"""Aggregate head observations into one merchant-scoped Performance answer."""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical_json import canonical_decimal
from .performance_identity import PopulationManifest, build_population_manifest, resolve_default_end
from .performance_metrics import (
    DERIVED_IMPRESSIONS_KEY,
    GBP_SOURCE_METRICS,
    HEADLINE_METRICS,
    IMPRESSION_COMPONENTS,
    METRIC_REGISTRY_VERSION,
    metric_definition,
)
from .performance_periods import CanonicalPeriods, Period, canonical_periods, compute_delta
from .performance_store import HeadObservation, open_quality_events, query_metric_heads

CONTRACT_VERSION = "seo_ops.merchant_performance.v1"


class DatePeriodV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    end: date

    @model_validator(mode="after")
    def validate_order(self):
        if self.start > self.end:
            raise ValueError("start must not be after end")
        return self


class ComparisonV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["previous_equal_length", "previous_complete_calendar_month", "custom"] = "previous_equal_length"
    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def validate_custom(self):
        if self.mode == "custom" and (self.start is None or self.end is None):
            raise ValueError("custom comparison requires start and end")
        if self.mode != "custom" and (self.start is not None or self.end is not None):
            raise ValueError("comparison dates are valid only for custom mode")
        return self


class MerchantPerformanceQueryV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location_ids: list[int] = Field(default_factory=list)
    current: DatePeriodV1 | None = None
    comparison: ComparisonV1 = Field(default_factory=ComparisonV1)
    granularity: Literal["day", "week", "month"] = "day"


def _days(period: Period) -> list[date]:
    return [period.start + timedelta(days=offset) for offset in range(period.days)]


def _index(heads: list[HeadObservation]) -> dict[tuple[date, str], list[HeadObservation]]:
    grouped: dict[tuple[date, str], list[HeadObservation]] = {}
    for head in heads:
        grouped.setdefault((head.business_date, head.metric_key), []).append(head)
    return grouped


def _daily_value(
    grouped: dict[tuple[date, str], list[HeadObservation]], day: date, metric_key: str, scope_count: int
) -> tuple[Decimal | None, str, str]:
    """Return (value, availability, completeness) for one metric on one day across all scopes."""
    if metric_key == DERIVED_IMPRESSIONS_KEY:
        components = [
            _daily_value(grouped, day, component, scope_count) for component in IMPRESSION_COMPONENTS
        ]
        available = [value for value, availability, _ in components if availability == "available"]
        if not available:
            return None, "unavailable", "unknown"
        total = sum(available, Decimal(0))
        complete = all(availability == "available" for _, availability, _ in components)
        return total, "available", "complete" if complete else "partial"
    observations = grouped.get((day, metric_key), [])
    if not observations:
        return None, "unavailable", "unknown"
    available = [obs.numeric_value for obs in observations if obs.availability == "available"]
    if not available:
        return None, "unavailable", "unknown"
    total = sum(available, Decimal(0))
    complete = len(available) == scope_count
    return total, "available", "complete" if complete else "partial"


def _aggregate(
    grouped: dict[tuple[date, str], list[HeadObservation]], period: Period, metric_key: str, scope_count: int
) -> dict:
    values: list[Decimal] = []
    observed = 0
    partial = False
    data_through: date | None = None
    for day in _days(period):
        value, availability, completeness = _daily_value(grouped, day, metric_key, scope_count)
        if availability == "available" and value is not None:
            values.append(value)
            observed += 1
            partial = partial or completeness == "partial"
            data_through = day
    expected = period.days
    if observed == 0:
        return {
            "value": None, "availability": "unavailable", "completeness": "unknown",
            "observed": 0, "expected": expected, "data_through": None,
        }
    total = sum(values, Decimal(0))
    completeness = "complete" if observed == expected and not partial else "partial"
    return {
        "value": canonical_decimal(total), "availability": "available", "completeness": completeness,
        "observed": observed, "expected": expected,
        "data_through": data_through.isoformat(),
    }


def _series(
    grouped: dict[tuple[date, str], list[HeadObservation]], period: Period, metric_key: str, scope_count: int
) -> dict:
    points = []
    for day in _days(period):
        value, availability, completeness = _daily_value(grouped, day, metric_key, scope_count)
        points.append({
            "date": day.isoformat(),
            "value": canonical_decimal(value),
            "availability": availability,
            "completeness": completeness,
            "missing_reason": None if availability == "available" else "no_observation",
        })
    return {"metric_key": metric_key, "label": metric_definition(metric_key).label, "points": points}


def _sources(conn: sqlite3.Connection, population: PopulationManifest, period: Period) -> list[dict]:
    scope_ids = tuple(scope.scope_id for scope in population.scopes)
    if not scope_ids:
        return []
    marks = ",".join("?" * len(scope_ids))
    row = conn.execute(
        f"SELECT MAX(data_through) AS data_through, MAX(published_at) AS published_at"
        f" FROM metric_sync_batches WHERE status = 'published' AND source_scope_id IN ({marks})",
        scope_ids,
    ).fetchone()
    return [{
        "source": "GBP",
        "date_basis": "store_local",
        "data_through": row["data_through"],
        "last_success_sync_at": row["published_at"],
        "status": "ready" if row["published_at"] else "no_data",
    }]


def query_merchant_performance(
    conn: sqlite3.Connection, merchant_id: int, request: MerchantPerformanceQueryV1, *, now: datetime
) -> dict:
    location_ids = tuple(sorted(request.location_ids)) or None
    population = build_population_manifest(conn, merchant_id, location_ids, as_of=now)
    if request.current is None:
        end = resolve_default_end(population, as_of=now)
        current = Period(end - timedelta(days=27), end)
    else:
        current = Period(request.current.start, request.current.end)
    custom = (
        Period(request.comparison.start, request.comparison.end)
        if request.comparison.mode == "custom" else None
    )
    periods: CanonicalPeriods = canonical_periods(current, request.comparison.mode, custom)
    scope_ids = tuple(scope.scope_id for scope in population.scopes)
    scope_count = len(scope_ids)
    window_start = min(periods.current.start, periods.comparison.start) if periods.comparison else periods.current.start
    window_end = max(periods.current.end, periods.comparison.end) if periods.comparison else periods.current.end
    heads = query_metric_heads(conn, scope_ids, GBP_SOURCE_METRICS, window_start, window_end)
    grouped = _index(heads)

    kpis = []
    for metric_key in HEADLINE_METRICS + tuple(k for k in GBP_SOURCE_METRICS if k not in HEADLINE_METRICS):
        current_value = _aggregate(grouped, periods.current, metric_key, scope_count)
        comparison_value = (
            _aggregate(grouped, periods.comparison, metric_key, scope_count) if periods.comparison else None
        )
        delta = compute_delta(
            Decimal(current_value["value"]) if current_value["value"] is not None else None,
            periods.current.days,
            Decimal(comparison_value["value"]) if comparison_value and comparison_value["value"] is not None else None,
            periods.comparison.days if periods.comparison else periods.current.days,
        )
        kpis.append({
            "metric_key": metric_key,
            "label": metric_definition(metric_key).label,
            "unit": metric_definition(metric_key).unit,
            "formula_version": METRIC_REGISTRY_VERSION,
            "current": current_value,
            "comparison": comparison_value,
            "delta": canonical_decimal(delta.value),
            "delta_type": delta.delta_type,
            "delta_reason": delta.reason,
            "comparison_basis": delta.basis,
        })

    corrected = sorted(
        {(head.business_date.isoformat(), head.metric_key) for head in heads
         if head.superseded and periods.current.start <= head.business_date <= periods.current.end}
    )
    return {
        "contract_version": CONTRACT_VERSION,
        "formula_version": METRIC_REGISTRY_VERSION,
        "merchant_id": merchant_id,
        "population_hash": population.manifest_sha256,
        "population": population.manifest,
        "periods": {
            "current": {"start": periods.current.start.isoformat(), "end": periods.current.end.isoformat(),
                        "days": periods.current.days},
            "comparison": None if periods.comparison is None else {
                "start": periods.comparison.start.isoformat(), "end": periods.comparison.end.isoformat(),
                "days": periods.comparison.days},
            "mode": periods.mode,
            "basis": periods.basis,
            "granularity": request.granularity,
        },
        "kpis": kpis,
        "series": [
            _series(grouped, periods.current, metric_key, scope_count) for metric_key in HEADLINE_METRICS
        ],
        "coverage": {
            "current_days": periods.current.days,
            "comparison_days": periods.comparison.days if periods.comparison else None,
        },
        "quality": open_quality_events(conn, scope_ids, periods.current.start, periods.current.end),
        "sources": _sources(conn, population, periods.current),
        "backfill_notes": [
            {"business_date": business_date, "metric_key": metric_key} for business_date, metric_key in corrected
        ],
    }

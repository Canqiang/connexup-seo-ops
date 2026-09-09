"""Aggregate head observations into one merchant-scoped Performance answer."""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical_json import canonical_decimal
from .performance_identity import (
    PopulationManifest,
    TimezoneUnresolved,
    build_population_manifest,
    resolve_default_end,
)
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
    # Weekly/monthly rollup arrives with the feature that needs it; the pilot
    # has ~20 days of data. Narrowed from day|week|month so a client can never
    # get a response whose periods.granularity claims a rollup that _series
    # does not actually produce (see periods.granularity below, which stays
    # in the response so the contract remains explicit).
    granularity: Literal["day"] = "day"


def _days(period: Period) -> list[date]:
    return [period.start + timedelta(days=offset) for offset in range(period.days)]


def _index(heads: list[HeadObservation]) -> dict[tuple[date, str], list[HeadObservation]]:
    grouped: dict[tuple[date, str], list[HeadObservation]] = {}
    for head in heads:
        grouped.setdefault((head.business_date, head.metric_key), []).append(head)
    return grouped


def _daily_value(
    grouped: dict[tuple[date, str], list[HeadObservation]], day: date, metric_key: str, scope_count: int
) -> tuple[Decimal | None, str, str, str | None]:
    """Return (value, availability, completeness, missing_reason) for one metric on one day.

    ``missing_reason`` is None whenever a value is available. Otherwise it
    distinguishes "we never synced this day" (``no_observation``, no
    published observation exists at all for this scope/day/metric) from
    "the source reported this metric as unavailable" (``metric_unavailable``,
    an observation exists and is hashed, but every scope reporting it said
    unavailable) -- these are different facts and must not read the same.
    """
    if metric_key == DERIVED_IMPRESSIONS_KEY:
        components = [
            _daily_value(grouped, day, component, scope_count) for component in IMPRESSION_COMPONENTS
        ]
        available = [value for value, availability, _completeness, _reason in components if availability == "available"]
        if not available:
            reason = (
                "metric_unavailable"
                if any(reason == "metric_unavailable" for _v, _a, _c, reason in components)
                else "no_observation"
            )
            return None, "unavailable", "unknown", reason
        total = sum(available, Decimal(0))
        # A component that is itself only partially covered by the bound
        # population (some scopes reported it, some did not) must not be
        # treated as fully reported just because at least one scope answered
        # -- the derived total is "complete" only when every component is
        # both available AND complete.
        complete = all(
            availability == "available" and completeness == "complete"
            for _value, availability, completeness, _reason in components
        )
        return total, "available", "complete" if complete else "partial", None
    observations = grouped.get((day, metric_key), [])
    if not observations:
        return None, "unavailable", "unknown", "no_observation"
    available = [obs.numeric_value for obs in observations if obs.availability == "available"]
    if not available:
        return None, "unavailable", "unknown", "metric_unavailable"
    total = sum(available, Decimal(0))
    complete = len(available) == scope_count
    return total, "available", "complete" if complete else "partial", None


def _aggregate(
    grouped: dict[tuple[date, str], list[HeadObservation]], period: Period, metric_key: str, scope_count: int
) -> dict:
    values: list[Decimal] = []
    observed = 0
    partial = False
    data_through: date | None = None
    for day in _days(period):
        value, availability, completeness, _reason = _daily_value(grouped, day, metric_key, scope_count)
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
        value, availability, completeness, missing_reason = _daily_value(grouped, day, metric_key, scope_count)
        points.append({
            "date": day.isoformat(),
            "value": canonical_decimal(value),
            "availability": availability,
            "completeness": completeness,
            "missing_reason": missing_reason,
        })
    return {"metric_key": metric_key, "label": metric_definition(metric_key).label, "points": points}


def _sources(conn: sqlite3.Connection, population: PopulationManifest) -> list[dict]:
    """Scope-wide source freshness -- deliberately not scoped to the queried period.

    ``source_data_through`` is "the newest published batch across all time for
    these scopes", distinct from a KPI's ``current.data_through`` ("last
    available day inside the requested period"). Naming it plainly (instead
    of reusing ``data_through``) keeps the two from reading as the same fact
    in a contract that gets hashed.
    """
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
        "source_data_through": row["data_through"],
        "last_success_sync_at": row["published_at"],
        "status": "ready" if row["published_at"] else "no_data",
    }]


def query_merchant_performance(
    conn: sqlite3.Connection, merchant_id: int, request: MerchantPerformanceQueryV1, *, now: datetime
) -> dict:
    location_ids = tuple(sorted(request.location_ids)) or None
    population = build_population_manifest(conn, merchant_id, location_ids, as_of=now)
    # Fail closed on every path, not just the default-period branch below:
    # resolve_default_end only ever runs when the caller omits `current`, but
    # a bound location seeded from a GBP profile starts with no verified
    # timezone (status 'needs_attention') and resolve_bound_scopes excludes
    # only archived locations -- so a caller supplying explicit dates (what
    # the Task 10 period picker always does) would otherwise sum observations
    # for a location whose store-local date_basis was never verified. The
    # write side already refuses this at preflight (location_timezone_missing
    # blocker); the read side must refuse it the same way regardless of which
    # period branch runs.
    for scope in population.scopes:
        if not scope.location.timezone_name:
            raise TimezoneUnresolved("location_timezone_missing")
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
        "sources": _sources(conn, population),
        "backfill_notes": [
            {"business_date": business_date, "metric_key": metric_key} for business_date, metric_key in corrected
        ],
    }

"""Turn one FBR GBP performance response into immutable observation drafts."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

from .fbr_gbp import FbrConfigurationError, FbrPayloadError, FbrUnavailableError
from .performance_metrics import GBP_SOURCE_METRICS
from .performance_store import ObservationDraft

GBP_ADAPTER_VERSION = "gbp.performance.v1"
SOURCE_START_DATE = date(2026, 8, 18)  # proven by the 2026-09-09 read-only probe


@dataclass(frozen=True)
class NormalizedPartition:
    drafts: tuple[ObservationDraft, ...]
    observed_dates: tuple[date, ...]
    omissions: tuple[tuple[date, str], ...]
    data_through: date | None


def _parse_row(row: object, start: date, end: date) -> tuple[date, str, Decimal]:
    if not isinstance(row, dict):
        raise FbrPayloadError("performance row must be an object")
    raw_date = row.get("metric_date")
    metric = row.get("metric")
    value = row.get("value")
    try:
        business_date = date.fromisoformat(str(raw_date))
    except ValueError as exc:
        raise FbrPayloadError(f"invalid metric_date: {raw_date!r}") from exc
    if not (start <= business_date <= end):
        raise FbrPayloadError(f"metric_date {business_date} is outside the requested window")
    if metric not in GBP_SOURCE_METRICS:
        raise FbrPayloadError(f"unknown metric key: {metric!r}")
    if isinstance(value, bool) or not isinstance(value, int):
        raise FbrPayloadError(f"metric value must be an integer: {value!r}")
    return business_date, str(metric), Decimal(value)


def normalize_performance_payload(
    payload: object, *, source_scope_id: int, start: date, end: date
) -> NormalizedPartition:
    if not isinstance(payload, dict) or not isinstance(payload.get("metrics"), list):
        raise FbrPayloadError("performance payload must contain a metrics list")
    observed: dict[tuple[date, str], Decimal] = {}
    for row in payload["metrics"]:
        business_date, metric, value = _parse_row(row, start, end)
        if (business_date, metric) in observed:
            raise FbrPayloadError(f"duplicate row for {business_date} {metric}")
        observed[(business_date, metric)] = value
    observed_dates = tuple(sorted({key[0] for key in observed}))
    drafts: list[ObservationDraft] = []
    omissions: list[tuple[date, str]] = []
    for business_date in observed_dates:
        for metric in GBP_SOURCE_METRICS:
            value = observed.get((business_date, metric))
            if value is None:
                omissions.append((business_date, metric))
                drafts.append(
                    ObservationDraft(source_scope_id, metric, business_date, None, "unavailable", "unknown")
                )
            else:
                drafts.append(
                    ObservationDraft(source_scope_id, metric, business_date, value, "available", "complete")
                )
    return NormalizedPartition(
        tuple(drafts), observed_dates, tuple(omissions), observed_dates[-1] if observed_dates else None
    )


def fetch_partition(
    client, *, fbr_merchant_id: str, place_id: str, source_scope_id: int, start: date, end: date
) -> tuple[bytes, NormalizedPartition]:
    payload = client.list_performance_metrics(
        fbr_merchant_id, place_id, from_date=start.isoformat(), to_date=end.isoformat()
    )
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return raw, normalize_performance_payload(payload, source_scope_id=source_scope_id, start=start, end=end)


def classify_source_error(exc: Exception) -> Literal["retryable", "blocked"]:
    if isinstance(exc, (FbrPayloadError, FbrConfigurationError)):
        return "blocked"
    if isinstance(exc, FbrUnavailableError):
        return "retryable"
    return "blocked"

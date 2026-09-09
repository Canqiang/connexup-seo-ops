"""Closed-interval store-local periods and the only delta rule in the system."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal, localcontext
from typing import Literal

from .performance_metrics import CALCULATION_CONTEXT

COMPARISON_MODES = ("previous_equal_length", "previous_complete_calendar_month", "custom")


@dataclass(frozen=True)
class Period:
    start: date
    end: date

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ValueError("period start must not be after end")

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


@dataclass(frozen=True)
class CanonicalPeriods:
    current: Period
    comparison: Period | None
    mode: str
    basis: Literal["total", "daily_average"]


@dataclass(frozen=True)
class DeltaResult:
    value: Decimal | None
    delta_type: Literal["percent"]
    basis: Literal["total", "daily_average"]
    reason: str | None


def _previous_complete_month(start: date) -> Period:
    last_day_previous = start.replace(day=1) - timedelta(days=1)
    return Period(last_day_previous.replace(day=1), last_day_previous)


def canonical_periods(current: Period, mode: str, custom: Period | None = None) -> CanonicalPeriods:
    if mode not in COMPARISON_MODES:
        raise ValueError(f"unknown comparison mode: {mode}")
    if mode == "custom":
        if custom is None:
            raise ValueError("custom comparison requires an explicit window")
        comparison = custom
    elif mode == "previous_equal_length":
        comparison = Period(current.start - timedelta(days=current.days), current.start - timedelta(days=1))
    else:
        comparison = _previous_complete_month(current.start)
    if custom is not None and mode != "custom":
        raise ValueError("comparison dates are valid only for custom mode")
    basis = "total" if comparison.days == current.days else "daily_average"
    return CanonicalPeriods(current=current, comparison=comparison, mode=mode, basis=basis)


def compute_delta(
    current_total: Decimal | None,
    current_days: int,
    comparison_total: Decimal | None,
    comparison_days: int,
) -> DeltaResult:
    basis: Literal["total", "daily_average"] = (
        "total" if current_days == comparison_days else "daily_average"
    )
    if current_total is None:
        return DeltaResult(None, "percent", basis, "current_unavailable")
    if comparison_total is None:
        return DeltaResult(None, "percent", basis, "comparison_unavailable")
    with localcontext(CALCULATION_CONTEXT) as ctx:
        if basis == "total":
            current_value, comparison_value = current_total, comparison_total
        else:
            current_value = ctx.divide(current_total, Decimal(current_days))
            comparison_value = ctx.divide(comparison_total, Decimal(comparison_days))
        if comparison_value == 0:
            if current_value == 0:
                return DeltaResult(Decimal("0"), "percent", basis, None)
            return DeltaResult(None, "percent", basis, "comparison_zero")
        ratio = ctx.divide(ctx.subtract(current_value, comparison_value), comparison_value)
        percent = ctx.multiply(ratio, Decimal(100)).quantize(Decimal("0.1"))
    return DeltaResult(percent, "percent", basis, None)

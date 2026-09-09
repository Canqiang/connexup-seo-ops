from datetime import date
from decimal import Decimal

import pytest

from app.performance_periods import Period, canonical_periods, compute_delta


def test_previous_equal_length_is_the_immediately_preceding_window():
    periods = canonical_periods(Period(date(2026, 8, 1), date(2026, 8, 31)), "previous_equal_length")
    assert periods.comparison == Period(date(2026, 7, 1), date(2026, 7, 31))
    assert periods.basis == "total"


def test_previous_complete_calendar_month_uses_the_month_before_current_start():
    periods = canonical_periods(Period(date(2026, 9, 3), date(2026, 9, 9)), "previous_complete_calendar_month")
    assert periods.comparison == Period(date(2026, 8, 1), date(2026, 8, 31))
    assert periods.basis == "daily_average"


def test_custom_comparison_requires_a_window_and_may_differ_in_length():
    periods = canonical_periods(
        Period(date(2026, 9, 1), date(2026, 9, 7)),
        "custom",
        Period(date(2026, 8, 1), date(2026, 8, 14)),
    )
    assert periods.comparison.days == 14 and periods.basis == "daily_average"
    with pytest.raises(ValueError):
        canonical_periods(Period(date(2026, 9, 1), date(2026, 9, 7)), "custom")


def test_equal_length_delta_uses_totals():
    result = compute_delta(Decimal("12600"), 31, Decimal("11560"), 31)
    assert result.basis == "total"
    assert result.value == Decimal("9.0")


def test_unequal_length_delta_compares_daily_averages():
    result = compute_delta(Decimal("140"), 7, Decimal("400"), 28)
    assert result.basis == "daily_average"
    assert result.value == Decimal("40.0")


@pytest.mark.parametrize(
    "current,comparison,reason",
    [
        (Decimal("120"), Decimal("0"), "comparison_zero"),
        (None, Decimal("10"), "current_unavailable"),
        (Decimal("10"), None, "comparison_unavailable"),
    ],
)
def test_delta_is_null_with_an_explicit_reason(current, comparison, reason):
    result = compute_delta(current, 7, comparison, 7)
    assert result.value is None and result.reason == reason


def test_both_periods_zero_is_flat_not_null():
    result = compute_delta(Decimal("0"), 7, Decimal("0"), 7)
    assert result.value == Decimal("0") and result.reason is None

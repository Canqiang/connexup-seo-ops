import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.fbr_gbp import FbrConfigurationError, FbrPayloadError, FbrUnavailableError
from app.performance_gbp import classify_source_error, normalize_performance_payload

GOLD = json.loads((Path(__file__).parent / "fixtures/performance/gbp_choice_brooklyn_gold.json").read_text())


def _normalize():
    return normalize_performance_payload(GOLD, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20))


def test_observed_zero_is_available_not_missing():
    partition = _normalize()
    call_clicks = next(
        d for d in partition.drafts if d.metric_key == "CALL_CLICKS" and d.business_date == date(2026, 8, 18)
    )
    assert call_clicks.numeric_value == Decimal("0")
    assert (call_clicks.availability, call_clicks.completeness) == ("available", "complete")


def test_omitted_key_on_a_returned_day_is_unavailable_and_reported():
    partition = _normalize()
    call_clicks = next(
        d for d in partition.drafts if d.metric_key == "CALL_CLICKS" and d.business_date == date(2026, 8, 19)
    )
    assert call_clicks.numeric_value is None
    assert (call_clicks.availability, call_clicks.completeness) == ("unavailable", "unknown")
    assert (date(2026, 8, 19), "CALL_CLICKS") in partition.omissions


def test_a_day_the_source_never_returned_produces_no_draft():
    partition = _normalize()
    assert all(draft.business_date != date(2026, 8, 20) for draft in partition.drafts)
    assert partition.observed_dates == (date(2026, 8, 18), date(2026, 8, 19))
    assert partition.data_through == date(2026, 8, 19)


def test_rows_outside_the_requested_window_are_rejected():
    payload = {"metrics": [{"metric_date": "2026-07-01", "metric": "CALL_CLICKS", "value": 1}]}
    with pytest.raises(FbrPayloadError):
        normalize_performance_payload(payload, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20))


def test_unknown_metric_keys_and_malformed_values_are_rejected():
    for metrics in (
        [{"metric_date": "2026-08-18", "metric": "BUSINESS_BOOKINGS", "value": 1}],
        [{"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": "many"}],
        [{"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": 1},
         {"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": 2}],
    ):
        with pytest.raises(FbrPayloadError):
            normalize_performance_payload(
                {"metrics": metrics}, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20)
            )


def test_transport_failures_are_retryable_and_payload_failures_are_blocked():
    assert classify_source_error(FbrUnavailableError("timeout")) == "retryable"
    assert classify_source_error(FbrPayloadError("bad")) == "blocked"


def test_configuration_errors_are_blocked():
    assert classify_source_error(FbrConfigurationError("invalid key")) == "blocked"


def test_unexpected_exceptions_are_blocked():
    assert classify_source_error(RuntimeError("unexpected")) == "blocked"

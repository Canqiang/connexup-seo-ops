from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.performance_identity import (
    TimezoneUnresolved,
    canonical_instant,
    seed_gbp_locations_from_profiles,
    set_location_timezone,
)
from app.performance_query import MerchantPerformanceQueryV1, query_merchant_performance
from app.performance_store import BatchDraft, ObservationDraft, create_batch, create_sync_job, publish_metric_batch

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _lease(conn, batch_id: int) -> None:
    """Move a freshly created batch from queued to leased so publish_metric_batch is legal.

    Migration 0001's protect_metric_sync_batch_transition trigger only allows
    queued -> leased -> {running, published, retryable, blocked, failed}, and
    the four non-running targets are terminal. Mirrors the identical helper in
    tests/test_performance_store.py rather than inventing a second pattern.
    """
    conn.execute(
        "UPDATE metric_sync_batches SET status = 'leased', lease_owner = 'test', updated_at = ?"
        " WHERE id = ?",
        (canonical_instant(NOW), batch_id),
    )
    conn.commit()


def _ready_merchant(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW)
    for scope in scopes:
        set_location_timezone(conn, scope.location.id, "America/New_York", actor="test", effective_at=NOW)
    return scopes


def _publish_day(conn, scope_id, day, values, *, request_id):
    job_id = create_sync_job(conn, job_type="backfill", request_id=request_id, requested_by="test",
                             scope_manifest={"scope_ids": [scope_id]}, start=day, end=day, now=NOW)
    batch_id = create_batch(conn, BatchDraft(job_id, scope_id, day.strftime("%Y-%m"), 1, "gbp.v1", NOW, day), now=NOW)
    _lease(conn, batch_id)
    drafts = [
        ObservationDraft(scope_id, key, day, None if value is None else Decimal(value),
                         "unavailable" if value is None else "available",
                         "unknown" if value is None else "complete")
        for key, value in values.items()
    ]
    publish_metric_batch(conn, batch_id, b"{}", drafts, now=NOW)


def test_totals_coverage_and_delta_are_computed_from_heads(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    scope_id = scopes[0].scope_id
    for index, day in enumerate((date(2026, 9, 1), date(2026, 9, 2))):
        _publish_day(conn, scope_id, day, {
            "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": 10, "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": 20,
            "BUSINESS_IMPRESSIONS_MOBILE_MAPS": 30, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": 40,
            "WEBSITE_CLICKS": 5, "CALL_CLICKS": 0, "BUSINESS_DIRECTION_REQUESTS": 3,
            "BUSINESS_FOOD_MENU_CLICKS": 7,
        }, request_id=f"c{index}")
    for index, day in enumerate((date(2026, 8, 30), date(2026, 8, 31))):
        _publish_day(conn, scope_id, day, {
            "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": 5, "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": 10,
            "BUSINESS_IMPRESSIONS_MOBILE_MAPS": 15, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": 20,
            "WEBSITE_CLICKS": 2, "CALL_CLICKS": 1, "BUSINESS_DIRECTION_REQUESTS": 1,
            "BUSINESS_FOOD_MENU_CLICKS": 2,
        }, request_id=f"p{index}")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-02"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    impressions = next(k for k in body["kpis"] if k["metric_key"] == "gbp_impressions_total")
    assert impressions["current"]["value"] == "200"
    assert impressions["comparison"]["value"] == "100"
    assert impressions["delta"] == "100.0" and impressions["comparison_basis"] == "total"
    assert impressions["current"]["observed"] == 2 and impressions["current"]["expected"] == 2
    call_clicks = next(k for k in body["kpis"] if k["metric_key"] == "CALL_CLICKS")
    assert call_clicks["current"]["value"] == "0"


def test_a_missing_day_breaks_the_series_and_reduces_coverage(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-03"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    series = next(s for s in body["series"] if s["metric_key"] == "WEBSITE_CLICKS")
    assert [point["value"] for point in series["points"]] == ["5", None, None]
    assert series["points"][1]["missing_reason"] == "no_observation"
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["current"]["observed"] == 1 and website["current"]["expected"] == 3
    assert website["current"]["completeness"] == "partial"


def test_unavailable_metric_rows_do_not_count_as_zero(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"CALL_CLICKS": None}, request_id="c0")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-01"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    call_clicks = next(k for k in body["kpis"] if k["metric_key"] == "CALL_CLICKS")
    assert call_clicks["current"]["value"] is None
    assert call_clicks["current"]["availability"] == "unavailable"


def test_repeating_the_same_query_returns_identical_bytes(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    request = MerchantPerformanceQueryV1(
        location_ids=[scopes[0].location.id],
        current={"start": "2026-09-01", "end": "2026-09-01"},
        comparison={"mode": "previous_equal_length"},
    )
    from app.canonical_json import canonical_json_bytes

    first = canonical_json_bytes(query_merchant_performance(conn, merchant_with_gbp_profiles, request, now=NOW))
    second = canonical_json_bytes(query_merchant_performance(conn, merchant_with_gbp_profiles, request, now=NOW))
    assert first == second


def test_a_comparison_window_before_the_source_start_reports_no_comparable_data(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 8, 20), {"WEBSITE_CLICKS": 5}, request_id="c0")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-08-20", "end": "2026-08-20"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["comparison"]["value"] is None
    assert website["delta"] is None and website["delta_reason"] == "comparison_unavailable"


def test_corrected_days_are_listed_as_backfill_notes(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 9}, request_id="c1")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-01"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    assert body["backfill_notes"] == [{"business_date": "2026-09-01", "metric_key": "WEBSITE_CLICKS"}]
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["current"]["value"] == "9"


def test_derived_impressions_reports_partial_when_only_some_scopes_report_it(conn, merchant_with_gbp_profiles):
    """Two bound locations; only one publishes any impression component for the day.

    Every component is honestly (value, "available", "partial") -- one of
    two scopes reported it. The derived total must not read "complete" just
    because each of the four components had *some* available value; it is
    complete only when every component is both available and complete.
    """
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    assert len(scopes) == 2
    day = date(2026, 9, 1)
    _publish_day(conn, scopes[0].scope_id, day, {
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": 10, "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": 20,
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS": 30, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": 40,
    }, request_id="c0")
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scope.location.id for scope in scopes],
            current={"start": "2026-09-01", "end": "2026-09-01"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    impressions = next(k for k in body["kpis"] if k["metric_key"] == "gbp_impressions_total")
    assert impressions["current"]["value"] == "100"
    assert impressions["current"]["completeness"] == "partial"
    series = next(s for s in body["series"] if s["metric_key"] == "gbp_impressions_total")
    assert series["points"][0]["value"] == "100"
    assert series["points"][0]["completeness"] == "partial"


def test_missing_reason_distinguishes_never_synced_from_source_reported_unavailable(conn, merchant_with_gbp_profiles):
    scopes = _ready_merchant(conn, merchant_with_gbp_profiles)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 2), {"WEBSITE_CLICKS": None}, request_id="c1")
    # 2026-09-03 is left entirely unpublished -- never synced.
    body = query_merchant_performance(
        conn, merchant_with_gbp_profiles,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-03"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    series = next(s for s in body["series"] if s["metric_key"] == "WEBSITE_CLICKS")
    assert series["points"][0]["missing_reason"] is None
    assert series["points"][1]["missing_reason"] == "metric_unavailable"
    assert series["points"][2]["missing_reason"] == "no_observation"


def test_explicit_period_fails_closed_when_a_bound_location_has_no_timezone(conn, merchant_with_gbp_profiles):
    """The fail-closed timezone check must run for explicit dates too, not only the default-period path.

    resolve_default_end alone would never catch this, since it only ever
    runs when the caller omits `current` -- exactly what the Task 10 period
    picker never does.
    """
    scopes = seed_gbp_locations_from_profiles(conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW)
    with pytest.raises(TimezoneUnresolved, match="location_timezone_missing"):
        query_merchant_performance(
            conn, merchant_with_gbp_profiles,
            MerchantPerformanceQueryV1(
                location_ids=[scopes[0].location.id],
                current={"start": "2026-09-01", "end": "2026-09-01"},
                comparison={"mode": "previous_equal_length"},
            ),
            now=NOW,
        )

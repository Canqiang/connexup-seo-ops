"""Router coverage for the merchant performance query's rollback gate and fail-closed timezone check.

Mirrors the seeding pattern in tests/test_performance_sync_api.py's _seed_pilot.
"""
import json
from datetime import datetime, timezone


def _seed_merchant_with_bound_location(client, *, set_timezone=True):
    created = client.post(
        "/api/merchants", json={"name": "Choice Brooklyn", "primary_location": "Brooklyn, NY"}
    )
    merchant_id = created.json()["id"]
    from app.db import connect
    from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone

    conn = connect()
    try:
        conn.execute(
            "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id, source_title,"
            " location_json, normalized_json, synced_at) VALUES (?,?,?,?,'{}',?,'2026-09-03T00:00:00.000000Z')",
            (merchant_id, "fbr-3", "24300588970198995", "Upper West Side",
             json.dumps({"place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE"})),
        )
        conn.commit()
        now = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)
        scopes = seed_gbp_locations_from_profiles(conn, merchant_id, actor="test", observed_at=now)
        if set_timezone:
            set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=now)
    finally:
        conn.close()
    return merchant_id


def test_query_refused_when_the_history_read_flag_is_off(client, monkeypatch):
    merchant_id = _seed_merchant_with_bound_location(client)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", str(merchant_id))
    # SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED is intentionally left unset (off).
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/query",
        json={"current": {"start": "2026-09-01", "end": "2026-09-01"}},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "history_read_not_enabled_for_merchant"


def test_query_refused_for_a_merchant_outside_the_pilot_allowlist(client, monkeypatch):
    merchant_id = _seed_merchant_with_bound_location(client)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", str(merchant_id + 1))
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/query",
        json={"current": {"start": "2026-09-01", "end": "2026-09-01"}},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "history_read_not_enabled_for_merchant"


def test_query_reports_a_missing_timezone_as_a_distinct_409_from_the_rollback_gate(client, monkeypatch):
    merchant_id = _seed_merchant_with_bound_location(client, set_timezone=False)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", str(merchant_id))
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/query",
        json={"current": {"start": "2026-09-01", "end": "2026-09-01"}},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "location_timezone_missing"
    assert response.json()["detail"] != "history_read_not_enabled_for_merchant"


def test_put_timezone_refused_when_the_history_read_flag_is_off(client, monkeypatch):
    """The PUT route writes merchant_locations, merchant_location_status_events
    and source_scopes, so it must sit behind the same rollback gate as the
    query route -- with both flags off, the Rollback runbook paragraph
    claims every route behind them returns 409, and this one must too."""
    merchant_id = _seed_merchant_with_bound_location(client, set_timezone=False)
    from app.db import connect

    conn = connect()
    try:
        location_id = conn.execute(
            "SELECT id FROM merchant_locations WHERE merchant_id = ?", (merchant_id,)
        ).fetchone()["id"]
    finally:
        conn.close()
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", str(merchant_id))
    # Both SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED and
    # SEO_OPS_PERFORMANCE_SYNC_ENABLED are intentionally left unset (off).
    response = client.put(
        f"/api/merchant-locations/{location_id}/timezone",
        json={"timezone_name": "America/Chicago"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "history_read_not_enabled_for_merchant"
    # The gate must refuse before the write -- the timezone stays unset.
    conn = connect()
    try:
        row = conn.execute(
            "SELECT timezone_name FROM merchant_locations WHERE id = ?", (location_id,)
        ).fetchone()
    finally:
        conn.close()
    assert row["timezone_name"] is None

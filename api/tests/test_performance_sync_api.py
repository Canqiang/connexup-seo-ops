import json


def _seed_pilot(client, monkeypatch):
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "1")
    created = client.post(
        "/api/merchants", json={"name": "Choice Brooklyn", "primary_location": "Brooklyn, NY"}
    )
    merchant_id = created.json()["id"]
    from app.db import connect
    from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone
    from datetime import datetime, timezone

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
        set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=now)
    finally:
        conn.close()
    return merchant_id


def test_preflight_clamps_to_the_source_start_and_lists_month_partitions(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill/preflight",
        json={"start": "2026-06-01", "end": "2026-09-06"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["clamped_start"] == "2026-08-18"
    assert [p["partition_month"] for p in body["partitions"]] == ["2026-08", "2026-09"]
    assert body["batch_estimate"] == 2
    assert body["blockers"] == []


def test_preflight_reports_a_missing_timezone_as_a_blocker(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    from app.db import connect

    conn = connect()
    try:
        conn.execute("UPDATE merchant_locations SET timezone_name = NULL, status = 'needs_attention'")
        conn.commit()
    finally:
        conn.close()
    body = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill/preflight",
        json={"start": "2026-08-18", "end": "2026-08-31"},
    ).json()
    assert any(blocker["code"] == "location_timezone_missing" for blocker in body["blockers"])


def test_confirm_requires_the_confirmation_flag(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill",
        json={"request_id": "r1", "start": "2026-08-18", "end": "2026-08-31", "confirmed": False},
    )
    assert response.status_code == 422


def test_confirm_is_idempotent_for_one_request_id(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    body = {"request_id": "r1", "start": "2026-08-18", "end": "2026-08-31", "confirmed": True}
    first = client.post(f"/api/merchants/{merchant_id}/performance/backfill", json=body)
    second = client.post(f"/api/merchants/{merchant_id}/performance/backfill", json=body)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["job_id"] == second.json()["job_id"]
    assert second.json()["batch_ids"] == []
    status = client.get(f"/api/performance-sync/jobs/{first.json()['job_id']}").json()
    # Controller ruling (job progress is not a counter ratio): batch_count and
    # completed_batch_count are raw attempt counters -- create_batch bumps
    # batch_count on every attempt including retry successors, while
    # completed_batch_count only counts publishes, so a job that needed a
    # retry would read as permanently incomplete on that ratio even after it
    # finished correctly. The response reports them as raw_attempt_counts
    # (not "progress") and separately reports the group-level truth: how
    # many (source_scope_id, partition_month) partitions exist, are
    # published, and are terminally failed, derived from each group's
    # latest-attempt row -- the same logic _finalize_job in
    # performance_sync.py uses to decide the job's real status.
    assert status["raw_attempt_counts"]["batch_count"] == 1
    assert status["status"] in {"queued", "running"}
    assert status["progress"] == {
        "partitions_total": 1,
        "partitions_published": 0,
        "partitions_failed": 0,
        "partitions_pending": 1,
    }


def test_backfill_is_refused_for_a_non_pilot_merchant(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "999")
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill",
        json={"request_id": "r2", "start": "2026-08-18", "end": "2026-08-31", "confirmed": True},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "performance_sync_not_enabled_for_merchant"

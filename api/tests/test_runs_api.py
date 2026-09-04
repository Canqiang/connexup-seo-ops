import json
import os
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from helpers import FakeCoreAi, cleanup_override, override_coreai, seed_fbr_link


def insert_fbr_link(
    merchant_id: int,
    *,
    fbr_merchant_id: str = "fbr-merchant-123",
    sync_status: str,
    last_synced_at: str | None = None,
    last_error: str | None = None,
) -> None:
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    seed_fbr_link(
        conn,
        merchant_id,
        fbr_merchant_id=fbr_merchant_id,
        sync_status=sync_status,
        last_synced_at=last_synced_at,
        last_error=last_error,
    )
    conn.commit()
    conn.close()


def insert_gbp_profile(
    merchant_id: int,
    *,
    normalized_json: str,
    fbr_merchant_id: str = "fbr-merchant-123",
    gbp_location_id: str = "locations/123",
    google_account_id: str | None = "accounts/77",
    source_name: str | None = "locations/123",
    source_title: str | None = "George's Hakka Kitchen",
    source_updated_at: str | None = None,
    synced_at: str = "2026-09-03T01:02:03+00:00",
) -> None:
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO merchant_gbp_profiles"
        " (merchant_id, fbr_merchant_id, gbp_location_id, google_account_id, source_name, source_title,"
        " normalized_json, source_updated_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            merchant_id,
            fbr_merchant_id,
            gbp_location_id,
            google_account_id,
            source_name,
            source_title,
            normalized_json,
            source_updated_at,
            synced_at,
        ),
    )
    conn.commit()
    conn.close()


def insert_run(client, *, status: str, with_task: bool = False) -> tuple[int, int]:
    import os
    import sqlite3

    merchant = client.post(
        "/api/merchants",
        json={"name": f"plan-{status}", "primary_location": "New York, NY"},
    ).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, ?, ?, 'manual', '2026-09-01T00:00:00+00:00', ?)",
        (
            merchant["id"],
            f"plan-{status}-{merchant['id']}",
            status,
            "2026-09-01T00:01:00+00:00" if status != "running" else None,
        ),
    )
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    if with_task:
        conn.execute(
            "INSERT INTO tasks (merchant_id, title, source_run_id, source_key, created_at)"
            " VALUES (?, '候选任务', ?, ?, '2026-09-01T00:01:00+00:00')",
            (merchant["id"], run_id, f"plan-test-{run_id}"),
        )
    conn.commit()
    conn.close()
    return merchant["id"], run_id


def test_create_run_triggers_and_stores(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post(
            "/api/merchants",
            json={"name": "Alpha", "notes": "n", "primary_location": "New York, NY"},
        ).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "running"
        assert run["trigger_kind"] == "manual"
        assert run["coreai_run_id"] == "core-1"
        agent_id, input_text = fake.triggered[0]
        assert agent_id == "agent-t"
        assert "Alpha" in input_text
    finally:
        cleanup_override()


def test_create_run_sends_us_local_diagnosis_context_and_plan_contract(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={
                "name": "Only Bear Chicken & Boba",
                "primary_location": "Mineola, NY",
                "website_url": "https://onlybear.example.com",
                "notes": "restaurant",
            },
        ).json()

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 201
        _agent_id, input_text = fake.triggered[0]
        assert "Only Bear Chicken & Boba" in input_text
        assert "Mineola, NY" in input_text
        assert "https://onlybear.example.com" in input_text
        assert "United States local SEO" in input_text
        assert "English keywords" in input_text
        assert "start_after_days" in input_text
    finally:
        cleanup_override()


def test_create_run_includes_bounded_persisted_gbp_snapshot_context(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Connected merchant", "primary_location": "Operator-entered location"},
        ).json()
        insert_fbr_link(
            merchant["id"],
            sync_status="synced",
            last_synced_at="2026-09-03T01:02:03+00:00",
        )
        insert_gbp_profile(
            merchant["id"],
            normalized_json=json.dumps(
                {
                    "title": "George's Hakka Kitchen",
                    "address": "2020 Broadway, New York, NY 10023, US",
                    "locality": "New York",
                    "administrative_area": "NY",
                    "postal_code": "10023",
                    "region_code": "US",
                    "phone": "+1 212-555-2020",
                    "website_url": "https://george.example.com",
                    "primary_category": "Hakka restaurant",
                    "additional_categories": ["Chinese restaurant"],
                    "open_status": "OPEN",
                    "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                    "description": "Neighborhood Hakka dishes near Broadway." + ("x" * 50_000),
                    "regular_hours": [
                        {
                            "open_day": "MONDAY",
                            "open_time": "11:30",
                            "close_day": "MONDAY",
                            "close_time": "21:00",
                        }
                    ],
                    "access_token": "must-never-reach-core-ai",
                    "oauth": {"refresh_token": "also-must-not-reach-core-ai"},
                }
            ),
        )

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 201
        _agent_id, input_text = fake.triggered[0]
        assert "CONNECTED_GBP_SNAPSHOT" in input_text
        assert "fbr-merchant-123" in input_text
        assert "locations/123" in input_text
        assert "accounts/77" in input_text
        assert "ChIJH8iZh-5ZwokRPLzzADeSnYE" in input_text
        assert "2026-09-03T01:02:03+00:00" in input_text
        assert "2020 Broadway, New York, NY 10023, US" in input_text
        assert "Hakka restaurant" in input_text
        assert "MONDAY" in input_text
        assert "must-never-reach-core-ai" not in input_text
        assert "also-must-not-reach-core-ai" not in input_text
        assert len(input_text) < 15_000
    finally:
        cleanup_override()


def test_create_run_without_fbr_link_explicitly_uses_basic_public_diagnosis(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Public only", "primary_location": "New York, NY"},
        ).json()

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 201
        _agent_id, input_text = fake.triggered[0]
        assert "BASIC_PUBLIC_ONLY" in input_text
        assert "no connected GBP" in input_text
        assert "Website: Not provided" in input_text
        assert "missing website" in input_text
        assert "Do not invent a website URL" in input_text
    finally:
        cleanup_override()


@pytest.mark.parametrize("sync_status", ["not_synced", "syncing", "failed"])
def test_create_run_rejects_bound_merchant_until_gbp_sync_is_current(client, sync_status):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Incomplete sync", "primary_location": "New York, NY"},
        ).json()
        insert_fbr_link(
            merchant["id"],
            sync_status=sync_status,
            last_synced_at="2026-09-02T01:02:03+00:00",
            last_error="upstream unavailable",
        )
        insert_gbp_profile(
            merchant["id"],
            normalized_json=json.dumps({"title": "stale-title-must-not-be-used"}),
            synced_at="2026-09-02T01:02:03+00:00",
        )

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 409
        assert "同步" in response.json()["detail"]
        assert fake.triggered == []
    finally:
        cleanup_override()


def test_create_run_rejects_synced_link_without_a_persisted_snapshot(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Missing snapshot", "primary_location": "New York, NY"},
        ).json()
        insert_fbr_link(
            merchant["id"],
            sync_status="synced",
            last_synced_at="2026-09-03T01:02:03+00:00",
        )

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 409
        assert "同步" in response.json()["detail"]
        assert fake.triggered == []
    finally:
        cleanup_override()


@pytest.mark.parametrize(
    ("link_fbr_id", "profile_fbr_id", "link_synced_at", "profile_synced_at"),
    [
        (
            "current-fbr",
            "stale-fbr",
            "2026-09-03T01:02:03+00:00",
            "2026-09-03T01:02:03+00:00",
        ),
        (
            "current-fbr",
            "current-fbr",
            "2026-09-03T01:02:03+00:00",
            "2026-09-02T01:02:03+00:00",
        ),
        ("current-fbr", "current-fbr", "not-a-timestamp", "not-a-timestamp"),
    ],
)
def test_create_run_rejects_snapshot_from_wrong_binding_or_sync_batch(
    client,
    link_fbr_id,
    profile_fbr_id,
    link_synced_at,
    profile_synced_at,
):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Stale snapshot", "primary_location": "New York, NY"},
        ).json()
        insert_fbr_link(
            merchant["id"],
            fbr_merchant_id=link_fbr_id,
            sync_status="synced",
            last_synced_at=link_synced_at,
        )
        insert_gbp_profile(
            merchant["id"],
            fbr_merchant_id=profile_fbr_id,
            normalized_json=json.dumps({"title": "Stale business"}),
            synced_at=profile_synced_at,
        )

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 409
        assert fake.triggered == []
    finally:
        cleanup_override()


@pytest.mark.parametrize(
    "normalized_json",
    ["{not-json", json.dumps({"access_token": "secret-but-not-evidence"})],
)
def test_create_run_rejects_snapshot_without_parseable_allowlisted_facts(
    client, normalized_json
):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Unusable snapshot", "primary_location": "New York, NY"},
        ).json()
        insert_fbr_link(
            merchant["id"],
            sync_status="synced",
            last_synced_at="2026-09-03T01:02:03+00:00",
        )
        insert_gbp_profile(merchant["id"], normalized_json=normalized_json)

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 409
        assert fake.triggered == []
    finally:
        cleanup_override()


def test_create_run_prompt_has_a_hard_size_limit_across_all_merchant_and_gbp_fields(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        huge = "x" * 50_000
        merchant = client.post(
            "/api/merchants",
            json={"name": "Oversized", "primary_location": "New York, NY"},
        ).json()
        conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
        conn.execute(
            "UPDATE merchants SET name = ?, primary_location = ?, website_url = ?, notes = ?"
            " WHERE id = ?",
            ("Oversized " + huge, huge, huge, huge, merchant["id"]),
        )
        conn.commit()
        conn.close()
        synced_at = "2026-09-03T01:02:03+00:00"
        insert_fbr_link(
            merchant["id"],
            fbr_merchant_id="fbr-" + huge,
            sync_status="synced",
            last_synced_at=synced_at,
        )
        oversized_facts = {key: huge for key in (
            "title",
            "address",
            "phone",
            "website_url",
            "primary_category",
            "description",
            "place_id",
        )}
        oversized_facts["additional_categories"] = [huge] * 20
        for location_number in range(10):
            insert_gbp_profile(
                merchant["id"],
                fbr_merchant_id="fbr-" + huge,
                gbp_location_id=f"locations/{location_number}-" + huge,
                google_account_id="accounts/" + huge,
                source_name="resource/" + huge,
                source_title=huge,
                source_updated_at="source-time-" + huge,
                normalized_json=json.dumps(oversized_facts),
                synced_at=synced_at,
            )

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 201
        _agent_id, input_text = fake.triggered[0]
        assert len(input_text) <= 12_000
        assert "CONNECTED_GBP_SNAPSHOT" in input_text
        assert "Then return the proposed dated Plan" in input_text
    finally:
        cleanup_override()


def test_concurrent_create_run_requests_reserve_before_dispatch(client):
    class BlockingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.started = threading.Event()
            self.release = threading.Event()
            self.calls = 0
            self.calls_lock = threading.Lock()

        def trigger(self, agent_id: str, input_text: str) -> dict:
            with self.calls_lock:
                self.calls += 1
                call_number = self.calls
            if call_number == 1:
                self.started.set()
                assert self.release.wait(timeout=3)
            return super().trigger(agent_id, input_text)

    fake = BlockingCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Concurrent", "primary_location": "New York, NY"},
        ).json()

        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(
                client.post, f"/api/merchants/{merchant['id']}/runs"
            )
            assert fake.started.wait(timeout=3)
            second = client.post(f"/api/merchants/{merchant['id']}/runs")
            fake.release.set()
            first = first_future.result(timeout=3)

        assert first.status_code == 201
        assert second.status_code == 409
        assert second.json()["detail"] == "a run is already in progress for this merchant"
        assert len(fake.triggered) == 1
    finally:
        fake.release.set()
        cleanup_override()


def test_create_run_conflict_when_running(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post(
            "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
        ).json()
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 409
    finally:
        cleanup_override()


def test_create_run_503_when_unconfigured(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
    ).json()
    assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 503


def test_create_run_404_missing_merchant(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        assert client.post("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_archived_merchant_rejects_new_analysis_run(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Archived", "primary_location": "New York, NY"},
        ).json()
        client.patch(f"/api/merchants/{merchant['id']}", json={"status": "archived"})

        response = client.post(f"/api/merchants/{merchant['id']}/runs")

        assert response.status_code == 409
        assert response.json()["detail"] == "merchant is archived"
        assert fake.triggered == []
    finally:
        cleanup_override()


def test_start_run_rechecks_active_status_after_acquiring_writer_lock(client):
    from fastapi import HTTPException

    from app.db import connect
    from app.runs import start_run

    merchant = client.post(
        "/api/merchants",
        json={"name": "Stale run claim", "primary_location": "New York, NY"},
    ).json()
    stale_connection = connect()
    stale_merchant = stale_connection.execute(
        "SELECT * FROM merchants WHERE id=?", (merchant["id"],)
    ).fetchone()
    fake = FakeCoreAi()
    try:
        assert client.patch(
            f"/api/merchants/{merchant['id']}", json={"status": "archived"}
        ).status_code == 200

        with pytest.raises(HTTPException) as error:
            start_run(
                stale_connection,
                fake,
                "agent-t",
                stale_merchant,
                "manual",
            )

        assert error.value.status_code == 409
        assert error.value.detail == "merchant is archived"
        assert fake.triggered == []
        assert stale_connection.execute(
            "SELECT count(*) FROM runs WHERE merchant_id=?", (merchant["id"],)
        ).fetchone()[0] == 0
    finally:
        stale_connection.close()


def test_trigger_failure_stores_failed_run(client):
    override_coreai(FakeCoreAi(fail=True))
    try:
        m = client.post(
            "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
        ).json()
        res = client.post(f"/api/merchants/{m['id']}/runs")
        assert res.status_code == 201
        run = res.json()
        assert run["status"] == "failed"
        assert "core-ai down" in run["error"]
        assert run["finished_at"] is not None
        # 失败 run 不算进行中，可再次发起
        assert client.post(f"/api/merchants/{m['id']}/runs").status_code == 201
    finally:
        cleanup_override()


def test_list_and_get_runs(client):
    fake = FakeCoreAi()
    override_coreai(fake)
    try:
        m = client.post(
            "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
        ).json()
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
        listed = client.get(f"/api/merchants/{m['id']}/runs").json()
        assert [r["id"] for r in listed] == [run["id"]]
        assert "report_text" not in listed[0]
        detail = client.get(f"/api/runs/{run['id']}").json()
        assert detail["id"] == run["id"]
        assert "report_text" in detail
        assert client.get("/api/runs/999").status_code == 404
        assert client.get("/api/merchants/999/runs").status_code == 404
    finally:
        cleanup_override()


def test_patch_merchant_interval(client):
    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
    ).json()
    assert m["auto_run_interval_days"] is None
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 7})
    assert res.json()["auto_run_interval_days"] == 7
    res = client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": None})
    assert res.json()["auto_run_interval_days"] is None
    assert client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 0}).status_code == 422


def test_run_tasks_endpoint(client):
    import os
    import sqlite3

    m = client.post(
        "/api/merchants", json={"name": "M", "primary_location": "New York, NY"}
    ).json()
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
        " VALUES (?, 'rt1', 'succeeded', 'manual', '2026-09-01T00:00:00+00:00')",
        (m["id"],),
    )
    run_id = conn.execute("SELECT id FROM runs WHERE coreai_run_id='rt1'").fetchone()[0]
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, source_run_id, source_key, created_at)"
        " VALUES (?, 'from-run', ?, 'plan-rt1-a', '2026-09-01T00:06:00+00:00')",
        (m["id"], run_id),
    )
    conn.commit()
    conn.close()
    client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "manual"})

    tasks = client.get(f"/api/runs/{run_id}/tasks").json()
    assert [t["title"] for t in tasks] == ["from-run"]
    assert client.get("/api/runs/999/tasks").status_code == 404


def test_approve_plan_rejects_non_succeeded_run(client):
    _merchant_id, running_id = insert_run(client, status="running", with_task=True)
    _merchant_id, failed_id = insert_run(client, status="failed", with_task=True)

    assert client.post(f"/api/runs/{running_id}/approve-plan").status_code == 409
    assert client.post(f"/api/runs/{failed_id}/approve-plan").status_code == 409


def test_approve_plan_rejects_succeeded_run_without_generated_tasks(client):
    _merchant_id, run_id = insert_run(client, status="succeeded")

    response = client.post(f"/api/runs/{run_id}/approve-plan")

    assert response.status_code == 409
    assert response.json()["detail"] == "run has no generated plan"


def test_approve_plan_is_persisted_and_idempotent(client):
    _merchant_id, run_id = insert_run(client, status="succeeded", with_task=True)

    first = client.post(f"/api/runs/{run_id}/approve-plan")
    second = client.post(f"/api/runs/{run_id}/approve-plan")

    assert first.status_code == 200
    assert first.json()["plan_approved_at"] is not None
    assert second.status_code == 200
    assert second.json()["plan_approved_at"] == first.json()["plan_approved_at"]
    assert client.get(f"/api/runs/{run_id}").json()["plan_approved_at"] == first.json()["plan_approved_at"]


def test_archived_merchant_rejects_plan_approval(client):
    merchant_id, run_id = insert_run(client, status="succeeded", with_task=True)
    assert client.patch(
        f"/api/merchants/{merchant_id}", json={"status": "archived"}
    ).status_code == 200

    response = client.post(f"/api/runs/{run_id}/approve-plan")

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant is archived"
    assert client.get(f"/api/runs/{run_id}").json()["plan_approved_at"] is None


def test_plan_approval_rechecks_merchant_inside_writer_transaction(client, monkeypatch):
    from app import runs

    _merchant_id, run_id = insert_run(client, status="succeeded", with_task=True)
    original_fetch = runs.fetch_active_merchant
    active_reads = []

    def observed_fetch(conn, merchant_id):
        active_reads.append(conn.in_transaction)
        return original_fetch(conn, merchant_id)

    monkeypatch.setattr(runs, "fetch_active_merchant", observed_fetch)

    response = client.post(f"/api/runs/{run_id}/approve-plan")

    assert response.status_code == 200
    assert active_reads == [True]

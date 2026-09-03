import asyncio
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from helpers import FakeCoreAi, cleanup_override, override_coreai
from app.config import CoreAiSettings

REPORT_WITH_PLAN = '报告\n```json\n[{"id": "i1", "title": "T1", "rationale": "R1"}]\n```\n'


def test_skill_only_keyword_workflow_is_polled_without_legacy_keyword_agents():
    from app.scheduler import seo_target_poll_agents

    settings = CoreAiSettings(
        base_url="https://core-ai.example",
        api_key="secret",
        agent_id="diagnostic-agent",
        keyword_skill_agent_id="keyword-skill-agent",
        keyword_seed_skill_id="seed-skill",
        keyword_ranking_skill_id="ranking-skill",
    )

    agents = seo_target_poll_agents(settings)

    assert agents is not None
    assert agents.keyword == "keyword-skill-agent"
    assert agents.audit == ""
    assert agents.ranking == ""


def test_scheduler_recovers_db_only_dispatches_without_integrations(
    tmp_path, monkeypatch
):
    """Missing Core AI/Local Falcon config must not strand durable DB leases."""
    database = tmp_path / "scheduler-recovery.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    for name in (
        "COREAI_BASE_URL",
        "COREAI_API_KEY",
        "COREAI_AGENT_ID",
        "COREAI_LOCAL_FALCON_TOOL_ID",
        "COREAI_KEYWORD_SKILL_AGENT_ID",
        "COREAI_KEYWORD_SEED_SKILL_ID",
        "COREAI_KEYWORD_RANKING_SKILL_ID",
    ):
        monkeypatch.delenv(name, raising=False)

    from app.db import init_db
    from app import scheduler

    init_db()
    setup = sqlite3.connect(database)
    merchant_id = setup.execute(
        "INSERT INTO merchants (name, status, created_at)"
        " VALUES ('stale recovery', 'active', '2020-01-01T00:00:00+00:00')"
    ).lastrowid
    setup.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status,"
        " source_agent_id, dispatch_state, dispatch_started_at, request_json, created_at)"
        " VALUES (?, 'stale-keyword', 'KEYWORD_SET', 'seo_ops.keyword_set.v2',"
        " 'running', 'keyword-skill-agent', 'dispatching',"
        " '2020-01-01T00:00:00+00:00', '{}', '2020-01-01T00:00:00+00:00')",
        (merchant_id,),
    )
    batch_id = setup.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status,"
        " scan_config_json, dispatch_token, dispatch_started_at, created_at)"
        " VALUES (?, 981, 982, 'stale-local-falcon', 'submitting', '{}',"
        " 'stale-worker', '2020-01-01T00:00:00+00:00',"
        " '2020-01-01T00:00:00+00:00')",
        (merchant_id,),
    ).lastrowid
    setup.execute(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, updated_at)"
        " VALUES (?, 'coffee near me', 'submitting',"
        " '2020-01-01T00:00:00+00:00')",
        (batch_id,),
    )
    setup.commit()
    setup.close()

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.scheduler_loop())

    check = sqlite3.connect(database)
    keyword = check.execute(
        "SELECT status, dispatch_state, coreai_run_id"
        " FROM merchant_seo_artifacts WHERE cycle_id = 'stale-keyword'"
    ).fetchone()
    local_falcon = check.execute(
        "SELECT status, dispatch_token FROM merchant_local_falcon_scan_batches"
        " WHERE id = ?",
        (batch_id,),
    ).fetchone()
    item_status = check.execute(
        "SELECT status FROM merchant_local_falcon_scan_items WHERE batch_id = ?",
        (batch_id,),
    ).fetchone()[0]
    check.close()

    assert keyword == ("failed", "unknown", None)
    assert local_falcon == ("unknown", None)
    assert item_status == "unknown"


def test_scheduler_polls_acknowledged_reports_when_local_falcon_is_configured(
    monkeypatch
):
    from app import scheduler

    settings = CoreAiSettings(
        base_url="https://core-ai.example",
        api_key="secret",
        agent_id="diagnostic-agent",
        local_falcon_tool_id="local-falcon-tool",
    )
    calls = []

    monkeypatch.setattr(scheduler, "coreai_settings", lambda: settings)
    monkeypatch.setattr(scheduler, "recover_stale_seo_dispatches_once", lambda: None)
    monkeypatch.setattr(scheduler, "poll_runs_once", lambda _client: None)
    monkeypatch.setattr(scheduler, "poll_task_executions_once", lambda _client: None)
    monkeypatch.setattr(scheduler, "submit_local_falcon_batches_once", lambda _client: 0)
    monkeypatch.setattr(
        scheduler,
        "poll_acknowledged_local_falcon_reports_once",
        lambda local_falcon: calls.append(local_falcon),
        raising=False,
    )
    monkeypatch.setattr(scheduler, "auto_scan_once", lambda _client, _agent_id: None)

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.scheduler_loop())

    assert len(calls) == 1
    assert calls[0]._server_id == "local-falcon-tool"


def strict_audit(merchant_id: int) -> str:
    return json.dumps(
        {
            "schema_version": "seo_ops.audit_report.v1",
            "merchant_id": str(merchant_id),
            "title": "Initial local SEO audit",
            "summary": "The location identity is confirmed and the website needs review.",
            "evidence_mode": "PUBLIC_AND_CONFIRMED",
            "findings": [
                {
                    "id": "missing-schema",
                    "area": "TECHNICAL",
                    "severity": "MEDIUM",
                    "observation": "No Restaurant structured data was observed.",
                    "evidence": ["Public website source inspection."],
                    "recommendation": "Prepare a reviewed Restaurant JSON-LD draft.",
                }
            ],
            "limitations": ["No Search Console access was used."],
            "next_actions": ["Review the structured data recommendation."],
        }
    )


def iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def make_merchant_with_run(client, fake, name="M"):
    m = client.post(
        "/api/merchants", json={"name": name, "primary_location": "Mineola, NY"}
    ).json()
    override_coreai(fake)
    try:
        run = client.post(f"/api/merchants/{m['id']}/runs").json()
    finally:
        cleanup_override()
    return m, run


def test_poll_marks_succeeded_and_creates_tasks(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": REPORT_WITH_PLAN}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["report_text"] == REPORT_WITH_PLAN
    assert detail["finished_at"] is not None
    tasks = client.get(f"/api/merchants/{m['id']}/tasks").json()
    assert [t["title"] for t in tasks] == ["T1"]
    assert tasks[0]["source_run_id"] == run["id"]

    poll_runs_once(fake)  # 再跑一轮：终态 run 不再轮询，任务不重复
    assert len(client.get(f"/api/merchants/{m['id']}/tasks").json()) == 1


def test_poll_completed_without_plan_block_still_succeeds(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": "纯文本报告，没有 JSON 块"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "succeeded"
    assert client.get(f"/api/merchants/{m['id']}/tasks").json() == []


def test_poll_accepts_a_strict_audit_snapshot_for_the_completed_run(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    merchant, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": strict_audit(merchant["id"]),
    }

    poll_runs_once(fake)

    response = client.get(f"/api/runs/{run['id']}/audit")
    assert response.status_code == 200
    assert response.json()["audit"]["findings"][0]["id"] == "missing-schema"


def test_poll_marks_failed_on_terminal_failure(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "TIMEOUT", "error": "took too long"}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert "took too long" in detail["error"]


def test_poll_leaves_nonterminal_running(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "running"


def test_auto_scan_triggers_due_merchants_only(client):
    from app.db import connect
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    due = client.post(
        "/api/merchants", json={"name": "due", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{due['id']}", json={"auto_run_interval_days": 7})
    fresh = client.post(
        "/api/merchants", json={"name": "fresh", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{fresh['id']}", json={"auto_run_interval_days": 7})
    off = client.post(
        "/api/merchants", json={"name": "off", "primary_location": "Mineola, NY"}
    ).json()
    archived = client.post(
        "/api/merchants", json={"name": "arch", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{archived['id']}", json={"auto_run_interval_days": 1})
    client.patch(f"/api/merchants/{archived['id']}", json={"status": "archived"})

    conn = connect()
    try:
        # due：上次 run 8 天前结束；fresh：昨天结束
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-1', 'succeeded', 'manual', ?, ?)",
            (due["id"], iso_days_ago(8.1), iso_days_ago(8)),
        )
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'old-2', 'succeeded', 'manual', ?, ?)",
            (fresh["id"], iso_days_ago(1.1), iso_days_ago(1)),
        )
        conn.commit()
    finally:
        conn.close()

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1  # 只有 due
    runs = client.get(f"/api/merchants/{due['id']}/runs").json()
    assert runs[0]["trigger_kind"] == "auto"
    assert runs[0]["status"] == "running"
    assert client.get(f"/api/merchants/{fresh['id']}/runs").json()[0]["coreai_run_id"] == "old-2"
    assert client.get(f"/api/merchants/{off['id']}/runs").json() == []


def test_auto_scan_first_run_when_never_ran(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m = client.post(
        "/api/merchants", json={"name": "never", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 30})

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == 1


def test_auto_scan_skips_merchant_with_running_run(client):
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    m, _run = make_merchant_with_run(client, fake)
    client.patch(f"/api/merchants/{m['id']}", json={"auto_run_interval_days": 1})
    before = len(fake.triggered)

    auto_scan_once(fake, "agent-t")

    assert len(fake.triggered) == before


def test_poll_handles_malformed_completed_at_timestamp(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": REPORT_WITH_PLAN, "completed_at": "not-a-date"}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["finished_at"] is not None
    # Verify finished_at is a valid ISO string
    from datetime import datetime
    datetime.fromisoformat(detail["finished_at"])


def test_poll_handles_non_string_completed_at_timestamp(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    # completed_at as an epoch int (truthy non-string) must not raise TypeError
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": REPORT_WITH_PLAN,
        "completed_at": 1725100000,
    }

    poll_runs_once(fake)  # must not raise

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["finished_at"] is not None
    from datetime import datetime

    parsed = datetime.fromisoformat(detail["finished_at"])
    assert parsed.tzinfo is not None


def test_poll_stores_aware_finished_at_for_naive_completed_at(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    # naive ISO string (no tzinfo) must not be stored as-is; it silently breaks
    # auto_scan_once's aware-minus-naive subtraction later.
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": REPORT_WITH_PLAN,
        "completed_at": "2026-08-31T12:00:00",
    }

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    from datetime import datetime

    assert datetime.fromisoformat(detail["finished_at"]).tzinfo is not None


def test_auto_scan_continues_after_corrupt_merchant_timestamp(client):
    from app.db import connect
    from app.scheduler import auto_scan_once

    fake = FakeCoreAi()
    bad = client.post(
        "/api/merchants", json={"name": "bad", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{bad['id']}", json={"auto_run_interval_days": 7})
    good = client.post(
        "/api/merchants", json={"name": "good", "primary_location": "Mineola, NY"}
    ).json()
    client.patch(f"/api/merchants/{good['id']}", json={"auto_run_interval_days": 7})

    conn = connect()
    try:
        # Insert a run with corrupt finished_at for bad merchant
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'bad-run', 'succeeded', 'manual', ?, ?)",
            (bad["id"], iso_days_ago(8.1), "corrupt-timestamp"),
        )
        # Insert a valid run for good merchant
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
            " VALUES (?, 'good-run', 'succeeded', 'manual', ?, ?)",
            (good["id"], iso_days_ago(8.1), iso_days_ago(8)),
        )
        conn.commit()
    finally:
        conn.close()

    auto_scan_once(fake, "agent-t")

    # good merchant should have been triggered despite bad merchant's corrupt timestamp
    assert len(fake.triggered) == 1
    runs = client.get(f"/api/merchants/{good['id']}/runs").json()
    assert runs[0]["trigger_kind"] == "auto"
    assert runs[0]["status"] == "running"


def test_hourly_fbr_sync_only_calls_due_active_bound_merchants_and_isolates_failures(
    client,
):
    from app.db import connect
    from app.fbr_gbp import FbrUnavailableError
    from app.scheduler import sync_due_fbr_profiles_once

    now = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)

    def merchant_with_link(name, external_id, status, updated_at, last_synced_at=None):
        merchant = client.post(
            "/api/merchants",
            json={"name": name, "primary_location": "Mineola, NY"},
        ).json()
        client.put(
            f"/api/merchants/{merchant['id']}/fbr-link",
            json={"fbr_merchant_id": external_id},
        )
        conn = connect()
        try:
            conn.execute(
                "UPDATE merchant_fbr_links"
                " SET sync_status = ?, updated_at = ?, last_synced_at = ?"
                " WHERE merchant_id = ?",
                (status, updated_at, last_synced_at, merchant["id"]),
            )
            conn.commit()
        finally:
            conn.close()
        return merchant

    old = "2026-09-03T10:59:59+00:00"
    fresh = "2026-09-03T11:30:00+00:00"
    failed = merchant_with_link("failed due", "fbr-fail", "failed", old, old)
    due = merchant_with_link("synced due", "fbr-due", "synced", old, old)
    merchant_with_link("synced fresh", "fbr-fresh", "synced", fresh, fresh)
    merchant_with_link("failed fresh", "fbr-failed-fresh", "failed", fresh, old)
    never = merchant_with_link("never synced", "fbr-never", "not_synced", fresh)
    archived = merchant_with_link("archived", "fbr-archived", "synced", old, old)
    client.patch(f"/api/merchants/{archived['id']}", json={"status": "archived"})
    client.post(
        "/api/merchants",
        json={"name": "unbound", "primary_location": "Mineola, NY"},
    )

    class IsolatingClient:
        def __init__(self):
            self.calls = []

        def list_locations(self, fbr_merchant_id):
            self.calls.append(fbr_merchant_id)
            if fbr_merchant_id == "fbr-fail":
                raise FbrUnavailableError("temporary FBR outage")
            return []

    fake = IsolatingClient()
    result = sync_due_fbr_profiles_once(fake, current_time=now)

    assert fake.calls == ["fbr-fail", "fbr-due", "fbr-never"]
    assert result == {"attempted": 3, "synced": 2, "failed": 1}

    conn = connect()
    try:
        failed_row = conn.execute(
            "SELECT sync_status, last_synced_at, last_error FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (failed["id"],),
        ).fetchone()
        due_row = conn.execute(
            "SELECT sync_status, last_synced_at FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (due["id"],),
        ).fetchone()
        never_row = conn.execute(
            "SELECT sync_status, last_synced_at FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (never["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert dict(failed_row) == {
        "sync_status": "failed",
        "last_synced_at": old,
        "last_error": "temporary FBR outage",
    }
    assert dict(due_row) == {
        "sync_status": "synced",
        "last_synced_at": now.isoformat(),
    }
    assert dict(never_row) == {
        "sync_status": "synced",
        "last_synced_at": now.isoformat(),
    }


def test_scheduler_checks_due_fbr_profiles_each_tick_without_core_ai_configuration(monkeypatch):
    from app import scheduler

    fbr_client = object()
    calls = []
    sleeps = 0

    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client, raising=False)
    monkeypatch.setattr(
        scheduler,
        "sync_due_fbr_profiles_once",
        lambda client: calls.append(client),
        raising=False,
    )

    class TwoTicksComplete(Exception):
        pass

    async def stop_after_two_ticks(_delay):
        nonlocal sleeps
        sleeps += 1
        if sleeps == 2:
            raise TwoTicksComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_two_ticks)
    with pytest.raises(TwoTicksComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

    assert scheduler.FBR_DUE_CHECK_EVERY_TICKS == 1
    assert calls == [fbr_client, fbr_client]


def test_fbr_due_scan_uses_a_fresh_clock_for_each_merchant(client, monkeypatch):
    from app import scheduler

    for suffix in ("one", "two"):
        merchant = client.post(
            "/api/merchants",
            json={"name": f"clock {suffix}", "primary_location": "Mineola, NY"},
        ).json()
        linked = client.put(
            f"/api/merchants/{merchant['id']}/fbr-link",
            json={"fbr_merchant_id": f"fbr-clock-{suffix}"},
        )
        assert linked.status_code == 200

    first = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)
    second = first + timedelta(minutes=20)
    clock = iter((first, second))

    class PerMerchantClock:
        @classmethod
        def now(cls, tz=None):
            assert tz is timezone.utc
            return next(clock)

    observed_due_times = []
    observed_sync_kwargs = []
    monkeypatch.setattr(scheduler, "datetime", PerMerchantClock)
    monkeypatch.setattr(
        scheduler,
        "gbp_sync_due",
        lambda _link, current: (observed_due_times.append(current) or True),
    )
    monkeypatch.setattr(
        scheduler,
        "sync_gbp_profile_once",
        lambda _conn, _client, merchant_id, **kwargs: (
            observed_sync_kwargs.append((merchant_id, kwargs)) or True
        ),
    )

    result = scheduler.sync_due_fbr_profiles_once(object())

    assert observed_due_times == [first, second]
    assert [kwargs for _merchant_id, kwargs in observed_sync_kwargs] == [{}, {}]
    assert result == {"attempted": 2, "synced": 2, "failed": 0}


def test_hourly_fbr_sync_loop_is_independent_of_core_ai_polling(monkeypatch):
    from app import scheduler

    fbr_client = object()
    calls = []

    monkeypatch.setattr(
        scheduler,
        "coreai_settings",
        lambda: (_ for _ in ()).throw(AssertionError("FBR loop must not inspect Core AI")),
    )
    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client)
    monkeypatch.setattr(
        scheduler,
        "sync_due_fbr_profiles_once",
        lambda client: calls.append(client),
    )

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

    assert calls == [fbr_client]

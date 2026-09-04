import asyncio
import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from helpers import FakeCoreAi, cleanup_override, override_coreai
from app.config import CoreAiSettings

REPORT_WITH_PLAN = "\n".join(
    [
        "报告",
        "```json",
        json.dumps(
            {
                "schema_version": "seo_ops.task_plan.v1",
                "tasks": [
                    {
                        "key": "i1",
                        "task_type": "PREPARE_ONLY",
                        "title": "T1",
                        "rationale": "R1",
                        "expected_outcome": "E1",
                        "depends_on": [],
                        "scheduled_start": None,
                        "parameters": {"description": "D1", "category": "technical"},
                    }
                ],
            }
        ),
        "```",
    ]
)


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
    run_id = setup.execute(
        "INSERT INTO runs (merchant_id,status,trigger_kind,dispatch_state,"
        "dispatch_token,dispatch_started_at,created_at) VALUES "
        "(?,'running','manual','DISPATCHING','stale-run-token',"
        "'2020-01-01T00:00:00+00:00','2020-01-01T00:00:00+00:00')",
        (merchant_id,),
    ).lastrowid
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
    run_dispatch = check.execute(
        "SELECT status,dispatch_state,error FROM runs WHERE id=?", (run_id,)
    ).fetchone()
    check.close()

    assert keyword == ("failed", "unknown", None)
    assert local_falcon == ("unknown", None)
    assert item_status == "unknown"
    assert run_dispatch == (
        "running",
        "UNKNOWN",
        "COREAI_DISPATCH_STALE_UNKNOWN",
    )


def test_scheduler_polls_acknowledged_reports_when_local_falcon_is_configured(
    monkeypatch,
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
    monkeypatch.setattr(scheduler, "recover_stale_run_dispatches_once", lambda: None)
    monkeypatch.setattr(scheduler, "recover_stale_seo_dispatches_once", lambda: None)
    monkeypatch.setattr(scheduler, "recover_stale_task_dispatches_once", lambda: None)
    monkeypatch.setattr(scheduler, "poll_runs_once", lambda _client: None)
    monkeypatch.setattr(scheduler, "poll_task_executions_once", lambda _client: None)
    monkeypatch.setattr(
        scheduler, "submit_local_falcon_batches_once", lambda _client: 0
    )
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


def test_poll_marks_succeeded_and_persists_draft_plan_without_tasks(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": REPORT_WITH_PLAN,
    }

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["report_text"] == REPORT_WITH_PLAN
    assert detail["finished_at"] is not None
    assert client.get(f"/api/merchants/{m['id']}/tasks").json() == []
    plan = client.get(f"/api/runs/{run['id']}/task-plan").json()
    assert plan["current_revision"]["decision_state"] == "DRAFT"
    assert plan["current_revision"]["payload"]["tasks"][0]["title"] == "T1"

    poll_runs_once(fake)  # 再跑一轮：终态 run 不再轮询，Plan 不重复
    assert client.get(f"/api/runs/{run['id']}/task-plan").json()["id"] == plan["id"]
    assert client.get(f"/api/merchants/{m['id']}/tasks").json() == []


def test_poll_completed_without_plan_block_still_succeeds(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": "纯文本报告，没有 JSON 块",
    }

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


def test_poll_sanitizes_a_malicious_run_error_before_persistence(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "FAILED",
        "error": (
            "\x00 forged\nAuthorization: Bearer upstream-secret\r\n" + "x" * 1000
        ),
    }

    poll_runs_once(fake)

    stored = client.get(f"/api/runs/{run['id']}").json()["error"]
    assert len(stored) <= 500
    assert "upstream-secret" not in stored
    assert "\x00" not in stored
    assert "\n" not in stored
    assert "\r" not in stored


@pytest.mark.parametrize("unsafe_output", [{"unexpected": "object"}, ["list"]])
def test_poll_completed_non_text_run_output_fails_closed(client, unsafe_output):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": unsafe_output,
    }

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert detail["report_text"] is None
    assert "invalid output" in detail["error"]


def test_poll_leaves_nonterminal_running(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    m, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)

    assert client.get(f"/api/runs/{run['id']}").json()["status"] == "running"


@pytest.mark.parametrize("status_code", [404, 410])
def test_run_poll_terminalizes_a_missing_bound_provider_run(client, status_code):
    from app.coreai import CoreAiError
    from app.scheduler import poll_runs_once

    class MissingRunCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(status_code, "run not found")

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake, "Missing diagnosis run")

    poll_runs_once(MissingRunCoreAi())

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert detail["dispatch_state"] == "FAILED"
    assert detail["coreai_run_id"] is None
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] == "COREAI_RUN_NO_LONGER_AVAILABLE"
    assert detail["finished_at"] is not None


def test_run_poll_keeps_fresh_transient_provider_error_retryable(client):
    from app.coreai import CoreAiError
    from app.db import connect
    from app.scheduler import poll_runs_once

    class UnavailableCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(503, "temporarily unavailable")

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake, "Fresh poll failure")
    conn = connect()
    try:
        conn.execute(
            "UPDATE runs SET dispatch_started_at=? WHERE id=?",
            (
                (datetime.now(timezone.utc) - timedelta(minutes=16)).isoformat(),
                run["id"],
            ),
        )
        conn.commit()
    finally:
        conn.close()

    poll_runs_once(UnavailableCoreAi())

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "running"
    assert detail["dispatch_state"] == "DISPATCHED"
    assert detail["coreai_run_id"] == run["coreai_run_id"]
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] is None
    conn = connect()
    try:
        failure_started_at = conn.execute(
            "SELECT poll_failure_started_at FROM runs WHERE id=?", (run["id"],)
        ).fetchone()[0]
    finally:
        conn.close()
    assert datetime.fromisoformat(failure_started_at).tzinfo is not None


def test_run_poll_terminalizes_a_stale_continuous_provider_failure(client):
    from app.coreai import CoreAiError
    from app.db import connect
    from app.scheduler import poll_runs_once

    class UnavailableCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(503, "temporarily unavailable")

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake, "Stale poll failure")
    conn = connect()
    try:
        conn.execute(
            "UPDATE runs SET poll_failure_started_at=? WHERE id=?",
            (
                (datetime.now(timezone.utc) - timedelta(minutes=16)).isoformat(),
                run["id"],
            ),
        )
        conn.commit()
    finally:
        conn.close()

    poll_runs_once(UnavailableCoreAi())

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert detail["dispatch_state"] == "FAILED"
    assert detail["coreai_run_id"] is None
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] == "COREAI_RUN_POLL_STALE"


def test_valid_run_poll_clears_the_consecutive_failure_clock(client):
    from app.db import connect
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake, "Recovered poll")
    conn = connect()
    try:
        conn.execute(
            "UPDATE runs SET poll_failure_started_at=? WHERE id=?",
            (
                (datetime.now(timezone.utc) - timedelta(minutes=14)).isoformat(),
                run["id"],
            ),
        )
        conn.commit()
    finally:
        conn.close()
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)

    conn = connect()
    try:
        stored = conn.execute(
            "SELECT dispatch_state,poll_failure_started_at FROM runs WHERE id=?",
            (run["id"],),
        ).fetchone()
    finally:
        conn.close()
    assert tuple(stored) == ("DISPATCHED", None)


def test_unsupported_provider_status_starts_the_poll_failure_clock(client):
    from app.db import connect
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake, "Unsupported status")
    fake.runs[run["coreai_run_id"]] = {"status": "BROKEN"}

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["dispatch_state"] == "DISPATCHED"
    conn = connect()
    try:
        failure_started_at = conn.execute(
            "SELECT poll_failure_started_at FROM runs WHERE id=?", (run["id"],)
        ).fetchone()[0]
    finally:
        conn.close()
    assert datetime.fromisoformat(failure_started_at).tzinfo is not None


def test_bound_run_unavailable_after_reconciliation_has_truthful_terminal_history(
    client,
):
    from app.coreai import CoreAiError
    from app.db import connect
    from app.scheduler import poll_runs_once

    class MissingRunCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(404, "run not found")

    captured = {}
    fake = FakeCoreAi()

    def uncertain_trigger(agent_id, input_text):
        captured["agent_id"] = agent_id
        captured["input"] = input_text
        raise CoreAiError(503, "provider outcome uncertain")

    fake.trigger = uncertain_trigger
    override_coreai(fake)
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Bound then unavailable", "primary_location": "Mineola, NY"},
        ).json()
        run = client.post(f"/api/merchants/{merchant['id']}/runs").json()
    finally:
        cleanup_override()
    assert run["dispatch_state"] == "UNKNOWN"
    provider_run_id = "recovered-provider-run"
    old_failure_clock = "2020-01-01T00:00:00+00:00"
    conn = connect()
    try:
        conn.execute(
            "UPDATE runs SET dispatch_started_at=?,poll_failure_started_at=? WHERE id=?",
            (old_failure_clock, old_failure_clock, run["id"]),
        )
        conn.commit()
    finally:
        conn.close()
    fake.runs[provider_run_id] = {
        "id": provider_run_id,
        "agent_id": captured["agent_id"],
        "input": captured["input"],
        "status": "RUNNING",
    }
    override_coreai(fake)
    try:
        first = client.post(
            f"/api/runs/{run['id']}/reconcile-dispatch",
            json={
                "action": "BIND_EXISTING",
                "provider_run_id": provider_run_id,
                "reason": "Verified the exact Agent and input in Core AI.",
            },
        )
    finally:
        cleanup_override()
    assert first.status_code == 200
    assert first.json()["dispatch_state"] == "DISPATCHED"
    conn = connect()
    try:
        rebound_clock = conn.execute(
            "SELECT dispatch_started_at,poll_failure_started_at FROM runs WHERE id=?",
            (run["id"],),
        ).fetchone()
    finally:
        conn.close()
    assert rebound_clock[0] != old_failure_clock
    assert datetime.fromisoformat(rebound_clock[0]).tzinfo is not None
    assert rebound_clock[1] is None

    poll_runs_once(MissingRunCoreAi())
    terminal = client.get(f"/api/runs/{run['id']}").json()
    assert terminal["status"] == "failed"
    assert terminal["dispatch_state"] == "FAILED"
    assert terminal["coreai_run_id"] is None
    assert terminal["provider_candidate_run_id"] == provider_run_id
    assert terminal["error"] == "COREAI_RUN_NO_LONGER_AVAILABLE"

    conn = connect()
    try:
        events = conn.execute(
            "SELECT action,result_dispatch_state FROM run_dispatch_reconciliations "
            "WHERE run_id=? ORDER BY id",
            (run["id"],),
        ).fetchall()
    finally:
        conn.close()
    assert [tuple(event) for event in events] == [("BIND_EXISTING", "DISPATCHED")]
    override_coreai(fake)
    try:
        restarted = client.post(f"/api/merchants/{merchant['id']}/runs")
    finally:
        cleanup_override()
    assert restarted.status_code == 201


@pytest.mark.parametrize("returned_id", [None, "another-coreai-run"])
def test_poll_run_rejects_a_missing_or_mismatched_coreai_identity(client, returned_id):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = make_merchant_with_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "id": returned_id,
        "status": "COMPLETED",
        "output": "must not be persisted",
    }

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "running"
    assert detail["report_text"] is None


def test_run_poll_rejects_archive_restore_aba_after_network_return(client):
    from app.scheduler import poll_runs_once
    from helpers import force_merchant_lifecycle_cycle, formal_workflow_snapshot

    class LifecycleCyclingCoreAi(FakeCoreAi):
        def __init__(self, merchant_id):
            super().__init__()
            self.merchant_id = merchant_id
            self.cycled = False

        def get_run(self, run_id):
            if not self.cycled:
                force_merchant_lifecycle_cycle(self.merchant_id)
                self.cycled = True
            return super().get_run(run_id)

    seed = FakeCoreAi()
    merchant, run = make_merchant_with_run(client, seed, "Run lifecycle ABA")
    fake = LifecycleCyclingCoreAi(merchant["id"])
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": REPORT_WITH_PLAN,
    }
    before = formal_workflow_snapshot()

    poll_runs_once(fake)

    assert fake.cycled is True
    after = formal_workflow_snapshot()
    assert after["task_plans"] == before["task_plans"]
    assert after["task_plan_revisions"] == before["task_plan_revisions"]
    assert after["tasks"] == before["tasks"]
    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "failed"
    assert detail["dispatch_state"] == "FAILED"
    assert detail["coreai_run_id"] is None
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] == "MERCHANT_LIFECYCLE_CHANGED_DURING_RUN"
    assert detail["report_text"] is None
    assert detail["finished_at"] is not None
    assert client.get(f"/api/runs/{run['id']}/task-plan").status_code == 404
    override_coreai(seed)
    try:
        restarted = client.post(f"/api/merchants/{merchant['id']}/runs")
    finally:
        cleanup_override()
    assert restarted.status_code == 201


def test_run_poll_rejects_lifecycle_aba_before_first_provider_read(client):
    from app.scheduler import poll_runs_once
    from helpers import force_merchant_lifecycle_cycle

    class CountingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.reads = 0

        def get_run(self, run_id):
            self.reads += 1
            return super().get_run(run_id)

    fake = CountingCoreAi()
    merchant, run = make_merchant_with_run(client, fake, "Before first poll ABA")
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}
    force_merchant_lifecycle_cycle(merchant["id"])

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert fake.reads == 0
    assert detail["status"] == "failed"
    assert detail["dispatch_state"] == "FAILED"
    assert detail["coreai_run_id"] is None
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] == "MERCHANT_LIFECYCLE_CHANGED_DURING_RUN"


def test_run_poll_detects_lifecycle_aba_between_nonterminal_ticks(client):
    from app.scheduler import poll_runs_once
    from helpers import force_merchant_lifecycle_cycle

    class CountingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.reads = 0

        def get_run(self, run_id):
            self.reads += 1
            return super().get_run(run_id)

    fake = CountingCoreAi()
    merchant, run = make_merchant_with_run(client, fake, "Between tick ABA")
    fake.runs[run["coreai_run_id"]] = {"status": "RUNNING"}

    poll_runs_once(fake)
    assert fake.reads == 1
    assert client.get(f"/api/runs/{run['id']}").json()["dispatch_state"] == "DISPATCHED"

    force_merchant_lifecycle_cycle(merchant["id"])
    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert fake.reads == 1
    assert detail["status"] == "failed"
    assert detail["dispatch_state"] == "FAILED"
    assert detail["coreai_run_id"] is None
    assert detail["provider_candidate_run_id"] == run["coreai_run_id"]
    assert detail["error"] == "MERCHANT_LIFECYCLE_CHANGED_DURING_RUN"


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
    assert (
        client.get(f"/api/merchants/{fresh['id']}/runs").json()[0]["coreai_run_id"]
        == "old-2"
    )
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
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": REPORT_WITH_PLAN,
        "completed_at": "not-a-date",
    }

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


def _operator_task(client, merchant_id):
    response = client.post(
        f"/api/merchants/{merchant_id}/tasks",
        json={
            "task_type": "PREPARE_ONLY",
            "title": "Prepare evidence",
            "rationale": "Evidence is needed",
            "expected_outcome": "A reviewable evidence bundle",
            "parameters": {"description": "Read-only preparation"},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _insert_historical_execution(
    task: dict, *, status: str, coreai_run_id: str | None, dispatch_started_at: str
) -> int:
    from app.db import connect

    request_json = json.dumps(
        {"historical": True, "task_id": task["id"]},
        sort_keys=True,
        separators=(",", ":"),
    )
    request_checksum = hashlib.sha256(request_json.encode()).hexdigest()
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'PREPARING', version = version + 1 WHERE id = ?",
            (task["id"],),
        )
        cursor = conn.execute(
            "INSERT INTO task_executions "
            "(task_id, stage, status, attempt, request_json, request_checksum, "
            "idempotency_key, coreai_run_id, dispatch_token, dispatch_started_at, "
            "evidence_json, created_at) VALUES "
            "(?, 'PREPARATION', ?, 1, ?, ?, ?, ?, ?, ?, '[]', ?)",
            (
                task["id"],
                status,
                request_json,
                request_checksum,
                f"historical:{task['id']}",
                coreai_run_id,
                f"dispatch-{task['id']}",
                dispatch_started_at,
                dispatch_started_at,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)
    finally:
        conn.close()


def _insert_llm_dispatch(task: dict, dispatch_started_at: str) -> int:
    from app.db import connect

    request = {
        "definition_checksum": task["definition_checksum"],
        "executor_kind": "COREAI_LLM_CALL",
        "input": "Prepare without external writes",
        "llm_call_id": "llm-call-preparation",
        "stage": "PREPARATION",
        "task_id": task["id"],
        "workflow_version": task["workflow_version"],
    }
    request_json = json.dumps(request, sort_keys=True, separators=(",", ":"))
    request_checksum = hashlib.sha256(request_json.encode()).hexdigest()
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'PREPARING', version = version + 1 WHERE id = ?",
            (task["id"],),
        )
        cursor = conn.execute(
            "INSERT INTO task_executions "
            "(task_id, stage, status, attempt, request_json, request_checksum, "
            "idempotency_key, dispatch_token, dispatch_started_at, evidence_json, created_at) "
            "VALUES (?, 'PREPARATION', 'DISPATCHING', 1, ?, ?, ?, ?, ?, '[]', ?)",
            (
                task["id"],
                request_json,
                request_checksum,
                f"task:{task['id']}:preparation:1:{request_checksum[:16]}",
                f"dispatch-{task['id']}",
                dispatch_started_at,
                dispatch_started_at,
            ),
        )
        conn.commit()
        return int(cursor.lastrowid)
    finally:
        conn.close()


def test_poll_preserves_historical_running_execution_compatibility(client):
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    merchant = client.post(
        "/api/merchants",
        json={"name": "Task poll", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="historical-run",
        dispatch_started_at="2026-09-03T11:59:00+00:00",
    )
    fake.runs["historical-run"] = {
        "status": "FAILED",
        "error": "generation failed",
        "completed_at": "2026-09-03T12:00:00+00:00",
    }

    poll_task_executions_once(fake)

    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["status"] == "NEEDS_ATTENTION"
    assert detail["executions"][-1]["id"] == execution_id
    assert detail["executions"][-1]["status"] == "FAILED"
    assert detail["executions"][-1]["error"] == "generation failed"
    assert detail["events"][-1]["event_type"] == "TASK_PREPARATION_FAILED"


def test_task_poll_rejects_archive_restore_aba_after_network_return(client):
    from app.scheduler import poll_task_executions_once
    from helpers import force_merchant_lifecycle_cycle, formal_workflow_snapshot

    merchant = client.post(
        "/api/merchants",
        json={"name": "Task poll lifecycle ABA", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="task-poll-lifecycle-aba",
        dispatch_started_at=datetime.now(timezone.utc).isoformat(),
    )

    class LifecycleCyclingCoreAi(FakeCoreAi):
        def get_run(self, run_id):
            force_merchant_lifecycle_cycle(merchant["id"])
            return {
                "id": run_id,
                "status": "FAILED",
                "error": "must not be persisted",
            }

    before = formal_workflow_snapshot()

    with pytest.raises(
        RuntimeError, match="active preparation is detached from its PREPARING Task"
    ):
        poll_task_executions_once(LifecycleCyclingCoreAi())

    assert formal_workflow_snapshot() == before
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["merchant_status"] == "active"
    assert detail["status"] == "PREPARING"
    assert detail["executions"][-1]["id"] == execution_id
    assert detail["executions"][-1]["status"] == "RUNNING"
    assert "must not be persisted" not in str(detail)


def test_task_poll_sanitizes_a_malicious_terminal_error_before_persistence(client):
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    merchant = client.post(
        "/api/merchants",
        json={"name": "Unsafe error", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="unsafe-error-run",
        dispatch_started_at=datetime.now(timezone.utc).isoformat(),
    )
    fake.runs["unsafe-error-run"] = {
        "status": "FAILED",
        "error": (
            "\x00 forged\n"
            "access_token=access-token-value "
            "client_secret:'client-secret-value' "
            'password="password-value" '
            '{"api_key":"quoted-api-key-value"}\r\n' + "x" * 1000
        ),
    }

    poll_task_executions_once(fake)

    detail = client.get(f"/api/tasks/{task['id']}").json()
    stored = detail["executions"][-1]["error"]
    event_error = detail["events"][-1]["payload"]["error"]
    assert event_error == stored
    assert len(stored) <= 500
    for secret in (
        "access-token-value",
        "client-secret-value",
        "password-value",
        "quoted-api-key-value",
    ):
        assert secret not in stored
    assert "\x00" not in stored
    assert "\n" not in stored
    assert "\r" not in stored


def test_task_poll_completed_non_text_output_fails_closed(client):
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    merchant = client.post(
        "/api/merchants",
        json={"name": "Unsafe terminal output", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="unsafe-output-run",
        dispatch_started_at=datetime.now(timezone.utc).isoformat(),
    )
    fake.runs["unsafe-output-run"] = {
        "status": "COMPLETED",
        "output": {"password": "must-not-be-bound-or-persisted"},
    }

    poll_task_executions_once(fake)

    detail = client.get(f"/api/tasks/{task['id']}").json()
    execution = detail["executions"][-1]
    assert detail["status"] == "NEEDS_ATTENTION"
    assert execution["id"] == execution_id
    assert execution["status"] == "FAILED"
    assert "invalid output" in execution["error"]
    assert "must-not-be-bound-or-persisted" not in str(detail)


def test_poll_never_approves_historical_agent_completed_output(client):
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    merchant = client.post(
        "/api/merchants",
        json={"name": "Legacy completed task", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="historical-completed-run",
        dispatch_started_at="2026-09-03T11:59:00+00:00",
    )
    fake.runs["historical-completed-run"] = {
        "status": "COMPLETED",
        "output": (
            '{"artifact_refs":["artifact://legacy"],'
            '"evidence":["Legacy Agent output"],'
            '"external_write_performed":false,"outcome":"ready",'
            '"summary":"Looks reviewable but lacks a trusted LLM Call envelope"}'
        ),
        "completed_at": "2026-09-03T12:00:00+00:00",
    }

    poll_task_executions_once(fake)

    detail = client.get(f"/api/tasks/{task['id']}").json()
    execution = detail["executions"][-1]
    assert detail["status"] == "NEEDS_ATTENTION"
    assert execution["id"] == execution_id
    assert execution["status"] == "UNKNOWN"
    assert execution["result"] is None
    assert execution["request"] == {"historical": True, "task_id": task["id"]}
    assert "historical Agent" in execution["error"]
    assert "unreviewable" in execution["error"]
    assert detail["events"][-1]["event_type"] == "TASK_PREPARATION_UNKNOWN"
    assert detail["events"][-1]["payload"]["reason"] == "legacy_agent_unreviewable"
    assert fake.llm_calls == []
    assert fake.triggered == []

    recovered_state = (detail["version"], len(detail["events"]))
    poll_task_executions_once(fake)
    reread = client.get(f"/api/tasks/{task['id']}").json()
    assert (reread["version"], len(reread["events"])) == recovered_state

    approval = client.post(
        f"/api/tasks/{task['id']}/approve-execution",
        json={
            "expected_version": reread["version"],
            "expected_execution_id": execution_id,
            "expected_result_checksum": "0" * 64,
        },
    )
    assert approval.status_code == 409
    assert approval.json()["detail"] == "task is not awaiting preparation approval"
    assert fake.llm_calls == []
    assert fake.triggered == []


def test_poll_marks_a_definitively_missing_coreai_run_unknown_once(client):
    from app.coreai import CoreAiError
    from app.scheduler import poll_task_executions_once

    class MissingRunCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(404, "run not found")

    merchant = client.post(
        "/api/merchants",
        json={"name": "Missing run", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="missing-coreai-run",
        dispatch_started_at=datetime.now(timezone.utc).isoformat(),
    )

    poll_task_executions_once(MissingRunCoreAi())

    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["status"] == "NEEDS_ATTENTION"
    assert detail["executions"][-1]["id"] == execution_id
    assert detail["executions"][-1]["status"] == "UNKNOWN"
    assert "not found" in detail["executions"][-1]["error"]
    assert detail["events"][-1]["payload"]["reason"] == "coreai_run_not_found"
    recovered_state = (detail["version"], len(detail["events"]))

    poll_task_executions_once(MissingRunCoreAi())

    reread = client.get(f"/api/tasks/{task['id']}").json()
    assert (reread["version"], len(reread["events"])) == recovered_state


@pytest.mark.parametrize("returned_id", [None, "another-coreai-run"])
def test_task_poll_rejects_a_missing_or_mismatched_coreai_identity(client, returned_id):
    from app.scheduler import poll_task_executions_once

    class WrongRunCoreAi:
        def get_run(self, _run_id):
            return {
                "id": returned_id,
                "status": "FAILED",
                "error": "belongs to another upstream run",
            }

    merchant = client.post(
        "/api/merchants",
        json={"name": "Wrong run", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_historical_execution(
        task,
        status="RUNNING",
        coreai_run_id="expected-coreai-run",
        dispatch_started_at=datetime.now(timezone.utc).isoformat(),
    )

    poll_task_executions_once(WrongRunCoreAi())

    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["status"] == "PREPARING"
    assert detail["executions"][-1]["id"] == execution_id
    assert detail["executions"][-1]["status"] == "RUNNING"
    assert detail["executions"][-1]["error"] is None


def test_poll_bounds_transient_errors_by_execution_age(client):
    from app.coreai import CoreAiError
    from app.scheduler import poll_task_executions_once

    class UnavailableCoreAi:
        def get_run(self, _run_id):
            raise CoreAiError(503, "temporarily unavailable")

    merchant = client.post(
        "/api/merchants",
        json={"name": "Poll ceiling", "primary_location": "New York, NY"},
    ).json()
    stale_task = _operator_task(client, merchant["id"])
    fresh_task = _operator_task(client, merchant["id"])
    stale_execution_id = _insert_historical_execution(
        stale_task,
        status="RUNNING",
        coreai_run_id="stale-poll-run",
        dispatch_started_at=(
            datetime.now(timezone.utc) - timedelta(minutes=16)
        ).isoformat(),
    )
    fresh_execution_id = _insert_historical_execution(
        fresh_task,
        status="RUNNING",
        coreai_run_id="fresh-poll-run",
        dispatch_started_at=(
            datetime.now(timezone.utc) - timedelta(minutes=14)
        ).isoformat(),
    )

    poll_task_executions_once(UnavailableCoreAi())

    stale = client.get(f"/api/tasks/{stale_task['id']}").json()
    assert stale["status"] == "NEEDS_ATTENTION"
    assert stale["executions"][-1]["id"] == stale_execution_id
    assert stale["executions"][-1]["status"] == "UNKNOWN"
    assert stale["events"][-1]["payload"]["reason"] == "coreai_poll_stale"
    fresh = client.get(f"/api/tasks/{fresh_task['id']}").json()
    assert fresh["status"] == "PREPARING"
    assert fresh["executions"][-1]["id"] == fresh_execution_id
    assert fresh["executions"][-1]["status"] == "RUNNING"


def test_synchronous_llm_call_rejects_unstructured_result(client):
    from app.main import app
    from app.tasks import get_execution_coreai

    fake = FakeCoreAi()
    fake.llm_output = "not structured JSON"
    app.dependency_overrides[get_execution_coreai] = lambda: (
        fake,
        "llm-call-preparation",
    )
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Unsafe output", "primary_location": "New York, NY"},
        ).json()
        task = _operator_task(client, merchant["id"])
        response = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"]},
        )

        assert response.status_code == 201
        assert response.json()["status"] == "FAILED"
        assert len(fake.llm_calls) == 1
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["executions"][-1]["status"] == "FAILED"
        assert "structured JSON" in detail["executions"][-1]["error"]
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_poll_marks_only_stale_llm_dispatch_unknown_without_redispatch(client):
    from app.scheduler import poll_task_executions_once

    merchant = client.post(
        "/api/merchants",
        json={"name": "Stale dispatch", "primary_location": "New York, NY"},
    ).json()
    stale_task = _operator_task(client, merchant["id"])
    fresh_task = _operator_task(client, merchant["id"])
    stale_at = (datetime.now(timezone.utc) - timedelta(minutes=16)).isoformat()
    fresh_at = (datetime.now(timezone.utc) - timedelta(minutes=14)).isoformat()
    stale_execution_id = _insert_llm_dispatch(stale_task, stale_at)
    fresh_execution_id = _insert_llm_dispatch(fresh_task, fresh_at)
    fake = FakeCoreAi()

    poll_task_executions_once(fake)

    stale = client.get(f"/api/tasks/{stale_task['id']}").json()
    assert stale["status"] == "NEEDS_ATTENTION"
    assert stale["executions"][-1]["id"] == stale_execution_id
    assert stale["executions"][-1]["status"] == "UNKNOWN"
    assert stale["events"][-1]["event_type"] == "TASK_PREPARATION_UNKNOWN"
    recovered_state = (stale["version"], len(stale["events"]))
    poll_task_executions_once(fake)
    stale_again = client.get(f"/api/tasks/{stale_task['id']}").json()
    assert (stale_again["version"], len(stale_again["events"])) == recovered_state
    retry = client.post(
        f"/api/tasks/{stale_task['id']}/retry-preparation",
        json={
            "expected_version": stale_again["version"],
            "reason": "Human accepts possible duplicate model cost",
        },
    )
    assert retry.status_code == 200
    assert retry.json()["status"] == "PENDING"
    fresh = client.get(f"/api/tasks/{fresh_task['id']}").json()
    assert fresh["status"] == "PREPARING"
    assert fresh["executions"][-1]["id"] == fresh_execution_id
    assert fresh["executions"][-1]["status"] == "DISPATCHING"
    assert fake.llm_calls == []


def test_scheduler_recovers_stale_db_dispatch_without_coreai_configuration(
    client, monkeypatch
):
    from app import scheduler

    merchant = client.post(
        "/api/merchants",
        json={"name": "Offline stale recovery", "primary_location": "New York, NY"},
    ).json()
    task = _operator_task(client, merchant["id"])
    execution_id = _insert_llm_dispatch(
        task,
        (datetime.now(timezone.utc) - timedelta(minutes=16)).isoformat(),
    )
    monkeypatch.setattr(scheduler, "coreai_settings", lambda: None)

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)

    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.scheduler_loop())

    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["status"] == "NEEDS_ATTENTION"
    assert detail["executions"][-1]["id"] == execution_id
    assert detail["executions"][-1]["status"] == "UNKNOWN"

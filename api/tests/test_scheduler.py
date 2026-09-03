import hashlib
import json
from datetime import datetime, timedelta, timezone

from helpers import FakeCoreAi, cleanup_override, override_coreai

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
    m = client.post("/api/merchants", json={"name": name}).json()
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
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": REPORT_WITH_PLAN}

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
    due = client.post("/api/merchants", json={"name": "due"}).json()
    client.patch(f"/api/merchants/{due['id']}", json={"auto_run_interval_days": 7})
    fresh = client.post("/api/merchants", json={"name": "fresh"}).json()
    client.patch(f"/api/merchants/{fresh['id']}", json={"auto_run_interval_days": 7})
    off = client.post("/api/merchants", json={"name": "off"}).json()
    archived = client.post("/api/merchants", json={"name": "arch"}).json()
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
    m = client.post("/api/merchants", json={"name": "never"}).json()
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
    bad = client.post("/api/merchants", json={"name": "bad"}).json()
    client.patch(f"/api/merchants/{bad['id']}", json={"auto_run_interval_days": 7})
    good = client.post("/api/merchants", json={"name": "good"}).json()
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
    merchant = client.post("/api/merchants", json={"name": "Task poll"}).json()
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


def test_poll_never_approves_historical_agent_completed_output(client):
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    merchant = client.post(
        "/api/merchants", json={"name": "Legacy completed task"}
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
        merchant = client.post("/api/merchants", json={"name": "Unsafe output"}).json()
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

    merchant = client.post("/api/merchants", json={"name": "Stale dispatch"}).json()
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

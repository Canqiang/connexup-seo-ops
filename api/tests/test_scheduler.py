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


def test_poll_preparation_failure_moves_task_to_attention_and_appends_event(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = client.post("/api/merchants", json={"name": "Task poll"}).json()
        task = _operator_task(client, merchant["id"])
        execution = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"]},
        ).json()
        fake.runs[execution["coreai_run_id"]] = {
            "status": "FAILED",
            "error": "generation failed",
            "completed_at": "2026-09-03T12:00:00+00:00",
        }

        poll_task_executions_once(fake)

        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["executions"][-1]["status"] == "FAILED"
        assert detail["executions"][-1]["error"] == "generation failed"
        assert detail["events"][-1]["event_type"] == "TASK_PREPARATION_FAILED"
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_poll_rejects_unstructured_agent_result_and_never_marks_it_approvable(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = client.post("/api/merchants", json={"name": "Unsafe output"}).json()
        task = _operator_task(client, merchant["id"])
        execution = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"]},
        ).json()
        fake.runs[execution["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": "not structured JSON",
        }

        poll_task_executions_once(fake)

        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["executions"][-1]["status"] == "FAILED"
        assert "structured JSON" in detail["executions"][-1]["error"]
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)

import json

import pytest

from helpers import FakeCoreAi, cleanup_override, override_coreai


STRICT_PLAN = {
    "schema_version": "seo_ops.task_plan.v1",
    "tasks": [
        {
            "key": "draft-schema",
            "task_type": "PREPARE_ONLY",
            "title": "Draft Restaurant structured data",
            "rationale": "The public website has no Restaurant JSON-LD.",
            "expected_outcome": "A reviewable structured-data draft.",
            "depends_on": [],
            "scheduled_start": None,
            "parameters": {"description": "Prepare JSON-LD only.", "category": "technical"},
        }
    ],
}


def strict_plan_report(plan=STRICT_PLAN) -> str:
    return "Diagnosis remains readable.\n```json\n" + json.dumps(plan) + "\n```\n"


def start_run(client, fake: FakeCoreAi):
    merchant = client.post("/api/merchants", json={"name": "Plan merchant"}).json()
    override_coreai(fake)
    try:
        run = client.post(f"/api/merchants/{merchant['id']}/runs").json()
    finally:
        cleanup_override()
    return merchant, run


def test_completed_run_persists_draft_plan_without_tasks(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    merchant, run = start_run(client, fake)
    report = strict_plan_report()
    fake.runs[run["coreai_run_id"]] = {"status": "COMPLETED", "output": report}

    poll_runs_once(fake)

    response = client.get(f"/api/runs/{run['id']}/task-plan")
    assert response.status_code == 200
    body = response.json()
    assert body["merchant_id"] == merchant["id"]
    assert body["source_kind"] == "AGENT"
    assert body["source_run_id"] == run["id"]
    assert body["state"] == "OPEN"
    assert body["latest_revision"] == 1
    assert body["approved_revision"] is None
    assert body["current_revision"]["decision_state"] == "DRAFT"
    assert body["current_revision"]["source"] == "AGENT"
    assert body["current_revision"]["created_by"] == run["coreai_run_id"]
    assert body["current_revision"]["payload"] == STRICT_PLAN
    assert "payload_json" not in body["current_revision"]
    assert client.get(f"/api/runs/{run['id']}/tasks").json() == []
    assert client.get(f"/api/merchants/{merchant['id']}/tasks").json() == []
    assert client.get(f"/api/runs/{run['id']}").json()["report_text"] == report


def test_agent_plan_persistence_is_idempotent_for_the_same_run_and_checksum(client):
    from app.db import connect
    from app.task_plan_contract import validate_task_plan
    from app.task_plans import persist_agent_plan
    from app.task_workflows import enabled_task_types

    fake = FakeCoreAi()
    merchant, run = start_run(client, fake)
    validated = validate_task_plan(STRICT_PLAN, enabled_task_types())
    conn = connect()
    try:
        first = persist_agent_plan(
            conn,
            merchant_id=merchant["id"],
            run_id=run["id"],
            coreai_run_id=run["coreai_run_id"],
            validated=validated,
        )
        second = persist_agent_plan(
            conn,
            merchant_id=merchant["id"],
            run_id=run["id"],
            coreai_run_id=run["coreai_run_id"],
            validated=validated,
        )

        assert second["id"] == first["id"]
        assert second["plan_id"] == first["plan_id"]
        assert second["revision"] == 1
        assert conn.execute("SELECT COUNT(*) FROM task_plans").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        conn.rollback()
        assert conn.execute("SELECT COUNT(*) FROM task_plans").fetchone()[0] == 0
    finally:
        conn.close()


def test_completed_run_cannot_replace_its_original_agent_plan(client):
    from app.db import connect
    from app.task_plan_contract import validate_task_plan
    from app.task_plans import persist_agent_plan
    from app.task_workflows import enabled_task_types

    fake = FakeCoreAi()
    merchant, run = start_run(client, fake)
    original = validate_task_plan(STRICT_PLAN, enabled_task_types())
    changed = validate_task_plan(
        {
            **STRICT_PLAN,
            "tasks": [{**STRICT_PLAN["tasks"][0], "title": "A different draft"}],
        },
        enabled_task_types(),
    )
    conn = connect()
    try:
        persist_agent_plan(
            conn,
            merchant_id=merchant["id"],
            run_id=run["id"],
            coreai_run_id=run["coreai_run_id"],
            validated=original,
        )
        with pytest.raises(
            ValueError, match="a completed Run cannot replace its original Agent Plan"
        ):
            persist_agent_plan(
                conn,
                merchant_id=merchant["id"],
                run_id=run["id"],
                coreai_run_id=run["coreai_run_id"],
                validated=changed,
            )
        assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 1
    finally:
        conn.rollback()
        conn.close()


def test_plan_get_routes_return_the_same_current_revision_view(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    _merchant, run = start_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": strict_plan_report(),
    }
    poll_runs_once(fake)

    by_run = client.get(f"/api/runs/{run['id']}/task-plan")
    assert by_run.status_code == 200
    by_id = client.get(f"/api/task-plans/{by_run.json()['id']}")

    assert by_id.status_code == 200
    assert by_id.json() == by_run.json()
    assert by_id.json()["current_revision"]["revision"] == 1
    assert by_id.json()["approved_revision"] is None
    assert client.get("/api/task-plans/999999").status_code == 404


def test_invalid_strict_output_keeps_raw_report_and_creates_no_plan_or_task(client):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    merchant, run = start_run(client, fake)
    invalid_report = strict_plan_report(
        {"schema_version": "seo_ops.task_plan.v1", "tasks": [{"key": "incomplete"}]}
    )
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": invalid_report,
    }

    poll_runs_once(fake)

    detail = client.get(f"/api/runs/{run['id']}").json()
    assert detail["status"] == "succeeded"
    assert detail["report_text"] == invalid_report
    assert client.get(f"/api/runs/{run['id']}/task-plan").status_code == 404
    assert client.get(f"/api/runs/{run['id']}/tasks").json() == []
    assert client.get(f"/api/merchants/{merchant['id']}/tasks").json() == []

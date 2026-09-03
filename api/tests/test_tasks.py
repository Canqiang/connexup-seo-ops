import hashlib
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest


def make_merchant(client, name="M"):
    return client.post("/api/merchants", json={"name": name}).json()


def task_body(**overrides):
    body = {
        "task_type": "PREPARE_ONLY",
        "title": "Prepare a review response",
        "rationale": "A response is needed",
        "expected_outcome": "A reviewable response",
        "parameters": {"description": "Draft only; do not publish", "category": "review"},
        "scheduled_start": None,
        "replaces_task_id": None,
        "replaces_task_version": None,
    }
    body.update(overrides)
    return body


def make_task(client, merchant_id, **overrides):
    response = client.post(
        f"/api/merchants/{merchant_id}/tasks", json=task_body(**overrides)
    )
    assert response.status_code == 201, response.text
    return response.json()


def plan_item(key, *, title=None, depends_on=None):
    return {
        "key": key,
        "task_type": "PREPARE_ONLY",
        "title": title or f"Prepare {key}",
        "rationale": f"The {key} work is required",
        "expected_outcome": f"A reviewable {key} result",
        "depends_on": depends_on or [],
        "scheduled_start": None,
        "parameters": {"description": f"Prepare {key} only", "category": "content"},
    }


def make_graph(client):
    from app.db import connect
    from app.task_plan_contract import validate_task_plan
    from app.task_plans import persist_agent_plan
    from app.task_workflows import enabled_task_types

    merchant = make_merchant(client, "Graph merchant")
    plan = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            plan_item("draft", title="Draft content"),
            plan_item("review", title="Review content", depends_on=["draft"]),
        ],
    }
    validated = validate_task_plan(plan, enabled_task_types())
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at) "
            "VALUES (?, 'graph-run', 'succeeded', 'manual', ?, ?)",
            (merchant["id"], "2026-09-03T00:00:00+00:00", "2026-09-03T00:01:00+00:00"),
        )
        run_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        revision = persist_agent_plan(
            conn,
            merchant_id=merchant["id"],
            run_id=run_id,
            coreai_run_id="graph-run",
            validated=validated,
        )
        plan_id = int(revision["plan_id"])
        conn.commit()
    finally:
        conn.close()
    approved = client.post(
        f"/api/task-plans/{plan_id}/approve",
        json={"revision": 1, "checksum": validated.checksum},
    )
    assert approved.status_code == 200, approved.text
    tasks = {task["task_key"]: task for task in approved.json()["tasks"]}
    return merchant, approved.json(), tasks


def verified_agent_result(summary="Prepared a reviewable artifact"):
    return json.dumps(
        {
            "outcome": "ready",
            "summary": summary,
            "artifact_refs": ["artifact://result-v1"],
            "evidence": ["Generated from verified merchant context"],
            "external_write_performed": False,
        }
    )


def override_preparation_agent(fake):
    from app.main import app
    from app.tasks import get_execution_coreai

    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")


def clear_preparation_agent():
    from app.main import app
    from app.tasks import get_execution_coreai

    app.dependency_overrides.pop(get_execution_coreai, None)


def execution_binding(task_detail):
    execution = task_detail["executions"][-1]
    return {
        "expected_version": task_detail["version"],
        "expected_execution_id": execution["id"],
        "expected_result_checksum": execution["result_checksum"],
    }


def execute_current(client, task_id):
    current = client.get(f"/api/tasks/{task_id}").json()
    return client.post(
        f"/api/tasks/{task_id}/execute",
        json={"expected_version": current["version"]},
    )


def approve_current(client, task_id):
    current = client.get(f"/api/tasks/{task_id}").json()
    return client.post(
        f"/api/tasks/{task_id}/approve-execution",
        json=execution_binding(current),
    )


def return_current(client, task_id, reason):
    current = client.get(f"/api/tasks/{task_id}").json()
    return client.post(
        f"/api/tasks/{task_id}/return-execution",
        json={**execution_binding(current), "reason": reason},
    )


def insert_execution(task_id, *, stage="PREPARATION", status="FAILED", **values):
    from app.db import connect

    request_json = json.dumps({"task_id": task_id}, separators=(",", ":"), sort_keys=True)
    checksum = hashlib.sha256(request_json.encode()).hexdigest()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO task_executions "
            "(task_id, stage, status, attempt, request_json, request_checksum, idempotency_key, "
            "provider_resource_id, result_json, evidence_json, created_at, finished_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                task_id,
                stage,
                status,
                values.get("attempt", 1),
                request_json,
                checksum,
                f"test:{task_id}:{stage}:{values.get('attempt', 1)}",
                values.get("provider_resource_id"),
                values.get("result_json"),
                values.get("evidence_json", "[]"),
                "2026-09-03T00:00:00+00:00",
                "2026-09-03T00:01:00+00:00",
            ),
        )
        conn.execute("UPDATE tasks SET status = 'NEEDS_ATTENTION' WHERE id = ?", (task_id,))
        conn.commit()
    finally:
        conn.close()


def test_operator_create_wraps_task_in_approved_implicit_plan(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])

    assert task["status"] == "PENDING"
    assert task["readiness"] == "READY"
    assert task["blocker"] is None
    assert task["plan"]["source_kind"] == "OPERATOR"
    assert task["plan"]["approved_revision"] == 1
    assert task["parameters"]["description"].startswith("Draft only")
    assert task["labels"] == []

    from app.db import connect

    conn = connect()
    try:
        revision = conn.execute(
            "SELECT * FROM task_plan_revisions WHERE plan_id = ?", (task["plan_id"],)
        ).fetchone()
        assert revision["decision_state"] == "APPROVED"
        event = conn.execute(
            "SELECT payload_json FROM task_events WHERE entity_type = 'PLAN' "
            "AND entity_id = ? AND event_type = 'PLAN_APPROVED'",
            (task["plan_id"],),
        ).fetchone()
        assert revision["checksum"] == json.loads(event[0])["checksum"]
    finally:
        conn.close()


def test_operator_create_is_strict_and_rejects_disabled_or_unknown_input(client):
    merchant = make_merchant(client)
    assert client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json=task_body(task_type="GBP_POST"),
    ).status_code == 422
    assert client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json={**task_body(), "status": "DONE"},
    ).status_code == 422
    assert client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json=task_body(parameters={"description": "ok", "credential": "secret"}),
    ).status_code == 422


def test_task_queries_filter_and_expose_one_list_blocker_and_full_detail_chain(client):
    merchant, plan, tasks = make_graph(client)
    review = tasks["review"]
    draft = tasks["draft"]

    params = {
        "merchant_id": merchant["id"],
        "plan_id": plan["id"],
        "plan_revision": review["plan_revision"],
        "task_type": "PREPARE_ONLY",
        "status": "PENDING",
        "readiness": "BLOCKED",
        "blocker_code": "UPSTREAM_NOT_DONE",
        "source_kind": "AGENT",
        "scheduled_after": "2026-09-02T00:00:00+00:00",
        "scheduled_before": "2026-09-04T00:00:00+00:00",
    }
    assert client.get("/api/tasks", params=params).json() == []
    params.pop("scheduled_after")
    params.pop("scheduled_before")
    listed = client.get("/api/tasks", params=params).json()
    assert [item["id"] for item in listed] == [review["id"]]
    assert listed[0]["blocker"] == {
        "code": "UPSTREAM_NOT_DONE",
        "task_id": draft["id"],
        "task_key": "draft",
        "task_title": "Draft content",
    }
    assert "upstream" not in listed[0]
    assert client.get(
        "/api/tasks", params={**params, "plan_revision": review["plan_revision"] + 1}
    ).json() == []
    assert client.get(
        "/api/tasks", params={**params, "blocker_code": "SCHEDULED_FOR_FUTURE"}
    ).json() == []

    detail = client.get(f"/api/tasks/{review['id']}").json()
    assert [(item["id"], item["task_key"]) for item in detail["upstream"]] == [
        (draft["id"], "draft")
    ]
    assert detail["downstream"] == []
    assert detail["executions"] == []
    assert any(event["event_type"] == "TASK_MATERIALIZED" for event in detail["events"])
    upstream_detail = client.get(f"/api/tasks/{draft['id']}").json()
    assert [item["id"] for item in upstream_detail["downstream"]] == [review["id"]]


def test_task_query_schedule_filters_are_timezone_aware(client):
    merchant = make_merchant(client)
    scheduled = (datetime.now(timezone.utc) + timedelta(days=1)).replace(microsecond=0).isoformat()
    task = make_task(client, merchant["id"], scheduled_start=scheduled)
    assert client.get(
        "/api/tasks",
        params={"scheduled_after": "2026-01-01T00:00:00Z", "scheduled_before": "2027-01-01T00:00:00Z"},
    ).json()[0]["id"] == task["id"]
    assert client.get("/api/tasks", params={"scheduled_before": "2026-01-01T00:00:00Z"}).json() == []
    assert client.get("/api/tasks", params={"scheduled_before": "not-a-date"}).status_code == 422


@pytest.mark.parametrize(
    "params",
    [
        {"task_type": "GBP_POST"},
        {"status": "doing"},
        {"readiness": "WAITING"},
        {"blocker_code": "UNKNOWN_BLOCKER"},
        {"source_kind": "USER"},
        {"plan_revision": "current"},
        {"plan_revision": 0},
    ],
)
def test_task_query_rejects_unknown_filter_values(client, params):
    assert client.get("/api/tasks", params=params).status_code == 422


def test_metadata_patch_is_versioned_audited_and_rejects_stale_or_definition_writes(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    response = client.patch(
        f"/api/tasks/{task['id']}",
        json={
            "expected_version": task["version"],
            "assignee": "operator-a",
            "labels": ["urgent", "review"],
            "operator_note": "Check brand tone",
        },
    )
    assert response.status_code == 200
    updated = response.json()
    assert updated["version"] == task["version"] + 1
    assert updated["assignee"] == "operator-a"
    assert updated["labels"] == ["urgent", "review"]
    stale = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": task["version"], "operator_note": "lost update"},
    )
    assert stale.status_code == 409

    definition = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": updated["version"], "title": "Rewrite definition"},
    )
    assert definition.status_code == 422
    assert definition.json()["detail"]["plan_id"] == task["plan_id"]
    assert client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": updated["version"], "status": "BLOCKED"},
    ).status_code == 422
    assert client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": updated["version"], "status": "DONE"},
    ).status_code == 422
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["events"][-1]["event_type"] == "TASK_METADATA_UPDATED"


def test_metadata_patch_rolls_back_if_its_audit_event_cannot_be_appended(client, monkeypatch):
    from app import tasks as tasks_module

    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])

    def fail_event(*_args, **_kwargs):
        raise RuntimeError("event store failed")

    monkeypatch.setattr(tasks_module, "append_task_event", fail_event)
    with pytest.raises(RuntimeError, match="event store failed"):
        client.patch(
            f"/api/tasks/{task['id']}",
            json={"expected_version": task["version"], "operator_note": "must roll back"},
        )
    reread = client.get(f"/api/tasks/{task['id']}").json()
    assert reread["version"] == task["version"]
    assert reread["operator_note"] is None


def test_metadata_patch_normalizes_null_labels_to_an_empty_list(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    labelled = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": task["version"], "labels": ["review"]},
    ).json()

    response = client.patch(
        f"/api/tasks/{task['id']}",
        json={"expected_version": labelled["version"], "labels": None},
    )

    assert response.status_code == 200
    assert response.json()["labels"] == []


def test_cancel_uses_compare_and_set_keeps_downstream_blocked_and_tasks_cannot_be_deleted(client):
    _merchant, _plan, tasks = make_graph(client)
    draft = tasks["draft"]
    review = tasks["review"]
    cancelled = client.post(
        f"/api/tasks/{draft['id']}/cancel",
        json={"expected_version": draft["version"], "reason": "No longer needed"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "CANCELLED"
    assert cancelled.json()["version"] == draft["version"] + 1
    assert client.post(
        f"/api/tasks/{draft['id']}/cancel",
        json={"expected_version": draft["version"], "reason": "stale"},
    ).status_code == 409
    downstream = client.get(f"/api/tasks/{review['id']}").json()
    assert downstream["status"] == "PENDING"
    assert downstream["readiness"] == "BLOCKED"
    assert downstream["blocker"]["task_id"] == draft["id"]
    assert client.delete(f"/api/tasks/{draft['id']}").status_code == 405

    from app.db import connect

    conn = connect()
    try:
        with pytest.raises(sqlite3.IntegrityError, match="formal tasks cannot be deleted"):
            conn.execute("DELETE FROM tasks WHERE id = ?", (draft["id"],))
    finally:
        conn.rollback()
        conn.close()


def test_attention_required_upstream_does_not_auto_cancel_its_downstream(client):
    from app.db import connect

    _merchant, _plan, tasks = make_graph(client)
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'NEEDS_ATTENTION', version = version + 1 WHERE id = ?",
            (tasks["draft"]["id"],),
        )
        conn.commit()
    finally:
        conn.close()
    downstream = client.get(f"/api/tasks/{tasks['review']['id']}").json()
    assert downstream["status"] == "PENDING"
    assert downstream["readiness"] == "BLOCKED"
    assert downstream["blocker"]["task_id"] == tasks["draft"]["id"]


def test_active_and_done_tasks_cannot_be_cancelled(client):
    from helpers import FakeCoreAi
    from app.scheduler import poll_task_executions_once

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = execute_current(client, task["id"])
        preparing = client.get(f"/api/tasks/{task['id']}").json()
        assert client.post(
            f"/api/tasks/{task['id']}/cancel",
            json={"expected_version": preparing["version"], "reason": "stop"},
        ).status_code == 409

        fake.runs[started.json()["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)
        awaiting = client.get(f"/api/tasks/{task['id']}").json()
        approve_current(client, task["id"])
        done = client.get(f"/api/tasks/{task['id']}").json()
        assert done["status"] == "DONE"
        assert client.post(
            f"/api/tasks/{task['id']}/cancel",
            json={"expected_version": done["version"], "reason": "too late"},
        ).status_code == 409
        assert awaiting["status"] == "AWAITING_APPROVAL"
    finally:
        clear_preparation_agent()


def test_replacement_requires_safe_same_merchant_source_and_links_both_directions(client):
    merchant = make_merchant(client)
    original = make_task(client, merchant["id"], title="Original")
    cancelled = client.post(
        f"/api/tasks/{original['id']}/cancel",
        json={"expected_version": original["version"], "reason": "Replace definition"},
    ).json()
    replacement = make_task(
        client,
        merchant["id"],
        title="Replacement",
        replaces_task_id=original["id"],
        replaces_task_version=cancelled["version"],
    )
    assert replacement["replaces_task_id"] == original["id"]
    reread = client.get(f"/api/tasks/{original['id']}").json()
    assert reread["status"] == "CANCELLED"
    assert reread["replaced_by_task_id"] == replacement["id"]
    assert reread["title"] == "Original"
    assert reread["version"] == cancelled["version"] + 1

    other = make_merchant(client, "Other")
    cross = client.post(
        f"/api/merchants/{other['id']}/tasks",
        json=task_body(
            replaces_task_id=original["id"],
            replaces_task_version=reread["version"],
        ),
    )
    assert cross.status_code == 409
    unsafe = make_task(client, merchant["id"], title="Unsafe")
    assert client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json=task_body(
            replaces_task_id=unsafe["id"],
            replaces_task_version=unsafe["version"],
        ),
    ).status_code == 409

    attention_source = make_task(client, merchant["id"], title="Failed preparation")
    insert_execution(attention_source["id"])
    safe_replacement = make_task(
        client,
        merchant["id"],
        title="Retry as replacement",
        replaces_task_id=attention_source["id"],
        replaces_task_version=attention_source["version"],
    )
    assert safe_replacement["replaces_task_id"] == attention_source["id"]
    stopped_source = client.get(f"/api/tasks/{attention_source['id']}").json()
    assert stopped_source["status"] == "CANCELLED"
    assert stopped_source["version"] == attention_source["version"] + 1
    assert stopped_source["replaced_by_task_id"] == safe_replacement["id"]
    assert client.get(f"/api/task-plans/{attention_source['plan_id']}").json()["state"] == "CLOSED"
    assert [
        event["event_type"]
        for event in stopped_source["events"]
        if event["event_type"] == "TASK_REPLACED"
    ] == ["TASK_REPLACED"]
    assert client.post(
        f"/api/tasks/{attention_source['id']}/retry-preparation",
        json={
            "expected_version": stopped_source["version"],
            "reason": "must remain terminal",
        },
    ).status_code == 409

    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        assert client.post(
            f"/api/tasks/{attention_source['id']}/execute",
            json={"expected_version": stopped_source["version"]},
        ).status_code == 409
        assert fake.triggered == []
    finally:
        clear_preparation_agent()


@pytest.mark.parametrize(
    "replacement_fields",
    [
        {"replaces_task_id": 1},
        {"replaces_task_version": 1},
    ],
)
def test_replacement_requires_id_and_version_together(client, replacement_fields):
    merchant = make_merchant(client)

    response = client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json=task_body(**replacement_fields),
    )

    assert response.status_code == 422


def test_replacement_rejects_stale_source_version_without_creating_a_plan(client):
    merchant = make_merchant(client)
    original = make_task(client, merchant["id"], title="Original")
    cancelled = client.post(
        f"/api/tasks/{original['id']}/cancel",
        json={"expected_version": original["version"], "reason": "replace"},
    ).json()

    response = client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json=task_body(
            replaces_task_id=original["id"],
            replaces_task_version=cancelled["version"] - 1,
        ),
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "replacement source changed; refresh and retry"
    assert client.get(f"/api/merchants/{merchant['id']}/tasks").json() == [cancelled]


def test_historical_replaced_attention_task_cannot_retry_or_execute(client):
    from app.db import connect
    from helpers import FakeCoreAi

    merchant = make_merchant(client)
    source = make_task(client, merchant["id"], title="Historical source")
    replacement = make_task(client, merchant["id"], title="Historical replacement")
    insert_execution(source["id"])
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET replaced_by_task_id = ? WHERE id = ?",
            (replacement["id"], source["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    before = client.get(f"/api/tasks/{source['id']}").json()
    assert before["status"] == "NEEDS_ATTENTION"
    assert before["replaced_by_task_id"] == replacement["id"]
    state = (before["status"], before["version"], len(before["events"]))

    retry = client.post(
        f"/api/tasks/{source['id']}/retry-preparation",
        json={"expected_version": before["version"], "reason": "historical retry"},
    )
    assert retry.status_code == 409
    assert retry.json()["detail"] == "replaced task cannot be reactivated"

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        execute = client.post(
            f"/api/tasks/{source['id']}/execute",
            json={"expected_version": before["version"]},
        )
        assert execute.status_code == 409
        assert execute.json()["detail"] == "replaced task cannot be reactivated"
        assert fake.triggered == []
    finally:
        clear_preparation_agent()

    reread = client.get(f"/api/tasks/{source['id']}").json()
    assert (reread["status"], reread["version"], len(reread["events"])) == state


def test_pathological_pending_replaced_task_execute_never_contacts_core_ai(client):
    from app.db import connect
    from helpers import FakeCoreAi

    class CountingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.agent_reads = 0

        def get_agent(self, agent_id):
            self.agent_reads += 1
            return super().get_agent(agent_id)

    merchant = make_merchant(client)
    source = make_task(client, merchant["id"], title="Pathological source")
    replacement = make_task(client, merchant["id"], title="Pathological replacement")
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET replaced_by_task_id = ? WHERE id = ?",
            (replacement["id"], source["id"]),
        )
        conn.commit()
    finally:
        conn.close()

    before = client.get(f"/api/tasks/{source['id']}").json()
    assert before["status"] == "PENDING"
    state = (
        before["status"],
        before["version"],
        len(before["events"]),
        len(before["executions"]),
    )
    fake = CountingCoreAi()
    override_preparation_agent(fake)
    try:
        response = client.post(
            f"/api/tasks/{source['id']}/execute",
            json={"expected_version": before["version"]},
        )
        assert response.status_code == 409
        assert response.json()["detail"] == "replaced task cannot be reactivated"
        assert fake.agent_reads == 0
        assert fake.triggered == []
    finally:
        clear_preparation_agent()

    reread = client.get(f"/api/tasks/{source['id']}").json()
    assert (
        reread["status"],
        reread["version"],
        len(reread["events"]),
        len(reread["executions"]),
    ) == state


def test_blocked_task_never_contacts_core_ai(client):
    from helpers import FakeCoreAi

    class CountingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.agent_reads = 0

        def get_agent(self, agent_id):
            self.agent_reads += 1
            return super().get_agent(agent_id)

    fake = CountingCoreAi()
    override_preparation_agent(fake)
    try:
        _merchant, _plan, tasks = make_graph(client)
        response = execute_current(client, tasks["review"]["id"])
        assert response.status_code == 409
        assert response.json()["detail"] == "task is blocked by an upstream task"
        assert fake.agent_reads == 0
        assert fake.triggered == []
    finally:
        clear_preparation_agent()


def test_future_scheduled_task_never_contacts_core_ai(client):
    from helpers import FakeCoreAi

    class CountingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.agent_reads = 0

        def get_agent(self, agent_id):
            self.agent_reads += 1
            return super().get_agent(agent_id)

    fake = CountingCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        scheduled = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
        task = make_task(client, merchant["id"], scheduled_start=scheduled)
        response = execute_current(client, task["id"])
        assert response.status_code == 409
        assert response.json()["detail"] == "task is scheduled for the future"
        assert fake.agent_reads == 0
        assert fake.triggered == []
    finally:
        clear_preparation_agent()


def test_execute_rejects_capability_enabled_preparation_agent_without_triggering_it(client):
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    fake.agent_definition["tools"] = [{"id": "builtin:builtin-all", "type": "BUILTIN"}]
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        response = execute_current(client, task["id"])
        assert response.status_code == 503
        assert response.json()["detail"] == "task preparation agent is not read-only"
        assert fake.triggered == []
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["executions"][-1]["status"] == "FAILED"
    finally:
        clear_preparation_agent()


@pytest.mark.parametrize(
    ("field", "unsafe_value"),
    [
        ("tools", "missing"),
        ("tools", None),
        ("tools", [{"id": "builtin:builtin-all"}]),
        ("skill_ids", "missing"),
        ("skill_ids", None),
        ("skill_ids", ["skill-1"]),
        ("subagent_ids", "missing"),
        ("subagent_ids", None),
        ("subagent_ids", ["agent-2"]),
        ("sandbox_config", "missing"),
        ("sandbox_config", []),
        ("sandbox_config", {"mode": "read-only"}),
        ("dataset_config", "missing"),
        ("dataset_config", []),
        ("dataset_config", {"dataset_ids": []}),
    ],
)
def test_execute_requires_complete_exact_empty_capability_metadata(
    client, field, unsafe_value
):
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    if unsafe_value == "missing":
        fake.agent_definition.pop(field)
    else:
        fake.agent_definition[field] = unsafe_value
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])

        response = execute_current(client, task["id"])

        assert response.status_code == 503
        assert fake.triggered == []
    finally:
        clear_preparation_agent()


def test_concurrent_execute_requests_create_one_active_preparation(client):
    from helpers import FakeCoreAi

    class BlockingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.started = threading.Event()
            self.release = threading.Event()

        def trigger(self, agent_id, input_text):
            self.started.set()
            assert self.release.wait(timeout=3)
            return super().trigger(agent_id, input_text)

    fake = BlockingCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"], title="Concurrent dispatch")
        execute_body = {"expected_version": task["version"]}
        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(
                client.post,
                f"/api/tasks/{task['id']}/execute",
                json=execute_body,
            )
            assert fake.started.wait(timeout=3)
            second = client.post(
                f"/api/tasks/{task['id']}/execute",
                json=execute_body,
            )
            fake.release.set()
            first = first_future.result(timeout=3)
        assert first.status_code == 201
        assert second.status_code == 409
        assert len(fake.triggered) == 1
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "PREPARING"
        assert len(detail["executions"]) == 1
        assert detail["executions"][0]["stage"] == "PREPARATION"
        assert detail["executions"][0]["status"] == "RUNNING"
    finally:
        fake.release.set()
        clear_preparation_agent()


def test_execute_rejects_stale_task_version_before_contacting_core_ai(client):
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])

        response = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"] + 1},
        )

        assert response.status_code == 409
        assert response.json()["detail"] == "task changed; refresh and retry"
        assert fake.triggered == []
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "PENDING"
        assert detail["executions"] == []
    finally:
        clear_preparation_agent()


def test_poll_success_approval_completes_prepare_only_and_unlocks_downstream(client):
    from app.scheduler import poll_task_executions_once
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        _merchant, plan, tasks = make_graph(client)
        draft = tasks["draft"]
        review = tasks["review"]
        started = execute_current(client, draft["id"]).json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result("Draft prepared"),
            "completed_at": "2026-09-03T08:30:00+00:00",
        }
        poll_task_executions_once(fake)
        awaiting = client.get(f"/api/tasks/{draft['id']}").json()
        assert awaiting["status"] == "AWAITING_APPROVAL"
        assert awaiting["executions"][-1]["status"] == "SUCCEEDED"
        approved = approve_current(client, draft["id"])
        assert approved.status_code == 200
        assert approved.json()["task"]["status"] == "DONE"
        assert approved.json()["execution"]["reviewed_at"] is not None
        assert client.get(f"/api/tasks/{review['id']}").json()["readiness"] == "READY"
        assert client.get(f"/api/task-plans/{plan['id']}").json()["state"] == "OPEN"
    finally:
        clear_preparation_agent()


def test_final_prepare_only_approval_closes_implicit_plan(client):
    from app.scheduler import poll_task_executions_once
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = execute_current(client, task["id"]).json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)
        assert approve_current(client, task["id"]).status_code == 200
        plan = client.get(f"/api/task-plans/{task['plan_id']}").json()
        assert plan["state"] == "CLOSED"
        assert plan["closed_at"] is not None
    finally:
        clear_preparation_agent()


def test_return_resets_to_pending_with_event_and_allows_a_new_attempt(client):
    from app.scheduler import poll_task_executions_once
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = execute_current(client, task["id"]).json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)
        returned = return_current(client, task["id"], "Use the approved menu copy")
        assert returned.status_code == 200
        assert returned.json()["task"]["status"] == "PENDING"
        assert returned.json()["execution"]["status"] == "SUCCEEDED"
        assert returned.json()["execution"]["review_note"].startswith("Use the approved")
        assert returned.json()["task"]["events"][-1]["event_type"] == "TASK_PREPARATION_RETURNED"
        retried = execute_current(client, task["id"])
        assert retried.status_code == 201
        assert retried.json()["attempt"] == 2
    finally:
        clear_preparation_agent()


def test_review_binding_rejects_attempt_one_after_attempt_two_is_current(client):
    from app.scheduler import poll_task_executions_once
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        attempt_one = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"]},
        ).json()
        fake.runs[attempt_one["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result("Attempt one"),
        }
        poll_task_executions_once(fake)
        first_review = client.get(f"/api/tasks/{task['id']}").json()
        first_binding = execution_binding(first_review)
        returned = client.post(
            f"/api/tasks/{task['id']}/return-execution",
            json={**first_binding, "reason": "revise"},
        )
        assert returned.status_code == 200

        pending = returned.json()["task"]
        attempt_two = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": pending["version"]},
        ).json()
        fake.runs[attempt_two["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result("Attempt two"),
        }
        poll_task_executions_once(fake)
        current = client.get(f"/api/tasks/{task['id']}").json()

        stale = client.post(
            f"/api/tasks/{task['id']}/approve-execution",
            json={
                **first_binding,
                "expected_version": current["version"],
            },
        )

        assert stale.status_code == 409
        assert stale.json()["detail"] == "task review target changed; refresh and retry"
        reread = client.get(f"/api/tasks/{task['id']}").json()
        assert reread["status"] == "AWAITING_APPROVAL"
        assert reread["executions"][-1]["id"] == attempt_two["id"]
        assert reread["executions"][-1]["reviewed_at"] is None
    finally:
        clear_preparation_agent()


@pytest.mark.parametrize("action", ["approve-execution", "return-execution"])
def test_review_actions_reject_incomplete_stored_preparation_result(client, action):
    from app.db import connect

    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    insert_execution(
        task["id"],
        status="SUCCEEDED",
        result_json='{"external_write_performed":false}',
    )
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'AWAITING_APPROVAL' WHERE id = ?", (task["id"],)
        )
        conn.commit()
    finally:
        conn.close()

    detail = client.get(f"/api/tasks/{task['id']}").json()
    body = execution_binding(detail)
    if action == "return-execution":
        body["reason"] = "revise"
    response = client.post(f"/api/tasks/{task['id']}/{action}", json=body)

    assert response.status_code == 409
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "AWAITING_APPROVAL"


@pytest.mark.parametrize("action", ["approve-execution", "return-execution"])
@pytest.mark.parametrize(
    ("column", "corrupt_value"),
    [
        ("request_json", '{ "task_id": 1 }'),
        ("request_checksum", "0" * 64),
        ("result_json", '{"external_write_performed":false}'),
        ("evidence_json", '["mismatched evidence"]'),
        ("provider_resource_id", "external-resource"),
        ("approval_id", 99),
        ("artifact_id", 88),
    ],
)
def test_review_actions_reject_corrupt_current_execution_without_mutation(
    client, action, column, corrupt_value
):
    from app.db import connect
    from app.scheduler import poll_task_executions_once
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = execute_current(client, task["id"]).json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)
        detail = client.get(f"/api/tasks/{task['id']}").json()
        binding = execution_binding(detail)

        conn = connect()
        try:
            conn.execute(
                f"UPDATE task_executions SET {column} = ? WHERE id = ?",
                (corrupt_value, binding["expected_execution_id"]),
            )
            conn.commit()
            before_task = tuple(
                conn.execute(
                    "SELECT status, version, completed_at FROM tasks WHERE id = ?",
                    (task["id"],),
                ).fetchone()
            )
            before_reviewed_at = conn.execute(
                "SELECT reviewed_at FROM task_executions WHERE id = ?",
                (binding["expected_execution_id"],),
            ).fetchone()[0]
            before_events = conn.execute(
                "SELECT COUNT(*) FROM task_events WHERE entity_type = 'TASK' AND entity_id = ?",
                (task["id"],),
            ).fetchone()[0]
        finally:
            conn.close()

        body = dict(binding)
        if action == "return-execution":
            body["reason"] = "revise"
        response = client.post(f"/api/tasks/{task['id']}/{action}", json=body)
        assert response.status_code == 409

        conn = connect()
        try:
            assert tuple(
                conn.execute(
                    "SELECT status, version, completed_at FROM tasks WHERE id = ?",
                    (task["id"],),
                ).fetchone()
            ) == before_task
            assert conn.execute(
                "SELECT reviewed_at FROM task_executions WHERE id = ?",
                (binding["expected_execution_id"],),
            ).fetchone()[0] == before_reviewed_at
            assert conn.execute(
                "SELECT COUNT(*) FROM task_events WHERE entity_type = 'TASK' AND entity_id = ?",
                (task["id"],),
            ).fetchone()[0] == before_events
        finally:
            conn.close()
    finally:
        clear_preparation_agent()


def test_retry_preparation_requires_failed_read_only_preparation_and_expected_version(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    insert_execution(task["id"])
    attention = client.get(f"/api/tasks/{task['id']}").json()
    retried = client.post(
        f"/api/tasks/{task['id']}/retry-preparation",
        json={"expected_version": attention["version"], "reason": "Transient failure"},
    )
    assert retried.status_code == 200
    assert retried.json()["status"] == "PENDING"
    assert retried.json()["version"] == attention["version"] + 1
    assert client.post(
        f"/api/tasks/{task['id']}/retry-preparation",
        json={"expected_version": attention["version"], "reason": "stale"},
    ).status_code == 409


def test_retry_preparation_rejects_when_any_older_attempt_is_still_active(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    insert_execution(task["id"], status="RUNNING", attempt=1)
    insert_execution(task["id"], status="FAILED", attempt=2)
    attention = client.get(f"/api/tasks/{task['id']}").json()

    response = client.post(
        f"/api/tasks/{task['id']}/retry-preparation",
        json={"expected_version": attention["version"], "reason": "retry"},
    )

    assert response.status_code == 409


@pytest.mark.parametrize(
    "attempt",
    [
        {"stage": "PUBLICATION", "status": "UNKNOWN"},
        {"stage": "VERIFICATION", "status": "FAILED"},
        {"stage": "PREPARATION", "status": "UNKNOWN"},
        {"stage": "PREPARATION", "status": "FAILED", "provider_resource_id": "provider-1"},
        {
            "stage": "PREPARATION",
            "status": "FAILED",
            "result_json": '{"external_write_performed":true}',
        },
    ],
)
def test_retry_preparation_rejects_publication_verification_or_write_uncertainty(client, attempt):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    insert_execution(task["id"], **attempt)
    attention = client.get(f"/api/tasks/{task['id']}").json()
    response = client.post(
        f"/api/tasks/{task['id']}/retry-preparation",
        json={"expected_version": attention["version"], "reason": "retry"},
    )
    assert response.status_code == 409


@pytest.mark.parametrize("status_code", [0, 408, 500, 503])
def test_ambiguous_core_ai_trigger_is_unknown_attention_and_never_redispatched(
    client, status_code
):
    from app.coreai import CoreAiError
    from app.db import connect
    from helpers import FakeCoreAi

    class AmbiguousCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.trigger_calls = 0

        def trigger(self, agent_id, input_text):
            self.trigger_calls += 1
            conn = connect()
            try:
                conn.execute(
                    "UPDATE task_executions SET evidence_json = ? WHERE status = 'DISPATCHING'",
                    ('["dispatch outcome unavailable"]',),
                )
                conn.commit()
            finally:
                conn.close()
            raise CoreAiError(status_code, "ambiguous trigger outcome")

    fake = AmbiguousCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        response = execute_current(client, task["id"])
        assert response.status_code == 201
        assert response.json()["status"] == "UNKNOWN"
        assert response.json()["evidence"] == ["dispatch outcome unavailable"]
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["events"][-1]["event_type"] == "TASK_PREPARATION_UNKNOWN"
        assert client.post(
            f"/api/tasks/{task['id']}/retry-preparation",
            json={"expected_version": detail["version"], "reason": "retry"},
        ).status_code == 409
        assert client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": detail["version"]},
        ).status_code == 409
        assert fake.trigger_calls == 1
    finally:
        clear_preparation_agent()


@pytest.mark.parametrize("status_code", [400, 404, 422])
def test_definite_core_ai_trigger_rejection_is_failed_and_retryable(client, status_code):
    from app.coreai import CoreAiError
    from helpers import FakeCoreAi

    class RejectedCoreAi(FakeCoreAi):
        def trigger(self, agent_id, input_text):
            raise CoreAiError(status_code, "request rejected")

    fake = RejectedCoreAi()
    override_preparation_agent(fake)
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        response = execute_current(client, task["id"])
        assert response.status_code == 201
        assert response.json()["status"] == "FAILED"
        detail = client.get(f"/api/tasks/{task['id']}").json()
        assert detail["events"][-1]["event_type"] == "TASK_PREPARATION_FAILED"
        retry = client.post(
            f"/api/tasks/{task['id']}/retry-preparation",
            json={"expected_version": detail["version"], "reason": "correct request"},
        )
        assert retry.status_code == 200
        assert retry.json()["status"] == "PENDING"
    finally:
        clear_preparation_agent()

import json
import threading
from concurrent.futures import ThreadPoolExecutor


def make_merchant(client):
    return client.post("/api/merchants", json={"name": "M"}).json()


def make_task(client, merchant_id, **extra):
    return client.post(f"/api/merchants/{merchant_id}/tasks", json={"title": "t", **extra}).json()


def verified_agent_result(summary: str = "Prepared a reviewable artifact") -> str:
    return json.dumps(
        {
            "outcome": "ready",
            "summary": summary,
            "artifact_refs": ["artifact://result-v1"],
            "evidence": ["Generated from the verified merchant context"],
            "external_write_performed": False,
        }
    )


def make_generated_task(client):
    import os
    import sqlite3

    merchant = make_merchant(client)
    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    conn.execute(
        "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at)"
        " VALUES (?, 'gate-run', 'succeeded', 'manual', '2026-09-01T00:00:00+00:00', '2026-09-01T00:01:00+00:00')",
        (merchant["id"],),
    )
    run_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute(
        "INSERT INTO tasks (merchant_id, title, source_run_id, source_key, created_at)"
        " VALUES (?, '计划任务', ?, 'plan-gate-task', '2026-09-01T00:01:00+00:00')",
        (merchant["id"], run_id),
    )
    task_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.commit()
    conn.close()
    return merchant, run_id, client.get(f"/api/tasks/{task_id}").json()


def test_create_and_list_tasks(client):
    m = make_merchant(client)
    res = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "Fix GBP", "rationale": "ranking dropped", "description": "check listing"},
    )
    assert res.status_code == 201
    t = res.json()
    assert t["merchant_id"] == m["id"]
    assert t["status"] == "todo"
    assert t["rationale"] == "ranking dropped"
    assert t["evidence_note"] is None
    assert t["completed_at"] is None
    assert [x["id"] for x in client.get(f"/api/merchants/{m['id']}/tasks").json()] == [t["id"]]


def test_create_task_rejects_empty_title(client):
    m = make_merchant(client)
    assert client.post(f"/api/merchants/{m['id']}/tasks", json={"title": ""}).status_code == 422


def test_task_endpoints_404_on_missing(client):
    assert client.post("/api/merchants/999/tasks", json={"title": "t"}).status_code == 404
    assert client.get("/api/merchants/999/tasks").status_code == 404
    assert client.get("/api/tasks/999").status_code == 404
    assert client.patch("/api/tasks/999", json={"status": "doing"}).status_code == 404


def test_task_can_start_but_direct_completion_requires_agent_approval(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"}).json()["status"] == "doing"
    response = client.patch(f"/api/tasks/{t['id']}", json={"status": "done"})
    assert response.status_code == 409
    task = client.get(f"/api/tasks/{t['id']}").json()
    assert task["status"] == "doing"
    assert task["completed_at"] is None


def test_todo_straight_to_done_is_422(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "done"}).status_code == 422


def test_cancel_from_todo_and_doing(client):
    m = make_merchant(client)
    t1 = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t1['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"
    t2 = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t2['id']}", json={"status": "doing"})
    assert client.patch(f"/api/tasks/{t2['id']}", json={"status": "cancelled"}).json()["status"] == "cancelled"


def test_terminal_states_reject_transitions(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t['id']}", json={"status": "cancelled"})
    for s in ("todo", "doing", "done"):
        assert client.patch(f"/api/tasks/{t['id']}", json={"status": s}).status_code == 422


def test_same_status_patch_is_noop(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"status": "todo"}).status_code == 200


def test_patch_text_fields(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    res = client.patch(
        f"/api/tasks/{t['id']}",
        json={"rationale": "because", "evidence_note": "did it", "title": "T2", "description": "d2"},
    )
    body = res.json()
    assert body["rationale"] == "because"
    assert body["evidence_note"] == "did it"
    assert body["title"] == "T2"
    assert body["description"] == "d2"
    assert body["status"] == "todo"


def test_patch_task_rejects_explicit_null_title(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    assert client.patch(f"/api/tasks/{t['id']}", json={"title": None}).status_code == 422


def test_task_expected_outcome_create_patch_and_default(client):
    m = make_merchant(client)
    t = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "t", "rationale": "r", "expected_outcome": "地图曝光提升"},
    ).json()
    assert t["expected_outcome"] == "地图曝光提升"
    t2 = make_task(client, m["id"])
    assert t2["expected_outcome"] is None
    res = client.patch(f"/api/tasks/{t2['id']}", json={"expected_outcome": "评分回升"})
    assert res.json()["expected_outcome"] == "评分回升"


def test_task_category_create_patch_and_invalid(client):
    m = make_merchant(client)
    t = client.post(
        f"/api/merchants/{m['id']}/tasks",
        json={"title": "t", "category": "gbp"},
    ).json()
    assert t["category"] == "gbp"
    t2 = make_task(client, m["id"])
    assert t2["category"] is None
    assert client.patch(f"/api/tasks/{t2['id']}", json={"category": "review"}).json()["category"] == "review"
    assert client.post(f"/api/merchants/{m['id']}/tasks", json={"title": "t", "category": "nope"}).status_code == 422


def test_list_all_tasks_with_merchant_name(client):
    a = client.post("/api/merchants", json={"name": "甲"}).json()
    b = client.post("/api/merchants", json={"name": "乙"}).json()
    make_task(client, a["id"])
    make_task(client, b["id"])
    tasks = client.get("/api/tasks").json()
    names = {t["merchant_name"] for t in tasks}
    assert {"甲", "乙"} <= names


def test_batch_status_transitions(client):
    m = make_merchant(client)
    t1 = make_task(client, m["id"])  # todo -> doing 合法
    t2 = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t2['id']}", json={"status": "cancelled"})  # 终态，批量应跳过
    res = client.post("/api/tasks/batch", json={"ids": [t1["id"], t2["id"], 999], "status": "doing"})
    assert res.status_code == 200
    body = res.json()
    assert body["updated"] == [t1["id"]]
    assert set(body["skipped"]) == {t2["id"], 999}
    assert client.get(f"/api/tasks/{t1['id']}").json()["status"] == "doing"


def test_batch_done_skips_tasks_without_approved_agent_results(client):
    m = make_merchant(client)
    t = make_task(client, m["id"])
    client.patch(f"/api/tasks/{t['id']}", json={"status": "doing"})
    res = client.post("/api/tasks/batch", json={"ids": [t["id"]], "status": "done"})
    assert res.json() == {"updated": [], "skipped": [t["id"]]}
    task = client.get(f"/api/tasks/{t['id']}").json()
    assert task["status"] == "doing"
    assert task["completed_at"] is None


def test_batch_rejects_bad_status(client):
    assert client.post("/api/tasks/batch", json={"ids": [1], "status": "todo"}).status_code == 422


def test_generated_task_cannot_start_before_plan_approval(client):
    _merchant, _run_id, task = make_generated_task(client)

    assert task["source_plan_approved"] is False

    response = client.patch(f"/api/tasks/{task['id']}", json={"status": "doing"})

    assert response.status_code == 409
    assert response.json()["detail"] == "source plan is not approved"


def test_generated_task_can_start_after_plan_approval(client):
    merchant, run_id, task = make_generated_task(client)
    assert client.post(f"/api/runs/{run_id}/approve-plan").status_code == 200

    listed = client.get(f"/api/merchants/{merchant['id']}/tasks").json()
    assert listed[0]["source_plan_approved"] is True

    response = client.patch(f"/api/tasks/{task['id']}", json={"status": "doing"})

    assert response.status_code == 200
    assert response.json()["status"] == "doing"


def test_batch_start_skips_generated_task_before_plan_approval(client):
    merchant, _run_id, generated = make_generated_task(client)
    manual = make_task(client, merchant["id"])

    response = client.post(
        "/api/tasks/batch",
        json={"ids": [generated["id"], manual["id"]], "status": "doing"},
    )

    assert response.status_code == 200
    assert response.json()["updated"] == [manual["id"]]
    assert response.json()["skipped"] == [generated["id"]]


def test_assigning_task_to_agent_creates_a_real_core_ai_execution(client):
    from app.main import app
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "Only Bear", "primary_location": "Mineola, NY"},
        ).json()
        task = make_task(
            client,
            merchant["id"],
            title="Update GBP hours",
            rationale="Hours are inconsistent",
            expected_outcome="Reduce customer confusion",
            category="gbp",
        )

        response = client.post(f"/api/tasks/{task['id']}/execute")

        assert response.status_code == 201
        execution = response.json()
        assert execution["status"] == "running"
        assert execution["attempt"] == 1
        assert execution["coreai_run_id"] == "core-1"
        assert fake.triggered[0][0] == "agent-execution"
        assert "Only Bear" in fake.triggered[0][1]
        assert "Update GBP hours" in fake.triggered[0][1]
        assert "Do not claim" in fake.triggered[0][1]
        assert "External writes and publication are NOT authorized" in fake.triggered[0][1]
        assert "Return only one JSON object" in fake.triggered[0][1]
        assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "doing"
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_execution_rejects_an_agent_with_any_runtime_capability(client):
    from app.main import app
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    fake.agent_definition["tools"] = [{"id": "builtin:builtin-all", "type": "BUILTIN"}]
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "unsafe-agent")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"], title="Must remain read-only")

        response = client.post(f"/api/tasks/{task['id']}/execute")

        assert response.status_code == 503
        assert response.json()["detail"] == "task preparation agent is not read-only"
        assert fake.triggered == []
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_concurrent_execute_requests_dispatch_only_one_agent_run(client):
    from app.main import app
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    class BlockingCoreAi(FakeCoreAi):
        def __init__(self):
            super().__init__()
            self.started = threading.Event()
            self.release = threading.Event()

        def trigger(self, agent_id: str, input_text: str) -> dict:
            self.started.set()
            assert self.release.wait(timeout=3)
            return super().trigger(agent_id, input_text)

    fake = BlockingCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"], title="Concurrent dispatch")

        with ThreadPoolExecutor(max_workers=2) as pool:
            first_future = pool.submit(client.post, f"/api/tasks/{task['id']}/execute")
            assert fake.started.wait(timeout=3)
            second = client.post(f"/api/tasks/{task['id']}/execute")
            fake.release.set()
            first = first_future.result(timeout=3)

        assert first.status_code == 201
        assert second.status_code == 409
        assert second.json()["detail"] == "task already has an active execution"
        assert len(fake.triggered) == 1
    finally:
        fake.release.set()
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_agent_result_requires_human_approval_and_can_be_returned(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"], title="Draft local landing page")
        started = client.post(f"/api/tasks/{task['id']}/execute").json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result("Created a local landing-page draft"),
            "completed_at": "2026-09-01T08:30:00+00:00",
        }

        poll_task_executions_once(fake)

        ready = client.get(f"/api/tasks/{task['id']}/execution").json()
        assert ready["status"] == "ready"
        assert json.loads(ready["output_text"])["summary"] == "Created a local landing-page draft"
        assert client.get(f"/api/tasks/{task['id']}").json()["status"] == "doing"
        assert client.get(f"/api/merchants/{merchant['id']}/tasks").json()[0]["execution_status"] == "ready"

        returned = client.post(
            f"/api/tasks/{task['id']}/return-execution",
            json={"reason": "Use the approved menu copy and add the Brooklyn location."},
        )
        assert returned.status_code == 200
        assert returned.json()["status"] == "returned"
        assert returned.json()["review_note"].startswith("Use the approved menu copy")

        retried = client.post(f"/api/tasks/{task['id']}/execute")
        assert retried.status_code == 201
        assert retried.json()["attempt"] == 2
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_approval_is_the_only_way_to_complete_an_agent_task(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = client.post(f"/api/tasks/{task['id']}/execute").json()

        assert client.patch(f"/api/tasks/{task['id']}", json={"status": "done"}).status_code == 409

        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)
        approved = client.post(f"/api/tasks/{task['id']}/approve-execution")

        assert approved.status_code == 200
        assert approved.json()["execution"]["status"] == "approved"
        assert approved.json()["task"]["status"] == "done"
        assert approved.json()["task"]["completed_at"] is not None
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_task_cannot_be_completed_without_an_approved_agent_result(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    assert client.patch(f"/api/tasks/{task['id']}", json={"status": "doing"}).status_code == 200

    response = client.patch(f"/api/tasks/{task['id']}", json={"status": "done"})
    batch = client.post("/api/tasks/batch", json={"ids": [task["id"]], "status": "done"})

    assert response.status_code == 409
    assert response.json()["detail"] == "task completion requires an approved agent result"
    assert batch.json() == {"updated": [], "skipped": [task["id"]]}


def test_active_agent_result_must_be_reviewed_before_task_can_be_cancelled(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"])
        started = client.post(f"/api/tasks/{task['id']}/execute").json()
        fake.runs[started["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": verified_agent_result(),
        }
        poll_task_executions_once(fake)

        cancel = client.patch(f"/api/tasks/{task['id']}", json={"status": "cancelled"})

        assert cancel.status_code == 409
        assert cancel.json()["detail"] == "active agent execution must be reviewed first"
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_cancel_and_execute_are_serialized_so_a_cancelled_task_never_dispatches(client, monkeypatch):
    from app import tasks as tasks_module
    from app.main import app
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    cancel_checked = threading.Event()
    release_cancel = threading.Event()
    execute_checked_agent = threading.Event()
    release_execute = threading.Event()
    agent_triggered = threading.Event()
    original_active_check = tasks_module.task_has_active_execution

    def pausing_active_check(conn, task_id):
        result = original_active_check(conn, task_id)
        if not result and not cancel_checked.is_set():
            cancel_checked.set()
            assert release_cancel.wait(timeout=3)
        return result

    class SignalingCoreAi(FakeCoreAi):
        def get_agent(self, agent_id: str) -> dict:
            execute_checked_agent.set()
            assert release_execute.wait(timeout=3)
            return super().get_agent(agent_id)

        def trigger(self, agent_id: str, input_text: str) -> dict:
            agent_triggered.set()
            return super().trigger(agent_id, input_text)

    fake = SignalingCoreAi()
    monkeypatch.setattr(tasks_module, "task_has_active_execution", pausing_active_check)
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "read-only-agent")
    try:
        merchant = make_merchant(client)
        task = make_task(client, merchant["id"], title="Cancel race")

        with ThreadPoolExecutor(max_workers=2) as pool:
            cancel_future = pool.submit(
                client.patch,
                f"/api/tasks/{task['id']}",
                json={"status": "cancelled"},
            )
            assert cancel_checked.wait(timeout=3)
            execute_future = pool.submit(client.post, f"/api/tasks/{task['id']}/execute")
            assert execute_checked_agent.wait(timeout=3)
            release_execute.set()
            assert not agent_triggered.wait(timeout=0.2)
            release_cancel.set()
            cancel = cancel_future.result(timeout=3)
            execute = execute_future.result(timeout=3)

        assert cancel.status_code == 200
        assert cancel.json()["status"] == "cancelled"
        assert execute.status_code == 409
        assert execute.json()["detail"] == "terminal task cannot be executed"
        assert fake.triggered == []
    finally:
        release_execute.set()
        release_cancel.set()
        app.dependency_overrides.pop(get_execution_coreai, None)


def test_unstructured_or_unauthorized_agent_output_never_becomes_approvable(client):
    from app.main import app
    from app.scheduler import poll_task_executions_once
    from app.tasks import get_execution_coreai
    from helpers import FakeCoreAi

    fake = FakeCoreAi()
    app.dependency_overrides[get_execution_coreai] = lambda: (fake, "agent-execution")
    try:
        merchant = make_merchant(client)
        plain_task = make_task(client, merchant["id"], title="plain result")
        plain = client.post(f"/api/tasks/{plain_task['id']}/execute").json()
        fake.runs[plain["coreai_run_id"]] = {"status": "COMPLETED", "output": "done"}

        write_task = make_task(client, merchant["id"], title="unsafe write result")
        write = client.post(f"/api/tasks/{write_task['id']}/execute").json()
        unsafe_result = json.loads(verified_agent_result())
        unsafe_result["external_write_performed"] = True
        fake.runs[write["coreai_run_id"]] = {
            "status": "COMPLETED",
            "output": json.dumps(unsafe_result),
        }

        poll_task_executions_once(fake)

        plain_execution = client.get(f"/api/tasks/{plain_task['id']}/execution").json()
        write_execution = client.get(f"/api/tasks/{write_task['id']}/execution").json()
        assert plain_execution["status"] == "failed"
        assert "structured JSON" in plain_execution["error"]
        assert write_execution["status"] == "failed"
        assert "unauthorized external write" in write_execution["error"]
    finally:
        app.dependency_overrides.pop(get_execution_coreai, None)

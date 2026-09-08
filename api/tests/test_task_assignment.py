import json
from datetime import datetime, timezone

import pytest

from test_tasks import make_merchant, make_task


def assign(client, task, kind="HUMAN", identity="test", **overrides):
    return client.put(f"/api/tasks/{task['id']}/assignment", json={
        "expected_version": task["version"], "assignee_type": kind,
        "assignee_id": identity, "reason": "确认责任人", **overrides,
    })


def seed_agent(status="active"):
    from app.agent_workbench import seed_configured_agents
    from app.config import configured_agent_slots
    from app.db import connect

    with connect() as conn:
        seed_configured_agents(conn, configured_agent_slots({
            "COREAI_AGENT_ID": "external-agent"
        }), datetime.now(timezone.utc))
        agent_id = conn.execute("SELECT id FROM seo_ops_agents").fetchone()[0]
        conn.execute("UPDATE seo_ops_agents SET status=?,retired_at=? WHERE id=?",
                     (status, datetime.now(timezone.utc).isoformat() if status == "retired" else None, agent_id))
    return agent_id


def test_am_assignment_persists_identity_and_event(client):
    task = make_task(client, make_merchant(client)["id"])
    response = assign(client, task)
    assert response.status_code == 200, response.text
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["assignment"]["assignee_type"] == "HUMAN"
    assert detail["assignment"]["assignee_id"] == "test"
    assert detail["assignment"]["display_name"] == "AM · test"
    assert detail["version"] == task["version"] + 1
    event = detail["events"][-1]
    assert event["event_type"] == "TASK_ASSIGNED"
    assert event["actor_id"] == "test"
    assert event["payload"]["before"] is None
    assert event["payload"]["after"]["assignee_id"] == "test"
    assert assign(client, task).status_code == 409


@pytest.mark.parametrize("kind,identity", [("HUMAN", "someone"), ("AGENT", "missing")])
def test_assignment_rejects_untrusted_identity(client, kind, identity):
    task = make_task(client, make_merchant(client)["id"])
    assert assign(client, task, kind, identity).status_code == 422
    assert client.get(f"/api/tasks/{task['id']}").json()["version"] == task["version"]


@pytest.mark.parametrize("kind,identity", [(None, "test"), ("HUMAN", None), ("AM", "test")])
def test_assignment_requires_valid_identity_pair(client, kind, identity):
    task = make_task(client, make_merchant(client)["id"])
    assert assign(client, task, kind, identity).status_code == 422


def test_active_agent_choices_and_assignment(client):
    task = make_task(client, make_merchant(client)["id"])
    agent_id = seed_agent()
    choices = client.get(f"/api/tasks/{task['id']}/assignment")
    assert choices.status_code == 200, choices.text
    assert [(x["assignee_type"], x["assignee_id"]) for x in choices.json()["options"]] == [
        ("HUMAN", "test"), ("AGENT", agent_id)
    ]
    assert assign(client, task, "AGENT", agent_id).status_code == 200
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["assignment"]["assignee_id"] == agent_id
    assert detail["readiness"] == "BLOCKED"
    assert detail["blocker"]["code"] == "ASSIGNEE_EXECUTION_UNAVAILABLE"


@pytest.mark.parametrize("status", ["disabled", "retired"])
def test_inactive_agent_cannot_be_assigned(client, status):
    task = make_task(client, make_merchant(client)["id"])
    agent_id = seed_agent(status)
    assert assign(client, task, "AGENT", agent_id).status_code == 422


@pytest.mark.parametrize("status", ["PREPARING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "DONE", "CANCELLED"])
def test_locked_task_cannot_be_transferred(client, status):
    from app.db import connect
    task = make_task(client, make_merchant(client)["id"])
    with connect() as conn:
        conn.execute("UPDATE tasks SET status=? WHERE id=?", (status, task["id"]))
    assert assign(client, task).status_code == 409
    assert client.get(f"/api/tasks/{task['id']}/assignment").json()["can_change"] is False


def test_clear_and_noop_preserve_legacy_text(client):
    from app.db import connect, init_db
    task = make_task(client, make_merchant(client)["id"])
    with connect() as conn:
        conn.execute("UPDATE tasks SET assignee='old operator' WHERE id=?", (task["id"],))
    assert assign(client, task).status_code == 200
    fresh = client.get(f"/api/tasks/{task['id']}").json()
    assert assign(client, fresh).json()["version"] == fresh["version"]
    assert assign(client, fresh, None, None).status_code == 200
    init_db()
    detail = client.get(f"/api/tasks/{task['id']}").json()
    assert detail["assignment"] is None
    assert detail["assignee"] == "old operator"
    assert [e["event_type"] for e in detail["events"]].count("TASK_ASSIGNED") == 2


def test_unknown_execution_blocks_transfer(client):
    from app.db import connect
    task = make_task(client, make_merchant(client)["id"])
    with connect() as conn:
        conn.execute("INSERT INTO task_executions (task_id,stage,status,attempt,request_json,"
                     "request_checksum,idempotency_key,created_at) VALUES (?, 'PREPARATION',"
                     "'UNKNOWN',1,? ,?,'unknown-assignment-test',?)",
                     (task["id"], json.dumps({}), "a" * 64, datetime.now(timezone.utc).isoformat()))
    assert assign(client, task).status_code == 409


def test_assignment_requires_login(client):
    task = make_task(client, make_merchant(client)["id"])
    client.post("/api/auth/logout")
    assert assign(client, task).status_code == 401
    assert client.get(f"/api/tasks/{task['id']}/assignment").status_code == 401


def test_upgrade_from_pre_assignment_database_preserves_tasks(client):
    from app.db import connect, init_db
    task = make_task(client, make_merchant(client)["id"])
    with connect() as conn:
        conn.execute("UPDATE tasks SET assignee='unresolved legacy' WHERE id=?", (task["id"],))
        before = tuple(conn.execute("SELECT * FROM tasks WHERE id=?", (task["id"],)).fetchone())
        conn.execute("DROP TABLE task_assignments")
        conn.execute("DELETE FROM schema_migrations WHERE version='0005_task_assignments'")
    init_db()
    init_db()
    with connect() as conn:
        assert tuple(conn.execute("SELECT * FROM tasks WHERE id=?", (task["id"],)).fetchone()) == before
        assert conn.execute("SELECT COUNT(*) FROM task_assignments").fetchone()[0] == 0
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_assignment_and_version_roll_back_when_event_write_fails(client, monkeypatch):
    from app import task_assignment
    from app.db import connect
    task = make_task(client, make_merchant(client)["id"])
    def fail_event(*args, **kwargs):
        raise RuntimeError("event write failed")
    monkeypatch.setattr(task_assignment, "append_task_event", fail_event)
    with pytest.raises(RuntimeError, match="event write failed"):
        assign(client, task)
    with connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM task_assignments").fetchone()[0] == 0
        assert conn.execute("SELECT version FROM tasks WHERE id=?", (task["id"],)).fetchone()[0] == task["version"]


def test_archived_merchant_cannot_be_assigned(client):
    merchant = make_merchant(client)
    task = make_task(client, merchant["id"])
    assert client.patch(f"/api/merchants/{merchant['id']}", json={"status": "archived"}).status_code == 200
    assert assign(client, task).status_code == 409


def test_assignment_agent_never_uses_legacy_preparation(client):
    from app import tasks
    from app.main import app
    task = make_task(client, make_merchant(client)["id"])
    agent_id = seed_agent()
    assert assign(client, task, "AGENT", agent_id).status_code == 200
    fresh = client.get(f"/api/tasks/{task['id']}").json()
    class NeverCalled:
        def llm_call(self, *args, **kwargs):
            raise AssertionError("must not call the legacy executor")
    app.dependency_overrides[tasks.get_execution_coreai] = lambda: (NeverCalled(), "legacy-call")
    try:
        response = client.post(f"/api/tasks/{task['id']}/execute", json={"expected_version": fresh["version"]})
        assert response.status_code == 409, response.text
        assert "执行绑定" in response.json()["detail"]
        assert client.get(f"/api/tasks/{task['id']}").json()["executions"] == []
    finally:
        app.dependency_overrides.pop(tasks.get_execution_coreai, None)

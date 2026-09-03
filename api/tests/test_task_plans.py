import json
import sqlite3

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


def plan_task(
    key: str,
    *,
    title: str | None = None,
    depends_on: list[str] | None = None,
    description: str | None = None,
) -> dict:
    return {
        "key": key,
        "task_type": "PREPARE_ONLY",
        "title": title or f"Prepare {key}",
        "rationale": f"The {key} work is required.",
        "expected_outcome": f"A reviewable {key} result.",
        "depends_on": depends_on or [],
        "scheduled_start": None,
        "parameters": {
            "description": description or f"Prepare {key} only.",
            "category": "content",
        },
    }


def two_wave_plan_payload(*, draft_title: str = "Draft content") -> dict:
    return {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            plan_task("draft", title=draft_title),
            plan_task("review", title="Review content", depends_on=["draft"]),
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


def create_draft_plan(client, payload=STRICT_PLAN):
    from app.scheduler import poll_runs_once

    fake = FakeCoreAi()
    merchant, run = start_run(client, fake)
    fake.runs[run["coreai_run_id"]] = {
        "status": "COMPLETED",
        "output": strict_plan_report(payload),
    }
    poll_runs_once(fake)
    response = client.get(f"/api/runs/{run['id']}/task-plan")
    assert response.status_code == 200
    return merchant, run, response.json()


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


def test_operator_edits_then_atomically_approves_exact_revision(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)
    edited = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": two_wave_plan_payload(),
            "removals": [
                {"key": "draft-schema", "reason": "Replace it with the two-step workflow."}
            ],
        },
    )
    assert edited.status_code == 200
    revision = edited.json()["current_revision"]

    approved = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": revision["revision"], "checksum": revision["checksum"]},
    )

    assert approved.status_code == 200
    assert approved.json()["approved_revision"] == 2
    assert [task["task_key"] for task in approved.json()["tasks"]] == ["draft", "review"]
    conn = connect()
    try:
        edge = conn.execute(
            "SELECT child.plan_id AS child_plan, parent.plan_id AS parent_plan, "
            "child.task_key AS child_key, parent.task_key AS parent_key "
            "FROM task_dependencies d "
            "JOIN tasks child ON child.id = d.task_id "
            "JOIN tasks parent ON parent.id = d.depends_on_task_id"
        ).fetchone()
        assert dict(edge) == {
            "child_plan": draft_plan["id"],
            "parent_plan": draft_plan["id"],
            "child_key": "review",
            "parent_key": "draft",
        }
        event_types = [
            row["event_type"]
            for row in conn.execute("SELECT event_type FROM task_events ORDER BY id")
        ]
        assert event_types == [
            "PLAN_DRAFT_REPLACED",
            "TASK_MATERIALIZED",
            "TASK_MATERIALIZED",
            "PLAN_APPROVED",
        ]
    finally:
        conn.close()


def test_stale_draft_revision_and_approval_checksum_return_conflict(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)

    stale_draft = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 999, "plan": STRICT_PLAN},
    )
    stale_checksum = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": "f" * 64},
    )

    assert stale_draft.status_code == 409
    assert stale_checksum.status_code == 409
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0] == 0
    finally:
        conn.close()


def test_current_draft_is_idempotent_but_reverting_to_old_checksum_creates_revision(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)
    original_checksum = draft_plan["current_revision"]["checksum"]

    unchanged = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": STRICT_PLAN},
    )
    assert unchanged.status_code == 200
    assert unchanged.json()["current_revision"]["revision"] == 1

    changed = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": two_wave_plan_payload(),
            "removals": [{"key": "draft-schema", "reason": "Use explicit draft and review steps."}],
        },
    )
    assert changed.status_code == 200
    reverted = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 2,
            "plan": STRICT_PLAN,
            "removals": [
                {"key": "draft", "reason": "Return to the original task."},
                {"key": "review", "reason": "Return to the original task."},
            ],
        },
    )

    assert reverted.status_code == 200
    assert reverted.json()["current_revision"]["revision"] == 3
    assert reverted.json()["current_revision"]["checksum"] == original_checksum
    conn = connect()
    try:
        revisions = conn.execute(
            "SELECT revision, decision_state, checksum FROM task_plan_revisions "
            "WHERE plan_id = ? ORDER BY revision",
            (draft_plan["id"],),
        ).fetchall()
        assert [(row["revision"], row["decision_state"]) for row in revisions] == [
            (1, "SUPERSEDED"),
            (2, "SUPERSEDED"),
            (3, "DRAFT"),
        ]
        assert revisions[0]["checksum"] == revisions[2]["checksum"]
    finally:
        conn.close()


@pytest.mark.parametrize(
    "plan,removals",
    [
        (two_wave_plan_payload(), []),
        (STRICT_PLAN, [{"key": "draft-schema", "reason": "Nothing was removed."}]),
        (
            two_wave_plan_payload(),
            [
                {"key": "draft-schema", "reason": "First reason."},
                {"key": "draft-schema", "reason": "Second reason."},
            ],
        ),
        (two_wave_plan_payload(), [{"key": "draft-schema", "reason": "   "}]),
    ],
    ids=["missing", "extra", "duplicate", "blank"],
)
def test_draft_removal_reasons_are_exact_unique_and_nonempty(client, plan, removals):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)

    response = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": plan, "removals": removals},
    )

    assert response.status_code == 422
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0] == 0
    finally:
        conn.close()


def test_draft_removal_reasons_are_audited_outside_the_strict_payload(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)

    response = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": two_wave_plan_payload(),
            "removals": [
                {"key": "draft-schema", "reason": "  Split ownership into two steps.  "}
            ],
        },
    )

    assert response.status_code == 200
    assert set(response.json()["current_revision"]["payload"]) == {"schema_version", "tasks"}
    conn = connect()
    try:
        revision = conn.execute(
            "SELECT payload_json FROM task_plan_revisions WHERE plan_id = ? AND revision = 2",
            (draft_plan["id"],),
        ).fetchone()
        assert "removal" not in revision["payload_json"]
        event = conn.execute(
            "SELECT payload_json FROM task_events WHERE entity_type = 'PLAN' "
            "AND entity_id = ? AND event_type = 'PLAN_DRAFT_REPLACED'",
            (draft_plan["id"],),
        ).fetchone()
        assert json.loads(event["payload_json"])["removed_keys"] == ["draft-schema"]
        assert json.loads(event["payload_json"])["removals"] == [
            {"key": "draft-schema", "reason": "Split ownership into two steps."}
        ]
    finally:
        conn.close()


def test_cycle_rejection_creates_no_revision_or_event(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)
    cyclic = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            plan_task("first", depends_on=["second"]),
            plan_task("second", depends_on=["first"]),
        ],
    }

    response = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": cyclic,
            "removals": [{"key": "draft-schema", "reason": "Replace the original proposal."}],
        },
    )

    assert response.status_code == 422
    conn = connect()
    try:
        assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0] == 0
    finally:
        conn.close()


def test_approval_failure_rolls_back_every_task_edge_event_and_decision(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client, two_wave_plan_payload())
    conn = connect()
    try:
        conn.execute(
            "CREATE TRIGGER fail_dependency_insert BEFORE INSERT ON task_dependencies "
            "BEGIN SELECT RAISE(ABORT, 'injected dependency failure'); END"
        )
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(sqlite3.IntegrityError, match="injected dependency failure"):
        client.post(
            f"/api/task-plans/{draft_plan['id']}/approve",
            json={
                "revision": 1,
                "checksum": draft_plan["current_revision"]["checksum"],
            },
        )

    conn = connect()
    try:
        plan = conn.execute(
            "SELECT approved_revision FROM task_plans WHERE id = ?", (draft_plan["id"],)
        ).fetchone()
        revision = conn.execute(
            "SELECT decision_state FROM task_plan_revisions WHERE plan_id = ? AND revision = 1",
            (draft_plan["id"],),
        ).fetchone()
        assert plan["approved_revision"] is None
        assert revision["decision_state"] == "DRAFT"
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM task_dependencies").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0] == 0
    finally:
        conn.close()


@pytest.mark.parametrize("change", ["alter", "remove"])
def test_new_draft_cannot_alter_or_remove_a_task_past_pending(client, change):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client, two_wave_plan_payload())
    approved = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": draft_plan["current_revision"]["checksum"]},
    )
    assert approved.status_code == 200
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'PREPARING' WHERE plan_id = ? AND task_key = 'draft'",
            (draft_plan["id"],),
        )
        conn.commit()
    finally:
        conn.close()

    if change == "alter":
        candidate = two_wave_plan_payload(draft_title="Silently rewritten draft")
        removals = []
    else:
        candidate = {
            "schema_version": "seo_ops.task_plan.v1",
            "tasks": [plan_task("review", title="Review content")],
        }
        removals = [{"key": "draft", "reason": "Try to remove an active task."}]
    response = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": candidate, "removals": removals},
    )

    assert response.status_code == 409
    conn = connect()
    try:
        assert conn.execute(
            "SELECT COUNT(*) FROM task_plan_revisions WHERE plan_id = ?", (draft_plan["id"],)
        ).fetchone()[0] == 1
    finally:
        conn.close()


def test_approval_rechecks_task_anchor_that_advanced_after_draft_save(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client, two_wave_plan_payload())
    first_approval = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": draft_plan["current_revision"]["checksum"]},
    )
    assert first_approval.status_code == 200
    edited = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": two_wave_plan_payload(draft_title="Updated while still pending"),
        },
    )
    assert edited.status_code == 200
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = 'PREPARING' WHERE plan_id = ? AND task_key = 'draft'",
            (draft_plan["id"],),
        )
        conn.commit()
    finally:
        conn.close()

    response = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={
            "revision": 2,
            "checksum": edited.json()["current_revision"]["checksum"],
        },
    )

    assert response.status_code == 409
    conn = connect()
    try:
        plan = conn.execute("SELECT * FROM task_plans WHERE id = ?", (draft_plan["id"],)).fetchone()
        task = conn.execute(
            "SELECT * FROM tasks WHERE plan_id = ? AND task_key = 'draft'", (draft_plan["id"],)
        ).fetchone()
        assert plan["approved_revision"] == 1
        assert task["title"] == "Draft content"
        assert task["plan_revision"] == 1
        assert conn.execute(
            "SELECT decision_state FROM task_plan_revisions WHERE plan_id = ? AND revision = 2",
            (draft_plan["id"],),
        ).fetchone()[0] == "DRAFT"
    finally:
        conn.close()


def test_new_approval_updates_and_cancels_only_pending_tasks_and_supersedes_revision(client):
    from app.db import connect

    original = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            plan_task("draft", title="Original draft"),
            plan_task("review", title="Original review", depends_on=["draft"]),
            plan_task("obsolete", title="Obsolete task"),
        ],
    }
    _merchant, _run, draft_plan = create_draft_plan(client, original)
    first_approval = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": draft_plan["current_revision"]["checksum"]},
    )
    assert first_approval.status_code == 200
    before = {task["task_key"]: task for task in first_approval.json()["tasks"]}
    replacement = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            plan_task("draft", title="Revised draft"),
            plan_task("review", title="Original review", depends_on=["draft"]),
            plan_task("publish", title="Prepare publication", depends_on=["review"]),
        ],
    }
    edited = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={
            "expected_revision": 1,
            "plan": replacement,
            "removals": [{"key": "obsolete", "reason": "The task no longer adds value."}],
        },
    )
    assert edited.status_code == 200

    second_approval = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 2, "checksum": edited.json()["current_revision"]["checksum"]},
    )

    assert second_approval.status_code == 200
    assert [task["task_key"] for task in second_approval.json()["tasks"]] == [
        "draft",
        "review",
        "publish",
    ]
    current = {task["task_key"]: task for task in second_approval.json()["tasks"]}
    assert current["draft"]["id"] == before["draft"]["id"]
    assert current["review"]["id"] == before["review"]["id"]
    assert current["draft"]["title"] == "Revised draft"
    assert current["draft"]["plan_revision"] == 2
    assert current["draft"]["version"] == 2
    conn = connect()
    try:
        obsolete = conn.execute(
            "SELECT * FROM tasks WHERE plan_id = ? AND task_key = 'obsolete'", (draft_plan["id"],)
        ).fetchone()
        assert obsolete["status"] == "CANCELLED"
        assert obsolete["plan_revision"] == 1
        assert obsolete["cancelled_at"] is not None
        assert conn.execute(
            "SELECT COUNT(*) FROM task_dependencies d "
            "JOIN tasks child ON child.id = d.task_id "
            "JOIN tasks parent ON parent.id = d.depends_on_task_id "
            "WHERE child.plan_id != parent.plan_id"
        ).fetchone()[0] == 0
        edges = conn.execute(
            "SELECT child.task_key, parent.task_key FROM task_dependencies d "
            "JOIN tasks child ON child.id = d.task_id "
            "JOIN tasks parent ON parent.id = d.depends_on_task_id ORDER BY d.id"
        ).fetchall()
        assert [tuple(row) for row in edges] == [("review", "draft"), ("publish", "review")]
        revisions = conn.execute(
            "SELECT revision, decision_state FROM task_plan_revisions "
            "WHERE plan_id = ? ORDER BY revision",
            (draft_plan["id"],),
        ).fetchall()
        assert [tuple(row) for row in revisions] == [(1, "SUPERSEDED"), (2, "APPROVED")]
    finally:
        conn.close()


def test_reject_marks_only_the_selected_draft_and_audits_reason(client):
    from app.db import connect

    _merchant, _run, draft_plan = create_draft_plan(client)

    rejected = client.post(
        f"/api/task-plans/{draft_plan['id']}/reject",
        json={"expected_revision": 1, "reason": "  The proposal is outside this cycle.  "},
    )

    assert rejected.status_code == 200
    assert rejected.json()["state"] == "REJECTED"
    assert rejected.json()["current_revision"]["decision_state"] == "REJECTED"
    assert rejected.json()["current_revision"]["decision_reason"] == "The proposal is outside this cycle."
    conn = connect()
    try:
        event = conn.execute(
            "SELECT * FROM task_events WHERE entity_type = 'PLAN' AND entity_id = ?",
            (draft_plan["id"],),
        ).fetchone()
        assert event["event_type"] == "PLAN_REJECTED"
        assert json.loads(event["payload_json"])["reason"] == "The proposal is outside this cycle."
        assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 0
    finally:
        conn.close()


def test_rejecting_new_draft_keeps_prior_approved_revision_active(client):
    _merchant, _run, draft_plan = create_draft_plan(client, two_wave_plan_payload())
    approved = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": draft_plan["current_revision"]["checksum"]},
    )
    assert approved.status_code == 200
    edited = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": two_wave_plan_payload()},
    )
    assert edited.status_code == 200

    rejected = client.post(
        f"/api/task-plans/{draft_plan['id']}/reject",
        json={"expected_revision": 2, "reason": "Keep the prior approved workflow."},
    )

    assert rejected.status_code == 200
    assert rejected.json()["state"] == "OPEN"
    assert rejected.json()["approved_revision"] == 1
    assert rejected.json()["current_revision"]["decision_state"] == "REJECTED"


def test_plan_lifecycle_closes_only_without_draft_and_all_tasks_terminal(client):
    from app.db import connect
    from app.task_plans import refresh_plan_lifecycle

    _merchant, _run, draft_plan = create_draft_plan(client, two_wave_plan_payload())
    approved = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": 1, "checksum": draft_plan["current_revision"]["checksum"]},
    )
    assert approved.status_code == 200
    conn = connect()
    try:
        conn.execute(
            "UPDATE tasks SET status = CASE task_key WHEN 'draft' THEN 'DONE' ELSE 'CANCELLED' END "
            "WHERE plan_id = ?",
            (draft_plan["id"],),
        )
        refresh_plan_lifecycle(conn, draft_plan["id"])
        conn.commit()
        closed = conn.execute("SELECT * FROM task_plans WHERE id = ?", (draft_plan["id"],)).fetchone()
        assert closed["state"] == "CLOSED"
        assert closed["closed_at"] is not None
    finally:
        conn.close()

    reopened = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": two_wave_plan_payload()},
    )
    assert reopened.status_code == 200
    assert reopened.json()["state"] == "OPEN"
    assert reopened.json()["closed_at"] is None

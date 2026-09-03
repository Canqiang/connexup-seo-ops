import sqlite3
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture()
def db():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE merchants (
            id INTEGER PRIMARY KEY,
            status TEXT NOT NULL
        );
        CREATE TABLE task_plans (
            id INTEGER PRIMARY KEY,
            approved_revision INTEGER
        );
        CREATE TABLE tasks (
            id INTEGER PRIMARY KEY,
            merchant_id INTEGER NOT NULL,
            plan_id INTEGER NOT NULL,
            plan_revision INTEGER NOT NULL,
            task_key TEXT NOT NULL,
            task_type TEXT NOT NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            scheduled_start TEXT
        );
        CREATE TABLE task_dependencies (
            id INTEGER PRIMARY KEY,
            task_id INTEGER NOT NULL,
            depends_on_task_id INTEGER NOT NULL
        );
        """
    )
    conn.execute("INSERT INTO merchants (id, status) VALUES (1, 'active')")
    conn.execute("INSERT INTO task_plans (id, approved_revision) VALUES (1, 1)")
    conn.commit()
    yield conn
    conn.close()


@pytest.fixture()
def seed_task_graph(db):
    db.executemany(
        """
        INSERT INTO tasks
            (id, merchant_id, plan_id, plan_revision, task_key, task_type, title, status)
        VALUES (?, 1, 1, 1, ?, 'PREPARE_ONLY', ?, ?)
        """,
        [
            (10, "draft", "Draft content", "PENDING"),
            (20, "review", "Review content", "PENDING"),
        ],
    )
    db.execute(
        "INSERT INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (1, 20, 10)"
    )
    db.commit()
    return {"draft": 10, "review": 20}


def test_phase_one_enables_only_prepare_only():
    from app.task_workflows import enabled_task_types

    assert enabled_task_types() == {"PREPARE_ONLY"}


def test_prepare_only_template_is_versioned_and_immutable():
    from app.task_workflows import WORKFLOW_TEMPLATES, WorkflowTemplate

    template = WORKFLOW_TEMPLATES["PREPARE_ONLY"]
    assert isinstance(template, WorkflowTemplate)
    assert template.task_type == "PREPARE_ONLY"
    assert template.version == 1
    assert template.terminal_after_approval is True
    assert template.transitions == {
        "PENDING": frozenset({"PREPARING", "NEEDS_ATTENTION", "CANCELLED"}),
        "PREPARING": frozenset({"AWAITING_APPROVAL", "NEEDS_ATTENTION", "CANCELLED"}),
        "AWAITING_APPROVAL": frozenset({"DONE", "PENDING", "NEEDS_ATTENTION", "CANCELLED"}),
        "NEEDS_ATTENTION": frozenset({"PENDING", "CANCELLED"}),
        "DONE": frozenset(),
        "CANCELLED": frozenset(),
    }
    with pytest.raises((AttributeError, TypeError)):
        template.version = 2


@pytest.mark.parametrize(
    "current,target",
    [
        ("PENDING", "PREPARING"),
        ("PREPARING", "AWAITING_APPROVAL"),
        ("AWAITING_APPROVAL", "DONE"),
        ("AWAITING_APPROVAL", "PENDING"),
        ("NEEDS_ATTENTION", "PENDING"),
        ("PENDING", "CANCELLED"),
    ],
)
def test_prepare_only_accepts_server_owned_transitions(current, target):
    from app.task_workflows import assert_transition

    assert assert_transition("PREPARE_ONLY", current, target) is None


@pytest.mark.parametrize(
    "task_type,current,target",
    [
        ("PREPARE_ONLY", "PENDING", "DONE"),
        ("PREPARE_ONLY", "PREPARING", "DONE"),
        ("PREPARE_ONLY", "DONE", "PENDING"),
        ("PREPARE_ONLY", "CANCELLED", "PENDING"),
        ("PREPARE_ONLY", "EXECUTING", "DONE"),
        ("GBP_POST", "PENDING", "PREPARING"),
    ],
)
def test_illegal_transition_is_rejected(task_type, current, target):
    from app.task_workflows import assert_transition

    with pytest.raises(ValueError):
        assert_transition(task_type, current, target)


def test_dependency_blocker_names_the_first_incomplete_upstream(seed_task_graph, db):
    from app.task_workflows import task_blocker

    downstream = db.execute("SELECT * FROM tasks WHERE task_key = 'review'").fetchone()
    assert task_blocker(db, downstream) == {
        "code": "UPSTREAM_NOT_DONE",
        "task_id": seed_task_graph["draft"],
        "task_key": "draft",
        "task_title": "Draft content",
    }


def test_dependency_blocker_uses_dependency_row_order(seed_task_graph, db):
    from app.task_workflows import task_blocker

    db.execute(
        "INSERT INTO tasks (id, merchant_id, plan_id, plan_revision, task_key, task_type, title, status) "
        "VALUES (30, 1, 1, 1, 'research', 'PREPARE_ONLY', 'Research facts', 'PREPARING')"
    )
    db.execute(
        "INSERT INTO task_dependencies (id, task_id, depends_on_task_id) VALUES (0, 20, 30)"
    )
    db.commit()
    downstream = db.execute("SELECT * FROM tasks WHERE id = 20").fetchone()
    assert task_blocker(db, downstream)["task_key"] == "research"


def test_archived_merchant_blocks_before_other_conditions(seed_task_graph, db):
    from app.task_workflows import task_blocker

    db.execute("UPDATE merchants SET status = 'archived' WHERE id = 1")
    db.execute(
        "UPDATE tasks SET scheduled_start = ? WHERE id = 20",
        ((datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),),
    )
    db.commit()
    task = db.execute("SELECT * FROM tasks WHERE id = 20").fetchone()
    assert task_blocker(db, task) == {"code": "MERCHANT_ARCHIVED"}


def test_inactive_approved_revision_blocks_before_schedule(seed_task_graph, db):
    from app.task_workflows import task_blocker

    db.execute("UPDATE task_plans SET approved_revision = 2 WHERE id = 1")
    db.execute(
        "UPDATE tasks SET scheduled_start = ? WHERE id = 20",
        ((datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),),
    )
    db.commit()
    task = db.execute("SELECT * FROM tasks WHERE id = 20").fetchone()
    assert task_blocker(db, task) == {"code": "REVISION_INACTIVE"}


def test_future_schedule_blocks_with_exact_scheduled_time(seed_task_graph, db):
    from app.task_workflows import task_blocker

    start = datetime(2026, 9, 5, 13, 0, tzinfo=timezone.utc)
    db.execute("UPDATE tasks SET scheduled_start = ? WHERE id = 20", (start.isoformat(),))
    db.commit()
    task = db.execute("SELECT * FROM tasks WHERE id = 20").fetchone()
    assert task_blocker(db, task, now=datetime(2026, 9, 5, 12, 59, tzinfo=timezone.utc)) == {
        "code": "SCHEDULED_FOR_FUTURE",
        "scheduled_start": start.isoformat(),
    }


def test_done_dependencies_and_elapsed_schedule_are_ready(seed_task_graph, db):
    from app.task_workflows import task_blocker

    db.execute("UPDATE tasks SET status = 'DONE' WHERE id = 10")
    start = datetime(2026, 9, 5, 13, 0, tzinfo=timezone.utc)
    db.execute("UPDATE tasks SET scheduled_start = ? WHERE id = 20", (start.isoformat(),))
    db.commit()
    task = db.execute("SELECT * FROM tasks WHERE id = 20").fetchone()
    assert task_blocker(db, task, now=start + timedelta(seconds=1)) is None

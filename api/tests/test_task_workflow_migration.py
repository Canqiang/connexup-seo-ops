import hashlib
import json
import sqlite3

import pytest


LEGACY_SCHEMA = """
CREATE TABLE merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes TEXT,
  primary_location TEXT,
  website_url TEXT,
  auto_run_interval_days INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  coreai_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','auto')),
  report_text TEXT,
  error TEXT,
  plan_approved_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  expected_outcome TEXT,
  category TEXT,
  scheduled_start TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
  evidence_note TEXT,
  source_run_id INTEGER REFERENCES runs(id),
  source_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE task_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  coreai_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ready','failed','approved','returned')),
  attempt INTEGER NOT NULL,
  output_text TEXT,
  error TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  reviewed_at TEXT
);
"""


def _seed_legacy_database(path, *, unapproved_execution=False):
    conn = sqlite3.connect(path)
    conn.executescript(LEGACY_SCHEMA)
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) VALUES (1, 'Legacy Merchant', '2026-08-01T00:00:00+00:00')"
    )
    conn.executemany(
        "INSERT INTO runs (id, merchant_id, coreai_run_id, status, trigger_kind, plan_approved_at, created_at, finished_at) "
        "VALUES (?, 1, ?, 'succeeded', 'manual', ?, '2026-08-02T00:00:00+00:00', '2026-08-02T01:00:00+00:00')",
        [
            (10, "approved-core-run", "2026-08-02T02:00:00+00:00"),
            (20, "draft-core-run", None),
        ],
    )
    conn.executemany(
        "INSERT INTO tasks "
        "(id, merchant_id, title, description, rationale, expected_outcome, category, scheduled_start, status, evidence_note, source_run_id, source_key, created_at, completed_at) "
        "VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (1, "Manual todo", "todo description", "todo rationale", "todo outcome", "content", None, "todo", "todo evidence", None, "manual-todo", "2026-08-03T00:00:00+00:00", None),
            (2, "Manual done", "done description", "done rationale", "done outcome", "review", None, "done", "done evidence", None, "manual-done", "2026-08-03T01:00:00+00:00", "2026-08-04T00:00:00+00:00"),
            (3, "Ambiguous doing", None, None, None, None, None, "doing", None, None, "ambiguous", "2026-08-03T02:00:00+00:00", None),
            (4, "Returned task", "returned description", "returned rationale", "returned outcome", "gbp", None, "doing", "returned evidence", None, "returned", "2026-08-03T03:00:00+00:00", None),
            (5, "Failed task", "failed description", "failed rationale", "failed outcome", "technical", None, "doing", "failed evidence", None, "failed", "2026-08-03T04:00:00+00:00", None),
            (10, "Approved running", "running description", "running rationale", "running outcome", "citation", "2026-08-10T00:00:00+00:00", "doing", "running evidence", 10, "running", "2026-08-05T00:00:00+00:00", None),
            (11, "Approved ready", "ready description", "ready rationale", "ready outcome", "other", None, "doing", "ready evidence", 10, "ready", "2026-08-05T01:00:00+00:00", None),
            (20, "Draft first", "draft first description", "draft first rationale", "draft first outcome", "content", None, "todo", None, 20, "draft-first", "2026-08-06T00:00:00+00:00", None),
            (21, "Draft second", None, "draft second rationale", "draft second outcome", None, None, "todo", None, 20, "draft-second", "2026-08-06T01:00:00+00:00", None),
        ],
    )
    executions = [
        (99, 2, "exec-approved", "approved", 2, "approved output", None, None, "2026-08-06T22:00:00+00:00", "2026-08-06T23:00:00+00:00", "2026-08-07T00:00:00+00:00"),
        (100, 10, "exec-running", "running", 1, None, None, None, "2026-08-07T00:00:00+00:00", None, None),
        (101, 11, "exec-ready", "ready", 2, "ready output", None, None, "2026-08-07T01:00:00+00:00", "2026-08-07T02:00:00+00:00", None),
        (102, 4, "exec-returned", "returned", 3, "returned output", None, "please revise", "2026-08-07T03:00:00+00:00", "2026-08-07T04:00:00+00:00", "2026-08-07T05:00:00+00:00"),
        (103, 5, "exec-failed", "failed", 4, "partial output", "provider failed", "failure review", "2026-08-07T06:00:00+00:00", "2026-08-07T07:00:00+00:00", None),
    ]
    if unapproved_execution:
        executions.append(
            (104, 20, "exec-unapproved", "running", 1, None, None, None, "2026-08-07T08:00:00+00:00", None, None)
        )
    conn.executemany(
        "INSERT INTO task_executions "
        "(id, task_id, coreai_run_id, status, attempt, output_text, error, review_note, created_at, finished_at, reviewed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        executions,
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def legacy_task_db(tmp_path):
    path = tmp_path / "legacy-task.db"
    _seed_legacy_database(path)
    return path


def test_legacy_tasks_are_converted_without_losing_history(legacy_task_db, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(legacy_task_db)
    conn.row_factory = sqlite3.Row

    states = {row["source_key"]: row["status"] for row in conn.execute("SELECT * FROM tasks")}
    assert states == {
        "manual-todo": "PENDING",
        "manual-done": "DONE",
        "ambiguous": "NEEDS_ATTENTION",
        "returned": "NEEDS_ATTENTION",
        "failed": "NEEDS_ATTENTION",
        "running": "PREPARING",
        "ready": "AWAITING_APPROVAL",
    }
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 7
    assert conn.execute("SELECT COUNT(*) FROM task_plans").fetchone()[0] == 7
    assert conn.execute("SELECT COUNT(*) FROM task_plan_revisions").fetchone()[0] == 7

    approved_run_plan = conn.execute("SELECT * FROM task_plans WHERE source_run_id = 10").fetchone()
    assert approved_run_plan["source_kind"] == "AGENT"
    assert approved_run_plan["approved_revision"] == 1
    assert conn.execute("SELECT COUNT(*) FROM tasks WHERE plan_id = ?", (approved_run_plan["id"],)).fetchone()[0] == 2

    draft_plan = conn.execute("SELECT * FROM task_plans WHERE source_run_id = 20").fetchone()
    assert draft_plan["approved_revision"] is None
    draft_revision = conn.execute(
        "SELECT * FROM task_plan_revisions WHERE plan_id = ?", (draft_plan["id"],)
    ).fetchone()
    assert draft_revision["decision_state"] == "DRAFT"
    assert json.loads(draft_revision["payload_json"]) == {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [
            {
                "depends_on": [],
                "expected_outcome": "draft first outcome",
                "key": "draft-first",
                "parameters": {"category": "content", "description": "draft first description"},
                "rationale": "draft first rationale",
                "scheduled_start": None,
                "task_type": "PREPARE_ONLY",
                "title": "Draft first",
            },
            {
                "depends_on": [],
                "expected_outcome": "draft second outcome",
                "key": "draft-second",
                "parameters": {"category": None, "description": None},
                "rationale": "draft second rationale",
                "scheduled_start": None,
                "task_type": "PREPARE_ONLY",
                "title": "Draft second",
            },
        ],
    }
    assert conn.execute("SELECT COUNT(*) FROM tasks WHERE source_run_id = 20").fetchone()[0] == 0

    executions = {row["id"]: row for row in conn.execute("SELECT * FROM task_executions")}
    assert {key: row["status"] for key, row in executions.items()} == {
        99: "SUCCEEDED",
        100: "RUNNING",
        101: "SUCCEEDED",
        102: "FAILED",
        103: "FAILED",
    }
    assert executions[100]["task_id"] == 10
    assert executions[99]["result_json"] == "approved output"
    assert executions[101]["task_id"] == 11
    assert executions[101]["result_json"] == "ready output"
    assert executions[102]["result_json"] == "returned output"
    assert executions[102]["review_note"] == "please revise"
    assert executions[103]["result_json"] == "partial output"
    assert executions[103]["error"] == "provider failed"
    assert executions[103]["review_note"] == "failure review"
    assert executions[103]["coreai_run_id"] == "exec-failed"
    assert executions[103]["attempt"] == 4
    assert executions[103]["created_at"] == "2026-08-07T06:00:00+00:00"
    assert executions[103]["finished_at"] == "2026-08-07T07:00:00+00:00"

    manual = conn.execute("SELECT * FROM tasks WHERE source_key = 'manual-todo'").fetchone()
    assert (manual["description"], manual["rationale"], manual["expected_outcome"]) == (
        "todo description",
        "todo rationale",
        "todo outcome",
    )
    assert manual["evidence_note"] == "todo evidence"
    assert manual["workflow_version"] == 1
    assert len(manual["definition_checksum"]) == 64
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_second_init_is_an_idempotent_no_op(legacy_task_db, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(legacy_task_db)
    before = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in ("task_plans", "task_plan_revisions", "tasks", "task_executions")
    }
    conn.close()

    init_db()
    conn = sqlite3.connect(legacy_task_db)
    after = {
        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        for table in before
    }
    marker_count = conn.execute(
        "SELECT COUNT(*) FROM schema_migrations WHERE name = 'task_workflow_v1'"
    ).fetchone()[0]
    conn.close()
    assert after == before
    assert marker_count == 1


def test_unapproved_candidate_with_execution_fails_closed_and_rolls_back(tmp_path, monkeypatch):
    path = tmp_path / "ambiguous.db"
    _seed_legacy_database(path, unapproved_execution=True)
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(RuntimeError, match="unapproved.*execution"):
        init_db()

    conn = sqlite3.connect(path)
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    assert "'todo','doing','done','cancelled'" in task_sql
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 9
    markers = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone()[0]
    assert markers == 0
    conn.close()


def test_rebuild_failure_rolls_back_every_schema_change(legacy_task_db, monkeypatch):
    from app import task_migrations

    conn = sqlite3.connect(legacy_task_db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")

    def fail_after_replacement_tables(_conn):
        raise RuntimeError("injected conversion failure")

    monkeypatch.setattr(task_migrations, "_convert_legacy_runs_and_tasks", fail_after_replacement_tables)
    with pytest.raises(RuntimeError, match="injected conversion failure"):
        task_migrations.migrate_task_workflow_v1(conn)

    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 9
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_plans'"
    ).fetchone()[0] == 0
    conn.close()


def test_events_tasks_and_revision_payloads_are_database_immutable(tmp_path, monkeypatch):
    path = tmp_path / "immutable.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.task_events import append_task_event

    init_db()
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) VALUES (1, 'Merchant', '2026-09-03T00:00:00+00:00')"
    )
    plan_id = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, state, latest_revision, created_at) "
        "VALUES (1, 'OPERATOR', 'OPEN', 1, '2026-09-03T00:00:00+00:00')"
    ).lastrowid
    payload = '{"schema_version":"seo_ops.task_plan.v1","tasks":[]}'
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, created_by, created_at) "
        "VALUES (?, 1, 'DRAFT', 'seo_ops.task_plan.v1', ?, ?, 'OPERATOR', 'operator-1', '2026-09-03T00:00:00+00:00')",
        (plan_id, payload, checksum),
    )
    task_id = conn.execute(
        "INSERT INTO tasks "
        "(merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, parameters_json, definition_checksum, title, status, created_at) "
        "VALUES (1, ?, 1, 'task-1', 'PREPARE_ONLY', 1, '{}', ?, 'Task', 'PENDING', '2026-09-03T00:00:00+00:00')",
        (plan_id, hashlib.sha256(b"{}").hexdigest()),
    ).lastrowid
    event_id = append_task_event(
        conn,
        entity_type="TASK",
        entity_id=task_id,
        event_type="CREATED",
        actor_type="OPERATOR",
        actor_id="operator-1",
        payload={"z": 1, "a": "值"},
    )
    event = conn.execute("SELECT * FROM task_events WHERE id = ?", (event_id,)).fetchone()
    assert event["payload_json"] == '{"a":"值","z":1}'

    with pytest.raises(sqlite3.IntegrityError, match="task events are append-only"):
        conn.execute("UPDATE task_events SET event_type = 'CHANGED' WHERE id = ?", (event_id,))
    with pytest.raises(sqlite3.IntegrityError, match="task events are append-only"):
        conn.execute("DELETE FROM task_events WHERE id = ?", (event_id,))
    with pytest.raises(sqlite3.IntegrityError, match="formal tasks cannot be deleted"):
        conn.execute("DELETE FROM tasks WHERE id = ?", (task_id,))
    with pytest.raises(sqlite3.IntegrityError, match="plan revision definition is immutable"):
        conn.execute(
            "UPDATE task_plan_revisions SET payload_json = '{}' WHERE plan_id = ? AND revision = 1",
            (plan_id,),
        )

    conn.execute(
        "UPDATE task_plan_revisions "
        "SET decision_state = 'APPROVED', decided_by = 'operator-1', decided_at = '2026-09-03T01:00:00+00:00' "
        "WHERE plan_id = ? AND revision = 1",
        (plan_id,),
    )
    assert conn.execute(
        "SELECT decision_state FROM task_plan_revisions WHERE plan_id = ?", (plan_id,)
    ).fetchone()[0] == "APPROVED"
    with pytest.raises(sqlite3.IntegrityError, match="plan revisions cannot be deleted"):
        conn.execute(
            "DELETE FROM task_plan_revisions WHERE plan_id = ? AND revision = 1", (plan_id,)
        )
    conn.close()

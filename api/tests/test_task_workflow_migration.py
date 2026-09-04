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
            (3, "Ambiguous doing", None, None, None, "unsupported", None, "doing", None, None, "ambiguous", "2026-08-03T02:00:00+00:00", None),
            (4, "Returned task", "returned description", "returned rationale", "returned outcome", "gbp", None, "doing", "returned evidence", None, "returned", "2026-08-03T03:00:00+00:00", None),
            (5, "Failed task", "failed description", "failed rationale", "failed outcome", "technical", None, "doing", "failed evidence", None, "failed", "2026-08-03T04:00:00+00:00", None),
            (10, "Approved running", "running description", "running rationale", "running outcome", "citation", "2026-08-10T00:00:00-04:00", "doing", "running evidence", 10, "running", "2026-08-05T00:00:00+00:00", None),
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


def _legacy_failure_snapshot(conn):
    return {
        "merchants": conn.execute("SELECT * FROM merchants ORDER BY id").fetchall(),
        "runs": conn.execute("SELECT * FROM runs ORDER BY id").fetchall(),
        "tasks": conn.execute("SELECT * FROM tasks ORDER BY id").fetchall(),
        "task_executions": conn.execute(
            "SELECT * FROM task_executions ORDER BY id"
        ).fetchall(),
        "sqlite_sequence": conn.execute(
            "SELECT * FROM sqlite_sequence ORDER BY name"
        ).fetchall(),
        "sqlite_master": conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE type IN ('table','index','trigger') "
            "AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name"
        ).fetchall(),
    }


WORKFLOW_TABLES = (
    "schema_migrations",
    "task_plans",
    "task_plan_revisions",
    "tasks",
    "task_dependencies",
    "task_executions",
    "task_events",
)


def _workflow_schema_shape(conn):
    def columns(table):
        return [tuple(row[1:]) for row in conn.execute(f"PRAGMA table_info({table})")]

    def foreign_keys(table):
        return sorted(
            tuple(row[2:]) for row in conn.execute(f"PRAGMA foreign_key_list({table})")
        )

    def indexes(table):
        result = []
        for row in conn.execute(f"PRAGMA index_list({table})"):
            name = row[1]
            if name.startswith("sqlite_autoindex_"):
                continue
            result.append(
                (
                    name,
                    row[2],
                    row[3],
                    row[4],
                    tuple(
                        index_row[2]
                        for index_row in conn.execute(f'PRAGMA index_info("{name}")')
                    ),
                )
            )
        return sorted(result)

    triggers = sorted(
        (row[0], " ".join(row[1].split()))
        for row in conn.execute(
            "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' "
            "AND tbl_name IN ('tasks','task_plan_revisions','task_events')"
        )
    )
    return {
        "tables": {
            table: {
                "columns": columns(table),
                "foreign_keys": foreign_keys(table),
                "indexes": indexes(table),
            }
            for table in WORKFLOW_TABLES
        },
        "triggers": triggers,
    }


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
    assert executions[99]["reviewed_at"] == "2026-08-07T00:00:00+00:00"
    assert executions[102]["reviewed_at"] == "2026-08-07T05:00:00+00:00"

    normalized = conn.execute("SELECT * FROM tasks WHERE source_key = 'ambiguous'").fetchone()
    normalized_item = {
        "depends_on": [],
        "expected_outcome": "A reviewable migrated task result",
        "key": "ambiguous",
        "parameters": {"category": None, "description": None},
        "rationale": "Migrated legacy task: Ambiguous doing",
        "scheduled_start": None,
        "task_type": "PREPARE_ONLY",
        "title": "Ambiguous doing",
    }
    normalized_revision = conn.execute(
        "SELECT r.payload_json, r.checksum FROM task_plan_revisions r "
        "JOIN task_plans p ON p.id = r.plan_id WHERE p.source_run_id IS NULL "
        "AND json_extract(r.payload_json, '$.tasks[0].key') = 'ambiguous'"
    ).fetchone()
    normalized_payload = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [normalized_item],
    }
    normalized_payload_json = json.dumps(
        normalized_payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    normalized_json = json.dumps(
        normalized_item, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    assert normalized_revision["payload_json"] == normalized_payload_json
    assert normalized_revision["checksum"] == hashlib.sha256(
        normalized_payload_json.encode()
    ).hexdigest()
    assert normalized["task_key"] == normalized_item["key"]
    assert normalized["task_type"] == normalized_item["task_type"]
    assert normalized["title"] == normalized_item["title"]
    assert normalized["rationale"] == normalized_item["rationale"]
    assert normalized["expected_outcome"] == normalized_item["expected_outcome"]
    assert normalized["scheduled_start"] == normalized_item["scheduled_start"]
    assert normalized["description"] == normalized_item["parameters"]["description"]
    assert normalized["category"] == normalized_item["parameters"]["category"]
    assert normalized["parameters_json"] == '{"category":null,"description":null}'
    assert normalized["definition_checksum"] == hashlib.sha256(
        normalized_json.encode()
    ).hexdigest()

    manual = conn.execute("SELECT * FROM tasks WHERE source_key = 'manual-todo'").fetchone()
    assert (manual["description"], manual["rationale"], manual["expected_outcome"]) == (
        "todo description",
        "todo rationale",
        "todo outcome",
    )
    assert manual["evidence_note"] == "todo evidence"
    assert manual["workflow_version"] == 1
    assert len(manual["definition_checksum"]) == 64
    conn.execute("UPDATE tasks SET status = 'EXECUTING' WHERE id = ?", (manual["id"],))
    conn.execute("UPDATE tasks SET status = 'VERIFYING' WHERE id = ?", (manual["id"],))
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def _seed_interim_formal_graph(conn):
    conn.execute(
        "INSERT INTO schema_migrations (name, applied_at) "
        "VALUES ('task_workflow_v1', '2026-09-03T00:00:00+00:00')"
    )
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) "
        "VALUES (1, 'Interim Merchant', '2026-09-03T00:00:00+00:00')"
    )
    plan_id = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, state, latest_revision, approved_revision, created_at) "
        "VALUES (1, 'OPERATOR', 'OPEN', 1, 1, '2026-09-03T00:00:00+00:00')"
    ).lastrowid
    payload = '{"schema_version":"seo_ops.task_plan.v1","tasks":[]}'
    checksum = hashlib.sha256(payload.encode()).hexdigest()
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, "
        "source, created_by, created_at, decided_by, decided_at) "
        "VALUES (?, 1, 'APPROVED', 'seo_ops.task_plan.v1', ?, ?, 'OPERATOR', "
        "'operator-1', '2026-09-03T00:00:00+00:00', 'operator-1', "
        "'2026-09-03T00:00:00+00:00')",
        (plan_id, payload, checksum),
    )
    definition_checksum = hashlib.sha256(b"{}").hexdigest()
    conn.execute(
        "INSERT INTO tasks "
        "(id, merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, "
        "parameters_json, definition_checksum, title, status, version, created_at) "
        "VALUES (41, 1, ?, 1, 'interim-source', 'PREPARE_ONLY', 1, '{}', ?, "
        "'Interim Source', 'NEEDS_ATTENTION', 7, '2026-09-03T00:00:00+00:00')",
        (plan_id, definition_checksum),
    )
    conn.execute(
        "INSERT INTO tasks "
        "(id, merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, "
        "parameters_json, definition_checksum, title, status, version, replaces_task_id, "
        "created_at) VALUES (42, 1, ?, 1, 'interim-replacement', 'PREPARE_ONLY', 1, "
        "'{}', ?, 'Interim Replacement', 'PENDING', 3, 41, "
        "'2026-09-03T00:01:00+00:00')",
        (plan_id, definition_checksum),
    )
    conn.execute("UPDATE tasks SET replaced_by_task_id = 42 WHERE id = 41")
    conn.execute(
        "INSERT INTO task_dependencies (id, task_id, depends_on_task_id) "
        "VALUES (71, 42, 41)"
    )
    request_json = '{"task_id":41}'
    conn.execute(
        "INSERT INTO task_executions "
        "(id, task_id, stage, status, attempt, request_json, request_checksum, "
        "idempotency_key, evidence_json, error, created_at, finished_at) "
        "VALUES (81, 41, 'PREPARATION', 'FAILED', 1, ?, ?, "
        "'interim:41:preparation:1', '[\"preserved evidence\"]', "
        "'preserved error', '2026-09-03T00:02:00+00:00', "
        "'2026-09-03T00:03:00+00:00')",
        (request_json, hashlib.sha256(request_json.encode()).hexdigest()),
    )
    return {"source_id": 41, "replacement_id": 42, "dependency_id": 71, "execution_id": 81}


def _v2_data_snapshot(conn):
    return {
        "tasks": conn.execute("SELECT * FROM tasks ORDER BY id").fetchall(),
        "task_dependencies": conn.execute(
            "SELECT * FROM task_dependencies ORDER BY id"
        ).fetchall(),
        "task_executions": conn.execute(
            "SELECT * FROM task_executions ORDER BY id"
        ).fetchall(),
    }


def _v2_failure_snapshot(conn):
    return {
        **_v2_data_snapshot(conn),
        "markers": conn.execute(
            "SELECT * FROM schema_migrations ORDER BY name"
        ).fetchall(),
        "sqlite_sequence": conn.execute(
            "SELECT * FROM sqlite_sequence ORDER BY name"
        ).fetchall(),
        "sqlite_master": conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE type IN ('table','index','trigger') "
            "AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY type, name"
        ).fetchall(),
    }


def test_v1_formal_database_is_atomically_upgraded_to_all_frozen_states(
    tmp_path, monkeypatch
):
    from app import task_migrations
    from app.db import SCHEMA_PATH

    path = tmp_path / "interim-v1.db"
    schema = SCHEMA_PATH.read_text().replace(
        "('PENDING','PREPARING','AWAITING_APPROVAL','EXECUTING','VERIFYING',"
        "'NEEDS_ATTENTION','DONE','CANCELLED')",
        "('PENDING','PREPARING','AWAITING_APPROVAL','NEEDS_ATTENTION','DONE','CANCELLED')",
    )
    conn = sqlite3.connect(path)
    conn.executescript(schema)
    ids = _seed_interim_formal_graph(conn)
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    before = _v2_data_snapshot(conn)

    task_migrations.migrate_task_workflow_v1(conn)
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    assert all(
        f"'{state}'" in task_sql
        for state in (
            "PENDING",
            "PREPARING",
            "AWAITING_APPROVAL",
            "EXECUTING",
            "VERIFYING",
            "NEEDS_ATTENTION",
            "DONE",
            "CANCELLED",
        )
    )
    assert _v2_data_snapshot(conn) == before
    assert conn.execute(
        "SELECT id, replaces_task_id, replaced_by_task_id FROM tasks ORDER BY id"
    ).fetchall() == [
        (ids["source_id"], None, ids["replacement_id"]),
        (ids["replacement_id"], ids["source_id"], None),
    ]
    assert conn.execute(
        "SELECT id, task_id, depends_on_task_id FROM task_dependencies"
    ).fetchall() == [(ids["dependency_id"], ids["replacement_id"], ids["source_id"])]
    assert conn.execute(
        "SELECT id, task_id, evidence_json, error FROM task_executions"
    ).fetchall() == [
        (ids["execution_id"], ids["source_id"], '["preserved evidence"]', "preserved error")
    ]
    assert conn.execute(
        "SELECT COUNT(*) FROM schema_migrations "
        "WHERE name = 'task_workflow_states_v2'"
    ).fetchone()[0] == 1
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    with pytest.raises(sqlite3.IntegrityError, match="formal tasks cannot be deleted"):
        conn.execute("DELETE FROM tasks WHERE id = ?", (ids["source_id"],))

    task_migrations.migrate_task_workflow_v1(conn)
    assert conn.execute(
        "SELECT COUNT(*) FROM schema_migrations "
        "WHERE name = 'task_workflow_states_v2'"
    ).fetchone()[0] == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM tasks WHERE id IN (?, ?)",
        (ids["source_id"], ids["replacement_id"]),
    ).fetchone()[0] == 2
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()


def test_states_v2_rebuild_failure_restores_interim_schema(tmp_path, monkeypatch):
    from app import task_migrations
    from app.db import SCHEMA_PATH

    path = tmp_path / "interim-v1-failure.db"
    schema = SCHEMA_PATH.read_text().replace(
        "('PENDING','PREPARING','AWAITING_APPROVAL','EXECUTING','VERIFYING',"
        "'NEEDS_ATTENTION','DONE','CANCELLED')",
        "('PENDING','PREPARING','AWAITING_APPROVAL','NEEDS_ATTENTION','DONE','CANCELLED')",
    )
    conn = sqlite3.connect(path)
    conn.executescript(schema)
    _seed_interim_formal_graph(conn)
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")
    before = _v2_failure_snapshot(conn)

    def fail_after_swap(_conn):
        raise RuntimeError("injected states v2 failure")

    monkeypatch.setattr(
        task_migrations, "_create_task_workflow_indexes_and_triggers", fail_after_swap
    )
    with pytest.raises(RuntimeError, match="injected states v2 failure"):
        task_migrations.migrate_task_workflow_v1(conn)

    assert _v2_failure_snapshot(conn) == before
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    conn.close()


def test_migrated_plain_text_execution_is_readable_but_never_reviewable_or_retryable(
    legacy_task_db, monkeypatch
):
    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    monkeypatch.setenv("SEO_OPS_AUTH_USERNAME", "test")
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", "seo-ops-test")
    monkeypatch.setenv("SEO_OPS_AUTH_SECRET", "test-secret-that-is-at-least-32-chars")
    monkeypatch.setenv("SEO_OPS_COOKIE_SECURE", "false")
    from app.db import init_db

    init_db()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        assert client.post(
            "/api/auth/login",
            json={"username": "test", "password": "seo-ops-test"},
        ).status_code == 200

        ready = client.get("/api/tasks/11")
        assert ready.status_code == 200
        ready_detail = ready.json()
        ready_execution = ready_detail["executions"][-1]
        assert ready_execution["result"] is None
        assert ready_execution["result_checksum"] is None
        assert ready_execution["legacy_result"] == {
            "unverified": True,
            "output_text": "ready output",
        }
        refused_review = client.post(
            "/api/tasks/11/approve-execution",
            json={
                "expected_version": ready_detail["version"],
                "expected_execution_id": ready_execution["id"],
                "expected_result_checksum": "0" * 64,
            },
        )
        assert refused_review.status_code == 409

        returned = client.get("/api/tasks/4").json()
        assert returned["executions"][-1]["legacy_result"] == {
            "unverified": True,
            "output_text": "returned output",
        }
        refused_retry = client.post(
            "/api/tasks/4/retry-preparation",
            json={"expected_version": returned["version"], "reason": "retry"},
        )
        assert refused_retry.status_code == 409


def test_migrated_json_shaped_text_is_legacy_and_never_retryable(
    legacy_task_db, monkeypatch
):
    raw_output = '{"external_write_performed":false}'
    conn = sqlite3.connect(legacy_task_db)
    conn.execute(
        "INSERT INTO tasks "
        "(id, merchant_id, title, status, source_key, created_at) "
        "VALUES (12, 1, 'JSON-shaped legacy output', 'doing', 'json-shaped', "
        "'2026-08-08T00:00:00+00:00')"
    )
    conn.execute(
        "INSERT INTO task_executions "
        "(id, task_id, coreai_run_id, status, attempt, output_text, error, created_at, "
        "finished_at) VALUES (106, 12, 'legacy-json-run', 'failed', 1, ?, "
        "'legacy failure', '2026-08-08T01:00:00+00:00', "
        "'2026-08-08T02:00:00+00:00')",
        (raw_output,),
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    monkeypatch.setenv("SEO_OPS_AUTH_USERNAME", "test")
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", "seo-ops-test")
    monkeypatch.setenv("SEO_OPS_AUTH_SECRET", "test-secret-that-is-at-least-32-chars")
    monkeypatch.setenv("SEO_OPS_COOKIE_SECURE", "false")
    from app.db import init_db

    init_db()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as client:
        assert client.post(
            "/api/auth/login",
            json={"username": "test", "password": "seo-ops-test"},
        ).status_code == 200
        detail = client.get("/api/tasks/12").json()
        assert detail["status"] == "NEEDS_ATTENTION"
        assert detail["executions"][-1]["result"] is None
        assert detail["executions"][-1]["legacy_result"] == {
            "unverified": True,
            "output_text": raw_output,
        }
        before = (
            detail["status"],
            detail["version"],
            len(detail["events"]),
        )

        response = client.post(
            "/api/tasks/12/retry-preparation",
            json={"expected_version": detail["version"], "reason": "retry"},
        )

        assert response.status_code == 409
        reread = client.get("/api/tasks/12").json()
        assert (reread["status"], reread["version"], len(reread["events"])) == before


def test_valid_aware_and_null_scheduled_starts_survive_migration_exactly(
    legacy_task_db, monkeypatch
):
    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    from app.db import init_db

    init_db()

    conn = sqlite3.connect(legacy_task_db)
    conn.row_factory = sqlite3.Row
    migrated = {
        row["source_key"]: row["scheduled_start"]
        for row in conn.execute(
            "SELECT source_key, scheduled_start FROM tasks "
            "WHERE source_key IN ('running', 'ambiguous')"
        )
    }
    run_payload = json.loads(
        conn.execute(
            "SELECT r.payload_json FROM task_plan_revisions r "
            "JOIN task_plans p ON p.id = r.plan_id WHERE p.source_run_id = 10"
        ).fetchone()[0]
    )
    run_schedule = {
        item["key"]: item["scheduled_start"] for item in run_payload["tasks"]
    }
    execution_ids = [
        row[0]
        for row in conn.execute("SELECT id FROM task_executions ORDER BY id").fetchall()
    ]
    conn.close()

    assert migrated == {
        "ambiguous": None,
        "running": "2026-08-10T00:00:00-04:00",
    }
    assert run_schedule == {
        "ready": None,
        "running": "2026-08-10T00:00:00-04:00",
    }
    assert execution_ids == [99, 100, 101, 102, 103]


@pytest.mark.parametrize(
    "scheduled_start",
    [
        pytest.param("not-an-instant", id="malformed"),
        pytest.param("2026-08-11T00:00:00", id="timezone-naive"),
    ],
)
def test_invalid_non_null_scheduled_start_aborts_without_normalizing_source_to_null(
    tmp_path, monkeypatch, scheduled_start
):
    path = tmp_path / "invalid-scheduled-start.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE tasks SET scheduled_start = ? WHERE id = 3", (scheduled_start,)
    )
    conn.commit()
    before = _legacy_failure_snapshot(conn)
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(RuntimeError, match="scheduled_start"):
        init_db()

    conn = sqlite3.connect(path)
    assert _legacy_failure_snapshot(conn) == before
    assert conn.execute(
        "SELECT scheduled_start FROM tasks WHERE id = 3"
    ).fetchone()[0] == scheduled_start
    conn.close()


def test_mixed_merchant_run_group_aborts_without_cross_merchant_plan(
    tmp_path, monkeypatch
):
    path = tmp_path / "mixed-merchant-run.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) "
        "VALUES (2, 'Other Merchant', '2026-08-01T00:00:00+00:00')"
    )
    conn.execute("UPDATE tasks SET merchant_id = 2 WHERE id = 11")
    conn.commit()
    before = _legacy_failure_snapshot(conn)
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(RuntimeError, match="run 10.*merchant"):
        init_db()

    conn = sqlite3.connect(path)
    assert _legacy_failure_snapshot(conn) == before
    assert conn.execute(
        "SELECT id, merchant_id FROM tasks WHERE source_run_id = 10 ORDER BY id"
    ).fetchall() == [(10, 1), (11, 2)]
    conn.close()


@pytest.mark.parametrize(
    "duplicate_scope",
    ["runs", "task_executions", "cross_table"],
)
def test_legacy_upgrade_rejects_preexisting_duplicate_coreai_run_bindings(
    tmp_path, monkeypatch, duplicate_scope
):
    path = tmp_path / f"duplicate-coreai-{duplicate_scope}.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    if duplicate_scope == "runs":
        conn.execute(
            "INSERT INTO runs "
            "(id, merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at) "
            "VALUES (30, 1, 'approved-core-run', 'succeeded', 'manual', "
            "'2026-08-08T00:00:00+00:00', '2026-08-08T01:00:00+00:00')"
        )
    elif duplicate_scope == "task_executions":
        conn.execute(
            "INSERT INTO task_executions "
            "(id, task_id, coreai_run_id, status, attempt, created_at, finished_at) "
            "VALUES (104, 1, 'exec-approved', 'failed', 1, "
            "'2026-08-08T00:00:00+00:00', '2026-08-08T01:00:00+00:00')"
        )
    else:
        conn.execute(
            "UPDATE task_executions SET coreai_run_id = 'approved-core-run' "
            "WHERE id = 103"
        )
    conn.commit()
    before = _legacy_failure_snapshot(conn)
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(RuntimeError, match="duplicate coreai_run_id bindings"):
        init_db()

    conn = sqlite3.connect(path)
    assert _legacy_failure_snapshot(conn) == before
    conn.close()


def test_orphan_execution_aborts_before_swap_when_foreign_keys_were_disabled(
    tmp_path, monkeypatch
):
    path = tmp_path / "orphan-execution.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 0
    conn.execute(
        "INSERT INTO task_executions "
        "(id, task_id, coreai_run_id, status, attempt, created_at) "
        "VALUES (107, 999, 'orphan-run', 'failed', 1, "
        "'2026-08-08T00:00:00+00:00')"
    )
    conn.commit()
    before = _legacy_failure_snapshot(conn)
    source_execution_ids = [
        row[0]
        for row in conn.execute("SELECT id FROM task_executions ORDER BY id").fetchall()
    ]
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(RuntimeError, match="execution.*missing task 999"):
        init_db()

    conn = sqlite3.connect(path)
    assert _legacy_failure_snapshot(conn) == before
    assert [
        row[0]
        for row in conn.execute("SELECT id FROM task_executions ORDER BY id").fetchall()
    ] == source_execution_ids
    assert conn.execute("SELECT COUNT(*) FROM task_executions").fetchone()[0] == len(
        source_execution_ids
    )
    conn.close()


def test_execution_copy_id_or_count_mismatch_aborts_before_source_swap(
    legacy_task_db, monkeypatch
):
    from app import task_migrations

    conn = sqlite3.connect(legacy_task_db)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    before = _legacy_failure_snapshot(conn)
    original_materialize = task_migrations._materialize_execution

    def omit_one_execution(target, execution):
        if execution["id"] != 101:
            original_materialize(target, execution)

    monkeypatch.setattr(
        task_migrations, "_materialize_execution", omit_one_execution
    )

    with pytest.raises(RuntimeError, match="preserve exact IDs and count"):
        task_migrations.migrate_task_workflow_v1(conn)

    assert _legacy_failure_snapshot(conn) == before
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
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


def test_duplicate_active_legacy_executions_roll_back_after_swap(tmp_path, monkeypatch):
    path = tmp_path / "duplicate-active.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO task_executions "
        "(id, task_id, coreai_run_id, status, attempt, output_text, error, review_note, created_at, finished_at, reviewed_at) "
        "VALUES (105, 10, 'exec-running-2', 'running', 2, NULL, NULL, NULL, "
        "'2026-08-07T00:30:00+00:00', NULL, NULL)"
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db

    with pytest.raises(sqlite3.IntegrityError, match="UNIQUE constraint failed"):
        init_db()

    conn = sqlite3.connect(path)
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    assert "'todo','doing','done','cancelled'" in task_sql
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == 9
    assert conn.execute("SELECT COUNT(*) FROM task_executions").fetchone()[0] == 6
    assert (
        conn.execute("SELECT status FROM task_executions WHERE id = 105").fetchone()[0]
        == "running"
    )
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'task_plans'"
    ).fetchone()[0] == 0
    conn.close()


@pytest.mark.parametrize(
    ("invalid_kind", "expected_code"),
    [
        pytest.param("unsupported_type", "task_type_disabled", id="unsupported-type"),
        pytest.param("oversized_description", "parameters", id="oversized-description"),
        pytest.param("too_many_tasks", "task_count", id="more-than-50-tasks"),
    ],
)
def test_invalid_legacy_plan_fails_closed_without_mutation(
    tmp_path, monkeypatch, invalid_kind, expected_code
):
    path = tmp_path / f"invalid-{invalid_kind}.db"
    _seed_legacy_database(path)
    conn = sqlite3.connect(path)
    if invalid_kind == "unsupported_type":
        conn.execute("ALTER TABLE tasks ADD COLUMN task_type TEXT")
        conn.execute("UPDATE tasks SET task_type = 'PREPARE_ONLY'")
        conn.execute("UPDATE tasks SET task_type = 'GBP_POST' WHERE id = 10")
    elif invalid_kind == "oversized_description":
        conn.execute("UPDATE tasks SET description = ? WHERE id = 10", ("x" * 4001,))
    else:
        conn.executemany(
            "INSERT INTO tasks "
            "(id, merchant_id, title, description, rationale, expected_outcome, category, scheduled_start, "
            "status, evidence_note, source_run_id, source_key, created_at, completed_at) "
            "VALUES (?, 1, ?, 'description', 'rationale', 'outcome', 'content', NULL, "
            "'todo', NULL, 10, ?, '2026-08-05T02:00:00+00:00', NULL)",
            [(task_id, f"Extra {task_id}", f"extra-{task_id}") for task_id in range(30, 79)],
        )
    conn.commit()
    original_task_count = conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.task_plan_contract import TaskPlanValidationError

    with pytest.raises(TaskPlanValidationError) as exc:
        init_db()
    assert expected_code in exc.value.codes

    conn = sqlite3.connect(path)
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    assert "'todo','doing','done','cancelled'" in task_sql
    assert conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0] == original_task_count
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
    ).fetchone()[0] == 0
    conn.close()


def test_fresh_and_migrated_workflow_schema_are_equivalent(tmp_path, monkeypatch):
    legacy_path = tmp_path / "legacy.db"
    fresh_path = tmp_path / "fresh.db"
    _seed_legacy_database(legacy_path)
    from app.db import init_db

    monkeypatch.setenv("SEO_OPS_DB", str(legacy_path))
    init_db()
    monkeypatch.setenv("SEO_OPS_DB", str(fresh_path))
    init_db()

    legacy = sqlite3.connect(legacy_path)
    fresh = sqlite3.connect(fresh_path)
    legacy_shape = _workflow_schema_shape(legacy)
    fresh_shape = _workflow_schema_shape(fresh)
    execution_columns = {
        row[1] for row in legacy.execute("PRAGMA table_info(task_executions)")
    }
    assert "reviewed_at" in execution_columns
    assert legacy_shape == fresh_shape
    assert legacy.execute("PRAGMA foreign_key_check").fetchall() == []
    assert fresh.execute("PRAGMA foreign_key_check").fetchall() == []
    legacy.close()
    fresh.close()


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

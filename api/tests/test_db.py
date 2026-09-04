import sqlite3

import pytest


def _insert_task_execution(conn, task_id: int, coreai_run_id: str, suffix: str) -> None:
    conn.execute(
        "INSERT INTO task_executions "
        "(task_id, stage, status, attempt, request_json, request_checksum, "
        "idempotency_key, coreai_run_id, evidence_json, created_at, finished_at) "
        "VALUES (?, 'PREPARATION', 'FAILED', 1, '{}', ?, ?, ?, '[]', ?, ?)",
        (
            task_id,
            "a" * 64,
            f"db-binding-{suffix}",
            coreai_run_id,
            "2026-09-04T00:00:00+00:00",
            "2026-09-04T00:01:00+00:00",
        ),
    )


def _operator_task(client, merchant_id: int) -> dict:
    response = client.post(
        f"/api/merchants/{merchant_id}/tasks",
        json={
            "task_type": "PREPARE_ONLY",
            "title": "Check binding",
            "rationale": "The Core AI identity must remain unique",
            "expected_outcome": "One local owner for one upstream run",
            "parameters": {"description": "Read-only check"},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_coreai_run_id_cannot_be_reused_from_run_history_across_merchants(client):
    from app.db import connect

    first = client.post("/api/merchants", json={"name": "First owner"}).json()
    second = client.post("/api/merchants", json={"name": "Second owner"}).json()
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs "
            "(merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at) "
            "VALUES (?, 'reused-upstream-run', 'succeeded', 'manual', ?, ?)",
            (
                first["id"],
                "2026-09-04T00:00:00+00:00",
                "2026-09-04T00:01:00+00:00",
            ),
        )
        with pytest.raises(sqlite3.IntegrityError, match="core-ai run id already bound"):
            conn.execute(
                "INSERT INTO runs "
                "(merchant_id, coreai_run_id, status, trigger_kind, created_at) "
                "VALUES (?, 'reused-upstream-run', 'running', 'manual', ?)",
                (second["id"], "2026-09-04T00:02:00+00:00"),
            )
    finally:
        conn.close()


def test_coreai_run_id_cannot_cross_from_run_history_to_task_execution(client):
    from app.db import connect

    first = client.post("/api/merchants", json={"name": "Run owner"}).json()
    second = client.post("/api/merchants", json={"name": "Task owner"}).json()
    task = _operator_task(client, second["id"])
    conn = connect()
    try:
        conn.execute(
            "INSERT INTO runs "
            "(merchant_id, coreai_run_id, status, trigger_kind, created_at, finished_at) "
            "VALUES (?, 'cross-table-run', 'succeeded', 'manual', ?, ?)",
            (
                first["id"],
                "2026-09-04T00:00:00+00:00",
                "2026-09-04T00:01:00+00:00",
            ),
        )
        with pytest.raises(sqlite3.IntegrityError, match="core-ai run id already bound"):
            _insert_task_execution(conn, task["id"], "cross-table-run", "cross-table")
    finally:
        conn.close()


def test_task_execution_coreai_run_id_cannot_be_reused_from_history_across_merchants(
    client,
):
    from app.db import connect

    first = client.post("/api/merchants", json={"name": "First task owner"}).json()
    second = client.post("/api/merchants", json={"name": "Second task owner"}).json()
    first_task = _operator_task(client, first["id"])
    second_task = _operator_task(client, second["id"])
    conn = connect()
    try:
        _insert_task_execution(conn, first_task["id"], "task-history-run", "first")
        with pytest.raises(sqlite3.IntegrityError, match="core-ai run id already bound"):
            _insert_task_execution(
                conn, second_task["id"], "task-history-run", "second"
            )
    finally:
        conn.close()


def test_init_db_creates_tables(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "t.db"))
    from app.db import init_db

    init_db()
    init_db()  # 幂等
    conn = sqlite3.connect(tmp_path / "t.db")
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    task_cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    execution_cols = {r[1] for r in conn.execute("PRAGMA table_info(task_executions)")}
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    marker = conn.execute(
        "SELECT COUNT(*) FROM schema_migrations WHERE name = 'task_workflow_v1'"
    ).fetchone()[0]
    states_marker = conn.execute(
        "SELECT COUNT(*) FROM schema_migrations WHERE name = 'task_workflow_states_v2'"
    ).fetchone()[0]
    foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
    conn.close()
    assert {
        "merchants",
        "task_plans",
        "task_plan_revisions",
        "tasks",
        "task_dependencies",
        "task_executions",
        "task_events",
        "schema_migrations",
    } <= names
    assert {
        "plan_id",
        "plan_revision",
        "task_key",
        "task_type",
        "workflow_version",
        "parameters_json",
        "definition_checksum",
        "version",
        "assignee",
        "labels_json",
        "operator_note",
        "replaces_task_id",
        "replaced_by_task_id",
    } <= task_cols
    assert {
        "stage",
        "request_json",
        "request_checksum",
        "idempotency_key",
        "dispatch_token",
        "provider_resource_id",
        "result_json",
        "evidence_json",
        "next_attempt_at",
        "reviewed_at",
    } <= execution_cols
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
    assert marker == 1
    assert states_marker == 1
    assert foreign_key_errors == []


def test_migration_adds_columns_and_runs_table(tmp_path, monkeypatch):
    """老库（第一块砖 schema）跑 init_db 后应获得新列和 runs 表。"""
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "old.db"))
    old_schema = """
    CREATE TABLE merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      merchant_id INTEGER NOT NULL REFERENCES merchants(id),
      title TEXT NOT NULL,
      description TEXT,
      rationale TEXT,
      status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
      evidence_note TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    """
    conn = sqlite3.connect(tmp_path / "old.db")
    conn.executescript(old_schema)
    conn.commit()
    conn.close()

    from app.db import init_db

    init_db()
    init_db()  # 幂等
    conn = sqlite3.connect(tmp_path / "old.db")
    merchant_cols = {r[1] for r in conn.execute("PRAGMA table_info(merchants)")}
    task_cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    conn.close()
    assert "auto_run_interval_days" in merchant_cols
    assert {
        "source_run_id",
        "source_key",
        "expected_outcome",
        "scheduled_start",
        "plan_id",
        "task_key",
        "workflow_version",
    } <= task_cols
    assert "runs" in tables
    assert "idx_tasks_source_key" in indexes


def test_fresh_schema_enforces_task_workflow_constraints(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "constraints.db"))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(tmp_path / "constraints.db")
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) VALUES (1, 'M', '2026-09-03T00:00:00+00:00')"
    )
    plan_id = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, state, latest_revision, created_at) "
        "VALUES (1, 'OPERATOR', 'OPEN', 1, '2026-09-03T00:00:00+00:00')"
    ).lastrowid
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, created_by, created_at) "
        "VALUES (?, 1, 'APPROVED', 'seo_ops.task_plan.v1', '{}', ?, 'OPERATOR', 'operator', '2026-09-03T00:00:00+00:00')",
        (plan_id, "a" * 64),
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO tasks "
            "(merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, parameters_json, definition_checksum, title, status, created_at) "
            "VALUES (1, ?, 1, 'bad', 'PREPARE_ONLY', 1, '{}', ?, 'Bad', 'todo', '2026-09-03T00:00:00+00:00')",
            (plan_id, "b" * 64),
        )
    conn.close()

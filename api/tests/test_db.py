import hashlib
import json
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

    first = client.post(
        "/api/merchants",
        json={"name": "First owner", "primary_location": "New York, NY"},
    ).json()
    second = client.post(
        "/api/merchants",
        json={"name": "Second owner", "primary_location": "New York, NY"},
    ).json()
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

    first = client.post(
        "/api/merchants",
        json={"name": "Run owner", "primary_location": "New York, NY"},
    ).json()
    second = client.post(
        "/api/merchants",
        json={"name": "Task owner", "primary_location": "New York, NY"},
    ).json()
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

    first = client.post(
        "/api/merchants",
        json={"name": "First task owner", "primary_location": "New York, NY"},
    ).json()
    second = client.post(
        "/api/merchants",
        json={"name": "Second task owner", "primary_location": "New York, NY"},
    ).json()
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
    from app.db import connect

    conn = connect()
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    fbr_object = conn.execute(
        "SELECT type FROM sqlite_master WHERE name='merchant_fbr_links'"
    ).fetchone()[0]
    versions = [
        row[0]
        for row in conn.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
    ]
    task_cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    execution_cols = {r[1] for r in conn.execute("PRAGMA table_info(task_executions)")}
    task_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"
    ).fetchone()[0]
    marker = conn.execute(
        "SELECT COUNT(*) FROM schema_migrations WHERE version = '0002_task_workflows'"
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
    assert foreign_key_errors == []
    assert fbr_object == "view"
    assert versions == [
        "0001_performance_history",
        "0002_task_workflows",
        "0003_performance_lifecycle_baseline",
        "0004_run_dispatch_contract",
        "0005_task_assignments",
    ]


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


def test_agent_workbench_schema_smoke_on_fresh_database(tmp_path, monkeypatch):
    database = tmp_path / "workbench-smoke.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(database)
    conn.execute("PRAGMA foreign_keys = ON")
    names = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert {
        "seo_ops_agents",
        "seo_ops_agent_runs",
        "seo_ops_agent_sync_state",
    } <= names

    indexes = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
    }
    assert {
        "ux_seo_ops_agents_current_key",
        "idx_seo_ops_agents_next_verification_at",
        "idx_seo_ops_agents_metadata_lease_until",
        "idx_seo_ops_agent_runs_agent_effective_history",
        "idx_seo_ops_agent_runs_raw_status",
        "idx_seo_ops_agent_runs_source",
        "idx_seo_ops_agent_sync_next_discovery_at",
        "idx_seo_ops_agent_sync_next_fast_poll_at",
        "idx_seo_ops_agent_sync_lease_until",
        "idx_runs_coreai_run_id",
        "idx_task_executions_coreai_run_id",
    } <= indexes

    agent_sql = (
        "INSERT INTO seo_ops_agents "
        "(id, agent_key, coreai_agent_id, display_name, role, status, created_at, updated_at) "
        "VALUES (NULL, ?, ?, 'Agent', 'Role', 'active', ?, ?)"
    )
    for suffix in ("first", "repeated"):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(agent_sql, (suffix, f"core-{suffix}", "2026-09-06", "2026-09-06"))

    conn.execute(
        "INSERT INTO seo_ops_agents "
        "(id, agent_key, coreai_agent_id, display_name, role, status, created_at, updated_at) "
        "VALUES ('agent-1', 'agent', 'core-agent', 'Agent', 'Role', 'active', ?, ?)",
        ("2026-09-06", "2026-09-06"),
    )
    for _ in range(2):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO seo_ops_agent_runs "
                "(coreai_run_id, seo_ops_agent_id, raw_status, first_seen_at) "
                "VALUES (NULL, 'agent-1', 'PENDING', '2026-09-06T00:00:00+00:00')"
            )
    for _ in range(2):
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO seo_ops_agent_sync_state (seo_ops_agent_id) VALUES (NULL)"
            )
    conn.close()


def _workbench_conn(tmp_path, monkeypatch, filename: str) -> sqlite3.Connection:
    database = tmp_path / filename
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(database)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _insert_agent(conn, suffix: str, **overrides):
    values = {
        "id": f"agent-{suffix}",
        "agent_key": f"key-{suffix}",
        "coreai_agent_id": f"core-{suffix}",
        "display_name": "Agent",
        "role": "Role",
        "sort_order": 0,
        "status": "active",
        "coreai_timeout_hint_seconds": None,
        "suspect_after_seconds": 1800,
        "retired_at": None,
        "created_at": "2026-09-06T00:00:00+00:00",
        "updated_at": "2026-09-06T00:00:00+00:00",
    }
    values.update(overrides)
    columns = ", ".join(values)
    placeholders = ", ".join("?" for _ in values)
    return conn.execute(
        f"INSERT INTO seo_ops_agents ({columns}) VALUES ({placeholders})",
        tuple(values.values()),
    )


def _insert_run(conn, suffix: str, **overrides):
    values = {
        "coreai_run_id": f"run-{suffix}",
        "seo_ops_agent_id": "agent-base",
        "raw_status": "RUNNING",
        "first_seen_at": "2026-09-06T00:00:00+00:00",
    }
    values.update(overrides)
    columns = ", ".join(values)
    placeholders = ", ".join("?" for _ in values)
    return conn.execute(
        f"INSERT INTO seo_ops_agent_runs ({columns}) VALUES ({placeholders})",
        tuple(values.values()),
    )


def _insert_sync(conn, suffix: str, **overrides):
    _insert_agent(conn, suffix)
    values = {"seo_ops_agent_id": f"agent-{suffix}"}
    values.update(overrides)
    columns = ", ".join(values)
    placeholders = ", ".join("?" for _ in values)
    return conn.execute(
        f"INSERT INTO seo_ops_agent_sync_state ({columns}) VALUES ({placeholders})",
        tuple(values.values()),
    )


def test_agent_registry_text_and_lifecycle_checks(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "registry-text.db")
    invalid = (
        ("blank-key", {"agent_key": " "}),
        ("long-key", {"agent_key": "k" * 81}),
        ("blank-name", {"display_name": " "}),
        ("long-name", {"display_name": "n" * 121}),
        ("blank-role", {"role": " "}),
        ("long-role", {"role": "r" * 241}),
        ("status", {"status": "unknown"}),
        ("active-retired-at", {"retired_at": "2026-09-06"}),
        ("retired-no-at", {"status": "retired"}),
    )
    for suffix, overrides in invalid:
        with pytest.raises(sqlite3.IntegrityError):
            _insert_agent(conn, suffix, **overrides)
    _insert_agent(
        conn,
        "retired-valid",
        status="retired",
        retired_at="2026-09-06T00:00:00+00:00",
    )
    conn.close()


def test_agent_registry_numeric_checks(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "registry-numeric.db")
    invalid = (
        ("sort-fraction", {"sort_order": 1.5}),
        ("sort-low", {"sort_order": -10001}),
        ("sort-high", {"sort_order": 10001}),
        ("suspect-fraction", {"suspect_after_seconds": 60.5}),
        ("suspect-low", {"suspect_after_seconds": 59}),
        ("suspect-high", {"suspect_after_seconds": 86401}),
        ("timeout-fraction", {"coreai_timeout_hint_seconds": 1.5}),
        ("timeout-zero", {"coreai_timeout_hint_seconds": 0}),
    )
    for suffix, overrides in invalid:
        with pytest.raises(sqlite3.IntegrityError):
            _insert_agent(conn, suffix, **overrides)
    _insert_agent(conn, "numeric-valid", coreai_timeout_hint_seconds=1)
    conn.close()


def test_agent_run_source_and_time_checks(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "run-source.db")
    _insert_agent(conn, "base")
    invalid = (
        ("bad-kind", {"source_kind": "task"}),
        ("source-zero", {"source_kind": "run", "source_local_id": 0}),
        ("source-negative", {"source_kind": "run", "source_local_id": -1}),
        ("source-fraction", {"source_kind": "run", "source_local_id": 1.5}),
        ("kind-only", {"source_kind": "run"}),
        ("id-only", {"source_local_id": 1}),
        ("bad-time", {"first_seen_at": "not-a-time"}),
    )
    for suffix, overrides in invalid:
        with pytest.raises(sqlite3.IntegrityError):
            _insert_run(conn, suffix, **overrides)
    _insert_run(
        conn,
        "source-valid",
        source_kind="run",
        source_local_id=1,
        first_seen_at="2026-09-06T08:00:00+08:00",
    )
    conn.close()


def test_agent_run_token_checks_reject_partial_fractional_and_negative(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "run-token.db")
    _insert_agent(conn, "base")
    invalid_pairs = (
        (None, 5),
        (5, None),
        (-1, 5),
        (5, -1),
        (1.5, 5),
        (5, 1.5),
    )
    for position, (input_tokens, output_tokens) in enumerate(invalid_pairs):
        with pytest.raises(sqlite3.IntegrityError):
            _insert_run(
                conn,
                f"tokens-{position}",
                input_tokens=input_tokens,
                output_tokens=output_tokens,
            )
    _insert_run(conn, "tokens-valid", input_tokens=0, output_tokens=5)
    conn.close()


def test_statusless_accepted_marker_is_nullable_but_narrow(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "run-statusless.db")
    _insert_agent(conn, "base")
    _insert_run(
        conn,
        "statusless-valid",
        raw_status=None,
        source_kind="run",
        source_local_id=1,
    )
    with pytest.raises(sqlite3.IntegrityError):
        _insert_run(conn, "blank-status", raw_status=" ")

    prohibited = (
        ("trigger_type", "manual"),
        ("started_at", "2026-09-06T00:00:00+00:00"),
        ("completed_at", "2026-09-06T00:00:00+00:00"),
        ("terminal_observed_at", "2026-09-06T00:00:00+00:00"),
        ("receipt_expires_at", "2026-09-06T00:00:00+00:00"),
        ("input_tokens", 1),
        ("output_tokens", 1),
        ("trace_id", "trace"),
        ("error_summary", "error"),
        ("last_poll_attempt_at", "2026-09-06T00:00:00+00:00"),
        ("last_synced_at", "2026-09-06T00:00:00+00:00"),
        ("last_poll_error", "error"),
    )
    for position, (column, value) in enumerate(prohibited):
        overrides = {
            "raw_status": None,
            "source_kind": "run",
            "source_local_id": 1,
            column: value,
        }
        if column == "input_tokens":
            overrides["output_tokens"] = 1
        if column == "output_tokens":
            overrides["input_tokens"] = 1
        with pytest.raises(sqlite3.IntegrityError):
            _insert_run(conn, f"prohibited-{position}", **overrides)
    conn.close()


def test_sync_integer_boolean_and_quality_checks(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "sync-checks.db")
    agent_columns = ("verification_failure_count", "metadata_lease_epoch")
    for position, column in enumerate(agent_columns):
        with pytest.raises(sqlite3.IntegrityError):
            _insert_agent(conn, f"agent-fraction-{position}", **{column: 1.5})
        with pytest.raises(sqlite3.IntegrityError):
            _insert_agent(conn, f"agent-negative-{position}", **{column: -1})

    sync_integer_columns = (
        "remote_total_runs",
        "last_discovery_returned_count",
        "pending_observed_count",
        "pending_upstream_total",
        "running_observed_count",
        "running_upstream_total",
        "paused_observed_count",
        "paused_upstream_total",
        "unresolved_unknown_status_count",
        "local_event_epoch",
        "projection_revision",
        "discovery_failure_count",
        "fast_poll_failure_count",
        "lease_epoch",
    )
    for position, column in enumerate(sync_integer_columns):
        with pytest.raises(sqlite3.IntegrityError):
            _insert_sync(conn, f"fraction-{position}", **{column: 1.5})
        with pytest.raises(sqlite3.IntegrityError):
            _insert_sync(conn, f"negative-{position}", **{column: -1})

    for position, column in enumerate(("current_state_complete", "sync_pending")):
        for bad_position, bad_value in enumerate((1.5, -1, 2)):
            with pytest.raises(sqlite3.IntegrityError):
                _insert_sync(
                    conn,
                    f"boolean-{position}-{bad_position}",
                    **{column: bad_value},
                )

    for position, column in enumerate(
        ("pending_set_quality", "running_set_quality", "paused_set_quality")
    ):
        with pytest.raises(sqlite3.IntegrityError):
            _insert_sync(conn, f"quality-{position}", **{column: "partial"})
    conn.close()


def test_history_event_epoch_constraints(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "history-epoch.db")
    _insert_sync(conn, "default")
    row = conn.execute(
        "SELECT history_event_epoch, unfiltered_proven_event_epoch "
        "FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id = 'agent-default'"
    ).fetchone()
    assert row == (0, None)
    for position, overrides in enumerate(
        (
            {"history_event_epoch": 1.5},
            {"unfiltered_proven_event_epoch": 1.5},
            {"history_event_epoch": -1},
            {"history_event_epoch": 1, "unfiltered_proven_event_epoch": -1},
            {"history_event_epoch": 1, "unfiltered_proven_event_epoch": 2},
        )
    ):
        with pytest.raises(sqlite3.IntegrityError):
            _insert_sync(conn, f"epoch-bad-{position}", **overrides)
    _insert_sync(
        conn,
        "epoch-equal",
        history_event_epoch=2,
        unfiltered_proven_event_epoch=2,
    )
    conn.close()


def test_finite_range_proof_marker_constraints(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "finite-range.db")
    _insert_sync(conn, "finite-default")
    assert conn.execute(
        "SELECT finite_range_proven_start_at FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id = 'agent-finite-default'"
    ).fetchone()[0] is None
    _insert_sync(
        conn,
        "finite-valid",
        finite_range_proven_start_at="2026-09-06T08:00:00+08:00",
    )
    with pytest.raises(sqlite3.IntegrityError):
        _insert_sync(conn, "finite-invalid", finite_range_proven_start_at="bad")
    conn.close()


def test_agent_workbench_schema_contract_complete(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "workbench-contract.db")
    expected_columns = {
        "seo_ops_agents": (
            "id", "agent_key", "coreai_agent_id", "display_name", "role",
            "sort_order", "status", "coreai_name", "coreai_model",
            "coreai_timeout_hint_seconds", "suspect_after_seconds",
            "last_verification_attempt_at", "last_verified_at",
            "last_verification_error", "verification_failure_count",
            "next_verification_at", "metadata_lease_owner", "metadata_lease_epoch",
            "metadata_lease_until", "retired_at", "created_at", "updated_at",
        ),
        "seo_ops_agent_runs": (
            "coreai_run_id", "seo_ops_agent_id", "raw_status", "trigger_type",
            "started_at", "completed_at", "terminal_observed_at",
            "receipt_expires_at", "input_tokens", "output_tokens", "trace_id",
            "error_summary", "source_kind", "source_local_id", "merchant_id",
            "first_seen_at", "last_poll_attempt_at", "last_synced_at",
            "last_poll_error", "data_warning_codes_json",
        ),
        "seo_ops_agent_sync_state": (
            "seo_ops_agent_id", "remote_total_runs", "last_discovery_attempt_at",
            "last_discovery_success_at", "last_discovery_error",
            "last_discovery_returned_count", "coverage_start_at",
            "finite_range_proven_start_at", "current_state_checked_at",
            "pending_observed_count", "pending_upstream_total",
            "pending_last_observed_at", "pending_set_quality",
            "running_observed_count", "running_upstream_total",
            "running_last_observed_at", "running_set_quality",
            "paused_observed_count", "paused_upstream_total",
            "paused_last_observed_at", "paused_set_quality",
            "unresolved_unknown_status_count", "current_state_complete",
            "current_state_error", "sync_pending", "local_event_epoch",
            "history_event_epoch", "unfiltered_proven_event_epoch",
            "projection_revision", "next_discovery_at", "last_fast_poll_attempt_at",
            "last_fast_poll_success_at", "last_fast_poll_error",
            "next_fast_poll_at", "discovery_failure_count",
            "fast_poll_failure_count", "lease_owner", "lease_epoch", "lease_until",
        ),
    }
    for table, columns in expected_columns.items():
        assert tuple(row[1] for row in conn.execute(f"PRAGMA table_info({table})")) == columns

    defaults = {
        table: {row[1]: row[4] for row in conn.execute(f"PRAGMA table_info({table})")}
        for table in expected_columns
    }
    assert {
        name: defaults["seo_ops_agents"][name]
        for name in (
            "sort_order",
            "suspect_after_seconds",
            "verification_failure_count",
            "metadata_lease_epoch",
        )
    } == {
        "sort_order": "0",
        "suspect_after_seconds": "1800",
        "verification_failure_count": "0",
        "metadata_lease_epoch": "0",
    }
    assert defaults["seo_ops_agent_runs"]["data_warning_codes_json"] == "'[]'"
    assert {
        name: defaults["seo_ops_agent_sync_state"][name]
        for name in (
            "pending_set_quality", "running_set_quality", "paused_set_quality",
            "unresolved_unknown_status_count", "current_state_complete",
            "sync_pending", "local_event_epoch", "history_event_epoch",
            "projection_revision", "discovery_failure_count",
            "fast_poll_failure_count", "lease_epoch",
        )
    } == {
        "pending_set_quality": "'unknown'", "running_set_quality": "'unknown'",
        "paused_set_quality": "'unknown'", "unresolved_unknown_status_count": "0",
        "current_state_complete": "0", "sync_pending": "1", "local_event_epoch": "0",
        "history_event_epoch": "0", "projection_revision": "0",
        "discovery_failure_count": "0", "fast_poll_failure_count": "0",
        "lease_epoch": "0",
    }

    run_fks = {
        (row[3], row[2], row[4], row[6])
        for row in conn.execute("PRAGMA foreign_key_list(seo_ops_agent_runs)")
    }
    assert ("seo_ops_agent_id", "seo_ops_agents", "id", "NO ACTION") in run_fks
    assert ("merchant_id", "merchants", "id", "SET NULL") in run_fks
    sync_fks = {
        (row[3], row[2], row[4], row[6])
        for row in conn.execute("PRAGMA foreign_key_list(seo_ops_agent_sync_state)")
    }
    assert sync_fks == {("seo_ops_agent_id", "seo_ops_agents", "id", "NO ACTION")}

    sql = " ".join(
        " ".join(row[0].lower().split())
        for row in conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' "
            "AND name LIKE 'seo_ops_agent%' ORDER BY name"
        )
    )
    for fragment in (
        "typeof(sort_order) = 'integer'",
        "status in ('active', 'disabled', 'retired')",
        "source_kind in ('run', 'task_execution', 'merchant_seo_artifact')",
        "datetime(first_seen_at) is not null",
        "(input_tokens is null) = (output_tokens is null)",
        "unfiltered_proven_event_epoch <= history_event_epoch",
        "current_state_complete in (0, 1)",
        "sync_pending in (0, 1)",
    ):
        assert fragment in sql

    indexes = {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'index'")
    }
    assert {
        "ux_seo_ops_agents_current_key",
        "idx_seo_ops_agents_next_verification_at",
        "idx_seo_ops_agents_metadata_lease_until",
        "idx_seo_ops_agent_runs_agent_effective_history",
        "idx_seo_ops_agent_runs_raw_status",
        "idx_seo_ops_agent_runs_source",
        "idx_seo_ops_agent_sync_next_discovery_at",
        "idx_seo_ops_agent_sync_next_fast_poll_at",
        "idx_seo_ops_agent_sync_lease_until",
        "idx_runs_coreai_run_id",
        "idx_task_executions_coreai_run_id",
    } <= indexes
    conn.close()


def test_agent_workbench_schema_repeated_init(tmp_path, monkeypatch):
    database = tmp_path / "workbench-repeat.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    from app.db import init_db

    init_db()
    init_db()
    conn = sqlite3.connect(database)
    assert conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' "
        "AND name IN ('seo_ops_agents', 'seo_ops_agent_runs', 'seo_ops_agent_sync_state')"
    ).fetchone()[0] == 3
    conn.close()


def test_pre_workbench_database_migrates_additively(tmp_path, monkeypatch):
    database = tmp_path / "pre-workbench.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(database)
    from app.migrations import content_sha256, register_sqlite_invariants

    register_sqlite_invariants(conn)
    conn.executescript(
        """
        DROP TABLE seo_ops_agent_sync_state;
        DROP TABLE seo_ops_agent_runs;
        DROP TABLE seo_ops_agents;
        DROP INDEX idx_task_executions_coreai_run_id;
        """
    )
    conn.execute(
        "INSERT INTO merchants (id, name, notes, created_at) VALUES (1, ?, ?, ?)",
        ("Legacy Merchant", "legacy-bytes-商户", "2026-09-06T00:00:00+00:00"),
    )
    lifecycle_stamp = "2026-09-06T00:00:00.000000Z"
    conn.execute(
        "INSERT INTO merchant_status_events "
        "(merchant_id, status, effective_at, generation, actor, reason, content_sha256, created_at) "
        "VALUES (1, 'active', ?, 1, 'legacy-fixture', 'created', ?, ?)",
        (
            lifecycle_stamp,
            content_sha256(1, "active", lifecycle_stamp, 1, "legacy-fixture", "created"),
            lifecycle_stamp,
        ),
    )
    conn.execute(
        "INSERT INTO runs (id, merchant_id, coreai_run_id, status, trigger_kind, report_text, created_at) "
        "VALUES (1, 1, 'legacy-run', 'succeeded', 'manual', ?, ?)",
        ("legacy-bytes-run", "2026-09-06T00:00:00+00:00"),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(id, merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id, "
        "request_json, payload_json, created_at) "
        "VALUES (1, 1, 'legacy-cycle', 'AUDIT_REPORT', 'legacy.v1', 'ready', "
        "'legacy-agent', '{}', ?, ?)",
        ("legacy-bytes-artifact", "2026-09-06T00:00:00+00:00"),
    )
    plan_id = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, state, latest_revision, approved_revision, created_at) "
        "VALUES (1, 'OPERATOR', 'OPEN', 1, 1, ?)",
        ("2026-09-06T00:00:00+00:00",),
    ).lastrowid
    task_definition = {
        "key": "legacy-task",
        "task_type": "PREPARE_ONLY",
        "title": "Legacy Task",
        "rationale": "Legacy rationale",
        "expected_outcome": "Legacy outcome",
        "depends_on": [],
        "scheduled_start": None,
        "parameters": {"description": "legacy-bytes-task", "category": "content"},
    }
    payload = json.dumps(
        {"schema_version": "seo_ops.task_plan.v1", "tasks": [task_definition]},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    payload_checksum = hashlib.sha256(payload.encode()).hexdigest()
    definition_checksum = hashlib.sha256(
        json.dumps(
            task_definition, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode()
    ).hexdigest()
    parameters_json = json.dumps(
        task_definition["parameters"], sort_keys=True, separators=(",", ":")
    )
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, "
        "created_by, created_at, decided_by, decided_at) "
        "VALUES (?, 1, 'APPROVED', 'seo_ops.task_plan.v1', ?, ?, 'OPERATOR', "
        "'operator', ?, 'operator', ?)",
        (
            plan_id,
            payload,
            payload_checksum,
            "2026-09-06T00:00:00+00:00",
            "2026-09-06T00:00:00+00:00",
        ),
    )
    conn.execute(
        "INSERT INTO tasks "
        "(id, merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, "
        "parameters_json, definition_checksum, title, description, rationale, expected_outcome, "
        "category, created_at) "
        "VALUES (1, 1, ?, 1, 'legacy-task', 'PREPARE_ONLY', 1, ?, ?, ?, ?, ?, ?, 'content', ?)",
        (
            plan_id,
            parameters_json,
            definition_checksum,
            "Legacy Task",
            "legacy-bytes-task",
            "Legacy rationale",
            "Legacy outcome",
            "2026-09-06T00:00:00+00:00",
        ),
    )
    conn.commit()
    before = {
        "merchant": conn.execute("SELECT * FROM merchants WHERE id = 1").fetchone(),
        "run": conn.execute("SELECT * FROM runs WHERE id = 1").fetchone(),
        "task": conn.execute("SELECT * FROM tasks WHERE id = 1").fetchone(),
        "artifact": conn.execute("SELECT * FROM merchant_seo_artifacts WHERE id = 1").fetchone(),
    }
    conn.close()

    init_db()
    conn = sqlite3.connect(database)
    after = {
        "merchant": conn.execute("SELECT * FROM merchants WHERE id = 1").fetchone(),
        "run": conn.execute("SELECT * FROM runs WHERE id = 1").fetchone(),
        "task": conn.execute("SELECT * FROM tasks WHERE id = 1").fetchone(),
        "artifact": conn.execute("SELECT * FROM merchant_seo_artifacts WHERE id = 1").fetchone(),
    }
    assert after == before
    assert {
        row[0]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    } >= {"seo_ops_agents", "seo_ops_agent_runs", "seo_ops_agent_sync_state"}
    conn.close()


def test_projected_run_survives_merchant_delete(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "projected-delete.db")
    conn.execute(
        "INSERT INTO merchants (id, name, created_at) VALUES (1, 'Merchant', '2026-09-06')"
    )
    _insert_agent(conn, "base")
    _insert_sync(conn, "sync")
    _insert_run(conn, "projected", merchant_id=1)
    conn.execute("UPDATE merchants SET status = 'archived' WHERE id = 1")
    conn.execute("DELETE FROM merchants WHERE id = 1")
    assert conn.execute(
        "SELECT merchant_id FROM seo_ops_agent_runs WHERE coreai_run_id = 'run-projected'"
    ).fetchone() == (None,)
    conn.close()

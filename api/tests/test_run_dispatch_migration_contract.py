from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from app.db import init_db
from app.migrations import (
    MIGRATIONS_DIR,
    RUN_DISPATCH_MIGRATION,
    apply_migrations,
    content_sha256,
    migration_registry_checksums,
    python_migration_checksum,
    register_sqlite_invariants,
)


def _use_database(monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
    monkeypatch.setenv("SEO_OPS_DB", str(path))


def _migration_ledger(path: Path) -> list[tuple[str, str]]:
    with sqlite3.connect(path) as conn:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
        ).fetchone()
        if row is None:
            return []
        return conn.execute(
            "SELECT version, checksum FROM schema_migrations ORDER BY version"
        ).fetchall()


def _rewrite_table_sql(path: Path, table: str, old: str, new: str) -> None:
    with sqlite3.connect(path) as conn:
        installed = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        assert installed is not None and old in installed[0]
        conn.execute("PRAGMA writable_schema = ON")
        conn.execute(
            "UPDATE sqlite_master SET sql=replace(sql, ?, ?) "
            "WHERE type='table' AND name=?",
            (old, new, table),
        )
        schema_version = int(conn.execute("PRAGMA schema_version").fetchone()[0])
        conn.execute(f"PRAGMA schema_version = {schema_version + 1}")
        conn.execute("PRAGMA writable_schema = OFF")
        conn.commit()


def _rebuild_table_without_constraints(path: Path, table: str) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute(f"ALTER TABLE {table} RENAME TO {table}_canonical")
        conn.execute(
            f"CREATE TABLE {table} AS SELECT * FROM {table}_canonical WHERE 0"
        )
        conn.execute(f"DROP TABLE {table}_canonical")
        conn.commit()


def _downgrade_to_exact_pre_poll_contract(
    path: Path, *, keep_0004_ledger: bool = False
) -> None:
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE runs DROP COLUMN poll_failure_started_at")
        if not keep_0004_ledger:
            conn.execute(
                "DELETE FROM schema_migrations "
                "WHERE version='0004_run_dispatch_contract'"
            )
        conn.commit()


def test_cold_start_rejects_partial_run_dispatch_columns_without_advancing_ledger(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "partial-run-dispatch.db"
    fixture = Path(__file__).parent / "fixtures" / "legacy_schema.sql"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(fixture.read_text())
        conn.execute(
            "ALTER TABLE runs ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'UNKNOWN' "
            "CHECK (dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED'))"
        )
        conn.commit()
    ledger_before = _migration_ledger(db_path)

    _use_database(monkeypatch, db_path)
    with pytest.raises(RuntimeError, match="partial run-dispatch column contract"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


def test_0004_manifest_is_checksum_bound_to_registry() -> None:
    manifest_path = MIGRATIONS_DIR / "0004_run_dispatch_contract.hook.json"
    assert migration_registry_checksums()[RUN_DISPATCH_MIGRATION] == (
        python_migration_checksum(
            RUN_DISPATCH_MIGRATION,
            contract=manifest_path.read_text(),
        )
    )


@pytest.mark.parametrize(
    "field,value",
    [
        ("version", "0004_wrong"),
        ("hook_revision", 2),
        ("hook_revision", True),
        ("entrypoint", "app.migrations.wrong"),
        ("responsibilities", ["install_fail_closed_run_dispatch_columns"]),
        ("unexpected", True),
    ],
)
def test_0004_manifest_contract_is_strict(
    tmp_path: Path, field: str, value: object
) -> None:
    migrations_dir = tmp_path / "migrations"
    migrations_dir.mkdir()
    for filename in (
        "0001_performance_history.sql",
        "0003_performance_lifecycle_baseline.hook.json",
    ):
        (migrations_dir / filename).write_bytes((MIGRATIONS_DIR / filename).read_bytes())
    manifest_path = MIGRATIONS_DIR / "0004_run_dispatch_contract.hook.json"
    manifest = json.loads(manifest_path.read_text())
    manifest[field] = value
    (migrations_dir / manifest_path.name).write_text(json.dumps(manifest))

    with pytest.raises(
        RuntimeError,
        match="migration hook contract mismatch: "
        "0004_run_dispatch_contract.hook.json",
    ):
        migration_registry_checksums(migrations_dir)


def test_0004_failure_rolls_back_columns_objects_and_ledger(tmp_path: Path) -> None:
    db_path = tmp_path / "duplicate-provider-run-id.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            CREATE TABLE merchants (
              id INTEGER PRIMARY KEY,
              name TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE runs (
              id INTEGER PRIMARY KEY,
              merchant_id INTEGER NOT NULL REFERENCES merchants(id),
              coreai_run_id TEXT,
              status TEXT NOT NULL,
              trigger_kind TEXT NOT NULL,
              report_text TEXT,
              error TEXT,
              plan_approved_at TEXT,
              created_at TEXT NOT NULL,
              finished_at TEXT
            );
            INSERT INTO merchants VALUES (1,'merchant','active','now');
            INSERT INTO runs VALUES
              (1,1,'duplicate','running','manual',NULL,NULL,NULL,'now',NULL),
              (2,1,'duplicate','failed','manual',NULL,NULL,NULL,'now',NULL);
            """
        )
        conn.commit()
        with pytest.raises(sqlite3.IntegrityError, match="UNIQUE constraint failed"):
            apply_migrations(
                conn,
                only_versions=frozenset({RUN_DISPATCH_MIGRATION}),
            )
        assert {
            str(row[1]) for row in conn.execute("PRAGMA table_info(runs)")
        }.isdisjoint(
            {
                "dispatch_state",
                "dispatch_token",
                "poll_failure_started_at",
                "input_sha256",
            }
        )
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE name='schema_migrations'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM sqlite_master "
            "WHERE name='run_dispatch_reconciliations'"
        ).fetchone() is None


def test_legacy_run_dispatch_migration_backfills_exact_states_and_is_idempotent(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "legacy-run-dispatch.db"
    fixture = Path(__file__).parent / "fixtures" / "legacy_schema.sql"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(fixture.read_text())
        conn.executemany(
            "INSERT INTO runs(id,merchant_id,coreai_run_id,status,trigger_kind,"
            "created_at) VALUES (?,?,?,?,?,?)",
            [
                (2, 1, "legacy-running-provider", "running", "manual", "2026-01-02"),
                (3, 1, None, "running", "manual", "2026-01-03"),
                (4, 1, None, "failed", "manual", "2026-01-04"),
                (5, 1, None, "succeeded", "manual", "2026-01-05"),
            ],
        )
        conn.commit()

    _use_database(monkeypatch, db_path)
    init_db()
    init_db()

    with sqlite3.connect(db_path) as conn:
        assert conn.execute(
            "SELECT id,dispatch_state FROM runs ORDER BY id"
        ).fetchall() == [
            (1, "DISPATCHED"),
            (2, "UNKNOWN"),
            (3, "UNKNOWN"),
            (4, "FAILED"),
            (5, "UNKNOWN"),
        ]
        run_columns = {
            str(row[1]): row for row in conn.execute("PRAGMA table_info(runs)")
        }
        assert run_columns["dispatch_state"][4] == "'UNKNOWN'"
        assert run_columns["poll_failure_started_at"][2] == "TEXT"
        assert conn.execute(
            "SELECT count(*) FROM schema_migrations "
            "WHERE version='0004_run_dispatch_contract'"
        ).fetchone()[0] == 1


def test_exact_pre_poll_contract_adds_only_poll_failure_column(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "exact-pre-poll.db"
    _use_database(monkeypatch, db_path)
    init_db()
    with sqlite3.connect(db_path) as conn:
        register_sqlite_invariants(conn)
        stamp = "2026-01-01T00:00:00.000000Z"
        conn.execute(
            "INSERT INTO merchants(name,status,created_at) "
            "VALUES ('merchant','active',?)",
            (stamp,),
        )
        merchant_id = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        conn.execute(
            "INSERT INTO merchant_status_events(merchant_id,status,effective_at,"
            "generation,actor,reason,content_sha256,created_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (
                merchant_id,
                "active",
                stamp,
                1,
                "test",
                "fixture",
                content_sha256(
                    merchant_id,
                    "active",
                    stamp,
                    1,
                    "test",
                    "fixture",
                ),
                stamp,
            ),
        )
        conn.execute(
            "INSERT INTO runs(merchant_id,coreai_run_id,dispatch_state,dispatch_token,"
            "status,trigger_kind,created_at) VALUES (?,?,?,?,?,?,?)",
            (
                merchant_id,
                "provider-1",
                "DISPATCHED",
                "token-1",
                "running",
                "manual",
                stamp,
            ),
        )
        conn.commit()
    _downgrade_to_exact_pre_poll_contract(db_path)
    before = _migration_ledger(db_path)

    init_db()
    init_db()

    with sqlite3.connect(db_path) as conn:
        register_sqlite_invariants(conn)
        columns = {
            str(row[1]): tuple(row)
            for row in conn.execute("PRAGMA table_info(runs)")
        }
        assert columns["poll_failure_started_at"][2:5] == ("TEXT", 0, None)
        assert conn.execute(
            "SELECT coreai_run_id,dispatch_state,dispatch_token FROM runs"
        ).fetchall() == [("provider-1", "DISPATCHED", "token-1")]
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    after = _migration_ledger(db_path)
    assert [row for row in after if row[0] != RUN_DISPATCH_MIGRATION] == before
    assert sum(row[0] == RUN_DISPATCH_MIGRATION for row in after) == 1


@pytest.mark.parametrize("drift", ["weak_index", "noop_trigger"])
def test_pre_poll_near_miss_fails_before_column_or_ledger_change(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    drift: str,
) -> None:
    db_path = tmp_path / f"pre-poll-{drift}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    _downgrade_to_exact_pre_poll_contract(db_path)
    with sqlite3.connect(db_path) as conn:
        if drift == "weak_index":
            conn.execute("DROP INDEX idx_runs_dispatch_token")
            conn.execute(
                "CREATE INDEX idx_runs_dispatch_token ON runs(dispatch_token)"
            )
        else:
            conn.execute(
                "DROP TRIGGER trg_run_dispatch_reconciliations_no_delete"
            )
            conn.execute(
                "CREATE TRIGGER trg_run_dispatch_reconciliations_no_delete "
                "BEFORE DELETE ON run_dispatch_reconciliations "
                "BEGIN SELECT 1; END"
            )
        conn.commit()
    ledger_before = _migration_ledger(db_path)

    with pytest.raises(RuntimeError, match="run-dispatch object contract mismatch"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before
    with sqlite3.connect(db_path) as conn:
        assert "poll_failure_started_at" not in {
            str(row[1]) for row in conn.execute("PRAGMA table_info(runs)")
        }


def test_recorded_0004_cannot_adopt_missing_poll_failure_column(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "recorded-pre-poll.db"
    _use_database(monkeypatch, db_path)
    init_db()
    _downgrade_to_exact_pre_poll_contract(db_path, keep_0004_ledger=True)
    ledger_before = _migration_ledger(db_path)

    with pytest.raises(
        RuntimeError,
        match="recorded run-dispatch migration is missing poll_failure_started_at",
    ):
        init_db()

    assert _migration_ledger(db_path) == ledger_before
    with sqlite3.connect(db_path) as conn:
        assert "poll_failure_started_at" not in {
            str(row[1]) for row in conn.execute("PRAGMA table_info(runs)")
        }


@pytest.mark.parametrize("object_kind", ["index", "trigger"])
def test_cold_start_rejects_same_name_weak_object_without_advancing_ledger(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    object_kind: str,
) -> None:
    db_path = tmp_path / f"cold-weak-{object_kind}.db"
    schema = Path(__file__).parents[1] / "schema.sql"
    with sqlite3.connect(db_path) as conn:
        register_sqlite_invariants(conn)
        conn.executescript(schema.read_text())
        if object_kind == "index":
            conn.execute("DROP INDEX idx_runs_dispatch_token")
            conn.execute(
                "CREATE INDEX idx_runs_dispatch_token ON runs(dispatch_token)"
            )
        else:
            conn.execute(
                "DROP TRIGGER trg_run_dispatch_reconciliations_no_update"
            )
            conn.execute(
                "CREATE TRIGGER trg_run_dispatch_reconciliations_no_update "
                "BEFORE UPDATE ON run_dispatch_reconciliations "
                "BEGIN SELECT 1; END"
            )
        conn.commit()
    ledger_before = _migration_ledger(db_path)

    _use_database(monkeypatch, db_path)
    with pytest.raises(RuntimeError, match="run-dispatch object contract mismatch"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


@pytest.mark.parametrize(
    "index_name,index_column",
    [
        ("idx_runs_coreai_run_id", "coreai_run_id"),
        ("idx_runs_dispatch_token", "dispatch_token"),
    ],
)
def test_recorded_run_dispatch_migration_rejects_same_name_non_unique_index(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    index_name: str,
    index_column: str,
) -> None:
    db_path = tmp_path / f"weak-{index_name}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(f"DROP INDEX {index_name}")
        conn.execute(f"CREATE INDEX {index_name} ON runs({index_column})")
        conn.commit()

    with pytest.raises(RuntimeError, match=index_name):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


@pytest.mark.parametrize(
    "trigger_name,event",
    [
        ("trg_run_dispatch_reconciliations_no_update", "UPDATE"),
        ("trg_run_dispatch_reconciliations_no_delete", "DELETE"),
    ],
)
def test_recorded_run_dispatch_migration_rejects_same_name_noop_trigger(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    trigger_name: str,
    event: str,
) -> None:
    db_path = tmp_path / f"weak-{trigger_name}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(f"DROP TRIGGER {trigger_name}")
        conn.execute(
            f"CREATE TRIGGER {trigger_name} BEFORE {event} ON run_dispatch_reconciliations "
            "BEGIN SELECT 1; END"
        )
        conn.commit()

    with pytest.raises(RuntimeError, match=trigger_name):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


@pytest.mark.parametrize("variant", ["missing", "noop"])
def test_recorded_run_dispatch_migration_requires_operator_command_delete_guard(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    variant: str,
) -> None:
    trigger_name = "guard_merchants_delete_with_operator_command_history"
    db_path = tmp_path / f"{variant}-{trigger_name}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute(f"DROP TRIGGER {trigger_name}")
        if variant == "noop":
            conn.execute(
                f"CREATE TRIGGER {trigger_name} BEFORE DELETE ON merchants "
                "BEGIN SELECT 1; END"
            )
        conn.commit()

    with pytest.raises(RuntimeError, match=trigger_name):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


@pytest.mark.parametrize(
    "old,new,field",
    [
        ("DEFAULT 'UNKNOWN'", "DEFAULT 'DISPATCHED'", "dispatch_state"),
        (
            "('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')",
            "('DISPATCHING','DISPATCHED','UNKNOWN','FAILED','BROKEN')",
            "dispatch_state",
        ),
        ("dispatch_token TEXT", "dispatch_token BLOB", "dispatch_token"),
    ],
)
def test_recorded_run_dispatch_migration_rejects_column_contract_drift(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    old: str,
    new: str,
    field: str,
) -> None:
    db_path = tmp_path / f"weak-runs-{field}-{len(old)}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)
    _rewrite_table_sql(db_path, "runs", old, new)

    with pytest.raises(RuntimeError, match=f"runs column contract mismatch: {field}"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


def test_recorded_run_dispatch_migration_rejects_weakened_reconciliation_table(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "weak-reconciliation-table.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)
    _rebuild_table_without_constraints(db_path, "run_dispatch_reconciliations")

    with pytest.raises(
        RuntimeError,
        match="run_dispatch_reconciliations",
    ):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


def test_recorded_task_workflow_migration_rejects_weakened_task_plans_table(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "weak-task-plans.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)

    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("ALTER TABLE task_plans RENAME TO task_plans_canonical")
        conn.execute(
            """
            CREATE TABLE task_plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                merchant_id INTEGER NOT NULL REFERENCES merchants(id),
                source_kind TEXT NOT NULL,
                source_run_id INTEGER REFERENCES runs(id),
                state TEXT NOT NULL,
                latest_revision INTEGER NOT NULL,
                approved_revision INTEGER,
                created_at TEXT NOT NULL,
                closed_at TEXT
            )
            """
        )
        conn.execute("DROP TABLE task_plans_canonical")
        conn.commit()

    with pytest.raises(RuntimeError, match="task_plans.*table contract"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before


@pytest.mark.parametrize(
    "table",
    [
        "task_plans",
        "task_plan_revisions",
        "tasks",
        "task_dependencies",
        "task_executions",
        "task_events",
    ],
)
def test_recorded_task_workflow_migration_rejects_every_table_contract_drift(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    table: str,
) -> None:
    db_path = tmp_path / f"weak-{table}.db"
    _use_database(monkeypatch, db_path)
    init_db()
    ledger_before = _migration_ledger(db_path)
    if table == "tasks":
        _rewrite_table_sql(
            db_path,
            table,
            "status TEXT NOT NULL DEFAULT 'PENDING'",
            "status TEXT NOT NULL DEFAULT 'DONE'",
        )
    else:
        _rebuild_table_without_constraints(db_path, table)

    with pytest.raises(RuntimeError, match=f"{table}.*table contract"):
        init_db()

    assert _migration_ledger(db_path) == ledger_before

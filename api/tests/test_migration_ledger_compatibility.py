import json
import sqlite3

import pytest


TASK_MIGRATION = "0002_task_workflows"
PERFORMANCE_MIGRATION = "0001_performance_history"
PERFORMANCE_MIGRATION_CHECKSUM = (
    "3eb1f10f2e7b3b102ab626bae3097e584210320618ef92e19936cdded8be6db5"
)


def _ledger_columns(conn: sqlite3.Connection) -> list[str]:
    return [str(row[1]) for row in conn.execute("PRAGMA table_info(schema_migrations)")]


def test_fresh_init_uses_one_checksum_backed_migration_ledger(tmp_path, monkeypatch):
    path = tmp_path / "fresh-canonical-ledger.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app.db import init_db
    from app.migrations import (
        MIGRATIONS_DIR,
        migration_registry_checksums,
        python_migration_checksum,
    )
    from app.task_migrations import task_workflow_python_migrations

    init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["version", "checksum", "applied_at"]
    rows = conn.execute(
        "SELECT version, checksum FROM schema_migrations ORDER BY version"
    ).fetchall()
    hook_payload = (MIGRATIONS_DIR / f"{TASK_MIGRATION}.hook.json").read_text()
    hook_contract = json.loads(hook_payload)
    assert hook_contract["hook_revision"] == 4
    assert {
        "reject_duplicate_coreai_run_bindings",
        "restore_cross_table_coreai_run_uniqueness_triggers",
        "validate_exact_task_table_contracts_on_every_startup",
    } <= set(hook_contract["guarantees"])
    expected_checksum = python_migration_checksum(TASK_MIGRATION, contract=hook_payload)
    assert dict(rows) == migration_registry_checksums(
        python_migrations=task_workflow_python_migrations()
    )
    migration = task_workflow_python_migrations()[0]
    assert migration.version == TASK_MIGRATION
    assert migration.checksum == expected_checksum
    assert migration.foreign_keys_off is True
    assert migration.legacy_ledger_names == (
        "task_workflow_v1",
        "task_workflow_states_v2",
    )
    assert callable(migration.validate_legacy_adoption)
    assert len(migration.compatible_checksums) == 2
    conn.close()


def test_exact_revision_2_checksum_is_validated_and_atomically_advanced(
    tmp_path, monkeypatch
):
    path = tmp_path / "revision-2-compatible.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.migrations import migration_registry_checksums
    from app.task_migrations import (
        TASK_WORKFLOW_REVISION_2_CHECKSUM,
        task_workflow_python_migrations,
    )

    init_db()
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE schema_migrations SET checksum=? WHERE version=?",
        (TASK_WORKFLOW_REVISION_2_CHECKSUM, TASK_MIGRATION),
    )
    conn.commit()
    conn.close()

    init_db()

    expected = migration_registry_checksums(
        python_migrations=task_workflow_python_migrations()
    )[TASK_MIGRATION]
    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (TASK_MIGRATION,),
    ).fetchone()[0] == expected
    conn.close()


def test_exact_revision_3_checksum_is_validated_and_atomically_advanced(
    tmp_path, monkeypatch
):
    path = tmp_path / "revision-3-compatible.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.migrations import migration_registry_checksums
    from app.task_migrations import (
        TASK_WORKFLOW_REVISION_3_CHECKSUM,
        task_workflow_python_migrations,
    )

    init_db()
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE schema_migrations SET checksum=? WHERE version=?",
        (TASK_WORKFLOW_REVISION_3_CHECKSUM, TASK_MIGRATION),
    )
    conn.commit()
    conn.close()

    init_db()

    expected = migration_registry_checksums(
        python_migrations=task_workflow_python_migrations()
    )[TASK_MIGRATION]
    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (TASK_MIGRATION,),
    ).fetchone()[0] == expected
    conn.close()


def test_revision_3_compatibility_rejects_weakened_table_before_checksum_cas(
    tmp_path, monkeypatch
):
    path = tmp_path / "revision-3-weak-table.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.task_migrations import TASK_WORKFLOW_REVISION_3_CHECKSUM

    init_db()
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA writable_schema = ON")
    conn.execute(
        "UPDATE sqlite_master SET sql=replace(sql, "
        "'payload_json TEXT NOT NULL', 'payload_json TEXT') "
        "WHERE type='table' AND name='task_events'"
    )
    conn.execute(
        "UPDATE schema_migrations SET checksum=? WHERE version=?",
        (TASK_WORKFLOW_REVISION_3_CHECKSUM, TASK_MIGRATION),
    )
    conn.execute("PRAGMA writable_schema = OFF")
    conn.commit()
    conn.close()

    with pytest.raises(RuntimeError, match="task_events.*table contract"):
        init_db()

    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (TASK_MIGRATION,),
    ).fetchone()[0] == TASK_WORKFLOW_REVISION_3_CHECKSUM
    conn.close()


def test_revision_2_compatibility_rejects_corrupt_plan_without_advancing_ledger(
    tmp_path, monkeypatch
):
    path = tmp_path / "revision-2-corrupt-plan.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.task_migrations import TASK_WORKFLOW_REVISION_2_CHECKSUM

    init_db()
    conn = sqlite3.connect(path)
    conn.execute(
        "INSERT INTO merchants(id,name,status,created_at) "
        "VALUES (1,'Corrupt','active','2026-09-04T00:00:00+00:00')"
    )
    plan_id = conn.execute(
        "INSERT INTO task_plans(merchant_id,source_kind,state,latest_revision,created_at) "
        "VALUES (1,'OPERATOR','OPEN',1,'2026-09-04T00:00:00+00:00')"
    ).lastrowid
    conn.execute(
        "INSERT INTO task_plan_revisions("
        "plan_id,revision,decision_state,schema_version,payload_json,checksum,"
        "source,created_by,created_at) "
        "VALUES (?,1,'DRAFT','seo_ops.task_plan.v1','{}',?,'OPERATOR','test',?)",
        (plan_id, "a" * 64, "2026-09-04T00:00:00+00:00"),
    )
    conn.execute(
        "UPDATE schema_migrations SET checksum=? WHERE version=?",
        (TASK_WORKFLOW_REVISION_2_CHECKSUM, TASK_MIGRATION),
    )
    conn.commit()
    conn.close()

    with pytest.raises(RuntimeError, match="revision payload invalid"):
        init_db()

    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (TASK_MIGRATION,),
    ).fetchone()[0] == TASK_WORKFLOW_REVISION_2_CHECKSUM
    conn.close()


def test_revision_2_rejects_same_name_trigger_with_wrong_contract_before_checksum_cas(
    tmp_path, monkeypatch
):
    path = tmp_path / "revision-2-wrong-trigger.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.task_migrations import TASK_WORKFLOW_REVISION_2_CHECKSUM

    init_db()
    conn = sqlite3.connect(path)
    conn.execute("DROP TRIGGER trg_tasks_no_delete")
    conn.execute(
        "CREATE TRIGGER trg_tasks_no_delete BEFORE DELETE ON tasks "
        "BEGIN SELECT 1; END"
    )
    conn.execute(
        "UPDATE schema_migrations SET checksum=? WHERE version=?",
        (TASK_WORKFLOW_REVISION_2_CHECKSUM, TASK_MIGRATION),
    )
    conn.commit()
    conn.close()

    with pytest.raises(RuntimeError, match="task workflow trigger contract mismatch"):
        init_db()

    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (TASK_MIGRATION,),
    ).fetchone()[0] == TASK_WORKFLOW_REVISION_2_CHECKSUM
    assert "SELECT 1" in conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='trigger' "
        "AND name='trg_tasks_no_delete'"
    ).fetchone()[0]
    conn.close()


@pytest.mark.parametrize("index_variant", ["missing", "wrong_definition"])
def test_legacy_adoption_rejects_missing_or_wrong_required_index_before_ledger_rewrite(
    tmp_path, monkeypatch, index_variant
):
    path = tmp_path / f"legacy-adoption-{index_variant}-index.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import SCHEMA_PATH, init_db

    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executescript(SCHEMA_PATH.read_text())
    conn.executemany(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        [
            ("task_workflow_v1", "2026-09-03T00:00:00+00:00"),
            ("task_workflow_states_v2", "2026-09-03T00:01:00+00:00"),
        ],
    )
    conn.execute("DROP INDEX idx_task_executions_active")
    if index_variant == "wrong_definition":
        conn.execute(
            "CREATE INDEX idx_task_executions_active "
            "ON task_executions(task_id, id)"
        )
    conn.commit()
    conn.close()

    with pytest.raises(RuntimeError, match="task workflow index contract mismatch"):
        init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["name", "applied_at"]
    assert conn.execute(
        "SELECT name FROM schema_migrations ORDER BY name"
    ).fetchall() == [
        ("task_workflow_states_v2",),
        ("task_workflow_v1",),
    ]
    if index_variant == "wrong_definition":
        assert "task_id, id" in conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='index' "
            "AND name='idx_task_executions_active'"
        ).fetchone()[0]
    conn.close()


def test_recorded_performance_migration_requires_exact_delete_guard(
    tmp_path, monkeypatch
):
    path = tmp_path / "missing-performance-guard.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    from app.db import init_db
    from app.migrations import MigrationInvariantError

    init_db()
    conn = sqlite3.connect(path)
    conn.execute("DROP TRIGGER guard_merchants_delete_with_durable_history")
    conn.commit()
    conn.close()

    with pytest.raises(
        MigrationInvariantError,
        match="performance_delete_guard_contract_mismatch",
    ):
        init_db()


def test_legacy_task_first_name_ledger_is_atomically_adopted(tmp_path, monkeypatch):
    path = tmp_path / "legacy-task-first.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app import task_migrations
    from app.db import SCHEMA_PATH, init_db

    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executescript(SCHEMA_PATH.read_text())
    conn.executemany(
        "INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)",
        [
            ("task_workflow_v1", "2026-09-03T00:00:00+00:00"),
            ("task_workflow_states_v2", "2026-09-03T00:01:00+00:00"),
        ],
    )
    conn.commit()
    conn.close()

    def destructive_hook_must_not_rerun(_conn):
        raise AssertionError("completed legacy task migration was re-run")

    monkeypatch.setattr(
        task_migrations,
        "_create_task_workflow_indexes_and_triggers",
        destructive_hook_must_not_rerun,
    )
    init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["version", "checksum", "applied_at"]
    assert conn.execute(
        "SELECT version FROM schema_migrations ORDER BY version"
    ).fetchall() == [
        ("0001_performance_history",),
        (TASK_MIGRATION,),
        ("0003_performance_lifecycle_baseline",),
        ("0004_run_dispatch_contract",),
        ("0005_task_assignments",),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_unknown_legacy_name_ledger_marker_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "unknown-legacy-marker.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app.db import SCHEMA_PATH, init_db
    from app.migrations import MigrationInvariantError

    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executescript(SCHEMA_PATH.read_text())
    conn.execute(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        ("some_other_feature", "2026-09-03T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    with pytest.raises(
        MigrationInvariantError, match="unrecognized legacy migration marker set"
    ):
        init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["name", "applied_at"]
    assert conn.execute("SELECT name FROM schema_migrations").fetchall() == [
        ("some_other_feature",)
    ]
    conn.close()


def test_partial_legacy_name_ledger_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "partial-legacy-marker.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app.db import SCHEMA_PATH, init_db
    from app.migrations import MigrationInvariantError

    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executescript(SCHEMA_PATH.read_text())
    conn.execute(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        ("task_workflow_v1", "2026-09-03T00:00:00+00:00"),
    )
    conn.commit()
    conn.close()

    with pytest.raises(
        MigrationInvariantError, match="unrecognized legacy migration marker set"
    ):
        init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["name", "applied_at"]
    assert conn.execute("SELECT name FROM schema_migrations").fetchall() == [
        ("task_workflow_v1",)
    ]
    conn.close()


def test_performance_first_canonical_ledger_is_preserved(tmp_path, monkeypatch):
    path = tmp_path / "performance-first.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app.db import SCHEMA_PATH, init_db
    from app.migrations import apply_migrations

    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
    assert apply_migrations(
        conn, only_versions=frozenset({PERFORMANCE_MIGRATION})
    ) == [PERFORMANCE_MIGRATION]
    conn.close()

    init_db()

    conn = sqlite3.connect(path)
    assert _ledger_columns(conn) == ["version", "checksum", "applied_at"]
    assert conn.execute(
        "SELECT version,checksum FROM schema_migrations ORDER BY version"
    ).fetchall() == [
        (PERFORMANCE_MIGRATION, PERFORMANCE_MIGRATION_CHECKSUM),
        (
            TASK_MIGRATION,
            conn.execute(
                "SELECT checksum FROM schema_migrations WHERE version=?",
                (TASK_MIGRATION,),
            ).fetchone()[0],
        ),
        (
            "0003_performance_lifecycle_baseline",
            conn.execute(
                "SELECT checksum FROM schema_migrations WHERE version=?",
                ("0003_performance_lifecycle_baseline",),
            ).fetchone()[0],
        ),
        (
            "0004_run_dispatch_contract",
            conn.execute(
                "SELECT checksum FROM schema_migrations WHERE version=?",
                ("0004_run_dispatch_contract",),
            ).fetchone()[0],
        ),
        ("0005_task_assignments", "1459a380cc9be4c3679252e6f4f32142007d5ef6f3c7f49a13b0081735bb32cd"),
    ]
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    conn.close()


def test_performance_first_checksum_mismatch_fails_closed(tmp_path, monkeypatch):
    path = tmp_path / "performance-first-checksum-mismatch.db"
    monkeypatch.setenv("SEO_OPS_DB", str(path))

    from app.db import SCHEMA_PATH, init_db

    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE schema_migrations ("
        "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    conn.execute(
        "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
        (PERFORMANCE_MIGRATION, "a" * 64, "2026-09-03T00:00:00.000000Z"),
    )
    conn.executescript(SCHEMA_PATH.read_text())
    conn.commit()
    conn.close()

    with pytest.raises(RuntimeError, match="migration checksum mismatch"):
        init_db()

    conn = sqlite3.connect(path)
    assert conn.execute(
        "SELECT version,checksum FROM schema_migrations"
    ).fetchall() == [(PERFORMANCE_MIGRATION, "a" * 64)]
    conn.close()


@pytest.mark.parametrize(
    ("version", "checksum", "message"),
    [
        ("not-numbered", "a" * 64, "invalid Python migration version"),
        ("0009_test_hook", "not-a-checksum", "invalid Python migration checksum"),
    ],
)
def test_shared_runner_rejects_invalid_python_registration(
    tmp_path, version, checksum, message
):
    from app.migrations import PythonMigration, apply_migrations

    conn = sqlite3.connect(":memory:")
    migration = PythonMigration(
        version=version,
        checksum=checksum,
        apply=lambda _conn, _stamp: None,
    )
    with pytest.raises(ValueError, match=message):
        apply_migrations(
            conn,
            migrations_dir=tmp_path,
            python_migrations=(migration,),
        )
    assert conn.in_transaction is False
    conn.close()


def test_shared_runner_rejects_empty_legacy_marker_name(tmp_path):
    from app.migrations import PythonMigration, apply_migrations

    conn = sqlite3.connect(":memory:")
    migration = PythonMigration(
        version="0009_test_hook",
        checksum="a" * 64,
        apply=lambda _conn, _stamp: None,
        legacy_ledger_names=("",),
        validate_legacy_adoption=lambda _conn: None,
    )
    with pytest.raises(ValueError, match="invalid legacy migration marker contract"):
        apply_migrations(
            conn,
            migrations_dir=tmp_path,
            python_migrations=(migration,),
        )
    assert conn.in_transaction is False
    conn.close()


def test_failed_legacy_ledger_upgrade_rolls_back_schema_and_data(tmp_path, monkeypatch):
    from app import task_migrations
    from app.db import init_db

    path = tmp_path / "failed-legacy-ledger-upgrade.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE merchants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active','archived')),
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
          status TEXT NOT NULL DEFAULT 'running'
            CHECK (status IN ('running','succeeded','failed')),
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
          status TEXT NOT NULL DEFAULT 'todo'
            CHECK (status IN ('todo','doing','done','cancelled')),
          evidence_note TEXT,
          source_run_id INTEGER REFERENCES runs(id),
          source_key TEXT,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );
        """
    )
    conn.execute(
        "INSERT INTO merchants(id,name,created_at) VALUES (1,'Legacy','2026-09-03T00:00:00+00:00')"
    )
    conn.execute(
        "INSERT INTO tasks(id,merchant_id,title,status,created_at) "
        "VALUES (1,1,'Legacy task','todo','2026-09-03T00:00:00+00:00')"
    )
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.commit()
    before_tasks = conn.execute("SELECT * FROM tasks ORDER BY id").fetchall()
    conn.close()

    def fail_conversion(_conn):
        raise RuntimeError("injected canonical migration failure")

    monkeypatch.setattr(
        task_migrations, "_convert_legacy_runs_and_tasks", fail_conversion
    )
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    with pytest.raises(RuntimeError, match="injected canonical migration failure"):
        init_db()

    conn = sqlite3.connect(path)
    # The empty legacy ledger is normalized in its own writer transaction
    # before schema bridging.  The later 0002 hook failure must leave that
    # canonical, checksum-capable ledger empty while rolling back Task data.
    assert _ledger_columns(conn) == ["version", "checksum", "applied_at"]
    assert (
        conn.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
        == []
    )
    assert conn.execute("SELECT * FROM tasks ORDER BY id").fetchall() == before_tasks
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_plans'"
        ).fetchone()[0]
        == 0
    )
    conn.close()

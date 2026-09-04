import os
import sqlite3
from pathlib import Path

from app.migrations import (
    PERFORMANCE_LIFECYCLE_MIGRATION,
    PERFORMANCE_MIGRATION,
    RUN_DISPATCH_MIGRATION,
    MigrationInvariantError,
    PythonMigration,
    apply_migrations,
    assert_migration_postconditions,
    assert_migration_registry_checksums,
    execute_sql_payload,
    register_sqlite_invariants,
    validate_run_dispatch_migration_input,
)
from app.task_migrations import (
    TASK_WORKFLOW_MIGRATION,
    assert_task_workflow_migration_postconditions,
    assert_task_workflow_table_contracts,
    assert_unique_coreai_run_bindings as _assert_unique_coreai_run_bindings,
    task_table_kind,
    task_workflow_python_migrations,
)

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"
DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "seo-ops-v3.db"


def db_path() -> str:
    return os.environ.get("SEO_OPS_DB", str(DEFAULT_DB_PATH))


def connect() -> sqlite3.Connection:
    # FastAPI 会把同步依赖的创建和路由函数放到线程池的不同线程执行；
    # 每个请求独享一条连接、顺序使用，因此跨线程是安全的。
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    register_sqlite_invariants(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


MIGRATION_COLUMNS: dict[str, dict[str, str]] = {
    "merchants": {
        "auto_run_interval_days": "INTEGER",
        "primary_location": "TEXT",
        "website_url": "TEXT",
    },
    "runs": {
        "plan_approved_at": "TEXT",
        "dispatch_state": (
            "TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK "
            "(dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED'))"
        ),
        "dispatch_token": "TEXT",
        "dispatch_started_at": "TEXT",
        "poll_failure_started_at": "TEXT",
        "provider_candidate_run_id": "TEXT",
        "source_agent_id": "TEXT",
        "merchant_lifecycle_generation": "INTEGER",
        "merchant_lifecycle_sha256": "TEXT",
        "input_sha256": "TEXT",
    },
    "merchant_seo_artifacts": {
        "provenance_json": "TEXT",
        "verification_started_at": "TEXT",
        "dispatch_state": "TEXT NOT NULL DEFAULT 'not_required'",
        "dispatch_started_at": "TEXT",
    },
    "tasks": {"source_run_id": "INTEGER REFERENCES runs(id)", "source_key": "TEXT", "expected_outcome": "TEXT", "category": "TEXT", "scheduled_start": "TEXT"},
    "merchant_local_falcon_scan_batches": {
        "confirmation_id": (
            "INTEGER REFERENCES merchant_local_falcon_scan_confirmations(id)"
        ),
        "dispatch_token": "TEXT",
        "dispatch_started_at": "TEXT",
    },
    "merchant_local_falcon_scan_items": {"ack_report_key": "TEXT"},
    "merchant_local_falcon_syncs": {
        "place_id": "TEXT",
        "keyword_artifact_id": "INTEGER REFERENCES merchant_seo_artifacts(id)",
        "cohort_sha256": "TEXT",
    },
}


_RUN_DISPATCH_COLUMNS = {
    "dispatch_state",
    "dispatch_token",
    "dispatch_started_at",
    "poll_failure_started_at",
    "provider_candidate_run_id",
    "source_agent_id",
    "merchant_lifecycle_generation",
    "merchant_lifecycle_sha256",
    "input_sha256",
}


def _migrate(
    conn: sqlite3.Connection, *, include_run_dispatch_fields: bool = True
) -> None:
    for table, cols in MIGRATION_COLUMNS.items():
        if table == "runs" and not include_run_dispatch_fields:
            cols = {
                name: declaration
                for name, declaration in cols.items()
                if name not in _RUN_DISPATCH_COLUMNS
            }
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # 全新库，表还没建，executescript 已带新列
        added: set[str] = set()
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
                added.add(col)
        if table == "runs" and "plan_approved_at" in added:
            conn.execute(
                "UPDATE runs SET plan_approved_at = COALESCE(finished_at, created_at)"
                " WHERE status = 'succeeded'"
            )
        if table == "runs" and "dispatch_state" in added:
            conn.execute(
                "UPDATE runs SET dispatch_state = CASE "
                "WHEN status = 'failed' THEN 'FAILED' "
                "WHEN status = 'succeeded' AND coreai_run_id IS NOT NULL "
                "THEN 'DISPATCHED' "
                "ELSE 'UNKNOWN' END"
            )
    if include_run_dispatch_fields and _object_type(
        conn, "runs"
    ) == "table" and "dispatch_token" in {
        str(row[1]) for row in conn.execute("PRAGMA table_info(runs)")
    }:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_coreai_run_id "
            "ON runs(coreai_run_id) WHERE coreai_run_id IS NOT NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_token "
            "ON runs(dispatch_token) WHERE dispatch_token IS NOT NULL"
        )


def _bootstrap_runs_for_legacy_tasks(conn: sqlite3.Connection) -> None:
    """Create only the parent table required by the legacy Task conversion."""

    if _object_type(conn, "runs") == "table":
        return
    conn.execute(
        """
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
        )
        """
    )


def _object_type(conn: sqlite3.Connection, name: str) -> str | None:
    row = conn.execute(
        "SELECT type FROM sqlite_master WHERE name = ?", (name,)
    ).fetchone()
    return None if row is None else str(row[0])


def _migration_recorded(
    conn: sqlite3.Connection, version: str = PERFORMANCE_MIGRATION
) -> bool:
    if _object_type(conn, "schema_migrations") != "table":
        return False
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(schema_migrations)")
    }
    if columns == {"name", "applied_at"}:
        # The shared runner may adopt this only after Task's exact marker-set
        # contract and final checksum have been registered.
        return False
    if columns != {"version", "checksum", "applied_at"}:
        raise MigrationInvariantError("unrecognized schema_migrations layout")
    return (
        conn.execute(
            "SELECT 1 FROM schema_migrations WHERE version = ?",
            (version,),
        ).fetchone()
        is not None
    )


def _legacy_fbr_bootstrap_required(
    conn: sqlite3.Connection,
    *,
    python_migrations: tuple[PythonMigration, ...] = (),
) -> bool:
    """Validate the FBR schema boundary without mutating it."""
    migration_columns = (
        {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(schema_migrations)")
        }
        if _object_type(conn, "schema_migrations") == "table"
        else set()
    )
    if migration_columns != {"name", "applied_at"}:
        assert_migration_registry_checksums(
            conn,
            python_migrations=python_migrations,
        )
    recorded = _migration_recorded(conn)
    lifecycle_recorded = _migration_recorded(
        conn, PERFORMANCE_LIFECYCLE_MIGRATION
    )
    compatibility_type = _object_type(conn, "merchant_fbr_links")
    legacy_renamed = _object_type(conn, "merchant_fbr_links_legacy")
    history_type = _object_type(conn, "merchant_fbr_binding_events")
    state_type = _object_type(conn, "merchant_fbr_link_state")

    if recorded:
        if (
            compatibility_type == "view"
            and (
                legacy_renamed is None
                or (legacy_renamed == "table" and not lifecycle_recorded)
            )
            and history_type == "table"
            and state_type == "table"
        ):
            return False
        raise MigrationInvariantError("recorded_fbr_migration_schema_inconsistent")

    if compatibility_type == "table":
        if legacy_renamed is None and history_type is None and state_type is None:
            return False
        raise MigrationInvariantError("legacy_and_migrated_fbr_objects_conflict")

    if (
        compatibility_type is None
        and legacy_renamed is None
        and history_type is None
        and state_type is None
    ):
        return True

    raise MigrationInvariantError("unrecorded_or_partial_fbr_migration_schema")


def init_db(*, python_migrations: tuple[PythonMigration, ...] = ()) -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    registered_migrations = (
        *task_workflow_python_migrations(),
        *python_migrations,
    )
    try:
        # Validate an already-recorded Task workflow before the run-dispatch
        # contract.  Migration 0004 owns a merchant-delete guard that refers
        # to ``task_plans``; rebuilding that table can make SQLite drop the
        # guard as a side effect.  Checking the owning table contract first
        # keeps cold-start diagnostics stable and identifies the actual drift
        # instead of reporting the dependent guard as the root cause.
        if _migration_recorded(conn, TASK_WORKFLOW_MIGRATION):
            assert_task_workflow_table_contracts(conn)

        # Classify dispatch schema before any compatibility bridge can add a
        # missing column or CREATE IF NOT EXISTS object and thereby conceal a
        # partial/forged contract.
        validate_run_dispatch_migration_input(conn)

        # Normalize and checksum-check the complete registry before any schema
        # bridge. ``only_versions`` filters execution only, so legacy Task
        # marker adoption and every known checksum remain fail-closed here.
        apply_migrations(
            conn,
            python_migrations=registered_migrations,
            only_versions=frozenset(),
        )

        # Serialize legacy prerequisite bridging and the fresh-schema path.
        # The formal schema contains indexes that are invalid against the old
        # lowercase Task table, so legacy Task conversion must run first.
        conn.execute("BEGIN IMMEDIATE")
        try:
            _legacy_fbr_bootstrap_required(
                conn,
                python_migrations=registered_migrations,
            )
            kind = task_table_kind(conn)
            if kind != "missing":
                _assert_unique_coreai_run_bindings(conn)
                _bootstrap_runs_for_legacy_tasks(conn)
            _migrate(conn, include_run_dispatch_fields=False)
            if kind == "missing":
                execute_sql_payload(conn, SCHEMA_PATH.read_bytes())
                _migrate(conn, include_run_dispatch_fields=False)
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        if kind != "missing":
            apply_migrations(
                conn,
                python_migrations=registered_migrations,
                only_versions=frozenset({TASK_WORKFLOW_MIGRATION}),
            )

        # The operator command ledger is owned by 0001 and the 0004 merchant
        # delete guard references it.  Once any legacy Task table has been
        # converted, install 0001 explicitly so the dependent trigger can be
        # created and validated atomically by 0004.
        apply_migrations(
            conn,
            python_migrations=registered_migrations,
            only_versions=frozenset({PERFORMANCE_MIGRATION}),
        )

        # 0004 is deliberately applied before the full-schema bridge. Legacy
        # databases enter here only with every dispatch field absent; fresh
        # databases already have the exact schema and atomically adopt it.
        apply_migrations(
            conn,
            python_migrations=registered_migrations,
            only_versions=frozenset({RUN_DISPATCH_MIGRATION}),
        )

        # Once Task 0002 has replaced any legacy table, the complete schema is
        # safe to install. Keep this bridge under one writer lock as well.
        conn.execute("BEGIN IMMEDIATE")
        try:
            _migrate(conn, include_run_dispatch_fields=False)
            execute_sql_payload(conn, SCHEMA_PATH.read_bytes())
            _migrate(conn, include_run_dispatch_fields=False)
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS "
                "idx_local_falcon_scan_batch_confirmation "
                "ON merchant_local_falcon_scan_batches(confirmation_id) "
                "WHERE confirmation_id IS NOT NULL"
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        apply_migrations(conn, python_migrations=registered_migrations)
        assert_migration_registry_checksums(
            conn,
            python_migrations=registered_migrations,
        )
        if _legacy_fbr_bootstrap_required(
            conn,
            python_migrations=registered_migrations,
        ):
            raise MigrationInvariantError("fbr_migration_did_not_complete")
        assert_migration_postconditions(
            conn, version=PERFORMANCE_LIFECYCLE_MIGRATION
        )
        assert_task_workflow_migration_postconditions(conn)
        if conn.execute("PRAGMA foreign_key_check").fetchall():
            raise RuntimeError("database initialization left broken foreign keys")
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

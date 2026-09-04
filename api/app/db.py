import os
import sqlite3
from pathlib import Path

from app.migrations import (
    PERFORMANCE_MIGRATION,
    MigrationInvariantError,
    apply_migrations,
    assert_migration_postconditions,
    assert_migration_registry_checksums,
    register_sqlite_invariants,
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
    "runs": {"plan_approved_at": "TEXT"},
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


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in MIGRATION_COLUMNS.items():
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


def _object_type(conn: sqlite3.Connection, name: str) -> str | None:
    row = conn.execute(
        "SELECT type FROM sqlite_master WHERE name = ?", (name,)
    ).fetchone()
    return None if row is None else str(row[0])


def _migration_recorded(conn: sqlite3.Connection) -> bool:
    if _object_type(conn, "schema_migrations") != "table":
        return False
    return (
        conn.execute(
            "SELECT 1 FROM schema_migrations WHERE version = ?",
            (PERFORMANCE_MIGRATION,),
        ).fetchone()
        is not None
    )


def _legacy_fbr_bootstrap_required(conn: sqlite3.Connection) -> bool:
    """Validate the FBR schema boundary without mutating it."""
    assert_migration_registry_checksums(conn)
    recorded = _migration_recorded(conn)
    compatibility_type = _object_type(conn, "merchant_fbr_links")
    legacy_renamed = _object_type(conn, "merchant_fbr_links_legacy")
    history_type = _object_type(conn, "merchant_fbr_binding_events")
    state_type = _object_type(conn, "merchant_fbr_link_state")

    if recorded:
        if (
            compatibility_type == "view"
            and legacy_renamed is None
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


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        _legacy_fbr_bootstrap_required(conn)
        _migrate(conn)
        conn.executescript(SCHEMA_PATH.read_text())
        # Existing databases may already contain the scan batch table while the
        # confirmation table is introduced by the schema above.
        _migrate(conn)
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key"
            " ON tasks(source_key) WHERE source_key IS NOT NULL"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_local_falcon_scan_batch_confirmation"
            " ON merchant_local_falcon_scan_batches(confirmation_id)"
            " WHERE confirmation_id IS NOT NULL"
        )
        apply_migrations(conn)
        assert_migration_registry_checksums(conn)
        if _legacy_fbr_bootstrap_required(conn):
            raise MigrationInvariantError("fbr_migration_did_not_complete")
        assert_migration_postconditions(conn, version=PERFORMANCE_MIGRATION)
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

import os
import sqlite3
from pathlib import Path

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"
DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "data" / "seo-ops-v3.db"


def db_path() -> str:
    return os.environ.get("SEO_OPS_DB", str(DEFAULT_DB_PATH))


def connect() -> sqlite3.Connection:
    # FastAPI 会把同步依赖的创建和路由函数放到线程池的不同线程执行；
    # 每个请求独享一条连接、顺序使用，因此跨线程是安全的。
    conn = sqlite3.connect(db_path(), check_same_thread=False)
    conn.row_factory = sqlite3.Row
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


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
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
        conn.commit()
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

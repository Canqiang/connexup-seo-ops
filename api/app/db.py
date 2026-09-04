import os
import sqlite3
from pathlib import Path

from .task_migrations import migrate_task_workflow_v1, task_table_kind

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
    "tasks": {"source_run_id": "INTEGER REFERENCES runs(id)", "source_key": "TEXT", "expected_outcome": "TEXT", "category": "TEXT", "scheduled_start": "TEXT"},
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


def _bootstrap_runs_for_legacy_tasks(conn: sqlite3.Connection) -> None:
    """Create only the missing parent needed before rebuilding a first-brick DB."""

    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'"
    ).fetchone():
        return
    conn.execute(
        """
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
        )
        """
    )


def _assert_unique_coreai_run_bindings(conn: sqlite3.Connection) -> None:
    sources: list[str] = []
    for table in ("runs", "task_executions"):
        columns = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "coreai_run_id" in columns:
            sources.append(
                f"SELECT coreai_run_id FROM {table} WHERE coreai_run_id IS NOT NULL"
            )
    if not sources:
        return
    duplicate = conn.execute(
        "SELECT coreai_run_id FROM ("
        + " UNION ALL ".join(sources)
        + ") GROUP BY coreai_run_id HAVING COUNT(*) > 1 LIMIT 1"
    ).fetchone()
    if duplicate is not None:
        raise RuntimeError("database contains duplicate coreai_run_id bindings")


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        _assert_unique_coreai_run_bindings(conn)
        _migrate(conn)
        conn.commit()
        kind = task_table_kind(conn)
        if kind == "legacy":
            _bootstrap_runs_for_legacy_tasks(conn)
            conn.commit()
            migrate_task_workflow_v1(conn)
            conn.executescript(SCHEMA_PATH.read_text())
        else:
            conn.executescript(SCHEMA_PATH.read_text())
            migrate_task_workflow_v1(conn)
        _migrate(conn)
        conn.commit()
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

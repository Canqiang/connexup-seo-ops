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
    "merchants": {"auto_run_interval_days": "INTEGER"},
    "tasks": {"source_run_id": "INTEGER REFERENCES runs(id)", "source_key": "TEXT", "expected_outcome": "TEXT", "category": "TEXT", "scheduled_start": "TEXT"},
}


def _migrate(conn: sqlite3.Connection) -> None:
    for table, cols in MIGRATION_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if not existing:
            continue  # 全新库，表还没建，executescript 已带新列
        for col, decl in cols.items():
            if col not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        _migrate(conn)
        conn.executescript(SCHEMA_PATH.read_text())
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key"
            " ON tasks(source_key) WHERE source_key IS NOT NULL"
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

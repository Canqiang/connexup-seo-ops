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


def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        conn.executescript(SCHEMA_PATH.read_text())
        conn.commit()
    finally:
        conn.close()


def get_db():
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()

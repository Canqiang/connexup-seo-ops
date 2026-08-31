import sqlite3


def test_init_db_creates_tables(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "t.db"))
    from app.db import init_db

    init_db()
    init_db()  # 幂等
    conn = sqlite3.connect(tmp_path / "t.db")
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"merchants", "tasks"} <= names


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
    assert {"source_run_id", "source_key"} <= task_cols
    assert "runs" in tables
    assert "idx_tasks_source_key" in indexes

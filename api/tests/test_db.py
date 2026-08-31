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

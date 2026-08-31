import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for var in ("COREAI_BASE_URL", "COREAI_API_KEY", "COREAI_AGENT_ID"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "test.db"))
    from app.db import init_db

    init_db()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c

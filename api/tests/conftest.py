import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for var in (
        "COREAI_BASE_URL",
        "COREAI_API_KEY",
        "COREAI_AGENT_ID",
        "COREAI_EXECUTION_AGENT_ID",
        "COREAI_KEYWORD_AGENT_ID",
        "COREAI_AUDIT_AGENT_ID",
        "COREAI_RANKING_AGENT_ID",
        "COREAI_LOCAL_FALCON_TOOL_ID",
        "COREAI_KEYWORD_SKILL_AGENT_ID",
        "COREAI_KEYWORD_SEED_SKILL_ID",
        "COREAI_KEYWORD_RANKING_SKILL_ID",
        "FBR_SEO_BASE_URL",
        "FBR_SEO_BEARER_TOKEN",
        "FBR_SEO_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "test.db"))
    monkeypatch.setenv("SEO_OPS_AUTH_USERNAME", "test")
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", "seo-ops-test")
    monkeypatch.setenv("SEO_OPS_AUTH_SECRET", "test-secret-that-is-at-least-32-chars")
    monkeypatch.setenv("SEO_OPS_COOKIE_SECURE", "false")
    from app.db import init_db

    init_db()
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        response = c.post(
            "/api/auth/login",
            json={"username": "test", "password": "seo-ops-test"},
        )
        assert response.status_code == 200
        yield c

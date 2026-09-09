import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


@pytest.fixture(autouse=True)
def isolate_orchestrator_configuration(monkeypatch):
    monkeypatch.delenv("COREAI_ORCHESTRATOR_AGENT_ID", raising=False)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    for var in (
        "COREAI_BASE_URL",
        "COREAI_API_KEY",
        "COREAI_AGENT_ID",
        "COREAI_EXECUTION_AGENT_ID",
        "COREAI_PREPARATION_LLM_CALL_ID",
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
        "SEO_OPS_OPERATOR_TIMEZONE",
        "SEO_OPS_AGENT_HISTORY_LIMIT",
        "SEO_OPS_TASK_AGENT_BINDINGS",
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


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "performance.db"))
    from app.db import connect, init_db

    init_db()
    connection = connect()
    try:
        yield connection
    finally:
        connection.close()


@pytest.fixture()
def gold_payload():
    return json.loads(
        (Path(__file__).parent / "fixtures/performance/gbp_choice_brooklyn_gold.json").read_text("utf-8")
    )


@pytest.fixture()
def merchant_with_gbp_profiles(conn):
    """Seed Choice Brooklyn (merchant 3) with its two real GBP location profiles."""
    conn.execute(
        "INSERT INTO merchants (id, name, status, created_at) VALUES"
        " (3,'Choice Brooklyn','active','2026-09-01T00:00:00.000000Z')"
    )
    for location_id, title, place_id in (
        ("1860638126797610816", "Clinton Hill", "ChIJaYcllU0N7ocR4lWiLngfEYg"),
        ("24300588970198995", "Upper West Side", "ChIJH8iZh-5ZwokRPLzzADeSnYE"),
    ):
        conn.execute(
            "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id,"
            " source_title, location_json, normalized_json, synced_at) VALUES"
            " (3,'fbr-3',?,?,'{}',?,'2026-09-03T00:00:00.000000Z')",
            (location_id, title, json.dumps({"title": title, "place_id": place_id})),
        )
    conn.commit()
    return 3

def test_coreai_settings_none_when_unset(monkeypatch):
    for var in ("COREAI_BASE_URL", "COREAI_API_KEY", "COREAI_AGENT_ID"):
        monkeypatch.delenv(var, raising=False)
    from app.config import coreai_settings

    assert coreai_settings() is None


def test_coreai_settings_reads_env_and_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example.com/")
    monkeypatch.setenv("COREAI_API_KEY", "coreai_test")
    monkeypatch.setenv("COREAI_AGENT_ID", "agent-1")
    from app.config import coreai_settings

    s = coreai_settings()
    assert s is not None
    assert s.base_url == "https://core.example.com"
    assert s.api_key == "coreai_test"
    assert s.agent_id == "agent-1"

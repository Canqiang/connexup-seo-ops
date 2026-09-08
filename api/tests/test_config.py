from pathlib import Path

import pytest


def test_workbench_connection_repr_redacts_api_key():
    from app.config import CoreAiConnectionSettings

    settings = CoreAiConnectionSettings(
        base_url="https://core.example",
        api_key="secret",
    )
    assert "secret" not in repr(settings)


def test_workbench_connection_does_not_require_primary_agent(monkeypatch):
    from app.config import (
        CoreAiConnectionSettings,
        coreai_connection_settings,
        coreai_settings,
    )

    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example/")
    monkeypatch.setenv("COREAI_API_KEY", "secret")
    monkeypatch.delenv("COREAI_AGENT_ID", raising=False)
    assert coreai_settings() is None
    assert coreai_connection_settings() == CoreAiConnectionSettings(
        base_url="https://core.example",
        api_key="secret",
    )


def test_agent_workbench_settings_defaults_and_bounds(monkeypatch):
    from app.config import agent_workbench_settings

    monkeypatch.delenv("SEO_OPS_OPERATOR_TIMEZONE", raising=False)
    monkeypatch.delenv("SEO_OPS_AGENT_HISTORY_LIMIT", raising=False)
    settings = agent_workbench_settings()
    assert settings.timezone.key == "Asia/Shanghai"
    assert settings.history_limit == 200

    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "  ")
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "  ")
    settings = agent_workbench_settings()
    assert settings.timezone.key == "Asia/Shanghai"
    assert settings.history_limit == 200

    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "America/New_York")
    settings = agent_workbench_settings()
    assert settings.timezone.key == "America/New_York"

    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "Not/A_Timezone")
    with pytest.raises(ValueError, match="SEO_OPS_OPERATOR_TIMEZONE"):
        agent_workbench_settings()

    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "Asia/Shanghai")
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "2.5")
    with pytest.raises(ValueError, match="SEO_OPS_AGENT_HISTORY_LIMIT"):
        agent_workbench_settings()

    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "1")
    assert agent_workbench_settings().history_limit == 1
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "0")
    with pytest.raises(ValueError, match="SEO_OPS_AGENT_HISTORY_LIMIT"):
        agent_workbench_settings()

    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "1000")
    assert agent_workbench_settings().history_limit == 1000
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "1001")
    with pytest.raises(ValueError, match="SEO_OPS_AGENT_HISTORY_LIMIT"):
        agent_workbench_settings()


def test_agent_workbench_settings_normalizes_path_like_timezone_error(monkeypatch):
    from app.config import agent_workbench_settings

    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "/etc/passwd")
    with pytest.raises(ValueError, match="^invalid SEO_OPS_OPERATOR_TIMEZONE$"):
        agent_workbench_settings()


def test_configured_agent_slots_exact_order(monkeypatch):
    from app.config import configured_agent_slots

    env_names = (
        "COREAI_AGENT_ID",
        "COREAI_EXECUTION_AGENT_ID",
        "COREAI_KEYWORD_AGENT_ID",
        "COREAI_AUDIT_AGENT_ID",
        "COREAI_RANKING_AGENT_ID",
        "COREAI_KEYWORD_SKILL_AGENT_ID",
    )
    for position, env_name in enumerate(env_names, start=1):
        monkeypatch.setenv(env_name, f"agent-{position}")

    slots = configured_agent_slots()
    assert [(slot.env_name, slot.agent_key) for slot in slots] == [
        ("COREAI_AGENT_ID", "diagnosis-plan"),
        ("COREAI_EXECUTION_AGENT_ID", "task-preparation"),
        ("COREAI_KEYWORD_AGENT_ID", "keyword-research"),
        ("COREAI_AUDIT_AGENT_ID", "seo-audit"),
        ("COREAI_RANKING_AGENT_ID", "ranking-analysis"),
        ("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-workflow"),
    ]
    assert [
        (slot.display_name, slot.role, slot.sort_order, slot.coreai_agent_id)
        for slot in slots
    ] == [
        ("诊断与计划 Agent", "诊断商户并生成可审核 SEO 计划", 10, "agent-1"),
        ("任务准备 Agent", "为已批准任务准备执行材料", 20, "agent-2"),
        ("关键词研究 Agent", "生成和整理本地搜索关键词", 30, "agent-3"),
        ("SEO 审计 Agent", "执行 SEO 审计与改进建议", 40, "agent-4"),
        ("排名分析 Agent", "分析本地搜索排名与变化", 50, "agent-5"),
        ("关键词 Skill Agent", "编排关键词研究 Skill 工作流", 60, "agent-6"),
    ]


def test_configured_agent_slots_explicit_mapping_never_falls_back_to_environment(
    monkeypatch,
):
    from app.config import configured_agent_slots

    for env_name in (
        "COREAI_ORCHESTRATOR_AGENT_ID",
        "COREAI_AGENT_ID",
        "COREAI_EXECUTION_AGENT_ID",
        "COREAI_KEYWORD_AGENT_ID",
        "COREAI_AUDIT_AGENT_ID",
        "COREAI_RANKING_AGENT_ID",
        "COREAI_KEYWORD_SKILL_AGENT_ID",
    ):
        monkeypatch.setenv(env_name, f"ambient-{env_name.lower()}")

    slots = configured_agent_slots({"COREAI_AUDIT_AGENT_ID": " explicit-audit "})
    assert [(slot.env_name, slot.coreai_agent_id) for slot in slots] == [
        ("COREAI_AUDIT_AGENT_ID", "explicit-audit")
    ]
    assert configured_agent_slots({}) == ()


def test_env_example_exposes_current_task_preparation_setting():
    env_example = Path(__file__).parents[1] / ".env.example"
    keys = {
        line.partition("=")[0]
        for line in env_example.read_text().splitlines()
        if line and not line.startswith("#") and "=" in line
    }

    assert "COREAI_PREPARATION_LLM_CALL_ID" in keys
    assert "COREAI_EXECUTION_AGENT_ID" not in keys
    assert "SEO_OPS_OPERATOR_TIMEZONE" in keys
    assert "SEO_OPS_AGENT_HISTORY_LIMIT" in keys


def test_coreai_settings_none_when_unset(monkeypatch):
    for var in (
        "COREAI_BASE_URL",
        "COREAI_API_KEY",
        "COREAI_AGENT_ID",
        "COREAI_EXECUTION_AGENT_ID",
        "COREAI_PREPARATION_LLM_CALL_ID",
    ):
        monkeypatch.delenv(var, raising=False)
    from app.config import coreai_settings

    assert coreai_settings() is None


def test_coreai_settings_reads_env_and_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example.com/")
    monkeypatch.setenv("COREAI_API_KEY", "coreai_test")
    monkeypatch.setenv("COREAI_AGENT_ID", "agent-1")
    monkeypatch.setenv("COREAI_PREPARATION_LLM_CALL_ID", "llm-call-preparation")
    monkeypatch.setenv("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-agent")
    monkeypatch.setenv("COREAI_KEYWORD_SEED_SKILL_ID", "seed-skill")
    monkeypatch.setenv("COREAI_KEYWORD_RANKING_SKILL_ID", "ranking-skill")
    from app.config import coreai_settings

    s = coreai_settings()
    assert s is not None
    assert s.base_url == "https://core.example.com"
    assert s.api_key == "coreai_test"
    assert s.agent_id == "agent-1"
    assert s.preparation_llm_call_id == "llm-call-preparation"
    assert s.keyword_skill_agent_id == "keyword-skill-agent"
    assert s.keyword_seed_skill_id == "seed-skill"
    assert s.keyword_ranking_skill_id == "ranking-skill"


@pytest.mark.parametrize(
    "explicit,legacy,expected",
    [
        (" orchestrator ", "legacy", "orchestrator"),
        ("orchestrator", "", "orchestrator"),
        ("  ", " legacy ", "legacy"),
        ("", "", None),
    ],
)
def test_planning_identity_resolution(monkeypatch, explicit, legacy, expected):
    from app.config import coreai_settings

    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "test-only")
    monkeypatch.setenv("COREAI_ORCHESTRATOR_AGENT_ID", explicit)
    monkeypatch.setenv("COREAI_AGENT_ID", legacy)
    settings = coreai_settings()
    assert (settings.agent_id if settings else None) == expected


@pytest.mark.parametrize("missing", ["COREAI_BASE_URL", "COREAI_API_KEY"])
def test_orchestrator_still_requires_connection(monkeypatch, missing):
    from app.config import coreai_settings

    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "test-only")
    monkeypatch.setenv("COREAI_ORCHESTRATOR_AGENT_ID", "orchestrator")
    monkeypatch.delenv(missing, raising=False)
    assert coreai_settings() is None


@pytest.mark.parametrize(
    "legacy,expected",
    [
        ("", [("orchestrator", "planner")]),
        (" planner ", [("orchestrator", "planner")]),
        ("old", [("orchestrator", "planner"), ("diagnosis-plan", "old")]),
    ],
)
def test_orchestrator_bootstrap_identity(legacy, expected):
    from app.config import configured_agent_slots

    slots = configured_agent_slots(
        {"COREAI_ORCHESTRATOR_AGENT_ID": " planner ", "COREAI_AGENT_ID": legacy}
    )
    assert [(s.agent_key, s.coreai_agent_id) for s in slots] == expected


def test_blank_orchestrator_preserves_legacy_registration():
    from app.config import configured_agent_slots

    slots = configured_agent_slots(
        {"COREAI_ORCHESTRATOR_AGENT_ID": " ", "COREAI_AGENT_ID": "legacy"}
    )
    assert [(s.agent_key, s.coreai_agent_id) for s in slots] == [
        ("diagnosis-plan", "legacy")
    ]

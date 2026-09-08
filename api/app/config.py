import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


@dataclass(frozen=True)
class CoreAiConnectionSettings:
    base_url: str
    api_key: str = field(repr=False)


def coreai_connection_settings() -> CoreAiConnectionSettings | None:
    base_url = os.environ.get("COREAI_BASE_URL", "").strip()
    api_key = os.environ.get("COREAI_API_KEY", "").strip()
    if not (base_url and api_key):
        return None
    return CoreAiConnectionSettings(
        base_url=base_url.rstrip("/"),
        api_key=api_key,
    )


@dataclass(frozen=True)
class AgentWorkbenchSettings:
    timezone: ZoneInfo
    history_limit: int


def agent_workbench_settings() -> AgentWorkbenchSettings:
    timezone_name = os.environ.get("SEO_OPS_OPERATOR_TIMEZONE", "").strip()
    history_limit_value = os.environ.get("SEO_OPS_AGENT_HISTORY_LIMIT", "").strip()
    try:
        timezone = ZoneInfo(timezone_name or "Asia/Shanghai")
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("invalid SEO_OPS_OPERATOR_TIMEZONE") from exc
    try:
        history_limit = int(history_limit_value) if history_limit_value else 200
    except ValueError as exc:
        raise ValueError("invalid SEO_OPS_AGENT_HISTORY_LIMIT") from exc
    if history_limit < 1:
        raise ValueError("invalid SEO_OPS_AGENT_HISTORY_LIMIT")
    if history_limit > 1000:
        raise ValueError("invalid SEO_OPS_AGENT_HISTORY_LIMIT")
    return AgentWorkbenchSettings(
        timezone=timezone,
        history_limit=history_limit,
    )


@dataclass(frozen=True)
class BootstrapAgentSlot:
    env_name: str
    agent_key: str
    display_name: str
    role: str
    sort_order: int
    coreai_agent_id: str


BOOTSTRAP_AGENT_SLOTS = (
    (
        "COREAI_ORCHESTRATOR_AGENT_ID",
        "orchestrator",
        "运营编排 Agent",
        "根据商户证据提出可审核运营计划",
        5,
    ),
    (
        "COREAI_AGENT_ID",
        "diagnosis-plan",
        "诊断与计划 Agent",
        "诊断商户并生成可审核 SEO 计划",
        10,
    ),
    (
        "COREAI_EXECUTION_AGENT_ID",
        "task-preparation",
        "任务准备 Agent",
        "为已批准任务准备执行材料",
        20,
    ),
    (
        "COREAI_KEYWORD_AGENT_ID",
        "keyword-research",
        "关键词研究 Agent",
        "生成和整理本地搜索关键词",
        30,
    ),
    (
        "COREAI_AUDIT_AGENT_ID",
        "seo-audit",
        "SEO 审计 Agent",
        "执行 SEO 审计与改进建议",
        40,
    ),
    (
        "COREAI_RANKING_AGENT_ID",
        "ranking-analysis",
        "排名分析 Agent",
        "分析本地搜索排名与变化",
        50,
    ),
    (
        "COREAI_KEYWORD_SKILL_AGENT_ID",
        "keyword-skill-workflow",
        "关键词 Skill Agent",
        "编排关键词研究 Skill 工作流",
        60,
    ),
)


def configured_agent_slots(
    values: Mapping[str, str] | None = None,
) -> tuple[BootstrapAgentSlot, ...]:
    source = os.environ if values is None else values
    slots = []
    orchestrator_id = source.get("COREAI_ORCHESTRATOR_AGENT_ID", "").strip()
    for env_name, agent_key, display_name, role, sort_order in BOOTSTRAP_AGENT_SLOTS:
        coreai_agent_id = source.get(env_name, "").strip()
        if agent_key == "diagnosis-plan" and orchestrator_id == coreai_agent_id:
            continue
        if coreai_agent_id:
            slots.append(
                BootstrapAgentSlot(
                    env_name=env_name,
                    agent_key=agent_key,
                    display_name=display_name,
                    role=role,
                    sort_order=sort_order,
                    coreai_agent_id=coreai_agent_id,
                )
            )
    return tuple(slots)


@dataclass(frozen=True)
class CoreAiSettings:
    base_url: str
    api_key: str
    agent_id: str
    preparation_llm_call_id: str | None = None
    keyword_agent_id: str | None = None
    audit_agent_id: str | None = None
    ranking_agent_id: str | None = None
    local_falcon_tool_id: str | None = None
    keyword_skill_agent_id: str | None = None
    keyword_seed_skill_id: str | None = None
    keyword_ranking_skill_id: str | None = None


def coreai_settings() -> CoreAiSettings | None:
    base_url = os.environ.get("COREAI_BASE_URL", "").strip()
    api_key = os.environ.get("COREAI_API_KEY", "").strip()
    agent_id = (
        os.environ.get("COREAI_ORCHESTRATOR_AGENT_ID", "").strip()
        or os.environ.get("COREAI_AGENT_ID", "").strip()
    )
    preparation_llm_call_id = (
        os.environ.get("COREAI_PREPARATION_LLM_CALL_ID", "").strip() or None
    )
    keyword_agent_id = os.environ.get("COREAI_KEYWORD_AGENT_ID", "").strip() or None
    audit_agent_id = os.environ.get("COREAI_AUDIT_AGENT_ID", "").strip() or None
    ranking_agent_id = os.environ.get("COREAI_RANKING_AGENT_ID", "").strip() or None
    local_falcon_tool_id = os.environ.get("COREAI_LOCAL_FALCON_TOOL_ID", "").strip() or None
    keyword_skill_agent_id = os.environ.get("COREAI_KEYWORD_SKILL_AGENT_ID", "").strip() or None
    keyword_seed_skill_id = os.environ.get("COREAI_KEYWORD_SEED_SKILL_ID", "").strip() or None
    keyword_ranking_skill_id = os.environ.get("COREAI_KEYWORD_RANKING_SKILL_ID", "").strip() or None
    if not (base_url and api_key and agent_id):
        return None
    return CoreAiSettings(
        base_url=base_url.rstrip("/"),
        api_key=api_key,
        agent_id=agent_id,
        preparation_llm_call_id=preparation_llm_call_id,
        keyword_agent_id=keyword_agent_id,
        audit_agent_id=audit_agent_id,
        ranking_agent_id=ranking_agent_id,
        local_falcon_tool_id=local_falcon_tool_id,
        keyword_skill_agent_id=keyword_skill_agent_id,
        keyword_seed_skill_id=keyword_seed_skill_id,
        keyword_ranking_skill_id=keyword_ranking_skill_id,
    )

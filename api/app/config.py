import os
from dataclasses import dataclass


@dataclass(frozen=True)
class CoreAiSettings:
    base_url: str
    api_key: str
    agent_id: str
    execution_agent_id: str | None = None
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
    agent_id = os.environ.get("COREAI_AGENT_ID", "").strip()
    execution_agent_id = os.environ.get("COREAI_EXECUTION_AGENT_ID", "").strip() or None
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
        execution_agent_id=execution_agent_id,
        keyword_agent_id=keyword_agent_id,
        audit_agent_id=audit_agent_id,
        ranking_agent_id=ranking_agent_id,
        local_falcon_tool_id=local_falcon_tool_id,
        keyword_skill_agent_id=keyword_skill_agent_id,
        keyword_seed_skill_id=keyword_seed_skill_id,
        keyword_ranking_skill_id=keyword_ranking_skill_id,
    )

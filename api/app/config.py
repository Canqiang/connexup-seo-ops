import os
from dataclasses import dataclass


@dataclass(frozen=True)
class CoreAiSettings:
    base_url: str
    api_key: str
    agent_id: str
    execution_agent_id: str | None = None


def coreai_settings() -> CoreAiSettings | None:
    base_url = os.environ.get("COREAI_BASE_URL", "").strip()
    api_key = os.environ.get("COREAI_API_KEY", "").strip()
    agent_id = os.environ.get("COREAI_AGENT_ID", "").strip()
    execution_agent_id = os.environ.get("COREAI_EXECUTION_AGENT_ID", "").strip() or None
    if not (base_url and api_key and agent_id):
        return None
    return CoreAiSettings(base_url.rstrip("/"), api_key, agent_id, execution_agent_id)

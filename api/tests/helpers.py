class FakeCoreAi:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.triggered: list[tuple[str, str]] = []
        self.runs: dict[str, dict] = {}
        self.agent_definition = {
            "id": "agent-t",
            "status": "PUBLISHED",
            "tools": [],
            "skill_ids": [],
            "subagent_ids": [],
            "sandbox_config": None,
            "dataset_config": None,
        }

    def get_agent(self, agent_id: str) -> dict:
        return {**self.agent_definition, "id": agent_id}

    def trigger(self, agent_id: str, input_text: str) -> dict:
        from app.coreai import CoreAiError

        if self.fail:
            raise CoreAiError(500, "core-ai down")
        rid = f"core-{len(self.triggered) + 1}"
        self.triggered.append((agent_id, input_text))
        self.runs[rid] = {"id": rid, "status": "RUNNING"}
        return {"run_id": rid, "status": "RUNNING"}

    def get_run(self, run_id: str) -> dict:
        return self.runs[run_id]


def override_coreai(fake, agent_id="agent-t"):
    from app.main import app
    from app.runs import get_coreai

    app.dependency_overrides[get_coreai] = lambda: (fake, agent_id)
    return app


def cleanup_override():
    from app.main import app

    app.dependency_overrides.clear()

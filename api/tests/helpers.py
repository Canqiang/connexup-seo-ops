class FakeCoreAi:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.triggered: list[tuple[str, str]] = []
        self.llm_calls: list[tuple[str, str]] = []
        self.runs: dict[str, dict] = {}
        self.llm_output = (
            '{"artifact_refs":["artifact://result-v1"],'
            '"evidence":["Generated from verified merchant context"],'
            '"external_write_performed":false,"outcome":"ready",'
            '"summary":"Prepared a reviewable artifact"}'
        )
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

    def llm_call(self, llm_call_id: str, input_text: str) -> str:
        from app.coreai import CoreAiError

        if self.fail:
            raise CoreAiError(500, "core-ai down")
        self.llm_calls.append((llm_call_id, input_text))
        return self.llm_output

    def get_run(self, run_id: str) -> dict:
        return {"id": run_id, **self.runs[run_id]}


def override_coreai(fake, agent_id="agent-t"):
    from app.main import app
    from app.runs import get_coreai

    app.dependency_overrides[get_coreai] = lambda: (fake, agent_id)
    return app


def cleanup_override():
    from app.main import app

    app.dependency_overrides.clear()

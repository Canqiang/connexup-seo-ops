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
            "dataset_config": [],
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


def seed_fbr_link(
    conn,
    merchant_id: int,
    *,
    fbr_merchant_id: str,
    sync_status: str,
    last_synced_at: str | None = None,
    last_error: str | None = None,
) -> None:
    """Seed the history/state source of truth used by the compatibility view."""
    from app.migrations import register_sqlite_invariants

    register_sqlite_invariants(conn)
    created_at = "2026-09-03T00:00:00.000000Z"
    conn.execute(
        "INSERT INTO merchant_fbr_binding_events("
        "merchant_id,fbr_merchant_id,generation,valid_from,opened_by,open_reason,created_at"
        ") VALUES (?,?,1,?,'test','test_fixture',?)",
        (merchant_id, fbr_merchant_id, created_at, created_at),
    )
    conn.execute(
        "INSERT INTO merchant_fbr_link_state("
        "merchant_id,sync_status,last_synced_at,last_error,created_at,updated_at"
        ") VALUES (?,?,?,?,?,?)",
        (
            merchant_id,
            sync_status,
            last_synced_at,
            last_error,
            created_at,
            created_at,
        ),
    )

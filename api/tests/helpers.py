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
            "type": "AGENT",
            "published_at": "2026-09-04T00:00:00+00:00",
            "updated_at": "2026-09-04T00:00:00+00:00",
            "tools": [],
            "skill_ids": [],
            "subagent_ids": [],
            "sandbox_config": None,
            "dataset_config": None,
            "enable_memory": False,
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


def force_merchant_lifecycle_transitions(
    merchant_id: int, statuses: tuple[str, ...]
) -> None:
    """Record test-only lifecycle transitions, including otherwise-blocked races."""

    import os
    import sqlite3

    from app.migrations import content_sha256, register_sqlite_invariants

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    register_sqlite_invariants(conn)
    try:
        conn.execute("BEGIN IMMEDIATE")
        generation = int(
            conn.execute(
                "SELECT COALESCE(MAX(generation), 0) FROM merchant_status_events "
                "WHERE merchant_id = ?",
                (merchant_id,),
            ).fetchone()[0]
        )
        for offset, status in enumerate(statuses, start=1):
            current_generation = generation + offset
            stamp = f"2026-09-04T00:00:00.{current_generation:06d}Z"
            actor = "test_lifecycle_race"
            reason = f"forced_{status}"
            conn.execute(
                "UPDATE merchants SET status = ? WHERE id = ?",
                (status, merchant_id),
            )
            conn.execute(
                "INSERT INTO merchant_status_events("
                "merchant_id,status,effective_at,generation,actor,reason,"
                "content_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
                (
                    merchant_id,
                    status,
                    stamp,
                    current_generation,
                    actor,
                    reason,
                    content_sha256(
                        merchant_id,
                        status,
                        stamp,
                        current_generation,
                        actor,
                        reason,
                    ),
                    stamp,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def force_merchant_lifecycle_cycle(merchant_id: int) -> None:
    """Simulate an archive/restore ABA while a provider call is in flight."""

    force_merchant_lifecycle_transitions(merchant_id, ("archived", "active"))


def formal_workflow_snapshot() -> dict[str, list[tuple]]:
    """Return immutable comparable rows for every formal workflow table."""

    import os
    import sqlite3

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    try:
        return {
            table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY 1")]
            for table in (
                "runs",
                "task_plans",
                "task_plan_revisions",
                "tasks",
                "task_dependencies",
                "task_executions",
                "task_events",
            )
        }
    finally:
        conn.close()


def override_coreai(fake, agent_id="agent-t"):
    from app.main import app
    from app.runs import (
        get_coreai,
        get_optional_coreai,
        get_optional_coreai_provider,
    )

    app.dependency_overrides[get_coreai] = lambda: (fake, agent_id)
    app.dependency_overrides[get_optional_coreai] = lambda: (fake, agent_id)
    app.dependency_overrides[get_optional_coreai_provider] = lambda: (
        lambda: (fake, agent_id)
    )
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

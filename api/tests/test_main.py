import asyncio
import os
import subprocess
import sys
from datetime import datetime, timezone

import pytest


def test_import_and_create_app_perform_zero_database_io(tmp_path):
    database = tmp_path / "must-not-exist.db"
    script = (
        "from contextlib import asynccontextmanager\n"
        "@asynccontextmanager\n"
        "async def noop(app):\n"
        "    yield\n"
        "from app.main import create_app\n"
        "create_app(noop)\n"
    )
    env = dict(os.environ)
    env["SEO_OPS_DB"] = str(database)
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=os.path.dirname(os.path.dirname(__file__)),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert not database.exists()


def test_lifespan_seeds_primes_then_starts_all_three_loops(tmp_path, monkeypatch):
    from app import main
    from app.config import BootstrapAgentSlot
    from app.db import connect

    events = []
    startup_at = datetime(2026, 9, 3, tzinfo=timezone.utc)
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "lifespan.db"))
    monkeypatch.setattr(main, "utc_now", lambda: startup_at)
    monkeypatch.setattr(
        main,
        "configured_agent_slots",
        lambda: (
            BootstrapAgentSlot(
                env_name="COREAI_AGENT_ID",
                agent_key="diagnosis-plan",
                display_name="Diagnosis Agent",
                role="Diagnosis",
                sort_order=10,
                coreai_agent_id="agent-primary",
            ),
        ),
    )

    def startup():
        main.initialize_writable_application()
        events.append("startup")

    def loop(name):
        async def run():
            conn = connect()
            try:
                row = conn.execute(
                    "SELECT s.next_discovery_at FROM seo_ops_agents a "
                    "JOIN seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id "
                    "WHERE a.coreai_agent_id='agent-primary'"
                ).fetchone()
                assert row["next_discovery_at"] == startup_at.isoformat()
            finally:
                conn.close()
            events.append(f"start:{name}")
            try:
                await asyncio.Event().wait()
            finally:
                events.append(f"stop:{name}")

        return run

    async def exercise():
        lifespan = main.create_lifespan(
            startup, loop("scheduler"), loop("fbr"), loop("workbench")
        )
        async with lifespan(None):
            await asyncio.sleep(0)
            assert events == [
                "startup",
                "start:scheduler",
                "start:fbr",
                "start:workbench",
            ]

    asyncio.run(exercise())
    assert events[-3:] == [
        "stop:scheduler",
        "stop:fbr",
        "stop:workbench",
    ]


@pytest.mark.parametrize("raising_loop", [None, "fbr"])
def test_lifespan_cancels_and_awaits_all_three_loops(raising_loop):
    from app.main import create_lifespan

    finalized = []

    def loop(name):
        async def run():
            try:
                await asyncio.Event().wait()
            finally:
                finalized.append(name)
                if name == raising_loop:
                    raise RuntimeError("shutdown sentinel")

        return run

    async def exercise():
        lifespan = create_lifespan(
            lambda: None,
            loop("scheduler"),
            loop("fbr"),
            loop("workbench"),
        )
        async with lifespan(None):
            await asyncio.sleep(0)

    asyncio.run(exercise())
    assert set(finalized) == {"scheduler", "fbr", "workbench"}


def _route_shape(application):
    return {
        (
            route.path,
            tuple(sorted(route.methods or ())),
            len(route.dependant.dependencies),
        )
        for route in application.routes
        if hasattr(route, "dependant")
    }


def test_app_factory_preserves_routes_with_injected_lifespan():
    from contextlib import asynccontextmanager

    from app.main import app, create_app

    @asynccontextmanager
    async def injected(_application):
        yield

    injected_app = create_app(injected)
    assert _route_shape(injected_app) == _route_shape(app)


def test_workbench_routes_require_operator(client):
    from contextlib import asynccontextmanager

    from fastapi.testclient import TestClient

    from app.main import create_app

    @asynccontextmanager
    async def noop(_application):
        yield

    unauthenticated = create_app(noop)
    routes = [
        ("GET", "/api/agent-workbench"),
        ("GET", "/api/agent-workbench/agents/missing/runs"),
        ("POST", "/api/agent-workbench/agents"),
        ("PATCH", "/api/agent-workbench/agents/missing"),
        ("POST", "/api/agent-workbench/agents/missing/retire"),
        ("POST", "/api/agent-workbench/agents/missing/replace"),
    ]
    with TestClient(unauthenticated) as anonymous:
        for method, path in routes:
            response = anonymous.request(method, path)
            assert response.status_code == 401, (method, path, response.text)

    aggregate = client.get("/api/agent-workbench")
    assert aggregate.status_code == 200, aggregate.text

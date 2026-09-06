import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from .agent_workbench import (
    agent_workbench_sync_loop,
    prime_agent_workbench_startup,
    router as agent_workbench_router,
    seed_configured_agents,
    utc_now,
)
from .audit_snapshots import router as audits_router
from .auth import require_operator, router as auth_router
from .config import configured_agent_slots
from .db import connect, init_db
from .merchants import router as merchants_router
from .merchant_profiles import identity_router, router as merchant_profiles_router
from .performance_dashboard import router as performance_dashboard_router
from .runs import router as runs_router
from .scheduler import fbr_scheduler_loop, scheduler_loop
from .seo_targets import router as seo_targets_router
from .task_plans import router as task_plans_router
from .tasks import router as tasks_router


def initialize_writable_application() -> None:
    init_db()
    conn = connect()
    try:
        startup_at = utc_now()
        seed_configured_agents(conn, configured_agent_slots(), startup_at)
        prime_agent_workbench_startup(conn, startup_at)
        conn.commit()
    finally:
        conn.close()


def create_lifespan(
    startup_callable,
    scheduler_coro,
    fbr_scheduler_coro,
    workbench_coro,
):
    @asynccontextmanager
    async def lifespan_context(app: FastAPI):
        startup_callable()
        background_tasks = [
            asyncio.create_task(scheduler_coro()),
            asyncio.create_task(fbr_scheduler_coro()),
            asyncio.create_task(workbench_coro()),
        ]
        try:
            yield
        finally:
            for task in background_tasks:
                task.cancel()
            await asyncio.gather(*background_tasks, return_exceptions=True)

    return lifespan_context


def create_app(lifespan_context) -> FastAPI:
    application = FastAPI(title="SEO Ops API", lifespan=lifespan_context)
    application.include_router(auth_router)
    operator_dependencies = [Depends(require_operator)]
    application.include_router(
        merchants_router, dependencies=operator_dependencies
    )
    application.include_router(
        merchant_profiles_router, dependencies=operator_dependencies
    )
    application.include_router(identity_router, dependencies=operator_dependencies)
    application.include_router(tasks_router, dependencies=operator_dependencies)
    application.include_router(runs_router, dependencies=operator_dependencies)
    application.include_router(
        task_plans_router, dependencies=operator_dependencies
    )
    application.include_router(audits_router, dependencies=operator_dependencies)
    application.include_router(
        seo_targets_router, dependencies=operator_dependencies
    )
    application.include_router(
        performance_dashboard_router, dependencies=operator_dependencies
    )
    application.include_router(
        agent_workbench_router, dependencies=operator_dependencies
    )
    return application


lifespan = create_lifespan(
    initialize_writable_application,
    scheduler_loop,
    fbr_scheduler_loop,
    agent_workbench_sync_loop,
)
app = create_app(lifespan)

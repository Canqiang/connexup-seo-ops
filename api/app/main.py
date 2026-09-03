import asyncio
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI

from .audit_snapshots import router as audits_router
from .auth import require_operator, router as auth_router
from .db import init_db
from .merchants import router as merchants_router
from .merchant_profiles import router as merchant_profiles_router
from .performance_dashboard import router as performance_dashboard_router
from .runs import router as runs_router
from .scheduler import fbr_scheduler_loop, scheduler_loop
from .seo_targets import router as seo_targets_router
from .tasks import router as tasks_router

init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [
        asyncio.create_task(scheduler_loop()),
        asyncio.create_task(fbr_scheduler_loop()),
    ]
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


app = FastAPI(title="SEO Ops API", lifespan=lifespan)
app.include_router(auth_router)
operator_dependencies = [Depends(require_operator)]
app.include_router(merchants_router, dependencies=operator_dependencies)
app.include_router(merchant_profiles_router, dependencies=operator_dependencies)
app.include_router(tasks_router, dependencies=operator_dependencies)
app.include_router(runs_router, dependencies=operator_dependencies)
app.include_router(audits_router, dependencies=operator_dependencies)
app.include_router(seo_targets_router, dependencies=operator_dependencies)
app.include_router(performance_dashboard_router, dependencies=operator_dependencies)

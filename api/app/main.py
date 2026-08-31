import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router
from .runs import router as runs_router
from .scheduler import scheduler_loop
from .tasks import router as tasks_router

init_db()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()


app = FastAPI(title="SEO Ops API", lifespan=lifespan)
app.include_router(merchants_router)
app.include_router(tasks_router)
app.include_router(runs_router)

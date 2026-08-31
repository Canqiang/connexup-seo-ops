from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router
from .tasks import router as tasks_router

init_db()
app = FastAPI(title="SEO Ops API")
app.include_router(merchants_router)
app.include_router(tasks_router)

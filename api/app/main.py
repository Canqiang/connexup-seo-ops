from fastapi import FastAPI

from .db import init_db
from .merchants import router as merchants_router

init_db()
app = FastAPI(title="SEO Ops API")
app.include_router(merchants_router)

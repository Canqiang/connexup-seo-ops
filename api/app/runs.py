import sqlite3

from fastapi import APIRouter, Depends, HTTPException

from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError
from .db import get_db
from .merchants import fetch_merchant, now_iso

router = APIRouter(prefix="/api", tags=["runs"])

RUN_LIST_COLUMNS = "id, merchant_id, coreai_run_id, status, trigger_kind, error, created_at, finished_at"

_client: CoreAiClient | None = None


def get_coreai() -> tuple[CoreAiClient, str]:
    global _client
    settings = coreai_settings()
    if settings is None:
        raise HTTPException(status_code=503, detail="core-ai not configured")
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return _client, settings.agent_id


def build_input(merchant: sqlite3.Row) -> str:
    return f"商户：{merchant['name']}\n备注：{merchant['notes'] or '无'}"


def has_running_run(conn: sqlite3.Connection, merchant_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM runs WHERE merchant_id = ? AND status = 'running' LIMIT 1",
        (merchant_id,),
    ).fetchone()
    return row is not None


def start_run(
    conn: sqlite3.Connection,
    client: CoreAiClient,
    agent_id: str,
    merchant: sqlite3.Row,
    trigger_kind: str,
) -> sqlite3.Row:
    try:
        res = client.trigger(agent_id, build_input(merchant))
        cur = conn.execute(
            "INSERT INTO runs (merchant_id, coreai_run_id, status, trigger_kind, created_at)"
            " VALUES (?, ?, 'running', ?, ?)",
            (merchant["id"], res["run_id"], trigger_kind, now_iso()),
        )
    except CoreAiError as e:
        now = now_iso()
        cur = conn.execute(
            "INSERT INTO runs (merchant_id, status, trigger_kind, error, created_at, finished_at)"
            " VALUES (?, 'failed', ?, ?, ?, ?)",
            (merchant["id"], trigger_kind, str(e), now, now),
        )
    conn.commit()
    return conn.execute("SELECT * FROM runs WHERE id = ?", (cur.lastrowid,)).fetchone()


@router.post("/merchants/{merchant_id}/runs", status_code=201)
def create_run(merchant_id: int, coreai=Depends(get_coreai), conn=Depends(get_db)):
    merchant = fetch_merchant(conn, merchant_id)
    if has_running_run(conn, merchant_id):
        raise HTTPException(status_code=409, detail="a run is already in progress for this merchant")
    client, agent_id = coreai
    return dict(start_run(conn, client, agent_id, merchant, "manual"))


@router.get("/merchants/{merchant_id}/runs")
def list_runs(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    rows = conn.execute(
        f"SELECT {RUN_LIST_COLUMNS} FROM runs WHERE merchant_id = ? ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/runs/{run_id}")
def get_run(run_id: int, conn=Depends(get_db)):
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return dict(row)


@router.get("/runs/{run_id}/tasks")
def get_run_tasks(run_id: int, conn=Depends(get_db)):
    if conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="run not found")
    rows = conn.execute(
        "SELECT * FROM tasks WHERE source_run_id = ? ORDER BY id", (run_id,)
    ).fetchall()
    return [dict(r) for r in rows]

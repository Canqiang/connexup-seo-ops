import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import get_db
from .merchants import fetch_merchant, now_iso

router = APIRouter(prefix="/api", tags=["tasks"])

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "todo": {"doing", "cancelled"},
    "doing": {"done", "cancelled"},
    "done": set(),
    "cancelled": set(),
}


class TaskCreate(BaseModel):
    title: str = Field(min_length=1)
    description: str | None = None
    rationale: str | None = None


class TaskPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    description: str | None = None
    rationale: str | None = None
    evidence_note: str | None = None
    status: Literal["todo", "doing", "done", "cancelled"] | None = None


def fetch_task(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return row


@router.get("/merchants/{merchant_id}/tasks")
def list_tasks(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    rows = conn.execute("SELECT * FROM tasks WHERE merchant_id = ? ORDER BY id DESC", (merchant_id,)).fetchall()
    return [dict(r) for r in rows]


@router.post("/merchants/{merchant_id}/tasks", status_code=201)
def create_task(merchant_id: int, body: TaskCreate, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    cur = conn.execute(
        "INSERT INTO tasks (merchant_id, title, description, rationale, created_at) VALUES (?, ?, ?, ?, ?)",
        (merchant_id, body.title, body.description, body.rationale, now_iso()),
    )
    conn.commit()
    return dict(fetch_task(conn, cur.lastrowid))


@router.get("/tasks/{task_id}")
def get_task(task_id: int, conn=Depends(get_db)):
    return dict(fetch_task(conn, task_id))


@router.patch("/tasks/{task_id}")
def patch_task(task_id: int, body: TaskPatch, conn=Depends(get_db)):
    task = fetch_task(conn, task_id)
    updates = body.model_dump(exclude_unset=True)
    if "title" in updates and updates["title"] is None:
        raise HTTPException(status_code=422, detail="title cannot be null")
    new_status = updates.pop("status", None)
    for field, value in updates.items():
        conn.execute(f"UPDATE tasks SET {field} = ? WHERE id = ?", (value, task_id))
    if new_status is not None and new_status != task["status"]:
        if new_status not in ALLOWED_TRANSITIONS[task["status"]]:
            raise HTTPException(status_code=422, detail=f"illegal transition {task['status']} -> {new_status}")
        completed_at = now_iso() if new_status == "done" else None
        conn.execute("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?", (new_status, completed_at, task_id))
    conn.commit()
    return dict(fetch_task(conn, task_id))

"""Persistence and read views for immutable, revisioned Task Plans."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .db import get_db
from .merchants import now_iso
from .task_plan_contract import ValidatedTaskPlan

router = APIRouter(prefix="/api", tags=["task-plans"])


def persist_agent_plan(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    run_id: int,
    coreai_run_id: str,
    validated: ValidatedTaskPlan,
) -> sqlite3.Row:
    """Persist exactly one immutable Agent revision in the caller transaction."""

    existing = conn.execute(
        "SELECT * FROM task_plans WHERE source_run_id = ?", (run_id,)
    ).fetchone()
    if existing is not None:
        revision = conn.execute(
            "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND checksum = ?",
            (existing["id"], validated.checksum),
        ).fetchone()
        if revision is None:
            raise ValueError("a completed Run cannot replace its original Agent Plan")
        return revision

    created_at = now_iso()
    cursor = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, source_run_id, state, latest_revision, approved_revision, created_at) "
        "VALUES (?, 'AGENT', ?, 'OPEN', 1, NULL, ?)",
        (merchant_id, run_id, created_at),
    )
    plan_id = int(cursor.lastrowid)
    revision_cursor = conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, created_by, created_at) "
        "VALUES (?, 1, 'DRAFT', 'seo_ops.task_plan.v1', ?, ?, 'AGENT', ?, ?)",
        (plan_id, validated.canonical_json, validated.checksum, coreai_run_id, created_at),
    )
    return conn.execute(
        "SELECT * FROM task_plan_revisions WHERE id = ?", (revision_cursor.lastrowid,)
    ).fetchone()


def _revision_view(revision: sqlite3.Row) -> dict[str, Any]:
    view = dict(revision)
    view["payload"] = json.loads(view.pop("payload_json"))
    return view


def _plan_view(conn: sqlite3.Connection, plan: sqlite3.Row) -> dict[str, Any]:
    current = conn.execute(
        "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND revision = ?",
        (plan["id"], plan["latest_revision"]),
    ).fetchone()
    if current is None:
        raise HTTPException(status_code=500, detail="task plan current revision not found")
    return {**dict(plan), "current_revision": _revision_view(current)}


@router.get("/runs/{run_id}/task-plan")
def get_run_task_plan(run_id: int, conn=Depends(get_db)):
    plan = conn.execute(
        "SELECT * FROM task_plans WHERE source_run_id = ?", (run_id,)
    ).fetchone()
    if plan is None:
        raise HTTPException(status_code=404, detail="task plan not found")
    return _plan_view(conn, plan)


@router.get("/task-plans/{plan_id}")
def get_task_plan(plan_id: int, conn=Depends(get_db)):
    plan = conn.execute("SELECT * FROM task_plans WHERE id = ?", (plan_id,)).fetchone()
    if plan is None:
        raise HTTPException(status_code=404, detail="task plan not found")
    return _plan_view(conn, plan)


__all__ = ["persist_agent_plan", "router"]

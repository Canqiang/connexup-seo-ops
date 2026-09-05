import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator

from .auth import require_operator
from .db import get_db
from .migrations import content_sha256

router = APIRouter(prefix="/api/merchants", tags=["merchants"])


class MerchantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    notes: str | None = None
    primary_location: str = Field(min_length=1, max_length=500)
    website_url: str | None = Field(default=None, max_length=2048)

    @field_validator("name", "primary_location", mode="before")
    @classmethod
    def strip_required_text(cls, value):
        return value.strip() if isinstance(value, str) else value


class MerchantPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    status: Literal["active", "archived"] | None = None
    notes: str | None = None
    primary_location: str | None = None
    website_url: str | None = None
    auto_run_interval_days: int | None = Field(default=None, ge=1)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _append_status_event(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    status: str,
    generation: int,
    stamp: str,
    actor: str,
    reason: str,
) -> None:
    conn.execute(
        "INSERT INTO merchant_status_events(merchant_id,status,effective_at,generation,"
        "actor,reason,content_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            merchant_id,
            status,
            stamp,
            generation,
            actor,
            reason,
            content_sha256(
                merchant_id,
                status,
                stamp,
                generation,
                actor,
                reason,
            ),
            stamp,
        ),
    )


def fetch_merchant(conn: sqlite3.Connection, merchant_id: int) -> sqlite3.Row:
    row = conn.execute(
        "SELECT * FROM merchants WHERE id = ?", (merchant_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="merchant not found")
    return row


def fetch_active_merchant(conn: sqlite3.Connection, merchant_id: int) -> sqlite3.Row:
    merchant = fetch_merchant(conn, merchant_id)
    if merchant["status"] != "active":
        raise HTTPException(status_code=409, detail="merchant is archived")
    return merchant


def merchant_lifecycle_token(
    conn: sqlite3.Connection, merchant_id: int
) -> tuple[str, int, str]:
    """Return the merchant's current, append-only lifecycle identity."""

    row = conn.execute(
        "SELECT m.status,e.status,e.generation,e.content_sha256 FROM merchants m "
        "JOIN merchant_status_events e ON e.merchant_id=m.id "
        "WHERE m.id=? AND e.generation=("
        "SELECT MAX(latest.generation) FROM merchant_status_events latest "
        "WHERE latest.merchant_id=m.id)",
        (merchant_id,),
    ).fetchone()
    if row is None or row[0] != row[1]:
        raise RuntimeError("merchant lifecycle history is missing")
    return str(row[0]), int(row[2]), str(row[3])


def merchant_has_active_work(conn: sqlite3.Connection, merchant_id: int) -> bool:
    checks = (
        (
            "SELECT 1 FROM runs WHERE merchant_id = ? AND status = 'running' LIMIT 1",
            (merchant_id,),
        ),
        (
            "SELECT 1 FROM task_executions te JOIN tasks t ON t.id = te.task_id"
            " WHERE t.merchant_id = ? AND ("
            "te.status IN ('PENDING','DISPATCHING','RUNNING') OR "
            "(te.status='SUCCEEDED' AND te.reviewed_at IS NULL "
            "AND t.status NOT IN ('DONE','CANCELLED'))) LIMIT 1",
            (merchant_id,),
        ),
        (
            "SELECT 1 FROM tasks WHERE merchant_id=? AND status IN "
            "('PREPARING','AWAITING_APPROVAL','EXECUTING','VERIFYING') LIMIT 1",
            (merchant_id,),
        ),
        (
            "SELECT 1 FROM merchant_seo_artifacts"
            " WHERE merchant_id = ? AND status = 'running' LIMIT 1",
            (merchant_id,),
        ),
        (
            "SELECT 1 FROM merchant_fbr_links"
            " WHERE merchant_id = ? AND sync_status = 'syncing' LIMIT 1",
            (merchant_id,),
        ),
        (
            "SELECT 1 FROM merchant_local_falcon_scan_batches"
            " WHERE merchant_id = ? AND status IN ('submitting', 'submitted', 'partial', 'unknown')"
            " LIMIT 1",
            (merchant_id,),
        ),
    )
    return any(
        conn.execute(sql, params).fetchone() is not None for sql, params in checks
    )


# This list mirrors the frozen 0001 performance-history delete guard. Lifecycle
# rows are deliberately excluded: a blank draft owns only its automatic
# created/archived events, which are removed by the merchant FK cascade.
MERCHANT_DURABLE_HISTORY_TABLES = (
    "merchant_fbr_binding_events",
    "merchant_fbr_link_state",
    "merchant_locations",
    "source_scope_bindings",
    "metric_sync_job_merchants",
    "data_quality_events",
    "merchant_gbp_profiles",
    "merchant_seo_artifacts",
    "merchant_local_falcon_syncs",
    "merchant_local_falcon_reports",
    "merchant_local_falcon_approvals",
    "merchant_local_falcon_scan_confirmations",
    "merchant_local_falcon_scan_batches",
    "merchant_local_falcon_reconciliations",
    "audit_snapshots",
    "task_plans",
    "tasks",
    "runs",
)


def merchant_has_durable_history(conn: sqlite3.Connection, merchant_id: int) -> bool:
    if any(
        conn.execute(
            f"SELECT 1 FROM {table} WHERE merchant_id = ? LIMIT 1",
            (merchant_id,),
        ).fetchone()
        is not None
        for table in MERCHANT_DURABLE_HISTORY_TABLES
    ):
        return True
    return (
        conn.execute(
            "SELECT 1 FROM operator_command_ledger "
            "WHERE target_kind='MERCHANT' AND target_stable_id=CAST(? AS TEXT) "
            "AND http_status != 404 "
            "LIMIT 1",
            (merchant_id,),
        ).fetchone()
        is not None
    )


def merchant_is_deletable_blank_draft(
    conn: sqlite3.Connection, merchant_id: int
) -> bool:
    if merchant_has_durable_history(conn, merchant_id):
        return False
    lifecycle = conn.execute(
        "SELECT status,generation,reason FROM merchant_status_events "
        "WHERE merchant_id=? ORDER BY generation",
        (merchant_id,),
    ).fetchall()
    return [tuple(row) for row in lifecycle] == [
        ("active", 1, "merchant_created"),
        ("archived", 2, "merchant_archived"),
    ]


LIST_SQL = """
SELECT m.*,
  (SELECT COUNT(*) FROM tasks t WHERE t.merchant_id = m.id AND t.status = 'PENDING') AS todo_count,
  (SELECT COUNT(*) FROM tasks t WHERE t.merchant_id = m.id
    AND t.status IN ('PREPARING','AWAITING_APPROVAL','EXECUTING','VERIFYING','NEEDS_ATTENTION')) AS doing_count,
  EXISTS(SELECT 1 FROM runs r WHERE r.merchant_id = m.id AND r.status = 'running') AS has_running_run,
  (SELECT r.created_at FROM runs r WHERE r.merchant_id = m.id ORDER BY r.id DESC LIMIT 1) AS last_run_at,
  (SELECT r.status FROM runs r WHERE r.merchant_id = m.id ORDER BY r.id DESC LIMIT 1) AS last_run_status
FROM merchants m
"""


@router.get("")
def list_merchants(
    status: Literal["active", "archived"] | None = None, conn=Depends(get_db)
):
    if status:
        rows = conn.execute(
            LIST_SQL + " WHERE m.status = ? ORDER BY m.id DESC", (status,)
        ).fetchall()
    else:
        rows = conn.execute(LIST_SQL + " ORDER BY m.id DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["has_running_run"] = bool(d["has_running_run"])
        d["can_delete"] = d[
            "status"
        ] == "archived" and merchant_is_deletable_blank_draft(conn, int(d["id"]))
        out.append(d)
    return out


@router.post("", status_code=201)
def create_merchant(
    body: MerchantCreate,
    conn=Depends(get_db),
    operator: str = Depends(require_operator),
):
    conn.execute("BEGIN IMMEDIATE")
    try:
        stamp = now_iso()
        cur = conn.execute(
            "INSERT INTO merchants (name, notes, primary_location, website_url, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            (body.name, body.notes, body.primary_location, body.website_url, stamp),
        )
        _append_status_event(
            conn,
            merchant_id=int(cur.lastrowid),
            status="active",
            generation=1,
            stamp=stamp,
            actor=operator,
            reason="merchant_created",
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return dict(fetch_merchant(conn, cur.lastrowid))


@router.get("/{merchant_id}")
def get_merchant(merchant_id: int, conn=Depends(get_db)):
    return dict(fetch_merchant(conn, merchant_id))


@router.patch("/{merchant_id}")
def patch_merchant(
    merchant_id: int,
    body: MerchantPatch,
    conn=Depends(get_db),
    operator: str = Depends(require_operator),
):
    updates = body.model_dump(exclude_unset=True)
    for field in ("name", "status"):
        if field in updates and updates[field] is None:
            raise HTTPException(status_code=422, detail=f"{field} cannot be null")
    conn.execute("BEGIN IMMEDIATE")
    try:
        merchant = fetch_merchant(conn, merchant_id)
        if merchant["status"] == "archived" and updates != {"status": "active"}:
            raise HTTPException(
                status_code=409,
                detail="archived merchant can only be restored",
            )
        target_status = updates.get("status")
        if (
            target_status == "archived"
            and merchant["status"] != "archived"
            and merchant_has_active_work(conn, merchant_id)
        ):
            raise HTTPException(
                status_code=409,
                detail="merchant has active work; resolve it before archiving",
            )
        for field, value in updates.items():
            conn.execute(
                f"UPDATE merchants SET {field} = ? WHERE id = ?",
                (value, merchant_id),
            )
        if target_status is not None and target_status != merchant["status"]:
            prior_generation = conn.execute(
                "SELECT COALESCE(MAX(generation),0) FROM merchant_status_events "
                "WHERE merchant_id=?",
                (merchant_id,),
            ).fetchone()[0]
            stamp = now_iso()
            _append_status_event(
                conn,
                merchant_id=merchant_id,
                status=target_status,
                generation=int(prior_generation) + 1,
                stamp=stamp,
                actor=operator,
                reason=(
                    "merchant_archived"
                    if target_status == "archived"
                    else "merchant_restored"
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return dict(fetch_merchant(conn, merchant_id))


@router.delete("/{merchant_id}", status_code=204)
def delete_merchant(
    merchant_id: int,
    conn=Depends(get_db),
    _operator: str = Depends(require_operator),
) -> Response:
    conn.execute("BEGIN IMMEDIATE")
    try:
        merchant = fetch_merchant(conn, merchant_id)
        if merchant["status"] != "archived":
            raise HTTPException(
                status_code=409,
                detail="merchant must be archived before deletion",
            )
        if not merchant_is_deletable_blank_draft(conn, merchant_id):
            raise HTTPException(
                status_code=409,
                detail="merchant has durable history; archive it instead",
            )
        conn.execute("DELETE FROM merchants WHERE id = ?", (merchant_id,))
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        if "merchant_has_durable_history" in str(exc):
            raise HTTPException(
                status_code=409,
                detail="merchant has durable history; archive it instead",
            ) from exc
        raise
    except Exception:
        conn.rollback()
        raise
    return Response(status_code=204)

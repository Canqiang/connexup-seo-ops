import sqlite3
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .db import get_db

router = APIRouter(prefix="/api/merchants", tags=["merchants"])


class MerchantCreate(BaseModel):
    name: str = Field(min_length=1)
    notes: str | None = None


class MerchantPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1)
    status: Literal["active", "archived"] | None = None
    notes: str | None = None
    auto_run_interval_days: int | None = Field(default=None, ge=1)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def fetch_merchant(conn: sqlite3.Connection, merchant_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM merchants WHERE id = ?", (merchant_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="merchant not found")
    return row


@router.get("")
def list_merchants(status: Literal["active", "archived"] | None = None, conn=Depends(get_db)):
    if status:
        rows = conn.execute("SELECT * FROM merchants WHERE status = ? ORDER BY id DESC", (status,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM merchants ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


@router.post("", status_code=201)
def create_merchant(body: MerchantCreate, conn=Depends(get_db)):
    cur = conn.execute(
        "INSERT INTO merchants (name, notes, created_at) VALUES (?, ?, ?)",
        (body.name, body.notes, now_iso()),
    )
    conn.commit()
    return dict(fetch_merchant(conn, cur.lastrowid))


@router.get("/{merchant_id}")
def get_merchant(merchant_id: int, conn=Depends(get_db)):
    return dict(fetch_merchant(conn, merchant_id))


@router.patch("/{merchant_id}")
def patch_merchant(merchant_id: int, body: MerchantPatch, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    updates = body.model_dump(exclude_unset=True)
    for field in ("name", "status"):
        if field in updates and updates[field] is None:
            raise HTTPException(status_code=422, detail=f"{field} cannot be null")
    for field, value in updates.items():
        conn.execute(f"UPDATE merchants SET {field} = ? WHERE id = ?", (value, merchant_id))
    conn.commit()
    return dict(fetch_merchant(conn, merchant_id))


@router.delete("/{merchant_id}", status_code=204)
def delete_merchant(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    n = conn.execute("SELECT COUNT(*) AS n FROM tasks WHERE merchant_id = ?", (merchant_id,)).fetchone()["n"]
    if n:
        raise HTTPException(status_code=409, detail="merchant has tasks; archive it instead")
    conn.execute("DELETE FROM merchants WHERE id = ?", (merchant_id,))
    conn.commit()

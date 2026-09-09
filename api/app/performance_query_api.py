"""Merchant-scoped Performance read endpoints behind an explicit rollback gate."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .auth import require_operator
from .config import performance_history_read_enabled, performance_sync_settings
from .db import get_db
from .performance_identity import TimezoneUnresolved, resolve_bound_scopes, set_location_timezone
from .performance_query import MerchantPerformanceQueryV1, query_merchant_performance

router = APIRouter(tags=["performance-query"])


class TimezoneBodyV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone_name: str = Field(min_length=1, max_length=64)


def _require_read_gate(merchant_id: int | None) -> None:
    settings = performance_sync_settings()
    if not performance_history_read_enabled() or merchant_id not in settings.pilot_merchant_ids:
        raise HTTPException(status_code=409, detail="history_read_not_enabled_for_merchant")


@router.get("/api/merchants/{merchant_id}/performance/locations")
def locations(merchant_id: int, conn=Depends(get_db), operator: str = Depends(require_operator)):
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=datetime.now(timezone.utc))
    return {
        "merchant_id": merchant_id,
        "history_read_enabled": performance_history_read_enabled()
        and merchant_id in performance_sync_settings().pilot_merchant_ids,
        "locations": [
            {"location_id": s.location.id, "display_name": s.location.display_name,
             "timezone_name": s.location.timezone_name, "status": s.location.status}
            for s in scopes
        ],
    }


@router.put("/api/merchant-locations/{location_id}/timezone")
def put_timezone(location_id: int, body: TimezoneBodyV1, conn=Depends(get_db), operator: str = Depends(require_operator)):
    row = conn.execute("SELECT merchant_id FROM merchant_locations WHERE id = ?", (location_id,)).fetchone()
    _require_read_gate(row["merchant_id"] if row is not None else None)
    try:
        location = set_location_timezone(
            conn, location_id, body.timezone_name, actor=operator, effective_at=datetime.now(timezone.utc)
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"location_id": location.id, "timezone_name": location.timezone_name, "status": location.status}


@router.post("/api/merchants/{merchant_id}/performance/query")
def post_query(
    merchant_id: int, body: MerchantPerformanceQueryV1,
    conn=Depends(get_db), operator: str = Depends(require_operator),
):
    _require_read_gate(merchant_id)
    try:
        return query_merchant_performance(conn, merchant_id, body, now=datetime.now(timezone.utc))
    except TimezoneUnresolved as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

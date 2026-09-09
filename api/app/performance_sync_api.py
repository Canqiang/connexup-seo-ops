"""Operator-confirmed GBP history backfill: preflight, confirm, and job status.

Every route here is the operator's door into the month-partitioned sync
engine built by Tasks 5-7. Two constraints shape all three routes:

- Preflight is read-only against local state only. It never calls FBR, GBP,
  or Core AI -- it reports what a backfill *would* cover (clamped window,
  month partitions, bound locations, blockers) purely from what is already
  stored, so it can never itself create side effects.
- Confirmation is explicit and required. ``BackfillConfirmV1.confirmed`` is
  typed ``Literal[True]``, so a request that omits it or sends ``false``
  fails FastAPI's request validation (422) before any handler code runs --
  "the confirmation flag is required and a request without it is rejected
  before anything is written" is enforced by the type, not by an ``if``.

``GET /api/performance-sync/jobs/{job_id}`` reports progress at the
partition-group level, not as a raw batch-counter ratio -- see
``_group_progress`` for why.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .auth import require_operator
from .config import performance_sync_settings
from .db import get_db
from .performance_gbp import SOURCE_START_DATE
from .performance_identity import resolve_bound_scopes
from .performance_sync import month_partitions, plan_sync_job

router = APIRouter(tags=["performance-sync"])


class BackfillWindowV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    end: date

    @model_validator(mode="after")
    def validate_window(self):
        if self.start > self.end:
            raise ValueError("start must not be after end")
        return self


class BackfillConfirmV1(BackfillWindowV1):
    request_id: str = Field(min_length=1, max_length=200)
    confirmed: Literal[True]


def _require_pilot(merchant_id: int) -> None:
    """Refuse before any work is planned: not enabled, or merchant not in the pilot allowlist."""
    settings = performance_sync_settings()
    if not settings.enabled or merchant_id not in settings.pilot_merchant_ids:
        raise HTTPException(status_code=409, detail="performance_sync_not_enabled_for_merchant")


@router.post("/api/merchants/{merchant_id}/performance/backfill/preflight")
def preflight(merchant_id: int, body: BackfillWindowV1, conn=Depends(get_db)):
    """Report what a backfill for ``[body.start, body.end]`` would cover -- from local state only.

    Read-only: no FBR call, no GBP write, no Core AI call. Clamps the window
    to ``SOURCE_START_DATE`` (a window that merely starts earlier is
    clamped; one entirely before it is flagged with the
    ``window_before_source_start`` blocker rather than reported as an empty
    success), lists the resulting month partitions and each bound
    location's readiness, and reports a ``location_timezone_missing``
    blocker for any bound location without a verified IANA timezone instead
    of silently excluding it.
    """
    _require_pilot(merchant_id)
    now = datetime.now(timezone.utc)
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=now)
    blockers: list[dict] = []
    if not scopes:
        blockers.append(
            {"code": "no_bound_gbp_location", "detail": "merchant has no bound GBP location"}
        )
    for scope in scopes:
        if not scope.location.timezone_name:
            blockers.append(
                {
                    "code": "location_timezone_missing",
                    "detail": f"location {scope.location.display_name!r} has no verified IANA timezone",
                    "location_id": scope.location.id,
                }
            )
    clamped_start = max(body.start, SOURCE_START_DATE)
    clamped_end = body.end
    if clamped_start > clamped_end:
        blockers.append(
            {
                "code": "window_before_source_start",
                "detail": f"the source has no data before {SOURCE_START_DATE.isoformat()}",
            }
        )
        partitions: tuple[tuple[str, date, date], ...] = ()
    else:
        partitions = month_partitions(clamped_start, clamped_end)
    return {
        "merchant_id": merchant_id,
        "requested_start": body.start.isoformat(),
        "requested_end": body.end.isoformat(),
        "clamped_start": clamped_start.isoformat(),
        "clamped_end": clamped_end.isoformat(),
        "source_start_date": SOURCE_START_DATE.isoformat(),
        "locations": [
            {
                "location_id": scope.location.id,
                "display_name": scope.location.display_name,
                "timezone_name": scope.location.timezone_name,
            }
            for scope in scopes
        ],
        "partitions": [
            {"partition_month": key, "start": start.isoformat(), "end": end.isoformat()}
            for key, start, end in partitions
        ],
        "batch_estimate": len(partitions) * len(scopes),
        "blockers": blockers,
    }


@router.post("/api/merchants/{merchant_id}/performance/backfill")
def confirm(
    merchant_id: int,
    body: BackfillConfirmV1,
    conn=Depends(get_db),
    operator: str = Depends(require_operator),
):
    """Plan (or idempotently replay) an operator-confirmed backfill job.

    Delegates window clamping, scope resolution and batch creation to
    ``plan_sync_job`` (Task 7); a repeated call with the same
    ``request_id`` (and otherwise-identical inputs) replays the same job id
    with an empty ``batch_ids`` list rather than creating duplicate batches.
    """
    _require_pilot(merchant_id)
    now = datetime.now(timezone.utc)
    try:
        plan = plan_sync_job(
            conn,
            merchant_id,
            body.start,
            body.end,
            job_type="backfill",
            request_id=body.request_id,
            operator=operator,
            now=now,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "job_id": plan.job_id,
        "batch_ids": list(plan.batch_ids),
        "clamped_start": plan.clamped_start.isoformat(),
        "clamped_end": plan.clamped_end.isoformat(),
    }


def _group_progress(batches: list[dict]) -> dict[str, int]:
    """Derive partition-group progress from each group's latest-attempt row.

    ``metric_sync_jobs.batch_count``/``completed_batch_count`` are raw
    attempt counters, not a progress ratio: ``create_batch`` (Task 7)
    increments ``batch_count`` on every attempt, including retry
    successors, while ``completed_batch_count`` only counts publishes -- so
    a job that needed even one retry never reaches
    ``completed_batch_count == batch_count`` even after it finished
    correctly. This mirrors the grouping ``_finalize_job`` in
    ``performance_sync.py`` uses to derive the job's real status -- group
    every batch by ``(source_scope_id, partition_month)``, take the row
    with the highest ``attempt`` in each group as that group's true current
    state -- but stays read-only (unlike ``_finalize_job`` it never writes
    to the job row), since this runs on every ``GET``.
    """
    latest: dict[tuple[int, str], dict] = {}
    for batch in batches:
        key = (batch["source_scope_id"], batch["partition_month"])
        current = latest.get(key)
        if current is None or batch["attempt"] > current["attempt"]:
            latest[key] = batch
    total = len(latest)
    published = sum(1 for row in latest.values() if row["status"] == "published")
    failed = sum(1 for row in latest.values() if row["status"] in ("retryable", "blocked", "failed"))
    return {
        "partitions_total": total,
        "partitions_published": published,
        "partitions_failed": failed,
        "partitions_pending": total - published - failed,
    }


@router.get("/api/performance-sync/jobs/{job_id}")
def job_status(job_id: int, conn=Depends(get_db)):
    job = conn.execute("SELECT * FROM metric_sync_jobs WHERE id = ?", (job_id,)).fetchone()
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    batches = [
        dict(row)
        for row in conn.execute(
            "SELECT id, source_scope_id, partition_month, attempt, status, data_through, error_category,"
            " error_summary, published_at FROM metric_sync_batches WHERE job_id = ? ORDER BY id",
            (job_id,),
        ).fetchall()
    ]
    return {
        "job_id": job["id"],
        "job_type": job["job_type"],
        "status": job["status"],
        "requested_start_date": job["requested_start_date"],
        "requested_end_date": job["requested_end_date"],
        "progress": _group_progress(batches),
        # Raw attempt counts, not progress -- see _group_progress. Kept for
        # operators who want the literal row values (e.g. total attempts
        # made so far including retries), never as a completion ratio.
        "raw_attempt_counts": {
            "batch_count": job["batch_count"],
            "completed_batch_count": job["completed_batch_count"],
        },
        "batches": batches,
    }

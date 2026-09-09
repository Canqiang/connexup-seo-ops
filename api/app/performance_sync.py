"""Month-partitioned GBP history jobs and the leased worker that publishes them.

Migration 0001's ``protect_metric_sync_batch_transition`` trigger (see
``api/migrations/0001_performance_history.sql``) makes ``published``,
``retryable``, ``blocked`` and ``failed`` all terminal: any UPDATE of a batch
already in one of those statuses aborts. That shapes three things this module
does differently from a naive "just retry the row" design:

- A retry is never a mutation of a terminal batch. When a batch fails
  retryably it is marked terminal ``retryable`` and a *new* batch row is
  created for the same ``(job_id, source_scope_id, partition_month)`` with
  ``attempt = parent.attempt + 1`` -- which the table's
  ``UNIQUE (job_id, source_scope_id, partition_month, attempt)`` constraint
  accommodates. Successor creation stops once ``attempt`` reaches
  ``SEO_OPS_PERFORMANCE_MAX_AUTO_ATTEMPTS``; the last failure stays terminal
  with no successor. A ``blocked`` classification never gets a successor at
  all -- a bug must not be retried.
- The parent is always terminalized *before* its successor is created. Head
  order is latest-publish-wins (``published_sequence`` is a publish-time
  counter with no tie to ``attempt`` or ``retrieved_at``), so if a parent were
  left claimable (e.g. still ``leased`` with an expired lease) while its
  successor already existed, two simultaneously-publishable attempts for one
  partition could let the slower, older attempt win the head.
- ``claim_next_batch`` selects only ``queued`` batches and ``leased`` batches
  whose lease has expired. Re-leasing an expired lease is legal precisely
  because the status stays ``leased`` (only ``NEW.status != OLD.status``
  trips the transition guard) -- an expired lease is refreshed in place, not
  transitioned. ``retryable`` batches are never selected; they are terminal.

Nothing in Task 5's ``performance_store`` sets ``metric_sync_jobs.running``,
``partial``, ``started_at`` or ``finished_at`` -- ``publish_metric_batch``
only increments ``completed_batch_count`` and flips the job to ``succeeded``
once ``completed_batch_count`` reaches ``batch_count``. That comparison is
only correct when every batch published on its first attempt: ``batch_count``
is incremented by every ``create_batch`` call, including failed attempts and
their successors, while ``completed_batch_count`` only counts publishes -- so
a job that needed even one retry would never reach the built-in "succeeded"
threshold, and a job whose only batch fails terminally would sit at
``queued`` forever. This module therefore owns job status end to end:
``claim_next_batch`` flips a job from ``queued`` to ``running`` (with
``started_at``) the moment its first batch is leased, and
``_finalize_job`` -- called after every batch outcome -- independently
derives the job's true status from the latest attempt of each
``(source_scope_id, partition_month)`` group (ignoring the possibly-inflated
``batch_count``/``completed_batch_count`` fields) and sets ``succeeded``,
``partial`` or ``failed`` plus ``finished_at`` once no group has claimable or
in-flight work left.

``_finalize_job`` is only ever invoked as a side effect of processing *some*
batch of that job. Every store write is its own committed transaction (see
below), so a crash between terminalizing a batch and creating its successor
(or, once a batch's group is genuinely done, between that and the
``_finalize_job`` call) can strand a job: if that batch was the job's last
outstanding work, no batch of that job is ever claimable again, so
``_finalize_job`` is never invoked again either, and the job would sit at
``running`` with ``finished_at`` NULL forever. ``process_metric_sync_batches_once``
therefore sweeps every ``queued``/``running`` job through ``_finalize_job`` at
the top of each pass (see ``_sweep_stranded_jobs``): that call is a no-op
for a job that still has genuinely claimable or in-flight work (the same
"is anything not yet settled" check ``_finalize_job`` already does), and
correctly finalizes one that was left stranded by a crash. The
terminalize-before-successor ordering itself is unchanged -- a stale head is
still worse than a stranded job, and the sweep makes that loss observable
(``partial``/``failed``) instead of silent.

Every store function in ``performance_store`` opens its own
``BEGIN IMMEDIATE`` and commits, so this module never calls one of them while
holding an open transaction of its own. For the same reason, a batch's
terminal writes are individually fenced on ``(status, lease_owner)`` so a
worker whose lease was reassigned mid-flight (its lease expired while it was
still processing) becomes a safe no-op instead of racing the new owner:
``_terminalize_batch`` fences directly in its ``UPDATE ... WHERE`` clause,
and since ``publish_metric_batch`` cannot be given the same fencing (it is a
Task 5 interface this module must not modify), ``_confirm_lease`` performs
the same compare-and-swap against ``heartbeat_at`` immediately before calling
it.
"""
from __future__ import annotations

import calendar
import json
import logging
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from .config import performance_sync_settings
from .db import connect
from .performance_gbp import GBP_ADAPTER_VERSION, SOURCE_START_DATE, classify_source_error, fetch_partition
from .performance_identity import canonical_instant, resolve_bound_scopes
from .performance_store import BatchDraft, create_batch, create_sync_job, publish_metric_batch, record_quality_event

logger = logging.getLogger(__name__)

# The daily job re-fetches a short trailing window, not just yesterday: GBP
# corrects/late-arrives data for a few days after the fact, and a fixed
# republish window is how those corrections land without a separate repair
# path. This is deliberately independent of SEO_OPS_PERFORMANCE_DELAY_DAYS
# (how far back "today" starts, to give the source time to settle) -- tying
# the window length to the delay was an accident of the original formula,
# not a real relationship, so it is a plain constant instead of another
# environment variable.
DAILY_TRAILING_WINDOW_DAYS = 5


@dataclass(frozen=True)
class SyncJobPlan:
    job_id: int
    batch_ids: tuple[int, ...]
    partitions: tuple[tuple[str, date, date], ...]
    clamped_start: date
    clamped_end: date


def month_partitions(start: date, end: date) -> tuple[tuple[str, date, date], ...]:
    """Split ``[start, end]`` into inclusive per-calendar-month partitions."""
    partitions: list[tuple[str, date, date]] = []
    cursor = start.replace(day=1)
    while cursor <= end:
        last_day = cursor.replace(day=calendar.monthrange(cursor.year, cursor.month)[1])
        partitions.append((cursor.strftime("%Y-%m"), max(cursor, start), min(last_day, end)))
        cursor = last_day + timedelta(days=1)
    return tuple(partitions)


def _fbr_merchant_id(conn: sqlite3.Connection, merchant_id: int) -> str:
    row = conn.execute(
        "SELECT fbr_merchant_id FROM merchant_gbp_profiles WHERE merchant_id = ? LIMIT 1", (merchant_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"merchant {merchant_id} has no GBP profile")
    return str(row["fbr_merchant_id"])


def plan_sync_job(
    conn: sqlite3.Connection, merchant_id: int, start: date, end: date, *,
    job_type: str, request_id: str, operator: str, now: datetime,
) -> SyncJobPlan:
    """Plan (or replay) a month-partitioned sync job for one merchant's bound GBP scopes.

    The requested window is clamped to ``SOURCE_START_DATE``: the source
    returns nothing earlier, so a window entirely before it is an error, not
    an empty success.
    """
    clamped_start = max(start, SOURCE_START_DATE)
    clamped_end = end
    if clamped_start > clamped_end:
        raise ValueError("requested window ends before the proven source start date")
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=now)
    if not scopes:
        raise ValueError(f"merchant {merchant_id} has no bound GBP location")
    partitions = month_partitions(clamped_start, clamped_end)
    manifest = {
        "merchant_id": merchant_id,
        "scope_ids": sorted(scope.scope_id for scope in scopes),
        "partitions": [key for key, _, _ in partitions],
    }
    job_id = create_sync_job(
        conn, job_type=job_type, request_id=request_id, requested_by=operator,
        scope_manifest=manifest, start=clamped_start, end=clamped_end, now=now,
    )
    existing = {
        (row["source_scope_id"], row["partition_month"])
        for row in conn.execute(
            "SELECT source_scope_id, partition_month FROM metric_sync_batches WHERE job_id = ?", (job_id,)
        )
    }
    batch_ids: list[int] = []
    for scope in scopes:
        for partition_key, _, partition_end in partitions:
            if (scope.scope_id, partition_key) in existing:
                continue
            batch_ids.append(
                create_batch(
                    conn,
                    BatchDraft(job_id, scope.scope_id, partition_key, 1, GBP_ADAPTER_VERSION, now, partition_end),
                    now=now,
                )
            )
    return SyncJobPlan(job_id, tuple(batch_ids), partitions, clamped_start, clamped_end)


def claim_next_batch(
    conn: sqlite3.Connection, *, owner_token: str, now: datetime, lease_seconds: int
) -> sqlite3.Row | None:
    """Lease the next claimable batch: a ``queued`` row, or a ``leased`` row whose lease expired.

    A ``retryable``/``blocked``/``failed`` batch is terminal and never
    selected -- a retry lives as a successor row instead (see the module
    docstring). Re-leasing an expired lease updates ``lease_owner``/
    ``lease_expires_at``/``heartbeat_at`` in place without changing
    ``status`` (it is already ``'leased'``), which is legal under
    ``protect_metric_sync_batch_transition`` because that trigger only
    fires on a status *change*.

    The first time a batch is leased for a still-``queued`` job, the job is
    flipped to ``running`` with ``started_at`` set -- see the module
    docstring for why Task 7 owns this transition.
    """
    stamp = canonical_instant(now)
    expiry = canonical_instant(now + timedelta(seconds=lease_seconds))
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT b.*, j.requested_start_date, j.requested_end_date"
            " FROM metric_sync_batches b JOIN metric_sync_jobs j ON j.id = b.job_id"
            " WHERE b.status = 'queued' OR (b.status = 'leased' AND b.lease_expires_at < ?)"
            " ORDER BY b.id LIMIT 1",
            (stamp,),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None
        conn.execute(
            "UPDATE metric_sync_batches SET status = 'leased', lease_owner = ?, lease_expires_at = ?,"
            " heartbeat_at = ?, updated_at = ? WHERE id = ?",
            (owner_token, expiry, stamp, stamp, row["id"]),
        )
        conn.execute(
            "UPDATE metric_sync_jobs SET status = 'running', started_at = COALESCE(started_at, ?)"
            " WHERE id = ? AND status = 'queued'",
            (stamp, row["job_id"]),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return row


def _partition_window(row: sqlite3.Row, start: date, end: date) -> tuple[date, date]:
    year, month = (int(part) for part in row["partition_month"].split("-"))
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    return max(first, start), min(last, end)


def _create_successor(conn: sqlite3.Connection, parent: sqlite3.Row, *, now: datetime) -> int:
    """Create the next-attempt batch row for ``parent``'s (job, scope, partition).

    Must only be called *after* ``parent`` has already been terminalized
    (Ruling 2): never leave a parent claimable while its successor exists.
    """
    data_through = date.fromisoformat(parent["data_through"]) if parent["data_through"] else None
    draft = BatchDraft(
        job_id=parent["job_id"],
        source_scope_id=parent["source_scope_id"],
        partition_month=parent["partition_month"],
        attempt=parent["attempt"] + 1,
        adapter_version=parent["adapter_version"],
        retrieved_at=now,
        data_through=data_through,
    )
    return create_batch(conn, draft, now=now)


def _terminalize_batch(
    conn: sqlite3.Connection, batch_id: int, *, owner_token: str, status: str, error_category: str,
    error_summary: str, now: datetime,
) -> bool:
    """Transition ``batch_id`` to a terminal status. Returns whether it actually did.

    Fenced on ``status IN ('leased','running') AND lease_owner = ?`` so this
    is always a safe no-op (never a trigger abort, never a race) in either of
    two cases: the batch already reached a terminal status by another path
    (e.g. it published successfully and only a *later* step -- recording a
    quality event -- failed), or this worker's lease was reassigned to
    another worker after it expired mid-flight. The caller must only create a
    successor when this returns ``True``: a ``False`` result means this
    worker did not actually cause the terminal transition, so it must not act
    as though it did.
    """
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "UPDATE metric_sync_batches SET status = ?, lease_owner = NULL, lease_expires_at = NULL,"
            " error_category = ?, error_summary = ?, updated_at = ? WHERE id = ?"
            " AND status IN ('leased','running') AND lease_owner = ?",
            (status, error_category, error_summary[:400], stamp, batch_id, owner_token),
        )
        transitioned = cursor.rowcount > 0
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return transitioned


def _confirm_lease(conn: sqlite3.Connection, batch_id: int, owner_token: str, *, now: datetime) -> bool:
    """Atomically confirm this worker still holds the lease, immediately before a terminal write.

    ``publish_metric_batch`` is a Task 5 interface this module must not
    modify, so it cannot be fenced on ``lease_owner`` directly the way
    ``_terminalize_batch`` is. This performs the same compare-and-swap by
    touching only ``heartbeat_at`` (never ``status``, so it can never trip
    ``protect_metric_sync_batch_transition``) and reporting whether the
    ``WHERE`` clause actually matched. ``False`` means the lease was
    reassigned to another worker since this worker claimed it -- the caller
    must not publish.
    """
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "UPDATE metric_sync_batches SET heartbeat_at = ? WHERE id = ? AND status = 'leased' AND lease_owner = ?",
            (stamp, batch_id, owner_token),
        )
        held = cursor.rowcount > 0
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return held


def _finalize_job(conn: sqlite3.Connection, job_id: int, *, now: datetime) -> None:
    """Derive the job's true status from the latest attempt of each (scope, partition) group.

    This is computed independently of ``metric_sync_jobs.batch_count`` /
    ``completed_batch_count`` -- see the module docstring for why those
    fields are not a reliable "is this job done" signal once any batch has
    ever been retried.
    """
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        rows = conn.execute(
            "SELECT source_scope_id, partition_month, attempt, status FROM metric_sync_batches"
            " WHERE job_id = ? ORDER BY source_scope_id, partition_month, attempt",
            (job_id,),
        ).fetchall()
        if not rows:
            conn.rollback()
            return
        latest_status_by_group: dict[tuple[int, str], str] = {}
        for row in rows:
            latest_status_by_group[(row["source_scope_id"], row["partition_month"])] = row["status"]
        if any(status in ("queued", "leased", "running") for status in latest_status_by_group.values()):
            # Claimable or in-flight work remains for at least one group;
            # the job is not done yet.
            conn.rollback()
            return
        published = sum(1 for status in latest_status_by_group.values() if status == "published")
        total = len(latest_status_by_group)
        if published == total:
            final_status = "succeeded"
        elif published > 0:
            final_status = "partial"
        else:
            final_status = "failed"
        conn.execute(
            "UPDATE metric_sync_jobs SET status = ?, finished_at = COALESCE(finished_at, ?) WHERE id = ?",
            (final_status, stamp, job_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _sweep_stranded_jobs(conn: sqlite3.Connection, *, now: datetime) -> None:
    """Re-finalize every ``queued``/``running`` job, recovering any left stranded by a crash.

    See the module docstring: ``_finalize_job`` is otherwise only invoked as
    a side effect of processing one of the job's own batches, so a crash
    after a job's last batch settled but before ``_finalize_job`` ran for it
    would leave the job at ``running`` forever. This is a plain, unconditional
    call to ``_finalize_job`` for every non-terminal job -- it already no-ops
    correctly on a job that still has genuinely claimable or in-flight work,
    so no separate "is this job actually stranded" check is needed here.
    """
    job_ids = [
        row["id"]
        for row in conn.execute("SELECT id FROM metric_sync_jobs WHERE status IN ('queued','running')").fetchall()
    ]
    for job_id in job_ids:
        _finalize_job(conn, job_id, now=now)


def process_metric_sync_batches_once(client, *, max_batches: int = 4, now: datetime | None = None) -> int:
    """Claim and process up to ``max_batches`` leased batches once. Returns the number handled.

    Returns 0 immediately (without touching the database) when
    ``SEO_OPS_PERFORMANCE_SYNC_ENABLED`` is not ``true``.
    """
    settings = performance_sync_settings()
    if not settings.enabled:
        return 0
    moment = now or datetime.now(timezone.utc)
    owner_token = uuid.uuid4().hex
    processed = 0
    conn = connect()
    try:
        _sweep_stranded_jobs(conn, now=moment)
        for _ in range(max_batches):
            row = claim_next_batch(conn, owner_token=owner_token, now=moment, lease_seconds=settings.lease_seconds)
            if row is None:
                break
            job_id = row["job_id"]
            try:
                # Everything that can raise for this batch -- scope/place_id/
                # window resolution, the fetch, and (once the lease is
                # reconfirmed) the publish and its quality events -- lives in
                # this one try block so classify_source_error's fail-closed
                # default guards all of it, not just the fetch. A binding
                # closed between planning and processing (Task 4) is exactly
                # as unrecoverable-without-a-retry as a malformed payload.
                scope = conn.execute(
                    "SELECT s.external_id, b.merchant_id, b.merchant_location_id FROM source_scopes s"
                    " JOIN source_scope_bindings b ON b.source_scope_id = s.id AND b.valid_to IS NULL"
                    " WHERE s.id = ?",
                    (row["source_scope_id"],),
                ).fetchone()
                if scope is None:
                    raise ValueError(f"source scope {row['source_scope_id']} has no active merchant binding")
                place_row = conn.execute(
                    "SELECT normalized_json FROM merchant_gbp_profiles WHERE merchant_id = ? AND gbp_location_id = ?",
                    (scope["merchant_id"], scope["external_id"]),
                ).fetchone()
                place_id = None
                if place_row is not None:
                    place_id = json.loads(place_row["normalized_json"] or "{}").get("place_id")
                if place_id is None:
                    raise ValueError("GBP profile has no place_id")
                start, end = _partition_window(
                    row, date.fromisoformat(row["requested_start_date"]), date.fromisoformat(row["requested_end_date"])
                )
                raw, partition = fetch_partition(
                    client,
                    fbr_merchant_id=_fbr_merchant_id(conn, scope["merchant_id"]),
                    place_id=place_id,
                    source_scope_id=row["source_scope_id"],
                    start=start,
                    end=end,
                )
                if _confirm_lease(conn, row["id"], owner_token, now=moment):
                    publish_metric_batch(conn, row["id"], raw, list(partition.drafts), now=moment)
                    for omission_date, metric_key in partition.omissions:
                        record_quality_event(
                            conn, source="GBP", scope_id=row["source_scope_id"], merchant_id=scope["merchant_id"],
                            location_id=scope["merchant_location_id"], category="source_omits_metric_rows",
                            severity="yellow", start=omission_date, end=omission_date,
                            details={"metric_key": metric_key, "note": "source returned other metrics for this day"},
                            batch_id=row["id"], now=moment,
                        )
                else:
                    logger.warning("performance batch %s lease was reassigned; skipping publish", row["id"])
            except Exception as exc:  # classified below via classify_source_error
                classification = classify_source_error(exc)
                terminal_status = "retryable" if classification == "retryable" else "blocked"
                # Fenced on (status, lease_owner): a no-op if the batch
                # already reached a terminal status by another path (e.g. it
                # published successfully and only the quality-event write
                # above failed) or if this worker's lease was reassigned.
                # Only actually terminalizing this batch justifies creating a
                # successor for it.
                transitioned = _terminalize_batch(
                    conn, row["id"], owner_token=owner_token, status=terminal_status, error_category=classification,
                    error_summary=str(exc), now=moment,
                )
                if transitioned and classification == "retryable" and row["attempt"] < settings.max_attempts:
                    _create_successor(conn, row, now=moment)
                logger.warning("performance batch %s failed (%s)", row["id"], classification)
            _finalize_job(conn, job_id, now=moment)
            processed += 1
    finally:
        conn.close()
    return processed


def enqueue_daily_performance_jobs_once(*, now: datetime | None = None) -> int:
    """Plan today's daily sync job for each configured pilot merchant. Returns the number planned.

    Returns 0 immediately (without touching the database) when
    ``SEO_OPS_PERFORMANCE_SYNC_ENABLED`` is not ``true`` or no pilot
    merchants are configured.
    """
    settings = performance_sync_settings()
    if not settings.enabled or not settings.pilot_merchant_ids:
        return 0
    moment = now or datetime.now(timezone.utc)
    end = moment.date() - timedelta(days=settings.delay_days)
    start = end - timedelta(days=DAILY_TRAILING_WINDOW_DAYS - 1)
    created = 0
    conn = connect()
    try:
        for merchant_id in sorted(settings.pilot_merchant_ids):
            # The request id must be merchant-specific: metric_sync_jobs has a
            # bare UNIQUE (requested_by, request_id), and requested_by is the
            # fixed "scheduler" for every pilot merchant. Without the
            # merchant id folded in here, every merchant after the first
            # would collide on that constraint with an sqlite3.IntegrityError
            # on the very first tick (not just on a same-day scope rebind).
            try:
                plan_sync_job(
                    conn, merchant_id, start, end, job_type="daily",
                    request_id=f"daily:{merchant_id}:{end.isoformat()}", operator="scheduler", now=moment,
                )
                created += 1
            except ValueError:
                logger.info("merchant %s is not ready for performance sync", merchant_id)
            except Exception:
                # No single merchant's unexpected failure (e.g. an
                # sqlite3.IntegrityError from a request id collision that
                # slips past the merchant-scoped id above) may take down the
                # rest of the pilot cohort's daily enqueue.
                logger.exception("merchant %s daily performance enqueue failed unexpectedly", merchant_id)
    finally:
        conn.close()
    return created

"""Append-only publication of metric batches and compare-and-swap head advancement.

Migration 0001 fixes the batch and head life cycles with triggers this module must
satisfy exactly (see ``api/migrations/0001_performance_history.sql``):

- ``protect_metric_sync_batch_transition`` allows only
  ``queued -> leased -> {running, published, retryable, blocked, failed}`` and
  ``running -> {published, retryable, blocked, failed}``. Every one of
  published/retryable/blocked/failed is terminal — no further UPDATE on that row
  is legal, including a second publish attempt. A retry is therefore always a
  *new* batch row (``attempt = parent.attempt + 1``, Task 7), never a mutation
  of a terminal one.
- ``validate_metric_observation_head_insert``/``_update`` require the head's
  ``NEW.observation_id`` to already belong to a batch whose status is
  ``'published'`` *at the moment the head row is written*, and require
  ``head_generation`` to be exactly 1 on insert or ``OLD.head_generation + 1``
  on update, with the new observation's ``published_sequence`` strictly
  greater than the one it replaces. This module flips the batch to
  ``'published'`` before writing any head row, and drives ``head_generation``/
  ``published_sequence`` to satisfy those checks directly.
- Migration 0006 rejects every UPDATE and DELETE on ``metric_observations``, so
  this module only ever INSERTs observation rows; published data is corrected
  by inserting a new observation and swinging the head, never by editing one.

``publish_metric_batch`` requires the batch to already be in ``leased`` or
``running`` — it never performs the ``queued -> leased`` lease transition
itself (a real worker leases a batch when it picks up the sync job to run),
and raises :class:`BatchLifecycleError` with a clear message instead of
letting an ineligible batch reach the trigger and abort with an opaque
``sqlite3.IntegrityError``.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from .canonical_json import canonical_decimal, canonical_json_bytes, canonical_sha256
from .performance_identity import canonical_instant
from .performance_metrics import METRIC_REGISTRY_VERSION


class BatchLifecycleError(RuntimeError):
    """Raised when a batch cannot be published from its current status."""


@dataclass(frozen=True)
class ObservationDraft:
    source_scope_id: int
    metric_key: str
    business_date: date
    numeric_value: Decimal | None
    availability: str
    completeness: str
    source_updated_at: datetime | None = None


@dataclass(frozen=True)
class BatchDraft:
    job_id: int
    source_scope_id: int
    partition_month: str
    attempt: int
    adapter_version: str
    retrieved_at: datetime
    data_through: date | None


@dataclass(frozen=True)
class PublishedBatch:
    batch_id: int
    observation_ids: tuple[int, ...]
    head_updates: int


@dataclass(frozen=True)
class HeadObservation:
    source_scope_id: int
    metric_key: str
    business_date: date
    numeric_value: Decimal | None
    availability: str
    completeness: str
    observation_id: int
    superseded: bool


def _logical_key(draft: ObservationDraft) -> dict:
    return {
        "source_scope_id": draft.source_scope_id,
        "business_date": draft.business_date.isoformat(),
        "metric_key": draft.metric_key,
        "dimension": {},
    }


def create_sync_job(
    conn: sqlite3.Connection,
    *,
    job_type: str,
    request_id: str,
    requested_by: str,
    scope_manifest: dict,
    start: date,
    end: date,
    now: datetime,
) -> int:
    """Create a sync job, or return the existing job id for a repeated request.

    Idempotency is keyed on (job_type, requested_by, request_id, the scope
    manifest, start, end): a byte-identical repeat returns the same job id.
    ``metric_sync_jobs`` also has a bare ``UNIQUE (requested_by, request_id)``
    constraint, so reusing a request_id with different parameters fails
    closed with an IntegrityError instead of silently adopting the new
    manifest.
    """
    manifest_bytes = canonical_json_bytes(scope_manifest)
    manifest_sha = canonical_sha256(scope_manifest)
    idempotency_key = hashlib.sha256(
        f"{job_type}|{requested_by}|{request_id}|{manifest_sha}|{start.isoformat()}|{end.isoformat()}".encode(
            "utf-8"
        )
    ).hexdigest()
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        existing = conn.execute(
            "SELECT id FROM metric_sync_jobs WHERE idempotency_key = ?", (idempotency_key,)
        ).fetchone()
        if existing is not None:
            conn.commit()
            return int(existing["id"])
        cursor = conn.execute(
            "INSERT INTO metric_sync_jobs (job_type, request_id, idempotency_key, scope_manifest_json,"
            " scope_manifest_sha256, requested_start_date, requested_end_date, status, requested_by,"
            " created_at) VALUES (?,?,?,?,?,?,?,'queued',?,?)",
            (
                job_type,
                request_id,
                idempotency_key,
                manifest_bytes.decode("utf-8"),
                manifest_sha,
                start.isoformat(),
                end.isoformat(),
                requested_by,
                stamp,
            ),
        )
        job_id = int(cursor.lastrowid)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return job_id


def create_batch(conn: sqlite3.Connection, draft: BatchDraft, *, now: datetime) -> int:
    """Create a ``queued`` batch row for one (job, scope, partition_month, attempt)."""
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month, attempt,"
            " status, adapter_version, data_through, retrieved_at, created_at, updated_at)"
            " VALUES (?, 'GBP', ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
            (
                draft.job_id,
                draft.source_scope_id,
                draft.partition_month,
                draft.attempt,
                draft.adapter_version,
                draft.data_through.isoformat() if draft.data_through is not None else None,
                canonical_instant(draft.retrieved_at),
                stamp,
                stamp,
            ),
        )
        batch_id = int(cursor.lastrowid)
        conn.execute(
            "UPDATE metric_sync_jobs SET batch_count = batch_count + 1 WHERE id = ?", (draft.job_id,)
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return batch_id


def publish_metric_batch(
    conn: sqlite3.Connection,
    batch_id: int,
    raw_payload: bytes,
    observations: list[ObservationDraft],
    *,
    now: datetime,
) -> PublishedBatch:
    """Publish a batch's raw payload and observations atomically, then advance heads.

    Raises :class:`BatchLifecycleError` if the batch is not currently
    ``leased`` or ``running`` (including if it does not exist), rather than
    relying on ``protect_metric_sync_batch_transition`` to abort with a raw
    trigger error.
    """
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        batch = conn.execute(
            "SELECT status FROM metric_sync_batches WHERE id = ?", (batch_id,)
        ).fetchone()
        if batch is None:
            raise BatchLifecycleError(f"metric_sync_batch {batch_id} does not exist")
        if batch["status"] not in ("leased", "running"):
            raise BatchLifecycleError(
                f"metric_sync_batch {batch_id} cannot be published from status '{batch['status']}'"
            )

        payload_sha = hashlib.sha256(raw_payload).hexdigest()
        conn.execute(
            "INSERT INTO metric_source_artifacts (batch_id, payload, content_type, payload_sha256,"
            " saved_at) VALUES (?,?,'application/json',?,?)",
            (batch_id, raw_payload, payload_sha, stamp),
        )

        # Insert every observation first. The head triggers require the
        # referenced batch to already be 'published' when a head row is
        # written, so the batch status flips below *before* any
        # metric_observation_heads INSERT/UPDATE — collect what each head
        # write needs here and apply it after that flip.
        pending: list[tuple[int, str, sqlite3.Row | None]] = []
        for draft in observations:
            logical = _logical_key(draft)
            logical_sha = canonical_sha256(logical)
            logical_bytes = canonical_json_bytes(logical)
            dimension_sha = canonical_sha256({})
            content = {
                "logical_key": logical,
                "value": canonical_decimal(draft.numeric_value),
                "availability": draft.availability,
                "completeness": draft.completeness,
                "formula_version": METRIC_REGISTRY_VERSION,
            }
            sequence = conn.execute(
                "SELECT COALESCE(MAX(published_sequence), 0) + 1 FROM metric_observations"
            ).fetchone()[0]
            previous = conn.execute(
                "SELECT observation_id, head_generation FROM metric_observation_heads"
                " WHERE logical_key_sha256 = ?",
                (logical_sha,),
            ).fetchone()
            cursor = conn.execute(
                "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
                " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
                " numeric_value, availability, completeness, source_updated_at, formula_version,"
                " published_sequence, supersedes_observation_id, content_sha256, created_at)"
                " VALUES (?,?,?,?, 'store_local', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    batch_id,
                    draft.source_scope_id,
                    draft.metric_key,
                    draft.business_date.isoformat(),
                    dimension_sha,
                    logical_bytes.decode("utf-8"),
                    logical_sha,
                    float(draft.numeric_value) if draft.numeric_value is not None else None,
                    draft.availability,
                    draft.completeness,
                    canonical_instant(draft.source_updated_at)
                    if draft.source_updated_at is not None
                    else None,
                    METRIC_REGISTRY_VERSION,
                    sequence,
                    previous["observation_id"] if previous is not None else None,
                    canonical_sha256(content),
                    stamp,
                ),
            )
            observation_id = int(cursor.lastrowid)
            pending.append((observation_id, logical_sha, previous))

        conn.execute(
            "UPDATE metric_sync_batches SET status = 'published', published_at = ?, updated_at = ?,"
            " response_sha256 = ? WHERE id = ?",
            (stamp, stamp, payload_sha, batch_id),
        )

        head_updates = 0
        for observation_id, logical_sha, previous in pending:
            if previous is None:
                conn.execute(
                    "INSERT INTO metric_observation_heads (logical_key_sha256, observation_id,"
                    " head_generation, updated_at) VALUES (?,?,1,?)",
                    (logical_sha, observation_id, stamp),
                )
            else:
                conn.execute(
                    "UPDATE metric_observation_heads SET observation_id = ?, head_generation = ?,"
                    " updated_at = ? WHERE logical_key_sha256 = ?",
                    (observation_id, previous["head_generation"] + 1, stamp, logical_sha),
                )
            head_updates += 1

        conn.execute(
            "UPDATE metric_sync_jobs SET completed_batch_count = completed_batch_count + 1,"
            " status = CASE WHEN completed_batch_count + 1 >= batch_count THEN 'succeeded' ELSE 'running' END"
            " WHERE id = (SELECT job_id FROM metric_sync_batches WHERE id = ?)",
            (batch_id,),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return PublishedBatch(batch_id, tuple(observation_id for observation_id, _sha, _prev in pending), head_updates)


def query_metric_heads(
    conn: sqlite3.Connection,
    scope_ids: tuple[int, ...],
    metric_keys: tuple[str, ...],
    start: date,
    end: date,
) -> list[HeadObservation]:
    """Return each logical key's current head observation in the given window.

    ``superseded`` is True only when the head's value actually differs from
    the observation it replaced — compared via ``content_sha256``, which
    folds in numeric_value/availability/completeness/formula_version/
    logical_key. A republish that carries the same value as before still
    advances ``head_generation`` (a new observation was appended) but is not
    a "correction", so it reports ``superseded=False``.
    """
    if not scope_ids or not metric_keys:
        return []
    scope_marks = ",".join("?" * len(scope_ids))
    metric_marks = ",".join("?" * len(metric_keys))
    rows = conn.execute(
        "SELECT o.source_scope_id, o.metric_key, o.business_date, o.numeric_value, o.availability,"
        " o.completeness, o.id AS observation_id,"
        " (o.supersedes_observation_id IS NOT NULL AND prior.content_sha256 != o.content_sha256)"
        "   AS superseded"
        " FROM metric_observation_heads h"
        " JOIN metric_observations o ON o.id = h.observation_id"
        " LEFT JOIN metric_observations prior ON prior.id = o.supersedes_observation_id"
        f" WHERE o.source_scope_id IN ({scope_marks}) AND o.metric_key IN ({metric_marks})"
        "   AND o.business_date BETWEEN ? AND ?"
        " ORDER BY o.business_date, o.source_scope_id, o.metric_key",
        (*scope_ids, *metric_keys, start.isoformat(), end.isoformat()),
    ).fetchall()
    return [
        HeadObservation(
            row["source_scope_id"],
            row["metric_key"],
            date.fromisoformat(row["business_date"]),
            None if row["numeric_value"] is None else Decimal(str(int(row["numeric_value"]))),
            row["availability"],
            row["completeness"],
            row["observation_id"],
            bool(row["superseded"]),
        )
        for row in rows
    ]


def record_quality_event(
    conn: sqlite3.Connection,
    *,
    source: str,
    scope_id: int | None,
    merchant_id: int | None,
    location_id: int | None,
    category: str,
    severity: str,
    start: date | None,
    end: date | None,
    details: dict,
    batch_id: int | None,
    now: datetime,
) -> int:
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        cursor = conn.execute(
            "INSERT INTO data_quality_events (source, source_scope_id, merchant_id, merchant_location_id,"
            " start_date, end_date, category, severity, status, details_json, first_seen_at,"
            " last_seen_at, batch_id) VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?, ?, ?)",
            (
                source,
                scope_id,
                merchant_id,
                location_id,
                start.isoformat() if start is not None else None,
                end.isoformat() if end is not None else None,
                category,
                severity,
                json.dumps(details, sort_keys=True, separators=(",", ":")),
                stamp,
                stamp,
                batch_id,
            ),
        )
        event_id = int(cursor.lastrowid)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return event_id


def open_quality_events(
    conn: sqlite3.Connection, scope_ids: tuple[int, ...], start: date, end: date
) -> list[dict]:
    """Unresolved (``status='open'``) quality events whose window overlaps [start, end]."""
    if not scope_ids:
        return []
    marks = ",".join("?" * len(scope_ids))
    rows = conn.execute(
        "SELECT source, category, severity, start_date, end_date, details_json, status, resolved_at"
        f" FROM data_quality_events WHERE source_scope_id IN ({marks}) AND status = 'open'"
        "   AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)"
        " ORDER BY severity DESC, category, start_date",
        (*scope_ids, end.isoformat(), start.isoformat()),
    ).fetchall()
    return [
        {
            "source": row["source"],
            "category": row["category"],
            "severity": row["severity"],
            "start_date": row["start_date"],
            "end_date": row["end_date"],
            "status": row["status"],
            "details": json.loads(row["details_json"] or "{}"),
        }
        for row in rows
    ]

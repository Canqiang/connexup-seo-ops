import sqlite3
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.performance_identity import canonical_instant
from app.performance_store import (
    BatchDraft,
    BatchLifecycleError,
    ObservationDraft,
    create_batch,
    create_sync_job,
    open_quality_events,
    publish_metric_batch,
    query_metric_heads,
    record_quality_event,
)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _scope(conn) -> int:
    cursor = conn.execute(
        "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
        " date_basis, metadata_json, created_at) VALUES ('GBP','GBP_LOCATION','1','gbp_location:1',"
        " 'America/New_York','store_local','{}','2026-09-09T00:00:00.000000Z')"
    )
    conn.commit()
    return int(cursor.lastrowid)


def _lease(conn, batch_id: int) -> None:
    """Move a freshly created batch from queued to leased so publish_metric_batch is legal.

    Migration 0001's protect_metric_sync_batch_transition trigger only allows
    queued -> leased -> {running, published, retryable, blocked, failed}, and
    the four non-running targets are terminal. A real worker performs this
    transition when it picks a batch up to run the sync; tests do the same
    thing through this one helper instead of duplicating the UPDATE.
    """
    conn.execute(
        "UPDATE metric_sync_batches SET status = 'leased', lease_owner = 'test', updated_at = ?"
        " WHERE id = ?",
        (canonical_instant(NOW), batch_id),
    )
    conn.commit()


def _publish(conn, scope_id, value, *, attempt, business_date=date(2026, 8, 18)):
    job_id = create_sync_job(
        conn, job_type="backfill", request_id=f"r{attempt}", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=business_date, end=business_date, now=NOW,
    )
    batch_id = create_batch(
        conn,
        BatchDraft(job_id, scope_id, business_date.strftime("%Y-%m"), attempt, "gbp.v1", NOW, business_date),
        now=NOW,
    )
    _lease(conn, batch_id)
    return publish_metric_batch(
        conn,
        batch_id,
        b'{"metrics":[]}',
        [ObservationDraft(scope_id, "CALL_CLICKS", business_date, value, "available", "complete", None)],
        now=NOW,
    )


def test_publish_is_atomic_and_creates_one_head(conn):
    scope_id = _scope(conn)
    published = _publish(conn, scope_id, Decimal("3"), attempt=1)
    assert len(published.observation_ids) == 1 and published.head_updates == 1
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("3")


def test_later_batch_supersedes_the_head_and_marks_the_correction(conn):
    scope_id = _scope(conn)
    _publish(conn, scope_id, Decimal("3"), attempt=1)
    _publish(conn, scope_id, Decimal("5"), attempt=2)
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("5") and heads[0].superseded is True
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 2


def test_republishing_an_identical_observation_keeps_one_head_generation(conn):
    scope_id = _scope(conn)
    _publish(conn, scope_id, Decimal("3"), attempt=1)
    _publish(conn, scope_id, Decimal("3"), attempt=2)
    generation = conn.execute("SELECT head_generation FROM metric_observation_heads").fetchone()[0]
    assert generation == 2
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("3") and heads[0].superseded is False


def test_superseded_stays_true_after_a_correction_is_republished_unchanged(conn):
    """A day that was genuinely corrected (3 -> 5) must stay flagged even
    after the corrected value is republished unchanged (5 -> 5) — this is
    the routine "republish the current month" case, and the flag must not
    reset just because the latest publish happens to match the one before
    it (3 -> 5 -> 5 must report superseded=True, not just 3 -> 5)."""
    scope_id = _scope(conn)
    _publish(conn, scope_id, Decimal("3"), attempt=1)
    _publish(conn, scope_id, Decimal("5"), attempt=2)
    _publish(conn, scope_id, Decimal("5"), attempt=3)
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("5") and heads[0].superseded is True


def test_unavailable_observation_keeps_a_null_value_not_zero(conn):
    scope_id = _scope(conn)
    job_id = create_sync_job(
        conn, job_type="backfill", request_id="r1", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 18), end=date(2026, 8, 18), now=NOW,
    )
    batch_id = create_batch(conn, BatchDraft(job_id, scope_id, "2026-08", 1, "gbp.v1", NOW, date(2026, 8, 18)), now=NOW)
    _lease(conn, batch_id)
    publish_metric_batch(
        conn, batch_id, b"{}",
        [ObservationDraft(scope_id, "CALL_CLICKS", date(2026, 8, 18), None, "unavailable", "unknown", None)],
        now=NOW,
    )
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value is None and heads[0].availability == "unavailable"


def test_publish_rejects_a_batch_that_is_still_queued(conn):
    scope_id = _scope(conn)
    job_id = create_sync_job(
        conn, job_type="backfill", request_id="rq", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 18), end=date(2026, 8, 18), now=NOW,
    )
    batch_id = create_batch(conn, BatchDraft(job_id, scope_id, "2026-08", 1, "gbp.v1", NOW, date(2026, 8, 18)), now=NOW)
    with pytest.raises(BatchLifecycleError):
        publish_metric_batch(
            conn, batch_id, b"{}",
            [ObservationDraft(scope_id, "CALL_CLICKS", date(2026, 8, 18), Decimal("1"), "available", "complete", None)],
            now=NOW,
        )
    status = conn.execute("SELECT status FROM metric_sync_batches WHERE id = ?", (batch_id,)).fetchone()[0]
    assert status == "queued"
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 0


def test_create_batch_stores_retrieved_at_distinct_from_now(conn):
    scope_id = _scope(conn)
    job_id = create_sync_job(
        conn, job_type="daily", request_id="rt", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 18), end=date(2026, 8, 18), now=NOW,
    )
    retrieved_at = datetime(2026, 8, 19, 3, 30, tzinfo=timezone.utc)
    batch_id = create_batch(
        conn,
        BatchDraft(job_id, scope_id, "2026-08", 1, "gbp.v1", retrieved_at, date(2026, 8, 18)),
        now=NOW,
    )
    row = conn.execute(
        "SELECT retrieved_at, created_at FROM metric_sync_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    assert row["retrieved_at"] == "2026-08-19T03:30:00.000000Z"
    assert row["created_at"] == canonical_instant(NOW)


def _batch(conn, scope_id: int, *, attempt: int = 1, business_date: date = date(2026, 8, 18)) -> int:
    """A bare queued batch row -- enough to satisfy data_quality_events.batch_id's foreign key."""
    job_id = create_sync_job(
        conn, job_type="daily", request_id=f"batch-{scope_id}-{attempt}-{business_date}", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=business_date, end=business_date, now=NOW,
    )
    return create_batch(
        conn,
        BatchDraft(job_id, scope_id, business_date.strftime("%Y-%m"), attempt, "gbp.v1", NOW, business_date),
        now=NOW,
    )


def test_record_quality_event_appears_in_open_quality_events_for_its_period(conn):
    scope_id = _scope(conn)
    record_quality_event(
        conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="MISSING_DAILY_METRIC", severity="red",
        start=date(2026, 8, 1), end=date(2026, 8, 31),
        details={"missing_dates": 3}, batch_id=None, now=NOW,
    )
    events = open_quality_events(conn, (scope_id,), date(2026, 8, 18), date(2026, 8, 18))
    assert len(events) == 1
    assert events[0]["category"] == "MISSING_DAILY_METRIC"
    assert events[0]["details"]["missing_dates"] == 3
    assert open_quality_events(conn, (scope_id,), date(2026, 9, 1), date(2026, 9, 5)) == []


def test_open_quality_events_excludes_resolved_events(conn):
    scope_id = _scope(conn)
    event_id = record_quality_event(
        conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="MISSING_DAILY_METRIC", severity="yellow",
        start=date(2026, 8, 1), end=None,
        details={}, batch_id=None, now=NOW,
    )
    conn.execute("UPDATE data_quality_events SET status = 'resolved' WHERE id = ?", (event_id,))
    conn.commit()
    assert open_quality_events(conn, (scope_id,), date(2026, 8, 18), date(2026, 8, 18)) == []


def test_open_quality_events_sorts_most_severe_first(conn):
    scope_id = _scope(conn)
    for severity, category in (("info", "A"), ("yellow", "B"), ("red", "C")):
        record_quality_event(
            conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
            category=category, severity=severity,
            start=date(2026, 8, 1), end=date(2026, 8, 31),
            details={}, batch_id=None, now=NOW,
        )
    events = open_quality_events(conn, (scope_id,), date(2026, 8, 18), date(2026, 8, 18))
    assert [event["severity"] for event in events] == ["red", "yellow", "info"]


def test_record_quality_event_dedups_repeated_omissions_into_one_open_row(conn):
    """The daily job republishes a trailing window so corrections can land,
    calling record_quality_event again for a (day, metric) omission that is
    still open. Three such republishes must leave exactly one open row --
    advancing last_seen_at and batch_id -- rather than one row per call."""
    scope_id = _scope(conn)
    kwargs = dict(
        source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="source_omits_metric_rows", severity="yellow",
        start=date(2026, 8, 18), end=date(2026, 8, 18),
        details={"metric_key": "CALL_CLICKS"},
    )
    batch_1 = _batch(conn, scope_id, attempt=1)
    batch_2 = _batch(conn, scope_id, attempt=2)
    batch_3 = _batch(conn, scope_id, attempt=3)

    first_id = record_quality_event(conn, **kwargs, batch_id=batch_1, now=NOW)
    later = datetime(2026, 9, 10, 12, 0, tzinfo=timezone.utc)
    second_id = record_quality_event(conn, **kwargs, batch_id=batch_2, now=later)
    even_later = datetime(2026, 9, 11, 12, 0, tzinfo=timezone.utc)
    third_id = record_quality_event(conn, **kwargs, batch_id=batch_3, now=even_later)

    assert first_id == second_id == third_id
    rows = conn.execute(
        "SELECT first_seen_at, last_seen_at, batch_id, status FROM data_quality_events"
        " WHERE source_scope_id = ?",
        (scope_id,),
    ).fetchall()
    assert len(rows) == 1
    row = rows[0]
    assert row["status"] == "open"
    assert row["first_seen_at"] == canonical_instant(NOW)
    assert row["last_seen_at"] == canonical_instant(even_later)
    assert row["batch_id"] == batch_3


def test_record_quality_event_creates_a_new_row_for_a_genuinely_different_omission(conn):
    """A different day, or a different metric on the same day, is a distinct
    quality event and must not collapse into the first one's row."""
    scope_id = _scope(conn)
    batch_id = _batch(conn, scope_id)
    record_quality_event(
        conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="source_omits_metric_rows", severity="yellow",
        start=date(2026, 8, 18), end=date(2026, 8, 18),
        details={"metric_key": "CALL_CLICKS"}, batch_id=batch_id, now=NOW,
    )
    record_quality_event(
        conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="source_omits_metric_rows", severity="yellow",
        start=date(2026, 8, 19), end=date(2026, 8, 19),
        details={"metric_key": "CALL_CLICKS"}, batch_id=batch_id, now=NOW,
    )
    record_quality_event(
        conn, source="GBP", scope_id=scope_id, merchant_id=None, location_id=None,
        category="source_omits_metric_rows", severity="yellow",
        start=date(2026, 8, 18), end=date(2026, 8, 18),
        details={"metric_key": "WEBSITE_CLICKS"}, batch_id=batch_id, now=NOW,
    )
    count = conn.execute(
        "SELECT COUNT(*) FROM data_quality_events WHERE source_scope_id = ?", (scope_id,)
    ).fetchone()[0]
    assert count == 3


def test_create_sync_job_is_idempotent_for_a_byte_identical_repeat(conn):
    scope_id = _scope(conn)
    kwargs = dict(
        job_type="backfill", request_id="idem-1", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 1), end=date(2026, 8, 31), now=NOW,
    )
    first_id = create_sync_job(conn, **kwargs)
    second_id = create_sync_job(conn, **kwargs)
    assert first_id == second_id
    count = conn.execute(
        "SELECT COUNT(*) FROM metric_sync_jobs WHERE request_id = ?", ("idem-1",)
    ).fetchone()[0]
    assert count == 1


def test_create_sync_job_rejects_request_id_reuse_with_a_different_window(conn):
    scope_id = _scope(conn)
    create_sync_job(
        conn, job_type="backfill", request_id="idem-2", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 1), end=date(2026, 8, 31), now=NOW,
    )
    with pytest.raises(sqlite3.IntegrityError):
        create_sync_job(
            conn, job_type="backfill", request_id="idem-2", requested_by="test",
            scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 9, 1), end=date(2026, 9, 30), now=NOW,
        )
    # The rejected attempt must not have left a dangling transaction — the
    # connection is still usable, and no second/divergent job was created.
    count = conn.execute(
        "SELECT COUNT(*) FROM metric_sync_jobs WHERE request_id = ?", ("idem-2",)
    ).fetchone()[0]
    assert count == 1

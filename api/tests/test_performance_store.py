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

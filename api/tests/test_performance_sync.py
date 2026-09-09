import json
from datetime import date, datetime, timedelta, timezone

import pytest

from app.fbr_gbp import FbrUnavailableError
from app.performance_identity import canonical_instant, seed_gbp_locations_from_profiles, set_location_timezone
from app.performance_store import query_metric_heads
from app.performance_sync import (
    _confirm_lease,
    _terminalize_batch,
    claim_next_batch,
    enqueue_daily_performance_jobs_once,
    month_partitions,
    plan_sync_job,
    process_metric_sync_batches_once,
)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


class FakeFbrClient:
    def __init__(self, payloads, failures=0):
        self.payloads = payloads
        self.failures = failures
        self.calls: list[tuple[str, str, str]] = []

    def list_performance_metrics(self, fbr_merchant_id, place_id, *, from_date, to_date):
        self.calls.append((place_id, from_date, to_date))
        if self.failures > 0:
            self.failures -= 1
            raise FbrUnavailableError("upstream timeout")
        return self.payloads


def _pilot(conn, monkeypatch, merchant_id):
    scopes = seed_gbp_locations_from_profiles(conn, merchant_id, actor="test", observed_at=NOW)
    for scope in scopes:
        set_location_timezone(conn, scope.location.id, "America/New_York", actor="test", effective_at=NOW)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", str(merchant_id))
    return scopes


def test_month_partitions_split_a_multi_month_window_inclusively():
    assert month_partitions(date(2026, 8, 18), date(2026, 9, 6)) == (
        ("2026-08", date(2026, 8, 18), date(2026, 8, 31)),
        ("2026-09", date(2026, 9, 1), date(2026, 9, 6)),
    )


def test_plan_clamps_the_request_to_the_proven_source_start(conn, monkeypatch, merchant_with_gbp_profiles):
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(
        conn, merchant_with_gbp_profiles, date(2026, 6, 1), date(2026, 9, 6),
        job_type="backfill", request_id="r1", operator="test", now=NOW,
    )
    assert plan.clamped_start == date(2026, 8, 18)
    assert len(plan.batch_ids) == 4  # two locations x two months


def test_plan_rejects_a_window_entirely_before_the_proven_source_start(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    with pytest.raises(ValueError):
        plan_sync_job(
            conn, merchant_with_gbp_profiles, date(2026, 1, 1), date(2026, 1, 31),
            job_type="backfill", request_id="r1", operator="test", now=NOW,
        )


def test_replaying_the_same_request_id_reuses_one_job(conn, monkeypatch, merchant_with_gbp_profiles):
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    first = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 31),
                          job_type="backfill", request_id="r1", operator="test", now=NOW)
    second = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 31),
                           job_type="backfill", request_id="r1", operator="test", now=NOW)
    assert first.job_id == second.job_id
    assert conn.execute("SELECT COUNT(*) FROM metric_sync_batches").fetchone()[0] == len(first.batch_ids)


def test_worker_publishes_observations_and_marks_the_batch_and_job(
    conn, monkeypatch, gold_payload, merchant_with_gbp_profiles
):
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    client = FakeFbrClient(gold_payload)
    assert process_metric_sync_batches_once(client, max_batches=4, now=NOW) == 2
    scope_ids = tuple(row["id"] for row in conn.execute("SELECT id FROM source_scopes ORDER BY id"))
    heads = query_metric_heads(conn, scope_ids, ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 19))
    assert {(h.business_date, h.availability) for h in heads} == {
        (date(2026, 8, 18), "available"), (date(2026, 8, 19), "unavailable"),
    }
    assert conn.execute(
        "SELECT COUNT(*) FROM data_quality_events WHERE category = 'source_omits_metric_rows'"
    ).fetchone()[0] == 2
    # Ruling 4: Task 7 owns job status. Both batches published, so the job
    # must be finalized to 'succeeded' with started_at/finished_at populated,
    # regardless of metric_sync_jobs.batch_count/completed_batch_count.
    job = conn.execute(
        "SELECT status, started_at, finished_at FROM metric_sync_jobs WHERE id = ?", (plan.job_id,)
    ).fetchone()
    assert job["status"] == "succeeded"
    assert job["started_at"] is not None
    assert job["finished_at"] is not None


def test_retryable_failure_terminalizes_the_parent_and_creates_a_successor_attempt(
    conn, monkeypatch, gold_payload, merchant_with_gbp_profiles
):
    """Controller Ruling 1: a retry is a successor row, never a mutation of a
    terminal batch. Controller Ruling 2: the parent is terminalized before its
    successor is created, so a parent is never left claimable while a
    successor for the same partition exists."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    client = FakeFbrClient(gold_payload, failures=99)
    processed = process_metric_sync_batches_once(client, max_batches=2, now=NOW)
    assert processed == 2
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 0

    rows = conn.execute(
        "SELECT source_scope_id, partition_month, attempt, status FROM metric_sync_batches"
        " ORDER BY source_scope_id, attempt"
    ).fetchall()
    by_group: dict[tuple[int, str], list[tuple[int, str]]] = {}
    for row in rows:
        by_group.setdefault((row["source_scope_id"], row["partition_month"]), []).append(
            (row["attempt"], row["status"])
        )
    assert len(by_group) == 2
    for attempts in by_group.values():
        # attempt 1 is terminal 'retryable' (never mutated further); a fresh
        # 'queued' attempt 2 exists for the same (scope, partition) so the
        # parent is never left claimable while its successor exists.
        assert attempts == [(1, "retryable"), (2, "queued")]

    # The job cannot remain 'queued' now that at least one batch has
    # terminally failed, but claimable successor work still exists so it must
    # not be finalized yet either.
    assert conn.execute("SELECT status FROM metric_sync_jobs").fetchone()[0] == "running"


def test_retryable_successor_chain_stops_at_the_configured_attempt_cap(
    conn, monkeypatch, gold_payload, merchant_with_gbp_profiles
):
    """Controller Ruling 1: stop creating successors once attempt reaches
    SEO_OPS_PERFORMANCE_MAX_AUTO_ATTEMPTS; the last failure stays terminal
    with no successor."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_MAX_AUTO_ATTEMPTS", "2")
    plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    client = FakeFbrClient(gold_payload, failures=999)
    for _ in range(3):
        process_metric_sync_batches_once(client, max_batches=2, now=NOW)

    rows = conn.execute(
        "SELECT source_scope_id, attempt, status FROM metric_sync_batches ORDER BY source_scope_id, attempt"
    ).fetchall()
    by_scope: dict[int, list[tuple[int, str]]] = {}
    for row in rows:
        by_scope.setdefault(row["source_scope_id"], []).append((row["attempt"], row["status"]))
    assert len(by_scope) == 2
    for attempts in by_scope.values():
        # No attempt 3 was ever created: the chain stops at the cap of 2.
        assert attempts == [(1, "retryable"), (2, "retryable")]

    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 0
    # Every group is now terminally failed with no claimable work left, so
    # Ruling 4 requires the job to not remain 'queued' (or 'running').
    assert conn.execute("SELECT status FROM metric_sync_jobs").fetchone()[0] == "failed"


def test_blocked_classification_never_gets_a_successor(conn, monkeypatch, merchant_with_gbp_profiles):
    """Controller Ruling 1: a 'blocked' classification never gets a successor
    at all, unlike 'retryable'."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)

    class BuggyClient:
        def list_performance_metrics(self, *args, **kwargs):
            raise RuntimeError("boom - not a recognised FBR error")

    process_metric_sync_batches_once(BuggyClient(), max_batches=2, now=NOW)
    rows = conn.execute(
        "SELECT source_scope_id, attempt, status FROM metric_sync_batches ORDER BY source_scope_id, attempt"
    ).fetchall()
    by_scope: dict[int, list[tuple[int, str]]] = {}
    for row in rows:
        by_scope.setdefault(row["source_scope_id"], []).append((row["attempt"], row["status"]))
    for attempts in by_scope.values():
        assert attempts == [(1, "blocked")]
    assert conn.execute("SELECT status FROM metric_sync_jobs").fetchone()[0] == "failed"


def test_claim_next_batch_reclaims_an_expired_lease_in_place(conn, monkeypatch, merchant_with_gbp_profiles):
    """Controller Ruling 3: claim_next_batch selects only queued batches and
    leased batches whose lease has expired; re-leasing an expired lease
    refreshes it in place (status stays 'leased') rather than transitioning,
    because protect_metric_sync_batch_transition only fires on a status
    change."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    first = claim_next_batch(conn, owner_token="worker-a", now=NOW, lease_seconds=30)
    assert first is not None
    # The lease has not expired yet: nothing else is claimable.
    still_locked = claim_next_batch(conn, owner_token="worker-b", now=NOW, lease_seconds=30)
    assert still_locked is None or still_locked["id"] != first["id"]

    later = NOW + timedelta(seconds=31)
    reclaimed = claim_next_batch(conn, owner_token="worker-b", now=later, lease_seconds=30)
    assert reclaimed is not None
    assert reclaimed["id"] == first["id"]
    row = conn.execute(
        "SELECT status, lease_owner FROM metric_sync_batches WHERE id = ?", (first["id"],)
    ).fetchone()
    assert row["status"] == "leased"
    assert row["lease_owner"] == "worker-b"


def test_a_closed_scope_binding_is_classified_and_does_not_crash_the_pass(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    """Review finding 1: the classification try-block was too narrow --
    resolving the scope via the active binding join can legitimately return
    None (Task 4 can close a binding), and that must be classified 'blocked'
    like any other bug, not propagate out and strand the batch 'leased'
    forever (re-claimed first on every following pass, since claims are
    ordered by id ascending)."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 18),
                  job_type="backfill", request_id="unbound", operator="test", now=NOW)
    # Close every active binding, exactly as Task 4 would when a location is
    # unbound -- the batch's source_scope_id now resolves to no active row.
    conn.execute(
        "UPDATE source_scope_bindings SET valid_to = ?, closed_by = 'test', close_reason = 'test_unbind'"
        " WHERE valid_to IS NULL",
        (canonical_instant(NOW + timedelta(seconds=1)),),
    )
    conn.commit()

    class NeverCalledClient:
        def list_performance_metrics(self, *args, **kwargs):
            raise AssertionError("fetch must not be reached once the scope has no active binding")

    processed = process_metric_sync_batches_once(NeverCalledClient(), max_batches=4, now=NOW)
    assert processed == 2
    statuses = {row[0] for row in conn.execute("SELECT status FROM metric_sync_batches")}
    assert statuses == {"blocked"}
    assert conn.execute("SELECT status FROM metric_sync_jobs WHERE id = ?", (plan.job_id,)).fetchone()[0] == "failed"


def test_a_quality_event_failure_after_a_successful_publish_does_not_corrupt_the_batch(
    conn, monkeypatch, gold_payload, merchant_with_gbp_profiles
):
    """Review finding 1 fix: publish and quality-event recording now share
    one try/classification block. Once publish_metric_batch has actually
    succeeded the batch is terminal 'published' -- a later failure recording
    the omission quality event must not attempt to illegally re-transition
    it, or create a bogus successor for an already-published partition."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)

    import app.performance_sync as performance_sync_module

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated quality-event write failure")

    monkeypatch.setattr(performance_sync_module, "record_quality_event", _boom)

    client = FakeFbrClient(gold_payload)
    process_metric_sync_batches_once(client, max_batches=1, now=NOW)

    rows = conn.execute("SELECT status, attempt FROM metric_sync_batches ORDER BY id").fetchall()
    assert rows[0]["status"] == "published"
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] > 0
    # No bogus successor was created for a partition that already published.
    assert conn.execute("SELECT COUNT(*) FROM metric_sync_batches").fetchone()[0] == 2


def test_a_stranded_job_is_swept_to_a_terminal_status_on_the_next_pass(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    """Review finding 2 (corrects the original task's Ruling 2 acceptance):
    simulate a worker that terminalized every batch of a job and then
    crashed before ever calling _finalize_job -- exactly the accepted window
    between the two commits. Without a sweep the job would sit at 'running'
    with finished_at NULL forever, since _finalize_job is otherwise only
    invoked as a side effect of processing one of that job's own batches."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 18),
                  job_type="backfill", request_id="strand", operator="test", now=NOW)
    assert len(plan.batch_ids) == 2

    for _ in plan.batch_ids:
        claimed = claim_next_batch(conn, owner_token="crashed-worker", now=NOW, lease_seconds=30)
        assert claimed is not None
        transitioned = _terminalize_batch(
            conn, claimed["id"], owner_token="crashed-worker", status="blocked",
            error_category="blocked", error_summary="simulated crash before finalize", now=NOW,
        )
        assert transitioned is True
    # Every batch is now terminal, but the crashed worker never got to call
    # _finalize_job for the last one: the job is stranded at 'running'.
    assert conn.execute(
        "SELECT status FROM metric_sync_jobs WHERE id = ?", (plan.job_id,)
    ).fetchone()[0] == "running"

    class NeverCalledClient:
        def list_performance_metrics(self, *args, **kwargs):
            raise AssertionError("nothing is claimable; the client must not be called")

    processed = process_metric_sync_batches_once(NeverCalledClient(), max_batches=4, now=NOW)
    assert processed == 0
    job = conn.execute(
        "SELECT status, finished_at FROM metric_sync_jobs WHERE id = ?", (plan.job_id,)
    ).fetchone()
    assert job["status"] == "failed"
    assert job["finished_at"] is not None


def test_a_worker_that_lost_its_lease_no_ops_instead_of_re_terminalizing(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    """Also-fix: _terminalize_batch and _confirm_lease fence on (status,
    lease_owner) so a worker whose lease was reassigned to someone else
    becomes a safe no-op instead of racing -- or illegally re-transitioning a
    batch -- the new owner already resolved."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    plan = plan_sync_job(conn, merchant_with_gbp_profiles, date(2026, 8, 18), date(2026, 8, 18),
                  job_type="backfill", request_id="fence", operator="test", now=NOW)
    batch_id = plan.batch_ids[0]

    claim_next_batch(conn, owner_token="worker-a", now=NOW, lease_seconds=30)
    # worker-a's lease has (conceptually) expired while it was still
    # processing; worker-b re-leases the same batch.
    claim_next_batch(conn, owner_token="worker-b", now=NOW + timedelta(seconds=31), lease_seconds=30)
    row = conn.execute("SELECT lease_owner FROM metric_sync_batches WHERE id = ?", (batch_id,)).fetchone()
    assert row["lease_owner"] == "worker-b"

    # worker-a, unaware it lost the lease, tries to confirm/terminalize using
    # its own stale owner token. Both must no-op rather than touch the row.
    assert _confirm_lease(conn, batch_id, "worker-a", now=NOW) is False
    transitioned = _terminalize_batch(
        conn, batch_id, owner_token="worker-a", status="blocked", error_category="blocked",
        error_summary="stale worker", now=NOW,
    )
    assert transitioned is False
    still = conn.execute(
        "SELECT status, lease_owner FROM metric_sync_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    assert still["status"] == "leased"
    assert still["lease_owner"] == "worker-b"


def test_enqueue_daily_performance_jobs_handles_multiple_pilot_merchants_independently(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    """Review finding 3: a date-only request id was shared by every pilot
    merchant under the same fixed requested_by='scheduler', so any merchant
    after the first collided on metric_sync_jobs' UNIQUE(requested_by,
    request_id) with an sqlite3.IntegrityError on the very first tick -- not
    just under a same-day scope rebind. The request id must be
    merchant-specific, and no single merchant's failure may abort the rest
    of the pilot cohort."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)
    conn.execute(
        "INSERT INTO merchants (id, name, status, created_at) VALUES"
        " (7,'Second Pilot','active','2026-09-01T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id,"
        " source_title, location_json, normalized_json, synced_at) VALUES"
        " (7,'fbr-7','9999999999999999999','Second Pilot Location','{}',?,'2026-09-03T00:00:00.000000Z')",
        (json.dumps({"title": "Second Pilot Location", "place_id": "ChIJsecondpilotplaceid"}),),
    )
    conn.commit()
    second_scopes = seed_gbp_locations_from_profiles(conn, 7, actor="test", observed_at=NOW)
    for scope in second_scopes:
        set_location_timezone(conn, scope.location.id, "America/New_York", actor="test", effective_at=NOW)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", f"{merchant_with_gbp_profiles},7")

    created = enqueue_daily_performance_jobs_once(now=NOW)
    assert created == 2
    request_ids = [
        row[0] for row in conn.execute("SELECT request_id FROM metric_sync_jobs WHERE requested_by = 'scheduler'")
    ]
    assert len(request_ids) == 2
    assert len(set(request_ids)) == 2  # merchant-specific: no collision


def test_daily_enqueue_plans_a_new_job_when_the_resolved_population_changes_mid_day(
    conn, monkeypatch, merchant_with_gbp_profiles
):
    """Fix round 2 ruling: the daily request id carries the scope-manifest
    hash, not just the date and merchant id, so a population that changes
    between ticks on the same day (a location bound or unbound) plans a
    genuinely new job instead of colliding on metric_sync_jobs'
    UNIQUE(requested_by, request_id) and silently going dark for that
    merchant until the date rolls over. An *unchanged* population across
    repeated ticks must still short-circuit to exactly one job."""
    _pilot(conn, monkeypatch, merchant_with_gbp_profiles)

    assert enqueue_daily_performance_jobs_once(now=NOW) == 1
    # Re-enqueuing with an unchanged population must not create a second job.
    assert enqueue_daily_performance_jobs_once(now=NOW) == 1
    jobs = conn.execute(
        "SELECT id, request_id FROM metric_sync_jobs WHERE requested_by = 'scheduler' ORDER BY id"
    ).fetchall()
    assert len(jobs) == 1

    # The population changes mid-day: close one of the two active bindings,
    # exactly as Task 4 would when a location is unbound. One scope remains
    # bound, so the merchant is still "ready" -- this is a changed
    # population, not an empty one.
    later = NOW + timedelta(hours=1)
    closing_scope_id = conn.execute(
        "SELECT source_scope_id FROM source_scope_bindings WHERE valid_to IS NULL ORDER BY source_scope_id LIMIT 1"
    ).fetchone()[0]
    conn.execute(
        "UPDATE source_scope_bindings SET valid_to = ?, closed_by = 'test', close_reason = 'test_unbind'"
        " WHERE source_scope_id = ? AND valid_to IS NULL",
        (canonical_instant(later), closing_scope_id),
    )
    conn.commit()

    created = enqueue_daily_performance_jobs_once(now=later)
    assert created == 1  # planned, not silently skipped and not an exception
    jobs = conn.execute(
        "SELECT id, request_id FROM metric_sync_jobs WHERE requested_by = 'scheduler' ORDER BY id"
    ).fetchall()
    assert len(jobs) == 2
    assert jobs[0]["request_id"] != jobs[1]["request_id"]

    # Re-enqueuing again with the now-stable (changed) population must not
    # create a third job.
    assert enqueue_daily_performance_jobs_once(now=later) == 1
    assert conn.execute(
        "SELECT COUNT(*) FROM metric_sync_jobs WHERE requested_by = 'scheduler'"
    ).fetchone()[0] == 2


def test_scheduler_helpers_are_inert_when_the_pilot_flag_is_off(monkeypatch):
    """Both scheduler helpers must return 0 immediately -- without ever
    calling connect() -- when SEO_OPS_PERFORMANCE_SYNC_ENABLED is not 'true',
    so behaviour is unchanged until the pilot is enabled."""
    from app import performance_sync

    monkeypatch.delenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", raising=False)

    def _forbidden():
        raise AssertionError("connect() must not be called while the pilot flag is off")

    monkeypatch.setattr(performance_sync, "connect", _forbidden)

    assert enqueue_daily_performance_jobs_once(now=NOW) == 0
    assert process_metric_sync_batches_once(object(), now=NOW) == 0

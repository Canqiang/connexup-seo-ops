import asyncio
from datetime import datetime, timedelta, timezone

import pytest

def test_hourly_fbr_sync_only_calls_due_active_bound_merchants_and_isolates_failures(
    client,
):
    from app.db import connect
    from app.fbr_gbp import FbrUnavailableError
    from app.scheduler import sync_due_fbr_profiles_once

    now = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)

    def merchant_with_link(name, external_id, status, updated_at, last_synced_at=None):
        merchant = client.post(
            "/api/merchants",
            json={"name": name, "primary_location": "Mineola, NY"},
        ).json()
        client.put(
            f"/api/merchants/{merchant['id']}/fbr-link",
            json={"fbr_merchant_id": external_id},
        )
        conn = connect()
        try:
            conn.execute(
                "UPDATE merchant_fbr_links"
                " SET sync_status = ?, updated_at = ?, last_synced_at = ?"
                " WHERE merchant_id = ?",
                (status, updated_at, last_synced_at, merchant["id"]),
            )
            conn.commit()
        finally:
            conn.close()
        return merchant

    old = "2026-09-03T10:59:59+00:00"
    fresh = "2026-09-03T11:30:00+00:00"
    failed = merchant_with_link("failed due", "fbr-fail", "failed", old, old)
    due = merchant_with_link("synced due", "fbr-due", "synced", old, old)
    merchant_with_link("synced fresh", "fbr-fresh", "synced", fresh, fresh)
    merchant_with_link("failed fresh", "fbr-failed-fresh", "failed", fresh, old)
    never = merchant_with_link("never synced", "fbr-never", "not_synced", fresh)
    archived = merchant_with_link("archived", "fbr-archived", "synced", old, old)
    client.patch(f"/api/merchants/{archived['id']}", json={"status": "archived"})
    client.post(
        "/api/merchants",
        json={"name": "unbound", "primary_location": "Mineola, NY"},
    )

    class IsolatingClient:
        def __init__(self):
            self.calls = []

        def list_locations(self, fbr_merchant_id):
            self.calls.append(fbr_merchant_id)
            if fbr_merchant_id == "fbr-fail":
                raise FbrUnavailableError("temporary FBR outage")
            return []

    fake = IsolatingClient()
    result = sync_due_fbr_profiles_once(fake, current_time=now)

    assert fake.calls == ["fbr-fail", "fbr-due", "fbr-never"]
    assert result == {"attempted": 3, "synced": 2, "failed": 1}

    conn = connect()
    try:
        failed_row = conn.execute(
            "SELECT sync_status, last_synced_at, last_error FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (failed["id"],),
        ).fetchone()
        due_row = conn.execute(
            "SELECT sync_status, last_synced_at FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (due["id"],),
        ).fetchone()
        never_row = conn.execute(
            "SELECT sync_status, last_synced_at FROM merchant_fbr_links"
            " WHERE merchant_id = ?",
            (never["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert dict(failed_row) == {
        "sync_status": "failed",
        "last_synced_at": old,
        "last_error": "temporary FBR outage",
    }
    assert dict(due_row) == {
        "sync_status": "synced",
        "last_synced_at": now.isoformat(),
    }
    assert dict(never_row) == {
        "sync_status": "synced",
        "last_synced_at": now.isoformat(),
    }


def test_scheduler_checks_due_fbr_profiles_each_tick_without_core_ai_configuration(monkeypatch):
    from app import scheduler

    fbr_client = object()
    calls = []
    sleeps = 0

    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client, raising=False)
    monkeypatch.setattr(
        scheduler,
        "sync_due_fbr_profiles_once",
        lambda client: calls.append(client),
        raising=False,
    )

    class TwoTicksComplete(Exception):
        pass

    async def stop_after_two_ticks(_delay):
        nonlocal sleeps
        sleeps += 1
        if sleeps == 2:
            raise TwoTicksComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_two_ticks)
    with pytest.raises(TwoTicksComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

    assert scheduler.FBR_DUE_CHECK_EVERY_TICKS == 1
    assert calls == [fbr_client, fbr_client]


def test_fbr_due_scan_uses_a_fresh_clock_for_each_merchant(client, monkeypatch):
    from app import scheduler

    for suffix in ("one", "two"):
        merchant = client.post(
            "/api/merchants",
            json={"name": f"clock {suffix}", "primary_location": "Mineola, NY"},
        ).json()
        linked = client.put(
            f"/api/merchants/{merchant['id']}/fbr-link",
            json={"fbr_merchant_id": f"fbr-clock-{suffix}"},
        )
        assert linked.status_code == 200

    first = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)
    second = first + timedelta(minutes=20)
    clock = iter((first, second))

    observed_due_times = []
    observed_sync_kwargs = []
    monkeypatch.setattr(
        scheduler,
        "gbp_sync_due",
        lambda _link, current: (observed_due_times.append(current) or True),
    )
    monkeypatch.setattr(
        scheduler,
        "sync_gbp_profile_once",
        lambda _conn, _client, merchant_id, **kwargs: (
            observed_sync_kwargs.append((merchant_id, kwargs)) or True
        ),
    )

    result = scheduler.sync_due_fbr_profiles_once(object(), clock=lambda: next(clock))

    assert observed_due_times == [first, second]
    assert [kwargs for _merchant_id, kwargs in observed_sync_kwargs] == [{}, {}]
    assert result == {"attempted": 2, "synced": 2, "failed": 0}


def test_hourly_fbr_sync_loop_is_independent_of_core_ai_polling(monkeypatch):
    from app import scheduler

    fbr_client = object()
    calls = []

    monkeypatch.setattr(
        scheduler,
        "coreai_settings",
        lambda: (_ for _ in ()).throw(AssertionError("FBR loop must not inspect Core AI")),
    )
    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client)
    monkeypatch.setattr(
        scheduler,
        "sync_due_fbr_profiles_once",
        lambda client: calls.append(client),
    )

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

    assert calls == [fbr_client]


def test_fbr_loop_wires_the_performance_sync_helpers_each_tick(monkeypatch):
    from app import scheduler

    fbr_client = object()
    enqueue_calls = []
    process_calls = []

    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client)
    monkeypatch.setattr(scheduler, "sync_due_fbr_profiles_once", lambda client: None)
    monkeypatch.setattr(
        scheduler, "enqueue_daily_performance_jobs_once", lambda: enqueue_calls.append(True) or 0
    )
    monkeypatch.setattr(
        scheduler,
        "process_metric_sync_batches_once",
        lambda client: process_calls.append(client) or 0,
    )

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

    assert enqueue_calls == [True]
    assert process_calls == [fbr_client]


def test_fbr_loop_performance_sync_helpers_are_inert_while_the_pilot_flag_is_off(monkeypatch):
    """The scheduler wiring itself must not depend on the pilot flag: with it
    off, the real helpers run every tick and must return 0 without ever
    touching the database, so behaviour is unchanged until the pilot is
    enabled."""
    from app import performance_sync, scheduler

    monkeypatch.delenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", raising=False)

    fbr_client = object()
    monkeypatch.setattr(scheduler, "get_fbr_client", lambda: fbr_client)
    monkeypatch.setattr(scheduler, "sync_due_fbr_profiles_once", lambda client: None)

    def _forbidden_connect():
        raise AssertionError("performance sync must not touch the database while its flag is off")

    monkeypatch.setattr(performance_sync, "connect", _forbidden_connect)

    class OneTickComplete(Exception):
        pass

    async def stop_after_first_tick(_delay):
        raise OneTickComplete

    monkeypatch.setattr(scheduler.asyncio, "sleep", stop_after_first_tick)
    with pytest.raises(OneTickComplete):
        asyncio.run(scheduler.fbr_scheduler_loop())

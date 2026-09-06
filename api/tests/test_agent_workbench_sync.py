import asyncio
import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import UUID

import pytest

from app import agent_workbench
from app.config import BootstrapAgentSlot
from app.coreai import CoreAiError
from app.db import init_db


NOW = datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc)
LOCAL_ID = "11111111-1111-4111-8111-111111111111"


class ListOnlyCoreAiFake:
    def __init__(self, responses=None, metadata=None):
        self.responses = {
            key: list(values) for key, values in (responses or {}).items()
        }
        self.metadata = list(metadata or [])
        self.calls = []
        self.metadata_calls = []
        self.closed = False

    def list_agent_runs(self, agent_id, status, limit):
        self.calls.append((agent_id, status, limit))
        queue = self.responses.setdefault((agent_id, status), [])
        value = queue.pop(0) if queue else {"runs": [], "total": 0}
        if isinstance(value, BaseException):
            raise value
        if callable(value):
            value = value()
        return value

    def get_agent(self, agent_id):
        self.metadata_calls.append(agent_id)
        value = self.metadata.pop(0) if self.metadata else {
            "id": agent_id,
            "type": "AGENT",
            "status": "PUBLISHED",
            "name": "Verified Agent",
            "model": "model-sync",
            "timeout_seconds": 900,
        }
        if isinstance(value, BaseException):
            raise value
        if callable(value):
            value = value()
        return value

    def get_run(self, _run_id):
        raise AssertionError("single-Run detail must never be called")

    def close(self):
        self.closed = True


def _slot(
    coreai_agent_id="agent-primary",
    *,
    key="diagnosis-plan",
    order=10,
    env_name="COREAI_AGENT_ID",
):
    return BootstrapAgentSlot(
        env_name=env_name,
        agent_key=key,
        display_name=f"Agent {key}",
        role=f"Role {key}",
        sort_order=order,
        coreai_agent_id=coreai_agent_id,
    )


def _connection(tmp_path, monkeypatch, name="sync.db"):
    database = tmp_path / name
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "sync-secret")
    init_db()
    conn = sqlite3.connect(database, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _seed_agent(conn, monkeypatch, *, now=NOW):
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), now)
    return LOCAL_ID


def _page(agent_id="agent-primary", status=None, run_ids=(), total=None):
    rows = [
        {
            "id": run_id,
            "agent_id": agent_id,
            "status": status or "RUNNING",
            "triggered_by": "WORKFLOW",
            "started_at": "2026-09-03T03:59:50+00:00",
        }
        for run_id in run_ids
    ]
    return {"runs": rows, "total": len(rows) if total is None else total}


def _db_file(conn):
    return conn.execute("PRAGMA database_list").fetchone()[2]


def _state(conn, local_id=LOCAL_ID):
    return conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()


def _full_responses(*, unfiltered=None, pending=None, running=None, paused=None):
    return {
        ("agent-primary", None): [unfiltered or _page(total=0)],
        ("agent-primary", "PENDING"): [pending or _page(status="PENDING", total=0)],
        ("agent-primary", "RUNNING"): [running or _page(status="RUNNING", total=0)],
        ("agent-primary", "PAUSED"): [paused or _page(status="PAUSED", total=0)],
    }


def _insert_unconfirmed(conn, status, run_id="local-unconfirmed"):
    if status is None:
        merchant_id = conn.execute(
            "INSERT INTO merchants (name,created_at) VALUES ('Sync Merchant',?)",
            (NOW.isoformat(),),
        ).lastrowid
        source_id = conn.execute(
            "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
            "VALUES (?,?,'running','manual',?)",
            (merchant_id, run_id, NOW.isoformat()),
        ).lastrowid
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,"
            "raw_status,source_kind,source_local_id,merchant_id,first_seen_at,"
            "data_warning_codes_json) VALUES (?,?,NULL,'run',?,?,?,?)",
            (
                run_id,
                LOCAL_ID,
                source_id,
                merchant_id,
                NOW.isoformat(),
                '["LOCAL_TRIGGER_STATUS_MISSING"]',
            ),
        )
    else:
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,"
            "raw_status,trigger_type,started_at,first_seen_at) "
            "VALUES (?,?,?,'WORKFLOW',?,?)",
            (run_id, LOCAL_ID, status, NOW.isoformat(), NOW.isoformat()),
        )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=1,"
        "history_event_epoch=1,unresolved_unknown_status_count=?,"
        "next_discovery_at=? WHERE seo_ops_agent_id=?",
        (int(status is None or status == "FUTURE_STATE"), NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()


def test_list_only_fake_guards_detail_call():
    fake = ListOnlyCoreAiFake()
    with pytest.raises(AssertionError, match="single-Run detail"):
        fake.get_run("forbidden")
    fake.close()
    assert fake.closed is True


def test_claim_and_release_independent_leases(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "independent-leases.db")
    _seed_agent(conn, monkeypatch)

    run_lease = agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "run-owner", NOW
    )
    metadata_lease = agent_workbench.claim_due_metadata_sync(
        conn, LOCAL_ID, "metadata-owner", NOW
    )

    assert run_lease == agent_workbench.AgentRunSyncLease(
        local_agent_id=LOCAL_ID,
        coreai_agent_id="agent-primary",
        lifecycle_status="active",
        owner="run-owner",
        epoch=1,
        lease_until="2026-09-03T04:00:45+00:00",
        discovery_due=True,
        fast_statuses=(),
        local_event_epoch=0,
        history_event_epoch=0,
    )
    assert metadata_lease == agent_workbench.AgentMetadataLease(
        local_agent_id=LOCAL_ID,
        coreai_agent_id="agent-primary",
        owner="metadata-owner",
        epoch=1,
        lease_until="2026-09-03T04:00:45+00:00",
        local_event_epoch=0,
    )
    assert agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "other-run", NOW
    ) is None
    assert agent_workbench.claim_due_metadata_sync(
        conn, LOCAL_ID, "other-metadata", NOW
    ) is None

    agent_workbench.release_run_lease(conn, run_lease)
    row = conn.execute(
        "SELECT s.lease_owner,a.metadata_lease_owner "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(row) == (None, "metadata-owner")
    agent_workbench.release_metadata_lease(conn, metadata_lease)
    row = conn.execute(
        "SELECT s.lease_owner,a.metadata_lease_owner "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(row) == (None, None)
    conn.close()


def test_independent_lease_renewal_and_expiry(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "lease-renewal.db")
    _seed_agent(conn, monkeypatch)
    run_lease = agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "run-owner", NOW
    )
    metadata_lease = agent_workbench.claim_due_metadata_sync(
        conn, LOCAL_ID, "metadata-owner", NOW
    )

    renewed_at = NOW + timedelta(seconds=10)
    assert agent_workbench.renew_run_lease(conn, run_lease, renewed_at) is True
    row = conn.execute(
        "SELECT s.lease_until,a.metadata_lease_owner,a.metadata_lease_until "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(row) == (
        "2026-09-03T04:00:55+00:00",
        "metadata-owner",
        "2026-09-03T04:00:45+00:00",
    )
    wrong_owner = agent_workbench.AgentRunSyncLease(
        **{**run_lease.__dict__, "owner": "wrong-owner"}
    )
    assert agent_workbench.renew_run_lease(conn, wrong_owner, renewed_at) is False
    assert agent_workbench.renew_run_lease(
        conn, run_lease, NOW + timedelta(seconds=55)
    ) is False

    assert agent_workbench.renew_metadata_lease(
        conn, metadata_lease, renewed_at
    ) is True
    row = conn.execute(
        "SELECT s.lease_until,a.metadata_lease_until "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(row) == (
        "2026-09-03T04:00:55+00:00",
        "2026-09-03T04:00:55+00:00",
    )
    wrong_metadata_owner = agent_workbench.AgentMetadataLease(
        **{**metadata_lease.__dict__, "owner": "wrong-owner"}
    )
    assert agent_workbench.renew_metadata_lease(
        conn, wrong_metadata_owner, renewed_at
    ) is False
    assert agent_workbench.renew_metadata_lease(
        conn, metadata_lease, NOW + timedelta(seconds=55)
    ) is False
    conn.close()


def test_full_discovery_proof(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "full-proof.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    fake = ListOnlyCoreAiFake(
        {
            ("agent-primary", None): [_page(run_ids=("run-1",), total=1)],
            ("agent-primary", "PENDING"): [
                _page(status="PENDING", total=0)
            ],
            ("agent-primary", "RUNNING"): [
                _page(status="RUNNING", run_ids=("run-1",), total=1)
            ],
            ("agent-primary", "PAUSED"): [_page(status="PAUSED", total=0)],
        }
    )

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW,
        client_factory=lambda: fake,
    ) is True
    assert fake.calls == [
        ("agent-primary", None, 200),
        ("agent-primary", "PENDING", 200),
        ("agent-primary", "RUNNING", 200),
        ("agent-primary", "PAUSED", 200),
    ]
    assert fake.metadata_calls == []
    assert fake.closed is True

    check = sqlite3.connect(str(tmp_path / "full-proof.db"))
    check.row_factory = sqlite3.Row
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 1
    assert state["sync_pending"] == 0
    assert (
        state["pending_observed_count"],
        state["running_observed_count"],
        state["paused_observed_count"],
    ) == (0, 1, 0)
    assert (
        state["pending_set_quality"],
        state["running_set_quality"],
        state["paused_set_quality"],
    ) == ("exact", "exact", "exact")
    assert state["history_event_epoch"] == 1
    assert state["unfiltered_proven_event_epoch"] == 1
    assert state["next_discovery_at"] == "2026-09-03T04:00:30+00:00"
    assert check.execute(
        "SELECT raw_status FROM seo_ops_agent_runs WHERE coreai_run_id='run-1'"
    ).fetchone()[0] == "RUNNING"
    check.close()

    second = ListOnlyCoreAiFake()
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: second,
    ) is False
    assert second.calls == []
    assert second.closed is False


def test_cycle_commits_atomically_and_schedules(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "atomic-cycle.db")
    _seed_agent(conn, monkeypatch)
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "owner", NOW)
    fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=_page(run_ids=("run-a", "run-b"), total=2),
            running=_page(status="RUNNING", run_ids=("run-a", "run-b"), total=2),
        )
    )
    cycle = agent_workbench.execute_run_request_plan(fake, lease, NOW, 200)
    wrong = agent_workbench.AgentRunSyncLease(
        **{**lease.__dict__, "epoch": lease.epoch + 1}
    )
    before = tuple(_state(conn))
    assert agent_workbench.commit_discovery_cycle(conn, wrong, cycle, NOW) is False
    assert tuple(_state(conn)) == before

    original = agent_workbench._apply_sync_run_tx
    calls = 0

    def fail_second(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("forced atomic failure")
        return original(*args, **kwargs)

    monkeypatch.setattr(agent_workbench, "_apply_sync_run_tx", fail_second)
    with pytest.raises(RuntimeError, match="forced atomic failure"):
        agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW)
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 0
    monkeypatch.setattr(agent_workbench, "_apply_sync_run_tx", original)
    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW) is True
    state = _state(conn)
    assert state["next_discovery_at"] == "2026-09-03T04:00:30+00:00"
    assert state["next_fast_poll_at"] == "2026-09-03T04:00:05+00:00"
    assert state["lease_owner"] is None
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 2
    conn.close()


def test_projection_revision_tracks_material_change_not_heartbeat(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "revision.db")
    _seed_agent(conn, monkeypatch)
    conn.close()

    def sync(at, status="RUNNING", tokens=None):
        row = _page(status=status, run_ids=("run-rev",), total=1)
        row["runs"][0]["token_usage"] = tokens
        fake = ListOnlyCoreAiFake(
            _full_responses(
                unfiltered=row,
                running=(row if status == "RUNNING" else _page(status="RUNNING", total=0)),
                pending=(row if status == "PENDING" else _page(status="PENDING", total=0)),
            )
        )
        check = sqlite3.connect(str(tmp_path / "revision.db"))
        check.execute(
            "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
            "WHERE seo_ops_agent_id=?", (at.isoformat(), LOCAL_ID)
        )
        check.commit()
        check.close()
        assert agent_workbench.sync_registered_agent_runs_once(
            LOCAL_ID, now=at, client_factory=lambda: fake
        )

    sync(NOW)
    check = sqlite3.connect(str(tmp_path / "revision.db"))
    first = check.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state"
    ).fetchone()[0]
    check.close()
    sync(NOW + timedelta(seconds=30))
    check = sqlite3.connect(str(tmp_path / "revision.db"))
    assert check.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state"
    ).fetchone()[0] == first
    check.close()
    sync(NOW + timedelta(seconds=60), "PENDING")
    check = sqlite3.connect(str(tmp_path / "revision.db"))
    second = check.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state"
    ).fetchone()[0]
    assert second == first + 1
    check.close()
    sync(NOW + timedelta(seconds=90), "COMPLETED", {"input": 3, "output": 5})
    check = sqlite3.connect(str(tmp_path / "revision.db"))
    assert check.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state"
    ).fetchone()[0] == second + 1
    check.close()


@pytest.mark.parametrize(
    "status,fast_due,all_unknown",
    [
        ("PENDING", True, False),
        ("RUNNING", True, False),
        ("PAUSED", False, False),
        ("COMPLETED", False, True),
        ("FAILED", False, True),
        ("TIMEOUT", False, True),
        ("CANCELLED", False, True),
        ("SKIPPED", False, True),
        ("FUTURE_STATE", False, True),
        (None, False, True),
    ],
)
def test_every_unconfirmed_raw_status_requires_exact_id_observation(
    tmp_path, monkeypatch, status, fast_due, all_unknown
):
    name = f"unconfirmed-{status or 'null'}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    _insert_unconfirmed(conn, status)
    conn.close()
    fake = ListOnlyCoreAiFake(_full_responses())
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 1
    qualities = tuple(state[f"{prefix}_set_quality"] for prefix in ("pending", "running", "paused"))
    if all_unknown:
        assert qualities == ("unknown", "unknown", "unknown")
    else:
        assert qualities[{"PENDING": 0, "RUNNING": 1, "PAUSED": 2}[status]] == "unknown"
    assert state["next_fast_poll_at"] == (
        "2026-09-03T04:00:05+00:00" if fast_due else None
    )
    assert state["next_discovery_at"] <= "2026-09-03T04:00:30+00:00"
    assert check.execute(
        "SELECT raw_status,last_synced_at FROM seo_ops_agent_runs"
    ).fetchone()[0] == status
    check.close()


@pytest.mark.parametrize(
    "lifecycle,delay", [("disabled", 900), ("retired", 86400)]
)
@pytest.mark.parametrize(
    "status",
    ["PENDING", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED", "FUTURE_STATE", None],
)
def test_inactive_unconfirmed_post_archival_cycle_preserves_lifecycle_cadence(
    tmp_path, monkeypatch, lifecycle, delay, status
):
    name = f"inactive-{lifecycle}-{status or 'null'}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    _insert_unconfirmed(conn, status)
    retired_at = NOW.isoformat() if lifecycle == "retired" else None
    conn.execute(
        "UPDATE seo_ops_agents SET status=?,retired_at=? WHERE id=?",
        (lifecycle, retired_at, LOCAL_ID),
    )
    conn.commit()
    conn.close()
    fake = ListOnlyCoreAiFake(_full_responses())
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["current_state_complete"] == 0
    assert state["next_fast_poll_at"] is None
    assert state["next_discovery_at"] == (NOW + timedelta(seconds=delay)).isoformat()
    check.close()
    second = ListOnlyCoreAiFake()
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW + timedelta(seconds=30), client_factory=lambda: second
    ) is False
    assert second.calls == []


@pytest.mark.parametrize(
    "remote,expected_quality,expected_count",
    [
        (_page(status="RUNNING", run_ids=("run-quality",), total=1), "exact", 1),
        (_page(status="RUNNING", run_ids=("run-quality",), total=3), "lower_bound", 1),
        (CoreAiError(0, "secret transport"), "unknown", 7),
    ],
)
def test_filtered_set_quality_truth_table(
    tmp_path, monkeypatch, remote, expected_quality, expected_count
):
    name = f"quality-{expected_quality}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_synced_at) "
        "VALUES ('run-quality',?,'RUNNING','WORKFLOW',?,?,?)",
        (LOCAL_ID, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET sync_pending=0,"
        "running_observed_count=7,running_upstream_total=7,"
        "running_set_quality='exact',next_discovery_at=?,next_fast_poll_at=? "
        "WHERE seo_ops_agent_id=?",
        (
            (NOW + timedelta(seconds=30)).isoformat(),
            NOW.isoformat(),
            LOCAL_ID,
        ),
    )
    conn.commit()
    conn.close()
    responses = {("agent-primary", "RUNNING"): [remote]}
    if isinstance(remote, BaseException):
        responses[("agent-primary", None)] = [CoreAiError(0, "secret fallback")]
    fake = ListOnlyCoreAiFake(responses)
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["running_set_quality"] == expected_quality
    assert state["running_observed_count"] == expected_count
    if expected_quality == "unknown":
        assert "secret" not in (state["last_fast_poll_error"] or "")
        run = check.execute(
            "SELECT raw_status,last_synced_at,last_poll_error FROM seo_ops_agent_runs"
        ).fetchone()
        assert run["raw_status"] == "RUNNING"
        assert run["last_synced_at"] == NOW.isoformat()
        assert "secret" not in run["last_poll_error"]
    check.close()


def test_fast_confirmation_deduplicates_status_calls(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "fast-dedup.db")
    _seed_agent(conn, monkeypatch)
    for run_id in ("run-fast-a", "run-fast-b"):
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
            "trigger_type,started_at,first_seen_at,last_synced_at) "
            "VALUES (?,?,'RUNNING','WORKFLOW',?,?,?)",
            (run_id, LOCAL_ID, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
        )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET sync_pending=0,next_discovery_at=?,"
        "next_fast_poll_at=? WHERE seo_ops_agent_id=?",
        ((NOW + timedelta(seconds=30)).isoformat(), NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    conn.close()
    fake = ListOnlyCoreAiFake(
        {("agent-primary", "RUNNING"): [_page(status="RUNNING", run_ids=("run-fast-a", "run-fast-b"), total=2)]}
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    assert fake.calls == [("agent-primary", "RUNNING", 200)]


@pytest.mark.parametrize("terminal_first", [False, True])
def test_same_cycle_status_conflict_blocks_complete_proof(
    tmp_path, monkeypatch, terminal_first
):
    name = f"conflict-{terminal_first}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    conn.close()
    unfiltered_status = "COMPLETED" if terminal_first else "PENDING"
    unfiltered = _page(status=unfiltered_status, run_ids=("run-conflict",), total=1)
    responses = _full_responses(
        unfiltered=unfiltered,
        pending=(
            _page(status="PENDING", run_ids=("run-conflict",), total=1)
            if not terminal_first else _page(status="PENDING", total=0)
        ),
        running=_page(status="RUNNING", run_ids=("run-conflict",), total=1),
    )
    fake = ListOnlyCoreAiFake(responses)
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["current_state_complete"] == 0
    assert state["current_state_error"].startswith("SAME_CYCLE_STATUS_CONFLICT")
    assert state["next_discovery_at"] == "2026-09-03T04:00:05+00:00"
    row = check.execute("SELECT * FROM seo_ops_agent_runs").fetchone()
    assert row["raw_status"] == ("COMPLETED" if terminal_first else "RUNNING")
    check.close()

    later = NOW + timedelta(seconds=6)
    stable_status = "COMPLETED" if terminal_first else "RUNNING"
    stable = _page(status=stable_status, run_ids=("run-conflict",), total=1)
    stable_fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=stable,
            running=(stable if stable_status == "RUNNING" else _page(status="RUNNING", total=0)),
        )
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=later, client_factory=lambda: stable_fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    assert _state(check)["current_state_error"] is None
    check.close()


def test_transition_resolution_merge_and_absence(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "transition.db")
    _seed_agent(conn, monkeypatch)
    for run_id, status in (("moving", "RUNNING"), ("still-pending", "PENDING")):
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
            "trigger_type,started_at,first_seen_at,last_synced_at) "
            "VALUES (?,?,?,'WORKFLOW',?,?,?)",
            (run_id, LOCAL_ID, status, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
        )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET sync_pending=0,next_discovery_at=?,"
        "next_fast_poll_at=? WHERE seo_ops_agent_id=?",
        ((NOW + timedelta(seconds=30)).isoformat(), NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    conn.close()
    fake = ListOnlyCoreAiFake(
        {
            ("agent-primary", "PENDING"): [
                _page(status="PENDING", run_ids=("moving", "still-pending"), total=2)
            ],
            ("agent-primary", "RUNNING"): [_page(status="RUNNING", total=0)],
        }
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW + timedelta(seconds=1), client_factory=lambda: fake
    )
    assert fake.calls == [
        ("agent-primary", "PENDING", 200),
        ("agent-primary", "RUNNING", 200),
    ]
    check = sqlite3.connect(str(tmp_path / "transition.db"))
    assert check.execute(
        "SELECT raw_status FROM seo_ops_agent_runs WHERE coreai_run_id='moving'"
    ).fetchone()[0] == "PENDING"
    check.close()

    later = NOW + timedelta(seconds=6)
    check = sqlite3.connect(str(tmp_path / "transition.db"))
    check.execute(
        "UPDATE seo_ops_agent_sync_state SET next_fast_poll_at=?,next_discovery_at=?",
        (later.isoformat(), (later + timedelta(seconds=30)).isoformat()),
    )
    check.commit()
    check.close()
    absent = ListOnlyCoreAiFake(
        {
            ("agent-primary", "PENDING"): [_page(status="PENDING", total=0)],
            ("agent-primary", None): [_page(total=0)],
        }
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=later, client_factory=lambda: absent
    )
    check = sqlite3.connect(str(tmp_path / "transition.db"))
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='moving'"
    ).fetchone()
    assert row["raw_status"] == "PENDING"
    assert "STATUS_NOT_IN_BOUNDED_LIST" in json.loads(row["data_warning_codes_json"])
    assert _state(check)["current_state_complete"] == 0
    check.close()


@pytest.mark.parametrize("fails", [False, True])
def test_metadata_only_due_success_and_failure(tmp_path, monkeypatch, fails):
    name = f"metadata-{fails}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET sync_pending=0,"
        "next_discovery_at=?,next_fast_poll_at=NULL,running_observed_count=4,"
        "running_set_quality='lower_bound' WHERE seo_ops_agent_id=?",
        ((NOW + timedelta(hours=1)).isoformat(), LOCAL_ID),
    )
    conn.execute(
        "UPDATE seo_ops_agents SET next_verification_at=?,coreai_name='Old Name',"
        "coreai_model='old-model' WHERE id=?", (NOW.isoformat(), LOCAL_ID)
    )
    conn.commit()
    before_sync = tuple(_state(conn))
    conn.close()
    fake = ListOnlyCoreAiFake(
        metadata=[CoreAiError(500, "body-secret")]
        if fails
        else [
            {
                "id": "agent-primary",
                "type": "AGENT",
                "status": "PUBLISHED",
                "name": "New Name",
                "model": "new-model",
                "timeout_seconds": 321,
            }
        ]
    )
    assert agent_workbench.verify_registered_agent_metadata_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    assert fake.metadata_calls == ["agent-primary"]
    assert fake.calls == []
    assert fake.closed is True
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    after_sync = tuple(_state(check))
    assert after_sync == before_sync
    agent = check.execute("SELECT * FROM seo_ops_agents WHERE id=?", (LOCAL_ID,)).fetchone()
    if fails:
        assert (agent["coreai_name"], agent["coreai_model"]) == ("Old Name", "old-model")
        assert agent["verification_failure_count"] == 1
        assert agent["next_verification_at"] == "2026-09-03T04:01:00+00:00"
        assert "body-secret" not in agent["last_verification_error"]
    else:
        assert (agent["coreai_name"], agent["coreai_model"], agent["coreai_timeout_hint_seconds"]) == ("New Name", "new-model", 321)
        assert agent["verification_failure_count"] == 0
        assert agent["next_verification_at"] == "2026-09-04T04:00:00+00:00"
    assert agent["metadata_lease_owner"] is None
    check.close()


def test_metadata_failure_does_not_block_list_proof(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "independent-lanes.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    metadata_fake = ListOnlyCoreAiFake(metadata=[CoreAiError(0, "metadata secret")])
    run_fake = ListOnlyCoreAiFake(_full_responses())
    with ThreadPoolExecutor(max_workers=2) as pool:
        metadata_future = pool.submit(
            agent_workbench.verify_registered_agent_metadata_once,
            LOCAL_ID,
            now=NOW,
            client_factory=lambda: metadata_fake,
        )
        run_future = pool.submit(
            agent_workbench.sync_registered_agent_runs_once,
            LOCAL_ID,
            now=NOW,
            client_factory=lambda: run_fake,
        )
        assert run_future.result(timeout=2) is True
        assert metadata_future.result(timeout=2) is True
    check = sqlite3.connect(str(tmp_path / "independent-lanes.db"))
    check.row_factory = sqlite3.Row
    assert _state(check)["current_state_complete"] == 1
    assert check.execute(
        "SELECT verification_failure_count FROM seo_ops_agents"
    ).fetchone()[0] == 1
    check.close()


def test_metadata_failure_backoff_is_bounded_and_lane_local(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "metadata-backoff.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
        "WHERE seo_ops_agent_id=?",
        ((NOW + timedelta(hours=2)).isoformat(), LOCAL_ID),
    )
    conn.commit()
    original_run_state = tuple(_state(conn))
    conn.close()
    at = NOW
    for index, delay in enumerate((60, 120, 240, 480, 960, 1920, 3600, 3600), 1):
        fake = ListOnlyCoreAiFake(metadata=[CoreAiError(0, f"metadata-{index}")])
        assert agent_workbench.verify_registered_agent_metadata_once(
            LOCAL_ID, now=at, client_factory=lambda fake=fake: fake
        )
        check = sqlite3.connect(str(tmp_path / "metadata-backoff.db"))
        check.row_factory = sqlite3.Row
        agent = check.execute("SELECT * FROM seo_ops_agents").fetchone()
        assert agent["verification_failure_count"] == index
        assert agent["next_verification_at"] == (at + timedelta(seconds=delay)).isoformat()
        assert tuple(_state(check)) == original_run_state
        check.close()
        at += timedelta(seconds=delay)


def test_sync_diagnostics_redact_secrets(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "redaction.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    secret = "transport-secret-xyz"
    fake = ListOnlyCoreAiFake(
        {
            ("agent-primary", None): [CoreAiError(500, secret)],
            ("agent-primary", "PENDING"): [ValueError(secret)],
            ("agent-primary", "RUNNING"): [RuntimeError(secret)],
            ("agent-primary", "PAUSED"): [
                {
                    "runs": [
                        {
                            "id": "safe-error-row",
                            "agent_id": "agent-primary",
                            "status": "PAUSED",
                            "triggered_by": "WORKFLOW",
                            "started_at": NOW.isoformat(),
                            "error": (
                                "Bearer sync-secret failed "
                                "https://core.example/path?api_key=sync-secret"
                            ),
                        }
                    ],
                    "total": 1,
                }
            ],
        }
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / "redaction.db"))
    check.row_factory = sqlite3.Row
    state_text = json.dumps(dict(_state(check)))
    run_text = json.dumps(dict(check.execute("SELECT * FROM seo_ops_agent_runs").fetchone()))
    for sentinel in (secret, "sync-secret"):
        assert sentinel not in state_text
        assert sentinel not in run_text
    assert "[REDACTED]" in run_text
    check.close()


def test_lifecycle_cadence_and_backoff(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "backoff.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    expected = (5, 10, 20, 40, 60, 60)
    at = NOW
    for index, delay in enumerate(expected, 1):
        fake = ListOnlyCoreAiFake(
            {("agent-primary", None): [CoreAiError(0, f"secret-{index}")]}
        )
        assert agent_workbench.sync_registered_agent_runs_once(
            LOCAL_ID, now=at, client_factory=lambda fake=fake: fake
        )
        check = sqlite3.connect(str(tmp_path / "backoff.db"))
        check.row_factory = sqlite3.Row
        state = _state(check)
        assert state["discovery_failure_count"] == index
        assert state["next_discovery_at"] == (at + timedelta(seconds=delay)).isoformat()
        check.close()
        before_due = ListOnlyCoreAiFake()
        assert agent_workbench.sync_registered_agent_runs_once(
            LOCAL_ID,
            now=at + timedelta(seconds=delay - 1),
            client_factory=lambda: before_due,
        ) is False
        at += timedelta(seconds=delay)


def test_filtered_only_new_identity_keeps_history_generation_dirty(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "2")
    conn = _connection(tmp_path, monkeypatch, "filtered-history.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    unfiltered = _page(run_ids=("run-window",), total=5)
    unfiltered["runs"][0]["started_at"] = "2026-09-03T03:50:00+00:00"
    running = _page(
        status="RUNNING", run_ids=("run-window", "run-filtered"), total=2
    )
    running["runs"][0]["started_at"] = "2026-09-03T03:50:00+00:00"
    running["runs"][1]["started_at"] = "2026-09-03T03:59:00+00:00"
    fake = ListOnlyCoreAiFake(
        _full_responses(unfiltered=unfiltered, running=running)
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / "filtered-history.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert check.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 2
    assert state["remote_total_runs"] == 5
    assert state["history_event_epoch"] == 2
    assert state["unfiltered_proven_event_epoch"] == 1
    assert state["finite_range_proven_start_at"] == "2026-09-03T03:59:00.000001+00:00"
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "Asia/Shanghai", 20
    )
    assert snapshot["coverage"]["history_complete"] is False
    assert snapshot["coverage"]["remote_total_runs"] is None
    assert snapshot["metrics_complete_for_range"] is False
    check.close()


def test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty(
    tmp_path, monkeypatch
):
    test_filtered_only_new_identity_keeps_history_generation_dirty(tmp_path, monkeypatch)
    database = tmp_path / "filtered-history.db"
    check = sqlite3.connect(str(database))
    check.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?",
        ((NOW + timedelta(seconds=30)).isoformat(),),
    )
    check.commit()
    check.close()
    later = NOW + timedelta(seconds=30)
    unfiltered = _page(run_ids=("run-window",), total=5)
    unfiltered["runs"][0]["started_at"] = "2026-09-03T03:50:00+00:00"
    fake = ListOnlyCoreAiFake(_full_responses(unfiltered=unfiltered))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=later, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(database))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["history_event_epoch"] == 2
    assert state["unfiltered_proven_event_epoch"] == 1
    check.close()


def test_untruncated_all_history_requires_exact_projected_id_set(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "exact-id-set.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_synced_at) "
        "VALUES ('omitted',?,'COMPLETED','WORKFLOW',?,?,?)",
        (LOCAL_ID, NOW.isoformat(), NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET history_event_epoch=1,"
        "unfiltered_proven_event_epoch=0 WHERE seo_ops_agent_id=?", (LOCAL_ID,)
    )
    conn.commit()
    conn.close()
    fake = ListOnlyCoreAiFake(_full_responses())
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / "exact-id-set.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["history_event_epoch"] == 1
    assert state["unfiltered_proven_event_epoch"] == 0
    assert state["finite_range_proven_start_at"] > NOW.isoformat()
    check.close()


@pytest.mark.parametrize("at_boundary", [False, True])
def test_finite_range_proof_ignores_old_unconfirmed_rows(
    tmp_path, monkeypatch, at_boundary
):
    name = f"finite-old-{at_boundary}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    range_start = agent_workbench._oldest_supported_range_start(NOW)
    factual = range_start if at_boundary else range_start - timedelta(seconds=1)
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Finite Merchant',?)",
        (NOW.isoformat(),),
    ).lastrowid
    source_id = conn.execute(
        "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
        "VALUES (?,'old-null','running','manual',?)",
        (merchant_id, factual.isoformat()),
    ).lastrowid
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "source_kind,source_local_id,merchant_id,first_seen_at,"
        "data_warning_codes_json) VALUES ('old-null',?,NULL,'run',?,?,?,?)",
        (
            LOCAL_ID,
            source_id,
            merchant_id,
            factual.isoformat(),
            '["LOCAL_TRIGGER_STATUS_MISSING"]',
        ),
    )
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at) VALUES "
        "('old-unconfirmed',?,'COMPLETED','WORKFLOW',?,?)",
        (LOCAL_ID, factual.isoformat(), factual.isoformat()),
    )
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_synced_at) VALUES "
        "('old-confirmed-missing-start',?,'COMPLETED','WORKFLOW',NULL,?,?)",
        (LOCAL_ID, factual.isoformat(), (NOW - timedelta(days=1)).isoformat()),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=1,"
        "history_event_epoch=3,unresolved_unknown_status_count=1,"
        "next_discovery_at=? WHERE seo_ops_agent_id=?", (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    conn.close()
    window = _page(run_ids=("window-row",), total=5)
    window["runs"][0]["started_at"] = range_start.isoformat()
    fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=window,
            running=_page(status="RUNNING", run_ids=("window-row",), total=1),
        )
    )
    fake.responses[("agent-primary", "RUNNING")][0]["runs"][0]["started_at"] = range_start.isoformat()
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    marker = agent_workbench._parse_time(_state(check)["finite_range_proven_start_at"])
    if at_boundary:
        assert marker > range_start
    else:
        assert marker <= range_start
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "Asia/Shanghai", 20
    )
    assert snapshot["metrics_complete_for_range"] is (not at_boundary)
    check.close()


def test_finite_range_boundary_is_inclusive(tmp_path, monkeypatch):
    test_finite_range_proof_ignores_old_unconfirmed_rows(
        tmp_path, monkeypatch, True
    )


def test_truncated_history_cannot_catch_up_with_any_missing_started_at(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "missing-start.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_synced_at) "
        "VALUES ('missing-start',?,'COMPLETED','WORKFLOW',NULL,?,?)",
        (LOCAL_ID, (NOW - timedelta(days=2)).isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET history_event_epoch=1,"
        "unfiltered_proven_event_epoch=0 WHERE seo_ops_agent_id=?", (LOCAL_ID,)
    )
    conn.commit()
    conn.close()
    truncated = _page(run_ids=("recent",), total=5)
    fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=truncated,
            running=_page(status="RUNNING", run_ids=("recent",), total=1),
        )
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / "missing-start.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["unfiltered_proven_event_epoch"] == 0
    next_at = NOW + timedelta(seconds=30)
    check.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?",
        (next_at.isoformat(),),
    )
    check.commit()
    check.close()
    complete_page = _page(
        status="RUNNING", run_ids=("missing-start", "recent"), total=2
    )
    complete_page["runs"][0]["status"] = "COMPLETED"
    complete_page["runs"][0]["started_at"] = None
    complete_fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=complete_page,
            running=_page(status="RUNNING", run_ids=("recent",), total=1),
        )
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=next_at, client_factory=lambda: complete_fake
    )
    check = sqlite3.connect(str(tmp_path / "missing-start.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["history_event_epoch"] == state["unfiltered_proven_event_epoch"] == 2
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "all", next_at, "Asia/Shanghai", 20
    )
    assert snapshot["coverage"]["history_complete"] is True
    check.close()


def test_startup_priming_and_dedup_window(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "startup.db")
    ids = iter(
        UUID(value)
        for value in (
            LOCAL_ID,
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
        )
    )
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(ids))
    agent_workbench.seed_configured_agents(
        conn,
        (
            _slot("agent-old", key="old", order=1),
            _slot("agent-recent", key="recent", order=2),
            _slot("agent-disabled", key="disabled", order=3),
        ),
        NOW - timedelta(hours=1),
    )
    future = (NOW + timedelta(hours=1)).isoformat()
    recent = (NOW - timedelta(seconds=5)).isoformat()
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?,"
        "last_discovery_attempt_at=NULL,lease_owner='live',lease_epoch=7,"
        "lease_until=? WHERE seo_ops_agent_id=?",
        (future, future, LOCAL_ID),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?,"
        "last_discovery_attempt_at=? WHERE seo_ops_agent_id=?",
        (future, recent, "22222222-2222-4222-8222-222222222222"),
    )
    conn.execute(
        "UPDATE seo_ops_agents SET last_verification_attempt_at=?,"
        "next_verification_at=? WHERE id=?", (recent, future, LOCAL_ID)
    )
    conn.execute(
        "UPDATE seo_ops_agents SET status='disabled',next_verification_at=? "
        "WHERE id=?", (future, "33333333-3333-4333-8333-333333333333")
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
        "WHERE seo_ops_agent_id=?",
        (future, "33333333-3333-4333-8333-333333333333"),
    )
    conn.commit()
    agent_workbench.prime_agent_workbench_startup(conn, NOW)
    old = conn.execute(
        "SELECT s.next_discovery_at,s.lease_owner,s.lease_epoch,s.lease_until,"
        "a.next_verification_at FROM seo_ops_agent_sync_state s "
        "JOIN seo_ops_agents a ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(old) == (NOW.isoformat(), "live", 7, future, future)
    recent_row = conn.execute(
        "SELECT s.next_discovery_at,a.next_verification_at "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        ("22222222-2222-4222-8222-222222222222",),
    ).fetchone()
    assert tuple(recent_row) == (future, NOW.isoformat())
    disabled = conn.execute(
        "SELECT s.next_discovery_at,a.next_verification_at "
        "FROM seo_ops_agent_sync_state s JOIN seo_ops_agents a "
        "ON a.id=s.seo_ops_agent_id WHERE a.id=?",
        ("33333333-3333-4333-8333-333333333333",),
    ).fetchone()
    assert tuple(disabled) == (future, future)
    conn.close()


def test_expired_or_reacquired_lease_discards_response(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "expired-fence.db")
    _seed_agent(conn, monkeypatch)
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "old", NOW)
    cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_full_responses()), lease, NOW, 200
    )
    before = tuple(_state(conn))
    assert agent_workbench.commit_discovery_cycle(
        conn, lease, cycle, NOW + timedelta(seconds=45)
    ) is False
    assert tuple(_state(conn)) == before
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET lease_owner='new',"
        "lease_epoch=lease_epoch+1,lease_until=? WHERE seo_ops_agent_id=?",
        ((NOW + timedelta(seconds=90)).isoformat(), LOCAL_ID),
    )
    conn.commit()
    before = tuple(_state(conn))
    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW) is False
    assert tuple(_state(conn)) == before
    conn.close()


@pytest.mark.parametrize(
    "lifecycle,delay,retired_at",
    [("disabled", 900, None), ("retired", 86400, NOW.isoformat())],
)
def test_inflight_lifecycle_change_controls_next_cadence(
    tmp_path, monkeypatch, lifecycle, delay, retired_at
):
    conn = _connection(tmp_path, monkeypatch, f"inflight-{lifecycle}.db")
    _seed_agent(conn, monkeypatch)
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "owner", NOW)
    cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_full_responses()), lease, NOW, 200
    )
    conn.execute(
        "UPDATE seo_ops_agents SET status=?,retired_at=? WHERE id=?",
        (lifecycle, retired_at, LOCAL_ID),
    )
    conn.commit()
    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW)
    state = _state(conn)
    assert state["next_discovery_at"] == (NOW + timedelta(seconds=delay)).isoformat()
    assert state["next_fast_poll_at"] is None
    conn.close()


def test_disabled_cycle_cannot_satisfy_reenable_proof(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "reenable-fence.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "UPDATE seo_ops_agents SET status='disabled' WHERE id=?", (LOCAL_ID,)
    )
    conn.commit()
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "archival", NOW)
    cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_full_responses()), lease, NOW, 200
    )
    conn.execute(
        "UPDATE seo_ops_agents SET status='active' WHERE id=?", (LOCAL_ID,)
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=1,sync_pending=1,"
        "next_discovery_at=? WHERE seo_ops_agent_id=?", (NOW.isoformat(), LOCAL_ID)
    )
    conn.commit()
    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW)
    state = _state(conn)
    assert state["sync_pending"] == 1
    assert state["current_state_complete"] == 0
    assert state["next_discovery_at"] == NOW.isoformat()
    conn.close()

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        owner="active-cycle",
        client_factory=lambda: ListOnlyCoreAiFake(_full_responses()),
    )
    check = sqlite3.connect(str(tmp_path / "reenable-fence.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["sync_pending"] == 0
    assert state["current_state_complete"] == 1
    check.close()


def test_local_registration_after_response_before_commit_blocks_idle(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "local-event-fence.db")
    _seed_agent(conn, monkeypatch)
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "old-cycle", NOW)
    cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_full_responses()), lease, NOW, 200
    )
    _insert_unconfirmed(conn, None, "accepted-after-response")
    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW)
    state = _state(conn)
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 1
    assert state["next_discovery_at"] == NOW.isoformat()
    assert state["unfiltered_proven_event_epoch"] is None
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    conn.close()

    observed = _page(status="RUNNING", run_ids=("accepted-after-response",), total=1)
    fake = ListOnlyCoreAiFake(
        _full_responses(unfiltered=observed, running=observed)
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: fake,
    )
    check = sqlite3.connect(str(tmp_path / "local-event-fence.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["current_state_complete"] == 1
    assert state["history_event_epoch"] == state["unfiltered_proven_event_epoch"] == 1
    row = check.execute("SELECT * FROM seo_ops_agent_runs").fetchone()
    assert row["raw_status"] == "RUNNING"
    assert row["last_synced_at"] is not None
    assert "LOCAL_TRIGGER_STATUS_MISSING" not in json.loads(
        row["data_warning_codes_json"]
    )
    check.close()


def test_failed_fast_confirmation_revokes_motion(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "fast-failure.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_poll_attempt_at,last_synced_at) "
        "VALUES ('run-motion',?,'RUNNING','WORKFLOW',?,?,?,?)",
        (
            LOCAL_ID,
            (NOW - timedelta(seconds=1)).isoformat(),
            NOW.isoformat(),
            (NOW - timedelta(seconds=1)).isoformat(),
            (NOW - timedelta(seconds=1)).isoformat(),
        ),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET sync_pending=0,current_state_complete=1,"
        "running_observed_count=1,running_upstream_total=1,"
        "running_set_quality='exact',pending_observed_count=0,"
        "pending_upstream_total=0,pending_set_quality='exact',paused_observed_count=0,"
        "paused_upstream_total=0,paused_set_quality='exact',next_discovery_at=?,"
        "next_fast_poll_at=?,last_fast_poll_success_at=? WHERE seo_ops_agent_id=?",
        (
            (NOW + timedelta(seconds=29)).isoformat(),
            NOW.isoformat(),
            (NOW - timedelta(seconds=1)).isoformat(),
            LOCAL_ID,
        ),
    )
    conn.commit()
    conn.close()
    fake = ListOnlyCoreAiFake(
        {
            ("agent-primary", "RUNNING"): [CoreAiError(0, "run-secret")],
            ("agent-primary", None): [CoreAiError(0, "fallback-secret")],
        }
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    check = sqlite3.connect(str(tmp_path / "fast-failure.db"))
    check.row_factory = sqlite3.Row
    row = check.execute("SELECT * FROM seo_ops_agent_runs").fetchone()
    assert row["raw_status"] == "RUNNING"
    assert row["last_synced_at"] == (NOW - timedelta(seconds=1)).isoformat()
    assert row["last_poll_attempt_at"] == NOW.isoformat()
    assert row["last_poll_error"] is not None
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "Asia/Shanghai", 20
    )
    signal = next(item for item in snapshot["signals"] if item["coreai_run_id"] == "run-motion")
    assert signal["fresh"] is False
    assert signal["signal_state"] == "uncertain"
    check.close()


@pytest.mark.parametrize("lifecycle,delay", [("disabled", 900), ("retired", 86400)])
def test_disabled_and_retired_archival_four_call_cycle(
    tmp_path, monkeypatch, lifecycle, delay
):
    name = f"archival-{lifecycle}.db"
    conn = _connection(tmp_path, monkeypatch, name)
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
        "trigger_type,started_at,first_seen_at,last_synced_at) "
        "VALUES ('old-running',?,'RUNNING','WORKFLOW',?,?,?)",
        (
            LOCAL_ID,
            NOW.isoformat(),
            NOW.isoformat(),
            (NOW - timedelta(seconds=1)).isoformat(),
        ),
    )
    conn.execute(
        "UPDATE seo_ops_agents SET status=?,retired_at=? WHERE id=?",
        (lifecycle, NOW.isoformat() if lifecycle == "retired" else None, LOCAL_ID),
    )
    conn.commit()
    conn.close()
    terminal = _page(status="COMPLETED", run_ids=("old-running",), total=1)
    fake = ListOnlyCoreAiFake(_full_responses(unfiltered=terminal))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    assert fake.calls == [
        ("agent-primary", None, 200),
        ("agent-primary", "PENDING", 200),
        ("agent-primary", "RUNNING", 200),
        ("agent-primary", "PAUSED", 200),
    ]
    check = sqlite3.connect(str(tmp_path / name))
    check.row_factory = sqlite3.Row
    assert check.execute("SELECT raw_status FROM seo_ops_agent_runs").fetchone()[0] == "COMPLETED"
    state = _state(check)
    assert state["next_fast_poll_at"] is None
    assert state["next_discovery_at"] == (NOW + timedelta(seconds=delay)).isoformat()
    check.close()


def test_due_lists_are_lane_ordered_and_independent(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "due-order.db")
    local_ids = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        "33333333-3333-4333-8333-333333333333",
    ]
    identities = iter(UUID(value) for value in local_ids)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(identities))
    agent_workbench.seed_configured_agents(
        conn,
        tuple(_slot(f"agent-{index}", key=f"key-{index}", order=index) for index in range(3)),
        NOW,
    )
    due_times = [NOW - timedelta(seconds=1), NOW - timedelta(seconds=2), NOW - timedelta(seconds=2)]
    for local_id, due in zip(local_ids, due_times):
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET sync_pending=0,next_discovery_at=? "
            "WHERE seo_ops_agent_id=?", (due.isoformat(), local_id)
        )
        conn.execute(
            "UPDATE seo_ops_agents SET next_verification_at=? WHERE id=?",
            ((NOW - (due - NOW)).isoformat(), local_id),
        )
    conn.commit()
    assert agent_workbench.list_due_run_agent_ids(conn, NOW) == [
        local_ids[1], local_ids[2], local_ids[0]
    ]
    # Verification due times were intentionally pushed into the future.
    assert agent_workbench.list_due_metadata_agent_ids(conn, NOW) == []
    conn.execute(
        "UPDATE seo_ops_agents SET next_verification_at=? WHERE id IN (?,?)",
        ((NOW - timedelta(seconds=3)).isoformat(), local_ids[2], local_ids[0]),
    )
    conn.commit()
    assert agent_workbench.list_due_metadata_agent_ids(conn, NOW) == [
        local_ids[0], local_ids[2]
    ]
    conn.close()


def test_full_proof_then_old_filtered_only_preserves_finite_range(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "old-filtered.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW,
        client_factory=lambda: ListOnlyCoreAiFake(_full_responses()),
    )
    check = sqlite3.connect(str(tmp_path / "old-filtered.db"))
    check.row_factory = sqlite3.Row
    floor = _state(check)["finite_range_proven_start_at"]
    check.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?",
        ((NOW + timedelta(seconds=30)).isoformat(),),
    )
    check.commit()
    check.close()
    old = _page(status="RUNNING", run_ids=("old-filtered",), total=1)
    old["runs"][0]["started_at"] = "2026-01-01T00:00:00+00:00"
    fake = ListOnlyCoreAiFake(
        _full_responses(unfiltered=_page(total=0), running=old)
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=30),
        client_factory=lambda: fake,
    )
    check = sqlite3.connect(str(tmp_path / "old-filtered.db"))
    check.row_factory = sqlite3.Row
    state = _state(check)
    assert state["finite_range_proven_start_at"] == floor
    assert state["history_event_epoch"] == 1
    assert state["unfiltered_proven_event_epoch"] == 0
    check.close()


def test_expired_metadata_response_is_discarded(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "metadata-fence.db")
    _seed_agent(conn, monkeypatch)
    lease = agent_workbench.claim_due_metadata_sync(
        conn, LOCAL_ID, "metadata-old", NOW
    )
    metadata = agent_workbench.VerifiedAgentMetadata(
        "agent-primary", "Too Late", "late-model", 1, NOW.isoformat()
    )
    result = agent_workbench.MetadataResult(NOW, metadata)
    before = tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    assert agent_workbench.commit_metadata_verification(
        conn, lease, result, NOW + timedelta(seconds=45)
    ) is False
    assert tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone()) == before
    conn.execute(
        "UPDATE seo_ops_agents SET metadata_lease_owner='metadata-new',"
        "metadata_lease_epoch=metadata_lease_epoch+1,metadata_lease_until=?",
        ((NOW + timedelta(seconds=90)).isoformat(),),
    )
    conn.commit()
    before = tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    assert agent_workbench.commit_metadata_verification(conn, lease, result, NOW) is False
    assert tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone()) == before
    conn.close()


def test_two_agent_timeout_isolation(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "two-agent.db")
    ids = [LOCAL_ID, "22222222-2222-4222-8222-222222222222"]
    identities = iter(UUID(value) for value in ids)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(identities))
    agent_workbench.seed_configured_agents(
        conn,
        (
            _slot("agent-blocked", key="blocked", order=1, env_name="AGENT_BLOCKED"),
            _slot("agent-fast", key="fast", order=2, env_name="AGENT_FAST"),
        ),
        NOW,
    )
    ids = [
        conn.execute(
            "SELECT id FROM seo_ops_agents WHERE coreai_agent_id=?", (core_id,)
        ).fetchone()[0]
        for core_id in ("agent-blocked", "agent-fast")
    ]
    conn.close()
    entered = threading.Event()
    release = threading.Event()

    def blocked_page():
        entered.set()
        assert release.wait(2)
        return _page(agent_id="agent-blocked", total=0)

    blocked = ListOnlyCoreAiFake(
        {
            ("agent-blocked", None): [blocked_page],
            ("agent-blocked", "PENDING"): [_page(agent_id="agent-blocked", status="PENDING", total=0)],
            ("agent-blocked", "RUNNING"): [_page(agent_id="agent-blocked", status="RUNNING", total=0)],
            ("agent-blocked", "PAUSED"): [_page(agent_id="agent-blocked", status="PAUSED", total=0)],
        }
    )
    fast = ListOnlyCoreAiFake(
        {
            ("agent-fast", None): [_page(agent_id="agent-fast", total=0)],
            ("agent-fast", "PENDING"): [_page(agent_id="agent-fast", status="PENDING", total=0)],
            ("agent-fast", "RUNNING"): [_page(agent_id="agent-fast", status="RUNNING", total=0)],
            ("agent-fast", "PAUSED"): [_page(agent_id="agent-fast", status="PAUSED", total=0)],
        }
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        slow_future = pool.submit(
            agent_workbench.sync_registered_agent_runs_once,
            ids[0], now=NOW, owner="blocked-owner", client_factory=lambda: blocked,
        )
        assert entered.wait(1), f"blocked worker result={slow_future.result(timeout=1)!r}"
        fast_future = pool.submit(
            agent_workbench.sync_registered_agent_runs_once,
            ids[1], now=NOW, owner="fast-owner", client_factory=lambda: fast,
        )
        assert fast_future.result(timeout=1) is True
        check = sqlite3.connect(str(tmp_path / "two-agent.db"))
        assert check.execute(
            "SELECT current_state_complete FROM seo_ops_agent_sync_state "
            "WHERE seo_ops_agent_id=?", (ids[1],)
        ).fetchone()[0] == 1
        check.close()
        release.set()
        assert slow_future.result(timeout=2) is True


def test_blocked_metadata_never_delays_fast_or_full_proof(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "blocked-metadata.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    entered = threading.Event()
    release = threading.Event()

    def blocked_metadata():
        entered.set()
        assert release.wait(2)
        raise CoreAiError(0, "metadata-secret")

    metadata_fake = ListOnlyCoreAiFake(metadata=[blocked_metadata])
    run_fake = ListOnlyCoreAiFake(
        _full_responses(
            unfiltered=_page(run_ids=("run-live",), total=1),
            running=_page(status="RUNNING", run_ids=("run-live",), total=1),
        )
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        metadata_future = pool.submit(
            agent_workbench.verify_registered_agent_metadata_once,
            LOCAL_ID, now=NOW, client_factory=lambda: metadata_fake,
        )
        assert entered.wait(1)
        run_future = pool.submit(
            agent_workbench.sync_registered_agent_runs_once,
            LOCAL_ID, now=NOW, client_factory=lambda: run_fake,
        )
        assert run_future.result(timeout=1) is True
        check = sqlite3.connect(str(tmp_path / "blocked-metadata.db"))
        check.row_factory = sqlite3.Row
        snapshot = agent_workbench.build_workbench_snapshot(
            check, "30d", NOW, "Asia/Shanghai", 20
        )
        signal = next(item for item in snapshot["signals"] if item["coreai_run_id"] == "run-live")
        assert signal["fresh"] is True
        assert signal["signal_state"] == "active"
        check.close()
        release.set()
        assert metadata_future.result(timeout=2) is True


@pytest.mark.parametrize("agent_count", [12, 17])
def test_supervisor_caps_and_refills_seventeen_agents(
    tmp_path, monkeypatch, agent_count
):
    conn = _connection(tmp_path, monkeypatch, "supervisor.db")
    local_ids = [
        f"00000000-0000-4000-8000-{index:012d}"
        for index in range(1, agent_count + 1)
    ]
    identities = iter(UUID(value) for value in local_ids)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(identities))
    agent_workbench.seed_configured_agents(
        conn,
        tuple(
            _slot(f"agent-{index:02d}", key=f"key-{index:02d}", order=index)
            for index in range(1, agent_count + 1)
        ),
        NOW,
    )
    conn.close()
    monkeypatch.setattr(agent_workbench, "SYNC_TICK_SECONDS", 0.01)
    lock = threading.Lock()
    release_run = threading.Event()
    release_metadata = threading.Event()
    seen_run = []
    seen_metadata = []
    active_run = active_metadata = peak_run = peak_metadata = 0

    def lane_connection():
        value = sqlite3.connect(str(tmp_path / "supervisor.db"), check_same_thread=False)
        value.row_factory = sqlite3.Row
        return value

    def run_worker(local_id, *, stop_event):
        nonlocal active_run, peak_run
        with lock:
            seen_run.append(local_id)
            active_run += 1
            peak_run = max(peak_run, active_run)
        release_run.wait(2)
        value = lane_connection()
        value.execute(
            "UPDATE seo_ops_agent_sync_state SET sync_pending=0,next_discovery_at=? "
            "WHERE seo_ops_agent_id=?",
            ("2099-01-01T00:00:00+00:00", local_id),
        )
        value.commit()
        value.close()
        with lock:
            active_run -= 1
        return True

    def metadata_worker(local_id, *, stop_event):
        nonlocal active_metadata, peak_metadata
        with lock:
            seen_metadata.append(local_id)
            active_metadata += 1
            peak_metadata = max(peak_metadata, active_metadata)
        release_metadata.wait(2)
        value = lane_connection()
        value.execute(
            "UPDATE seo_ops_agents SET next_verification_at=? WHERE id=?",
            ("2099-01-01T00:00:00+00:00", local_id),
        )
        value.commit()
        value.close()
        with lock:
            active_metadata -= 1
        return True

    async def exercise():
        task = asyncio.create_task(
            agent_workbench.agent_workbench_sync_loop(
                connection_factory=lane_connection,
                run_worker=run_worker,
                metadata_worker=metadata_worker,
            )
        )
        for _ in range(200):
            with lock:
                if peak_run == 8 and peak_metadata == 4:
                    break
            await asyncio.sleep(0.01)
        assert peak_run == 8
        assert peak_metadata == 4
        assert seen_run[:8] == local_ids[:8]
        assert seen_metadata[:4] == local_ids[:4]
        release_run.set()
        release_metadata.set()
        for _ in range(400):
            with lock:
                if len(set(seen_run)) == len(local_ids) and len(set(seen_metadata)) == len(local_ids):
                    break
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert set(seen_run) == set(local_ids)
        assert set(seen_metadata) == set(local_ids)
        assert peak_run <= agent_workbench.MAX_CONCURRENT_AGENT_SYNCS
        assert peak_metadata <= agent_workbench.MAX_CONCURRENT_METADATA_SYNCS

    asyncio.run(exercise())


def test_supervisor_cancellation_awaits_both_worker_pools(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "supervisor-cancel.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    monkeypatch.setattr(agent_workbench, "SYNC_TICK_SECONDS", 0.01)
    run_entered = threading.Event()
    metadata_entered = threading.Event()
    run_exited = threading.Event()
    metadata_exited = threading.Event()

    def lane_connection():
        value = sqlite3.connect(str(tmp_path / "supervisor-cancel.db"), check_same_thread=False)
        value.row_factory = sqlite3.Row
        return value

    def blocked(entered, exited):
        def worker(_local_id, *, stop_event):
            entered.set()
            stop_event.wait(2)
            exited.set()
            return False
        return worker

    async def cancel():
        task = asyncio.create_task(
            agent_workbench.agent_workbench_sync_loop(
                connection_factory=lane_connection,
                run_worker=blocked(run_entered, run_exited),
                metadata_worker=blocked(metadata_entered, metadata_exited),
            )
        )
        for _ in range(100):
            if run_entered.is_set() and metadata_entered.is_set():
                break
            await asyncio.sleep(0.01)
        assert run_entered.is_set() and metadata_entered.is_set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert run_exited.is_set() and metadata_exited.is_set()

    asyncio.run(cancel())

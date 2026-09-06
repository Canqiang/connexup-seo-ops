import logging
import sqlite3
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID

import httpx
import pytest

from app import agent_workbench, runs, seo_targets, tasks
from app.config import BootstrapAgentSlot
from app.coreai import CoreAiClient
from app.db import init_db


NOW = datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc)
LOCAL_ID = "11111111-1111-4111-8111-111111111111"


class ListOnlyCoreAiFake:
    def __init__(self, responses):
        self.responses = {key: list(values) for key, values in responses.items()}
        self.calls = []
        self.closed = False

    def list_agent_runs(self, agent_id, status, limit):
        self.calls.append((agent_id, status, limit))
        return self.responses[(agent_id, status)].pop(0)

    def close(self):
        self.closed = True


def _slot(coreai_agent_id="agent-primary"):
    return BootstrapAgentSlot(
        env_name="COREAI_AGENT_ID",
        agent_key="diagnosis-plan",
        display_name="Diagnosis Agent",
        role="Diagnosis",
        sort_order=10,
        coreai_agent_id=coreai_agent_id,
    )


def _connection(tmp_path, monkeypatch, name="triggers.db"):
    database = tmp_path / name
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "trigger-secret")
    init_db()
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _seed_exact_idle(conn, monkeypatch):
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), NOW)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=0,"
        "last_discovery_returned_count=0,coverage_start_at=NULL,"
        "finite_range_proven_start_at=?,pending_observed_count=0,"
        "pending_upstream_total=0,pending_last_observed_at=?,"
        "pending_set_quality='exact',running_observed_count=0,"
        "running_upstream_total=0,running_last_observed_at=?,"
        "running_set_quality='exact',paused_observed_count=0,"
        "paused_upstream_total=0,paused_last_observed_at=?,"
        "paused_set_quality='exact',unresolved_unknown_status_count=0,"
        "current_state_complete=1,current_state_error=NULL,sync_pending=0,"
        "local_event_epoch=2,history_event_epoch=3,"
        "unfiltered_proven_event_epoch=3,next_discovery_at=?,"
        "next_fast_poll_at=NULL WHERE seo_ops_agent_id=?",
        (
            (NOW - timedelta(hours=1)).isoformat(),
            NOW.isoformat(),
            NOW.isoformat(),
            NOW.isoformat(),
            (NOW + timedelta(minutes=5)).isoformat(),
            LOCAL_ID,
        ),
    )
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Trigger Merchant',?)",
        (NOW.isoformat(),),
    ).lastrowid
    conn.commit()
    return merchant_id


def _insert_source_run(conn, merchant_id, run_id, *, status="running"):
    source_id = conn.execute(
        "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
        "VALUES (?,?,?,'manual',?)",
        (merchant_id, run_id, status, NOW.isoformat()),
    ).lastrowid
    conn.commit()
    return source_id


def _list_page(*rows):
    return {"runs": list(rows), "total": len(rows)}


def _listed_run(run_id, status):
    return {
        "id": run_id,
        "agent_id": "agent-primary",
        "status": status,
        "triggered_by": "WORKFLOW",
        "started_at": (NOW - timedelta(seconds=10)).isoformat(),
        "completed_at": NOW.isoformat(),
        "token_usage": {"input": 12, "output": 5},
        "trace_id": "trace-confirmed",
    }


def _discovery_responses(unfiltered, *, running=None):
    return {
        ("agent-primary", None): [unfiltered],
        ("agent-primary", "PENDING"): [_list_page()],
        ("agent-primary", "RUNNING"): [running or _list_page()],
        ("agent-primary", "PAUSED"): [_list_page()],
    }


def _real_coreai(handler):
    return CoreAiClient(
        "https://core.example",
        "transport-secret",
        transport=httpx.MockTransport(handler),
    )


def test_best_effort_started_run_happy_path(tmp_path, monkeypatch):
    conn = _connection(tmp_path, monkeypatch, "happy.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "accepted-run")
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "accepted-run",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / "happy.db")
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='accepted-run'"
    ).fetchone()
    assert row is not None
    assert (
        row["seo_ops_agent_id"],
        row["raw_status"],
        row["source_kind"],
        row["source_local_id"],
        row["merchant_id"],
        row["first_seen_at"],
        row["trigger_type"],
        row["last_synced_at"],
    ) == (
        LOCAL_ID,
        "RUNNING",
        "run",
        source_id,
        merchant_id,
        NOW.isoformat(),
        None,
        None,
    )
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["local_event_epoch"] == 3
    assert state["history_event_epoch"] == 4
    assert state["unfiltered_proven_event_epoch"] == 3
    assert state["finite_range_proven_start_at"] == (
        NOW + timedelta(microseconds=1)
    ).isoformat()
    assert state["running_set_quality"] == "unknown"
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 0
    assert state["next_fast_poll_at"] == NOW.isoformat()
    check.close()


def test_best_effort_started_run_fills_discovery_race_association(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "discovery-race.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "race-accepted")
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,first_seen_at,"
        "last_synced_at,data_warning_codes_json) VALUES (?,?,?,?,?,?,?)",
        (
            "race-accepted",
            LOCAL_ID,
            "RUNNING",
            "WORKFLOW",
            (NOW - timedelta(seconds=1)).isoformat(),
            NOW.isoformat(),
            "[]",
        ),
    )
    conn.commit()
    conn.close()

    agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "race-accepted",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    )
    check = sqlite3.connect(tmp_path / "discovery-race.db")
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='race-accepted'"
    ).fetchone()
    assert (row["source_kind"], row["source_local_id"], row["merchant_id"]) == (
        "run",
        source_id,
        merchant_id,
    )
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["local_event_epoch"] == 3
    assert state["history_event_epoch"] == 4
    assert state["unfiltered_proven_event_epoch"] == 3
    assert state["running_set_quality"] == "unknown"
    check.close()

    agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "race-accepted",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    )
    replay = sqlite3.connect(tmp_path / "discovery-race.db")
    state = replay.execute(
        "SELECT local_event_epoch,history_event_epoch "
        "FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(state) == (3, 4)
    replay.close()


@pytest.mark.parametrize("raw_status", ["PAUSED", "COMPLETED"])
def test_discovery_race_association_requires_post_event_exact_id(
    tmp_path, monkeypatch, raw_status
):
    database_name = f"discovery-race-{raw_status.lower()}.db"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "race-exact-id")
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,first_seen_at,"
        "last_synced_at,terminal_observed_at,data_warning_codes_json) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (
            "race-exact-id",
            LOCAL_ID,
            raw_status,
            "WORKFLOW",
            (NOW - timedelta(seconds=1)).isoformat(),
            NOW.isoformat(),
            NOW.isoformat() if raw_status == "COMPLETED" else None,
            "[]",
        ),
    )
    conn.commit()
    conn.close()

    agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "race-exact-id",
        raw_status,
        "run",
        source_id,
        observed_at=NOW,
    )
    empty_cycle = ListOnlyCoreAiFake(_discovery_responses(_list_page()))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: empty_cycle,
    ) is True

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='race-exact-id'"
    ).fetchone()
    assert (row["source_kind"], row["source_local_id"]) == ("run", source_id)
    assert row["last_synced_at"] is None
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 0
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "all", NOW + timedelta(seconds=1), "UTC", 20
    )
    assert snapshot["current_state_complete"] is False
    assert snapshot["signals"][0]["signal_state"] == (
        "archiving" if raw_status == "COMPLETED" else "uncertain"
    )
    assert snapshot["signals"][0]["fresh"] is False
    check.close()


def test_best_effort_started_run_failure_isolation(tmp_path, monkeypatch, caplog):
    conn = _connection(tmp_path, monkeypatch, "failure-isolation.db")
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Absent Agent',?)",
        (NOW.isoformat(),),
    ).lastrowid
    source_id = _insert_source_run(conn, merchant_id, "orphan-run")
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "absent-agent",
        "orphan-run",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / "failure-isolation.db")
    assert check.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 0
    check.close()

    conn = sqlite3.connect(tmp_path / "failure-isolation.db")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    mismatch_source_id = _insert_source_run(
        conn, merchant_id, "committed-other-run"
    )
    before_state = tuple(
        conn.execute(
            "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
            (LOCAL_ID,),
        ).fetchone()
    )
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "mismatched-run",
        "RUNNING",
        "run",
        mismatch_source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / "failure-isolation.db")
    check.row_factory = sqlite3.Row
    assert check.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 0
    assert tuple(
        check.execute(
            "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
            (LOCAL_ID,),
        ).fetchone()
    ) == before_state
    check.close()

    real_connect = agent_workbench.connect
    sentinel = "Bearer credential-sentinel?token=query-sentinel body-sentinel"

    class SQLiteFailureConnection:
        rolled_back = False
        closed = False

        def execute(self, *_args, **_kwargs):
            raise sqlite3.OperationalError(sentinel)

        def rollback(self):
            self.rolled_back = True

        def close(self):
            self.closed = True

    failed_connection = SQLiteFailureConnection()
    monkeypatch.setattr(agent_workbench, "connect", lambda: failed_connection)
    caplog.set_level(logging.WARNING, logger="app.agent_workbench")
    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "sqlite-failure-run",
        "RUNNING",
        "run",
        987,
        observed_at=NOW,
    ) is None
    assert failed_connection.rolled_back is True
    assert failed_connection.closed is True
    assert "WORKBENCH_RUN_PROJECTION_FAILED" in caplog.text
    assert "Agent Workbench 本地 Run 投影失败" in caplog.text
    assert "agent-primary" in caplog.text
    assert "sqlite-failure-run" in caplog.text
    assert "source_kind=run" in caplog.text
    assert "source_local_id=987" in caplog.text
    for secret in (
        sentinel,
        "credential-sentinel",
        "query-sentinel",
        "body-sentinel",
    ):
        assert secret not in caplog.text
    check = sqlite3.connect(tmp_path / "failure-isolation.db")
    assert "credential-sentinel" not in "\n".join(check.iterdump())
    check.close()

    monkeypatch.setattr(agent_workbench, "connect", real_connect)
    caplog.clear()
    projection_sentinel = "projection-body-secret-sentinel"

    class ProjectionFailureConnection:
        def __init__(self):
            self.connection = real_connect()
            self.rolled_back = False
            self.closed = False

        def execute(self, sql, *args, **kwargs):
            if sql.startswith("INSERT INTO seo_ops_agent_runs"):
                raise RuntimeError(projection_sentinel)
            return self.connection.execute(sql, *args, **kwargs)

        def rollback(self):
            self.rolled_back = True
            self.connection.rollback()

        def close(self):
            self.closed = True
            self.connection.close()

    projection_connection = ProjectionFailureConnection()
    monkeypatch.setattr(
        agent_workbench, "connect", lambda: projection_connection
    )
    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        "committed-other-run",
        "RUNNING",
        "run",
        mismatch_source_id,
        observed_at=NOW,
    ) is None
    assert projection_connection.rolled_back is True
    assert projection_connection.closed is True
    assert "WORKBENCH_RUN_PROJECTION_FAILED" in caplog.text
    assert projection_sentinel not in caplog.text
    check = sqlite3.connect(tmp_path / "failure-isolation.db")
    assert check.execute("SELECT COUNT(*) FROM seo_ops_agent_runs").fetchone()[0] == 0
    assert projection_sentinel not in "\n".join(check.iterdump())
    check.close()


@pytest.mark.parametrize(
    ("raw_status", "suffix"),
    [(None, "missing"), ("", "blank"), (123, "non-string")],
)
def test_statusless_accepted_run_persists_confirmation_marker(
    tmp_path, monkeypatch, caplog, raw_status, suffix
):
    database_name = f"statusless-{suffix}.db"
    run_id = f"statusless-{suffix}-run"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id)
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        raw_status,
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row is not None
    assert (
        row["raw_status"],
        row["trigger_type"],
        row["started_at"],
        row["completed_at"],
        row["terminal_observed_at"],
        row["receipt_expires_at"],
        row["input_tokens"],
        row["output_tokens"],
        row["trace_id"],
        row["error_summary"],
        row["last_poll_attempt_at"],
        row["last_synced_at"],
        row["last_poll_error"],
    ) == (None,) * 13
    assert row["source_kind"] == "run"
    assert row["source_local_id"] == source_id
    assert row["first_seen_at"] == NOW.isoformat()
    assert row["data_warning_codes_json"] == '["LOCAL_TRIGGER_STATUS_MISSING"]'

    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["local_event_epoch"] == 3
    assert state["history_event_epoch"] == 4
    assert state["unfiltered_proven_event_epoch"] == 3
    assert state["unresolved_unknown_status_count"] == 1
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    assert tuple(
        state[f"{prefix}_observed_count"]
        for prefix in ("pending", "running", "paused")
    ) == (0, 0, 0)
    assert state["remote_total_runs"] == 0
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 0
    assert state["next_discovery_at"] == NOW.isoformat()
    assert state["next_fast_poll_at"] is None

    snapshot = agent_workbench.build_workbench_snapshot(
        check, "7d", NOW, "UTC", 20
    )
    assert snapshot["coverage"]["mirrored_run_count"] == 1
    assert snapshot["coverage"]["remote_total_runs"] is None
    assert snapshot["coverage"]["history_complete"] is False
    assert snapshot["coverage"]["range_complete"] is False
    assert snapshot["current_state_incomplete_statuses"] == [
        "PENDING",
        "RUNNING",
        "PAUSED",
        "UNKNOWN",
    ]
    signal = snapshot["signals"][0]
    assert signal["raw_status"] is None
    assert signal["signal_state"] == "uncertain"
    assert signal["fresh"] is False
    assert "LOCAL_TRIGGER_STATUS_MISSING" in {
        warning["code"] for warning in snapshot["sync_warnings"]
    }
    before_row = tuple(row)
    before_state = tuple(state)
    check.close()

    caplog.set_level(logging.WARNING, logger="app.agent_workbench")
    caplog.clear()
    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        raw_status,
        "run",
        source_id,
        observed_at=NOW + timedelta(seconds=1),
    ) is None
    assert "WORKBENCH_RUN_PROJECTION_FAILED" not in caplog.text
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    assert check.execute(
        "SELECT COUNT(*) FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()[0] == 1
    assert tuple(
        check.execute(
            "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
        ).fetchone()
    ) == before_row
    assert tuple(
        check.execute(
            "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
            (LOCAL_ID,),
        ).fetchone()
    ) == before_state
    check.close()


@pytest.mark.parametrize(
    "raw_status", ["PENDING", "RUNNING", "PAUSED", "FUTURE_STATE"]
)
def test_local_nonterminal_invalidates_exact_idle(
    tmp_path, monkeypatch, raw_status
):
    database_name = f"nonterminal-{raw_status.lower()}.db"
    run_id = f"accepted-{raw_status.lower()}"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id)
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        raw_status,
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert (row["raw_status"], row["trigger_type"], row["last_synced_at"]) == (
        raw_status,
        None,
        None,
    )
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert (state["local_event_epoch"], state["history_event_epoch"]) == (3, 4)
    assert state["unfiltered_proven_event_epoch"] == 3
    qualities = {
        prefix: state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    }
    expected_unknown = (
        {raw_status.lower()}
        if raw_status in agent_workbench.KNOWN_NONTERMINAL
        else {"pending", "running", "paused"}
    )
    assert {key for key, value in qualities.items() if value == "unknown"} == (
        expected_unknown
    )
    assert state["unresolved_unknown_status_count"] == int(
        raw_status not in agent_workbench.KNOWN_NONTERMINAL
    )
    assert state["current_state_complete"] == 0
    assert state["sync_pending"] == 0
    if raw_status in {"PENDING", "RUNNING"}:
        assert state["next_fast_poll_at"] == NOW.isoformat()
        assert state["next_discovery_at"] == (
            NOW + timedelta(minutes=5)
        ).isoformat()
    else:
        assert state["next_fast_poll_at"] is None
        assert state["next_discovery_at"] == NOW.isoformat()
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "7d", NOW, "UTC", 20
    )
    assert snapshot["coverage"]["remote_total_runs"] is None
    assert snapshot["coverage"]["range_complete"] is False
    assert snapshot["current_state_complete"] is False
    assert snapshot["signals"][0]["signal_state"] == "uncertain"
    assert snapshot["signals"][0]["fresh"] is False
    check.close()


@pytest.mark.parametrize(
    ("lifecycle", "existing_due", "expected_due"),
    [
        (
            "disabled",
            NOW + timedelta(hours=2),
            NOW + timedelta(minutes=15),
        ),
        (
            "disabled",
            NOW - timedelta(minutes=1),
            NOW - timedelta(minutes=1),
        ),
        (
            "disabled",
            NOW + timedelta(minutes=2),
            NOW + timedelta(minutes=2),
        ),
        (
            "retired",
            NOW + timedelta(hours=48),
            NOW + timedelta(hours=24),
        ),
        (
            "retired",
            NOW + timedelta(hours=1),
            NOW + timedelta(hours=1),
        ),
    ],
)
def test_inactive_lifecycle_running_acceptance_preserves_archival_cadence(
    tmp_path, monkeypatch, lifecycle, existing_due, expected_due
):
    database_name = f"inactive-running-{lifecycle}-{int(existing_due.timestamp())}.db"
    run_id = f"accepted-{lifecycle}-running"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    if lifecycle == "retired":
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=? WHERE id=?",
            (NOW.isoformat(), LOCAL_ID),
        )
    else:
        conn.execute(
            "UPDATE seo_ops_agents SET status=? WHERE id=?", (lifecycle, LOCAL_ID)
        )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?,"
        "next_fast_poll_at=NULL WHERE seo_ops_agent_id=?",
        (existing_due.isoformat() if existing_due else None, LOCAL_ID),
    )
    conn.commit()
    source_id = _insert_source_run(conn, merchant_id, run_id)
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    assert check.execute(
        "SELECT status FROM seo_ops_agents WHERE id=?", (LOCAL_ID,)
    ).fetchone()[0] == lifecycle
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["next_discovery_at"] == expected_due.isoformat()
    assert state["next_fast_poll_at"] is None
    assert state["sync_pending"] == 0
    assert state["running_set_quality"] == "unknown"
    assert state["current_state_complete"] == 0
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "7d", NOW, "UTC", 20
    )
    signal = snapshot["signals"][0]
    assert signal["lifecycle_status"] == lifecycle
    assert signal["signal_state"] == "uncertain"
    assert signal["fresh"] is False
    check.close()


@pytest.mark.parametrize(
    ("lifecycle", "existing_due", "expected_due"),
    [
        (
            "disabled",
            NOW + timedelta(hours=2),
            NOW + timedelta(minutes=15),
        ),
        (
            "disabled",
            NOW - timedelta(minutes=1),
            NOW - timedelta(minutes=1),
        ),
        (
            "retired",
            NOW + timedelta(hours=48),
            NOW + timedelta(hours=24),
        ),
        (
            "retired",
            NOW - timedelta(minutes=1),
            NOW - timedelta(minutes=1),
        ),
    ],
)
def test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence(
    tmp_path, monkeypatch, lifecycle, existing_due, expected_due
):
    database_name = f"inactive-statusless-{lifecycle}-{int(existing_due.timestamp())}.db"
    run_id = f"accepted-{lifecycle}-statusless"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    if lifecycle == "retired":
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=? WHERE id=?",
            (NOW.isoformat(), LOCAL_ID),
        )
    else:
        conn.execute(
            "UPDATE seo_ops_agents SET status=? WHERE id=?", (lifecycle, LOCAL_ID)
        )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?,"
        "next_fast_poll_at=NULL WHERE seo_ops_agent_id=?",
        (existing_due.isoformat(), LOCAL_ID),
    )
    conn.commit()
    source_id = _insert_source_run(conn, merchant_id, run_id)
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary", run_id, None, "run", source_id, observed_at=NOW
    ) is None

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["raw_status"] is None
    assert row["last_synced_at"] is None
    assert row["data_warning_codes_json"] == '["LOCAL_TRIGGER_STATUS_MISSING"]'
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["next_discovery_at"] == expected_due.isoformat()
    assert state["next_fast_poll_at"] is None
    assert state["sync_pending"] == 0
    assert state["unresolved_unknown_status_count"] == 1
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "7d", NOW, "UTC", 20
    )
    assert snapshot["current_state_incomplete_statuses"][-1] == "UNKNOWN"
    signal = snapshot["signals"][0]
    assert signal["lifecycle_status"] == lifecycle
    assert signal["signal_state"] == "uncertain"
    assert signal["fresh"] is False
    check.close()


@pytest.mark.parametrize(
    "raw_status", ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"]
)
def test_local_terminal_status_is_unconfirmed_without_receipt(
    tmp_path, monkeypatch, raw_status
):
    database_name = f"terminal-{raw_status.lower()}.db"
    run_id = f"accepted-{raw_status.lower()}"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id, status="running")
    conn.close()

    assert agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        raw_status,
        "run",
        source_id,
        observed_at=NOW,
    ) is None

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["raw_status"] == raw_status
    assert row["terminal_observed_at"] == NOW.isoformat()
    assert row["receipt_expires_at"] is None
    assert (
        row["trigger_type"],
        row["started_at"],
        row["completed_at"],
        row["input_tokens"],
        row["output_tokens"],
        row["trace_id"],
        row["error_summary"],
        row["last_poll_attempt_at"],
        row["last_synced_at"],
        row["last_poll_error"],
    ) == (None,) * 10
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["unresolved_unknown_status_count"] == 0
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    assert state["next_discovery_at"] == NOW.isoformat()
    assert state["next_fast_poll_at"] is None
    assert state["sync_pending"] == 0
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "7d", NOW, "UTC", 20
    )
    assert snapshot["coverage"]["remote_total_runs"] is None
    assert snapshot["coverage"]["range_complete"] is False
    assert snapshot["metrics_complete_for_range"] is False
    signal = snapshot["signals"][0]
    assert signal["signal_state"] == "archiving"
    assert signal["fresh"] is False
    assert signal["receipt_expires_at"] is None
    assert snapshot["agents"][0]["last_terminal_run"]["archiving"] is True
    assert "LOCAL_RUN_UNCONFIRMED" in snapshot["agents"][0][
        "last_terminal_run"
    ]["warning_codes"]
    check.close()


def test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt(
    tmp_path, monkeypatch
):
    database_name = "terminal-list-confirmation.db"
    run_id = "terminal-confirmed"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id, status="running")
    conn.close()
    agent_workbench.best_effort_record_started_run(
        "agent-primary", run_id, "COMPLETED", "run", source_id, observed_at=NOW
    )

    exact_zero = ListOnlyCoreAiFake(_discovery_responses(_list_page()))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: exact_zero,
    ) is True
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["last_synced_at"] is None
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 0
    assert state["unfiltered_proven_event_epoch"] < state["history_event_epoch"]
    check.close()

    listed = _listed_run(run_id, "COMPLETED")
    confirmed = ListOnlyCoreAiFake(
        _discovery_responses(_list_page(listed))
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=31),
        client_factory=lambda: confirmed,
    ) is True
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["raw_status"] == "COMPLETED"
    assert row["terminal_observed_at"] == NOW.isoformat()
    assert row["receipt_expires_at"] is None
    assert row["last_synced_at"] == (NOW + timedelta(seconds=31)).isoformat()
    assert row["trigger_type"] == "WORKFLOW"
    assert row["started_at"] == (NOW - timedelta(seconds=10)).isoformat()
    assert row["completed_at"] == NOW.isoformat()
    assert (row["input_tokens"], row["output_tokens"]) == (12, 5)
    assert row["trace_id"] == "trace-confirmed"
    assert "LOCAL_RUN_UNCONFIRMED" not in row["data_warning_codes_json"]
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 1
    assert state["unfiltered_proven_event_epoch"] == state["history_event_epoch"]
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "all", NOW + timedelta(seconds=31), "UTC", 20
    )
    assert snapshot["coverage"]["remote_total_runs"] == 1
    assert snapshot["coverage"]["history_complete"] is True
    check.close()


def test_conflicting_list_terminal_confirms_identity_without_hybrid_payload(
    tmp_path, monkeypatch
):
    database_name = "terminal-list-conflict.db"
    run_id = "terminal-conflict"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id, status="running")
    conn.close()
    agent_workbench.best_effort_record_started_run(
        "agent-primary", run_id, "COMPLETED", "run", source_id, observed_at=NOW
    )

    conflicting = ListOnlyCoreAiFake(
        _discovery_responses(_list_page(_listed_run(run_id, "FAILED")))
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: conflicting,
    ) is True

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert (
        row["raw_status"],
        row["trigger_type"],
        row["started_at"],
        row["completed_at"],
        row["terminal_observed_at"],
        row["receipt_expires_at"],
        row["input_tokens"],
        row["output_tokens"],
        row["trace_id"],
        row["error_summary"],
    ) == (
        "COMPLETED",
        None,
        None,
        None,
        NOW.isoformat(),
        None,
        None,
        None,
        None,
        None,
    )
    assert row["last_synced_at"] == (NOW + timedelta(seconds=1)).isoformat()
    assert "TERMINAL_STATUS_CONFLICT" in row["data_warning_codes_json"]
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "all", NOW + timedelta(seconds=1), "UTC", 20
    )
    warning_codes = snapshot["agents"][0]["last_terminal_run"]["warning_codes"]
    assert "TERMINAL_STATUS_CONFLICT" in warning_codes
    assert "LOCAL_RUN_UNCONFIRMED" not in warning_codes
    check.close()


def test_terminal_to_nonterminal_list_observation_is_conflict_without_hybrid(
    tmp_path, monkeypatch
):
    database_name = "terminal-nonterminal-conflict.db"
    run_id = "terminal-nonterminal-conflict"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id, status="running")
    conn.close()
    agent_workbench.best_effort_record_started_run(
        "agent-primary", run_id, "COMPLETED", "run", source_id, observed_at=NOW
    )

    incoming = _listed_run(run_id, "RUNNING")
    conflicting = ListOnlyCoreAiFake(
        _discovery_responses(_list_page(incoming), running=_list_page(incoming))
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: conflicting,
    ) is True

    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert (
        row["raw_status"],
        row["trigger_type"],
        row["started_at"],
        row["completed_at"],
        row["terminal_observed_at"],
        row["receipt_expires_at"],
        row["input_tokens"],
        row["output_tokens"],
        row["trace_id"],
        row["error_summary"],
    ) == (
        "COMPLETED",
        None,
        None,
        None,
        NOW.isoformat(),
        None,
        None,
        None,
        None,
        None,
    )
    assert row["last_synced_at"] == (NOW + timedelta(seconds=1)).isoformat()
    assert "TERMINAL_STATUS_CONFLICT" in row["data_warning_codes_json"]
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 0
    assert state["running_set_quality"] == "unknown"
    assert state["sync_pending"] == 0
    check.close()


@pytest.mark.parametrize(
    ("raw_status", "suffix"), [("RUNNING", "running"), (None, "missing")]
)
def test_best_effort_started_run_fences_older_discovery_result(
    tmp_path, monkeypatch, raw_status, suffix
):
    database_name = f"event-fence-{suffix}.db"
    run_id = f"event-fence-{suffix}"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, run_id, status="running")
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
        "WHERE seo_ops_agent_id=?",
        (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    old_lease = agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "old-discovery", NOW
    )
    old_cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_discovery_responses(_list_page())),
        old_lease,
        NOW,
        200,
    )

    agent_workbench.best_effort_record_started_run(
        "agent-primary",
        run_id,
        raw_status,
        "run",
        source_id,
        observed_at=NOW + timedelta(seconds=1),
    )
    assert agent_workbench.commit_discovery_cycle(
        conn, old_lease, old_cycle, NOW + timedelta(seconds=2)
    ) is True
    row = conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["last_synced_at"] is None
    state = conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 0
    assert state["local_event_epoch"] == 3
    conn.close()

    post_event_zero = ListOnlyCoreAiFake(_discovery_responses(_list_page()))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=3),
        client_factory=lambda: post_event_zero,
    ) is True
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["last_synced_at"] is None
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "all", NOW + timedelta(seconds=3), "UTC", 20
    )
    assert snapshot["current_state_complete"] is False
    assert snapshot["signals"][0]["signal_state"] == "uncertain"
    assert snapshot["signals"][0]["fresh"] is False
    check.close()

    listed = _listed_run(run_id, "RUNNING")
    exact_id = ListOnlyCoreAiFake(
        _discovery_responses(_list_page(listed), running=_list_page(listed))
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=33),
        client_factory=lambda: exact_id,
    ) is True
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["raw_status"] == "RUNNING"
    assert row["last_synced_at"] == (NOW + timedelta(seconds=33)).isoformat()
    assert "LOCAL_TRIGGER_STATUS_MISSING" not in row["data_warning_codes_json"]
    state = check.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert state["current_state_complete"] == 1
    check.close()


def test_runs_start_run_registers_after_commit(tmp_path, monkeypatch):
    database_name = "runs-hook.db"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    merchant = conn.execute(
        "SELECT * FROM merchants WHERE id=?", (merchant_id,)
    ).fetchone()
    monkeypatch.setattr(runs, "_validate_safe_diagnosis_agent", lambda *_args: None)
    monkeypatch.setattr(runs, "build_input", lambda *_args, **_kwargs: "safe input")
    monkeypatch.setattr(
        runs,
        "merchant_lifecycle_token",
        lambda *_args: ("active", 1, "lifecycle-sha"),
    )
    monkeypatch.setattr(runs, "now_iso", lambda: NOW.isoformat())

    class TriggerClient:
        calls = 0

        def trigger(self, agent_id, input_text):
            self.calls += 1
            assert (agent_id, input_text) == ("agent-primary", "safe input")
            return {"run_id": "runs-hook-accepted", "status": "RUNNING"}

    client = TriggerClient()
    handoffs = []
    real_record = agent_workbench.best_effort_record_started_run

    def record_after_commit(*args, **kwargs):
        committed = sqlite3.connect(tmp_path / database_name)
        committed.row_factory = sqlite3.Row
        row = committed.execute(
            "SELECT * FROM runs WHERE id=?", (args[4],)
        ).fetchone()
        assert row["coreai_run_id"] == "runs-hook-accepted"
        assert row["dispatch_state"] == "DISPATCHED"
        committed.close()
        handoffs.append((args, kwargs))
        return real_record(*args, **kwargs)

    monkeypatch.setattr(
        runs, "best_effort_record_started_run", record_after_commit, raising=False
    )
    result = runs.start_run(
        conn, client, "agent-primary", merchant, "manual"
    )
    assert result["coreai_run_id"] == "runs-hook-accepted"
    assert client.calls == 1
    assert len(handoffs) == 1
    assert handoffs[0][0][:5] == (
        "agent-primary",
        "runs-hook-accepted",
        "RUNNING",
        "run",
        result["id"],
    )
    projected = conn.execute(
        "SELECT source_kind,source_local_id FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='runs-hook-accepted'"
    ).fetchone()
    assert tuple(projected) == ("run", result["id"])
    conn.close()


def test_projection_failure_never_retries_external_trigger(
    tmp_path, monkeypatch, caplog
):
    sentinel = "projection-secret-sentinel"
    conn = _connection(tmp_path, monkeypatch, "projection-isolation.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    merchant = conn.execute(
        "SELECT * FROM merchants WHERE id=?", (merchant_id,)
    ).fetchone()
    monkeypatch.setattr(runs, "_validate_safe_diagnosis_agent", lambda *_args: None)
    monkeypatch.setattr(runs, "build_input", lambda *_args, **_kwargs: "safe input")
    monkeypatch.setattr(
        runs,
        "merchant_lifecycle_token",
        lambda *_args: ("active", 1, "lifecycle-sha"),
    )
    monkeypatch.setattr(runs, "now_iso", lambda: NOW.isoformat())

    class TriggerClient:
        calls = 0

        def trigger(self, _agent_id, _input_text):
            self.calls += 1
            return {"run_id": "accepted-once", "status": "RUNNING"}

    client = TriggerClient()

    def broken_projection(*_args, **_kwargs):
        raise RuntimeError(sentinel)

    monkeypatch.setattr(runs, "best_effort_record_started_run", broken_projection)
    with caplog.at_level(logging.WARNING):
        result = runs.start_run(
            conn, client, "agent-primary", merchant, "manual"
        )
    assert result["coreai_run_id"] == "accepted-once"
    assert client.calls == 1
    assert "WORKBENCH_RUN_PROJECTION_FAILED" in caplog.text
    assert sentinel not in caplog.text
    assert conn.execute(
        "SELECT COUNT(*) FROM runs WHERE coreai_run_id='accepted-once'"
    ).fetchone()[0] == 1

    keyword_artifact_id = conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,"
        "source_agent_id,dispatch_state,request_json,created_at) "
        "VALUES (?,'isolation-keyword','KEYWORD_SET','seo_ops.keyword_set.v2',"
        "'running','keyword-skill-workflow','pending',?,?)",
        (
            merchant_id,
            '{"expected_active_artifact_id":null}',
            NOW.isoformat(),
        ),
    ).lastrowid
    conn.commit()
    monkeypatch.setattr(
        seo_targets,
        "build_keyword_request",
        lambda *_args: {"execution_spec": {}, "rules": []},
    )
    monkeypatch.setattr(seo_targets, "now_iso", lambda: NOW.isoformat())

    class KeywordClient:
        trigger_calls = 0

        def get_agent(self, _agent_id):
            return {"skill_ids": ["seed-skill", "ranking-skill"]}

        def get_skill(self, skill_id):
            return {
                "id": skill_id,
                "qualified_name": f"qualified.{skill_id}",
                "version": 1,
                "updated_at": NOW.isoformat(),
            }

        def trigger(self, _agent_id, _input_text):
            self.trigger_calls += 1
            return {"run_id": "keyword-accepted-once", "status": "PENDING"}

    keyword_client = KeywordClient()
    monkeypatch.setattr(
        seo_targets, "best_effort_record_started_run", broken_projection
    )
    with caplog.at_level(logging.WARNING):
        cycle_id = seo_targets._start_keyword_skill_cycle(
            conn,
            merchant,
            keyword_client,
            seo_targets.KeywordSkillWorkflow(
                "agent-primary", "seed-skill", "ranking-skill"
            ),
            keyword_artifact_id,
            "isolation-keyword",
        )
    assert cycle_id == "isolation-keyword"
    assert keyword_client.trigger_calls == 1
    assert conn.execute(
        "SELECT coreai_run_id FROM merchant_seo_artifacts WHERE id=?",
        (keyword_artifact_id,),
    ).fetchone()[0] == "keyword-accepted-once"
    assert sentinel not in caplog.text
    conn.execute(
        "UPDATE merchant_seo_artifacts SET status='ready' WHERE id=?",
        (keyword_artifact_id,),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "payload_json,request_json,created_at,completed_at) "
        "VALUES (?,'isolation-chain','KEYWORD_SET','seo_ops.keyword_set.v2',"
        "'ready','keyword-agent','{}','{}',?,?)",
        (merchant_id, NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "coreai_run_id,request_json,created_at) "
        "VALUES (?,'isolation-chain','AUDIT_REPORT','seo_ops.audit_report.v1',"
        "'running','audit-agent','completed-isolation-audit','{}',?)",
        (merchant_id, NOW.isoformat()),
    )
    conn.commit()
    monkeypatch.setattr(
        seo_targets,
        "parse_audit_report",
        lambda *_args: SimpleNamespace(model_dump=lambda **_kwargs: {"audit": True}),
    )
    monkeypatch.setattr(
        seo_targets, "_build_ranking_request", lambda *_args: {"ranking": True}
    )

    class ChainedClient:
        trigger_calls = 0

        def get_run(self, run_id):
            assert run_id == "completed-isolation-audit"
            return {
                "status": "COMPLETED",
                "completed_at": NOW.isoformat(),
                "output": {"audit": True},
            }

        def trigger(self, _agent_id, _input_text):
            self.trigger_calls += 1
            return {"run_id": "chained-accepted-once", "status": "PENDING"}

    chained_client = ChainedClient()
    with caplog.at_level(logging.WARNING):
        seo_targets.poll_seo_targets_once(
            chained_client,
            seo_targets.SeoAgentIds(
                keyword="keyword-agent",
                audit="audit-agent",
                ranking="agent-primary",
            ),
        )
    assert chained_client.trigger_calls == 1
    chained = conn.execute(
        "SELECT coreai_run_id,status FROM merchant_seo_artifacts "
        "WHERE coreai_run_id='chained-accepted-once'"
    ).fetchone()
    assert tuple(chained) == ("chained-accepted-once", "running")
    assert sentinel not in caplog.text
    conn.close()


def test_keyword_skill_artifact_registers_after_commit(tmp_path, monkeypatch):
    database_name = "keyword-hook.db"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    cycle_id = "keyword-cycle"
    artifact_id = conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,"
        "source_agent_id,dispatch_state,request_json,created_at) "
        "VALUES (?,?,'KEYWORD_SET','seo_ops.keyword_set.v2','running',"
        "'keyword-skill-workflow','pending',?,?)",
        (
            merchant_id,
            cycle_id,
            '{"expected_active_artifact_id":null}',
            NOW.isoformat(),
        ),
    ).lastrowid
    conn.commit()
    merchant = conn.execute(
        "SELECT * FROM merchants WHERE id=?", (merchant_id,)
    ).fetchone()
    monkeypatch.setattr(
        seo_targets,
        "build_keyword_request",
        lambda *_args: {"execution_spec": {}, "rules": []},
    )
    monkeypatch.setattr(seo_targets, "now_iso", lambda: NOW.isoformat())
    workflow = seo_targets.KeywordSkillWorkflow(
        "agent-primary", "seed-skill", "ranking-skill"
    )

    class KeywordClient:
        trigger_calls = 0

        def get_agent(self, _agent_id):
            return {"skill_ids": ["seed-skill", "ranking-skill"]}

        def get_skill(self, skill_id):
            return {
                "id": skill_id,
                "qualified_name": f"qualified.{skill_id}",
                "version": 1,
                "updated_at": NOW.isoformat(),
            }

        def trigger(self, agent_id, _input_text):
            self.trigger_calls += 1
            assert agent_id == "agent-primary"
            return {"run_id": "keyword-hook-accepted", "status": "PENDING"}

    client = KeywordClient()
    handoffs = []
    real_record = agent_workbench.best_effort_record_started_run

    def record_after_commit(*args, **kwargs):
        committed = sqlite3.connect(tmp_path / database_name)
        committed.row_factory = sqlite3.Row
        row = committed.execute(
            "SELECT * FROM merchant_seo_artifacts WHERE id=?", (args[4],)
        ).fetchone()
        assert row["coreai_run_id"] == "keyword-hook-accepted"
        assert row["dispatch_state"] == "dispatched"
        committed.close()
        handoffs.append((args, kwargs))
        return real_record(*args, **kwargs)

    monkeypatch.setattr(
        seo_targets,
        "best_effort_record_started_run",
        record_after_commit,
        raising=False,
    )
    assert seo_targets._start_keyword_skill_cycle(
        conn,
        merchant,
        client,
        workflow,
        artifact_id,
        cycle_id,
    ) == cycle_id
    assert client.trigger_calls == 1
    assert len(handoffs) == 1
    assert handoffs[0][0][:5] == (
        "agent-primary",
        "keyword-hook-accepted",
        "PENDING",
        "merchant_seo_artifact",
        artifact_id,
    )
    projected = conn.execute(
        "SELECT source_kind,source_local_id FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='keyword-hook-accepted'"
    ).fetchone()
    assert tuple(projected) == ("merchant_seo_artifact", artifact_id)
    conn.close()


def test_chained_audit_ranking_artifact_registers_after_commit(
    tmp_path, monkeypatch
):
    database_name = "chained-hook.db"
    conn = _connection(tmp_path, monkeypatch, database_name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    cycle_id = "audit-ranking-cycle"
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,"
        "source_agent_id,payload_json,request_json,created_at,completed_at) "
        "VALUES (?,?,'KEYWORD_SET','seo_ops.keyword_set.v2','ready',"
        "'keyword-agent','{}','{}',?,?)",
        (merchant_id, cycle_id, NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,"
        "source_agent_id,coreai_run_id,request_json,created_at) "
        "VALUES (?,?,'AUDIT_REPORT','seo_ops.audit_report.v1','running',"
        "'audit-agent','completed-audit','{}',?)",
        (merchant_id, cycle_id, NOW.isoformat()),
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(seo_targets, "now_iso", lambda: NOW.isoformat())
    monkeypatch.setattr(
        seo_targets,
        "parse_audit_report",
        lambda *_args: SimpleNamespace(model_dump=lambda **_kwargs: {"audit": True}),
    )
    monkeypatch.setattr(
        seo_targets,
        "_build_ranking_request",
        lambda *_args: {"ranking": True},
    )

    class ChainedClient:
        trigger_calls = 0

        def get_run(self, run_id):
            assert run_id == "completed-audit"
            return {
                "status": "COMPLETED",
                "completed_at": NOW.isoformat(),
                "output": {"audit": True},
            }

        def trigger(self, agent_id, _input_text):
            self.trigger_calls += 1
            assert agent_id == "agent-primary"
            return {"run_id": "ranking-hook-accepted", "status": "PENDING"}

    client = ChainedClient()
    handoffs = []
    real_record = agent_workbench.best_effort_record_started_run

    def record_after_commit(*args, **kwargs):
        committed = sqlite3.connect(tmp_path / database_name)
        committed.row_factory = sqlite3.Row
        row = committed.execute(
            "SELECT * FROM merchant_seo_artifacts WHERE id=?", (args[4],)
        ).fetchone()
        assert row["coreai_run_id"] == "ranking-hook-accepted"
        assert row["status"] == "running"
        committed.close()
        handoffs.append((args, kwargs))
        return real_record(*args, **kwargs)

    monkeypatch.setattr(
        seo_targets,
        "best_effort_record_started_run",
        record_after_commit,
        raising=False,
    )
    seo_targets.poll_seo_targets_once(
        client,
        seo_targets.SeoAgentIds(
            keyword="keyword-agent", audit="audit-agent", ranking="agent-primary"
        ),
    )
    assert client.trigger_calls == 1
    assert len(handoffs) == 1
    assert handoffs[0][0][0:4] == (
        "agent-primary",
        "ranking-hook-accepted",
        "PENDING",
        "merchant_seo_artifact",
    )
    check = sqlite3.connect(tmp_path / database_name)
    check.row_factory = sqlite3.Row
    artifact = check.execute(
        "SELECT * FROM merchant_seo_artifacts "
        "WHERE coreai_run_id='ranking-hook-accepted'"
    ).fetchone()
    assert artifact is not None
    assert handoffs[0][0][4] == artifact["id"]
    projection = check.execute(
        "SELECT source_kind,source_local_id FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='ranking-hook-accepted'"
    ).fetchone()
    assert tuple(projection) == ("merchant_seo_artifact", artifact["id"])
    check.close()


def test_task_execute_llm_call_is_not_projected_as_agent_run(client, monkeypatch):
    from app.main import app

    class LlmOnlyClient:
        def __init__(self):
            self.llm_calls = []

        def llm_call(self, llm_call_id, input_text):
            self.llm_calls.append((llm_call_id, input_text))
            return (
                '{"outcome":"ready","summary":"Prepared",'
                '"artifact_refs":["artifact://prepared"],'
                '"evidence":["verified context"],'
                '"external_write_performed":false}'
            )

    fake = LlmOnlyClient()
    projection_calls = []
    monkeypatch.setattr(
        tasks,
        "best_effort_record_started_run",
        lambda *args, **kwargs: projection_calls.append((args, kwargs)),
        raising=False,
    )
    app.dependency_overrides[tasks.get_execution_coreai] = lambda: (
        fake,
        "preparation-call",
    )
    try:
        merchant = client.post(
            "/api/merchants",
            json={"name": "LLM-only merchant", "primary_location": "New York, NY"},
        ).json()
        created = client.post(
            f"/api/merchants/{merchant['id']}/tasks",
            json={
                "task_type": "PREPARE_ONLY",
                "title": "Prepare a response",
                "rationale": "A response is needed",
                "expected_outcome": "A reviewable response",
                "parameters": {
                    "description": "Draft only; do not publish",
                    "category": "review",
                },
                "scheduled_start": None,
                "replaces_task_id": None,
                "replaces_task_version": None,
            },
        )
        assert created.status_code == 201, created.text
        task = created.json()
        response = client.post(
            f"/api/tasks/{task['id']}/execute",
            json={"expected_version": task["version"]},
        )
        assert response.status_code == 201, response.text
        execution = response.json()
        assert execution["status"] == "SUCCEEDED"
        assert execution["coreai_run_id"] is None
        assert len(fake.llm_calls) == 1
        assert projection_calls == []
    finally:
        app.dependency_overrides.pop(tasks.get_execution_coreai, None)


def test_normalized_trigger_identity_reaches_every_source_and_projection(
    tmp_path, monkeypatch
):
    conn = _connection(tmp_path, monkeypatch, "normalized-identities.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    merchant = conn.execute(
        "SELECT * FROM merchants WHERE id=?", (merchant_id,)
    ).fetchone()
    monkeypatch.setattr(runs, "_validate_safe_diagnosis_agent", lambda *_args: None)
    monkeypatch.setattr(runs, "build_input", lambda *_args, **_kwargs: "safe input")
    monkeypatch.setattr(
        runs,
        "merchant_lifecycle_token",
        lambda *_args: ("active", 1, "lifecycle-sha"),
    )
    monkeypatch.setattr(runs, "now_iso", lambda: NOW.isoformat())

    run_posts = []

    def run_handler(request):
        run_posts.append(request)
        return httpx.Response(
            200, json={"run_id": "  normalized-run  ", "status": " RUNNING "}
        )

    run_client = _real_coreai(run_handler)
    run = runs.start_run(conn, run_client, "agent-primary", merchant, "manual")
    assert len(run_posts) == 1
    assert run["coreai_run_id"] == "normalized-run"
    run_projection = conn.execute(
        "SELECT coreai_run_id,raw_status,source_kind,source_local_id "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='normalized-run'"
    ).fetchone()
    assert tuple(run_projection) == (
        "normalized-run",
        "RUNNING",
        "run",
        run["id"],
    )
    run_client.close()

    keyword_artifact_id = conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "dispatch_state,request_json,created_at) VALUES "
        "(?,'normalized-keyword','KEYWORD_SET','seo_ops.keyword_set.v2','running',"
        "'keyword-skill-workflow','pending',?,?)",
        (merchant_id, '{"expected_active_artifact_id":null}', NOW.isoformat()),
    ).lastrowid
    conn.commit()
    monkeypatch.setattr(
        seo_targets,
        "build_keyword_request",
        lambda *_args: {"execution_spec": {}, "rules": []},
    )
    monkeypatch.setattr(seo_targets, "now_iso", lambda: NOW.isoformat())
    keyword_posts = []

    def keyword_handler(request):
        path = request.url.path
        if path == "/api/agents/agent-primary":
            return httpx.Response(
                200,
                json={
                    "id": "agent-primary",
                    "skill_ids": ["seed-skill", "ranking-skill"],
                },
            )
        if path.startswith("/api/skills/"):
            skill_id = path.rsplit("/", 1)[-1]
            return httpx.Response(
                200,
                json={
                    "id": skill_id,
                    "qualified_name": f"qualified.{skill_id}",
                    "version": 1,
                    "updated_at": NOW.isoformat(),
                },
            )
        keyword_posts.append(request)
        return httpx.Response(
            200,
            json={"run_id": "  normalized-keyword  ", "status": " PENDING "},
        )

    keyword_client = _real_coreai(keyword_handler)
    seo_targets._start_keyword_skill_cycle(
        conn,
        merchant,
        keyword_client,
        seo_targets.KeywordSkillWorkflow(
            "agent-primary", "seed-skill", "ranking-skill"
        ),
        keyword_artifact_id,
        "normalized-keyword",
    )
    assert len(keyword_posts) == 1
    keyword_source = conn.execute(
        "SELECT coreai_run_id FROM merchant_seo_artifacts WHERE id=?",
        (keyword_artifact_id,),
    ).fetchone()
    assert keyword_source[0] == "normalized-keyword"
    keyword_projection = conn.execute(
        "SELECT raw_status,source_kind,source_local_id FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='normalized-keyword'"
    ).fetchone()
    assert tuple(keyword_projection) == (
        "PENDING",
        "merchant_seo_artifact",
        keyword_artifact_id,
    )
    keyword_client.close()

    conn.execute(
        "UPDATE merchant_seo_artifacts SET status='ready' WHERE id=?",
        (keyword_artifact_id,),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "payload_json,request_json,created_at,completed_at) VALUES "
        "(?,'normalized-chain','KEYWORD_SET','seo_ops.keyword_set.v2','ready',"
        "'keyword-agent','{}','{}',?,?)",
        (merchant_id, NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "coreai_run_id,request_json,created_at) VALUES "
        "(?,'normalized-chain','AUDIT_REPORT','seo_ops.audit_report.v1','running',"
        "'audit-agent','normalized-audit-source','{}',?)",
        (merchant_id, NOW.isoformat()),
    )
    conn.commit()
    monkeypatch.setattr(
        seo_targets,
        "parse_audit_report",
        lambda *_args: SimpleNamespace(model_dump=lambda **_kwargs: {"audit": True}),
    )
    monkeypatch.setattr(
        seo_targets, "_build_ranking_request", lambda *_args: {"ranking": True}
    )
    chain_posts = []

    def chain_handler(request):
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "id": "normalized-audit-source",
                    "agent_id": "audit-agent",
                    "status": "COMPLETED",
                    "output": "{}",
                    "completed_at": NOW.isoformat(),
                },
            )
        chain_posts.append(request)
        return httpx.Response(
            200,
            json={"run_id": "  normalized-chain  ", "status": " PENDING "},
        )

    chain_client = _real_coreai(chain_handler)
    seo_targets.poll_seo_targets_once(
        chain_client,
        seo_targets.SeoAgentIds(
            keyword="keyword-agent", audit="audit-agent", ranking="agent-primary"
        ),
    )
    assert len(chain_posts) == 1
    chain_source = conn.execute(
        "SELECT id FROM merchant_seo_artifacts WHERE coreai_run_id='normalized-chain'"
    ).fetchone()
    chain_projection = conn.execute(
        "SELECT raw_status,source_kind,source_local_id FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='normalized-chain'"
    ).fetchone()
    assert tuple(chain_projection) == (
        "PENDING",
        "merchant_seo_artifact",
        chain_source["id"],
    )
    chain_client.close()
    conn.close()

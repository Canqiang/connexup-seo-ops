"""Release acceptance for the durable Agent Workbench truth path.

This file intentionally exercises only public HTTP behavior and the durable
projection helpers already delivered by Tasks 1--10.  It also owns the
acceptance-only live/readback/visual harness tests.  Core AI fakes are list
only: any accidental single-Run detail request is a hard test failure.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import importlib
import json
import multiprocessing
import os
import shutil
import signal
import socket
import sqlite3
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import UUID

import httpx
import pytest

from app import agent_workbench
from app.config import BootstrapAgentSlot
from app.coreai import CoreAiError
from app.db import init_db

import agent_workbench_live_readback as live_readback
import agent_workbench_visual_fixture as visual_fixture


NOW = datetime(2026, 9, 3, 4, 0, 0, tzinfo=timezone.utc)
LOCAL_ID = "11111111-1111-4111-8111-111111111111"
CORE_ID = "agent-acceptance"
TASK7_AVAILABLE = all(
    hasattr(importlib.import_module("app.main"), name)
    for name in (
        "initialize_writable_application",
        "create_lifespan",
        "create_app",
    )
) and hasattr(agent_workbench, "best_effort_record_started_run")
TASK7_REASON = (
    "Task 7 production integration is absent: requires app factory/lifespan "
    "and accepted-Run projection hook"
)


class ListOnlyCoreAiFake:
    def __init__(self, responses=None, metadata=None):
        self.responses = {
            key: list(values) for key, values in (responses or {}).items()
        }
        self.metadata = metadata or {
            "id": CORE_ID,
            "type": "AGENT",
            "status": "PUBLISHED",
            "name": "Acceptance Agent",
            "model": "acceptance-model",
            "timeout_seconds": 900,
        }
        self.calls: list[tuple[str, str | None, int]] = []
        self.get_run_calls = 0
        self.closed = False

    def get_agent(self, agent_id):
        assert agent_id == self.metadata["id"]
        return dict(self.metadata)

    def list_agent_runs(self, agent_id, status, limit):
        self.calls.append((agent_id, status, limit))
        queue = self.responses.setdefault((agent_id, status), [])
        value = queue.pop(0) if queue else {"runs": [], "total": 0}
        if isinstance(value, BaseException):
            raise value
        return value() if callable(value) else value

    def get_run(self, _run_id):
        self.get_run_calls += 1
        raise AssertionError("single-Run detail must never be called")

    def close(self):
        self.closed = True


def _slot(core_id=CORE_ID):
    return BootstrapAgentSlot(
        env_name="COREAI_AGENT_ID",
        agent_key="acceptance",
        display_name="Acceptance Agent",
        role="Prove the complete truth path",
        sort_order=10,
        coreai_agent_id=core_id,
    )


def _open_database(tmp_path, monkeypatch, name="acceptance.db"):
    path = tmp_path / name
    monkeypatch.setenv("SEO_OPS_DB", str(path))
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "acceptance-secret")
    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "Asia/Shanghai")
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "200")
    init_db()
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return path, conn


def _external_sqlite_guard_state(path: Path) -> dict:
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
            )
        ]
        row_counts = {
            table: int(
                connection.execute(
                    f'SELECT COUNT(*) FROM "{table.replace(chr(34), chr(34) * 2)}"'
                ).fetchone()[0]
            )
            for table in tables
        }
    finally:
        connection.close()
    metadata = path.stat()
    return {
        "bytes_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "mtime_ns": metadata.st_mtime_ns,
        "row_counts": row_counts,
        "sidecars": {
            suffix: Path(f"{path}{suffix}").exists()
            for suffix in ("-journal", "-wal", "-shm")
        },
    }


def _sqlite_argument_basename(value: object) -> str:
    raw = str(value)
    if raw.startswith("file:"):
        raw = raw[5:].split("?", 1)[0]
    return Path(raw).name


def _sqlite_rw_path_argument(value: object) -> Path | None:
    raw = str(value)
    if raw == ":memory:":
        return None
    if raw.startswith("file:"):
        path, _, query = raw[5:].partition("?")
        if "mode=ro" in query.split("&"):
            return None
        return Path(path)
    return Path(raw)


def _seed_agent(conn, monkeypatch, now=NOW):
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), now)
    return LOCAL_ID


def _seed_exact_idle(conn, monkeypatch, now=NOW):
    """Seed one registered Agent with a durable exact-idle proof."""

    _seed_agent(conn, monkeypatch, now)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=0,"
        "last_discovery_attempt_at=?,last_discovery_success_at=?,"
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
            now.isoformat(),
            now.isoformat(),
            (now - timedelta(hours=1)).isoformat(),
            now.isoformat(),
            now.isoformat(),
            now.isoformat(),
            (now + timedelta(minutes=5)).isoformat(),
            LOCAL_ID,
        ),
    )
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES (?,?)",
        ("Acceptance Merchant", now.isoformat()),
    ).lastrowid
    conn.commit()
    return merchant_id


def _insert_source_run(conn, merchant_id, run_id, *, status="running", now=NOW):
    source_id = conn.execute(
        "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
        "VALUES (?,?,?,'manual',?)",
        (merchant_id, run_id, status, now.isoformat()),
    ).lastrowid
    conn.commit()
    return source_id


def _sync_state(conn):
    return conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()


def _require_task7():
    assert TASK7_AVAILABLE, TASK7_REASON


def _run(
    run_id,
    status="RUNNING",
    *,
    started_at=None,
    completed_at=None,
    tokens=None,
    triggered_by="WORKFLOW",
    agent_id=CORE_ID,
):
    row = {
        "id": run_id,
        "agent_id": agent_id,
        "status": status,
        "triggered_by": triggered_by,
        "started_at": (started_at or NOW - timedelta(seconds=5)).isoformat(),
    }
    if completed_at is not None:
        row["completed_at"] = completed_at.isoformat()
    if tokens is not None:
        row["token_usage"] = {"input": tokens[0], "output": tokens[1]}
    return row


def _page(rows=(), *, total=None):
    rows = list(rows)
    return {"runs": rows, "total": len(rows) if total is None else total}


def _four_pages(*, all_rows=(), pending=(), running=(), paused=(), total=None):
    return {
        (CORE_ID, None): [_page(all_rows, total=total)],
        (CORE_ID, "PENDING"): [_page(pending)],
        (CORE_ID, "RUNNING"): [_page(running)],
        (CORE_ID, "PAUSED"): [_page(paused)],
    }


def _force_discovery_due(path, at):
    conn = sqlite3.connect(path)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=?,"
        "next_fast_poll_at=NULL WHERE seo_ops_agent_id=?",
        (at.isoformat(), LOCAL_ID),
    )
    conn.commit()
    conn.close()


def _snapshot(path, now):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        return agent_workbench.build_workbench_snapshot(
            conn, "30d", now, "Asia/Shanghai", 200
        )
    finally:
        conn.close()


def test_registration_persists_before_first_proof(tmp_path, monkeypatch):
    _, conn = _open_database(tmp_path, monkeypatch)
    metadata = agent_workbench.VerifiedAgentMetadata(
        CORE_ID,
        "Acceptance Agent",
        "acceptance-model",
        900,
        NOW.isoformat(),
    )
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    body = agent_workbench.RegisterAgentRequest(
        coreai_agent_id=CORE_ID,
        agent_key="acceptance",
        display_name="Acceptance Agent",
        role="Prove the complete truth path",
        sort_order=10,
        suspect_after_seconds=900,
    )

    result = agent_workbench._register_agent(conn, body, metadata, NOW)

    row = conn.execute(
        "SELECT a.status,s.sync_pending,s.current_state_complete,"
        "s.remote_total_runs FROM seo_ops_agents a JOIN "
        "seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id WHERE a.id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert result["agent"]["id"] == LOCAL_ID
    assert tuple(row) == ("active", 1, 0, None)
    conn.close()


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_local_running_acceptance_revokes_exact_idle(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch, "accepted-running.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "accepted-running")
    conn.close()
    _require_task7()

    agent_workbench.best_effort_record_started_run(
        CORE_ID,
        "accepted-running",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW,
    )

    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='accepted-running'"
    ).fetchone()
    assert (
        row["raw_status"],
        row["trigger_type"],
        row["last_synced_at"],
        row["source_kind"],
        row["source_local_id"],
    ) == ("RUNNING", None, None, "run", source_id)
    state = _sync_state(check)
    assert (state["local_event_epoch"], state["history_event_epoch"]) == (3, 4)
    assert state["unfiltered_proven_event_epoch"] == 3
    assert state["running_set_quality"] == "unknown"
    assert state["current_state_complete"] == 0
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "UTC", 20
    )
    assert snapshot["has_active_runs"] is None
    assert snapshot["current_counts"]["running"]["quality"] == "unknown"
    signal = snapshot["signals"][0]
    assert signal["coreai_run_id"] == "accepted-running"
    assert signal["signal_state"] == "uncertain"
    assert signal["fresh"] is False
    check.close()


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_old_zero_cycle_cannot_overwrite_local_run(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch, "old-zero-running.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "accepted-after-response")
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
        "WHERE seo_ops_agent_id=?",
        (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    old_lease = agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "old-zero", NOW
    )
    old_cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_four_pages()), old_lease, NOW, 200
    )
    _require_task7()

    agent_workbench.best_effort_record_started_run(
        CORE_ID,
        "accepted-after-response",
        "RUNNING",
        "run",
        source_id,
        observed_at=NOW + timedelta(seconds=1),
    )
    assert agent_workbench.commit_discovery_cycle(
        conn, old_lease, old_cycle, NOW + timedelta(seconds=2)
    )
    row = conn.execute(
        "SELECT raw_status,last_synced_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='accepted-after-response'"
    ).fetchone()
    assert tuple(row) == ("RUNNING", None)
    state = _sync_state(conn)
    assert state["local_event_epoch"] == 3
    assert state["current_state_complete"] == 0
    assert state["running_set_quality"] == "unknown"
    assert state["unfiltered_proven_event_epoch"] < state["history_event_epoch"]
    conn.close()
    snapshot = _snapshot(path, NOW + timedelta(seconds=2))
    assert snapshot["has_active_runs"] is None
    assert snapshot["signals"][0]["fresh"] is False


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_old_zero_cycle_cannot_overwrite_statusless_acceptance(
    tmp_path, monkeypatch
):
    path, conn = _open_database(tmp_path, monkeypatch, "old-zero-statusless.db")
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(conn, merchant_id, "accepted-statusless")
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
        "WHERE seo_ops_agent_id=?",
        (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    old_lease = agent_workbench.claim_due_run_sync(
        conn, LOCAL_ID, "old-zero", NOW
    )
    old_cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_four_pages()), old_lease, NOW, 200
    )
    _require_task7()

    agent_workbench.best_effort_record_started_run(
        CORE_ID,
        "accepted-statusless",
        None,
        "run",
        source_id,
        observed_at=NOW + timedelta(seconds=1),
    )
    assert agent_workbench.commit_discovery_cycle(
        conn, old_lease, old_cycle, NOW + timedelta(seconds=2)
    )
    row = conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='accepted-statusless'"
    ).fetchone()
    assert row["raw_status"] is None
    assert row["last_synced_at"] is None
    assert row["source_kind"] == "run"
    assert row["source_local_id"] == source_id
    state = _sync_state(conn)
    assert state["unresolved_unknown_status_count"] == 1
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    conn.close()

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=3),
        client_factory=lambda: ListOnlyCoreAiFake(_four_pages()),
    )
    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    assert check.execute(
        "SELECT last_synced_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='accepted-statusless'"
    ).fetchone()[0] is None
    assert _sync_state(check)["current_state_complete"] == 0
    check.close()

    listed = _run("accepted-statusless", "RUNNING")
    _force_discovery_due(path, NOW + timedelta(seconds=33))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=33),
        client_factory=lambda: ListOnlyCoreAiFake(
            _four_pages(all_rows=(listed,), running=(listed,))
        ),
    )
    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT raw_status,last_synced_at,data_warning_codes_json "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='accepted-statusless'"
    ).fetchone()
    assert row["raw_status"] == "RUNNING"
    assert row["last_synced_at"] == (NOW + timedelta(seconds=33)).isoformat()
    assert "LOCAL_TRIGGER_STATUS_MISSING" not in json.loads(
        row["data_warning_codes_json"]
    )
    assert _sync_state(check)["current_state_complete"] == 1
    check.close()


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
@pytest.mark.parametrize("terminal_status", ["COMPLETED", "SKIPPED"])
def test_immediate_terminal_trigger_requires_list_confirmation(
    tmp_path, monkeypatch, terminal_status
):
    name = f"immediate-{terminal_status.lower()}.db"
    path, conn = _open_database(tmp_path, monkeypatch, name)
    merchant_id = _seed_exact_idle(conn, monkeypatch)
    source_id = _insert_source_run(
        conn, merchant_id, f"accepted-{terminal_status.lower()}", status="running"
    )
    conn.close()
    run_id = f"accepted-{terminal_status.lower()}"
    _require_task7()

    agent_workbench.best_effort_record_started_run(
        CORE_ID,
        run_id,
        terminal_status,
        "run",
        source_id,
        observed_at=NOW,
    )
    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["terminal_observed_at"] == NOW.isoformat()
    assert row["receipt_expires_at"] is None
    assert row["last_synced_at"] is None
    state = _sync_state(check)
    assert tuple(
        state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "UTC", 20
    )
    assert snapshot["coverage"]["remote_total_runs"] is None
    assert snapshot["current_state_complete"] is False
    signal = snapshot["signals"][0]
    assert signal["signal_state"] == "archiving"
    assert signal["fresh"] is False
    assert signal["fresh_until"] is None
    check.close()

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=1),
        client_factory=lambda: ListOnlyCoreAiFake(_four_pages()),
    )
    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    assert tuple(
        check.execute(
            "SELECT terminal_observed_at,receipt_expires_at,last_synced_at "
            "FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
        ).fetchone()
    ) == (NOW.isoformat(), None, None)
    assert _sync_state(check)["current_state_complete"] == 0
    check.close()

    listed = _run(
        run_id,
        terminal_status,
        completed_at=NOW,
        tokens=(0, 0),
    )
    _force_discovery_due(path, NOW + timedelta(seconds=31))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW + timedelta(seconds=31),
        client_factory=lambda: ListOnlyCoreAiFake(_four_pages(all_rows=(listed,))),
    )
    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?", (run_id,)
    ).fetchone()
    assert row["raw_status"] == terminal_status
    assert row["terminal_observed_at"] == NOW.isoformat()
    assert row["receipt_expires_at"] is None
    assert row["last_synced_at"] == (NOW + timedelta(seconds=31)).isoformat()
    assert (row["input_tokens"], row["output_tokens"]) == (0, 0)
    assert _sync_state(check)["current_state_complete"] == 1
    check.close()


def test_old_disabled_cycle_cannot_satisfy_reenable(tmp_path, monkeypatch):
    _, conn = _open_database(tmp_path, monkeypatch, "reenable-fence.db")
    _seed_agent(conn, monkeypatch)
    conn.execute(
        "UPDATE seo_ops_agents SET status='disabled' WHERE id=?", (LOCAL_ID,)
    )
    conn.commit()
    lease = agent_workbench.claim_due_run_sync(conn, LOCAL_ID, "archival", NOW)
    cycle = agent_workbench.execute_run_request_plan(
        ListOnlyCoreAiFake(_four_pages()), lease, NOW, 200
    )
    conn.execute(
        "UPDATE seo_ops_agents SET status='active' WHERE id=?", (LOCAL_ID,)
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=1,sync_pending=1,"
        "next_discovery_at=? WHERE seo_ops_agent_id=?",
        (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()

    assert agent_workbench.commit_discovery_cycle(conn, lease, cycle, NOW)
    state = _sync_state(conn)
    assert state["local_event_epoch"] == 1
    assert state["sync_pending"] == 1
    assert state["current_state_complete"] == 0
    assert state["next_discovery_at"] == NOW.isoformat()
    conn.close()


def test_list_confirmation_enables_running_signal(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch)
    _seed_agent(conn, monkeypatch)
    conn.close()
    running = _run("run-live")
    fake = ListOnlyCoreAiFake(
        _four_pages(all_rows=(running,), running=(running,))
    )

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )

    snapshot = _snapshot(path, NOW + timedelta(seconds=1))
    signal = next(row for row in snapshot["signals"] if row["coreai_run_id"] == "run-live")
    assert signal["raw_status"] == "RUNNING"
    assert signal["trigger_type"] == "WORKFLOW"
    assert signal["fresh"] is True
    assert signal["signal_state"] == "active"
    assert snapshot["current_counts"]["running"] == {
        "value": 1,
        "quality": "exact",
        "last_observed_value": 1,
        "last_observed_at": NOW.isoformat(),
    }
    assert snapshot["refresh_after_ms"] == 5000
    assert fake.get_run_calls == 0
    assert fake.calls == [
        (CORE_ID, None, 200),
        (CORE_ID, "PENDING", 200),
        (CORE_ID, "RUNNING", 200),
        (CORE_ID, "PAUSED", 200),
    ]


@pytest.mark.parametrize("tokens", [(7, 11), (0, 0)])
def test_terminal_projection_persists_tokens_and_receipt(
    tmp_path, monkeypatch, tokens
):
    path, conn = _open_database(tmp_path, monkeypatch)
    _seed_agent(conn, monkeypatch)
    conn.close()
    running = _run("run-terminal")
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW,
        client_factory=lambda: ListOnlyCoreAiFake(
            _four_pages(all_rows=(running,), running=(running,))
        ),
    )
    terminal_at = NOW + timedelta(seconds=5)
    _force_discovery_due(path, terminal_at)
    completed = _run(
        "run-terminal",
        "COMPLETED",
        completed_at=terminal_at,
        tokens=tokens,
    )
    fake = ListOnlyCoreAiFake(_four_pages(all_rows=(completed,)))

    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=terminal_at, client_factory=lambda: fake
    )

    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    row = check.execute(
        "SELECT raw_status,input_tokens,output_tokens,terminal_observed_at,"
        "receipt_expires_at,last_synced_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-terminal'"
    ).fetchone()
    assert tuple(row) == (
        "COMPLETED",
        tokens[0],
        tokens[1],
        terminal_at.isoformat(),
        (terminal_at + timedelta(seconds=10)).isoformat(),
        terminal_at.isoformat(),
    )
    check.close()
    snapshot = _snapshot(path, terminal_at + timedelta(seconds=1))
    receipt = next(row for row in snapshot["signals"] if row["coreai_run_id"] == "run-terminal")
    assert receipt["signal_state"] == "completed"
    assert receipt["total_tokens"] == sum(tokens)
    assert fake.get_run_calls == 0


@pytest.mark.parametrize(
    ("source_status", "expected_state", "expected_archiving"),
    [
        ("running", "archiving", True),
        ("succeeded", "completed", False),
    ],
)
def test_local_archiving_settles_to_static_receipt(
    tmp_path,
    monkeypatch,
    source_status,
    expected_state,
    expected_archiving,
):
    _, conn = _open_database(
        tmp_path, monkeypatch, f"local-{source_status}.db"
    )
    _seed_agent(conn, monkeypatch)
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES (?,?)",
        ("Local Source Merchant", NOW.isoformat()),
    ).lastrowid
    source_id = _insert_source_run(
        conn,
        merchant_id,
        f"local-{source_status}",
        status=source_status,
    )
    parsed = agent_workbench.parse_agent_run_page(
        CORE_ID,
        _page(
            (
                _run(
                    f"local-{source_status}",
                    "COMPLETED",
                    completed_at=NOW,
                    tokens=(7, 11),
                ),
            )
        ),
        NOW,
    ).runs[0]
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        parsed,
        NOW,
        agent_workbench.LocalRunBinding("run", source_id),
    )

    snapshot = agent_workbench.build_workbench_snapshot(
        conn, "30d", NOW + timedelta(seconds=1), "UTC", 20
    )
    signal = next(
        item
        for item in snapshot["signals"]
        if item["coreai_run_id"] == f"local-{source_status}"
    )
    assert signal["signal_state"] == expected_state
    assert signal["association"]["kind"] == "run"
    assert signal["association"]["source_local_id"] == source_id
    assert signal["total_tokens"] == 18
    assert signal["receipt_expires_at"] == (
        NOW + timedelta(seconds=10)
    ).isoformat()
    terminal = snapshot["agents"][0]["last_terminal_run"]
    assert terminal["archiving"] is expected_archiving
    conn.close()


def test_repeat_discovery_never_moves_receipt_expiry(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch)
    _seed_agent(conn, monkeypatch)
    parsed = agent_workbench.parse_agent_run_page(
        CORE_ID,
        _page((_run("repeat", "COMPLETED", completed_at=NOW, tokens=(7, 11)),)),
        NOW,
    ).runs[0]
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, parsed, NOW)
    before = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs"
    ).fetchone()
    agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, parsed, NOW + timedelta(seconds=3)
    )
    after = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs"
    ).fetchone()
    assert tuple(after) == tuple(before) == (
        NOW.isoformat(),
        (NOW + timedelta(seconds=10)).isoformat(),
    )
    conn.close()


def test_external_run_discovery_bound_and_unassociated_copy(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch)
    _seed_agent(conn, monkeypatch)
    conn.close()
    external = _run("external-run")
    fake = ListOnlyCoreAiFake(
        _four_pages(all_rows=(external,), running=(external,))
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    snapshot = _snapshot(path, NOW + timedelta(seconds=1))
    signal = next(row for row in snapshot["signals"] if row["coreai_run_id"] == "external-run")
    assert signal["association"] is None
    assert signal["last_synced_at"] == NOW.isoformat()
    assert agent_workbench.ACTIVE_DISCOVERY_SECONDS == 30
    assert agent_workbench.ACTIVE_DISCOVERY_SECONDS * 2 == 60
    assert fake.get_run_calls == 0


def test_old_terminal_backfill_has_no_receipt(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch)
    _seed_agent(conn, monkeypatch)
    conn.close()
    old = _run(
        "old-terminal",
        "COMPLETED",
        completed_at=NOW - timedelta(seconds=11),
        tokens=(3, 5),
    )
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW,
        client_factory=lambda: ListOnlyCoreAiFake(_four_pages(all_rows=(old,))),
    )
    check = sqlite3.connect(path)
    row = check.execute(
        "SELECT terminal_observed_at,receipt_expires_at,input_tokens,output_tokens "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='old-terminal'"
    ).fetchone()
    assert tuple(row) == (NOW.isoformat(), None, 3, 5)
    check.close()
    assert all(row["coreai_run_id"] != "old-terminal" for row in _snapshot(path, NOW)["signals"])


def test_mixed_proof_remains_honest(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch, "mixed-proof.db")
    _seed_agent(conn, monkeypatch)
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES (?,?)",
        ("Mixed Proof Merchant", NOW.isoformat()),
    ).lastrowid
    conn.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,"
        "raw_status,trigger_type,started_at,first_seen_at,last_synced_at,"
        "data_warning_codes_json) VALUES (?,?,?,'WORKFLOW',?,?,?,?)",
        (
            "outside-unknown",
            LOCAL_ID,
            "AWAITING_REVIEW",
            (NOW - timedelta(days=31)).isoformat(),
            (NOW - timedelta(days=31)).isoformat(),
            (NOW - timedelta(minutes=1)).isoformat(),
            '["UNKNOWN_STATUS"]',
        ),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=1,"
        "history_event_epoch=1,unresolved_unknown_status_count=1,"
        "next_discovery_at=? WHERE seo_ops_agent_id=?",
        (NOW.isoformat(), LOCAL_ID),
    )
    conn.commit()
    conn.close()

    recent = [
        _run(
            f"recent-{index:03d}",
            "COMPLETED",
            started_at=NOW - timedelta(minutes=index + 1),
            completed_at=NOW - timedelta(minutes=index),
            tokens=(index % 3, index % 5),
        )
        for index in range(199)
    ]
    recent.append(
        _run(
            "inside-unknown",
            "AWAITING_REVIEW",
            started_at=NOW - timedelta(minutes=2),
        )
    )
    old_running = _run(
        "old-running",
        "RUNNING",
        started_at=NOW - timedelta(days=15),
    )
    responses = {
        (CORE_ID, None): [_page(recent, total=201)],
        (CORE_ID, "PENDING"): [CoreAiError(0, "never serialize this secret")],
        (CORE_ID, "RUNNING"): [_page((old_running,), total=2)],
        (CORE_ID, "PAUSED"): [_page(())],
    }
    fake = ListOnlyCoreAiFake(responses)
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )

    check = sqlite3.connect(path)
    check.row_factory = sqlite3.Row
    state = _sync_state(check)
    assert state["running_observed_count"] == 1
    assert state["running_upstream_total"] == 2
    assert state["running_set_quality"] == "lower_bound"
    assert state["pending_last_observed_at"] is None
    assert state["pending_set_quality"] == "unknown"
    assert state["paused_observed_count"] == 0
    assert state["paused_set_quality"] == "exact"
    assert state["current_state_complete"] == 0
    snapshot = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "UTC", 20
    )
    assert snapshot["has_active_runs"] is None
    assert snapshot["coverage"]["history_complete"] is False
    assert snapshot["metrics_complete_for_range"] is False
    # The durable status segment retains the lower bound; the aggregate
    # deliberately degrades every active count while sync_pending is true.
    assert snapshot["current_counts"]["running"]["quality"] == "unknown"
    assert snapshot["agents"][0]["current_counts"]["running"][
        "last_observed_value"
    ] == 1
    assert snapshot["current_counts"]["queued"]["quality"] == "unknown"
    static_ids = {
        row["coreai_run_id"]
        for row in snapshot["signals"]
        if row["signal_state"] == "uncertain" and row["fresh"] is False
    }
    assert {"inside-unknown", "outside-unknown"} <= static_ids
    assert fake.get_run_calls == 0

    # A source-associated NULL status blocks all known buckets without being
    # animated, even though the earlier range proof remains factual.
    source_id = _insert_source_run(check, merchant_id, "local-null")
    check.execute(
        "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,"
        "raw_status,source_kind,source_local_id,merchant_id,first_seen_at,"
        "data_warning_codes_json) VALUES (?, ?, NULL, 'run', ?, ?, ?, ?)",
        (
            "local-null",
            LOCAL_ID,
            source_id,
            merchant_id,
            (NOW - timedelta(minutes=1)).isoformat(),
            '["LOCAL_TRIGGER_STATUS_MISSING"]',
        ),
    )
    check.execute(
        "UPDATE seo_ops_agent_sync_state SET local_event_epoch=local_event_epoch+1,"
        "history_event_epoch=history_event_epoch+1,"
        "unresolved_unknown_status_count=unresolved_unknown_status_count+1,"
        "pending_set_quality='unknown',running_set_quality='unknown',"
        "paused_set_quality='unknown',current_state_complete=0 "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    )
    check.commit()
    with_null = agent_workbench.build_workbench_snapshot(
        check, "30d", NOW, "UTC", 20
    )
    assert with_null["has_active_runs"] is None
    assert tuple(
        with_null["current_counts"][key]["quality"]
        for key in ("queued", "running", "waiting")
    ) == ("unknown", "unknown", "unknown")
    null_signal = next(
        row for row in with_null["signals"] if row["coreai_run_id"] == "local-null"
    )
    assert null_signal["raw_status"] is None
    assert null_signal["signal_state"] == "uncertain"
    assert null_signal["fresh"] is False
    check.close()

    # A same-cycle disagreement is never reconciled by selecting one status.
    conflict_path, conflict = _open_database(
        tmp_path, monkeypatch, "mixed-conflict.db"
    )
    _seed_agent(conflict, monkeypatch)
    conflict.close()
    unfiltered = _run("same-cycle-conflict", "PENDING")
    running = _run("same-cycle-conflict", "RUNNING")
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID,
        now=NOW,
        client_factory=lambda: ListOnlyCoreAiFake(
            _four_pages(
                all_rows=(unfiltered,), pending=(unfiltered,), running=(running,)
            )
        ),
    )
    conflict = sqlite3.connect(conflict_path)
    conflict.row_factory = sqlite3.Row
    conflict_state = _sync_state(conflict)
    assert conflict_state["current_state_complete"] == 0
    assert conflict_state["current_state_error"].startswith(
        "SAME_CYCLE_STATUS_CONFLICT"
    )
    assert tuple(
        conflict_state[f"{prefix}_set_quality"]
        for prefix in ("pending", "running", "paused")
    ) == ("unknown", "unknown", "unknown")
    assert agent_workbench.build_workbench_snapshot(
        conflict, "30d", NOW, "UTC", 20
    )["has_active_runs"] is None
    conflict.close()


def test_live_app_helper_is_red_before_task7_integration():
    module = importlib.import_module("agent_workbench_live_app")
    if not TASK7_AVAILABLE:
        with pytest.raises(module.Task7RequiredError):
            module.build_live_app()
    else:
        assert module.build_live_app().title == "SEO Ops API"


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_fresh_app_instance_reads_durable_projection(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    path, conn = _open_database(tmp_path, monkeypatch, "fresh-instance.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    terminal = _run(
        "durable-terminal",
        "COMPLETED",
        completed_at=NOW,
        tokens=(7, 11),
    )
    fake = ListOnlyCoreAiFake(_four_pages(all_rows=(terminal,)))
    assert agent_workbench.sync_registered_agent_runs_once(
        LOCAL_ID, now=NOW, client_factory=lambda: fake
    )
    assert fake.get_run_calls == 0
    before = sqlite3.connect(path)
    before.row_factory = sqlite3.Row
    stable_before = {
        table: [dict(row) for row in before.execute(f"SELECT * FROM {table}")]
        for table in (
            "seo_ops_agents",
            "seo_ops_agent_runs",
            "seo_ops_agent_sync_state",
        )
    }
    history_before = agent_workbench.list_projected_agent_runs(
        before, LOCAL_ID, "30d", 20, None, NOW, "Asia/Shanghai"
    )
    before.close()

    for key in ("COREAI_BASE_URL", "COREAI_API_KEY"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SEO_OPS_AUTH_USERNAME", "acceptance-operator")
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", "acceptance-password")
    monkeypatch.setenv(
        "SEO_OPS_AUTH_SECRET", "acceptance-secret-with-at-least-32-characters"
    )
    module = importlib.import_module("agent_workbench_live_app")
    application = module.build_live_app(
        startup_callable=lambda: None,
        scheduler_coro=module.parked_scheduler_loop,
        fbr_scheduler_coro=module.parked_fbr_scheduler_loop,
        workbench_coro=module.parked_restart_workbench_loop,
    )
    with TestClient(application) as client:
        assert client.get("/api/agent-workbench").status_code == 401
        login = client.post(
            "/api/auth/login",
            json={
                "username": "acceptance-operator",
                "password": "acceptance-password",
            },
        )
        assert login.status_code == 200
        aggregate_response = client.get(
            "/api/agent-workbench", params={"range": "30d"}
        )
        assert aggregate_response.status_code == 200
        aggregate = aggregate_response.json()
        history_response = client.get(
            f"/api/agent-workbench/agents/{LOCAL_ID}/runs",
            params={"range": "30d", "limit": 20},
        )
        assert history_response.status_code == 200
        history_after = history_response.json()

    after = sqlite3.connect(path)
    after.row_factory = sqlite3.Row
    stable_after = {
        table: [dict(row) for row in after.execute(f"SELECT * FROM {table}")]
        for table in stable_before
    }
    snapshot_at = datetime.fromisoformat(aggregate["snapshot_at"])
    rebuilt = agent_workbench.build_workbench_snapshot(
        after, "30d", snapshot_at, "Asia/Shanghai", 200
    )
    after.close()
    assert stable_after == stable_before
    durable_history_fields = (
        "coreai_run_id",
        "raw_status",
        "trigger_type",
        "started_at",
        "effective_started_at",
        "completed_at",
        "terminal_observed_at",
        "receipt_expires_at",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "token_state",
        "last_synced_at",
        "association",
        "error_summary",
    )
    def durable_history(body):
        return [
            {key: row[key] for key in durable_history_fields}
            for row in body["items"]
        ]
    assert durable_history(history_after) == durable_history(history_before)
    assert aggregate == rebuilt
    assert aggregate["agents"][0]["last_terminal_run"]["coreai_run_id"] == (
        "durable-terminal"
    )
    assert aggregate["agents"][0]["last_terminal_run"]["total_tokens"] == 18


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench(
    tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient
    from app import main
    from app.coreai import CoreAiClient

    _require_task7()
    _, conn = _open_database(tmp_path, monkeypatch, "live-lifespan.db")
    conn.close()
    monkeypatch.setenv("SEO_OPS_AUTH_USERNAME", "acceptance-operator")
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", "acceptance-password")
    monkeypatch.setenv(
        "SEO_OPS_AUTH_SECRET", "acceptance-secret-with-at-least-32-characters"
    )
    module = importlib.import_module("agent_workbench_live_app")
    starts = {name: threading.Event() for name in ("scheduler", "fbr", "workbench")}
    finalized = []
    startup_calls = []
    production_scheduler_calls = []
    trigger_calls = []

    async def forbidden_scheduler():
        production_scheduler_calls.append("called")
        raise AssertionError("production scheduler must be parked")

    monkeypatch.setattr(main, "scheduler_loop", forbidden_scheduler)
    monkeypatch.setattr(main, "fbr_scheduler_loop", forbidden_scheduler)

    def forbidden_trigger(self, *_args, **_kwargs):
        trigger_calls.append(type(self).__name__)
        raise AssertionError("live gate must never trigger a Core AI run")

    monkeypatch.setattr(CoreAiClient, "trigger", forbidden_trigger)

    def parked(name, *, raises=False):
        async def run():
            starts[name].set()
            try:
                await __import__("asyncio").Event().wait()
            finally:
                finalized.append(name)
                if raises:
                    raise RuntimeError("fixed parked finalizer failure")

        return run

    application = module.build_live_app(
        startup_callable=lambda: startup_calls.append("startup"),
        scheduler_coro=parked("scheduler"),
        fbr_scheduler_coro=parked("fbr", raises=True),
        workbench_coro=parked("workbench"),
    )

    def route_shape(value):
        def dependency_shape(dependant):
            return (
                dependant.call,
                tuple(dependency_shape(child) for child in dependant.dependencies),
            )

        return [
            (
                route.path,
                tuple(sorted(route.methods or ())),
                route.endpoint,
                tuple(
                    dependency_shape(dependency)
                    for dependency in route.dependant.dependencies
                ),
            )
            for route in value.routes
            if hasattr(route, "dependant")
        ]

    assert route_shape(application) == route_shape(main.app)
    with TestClient(application) as client:
        assert all(event.wait(timeout=2) for event in starts.values())
        assert startup_calls == ["startup"]
        assert production_scheduler_calls == []
        assert trigger_calls == []
        assert client.get("/api/agent-workbench").status_code == 401
        assert client.post(
            "/api/auth/login",
            json={
                "username": "acceptance-operator",
                "password": "acceptance-password",
            },
        ).status_code == 200
        assert client.get("/api/agent-workbench").status_code == 200
    assert set(finalized) == {"scheduler", "fbr", "workbench"}


def test_restart_read_connection_enforces_query_only_when_uri_mode_is_bypassed(
    tmp_path,
):
    module = importlib.import_module("agent_workbench_live_app")
    database = tmp_path / "guard.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE guarded(value TEXT)")
    connection.commit()
    connection.close()

    guarded = module.open_restart_read_connection(
        database, connection_factory=lambda _uri, **_kwargs: sqlite3.connect(database)
    )
    try:
        assert guarded.execute("PRAGMA query_only").fetchone()[0] == 1
        with pytest.raises(sqlite3.DatabaseError):
            guarded.execute("INSERT INTO guarded VALUES ('forbidden')")
    finally:
        guarded.close()


def test_restart_read_connection_installs_write_denial_authorizer(tmp_path):
    module = importlib.import_module("agent_workbench_live_app")
    database = tmp_path / "authorizer.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE guarded(value TEXT)")
    connection.commit()
    connection.close()
    guarded = module.open_restart_read_connection(database)
    try:
        assert guarded.execute("SELECT COUNT(*) FROM guarded").fetchone()[0] == 0
        for sql in (
            "INSERT INTO guarded VALUES ('x')",
            "UPDATE guarded SET value='y'",
            "DELETE FROM guarded",
            "CREATE TABLE denied(value TEXT)",
            "ATTACH DATABASE ':memory:' AS denied",
            "PRAGMA wal_checkpoint",
            "PRAGMA user_version",
            "PRAGMA query_only=OFF",
        ):
            with pytest.raises(sqlite3.DatabaseError):
                guarded.execute(sql)
    finally:
        guarded.close()


def test_restart_guard_rejects_existing_links_and_non_regular_files(
    tmp_path, monkeypatch
):
    module = importlib.import_module("agent_workbench_live_app")
    guarded = tmp_path / "restart-guard"
    guarded.mkdir()
    database = guarded / "restart.db"
    marker = guarded / module.RESTART_MARKER_NAME
    marker.write_text(database.name, encoding="utf-8")
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv(module.RESTART_MARKER_ENV, str(marker))
    assert stat.S_ISREG(os.lstat(marker).st_mode)
    assert module.validate_restart_database(must_exist=False) == database

    database.write_bytes(b"existing")
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=False)
    database.unlink()

    outside = tmp_path / "outside.db"
    outside.write_bytes(b"outside")
    database.symlink_to(outside)
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=True)
    database.unlink()

    os.link(outside, database)
    assert os.lstat(database).st_nlink == 2
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=True)
    database.unlink()

    database.mkdir()
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=True)
    database.rmdir()

    marker.unlink()
    marker_target = tmp_path / "marker-target"
    marker_target.write_text(database.name, encoding="utf-8")
    marker.symlink_to(marker_target)
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=False)
    marker.unlink()

    os.link(marker_target, marker)
    with pytest.raises(RuntimeError):
        module.validate_restart_database(must_exist=False)


def test_restart_write_startup_revalidates_created_database(tmp_path, monkeypatch):
    module = importlib.import_module("agent_workbench_live_app")
    guarded = tmp_path / "restart-post-create"
    guarded.mkdir()
    database = guarded / "restart.db"
    marker = guarded / module.RESTART_MARKER_NAME
    marker.write_text(database.name, encoding="utf-8")
    outside = tmp_path / "outside-write-target.db"
    outside.write_bytes(b"unchanged")
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv(module.RESTART_MARKER_ENV, str(marker))

    class Main:
        @staticmethod
        def initialize_writable_application():
            database.symlink_to(outside)

    seeded = []
    monkeypatch.setattr(module, "_task7_main", lambda: Main)
    monkeypatch.setattr(
        module, "_seed_restart_fixture", lambda *_args: seeded.append(True)
    )
    with pytest.raises(RuntimeError):
        module.restart_write_startup()
    assert seeded == []
    assert outside.read_bytes() == b"unchanged"


def test_restart_write_startup_never_opens_temporary_target_symlink_for_write(
    tmp_path, monkeypatch
):
    module = importlib.import_module("agent_workbench_live_app")
    from app import main

    guarded = tmp_path / "restart-temporary-link"
    guarded.mkdir()
    database = guarded / "restart.db"
    marker = guarded / module.RESTART_MARKER_NAME
    marker.write_text(database.name, encoding="utf-8")
    outside = tmp_path / "outside-restart.db"
    outside_connection = sqlite3.connect(outside)
    outside_connection.execute("CREATE TABLE external_guard(value TEXT)")
    outside_connection.execute("INSERT INTO external_guard VALUES ('preserve')")
    outside_connection.commit()
    outside_connection.close()
    outside_before = _external_sqlite_guard_state(outside)
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv(module.RESTART_MARKER_ENV, str(marker))
    original_initialize = main.initialize_writable_application

    def initialize_while_target_is_a_symlink():
        database.symlink_to(outside)
        try:
            original_initialize()
        finally:
            database.unlink()

    monkeypatch.setattr(
        main, "initialize_writable_application", initialize_while_target_is_a_symlink
    )
    monkeypatch.setattr(module, "_seed_restart_fixture", lambda *_args: None)
    real_connect = module.sqlite3.connect
    opened_databases = []

    def recording_connect(path, *args, **kwargs):
        opened_databases.append(path)
        return real_connect(path, *args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", recording_connect)
    module.restart_write_startup()
    monkeypatch.setattr(module.sqlite3, "connect", real_connect)

    assert stat.S_ISREG(os.lstat(database).st_mode)
    assert os.lstat(database).st_nlink == 1
    assert database.name not in {
        _sqlite_argument_basename(path) for path in opened_databases
    }
    assert _external_sqlite_guard_state(outside) == outside_before
    assert not any(
        Path(f"{database}{suffix}").exists()
        for suffix in ("-journal", "-wal", "-shm")
    )
    assert {path.name for path in guarded.iterdir()} == {
        database.name,
        marker.name,
    }


def test_restart_write_startup_never_opens_swappable_stage_path_for_write(
    tmp_path, monkeypatch
):
    module = importlib.import_module("agent_workbench_live_app")
    guarded = tmp_path / "restart-stage-swap"
    guarded.mkdir()
    database = guarded / "restart.db"
    marker = guarded / module.RESTART_MARKER_NAME
    marker.write_text(database.name, encoding="utf-8")
    outside = tmp_path / "outside-restart-stage.db"
    outside_connection = sqlite3.connect(outside)
    outside_connection.execute("CREATE TABLE external_guard(value TEXT)")
    outside_connection.execute("INSERT INTO external_guard VALUES ('preserve')")
    outside_connection.commit()
    outside_connection.close()
    outside_before = _external_sqlite_guard_state(outside)
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    monkeypatch.setenv(module.RESTART_MARKER_ENV, str(marker))
    real_connect = module.sqlite3.connect
    opened_databases = []
    attacked = False

    def connect_after_swapping_stage(path, *args, **kwargs):
        nonlocal attacked
        opened_databases.append(path)
        write_path = _sqlite_rw_path_argument(path)
        if write_path is None or attacked:
            return real_connect(path, *args, **kwargs)
        attacked = True
        saved = write_path.with_name(write_path.name + ".saved")
        os.link(write_path, saved)
        write_path.unlink()
        write_path.symlink_to(outside)
        try:
            return real_connect(path, *args, **kwargs)
        finally:
            write_path.unlink()
            os.link(saved, write_path)
            saved.unlink()

    monkeypatch.setattr(module.sqlite3, "connect", connect_after_swapping_stage)
    error = None
    try:
        module.restart_write_startup()
    except BaseException as caught:
        error = caught
    finally:
        monkeypatch.setattr(module.sqlite3, "connect", real_connect)

    assert error is None
    assert attacked is False
    assert all(_sqlite_rw_path_argument(path) is None for path in opened_databases)
    assert _external_sqlite_guard_state(outside) == outside_before
    assert stat.S_ISREG(os.lstat(database).st_mode)
    assert not any(
        Path(f"{outside}{suffix}").exists()
        for suffix in ("-journal", "-wal", "-shm")
    )


def _reserve_loopback_port():
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]
    finally:
        listener.close()


def _start_restart_server(api_dir, port, environment):
    return subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "agent_workbench_live_app:restart_probe_app",
            "--app-dir",
            "tests",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--log-level",
            "warning",
        ],
        cwd=api_dir,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def _wait_for_restart_server(process, base_url, *, timeout=12.0):
    expires = time.monotonic() + timeout
    while time.monotonic() < expires:
        if process.poll() is not None:
            raise AssertionError(
                f"restart server exited before readiness: {process.returncode}"
            )
        try:
            with httpx.Client(
                base_url=base_url, follow_redirects=False, timeout=0.5
            ) as client:
                response = client.post(
                    "/api/auth/login",
                    json={
                        "username": "restart-operator",
                        "password": "restart-password",
                    },
                )
                if response.status_code == 200:
                    return
        except httpx.HTTPError:
            pass
        time.sleep(0.05)
    raise AssertionError("restart server readiness timed out")


def _read_restart_api(base_url):
    with httpx.Client(
        base_url=base_url, follow_redirects=False, timeout=3.0
    ) as client:
        login = client.post(
            "/api/auth/login",
            json={
                "username": "restart-operator",
                "password": "restart-password",
            },
        )
        assert login.status_code == 200
        aggregate_response = client.get(
            "/api/agent-workbench", params={"range": "all"}
        )
        assert aggregate_response.status_code == 200
        aggregate = aggregate_response.json()
        module = importlib.import_module("agent_workbench_live_app")
        history_response = client.get(
            f"/api/agent-workbench/agents/{module.RESTART_LOCAL_AGENT_ID}/runs",
            params={"range": "all", "limit": 20},
        )
        assert history_response.status_code == 200
        history = history_response.json()
    agent = next(
        row
        for row in aggregate["agents"]
        if row["id"] == module.RESTART_LOCAL_AGENT_ID
    )
    assert len(history["items"]) == 1
    terminal = history["items"][0]
    assert terminal["coreai_run_id"] == module.RESTART_RUN_ID
    assert agent["last_terminal_run"]["coreai_run_id"] == module.RESTART_RUN_ID
    datetime.fromisoformat(aggregate["snapshot_at"])
    datetime.fromisoformat(history["range_end"])
    assert terminal["elapsed_seconds"] >= 0
    durable_fields = (
        "coreai_run_id",
        "raw_status",
        "trigger_type",
        "started_at",
        "effective_started_at",
        "completed_at",
        "terminal_observed_at",
        "receipt_expires_at",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "token_state",
        "last_synced_at",
        "association",
        "error_summary",
    )
    return {
        "agent": {
            "id": agent["id"],
            "agent_key": agent["agent_key"],
            "coreai_agent_id": agent["coreai_agent_id"],
            "display_name": agent["display_name"],
            "lifecycle_status": agent["lifecycle_status"],
            "role": agent["role"],
            "sort_order": agent["sort_order"],
        },
        "history": {key: terminal[key] for key in durable_fields},
    }


def _restart_sqlite_stable_hash(database):
    connection = sqlite3.connect(
        f"file:{database}?mode=ro", uri=True
    )
    connection.row_factory = sqlite3.Row
    try:
        payload = {
            table: [
                dict(row)
                for row in connection.execute(
                    f"SELECT * FROM {table} ORDER BY rowid"
                )
            ]
            for table in (
                "seo_ops_agents",
                "seo_ops_agent_runs",
                "seo_ops_agent_sync_state",
            )
        }
    finally:
        connection.close()
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _restart_file_manifest(database):
    return {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(database.parent.glob(f"{database.name}*"))
        if path.is_file()
    }


def _stop_restart_server(process):
    if process.poll() is None:
        process.send_signal(signal.SIGINT)
    exit_code = process.wait(timeout=12)
    assert exit_code == 0
    assert process.poll() == 0
    return exit_code


@pytest.mark.xfail(
    not TASK7_AVAILABLE, reason=TASK7_REASON, strict=True
)
def test_terminal_tokens_survive_real_server_restart(tmp_path, monkeypatch):
    _require_task7()
    module = importlib.import_module("agent_workbench_live_app")
    guarded = tmp_path / "restart-owned"
    guarded.mkdir()
    database = guarded / "restart.db"
    marker = guarded / module.RESTART_MARKER_NAME
    marker.write_text(database.name, encoding="utf-8")
    evidence_root = Path(
        os.environ.get("AW_RESTART_EVIDENCE_DIR", str(tmp_path / "evidence"))
    ).absolute()
    evidence_root.mkdir(parents=True, exist_ok=True)
    evidence_path = evidence_root / "server-restart.json"
    environment = dict(os.environ)
    for key in tuple(environment):
        if key.startswith("COREAI_"):
            environment.pop(key)
    environment.update(
        {
            "SEO_OPS_DB": str(database),
            "SEO_OPS_AUTH_USERNAME": "restart-operator",
            "SEO_OPS_AUTH_PASSWORD": "restart-password",
            "SEO_OPS_AUTH_SECRET": (
                "restart-secret-with-at-least-32-characters"
            ),
            "SEO_OPS_COOKIE_SECURE": "false",
            "SEO_OPS_OPERATOR_TIMEZONE": "UTC",
            "SEO_OPS_AGENT_HISTORY_LIMIT": "200",
            module.RESTART_MARKER_ENV: str(marker),
        }
    )
    api_dir = Path(__file__).resolve().parents[1]
    port = _reserve_loopback_port()
    base_url = f"http://127.0.0.1:{port}"
    process_a = None
    process_b = None
    try:
        environment[module.RESTART_PHASE_ENV] = "write"
        process_a = _start_restart_server(api_dir, port, environment)
        pid_a = process_a.pid
        _wait_for_restart_server(process_a, base_url)
        api_a = _read_restart_api(base_url)
        sqlite_a = _restart_sqlite_stable_hash(database)
        exit_a = _stop_restart_server(process_a)
        manifest_before_b = _restart_file_manifest(database)

        environment[module.RESTART_PHASE_ENV] = "read"
        process_b = _start_restart_server(api_dir, port, environment)
        pid_b = process_b.pid
        assert pid_b != pid_a
        _wait_for_restart_server(process_b, base_url)
        api_b = _read_restart_api(base_url)
        sqlite_b = _restart_sqlite_stable_hash(database)
        exit_b = _stop_restart_server(process_b)
        manifest_after_b = _restart_file_manifest(database)
    finally:
        for process in (process_a, process_b):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

    assert api_b == api_a
    assert sqlite_b == sqlite_a
    assert manifest_after_b == manifest_before_b
    terminal = api_b["history"]
    assert terminal["raw_status"] == "COMPLETED"
    assert terminal["input_tokens"] == 7
    assert terminal["output_tokens"] == 11
    assert terminal["total_tokens"] == 18
    assert terminal["terminal_observed_at"] == module.RESTART_OBSERVED_AT
    assert (
        terminal["receipt_expires_at"]
        == module.RESTART_RECEIPT_EXPIRES_AT
    )
    api_hash = hashlib.sha256(
        json.dumps(api_a, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    evidence = {
        "api_durable_subset_sha256": api_hash,
        "input_tokens": 7,
        "output_tokens": 11,
        "process_a_exit_code": exit_a,
        "process_a_pid": pid_a,
        "process_b_exit_code": exit_b,
        "process_b_pid": pid_b,
        "raw_status": "COMPLETED",
        "receipt_expires_at": module.RESTART_RECEIPT_EXPIRES_AT,
        "schema_version": "agent_workbench_server_restart.v1",
        "sqlite_stable_rows_sha256": sqlite_a,
        "terminal_observed_at": module.RESTART_OBSERVED_AT,
        "total_tokens": 18,
    }
    evidence_bytes = json.dumps(
        evidence, sort_keys=True, separators=(",", ":")
    ) + "\n"
    evidence_path.write_text(evidence_bytes, encoding="utf-8")
    assert evidence_path.read_text(encoding="utf-8") == evidence_bytes
    for secret in (
        environment["SEO_OPS_AUTH_SECRET"],
        environment["SEO_OPS_AUTH_PASSWORD"],
    ):
        assert secret not in evidence_bytes


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["--env-file", "x"],
        ["--env-file", "x", "--api-url", "http://127.0.0.1:8000"],
    ],
)
def test_live_readback_structural_and_sanitization_contract(argv, capsys):
    with pytest.raises(SystemExit) as caught:
        live_readback.build_parser().parse_args(argv)
    assert caught.value.code == 2
    assert "secret" not in capsys.readouterr().err.lower()


def test_live_readback_structural_and_sanitization_contract_fixed_output(
    monkeypatch, capsys
):
    sentinel = "DO-NOT-LEAK-TRANSPORT-SENTINEL"

    def unavailable(_args):
        raise RuntimeError(sentinel)

    monkeypatch.setattr(live_readback, "run_cli", unavailable)
    code = live_readback.main(
        [
            "--env-file",
            "not-read.env",
            "--api-url",
            "http://127.0.0.1:8000",
            "--range",
            "30d",
        ]
    )
    captured = capsys.readouterr()
    assert code == live_readback.EXIT_CODES[live_readback.RESULT_UNAVAILABLE]
    assert captured.err == f"{live_readback.RESULT_UNAVAILABLE}\n"
    assert sentinel not in captured.out + captured.err
    decoded = json.loads(captured.out)
    assert decoded == {
        "active_transition_candidates": [],
        "agent_segments": [],
        "configured_not_registered": [],
        "range": None,
        "result_code": live_readback.RESULT_UNAVAILABLE,
        "schema_version": live_readback.SCHEMA_VERSION,
    }
    assert captured.out == live_readback._canonical(decoded)


def test_live_readback_named_env_file_overrides_conflicting_ambient(
    tmp_path, monkeypatch
):
    named = tmp_path / "live.env"
    named.write_text(
        "\n".join(
            (
                "SEO_OPS_AUTH_USERNAME=file-user",
                "SEO_OPS_AUTH_PASSWORD=file-password",
                "SEO_OPS_AUTH_SECRET=file-secret-that-is-at-least-32-characters",
                f"SEO_OPS_DB={tmp_path / 'file.db'}",
                "COREAI_BASE_URL=https://file-core.example",
                "COREAI_API_KEY=file-core-key",
                "COREAI_AGENT_ID=file-agent",
                "SEO_OPS_OPERATOR_TIMEZONE=UTC",
                "SEO_OPS_AGENT_HISTORY_LIMIT=77",
            )
        )
        + "\n",
        encoding="utf-8",
    )
    sentinel = "AMBIENT-SECRET-SENTINEL"
    for key in (
        "SEO_OPS_AUTH_USERNAME",
        "SEO_OPS_AUTH_PASSWORD",
        "SEO_OPS_AUTH_SECRET",
        "SEO_OPS_DB",
        "COREAI_BASE_URL",
        "COREAI_API_KEY",
        "COREAI_AGENT_ID",
        "SEO_OPS_OPERATOR_TIMEZONE",
        "SEO_OPS_AGENT_HISTORY_LIMIT",
    ):
        monkeypatch.setenv(key, sentinel)
    before = dict(os.environ)

    values = live_readback.load_named_environment(str(named))
    slots = tuple(__import__("app.config", fromlist=["configured_agent_slots"]).configured_agent_slots(values))

    assert values["COREAI_BASE_URL"] == "https://file-core.example"
    assert [slot.coreai_agent_id for slot in slots] == ["file-agent"]
    assert dict(os.environ) == before
    assert sentinel not in live_readback._canonical(
        {"base_url": values["COREAI_BASE_URL"], "ids": [slot.coreai_agent_id for slot in slots]}
    )


@pytest.mark.parametrize("seconds", ["0", "241", "not-an-integer"])
def test_live_readback_global_deadline(seconds):
    with pytest.raises(SystemExit) as caught:
        live_readback.build_parser().parse_args(
            [
                "--env-file",
                "x",
                "--api-url",
                "http://127.0.0.1:8000",
                "--range",
                "30d",
                "--overall-timeout-seconds",
                seconds,
            ]
        )
    assert caught.value.code == 2
    assert live_readback.build_parser().parse_args(
        [
            "--env-file",
            "x",
            "--api-url",
            "http://127.0.0.1:8000",
            "--range",
            "30d",
        ]
    ).overall_timeout_seconds == 240


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:8000",
        "http://external.example:8000",
        "http://user:password@127.0.0.1:8000",
        "http://127.0.0.1:8000/",
        "http://127.0.0.1:8000/path",
        "http://127.0.0.1:8000/?query=1",
        "http://127.0.0.1:8000/#fragment",
        "http://127.0.0.1",
    ],
)
def test_live_readback_rejects_non_loopback_url_and_redirect(url):
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback.validate_api_url(url)
    assert caught.value.code == live_readback.RESULT_UNAVAILABLE


def test_live_readback_rejects_non_loopback_url_and_redirect_before_env_load(
    monkeypatch,
):
    touched = False

    def forbidden(_path):
        nonlocal touched
        touched = True
        raise AssertionError("named environment must not be read")

    monkeypatch.setattr(live_readback, "load_named_environment", forbidden)
    args = argparse.Namespace(
        env_file="secret.env",
        api_url="https://outside.example:443",
        range_key="30d",
        strict=True,
        overall_timeout_seconds=240,
        observe_run_id=None,
        observe_seconds=None,
    )
    with pytest.raises(live_readback.GateFailure):
        live_readback.run_cli(args)
    assert touched is False


def test_live_readback_rejects_non_loopback_url_and_redirect_response():
    seen = {}

    class Response:
        status_code = 302

        def json(self):
            raise AssertionError("redirect body must not be read")

    class Client:
        def __init__(self, **kwargs):
            seen.update(kwargs)

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def get(self, *_args, **_kwargs):
            return Response()

    deadline = live_readback.Deadline.start(10)
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback._request_aggregate(
            "http://127.0.0.1:8000",
            "30d",
            {
                "SEO_OPS_AUTH_USERNAME": "operator",
                "SEO_OPS_AUTH_SECRET": "a-secret-that-is-at-least-32-characters",
            },
            deadline,
            client_factory=Client,
        )
    assert caught.value.code == live_readback.RESULT_UNAVAILABLE
    assert seen["follow_redirects"] is False


def test_live_readback_directly_reads_every_active_or_configured_agent():
    fake = ListOnlyCoreAiFake(_four_pages())
    values = {
        "COREAI_BASE_URL": "https://core.example",
        "COREAI_API_KEY": "secret",
    }
    result = live_readback._direct_bundle(
        CORE_ID,
        values,
        live_readback.Deadline.start(10),
        core_client_factory=lambda _url, _key: fake,
    )
    assert result["coreai_agent_id"] == CORE_ID
    assert fake.calls == [
        (CORE_ID, None, live_readback.LIST_LIMIT),
        (CORE_ID, "PENDING", live_readback.LIST_LIMIT),
        (CORE_ID, "RUNNING", live_readback.LIST_LIMIT),
        (CORE_ID, "PAUSED", live_readback.LIST_LIMIT),
    ]
    assert fake.get_run_calls == 0
    assert fake.closed is True


def _bundle_from_rows(rows, *, total=None):
    pages = {}
    for status in live_readback.FILTERS:
        selected = list(rows) if status is None else [row for row in rows if row["status"] == status]
        page_total = total if status is None and total is not None else len(selected)
        pages[status or "ALL"] = agent_workbench.parse_agent_run_page(
            CORE_ID,
            _page(selected, total=page_total),
            NOW,
            expected_status=status,
        )
    return {"coreai_agent_id": CORE_ID, "pages": pages}


@pytest.mark.parametrize(
    "status",
    [
        "PENDING",
        "RUNNING",
        "PAUSED",
        "COMPLETED",
        "FAILED",
        "TIMEOUT",
        "CANCELLED",
        "SKIPPED",
        "FUTURE_STATE",
        None,
    ],
)
def test_live_readback_compares_status_ids_owners_totals_and_tokens(
    tmp_path, monkeypatch, status
):
    _, conn = _open_database(tmp_path, monkeypatch, f"unconfirmed-{status}.db")
    _seed_agent(conn, monkeypatch)
    if status is None:
        merchant_id = conn.execute(
            "INSERT INTO merchants (name,created_at) VALUES ('Acceptance',?)",
            (NOW.isoformat(),),
        ).lastrowid
        source_id = conn.execute(
            "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
            "VALUES (?,'unconfirmed','running','manual',?)",
            (merchant_id, NOW.isoformat()),
        ).lastrowid
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
            "source_kind,source_local_id,merchant_id,first_seen_at,last_synced_at) "
            "VALUES ('unconfirmed',?,NULL,'run',?,?,?,NULL)",
            (LOCAL_ID, source_id, merchant_id, NOW.isoformat()),
        )
    else:
        conn.execute(
            "INSERT INTO seo_ops_agent_runs (coreai_run_id,seo_ops_agent_id,raw_status,"
            "trigger_type,started_at,first_seen_at,last_synced_at) VALUES "
            "('unconfirmed',?,?,NULL,?,?,NULL)",
            (LOCAL_ID, status, NOW.isoformat(), NOW.isoformat()),
        )
    conn.commit()
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback._compare_bundle(conn, LOCAL_ID, _bundle_from_rows([], total=1))
    assert caught.value.code == live_readback.RESULT_UNCONFIRMED
    conn.close()


def test_live_readback_compares_status_ids_owners_totals_and_tokens_exact_and_bounded(
    tmp_path, monkeypatch
):
    _, conn = _open_database(tmp_path, monkeypatch, "bundle.db")
    _seed_agent(conn, monkeypatch)
    for run_id, token_pair in (("one", (7, 11)), ("two", (13, 17))):
        parsed = agent_workbench.parse_agent_run_page(
            CORE_ID,
            _page((_run(run_id, "COMPLETED", completed_at=NOW, tokens=token_pair),)),
            NOW,
        ).runs[0]
        agent_workbench.upsert_projected_run(conn, LOCAL_ID, parsed, NOW)
    exact = live_readback._compare_bundle(
        conn,
        LOCAL_ID,
        _bundle_from_rows(
            [
                _run("one", "COMPLETED", completed_at=NOW, tokens=(7, 11)),
                _run("two", "COMPLETED", completed_at=NOW, tokens=(13, 17)),
            ]
        ),
    )
    assert exact["comparison"] == "exact"
    assert exact["known_input_tokens"] == 20
    assert exact["known_output_tokens"] == 28
    assert exact["known_total_tokens"] == 48
    bounded = live_readback._compare_bundle(
        conn,
        LOCAL_ID,
        _bundle_from_rows(
            [_run("one", "COMPLETED", completed_at=NOW, tokens=(7, 11))],
            total=2,
        ),
    )
    assert bounded["comparison"] == "bounded_overlap"
    assert bounded["returned_ids"] == ["one"]
    assert bounded["known_total_tokens"] == 18
    conn.close()


def test_live_readback_reports_active_transition_candidates():
    eligible = {
        "coreai_run_id": "eligible",
        "local_agent_id": LOCAL_ID,
        "raw_status": "RUNNING",
        "lifecycle_status": "active",
        "agent_current_state_complete": True,
        "fresh": True,
        "suspect": False,
        "signal_state": "active",
    }
    assert live_readback._motion_candidates({"signals": [eligible]}) == [
        {
            "coreai_run_id": "eligible",
            "local_agent_id": LOCAL_ID,
            "raw_status": "RUNNING",
            "transition_observed": "not_applicable",
        }
    ]
    for field, value in (
        ("raw_status", "PENDING"),
        ("lifecycle_status", "disabled"),
        ("agent_current_state_complete", False),
        ("fresh", False),
        ("suspect", True),
        ("signal_state", "uncertain"),
    ):
        row = {**eligible, field: value}
        assert live_readback._motion_candidates({"signals": [row]}) == []


def _segment_attempt(code, fingerprint, local_id, *, label):
    segment = (
        {
            "coreai_agent_id": label,
            "local_agent_id": local_id,
            "returned_ids": [],
        }
        if code == live_readback.RESULT_OK
        else None
    )
    return live_readback.SegmentAttempt(
        result_code=code,
        fingerprint=fingerprint,
        marker_before=f"marker-{local_id}",
        marker_after=f"marker-{local_id}",
        observed_from="2026-09-03T04:00:00Z",
        observed_through="2026-09-03T04:00:01Z",
        segment=segment,
        bundle={"coreai_agent_id": label, "pages": {}},
    )


def test_live_readback_retries_only_changed_segment(tmp_path, monkeypatch):
    path, conn = _open_database(tmp_path, monkeypatch, "targeted-retry.db")
    peer_local_id = "22222222-2222-4222-8222-222222222222"
    peer_core_id = "agent-peer"
    ids = iter((UUID(LOCAL_ID), UUID(peer_local_id)))
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(ids))
    peer_slot = BootstrapAgentSlot(
        env_name="COREAI_PEER_AGENT_ID",
        agent_key="peer",
        display_name="Peer Agent",
        role="Stable peer",
        sort_order=20,
        coreai_agent_id=peer_core_id,
    )
    agent_workbench.seed_configured_agents(conn, (_slot(), peer_slot), NOW)
    conn.commit()
    conn.close()

    readback = sqlite3.connect(path)
    readback.row_factory = sqlite3.Row
    registry = [
        dict(row)
        for row in readback.execute(
            "SELECT id,coreai_agent_id,status FROM seo_ops_agents ORDER BY id"
        )
    ]
    readback.close()
    aggregate = {
        "agents": [
            {
                "coreai_agent_id": row["coreai_agent_id"],
                "id": row["id"],
                "lifecycle_status": row["status"],
            }
            for row in registry
        ],
        "signals": [],
    }
    monkeypatch.setattr(
        live_readback,
        "_local_bracket",
        lambda *_args, **_kwargs: (aggregate, "local-hash"),
    )
    monkeypatch.setattr(
        live_readback,
        "_agent_marker",
        lambda _conn, local_id: f"marker-{local_id}",
    )
    calls = []

    def collect(_conn, core_ids, by_core, *_args):
        selected = tuple(sorted(core_ids))
        calls.append(selected)
        if len(calls) == 1:
            return {
                CORE_ID: _segment_attempt(
                    live_readback.RESULT_OK,
                    "stable",
                    by_core[CORE_ID]["id"],
                    label=CORE_ID,
                ),
                peer_core_id: _segment_attempt(
                    live_readback.RESULT_MISMATCH,
                    "bad-first",
                    by_core[peer_core_id]["id"],
                    label=peer_core_id,
                ),
            }
        assert selected == (peer_core_id,)
        return {
            peer_core_id: _segment_attempt(
                live_readback.RESULT_OK,
                "clean-second",
                by_core[peer_core_id]["id"],
                label=peer_core_id,
            )
        }

    monkeypatch.setattr(live_readback, "_collect_segment_attempts", collect)
    sleeps = []
    report = live_readback.reconcile(
        {
            "SEO_OPS_DB": str(path),
            "COREAI_AGENT_ID": CORE_ID,
        },
        "http://127.0.0.1:8000",
        "30d",
        sleep=sleeps.append,
    )
    assert calls == [(CORE_ID, peer_core_id), (peer_core_id,)]
    assert sleeps == [live_readback.NORMAL_PROOF_INTERVAL_SECONDS]
    assert [row["coreai_agent_id"] for row in report["agent_segments"]] == [
        CORE_ID,
        peer_core_id,
    ]


def test_live_readback_retry_outcomes():
    mismatch = _segment_attempt(
        live_readback.RESULT_MISMATCH, "same", LOCAL_ID, label=CORE_ID
    )
    same = _segment_attempt(
        live_readback.RESULT_MISMATCH, "same", LOCAL_ID, label=CORE_ID
    )
    changed = _segment_attempt(
        live_readback.RESULT_MISMATCH, "new-watermark", LOCAL_ID, label=CORE_ID
    )
    clean = _segment_attempt(
        live_readback.RESULT_OK, "clean", LOCAL_ID, label=CORE_ID
    )
    assert live_readback._retry_failure(mismatch, clean) == live_readback.RESULT_OK
    assert (
        live_readback._retry_failure(mismatch, same)
        == live_readback.RESULT_MISMATCH
    )
    assert (
        live_readback._retry_failure(mismatch, changed)
        == live_readback.RESULT_UNSTABLE
    )


def test_live_readback_clock_only_heartbeat_keeps_segment_stable():
    first = _bundle_from_rows(
        [_run("stable-running", "RUNNING")],
    )
    second = _bundle_from_rows(
        [_run("stable-running", "RUNNING")],
    )
    assert first["pages"]["ALL"].observed_at == second["pages"]["ALL"].observed_at
    moved = {}
    for name, page in second["pages"].items():
        moved[name] = type(page)(
            runs=page.runs,
            total=page.total,
            returned_count=page.returned_count,
            observed_at=(NOW + timedelta(seconds=30)).isoformat(),
        )
    second = {"coreai_agent_id": CORE_ID, "pages": moved}
    assert (
        live_readback._bundle_fingerprint(first)
        == live_readback._bundle_fingerprint(second)
    )
    changed = _bundle_from_rows(
        [_run("stable-running", "PAUSED")],
    )
    assert (
        live_readback._bundle_fingerprint(first)
        != live_readback._bundle_fingerprint(changed)
    )


def test_live_readback_semantic_marker_excludes_only_lease_and_clock_fields(
    tmp_path, monkeypatch
):
    _, conn = _open_database(tmp_path, monkeypatch, "semantic-marker.db")
    _seed_agent(conn, monkeypatch)
    before = live_readback._agent_marker(conn, LOCAL_ID)
    conn.execute(
        "UPDATE seo_ops_agents SET last_verification_attempt_at=?,last_verified_at=?,"
        "next_verification_at=?,metadata_lease_owner=?,metadata_lease_epoch="
        "metadata_lease_epoch+1,metadata_lease_until=? WHERE id=?",
        (
            (NOW + timedelta(seconds=30)).isoformat(),
            (NOW + timedelta(seconds=30)).isoformat(),
            (NOW + timedelta(days=2)).isoformat(),
            "other-worker",
            (NOW + timedelta(minutes=1)).isoformat(),
            LOCAL_ID,
        ),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET last_discovery_attempt_at=?,"
        "current_state_checked_at=?,lease_owner=?,lease_epoch=lease_epoch+1,"
        "lease_until=? WHERE seo_ops_agent_id=?",
        (
            (NOW + timedelta(seconds=30)).isoformat(),
            (NOW + timedelta(seconds=30)).isoformat(),
            "other-worker",
            (NOW + timedelta(minutes=1)).isoformat(),
            LOCAL_ID,
        ),
    )
    conn.commit()
    assert live_readback._agent_marker(conn, LOCAL_ID) == before
    conn.execute(
        "UPDATE seo_ops_agents SET display_name='Materially changed' WHERE id=?",
        (LOCAL_ID,),
    )
    conn.commit()
    assert live_readback._agent_marker(conn, LOCAL_ID) != before
    conn.close()


def test_live_readback_local_bracket_discards_one_unstable_attempt(monkeypatch):
    calls = []
    outcomes = iter(
        (
            live_readback.GateFailure(live_readback.RESULT_UNSTABLE),
            ({"snapshot_at": NOW.isoformat()}, "stable-hash"),
        )
    )

    def bracket(*_args, **_kwargs):
        calls.append("read")
        outcome = next(outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(live_readback, "_local_bracket", bracket)
    sleeps = []
    result = live_readback._stable_local_bracket(
        object(),
        "http://127.0.0.1:8000",
        "30d",
        {},
        live_readback.Deadline.start(60),
        object,
        sleeps.append,
    )
    assert result == ({"snapshot_at": NOW.isoformat()}, "stable-hash")
    assert calls == ["read", "read"]
    assert sleeps == [live_readback.NORMAL_PROOF_INTERVAL_SECONDS]

    monkeypatch.setattr(
        live_readback,
        "_local_bracket",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            live_readback.GateFailure(live_readback.RESULT_UNSTABLE)
        ),
    )
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback._stable_local_bracket(
            object(),
            "http://127.0.0.1:8000",
            "30d",
            {},
            live_readback.Deadline.start(60),
            object,
            lambda _seconds: None,
        )
    assert caught.value.code == live_readback.RESULT_UNSTABLE


def test_live_readback_global_deadline_terminates_noncooperative_workers(monkeypatch):
    core_ids = tuple(f"agent-{index:02d}" for index in range(17))
    registry = {
        core_id: {"id": f"local-{index:02d}"}
        for index, core_id in enumerate(core_ids)
    }
    monkeypatch.setattr(live_readback, "_agent_marker", lambda *_args: "stable")
    context = multiprocessing.get_context("fork")
    worker_started = context.Event()
    original_threads = {thread.ident for thread in threading.enumerate()}
    original_children = {process.pid for process in multiprocessing.active_children()}

    class SlowClient:
        def __init__(self, _timeout):
            pass

        def get_agent(self, agent_id):
            worker_started.set()
            # Deliberately ignores the supplied transport timeout.
            time.sleep(0.30)
            return {"id": agent_id}

        def list_agent_runs(self, *_args):
            return {"runs": [], "total": 0}

        def close(self):
            pass

    def factory(_url, _key, *, timeout):
        return SlowClient(timeout)

    started = time.monotonic()
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback._collect_segment_attempts(
            object(),
            core_ids,
            registry,
            {
                "COREAI_BASE_URL": "https://core.example",
                "COREAI_API_KEY": "secret",
            },
            live_readback.Deadline.start(0.05),
            factory,
        )
    elapsed = time.monotonic() - started
    assert caught.value.code == live_readback.RESULT_TIMEOUT
    assert worker_started.is_set()
    assert elapsed < 0.20
    assert {thread.ident for thread in threading.enumerate()} == original_threads
    assert {
        process.pid for process in multiprocessing.active_children()
    } == original_children


def test_live_readback_default_core_client_spawns_after_parent_http(monkeypatch):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self):
            if self.path.startswith("/api/agent-workbench?"):
                body = {"snapshot_at": NOW.isoformat()}
            elif self.path == f"/api/agents/{CORE_ID}":
                body = {"id": CORE_ID}
            elif self.path.startswith(f"/api/runs/agent/{CORE_ID}/list?"):
                body = {"runs": [], "total": 0}
            else:
                self.send_error(404)
                return
            encoded = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server.server_port}"
    values = {
        "COREAI_API_KEY": "test-key",
        "COREAI_BASE_URL": base_url,
        "SEO_OPS_AUTH_SECRET": "s" * 32,
        "SEO_OPS_AUTH_USERNAME": "operator",
    }
    real_get_context = multiprocessing.get_context
    requested_methods = []

    def recording_context(method):
        requested_methods.append(method)
        return real_get_context(method)

    monkeypatch.setattr(live_readback.multiprocessing, "get_context", recording_context)
    try:
        deadline = live_readback.Deadline.start(10)
        # Reproduce the production order: parent process completes local HTTP
        # before the isolated default CoreAiClient performs network/TLS work.
        assert live_readback._request_aggregate(
            base_url, "30d", values, deadline
        )["snapshot_at"] == NOW.isoformat()
        bundles = live_readback._supervised_direct_bundles(
            (CORE_ID,), values, deadline, live_readback.CoreAiClient
        )
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)

    assert requested_methods == ["spawn"]
    assert set(bundles) == {CORE_ID}
    assert bundles[CORE_ID]["coreai_agent_id"] == CORE_ID
    assert all(page.total == 0 for page in bundles[CORE_ID]["pages"].values())


def _eligible_aggregate(run_id, status="RUNNING"):
    signal = {
        "coreai_run_id": run_id,
        "local_agent_id": LOCAL_ID,
        "raw_status": status,
    }
    if status == "RUNNING":
        signal.update(
            {
                "lifecycle_status": "active",
                "agent_current_state_complete": True,
                "fresh": True,
                "suspect": False,
                "signal_state": "active",
            }
        )
    return {"agents": [], "refresh_after_ms": 1000, "signals": [signal]}


@pytest.mark.parametrize(
    "terminal_status", ["COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"]
)
def test_live_readback_observe_mode_proves_same_run_transition(
    tmp_path, monkeypatch, terminal_status
):
    path, conn = _open_database(
        tmp_path, monkeypatch, f"observe-{terminal_status}.db"
    )
    _seed_agent(conn, monkeypatch)
    run_id = f"observe-{terminal_status.lower()}"
    parsed = agent_workbench.parse_agent_run_page(
        CORE_ID,
        _page(
            (
                _run(
                    run_id,
                    terminal_status,
                    completed_at=NOW,
                    tokens=(7, 11),
                ),
            )
        ),
        NOW,
    ).runs[0]
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, parsed, NOW)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=1,"
        "last_discovery_returned_count=1,history_event_epoch=1,"
        "unfiltered_proven_event_epoch=1,pending_observed_count=0,"
        "pending_upstream_total=0,pending_set_quality='exact',"
        "running_observed_count=0,running_upstream_total=0,"
        "running_set_quality='exact',paused_observed_count=0,"
        "paused_upstream_total=0,paused_set_quality='exact' "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    )
    conn.commit()
    conn.close()
    initial = _eligible_aggregate(run_id)
    terminal = _eligible_aggregate(run_id, terminal_status)
    aggregates = iter((initial, terminal))
    monkeypatch.setattr(
        live_readback,
        "_request_aggregate",
        lambda *_args, **_kwargs: next(aggregates),
    )
    monkeypatch.setattr(
        live_readback,
        "_local_bracket",
        lambda *_args, **_kwargs: (terminal, "terminal-hash"),
    )
    fake = ListOnlyCoreAiFake(
        _four_pages(
            all_rows=(
                _run(
                    run_id,
                    terminal_status,
                    completed_at=NOW,
                    tokens=(7, 11),
                ),
            )
        )
    )
    report = live_readback.observe_transition(
        {
            "SEO_OPS_DB": str(path),
            "COREAI_BASE_URL": "https://core.example",
            "COREAI_API_KEY": "acceptance-secret",
        },
        "http://127.0.0.1:8000",
        "30d",
        run_id,
        5,
        timeout_seconds=10,
        sleep=lambda _seconds: None,
        core_client_factory=lambda *_args, **_kwargs: fake,
    )
    assert report["observe_run_id"] == run_id
    assert report["final_raw_status"] == terminal_status
    assert report["terminal_token_match"] is True
    assert report["transition_observed"] is True
    # Success requires the isolated bundle's ALL page to match this same Run
    # and Token tuple. Exact list-only call shape is asserted directly in
    # test_live_readback_directly_reads_every_active_or_configured_agent.


def test_live_readback_observe_mode_times_out_honestly_on_token_mismatch(
    tmp_path, monkeypatch
):
    path, conn = _open_database(tmp_path, monkeypatch, "observe-mismatch.db")
    _seed_agent(conn, monkeypatch)
    run_id = "observe-token-mismatch"
    parsed = agent_workbench.parse_agent_run_page(
        CORE_ID,
        _page((_run(run_id, "COMPLETED", completed_at=NOW, tokens=(7, 11)),)),
        NOW,
    ).runs[0]
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, parsed, NOW)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=1,"
        "last_discovery_returned_count=1,history_event_epoch=1,"
        "unfiltered_proven_event_epoch=1,pending_observed_count=0,"
        "pending_upstream_total=0,pending_set_quality='exact',"
        "running_observed_count=0,running_upstream_total=0,"
        "running_set_quality='exact',paused_observed_count=0,"
        "paused_upstream_total=0,paused_set_quality='exact' "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    )
    conn.commit()
    conn.close()
    initial = _eligible_aggregate(run_id)
    terminal = _eligible_aggregate(run_id, "COMPLETED")
    aggregates = iter((initial, terminal))
    monkeypatch.setattr(
        live_readback,
        "_request_aggregate",
        lambda *_args, **_kwargs: next(aggregates),
    )
    monkeypatch.setattr(
        live_readback,
        "_local_bracket",
        lambda *_args, **_kwargs: (terminal, "terminal-hash"),
    )
    fake = ListOnlyCoreAiFake(
        _four_pages(
            all_rows=(
                _run(run_id, "COMPLETED", completed_at=NOW, tokens=(7, 12)),
            )
        )
    )
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback.observe_transition(
            {
                "SEO_OPS_DB": str(path),
                "COREAI_BASE_URL": "https://core.example",
                "COREAI_API_KEY": "acceptance-secret",
            },
            "http://127.0.0.1:8000",
            "30d",
            run_id,
            5,
            timeout_seconds=10,
            sleep=lambda _seconds: None,
            core_client_factory=lambda *_args, **_kwargs: fake,
        )
    assert caught.value.code == live_readback.RESULT_MISMATCH


def test_live_readback_observe_requires_running_to_be_reestablished_after_gap(
    tmp_path, monkeypatch
):
    path, conn = _open_database(tmp_path, monkeypatch, "observe-gap.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    run_id = "observe-gap"
    paused = _eligible_aggregate(run_id, "PAUSED")
    terminal = _eligible_aggregate(run_id, "COMPLETED")
    responses = iter((_eligible_aggregate(run_id), paused, terminal))
    request_count = 0

    def request(*_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        return next(responses)

    class Clock:
        value = 0.0

        def __call__(self):
            return self.value

        def sleep(self, seconds):
            self.value += seconds

    clock = Clock()
    monkeypatch.setattr(live_readback, "_request_aggregate", request)
    with pytest.raises(live_readback.GateFailure) as caught:
        live_readback.observe_transition(
            {
                "SEO_OPS_DB": str(path),
                "COREAI_BASE_URL": "https://core.example",
                "COREAI_API_KEY": "secret",
            },
            "http://127.0.0.1:8000",
            "30d",
            run_id,
            3,
            timeout_seconds=10,
            sleep=clock.sleep,
            monotonic=clock,
            core_client_factory=lambda *_args, **_kwargs: (_ for _ in ()).throw(
                AssertionError("terminal without a renewed RUNNING proof is ineligible")
            ),
        )
    assert caught.value.code == live_readback.RESULT_TRANSITION_MISSING
    # Initial RUNNING plus two in-bound polls. The request at exactly stop_at
    # is forbidden even though a terminal response would be available.
    assert request_count == 3


def test_live_readback_observe_accepts_terminal_after_running_is_reestablished(
    tmp_path, monkeypatch
):
    path, conn = _open_database(tmp_path, monkeypatch, "observe-renewed.db")
    _seed_agent(conn, monkeypatch)
    conn.close()
    run_id = "observe-renewed"
    terminal = _eligible_aggregate(run_id, "COMPLETED")
    responses = iter(
        (
            _eligible_aggregate(run_id),
            _eligible_aggregate(run_id, "PAUSED"),
            _eligible_aggregate(run_id),
            terminal,
        )
    )
    monkeypatch.setattr(
        live_readback, "_request_aggregate", lambda *_args, **_kwargs: next(responses)
    )
    monkeypatch.setattr(
        live_readback,
        "_stable_local_bracket",
        lambda *_args, **_kwargs: (terminal, "terminal-hash"),
    )
    attempt = live_readback.SegmentAttempt(
        result_code=live_readback.RESULT_OK,
        fingerprint="renewed",
        marker_before="stable",
        marker_after="stable",
        observed_from=NOW.isoformat(),
        observed_through=NOW.isoformat(),
        segment={},
        bundle={},
    )
    monkeypatch.setattr(
        live_readback,
        "_collect_segment_attempts",
        lambda _conn, core_ids, *_args, **_kwargs: {next(iter(core_ids)): attempt},
    )
    monkeypatch.setattr(live_readback, "_require_terminal_match", lambda *_args: None)

    class Clock:
        value = 0.0

        def __call__(self):
            return self.value

        def sleep(self, seconds):
            self.value += seconds

    clock = Clock()
    report = live_readback.observe_transition(
        {
            "SEO_OPS_DB": str(path),
            "COREAI_BASE_URL": "https://core.example",
            "COREAI_API_KEY": "secret",
        },
        "http://127.0.0.1:8000",
        "30d",
        run_id,
        4,
        timeout_seconds=10,
        sleep=clock.sleep,
        monotonic=clock,
    )
    assert report["result_code"] == live_readback.RESULT_OK
    assert report["final_raw_status"] == "COMPLETED"


def test_visual_fixture_rejects_unsafe_paths(tmp_path, monkeypatch):
    configured = tmp_path / "configured" / "seo.db"
    configured.parent.mkdir()
    monkeypatch.setattr(visual_fixture.app_db, "DEFAULT_DB_PATH", configured)
    for path in (configured.parent, tmp_path, configured.parent / "child"):
        if not path.exists():
            path.mkdir()
        with pytest.raises(ValueError):
            visual_fixture.validate_generation_directory(path)
    nonempty = tmp_path / "nonempty"
    nonempty.mkdir()
    (nonempty / "owned.txt").write_text("not empty", encoding="utf-8")
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "elsewhere" / "seo.db",
    )
    with pytest.raises(ValueError):
        visual_fixture.validate_generation_directory(nonempty)
    unmarked = tmp_path / "unmarked.db"
    sqlite3.connect(unmarked).close()
    with pytest.raises(ValueError):
        visual_fixture.validate_refresh_database(unmarked)


def test_visual_fixture_rejects_symlink_directory_and_cleans_partial_sidecars(
    tmp_path, monkeypatch
):
    target = tmp_path / "fixture-target"
    target.mkdir()
    linked = tmp_path / "fixture-link"
    linked.symlink_to(target, target_is_directory=True)
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    with pytest.raises(ValueError):
        visual_fixture.validate_generation_directory(linked)

    output = tmp_path / "partial-cleanup"
    output.mkdir()

    def fail_after_sidecars(path, _scenario):
        assert path.is_file()
        assert not path.is_symlink()
        Path(f"{path}-journal").write_bytes(b"journal")
        Path(f"{path}-wal").write_bytes(b"wal")
        Path(f"{path}-shm").write_bytes(b"shm")
        raise sqlite3.OperationalError("fixed fixture failure")

    monkeypatch.setattr(visual_fixture, "_new_database", fail_after_sidecars)
    with pytest.raises(sqlite3.OperationalError):
        visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    assert list(output.iterdir()) == []


def test_visual_fixture_hides_stage_path_from_production_initializer(
    tmp_path, monkeypatch
):
    output = tmp_path / "atomic-fixture"
    output.mkdir()
    outside = tmp_path / "outside-fixture.db"
    outside.write_bytes(b"unchanged")
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )

    observed_databases = []

    def stop_after_observing_database():
        observed_databases.append(os.environ["SEO_OPS_DB"])
        raise RuntimeError("fixed initializer stop")

    monkeypatch.setattr(
        visual_fixture.app_db, "init_db", stop_after_observing_database
    )
    with pytest.raises(RuntimeError, match="fixed initializer stop"):
        visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    assert observed_databases == [":memory:"]
    assert outside.read_bytes() == b"unchanged"
    assert list(output.iterdir()) == []


def test_visual_fixture_generation_initializes_only_an_in_memory_database(
    tmp_path, monkeypatch
):
    output = tmp_path / "generation-temporary-link"
    output.mkdir()
    outside = tmp_path / "outside-generation.db"
    outside_connection = sqlite3.connect(outside)
    outside_connection.execute("CREATE TABLE external_guard(value TEXT)")
    outside_connection.execute("INSERT INTO external_guard VALUES ('preserve')")
    outside_connection.commit()
    outside_connection.close()
    outside_before = _external_sqlite_guard_state(outside)
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    real_init_db = visual_fixture.app_db.init_db

    initialized_databases = []

    def initialize_memory_database():
        initialized_databases.append(os.environ["SEO_OPS_DB"])
        real_init_db()

    monkeypatch.setattr(
        visual_fixture.app_db, "init_db", initialize_memory_database
    )
    real_connect = visual_fixture.sqlite3.connect
    opened_databases = []

    def recording_connect(path, *args, **kwargs):
        opened_databases.append(path)
        return real_connect(path, *args, **kwargs)

    monkeypatch.setattr(visual_fixture.sqlite3, "connect", recording_connect)
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    monkeypatch.setattr(visual_fixture.sqlite3, "connect", real_connect)

    assert initialized_databases == [":memory:"] * len(visual_fixture.SCENARIOS)
    assert all(_sqlite_rw_path_argument(path) is None for path in opened_databases)
    assert set(record["database_paths"]) == set(visual_fixture.SCENARIOS)
    assert _external_sqlite_guard_state(outside) == outside_before
    assert {path.name for path in output.iterdir()} == {
        f"{scenario}.db" for scenario in visual_fixture.SCENARIOS
    }


def test_visual_fixture_generation_never_opens_swappable_stage_path_for_write(
    tmp_path, monkeypatch
):
    output = tmp_path / "generation-stage-swap"
    output.mkdir()
    outside = tmp_path / "outside-generation-stage.db"
    outside_connection = sqlite3.connect(outside)
    outside_connection.execute("CREATE TABLE external_guard(value TEXT)")
    outside_connection.execute("INSERT INTO external_guard VALUES ('preserve')")
    outside_connection.commit()
    outside_connection.close()
    outside_before = _external_sqlite_guard_state(outside)
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    real_connect = visual_fixture.sqlite3.connect
    opened_databases = []
    attacked = False

    def connect_after_swapping_stage(path, *args, **kwargs):
        nonlocal attacked
        opened_databases.append(path)
        write_path = _sqlite_rw_path_argument(path)
        if write_path is None or attacked:
            return real_connect(path, *args, **kwargs)
        attacked = True
        saved = write_path.with_name(write_path.name + ".saved")
        os.link(write_path, saved)
        write_path.unlink()
        write_path.symlink_to(outside)
        try:
            return real_connect(path, *args, **kwargs)
        finally:
            write_path.unlink()
            os.link(saved, write_path)
            saved.unlink()

    monkeypatch.setattr(
        visual_fixture.sqlite3, "connect", connect_after_swapping_stage
    )
    error = None
    try:
        record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    except BaseException as caught:
        error = caught
        record = None
    finally:
        monkeypatch.setattr(visual_fixture.sqlite3, "connect", real_connect)

    assert error is None
    assert attacked is False
    assert record is not None
    assert all(_sqlite_rw_path_argument(path) is None for path in opened_databases)
    assert _external_sqlite_guard_state(outside) == outside_before
    assert not any(
        Path(f"{outside}{suffix}").exists()
        for suffix in ("-journal", "-wal", "-shm")
    )


def test_visual_fixture_generation_preserves_concurrent_unowned_target(
    tmp_path, monkeypatch
):
    output = tmp_path / "generation-no-clobber-race"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    real_install = visual_fixture._install_no_clobber
    concurrent = output / "active.db"

    def install_after_concurrent_create(*args, **kwargs):
        concurrent.write_bytes(b"concurrent-unowned")
        return real_install(*args, **kwargs)

    monkeypatch.setattr(
        visual_fixture, "_install_no_clobber", install_after_concurrent_create
    )
    with pytest.raises(FileExistsError):
        visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)

    assert concurrent.read_bytes() == b"concurrent-unowned"
    assert {path.name for path in output.iterdir()} == {concurrent.name}


def test_visual_fixture_refresh_rejects_path_replaced_after_read_only_validation(
    tmp_path, monkeypatch
):
    output = tmp_path / "refresh-race"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    active = Path(record["database_paths"]["active"])
    outside = tmp_path / "outside-marked.db"
    shutil.copy2(active, outside)
    outside_before = outside.read_bytes()
    real_connect = visual_fixture.sqlite3.connect
    calls = 0
    opened_databases = []

    def swap_before_write_connect(database, *args, **kwargs):
        nonlocal calls
        calls += 1
        opened_databases.append(database)
        if calls == 1:
            active.unlink()
            active.symlink_to(outside)
        return real_connect(database, *args, **kwargs)

    monkeypatch.setattr(visual_fixture.sqlite3, "connect", swap_before_write_connect)
    with pytest.raises(ValueError):
        visual_fixture.refresh_fixture(
            active,
            now_factory=lambda: NOW + timedelta(minutes=1),
            receipt_id_factory=lambda: "must-not-be-written",
        )
    assert calls >= 1
    assert all(_sqlite_rw_path_argument(path) is None for path in opened_databases)
    assert active.is_symlink()
    assert outside.read_bytes() == outside_before
    assert not any(path.name.startswith(".agent-workbench-") for path in output.iterdir())


def test_visual_fixture_refresh_never_writes_temporary_symlink_target(
    tmp_path, monkeypatch
):
    output = tmp_path / "refresh-temporary-link"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    active = Path(record["database_paths"]["active"])
    outside = tmp_path / "outside-refresh.db"
    shutil.copy2(active, outside)
    outside_before = _external_sqlite_guard_state(outside)
    real_connect = visual_fixture.sqlite3.connect
    calls = 0
    opened_databases = []

    def connect_while_target_is_a_symlink(database, *args, **kwargs):
        nonlocal calls
        calls += 1
        opened_databases.append(database)
        saved = active.with_name(active.name + ".saved")
        os.link(active, saved)
        active.unlink()
        active.symlink_to(outside)
        try:
            return real_connect(database, *args, **kwargs)
        finally:
            active.unlink()
            os.link(saved, active)
            saved.unlink()

    monkeypatch.setattr(
        visual_fixture.sqlite3, "connect", connect_while_target_is_a_symlink
    )
    refreshed = visual_fixture.refresh_fixture(
        active,
        now_factory=lambda: NOW + timedelta(minutes=1),
        receipt_id_factory=lambda: "safe-staged-receipt",
    )
    monkeypatch.setattr(visual_fixture.sqlite3, "connect", real_connect)

    assert calls >= 1
    assert refreshed["new_receipt_id"] == "safe-staged-receipt"
    assert active.name not in {
        _sqlite_argument_basename(path) for path in opened_databases
    }
    assert _external_sqlite_guard_state(outside) == outside_before
    assert not any(
        Path(f"{active}{suffix}").exists()
        for suffix in ("-journal", "-wal", "-shm")
    )
    assert not any(path.name.startswith(".agent-workbench-") for path in output.iterdir())


def test_visual_fixture_refresh_never_opens_swappable_stage_path_for_write(
    tmp_path, monkeypatch
):
    output = tmp_path / "refresh-stage-swap"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    active = Path(record["database_paths"]["active"])
    outside = tmp_path / "outside-refresh-stage.db"
    shutil.copy2(active, outside)
    outside_connection = sqlite3.connect(outside)
    outside_connection.execute("CREATE TABLE external_guard(value TEXT)")
    outside_connection.execute("INSERT INTO external_guard VALUES ('preserve')")
    outside_connection.commit()
    outside_connection.close()
    outside_before = _external_sqlite_guard_state(outside)
    real_connect = visual_fixture.sqlite3.connect
    opened_databases = []
    attacked = False

    def connect_after_swapping_stage(path, *args, **kwargs):
        nonlocal attacked
        opened_databases.append(path)
        write_path = _sqlite_rw_path_argument(path)
        if write_path is None or attacked:
            return real_connect(path, *args, **kwargs)
        attacked = True
        saved = write_path.with_name(write_path.name + ".saved")
        os.link(write_path, saved)
        write_path.unlink()
        write_path.symlink_to(outside)
        try:
            return real_connect(path, *args, **kwargs)
        finally:
            write_path.unlink()
            os.link(saved, write_path)
            saved.unlink()

    monkeypatch.setattr(
        visual_fixture.sqlite3, "connect", connect_after_swapping_stage
    )
    error = None
    try:
        refreshed = visual_fixture.refresh_fixture(
            active,
            now_factory=lambda: NOW + timedelta(minutes=1),
            receipt_id_factory=lambda: "memory-refresh-receipt",
        )
    except BaseException as caught:
        error = caught
        refreshed = None
    finally:
        monkeypatch.setattr(visual_fixture.sqlite3, "connect", real_connect)

    assert error is None
    assert attacked is False
    assert refreshed is not None
    assert refreshed["new_receipt_id"] == "memory-refresh-receipt"
    assert all(_sqlite_rw_path_argument(path) is None for path in opened_databases)
    assert _external_sqlite_guard_state(outside) == outside_before
    assert not any(
        Path(f"{outside}{suffix}").exists()
        for suffix in ("-journal", "-wal", "-shm")
    )


@pytest.mark.parametrize("suffix", ("-journal", "-wal", "-shm"))
def test_visual_fixture_refresh_rejects_source_sqlite_sidecars(
    tmp_path, monkeypatch, suffix
):
    output = tmp_path / f"refresh-source-{suffix[1:]}"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    active = Path(record["database_paths"]["active"])
    active_before = active.read_bytes()
    sidecar = Path(f"{active}{suffix}")
    sidecar.write_bytes(b"must-not-be-ignored")

    with pytest.raises(ValueError, match="source database has an active SQLite sidecar"):
        visual_fixture.refresh_fixture(
            active,
            now_factory=lambda: NOW + timedelta(minutes=1),
            receipt_id_factory=lambda: "must-not-be-published",
        )

    assert active.read_bytes() == active_before
    assert sidecar.read_bytes() == b"must-not-be-ignored"
    assert not any(path.name.startswith(".agent-workbench-") for path in output.iterdir())


def test_visual_fixture_generation_checks_integrity_before_publish(
    tmp_path, monkeypatch
):
    output = tmp_path / "generation-integrity-check"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    real_new_database = visual_fixture._new_database

    class IntegrityFailureConnection:
        def __init__(self, connection):
            self._connection = connection

        def __getattr__(self, name):
            return getattr(self._connection, name)

        def execute(self, statement, *args, **kwargs):
            if statement.strip().upper() == "PRAGMA INTEGRITY_CHECK":
                return iter((("acceptance-injected corruption",),))
            return self._connection.execute(statement, *args, **kwargs)

    def new_database_with_failed_integrity(path, scenario):
        return IntegrityFailureConnection(real_new_database(path, scenario))

    monkeypatch.setattr(
        visual_fixture, "_new_database", new_database_with_failed_integrity
    )
    with pytest.raises(ValueError, match="integrity check failed"):
        visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    assert list(output.iterdir()) == []


def test_visual_fixture_generation_checks_foreign_keys_before_publish(
    tmp_path, monkeypatch
):
    output = tmp_path / "generation-foreign-key-check"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    real_new_database = visual_fixture._new_database
    real_active_seeder = visual_fixture.SEEDERS["active"]

    def new_database_without_enforcement(path, scenario):
        connection = real_new_database(path, scenario)
        connection.execute("PRAGMA foreign_keys=OFF")
        return connection

    def seed_with_foreign_key_violation(connection, generated_at):
        real_active_seeder(connection, generated_at)
        connection.execute("CREATE TABLE acceptance_parent(id INTEGER PRIMARY KEY)")
        connection.execute(
            "CREATE TABLE acceptance_child("
            "parent_id INTEGER REFERENCES acceptance_parent(id))"
        )
        connection.execute("INSERT INTO acceptance_child VALUES (404)")

    monkeypatch.setattr(
        visual_fixture, "_new_database", new_database_without_enforcement
    )
    monkeypatch.setitem(
        visual_fixture.SEEDERS, "active", seed_with_foreign_key_violation
    )
    with pytest.raises(ValueError, match="foreign key check failed"):
        visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    assert list(output.iterdir()) == []


def test_visual_fixture_refresh_checks_foreign_keys_before_publish(
    tmp_path, monkeypatch
):
    output = tmp_path / "refresh-foreign-key-check"
    output.mkdir()
    monkeypatch.setattr(
        visual_fixture.app_db,
        "DEFAULT_DB_PATH",
        tmp_path / "configured" / "seo.db",
    )
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: NOW)
    active = Path(record["database_paths"]["active"])
    connection = sqlite3.connect(active)
    connection.execute("PRAGMA foreign_keys=OFF")
    connection.execute("CREATE TABLE acceptance_parent(id INTEGER PRIMARY KEY)")
    connection.execute(
        "CREATE TABLE acceptance_child("
        "parent_id INTEGER REFERENCES acceptance_parent(id))"
    )
    connection.execute("INSERT INTO acceptance_child VALUES (404)")
    connection.commit()
    connection.close()
    active_before = active.read_bytes()

    with pytest.raises(ValueError, match="foreign key check failed"):
        visual_fixture.refresh_fixture(
            active,
            now_factory=lambda: NOW + timedelta(minutes=1),
            receipt_id_factory=lambda: "must-not-be-published",
        )

    assert active.read_bytes() == active_before
    assert not any(path.name.startswith(".agent-workbench-") for path in output.iterdir())


def test_visual_fixture_generation_output_is_canonical(tmp_path, monkeypatch):
    output = tmp_path / "fixtures"
    output.mkdir()
    frozen = datetime(2026, 9, 3, 16, 0, 30, tzinfo=timezone.utc)
    real_connect = visual_fixture.sqlite3.connect
    opened_databases = []

    def recording_connect(path, *args, **kwargs):
        opened_databases.append(path)
        return real_connect(path, *args, **kwargs)

    monkeypatch.setattr(visual_fixture.sqlite3, "connect", recording_connect)
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: frozen)
    monkeypatch.setattr(visual_fixture.sqlite3, "connect", real_connect)
    final_names = {f"{scenario}.db" for scenario in visual_fixture.SCENARIOS}
    assert record == {
        "database_paths": {
            scenario: str((output / f"{scenario}.db").absolute())
            for scenario in visual_fixture.SCENARIOS
        },
        "generated_at": "2026-09-03T16:00:30Z",
        "output_dir": str(output.absolute()),
        "schema_version": visual_fixture.GENERATION_SCHEMA,
    }
    assert visual_fixture._canonical(record) == json.dumps(
        record, sort_keys=True, separators=(",", ":")
    ) + "\n"
    assert not final_names & {
        _sqlite_argument_basename(path) for path in opened_databases
    }
    assert {path.name for path in output.iterdir()} == final_names


def _fixture_snapshot(database, now):
    monkey = pytest.MonkeyPatch()
    monkey.setenv("COREAI_BASE_URL", "http://127.0.0.1:9")
    monkey.setenv("COREAI_API_KEY", "fixture-key")
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        return agent_workbench.build_workbench_snapshot(
            connection, "30d", now, "Asia/Shanghai", 20
        )
    finally:
        connection.close()
        monkey.undo()


def test_visual_fixture_active_state(tmp_path):
    output = tmp_path / "active-fixtures"
    output.mkdir()
    frozen = datetime(2026, 9, 3, 16, 0, 30, tzinfo=timezone.utc)
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: frozen)
    database = record["database_paths"]["active"]
    snapshot = _fixture_snapshot(database, frozen)
    assert len(snapshot["agents"]) == 12
    active = [
        row for row in snapshot["signals"]
        if row["raw_status"] == "RUNNING" and row["fresh"] and not row["suspect"]
    ]
    assert len(active) == 3
    assert len({row["local_agent_id"] for row in active}) == 2
    assert snapshot["current_counts"]["running"]["value"] == 3
    assert any(len(agent["display_name"]) == 110 for agent in snapshot["agents"])
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    history = conn.execute(
        "SELECT effective_started_at FROM ("
        "SELECT COALESCE(started_at,first_seen_at) AS effective_started_at "
        "FROM seo_ops_agent_runs WHERE coreai_run_id LIKE 'preview-history-%')"
    ).fetchall()
    assert len(history) == 21
    archiving = conn.execute(
        "SELECT terminal_observed_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='preview-archiving'"
    ).fetchone()[0]
    assert archiving == frozen.isoformat()
    conn.close()


def test_visual_fixture_idle_partial_and_stale_states(tmp_path):
    output = tmp_path / "other-fixtures"
    output.mkdir()
    frozen = datetime(2026, 9, 3, 16, 0, 30, tzinfo=timezone.utc)
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: frozen)
    idle = _fixture_snapshot(record["database_paths"]["idle"], frozen)
    partial = _fixture_snapshot(record["database_paths"]["partial"], frozen)
    stale = _fixture_snapshot(record["database_paths"]["stale"], frozen)
    assert idle["sync_health"] == "fresh"
    assert idle["current_state_complete"] is True
    assert idle["has_active_runs"] is False
    assert idle["signals"] == []
    assert partial["sync_health"] == "partial"
    assert partial["current_state_complete"] is False
    assert partial["has_active_runs"] is None
    assert all(not row["fresh"] for row in partial["signals"])
    assert stale["sync_health"] == "stale"
    assert stale["stale"] is True
    assert all(not row["fresh"] for row in stale["signals"])


def test_visual_fixture_refresh_semantics(tmp_path):
    output = tmp_path / "refresh-fixtures"
    output.mkdir()
    frozen = datetime(2026, 9, 3, 16, 0, 30, tzinfo=timezone.utc)
    record = visual_fixture.generate_fixtures(output, now_factory=lambda: frozen)
    refreshed = frozen + timedelta(minutes=1)
    active = visual_fixture.refresh_fixture(
        record["database_paths"]["active"],
        now_factory=lambda: refreshed,
        receipt_id_factory=lambda: "preview-refresh-receipt",
    )
    assert active == {
        "new_receipt_id": "preview-refresh-receipt",
        "refreshed_at": "2026-09-03T16:01:30Z",
        "scenario": "active",
        "schema_version": visual_fixture.REFRESH_SCHEMA,
    }
    for scenario in ("idle", "partial"):
        result = visual_fixture.refresh_fixture(
            record["database_paths"][scenario], now_factory=lambda: refreshed
        )
        assert result["scenario"] == scenario
        assert result["new_receipt_id"] is None
    with pytest.raises(ValueError):
        visual_fixture.refresh_fixture(
            record["database_paths"]["stale"], now_factory=lambda: refreshed
        )


def test_privacy_inventory_allows_only_parser_discard_literals(tmp_path, monkeypatch):
    production = Path(agent_workbench.__file__)
    tree = ast.parse(production.read_text(encoding="utf-8"), filename=str(production))
    sensitive_literals = {"input", "output", "transcript", "artifacts", "error_stack"}
    occurrences = {
        value: [
            node.lineno
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and node.value == value
        ]
        for value in sensitive_literals
    }
    assignments = {
        target.id: node
        for node in tree.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    assert isinstance(assignments["TOKEN_USAGE_INPUT_FIELD"].value, ast.Constant)
    assert isinstance(assignments["TOKEN_USAGE_OUTPUT_FIELD"].value, ast.Constant)
    discard_elements = {
        element.value: element.lineno
        for element in assignments["DISCARDED_UPSTREAM_FIELDS"].value.args[0].elts
        if isinstance(element, ast.Constant)
    }
    assert occurrences == {
        "input": [assignments["TOKEN_USAGE_INPUT_FIELD"].value.lineno],
        "output": [assignments["TOKEN_USAGE_OUTPUT_FIELD"].value.lineno],
        "transcript": [discard_elements["transcript"]],
        "artifacts": [discard_elements["artifacts"]],
        "error_stack": [discard_elements["error_stack"]],
    }
    assert agent_workbench.DISCARDED_UPSTREAM_FIELDS == frozenset(sensitive_literals)
    source = production.read_text(encoding="utf-8")
    assert "token_usage.get(TOKEN_USAGE_INPUT_FIELD)" in source
    assert "token_usage.get(TOKEN_USAGE_OUTPUT_FIELD)" in source
    assert "if key not in DISCARDED_UPSTREAM_FIELDS" in source

    _, conn = _open_database(tmp_path, monkeypatch, "privacy.db")
    for table in (
        "seo_ops_agents",
        "seo_ops_agent_runs",
        "seo_ops_agent_sync_state",
    ):
        columns = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        assert not columns & sensitive_literals
    conn.close()

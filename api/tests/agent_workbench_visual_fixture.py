"""Generate disposable Agent Workbench databases for browser acceptance.

This module deliberately lives under ``tests``.  It is not imported by the
production application and it never contacts Core AI.  Its two entry points
are intentionally narrow:

* create four fresh, marked databases in an already-empty temporary directory;
* refresh only the proof clocks of a marked active/idle/partial database.

Successful CLI invocations print one canonical, allow-listed JSON record.
Failures print no database content, environment value, or upstream payload.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import stat
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Iterator
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import agent_workbench
from app import db as app_db


SCENARIOS = ("active", "idle", "partial", "stale")
REFRESHABLE_SCENARIOS = frozenset({"active", "idle", "partial"})
MARKER_TABLE = "agent_workbench_preview_fixture"
GENERATION_SCHEMA = "agent_workbench_visual_fixture_generation.v1"
REFRESH_SCHEMA = "agent_workbench_visual_fixture_refresh.v1"
LONG_DISPLAY_NAME = "Agent " + ("超长名称用于百分之二百缩放与表格换行验证" * 8)
LONG_DISPLAY_NAME = LONG_DISPLAY_NAME[:110]


@dataclass(frozen=True)
class _ValidatedRefreshTarget:
    path: Path
    scenario: str
    device: int
    inode: int


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("aware UTC time required")
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _aware_utc(value).isoformat()


def _wire_time(value: datetime) -> str:
    return _aware_utc(value).isoformat().replace("+00:00", "Z")


def _canonical(record: dict) -> str:
    return json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"


def _path_contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _default_database_directory() -> Path:
    return app_db.DEFAULT_DB_PATH.resolve().parent


def _reject_default_tree(path: Path) -> None:
    default_dir = _default_database_directory()
    if (
        path == default_dir
        or _path_contains(path, default_dir)
        or _path_contains(default_dir, path)
    ):
        raise ValueError("fixture path overlaps configured database tree")


def _validate_owned_directory(path: Path) -> os.stat_result:
    try:
        entry = os.lstat(path)
    except OSError:
        raise ValueError("output path must be a directory") from None
    if not stat.S_ISDIR(entry.st_mode) or stat.S_ISLNK(entry.st_mode):
        raise ValueError("output path must be a non-symlink directory")
    if entry.st_uid != os.geteuid() or entry.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        raise ValueError("output directory must be owned and write-guarded")
    return entry


def _single_link_regular_file(path: Path) -> os.stat_result:
    try:
        entry = os.lstat(path)
    except OSError:
        raise ValueError("fixture database is missing") from None
    if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
        raise ValueError("fixture database must be a single-link regular file")
    return entry


def validate_generation_directory(raw_path: str | os.PathLike[str]) -> Path:
    path = Path(raw_path).expanduser().absolute()
    _validate_owned_directory(path)
    canonical = path.resolve(strict=True)
    _reject_default_tree(canonical)
    if any(canonical.iterdir()):
        raise ValueError("output directory must be empty")
    return canonical


@contextmanager
def _database_environment(path: Path) -> Iterator[None]:
    previous = os.environ.get("SEO_OPS_DB")
    os.environ["SEO_OPS_DB"] = str(path)
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("SEO_OPS_DB", None)
        else:
            os.environ["SEO_OPS_DB"] = previous


def _new_database(path: Path, scenario: str) -> sqlite3.Connection:
    expected = _single_link_regular_file(path)
    with _database_environment(path):
        app_db.init_db()
    initialized = _single_link_regular_file(path)
    if (initialized.st_dev, initialized.st_ino) != (expected.st_dev, expected.st_ino):
        raise ValueError("fixture database changed during initialization")
    conn = sqlite3.connect(f"file:{path}?mode=rw", uri=True)
    opened = _single_link_regular_file(path)
    if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
        conn.close()
        raise ValueError("fixture database changed before SQLite open")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute(
        f"CREATE TABLE {MARKER_TABLE} ("
        "scenario TEXT PRIMARY KEY NOT NULL, "
        "created_at TEXT NOT NULL, "
        "marker_version TEXT NOT NULL CHECK (marker_version='v1'))"
    )
    return conn


def _insert_agent(
    conn: sqlite3.Connection,
    *,
    local_id: str,
    core_id: str,
    key: str,
    name: str,
    role: str,
    order: int,
    lifecycle: str,
    now: datetime,
    sync_pending: bool = False,
    complete: bool = True,
    counts: tuple[int | None, int | None, int | None] = (0, 0, 0),
    qualities: tuple[str, str, str] = ("exact", "exact", "exact"),
    remote_total: int | None = 0,
    returned_count: int | None = 0,
    history_epoch: int = 0,
    proven_epoch: int | None = 0,
    discovery_error: str | None = None,
    current_error: str | None = None,
    proof_at: datetime | None = None,
    coverage_start_at: datetime | None = None,
    finite_range_start_at: datetime | None = None,
) -> None:
    proof = proof_at or now
    stamp = _iso(now)
    proof_stamp = _iso(proof)
    retired_at = stamp if lifecycle == "retired" else None
    conn.execute(
        "INSERT INTO seo_ops_agents ("
        "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
        "coreai_name,coreai_model,coreai_timeout_hint_seconds,"
        "suspect_after_seconds,last_verification_attempt_at,last_verified_at,"
        "verification_failure_count,next_verification_at,retired_at,created_at,updated_at"
        ") VALUES (?,?,?,?,?,?,?,?,?,900,1800,?,?,0,?,?,?,?)",
        (
            local_id,
            key,
            core_id,
            name,
            role,
            order,
            lifecycle,
            f"Core {name}",
            "acceptance-model",
            proof_stamp,
            proof_stamp,
            _iso(proof + timedelta(days=1)),
            retired_at,
            stamp,
            stamp,
        ),
    )
    pending, running, paused = counts
    pending_quality, running_quality, paused_quality = qualities
    conn.execute(
        "INSERT INTO seo_ops_agent_sync_state ("
        "seo_ops_agent_id,remote_total_runs,last_discovery_attempt_at,"
        "last_discovery_success_at,last_discovery_error,last_discovery_returned_count,"
        "coverage_start_at,finite_range_proven_start_at,current_state_checked_at,"
        "pending_observed_count,pending_upstream_total,pending_last_observed_at,"
        "pending_set_quality,running_observed_count,running_upstream_total,"
        "running_last_observed_at,running_set_quality,paused_observed_count,"
        "paused_upstream_total,paused_last_observed_at,paused_set_quality,"
        "unresolved_unknown_status_count,current_state_complete,current_state_error,"
        "sync_pending,local_event_epoch,history_event_epoch,unfiltered_proven_event_epoch,"
        "projection_revision,next_discovery_at,last_fast_poll_attempt_at,"
        "last_fast_poll_success_at,next_fast_poll_at"
        ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            local_id,
            remote_total,
            proof_stamp,
            proof_stamp,
            discovery_error,
            returned_count,
            _iso(coverage_start_at) if coverage_start_at else proof_stamp,
            _iso(finite_range_start_at) if finite_range_start_at else proof_stamp,
            proof_stamp,
            pending,
            pending,
            proof_stamp if pending is not None else None,
            pending_quality,
            running,
            running,
            proof_stamp if running is not None else None,
            running_quality,
            paused,
            paused,
            proof_stamp if paused is not None else None,
            paused_quality,
            0,
            int(complete),
            current_error,
            int(sync_pending),
            0,
            history_epoch,
            proven_epoch,
            0,
            _iso(proof + timedelta(seconds=30)),
            proof_stamp,
            proof_stamp,
            _iso(proof + timedelta(seconds=5)),
        ),
    )


def _insert_run(
    conn: sqlite3.Connection,
    *,
    run_id: str,
    agent_id: str,
    status: str | None,
    first_seen: datetime,
    started: datetime | None = None,
    completed: datetime | None = None,
    terminal_observed: datetime | None = None,
    receipt_expires: datetime | None = None,
    input_tokens: int | None = None,
    output_tokens: int | None = None,
    trigger_type: str | None = "WORKFLOW",
    last_synced: datetime | None = None,
    source_kind: str | None = None,
    source_local_id: int | None = None,
    merchant_id: int | None = None,
    warnings: tuple[str, ...] = (),
) -> None:
    conn.execute(
        "INSERT INTO seo_ops_agent_runs ("
        "coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,started_at,completed_at,"
        "terminal_observed_at,receipt_expires_at,input_tokens,output_tokens,trace_id,"
        "error_summary,source_kind,source_local_id,merchant_id,first_seen_at,"
        "last_poll_attempt_at,last_synced_at,last_poll_error,data_warning_codes_json"
        ") VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,NULL,?)",
        (
            run_id,
            agent_id,
            status,
            trigger_type if status is not None else None,
            _iso(started) if started else None,
            _iso(completed) if completed else None,
            _iso(terminal_observed) if terminal_observed else None,
            _iso(receipt_expires) if receipt_expires else None,
            input_tokens,
            output_tokens,
            source_kind,
            source_local_id,
            merchant_id,
            _iso(first_seen),
            _iso(last_synced) if last_synced else None,
            _iso(last_synced) if last_synced else None,
            json.dumps(sorted(set(warnings)), separators=(",", ":")),
        ),
    )


def _seed_active(conn: sqlite3.Connection, now: datetime) -> None:
    today_start, _ = agent_workbench._range_bounds("today", now, "Asia/Shanghai")
    ids = [f"00000000-0000-4000-8000-{index:012d}" for index in range(1, 13)]
    specs = [
        ("execution", "执行 Agent", "active"),
        ("keyword", "关键词 Agent", "active"),
        ("review", "审核 Agent", "active"),
        ("history", "历史分页 Agent", "active"),
        ("long", LONG_DISPLAY_NAME, "active"),
        ("incomplete", "覆盖待确认 Agent", "disabled"),
        ("unknown", "未知状态 Agent", "disabled"),
        ("retired", "已退役 Agent", "retired"),
        ("content", "内容 Agent", "disabled"),
        ("rank", "排名 Agent", "disabled"),
        ("audit", "审计 Agent", "disabled"),
        ("spare", "备用 Agent", "retired"),
    ]
    run_totals = {0: 4, 1: 1, 3: 21, 5: 1, 6: 1}
    for index, (key, name, lifecycle) in enumerate(specs):
        if index == 0:
            counts = (1, 2, 1)
        elif index == 1:
            counts = (0, 1, 0)
        else:
            counts = (0, 0, 0)
        total = run_totals.get(index, 0)
        _insert_agent(
            conn,
            local_id=ids[index],
            core_id=f"preview-agent-{key}",
            key=f"preview-{key}",
            name=name,
            role=f"{name} 的验收职责",
            order=(index + 1) * 10,
            lifecycle=lifecycle,
            now=now,
            counts=counts,
            remote_total=total,
            returned_count=total,
            history_epoch=total,
            proven_epoch=total,
            coverage_start_at=today_start,
            finite_range_start_at=today_start,
        )

    # Three motion-eligible RUNNING rows across two active owners.
    for suffix, owner, offset in (
        ("one", ids[0], 7),
        ("two", ids[0], 6),
        ("three", ids[1], 5),
    ):
        _insert_run(
            conn,
            run_id=f"preview-running-{suffix}",
            agent_id=owner,
            status="RUNNING",
            first_seen=now - timedelta(seconds=offset),
            started=now - timedelta(seconds=offset),
            last_synced=now,
        )

    _insert_run(
        conn,
        run_id="preview-pending",
        agent_id=ids[0],
        status="PENDING",
        first_seen=now - timedelta(seconds=4),
        started=now - timedelta(seconds=4),
        last_synced=now,
    )
    _insert_run(
        conn,
        run_id="preview-paused",
        agent_id=ids[0],
        status="PAUSED",
        first_seen=now - timedelta(seconds=3),
        started=now - timedelta(seconds=3),
        last_synced=now,
    )

    # One factual terminal observation whose local source is still running.
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES (?,?)",
        ("Preview Merchant", _iso(now)),
    ).lastrowid
    source_id = conn.execute(
        "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
        "VALUES (?,?,'running','manual',?)",
        (merchant_id, "preview-archiving", _iso(now - timedelta(seconds=12))),
    ).lastrowid
    _insert_run(
        conn,
        run_id="preview-archiving",
        agent_id=ids[0],
        status="COMPLETED",
        first_seen=now - timedelta(seconds=12),
        started=now - timedelta(seconds=12),
        completed=now,
        terminal_observed=now,
        input_tokens=3,
        output_tokens=5,
        last_synced=now,
        source_kind="run",
        source_local_id=source_id,
        merchant_id=merchant_id,
    )

    # Unknown future status is isolated under a disabled owner and stays static.
    _insert_run(
        conn,
        run_id="preview-unknown",
        agent_id=ids[6],
        status="AWAITING_REVIEW",
        first_seen=now - timedelta(seconds=2),
        started=now - timedelta(seconds=2),
        last_synced=now,
        warnings=("UNKNOWN_STATUS",),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET unresolved_unknown_status_count=1 "
        "WHERE seo_ops_agent_id=?",
        (ids[6],),
    )

    # Incomplete history coverage with a lower-bound total.
    _insert_run(
        conn,
        run_id="preview-incomplete-history",
        agent_id=ids[5],
        status="COMPLETED",
        first_seen=now - timedelta(hours=2),
        started=now - timedelta(hours=2),
        completed=now - timedelta(hours=1),
        terminal_observed=now - timedelta(hours=1),
        input_tokens=1,
        output_tokens=2,
        last_synced=now,
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=2,"
        "last_discovery_returned_count=1,history_event_epoch=2,"
        "unfiltered_proven_event_epoch=1 WHERE seo_ops_agent_id=?",
        (ids[5],),
    )

    # Twenty-one expired terminal rows at the inclusive local-day boundary.
    for index in range(1, 22):
        _insert_run(
            conn,
            run_id=f"preview-history-{index:02d}",
            agent_id=ids[3],
            status="COMPLETED",
            first_seen=today_start,
            started=today_start,
            completed=today_start,
            terminal_observed=today_start,
            receipt_expires=today_start + timedelta(seconds=10),
            input_tokens=index,
            output_tokens=index + 1,
            last_synced=today_start,
        )

    # Initial short receipt. Refresh always inserts a distinct one.
    _insert_run(
        conn,
        run_id="preview-receipt-initial",
        agent_id=ids[2],
        status="COMPLETED",
        first_seen=now - timedelta(seconds=2),
        started=now - timedelta(seconds=2),
        completed=now,
        terminal_observed=now,
        receipt_expires=now + timedelta(seconds=10),
        input_tokens=0,
        output_tokens=0,
        last_synced=now,
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=1,"
        "last_discovery_returned_count=1,history_event_epoch=1,"
        "unfiltered_proven_event_epoch=1 WHERE seo_ops_agent_id=?",
        (ids[2],),
    )


def _seed_idle(conn: sqlite3.Connection, now: datetime) -> None:
    local_id = "10000000-0000-4000-8000-000000000001"
    _insert_agent(
        conn,
        local_id=local_id,
        core_id="preview-idle-agent",
        key="preview-idle",
        name="空闲验收 Agent",
        role="证明精确且新鲜的空闲状态",
        order=10,
        lifecycle="active",
        now=now,
        remote_total=1,
        returned_count=1,
        history_epoch=1,
        proven_epoch=1,
    )
    terminal_at = now - timedelta(hours=1)
    _insert_run(
        conn,
        run_id="preview-idle-terminal",
        agent_id=local_id,
        status="COMPLETED",
        first_seen=terminal_at,
        started=terminal_at,
        completed=terminal_at + timedelta(seconds=30),
        terminal_observed=terminal_at + timedelta(seconds=30),
        input_tokens=7,
        output_tokens=11,
        last_synced=terminal_at + timedelta(seconds=30),
    )


def _seed_partial(conn: sqlite3.Connection, now: datetime) -> None:
    specs = (
        ("healthy", LONG_DISPLAY_NAME, (0, 0, 0), ("exact", "exact", "exact"), None),
        ("lower", "下界证明 Agent", (0, 1, 0), ("exact", "lower_bound", "exact"), None),
        ("failed", "失败页 Agent", (0, 1, 0), ("exact", "exact", "exact"), "RUN_LIST_HTTP_ERROR"),
        ("never", "尚未确认 Agent", (None, None, None), ("unknown", "unknown", "unknown"), "尚无成功确认"),
    )
    for index, (key, name, counts, qualities, error) in enumerate(specs):
        _insert_agent(
            conn,
            local_id=f"20000000-0000-4000-8000-{index + 1:012d}",
            core_id=f"preview-partial-{key}",
            key=f"preview-partial-{key}",
            name=name,
            role="局部证明验收",
            order=(index + 1) * 10,
            lifecycle="active",
            now=now,
            complete=key == "healthy",
            counts=counts,
            qualities=qualities,
            remote_total=None if key == "never" else (1 if key in {"lower", "failed"} else 0),
            returned_count=None if key == "never" else (1 if key in {"lower", "failed"} else 0),
            discovery_error=error if key == "failed" else None,
            current_error=error,
        )
    for key, index in (("lower", 2), ("failed", 3)):
        _insert_run(
            conn,
            run_id=f"preview-partial-{key}-running",
            agent_id=f"20000000-0000-4000-8000-{index:012d}",
            status="RUNNING",
            first_seen=now - timedelta(seconds=8),
            started=now - timedelta(seconds=8),
            last_synced=now - timedelta(seconds=2),
        )


def _seed_stale(conn: sqlite3.Connection, now: datetime) -> None:
    proof = now - timedelta(minutes=10)
    local_id = "30000000-0000-4000-8000-000000000001"
    _insert_agent(
        conn,
        local_id=local_id,
        core_id="preview-stale-agent",
        key="preview-stale",
        name="过期缓存 Agent",
        role="证明过期信号仍可见但静止",
        order=10,
        lifecycle="active",
        now=now,
        proof_at=proof,
        counts=(1, 1, 1),
        remote_total=3,
        returned_count=3,
        history_epoch=3,
        proven_epoch=3,
    )
    for status in ("RUNNING", "PENDING", "PAUSED"):
        _insert_run(
            conn,
            run_id=f"preview-stale-{status.lower()}",
            agent_id=local_id,
            status=status,
            first_seen=proof - timedelta(minutes=1),
            started=proof - timedelta(minutes=1),
            last_synced=proof,
        )


SEEDERS = {
    "active": _seed_active,
    "idle": _seed_idle,
    "partial": _seed_partial,
    "stale": _seed_stale,
}


def _open_generation_directory(directory: Path) -> int:
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        raise ValueError("output directory cannot be opened safely") from None
    try:
        opened = os.fstat(descriptor)
        current = _validate_owned_directory(directory)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
            or os.listdir(descriptor)
        ):
            raise ValueError("output directory changed or is not empty")
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def _create_database_placeholder(directory_fd: int, name: str) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, 0o600, dir_fd=directory_fd)
    except OSError:
        raise ValueError("fixture database already exists") from None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise ValueError("fixture database placeholder is unsafe")
    finally:
        os.close(descriptor)


def _unlink_fixture_files(directory_fd: int, database_names: list[str]) -> None:
    for name in database_names:
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.unlink(name + suffix, dir_fd=directory_fd)
            except FileNotFoundError:
                pass


def generate_fixtures(
    output_dir: str | os.PathLike[str],
    *,
    now_factory: Callable[[], datetime] = utc_now,
) -> dict:
    directory = validate_generation_directory(output_dir)
    generated_at = _aware_utc(now_factory())
    directory_fd = _open_generation_directory(directory)
    paths: dict[str, str] = {}
    created_names: list[str] = []
    try:
        for scenario in SCENARIOS:
            name = f"{scenario}.db"
            path = directory / name
            # Register the exact directory entry before creation so every
            # partial base file and SQLite sidecar is removed on failure.
            created_names.append(name)
            _create_database_placeholder(directory_fd, name)
            conn = _new_database(path, scenario)
            try:
                conn.execute(
                    f"INSERT INTO {MARKER_TABLE} (scenario,created_at,marker_version) "
                    "VALUES (?,?,'v1')",
                    (scenario, _iso(generated_at)),
                )
                SEEDERS[scenario](conn, generated_at)
                conn.commit()
            finally:
                conn.close()
            paths[scenario] = str(path)
    except BaseException:
        _unlink_fixture_files(directory_fd, created_names)
        raise
    finally:
        os.close(directory_fd)
    return {
        "database_paths": paths,
        "generated_at": _wire_time(generated_at),
        "output_dir": str(directory),
        "schema_version": GENERATION_SCHEMA,
    }


def _read_marker(conn: sqlite3.Connection) -> tuple[str, str]:
    table = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (MARKER_TABLE,)
    ).fetchone()
    if table is None:
        raise ValueError("unmarked fixture database")
    rows = conn.execute(
        f"SELECT scenario,marker_version FROM {MARKER_TABLE}"
    ).fetchall()
    if len(rows) != 1 or rows[0]["marker_version"] != "v1":
        raise ValueError("invalid fixture marker")
    return str(rows[0]["scenario"]), str(rows[0]["marker_version"])


def _require_refresh_identity(target: _ValidatedRefreshTarget) -> None:
    current = _single_link_regular_file(target.path)
    if (current.st_dev, current.st_ino) != (target.device, target.inode):
        raise ValueError("fixture database changed after validation")


def _validated_refresh_target(
    raw_path: str | os.PathLike[str],
) -> _ValidatedRefreshTarget:
    path = Path(raw_path).expanduser().absolute()
    expected = _single_link_regular_file(path)
    canonical = path.resolve(strict=True)
    _reject_default_tree(canonical.parent)
    conn = sqlite3.connect(f"file:{canonical}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        opened = _single_link_regular_file(canonical)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError("fixture database changed before refresh")
        scenario, _version = _read_marker(conn)
        reopened = _single_link_regular_file(canonical)
        if (reopened.st_dev, reopened.st_ino) != (expected.st_dev, expected.st_ino):
            raise ValueError("fixture database changed during validation")
    finally:
        conn.close()
    if scenario not in REFRESHABLE_SCENARIOS:
        raise ValueError("fixture scenario cannot be refreshed")
    if path.name != f"{scenario}.db":
        raise ValueError("fixture marker does not match filename")
    return _ValidatedRefreshTarget(
        path=canonical,
        scenario=scenario,
        device=expected.st_dev,
        inode=expected.st_ino,
    )


def validate_refresh_database(raw_path: str | os.PathLike[str]) -> tuple[Path, str]:
    target = _validated_refresh_target(raw_path)
    return target.path, target.scenario


def _refresh_common_agent_proof(
    conn: sqlite3.Connection, local_id: str, refreshed_at: datetime
) -> None:
    stamp = _iso(refreshed_at)
    conn.execute(
        "UPDATE seo_ops_agents SET last_verification_attempt_at=?,last_verified_at=?,"
        "next_verification_at=? WHERE id=?",
        (stamp, stamp, _iso(refreshed_at + timedelta(days=1)), local_id),
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET last_discovery_attempt_at=?,"
        "last_discovery_success_at=?,current_state_checked_at=?,"
        "pending_last_observed_at=CASE WHEN pending_observed_count IS NULL THEN NULL ELSE ? END,"
        "running_last_observed_at=CASE WHEN running_observed_count IS NULL THEN NULL ELSE ? END,"
        "paused_last_observed_at=CASE WHEN paused_observed_count IS NULL THEN NULL ELSE ? END,"
        "last_fast_poll_attempt_at=?,last_fast_poll_success_at=?,"
        "next_discovery_at=?,next_fast_poll_at=? WHERE seo_ops_agent_id=?",
        (
            stamp,
            stamp,
            stamp,
            stamp,
            stamp,
            stamp,
            stamp,
            stamp,
            _iso(refreshed_at + timedelta(seconds=30)),
            _iso(refreshed_at + timedelta(seconds=5)),
            local_id,
        ),
    )


def _refresh_active(
    conn: sqlite3.Connection,
    refreshed_at: datetime,
    receipt_id_factory: Callable[[], str],
) -> str:
    for row in conn.execute(
        "SELECT id FROM seo_ops_agents WHERE status='active'"
    ).fetchall():
        _refresh_common_agent_proof(conn, row["id"], refreshed_at)
    running_ids = [
        row["coreai_run_id"]
        for row in conn.execute(
            "SELECT coreai_run_id FROM seo_ops_agent_runs WHERE raw_status='RUNNING'"
        )
    ]
    stamp = _iso(refreshed_at)
    if running_ids:
        placeholders = ",".join("?" for _ in running_ids)
        conn.execute(
            f"UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,last_synced_at=? "
            f"WHERE coreai_run_id IN ({placeholders})",
            (stamp, stamp, *running_ids),
        )
    new_id = receipt_id_factory().strip()
    if not new_id or len(new_id) > 200:
        raise ValueError("invalid preview receipt id")
    if conn.execute(
        "SELECT 1 FROM seo_ops_agent_runs WHERE coreai_run_id=?", (new_id,)
    ).fetchone():
        raise ValueError("preview receipt id is not unique")
    owner = conn.execute(
        "SELECT id FROM seo_ops_agents WHERE agent_key='preview-review'"
    ).fetchone()
    if owner is None:
        raise ValueError("active fixture is incomplete")
    _insert_run(
        conn,
        run_id=new_id,
        agent_id=owner["id"],
        status="COMPLETED",
        first_seen=refreshed_at,
        started=refreshed_at,
        completed=refreshed_at,
        terminal_observed=refreshed_at,
        receipt_expires=refreshed_at + timedelta(seconds=10),
        input_tokens=0,
        output_tokens=0,
        last_synced=refreshed_at,
    )
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET remote_total_runs=remote_total_runs+1,"
        "last_discovery_returned_count=last_discovery_returned_count+1,"
        "history_event_epoch=history_event_epoch+1,"
        "unfiltered_proven_event_epoch=history_event_epoch+1,"
        "projection_revision=projection_revision+1 WHERE seo_ops_agent_id=?",
        (owner["id"],),
    )
    return new_id


def _refresh_idle(conn: sqlite3.Connection, refreshed_at: datetime) -> None:
    for row in conn.execute("SELECT id FROM seo_ops_agents WHERE status='active'"):
        _refresh_common_agent_proof(conn, row["id"], refreshed_at)


def _refresh_partial(conn: sqlite3.Connection, refreshed_at: datetime) -> None:
    stamp = _iso(refreshed_at)
    for row in conn.execute("SELECT id FROM seo_ops_agents WHERE status='active'"):
        _refresh_common_agent_proof(conn, row["id"], refreshed_at)
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET last_discovery_error='RUN_LIST_HTTP_ERROR',"
        "current_state_error='RUN_LIST_HTTP_ERROR' WHERE seo_ops_agent_id=("
        "SELECT id FROM seo_ops_agents WHERE agent_key='preview-partial-failed')"
    )
    conn.execute(
        "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,last_synced_at=? "
        "WHERE coreai_run_id LIKE 'preview-partial-%-running'",
        (stamp, stamp),
    )


def refresh_fixture(
    database_path: str | os.PathLike[str],
    *,
    now_factory: Callable[[], datetime] = utc_now,
    receipt_id_factory: Callable[[], str] = lambda: f"preview-receipt-{uuid.uuid4()}",
) -> dict:
    target = _validated_refresh_target(database_path)
    path, scenario = target.path, target.scenario
    refreshed_at = _aware_utc(now_factory())
    conn = sqlite3.connect(f"file:{path}?mode=rw", uri=True)
    new_receipt_id = None
    try:
        _require_refresh_identity(target)
        conn.row_factory = sqlite3.Row
        if _read_marker(conn) != (scenario, "v1"):
            raise ValueError("fixture marker changed before refresh")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("BEGIN IMMEDIATE")
        _require_refresh_identity(target)
        if _read_marker(conn) != (scenario, "v1"):
            raise ValueError("fixture marker changed during refresh")
        if scenario == "active":
            new_receipt_id = _refresh_active(conn, refreshed_at, receipt_id_factory)
        elif scenario == "idle":
            _refresh_idle(conn, refreshed_at)
        elif scenario == "partial":
            _refresh_partial(conn, refreshed_at)
        else:  # defensive; validate_refresh_database already rejects this.
            raise ValueError("fixture scenario cannot be refreshed")
        _require_refresh_identity(target)
        conn.commit()
        _require_refresh_identity(target)
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.close()
    return {
        "new_receipt_id": new_receipt_id,
        "refreshed_at": _wire_time(refreshed_at),
        "scenario": scenario,
        "schema_version": REFRESH_SCHEMA,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent Workbench visual fixtures")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--output-dir")
    group.add_argument("--refresh-scenario")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        record = (
            generate_fixtures(args.output_dir)
            if args.output_dir is not None
            else refresh_fixture(args.refresh_scenario)
        )
    except (OSError, sqlite3.Error, ValueError):
        print("FIXTURE_REJECTED", file=sys.stderr)
        return 2
    sys.stdout.write(_canonical(record))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

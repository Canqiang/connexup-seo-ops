"""Acceptance-only ASGI applications for Agent Workbench release gates.

``app`` retains production route/auth/bootstrap parity while parking the two
ordinary schedulers and running the real Workbench proof loop.  The separate
``restart_probe_app`` is guarded to a marker-owned temporary SQLite database;
its read phase opens only request-owned, independently defended read-only
connections.

The module deliberately constructs neither FastAPI application at import time.
Uvicorn reaches the lazy ASGI wrappers only after its environment is complete,
which also makes importing this module filesystem/DB-I/O free.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import stat
from pathlib import Path
from typing import Awaitable, Callable
from urllib.parse import quote


RESTART_PHASE_ENV = "AGENT_WORKBENCH_RESTART_PHASE"
RESTART_MARKER_ENV = "AGENT_WORKBENCH_RESTART_MARKER"
RESTART_MARKER_NAME = ".agent-workbench-restart-owned"
RESTART_LOCAL_AGENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
RESTART_CORE_AGENT_ID = "agent-workbench-restart-agent"
RESTART_RUN_ID = "agent-workbench-restart-run"
RESTART_OBSERVED_AT = "2026-09-03T04:00:00+00:00"
RESTART_RECEIPT_EXPIRES_AT = "2026-09-03T04:00:10+00:00"
RESTART_INPUT_TOKENS = 7
RESTART_OUTPUT_TOKENS = 11


class Task7RequiredError(RuntimeError):
    """Raised when this acceptance helper is run before Task 7 is integrated."""


async def _park_forever() -> None:
    waiter = asyncio.Event()
    try:
        await waiter.wait()
    except asyncio.CancelledError:
        raise


async def parked_scheduler_loop() -> None:
    """Cancellation-aware replacement for the ordinary SEO scheduler."""

    await _park_forever()


async def parked_fbr_scheduler_loop() -> None:
    """Cancellation-aware replacement for the Local Falcon scheduler."""

    await _park_forever()


async def parked_restart_workbench_loop() -> None:
    """Cancellation-aware replacement used only by restart persistence proof."""

    await _park_forever()


def _task7_main():
    from app import main

    required = (
        "initialize_writable_application",
        "create_lifespan",
        "create_app",
    )
    if not all(callable(getattr(main, name, None)) for name in required):
        raise Task7RequiredError("Task 7 application factory is not integrated")
    return main


def build_live_app(
    *,
    startup_callable: Callable[[], None] | None = None,
    scheduler_coro: Callable[[], Awaitable[None]] = parked_scheduler_loop,
    fbr_scheduler_coro: Callable[[], Awaitable[None]] = parked_fbr_scheduler_loop,
    workbench_coro: Callable[[], Awaitable[None]] | None = None,
):
    """Build the scheduler-parked live gate from Task 7's real factories."""

    main = _task7_main()
    from app.agent_workbench import agent_workbench_sync_loop

    lifespan = main.create_lifespan(
        startup_callable or main.initialize_writable_application,
        scheduler_coro,
        fbr_scheduler_coro,
        workbench_coro or agent_workbench_sync_loop,
    )
    return main.create_app(lifespan)


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
    except ValueError:
        return False
    return True


def _single_link_regular_file(path: Path, label: str) -> os.stat_result:
    """Validate an exact directory entry without following links."""

    try:
        entry = os.lstat(path)
    except OSError:
        raise RuntimeError(f"{label} is missing") from None
    if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1:
        raise RuntimeError(f"{label} is not a single-link regular file")
    return entry


def _read_restart_marker(marker: Path) -> str:
    before = _single_link_regular_file(marker, "restart database marker")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(marker, flags)
    except OSError:
        raise RuntimeError("restart database marker is unreadable") from None
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
        ):
            raise RuntimeError("restart database marker changed during validation")
        with os.fdopen(descriptor, encoding="utf-8") as handle:
            descriptor = -1
            return handle.read().strip()
    except (OSError, UnicodeError):
        raise RuntimeError("restart database marker is unreadable") from None
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def validate_restart_database(*, must_exist: bool) -> Path:
    """Return the marked disposable DB path for one explicit lifecycle phase."""

    from app.db import DEFAULT_DB_PATH, db_path

    database = Path(db_path()).expanduser().absolute()
    parent = database.parent.resolve(strict=True)
    database = parent / database.name
    default_tree = DEFAULT_DB_PATH.resolve().parent
    if (
        parent == default_tree
        or _contains(parent, default_tree)
        or _contains(default_tree, parent)
    ):
        raise RuntimeError("restart database overlaps configured database tree")
    marker_value = os.environ.get(RESTART_MARKER_ENV, "").strip()
    marker = (
        Path(marker_value).expanduser().absolute()
        if marker_value
        else parent / RESTART_MARKER_NAME
    )
    try:
        marker_parent = marker.parent.resolve(strict=True)
    except OSError:
        raise RuntimeError("restart database marker is missing") from None
    if marker_parent != parent:
        raise RuntimeError("restart database marker is missing")
    marked_name = _read_restart_marker(marker)
    if marked_name != database.name:
        raise RuntimeError("restart database marker mismatch")
    if must_exist:
        _single_link_regular_file(database, "restart database")
    elif os.path.lexists(database):
        raise RuntimeError("restart database already exists")
    return database


def _write_action_codes() -> frozenset[int]:
    names = (
        "SQLITE_INSERT",
        "SQLITE_UPDATE",
        "SQLITE_DELETE",
        "SQLITE_CREATE_INDEX",
        "SQLITE_CREATE_TABLE",
        "SQLITE_CREATE_TEMP_INDEX",
        "SQLITE_CREATE_TEMP_TABLE",
        "SQLITE_CREATE_TEMP_TRIGGER",
        "SQLITE_CREATE_TEMP_VIEW",
        "SQLITE_CREATE_TRIGGER",
        "SQLITE_CREATE_VIEW",
        "SQLITE_DROP_INDEX",
        "SQLITE_DROP_TABLE",
        "SQLITE_DROP_TEMP_INDEX",
        "SQLITE_DROP_TEMP_TABLE",
        "SQLITE_DROP_TEMP_TRIGGER",
        "SQLITE_DROP_TEMP_VIEW",
        "SQLITE_DROP_TRIGGER",
        "SQLITE_DROP_VIEW",
        "SQLITE_ALTER_TABLE",
        "SQLITE_REINDEX",
        "SQLITE_ANALYZE",
        "SQLITE_CREATE_VTABLE",
        "SQLITE_DROP_VTABLE",
        "SQLITE_ATTACH",
        "SQLITE_DETACH",
    )
    return frozenset(
        value for name in names if isinstance((value := getattr(sqlite3, name, None)), int)
    )


WRITE_ACTION_CODES = _write_action_codes()


def restart_write_denial_authorizer(
    action_code: int,
    first_argument: str | None,
    second_argument: str | None,
    _database_name: str | None,
    _trigger_name: str | None,
) -> int:
    """Deny writes and every PRAGMA except reading query_only itself."""

    if action_code in WRITE_ACTION_CODES:
        return sqlite3.SQLITE_DENY
    if action_code == sqlite3.SQLITE_PRAGMA:
        if (
            isinstance(first_argument, str)
            and first_argument.casefold() == "query_only"
            and second_argument is None
        ):
            return sqlite3.SQLITE_OK
        return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK


def open_restart_read_connection(
    database_path: str | os.PathLike[str],
    *,
    connection_factory: Callable[..., sqlite3.Connection] = sqlite3.connect,
) -> sqlite3.Connection:
    """Open one request-owned connection with three independent write guards."""

    database = Path(database_path).expanduser().absolute()
    uri = f"file:{quote(str(database), safe='/')}?mode=ro"
    try:
        connection = connection_factory(uri, uri=True, check_same_thread=False)
        connection.row_factory = sqlite3.Row
        # Install query_only before the authorizer so the helper itself is the
        # sole permitted PRAGMA assignment on this connection.
        connection.execute("PRAGMA query_only=ON")
        connection.set_authorizer(restart_write_denial_authorizer)
    except BaseException:
        try:
            connection.close()
        except (NameError, sqlite3.Error):
            pass
        raise
    return connection


def restart_read_db_dependency():
    database = validate_restart_database(must_exist=True)
    connection = open_restart_read_connection(database)
    try:
        yield connection
    finally:
        connection.close()


def _seed_restart_fixture() -> None:
    from app import agent_workbench
    from app.config import BootstrapAgentSlot
    from app.db import connect

    database = validate_restart_database(must_exist=True)
    if database.stat().st_size <= 0:
        raise RuntimeError("restart database was not initialized")
    observed_at = agent_workbench._parse_time(RESTART_OBSERVED_AT)
    if observed_at is None:
        raise RuntimeError("invalid fixed restart timestamp")
    conn = connect()
    try:
        slot = BootstrapAgentSlot(
            env_name="AGENT_WORKBENCH_RESTART_AGENT_ID",
            agent_key="restart-proof",
            display_name="Restart Proof Agent",
            role="Prove durable terminal Token persistence",
            sort_order=10,
            coreai_agent_id=RESTART_CORE_AGENT_ID,
        )
        original_uuid4 = agent_workbench.uuid.uuid4
        try:
            agent_workbench.uuid.uuid4 = lambda: __import__("uuid").UUID(
                RESTART_LOCAL_AGENT_ID
            )
            agent_workbench.seed_configured_agents(conn, (slot,), observed_at)
        finally:
            agent_workbench.uuid.uuid4 = original_uuid4
        parsed = agent_workbench.parse_agent_run_page(
            RESTART_CORE_AGENT_ID,
            {
                "runs": [
                    {
                        "id": RESTART_RUN_ID,
                        "agent_id": RESTART_CORE_AGENT_ID,
                        "status": "COMPLETED",
                        "triggered_by": "ACCEPTANCE_RESTART",
                        "started_at": RESTART_OBSERVED_AT,
                        "completed_at": RESTART_OBSERVED_AT,
                        "token_usage": {
                            "input": RESTART_INPUT_TOKENS,
                            "output": RESTART_OUTPUT_TOKENS,
                        },
                    }
                ],
                "total": 1,
            },
            observed_at,
        ).runs[0]
        agent_workbench.upsert_projected_run(
            conn, RESTART_LOCAL_AGENT_ID, parsed, observed_at
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET remote_total_runs=1,"
            "last_discovery_attempt_at=?,last_discovery_success_at=?,"
            "last_discovery_returned_count=1,coverage_start_at=?,"
            "finite_range_proven_start_at=?,current_state_checked_at=?,"
            "pending_observed_count=0,pending_upstream_total=0,"
            "pending_last_observed_at=?,pending_set_quality='exact',"
            "running_observed_count=0,running_upstream_total=0,"
            "running_last_observed_at=?,running_set_quality='exact',"
            "paused_observed_count=0,paused_upstream_total=0,"
            "paused_last_observed_at=?,paused_set_quality='exact',"
            "current_state_complete=1,sync_pending=0,"
            "unfiltered_proven_event_epoch=history_event_epoch,"
            "projection_revision=projection_revision+1 WHERE seo_ops_agent_id=?",
            (
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_OBSERVED_AT,
                RESTART_LOCAL_AGENT_ID,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def restart_write_startup() -> None:
    main = _task7_main()
    validate_restart_database(must_exist=False)
    main.initialize_writable_application()
    validate_restart_database(must_exist=True)
    _seed_restart_fixture()


def restart_read_startup() -> None:
    database = validate_restart_database(must_exist=True)
    connection = open_restart_read_connection(database)
    try:
        before = connection.total_changes
        row = connection.execute(
            "SELECT raw_status,input_tokens,output_tokens,terminal_observed_at,"
            "receipt_expires_at FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (RESTART_RUN_ID,),
        ).fetchone()
        if row is None or tuple(row) != (
            "COMPLETED",
            RESTART_INPUT_TOKENS,
            RESTART_OUTPUT_TOKENS,
            RESTART_OBSERVED_AT,
            RESTART_RECEIPT_EXPIRES_AT,
        ):
            raise RuntimeError("restart fixture mismatch")
        if connection.total_changes != before:
            raise RuntimeError("read phase changed the database")
    finally:
        connection.close()


def build_restart_probe_app():
    """Build the guarded write/read restart app without adding any route."""

    main = _task7_main()
    phase = os.environ.get(RESTART_PHASE_ENV, "").strip()
    if phase not in {"write", "read"}:
        raise RuntimeError("invalid restart phase")
    startup = restart_write_startup if phase == "write" else restart_read_startup
    lifespan = main.create_lifespan(
        startup,
        parked_scheduler_loop,
        parked_fbr_scheduler_loop,
        parked_restart_workbench_loop,
    )
    application = main.create_app(lifespan)
    if phase == "read":
        from app.db import get_db

        application.dependency_overrides[get_db] = restart_read_db_dependency
    return application


class _LazyAsgiApplication:
    def __init__(self, factory: Callable[[], object]) -> None:
        self._factory = factory
        self._application = None

    async def __call__(self, scope, receive, send):
        if self._application is None:
            self._application = self._factory()
        await self._application(scope, receive, send)


app = _LazyAsgiApplication(build_live_app)
restart_probe_app = _LazyAsgiApplication(build_restart_probe_app)

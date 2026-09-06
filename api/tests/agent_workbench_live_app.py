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
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Awaitable, Callable, Iterator
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


def _open_directory_fd(directory: Path) -> int:
    before = os.lstat(directory)
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(directory, flags)
    except OSError:
        raise RuntimeError("restart database directory is unsafe") from None
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISDIR(opened.st_mode)
        or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
    ):
        os.close(descriptor)
        raise RuntimeError("restart database directory changed")
    return descriptor


def _create_exclusive_file(
    directory_fd: int, name: str
) -> tuple[int, os.stat_result]:
    flags = os.O_RDWR | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, 0o600, dir_fd=directory_fd)
    except OSError:
        raise RuntimeError("restart staging database could not be created") from None
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
            raise RuntimeError("restart staging database is unsafe")
        return descriptor, opened
    except BaseException:
        os.close(descriptor)
        raise


def _unlink_sqlite_family(directory_fd: int, name: str) -> None:
    for suffix in ("", "-journal", "-wal", "-shm"):
        try:
            os.unlink(name + suffix, dir_fd=directory_fd)
        except FileNotFoundError:
            pass


def _require_no_sqlite_sidecars(directory_fd: int, name: str) -> None:
    for suffix in ("-journal", "-wal", "-shm"):
        try:
            os.stat(name + suffix, dir_fd=directory_fd, follow_symlinks=False)
        except FileNotFoundError:
            continue
        raise RuntimeError("restart staging database has an active sidecar")


@contextmanager
def _private_restart_stage(
    parent: Path, parent_fd: int
) -> Iterator[tuple[Path, int, str, int, os.stat_result]]:
    directory_name = f".agent-workbench-restart-{uuid.uuid4().hex}"
    database_name = "staged.db"
    stage_fd = -1
    database_fd = -1
    created_directory = False
    try:
        os.mkdir(directory_name, 0o700, dir_fd=parent_fd)
        created_directory = True
        stage_fd = os.open(
            directory_name,
            os.O_RDONLY
            | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        opened = os.fstat(stage_fd)
        if not stat.S_ISDIR(opened.st_mode) or stat.S_IMODE(opened.st_mode) != 0o700:
            raise RuntimeError("restart staging directory is unsafe")
        database_fd, expected = _create_exclusive_file(stage_fd, database_name)
        yield (
            parent / directory_name / database_name,
            stage_fd,
            database_name,
            database_fd,
            expected,
        )
    except OSError:
        raise RuntimeError("restart staging directory could not be created") from None
    finally:
        if stage_fd >= 0:
            if database_fd >= 0:
                os.close(database_fd)
            _unlink_sqlite_family(stage_fd, database_name)
            os.close(stage_fd)
        if created_directory:
            try:
                os.rmdir(directory_name, dir_fd=parent_fd)
            except FileNotFoundError:
                pass


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


class _PinnedConnection:
    """Delegate a production startup connection while suppressing close()."""

    def __init__(self, connection: sqlite3.Connection) -> None:
        self._connection = connection

    def __getattr__(self, name: str):
        return getattr(self._connection, name)

    def close(self) -> None:
        return None


def _restart_memory_connection(app_db) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:", check_same_thread=False)
    connection.row_factory = sqlite3.Row
    app_db.register_sqlite_invariants(connection)
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def _require_restart_database_integrity(connection: sqlite3.Connection) -> None:
    rows = list(connection.execute("PRAGMA integrity_check"))
    if len(rows) != 1 or str(rows[0][0]).lower() != "ok":
        raise RuntimeError("restart database integrity check failed")
    if next(iter(connection.execute("PRAGMA foreign_key_check")), None) is not None:
        raise RuntimeError("restart database foreign key check failed")


def _serialize_restart_database(connection: sqlite3.Connection, app_db) -> bytes:
    if connection.in_transaction:
        raise RuntimeError("restart database has an uncommitted transaction")
    _require_restart_database_integrity(connection)
    payload = connection.serialize()
    if not payload:
        raise RuntimeError("restart database serialization is empty")
    verifier = _restart_memory_connection(app_db)
    try:
        verifier.deserialize(payload)
        _require_restart_database_integrity(verifier)
    finally:
        verifier.close()
    return payload


def _write_restart_database(
    stage_fd: int,
    stage_name: str,
    database_fd: int,
    expected: os.stat_result,
    payload: bytes,
) -> None:
    opened = os.fstat(database_fd)
    entry = os.stat(stage_name, dir_fd=stage_fd, follow_symlinks=False)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_nlink != 1
        or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        or (entry.st_dev, entry.st_ino) != (expected.st_dev, expected.st_ino)
    ):
        raise RuntimeError("restart staging database changed")
    os.ftruncate(database_fd, 0)
    os.lseek(database_fd, 0, os.SEEK_SET)
    view = memoryview(payload)
    while view:
        written = os.write(database_fd, view)
        if written <= 0:
            raise RuntimeError("restart staging database write failed")
        view = view[written:]
    os.fsync(database_fd)
    opened = os.fstat(database_fd)
    entry = os.stat(stage_name, dir_fd=stage_fd, follow_symlinks=False)
    if (
        opened.st_size != len(payload)
        or opened.st_nlink != 1
        or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
        or (entry.st_dev, entry.st_ino) != (expected.st_dev, expected.st_ino)
    ):
        raise RuntimeError("restart staging database changed")
    os.lseek(database_fd, 0, os.SEEK_SET)
    readback = bytearray()
    while len(readback) < len(payload):
        chunk = os.read(database_fd, min(1024 * 1024, len(payload) - len(readback)))
        if not chunk:
            break
        readback.extend(chunk)
    if bytes(readback) != payload or os.read(database_fd, 1):
        raise RuntimeError("restart staging database readback failed")


def _install_restart_database(
    parent_fd: int,
    stage_fd: int,
    stage_name: str,
    database_fd: int,
    target_name: str,
    expected: os.stat_result,
) -> None:
    try:
        opened = os.fstat(database_fd)
        staged = os.stat(stage_name, dir_fd=stage_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino)
            or (staged.st_dev, staged.st_ino) != (expected.st_dev, expected.st_ino)
        ):
            raise RuntimeError("restart staging database changed")
        os.link(
            stage_name,
            target_name,
            src_dir_fd=stage_fd,
            dst_dir_fd=parent_fd,
            follow_symlinks=False,
        )
        # link(2) is the no-clobber publication linearization point.  Once it
        # succeeds there is no stdlib inode-conditional unlink, so an error
        # after publication must never try to roll the public name back: a
        # concurrent process could already have replaced it with its own file.
        installed = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(installed.st_mode)
            or (installed.st_dev, installed.st_ino)
            != (expected.st_dev, expected.st_ino)
        ):
            raise RuntimeError("restart database installation changed")
        os.unlink(stage_name, dir_fd=stage_fd)
        installed = os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(installed.st_mode)
            or installed.st_nlink != 1
            or (installed.st_dev, installed.st_ino)
            != (expected.st_dev, expected.st_ino)
        ):
            raise RuntimeError("restart database installation changed")
    except BaseException as error:
        if isinstance(error, OSError):
            raise RuntimeError("restart database could not be installed") from None
        raise


def _require_restart_target_absent(parent_fd: int, target_name: str) -> None:
    try:
        os.stat(target_name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return
    raise RuntimeError("restart database already exists")


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


def _seed_restart_fixture(conn: sqlite3.Connection) -> None:
    from app import agent_workbench
    from app.config import BootstrapAgentSlot

    if conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='seo_ops_agents'"
    ).fetchone() is None:
        raise RuntimeError("restart database was not initialized")
    observed_at = agent_workbench._parse_time(RESTART_OBSERVED_AT)
    if observed_at is None:
        raise RuntimeError("invalid fixed restart timestamp")
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
    except BaseException:
        conn.rollback()
        raise


def restart_write_startup() -> None:
    from app import db as app_db

    main = _task7_main()
    database = validate_restart_database(must_exist=False)
    parent_fd = _open_directory_fd(database.parent)
    try:
        with _private_restart_stage(database.parent, parent_fd) as (
            _stage_path,
            stage_fd,
            stage_name,
            database_fd,
            expected,
        ):
            with _database_environment(Path(":memory:")):
                pinned = _restart_memory_connection(app_db)
                original_db_connect = app_db.connect
                original_main_connect = getattr(main, "connect", None)
                app_db.connect = lambda: _PinnedConnection(pinned)
                if original_main_connect is not None:
                    main.connect = lambda: _PinnedConnection(pinned)
                try:
                    main.initialize_writable_application()
                    current = os.stat(
                        stage_name, dir_fd=stage_fd, follow_symlinks=False
                    )
                    if (current.st_dev, current.st_ino) != (
                        expected.st_dev,
                        expected.st_ino,
                    ):
                        raise RuntimeError("restart staging database changed")
                    _require_restart_target_absent(parent_fd, database.name)
                    _seed_restart_fixture(pinned)
                    payload = _serialize_restart_database(pinned, app_db)
                finally:
                    app_db.connect = original_db_connect
                    if original_main_connect is not None:
                        main.connect = original_main_connect
                    pinned.close()
            _write_restart_database(
                stage_fd, stage_name, database_fd, expected, payload
            )
            _require_no_sqlite_sidecars(stage_fd, stage_name)
            # Revalidate authorization and the no-clobber target immediately
            # before publishing the completed, closed staging database.
            validate_restart_database(must_exist=False)
            _install_restart_database(
                parent_fd,
                stage_fd,
                stage_name,
                database_fd,
                database.name,
                expected,
            )
    finally:
        os.close(parent_fd)


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

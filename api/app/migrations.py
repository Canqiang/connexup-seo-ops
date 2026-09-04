from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from typing import Any, Callable


MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_NAME = re.compile(r"^(?P<version>\d{4}_[a-z0-9_]+)\.sql$")
MIGRATION_VERSION = re.compile(r"^\d{4}_[a-z0-9_]+$")
PERFORMANCE_MIGRATION = "0001_performance_history"
PERFORMANCE_DELETE_GUARD_NAME = "guard_merchants_delete_with_durable_history"
PERFORMANCE_LIFECYCLE_MIGRATION = "0003_performance_lifecycle_baseline"
PERFORMANCE_LIFECYCLE_HOOK_MANIFEST = (
    f"{PERFORMANCE_LIFECYCLE_MIGRATION}.hook.json"
)
RUN_DISPATCH_MIGRATION = "0004_run_dispatch_contract"
RUN_DISPATCH_HOOK_MANIFEST = f"{RUN_DISPATCH_MIGRATION}.hook.json"
_PERFORMANCE_LIFECYCLE_HOOK_CONTRACT = {
    "version": PERFORMANCE_LIFECYCLE_MIGRATION,
    "hook_revision": 1,
    "entrypoint": (
        "app.migrations.run_performance_lifecycle_baseline_migration_hook"
    ),
    "responsibilities": [
        "bootstrap_legacy_fbr_binding_baselines",
        "bootstrap_missing_merchant_status_baselines",
        "validate_complete_merchant_lifecycle_history",
        "remove_legacy_fbr_projection_table",
    ],
}
_RUN_DISPATCH_HOOK_CONTRACT = {
    "version": RUN_DISPATCH_MIGRATION,
    "hook_revision": 1,
    "entrypoint": "app.migrations.run_run_dispatch_contract_migration_hook",
    "responsibilities": [
        "install_fail_closed_run_dispatch_columns",
        "backfill_legacy_dispatch_state",
        "track_consecutive_provider_poll_failures",
        "enforce_unique_provider_and_dispatch_identities",
        "install_immutable_dispatch_reconciliation_ledger",
        "extend_merchant_delete_guard_to_task_plans",
        "extend_merchant_delete_guard_to_operator_commands",
        "validate_exact_run_dispatch_schema_contract",
    ],
}
_CANONICAL_UTC_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
_PYTHON_MIGRATION_CHECKSUM_PREFIX = "seo-ops-python-migration-v1:"
_COMBINED_MIGRATION_CHECKSUM_PREFIX = "seo-ops-combined-migration-v1:"


class MigrationInvariantError(RuntimeError):
    """Raised before commit when persisted schema or history is contradictory."""


@dataclass(frozen=True)
class LegacyFbrBaselineResult:
    rows_seen: int
    events_inserted: int
    states_inserted: int


@dataclass(frozen=True)
class PythonMigration:
    """An explicitly registered, transaction-owned application migration."""

    version: str
    checksum: str
    apply: Callable[[sqlite3.Connection, str], None]
    foreign_keys_off: bool = False
    legacy_ledger_names: tuple[str, ...] = ()
    validate_legacy_adoption: Callable[[sqlite3.Connection], None] | None = None
    compatible_checksums: tuple[
        tuple[str, Callable[[sqlite3.Connection], None]], ...
    ] = ()


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_hash(parts: list[Any]) -> str:
    payload = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    return _sha256_text(payload)


def _canonical_fbr_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    return value.strip()


def _fbr_identity_sha256(value: Any) -> str | None:
    canonical = _canonical_fbr_id(value)
    return None if canonical is None else _sha256_text(canonical)


def _fbr_binding_open_sha256(
    merchant_id: Any,
    fbr_merchant_id: Any,
    generation: Any,
    valid_from: Any,
    opened_by: Any,
    open_reason: Any,
) -> str:
    return _canonical_hash(
        [merchant_id, fbr_merchant_id, generation, valid_from, opened_by, open_reason]
    )


def _fbr_binding_close_sha256(
    event_id: Any,
    open_hash: Any,
    valid_to: Any,
    closed_by: Any,
    close_reason: Any,
) -> str:
    return _canonical_hash([event_id, open_hash, valid_to, closed_by, close_reason])


def _content_sha256(*parts: Any) -> str:
    return _canonical_hash(list(parts))


def content_sha256(*parts: Any) -> str:
    """Return the canonical digest used by immutable application events."""

    return _content_sha256(*parts)


def _is_canonical_utc_instant(value: Any) -> int:
    if not isinstance(value, str) or len(value) != 27:
        return 0
    try:
        parsed = datetime.strptime(value, _CANONICAL_UTC_FORMAT).replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return 0
    return int(parsed.strftime(_CANONICAL_UTC_FORMAT) == value)


def register_sqlite_invariants(conn: sqlite3.Connection) -> None:
    conn.create_function("canonical_fbr_id", 1, _canonical_fbr_id, deterministic=True)
    conn.create_function(
        "fbr_identity_sha256", 1, _fbr_identity_sha256, deterministic=True
    )
    conn.create_function(
        "fbr_binding_open_sha256", 6, _fbr_binding_open_sha256, deterministic=True
    )
    conn.create_function(
        "fbr_binding_close_sha256", 5, _fbr_binding_close_sha256, deterministic=True
    )
    conn.create_function("content_sha256", -1, _content_sha256, deterministic=True)
    conn.create_function(
        "is_canonical_utc_instant", 1, _is_canonical_utc_instant, deterministic=True
    )


def _object_type(conn: sqlite3.Connection, name: str) -> str | None:
    row = conn.execute(
        "SELECT type FROM sqlite_master WHERE name = ?", (name,)
    ).fetchone()
    return None if row is None else str(row[0])


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return _object_type(conn, name) == "table"


_RUN_DISPATCH_COLUMN_DEFINITIONS = {
    "dispatch_state": (
        "dispatch_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK "
        "(dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED'))"
    ),
    "dispatch_token": "dispatch_token TEXT",
    "dispatch_started_at": "dispatch_started_at TEXT",
    "poll_failure_started_at": "poll_failure_started_at TEXT",
    "provider_candidate_run_id": "provider_candidate_run_id TEXT",
    "source_agent_id": "source_agent_id TEXT",
    "merchant_lifecycle_generation": "merchant_lifecycle_generation INTEGER",
    "merchant_lifecycle_sha256": "merchant_lifecycle_sha256 TEXT",
    "input_sha256": "input_sha256 TEXT",
}
_PRE_POLL_RUN_DISPATCH_COLUMNS = (
    set(_RUN_DISPATCH_COLUMN_DEFINITIONS) - {"poll_failure_started_at"}
)


def _run_dispatch_schema_statements() -> dict[str, tuple[str, str, str]]:
    """Return the frozen objects owned by migration 0004."""

    return {
        "idx_runs_coreai_run_id": (
            "index",
            "runs",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_coreai_run_id "
            "ON runs(coreai_run_id) WHERE coreai_run_id IS NOT NULL",
        ),
        "idx_runs_dispatch_token": (
            "index",
            "runs",
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_token "
            "ON runs(dispatch_token) WHERE dispatch_token IS NOT NULL",
        ),
        "run_dispatch_reconciliations": (
            "table",
            "run_dispatch_reconciliations",
            """
            CREATE TABLE IF NOT EXISTS run_dispatch_reconciliations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
              action TEXT NOT NULL CHECK (action IN ('NOT_CREATED','BIND_EXISTING')),
              provider_run_id TEXT,
              operator_id TEXT NOT NULL CHECK (length(trim(operator_id)) > 0),
              prior_dispatch_state TEXT NOT NULL
                CHECK (prior_dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')),
              result_dispatch_state TEXT NOT NULL
                CHECK (result_dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')),
              reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
              created_at TEXT NOT NULL
            )
            """,
        ),
        "idx_run_dispatch_reconciliations_run": (
            "index",
            "run_dispatch_reconciliations",
            "CREATE INDEX IF NOT EXISTS idx_run_dispatch_reconciliations_run "
            "ON run_dispatch_reconciliations(run_id, id)",
        ),
        "trg_run_dispatch_reconciliations_no_update": (
            "trigger",
            "run_dispatch_reconciliations",
            """
            CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_reconciliations_no_update
            BEFORE UPDATE ON run_dispatch_reconciliations
            BEGIN
              SELECT RAISE(ABORT, 'run dispatch reconciliations are append-only');
            END
            """,
        ),
        "trg_run_dispatch_reconciliations_no_delete": (
            "trigger",
            "run_dispatch_reconciliations",
            """
            CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_reconciliations_no_delete
            BEFORE DELETE ON run_dispatch_reconciliations
            BEGIN
              SELECT RAISE(ABORT, 'run dispatch reconciliations are append-only');
            END
            """,
        ),
        "guard_merchants_delete_with_task_plan_history": (
            "trigger",
            "merchants",
            """
            CREATE TRIGGER IF NOT EXISTS guard_merchants_delete_with_task_plan_history
            BEFORE DELETE ON merchants
            WHEN EXISTS (SELECT 1 FROM task_plans WHERE merchant_id=OLD.id)
            BEGIN
              SELECT RAISE(ABORT, 'merchant_has_durable_history');
            END
            """,
        ),
        "guard_merchants_delete_with_operator_command_history": (
            "trigger",
            "merchants",
            """
            CREATE TRIGGER IF NOT EXISTS guard_merchants_delete_with_operator_command_history
            BEFORE DELETE ON merchants
            WHEN EXISTS (
              SELECT 1 FROM operator_command_ledger
              WHERE target_kind='MERCHANT'
                AND target_stable_id=CAST(OLD.id AS TEXT)
                AND http_status != 404
            )
            BEGIN
              SELECT RAISE(ABORT, 'merchant_has_durable_history');
            END
            """,
        ),
    }


def _normalized_contract_ddl(value: str) -> str:
    normalized = " ".join(value.strip().rstrip(";").split())
    normalized = re.sub(
        r"^(CREATE(?: UNIQUE)? (?:TABLE|INDEX|TRIGGER)) IF NOT EXISTS ",
        r"\1 ",
        normalized,
        count=1,
    )
    return re.sub(
        r'(?:"([a-z_][a-z0-9_]*)"|`([a-z_][a-z0-9_]*)`|\[([a-z_][a-z0-9_]*)\])',
        lambda match: next(group for group in match.groups() if group is not None),
        normalized,
        flags=re.IGNORECASE,
    )


def _split_table_definitions(table_sql: str) -> list[str]:
    """Split CREATE TABLE column/constraint clauses at top-level commas."""

    start = table_sql.find("(")
    end = table_sql.rfind(")")
    if start < 0 or end <= start:
        raise MigrationInvariantError("runs table contract is not parseable")
    body = table_sql[start + 1 : end]
    definitions: list[str] = []
    pending: list[str] = []
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(body):
        char = body[index]
        pending.append(char)
        if quote is not None:
            if char == quote:
                if index + 1 < len(body) and body[index + 1] == quote:
                    pending.append(body[index + 1])
                    index += 1
                else:
                    quote = None
        elif char in {"'", '"', "`"}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            pending.pop()
            definitions.append("".join(pending).strip())
            pending.clear()
        index += 1
    if quote is not None or depth != 0:
        raise MigrationInvariantError("runs table contract is not parseable")
    if pending:
        definitions.append("".join(pending).strip())
    return definitions


def _assert_run_dispatch_column_definitions(
    conn: sqlite3.Connection, names: set[str]
) -> None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='runs'"
    ).fetchone()
    if row is None or not isinstance(row[0], str):
        raise MigrationInvariantError("runs table contract is missing")
    definitions: dict[str, str] = {}
    for definition in _split_table_definitions(row[0]):
        normalized = _normalized_contract_ddl(definition)
        name = normalized.split(" ", 1)[0].lower() if normalized else ""
        definitions[name] = normalized
    for name in sorted(names):
        expected_definition = _RUN_DISPATCH_COLUMN_DEFINITIONS[name]
        if definitions.get(name) != _normalized_contract_ddl(expected_definition):
            raise MigrationInvariantError(f"runs column contract mismatch: {name}")


def _run_dispatch_column_contract_state(conn: sqlite3.Connection) -> str:
    """Classify runs as missing, legacy, pre-poll, or complete; reject drift."""

    if not table_exists(conn, "runs"):
        return "missing"
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(runs)").fetchall()
    }
    expected = set(_RUN_DISPATCH_COLUMN_DEFINITIONS)
    present = columns & expected
    if not present:
        return "legacy"
    if present == _PRE_POLL_RUN_DISPATCH_COLUMNS:
        _assert_run_dispatch_column_definitions(
            conn, _PRE_POLL_RUN_DISPATCH_COLUMNS
        )
        return "pre_poll"
    if present != expected:
        missing = sorted(expected - present)
        raise MigrationInvariantError(
            "partial run-dispatch column contract: "
            f"present={sorted(present)!r},missing={missing!r}"
        )
    _assert_run_dispatch_column_definitions(conn, expected)
    return "complete"


def _assert_exact_schema_object(
    conn: sqlite3.Connection,
    *,
    name: str,
    expected_type: str,
    expected_table: str,
    expected_sql: str,
    allow_missing: bool = False,
) -> None:
    row = conn.execute(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?", (name,)
    ).fetchone()
    if row is None and allow_missing:
        return
    if (
        row is None
        or row[0] != expected_type
        or row[1] != expected_table
        or not isinstance(row[2], str)
        or _normalized_contract_ddl(row[2])
        != _normalized_contract_ddl(expected_sql)
    ):
        raise MigrationInvariantError(f"run-dispatch object contract mismatch: {name}")


def _assert_run_dispatch_objects(
    conn: sqlite3.Connection,
    *,
    state: str,
    require_complete: bool,
    allowed_missing: frozenset[str] = frozenset(),
) -> None:
    contracts = _run_dispatch_schema_statements()
    for name, (expected_type, expected_table, expected_sql) in contracts.items():
        allow_missing = not require_complete or name in allowed_missing
        if state == "legacy" and name == "idx_runs_coreai_run_id":
            # This unique index existed before dispatch lifecycle tracking and
            # is valid either absent or already canonical on a legacy database.
            allow_missing = True
        _assert_exact_schema_object(
            conn,
            name=name,
            expected_type=expected_type,
            expected_table=expected_table,
            expected_sql=expected_sql,
            allow_missing=allow_missing,
        )


def _assert_run_dispatch_unique_index_contracts(
    conn: sqlite3.Connection,
) -> None:
    expected_unique_indexes = {
        "runs": {
            (
                "idx_runs_coreai_run_id",
                ("coreai_run_id",),
                True,
                "c",
            ),
            (
                "idx_runs_dispatch_token",
                ("dispatch_token",),
                True,
                "c",
            ),
        },
        "run_dispatch_reconciliations": {
            (None, ("run_id",), False, "u"),
        },
    }
    for table_name, expected in expected_unique_indexes.items():
        actual: set[tuple[str | None, tuple[str, ...], bool, str]] = set()
        for index_row in conn.execute(f"PRAGMA index_list({table_name})"):
            if not bool(index_row[2]):
                continue
            index_name = str(index_row[1])
            origin = str(index_row[3])
            columns = tuple(
                str(column_row[2])
                for column_row in conn.execute(f"PRAGMA index_info({index_name})")
            )
            actual.add(
                (
                    None if origin == "u" else index_name,
                    columns,
                    bool(index_row[4]),
                    origin,
                )
            )
        if actual != expected:
            raise MigrationInvariantError(
                f"run-dispatch unique-index contract mismatch: {table_name}"
            )


def _run_dispatch_migration_recorded(conn: sqlite3.Connection) -> bool:
    if not table_exists(conn, "schema_migrations"):
        return False
    columns = {
        str(row[1]) for row in conn.execute("PRAGMA table_info(schema_migrations)")
    }
    if columns == {"version", "checksum", "applied_at"}:
        key = "version"
    elif columns == {"name", "applied_at"}:
        key = "name"
    else:
        raise MigrationInvariantError("unrecognized schema_migrations layout")
    return (
        conn.execute(
            f"SELECT 1 FROM schema_migrations WHERE {key}=?",
            (RUN_DISPATCH_MIGRATION,),
        ).fetchone()
        is not None
    )


def validate_run_dispatch_migration_input(conn: sqlite3.Connection) -> str:
    """Read-only cold-start gate that prevents bridge code masking drift."""

    state = _run_dispatch_column_contract_state(conn)
    if state == "missing":
        for name in _run_dispatch_schema_statements():
            if _object_type(conn, name) is not None:
                raise MigrationInvariantError(
                    f"run-dispatch object exists without runs table: {name}"
                )
        return state
    if state in {"complete", "pre_poll"}:
        recorded = _run_dispatch_migration_recorded(conn)
        allowed_missing = (
            frozenset({"guard_merchants_delete_with_operator_command_history"})
            if not recorded
            else frozenset()
        )
        _assert_run_dispatch_objects(
            conn,
            state=state,
            require_complete=True,
            allowed_missing=allowed_missing,
        )
        _assert_run_dispatch_unique_index_contracts(conn)
        if state == "pre_poll" and recorded:
            raise MigrationInvariantError(
                "recorded run-dispatch migration is missing "
                "poll_failure_started_at"
            )
        return state
    _assert_run_dispatch_objects(
        conn,
        state=state,
        require_complete=False,
    )
    # A legacy database must be wholly legacy. A reconciliation table or any
    # new-field object is evidence of a partial interrupted/hand-built change.
    if state == "legacy":
        for name in _run_dispatch_schema_statements():
            if name == "idx_runs_coreai_run_id":
                continue
            if _object_type(conn, name) is not None:
                raise MigrationInvariantError(
                    f"partial run-dispatch object contract: {name}"
                )
    return state


def assert_run_dispatch_migration_postconditions(
    conn: sqlite3.Connection,
) -> None:
    state = _run_dispatch_column_contract_state(conn)
    if state != "complete":
        raise MigrationInvariantError(
            f"run-dispatch migration schema is incomplete: {state}"
        )
    _assert_run_dispatch_objects(conn, state=state, require_complete=True)
    _assert_run_dispatch_unique_index_contracts(conn)


def run_run_dispatch_contract_migration_hook(
    conn: sqlite3.Connection, _migration_instant: str
) -> None:
    """Install the run dispatch lifecycle under the migration transaction."""

    if not conn.in_transaction:
        raise MigrationInvariantError(
            "run-dispatch migration hook requires an active transaction"
        )
    state = validate_run_dispatch_migration_input(conn)
    if state == "missing":
        raise MigrationInvariantError("runs table is missing for run-dispatch migration")
    if state == "legacy":
        for definition in _RUN_DISPATCH_COLUMN_DEFINITIONS.values():
            conn.execute(f"ALTER TABLE runs ADD COLUMN {definition}")
        conn.execute(
            "UPDATE runs SET dispatch_state = CASE "
            "WHEN status = 'failed' THEN 'FAILED' "
            "WHEN status = 'succeeded' AND coreai_run_id IS NOT NULL "
            "THEN 'DISPATCHED' ELSE 'UNKNOWN' END"
        )
        for _name, (_object_type_name, _table_name, statement) in (
            _run_dispatch_schema_statements().items()
        ):
            conn.execute(statement)
    elif state == "pre_poll":
        conn.execute(
            "ALTER TABLE runs ADD COLUMN poll_failure_started_at TEXT"
        )
    if not _run_dispatch_migration_recorded(conn):
        name = "guard_merchants_delete_with_operator_command_history"
        if _object_type(conn, name) is None:
            conn.execute(_run_dispatch_schema_statements()[name][2])
    assert_run_dispatch_migration_postconditions(conn)


def _migration_files(migrations_dir: Path) -> list[tuple[Path, str, bytes, str]]:
    result: list[tuple[Path, str, bytes, str]] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        match = MIGRATION_NAME.fullmatch(path.name)
        if match is None:
            raise RuntimeError(f"invalid migration filename: {path.name}")
        payload = path.read_bytes()
        result.append(
            (
                path,
                match.group("version"),
                payload,
                hashlib.sha256(payload).hexdigest(),
            )
        )
    return result


def _execute_sql_payload(conn: sqlite3.Connection, payload: bytes) -> None:
    """Execute one SQL migration without letting executescript release our lock."""
    pending: list[str] = []
    for line in payload.decode("utf-8").splitlines(keepends=True):
        pending.append(line)
        statement = "".join(pending)
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            pending.clear()
    if "".join(pending).strip():
        raise sqlite3.OperationalError("incomplete migration SQL statement")


def execute_sql_payload(conn: sqlite3.Connection, payload: bytes) -> None:
    """Execute complete SQL statements without ``executescript`` auto-commits."""

    _execute_sql_payload(conn, payload)


def performance_delete_guard_contract_sql(
    migrations_dir: Path = MIGRATIONS_DIR,
) -> str:
    """Return the canonical delete-guard DDL owned by migration 0001.

    Task migration 0002 must temporarily remove this trigger while replacing
    ``tasks``.  Resolve the contract from the immutable migration artifact so
    the Task hook never carries or recreates a second, drifting definition.
    """

    payload = (migrations_dir / f"{PERFORMANCE_MIGRATION}.sql").read_text(
        encoding="utf-8"
    )
    pending: list[str] = []
    matches: list[str] = []
    for line in payload.splitlines(keepends=True):
        pending.append(line)
        statement = "".join(pending)
        if not sqlite3.complete_statement(statement):
            continue
        normalized = " ".join(statement.strip().rstrip(";").split())
        if normalized.startswith(
            f"CREATE TRIGGER {PERFORMANCE_DELETE_GUARD_NAME} "
        ):
            matches.append(statement.strip().rstrip(";"))
        pending.clear()
    if "".join(pending).strip() or len(matches) != 1:
        raise MigrationInvariantError(
            "performance delete-guard migration contract is missing or ambiguous"
        )
    return matches[0]


def python_migration_checksum(version: str, *, contract: str) -> str:
    """Hash a frozen migration contract rather than an evolving runtime module."""

    if MIGRATION_VERSION.fullmatch(version) is None:
        raise ValueError("invalid Python migration version")
    if not isinstance(contract, str) or not contract.strip():
        raise ValueError("Python migration contract is required")
    return _sha256_text(
        f"{_PYTHON_MIGRATION_CHECKSUM_PREFIX}{version}:{contract.strip()}"
    )


def combined_migration_checksum(
    version: str, *, sql_checksum: str, python_checksum: str
) -> str:
    """Bind one SQL payload and one frozen Python-hook contract together."""

    if MIGRATION_VERSION.fullmatch(version) is None:
        raise ValueError("invalid combined migration version")
    for label, checksum in (
        ("SQL", sql_checksum),
        ("Python", python_checksum),
    ):
        if re.fullmatch(r"[a-f0-9]{64}", checksum) is None:
            raise ValueError(f"invalid {label} migration checksum: {version}")
    return _sha256_text(
        f"{_COMBINED_MIGRATION_CHECKSUM_PREFIX}"
        f"{version}:{sql_checksum}:{python_checksum}"
    )


def _migration_ledger_columns(conn: sqlite3.Connection) -> set[str]:
    if not table_exists(conn, "schema_migrations"):
        return set()
    return {
        str(row[1]) for row in conn.execute("PRAGMA table_info(schema_migrations)")
    }


def ensure_migration_ledger(
    conn: sqlite3.Connection,
    *,
    legacy_adoptions: dict[
        frozenset[str],
        tuple[str, str, Callable[[sqlite3.Connection], None]],
    ]
    | None = None,
) -> None:
    """Create or atomically upgrade the sole migration registry.

    Earlier Task workflow builds used ``(name, applied_at)``.  A non-empty
    legacy ledger can only be adopted through an explicitly registered exact
    marker-set contract.  Partial and unknown sets fail closed.
    """

    columns = _migration_ledger_columns(conn)
    if not columns:
        conn.execute(
            "CREATE TABLE schema_migrations ("
            "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        return
    if columns == {"version", "checksum", "applied_at"}:
        return
    if columns != {"name", "applied_at"}:
        raise MigrationInvariantError("unrecognized schema_migrations layout")

    legacy_rows = conn.execute(
        "SELECT name,applied_at FROM schema_migrations ORDER BY name"
    ).fetchall()
    adoption: tuple[
        str,
        str,
        Callable[[sqlite3.Connection], None],
    ] | None = None
    if legacy_rows:
        legacy_names = frozenset(str(row[0]) for row in legacy_rows)
        adoption = (legacy_adoptions or {}).get(legacy_names)
        if adoption is None:
            raise MigrationInvariantError(
                "unrecognized legacy migration marker set: "
                f"{','.join(sorted(legacy_names))}"
            )
        adoption[2](conn)
    conn.execute("ALTER TABLE schema_migrations RENAME TO schema_migrations_legacy")
    conn.execute(
        "CREATE TABLE schema_migrations ("
        "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    if adoption is not None:
        version, checksum, _validator = adoption
        applied_at = max(str(row[1]) for row in legacy_rows)
        conn.execute(
            "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
            (version, checksum, applied_at),
        )
    conn.execute("DROP TABLE schema_migrations_legacy")


def _index_python_migrations(
    python_migrations: tuple[PythonMigration, ...],
) -> dict[str, PythonMigration]:
    hooks_by_version: dict[str, PythonMigration] = {}
    for migration in python_migrations:
        if MIGRATION_VERSION.fullmatch(migration.version) is None:
            raise ValueError(f"invalid Python migration version: {migration.version}")
        if migration.version in hooks_by_version:
            raise MigrationInvariantError(
                f"duplicate migration version: {migration.version}"
            )
        if re.fullmatch(r"[a-f0-9]{64}", migration.checksum) is None:
            raise ValueError(f"invalid Python migration checksum: {migration.version}")
        if any(
            not isinstance(name, str) or not name
            for name in migration.legacy_ledger_names
        ) or len(set(migration.legacy_ledger_names)) != len(
            migration.legacy_ledger_names
        ):
            raise ValueError(
                f"invalid legacy migration marker contract: {migration.version}"
            )
        if (
            migration.legacy_ledger_names
            and migration.validate_legacy_adoption is None
        ):
            raise ValueError(
                "legacy migration marker contract requires a validator: "
                f"{migration.version}"
            )
        if (
            not migration.legacy_ledger_names
            and migration.validate_legacy_adoption is not None
        ):
            raise ValueError(
                "legacy migration validator requires marker names: "
                f"{migration.version}"
            )
        compatible_checksums: set[str] = set()
        for checksum, validator in migration.compatible_checksums:
            if (
                re.fullmatch(r"[a-f0-9]{64}", checksum) is None
                or checksum == migration.checksum
                or checksum in compatible_checksums
                or not callable(validator)
            ):
                raise ValueError(
                    f"invalid compatible migration checksum: {migration.version}"
                )
            compatible_checksums.add(checksum)
        hooks_by_version[migration.version] = migration
    return hooks_by_version


def _builtin_python_migrations(
    migrations_dir: Path,
    sql_by_version: dict[str, tuple[bytes, str]],
) -> tuple[PythonMigration, ...]:
    """Register repository-owned hooks whenever their matching SQL is present."""

    if PERFORMANCE_MIGRATION not in sql_by_version:
        return ()
    manifest_path = migrations_dir / PERFORMANCE_LIFECYCLE_HOOK_MANIFEST
    try:
        contract = manifest_path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise MigrationInvariantError(
            "migration hook contract missing: "
            f"{PERFORMANCE_LIFECYCLE_HOOK_MANIFEST}"
        ) from exc
    try:
        manifest = json.loads(contract)
    except json.JSONDecodeError as exc:
        raise MigrationInvariantError(
            "migration hook contract invalid: "
            f"{PERFORMANCE_LIFECYCLE_HOOK_MANIFEST}"
        ) from exc
    if (
        not isinstance(manifest, dict)
        or type(manifest.get("hook_revision")) is not int
        or manifest != _PERFORMANCE_LIFECYCLE_HOOK_CONTRACT
    ):
        raise MigrationInvariantError(
            "migration hook contract mismatch: "
            f"{PERFORMANCE_LIFECYCLE_HOOK_MANIFEST}"
        )
    migrations = [
        PythonMigration(
            version=PERFORMANCE_LIFECYCLE_MIGRATION,
            checksum=python_migration_checksum(
                PERFORMANCE_LIFECYCLE_MIGRATION,
                contract=contract,
            ),
            apply=partial(
                run_performance_lifecycle_baseline_migration_hook,
                performance_sql_checksum=sql_by_version[PERFORMANCE_MIGRATION][1],
            ),
        ),
    ]
    run_dispatch_manifest_path = migrations_dir / RUN_DISPATCH_HOOK_MANIFEST
    if (
        migrations_dir.resolve() == MIGRATIONS_DIR.resolve()
        or run_dispatch_manifest_path.exists()
    ):
        try:
            run_dispatch_contract = run_dispatch_manifest_path.read_text(
                encoding="utf-8"
            )
        except FileNotFoundError as exc:
            raise MigrationInvariantError(
                f"migration hook contract missing: {RUN_DISPATCH_HOOK_MANIFEST}"
            ) from exc
        try:
            run_dispatch_manifest = json.loads(run_dispatch_contract)
        except json.JSONDecodeError as exc:
            raise MigrationInvariantError(
                f"migration hook contract invalid: {RUN_DISPATCH_HOOK_MANIFEST}"
            ) from exc
        if (
            not isinstance(run_dispatch_manifest, dict)
            or type(run_dispatch_manifest.get("hook_revision")) is not int
            or run_dispatch_manifest != _RUN_DISPATCH_HOOK_CONTRACT
        ):
            raise MigrationInvariantError(
                f"migration hook contract mismatch: {RUN_DISPATCH_HOOK_MANIFEST}"
            )
        migrations.append(
            PythonMigration(
                version=RUN_DISPATCH_MIGRATION,
                checksum=python_migration_checksum(
                    RUN_DISPATCH_MIGRATION,
                    contract=run_dispatch_contract,
                ),
                apply=run_run_dispatch_contract_migration_hook,
            )
        )
    return tuple(migrations)


def _all_python_migrations(
    migrations_dir: Path,
    sql_by_version: dict[str, tuple[bytes, str]],
    python_migrations: tuple[PythonMigration, ...],
) -> dict[str, PythonMigration]:
    return _index_python_migrations(
        (*_builtin_python_migrations(migrations_dir, sql_by_version), *python_migrations)
    )


def _registered_migration_checksums(
    sql_by_version: dict[str, tuple[bytes, str]],
    hooks_by_version: dict[str, PythonMigration],
) -> dict[str, str]:
    result: dict[str, str] = {}
    for version in sorted({*sql_by_version, *hooks_by_version}):
        sql_migration = sql_by_version.get(version)
        python_migration = hooks_by_version.get(version)
        if sql_migration is not None and python_migration is not None:
            result[version] = combined_migration_checksum(
                version,
                sql_checksum=sql_migration[1],
                python_checksum=python_migration.checksum,
            )
        elif sql_migration is not None:
            result[version] = sql_migration[1]
        elif python_migration is not None:
            result[version] = python_migration.checksum
        else:  # pragma: no cover - versions comes from these two registries.
            raise AssertionError(f"migration registry lost version: {version}")
    return result


def migration_registry_checksums(
    migrations_dir: Path = MIGRATIONS_DIR,
    *,
    python_migrations: tuple[PythonMigration, ...] = (),
) -> dict[str, str]:
    """Return the final SQL, Python, and combined checksums for one registry."""

    sql_by_version = {
        version: (payload, checksum)
        for _path, version, payload, checksum in _migration_files(migrations_dir)
    }
    return _registered_migration_checksums(
        sql_by_version,
        _all_python_migrations(migrations_dir, sql_by_version, python_migrations),
    )


def assert_migration_registry_checksums(
    conn: sqlite3.Connection,
    migrations_dir: Path = MIGRATIONS_DIR,
    *,
    expected_checksums: dict[str, str] | None = None,
    python_migrations: tuple[PythonMigration, ...] = (),
) -> None:
    if not table_exists(conn, "schema_migrations"):
        return
    if expected_checksums is not None and python_migrations:
        raise ValueError(
            "pass expected_checksums or python_migrations, not both"
        )
    expected = (
        expected_checksums
        if expected_checksums is not None
        else migration_registry_checksums(
            migrations_dir,
            python_migrations=python_migrations,
        )
    )
    columns = _migration_ledger_columns(conn)
    if columns != {"version", "checksum", "applied_at"}:
        raise MigrationInvariantError("unrecognized schema_migrations layout")
    for version, checksum in conn.execute(
        "SELECT version, checksum FROM schema_migrations ORDER BY version"
    ):
        expected_checksum = expected.get(version)
        if expected_checksum is None:
            raise MigrationInvariantError(
                f"unknown migration registry row: {version}"
            )
        if checksum != expected_checksum:
            raise RuntimeError(f"migration checksum mismatch: {version}")


def _upgrade_compatible_migration_checksums(
    conn: sqlite3.Connection,
    *,
    expected_checksums: dict[str, str],
    hooks_by_version: dict[str, PythonMigration],
) -> None:
    """Validate and atomically advance explicitly compatible ledger rows.

    Compatibility is deliberately opt-in by exact historical checksum. The
    validator must prove that the already-applied schema and data satisfy the
    newer frozen contract before the ledger is advanced.
    """

    compatible_by_version = {
        version: dict(migration.compatible_checksums)
        for version, migration in hooks_by_version.items()
        if migration.compatible_checksums
    }
    for version, actual_checksum in conn.execute(
        "SELECT version,checksum FROM schema_migrations ORDER BY version"
    ).fetchall():
        expected_checksum = expected_checksums.get(str(version))
        if expected_checksum is None:
            raise MigrationInvariantError(
                f"unknown migration registry row: {version}"
            )
        if actual_checksum == expected_checksum:
            continue
        validator = compatible_by_version.get(str(version), {}).get(
            str(actual_checksum)
        )
        if validator is None:
            raise RuntimeError(f"migration checksum mismatch: {version}")
        validator(conn)
        updated = conn.execute(
            "UPDATE schema_migrations SET checksum=? "
            "WHERE version=? AND checksum=?",
            (expected_checksum, version, actual_checksum),
        )
        if updated.rowcount != 1:
            raise MigrationInvariantError(
                f"migration compatibility ledger race: {version}"
            )


def _assert_existing_source_scope_binding_generations_valid(
    conn: sqlite3.Connection,
) -> None:
    if not (
        table_exists(conn, "source_scopes")
        and table_exists(conn, "source_scope_bindings")
    ):
        return
    scopes = conn.execute(
        "SELECT id, source, scope_type FROM source_scopes ORDER BY id"
    ).fetchall()
    location_types = {"GBP_LOCATION", "REVIEW_LOCATION", "LOCAL_RANK_COHORT"}
    valid_tags = {
        "GBP_LOCATION": "GBP",
        "GSC_PROPERTY": "GSC",
        "REVIEW_LOCATION": "REVIEWS",
        "LOCAL_RANK_COHORT": "LOCAL_FALCON",
    }
    for scope_id, source, scope_type in scopes:
        if valid_tags.get(str(scope_type)) != source:
            raise MigrationInvariantError(f"source_scope_tag_invalid: scope_id={scope_id}")
        rows = conn.execute(
            "SELECT merchant_id, merchant_location_id, binding_generation "
            "FROM source_scope_bindings WHERE source_scope_id = ? "
            "ORDER BY binding_generation, id",
            (scope_id,),
        ).fetchall()
        if scope_type in location_types:
            generations = [int(row[2]) for row in rows]
            if generations != list(range(1, len(rows) + 1)):
                raise MigrationInvariantError(
                    f"location_scope_generation_invalid: scope_id={scope_id}"
                )
            if any(row[1] is None for row in rows):
                raise MigrationInvariantError(
                    f"location_scope_cardinality_invalid: scope_id={scope_id}"
                )
            if table_exists(conn, "merchant_locations"):
                for merchant_id, location_id, _ in rows:
                    matches = conn.execute(
                        "SELECT 1 FROM merchant_locations WHERE id=? AND merchant_id=?",
                        (location_id, merchant_id),
                    ).fetchone()
                    if matches is None:
                        raise MigrationInvariantError(
                            f"location_scope_cardinality_invalid: scope_id={scope_id}"
                        )
        elif scope_type == "GSC_PROPERTY":
            by_merchant: dict[int, list[int]] = {}
            for merchant_id, location_id, generation in rows:
                if location_id is not None:
                    raise MigrationInvariantError(
                        f"gsc_scope_cardinality_invalid: scope_id={scope_id}"
                    )
                by_merchant.setdefault(int(merchant_id), []).append(int(generation))
            for merchant_id, generations in by_merchant.items():
                if generations != list(range(1, len(generations) + 1)):
                    raise MigrationInvariantError(
                        "gsc_scope_generation_invalid: "
                        f"scope_id={scope_id},merchant_id={merchant_id}"
                    )
        else:
            raise MigrationInvariantError(f"source_scope_tag_invalid: scope_id={scope_id}")


def _assert_legacy_fbr_links_migratable(conn: sqlite3.Connection) -> int:
    """Validate every legacy link before 0001 renames or drops its table."""
    if _object_type(conn, "merchant_fbr_links") != "table":
        raise MigrationInvariantError("legacy_fbr_table_missing")
    rows = conn.execute(
        "SELECT merchant_id,fbr_merchant_id FROM merchant_fbr_links ORDER BY merchant_id"
    ).fetchall()
    owners: dict[str, int] = {}
    for merchant_id, raw_fbr_id in rows:
        exact_id = _canonical_fbr_id(raw_fbr_id)
        if not exact_id:
            raise MigrationInvariantError(
                f"legacy_fbr_identity_invalid: merchant_id={merchant_id}"
            )
        owner = owners.get(exact_id)
        if owner is not None and owner != int(merchant_id):
            raise MigrationInvariantError(
                f"fbr_identity_interval_overlap: fbr_sha256={_sha256_text(exact_id)}"
            )
        owners[exact_id] = int(merchant_id)
    return len(rows)


def _ensure_legacy_fbr_table(conn: sqlite3.Connection) -> None:
    """Create the empty pre-0001 input table while holding the migration lock."""
    compatibility_type = _object_type(conn, "merchant_fbr_links")
    legacy_renamed = _object_type(conn, "merchant_fbr_links_legacy")
    history_type = _object_type(conn, "merchant_fbr_binding_events")
    state_type = _object_type(conn, "merchant_fbr_link_state")
    if compatibility_type == "table":
        if legacy_renamed is None and history_type is None and state_type is None:
            return
        raise MigrationInvariantError("legacy_and_migrated_fbr_objects_conflict")
    if (
        compatibility_type is None
        and legacy_renamed is None
        and history_type is None
        and state_type is None
    ):
        conn.execute(
            "CREATE TABLE merchant_fbr_links ("
            "merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,"
            "fbr_merchant_id TEXT NOT NULL,"
            "sync_status TEXT NOT NULL DEFAULT 'not_synced' "
            "CHECK (sync_status IN ('not_synced','syncing','synced','failed')),"
            "last_synced_at TEXT,last_error TEXT,created_at TEXT NOT NULL,"
            "updated_at TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE INDEX idx_merchant_fbr_links_external "
            "ON merchant_fbr_links(fbr_merchant_id)"
        )
        return
    raise MigrationInvariantError("unrecorded_or_partial_fbr_migration_schema")


def bootstrap_legacy_fbr_binding_baselines(
    conn: sqlite3.Connection, *, baseline_at: datetime, actor: str
) -> LegacyFbrBaselineResult:
    if baseline_at.tzinfo is None or baseline_at.utcoffset() != timezone.utc.utcoffset(None):
        raise MigrationInvariantError("baseline_at must be UTC")
    stamp = baseline_at.astimezone(timezone.utc).strftime(_CANONICAL_UTC_FORMAT)
    if not table_exists(conn, "merchant_fbr_links_legacy"):
        return LegacyFbrBaselineResult(0, 0, 0)
    rows = conn.execute(
        "SELECT merchant_id, fbr_merchant_id, sync_status, last_synced_at, "
        "last_error, created_at, updated_at FROM merchant_fbr_links_legacy "
        "ORDER BY merchant_id"
    ).fetchall()
    owners: dict[str, int] = {}
    for row in rows:
        exact_id = _canonical_fbr_id(row[1])
        if not exact_id:
            raise MigrationInvariantError(
                f"legacy_fbr_identity_invalid: merchant_id={row[0]}"
            )
        if exact_id in owners and owners[exact_id] != int(row[0]):
            raise MigrationInvariantError(
                f"fbr_identity_interval_overlap: fbr_sha256={_sha256_text(exact_id)}"
            )
        owners[exact_id] = int(row[0])

    inserted_events = 0
    inserted_states = 0
    for row in rows:
        merchant_id = int(row[0])
        exact_id = _canonical_fbr_id(row[1])
        if not exact_id:  # The preflight and first pass above make this unreachable.
            raise MigrationInvariantError(
                f"legacy_fbr_identity_invalid: merchant_id={merchant_id}"
            )
        existing = conn.execute(
            "SELECT id, fbr_merchant_id, generation, valid_from, open_reason "
            "FROM merchant_fbr_binding_events WHERE merchant_id = ? ORDER BY generation",
            (merchant_id,),
        ).fetchall()
        if existing:
            if len(existing) != 1 or tuple(existing[0][1:]) != (
                exact_id,
                1,
                stamp,
                "legacy_fbr_binding_baseline",
            ):
                raise MigrationInvariantError(
                    f"legacy_fbr_binding_baseline_incompatible: merchant_id={merchant_id}"
                )
            event_id = int(existing[0][0])
        else:
            cursor = conn.execute(
                "INSERT INTO merchant_fbr_binding_events("
                "merchant_id,fbr_merchant_id,generation,valid_from,opened_by,open_reason,created_at"
                ") VALUES (?,?,?,?,?,?,?)",
                (
                    merchant_id,
                    exact_id,
                    1,
                    stamp,
                    actor,
                    "legacy_fbr_binding_baseline",
                    stamp,
                ),
            )
            event_id = int(cursor.lastrowid)
            inserted_events += 1
        state = conn.execute(
            "SELECT sync_status,last_synced_at,last_error,created_at,updated_at "
            "FROM merchant_fbr_link_state WHERE merchant_id=?",
            (merchant_id,),
        ).fetchone()
        wanted_state = tuple(row[2:])
        if state is None:
            conn.execute(
                "INSERT INTO merchant_fbr_link_state(merchant_id,sync_status,last_synced_at,"
                "last_error,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                (merchant_id, *wanted_state),
            )
            inserted_states += 1
        elif tuple(state) != wanted_state:
            raise MigrationInvariantError(
                f"legacy_fbr_link_state_incompatible: merchant_id={merchant_id}"
            )
        projected = conn.execute(
            "SELECT binding_event_id,fbr_merchant_id FROM merchant_fbr_links "
            "WHERE merchant_id=?",
            (merchant_id,),
        ).fetchone()
        if projected is None or tuple(projected) != (event_id, exact_id):
            raise MigrationInvariantError(
                f"legacy_fbr_projection_invalid: merchant_id={merchant_id}"
            )
    return LegacyFbrBaselineResult(len(rows), inserted_events, inserted_states)


def _bootstrap_missing_merchant_status_baselines(
    conn: sqlite3.Connection, *, stamp: str, actor: str, reason: str
) -> None:
    for merchant_id, status in conn.execute(
        "SELECT id,status FROM merchants ORDER BY id"
    ).fetchall():
        if conn.execute(
            "SELECT 1 FROM merchant_status_events WHERE merchant_id=?", (merchant_id,)
        ).fetchone():
            continue
        conn.execute(
            "INSERT INTO merchant_status_events(merchant_id,status,effective_at,generation,"
            "actor,reason,content_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)",
            (
                merchant_id,
                status,
                stamp,
                1,
                actor,
                reason,
                _content_sha256(
                    merchant_id,
                    status,
                    stamp,
                    1,
                    actor,
                    reason,
                ),
                stamp,
            ),
        )


def _assert_performance_history_schema_present(conn: sqlite3.Connection) -> None:
    expected_objects = {
        "merchant_status_events": "table",
        "merchant_fbr_binding_events": "table",
        "merchant_fbr_link_state": "table",
        "merchant_fbr_links": "view",
    }
    for name, expected_type in expected_objects.items():
        if _object_type(conn, name) != expected_type:
            raise MigrationInvariantError(
                f"performance_history_schema_missing: object={name}"
            )
    legacy_type = _object_type(conn, "merchant_fbr_links_legacy")
    if legacy_type not in {None, "table"}:
        raise MigrationInvariantError("legacy_fbr_projection_object_invalid")
    if legacy_type == "table":
        event_count = conn.execute(
            "SELECT count(*) FROM merchant_fbr_binding_events"
        ).fetchone()[0]
        state_count = conn.execute(
            "SELECT count(*) FROM merchant_fbr_link_state"
        ).fetchone()[0]
        if event_count or state_count:
            raise MigrationInvariantError(
                "legacy_and_migrated_fbr_objects_conflict"
            )


def _assert_performance_sql_migration_prerequisite(
    conn: sqlite3.Connection, *, expected_checksum: str
) -> None:
    row = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?",
        (PERFORMANCE_MIGRATION,),
    ).fetchone()
    if row is None:
        raise MigrationInvariantError(
            "performance_lifecycle_prerequisite_missing: "
            f"{PERFORMANCE_MIGRATION}"
        )
    if row[0] != expected_checksum:
        raise RuntimeError(f"migration checksum mismatch: {PERFORMANCE_MIGRATION}")


def run_performance_lifecycle_baseline_migration_hook(
    conn: sqlite3.Connection,
    migration_instant: str,
    *,
    performance_sql_checksum: str,
) -> None:
    """Apply the frozen forward lifecycle baseline under the runner transaction."""

    _assert_performance_sql_migration_prerequisite(
        conn, expected_checksum=performance_sql_checksum
    )
    _assert_performance_history_schema_present(conn)
    _assert_merchant_status_history_valid(conn, allow_missing=True)
    _assert_fbr_binding_history_valid(conn)
    instant = datetime.strptime(migration_instant, _CANONICAL_UTC_FORMAT).replace(
        tzinfo=timezone.utc
    )
    actor = "schema_migration:0003_performance_lifecycle_baseline"
    if table_exists(conn, "merchant_fbr_links_legacy"):
        baseline = bootstrap_legacy_fbr_binding_baselines(
            conn, baseline_at=instant, actor=actor
        )
        if (
            baseline.events_inserted != baseline.rows_seen
            or baseline.states_inserted != baseline.rows_seen
        ):
            raise MigrationInvariantError(
                "legacy_fbr_projection_not_one_to_one: "
                f"expected={baseline.rows_seen},"
                f"actual={(baseline.events_inserted, baseline.states_inserted)}"
            )
        conn.execute("DROP TABLE merchant_fbr_links_legacy")
    _bootstrap_missing_merchant_status_baselines(
        conn,
        stamp=migration_instant,
        actor=actor,
        reason="lifecycle_gap_baseline",
    )
    assert_migration_postconditions(
        conn, version=PERFORMANCE_LIFECYCLE_MIGRATION
    )


def _assert_merchant_status_history_valid(
    conn: sqlite3.Connection, *, allow_missing: bool = False
) -> None:
    if not table_exists(conn, "merchant_status_events"):
        raise MigrationInvariantError("merchant_status_history_missing")
    for merchant_id, current_status in conn.execute(
        "SELECT id,status FROM merchants ORDER BY id"
    ).fetchall():
        events = conn.execute(
            "SELECT id,status,effective_at,generation,actor,reason,content_sha256 "
            "FROM merchant_status_events WHERE merchant_id=? ORDER BY generation",
            (merchant_id,),
        ).fetchall()
        if not events:
            if allow_missing:
                continue
            raise MigrationInvariantError(
                f"merchant_status_history_missing: merchant_id={merchant_id}"
            )
        generations = [int(event[3]) for event in events]
        if generations != list(range(1, len(events) + 1)):
            raise MigrationInvariantError(
                f"merchant_status_generation_invalid: merchant_id={merchant_id}"
            )
        for event in events:
            event_id, status, effective_at, generation, actor, reason, digest = event
            if not str(actor).strip() or not str(reason).strip():
                raise MigrationInvariantError(
                    f"merchant_status_provenance_missing: event_id={event_id}"
                )
            expected_digest = _content_sha256(
                merchant_id,
                status,
                effective_at,
                generation,
                actor,
                reason,
            )
            if digest != expected_digest:
                raise MigrationInvariantError(
                    f"merchant_status_hash_invalid: event_id={event_id}"
                )
        if events[-1][1] != current_status:
            raise MigrationInvariantError(
                f"merchant_status_latest_mismatch: merchant_id={merchant_id}"
            )


def _assert_fbr_binding_history_valid(conn: sqlite3.Connection) -> None:
    """Replay the complete FBR binding projection from its immutable events."""

    rows = conn.execute(
        "SELECT id,merchant_id,fbr_merchant_id,canonical_fbr_merchant_sha256,"
        "generation,valid_from,valid_to,opened_by,open_reason,content_sha256,"
        "closed_by,close_reason,close_content_sha256,created_at "
        "FROM merchant_fbr_binding_events ORDER BY merchant_id,generation"
    ).fetchall()
    chains: dict[int, list[Any]] = {}
    identity_intervals: dict[str, list[tuple[str, str | None, int]]] = {}
    for row in rows:
        merchant_id = int(row[1])
        chains.setdefault(merchant_id, []).append(row)
        identity_intervals.setdefault(str(row[2]), []).append(
            (str(row[5]), None if row[6] is None else str(row[6]), int(row[0]))
        )

    state_merchants = {
        int(row[0])
        for row in conn.execute(
            "SELECT merchant_id FROM merchant_fbr_link_state ORDER BY merchant_id"
        ).fetchall()
    }
    event_merchants = set(chains)
    if event_merchants != state_merchants:
        raise MigrationInvariantError(
            "fbr_binding_state_set_mismatch: "
            f"events={sorted(event_merchants)},states={sorted(state_merchants)}"
        )

    projection_rows = conn.execute(
        "SELECT merchant_id,binding_event_id,fbr_merchant_id "
        "FROM merchant_fbr_links ORDER BY merchant_id"
    ).fetchall()
    projection_by_merchant = {int(row[0]): row for row in projection_rows}
    if (
        len(projection_by_merchant) != len(projection_rows)
        or set(projection_by_merchant) != event_merchants
    ):
        raise MigrationInvariantError(
            "fbr_binding_projection_set_mismatch: "
            f"events={sorted(event_merchants)},"
            f"projection={sorted(projection_by_merchant)}"
        )

    for merchant_id, events in chains.items():
        generations = [int(event[4]) for event in events]
        if generations != list(range(1, len(events) + 1)):
            raise MigrationInvariantError(
                f"fbr_binding_generation_invalid: merchant_id={merchant_id}"
            )

        for index, event in enumerate(events):
            (
                event_id,
                _merchant_id,
                fbr_merchant_id,
                identity_digest,
                generation,
                valid_from,
                valid_to,
                opened_by,
                open_reason,
                open_digest,
                closed_by,
                close_reason,
                close_digest,
                created_at,
            ) = event
            canonical_fbr_id = _canonical_fbr_id(fbr_merchant_id)
            if (
                not canonical_fbr_id
                or canonical_fbr_id != fbr_merchant_id
                or not isinstance(opened_by, str)
                or not opened_by.strip()
                or not isinstance(open_reason, str)
                or not open_reason.strip()
                or not _is_canonical_utc_instant(valid_from)
                or not _is_canonical_utc_instant(created_at)
            ):
                raise MigrationInvariantError(
                    f"fbr_binding_provenance_invalid: event_id={event_id}"
                )
            if (
                identity_digest != _fbr_identity_sha256(fbr_merchant_id)
                or open_digest
                != _fbr_binding_open_sha256(
                    merchant_id,
                    fbr_merchant_id,
                    generation,
                    valid_from,
                    opened_by,
                    open_reason,
                )
            ):
                raise MigrationInvariantError(
                    f"fbr_binding_hash_invalid: event_id={event_id}"
                )

            is_current = index == len(events) - 1
            if is_current:
                if any(
                    value is not None
                    for value in (valid_to, closed_by, close_reason, close_digest)
                ):
                    raise MigrationInvariantError(
                        f"fbr_binding_current_event_closed: merchant_id={merchant_id}"
                    )
                projected = projection_by_merchant[merchant_id]
                if int(projected[1]) != int(event_id) or projected[2] != fbr_merchant_id:
                    raise MigrationInvariantError(
                        f"fbr_binding_projection_invalid: merchant_id={merchant_id}"
                    )
                continue

            if (
                not _is_canonical_utc_instant(valid_to)
                or valid_to <= valid_from
                or not isinstance(closed_by, str)
                or not closed_by.strip()
                or not isinstance(close_reason, str)
                or not close_reason.strip()
                or close_digest
                != _fbr_binding_close_sha256(
                    event_id,
                    open_digest,
                    valid_to,
                    closed_by,
                    close_reason,
                )
            ):
                raise MigrationInvariantError(
                    f"fbr_binding_close_invalid: event_id={event_id}"
                )
            next_valid_from = events[index + 1][5]
            if next_valid_from < valid_to:
                raise MigrationInvariantError(
                    f"fbr_binding_interval_overlap: merchant_id={merchant_id}"
                )

    for exact_id, intervals in identity_intervals.items():
        ordered = sorted(intervals, key=lambda interval: (interval[0], interval[2]))
        for previous, current in zip(ordered, ordered[1:]):
            if previous[1] is None or current[0] < previous[1]:
                raise MigrationInvariantError(
                    "fbr_identity_interval_overlap: "
                    f"fbr_sha256={_sha256_text(exact_id)}"
                )


def assert_migration_postconditions(
    conn: sqlite3.Connection,
    *,
    version: str,
    expected_legacy_fbr_rows: int | None = None,
) -> None:
    if version == RUN_DISPATCH_MIGRATION:
        assert_run_dispatch_migration_postconditions(conn)
        return
    if version not in {
        PERFORMANCE_MIGRATION,
        PERFORMANCE_LIFECYCLE_MIGRATION,
    }:
        return
    _assert_performance_delete_guard_postcondition(conn)
    _assert_performance_history_schema_present(conn)
    lifecycle_complete = version == PERFORMANCE_LIFECYCLE_MIGRATION
    if lifecycle_complete and table_exists(conn, "merchant_fbr_links_legacy"):
        raise MigrationInvariantError("legacy_fbr_table_not_removed")
    if lifecycle_complete:
        _assert_fbr_binding_history_valid(conn)
    if expected_legacy_fbr_rows is not None:
        counts = (
            conn.execute("SELECT count(*) FROM merchant_fbr_binding_events").fetchone()[0],
            conn.execute("SELECT count(*) FROM merchant_fbr_link_state").fetchone()[0],
            conn.execute("SELECT count(*) FROM merchant_fbr_links").fetchone()[0],
        )
        if counts != (expected_legacy_fbr_rows,) * 3:
            raise MigrationInvariantError(
                "legacy_fbr_projection_not_one_to_one: "
                f"expected={expected_legacy_fbr_rows},actual={counts}"
            )
    _assert_merchant_status_history_valid(
        conn, allow_missing=not lifecycle_complete
    )
    _assert_existing_source_scope_binding_generations_valid(conn)


def _assert_performance_delete_guard_postcondition(
    conn: sqlite3.Connection,
) -> None:
    """Require 0001's exact durable-history delete guard once recorded."""

    if not table_exists(conn, "schema_migrations"):
        return
    columns = _migration_ledger_columns(conn)
    if columns != {"version", "checksum", "applied_at"}:
        return
    recorded = conn.execute(
        "SELECT 1 FROM schema_migrations WHERE version=?",
        (PERFORMANCE_MIGRATION,),
    ).fetchone()
    if recorded is None:
        return
    row = conn.execute(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?",
        (PERFORMANCE_DELETE_GUARD_NAME,),
    ).fetchone()
    expected_sql = performance_delete_guard_contract_sql()
    if (
        row is None
        or row[0] != "trigger"
        or row[1] != "merchants"
        or not isinstance(row[2], str)
        or " ".join(row[2].strip().rstrip(";").split())
        != " ".join(expected_sql.strip().rstrip(";").split())
    ):
        raise MigrationInvariantError(
            "performance_delete_guard_contract_mismatch"
        )


def _assert_recorded_migration_postconditions(
    conn: sqlite3.Connection,
) -> None:
    """Revalidate repository-owned postconditions on every cold start."""

    for (version,) in conn.execute(
        "SELECT version FROM schema_migrations ORDER BY version"
    ).fetchall():
        assert_migration_postconditions(conn, version=str(version))


def apply_migrations(
    conn: sqlite3.Connection,
    migrations_dir: Path = MIGRATIONS_DIR,
    *,
    python_migrations: tuple[PythonMigration, ...] = (),
    only_versions: frozenset[str] | None = None,
) -> list[str]:
    if conn.in_transaction:
        raise MigrationInvariantError("migration_connection_has_active_transaction")
    register_sqlite_invariants(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    applied: list[str] = []
    sql_by_version = {
        version: (payload, checksum)
        for _path, version, payload, checksum in _migration_files(migrations_dir)
    }
    hooks_by_version = _all_python_migrations(
        migrations_dir,
        sql_by_version,
        python_migrations,
    )
    expected_checksums = _registered_migration_checksums(
        sql_by_version,
        hooks_by_version,
    )
    versions = sorted(expected_checksums)
    if only_versions is None:
        executable_versions = versions
    else:
        unknown_versions = sorted(set(only_versions) - set(versions))
        if unknown_versions:
            raise MigrationInvariantError(
                f"unknown requested migration versions: {unknown_versions!r}"
            )
        executable_versions = [
            version for version in versions if version in only_versions
        ]

    legacy_adoptions: dict[
        frozenset[str],
        tuple[str, str, Callable[[sqlite3.Connection], None]],
    ] = {}
    for migration in hooks_by_version.values():
        if not migration.legacy_ledger_names:
            continue
        validator = migration.validate_legacy_adoption
        if validator is None:  # Guarded while the hook registry is validated.
            raise AssertionError(
                f"migration adoption validator was lost: {migration.version}"
            )
        marker_set = frozenset(migration.legacy_ledger_names)
        if marker_set in legacy_adoptions:
            raise MigrationInvariantError(
                "duplicate legacy migration marker contract: "
                f"{','.join(sorted(marker_set))}"
            )
        legacy_adoptions[marker_set] = (
            migration.version,
            expected_checksums[migration.version],
            validator,
        )

    if not executable_versions:
        try:
            conn.execute("BEGIN IMMEDIATE")
            ensure_migration_ledger(conn, legacy_adoptions=legacy_adoptions)
            _assert_existing_source_scope_binding_generations_valid(conn)
            _upgrade_compatible_migration_checksums(
                conn,
                expected_checksums=expected_checksums,
                hooks_by_version=hooks_by_version,
            )
            assert_migration_registry_checksums(
                conn, migrations_dir, expected_checksums=expected_checksums
            )
            _assert_recorded_migration_postconditions(conn)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return applied

    for version in executable_versions:
        sql_migration = sql_by_version.get(version)
        python_migration = hooks_by_version.get(version)
        payload = None if sql_migration is None else sql_migration[0]
        checksum = expected_checksums[version]
        disable_foreign_keys = bool(
            python_migration is not None and python_migration.foreign_keys_off
        )
        if disable_foreign_keys:
            conn.execute("PRAGMA foreign_keys = OFF")
        try:
            # The ledger and every preflight are deliberately read only after this
            # writer lock. A waiter must observe the winner's committed registry row.
            conn.execute("BEGIN IMMEDIATE")
            ensure_migration_ledger(conn, legacy_adoptions=legacy_adoptions)
            _assert_existing_source_scope_binding_generations_valid(conn)
            _upgrade_compatible_migration_checksums(
                conn,
                expected_checksums=expected_checksums,
                hooks_by_version=hooks_by_version,
            )
            assert_migration_registry_checksums(
                conn, migrations_dir, expected_checksums=expected_checksums
            )
            _assert_recorded_migration_postconditions(conn)
            existing = conn.execute(
                "SELECT checksum FROM schema_migrations WHERE version = ?",
                (version,),
            ).fetchone()
            if existing is not None:
                if existing[0] != checksum:
                    raise RuntimeError(f"migration checksum mismatch: {version}")
                assert_migration_postconditions(conn, version=version)
                conn.commit()
                continue

            if version == PERFORMANCE_MIGRATION:
                _ensure_legacy_fbr_table(conn)
                _assert_legacy_fbr_links_migratable(conn)
            stamp = datetime.now(timezone.utc).strftime(_CANONICAL_UTC_FORMAT)
            if payload is not None:
                _execute_sql_payload(conn, payload)
            if python_migration is not None:
                python_migration.apply(conn, stamp)
            if disable_foreign_keys:
                foreign_key_errors = conn.execute(
                    "PRAGMA foreign_key_check"
                ).fetchall()
                if foreign_key_errors:
                    raise MigrationInvariantError(
                        "python migration foreign_key_check failed: "
                        f"{foreign_key_errors!r}"
                    )
            assert_migration_postconditions(
                conn,
                version=version,
            )
            conn.execute(
                "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
                (version, checksum, stamp),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            if disable_foreign_keys:
                conn.execute("PRAGMA foreign_keys = ON")
        applied.append(version)
    return applied

from __future__ import annotations

import hashlib
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_NAME = re.compile(r"^(?P<version>\d{4}_[a-z0-9_]+)\.sql$")
MIGRATION_VERSION = re.compile(r"^\d{4}_[a-z0-9_]+$")
_CANONICAL_UTC_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
_PYTHON_MIGRATION_CHECKSUM_PREFIX = "seo-ops-python-migration-v1:"
_EXTERNAL_CANONICAL_MIGRATIONS = {
    "0001_performance_history": (
        "3eb1f10f2e7b3b102ab626bae3097e584210320618ef92e19936cdded8be6db5"
    )
}


class MigrationInvariantError(RuntimeError):
    """Raised before commit when persisted migration state is contradictory."""


@dataclass(frozen=True)
class PythonMigration:
    """An explicitly registered, transaction-owned application migration."""

    version: str
    checksum: str
    apply: Callable[[sqlite3.Connection, str], None]
    foreign_keys_off: bool = False
    legacy_ledger_names: tuple[str, ...] = ()
    validate_legacy_adoption: Callable[[sqlite3.Connection], None] | None = None


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        is not None
    )


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")]


def python_migration_checksum(version: str, *, contract: str) -> str:
    """Hash a frozen migration contract rather than an evolving runtime module."""

    if MIGRATION_VERSION.fullmatch(version) is None:
        raise ValueError("invalid Python migration version")
    if not isinstance(contract, str) or not contract.strip():
        raise ValueError("Python migration contract is required")
    return hashlib.sha256(
        f"{_PYTHON_MIGRATION_CHECKSUM_PREFIX}{version}:{contract.strip()}".encode(
            "utf-8"
        )
    ).hexdigest()


def _migration_files(
    migrations_dir: Path = MIGRATIONS_DIR,
) -> list[tuple[Path, str, bytes, str]]:
    result: list[tuple[Path, str, bytes, str]] = []
    for path in sorted(migrations_dir.glob("*.sql")):
        match = MIGRATION_NAME.fullmatch(path.name)
        if match is None:
            raise MigrationInvariantError(f"invalid migration filename: {path.name}")
        version = match.group("version")
        payload = path.read_bytes()
        result.append((path, version, payload, hashlib.sha256(payload).hexdigest()))
    return result


def _execute_sql_payload(conn: sqlite3.Connection, payload: bytes) -> None:
    """Execute SQL without executescript releasing the migration transaction."""

    pending: list[str] = []
    for line in payload.decode("utf-8").splitlines(keepends=True):
        pending.append(line)
        statement = "".join(pending)
        if sqlite3.complete_statement(statement):
            conn.execute(statement)
            pending.clear()
    if "".join(pending).strip():
        raise sqlite3.OperationalError("incomplete migration SQL statement")


def _normalize_migration_registry(
    conn: sqlite3.Connection,
    python_migrations: tuple[PythonMigration, ...],
) -> None:
    """Upgrade the former Task-only ledger while holding the writer lock.

    The enclosing transaction makes both the ledger conversion and task data
    conversion atomic.
    """

    if not _table_exists(conn, "schema_migrations"):
        conn.execute(
            "CREATE TABLE schema_migrations ("
            "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        return

    columns = _table_columns(conn, "schema_migrations")
    if columns == ["version", "checksum", "applied_at"]:
        return
    if columns != ["name", "applied_at"]:
        raise MigrationInvariantError(
            f"unsupported schema_migrations columns: {columns!r}"
        )

    legacy_rows = [
        (str(row[0]), str(row[1]))
        for row in conn.execute(
            "SELECT name,applied_at FROM schema_migrations ORDER BY name"
        ).fetchall()
    ]
    markers = [name for name, _applied_at in legacy_rows]
    migration_by_legacy_names = {
        frozenset(migration.legacy_ledger_names): migration
        for migration in python_migrations
        if migration.legacy_ledger_names
    }
    folded_migration = migration_by_legacy_names.get(frozenset(markers))
    if markers and folded_migration is None:
        known_legacy_names = {
            name
            for migration in python_migrations
            for name in migration.legacy_ledger_names
        }
        unknown = sorted(set(markers) - known_legacy_names)
        if unknown:
            raise MigrationInvariantError(
                f"unknown legacy migration registry rows: {unknown!r}"
            )
        raise MigrationInvariantError(
            f"partial legacy task migration registry: {markers!r}"
        )
    if folded_migration is not None:
        validator = folded_migration.validate_legacy_adoption
        if validator is None:
            raise MigrationInvariantError(
                "legacy migration adoption is missing its validator: "
                f"{folded_migration.version}"
            )
        validator(conn)
    if _table_exists(conn, "_legacy_task_schema_migrations"):
        raise MigrationInvariantError("stale legacy task migration registry exists")
    conn.execute(
        "ALTER TABLE schema_migrations RENAME TO _legacy_task_schema_migrations"
    )
    conn.execute(
        "CREATE TABLE schema_migrations ("
        "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
    )
    if folded_migration is not None and legacy_rows:
        conn.execute(
            "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
            (
                folded_migration.version,
                folded_migration.checksum,
                max(applied_at for _version, applied_at in legacy_rows),
            ),
        )
    conn.execute("DROP TABLE _legacy_task_schema_migrations")


def assert_migration_registry_checksums(
    conn: sqlite3.Connection,
    migrations_dir: Path = MIGRATIONS_DIR,
    *,
    python_migrations: tuple[PythonMigration, ...] = (),
) -> None:
    """Validate every migration artifact this checkout knows how to execute.

    Canonical rows from another feature branch are preserved. Once branches are
    integrated, their migration files make those rows known and checksum-checked
    by the same runner.
    """

    if not _table_exists(conn, "schema_migrations"):
        return
    columns = _table_columns(conn, "schema_migrations")
    if columns != ["version", "checksum", "applied_at"]:
        raise MigrationInvariantError(
            f"unsupported schema_migrations columns: {columns!r}"
        )
    expected = {
        version: checksum
        for _path, version, _payload, checksum in _migration_files(migrations_dir)
    }
    for migration in python_migrations:
        if migration.version in expected:
            raise MigrationInvariantError(
                f"duplicate migration version: {migration.version}"
            )
        expected[migration.version] = migration.checksum
    for version, checksum in conn.execute(
        "SELECT version,checksum FROM schema_migrations ORDER BY version"
    ):
        expected_checksum = expected.get(str(version))
        if expected_checksum is None:
            expected_checksum = _EXTERNAL_CANONICAL_MIGRATIONS.get(str(version))
        if expected_checksum is None:
            raise MigrationInvariantError(f"unknown migration registry row: {version}")
        if checksum != expected_checksum:
            raise RuntimeError(f"migration checksum mismatch: {version}")


def apply_migrations(
    conn: sqlite3.Connection,
    migrations_dir: Path = MIGRATIONS_DIR,
    *,
    python_migrations: tuple[PythonMigration, ...] = (),
) -> list[str]:
    if conn.in_transaction:
        raise MigrationInvariantError("migration_connection_has_active_transaction")

    sql_migrations = _migration_files(migrations_dir)
    for migration in python_migrations:
        if MIGRATION_VERSION.fullmatch(migration.version) is None:
            raise ValueError(f"invalid Python migration version: {migration.version}")
        if re.fullmatch(r"[a-f0-9]{64}", migration.checksum) is None:
            raise ValueError(f"invalid Python migration checksum: {migration.version}")
        if len(set(migration.legacy_ledger_names)) != len(
            migration.legacy_ledger_names
        ) or any(
            not isinstance(name, str) or not name
            for name in migration.legacy_ledger_names
        ):
            raise ValueError(
                f"invalid legacy migration marker contract: {migration.version}"
            )
        if migration.legacy_ledger_names and migration.validate_legacy_adoption is None:
            raise ValueError(
                f"legacy migration validator is required: {migration.version}"
            )
        if not migration.legacy_ledger_names and migration.validate_legacy_adoption:
            raise ValueError(
                f"legacy migration names are required: {migration.version}"
            )
    versions = [version for _path, version, _payload, _checksum in sql_migrations]
    versions.extend(migration.version for migration in python_migrations)
    if len(set(versions)) != len(versions):
        raise MigrationInvariantError("duplicate migration version")
    entries: list[tuple[str, str, bytes | PythonMigration, str]] = [
        (version, "sql", payload, checksum)
        for _path, version, payload, checksum in sql_migrations
    ]
    entries.extend(
        (migration.version, "python", migration, migration.checksum)
        for migration in python_migrations
    )

    applied: list[str] = []
    if not entries:
        try:
            conn.execute("BEGIN IMMEDIATE")
            _normalize_migration_registry(conn, python_migrations)
            assert_migration_registry_checksums(
                conn, migrations_dir, python_migrations=python_migrations
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return applied

    for version, kind, payload_or_migration, checksum in sorted(entries):
        foreign_keys_off = (
            kind == "python"
            and isinstance(payload_or_migration, PythonMigration)
            and payload_or_migration.foreign_keys_off
        )
        if foreign_keys_off:
            conn.execute("PRAGMA foreign_keys = OFF")
        try:
            conn.execute("BEGIN IMMEDIATE")
            _normalize_migration_registry(conn, python_migrations)
            assert_migration_registry_checksums(
                conn, migrations_dir, python_migrations=python_migrations
            )
            existing = conn.execute(
                "SELECT checksum FROM schema_migrations WHERE version=?", (version,)
            ).fetchone()
            if existing is not None:
                if existing[0] != checksum:
                    raise RuntimeError(f"migration checksum mismatch: {version}")
                conn.commit()
                continue

            stamp = datetime.now(timezone.utc).strftime(_CANONICAL_UTC_FORMAT)
            if kind == "sql":
                if not isinstance(payload_or_migration, bytes):
                    raise MigrationInvariantError("invalid SQL migration registration")
                _execute_sql_payload(conn, payload_or_migration)
            else:
                if not isinstance(payload_or_migration, PythonMigration):
                    raise MigrationInvariantError(
                        "invalid Python migration registration"
                    )
                payload_or_migration.apply(conn, stamp)
            if foreign_keys_off:
                foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
                if foreign_key_errors:
                    raise MigrationInvariantError(
                        "python migration foreign_key_check failed: "
                        f"{foreign_key_errors!r}"
                    )
            conn.execute(
                "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
                (version, checksum, stamp),
            )
            conn.commit()
            applied.append(version)
        except Exception:
            conn.rollback()
            raise
        finally:
            if foreign_keys_off:
                conn.execute("PRAGMA foreign_keys = ON")
    return applied


__all__ = [
    "MIGRATIONS_DIR",
    "MigrationInvariantError",
    "PythonMigration",
    "apply_migrations",
    "assert_migration_registry_checksums",
    "python_migration_checksum",
]

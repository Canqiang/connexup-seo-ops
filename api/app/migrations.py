from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"
MIGRATION_NAME = re.compile(r"^(?P<version>\d{4}_[a-z0-9_]+)\.sql$")
PERFORMANCE_MIGRATION = "0001_performance_history"
_CANONICAL_UTC_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"


class MigrationInvariantError(RuntimeError):
    """Raised before commit when persisted schema or history is contradictory."""


@dataclass(frozen=True)
class LegacyFbrBaselineResult:
    rows_seen: int
    events_inserted: int
    states_inserted: int


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


def assert_migration_registry_checksums(
    conn: sqlite3.Connection, migrations_dir: Path = MIGRATIONS_DIR
) -> None:
    if not table_exists(conn, "schema_migrations"):
        return
    expected = {
        version: checksum
        for _, version, _, checksum in _migration_files(migrations_dir)
    }
    for version, checksum in conn.execute(
        "SELECT version, checksum FROM schema_migrations ORDER BY version"
    ):
        if version not in expected:
            raise MigrationInvariantError(f"unknown migration registry row: {version}")
        if checksum != expected[version]:
            raise RuntimeError(f"migration checksum mismatch: {version}")


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


def _bootstrap_legacy_merchant_status_baselines(
    conn: sqlite3.Connection, *, stamp: str, actor: str
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
                "legacy_status_baseline",
                _content_sha256(
                    merchant_id,
                    status,
                    stamp,
                    1,
                    actor,
                    "legacy_status_baseline",
                ),
                stamp,
            ),
        )


def run_migration_data_hook(
    conn: sqlite3.Connection, *, version: str, migration_instant: str
) -> LegacyFbrBaselineResult | None:
    if version != PERFORMANCE_MIGRATION:
        return None
    instant = datetime.strptime(migration_instant, _CANONICAL_UTC_FORMAT).replace(
        tzinfo=timezone.utc
    )
    actor = "schema_migration:0001_performance_history"
    result = bootstrap_legacy_fbr_binding_baselines(
        conn, baseline_at=instant, actor=actor
    )
    _bootstrap_legacy_merchant_status_baselines(
        conn, stamp=migration_instant, actor=actor
    )
    conn.execute("DROP TABLE merchant_fbr_links_legacy")
    return result


def assert_migration_postconditions(
    conn: sqlite3.Connection,
    *,
    version: str,
    expected_legacy_fbr_rows: int | None = None,
) -> None:
    if version != PERFORMANCE_MIGRATION:
        return
    if _object_type(conn, "merchant_fbr_links") != "view":
        raise MigrationInvariantError("merchant_fbr_links_projection_missing")
    if table_exists(conn, "merchant_fbr_links_legacy"):
        raise MigrationInvariantError("legacy_fbr_table_not_removed")
    bad_state = conn.execute(
        "SELECT state.merchant_id FROM merchant_fbr_link_state state "
        "LEFT JOIN merchant_fbr_links link ON link.merchant_id=state.merchant_id "
        "WHERE link.binding_event_id IS NULL LIMIT 1"
    ).fetchone()
    if bad_state is not None:
        raise MigrationInvariantError(
            f"fbr_projection_missing_open_event: merchant_id={bad_state[0]}"
        )
    bad_hash = conn.execute(
        "SELECT id FROM merchant_fbr_binding_events "
        "WHERE canonical_fbr_merchant_sha256 != fbr_identity_sha256(fbr_merchant_id) "
        "OR content_sha256 != fbr_binding_open_sha256(merchant_id,fbr_merchant_id,"
        "generation,valid_from,opened_by,open_reason) LIMIT 1"
    ).fetchone()
    if bad_hash is not None:
        raise MigrationInvariantError(f"fbr_binding_hash_invalid: event_id={bad_hash[0]}")
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
    _assert_existing_source_scope_binding_generations_valid(conn)


def apply_migrations(
    conn: sqlite3.Connection, migrations_dir: Path = MIGRATIONS_DIR
) -> list[str]:
    if conn.in_transaction:
        raise MigrationInvariantError("migration_connection_has_active_transaction")
    register_sqlite_invariants(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    applied: list[str] = []
    migrations = _migration_files(migrations_dir)
    if not migrations:
        try:
            conn.execute("BEGIN IMMEDIATE")
            _assert_existing_source_scope_binding_generations_valid(conn)
            assert_migration_registry_checksums(conn, migrations_dir)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return applied

    for _path, version, payload, checksum in migrations:
        try:
            # The ledger and every preflight are deliberately read only after this
            # writer lock. A waiter must observe the winner's committed registry row.
            conn.execute("BEGIN IMMEDIATE")
            _assert_existing_source_scope_binding_generations_valid(conn)
            assert_migration_registry_checksums(conn, migrations_dir)
            existing = (
                conn.execute(
                    "SELECT checksum FROM schema_migrations WHERE version = ?",
                    (version,),
                ).fetchone()
                if table_exists(conn, "schema_migrations")
                else None
            )
            if existing is not None:
                if existing[0] != checksum:
                    raise RuntimeError(f"migration checksum mismatch: {version}")
                conn.commit()
                continue

            expected_legacy_fbr_rows = None
            if version == PERFORMANCE_MIGRATION:
                _ensure_legacy_fbr_table(conn)
                expected_legacy_fbr_rows = _assert_legacy_fbr_links_migratable(conn)
            stamp = datetime.now(timezone.utc).strftime(_CANONICAL_UTC_FORMAT)
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)"
            )
            _execute_sql_payload(conn, payload)
            baseline = run_migration_data_hook(
                conn, version=version, migration_instant=stamp
            )
            if (
                expected_legacy_fbr_rows is not None
                and (baseline is None or baseline.rows_seen != expected_legacy_fbr_rows)
            ):
                raise MigrationInvariantError(
                    "legacy_fbr_projection_not_one_to_one: "
                    f"expected={expected_legacy_fbr_rows},"
                    f"actual={None if baseline is None else baseline.rows_seen}"
                )
            assert_migration_postconditions(
                conn,
                version=version,
                expected_legacy_fbr_rows=expected_legacy_fbr_rows,
            )
            conn.execute(
                "INSERT INTO schema_migrations(version,checksum,applied_at) VALUES (?,?,?)",
                (version, checksum, stamp),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        applied.append(version)
    return applied

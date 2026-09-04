import hashlib
import importlib
import sqlite3
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.db import init_db


FIXTURES = Path(__file__).parent / "fixtures"
NOW = "2026-09-03T10:00:00.000000Z"
T0 = "2026-09-03T10:00:00.000000Z"
T1 = "2026-09-03T11:00:00.000000Z"
T2 = "2026-09-03T12:00:00.000000Z"
PERFORMANCE_TABLES = (
    "merchant_locations",
    "merchant_status_events",
    "merchant_location_status_events",
    "merchant_fbr_binding_events",
    "merchant_fbr_link_state",
    "merchant_location_aliases",
    "merchant_location_alias_evidence_points",
    "source_scopes",
    "source_scope_bindings",
    "metric_sync_jobs",
    "metric_sync_job_merchants",
    "metric_sync_batches",
    "metric_source_artifacts",
    "metric_observations",
    "metric_observation_heads",
    "data_quality_events",
    "storage_capacity_samples",
    "operator_command_ledger",
)


def migrations_api():
    return importlib.import_module("app.migrations")


def open_database(database):
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    migrations_api().register_sqlite_invariants(conn)
    return conn


def build_legacy_database(database):
    conn = sqlite3.connect(database)
    conn.executescript((FIXTURES / "legacy_schema.sql").read_text())
    conn.commit()
    conn.close()
    return database


def build_legacy_database_with_duplicate_current_fbr_identity(database):
    build_legacy_database(database)
    conn = sqlite3.connect(database)
    conn.execute(
        "INSERT INTO merchants(id,name,status,created_at) VALUES (3,'Duplicate','active',?)",
        ("2024-03-01T00:00:00.000000Z",),
    )
    conn.execute(
        "INSERT INTO merchant_fbr_links(merchant_id,fbr_merchant_id,sync_status,"
        "created_at,updated_at) VALUES (3,'legacy-fbr-merchant-001','not_synced',?,?)",
        ("2024-03-01T00:00:00.000000Z", "2024-03-01T00:00:00.000000Z"),
    )
    conn.commit()
    conn.close()
    return database


def build_legacy_database_with_blank_fbr_identity(database, fbr_merchant_id):
    build_legacy_database(database)
    conn = sqlite3.connect(database)
    conn.execute(
        "UPDATE merchant_fbr_links SET fbr_merchant_id=? WHERE merchant_id=1",
        (fbr_merchant_id,),
    )
    conn.commit()
    conn.close()
    return database


def _hash_rows(conn, table, columns):
    quoted = ",".join(f'"{column}"' for column in columns)
    rows = conn.execute(f'SELECT {quoted} FROM "{table}" ORDER BY {quoted}').fetchall()
    return hashlib.sha256(repr([tuple(row) for row in rows]).encode()).hexdigest()


def legacy_evidence_hashes(database):
    conn = sqlite3.connect(database)
    result = {
        "merchants": _hash_rows(conn, "merchants", ["id", "name", "status", "notes", "created_at"]),
        "fbr": _hash_rows(
            conn,
            "merchant_fbr_links",
            ["merchant_id", "fbr_merchant_id", "sync_status", "last_synced_at", "last_error", "created_at", "updated_at"],
        ),
        "profiles": _hash_rows(conn, "merchant_gbp_profiles", ["id", "normalized_json", "synced_at"]),
        "tasks": _hash_rows(conn, "tasks", ["id", "title", "evidence_note", "created_at"]),
        "audits": _hash_rows(conn, "audit_snapshots", ["id", "payload_json", "accepted_at"]),
        "rank": _hash_rows(conn, "merchant_local_falcon_reports", ["id", "report_key", "grid_points_json"]),
    }
    conn.close()
    return result


def performance_table_counts(database):
    conn = open_database(database)
    counts = {name: conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in PERFORMANCE_TABLES}
    conn.close()
    return counts


def migration_versions(database):
    conn = sqlite3.connect(database)
    if not table_exists(conn, "schema_migrations"):
        conn.close()
        return []
    versions = [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
    conn.close()
    return versions


def migration_versions_from_conn(conn):
    if not table_exists(conn, "schema_migrations"):
        return []
    return [row[0] for row in conn.execute("SELECT version FROM schema_migrations ORDER BY version")]


def integrity_results(database):
    conn = open_database(database)
    integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
    foreign_keys = [tuple(row) for row in conn.execute("PRAGMA foreign_key_check")]
    conn.close()
    return integrity, foreign_keys


def exact_database_fingerprint(database):
    conn = open_database(database)
    objects = [
        tuple(row)
        for row in conn.execute(
            "SELECT type,name,tbl_name,sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name"
        )
    ]
    tables = [row[1] for row in objects if row[0] == "table"]
    contents = []
    for table in tables:
        rows = [tuple(row) for row in conn.execute(f'SELECT * FROM "{table}" ORDER BY rowid')]
        contents.append((table, rows))
    conn.close()
    return hashlib.sha256(repr((objects, contents)).encode()).hexdigest()


def run_init_db_in_fresh_process(database):
    subprocess.run(
        [sys.executable, "-c", "from app.db import init_db; init_db()"],
        cwd=Path(__file__).parents[1],
        env={**__import__("os").environ, "SEO_OPS_DB": str(database)},
        check=True,
        capture_output=True,
        text=True,
    )


def sqlite_object_type(database, name):
    conn = sqlite3.connect(database)
    row = conn.execute("SELECT type FROM sqlite_master WHERE name=?", (name,)).fetchone()
    conn.close()
    return None if row is None else row[0]


def index_exists_at_path(database, name):
    return sqlite_object_type(database, name) == "index"


def table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def table_exists_at_path(database, name):
    conn = sqlite3.connect(database)
    exists = table_exists(conn, name)
    conn.close()
    return exists


def table_names(conn):
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def migration_row(database, version):
    conn = sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM schema_migrations WHERE version=?", (version,)).fetchone()
    conn.close()
    return SimpleNamespace(**dict(row))


def legacy_fbr_projection(database):
    conn = open_database(database) if sqlite_object_type(database, "merchant_fbr_links") == "view" else sqlite3.connect(database)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM merchant_fbr_links ORDER BY merchant_id LIMIT 1").fetchone()
    conn.close()
    return SimpleNamespace(**dict(row))


def fbr_binding_events(database, merchant_id):
    conn = open_database(database)
    rows = conn.execute(
        "SELECT * FROM merchant_fbr_binding_events WHERE merchant_id=? ORDER BY generation",
        (merchant_id,),
    ).fetchall()
    conn.close()
    return [SimpleNamespace(**dict(row)) for row in rows]


def before(instant):
    parsed = datetime.strptime(instant, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    return (parsed - timedelta(microseconds=1)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def direct_fbr_binding_at(database, exact_fbr_id, instant):
    conn = open_database(database)
    row = conn.execute(
        "SELECT * FROM merchant_fbr_binding_events WHERE fbr_merchant_id=? "
        "AND valid_from<=? AND (valid_to IS NULL OR ?<valid_to)",
        (exact_fbr_id, instant, instant),
    ).fetchone()
    conn.close()
    return None if row is None else SimpleNamespace(**dict(row))


def fixture_migrations(tmp_path, _name):
    directory = tmp_path / "bad-migrations"
    directory.mkdir()
    (directory / "0001_break.sql").write_text(
        "CREATE TABLE half_created(id INTEGER PRIMARY KEY);\nTHIS IS NOT SQL;\n"
    )
    return directory


def build_preconstraint_performance_database(database):
    build_legacy_database(database)
    conn = sqlite3.connect(database)
    conn.executescript(
        """
        CREATE TABLE merchant_locations (
          id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL, display_name TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE source_scopes (
          id INTEGER PRIMARY KEY, source TEXT NOT NULL, scope_type TEXT NOT NULL,
          external_id TEXT NOT NULL, canonical_key TEXT NOT NULL, date_basis TEXT NOT NULL,
          metadata_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE source_scope_bindings (
          id INTEGER PRIMARY KEY, source_scope_id INTEGER NOT NULL, merchant_id INTEGER NOT NULL,
          merchant_location_id INTEGER, binding_generation INTEGER NOT NULL,
          valid_from TEXT NOT NULL, valid_to TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()
    return database


def seed_cross_merchant_location_bindings(database, scope_type, generations, non_overlapping):
    del non_overlapping
    conn = sqlite3.connect(database)
    conn.execute("INSERT INTO merchants(id,name,status,created_at) VALUES (3,'Third','active',?)", (T0,))
    conn.executemany(
        "INSERT INTO merchant_locations(id,merchant_id,display_name,status,created_at) VALUES (?,?,?,?,?)",
        [(1, 1, "A", "active", T0), (2, 3, "B", "active", T0)],
    )
    source = {"GBP_LOCATION": "GBP", "REVIEW_LOCATION": "REVIEWS", "LOCAL_RANK_COHORT": "LOCAL_FALCON"}[scope_type]
    conn.execute(
        "INSERT INTO source_scopes VALUES (1,?,?,?,?,?,?,?)",
        (source, scope_type, "legacy-scope", "legacy/scope", "UTC", "{}", T0),
    )
    conn.executemany(
        "INSERT INTO source_scope_bindings VALUES (?,?,?,?,?,?,?,?,?)",
        [(1, 1, 1, 1, generations[0], T0, T1, "legacy", T0), (2, 1, 3, 2, generations[1], T1, None, "legacy", T1)],
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def conn(tmp_path, monkeypatch):
    database = tmp_path / "constraints.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    init_db()
    connection = open_database(database)
    yield connection
    connection.close()


def insert_merchant(conn):
    cursor = conn.execute(
        "INSERT INTO merchants(name,status,created_at) VALUES ('Test Merchant','active',?)",
        (NOW,),
    )
    return cursor.lastrowid


def insert_two_merchants(conn):
    return insert_merchant(conn), insert_merchant(conn)


def insert_location(conn, merchant_id, suffix):
    cursor = conn.execute(
        "INSERT INTO merchant_locations(merchant_id,display_name,status,created_at) VALUES (?,?,?,?)",
        (merchant_id, f"Location {suffix}", "active", NOW),
    )
    return cursor.lastrowid


def direct_insert_scope(conn, source, scope_type, canonical_key="scope/test"):
    cursor = conn.execute(
        "INSERT INTO source_scopes(source,scope_type,external_id,canonical_key,date_basis,metadata_json,created_at) "
        "VALUES (?,?,?,?,?,?,?)",
        (source, scope_type, canonical_key, canonical_key, "UTC", "{}", NOW),
    )
    return cursor.lastrowid


insert_scope = direct_insert_scope


def direct_insert_binding(conn, source_scope_id, merchant_id, merchant_location_id, generation, valid_from=T0, valid_to=None):
    closed_by = "test" if valid_to else None
    close_reason = "test-close" if valid_to else None
    cursor = conn.execute(
        "INSERT INTO source_scope_bindings(source_scope_id,merchant_id,merchant_location_id,binding_generation,"
        "valid_from,valid_to,created_by,created_at,closed_by,close_reason) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (source_scope_id, merchant_id, merchant_location_id, generation, valid_from, valid_to, "test", NOW, closed_by, close_reason),
    )
    return SimpleNamespace(id=cursor.lastrowid, binding_generation=generation)


def binding_rows(conn, scope):
    rows = conn.execute(
        "SELECT id,binding_generation FROM source_scope_bindings WHERE source_scope_id=? ORDER BY id",
        (scope,),
    ).fetchall()
    return [SimpleNamespace(**dict(row)) for row in rows]


def binding_generations_for_merchant(conn, scope, merchant):
    return [
        row[0]
        for row in conn.execute(
            "SELECT binding_generation FROM source_scope_bindings WHERE source_scope_id=? AND merchant_id=? ORDER BY binding_generation",
            (scope, merchant),
        )
    ]


def direct_insert_fbr_binding_event(conn, merchant_id, fbr_merchant_id, generation, valid_from, valid_to=None):
    closed_by = "test" if valid_to else None
    close_reason = "test-close" if valid_to else None
    cursor = conn.execute(
        "INSERT INTO merchant_fbr_binding_events(merchant_id,fbr_merchant_id,generation,valid_from,valid_to,"
        "opened_by,open_reason,closed_by,close_reason,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (merchant_id, fbr_merchant_id, generation, valid_from, valid_to, "test", "test-open", closed_by, close_reason, NOW),
    )
    return SimpleNamespace(id=cursor.lastrowid, generation=generation, valid_from=valid_from, valid_to=valid_to)


def direct_insert_fbr_binding_event_with_explicit_identity_hash(conn, **values):
    return conn.execute(
        "INSERT INTO merchant_fbr_binding_events(merchant_id,fbr_merchant_id,canonical_fbr_merchant_sha256,"
        "generation,valid_from,opened_by,open_reason,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (values["merchant_id"], values["fbr_merchant_id"], values["canonical_fbr_merchant_sha256"], values["generation"], values["valid_from"], "test", "test-open", NOW),
    )


def direct_insert_fbr_link_state(conn, merchant_id):
    conn.execute(
        "INSERT INTO merchant_fbr_link_state(merchant_id,sync_status,created_at,updated_at) VALUES (?,'not_synced',?,?)",
        (merchant_id, NOW, NOW),
    )


def current_fbr_projection(conn, merchant):
    row = conn.execute("SELECT * FROM merchant_fbr_links WHERE merchant_id=?", (merchant,)).fetchone()
    return SimpleNamespace(**dict(row))


def direct_close_fbr_binding_event(conn, event_id, valid_to, actor):
    conn.execute(
        "UPDATE merchant_fbr_binding_events SET valid_to=?,closed_by=?,close_reason=? WHERE id=?",
        (valid_to, actor, "direct-close", event_id),
    )


def fbr_projection_rows(conn, merchant):
    return conn.execute("SELECT * FROM merchant_fbr_links WHERE merchant_id=?", (merchant,)).fetchall()


def projection_rows_pointing_to_closed_fbr_events(conn):
    return conn.execute(
        "SELECT link.* FROM merchant_fbr_links link JOIN merchant_fbr_binding_events event "
        "ON event.id=link.binding_event_id WHERE event.valid_to IS NOT NULL"
    ).fetchall()


def insert_archived_merchant(conn, name):
    cursor = conn.execute(
        "INSERT INTO merchants(name,status,created_at) VALUES (?,'archived',?)",
        (name, NOW),
    )
    return cursor.lastrowid


def insert_metric_job(conn, *, requested_by="test", request_id="job-request"):
    cursor = conn.execute(
        "INSERT INTO metric_sync_jobs("
        "job_type,request_id,idempotency_key,scope_manifest_json,scope_manifest_sha256,"
        "requested_start_date,requested_end_date,status,requested_by,created_at"
        ") VALUES ('daily',?,?,?,?,? ,?,'queued',?,?)",
        (
            request_id,
            f"idempotency-{request_id}",
            "{}",
            "a" * 64,
            "2026-09-01",
            "2026-09-02",
            requested_by,
            NOW,
        ),
    )
    return cursor.lastrowid


def insert_metric_scope(conn, canonical_key="locations/metrics"):
    return direct_insert_scope(
        conn,
        source="GBP",
        scope_type="GBP_LOCATION",
        canonical_key=canonical_key,
    )


def insert_metric_batch(conn, job_id, scope_id, *, status, attempt=1):
    cursor = conn.execute(
        "INSERT INTO metric_sync_batches("
        "job_id,source,source_scope_id,partition_month,attempt,status,adapter_version,"
        "created_at,updated_at) VALUES (?,'GBP',?,'2026-09',?,?, 'v1',?,?)",
        (job_id, scope_id, attempt, status, NOW, NOW),
    )
    return cursor.lastrowid


def insert_metric_observation(
    conn, batch_id, scope_id, logical_key, *, published_sequence
):
    cursor = conn.execute(
        "INSERT INTO metric_observations("
        "batch_id,source_scope_id,metric_key,business_date,date_basis,dimension_json,"
        "dimension_sha256,logical_key_json,logical_key_sha256,numeric_value,availability,"
        "completeness,formula_version,published_sequence,content_sha256,created_at"
        ") VALUES (?,?,'CALL_CLICKS','2026-09-01','UTC','{}',?,'{}',?,1.0,"
        "'available','complete','v1',?,?,?)",
        (batch_id, scope_id, "b" * 64, logical_key, published_sequence, "c" * 64, NOW),
    )
    return cursor.lastrowid


def test_versioned_migration_is_atomic_checksum_locked_and_repeatable(tmp_path, monkeypatch):
    database = build_legacy_database(tmp_path / "legacy.db")
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    before_hashes = legacy_evidence_hashes(database)

    init_db()
    first = performance_table_counts(database)
    init_db()
    second = performance_table_counts(database)

    assert first == second
    assert legacy_evidence_hashes(database) == before_hashes
    assert migration_versions(database) == ["0001_performance_history"]
    assert integrity_results(database) == ("ok", [])


def test_migrated_database_fresh_process_cold_start_skips_legacy_fbr_ddl(tmp_path):
    database = build_legacy_database(tmp_path / "migrated-cold-start.db")
    run_init_db_in_fresh_process(database)
    first = exact_database_fingerprint(database)
    run_init_db_in_fresh_process(database)
    assert sqlite_object_type(database, "merchant_fbr_links") == "view"
    assert not index_exists_at_path(database, "idx_merchant_fbr_links_external")
    assert migration_versions(database) == ["0001_performance_history"]
    assert exact_database_fingerprint(database) == first
    assert integrity_results(database) == ("ok", [])


def test_fresh_database_init_db_twice_bootstraps_then_migrates_once(tmp_path, monkeypatch):
    database = tmp_path / "fresh-twice.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    init_db()
    first = exact_database_fingerprint(database)
    init_db()
    assert sqlite_object_type(database, "merchant_fbr_links") == "view"
    assert migration_versions(database) == ["0001_performance_history"]
    assert exact_database_fingerprint(database) == first
    assert integrity_results(database) == ("ok", [])


def test_0001_backfills_legacy_fbr_projection_at_migration_instant_only(tmp_path):
    database = build_legacy_database(tmp_path / "legacy-fbr.db")
    legacy = legacy_fbr_projection(database)
    migrations_api().apply_migrations(sqlite3.connect(database))
    applied_at = migration_row(database, "0001_performance_history").applied_at
    event = fbr_binding_events(database, merchant_id=legacy.merchant_id)
    assert len(event) == 1
    assert event[0].generation == 1
    assert event[0].fbr_merchant_id == legacy.fbr_merchant_id.strip()
    assert event[0].valid_from == applied_at
    assert event[0].open_reason == "legacy_fbr_binding_baseline"
    assert legacy_fbr_projection(database).binding_event_id == event[0].id
    exact_fbr_id = legacy.fbr_merchant_id.strip()
    assert direct_fbr_binding_at(database, exact_fbr_id, before(applied_at)) is None
    assert direct_fbr_binding_at(database, exact_fbr_id, applied_at).id == event[0].id
    before_replay = exact_database_fingerprint(database)
    migrations_api().apply_migrations(sqlite3.connect(database))
    assert exact_database_fingerprint(database) == before_replay


def test_0001_registry_checksum_binds_frozen_data_hook_contract():
    migrations = migrations_api()
    sql_path = migrations.MIGRATIONS_DIR / "0001_performance_history.sql"
    hook_path = migrations.MIGRATIONS_DIR / "0001_performance_history.hook.json"

    checksums = migrations.migration_registry_checksums()
    sql_checksum = hashlib.sha256(sql_path.read_bytes()).hexdigest()
    hook_checksum = migrations.python_migration_checksum(
        "0001_performance_history",
        contract=hook_path.read_text(),
    )

    assert checksums["0001_performance_history"] == (
        migrations.combined_migration_checksum(
            "0001_performance_history",
            sql_checksum=sql_checksum,
            python_checksum=hook_checksum,
        )
    )
    assert checksums["0001_performance_history"] != sql_checksum


def test_0001_missing_status_baseline_rolls_back_hook_schema_and_ledger(
    tmp_path, monkeypatch
):
    migrations = migrations_api()
    database = build_legacy_database(tmp_path / "legacy-status-noop.db")
    before_fingerprint = exact_database_fingerprint(database)
    monkeypatch.setattr(
        migrations,
        "_bootstrap_legacy_merchant_status_baselines",
        lambda *_args, **_kwargs: None,
    )

    with pytest.raises(
        migrations.MigrationInvariantError,
        match="merchant_status_history_missing: merchant_id=1",
    ):
        migrations.apply_migrations(sqlite3.connect(database))

    assert exact_database_fingerprint(database) == before_fingerprint
    assert migration_versions(database) == []
    assert sqlite_object_type(database, "merchant_fbr_links") == "table"


def test_0001_backfills_traceable_status_baseline_for_every_legacy_merchant(tmp_path):
    migrations = migrations_api()
    database = build_legacy_database(tmp_path / "legacy-status-baseline.db")

    migrations.apply_migrations(sqlite3.connect(database))

    conn = open_database(database)
    rows = conn.execute(
        "SELECT merchant_id,status,effective_at,generation,actor,reason,"
        "content_sha256,created_at FROM merchant_status_events ORDER BY merchant_id"
    ).fetchall()
    merchants = conn.execute(
        "SELECT id,status FROM merchants ORDER BY id"
    ).fetchall()
    persisted_checksum = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version='0001_performance_history'"
    ).fetchone()[0]
    conn.close()

    assert [(row["merchant_id"], row["status"]) for row in rows] == [
        (merchant["id"], merchant["status"]) for merchant in merchants
    ]
    for row in rows:
        assert row["generation"] == 1
        assert row["actor"] == "schema_migration:0001_performance_history"
        assert row["reason"] == "legacy_status_baseline"
        assert row["created_at"] == row["effective_at"]
        assert row["content_sha256"] == migrations.content_sha256(
            row["merchant_id"],
            row["status"],
            row["effective_at"],
            row["generation"],
            row["actor"],
            row["reason"],
        )
    assert persisted_checksum == migrations.migration_registry_checksums()[
        "0001_performance_history"
    ]


def test_replayed_0001_rejects_merchant_status_without_a_latest_event(tmp_path):
    migrations = migrations_api()
    database = build_legacy_database(tmp_path / "status-event-tamper.db")
    migrations.apply_migrations(sqlite3.connect(database))
    conn = open_database(database)
    conn.execute("UPDATE merchants SET status='archived' WHERE id=1")
    conn.commit()

    with pytest.raises(
        migrations.MigrationInvariantError,
        match="merchant_status_latest_mismatch: merchant_id=1",
    ):
        migrations.apply_migrations(conn)

    conn.close()


def test_0001_fbr_baseline_conflict_rolls_back_schema_hook_and_registry(tmp_path):
    database = build_legacy_database_with_duplicate_current_fbr_identity(tmp_path / "legacy-fbr-conflict.db")
    before_fingerprint = exact_database_fingerprint(database)
    with pytest.raises(migrations_api().MigrationInvariantError, match="fbr_identity_interval_overlap"):
        migrations_api().apply_migrations(sqlite3.connect(database))
    assert exact_database_fingerprint(database) == before_fingerprint
    assert not table_exists_at_path(database, "merchant_fbr_binding_events")
    assert migration_versions(database) == []


@pytest.mark.parametrize("fbr_merchant_id", ["", "   ", "\t", "\u2003"])
def test_0001_rejects_blank_legacy_fbr_identity_before_destructive_ddl(
    tmp_path, fbr_merchant_id
):
    database = build_legacy_database_with_blank_fbr_identity(
        tmp_path / "legacy-fbr-blank.db", fbr_merchant_id
    )
    before_fingerprint = exact_database_fingerprint(database)
    statements = []
    conn = sqlite3.connect(database)
    conn.set_trace_callback(statements.append)

    with pytest.raises(
        migrations_api().MigrationInvariantError,
        match="legacy_fbr_identity_invalid: merchant_id=1",
    ):
        migrations_api().apply_migrations(conn)

    conn.close()
    assert not any(
        "ALTER TABLE MERCHANT_FBR_LINKS RENAME" in statement.upper()
        for statement in statements
    )
    assert exact_database_fingerprint(database) == before_fingerprint
    assert sqlite_object_type(database, "merchant_fbr_links") == "table"
    assert migration_versions(database) == []


def test_0001_preserves_every_valid_legacy_fbr_link_exactly_once(tmp_path):
    database = build_legacy_database(tmp_path / "legacy-fbr-one-to-one.db")
    conn = sqlite3.connect(database)
    conn.execute(
        "INSERT INTO merchant_fbr_links(merchant_id,fbr_merchant_id,sync_status,"
        "last_synced_at,last_error,created_at,updated_at) "
        "VALUES (2,'  legacy-fbr-merchant-002  ','failed',NULL,'retry later',?,?)",
        ("2024-02-02T00:00:00.000000Z", "2026-08-02T00:00:00.000000Z"),
    )
    expected = [
        (row[0], row[1].strip(), *row[2:])
        for row in conn.execute(
            "SELECT merchant_id,fbr_merchant_id,sync_status,last_synced_at,last_error,"
            "created_at,updated_at FROM merchant_fbr_links ORDER BY merchant_id"
        )
    ]
    conn.commit()
    conn.close()

    migrations_api().apply_migrations(sqlite3.connect(database))

    conn = open_database(database)
    projection = [
        tuple(row)
        for row in conn.execute(
            "SELECT merchant_id,fbr_merchant_id,sync_status,last_synced_at,last_error,"
            "created_at,updated_at FROM merchant_fbr_links ORDER BY merchant_id"
        )
    ]
    event_merchants = [
        tuple(row)
        for row in conn.execute(
            "SELECT merchant_id,count(*) FROM merchant_fbr_binding_events "
            "GROUP BY merchant_id ORDER BY merchant_id"
        )
    ]
    state_merchants = [
        row[0]
        for row in conn.execute(
            "SELECT merchant_id FROM merchant_fbr_link_state ORDER BY merchant_id"
        )
    ]
    conn.close()

    assert projection == expected
    assert event_merchants == [(1, 1), (2, 1)]
    assert state_merchants == [1, 2]


def test_failed_migration_leaves_no_partial_schema(tmp_path):
    conn = sqlite3.connect(tmp_path / "failure.db")
    conn.executescript("CREATE TABLE merchants(id INTEGER PRIMARY KEY);")
    with pytest.raises(sqlite3.DatabaseError):
        migrations_api().apply_migrations(
            conn, fixture_migrations(tmp_path, "create_then_fail")
        )
    assert "half_created" not in table_names(conn)
    assert migration_versions_from_conn(conn) == []


class _LedgerRaceConnection(sqlite3.Connection):
    barrier: threading.Barrier

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._schema_migration_reads = 0

    def execute(self, sql, parameters=(), /):
        if (
            "SELECT type FROM sqlite_master WHERE name = ?" in sql
            and tuple(parameters) == ("schema_migrations",)
        ):
            self._schema_migration_reads += 1
            if self._schema_migration_reads == 2:
                try:
                    self.barrier.wait(timeout=0.5)
                except threading.BrokenBarrierError:
                    pass
        return super().execute(sql, parameters)


def test_two_connections_reread_migration_ledger_after_acquiring_write_lock(tmp_path):
    database = build_legacy_database(tmp_path / "migration-race.db")
    _LedgerRaceConnection.barrier = threading.Barrier(2)

    def migrate_once():
        conn = sqlite3.connect(
            database,
            timeout=5,
            factory=_LedgerRaceConnection,
        )
        try:
            return migrations_api().apply_migrations(conn)
        finally:
            conn.close()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: migrate_once(), range(2)))

    assert sorted(results, key=len) == [[], ["0001_performance_history"]]
    assert migration_versions(database) == ["0001_performance_history"]
    assert integrity_results(database) == ("ok", [])


def test_two_fresh_init_db_calls_share_locked_legacy_fbr_bootstrap(
    tmp_path, monkeypatch
):
    database = tmp_path / "fresh-init-race.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    db_api = importlib.import_module("app.db")
    original_preflight = db_api._legacy_fbr_bootstrap_required
    observed_transactions = []
    observations_lock = threading.Lock()
    observed_connections: set[int] = set()

    def synchronized_preflight(conn, **kwargs):
        with observations_lock:
            if id(conn) not in observed_connections:
                observed_connections.add(id(conn))
                observed_transactions.append(conn.in_transaction)
        result = original_preflight(conn, **kwargs)
        return result

    monkeypatch.setattr(
        db_api, "_legacy_fbr_bootstrap_required", synchronized_preflight
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: db_api.init_db(), range(2)))

    assert results == [None, None]
    assert observed_transactions and all(observed_transactions)
    assert sqlite_object_type(database, "merchant_fbr_links") == "view"
    assert migration_versions(database) == ["0001_performance_history"]
    assert performance_table_counts(database)["merchant_fbr_binding_events"] == 0
    assert integrity_results(database) == ("ok", [])


def test_two_legacy_init_db_calls_serialize_column_bridge(tmp_path, monkeypatch):
    database = tmp_path / "legacy-column-bridge-race.db"
    conn = sqlite3.connect(database)
    conn.executescript(
        """
        CREATE TABLE merchants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          merchant_id INTEGER NOT NULL REFERENCES merchants(id),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'todo',
          created_at TEXT NOT NULL
        );
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    db_api = importlib.import_module("app.db")
    original_migrate = db_api._migrate
    observed_transactions = []
    observations_lock = threading.Lock()

    def synchronized_migrate(connection):
        with observations_lock:
            observed_transactions.append(connection.in_transaction)
        original_migrate(connection)

    monkeypatch.setattr(db_api, "_migrate", synchronized_migrate)

    def initialize(_index):
        return db_api.init_db()

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(initialize, range(2)))

    assert results == [None, None]
    assert observed_transactions and all(observed_transactions)
    assert migration_versions(database) == ["0001_performance_history"]
    assert integrity_results(database) == ("ok", [])


def test_exact_legacy_task_marker_set_folds_into_registered_combined_migration(
    tmp_path,
):
    migrations = migrations_api()
    migrations_dir = tmp_path / "task-migrations"
    migrations_dir.mkdir()
    sql_path = migrations_dir / "0002_task_workflows.sql"
    sql_path.write_text(
        "CREATE TABLE task_migration_must_not_replay(id INTEGER PRIMARY KEY);\n"
    )
    database = tmp_path / "legacy-ledger.db"
    conn = sqlite3.connect(database)
    conn.execute(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        [
            ("task_workflow_v1", "2026-09-02T00:00:00+00:00"),
            ("task_workflow_states_v2", "2026-09-02T00:01:00+00:00"),
        ],
    )
    conn.commit()
    hook_calls = []
    validator_calls = []
    hook_checksum = migrations.python_migration_checksum(
        "0002_task_workflows", contract="task-workflows-schema-v2"
    )

    def apply_hook(_connection, _migration_instant):
        hook_calls.append(True)

    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=hook_checksum,
        apply=apply_hook,
        legacy_ledger_names=("task_workflow_v1", "task_workflow_states_v2"),
        validate_legacy_adoption=lambda connection: validator_calls.append(
            connection.in_transaction
        ),
    )

    assert migrations.apply_migrations(
        conn,
        migrations_dir,
        python_migrations=(migration,),
    ) == []

    columns = {
        row[1] for row in conn.execute("PRAGMA table_info(schema_migrations)")
    }
    rows = conn.execute(
        "SELECT version,checksum,applied_at FROM schema_migrations ORDER BY version"
    ).fetchall()
    conn.close()
    assert columns == {"version", "checksum", "applied_at"}
    assert rows == [
        (
            "0002_task_workflows",
            migrations.combined_migration_checksum(
                "0002_task_workflows",
                sql_checksum=hashlib.sha256(sql_path.read_bytes()).hexdigest(),
                python_checksum=hook_checksum,
            ),
            "2026-09-02T00:01:00+00:00",
        )
    ]
    assert hook_calls == []
    assert validator_calls == [True]
    assert not table_exists_at_path(database, "task_migration_must_not_replay")


@pytest.mark.parametrize(
    "legacy_names",
    [
        ("task_workflow_v1",),
        ("task_workflow_v1", "task_workflow_states_v2", "unknown_v3"),
    ],
)
def test_partial_or_unknown_legacy_marker_set_fails_closed(
    tmp_path, legacy_names
):
    migrations = migrations_api()
    migrations_dir = tmp_path / "task-migrations"
    migrations_dir.mkdir()
    (migrations_dir / "0002_task_workflows.sql").write_text(
        "CREATE TABLE task_migration_must_not_run(id INTEGER PRIMARY KEY);\n"
    )
    conn = sqlite3.connect(tmp_path / "legacy-ledger-invalid.db")
    conn.execute(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        [(name, f"2026-09-02T00:0{index}:00+00:00") for index, name in enumerate(legacy_names)],
    )
    conn.commit()
    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=migrations.python_migration_checksum(
            "0002_task_workflows", contract="task-workflows-schema-v2"
        ),
        apply=lambda *_args: None,
        legacy_ledger_names=("task_workflow_v1", "task_workflow_states_v2"),
        validate_legacy_adoption=lambda _connection: None,
    )

    with pytest.raises(
        migrations.MigrationInvariantError, match="legacy migration marker set"
    ):
        migrations.apply_migrations(
            conn,
            migrations_dir,
            python_migrations=(migration,),
        )

    assert {
        row[1] for row in conn.execute("PRAGMA table_info(schema_migrations)")
    } == {"name", "applied_at"}
    assert [
        row[0]
        for row in conn.execute("SELECT name FROM schema_migrations ORDER BY name")
    ] == sorted(legacy_names)
    assert "task_migration_must_not_run" not in table_names(conn)
    conn.close()


def test_legacy_adoption_validation_failure_preserves_name_ledger(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "task-migrations"
    migrations_dir.mkdir()
    (migrations_dir / "0002_task_workflows.sql").write_text(
        "CREATE TABLE task_migration_must_not_run(id INTEGER PRIMARY KEY);\n"
    )
    conn = sqlite3.connect(tmp_path / "legacy-ledger-invalid-schema.db")
    conn.execute(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.executemany(
        "INSERT INTO schema_migrations(name,applied_at) VALUES (?,?)",
        [
            ("task_workflow_v1", "2026-09-02T00:00:00+00:00"),
            ("task_workflow_states_v2", "2026-09-02T00:01:00+00:00"),
        ],
    )
    conn.commit()

    def reject_interim_schema(_connection):
        raise migrations.MigrationInvariantError("legacy task schema is not final")

    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=migrations.python_migration_checksum(
            "0002_task_workflows", contract="task-workflows-schema-v2"
        ),
        apply=lambda *_args: None,
        legacy_ledger_names=("task_workflow_v1", "task_workflow_states_v2"),
        validate_legacy_adoption=reject_interim_schema,
    )

    with pytest.raises(
        migrations.MigrationInvariantError, match="legacy task schema is not final"
    ):
        migrations.apply_migrations(
            conn,
            migrations_dir,
            python_migrations=(migration,),
        )

    assert {
        row[1] for row in conn.execute("PRAGMA table_info(schema_migrations)")
    } == {"name", "applied_at"}
    assert conn.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 2
    assert "task_migration_must_not_run" not in table_names(conn)
    conn.close()


def test_shared_runner_combines_sql_and_python_hook_in_one_migration(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "combined-migrations"
    migrations_dir.mkdir()
    sql_path = migrations_dir / "0002_task_workflows.sql"
    sql_path.write_text(
        "CREATE TABLE task_workflow_marker(id INTEGER PRIMARY KEY, source TEXT);\n"
    )
    conn = sqlite3.connect(tmp_path / "combined-migration.db")
    hook_calls = []

    def apply_hook(connection, migration_instant):
        hook_calls.append((connection.in_transaction, migration_instant))
        assert table_exists(connection, "task_workflow_marker")
        connection.execute(
            "INSERT INTO task_workflow_marker(id,source) VALUES (1,'python-hook')"
        )

    hook_checksum = migrations.python_migration_checksum(
        "0002_task_workflows", contract="task-workflows-schema-v2"
    )
    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=hook_checksum,
        apply=apply_hook,
    )

    assert migrations.apply_migrations(
        conn,
        migrations_dir,
        python_migrations=(migration,),
    ) == ["0002_task_workflows"]
    assert migrations.apply_migrations(
        conn,
        migrations_dir,
        python_migrations=(migration,),
    ) == []
    persisted_checksum = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version='0002_task_workflows'"
    ).fetchone()[0]

    assert persisted_checksum == migrations.combined_migration_checksum(
        "0002_task_workflows",
        sql_checksum=hashlib.sha256(sql_path.read_bytes()).hexdigest(),
        python_checksum=hook_checksum,
    )
    assert conn.execute(
        "SELECT id,source FROM task_workflow_marker"
    ).fetchall() == [(1, "python-hook")]
    assert len(hook_calls) == 1
    assert hook_calls[0][0] is True
    conn.close()


def test_empty_legacy_name_ledger_becomes_canonical_then_runs_migration(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "empty-legacy-ledger-migrations"
    migrations_dir.mkdir()
    (migrations_dir / "0002_task_workflows.sql").write_text(
        "CREATE TABLE task_workflow_marker(id INTEGER PRIMARY KEY);\n"
    )
    conn = sqlite3.connect(tmp_path / "empty-legacy-ledger.db")
    conn.execute(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
    )
    conn.commit()

    assert migrations.apply_migrations(conn, migrations_dir) == [
        "0002_task_workflows"
    ]
    assert {
        row[1] for row in conn.execute("PRAGMA table_info(schema_migrations)")
    } == {"version", "checksum", "applied_at"}
    assert migration_versions_from_conn(conn) == ["0002_task_workflows"]
    assert "task_workflow_marker" in table_names(conn)
    conn.close()


def test_combined_sql_and_python_failure_rolls_back_both_parts(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "combined-failure-migrations"
    migrations_dir.mkdir()
    (migrations_dir / "0002_task_workflows.sql").write_text(
        "CREATE TABLE partial_combined_task_workflow(id INTEGER PRIMARY KEY);\n"
    )
    conn = sqlite3.connect(tmp_path / "combined-failure.db")

    def failing_hook(connection, _migration_instant):
        assert table_exists(connection, "partial_combined_task_workflow")
        raise RuntimeError("combined hook failed")

    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=migrations.python_migration_checksum(
            "0002_task_workflows", contract="task-workflows-schema-v2"
        ),
        apply=failing_hook,
    )

    with pytest.raises(RuntimeError, match="combined hook failed"):
        migrations.apply_migrations(
            conn,
            migrations_dir,
            python_migrations=(migration,),
        )

    assert "partial_combined_task_workflow" not in table_names(conn)
    assert migration_versions_from_conn(conn) == []
    conn.close()


def test_shared_runner_executes_python_migration_once_under_its_transaction(
    tmp_path,
):
    migrations = migrations_api()
    migrations_dir = tmp_path / "empty-migrations"
    migrations_dir.mkdir()
    database = tmp_path / "python-migration.db"
    conn = sqlite3.connect(database)
    calls = []

    def apply_hook(connection, migration_instant):
        calls.append((connection.in_transaction, migration_instant))
        connection.execute("CREATE TABLE task_workflow_marker(id INTEGER PRIMARY KEY)")

    version = "0002_task_workflows"
    checksum = migrations.python_migration_checksum(
        version, contract="task-workflows-schema-v2"
    )
    migration = migrations.PythonMigration(
        version=version,
        checksum=checksum,
        apply=apply_hook,
    )

    assert migrations.apply_migrations(
        conn,
        migrations_dir,
        python_migrations=(migration,),
    ) == [version]
    assert migrations.apply_migrations(
        conn,
        migrations_dir,
        python_migrations=(migration,),
    ) == []
    row = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version=?", (version,)
    ).fetchone()
    conn.close()

    assert row == (checksum,)
    assert len(calls) == 1
    assert calls[0][0] is True
    assert len(calls[0][1]) == 27 and calls[0][1].endswith("Z")


def test_init_db_threads_python_registry_through_pre_and_post_checks(
    tmp_path, monkeypatch
):
    migrations = migrations_api()
    database = tmp_path / "init-with-python-registry.db"
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    calls = []

    def apply_hook(connection, _migration_instant):
        calls.append(connection.in_transaction)
        connection.execute(
            "CREATE TABLE task_workflow_registry_marker(id INTEGER PRIMARY KEY)"
        )

    migration = migrations.PythonMigration(
        version="0002_task_workflows",
        checksum=migrations.python_migration_checksum(
            "0002_task_workflows", contract="task-workflows-schema-v2"
        ),
        apply=apply_hook,
    )

    init_db(python_migrations=(migration,))
    init_db(python_migrations=(migration,))

    assert calls == [True]
    assert migration_versions(database) == [
        "0001_performance_history",
        "0002_task_workflows",
    ]
    assert table_exists_at_path(database, "task_workflow_registry_marker")


def test_shared_python_migration_failure_rolls_back_hook_and_ledger(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "empty-migrations"
    migrations_dir.mkdir()
    conn = sqlite3.connect(tmp_path / "python-migration-failure.db")

    def failing_hook(connection, _migration_instant):
        connection.execute("CREATE TABLE partial_task_workflow(id INTEGER PRIMARY KEY)")
        raise RuntimeError("task workflow hook failed")

    version = "0002_task_workflows"
    migration = migrations.PythonMigration(
        version=version,
        checksum=migrations.python_migration_checksum(
            version, contract="task-workflows-schema-v2"
        ),
        apply=failing_hook,
    )

    with pytest.raises(RuntimeError, match="task workflow hook failed"):
        migrations.apply_migrations(
            conn,
            migrations_dir,
            python_migrations=(migration,),
        )

    assert "partial_task_workflow" not in table_names(conn)
    assert migration_versions_from_conn(conn) == []
    conn.close()


def test_python_migration_fk_off_mode_audits_before_commit_and_restores_fk(tmp_path):
    migrations = migrations_api()
    migrations_dir = tmp_path / "empty-migrations"
    migrations_dir.mkdir()
    conn = sqlite3.connect(tmp_path / "python-migration-fk.db")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY);"
        "CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));"
    )

    def corrupting_hook(connection, _migration_instant):
        assert connection.execute("PRAGMA foreign_keys").fetchone()[0] == 0
        connection.execute("INSERT INTO child(parent_id) VALUES (999)")

    version = "0002_task_workflows"
    migration = migrations.PythonMigration(
        version=version,
        checksum=migrations.python_migration_checksum(
            version, contract="task-workflows-schema-v2"
        ),
        apply=corrupting_hook,
        foreign_keys_off=True,
    )

    with pytest.raises(
        migrations.MigrationInvariantError, match="foreign_key_check"
    ):
        migrations.apply_migrations(
            conn,
            migrations_dir,
            python_migrations=(migration,),
        )

    assert conn.execute("SELECT count(*) FROM child").fetchone()[0] == 0
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    assert migration_versions_from_conn(conn) == []
    conn.close()


def test_migration_preflight_fails_closed_on_corrupt_location_binding_generations(tmp_path):
    database = build_preconstraint_performance_database(tmp_path / "corrupt.db")
    seed_cross_merchant_location_bindings(database, scope_type="GBP_LOCATION", generations=(1, 1), non_overlapping=True)
    before_fingerprint = exact_database_fingerprint(database)
    conn = sqlite3.connect(database)
    with pytest.raises(migrations_api().MigrationInvariantError, match="location_scope_generation_invalid"):
        migrations_api().apply_migrations(conn)
    assert exact_database_fingerprint(database) == before_fingerprint
    assert migration_versions(database) == []


def test_binding_cannot_pair_one_merchant_with_another_merchants_location(conn):
    merchant_a, merchant_b = insert_two_merchants(conn)
    location_b = insert_location(conn, merchant_b, "B")
    scope = insert_scope(conn, source="GBP", scope_type="GBP_LOCATION", canonical_key="locations/a")
    with pytest.raises(sqlite3.IntegrityError):
        direct_insert_binding(conn, scope, merchant_a, location_b, 1)


@pytest.mark.parametrize(("source", "scope_type"), [("GBP", "GBP_LOCATION"), ("REVIEWS", "REVIEW_LOCATION"), ("LOCAL_FALCON", "LOCAL_RANK_COHORT")])
def test_direct_sql_location_scope_binding_rejects_null_location(conn, source, scope_type):
    merchant = insert_merchant(conn)
    scope = insert_scope(conn, source=source, scope_type=scope_type)
    with pytest.raises(sqlite3.IntegrityError):
        direct_insert_binding(conn, scope, merchant, None, 1)


def test_direct_sql_rejects_wrong_source_scope_tag_or_gsc_location_cardinality(conn):
    merchant = insert_merchant(conn)
    location = insert_location(conn, merchant, "A")
    with pytest.raises(sqlite3.IntegrityError):
        direct_insert_scope(conn, source="GSC", scope_type="GBP_LOCATION")
    property_scope = insert_scope(conn, source="GSC", scope_type="GSC_PROPERTY")
    with pytest.raises(sqlite3.IntegrityError):
        direct_insert_binding(conn, property_scope, merchant, location, 1)


def test_direct_sql_valid_gsc_property_bindings_require_null_location(conn):
    merchant_a, merchant_b = insert_two_merchants(conn)
    property_scope = insert_scope(conn, source="GSC", scope_type="GSC_PROPERTY", canonical_key="sc-domain:example.com")
    first = direct_insert_binding(conn, property_scope, merchant_a, None, 1)
    second = direct_insert_binding(conn, property_scope, merchant_b, None, 1)
    assert binding_rows(conn, property_scope) == [first, second]


def test_direct_sql_gsc_generation_is_strictly_next_per_merchant(conn):
    merchant_a, merchant_b = insert_two_merchants(conn)
    property_scope = insert_scope(conn, source="GSC", scope_type="GSC_PROPERTY", canonical_key="sc-domain:example.com")
    first_a = direct_insert_binding(conn, property_scope, merchant_a, None, 1, T0, T1)
    first_b = direct_insert_binding(conn, property_scope, merchant_b, None, 1, T0)
    with pytest.raises(sqlite3.IntegrityError, match="source_scope_binding_generation_invalid"):
        direct_insert_binding(conn, property_scope, merchant_a, None, 3, T1)
    second_a = direct_insert_binding(conn, property_scope, merchant_a, None, 2, T1)
    assert binding_generations_for_merchant(conn, property_scope, merchant_a) == [first_a.binding_generation, second_a.binding_generation] == [1, 2]
    assert binding_generations_for_merchant(conn, property_scope, merchant_b) == [first_b.binding_generation] == [1]


@pytest.mark.parametrize(("source", "scope_type"), [("GBP", "GBP_LOCATION"), ("REVIEWS", "REVIEW_LOCATION"), ("LOCAL_FALCON", "LOCAL_RANK_COHORT")])
def test_direct_sql_location_scope_generation_is_global_and_strictly_next(conn, source, scope_type):
    merchant_a, merchant_b = insert_two_merchants(conn)
    location_a = insert_location(conn, merchant_a, "A")
    location_b = insert_location(conn, merchant_b, "B")
    scope = insert_scope(conn, source=source, scope_type=scope_type)
    first = direct_insert_binding(conn, scope, merchant_a, location_a, 1, T0, T1)
    with pytest.raises(sqlite3.IntegrityError, match="source_scope_binding_generation_invalid"):
        direct_insert_binding(conn, scope, merchant_b, location_b, 1, T1)
    with pytest.raises(sqlite3.IntegrityError, match="source_scope_binding_generation_invalid"):
        direct_insert_binding(conn, scope, merchant_b, location_b, 3, T1)
    second = direct_insert_binding(conn, scope, merchant_b, location_b, 2, T1)
    assert [(row.id, row.binding_generation) for row in binding_rows(conn, scope)] == [(first.id, 1), (second.id, 2)]


def test_direct_sql_fbr_binding_history_rejects_duplicate_gap_overlap_rewrite_and_delete(conn):
    merchant = insert_merchant(conn)
    first = direct_insert_fbr_binding_event(conn, merchant, "fbr-a", 1, T0, T1)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_binding_generation_invalid"):
        direct_insert_fbr_binding_event(conn, merchant, "fbr-b", 1, T1)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_binding_generation_invalid"):
        direct_insert_fbr_binding_event(conn, merchant, "fbr-b", 3, T1)
    second = direct_insert_fbr_binding_event(conn, merchant, "fbr-b", 2, T1)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_binding_event_immutable"):
        conn.execute("UPDATE merchant_fbr_binding_events SET fbr_merchant_id=? WHERE id=?", ("fbr-rewritten", first.id))
    with pytest.raises(sqlite3.IntegrityError, match="fbr_binding_event_delete_forbidden"):
        conn.execute("DELETE FROM merchant_fbr_binding_events WHERE id=?", (second.id,))
    other = insert_merchant(conn)
    direct_insert_fbr_binding_event(conn, other, "other-a", 1, T0, T2)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_binding_interval_overlap"):
        direct_insert_fbr_binding_event(conn, other, "other-b", 2, T1)


def test_direct_sql_fbr_current_projection_must_point_to_exact_open_event(conn):
    merchant = insert_merchant(conn)
    event = direct_insert_fbr_binding_event(conn, merchant, "fbr-a", 1, T0)
    direct_insert_fbr_link_state(conn, merchant)
    assert current_fbr_projection(conn, merchant).binding_event_id == event.id
    with pytest.raises(sqlite3.DatabaseError, match="cannot modify merchant_fbr_links"):
        conn.execute("UPDATE merchant_fbr_links SET fbr_merchant_id=? WHERE merchant_id=?", ("fbr-b", merchant))


def test_committed_event_close_can_never_leave_projection_pointing_to_closed_event(conn):
    merchant = insert_merchant(conn)
    event = direct_insert_fbr_binding_event(conn, merchant, "fbr-a", 1, T0)
    direct_insert_fbr_link_state(conn, merchant)
    conn.commit()
    direct_close_fbr_binding_event(conn, event.id, T1, "direct-sql-test")
    conn.commit()
    assert fbr_projection_rows(conn, merchant) == []
    assert projection_rows_pointing_to_closed_fbr_events(conn) == []


def test_direct_sql_exact_fbr_identity_cannot_overlap_across_merchants(conn):
    merchant_a, merchant_b = insert_two_merchants(conn)
    first = direct_insert_fbr_binding_event(conn, merchant_a, "fbr-shared", 1, T0, T2)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_identity_interval_overlap"):
        direct_insert_fbr_binding_event(conn, merchant_b, "fbr-shared", 1, T1)
    second = direct_insert_fbr_binding_event(conn, merchant_b, "fbr-shared", 1, T2)
    assert first.valid_to == second.valid_from


def test_direct_sql_cannot_forge_normalized_fbr_identity_hash(conn):
    merchant = insert_merchant(conn)
    with pytest.raises(sqlite3.OperationalError, match="generated column"):
        direct_insert_fbr_binding_event_with_explicit_identity_hash(conn, merchant_id=merchant, fbr_merchant_id="fbr-a", canonical_fbr_merchant_sha256="0" * 64, generation=1, valid_from=T0)
    with pytest.raises(sqlite3.IntegrityError, match="fbr_identity_not_canonical"):
        direct_insert_fbr_binding_event(conn, merchant, "  fbr-a  ", 1, T0)


@pytest.mark.parametrize("bad_instant", ["2026-02-30T00:00:00.000000Z", "2026-09-03T10:00:00Z", "not-an-instant", ""])
def test_direct_sql_fbr_event_rejects_noncanonical_or_calendar_invalid_instants(conn, bad_instant):
    merchant = insert_merchant(conn)
    with pytest.raises(sqlite3.IntegrityError, match="canonical_utc_instant"):
        direct_insert_fbr_binding_event(conn, merchant, "fbr-a", 1, bad_instant)


@pytest.mark.parametrize("bad_close", ["2026-02-30T00:00:00.000000Z", "2026-09-03T10:00:00Z", "not-an-instant"])
def test_direct_sql_fbr_event_rejects_invalid_close_instant(conn, bad_close):
    merchant = insert_merchant(conn)
    event = direct_insert_fbr_binding_event(conn, merchant, "fbr-a", 1, T0)
    with pytest.raises(sqlite3.IntegrityError, match="canonical_utc_instant"):
        direct_close_fbr_binding_event(conn, event.id, bad_close, "direct-sql-test")


def test_archived_merchant_with_only_gbp_profile_cannot_be_deleted(conn):
    merchant = insert_archived_merchant(conn, "Profile evidence")
    conn.execute(
        "INSERT INTO merchant_gbp_profiles("
        "merchant_id,fbr_merchant_id,gbp_location_id,normalized_json,synced_at"
        ") VALUES (?,?,?,'{}',?)",
        (merchant, "fbr-profile", "locations/profile", NOW),
    )

    with pytest.raises(sqlite3.IntegrityError, match="merchant_has_durable_history"):
        conn.execute("DELETE FROM merchants WHERE id=?", (merchant,))

    assert conn.execute(
        "SELECT count(*) FROM merchant_gbp_profiles WHERE merchant_id=?", (merchant,)
    ).fetchone()[0] == 1


def test_archived_merchant_with_only_seo_artifact_cannot_be_deleted(conn):
    merchant = insert_archived_merchant(conn, "Artifact evidence")
    conn.execute(
        "INSERT INTO merchant_seo_artifacts("
        "merchant_id,cycle_id,artifact_type,schema_version,status,source_agent_id,"
        "request_json,created_at) VALUES (?,'cycle-1','AUDIT_REPORT','v1','ready',"
        "'agent-1','{}',?)",
        (merchant, NOW),
    )

    with pytest.raises(sqlite3.IntegrityError, match="merchant_has_durable_history"):
        conn.execute("DELETE FROM merchants WHERE id=?", (merchant,))

    assert conn.execute(
        "SELECT count(*) FROM merchant_seo_artifacts WHERE merchant_id=?", (merchant,)
    ).fetchone()[0] == 1


def test_archived_merchant_with_only_local_falcon_evidence_cannot_be_deleted(conn):
    merchant = insert_archived_merchant(conn, "Local Falcon evidence")
    conn.execute(
        "INSERT INTO merchant_local_falcon_reports("
        "merchant_id,report_key,place_id,keyword,platform,captured_at,center_lat,center_lng,"
        "grid_size,radius,measurement,arp,atrp,solv,found_in,grid_points_json,synced_at"
        ") VALUES (?,?,?,?, 'google',?,40.7,-73.8,9,2.0,'mi',4.0,5.0,75.0,70,'[]',?)",
        (merchant, "report-only", "place-only", "restaurant", NOW, NOW),
    )

    with pytest.raises(sqlite3.IntegrityError, match="merchant_has_durable_history"):
        conn.execute("DELETE FROM merchants WHERE id=?", (merchant,))

    assert conn.execute(
        "SELECT count(*) FROM merchant_local_falcon_reports WHERE merchant_id=?",
        (merchant,),
    ).fetchone()[0] == 1


def test_metric_job_uses_normalized_merchant_ownership_for_delete_guard(conn):
    merchant = insert_archived_merchant(conn, "Job ownership")
    job = insert_metric_job(conn, request_id="normalized-owner")
    conn.execute(
        "INSERT INTO metric_sync_job_merchants(job_id,merchant_id) VALUES (?,?)",
        (job, merchant),
    )

    with pytest.raises(sqlite3.IntegrityError, match="merchant_has_durable_history"):
        conn.execute("DELETE FROM merchants WHERE id=?", (merchant,))


def test_metric_observation_head_rejects_unpublished_or_mismatched_observation(conn):
    scope = insert_metric_scope(conn)
    failed_job = insert_metric_job(conn, request_id="failed-head")
    failed_batch = insert_metric_batch(conn, failed_job, scope, status="failed")
    unpublished = insert_metric_observation(
        conn, failed_batch, scope, "d" * 64, published_sequence=1
    )
    with pytest.raises(sqlite3.IntegrityError, match="head_observation_not_published"):
        conn.execute(
            "INSERT INTO metric_observation_heads VALUES (?,?,1,?)",
            ("d" * 64, unpublished, NOW),
        )

    published_job = insert_metric_job(conn, request_id="published-head")
    published_batch = insert_metric_batch(
        conn, published_job, scope, status="published"
    )
    published = insert_metric_observation(
        conn, published_batch, scope, "e" * 64, published_sequence=1
    )
    with pytest.raises(sqlite3.IntegrityError, match="head_logical_key_mismatch"):
        conn.execute(
            "INSERT INTO metric_observation_heads VALUES (?,?,1,?)",
            ("f" * 64, published, NOW),
        )


def test_metric_observation_head_advances_sequence_and_generation_and_cannot_delete(conn):
    scope = insert_metric_scope(conn)
    job = insert_metric_job(conn, request_id="head-advance")
    first_batch = insert_metric_batch(conn, job, scope, status="published", attempt=1)
    second_batch = insert_metric_batch(conn, job, scope, status="published", attempt=2)
    third_batch = insert_metric_batch(conn, job, scope, status="published", attempt=3)
    logical_key = "d" * 64
    first = insert_metric_observation(
        conn, first_batch, scope, logical_key, published_sequence=2
    )
    older = insert_metric_observation(
        conn, second_batch, scope, logical_key, published_sequence=1
    )
    conn.execute(
        "INSERT INTO metric_observation_heads VALUES (?,?,1,?)",
        (logical_key, first, NOW),
    )

    with pytest.raises(sqlite3.IntegrityError, match="head_sequence_not_newer"):
        conn.execute(
            "UPDATE metric_observation_heads SET observation_id=?,head_generation=2 "
            "WHERE logical_key_sha256=?",
            (older, logical_key),
        )

    newer = insert_metric_observation(
        conn, third_batch, scope, logical_key, published_sequence=3
    )
    with pytest.raises(sqlite3.IntegrityError, match="head_generation_invalid"):
        conn.execute(
            "UPDATE metric_observation_heads SET observation_id=?,head_generation=3 "
            "WHERE logical_key_sha256=?",
            (newer, logical_key),
        )
    conn.execute(
        "UPDATE metric_observation_heads SET observation_id=?,head_generation=2 "
        "WHERE logical_key_sha256=?",
        (newer, logical_key),
    )
    with pytest.raises(sqlite3.IntegrityError, match="head_delete_forbidden"):
        conn.execute(
            "DELETE FROM metric_observation_heads WHERE logical_key_sha256=?",
            (logical_key,),
        )


def test_migration_executes_the_same_bytes_that_were_checksummed(tmp_path, monkeypatch):
    migrations_dir = tmp_path / "checksum-race"
    migrations_dir.mkdir()
    migration = migrations_dir / "0002_checksum_race.sql"
    verified = b"CREATE TABLE verified_payload(id INTEGER PRIMARY KEY);\n"
    changed = b"CREATE TABLE unverified_payload(id INTEGER PRIMARY KEY);\n"
    migration.write_bytes(verified)
    original_read_bytes = Path.read_bytes
    reads = 0

    def changing_read_bytes(path):
        nonlocal reads
        if path == migration:
            reads += 1
            return verified if reads == 1 else changed
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", changing_read_bytes)
    conn = sqlite3.connect(tmp_path / "checksum-race.db")
    migrations_api().apply_migrations(conn, migrations_dir)

    checksum = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE version='0002_checksum_race'"
    ).fetchone()[0]
    assert checksum == hashlib.sha256(verified).hexdigest()
    assert "verified_payload" in table_names(conn)
    assert "unverified_payload" not in table_names(conn)
    assert reads == 1


def test_storage_capacity_sample_persists_write_lock_failure_count(conn):
    conn.execute(
        "INSERT INTO storage_capacity_samples("
        "database_bytes,batch_growth_bytes,backup_duration_ms,write_lock_failure_count,"
        "free_bytes,sample_reason,measured_at) VALUES (1000,200,30,4,5000,'pilot',?)",
        (NOW,),
    )
    assert conn.execute(
        "SELECT write_lock_failure_count FROM storage_capacity_samples"
    ).fetchone()[0] == 4
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO storage_capacity_samples("
            "database_bytes,batch_growth_bytes,backup_duration_ms,write_lock_failure_count,"
            "sample_reason,measured_at) VALUES (1,1,1,-1,'invalid',?)",
            (NOW,),
        )

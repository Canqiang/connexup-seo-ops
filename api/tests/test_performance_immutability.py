import sqlite3

import pytest


def _seed_observation(conn):
    conn.execute(
        "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
        " date_basis, metadata_json, created_at) VALUES"
        " ('GBP','GBP_LOCATION','1','gbp:1','America/New_York','store_local','{}',"
        " '2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_sync_jobs (job_type, request_id, idempotency_key, scope_manifest_json,"
        " scope_manifest_sha256, requested_start_date, requested_end_date, status, requested_by,"
        " created_at) VALUES ('backfill','r1','k1','{}', ?, '2026-08-18','2026-08-19','queued',"
        " 'test','2026-09-09T00:00:00.000000Z')",
        ("a" * 64,),
    )
    conn.execute(
        "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month, attempt,"
        " status, adapter_version, created_at, updated_at) VALUES (1,'GBP',1,'2026-08',1,'published',"
        " 'gbp.v1','2026-09-09T00:00:00.000000Z','2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
        " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
        " numeric_value, availability, completeness, formula_version, published_sequence,"
        " content_sha256, created_at) VALUES (1,1,'CALL_CLICKS','2026-08-18','store_local','{}',?,"
        " '{}',?,3,'available','complete','seo_ops.performance_metrics.v1',1,?,"
        " '2026-09-09T00:00:00.000000Z')",
        ("b" * 64, "c" * 64, "d" * 64),
    )
    conn.commit()


def test_published_observation_cannot_be_updated_or_deleted(conn):
    _seed_observation(conn)
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("UPDATE metric_observations SET numeric_value = 99 WHERE id = 1")
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("DELETE FROM metric_observations WHERE id = 1")


def test_observation_on_non_published_batch_is_also_immutable(conn):
    # 0001's pre-existing guard only blocks rewrites once the linked batch is
    # 'published'. 0006 must make immutability unconditional -- a database
    # guarantee, not a convention that depends on batch lifecycle state --
    # so an observation attached to a still-queued batch must be protected
    # too.
    conn.execute(
        "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
        " date_basis, metadata_json, created_at) VALUES"
        " ('GBP','GBP_LOCATION','1','gbp:1','America/New_York','store_local','{}',"
        " '2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_sync_jobs (job_type, request_id, idempotency_key, scope_manifest_json,"
        " scope_manifest_sha256, requested_start_date, requested_end_date, status, requested_by,"
        " created_at) VALUES ('backfill','r1','k1','{}', ?, '2026-08-18','2026-08-19','queued',"
        " 'test','2026-09-09T00:00:00.000000Z')",
        ("a" * 64,),
    )
    conn.execute(
        "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month, attempt,"
        " status, adapter_version, created_at, updated_at) VALUES (1,'GBP',1,'2026-08',1,'queued',"
        " 'gbp.v1','2026-09-09T00:00:00.000000Z','2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
        " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
        " numeric_value, availability, completeness, formula_version, published_sequence,"
        " content_sha256, created_at) VALUES (1,1,'CALL_CLICKS','2026-08-18','store_local','{}',?,"
        " '{}',?,3,'available','complete','seo_ops.performance_metrics.v1',1,?,"
        " '2026-09-09T00:00:00.000000Z')",
        ("b" * 64, "c" * 64, "d" * 64),
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("UPDATE metric_observations SET numeric_value = 99 WHERE id = 1")
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("DELETE FROM metric_observations WHERE id = 1")


def test_metric_source_artifacts_remain_append_only(conn):
    # 0006 does not add triggers to this table. 0001's own
    # reject_metric_source_artifact_update/_delete triggers already make it
    # unconditionally append-only (see api/migrations/0001_performance_history.sql
    # lines 563-566), so 0006 must not duplicate them -- two triggers firing on
    # the same event with different messages would make any future
    # message-matching test brittle. This test keeps the append-only guarantee
    # covered by this task's suite even though a different migration provides
    # it, matching the message 0001 actually raises.
    _seed_observation(conn)
    conn.execute(
        "INSERT INTO metric_source_artifacts (batch_id, payload, content_type,"
        " payload_sha256, saved_at) VALUES (1, X'00', 'application/json', ?,"
        " '2026-09-09T00:00:00.000000Z')",
        ("e" * 64,),
    )
    conn.commit()
    with pytest.raises(
        sqlite3.IntegrityError, match="metric_source_artifacts are append-only"
    ):
        conn.execute(
            "UPDATE metric_source_artifacts SET content_type = 'text/plain' WHERE id = 1"
        )
    with pytest.raises(
        sqlite3.IntegrityError, match="metric_source_artifacts are append-only"
    ):
        conn.execute("DELETE FROM metric_source_artifacts WHERE id = 1")


def test_heads_and_batches_remain_updatable(conn):
    _seed_observation(conn)
    conn.execute(
        "INSERT INTO metric_observation_heads (logical_key_sha256, observation_id, head_generation,"
        " updated_at) VALUES (?,1,1,'2026-09-09T00:00:00.000000Z')",
        ("c" * 64,),
    )
    # A legitimate head advance points at a newer, later-published observation
    # sharing the same logical key -- bumping head_generation on an unchanged
    # observation_id is not a valid transition under 0001's own head-update
    # guard (published_sequence would not have advanced).
    conn.execute(
        "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
        " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
        " numeric_value, availability, completeness, formula_version, published_sequence,"
        " content_sha256, created_at) VALUES (1,1,'CALL_CLICKS','2026-08-19','store_local','{}',?,"
        " '{}',?,4,'available','complete','seo_ops.performance_metrics.v1',2,?,"
        " '2026-09-09T00:00:00.000000Z')",
        ("e" * 64, "c" * 64, "f" * 64),
    )
    conn.execute(
        "UPDATE metric_observation_heads SET observation_id = 2, head_generation = 2"
        " WHERE observation_id = 1"
    )
    # A batch already 'published' is itself a terminal state under 0001's own
    # transition guard, so batch mutability is exercised on a second, still-
    # queued batch via a valid queued -> leased transition.
    conn.execute(
        "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month,"
        " attempt, status, adapter_version, created_at, updated_at) VALUES (1,'GBP',1,'2026-08',2,"
        " 'queued','gbp.v1','2026-09-09T00:00:00.000000Z','2026-09-09T00:00:00.000000Z')"
    )
    conn.execute("UPDATE metric_sync_batches SET status = 'leased' WHERE id = 2")
    conn.commit()
    assert conn.execute("SELECT head_generation FROM metric_observation_heads").fetchone()[0] == 2
    assert (
        conn.execute("SELECT status FROM metric_sync_batches WHERE id = 2").fetchone()[0]
        == "leased"
    )

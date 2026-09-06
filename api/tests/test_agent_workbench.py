import asyncio
import sqlite3
from dataclasses import asdict, fields
from datetime import datetime, timedelta, timezone
from typing import get_args
from uuid import UUID

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import agent_workbench
from app.auth import require_operator
from app.config import BootstrapAgentSlot
from app.coreai import CoreAiError
from app.db import get_db, init_db


NOW = datetime(2026, 9, 3, 1, 2, 3, tzinfo=timezone.utc)
LOCAL_ID = "11111111-1111-4111-8111-111111111111"
REGISTER_BODY = {
    "coreai_agent_id": "agent-extra",
    "agent_key": "citation-monitor",
    "display_name": "Citation Monitor Agent",
    "role": "监控关键引用与目录变化",
    "sort_order": 70,
    "suspect_after_seconds": 1800,
}


def _workbench_conn(tmp_path, monkeypatch, name="workbench.db"):
    database = tmp_path / name
    monkeypatch.setenv("SEO_OPS_DB", str(database))
    init_db()
    conn = sqlite3.connect(database, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _slot(**overrides):
    values = {
        "env_name": "COREAI_AGENT_ID",
        "agent_key": "diagnosis-plan",
        "display_name": "诊断与计划 Agent",
        "role": "诊断商户并生成可审核 SEO 计划",
        "sort_order": 10,
        "coreai_agent_id": "agent-primary",
    }
    values.update(overrides)
    return BootstrapAgentSlot(**values)


def _request(raw: bytes) -> Request:
    delivered = False

    async def receive():
        nonlocal delivered
        if delivered:
            return {"type": "http.request", "body": b"", "more_body": False}
        delivered = True
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request({"type": "http", "method": "POST", "path": "/"}, receive)


def _build_app(conn=None, coreai=None):
    app = FastAPI()
    app.include_router(
        agent_workbench.router,
        dependencies=[Depends(require_operator)],
    )
    app.dependency_overrides[require_operator] = lambda: "test-operator"
    if conn is not None:
        app.dependency_overrides[get_db] = lambda: conn
    if coreai is not None and hasattr(
        agent_workbench, "get_agent_workbench_coreai"
    ):
        app.dependency_overrides[
            agent_workbench.get_agent_workbench_coreai
        ] = lambda: coreai
        if hasattr(agent_workbench, "get_agent_workbench_coreai_factory"):
            def fake_client_dependency():
                yield coreai

            app.dependency_overrides[
                agent_workbench.get_agent_workbench_coreai_factory
            ] = lambda: fake_client_dependency
    return app


class FakeWorkbenchCoreAi:
    def __init__(self, metadata=None, error=None):
        self.metadata = metadata or {
            "id": "agent-extra",
            "type": "AGENT",
            "status": "PUBLISHED",
            "name": "Citation Monitor",
            "model": "gpt-example",
            "timeout_seconds": 900,
        }
        self.error = error
        self.get_agent_calls = []
        self.list_agent_run_calls = []

    def get_agent(self, agent_id):
        self.get_agent_calls.append(agent_id)
        if self.error is not None:
            raise self.error
        return dict(self.metadata)

    def list_agent_runs(self, agent_id, status, limit):
        self.list_agent_run_calls.append((agent_id, status, limit))
        return {"runs": [], "total": 0}


def test_parser_discard_allowlist_is_exact():
    assert agent_workbench.TOKEN_USAGE_INPUT_FIELD == "input"
    assert agent_workbench.TOKEN_USAGE_OUTPUT_FIELD == "output"
    assert agent_workbench.DISCARDED_UPSTREAM_FIELDS == frozenset(
        {"input", "output", "transcript", "artifacts", "error_stack"}
    )
    assert {field.name for field in fields(agent_workbench.ParsedAgentRun)} == {
        "coreai_run_id",
        "coreai_agent_id",
        "raw_status",
        "trigger_type",
        "started_at",
        "completed_at",
        "completed_at_state",
        "input_tokens",
        "output_tokens",
        "trace_id",
        "error_summary",
        "warnings",
    }
    assert {
        field.name for field in fields(agent_workbench.ParsedAgentRunPage)
    } == {"runs", "total", "returned_count", "observed_at"}
    sentinel_by_field = {
        name: f"private-{name}-sentinel"
        for name in agent_workbench.DISCARDED_UPSTREAM_FIELDS
    }
    page = {
        "runs": [
            {
                "id": "run-private",
                "agent_id": "agent-primary",
                "status": "RUNNING",
                "triggered_by": "WORKFLOW",
                **sentinel_by_field,
            }
        ],
        "total": 1,
    }
    parsed = agent_workbench.parse_agent_run_page("agent-primary", page, NOW)
    rendered = repr(parsed)
    for sentinel in sentinel_by_field.values():
        assert sentinel not in rendered


def test_parser_discards_large_private_fields():
    raw_run = {
        "id": "run-large-private",
        "agent_id": "agent-primary",
        "status": "RUNNING",
        "triggered_by": "WORKFLOW",
        "input": "raw-top-level-input",
        "output": "raw-top-level-output",
        "transcript": "private-transcript",
        "artifacts": ["private-artifact"],
        "error_stack": "private-stack",
    }

    parsed = agent_workbench.parse_agent_run_page(
        "agent-primary", {"runs": [raw_run], "total": 1}, NOW
    )

    assert len(parsed.runs) == 1
    assert parsed.runs[0].coreai_run_id == "run-large-private"
    rendered = repr(parsed)
    for value in raw_run.values():
        if value in ("run-large-private", "agent-primary", "RUNNING", "WORKFLOW"):
            continue
        assert repr(value) not in rendered


@pytest.mark.parametrize(
    ("status", "triggered_by"),
    [
        ("PENDING", "MANUAL"),
        ("RUNNING", "WORKFLOW"),
        ("PAUSED", "SCHEDULED"),
        ("COMPLETED", "API"),
        ("FAILED", "RETRY"),
        ("TIMEOUT", "SYSTEM"),
        ("CANCELLED", "OPERATOR"),
        ("SKIPPED", "future-trigger-kind"),
    ],
)
def test_parse_known_status_and_narrow_fields(status, triggered_by):
    parsed = agent_workbench.parse_agent_run_page(
        "agent-primary",
        {
            "runs": [
                {
                    "id": f"run-{status.lower()}",
                    "agent_id": "agent-primary",
                    "status": status,
                    "triggered_by": triggered_by,
                    "unexpected": "must-not-project",
                }
            ],
            "total": 1,
        },
        NOW,
    )

    run = parsed.runs[0]
    assert run.raw_status == status
    assert run.trigger_type == triggered_by
    assert run.coreai_agent_id == "agent-primary"
    assert "must-not-project" not in repr(run)
    if status == "PENDING":
        for field_name in ("id", "status", "triggered_by"):
            for invalid in (None, "", "   "):
                row = {
                    "id": "run-valid",
                    "agent_id": "agent-primary",
                    "status": "PENDING",
                    "triggered_by": "MANUAL",
                }
                row[field_name] = invalid
                with pytest.raises(ValueError, match=field_name):
                    agent_workbench.parse_agent_run_page(
                        "agent-primary", {"runs": [row], "total": 1}, NOW
                    )
            missing = {
                "id": "run-valid",
                "agent_id": "agent-primary",
                "status": "PENDING",
                "triggered_by": "MANUAL",
            }
            missing.pop(field_name)
            with pytest.raises(ValueError, match=field_name):
                agent_workbench.parse_agent_run_page(
                    "agent-primary", {"runs": [missing], "total": 1}, NOW
                )
        mismatch = {
            "id": "run-wrong-owner",
            "agent_id": "agent-other",
            "status": "PENDING",
            "triggered_by": "MANUAL",
        }
        with pytest.raises(ValueError, match="agent_id"):
            agent_workbench.parse_agent_run_page(
                "agent-primary", {"runs": [mismatch], "total": 1}, NOW
            )
        filtered_mismatch = dict(mismatch, agent_id="agent-primary")
        with pytest.raises(ValueError, match="expected_status"):
            agent_workbench.parse_agent_run_page(
                "agent-primary",
                {"runs": [filtered_mismatch], "total": 1},
                NOW,
                expected_status="RUNNING",
            )


def _parse_one(**overrides):
    row = {
        "id": "run-one",
        "agent_id": "agent-primary",
        "status": "RUNNING",
        "triggered_by": "WORKFLOW",
    }
    row.update(overrides)
    return agent_workbench.parse_agent_run_page(
        "agent-primary", {"runs": [row], "total": 1}, NOW
    ).runs[0]


def test_parse_timestamp_valid_and_missing():
    run = _parse_one(
        started_at="2026-09-03T09:02:03+08:00",
        completed_at="2026-09-03T09:03:03+08:00",
    )

    assert run.started_at == "2026-09-03T01:02:03+00:00"
    assert run.completed_at == "2026-09-03T01:03:03+00:00"
    assert run.completed_at_state == "valid"
    assert run.warnings == ()

    missing = _parse_one()
    assert missing.started_at is None
    assert missing.completed_at is None
    assert missing.completed_at_state == "missing"
    assert missing.warnings == ()


@pytest.mark.parametrize(
    ("field_name", "warning"),
    [
        ("started_at", "INVALID_STARTED_AT"),
        ("completed_at", "INVALID_COMPLETED_AT"),
    ],
)
def test_parse_timestamp_rejects_naive(field_name, warning):
    run = _parse_one(**{field_name: "2026-09-03T01:02:03"})

    assert getattr(run, field_name) is None
    assert run.completed_at_state == (
        "invalid" if field_name == "completed_at" else "missing"
    )
    assert run.warnings == (warning,)


@pytest.mark.parametrize(
    ("field_name", "warning"),
    [
        ("started_at", "INVALID_STARTED_AT"),
        ("completed_at", "INVALID_COMPLETED_AT"),
    ],
)
def test_parse_timestamp_rejects_malformed(field_name, warning):
    run = _parse_one(**{field_name: "not-a-time"})

    assert getattr(run, field_name) is None
    assert run.completed_at_state == (
        "invalid" if field_name == "completed_at" else "missing"
    )
    assert run.warnings == (warning,)


def test_parse_token_pair_accepts_zero():
    run = _parse_one(token_usage={"input": 0, "output": 0})

    assert (run.input_tokens, run.output_tokens) == (0, 0)
    assert run.warnings == ()


@pytest.mark.parametrize(
    "token_usage",
    [{"input": 3}, {"output": 5}],
)
def test_parse_token_pair_rejects_partial(token_usage):
    run = _parse_one(token_usage=token_usage)

    assert (run.input_tokens, run.output_tokens) == (None, None)
    assert run.warnings == ("TOKEN_USAGE_INVALID",)


@pytest.mark.parametrize(
    ("input_value", "output_value"),
    [
        (True, 1),
        (1, False),
        (True, False),
        (-1, 2),
        (2, -1),
        (1.5, 2),
        (1, 2.5),
        ("1", 2),
        (1, "2"),
    ],
)
def test_parse_token_pair_rejects_invalid_scalars(input_value, output_value):
    run = _parse_one(
        token_usage={"input": input_value, "output": output_value}
    )

    assert (run.input_tokens, run.output_tokens) == (None, None)
    assert run.warnings == ("TOKEN_USAGE_INVALID",)


def test_parser_duplicate_rows_are_deterministic():
    row = {
        "id": "run-duplicate",
        "agent_id": "agent-primary",
        "status": "RUNNING",
        "triggered_by": "WORKFLOW",
        "token_usage": {"input": 1, "output": 2},
    }

    parsed = agent_workbench.parse_agent_run_page(
        "agent-primary", {"runs": [row, dict(row)], "total": 1}, NOW
    )

    assert len(parsed.runs) == 1
    assert parsed.returned_count == 1
    assert parsed.runs[0].coreai_run_id == "run-duplicate"

    conflicting = dict(row, status="PAUSED")
    with pytest.raises(ValueError, match="duplicate"):
        agent_workbench.parse_agent_run_page(
            "agent-primary", {"runs": [row, conflicting], "total": 1}, NOW
        )


class DangerousErrorBody:
    def __str__(self):
        raise AssertionError("unsupported upstream error was stringified")

    def __repr__(self):
        raise AssertionError("unsupported upstream error was represented")


@pytest.mark.parametrize(
    ("raw_error", "expected"),
    [
        (
            "request-credential-sentinel could not authenticate",
            "[REDACTED] could not authenticate",
        ),
        (
            {"message": "request-credential-sentinel was refused"},
            "[REDACTED] was refused",
        ),
        (
            "Bearer request-credential-sentinel denied",
            "Bearer [REDACTED] denied",
        ),
        (
            "Authorization: request-credential-sentinel denied",
            "Authorization: [REDACTED] denied",
        ),
        (
            "API-key=request-credential-sentinel denied",
            "API-key=[REDACTED] denied",
        ),
        (
            "https://core.example/runs?api_key=request-credential-sentinel&limit=1",
            "https://core.example/runs?api_key=[REDACTED]&limit=1",
        ),
        (DangerousErrorBody(), "上游消息不可用"),
        ({"body": DangerousErrorBody()}, "上游消息不可用"),
    ],
)
def test_parser_redacts_upstream_error_secrets(raw_error, expected, caplog):
    sentinel = "request-credential-sentinel"
    row = {
        "id": "run-private-error",
        "agent_id": "agent-primary",
        "status": "FAILED",
        "triggered_by": "WORKFLOW",
        "error": raw_error,
    }

    parsed = agent_workbench.parse_agent_run_page(
        "agent-primary",
        {"runs": [row], "total": 1},
        NOW,
        sensitive_values=(sentinel,),
    )

    assert parsed.runs[0].error_summary == expected
    assert sentinel not in repr(parsed)
    assert sentinel not in caplog.text
    if isinstance(raw_error, str) or (
        isinstance(raw_error, dict)
        and isinstance(raw_error.get("message"), str)
    ):
        assert str(raw_error) not in repr(parsed)


def test_parser_rejects_returned_rows_greater_than_total():
    rows = [
        {
            "id": f"run-{index}",
            "agent_id": "agent-primary",
            "status": "RUNNING",
            "triggered_by": "WORKFLOW",
        }
        for index in range(2)
    ]

    with pytest.raises(ValueError, match="total"):
        agent_workbench.parse_agent_run_page(
            "agent-primary", {"runs": rows, "total": 1}, NOW
        )


def _seed_agent_for_projection(conn, monkeypatch):
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), NOW)


def _insert_local_run(conn, coreai_run_id="run-project"):
    merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Projection Merchant',?)",
        (NOW.isoformat(),),
    ).lastrowid
    source_local_id = conn.execute(
        "INSERT INTO runs (merchant_id,coreai_run_id,status,trigger_kind,created_at) "
        "VALUES (?,?,'running','manual',?)",
        (merchant_id, coreai_run_id, NOW.isoformat()),
    ).lastrowid
    conn.commit()
    return merchant_id, source_local_id


def _insert_local_artifact(conn, merchant_id, coreai_run_id):
    source_local_id = conn.execute(
        "INSERT INTO merchant_seo_artifacts "
        "(merchant_id,cycle_id,artifact_type,schema_version,status,"
        "source_agent_id,coreai_run_id,request_json,created_at) "
        "VALUES (?,'cycle-projection','AUDIT_REPORT','test.v1','running',"
        "'agent-primary',?,'{}',?)",
        (merchant_id, coreai_run_id, NOW.isoformat()),
    ).lastrowid
    conn.commit()
    return source_local_id


def _insert_local_task_execution(conn, merchant_id, coreai_run_id, suffix=""):
    plan_id = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id,source_kind,state,latest_revision,created_at) "
        "VALUES (?,'OPERATOR','OPEN',1,?)",
        (merchant_id, NOW.isoformat()),
    ).lastrowid
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id,revision,decision_state,schema_version,payload_json,checksum,"
        "source,created_by,created_at) "
        "VALUES (?,1,'APPROVED','seo_ops.task_plan.v1','{}',?,'OPERATOR',"
        "'test-operator',?)",
        (plan_id, "a" * 64, NOW.isoformat()),
    )
    task_id = conn.execute(
        "INSERT INTO tasks "
        "(merchant_id,plan_id,plan_revision,task_key,task_type,workflow_version,"
        "parameters_json,definition_checksum,title,status,created_at) "
        "VALUES (?,?,1,?,'PREPARE_ONLY',1,'{}',?,'Projection Task','PENDING',?)",
        (
            merchant_id,
            plan_id,
            f"task-{coreai_run_id}{suffix}",
            "b" * 64,
            NOW.isoformat(),
        ),
    ).lastrowid
    execution_id = conn.execute(
        "INSERT INTO task_executions "
        "(task_id,stage,status,attempt,request_json,request_checksum,"
        "idempotency_key,coreai_run_id,created_at) "
        "VALUES (?,'PREPARATION','RUNNING',1,'{}',?,?,?,?)",
        (
            task_id,
            "c" * 64,
            f"idem-{coreai_run_id}{suffix}",
            coreai_run_id,
            NOW.isoformat(),
        ),
    ).lastrowid
    conn.commit()
    return task_id, execution_id


def _parsed_projection_run(**overrides):
    row = {
        "id": "run-project",
        "agent_id": "agent-primary",
        "status": "RUNNING",
        "triggered_by": "WORKFLOW",
        "started_at": "2026-09-03T01:01:03+00:00",
        "token_usage": {"input": 10, "output": 20},
        "trace_id": "trace-project",
    }
    row.update(overrides)
    return agent_workbench.parse_agent_run_page(
        "agent-primary", {"runs": [row], "total": 1}, NOW
    ).runs[0]


def test_projection_new_row_exact_readback(tmp_path, monkeypatch):
    assert get_args(agent_workbench.LocalSourceKind) == (
        "run",
        "task_execution",
        "merchant_seo_artifact",
    )
    binding = agent_workbench.LocalRunBinding("run", 1)
    assert get_args(agent_workbench.ProjectionDisposition) == (
        "inserted",
        "updated",
        "unchanged",
        "older_ignored",
        "conflict_ignored",
    )
    expected_result = agent_workbench.ProjectionResult(
        coreai_run_id="run-project",
        disposition="inserted",
        warning_codes=(),
    )
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-new.db")
    _seed_agent_for_projection(conn, monkeypatch)
    merchant_id, source_local_id = _insert_local_run(conn)
    binding = agent_workbench.LocalRunBinding("run", source_local_id)

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, _parsed_projection_run(), NOW, binding
    )

    assert result == expected_result
    assert dict(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone()) == {
        "coreai_run_id": "run-project",
        "seo_ops_agent_id": LOCAL_ID,
        "raw_status": "RUNNING",
        "trigger_type": "WORKFLOW",
        "started_at": "2026-09-03T01:01:03+00:00",
        "completed_at": None,
        "terminal_observed_at": None,
        "receipt_expires_at": None,
        "input_tokens": 10,
        "output_tokens": 20,
        "trace_id": "trace-project",
        "error_summary": None,
        "source_kind": "run",
        "source_local_id": source_local_id,
        "merchant_id": merchant_id,
        "first_seen_at": NOW.isoformat(),
        "last_poll_attempt_at": NOW.isoformat(),
        "last_synced_at": NOW.isoformat(),
        "last_poll_error": None,
        "data_warning_codes_json": "[]",
    }
    assert conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0] == 1
    conn.close()


def test_projection_first_list_proof_updates_accepted_marker(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-accepted-marker.db")
    _seed_agent_for_projection(conn, monkeypatch)
    merchant_id, source_local_id = _insert_local_run(conn)
    first_seen_at = (NOW - timedelta(seconds=2)).isoformat()
    conn.execute(
        "INSERT INTO seo_ops_agent_runs ("
        "coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,"
        "source_kind,source_local_id,merchant_id,first_seen_at,"
        "data_warning_codes_json"
        ") VALUES (?,?,NULL,NULL,'run',?,?,?,?)",
        (
            "run-project",
            LOCAL_ID,
            source_local_id,
            merchant_id,
            first_seen_at,
            '["LOCAL_TRIGGER_STATUS_MISSING"]',
        ),
    )
    conn.commit()

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, _parsed_projection_run(), NOW
    )

    assert result == agent_workbench.ProjectionResult(
        "run-project", "updated", ()
    )
    row = conn.execute(
        "SELECT seo_ops_agent_id,raw_status,trigger_type,started_at,completed_at,"
        "terminal_observed_at,receipt_expires_at,input_tokens,output_tokens,"
        "trace_id,error_summary,source_kind,source_local_id,merchant_id,"
        "first_seen_at,last_poll_attempt_at,last_synced_at,last_poll_error,"
        "data_warning_codes_json FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(row) == (
        LOCAL_ID,
        "RUNNING",
        "WORKFLOW",
        "2026-09-03T01:01:03+00:00",
        None,
        None,
        None,
        10,
        20,
        "trace-project",
        None,
        "run",
        source_local_id,
        merchant_id,
        first_seen_at,
        NOW.isoformat(),
        NOW.isoformat(),
        None,
        "[]",
    )
    assert conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0] == 1
    conn.close()


def test_projection_same_observation_is_idempotent(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-idempotent.db")
    _seed_agent_for_projection(conn, monkeypatch)
    _, source_local_id = _insert_local_run(conn)
    binding = agent_workbench.LocalRunBinding("run", source_local_id)
    run = _parsed_projection_run()
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, run, NOW, binding)
    before_row = tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    before_revision = conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0]

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, run, NOW, binding
    )

    assert result == agent_workbench.ProjectionResult(
        "run-project", "unchanged", ()
    )
    assert tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone()) == before_row
    assert conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0] == before_revision
    conn.close()


def test_projection_sanitized_error_sqlite_readback(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-private-error.db")
    _seed_agent_for_projection(conn, monkeypatch)
    _, source_local_id = _insert_local_run(conn)
    sentinel = "projection-credential-sentinel"
    parsed = agent_workbench.parse_agent_run_page(
        "agent-primary",
        {
            "runs": [
                {
                    "id": "run-project",
                    "agent_id": "agent-primary",
                    "status": "FAILED",
                    "triggered_by": "WORKFLOW",
                    "error": f"provider rejected {sentinel}",
                }
            ],
            "total": 1,
        },
        NOW,
        sensitive_values=(sentinel,),
    ).runs[0]

    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        parsed,
        NOW,
        agent_workbench.LocalRunBinding("run", source_local_id),
    )

    row = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    assert row["error_summary"] == "provider rejected [REDACTED]"
    assert sentinel not in repr(row)
    conn.close()


def test_projection_data_warning_readback(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-warnings.db")
    _seed_agent_for_projection(conn, monkeypatch)
    invalid = _parsed_projection_run(
        completed_at="malformed-completion",
        token_usage={"input": 7},
    )

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, invalid, NOW
    )

    assert result.warning_codes == (
        "INVALID_COMPLETED_AT",
        "TOKEN_USAGE_INVALID",
    )
    row = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    assert row["data_warning_codes_json"] == (
        '["INVALID_COMPLETED_AT","TOKEN_USAGE_INVALID"]'
    )
    assert row["last_poll_error"] is None

    observed_later = NOW + timedelta(seconds=1)
    recovered = _parsed_projection_run(
        completed_at="2026-09-03T01:02:03+00:00",
        token_usage={"input": 8, "output": 9},
    )
    recovered_result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, recovered, observed_later
    )
    recovered_row = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    assert recovered_result.warning_codes == ()
    assert recovered_row["data_warning_codes_json"] == "[]"
    assert recovered_row["completed_at"] == "2026-09-03T01:02:03+00:00"
    assert (recovered_row["input_tokens"], recovered_row["output_tokens"]) == (8, 9)
    assert recovered_row["last_poll_error"] is None

    conn.execute(
        "UPDATE seo_ops_agent_runs SET data_warning_codes_json="
        "'[\"TERMINAL_STATUS_CONFLICT\"]' WHERE coreai_run_id='run-project'"
    )
    conn.commit()
    invalid_again = _parsed_projection_run(token_usage={"output": 11})
    conflict_result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, invalid_again, NOW + timedelta(seconds=2)
    )
    assert conflict_result.warning_codes == (
        "TERMINAL_STATUS_CONFLICT",
        "TOKEN_USAGE_INVALID",
    )
    assert conn.execute(
        "SELECT data_warning_codes_json FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()[0] == (
        '["TERMINAL_STATUS_CONFLICT","TOKEN_USAGE_INVALID"]'
    )

    valid_again = _parsed_projection_run(token_usage={"input": 12, "output": 13})
    persistent_result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, valid_again, NOW + timedelta(seconds=3)
    )
    assert persistent_result.warning_codes == ("TERMINAL_STATUS_CONFLICT",)
    assert conn.execute(
        "SELECT data_warning_codes_json FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()[0] == '["TERMINAL_STATUS_CONFLICT"]'
    conn.close()


@pytest.mark.parametrize(
    (
        "initial_status",
        "incoming_status",
        "expected_status",
        "expected_disposition",
    ),
    [
        ("PENDING", "RUNNING", "RUNNING", "updated"),
        ("PENDING", "PAUSED", "PAUSED", "updated"),
        ("RUNNING", "PAUSED", "PAUSED", "updated"),
        ("PAUSED", "PENDING", "PENDING", "updated"),
        ("PAUSED", "RUNNING", "RUNNING", "updated"),
        ("RUNNING", "COMPLETED", "COMPLETED", "updated"),
        ("COMPLETED", "RUNNING", "COMPLETED", "conflict_ignored"),
        ("COMPLETED", "FAILED", "COMPLETED", "conflict_ignored"),
        ("FUTURE_STATE", "RUNNING", "RUNNING", "updated"),
        ("FUTURE_STATE", "FUTURE_STATE_2", "FUTURE_STATE_2", "updated"),
        ("RUNNING", "FUTURE_STATE", "FUTURE_STATE", "updated"),
        ("COMPLETED", "FUTURE_STATE", "COMPLETED", "conflict_ignored"),
    ],
)
def test_projection_transition_truth_table(
    tmp_path,
    monkeypatch,
    initial_status,
    incoming_status,
    expected_status,
    expected_disposition,
):
    conn = _workbench_conn(
        tmp_path,
        monkeypatch,
        f"transition-{initial_status}-{incoming_status}.db",
    )
    _seed_agent_for_projection(conn, monkeypatch)
    initial = _parsed_projection_run(status=initial_status)
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, initial, NOW)
    if initial_status not in {
        "PENDING", "RUNNING", "PAUSED", "COMPLETED", "FAILED",
        "TIMEOUT", "CANCELLED", "SKIPPED",
    }:
        assert conn.execute(
            "SELECT unresolved_unknown_status_count "
            "FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
            (LOCAL_ID,),
        ).fetchone()[0] == 1
    authoritative_columns = (
        "raw_status",
        "trigger_type",
        "started_at",
        "completed_at",
        "input_tokens",
        "output_tokens",
        "trace_id",
        "error_summary",
        "terminal_observed_at",
        "receipt_expires_at",
    )
    authoritative_before = tuple(conn.execute(
        f"SELECT {','.join(authoritative_columns)} FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone())
    incoming_overrides = {"status": incoming_status}
    if initial_status in {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}:
        incoming_overrides.update(
            triggered_by="LATER_TRIGGER",
            started_at="2026-09-03T01:02:00+00:00",
            completed_at="2026-09-03T01:02:01+00:00",
            token_usage={"input": 101, "output": 202},
            trace_id="later-trace",
            error="later-error",
        )

    result = agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(**incoming_overrides),
        NOW + timedelta(seconds=1),
    )

    row = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    assert row["raw_status"] == expected_status
    assert result.disposition == expected_disposition
    assert row["last_synced_at"] == (NOW + timedelta(seconds=1)).isoformat()
    expected_unknown_count = int(
        expected_status not in {
            "PENDING", "RUNNING", "PAUSED", "COMPLETED", "FAILED",
            "TIMEOUT", "CANCELLED", "SKIPPED",
        }
    )
    assert conn.execute(
        "SELECT unresolved_unknown_status_count "
        "FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0] == expected_unknown_count
    if initial_status in {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}:
        authoritative_after = tuple(conn.execute(
            f"SELECT {','.join(authoritative_columns)} FROM seo_ops_agent_runs "
            "WHERE coreai_run_id='run-project'"
        ).fetchone())
        assert authoritative_after == authoritative_before
    if (
        initial_status in {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
        and incoming_status not in {"PENDING", "RUNNING", "PAUSED"}
        and incoming_status != initial_status
    ):
        assert result.warning_codes == ("TERMINAL_STATUS_CONFLICT",)
        assert row["data_warning_codes_json"] == '["TERMINAL_STATUS_CONFLICT"]'
    conn.close()


def test_projection_older_observation_cannot_overwrite_or_rewind(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-older.db")
    _seed_agent_for_projection(conn, monkeypatch)
    latest_observation = NOW + timedelta(seconds=10)
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(),
        latest_observation,
    )
    before = tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone())
    revision = conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0]
    older = _parsed_projection_run(
        status="PAUSED",
        triggered_by="OLDER_TRIGGER",
        started_at="2026-09-02T00:00:00+00:00",
        completed_at="2026-09-02T00:01:00+00:00",
        token_usage={"input": 999, "output": 888},
        trace_id="older-trace",
        error="older-error",
    )

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, older, NOW
    )

    assert result.disposition == "older_ignored"
    assert tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='run-project'"
    ).fetchone()) == before
    assert conn.execute(
        "SELECT projection_revision FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (LOCAL_ID,),
    ).fetchone()[0] == revision
    conn.close()


def test_projection_same_terminal_different_payload_keeps_first_authoritative_tuple(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "projection-terminal-repeat.db")
    _seed_agent_for_projection(conn, monkeypatch)
    initial = _parsed_projection_run(
        status="COMPLETED",
        triggered_by="FIRST_TRIGGER",
        started_at="2026-09-03T01:00:00+00:00",
        completed_at=NOW.isoformat(),
        token_usage={"input": 10, "output": 20},
        trace_id="first-trace",
        error="first-error",
    )
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, initial, NOW)
    authoritative_columns = (
        "raw_status",
        "trigger_type",
        "started_at",
        "completed_at",
        "input_tokens",
        "output_tokens",
        "trace_id",
        "error_summary",
        "terminal_observed_at",
        "receipt_expires_at",
    )
    before = tuple(conn.execute(
        f"SELECT {','.join(authoritative_columns)} FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone())
    incoming = _parsed_projection_run(
        status="COMPLETED",
        triggered_by="SECOND_TRIGGER",
        started_at="2026-09-03T01:00:30+00:00",
        completed_at="2026-09-03T01:02:04+00:00",
        token_usage={"input": 30, "output": 40},
        trace_id="second-trace",
        error="second-error",
    )

    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, incoming, NOW + timedelta(seconds=1)
    )

    after = tuple(conn.execute(
        f"SELECT {','.join(authoritative_columns)} FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone())
    assert after == before
    assert result == agent_workbench.ProjectionResult(
        "run-project", "updated", ()
    )
    row = conn.execute(
        "SELECT last_poll_attempt_at,last_synced_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(row) == (
        (NOW + timedelta(seconds=1)).isoformat(),
        (NOW + timedelta(seconds=1)).isoformat(),
    )
    conn.close()


def test_receipt_for_recent_valid_completion(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "receipt-recent.db")
    _seed_agent_for_projection(conn, monkeypatch)
    completed = _parsed_projection_run(
        status="COMPLETED", completed_at=NOW.isoformat()
    )

    agent_workbench.upsert_projected_run(conn, LOCAL_ID, completed, NOW)

    row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(row) == (
        NOW.isoformat(),
        (NOW + timedelta(seconds=10)).isoformat(),
    )

    boundary = _parsed_projection_run(
        id="run-boundary",
        status="COMPLETED",
        completed_at=(NOW - timedelta(seconds=10)).isoformat(),
    )
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, boundary, NOW)
    boundary_row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-boundary'"
    ).fetchone()
    assert tuple(boundary_row) == (
        NOW.isoformat(),
        (NOW + timedelta(seconds=10)).isoformat(),
    )
    conn.close()


def test_receipt_rejects_future_or_old_completion(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "receipt-reject.db")
    _seed_agent_for_projection(conn, monkeypatch)
    agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, _parsed_projection_run(), NOW - timedelta(seconds=1)
    )
    future = _parsed_projection_run(
        status="COMPLETED",
        completed_at=(NOW + timedelta(seconds=1)).isoformat(),
    )

    agent_workbench.upsert_projected_run(conn, LOCAL_ID, future, NOW)

    row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(row) == (NOW.isoformat(), None)

    old = _parsed_projection_run(
        id="run-old-completion",
        status="COMPLETED",
        completed_at=(NOW - timedelta(seconds=11)).isoformat(),
    )
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, old, NOW)
    old_row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-old-completion'"
    ).fetchone()
    assert tuple(old_row) == (NOW.isoformat(), None)
    conn.close()


def test_receipt_missing_completion_requires_recent_known_nonterminal(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "receipt-missing.db")
    _seed_agent_for_projection(conn, monkeypatch)
    previous_observation = NOW - timedelta(seconds=15)
    agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, _parsed_projection_run(), previous_observation
    )

    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(status="COMPLETED"),
        NOW,
    )

    row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(row) == (
        NOW.isoformat(),
        (NOW + timedelta(seconds=10)).isoformat(),
    )

    unknown = _parsed_projection_run(id="run-unknown", status="QUEUED_REMOTE")
    agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, unknown, NOW - timedelta(seconds=1)
    )
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-unknown", status="COMPLETED"),
        NOW,
    )
    unknown_row = conn.execute(
        "SELECT receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-unknown'"
    ).fetchone()
    assert unknown_row[0] is None

    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-backfill", status="COMPLETED"),
        NOW,
    )
    backfill_row = conn.execute(
        "SELECT receipt_expires_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-backfill'"
    ).fetchone()
    assert backfill_row[0] is None
    conn.close()


def test_receipt_invalid_time_and_old_backfill_never_enter(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "receipt-invalid.db")
    _seed_agent_for_projection(conn, monkeypatch)
    for run_id, invalid_completed_at in (
        ("run-naive", "2026-09-03T01:02:03"),
        ("run-malformed", "not-a-time"),
    ):
        agent_workbench.upsert_projected_run(
            conn,
            LOCAL_ID,
            _parsed_projection_run(id=run_id),
            NOW - timedelta(seconds=1),
        )
        agent_workbench.upsert_projected_run(
            conn,
            LOCAL_ID,
            _parsed_projection_run(
                id=run_id,
                status="COMPLETED",
                completed_at=invalid_completed_at,
            ),
            NOW,
        )
        row = conn.execute(
            "SELECT terminal_observed_at,receipt_expires_at "
            "FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run_id,),
        ).fetchone()
        assert tuple(row) == (NOW.isoformat(), None)

    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(
            id="run-old-backfill",
            status="COMPLETED",
            completed_at=(NOW - timedelta(hours=1)).isoformat(),
        ),
        NOW,
    )
    backfill_row = conn.execute(
        "SELECT terminal_observed_at,receipt_expires_at "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='run-old-backfill'"
    ).fetchone()
    assert tuple(backfill_row) == (NOW.isoformat(), None)
    conn.close()


def test_receipt_and_terminal_observation_are_immutable_on_repeat(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "receipt-repeat.db")
    _seed_agent_for_projection(conn, monkeypatch)
    agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, _parsed_projection_run(), NOW - timedelta(seconds=1)
    )
    first_terminal = _parsed_projection_run(
        status="COMPLETED",
        completed_at=NOW.isoformat(),
        triggered_by="WORKFLOW",
        token_usage={"input": 10, "output": 20},
        trace_id="trace-first-terminal",
        error="first terminal",
    )
    agent_workbench.upsert_projected_run(conn, LOCAL_ID, first_terminal, NOW)
    authoritative = tuple(
        conn.execute(
            "SELECT raw_status,trigger_type,started_at,completed_at,input_tokens,"
            "output_tokens,trace_id,error_summary,terminal_observed_at,"
            "receipt_expires_at FROM seo_ops_agent_runs "
            "WHERE coreai_run_id='run-project'"
        ).fetchone()
    )

    repeated = _parsed_projection_run(
        status="COMPLETED",
        started_at=(NOW - timedelta(hours=2)).isoformat(),
        completed_at=(NOW + timedelta(seconds=5)).isoformat(),
        triggered_by="MANUAL",
        token_usage={"input": 999, "output": 888},
        trace_id="trace-repeat",
        error="later terminal",
    )
    result = agent_workbench.upsert_projected_run(
        conn, LOCAL_ID, repeated, NOW + timedelta(seconds=5)
    )

    repeated_row = conn.execute(
        "SELECT raw_status,trigger_type,started_at,completed_at,input_tokens,"
        "output_tokens,trace_id,error_summary,terminal_observed_at,"
        "receipt_expires_at,last_synced_at FROM seo_ops_agent_runs "
        "WHERE coreai_run_id='run-project'"
    ).fetchone()
    assert tuple(repeated_row[:10]) == authoritative
    assert repeated_row[10] == (NOW + timedelta(seconds=5)).isoformat()
    assert result.disposition == "updated"
    conn.close()


def test_resolve_local_association_zero_one_many(tmp_path, monkeypatch):
    expected = agent_workbench.LocalAssociationResolution(
        binding=None,
        merchant_id=None,
        local_href=None,
        local_label=None,
        warning_codes=(),
    )
    conn = _workbench_conn(tmp_path, monkeypatch, "association-resolution.db")
    _seed_agent_for_projection(conn, monkeypatch)
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-unassociated"),
        NOW,
    )

    result = agent_workbench.resolve_local_association(conn, "run-unassociated")

    assert result == expected

    merchant_id, source_local_id = _insert_local_run(conn, "run-unique")
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-unique"),
        NOW,
    )
    unique = agent_workbench.resolve_local_association(conn, "run-unique")
    assert unique == agent_workbench.LocalAssociationResolution(
        binding=agent_workbench.LocalRunBinding("run", source_local_id),
        merchant_id=merchant_id,
        local_href=f"/runs/{source_local_id}",
        local_label=f"Run #{source_local_id}",
        warning_codes=(),
    )
    bound_row = conn.execute(
        "SELECT source_kind,source_local_id,merchant_id "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='run-unique'"
    ).fetchone()
    assert tuple(bound_row) == ("run", source_local_id, merchant_id)

    conflict_merchant_id, _ = _insert_local_run(conn, "run-conflict")
    _insert_local_artifact(conn, conflict_merchant_id, "run-conflict")
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-conflict"),
        NOW,
    )
    conflict = agent_workbench.resolve_local_association(conn, "run-conflict")
    assert conflict == agent_workbench.LocalAssociationResolution(
        binding=None,
        merchant_id=None,
        local_href=None,
        local_label=None,
        warning_codes=("LOCAL_ASSOCIATION_CONFLICT",),
    )
    conflict_row = conn.execute(
        "SELECT source_kind,source_local_id,merchant_id "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='run-conflict'"
    ).fetchone()
    assert tuple(conflict_row) == (None, None, None)

    _insert_local_artifact(conn, merchant_id, "run-unique")
    bound_conflict = agent_workbench.resolve_local_association(conn, "run-unique")
    assert bound_conflict == agent_workbench.LocalAssociationResolution(
        binding=agent_workbench.LocalRunBinding("run", source_local_id),
        merchant_id=merchant_id,
        local_href=f"/runs/{source_local_id}",
        local_label=f"Run #{source_local_id}",
        warning_codes=("LOCAL_ASSOCIATION_CONFLICT",),
    )
    preserved = conn.execute(
        "SELECT source_kind,source_local_id,merchant_id "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='run-unique'"
    ).fetchone()
    assert tuple(preserved) == ("run", source_local_id, merchant_id)

    conn.execute("DROP INDEX idx_runs_coreai_run_id")
    conn.execute("DROP TRIGGER trg_runs_coreai_run_id_unique_insert")
    conn.execute("DROP TRIGGER trg_runs_coreai_run_id_unique_update")
    _insert_local_run(conn, "run-conflict-within-runs")
    _insert_local_run(conn, "run-conflict-within-runs")
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-conflict-within-runs"),
        NOW,
    )
    within_runs = agent_workbench.resolve_local_association(
        conn, "run-conflict-within-runs"
    )
    assert within_runs.warning_codes == ("LOCAL_ASSOCIATION_CONFLICT",)
    assert within_runs.binding is None

    conn.execute("DROP TRIGGER trg_task_executions_coreai_run_id_unique_insert")
    conn.execute("DROP TRIGGER trg_task_executions_coreai_run_id_unique_update")
    task_conflict_merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Task Conflict',?)",
        (NOW.isoformat(),),
    ).lastrowid
    _insert_local_task_execution(
        conn, task_conflict_merchant_id, "run-conflict-within-tasks", "-a"
    )
    _insert_local_task_execution(
        conn, task_conflict_merchant_id, "run-conflict-within-tasks", "-b"
    )
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-conflict-within-tasks"),
        NOW,
    )
    within_tasks = agent_workbench.resolve_local_association(
        conn, "run-conflict-within-tasks"
    )
    assert within_tasks.warning_codes == ("LOCAL_ASSOCIATION_CONFLICT",)
    assert within_tasks.binding is None

    stale_merchant_id, stale_run_id = _insert_local_run(
        conn, "run-stale-binding"
    )
    agent_workbench.upsert_projected_run(
        conn,
        LOCAL_ID,
        _parsed_projection_run(id="run-stale-binding"),
        NOW,
    )
    agent_workbench.resolve_local_association(conn, "run-stale-binding")
    conn.execute(
        "UPDATE runs SET coreai_run_id=NULL WHERE id=?", (stale_run_id,)
    )
    _insert_local_artifact(conn, stale_merchant_id, "run-stale-binding")
    stale_conflict = agent_workbench.resolve_local_association(
        conn, "run-stale-binding"
    )
    assert stale_conflict == agent_workbench.LocalAssociationResolution(
        agent_workbench.LocalRunBinding("run", stale_run_id),
        stale_merchant_id,
        None,
        None,
        ("LOCAL_ASSOCIATION_CONFLICT",),
    )
    conn.close()


def test_association_links_and_merchant_delete(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "association-links.db")
    _seed_agent_for_projection(conn, monkeypatch)
    run_merchant_id, run_local_id = _insert_local_run(conn, "link-run")
    task_merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Task Merchant',?)",
        (NOW.isoformat(),),
    ).lastrowid
    task_id, execution_id = _insert_local_task_execution(
        conn, task_merchant_id, "link-task"
    )
    artifact_merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Artifact Merchant',?)",
        (NOW.isoformat(),),
    ).lastrowid
    artifact_id = _insert_local_artifact(
        conn, artifact_merchant_id, "link-artifact"
    )
    for coreai_run_id in ("link-run", "link-task", "link-artifact"):
        agent_workbench.upsert_projected_run(
            conn,
            LOCAL_ID,
            _parsed_projection_run(id=coreai_run_id),
            NOW,
        )

    assert agent_workbench.resolve_local_association(conn, "link-run") == (
        agent_workbench.LocalAssociationResolution(
            agent_workbench.LocalRunBinding("run", run_local_id),
            run_merchant_id,
            f"/runs/{run_local_id}",
            f"Run #{run_local_id}",
            (),
        )
    )
    assert agent_workbench.resolve_local_association(conn, "link-task") == (
        agent_workbench.LocalAssociationResolution(
            agent_workbench.LocalRunBinding("task_execution", execution_id),
            task_merchant_id,
            f"/tasks/{task_id}",
            "Projection Task",
            (),
        )
    )
    assert agent_workbench.resolve_local_association(conn, "link-artifact") == (
        agent_workbench.LocalAssociationResolution(
            agent_workbench.LocalRunBinding("merchant_seo_artifact", artifact_id),
            artifact_merchant_id,
            f"/merchants/{artifact_merchant_id}/profile",
            f"AUDIT_REPORT #{artifact_id}",
            (),
        )
    )

    for trigger_name in (
        "guard_merchants_delete_with_task_plan_history",
        "guard_merchants_delete_with_operator_command_history",
        "guard_merchants_delete_with_durable_history",
    ):
        conn.execute(f"DROP TRIGGER {trigger_name}")
    conn.execute("DELETE FROM merchants WHERE id=?", (artifact_merchant_id,))
    conn.commit()
    projected = conn.execute(
        "SELECT source_kind,source_local_id,merchant_id "
        "FROM seo_ops_agent_runs WHERE coreai_run_id='link-artifact'"
    ).fetchone()
    assert tuple(projected) == (
        "merchant_seo_artifact",
        artifact_id,
        None,
    )
    assert agent_workbench.resolve_local_association(conn, "link-artifact") == (
        agent_workbench.LocalAssociationResolution(
            agent_workbench.LocalRunBinding(
                "merchant_seo_artifact", artifact_id
            ),
            None,
            None,
            None,
            (),
        )
    )
    conn.close()


def test_association_preflight_warnings(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "association-preflight.db")
    conn.execute("DROP INDEX idx_runs_coreai_run_id")
    conn.execute("DROP TRIGGER trg_runs_coreai_run_id_unique_insert")
    conn.execute("DROP TRIGGER trg_runs_coreai_run_id_unique_update")
    conn.execute("DROP TRIGGER trg_task_executions_coreai_run_id_unique_insert")
    conn.execute("DROP TRIGGER trg_task_executions_coreai_run_id_unique_update")

    across_merchant_id, _ = _insert_local_run(conn, "duplicate-across")
    _insert_local_artifact(conn, across_merchant_id, "duplicate-across")
    _insert_local_run(conn, "duplicate-runs")
    _insert_local_run(conn, "duplicate-runs")
    task_merchant_id = conn.execute(
        "INSERT INTO merchants (name,created_at) VALUES ('Duplicate Task',?)",
        (NOW.isoformat(),),
    ).lastrowid
    _insert_local_task_execution(
        conn, task_merchant_id, "duplicate-tasks", "-a"
    )
    _insert_local_task_execution(
        conn, task_merchant_id, "duplicate-tasks", "-b"
    )
    _insert_local_run(conn, "single-run")

    assert agent_workbench.association_preflight_warnings(conn) == [
        {
            "code": "LOCAL_ASSOCIATION_CONFLICT",
            "message": "Core AI Run ID 对应多个本地记录",
            "fields": {
                "coreai_run_id": "duplicate-across",
                "source_kinds": "merchant_seo_artifact,run",
            },
        },
        {
            "code": "LOCAL_ASSOCIATION_CONFLICT",
            "message": "Core AI Run ID 对应多个本地记录",
            "fields": {
                "coreai_run_id": "duplicate-runs",
                "source_kinds": "run",
            },
        },
        {
            "code": "LOCAL_ASSOCIATION_CONFLICT",
            "message": "Core AI Run ID 对应多个本地记录",
            "fields": {
                "coreai_run_id": "duplicate-tasks",
                "source_kinds": "task_execution",
            },
        },
    ]
    conn.close()


def test_workbench_error_detail_shape():
    app = _build_app()

    @app.get("/test-workbench-error")
    def raise_workbench_error():
        raise agent_workbench.WorkbenchError(
            409,
            "TEST_CONFLICT",
            "可重试的冲突",
            {"agent_key": "已存在"},
        )

    with TestClient(app) as client:
        response = client.get("/test-workbench-error")

    assert response.status_code == 409
    assert response.json() == {
        "detail": {
            "code": "TEST_CONFLICT",
            "message": "可重试的冲突",
            "fields": {"agent_key": "已存在"},
        }
    }


def test_workbench_sanitizer_redacts_credentials():
    api_key = "request-api-key-sentinel"
    auth_secret = "request-auth-secret-sentinel"
    rows = (
        (f"upstream {api_key} failed", "upstream [REDACTED] failed"),
        (
            {"message": f"local auth {auth_secret} failed"},
            "local auth [REDACTED] failed",
        ),
        ("Bearer bearer-token-sentinel failed", "Bearer [REDACTED] failed"),
        (
            "Authorization: Basic basic-token-sentinel; denied",
            "Authorization: [REDACTED]; denied",
        ),
        ("API-key=labelled-key-sentinel denied", "API-key=[REDACTED] denied"),
        ("token: labelled-token-sentinel denied", "token: [REDACTED] denied"),
        ("secret = labelled-secret-sentinel", "secret = [REDACTED]"),
        (
            '{"api_key": "external key with spaces"}',
            '{"api_key": "[REDACTED]"}',
        ),
        (
            '{"Authorization": "Basic abc def"}',
            '{"Authorization": "[REDACTED]"}',
        ),
        ("{'token': 'alpha beta'}", "{'token': '[REDACTED]'}"),
        ('{"secret": "alpha,beta"}', '{"secret": "[REDACTED]"}'),
        ('{"API-key": "quoted-api-key"}', '{"API-key": "[REDACTED]"}'),
        (
            "GET https://core.example/runs?api_key=query-secret&limit=2 failed",
            "GET https://core.example/runs?api_key=[REDACTED]&limit=2 failed",
        ),
        (
            "https://core.example/runs?safe=yes&ACCESS-TOKEN=query-token#part",
            "https://core.example/runs?safe=yes&ACCESS-TOKEN=[REDACTED]#part",
        ),
        (
            "https://core.example/runs?authorization=query-auth;key=query-key",
            "https://core.example/runs?authorization=[REDACTED];key=[REDACTED]",
        ),
        ("upstream\x00failed\n\t retry", "upstream failed retry"),
        ("界" * 241, "界" * 240),
    )
    for raw, expected in rows:
        assert agent_workbench.sanitize_operator_text(
            raw,
            sensitive_values=(api_key, auth_secret),
        ) == expected

    class DangerousBody:
        def __str__(self):
            raise AssertionError("raw object was stringified")

        def __repr__(self):
            raise AssertionError("raw object was represented")

    assert agent_workbench.sanitize_operator_text(DangerousBody()) == (
        "上游消息不可用"
    )
    for ordering in (("abc", "abcdef", "abc"), ("abcdef", "abc")):
        sanitized = agent_workbench.sanitize_operator_text(
            "credential=abcdef",
            sensitive_values=ordering,
        )
        assert sanitized == "credential=[REDACTED]"
        assert "def" not in sanitized


def test_seed_new_configured_agent(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))

    warnings = agent_workbench.seed_configured_agents(conn, (_slot(),), NOW)

    assert warnings == []
    assert dict(conn.execute("SELECT * FROM seo_ops_agents").fetchone()) | {
        "coreai_name": None,
    } == dict(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    agent = dict(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    assert {
        key: agent[key]
        for key in (
            "id",
            "agent_key",
            "coreai_agent_id",
            "display_name",
            "role",
            "sort_order",
            "status",
            "suspect_after_seconds",
            "created_at",
            "updated_at",
        )
    } == {
        "id": LOCAL_ID,
        "agent_key": "diagnosis-plan",
        "coreai_agent_id": "agent-primary",
        "display_name": "诊断与计划 Agent",
        "role": "诊断商户并生成可审核 SEO 计划",
        "sort_order": 10,
        "status": "active",
        "suspect_after_seconds": 1800,
        "created_at": NOW.isoformat(),
        "updated_at": NOW.isoformat(),
    }
    sync = dict(conn.execute("SELECT * FROM seo_ops_agent_sync_state").fetchone())
    assert sync["seo_ops_agent_id"] == LOCAL_ID
    assert sync["sync_pending"] == 1
    assert sync["next_discovery_at"] == NOW.isoformat()
    conn.close()


def test_seed_repeat_preserves_operator_fields_and_history(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "seed-repeat.db")
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), NOW)
    conn.execute(
        "UPDATE seo_ops_agents SET display_name='Operator Name', role='Operator Role', "
        "sort_order=99, suspect_after_seconds=7200 WHERE id=?",
        (LOCAL_ID,),
    )
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
        "VALUES ('run-existing',?,'COMPLETED',?)",
        (LOCAL_ID, NOW.isoformat()),
    )
    conn.commit()
    before_agent = tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    before_sync = tuple(conn.execute("SELECT * FROM seo_ops_agent_sync_state").fetchone())
    before_runs = [tuple(row) for row in conn.execute("SELECT * FROM seo_ops_agent_runs")]

    warnings = agent_workbench.seed_configured_agents(
        conn,
        (_slot(display_name="New Default", role="New Role", sort_order=3),),
        NOW,
    )

    assert warnings == []
    assert tuple(conn.execute("SELECT * FROM seo_ops_agents").fetchone()) == before_agent
    assert tuple(conn.execute("SELECT * FROM seo_ops_agent_sync_state").fetchone()) == before_sync
    assert [tuple(row) for row in conn.execute("SELECT * FROM seo_ops_agent_runs")] == before_runs
    conn.close()


def test_seed_removed_env_keeps_existing_registry_and_history(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "seed-removed.db")
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, (_slot(),), NOW)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
        "VALUES ('run-existing',?,'RUNNING',?)",
        (LOCAL_ID, NOW.isoformat()),
    )
    conn.commit()
    before = {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")]
        for table in (
            "seo_ops_agents",
            "seo_ops_agent_sync_state",
            "seo_ops_agent_runs",
        )
    }

    assert agent_workbench.seed_configured_agents(conn, (), NOW) == []

    after = {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")]
        for table in before
    }
    assert after == before
    conn.close()


def test_seed_conflict_warnings_are_recomputed(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "seed-conflicts.db")
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    duplicate = _slot(
        env_name="COREAI_EXECUTION_AGENT_ID",
        agent_key="task-preparation",
        display_name="任务准备 Agent",
        role="为已批准任务准备执行材料",
        sort_order=20,
    )

    warnings = agent_workbench.seed_configured_agents(
        conn,
        (_slot(), duplicate),
        NOW,
    )

    assert [dict(row) for row in conn.execute(
        "SELECT agent_key,coreai_agent_id FROM seo_ops_agents"
    )] == [{"agent_key": "diagnosis-plan", "coreai_agent_id": "agent-primary"}]
    assert warnings == [
        {
            "code": "CONFIG_DUPLICATE_AGENT_ID",
            "message": "多个配置槽使用同一个 Core AI Agent ID",
            "fields": {
                "coreai_agent_id": "agent-primary",
                "selected_env": "COREAI_AGENT_ID",
                "ignored_env": "COREAI_EXECUTION_AGENT_ID",
            },
        }
    ]

    conflicting = _slot(coreai_agent_id="agent-replacement")
    duplicate_conflicting = _slot(
        env_name="COREAI_EXECUTION_AGENT_ID",
        agent_key="task-preparation",
        display_name="任务准备 Agent",
        role="为已批准任务准备执行材料",
        sort_order=20,
        coreai_agent_id="agent-replacement",
    )
    expected = [
        {
            "code": "CONFIG_ROLE_CONFLICT",
            "message": "配置角色已绑定另一个 Core AI Agent ID",
            "fields": {
                "agent_key": "diagnosis-plan",
                "configured_coreai_agent_id": "agent-replacement",
                "registered_coreai_agent_id": "agent-primary",
                "env_name": "COREAI_AGENT_ID",
            },
        },
        {
            "code": "CONFIG_DUPLICATE_AGENT_ID",
            "message": "多个配置槽使用同一个 Core AI Agent ID",
            "fields": {
                "coreai_agent_id": "agent-replacement",
                "selected_env": "COREAI_AGENT_ID",
                "ignored_env": "COREAI_EXECUTION_AGENT_ID",
            },
        },
    ]
    assert agent_workbench.seed_configured_agents(
        conn, (conflicting, duplicate_conflicting), NOW
    ) == expected
    assert [
        asdict(warning)
        for warning in agent_workbench.bootstrap_configuration_warnings(
            conn, (conflicting, duplicate_conflicting)
        )
    ] == expected
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 1
    conn.close()


def test_read_workbench_json_empty_bytes():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        asyncio.run(agent_workbench.read_workbench_json(_request(b"")))
    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "REQUEST_BODY_REQUIRED",
        "message": "请求正文不能为空",
        "fields": {"body": "请求正文不能为空"},
    }


def test_read_workbench_json_malformed_bytes():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        asyncio.run(agent_workbench.read_workbench_json(_request(b'{"broken"')))
    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "INVALID_JSON",
        "message": "请求正文不是有效的 JSON",
        "fields": {"body": "请求正文不是有效的 JSON"},
    }


@pytest.mark.parametrize("raw", [b"[]", b"null", b"true", b'"text"', b"3"])
def test_read_workbench_json_requires_object_root(raw):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        asyncio.run(agent_workbench.read_workbench_json(_request(raw)))
    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {"body": "必须是 JSON 对象"},
    }


def test_require_empty_workbench_body_accepts_zero_bytes():
    assert asyncio.run(
        agent_workbench.require_empty_workbench_body(_request(b""))
    ) is None


@pytest.mark.parametrize("raw", [b" ", b"{}", b"null", b"anything"])
def test_require_empty_workbench_body_rejects_nonzero_bytes(raw):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        asyncio.run(agent_workbench.require_empty_workbench_body(_request(raw)))
    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "UNEXPECTED_REQUEST_BODY",
        "message": "此操作不接受请求正文",
        "fields": {"body": "此操作不接受请求正文"},
    }


@pytest.mark.parametrize("missing", tuple(REGISTER_BODY))
def test_register_dto_missing_required_fields(missing):
    raw = {key: value for key, value in REGISTER_BODY.items() if key != missing}
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.RegisterAgentRequest,
            raw,
        )
    assert raised.value.status_code == 422
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {missing: "Field required"},
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("coreai_agent_id", 7),
        ("agent_key", ["citation-monitor"]),
        ("display_name", True),
        ("role", {"text": "role"}),
        ("sort_order", "70"),
        ("suspect_after_seconds", "1800"),
    ],
)
def test_register_dto_wrong_types(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.RegisterAgentRequest,
            {**REGISTER_BODY, field: value},
        )
    assert raised.value.status_code == 422
    assert raised.value.detail["code"] == "VALIDATION_ERROR"
    assert tuple(raised.value.detail["fields"]) == (field,)


def test_register_dto_rejects_extra_fields():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.RegisterAgentRequest,
            {**REGISTER_BODY, "unexpected": "value"},
        )
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {"unexpected": "Extra inputs are not permitted"},
    }


@pytest.mark.parametrize("field", ["sort_order", "suspect_after_seconds"])
@pytest.mark.parametrize("value", ["70", 70.0, True])
def test_register_dto_integer_fields_reject_coercion(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.RegisterAgentRequest,
            {**REGISTER_BODY, field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("display_name", 7),
        ("role", ["role"]),
        ("sort_order", "70"),
        ("suspect_after_seconds", 1800.0),
        ("lifecycle_status", "retired"),
    ],
)
def test_edit_dto_rejects_wrong_types(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.UpdateAgentRequest,
            {field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


def test_edit_dto_rejects_empty_patch():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.UpdateAgentRequest,
            {},
        )
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {"body": "至少提供一个要更新的字段"},
    }


def test_edit_dto_rejects_extra_fields():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.UpdateAgentRequest,
            {"display_name": "Updated", "coreai_agent_id": "immutable"},
        )
    assert raised.value.detail["fields"] == {
        "coreai_agent_id": "Extra inputs are not permitted"
    }


@pytest.mark.parametrize(
    "field",
    [
        "display_name",
        "role",
        "sort_order",
        "suspect_after_seconds",
        "lifecycle_status",
    ],
)
def test_edit_dto_rejects_explicit_null(field):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.UpdateAgentRequest,
            {field: None},
        )
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {field: "Field may not be null"},
    }


@pytest.mark.parametrize("field", ["sort_order", "suspect_after_seconds"])
@pytest.mark.parametrize("value", ["70", 70.0, True])
def test_edit_dto_integer_fields_reject_coercion(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.UpdateAgentRequest,
            {field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


def test_replace_dto_missing_required_field():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"display_name": "Replacement"},
        )
    assert raised.value.detail == {
        "code": "VALIDATION_ERROR",
        "message": "请求数据校验失败",
        "fields": {"coreai_agent_id": "Field required"},
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("coreai_agent_id", 7),
        ("display_name", ["Replacement"]),
        ("role", True),
        ("sort_order", "70"),
        ("suspect_after_seconds", 1800.0),
    ],
)
def test_replace_dto_wrong_types(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"coreai_agent_id": "agent-replacement", field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


def test_replace_dto_rejects_extra_fields():
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"coreai_agent_id": "agent-replacement", "unexpected": "value"},
        )
    assert raised.value.detail["fields"] == {
        "unexpected": "Extra inputs are not permitted"
    }


@pytest.mark.parametrize(
    "field",
    ["display_name", "role", "sort_order", "suspect_after_seconds"],
)
def test_replace_dto_rejects_explicit_null(field):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"coreai_agent_id": "agent-replacement", field: None},
        )
    assert raised.value.detail["fields"] == {field: "Field may not be null"}


@pytest.mark.parametrize("field", ["sort_order", "suspect_after_seconds"])
@pytest.mark.parametrize("value", ["70", 70.0, True])
def test_replace_dto_integer_fields_reject_coercion(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"coreai_agent_id": "agent-replacement", field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("display_name", " \n "),
        ("role", "角" * 241),
        ("sort_order", 10001),
        ("suspect_after_seconds", 59),
    ],
)
def test_replace_dto_applies_presentation_field_bounds(field, value):
    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.parse_workbench_mutation(
            agent_workbench.ReplaceAgentRequest,
            {"coreai_agent_id": "agent-replacement", field: value},
        )
    assert tuple(raised.value.detail["fields"]) == (field,)


def test_register_agent_happy_path(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "register.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW, raising=False)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    app = _build_app(conn, fake)

    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)

    assert response.status_code == 201
    assert response.json() == {
        "agent": {
            "id": LOCAL_ID,
            "agent_key": "citation-monitor",
            "coreai_agent_id": "agent-extra",
            "display_name": "Citation Monitor Agent",
            "role": "监控关键引用与目录变化",
            "sort_order": 70,
            "lifecycle_status": "active",
            "coreai_metadata": {
                "name": "Citation Monitor",
                "model": "gpt-example",
                "timeout_hint_seconds": 900,
                "last_verified_at": NOW.isoformat(),
                "verification_error": None,
            },
            "suspect_after_seconds": 1800,
            "sync_pending": True,
        },
        "sync_pending": True,
    }
    assert fake.get_agent_calls == ["agent-extra"]
    assert fake.list_agent_run_calls == []
    persisted = dict(conn.execute("SELECT * FROM seo_ops_agents").fetchone())
    assert persisted["coreai_name"] == "Citation Monitor"
    assert persisted["coreai_model"] == "gpt-example"
    assert persisted["last_verified_at"] == NOW.isoformat()
    conn.close()


def test_metadata_name_and_model_are_sanitized_before_storage_and_response(
    tmp_path, monkeypatch, caplog
):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-sanitize.db")
    api_key = "active-api-key-sentinel"
    auth_password = "overlap-secret"
    auth_secret = "overlap-secret-longer"
    labeled_values = (
        "external key with spaces",
        "abc def",
        "alpha beta",
        "alpha,beta",
        "quoted-api-key",
    )
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", api_key)
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", auth_password)
    monkeypatch.setenv("SEO_OPS_AUTH_SECRET", auth_secret)
    fake = FakeWorkbenchCoreAi(
        metadata={
            "id": "agent-extra",
            "type": "AGENT",
            "status": "PUBLISHED",
            "name": (
                f'{{"api_key": "external key with spaces"}} '
                f'{{"Authorization": "Basic abc def"}} {api_key} '
                f"{auth_secret} {auth_password}"
            ),
            "model": (
                "{'token': 'alpha beta', "
                '"secret": "alpha,beta", "API-key": "quoted-api-key"}'
            ),
            "timeout_seconds": 900,
        }
    )
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))

    direct = agent_workbench.verify_agent_metadata(
        fake,
        "agent-extra",
        NOW,
        sensitive_values=(api_key, auth_password, auth_secret),
    )
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)

    assert response.status_code == 201
    persisted = tuple(
        conn.execute("SELECT coreai_name,coreai_model FROM seo_ops_agents").fetchone()
    )
    boundaries = (repr(direct), repr(persisted), response.text, caplog.text)
    for sentinel in (api_key, auth_password, auth_secret, *labeled_values):
        assert all(sentinel not in boundary for boundary in boundaries)
    assert "[REDACTED]" in direct.name
    assert "[REDACTED]" in direct.model
    conn.close()


def test_metadata_id_mismatch_is_422(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-id.db")
    fake = FakeWorkbenchCoreAi(metadata={**FakeWorkbenchCoreAi().metadata, "id": "wrong"})
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "AGENT_ID_MISMATCH",
            "message": "Core AI Agent ID 不匹配",
            "fields": {},
        }
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    conn.close()


def test_metadata_wrong_type_is_422(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-type.db")
    fake = FakeWorkbenchCoreAi(metadata={**FakeWorkbenchCoreAi().metadata, "type": "SKILL"})
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "AGENT_TYPE_INVALID",
        "message": "该 Core AI 定义不是 Agent",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    conn.close()


def test_metadata_unpublished_is_422(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-status.db")
    fake = FakeWorkbenchCoreAi(metadata={**FakeWorkbenchCoreAi().metadata, "status": "DRAFT"})
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "AGENT_NOT_PUBLISHED",
        "message": "Core AI Agent 尚未发布",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    conn.close()


@pytest.mark.parametrize("name", [None, 7, " \n\t "])
def test_metadata_blank_name_is_422(tmp_path, monkeypatch, name):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-name.db")
    fake = FakeWorkbenchCoreAi(metadata={**FakeWorkbenchCoreAi().metadata, "name": name})
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 422
    assert response.json()["detail"] == {
        "code": "AGENT_NAME_INVALID",
        "message": "Core AI Agent 名称不可用",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    conn.close()


@pytest.mark.parametrize("timeout", [True, 0, -1, "900", 900.0])
def test_metadata_timeout_hint_accepts_only_positive_integer(timeout):
    fake = FakeWorkbenchCoreAi(
        metadata={**FakeWorkbenchCoreAi().metadata, "timeout_seconds": timeout}
    )

    metadata = agent_workbench.verify_agent_metadata(fake, "agent-extra", NOW)

    assert metadata.timeout_hint_seconds is None


def test_metadata_missing_credentials_is_fixed_503(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-missing-creds.db")
    monkeypatch.delenv("COREAI_BASE_URL", raising=False)
    monkeypatch.delenv("COREAI_API_KEY", raising=False)
    app = _build_app(conn)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "COREAI_NOT_CONFIGURED",
        "message": "Core AI 连接未配置",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    conn.close()


def test_coreai_dependency_closes_client_after_normal_yield(monkeypatch):
    created = []

    class OwnedClient:
        def __init__(self, base_url, api_key):
            self.arguments = (base_url, api_key)
            self.closed = False
            created.append(self)

        def close(self):
            self.closed = True

    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example/")
    monkeypatch.setenv("COREAI_API_KEY", "owned-key")
    monkeypatch.setattr(agent_workbench, "CoreAiClient", OwnedClient, raising=False)
    dependency = agent_workbench.get_agent_workbench_coreai()

    yielded = next(dependency)
    with pytest.raises(StopIteration):
        next(dependency)

    assert yielded is created[0]
    assert yielded.arguments == ("https://core.example", "owned-key")
    assert yielded.closed is True


def test_coreai_dependency_closes_client_when_consumer_raises(monkeypatch):
    created = []

    class OwnedClient:
        def __init__(self, base_url, api_key):
            self.closed = False
            created.append(self)

        def close(self):
            self.closed = True

    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", "owned-key")
    monkeypatch.setattr(agent_workbench, "CoreAiClient", OwnedClient)
    dependency = agent_workbench.get_agent_workbench_coreai()
    next(dependency)

    with pytest.raises(RuntimeError, match="consumer failed"):
        dependency.throw(RuntimeError("consumer failed"))

    assert created[0].closed is True


def test_metadata_transport_is_fixed_503(tmp_path, monkeypatch, caplog):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-transport.db")
    sentinel = "transport-private-body-sentinel"
    fake = FakeWorkbenchCoreAi(error=CoreAiError(0, sentinel))
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)

    with pytest.raises(agent_workbench.WorkbenchError) as raised:
        agent_workbench.verify_agent_metadata(fake, "agent-extra", NOW)

    app = _build_app(conn, fake)
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "COREAI_VERIFICATION_FAILED",
        "message": "Core AI 暂时不可用，稍后重试",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    for boundary in (repr(raised.value), response.text, caplog.text):
        assert sentinel not in boundary
    conn.close()


@pytest.mark.parametrize(
    "sentinel",
    ["private-http-text-body", '{"message":"private-http-json-body"}'],
)
def test_metadata_http_error_body_is_fixed_503(
    tmp_path, monkeypatch, caplog, sentinel
):
    conn = _workbench_conn(tmp_path, monkeypatch, "metadata-http.db")
    fake = FakeWorkbenchCoreAi(error=CoreAiError(500, sentinel))
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "COREAI_VERIFICATION_FAILED",
        "message": "Core AI 暂时不可用，稍后重试",
        "fields": {},
    }
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 0
    assert sentinel not in response.text
    assert sentinel not in caplog.text
    conn.close()


@pytest.mark.parametrize(
    ("raw", "expected_fields"),
    [
        (
            {key: value for key, value in REGISTER_BODY.items() if key != "agent_key"},
            {"agent_key": "Field required"},
        ),
        ({**REGISTER_BODY, "sort_order": "70"}, {"sort_order": "Input should be a valid integer"}),
        (
            {**REGISTER_BODY, "unexpected": "value"},
            {"unexpected": "Extra inputs are not permitted"},
        ),
    ],
)
def test_register_http_validation_envelopes(tmp_path, monkeypatch, raw, expected_fields):
    conn = _workbench_conn(tmp_path, monkeypatch, "register-http-validation.db")
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        response = client.post("/api/agent-workbench/agents", json=raw)
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "VALIDATION_ERROR",
            "message": "请求数据校验失败",
            "fields": expected_fields,
        }
    }
    conn.close()


@pytest.mark.parametrize(
    ("raw", "code", "message", "fields"),
    [
        (b"", "REQUEST_BODY_REQUIRED", "请求正文不能为空", {"body": "请求正文不能为空"}),
        (
            b'{"broken"',
            "INVALID_JSON",
            "请求正文不是有效的 JSON",
            {"body": "请求正文不是有效的 JSON"},
        ),
        (b"[]", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
        (b"null", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
        (b"7", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
    ],
)
def test_register_http_transport_envelopes(
    tmp_path, monkeypatch, raw, code, message, fields
):
    conn = _workbench_conn(tmp_path, monkeypatch, "register-http-transport.db")
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        response = client.post(
            "/api/agent-workbench/agents",
            content=raw,
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 422
    assert response.json() == {
        "detail": {"code": code, "message": message, "fields": fields}
    }
    conn.close()


def test_registration_conflicts_and_field_bounds(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "registration-conflicts.db")
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    fake = FakeWorkbenchCoreAi()
    app = _build_app(conn, fake)
    with TestClient(app, raise_server_exceptions=False) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        assert created.status_code == 201

        duplicate_id = client.post(
            "/api/agent-workbench/agents",
            json={**REGISTER_BODY, "agent_key": "other-role"},
        )
        fake.metadata["id"] = "agent-new"
        duplicate_key = client.post(
            "/api/agent-workbench/agents",
            json={**REGISTER_BODY, "coreai_agent_id": "agent-new"},
        )

    assert duplicate_id.status_code == 409
    assert duplicate_id.json()["detail"] == {
        "code": "COREAI_AGENT_ID_CONFLICT",
        "message": "该 Core AI Agent 已注册",
        "fields": {"coreai_agent_id": "已存在"},
    }
    assert duplicate_key.status_code == 409
    assert duplicate_key.json()["detail"] == {
        "code": "AGENT_KEY_CONFLICT",
        "message": "该 Agent 角色键已在使用",
        "fields": {"agent_key": "已存在"},
    }
    with TestClient(app, raise_server_exceptions=False) as client:
        key_responses = []
        for index, agent_key in enumerate(("   ", "x" * 81, " k ", f" {'z' * 80} ")):
            coreai_id = f"agent-key-{index}"
            fake.metadata["id"] = coreai_id
            key_responses.append(
                client.post(
                    "/api/agent-workbench/agents",
                    json={
                        **REGISTER_BODY,
                        "coreai_agent_id": coreai_id,
                        "agent_key": agent_key,
                    },
                )
            )
    for response in key_responses[:2]:
        assert response.status_code == 422
        assert response.json()["detail"]["fields"] == {
            "agent_key": "长度必须为 1 到 80 个字符"
        }
    assert [response.status_code for response in key_responses[2:]] == [201, 201]
    assert [
        response.json()["agent"]["agent_key"] for response in key_responses[2:]
    ] == ["k", "z" * 80]
    text_rows = (
        ("display_name", "   ", 422, None),
        ("display_name", "d" * 121, 422, None),
        ("display_name", " Display ", 201, "Display"),
        ("display_name", f" {'d' * 120} ", 201, "d" * 120),
        ("role", " \t ", 422, None),
        ("role", "r" * 241, 422, None),
        ("role", " Role ", 201, "Role"),
        ("role", f" {'r' * 240} ", 201, "r" * 240),
    )
    with TestClient(app, raise_server_exceptions=False) as client:
        for index, (field, value, status, normalized) in enumerate(text_rows):
            coreai_id = f"agent-text-{index}"
            fake.metadata["id"] = coreai_id
            response = client.post(
                "/api/agent-workbench/agents",
                json={
                    **REGISTER_BODY,
                    "coreai_agent_id": coreai_id,
                    "agent_key": f"text-role-{index}",
                    field: value,
                },
            )
            assert response.status_code == status
            if status == 422:
                limit = "1 到 120" if field == "display_name" else "1 到 240"
                assert response.json()["detail"]["fields"] == {
                    field: f"长度必须为 {limit} 个字符"
                }
            else:
                assert response.json()["agent"][field] == normalized
    with TestClient(app, raise_server_exceptions=False) as client:
        sort_responses = []
        for index, value in enumerate((-10001, 10001, -10000, 10000)):
            coreai_id = f"agent-sort-{index}"
            fake.metadata["id"] = coreai_id
            sort_responses.append(
                client.post(
                    "/api/agent-workbench/agents",
                    json={
                        **REGISTER_BODY,
                        "coreai_agent_id": coreai_id,
                        "agent_key": f"sort-role-{index}",
                        "sort_order": value,
                    },
                )
            )
    for response in sort_responses[:2]:
        assert response.status_code == 422
        assert response.json()["detail"]["fields"] == {
            "sort_order": "必须介于 -10000 和 10000 之间"
        }
    assert [response.status_code for response in sort_responses[2:]] == [201, 201]
    with TestClient(app, raise_server_exceptions=False) as client:
        suspect_responses = []
        for index, value in enumerate((59, 86401, 60, 86400)):
            coreai_id = f"agent-suspect-{index}"
            fake.metadata["id"] = coreai_id
            suspect_responses.append(
                client.post(
                    "/api/agent-workbench/agents",
                    json={
                        **REGISTER_BODY,
                        "coreai_agent_id": coreai_id,
                        "agent_key": f"suspect-role-{index}",
                        "suspect_after_seconds": value,
                    },
                )
            )
    for response in suspect_responses[:2]:
        assert response.status_code == 422
        assert response.json()["detail"]["fields"] == {
            "suspect_after_seconds": "必须介于 60 和 86400 之间"
        }
    assert [response.status_code for response in suspect_responses[2:]] == [201, 201]
    assert conn.execute("SELECT COUNT(*) FROM seo_ops_agents").fetchone()[0] == 11
    conn.close()


def test_update_presentation_and_disable(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "update-agent.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
        updated = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={
                "display_name": " Updated Name ",
                "role": " Updated Role ",
                "sort_order": -7,
                "suspect_after_seconds": 3600,
            },
        )
        immutable_core = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"coreai_agent_id": "cannot-change"},
        )
        immutable_key = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"agent_key": "cannot-change"},
        )

    assert updated.status_code == 200
    assert updated.json()["agent"] | {
        "display_name": "Updated Name",
        "role": "Updated Role",
        "sort_order": -7,
        "suspect_after_seconds": 3600,
    } == updated.json()["agent"]
    assert updated.json()["agent"]["coreai_agent_id"] == "agent-extra"
    assert updated.json()["agent"]["agent_key"] == "citation-monitor"
    for response, field in (
        (immutable_core, "coreai_agent_id"),
        (immutable_key, "agent_key"),
    ):
        assert response.status_code == 422
        assert tuple(response.json()["detail"]["fields"]) == (field,)
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
        "VALUES ('run-before-disable',?,'RUNNING',?)",
        (local_id, NOW.isoformat()),
    )
    conn.commit()
    with TestClient(app) as client:
        disabled = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "disabled"},
        )
    assert disabled.status_code == 200
    assert disabled.json()["agent"]["lifecycle_status"] == "disabled"
    assert conn.execute(
        "SELECT next_discovery_at FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()[0] == "2026-09-03T01:17:03+00:00"
    assert conn.execute(
        "SELECT COUNT(*) FROM seo_ops_agent_runs WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()[0] == 1
    assert fake.get_agent_calls == ["agent-extra"]
    conn.close()


def test_presentation_edit_and_disable_do_not_acquire_coreai_client(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "local-update-without-coreai.db")
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, [_slot()], NOW)
    monkeypatch.delenv("COREAI_BASE_URL", raising=False)
    monkeypatch.delenv("COREAI_API_KEY", raising=False)
    created_clients = []

    class UnexpectedClient:
        def __init__(self, *args, **kwargs):
            created_clients.append((args, kwargs))
            raise AssertionError("local-only PATCH created a Core AI client")

    monkeypatch.setattr(agent_workbench, "CoreAiClient", UnexpectedClient)
    app = _build_app(conn)
    with TestClient(app, raise_server_exceptions=False) as client:
        edited = client.patch(
            f"/api/agent-workbench/agents/{LOCAL_ID}",
            json={"display_name": "Local presentation"},
        )
        disabled = client.patch(
            f"/api/agent-workbench/agents/{LOCAL_ID}",
            json={"lifecycle_status": "disabled"},
        )

    assert edited.status_code == 200
    assert edited.json()["agent"]["display_name"] == "Local presentation"
    assert disabled.status_code == 200
    assert disabled.json()["agent"]["lifecycle_status"] == "disabled"
    assert created_clients == []
    conn.close()


def test_reenable_without_credentials_records_fixed_verification_failure(
    tmp_path, monkeypatch
):
    conn = _workbench_conn(tmp_path, monkeypatch, "reenable-without-coreai.db")
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: UUID(LOCAL_ID))
    agent_workbench.seed_configured_agents(conn, [_slot()], NOW)
    conn.execute(
        "UPDATE seo_ops_agents SET status='disabled' WHERE id=?",
        (LOCAL_ID,),
    )
    conn.commit()
    monkeypatch.delenv("COREAI_BASE_URL", raising=False)
    monkeypatch.delenv("COREAI_API_KEY", raising=False)
    app = _build_app(conn)

    with TestClient(app) as client:
        response = client.patch(
            f"/api/agent-workbench/agents/{LOCAL_ID}",
            json={"lifecycle_status": "active"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == {
        "code": "COREAI_NOT_CONFIGURED",
        "message": "Core AI 连接未配置",
        "fields": {},
    }
    verification = conn.execute(
        "SELECT status,last_verification_attempt_at,last_verification_error,"
        "verification_failure_count,next_verification_at "
        "FROM seo_ops_agents WHERE id=?",
        (LOCAL_ID,),
    ).fetchone()
    assert tuple(verification) == (
        "disabled",
        NOW.isoformat(),
        "COREAI_NOT_CONFIGURED: Core AI 连接未配置",
        1,
        "2026-09-03T01:03:03+00:00",
    )
    conn.close()


@pytest.mark.parametrize(
    ("raw", "expected_fields"),
    [
        ({}, {"body": "至少提供一个要更新的字段"}),
        ({"sort_order": "7"}, {"sort_order": "Input should be a valid integer"}),
        ({"unknown": "value"}, {"unknown": "Extra inputs are not permitted"}),
    ],
)
def test_edit_http_validation_envelopes(tmp_path, monkeypatch, raw, expected_fields):
    conn = _workbench_conn(tmp_path, monkeypatch, "edit-http-validation.db")
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
        response = client.patch(
            f"/api/agent-workbench/agents/{local_id}", json=raw
        )
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "VALIDATION_ERROR",
            "message": "请求数据校验失败",
            "fields": expected_fields,
        }
    }
    conn.close()


@pytest.mark.parametrize(
    ("raw", "code", "message", "fields"),
    [
        (b"", "REQUEST_BODY_REQUIRED", "请求正文不能为空", {"body": "请求正文不能为空"}),
        (
            b"{bad",
            "INVALID_JSON",
            "请求正文不是有效的 JSON",
            {"body": "请求正文不是有效的 JSON"},
        ),
        (b"[]", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
        (b"true", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
    ],
)
def test_edit_http_transport_envelopes(
    tmp_path, monkeypatch, raw, code, message, fields
):
    conn = _workbench_conn(tmp_path, monkeypatch, "edit-http-transport.db")
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
        response = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            content=raw,
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 422
    assert response.json() == {
        "detail": {"code": code, "message": message, "fields": fields}
    }
    conn.close()


def test_reenable_verifies_before_write(tmp_path, monkeypatch, caplog):
    conn = _workbench_conn(tmp_path, monkeypatch, "reenable.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
        disabled = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "disabled"},
        )
        assert disabled.status_code == 200

        conn.execute(
            "UPDATE seo_ops_agents SET coreai_name='Cached Name',"
            "coreai_model='cached-model',coreai_timeout_hint_seconds=321,"
            "last_verified_at='2026-09-02T01:02:03+00:00',"
            "verification_failure_count=2,"
            "metadata_lease_owner='metadata-owner',metadata_lease_epoch=7,"
            "metadata_lease_until='2026-09-03T01:10:00+00:00' WHERE id=?",
            (local_id,),
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET lease_owner='run-owner',"
            "lease_epoch=4,lease_until='2026-09-03T01:10:00+00:00',"
            "last_discovery_error='preserve-discovery-error' "
            "WHERE seo_ops_agent_id=?",
            (local_id,),
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_runs "
            "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
            "VALUES ('preserved-reenable-run',?,'RUNNING',?)",
            (local_id, NOW.isoformat()),
        )
        conn.commit()
        sync_before = tuple(
            conn.execute(
                "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
                (local_id,),
            ).fetchone()
        )
        run_before = tuple(
            conn.execute(
                "SELECT * FROM seo_ops_agent_runs "
                "WHERE coreai_run_id='preserved-reenable-run'"
            ).fetchone()
        )

        failure_now = NOW + timedelta(minutes=10)
        monkeypatch.setattr(agent_workbench, "utc_now", lambda: failure_now)
        sentinel = 'private-reenable-{"api_key": "secret"}'
        fake.error = CoreAiError(0, sentinel)
        failed = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "active"},
        )
        assert failed.status_code == 503
        assert failed.json()["detail"] == {
            "code": "COREAI_VERIFICATION_FAILED",
            "message": "Core AI 暂时不可用，稍后重试",
            "fields": {},
        }
        after_failure = dict(
            conn.execute(
                "SELECT * FROM seo_ops_agents WHERE id=?", (local_id,)
            ).fetchone()
        )
        assert after_failure | {
            "status": "disabled",
            "coreai_name": "Cached Name",
            "coreai_model": "cached-model",
            "coreai_timeout_hint_seconds": 321,
            "last_verified_at": "2026-09-02T01:02:03+00:00",
            "last_verification_attempt_at": failure_now.isoformat(),
            "last_verification_error": (
                "COREAI_VERIFICATION_FAILED: Core AI 暂时不可用，稍后重试"
            ),
            "verification_failure_count": 3,
            "next_verification_at": "2026-09-03T01:16:03+00:00",
            "metadata_lease_owner": "metadata-owner",
            "metadata_lease_epoch": 7,
            "metadata_lease_until": "2026-09-03T01:10:00+00:00",
        } == after_failure
        assert tuple(
            conn.execute(
                "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
                (local_id,),
            ).fetchone()
        ) == sync_before
        assert tuple(
            conn.execute(
                "SELECT * FROM seo_ops_agent_runs "
                "WHERE coreai_run_id='preserved-reenable-run'"
            ).fetchone()
        ) == run_before
        assert sentinel not in repr(after_failure)
        assert sentinel not in failed.text
        assert sentinel not in caplog.text

        fake.error = None
        monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
        reenabled = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "active"},
        )

    assert reenabled.status_code == 200
    assert reenabled.json()["agent"]["lifecycle_status"] == "active"
    sync = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?", (local_id,)
    ).fetchone())
    assert sync["local_event_epoch"] == 1
    assert sync["sync_pending"] == 1
    assert sync["next_discovery_at"] == NOW.isoformat()
    assert fake.get_agent_calls == ["agent-extra", "agent-extra", "agent-extra"]
    conn.close()


def test_reenable_atomically_invalidates_archival_proof(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "reenable-proof.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
        client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "disabled"},
        )
    observed_at = "2026-09-03T00:55:00+00:00"
    conn.execute(
        "UPDATE seo_ops_agent_sync_state SET "
        "pending_observed_count=2,pending_upstream_total=2,pending_last_observed_at=?,"
        "pending_set_quality='exact',running_observed_count=1,running_upstream_total=1,"
        "running_last_observed_at=?,running_set_quality='exact',"
        "paused_observed_count=3,paused_upstream_total=3,paused_last_observed_at=?,"
        "paused_set_quality='exact',current_state_complete=1,sync_pending=0,"
        "lease_owner='run-owner',lease_epoch=4,lease_until=? WHERE seo_ops_agent_id=?",
        (observed_at, observed_at, observed_at, "2026-09-03T01:10:00+00:00", local_id),
    )
    conn.execute(
        "UPDATE seo_ops_agents SET metadata_lease_owner='metadata-owner',"
        "metadata_lease_epoch=7,metadata_lease_until=? WHERE id=?",
        ("2026-09-03T01:10:00+00:00", local_id),
    )
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at,last_synced_at) "
        "VALUES ('cached-running',?,'RUNNING',?,?)",
        (local_id, observed_at, observed_at),
    )
    conn.commit()
    run_before = tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='cached-running'"
    ).fetchone())

    with TestClient(app) as client:
        response = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "active"},
        )

    assert response.status_code == 200
    sync = dict(conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?", (local_id,)
    ).fetchone())
    for prefix, count in (("pending", 2), ("running", 1), ("paused", 3)):
        assert sync[f"{prefix}_observed_count"] == count
        assert sync[f"{prefix}_upstream_total"] == count
        assert sync[f"{prefix}_last_observed_at"] == observed_at
        assert sync[f"{prefix}_set_quality"] == "unknown"
    assert sync["current_state_complete"] == 0
    assert sync["sync_pending"] == 1
    assert sync["local_event_epoch"] == 1
    assert sync["next_discovery_at"] == NOW.isoformat()
    assert (sync["lease_owner"], sync["lease_epoch"], sync["lease_until"]) == (
        "run-owner", 4, "2026-09-03T01:10:00+00:00"
    )
    agent = dict(conn.execute("SELECT * FROM seo_ops_agents WHERE id=?", (local_id,)).fetchone())
    assert (
        agent["metadata_lease_owner"],
        agent["metadata_lease_epoch"],
        agent["metadata_lease_until"],
    ) == ("metadata-owner", 7, "2026-09-03T01:10:00+00:00")
    assert tuple(conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id='cached-running'"
    ).fetchone()) == run_before
    conn.close()


def test_retire_is_bodyless_and_irreversible(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "retire.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        local_id = created.json()["agent"]["id"]
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
        "VALUES ('run-before-retire',?,'COMPLETED',?)",
        (local_id, NOW.isoformat()),
    )
    conn.commit()
    with TestClient(app) as client:
        retired = client.post(
            f"/api/agent-workbench/agents/{local_id}/retire",
            content=b"",
        )

    assert retired.status_code == 200
    assert retired.json()["agent"]["lifecycle_status"] == "retired"
    agent = conn.execute(
        "SELECT status,retired_at FROM seo_ops_agents WHERE id=?", (local_id,)
    ).fetchone()
    assert tuple(agent) == ("retired", NOW.isoformat())
    assert conn.execute(
        "SELECT next_discovery_at FROM seo_ops_agent_sync_state "
        "WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()[0] == "2026-09-04T01:02:03+00:00"
    assert conn.execute(
        "SELECT COUNT(*) FROM seo_ops_agent_runs WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()[0] == 1
    with TestClient(app) as client:
        for raw in (b" ", b"{}", b"null", b"other"):
            rejected = client.post(
                f"/api/agent-workbench/agents/{local_id}/retire",
                content=raw,
            )
            assert rejected.status_code == 422
            assert rejected.json() == {
                "detail": {
                    "code": "UNEXPECTED_REQUEST_BODY",
                    "message": "此操作不接受请求正文",
                    "fields": {"body": "此操作不接受请求正文"},
                }
            }
        repeated = client.post(
            f"/api/agent-workbench/agents/{local_id}/retire",
            content=b"",
        )
    assert repeated.status_code == 409
    assert repeated.json()["detail"] == {
        "code": "AGENT_RETIRED",
        "message": "Agent 已归档，不能重复归档",
        "fields": {},
    }
    conn.close()


def test_replace_is_atomic_and_preserves_old_history(tmp_path, monkeypatch):
    conn = _workbench_conn(tmp_path, monkeypatch, "replace.db")
    fake = FakeWorkbenchCoreAi()
    monkeypatch.setattr(agent_workbench, "utc_now", lambda: NOW)
    ids = iter((UUID(LOCAL_ID), UUID("22222222-2222-4222-8222-222222222222")))
    monkeypatch.setattr(agent_workbench.uuid, "uuid4", lambda: next(ids))
    app = _build_app(conn, fake)
    with TestClient(app) as client:
        created = client.post("/api/agent-workbench/agents", json=REGISTER_BODY)
        old_id = created.json()["agent"]["id"]
    conn.execute(
        "INSERT INTO seo_ops_agent_runs "
        "(coreai_run_id,seo_ops_agent_id,raw_status,first_seen_at) "
        "VALUES ('old-history',?,'COMPLETED',?)",
        (old_id, NOW.isoformat()),
    )
    conn.execute(
        "INSERT INTO seo_ops_agents "
        "(id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
        "suspect_after_seconds,created_at,updated_at) "
        "VALUES ('existing-local','existing-role','agent-present','Existing',"
        "'Already registered',80,'active',1800,?,?)",
        (NOW.isoformat(), NOW.isoformat()),
    )
    conn.execute(
        "INSERT INTO seo_ops_agent_sync_state (seo_ops_agent_id) "
        "VALUES ('existing-local')"
    )
    conn.commit()
    with TestClient(app, raise_server_exceptions=False) as client:
        same = client.post(
            f"/api/agent-workbench/agents/{old_id}/replace",
            json={"coreai_agent_id": "agent-extra"},
        )
        fake.metadata["id"] = "agent-present"
        existing = client.post(
            f"/api/agent-workbench/agents/{old_id}/replace",
            json={"coreai_agent_id": "agent-present"},
        )

    assert same.status_code == 409
    assert existing.status_code == 409
    assert conn.execute(
        "SELECT status FROM seo_ops_agents WHERE id=?", (old_id,)
    ).fetchone()[0] == "active"
    assert conn.execute(
        "SELECT COUNT(*) FROM seo_ops_agents WHERE status='retired'"
    ).fetchone()[0] == 0
    fake.metadata["id"] = "agent-unavailable"
    fake.error = CoreAiError(0, "private-replace-failure")
    with TestClient(app) as client:
        failed_verification = client.post(
            f"/api/agent-workbench/agents/{old_id}/replace",
            json={"coreai_agent_id": "agent-unavailable"},
        )
    assert failed_verification.status_code == 503
    assert conn.execute(
        "SELECT status FROM seo_ops_agents WHERE id=?", (old_id,)
    ).fetchone()[0] == "active"
    fake.error = None
    fake.metadata.update(
        {"id": "agent-replacement", "name": "Replacement Core Agent"}
    )

    with TestClient(app) as client:
        replaced = client.post(
            f"/api/agent-workbench/agents/{old_id}/replace",
            json={
                "coreai_agent_id": "agent-replacement",
                "display_name": "Replacement Display",
            },
        )

    assert replaced.status_code == 200
    assert replaced.json()["sync_pending"] is True
    new_agent = replaced.json()["agent"]
    assert new_agent == new_agent | {
        "id": "22222222-2222-4222-8222-222222222222",
        "agent_key": "citation-monitor",
        "coreai_agent_id": "agent-replacement",
        "display_name": "Replacement Display",
        "role": "监控关键引用与目录变化",
        "sort_order": 70,
        "suspect_after_seconds": 1800,
        "lifecycle_status": "active",
        "sync_pending": True,
    }
    old = conn.execute(
        "SELECT status,retired_at FROM seo_ops_agents WHERE id=?", (old_id,)
    ).fetchone()
    assert tuple(old) == ("retired", NOW.isoformat())
    assert conn.execute(
        "SELECT seo_ops_agent_id FROM seo_ops_agent_runs WHERE coreai_run_id='old-history'"
    ).fetchone()[0] == old_id
    assert conn.execute(
        "SELECT next_discovery_at FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (new_agent["id"],),
    ).fetchone()[0] == NOW.isoformat()
    conn.close()


@pytest.mark.parametrize(
    ("raw", "expected_fields"),
    [
        ({}, {"coreai_agent_id": "Field required"}),
        (
            {"coreai_agent_id": 7},
            {"coreai_agent_id": "Input should be a valid string"},
        ),
        (
            {"coreai_agent_id": "agent-replacement", "unexpected": "value"},
            {"unexpected": "Extra inputs are not permitted"},
        ),
    ],
)
def test_replace_http_validation_envelopes(
    tmp_path, monkeypatch, raw, expected_fields
):
    conn = _workbench_conn(tmp_path, monkeypatch, "replace-http-validation.db")
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        response = client.post(
            f"/api/agent-workbench/agents/{LOCAL_ID}/replace",
            json=raw,
        )
    assert response.status_code == 422
    assert response.json() == {
        "detail": {
            "code": "VALIDATION_ERROR",
            "message": "请求数据校验失败",
            "fields": expected_fields,
        }
    }
    conn.close()


@pytest.mark.parametrize(
    ("raw", "code", "message", "fields"),
    [
        (b"", "REQUEST_BODY_REQUIRED", "请求正文不能为空", {"body": "请求正文不能为空"}),
        (
            b"{bad",
            "INVALID_JSON",
            "请求正文不是有效的 JSON",
            {"body": "请求正文不是有效的 JSON"},
        ),
        (b"[]", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
        (b"false", "VALIDATION_ERROR", "请求数据校验失败", {"body": "必须是 JSON 对象"}),
    ],
)
def test_replace_http_transport_envelopes(
    tmp_path, monkeypatch, raw, code, message, fields
):
    conn = _workbench_conn(tmp_path, monkeypatch, "replace-http-transport.db")
    app = _build_app(conn, FakeWorkbenchCoreAi())
    with TestClient(app) as client:
        response = client.post(
            f"/api/agent-workbench/agents/{LOCAL_ID}/replace",
            content=raw,
            headers={"content-type": "application/json"},
        )
    assert response.status_code == 422
    assert response.json() == {
        "detail": {"code": code, "message": message, "fields": fields}
    }
    conn.close()

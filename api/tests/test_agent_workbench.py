import asyncio
import sqlite3
from dataclasses import asdict
from datetime import datetime, timezone
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
    auth_password = "local-auth-password-sentinel"
    auth_secret = "local-auth-secret-sentinel-000000000"
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example")
    monkeypatch.setenv("COREAI_API_KEY", api_key)
    monkeypatch.setenv("SEO_OPS_AUTH_PASSWORD", auth_password)
    monkeypatch.setenv("SEO_OPS_AUTH_SECRET", auth_secret)
    fake = FakeWorkbenchCoreAi(
        metadata={
            "id": "agent-extra",
            "type": "AGENT",
            "status": "PUBLISHED",
            "name": f"Citation {api_key} Monitor {auth_password}",
            "model": f"model-{auth_secret}-{api_key}",
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
    for sentinel in (api_key, auth_password, auth_secret):
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


def test_reenable_verifies_before_write(tmp_path, monkeypatch):
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

        fake.error = CoreAiError(0, "private-reenable-failure")
        failed = client.patch(
            f"/api/agent-workbench/agents/{local_id}",
            json={"lifecycle_status": "active"},
        )
        assert failed.status_code == 503
        assert conn.execute(
            "SELECT status FROM seo_ops_agents WHERE id=?", (local_id,)
        ).fetchone()[0] == "disabled"

        fake.error = None
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

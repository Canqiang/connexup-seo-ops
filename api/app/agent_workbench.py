import json
import os
import re
import unicodedata
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Sequence

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError

from .config import coreai_connection_settings
from .coreai import CoreAiClient, CoreAiContractError, CoreAiError
from .db import get_db


router = APIRouter(prefix="/api/agent-workbench", tags=["agent-workbench"])

TOKEN_USAGE_INPUT_FIELD = "input"
TOKEN_USAGE_OUTPUT_FIELD = "output"
DISCARDED_UPSTREAM_FIELDS = frozenset(
    {
        TOKEN_USAGE_INPUT_FIELD,
        TOKEN_USAGE_OUTPUT_FIELD,
        "transcript",
        "artifacts",
        "error_stack",
    }
)
KNOWN_NONTERMINAL = frozenset({"PENDING", "RUNNING", "PAUSED"})
KNOWN_TERMINAL = frozenset(
    {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
)


def _is_unknown_status(status: str | None) -> bool:
    return (
        status is not None
        and status not in KNOWN_NONTERMINAL | KNOWN_TERMINAL
    )


@dataclass(frozen=True)
class ParsedAgentRun:
    coreai_run_id: str
    coreai_agent_id: str
    raw_status: str
    trigger_type: str
    started_at: str | None
    completed_at: str | None
    completed_at_state: Literal["valid", "missing", "invalid"]
    input_tokens: int | None
    output_tokens: int | None
    trace_id: str | None
    error_summary: str | None
    warnings: Sequence[str]


@dataclass(frozen=True)
class ParsedAgentRunPage:
    runs: Sequence[ParsedAgentRun]
    total: int
    returned_count: int
    observed_at: str


LocalSourceKind = Literal["run", "task_execution", "merchant_seo_artifact"]


@dataclass(frozen=True)
class LocalRunBinding:
    source_kind: LocalSourceKind
    source_local_id: int


ProjectionDisposition = Literal[
    "inserted",
    "updated",
    "unchanged",
    "older_ignored",
    "conflict_ignored",
]


@dataclass(frozen=True)
class ProjectionResult:
    coreai_run_id: str
    disposition: ProjectionDisposition
    warning_codes: tuple[str, ...]


@dataclass(frozen=True)
class LocalAssociationResolution:
    binding: LocalRunBinding | None
    merchant_id: int | None
    local_href: str | None
    local_label: str | None
    warning_codes: tuple[str, ...]


class RegisterAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    coreai_agent_id: str
    agent_key: str
    display_name: str
    role: str
    sort_order: int
    suspect_after_seconds: int

    @field_validator("agent_key")
    @classmethod
    def validate_agent_key(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 80:
            raise PydanticCustomError(
                "agent_key_length",
                "长度必须为 1 到 80 个字符",
            )
        return trimmed

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 120:
            raise PydanticCustomError(
                "display_name_length",
                "长度必须为 1 到 120 个字符",
            )
        return trimmed

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 240:
            raise PydanticCustomError(
                "role_length",
                "长度必须为 1 到 240 个字符",
            )
        return trimmed

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        if not -10000 <= value <= 10000:
            raise PydanticCustomError(
                "sort_order_range",
                "必须介于 -10000 和 10000 之间",
            )
        return value

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        if not 60 <= value <= 86400:
            raise PydanticCustomError(
                "suspect_after_seconds_range",
                "必须介于 60 和 86400 之间",
            )
        return value


class UpdateAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    display_name: str = None
    role: str = None
    sort_order: int = None
    suspect_after_seconds: int = None
    lifecycle_status: Literal["active", "disabled"] = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        return RegisterAgentRequest.validate_display_name(value)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        return RegisterAgentRequest.validate_role(value)

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        return RegisterAgentRequest.validate_sort_order(value)

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        return RegisterAgentRequest.validate_suspect_after_seconds(value)

    @model_validator(mode="after")
    def require_update(self):
        if not self.model_fields_set:
            raise PydanticCustomError(
                "empty_patch",
                "至少提供一个要更新的字段",
            )
        return self


class ReplaceAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    coreai_agent_id: str
    display_name: str = None
    role: str = None
    sort_order: int = None
    suspect_after_seconds: int = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        return RegisterAgentRequest.validate_display_name(value)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        return RegisterAgentRequest.validate_role(value)

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        return RegisterAgentRequest.validate_sort_order(value)

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        return RegisterAgentRequest.validate_suspect_after_seconds(value)


class WorkbenchError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        fields: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message, "fields": fields or {}},
        )


def parse_workbench_mutation(model_type, raw: object) -> BaseModel:
    if isinstance(raw, dict):
        null_fields = {
            key: "Field may not be null"
            for key, value in raw.items()
            if value is None and key in model_type.model_fields
        }
        if null_fields:
            raise WorkbenchError(
                422,
                "VALIDATION_ERROR",
                "请求数据校验失败",
                null_fields,
            )
    try:
        return model_type.model_validate(raw)
    except ValidationError as exc:
        fields = {}
        for error in exc.errors(include_url=False, include_input=False):
            location = error.get("loc", ())
            field = ".".join(str(part) for part in location) or "body"
            fields[field] = sanitize_operator_text(error.get("msg"))
        raise WorkbenchError(
            422,
            "VALIDATION_ERROR",
            "请求数据校验失败",
            fields,
        ) from None


def get_agent_workbench_coreai():
    settings = coreai_connection_settings()
    if settings is None:
        raise WorkbenchError(
            503,
            "COREAI_NOT_CONFIGURED",
            "Core AI 连接未配置",
        )
    client = CoreAiClient(settings.base_url, settings.api_key)
    try:
        yield client
    finally:
        client.close()


def get_agent_workbench_coreai_factory():
    return get_agent_workbench_coreai


@router.post("/agents", status_code=201)
async def register_agent(
    request: Request,
    conn=Depends(get_db),
    client=Depends(get_agent_workbench_coreai),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(RegisterAgentRequest, raw)
    metadata = verify_agent_metadata(
        client,
        body.coreai_agent_id,
        utc_now(),
        sensitive_values=_request_sensitive_values(),
    )
    return _register_agent(conn, body, metadata, utc_now())


@router.patch("/agents/{local_agent_id}")
async def update_agent(
    local_agent_id: str,
    request: Request,
    conn=Depends(get_db),
    client_factory=Depends(get_agent_workbench_coreai_factory),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(UpdateAgentRequest, raw)
    metadata = None
    if body.lifecycle_status == "active":
        row = conn.execute(
            "SELECT coreai_agent_id,status FROM seo_ops_agents WHERE id=?",
            (local_agent_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "disabled":
            client_dependency = client_factory()
            attempt_at = utc_now()
            sensitive_values = _request_sensitive_values()
            try:
                try:
                    client = next(client_dependency)
                    metadata = verify_agent_metadata(
                        client,
                        row["coreai_agent_id"],
                        attempt_at,
                        sensitive_values=sensitive_values,
                    )
                except WorkbenchError as exc:
                    _record_reenable_verification_failure(
                        conn,
                        local_agent_id,
                        row["coreai_agent_id"],
                        attempt_at,
                        exc,
                        sensitive_values,
                    )
                    raise
            finally:
                client_dependency.close()
    return _update_agent(conn, local_agent_id, body, utc_now(), metadata)


@router.post("/agents/{local_agent_id}/retire")
async def retire_agent(local_agent_id: str, request: Request, conn=Depends(get_db)):
    await require_empty_workbench_body(request)
    return _retire_agent(conn, local_agent_id, utc_now())


@router.post("/agents/{local_agent_id}/replace")
async def replace_agent(
    local_agent_id: str,
    request: Request,
    conn=Depends(get_db),
    client=Depends(get_agent_workbench_coreai),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(ReplaceAgentRequest, raw)
    metadata = verify_agent_metadata(
        client,
        body.coreai_agent_id,
        utc_now(),
        sensitive_values=_request_sensitive_values(),
    )
    return _replace_agent(conn, local_agent_id, body, metadata, utc_now())


def sanitize_operator_text(
    value: object,
    sensitive_values: tuple[str, ...] = (),
) -> str:
    if isinstance(value, str):
        text = value
    elif isinstance(value, dict) and isinstance(value.get("message"), str):
        text = value["message"]
    else:
        return "上游消息不可用"
    for sensitive in sorted(
        {sensitive for sensitive in sensitive_values if sensitive},
        key=len,
        reverse=True,
    ):
        text = text.replace(sensitive, "[REDACTED]")
    text = re.sub(
        r"(?i)(?P<prefix>[?&;])"
        r"(?P<key>api[_-]?key|apikey|access[_-]?token|token|key|secret|authorization)"
        r"(?P<equals>=)[^&#;\s]*",
        lambda match: (
            f"{match.group('prefix')}{match.group('key')}"
            f"{match.group('equals')}[REDACTED]"
        ),
        text,
    )
    credential_label = (
        r"(?:authorization|api[-_ ]?key|access[-_ ]?token|token|secret)"
    )
    quoted_or_plain_label = (
        rf'(?:"{credential_label}"|\'{credential_label}\'|{credential_label})'
    )
    text = re.sub(
        rf'(?i)(?P<prefix>{quoted_or_plain_label}\s*[:=]\s*")'
        r'(?:(?:Basic|Bearer)\s+)?(?:\\.|[^"\\])*"',
        lambda match: f"{match.group('prefix')}[REDACTED]\"",
        text,
    )
    text = re.sub(
        rf"(?i)(?P<prefix>{quoted_or_plain_label}\s*[:=]\s*')"
        r"(?:(?:Basic|Bearer)\s+)?(?:\\.|[^'\\])*'",
        lambda match: f"{match.group('prefix')}[REDACTED]'",
        text,
    )
    text = re.sub(
        r"(?i)\bBearer\s+[^\s,;}&]+",
        "Bearer [REDACTED]",
        text,
    )
    text = re.sub(
        rf"(?i)(?P<prefix>{credential_label}\s*[:=]\s*)"
        r"(?:(?:Basic|Bearer)\s+)?[^\s,;}&\#]+",
        r"\g<prefix>[REDACTED]",
        text,
    )
    text = "".join(
        " " if unicodedata.category(char).startswith("C") else char
        for char in text
    )
    return " ".join(text.split())[:240].rstrip()


def parse_agent_run_page(
    expected_agent_id: str,
    page: dict,
    observed_at: datetime,
    *,
    expected_status: str | None = None,
    sensitive_values: Sequence[str] = (),
) -> ParsedAgentRunPage:
    parsed_runs = []
    seen_runs = {}
    for upstream_row in page["runs"]:
        row = {
            key: value
            for key, value in upstream_row.items()
            if key not in DISCARDED_UPSTREAM_FIELDS
        }
        for field_name in ("id", "status", "triggered_by"):
            value = row.get(field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"invalid {field_name}")
        if row.get("agent_id") != expected_agent_id:
            raise ValueError("invalid agent_id")
        if expected_status is not None and row["status"] != expected_status:
            raise ValueError("invalid expected_status")
        warnings = []
        started_value = row.get("started_at")
        completed_value = row.get("completed_at")
        started_at, started_invalid = _parse_upstream_timestamp(started_value)
        completed_at, completed_invalid = _parse_upstream_timestamp(completed_value)
        if started_invalid:
            warnings.append("INVALID_STARTED_AT")
        if completed_invalid:
            warnings.append("INVALID_COMPLETED_AT")
        token_usage = row.get("token_usage")
        input_tokens = None
        output_tokens = None
        if isinstance(token_usage, dict):
            has_input = TOKEN_USAGE_INPUT_FIELD in token_usage
            has_output = TOKEN_USAGE_OUTPUT_FIELD in token_usage
            if has_input != has_output:
                warnings.append("TOKEN_USAGE_INVALID")
            input_value = token_usage.get(TOKEN_USAGE_INPUT_FIELD)
            output_value = token_usage.get(TOKEN_USAGE_OUTPUT_FIELD)
            if isinstance(input_value, bool) or isinstance(output_value, bool):
                if "TOKEN_USAGE_INVALID" not in warnings:
                    warnings.append("TOKEN_USAGE_INVALID")
            elif (
                isinstance(input_value, int)
                and isinstance(output_value, int)
                and (input_value < 0 or output_value < 0)
            ):
                if "TOKEN_USAGE_INVALID" not in warnings:
                    warnings.append("TOKEN_USAGE_INVALID")
            elif (
                isinstance(input_value, int)
                and input_value >= 0
                and isinstance(output_value, int)
                and output_value >= 0
            ):
                input_tokens = input_value
                output_tokens = output_value
            elif "TOKEN_USAGE_INVALID" not in warnings:
                warnings.append("TOKEN_USAGE_INVALID")
        raw_error = row.get("error")
        error_summary = None
        if isinstance(raw_error, str) or (
            isinstance(raw_error, dict)
            and isinstance(raw_error.get("message"), str)
        ):
            error_summary = sanitize_operator_text(
                raw_error,
                sensitive_values=tuple(sensitive_values),
            )
        elif "error" in row and raw_error is not None:
            error_summary = "上游消息不可用"
        parsed_run = ParsedAgentRun(
            coreai_run_id=row["id"],
            coreai_agent_id=row["agent_id"],
            raw_status=row["status"],
            trigger_type=row["triggered_by"],
            started_at=started_at,
            completed_at=completed_at,
            completed_at_state=(
                "invalid"
                if completed_invalid
                else "missing" if completed_value is None else "valid"
            ),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            trace_id=(
                row.get("trace_id")
                if isinstance(row.get("trace_id"), str)
                else None
            ),
            error_summary=error_summary,
            warnings=tuple(warnings),
        )
        previous = seen_runs.get(parsed_run.coreai_run_id)
        if previous == parsed_run:
            continue
        if previous is not None:
            raise ValueError("conflicting duplicate run id")
        seen_runs[parsed_run.coreai_run_id] = parsed_run
        parsed_runs.append(parsed_run)
    total = page.get("total")
    if (
        not isinstance(total, int)
        or isinstance(total, bool)
        or total < len(parsed_runs)
    ):
        raise ValueError("invalid total")
    return ParsedAgentRunPage(
        runs=tuple(parsed_runs),
        total=total,
        returned_count=len(parsed_runs),
        observed_at=_utc_iso(observed_at),
    )


def _parse_upstream_timestamp(value: object) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None, True
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None, True
    return _utc_iso(parsed), False


def receipt_expiry(
    *,
    previous_raw_status: str | None,
    previous_last_synced_at: datetime | None,
    incoming: ParsedAgentRun,
    terminal_observed_at: datetime,
) -> datetime | None:
    if incoming.raw_status not in KNOWN_TERMINAL:
        return None
    if incoming.completed_at_state == "valid":
        completed = datetime.fromisoformat(incoming.completed_at)
        delta = (terminal_observed_at - completed).total_seconds()
        return (
            terminal_observed_at + timedelta(seconds=10)
            if 0 <= delta <= 10
            else None
        )
    if incoming.completed_at_state == "invalid":
        return None
    recently_seen = (
        previous_last_synced_at is not None
        and 0
        <= (terminal_observed_at - previous_last_synced_at).total_seconds()
        <= 15
    )
    return (
        terminal_observed_at + timedelta(seconds=10)
        if previous_raw_status in KNOWN_NONTERMINAL and recently_seen
        else None
    )


def _binding_merchant_id(conn, binding: LocalRunBinding | None) -> int | None:
    if binding is None:
        return None
    queries = {
        "run": "SELECT merchant_id FROM runs WHERE id=?",
        "task_execution": (
            "SELECT t.merchant_id FROM task_executions e "
            "JOIN tasks t ON t.id=e.task_id WHERE e.id=?"
        ),
        "merchant_seo_artifact": (
            "SELECT merchant_id FROM merchant_seo_artifacts WHERE id=?"
        ),
    }
    query = queries.get(binding.source_kind)
    if query is None:
        raise ValueError("invalid source_kind")
    row = conn.execute(query, (binding.source_local_id,)).fetchone()
    if row is None:
        raise ValueError("invalid source_local_id")
    return row[0]


def resolve_local_association(conn, coreai_run_id: str) -> LocalAssociationResolution:
    conn.execute("BEGIN IMMEDIATE")
    try:
        projected = conn.execute(
            "SELECT source_kind,source_local_id,merchant_id "
            "FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (coreai_run_id,),
        ).fetchone()
        if projected is None:
            raise ValueError("projected run not found")
        matches = conn.execute(
            "SELECT 'run' AS source_kind,id AS source_local_id,merchant_id,"
            "'/runs/' || id AS local_href,'Run #' || id AS local_label "
            "FROM runs WHERE coreai_run_id=? "
            "UNION ALL "
            "SELECT 'task_execution',e.id,t.merchant_id,"
            "'/tasks/' || t.id,t.title "
            "FROM task_executions e JOIN tasks t ON t.id=e.task_id "
            "WHERE e.coreai_run_id=? "
            "UNION ALL "
            "SELECT 'merchant_seo_artifact',id,merchant_id,"
            "'/merchants/' || merchant_id || '/profile',"
            "artifact_type || ' #' || id "
            "FROM merchant_seo_artifacts WHERE coreai_run_id=?",
            (coreai_run_id, coreai_run_id, coreai_run_id),
        ).fetchall()
        existing_binding = (
            LocalRunBinding(projected[0], projected[1])
            if projected[0] is not None and projected[1] is not None
            else None
        )
        if existing_binding is not None:
            bound_match = next(
                (
                    match
                    for match in matches
                    if match[0] == existing_binding.source_kind
                    and match[1] == existing_binding.source_local_id
                ),
                None,
            )
            warnings = (
                ("LOCAL_ASSOCIATION_CONFLICT",)
                if len(matches) > 1 or (matches and bound_match is None)
                else ()
            )
            result = LocalAssociationResolution(
                existing_binding,
                projected[2],
                (
                    bound_match[3]
                    if bound_match is not None and projected[2] is not None
                    else None
                ),
                (
                    bound_match[4]
                    if bound_match is not None and projected[2] is not None
                    else None
                ),
                warnings,
            )
        elif not matches:
            result = LocalAssociationResolution(None, None, None, None, ())
        elif len(matches) == 1:
            match = matches[0]
            binding = LocalRunBinding(match[0], match[1])
            conn.execute(
                "UPDATE seo_ops_agent_runs SET source_kind=?,source_local_id=?,"
                "merchant_id=? WHERE coreai_run_id=? AND source_kind IS NULL "
                "AND source_local_id IS NULL",
                (binding.source_kind, binding.source_local_id, match[2], coreai_run_id),
            )
            result = LocalAssociationResolution(
                binding, match[2], match[3], match[4], ()
            )
        else:
            result = LocalAssociationResolution(
                None, None, None, None, ("LOCAL_ASSOCIATION_CONFLICT",)
            )
        conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise


def association_preflight_warnings(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT coreai_run_id,source_kind FROM ("
        "SELECT coreai_run_id,'run' AS source_kind FROM runs "
        "WHERE coreai_run_id IS NOT NULL "
        "UNION ALL "
        "SELECT coreai_run_id,'task_execution' FROM task_executions "
        "WHERE coreai_run_id IS NOT NULL "
        "UNION ALL "
        "SELECT coreai_run_id,'merchant_seo_artifact' "
        "FROM merchant_seo_artifacts WHERE coreai_run_id IS NOT NULL"
        ") ORDER BY coreai_run_id,source_kind"
    ).fetchall()
    bindings: dict[str, list[str]] = {}
    for coreai_run_id, source_kind in rows:
        bindings.setdefault(coreai_run_id, []).append(source_kind)
    return [
        {
            "code": "LOCAL_ASSOCIATION_CONFLICT",
            "message": "Core AI Run ID 对应多个本地记录",
            "fields": {
                "coreai_run_id": coreai_run_id,
                "source_kinds": ",".join(sorted(set(source_kinds))),
            },
        }
        for coreai_run_id, source_kinds in bindings.items()
        if len(source_kinds) > 1
    ]


def upsert_projected_run(
    conn,
    local_agent_id,
    run: ParsedAgentRun,
    observed_at,
    binding: LocalRunBinding | None = None,
) -> ProjectionResult:
    stamp = _utc_iso(observed_at)
    warning_codes = tuple(sorted(set(run.warnings)))
    conn.execute("BEGIN IMMEDIATE")
    try:
        owner = conn.execute(
            "SELECT coreai_agent_id FROM seo_ops_agents WHERE id=?",
            (local_agent_id,),
        ).fetchone()
        if owner is None or owner[0] != run.coreai_agent_id:
            raise ValueError("invalid projected run owner")
        existing = conn.execute(
            "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run.coreai_run_id,),
        ).fetchone()
        if existing is not None and existing["seo_ops_agent_id"] != local_agent_id:
            raise ValueError("projected run already has another owner")
        if existing is not None:
            existing_warning_set = set(
                json.loads(existing["data_warning_codes_json"])
            )
            if "TERMINAL_STATUS_CONFLICT" in existing_warning_set:
                warning_codes = tuple(
                    sorted(set(warning_codes) | {"TERMINAL_STATUS_CONFLICT"})
                )
        if existing is not None and existing["last_synced_at"] is not None:
            previous_sync = datetime.fromisoformat(existing["last_synced_at"])
            current_sync = datetime.fromisoformat(stamp)
        else:
            previous_sync = None
            current_sync = None
        if (
            previous_sync is not None
            and current_sync is not None
            and current_sync <= previous_sync
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id,
                "unchanged" if current_sync == previous_sync else "older_ignored",
                existing_warnings,
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status in KNOWN_NONTERMINAL
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL WHERE coreai_run_id=?",
                (stamp, stamp, run.coreai_run_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "conflict_ignored", existing_warnings
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status == existing["raw_status"]
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL WHERE coreai_run_id=?",
                (stamp, stamp, run.coreai_run_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "updated", existing_warnings
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status not in KNOWN_NONTERMINAL
        ):
            conflict_warnings = tuple(
                sorted(
                    set(json.loads(existing["data_warning_codes_json"]))
                    | {"TERMINAL_STATUS_CONFLICT"}
                )
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL,data_warning_codes_json=? "
                "WHERE coreai_run_id=?",
                (
                    stamp,
                    stamp,
                    json.dumps(conflict_warnings, separators=(",", ":")),
                    run.coreai_run_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "conflict_ignored", conflict_warnings
            )
        if existing is not None and (
            existing["raw_status"] is None
            or existing["raw_status"] == run.raw_status
            or existing["raw_status"] in KNOWN_NONTERMINAL
            or _is_unknown_status(existing["raw_status"])
        ):
            terminal_observed_at = existing["terminal_observed_at"]
            receipt_expires_at = existing["receipt_expires_at"]
            if (
                run.raw_status in KNOWN_TERMINAL
                and existing["raw_status"] not in KNOWN_TERMINAL
                and terminal_observed_at is None
            ):
                terminal_observation = datetime.fromisoformat(stamp)
                expiry = receipt_expiry(
                    previous_raw_status=existing["raw_status"],
                    previous_last_synced_at=previous_sync,
                    incoming=run,
                    terminal_observed_at=terminal_observation,
                )
                terminal_observed_at = stamp
                receipt_expires_at = _utc_iso(expiry) if expiry is not None else None
            conn.execute(
                "UPDATE seo_ops_agent_runs SET raw_status=?,trigger_type=?,started_at=?,"
                "completed_at=?,terminal_observed_at=?,receipt_expires_at=?,"
                "input_tokens=?,output_tokens=?,trace_id=?,"
                "error_summary=?,last_poll_attempt_at=?,last_synced_at=?,"
                "last_poll_error=NULL,data_warning_codes_json=? "
                "WHERE coreai_run_id=?",
                (
                    run.raw_status,
                    run.trigger_type,
                    run.started_at,
                    run.completed_at,
                    terminal_observed_at,
                    receipt_expires_at,
                    run.input_tokens,
                    run.output_tokens,
                    run.trace_id,
                    run.error_summary,
                    stamp,
                    stamp,
                    json.dumps(warning_codes, separators=(",", ":")),
                    run.coreai_run_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1,"
                "unresolved_unknown_status_count="
                "unresolved_unknown_status_count+? "
                "WHERE seo_ops_agent_id=?",
                (
                    int(_is_unknown_status(run.raw_status))
                    - int(_is_unknown_status(existing["raw_status"])),
                    local_agent_id,
                ),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "updated", warning_codes
            )
        merchant_id = _binding_merchant_id(conn, binding)
        terminal_observed = (
            datetime.fromisoformat(stamp)
            if run.raw_status in KNOWN_TERMINAL
            else None
        )
        expires = (
            receipt_expiry(
                previous_raw_status=None,
                previous_last_synced_at=None,
                incoming=run,
                terminal_observed_at=terminal_observed,
            )
            if terminal_observed is not None
            else None
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_runs ("
            "coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,started_at,"
            "completed_at,terminal_observed_at,receipt_expires_at,"
            "input_tokens,output_tokens,trace_id,error_summary,"
            "source_kind,source_local_id,merchant_id,first_seen_at,"
            "last_poll_attempt_at,last_synced_at,last_poll_error,"
            "data_warning_codes_json"
            ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
            (
                run.coreai_run_id,
                local_agent_id,
                run.raw_status,
                run.trigger_type,
                run.started_at,
                run.completed_at,
                _utc_iso(terminal_observed) if terminal_observed is not None else None,
                _utc_iso(expires) if expires is not None else None,
                run.input_tokens,
                run.output_tokens,
                run.trace_id,
                run.error_summary,
                binding.source_kind if binding is not None else None,
                binding.source_local_id if binding is not None else None,
                merchant_id,
                stamp,
                stamp,
                stamp,
                json.dumps(warning_codes, separators=(",", ":")),
            ),
        )
        inserted = conn.execute(
            "SELECT coreai_run_id FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run.coreai_run_id,),
        ).fetchone()
        if inserted is None:
            raise RuntimeError("projected run insert readback failed")
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET "
            "projection_revision=projection_revision+1,"
            "unresolved_unknown_status_count="
            "unresolved_unknown_status_count+? "
            "WHERE seo_ops_agent_id=?",
            (int(_is_unknown_status(run.raw_status)), local_agent_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return ProjectionResult(run.coreai_run_id, "inserted", warning_codes)


def _utc_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class VerifiedAgentMetadata:
    coreai_agent_id: str
    name: str
    model: str | None
    timeout_hint_seconds: int | None
    verified_at: str


def verify_agent_metadata(
    client,
    coreai_agent_id: str,
    now: datetime,
    sensitive_values=(),
) -> VerifiedAgentMetadata:
    try:
        raw = client.get_agent(coreai_agent_id)
    except CoreAiContractError as exc:
        if exc.code == "AGENT_ID_MISMATCH":
            raise WorkbenchError(
                422,
                "AGENT_ID_MISMATCH",
                "Core AI Agent ID 不匹配",
            ) from None
        raise WorkbenchError(
            422,
            "AGENT_METADATA_INVALID",
            "Core AI Agent 元数据不可用",
        ) from None
    except CoreAiError:
        raise WorkbenchError(
            503,
            "COREAI_VERIFICATION_FAILED",
            "Core AI 暂时不可用，稍后重试",
        ) from None
    if raw.get("id") != coreai_agent_id:
        raise WorkbenchError(
            422,
            "AGENT_ID_MISMATCH",
            "Core AI Agent ID 不匹配",
        )
    if raw.get("type") != "AGENT":
        raise WorkbenchError(
            422,
            "AGENT_TYPE_INVALID",
            "该 Core AI 定义不是 Agent",
        )
    if raw.get("status") != "PUBLISHED":
        raise WorkbenchError(
            422,
            "AGENT_NOT_PUBLISHED",
            "Core AI Agent 尚未发布",
        )
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise WorkbenchError(
            422,
            "AGENT_NAME_INVALID",
            "Core AI Agent 名称不可用",
        )
    model = raw.get("model")
    timeout = raw.get("timeout_seconds")
    timeout_hint = (
        timeout
        if isinstance(timeout, int)
        and not isinstance(timeout, bool)
        and timeout > 0
        else None
    )
    safe_name = sanitize_operator_text(name, sensitive_values=sensitive_values)
    if not safe_name:
        raise WorkbenchError(
            422,
            "AGENT_NAME_INVALID",
            "Core AI Agent 名称不可用",
        )
    return VerifiedAgentMetadata(
        coreai_agent_id=coreai_agent_id,
        name=safe_name,
        model=(
            sanitize_operator_text(model, sensitive_values=sensitive_values)
            if isinstance(model, str) and model.strip()
            else None
        ),
        timeout_hint_seconds=timeout_hint,
        verified_at=_utc_iso(now),
    )


def _request_sensitive_values() -> tuple[str, ...]:
    settings = coreai_connection_settings()
    candidates = (
        settings.api_key if settings is not None else "",
        os.environ.get("SEO_OPS_AUTH_PASSWORD", ""),
        os.environ.get("SEO_OPS_AUTH_SECRET", ""),
    )
    return tuple(value for value in candidates if value)


def _register_agent(conn, body, metadata: VerifiedAgentMetadata, now: datetime):
    local_id = str(uuid.uuid4())
    stamp = _utc_iso(now)
    next_verification = _utc_iso(now + timedelta(hours=24))
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id=?",
            (body.coreai_agent_id,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "该 Core AI Agent 已注册",
                {"coreai_agent_id": "已存在"},
            )
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE agent_key=? AND status<>'retired'",
            (body.agent_key,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "AGENT_KEY_CONFLICT",
                "该 Agent 角色键已在使用",
                {"agent_key": "已存在"},
            )
        conn.execute(
            "INSERT INTO seo_ops_agents ("
            "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
            "coreai_name,coreai_model,coreai_timeout_hint_seconds,"
            "suspect_after_seconds,last_verification_attempt_at,last_verified_at,"
            "last_verification_error,verification_failure_count,next_verification_at,"
            "created_at,updated_at"
            ") VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,NULL,0,?,?,?)",
            (
                local_id,
                body.agent_key,
                body.coreai_agent_id,
                body.display_name,
                body.role,
                body.sort_order,
                metadata.name,
                metadata.model,
                metadata.timeout_hint_seconds,
                body.suspect_after_seconds,
                stamp,
                metadata.verified_at,
                next_verification,
                stamp,
                stamp,
            ),
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_sync_state "
            "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
            (local_id, stamp),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _update_agent(
    conn,
    local_id: str,
    body: UpdateAgentRequest,
    now: datetime,
    metadata: VerifiedAgentMetadata | None = None,
):
    fields = body.model_fields_set - {"lifecycle_status"}
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT status FROM seo_ops_agents WHERE id=?",
            (local_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "retired":
            raise WorkbenchError(409, "AGENT_RETIRED", "已归档 Agent 不可修改")
        if fields:
            assignments = ",".join(f"{field}=?" for field in sorted(fields))
            values = [getattr(body, field) for field in sorted(fields)]
            conn.execute(
                f"UPDATE seo_ops_agents SET {assignments},updated_at=? WHERE id=?",
                (*values, _utc_iso(now), local_id),
            )
        if (
            "lifecycle_status" in body.model_fields_set
            and body.lifecycle_status == "disabled"
            and row["status"] == "active"
        ):
            stamp = _utc_iso(now)
            conn.execute(
                "UPDATE seo_ops_agents SET status='disabled',updated_at=? WHERE id=?",
                (stamp, local_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
                "WHERE seo_ops_agent_id=?",
                (_utc_iso(now + timedelta(minutes=15)), local_id),
            )
        if (
            "lifecycle_status" in body.model_fields_set
            and body.lifecycle_status == "active"
            and row["status"] == "disabled"
            and metadata is not None
        ):
            stamp = _utc_iso(now)
            conn.execute(
                "UPDATE seo_ops_agents SET status='active',coreai_name=?,"
                "coreai_model=?,coreai_timeout_hint_seconds=?,"
                "last_verification_attempt_at=?,last_verified_at=?,"
                "last_verification_error=NULL,verification_failure_count=0,"
                "next_verification_at=?,updated_at=? WHERE id=?",
                (
                    metadata.name,
                    metadata.model,
                    metadata.timeout_hint_seconds,
                    stamp,
                    metadata.verified_at,
                    _utc_iso(now + timedelta(hours=24)),
                    stamp,
                    local_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "local_event_epoch=local_event_epoch+1,sync_pending=1,"
                "pending_set_quality='unknown',running_set_quality='unknown',"
                "paused_set_quality='unknown',current_state_complete=0,"
                "next_discovery_at=? WHERE seo_ops_agent_id=?",
                (stamp, local_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _record_reenable_verification_failure(
    conn,
    local_id: str,
    coreai_agent_id: str,
    now: datetime,
    error: WorkbenchError,
    sensitive_values: tuple[str, ...],
) -> None:
    detail = error.detail if isinstance(error.detail, dict) else {}
    code = detail.get("code")
    message = detail.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        code = "COREAI_VERIFICATION_FAILED"
        message = "Core AI 暂时不可用，稍后重试"
    error_summary = sanitize_operator_text(
        f"{code}: {message}",
        sensitive_values=sensitive_values,
    )
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT verification_failure_count FROM seo_ops_agents "
            "WHERE id=? AND coreai_agent_id=? AND status='disabled'",
            (local_id, coreai_agent_id),
        ).fetchone()
        if row is not None:
            failure_count = row["verification_failure_count"] + 1
            retry_seconds = min(60 * (2 ** min(failure_count - 1, 6)), 3600)
            conn.execute(
                "UPDATE seo_ops_agents SET last_verification_attempt_at=?,"
                "last_verification_error=?,verification_failure_count=?,"
                "next_verification_at=? "
                "WHERE id=? AND coreai_agent_id=? AND status='disabled'",
                (
                    stamp,
                    error_summary,
                    failure_count,
                    _utc_iso(now + timedelta(seconds=retry_seconds)),
                    local_id,
                    coreai_agent_id,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _retire_agent(conn, local_id: str, now: datetime):
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT status FROM seo_ops_agents WHERE id=?",
            (local_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "retired":
            raise WorkbenchError(
                409,
                "AGENT_RETIRED",
                "Agent 已归档，不能重复归档",
            )
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=?,updated_at=? "
            "WHERE id=?",
            (stamp, stamp, local_id),
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
            "WHERE seo_ops_agent_id=?",
            (_utc_iso(now + timedelta(hours=24)), local_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _replace_agent(
    conn,
    old_local_id: str,
    body: ReplaceAgentRequest,
    metadata: VerifiedAgentMetadata,
    now: datetime,
):
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        old = conn.execute(
            "SELECT * FROM seo_ops_agents WHERE id=?",
            (old_local_id,),
        ).fetchone()
        if old is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if old["status"] == "retired":
            raise WorkbenchError(409, "AGENT_RETIRED", "已归档 Agent 不可替换")
        if body.coreai_agent_id == old["coreai_agent_id"]:
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "替换 Agent 必须使用新的 Core AI Agent ID",
                {"coreai_agent_id": "必须与当前 ID 不同"},
            )
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id=?",
            (body.coreai_agent_id,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "该 Core AI Agent 已注册",
                {"coreai_agent_id": "已存在"},
            )

        new_local_id = str(uuid.uuid4())
        inherited = {
            field: (
                getattr(body, field)
                if field in body.model_fields_set
                else old[field]
            )
            for field in (
                "display_name",
                "role",
                "sort_order",
                "suspect_after_seconds",
            )
        }
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=?,updated_at=? "
            "WHERE id=?",
            (stamp, stamp, old_local_id),
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
            "WHERE seo_ops_agent_id=?",
            (_utc_iso(now + timedelta(hours=24)), old_local_id),
        )
        conn.execute(
            "INSERT INTO seo_ops_agents ("
            "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
            "coreai_name,coreai_model,coreai_timeout_hint_seconds,"
            "suspect_after_seconds,last_verification_attempt_at,last_verified_at,"
            "last_verification_error,verification_failure_count,next_verification_at,"
            "created_at,updated_at"
            ") VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,NULL,0,?,?,?)",
            (
                new_local_id,
                old["agent_key"],
                body.coreai_agent_id,
                inherited["display_name"],
                inherited["role"],
                inherited["sort_order"],
                metadata.name,
                metadata.model,
                metadata.timeout_hint_seconds,
                inherited["suspect_after_seconds"],
                stamp,
                metadata.verified_at,
                _utc_iso(now + timedelta(hours=24)),
                stamp,
                stamp,
            ),
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_sync_state "
            "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
            (new_local_id, stamp),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, new_local_id)


def _mutation_response(conn, local_id: str) -> dict:
    row = conn.execute(
        "SELECT a.*, s.sync_pending FROM seo_ops_agents a "
        "JOIN seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id "
        "WHERE a.id=?",
        (local_id,),
    ).fetchone()
    if row is None:
        raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
    sync_pending = bool(row["sync_pending"])
    return {
        "agent": {
            "id": row["id"],
            "agent_key": row["agent_key"],
            "coreai_agent_id": row["coreai_agent_id"],
            "display_name": row["display_name"],
            "role": row["role"],
            "sort_order": row["sort_order"],
            "lifecycle_status": row["status"],
            "coreai_metadata": {
                "name": row["coreai_name"],
                "model": row["coreai_model"],
                "timeout_hint_seconds": row["coreai_timeout_hint_seconds"],
                "last_verified_at": row["last_verified_at"],
                "verification_error": row["last_verification_error"],
            },
            "suspect_after_seconds": row["suspect_after_seconds"],
            "sync_pending": sync_pending,
        },
        "sync_pending": sync_pending,
    }


@dataclass(frozen=True)
class WorkbenchWarning:
    code: str
    message: str
    fields: dict[str, str]


def _configuration_plan(conn, slots):
    selected_by_id: dict[str, object] = {}
    accepted = []
    warnings: list[WorkbenchWarning] = []
    for slot in slots:
        selected = selected_by_id.get(slot.coreai_agent_id)
        if selected is not None:
            warnings.append(
                WorkbenchWarning(
                    code="CONFIG_DUPLICATE_AGENT_ID",
                    message="多个配置槽使用同一个 Core AI Agent ID",
                    fields={
                        "coreai_agent_id": slot.coreai_agent_id,
                        "selected_env": selected.env_name,
                        "ignored_env": slot.env_name,
                    },
                )
            )
            continue
        selected_by_id[slot.coreai_agent_id] = slot
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id = ?",
            (slot.coreai_agent_id,),
        ).fetchone():
            accepted.append(slot)
            continue
        current = conn.execute(
            "SELECT coreai_agent_id FROM seo_ops_agents "
            "WHERE agent_key = ? AND status <> 'retired'",
            (slot.agent_key,),
        ).fetchone()
        if current is not None:
            warnings.append(
                WorkbenchWarning(
                    code="CONFIG_ROLE_CONFLICT",
                    message="配置角色已绑定另一个 Core AI Agent ID",
                    fields={
                        "agent_key": slot.agent_key,
                        "configured_coreai_agent_id": slot.coreai_agent_id,
                        "registered_coreai_agent_id": current[0],
                        "env_name": slot.env_name,
                    },
                )
            )
            continue
        accepted.append(slot)
    return accepted, warnings


def bootstrap_configuration_warnings(conn, slots) -> list[WorkbenchWarning]:
    return _configuration_plan(conn, slots)[1]


async def read_workbench_json(request) -> object:
    raw = await request.body()
    if raw == b"":
        raise WorkbenchError(
            422,
            "REQUEST_BODY_REQUIRED",
            "请求正文不能为空",
            {"body": "请求正文不能为空"},
        )
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, ValueError):
        raise WorkbenchError(
            422,
            "INVALID_JSON",
            "请求正文不是有效的 JSON",
            {"body": "请求正文不是有效的 JSON"},
        ) from None
    if not isinstance(parsed, dict):
        raise WorkbenchError(
            422,
            "VALIDATION_ERROR",
            "请求数据校验失败",
            {"body": "必须是 JSON 对象"},
        )
    return parsed


async def require_empty_workbench_body(request) -> None:
    raw = await request.body()
    if raw == b"":
        return None
    raise WorkbenchError(
        422,
        "UNEXPECTED_REQUEST_BODY",
        "此操作不接受请求正文",
        {"body": "此操作不接受请求正文"},
    )


def seed_configured_agents(conn, slots, now: datetime) -> list[dict]:
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        accepted, warnings = _configuration_plan(conn, slots)
        for slot in accepted:
            if conn.execute(
                "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id = ?",
                (slot.coreai_agent_id,),
            ).fetchone():
                continue
            local_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO seo_ops_agents ("
                "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
                "suspect_after_seconds,created_at,updated_at"
                ") VALUES (?,?,?,?,?,?,'active',1800,?,?)",
                (
                    local_id,
                    slot.agent_key,
                    slot.coreai_agent_id,
                    slot.display_name,
                    slot.role,
                    slot.sort_order,
                    stamp,
                    stamp,
                ),
            )
            conn.execute(
                "INSERT INTO seo_ops_agent_sync_state "
                "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
                (local_id, stamp),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return [asdict(warning) for warning in warnings]

import json
import re
import unicodedata

import httpx

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
LLM_CALL_TIMEOUT_SECONDS = 660.0
MAX_COREAI_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_COREAI_JSON_FIELD_BYTES = 1024 * 1024
MAX_COREAI_JSON_LIST_ITEMS = 1000
MAX_COREAI_JSON_OBJECT_FIELDS = 1000
MAX_COREAI_IDENTIFIER_CHARS = 255
MAX_COREAI_STATUS_CHARS = 64
MAX_COREAI_TIMESTAMP_CHARS = 128
MAX_PERSISTED_COREAI_ERROR_CHARS = 500

_CREDENTIAL_RE = re.compile(
    r"(?i)\b(authorization|api[ _-]?key)\b\s*[:=]\s*(?:bearer\s+)?[^\s,;]+"
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")


def sanitize_coreai_error(value: object, fallback: str = "core-ai request failed") -> str:
    """Return a bounded, log-safe message suitable for durable local storage."""

    text = value if isinstance(value, str) else fallback
    text = "".join(
        " " if unicodedata.category(char).startswith("C") else char for char in text
    )
    text = _CREDENTIAL_RE.sub(lambda match: f"{match.group(1)}=<redacted>", text)
    text = _BEARER_RE.sub("Bearer <redacted>", text)
    text = " ".join(text.split())
    if not text:
        text = fallback
    return text[:MAX_PERSISTED_COREAI_ERROR_CHARS].rstrip()


class CoreAiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(sanitize_coreai_error(message))
        self.status_code = status_code


def _validate_json_limits(value: object) -> None:
    pending: list[tuple[object, str]] = [(value, "$")]
    while pending:
        current, path = pending.pop()
        if isinstance(current, dict):
            if len(current) > MAX_COREAI_JSON_OBJECT_FIELDS:
                raise CoreAiError(0, f"core-ai JSON object {path} has too many fields")
            for key, child in current.items():
                if not isinstance(key, str) or len(key) > MAX_COREAI_IDENTIFIER_CHARS:
                    raise CoreAiError(0, f"core-ai JSON object {path} has an invalid field name")
                pending.append((child, f"{path}.{key}"))
        elif isinstance(current, list):
            if len(current) > MAX_COREAI_JSON_LIST_ITEMS:
                raise CoreAiError(0, f"core-ai JSON list {path} exceeds item limit")
            pending.extend((child, f"{path}[]") for child in current)
        elif isinstance(current, str):
            if len(current.encode("utf-8")) > MAX_COREAI_JSON_FIELD_BYTES:
                raise CoreAiError(0, f"core-ai JSON field {path} is too large")


def _valid_identifier(value: object) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and value == value.strip()
        and len(value) <= MAX_COREAI_IDENTIFIER_CHARS
        and all(not char.isspace() and not unicodedata.category(char).startswith("C") for char in value)
    )


def validate_run_detail(body: object, run_id: str) -> dict:
    if not isinstance(body, dict):
        raise CoreAiError(0, "core-ai returned non-object JSON")
    _validate_json_limits(body)
    if body.get("id") != run_id:
        raise CoreAiError(0, "core-ai run detail id mismatch")
    if not _valid_identifier(body["id"]):
        raise CoreAiError(0, "core-ai run detail has invalid id")
    status = body.get("status")
    if not isinstance(status, str) or not status.strip():
        raise CoreAiError(0, "core-ai run detail missing status")
    if len(status) > MAX_COREAI_STATUS_CHARS or any(
        unicodedata.category(char).startswith("C") for char in status
    ):
        raise CoreAiError(0, "core-ai run detail has invalid status")
    completed_at = body.get("completed_at")
    if isinstance(completed_at, str) and len(completed_at) > MAX_COREAI_TIMESTAMP_CHARS:
        raise CoreAiError(0, "core-ai run detail completed_at is too long")
    normalized = dict(body)
    if "error" in normalized and normalized["error"] is not None:
        normalized["error"] = sanitize_coreai_error(
            normalized["error"], f"core-ai status {status}"
        )
    return normalized


class CoreAiClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
    ):
        # token 只进 Authorization 头，不进 URL/日志/错误消息
        self._client = httpx.Client(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            transport=transport,
        )

    def _request(
        self,
        method: str,
        path: str,
        json_body: dict | None = None,
        *,
        timeout: float | None = None,
    ) -> dict:
        try:
            stream_kwargs = {"json": json_body}
            if timeout is not None:
                stream_kwargs["timeout"] = timeout
            with self._client.stream(method, path, **stream_kwargs) as res:
                declared_length = res.headers.get("Content-Length")
                if declared_length is not None:
                    try:
                        parsed_length = int(declared_length)
                    except ValueError:
                        parsed_length = 0
                    if parsed_length > MAX_COREAI_RESPONSE_BYTES:
                        raise CoreAiError(
                            res.status_code if res.status_code >= 400 else 0,
                            "core-ai response is too large",
                        )
                collected = bytearray()
                for chunk in res.iter_bytes():
                    if len(collected) + len(chunk) > MAX_COREAI_RESPONSE_BYTES:
                        raise CoreAiError(
                            res.status_code if res.status_code >= 400 else 0,
                            "core-ai response is too large",
                        )
                    collected.extend(chunk)
                raw_body = bytes(collected)
                status_code = res.status_code
        except CoreAiError:
            raise
        except httpx.HTTPError as e:
            raise CoreAiError(0, f"core-ai request failed: {e}") from e
        if status_code >= 400:
            try:
                error_body = json.loads(raw_body)
            except (UnicodeDecodeError, ValueError):
                message = raw_body.decode("utf-8", errors="replace")
            else:
                message = (
                    error_body.get("message")
                    if isinstance(error_body, dict)
                    else None
                ) or raw_body.decode("utf-8", errors="replace")
            raise CoreAiError(status_code, message)
        try:
            body = json.loads(raw_body)
        except (UnicodeDecodeError, ValueError) as e:
            raise CoreAiError(0, "core-ai returned non-JSON response") from e
        if not isinstance(body, dict):
            raise CoreAiError(0, "core-ai returned non-object JSON")
        _validate_json_limits(body)
        return body

    def trigger(self, agent_id: str, input_text: str) -> dict:
        body = self._request("POST", f"/api/runs/agent/{agent_id}/trigger", {"input": input_text})
        if not _valid_identifier(body.get("run_id")):
            raise CoreAiError(0, "core-ai trigger response missing run_id")
        return body

    def llm_call(self, llm_call_id: str, input_text: str) -> str:
        body = self._request(
            "POST",
            f"/api/llm/{llm_call_id}/call",
            {"input": input_text},
            timeout=LLM_CALL_TIMEOUT_SECONDS,
        )
        output = body.get("output")
        if not isinstance(output, str):
            raise CoreAiError(0, "core-ai LLM call response missing text output")
        return output

    def get_agent(self, agent_id: str) -> dict:
        body = self._request("GET", f"/api/agents/{agent_id}")
        if body.get("id") != agent_id:
            raise CoreAiError(0, "core-ai agent detail id mismatch")
        return body

    def get_run(self, run_id: str) -> dict:
        body = self._request("GET", f"/api/runs/{run_id}")
        return validate_run_detail(body, run_id)

    def call_mcp_tool(self, server_id: str, tool_name: str, arguments: dict) -> dict:
        body = self._request(
            "POST",
            f"/api/tools/mcp-servers/{server_id}/test-tool",
            {"tool_name": tool_name, "arguments": json.dumps(arguments)},
        )
        result = body.get("result")
        if body.get("success") is not True:
            message = result if isinstance(result, str) and result else "core-ai MCP tool call failed"
            raise CoreAiError(0, message[:500])
        if isinstance(result, str):
            try:
                result = json.loads(result)
            except json.JSONDecodeError as exc:
                raise CoreAiError(0, "core-ai MCP tool returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise CoreAiError(0, "core-ai MCP tool returned non-object JSON")
        _validate_json_limits(result)
        return result

    def close(self) -> None:
        self._client.close()

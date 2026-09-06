import json
import re
import unicodedata
from urllib.parse import quote, unquote_plus, urlsplit

import httpx

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
NONTERMINAL_STATUSES = {"PENDING", "RUNNING"}
RUN_STATUSES = TERMINAL_STATUSES | NONTERMINAL_STATUSES
RUN_LIST_FIELDS = (
    "id",
    "agent_id",
    "triggered_by",
    "status",
    "token_usage",
    "trace_id",
    "started_at",
    "completed_at",
    "error",
)
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
    r"""(?ix)
    (?<![\w-])
    ["']?
    (?P<key>
        authorization
        | x[ _-]?api[ _-]?key
        | api[ _-]?key
        | access[ _-]?token
        | refresh[ _-]?token
        | client[ _-]?secret
        | password
    )
    (?![\w-])
    ["']?
    \s*[:=]\s*
    (?:
        "(?:\\.|[^"\\])*"
        | '(?:\\.|[^'\\])*'
        | (?:bearer\s+)?[^\s,;}&]+
    )
    """
)
_AUTHORIZATION_SCHEME_RE = re.compile(
    r"""(?ix)
    (?<![\w-])
    ["']?authorization(?![\w-])["']?
    \s*[:=]\s*
    (?:basic|bearer)\s+[^\s,;}&]+
    """
)
_BEARER_RE = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_URL_USERINFO_RE = re.compile(r"(?i)\b(?P<scheme>https?://)[^\s/@:]+:[^\s/@]+@")
_URL_RE = re.compile(r"(?i)\bhttps?://[^\s<>\"']+")
_SENSITIVE_URL_QUERY_KEYS = frozenset(
    {
        "access_token",
        "api_key",
        "apikey",
        "auth_token",
        "client_secret",
        "code",
        "credential",
        "id_token",
        "key",
        "refresh_token",
        "secret",
        "session_token",
        "sig",
        "signature",
        "token",
        "x_amz_credential",
        "x_amz_security_token",
        "x_amz_signature",
        "x_api_key",
    }
)


def _split_url_trailing_punctuation(value: str) -> tuple[str, str]:
    url = value
    suffix = ""
    while url and url[-1] in ".,;:!?。；，！":
        suffix = url[-1] + suffix
        url = url[:-1]
    for opening, closing in (("(", ")"), ("[", "]"), ("{", "}")):
        while url.endswith(closing) and url.count(closing) > url.count(opening):
            suffix = closing + suffix
            url = url[:-1]
    return url, suffix


def _normalized_url_query_key(value: str) -> str:
    decoded = unquote_plus(value).strip().casefold()
    return re.sub(r"[.\- ]+", "_", decoded)


def _redact_url_query(query: str) -> str:
    parts = re.split(r"([&;])", query)
    for index in range(0, len(parts), 2):
        key, separator, _value = parts[index].partition("=")
        if separator and _normalized_url_query_key(key) in _SENSITIVE_URL_QUERY_KEYS:
            parts[index] = f"{key}=<redacted>"
    return "".join(parts)


def _redact_sensitive_url_query_values(value: str) -> str:
    def redact(match: re.Match[str]) -> str:
        raw_url, trailing = _split_url_trailing_punctuation(match.group(0))
        try:
            urlsplit(raw_url)
        except ValueError:
            # Invalid authority syntax (for example a broken IPv6 literal) must
            # not turn an upstream error into a credential disclosure.
            pass
        query_start = raw_url.find("?")
        if query_start < 0:
            return raw_url + trailing
        fragment_start = raw_url.find("#", query_start + 1)
        query_end = fragment_start if fragment_start >= 0 else len(raw_url)
        query = raw_url[query_start + 1 : query_end]
        redacted_query = _redact_url_query(query)
        return (
            raw_url[: query_start + 1] + redacted_query + raw_url[query_end:] + trailing
        )

    return _URL_RE.sub(redact, value)


def sanitize_coreai_error(
    value: object, fallback: str = "core-ai request failed"
) -> str:
    """Return a bounded, log-safe message suitable for durable local storage."""

    text = value if isinstance(value, str) else fallback
    text = "".join(
        " " if unicodedata.category(char).startswith("C") else char for char in text
    )
    text = _redact_sensitive_url_query_values(text)
    text = _URL_USERINFO_RE.sub(
        lambda match: f"{match.group('scheme')}<redacted>@", text
    )
    text = _AUTHORIZATION_SCHEME_RE.sub("Authorization=<redacted>", text)
    text = _CREDENTIAL_RE.sub(lambda match: f"{match.group('key')}=<redacted>", text)
    text = _BEARER_RE.sub("Bearer <redacted>", text)
    text = " ".join(text.split())
    if not text:
        text = fallback
    return text[:MAX_PERSISTED_COREAI_ERROR_CHARS].rstrip()


class CoreAiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(sanitize_coreai_error(message))
        self.status_code = status_code


class CoreAiContractError(CoreAiError):
    def __init__(self, code: str, message: str):
        super().__init__(0, message)
        self.code = code


def _validate_json_limits(value: object) -> None:
    pending: list[tuple[object, str]] = [(value, "$")]
    while pending:
        current, path = pending.pop()
        if isinstance(current, dict):
            if len(current) > MAX_COREAI_JSON_OBJECT_FIELDS:
                raise CoreAiError(0, f"core-ai JSON object {path} has too many fields")
            for key, child in current.items():
                if not isinstance(key, str) or len(key) > MAX_COREAI_IDENTIFIER_CHARS:
                    raise CoreAiError(
                        0, f"core-ai JSON object {path} has an invalid field name"
                    )
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
        and all(
            not char.isspace() and not unicodedata.category(char).startswith("C")
            for char in value
        )
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
    if status not in RUN_STATUSES:
        raise CoreAiError(0, "core-ai run detail has unsupported status")
    completed_at = body.get("completed_at")
    if isinstance(completed_at, str) and len(completed_at) > MAX_COREAI_TIMESTAMP_CHARS:
        raise CoreAiError(0, "core-ai run detail completed_at is too long")
    normalized = dict(body)
    if status in TERMINAL_STATUSES:
        for field in ("output", "error"):
            value = normalized.get(field)
            if value is not None and not isinstance(value, str):
                normalized["status"] = "FAILED"
                normalized.pop("output", None)
                normalized["error"] = f"core-ai terminal response has invalid {field}"
                return normalized
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
        params: dict | None = None,
        *,
        timeout: float | None = None,
    ) -> dict:
        try:
            stream_kwargs = {"json": json_body, "params": params}
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
                    error_body.get("message") if isinstance(error_body, dict) else None
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
        body = self._request(
            "POST",
            f"/api/runs/agent/{quote(agent_id, safe='')}/trigger",
            {"input": input_text},
        )
        run_id = body.get("run_id")
        if not isinstance(run_id, str) or not run_id.strip():
            raise CoreAiContractError(
                "TRIGGER_RUN_ID_INVALID",
                "core-ai trigger response has invalid run_id",
            )
        normalized_run_id = run_id.strip()
        if not _valid_identifier(normalized_run_id):
            raise CoreAiError(0, "core-ai trigger response missing run_id")
        raw_status = body.get("status")
        status = (
            raw_status.strip()
            if isinstance(raw_status, str) and raw_status.strip()
            else None
        )
        return {**body, "run_id": normalized_run_id, "status": status}

    def list_agent_runs(
        self, agent_id: str, status: str | None, limit: int
    ) -> dict:
        params: dict[str, str | int] = {"limit": limit}
        if status is not None:
            params["status"] = status
        body = self._request(
            "GET",
            f"/api/runs/agent/{quote(agent_id, safe='')}/list",
            params=params,
        )
        runs = body.get("runs")
        if not isinstance(runs, list):
            raise CoreAiError(0, "core-ai Agent run list is malformed")
        if not all(isinstance(row, dict) for row in runs):
            raise CoreAiError(0, "core-ai Agent run list is malformed")
        total = body.get("total")
        if isinstance(total, bool) or not isinstance(total, int) or total < 0:
            raise CoreAiError(0, "core-ai Agent run total is malformed")
        if len(runs) > total:
            raise CoreAiError(0, "core-ai Agent run total is malformed")
        return {
            "runs": [
                {key: row.get(key) for key in RUN_LIST_FIELDS} for row in runs
            ],
            "total": total,
        }

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
        body = self._request("GET", f"/api/agents/{quote(agent_id, safe='')}")
        if body.get("id") != agent_id:
            raise CoreAiContractError(
                "AGENT_ID_MISMATCH",
                "core-ai agent detail id mismatch",
            )
        return body

    def get_run(self, run_id: str) -> dict:
        body = self._request("GET", f"/api/runs/{run_id}")
        return validate_run_detail(body, run_id)

    def get_skill(self, skill_id: str) -> dict:
        body = self._request("GET", f"/api/skills/{skill_id}")
        if body.get("id") != skill_id or not isinstance(
            body.get("qualified_name"), str
        ):
            raise CoreAiError(
                0, "core-ai skill detail does not match the requested skill"
            )
        if not body["qualified_name"].strip():
            raise CoreAiError(0, "core-ai skill detail is missing qualified_name")
        return body

    def get_trace(self, trace_id: str) -> dict:
        body = self._request("GET", f"/api/traces/{trace_id}")
        if body.get("traceId") != trace_id or not body.get("status"):
            raise CoreAiError(
                0, "core-ai trace detail does not match the requested trace"
            )
        return body

    def list_trace_spans(self, trace_id: str) -> list[dict]:
        body = self._request("GET", f"/api/traces/{trace_id}/spans")
        spans = body.get("spans")
        if not isinstance(spans, list) or not all(
            isinstance(span, dict) for span in spans
        ):
            raise CoreAiError(0, "core-ai trace span list is malformed")
        return spans

    def get_trace_span(self, trace_id: str, span_id: str) -> dict:
        body = self._request("GET", f"/api/traces/{trace_id}/spans/{span_id}")
        if body.get("spanId") != span_id:
            raise CoreAiError(
                0, "core-ai trace span detail does not match the requested span"
            )
        return body

    def call_mcp_tool(self, server_id: str, tool_name: str, arguments: dict) -> dict:
        body = self._request(
            "POST",
            f"/api/tools/mcp-servers/{server_id}/test-tool",
            {"tool_name": tool_name, "arguments": json.dumps(arguments)},
        )
        result = body.get("result")
        if body.get("success") is not True:
            message = (
                result
                if isinstance(result, str) and result
                else "core-ai MCP tool call failed"
            )
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

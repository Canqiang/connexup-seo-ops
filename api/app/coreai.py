import json

import httpx

TERMINAL_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
LLM_CALL_TIMEOUT_SECONDS = 660.0


class CoreAiError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


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
            if timeout is None:
                res = self._client.request(method, path, json=json_body)
            else:
                res = self._client.request(
                    method, path, json=json_body, timeout=timeout
                )
        except httpx.HTTPError as e:
            raise CoreAiError(0, f"core-ai request failed: {e}") from e
        if res.status_code >= 400:
            try:
                error_body = res.json()
            except ValueError:
                message = res.text[:200]
            else:
                message = (error_body.get("message") if isinstance(error_body, dict) else None) or res.text[:200]
            raise CoreAiError(res.status_code, message)
        try:
            body = res.json()
        except ValueError as e:
            raise CoreAiError(0, "core-ai returned non-JSON response") from e
        if not isinstance(body, dict):
            raise CoreAiError(0, "core-ai returned non-object JSON")
        return body

    def trigger(self, agent_id: str, input_text: str) -> dict:
        body = self._request("POST", f"/api/runs/agent/{agent_id}/trigger", {"input": input_text})
        if not body.get("run_id"):
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
        if not body.get("status"):
            raise CoreAiError(0, "core-ai run detail missing status")
        return body

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
        return result

    def close(self) -> None:
        self._client.close()

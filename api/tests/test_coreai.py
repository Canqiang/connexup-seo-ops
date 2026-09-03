import httpx
import pytest


def make_client(handler):
    from app.coreai import CoreAiClient

    return CoreAiClient("https://core.test", "coreai_k", transport=httpx.MockTransport(handler))


def test_trigger_posts_input_and_returns_run_id():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json={"run_id": "r-1", "status": "RUNNING"})

    res = make_client(handler).trigger("agent-9", "hello")
    assert res["run_id"] == "r-1"
    assert seen["url"] == "https://core.test/api/runs/agent/agent-9/trigger"
    assert seen["auth"] == "Bearer coreai_k"
    assert seen["body"] == {"input": "hello"}


def test_trigger_missing_run_id_raises():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(202, json={"status": "RUNNING"})

    with pytest.raises(CoreAiError):
        make_client(handler).trigger("a", "x")


def test_llm_call_posts_only_input_with_bounded_long_timeout_and_returns_output():
    seen = {}

    def handler(request):
        import json

        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["timeout"] = request.extensions["timeout"]
        return httpx.Response(200, json={"output": '{"outcome":"ready"}'})

    output = make_client(handler).llm_call("prepare-v1", "prepare this")

    assert output == '{"outcome":"ready"}'
    assert seen == {
        "method": "POST",
        "url": "https://core.test/api/llm/prepare-v1/call",
        "body": {"input": "prepare this"},
        "timeout": {
            "connect": 660.0,
            "read": 660.0,
            "write": 660.0,
            "pool": 660.0,
        },
    }


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"output": None},
        {"output": ["not", "text"]},
    ],
)
def test_llm_call_rejects_missing_or_non_text_output(response):
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(200, json=response)

    with pytest.raises(CoreAiError, match="output"):
        make_client(handler).llm_call("prepare-v1", "prepare this")


def test_get_agent_reads_back_the_exact_published_capabilities():
    def handler(request):
        assert request.method == "GET"
        assert request.url.path == "/api/agents/agent-9"
        return httpx.Response(200, json={"id": "agent-9", "status": "PUBLISHED", "tools": []})

    agent = make_client(handler).get_agent("agent-9")

    assert agent == {"id": "agent-9", "status": "PUBLISHED", "tools": []}


def test_get_run_returns_detail():
    def handler(request):
        assert str(request.url) == "https://core.test/api/runs/r-2"
        return httpx.Response(200, json={"id": "r-2", "status": "COMPLETED", "output": "report"})

    detail = make_client(handler).get_run("r-2")
    assert detail["status"] == "COMPLETED"
    assert detail["output"] == "report"


def test_http_error_surfaces_status_and_message():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(401, json={"message": "invalid api key"})

    with pytest.raises(CoreAiError) as e:
        make_client(handler).get_run("r-3")
    assert e.value.status_code == 401
    assert "invalid api key" in str(e.value)


def test_network_error_wrapped():
    from app.coreai import CoreAiError

    def handler(request):
        raise httpx.ConnectError("boom")

    with pytest.raises(CoreAiError):
        make_client(handler).get_run("r-4")


def test_non_dict_json_body_raises_coreai_error_not_attributeerror():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(200, json=[1, 2, 3])

    with pytest.raises(CoreAiError):
        make_client(handler).get_run("r-5")


def test_call_mcp_tool_posts_json_arguments_and_parses_nested_object():
    seen = {}

    def handler(request):
        import json

        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "success": True,
                "duration_ms": 12,
                "result": json.dumps({"reports": [{"report_key": "abc123"}]}),
            },
        )

    result = make_client(handler).call_mcp_tool(
        "local-falcon-id",
        "listLocalFalconScanReports",
        {"placeId": "place-1", "keyword": "breakfast"},
    )

    assert seen["url"] == "https://core.test/api/tools/mcp-servers/local-falcon-id/test-tool"
    assert seen["body"] == {
        "tool_name": "listLocalFalconScanReports",
        "arguments": '{"placeId": "place-1", "keyword": "breakfast"}',
    }
    assert result == {"reports": [{"report_key": "abc123"}]}


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        ({"success": False, "result": "upstream rejected", "duration_ms": 3}, "upstream rejected"),
        ({"success": True, "result": "[]", "duration_ms": 3}, "non-object"),
        ({"success": True, "result": "not-json", "duration_ms": 3}, "invalid JSON"),
    ],
)
def test_call_mcp_tool_rejects_failed_or_malformed_results(response, expected):
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(200, json=response)

    with pytest.raises(CoreAiError, match=expected):
        make_client(handler).call_mcp_tool("server-1", "readTool", {})

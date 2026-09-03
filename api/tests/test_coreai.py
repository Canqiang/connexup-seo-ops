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


def test_reads_skill_and_trace_span_detail_for_keyword_provenance():
    seen = []

    def handler(request):
        seen.append(request.url.path)
        if request.url.path == "/api/skills/seed-skill":
            return httpx.Response(
                200,
                json={
                    "id": "seed-skill",
                    "qualified_name": "fbradmin/seo-keyword-seed-generate",
                    "version": None,
                },
            )
        if request.url.path == "/api/traces/trace-1":
            return httpx.Response(
                200,
                json={"traceId": "trace-1", "agentId": "agent-1", "status": "COMPLETED"},
            )
        if request.url.path == "/api/traces/trace-1/spans":
            return httpx.Response(
                200,
                json={"spans": [{"spanId": "span-1", "name": "use_skill", "type": "TOOL"}]},
            )
        if request.url.path == "/api/traces/trace-1/spans/span-1":
            return httpx.Response(
                200,
                json={
                    "spanId": "span-1",
                    "name": "use_skill",
                    "type": "TOOL",
                    "status": "OK",
                    "input": '{"name":"fbradmin/seo-keyword-seed-generate"}',
                    "output": "ToolCallResult{status=COMPLETED, toolName='use_skill'}",
                },
            )
        raise AssertionError(f"unexpected path {request.url.path}")

    client = make_client(handler)

    assert client.get_skill("seed-skill")["qualified_name"] == (
        "fbradmin/seo-keyword-seed-generate"
    )
    assert client.get_trace("trace-1")["status"] == "COMPLETED"
    assert client.list_trace_spans("trace-1")[0]["spanId"] == "span-1"
    assert client.get_trace_span("trace-1", "span-1")["status"] == "OK"
    assert seen == [
        "/api/skills/seed-skill",
        "/api/traces/trace-1",
        "/api/traces/trace-1/spans",
        "/api/traces/trace-1/spans/span-1",
    ]


@pytest.mark.parametrize(
    ("method", "response"),
    [
        ("get_skill", {"id": "other", "qualified_name": "x/y"}),
        ("get_trace", {"traceId": "other", "status": "COMPLETED"}),
        ("list_trace_spans", {"spans": {}}),
        ("get_trace_span", {"spanId": "other", "status": "OK"}),
    ],
)
def test_provenance_reads_reject_mismatched_or_malformed_contracts(method, response):
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(200, json=response)

    client = make_client(handler)
    args = {
        "get_skill": ("expected",),
        "get_trace": ("expected",),
        "list_trace_spans": ("expected",),
        "get_trace_span": ("trace", "expected"),
    }[method]

    with pytest.raises(CoreAiError):
        getattr(client, method)(*args)


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

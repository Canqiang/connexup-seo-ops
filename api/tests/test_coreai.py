import httpx
import pytest


def make_client(handler):
    from app.coreai import CoreAiClient

    return CoreAiClient(
        "https://core.test", "coreai_k", transport=httpx.MockTransport(handler)
    )


def test_request_passes_query_params():
    seen = {}

    def handler(request):
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json={})

    make_client(handler)._request("GET", "/probe", params={"status": "PAUSED"})

    assert seen["query"] == {"status": "PAUSED"}


def test_list_agent_runs_uses_real_path_query_and_discards_large_fields():
    seen = {}

    def handler(request):
        seen["path"] = request.url.raw_path.decode().partition("?")[0]
        seen["query"] = dict(request.url.params)
        return httpx.Response(
            200,
            json={
                "runs": [
                    {
                        "id": "run-1",
                        "agent_id": "agent/1",
                        "triggered_by": "WORKFLOW",
                        "status": "PAUSED",
                        "input": "must disappear",
                        "output": "must disappear",
                        "error": None,
                        "error_stack": "must disappear",
                        "token_usage": {"input": 3, "output": 5},
                        "trace_id": "trace-1",
                        "started_at": "2026-09-03T01:00:00Z",
                        "completed_at": None,
                    }
                ],
                "total": 1,
            },
        )

    page = make_client(handler).list_agent_runs("agent/1", "PAUSED", 200)

    assert seen == {
        "path": "/api/runs/agent/agent%2F1/list",
        "query": {"status": "PAUSED", "limit": "200"},
    }
    assert page == {
        "runs": [
            {
                "id": "run-1",
                "agent_id": "agent/1",
                "triggered_by": "WORKFLOW",
                "status": "PAUSED",
                "token_usage": {"input": 3, "output": 5},
                "trace_id": "trace-1",
                "started_at": "2026-09-03T01:00:00Z",
                "completed_at": None,
                "error": None,
            }
        ],
        "total": 1,
    }
    assert "input" not in page["runs"][0]
    assert "output" not in page["runs"][0]
    assert "error_stack" not in page["runs"][0]

    make_client(handler).list_agent_runs("agent/1", None, 7)

    assert seen == {
        "path": "/api/runs/agent/agent%2F1/list",
        "query": {"limit": "7"},
    }


def test_list_agent_runs_preserves_zero_token_pair():
    def handler(_request):
        return httpx.Response(
            200,
            json={
                "runs": [
                    {
                        "id": "run-zero",
                        "token_usage": {"input": 0, "output": 0},
                    }
                ],
                "total": 1,
            },
        )

    page = make_client(handler).list_agent_runs("agent-1", None, 1)

    assert page["runs"][0]["token_usage"] == {"input": 0, "output": 0}


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        ({"total": 0}, "core-ai Agent run list is malformed"),
        ({"runs": {}, "total": 0}, "core-ai Agent run list is malformed"),
        (
            {"runs": ["secret-row"], "total": 1},
            "core-ai Agent run list is malformed",
        ),
        ({"runs": []}, "core-ai Agent run total is malformed"),
        ({"runs": [], "total": True}, "core-ai Agent run total is malformed"),
        ({"runs": [], "total": -1}, "core-ai Agent run total is malformed"),
        ({"runs": [], "total": 1.5}, "core-ai Agent run total is malformed"),
        ({"runs": [{}], "total": 0}, "core-ai Agent run total is malformed"),
    ],
)
def test_list_agent_runs_rejects_malformed_envelopes(response, expected):
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(200, json=response)

    with pytest.raises(CoreAiError, match=expected) as caught:
        make_client(handler).list_agent_runs("agent-1", None, 10)

    assert caught.value.status_code == 0


def test_list_agent_runs_accepts_empty_page_with_zero_total():
    def handler(_request):
        return httpx.Response(200, json={"runs": [], "total": 0})

    assert make_client(handler).list_agent_runs("agent-1", None, 10) == {
        "runs": [],
        "total": 0,
    }


def test_trigger_posts_input_and_returns_run_id():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("Authorization")
        import json

        seen["body"] = json.loads(request.content)
        return httpx.Response(202, json={"run_id": "r-1", "status": "RUNNING"})

    res = make_client(handler).trigger("agent/9", "hello")
    assert res["run_id"] == "r-1"
    assert seen["url"] == "https://core.test/api/runs/agent/agent%2F9/trigger"
    assert seen["auth"] == "Bearer coreai_k"
    assert seen["body"] == {"input": "hello"}


def test_trigger_missing_run_id_raises():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(202, json={"status": "RUNNING"})

    with pytest.raises(CoreAiError):
        make_client(handler).trigger("a", "x")


@pytest.mark.parametrize(
    ("response", "expected_run_id"),
    [
        ({}, None),
        ({"run_id": None}, None),
        ({"run_id": True}, None),
        ({"run_id": 12345}, None),
        ({"run_id": ["secret-run-id"]}, None),
        ({"run_id": ""}, None),
        ({"run_id": " \t "}, None),
        ({"run_id": "  padded-run-id  ", "status": "RUNNING"}, "padded-run-id"),
    ],
)
def test_trigger_rejects_invalid_run_identity(response, expected_run_id):
    from app.coreai import CoreAiContractError

    def handler(_request):
        return httpx.Response(202, json=response)

    if expected_run_id is not None:
        assert (
            make_client(handler).trigger("agent-1", "run")["run_id"]
            == expected_run_id
        )
        return

    with pytest.raises(CoreAiContractError) as caught:
        make_client(handler).trigger("agent-1", "run")
    assert caught.value.status_code == 0
    assert caught.value.code == "TRIGGER_RUN_ID_INVALID"
    assert str(caught.value) == "core-ai trigger response has invalid run_id"


def test_trigger_rejects_an_oversized_run_id():
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(202, json={"run_id": "r" * 256, "status": "RUNNING"})

    with pytest.raises(CoreAiError, match="run_id"):
        make_client(handler).trigger("a", "x")


@pytest.mark.parametrize(
    ("response", "expected_status"),
    [
        ({"run_id": "run-1", "marker": "kept"}, None),
        ({"run_id": "run-1", "status": None, "marker": "kept"}, None),
        ({"run_id": "run-1", "status": "", "marker": "kept"}, None),
        ({"run_id": "run-1", "status": " \t ", "marker": "kept"}, None),
        ({"run_id": "run-1", "status": True, "marker": "kept"}, None),
        ({"run_id": "run-1", "status": 7, "marker": "kept"}, None),
        ({"run_id": "run-1", "status": ["RUNNING"], "marker": "kept"}, None),
        (
            {"run_id": "run-1", "status": {"value": "RUNNING"}, "marker": "kept"},
            None,
        ),
        ({"run_id": "run-1", "status": "  RUNNING  ", "marker": "kept"}, "RUNNING"),
        (
            {"run_id": "run-1", "status": "  WAITING_FOR_TOOL  ", "marker": "kept"},
            "WAITING_FOR_TOOL",
        ),
    ],
)
def test_trigger_normalizes_optional_status(response, expected_status):
    def handler(_request):
        return httpx.Response(202, json=response)

    result = make_client(handler).trigger("agent-1", "run")

    assert result["run_id"] == "run-1"
    assert result["status"] == expected_status
    assert result["marker"] == "kept"


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


def test_llm_call_rejects_an_oversized_output_field():
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(200, json={"output": "x" * (1024 * 1024 + 1)})

    with pytest.raises(CoreAiError, match="output"):
        make_client(handler).llm_call("prepare-v1", "prepare this")


def test_get_agent_reads_back_the_exact_published_capabilities():
    def handler(request):
        assert request.method == "GET"
        assert request.url.raw_path == b"/api/agents/agent%2F9"
        return httpx.Response(
            200, json={"id": "agent/9", "status": "PUBLISHED", "tools": []}
        )

    agent = make_client(handler).get_agent("agent/9")

    assert agent == {"id": "agent/9", "status": "PUBLISHED", "tools": []}


def test_get_agent_id_mismatch_is_typed_contract_error():
    from app.coreai import CoreAiContractError, CoreAiError

    def handler(_request):
        return httpx.Response(
            200, json={"id": "other-agent", "status": "PUBLISHED", "tools": []}
        )

    with pytest.raises(CoreAiContractError) as caught:
        make_client(handler).get_agent("agent-9")

    assert isinstance(caught.value, CoreAiError)
    assert caught.value.status_code == 0
    assert caught.value.code == "AGENT_ID_MISMATCH"
    assert str(caught.value) == "core-ai agent detail id mismatch"


def test_coreai_json_lists_have_a_bounded_item_count():
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(
            200,
            json={"id": "agent-9", "status": "PUBLISHED", "tools": [{}] * 1001},
        )

    with pytest.raises(CoreAiError, match="list"):
        make_client(handler).get_agent("agent-9")


def test_get_run_returns_detail():
    def handler(request):
        assert str(request.url) == "https://core.test/api/runs/r-2"
        return httpx.Response(
            200, json={"id": "r-2", "status": "COMPLETED", "output": "report"}
        )

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
                json={
                    "traceId": "trace-1",
                    "agentId": "agent-1",
                    "status": "COMPLETED",
                },
            )
        if request.url.path == "/api/traces/trace-1/spans":
            return httpx.Response(
                200,
                json={
                    "spans": [{"spanId": "span-1", "name": "use_skill", "type": "TOOL"}]
                },
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


@pytest.mark.parametrize(
    "response",
    [
        {"status": "COMPLETED", "output": "report"},
        {"id": "another-run", "status": "COMPLETED", "output": "report"},
    ],
)
def test_get_run_rejects_a_missing_or_mismatched_run_id(response):
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(200, json=response)

    with pytest.raises(CoreAiError, match="run detail id mismatch"):
        make_client(handler).get_run("expected-run")


def test_get_run_rejects_a_status_outside_the_public_coreai_contract():
    from app.coreai import CoreAiError

    def handler(_request):
        return httpx.Response(200, json={"id": "bad-status", "status": "BROKEN"})

    with pytest.raises(CoreAiError, match="unsupported status"):
        make_client(handler).get_run("bad-status")


@pytest.mark.parametrize(
    "unsafe_output",
    [
        {"password": "output-object-secret"},
        ["output-list-secret"],
    ],
)
def test_get_run_converts_non_text_completed_output_to_safe_failure(unsafe_output):
    def handler(_request):
        return httpx.Response(
            200,
            json={"id": "terminal-run", "status": "COMPLETED", "output": unsafe_output},
        )

    detail = make_client(handler).get_run("terminal-run")

    assert detail["status"] == "FAILED"
    assert "invalid output" in detail["error"]
    assert "output" not in detail
    assert "output-object-secret" not in str(detail)
    assert "output-list-secret" not in str(detail)


def test_get_run_replaces_non_text_terminal_error_with_safe_failure():
    def handler(_request):
        return httpx.Response(
            200,
            json={
                "id": "terminal-run",
                "status": "FAILED",
                "error": {"client_secret": "structured-error-secret"},
            },
        )

    detail = make_client(handler).get_run("terminal-run")

    assert detail["status"] == "FAILED"
    assert detail["error"] == "core-ai terminal response has invalid error"
    assert "structured-error-secret" not in str(detail)


def test_http_error_surfaces_status_and_message():
    from app.coreai import CoreAiError

    def handler(request):
        return httpx.Response(401, json={"message": "invalid api key"})

    with pytest.raises(CoreAiError) as e:
        make_client(handler).get_run("r-3")
    assert e.value.status_code == 401
    assert "invalid api key" in str(e.value)


def test_http_error_message_is_redacted_single_line_and_bounded():
    from app.coreai import CoreAiError

    malicious = (
        "\x00 forged log line\nAuthorization: Bearer top-secret-token\r\n" + "x" * 1000
    )

    def handler(_request):
        return httpx.Response(500, json={"message": malicious})

    with pytest.raises(CoreAiError) as caught:
        make_client(handler).get_run("r-secret")

    stored = str(caught.value)
    assert len(stored) <= 500
    assert "top-secret-token" not in stored
    assert "\x00" not in stored
    assert "\n" not in stored
    assert "\r" not in stored


def test_http_error_redacts_common_plain_and_quoted_credential_forms():
    from app.coreai import CoreAiError

    malicious = (
        "access_token=access-token-value "
        "client_secret:'client-secret-value' "
        'password="password-value" '
        '{"api_key":"quoted-api-key-value"}'
    )

    def handler(_request):
        return httpx.Response(500, json={"message": malicious})

    with pytest.raises(CoreAiError) as caught:
        make_client(handler).get_run("r-secret")

    stored = str(caught.value)
    for secret in (
        "access-token-value",
        "client-secret-value",
        "password-value",
        "quoted-api-key-value",
    ):
        assert secret not in stored


def test_http_error_redacts_header_query_refresh_token_and_url_userinfo_forms():
    from app.coreai import CoreAiError

    malicious = " ".join(
        (
            "X-Api-Key: x-api-key-secret",
            "Authorization: Basic basic-auth-secret",
            "refresh_token=refresh-secret",
            "Refresh-Token: refresh-header-secret",
            "https://alice:url-password-secret@core.test/fail?api_key=query-secret&refresh_token=query-refresh-secret",
        )
    )

    def handler(_request):
        return httpx.Response(503, json={"message": malicious})

    with pytest.raises(CoreAiError) as caught:
        make_client(handler).get_run("r-secret")

    stored = str(caught.value)
    for secret in (
        "x-api-key-secret",
        "basic-auth-secret",
        "refresh-secret",
        "refresh-header-secret",
        "url-password-secret",
        "query-secret",
        "query-refresh-secret",
    ):
        assert secret not in stored


def test_http_error_redacts_cloud_signed_url_credentials_and_preserves_safe_query_shape():
    from app.coreai import CoreAiError

    malicious = " ".join(
        (
            "azure=https://blob.test/report.html?sv=2018-11-09&sp=r&sig=azure-secret&se=2026-09-03T04%3A16%3A57Z",
            "legacy=https://blob.test/report?signature=legacy-secret&download=1",
            "aws=https://s3.test/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=aws-credential%2Fscope&X-Amz-Signature=aws-signature&response-content-type=text%2Fhtml",
        )
    )

    def handler(_request):
        return httpx.Response(500, json={"message": malicious})

    with pytest.raises(CoreAiError) as caught:
        make_client(handler).get_run("r-signed-url")

    assert str(caught.value) == " ".join(
        (
            "azure=https://blob.test/report.html?sv=2018-11-09&sp=r&sig=<redacted>&se=2026-09-03T04%3A16%3A57Z",
            "legacy=https://blob.test/report?signature=<redacted>&download=1",
            "aws=https://s3.test/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=<redacted>&X-Amz-Signature=<redacted>&response-content-type=text%2Fhtml",
        )
    )


def test_http_error_redacts_common_sensitive_query_keys_without_touching_safe_keys():
    from app.coreai import sanitize_coreai_error

    unsafe = (
        "https://core.test/callback?token=token-secret&code=code-secret&key=key-secret"
        "&api-key=api-key-secret&access_token=access-secret"
        "&refresh-token=refresh-secret&session_token=session-secret"
        "&monkey=banana&postcode=11501&keyboard=qwerty"
    )

    assert sanitize_coreai_error(unsafe) == (
        "https://core.test/callback?token=<redacted>&code=<redacted>&key=<redacted>"
        "&api-key=<redacted>&access_token=<redacted>"
        "&refresh-token=<redacted>&session_token=<redacted>"
        "&monkey=banana&postcode=11501&keyboard=qwerty"
    )


def test_http_error_redacts_embedded_multiple_and_malformed_urls_without_losing_punctuation():
    from app.coreai import sanitize_coreai_error

    unsafe = (
        "first=(https://one.test/a?sig=one-secret&view=full), "
        "malformed=https://[::1/path?token=two-secret&keep=yes; "
        "next=https://two.test/b?code=three-secret#section. "
        "bad-percent=https://bad.test/?signature=%E0%A4%A&ok=%ZZ"
    )

    assert sanitize_coreai_error(unsafe) == (
        "first=(https://one.test/a?sig=<redacted>&view=full), "
        "malformed=https://[::1/path?token=<redacted>&keep=yes; "
        "next=https://two.test/b?code=<redacted>#section. "
        "bad-percent=https://bad.test/?signature=<redacted>&ok=%ZZ"
    )


def test_declared_oversized_response_is_rejected_without_reading_its_body():
    from app.coreai import CoreAiError

    class MustNotRead(httpx.SyncByteStream):
        def __iter__(self):
            raise AssertionError("oversized response body was read")

    def handler(_request):
        return httpx.Response(
            200,
            headers={"Content-Length": str(2 * 1024 * 1024 + 1)},
            stream=MustNotRead(),
        )

    with pytest.raises(CoreAiError, match="too large"):
        make_client(handler).get_run("oversized-run")


def test_chunked_oversized_response_stops_at_the_byte_ceiling():
    from app.coreai import CoreAiError

    class OversizedChunks(httpx.SyncByteStream):
        def __iter__(self):
            yield b'{"padding":"'
            yield b"x" * (2 * 1024 * 1024)
            raise AssertionError("client read beyond its response byte ceiling")

    def handler(_request):
        return httpx.Response(200, stream=OversizedChunks())

    with pytest.raises(CoreAiError, match="too large"):
        make_client(handler).get_run("oversized-run")


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

    assert (
        seen["url"]
        == "https://core.test/api/tools/mcp-servers/local-falcon-id/test-tool"
    )
    assert seen["body"] == {
        "tool_name": "listLocalFalconScanReports",
        "arguments": '{"placeId": "place-1", "keyword": "breakfast"}',
    }
    assert result == {"reports": [{"report_key": "abc123"}]}


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (
            {"success": False, "result": "upstream rejected", "duration_ms": 3},
            "upstream rejected",
        ),
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

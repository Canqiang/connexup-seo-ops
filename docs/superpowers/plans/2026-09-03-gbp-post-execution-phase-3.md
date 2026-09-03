# GBP Post Execution Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the first external-write Workflow Template so an approved GBP Post Artifact is published by a narrowly capable Agent and marked complete only after exact readback verification.

**Architecture:** Add a feature-flagged `GBP_POST` template, strict artifact/publish/readback contracts, separate Publishing and Verification Agent capability gates, and durable dispatch/verification attempts. Approval creates a publication attempt automatically; every ambiguous write outcome moves forward to read-only reconciliation and never loops back into a blind create call.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, SQLite, pytest, httpx-based Core AI client, React 19, TypeScript 6, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-generated-task-dependencies-design.md`

## Global Constraints

- Complete and deploy Phase 1 and Phase 2 before enabling this phase.
- Use an isolated worktree; preserve unrelated Dashboard/Performance changes and `docs/evidence/`.
- `SEO_OPS_GBP_POST_ENABLED` defaults to false and must gate Plan validation, policy activation, scheduler dispatch, and UI capability.
- Publishing and Verification use different published Core AI Agents and different exact tool IDs.
- Publishing Agent gets only the configured GBP Post create tool; Verification Agent gets only the configured GBP Post read tool; neither gets Skills, sub-agents, sandbox, or datasets.
- Publishing receives only the immutable approved Artifact, exact target, ApprovalGrant, and stable idempotency key; it cannot rewrite content or target.
- Persist publication intent and request checksum before the remote trigger.
- A lost/ambiguous publishing response, stale dispatch lease, or any observed write-tool invocation transitions to read-only verification; it never triggers a second create automatically.
- Read-only verification may retry with persisted backoff; publication may retry automatically only when Core AI trace proves the write tool was never invoked.
- API success, Core AI Run completion, or Agent prose never marks the Task `DONE`.
- Only server-normalized provider readback matching the approved Artifact and location marks `DONE` and unlocks downstream Tasks.
- Mismatch or inconclusive readback enters `NEEDS_ATTENTION`; compensating edits/removal require a new independently authorized Task.
- No browser route may call Core AI, FBR, Operation Assistant, or Google directly.
- Never persist or return OAuth tokens, API keys, or raw credentials.
- Do not modify Dashboard or Performance files.

## File and Responsibility Map

- `api/app/gbp_post_contract.py`: GBP Post task parameters, Artifact, publishing result, verification readback, normalization, and exact comparison.
- `api/app/task_agent_capabilities.py`: exact Publishing/Verification Agent capability validation.
- `api/app/task_publication.py`: publication request construction, durable claim/dispatch, Run polling, trace proof, and uncertainty conversion.
- `api/app/task_verification.py`: read-only verification request, retries, Run polling, exact match, and final transition.
- `api/app/task_orchestrator.py`: creates pending publication/verification attempts and advances the fixed template.
- `api/app/task_workflows.py`, `api/app/task_artifacts.py`, `api/app/task_authorization.py`: register `GBP_POST`, its Artifact parser, operation/target, and post-grant transition.
- `api/app/coreai.py`, `api/app/config.py`, `api/app/scheduler.py`: trace/capability helpers, environment settings, and ordered orchestration loop.
- `api/app/tasks.py`: safe reconcile endpoint and complete execution/readback detail.
- `api/schema.sql`, `api/app/db.py`: any remaining attempt columns/indexes and an idempotent additive migration.
- `web/src/pages/TaskDetail.tsx`: approved → publishing → verification → done/attention timeline and safe reconcile action.
- `web/src/pages/AutomationPolicies.tsx`: only permits activation when live GBP Post capability is enabled.
- `web/src/api.ts`, `web/src/labels.ts`, `web/src/App.test.tsx`, `web/src/index.css`: contracts, copy, tests, and presentation.
- `api/.env.example`, `README.md`: feature flag, exact Agent/tool settings, rollout and recovery instructions.

---

### Task 1: Strict GBP Post parameter, Artifact, and readback contracts

**Files:**
- Create: `api/app/gbp_post_contract.py`
- Create: `api/tests/test_gbp_post_contract.py`
- Modify: `api/app/task_plan_contract.py`
- Modify: `api/app/task_workflows.py`
- Modify: `api/app/task_artifacts.py`
- Modify: `api/app/task_orchestrator.py`
- Modify: `api/tests/test_task_plan_contract.py`
- Modify: `api/tests/test_task_artifacts.py`
- Modify: `api/tests/test_task_orchestrator.py`

**Interfaces:**
- Produces: `GbpPostParameters`, `GbpPostArtifact`, `GbpPostPublishResult`, and `GbpPostReadbackResult`.
- Produces: `normalize_observed_post(post: ObservedGbpPost) -> dict[str, object]`.
- Produces: `match_approved_post(artifact, readback, provider_resource_id) -> VerifiedMatch`.
- Changes: the read-only Preparation request for `GBP_POST` requires exactly one `seo_ops.gbp_post_artifact.v1` object bound to the persisted location/topic.
- Changes: `GBP_POST` is accepted by Plan validation only when the runtime feature flag is true.

- [ ] **Step 1: Write strict parameter and Artifact tests**

```python
VALID_ARTIFACT = {
    "schema_version": "seo_ops.gbp_post_artifact.v1",
    "location_id": "locations/123",
    "language_code": "en-US",
    "topic_type": "STANDARD",
    "summary": "Lunch specials are available this week.",
    "call_to_action": {
        "action_type": "ORDER",
        "url": "https://example.com/order",
    },
    "media": [{
        "source_uri": "https://images.example.com/lunch.jpg",
        "media_format": "PHOTO",
    }],
    "external_write_performed": False,
}


def test_gbp_post_artifact_is_strict_and_target_bound():
    artifact = parse_gbp_post_artifact(VALID_ARTIFACT, expected_location_id="locations/123")
    assert artifact.payload["summary"] == "Lunch specials are available this week."
    assert len(artifact.checksum) == 64
```

Reject unknown fields, wrong location, non-`en-US`, non-`STANDARD`, empty or over-1500 summary, unsupported CTA, non-HTTPS CTA/media URLs, more than one media item, non-PHOTO media, and `external_write_performed` not exactly false.

- [ ] **Step 2: Write readback comparison tests**

Test exact provider ID match, exact content match without an ID, zero matches, two matches, location mismatch, summary whitespace difference, CTA mismatch, media mismatch, and non-LIVE provider state. Only one exact normalized LIVE match may return `VerifiedMatch(matched=True, ...)`.

```python
def test_duplicate_exact_posts_are_not_accepted_as_one_verified_match():
    readback = GbpPostReadbackResult(
        schema_version="seo_ops.gbp_post_readback.v1",
        search_complete=True,
        observed_at="2026-09-03T12:00:00Z",
        posts=[OBSERVED_POST, {**OBSERVED_POST, "provider_resource_id": "posts/second"}],
    )
    result = match_approved_post(VALID_ARTIFACT, readback, provider_resource_id=None)
    assert result.matched is False
    assert result.reason == "multiple_exact_matches"
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_gbp_post_contract.py tests/test_task_plan_contract.py tests/test_task_artifacts.py -q`

Expected: FAIL because `GBP_POST` has no server contract.

- [ ] **Step 4: Implement the exact schemas**

```python
HttpsUrl = Annotated[AnyUrl, UrlConstraints(allowed_schemes=["https"])]


class GbpPostParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location_id: str = Field(min_length=1, max_length=200)
    topic: str = Field(min_length=1, max_length=500)


class GbpPostCallToAction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_type: Literal["LEARN_MORE", "ORDER", "SIGN_UP"]
    url: HttpsUrl


class GbpPostMedia(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_uri: HttpsUrl
    media_format: Literal["PHOTO"]


class GbpPostArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["seo_ops.gbp_post_artifact.v1"]
    location_id: str = Field(min_length=1, max_length=200)
    language_code: Literal["en-US"]
    topic_type: Literal["STANDARD"]
    summary: str = Field(min_length=1, max_length=1500)
    call_to_action: GbpPostCallToAction | None = None
    media: list[GbpPostMedia] = Field(default_factory=list, max_length=1)
    external_write_performed: Literal[False]
```

Define `ObservedGbpPost` with provider resource ID, location ID, summary, CTA, media, state, create/update timestamps. `GbpPostReadbackResult` contains `search_complete: bool`, `observed_at: AwareDatetime`, and at most 100 observed posts; it contains no Agent-supplied `matched` or checksum field. Normalize line endings to `\n` and trim only outer text whitespace; do not collapse internal spaces or rewrite URLs.

- [ ] **Step 5: Register the fixed template behind the flag**

Add template path `PENDING -> PREPARING -> AWAITING_APPROVAL -> EXECUTING -> VERIFYING -> DONE`, with `NEEDS_ATTENTION` allowed from non-terminal states, `operation = "CREATE_GBP_POST"`, and `policy_authorizable = True`. Register `GbpPostParameters` and `GbpPostArtifact` parsers but return `task_type_disabled` unless `SEO_OPS_GBP_POST_ENABLED=true`.

Extend the Preparation request builder by template: `PREPARE_ONLY` retains `seo_ops.preparation_artifact.v1`; `GBP_POST` receives persisted merchant facts plus the exact `location_id`/`topic` as untrusted data and must return `seo_ops.gbp_post_artifact.v1` with `external_write_performed=false`. Assert the Preparation Agent still has no tools and cannot publish.

```python
WORKFLOW_TEMPLATES["GBP_POST"] = WorkflowTemplate(
    task_type="GBP_POST",
    version=1,
    transitions=GBP_POST_TRANSITIONS,
    terminal_after_approval=False,
    operation="CREATE_GBP_POST",
    policy_authorizable=True,
)
```

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_gbp_post_contract.py tests/test_task_plan_contract.py tests/test_task_artifacts.py tests/test_task_workflows.py tests/test_task_orchestrator.py -q`

Expected: PASS.

```bash
git add api/app/gbp_post_contract.py api/app/task_plan_contract.py api/app/task_workflows.py api/app/task_artifacts.py api/app/task_orchestrator.py api/tests/test_gbp_post_contract.py api/tests/test_task_plan_contract.py api/tests/test_task_artifacts.py api/tests/test_task_orchestrator.py
git commit -m "feat: define the gbp post workflow contract"
```

---

### Task 2: Feature flag and exact stage-specific Agent capability gates

**Files:**
- Create: `api/app/task_agent_capabilities.py`
- Create: `api/tests/test_task_agent_capabilities.py`
- Modify: `api/app/config.py`
- Modify: `api/app/automation_policies.py`
- Modify: `api/app/task_authorization.py`
- Modify: `api/tests/test_config.py`
- Modify: `api/tests/test_automation_policies.py`
- Modify: `api/tests/test_task_authorization.py`
- Modify: `api/tests/conftest.py`
- Modify: `api/tests/helpers.py`

**Interfaces:**
- Extends: `CoreAiSettings` with GBP Post enablement, Agent IDs, and exact tool IDs.
- Produces: `validate_publishing_agent(agent: dict, expected_tool_id: str) -> None`.
- Produces: `validate_verification_agent(agent: dict, expected_tool_id: str) -> None`.
- Produces: `POST /api/automation-policies/{policy_key}/activate` with `expected_version`.
- Changes: the merchant policy-list capability response reports `gbp_post_enabled` and `can_activate`; `can_activate` is true only when the flag and all four distinct stage settings are valid.

- [ ] **Step 1: Write configuration and fail-closed tests**

```python
def test_gbp_post_is_disabled_by_default(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core-ai.test")
    monkeypatch.setenv("COREAI_API_KEY", "test-key")
    monkeypatch.setenv("COREAI_AGENT_ID", "analysis-agent")
    monkeypatch.delenv("SEO_OPS_GBP_POST_ENABLED", raising=False)
    settings = coreai_settings()
    assert settings is not None
    assert settings.gbp_post_enabled is False


def test_enabled_gbp_post_requires_all_four_stage_settings(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core-ai.test")
    monkeypatch.setenv("COREAI_API_KEY", "test-key")
    monkeypatch.setenv("COREAI_AGENT_ID", "analysis-agent")
    monkeypatch.setenv("SEO_OPS_GBP_POST_ENABLED", "true")
    with pytest.raises(CoreAiConfigurationError):
        coreai_settings()
```

When enabled, require non-empty `COREAI_GBP_POST_PUBLISH_AGENT_ID`, `COREAI_GBP_POST_VERIFY_AGENT_ID`, `COREAI_GBP_POST_PUBLISH_TOOL_ID`, and `COREAI_GBP_POST_READ_TOOL_ID`. Reject equal publish/verify Agent IDs or equal tool IDs.

Assert policy activation returns 409 while the feature is disabled or any required setting is missing. With complete enabled settings, activation creates a new immutable `ACTIVE` policy version. Pausing/revoking creates a later version, revokes grants whose publication attempt is still `PENDING`, cancels those attempts, and returns their Tasks to `AWAITING_APPROVAL`. It does not alter `DISPATCHING`, `RUNNING`, or later attempts.

- [ ] **Step 2: Write exact capability tests**

Accept only a `PUBLISHED` Agent whose tool-ID set equals the one expected ID and whose `skill_ids`, `subagent_ids`, `sandbox_config`, and `dataset_config` are empty. Reject extra built-in/MCP tools, missing tool, draft status, IDs in the wrong stage, and any auxiliary capability.

```python
@pytest.mark.parametrize("field,value", [
    ("tools", []),
    ("tools", [{"id": "publish-tool"}, {"id": "extra-tool"}]),
    ("skill_ids", ["skill-1"]),
    ("subagent_ids", ["agent-2"]),
])
def test_publishing_agent_rejects_capability_drift(published_agent, field, value):
    published_agent[field] = value
    with pytest.raises(AgentCapabilityError):
        validate_publishing_agent(published_agent, "publish-tool")
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_agent_capabilities.py tests/test_config.py -q`

Expected: FAIL because the new settings and validators do not exist.

- [ ] **Step 4: Implement strict settings and validators**

```python
@dataclass(frozen=True)
class GbpPostAgentSettings:
    enabled: bool
    publish_agent_id: str | None
    verify_agent_id: str | None
    publish_tool_id: str | None
    read_tool_id: str | None


def _tool_ids(agent: dict) -> set[str]:
    tools = agent.get("tools")
    if not isinstance(tools, list):
        raise AgentCapabilityError("agent tools are malformed")
    return {tool["id"] for tool in tools if isinstance(tool, dict) and isinstance(tool.get("id"), str)}
```

Share one internal `_validate_stage_agent()` while exposing separate stage functions so callers cannot accidentally validate a publishing Agent as read-only verification.

Implement policy activation as a compare-and-set version operation. It checks configuration but does not contact Core AI; every actual dispatch still reads back and validates the live Agent capability snapshot before claim. Implement pause/revoke cleanup in the same database transaction as the new policy version so no unclaimed attempt can race through on an obsolete policy grant.

Extend the Phase-2 policy list response using only validated server settings:

```python
capabilities = {
    "gbp_post_enabled": settings is not None and settings.gbp_post_enabled,
    "can_activate": settings is not None and settings.gbp_post_enabled and settings.gbp_post_stage_settings_complete,
}
```

This capability means activation is configured, not that the remote Agents are currently valid; activation remains a local compare-and-set, and dispatch still performs live Agent readback before any claim.

- [ ] **Step 5: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_agent_capabilities.py tests/test_config.py -q`

Expected: PASS.

```bash
git add api/app/task_agent_capabilities.py api/app/config.py api/app/automation_policies.py api/app/task_authorization.py api/tests/test_task_agent_capabilities.py api/tests/test_config.py api/tests/test_automation_policies.py api/tests/test_task_authorization.py api/tests/conftest.py api/tests/helpers.py
git commit -m "feat: gate gbp post agents by exact capability"
```

---

### Task 3: Approval-to-publication transition and durable dispatch boundary

**Files:**
- Create: `api/app/task_publication.py`
- Create: `api/tests/test_task_publication.py`
- Modify: `api/app/task_authorization.py`
- Modify: `api/app/task_orchestrator.py`
- Modify: `api/app/coreai.py`
- Modify: `api/app/tasks.py`
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Modify: `api/tests/test_tasks.py`

**Interfaces:**
- Produces: `build_publication_request(task, artifact, grant, idempotency_key) -> dict`.
- Produces: `begin_publication(conn, *, task_id, grant_id) -> sqlite3.Row`.
- Produces: `dispatch_publication_once(client, settings) -> int`.
- Produces: `POST /api/tasks/{task_id}/revoke-approval` with `{expected_version, reason}`.
- Changes: valid GBP_POST grant atomically transitions `AWAITING_APPROVAL -> EXECUTING` and creates one `PENDING` publication attempt.

- [ ] **Step 1: Write exact request and post-grant tests**

```python
def test_gbp_post_grant_creates_one_pending_publication_attempt(awaiting_gbp_task, db):
    grant = approve_current_artifact(awaiting_gbp_task)
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (awaiting_gbp_task["id"],)).fetchone()
    attempt = db.execute(
        "SELECT * FROM task_executions WHERE task_id = ? AND stage = 'PUBLICATION'",
        (task["id"],),
    ).fetchone()
    assert task["status"] == "EXECUTING"
    assert attempt["status"] == "PENDING"
    assert attempt["approval_id"] == grant["id"]
```

Assert the request contains only schema version, Task/Artifact/grant IDs, merchant/location, operation, Artifact payload/checksum, and idempotency key. Assert no rationale, free-form operator instructions, token, secret, or policy payload is included. Assert an expired/revoked grant is re-read before claim, cancels the pending publication attempt, and returns the Task to `AWAITING_APPROVAL` without a remote call.

- [ ] **Step 2: Write lost-response and concurrency tests**

Two workers may claim only one pending attempt. Persist `DISPATCHING`, dispatch token, start time, canonical request JSON/checksum, and stable idempotency key before `CoreAiClient.trigger()`. Simulate process loss after the trigger but before run-ID persistence; stale recovery must mark the attempt `UNKNOWN`, move Task to `VERIFYING`, and create a verification attempt without triggering publishing again.

Approval revocation succeeds only while the publication attempt is still `PENDING`: revoke the grant, cancel that attempt, return the Task to `AWAITING_APPROVAL`, increment its version, and append events in one transaction. Once the attempt is `DISPATCHING` or `RUNNING`, return 409. Pausing/revoking a policy performs the same cleanup for its unclaimed pending grants but does not alter an already claimed attempt.

```python
def test_lost_publish_ack_never_dispatches_a_second_create(publication_workflow):
    publication_workflow.lose_trigger_response_after_remote_accept()
    publication_workflow.recover_stale_dispatch()
    publication_workflow.run_scheduler_ticks(3)
    assert publication_workflow.publish_trigger_count == 1
    assert publication_workflow.task_status == "VERIFYING"
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_publication.py -q`

Expected: FAIL because no publication dispatcher exists.

- [ ] **Step 4: Add/verify durable execution columns and indexes**

Ensure `task_executions` contains `stage`, `status`, `attempt`, `approval_id`, `artifact_id`, `request_json`, `request_checksum`, `idempotency_key`, `dispatch_token`, `dispatch_started_at`, `coreai_run_id`, `provider_resource_id`, `result_json`, `evidence_json`, `error`, `next_attempt_at`, `created_at`, and `finished_at`. Add one partial unique active-attempt index per `(task_id, stage)` for statuses `PENDING`, `DISPATCHING`, and `RUNNING`. Add an idempotent migration for any columns not created in Phase 1.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_active_stage
  ON task_executions(task_id, stage)
  WHERE status IN ('PENDING','DISPATCHING','RUNNING');
```

- [ ] **Step 5: Implement stable identity and pre-call persistence**

```python
def publication_idempotency_key(task_id: int, artifact_checksum: str, operation: str) -> str:
    raw = f"seo-ops:{task_id}:{artifact_checksum}:{operation}".encode()
    return hashlib.sha256(raw).hexdigest()


def build_publication_request(task, artifact, grant, idempotency_key):
    return {
        "schema_version": "seo_ops.gbp_post_publish_request.v1",
        "task_id": task["id"],
        "merchant_id": task["merchant_id"],
        "artifact_id": artifact["id"],
        "artifact_checksum": artifact["checksum"],
        "approval_grant_id": grant["id"],
        "operation": "CREATE_GBP_POST",
        "location_id": artifact["payload"]["location_id"],
        "idempotency_key": idempotency_key,
        "post": artifact["payload"],
    }
```

Validate the Publishing Agent before claiming. Claim under `BEGIN IMMEDIATE`, commit, then trigger Core AI outside the transaction. Persist the returned run ID only with `WHERE status='DISPATCHING' AND dispatch_token=?`.

- [ ] **Step 6: Treat all unacknowledged dispatch outcomes as unknown**

Any exception after the remote trigger begins is not proof of absence. Store `UNKNOWN`, transition to `VERIFYING`, create a read-only verification attempt, and append events. Stale `DISPATCHING` recovery follows the same path. It must never set the Task back to `EXECUTING` or create another publication attempt.

```python
except CoreAiError as exc:
    mark_publication_unknown_and_begin_verification(
        execution_id=claim.execution_id,
        reason=f"publishing dispatch outcome unknown: {exc}",
    )
```

- [ ] **Step 7: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_publication.py tests/test_task_authorization.py tests/test_db.py -q`

Expected: PASS.

```bash
git add api/app/task_publication.py api/app/task_authorization.py api/app/task_orchestrator.py api/app/coreai.py api/app/tasks.py api/schema.sql api/app/db.py api/tests/test_task_publication.py api/tests/test_tasks.py
git commit -m "feat: add durable gbp post publication dispatch"
```

---

### Task 4: Publishing Run polling and trace-based retry proof

**Files:**
- Modify: `api/app/task_publication.py`
- Modify: `api/app/coreai.py`
- Modify: `api/tests/test_task_publication.py`
- Modify: `api/tests/helpers.py`

**Interfaces:**
- Produces: `poll_publication_runs_once(client, settings) -> int`.
- Produces: `publish_tool_invocations(client, run: dict, expected_tool_id: str) -> list[dict]`.
- Produces: `parse_publish_result(raw: object) -> GbpPostPublishResult`.

- [ ] **Step 1: Write terminal outcome matrix tests**

Cover:

```text
Core AI non-terminal                         -> stay RUNNING
COMPLETED + one exact write tool invocation -> store result/hint, go VERIFYING
COMPLETED + claimed create but no tool span  -> NEEDS_ATTENTION
FAILED/TIMEOUT + no write tool span          -> one limited safe publication retry
FAILED/TIMEOUT + any write tool span         -> VERIFYING, never republish
trace unavailable or malformed               -> VERIFYING, never republish
wrong tool invocation                         -> NEEDS_ATTENTION
more than one publish-tool invocation         -> VERIFYING with anomaly, never republish
```

Assert total publication attempts are at most 2 and both use the same idempotency key, artifact, grant, and request checksum.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_publication.py -q`

Expected: FAIL because publication Runs are not polled or trace-checked.

- [ ] **Step 3: Extend Core AI trace helpers without exposing credentials**

Use existing `get_trace`, `list_trace_spans`, and `get_trace_span`. Determine the trace ID from the persisted Core AI Run readback. Accept a write invocation only when a span's structured tool identity equals the configured publish tool ID; do not infer from span names or Agent prose.

```python
def publish_tool_invocations(client, run, expected_tool_id):
    trace_id = run.get("trace_id") or run.get("traceId")
    if not isinstance(trace_id, str) or not trace_id:
        raise TraceProofUnavailable("publishing trace id is missing")
    return [span for span in client.list_trace_spans(trace_id) if span_tool_id(span) == expected_tool_id]
```

- [ ] **Step 4: Implement fail-closed polling**

Parse `GbpPostPublishResult` from the configured publish-tool span output, not from Agent final prose. Its fields are `schema_version`, `outcome IN ('CREATED','REJECTED_BEFORE_WRITE','UNKNOWN')`, optional `provider_resource_id`, location ID, and artifact checksum. Store Agent final output only as secondary explanation. Treat resource ID as a hint and compare the span's structured tool arguments with the frozen location and Artifact payload; any argument drift is an anomaly and proceeds to verification without another publish. A failed/timeout Core AI Run with a complete trace proving zero write-tool invocations may take the limited safe retry path; a completed Run may retry only when its final structured result is `REJECTED_BEFORE_WRITE` and the complete trace also proves zero write-tool invocations. All contradictions enter `NEEDS_ATTENTION` or verification as defined by the outcome matrix.

```python
invocations = publish_tool_invocations(client, core, settings.gbp_post_publish_tool_id)
if len(invocations) == 1:
    result = parse_publish_result(span_output(invocations[0]))
    begin_verification_from_publish_result(conn, execution, result)
elif len(invocations) > 1:
    begin_verification_with_anomaly(conn, execution, "multiple publish tool invocations")
else:
    handle_proven_no_write_outcome(conn, execution, core)
```

- [ ] **Step 5: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_publication.py tests/test_coreai.py -q`

Expected: PASS.

```bash
git add api/app/task_publication.py api/app/coreai.py api/tests/test_task_publication.py api/tests/helpers.py
git commit -m "feat: reconcile publication outcomes from trace evidence"
```

---

### Task 5: Read-only verification, exact readback, and persisted backoff

**Files:**
- Create: `api/app/task_verification.py`
- Create: `api/tests/test_task_verification.py`
- Modify: `api/app/task_orchestrator.py`
- Modify: `api/app/task_agent_capabilities.py`

**Interfaces:**
- Produces: `begin_verification(conn, *, task_id, publication_execution_id) -> sqlite3.Row`.
- Produces: `dispatch_verification_once(client, settings) -> int`.
- Produces: `poll_verification_runs_once(client, settings) -> int`.
- Produces: `schedule_verification_retry(conn, execution, reason, now) -> None`.

- [ ] **Step 1: Write verification request and capability tests**

The request contains schema version, Task/Artifact IDs, approved location/content, optional provider resource ID, publication dispatch time, and a bounded search window. It contains no write tool, approval policy body, or mutable natural-language instruction. Verify the Verification Agent has exactly the configured read tool. Accept observed provider data only from that read-tool span output; Agent final prose is never verification evidence.

```python
def test_agent_prose_without_read_tool_evidence_cannot_complete_task(verification_workflow):
    verification_workflow.complete_agent(output={"matched": True}, trace_spans=[])
    verification_workflow.poll()
    assert verification_workflow.task_status != "DONE"
```

- [ ] **Step 2: Write exact completion and failure tests**

```python
def test_exact_live_readback_completes_task_and_unblocks_downstream(verified_readback, db):
    poll_verification_runs_once(verified_readback.client, verified_readback.settings)
    task = db.execute("SELECT * FROM tasks WHERE id = ?", (verified_readback.task_id,)).fetchone()
    downstream = db.execute("SELECT * FROM tasks WHERE task_key = 'after-post'").fetchone()
    assert task["status"] == "DONE"
    assert task_blocker(db, downstream) is None
```

Assert missing/multiple/wrong read-tool spans, drifted tool arguments, location/content/CTA/media/state mismatch, duplicate exact matches, and incomplete search enter `NEEDS_ATTENTION` after retry budget. Assert provider ID mismatch cannot fall back to a different content match. Assert a fabricated Agent final answer with no matching tool output never completes a Task. Evidence JSON stores normalized tool-output fields, timestamps, and read Agent/run/span IDs but no secret/raw headers.

- [ ] **Step 3: Write persisted retry/restart tests**

Use exact delays `[30, 120, 600, 1800, 3600]` seconds. A temporary unavailable read or non-terminal provider state stores `next_attempt_at` and does not create a write attempt. Restart between retries and assert the scheduler resumes from the stored time/count. After five unsuccessful readbacks, transition to `NEEDS_ATTENTION`.

```python
@pytest.mark.parametrize("attempt,delay", enumerate((30, 120, 600, 1800, 3600), start=1))
def test_verification_backoff_is_persisted(attempt, delay, verification_execution, db, now):
    schedule_verification_retry(db, verification_execution(attempt=attempt), "not visible", now)
    row = latest_verification(db)
    assert datetime.fromisoformat(row["next_attempt_at"]) == now + timedelta(seconds=delay)
```

- [ ] **Step 4: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_verification.py -q`

Expected: FAIL because the read-only verification pipeline does not exist.

- [ ] **Step 5: Implement request, dispatch, and exact server comparison**

```python
VERIFY_RETRY_SECONDS = (30, 120, 600, 1800, 3600)


def verification_request(task, artifact, publication):
    return {
        "schema_version": "seo_ops.gbp_post_verify_request.v1",
        "task_id": task["id"],
        "artifact_id": artifact["id"],
        "location_id": artifact["payload"]["location_id"],
        "provider_resource_id": publication["provider_resource_id"],
        "expected_post": artifact["payload"],
        "search_window": {
            "from": publication["dispatch_started_at"],
            "to": now_iso(),
        },
    }
```

The read tool returns observed posts and `search_complete`; load its structured output from the exact trace span, validate its request arguments, parse it as `GbpPostReadbackResult`, and call `match_approved_post()`. On match, update verification execution, Task `VERIFYING -> DONE`, completed time/version, and events in one transaction. Never accept Agent-supplied completion text.

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_verification.py tests/test_task_workflows.py -q`

Expected: PASS.

```bash
git add api/app/task_verification.py api/app/task_orchestrator.py api/app/task_agent_capabilities.py api/tests/test_task_verification.py
git commit -m "feat: verify gbp posts from exact readback"
```

---

### Task 6: Ordered scheduler integration and safe reconcile API

**Files:**
- Modify: `api/app/scheduler.py`
- Modify: `api/app/tasks.py`
- Create: `api/tests/test_gbp_post_workflow.py`
- Modify: `api/tests/test_scheduler.py`
- Modify: `api/tests/test_tasks.py`

**Interfaces:**
- Produces: one scheduler tick that recovers stale work, polls known Runs, then claims bounded new work.
- Produces: `POST /api/tasks/{task_id}/reconcile` with `{expected_version, reason}`.
- Guarantees: reconcile creates/awakens read-only verification only and never creates a publication attempt.

- [ ] **Step 1: Write end-to-end fake-Agent workflow test**

```python
def test_approved_gbp_post_is_published_then_verified_without_another_human_action(workflow):
    workflow.approve_artifact()
    workflow.tick_until_publication_dispatched()
    workflow.complete_publication(provider_resource_id="posts/abc")
    workflow.tick_until_verification_dispatched()
    workflow.complete_verification_with_exact_live_post("posts/abc")
    workflow.tick()

    detail = workflow.get_task()
    assert detail["status"] == "DONE"
    assert detail["current_approval"]["artifact_checksum"] == detail["current_artifact"]["checksum"]
    assert detail["executions"][-1]["stage"] == "VERIFICATION"
```

Add the same flow for an exact automation-policy grant. Assert no human publish/verify endpoint is called after either grant.

- [ ] **Step 2: Write uncertainty and reconcile tests**

Simulate trigger response loss, stale dispatch, Core AI timeout after a write span, mismatched readback, and process restart. In every case count Publishing Agent triggers and assert it remains one. `POST /reconcile` may add one pending Verification execution only when no active verification exists; repeated requests are idempotent and publishing count remains unchanged.

```python
def test_reconcile_is_read_only_and_idempotent(client, attention_task, fake_agents):
    body = {"expected_version": attention_task["version"], "reason": "Read back again"}
    first = client.post(f"/api/tasks/{attention_task['id']}/reconcile", json=body)
    second = client.post(f"/api/tasks/{attention_task['id']}/reconcile", json=body)
    assert first.status_code == 202
    assert second.status_code in {202, 409}
    assert fake_agents.publish_trigger_count == 0
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_gbp_post_workflow.py tests/test_scheduler.py tests/test_tasks.py -q`

Expected: FAIL because scheduler and reconcile API are not wired end to end.

- [ ] **Step 4: Wire a bounded scheduler tick**

Use this order per tick:

```python
recover_stale_seo_dispatches_once()
recover_stale_publication_dispatches_once()
poll_runs_once(client)
poll_task_executions_once(client)       # preparation
poll_publication_runs_once(client, settings)
poll_verification_runs_once(client, settings)
dispatch_verification_once(client, settings)
dispatch_publication_once(client, settings)
if settings.preparation_llm_call_id is not None:
    dispatch_preparation_once(client, settings.preparation_llm_call_id)
```

Each dispatch function handles at most one Task per tick. Keep database-only stale recovery active without Core AI configuration. Skip GBP functions entirely when the feature flag is false.

- [ ] **Step 5: Implement safe reconcile endpoint**

Require Task `VERIFYING` or `NEEDS_ATTENTION`, exact Task version, a historical publication attempt bound to the current Artifact and its original grant, and no active Verification attempt. The grant may since have expired or been revoked because readback is non-mutating; it cannot authorize a new publication. Append `RECONCILIATION_REQUESTED`, insert a pending Verification attempt, and return HTTP 202 with refreshed Task detail. Do not expose an action that moves directly to `EXECUTING`.

```python
@router.post("/tasks/{task_id}/reconcile", status_code=202)
def reconcile_task(task_id: int, body: ReconcileBody, operator=Depends(require_operator), conn=Depends(get_db)):
    return request_read_only_reconciliation(
        conn, task_id=task_id, expected_version=body.expected_version,
        reason=body.reason, operator=operator,
    )
```

- [ ] **Step 6: Run focused and full backend tests, then commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_gbp_post_workflow.py tests/test_scheduler.py tests/test_tasks.py -q`

Run: `cd api && .venv/bin/python -m pytest tests -q`

Expected: PASS.

```bash
git add api/app/scheduler.py api/app/tasks.py api/tests/test_gbp_post_workflow.py api/tests/test_scheduler.py api/tests/test_tasks.py
git commit -m "feat: orchestrate approved gbp post workflows"
```

---

### Task 7: Publishing and verification evidence UI

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/labels.ts`
- Modify: `web/src/pages/TaskDetail.tsx`
- Modify: `web/src/pages/AutomationPolicies.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: complete Task detail with dependencies, Artifact/checksum, grant, stage attempts, provider resource ID, normalized evidence, and attention reason.
- Produces: automatic post-approval progress with no manual publish or complete button.

- [ ] **Step 1: Write UI workflow tests**

After Artifact approval, assert the page displays `发布中`; after publication readback, `验证中`; after exact provider readback, `已完成`. Assert the UI never renders `立即发布`, `标记完成`, or a second approval during execution. Policy-approved Tasks show policy key/version and the same stage trail. A not-yet-claimed `PENDING` publication attempt may show `撤销本次授权`; after claim begins the action disappears and policy changes are described as affecting future Tasks only. On the policy page, `启用托管` appears only when the backend reports complete GBP Post configuration and sends the current policy version to the activation endpoint.

```typescript
expect(await screen.findByText('发布中')).toBeTruthy()
expect(screen.queryByRole('button', { name: '立即发布' })).toBeNull()
expect(screen.queryByRole('button', { name: '标记完成' })).toBeNull()
```

- [ ] **Step 2: Write attention/reconcile tests**

For uncertain publication, show `正在安全回查，系统不会重复发布`. For mismatch/inconclusive terminal state, show `需要人工处理`, provider/resource evidence, and one `重新回读验证` action. Clicking it sends Task version/reason, handles HTTP 202, refreshes from response, and does not call any publish endpoint.

```typescript
fireEvent.click(screen.getByRole('button', { name: '重新回读验证' }))
await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
  '/api/tasks/42/reconcile', expect.objectContaining({ method: 'POST' }),
))
expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/publish'))).toBe(false)
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because Task detail lacks publication/verification evidence.

- [ ] **Step 4: Add exact execution/evidence types**

```typescript
export type TaskExecutionStage = 'PREPARATION' | 'PUBLICATION' | 'VERIFICATION'
export type TaskExecutionStatus = 'PENDING' | 'DISPATCHING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' | 'CANCELLED'

export type TaskExecution = {
  id: number
  stage: TaskExecutionStage
  status: TaskExecutionStatus
  attempt: number
  request_checksum: string | null
  idempotency_key: string | null
  provider_resource_id: string | null
  evidence: Record<string, unknown> | null
  error: string | null
  created_at: string
  finished_at: string | null
}
```

Add `reconcileTask(id, {expected_version, reason})`, `revokeTaskApproval(id, {expected_version, reason})`, and `activateAutomationPolicy(policyKey, {expected_version})`. Do not expose raw request JSON, credentials, or provider headers in the frontend type.

- [ ] **Step 5: Render one fixed stage trail and evidence disclosure**

Show Preparation, Approval, Publication, and Verification in template order. Completed stages display time; current stage uses the status label; future stages are quiet. Put checksums, Agent/run IDs, idempotency key prefix, provider resource ID, and normalized readback inside a collapsed technical-evidence section.

```tsx
const stages = ['PREPARATION', 'APPROVAL', 'PUBLICATION', 'VERIFICATION'] as const
return <ol className="task-stage-trail">{stages.map(stage => (
  <li key={stage} data-state={stageState(task, stage)}>{STAGE_LABELS[stage]}</li>
))}</ol>
```

- [ ] **Step 6: Run frontend gates and commit**

Run: `cd web && npm test`

Run: `cd web && npm run lint`

Run: `cd web && npm run build`

Expected: all commands exit 0.

```bash
git add web/src/api.ts web/src/labels.ts web/src/pages/TaskDetail.tsx web/src/pages/AutomationPolicies.tsx web/src/App.test.tsx web/src/index.css
git commit -m "feat: show gbp publication verification evidence"
```

---

### Task 8: Feature-flagged rollout, real readback gate, and final verification

**Files:**
- Modify: `api/.env.example`
- Modify: `README.md`
- Create: `docs/runbooks/gbp-post-workflow.md`
- Modify only previously listed Phase-3 files if verification exposes a scoped defect.

**Interfaces:**
- Produces: a disabled-by-default production configuration and an operator recovery runbook.

- [ ] **Step 1: Document exact configuration without secrets**

Add these names with empty values and `SEO_OPS_GBP_POST_ENABLED=false`:

```dotenv
SEO_OPS_GBP_POST_ENABLED=false
COREAI_GBP_POST_PUBLISH_AGENT_ID=
COREAI_GBP_POST_VERIFY_AGENT_ID=
COREAI_GBP_POST_PUBLISH_TOOL_ID=
COREAI_GBP_POST_READ_TOOL_ID=
```

Document that enablement requires two separately published Agents whose capability snapshots exactly match their configured tool IDs.

- [ ] **Step 2: Write the recovery and rollout runbook**

Cover: feature disable, stale/unknown publication, verification retry timing, safe reconcile, mismatch handling, policy pause/revoke, compensating Task creation, and the prohibition on blind re-publication. Include SQL readbacks for Task state, current artifact/grant, all publication/verification attempts, and event order.

- [ ] **Step 3: Run all offline quality gates with the flag disabled and enabled**

Run twice, first without the flag and then with fake Agent/tool settings:

Run: `cd api && .venv/bin/python -m pytest tests -q`

Run: `cd web && npm test`

Run: `cd web && npm run lint`

Run: `cd web && npm run build`

Run: `git diff --check`

Expected: every command exits 0; the disabled run performs zero GBP publishing/verification calls.

- [ ] **Step 4: Perform one authorized test-account canary**

Only after explicit canary/deployment authorization, use a non-production GBP test location and one human-approved Artifact. Before enabling, record the exact Task ID, Artifact checksum, grant ID, location ID, Publishing/Verification Agent IDs, tool IDs, and feature configuration. Enable one worker, wait for terminal workflow state, then read back the provider resource through the independent Verification Agent and compare normalized content to the approved Artifact.

Stop the canary immediately if the dispatch becomes unknown, the tool trace is missing, more than one publication invocation appears, or the readback is not an exact match. Preserve the Task, attempts, events, Core AI trace IDs, and provider resource ID as evidence; do not retry publication manually.

- [ ] **Step 5: Verify completion evidence and downstream unlock**

Require all of the following before declaring the canary successful: one unrevoked grant bound to the Artifact checksum, exactly one Publishing tool invocation, one provider resource ID, a normalized LIVE readback exact match, Task `DONE`, and the next dependent Task reported `READY`. A 200 response or completed Core AI Run alone fails this gate.

- [ ] **Step 6: Commit Phase 3 documentation**

```bash
git add api/.env.example README.md docs/runbooks/gbp-post-workflow.md
git commit -m "docs: add gbp post workflow rollout runbook"
```

Keep `SEO_OPS_GBP_POST_ENABLED=false` in shared environments until the canary evidence is reviewed and a separate deployment decision explicitly enables it.

# Audit Phase 2 Manual Execution and Read API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an authenticated operator create and follow a location-level Audit Run that safely dispatches to the dedicated Core AI Audit Agent, validates provenance/output, accepts exactly one immutable Version, and exposes operator-safe read APIs.

**Architecture:** Build a local-only preflight manifest first, then persist a queued business Run before any network call. A dedicated worker claims fenced Attempts, writes an irreversible dispatch barrier, calls Core AI outside the transaction, and either stores a unique acknowledgement or isolates the Attempt as unknown. Polling and validation read back Core AI Run/Trace/Skill provenance before calling the Phase 1 atomic acceptance function. Separate read routers expose consistent overview/history/compare DTOs and server-calculated capability reasons.

**Tech Stack:** FastAPI, Pydantic v2, Python `sqlite3`, httpx, pytest, existing Core AI REST client.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Complete Phase 1 and keep its hash/identity/immutability tests green.
- Use `COREAI_AUDIT_AGENT_ID`; do not send Audit v2 through `COREAI_AGENT_ID`, generic `runs.py`, `scheduler.py`, or the legacy keyword→Audit Artifact chain.
- Manual POST performs only local reads/writes and returns promptly. Core AI calls happen only in the worker after commit.
- A queued Run always has a non-empty, hash-verified frozen manifest; there is no dispatchable “preflight pending” state.
- The `dispatch_started_at` barrier is written before the trigger request. If the outcome is ambiguous and remote idempotent readback is not proven, transition to `unknown` and never resend.
- Provenance comes from Core AI Run/Trace readback. The Agent payload cannot self-attest Agent or Skill identity.
- Keep raw payloads, validation dumps, Trace bodies, access tokens, and signed URLs out of operator API responses and logs.
- Do not add automatic scheduling or automatic Attempt retry in this phase. A failed/blocked manual Run is retried only through a new explicit Run.

---

## Task 1: Verify and encode the Core AI Audit protocol boundary

**Files:**

- Modify: `api/app/config.py`
- Modify: `api/app/coreai.py`
- Modify: `api/.env.example`
- Modify: `api/tests/test_config.py`
- Modify: `api/tests/test_coreai.py`
- Create: `docs/evidence/audit-coreai-uat-protocol-2026-09-03.md`

**Configuration:**

```python
@dataclass(frozen=True)
class AuditSettings:
    coreai_base_url: str
    coreai_api_key: str
    audit_agent_id: str
    required_skill_ids: tuple[str, ...]
    request_schema_version: str
    worker_poll_seconds: float
    attempt_lease_seconds: int
    validation_timeout_seconds: int
    remote_idempotency_mode: Literal["verified", "at-most-once"]
```

Environment keys are `COREAI_BASE_URL`, `COREAI_API_KEY`, `COREAI_AUDIT_AGENT_ID`, comma-separated `COREAI_AUDIT_REQUIRED_SKILL_IDS`, `COREAI_AUDIT_REQUEST_SCHEMA_VERSION=seo_ops.audit_request.v2`, `AUDIT_WORKER_POLL_SECONDS=2`, `AUDIT_ATTEMPT_LEASE_SECONDS=60`, `AUDIT_VALIDATION_TIMEOUT_SECONDS=300`, and `COREAI_AUDIT_IDEMPOTENCY_MODE=at-most-once`. `audit_settings()` does not require the generic `COREAI_AGENT_ID`.

- [ ] Add config tests for missing Audit-specific settings, whitespace normalization, Skill ID parsing/deduplication, invalid modes, and the default `at-most-once` safety mode.
- [ ] Use the restored `ktctl connect` route to inspect actual UAT OpenAPI/endpoint responses for trigger headers/body, returned run identity, lookup by correlation/idempotency key, terminal result fields, Trace spans, Agent identity, Skill identity, and attachment listing/downloading. Do not send a paid or production-impacting Audit merely to probe schema; use an existing safe test Agent/run or provider documentation exposed by UAT.
- [ ] Record exact redacted request/response field names, endpoint paths, HTTP statuses, and the observed negative case in `docs/evidence/audit-coreai-uat-protocol-2026-09-03.md`. Do not record API keys, tokens, full business inputs, or SAS query strings.
- [ ] Add `httpx.MockTransport` tests for the observed contract. Introduce dedicated methods without changing existing callers:

```python
def trigger_audit(self, *, agent_id: str, input_text: str,
                  idempotency_key: str, correlation_id: str) -> AuditDispatchAck: ...
def find_audit_run(self, *, idempotency_key: str,
                   correlation_id: str) -> AuditDispatchLookup: ...
def get_audit_provenance(self, *, run_id: str) -> AuditProvenanceReadback: ...
def list_audit_attachments(self, *, run_id: str) -> list[AuditAttachmentRef]: ...
def download_audit_attachment(self, *, run_id: str,
                              attachment_id: str,
                              max_bytes: int) -> AuditAttachmentDownload: ...
```

- [ ] If UAT proves that a repeated key returns and can read back exactly one remote Run, encode that path and allow `remote_idempotency_mode="verified"`. If any part is absent or ambiguous, `find_audit_run` returns an explicit unsupported result and the only allowed runtime mode remains `at-most-once`.
- [ ] Make attachment methods return an explicit unsupported capability until their actual list/download contract is proven; never parse arbitrary URLs from model text.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_config.py tests/test_coreai.py -q
```

- [ ] Commit protocol code and redacted evidence as `feat: define core ai audit protocol boundary` when green.

## Task 2: Freeze the local Audit input manifest

**Files:**

- Create: `api/app/audit_manifest.py`
- Create: `api/tests/test_audit_manifest.py`
- Modify: `api/tests/helpers.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class AuditPreflightResult:
    status: Literal["ready", "blocked"]
    manifest: FrozenAuditManifest
    manifest_sha256: str
    blocker_code: str | None
    blocker_summary: str | None

def build_audit_preflight(conn: sqlite3.Connection, *, subject_id: str,
                          rubric_version: str,
                          frozen_at: str) -> AuditPreflightResult: ...

def build_audit_agent_input(*, manifest: FrozenAuditManifest) -> str: ...
```

- [ ] Add fixtures for exact ready identity, no website, optional missing/stale source, hard-stale required source, unbound identity, source identity mismatch, ready internal Asset, and non-ready required Asset.
- [ ] Build only from persisted Location Registry, GBP/FBR snapshots, the frozen Subject `website_url` presence/absence fact, locally active keyword Version when the rubric names it, ready Assets, and immutable rubric. The initial rubric has no page-crawl source, so page-content Criteria are explicitly unavailable. Do not call FBR, GBP, Local Falcon, website crawling, or Core AI.
- [ ] Give every evidence item a random opaque handle and freeze subject binding, safe internal source reference, captured time, source/Asset hash, readiness, and allowed locator range. The Agent input receives the handle and required content only.
- [ ] Include exact expected Criterion IDs, Audit Agent ID, required Skill IDs, request schema, configured size-limit version, source freshness results, unavailable sources, Subject generation/hash, and Rubric version/hash.
- [ ] Return a terminal blocker for unbound/mismatched identity or missing required source; allow optional missing/soft-stale sources while preserving them for coverage/limitations.
- [ ] Verify JCS hash on every read and before Run insertion. Redact URL queries and reject any manifest value containing an Authorization header, cookie, or signed query.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_manifest.py -q
```

- [ ] Commit as `feat: freeze local audit evidence manifests` when green.

## Task 3: Add manual Run, retry, event, reconcile, abandon, and policy-read APIs

**Files:**

- Create: `api/app/audit_runs.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_runs.py`

**Endpoints and exact semantics:**

- `POST /api/audit-subjects/{subject_id}/runs` with `{ "request_id": "<uuid>" }` returns 201 for a new queued/blocked Run and 200 for an identical replay.
- `GET /api/audit-runs/{run_id}` returns status/times, current Attempt summary, retry relation, safe error, and `poll_after_ms`; it returns `2000` only for `queued|dispatching|running|validating`, otherwise `null`.
- `GET /api/audit-runs/{run_id}/events?cursor=&limit=` returns stable `(occurred_at,id)` cursor pagination and safe event payloads.
- `POST /api/audit-runs/{run_id}/retry` with a new request ID creates a new Run linked by `retry_of_run_id` only from terminal blocked/failed.
- `POST /api/audit-runs/{run_id}/reconcile` accepts only `unknown` and reuses the original dispatch key/correlation.
- `POST /api/audit-runs/{run_id}/abandon` requires `{ "request_id": "<uuid>", "reason": "..." }`, at least one inconclusive reconciliation event, and current `unknown` state.

All errors use:

```json
{"detail":{"code":"AUDIT_ALREADY_RUNNING","message":"该门店已有正在进行的 Audit。","context":{"active_run_id":"..."}}}
```

- [ ] Write failing API tests for auth, nonexistent/cross-merchant/archived/unbound Subject, queued and blocked creation, replay, request-ID payload conflict, one active Run, active `unknown`, event pagination, explicit retry, reconciliation guard, abandonment guard, and safe structured errors.
- [ ] In one short `BEGIN IMMEDIATE` transaction, re-read Subject and location generation, run local preflight, then create either a complete queued Run or an auditable blocked Run/event. Return after commit without calling Core AI.
- [ ] Derive global `run_key` and `request_id` UUID identities separately. The uniqueness boundary is `(audit_subject_id, request_id)`; replay compares the canonical request hash before returning the old Run.
- [ ] Generate `dispatch_idempotency_key = SHA256("seo-ops:audit:" + run_key + ":" + attempt_number + ":" + input_manifest_sha256)` only when the worker creates an Attempt.
- [ ] Reconcile through `find_audit_run` only. A unique proven remote Run advances to running; a proven absent run makes manual Attempt/Run failed; unsupported or ambiguous lookup keeps `unknown`.
- [ ] Register the router in `main.py` under existing operator authentication.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_runs.py tests/test_audit_manifest.py -q
```

- [ ] Commit as `feat: add manual audit run api` when green.

## Task 4: Dispatch Attempts with fencing and at-most-once recovery

**Files:**

- Create: `api/app/audit_worker.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_worker.py`

**Interfaces:**

```python
def dispatch_audit_runs_once(*, now: str, worker_id: str,
                             client: CoreAiClient | None = None) -> int: ...
def poll_audit_runs_once(*, now: str, worker_id: str,
                         client: CoreAiClient | None = None) -> int: ...
def recover_stale_audit_attempts_once(*, now: str, worker_id: str,
                                      client: CoreAiClient | None = None) -> int: ...
async def audit_worker_loop() -> None: ...
```

Repository lease operations are explicit:

```python
def claim_audit_attempt(conn: sqlite3.Connection, *, worker_id: str,
                        now: str, lease_seconds: int) -> ClaimedAuditAttempt | None: ...
def renew_audit_attempt_lease(conn: sqlite3.Connection, *, attempt_id: str,
                              worker_id: str, lease_generation: int,
                              now: str, lease_seconds: int) -> bool: ...
```

- [ ] Add two-connection tests proving one worker claims a queued Run, creates one current Attempt, renews without changing ownership/generation, increments generation on takeover, and prevents a stale worker from writing the dispatch barrier, acknowledgement, state, or acceptance.
- [ ] Add tests for success acknowledgement, local failure before the barrier, UAT-proven remote rejection-without-creation, generic HTTP/transport error after the barrier, timeout after `dispatch_started_at`, process death before barrier, process death after barrier, expired lease with verified idempotency, and expired lease under at-most-once mode.
- [ ] Claim in a short transaction and commit. In a second short transaction, CAS-write `dispatch_started_at` with the current lease generation. Only then call `trigger_audit` outside the transaction.
- [ ] Renew immediately before every trigger/poll/provenance network call and require the provider timeout to be shorter than the verified remaining lease. If renewal fails, make no network call and let the new lease owner continue.
- [ ] On clear acknowledgement, save unique `coreai_run_id`, `acknowledged_at`, and running event under the same lease-generation fence.
- [ ] Complete all local serialization/configuration validation before writing the barrier. A local failure before the barrier may fail the Attempt/Run. After the barrier, only an acknowledgement or an exact UAT-proven provider response that guarantees no Run was created may become a known outcome; every generic HTTP, timeout, connection, parse, cancellation, or process failure becomes `unknown`, retains the subject lock, and writes a safe correlation event.
- [ ] Recovery may trigger only when `dispatch_started_at IS NULL`. When non-null and unacknowledged, replay with the same key only in verified mode; otherwise transition to unknown without another trigger.
- [ ] Register one `audit_worker_loop()` task in FastAPI lifespan. Cancellation must close cleanly and must not change terminal or unknown state.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_worker.py tests/test_audit_runs.py -q
```

- [ ] Commit as `feat: dispatch fenced audit attempts` when green.

## Task 5: Poll, validate provenance, and atomically accept native v2

**Files:**

- Modify: `api/app/audit_worker.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/tests/test_audit_worker.py`
- Modify: `api/tests/helpers.py`

- [ ] Add worker tests for remote queued/running, remote failed, valid terminal result, invalid JSON, schema errors summarized by field path, Agent mismatch, missing/unexpected Skill calls, unavailable Trace before deadline, provenance timeout, score mismatch, source-handle mismatch, subject changed during Run, and duplicate poll after success.
- [ ] Poll the acknowledged `coreai_run_id` outside a write transaction. Store only safe state/timestamps/events until terminal output exists.
- [ ] On terminal completion, place Run/Attempt in `validating`, read back Agent and exact required Skill IDs from Trace, and retry provenance readback only until the configured validation deadline. Do not trust output text fields for provenance.
- [ ] Hash and record the bounded producer response before parsing; on failure preserve only byte count/hash plus safe validation detail. Parse producer output with `parse_producer_result`, verify the frozen manifest hash, resolve Evidence handles, build the canonical report, and call `accept_audit_version` with the current lease generation.
- [ ] Map validation failures to stable codes such as `AUDIT_OUTPUT_NOT_JSON`, `AUDIT_OUTPUT_SCHEMA_INVALID`, `AUDIT_SCORE_MISMATCH`, `AUDIT_PROVENANCE_UNVERIFIED`, and `AUDIT_SUBJECT_CHANGED_DURING_RUN`; store a short summary and bounded field paths, never the full Pydantic dump.
- [ ] `accept_audit_version` performs its first readback before commit. After commit, immediately call `verify_audit_version_readback` using a fresh connection before the worker reports completion in logs. A failed post-commit readback records a critical safe event and every read API fails closed for that Version.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_worker.py tests/test_audit_repository.py tests/test_audit_contracts.py tests/test_audit_rubric.py -q
```

- [ ] Commit as `feat: validate and accept audit runs` when green.

## Task 6: Expose Subject overview, Version history/detail, compare, Evidence, and alerts

**Files:**

- Create: `api/app/audit_versions.py`
- Create: `api/app/audit_presentation.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_versions.py`

**Endpoints:**

- `GET /api/merchants/{merchant_id}/audit-subjects`
- `GET /api/audit-subjects/{subject_id}/overview`
- `GET /api/audit-subjects/{subject_id}/versions?cursor=&limit=`
- `GET /api/audit-versions/{version_id}`
- `GET /api/audit-versions/{version_id}/compare?base_version_id=`
- `GET /api/audit-versions/{version_id}/assets`
- `GET /api/audit-change-alerts?merchant_id=&status=&cursor=&limit=`
- `POST /api/audit-change-alerts/{alert_id}/read`

**Capability DTO:**

```json
{
  "compare":{"enabled":true,"reason_code":null},
  "export_pdf":{"enabled":false,"reason_code":"AUDIT_EXPORT_RUNTIME_UNAVAILABLE"},
  "export_html":{"enabled":false,"reason_code":"AUDIT_EXPORT_NOT_INSTALLED"},
  "export_json":{"enabled":false,"reason_code":"AUDIT_EXPORT_NOT_INSTALLED"},
  "plan_draft":{"enabled":false,"reason_code":"AUDIT_PLAN_SERVICE_UNVERIFIED"}
}
```

- [ ] Add tests for current-generation latest-success semantics, active+latest coexistence, never-success states, scored/incomplete/unscored legacy summaries, generation-changed history, deterministic cursor pagination, cross-merchant access, safe capabilities, and alert read idempotency.
- [ ] Include both `active_run` and `latest_terminal_run` in Subject summary/Overview. The latter returns the newest blocked/failed/succeeded/abandoned Run with safe error, recent-event summary, and allowed retry/reconcile actions, so a Subject with no accepted Version still has a discoverable operational state.
- [ ] Compute merchant shared-risk deduplication by `(scope_type, scope_key, criterion_id)` without inventing a merchant total score.
- [ ] Build each Subject overview from one SQLite read transaction so Subject generation, policy, active Run, current head, verified Version, and capabilities describe one consistent database snapshot.
- [ ] Return a discriminated Version DTO: canonical v2 for native/fully adapted rows; typed untouched legacy envelope for unscored legacy. Do not emit null KPI fields that the UI could mistake for zero.
- [ ] Compare only same-generation compatible canonical Versions with equal rubric hash, scoring algorithm, and Criterion ID set. When no explicit base is provided, use the target's frozen `comparison_base_version_id`; never search again at read time.
- [ ] Return added, persistent, resolved, score changes, and `not_comparable` reason codes. Read and verify immutable Version projection before returning it.
- [ ] Register the router and run:

```bash
.venv/bin/python -m pytest tests/test_audit_versions.py tests/test_audit_runs.py -q
.venv/bin/python -m pytest -q
```

- [ ] Commit as `feat: expose audit versions and comparison` after the full backend suite passes.

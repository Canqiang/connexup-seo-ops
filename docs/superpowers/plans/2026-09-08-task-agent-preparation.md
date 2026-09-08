# Assigned Agent Preparation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, following the user's preference. Steps use checkbox tracking.

**Goal:** Manually start the assigned dedicated Agent, persist its run, validate its draft and require AM approval.

**Architecture:** New strict COREAI_AGENT_PREPARATION_V1 request protocol, separate service, existing task lifecycle and scheduler. Existing LLM Call requests and historical untrusted Agent records retain their rules.

**Tech Stack:** SQLite, FastAPI, Python, React/TypeScript; no new dependencies.

**Spec:** docs/superpowers/specs/2026-09-08-task-agent-preparation-design.md (approved dedicated-Agent convention).

## Global Constraints

- Work only in codex/task-agent-preparation. No real merchant database/config writes, publication, paid scans or main merge. User subsequently authorized exactly one real UAT run with isolated synthetic data; this allowance has been consumed successfully, not a standing authorization for additional runs.
- Current authenticated operator is AM; assignment does not trigger execution.
- No tools/skills/subagents/sandbox/datasets/memory. Configuration drift blocks; this is not remote version pinning.
- Explicit server JSON map SEO_OPS_TASK_AGENT_BINDINGS keyed by local Agent ID contains coreai_agent_id and config_sha256; absent/invalid map blocks Agent dispatch.

## Task 1 — strict protocol and manual dispatch

Files: create api/app/task_agent_protocol.py, api/app/task_agent_preparation.py, api/tests/test_task_agent_preparation.py; modify api/app/tasks.py and api/tests/conftest.py.

Interfaces: agent_snapshot(detail, expected_id) -> dict; digest(value) -> str; binding_for_task(conn, task_id) -> dict | None; validate_agent_request(execution, task=None) -> dict; start_agent_preparation(conn, task_id, expected_version, operator, client) -> dict.

- [x] Add real API tests using a fake Core AI network boundary, temporary SQLite and current AM session. Core success assertion: `assert response.json()['status'] == 'RUNNING'`; then read DB request and verify local/remote identity and exactly one captured trigger.
- [x] Run new tests before implementation; expect existing AGENT blocker, not a fixture error.
- [x] Implement strict canonical request, identity/hash checks and no-tool snapshot validation. Capture allowed binding and verified config before claiming; recheck binding/task/merchant inside BEGIN IMMEDIATE. Save DISPATCHING and PREPARING before one trigger. Persist exact run ID under token/Task/lifecycle fence; duplicate remote ID or uncertain response becomes UNKNOWN without retry.
- [x] Select Agent dependency without requiring LLM Call configuration. Old path unchanged. Example branch: `if owner and owner['assignee_type'] == 'AGENT': return start_agent_preparation(...)`.
- [x] Test bad bindings, missing capabilities, drift, concurrent/stale Task, duplicate trigger/run ID and unknown dispatch. Run API regression.

## Task 2 — polling and approval

Files: modify api/app/task_agent_preparation.py, api/app/tasks.py, api/app/scheduler.py; extend api/tests/test_task_agent_preparation.py.

Interfaces: poll_agent_preparation(conn, execution, client) -> None; is_agent_request(execution) -> bool. Reuse normalized result and existing review checksum.

- [x] Test `poll_task_executions_once(fake)` produces AWAITING_APPROVAL then `approve-execution` produces DONE; before implementation expect historical UNKNOWN path. Test invalid result/identity and duplicate completion.
- [x] Route only new protocol to new polling service. Require exact run ID, Agent ID, input and unchanged Agent config; COMPLETED alone insufficient. Apply result under the original token, task definition/version and merchant lifecycle checks. Failed/unknown requests remain distinguishable; no automatic trigger retry.
- [x] Extend stale DISPATCHING recovery to validate both new and old envelopes. Keep UNKNOWN Agent requests non-retryable. Review new Agent envelope separately and retain old run-ID rejection for LLM history.
- [x] Verify invalid/mutated evidence cannot be approved; state races and archived merchants cannot be revived. Run targeted and full API tests.

## Task 3 — presentation and handoff

Files: web/src/api.ts, web/src/components/TaskAssignment.tsx and tests, web/src/pages/TaskDetail.tsx, README.md, api/.env.example.

- [x] Test that configured Agent owner no longer claims execution is unavailable; show explicit blocker when absent. Pass readiness into owner display; preserve optional compatibility for old fixtures.
- [x] Expose execution Agent identity/run ID through existing execution details, with no fake progress. Add configuration example without changing actual .env. Example map: `{"local-agent-id":{"coreai_agent_id":"remote-agent-id","config_sha256":"<actual canonical snapshot sha256>"}}`; docs explain generating the exact hash and no in-place edits.
- [x] Run frontend tests, lint/build, full API regression and git diff --check; inspect rendered isolated fixture. Record exact counts and no UAT runtime proof.
- [x] Keep branch until user selects merge; no unrelated commits.

## Local verification readback — 2026-09-08 (before real UAT)

- Full API: **1366 passed**, 8 dependency/process deprecation warnings.
- Dedicated Agent API cases after the concurrency test: **29 passed**. Includes two simultaneous preflight requests with exactly one trigger/one persisted execution, repeat-start rejection, preflight Task version change, duplicate remote ID, timeout UNKNOWN, missing/unsafe capabilities, exact identity/config, evidence tampering, connection-only scheduler and merchant lifecycle race.
- Full frontend: **395 passed**; lint and production build exit 0. Existing >500 kB bundle warning remains.
- Inline review: fixed scheduler dependence on diagnosis settings, preserved per-protocol stale-dispatch messages and exact merchant lifecycle recovery fence. Existing LLM Call tests pass.
- Local browser gate passed using production build, real API and temporary SQLite with fake Agent. Verified start, completion, AM approval, persistent DONE readback and UNKNOWN guard. Fixed stale notices, reviewed-history presentation and readiness/status confusion. Details: `docs/agents/task-preparation-local-acceptance-2026-09-08.md`. Real UAT acceptance remains separate. The concurrency test uses two threads; process-crash stress is not claimed.
- No real configuration/registry/database changes, remote run, main merge, commit or push. Main user-owned dirty docs unchanged.
- Setup and next isolated UAT acceptance steps: `docs/agents/task-preparation-binding.md`. Local test completion is not remote end-to-end proof.

## Subsequent real UAT acceptance

- [x] One authorized run against the dedicated Agent, using temporary SQLite and synthetic merchant/task only.
- [x] Independently match remote run/Agent/input and unchanged configuration; validate structured draft, then test-AM approval and independent read-only database terminal state.
- Run `ff38cbf5-1a23-440a-9e87-7d35adfbc1cd`: COMPLETED; isolated Task 1: DONE, version 5; execution 1: SUCCEEDED, attempt 1.
- Evidence: `docs/agents/task-preparation-uat-acceptance-2026-09-08.md`. No main instance configuration or data changed. Merge and real instance enablement remain separate user decisions.

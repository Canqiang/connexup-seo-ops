# SEO Ops Agent Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an operator-only Agent 工作台 that truthfully makes all explicitly registered SEO Ops Agents feel active and observable by showing current Run state, execution history, Token coverage, synchronization freshness, and lifecycle management for an arbitrary number of Agents.

**Architecture:** Keep Core AI read-only and project its bounded Agent-run list responses into three durable SQLite tables. A dedicated fenced background loop performs 30-second discovery, 5-second confirmation for fresh queued/running work, and low-frequency archival reconciliation; the browser reads only one coherent local snapshot and follows the server-provided 5/30-second cadence without overlapping requests. The React page separates factual state from visual motion: deep navy is the Execution Signal stage, bright teal is reserved for fresh verified RUNNING only, and every stale, paused, terminal, disabled, retired, or uncertain state is static.

**Tech Stack:** Python 3.13, FastAPI 0.141, Pydantic 2.13, SQLite, httpx 0.28, pytest 9, React 19, TypeScript 6, React Router 7, Vitest 4, Testing Library, scoped CSS.

**Spec:** docs/superpowers/specs/2026-09-03-agent-workbench-design.md

## Global Constraints

- Modify only /Users/xander/git_repo/connexup-seo-ops. Core AI under /Users/xander/git_repo/core-ai is contract evidence only and must remain untouched.
- This plan and its confirmed design spec must already be present in narrow commits before execution. From the owner-approved integrated checkout, set `AW_BASE_COMMIT="$(git rev-parse HEAD)"`, then require `git cat-file -e "$AW_BASE_COMMIT":docs/superpowers/plans/2026-09-03-agent-workbench.md` and the analogous exact spec path before creating the worktree. Before Task 1, let the owners of the current Local Falcon, Performance Dashboard, merchant-lifecycle, and task-plan changes commit their intended work. Then create an isolated worktree from that exact integrated commit with superpowers:using-git-worktrees. If either document is absent from that commit or those feature changes are still uncommitted, stop and coordinate; never reset, copy over, format, or stage the dirty checkout wholesale.
- Apply narrow patches to existing high-conflict files. Before every commit inspect git diff --cached --name-only and git diff --cached; stage only the exact paths named by that task.
- Run every command block from the isolated worktree, regardless of the caller's current subdirectory: start with `cd "$(git rev-parse --show-toplevel)"`, use `(cd api && ...)` or `(cd web && ...)` for subproject commands, and return to the worktree root before every Git command. Use only non-interactive `git add -- <exact paths>`; because each task begins from the preceding clean task commit, never use `git add -p`, globs, or `git add .`.
- Preserve the existing scheduler's 30-second cadence. Agent Workbench gets an independent loop; it must not accelerate unrelated scheduler jobs.
- Read Core AI state only through GET /api/agents/{agent_id} and GET /api/runs/agent/{agent_id}/list. Workbench code and tests must never call GET /api/runs/{run_id}.
- Register only explicit SEO Ops Agents. Configuration slots seed the registry but are not a fixed Agent count; arbitrary additional Agents are supported without code or environment changes.
- Persist only narrow run summaries. Never store or log Core AI input, output, transcript, artifacts, error stack, API keys, or authorization headers.
- Persist every supplied Core AI status verbatim. `raw_status=NULL` is reserved only for a source-associated accepted Run ID whose trigger response supplied no status and no valid list row has confirmed it; it blocks idle and never gains motion. Unknown non-empty statuses remain unknown, block exact-idle claims, and never gain motion. Terminal status never regresses; conflicting terminal values remain visible as a warning.
- Token values are nullable. Accept them only when both input and output are integral and non-negative; missing or invalid data is unknown, never zero-filled.
- No Agent hard-delete endpoint. Disable and retire preserve history; replacement is an atomic retire-and-create operation.
- Only a fresh, non-suspect RUNNING signal on an active registry record with a complete current-state proof may pulse or move. PENDING, PAUSED, terminal, stale, uncertain, disabled, and retired states are static.
- Browser timing can only downgrade server claims. It may stop motion, expire a receipt, or replace current wording with timestamped snapshot wording; it must not invent a transition or restore freshness.
- Use no new runtime or test dependencies. Work within the installed FastAPI/httpx/pytest and React/Vitest/Testing Library stack.
- Load superpowers:test-driven-development before Task 1 and keep every RED command genuinely failing for the stated missing behavior. Load superpowers:verification-before-completion before Task 11.
- Treat each checkbox as one 2-5 minute executable feedback slice. Test-writing and production implementation are separate checkboxes; distinct production branches are separate slices. A small table-driven set of scalar examples may share one test-writing checkbox only when every row exercises the same implementation branch, and a GREEN characterization may extend an already implemented branch. Never batch an entire helper, multiple behaviors, or RED-to-GREEN implementation behind one checkbox.
- Every command block is fail-fast: after the root-first `cd`, run `set -e` and `set -o pipefail` before any gate, staging, or commit command. A non-zero command stops the block; never check a box, stage, or commit after a failed command. Each TDD checkbox carries a complete copy-pasteable `Exact feedback command` on the same line; narrative references to that literal command are not placeholders. There are no bare `run -k NAME` or `<...>` commands.
- Use timezone-aware UTC strings in persistence and transport. Calendar ranges are computed by the API in SEO_OPS_OPERATOR_TIMEZONE, default Asia/Shanghai.
- All routes use the existing operator authentication dependency. The browser never calls Core AI directly.

## File and Responsibility Map

- api/app/config.py: credentials-only Core AI connection settings, validated Workbench timezone/history settings, and the six bootstrap Agent slots.
- api/.env.example: documents SEO_OPS_OPERATOR_TIMEZONE and SEO_OPS_AGENT_HISTORY_LIMIT.
- api/schema.sql: seo_ops_agents, seo_ops_agent_runs, seo_ops_agent_sync_state, constraints, and lookup/due-time indexes.
- api/app/coreai.py: optional query parameters plus the bounded, narrow Agent-run list adapter; existing trigger/detail/skill/trace behavior stays compatible.
- api/app/agent_workbench.py: mutation DTOs, metadata verification, registry lifecycle, projection and association logic, range/coverage/Token/current-state aggregation, history cursors, operator router, adaptive synchronization, lease fencing, and best-effort local registration.
- api/app/main.py: zero-I/O application construction plus writable lifespan initialization, local registry seed, operator router, independent Agent sync task, and awaited shutdown of all three background loops: the existing scheduler, existing Local Falcon scheduler, and Agent Workbench.
- api/app/runs.py, api/app/tasks.py, api/app/seo_targets.py: four narrow post-commit calls that register accepted local Core AI Runs without changing existing dispatch semantics.
- api/tests/test_config.py, api/tests/test_db.py, api/tests/test_coreai.py: configuration, additive schema, and true Core AI HTTP contract.
- api/tests/test_agent_workbench.py: registry, projection, association, receipts, aggregate, history, and authentication behavior.
- api/tests/test_agent_workbench_sync.py: cadence, list-proof quality, degraded state, metadata retry, and fenced leases.
- api/tests/test_agent_workbench_triggers.py: all four local trigger hooks, including projection-failure isolation.
- api/tests/test_agent_workbench_acceptance.py: full registered-Agent/list/projection/readback truth path.
- api/tests/agent_workbench_live_app.py: loopback-only acceptance app built from the real router/auth/DB factory, with both existing ordinary schedulers replaced by independent cancellation-aware parked tasks.
- api/tests/agent_workbench_live_readback.py: sanitized read-only reconciliation of configured Core AI list state, SQLite projection, and authenticated aggregate.
- api/tests/agent_workbench_visual_fixture.py: guarded disposable active/idle/partial/stale databases for real-browser acceptance only.
- api/tests/test_main.py: all three lifespan tasks start independently, cancel, and are awaited.
- web/src/api.ts: exact Workbench, history, registry mutation, warning, signal, and association types plus abortable API methods.
- web/src/agentWorkbenchApi.test.ts: URL/body/AbortSignal and structured API-error contract tests.
- web/src/agentWorkbenchPresentation.ts: pure status text, quality text, snapshot-aligned clocks, freshness downgrade, receipt expiry, event diffing, and deterministic selection.
- web/src/useAgentWorkbenchPolling.ts: non-overlapping recursive timeout, AbortController lifecycle, visibility/focus behavior, tab-local pause, and manual refresh.
- web/src/pages/AgentWorkbench.tsx: page state composition, header, range selection, empty/degraded states, and polite event announcements.
- web/src/components/agent-workbench/LiveRunStage.tsx: accessible Run tabs, one detail panel, lifecycle rail, factual receipt, idle state, and copy action.
- web/src/components/agent-workbench/AgentSummaryMetrics.tsx: selected-range outcomes/Token coverage plus current queued/running/waiting and legacy counts.
- web/src/components/agent-workbench/AgentRegistryTable.tsx: arbitrary-length Agent table, filters, coverage qualifiers, and accessible expansion controls.
- web/src/components/agent-workbench/AgentRunHistory.tsx: cursor-based projected history and server-supplied local links.
- web/src/components/agent-workbench/AgentManagerDrawer.tsx: register/edit/disable/re-enable/retire/replace flows, validation, focus containment, inert background, and focus restoration.
- web/src/App.tsx: Agent glyph, sidebar entry after 任务, active state, and /agents route.
- web/vite.config.ts and web/src/viteProxy.test.ts: deterministic IPv4 loopback API proxy for the guarded browser/live gate.
- web/src/index.css: one append-only .agent-workbench-scoped palette/layout/motion block plus reduced-motion and forced-colors rules.
- web/src/agentWorkbenchPresentation.test.ts, web/src/AgentWorkbench.test.tsx, web/src/agentWorkbenchStyles.test.ts: pure timing/selection rules, component/polling/accessibility behavior, and palette contrast.
- web/src/App.test.tsx: direct-route and four-item navigation smoke coverage only.

## Isolated Worktree Bootstrap

- [ ] After `superpowers:using-git-worktrees` creates the isolated checkout from the exact integrated commit, enter that worktree and confirm `git status --short` is empty before installing anything.
- [ ] Create the ignored Python environment and install the repository requirements; this feature adds no dependency:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
python3.13 -m venv api/.venv
api/.venv/bin/python -m pip install -r api/requirements.txt
~~~

- [ ] Install the exact locked frontend dependency tree:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm ci)
~~~

- [ ] Run the integrated commit's baseline before Task 1; if it is red, preserve the output and coordinate instead of attributing the failure to Workbench code:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests -q)
(cd web && npm test)
(cd web && npm run lint)
(cd web && npm run build)
git status --short
~~~

Expected: all commands pass and Git stays clean; `.venv` and `node_modules` remain ignored.

- [ ] Only immediately before Task 11's live gate, provision the ignored real environment from the known source checkout without printing it, then verify Git ignores it:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -f /Users/xander/git_repo/connexup-seo-ops/api/.env
install -m 600 /Users/xander/git_repo/connexup-seo-ops/api/.env api/.env
git check-ignore -q api/.env
~~~

If that exact source file is absent or is not the operator-approved environment for this integration, do not synthesize credentials: mark the live gate unavailable and continue only with fake-backed/visual-fixture verification. Never stage or print `api/.env`.

---

### Task 1: Add validated settings and the durable schema

**Files:**
- Modify: api/app/config.py
- Modify: api/.env.example
- Modify: api/schema.sql
- Modify: api/tests/conftest.py
- Modify: api/tests/test_config.py
- Modify: api/tests/test_db.py

**Interfaces:**
- Produces: CoreAiConnectionSettings(base_url: str, api_key: str).
- Produces: AgentWorkbenchSettings(timezone: zoneinfo.ZoneInfo, history_limit: int).
- Produces: BootstrapAgentSlot(env_name, agent_key, display_name, role, sort_order, coreai_agent_id).
- Produces: coreai_connection_settings() -> CoreAiConnectionSettings | None without changing coreai_settings().
- Produces: agent_workbench_settings() -> AgentWorkbenchSettings.
- Produces: configured_agent_slots() -> tuple of BootstrapAgentSlot values in the documented deterministic order.
- Persists: seo_ops_agents, seo_ops_agent_runs, and seo_ops_agent_sync_state.

**Mandatory vertical RED-GREEN order:** Execute these small slices in order; the longer sections below are contract references.

- [ ] Add `test_workbench_connection_does_not_require_primary_agent`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k workbench_connection_does_not_require_primary_agent)` and observe RED.
- [ ] Implement `CoreAiConnectionSettings` plus `coreai_connection_settings` only; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_workbench_connection_does_not_require_primary_agent)`.
- [ ] Rerun the complete config file to prove existing `coreai_settings` behavior is unchanged. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q)`.
- [ ] Add the default timezone/history row to `test_agent_workbench_settings_defaults_and_bounds` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only the default Workbench settings and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add valid/invalid timezone rows to the same test and observe RED for invalid-zone handling. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only timezone parsing and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add below-minimum/above-maximum history-limit rows and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only bounded history-limit parsing and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add `test_configured_agent_slots_exact_order`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_exact_order)`.
- [ ] Implement the six deterministic slot descriptors and secret-safe repr; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_exact_order)`.
- [ ] Add `test_agent_workbench_schema_on_fresh_database`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k agent_workbench_schema_on_fresh_database)` and observe RED.
- [ ] Add only the three `CREATE TABLE` statements and rerun the fresh-schema selection; keep the missing-index/constraint assertions RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_on_fresh_database)`.
- [ ] Add the named lookup/due indexes and rerun; keep the primary-key NULL assertion RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_on_fresh_database)`.
- [ ] Add explicit non-NULL checks to all three logical primary keys and require two successive NULL-insert attempts to fail; finish the fresh-schema selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_on_fresh_database)`.
- [ ] Add the partial-pair rows to `test_agent_run_token_checks_reject_partial_fractional_and_negative` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the Token null-parity CHECK and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add fractional Token rows and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the Token `typeof(...)=integer` CHECK and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add negative Token rows and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the non-negative Token CHECK and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add the valid source-bound NULL-status row and blank-status rejection to `test_statusless_accepted_marker_is_nullable_but_narrow`; observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Implement only the NULL-or-trimmed-nonempty `raw_status` CHECK and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add the table-driven prohibited-upstream-column rows—including `started_at`—to the same test and observe RED; every row exercises the same NULL-status narrowness branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add the single NULL-status upstream-field absence CHECK and finish the focused selection green; keep warning-code ownership in Task 7 rather than pretending SQL defaults prove it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add integer counter violations to `test_sync_integer_boolean_and_quality_checks` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only integer/non-negative counter CHECKs and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add boolean-domain violations to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only 0/1/NULL boolean CHECKs and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add invalid quality enum rows to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only exact/lower_bound/unknown quality CHECKs and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add the default epoch row to `test_history_event_epoch_constraints` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add only the `(history_event_epoch=0, unfiltered_proven_event_epoch=NULL)` defaults and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add fractional/negative epoch rows and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add integer/non-negative epoch CHECKs and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add future-proven and equal-proven rows and observe RED for the future case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Enforce proven epoch at or behind history epoch and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add `test_agent_workbench_schema_repeated_init` and observe RED if initialization is not idempotent. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_repeated_init)`.
- [ ] Fix only repeated-initialization idempotence and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_repeated_init)`.
- [ ] Add `test_pre_workbench_database_migrates_additively`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_pre_workbench_database_migrates_additively)`.
- [ ] Extend `init_db` only as needed to preserve/read back every legacy row while adding the new tables/indexes; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_pre_workbench_database_migrates_additively)`.
- [ ] Add `test_projected_run_survives_merchant_delete`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_projected_run_survives_merchant_delete)`.
- [ ] Add the precise SET NULL foreign-key behavior; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_projected_run_survives_merchant_delete)`.
- [ ] Update `.env.example`, clear host variables in the shared fixture, and rerun the complete config/database files before the final commit checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py -q)`.

**Contract reference 1A: Configuration and bootstrap-slot tests**

~~~python
def test_workbench_connection_does_not_require_primary_agent(monkeypatch):
    monkeypatch.setenv("COREAI_BASE_URL", "https://core.example/")
    monkeypatch.setenv("COREAI_API_KEY", "secret")
    monkeypatch.delenv("COREAI_AGENT_ID", raising=False)
    assert coreai_settings() is None
    assert coreai_connection_settings() == CoreAiConnectionSettings(
        base_url="https://core.example",
        api_key="secret",
    )


def test_agent_workbench_settings_defaults_and_bounds(monkeypatch):
    monkeypatch.setenv("SEO_OPS_OPERATOR_TIMEZONE", "Asia/Shanghai")
    monkeypatch.setenv("SEO_OPS_AGENT_HISTORY_LIMIT", "200")
    settings = agent_workbench_settings()
    assert settings.timezone.key == "Asia/Shanghai"
    assert settings.history_limit == 200
~~~

Add literal tests for the default values, history limits 1 and 1000, rejection of 0, 1001, non-integers, and an invalid IANA timezone. Assert the six slots and order exactly:

~~~python
assert [(slot.env_name, slot.agent_key) for slot in configured_agent_slots()] == [
    ("COREAI_AGENT_ID", "diagnosis-plan"),
    ("COREAI_EXECUTION_AGENT_ID", "task-preparation"),
    ("COREAI_KEYWORD_AGENT_ID", "keyword-research"),
    ("COREAI_AUDIT_AGENT_ID", "seo-audit"),
    ("COREAI_RANKING_AGENT_ID", "ranking-analysis"),
    ("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-workflow"),
]
~~~

Also assert the API key is excluded from repr(CoreAiConnectionSettings). Clear SEO_OPS_OPERATOR_TIMEZONE and SEO_OPS_AGENT_HISTORY_LIMIT in the shared client fixture so tests cannot leak host configuration.

**Contract reference 1B: Fresh-database and repeated-init schema**

Assert all columns, foreign keys, CHECK constraints, and indexes exist after init_db(), then call init_db() again and prove the schema is idempotent. Add a separate pre-Workbench fixture that creates only the currently shipped tables and one existing merchant/run/task/artifact row, invokes init_db(), and proves all legacy rows/columns remain byte-for-byte readable while the three new tables/indexes are added. Insert a merchant, Agent, sync row, and projected Run; delete the merchant and assert the projected merchant_id becomes NULL while the Run remains.

The schema must include these exact logical columns:

~~~sql
CREATE TABLE IF NOT EXISTS seo_ops_agents (
  id TEXT PRIMARY KEY NOT NULL,
  agent_key TEXT NOT NULL,
  coreai_agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(sort_order) = 'integer' AND sort_order BETWEEN -10000 AND 10000
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  coreai_name TEXT,
  coreai_model TEXT,
  coreai_timeout_hint_seconds INTEGER CHECK (
    coreai_timeout_hint_seconds IS NULL OR (
      typeof(coreai_timeout_hint_seconds) = 'integer'
      AND coreai_timeout_hint_seconds > 0
    )
  ),
  suspect_after_seconds INTEGER NOT NULL DEFAULT 1800
    CHECK (
      typeof(suspect_after_seconds) = 'integer'
      AND suspect_after_seconds BETWEEN 60 AND 86400
    ),
  last_verification_attempt_at TEXT,
  last_verified_at TEXT,
  last_verification_error TEXT,
  verification_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(verification_failure_count) = 'integer'
    AND verification_failure_count >= 0
  ),
  next_verification_at TEXT,
  metadata_lease_owner TEXT,
  metadata_lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(metadata_lease_epoch) = 'integer' AND metadata_lease_epoch >= 0
  ),
  metadata_lease_until TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(agent_key)) BETWEEN 1 AND 80),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  CHECK (length(trim(role)) BETWEEN 1 AND 240),
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_seo_ops_agents_current_key
ON seo_ops_agents(agent_key) WHERE status <> 'retired';
~~~

Add the projection table with this exact column contract:

~~~sql
CREATE TABLE IF NOT EXISTS seo_ops_agent_runs (
  coreai_run_id TEXT PRIMARY KEY NOT NULL,
  seo_ops_agent_id TEXT NOT NULL REFERENCES seo_ops_agents(id),
  raw_status TEXT CHECK (raw_status IS NULL OR length(trim(raw_status)) > 0),
  trigger_type TEXT,
  started_at TEXT,
  completed_at TEXT,
  terminal_observed_at TEXT,
  receipt_expires_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  trace_id TEXT,
  error_summary TEXT,
  source_kind TEXT CHECK (
    source_kind IS NULL OR source_kind IN ('run', 'task_execution', 'merchant_seo_artifact')
  ),
  source_local_id INTEGER CHECK (
    source_local_id IS NULL OR typeof(source_local_id) = 'integer'
  ),
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL CHECK (datetime(first_seen_at) IS NOT NULL),
  last_poll_attempt_at TEXT,
  last_synced_at TEXT,
  last_poll_error TEXT,
  data_warning_codes_json TEXT NOT NULL DEFAULT '[]',
  CHECK (
    (source_kind IS NULL AND source_local_id IS NULL)
    OR (source_kind IS NOT NULL AND source_local_id IS NOT NULL)
  ),
  CHECK ((input_tokens IS NULL) = (output_tokens IS NULL)),
  CHECK (
    input_tokens IS NULL OR (
      typeof(input_tokens) = 'integer' AND input_tokens >= 0
    )
  ),
  CHECK (
    output_tokens IS NULL OR (
      typeof(output_tokens) = 'integer' AND output_tokens >= 0
    )
  ),
  CHECK (
    raw_status IS NOT NULL OR (
      source_kind IS NOT NULL
      AND source_local_id IS NOT NULL
      AND trigger_type IS NULL
      AND started_at IS NULL
      AND completed_at IS NULL
      AND terminal_observed_at IS NULL
      AND receipt_expires_at IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND trace_id IS NULL
      AND error_summary IS NULL
      AND last_poll_attempt_at IS NULL
      AND last_synced_at IS NULL
      AND last_poll_error IS NULL
    )
  )
);
~~~

Add one seo_ops_agent_sync_state row per registry row with these exact columns:

~~~text
seo_ops_agent_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_ops_agents(id)
remote_total_runs INTEGER NULL
last_discovery_attempt_at TEXT NULL
last_discovery_success_at TEXT NULL
last_discovery_error TEXT NULL
last_discovery_returned_count INTEGER NULL
coverage_start_at TEXT NULL
current_state_checked_at TEXT NULL
pending_observed_count INTEGER NULL
pending_upstream_total INTEGER NULL
pending_last_observed_at TEXT NULL
pending_set_quality TEXT NOT NULL DEFAULT 'unknown'
running_observed_count INTEGER NULL
running_upstream_total INTEGER NULL
running_last_observed_at TEXT NULL
running_set_quality TEXT NOT NULL DEFAULT 'unknown'
paused_observed_count INTEGER NULL
paused_upstream_total INTEGER NULL
paused_last_observed_at TEXT NULL
paused_set_quality TEXT NOT NULL DEFAULT 'unknown'
unresolved_unknown_status_count INTEGER NOT NULL DEFAULT 0
current_state_complete INTEGER NOT NULL DEFAULT 0
current_state_error TEXT NULL
sync_pending INTEGER NOT NULL DEFAULT 1
local_event_epoch INTEGER NOT NULL DEFAULT 0
history_event_epoch INTEGER NOT NULL DEFAULT 0
unfiltered_proven_event_epoch INTEGER NULL
projection_revision INTEGER NOT NULL DEFAULT 0
next_discovery_at TEXT NULL
last_fast_poll_attempt_at TEXT NULL
last_fast_poll_success_at TEXT NULL
last_fast_poll_error TEXT NULL
next_fast_poll_at TEXT NULL
discovery_failure_count INTEGER NOT NULL DEFAULT 0
fast_poll_failure_count INTEGER NOT NULL DEFAULT 0
lease_owner TEXT NULL
lease_epoch INTEGER NOT NULL DEFAULT 0
lease_until TEXT NULL
~~~

Apply CHECK constraints so counts/totals/failure counts/revisions/epochs are NULL or non-negative integers, qualities are exact/lower_bound/unknown, booleans are integer 0/1, and first_seen_at is SQLite-parseable. SQLite rowid tables do not make a non-INTEGER `PRIMARY KEY` implicitly reject NULL, so declare `seo_ops_agents.id`, `seo_ops_agent_runs.coreai_run_id`, and `seo_ops_agent_sync_state.seo_ops_agent_id` as `PRIMARY KEY NOT NULL`; prove both a first and repeated NULL insertion fail for each logical identity. Use `value IS NULL OR (typeof(value) = 'integer' AND value >= 0)` for every nullable count/total, `typeof(value) = 'integer' AND value >= 0` for non-null failure counts plus `metadata_lease_epoch`, run `lease_epoch`, `local_event_epoch`, `history_event_epoch`, and `projection_revision`, and `typeof(value) = 'integer' AND value IN (0, 1)` for booleans. Constrain `unfiltered_proven_event_epoch` to NULL or an integral value in `0..history_event_epoch`; it is the durable proof generation, not a timestamp. Explicitly reject malformed first_seen_at. Insert `(NULL, 5)`, `(5, NULL)`, `(-1, 5)`, `(5, -1)`, and `(1.5, 5)` Token pairs and require `sqlite3.IntegrityError`; parameterize `1.5` across every Agent/sync count/total/failure/revision/epoch column and a non-integral boolean and require the same. SQLite CHECK expressions that merely evaluate to NULL are not sufficient. `raw_status=NULL` has exactly one meaning: Core AI accepted that exact Run ID locally, but no valid list row has confirmed its status yet. The schema permits it only with a source association plus `first_seen_at` and no upstream-derived fields; empty strings remain invalid. Separately, Task 7's helper must persist canonical `LOCAL_TRIGGER_STATUS_MISSING` warning JSON and reread it—the generic schema default alone is not treated as proof of that application invariant. This durable marker lives in the same projection table, so a later exact-zero list cannot erase the accepted event or permit a false idle claim. Add indexes for Agent/effective history lookup, raw status, association lookup, next verification, next discovery, next fast poll, both metadata/run lease expiries, and existing runs.coreai_run_id/task_executions.coreai_run_id lookup. Make seo_ops_agent_id immutable in application logic; do not add a cascade that can erase Run history.

**Final Task 1 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 1C: Settings and schema**

Use zoneinfo.ZoneInfo for validation, return defaults only when variables are absent/blank, and raise ValueError with the exact variable name for invalid configured values. Declare api_key with dataclasses.field(repr=False). Preserve CoreAiSettings and coreai_settings() byte-for-byte in behavior.

Use these deterministic bootstrap display defaults and sort orders:

~~~python
BOOTSTRAP_AGENT_SLOTS = (
    ("COREAI_AGENT_ID", "diagnosis-plan", "诊断与计划 Agent", "诊断商户并生成可审核 SEO 计划", 10),
    ("COREAI_EXECUTION_AGENT_ID", "task-preparation", "任务准备 Agent", "为已批准任务准备执行材料", 20),
    ("COREAI_KEYWORD_AGENT_ID", "keyword-research", "关键词研究 Agent", "生成和整理本地搜索关键词", 30),
    ("COREAI_AUDIT_AGENT_ID", "seo-audit", "SEO 审计 Agent", "执行 SEO 审计与改进建议", 40),
    ("COREAI_RANKING_AGENT_ID", "ranking-analysis", "排名分析 Agent", "分析本地搜索排名与变化", 50),
    ("COREAI_KEYWORD_SKILL_AGENT_ID", "keyword-skill-workflow", "关键词 Skill Agent", "编排关键词研究 Skill 工作流", 60),
)
~~~

Document only non-secret values in api/.env.example:

~~~dotenv
SEO_OPS_OPERATOR_TIMEZONE=Asia/Shanghai
SEO_OPS_AGENT_HISTORY_LIMIT=200
~~~

- [ ] **Step 5: Run focused tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py -q)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/config.py api/.env.example api/schema.sql api/tests/conftest.py api/tests/test_config.py api/tests/test_db.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: add agent workbench storage"
~~~

---

### Task 2: Add the true Core AI Agent-run list boundary

**Files:**
- Modify: api/app/coreai.py
- Modify: api/tests/test_coreai.py

**Interfaces:**
- Extends: CoreAiClient._request(method, path, json_body=None, params=None) -> dict.
- Produces: CoreAiContractError(code: str, message: str), a typed CoreAiError subtype for sanitized upstream-shape violations.
- Strengthens: CoreAiClient.trigger(agent_id, input_text) -> dict with a trimmed non-empty string `run_id` and a normalized `status: str | None`.
- Produces: CoreAiClient.list_agent_runs(agent_id: str, status: str | None, limit: int) -> dict.
- Returns only: runs[].id, agent_id, triggered_by, status, token_usage, trace_id, started_at, completed_at, error; and top-level total.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `test_request_passes_query_params`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k request_passes_query_params)` and observe RED.
- [ ] Add the optional `_request(..., params=None)` seam without changing existing JSON calls; rerun the new case and all existing Core AI trigger cases to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)`.
- [ ] Add `test_list_agent_runs_uses_real_path_query_and_discards_large_fields`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] Implement URL quoting, optional status query, limit, and `RUN_LIST_FIELDS`; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] **GREEN characterization:** Add `test_list_agent_runs_preserves_zero_token_pair` after the preceding adapter slice is green; run the literal command at the end of this step and require it to stay green without normalizing zeros away. This is a preservation check, not a claimed RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_preserves_zero_token_pair)`.
- [ ] Add `test_list_agent_runs_rejects_malformed_envelopes`, one parameterized envelope at a time; run the literal command at the end of this step after each case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add only the returned-list/object/total guards required by the failing case; finish the malformed cases with the literal command at the end of this step green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add `test_get_agent_id_mismatch_is_typed_contract_error`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_get_agent_id_mismatch_is_typed_contract_error)`.
- [ ] Implement `CoreAiContractError` plus the existing ID guard mapping; rerun it and every existing Core AI test to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)`.
- [ ] Add `test_trigger_rejects_invalid_run_identity`; parameterize missing, null, bool, integer, list, blank, and whitespace-only `run_id`, require generic `TRIGGER_RUN_ID_INVALID`, and run the literal command at the end of this step to observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Implement the typed/nonblank trigger-ID boundary and return the trimmed ID; add a padded valid-ID case and rerun to green without logging or echoing the rejected value. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Add the missing/null/blank/non-string rows to `test_trigger_normalizes_optional_status`; run the focused selection and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Implement only the optional-status-to-`None` branch and rerun the focused selection to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Add padded RUNNING and padded future-status rows to the same test and observe RED if either value is not trimmed/preserved exactly. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Implement only non-empty status trimming/preservation and rerun the focused selection to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Run the complete Core AI file and perform the non-interactive commit checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)`.

**Contract reference 2A: MockTransport request and narrowing**

~~~python
def test_list_agent_runs_uses_real_path_query_and_discards_large_fields():
    seen = {}
    def handler(request):
        seen["path"] = request.url.path
        seen["query"] = dict(request.url.params)
        return httpx.Response(200, json={
            "runs": [{
                "id": "run-1",
                "agent_id": "agent-1",
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
            }],
            "total": 1,
        })

    client = CoreAiClient("https://core.example", "secret", transport=httpx.MockTransport(handler))
    page = client.list_agent_runs("agent-1", "PAUSED", 200)
    assert seen == {
        "path": "/api/runs/agent/agent-1/list",
        "query": {"status": "PAUSED", "limit": "200"},
    }
    assert "input" not in page["runs"][0]
    assert "output" not in page["runs"][0]
    assert "error_stack" not in page["runs"][0]
~~~

Also test no status parameter for the unfiltered call, URL encoding of an Agent ID, valid total zero, and retention of a zero-valued Token pair.

**Contract reference 2B: Malformed envelope and Agent-ID contract**

Reject non-list runs, boolean/negative/non-integral total, any non-object row, and a returned count greater than total with CoreAiError(0, sanitized message). Do not validate status semantics or Agent-ID ownership here; Task 4 owns those projection rules.

For `get_agent()`, return a valid object whose `id` differs from the requested ID and assert the client raises `CoreAiContractError` with `status_code == 0` and `code == "AGENT_ID_MISMATCH"`. Existing `except CoreAiError` callers must continue to catch it. This typed error lets the Workbench distinguish an accessible-but-invalid Agent (422) from a transport/HTTP failure (503) without parsing error text.

**Contract reference 2C: Accepted trigger identity and optional status**

Core AI may already have accepted a trigger before SEO Ops parses the 202 response, so normalize only the narrow values required for durable identity. `run_id` must be an explicit string whose trimmed form is non-empty; return that trimmed form. Missing, null, boolean, numeric, collection, blank, or whitespace-only IDs raise `CoreAiContractError('TRIGGER_RUN_ID_INVALID', 'core-ai trigger response has invalid run_id')` without including the raw value/body. Never pass such a value to a source table or Workbench helper. A valid padded ID is normalized once at this client boundary, and every downstream source/projection uses the same normalized value.

`status` is optional evidence. If it is an explicit string with non-empty trimmed content, return the trimmed text verbatim, including an unknown future value. Missing, null, blank, whitespace-only, boolean, numeric, or collection status becomes `None` rather than a coerced/fabricated status or a trigger failure. Return a shallow copied response with only these two fields normalized so existing valid trigger callers remain compatible; never mutate the raw response object or call `str` on either field.

**Final Task 2 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 2D: Trigger guard and list adapter**

~~~python
RUN_LIST_FIELDS = (
    "id", "agent_id", "triggered_by", "status", "token_usage",
    "trace_id", "started_at", "completed_at", "error",
)

def list_agent_runs(self, agent_id: str, status: str | None, limit: int) -> dict:
    params: dict[str, str | int] = {"limit": limit}
    if status is not None:
        params["status"] = status
    body = self._request(
        "GET",
        f"/api/runs/agent/{quote(agent_id, safe='')}/list",
        params=params,
    )
    runs = body.get("runs")
    total = body.get("total")
    if not isinstance(runs, list) or not all(isinstance(row, dict) for row in runs):
        raise CoreAiError(0, "core-ai Agent run list is malformed")
    if isinstance(total, bool) or not isinstance(total, int) or total < len(runs):
        raise CoreAiError(0, "core-ai Agent run total is malformed")
    return {
        "runs": [{key: row.get(key) for key in RUN_LIST_FIELDS} for row in runs],
        "total": total,
    }
~~~

Pass params separately to httpx.Client.request. Keep existing valid callers and transport/HTTP behavior unchanged and never include the token, rejected scalar, or response body in a new error.

Add the typed contract error and use it only for the existing `get_agent()` identity guard:

~~~python
class CoreAiContractError(CoreAiError):
    def __init__(self, code: str, message: str):
        super().__init__(0, message)
        self.code = code


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
    raw_status = body.get("status")
    status = raw_status.strip() if isinstance(raw_status, str) and raw_status.strip() else None
    return {**body, "run_id": run_id.strip(), "status": status}


def get_agent(self, agent_id: str) -> dict:
    body = self._request("GET", f"/api/agents/{quote(agent_id, safe='')}")
    if body.get("id") != agent_id:
        raise CoreAiContractError(
            "AGENT_ID_MISMATCH",
            "core-ai agent detail id mismatch",
        )
    return body
~~~

Keep transport, HTTP, and all other malformed responses as ordinary `CoreAiError`; do not infer contract codes from message strings.

- [ ] **Step 5: Run focused tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/coreai.py api/tests/test_coreai.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: list Core AI agent runs"
~~~

---

### Task 3: Build explicit Agent registry lifecycle APIs

**Files:**
- Create: api/app/agent_workbench.py
- Create: api/tests/test_agent_workbench.py

**Interfaces:**
- Produces: router with prefix /api/agent-workbench.
- Produces: seed_configured_agents(conn, slots, now) -> list[dict].
- Produces: bootstrap_configuration_warnings(conn, slots) -> list[WorkbenchWarning], recomputed from configuration and registry without persisting a stale copy.
- Produces: verify_agent_metadata(client, coreai_agent_id, now, sensitive_values=()) -> VerifiedAgentMetadata.
- Produces: get_agent_workbench_coreai() -> iterator yielding one request-owned CoreAiClient and closing it in finally.
- Produces: read_workbench_json(request) -> object, parse_workbench_mutation(model_type, raw) -> BaseModel, and require_empty_workbench_body(request) -> None so every mutation has the same structured error envelope without inventing a retire body.
- Adds: POST /api/agent-workbench/agents.
- Adds: PATCH /api/agent-workbench/agents/{local_agent_id}.
- Adds: POST /api/agent-workbench/agents/{local_agent_id}/retire.
- Adds: POST /api/agent-workbench/agents/{local_agent_id}/replace.

**Mandatory vertical RED-GREEN order:**

- [ ] Create the test-local FastAPI app/dependency overrides plus `test_workbench_error_detail_shape`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k workbench_error_detail_shape)` and observe the missing-module failure.
- [ ] Create `agent_workbench.py` with router, `WorkbenchError`, sanitizer, and no routes; rerun collection/error-shape to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_error_detail_shape)`.
- [ ] Add `test_workbench_sanitizer_redacts_credentials`; inject known secrets, Bearer/Authorization/API-key labels, and sensitive URL query parameters into one message at a time; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Implement credential redaction before control-character normalization/240-code-point truncation, with no raw object/body repr; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Add `test_seed_new_configured_agent`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_new_configured_agent)`.
- [ ] Implement the one-slot insert and sync-state insert transaction; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_new_configured_agent)`.
- [ ] Add `test_seed_repeat_preserves_operator_fields_and_history`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_repeat_preserves_operator_fields_and_history)`.
- [ ] Implement idempotent preserve-only seeding; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_repeat_preserves_operator_fields_and_history)`.
- [ ] Add `test_seed_removed_env_keeps_existing_registry_and_history` and observe RED if empty configuration mutates persisted state. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_removed_env_keeps_existing_registry_and_history)`.
- [ ] Make empty/removed configuration preserve the registry and history byte-for-byte; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_removed_env_keeps_existing_registry_and_history)`.
- [ ] Add `test_seed_conflict_warnings_are_recomputed`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Implement first-slot duplicate-ID precedence and deterministic warning recomputation; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Add `test_register_agent_happy_path`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Implement `get_agent_workbench_coreai`, successful metadata verification, DTO, and one registration transaction; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Add `test_metadata_id_mismatch_is_422` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_id_mismatch_is_422)`.
- [ ] Implement only the typed ID-mismatch mapping without parsing error text; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_id_mismatch_is_422)`.
- [ ] Add `test_metadata_wrong_type_is_422` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_wrong_type_is_422)`.
- [ ] Implement only the exact `AGENT` type guard; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_wrong_type_is_422)`.
- [ ] Add `test_metadata_unpublished_is_422` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_unpublished_is_422)`.
- [ ] Implement only the exact `PUBLISHED` status guard; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_unpublished_is_422)`.
- [ ] Add `test_metadata_blank_name_is_422` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_blank_name_is_422)`.
- [ ] Implement only the nonblank-name guard; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_blank_name_is_422)`.
- [ ] Add `test_metadata_missing_credentials_is_fixed_503` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_missing_credentials_is_fixed_503)`.
- [ ] Map only missing Workbench credentials to the fixed 503 code/message; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_missing_credentials_is_fixed_503)`.
- [ ] Add `test_metadata_transport_is_fixed_503`; inject one exception whose text is a unique sentinel and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_transport_is_fixed_503)`.
- [ ] Map transport failure directly to a fixed 503 without inspecting the exception; rerun until the sentinel is absent from HTTP JSON, SQLite, caplog, and exception repr. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_transport_is_fixed_503)`.
- [ ] Add `test_metadata_http_error_body_is_fixed_503`; inject separate 500 text and JSON bodies with unique sentinels and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_http_error_body_is_fixed_503)`.
- [ ] Map HTTP failure without inspecting either body and rerun until both sentinels are absent from every tested boundary. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_http_error_body_is_fixed_503)`.
- [ ] Add `test_body_protocol_empty_is_structured` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_empty_is_structured)`.
- [ ] Add the empty-body branch of `read_workbench_json` and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_empty_is_structured)`.
- [ ] Add `test_body_protocol_malformed_is_structured` with malformed bytes and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_malformed_is_structured)`.
- [ ] Add only the malformed-JSON branch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_malformed_is_structured)`.
- [ ] Add `test_body_protocol_root_is_structured` for array and scalar roots and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_root_is_structured)`.
- [ ] Add only the plain-object root guard and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_root_is_structured)`.
- [ ] Add `test_body_protocol_extra_fields_are_structured` with one extra field and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_extra_fields_are_structured)`.
- [ ] Enable strict extra-field rejection and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_body_protocol_extra_fields_are_structured)`.
- [ ] Add `test_register_numeric_string_integer_is_rejected` for one integer field and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_numeric_string_integer_is_rejected)`.
- [ ] Make registration integers strict and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_numeric_string_integer_is_rejected)`.
- [ ] **GREEN characterization:** Add `test_register_integer_fields_reject_remaining_coercions` for integral floats and booleans across both integer fields; require it to remain green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_integer_fields_reject_remaining_coercions)`.
- [ ] **GREEN characterization:** Add `test_edit_integer_fields_reject_coercion` with the same scalar matrix and require no new parser branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_integer_fields_reject_coercion)`.
- [ ] **GREEN characterization:** Add `test_replace_integer_fields_reject_coercion` with the same scalar matrix and require no new parser branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_integer_fields_reject_coercion)`.
- [ ] Add `test_registration_conflicts_and_field_bounds` one conflict/boundary row at a time and leave the first missing guard RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the 409/422 transaction guard exposed by each failing row and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add `test_update_presentation_and_disable` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Implement immutable-ID presentation edits plus the disabled lifecycle cadence and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Add `test_reenable_verifies_before_write` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_verifies_before_write)`.
- [ ] Implement only the verified atomic transition and `local_event_epoch` increment without mutating an existing Run or metadata lease; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_verifies_before_write)`.
- [ ] Add `test_reenable_revokes_archival_proof_immediately`; seed fresh exact disabled archival proof plus a cached RUNNING row, re-enable, and run the literal command at the end of this step to observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_revokes_archival_proof_immediately)`.
- [ ] In the re-enable transaction preserve last observations but set all three bucket qualities unknown, `current_state_complete=0`, `sync_pending=1`, and full discovery due now; rerun until an immediate aggregate is static, has no exact count/idle claim, and only a post-epoch complete proof can restore it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_revokes_archival_proof_immediately)`.
- [ ] Add the zero-byte success/history-preservation half of `test_retire_is_bodyless_and_irreversible` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Implement only retire/history preservation and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Add whitespace, JSON, other non-zero body, and repeat-retire rows to the same test and observe RED at the first missing guard. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Implement raw-byte body rejection plus irreversible lifecycle conflict and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Add `test_replace_is_atomic_and_preserves_old_history` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_is_atomic_and_preserves_old_history)`.
- [ ] Implement verify-then-retire/create with one rollback boundary and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_is_atomic_and_preserves_old_history)`.
- [ ] Run the complete registry test file and perform the final commit checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)`.

**Contract reference 3A: Deterministic seed behavior**

Test no configured slots, one slot, repeated seeding, duplicate Core AI IDs in multiple slots, and a configured role-key conflict. Seeding must:

1. Insert one active row for a new role/ID.
2. Preserve operator-edited presentation fields and existing ownership on repeat.
3. Never replace an existing role key whose current row has a different Core AI ID.
4. Choose only the first configured slot for a duplicated Core AI ID and return CONFIG_DUPLICATE_AGENT_ID plus CONFIG_ROLE_CONFLICT warnings for the aggregate layer. bootstrap_configuration_warnings recomputes the same warnings after restart, because startup's return value is not treated as durable state.
5. Set sync_pending=1 and next_discovery_at=now for a new row without doing network I/O.
6. Seed one configured slot, attach one projected history row, rerun seeding with that environment variable removed/all slots empty, and assert the registry row, lifecycle, sync row, and history are byte-for-byte unchanged. Removing bootstrap configuration never disables, retires, replaces, or deletes an existing registry record.

**Contract reference 3B: Registration and metadata-verification API**

Use a dedicated fake with get_agent() and list_agent_runs(); do not widen the shared FakeCoreAi. Until Task 7 registers the production router in main.py, build a test-local FastAPI app, include agent_workbench.router with Depends(require_operator), and override get_db/get_agent_workbench_coreai. Freeze `utc_now()` at `2026-09-03T01:02:03+00:00` and `uuid.uuid4()` at `11111111-1111-4111-8111-111111111111`. This keeps every Task 3 RED/GREEN cycle runnable without prematurely editing the high-conflict application lifecycle. Test this accepted request exactly:

~~~json
{
  "coreai_agent_id": "agent-extra",
  "agent_key": "citation-monitor",
  "display_name": "Citation Monitor Agent",
  "role": "监控关键引用与目录变化",
  "sort_order": 70,
  "suspect_after_seconds": 1800
}
~~~

Registration returns HTTP 201:

~~~json
{
  "agent": {
    "id": "11111111-1111-4111-8111-111111111111",
    "agent_key": "citation-monitor",
    "coreai_agent_id": "agent-extra",
    "display_name": "Citation Monitor Agent",
    "role": "监控关键引用与目录变化",
    "sort_order": 70,
    "lifecycle_status": "active",
    "coreai_metadata": {
      "name": "Citation Monitor",
      "model": "gpt-example",
      "timeout_hint_seconds": 900,
      "last_verified_at": "2026-09-03T01:02:03+00:00",
      "verification_error": null
    },
    "suspect_after_seconds": 1800,
    "sync_pending": true
  },
  "sync_pending": true
}
~~~

The metadata response must have exact ID, type AGENT, status PUBLISHED, and non-empty name. Test ID mismatch, inaccessible transport, wrong type, DRAFT status, blank name, duplicate Core AI ID, duplicate current agent_key, whitespace-only fields, the exact 1-80 trimmed agent_key bounds without adding an undocumented regex, other text limits, sort_order outside -10000..10000, and suspect threshold outside 60..86400. Assert failed verification inserts nothing. Use HTTP 409 for local uniqueness/lifecycle conflicts, 422 for accessible but invalid metadata, and 503 for missing credentials or an upstream verification failure. Error detail is always:

~~~json
{"code": "STABLE_MACHINE_CODE", "message": "sanitized operator message", "fields": {}}
~~~

Send each body-bearing mutation (register, edit, and replace) an empty body, malformed JSON, a JSON array, a missing required field, a wrong field type, and an extra field. For both integer fields, send `"70"`, `70.0`, and `true` as the otherwise-valid `sort_order`, and `"1800"`, `1800.0`, and `true` as `suspect_after_seconds`, across all three mutation DTOs; every case is 422 rather than Pydantic coercion. Assert every response still uses that object-shaped `detail`, with stable codes `REQUEST_BODY_REQUIRED`, `INVALID_JSON`, or `VALIDATION_ERROR`; validation failures put only sanitized field messages in `fields`. Separately prove retire succeeds only with zero request-body bytes and returns structured `UNEXPECTED_REQUEST_BODY` for whitespace, `{}`, `null`, or any other non-zero body. Do not accept FastAPI's default list-shaped Pydantic 422 response on these Workbench mutation routes.

**Contract reference 3C: Edit, disable, re-enable, retire, and replace**

Freeze these request contracts:

~~~typescript
type UpdateAgentRequest = {
  display_name?: string
  role?: string
  sort_order?: number
  suspect_after_seconds?: number
  lifecycle_status?: 'active' | 'disabled'
}

type ReplaceAgentRequest = {
  coreai_agent_id: string
  display_name?: string
  role?: string
  sort_order?: number
  suspect_after_seconds?: number
}
~~~

An empty PATCH is 422. agent_key and coreai_agent_id are immutable under PATCH. Disabling requires no upstream call, preserves Runs, and makes discovery due at now+15 minutes. Re-enabling first verifies metadata, then in one transaction writes active, increments `local_event_epoch`, preserves prior observed counts/times but sets PENDING/RUNNING/PAUSED qualities to unknown, sets `current_state_complete=0`, writes `sync_pending=1`, and sets next_discovery_at=now without mutating an existing run or metadata lease. Its immediate aggregate keeps cached rows visible but static, exposes no exact current count or idle claim, and requires a complete full proof acquired at the new epoch before clearing sync_pending; lifecycle plus the generation change also prevent already-fetched disabled/current proof from satisfying it. Retire accepts active or disabled with exactly zero request-body bytes, sets retired_at, preserves history, schedules now+24 hours, and cannot be undone; whitespace or any other non-zero retire body is rejected with structured `UNEXPECTED_REQUEST_BODY`. Replace rejects the same Core AI ID and any ID already present, verifies the new ID first, then in one BEGIN IMMEDIATE transaction retires the old row and creates a new row with the same stable role key; omitted presentation fields inherit from the old record, new sync_pending is true, old Runs remain bound to the old local ID, and any constraint failure rolls the whole transaction back.

**Final Task 3 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 3D: Registry DTOs, errors, verification, and transactions**

Give every register/edit/replace Pydantic model `model_config = ConfigDict(extra='forbid', strict=True)`, plus the exact length/range bounds from the tests; do not use lax `int` coercion or treat booleans as integers. Use UUID strings for local IDs, BEGIN IMMEDIATE for lifecycle races, and one `sanitize_operator_text(value, sensitive_values=())` boundary for every upstream-derived API/database/log message. It must first replace every non-empty known credential value and case-insensitive Bearer credential, Authorization/API-key/token/secret labelled value, and sensitive URL query value (`api_key`, `apikey`, `access_token`, `token`, `key`, `secret`, `authorization`) with `[REDACTED]`; then collapse control characters/whitespace and truncate to 240 Unicode code points. Accept only an explicit string or explicit string `message` member as source text; for another object/response/body emit a fixed generic message and never call repr/str on it. Never include a raw response body, Authorization header, exception cause text, or credential in `WorkbenchError`, persisted error_summary, repr, or logs. Make `WorkbenchError` a thin `HTTPException` subtype whose `detail` is always `{code, message, fields}` and suppress raw exception chaining at the route boundary. Do not bind mutation bodies directly as Pydantic route parameters. Read raw bytes through `read_workbench_json`: empty bytes raise `REQUEST_BODY_REQUIRED`, JSON decode failure raises `INVALID_JSON`, and valid JSON goes through `model_type.model_validate(raw)` in `parse_workbench_mutation`. Catch `ValidationError`, map each location to a stable dot-separated field key (use `body` for a root error), sanitize the message, and raise `VALIDATION_ERROR`. Apply this dependency/helper to POST register, PATCH edit, and POST replace so missing, wrong, and extra data cannot escape as FastAPI's default detail array. Keep POST retire strictly bodyless: `require_empty_workbench_body` accepts only `raw_bytes == b''`; whitespace or any other non-zero bytes raise `UNEXPECTED_REQUEST_BODY`.

~~~python
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
    sensitive_values: Sequence[str] = (),
) -> VerifiedAgentMetadata:
    try:
        raw = client.get_agent(coreai_agent_id)
    except CoreAiContractError as exc:
        if exc.code == "AGENT_ID_MISMATCH":
            raise WorkbenchError(422, exc.code, "Core AI Agent ID 不匹配") from None
        raise WorkbenchError(422, "AGENT_METADATA_INVALID", "Core AI Agent 元数据不可用") from None
    except CoreAiError:
        # CoreAiClient may retain raw HTTP response text in exception args for
        # legacy callers. Workbench must never inspect, stringify, or forward it.
        raise WorkbenchError(
            503,
            "COREAI_VERIFICATION_FAILED",
            "Core AI 暂时不可用，稍后重试",
        ) from None
    if raw.get("id") != coreai_agent_id:
        raise WorkbenchError(422, "AGENT_ID_MISMATCH", "Core AI Agent ID 不匹配")
    if raw.get("type") != "AGENT":
        raise WorkbenchError(422, "AGENT_TYPE_INVALID", "该 Core AI 定义不是 Agent")
    if raw.get("status") != "PUBLISHED":
        raise WorkbenchError(422, "AGENT_NOT_PUBLISHED", "Core AI Agent 尚未发布")
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise WorkbenchError(422, "AGENT_NAME_INVALID", "Core AI Agent 名称不可用")
    model = raw.get("model")
    model_hint = model.strip() if isinstance(model, str) and model.strip() else None
    timeout = raw.get("timeout_seconds")
    timeout_hint = (
        timeout
        if isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0
        else None
    )
    return VerifiedAgentMetadata(
        coreai_agent_id=coreai_agent_id,
        name=name.strip(),
        model=model_hint,
        timeout_hint_seconds=timeout_hint,
        verified_at=now.astimezone(timezone.utc).isoformat(),
    )
~~~

Metadata verification writes only verification columns and its independent 24-hour due time. A success clears last_verification_error/failure count; a failure preserves prior cached metadata and records only a fixed Workbench-owned code/message when operating on an existing row. `CoreAiError.args`, `str(exc)`, response text/JSON, and nested causes are forbidden sources because the current Core AI client can place raw HTTP bodies there. Only a Workbench-defined typed contract code or Task 4's dedicated successfully parsed Run-list `error` field may enter the sanitizer. Synchronous register/replace/re-enable verification must not clear Run-list errors or mutate either the run lease in sync state or the metadata lease columns on an existing row.

get_agent_workbench_coreai reads only coreai_connection_settings(), raises 503 when base URL/key are absent, creates one CoreAiClient for the request, yields it, and closes it in finally. The request entrypoint separately gathers the API key plus currently available local auth password/secret into a short-lived tuple and supplies it to `verify_agent_metadata(..., sensitive_values=...)`; that tuple never enters a DTO, repr, log, exception detail, or database. Do not reuse the existing primary-Agent dependency or introduce a cross-thread global client.

- [ ] **Step 6: Run focused tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS for seed and registry tests.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: manage SEO Ops agents"
~~~

---

### Task 4: Implement narrow projection, guarded transitions, receipts, and local association

**Files:**
- Modify: api/app/agent_workbench.py
- Modify: api/tests/test_agent_workbench.py

**Interfaces:**
- Produces: ParsedAgentRun and ParsedAgentRunPage.
- Produces: parse_agent_run_page(expected_agent_id: str, page: dict, observed_at: datetime, expected_status: str | None = None) -> ParsedAgentRunPage.
- Produces: upsert_projected_run(conn, local_agent_id, run, observed_at, binding=None, local_registration=False) -> ProjectionResult.
- Produces: resolve_local_association(conn, coreai_run_id: str) -> LocalAssociationResolution.
- Produces: association_preflight_warnings(conn) -> list[dict].

**Mandatory vertical RED-GREEN order:**

- [ ] Add `test_parse_known_status_and_narrow_fields`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k parse_known_status_and_narrow_fields)` and observe RED.
- [ ] Implement immutable parsed dataclasses plus required ID/status/trigger/ownership validation; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_known_status_and_narrow_fields)`.
- [ ] Add `test_parse_timestamp_valid_and_missing` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Implement aware-UTC normalization plus factual NULL for missing timestamps; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Add `test_parse_timestamp_rejects_naive` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_naive)`.
- [ ] Add only the naive-time NULL/warning branch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_naive)`.
- [ ] Add `test_parse_timestamp_rejects_malformed` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_malformed)`.
- [ ] Add only the malformed-time NULL/warning branch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_malformed)`.
- [ ] Add `test_parse_token_pair_accepts_zero` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_accepts_zero)`.
- [ ] Implement only pair-present integral non-negative Token parsing and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_accepts_zero)`.
- [ ] Add `test_parse_token_pair_rejects_partial` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_partial)`.
- [ ] Implement only pair-nullity plus `TOKEN_USAGE_INVALID` and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_partial)`.
- [ ] Add `test_parse_token_pair_rejects_invalid_scalars` one boolean/negative/fractional/string row at a time and observe RED on the first unsupported row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Reject each invalid scalar without coercion, NULL both Token values, emit one canonical warning, and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Add `test_parser_discards_large_private_fields` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discards_large_private_fields)`.
- [ ] Implement only narrow-field selection and rerun while asserting the dataclass repr omits every discarded value. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discards_large_private_fields)`.
- [ ] Add the identical-row collapse half of `test_parser_duplicate_rows_are_deterministic` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Implement identical duplicate collapse and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Add the conflicting-row rejection half to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Implement only conflicting duplicate-ID rejection and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Add `test_parser_redacts_upstream_error_secrets`; inject a known credential sentinel through a string error, an explicit string `message` member, a Bearer/Authorization/API-key label, and a sensitive URL query value; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Route only the permitted string/message source through `sanitize_operator_text(..., sensitive_values=...)`, reject all other object/body shapes with the fixed generic message, and rerun until the parsed dataclass repr, SQLite projection, aggregate, history response, and captured logs contain no sentinel or raw body. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Add `test_projection_data_warning_readback`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Implement canonical warning JSON replacement/persistent conflict union; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Add the legal non-terminal rows to `test_projection_transition_truth_table` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement newer-observation non-terminal transitions inside `BEGIN IMMEDIATE`; rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add terminal regression and terminal-conflict rows to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement terminal non-regression while preserving the complete first authoritative payload tuple; rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add unknown-to-known, nonterminal-to-unknown, and terminal-to-unknown rows and observe RED at the first unsupported branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement unresolved-unknown tracking plus terminal-to-unknown conflict preservation and finish the transition selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add `test_receipt_for_recent_valid_completion` for the zero-second boundary and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] Implement fixed ten-second receipt expiry and rerun the zero-second case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] Add the exact ten-second boundary to the same test and require it to stay green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] Add `test_receipt_rejects_future_or_old_completion` with only the future completion row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] Reject future completion without moving terminal observation and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] Add the eleven-second-old completion row and require it to stay green under the same bound. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] Add `test_receipt_missing_completion_requires_recent_known_nonterminal` for a recent known non-terminal predecessor and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] Implement only the recent-known-nonterminal fallback and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] Add unknown and missing-history predecessor rows and require no fallback receipt. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] Add `test_receipt_invalid_time_and_old_backfill_never_enter` for invalid/naive timestamps and observe RED if either reaches the fallback. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] Apply the no-fallback rule to invalid/naive time and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] Add the initial old-terminal backfill row and require no receipt under the same rule. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] Add `test_receipt_and_terminal_observation_are_immutable_on_repeat` and observe RED if either timestamp moves. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_and_terminal_observation_are_immutable_on_repeat)`.
- [ ] Implement once-only terminal/receipt writes and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_and_terminal_observation_are_immutable_on_repeat)`.
- [ ] Add zero-match and one-match rows to `test_resolve_local_association_zero_one_many` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Implement unassociated plus unique cross-table binding and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add the many-match conflict row to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Preserve existing binding or emit the unbound conflict without reassignment; finish the resolver selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add `test_association_links_and_merchant_delete` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Implement server-supplied links plus `SET NULL` link suppression and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Add `test_association_preflight_warnings` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_preflight_warnings)`.
- [ ] Implement deterministic duplicate reporting and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_preflight_warnings)`.
- [ ] Run the complete projection/registry file and perform the final commit checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)`.

**Contract reference 4A: Parser ownership, time, status, Token, and privacy**

Use table-driven tests for all known statuses:

~~~python
KNOWN_NONTERMINAL = {"PENDING", "RUNNING", "PAUSED"}
KNOWN_TERMINAL = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
~~~

Assert exact preservation of raw_status and triggered_by, Agent-ID ownership, aware timestamp conversion to UTC, missing timestamps as NULL, and sanitized error_summary. Derive `error_summary` only from an upstream string or an explicit string `message` member and pass it through Task 3's `sanitize_operator_text` with the active Core AI API key, local auth secret, and any other request-owned credential as `sensitive_values`; any other object, response, or body shape becomes the fixed generic operator message without calling `str`/`repr`. Inject the same sentinel into the raw page, then assert it is absent from `ParsedAgentRun`, its repr, SQLite, aggregate/history JSON, and captured logs. A naive or malformed timestamp becomes NULL with INVALID_STARTED_AT or INVALID_COMPLETED_AT; it is never replaced by observation time. A missing timestamp has no invalid-timestamp warning.

Accept Token usage only when both input and output are integers, are not booleans, and are non-negative. Test (0, 0) as known, either missing component as both NULL, negative/fractional/string values as both NULL, and TOKEN_USAGE_INVALID warning. Assert the parser result and its repr contain none of input, output, or error_stack from the upstream row.

Reject the whole response for missing/blank run ID, missing/blank status, missing/blank triggered_by, Agent-ID mismatch, a row that does not match an expected filtered status, duplicate conflicting rows, or returned rows greater than total. Unknown non-empty triggered_by values remain verbatim because they are trigger types, not user identities. Identical duplicate IDs may collapse to one validated row but do not count twice.

Assert projection readback stores simultaneous TOKEN_USAGE_INVALID and INVALID_COMPLETED_AT codes in canonical sorted data_warning_codes_json while leaving last_poll_error NULL. A later valid observation clears recovered Token/timestamp codes. These data-quality warnings do not make an otherwise valid status proof stale.

**Contract reference 4B: Transitions and receipts**

Cover these persisted transition rules:

~~~python
TRANSITION_CASES = [
    ("PENDING", "RUNNING", "RUNNING"),
    ("PENDING", "PAUSED", "PAUSED"),
    ("RUNNING", "PAUSED", "PAUSED"),
    ("PAUSED", "PENDING", "PENDING"),
    ("PAUSED", "RUNNING", "RUNNING"),
    ("RUNNING", "COMPLETED", "COMPLETED"),
    ("COMPLETED", "RUNNING", "COMPLETED"),
    ("COMPLETED", "FAILED", "COMPLETED"),
]
~~~

Parameterize one real seeded-row upsert test with TRANSITION_CASES. Assert terminal regression is ignored and a conflicting terminal or terminal-to-unknown observation preserves the first authoritative terminal payload tuple byte-for-byte: raw_status, trigger_type, started_at, completed_at, input/output Tokens, trace_id, error_summary, terminal_observed_at, and receipt_expires_at. `last_poll_attempt_at` may record every attempt, and `last_synced_at` may advance to the observation time of a later valid parsed list row carrying that exact Run ID even when its terminal status conflicts; this is identity/list confirmation metadata, not permission to borrow the later payload. The persistent TERMINAL_STATUS_CONFLICT warning/bookkeeping and owning sync-state conflict observation remain qualified, and the row can never become a hybrid `COMPLETED` record carrying later `FAILED` Token/error/time fields. An observation older than the stored last_synced_at cannot overwrite any payload field or move last_synced_at backward.

Also test unknown-to-known and known-nonterminal-to-unknown updates: both preserve the newly observed verbatim value and toggle unresolved-unknown proof state. A terminal-to-unknown observation keeps the full authoritative terminal tuple and records a conflict warning rather than regressing or borrowing any later payload field.

Receipt tests must freeze all branches:

- a valid completed_at with a local observation delta from 0 through 10 seconds gets receipt_expires_at = terminal_observed_at + 10 seconds;
- a valid future completed_at or delta over 10 seconds gets no receipt;
- missing completed_at gets a receipt only for an already mirrored non-terminal row whose previous last_synced_at is at most 15 seconds old;
- invalid or naive completed_at never uses the missing-value fallback;
- an unknown-future status transitioning to terminal with missing completed_at gets no receipt, because unknown is never assumed to have been a verified non-terminal state;
- initial old terminal backfill gets no receipt;
- repeating discovery never creates or extends receipt_expires_at;
- terminal_observed_at is written exactly once.

**Contract reference 4C: Local association**

Seed exact matches in each source:

~~~text
runs.id -> source_kind=run -> local_href=/runs/{runs.id}
task_executions.id -> source_kind=task_execution -> local_href=/tasks/{task_executions.task_id}
merchant_seo_artifacts.id -> source_kind=merchant_seo_artifact -> local_href=/merchants/{merchant_id}/profile
~~~

The resolver derives merchant_id and labels from those rows; no public helper accepts merchant_id as an independent association argument. Zero matches stays unassociated. Exactly one match binds. Multiple matches within runs, within task_executions, or across any two source tables leave an unbound projection unbound and return LOCAL_ASSOCIATION_CONFLICT. An already bound Run never moves even if a later conflicting match appears. Deleting a merchant sets projected merchant_id to NULL and suppresses stale local links without deleting Run history.

Assert association_preflight_warnings() reports every duplicated non-null Core AI Run ID and the source kinds involved without silently choosing one.

**Final Task 4 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 4D: Parser and immutable projection semantics**

Use immutable parsed values so the transaction cannot accidentally persist the original payload:

~~~python
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
~~~

For a new projection, set first_seen_at to the local observation time and last_synced_at only for a successfully parsed list response. For an existing row, compare aware last_synced_at with the response observation before applying data. Store exact raw status; classify only when reading. Enforce terminal guards in Python inside BEGIN IMMEDIATE, not only in UI code.

Use this once-only receipt decision before the terminal update:

~~~python
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
        return terminal_observed_at + timedelta(seconds=10) if 0 <= delta <= 10 else None
    if incoming.completed_at_state == "invalid":
        return None
    transitioned = previous_raw_status in KNOWN_NONTERMINAL
    recently_seen = (
        previous_last_synced_at is not None
        and 0 <= (terminal_observed_at - previous_last_synced_at).total_seconds() <= 15
    )
    return terminal_observed_at + timedelta(seconds=10) if transitioned and recently_seen else None
~~~

Do not expose a generic UPDATE that can mutate seo_ops_agent_id, source_kind, or source_local_id. Local registration may fill an empty binding but never overwrites an upstream-populated status. Discovery may fill an empty binding only through the zero/one/many resolver above.

`ParsedAgentRun.trigger_type` remains a required non-empty string because it comes only from a validated list row. The persistence column stays nullable: an immediate local trigger has no `triggered_by` field and stores NULL until the first list proof fills it. Never infer `MANUAL`, `WORKFLOW`, or another trigger type.

Use last_poll_error only for status-confirmation failure/absence on a row that already has a non-null status; a valid later status confirmation clears it. A NULL-status accepted marker instead carries `LOCAL_TRIGGER_STATUS_MISSING` in canonical `data_warning_codes_json` and cannot carry upstream poll fields while unresolved. Store Token/timestamp parser warnings in the same canonical sorted JSON string, replacing recovered observation warnings on a later valid row. Clear `LOCAL_TRIGGER_STATUS_MISSING` only when a valid page observes that exact ID and supplies the first non-empty status. Union TERMINAL_STATUS_CONFLICT into that JSON as a persistent code and never auto-clear it; the first terminal status remains authoritative and the conflict remains available for operator review. Freshness depends on sync-state and last_poll_error, never on data_warning_codes_json alone; an unresolved NULL status independently forces uncertain/static presentation.

- [ ] **Step 6: Run focused tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS for parser, transition, receipt, privacy, and association cases.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: project agent run summaries"
~~~

---

### Task 5: Expose coherent aggregate and cursor-based history snapshots

**Files:**
- Modify: api/app/agent_workbench.py
- Modify: api/tests/test_agent_workbench.py

**Interfaces:**
- Produces: build_workbench_snapshot(conn, range_key, now, timezone, history_limit) -> dict.
- Produces: list_projected_agent_runs(conn, local_agent_id, range_key, limit, before, now, timezone) -> dict.
- Adds: GET /api/agent-workbench?range=today|7d|30d|all.
- Adds: GET /api/agent-workbench/agents/{local_agent_id}/runs?range=30d&limit=20&before={opaque_cursor}.

**Mandatory vertical RED-GREEN order:** The reference sections below freeze data and edge cases; execute only these small tracked slices, in order, and keep each named `-k` selection green before moving on.

- [ ] Add `test_empty_workbench_snapshot_contract` with the frozen clock/no-Agent envelope; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k empty_workbench_snapshot_contract)` and observe the missing-builder failure.
- [ ] Implement range validation plus the empty top-level envelope in `build_workbench_snapshot`; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_empty_workbench_snapshot_contract)`.
- [ ] Add `test_snapshot_warning_association_and_agent_shapes` for the exact warning, association, signal, registry, and Agent nullability contracts; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the typed row serializers needed by that shape test; rerun it to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add `test_status_classifier_truth_table`; run the literal command at the end of this step and observe RED for the ten frozen rows, including the NULL accepted/unconfirmed marker. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Implement the centralized raw-status classifier; rerun the classifier selection to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Add `test_calendar_range_boundaries`, one Asia/Shanghai case at a time and then the New York DST case; run the literal command at the end of this step after each assertion and keep the latest case RED until the boundary helper is extended. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement each calendar boundary branch in the API timezone helper; finish with the entire boundary selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add `test_range_metric_truth_table` for Run/outcome/success/Token membership and lifecycle inclusion; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only selected-range metric aggregation; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add `test_current_count_quality_truth_table` for exact/lower-bound/unknown/no-active/legacy cases; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Implement per-Agent then aggregate CurrentCount composition; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Add `test_aggregate_health_and_freshness_fields` for sync_health/stale/watermarks/incomplete-statuses/deadlines; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement the health, conservative watermark, incomplete-status union, and fresh-until helpers; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add `test_sync_pending_never_reuses_old_complete_proof`; seed internally inconsistent old exact qualities with active `sync_pending=1`, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Treat sync_pending as an effective unknown/incomplete freshness barrier in every aggregate/Agent/signal DTO until a complete new proof clears it; rerun until counts are qualified, cached signals static, and idle impossible. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Add `test_aggregate_coverage_sum_max_min_and_nulls` with the three-Agent fixture; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement coverage aggregation without touching current-count code; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add `test_unconfirmed_local_run_invalidates_effective_history_proof`; start from persisted exact-zero history, insert first a known-status local row and then a NULL-status marker with `last_synced_at=NULL`, and assert each case exposes mirrored 1, effective remote total NULL, history/range/metrics incomplete, a stable unconfirmed warning, and never a usable 1/0 ratio; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Derive the unconfirmed-row barrier from SQLite without erasing the last observed persisted total/coverage; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Add `test_remote_total_below_mirrored_is_never_usable`; confirm the exact local ID through a filtered page while an inconsistent unfiltered total remains zero, then assert effective total NULL plus `REMOTE_TOTAL_BELOW_MIRRORED`; feed a valid unfiltered total/page containing the ID and require effective 1/1 plus complete coverage only then. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_remote_total_below_mirrored_is_never_usable)`.
- [ ] Implement the total-consistency barrier and proof-restoration rule; rerun both coverage selections to green without clamping or inventing an upstream total. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k 'test_unconfirmed_local_run_invalidates_effective_history_proof or test_remote_total_below_mirrored_is_never_usable')`.
- [ ] Add `test_stage_signal_truth_table` for known, NULL-status, unknown, cached, and lifecycle-qualified non-terminal signals; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement signal selection/sorting and per-Agent freshness only; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add `test_signal_suspect_boundary_and_deadline`; freeze PENDING/RUNNING one millisecond before/at the local threshold plus old PAUSED, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Derive nullable `suspect_at`, include it in signal/Agent/aggregate downgrade boundaries, and at the boundary emit uncertain/static `状态待确认` without changing raw_status; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Add `test_refresh_after_clamps_due_retry_to_one_second`; set persisted retry/due timestamps before and equal to `snapshot_at`, require `refresh_after_ms=1000`, and observe RED rather than a zero/negative server recommendation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_clamps_due_retry_to_one_second)`.
- [ ] Clamp the server-computed retry delay to 1000..60000 milliseconds before taking it against the 5/30-second base; rerun the literal command to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_clamps_due_retry_to_one_second)`.
- [ ] Add `test_archiving_and_terminal_receipts` for exact source status, list-confirmed versus immediate-terminal-unconfirmed freshness, delay, expiry, and cadence; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement local archiving/receipt overlays without rewriting raw status; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add `test_history_cursor_round_trip_and_bounds`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement versioned cursor encode/decode, stable ordering, and clamped page size; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add `test_history_privacy_and_warning_projection`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] Implement the narrow history serializer and warning-code mapping; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] Add `test_workbench_get_routes_contract_and_auth`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] Wire only the two authenticated GET routes to the green helpers; rerun that route selection to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] Fill the canonical multi-Agent `EXPECTED_WORKBENCH_SNAPSHOT`, assert exact equality in `test_workbench_snapshot_contract`, and observe RED at the first missing/mismatched field. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_snapshot_contract)`.
- [ ] Correct only the serializer/composition field exposed by each failure and finish the focused contract selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_snapshot_contract)`.
- [ ] Run the complete Task 5 test file, then perform the exact non-interactive commit in the final checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)`.

**Contract reference 5A: Canonical cross-end aggregate fixture**

Reuse the Task 3 test-local FastAPI app until Task 7 wires the production router. Omitted range defaults to 30d and any other value is 422. Create a module-level EXPECTED_WORKBENCH_SNAPSHOT fixture in the test file and assert exact equality, not selected fields. It must contain these top-level keys and shapes:

~~~typescript
type AgentWorkbenchSnapshot = {
  snapshot_at: string
  last_complete_discovery_at: string | null
  sync_health: 'fresh' | 'partial' | 'stale' | 'unavailable' | 'not_configured'
  stale: boolean
  current_state_complete: boolean | null
  current_state_checked_at: string | null
  current_state_incomplete_statuses: Array<'PENDING' | 'RUNNING' | 'PAUSED' | 'UNKNOWN'>
  fresh_until: string | null
  has_active_runs: boolean | null
  has_queued_runs: boolean | null
  has_waiting_runs: boolean | null
  current_counts: {
    running: CurrentCount
    queued: CurrentCount
    waiting: CurrentCount
    legacy_nonterminal: CurrentCount
  }
  refresh_after_ms: number
  range: 'today' | '7d' | '30d' | 'all'
  timezone: string
  range_start: string | null
  range_end: string
  metrics_complete_for_range: boolean
  coverage: CoverageSummary
  summary: RangeMetrics
  signals: WorkbenchSignal[]
  agents: WorkbenchAgent[]
  sync_warnings: WorkbenchWarning[]
}

type CurrentCount = {
  value: number | null
  quality: 'exact' | 'lower_bound' | 'unknown'
  last_observed_value: number | null
  last_observed_at: string | null
}

type RangeMetrics = {
  run_count: number
  terminal_runs: number
  successful_runs: number
  success_rate: number | null
  known_input_tokens: number
  known_output_tokens: number
  known_total_tokens: number
  token_known_runs: number
  token_eligible_runs: number
}

type CoverageSummary = {
  mirrored_run_count: number
  remote_total_runs: number | null
  history_complete: boolean
  range_complete: boolean
  coverage_start_at: string | null
  coverage_as_of: string | null
}
~~~

Freeze the warning and association structures exactly:

~~~typescript
type WorkbenchWarning = {
  code: string
  message: string
  local_agent_id: string | null
  coreai_run_id: string | null
}

type LocalAssociation = {
  kind: 'run' | 'task_execution' | 'merchant_seo_artifact'
  source_local_id: number
  merchant_id: number | null
  merchant_name: string | null
  local_href: string | null
  local_label: string
}
~~~

Freeze the signal contract, including every nullable boundary:

~~~typescript
type WorkbenchSignal = {
  coreai_run_id: string
  local_agent_id: string
  agent_name: string
  agent_role: string
  lifecycle_status: 'active' | 'disabled' | 'retired'
  agent_current_state_complete: boolean
  raw_status: string | null
  presentation_group: 'queued' | 'active' | 'waiting' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'unknown'
  signal_state: 'queued' | 'active' | 'waiting' | 'uncertain' | 'archiving' | 'completed'
  trigger_type: string | null
  fresh: boolean
  suspect: boolean
  suspect_reason: string | null
  started_at: string | null
  effective_started_at: string
  completed_at: string | null
  terminal_observed_at: string | null
  receipt_expires_at: string | null
  elapsed_seconds: number
  last_synced_at: string | null
  fresh_until: string | null
  suspect_at: string | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  token_state: 'known' | 'pending' | 'unavailable' | 'unconfirmed'
  association: LocalAssociation | null
}
~~~

`presentation_group` is classified once on the server and serialized on both signal and history DTOs; React renders it and must not independently remap raw statuses. `raw_status=NULL` is the durable, source-associated marker for an accepted local Run whose trigger response omitted status and whose exact ID has not yet appeared in a valid list response. It serializes as `presentation_group='unknown'`, a static `状态待确认（上游未返回状态）` signal, and warning `LOCAL_TRIGGER_STATUS_MISSING`; it never becomes a fabricated Core AI status. `trigger_type=NULL` means an immediate local projection has not yet been confirmed by a list response. `agent_current_state_complete` belongs to that producing Agent; aggregate `current_state_complete` is used for all-idle claims, not to suppress an independently healthy Agent.

Freeze the remaining reusable structures exactly:

~~~typescript
type ProjectedRunSummary = {
  coreai_run_id: string
  raw_status: string | null
  presentation_group: 'queued' | 'active' | 'waiting' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'unknown'
  trigger_type: string | null
  started_at: string | null
  effective_started_at: string
  completed_at: string | null
  terminal_observed_at: string | null
  receipt_expires_at: string | null
  elapsed_seconds: number
  duration_seconds: number | null
  input_tokens: number | null
  output_tokens: number | null
  total_tokens: number | null
  token_state: 'known' | 'pending' | 'unavailable' | 'unconfirmed'
  last_synced_at: string | null
  suspect: boolean
  suspect_reason: string | null
  archiving: boolean
  archive_delayed: boolean
  warning_codes: string[]
  association: LocalAssociation | null
  error_summary: string | null
}

type AgentRegistryRecord = {
  id: string
  agent_key: string
  coreai_agent_id: string
  display_name: string
  role: string
  sort_order: number
  lifecycle_status: 'active' | 'disabled' | 'retired'
  coreai_metadata: {
    name: string | null
    model: string | null
    timeout_hint_seconds: number | null
    last_verified_at: string | null
    verification_error: string | null
  }
  suspect_after_seconds: number
  sync_pending: boolean
}

type WorkbenchAgent = AgentRegistryRecord & {
  sync: {
    health: 'fresh' | 'stale' | 'unavailable'
    last_discovery_attempt_at: string | null
    last_discovery_success_at: string | null
    discovery_error: string | null
    current_state_checked_at: string | null
    current_state_error: string | null
    next_discovery_at: string | null
    last_fast_poll_attempt_at: string | null
    last_fast_poll_success_at: string | null
    fast_poll_error: string | null
  }
  current_state_complete: boolean
  current_counts: {
    running: CurrentCount
    queued: CurrentCount
    waiting: CurrentCount
  }
  range_metrics: RangeMetrics
  coverage: CoverageSummary
  last_terminal_run: ProjectedRunSummary | null
  warnings: WorkbenchWarning[]
}
~~~

Mutation responses use AgentRegistryRecord rather than pretending that a single mutation already recomputed WorkbenchAgent metrics. Every WorkbenchSignal contains the fields listed above plus signal_state/fresh/fresh_until and Agent identity/lifecycle fields.

**Contract reference 5B: Range and metric truth tables**

Freeze calendar boundaries in Asia/Shanghai for today, preceding 7 local dates, preceding 30 local dates, and all. Add one America/New_York DST-boundary test to prove ranges use local calendar midnights rather than subtracting fixed 24-hour durations. Membership uses started_at, then first_seen_at. The end is exclusive next local midnight.

Assert:

- Run count includes every mirrored accepted Run except exact SKIPPED, including a NULL-status confirmation marker and an unknown future status.
- A NULL-status confirmation marker or unknown future status increments Run count and remains outside terminal/success/Token-eligibility populations. Across active, disabled, or retired registry records, either always adds aggregate UNKNOWN, stays a static signal, and blocks the all-idle claim while unresolved; it makes `metrics_complete_for_range` false only when its effective start belongs to the selected range. Known current running/queued/waiting counts remain active-only, and the legacy count remains the three known non-terminal statuses only.
- terminal_runs and the success denominator include COMPLETED, FAILED, TIMEOUT, and CANCELLED only.
- successful_runs includes COMPLETED only.
- success_rate is NULL when terminal_runs is zero.
- known Token sums use only terminal non-skipped Runs with both components known.
- token_known_runs/token_eligible_runs are always returned, including 0/0.
- selected-range metrics include active, disabled, and retired Agents.
- current running/queued/waiting counts include active Agents only.
- legacy_nonterminal includes disabled/retired PENDING, RUNNING, and PAUSED without making them live.

Freeze one table-driven classifier used by aggregate, history, and signals:

~~~text
PENDING    -> queued    | counts as Run | non-terminal | Token-ineligible
RUNNING    -> active    | counts as Run | non-terminal | Token-ineligible
PAUSED     -> waiting   | counts as Run | non-terminal | Token-ineligible
COMPLETED  -> success   | counts as Run | outcome      | Token-eligible
FAILED     -> failure   | counts as Run | outcome      | Token-eligible
TIMEOUT    -> failure   | counts as Run | outcome      | Token-eligible
CANCELLED  -> cancelled | counts as Run | outcome      | Token-eligible
SKIPPED    -> skipped   | excluded      | excluded     | Token-ineligible
other text -> unknown   | counts as Run | excluded     | Token-ineligible/static
NULL       -> unknown   | counts as Run | excluded     | Token-ineligible/static; accepted, status unconfirmed
~~~

Assert exact `presentation_group`, Run-count membership, success denominator membership, Token eligibility, and default signal motion eligibility for every row. Local `archiving` and receipt `completed` are overlays derived only after this raw classifier; they do not rewrite `presentation_group`.

Derive the same server-side `token_state` for `WorkbenchSignal` and `ProjectedRunSummary`: `known` only for a list-confirmed Token-eligible terminal status with a valid pair (including zero); `unavailable` for a list-confirmed Token-eligible terminal status whose pair is absent/invalid and for list-confirmed exact SKIPPED; `pending` for known PENDING/RUNNING/PAUSED regardless of any premature usage values; and `unconfirmed` for `raw_status=NULL`, a non-empty future status whose terminal/eligibility meaning is unknown, or an immediate known terminal/SKIPPED row whose `last_synced_at` is still NULL. Exact-shape and classifier tests assert all four branches, and the browser only formats the serialized value.

**Contract reference 5C: Quality, health, freshness, and coverage**

Aggregate count quality is exact only when every included active Agent's corresponding set is exact; lower_bound when at least one is lower_bound and none is unknown; unknown when any is unknown. For unknown, value is NULL and last_observed_value is the sum of last valid observations; last_observed_at is the oldest contributing time. has_* is true when a valid current response proves at least one, false only for exact zero, and NULL otherwise.

`sync_pending=1` is an overriding current-proof barrier for an active Agent, even if a legacy/inconsistent row still contains exact qualities or recent timestamps: serialize all three of that Agent's effective CurrentCounts as unknown with preserved last-observed evidence, `current_state_complete=false`, health no better than partial, and no proof/signal fresh boundary. This defense complements Task 3's transactional re-enable invalidation and prevents stale archival proof from enabling idle or motion before a complete new-epoch discovery clears sync_pending.

When there is no active Agent, running/queued/waiting are exact zero and has_* is false, but current_state_complete is NULL and sync_health is not_configured, so the stage still cannot say 当前全部空闲. legacy_nonterminal combines PENDING/RUNNING/PAUSED qualities across disabled and retired Agents: exact only when every included archival set is exact, lower_bound when none is unknown and at least one is truncated, and unknown when any included set is unknown. With no disabled/retired Agent it is exact zero.

Test per-Agent `fresh`/`stale`/`unavailable` separately, and aggregate `fresh`/`partial`/`stale`/`unavailable`/`not_configured` separately; per-Agent serializers never emit aggregate-only `partial` or `not_configured`. Missing Core AI base URL/key forces active Agents to unavailable even when cached timestamps are recent, while persisted registry/history remains in the response. For an active Agent compute fresh_until as the earliest of:

~~~text
last_discovery_success_at + 90 seconds
current_state_checked_at + 90 seconds
each non-suspect PENDING/RUNNING last_synced_at + 15 seconds
each non-suspect PENDING/RUNNING effective_started_at + suspect_after_seconds
~~~

A snapshot generated at or after the boundary is already stale. For each PENDING/RUNNING signal return derived `suspect_at = effective_started_at + suspect_after_seconds`; PAUSED, terminal, archiving, and unknown signals return NULL. At or beyond that instant the server emits `suspect=true`, `signal_state='uncertain'`, `fresh=false`, and `状态待确认` presentation data without changing raw_status. Metadata verification failure adds a warning but does not suppress independently fresh list state. last_complete_discovery_at is NULL until every active Agent has a successful unfiltered discovery; afterward it is the oldest last_discovery_success_at among those active Agents, so it is a conservative full-registry watermark even when later health becomes partial.

Use a two-Agent truth-table fixture for the remaining top-level compatibility fields. `stale` is true exactly for `sync_health` partial/stale/unavailable and false for fresh/not_configured. `current_state_checked_at` is the oldest latest current-proof attempt among active Agents and is NULL with no active Agent. `current_state_incomplete_statuses` is the stable de-duplicated union, ordered PENDING, RUNNING, PAUSED, UNKNOWN: include each known status when any active Agent's corresponding quality is not exact, and include UNKNOWN when any active, disabled, or retired Agent has either an accepted NULL-status marker or an unresolved non-empty unknown-status row. Assert one healthy Agent cannot erase another Agent's incomplete member.

Assert a failed latest fast confirmation makes that Run and Agent stale/static immediately even when its preceding last_synced_at is less than 15 seconds old. Age is an upper bound for a successful confirmation, not permission to ignore a newer failed attempt.

Treat persisted `remote_total_runs`, returned count, and coverage boundary as the last upstream observation, not automatically as a currently usable denominator. Derive durable `history_dirty = unfiltered_proven_event_epoch IS NULL OR unfiltered_proven_event_epoch < history_event_epoch`, and independently derive `has_unconfirmed_local_run` from any projected row with `last_synced_at IS NULL`. While either is true, expose effective `coverage.remote_total_runs=NULL`, `history_complete=false`, `range_complete=false`, and `metrics_complete_for_range=false`, while retaining the last observed values in SQLite; emit deterministic `HISTORY_PROOF_DIRTY`, plus `LOCAL_RUN_UNCONFIRMED` and, for nullable status, `LOCAL_TRIGGER_STATUS_MISSING` when applicable. This applies to immediate known, terminal/SKIPPED, unknown-future, and NULL-status projections alike. A post-event exact-zero or filtered-only confirmation cannot produce `基于已镜像 1/0 次`, reuse an old truncated coverage boundary, or restore coverage.

Even after every row has a successful list observation, a persisted upstream total smaller than `mirrored_run_count` is contradictory rather than a denominator: expose effective total NULL, keep history/range/metrics incomplete, and emit `REMOTE_TOTAL_BELOW_MIRRORED`. Never clamp either side or invent a corrected total. Clear that derived warning only after a valid unfiltered response supplies a total at least as large as the mirrored count and the normal coverage proof passes.

Otherwise, history is complete only when the latest valid unfiltered response is untruncated, `unfiltered_proven_event_epoch == history_event_epoch`, `last_discovery_returned_count == remote_total_runs == mirrored_run_count`, and its returned ID set has been projected for that Agent. A truncated response proves a finite range only when coverage_start_at is present, range_start >= coverage_start_at, the two history epochs are equal, no unconfirmed row exists, and the effective total is usable. all is complete only with complete history. metrics_complete_for_range additionally requires each included Agent's latest due discovery to have succeeded and no unresolved uncertain, NULL-status, or unknown-status Run in range. Assert every incomplete metric includes mirrored/remote/coverage qualifiers in the response.

Aggregate mirrored_run_count always sums local rows. Aggregate remote_total_runs is NULL if any included Agent has never produced an unfiltered total or its effective total is unusable because of a dirty history generation, unconfirmed local row, or total contradiction; otherwise it is the sum. Aggregate coverage_start_at is the latest per-Agent last-observed boundary and coverage_as_of is the oldest per-Agent discovery success; either is NULL when any included Agent has never produced that observation, while the completeness booleans/dirty warning determine whether those timestamps are usable proof.

Use a three-Agent fixture with different totals/boundaries/success times to assert those sum/max/min rules exactly, then NULL one Agent's total/boundary/success in separate cases and assert the corresponding aggregate field becomes NULL without erasing mirrored_run_count.

**Contract reference 5D: Stage signals and local archiving**

Signals include:

- active-registry PENDING/RUNNING/PAUSED rows from the latest proof;
- every unresolved row from an active, disabled, or retired registry record with either `raw_status=NULL` or a non-empty unknown future raw status, as lifecycle-qualified uncertain/static until a later valid list observation of that exact ID resolves it, so the operator sees the accepted/upstream state even though it cannot contribute to a known current bucket;
- cached non-terminal rows whose proof failed, as uncertain and static;
- disabled/retired non-terminal rows, as lifecycle-qualified and static;
- terminal rows with an unexpired receipt;
- terminal associated rows whose exact local source status is still running, as archiving.

Only local runs.status=running, task_executions.status=running, and merchant_seo_artifacts.status=running mean archiving. After five minutes from immutable terminal_observed_at, remove the archiving item from signals and add ARCHIVE_DELAY to its Agent/history row. An unassociated terminal Run is never archiving. Active PENDING/RUNNING signal fresh_until is the minimum of its Agent proof boundary, last_synced_at+15 seconds, and suspect_at; PAUSED uses the Agent proof boundary and remains static; NULL-status/unknown/cached/legacy non-terminal signals have fresh=false and fresh_until=NULL. Add active/disabled/retired NULL-status and unknown-status fixtures and assert they remain visible/static and prevent `当前全部空闲` even beside an otherwise exact-zero active Agent. Terminal receipts are static with fresh=false/fresh_until=NULL and use receipt_expires_at as their separate lifetime. A list-confirmed terminal row (`last_synced_at IS NOT NULL`, no later poll error, and otherwise valid owning proof) whose exact local source is still running may expose its local archiving claim as `fresh=true` with `fresh_until=snapshot_at+15 seconds`; an immediate-terminal row that is still awaiting exact-ID list confirmation remains archiving-but-unconfirmed with `fresh=false`/`fresh_until=NULL`. Both are static, and either in-window archiving presence independently selects the five-second browser cadence without using `fresh=true` as a proxy. Sort signals by effective_started_at descending, then coreai_run_id descending.

**Contract reference 5E: History cursor and privacy**

The history envelope is exact:

~~~json
{
  "items": [],
  "next_before": null,
  "range": "30d",
  "timezone": "Asia/Shanghai",
  "range_start": "2026-08-04T16:00:00+00:00",
  "range_end": "2026-09-03T16:00:00+00:00"
}
~~~

Freeze the request clock at `2026-09-03T04:00:00+00:00`, which yields those exact Asia/Shanghai 30-day boundaries.

Sort by (effective_started_at DESC, coreai_run_id DESC). Default limit is 20; clamp values below 1 to 1 and above 100 to 100. before is a URL-safe base64 encoding of a versioned JSON tuple [1, effective_started_at, coreai_run_id]. Reject malformed version/type/time/cursor with 422; return 404 for an unknown local Agent. Each ProjectedRunSummary exposes only projected status/timing/Token/trigger/error-summary/association fields plus canonical `warning_codes` derived from its persisted warning JSON; it never exposes full Core AI content. Include `LOCAL_TRIGGER_STATUS_MISSING`, `TERMINAL_STATUS_CONFLICT`, Token/timestamp warning codes, and `ARCHIVE_DELAY` when applicable so history can render factual per-Run warnings without depending on the aggregate warning list.

**Final Task 5 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 5F: Range, aggregate, signals, and history**

Keep SQL parameterized and calculate current state independently from the historical range. Centralize status sets and derive effective_started_at once:

~~~python
OUTCOME_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"}
SUCCESS_STATUSES = {"COMPLETED"}

def counts_as_run(raw_status: str | None) -> bool:
    return raw_status != "SKIPPED"

def effective_started_at(row: sqlite3.Row) -> datetime:
    return parse_utc(row["started_at"]) if row["started_at"] else parse_utc(row["first_seen_at"])
~~~

Build one read transaction so agents, metrics, current qualities, signals, and warnings describe the same SQLite snapshot. Generate snapshot_at once at response start. Return server-prepared local_href/local_label; the browser must never reverse-map task_execution IDs.

Within that same transaction compute per-Agent mirrored/unconfirmed counts and compare `history_event_epoch` with `unfiltered_proven_event_epoch` before serializing coverage. If the generation is dirty, any row has `last_synced_at IS NULL`, or the persisted upstream total is lower than mirrored count, expose the effective remote total as NULL and force history/range/metric completeness false without overwriting persisted last-observed fields. Emit `HISTORY_PROOF_DIRTY`, `LOCAL_RUN_UNCONFIRMED`, or `REMOTE_TOTAL_BELOW_MIRRORED` from those facts. Only the later valid unfiltered/list proof defined in Contract 5C removes the corresponding barrier; formatting code must never clamp `M`, divide by zero, or render `N/0` when N is positive.

sync_warnings is the stable, de-duplicated union of bootstrap_configuration_warnings(), association_preflight_warnings(), per-Agent discovery/current/metadata warnings, local Run confirmation/NULL-status warnings, unusable-total warnings, unknown-status warnings, Token/timestamp data warnings, terminal conflicts, and archive delays. Sort by code, local_agent_id, then coreai_run_id so equal snapshots serialize deterministically; never include upstream payloads or credentials.

Set refresh_after_ms to 5000 when a fresh queued/active signal or any in-window local archiving signal exists; otherwise 30000. When health is partial/stale, clamp the earliest persisted retry delay to 1000..60000 milliseconds first, then use the earlier of that value and the base cadence. A due-at/before-snapshot event therefore recommends one immediate-next browser read after one second, never 0/negative or a busy loop. Never let one failing Agent override a healthy active five-second signal.

- [ ] **Step 8: Run focused tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

Expected: PASS for exact snapshots, ranges, coverage, signals, and cursors.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: serve agent workbench snapshots"
~~~

---

### Task 6: Implement fenced adaptive synchronization

**Files:**
- Modify: api/app/agent_workbench.py
- Create: api/tests/test_agent_workbench_sync.py

**Interfaces:**
- Produces: claim_due_run_sync(conn, local_agent_id, owner, now) -> AgentRunSyncLease | None and claim_due_metadata_sync(...) -> AgentMetadataLease | None on independent lease columns.
- Produces: renew_run_lease/renew_metadata_lease plus commit_discovery_cycle/commit_metadata_verification, each fenced only by its own owner+epoch+expiry and lifecycle/event generation.
- Produces: list_due_run_agent_ids(conn, now) and list_due_metadata_agent_ids(conn, now), each ordered by its own due time then local ID.
- Produces: prime_agent_workbench_startup(conn, startup_at) -> None.
- Produces: sync_registered_agent_runs_once(...) -> bool and verify_registered_agent_metadata_once(...) -> bool, with separately owned clients/connections.
- Produces: agent_workbench_sync_loop() -> None.
- Guarantees: no upstream network call inside a SQLite transaction, no response commit without the matching lane's live owner+epoch fence, and slow metadata can never own or block a Run-status lease/worker slot.

**Mandatory vertical RED-GREEN order:** Use the detailed references below as acceptance criteria, but build the engine through these independently runnable slices.

- [ ] Add the list-only fake/call recorder and its close/get_run guard; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q --collect-only)` and make collection pass before production edits.
- [ ] Add `test_claim_and_release_independent_leases`; claim run and metadata lanes concurrently for the same Agent, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_claim_and_release_independent_leases)`.
- [ ] Implement separate conditional owner/epoch/expiry columns and matching-lane release only; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_claim_and_release_independent_leases)`.
- [ ] Add `test_independent_lease_renewal_and_expiry`; run each lane's matching/wrong/expired case and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)`.
- [ ] Implement `renew_run_lease` and `renew_metadata_lease` without cross-lane mutation; rerun the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)`.
- [ ] Add `test_full_discovery_proof`; run the literal command at the end of this step and observe RED for the exact four calls. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_discovery_proof)`.
- [ ] Implement one serialized per-Agent request plan and parsed in-memory CycleResult, without concurrency; rerun until the four-call selection is green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_discovery_proof)`.
- [ ] Add `test_cycle_commits_atomically_and_schedules`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Implement only the `BEGIN IMMEDIATE` owner/epoch/expiry/event fence and false/no-write exit in `commit_discovery_cycle`; rerun the literal command at the end of this step and keep the still-missing atomic-write assertion RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Add one assertion that all four parsed page outcomes appear together or none do when a forced upsert fails; run the literal command and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Implement only the four-page projection/upsert unit inside the existing transaction; rerun the literal command and keep the missing-schedule assertion RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Add one assertion for the exact next-discovery/fast due values and lease release after commit; run the literal command and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Implement only cadence/backoff scheduling and matching-lane release; rerun the literal command until the transaction test is green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)`.
- [ ] Add `test_projection_revision_tracks_material_change_not_heartbeat`; run identical-proof, status, Token, association, quality/error, and receipt cases one at a time and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)`.
- [ ] Increment `projection_revision` once per transaction only when one of those semantic fields changes; keep timestamp/due/lease-only heartbeats stable and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)`.
- [ ] Add `test_local_registration_after_response_before_commit_blocks_idle`; pause an exact-zero cycle after all four responses, insert one local RUNNING projection through a second connection, then run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_local_registration_after_response_before_commit_blocks_idle)`.
- [ ] Add the in-transaction local-event barrier: after page upserts, reread locally unconfirmed rows and refuse any exact bucket/current proof that did not observe their Run IDs in this cycle; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_local_registration_after_response_before_commit_blocks_idle)`.
- [ ] Add `test_every_unconfirmed_raw_status_requires_exact_id_observation`; seed `last_synced_at=NULL` rows for PENDING/RUNNING/PAUSED, all five terminal/SKIPPED values, a future status, and NULL; feed a post-event exact-zero cycle and require the appropriate/all bucket uncertainty, static presentation, unusable history proof, and bounded 5/30-second confirmation schedule for every row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)`.
- [ ] Generalize the exact-ID barrier across the full status classifier, with five-second retry only for known PENDING/RUNNING and no-later-than-30-second full discovery for every other unconfirmed row; rerun to green without a due-now busy loop. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)`.
- [ ] Add `test_filtered_only_new_identity_keeps_history_generation_dirty`; start from truncated unfiltered total 500/mirrored 200 with a usable finite-range boundary, insert/confirm a new local ID through a fast filtered page only, and require mirrored 201, persisted total/boundary retained, effective total NULL, and history/range/metrics incomplete across restart; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_only_new_identity_keeps_history_generation_dirty)`.
- [ ] Increment `history_event_epoch` once per distinct new Run identity and advance `unfiltered_proven_event_epoch` only from a valid post-generation unfiltered page; rerun the filtered-only case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_only_new_identity_keeps_history_generation_dirty)`.
- [ ] Add `test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty`; in cycle one create a filtered-only in-range ID, then in cycle two return a valid truncated unfiltered page that still omits it; run the literal command at the end of this step and observe RED if the proven epoch advances. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty)`.
- [ ] Add the restart-safe truncated-page proof guard using only persisted fields: require every projected ID with valid upstream start at or after the new `coverage_start_at` to occur in that unfiltered returned-ID set, and conservatively block advancement when any projected row has missing/invalid upstream `started_at`; rerun the omission selection to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty)`.
- [ ] Add `test_truncated_history_cannot_catch_up_with_any_missing_started_at`; seed an older otherwise-clean projected row whose upstream start is NULL, restart the database, and prove a later truncated page cannot advance the epoch even when every in-bound valid-start ID is present; then supply an untruncated exact-ID page and require safe recovery. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_history_cannot_catch_up_with_any_missing_started_at)`.
- [ ] Extend the truncated-page test with a third cycle that includes the dirty in-range ID and a consistent total/boundary; require the epochs to become equal and finite-range coverage to recover only then. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_history_cannot_catch_up_with_any_missing_started_at)`.
- [ ] Add `test_untruncated_unfiltered_requires_exact_projected_id_set`; omit one existing projected ID from an otherwise untruncated page and observe RED, then require exact set equality before advancing the proven epoch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_untruncated_unfiltered_requires_exact_projected_id_set)`.
- [ ] Add `test_filtered_set_quality_truth_table`, one exact/lower-bound/unknown row at a time; run the literal command at the end of this step after each addition. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)`.
- [ ] Implement the matching quality/error preservation branch after each failing case; finish the selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)`.
- [ ] Add `test_same_cycle_status_conflict_blocks_complete_proof`; cover the same Run ID in PENDING+RUNNING and terminal-unfiltered+RUNNING cases, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)`.
- [ ] Apply Task 4 transition guards in deterministic observation order plus conflict-qualified buckets/current state; rerun to green, then add a stable following cycle that clears only the transient current-proof conflict. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)`.
- [ ] Add `test_failed_fast_confirmation_revokes_motion`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_failed_fast_confirmation_revokes_motion)`.
- [ ] Implement run-specific attempt/error updates without status regression; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_failed_fast_confirmation_revokes_motion)`.
- [ ] Add `test_fast_confirmation_deduplicates_status_calls`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_fast_confirmation_deduplicates_status_calls)`.
- [ ] Implement distinct-status five-second request planning; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_fast_confirmation_deduplicates_status_calls)`.
- [ ] Add `test_transition_resolution_merge_and_absence`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_transition_resolution_merge_and_absence)`.
- [ ] Implement same-cycle merge, bounded unfiltered fallback, and uncertainty; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_transition_resolution_merge_and_absence)`.
- [ ] Add `test_metadata_failure_does_not_block_list_proof`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_failure_does_not_block_list_proof)`.
- [ ] Implement separate metadata outcome/backoff commit while the Run worker completes its list plan independently; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_failure_does_not_block_list_proof)`.
- [ ] Add `test_metadata_only_due_success_and_failure`; parameterize success/failure with due `next_verification_at`, future `next_discovery_at`, and no fast status due, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)`.
- [ ] Implement the metadata-only request plan: exactly one `get_agent()` and zero list calls, changing only metadata verification/cache/error/backoff fields while preserving every current-quality/count, discovery/fast timestamp, `next_discovery_at`, and projected Run; rerun both branches to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)`.
- [ ] Add `test_blocked_metadata_never_delays_fast_or_full_proof`; hold `get_agent()` behind a threading.Event as five-second fast and thirty-second discovery work become due for the same Agent, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_blocked_metadata_never_delays_fast_or_full_proof)`.
- [ ] Split metadata into its own client/connection/lease/task pool; require the due status lists to commit while metadata remains blocked, preserve RUNNING motion eligibility, then release metadata and commit only verification fields; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_blocked_metadata_never_delays_fast_or_full_proof)`.
- [ ] Add `test_sync_diagnostics_redact_secrets`; inject unique sentinels through a transport exception and 500 text/JSON body, plus a dedicated successful Run-list row's explicit string `error`/`message`, Bearer label, and sensitive URL query; capture logs and every persisted error column and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)`.
- [ ] Map transport, HTTP, malformed-envelope, and arbitrary exception failures directly to fixed Workbench-owned codes/messages without inspecting `CoreAiError.args`, `str(exc)`, repr, response body, or cause. Route only a successfully parsed Run row's dedicated string `error` or string `message` member through `sanitize_operator_text(..., sensitive_values=...)`; rerun until all transport/body sentinels are absent from logs, HTTP/background results, exception repr, `last_verification_error`, `last_discovery_error`, `current_state_error`, `last_fast_poll_error`, projected `last_poll_error`, and `error_summary`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)`.
- [ ] Add `test_lifecycle_cadence_and_backoff`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_lifecycle_cadence_and_backoff)`.
- [ ] Implement per-lifecycle due times and per-Agent bounded retries; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_lifecycle_cadence_and_backoff)`.
- [ ] Add `test_disabled_and_retired_archival_four_call_cycle`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)`.
- [ ] Extend lifecycle request planning to keep all four bounded reads and merge old non-terminal rows while preserving static lifecycle qualification; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)`.
- [ ] Add `test_startup_priming_and_dedup_window`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_startup_priming_and_dedup_window)`.
- [ ] Implement due-now priming without lease mutation; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_startup_priming_and_dedup_window)`.
- [ ] Add `test_two_agent_timeout_isolation`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_two_agent_timeout_isolation)`.
- [ ] Implement per-Agent `asyncio.to_thread` tasks and reaping/fill behavior; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_two_agent_timeout_isolation)`.
- [ ] Add `test_supervisor_caps_and_refills_seventeen_agents`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_caps_and_refills_seventeen_agents)`.
- [ ] Implement the eight-task cap, due ordering, and local in-flight map; rerun both 12/17-Agent cases to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_caps_and_refills_seventeen_agents)`.
- [ ] Add `test_expired_or_reacquired_lease_discards_response`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)`.
- [ ] Implement the pre-request renewal and pre-commit fence reread; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)`.
- [ ] Add `test_inflight_lifecycle_change_controls_next_cadence`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_inflight_lifecycle_change_controls_next_cadence)`.
- [ ] Implement lifecycle reread inside the fenced commit; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_inflight_lifecycle_change_controls_next_cadence)`.
- [ ] Add `test_disabled_cycle_cannot_satisfy_reenable_proof`; pause an archival cycle after its responses, re-enable through a second connection, then run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_cycle_cannot_satisfy_reenable_proof)`.
- [ ] Reuse the captured `local_event_epoch` fence so the old cycle cannot clear `sync_pending`, publish exact current proof, or postpone due-now work; require the next full cycle at the new epoch to clear it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_cycle_cannot_satisfy_reenable_proof)`.
- [ ] Add `test_supervisor_cancellation_awaits_both_worker_pools`; block one Run and one metadata request, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_cancellation_awaits_both_worker_pools)`.
- [ ] Implement the shared threading.Event shutdown and await outstanding thread tasks from both maps; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_cancellation_awaits_both_worker_pools)`.
- [ ] Run the complete Task 6 file and the related Task 4/Core AI tests, then perform the final static boundary and commit checkpoints below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py tests/test_agent_workbench.py tests/test_coreai.py -q)`.

**Contract reference 6A: Deterministic list-only fake and call recorder**

The fake accepts response/error queues keyed by (agent_id, status), records (agent_id, status, limit), exposes get_agent(), and raises AssertionError if get_run() is invoked. Give it a close() recorder so worker ownership is testable.

**Contract reference 6B: Full 30-second proof**

For one active Agent with Run discovery due now, call `sync_registered_agent_runs_once` and assert the exact ordered calls:

~~~python
assert fake.calls == [
    ("agent-1", None, 200),
    ("agent-1", "PENDING", 200),
    ("agent-1", "RUNNING", 200),
    ("agent-1", "PAUSED", 200),
]
~~~

Return one running row and exact totals. Assert all parsed rows and four set observations commit in one transaction, current_state_complete becomes true, sync_pending clears, discovery/fast failure counts reset, and next_discovery_at is now+30 seconds. Run a second pass before due time and assert zero calls.
The Run-lane fake also records metadata calls; assert this full discovery makes zero `get_agent()` calls even if a separate metadata task is concurrently in flight.

On a first exact-empty unfiltered proof for a new registry row, set `unfiltered_proven_event_epoch=history_event_epoch=0`. In the one-new-RUNNING fixture above, that new identity increments the history generation and the valid unfiltered page proves it, so assert `unfiltered_proven_event_epoch=history_event_epoch=1`. Equality establishes that the current coverage window contains no unproved identity event; it does not by itself make a truncated response complete.

**Contract reference 6C: Filtered-set quality and partial proof**

Test exact when returned_count==total, lower_bound when returned_count<total, and unknown when a request fails or is invalid. A failed request retains its last valid count/time, changes quality to unknown, records a sanitized status-specific error, keeps sync_pending, and never removes cached Runs or infers terminal state.

For a fast PENDING/RUNNING confirmation failure, set last_poll_attempt_at and last_poll_error on affected cached Runs without changing last_synced_at/raw_status. Assert health and motion become stale immediately; a still-recent previous success cannot mask the later failed attempt.

A fully valid untruncated unfiltered response may prove all three sets exact even if a filtered response failed, provided the cycle itself has no cross-page status conflict and every locally accepted unconfirmed Run ID appears in a valid page. A truncated unfiltered response cannot clear ACTIVE_SET_TRUNCATED for any status; each affected filtered response must itself be valid and untruncated. Any mirrored NULL or unmapped raw status contributes to unresolved_unknown_status_count, adds UNKNOWN, and keeps the proof incomplete.

If the same Run ID appears with different raw statuses across valid pages in one cycle, order observations by response observation time and then fixed request order, but apply every observation through Task 4's transition guard. A later legal non-terminal observation may replace an earlier non-terminal value; once a terminal value is observed, no later non-terminal or different terminal value may overwrite it, and the existing terminal-conflict rule remains authoritative. Mark every implicated known-current bucket `unknown`, set current_state_complete=false, record sanitized `SAME_CYCLE_STATUS_CONFLICT`, and schedule one full discovery retry on the five-second error cadence. The Run remains one static signal, never simultaneous queued/running/waiting counts. A later complete cycle with one consistent status for that ID clears only this transient current-proof error and may restore exact buckets; it never clears a persistent terminal-status conflict.

**Contract reference 6D: Fast confirmation and transition resolution**

At five seconds, request once per distinct mirrored non-suspect active status, not once per Run. Two RUNNING Runs cause one status=RUNNING call; one PENDING plus two RUNNING Runs cause exactly two filtered calls. Fast polling never moves next_discovery_at, and a due 30-second proof still performs all four calls.

Merge all same-cycle responses before treating absence as meaningful. If a known RUNNING row appears in PENDING, persist PENDING. If it disappears from all requested non-terminal sets, make one unfiltered bounded request unless already made in that cycle. Persist a terminal value only when present. If still absent, preserve raw status, set a run-specific STATUS_NOT_IN_BOUNDED_LIST warning, and present it as uncertain.

PAUSED is reconciled only by the mandatory 30-second proof. A PENDING/RUNNING row older than suspect_after_seconds stops five-second scheduling and motion eligibility but keeps raw_status and returns to the 30-second proof. PAUSED never becomes suspect due to age.

**Contract reference 6E: Lifecycle cadence and backoff**

Freeze constants:

~~~python
SYNC_TICK_SECONDS = 1
MAX_CONCURRENT_AGENT_SYNCS = 8
MAX_CONCURRENT_METADATA_SYNCS = 4
STARTUP_DEDUP_WINDOW_SECONDS = 10
ACTIVE_DISCOVERY_SECONDS = 30
DISABLED_DISCOVERY_SECONDS = 15 * 60
RETIRED_DISCOVERY_SECONDS = 24 * 60 * 60
FAST_STATUS_SECONDS = 5
RUN_FRESH_SECONDS = 15
PROOF_FRESH_SECONDS = 90
SYNC_BACKOFF_BASE_SECONDS = 5
SYNC_BACKOFF_MAX_SECONDS = 60
METADATA_SUCCESS_SECONDS = 24 * 60 * 60
METADATA_BACKOFF_BASE_SECONDS = 60
METADATA_BACKOFF_MAX_SECONDS = 60 * 60
LEASE_SECONDS = 45
~~~

Assert successful active/disabled/retired discovery schedules 30 seconds/15 minutes/24 hours respectively. For a due disabled Agent and a due retired Agent, the call recorder must still show the exact unfiltered, PENDING, RUNNING, and PAUSED four-request archival cycle; seed an old non-terminal row and prove that cycle participates in the same merge/reconciliation rules while remaining lifecycle-qualified and static. Transport failures preserve the projection and retry that Agent at 5, 10, 20, 40, then 60 seconds without affecting another Agent. A success resets only that Agent's corresponding backoff. Fast and discovery due times remain independent.

Add a two-Agent isolation test: block Agent A's Core AI request behind a threading.Event, let Agent B return immediately, and assert B commits/schedules its healthy proof before A is released. This proves one 30-second transport timeout does not serialize every registered Agent.

Add a 17-Agent supervisor-capacity test with a fast barrier fake and due times that deliberately sort all Agents. Assert no more than `MAX_CONCURRENT_AGENT_SYNCS == 8` Run workers and `MAX_CONCURRENT_METADATA_SYNCS == 4` metadata workers enter their respective pools at once, the first admitted IDs in each lane follow that lane's due-time/local-ID order, each completion immediately fills one open slot, no local Agent overlaps with itself within one lane, and all 17 eventually receive exactly one complete four-list proof plus any independently due metadata verification. A Run worker and metadata worker for the same Agent may overlap by design. Repeat the Run-worker count assertion with twelve Agents to cover the visual target without encoding twelve as a product limit.

Test startup priming separately: every active Agent whose latest discovery/metadata attempt is absent or older than startup_at-10 seconds becomes due in its own lane at startup even when a future persisted cadence existed. A proof/verification attempt made by another worker within the ten-second dedupe window counts only for the corresponding lane, preventing a simultaneous worker stampede without coupling the clocks. Disabled/retired discovery cadence is not accelerated and their metadata lane stays disabled. Priming never changes either lane's owner/epoch/until columns; a valid owner is not stolen, and its fenced completion may satisfy only that lane's primed work.

**Contract reference 6F: Metadata scheduling**

At startup and whenever next_verification_at is due for an active Agent, the independent metadata worker verifies through get_agent(). Success updates cached name/model/timeout hint, clears only metadata error/failure count, and schedules 24 hours. Failure preserves prior metadata, never changes Run-list freshness fields, and retries at 60, 120, 240 seconds up to one hour. Start a metadata request behind a barrier, then let fast and full Run-list work become due for the same Agent: the separate Run worker must acquire its own lease/client/slot, commit its status proof on time, permit the independently qualified RUNNING motion, and remain unaffected when metadata later fails. A metadata error must not early-return from, serialize, or poison discovery. Disabled/retired rows are not periodically metadata-verified. Registration/replacement/re-enable tests from Task 3 remain synchronous and independent of this schedule.

Prove the clocks are independent with due `next_verification_at`, future `next_discovery_at`, and no due fast status. The metadata call recorder contains exactly `get_agent()` and no unfiltered or status-filtered list request. The commit may update only cached metadata, verification attempt/success/error/failure count, `next_verification_at`, and its own lease mechanics; it must leave every projected Run, current count/quality/completeness field, discovery/fast attempt/success/error field, `next_discovery_at`, and `next_fast_poll_at` byte-for-byte unchanged. A discovery-only or fast-only run lease never performs metadata I/O, even when a metadata worker for that Agent is concurrently blocked.

**Contract reference 6G: Lease acquisition, renewal, and fencing**

Use two SQLite connections plus ThreadPoolExecutor/threading.Event. Assert:

1. BEGIN IMMEDIATE acquisition succeeds for only one Run worker while the sync-state `lease_until` is live, and for only one metadata worker while the Agent-row `metadata_lease_until` is live.
2. The same Agent may hold one Run lease and one metadata lease concurrently; acquiring/renewing/releasing one leaves the other's columns byte-for-byte unchanged.
3. Every new acquisition has a unique owner token and increments only its lane's epoch.
4. Renewal succeeds only for the matching lane's owner+epoch before expiry, immediately before each request in that lane.
5. A response arriving after its lane's lease expiry or reacquisition returns false from `commit_discovery_cycle`/`commit_metadata_verification` and changes no owned fields.
6. A crashed owner needs no cleanup; a new worker claims that lane after expiry without disturbing the other lane.
7. Registration, replacement, and re-enable set sync_pending/due-now but do not overwrite a valid Run or metadata lease.
8. If lifecycle changes while a Run request is in flight, the fenced commit rereads the current lifecycle and schedules the next discovery cadence from that value; an old active claim cannot re-enable motion or a 30-second cadence for a newly disabled/retired row. A metadata commit requires the row still be active and at its captured `local_event_epoch`; disable/retire or disable-then-re-enable makes the old metadata response a no-op.
9. A valid Run lease is necessary but not sufficient to publish exact idle or history coverage. Every newly accepted local trigger transaction inserts one source-associated projection row and increments both `local_event_epoch` and `history_event_epoch`; when its response status is missing, that row durably carries `raw_status=NULL` plus `LOCAL_TRIGGER_STATUS_MISSING` until a valid list page observes the exact Run ID. Pause a cycle after it captures current/history epoch E and receives exact-zero unfiltered/PENDING/RUNNING/PAUSED pages, use a second connection to commit a local trigger at epoch E+1, then let the older response enter `commit_discovery_cycle`. The transaction may retain valid history observations but must keep affected/all bucket qualities unknown, set current_state_complete=false, leave `unfiltered_proven_event_epoch` behind, preserve a due-now confirmation, and forbid idle/usable history totals. A cycle that starts after the event may restore complete current proof only after one of its valid pages contains that exact Run ID and supplies a non-empty status; an exact-zero post-event cycle leaves the NULL marker unresolved, includes UNKNOWN, and still forbids idle. Historical proof additionally requires a valid post-generation unfiltered result before advancing its proven epoch. The same exact-ID rule applies to every unconfirmed known-status projected row.
10. Use the same Run-generation fence for re-enable. Pause a disabled archival cycle after it captures epoch E and receives its pages, re-enable the Agent in another transaction that writes active/sync_pending/due-now and epoch E+1, then release the old cycle. Its commit cannot clear sync_pending, publish exact proof, or postpone due-now work even though its lifecycle reread now sees active; only a full active cycle acquired at E+1 can satisfy re-enable.

**Final Task 6 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 6H: Independent fenced claims and request plans**

Acquire each lane with its own BEGIN IMMEDIATE conditional update and capture `local_event_epoch`; the Run lane also captures `history_event_epoch` as the generation of any unfiltered request it is about to issue. The sync-state `lease_owner/lease_epoch/lease_until` columns belong only to Run status/history work; the Agent-row `metadata_lease_owner/metadata_lease_epoch/metadata_lease_until` columns belong only to metadata verification. Network calls occur after commit on separate clients/connections and may overlap for the same Agent. Before each call, renew only that lane to now+45 seconds; after each response, parse fully before opening its commit transaction. Run commit rereads the Run lease tuple and discards results unless all still match and expiry is future. It also rereads both event epochs: when `local_event_epoch` differs, valid pages may update observed Run/history rows, but this older cycle may not publish exact current buckets, clear current-state uncertainty, clear `sync_pending`, or postpone the due-now confirmation. When `history_event_epoch` differs from the captured generation, that unfiltered response may update last-observed total/boundary but cannot advance `unfiltered_proven_event_epoch` or make it usable coverage. Metadata commit rereads its own tuple, active lifecycle, Core AI ID, and captured local event epoch; failure of any fence changes no metadata or schedule field.

~~~python
@dataclass(frozen=True)
class AgentRunSyncLease:
    local_agent_id: str
    coreai_agent_id: str
    lifecycle_status: str
    owner: str
    epoch: int
    lease_until: str
    discovery_due: bool
    fast_statuses: Sequence[str]
    local_event_epoch: int
    history_event_epoch: int


@dataclass(frozen=True)
class AgentMetadataLease:
    local_agent_id: str
    coreai_agent_id: str
    owner: str
    epoch: int
    lease_until: str
    local_event_epoch: int
~~~

Use one owner token per acquisition in the form process-id:UUID. Release only the matching lane with matching owner+epoch. Let expired leases stand for natural recovery; never run destructive lease cleanup.

**Implementation reference 6I: Coherent discovery and current-state proofs**

Build an in-memory `RunCycleResult` with only unfiltered, PENDING, RUNNING, and PAUSED outcomes. Plan its calls strictly from captured discovery/fast due state; it never calls `get_agent` or waits for the metadata lane. In parallel, the metadata worker builds a one-response `MetadataResult` and commits cached metadata/verification schedule through its own fence and transaction. Parse every response completely before either lane opens its commit transaction. The Run transaction then:

- snapshots the existing Run-ID set before any upsert, merges all valid pages, and partitions distinct new identities into `new_unfiltered_ids` (present in the valid unfiltered page) and `new_filtered_only_ids`; status/Token updates to an existing identity and an idempotent replay never count as a new history event;
- increments `history_event_epoch` exactly once per distinct new Run ID. If there is no valid unfiltered response, leave `unfiltered_proven_event_epoch` unchanged. If the transaction entered with the persisted history epoch equal to the lease's captured generation and no local event changed either captured epoch, evaluate proof against the unfiltered page before counting any same-cycle filtered-only identity. An untruncated page may advance only when its returned-ID set exactly equals the complete projected-ID set after applying its own new identities. A truncated page may advance only when it has a valid `coverage_start_at`, every projected row with valid upstream `started_at` at or after that boundary appears in its returned-ID set, and no projected row at all has missing/invalid upstream `started_at`; `first_seen_at` is never a substitute. This conservative predicate is deliberately derivable from the existing persisted rows after restart and needs no inferred per-Run dirty generation. If it passes, set the proven epoch to `captured_history_event_epoch + len(new_unfiltered_ids)`; then increment the history epoch for every same-cycle filtered-only new identity, leaving those later increments dirty. If it fails, keep the prior proven epoch. Thus an unfiltered response fetched first can never prove a new identity discovered only by a following filtered call, and a later truncated page that omits that dirty in-range identity still cannot catch up. If the entry epoch differs because a local event committed while requests were in flight, do not advance the proven epoch at all; still preserve valid observations and increment the current epoch for any genuinely new identities;
- upserts rows from valid pages by response observation time, using the identity partition above so a duplicate across pages increments the generation once only;
- builds the set of Run IDs actually observed by valid pages in this cycle, then rereads every locally registered row whose `last_synced_at IS NULL`; for each unobserved PENDING/RUNNING/PAUSED row, overrides the corresponding bucket to unknown; each unobserved known terminal/SKIPPED row invalidates all three current buckets because a trigger-response terminal is still not list-confirmed; and each unobserved unknown-future or NULL-status row keeps unresolved-unknown/current completeness false and preserves its warning. After the immediate due-now attempt, schedule the next confirmation at now+5 seconds only for known PENDING/RUNNING, and the next full discovery no later than now+30 seconds for PAUSED, terminal/SKIPPED, future, or NULL status; never leave a completed attempt permanently due-now. When a valid page finally contains the exact ID, mark that row list-confirmed and set `last_synced_at`; for a compatible transition, fill its parsed trigger/upstream fields, and for a NULL marker also fill exact raw status and clear only `LOCAL_TRIGGER_STATUS_MISSING`. If the list disagrees with an immediate terminal status, set `last_synced_at` to clear only the derived `LOCAL_RUN_UNCONFIRMED` identity barrier, preserve the complete first terminal payload tuple under Task 4's guard, and retain `TERMINAL_STATUS_CONFLICT` so affected current/history truth remains qualified;
- detects duplicate Run IDs with conflicting same-cycle statuses before deriving set counts, applies the ordered observations through terminal-safe Task 4 guards, downgrades every implicated current bucket to unknown, and schedules the transient conflict retry;
- updates last-observed unfiltered remote_total_runs, last_discovery_returned_count, coverage_start_at, and last discovery success/error, while Task 5 withholds those as usable coverage whenever the two history epochs differ or total is contradictory;
- replaces each valid status observation and changes failed status quality to unknown without deleting its prior observation;
- derives `unresolved_unknown_status_count` from distinct rows whose status is NULL or non-empty/unmapped, then derives current_state_complete;
- clears sync_pending only when all three known sets are exact and unresolved unknown is zero;
- schedules lifecycle cadence or bounded retry independently;
- updates run-specific confirmation errors without rewriting raw status.

Compare canonical before/after semantic tuples inside that transaction and increment `projection_revision` exactly once when any projected Run identity/status/upstream time/Token/association/warning/receipt field, either history epoch, or any count/total/quality/error/sync-pending/coverage value changes. Do not increment it for observation timestamps, freshness extensions, due/backoff times, lease fields, or an otherwise identical repeated proof. This SQLite-only monotonic marker supports Task 11's per-Agent stable readback windows; it is not exposed as a browser freshness claim.

Every unfiltered and filtered list request uses the one validated SEO_OPS_AGENT_HISTORY_LIMIT value for that process, default 200 and bounded 1..1000. The latest valid unfiltered page is ordered by Core AI started_at descending. When truncated, set coverage_start_at only if every returned row has a valid started_at; first_seen_at remains a display fallback but cannot prove remote range coverage.

**Implementation reference 6J: Independent per-Agent workers and async supervisor**

`sync_registered_agent_runs_once` opens its own SQLite connections and creates/closes one CoreAiClient for that Agent; unfiltered/status list requests inside one Run lease stay serialized. `verify_registered_agent_metadata_once` owns a different connection, client, and metadata lease and performs only `get_agent`. Different Agents run independently, and the two lanes for one Agent may overlap so a 30-second metadata transport cannot age out a five-second Run proof.

`agent_workbench_sync_loop` keeps two local maps and two independent caps: at most `MAX_CONCURRENT_AGENT_SYNCS` Run tasks and `MAX_CONCURRENT_METADATA_SYNCS` metadata tasks, each dispatched through `asyncio.to_thread`. Every one-second supervisor tick reaps both maps, reads each lane's due Agent IDs in its persisted due-time order, excludes only an ID already running in that same lane/process, and fills both pools without awaiting the other lane or an unrelated Agent. The local maps are scheduling mechanics, never source-of-truth state; due times, errors, counts, and both leases stay in SQLite for multi-worker coherence.

If credentials are missing, dispatch no network work in either lane; persisted data stays readable and aggregate health becomes unavailable. Give both worker kinds a shared threading.Event checked before every next upstream request. On supervisor cancellation, set that event and await every current thread task from both maps; at most each lane's current 30-second httpx request remains, and each response still needs its own valid fence before commit.

At the worker boundary, gather the active Core AI API key and available local authentication credentials into a short-lived tuple passed only to `sanitize_operator_text`; never persist, return, or log that tuple. Transport, HTTP, malformed-envelope, and unexpected exceptions always map to a fixed Workbench-owned code/message; never inspect an arbitrary exception string argument, `CoreAiError.args`, `str(exc)`, repr, body, or nested cause. The only upstream source text allowed through the sanitizer is the dedicated string `error` field—or its explicit string `message` member—of an otherwise successfully parsed Run-list row. Diagnostics contain a stable code and sanitized local Agent/Run identifiers only. Do not log raw exception repr, response bodies, request headers, nested causes, or tracebacks whose exception chain can reveal those values; raise mapped Workbench errors `from None`.

- [ ] **Step 12: Run focused and related backend tests**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py tests/test_agent_workbench.py tests/test_coreai.py -q)
~~~

Expected: PASS. Search the implementation and tests and assert there is no Workbench use of get_run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && rg -n "get_run\(" app/agent_workbench.py tests/test_agent_workbench*)
~~~

Expected: no production match; only the fake's deliberate AssertionError method may appear in tests.

- [ ] **Step 13: Commit the synchronization engine**

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench_sync.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: sync agent workbench state"
~~~

---

### Task 7: Wire accepted Runs and the independent application lifecycle

**Files:**
- Modify: api/app/agent_workbench.py
- Modify: api/app/runs.py
- Modify: api/app/tasks.py
- Modify: api/app/seo_targets.py
- Modify: api/app/main.py
- Create: api/tests/test_agent_workbench_triggers.py
- Create: api/tests/test_main.py

**Interfaces:**
- Produces: best_effort_record_started_run(coreai_agent_id, coreai_run_id, raw_status: str | None, source_kind, source_local_id, observed_at=None) -> None. Any registered lifecycle may own an accepted Run; only an `active` owner may receive active-speed confirmation scheduling.
- Changes: _insert_running_artifact(conn, merchant_id, cycle_id, artifact_type, schema_version, agent_id, run_id, request) -> int returns the inserted artifact ID.
- Produces: initialize_writable_application() -> schema initialization plus seed/prime commit; create_lifespan(startup_callable, scheduler_coro, fbr_scheduler_coro, workbench_coro) -> reusable FastAPI lifespan context; and create_app(lifespan_context) -> the one real router/auth application shape with zero construction-time DB I/O.
- Starts: the existing scheduler_loop(), the existing fbr_scheduler_loop(), and agent_workbench_sync_loop() as three separate lifespan tasks; never merge or omit the Local Falcon loop.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `test_best_effort_started_run_happy_path`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k best_effort_started_run_happy_path)` and observe RED.
- [ ] Implement one own-connection, committed-source, registered-Agent insert/bind path that increments both `local_event_epoch` and `history_event_epoch` exactly once for a distinct new Run identity in the same transaction; rerun to green and read back `unfiltered_proven_event_epoch < history_event_epoch`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_happy_path)`.
- [ ] Add `test_best_effort_started_run_failure_isolation`, one absent-registry/source-mismatch/SQLite/projection case at a time; put distinct credential/body sentinels only in each arbitrary raised exception, capture logs, and run the literal command at the end of this step after each case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)`.
- [ ] Add rollback/no-raise behavior plus a fixed Workbench-owned failure message and sanitized local identifiers; never inspect or stringify the caught exception. Finish the selection green and assert every sentinel is absent from caplog, exception repr, HTTP/background results, and SQLite. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)`.
- [ ] Add `test_statusless_accepted_run_persists_confirmation_marker`; start from exact idle/history zero, return an accepted Run ID with missing, blank, and non-string status in separate cases, reopen SQLite, and require one source-bound row with `raw_status=NULL`, `LOCAL_TRIGGER_STATUS_MISSING`, no upstream-derived fields, both event epochs incremented once, `unfiltered_proven_event_epoch` still behind, all three known bucket qualities unknown, discovery due now, mirrored count 1, effective remote total NULL, and no 1/0 coverage; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)`.
- [ ] Implement the idempotent NULL-status marker transaction and static aggregate signal without inventing a raw status; rerun to green, then replay the helper and prove it neither inserts twice nor increments either event epoch twice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)`.
- [ ] Add `test_local_nonterminal_invalidates_exact_idle`; run the literal command at the end of this step for PENDING, then RUNNING, then PAUSED, then unknown, requiring each unconfirmed row to invalidate both current proof and effective history coverage. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)`.
- [ ] Implement atomic per-bucket quality invalidation, due-now scheduling, and idempotent unresolved counting while preserving lifecycle `sync_pending`; finish with the literal command at the end of this step green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)`.
- [ ] Add `test_inactive_lifecycle_running_acceptance_preserves_archival_cadence`; parameterize disabled and retired owners with a RUNNING response, seed an earlier/future lifecycle due time, and observe RED until the row persists but `next_fast_poll_at` remains NULL and `next_discovery_at` is not accelerated or postponed. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)`.
- [ ] Implement the lifecycle gate for known-status accepted Runs: `active` PENDING/RUNNING may become due now, while disabled/retired owners use `min(existing_next_discovery_at, observed_at + lifecycle_interval)` with NULL treated as the lifecycle deadline, clear no lifecycle field, and never schedule a fast poll. Rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)`.
- [ ] Add `test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence`; repeat the disabled/retired matrix with a missing trigger status and require the durable NULL-status marker, static signal, UNKNOWN blocker, unchanged `sync_pending`, no motion, no fast poll, and the same non-accelerating archival deadline. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)`.
- [ ] Route every non-active status branch through the same archival scheduler and rerun the missing-status case to green; an already overdue lifecycle deadline stays overdue and is handled by the normal archival worker, but the accepted event itself never changes the owner to active or sets `sync_pending`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)`.
- [ ] Add `test_local_terminal_status_is_unconfirmed_without_receipt`; parameterize COMPLETED/FAILED/TIMEOUT/CANCELLED/SKIPPED from the trigger response, require exact raw status, immutable `terminal_observed_at=observed_at`, NULL trigger/list fields and Tokens, no receipt, all three current buckets unknown, full discovery due now, unusable old history total, and static/no-motion presentation; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)`.
- [ ] Implement the immediate-terminal branch and rerun to green; keep an associated still-running local source as static unconfirmed archiving evidence, but do not mark upstream freshness or create a receipt. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)`.
- [ ] Add `test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt`; first feed post-event exact-zero, then the same terminal ID/status in a valid page, and observe RED at list-confirmation/coverage restoration. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt)`.
- [ ] Implement compatible exact-ID terminal confirmation, `last_synced_at`/trigger/Token fill, and consistent-unfiltered coverage restoration while receipt stays NULL; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt)`.
- [ ] Add `test_conflicting_list_terminal_confirms_identity_without_hybrid_payload`; start with an immediate COMPLETED marker, then return its exact ID as FAILED in a valid list page and observe RED until `last_synced_at` becomes non-NULL and `LOCAL_RUN_UNCONFIRMED` clears while the complete original COMPLETED payload tuple/NULL receipt stays unchanged and `TERMINAL_STATUS_CONFLICT` keeps current truth qualified. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_conflicting_list_terminal_confirms_identity_without_hybrid_payload)`.
- [ ] Separate valid exact-ID list confirmation metadata from the immutable authoritative terminal payload, then rerun the focused conflict case to green without clearing the persistent conflict warning. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_conflicting_list_terminal_confirms_identity_without_hybrid_payload)`.
- [ ] Add `test_best_effort_started_run_fences_older_discovery_result`; parameterize RUNNING and missing-status trigger responses, block an exact-zero cycle before commit, invoke the real helper after its source transaction commits, release the old cycle, and run the literal command at the end of this step to observe RED until the Task 6 event barrier is exercised end to end. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)`.
- [ ] Rerun the same test after wiring the helper; require uncertain/static plus idle forbidden after the old commit in both cases. Feed a post-event exact-zero cycle and prove both remain unconfirmed; then feed a valid page containing each exact Run ID and require only that observation to restore exact current truth and, for missing status, fill the real non-empty status. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)`.
- [ ] Add `test_runs_start_run_registers_after_commit`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_runs_start_run_registers_after_commit)`.
- [ ] Add the one post-commit `runs.py` hook and rerun its focused case to green; the complete call-site regressions run at this Task's checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_runs_start_run_registers_after_commit)`.
- [ ] Add `test_task_execute_registers_after_commit`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_task_execute_registers_after_commit)`.
- [ ] Add the one post-commit `tasks.py` hook and rerun its focused case to green; the complete call-site regressions run at this Task's checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_task_execute_registers_after_commit)`.
- [ ] Add `test_keyword_skill_artifact_registers_after_commit`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_keyword_skill_artifact_registers_after_commit)`.
- [ ] Return the inserted artifact ID, add the first `seo_targets.py` hook, and rerun its focused case to green; the complete call-site regressions run at this Task's checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_keyword_skill_artifact_registers_after_commit)`.
- [ ] Add `test_chained_audit_ranking_artifact_registers_after_commit`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_chained_audit_ranking_artifact_registers_after_commit)`.
- [ ] Add the second artifact hook without another trigger and rerun its focused case to green; the complete scheduler/SEO-target regressions run at this Task's checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_chained_audit_ranking_artifact_registers_after_commit)`.
- [ ] Add `test_normalized_trigger_identity_reaches_every_source_and_projection`; parameterize all four call sites with the real Task 2 client boundary returning padded valid ID/status, then assert the trimmed ID/status reach the committed source row and helper exactly once; run the literal command at the end of this step to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_normalized_trigger_identity_reaches_every_source_and_projection)`.
- [ ] Add `test_invalid_trigger_identity_never_reaches_source_or_projection`; parameterize all four call sites with non-string/blank Run IDs, assert the stable existing failure-or-dispatch-unknown behavior, zero invalid `coreai_run_id` writes, zero helper calls, and exactly one upstream POST; run the focused case plus all existing call-site regressions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py tests/test_runs_api.py tests/test_tasks.py tests/test_seo_targets.py tests/test_scheduler.py -q)`.
- [ ] Add `test_projection_failure_never_retries_external_trigger`, parameterized across all four call sites; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)`.
- [ ] Add call-site isolation around the helper only; rerun to green and assert exactly one Core AI trigger per case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)`.
- [ ] Add `test_import_and_create_app_perform_zero_database_io`; in a fresh subprocess point `SEO_OPS_DB` at a nonexistent path, import `app.main`, call `create_app` with a no-op lifespan, and assert no database/file/open hook occurs; run the literal command at the end of this step and observe RED against the current import-time `init_db()`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_import_and_create_app_perform_zero_database_io)`.
- [ ] Move `init_db` plus seed/prime into `initialize_writable_application`, leave module import/application construction pure, and rerun the subprocess case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_import_and_create_app_perform_zero_database_io)`.
- [ ] Add `test_lifespan_seeds_primes_then_starts_all_three_loops`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_seeds_primes_then_starts_all_three_loops)` and observe RED.
- [ ] Inject the writable startup and the three named loop callables; rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_seeds_primes_then_starts_all_three_loops)` to green and assert schema initialization, seed, and prime complete before any loop starts.
- [ ] Add `test_lifespan_cancels_and_awaits_all_three_loops`; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` and observe RED.
- [ ] Implement cancellation plus `gather(..., return_exceptions=True)` for all three tasks; rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` to green, including one loop finalizer raising while the other two still finish.
- [ ] Add `test_app_factory_preserves_routes_with_injected_lifespan`; compare injected and production route/dependency sets and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_app_factory_preserves_routes_with_injected_lifespan)`.
- [ ] Centralize router/dependency construction in `create_app` without an environment disable switch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_app_factory_preserves_routes_with_injected_lifespan)`.
- [ ] Add `test_workbench_routes_require_operator` and observe RED on any unauthenticated route. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_workbench_routes_require_operator)`.
- [ ] Wire the existing operator dependency to every Workbench route and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_workbench_routes_require_operator)`.
- [ ] Run the complete trigger/lifecycle tests plus existing runs/tasks/seo-targets/scheduler regressions before the final commit checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py tests/test_main.py tests/test_runs_api.py tests/test_tasks.py tests/test_seo_targets.py tests/test_scheduler.py -q)`.

**Contract reference 7A: Best-effort helper**

Assert the helper opens its own connection, requires an existing registered exact Core AI Agent of any lifecycle, validates the committed source row/run-ID match, derives merchant_id, and inserts or fills the association idempotently. If registry is absent, the source is uncommitted/mismatched, SQLite fails, or projection logic raises, assert the helper returns None, rolls back its own transaction, logs a bounded diagnostic, and never raises to the caller. The diagnostic contains only a stable code, sanitized local Agent/Run/source identifiers, and a fixed Workbench-owned operator message; arbitrary caught-exception text is never inspected or stringified. Inject credentials, Bearer/header text, query secrets, and raw body text into the failure and prove none appears in caplog, result objects, exception repr, or SQLite.

Treat a missing, blank, or non-string trigger-response status as an accepted event with unknown current bucket, not as a no-op, coerced scalar, or invented raw status. After validating the registry and committed source, use one transaction to insert the exact accepted Run ID in `seo_ops_agent_runs` with `raw_status=NULL`, the immutable source association, local `first_seen_at`, and `LOCAL_TRIGGER_STATUS_MISSING`; leave all upstream-derived fields NULL. In that same distinct-new-ID transaction increment both `local_event_epoch` and `history_event_epoch`, leave `unfiltered_proven_event_epoch` behind, set PENDING/RUNNING/PAUSED qualities to unknown, set current_state_complete=0, and preserve prior observed counts/times plus lifecycle-owned `sync_pending`. The row itself is the durable confirmation barrier: every later proof includes UNKNOWN and forbids idle until a valid parsed list page contains that exact ID. It also invalidates effective history/remote-total coverage under Task 5 while preserving the last observed SQLite total, so mirrored 1 can never be presented as 1/0. A valid page that omits it—including a post-event exact-zero four-list cycle—may refresh bounded observations but cannot delete the marker, clear UNKNOWN, claim complete current truth, restore usable coverage, or show idle. For an active owner, set `next_discovery_at=now`; after that immediate attempt, an unresolved marker uses the ordinary no-later-than-30-second full-discovery cadence and never fabricates a five-second active status. For disabled/retired owners, persist and expose the same marker but never accelerate to an active cadence: keep `next_fast_poll_at=NULL` and set `next_discovery_at=min(existing_next_discovery_at, observed_at + 15 minutes/24 hours)` with NULL treated as that lifecycle deadline. An existing earlier or overdue archival deadline is preserved. In every lifecycle the aggregate immediately shows a selectable static `状态待确认（上游未返回状态）` signal; the event never re-enables the Agent, sets `sync_pending`, or enables motion.

Start from a fresh exact-idle/history proof with observed running/queued/waiting counts and upstream/mirrored totals all zero and `sync_pending=0`. Register local PENDING, RUNNING, PAUSED, each known terminal/SKIPPED, missing-status, and unknown-future triggers in separate cases. In the same transaction as each distinct new projection, increment both `local_event_epoch` and `history_event_epoch` exactly once, leave `unfiltered_proven_event_epoch` behind, and assert the matching known non-terminal bucket—or all three for terminal/SKIPPED/missing/unknown status—becomes `unknown` and `current_state_complete=0`, while its last observed zero/count/remote-total timestamp and the existing lifecycle-owned `sync_pending=0` remain intact. At read time every `last_synced_at=NULL` row forces effective remote total NULL and history/range/metrics incomplete; never overwrite the persisted last observation and never expose mirrored 1 over remote 0. An idempotent helper replay for the same already-associated Run must not increment either epoch again. For an active owner, PENDING/RUNNING set `next_fast_poll_at=now`; PAUSED, terminal/SKIPPED, missing status, and unknown status set `next_discovery_at=now` because they require full proof. For a disabled or retired owner, every status instead leaves `next_fast_poll_at=NULL` and keeps the earlier of its existing archival due time and `observed_at + DISABLED_DISCOVERY_SECONDS/RETIRED_DISCOVERY_SECONDS`; it never receives active-speed confirmation, becomes active, or sets `sync_pending`. A newly opened aggregate must show each accepted non-terminal/unknown Run as uncertain/static, never an exact-zero bucket or exact idle. For a known immediate terminal, persist exact raw status and immutable `terminal_observed_at=observed_at`, leave upstream timestamps/trigger/Tokens/last_synced_at NULL, and assign no receipt because no previously list-confirmed non-terminal state or valid recent completed_at exists. It may appear only as static unconfirmed archiving when its associated local source remains running; it is never fresh or animated. A later lifecycle-eligible cycle restores complete current proof only after it starts with the current event epoch and a valid page actually observes that Run ID, possibly in a later terminal state; both pre-event and post-event exact-zero responses leave an unobserved row uncertain. Historical coverage additionally requires a consistent updated unfiltered total/page under Task 5, so filtered confirmation alone cannot resurrect a stale 0 denominator. An unknown future non-empty trigger status likewise invalidates current-state completeness and participates in `unresolved_unknown_status_count`. Compute that count from distinct projected rows whose raw status is NULL or unmapped without double-counting an idempotent call. Every immediate projection stores `trigger_type=NULL`; the first valid list response fills the actual trigger type and list-derived fields, fills a NULL raw status with the exact returned status, and clears only `LOCAL_TRIGGER_STATUS_MISSING`; it never moves `terminal_observed_at` or retroactively creates a receipt for an immediate-terminal row. `sync_pending` remains reserved for a new/replaced/re-enabled registry owner awaiting its first complete proof; ordinary Run confirmation does not repurpose it.

**Contract reference 7B: Four post-commit trigger paths**

Cover all four real trigger sites:

~~~text
runs.start_run                         -> source_kind run
tasks.execute_task                     -> source_kind task_execution
keyword Skill regeneration             -> source_kind merchant_seo_artifact
keyword -> audit/ranking chained trigger -> source_kind merchant_seo_artifact
~~~

For each, assert Core AI acceptance is first written to the source table and committed, then the helper sees that row and adds the projection. For the chained path, assert _insert_running_artifact returns the inserted ID. Assert scheduler auto-scan inherits the runs.start_run hook without a fifth call site.

Use an actual `CoreAiClient` with `httpx.MockTransport` at each call-site boundary for the identity regressions; a fake that returns an arbitrary Python dict would bypass the contract under test. A padded valid ID/status is normalized once and the exact trimmed values appear in both local source and projection. An invalid ID raises Task 2's typed `CoreAiError` before any `coreai_run_id` update/helper call. Preserve each existing caller's established failure semantics—ordinary Run/task records fail, keyword dispatch remains explicitly unknown, and the chained artifact follows its current failed-artifact path—without automatic re-triggering. Assert one POST only in every case. Optional invalid/missing status does not fail an otherwise valid Run ID: the client returns `None`, and Contract 7A creates the durable NULL-status marker.

**Contract reference 7C: Projection-failure isolation**

Monkeypatch best_effort_record_started_run to raise despite its own contract and assert each caller still returns/persists the accepted Core AI Run exactly once. Raise an exception whose only string contains a secret sentinel and assert the call-site log records the stable projection-failure code, fixed message, and sanitized local identifiers without reading the exception, with no raw exception repr, traceback/cause, body, or sentinel. The route/background result must not become a trigger failure and must not call client.trigger a second time. Keep the existing keyword dispatch-unknown behavior unchanged when Core AI itself fails before a Run ID is persisted; do not project an invented row.

**Task 7 trigger integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q)
~~~

Expected: PASS because the trigger vertical slices above reached green.

**Implementation reference 7D: Helper and four narrow hooks**

Capture accepted run_id/status in the existing success branch, commit the business connection, and only then invoke the helper. Wrap the call site too, so even an accidental future helper regression cannot convert an accepted external write into a retryable local failure. The helper's distinct-new-ID transaction increments both event epochs; an idempotent replay changes neither and must reread the still-dirty history proof state.

Consume Task 2's already normalized trigger result: `run_id` is a trimmed non-empty string and `status` is either trimmed non-empty text or `None`. Keep a defensive helper type check, but do not independently normalize to a different identity. For a non-null status use that exact returned text, including an unknown future value. For `None`, insert the same accepted Run ID with nullable raw status and `LOCAL_TRIGGER_STATUS_MISSING` as Contract 7A specifies; never call `str` on an upstream value. The committed source association and durable marker let normal discovery repair the row without inventing upstream truth. Never mark local registration fresh enough for motion: every immediate projection sets `first_seen_at` while `trigger_type` and `last_synced_at` stay NULL until a valid list response confirms that exact Run ID. Atomically invalidate the affected exact current-state claim as specified in Contract 7A, and combine Task 6's local-event epoch fence with the durable unconfirmed row so neither an older response nor a newer exact-zero cycle can restore idle before confirmation.

**Contract reference 7E: Lifespan, application factory, and authentication**

Importing `app.main`, evaluating the production singleton, and calling `create_app` must perform zero filesystem/database I/O. A fresh subprocess with `SEO_OPS_DB` aimed at a nonexistent file proves import/construction does not create it. All writable setup moves into `initialize_writable_application`, invoked only when the production/writable lifespan enters: call `init_db()` first, then connect, seed, prime, commit, and close before either loop starts.

Inject the writable startup plus event-recording `scheduler_loop`, `fbr_scheduler_loop`, and Workbench coroutines into `create_lifespan` and enter the resulting FastAPI lifespan. Assert schema initialization and local seeding complete before any task starts. On exit, assert all three tasks receive cancellation and all three finalizers run. A task that raises during shutdown must not prevent awaiting either peer. `create_app` owns all production router includes and dependency lists exactly once; the production singleton and Task 11's live-gate/restart apps all call this factory, so the safety harness cannot silently lose auth, lose the existing Local Falcon scheduler, or gain a test-only mutation route.

Also request every Workbench route without an operator session and assert 401; with the existing logged-in fixture, assert the aggregate route is reachable even when Core AI credentials are absent.

**Task 7 lifecycle integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_main.py tests/test_agent_workbench_triggers.py -q)
~~~

Expected: PASS because the lifecycle vertical slices above reached green.

**Implementation reference 7F: Router, seed, and awaited loops**

Use this injected shutdown shape:

~~~python
def initialize_writable_application() -> None:
    init_db()
    conn = connect()
    try:
        startup_at = utc_now()
        seed_configured_agents(conn, configured_agent_slots(), startup_at)
        prime_agent_workbench_startup(conn, startup_at)
        conn.commit()
    finally:
        conn.close()


def create_lifespan(
    startup_callable,
    scheduler_coro,
    fbr_scheduler_coro,
    workbench_coro,
):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        startup_callable()
        tasks = [
            asyncio.create_task(scheduler_coro()),
            asyncio.create_task(fbr_scheduler_coro()),
            asyncio.create_task(workbench_coro()),
        ]
        try:
            yield
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
    return lifespan


lifespan = create_lifespan(
    initialize_writable_application,
    scheduler_loop,
    fbr_scheduler_loop,
    agent_workbench_sync_loop,
)
app = create_app(lifespan)
~~~

`create_app` constructs FastAPI and includes auth plus every existing and Workbench router with the same operator dependency lists; there is no second handwritten route map and no module-level `init_db()` call. Include agent_workbench.router with the existing operator_dependencies list. Do not make startup wait on Core AI; the Workbench loop owns startup discovery after acquiring a lease. Startup/loop injection accepts callables in code, not a production environment disable flag, so production cannot accidentally park its scheduler or skip initialization.

- [ ] **Step 9: Run backend integration tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py tests/test_coreai.py tests/test_agent_workbench.py tests/test_agent_workbench_sync.py tests/test_agent_workbench_triggers.py tests/test_main.py tests/test_runs_api.py tests/test_tasks.py tests/test_seo_targets.py tests/test_scheduler.py -q)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/app/runs.py api/app/tasks.py api/app/seo_targets.py api/app/main.py api/tests/test_agent_workbench_triggers.py api/tests/test_main.py
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: wire agent workbench updates"
~~~

---

### Task 8: Freeze frontend contracts and pure presentation time

**Files:**
- Modify: web/src/api.ts
- Create: web/src/agentWorkbenchApi.test.ts
- Create: web/src/agentWorkbenchPresentation.ts
- Create: web/src/agentWorkbenchPresentation.test.ts

**Interfaces:**
- Produces: the exact TypeScript structures frozen by Task 5.
- Produces: ApiError(message: string, status: number, code: string | null, fields: Record<string, string>).
- Produces: api.getAgentWorkbench(range, signal), getAgentRunHistory(localAgentId, range, limit, before, signal), registerAgent(body), updateAgent(localAgentId, body), retireAgent(localAgentId), and replaceAgent(localAgentId, body).
- Produces: createPresentationState(), advancePresentation(), replacePresentationSnapshot(), reconcileSignalSelection(), diffWorkbenchEvents(), and formatCompactNumber().
- Produces: PresentedWorkbench.current_counts as the only UI-facing current-claim source, with derived quality/copy and running-owner eligibility; the immutable raw snapshot remains available only for persisted facts and selected-range history metrics.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `getAgentWorkbench sends range and AbortSignal`; run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t 'getAgentWorkbench sends range and AbortSignal')` and observe RED.
- [ ] Add only the Workbench snapshot types and aggregate GET; rerun that named test to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "getAgentWorkbench sends range and AbortSignal")`.
- [ ] **GREEN characterization:** After the aggregate types/GET slice is green, add `aggregate preserves statusless signal shape`; return one `raw_status:null` signal/history fixture with server `presentation_group:'unknown'` and `token_state:'unconfirmed'`, assert exact object equality and TypeScript access to those fields, and require the literal command at the end of this step to stay green without a client-side status mapper. This is a contract-preservation check, not a claimed RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "aggregate preserves statusless signal shape")`.
- [ ] Add `history URL encodes path and cursor`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "history URL encodes path and cursor")`.
- [ ] Implement the abortable history GET with URLSearchParams; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "history URL encodes path and cursor")`.
- [ ] Add `registerAgent sends strict body` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "registerAgent sends strict body")`.
- [ ] Implement only POST register and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "registerAgent sends strict body")`.
- [ ] Add `updateAgent sends encoded id and strict body` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "updateAgent sends encoded id and strict body")`.
- [ ] Implement only PATCH update and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "updateAgent sends encoded id and strict body")`.
- [ ] Add `retireAgent sends zero-byte body` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "retireAgent sends zero-byte body")`.
- [ ] Implement only bodyless POST retire and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "retireAgent sends zero-byte body")`.
- [ ] Add `replaceAgent sends encoded id and strict body` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "replaceAgent sends encoded id and strict body")`.
- [ ] Implement only POST replace and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "replaceAgent sends encoded id and strict body")`.
- [ ] Add `structured and legacy API errors`; include valid plain/null-prototype string maps plus array, Date, scalar-value, and prototype-bearing non-record `fields` rejections; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")`.
- [ ] Implement the backward-compatible ApiError parser and rerun the focused case to green; both complete Task 8 files run at this Task's checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")`.
- [ ] Perform the transport-slice commit at reference 8C before presentation work. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")`.
- [ ] Add `snapshot clock aligns monotonically`; run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t 'snapshot clock aligns monotonically')` and observe RED.
- [ ] Implement SnapshotClock/alignedEpochMs/signalElapsedSeconds with the non-null first-seen invariant; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot clock aligns monotonically")`.
- [ ] Add `compact number formatting` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "compact number formatting")`.
- [ ] Implement only the frozen Intl helper and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "compact number formatting")`.
- [ ] Add `aggregate deadline downgrades exact zero current claims`; at `fresh_until` require PresentedWorkbench current quality/copy to become unknown and idle eligibility false while the raw snapshot stays exact zero; observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact zero current claims")`.
- [ ] Implement the immutable PresentedWorkbench current-count copy plus exact-zero downgrade only; rerun to green without mutating the API snapshot. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact zero current claims")`.
- [ ] Add `aggregate deadline downgrades exact positive current claims`; require removal of current-tense and exact-owner eligibility while retaining last-confirmed evidence, then observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact positive current claims")`.
- [ ] Implement only the exact-positive downgrade branch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact positive current claims")`.
- [ ] Add `aggregate deadline downgrades lower-bound current claims`; require `至少 N` to disappear while raw lower-bound data stays unchanged, then observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades lower-bound current claims")`.
- [ ] Implement only the lower-bound downgrade branch and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades lower-bound current claims")`.
- [ ] Add `suspect deadline changes only presentation truth`; place a fresh RUNNING and PENDING `suspect_at` 250ms after an elapsed tick, run the literal command at the end of this step, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")`.
- [ ] At that exact aligned deadline mark the presented signals uncertain/suspect/static and downgrade affected current claims while preserving raw status and immutable API snapshot fields; rerun to green and assert old PAUSED has no suspect deadline. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")`.
- [ ] Add `signal deadlines gate motion independently` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "signal deadlines gate motion independently")`.
- [ ] Implement per-signal local freshness without mutating aggregate facts and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "signal deadlines gate motion independently")`.
- [ ] Add the running-clock half of `receipt expires automatically but freezes while paused` and observe RED at expiry. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")`.
- [ ] Implement running-clock receipt expiry and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")`.
- [ ] Add the paused-clock half to the same test and observe RED if the receipt disappears while paused. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")`.
- [ ] Freeze and resume the presentation clock, then finish the receipt selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")`.
- [ ] Add `snapshot replacement never replays receipt entrance` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot replacement never replays receipt entrance")`.
- [ ] Implement seen-receipt bookkeeping and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot replacement never replays receipt entrance")`.
- [ ] Add surviving and next-selection rows to `selection reconciliation reports removal`; observe RED on the first missing transition. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")`.
- [ ] Implement only surviving/next pure selection results and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")`.
- [ ] Add previous/none/pause rows and observe RED on the first missing transition. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")`.
- [ ] Finish the pure `selectedWasRemoved`/selection result and rerun all rows to green; DOM focus remains Task 9's responsibility. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")`.
- [ ] Add `workbench event diff is semantic only` one allowed announcement at a time and observe RED on the first missing event. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")`.
- [ ] Implement the five exact semantic event branches and finish the focused selection green without announcing timer ticks. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")`.
- [ ] Run both complete Task 8 files, then perform the final presentation commit checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts src/agentWorkbenchPresentation.test.ts)`.

**Contract reference 8A: API URL, body, abort, and errors**

Mock fetch and assert:

~~~typescript
await api.getAgentWorkbench('30d', controller.signal)
expect(fetch).toHaveBeenCalledWith(
  '/api/agent-workbench?range=30d',
  expect.objectContaining({ signal: controller.signal, credentials: 'same-origin' }),
)

await api.getAgentRunHistory('local agent/1', '7d', 20, 'opaque+cursor', controller.signal)
expect(fetch).toHaveBeenLastCalledWith(
  '/api/agent-workbench/agents/local%20agent%2F1/runs?range=7d&limit=20&before=opaque%2Bcursor',
  expect.objectContaining({ signal: controller.signal }),
)
~~~

Assert exact POST/PATCH/retire/replace methods and JSON bodies from Task 3. For a backend detail object, assert ApiError preserves status/code/fields and uses its message. Existing string detail errors must still produce the same visible Error.message, so current screens do not regress.

Freeze `raw_status` and `trigger_type` as `string | null` in both `ProjectedRunSummary` and `WorkbenchSignal`; both DTOs also carry server-generated `presentation_group` and the four-state `token_state`. Read an accepted/unconfirmed `raw_status:null` response without throwing or remapping it; presentation components render the Task 10 status/Token fallbacks until a list response supplies the real non-empty status.

**Task 8 transport integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts)
~~~

Expected: PASS because the transport vertical slices above reached green.

**Implementation reference 8B: Exact types and abortable API methods**

Implement all Task 5 shapes once in api.ts, including signal `presentation_group`, nullable `raw_status`, and four-state `token_state`. The server is the only raw-status classifier; TypeScript preserves these fields and UI code formats them without recreating a divergent mapping table. The mutation types are exact and do not accept agent_key/coreai_agent_id in PATCH. Use URLSearchParams for queries and encodeURIComponent for path IDs.

Keep request<T> backward-compatible while recognizing structured detail:

~~~typescript
function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value as Record<string, unknown>).every(item => typeof item === 'string')
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly fields: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function errorFromResponse(status: number, statusText: string, body: unknown): ApiError {
  const detail = body && typeof body === 'object' && 'detail' in body
    ? (body as { detail?: unknown }).detail
    : null
  if (typeof detail === 'string') return new ApiError(detail, status)
  if (detail && typeof detail === 'object') {
    const value = detail as { message?: unknown; code?: unknown; fields?: unknown }
    return new ApiError(
      typeof value.message === 'string' ? value.message : status + ' ' + statusText,
      status,
      typeof value.code === 'string' ? value.code : null,
      isStringRecord(value.fields) ? value.fields : {},
    )
  }
  return new ApiError(status + ' ' + statusText, status)
}
~~~

Every Workbench GET accepts an AbortSignal and passes it through RequestInit. Mutation functions do not imply discovery completion; callers render response.sync_pending.

**Commit checkpoint 8C: Transport slice**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/api.ts web/src/agentWorkbenchApi.test.ts
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: add agent workbench client contract"
~~~

**Contract reference 8D: Snapshot clock, elapsed time, and number formatting**

Use vi.useFakeTimers only for code that schedules; pass monotonic numbers directly to pure functions. Freeze this clock contract:

~~~typescript
type SnapshotClock = {
  snapshotEpochMs: number
  receivedAtMonotonicMs: number
}

export function alignedEpochMs(clock: SnapshotClock, nowMonotonicMs: number): number {
  return clock.snapshotEpochMs + Math.max(0, nowMonotonicMs - clock.receivedAtMonotonicMs)
}

export function signalElapsedSeconds(
  signal: WorkbenchSignal,
  clock: SnapshotClock,
  nowMonotonicMs: number,
): number {
  return signal.elapsed_seconds + Math.floor(
    Math.max(0, nowMonotonicMs - clock.receivedAtMonotonicMs) / 1000,
  )
}
~~~

Assert negative monotonic drift clamps at zero. Freeze the invariant from Task 1/Task 5: `first_seen_at` is a valid, non-null local observation, so `effective_started_at` and `elapsed_seconds` are always non-null in API and frontend types. When upstream `started_at` is missing/invalid, test elapsed time from `first_seen_at`; do not retain an unreachable `开始时间不可用` branch or a nullable helper result.

Define the shared Workbench-only compact-number contract here rather than depending on a page-local formatter: `0 -> "0"`, `999 -> "999"`, `12_500 -> "1.3万"`, and `1_234_567 -> "123.5万"` using `Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 1})`. Reject non-finite input at the type boundary/tests. Task 10 may abbreviate visual text with this helper while preserving the full integer in its accessible name.

**Contract reference 8E: Local freshness downgrade**

At aggregate or signal fresh_until, not one millisecond later, advancePresentation must:

- set presentation freshness false and stop motion eligibility;
- replace every current count presentation with unknown snapshot wording, including exact zero, exact positive, and lower-bound values; retain any previous value only as `上次确认` evidence rather than a current claim;
- expose has_active_runs/has_queued_runs/has_waiting_runs as null in the presentation;
- preserve raw_status, timestamps, persisted count objects, and historical metrics;
- never turn stale data fresh as time advances.

`PresentedWorkbench.current_counts` is the only current-count input allowed in `LiveRunStage` and the current portion of `AgentSummaryMetrics`. Each presented bucket carries the derived `quality`, display evidence, `claim_is_current`, and—for running only—`exact_owner_claim_allowed`. At an aggregate deadline, signal deadline, suspect deadline, hide, or pause transition, derive an unknown/non-current copy before rendering: preserve the last observed value/time only as historical evidence, clear exact/lower-bound current wording and owner eligibility, and make idle ineligible. `snapshot.current_counts` stays byte-for-byte immutable and must not be read by either component for a current-tense headline/card. Historical range summary and coverage continue to read the immutable snapshot.

Treat each future PENDING/RUNNING `suspect_at` as an equally exact local downgrade deadline. At the boundary, without mutating the API snapshot, set only the presented signal's `suspect=true`, `suspect_reason=超过本地状态待确认阈值`, `signal_state='uncertain'`, `fresh=false`, and motion eligibility false; downgrade the owning/aggregate current claim to unknown snapshot wording and preserve `raw_status`, times, Tokens, and history. PAUSED/terminal/archiving/unknown signals have no suspect deadline. Test a threshold 250ms after the preceding one-second tick so the reducer cannot wait for the next tick or network request.

Add explicit exact-positive and lower-bound fixtures so neither continues to say `当前 N` or `至少 N` after expiry. The aggregate boundary revokes every aggregate current claim and exact-idle wording; each signal's own boundary independently controls that signal's motion. One stale Agent or an expired aggregate boundary must not suppress another Agent whose signal and owning-Agent proof remain fresh. Metadata-only verification warnings do not revoke a separately fresh complete list proof. Hidden/focus-restored cached state is immediately presentation-stale until a new successful fetch.

**Contract reference 8F: Receipt, pause, and replacement**

While auto update is enabled and visible, filter a receipt at receipt_expires_at without a network response. At pause time, freeze the monotonic clock: a visible receipt remains selected past nominal expiry, its copy becomes absolute-time snapshot wording, and all motion is false. Resume or manual refresh first evaluates expiry against actual aligned time, removes expired receipts, and never adds their IDs back to entrance animation.

replacePresentationSnapshot accepts one of initial, automatic, manual, visibility, or resume reasons. It records receipt IDs already presented so refresh/resume cannot replay the optional entrance transition. A failed fetch leaves the prior state downgraded and cannot move its snapshot clock forward.

**Contract reference 8G: Deterministic selection and event diff**

Initial selection is the newest signal by effective_started_at/coreai_run_id. Refresh preserves a selected ID if it remains and returns `selectedWasRemoved=false`. If the selected tab is removed, choose the item now occupying its old index, otherwise the preceding final item, and return `selectedWasRemoved=true`; if none remain return the same removal fact plus `focusStageHeading=true`. The pure reducer must not return `focusSelectedTab`, because it cannot know whether that DOM tab owned focus. Pause preserves selection and returns no focus request. Left/right roving focus wraps through tabs but selection changes only through the tabs interaction contract.

diffWorkbenchEvents announces only:

- newly discovered Run;
- raw status becoming terminal;
- aggregate freshness lost/restored;
- manual refresh completion;
- successful run-ID copy.

It must not announce one-second ticks, relative-time wording changes, row expansion, or unchanged polling snapshots.

**Task 8 presentation integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchPresentation.test.ts)
~~~

Expected: PASS because the presentation vertical slices above reached green.

**Implementation reference 8H: Pure presentation reducer**

Keep the API snapshot immutable. Return derived `current_counts`, signals, current-copy/owner eligibility, and idle eligibility in a separate PresentedWorkbench object. Manual pause stores pausedAtMonotonicMs; automatic visible mode uses the caller's current monotonic value. Receipt removal and fresh_until downgrade use alignedEpochMs, never Date.now after the snapshot is accepted. Add a reducer invariant test that deep-freezes the raw snapshot and proves all aggregate/signal/suspect/hide/pause downgrades update only PresentedWorkbench.

Centralize motion eligibility:

~~~typescript
export function mayAnimateRunning(
  signal: WorkbenchSignal,
  signalLocallyFresh: boolean,
): boolean {
  return signalLocallyFresh
    && signal.agent_current_state_complete
    && signal.lifecycle_status === 'active'
    && signal.raw_status === 'RUNNING'
    && signal.signal_state === 'active'
    && signal.fresh
    && !signal.suspect
}
~~~

Status label functions must return explicit Chinese text for all eight known statuses plus 未知状态（RAW_VALUE）. Implement `formatCompactNumber` with the exact tested locale/options above. Do not infer status from elapsed time, Tokens, or CSS class.

- [ ] **Step 11: Run focused frontend tests and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts src/agentWorkbenchPresentation.test.ts)
(cd web && npm run lint)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/api.ts web/src/agentWorkbenchApi.test.ts web/src/agentWorkbenchPresentation.ts web/src/agentWorkbenchPresentation.test.ts
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: model agent workbench presentation"
~~~

---

### Task 9: Build non-overlapping polling and the Execution Signal stage

**Files:**
- Create: web/src/useAgentWorkbenchPolling.ts
- Create: web/src/pages/AgentWorkbench.tsx
- Create: web/src/components/agent-workbench/LiveRunStage.tsx
- Create: web/src/AgentWorkbench.test.tsx
- Modify: web/src/index.css

**Interfaces:**
- Produces: useAgentWorkbenchPolling(range) -> snapshot/presentation/loading/refreshing/error/auto-update/refresh actions.
- Produces: AgentWorkbench page without assuming a fixed Agent count.
- Produces: LiveRunStage with tabs, one tabpanel, lifecycle rail, motion gate, idle/snapshot/degraded state, and stage-heading focus fallback.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `visible StrictMode mount fetches once`; render under `React.StrictMode`, run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'visible StrictMode mount fetches once')`, and observe RED.
- [ ] Create the hook/page shell with one visible/non-paused effective initial GET and StrictMode probe-cleanup reuse; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "visible StrictMode mount fetches once")`.
- [ ] Add `server cadence starts after settlement`; run the literal command at the end of this step for 5s then 30s and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "server cadence starts after settlement")`.
- [ ] Implement recursive settled-request timeout plus 1-60s clamp; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "server cadence starts after settlement")`.
- [ ] Add `StrictMode probe remount joins one in-flight request`; keep the first GET unresolved through the probe cleanup/remount and observe RED when a second GET starts. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "StrictMode probe remount joins one in-flight request")`.
- [ ] Implement only a module-scoped request-keyed shared in-flight record that the probe remount can join; rerun the literal command to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "StrictMode probe remount joins one in-flight request")`.
- [ ] Add `real unmount aborts shared request after deferred cleanup`; unmount without remount, flush one microtask/deferred cleanup boundary, and observe RED until the controller aborts exactly once. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "real unmount aborts shared request after deferred cleanup")`.
- [ ] Implement only subscriber counting plus deferred zero-subscriber abort; rerun the literal command to green without delaying ordinary settled scheduling. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "real unmount aborts shared request after deferred cleanup")`.
- [ ] Add `automatic requests never overlap in StrictMode`; resolve and advance several 5/30-second cycles and observe RED if maximum concurrent aggregate GETs exceeds one. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "automatic requests never overlap in StrictMode")`.
- [ ] Route recursive refresh through the shared record and arm the next timer only after settlement; rerun the literal command to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "automatic requests never overlap in StrictMode")`.
- [ ] Add `range change aborts obsolete generation` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "range change aborts obsolete generation")`.
- [ ] Implement abort/settle/generation guards and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "range change aborts obsolete generation")`.
- [ ] Add `stored pause performs no initial read` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stored pause performs no initial read")`.
- [ ] Implement synchronous sessionStorage hydration and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stored pause performs no initial read")`.
- [ ] Add `hidden mount waits for visibility` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hidden mount waits for visibility")`.
- [ ] Implement first-effect visibility gating and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hidden mount waits for visibility")`.
- [ ] Add `hide aborts and focus while hidden is inert`, including hidden-window-focus with zero GETs/timers, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide aborts and focus while hidden is inert")`.
- [ ] Implement hidden abort/focus guards and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide aborts and focus while hidden is inert")`.
- [ ] Add the paused-range half of `pause refresh and resume obey pending range` and observe RED when a range change reads. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Implement pending-range storage without a request and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Add the manual-refresh half and observe RED unless exactly one pending-range GET occurs. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Implement one-shot paused refresh without restarting timers and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Add the resume half and observe RED unless the pending range becomes active through one immediate GET. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Implement resume generation/timer activation and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")`.
- [ ] Add the pause-then-manual-refresh row to `aborted request queues one immediate successor` while the aborted promise is unsettled and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")`.
- [ ] Mark the aborted generation obsolete, coalesce one immediate intent, await AbortError settlement, and then issue exactly one successor; rerun that row to green with maximum concurrency one. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")`.
- [ ] **GREEN characterization:** Add the hide-then-visible unsettled row and require the same one-successor invariant. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")`.
- [ ] **GREEN characterization:** Add the pause-then-resume unsettled row and require the same one-successor invariant. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")`.
- [ ] Add the `fresh_until` row to `exact deadlines fire between elapsed ticks`, place it 250ms after a tick, and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")`.
- [ ] Implement earliest-deadline timeout/rearming and rerun the freshness row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")`.
- [ ] **GREEN characterization:** Add `suspect_at` 250ms after a tick and require the same exact-deadline path. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")`.
- [ ] **GREEN characterization:** Add `receipt_expires_at` 250ms after a tick and require the same exact-deadline path. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")`.
- [ ] Add `fresh deadline revokes stage current wording`; with fake timers cross `fresh_until` while deep-freezing the raw exact-positive snapshot, then require LiveRunStage to drop exact/current/owner wording and show last-confirmed evidence; observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes stage current wording")`.
- [ ] Pass `PresentedWorkbench.current_counts` into `LiveRunStage`; rerun the literal command to green and assert the stage never reads raw `snapshot.current_counts` for a current claim. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes stage current wording")`.
- [ ] Add `suspect deadline revokes owning stage wording`; cross one RUNNING signal's suspect boundary and observe RED while the raw snapshot remains unchanged. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes owning stage wording")`.
- [ ] Implement owning-bucket presentation propagation and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes owning stage wording")`.
- [ ] Add the visibility-hidden half of `hide and pause revoke stage current wording before render` and observe RED before any network response. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")`.
- [ ] Wire the synchronous hidden presentation downgrade into the stage and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")`.
- [ ] **GREEN characterization:** Add the manual-pause half and require the same static last-confirmed/no-owner wording with an unchanged raw snapshot. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")`.
- [ ] Add `header and range copy reflects snapshot truth` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "header and range copy reflects snapshot truth")`.
- [ ] Implement the header/radiogroup while preserving the displayed snapshot range and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "header and range copy reflects snapshot truth")`.
- [ ] Add `sync health unavailable keeps persisted data static` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "sync health unavailable keeps persisted data static")`.
- [ ] Implement the unavailable banner while retaining registry/history/cached static signals with no motion or idle claim; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "sync health unavailable keeps persisted data static")`.
- [ ] Add `no-record notice is distinct from idle` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "no-record notice is distinct from idle")`.
- [ ] Implement only `尚未注册 SEO Ops Agent` plus `管理 Agent` and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "no-record notice is distinct from idle")`.
- [ ] Add `disabled-only notice retains legacy signals` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "disabled-only notice retains legacy signals")`.
- [ ] Implement only `当前没有启用的 Agent` with static legacy chips and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "disabled-only notice retains legacy signals")`.
- [ ] Add `retired-only notice retains archived signals` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retired-only notice retains archived signals")`.
- [ ] Implement only `当前没有在册 Agent` plus `查看已归档` with static archived chips and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retired-only notice retains archived signals")`.
- [ ] Add `stage renders tabs and one selected panel` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage renders tabs and one selected panel")`.
- [ ] Implement semantic tabs plus one tabpanel and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage renders tabs and one selected panel")`.
- [ ] Add identity/time/Run-ID assertions to `stage detail exposes every factual field` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Render identity, semantic time, and copyable Run ID; rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Add association/trigger assertions to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Render only server-supplied association plus factual trigger fallback and rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Add Token/freshness assertions to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Render the server-provided Token state plus synchronization freshness text and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")`.
- [ ] Add the exact-owner row to `stage headline respects current-count quality` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Implement exact quality-qualified headline facts without counting `signals.length`; rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Add the lower-bound owner row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Implement only lower-bound headline copy and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Add the unknown-owner row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Implement only unknown headline copy and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")`.
- [ ] Add `unknown and legacy signals remain static` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "unknown and legacy signals remain static")`.
- [ ] Implement explicit unknown/lifecycle labels without known-state inference and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "unknown and legacy signals remain static")`.
- [ ] Add the focused network-removal row to `removed focused receipt transfers focus` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")`.
- [ ] Implement post-snapshot DOM-aware focus transfer to the next signal/stage heading and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")`.
- [ ] Add the focused local-expiry removal row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")`.
- [ ] Apply the same focus transfer after a presentation deadline commit and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")`.
- [ ] **GREEN characterization:** Add focus-elsewhere and final-signal-removal rows; require no focus stealing and deterministic heading fallback. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")`.
- [ ] Add the fresh verified active RUNNING row to `only qualified running signal has motion` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")`.
- [ ] Add the motion class only through `mayAnimateRunning` and rerun the positive row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")`.
- [ ] **GREEN characterization:** Add the table-driven static rows for non-RUNNING, stale/incomplete/suspect, disabled/retired, hidden/paused, and reduced-motion inputs; every row exercises the same false motion gate. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")`.
- [ ] Add the fully fresh/exact/no-signal active row to `idle requires fresh complete exact active proof` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")`.
- [ ] Implement only the positive idle predicate/panel and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")`.
- [ ] Add the table-driven denial rows for no active Agent, non-exact/stale proof, non-zero active bucket, and any actual signal; require the same predicate to remain false. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")`.
- [ ] **GREEN characterization:** Add active exact-zero plus disabled archival-quality-unknown with no legacy/unknown signal and require idle to remain allowed. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")`.
- [ ] Append the minimal scoped navy-stage layout and non-motion styles; rerun the stage/idle selections before Task 10 adds the frozen palette assertions. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'stage|idle')`.
- [ ] Add only the qualifying RUNNING motion selector and rerun the exact motion matrix. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")`.
- [ ] Run the complete presentation/page tests and lint before the final commit checkpoint below. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts src/AgentWorkbench.test.tsx && npm run lint)`.

**Contract reference 9A: Recursive cadence and no overlap**

With fake timers and deferred fetch promises, assert:

1. Mount performs one immediate GET for the selected range only when sessionStorage does not already say paused and `document.visibilityState === 'visible'`.
2. A response with refresh_after_ms=5000 schedules the next request five seconds after that request settles.
3. A response with refresh_after_ms=30000 schedules thirty seconds after settlement.
4. Advancing time while a promise is pending never starts a second request.
5. Delays are defensively clamped to 1000..60000; a malformed delay falls back to 30000.
6. While automatic update is running, changing range aborts the obsolete request, awaits its AbortError settlement, then requests the new range; observed concurrent request count never exceeds one.
7. If pause/manual refresh, hide/visible, or pause/resume happens before the aborted request settles, the old promise is never reused as the requested refresh. Record one coalesced immediate successor, wait for old settlement, then issue exactly one GET for the current generation/range/mode; concurrency remains one.
8. While manually paused, changing range records a pending range but performs no request until 刷新显示 or resume.
9. Unmount aborts the active request and clears refresh/tick/deadline timers.
10. The real `React.StrictMode` setup-cleanup-setup probe issues exactly one initial GET: probe cleanup defers abort to a microtask, the immediate second setup cancels that deferred abort and reuses the in-flight promise, and only one result can commit. A genuine unmount that is not followed by setup lets the deferred cleanup abort, invalidates the generation before any result commit, and leaves zero timers.

Capture each RequestInit.signal and assert AbortError is not surfaced as an operator error.

**Contract reference 9B: Visibility, focus, failure, and manual pause**

Mock document.visibilityState with Object.defineProperty and restore it after each test. Hiding:

- clears the next automatic refresh;
- aborts an automatic in-flight request;
- stops the one-second elapsed tick;
- immediately removes all motion classes and current-idle wording from cached presentation.

Returning visible or receiving window focus performs one immediate fetch when auto update is enabled, but the window-focus handler must first require `document.visibilityState === 'visible'`. While hidden, a window-focus event performs zero GETs and arms zero timers. Duplicate visibility/focus events still produce no overlap. Old motion does not return before a fresh successful response.

Pause writes seo-ops.agent-workbench.auto-update=paused to sessionStorage, aborts automatic work, freezes visible elapsed values, changes every current claim to 数据截至/截至 wording, and keeps selection/receipt focus. 刷新显示 performs exactly one aggregate `GET /api/agent-workbench` while remaining paused; it never implicitly reloads expanded-history endpoints. Resume writes running, applies local receipt/freshness expiry before paint, and fetches immediately while staying static until success. A normal fetch failure preserves the prior downgraded snapshot and retries at the prior cadence, or 30 seconds when no snapshot has succeeded.

An AbortController signal is not proof that its promise has settled. If an immediate manual, visible, or resume request arrives while the old automatic generation is aborting, mark that promise obsolete and queue one current intent rather than returning/reusing it. Multiple equivalent focus/visibility events coalesce. In `finally`, after the old AbortError settles and only if mount/visibility/pause rules still permit the queued reason, issue exactly one new aggregate GET for the latest range. The obsolete response cannot commit, surface an error, consume the manual action, or arm a cadence timer.

Preload sessionStorage with `seo-ops.agent-workbench.auto-update=paused` before mount and assert hydration performs zero GETs, arms no refresh/tick/deadline timer, and renders `自动更新已暂停 · 尚未读取` plus `刷新显示`. Focus/visibility events remain no-ops in that state. The first explicit `刷新显示` performs one GET and remains paused; Resume without a prior read performs one immediate GET and enters running mode only after that response settles. This persisted-pause case is distinct from clicking pause after a snapshot already exists.

Set `document.visibilityState='hidden'` before a non-paused mount and assert zero GETs and zero timers. Dispatching one transition to visible starts exactly one immediate GET; duplicate focus/visibility events share that in-flight request. No cached idle or motion state is shown before the first visible response.

Add exact-deadline fake-timer cases where fresh_until, a PENDING/RUNNING suspect_at, and receipt_expires_at each fall 250ms after a one-second elapsed tick. The hook must arm a separate timeout for the earliest aggregate/signal/suspect/receipt deadline, update at that exact boundary, remove/rearm it as deadlines pass, and not wait for the next one-second tick or network refresh. At suspect_at it must show `状态待确认`, remove motion, and preserve raw status. Hidden/paused mode cancels that timeout; restore/resume applies all elapsed deadlines synchronously before any new response.

**Contract reference 9C: Header, first load, refresh, range, and zero states**

First load renders 正在载入 Agent 状态 and never 当前全部空闲. Refresh with a snapshot keeps stage/table mounted and shows a compact 正在刷新. Header copy must cover:

~~~text
运行状态已刷新 · N 秒前
部分 Agent 状态延迟
状态可能延迟 · 上次成功同步 …
当前状态覆盖不完整
实时同步不可用 · 显示已保存数据
自动更新 · 运行中约 5 秒
自动更新 · 空闲最多 30 秒
自动更新已暂停 · 数据截至 …
~~~

Range selection is a labelled radiogroup with 今天, 近 7 天, 近 30 天, 全部; default is 近 30 天. 刷新显示 is labelled as a local snapshot reread and never claims to force Core AI.

When paused, selecting a different range shows 已选择近 N 天 · 当前仍显示 {snapshot.range} 数据 and does not relabel the visible metrics. 刷新显示 fetches the pending range once while remaining paused; resume immediately fetches it and resumes automatic cadence only after that response.

Render and assert all zero-state distinctions: no registry rows shows `尚未注册 SEO Ops Agent` plus `管理 Agent`; disabled rows with none active shows `当前没有启用的 Agent`; retired-only shows `当前没有在册 Agent` plus `查看已归档`. In the latter two fixtures, retain any disabled/retired legacy non-terminal signal in the stage as a static chip instead of replacing it with an empty-stage illustration. None of these notices may say `当前全部空闲`.

Render `sync_health='unavailable'` with persisted active registry rows, projected history, and a cached RUNNING raw signal. Assert the exact banner `实时同步不可用 · 显示已保存数据`, keep the table/history and cached signal visible, downgrade every current claim to snapshot wording, and render no motion or `当前全部空闲`. Missing Core AI configuration is a synchronization condition, never an empty-registry condition.

**Contract reference 9D: Tabs, selection, and stage states**

Render two Runs from one Agent and one from another. Assert three tabs, one tabpanel, complete ID copy labels, stable aria-controls/aria-labelledby IDs, and only the selected detail panel. ArrowLeft/ArrowRight wrap roving tab focus and activate the focused Run. Clicking a chip activates it without moving focus outside the tab. Assert the whole Workbench owns exactly one `aria-live="polite"` event-announcement region; all elapsed/relative `time` elements use `aria-live="off"`, a valid `datetime`, and an absolute-time accessible label.

Rerender with a refreshed snapshot and assert selection survives without stealing focus. For both a network snapshot replacement and the exact local `receipt_expires_at` deadline callback, before committing presentation state that removes the selected receipt capture whether `document.activeElement` is that old selected tab. If it was focused and another signal remains, assert deterministic next selection plus DOM focus on the newly selected mounted tab; if focus was elsewhere, assert the same selection change with no focus transfer. If the removed focused tab was the final signal, focus the stage heading; if focus was elsewhere, do not steal it. While paused, crossing receipt expiry must not remove the tab or move focus.

Test exact stage copies and rails for PENDING, RUNNING, PAUSED, uncertain, local archiving, COMPLETED, FAILED, TIMEOUT, CANCELLED, and SKIPPED receipts. aria-current=step appears only on the verified current lifecycle node; future nodes remain incomplete.

Add one active-registry signal with raw status `AWAITING_REVIEW` and one source-associated `raw_status=null` marker. Assert the former remains a selectable static chip/panel labelled `未知状态（AWAITING_REVIEW）`, while the latter reads `状态待确认（上游未返回状态）`; neither may disappear into history, use a known lifecycle node, or count as active/queued/waiting. For each selected signal also assert the Agent display name and business role, raw/presentation status, server-provided association label/link or 未关联商户, elapsed value from `started_at` or the factual `first_seen_at` fallback, short Run ID plus full copy name, actual trigger type or `触发来源待确认`, 完成后入账/known/unavailable Token state, and last successful synchronization/freshness text. These fields remain visible when motion is disabled.

Freeze the exact headline fixture with three RUNNING Runs across two active Agents (two from one owner and one from another), one PENDING Run from a third Agent, one PAUSED Run from a fourth, one archiving Run, one unknown signal, and one terminal receipt. Seed raw `snapshot.current_counts.running/queued/waiting` exact values 3/1/1, derive the still-fresh PresentedWorkbench copy, and pass only that presented copy to the stage. Assert `2 个 Agent · 3 个 Run 进行中`, plus separate `1 个排队`, `1 个等待输入`, and `1 个归档中` facts. In a second exact case keep only the two same-Agent RUNNING rows and assert `1 个 Agent · 2 个 Run 进行中`, proving owner de-duplication and multi-owner addition independently.

Run counts and their qualifiers always come from `presentation.current_counts`, never from the immutable `snapshot.current_counts`, chips, or `signals.length`: presentation `exact` renders the exact number, `lower_bound` renders `至少 N`, and `unknown` renders `当前数量未知` (with last-confirmed evidence only where the presented DTO supplies it). The distinct running-Agent set may be stated exactly only when `exact_owner_claim_allowed` is true and the visible active-signal cardinality matches the presented exact count. For lower-bound proof, use `已看到 N 个 Agent · 至少 M 个 Run 进行中`; for unknown/failed/locally-expired proof with cached RUNNING chips, use `已看到 N 个 Agent 的运行记录 · 当前数量未知`, never `N 个 Agent 正在工作`. Add one truncated-owner lower-bound case and one failed-owner unknown case: chips remain visible/static, but neither headline leaks an exact current Run or Agent claim. Apply the same exact/`至少 N`/`数量未知` rule independently to queued and waiting facts. Unknown signals and terminal receipts stay visible as chips but never inflate any current bucket. When presented exact running is zero, omit the running headline rather than rendering `0 个 Agent 正在工作`.

**Contract reference 9E: Exclusive motion and idle**

For every combination below, assert the Run status remains textual. Continuous pulse/rail motion appears only in the first three positive rows; every row in the static group remains motionless:

~~~text
RUNNING + active Agent + fresh signal + complete proof + not suspect -> motion
RUNNING + metadata warning only but healthy list proof              -> motion
RUNNING + owning Agent healthy while another Agent is stale         -> motion
--- static group ---
RUNNING + stale/incomplete/suspect/disabled/retired                 -> static
PENDING/PAUSED/terminal/uncertain/archiving                         -> static
~~~

当前全部空闲 renders only when there is at least one active Agent, aggregate active-registry proof is fresh and complete, the three active counts `running`/`queued`/`waiting` are exact zero, and there is no signal. `legacy_nonterminal` quality by itself is not an active-capacity condition: an otherwise exact-idle active registry may still show idle when a disabled/retired archival set is unknown but has no mirrored legacy, NULL-status, or unknown-status signal. An actual disabled/retired non-terminal, NULL-status, or unknown row remains a static signal (and UNKNOWN completeness blocker where applicable), so it still forbids the no-signal idle state. The idle panel includes the last completed Agent/time when supplied and 等待下一次派发. No pulse, sweep, or ambient class exists in idle.

**Final Task 9 integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/AgentWorkbench.test.tsx)
~~~

Expected: PASS because every vertical slice above reached green.

**Implementation reference 9F: Polling hook**

Initialize pause state synchronously from sessionStorage before the first fetch effect, and check `document.visibilityState` in that first effect and in every focus handler before requesting or arming timers. A stored paused value or initially hidden document performs no implicit mount read and arms no timer; hidden window-focus events are inert. Only `刷新显示`, Resume, or the first visible transition may start its first request under the corresponding rules. Otherwise use one recursive setTimeout scheduled only after any non-aborted automatic attempt settles. Keep refs for the inFlight promise plus its generation/obsolete flag, one coalesced immediate-refresh intent, AbortController, refresh timer, one-second tick timer, exact-deadline timer, latest snapshot, displayed range, pending selected range, mount generation, and a deferred-unmount cleanup token. During React StrictMode's immediate effect probe, cancel the queued cleanup and reuse the same still-valid in-flight read; during a genuine unmount, the microtask cleanup invalidates the generation before commit, aborts the request, and clears timers. Reuse an in-flight promise only when it still belongs to the current viable generation. If it is aborted/obsolete, queue the latest allowed manual/visible/resume intent, await settlement in `finally`, and start exactly one successor without overlap. Running-mode range replacement uses the same obsolete-generation queue. Paused-mode range selection changes only the pending range.

Use performance.now for presentation progression and sessionStorage for tab-local pause. Date.now may be used only for parsing absolute display labels unrelated to elapsed/freshness truth.

~~~typescript
const scheduleNext = (rawDelay: number | undefined) => {
  if (!autoEnabledRef.current || document.visibilityState !== 'visible') return
  const delay = Number.isFinite(rawDelay)
    ? Math.min(60_000, Math.max(1_000, rawDelay as number))
    : 30_000
  refreshTimerRef.current = window.setTimeout(() => {
    void refresh('automatic')
  }, delay)
}
~~~

On each accepted snapshot or local deadline transition, schedule a dedicated timeout for the earliest future aggregate fresh_until, per-signal fresh_until, PENDING/RUNNING suspect_at, or visible receipt_expires_at using aligned snapshot time. The callback advances pure presentation at the boundary and schedules the next deadline. On hide/pause/unmount, cancel refresh/tick/deadline timers and abort only Workbench requests. On visible/focus/resume, apply expired deadlines first, then deduplicate through inFlight and immediate-refresh state.

**Implementation reference 9G: Page shell and header**

The page owns selected range, selected signal ID, heading ref, selected-tab refs, manager opener, and the single polite announcement string. It delegates timing/state truth to the hook and pure reducer. Immediately before every presentation commit that can reconcile/remove signals—network replacement, manual/resume response, or local deadline transition—record whether `document.activeElement` is the old selected tab. After the DOM commit, consume `selectedWasRemoved`: only when that old tab had focus, focus the replacement selected tab or, when no signal remains, the stage heading. If focus was elsewhere, selection still reconciles but focus stays elsewhere; never steal focus merely because an item expired. Keep prior snapshot visible during refresh/error.

Render separate zero/degraded notices:

- no records: 尚未注册 SEO Ops Agent plus 管理 Agent;
- disabled but none active: 当前没有启用的 Agent while rows remain visible;
- only retired: 当前没有在册 Agent plus 查看已归档;
- incomplete proof: never use 当前全部空闲.

The backend keeps syncing while browser auto update is paused/hidden; explain this in the control's accessible description.

**Implementation reference 9H: LiveRunStage semantics**

Use real button tabs inside role=tablist and one role=tabpanel. Derive every per-state headline count, qualifier, current-copy mode, and owner eligibility from `presentation.current_counts` exactly as frozen in Contract 9D; chips supply only the de-duplicated visible-owner set and never the Run total. Raw `snapshot.current_counts` is forbidden here. Exact owner wording requires presented exact quality, `claim_is_current=true`, `exact_owner_claim_allowed=true`, and a matching visible active-signal cardinality; incomplete or locally expired proof uses only `已看到`/`数量未知`/last-confirmed language. The selected panel renders Agent name/role, explicit status, server association, snapshot-aligned elapsed text, actual trigger type or `触发来源待确认`, Token state, and synchronization freshness. Shorten Run IDs visually but keep complete ID in aria-label and clipboard content. Relative time elements have aria-live=off and an absolute-time aria-label; use time datetime for real timestamps.

The lifecycle rail is an ordered list. Add the exclusive .agent-workbench__signal--motion class only from mayAnimateRunning(). A terminal receipt may receive one .agent-workbench__receipt--enter class for at most 200ms if its ID is newly observed; settled receipt state is static.

**Implementation reference 9I: Scoped stage styles**

Define these page-scoped custom properties:

~~~css
.agent-workbench {
  --aw-stage: #19324A;
  --aw-page: #F5F7F9;
  --aw-card: #FFFFFF;
  --aw-live: #2CCBB6;
  --aw-live-dark: #176B60;
  --aw-success: #26765B;
  --aw-action-small: #9D5712;
  --aw-failure: #B4372E;
  --aw-stage-success: #71D7AF;
  --aw-stage-warning: #F2B56B;
  --aw-stage-failure: #FF9A91;
  --aw-secondary: #596F81;
  --aw-stage-divider: #5E7F95;
  --aw-stage-secondary: #A9BDC9;
}
~~~

Append; do not rewrite existing global CSS. Do not reuse global .badge.running because it animates without the Workbench freshness gate. Scope every new selector beneath .agent-workbench. Add reduced-motion rules now for pulse, rail, receipt entrance, and smooth scrolling; Task 10 extends them for the drawer.

- [ ] **Step 11: Run focused tests, lint, and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchPresentation.test.ts src/AgentWorkbench.test.tsx)
(cd web && npm run lint)
~~~

Expected: PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/useAgentWorkbenchPolling.ts web/src/pages/AgentWorkbench.tsx web/src/components/agent-workbench/LiveRunStage.tsx web/src/AgentWorkbench.test.tsx web/src/index.css
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: show live agent execution signals"
~~~

---

### Task 10: Add the scalable registry, history, management drawer, navigation, and complete styling

**Files:**
- Create: web/src/components/agent-workbench/AgentSummaryMetrics.tsx
- Create: web/src/components/agent-workbench/AgentRegistryTable.tsx
- Create: web/src/components/agent-workbench/AgentRunHistory.tsx
- Create: web/src/components/agent-workbench/AgentManagerDrawer.tsx
- Modify: web/src/pages/AgentWorkbench.tsx
- Modify: web/src/AgentWorkbench.test.tsx
- Create: web/src/agentWorkbenchStyles.test.ts
- Modify: web/src/App.tsx
- Modify: web/src/App.test.tsx
- Modify: web/vite.config.ts
- Create: web/src/viteProxy.test.ts
- Modify: web/src/index.css

**Interfaces:**
- Produces: selected-range summary cards whose historical coverage is never confused with current-state quality.
- Produces: an arbitrary-length Agent table with active/disabled default scope and explicit retired filter.
- Produces: locally paginated projected history; links are rendered only from server-provided LocalAssociation.
- Produces: a modal management drawer for every non-destructive registry operation.
- Adds: authenticated /agents route and sidebar entry Agent after 任务.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `summary qualifies incomplete range metrics`; run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'summary qualifies incomplete range metrics')` and observe RED.
- [ ] Create and mount `AgentSummaryMetrics` with only Run/outcome/rate coverage wording; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary qualifies incomplete range metrics")`.
- [ ] Add `summary keeps presented current counts independent of range`; add one exact-current case, change only the historical range, and observe RED if the current card changes or reads raw snapshot current counts. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary keeps presented current counts independent of range")`.
- [ ] Implement the exact-current formatter from `presentation.current_counts` only; rerun the literal command to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary keeps presented current counts independent of range")`.
- [ ] Add the lower-bound row to `summary presents lower-bound and observed-unknown current counts` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Implement only `至少 N` current-count copy from PresentedWorkbench and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Add the observed-unknown row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Implement only timestamped last-confirmed unknown copy and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Add the never-confirmed unknown row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Implement only `当前数量未知 · 尚无成功确认` and finish the focused selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")`.
- [ ] Add the zero success-denominator row to `summary distinguishes zero denominator and zero tokens` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")`.
- [ ] Implement only the em-dash rate formatter and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")`.
- [ ] Add the known-zero Token row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")`.
- [ ] Implement only factual zero Token/coverage copy and finish the focused selection green without changing current counts. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")`.
- [ ] Add `fresh deadline revokes summary current wording`; with fake timers cross `fresh_until`, keep the raw exact-positive snapshot deep-frozen, and observe RED until AgentSummaryMetrics withdraws exact/current wording from the PresentedWorkbench copy. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes summary current wording")`.
- [ ] Pass only `presentation.current_counts` to the current portion of AgentSummaryMetrics; rerun the literal command to green and assert selected-range cards still read raw historical summary/coverage. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes summary current wording")`.
- [ ] Add `suspect deadline revokes summary owning count`; cross one RUNNING signal's boundary and observe RED while raw status/counts remain unchanged. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes summary owning count")`.
- [ ] Consume the existing PresentedWorkbench downgrade without adding a component clock and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes summary owning count")`.
- [ ] Add the visibility-hidden half of `hide and pause revoke summary current wording` and observe RED before a new fetch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")`.
- [ ] Wire the existing hidden PresentedWorkbench transition into the summary and rerun that half to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")`.
- [ ] **GREEN characterization:** Add the manual-pause half and require the same withdrawal of exact/lower-bound/current-tense copy. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")`.
- [ ] Add `summary never renders mirrored count over stale zero total`; feed mirrored 1/effective remote NULL with `LOCAL_RUN_UNCONFIRMED`, assert `基于已镜像 1 次 · 上游总数未知` and absence of `1/0`, then keep this case green using only the server-qualified coverage DTO. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary never renders mirrored count over stale zero total")`.
- [ ] Add `registry supports twelve mixed lifecycle agents`; run the literal command at the end of this step and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")`.
- [ ] Create the arbitrary-length table shell and sort default active/disabled rows by `sort_order`/name; rerun and keep the retired-filter assertion RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")`.
- [ ] Add the explicit archived filter and finish the twelve-Agent selection green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")`.
- [ ] Add `registry row renders factual metrics and warnings` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry row renders factual metrics and warnings")`.
- [ ] Implement row cells/badges only from server snapshot fields and rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry row renders factual metrics and warnings")`.
- [ ] Add `expansion loads first local history page` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "expansion loads first local history page")`.
- [ ] Implement one accessible expansion button plus the first 20-item request and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "expansion loads first local history page")`.
- [ ] Add the matching-cursor append row to `history cursor appends only matching response` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")`.
- [ ] Implement request-keyed append and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")`.
- [ ] Add the range-race row and observe RED when an obsolete response appends. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")`.
- [ ] Add history generation/AbortController guards and rerun the race row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")`.
- [ ] **GREEN characterization:** Add collapse-abort and unmount-abort rows and require the same obsolete-response guard with zero late commits. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")`.
- [ ] Add `paused range change performs zero aggregate and history reads`; expand one row, pause, choose a pending range, and observe RED if either endpoint is called. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused range change performs zero aggregate and history reads")`.
- [ ] Keep the old-range history cache visibly labelled while storing the pending range and issuing zero reads; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused range change performs zero aggregate and history reads")`.
- [ ] Add `paused manual refresh and history controls permit only one read`; click `刷新显示`, resolve one aggregate GET, then exercise history controls and observe RED if any history GET or second aggregate GET occurs. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused manual refresh and history controls permit only one read")`.
- [ ] Implement the common cache-only paused history branch, old-range label, uncached explanation, and disabled paging; rerun the focused case to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused manual refresh and history controls permit only one read")`.
- [ ] Add `resume reloads expanded history after aggregate acceptance`; require aggregate acceptance before any history GET and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "resume reloads expanded history after aggregate acceptance")`.
- [ ] Implement displayed-range binding plus one request per expanded row/no collapsed-row request and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "resume reloads expanded history after aggregate acceptance")`.
- [ ] Add status/time/trigger assertions to `history item exposes factual fields and warning badges` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Render raw/presentation status, semantic time, duration, and factual trigger fallback; rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Add Token/association/error/ID assertions to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Render the four Token states, server association, sanitized error, and copyable full ID; rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Add warning-badge assertions to the same test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Render only server warning codes/archive flag and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")`.
- [ ] Add `register mutation rereads persisted snapshot` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "register mutation rereads persisted snapshot")`.
- [ ] Implement only register-mode drawer/body/persisted readback and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "register mutation rereads persisted snapshot")`.
- [ ] Add the edit row to `edit disable and re-enable use exact contracts` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Implement only edit mode/action and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Add the disable row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Implement only disable action/persisted lifecycle result and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Add the verified re-enable row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Implement only re-enable action/persisted `sync_pending` result and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")`.
- [ ] Add the retire row to `retire and replace require explicit confirmation` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")`.
- [ ] Implement only bodyless retire confirmation without a delete path and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")`.
- [ ] Add the replace row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")`.
- [ ] Implement only replace confirmation and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")`.
- [ ] Add the paused-register row to `paused mutation does not bypass read pause` and observe RED if a follow-up read occurs. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")`.
- [ ] Implement the common paused mutation-success branch: show returned persistence state, keep aggregate/history untouched, and issue zero follow-up reads; rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")`.
- [ ] **GREEN characterization:** Add edit/disable/re-enable/retire/replace rows and require the same common paused branch with zero aggregate/history follow-up reads. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")`.
- [ ] Add duplicate/inaccessible/unpublished field-error rows to `structured mutation errors bind fields` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")`.
- [ ] Bind server fields through `aria-describedby` and rerun those rows to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")`.
- [ ] Add the form-level error row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")`.
- [ ] Add only the form `role=alert` fallback and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")`.
- [ ] Add `drawer portal stays outside inert application root` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer portal stays outside inert application root")`.
- [ ] Implement only the portal sibling mount point and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer portal stays outside inert application root")`.
- [ ] Add register-mode input focus to `drawer mode chooses deterministic initial focus` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")`.
- [ ] Implement input-mode initial focus and rerun the register row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")`.
- [ ] **GREEN characterization:** Add edit and replace input-mode rows and require the same focus branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")`.
- [ ] Add the input-free retire row and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")`.
- [ ] Focus the readable retire heading with `tabIndex={-1}` and finish the focused test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")`.
- [ ] Add `drawer explicit focus handler wraps forward` at the final control and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps forward")`.
- [ ] Implement only forward wrap and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps forward")`.
- [ ] Add `drawer explicit focus handler wraps backward` at the first control and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps backward")`.
- [ ] Implement only reverse wrap and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps backward")`.
- [ ] Add the initially non-inert row to `drawer restores preexisting inert state` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")`.
- [ ] Implement exact inert apply/remove restoration and rerun that row to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")`.
- [ ] **GREEN characterization:** Add pre-existing inert attribute/property rows and require exact preservation on close/unmount. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")`.
- [ ] Add `drawer escape restores opener during pending request` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer escape restores opener during pending request")`.
- [ ] Implement late-update suppression plus exact opener restoration and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer escape restores opener during pending request")`.
- [ ] Add `agents navigation and direct route`; run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/App.test.tsx -t 'agents navigation and direct route')` and observe RED.
- [ ] Add the Agent glyph/link/route while preserving every existing route and `/api/auth/me`; rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/App.test.tsx -t "agents navigation and direct route")`.
- [ ] Add `vite proxy targets IPv4 loopback`; import/read the exported Vite config and assert `/api` resolves to `http://127.0.0.1:8000`, then run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/viteProxy.test.ts -t 'vite proxy targets IPv4 loopback')` and observe RED against the current localhost target.
- [ ] Change only the development `/api` proxy target to `http://127.0.0.1:8000`; rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/viteProxy.test.ts -t 'vite proxy targets IPv4 loopback')` to green. Keep Task 11's API bound to that exact IPv4 address; the readback CLI may still accept either explicit loopback spelling after its own validation.
- [ ] Add `workbench palette meets contrast contract` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench palette meets contrast contract")`.
- [ ] Add only the frozen scoped palette tokens/selectors and rerun the contrast test to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench palette meets contrast contract")`.
- [ ] Add the reduced-motion assertions to `workbench accessibility fallbacks are scoped` and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Append only the scoped reduced-motion overrides and rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Add the forced-colors assertions and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Append only the scoped forced-colors rules and rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Add keyframe-exclusivity assertions and observe RED if a static state matches continuous motion. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Scope keyframes to the qualifying RUNNING class and rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Add portal-drawer scope assertions and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Append only the portal drawer selectors and rerun those assertions to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Add table-overflow/reflow assertions and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Append only the internal table overflow/reflow rules and finish the focused style test green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")`.
- [ ] Run the complete Task 10 UI/style/navigation selection and lint; all tests must be green before the final commit checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx src/App.test.tsx src/agentWorkbenchStyles.test.ts src/viteProxy.test.ts && npm run lint)`.

**Contract reference 10A: Global summary and current counts**

Above the table render the selected range's Run 数, 成功完成, 成功率, 已知总 Tokens, and Token 覆盖 from the immutable `snapshot.summary`. Beside them render current queued/running/waiting counts only from `presentation.current_counts`, plus presented legacy_nonterminal only when non-zero or non-exact. The current cards must never read raw `snapshot.current_counts`.

Assert historical cards use metrics_complete_for_range/coverage and show `基于已镜像 N/M 次` on every affected Run/outcome/rate/Token value only when `remote_total_runs` is a server-qualified non-null denominator. When it is NULL—including an unconfirmed local Run over a persisted stale zero—use `基于已镜像 N 次 · 上游总数未知`; never render `N/null`, positive `N/0`, or repair the value in React. Current cards independently use each PresentedCurrentCount quality and never inherit the range qualifier. A zero success denominator displays —; known zero Tokens displays 0 and 已知 0/0 次; lower-bound/unknown current text follows Task 8's presentation contract. For `quality='unknown'`, render `当前数量未知 · 上次确认 N（时间）` only when both presented evidence fields exist; when both are NULL render `当前数量未知 · 尚无成功确认`, never `null` or an invalid date. Selecting a new range changes historical metrics but does not relabel current counts as range-bound. At fresh/suspect/hide/pause downgrade, the raw snapshot remains unchanged while both this current summary and the stage withdraw exact/`至少`/current-tense owner claims in the same render.

**Contract reference 10B: Arbitrary-count table and row metrics**

Render twelve mixed-lifecycle Agents and assert there is no five-Agent/card assumption. Default rows include active and disabled, exclude retired, and sort by sort_order then display_name. 查看已归档 reveals retired rows.

For every row assert name/role, lifecycle, current or last terminal state, selected-range Run count, success rate, known input/output/total Tokens, Token coverage, last successful sync, and history coverage. Display:

~~~text
success denominator zero        -> —
known zero Tokens               -> 0
missing terminal Token pair     -> 不可用
non-terminal Token state        -> 完成后入账
unconfirmed Token eligibility   -> 状态确认后判断
known coverage                  -> 已知 N/M 次
incomplete history              -> 基于已镜像 N/M 次
lower-bound current count       -> 至少 N
unknown current count           -> 当前数量未知 · 上次确认 N（时间）
unknown with no observation     -> 当前数量未知 · 尚无成功确认
unknown upstream total          -> 基于已镜像 N 次 · 上游总数未知
~~~

Abbreviated visual numbers must keep the complete number in aria-label and use tabular numerals.

Give an Agent a metadata-verification warning and a separate current-sync warning, then assert both appear as textual badges in that Agent's row/details. A metadata-only warning remains visually present while the same Agent's independently healthy RUNNING stage signal still qualifies for motion.

**Contract reference 10C: Expansion, cursor, and local links**

Expansion uses a button with aria-expanded/aria-controls. While auto update is running, opening one row requests its first 20 history items for the currently displayed `snapshot.range` and keeps the operator on /agents. Loading more passes exactly next_before; a null cursor removes the control. History never binds to the header's pending range. Only acceptance of a new aggregate snapshot with a different `snapshot.range` may abort old history requests and reload expanded rows. While paused, every expansion/history/load-more interaction is cache-only and performs zero GETs: an already loaded row may reveal its frozen items, an uncached row says `自动更新已暂停 · 恢复后载入历史`, and history paging controls are disabled/absent. Acceptance of a manually refreshed aggregate preserves expanded IDs and old items, labels them `历史仍为 {oldRange} · 当前页面为 {newRange}`, and performs zero history requests. After resume, first accept the immediate aggregate response; only then request the displayed range once for each still-expanded row, while collapsed rows remain unloaded.

Refreshes preserve the set of expanded local Agent IDs, filters, scroll position, and focused control. Collapse/unmount aborts that row's history request. Render local_href/local_label exactly when present. For an unassociated item render 未关联商户; never construct a route from source_kind/source_local_id in the browser.

For expanded history fixtures assert raw/presentation status, start and completion `time[datetime]` elements with absolute accessible labels, duration, nullable trigger fallback, all four known/pending/unavailable/unconfirmed Token states, sanitized error summary, association, and copyable full Run ID. Feed `LOCAL_TRIGGER_STATUS_MISSING`, `TERMINAL_STATUS_CONFLICT`, `TOKEN_USAGE_INVALID`, and `ARCHIVE_DELAY` through `warning_codes`/`archive_delayed` and assert visible `状态待确认`, `状态冲突`, `Token 数据异常`, and `归档延迟` badges. Timers stay `aria-live="off"`; the page still has exactly one polite event region.

**Contract reference 10D: Management mutation and readback**

Cover register, presentation edit, disable, verified re-enable, retire confirmation, and replace. Assert exact API bodies from Task 3. When auto update is running, on success show the persisted returned lifecycle and sync_pending state, then reread `GET /api/agent-workbench` without claiming upstream discovery finished. When paused, the explicit mutation itself remains allowed, but it must not bypass the read pause: show only the mutation response's persisted Agent lifecycle/sync_pending in a confirmation state, leave the main snapshot/history untouched, display `设置已保存 · 页面仍为暂停快照；点击刷新显示或恢复自动更新`, and perform zero follow-up aggregate/history GETs. Only the existing `刷新显示` action may make the one paused local read; resume follows Task 9's sequence.

Duplicate/inaccessible/unpublished errors render the server's sanitized message. ApiError.fields values attach through aria-describedby to the matching field; a form-level error gets role=alert. There is no delete button or DELETE request.

Populate `snapshot.sync_warnings` with configuration, association, metadata, terminal-conflict, and archive-delay warnings. Assert a labelled static `运行告警` list renders each sanitized message and its Agent/Run context when present without creating another live region. The same warnings also remain available at their per-Agent/per-history locations; hiding a global warning must never change status, count, or motion semantics.

**Contract reference 10E: Modal focus and keyboard behavior**

Open from 管理 Agent and assert:

- portal dialog has role=dialog, aria-modal=true, and accessible name;
- the portal wrapper outside `#root` has `class="agent-workbench agent-workbench__portal"`, so every scoped drawer/reduced-motion/forced-colors selector applies;
- register/edit/replace focus the first relevant input; the input-free retire confirmation focuses its readable heading with `tabIndex={-1}` rather than leaving focus in inert content or pre-focusing the destructive confirmation;
- the entire application root behind the portal has the inert attribute while open and, when the runtime exposes `HTMLElement.inert`, its property is true; that root contains sidebar navigation, workspace header, logout, and Workbench content;
- invoking the drawer's Tab handler from the last control wraps to first, and invoking Shift+Tab from first wraps to last;
- Escape closes and restores the opener even if the request is still settling; ignore late component state updates and rely on persisted readback when reopened;
- close restores focus to the exact opener;
- all errors remain associated with their fields.

Use fireEvent.keyDown because no user-event dependency is installed, and assert the focus value produced by the application handler only. jsdom 29 neither implements native inert behavior nor performs browser sequential focus movement from `fireEvent.keyDown`; these unit tests must not claim either capability. Restore document body, portal node, inert attribute/property state, and focus between tests.

Explicitly query the sidebar Agent link and header logout control while the drawer is open and assert both are descendants of the one root carrying the inert attribute. Seed a pre-existing inert attribute and, when supported, property state in one test and assert cleanup restores each exact prior state rather than blindly removing it. Reserve proof that those background controls cannot receive real sequential keyboard focus for Task 11's browser acceptance matrix.

**Contract reference 10F: Navigation and direct route**

Update the existing dirty navigation assertion from 看板/商户/任务 to exactly 看板/商户/任务/Agent. Navigate directly to /agents after the operator session resolves, assert Agent is aria-current=page, and assert the page makes only the SEO Ops aggregate request beyond the existing `/api/auth/me` session check. Merchant, Task, Run, and Dashboard active-state behavior remains unchanged.

**Contract reference 10G: Palette, contrast, and fallbacks**

agentWorkbenchStyles.test.ts reads index.css, extracts the exact custom properties, and computes WCAG relative luminance without a dependency. Assert at least 4.5:1 for:

~~~text
#2CCBB6, #71D7AF, #F2B56B, #FF9A91, #A9BDC9, #FFFFFF on #19324A
#176B60, #26765B, #9D5712, #B4372E, #596F81 on #FFFFFF
~~~

Assert selectors are scoped beneath .agent-workbench, continuous keyframes are referenced only by .agent-workbench__signal--motion, reduced-motion disables pulse/rail/receipt/drawer/smooth-scroll animation, and forced-colors retains borders, focus outlines, selected tabs, and status text.

**Task 10 vertical-slice integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/AgentWorkbench.test.tsx src/agentWorkbenchStyles.test.ts src/App.test.tsx)
~~~

Expected: PASS because each component/interaction/style slice above was taken from RED to green before this combined checkpoint.

**Implementation reference 10H: AgentSummaryMetrics**

Use `snapshot.summary`, `presentation.current_counts`, `metrics_complete_for_range`, and `snapshot.coverage` exactly; do not recalculate outcomes, Tokens, freshness, or current quality in React. Raw `snapshot.current_counts` is forbidden in this component. Give full numerical values accessible names and use Task 8's tested `formatCompactNumber` only for visual text. Implement both nullable fallbacks from Contract 10A. Mount this component between `LiveRunStage` and `AgentRegistryTable`, so the page visibly includes the global selected-range/current summary rather than leaving it as an unused component. In the page shell, render `snapshot.sync_warnings` as the labelled static `运行告警` list from Contract 10D; do not add `aria-live` to it. The component has no timer and no motion.

**Implementation reference 10I: AgentRegistryTable and AgentRunHistory**

Use a labelled horizontally scrollable table region at the existing 1180px application minimum. The row itself is not clickable; use one real expansion button. Key expansion/history state by immutable local Agent ID so replacement and reordering cannot move state to another Agent.

Each expanded history owns an AbortController and appends only when its cursor still matches the response request. A request for an older range/cursor that resolves late is ignored. Key history requests to the accepted `snapshot.range`, never `pendingRange`. On an auto-enabled accepted range change, abort and reload expanded histories; on a paused accepted range change, retain and label old-range items and make all history controls cache-only. Resume waits for its aggregate response before reloading still-expanded histories, preventing old/new range races. Render `raw_status` verbatim when non-null, the explicit server `presentation_group`, the statusless fallback when null, real time elements, duration, actual `trigger_type` or `触发来源待确认`, the serialized four-state Token copy, run-ID copy, sanitized error summary, server association, and mapped `warning_codes`/`archive_delayed` badges. Render each `WorkbenchAgent.warnings` entry as a textual row/detail badge; do not let warning presence alter computed motion or state.

**Implementation reference 10J: Management drawer**

Render through createPortal(document.body) into a dedicated wrapper outside `#root` with `class="agent-workbench agent-workbench__portal"`; remove that wrapper during cleanup. This preserves the page-scoped CSS contract for drawer, reduced-motion, and forced-colors rules even though the portal is outside the page root. Store document.activeElement before opening; capture the existing inert attribute and feature-detected `HTMLElement.inert` property of `#root`, always set the attribute and set the property when supported, focus the first field for register/edit/replace or the `tabIndex={-1}` heading for retire, enumerate enabled drawer controls for explicit wrapping, listen for Escape, then restore the exact prior attribute/property state and opener focus in cleanup. The sidebar, workspace header, logout, and page content must all be inside the inert root; never inert only the Workbench panel.

Use explicit modes:

~~~typescript
type DrawerMode =
  | { kind: 'register' }
  | { kind: 'edit'; agent: WorkbenchAgent }
  | { kind: 'replace'; agent: WorkbenchAgent }
  | { kind: 'retire'; agent: WorkbenchAgent }
~~~

Label submit actions 验证并注册, 保存设置, 验证并替换, and 确认归档. Re-enable uses lifecycle_status=active and labels the server action as requiring fresh Core AI verification. Show `agent.coreai_metadata.timeout_hint_seconds` only as Core AI 配置参考值; the editable local field is 状态待确认阈值. Never call Core AI from the browser.

Receive the page's paused/running state explicitly. After a successful mutation in running mode, request the aggregate normally. In paused mode, render the server-returned `AgentRegistryRecord` confirmation inside the drawer/toast without merging it into the immutable page snapshot and without calling aggregate or history; route the operator only to the existing `刷新显示` or resume controls. Closing the drawer does not implicitly read.

**Implementation reference 10K: Navigation and route**

Extend NavGlyph's union and path map with an Agent network glyph. Add agentsActive = pathname === '/agents', the sidebar link after 任务, and Route path=/agents. Preserve the already integrated Performance Dashboard import/route and all unrelated dirty App.tsx work.

**Implementation reference 10L: Scoped table, drawer, responsive, and accessibility CSS**

Append the remaining .agent-workbench block. Reflow the header/actions/drawer fields vertically at 200% zoom, confine table overflow to its labelled region, and verify no Workbench-specific page-wide horizontal overflow at 1180, 1440, or 1920 CSS pixels. The legacy shell min-width remains unchanged.

Only orange operator actions use the orange family; bright teal remains navy-stage RUNNING only. Use dark teal plus icon/text on white. Every state retains a textual label and shape. Add max-200ms non-looping receipt entrance, restrained drawer slide, strong focus-visible rings, and full reduced-motion/forced-colors overrides.

- [ ] **Final Task 10 checkpoint: Run focused tests, full frontend checks, and commit**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts src/agentWorkbenchPresentation.test.ts src/AgentWorkbench.test.tsx src/agentWorkbenchStyles.test.ts src/viteProxy.test.ts src/App.test.tsx)
(cd web && npm test)
(cd web && npm run lint)
(cd web && npm run build)
~~~

Expected: all PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/components/agent-workbench/AgentSummaryMetrics.tsx web/src/components/agent-workbench/AgentRegistryTable.tsx web/src/components/agent-workbench/AgentRunHistory.tsx web/src/components/agent-workbench/AgentManagerDrawer.tsx
git add -- web/src/pages/AgentWorkbench.tsx web/src/AgentWorkbench.test.tsx web/src/agentWorkbenchStyles.test.ts
git add -- web/src/App.tsx web/src/App.test.tsx web/vite.config.ts web/src/viteProxy.test.ts web/src/index.css
git diff --cached --name-only
git diff --cached
git diff --cached --check
git commit -m "feat: complete agent workbench UI"
~~~

---

### Task 11: Prove the complete truth path and release gates

**Files:**
- Create: api/tests/test_agent_workbench_acceptance.py
- Create: api/tests/agent_workbench_live_app.py
- Create: api/tests/agent_workbench_live_readback.py
- Create: api/tests/agent_workbench_visual_fixture.py

**Interfaces:**
- Proves: configured/registered Agent -> bounded list proof -> SQLite readback -> operator aggregate -> browser downgrade/receipt behavior.
- Produces: a test-only loopback ASGI app using the real production app factory/router/auth/DB bootstrap, independent cancellation-aware parked replacements for both existing ordinary schedulers, and either the real Workbench sync loop or an explicitly parked restart-probe loop.
- Produces: a read-only live reconciliation CLI for configured IDs, bounded statuses/totals/Tokens, SQLite projection, and the authenticated aggregate.
- Produces: a guarded, disposable visual-fixture generator for active, idle, partial, and stale acceptance states; it exposes no production API or UI surface.

**Mandatory vertical verification and release order:**

- [ ] Create the shared temporary-database/TestClient/list-only-fake harness; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q --collect-only)` and make collection pass.
- [ ] Add `test_registration_persists_before_first_proof`; run the literal command at the end of this step and require PASS against Tasks 1-7. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_registration_persists_before_first_proof)`.
- [ ] Add `test_local_running_acceptance_revokes_exact_idle`; run the literal command at the end of this step and require the static/unconfirmed row, nullable trigger type, event-epoch increment, unknown bucket, and no-idle assertions to pass. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_local_running_acceptance_revokes_exact_idle)`.
- [ ] Add `test_old_zero_cycle_cannot_overwrite_local_run`; use two connections/events and run the literal command at the end of this step to verify a pre-event response cannot restore exact idle. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_zero_cycle_cannot_overwrite_local_run)`.
- [ ] Add `test_old_zero_cycle_cannot_overwrite_statusless_acceptance`; repeat with a missing trigger-response status and require the exact ID/source-associated `raw_status=NULL` projection, all three buckets unknown, and the old-cycle commit fenced; then run a new exact-zero cycle and prove the durable marker still blocks idle until a valid page observes that ID with a non-empty status. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_zero_cycle_cannot_overwrite_statusless_acceptance)`.
- [ ] Add `test_immediate_terminal_trigger_requires_list_confirmation`; repeat for one terminal status and SKIPPED, require immutable terminal observation/no receipt, all-bucket current uncertainty, effective remote total NULL instead of 1/0, static archiving only when the exact local source is still running, `fresh=false`, `fresh_until=null`, and no restoration after post-event exact-zero; then confirm the exact IDs through valid pages/consistent totals without restarting a receipt. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_immediate_terminal_trigger_requires_list_confirmation)`.
- [ ] Add `test_old_disabled_cycle_cannot_satisfy_reenable`; run the literal command at the end of this step and require re-enable `sync_pending`/due-now/event-epoch state to survive the archival response. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_disabled_cycle_cannot_satisfy_reenable)`.
- [ ] Add `test_list_confirmation_enables_running_signal`; run the literal command at the end of this step and require actual trigger type, exact current proof, five-second recommendation, and motion eligibility. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_list_confirmation_enables_running_signal)`.
- [ ] Add `test_terminal_projection_persists_tokens_and_receipt`; run the literal command at the end of this step and require immutable terminal observation/receipt plus known zero/nonzero Token cases. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_projection_persists_tokens_and_receipt)`.
- [ ] Add `test_local_archiving_settles_to_static_receipt`; run running-source and settled-source cases separately until both pass. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_local_archiving_settles_to_static_receipt)`.
- [ ] Add `test_repeat_discovery_never_moves_receipt_expiry`; run the literal command at the end of this step and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_repeat_discovery_never_moves_receipt_expiry)`.
- [ ] Add `test_external_run_discovery_bound_and_unassociated_copy`; run the literal command at the end of this step and require the 30-second projection/60-second open-browser bound without local association. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_external_run_discovery_bound_and_unassociated_copy)`.
- [ ] Add `test_old_terminal_backfill_has_no_receipt`; run the literal command at the end of this step and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_terminal_backfill_has_no_receipt)`.
- [ ] Add `test_mixed_proof_remains_honest`; run truncated, failed, NULL-status, unknown-status, and same-cycle-conflict cases one at a time and require the expected lower-bound/unknown/static/no-idle outputs. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`.
- [ ] Add `test_fresh_app_instance_reads_durable_projection`; close all connections, create a new application/TestClient, run the literal command at the end of this step, and require unchanged readback with no Core AI call. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_fresh_app_instance_reads_durable_projection)`.
- [ ] Run the complete acceptance file before building release-only helpers. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q)`.
- [ ] Add `test_live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench`; inject separate ordinary-scheduler and Local-Falcon-scheduler fakes that fail if called plus an event-recording Workbench loop; run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)` and observe the missing safe-harness failure.
- [ ] Implement `agent_workbench_live_app.py` from Task 7's real `create_app`/`create_lifespan` factories with two independent cancellation-aware parked ordinary schedulers; rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)` until production route/auth parity, zero scheduler/Local-Falcon/trigger calls, Workbench-loop start, cancellation, and all three awaited finalizers are green.
- [ ] Add `test_terminal_tokens_survive_real_server_restart`; launch two separate uvicorn subprocesses in sequence against one marked temporary database, run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k terminal_tokens_survive_real_server_restart)` and observe RED until process A writes/serves then exits and process B serves the exact persisted terminal status/Token/receipt/history durable subset with all three loops parked and Core AI unavailable.
- [ ] Implement guarded write/read startup phases in `agent_workbench_live_app.py`; for B use only `mode=ro` request dependencies plus a write-denying authorizer, assert zero init/seed/prime/write-hook calls and unchanged DB/sidecar hashes, retain sanitized PID/exit/hash/readback evidence, and rerun until the actual process-boundary test is green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`.
- [ ] Add `test_live_readback_structural_and_sanitization_contract`; inject credential/body/header/query sentinels into transport failures and 500 text/JSON responses, then capture stdout/stderr/JSON/exception repr as well as SQLite/API data; run the literal command at the end of this step and observe the missing CLI-helper failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`.
- [ ] Implement argument parsing, secret-safe loading/output, registry-to-aggregate set comparison, structural failure codes, and fixed code-only diagnostics for every transport/HTTP/malformed/unexpected failure; never inspect `CoreAiError.args`, `str(exc)`, repr, body, or cause. Rerun until no sentinel or raw body/cause can cross any output boundary. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`.
- [ ] Add `test_live_readback_rejects_non_loopback_url_and_redirect`; run external-host, userinfo, path/query/fragment, missing-port, and 3xx cases separately; implement strict loopback URL validation plus redirects-off HTTP until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`.
- [ ] Add `test_live_readback_directly_reads_every_active_or_configured_agent`; require four bounded list calls plus metadata per de-duplicated ID regardless of scheduler due time; implement that direct request plan until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_directly_reads_every_active_or_configured_agent)`.
- [ ] Add `test_live_readback_caps_agent_bundles`; use seventeen blocked Agents, run the literal command at the end of this step, and implement an eight-worker cap with metadata/four-list calls serialized inside each Agent bundle until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_caps_agent_bundles)`.
- [ ] Add `test_live_readback_clock_only_heartbeat_keeps_segment_stable`; advance 30-second proof timestamps across slow bundles and run the literal command at the end of this step; implement the semantic-versus-clock marker split until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_clock_only_heartbeat_keeps_segment_stable)`.
- [ ] Add `test_live_readback_material_change_invalidates_only_its_segment`; change one Agent's status/Token/revision during its bracket and implement per-Agent invalidation without discarding stable peers until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_material_change_invalidates_only_its_segment)`.
- [ ] Add `test_live_readback_retries_only_changed_segment`; assert one normal-delay retry reissues exactly that Agent's five calls plus the short local bracket, then implement targeted retry scheduling until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retries_only_changed_segment)`.
- [ ] Add `test_live_readback_never_splices_segment_attempts`; give attempt A remote data and attempt B local data that would falsely match if mixed, then implement immutable attempt records until the result remains a mismatch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_never_splices_segment_attempts)`.
- [ ] Add `test_live_readback_compares_status_ids_owners_totals_and_tokens`; add same-total/different-ID, wrong returned `row.agent_id`, wrong projected local owner, unresolved `raw_status=NULL`, exact, and bounded-overlap cases separately and implement identity/ownership-first projection/aggregate comparisons until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`.
- [ ] Add `test_live_readback_retry_outcomes`; run clean-first, clean-second, repeated-mismatch, changing-mismatch, and changing-watermark cases separately; implement exact `LIVE_GATE_MISMATCH`/`LIVE_GATE_UNSTABLE` termination until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`.
- [ ] Add `test_live_readback_reports_active_transition_candidates`; run active and no-active clean reconciliation cases, then emit sanitized candidate IDs without changing the clean snapshot exit code. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`.
- [ ] Add `test_live_readback_observe_mode_proves_same_run_transition`; start with one selected candidate non-terminal, advance fake local reads to terminal, and implement bounded read-only observation plus final direct/SQLite status-and-Token comparison until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`.
- [ ] Add `test_live_readback_observe_mode_times_out_honestly`; run still-active, already-terminal-at-start, disappeared, and Token-mismatch cases separately; implement `LIVE_TRANSITION_NOT_OBSERVED` versus reconciliation-mismatch exits until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`.
- [ ] Run the complete fake-backed live-readback selection. Do not execute the real read-only command until reference 11C's scheduler-parked API is running; that later command is its own live evidence step and never starts a Run. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k 'test_live_readback_')`.
- [ ] Add `test_visual_fixture_rejects_unsafe_paths`; run default/ancestor/descendant/non-empty/unmarked cases one at a time and implement only the guard/marker layer until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`.
- [ ] Add `test_visual_fixture_active_state`; implement the twelve-Agent active fixture, three qualifying RUNNING signals across two active owners, a separated unknown owner, and real aggregate/count assertions until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`.
- [ ] Add `test_visual_fixture_idle_state`; implement only the exact-fresh idle database and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_idle_state)`.
- [ ] Add `test_visual_fixture_partial_state`; implement only the multi-Agent partial/lower-bound/unknown-total database and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`.
- [ ] Add `test_visual_fixture_stale_state`; implement only expired/static cached state and rerun to green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_stale_state)`.
- [ ] Add `test_visual_fixture_refreshes_only_marked_scenarios`; refresh active, idle, and partial marked databases separately, prove their real aggregate remains respectively multi-owner active, exact-fresh idle, and partial, then prove stale/unmarked/default databases are rejected; implement real production-duration windows without contacting Core AI until green. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`.
- [ ] Run all fixture/acceptance tests and generate the four disposable databases from reference 11D. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q) && AW_PREVIEW_DIR="$(mktemp -d)" && export AW_PREVIEW_DIR && (cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --output-dir "$AW_PREVIEW_DIR") && printf '%s\n' "$AW_PREVIEW_DIR"`.
- [ ] Add `test_privacy_inventory_allows_only_parser_discard_literals`; parse `api/schema.sql` plus the production AST for `api/app/agent_workbench.py`, require no exact sensitive persistence identifier and allow the exact strings `input`, `output`, `transcript`, `artifacts`, and `error_stack` only as members of the one parser-local `DISCARDED_UPSTREAM_FIELDS` constant; run the literal command and observe RED for any unclassified occurrence. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)`.
- [ ] Move/remove every unclassified occurrence until the machine-readable privacy allowlist test is green; do not weaken the exact constant/member/location assertions or allow persisted/logged full-content fields. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)`.
- [ ] Complete the automated release and static-boundary commands before opening visual preview.
- [ ] Inspect active at 1180 CSS px and record the scoped motion/color/count result. Manual evidence step; no test command.
- [ ] Inspect active at 1440 CSS px and record the scoped motion/color/count result. Manual evidence step; no test command.
- [ ] Inspect active at 1920 CSS px and record the scoped motion/color/count result. Manual evidence step; no test command.
- [ ] Set 200% zoom before a hard reload/direct `/agents` navigation on active, then record loading-to-snapshot, no Workbench page-level overflow, table/drawer reflow, and keyboard focus. Manual evidence step; no test command.
- [ ] Inspect idle at 1180 CSS px and record exact-idle plus 30-second no-overlap evidence. Manual evidence step; no test command.
- [ ] Inspect idle at 1440 CSS px and record exact-idle plus 30-second no-overlap evidence. Manual evidence step; no test command.
- [ ] Inspect idle at 1920 CSS px and record exact-idle plus 30-second no-overlap evidence. Manual evidence step; no test command.
- [ ] Hard reload/direct-navigate idle at 200% zoom under the same new-page protocol and record reflow/focus evidence. Manual evidence step; no test command.
- [ ] Inspect partial at 1180 CSS px and record qualified counts/static signals/no-idle evidence. Manual evidence step; no test command.
- [ ] Inspect partial at 1440 CSS px and record qualified counts/static signals/no-idle evidence. Manual evidence step; no test command.
- [ ] Inspect partial at 1920 CSS px and record qualified counts/static signals/no-idle evidence. Manual evidence step; no test command.
- [ ] Hard reload/direct-navigate partial at 200% zoom under the same new-page protocol and record reflow/long-name evidence. Manual evidence step; no test command.
- [ ] Inspect stale at 1180 CSS px and record expired-motion/current-copy downgrade. Manual evidence step; no test command.
- [ ] Inspect stale at 1440 CSS px and record expired-motion/current-copy downgrade. Manual evidence step; no test command.
- [ ] Inspect stale at 1920 CSS px and record expired-motion/current-copy downgrade. Manual evidence step; no test command.
- [ ] Hard reload/direct-navigate stale at 200% zoom under the same new-page protocol and record reflow/fallback evidence. Manual evidence step; no test command.
- [ ] Inspect paused presentation at 1180 CSS px and record zero implicit reads/frozen clock behavior. Manual evidence step; no test command.
- [ ] Inspect paused presentation at 1440 CSS px and record pending-range/manual-read behavior. Manual evidence step; no test command.
- [ ] Inspect paused presentation at 1920 CSS px and record receipt/focus freeze behavior. Manual evidence step; no test command.
- [ ] Hard reload/direct-navigate a stored-paused presentation at 200% zoom under the same new-page protocol and record zero initial GET plus controls/drawer reflow. Manual evidence step; no test command.
- [ ] In the real browser open every drawer mode, Tab/Shift+Tab across both ends, and prove `document.activeElement` never enters the inert `#root` or reaches sidebar/header/logout until close; then verify Escape/opener restoration, Run tabs/history/copy links, reduced motion, and forced colors as separate interactions. Retain screenshots/Network timestamps outside the source tree. Manual evidence step; no test command.
- [ ] Rerun every automated acceptance gate and perform the final narrow test-support commit by executing the complete fail-fast block under **Final Task 11 checkpoint** below.

**Contract reference 11A: Running-to-terminal truth path**

Use a temporary SQLite database, logged-in TestClient, dependency-injected list-only Core AI fake, and a controllable aware clock. Monkeypatch both lifespan loops to parked cancellation-aware coroutines so the test drives `sync_registered_agent_runs_once` explicitly and cannot race a background tick. Execute this exact sequence:

1. Register an Agent and reread its persisted active/sync_pending row.
2. Establish an exact-idle/history-zero four-list proof, accept a local RUNNING trigger, and reread both SQLite and the aggregate to prove the immediate row is static/uncertain with `trigger_type=NULL`, current quality unknown, no exact-idle claim, effective remote total NULL, and no `1/0` coverage.
3. Run a complete four-list proof with that RUNNING Run and its actual `triggered_by` value.
4. Reread seo_ops_agent_runs and GET /api/agent-workbench; assert raw RUNNING, confirmed trigger type, exact current count, fresh_until, five-second recommendation, and live eligibility.
5. Return COMPLETED with a valid recent completed_at and Tokens.
6. Reread the terminal projection; assert immutable terminal_observed_at/receipt_expires_at and known Token totals.
7. Keep its associated source row running and assert archiving; settle that exact source and assert a factual terminal receipt.
8. Repeat discovery and assert receipt expiry does not move.

The fake's get_run method raises AssertionError, proving the entire path stayed on list APIs.

**Contract reference 11B: External discovery and historical honesty**

Start with no local source association. Add a Core AI Run only to the fake, advance to the next 30-second discovery, then GET the aggregate and assert it appears as 未关联商户. Model the documented worst case: an already-open idle browser may require its following 30-second read, so the combined bound is 60 seconds, while direct navigation/focus/manual read sees the current projection immediately.

Seed an old terminal Run with completed_at older than ten seconds and assert discovery mirrors it into history without receipt_expires_at and without any 刚刚 semantic field.

Add one exact mixed-proof sequence: the unfiltered recent page returns 200 of 201 and omits an old RUNNING Run; the `status=RUNNING` page discovers that old Run but returns 1 of 2; `status=PENDING` fails with no prior observation; `status=PAUSED` returns exact zero; and the unfiltered page contains one in-range `AWAITING_REVIEW` row. Assert the old Run is mirrored, running is `lower_bound` with value 1, pending is `unknown` with no last observation, paused is exact zero, the unknown raw row remains a static signal, current proof is incomplete, range metrics are qualified incomplete, and idle is forbidden. Put an otherwise identical unknown row outside the selected range and assert it still blocks current completeness but does not by itself invalidate that range's metrics.

First prove cheap restart persistence with the same temporary database: close the first TestClient and every SQLite connection after a successful projection; then construct a fresh in-process FastAPI application and TestClient with all three background loops parked and Core AI credentials absent. Reread the registry, projection, sync timestamps, history, and aggregate unchanged. This proves durable database readback across fresh application instances and closed connections but is not the server-restart gate. No scheduler/trigger/list call may occur during that readback, and cached state is visible but cannot become freshly animated without a new proof.

Then prove a real server restart in `test_terminal_tokens_survive_real_server_restart`. Create a marked pytest temporary directory outside the configured/default database tree and reserve a loopback port. Launch uvicorn process A from `api/` as `agent_workbench_live_app:restart_probe_app --app-dir tests`, with a test-only `AGENT_WORKBENCH_RESTART_PHASE=write`, the marked temporary SQLite path, the ordinary scheduler, Local Falcon scheduler, and Workbench loop all independently parked, no Core AI credentials, and fixed terminal fixture IDs/status `COMPLETED`/Token pair 7+11/receipt/history values. Its guarded lifespan uses the real schema and projection/aggregate helpers to write and commit once before serving; authenticate, read the API plus SQLite, record its PID and canonical durable-subset hashes, send SIGINT, wait for exit code zero, and verify the PID is gone. Launch a distinct uvicorn process B on the same loopback port/database with phase `read`; this phase is strictly read-only, all three loops remain parked, Core AI stays unavailable, and no fixture insert/update is allowed. On its first authenticated API/history read plus SQLite read-only query, require the identical Agent ID, Run ID, terminal status, input/output/total Tokens, immutable terminal observation/receipt, and history row. Define the API durable subset as only registry identity/lifecycle plus the history row's Run/Agent IDs, raw terminal status, Token pair/total, terminal_observed_at, receipt_expires_at, and other persisted history fields; its canonical hash must match across A/B. Hash the stable SQLite registry/sync/Run rows separately and require equality. Exclude `snapshot_at`, elapsed/duration-at-read, health/freshness/deadline, recommended cadence, and other request-time derived values from cross-process equality; instead assert they are well-formed and recomputed consistently with each process's own snapshot time. Stop and await B, then write only sanitized distinct PIDs, exit codes, API durable-subset hash, SQLite stable-row hash, and asserted scalar values to `server-restart.json`; no auth value, cookie, credential, body, or stack enters evidence. Any startup timeout, same/dangling PID, non-zero exit, scheduler/trigger/list call, durable-subset mismatch, or malformed request-time field fails the gate. Advance the pure browser presentation clock exactly to fresh_until and receipt_expires_at through the existing frontend tests; the full release gate must include those tests.

**Acceptance integration checkpoint:**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q)
~~~

Expected: PASS because Tasks 1-10 already implement every behavior under test. This is an integration/readback gate, not a new production behavior and therefore is not labelled as a RED step.

Run the OS-process server-restart case once more with durable out-of-tree evidence:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_RESTART_EVIDENCE_DIR="$(mktemp -d)"
export AW_RESTART_EVIDENCE_DIR
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k terminal_tokens_survive_real_server_restart -s)
test -s "$AW_RESTART_EVIDENCE_DIR/server-restart.json"
printf '%s\n' "$AW_RESTART_EVIDENCE_DIR/server-restart.json"
~~~

Expected: PASS; the JSON records two distinct PIDs, both awaited zero exits, identical API durable-subset and SQLite stable-row hashes, valid per-process request-time fields, and the exact terminal/Token scalars without secrets. This is the criterion-6 server-restart evidence; the cheaper fresh-TestClient test is not a substitute.

**Failure-routing rule:**

If the Acceptance integration checkpoint fails, stop the release sequence, identify the first mismatching contract and owning Task 1-10, add one focused regression assertion to that task's existing test file, make the smallest production correction allowed by that task, run that focused test to green, and then rerun the acceptance checkpoint. Do not add a new endpoint, Core AI detail call, optimistic browser state, or undocumented status inference from the acceptance layer.

- [ ] **Automated release checkpoint: Run all gates**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests -v)
(cd web && npm test)
(cd web && npm run lint)
(cd web && npm run build)
~~~

Expected: every command exits zero. A build alone is not acceptance.

- [ ] **Static-boundary checkpoint: Run exact searches**

Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if rg -n "get_run\(" api/app/agent_workbench.py; then
  echo "Forbidden Workbench single-Run detail call found" >&2
  exit 1
fi
if rg -n "DELETE.*/api/agent-workbench|@router.delete" api/app/agent_workbench.py web/src; then
  echo "Forbidden Agent hard-delete route found" >&2
  exit 1
fi
git diff --check
~~~

Run the raw privacy inventory only as diagnostic context, then require the machine-readable allowlist test to pass before proceeding:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
rg -n '(^|[^[:alnum:]_])(input|output|transcript|artifacts|error_stack)([^[:alnum:]_]|$)' api/schema.sql api/app/agent_workbench.py || true
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)
~~~

Expected:

- the two guarded searches exit zero only when there is no get_run match in Workbench production and no Agent hard-delete route;
- the AST/schema allowlist test classifies every raw inventory match and exits non-zero for anything outside the single parser-local discard constant; `input_tokens`/`output_tokens` do not match the exact-word inventory and remain the only allowed persisted Token fields;
- no whitespace errors.

**Implementation and execution reference 11C: Read back configured Core AI without starting a Run**

Implement `api/tests/agent_workbench_live_app.py` as an acceptance-only module, never a production configuration switch. Its exported `app` must call Task 7's real `create_app(create_lifespan(initialize_writable_application, ...))`, inject distinct cancellation-aware parked coroutines in place of `scheduler_loop` and `fbr_scheduler_loop`, and inject the real `agent_workbench_sync_loop`; therefore startup still initializes/seeds/primes the real database and the Workbench proof worker actually runs, while automatic SEO scans, Local Falcon scheduling, and every scheduler-originated trigger are impossible. Its test injects event recorders, asserts full production route/auth parity, zero calls to either ordinary scheduler and all trigger clients, one Workbench-loop start, and cancellation/awaited finalization for all three tasks—even when one parked finalizer raises.

The separate `restart_probe_app` is guarded to a marker-owned pytest temporary database and chooses its callables only inside this test module. Write phase uses a guarded startup that calls the real writable initializer and inserts only the fixed terminal fixture, followed by three parked loops. Read phase uses a no-write startup that opens the existing database in SQLite URI `mode=ro`, validates the required schema/fixture, and closes; it never calls `init_db`, seed, prime, or a write helper. Build the same real app/router, override `get_db` with a request-owned `mode=ro`/`PRAGMA query_only=ON` connection, install a SQLite authorizer/test write hook that rejects INSERT/UPDATE/DELETE/DDL/ATTACH/writable PRAGMA, and use three independently instrumented parked loops. Assert module import/app construction is I/O-free, process-B connection `total_changes` stays zero, every attempted write would fail, and the database plus sidecar-file hashes/set are identical before/after B. Neither phase adds a route. Never run the live gate against normal `app.main:app`.

Implement `api/tests/agent_workbench_live_readback.py` as a read-only CLI with required arguments `--env-file`, `--api-url`, `--range`, and optional `--strict`, `--observe-run-id`, and `--observe-seconds`. `--observe-run-id` and `--observe-seconds` must appear together; bound the sanitized non-empty ID to 200 characters and observation duration to 1..3600 seconds. Load the named env file without logging values. Before reading the local auth secret or constructing a cookie, parse `--api-url` and accept only `http://127.0.0.1:<explicit-port>` or `http://localhost:<explicit-port>` with no userinfo, path, query, or fragment; reject every other target. Use an HTTP client with `follow_redirects=False` and fail any 3xx response without following it. Only after that validation may the CLI create an operator session cookie from the configured local auth secret, GET the running app's aggregate, open SQLite read-only, and call only Core AI `get_agent()` plus bounded unfiltered/PENDING/RUNNING/PAUSED list GETs. The report contains IDs, statuses, counts, timestamps, and Token sums only; it must never serialize credentials, input, output, errors, stacks, artifacts, response bodies, or the session cookie. Before any stderr/JSON/exception boundary, map transport, HTTP, malformed, and unexpected failures directly to a stable code plus fixed generic message. Never inspect or sanitize-forward `CoreAiError.args`, an arbitrary exception string/message, repr, response body, header, cookie, or nested cause; only Workbench-defined safe contract codes and locally constructed validation messages may be emitted. Suppress raw exception chaining.

Freeze these reconciliation rules and cover them with fakes from `test_agent_workbench_acceptance.py` before the live run:

1. Compare the non-empty IDs from `configured_agent_slots()` with the registry by exact Core AI ID. Configured IDs may be a subset of an arbitrary registry, but `configured_not_registered` must be empty after startup seeding.
2. Compare every registry ID and lifecycle with `aggregate.agents`, including retired rows, as an exact set-and-value match. Inside the short clock-sensitive local bracket defined below, compare every persisted Agent sync/count/quality/error/timestamp value with the same aggregate Agent item; retired rows are never exempt from aggregate/SQLite integrity. Do not reuse those clock fields as the stability marker for the longer direct-Core-AI segments.
3. Form the de-duplicated union of every active registry Core AI ID and every configured Core AI ID. For every ID in that union, perform one direct `get_agent()` plus bounded unfiltered/PENDING/RUNNING/PAUSED read in each reconciliation attempt regardless of persisted next-due timestamps; the CLI is a read-only validation probe, not the background scheduler. Require every direct metadata ID to equal its requested ID. Disabled/retired rows remain aggregate/SQLite checked but receive no direct live read unless also present in the configured-ID union.
4. Merge the unfiltered and three filtered returned rows by Run ID. Before any global-ID lookup, require every returned row's `agent_id` to equal the requested Core AI Agent for that bundle; then require the matching projected row's `seo_ops_agent_id` to equal that bundle's local registry ID. A wrong upstream owner is a structural mismatch and a wrong local projection owner is a reconciliation mismatch, including in truncated/subset branches. A same-cycle status conflict is itself a mismatch for that attempt. Every directly returned Run ID, not merely an overlap found by accident, must exist in `seo_ops_agent_runs`; for each non-conflicting ID compare raw status and a valid nullable Token pair. A missing projected ID is a mismatch even when upstream/projected totals happen to be equal. Independently, any local `raw_status=NULL` marker is an unresolved accepted event and makes the clean live gate fail with `LIVE_GATE_UNCONFIRMED_RUN` until a direct valid page and the persisted projection agree on its exact non-empty status; a truncated page may explain absence but cannot turn that marker into a clean pass. When the unfiltered page is untruncated and local history coverage is complete, require its ID set to equal all projected IDs for that exact Agent. When a filtered status page is untruncated and the matching local set quality is exact at the same proof watermark, require its ID set to equal that Agent projection's proven set for that status. For a truncated page require only same-owner returned-ID subset plus field equality; extra known projected history is not an error. Filtered PENDING/RUNNING/PAUSED IDs participate, not only the recent unfiltered page.
5. Report each direct unfiltered `total`, returned count, raw-status counts, bounded known-Token run count, bounded known input/output/total Tokens, and the projection's recorded remote total. A strict total mismatch fails only after one stable retry; when a page is truncated, label Token comparison `bounded_overlap` and never claim all-history Token equality.
6. Parse the authenticated aggregate's own `snapshot_at`, pass that exact aware instant plus the same range/timezone/history limit into `build_workbench_snapshot` on a read-only SQLite connection, and compare the complete canonical response, including persisted sync timestamps and request-time-derived freshness/elapsed fields. This avoids millisecond drift instead of maintaining an exclusion list. When `range_complete` is true, require the aggregate known Token sums to equal the complete projected range query; otherwise label them projected/incomplete rather than comparing them with a truncated Core AI page.
7. Treat missing configured registration and metadata ID mismatch as structural failures. Do not demand one global stability window across `5 × Agent count` upstream calls. First validate aggregate versus the same-range SQLite-built snapshot in its own short clock-sensitive double-read bracket: hash every local row/value that can affect the Workbench builder (all three Workbench tables plus referenced merchant/source association state), GET the aggregate, build the local snapshot at the aggregate's exact `snapshot_at`, then recompute that full local hash. Discard and retry this short bracket once if the hash changed; otherwise any response/readback difference is a stable mismatch. Next process Agent bundles with at most `MAX_LIVE_READBACK_WORKERS = 8` concurrent workers; calls within one Agent bundle remain serialized. Each bundle reads that Agent's local semantic snapshot and marker, performs metadata plus four direct lists, then rereads only that Agent. This longer-window marker is `(local_event_epoch, projection_revision, canonical projected-run/current-count/registry semantic hash)` and deliberately excludes observation/freshness/due/lease timestamps, so a clock-only 30-second proof may cross the bundle without false instability while any material identity/status/Token/association/quality/error/receipt/coverage/lifecycle change invalidates it. Compare direct data only with the post-read from the same stable segment, record its own observed interval, and never describe per-Agent segments as one simultaneous global upstream snapshot. After all bundles, rerun the short aggregate/SQLite bracket and reread each Agent's semantic marker; retry only a segment whose marker changed or whose first stable comparison mismatched, after one normal 30-second proof interval. Never splice remote data from one segment attempt to local data from another. A clean stable local bracket plus one clean stable segment per Agent succeeds. Repeated identical stable mismatch exits non-zero `LIVE_GATE_MISMATCH`; a changed segment after its sole retry, differing stable mismatch fingerprints, or a local bracket that never stabilizes exits non-zero `LIVE_GATE_UNSTABLE`. Missing credentials/auth, inaccessible Core AI, or no registered Agent exits with `LIVE_GATE_UNAVAILABLE`. Every non-zero outcome prevents a live-acceptance claim.
8. Do not start a Run. A normal clean reconciliation emits `active_transition_candidates` containing sanitized IDs/Agent IDs/raw statuses for any already-authorized PENDING/RUNNING/PAUSED Runs and `transition_observed=not_applicable`; it may exit zero without a transition because this is the spec's read-only snapshot gate. To complete rollout step 5, immediately launch observe mode for one candidate while it is still non-terminal, passing its exact ID plus an operator-chosen bounded duration. Establish that exact Run as non-terminal at observe-mode start, poll only the local aggregate/SQLite snapshot at the server-recommended cadence without overlap, and, when it becomes terminal locally, perform a fresh bracketed direct Agent list bundle and require the same terminal status and valid nullable Token pair in SQLite. Success emits `transition_observed=true`. If the ID was already terminal at observe-mode start, remains active through the bound, disappears outside evidence, or never obtains matching terminal/Token readback, exit non-zero `LIVE_TRANSITION_NOT_OBSERVED` (or the stricter reconciliation mismatch code). This mode carries the candidate ID within one process, so it never infers a transition by comparing unrelated CLI invocations.

Confirm ports 8000 and 5173 are free, then start the scheduler-parked live-gate API and Vite in two terminals with the real local `.env`. Abort on any occupied port; do not accept an auto-selected replacement port or reuse an unidentified existing server:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if lsof -nP -iTCP:8000 -sTCP:LISTEN || lsof -nP -iTCP:5173 -sTCP:LISTEN; then
  echo "Required live-gate port is already occupied" >&2
  exit 1
fi
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/uvicorn agent_workbench_live_app:app --app-dir tests --host 127.0.0.1 --port 8000 --env-file .env)
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort)
~~~

Authenticate at `http://127.0.0.1:5173/agents`, do not use any management or trigger control, wait for the first Workbench proof cycle to settle, and inspect the aggregate Network response. Then run the tested readback in a third terminal; stdout is one canonical sanitized JSON object and stderr is code-only diagnostics:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_LIVE_EVIDENCE_DIR="$(mktemp -d)"
export AW_LIVE_EVIDENCE_DIR
(cd api && .venv/bin/python tests/agent_workbench_live_readback.py \
  --env-file .env \
  --api-url http://127.0.0.1:8000 \
  --range 30d \
  --strict) | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"
~~~

The CLI performs one short local aggregate bracket and one independently bracketed bundle per Agent, with at most one retry for each unstable/mismatching segment after the normal 30-second proof interval. It never combines direct remote data from one segment attempt with SQLite state from another or calls the staggered results one global instantaneous snapshot. Require exit zero for a clean local bracket plus clean stable Agent segments and retain the sanitized JSON with per-segment observation intervals as external evidence. Record `LIVE_GATE_UNAVAILABLE`, `LIVE_GATE_MISMATCH`, or `LIVE_GATE_UNSTABLE` exactly for non-zero reconciliation outcomes.

Select the first already-active candidate from that exact report without triggering anything. If there is one, immediately observe the same Run for up to 15 minutes and require terminal/Token readback from the resulting JSON:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_LIVE_EVIDENCE_DIR:-}"
AW_OBSERVE_RUN_ID="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); rows=data.get("active_transition_candidates", []); print(rows[0]["coreai_run_id"] if rows else "")' "$AW_LIVE_EVIDENCE_DIR/snapshot.json")"
if test -n "$AW_OBSERVE_RUN_ID"; then
  set -o pipefail
  (cd api && .venv/bin/python tests/agent_workbench_live_readback.py \
    --env-file .env \
    --api-url http://127.0.0.1:8000 \
    --range 30d \
    --strict \
    --observe-run-id "$AW_OBSERVE_RUN_ID" \
    --observe-seconds 900) | tee "$AW_LIVE_EVIDENCE_DIR/transition.json"
  AW_TRANSITION_OK="$(cd api && .venv/bin/python -c 'import json,sys; print(str(json.load(open(sys.argv[1], encoding="utf-8")).get("transition_observed", False)).lower())' "$AW_LIVE_EVIDENCE_DIR/transition.json")"
  test "$AW_TRANSITION_OK" = "true"
else
  echo "LIVE_TRANSITION_NOT_OBSERVED: no already-active candidate; rerun this read-only gate during authorized work" >&2
fi
~~~

The candidate-present branch must exit zero only with `transition_observed=true` for that same ID. The no-candidate branch is not a snapshot failure, but rollout step 5 remains explicitly `LIVE_TRANSITION_NOT_OBSERVED`; retain `snapshot.json` and rerun during later already-authorized work. An already-terminal/disappeared/timed-out candidate fails observe mode rather than silently choosing another ID. Do not claim full rollout acceptance merely because fake-backed tests or a clean single snapshot pass, and do not trigger an external Run during this check.

**Implementation reference 11D: Guarded disposable visual fixtures**

Implement `api/tests/agent_workbench_visual_fixture.py` with mutually exclusive CLI modes `--output-dir PATH` and `--refresh-scenario PATH`. For generation, `PATH` must already exist, resolve to an empty directory, be neither equal to, an ancestor of, nor a descendant of the configured default database directory, and have no existing `active.db`, `idle.db`, `partial.db`, or `stale.db`; otherwise exit non-zero before writing. Every generated database contains a private `agent_workbench_preview_fixture` marker with its scenario. Refresh accepts only a marked active, idle, or partial database whose filename agrees with its marker; it rejects the default database, stale scenario, mismatched marker/name, and every unmarked database, and never contacts Core AI.

Generation calls the real schema/aggregation helpers and creates exactly four databases named `active.db`, `idle.db`, `partial.db`, and `stale.db`, with timestamps relative to one captured aware UTC instant:

- `active.db`: twelve mixed-lifecycle Agents, a 110-character display name, three RUNNING Runs across two active Agents whose own current proof is fresh/complete, one PENDING, one PAUSED, one unknown-future static signal owned by a different disabled Agent, one local-archiving item, one terminal receipt, and one Agent with incomplete history coverage; tests must assert exact `2 个 Agent · 3 个 Run` inputs, all three RUNNING signals satisfy every `mayAnimateRunning` input, and the separate unknown signal remains static and still forbids any aggregate idle claim;
- `idle.db`: at least one active Agent, exact zero current counts, complete fresh proof, and one last terminal Run;
- `partial.db`: at least one healthy exact fresh Agent plus a second Agent with a lower-bound status page, a third with a failed status page/prior observation, one never-confirmed Agent, and coverage with `remote_total_runs=NULL`; the real aggregate must equal `sync_health='partial'`;
- `stale.db`: expired aggregate/signal boundaries and cached non-terminal rows that must remain visible but static.

`--refresh-scenario active.db` captures a new real UTC instant, refreshes only that marked fixture's proof timestamps, inserts a new uniquely identified preview receipt rather than extending an existing receipt, and sets the fresh RUNNING window to the production 15 seconds and the receipt window to the production 10 seconds. For idle, refresh only the exact-zero discovery/current proof timestamps needed for the production 90-second boundary, preserving all zero counts/qualities/history. For partial, refresh the healthy Agent's proof and the incomplete Agents' attempt/last-valid observation times while preserving every lower-bound/unknown quality, error, Run, and total so the real aggregate remains `sync_health='partial'`. Stale refresh is forbidden so it cannot accidentally become fresh. These modes exist only for just-in-time human inspection without falsifying production durations or semantic state. The preview server runs with lifespan disabled, so it cannot seed or poll. The helper prints only its output paths/refresh timestamp. Add acceptance tests that generate all four in a pytest temporary directory, build each real aggregate, assert its defining conditions, exercise every allowed refresh after advancing beyond 90 seconds, rebuild the aggregates to prove active/idle/partial semantics, and prove the helper refuses the real/default database, stale/mismatched/unmarked databases, and a non-empty output directory.

Generate the fixtures:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_PREVIEW_DIR="$(mktemp -d)"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --output-dir "$AW_PREVIEW_DIR")
printf '%s\n' "$AW_PREVIEW_DIR"
~~~

Keep this fixture-generation shell open as **control terminal C**; it owns `AW_PREVIEW_DIR` and runs every just-in-time refresh. Copy the printed absolute directory once into **preview API terminal B** with `export AW_PREVIEW_DIR='…'`, using the exact printed value, then run `test -d "$AW_PREVIEW_DIR" && test -f "$AW_PREVIEW_DIR/active.db"` there before starting any server. Vite remains in **terminal A**. Never expect a shell variable to cross terminals, and never run a refresh command in terminal B while its foreground uvicorn process owns that terminal.

**Manual acceptance reference 11E: Visual, cadence, and interaction matrix**

After the live readback in reference 11C finishes, stop the scheduler-parked live-gate API in terminal B with Ctrl-C, wait for the shell prompt (the awaited lifespan shutdown), and require port 8000 to be free before preview begins. Keep Vite running in terminal A. In control terminal C, immediately refresh active; in terminal B, export the exact printed absolute `AW_PREVIEW_DIR`, validate it, and then start the preview API:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_DIR:-}"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/active.db")
~~~

For each scenario, stop the preview API in terminal B with Ctrl-C and wait for its prompt before changing databases. Refresh only from control terminal C. Start the next API from terminal B, where the same copied absolute `AW_PREVIEW_DIR` remains exported, with non-secret inert connection values and lifespan disabled, so no startup seed, scheduler, or synchronization worker can rewrite the fixtures:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/active.db"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env --lifespan off
)
~~~

For every active viewport/interaction that must show motion or the short receipt, keep the active preview server open, run the following in the fixture-generation shell, then immediately press `刷新显示`; rerun it to create a new receipt ID if the ten-second window expires:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/active.db")
~~~

After active inspection, stop that preview server. Refresh idle immediately before starting it, and rerun the refresh command plus `刷新显示` immediately before any later idle viewport/new-page check whose 90-second window may have expired:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/idle.db")
~~~

Start the exact idle server:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/idle.db"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env --lifespan off
)
~~~

Stop idle before switching. Refresh partial immediately before starting it, and rerun the refresh command plus `刷新显示` immediately before any later partial viewport/new-page check whose proof window may have expired:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/partial.db")
~~~

Start the exact partial server:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/partial.db"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env --lifespan off
)
~~~

Stop partial. Never refresh stale; the helper must reject that request and its expired/static state is the acceptance subject. Start the exact stale server:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/stale.db"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --env-file .env --lifespan off
)
~~~

In the authenticated `/agents` page, inspect 1180, 1440, and 1920 CSS-pixel widths plus 200% browser zoom. For every 200% row, set zoom first, then hard reload or open a new direct `/agents` navigation; observe first-load/paused hydration through the final snapshot, keyboard focus, page overflow, table reflow, and drawer reflow rather than zooming only an already-mounted page. Verify the complete matrix:

- active: the porcelain/white/navy/orange palette remains intact; bright teal and continuous motion appear only on the three fresh verified RUNNING signals across two owners; headline reads `2 个 Agent · 3 个 Run 进行中` and excludes the receipt/unknown signal, while queued, waiting, archiving, unknown, and terminal states remain textual/static;
- scale: all twelve Agents, the long name, multiple Runs from one Agent, the scrollable chip row/one detail panel, internal table scrolling, and drawer reflow remain usable without a five-card assumption;
- coverage: incomplete known total shows `基于已镜像 N/M 次`; unknown total shows `基于已镜像 N 次 · 上游总数未知`; never-confirmed counts show `当前数量未知 · 尚无成功确认`;
- idle: `当前全部空闲` appears only in the exact fresh fixture and the Network panel shows non-overlapping 30-second browser reads;
- active cadence: the Network panel shows non-overlapping five-second reads scheduled after prior completion;
- partial/stale: cached signals stay visible/static, exact-idle wording is absent, and no old motion returns after focus/visibility until a successful fresh response;
- pause: selecting a new range queues it without a request, `刷新显示` performs one read, clocks/receipt/focus freeze, resume expires old presentation first, and wording uses absolute snapshot time;
- interaction: keyboard-only Run tabs, row expansion, native-browser drawer wrap plus inert-background exclusion, Escape/focus restoration, copy action, local links, focus rings, reduced motion, and forced-colors all follow their frozen contracts; this browser row, not jsdom, is the proof that sidebar/header/logout cannot receive sequential focus while the drawer is open.

Capture Network timestamps and one screenshot for active, idle, paused, partial, and stale states as acceptance evidence outside the source tree unless the project owner explicitly requests committed evidence.

After the last stale/paused/browser row, stop the preview API in terminal B and Vite in terminal A with Ctrl-C, wait for both prompts, then prove no test server remains:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if lsof -nP -iTCP:8000 -sTCP:LISTEN || lsof -nP -iTCP:5173 -sTCP:LISTEN; then
  echo "Agent Workbench acceptance server still running" >&2
  exit 1
fi
~~~

- [ ] **Final Task 11 checkpoint: Re-run every automated/static gate, commit test support, and inspect scope**

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests -v)
(cd web && npm test)
(cd web && npm run lint)
(cd web && npm run build)
if rg -n "get_run\(" api/app/agent_workbench.py; then
  echo "Forbidden Workbench single-Run detail call found" >&2
  exit 1
fi
if rg -n "DELETE.*/api/agent-workbench|@router.delete" api/app/agent_workbench.py web/src; then
  echo "Forbidden Agent hard-delete route found" >&2
  exit 1
fi
git diff --check
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)
git add -- api/tests/test_agent_workbench_acceptance.py api/tests/agent_workbench_live_app.py api/tests/agent_workbench_live_readback.py api/tests/agent_workbench_visual_fixture.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' \
  api/tests/agent_workbench_live_app.py \
  api/tests/agent_workbench_live_readback.py \
  api/tests/agent_workbench_visual_fixture.py \
  api/tests/test_agent_workbench_acceptance.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
git diff --cached
git diff --cached --check
git commit -m "test: prove agent workbench truth path"
git status --short
git log --oneline --decorate -12
~~~

Expected: every API/frontend command passes; guarded forbidden-boundary searches are empty; the exact AST/schema privacy allowlist test passes; the staged-name equality proves exactly four acceptance-support files are committed; only intended Workbench commits are new in the isolated branch; no unrelated concurrent files are staged or lost.

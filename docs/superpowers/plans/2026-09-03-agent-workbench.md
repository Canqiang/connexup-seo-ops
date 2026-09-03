# SEO Ops Agent Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an operator-only Agent 工作台 that truthfully makes all explicitly registered SEO Ops Agents feel active and observable by showing current Run state, execution history, Token coverage, synchronization freshness, and lifecycle management for an arbitrary number of Agents.

**Architecture:** Keep Core AI read-only and project its bounded Agent-run list responses into three durable SQLite tables. A dedicated fenced background loop performs 30-second discovery, 5-second confirmation for fresh queued/running work, and low-frequency archival reconciliation; the browser reads only one coherent local snapshot and follows the server-provided 5/30-second cadence without overlapping requests. The React page separates factual state from visual motion: deep navy is the Execution Signal stage, bright teal is reserved for fresh verified RUNNING only, and every stale, paused, terminal, disabled, retired, or uncertain state is static.

**Tech Stack:** Python 3.13, FastAPI 0.141, Pydantic 2.13, SQLite, httpx 0.28, pytest 9, React 19, TypeScript 6, React Router 7, Vitest 4, Testing Library, scoped CSS.

**Spec:** docs/superpowers/specs/2026-09-03-agent-workbench-design.md

## Global Constraints

- Modify only /Users/xander/git_repo/connexup-seo-ops. Core AI under /Users/xander/git_repo/core-ai is contract evidence only and must remain untouched.
- This plan and its confirmed design spec must already be present in narrow commits before execution. From the owner-approved integrated checkout, set `AW_BASE_COMMIT="$(git rev-parse HEAD)"`, then run both `git cat-file -e "$AW_BASE_COMMIT":docs/superpowers/plans/2026-09-03-agent-workbench.md` and `git cat-file -e "$AW_BASE_COMMIT":docs/superpowers/specs/2026-09-03-agent-workbench-design.md` before creating the worktree. Before Task 1, let the owners of the current Local Falcon, Performance Dashboard, merchant-lifecycle, and task-plan changes commit their intended work. Then create an isolated worktree from that exact integrated commit with superpowers:using-git-worktrees. If either document is absent from that commit or those feature changes are still uncommitted, stop and coordinate; never reset, copy over, format, or stage the dirty checkout wholesale.
- Apply narrow patches to existing high-conflict files. Before every commit inspect git diff --cached --name-only and git diff --cached; stage only the exact paths named by that task.
- Run every command block from the isolated worktree, regardless of the caller's current subdirectory: start with `cd "$(git rev-parse --show-toplevel)"`, use `(cd api && ...)` or `(cd web && ...)` for subproject commands, and return to the worktree root before every Git command. Use only non-interactive `git add --` followed by explicitly named paths; because each task begins from the preceding clean task commit, never use `git add -p`, globs, or `git add .`.
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
- Every command block starts fail-fast: after the root-first `cd`, run `set -e` and `set -o pipefail` before any gate, staging, or commit command. A non-zero command stops the block; never check a box, stage, or commit after a failed command. The only exception is a Task 11 block explicitly marked as diagnostic evidence capture: it may switch to `set +e` only after that standard preamble, must immediately persist the exact component exit codes, classify the checklist item as non-pass without claiming success, and restore `set -e` before continuing readback/finalization. Every RED/GREEN execution checkbox carries a complete copy-pasteable `Exact feedback command` on the same line; the immediately preceding test-writing or production-implementation checkbox is a separate action and contains no embedded execution. Narrative references to a literal command are not placeholders. There are no schematic shell commands or bare `run -k NAME` instructions.
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

- [ ] From the owner-approved integrated checkout, validate that one captured base commit contains both the plan and confirmed spec.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_BASE_COMMIT="$(git rev-parse HEAD)"
git cat-file -e "$AW_BASE_COMMIT":docs/superpowers/plans/2026-09-03-agent-workbench.md
git cat-file -e "$AW_BASE_COMMIT":docs/superpowers/specs/2026-09-03-agent-workbench-design.md
printf '%s\n' "$AW_BASE_COMMIT"
~~~

- [ ] Use `superpowers:using-git-worktrees` to create and enter an isolated checkout from that exact validated base commit. Manual environment step.
- [ ] Confirm the isolated worktree is clean before installing anything.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
~~~

- [ ] Create the ignored Python virtual environment; this feature adds no dependency.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
python3.13 -m venv api/.venv
~~~

- [ ] Install the repository's existing Python requirements into that environment.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
api/.venv/bin/python -m pip install -r api/requirements.txt
~~~

- [ ] Install the exact locked frontend dependency tree:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm ci)
~~~

- [ ] Run the integrated commit's full API baseline; if it is red, preserve the output and coordinate instead of attributing the failure to Workbench code.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests -q)
~~~

- [ ] Run the integrated commit's full frontend test baseline and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test)
~~~

- [ ] Run the integrated commit's frontend lint baseline and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run lint)
~~~

- [ ] Run the integrated commit's production frontend build baseline and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run build)
~~~

- [ ] Confirm baseline tooling left the isolated worktree clean; `.venv` and `node_modules` must remain ignored.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
~~~

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
- Produces: configured_agent_slots(values: Mapping[str, str] | None = None) -> tuple of BootstrapAgentSlot values in the documented deterministic order; omitted `values` reads the process environment for production, while an explicit mapping is exclusive and never falls back to ambient keys.
- Persists: seo_ops_agents, seo_ops_agent_runs, and seo_ops_agent_sync_state.

**Mandatory vertical RED-GREEN order:** Execute these small slices in order; the longer sections below are contract references.

- [ ] Add `test_workbench_connection_repr_redacts_api_key` before the connection value type exists.
- [ ] Run the focused test and observe RED for the missing value type. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_workbench_connection_repr_redacts_api_key)`.
- [ ] Add only `CoreAiConnectionSettings` with `api_key=field(repr=False)`.
- [ ] Run the focused repr test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_workbench_connection_repr_redacts_api_key)`.
- [ ] Add `test_workbench_connection_does_not_require_primary_agent`.
- [ ] Run the focused factory test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_workbench_connection_does_not_require_primary_agent)`.
- [ ] Implement only `coreai_connection_settings` without changing `coreai_settings`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_workbench_connection_does_not_require_primary_agent)`.
- [ ] Run the complete config file and prove existing `coreai_settings` behavior is unchanged. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q)`.
- [ ] Add the default timezone/history row to `test_agent_workbench_settings_defaults_and_bounds`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only the default Workbench settings.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add the valid custom-IANA-timezone row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only configured IANA-timezone parsing.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add the invalid-IANA-timezone row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only invalid-IANA-timezone rejection.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add the rejected non-integer history-limit row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only strict integer parsing for the configured history limit.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add the accepted lower boundary `1` and rejected below-minimum value `0` to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only the lower history-limit bound.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add the accepted upper boundary `1000` and rejected above-maximum value `1001` to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Implement only the upper history-limit bound.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_agent_workbench_settings_defaults_and_bounds)`.
- [ ] Add `test_configured_agent_slots_exact_order`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_exact_order)`.
- [ ] Implement only the six deterministic slot descriptors.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_exact_order)`.
- [ ] Add `test_configured_agent_slots_explicit_mapping_never_falls_back_to_environment`, supplying one ID in the explicit mapping and different non-empty ambient IDs for all other slots.
- [ ] Run the focused mapping test and observe RED because the explicit-mapping interface does not yet exist. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_explicit_mapping_never_falls_back_to_environment)`.
- [ ] Add only the optional explicit-mapping branch to `configured_agent_slots`; retain the existing process-environment behavior when the argument is omitted.
- [ ] Run the focused mapping test and require only the explicitly supplied ID. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_config.py -q -k test_configured_agent_slots_explicit_mapping_never_falls_back_to_environment)`.
- [ ] Add `test_agent_workbench_schema_smoke_on_fresh_database` with only table-name, exact named-index, and logical-primary-key smoke assertions.
- [ ] Run the focused smoke test and observe RED for the missing tables. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the `seo_ops_agents` table skeleton with its frozen columns/defaults but without named indexes, the non-NULL logical-identity guard, or CHECKs.
- [ ] Run the focused smoke test and observe the remaining missing-table RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the `seo_ops_agent_runs` table skeleton with its frozen columns/defaults/foreign keys but without named indexes, the non-NULL logical-identity guard, or CHECKs.
- [ ] Run the focused smoke test and observe the remaining missing-sync-table RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the `seo_ops_agent_sync_state` table skeleton with its frozen columns/defaults/foreign key except the deliberately deferred `history_event_epoch`, `unfiltered_proven_event_epoch`, and `finite_range_proven_start_at` fields/defaults; omit named indexes, the non-NULL logical-identity guard, and CHECKs.
- [ ] Run the focused smoke test and observe the remaining missing-index RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only `ux_seo_ops_agents_current_key`, `idx_seo_ops_agents_next_verification_at`, and `idx_seo_ops_agents_metadata_lease_until`.
- [ ] Run the focused smoke test and observe the remaining missing-index RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only `idx_seo_ops_agent_runs_agent_effective_history`, `idx_seo_ops_agent_runs_raw_status`, and `idx_seo_ops_agent_runs_source`.
- [ ] Run the focused smoke test and observe the remaining missing-index RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only `idx_seo_ops_agent_sync_next_discovery_at`, `idx_seo_ops_agent_sync_next_fast_poll_at`, and `idx_seo_ops_agent_sync_lease_until`.
- [ ] Run the focused smoke test and observe the remaining legacy-link-index RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only `idx_runs_coreai_run_id` and `idx_task_executions_coreai_run_id`.
- [ ] Run the focused smoke test and observe the remaining logical-primary-key RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the non-NULL guard to `seo_ops_agents.id`.
- [ ] Run the focused smoke test and observe the remaining Run-primary-key RED failure; the test checks logical keys in Agent, Run, sync-state order. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the non-NULL guard to `seo_ops_agent_runs.coreai_run_id`.
- [ ] Run the focused smoke test and observe the remaining sync-state-primary-key RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add only the non-NULL guard to `seo_ops_agent_sync_state.seo_ops_agent_id`.
- [ ] Run the focused smoke test and require PASS, including first and repeated NULL-insert rejection for each logical primary key; this smoke pass does not yet claim the full column/CHECK contract. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_smoke_on_fresh_database)`.
- [ ] Add blank/overlength `agent_key` rows to `test_agent_registry_text_and_lifecycle_checks`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add only the `agent_key` text CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add blank/overlength `display_name` rows to the same registry test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add only the `display_name` text CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add blank/overlength `role` rows to the same registry test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add only the `role` text CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add invalid lifecycle-status rows to the same registry test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add only the lifecycle-status enum CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add retired-status/timestamp parity rows to the same registry test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add only the retired-at lifecycle parity CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_text_and_lifecycle_checks)`.
- [ ] Add fractional and out-of-range `sort_order` rows to `test_agent_registry_numeric_checks`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add only the bounded-integer `sort_order` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add fractional and out-of-range `suspect_after_seconds` rows to the same numeric test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add only the bounded-integer `suspect_after_seconds` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add nullable, fractional, zero, and positive timeout-hint rows to the same numeric test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add only the nullable positive-integer timeout-hint CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_registry_numeric_checks)`.
- [ ] Add invalid source-kind rows to `test_agent_run_source_and_time_checks`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add only the source-kind enum CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add fractional and non-positive source-ID rows to the same Run test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add only the positive integral source-ID CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add source-kind/source-ID null-pair rows to the same Run test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add only the source-kind/source-ID null-parity CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add aware-UTC and malformed `first_seen_at` rows to the same Run test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add only the SQLite-parseable required `first_seen_at` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_source_and_time_checks)`.
- [ ] Add the partial-pair rows to `test_agent_run_token_checks_reject_partial_fractional_and_negative`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the Token null-parity CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add fractional Token rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the Token `typeof(...)=integer` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add negative Token rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add only the non-negative Token CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_run_token_checks_reject_partial_fractional_and_negative)`.
- [ ] Add the valid source-bound NULL-status row and blank-status rejection to `test_statusless_accepted_marker_is_nullable_but_narrow`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Implement only the NULL-or-trimmed-nonempty `raw_status` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add the table-driven prohibited-upstream-column rows—including `started_at`—to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add only the single NULL-status upstream-field absence CHECK, leaving warning-code ownership to Task 7.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_statusless_accepted_marker_is_nullable_but_narrow)`.
- [ ] Add a fractional Agent `verification_failure_count` row to `test_sync_integer_boolean_and_quality_checks`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECK for `verification_failure_count`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a fractional Agent `metadata_lease_epoch` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECK for `metadata_lease_epoch`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional sync-state `remote_total_runs` and `last_discovery_returned_count` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the unfiltered total/returned-count pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional `pending_observed_count` and `pending_upstream_total` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the PENDING observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional `running_observed_count` and `running_upstream_total` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the RUNNING observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional `paused_observed_count` and `paused_upstream_total` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the PAUSED observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a fractional `unresolved_unknown_status_count` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECK for `unresolved_unknown_status_count`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional `local_event_epoch` and `projection_revision` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the local-event/revision pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add fractional `discovery_failure_count` and `fast_poll_failure_count` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECKs for the discovery/fast failure-count pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a fractional `lease_epoch` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the integer-type CHECK for `lease_epoch`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a negative `verification_failure_count` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECK for `verification_failure_count`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a negative `metadata_lease_epoch` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECK for `metadata_lease_epoch`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative unfiltered total/returned-count rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the unfiltered total/returned-count pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative PENDING observed/total rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the PENDING observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative RUNNING observed/total rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the RUNNING observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative PAUSED observed/total rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the PAUSED observed/total pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a negative `unresolved_unknown_status_count` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECK for `unresolved_unknown_status_count`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative `local_event_epoch` and `projection_revision` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the local-event/revision pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add negative discovery/fast failure-count rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECKs for the discovery/fast failure-count pair.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add a negative `lease_epoch` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the non-negative CHECK for `lease_epoch`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add non-integral and out-of-domain `current_state_complete` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the required integral 0/1 `current_state_complete` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add non-integral and out-of-domain `sync_pending` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the required integral 0/1 `sync_pending` CHECK.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add invalid `pending_set_quality` enum rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the exact/lower_bound/unknown CHECK for `pending_set_quality`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add invalid `running_set_quality` enum rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the exact/lower_bound/unknown CHECK for `running_set_quality`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add invalid `paused_set_quality` enum rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add only the exact/lower_bound/unknown CHECK for `paused_set_quality`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_sync_integer_boolean_and_quality_checks)`.
- [ ] Add the default epoch row to `test_history_event_epoch_constraints`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add only the `(history_event_epoch=0, unfiltered_proven_event_epoch=NULL)` defaults.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add fractional epoch rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add only the integer-type epoch CHECKs.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add negative epoch rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add only the non-negative epoch CHECKs.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add future-proven and equal-proven rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Enforce proven epoch at or behind history epoch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_history_event_epoch_constraints)`.
- [ ] Add the default-NULL and aware-UTC acceptance rows to `test_finite_range_proof_marker_constraints`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_finite_range_proof_marker_constraints)`.
- [ ] Add only the nullable `finite_range_proven_start_at` column.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_finite_range_proof_marker_constraints)`.
- [ ] Add the malformed non-NULL timestamp rejection row to `test_finite_range_proof_marker_constraints`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_finite_range_proof_marker_constraints)`.
- [ ] Add only the SQLite-parseable timestamp CHECK for `finite_range_proven_start_at`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_finite_range_proof_marker_constraints)`.
- [ ] **GREEN characterization:** Add `test_agent_workbench_schema_contract_complete` with the exact columns, foreign keys, CHECK SQL fragments, defaults, and named indexes from Contract 1B.
- [ ] Run the final schema-contract test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_contract_complete)`.
- [ ] **GREEN characterization:** Add `test_agent_workbench_schema_repeated_init` for the existing `init_db` executescript path.
- [ ] Run the focused idempotence characterization and require PASS without changing `api/app/db.py`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_agent_workbench_schema_repeated_init)`.
- [ ] **GREEN characterization:** Add `test_pre_workbench_database_migrates_additively` with one byte-for-byte legacy merchant/run/task/artifact readback.
- [ ] Run the additive-schema characterization and require PASS through the existing `_migrate` plus `executescript` order, without changing `api/app/db.py`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_pre_workbench_database_migrates_additively)`.
- [ ] **GREEN characterization:** Add `test_projected_run_survives_merchant_delete` after the projection foreign key already declares `ON DELETE SET NULL`.
- [ ] Run the focused foreign-key characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_db.py -q -k test_projected_run_survives_merchant_delete)`.

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

Use an early smoke test only for the three table names, the exact named indexes, and explicit non-NULL logical primary keys. After every column/default/foreign-key/CHECK slice below is present, add the final full-schema GREEN characterization. The shipped `init_db` already runs `_migrate`, `SCHEMA_PATH` through `executescript`, then `_migrate` again; characterize that unchanged path by calling it twice and by opening a pre-Workbench fixture containing one existing merchant/run/task/artifact row. Prove every legacy row/column remains byte-for-byte readable while the three new tables/indexes are added. Insert a merchant, Agent, sync row, and projected Run; delete the merchant and characterize the declared `ON DELETE SET NULL` behavior: projected `merchant_id` becomes NULL while the Run remains. Do not modify `api/app/db.py` for these schema-only additions.

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
    source_local_id IS NULL OR (
      typeof(source_local_id) = 'integer' AND source_local_id > 0
    )
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

Add one `seo_ops_agent_sync_state` row per registry row with this exact DDL:

~~~sql
CREATE TABLE IF NOT EXISTS seo_ops_agent_sync_state (
  seo_ops_agent_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_ops_agents(id),
  remote_total_runs INTEGER CHECK (
    remote_total_runs IS NULL OR (typeof(remote_total_runs) = 'integer' AND remote_total_runs >= 0)
  ),
  last_discovery_attempt_at TEXT,
  last_discovery_success_at TEXT,
  last_discovery_error TEXT,
  last_discovery_returned_count INTEGER CHECK (
    last_discovery_returned_count IS NULL OR (
      typeof(last_discovery_returned_count) = 'integer' AND last_discovery_returned_count >= 0
    )
  ),
  coverage_start_at TEXT,
  finite_range_proven_start_at TEXT CHECK (
    finite_range_proven_start_at IS NULL OR datetime(finite_range_proven_start_at) IS NOT NULL
  ),
  current_state_checked_at TEXT,
  pending_observed_count INTEGER CHECK (
    pending_observed_count IS NULL OR (typeof(pending_observed_count) = 'integer' AND pending_observed_count >= 0)
  ),
  pending_upstream_total INTEGER CHECK (
    pending_upstream_total IS NULL OR (typeof(pending_upstream_total) = 'integer' AND pending_upstream_total >= 0)
  ),
  pending_last_observed_at TEXT,
  pending_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (pending_set_quality IN ('exact', 'lower_bound', 'unknown')),
  running_observed_count INTEGER CHECK (
    running_observed_count IS NULL OR (typeof(running_observed_count) = 'integer' AND running_observed_count >= 0)
  ),
  running_upstream_total INTEGER CHECK (
    running_upstream_total IS NULL OR (typeof(running_upstream_total) = 'integer' AND running_upstream_total >= 0)
  ),
  running_last_observed_at TEXT,
  running_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (running_set_quality IN ('exact', 'lower_bound', 'unknown')),
  paused_observed_count INTEGER CHECK (
    paused_observed_count IS NULL OR (typeof(paused_observed_count) = 'integer' AND paused_observed_count >= 0)
  ),
  paused_upstream_total INTEGER CHECK (
    paused_upstream_total IS NULL OR (typeof(paused_upstream_total) = 'integer' AND paused_upstream_total >= 0)
  ),
  paused_last_observed_at TEXT,
  paused_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (paused_set_quality IN ('exact', 'lower_bound', 'unknown')),
  unresolved_unknown_status_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(unresolved_unknown_status_count) = 'integer' AND unresolved_unknown_status_count >= 0
  ),
  current_state_complete INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(current_state_complete) = 'integer' AND current_state_complete IN (0, 1)
  ),
  current_state_error TEXT,
  sync_pending INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(sync_pending) = 'integer' AND sync_pending IN (0, 1)
  ),
  local_event_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(local_event_epoch) = 'integer' AND local_event_epoch >= 0
  ),
  history_event_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(history_event_epoch) = 'integer' AND history_event_epoch >= 0
  ),
  unfiltered_proven_event_epoch INTEGER CHECK (
    unfiltered_proven_event_epoch IS NULL OR (
      typeof(unfiltered_proven_event_epoch) = 'integer'
      AND unfiltered_proven_event_epoch >= 0
      AND unfiltered_proven_event_epoch <= history_event_epoch
    )
  ),
  projection_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(projection_revision) = 'integer' AND projection_revision >= 0
  ),
  next_discovery_at TEXT,
  last_fast_poll_attempt_at TEXT,
  last_fast_poll_success_at TEXT,
  last_fast_poll_error TEXT,
  next_fast_poll_at TEXT,
  discovery_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(discovery_failure_count) = 'integer' AND discovery_failure_count >= 0
  ),
  fast_poll_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(fast_poll_failure_count) = 'integer' AND fast_poll_failure_count >= 0
  ),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(lease_epoch) = 'integer' AND lease_epoch >= 0
  ),
  lease_until TEXT
);
~~~

Add every lookup/due index with these exact names and SQL, in the small index-family slices listed in the mandatory order:

~~~sql
CREATE UNIQUE INDEX IF NOT EXISTS ux_seo_ops_agents_current_key
ON seo_ops_agents(agent_key) WHERE status <> 'retired';

CREATE INDEX IF NOT EXISTS idx_seo_ops_agents_next_verification_at
ON seo_ops_agents(next_verification_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agents_metadata_lease_until
ON seo_ops_agents(metadata_lease_until);

CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_agent_effective_history
ON seo_ops_agent_runs(
  seo_ops_agent_id,
  COALESCE(started_at, first_seen_at) DESC,
  coreai_run_id DESC
);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_raw_status
ON seo_ops_agent_runs(raw_status);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_source
ON seo_ops_agent_runs(source_kind, source_local_id);

CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_next_discovery_at
ON seo_ops_agent_sync_state(next_discovery_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_next_fast_poll_at
ON seo_ops_agent_sync_state(next_fast_poll_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_lease_until
ON seo_ops_agent_sync_state(lease_until);

CREATE INDEX IF NOT EXISTS idx_runs_coreai_run_id
ON runs(coreai_run_id) WHERE coreai_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_task_executions_coreai_run_id
ON task_executions(coreai_run_id) WHERE coreai_run_id IS NOT NULL;
~~~

The DDL above is the frozen constraint/index contract. SQLite rowid tables do not make a non-INTEGER `PRIMARY KEY` implicitly reject NULL, so prove both a first and repeated NULL insertion fail for each logical identity. Insert `(NULL, 5)`, `(5, NULL)`, `(-1, 5)`, `(5, -1)`, and `(1.5, 5)` Token pairs and require `sqlite3.IntegrityError`; parameterize `1.5` across every Agent/sync count/total/failure/revision/epoch column and a non-integral boolean and require the same. SQLite CHECK expressions that merely evaluate to NULL are not sufficient. `raw_status=NULL` has exactly one meaning: Core AI accepted that exact Run ID locally, but no valid list row has confirmed its status yet. The schema permits it only with a source association plus `first_seen_at` and no upstream-derived fields; empty strings remain invalid. Separately, Task 7's helper must persist canonical `LOCAL_TRIGGER_STATUS_MISSING` warning JSON and reread it—the generic schema default alone is not treated as proof of that application invariant. This durable marker lives in the same projection table, so a later exact-zero list cannot erase the accepted event or permit a false idle claim. Make `seo_ops_agent_id` immutable in application logic; do not add a cascade that can erase Run history.

**Implementation reference 1C: Settings and schema**

Use zoneinfo.ZoneInfo for validation, return defaults only when variables are absent/blank, and raise ValueError with the exact variable name for invalid configured values. Declare api_key with dataclasses.field(repr=False). Preserve CoreAiSettings and coreai_settings() byte-for-byte in behavior. `configured_agent_slots(values=None)` reads `os.environ` only when `values is None`; an explicitly supplied mapping—including an empty mapping—is the complete source for slot IDs and never falls back to the process environment.

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

- [ ] Add only the documented non-secret Workbench values to `api/.env.example`.

- [ ] Clear `SEO_OPS_OPERATOR_TIMEZONE` and `SEO_OPS_AGENT_HISTORY_LIMIT` in the shared API client fixture.

- [ ] Run the complete Task 1 config/schema test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py -q)
~~~

- [ ] Stage exactly the six Task 1 files and assert the sorted staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/config.py api/.env.example api/schema.sql api/tests/conftest.py api/tests/test_config.py api/tests/test_db.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/.env.example api/app/config.py api/schema.sql api/tests/conftest.py api/tests/test_config.py api/tests/test_db.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 1 staged patch and require its whitespace check to pass.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 1 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: add agent workbench storage"
~~~

- [ ] Prove the isolated worktree is clean after the Task 1 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Add `test_request_passes_query_params`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k request_passes_query_params)`.
- [ ] Add the optional `_request(..., params=None)` seam without changing existing JSON calls.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)`.
- [ ] Add the quoted path, filtered-status query, and limit assertions to `test_list_agent_runs_uses_real_path_query_and_discards_large_fields`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] Implement only the quoted list path and query-parameter construction.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] **GREEN characterization:** Add the unfiltered-call assertion that omits the `status` query parameter.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] Add the exact returned-field and discarded-large-field assertions to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] Add only the exact `RUN_LIST_FIELDS` tuple.
- [ ] Run the focused test and observe the remaining response-projection RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] Implement only narrow response projection through `RUN_LIST_FIELDS`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_uses_real_path_query_and_discards_large_fields)`.
- [ ] **GREEN characterization:** Add `test_list_agent_runs_preserves_zero_token_pair` after the preceding adapter slice is green.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_preserves_zero_token_pair)`.
- [ ] Add the missing/non-list `runs` rows to `test_list_agent_runs_rejects_malformed_envelopes`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add only the returned-list guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add the non-object returned-row case to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add only the returned-row object guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add the missing, boolean, negative, and non-integral `total` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add only the integral non-negative `total` guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add the returned-count-greater-than-total row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add only the returned-count consistency guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_list_agent_runs_rejects_malformed_envelopes)`.
- [ ] Add `test_get_agent_id_mismatch_is_typed_contract_error`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_get_agent_id_mismatch_is_typed_contract_error)`.
- [ ] Add only the typed `CoreAiContractError` subclass.
- [ ] Run the focused test and observe the remaining ID-guard RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_get_agent_id_mismatch_is_typed_contract_error)`.
- [ ] Map only the existing Agent-ID mismatch guard to `CoreAiContractError`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)`.
- [ ] Add the missing, null, boolean, integer, and list `run_id` rows to `test_trigger_rejects_invalid_run_identity`, requiring generic `TRIGGER_RUN_ID_INVALID` without echoing values.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Implement only the required string `run_id` boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Add the blank and whitespace-only `run_id` rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Add only the nonblank trigger-ID guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Add the padded valid-ID normalization row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Return only the trimmed valid trigger ID.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_rejects_invalid_run_identity)`.
- [ ] Add the missing/null/blank/non-string rows to `test_trigger_normalizes_optional_status`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Implement only the optional-status-to-`None` branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Add padded RUNNING and padded future-status rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.
- [ ] Implement only non-empty status trimming/preservation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_coreai.py -q -k test_trigger_normalizes_optional_status)`.

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

- [ ] Run the complete Task 2 Core AI adapter test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_coreai.py -q)
~~~

- [ ] Stage exactly the two Task 2 files and assert the sorted staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/coreai.py api/tests/test_coreai.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/coreai.py api/tests/test_coreai.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 2 staged patch and require its whitespace check to pass.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 2 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: list Core AI agent runs"
~~~

- [ ] Prove the isolated worktree is clean after the Task 2 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Create the test-local FastAPI app and dependency-override harness.
- [ ] Add `test_workbench_error_detail_shape` to that harness.
- [ ] Run the focused test and observe the missing-module RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k workbench_error_detail_shape)`.
- [ ] Create `agent_workbench.py` with only the empty Workbench router.
- [ ] Run the focused test and observe the remaining missing-error-envelope RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_error_detail_shape)`.
- [ ] Implement only `WorkbenchError` and its structured error-envelope handling.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_error_detail_shape)`.
- [ ] Add the known request-owned credential sentinel rows to `test_workbench_sanitizer_redacts_credentials`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Implement only exact `sensitive_values` redaction without calling `str` or `repr` on raw objects/bodies.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Add the Bearer, Authorization, and API-key label rows to the same sanitizer test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Implement only labeled-credential redaction.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Add the sensitive URL-query-parameter rows to the same sanitizer test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Implement only sensitive URL-query-value redaction.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Add control-character normalization and 240-code-point truncation rows to the same sanitizer test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Implement only control-character normalization and 240-code-point truncation after redaction.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_sanitizer_redacts_credentials)`.
- [ ] Add `test_seed_new_configured_agent`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_new_configured_agent)`.
- [ ] Implement the one-slot insert and sync-state insert transaction.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_new_configured_agent)`.
- [ ] Add `test_seed_repeat_preserves_operator_fields_and_history`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_repeat_preserves_operator_fields_and_history)`.
- [ ] Implement idempotent preserve-only seeding.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_repeat_preserves_operator_fields_and_history)`.
- [ ] **GREEN characterization:** Add `test_seed_removed_env_keeps_existing_registry_and_history`; after preserve-only idempotent seeding is green, an empty configured-slot list must take the same no-op path and leave the registry/history byte-for-byte unchanged.
- [ ] Run the focused characterization and require PASS without another production edit. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_removed_env_keeps_existing_registry_and_history)`.
- [ ] Add `test_seed_conflict_warnings_are_recomputed`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Implement only first-slot duplicate-ID precedence and `CONFIG_DUPLICATE_AGENT_ID` reporting.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Add the configured role-key conflict and restart recomputation rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Implement only deterministic `CONFIG_ROLE_CONFLICT` recomputation from configuration and registry state.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_seed_conflict_warnings_are_recomputed)`.
- [ ] Add helper-only `test_read_workbench_json_empty_bytes` without mounting a mutation route.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_empty_bytes)`.
- [ ] Add only the empty-byte `REQUEST_BODY_REQUIRED` branch to `read_workbench_json`.
- [ ] Run the helper test and require the exact object-shaped envelope to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_empty_bytes)`.
- [ ] Add helper-only `test_read_workbench_json_malformed_bytes`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_malformed_bytes)`.
- [ ] Add only the malformed-JSON `INVALID_JSON` branch.
- [ ] Run the helper test and require the exact object-shaped envelope to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_malformed_bytes)`.
- [ ] Add helper-only `test_read_workbench_json_requires_object_root` for array and scalar roots.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_requires_object_root)`.
- [ ] Add only the plain-object-root `VALIDATION_ERROR` branch.
- [ ] Run the helper test and require the exact `fields.body` envelope to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_read_workbench_json_requires_object_root)`.
- [ ] Add helper-only `test_require_empty_workbench_body_accepts_zero_bytes`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_require_empty_workbench_body_accepts_zero_bytes)`.
- [ ] Implement only the exact-zero-byte success branch of `require_empty_workbench_body`.
- [ ] Run the helper test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_require_empty_workbench_body_accepts_zero_bytes)`.
- [ ] Add helper-only `test_require_empty_workbench_body_rejects_nonzero_bytes` with whitespace, `{}`, `null`, and arbitrary nonzero rows.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_require_empty_workbench_body_rejects_nonzero_bytes)`.
- [ ] Implement only structured `UNEXPECTED_REQUEST_BODY` rejection for nonzero bytes.
- [ ] Run the helper test and require the exact error detail to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_require_empty_workbench_body_rejects_nonzero_bytes)`.
- [ ] Add helper-only `test_register_dto_missing_required_fields` with one-at-a-time missing-field rows.
- [ ] Run the helper test and observe RED for the missing registration DTO/parser. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_missing_required_fields)`.
- [ ] Define only the strict registration DTO.
- [ ] Run the helper test and observe the remaining validation-envelope RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_missing_required_fields)`.
- [ ] Implement only `parse_workbench_mutation` and its sanitized validation-envelope mapping.
- [ ] Run the helper test and require exact sanitized `VALIDATION_ERROR` fields to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_missing_required_fields)`.
- [ ] **GREEN characterization:** Add helper-only `test_register_dto_wrong_types` with one wrong scalar type per field family.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_wrong_types)`.
- [ ] Add helper-only `test_register_dto_rejects_extra_fields`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_rejects_extra_fields)`.
- [ ] Add only `extra='forbid'` to the registration DTO.
- [ ] Run the helper test and require the exact sanitized field error to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_rejects_extra_fields)`.
- [ ] **GREEN characterization:** Add helper-only `test_register_dto_integer_fields_reject_coercion` for string, integral-float, and boolean values across both integer fields.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_dto_integer_fields_reject_coercion)`.
- [ ] Add helper-only `test_edit_dto_rejects_wrong_types`.
- [ ] Run the helper test and observe RED for the missing edit DTO. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_wrong_types)`.
- [ ] Define only the strict edit DTO fields.
- [ ] Run the helper test and require exact sanitized `VALIDATION_ERROR` fields to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_wrong_types)`.
- [ ] Add helper-only `test_edit_dto_rejects_empty_patch` with `{}`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_empty_patch)`.
- [ ] Add only the at-least-one-field root guard.
- [ ] Run the helper test and require the exact `fields.body` envelope to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_empty_patch)`.
- [ ] Add helper-only `test_edit_dto_rejects_extra_fields`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_extra_fields)`.
- [ ] Add only `extra='forbid'` to the edit DTO.
- [ ] Run the helper test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_extra_fields)`.
- [ ] Add helper-only `test_edit_dto_rejects_explicit_null` with one-at-a-time rows for `display_name`, `role`, `sort_order`, `suspect_after_seconds`, and `lifecycle_status`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_explicit_null)`.
- [ ] Implement only the model-generic absent-versus-explicit-null policy, exercised first by the edit DTO.
- [ ] Run the helper test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_rejects_explicit_null)`.
- [ ] **GREEN characterization:** Add helper-only `test_edit_dto_integer_fields_reject_coercion` with the registration scalar matrix.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_dto_integer_fields_reject_coercion)`.
- [ ] Add helper-only `test_replace_dto_missing_required_field`.
- [ ] Run the helper test and observe RED for the missing replace DTO. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_missing_required_field)`.
- [ ] Define only the strict replace DTO with required `coreai_agent_id`.
- [ ] Run the helper test and require exact sanitized `VALIDATION_ERROR` fields to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_missing_required_field)`.
- [ ] **GREEN characterization:** Add helper-only `test_replace_dto_wrong_types` with one wrong scalar type per field family.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_wrong_types)`.
- [ ] Add helper-only `test_replace_dto_rejects_extra_fields`.
- [ ] Run the helper test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_rejects_extra_fields)`.
- [ ] Add only `extra='forbid'` to the replace DTO.
- [ ] Run the helper test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_rejects_extra_fields)`.
- [ ] **GREEN characterization:** Add helper-only `test_replace_dto_rejects_explicit_null` for every optional presentation field.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_rejects_explicit_null)`.
- [ ] **GREEN characterization:** Add helper-only `test_replace_dto_integer_fields_reject_coercion` with the registration scalar matrix.
- [ ] Run the helper characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_dto_integer_fields_reject_coercion)`.
- [ ] Add `test_register_agent_happy_path`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Add only the POST registration route shell wired through the already-green raw-body and DTO helpers.
- [ ] Run the focused test and observe the remaining metadata-verification RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Implement only successful `verify_agent_metadata` parsing for the frozen metadata contract.
- [ ] Run the focused test and observe the remaining persistence RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Implement only the atomic registration and sync-state insert transaction.
- [ ] Run the focused test and observe the remaining response-shape RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Implement only the frozen successful registration response DTO.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_agent_happy_path)`.
- [ ] Add `test_metadata_name_and_model_are_sanitized_before_storage_and_response` with the active API-key and local-auth sentinels embedded in both upstream text fields.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_name_and_model_are_sanitized_before_storage_and_response)`.
- [ ] Route nonblank metadata `name` and optional `model` through the same `sanitize_operator_text(..., sensitive_values=...)` boundary before constructing `VerifiedAgentMetadata`.
- [ ] Run the focused test and require PASS with both sentinels absent from the dataclass repr, SQLite columns, response JSON, and caplog. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_name_and_model_are_sanitized_before_storage_and_response)`.
- [ ] Add `test_metadata_id_mismatch_is_422`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_id_mismatch_is_422)`.
- [ ] Implement only the typed ID-mismatch mapping without parsing error text.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_id_mismatch_is_422)`.
- [ ] Add `test_metadata_wrong_type_is_422`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_wrong_type_is_422)`.
- [ ] Implement only the exact `AGENT` type guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_wrong_type_is_422)`.
- [ ] Add `test_metadata_unpublished_is_422`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_unpublished_is_422)`.
- [ ] Implement only the exact `PUBLISHED` status guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_unpublished_is_422)`.
- [ ] Add `test_metadata_blank_name_is_422`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_blank_name_is_422)`.
- [ ] Implement only the nonblank-name guard.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_blank_name_is_422)`.
- [ ] Add `test_metadata_missing_credentials_is_fixed_503`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_missing_credentials_is_fixed_503)`.
- [ ] Implement only the fixed missing-credential 503 branch of `get_agent_workbench_coreai`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_missing_credentials_is_fixed_503)`.
- [ ] Add `test_coreai_dependency_closes_client_after_normal_yield`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_coreai_dependency_closes_client_after_normal_yield)`.
- [ ] Implement only request-owned client construction, one generator yield, and normal-completion close.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_coreai_dependency_closes_client_after_normal_yield)`.
- [ ] Add `test_coreai_dependency_closes_client_when_consumer_raises`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_coreai_dependency_closes_client_when_consumer_raises)`.
- [ ] Move the already-present generator yield and close into one `try/finally` without changing client ownership.
- [ ] Run the focused exceptional-close test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_coreai_dependency_closes_client_when_consumer_raises)`.
- [ ] Add `test_metadata_transport_is_fixed_503` with one exception whose text is a unique sentinel.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_transport_is_fixed_503)`.
- [ ] Map transport failure directly to a fixed 503 without inspecting the exception.
- [ ] Run the focused test and require PASS with the sentinel absent from HTTP JSON, SQLite, caplog, and exception repr. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_transport_is_fixed_503)`.
- [ ] Add `test_metadata_http_error_body_is_fixed_503` with separate 500 text and JSON bodies containing unique sentinels.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_http_error_body_is_fixed_503)`.
- [ ] Map HTTP failure without inspecting either body.
- [ ] Run the focused test and require PASS with both sentinels absent from every tested boundary. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_metadata_http_error_body_is_fixed_503)`.
- [ ] **GREEN characterization:** Add `test_register_http_validation_envelopes` with missing-required, wrong-type, and extra-field request rows.
- [ ] Run the focused HTTP characterization and require exact `response.json() == {"detail":{"code":"VALIDATION_ERROR","message":expected_message,"fields":expected_fields}}` for every row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_http_validation_envelopes)`.
- [ ] **GREEN characterization:** Add `test_register_http_transport_envelopes` with zero bytes, malformed JSON, and array/scalar-root request rows.
- [ ] Run the focused HTTP characterization and require exact outer `detail` objects, exact `REQUEST_BODY_REQUIRED`/`INVALID_JSON`/`VALIDATION_ERROR` codes, fixed messages, and exact fields for every row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_register_http_transport_envelopes)`.
- [ ] Add duplicate Core AI ID and duplicate current `agent_key` rows to `test_registration_conflicts_and_field_bounds`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the local uniqueness/lifecycle 409 transaction guards.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add whitespace-only and exact 1–80 trimmed `agent_key` boundary rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the exact trimmed `agent_key` bounds without an undocumented regex.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add whitespace-only and exact trimmed-length boundary rows for `display_name` and `role` to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the documented `display_name` and `role` text bounds.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add below/above `sort_order` boundary rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the `-10000..10000` sort-order bound.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add below/above `suspect_after_seconds` boundary rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Implement only the `60..86400` suspect-threshold bound.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_registration_conflicts_and_field_bounds)`.
- [ ] Add the presentation-edit and immutable-ID rows to `test_update_presentation_and_disable`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Add only the PATCH route shell wired through the already-green raw-body and edit-DTO helpers.
- [ ] Run the focused test and observe the remaining edit-handler RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Implement only immutable-ID presentation edits.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] **GREEN characterization:** Add `test_edit_http_validation_envelopes` with `{}` empty PATCH, wrong-type, and extra-field rows.
- [ ] Run the focused HTTP characterization and require exact outer `detail`, `VALIDATION_ERROR`, fixed message, and per-row fields values. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_http_validation_envelopes)`.
- [ ] **GREEN characterization:** Add `test_edit_http_transport_envelopes` with zero bytes, malformed JSON, and array/scalar-root rows.
- [ ] Run the focused HTTP characterization and require exact outer `detail` objects, exact `REQUEST_BODY_REQUIRED`/`INVALID_JSON`/`VALIDATION_ERROR` codes, fixed messages, and exact fields for every row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_edit_http_transport_envelopes)`.
- [ ] Add the disable-lifecycle cadence row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Implement only the disabled lifecycle cadence.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_update_presentation_and_disable)`.
- [ ] Add `test_reenable_verifies_before_write`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_verifies_before_write)`.
- [ ] Implement only the verified atomic transition and `local_event_epoch` increment without mutating an existing Run or metadata lease.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_verifies_before_write)`.
- [ ] Add `test_reenable_atomically_invalidates_archival_proof` with fresh exact disabled archival proof, a cached RUNNING row, and a re-enable request; assert only the committed database state.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_atomically_invalidates_archival_proof)`.
- [ ] In the re-enable transaction preserve last observations but set all three bucket qualities unknown, `current_state_complete=0`, `sync_pending=1`, and full discovery due now.
- [ ] Run the focused test and require PASS with those invalidations committed atomically and every prior observation preserved; aggregate readback belongs to Task 5. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenable_atomically_invalidates_archival_proof)`.
- [ ] Add the zero-byte success/history-preservation half of `test_retire_is_bodyless_and_irreversible`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Add only the POST retire route shell wired through `require_empty_workbench_body`.
- [ ] Run the focused test and observe the remaining retire-handler RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Implement only retire/history preservation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] **GREEN characterization:** Add whitespace, `{}`, `null`, and other nonzero HTTP-body rows to the same retire test.
- [ ] Run the focused HTTP characterization and require exact structured `UNEXPECTED_REQUEST_BODY` responses. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Add the repeat-retire conflict row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Implement only the irreversible lifecycle conflict.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_retire_is_bodyless_and_irreversible)`.
- [ ] Add `test_replace_is_atomic_and_preserves_old_history`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_is_atomic_and_preserves_old_history)`.
- [ ] Add only the POST replace route shell wired through the already-green raw-body and replace-DTO helpers.
- [ ] Run the focused test and observe the remaining replacement-transaction RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_is_atomic_and_preserves_old_history)`.
- [ ] Implement verify-then-retire/create with one rollback boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_is_atomic_and_preserves_old_history)`.
- [ ] **GREEN characterization:** Add `test_replace_http_validation_envelopes` with missing-required, wrong-type, and extra-field rows.
- [ ] Run the focused HTTP characterization and require exact outer `detail`, `VALIDATION_ERROR`, fixed message, and per-row fields values. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_http_validation_envelopes)`.
- [ ] **GREEN characterization:** Add `test_replace_http_transport_envelopes` with zero bytes, malformed JSON, and array/scalar-root rows.
- [ ] Run the focused HTTP characterization and require exact outer `detail` objects, exact `REQUEST_BODY_REQUIRED`/`INVALID_JSON`/`VALIDATION_ERROR` codes, fixed messages, and exact fields for every row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_replace_http_transport_envelopes)`.

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

Send each body-bearing mutation (register, edit, and replace) an empty body, malformed JSON, a JSON array, a missing required field, a wrong field type, and an extra field. For both integer fields, send `"70"`, `70.0`, and `true` as the otherwise-valid `sort_order`, and `"1800"`, `1800.0`, and `true` as `suspect_after_seconds`, across all three mutation DTOs; every case is 422 rather than Pydantic coercion. For edit and replace, omission means preserve/inherit, while explicit JSON `null` for any optional request field is a 422 `VALIDATION_ERROR`; test every optional field, including edit-only `lifecycle_status`. Assert every response still uses that object-shaped `detail`, with stable codes `REQUEST_BODY_REQUIRED`, `INVALID_JSON`, or `VALIDATION_ERROR`; validation failures put only sanitized field messages in `fields`. Separately prove retire succeeds only with zero request-body bytes and returns structured `UNEXPECTED_REQUEST_BODY` for whitespace, `{}`, `null`, or any other non-zero body. Do not accept FastAPI's default list-shaped Pydantic 422 response on these Workbench mutation routes.

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

An empty PATCH is 422. Every optional field in PATCH and replace is optional-but-non-null: absence means preserve/inherit, while explicit JSON `null` is 422. agent_key and coreai_agent_id are immutable under PATCH. Disabling requires no upstream call, preserves Runs, and makes discovery due at now+15 minutes. Re-enabling first verifies metadata, then in one transaction writes active, increments `local_event_epoch`, preserves prior observed counts/times but sets PENDING/RUNNING/PAUSED qualities to unknown, sets `current_state_complete=0`, writes `sync_pending=1`, and sets next_discovery_at=now without mutating an existing run or metadata lease. Task 3 proves only that atomic database invalidation. Task 5 owns the aggregate readback proving cached rows remain visible but static, no exact count/idle claim appears, and only a complete proof acquired at the new epoch may clear `sync_pending`; lifecycle plus the generation change also prevent already-fetched disabled/current proof from satisfying it. Retire accepts active or disabled with exactly zero request-body bytes, sets retired_at, preserves history, schedules now+24 hours, and cannot be undone; whitespace or any other non-zero retire body is rejected with structured `UNEXPECTED_REQUEST_BODY`. Replace rejects the same Core AI ID and any ID already present, verifies the new ID first, then in one BEGIN IMMEDIATE transaction retires the old row and creates a new row with the same stable role key; omitted presentation fields inherit from the old record, new sync_pending is true, old Runs remain bound to the old local ID, and any constraint failure rolls the whole transaction back.

**Implementation reference 3D: Registry DTOs, errors, verification, and transactions**

Give every register/edit/replace Pydantic model `model_config = ConfigDict(extra='forbid', strict=True)`, plus the exact length/range bounds from the tests; do not use lax `int` coercion or treat booleans as integers. Edit/replace fields are optional-but-non-null: distinguish omission from explicit JSON `null` through `model_fields_set` or a model-level before validator, use omission only for preserve/inherit semantics, and reject explicit null through the same structured `VALIDATION_ERROR` path. Do not annotate a request field as `T | None` merely to model omission. Use UUID strings for local IDs, BEGIN IMMEDIATE for lifecycle races, and one `sanitize_operator_text(value, sensitive_values=())` boundary for every upstream-derived API/database/log message. It must first replace every non-empty known credential value and case-insensitive Bearer credential, Authorization/API-key/token/secret labelled value, and sensitive URL query value (`api_key`, `apikey`, `access_token`, `token`, `key`, `secret`, `authorization`) with `[REDACTED]`; then collapse control characters/whitespace and truncate to 240 Unicode code points. Accept only an explicit string or explicit string `message` member as source text; for another object/response/body emit a fixed generic message and never call repr/str on it. Never include a raw response body, Authorization header, exception cause text, or credential in `WorkbenchError`, persisted error_summary, repr, or logs. Make `WorkbenchError` a thin `HTTPException` subtype whose `detail` is always `{code, message, fields}` and suppress raw exception chaining at the route boundary. Do not bind mutation bodies directly as Pydantic route parameters. Read raw bytes through `read_workbench_json`: empty bytes raise `REQUEST_BODY_REQUIRED`, JSON decode failure raises `INVALID_JSON`, and valid JSON goes through `model_type.model_validate(raw)` in `parse_workbench_mutation`. Catch `ValidationError`, map each location to a stable dot-separated field key (use `body` for a root error), sanitize the message, and raise `VALIDATION_ERROR`. Apply this dependency/helper to POST register, PATCH edit, and POST replace so missing, wrong, extra, and explicit-null data cannot escape as FastAPI's default detail array. Keep POST retire strictly bodyless: `require_empty_workbench_body` accepts only `raw_bytes == b''`; whitespace or any other non-zero bytes raise `UNEXPECTED_REQUEST_BODY`.

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
    safe_name = sanitize_operator_text(name, sensitive_values=sensitive_values)
    if not safe_name:
        raise WorkbenchError(422, "AGENT_NAME_INVALID", "Core AI Agent 名称不可用")
    model = raw.get("model")
    model_hint = (
        sanitize_operator_text(model, sensitive_values=sensitive_values)
        if isinstance(model, str) and model.strip()
        else None
    )
    timeout = raw.get("timeout_seconds")
    timeout_hint = (
        timeout
        if isinstance(timeout, int) and not isinstance(timeout, bool) and timeout > 0
        else None
    )
    return VerifiedAgentMetadata(
        coreai_agent_id=coreai_agent_id,
        name=safe_name,
        model=model_hint,
        timeout_hint_seconds=timeout_hint,
        verified_at=now.astimezone(timezone.utc).isoformat(),
    )
~~~

Metadata verification sanitizes `name` and optional `model` with the same request-owned `sensitive_values` before either value enters `VerifiedAgentMetadata`, SQLite, an API DTO, repr, or logs. It writes only verification columns and its independent 24-hour due time. A success clears last_verification_error/failure count; a failure preserves prior cached metadata and records only a fixed Workbench-owned code/message when operating on an existing row. `CoreAiError.args`, `str(exc)`, response text/JSON, and nested causes are forbidden sources because the current Core AI client can place raw HTTP bodies there. Only a Workbench-defined typed contract code or Task 4's dedicated successfully parsed Run-list `error` field may enter the sanitizer. Synchronous register/replace/re-enable verification must not clear Run-list errors or mutate either the run lease in sync state or the metadata lease columns on an existing row.

get_agent_workbench_coreai reads only coreai_connection_settings(), raises 503 when base URL/key are absent, creates one CoreAiClient for the request, yields it, and closes it in finally. The request entrypoint separately gathers the API key plus currently available local auth password/secret into a short-lived tuple and supplies it to `verify_agent_metadata(..., sensitive_values=...)`; that tuple never enters a DTO, repr, log, exception detail, or database. Do not reuse the existing primary-Agent dependency or introduce a cross-thread global client.

- [ ] Run the complete Task 3 registry API test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

- [ ] Stage exactly the two Task 3 files and assert the sorted staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/agent_workbench.py api/tests/test_agent_workbench.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 3 staged patch and require its whitespace check to pass.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 3 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: manage SEO Ops agents"
~~~

- [ ] Prove the isolated worktree is clean after the Task 3 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
~~~

---

### Task 4: Implement narrow projection, guarded transitions, receipts, and local association

**Files:**
- Modify: api/app/agent_workbench.py
- Modify: api/tests/test_agent_workbench.py

**Interfaces:**
- Produces: ParsedAgentRun and ParsedAgentRunPage.
- Produces: parse_agent_run_page(expected_agent_id: str, page: dict, observed_at: datetime, *, expected_status: str | None = None, sensitive_values: Sequence[str] = ()) -> ParsedAgentRunPage.
- Produces: upsert_projected_run(conn, local_agent_id, run: ParsedAgentRun, observed_at, binding: LocalRunBinding | None = None) -> ProjectionResult; this list-proof API never accepts trigger-response markers.
- Produces: resolve_local_association(conn, coreai_run_id: str) -> LocalAssociationResolution.
- Produces: association_preflight_warnings(conn) -> list[dict].

**Mandatory vertical RED-GREEN order:**

- [ ] Add `test_parser_discard_allowlist_is_exact` before parser constants or narrow parsed types exist; assert the exact constant values, exact composed set, exact parsed field set, and repr absence for each discarded top-level field.
- [ ] Run the focused test and observe RED for the missing parser-owned constants. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discard_allowlist_is_exact)`.
- [ ] Define only `TOKEN_USAGE_INPUT_FIELD = "input"`.
- [ ] Run the focused test and observe the remaining missing-output-constant RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discard_allowlist_is_exact)`.
- [ ] Define only `TOKEN_USAGE_OUTPUT_FIELD = "output"`.
- [ ] Run the focused test and observe the remaining missing-discard-set RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discard_allowlist_is_exact)`.
- [ ] Define only `DISCARDED_UPSTREAM_FIELDS = frozenset({TOKEN_USAGE_INPUT_FIELD, TOKEN_USAGE_OUTPUT_FIELD, "transcript", "artifacts", "error_stack"})`.
- [ ] Run the focused test and observe the remaining missing-narrow-type RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discard_allowlist_is_exact)`.
- [ ] Add `test_parser_discards_large_private_fields` with all five discarded top-level fields present in the raw row.
- [ ] Run the focused test and observe RED for the missing narrow parser projection. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_discards_large_private_fields)`.
- [ ] Add the known-status and exact-trigger preservation rows to `test_parse_known_status_and_narrow_fields`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k parse_known_status_and_narrow_fields)`.
- [ ] Define only the immutable narrow `ParsedAgentRun` dataclass.
- [ ] Run the focused parser tests and observe the remaining missing-page-type RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k 'test_parser_discard_allowlist_is_exact or test_parser_discards_large_private_fields or test_parse_known_status_and_narrow_fields')`.
- [ ] Define only the immutable narrow `ParsedAgentRunPage` dataclass.
- [ ] Run the focused parser tests and observe the remaining parser-function RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k 'test_parser_discard_allowlist_is_exact or test_parser_discards_large_private_fields or test_parse_known_status_and_narrow_fields')`.
- [ ] Implement only explicit allowlisted known-status/trigger projection; use the two Token constants only beneath `token_usage`.
- [ ] Run the three focused parser tests and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k 'test_parser_discard_allowlist_is_exact or test_parser_discards_large_private_fields or test_parse_known_status_and_narrow_fields')`.
- [ ] Add missing/blank Run ID, status, and trigger rows to the same parser test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_known_status_and_narrow_fields)`.
- [ ] Implement only required nonblank Run ID, status, and trigger validation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_known_status_and_narrow_fields)`.
- [ ] Add the Agent-ID ownership mismatch and filtered-status mismatch rows to the same parser test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_known_status_and_narrow_fields)`.
- [ ] Implement only Agent ownership and expected-filter validation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_known_status_and_narrow_fields)`.
- [ ] Add the aware-timestamp normalization row to `test_parse_timestamp_valid_and_missing`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Implement only aware timestamp normalization to UTC.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Add the missing-timestamp row to the same test, asserting factual NULL without an invalid-time warning.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Implement only the missing-timestamp NULL branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_valid_and_missing)`.
- [ ] Add `test_parse_timestamp_rejects_naive`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_naive)`.
- [ ] Add only the naive-time NULL/warning branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_naive)`.
- [ ] Add `test_parse_timestamp_rejects_malformed`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_malformed)`.
- [ ] Add only the malformed-time NULL/warning branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_timestamp_rejects_malformed)`.
- [ ] Add `test_parse_token_pair_accepts_zero`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_accepts_zero)`.
- [ ] Implement only pair-present integral non-negative Token parsing.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_accepts_zero)`.
- [ ] Add `test_parse_token_pair_rejects_partial`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_partial)`.
- [ ] Implement only pair-nullity plus `TOKEN_USAGE_INVALID`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_partial)`.
- [ ] Add the boolean Token rows to `test_parse_token_pair_rejects_invalid_scalars`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Implement the invalid-boolean Token outcome: no coercion, both values NULL, and one canonical warning.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Add the negative Token rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Reject negative Token values, NULL both values, and retain one canonical warning.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Add the fractional and string Token rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Reject fractional/string Token values without coercion, NULL both values, and retain one canonical warning.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parse_token_pair_rejects_invalid_scalars)`.
- [ ] Add the identical-row collapse half of `test_parser_duplicate_rows_are_deterministic`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Implement identical duplicate collapse.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Add the conflicting-row rejection half to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Implement only conflicting duplicate-ID rejection.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_duplicate_rows_are_deterministic)`.
- [ ] Add string-error and explicit string-`message` rows with a request-owned credential sentinel to `test_parser_redacts_upstream_error_secrets`, passing that sentinel only through the parser's keyword-only `sensitive_values` argument.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Route only permitted string/message error sources through `sanitize_operator_text(..., sensitive_values=...)`.
- [ ] Run the focused test and require PASS with the sentinel absent from parsed dataclass repr and captured logs. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] **GREEN characterization:** Add Bearer/Authorization/API-key-label and sensitive-URL-query rows to the same test.
- [ ] Run the focused test and require PASS with no sentinel or raw body at any asserted boundary. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Add non-string error object/body rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Map only unsupported error object/body shapes to the fixed generic operator message without `str` or `repr`.
- [ ] Run the focused test and require PASS with no sentinel or raw body at any asserted boundary. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_parser_redacts_upstream_error_secrets)`.
- [ ] Add `test_projection_new_row_exact_readback` with one parsed Run, one `LocalRunBinding`, the exact `ProjectionResult`, and an exact SQLite row readback.
- [ ] Run the focused test and observe RED for the missing projection/local-input result types. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Define only the `LocalSourceKind` literal alias.
- [ ] Run the focused test and observe the remaining missing-local-input-type RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Define only the immutable `LocalRunBinding` input type.
- [ ] Run the focused test and observe the remaining missing-projection-result RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Define only the `ProjectionDisposition` literal alias.
- [ ] Run the focused test and observe the remaining missing-projection-result RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Define only the immutable `ProjectionResult` type.
- [ ] Run the focused test and observe the remaining new-row insert RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Implement only the new-row insert transaction, including immutable owner/binding and exact `first_seen_at`/`last_synced_at` values.
- [ ] Run the focused test and require the exact result plus SQLite readback to PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_new_row_exact_readback)`.
- [ ] Add `test_projection_same_observation_is_idempotent` with a byte-for-byte row snapshot and unchanged `projection_revision`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_same_observation_is_idempotent)`.
- [ ] Implement only the same-observation no-op branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_same_observation_is_idempotent)`.
- [ ] **GREEN characterization:** Add `test_projection_sanitized_error_sqlite_readback` using the parser credential sentinel and the now-green new-row projection path.
- [ ] Run the focused characterization and require the sentinel absent from SQLite while the sanitized factual summary remains readable. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_sanitized_error_sqlite_readback)`.
- [ ] Add `test_projection_data_warning_readback`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Implement only canonical sorted replacement of recoverable observation-warning JSON.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Add the persistent `TERMINAL_STATUS_CONFLICT` union row to the same warning readback test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Implement only persistent-conflict union without auto-clearing it.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_data_warning_readback)`.
- [ ] Add the legal non-terminal rows to `test_projection_transition_truth_table`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement newer-observation non-terminal transitions inside `BEGIN IMMEDIATE`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add `test_projection_older_observation_cannot_overwrite_or_rewind` with an older response carrying different status, Token pair, trace, error, and timestamps.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_older_observation_cannot_overwrite_or_rewind)`.
- [ ] Implement only the aware `observed_at <= last_synced_at` no-op guard before any payload mutation.
- [ ] Run the focused test and require the entire row tuple plus `last_synced_at` and `projection_revision` to remain unchanged. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_older_observation_cannot_overwrite_or_rewind)`.
- [ ] Add terminal-to-nonterminal regression rows to the same transition test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement only terminal non-regression while preserving the complete first authoritative payload tuple.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add `test_projection_same_terminal_different_payload_keeps_first_authoritative_tuple` with a newer same-status terminal response whose trigger, times, Token pair, trace, and error all differ.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_same_terminal_different_payload_keeps_first_authoritative_tuple)`.
- [ ] Implement only same-terminal tuple immutability while allowing list-confirmation metadata to advance.
- [ ] Run the focused test and require the first authoritative tuple byte-for-byte, with only permitted confirmation metadata advanced. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_same_terminal_different_payload_keeps_first_authoritative_tuple)`.
- [ ] Add different-terminal conflict rows to the same transition test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement only terminal-conflict warning persistence without replacing the authoritative tuple.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add unknown-to-known rows to the same transition test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement only unknown-to-known resolution.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add nonterminal-to-unknown rows to the same transition test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement only unresolved-unknown tracking for a nonterminal predecessor.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add terminal-to-unknown rows to the same transition test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Implement only terminal-to-unknown conflict preservation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_transition_truth_table)`.
- [ ] Add `test_receipt_for_recent_valid_completion` for the zero-second boundary.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] Implement fixed ten-second receipt expiry.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] **GREEN characterization:** Add the exact inclusive ten-second boundary to the same test.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_for_recent_valid_completion)`.
- [ ] Add `test_receipt_rejects_future_or_old_completion` with only the future completion row.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] Reject future completion without moving terminal observation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] **GREEN characterization:** Add the eleven-second-old completion row asserting no receipt.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_rejects_future_or_old_completion)`.
- [ ] Add `test_receipt_missing_completion_requires_recent_known_nonterminal` for a recent known non-terminal predecessor.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] Implement only the recent-known-nonterminal fallback.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] **GREEN characterization:** Add unknown and missing-history predecessor rows asserting no fallback receipt.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_missing_completion_requires_recent_known_nonterminal)`.
- [ ] Add `test_receipt_invalid_time_and_old_backfill_never_enter` for invalid/naive timestamps.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] Apply the no-fallback rule to invalid/naive time.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] **GREEN characterization:** Add the initial old-terminal backfill row asserting no receipt under the same rule.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_invalid_time_and_old_backfill_never_enter)`.
- [ ] Add `test_receipt_and_terminal_observation_are_immutable_on_repeat`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_and_terminal_observation_are_immutable_on_repeat)`.
- [ ] Implement once-only terminal/receipt writes.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_receipt_and_terminal_observation_are_immutable_on_repeat)`.
- [ ] Add the zero-match row to `test_resolve_local_association_zero_one_many`; access the expected immutable `LocalAssociationResolution` type before calling the still-missing resolver so the first failure is deterministic.
- [ ] Run the focused test and observe RED for the missing resolution type. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Define only the immutable `LocalAssociationResolution` type.
- [ ] Run the focused test and observe the remaining missing zero-match resolver RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Implement only the unassociated zero-match result.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add the unique one-match row to the same resolver test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Implement only unique cross-table binding.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add the unbound many-match conflict row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Emit only the deterministic unbound conflict without reassignment.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add the already-bound many-match row to the same resolver test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Preserve only the existing binding when a later resolver pass sees many matches.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_resolve_local_association_zero_one_many)`.
- [ ] Add the server-supplied local-link rows to `test_association_links_and_merchant_delete`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Implement only server-supplied local links, with no browser-side ID reverse mapping.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Add the merchant-delete `SET NULL` link-suppression row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Implement only link suppression after the merchant association becomes NULL.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_links_and_merchant_delete)`.
- [ ] Add `test_association_preflight_warnings`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_preflight_warnings)`.
- [ ] Implement deterministic duplicate reporting.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_association_preflight_warnings)`.

**Contract reference 4A: Parser ownership, time, status, Token, and privacy**

Use table-driven tests for all known statuses:

~~~python
KNOWN_NONTERMINAL = {"PENDING", "RUNNING", "PAUSED"}
KNOWN_TERMINAL = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
~~~

Assert exact preservation of raw_status and triggered_by, Agent-ID ownership, aware timestamp conversion to UTC, missing timestamps as NULL, and sanitized error_summary. Define parser-owned `TOKEN_USAGE_INPUT_FIELD`/`TOKEN_USAGE_OUTPUT_FIELD` string constants and one `DISCARDED_UPSTREAM_FIELDS` composed from those two names plus the exact literals `transcript`, `artifacts`, and `error_stack`; this permits required Token parsing without repeating ambiguous `input`/`output` string literals elsewhere. Use the two Token keys only beneath `token_usage`, use the discard set only at the parser boundary, and never duplicate those five literals in production schema/serialization/logging code. Derive `error_summary` only from an upstream string or an explicit string `message` member and pass it through Task 3's `sanitize_operator_text`. The request/worker that already owns the active Core AI API key, local auth secret, and any other credential passes those exact strings through the parser's keyword-only `sensitive_values` argument; the parser never reads global settings or reconstructs credentials. Any other object, response, or body shape becomes the fixed generic operator message without calling `str`/`repr`. Inject the same sentinel into the raw page and explicit argument, then assert at this stage that it is absent from `ParsedAgentRun`, its repr, SQLite, and captured logs. Task 5 owns the separate aggregate/history serializer privacy readback once those serializers exist. A naive or malformed timestamp becomes NULL with INVALID_STARTED_AT or INVALID_COMPLETED_AT; it is never replaced by observation time. A missing timestamp has no invalid-timestamp warning.

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


LocalSourceKind = Literal["run", "task_execution", "merchant_seo_artifact"]
ProjectionDisposition = Literal[
    "inserted",
    "updated",
    "unchanged",
    "older_ignored",
    "conflict_ignored",
]


@dataclass(frozen=True)
class LocalRunBinding:
    source_kind: LocalSourceKind
    source_local_id: int


@dataclass(frozen=True)
class ProjectionResult:
    coreai_run_id: str
    disposition: ProjectionDisposition
    warning_codes: tuple[str, ...]


@dataclass(frozen=True)
class LocalAssociationResolution:
    binding: LocalRunBinding | None
    merchant_id: int | None
    local_href: str | None
    local_label: str | None
    warning_codes: tuple[str, ...]
~~~

`LocalRunBinding` is the only public local-association input to list-proof projection; callers never pass `merchant_id`, links, labels, or a raw mapping. `LocalAssociationResolution` owns those derived outputs. `upsert_projected_run` accepts only `ParsedAgentRun`, whose status and trigger are non-null because they came from a validated list row. Task 7 exclusively owns the separate accepted-trigger helper and its normalized trigger-result input; that helper writes a source-associated row directly and never constructs a partially-null `ParsedAgentRun` or calls this list-proof API. For a new list projection, set first_seen_at to the local observation time and last_synced_at only for a successfully parsed list response. Return `ProjectionDisposition="inserted"` and reread the exact row inside the transaction. Replaying the same observation returns `"unchanged"` without changing the row or `projection_revision`. For an existing row, compare aware last_synced_at with the response observation before applying data. Store exact raw status; classify only when reading. Enforce terminal guards in Python inside BEGIN IMMEDIATE, not only in UI code.

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

Do not expose a generic UPDATE that can mutate seo_ops_agent_id, source_kind, or source_local_id. Task 7's accepted-trigger helper may fill an empty binding under its own transaction contract but never overwrites an upstream-populated status. Discovery may fill an empty binding only through the zero/one/many resolver above.

`ParsedAgentRun.trigger_type` remains a required non-empty string because it comes only from a validated list row. The persistence column stays nullable: Task 7 consumes Task 2's normalized trigger result through its dedicated helper, stores `trigger_type=NULL`, and waits for the first list proof to fill it. Never infer `MANUAL`, `WORKFLOW`, or another trigger type.

Use last_poll_error only for status-confirmation failure/absence on a row that already has a non-null status; a valid later status confirmation clears it. A NULL-status accepted marker instead carries `LOCAL_TRIGGER_STATUS_MISSING` in canonical `data_warning_codes_json` and cannot carry upstream poll fields while unresolved. Store Token/timestamp parser warnings in the same canonical sorted JSON string, replacing recovered observation warnings on a later valid row. Clear `LOCAL_TRIGGER_STATUS_MISSING` only when a valid page observes that exact ID and supplies the first non-empty status. Union TERMINAL_STATUS_CONFLICT into that JSON as a persistent code and never auto-clear it; the first terminal status remains authoritative and the conflict remains available for operator review. Freshness depends on sync-state and last_poll_error, never on data_warning_codes_json alone; an unresolved NULL status independently forces uncertain/static presentation.

- [ ] Run the complete Task 4 projection/receipt/association test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

- [ ] Stage exactly the two Task 4 files and assert the sorted staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/agent_workbench.py api/tests/test_agent_workbench.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 4 staged patch and require its whitespace check to pass.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 4 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: project agent run summaries"
~~~

- [ ] Prove the isolated worktree is clean after the Task 4 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Add `test_empty_workbench_snapshot_contract` with the frozen clock/no-Agent envelope.
- [ ] Run the focused test and observe the missing-builder RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k empty_workbench_snapshot_contract)`.
- [ ] Create `build_workbench_snapshot` with only range-key validation.
- [ ] Run the focused test and observe the remaining empty-envelope RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_empty_workbench_snapshot_contract)`.
- [ ] Implement only the frozen empty top-level envelope.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_empty_workbench_snapshot_contract)`.
- [ ] Add `test_snapshot_read_transaction_prevents_torn_second_connection_read`; use a WAL-mode temporary database, pause the builder after its Agent read, commit a Run/sync mutation through a second SQLite connection, then resume and assert the pre-mutation snapshot is internally coherent.
- [ ] Run the focused test and observe RED from the torn mixed-generation snapshot. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_read_transaction_prevents_torn_second_connection_read)`.
- [ ] Start one explicit deferred `BEGIN` read-only transaction before the first builder SELECT and close that transaction after every snapshot component has been read.
- [ ] Run the focused second-connection test and require one coherent SQLite snapshot with no builder writes. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_read_transaction_prevents_torn_second_connection_read)`.
- [ ] Add the exact warning shape row to `test_snapshot_warning_association_and_agent_shapes`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the warning serializer.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add the exact local-association shape row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the local-association serializer.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add the exact signal row-shape assertions to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the signal row serializer.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add the exact registry row-shape assertions to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the registry row serializer.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add the exact Agent nullability assertions to the same shape test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Implement only the Agent serializer nullability contract.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_snapshot_warning_association_and_agent_shapes)`.
- [ ] Add the PENDING, RUNNING, and PAUSED rows to `test_status_classifier_truth_table`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Implement only the centralized known-nonterminal classifier branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Add the COMPLETED, FAILED, TIMEOUT, and CANCELLED rows to the same classifier test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Implement only the known-outcome classifier branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Add the exact SKIPPED row to the same classifier test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Implement only the skipped/excluded classifier branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Add the non-empty future-status and NULL accepted/unconfirmed rows to the same classifier test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Implement only the unknown/NULL classifier branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_status_classifier_truth_table)`.
- [ ] Add the Asia/Shanghai `today` boundary row to `test_calendar_range_boundaries`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement only the local-today half-open boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add the Asia/Shanghai preceding-seven-local-dates boundary row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement only the `7d` local-calendar boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add the Asia/Shanghai `30d` boundary row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement only the `30d` local-calendar boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add the unbounded `all` row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement only the unbounded `all` branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add the America/New_York DST-boundary row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Implement only timezone-local midnight conversion across DST.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_calendar_range_boundaries)`.
- [ ] Add Run-count membership rows, including exact SKIPPED exclusion and NULL/unknown inclusion, to `test_range_metric_truth_table`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only selected-range Run-count aggregation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add terminal-denominator and success-membership rows to the same metric test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only selected-range outcome/success aggregation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add the zero-terminal-denominator row to the same metric test, asserting `success_rate=NULL`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only NULL success rate for a zero terminal denominator.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add Token-eligibility, known-pair, and 0/0 population rows to the same metric test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only selected-range Token sums and eligibility populations.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add active/disabled/retired historical inclusion and active-only current-count rows to the same metric test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Implement only lifecycle-aware historical versus current membership.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_range_metric_truth_table)`.
- [ ] Add exact, lower-bound, and unknown per-Agent quality rows to `test_current_count_quality_truth_table`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Implement only per-Agent `CurrentCount` composition with preserved last-observed evidence.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Add two-Agent aggregate quality-precedence rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Implement only aggregate exact/lower-bound/unknown quality composition.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Add the no-active-Agent exact-zero/current-state-null row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Implement only the no-active-Agent `not_configured` count semantics.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Add disabled/retired legacy-nonterminal quality rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Implement only lifecycle-qualified legacy-nonterminal aggregation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_current_count_quality_truth_table)`.
- [ ] Add per-Agent `fresh`, `stale`, and `unavailable` rows to `test_aggregate_health_and_freshness_fields`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only per-Agent freshness composition.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add aggregate `fresh`, `partial`, `stale`, `unavailable`, and `not_configured` rows to the same health test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only aggregate health precedence.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add the top-level `stale` compatibility rows to the same health test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only the `stale` boolean mapping from aggregate health.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add `test_due_discovery_failure_makes_range_metrics_incomplete` with an older valid coverage proof followed by a due-at-snapshot discovery attempt that failed.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_due_discovery_failure_makes_range_metrics_incomplete)`.
- [ ] Implement only the latest-due-discovery-failure barrier for `metrics_complete_for_range`.
- [ ] Run the focused test and observe the remaining Agent-health RED failure while cached metrics remain visible but qualified incomplete. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_due_discovery_failure_makes_range_metrics_incomplete)`.
- [ ] Apply only the due-discovery failure to the owning Agent's health.
- [ ] Run the focused test and observe the remaining aggregate-health RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_due_discovery_failure_makes_range_metrics_incomplete)`.
- [ ] Compose only aggregate health from the newly degraded Agent.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_due_discovery_failure_makes_range_metrics_incomplete)`.
- [ ] Add `test_later_fast_poll_failure_makes_run_and_agent_static_stale` with a successful `last_synced_at` inside 15 seconds and a later failed poll attempt.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_later_fast_poll_failure_makes_run_and_agent_static_stale)`.
- [ ] Implement only later-fast-poll-failure precedence for the cached Run signal's `fresh=false` value.
- [ ] Run the focused test and observe the remaining static-presentation RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_later_fast_poll_failure_makes_run_and_agent_static_stale)`.
- [ ] Apply only static signal presentation after that later failure.
- [ ] Run the focused test and observe the remaining owning-Agent-health RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_later_fast_poll_failure_makes_run_and_agent_static_stale)`.
- [ ] Apply only stale health to the owning Agent.
- [ ] Run the focused test and require PASS with the cached signal still visible. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_later_fast_poll_failure_makes_run_and_agent_static_stale)`.
- [ ] Add conservative last-complete/current-checked watermark rows to the same health test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only the conservative oldest-active-Agent watermarks.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add stable de-duplicated incomplete-status union rows to the same health test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only the PENDING/RUNNING/PAUSED/UNKNOWN incomplete-status union ordering.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add Agent/list/signal deadline rows to the same health test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Implement only earliest-boundary `fresh_until` calculation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_health_and_freshness_fields)`.
- [ ] Add `test_sync_pending_never_reuses_old_complete_proof` with internally inconsistent old exact qualities and active `sync_pending=1`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to the three effective aggregate `CurrentCount` values.
- [ ] Run the focused test and observe the remaining all-idle/Agent/signal RED failure while requiring qualified counts. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to aggregate all-idle eligibility.
- [ ] Run the focused test and observe the remaining Agent/signal RED failure while requiring no idle claim. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to the owning Agent's `current_state_complete`.
- [ ] Run the focused test and observe the remaining Agent-health/signal RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to the owning Agent's health.
- [ ] Run the focused test and observe the remaining signal RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to cached signal freshness.
- [ ] Run the focused test and observe the remaining motion-eligibility RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] Apply `sync_pending` only to cached signal motion eligibility.
- [ ] Run the focused test and require PASS with static cached signals. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_sync_pending_never_reuses_old_complete_proof)`.
- [ ] **GREEN characterization:** Add `test_reenabled_agent_immediate_aggregate_revokes_archival_proof` by invoking Task 3's re-enable mutation and building the immediate aggregate.
- [ ] Run the focused cross-task characterization and require the immediate aggregate static/inexact with no idle claim. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenabled_agent_immediate_aggregate_revokes_archival_proof)`.
- [ ] Add `test_reenabled_agent_aggregate_requires_post_epoch_complete_proof` with one pre-epoch complete proof and one later proof whose epoch matches the incremented `local_event_epoch`.
- [ ] Run the focused test and observe RED for proof restoration. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenabled_agent_aggregate_requires_post_epoch_complete_proof)`.
- [ ] Implement only aggregate proof restoration after the matching post-epoch complete discovery.
- [ ] Run the focused test and require PASS with the pre-epoch proof rejected and the matching post-epoch proof accepted. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_reenabled_agent_aggregate_requires_post_epoch_complete_proof)`.
- [ ] Add the three-Agent mirrored/remote total-sum row to `test_aggregate_coverage_sum_max_min_and_nulls`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only non-null coverage total summation without touching current-count code.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the latest per-Agent coverage-boundary row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only latest-boundary coverage aggregation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the oldest per-Agent discovery-success row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only oldest-success coverage aggregation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the per-Agent missing-total propagation row to the same coverage test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only aggregate `remote_total_runs=NULL` propagation while preserving `mirrored_run_count`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the per-Agent missing-coverage-boundary row to the same coverage test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only aggregate `coverage_start_at=NULL` propagation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the per-Agent missing-discovery-success row to the same coverage test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Implement only aggregate `coverage_as_of=NULL` propagation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_coverage_sum_max_min_and_nulls)`.
- [ ] Add the in-range known-status row with `last_synced_at=NULL` to `test_unconfirmed_local_run_invalidates_effective_history_proof`, asserting mirrored 1, effective total NULL, incomplete all/finite metrics, `LOCAL_RUN_UNCONFIRMED`, and no usable 1/0 ratio.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Derive only the known-status unconfirmed-row barrier from SQLite without erasing persisted last-observed total/coverage.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Add the in-range NULL-status accepted marker to the same test, asserting the same barrier plus `LOCAL_TRIGGER_STATUS_MISSING`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Extend only the unconfirmed-row warning derivation for the NULL-status accepted marker.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_unconfirmed_local_run_invalidates_effective_history_proof)`.
- [ ] Add old NULL-status and known-status unconfirmed rows before/exactly-at `range_start` to `test_out_of_range_global_history_barriers_do_not_poison_finite_range`, keeping global barriers while asserting the two finite qualifiers on both sides.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Separate only unconfirmed-row all-history barriers from finite-range factual membership at the exact boundary.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Add old list-confirmed rows with missing upstream `started_at` before/exactly-at `range_start` to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Apply only the factual effective-start defense-in-depth rule for missing upstream start times.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Add old filtered-only identities before/exactly-at `range_start` to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Apply only persisted `finite_range_proven_start_at` coverage to filtered-only identities without copying the global history boolean.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_out_of_range_global_history_barriers_do_not_poison_finite_range)`.
- [ ] Add the filtered-confirmed local-ID row with inconsistent unfiltered total zero to `test_remote_total_below_mirrored_is_never_usable`, asserting effective total NULL and `REMOTE_TOTAL_BELOW_MIRRORED`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_remote_total_below_mirrored_is_never_usable)`.
- [ ] Implement only the below-mirrored total-consistency barrier without clamping or inventing a total.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_remote_total_below_mirrored_is_never_usable)`.
- [ ] Add the later valid unfiltered 1/1 page to the same test, requiring warning clearance and complete coverage only then.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_remote_total_below_mirrored_is_never_usable)`.
- [ ] Implement only valid unfiltered proof restoration.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k 'test_unconfirmed_local_run_invalidates_effective_history_proof or test_remote_total_below_mirrored_is_never_usable')`.
- [ ] Add `test_effective_start_and_elapsed_seconds_are_snapshot_aligned` with a valid upstream start that wins over `first_seen_at`, a missing/invalid upstream start that falls back to `first_seen_at`, a positive fractional interval that floors to whole seconds, and an effective start 250 milliseconds after `snapshot_at` that clamps to zero; require identical values in signal and history serialization.
- [ ] Run the focused test and observe RED for the missing server-side elapsed calculation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_effective_start_and_elapsed_seconds_are_snapshot_aligned)`.
- [ ] Implement only `elapsed_seconds = max(0, floor((snapshot_at - effective_started_at).total_seconds()))` from aware instants and route both signal/history DTOs through that helper.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_effective_start_and_elapsed_seconds_are_snapshot_aligned)`.
- [ ] Add `test_terminal_duration_seconds_is_factual_and_bounded` with a known terminal Run whose valid completion interval floors from a positive fraction, a terminal Run whose completion precedes its effective start and clamps to zero, and missing/invalid-completion plus non-terminal rows that remain NULL; require the same value in history serialization.
- [ ] Run the focused test and observe RED for the missing duration helper. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_terminal_duration_seconds_is_factual_and_bounded)`.
- [ ] Implement only `duration_seconds = max(0, floor((completed_at - effective_started_at).total_seconds()))` for a known terminal status with a valid aware completion instant; return NULL for every other row.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_terminal_duration_seconds_is_factual_and_bounded)`.
- [ ] Add active PENDING/RUNNING/PAUSED rows to `test_stage_signal_truth_table`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only active known-nonterminal signal membership.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add effective-start/core-ID ordering rows to the same signal test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only deterministic signal ordering.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add per-Agent proof-freshness rows for those active known-nonterminal signals.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only per-Agent signal freshness composition.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add active/disabled/retired NULL-status and unknown-future membership rows to the same signal test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only lifecycle-qualified NULL/unknown signal membership.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add uncertain/static presentation assertions for the NULL/unknown rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only NULL/unknown uncertain/static presentation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add the all-idle-blocking assertions for unresolved NULL/unknown rows.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only the unresolved-status idle barrier.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add cached nonterminal rows whose latest proof failed to the same signal test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only cached-proof-failure signals as uncertain and static.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add disabled/retired known-nonterminal rows to the same signal test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Implement only disabled/retired known-nonterminal signals as lifecycle-qualified and static.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_stage_signal_truth_table)`.
- [ ] Add PENDING/RUNNING rows one millisecond before and exactly at the local suspect threshold to `test_signal_suspect_boundary_and_deadline`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Derive only nullable PENDING/RUNNING `suspect_at`.
- [ ] Run the focused test and observe the remaining downgrade-boundary RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Apply only the exact signal downgrade boundary, emitting uncertain/static `状态待确认` without changing `raw_status`.
- [ ] Run the focused test and observe the remaining Agent-health RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Apply only the owning Agent health downgrade at the same boundary.
- [ ] Run the focused test and observe the remaining aggregate-health RED failure. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Apply only aggregate health/freshness composition for a suspect active signal.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Add the old PAUSED row to the same test, requiring nullable `suspect_at` and static presentation.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Implement only the PAUSED no-suspect/static branch.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_signal_suspect_boundary_and_deadline)`.
- [ ] Add `test_refresh_after_uses_five_or_thirty_second_base_cadence` with one fresh queued/active signal row and one no-live-signal row.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_uses_five_or_thirty_second_base_cadence)`.
- [ ] Implement only the `5000`/`30000` base-cadence selection.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_uses_five_or_thirty_second_base_cadence)`.
- [ ] Add `test_failing_agent_does_not_override_healthy_five_second_cadence` with one healthy fresh active signal and one separate Agent whose retry is already due.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_failing_agent_does_not_override_healthy_five_second_cadence)`.
- [ ] Implement only healthy-five-second-signal precedence over another Agent's failure retry.
- [ ] Run the focused test and require exact `refresh_after_ms=5000`. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_failing_agent_does_not_override_healthy_five_second_cadence)`.
- [ ] Add `test_refresh_after_clamps_due_retry_to_one_second` with retry/due timestamps before and equal to `snapshot_at` and an exact `refresh_after_ms=1000` assertion.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_clamps_due_retry_to_one_second)`.
- [ ] Clamp the server-computed retry delay to 1000..60000 milliseconds before taking it against the 5/30-second base.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_refresh_after_clamps_due_retry_to_one_second)`.
- [ ] Add exact local-source status rows to `test_archiving_and_terminal_receipts`, with only literal local `running` treated as archiving.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement only local archiving selection without rewriting raw status.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add list-confirmed and immediate-terminal-unconfirmed archiving freshness rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement only confirmed-fresh versus immediate-unconfirmed archiving presentation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add the exact five-minute archive-delay row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement only archive-delay removal and `ARCHIVE_DELAY` warning emission.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add the ten-second terminal-receipt expiry row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement only terminal-receipt lifetime overlay selection.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add the in-window archiving five-second-cadence row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Implement only archiving-presence cadence selection without using `fresh=true` as a proxy.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_archiving_and_terminal_receipts)`.
- [ ] Add the versioned URL-safe cursor round-trip row to `test_history_cursor_round_trip_and_bounds`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement only successful strict versioned cursor encode/decode.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add malformed base64/JSON/version/type/time cursor rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Map only malformed cursors to structured HTTP 422.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add the `(effective_started_at DESC, coreai_run_id DESC)` ordering rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement only stable history ordering.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add page-boundary continuation rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement only cursor page continuation.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add the default-20 limit row to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement only page-size defaulting.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add below-1 and above-100 limit rows to the same test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Implement only page-size clamping to `1..100`.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_cursor_round_trip_and_bounds)`.
- [ ] Add narrow projected-history field and forbidden-full-content assertions to `test_history_privacy_and_warning_projection`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] Implement only the narrow history serializer, excluding full Core AI content.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] Add canonical per-Run warning-code projection rows to the same privacy test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] Implement only the canonical history warning-code mapping.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_privacy_and_warning_projection)`.
- [ ] **GREEN characterization:** Add `test_projection_privacy_at_aggregate_serializer` with the Task 4 credential sentinel and raw top-level `input`, `output`, `transcript`, `artifacts`, and `error_stack` keys.
- [ ] Run the focused aggregate-serializer characterization and require the sentinel/raw fields absent while projected Token totals and sanitized `error_summary` remain factual. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_privacy_at_aggregate_serializer)`.
- [ ] **GREEN characterization:** Add `test_projection_privacy_at_history_serializer` with the same Task 4 sentinel/raw-field fixture.
- [ ] Run the focused history-serializer characterization and require the sentinel/raw fields absent while projected Token totals and sanitized `error_summary` remain factual. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_projection_privacy_at_history_serializer)`.
- [ ] Add the authenticated aggregate-GET row to `test_workbench_get_routes_contract_and_auth`.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] Wire only the authenticated aggregate GET route to its green helper with the fixed `30d` default.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] **GREEN characterization:** Add the unauthenticated aggregate-GET rejection row to the same route test.
- [ ] Run the focused route characterization and require PASS through the existing test-local operator dependency. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] **GREEN characterization:** Add `test_aggregate_route_range_defaults_to_30d` for an omitted `range`.
- [ ] Run the focused default-range characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_route_range_defaults_to_30d)`.
- [ ] Add `test_aggregate_route_invalid_range_is_422` for one unsupported value, asserting the exact `INVALID_RANGE` object envelope.
- [ ] Run the focused route test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_route_invalid_range_is_422)`.
- [ ] Map only unsupported aggregate ranges to 422 `{"code":"INVALID_RANGE","message":"不支持的时间范围","fields":{"range":"仅支持 today、7d、30d 或 all"}}` while preserving omitted `range=30d`.
- [ ] Run the focused route test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_aggregate_route_invalid_range_is_422)`.
- [ ] Add the authenticated history-GET row to the same route test.
- [ ] Run the focused test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] Wire only the authenticated history GET route to its green helper with the fixed `30d` default.
- [ ] Run the focused test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] **GREEN characterization:** Add the unauthenticated history-GET rejection row to the same route test.
- [ ] Run the focused route characterization and require PASS through the existing test-local operator dependency. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_get_routes_contract_and_auth)`.
- [ ] **GREEN characterization:** Add `test_history_route_range_defaults_to_30d` for an omitted `range`.
- [ ] Run the focused default-range characterization and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_route_range_defaults_to_30d)`.
- [ ] Add `test_history_route_invalid_range_is_422` for one unsupported value, asserting the same exact `INVALID_RANGE` object envelope.
- [ ] Run the focused route test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_route_invalid_range_is_422)`.
- [ ] Map only unsupported history ranges to the same exact 422 `INVALID_RANGE` envelope while preserving omitted `range=30d`.
- [ ] Run the focused route test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_route_invalid_range_is_422)`.
- [ ] Add `test_history_route_unknown_agent_is_404`, asserting `response.json() == {"detail":{"code":"AGENT_NOT_FOUND","message":"未找到 Agent","fields":{}}}` exactly.
- [ ] Run the focused route test and observe RED. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_route_unknown_agent_is_404)`.
- [ ] Map only an absent local registry ID to the exact object-shaped 404 error.
- [ ] Run the focused route test and require PASS. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_history_route_unknown_agent_is_404)`.
- [ ] **GREEN characterization:** Add the canonical multi-Agent `EXPECTED_WORKBENCH_SNAPSHOT` fixture after every serializer/composition slice is green.
- [ ] Add only the exact-equality assertion against that fixture to `test_workbench_snapshot_contract`.
- [ ] Run the focused final contract characterization and require PASS without an open-ended correction step. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q -k test_workbench_snapshot_contract)`.

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

Treat persisted `remote_total_runs`, returned count, and coverage boundary as the last upstream observation, not automatically as a currently usable all-history denominator. Derive durable `history_dirty = unfiltered_proven_event_epoch IS NULL OR unfiltered_proven_event_epoch < history_event_epoch`, and independently derive `has_unconfirmed_local_run` from any projected row with `last_synced_at IS NULL`. While either is true, expose effective `coverage.remote_total_runs=NULL` and `history_complete=false` while retaining the last observed values in SQLite; emit deterministic `HISTORY_PROOF_DIRTY`, plus `LOCAL_RUN_UNCONFIRMED` and, for nullable status, `LOCAL_TRIGGER_STATUS_MISSING` when applicable. This applies to immediate known, terminal/SKIPPED, unknown-future, and NULL-status projections alike. A post-event exact-zero or filtered-only confirmation cannot produce `基于已镜像 1/0 次`, restore the all-history denominator, or make `all` complete. These are global history/denominator barriers, not automatic finite-range barriers: an affected row invalidates a finite range only while its factual `effective_started_at` belongs to that selected range or while no independent `finite_range_proven_start_at` covers the range.

Even after every row has a successful list observation, a persisted upstream total smaller than `mirrored_run_count` is contradictory rather than an all-history denominator: expose effective total NULL, keep `history_complete=false`, and emit `REMOTE_TOTAL_BELOW_MIRRORED`. Never clamp either side or invent a corrected total. Clear that derived warning only after a valid unfiltered response supplies a total at least as large as the mirrored count and the normal all-history proof passes. The contradiction does not by itself poison a later finite range whose independent window proof starts after every discrepant local identity; an in-range discrepancy still invalidates that window when the synchronization transaction cannot establish its proof marker.

Overall history is complete only when the latest valid unfiltered response is untruncated, `unfiltered_proven_event_epoch == history_event_epoch`, `last_discovery_returned_count == remote_total_runs == mirrored_run_count`, and its returned ID set exactly matches the projected ID set for that Agent. A finite selected range is identity-complete when overall history is complete or `range_start` is non-NULL and at or after a non-NULL `finite_range_proven_start_at` produced by the latest valid unfiltered-window algorithm in Contract 6I. This finite proof does not require the globally exposed `remote_total_runs` to be non-NULL and does not require the all-history epochs to match. The marker already excludes unconfirmed, filtered-only, and missing-start identities at or after its boundary; as a defense-in-depth query-time check, any row with `last_synced_at IS NULL` or missing/invalid upstream `started_at` whose factual effective start belongs to the selected half-open range forces `range_complete=false`. `all` is complete only with complete history. `metrics_complete_for_range` additionally requires every included Agent's latest due discovery to have succeeded and no unresolved uncertain, NULL-status, or unknown-status Run in the selected range. An unresolved row before `range_start` keeps global warnings/history qualification but does not poison today/7d/30d forever. Assert both sides of the exact `effective_started_at == range_start` boundary and include mirrored/remote/coverage qualifiers whenever a metric is incomplete.

Aggregate mirrored_run_count always sums local rows. Aggregate remote_total_runs is NULL if any included Agent has never produced an unfiltered total or its effective all-history total is unusable because of a dirty history generation, unconfirmed local row, or total contradiction; otherwise it is the sum. Aggregate coverage_start_at is the latest per-Agent last-observed boundary and coverage_as_of is the oldest per-Agent discovery success; either is NULL when any included Agent has never produced that observation. The internal aggregate finite proof boundary is the latest included per-Agent `finite_range_proven_start_at`; every included Agent must cover the selected finite range. The completeness booleans and global warnings remain independent, so a response may truthfully have `remote_total_runs=NULL`, `history_complete=false`, and `range_complete=true` for a recent finite window.

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

**Implementation reference 5F: Range, aggregate, signals, and history**

Keep SQL parameterized and calculate current state independently from the historical range. Centralize status sets and derive effective_started_at once:

~~~python
OUTCOME_STATUSES = {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"}
SUCCESS_STATUSES = {"COMPLETED"}

def counts_as_run(raw_status: str | None) -> bool:
    return raw_status != "SKIPPED"

def effective_started_at(row: sqlite3.Row) -> datetime:
    return parse_utc(row["started_at"]) if row["started_at"] else parse_utc(row["first_seen_at"])

def elapsed_seconds(snapshot_at: datetime, effective_start: datetime) -> int:
    return max(0, math.floor((snapshot_at - effective_start).total_seconds()))

def duration_seconds(row: sqlite3.Row, effective_start: datetime) -> int | None:
    if row["raw_status"] not in KNOWN_TERMINAL or not row["completed_at"]:
        return None
    completed = parse_utc(row["completed_at"])
    return max(0, math.floor((completed - effective_start).total_seconds()))
~~~

Build one read transaction so agents, metrics, current qualities, signals, and warnings describe the same SQLite snapshot. Generate `snapshot_at` once at response start, execute literal `conn.execute("BEGIN")` before the first SELECT, perform no writes, and call `conn.rollback()` in `finally` to close the read transaction; do not use `BEGIN IMMEDIATE` for this read path. The WAL-mode second-connection test must commit a concurrent mutation between component reads yet still observe the original generation throughout the builder. Return server-prepared local_href/local_label; the browser must never reverse-map task_execution IDs.

Within that same transaction compute per-Agent mirrored/unconfirmed counts and compare `history_event_epoch` with `unfiltered_proven_event_epoch` before serializing coverage. If the generation is dirty, any row has `last_synced_at IS NULL`, or the persisted upstream total is lower than mirrored count, expose the effective all-history remote total as NULL and force `history_complete=false` without overwriting persisted last-observed fields. Emit `HISTORY_PROOF_DIRTY`, `LOCAL_RUN_UNCONFIRMED`, or `REMOTE_TOTAL_BELOW_MIRRORED` from those facts. Derive finite `range_complete` independently from `finite_range_proven_start_at` and the selected range's factual unresolved/missing-start membership exactly as Contract 5C specifies; never copy a global history boolean into a finite-range boolean. Formatting code must never clamp `M`, divide by zero, or render `N/0` when N is positive.

sync_warnings is the stable, de-duplicated union of bootstrap_configuration_warnings(), association_preflight_warnings(), per-Agent discovery/current/metadata warnings, local Run confirmation/NULL-status warnings, unusable-total warnings, unknown-status warnings, Token/timestamp data warnings, terminal conflicts, and archive delays. Sort by code, local_agent_id, then coreai_run_id so equal snapshots serialize deterministically; never include upstream payloads or credentials.

Set refresh_after_ms to 5000 when a fresh queued/active signal or any in-window local archiving signal exists; otherwise 30000. When health is partial/stale, clamp the earliest persisted retry delay to 1000..60000 milliseconds first, then use the earlier of that value and the base cadence. A due-at/before-snapshot event therefore recommends one immediate-next browser read after one second, never 0/negative or a busy loop. Never let one failing Agent override a healthy active five-second signal.

- [ ] Run the complete Task 5 aggregate/history test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench.py -q)
~~~

- [ ] Stage exactly the two Task 5 files and assert the sorted staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench.py
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/agent_workbench.py api/tests/test_agent_workbench.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 5 staged patch and require its whitespace check to pass.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 5 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: serve agent workbench snapshots"
~~~

- [ ] Prove the isolated worktree is clean after the Task 5 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Add the list-only fake/call recorder and its close/get_run guard.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q --collect-only)` and require collection to pass before production edits.
- [ ] Add `test_claim_and_release_independent_leases`, claiming Run and metadata lanes concurrently for the same Agent.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_claim_and_release_independent_leases)` and observe RED.
- [ ] Implement separate conditional owner/epoch/expiry columns and matching-lane release only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_claim_and_release_independent_leases)` and require PASS.
- [ ] Add the Run-lane matching-owner row to `test_independent_lease_renewal_and_expiry`.
- [ ] Add the Run-lane wrong-owner row to the same renewal test.
- [ ] Add the Run-lane expired-lease row to the same renewal test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)` and observe RED.
- [ ] Implement `renew_run_lease` without metadata-lane mutation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)` and require the Run-lane rows to pass.
- [ ] Add the metadata-lane matching-owner row to `test_independent_lease_renewal_and_expiry`.
- [ ] Add the metadata-lane wrong-owner row to the same renewal test.
- [ ] Add the metadata-lane expired-lease row to the same renewal test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)` and observe RED on the metadata branch.
- [ ] Implement `renew_metadata_lease` without Run-lane mutation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_independent_lease_renewal_and_expiry)` and require PASS.
- [ ] Add `test_full_discovery_proof` for the exact four-call sequence.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_discovery_proof)` and observe RED.
- [ ] Implement one serialized per-Agent request plan and parsed in-memory CycleResult, without concurrency.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_discovery_proof)` and require the four-call selection to pass.
- [ ] Add the initial fence/no-write assertions to `test_cycle_commits_atomically_and_schedules`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and observe RED.
- [ ] Implement only the `BEGIN IMMEDIATE` owner/epoch/expiry/event fence and false/no-write exit in `commit_discovery_cycle`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and require the fence assertions to pass while the atomic-write assertion remains RED.
- [ ] Add the forced-upsert-failure assertion that all four parsed page outcomes appear together or none do.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and observe RED on atomic projection.
- [ ] Implement only the four-page projection/upsert unit inside the existing transaction.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and require the atomic-write assertions to pass while the schedule assertion remains RED.
- [ ] Add the exact next-discovery/fast due and lease-release assertions.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and observe RED on scheduling.
- [ ] Implement only cadence/backoff scheduling and matching-lane release.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_cycle_commits_atomically_and_schedules)` and require PASS.
- [ ] Add the identical-heartbeat row to `test_projection_revision_tracks_material_change_not_heartbeat`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the heartbeat to leave the revision unchanged.
- [ ] Add the Run identity/status row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED when the revision does not increment.
- [ ] Add Run identity/status to the canonical semantic tuple while excluding observation/due/lease timestamps.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the identity/status row to pass.
- [ ] Add the Token row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on Token change.
- [ ] Add only Token values to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the Token row to pass.
- [ ] Add the association row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on association change.
- [ ] Add only association values to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the association row to pass.
- [ ] Add the quality/error row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on quality/error change.
- [ ] Add only quality/error values to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the quality/error row to pass.
- [ ] Add the receipt row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on receipt change.
- [ ] Add only receipt values to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the receipt row to pass.
- [ ] Add the history-epoch row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on history-epoch change.
- [ ] Add only history-epoch fields to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the history-epoch row to pass.
- [ ] Add the remote-total/coverage row to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on remote-total/coverage change.
- [ ] Add only remote-total/coverage fields to the canonical semantic tuple.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require the remote-total/coverage row to pass.
- [ ] Add the `finite_range_proven_start_at` row and the simultaneous-material-change assertion to the revision test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and observe RED on the finite-range proof field.
- [ ] Add only `finite_range_proven_start_at` to the canonical semantic tuple while preserving one increment per transaction.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_projection_revision_tracks_material_change_not_heartbeat)` and require PASS.
- [ ] Add `test_local_registration_after_response_before_commit_blocks_idle`, pausing an exact-zero cycle after all four responses and inserting one local RUNNING projection through a second connection.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_local_registration_after_response_before_commit_blocks_idle)` and observe RED.
- [ ] Add the in-transaction local-event barrier that rereads locally unconfirmed rows after page upserts and refuses exact proof for IDs absent from the cycle.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_local_registration_after_response_before_commit_blocks_idle)` and require PASS.
- [ ] Add the active-owner PENDING row to `test_every_unconfirmed_raw_status_requires_exact_id_observation`, requiring bucket uncertainty, static presentation, unusable history proof, and a bounded five-second confirmation schedule.
- [ ] Add the active-owner RUNNING row to the same classifier test with the same expected uncertainty, presentation, history, and confirmation schedule.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and observe RED.
- [ ] Generalize the exact-ID barrier for unconfirmed PENDING/RUNNING rows owned by an active Agent with a five-second retry and no due-now busy loop.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and require the PENDING/RUNNING rows to pass.
- [ ] Add the active-owner PAUSED row to the same classifier test, requiring all applicable proof to remain uncertain and full discovery within 30 seconds.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and observe RED on PAUSED.
- [ ] Extend the active-owner exact-ID barrier to unconfirmed PAUSED rows with no-later-than-30-second full discovery.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and require the PAUSED row to pass.
- [ ] Add the active-owner parameterized COMPLETED row to the same classifier test, requiring all three current buckets to remain uncertain and full discovery within 30 seconds.
- [ ] Add the active-owner parameterized FAILED row to the same classifier test with the same expected uncertainty and discovery schedule.
- [ ] Add the active-owner parameterized TIMEOUT row to the same classifier test with the same expected uncertainty and discovery schedule.
- [ ] Add the active-owner parameterized CANCELLED row to the same classifier test with the same expected uncertainty and discovery schedule.
- [ ] Add the active-owner parameterized SKIPPED row to the same classifier test with the same expected uncertainty and discovery schedule.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and observe RED on terminal/SKIPPED rows.
- [ ] Extend the active-owner exact-ID barrier to unconfirmed terminal/SKIPPED rows without changing their persisted status.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and require the terminal/SKIPPED rows to pass.
- [ ] Add the active-owner future-status row to the same classifier test, requiring UNKNOWN/static presentation, unusable history proof, and full discovery within 30 seconds.
- [ ] Add the active-owner NULL-status row to the same classifier test with the same expected presentation, history, and discovery schedule.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and observe RED on future/NULL rows.
- [ ] Extend the active-owner exact-ID barrier to unconfirmed future and NULL statuses without inventing a known state.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_every_unconfirmed_raw_status_requires_exact_id_observation)` and require PASS without a due-now busy loop.
- [ ] Add `test_inactive_unconfirmed_post_archival_cycle_preserves_lifecycle_cadence`, parameterized over disabled/retired owners and PENDING, RUNNING, PAUSED, COMPLETED, FAILED, TIMEOUT, CANCELLED, SKIPPED, one future non-empty status, and NULL. Seed each `last_synced_at IS NULL` row with `next_discovery_at=now` and `next_fast_poll_at=NULL`, execute its first successful exact-zero four-list archival cycle while omitting the ID, and assert the row/barrier remains uncertain and static, `next_fast_poll_at IS NULL`, and `next_discovery_at` is exactly the cycle observation time plus 15 minutes/24 hours respectively. Advance 30 seconds and assert a second worker makes zero upstream calls.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_inactive_unconfirmed_post_archival_cycle_preserves_lifecycle_cadence)` and observe RED if any inactive status family receives a five-second fast poll, a no-later-than-30-second discovery, or loses its confirmation barrier.
- [ ] Branch unconfirmed scheduling on the lifecycle reread inside `commit_discovery_cycle`: only an active owner may schedule PENDING/RUNNING at now+5 seconds or PAUSED/terminal/SKIPPED/future/NULL at no later than now+30 seconds. After a successful disabled/retired archival cycle, set `next_fast_poll_at=NULL` and schedule the next discovery at the cycle observation time plus `DISABLED_DISCOVERY_SECONDS`/`RETIRED_DISCOVERY_SECONDS`, regardless of the unresolved row's raw status; the omitted exact ID remains uncertain and list-unconfirmed.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k 'test_every_unconfirmed_raw_status_requires_exact_id_observation or test_inactive_unconfirmed_post_archival_cycle_preserves_lifecycle_cadence')` and require PASS for both active-speed and inactive-archival branches.
- [ ] Add `test_filtered_only_new_identity_keeps_history_generation_dirty` with truncated total 500/mirrored 200, a usable finite-range boundary, and one in-range fast-filtered-only identity; assert mirrored 201, retained persisted total/boundary, effective total NULL, a tightened finite marker, and incomplete history/range/metrics after restart.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_only_new_identity_keeps_history_generation_dirty)` and observe RED.
- [ ] Increment `history_event_epoch` once per distinct new Run identity, advance `unfiltered_proven_event_epoch` only from a valid post-generation unfiltered page, and atomically tighten `finite_range_proven_start_at` beyond any new identity absent from that same unfiltered page.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_only_new_identity_keeps_history_generation_dirty)` and require PASS.
- [ ] Add `test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty` with a filtered-only in-range ID in cycle one and a valid truncated page omitting it in cycle two.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty)` and observe RED if the proven epoch advances.
- [ ] Add the restart-safe truncated-page all-history-epoch guard using only persisted fields: require every projected ID with valid upstream start at or after the new `coverage_start_at` in the unfiltered returned-ID set, and block only `unfiltered_proven_event_epoch` advancement when any projected row has missing/invalid upstream `started_at`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_unfiltered_omitting_dirty_in_range_identity_keeps_history_dirty)` and require PASS; the separate finite-range marker remains for the next slice.
- [ ] Add `test_finite_range_proof_ignores_old_unconfirmed_rows` with one old NULL-status marker, one old known unconfirmed row, and one old list-confirmed missing-start row strictly before the selected range after restart, followed by one coherent truncated window.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_finite_range_proof_ignores_old_unconfirmed_rows)` and observe RED when finite metrics inherit the dirty global epoch.
- [ ] Derive and persist a separate coherent finite-window marker from the truncated proof while retaining global history/remote-total qualification.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_finite_range_proof_ignores_old_unconfirmed_rows)` and require `finite_range_proven_start_at <= range_start` plus recovered finite metrics.
- [ ] Add `test_finite_range_boundary_is_inclusive`, moving each unresolved/missing-start fixture's factual effective start to exactly `range_start`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_finite_range_boundary_is_inclusive)` and observe RED if range metrics remain complete.
- [ ] Tighten the safe marker to `next_instant` of an inclusive-boundary blocker.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_finite_range_boundary_is_inclusive)` and require range/metrics to remain incomplete.
- [ ] Add `test_full_proof_then_old_filtered_only_preserves_finite_range`, establishing a full-history proof before discovering one filtered-only identity strictly before the persisted finite floor and restarting.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_proof_then_old_filtered_only_preserves_finite_range)` and observe RED if the marker is erased or widened.
- [ ] Write the oldest supported finite-range boundary after exact full proof and monotonically tighten it only past factual in-range blockers.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_full_proof_then_old_filtered_only_preserves_finite_range)` and require the old identity to dirty global history while the fresh finite range survives restart.
- [ ] Add the missing-start truncated-cycle portion of `test_truncated_history_cannot_catch_up_with_any_missing_started_at`, seeding an older otherwise-clean projected row with NULL upstream start and proving a later truncated page cannot advance the epoch even when every in-bound valid-start ID is present.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_history_cannot_catch_up_with_any_missing_started_at)` and observe RED if the epoch advances.
- [ ] Extend the truncated all-history guard so any projected missing/invalid upstream `started_at` blocks epoch advancement.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_history_cannot_catch_up_with_any_missing_started_at)` and require the truncated-cycle assertions to pass.
- [ ] Add a third untruncated cycle containing the missing-start ID with a consistent exact ID set/total to the same test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_truncated_history_cannot_catch_up_with_any_missing_started_at)` and require equal all-history epochs plus recovered `history_complete`.
- [ ] Add `test_untruncated_all_history_requires_exact_projected_id_set`, omitting one existing projected ID from an otherwise untruncated page.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_untruncated_all_history_requires_exact_projected_id_set)` and observe RED.
- [ ] Require exact returned/projected ID-set equality before advancing the all-history proven epoch or exposing `history_complete=true`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_untruncated_all_history_requires_exact_projected_id_set)` and require PASS.
- [ ] Add the exact row to `test_filtered_set_quality_truth_table`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and observe RED on the exact branch.
- [ ] Implement the exact filtered-set quality branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and require the exact row to pass.
- [ ] Add the lower-bound row to `test_filtered_set_quality_truth_table`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and observe RED on the lower-bound branch.
- [ ] Implement the lower-bound filtered-set quality branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and require the lower-bound row to pass.
- [ ] Add the unknown/error-preservation row to `test_filtered_set_quality_truth_table`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and observe RED on the unknown branch.
- [ ] Implement the unknown filtered-set quality and prior-observation/error-preservation branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_filtered_set_quality_truth_table)` and require PASS.
- [ ] Add the same-ID PENDING+RUNNING row to `test_same_cycle_status_conflict_blocks_complete_proof`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and observe RED.
- [ ] Apply Task 4 transition guards in deterministic observation order plus conflict-qualified buckets/current state for non-terminal conflicts.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and require the PENDING+RUNNING row to pass.
- [ ] Add the terminal-unfiltered+RUNNING row to the same conflict test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and observe RED on terminal conflict handling.
- [ ] Extend the deterministic transition/conflict qualification to preserve the authoritative terminal status.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and require both conflict rows to pass.
- [ ] Add a stable following-cycle row that clears only the transient current-proof conflict.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and observe RED if transient conflict state persists or a persistent terminal conflict clears.
- [ ] Implement stable-cycle clearing for only the transient current-proof conflict.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_same_cycle_status_conflict_blocks_complete_proof)` and require PASS.
- [ ] Add `test_failed_fast_confirmation_revokes_motion`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_failed_fast_confirmation_revokes_motion)` and observe RED.
- [ ] Implement run-specific attempt/error updates without status regression.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_failed_fast_confirmation_revokes_motion)` and require PASS.
- [ ] Add `test_fast_confirmation_deduplicates_status_calls`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_fast_confirmation_deduplicates_status_calls)` and observe RED.
- [ ] Implement distinct-status five-second request planning.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_fast_confirmation_deduplicates_status_calls)` and require PASS.
- [ ] Add `test_transition_resolution_merge_and_absence`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_transition_resolution_merge_and_absence)` and observe RED.
- [ ] Implement same-cycle merge, bounded unfiltered fallback, and uncertainty.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_transition_resolution_merge_and_absence)` and require PASS.
- [ ] Add `test_metadata_failure_does_not_block_list_proof`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_failure_does_not_block_list_proof)` and observe RED.
- [ ] Implement a separately fenced metadata outcome/backoff commit while the Run worker completes its list plan independently.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_failure_does_not_block_list_proof)` and require PASS.
- [ ] Add the success row to `test_metadata_only_due_success_and_failure` with due `next_verification_at`, future `next_discovery_at`, and no fast status due.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)` and observe RED on metadata-only success.
- [ ] Implement the metadata-only success request plan with exactly one `get_agent()`, zero list calls, and changes limited to metadata verification/cache fields.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)` and require the success row to pass while preserving every current-quality/count, discovery/fast timestamp, `next_discovery_at`, and projected Run.
- [ ] Add the failure row to `test_metadata_only_due_success_and_failure` with the same independent-clock preservation assertions.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)` and observe RED on metadata-only failure.
- [ ] Implement metadata-only error/backoff updates without touching Run-list state.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_metadata_only_due_success_and_failure)` and require PASS.
- [ ] Add `test_blocked_metadata_never_delays_fast_or_full_proof`, holding `get_agent()` behind a threading.Event while five-second fast and thirty-second discovery work become due for the same Agent.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_blocked_metadata_never_delays_fast_or_full_proof)` and observe RED.
- [ ] Split metadata into its own client/connection/lease/task pool so due status lists commit while metadata remains blocked and RUNNING motion remains eligible.
- [ ] Release the metadata barrier and implement the metadata completion path so it commits only verification fields.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_blocked_metadata_never_delays_fast_or_full_proof)` and require PASS.
- [ ] Add the transport-exception sentinel row to `test_sync_diagnostics_redact_secrets`, capturing logs and every persisted error column.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and observe RED.
- [ ] Map transport exceptions directly to fixed Workbench-owned codes/messages without inspecting `CoreAiError.args`, `str(exc)`, repr, or cause.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and require the transport sentinel to be absent from logs, results, exception repr, and SQLite.
- [ ] Add the 500 text-body sentinel row to the diagnostics test.
- [ ] Add the 500 JSON-body sentinel row to the diagnostics test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and observe RED on HTTP-body leakage.
- [ ] Map HTTP failures directly to fixed Workbench-owned codes/messages without inspecting response bodies.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and require both HTTP-body sentinels to be absent.
- [ ] Add the malformed-envelope sentinel row to the diagnostics test.
- [ ] Add the arbitrary-exception sentinel row to the diagnostics test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and observe RED on the first unmapped branch.
- [ ] Map malformed-envelope and arbitrary exceptions directly to fixed Workbench-owned codes/messages without inspecting exception arguments, repr, body, or cause.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and require those sentinels to be absent.
- [ ] Add the successfully parsed Run-list row carrying explicit string `error`/`message`, Bearer label, and sensitive URL query to the diagnostics test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and observe RED on source-text sanitization.
- [ ] Route only that dedicated string `error` or string `message` member through `sanitize_operator_text(..., sensitive_values=...)`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_sync_diagnostics_redact_secrets)` and require every sentinel to be absent from logs, HTTP/background results, exception repr, `last_verification_error`, `last_discovery_error`, `current_state_error`, `last_fast_poll_error`, projected `last_poll_error`, and `error_summary`.
- [ ] Add `test_lifecycle_cadence_and_backoff`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_lifecycle_cadence_and_backoff)` and observe RED.
- [ ] Implement per-lifecycle due times and per-Agent bounded retries.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_lifecycle_cadence_and_backoff)` and require PASS.
- [ ] Add the disabled row to `test_disabled_and_retired_archival_four_call_cycle`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)` and observe RED.
- [ ] Extend disabled lifecycle request planning to keep all four bounded reads and merge old non-terminal rows with static lifecycle qualification.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)` and require the disabled row to pass.
- [ ] Add the retired row to `test_disabled_and_retired_archival_four_call_cycle`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)` and observe RED on retired lifecycle handling.
- [ ] Extend the same archival request plan and static qualification to retired Agents.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_and_retired_archival_four_call_cycle)` and require PASS.
- [ ] Add `test_startup_priming_and_dedup_window`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_startup_priming_and_dedup_window)` and observe RED.
- [ ] Implement due-now priming without lease mutation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_startup_priming_and_dedup_window)` and require PASS.
- [ ] Add `test_two_agent_timeout_isolation`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_two_agent_timeout_isolation)` and observe RED.
- [ ] Implement per-Agent `asyncio.to_thread` tasks and reaping/fill behavior.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_two_agent_timeout_isolation)` and require PASS.
- [ ] Add the seventeen-Agent refill row to `test_supervisor_caps_and_refills_seventeen_agents`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_caps_and_refills_seventeen_agents)` and observe RED.
- [ ] Implement the eight-task cap, due ordering, and local in-flight map.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_caps_and_refills_seventeen_agents)` and require both the existing 12-Agent case and new 17-Agent case to pass.
- [ ] Add the expired-lease row to `test_expired_or_reacquired_lease_discards_response`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)` and observe RED.
- [ ] Implement pre-request renewal and the expired pre-commit fence reread.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)` and require the expired-lease row to pass.
- [ ] Add the reacquired-lease row to `test_expired_or_reacquired_lease_discards_response`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)` and observe RED on owner/epoch replacement.
- [ ] Extend the pre-commit fence reread to reject a reacquired owner/epoch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_expired_or_reacquired_lease_discards_response)` and require PASS.
- [ ] Add `test_inflight_lifecycle_change_controls_next_cadence`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_inflight_lifecycle_change_controls_next_cadence)` and observe RED.
- [ ] Implement lifecycle reread inside the fenced commit.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_inflight_lifecycle_change_controls_next_cadence)` and require PASS.
- [ ] Add `test_disabled_cycle_cannot_satisfy_reenable_proof`, pausing an archival cycle after its responses and re-enabling through a second connection.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_cycle_cannot_satisfy_reenable_proof)` and observe RED.
- [ ] Reuse the captured `local_event_epoch` fence so the old cycle cannot clear `sync_pending`, publish exact current proof, or postpone due-now work.
- [ ] Add the next-full-cycle assertion requiring the new epoch to clear the re-enable proof.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_disabled_cycle_cannot_satisfy_reenable_proof)` and require PASS.
- [ ] Add `test_supervisor_cancellation_awaits_both_worker_pools`, blocking one Run request and one metadata request.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_cancellation_awaits_both_worker_pools)` and observe RED.
- [ ] Implement the shared threading.Event shutdown and await outstanding thread tasks from both maps.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py -q -k test_supervisor_cancellation_awaits_both_worker_pools)` and require PASS.

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

Assert successful active/disabled/retired discovery schedules 30 seconds/15 minutes/24 hours respectively. For a due disabled Agent and a due retired Agent, the call recorder must still show the exact unfiltered, PENDING, RUNNING, and PAUSED four-request archival cycle; seed an old non-terminal row and prove that cycle participates in the same merge/reconciliation rules while remaining lifecycle-qualified and static. Repeat with every `last_synced_at IS NULL` status family omitted from the archival pages: successful inactive reconciliation must retain the confirmation barrier, force `next_fast_poll_at=NULL`, and schedule only the next 15-minute/24-hour lifecycle discovery. An unresolved inactive row never inherits the active five-second or no-later-than-30-second confirmation cadence after its first archival cycle. Transport failures preserve the projection and retry that Agent at 5, 10, 20, 40, then 60 seconds without affecting another Agent. A success resets only that Agent's corresponding backoff. Fast and discovery due times remain independent.

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
- increments `history_event_epoch` exactly once per distinct new Run ID. If there is no valid unfiltered response, leave `unfiltered_proven_event_epoch` unchanged. If the transaction entered with the persisted history epoch equal to the lease's captured generation and no local event changed either captured epoch, evaluate all-history proof against the unfiltered page before counting any same-cycle filtered-only identity. An untruncated page may advance only when its returned-ID set exactly equals the complete projected-ID set after applying its own new identities. A truncated page may advance only when it has a valid `coverage_start_at`, every projected row with valid upstream `started_at` at or after that boundary appears in its returned-ID set, and no projected row at all has missing/invalid upstream `started_at`; `first_seen_at` is never a substitute for this global epoch. If that predicate passes, set the proven epoch to `captured_history_event_epoch + len(new_unfiltered_ids)`; then increment the history epoch for every same-cycle filtered-only new identity, leaving those later increments globally dirty. If it fails, keep the prior proven epoch. Thus an unfiltered response fetched first can never globally prove a new identity discovered only by a following filtered call, and a later truncated page that omits a dirty in-range valid-start identity still cannot catch up. If the entry epoch differs because a local event committed while requests were in flight, do not advance the all-history proven epoch at all; still preserve valid observations and increment the current epoch for any genuinely new identities;
- derives `finite_range_proven_start_at` separately from the global epoch in the same valid unfiltered commit. It is the earliest inclusive start currently safe for the supported finite ranges, and `next_instant(t)` means exactly one microsecond after an aware UTC factual timestamp. For an untruncated page whose returned-ID set exactly equals the complete projected-ID set, write the oldest supported finite-range start (`30d`) calculated at that proof's observation time in the configured timezone; this durable floor survives restart and is sufficient for later-moving today/7d/30d boundaries. If an otherwise untruncated page has projected IDs absent from the returned exact remote set, start from that same floor and tighten it to at least `next_instant(max effective_started_at(absent IDs))`. For a truncated page, require every returned row to have a valid upstream `started_at`, take `coverage_start_at` as the candidate floor, and require every projected row with a valid upstream `started_at >= coverage_start_at` to be present in that returned set; if this containment fails, store NULL because no contiguous window was proved. When that window is coherent, tighten the candidate to at least `next_instant` of every projected row whose upstream start is missing/invalid or whose exact ID remains unconfirmed, using `first_seen_at` only as that row's factual effective-start fallback. A blocker before the candidate leaves it unchanged; a blocker exactly at a selected `range_start` moves the marker after the boundary. Any local or same-cycle filtered-only new identity not included in the unfiltered result atomically changes the marker to `max(existing_marker, next_instant(effective_started_at(new row)))`, leaving NULL as NULL; it must not blindly erase a full/window proof that remains valid after an old out-of-range identity. An older in-flight generation cannot write or widen the marker. A failed/invalid due discovery may retain the last marker as evidence, but Contract 5C's latest-due-success condition keeps metrics incomplete until a new successful proof;
- upserts rows from valid pages by response observation time, using the identity partition above so a duplicate across pages increments the generation once only;
- builds the set of Run IDs actually observed by valid pages in this cycle, then rereads every locally registered row whose `last_synced_at IS NULL`; for each unobserved PENDING/RUNNING/PAUSED row, overrides the corresponding bucket to unknown; each unobserved known terminal/SKIPPED row invalidates all three current buckets because a trigger-response terminal is still not list-confirmed; and each unobserved unknown-future or NULL-status row keeps unresolved-unknown/current completeness false and preserves its warning. Branch the unresolved-row schedule on the lifecycle reread used by the fenced commit. Only for an active owner, after the immediate due-now attempt, schedule the next confirmation at now+5 seconds for known PENDING/RUNNING and the next full discovery no later than now+30 seconds for PAUSED, terminal/SKIPPED, future, or NULL status; never leave a completed attempt permanently due-now. For a disabled/retired owner after any successful archival cycle, every status family instead leaves `next_fast_poll_at=NULL` and sets `next_discovery_at` to the cycle observation time plus 15 minutes/24 hours, so an omitted unconfirmed ID remains a static barrier without accelerating the lifecycle. When a valid page finally contains the exact ID, mark that row list-confirmed and set `last_synced_at`; for a compatible transition, fill its parsed trigger/upstream fields, and for a NULL marker also fill exact raw status and clear only `LOCAL_TRIGGER_STATUS_MISSING`. If the list disagrees with an immediate terminal status, set `last_synced_at` to clear only the derived `LOCAL_RUN_UNCONFIRMED` identity barrier, preserve the complete first terminal payload tuple under Task 4's guard, and retain `TERMINAL_STATUS_CONFLICT` so affected current/history truth remains qualified;
- detects duplicate Run IDs with conflicting same-cycle statuses before deriving set counts, applies the ordered observations through terminal-safe Task 4 guards, downgrades every implicated current bucket to unknown, and schedules the transient conflict retry;
- updates last-observed unfiltered remote_total_runs, last_discovery_returned_count, coverage_start_at, finite_range_proven_start_at, and last discovery success/error; Task 5 withholds the global denominator whenever the two history epochs differ or total is contradictory while still permitting an independently covered finite range;
- replaces each valid status observation and changes failed status quality to unknown without deleting its prior observation;
- derives `unresolved_unknown_status_count` from distinct rows whose status is NULL or non-empty/unmapped, then derives current_state_complete;
- clears sync_pending only when all three known sets are exact and unresolved unknown is zero;
- schedules lifecycle cadence or bounded retry independently;
- updates run-specific confirmation errors without rewriting raw status.

Compare canonical before/after semantic tuples inside that transaction and increment `projection_revision` exactly once when any projected Run identity/status/upstream time/Token/association/warning/receipt field, either history epoch, or any count/total/quality/error/sync-pending/coverage/finite-range-proof value changes. Do not increment it for observation timestamps, freshness extensions, due/backoff times, lease fields, or an otherwise identical repeated proof. This SQLite-only monotonic marker supports Task 11's per-Agent stable readback windows; it is not exposed as a browser freshness claim.

Every unfiltered and filtered list request uses the one validated SEO_OPS_AGENT_HISTORY_LIMIT value for that process, default 200 and bounded 1..1000. The latest valid unfiltered page is ordered by Core AI started_at descending. When truncated, set coverage_start_at only if every returned row has a valid started_at; first_seen_at remains a display fallback but cannot prove remote range coverage.

**Implementation reference 6J: Independent per-Agent workers and async supervisor**

`sync_registered_agent_runs_once` opens its own SQLite connections and creates/closes one CoreAiClient for that Agent; unfiltered/status list requests inside one Run lease stay serialized. `verify_registered_agent_metadata_once` owns a different connection, client, and metadata lease and performs only `get_agent`. Different Agents run independently, and the two lanes for one Agent may overlap so a 30-second metadata transport cannot age out a five-second Run proof.

`agent_workbench_sync_loop` keeps two local maps and two independent caps: at most `MAX_CONCURRENT_AGENT_SYNCS` Run tasks and `MAX_CONCURRENT_METADATA_SYNCS` metadata tasks, each dispatched through `asyncio.to_thread`. Every one-second supervisor tick reaps both maps, reads each lane's due Agent IDs in its persisted due-time order, excludes only an ID already running in that same lane/process, and fills both pools without awaiting the other lane or an unrelated Agent. The local maps are scheduling mechanics, never source-of-truth state; due times, errors, counts, and both leases stay in SQLite for multi-worker coherence.

If credentials are missing, dispatch no network work in either lane; persisted data stays readable and aggregate health becomes unavailable. Give both worker kinds a shared threading.Event checked before every next upstream request. On supervisor cancellation, set that event and await every current thread task from both maps; at most each lane's current 30-second httpx request remains, and each response still needs its own valid fence before commit.

At the worker boundary, gather the active Core AI API key and available local authentication credentials into a short-lived tuple passed only to `sanitize_operator_text`; never persist, return, or log that tuple. Transport, HTTP, malformed-envelope, and unexpected exceptions always map to a fixed Workbench-owned code/message; never inspect an arbitrary exception string argument, `CoreAiError.args`, `str(exc)`, repr, body, or nested cause. The only upstream source text allowed through the sanitizer is the dedicated string `error` field—or its explicit string `message` member—of an otherwise successfully parsed Run-list row. Diagnostics contain a stable code and sanitized local Agent/Run identifiers only. Do not log raw exception repr, response bodies, request headers, nested causes, or tracebacks whose exception chain can reveal those values; raise mapped Workbench errors `from None`.

- [ ] Run the complete Task 6 focused and related backend test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_agent_workbench_sync.py tests/test_agent_workbench.py tests/test_coreai.py -q)
~~~

- [ ] Prove the Task 6 production implementation contains no single-Run detail call.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if rg -n 'get_run\(' api/app/agent_workbench.py; then
  exit 1
fi
~~~

- [ ] Stage exactly the two Task 6 files.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/tests/test_agent_workbench_sync.py
~~~

- [ ] Assert the sorted Task 6 staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/agent_workbench.py api/tests/test_agent_workbench_sync.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 6 staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 6 staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 6 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: sync agent workbench state"
~~~

- [ ] Prove the isolated worktree is clean after the Task 6 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Add `test_best_effort_started_run_happy_path`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k best_effort_started_run_happy_path)` and observe RED.
- [ ] Implement one own-connection, committed-source, registered-Agent insert/bind path that increments both `local_event_epoch` and `history_event_epoch` exactly once and tightens `finite_range_proven_start_at` to `max(existing, first_seen_at + 1 microsecond)` for a distinct new Run identity in the same transaction, with NULL remaining NULL.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_happy_path)` and require `unfiltered_proven_event_epoch < history_event_epoch` plus a marker later than the new Run when a prior finite proof exists.
- [ ] Add the absent-registry row to `test_best_effort_started_run_failure_isolation`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and observe RED.
- [ ] Implement the absent-registry no-op without raising.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and require the absent-registry row to pass.
- [ ] Add the source-mismatch row to the failure-isolation test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and observe RED on source mismatch.
- [ ] Implement rollback/no-raise behavior for source mismatch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and require the source-mismatch row to pass.
- [ ] Add the SQLite-exception row with a distinct credential/body sentinel and caplog capture.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and observe RED.
- [ ] Add rollback/no-raise behavior plus a fixed Workbench-owned failure message and sanitized local identifiers without inspecting or stringifying the caught SQLite exception.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and require the SQLite sentinel to be absent from caplog, exception repr, HTTP/background results, and SQLite.
- [ ] Add the projection-exception row with its own distinct sentinel.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and observe RED on projection failure.
- [ ] Extend the fixed sanitized failure path to arbitrary projection exceptions without inspecting or stringifying them.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_failure_isolation)` and require PASS with every sentinel absent.
- [ ] Add the missing-status row to `test_statusless_accepted_run_persists_confirmation_marker`, starting from exact idle/history zero and reopening SQLite for readback.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and observe RED.
- [ ] Implement the NULL-status marker transaction and static aggregate signal without inventing a raw status.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and require one source-bound row with `raw_status=NULL`, `LOCAL_TRIGGER_STATUS_MISSING`, no upstream-derived fields, both event epochs incremented once, lagging `unfiltered_proven_event_epoch`, unknown known-bucket qualities, discovery due now, mirrored count 1, effective remote total NULL, and no 1/0 coverage.
- [ ] Add the blank-status row to the same statusless test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and observe RED if blank status is not normalized to the marker path.
- [ ] Normalize blank trigger status to the existing NULL-status marker path.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and require the blank row to pass.
- [ ] Add the non-string-status row to the same statusless test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and observe RED if the value bypasses the marker path.
- [ ] Normalize non-string trigger status to the existing NULL-status marker path.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and require the non-string row to pass.
- [ ] Add an idempotent helper-replay row to the statusless test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and observe RED if replay inserts twice or increments either event epoch twice.
- [ ] Make the NULL-status marker transaction idempotent for the same Run identity.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_statusless_accepted_run_persists_confirmation_marker)` and require PASS.
- [ ] Add the PENDING row to `test_local_nonterminal_invalidates_exact_idle`, requiring the unconfirmed row to invalidate current proof and effective history coverage.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and observe RED.
- [ ] Implement atomic PENDING-bucket quality invalidation and due-now scheduling while preserving lifecycle `sync_pending`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and require the PENDING row to pass.
- [ ] Add the RUNNING row to the same non-terminal test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and observe RED on RUNNING invalidation.
- [ ] Extend atomic quality invalidation and due-now scheduling to RUNNING.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and require the RUNNING row to pass.
- [ ] Add the PAUSED row to the same non-terminal test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and observe RED on PAUSED invalidation.
- [ ] Extend atomic quality invalidation and due-now scheduling to PAUSED.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and require the PAUSED row to pass.
- [ ] Add the unknown-status row to the same non-terminal test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and observe RED on unresolved counting.
- [ ] Implement idempotent unresolved counting and all-bucket invalidation for the unknown status while preserving lifecycle `sync_pending`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_nonterminal_invalidates_exact_idle)` and require PASS.
- [ ] Add the disabled/future-deadline RUNNING row to `test_inactive_lifecycle_running_acceptance_preserves_archival_cadence`, requiring the row to persist while `next_fast_poll_at` remains NULL and `next_discovery_at` is not accelerated or postponed.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and observe RED.
- [ ] Implement the lifecycle gate for known-status accepted Runs: active PENDING/RUNNING may become due now, while a disabled owner uses `min(existing_next_discovery_at, observed_at + lifecycle_interval)`, clears no lifecycle field, and never schedules a fast poll.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and require the disabled/future row to pass.
- [ ] Add the disabled/earlier-deadline RUNNING row to the same lifecycle test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and observe RED if the earlier deadline is postponed.
- [ ] Preserve an earlier disabled lifecycle deadline through the existing `min` scheduler.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and require both disabled rows to pass.
- [ ] Add the retired/future-deadline RUNNING row to the lifecycle test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and observe RED on retired handling.
- [ ] Extend the non-active known-status lifecycle gate to retired owners, treating NULL as the lifecycle deadline.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and require the retired/future row to pass.
- [ ] Add the retired/earlier-deadline RUNNING row to the lifecycle test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and observe RED if the earlier deadline is postponed.
- [ ] Preserve an earlier retired lifecycle deadline through the same `min` scheduler.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_running_acceptance_preserves_archival_cadence)` and require PASS.
- [ ] Add the disabled/future-deadline missing-status row to `test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence`, requiring the durable NULL-status marker, static signal, UNKNOWN blocker, unchanged `sync_pending`, no motion, and no fast poll.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and observe RED.
- [ ] Route the disabled missing-status branch through the archival scheduler without activating the owner or setting `sync_pending`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and require the disabled/future row to pass.
- [ ] Add the disabled/overdue-deadline missing-status row to the same test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and observe RED if the overdue deadline changes.
- [ ] Preserve an already overdue disabled deadline for the normal archival worker.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and require both disabled rows to pass.
- [ ] Add the retired/future-deadline missing-status row to the same test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and observe RED on retired statusless handling.
- [ ] Route the retired missing-status branch through the same archival scheduler without activating the owner or setting `sync_pending`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and require the retired/future row to pass.
- [ ] Add the retired/overdue-deadline missing-status row to the same test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and observe RED if the overdue deadline changes.
- [ ] Preserve an already overdue retired deadline for the normal archival worker.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_inactive_lifecycle_statusless_acceptance_preserves_archival_cadence)` and require PASS.
- [ ] Add the COMPLETED row to `test_local_terminal_status_is_unconfirmed_without_receipt`, requiring exact raw status, immutable `terminal_observed_at=observed_at`, NULL trigger/list fields and Tokens, no receipt, unknown current buckets, discovery due now, unusable old history total, and static/no-motion presentation.
- [ ] Add the FAILED row to the same terminal-status test with the same expected evidence and presentation contract.
- [ ] Add the TIMEOUT row to the same terminal-status test with the same expected evidence and presentation contract.
- [ ] Add the CANCELLED row to the same terminal-status test with the same expected evidence and presentation contract.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)` and observe RED.
- [ ] Implement the immediate terminal-outcome branch while keeping an associated still-running local source as static unconfirmed archiving evidence and creating no receipt.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)` and require the four outcome rows to pass.
- [ ] Add the SKIPPED row to the same terminal-status test with the same unconfirmed/no-receipt contract.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)` and observe RED on SKIPPED handling.
- [ ] Extend the immediate-terminal branch to SKIPPED without marking upstream freshness.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_local_terminal_status_is_unconfirmed_without_receipt)` and require PASS.
- [ ] Add `test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt`, first feeding post-event exact-zero and then the same terminal ID/status in a valid page.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt)` and observe RED at list-confirmation/coverage restoration.
- [ ] Implement compatible exact-ID terminal confirmation, `last_synced_at`/trigger/Token fill, and consistent-unfiltered coverage restoration while receipt stays NULL.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_exact_list_id_confirms_immediate_terminal_without_restarting_receipt)` and require PASS.
- [ ] Add `test_conflicting_list_terminal_confirms_identity_without_hybrid_payload`, starting with an immediate COMPLETED marker and then returning its exact ID as FAILED in a valid list page.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_conflicting_list_terminal_confirms_identity_without_hybrid_payload)` and observe RED.
- [ ] Separate valid exact-ID list-confirmation metadata from the immutable authoritative terminal payload.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_conflicting_list_terminal_confirms_identity_without_hybrid_payload)` and require non-NULL `last_synced_at`, cleared `LOCAL_RUN_UNCONFIRMED`, unchanged original COMPLETED payload tuple/NULL receipt, and retained `TERMINAL_STATUS_CONFLICT`.
- [ ] Add the RUNNING row to `test_best_effort_started_run_fences_older_discovery_result`, blocking an exact-zero cycle before commit, invoking the real helper after its source transaction commits, and releasing the old cycle.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and observe RED until the Task 6 event barrier is exercised end to end.
- [ ] Wire the helper's RUNNING event epoch into the existing Task 6 commit barrier.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and require uncertain/static presentation plus idle forbidden after the old commit.
- [ ] Add the missing-status trigger row to the older-discovery test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and observe RED if the NULL marker escapes the barrier.
- [ ] Wire the helper's missing-status event epoch into the same commit barrier.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and require both rows to remain uncertain/static with idle forbidden.
- [ ] Add a post-event exact-zero cycle to the RUNNING older-discovery row.
- [ ] Add a post-event exact-zero cycle to the missing-status older-discovery row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and require both Runs to remain unconfirmed.
- [ ] Add a valid page containing the exact Run ID to the RUNNING older-discovery row.
- [ ] Add a valid page containing the exact Run ID to the missing-status older-discovery row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_best_effort_started_run_fences_older_discovery_result)` and require only exact-ID observation to restore current truth and fill the real non-empty status for the missing-status row.
- [ ] Add `test_runs_start_run_registers_after_commit`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_runs_start_run_registers_after_commit)` and observe RED.
- [ ] Add the one post-commit `runs.py` hook.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_runs_start_run_registers_after_commit)` and require PASS; complete call-site regressions remain at this Task's checkpoint.
- [ ] Add `test_task_execute_registers_after_commit`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_task_execute_registers_after_commit)` and observe RED.
- [ ] Add the one post-commit `tasks.py` hook.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_task_execute_registers_after_commit)` and require PASS; complete call-site regressions remain at this Task's checkpoint.
- [ ] Add `test_keyword_skill_artifact_registers_after_commit`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_keyword_skill_artifact_registers_after_commit)` and observe RED.
- [ ] Return the inserted artifact ID from the keyword-skill path.
- [ ] Add the first post-commit `seo_targets.py` hook.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_keyword_skill_artifact_registers_after_commit)` and require PASS; complete call-site regressions remain at this Task's checkpoint.
- [ ] Add `test_chained_audit_ranking_artifact_registers_after_commit`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_chained_audit_ranking_artifact_registers_after_commit)` and observe RED.
- [ ] Add the second artifact hook without another trigger.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_chained_audit_ranking_artifact_registers_after_commit)` and require PASS; complete scheduler/SEO-target regressions remain at this Task's checkpoint.
- [ ] Add the `runs.py` row to `test_normalized_trigger_identity_reaches_every_source_and_projection`, using the real Task 2 client boundary with a padded valid ID/status and asserting one trimmed committed-source/helper handoff.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_normalized_trigger_identity_reaches_every_source_and_projection)` and require PASS.
- [ ] Add the `tasks.py` row to the normalized-identity test.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_normalized_trigger_identity_reaches_every_source_and_projection)` and require PASS.
- [ ] Add the keyword-skill artifact row to the normalized-identity test.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_normalized_trigger_identity_reaches_every_source_and_projection)` and require PASS.
- [ ] Add the chained audit-ranking artifact row to the normalized-identity test.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_normalized_trigger_identity_reaches_every_source_and_projection)` and require PASS.
- [ ] Add the `runs.py` non-string/blank-ID row to `test_invalid_trigger_identity_never_reaches_source_or_projection`, requiring stable failure-or-dispatch-unknown behavior, zero invalid `coreai_run_id` writes, zero helper calls, and exactly one upstream POST.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_invalid_trigger_identity_never_reaches_source_or_projection)` and require PASS.
- [ ] Add the `tasks.py` non-string/blank-ID row to the invalid-identity test.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_invalid_trigger_identity_never_reaches_source_or_projection)` and require PASS.
- [ ] Add the keyword-skill artifact non-string/blank-ID row to the invalid-identity test.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_invalid_trigger_identity_never_reaches_source_or_projection)` and require PASS.
- [ ] Add the chained audit-ranking artifact non-string/blank-ID row to the invalid-identity test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py tests/test_runs_api.py tests/test_tasks.py tests/test_seo_targets.py tests/test_scheduler.py -q)` and require the invalid-identity selection plus all existing call-site regressions to pass.
- [ ] Add the `runs.py` row to `test_projection_failure_never_retries_external_trigger`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and observe RED.
- [ ] Add `runs.py` call-site isolation around the helper only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and require exactly one Core AI trigger.
- [ ] Add the `tasks.py` row to the projection-failure test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and observe RED on the task path.
- [ ] Add `tasks.py` call-site isolation around the helper only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and require exactly one Core AI trigger per covered case.
- [ ] Add the keyword-skill artifact row to the projection-failure test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and observe RED on the first artifact path.
- [ ] Add first-artifact call-site isolation around the helper only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and require exactly one Core AI trigger per covered case.
- [ ] Add the chained audit-ranking artifact row to the projection-failure test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and observe RED on the second artifact path.
- [ ] Add second-artifact call-site isolation around the helper only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_triggers.py -q -k test_projection_failure_never_retries_external_trigger)` and require PASS with exactly one Core AI trigger per case.
- [ ] Add `test_import_and_create_app_perform_zero_database_io`, using a fresh subprocess with `SEO_OPS_DB` at a nonexistent path, importing `app.main`, calling `create_app` with a no-op lifespan, and asserting no database/file/open hook occurs.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_import_and_create_app_perform_zero_database_io)` and observe RED against the current import-time `init_db()`.
- [ ] Move `init_db` plus seed/prime into `initialize_writable_application` and leave module import/application construction pure.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_import_and_create_app_perform_zero_database_io)` and require PASS.
- [ ] Add `test_lifespan_seeds_primes_then_starts_all_three_loops`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_seeds_primes_then_starts_all_three_loops)` and observe RED.
- [ ] Inject the writable startup callable into the lifespan.
- [ ] Inject the three named loop callables into the lifespan.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_seeds_primes_then_starts_all_three_loops)` and require schema initialization, seed, and prime to complete before any loop starts.
- [ ] Add the normal-shutdown row to `test_lifespan_cancels_and_awaits_all_three_loops`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` and observe RED.
- [ ] Implement cancellation plus `gather(..., return_exceptions=True)` for all three tasks.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` and require all three normal finalizers to finish.
- [ ] Add the row where one loop finalizer raises while the other two still finish.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` and observe RED if either sibling finalizer is skipped.
- [ ] Preserve sibling finalizer completion when `gather(..., return_exceptions=True)` captures one finalizer failure.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k lifespan_cancels_and_awaits_all_three_loops)` and require PASS.
- [ ] Add `test_app_factory_preserves_routes_with_injected_lifespan`, comparing injected and production route/dependency sets.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_app_factory_preserves_routes_with_injected_lifespan)` and observe RED.
- [ ] Centralize router/dependency construction in `create_app` without an environment disable switch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_app_factory_preserves_routes_with_injected_lifespan)` and require PASS.
- [ ] Add `test_workbench_routes_require_operator` for every unauthenticated Workbench route.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_workbench_routes_require_operator)` and observe RED on any unprotected route.
- [ ] Wire the existing operator dependency to every Workbench route.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_main.py -q -k test_workbench_routes_require_operator)` and require PASS.

**Contract reference 7A: Best-effort helper**

Assert the helper opens its own connection, requires an existing registered exact Core AI Agent of any lifecycle, validates the committed source row/run-ID match, derives merchant_id, and inserts or fills the association idempotently. If registry is absent, the source is uncommitted/mismatched, SQLite fails, or projection logic raises, assert the helper returns None, rolls back its own transaction, logs a bounded diagnostic, and never raises to the caller. The diagnostic contains only a stable code, sanitized local Agent/Run/source identifiers, and a fixed Workbench-owned operator message; arbitrary caught-exception text is never inspected or stringified. Inject credentials, Bearer/header text, query secrets, and raw body text into the failure and prove none appears in caplog, result objects, exception repr, or SQLite.

Treat a missing, blank, or non-string trigger-response status as an accepted event with unknown current bucket, not as a no-op, coerced scalar, or invented raw status. After validating the registry and committed source, use one transaction to insert the exact accepted Run ID in `seo_ops_agent_runs` with `raw_status=NULL`, the immutable source association, local `first_seen_at`, and `LOCAL_TRIGGER_STATUS_MISSING`; leave all upstream-derived fields NULL. In that same distinct-new-ID transaction increment both `local_event_epoch` and `history_event_epoch`, leave `unfiltered_proven_event_epoch` behind, tighten a non-NULL `finite_range_proven_start_at` to at least `first_seen_at + 1 microsecond`, set PENDING/RUNNING/PAUSED qualities to unknown, set `current_state_complete=0`, and preserve prior observed counts/times plus lifecycle-owned `sync_pending`. The row itself is the durable confirmation barrier: every later proof includes UNKNOWN and forbids idle until a valid parsed list page contains that exact ID. It also invalidates the effective all-history denominator and every currently selectable finite-range proof that contains the new event while preserving a narrower prior proof for future ranges, so mirrored 1 can never be presented as 1/0. A valid page that omits it—including a post-event exact-zero four-list cycle—may refresh bounded observations but cannot delete the marker, clear UNKNOWN, claim complete current truth, restore all-history coverage, or show idle; a later unfiltered window may establish only a new finite boundary strictly after the marker's factual effective start under Task 6I. For an active owner, set `next_discovery_at=now`; after that immediate attempt, an unresolved marker uses the ordinary no-later-than-30-second full-discovery cadence and never fabricates a five-second active status. For disabled/retired owners, persist and expose the same marker but never accelerate to an active cadence: keep `next_fast_poll_at=NULL` and set `next_discovery_at=min(existing_next_discovery_at, observed_at + 15 minutes/24 hours)` with NULL treated as that lifecycle deadline. An existing earlier or overdue archival deadline is preserved. In every lifecycle the aggregate immediately shows a selectable static `状态待确认（上游未返回状态）` signal; the event never re-enables the Agent, sets `sync_pending`, or enables motion.

Start from a fresh exact-idle/history proof with observed running/queued/waiting counts and upstream/mirrored totals all zero and `sync_pending=0`. Register local PENDING, RUNNING, PAUSED, each known terminal/SKIPPED, missing-status, and unknown-future triggers in separate cases. In the same transaction as each distinct new projection, increment both `local_event_epoch` and `history_event_epoch` exactly once, leave `unfiltered_proven_event_epoch` behind, tighten any existing `finite_range_proven_start_at` past the new row's factual effective start, and assert the matching known non-terminal bucket—or all three for terminal/SKIPPED/missing/unknown status—becomes `unknown` and `current_state_complete=0`, while its last observed zero/count/remote-total timestamp and the existing lifecycle-owned `sync_pending=0` remain intact. At immediate readback every new `last_synced_at=NULL` row falls inside the selected recent range, so it forces effective remote total NULL and history/range/metrics incomplete; never overwrite the persisted last observation and never expose mirrored 1 over remote 0. After the row ages outside a finite range, the tightened durable marker may make that range complete once a latest due discovery succeeds; the all-history denominator and idle barrier remain qualified. An idempotent helper replay for the same already-associated Run must not increment either epoch or change the marker. For an active owner, PENDING/RUNNING set `next_fast_poll_at=now`; PAUSED, terminal/SKIPPED, missing status, and unknown status set `next_discovery_at=now` because they require full proof. For a disabled or retired owner, every status instead leaves `next_fast_poll_at=NULL` and keeps the earlier of its existing archival due time and `observed_at + DISABLED_DISCOVERY_SECONDS/RETIRED_DISCOVERY_SECONDS`; it never receives active-speed confirmation, becomes active, or sets `sync_pending`. A newly opened aggregate must show each accepted non-terminal/unknown Run as uncertain/static, never an exact-zero bucket or exact idle. For a known immediate terminal, persist exact raw status and immutable `terminal_observed_at=observed_at`, leave upstream timestamps/trigger/Tokens/last_synced_at NULL, and assign no receipt because no previously list-confirmed non-terminal state or valid recent completed_at exists. It may appear only as static unconfirmed archiving when its associated local source remains running; it is never fresh or animated. A later lifecycle-eligible cycle restores complete current proof only after it starts with the current event epoch and a valid page actually observes that Run ID, possibly in a later terminal state; both pre-event and post-event exact-zero responses leave an unobserved row uncertain. Historical coverage additionally requires a consistent updated unfiltered total/page under Task 5, so filtered confirmation alone cannot resurrect a stale 0 denominator. An unknown future non-empty trigger status likewise invalidates current-state completeness and participates in `unresolved_unknown_status_count`. Compute that count from distinct projected rows whose raw status is NULL or unmapped without double-counting an idempotent call. Every immediate projection stores `trigger_type=NULL`; the first valid list response fills the actual trigger type and list-derived fields, fills a NULL raw status with the exact returned status, and clears only `LOCAL_TRIGGER_STATUS_MISSING`; it never moves `terminal_observed_at` or retroactively creates a receipt for an immediate-terminal row. `sync_pending` remains reserved for a new/replaced/re-enabled registry owner awaiting its first complete proof; ordinary Run confirmation does not repurpose it.

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

**Implementation reference 7D: Helper and four narrow hooks**

Capture accepted run_id/status in the existing success branch, commit the business connection, and only then invoke the helper. Wrap the call site too, so even an accidental future helper regression cannot convert an accepted external write into a retryable local failure. The helper's distinct-new-ID transaction increments both event epochs; an idempotent replay changes neither and must reread the still-dirty history proof state.

Consume Task 2's already normalized trigger result: `run_id` is a trimmed non-empty string and `status` is either trimmed non-empty text or `None`. Keep a defensive helper type check, but do not independently normalize to a different identity. For a non-null status use that exact returned text, including an unknown future value. For `None`, insert the same accepted Run ID with nullable raw status and `LOCAL_TRIGGER_STATUS_MISSING` as Contract 7A specifies; never call `str` on an upstream value. The committed source association and durable marker let normal discovery repair the row without inventing upstream truth. Never mark local registration fresh enough for motion: every immediate projection sets `first_seen_at` while `trigger_type` and `last_synced_at` stay NULL until a valid list response confirms that exact Run ID. Atomically invalidate the affected exact current-state claim as specified in Contract 7A, and combine Task 6's local-event epoch fence with the durable unconfirmed row so neither an older response nor a newer exact-zero cycle can restore idle before confirmation.

**Contract reference 7E: Lifespan, application factory, and authentication**

Importing `app.main`, evaluating the production singleton, and calling `create_app` must perform zero filesystem/database I/O. A fresh subprocess with `SEO_OPS_DB` aimed at a nonexistent file proves import/construction does not create it. All writable setup moves into `initialize_writable_application`, invoked only when the production/writable lifespan enters: call `init_db()` first, then connect, seed, prime, commit, and close before either loop starts.

Inject the writable startup plus event-recording `scheduler_loop`, `fbr_scheduler_loop`, and Workbench coroutines into `create_lifespan` and enter the resulting FastAPI lifespan. Assert schema initialization and local seeding complete before any task starts. On exit, assert all three tasks receive cancellation and all three finalizers run. A task that raises during shutdown must not prevent awaiting either peer. `create_app` owns all production router includes and dependency lists exactly once; the production singleton and Task 11's live-gate/restart apps all call this factory, so the safety harness cannot silently lose auth, lose the existing Local Falcon scheduler, or gain a test-only mutation route.

Also request every Workbench route without an operator session and assert 401; with the existing logged-in fixture, assert the aggregate route is reachable even when Core AI credentials are absent.

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

- [ ] Run the Task 7 lifecycle/trigger-hook test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_main.py tests/test_agent_workbench_triggers.py -q)
~~~

- [ ] Run the Task 1-6 Workbench backend regression gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_config.py tests/test_db.py tests/test_coreai.py tests/test_agent_workbench.py tests/test_agent_workbench_sync.py -q)
~~~

- [ ] Run the existing dispatch/scheduler regression gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd api && .venv/bin/python -m pytest tests/test_runs_api.py tests/test_tasks.py tests/test_seo_targets.py tests/test_scheduler.py -q)
~~~

- [ ] Stage exactly the seven Task 7 files.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- api/app/agent_workbench.py api/app/runs.py api/app/tasks.py api/app/seo_targets.py api/app/main.py api/tests/test_agent_workbench_triggers.py api/tests/test_main.py
~~~

- [ ] Assert the sorted Task 7 staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' api/app/agent_workbench.py api/app/main.py api/app/runs.py api/app/seo_targets.py api/app/tasks.py api/tests/test_agent_workbench_triggers.py api/tests/test_main.py | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 7 staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 7 staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 7 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: wire agent workbench updates"
~~~

- [ ] Prove the isolated worktree is clean after the Task 7 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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
- Produces: createPresentationState(), `advancePresentation(state, nowMonotonicMs, reason: PresentationAdvanceReason)`, `replacePresentationSnapshot(state, snapshot, receivedAtMonotonicMs, reason: SnapshotReplacementReason)`, reconcileSignalSelection(), diffWorkbenchEvents(), and formatCompactNumber(), where `PresentationAdvanceReason = 'clock' | 'hidden' | 'focus' | 'pause' | 'manual' | 'resume' | 'mutation'` and `SnapshotReplacementReason = 'initial' | 'automatic' | 'manual' | 'visibility' | 'focus' | 'resume' | 'range' | 'mutation'`.
- Produces: PresentedWorkbench.current_counts as the only UI-facing current-claim source, with derived quality/copy and running-owner eligibility; the immutable raw snapshot remains available only for persisted facts and selected-range history metrics.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `getAgentWorkbench sends range and AbortSignal`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t 'getAgentWorkbench sends range and AbortSignal')` and observe RED.
- [ ] Add only the Workbench snapshot types and aggregate GET.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "getAgentWorkbench sends range and AbortSignal")` and require PASS.
- [ ] **GREEN characterization:** Add `aggregate preserves statusless signal shape` with one `raw_status:null` signal/history fixture, server `presentation_group:'unknown'`, and `token_state:'unconfirmed'`; assert exact object equality and TypeScript access without a client-side status mapper.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "aggregate preserves statusless signal shape")` and require PASS; this is contract preservation, not a claimed RED.
- [ ] Add `history URL encodes path and cursor`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "history URL encodes path and cursor")` and observe RED.
- [ ] Implement the abortable history GET with URLSearchParams.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "history URL encodes path and cursor")` and require PASS.
- [ ] Add `registerAgent sends strict body`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "registerAgent sends strict body")` and observe RED.
- [ ] Implement only POST register.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "registerAgent sends strict body")` and require PASS.
- [ ] Add `updateAgent sends encoded id and strict body`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "updateAgent sends encoded id and strict body")` and observe RED.
- [ ] Implement only PATCH update.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "updateAgent sends encoded id and strict body")` and require PASS.
- [ ] Add `retireAgent sends zero-byte body`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "retireAgent sends zero-byte body")` and observe RED.
- [ ] Implement only bodyless POST retire.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "retireAgent sends zero-byte body")` and require PASS.
- [ ] Add `replaceAgent sends encoded id and strict body`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "replaceAgent sends encoded id and strict body")` and observe RED.
- [ ] Implement only POST replace.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "replaceAgent sends encoded id and strict body")` and require PASS.
- [ ] Add the legacy-string row to `structured and legacy API errors`.
- [ ] Add the valid plain-object string-map row to the same API-error test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and observe RED on structured parsing.
- [ ] Implement the backward-compatible ApiError parser for legacy detail strings and plain-object string maps.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and require those rows to pass.
- [ ] Add the valid null-prototype string-map row to the API-error test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and observe RED if it is rejected.
- [ ] Extend `isStringRecord` to accept null-prototype string maps.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and require the null-prototype row to pass.
- [ ] Add the array-valued `fields` rejection row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and observe RED if the array is retained.
- [ ] Reject array-valued `fields` to an empty map.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and require the array row to pass.
- [ ] Add the Date-valued non-record `fields` rejection row.
- [ ] Add the prototype-bearing non-record `fields` rejection row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and observe RED on the first prototype rejection.
- [ ] Reject non-plain prototype-bearing `fields` values to an empty map.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and require both prototype rows to pass.
- [ ] Add the scalar-value-in-map `fields` rejection row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and observe RED if the non-string value survives.
- [ ] Reject any `fields` map containing a non-string value.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchApi.test.ts -t "structured and legacy API errors")` and require PASS.
- [ ] Run the complete Task 8 transport test file and require PASS before presentation work.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts)
~~~

- [ ] Stage exactly the two Task 8 transport files.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/api.ts web/src/agentWorkbenchApi.test.ts
~~~

- [ ] Assert the sorted Task 8 transport staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' web/src/agentWorkbenchApi.test.ts web/src/api.ts | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 8 transport staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 8 transport staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 8 transport patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: add agent workbench client contract"
~~~

- [ ] Prove the isolated worktree is clean after the Task 8 transport commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
~~~

- [ ] Add the aligned-clock row to `snapshot clock aligns monotonically`.
- [ ] Add the negative-drift row to the same snapshot-clock test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t 'snapshot clock aligns monotonically')` and observe RED.
- [ ] Implement `SnapshotClock` and `alignedEpochMs` with negative monotonic drift clamped at zero.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot clock aligns monotonically")` and require the aligned-clock rows to pass.
- [ ] Add the `signalElapsedSeconds` row with the non-null first-seen invariant to the same clock test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot clock aligns monotonically")` and observe RED on elapsed time.
- [ ] Implement `signalElapsedSeconds` from the aligned monotonic delta with a non-null result.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot clock aligns monotonically")` and require PASS.
- [ ] Add `compact number formatting`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "compact number formatting")` and observe RED.
- [ ] Implement only the frozen Intl helper.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "compact number formatting")` and require PASS.
- [ ] Add `aggregate deadline downgrades exact zero current claims`, requiring PresentedWorkbench current quality/copy to become unknown and idle eligibility false at `fresh_until` while the raw snapshot stays exact zero.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact zero current claims")` and observe RED.
- [ ] Implement the immutable PresentedWorkbench current-count copy plus exact-zero downgrade only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact zero current claims")` and require PASS without mutating the API snapshot.
- [ ] Add `aggregate deadline downgrades exact positive current claims`, requiring removal of current-tense and exact-owner eligibility while retaining last-confirmed evidence.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact positive current claims")` and observe RED.
- [ ] Implement only the exact-positive downgrade branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades exact positive current claims")` and require PASS.
- [ ] Add `aggregate deadline downgrades lower-bound current claims`, requiring `至少 N` to disappear while raw lower-bound data stays unchanged.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades lower-bound current claims")` and observe RED.
- [ ] Implement only the lower-bound downgrade branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "aggregate deadline downgrades lower-bound current claims")` and require PASS.
- [ ] Add `focus advance synchronously downgrades cached presentation`, table-driven over a fresh exact-idle snapshot and a fresh exact-positive RUNNING snapshot eligible for motion. Deep-freeze each API snapshot, call `advancePresentation(state, nowMonotonicMs, 'focus')` before any replacement response, and require presented current qualities unknown, convenience booleans NULL, idle ineligible, every signal static, and the raw snapshot byte-for-byte unchanged.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "focus advance synchronously downgrades cached presentation")` and observe RED while either cached idle/current wording or RUNNING motion survives.
- [ ] Add `PresentationAdvanceReason` and route `focus` through the same immutable presentation-only current/idle/motion downgrade as hidden interruption after applying elapsed receipt/freshness deadlines at the supplied monotonic time; it cannot restore freshness or mutate the API snapshot.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "focus advance synchronously downgrades cached presentation")` and require PASS for both exact-idle and RUNNING fixtures.
- [ ] Add the RUNNING row to `suspect deadline changes only presentation truth`, placing `suspect_at` 250ms after an elapsed tick.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")` and observe RED.
- [ ] At the exact aligned RUNNING deadline, mark the presented signal uncertain/suspect/static and downgrade its current claim while preserving raw status and immutable API snapshot fields.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")` and require the RUNNING row to pass.
- [ ] Add the PENDING `suspect_at` row at the same 250ms boundary.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")` and observe RED on PENDING.
- [ ] Extend the suspect presentation downgrade to PENDING.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")` and require both active rows to pass.
- [ ] Add the old-PAUSED row to the same suspect-deadline test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "suspect deadline changes only presentation truth")` and require PAUSED to have no suspect deadline.
- [ ] Add `signal deadlines gate motion independently`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "signal deadlines gate motion independently")` and observe RED.
- [ ] Implement per-signal local freshness without mutating aggregate facts.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "signal deadlines gate motion independently")` and require PASS.
- [ ] Add the running-clock expiry row to `receipt expires automatically but freezes while paused`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and observe RED at expiry.
- [ ] Implement running-clock receipt expiry.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and require the running-clock row to pass.
- [ ] Add the paused-clock retention row to the same receipt test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and observe RED if the receipt disappears while paused.
- [ ] Freeze the presentation clock while paused.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and require the paused retention row to pass.
- [ ] Add the resume-expiry row to the same receipt test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and observe RED if elapsed real time is ignored after resume.
- [ ] Resume the presentation clock from actual aligned time.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "receipt expires automatically but freezes while paused")` and require PASS.
- [ ] Add `snapshot replacement never replays receipt entrance`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot replacement never replays receipt entrance")` and observe RED.
- [ ] Implement seen-receipt bookkeeping.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "snapshot replacement never replays receipt entrance")` and require PASS.
- [ ] Add the surviving-selection row to `selection reconciliation reports removal`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and observe RED.
- [ ] Implement the pure surviving-selection result with `selectedWasRemoved=false`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and require the surviving row to pass.
- [ ] Add the next-index selection row to the same reconciliation test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and observe RED on removed selection.
- [ ] Implement next-index selection with `selectedWasRemoved=true`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and require the next-index row to pass.
- [ ] Add the preceding-final-item selection row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and observe RED when no next index exists.
- [ ] Implement the preceding-final-item fallback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and require the previous-item row to pass.
- [ ] Add the no-signals removal row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and observe RED on empty fallback.
- [ ] Implement the no-selection result with `selectedWasRemoved=true` and `focusStageHeading=true`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and require the no-signals row to pass.
- [ ] Add the pause-preserves-selection row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and observe RED if pause returns a focus request or changes selection.
- [ ] Implement pause preservation with no focus request; keep DOM focus in Task 9.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "selection reconciliation reports removal")` and require PASS.
- [ ] Add the newly discovered Run row to `workbench event diff is semantic only`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and observe RED.
- [ ] Implement only the newly discovered Run announcement branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require the discovery row to pass.
- [ ] Add the raw-status-becomes-terminal row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and observe RED on terminal transition.
- [ ] Implement only the terminal-transition announcement branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require the terminal row to pass.
- [ ] Add the aggregate-freshness-lost row.
- [ ] Add the aggregate-freshness-restored row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and observe RED on the first freshness transition.
- [ ] Implement only the aggregate freshness transition announcement branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require both freshness rows to pass.
- [ ] Add the manual-refresh-completion row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and observe RED on manual completion.
- [ ] Implement only the manual-refresh-completion announcement branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require the manual row to pass.
- [ ] Add the successful run-ID-copy row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and observe RED on copy success.
- [ ] Implement only the successful run-ID-copy announcement branch.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require the copy row to pass.
- [ ] **GREEN characterization:** Add the timer-tick row that expects no announcement.
- [ ] **GREEN characterization:** Add the relative-wording row that expects no announcement.
- [ ] **GREEN characterization:** Add the row-expansion row that expects no announcement.
- [ ] **GREEN characterization:** Add the unchanged-snapshot row that expects no announcement.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchPresentation.test.ts -t "workbench event diff is semantic only")` and require PASS for all five semantic event branches and all non-event rows.

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

**Implementation reference 8C: Transport slice isolation**

The mandatory split slices above commit `api.ts` and `agentWorkbenchApi.test.ts` before presentation work begins. Do not restage or recommit those files in Task 8's later presentation commit.

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

`PresentedWorkbench.current_counts` is the only current-count input allowed in `LiveRunStage` and the current portion of `AgentSummaryMetrics`. Each presented bucket carries the derived `quality`, display evidence, `claim_is_current`, and—for running only—`exact_owner_claim_allowed`. At an aggregate deadline, signal deadline, suspect deadline, hide, visible-window focus restoration, mutation-success barrier, or pause transition, derive an unknown/non-current copy before rendering: preserve the last observed value/time only as historical evidence, clear exact/lower-bound current wording and owner eligibility, make every signal static, and make idle ineligible. `snapshot.current_counts` stays byte-for-byte immutable and must not be read by either component for a current-tense headline/card. Historical range summary and coverage continue to read the immutable snapshot.

Treat each future PENDING/RUNNING `suspect_at` as an equally exact local downgrade deadline. At the boundary, without mutating the API snapshot, set only the presented signal's `suspect=true`, `suspect_reason=超过本地状态待确认阈值`, `signal_state='uncertain'`, `fresh=false`, and motion eligibility false; downgrade the owning/aggregate current claim to unknown snapshot wording and preserve `raw_status`, times, Tokens, and history. PAUSED/terminal/archiving/unknown signals have no suspect deadline. Test a threshold 250ms after the preceding one-second tick so the reducer cannot wait for the next tick or network request.

Add explicit exact-positive and lower-bound fixtures so neither continues to say `当前 N` or `至少 N` after expiry. The aggregate boundary revokes every aggregate current claim and exact-idle wording; each signal's own boundary independently controls that signal's motion. One stale Agent or an expired aggregate boundary must not suppress another Agent whose signal and owning-Agent proof remain fresh. Metadata-only verification warnings do not revoke a separately fresh complete list proof. Hidden/focus-restored cached state is immediately presentation-stale until a new successful fetch.

**Contract reference 8F: Receipt, pause, and replacement**

While auto update is enabled and visible, filter a receipt at receipt_expires_at without a network response. At pause time, freeze the monotonic clock: a visible receipt remains selected past nominal expiry, its copy becomes absolute-time snapshot wording, and all motion is false. Resume or manual refresh first evaluates expiry against actual aligned time, removes expired receipts, and never adds their IDs back to entrance animation.

replacePresentationSnapshot accepts one of initial, automatic, manual, visibility, focus, resume, range, or mutation reasons. It records receipt IDs already presented so refresh/focus/resume/range/mutation readback cannot replay the optional entrance transition. A failed fetch leaves the prior state downgraded and cannot move its snapshot clock forward. Only acceptance of a successful response begun after the corresponding focus or mutation barrier may restore freshness removed for that reason.

**Contract reference 8G: Deterministic selection and event diff**

Initial selection is the newest signal by effective_started_at/coreai_run_id. Refresh preserves a selected ID if it remains and returns `selectedWasRemoved=false`. If the selected tab is removed, choose the item now occupying its old index, otherwise the preceding final item, and return `selectedWasRemoved=true`; if none remain return the same removal fact plus `focusStageHeading=true`. The pure reducer must not return `focusSelectedTab`, because it cannot know whether that DOM tab owned focus. Pause preserves selection and returns no focus request. Left/right roving focus wraps through tabs but selection changes only through the tabs interaction contract.

diffWorkbenchEvents announces only:

- newly discovered Run;
- raw status becoming terminal;
- aggregate freshness lost/restored;
- manual refresh completion;
- successful run-ID copy.

It must not announce one-second ticks, relative-time wording changes, row expansion, or unchanged polling snapshots.

**Implementation reference 8H: Pure presentation reducer**

Keep the API snapshot immutable. Return derived `current_counts`, signals, current-copy/owner eligibility, and idle eligibility in a separate PresentedWorkbench object. `advancePresentation` takes the explicit `PresentationAdvanceReason`; `focus` and `mutation` first apply elapsed receipt/freshness deadlines at the provided monotonic time and then force the cached current/idle/motion presentation stale, even when `fresh_until` has not elapsed. Manual pause stores pausedAtMonotonicMs; automatic visible mode uses the caller's current monotonic value. Receipt removal and fresh_until downgrade use alignedEpochMs, never Date.now after the snapshot is accepted. Add a reducer invariant test that deep-freezes the raw snapshot and proves all aggregate/signal/suspect/hide/focus/mutation/pause downgrades update only PresentedWorkbench.

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

- [ ] Run the complete Task 8 API/presentation test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts src/agentWorkbenchPresentation.test.ts)
~~~

- [ ] Run frontend lint against the Task 8 implementation and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run lint)
~~~

- [ ] Stage exactly the two remaining Task 8 presentation files; do not restage either transport file.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/agentWorkbenchPresentation.ts web/src/agentWorkbenchPresentation.test.ts
~~~

- [ ] Assert the sorted Task 8 presentation-only staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' web/src/agentWorkbenchPresentation.test.ts web/src/agentWorkbenchPresentation.ts | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 8 presentation-only staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 8 presentation-only staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 8 presentation-only patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: model agent workbench presentation"
~~~

- [ ] Prove the isolated worktree is clean after the Task 8 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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
- Produces: `WorkbenchRefreshReason = 'initial' | 'automatic' | 'manual' | 'visibility' | 'focus' | 'resume' | 'range' | 'mutation'` and `useAgentWorkbenchPolling(range) -> snapshot/presentation/loading/refreshing/error/auto-update/requestRefresh(reason)`; `requestRefresh('mutation')` is the Task 10 post-write readback barrier.
- Produces: AgentWorkbench page without assuming a fixed Agent count.
- Produces: LiveRunStage with tabs, one tabpanel, lifecycle rail, motion gate, idle/snapshot/degraded state, and stage-heading focus fallback.

**Mandatory vertical RED-GREEN order:**

- [ ] Add `visible StrictMode mount fetches once` under `React.StrictMode`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'visible StrictMode mount fetches once')` and observe RED.
- [ ] Create the hook/page shell with one visible/non-paused effective initial GET and StrictMode probe-cleanup reuse.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "visible StrictMode mount fetches once")` and require PASS.
- [ ] Add the five-second cadence row to `server cadence starts after settlement`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "server cadence starts after settlement")` and observe RED.
- [ ] Implement recursive settled-request timeout with the 1–60-second clamp.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "server cadence starts after settlement")` and require the five-second row to pass.
- [ ] Add the thirty-second cadence row to the same settlement test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "server cadence starts after settlement")` and require the thirty-second row to pass through the same clamped scheduler.
- [ ] Add `StrictMode probe remount joins one in-flight request`, keeping the first GET unresolved through probe cleanup/remount.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "StrictMode probe remount joins one in-flight request")` and observe RED when a second GET starts.
- [ ] Implement only a module-scoped request-keyed shared in-flight record that the probe remount can join.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "StrictMode probe remount joins one in-flight request")` and require PASS.
- [ ] Add `real unmount aborts shared request after deferred cleanup`, unmounting without remount and flushing one microtask/deferred-cleanup boundary.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "real unmount aborts shared request after deferred cleanup")` and observe RED until the controller aborts exactly once.
- [ ] Implement only subscriber counting plus deferred zero-subscriber abort.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "real unmount aborts shared request after deferred cleanup")` and require PASS without delaying ordinary settled scheduling.
- [ ] Add `automatic requests never overlap in StrictMode`, resolving and advancing several 5/30-second cycles.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "automatic requests never overlap in StrictMode")` and observe RED if maximum concurrent aggregate GETs exceeds one.
- [ ] Route recursive refresh through the shared record and arm the next timer only after settlement.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "automatic requests never overlap in StrictMode")` and require PASS.
- [ ] Add `range change aborts obsolete generation`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "range change aborts obsolete generation")` and observe RED.
- [ ] Implement abort/settle/generation guards.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "range change aborts obsolete generation")` and require PASS.
- [ ] Add `stored pause performs no initial read`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stored pause performs no initial read")` and observe RED.
- [ ] Implement synchronous sessionStorage hydration.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stored pause performs no initial read")` and require PASS.
- [ ] Add `hidden mount waits for visibility`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hidden mount waits for visibility")` and observe RED.
- [ ] Implement first-effect visibility gating.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hidden mount waits for visibility")` and require PASS.
- [ ] Add `hide aborts and focus while hidden is inert`, including hidden-window focus with zero GETs/timers.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide aborts and focus while hidden is inert")` and observe RED.
- [ ] Implement hidden abort/focus guards.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide aborts and focus while hidden is inert")` and require PASS.
- [ ] Add `visible focus downgrades before one causal successor`, starting from both a fresh exact-idle snapshot and a fresh motion-eligible RUNNING snapshot while one automatic aggregate GET begun before focus remains unresolved. Dispatch window focus while visibility is still visible and assert, in the same event turn before any response, that current claims are snapshot-only, idle is absent, and motion is absent. Let the old request ignore abort and resolve successfully; require its payload not to commit or restore freshness, then require exactly one post-focus GET to start only after old settlement with maximum aggregate concurrency one.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "visible focus downgrades before one causal successor")` and observe RED if focus retains cached current/idle/motion, reuses the pre-focus request, commits its response, overlaps requests, or omits the successor.
- [ ] In the visible/non-paused focus handler, synchronously call `advancePresentation(..., 'focus')`, advance the causal intent epoch, mark any request begun before that epoch obsolete, abort it, and queue one `focus` successor. Start that successor only from the old request's `finally`; tag it with the queued epoch so only its successful response may restore freshness.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "visible focus downgrades before one causal successor")` and require PASS with maximum concurrency one and exactly one accepted post-focus response.
- [ ] **GREEN characterization:** Add a successor-failure row to the visible-focus test and require the pre-focus presentation to remain stale/static after the failure; duplicate focus/visibility events before the queued successor starts must still coalesce to one GET.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "visible focus downgrades before one causal successor")` and require PASS.
- [ ] Add `mutation refresh intent waits for a post-write non-overlapping successor` with a hook harness, a fresh cached snapshot, and one unresolved automatic GET. Invoke `requestRefresh('mutation')` as if a running-mode mutation has just succeeded; require the cached current presentation to downgrade immediately, the old request to become obsolete, zero second GETs before it settles, its successful payload to be ignored, exactly one successor afterward, and maximum concurrency one.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "mutation refresh intent waits for a post-write non-overlapping successor")` and observe RED if a pre-mutation response can satisfy the intent or requests overlap.
- [ ] Route `mutation` through the same causal intent epoch/obsolete/finally-successor controller as focus, using `advancePresentation(..., 'mutation')` before queuing. A mutation intent is issued only after the mutation HTTP success; pause or hide may cancel its network start under the existing mode rules, in which case the next explicit resume/visibility intent becomes the required later read.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "mutation refresh intent waits for a post-write non-overlapping successor")` and require PASS.
- [ ] Add the paused-range row to `pause refresh and resume obey pending range`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and observe RED when a range change reads.
- [ ] Implement pending-range storage without a request.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and require the paused-range row to pass.
- [ ] Add the manual-refresh row to the pending-range test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and observe RED unless exactly one pending-range GET occurs.
- [ ] Implement one-shot paused refresh without restarting timers.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and require the manual-refresh row to pass.
- [ ] Add the resume row to the pending-range test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and observe RED unless the pending range becomes active through one immediate GET.
- [ ] Implement resume generation/timer activation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "pause refresh and resume obey pending range")` and require PASS.
- [ ] Add the pause-then-manual-refresh row to `aborted request queues one immediate successor` while the aborted promise remains unsettled.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")` and observe RED.
- [ ] Mark the aborted generation obsolete, coalesce one immediate intent, await AbortError settlement, and then issue exactly one successor.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")` and require maximum concurrency one.
- [ ] **GREEN characterization:** Add the hide-then-visible unsettled row with the same one-successor invariant.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")` and require PASS.
- [ ] **GREEN characterization:** Add the pause-then-resume unsettled row with the same one-successor invariant.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "aborted request queues one immediate successor")` and require PASS.
- [ ] Add the `fresh_until` row to `exact deadlines fire between elapsed ticks`, placing it 250ms after a tick.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")` and observe RED.
- [ ] Implement earliest-deadline timeout/rearming.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")` and require the freshness row to pass.
- [ ] **GREEN characterization:** Add `suspect_at` 250ms after a tick using the same exact-deadline path.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")` and require PASS.
- [ ] **GREEN characterization:** Add `receipt_expires_at` 250ms after a tick using the same exact-deadline path.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "exact deadlines fire between elapsed ticks")` and require PASS.
- [ ] Add `fresh deadline revokes stage current wording`, crossing `fresh_until` with fake timers while the raw exact-positive snapshot remains deep-frozen and requiring last-confirmed evidence instead of exact/current/owner wording.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes stage current wording")` and observe RED.
- [ ] Pass `PresentedWorkbench.current_counts` into `LiveRunStage`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes stage current wording")` and require PASS while asserting the stage never reads raw `snapshot.current_counts` for a current claim.
- [ ] Add `suspect deadline revokes owning stage wording`, crossing one RUNNING signal's suspect boundary while the raw snapshot remains unchanged.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes owning stage wording")` and observe RED.
- [ ] Implement owning-bucket presentation propagation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes owning stage wording")` and require PASS.
- [ ] Add the visibility-hidden row to `hide and pause revoke stage current wording before render`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")` and observe RED before any network response.
- [ ] Wire the synchronous hidden presentation downgrade into the stage.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")` and require the hidden row to pass.
- [ ] **GREEN characterization:** Add the manual-pause row with the same static last-confirmed/no-owner wording and an unchanged raw snapshot.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke stage current wording before render")` and require PASS.
- [ ] Add `header and range copy reflects snapshot truth`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "header and range copy reflects snapshot truth")` and observe RED.
- [ ] Implement the header/radiogroup while preserving the displayed snapshot range.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "header and range copy reflects snapshot truth")` and require PASS.
- [ ] Add `sync health unavailable keeps persisted data static`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "sync health unavailable keeps persisted data static")` and observe RED.
- [ ] Implement the unavailable banner while retaining registry/history/cached static signals with no motion or idle claim.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "sync health unavailable keeps persisted data static")` and require PASS.
- [ ] Add `no-record notice is distinct from idle`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "no-record notice is distinct from idle")` and observe RED.
- [ ] Implement only `尚未注册 SEO Ops Agent` plus `管理 Agent`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "no-record notice is distinct from idle")` and require PASS.
- [ ] Add `disabled-only notice retains legacy signals`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "disabled-only notice retains legacy signals")` and observe RED.
- [ ] Implement only `当前没有启用的 Agent` with static legacy chips.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "disabled-only notice retains legacy signals")` and require PASS.
- [ ] Add `retired-only notice retains archived signals`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retired-only notice retains archived signals")` and observe RED.
- [ ] Implement only `当前没有在册 Agent` plus `查看已归档` with static archived chips.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retired-only notice retains archived signals")` and require PASS.
- [ ] Add `stage renders tabs and one selected panel`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage renders tabs and one selected panel")` and observe RED.
- [ ] Implement semantic tabs plus one tabpanel.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage renders tabs and one selected panel")` and require PASS.
- [ ] Add identity/time/Run-ID assertions to `stage detail exposes every factual field`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and observe RED.
- [ ] Render identity, semantic time, and copyable Run ID.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and require those assertions to pass.
- [ ] Add association/trigger assertions to the same detail test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and observe RED.
- [ ] Render only server-supplied association plus factual trigger fallback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and require the association/trigger assertions to pass.
- [ ] Add Token/freshness assertions to the same detail test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and observe RED.
- [ ] Render the server-provided Token state plus synchronization freshness text.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage detail exposes every factual field")` and require PASS.
- [ ] Add the exact-owner row to `stage headline respects current-count quality`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and observe RED.
- [ ] Implement exact quality-qualified headline facts without counting `signals.length`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and require the exact-owner row to pass.
- [ ] Add the lower-bound owner row to the headline-quality test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and observe RED.
- [ ] Implement only lower-bound headline copy.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and require the lower-bound row to pass.
- [ ] Add the unknown-owner row to the headline-quality test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and observe RED.
- [ ] Implement only unknown headline copy.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "stage headline respects current-count quality")` and require PASS.
- [ ] Add `unknown and legacy signals remain static`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "unknown and legacy signals remain static")` and observe RED.
- [ ] Implement explicit unknown/lifecycle labels without known-state inference.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "unknown and legacy signals remain static")` and require PASS.
- [ ] Add the focused network-removal row to `removed focused receipt transfers focus`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and observe RED.
- [ ] Implement post-snapshot DOM-aware focus transfer to the next signal/stage heading.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and require the network-removal row to pass.
- [ ] Add the focused local-expiry removal row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and observe RED.
- [ ] Apply the same focus transfer after a presentation deadline commit.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and require the local-expiry row to pass.
- [ ] **GREEN characterization:** Add the focus-elsewhere row requiring no focus stealing.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and require PASS.
- [ ] **GREEN characterization:** Add the final-signal-removal row requiring deterministic heading fallback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "removed focused receipt transfers focus")` and require PASS.
- [ ] Add the fresh verified active RUNNING row to `only qualified running signal has motion`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")` and observe RED.
- [ ] Add the motion class only through `mayAnimateRunning`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")` and require the positive row to pass.
- [ ] **GREEN characterization:** Add the non-RUNNING static row to the table-driven false-motion gate.
- [ ] **GREEN characterization:** Add the stale static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the incomplete static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the suspect static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the disabled static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the retired static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the hidden static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the paused static row to the same false-motion gate.
- [ ] **GREEN characterization:** Add the reduced-motion static row to the same false-motion gate.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")` and require PASS.
- [ ] Add the fully fresh/exact/no-signal active row to `idle requires fresh complete exact active proof`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")` and observe RED.
- [ ] Implement only the positive idle predicate/panel.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")` and require the positive row to pass.
- [ ] Add the no-active-Agent denial row to the table-driven idle predicate test.
- [ ] Add the non-exact-proof denial row to the same idle predicate test.
- [ ] Add the stale-proof denial row to the same idle predicate test.
- [ ] Add the non-zero-active-bucket denial row to the same idle predicate test.
- [ ] Add the actual-signal denial row to the same idle predicate test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")` and require every denial row to keep the predicate false.
- [ ] **GREEN characterization:** Add active exact-zero plus disabled archival-quality-unknown with no legacy/unknown signal.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "idle requires fresh complete exact active proof")` and require idle to remain allowed.
- [ ] Append the minimal scoped navy-stage layout and non-motion styles.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'stage|idle')` and require the stage/idle selections to pass before Task 10 adds the frozen palette assertions.
- [ ] Add only the qualifying RUNNING motion selector.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "only qualified running signal has motion")` and require the exact motion matrix to pass.

**Contract reference 9A: Recursive cadence and no overlap**

Freeze the request-reason and causal queue shapes:

~~~typescript
type WorkbenchRefreshReason =
  | 'initial'
  | 'automatic'
  | 'manual'
  | 'visibility'
  | 'focus'
  | 'resume'
  | 'range'
  | 'mutation'

type ImmediateRefreshIntent = {
  reason: WorkbenchRefreshReason
  intentEpoch: number
}
~~~

With fake timers and deferred fetch promises, assert:

1. Mount performs one immediate GET for the selected range only when sessionStorage does not already say paused and `document.visibilityState === 'visible'`.
2. A response with refresh_after_ms=5000 schedules the next request five seconds after that request settles.
3. A response with refresh_after_ms=30000 schedules thirty seconds after settlement.
4. Advancing time while a promise is pending never starts a second request.
5. Delays are defensively clamped to 1000..60000; a malformed delay falls back to 30000.
6. While automatic update is running, changing range aborts the obsolete request, awaits its AbortError settlement, then requests the new range; observed concurrent request count never exceeds one.
7. If pause/manual refresh, hide/visibility restoration, visible focus, pause/resume, or running-mode mutation readback happens before the obsolete request settles, the old promise is never reused as the requested refresh. Increment the intent epoch, record one coalesced immediate successor carrying the latest required epoch, wait for old settlement, then issue exactly one GET for the current generation/range/mode; concurrency remains one.
8. A response may commit only when its request generation is viable, its obsolete flag is false, and its `startedIntentEpoch` is at least the queued causal barrier it is satisfying. Thus a request begun before focus or mutation success can never restore freshness or satisfy that event's readback even if its transport ignores abort and resolves successfully.
9. Equivalent visibility/focus events that arrive while a successor is still queued coalesce into that one successor, updating the queued intent to the greatest required epoch. Once a successor has started, a later visible-focus event creates a new epoch, marks that now-pre-focus request obsolete, and queues one later successor after it settles. A later mutation success likewise advances the epoch and cannot be consumed by a request begun before that mutation.
10. While manually paused, changing range records a pending range but performs no request until 刷新显示 or resume; a paused mutation never calls the request controller.
11. Unmount aborts the active request and clears refresh/tick/deadline timers.
12. The real `React.StrictMode` setup-cleanup-setup probe issues exactly one initial GET: probe cleanup defers abort to a microtask, the immediate second setup cancels that deferred abort and reuses the in-flight promise, and only one result can commit. A genuine unmount that is not followed by setup lets the deferred cleanup abort, invalidates the generation before any result commit, and leaves zero timers.

Capture each RequestInit.signal and assert AbortError is not surfaced as an operator error.

**Contract reference 9B: Visibility, focus, failure, and manual pause**

Mock document.visibilityState with Object.defineProperty and restore it after each test. Hiding:

- clears the next automatic refresh;
- aborts an automatic in-flight request;
- stops the one-second elapsed tick;
- immediately removes all motion classes and current-idle wording from cached presentation.

Returning visible or receiving window focus performs one immediate fetch when auto update is enabled, but the window-focus handler must first require `document.visibilityState === 'visible'`. While hidden, a window-focus event performs zero GETs and arms zero timers. A visible focus event synchronously applies `advancePresentation(..., 'focus')`, so even an unexpired cached snapshot loses current wording, idle, and motion in that event turn. It then requires a GET begun after the focus intent epoch: any pre-focus in-flight response is obsolete and cannot commit, and its `finally` starts the one queued successor without overlap. Duplicate visibility/focus events before that successor starts coalesce. Old current truth or motion returns only after the post-focus successor succeeds with a fresh complete snapshot; failure preserves the downgraded presentation.

Pause writes seo-ops.agent-workbench.auto-update=paused to sessionStorage, aborts automatic work, freezes visible elapsed values, changes every current claim to 数据截至/截至 wording, and keeps selection/receipt focus. 刷新显示 performs exactly one aggregate `GET /api/agent-workbench` while remaining paused; it never implicitly reloads expanded-history endpoints. Resume writes running, applies local receipt/freshness expiry before paint, and fetches immediately while staying static until success. A normal fetch failure preserves the prior downgraded snapshot and retries at the prior cadence, or 30 seconds when no snapshot has succeeded.

An AbortController signal is not proof that its promise has settled. If an immediate manual, visibility, focus, resume, range, or mutation request arrives while an older request is active/aborting, mark that promise obsolete and queue one current intent rather than returning/reusing it. Each intent records a monotonically increasing causal epoch; focus and mutation always require a request whose `startedIntentEpoch` is at least their epoch. Multiple equivalent focus/visibility events may coalesce only while the successor remains queued, and the retained intent carries their greatest epoch; a request already started before a later focus is obsolete. In `finally`, after the old request settles and only if mount/visibility/pause rules still permit the queued reason, issue exactly one new aggregate GET for the latest range and epoch. The obsolete response cannot commit, restore freshness, surface an error, consume the action, or arm a cadence timer.

Preload sessionStorage with `seo-ops.agent-workbench.auto-update=paused` before mount and assert hydration performs zero GETs, arms no refresh/tick/deadline timer, and renders `自动更新已暂停 · 尚未读取` plus `刷新显示`. Focus/visibility events remain no-ops in that state. The first explicit `刷新显示` performs one GET and remains paused; Resume without a prior read performs one immediate GET and enters running mode only after that response settles. This persisted-pause case is distinct from clicking pause after a snapshot already exists.

Set `document.visibilityState='hidden'` before a non-paused mount and assert zero GETs and zero timers. Dispatching one transition to visible starts exactly one immediate GET. If a visible-focus event arrives after that GET has started, assert the visibility request becomes obsolete, no second GET overlaps it, and exactly one post-focus successor starts after settlement; only events received while that successor is still queued coalesce into it. No cached idle or motion state is shown before the accepted post-restoration response.

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

**Implementation reference 9F: Polling hook**

Initialize pause state synchronously from sessionStorage before the first fetch effect, and check `document.visibilityState` in that first effect and in every focus handler before requesting or arming timers. A stored paused value or initially hidden document performs no implicit mount read and arms no timer; hidden window-focus events are inert. Only `刷新显示`, Resume, or the first visibility transition may start its first request under the corresponding rules. Otherwise use one recursive setTimeout scheduled only after any non-aborted automatic attempt settles. Keep refs for the inFlight promise plus its generation/obsolete flag/`startedIntentEpoch`, one coalesced `ImmediateRefreshIntent`, the monotonically increasing latest intent epoch, AbortController, refresh timer, one-second tick timer, exact-deadline timer, latest snapshot, displayed range, pending selected range, mount generation, and a deferred-unmount cleanup token. During React StrictMode's immediate effect probe, cancel the queued cleanup and reuse the same still-valid in-flight read; during a genuine unmount, the microtask cleanup invalidates the generation before commit, aborts the request, and clears timers. Reuse an in-flight promise only when it belongs to the current viable generation and began at or after the causal epoch it is asked to satisfy. Otherwise mark it obsolete, abort it, retain the latest allowed manual/visibility/focus/resume/range/mutation intent, await settlement in `finally`, and start exactly one successor without overlap. Running-mode range replacement and Task 10's post-mutation readback use this same controller. Paused-mode range selection changes only the pending range, and paused mutation success never queues an intent.

Use performance.now for presentation progression and sessionStorage for tab-local pause. Date.now may be used only for parsing absolute display labels unrelated to elapsed/freshness truth.

~~~typescript
const scheduleNext = (rawDelay: number | undefined) => {
  if (!autoEnabledRef.current || document.visibilityState !== 'visible') return
  const delay = Number.isFinite(rawDelay)
    ? Math.min(60_000, Math.max(1_000, rawDelay as number))
    : 30_000
  refreshTimerRef.current = window.setTimeout(() => {
    void requestRefresh('automatic')
  }, delay)
}
~~~

On each accepted snapshot or local deadline transition, schedule a dedicated timeout for the earliest future aggregate fresh_until, per-signal fresh_until, PENDING/RUNNING suspect_at, or visible receipt_expires_at using aligned snapshot time. The callback advances pure presentation at the boundary and schedules the next deadline. On hide/pause/unmount, cancel refresh/tick/deadline timers and abort only Workbench requests. On visibility/resume, apply expired deadlines first, then queue the corresponding causal intent. On visible focus, call the explicit focus presentation downgrade before queuing. On running-mode mutation success, call the mutation presentation downgrade and queue `mutation` only after the write response exists. Every path deduplicates through the same epoch-tagged inFlight/immediate-intent state.

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

- [ ] Run the complete Task 9 presentation/page test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchPresentation.test.ts src/AgentWorkbench.test.tsx)
~~~

- [ ] Run frontend lint against the Task 9 implementation and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run lint)
~~~

- [ ] Stage exactly the five Task 9 files.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/useAgentWorkbenchPolling.ts web/src/pages/AgentWorkbench.tsx web/src/components/agent-workbench/LiveRunStage.tsx web/src/AgentWorkbench.test.tsx web/src/index.css
~~~

- [ ] Assert the sorted Task 9 staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' web/src/AgentWorkbench.test.tsx web/src/components/agent-workbench/LiveRunStage.tsx web/src/index.css web/src/pages/AgentWorkbench.tsx web/src/useAgentWorkbenchPolling.ts | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 9 staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 9 staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 9 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: show live agent execution signals"
~~~

- [ ] Prove the isolated worktree is clean after the Task 9 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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

- [ ] Add `summary qualifies incomplete range metrics`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t 'summary qualifies incomplete range metrics')` and observe RED.
- [ ] Create and mount `AgentSummaryMetrics` with only Run/outcome/rate coverage wording.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary qualifies incomplete range metrics")` and require PASS.
- [ ] Add `summary keeps presented current counts independent of range`, changing only historical range in one exact-current case and forbidding raw snapshot current-count reads.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary keeps presented current counts independent of range")` and observe RED if the current card changes.
- [ ] Implement the exact-current formatter from `presentation.current_counts` only.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary keeps presented current counts independent of range")` and require PASS.
- [ ] Add the lower-bound row to `summary presents lower-bound and observed-unknown current counts`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and observe RED.
- [ ] Implement only `至少 N` current-count copy from PresentedWorkbench.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and require the lower-bound row to pass.
- [ ] Add the observed-unknown row to the current-count test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and observe RED.
- [ ] Implement only timestamped last-confirmed unknown copy.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and require the observed-unknown row to pass.
- [ ] Add the never-confirmed unknown row to the current-count test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and observe RED.
- [ ] Implement only `当前数量未知 · 尚无成功确认`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary presents lower-bound and observed-unknown current counts")` and require PASS.
- [ ] Add the zero success-denominator row to `summary distinguishes zero denominator and zero tokens`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")` and observe RED.
- [ ] Implement only the em-dash rate formatter.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")` and require the denominator row to pass.
- [ ] Add the known-zero Token row to the same summary test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")` and observe RED.
- [ ] Implement only factual zero Token/coverage copy without changing current counts.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary distinguishes zero denominator and zero tokens")` and require PASS.
- [ ] Add `fresh deadline revokes summary current wording`, crossing `fresh_until` with fake timers while keeping the raw exact-positive snapshot deep-frozen.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes summary current wording")` and observe RED until exact/current wording is withdrawn.
- [ ] Pass only `presentation.current_counts` to the current portion of AgentSummaryMetrics.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "fresh deadline revokes summary current wording")` and require PASS while selected-range cards still read raw historical summary/coverage.
- [ ] Add `suspect deadline revokes summary owning count`, crossing one RUNNING signal's boundary while raw status/counts remain unchanged.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes summary owning count")` and observe RED.
- [ ] Consume the existing PresentedWorkbench downgrade without adding a component clock.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "suspect deadline revokes summary owning count")` and require PASS.
- [ ] Add the visibility-hidden row to `hide and pause revoke summary current wording`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")` and observe RED before a new fetch.
- [ ] Wire the existing hidden PresentedWorkbench transition into the summary.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")` and require the hidden row to pass.
- [ ] **GREEN characterization:** Add the visible-focus row to `hide and pause revoke summary current wording`, requiring exact/lower-bound/current-tense summary copy to disappear synchronously before the post-focus aggregate response while the raw snapshot remains unchanged.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")` and require the visible-focus row to pass through the Task 8/9 PresentedWorkbench downgrade.
- [ ] **GREEN characterization:** Add the manual-pause row requiring the same withdrawal of exact/lower-bound/current-tense copy.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "hide and pause revoke summary current wording")` and require PASS.
- [ ] **GREEN characterization:** Add `summary never renders mirrored count over stale zero total` with mirrored 1/effective remote NULL and `LOCAL_RUN_UNCONFIRMED`; assert `基于已镜像 1 次 · 上游总数未知` and absence of `1/0` using only the server-qualified coverage DTO.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "summary never renders mirrored count over stale zero total")` and require PASS.
- [ ] Add `registry supports twelve mixed lifecycle agents`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")` and observe RED.
- [ ] Create the arbitrary-length table shell and sort default active/disabled rows by `sort_order`/name.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")` and require the table assertions to pass while the retired-filter assertion remains RED.
- [ ] Implement the explicit archived filter.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry supports twelve mixed lifecycle agents")` and require PASS.
- [ ] Add `registry row renders factual metrics and warnings`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry row renders factual metrics and warnings")` and observe RED.
- [ ] Implement row cells/badges only from server snapshot fields.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "registry row renders factual metrics and warnings")` and require PASS.
- [ ] Add `expansion loads first local history page`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "expansion loads first local history page")` and observe RED.
- [ ] Implement one accessible expansion button plus the first 20-item request.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "expansion loads first local history page")` and require PASS.
- [ ] Add the matching-cursor append row to `history cursor appends only matching response`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and observe RED.
- [ ] Implement request-keyed append.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and require the matching-cursor row to pass.
- [ ] Add the range-race row to the cursor test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and observe RED when an obsolete response appends.
- [ ] Add history generation/AbortController guards.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and require the race row to pass.
- [ ] **GREEN characterization:** Add the collapse-abort row with zero late commits.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and require PASS.
- [ ] **GREEN characterization:** Add the unmount-abort row with zero late commits.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history cursor appends only matching response")` and require PASS.
- [ ] Add `paused range change performs zero aggregate and history reads`, expanding one row before pausing and choosing a pending range.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused range change performs zero aggregate and history reads")` and observe RED if either endpoint is called.
- [ ] Keep the old-range history cache visibly labelled while storing the pending range and issuing zero reads.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused range change performs zero aggregate and history reads")` and require PASS.
- [ ] Add `paused manual refresh and history controls permit only one read`, resolving one aggregate GET after `刷新显示` before exercising history controls.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused manual refresh and history controls permit only one read")` and observe RED if any history GET or second aggregate GET occurs.
- [ ] Implement the common cache-only paused history branch, old-range label, uncached explanation, and disabled paging.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused manual refresh and history controls permit only one read")` and require PASS.
- [ ] Add `resume reloads expanded history after aggregate acceptance`, requiring aggregate acceptance before any history GET.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "resume reloads expanded history after aggregate acceptance")` and observe RED.
- [ ] Implement displayed-range binding plus one request per expanded row and no request for a collapsed row.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "resume reloads expanded history after aggregate acceptance")` and require PASS.
- [ ] Add status/time/trigger assertions to `history item exposes factual fields and warning badges`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and observe RED.
- [ ] Render raw/presentation status, semantic time, duration, and factual trigger fallback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and require those assertions to pass.
- [ ] Add Token/association/error/ID assertions to the same history-item test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and observe RED.
- [ ] Render the four Token states, server association, sanitized error, and copyable full ID.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and require those assertions to pass.
- [ ] Add warning-badge assertions to the same history-item test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and observe RED.
- [ ] Render only server warning codes/archive flag.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "history item exposes factual fields and warning badges")` and require PASS.
- [ ] Add `register mutation rereads persisted snapshot`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "register mutation rereads persisted snapshot")` and observe RED.
- [ ] Implement only register-mode drawer/body/persisted readback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "register mutation rereads persisted snapshot")` and require PASS.
- [ ] Add the edit row to `edit disable and re-enable use exact contracts`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and observe RED.
- [ ] Implement only edit mode/action.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and require the edit row to pass.
- [ ] Add the disable row to the exact-contracts test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and observe RED.
- [ ] Implement only the disable action and persisted lifecycle result.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and require the disable row to pass.
- [ ] Add the verified re-enable row to the exact-contracts test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and observe RED.
- [ ] Implement only the re-enable action and persisted `sync_pending` result.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "edit disable and re-enable use exact contracts")` and require PASS.
- [ ] Add the retire row to `retire and replace require explicit confirmation`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")` and observe RED.
- [ ] Implement only bodyless retire confirmation without a delete path.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")` and require the retire row to pass.
- [ ] Add the replace row to the confirmation test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")` and observe RED.
- [ ] Implement only replace confirmation.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "retire and replace require explicit confirmation")` and require PASS.
- [ ] Add `running mutations linearize aggregate readback after write`, parameterized over register, presentation edit, disable, verified re-enable, retire, and replace. In each row, mount with automatic update running, accept an initial snapshot, start the next automatic aggregate GET, and leave it unresolved before submitting the mutation. Resolve the mutation successfully and require its exact returned `AgentRegistryRecord` lifecycle/`sync_pending` confirmation immediately; require the old GET to be marked obsolete/aborted and zero successor GETs while it is unsettled. Let that old transport ignore abort and resolve with a pre-write snapshot; assert it neither commits nor completes the mutation readback. Only after settlement may one successor GET begin, and its recorded start must follow the mutation-success resolution.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "running mutations linearize aggregate readback after write")` and observe RED if any pre-write response satisfies readback, two aggregate GETs overlap, or a mutation mode skips the successor.
- [ ] Route the common running-mode mutation-success branch through Task 9's `requestRefresh('mutation')` instead of calling `getAgentWorkbench` directly or joining the current promise. Keep the returned persistence confirmation visible while the cached main presentation is downgraded; the epoch-tagged controller owns obsolete-response rejection and starts the one successor after settlement.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "running mutations linearize aggregate readback after write")` and require exactly one post-mutation successor, maximum aggregate concurrency one, acceptance only of its response, and no claim that upstream discovery has completed.
- [ ] **GREEN characterization:** Add a mutation-error row and assert a rejected mutation neither obsoletes the current aggregate request nor queues a mutation successor. Add a successful-successor failure row and assert the returned persisted confirmation remains visible while the main snapshot stays downgraded and normal retry cadence resumes.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "running mutations linearize aggregate readback after write")` and require PASS.
- [ ] Add the paused-register row to `paused mutation does not bypass read pause`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")` and observe RED if a follow-up read occurs.
- [ ] Implement the common paused mutation-success branch that shows returned persistence state while leaving aggregate/history untouched and issuing zero follow-up reads.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")` and require the register row to pass.
- [ ] **GREEN characterization:** Add the paused-edit row using the common no-follow-up-read branch.
- [ ] **GREEN characterization:** Add the paused-disable row using the common no-follow-up-read branch.
- [ ] **GREEN characterization:** Add the paused-re-enable row using the common no-follow-up-read branch.
- [ ] **GREEN characterization:** Add the paused-retire row using the common no-follow-up-read branch.
- [ ] **GREEN characterization:** Add the paused-replace row using the common no-follow-up-read branch.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "paused mutation does not bypass read pause")` and require PASS with zero aggregate/history follow-up reads.
- [ ] Add the duplicate field-error row to `structured mutation errors bind fields`.
- [ ] Add the inaccessible field-error row to the same test.
- [ ] Add the unpublished field-error row to the same test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")` and observe RED.
- [ ] Bind server fields through `aria-describedby`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")` and require all field-error rows to pass.
- [ ] Add the form-level error row to the structured-error test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")` and observe RED.
- [ ] Add only the form `role=alert` fallback.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "structured mutation errors bind fields")` and require PASS.
- [ ] Add `drawer portal stays outside inert application root`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer portal stays outside inert application root")` and observe RED.
- [ ] Implement only the portal sibling mount point.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer portal stays outside inert application root")` and require PASS.
- [ ] Add register-mode input focus to `drawer mode chooses deterministic initial focus`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")` and observe RED.
- [ ] Implement input-mode initial focus.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")` and require the register row to pass.
- [ ] **GREEN characterization:** Add the edit input-mode focus row.
- [ ] **GREEN characterization:** Add the replace input-mode focus row.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")` and require both rows to use the same focus branch.
- [ ] Add the input-free retire row to the initial-focus test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")` and observe RED.
- [ ] Focus the readable retire heading with `tabIndex={-1}`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer mode chooses deterministic initial focus")` and require PASS.
- [ ] Add `drawer explicit focus handler wraps forward` at the final control.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps forward")` and observe RED.
- [ ] Implement only forward wrap.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps forward")` and require PASS.
- [ ] Add `drawer explicit focus handler wraps backward` at the first control.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps backward")` and observe RED.
- [ ] Implement only reverse wrap.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer explicit focus handler wraps backward")` and require PASS.
- [ ] Add the initially non-inert row to `drawer restores preexisting inert state`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")` and observe RED.
- [ ] Implement exact inert apply/remove restoration.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")` and require the initially non-inert row to pass.
- [ ] **GREEN characterization:** Add the pre-existing inert-attribute row with exact close/unmount preservation.
- [ ] **GREEN characterization:** Add the pre-existing inert-property row with exact close/unmount preservation.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer restores preexisting inert state")` and require PASS.
- [ ] Add `drawer escape restores opener during pending request`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer escape restores opener during pending request")` and observe RED.
- [ ] Implement late-update suppression plus exact opener restoration.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/AgentWorkbench.test.tsx -t "drawer escape restores opener during pending request")` and require PASS.
- [ ] Add `agents navigation and direct route`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/App.test.tsx -t 'agents navigation and direct route')` and observe RED.
- [ ] Add the Agent glyph/link/route while preserving every existing route and `/api/auth/me`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/App.test.tsx -t "agents navigation and direct route")` and require PASS.
- [ ] Add `vite proxy targets IPv4 loopback`, reading the exported Vite config and asserting `/api` resolves to `http://127.0.0.1:8000`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/viteProxy.test.ts -t 'vite proxy targets IPv4 loopback')` and observe RED against the current localhost target.
- [ ] Change only the development `/api` proxy target to `http://127.0.0.1:8000`.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/viteProxy.test.ts -t 'vite proxy targets IPv4 loopback')` and require PASS.

Keep Task 11's API bound to that exact IPv4 address; the readback CLI may still accept either explicit loopback spelling after its own validation.

- [ ] Add `workbench palette meets contrast contract`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench palette meets contrast contract")` and observe RED.
- [ ] Add only the frozen scoped palette tokens/selectors.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench palette meets contrast contract")` and require PASS.
- [ ] Add the reduced-motion assertions to `workbench accessibility fallbacks are scoped`.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and observe RED.
- [ ] Append only the scoped reduced-motion overrides.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and require the reduced-motion assertions to pass.
- [ ] Add the forced-colors assertions to the same style test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and observe RED.
- [ ] Append only the scoped forced-colors rules.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and require the forced-colors assertions to pass.
- [ ] Add keyframe-exclusivity assertions to the style test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and observe RED if a static state matches continuous motion.
- [ ] Scope keyframes to the qualifying RUNNING class.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and require the keyframe assertions to pass.
- [ ] Add portal-drawer scope assertions to the style test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and observe RED.
- [ ] Append only the portal drawer selectors.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and require the portal assertions to pass.
- [ ] Add table-overflow/reflow assertions to the style test.
- [ ] Run `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and observe RED.
- [ ] Append only the internal table overflow/reflow rules.
- [ ] Rerun `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test -- src/agentWorkbenchStyles.test.ts -t "workbench accessibility fallbacks are scoped")` and require PASS.

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

Cover register, presentation edit, disable, verified re-enable, retire confirmation, and replace. Assert exact API bodies from Task 3. When auto update is running, on success show the persisted returned lifecycle and sync_pending state, synchronously downgrade the cached main presentation, and invoke Task 9's `requestRefresh('mutation')`. This is a causal write-read barrier: an aggregate request begun before the mutation success becomes obsolete, its response cannot commit or satisfy readback, no successor may overlap it, and exactly one GET begun after it settles provides the persisted aggregate readback without claiming upstream discovery finished. A failed mutation creates no barrier/read. If the post-mutation GET fails, retain the mutation-response confirmation and downgraded snapshot while normal retry continues. When paused, the explicit mutation itself remains allowed, but it must not bypass the read pause: show only the mutation response's persisted Agent lifecycle/sync_pending in a confirmation state, leave the main snapshot/history untouched, display `设置已保存 · 页面仍为暂停快照；点击刷新显示或恢复自动更新`, and perform zero follow-up aggregate/history GETs. Only the existing `刷新显示` action may make the one paused local read; resume follows Task 9's sequence.

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

Receive the page's paused/running state and Task 9's `requestRefresh` action explicitly. After a successful mutation in running mode, render the server-returned `AgentRegistryRecord` confirmation without merging it into the immutable page snapshot, then call only `requestRefresh('mutation')`; never call `getAgentWorkbench` from the drawer and never await/reuse an existing aggregate promise as the write readback. The polling controller downgrades cached presentation, obsoletes any pre-write request, and performs the one post-settlement successor. In paused mode, render the same confirmation inside the drawer/toast without calling `requestRefresh`, aggregate, or history; route the operator only to the existing `刷新显示` or resume controls. Closing the drawer does not implicitly read.

**Implementation reference 10K: Navigation and route**

Extend NavGlyph's union and path map with an Agent network glyph. Add agentsActive = pathname === '/agents', the sidebar link after 任务, and Route path=/agents. Preserve the already integrated Performance Dashboard import/route and all unrelated dirty App.tsx work.

**Implementation reference 10L: Scoped table, drawer, responsive, and accessibility CSS**

Append the remaining .agent-workbench block. Reflow the header/actions/drawer fields vertically at 200% zoom, confine table overflow to its labelled region, and verify no Workbench-specific page-wide horizontal overflow at 1180, 1440, or 1920 CSS pixels. The legacy shell min-width remains unchanged.

Only orange operator actions use the orange family; bright teal remains navy-stage RUNNING only. Use dark teal plus icon/text on white. Every state retains a textual label and shape. Add max-200ms non-looping receipt entrance, restrained drawer slide, strong focus-visible rings, and full reduced-motion/forced-colors overrides.

- [ ] Run the complete Task 8-10 focused frontend test gate and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test -- src/agentWorkbenchApi.test.ts src/agentWorkbenchPresentation.test.ts src/AgentWorkbench.test.tsx src/agentWorkbenchStyles.test.ts src/viteProxy.test.ts src/App.test.tsx)
~~~

- [ ] Run the full frontend test suite and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm test)
~~~

- [ ] Run frontend lint and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run lint)
~~~

- [ ] Run the production frontend build and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(cd web && npm run build)
~~~

- [ ] Stage exactly the twelve Task 10 files.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git add -- web/src/components/agent-workbench/AgentSummaryMetrics.tsx web/src/components/agent-workbench/AgentRegistryTable.tsx web/src/components/agent-workbench/AgentRunHistory.tsx web/src/components/agent-workbench/AgentManagerDrawer.tsx
git add -- web/src/pages/AgentWorkbench.tsx web/src/AgentWorkbench.test.tsx web/src/agentWorkbenchStyles.test.ts
git add -- web/src/App.tsx web/src/App.test.tsx web/vite.config.ts web/src/viteProxy.test.ts web/src/index.css
~~~

- [ ] Assert the sorted Task 10 staged-name set.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)"
AW_EXPECTED_NAMES="$(printf '%s\n' web/src/AgentWorkbench.test.tsx web/src/App.test.tsx web/src/App.tsx web/src/agentWorkbenchStyles.test.ts web/src/components/agent-workbench/AgentManagerDrawer.tsx web/src/components/agent-workbench/AgentRegistryTable.tsx web/src/components/agent-workbench/AgentRunHistory.tsx web/src/components/agent-workbench/AgentSummaryMetrics.tsx web/src/index.css web/src/pages/AgentWorkbench.tsx web/src/viteProxy.test.ts web/vite.config.ts | LC_ALL=C sort)"
test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES"
printf '%s\n' "$AW_STAGED_NAMES"
~~~

- [ ] Inspect the complete Task 10 staged patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached
~~~

- [ ] Run the Task 10 staged whitespace check and require PASS.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git diff --cached --check
~~~

- [ ] Commit only the inspected Task 10 patch.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git commit -m "feat: complete agent workbench UI"
~~~

- [ ] Prove the isolated worktree is clean after the Task 10 commit.

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -z "$(git status --porcelain)"
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
- Produces: canonical allowlisted fixture-generation/refresh JSON stdout; generation reports the one aware UTC `generated_at` used for factual fixture timestamps, and every active refresh reports its aware UTC `refreshed_at` plus newly inserted receipt `coreai_run_id` as `new_receipt_id` for exact HTTP comparison.

**Mandatory vertical verification and release order:**

- [ ] Create the shared temporary-database fixture.
- [ ] Define the logged-in TestClient fixture.
- [ ] Define the controllable aware-clock fixture.
- [ ] Define the list-only Core AI fake fixture whose `get_run` raises `AssertionError`.
- [ ] Install an independent cancellation-aware parked replacement for the ordinary scheduler in the shared harness.
- [ ] Install an independent cancellation-aware parked replacement for the Local Falcon scheduler in the shared harness.
- [ ] Install an independent cancellation-aware parked replacement for the Workbench loop in the shared harness. Only reference 11C's live app may run the real Workbench loop.
- [ ] Run the acceptance-file collection gate. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q --collect-only)`. Expected: PASS.
- [ ] Add `test_registration_persists_before_first_proof` with the persisted active/`sync_pending` readback assertions from reference 11A.
- [ ] Run the registration-before-proof case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_registration_persists_before_first_proof)`. Expected: PASS against Tasks 1-7.
- [ ] Add `test_local_running_acceptance_revokes_exact_idle` with the static/unconfirmed row, nullable trigger type, event-epoch increment, unknown bucket, and no-idle assertions.
- [ ] Run the local-RUNNING acceptance case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_local_running_acceptance_revokes_exact_idle)`. Expected: PASS.
- [ ] Add `test_old_zero_cycle_cannot_overwrite_local_run` with two connections/events and the pre-event response fence.
- [ ] Run the old-zero/local-Run race case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_zero_cycle_cannot_overwrite_local_run)`. Expected: PASS without restoring exact idle.
- [ ] Add the missing-trigger-status and pre-event-response branch of `test_old_zero_cycle_cannot_overwrite_statusless_acceptance` with assertions for the exact ID/source-associated `raw_status=NULL` projection, all three unknown buckets, and the old-cycle commit fence.
- [ ] Run the first statusless-acceptance branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_zero_cycle_cannot_overwrite_statusless_acceptance)`. Expected: PASS.
- [ ] Extend `test_old_zero_cycle_cannot_overwrite_statusless_acceptance` with a new exact-zero cycle that leaves the durable marker non-idle until a valid page observes the same ID with a non-empty status.
- [ ] Run the completed statusless-acceptance case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_zero_cycle_cannot_overwrite_statusless_acceptance)`. Expected: PASS.
- [ ] Add the known-terminal branch of `test_immediate_terminal_trigger_requires_list_confirmation` with immutable terminal observation, no receipt, all-bucket current uncertainty, effective remote total NULL instead of 1/0, conditional static archiving, `fresh=false`, and `fresh_until=null`.
- [ ] Run the known-terminal immediate-trigger branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_immediate_terminal_trigger_requires_list_confirmation)`. Expected: PASS.
- [ ] Extend `test_immediate_terminal_trigger_requires_list_confirmation` with the `SKIPPED` branch and the post-event exact-zero non-restoration assertions.
- [ ] Run the terminal-plus-`SKIPPED` immediate-trigger branches. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_immediate_terminal_trigger_requires_list_confirmation)`. Expected: PASS.
- [ ] Extend `test_immediate_terminal_trigger_requires_list_confirmation` with valid-page/exact-ID confirmation and consistent-total restoration while the receipt remains absent.
- [ ] Run the complete immediate-terminal confirmation case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_immediate_terminal_trigger_requires_list_confirmation)`. Expected: PASS without restarting a receipt.
- [ ] Add `test_old_disabled_cycle_cannot_satisfy_reenable` with re-enable `sync_pending`, due-now, and event-epoch assertions that survive the archival response.
- [ ] Run the disabled-cycle/re-enable race case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_disabled_cycle_cannot_satisfy_reenable)`. Expected: PASS.
- [ ] Add `test_list_confirmation_enables_running_signal` with actual trigger type, exact current proof, five-second recommendation, and motion-eligibility assertions.
- [ ] Run the list-confirmed RUNNING case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_list_confirmation_enables_running_signal)`. Expected: PASS.
- [ ] Add the nonzero-Token branch of `test_terminal_projection_persists_tokens_and_receipt` with immutable terminal-observation and receipt assertions.
- [ ] Run the nonzero-Token terminal projection branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_projection_persists_tokens_and_receipt)`. Expected: PASS.
- [ ] Extend `test_terminal_projection_persists_tokens_and_receipt` with the known-zero Token branch.
- [ ] Run both terminal Token branches. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_projection_persists_tokens_and_receipt)`. Expected: PASS.
- [ ] Add the running-source branch of `test_local_archiving_settles_to_static_receipt`.
- [ ] Run the running-source archiving branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_local_archiving_settles_to_static_receipt)`. Expected: PASS.
- [ ] Extend `test_local_archiving_settles_to_static_receipt` with the settled-source static-receipt branch.
- [ ] Run both local-source branches. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_local_archiving_settles_to_static_receipt)`. Expected: PASS.
- [ ] Add `test_repeat_discovery_never_moves_receipt_expiry`.
- [ ] Run the immutable-receipt-expiry case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_repeat_discovery_never_moves_receipt_expiry)`. Expected: PASS.
- [ ] Add `test_external_run_discovery_bound_and_unassociated_copy` with the 30-second projection and 60-second already-open-browser bounds.
- [ ] Run the external discovery case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_external_run_discovery_bound_and_unassociated_copy)`. Expected: PASS without local association.
- [ ] Add `test_old_terminal_backfill_has_no_receipt`.
- [ ] Run the old-terminal backfill case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_old_terminal_backfill_has_no_receipt)`. Expected: PASS.
- [ ] Add the truncated-page branch of `test_mixed_proof_remains_honest` with lower-bound, static, and no-idle assertions.
- [ ] Run the truncated-page mixed-proof branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`. Expected: PASS.
- [ ] Extend `test_mixed_proof_remains_honest` with the failed-page branch and its unknown/no-idle assertions.
- [ ] Run the failed-page mixed-proof branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`. Expected: PASS.
- [ ] Extend `test_mixed_proof_remains_honest` with the NULL-status branch and its static/no-idle assertions.
- [ ] Run the NULL-status mixed-proof branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`. Expected: PASS.
- [ ] Extend `test_mixed_proof_remains_honest` with the unknown-status branch and its static/no-idle assertions.
- [ ] Run the unknown-status mixed-proof branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`. Expected: PASS.
- [ ] Extend `test_mixed_proof_remains_honest` with the same-cycle-conflict branch and its qualified-output assertions.
- [ ] Run the complete mixed-proof case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_mixed_proof_remains_honest)`. Expected: PASS.
- [ ] Add `test_fresh_app_instance_reads_durable_projection` with connection closure, a new application/TestClient, unchanged durable readback, and zero Core AI calls.
- [ ] Run the fresh-application readback case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_fresh_app_instance_reads_durable_projection)`. Expected: PASS.
- [ ] Run the complete acceptance file before building release-only helpers. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q)`.
- [ ] Add the startup half of `test_live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench` with fail-if-called ordinary-scheduler and Local-Falcon-scheduler fakes, an event-recording Workbench loop, route/auth parity, zero-trigger, and Workbench-start assertions.
- [ ] Run the live-gate startup half. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)`. Expected: RED at the missing safe harness.
- [ ] Create the minimal `agent_workbench_live_app.py` from Task 7's real application/lifespan factories.
- [ ] Wire two independent parked ordinary schedulers into the live app.
- [ ] Wire the real Workbench loop into the live app.
- [ ] Run the live-gate startup half again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)`. Expected: GREEN for startup behavior.
- [ ] Extend `test_live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench` with cancellation and all-three-awaited shutdown assertions.
- [ ] Run the live-gate shutdown half. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)`. Expected: RED at the first missing finalizer.
- [ ] Wire cancellation-aware parked-loop finalizers through the real lifespan.
- [ ] Run the complete live-gate lifespan case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k live_gate_lifespan_parks_both_ordinary_schedulers_and_awaits_workbench)`. Expected: GREEN with all three loops awaited.
- [ ] Add the process-A setup branch of `test_terminal_tokens_survive_real_server_restart` with one marker-owned temporary database, one reserved loopback port, and one captured subprocess PID.
- [ ] Run the process-A setup branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED for the missing restart app.
- [ ] Implement process A's marker-owned temporary-database guard in `agent_workbench_live_app.py`.
- [ ] Implement process A's writable startup mode.
- [ ] Run the process-A startup branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN for the marker guard, reserved-port startup, and captured process-A PID; this slice does not yet assert fixture data.
- [ ] Extend the process-A test branch with the fixed terminal status, Token pair 7+11, receipt, history, and canonical durable-subset assertions.
- [ ] Run the process-A fixture assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED at the missing fixed fixture.
- [ ] Implement process A's fixed terminal fixture through the real schema/projection/aggregate helpers.
- [ ] Run the process-A fixture branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN for the fixed durable fixture; shutdown behavior is not asserted until the next step.
- [ ] Extend the process-A test branch with bounded readiness, SIGINT, awaited zero exit, captured PID, and PID-gone assertions.
- [ ] Run the process-A shutdown assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED at graceful shutdown behavior.
- [ ] Implement process A's three independently parked loops.
- [ ] Implement process A's bounded graceful exit.
- [ ] Run the complete process-A slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN for process A.
- [ ] Extend `test_terminal_tokens_survive_real_server_restart` with a distinct process-B PID against the existing database while Core AI is unavailable.
- [ ] Run the process-B launch branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED at the missing read phase.
- [ ] Implement process B's no-write startup mode.
- [ ] Implement process B's request-owned SQLite `mode=ro` dependency.
- [ ] Run the process-B startup branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN for a distinct process-B PID and read-only startup while Core AI is unavailable; durable-subset values are not asserted until the next step.
- [ ] Extend the process-B branch with exact persisted terminal status, Token, receipt, history, stable-SQLite hash, and distinct-PID assertions.
- [ ] Run the process-B durable-subset assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED at durable-subset readback.
- [ ] Implement process B's API/history durable-subset readback without a write path.
- [ ] Implement process B's SQLite durable-subset readback without a write path.
- [ ] Run the durable process-B readback branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN while the stronger write guards remain outside this slice.
- [ ] **GREEN characterization:** Extend the process-B branch with zero init, seed, prime, and application-write-hook call counts.
- [ ] Run the process-B initialization characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN because the implemented read phase owns no initialization or application write path.
- [ ] **GREEN characterization:** Extend the process-B branch with one explicitly rejected DML attempt through its existing URI `mode=ro` connection and `total_changes == 0`.
- [ ] Run the process-B URI read-only characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN because SQLite `mode=ro` already rejects the attempt.
- [ ] **GREEN characterization:** Extend the process-B branch with unchanged database/sidecar set-and-hash assertions around that rejected `mode=ro` attempt.
- [ ] Run the process-B unchanged-file characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN with no database or sidecar creation/change.
- [ ] Add `test_restart_read_connection_enforces_query_only_when_uri_mode_is_bypassed`, using the request-connection factory seam to open the marker-owned temporary database read-write and asserting `PRAGMA query_only == 1` plus a rejected DML attempt.
- [ ] Run the query-only defense case before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_restart_read_connection_enforces_query_only_when_uri_mode_is_bypassed)`. Expected: RED because the deliberately read-write test connection lacks the independent defense.
- [ ] Implement `PRAGMA query_only=ON` for every process-B request-owned SQLite connection.
- [ ] Run the query-only defense case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_restart_read_connection_enforces_query_only_when_uri_mode_is_bypassed)`. Expected: GREEN with the bypassed URI layer still unable to write.
- [ ] Add `test_restart_read_connection_installs_write_denial_authorizer`, using a recording request-connection seam to assert installation of a callback that returns `SQLITE_DENY` for DML, DDL, `ATTACH`, `DETACH`, and writable-PRAGMA action codes.
- [ ] Run the authorizer-defense case before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_restart_read_connection_installs_write_denial_authorizer)`. Expected: RED because no independent authorizer is installed.
- [ ] Implement the write-denying SQLite authorizer for every process-B request-owned SQLite connection.
- [ ] Run the authorizer-defense case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_restart_read_connection_installs_write_denial_authorizer)`. Expected: GREEN while ordinary read action codes remain allowed.
- [ ] Run the complete process-B no-write slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k 'test_terminal_tokens_survive_real_server_restart or test_restart_read_connection_')`. Expected: GREEN with all three independent read-only layers and unchanged database/sidecars.
- [ ] Extend the restart test with sanitized `server-restart.json` assertions for two distinct PIDs, both awaited zero exits, before/after hashes, and the exact durable terminal/Token scalars.
- [ ] Run the restart evidence-shape branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: RED at missing evidence output.
- [ ] Implement atomic fixed-shape restart evidence output outside the source tree.
- [ ] Run the restart evidence-shape branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN with the exact allowlisted evidence shape.
- [ ] **GREEN characterization:** Extend the restart evidence branch with one secret sentinel that must be absent from the evidence file.
- [ ] Run the restart evidence-sanitization characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN because the implemented fixed-shape writer never reads or serializes arbitrary environment/auth values.
- [ ] Run the complete process-boundary restart test. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_terminal_tokens_survive_real_server_restart)`. Expected: GREEN.
- [ ] Add the required-argument rows to `test_live_readback_structural_and_sanitization_contract`.
- [ ] Run the required-argument rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: RED for the missing CLI/helper.
- [ ] Implement live-readback argument parsing.
- [ ] Run the required-argument rows again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN for required-argument validation.
- [ ] Extend `test_live_readback_structural_and_sanitization_contract` with the registry-to-aggregate structural rows, including validation-before-secret-load and canonical-output assertions.
- [ ] Run the registry/aggregate structural rows before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: RED at the missing structural result/output behavior.
- [ ] Add `test_live_readback_named_env_file_overrides_conflicting_ambient`: place marked local-auth, database, Core AI, and `SEO_OPS_*` values in a temporary named env file, inject different sentinel values for every consumed configuration key into the parent process environment, and assert the settings loader plus `configured_agent_slots(private_mapping)` use only the marked file values while no ambient sentinel reaches stdout, stderr, canonical JSON, SQLite, or the HTTP fake.
- [ ] Run the authoritative-env-file test before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_named_env_file_overrides_conflicting_ambient)`. Expected: RED for the missing private named-file loader.
- [ ] Implement authoritative named-file loading after loopback URL validation: parse the file into a private mapping, take every Workbench local-auth/database/Core-AI/`SEO_OPS_*` value exclusively from that mapping, pass it explicitly to `configured_agent_slots`, and never fall back to or mutate the ambient process environment for those keys.
- [ ] Run the authoritative-env-file test again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_named_env_file_overrides_conflicting_ambient)`. Expected: GREEN with exact file-value use and zero ambient-sentinel leakage.
- [ ] Implement the canonical output shell.
- [ ] Implement registry-to-aggregate structural result codes.
- [ ] Run the structural rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN.
- [ ] Extend `test_live_readback_structural_and_sanitization_contract` with the transport-error sentinel row.
- [ ] Run the transport sentinel row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: RED at the first leak.
- [ ] Implement fixed code-only diagnostics for transport failures without inspecting exception args, string, repr, body, or cause.
- [ ] Run the transport sentinel row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN with no transport sentinel bytes.
- [ ] Extend `test_live_readback_structural_and_sanitization_contract` with the HTTP-500 text sentinel row.
- [ ] Run the HTTP-500 text sentinel row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: RED at the first leak.
- [ ] Implement fixed code-only diagnostics for HTTP failures without inspecting status body, exception args, string, repr, or cause.
- [ ] Run the HTTP-500 text sentinel row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN with no response-text sentinel bytes.
- [ ] **GREEN characterization:** Extend `test_live_readback_structural_and_sanitization_contract` with the HTTP-500 JSON sentinel row.
- [ ] Run the HTTP-500 JSON sanitization characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN because the fixed HTTP diagnostic does not parse or serialize either text or JSON error bodies.
- [ ] Extend `test_live_readback_structural_and_sanitization_contract` with malformed-success and unexpected-exception sentinel rows.
- [ ] Run the malformed/unexpected sentinel rows before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: RED at the missing fixed malformed/unexpected diagnostics.
- [ ] Implement fixed code-only diagnostics for malformed and unexpected failures without inspecting exception args, string, repr, body, or cause.
- [ ] Run the complete structural/sanitization case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_structural_and_sanitization_contract)`. Expected: GREEN for stdout, stderr, JSON, SQLite, and API sentinel assertions.
- [ ] Add the `0`, `241`, and non-integer argument-error rows to `test_live_readback_global_deadline`.
- [ ] Run the deadline argument rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_global_deadline)`. Expected: RED.
- [ ] Implement validated 1..240-second deadline arguments with default 240.
- [ ] Run the deadline argument rows again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_global_deadline)`. Expected: GREEN for argument validation.
- [ ] Extend `test_live_readback_global_deadline` with a fake monotonic clock and many blocked Agent bundles that require `LIVE_GATE_TIMEOUT` at 240 seconds.
- [ ] Run the blocked-bundle deadline branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_global_deadline)`. Expected: RED until outstanding reads are cancelled and awaited.
- [ ] Implement the one-shot global reconciliation deadline around all bundles.
- [ ] Implement cancellation and awaited cleanup for outstanding live-readback workers.
- [ ] Run the global-deadline case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_global_deadline)`. Expected: GREEN with a fixed secret-safe timeout result.
- [ ] Add the external-host and userinfo rows to `test_live_readback_rejects_non_loopback_url_and_redirect`.
- [ ] Run the first URL-rejection slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: RED.
- [ ] Implement rejection of non-loopback hosts and URL userinfo before secret loading.
- [ ] Run the external-host/userinfo rows again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: GREEN.
- [ ] Extend `test_live_readback_rejects_non_loopback_url_and_redirect` with path, query, and fragment rows.
- [ ] Run the path/query/fragment URL rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: RED.
- [ ] Implement rejection of non-empty path, query, and fragment components.
- [ ] Run the path/query/fragment URL rows again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: GREEN.
- [ ] Extend `test_live_readback_rejects_non_loopback_url_and_redirect` with the missing-port row.
- [ ] Run the missing-port URL row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: RED.
- [ ] Implement explicit-port enforcement for the already validated loopback base URL.
- [ ] Run the missing-port URL row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: GREEN.
- [ ] Run the static URL-selection rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: GREEN.
- [ ] Extend `test_live_readback_rejects_non_loopback_url_and_redirect` with the 3xx response row.
- [ ] Run the 3xx response row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: RED if the client follows the redirect.
- [ ] Disable redirect following in the live-readback HTTP client.
- [ ] Map every 3xx response to a fixed code.
- [ ] Run the complete URL/redirect case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_rejects_non_loopback_url_and_redirect)`. Expected: GREEN.
- [ ] Add `test_live_readback_directly_reads_every_active_or_configured_agent` with the exact de-duplicated Agent call set.
- [ ] Run the direct-read call-set case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_directly_reads_every_active_or_configured_agent)`. Expected: RED.
- [ ] Implement one metadata call plus four serialized bounded list calls per selected Agent regardless of scheduler due time.
- [ ] Run the direct-read call-set case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_directly_reads_every_active_or_configured_agent)`. Expected: GREEN.
- [ ] Add `test_live_readback_caps_agent_bundles` with seventeen blocked Agents.
- [ ] Run the Agent-bundle cap case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_caps_agent_bundles)`. Expected: RED when more than eight bundles enter.
- [ ] Implement the eight-worker Agent-bundle cap while keeping all five calls serialized inside each bundle.
- [ ] Run the Agent-bundle cap case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_caps_agent_bundles)`. Expected: GREEN.
- [ ] Add `test_live_readback_clock_only_heartbeat_keeps_segment_stable` with a 30-second timestamp-only proof crossing a slow bundle.
- [ ] Run the clock-only heartbeat case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_clock_only_heartbeat_keeps_segment_stable)`. Expected: RED if the proof invalidates the segment.
- [ ] Exclude observation, freshness, due, and lease clocks from the semantic segment marker.
- [ ] Run the clock-only heartbeat case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_clock_only_heartbeat_keeps_segment_stable)`. Expected: GREEN.
- [ ] Add `test_live_readback_material_change_invalidates_only_its_segment` with one Agent changing status, Token, or revision mid-bracket.
- [ ] Run the material-change case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_material_change_invalidates_only_its_segment)`. Expected: RED.
- [ ] Add status, Token, association, and quality fields to the per-Agent semantic marker.
- [ ] Add error, receipt, and lifecycle fields to the per-Agent semantic marker without invalidating stable peers.
- [ ] Run the material-change case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_material_change_invalidates_only_its_segment)`. Expected: GREEN.
- [ ] Add `test_live_readback_retries_only_changed_segment` with one changed Agent and stable peers.
- [ ] Run the targeted-retry case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retries_only_changed_segment)`. Expected: RED unless only that Agent's five calls plus the short local bracket repeat after one normal delay.
- [ ] Implement targeted one-segment retry scheduling.
- [ ] Run the targeted-retry case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retries_only_changed_segment)`. Expected: GREEN.
- [ ] Add `test_live_readback_never_splices_segment_attempts` with mismatched attempt-A remote data and attempt-B local data.
- [ ] Run the no-splicing case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_never_splices_segment_attempts)`. Expected: RED if the false composite passes.
- [ ] Store immutable same-attempt records for segment comparisons.
- [ ] Run the no-splicing case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_never_splices_segment_attempts)`. Expected: GREEN with the composite retained as a mismatch.
- [ ] Add the same-total/different-ID row to `test_live_readback_compares_status_ids_owners_totals_and_tokens`.
- [ ] Run the returned-ID comparison row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED.
- [ ] Implement returned-ID set comparison before totals.
- [ ] Run the returned-ID comparison row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Extend `test_live_readback_compares_status_ids_owners_totals_and_tokens` with the wrong returned `row.agent_id` row.
- [ ] Run the upstream-owner row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED.
- [ ] Implement upstream-owner validation.
- [ ] Run the upstream-owner row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Extend `test_live_readback_compares_status_ids_owners_totals_and_tokens` with the wrong projected local-owner row.
- [ ] Run the local-owner row before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED.
- [ ] Implement projected local-owner validation.
- [ ] Run both owner-validation rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Extend `test_live_readback_compares_status_ids_owners_totals_and_tokens` with truncated-page `last_synced_at IS NULL` rows for PENDING, RUNNING, and PAUSED.
- [ ] Run the unconfirmed non-terminal slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED if the CLI exits clean.
- [ ] Implement `LIVE_GATE_UNCONFIRMED_RUN` classification from `last_synced_at IS NULL`, independent of raw status or page truncation.
- [ ] Run the unconfirmed non-terminal slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] **GREEN characterization:** Extend the unconfirmed matrix with COMPLETED, FAILED, and TIMEOUT rows.
- [ ] Run the first unconfirmed terminal characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN because classification is independent of raw status.
- [ ] **GREEN characterization:** Extend the unconfirmed matrix with CANCELLED and `SKIPPED` rows.
- [ ] Run the second unconfirmed terminal characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN because `SKIPPED` and CANCELLED do not bypass the missing-confirmation rule.
- [ ] **GREEN characterization:** Extend the unconfirmed matrix with one future status and NULL status, using a valid truncated direct page that omits the ID in each row.
- [ ] Run the future/NULL unconfirmed characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN because classification depends only on `last_synced_at IS NULL`.
- [ ] Run the complete unconfirmed matrix. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Extend `test_live_readback_compares_status_ids_owners_totals_and_tokens` with the exact-complete Token/total row using only list-confirmed projections.
- [ ] Run the exact-complete Token/total row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED at the first missing comparison.
- [ ] Implement exact Token/total reporting for complete proofs.
- [ ] Run the exact-complete Token/total row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Extend the Token/total branch with the bounded-overlap row using only list-confirmed projections.
- [ ] Run the bounded-overlap Token/total row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: RED.
- [ ] Implement bounded-overlap Token/total reporting without weakening exact-complete comparisons.
- [ ] Run the complete status/ID/owner/total/Token case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_compares_status_ids_owners_totals_and_tokens)`. Expected: GREEN.
- [ ] Add the clean-first row to `test_live_readback_retry_outcomes`.
- [ ] Run the clean-first retry row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: RED if it exits incorrectly.
- [ ] Implement clean first-attempt success.
- [ ] Run the clean-first retry row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: GREEN without a retry.
- [ ] Extend `test_live_readback_retry_outcomes` with the clean-second row.
- [ ] Run the clean-second retry row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: RED if it exits incorrectly.
- [ ] Implement recovered second-attempt success.
- [ ] Run both clean retry rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: GREEN.
- [ ] Extend `test_live_readback_retry_outcomes` with the repeated-identical-mismatch row.
- [ ] Run the identical-mismatch row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: RED.
- [ ] Map a stable repeated fingerprint to `LIVE_GATE_MISMATCH`.
- [ ] Run the identical-mismatch row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: GREEN.
- [ ] Extend `test_live_readback_retry_outcomes` with the changing-mismatch row.
- [ ] Run the changing-mismatch row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: RED.
- [ ] Map either unstable retry shape to `LIVE_GATE_UNSTABLE`.
- [ ] Run the changing-mismatch row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: GREEN with `LIVE_GATE_UNSTABLE`.
- [ ] **GREEN characterization:** Extend `test_live_readback_retry_outcomes` with the changing-watermark row.
- [ ] Run the complete retry-outcomes case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_retry_outcomes)`. Expected: GREEN because any differing attempt fingerprint, including only its watermark, maps to `LIVE_GATE_UNSTABLE`.
- [ ] Add the eligible active-run row to `test_live_readback_reports_active_transition_candidates` with an active owner, exact complete/fresh proof, list-confirmed non-suspect RUNNING status, no later poll error, and every `mayAnimateRunning` input true.
- [ ] Run the eligible-candidate row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`. Expected: RED.
- [ ] Emit only sanitized motion-eligible RUNNING candidate IDs without changing the clean snapshot exit code.
- [ ] Run the eligible-candidate row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`. Expected: GREEN.
- [ ] **GREEN characterization:** Extend `test_live_readback_reports_active_transition_candidates` with PENDING, PAUSED, and suspect-RUNNING rows.
- [ ] Run the first ineligible-candidate slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`. Expected: GREEN with an empty candidate list and unchanged clean exit.
- [ ] **GREEN characterization:** Extend the candidate test with stale, incomplete-proof, and unconfirmed RUNNING rows.
- [ ] Run the second ineligible-candidate slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`. Expected: GREEN with an empty candidate list and unchanged clean exit.
- [ ] **GREEN characterization:** Extend the candidate test with disabled/retired RUNNING and no-active rows.
- [ ] Run the complete candidate selection. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_reports_active_transition_candidates)`. Expected: GREEN.
- [ ] Add the COMPLETED, FAILED, and TIMEOUT branches of `test_live_readback_observe_mode_proves_same_run_transition`, each starting from one motion-eligible RUNNING candidate for the same ID.
- [ ] Run the first observe-destination slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`. Expected: RED at the missing transition proof.
- [ ] Implement bounded non-overlapping read-only observation of the exact selected ID.
- [ ] Run the first observe-destination slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`. Expected: GREEN for bounded transition observation only.
- [ ] **GREEN characterization:** Extend the same-ID observe test with CANCELLED and `SKIPPED` destinations.
- [ ] Run the complete observe-destination matrix. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`. Expected: GREEN for all five terminal destinations, including `SKIPPED`.
- [ ] Extend the observe-mode test with the final fresh direct-list/SQLite terminal status-and-Token equality gate.
- [ ] Run the final direct-comparison assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`. Expected: RED at the missing final direct comparison.
- [ ] Implement the final fresh direct-list/SQLite terminal status-and-Token equality gate.
- [ ] Run the complete same-ID observe-mode case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_proves_same_run_transition)`. Expected: GREEN for every destination, including `SKIPPED`.
- [ ] Add the still-active timeout row to `test_live_readback_observe_mode_times_out_honestly`.
- [ ] Run the still-active timeout row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: RED.
- [ ] Emit `LIVE_TRANSITION_NOT_OBSERVED` at the bounded timeout.
- [ ] Run the still-active timeout row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: GREEN.
- [ ] **GREEN characterization:** Extend `test_live_readback_observe_mode_times_out_honestly` with the already-terminal-at-start row.
- [ ] Run the already-terminal-at-start row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: GREEN with the same not-observed code and no replacement ID.
- [ ] **GREEN characterization:** Extend the observe-failure test with the disappeared-ID row.
- [ ] Run the disappeared-ID row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: GREEN with the same not-observed code and no replacement ID.
- [ ] Extend the observe-failure test with the terminal Token-mismatch row.
- [ ] Run the terminal Token-mismatch row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: RED if reported only as not observed.
- [ ] Route terminal status/Token disagreement to the stricter reconciliation-mismatch code.
- [ ] Run the complete observe-failure selection. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_live_readback_observe_mode_times_out_honestly)`. Expected: GREEN.
- [ ] Run the complete fake-backed live-readback selection. Do not execute the real read-only command until reference 11C's scheduler-parked API is running; that later command is its own live evidence step and never starts a Run. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k 'test_live_readback_')`.
- [ ] Add the configured-default and ancestor-path rows to `test_visual_fixture_rejects_unsafe_paths`.
- [ ] Run the first unsafe-path slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: RED.
- [ ] Implement configured-default and ancestor-path rejection using canonical paths.
- [ ] Run the first unsafe-path slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: GREEN.
- [ ] Extend `test_visual_fixture_rejects_unsafe_paths` with the descendant-path row.
- [ ] Run the descendant-path row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: RED.
- [ ] Implement canonical descendant-path rejection.
- [ ] Run the path-boundary rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: GREEN.
- [ ] Extend `test_visual_fixture_rejects_unsafe_paths` with the non-empty output-directory row.
- [ ] Run the non-empty-directory row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: RED.
- [ ] Implement empty-directory-only generation.
- [ ] Run the non-empty-directory row again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: GREEN rejection.
- [ ] Extend `test_visual_fixture_rejects_unsafe_paths` with the unmarked-refresh row.
- [ ] Run the unmarked-refresh row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: RED.
- [ ] Implement exact private-marker validation for refresh.
- [ ] Run the complete fixture path-safety selection. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_rejects_unsafe_paths)`. Expected: GREEN.
- [ ] Add `test_visual_fixture_generation_output_is_canonical` with a frozen aware UTC clock, exact raw canonical stdout bytes, exact generation-record keys, and exact four absolute database paths.
- [ ] Run the fixture-generation output case before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_generation_output_is_canonical)`. Expected: RED because the output lacks the frozen `generated_at` contract.
- [ ] Implement `generated_at` from the same single aware UTC instant used to seed all four databases in the canonical `agent_workbench_visual_fixture_generation.v1` stdout record.
- [ ] Run the fixture-generation output case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_generation_output_is_canonical)`. Expected: GREEN with exact allowlisted bytes.
- [ ] **GREEN characterization:** Extend the generation-output case with empty-success-stderr and a secret sentinel that must be absent from both streams.
- [ ] Run the generation-output sanitization characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_generation_output_is_canonical)`. Expected: GREEN with no sentinel bytes.
- [ ] Add the twelve mixed-lifecycle Agent registry branch to `test_visual_fixture_active_state`.
- [ ] Run the active registry slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED at generation.
- [ ] Implement the twelve-Agent registry.
- [ ] Run the active registry slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN for registry shape.
- [ ] Extend `test_visual_fixture_active_state` with three qualifying RUNNING Runs across two active owners and the exact `2 个 Agent · 3 个 Run` inputs.
- [ ] Run the active RUNNING/count slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED.
- [ ] Implement the three qualifying RUNNING Runs across two active owners.
- [ ] Run the active RUNNING/count slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN with every `mayAnimateRunning` input true.
- [ ] Extend `test_visual_fixture_active_state` with the disabled unknown signal and local-archiving assertions, including exact equality between the local-archiving row's immutable `terminal_observed_at` and the parsed generation record's `generated_at`.
- [ ] Run the active unknown/archiving assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED.
- [ ] Implement the disabled unknown-signal fixture row.
- [ ] Implement the local-archiving fixture row.
- [ ] Run the active unknown/archiving slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN; receipt/name behavior is not asserted until the next step.
- [ ] Extend the active-fixture test with terminal receipt and 110-character display-name assertions.
- [ ] Run the active receipt/name assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED.
- [ ] Implement the terminal-receipt fixture row.
- [ ] Implement the 110-character display-name fixture row.
- [ ] Run the active receipt/name slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN; incomplete-history coverage is not asserted until the next step.
- [ ] Extend the active-fixture test with incomplete-history coverage and exact real-aggregate/count assertions.
- [ ] Run the active incomplete-history assertions before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED.
- [ ] Implement the incomplete-history fixture row.
- [ ] Run the complete active-fixture case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN.
- [ ] Extend `test_visual_fixture_active_state` with the clock frozen 30 seconds after the exact operator-timezone midnight edge and expectations for exactly 21 receipt-expired terminal history rows for one immutable Agent ID, with every `effective_started_at` and `finished_at` inclusively inside `[today_range_start, generated_at]`.
- [ ] Run the active history-pagination branch before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: RED because the fixture does not yet seed more than one default page for one Agent.
- [ ] Implement the 21 receipt-expired rows with identical `effective_started_at=finished_at=terminal_observed_at=today_range_start`, `receipt_expires_at=today_range_start+10 seconds`, `generated_at=today_range_start+30 seconds`, and deterministic unique Run IDs as the secondary ordering key, without adding any current-state signal.
- [ ] Run the active history timestamp/count slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN with all 21 receipt-expired rows still inside `today` at the midnight edge.
- [ ] **GREEN characterization:** Extend that history branch with the real builder's exact first 20 `(effective_started_at DESC, coreai_run_id DESC)` items and an independently encoded exact non-null `next_before` for `[1, twentieth_effective_started_at, twentieth_coreai_run_id]`.
- [ ] Run the active history first-page characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN with the exact non-null cursor from the existing production builder.
- [ ] **GREEN characterization:** Extend that history branch with a second request passing the exact returned cursor and assertions for the one remaining Run, no duplicates, stable Agent ownership, and `next_before=null`.
- [ ] Run the complete active-fixture case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_active_state)`. Expected: GREEN with deterministic 20-plus-one pagination.
- [ ] Add `test_visual_fixture_idle_state` with exact-fresh idle semantics.
- [ ] Run the idle-fixture case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_idle_state)`. Expected: RED.
- [ ] Implement only the exact-fresh idle database.
- [ ] Run the idle-fixture case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_idle_state)`. Expected: GREEN.
- [ ] Add the healthy-exact and lower-bound branches of `test_visual_fixture_partial_state`.
- [ ] Run the first partial-fixture slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: RED.
- [ ] Implement the healthy exact partial-fixture Agent.
- [ ] Implement the lower-bound partial-fixture Agent.
- [ ] Run the first partial-fixture slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: GREEN for those two Agents.
- [ ] Extend `test_visual_fixture_partial_state` with the failed-page/prior-observation branch.
- [ ] Run the failed-page partial-fixture slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: RED.
- [ ] Implement the failed-page/prior-observation partial Agent.
- [ ] Run the failed-page partial-fixture slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: GREEN for that branch.
- [ ] Extend `test_visual_fixture_partial_state` with the never-confirmed Agent and `remote_total_runs=NULL` assertions.
- [ ] Run the never-confirmed partial-fixture slice. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: RED.
- [ ] Implement the never-confirmed partial Agent with unknown total.
- [ ] Run the never-confirmed partial-fixture slice again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: GREEN with `sync_health='partial'`.
- [ ] Extend `test_visual_fixture_partial_state` with an exact 110-character display name on its healthy Agent and assert that the real aggregate preserves all 110 characters.
- [ ] Run the partial long-name branch before implementation. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: RED because `partial.db` does not yet contain the 200%-zoom name fixture.
- [ ] Implement the exact 110-character display name in `partial.db`.
- [ ] Run the complete partial-fixture case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_partial_state)`. Expected: GREEN with `sync_health='partial'` and the untruncated name.
- [ ] Add `test_visual_fixture_stale_state` with expired aggregate/signal boundaries and visible static cached non-terminal rows.
- [ ] Run the stale-fixture case. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_stale_state)`. Expected: RED.
- [ ] Implement only the expired/static cached state.
- [ ] Run the stale-fixture case again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_stale_state)`. Expected: GREEN.
- [ ] Add the active mutation branch to `test_visual_fixture_refreshes_only_marked_scenarios` after advancing beyond 90 seconds, using a frozen aware UTC clock and preview receipt-ID factory to assert the 15-second proof, new ten-second receipt, exact aggregate receipt ID, zero Core AI I/O, and byte-identical pre/post local-archiving `terminal_observed_at` plus local-source timestamp/status tuple.
- [ ] Run the active-refresh mutation branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: RED.
- [ ] Implement the active fixture's 15-second proof refresh without changing the seeded local-archiving observation or local-source facts.
- [ ] Implement insertion of a newly identified ten-second preview receipt without extending any existing receipt.
- [ ] Run the active-refresh mutation branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN.
- [ ] Extend the active-refresh branch by capturing its exact raw stdout bytes and asserting the canonical JSON line defined in reference 11D.
- [ ] Run the active-refresh output branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: RED at structured stdout.
- [ ] Implement the exact secret-safe `agent_workbench_visual_fixture_refresh.v1` JSON stdout record with `scenario`, aware `refreshed_at`, and non-empty `new_receipt_id`.
- [ ] Run the active-refresh output branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN with the rebuilt aggregate's receipt `coreai_run_id` byte-equal to captured `new_receipt_id`.
- [ ] **GREEN characterization:** Extend the active-refresh output branch with sentinel environment/auth values, exact-key allowlisting, and empty-success-stderr assertions.
- [ ] Run the refresh-output sanitization branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN with no sentinel bytes in stdout or stderr.
- [ ] **GREEN characterization:** Extend the active-refresh branch with a second frozen refresh whose exact stdout is captured independently and whose `new_receipt_id` differs from the first.
- [ ] Run the active-refresh uniqueness branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN without moving the first receipt's expiry.
- [ ] Extend the refresh test with the idle scenario after its proof is older than 90 seconds.
- [ ] Run the idle-refresh branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: RED.
- [ ] Implement only the idle exact-zero discovery/current-proof timestamp refresh.
- [ ] Run the idle-refresh branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN with preserved counts, qualities, and history.
- [ ] Extend the refresh test with the partial scenario after its proof is older than 90 seconds.
- [ ] Run the partial-refresh branch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: RED.
- [ ] Implement only the healthy Agent's proof-timestamp refresh.
- [ ] Implement only the incomplete Agents' attempt/last-valid timestamp refreshes.
- [ ] Run the partial-refresh branch again. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN with all lower-bound/unknown/error/Run/total semantics and `sync_health='partial'` preserved.
- [ ] **GREEN characterization:** Extend the refresh test with the stale-scenario rejection row.
- [ ] Run the stale-refresh rejection row. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN rejection.
- [ ] **GREEN characterization:** Extend the refresh test with the unmarked and mismatched-marker rejection rows.
- [ ] Run the marker-rejection rows. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN rejection.
- [ ] **GREEN characterization:** Extend the refresh test with the configured-default-database rejection row.
- [ ] Run the complete marked-scenario refresh selection. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_fixture_refreshes_only_marked_scenarios)`. Expected: GREEN rejection for the default database.
- [ ] **GREEN characterization:** Add `test_visual_preview_auth_uses_fixture_only_environment` that changes to a directory with no `.env`, clears inherited auth/Core AI variables, sets only the fixed non-secret preview exports from reference 11E, builds the real lifespan-disabled app over `active.db`, logs in through `/api/auth/login`, reads `/api/agent-workbench`, and asserts both responses are HTTP 200 while the fixed preview auth secret and an inherited-secret sentinel are absent from response bodies and captured output.
- [ ] Run the fixture-only preview-auth characterization. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_visual_preview_auth_uses_fixture_only_environment)`. Expected: GREEN without reading or requiring `api/.env`.
- [ ] Run the complete fixture/acceptance test file. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q)`.
- [ ] **GREEN cross-task verification:** Add `test_privacy_inventory_allows_only_parser_discard_literals` with AST/schema assertions that forbid exact sensitive persistence identifiers, allow literal `input`/`output` only in Task 4's named Token-key assignments, allow `transcript`/`artifacts`/`error_stack` only in its composed `DISCARDED_UPSTREAM_FIELDS`, and require production references to those constants.
- [ ] Run the GREEN privacy characterization immediately. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)`. Expected: PASS.

If the privacy characterization fails, use the failure-routing rule to correct and separately commit the owning Task 1 or Task 4 contract before resuming Task 11; never leave a production diff in the Task 11 support commit.

- [ ] Verify the operator-approved source environment exists as a regular file without printing it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test -f /Users/xander/git_repo/connexup-seo-ops/api/.env`.
- [ ] Verify that exact source environment is readable without printing it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test -r /Users/xander/git_repo/connexup-seo-ops/api/.env`.
- [ ] Copy that exact source into the isolated checkout without printing it. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && install -m 600 /Users/xander/git_repo/connexup-seo-ops/api/.env api/.env`.
- [ ] Verify the provisioned destination byte-for-byte without printing content. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && cmp -s /Users/xander/git_repo/connexup-seo-ops/api/.env api/.env`.
- [ ] Verify the provisioned destination has owner-only permissions without printing content. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test "$(stat -f '%Lp' api/.env)" = 600`.
- [ ] Verify Git ignores the provisioned destination. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git check-ignore -q -- api/.env`.
- [ ] Run reference 11C's exact read-only port preflight. Expected: ports 8000 and 5173 are both free.
- [ ] Start only reference 11C's scheduler-parked API command in terminal B. Expected: the foreground process remains running.
- [ ] Record the scheduler-parked API's successful startup line.
- [ ] Start only reference 11C's strict-port Vite command in terminal A. Expected: the foreground process remains running.
- [ ] Record Vite's exact 5173 URL.
- [ ] Authenticate at `/agents` without using any management or trigger control.
- [ ] Wait for the first Workbench cycle.
- [ ] Inspect one aggregate Network response. Expected: HTTP 200.
- [ ] Run the Bash syntax gate against reference 11C's exact strict-snapshot block. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && AW_STRICT_SNAPSHOT_BLOCK="$(awk '/^# AW_STRICT_LIVE_SNAPSHOT_SHELL_BEGIN$/{emit=1} emit{print} /^# AW_STRICT_LIVE_SNAPSHOT_SHELL_END$/{exit}' docs/superpowers/plans/2026-09-03-agent-workbench.md)" && test -n "$AW_STRICT_SNAPSHOT_BLOCK" && printf '%s\n' "$AW_STRICT_SNAPSHOT_BLOCK" | bash -n`.
- [ ] Run the zsh syntax gate against reference 11C's exact strict-snapshot block. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && AW_STRICT_SNAPSHOT_BLOCK="$(awk '/^# AW_STRICT_LIVE_SNAPSHOT_SHELL_BEGIN$/{emit=1} emit{print} /^# AW_STRICT_LIVE_SNAPSHOT_SHELL_END$/{exit}' docs/superpowers/plans/2026-09-03-agent-workbench.md)" && test -n "$AW_STRICT_SNAPSHOT_BLOCK" && printf '%s\n' "$AW_STRICT_SNAPSHOT_BLOCK" | zsh -n`.
- [ ] Run reference 11C's exact strict-snapshot static ordering audit.
- [ ] Inspect the strict-snapshot static ordering result. Expected: `STRICT_SNAPSHOT_STATIC_CONTRACT_OK`.
- [ ] Run reference 11C's exact injected-nonpass cross-shell audit. Expected: both Bash and zsh preserve the pre-run locator, capture CLI exit 23 plus pipeline exit 23 and tee exit zero, atomically persist the exact marker, report checklist non-pass, and reach `SHELL_ALIVE_AFTER_NONPASS`.
- [ ] Inspect the injected-nonpass audit result. Expected: `STRICT_SNAPSHOT_NONPASS_AUDIT_OK=bash,zsh`, with no `LIVE_SNAPSHOT_EXIT_ZERO` claim.
- [ ] Run only reference 11C's exact strict snapshot readback in terminal C with its 240-second global deadline; the block retains `snapshot.json`, the external locator, and the atomic exit marker while keeping terminal C alive.
- [ ] Read back the external evidence-directory locator. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test -n "${AW_LIVE_EVIDENCE_DIR:-}" && test -n "${AW_LIVE_EVIDENCE_LOCATOR:-}" && test "$(tr -d '\n' < "$AW_LIVE_EVIDENCE_LOCATOR")" = "$AW_LIVE_EVIDENCE_DIR" && printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "$AW_LIVE_EVIDENCE_DIR"`.
- [ ] Read back the strict snapshot's atomic exit marker with reference 11C's exact non-fatal marker-readback block. Expected for live acceptance: schema `agent_workbench_live_snapshot_exit.v1` with numeric `cli_exit=0`, `pipeline_exit=0`, and `tee_exit=0`; every other value or shape is explicit checklist non-pass without killing terminal C.
- [ ] Record any non-zero `LIVE_GATE_UNAVAILABLE`, `LIVE_GATE_MISMATCH`, `LIVE_GATE_UNSTABLE`, or `LIVE_GATE_TIMEOUT` code as incomplete live acceptance.
- [ ] Inspect `snapshot.json` only after the all-zero marker for a clean local bracket, one stable segment per Agent, and `active_transition_candidates`; do not infer a transition from the snapshot alone.
- [ ] Run reference 11C's exact **owned observer launch** block asynchronously in terminal C. Expected: immediate return with the selected Run ID/PID plus stdout/stderr/exit paths, or an explicit `LIVE_TRANSITION_NOT_OBSERVED` no-candidate marker, without starting a Run.
- [ ] While the read-only observer runs, execute the full API suite. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests -v)`.
- [ ] Record the full API-suite result.
- [ ] Execute the complete frontend test suite. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm test)`.
- [ ] Record the complete frontend test-suite result.
- [ ] Execute frontend lint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm run lint)`.
- [ ] Record the frontend-lint result.
- [ ] Execute the production frontend build. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd web && npm run build)`.
- [ ] Record the production-build result.
- [ ] Prove Workbench production code contains no single-Run detail call. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && if rg -n 'get_run\(' api/app/agent_workbench.py; then exit 1; fi`.
- [ ] Prove there is no Agent hard-delete route. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && if rg -n 'DELETE.*/api/agent-workbench|@router.delete' api/app/agent_workbench.py web/src; then exit 1; fi`.
- [ ] Check the full unstaged patch for whitespace errors. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git diff --check`.
- [ ] Run reference 11C's exact **non-blocking observer inspection** block after the automated gates; do not add a wait loop.
- [ ] Inspect the non-blocking observer result. If it exited, require the same candidate's eligible-RUNNING start, terminal transition to one of `COMPLETED`, `FAILED`, `TIMEOUT`, `CANCELLED`, or `SKIPPED`, and final direct-list/SQLite Token equality; if it is still running, leave this evidence item unchecked.
- [ ] Run reference 11C's exact **mandatory observer finalization** block for every candidate-present path, including a still-active child, one that ended naturally after inspection, or one already reaped.
- [ ] Inspect the observer-finalization markers. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}" && if test -n "${AW_LIVE_EVIDENCE_DIR:-}" && test -f "$AW_LIVE_EVIDENCE_DIR/transition.validated" && test ! -f "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"; then echo LIVE_TRANSITION_VALIDATED; else echo LIVE_TRANSITION_NOT_OBSERVED; fi`. Expected: pass only when `transition.validated` exists and `transition.not-observed` does not; every other shape is an explicit non-pass while terminal C remains available.
- [ ] Record rollout step 5 from those markers. Only same-ID proof may pass; every other result is `LIVE_TRANSITION_NOT_OBSERVED` and never authorizes a replacement ID or trigger.
- [ ] Stop the scheduler-parked API in terminal B with Ctrl-C.
- [ ] Wait for terminal B's awaited lifespan-shutdown prompt.
- [ ] Prove port 8000 is free before preview while leaving the identified Vite process running. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && if lsof -nP -iTCP:8000 -sTCP:LISTEN; then exit 1; fi`.
- [ ] In control terminal C, invalidate every prior visual-fixture shell export so no earlier database can be reused. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && unset AW_PREVIEW_DIR AW_PREVIEW_GENERATION_OUTPUT AW_PREVIEW_GENERATED_AT AW_ACTIVE_REFRESH_OUTPUT AW_EXPECTED_REFRESHED_AT AW_EXPECTED_RECEIPT_ID AW_NONACTIVE_REFRESH_OUTPUT AW_EXPECTED_REFRESH_SCENARIO`.
- [ ] In control terminal C, allocate one new disposable fixture directory after the live API has stopped. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && export AW_PREVIEW_DIR="$(mktemp -d)"`.
- [ ] In control terminal C, allocate one generation-record file outside the still-empty fixture directory. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && export AW_PREVIEW_GENERATION_OUTPUT="$(mktemp)"`.
- [ ] Generate the four databases from reference 11D into that new empty directory while retaining the helper's exact structured stdout. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && set -o pipefail && (cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --output-dir "$AW_PREVIEW_DIR") | tee "$AW_PREVIEW_GENERATION_OUTPUT"`.
- [ ] Validate the exact generation record in control terminal C. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -c 'from datetime import datetime,timedelta; import json,os,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"database_paths","generated_at","output_dir","schema_version"}; assert data["schema_version"] == "agent_workbench_visual_fixture_generation.v1"; assert data["output_dir"] == sys.argv[2]; scenarios=("active","idle","partial","stale"); assert data["database_paths"] == {name: os.path.join(sys.argv[2], name+".db") for name in scenarios}; value=data["generated_at"]; assert isinstance(value,str) and value.endswith("Z"); parsed=datetime.fromisoformat(value[:-1]+"+00:00"); assert parsed.utcoffset() == timedelta(0); print(data["output_dir"])' "$AW_PREVIEW_GENERATION_OUTPUT" "$AW_PREVIEW_DIR")`.
- [ ] Freeze the validated safe generation timestamp in control terminal C. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && AW_PREVIEW_GENERATED_AT="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print(data["generated_at"])' "$AW_PREVIEW_GENERATION_OUTPUT")" && export AW_PREVIEW_GENERATED_AT`.
- [ ] In control terminal C, run the exact 11E **active refresh capture** block; it retains the helper's exact structured stdout in the newly assigned `AW_ACTIVE_REFRESH_OUTPUT` file.
- [ ] Run the exact 11E **active refresh readback** block in control terminal C. Expected: it freezes the emitted aware `refreshed_at` and non-empty `new_receipt_id` in exported shell variables without reading secrets.
- [ ] In terminal B, export the exact `AW_PREVIEW_DIR` value reported by generation.
- [ ] Validate the active fixture database before launch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test -n "${AW_PREVIEW_DIR:-}" && test -d "$AW_PREVIEW_DIR" && test -f "$AW_PREVIEW_DIR/active.db"`.
- [ ] Run the exact 11E **pre-launch generation-age guard** in control terminal C. Expected: PASS only while the factual local-archiving observation remains less than 60 seconds old.
- [ ] Start only the exact 11E active preview command in terminal B. Expected: the foreground server remains running.
- [ ] Record the active preview API's 8000 startup line.
- [ ] Authenticate the active preview at `/agents` with the fixed fixture-only `preview-operator` / `preview-only-password` values from its explicit exports; do not reuse or inspect any real-environment credential.
- [ ] Inspect the preview login response. Expected: HTTP 200, a working fixture-only session, and neither the fixed fixture auth secret nor any inherited-secret sentinel in response bodies or console/server output.
- [ ] On `/agents`, press `刷新显示` immediately.
- [ ] Inspect the active aggregate Network response. Expected: HTTP 200.
- [ ] Compare the HTTP aggregate's preview receipt signal `coreai_run_id` byte-for-byte with exported `AW_EXPECTED_RECEIPT_ID`.
- [ ] Compare that receipt's timing with exported `AW_EXPECTED_REFRESHED_AT`. Expected: the production ten-second window.
- [ ] Compare the HTTP aggregate's local-archiving `terminal_observed_at` byte-for-byte with exported `AW_PREVIEW_GENERATED_AT`.
- [ ] Inspect the HTTP aggregate's local-archiving age at its own `snapshot_at`. Expected: `0 <= snapshot_at - terminal_observed_at < 300 seconds`, `signal_state='archiving'`, and `ARCHIVE_DELAY` is absent.
- [ ] Set the active viewport to 1180 CSS pixels.
- [ ] Inspect active at 1180 CSS pixels for scoped motion, color, and counts.
- [ ] Record the active 1180-pixel evidence.
- [ ] Capture one active screenshot outside the source tree while the just-proved factual local-archiving row is still in its five-minute window.
- [ ] Record the aggregate Network timestamp corresponding to that active screenshot.
- [ ] Run the exact 11E **active refresh capture** block again in control terminal C.
- [ ] Run the exact 11E **active refresh readback** block again; require a newly emitted receipt ID.
- [ ] Press `刷新显示` once for the 1440-pixel proof.
- [ ] Inspect that active aggregate Network response. Expected: HTTP 200 with a receipt `coreai_run_id` equal to `AW_EXPECTED_RECEIPT_ID`.
- [ ] Set the active viewport to 1440 CSS pixels.
- [ ] Inspect active at 1440 CSS pixels for scoped motion, color, and counts.
- [ ] Record the active 1440-pixel evidence.
- [ ] Run the exact 11E **active refresh capture** block again in control terminal C.
- [ ] Run the exact 11E **active refresh readback** block again; require a newly emitted receipt ID.
- [ ] Press `刷新显示` once for the 1920-pixel proof.
- [ ] Inspect that active aggregate Network response. Expected: HTTP 200 with a receipt `coreai_run_id` equal to `AW_EXPECTED_RECEIPT_ID`.
- [ ] Set the active viewport to 1920 CSS pixels.
- [ ] Inspect active at 1920 CSS pixels for scoped motion, color, and counts.
- [ ] Record the active 1920-pixel evidence.
- [ ] Set browser zoom to 200% without reloading or navigating; do not treat the old presentation as new evidence.
- [ ] Run the exact 11E **active refresh capture** block again in control terminal C.
- [ ] Run the exact 11E **active refresh readback** block again; require a newly emitted receipt ID.
- [ ] Hard reload or directly navigate to `/agents` at 200% zoom.
- [ ] Inspect the new active aggregate response. Expected: HTTP 200 with a receipt `coreai_run_id` equal to `AW_EXPECTED_RECEIPT_ID`.
- [ ] Record active 200% loading-to-final-snapshot behavior from that new page request.
- [ ] Record active 200% Workbench page-overflow behavior.
- [ ] Record active 200% table reflow.
- [ ] Record active 200% drawer reflow.
- [ ] Traverse the active 200% page by keyboard.
- [ ] Record visible ordered focus from the keyboard traversal.
- [ ] Return browser zoom to 100%.
- [ ] Set the active viewport to 1180 CSS pixels.
- [ ] Select the `30d` range while automatic updates are running.
- [ ] Wait for the `30d` aggregate response to be accepted before opening history.
- [ ] Expand the fixture Agent that owns the 21 deterministic history rows while automatic updates are running.
- [ ] Inspect its initial history response. Expected: HTTP 200 with exactly 20 ordered items and the tested non-null `next_before`.
- [ ] Keep a different Agent row collapsed.
- [ ] Click `暂停自动更新`.
- [ ] Observe the paused page for 30 seconds.
- [ ] Record zero implicit aggregate/history reads, frozen elapsed/freshness clocks, and absolute snapshot wording from that interval.
- [ ] Set the paused active viewport to 1440 CSS pixels.
- [ ] Choose the `7d` range while paused.
- [ ] Inspect the pending-range state. Expected: zero request plus the explicit pending-range/old-snapshot label.
- [ ] Click `刷新显示` exactly once while paused.
- [ ] Inspect the manual-read Network sequence. Expected: one pending-range aggregate HTTP 200 and no history GET.
- [ ] Inspect post-read presentation. Expected: paused mode remains active and expanded history retains its labelled old-range cache.
- [ ] Click `恢复自动更新`; this is running-mode setup for the later receipt-freeze proof, not the final Resume acceptance.
- [ ] Inspect the immediate Resume request. Expected: exactly one aggregate GET for the pending range.
- [ ] Wait for that aggregate response to be accepted.
- [ ] Inspect the control state. Expected: running mode is active before creating the new receipt.
- [ ] Set the active viewport to 1920 CSS pixels.
- [ ] Run the exact 11E **active refresh capture** block in control terminal C for the receipt-freeze proof.
- [ ] Run the exact 11E **active refresh readback** block. Expected: it exports the emitted `AW_EXPECTED_REFRESHED_AT` and new `AW_EXPECTED_RECEIPT_ID`.
- [ ] Click `刷新显示` immediately.
- [ ] Inspect the new aggregate response. Expected: HTTP 200 within the production ten-second receipt window.
- [ ] Compare the response receipt signal's `coreai_run_id` byte-for-byte with `AW_EXPECTED_RECEIPT_ID`.
- [ ] Focus that exact receipt's Run tab.
- [ ] Click `暂停自动更新` before that receipt's production ten-second window expires.
- [ ] Inspect the paused receipt. Expected: the receipt remains frozen.
- [ ] Inspect the paused Run-tab focus. Expected: selection and focus remain on the same emitted receipt ID.
- [ ] Inspect paused elapsed/freshness values and snapshot wording. Expected: all presentation clocks remain frozen and wording is absolute.
- [ ] Capture one paused screenshot outside the source tree.
- [ ] Record the aggregate Network timestamp that supplied the paused screenshot's exact receipt.
- [ ] Inspect the history-heavy Agent row. Expected: it remains expanded with its labelled old-range cache.
- [ ] Inspect the other Agent row. Expected: it remains collapsed.
- [ ] Select `30d` as the new pending range while paused.
- [ ] Let the real clock pass the frozen receipt's `receipt_expires_at`.
- [ ] Inspect the still-paused state. Expected: zero request and no local visual expiry.
- [ ] Click `恢复自动更新` for the final Resume acceptance.
- [ ] Inspect presentation before any response commits. Expected: synchronous expiry of the old receipt/freshness, static presentation, and no receipt entrance replay.
- [ ] Inspect the immediate Resume request. Expected: exactly one aggregate GET for the pending range and zero history GET before its accepted response.
- [ ] Wait for the pending-range aggregate response to be accepted.
- [ ] Inspect post-aggregate history requests. Expected: exactly one new-range history GET for each still-expanded row and none for collapsed rows.
- [ ] Inspect the expanded row's first new-range history response. Expected: exactly 20 fixture-ordered items and the exact non-null `next_before` frozen by the fixture test.
- [ ] Request one next page of Run history with that exact `next_before` value.
- [ ] Inspect the paginated history. Expected: the twenty-first deterministic Run appends once under the same immutable Agent ID, no first-page item duplicates, and the second response has `next_before=null`.
- [ ] Inspect subsequent aggregate cadence. Expected: non-overlapping 5/30-second scheduling from the accepted server recommendation.
- [ ] Retain the ordered Network timestamps for the complete final Resume sequence.
- [ ] Click `暂停自动更新` again.
- [ ] Set browser zoom to 200%.
- [ ] Hard reload or directly navigate to the stored-paused `/agents` presentation.
- [ ] Inspect stored-paused hydration. Expected: zero initial GET plus usable controls and drawer reflow.
- [ ] Click `刷新显示` exactly once while the stored pause remains active.
- [ ] Inspect that manual hydration request. Expected: exactly one aggregate GET, HTTP 200 from the active fixture, Agent rows become available, and automatic mode remains paused with no timer or history GET.
- [ ] Open the register input drawer.
- [ ] Prove Tab/Shift+Tab wraps inside the register drawer without entering inert `#root` or reaching sidebar/header/logout.
- [ ] Close the register drawer with Escape and require focus to return to its exact opener before continuing.
- [ ] Open the edit input drawer.
- [ ] Prove Tab/Shift+Tab wraps inside the edit drawer without entering inert `#root` or reaching sidebar/header/logout.
- [ ] Close the edit drawer with its close control and require focus to return to that row's exact edit opener before continuing.
- [ ] Open the replace input drawer.
- [ ] Prove Tab/Shift+Tab wraps inside the replace drawer without entering inert `#root` or reaching sidebar/header/logout.
- [ ] Close the replace drawer with Escape and require focus to return to that row's exact replace opener before continuing.
- [ ] Open the input-free retire drawer.
- [ ] Prove the retire drawer receives heading-first focus with forward/reverse wrap and inert-background exclusion.
- [ ] Close the retire drawer with its close control and require focus to return to that row's exact retire opener.
- [ ] Confirm no mutation was submitted during these manual drawer checks; rely on Task 10's controlled deferred-request automated test for pending-close/no-late-update semantics.
- [ ] Exercise the Run tabs using only the keyboard.
- [ ] Inspect the Run-tab semantics. Expected: exactly one selected tab and one corresponding tabpanel.
- [ ] Activate Agent-row expansion through its real button.
- [ ] Inspect the stored-paused expanded row. Expected: the row itself is not an activation target, the uncached-history message is visible, and no history GET occurs.
- [ ] Invoke the Run-ID copy action.
- [ ] Inspect copied and rendered values. Expected: the clipboard has the full ID while the visual label remains shortened.
- [ ] Open each rendered local link without invoking an Agent-state mutation.
- [ ] Record every opened link's accessible name and destination.
- [ ] Turn on reduced motion.
- [ ] Inspect reduced-motion presentation. Expected: every continuous and receipt transition is removed while factual state remains.
- [ ] Turn on forced colors.
- [ ] Inspect forced-colors presentation. Expected: status and focus distinctions remain visible without color alone.
- [ ] Turn off forced colors and reduced motion.
- [ ] Record keyboard focus-ring visibility in the restored default scheme. Manual evidence step.
- [ ] Reset browser zoom to 100%.
- [ ] Click `恢复自动更新` to end the stored-pause acceptance before changing preview scenarios.
- [ ] Inspect presentation before the response commits. Expected: synchronous stale/static downgrade and no restored motion from the cached active snapshot.
- [ ] Inspect the post-Resume request. Expected: exactly one non-overlapping aggregate GET.
- [ ] Wait for that active-fixture response and require HTTP 200.
- [ ] Read back `sessionStorage['seo-ops.agent-workbench.auto-update']` as exactly `running`; this running state must persist through the later idle, partial, and stale reloads.
- [ ] Stop the active preview API in terminal B with Ctrl-C.
- [ ] Wait for terminal B's prompt.
- [ ] Run the exact 11E **idle refresh capture** block in control terminal C immediately before launch.
- [ ] Run the exact 11E **non-active refresh readback** block for idle. Expected: an aware `refreshed_at`, `scenario="idle"`, and `new_receipt_id=null`.
- [ ] Start only the exact 11E idle preview command in terminal B. Expected: the foreground server remains running.
- [ ] Record the idle preview API's 8000 startup line.
- [ ] Press `刷新显示` once for the initial idle proof.
- [ ] Inspect the idle aggregate Network response. Expected: HTTP 200.
- [ ] Set the idle viewport to 1180 CSS pixels.
- [ ] Inspect idle at 1180 CSS pixels for exact-idle state and non-overlapping 30-second cadence.
- [ ] Record the idle 1180-pixel evidence.
- [ ] Run the exact 11E **idle refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for idle.
- [ ] Press `刷新显示` once for the 1440-pixel idle proof.
- [ ] Inspect that idle aggregate Network response. Expected: HTTP 200.
- [ ] Set the idle viewport to 1440 CSS pixels.
- [ ] Inspect idle at 1440 CSS pixels for exact-idle state and non-overlapping 30-second cadence.
- [ ] Record the idle 1440-pixel evidence.
- [ ] Run the exact 11E **idle refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for idle.
- [ ] Press `刷新显示` once for the 1920-pixel idle proof.
- [ ] Inspect that idle aggregate Network response. Expected: HTTP 200.
- [ ] Set the idle viewport to 1920 CSS pixels.
- [ ] Inspect idle at 1920 CSS pixels for exact-idle state and non-overlapping 30-second cadence.
- [ ] Record the idle 1920-pixel evidence.
- [ ] Set browser zoom to 200% for idle.
- [ ] Run the exact 11E **idle refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for idle.
- [ ] Hard reload or directly navigate to idle `/agents` under the new-page protocol.
- [ ] Inspect the new idle aggregate response. Expected: HTTP 200.
- [ ] Record idle 200% reflow and focus evidence from that new page request.
- [ ] Capture one idle screenshot outside the source tree.
- [ ] Record the idle aggregate Network timestamp corresponding to that screenshot.
- [ ] Reset browser zoom to 100% before leaving the idle scenario, so the next scenario's ordinary-width matrix starts from an independent default-scale page.
- [ ] Stop the idle preview API in terminal B with Ctrl-C.
- [ ] Wait for terminal B's prompt.
- [ ] Run the exact 11E **partial refresh capture** block in control terminal C immediately before launch.
- [ ] Run the exact 11E **non-active refresh readback** block for partial. Expected: an aware `refreshed_at`, `scenario="partial"`, and `new_receipt_id=null`.
- [ ] Start only the exact 11E partial preview command in terminal B. Expected: the foreground server remains running.
- [ ] Record the partial preview API's 8000 startup line.
- [ ] Press `刷新显示` once for the initial partial proof.
- [ ] Inspect the partial aggregate Network response. Expected: HTTP 200.
- [ ] Set the partial viewport to 1180 CSS pixels.
- [ ] Inspect partial at 1180 CSS pixels for qualified counts, static signals, and no-idle state.
- [ ] Record the partial 1180-pixel evidence.
- [ ] Run the exact 11E **partial refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for partial.
- [ ] Press `刷新显示` once for the 1440-pixel partial proof.
- [ ] Inspect that partial aggregate Network response. Expected: HTTP 200.
- [ ] Set the partial viewport to 1440 CSS pixels.
- [ ] Inspect partial at 1440 CSS pixels for qualified counts, static signals, and no-idle state.
- [ ] Record the partial 1440-pixel evidence.
- [ ] Run the exact 11E **partial refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for partial.
- [ ] Press `刷新显示` once for the 1920-pixel partial proof.
- [ ] Inspect that partial aggregate Network response. Expected: HTTP 200.
- [ ] Set the partial viewport to 1920 CSS pixels.
- [ ] Inspect partial at 1920 CSS pixels for qualified counts, static signals, and no-idle state.
- [ ] Record the partial 1920-pixel evidence.
- [ ] Set browser zoom to 200% for partial.
- [ ] Run the exact 11E **partial refresh capture** block again.
- [ ] Run the exact 11E **non-active refresh readback** block for partial.
- [ ] Hard reload or directly navigate to partial `/agents` under the new-page protocol.
- [ ] Inspect the new partial aggregate response. Expected: HTTP 200.
- [ ] Record partial 200% reflow and long-name evidence from that new page request.
- [ ] Capture one partial screenshot outside the source tree.
- [ ] Record the partial aggregate Network timestamp corresponding to that screenshot.
- [ ] Reset browser zoom to 100% before leaving the partial scenario, so stale ordinary-width evidence cannot inherit the partial 200% scale.
- [ ] Stop the partial preview API in terminal B with Ctrl-C.
- [ ] Wait for terminal B's prompt.
- [ ] Confirm from retained refresh records that no stale refresh was run.
- [ ] Start only the exact 11E stale preview command in terminal B. Expected: the foreground server remains running.
- [ ] Record the stale preview API's 8000 startup line.
- [ ] Hard reload `/agents` against stale without refreshing the fixture.
- [ ] Inspect the stale aggregate Network response. Expected: HTTP 200.
- [ ] Set the stale viewport to 1180 CSS pixels.
- [ ] Inspect stale at 1180 CSS pixels for expired motion and current-copy downgrade.
- [ ] Record the stale 1180-pixel evidence.
- [ ] Set the stale viewport to 1440 CSS pixels.
- [ ] Inspect stale at 1440 CSS pixels for expired motion and current-copy downgrade.
- [ ] Record the stale 1440-pixel evidence.
- [ ] Set the stale viewport to 1920 CSS pixels.
- [ ] Inspect stale at 1920 CSS pixels for expired motion and current-copy downgrade.
- [ ] Record the stale 1920-pixel evidence.
- [ ] Set browser zoom to 200% for stale.
- [ ] Hard reload or directly navigate to stale `/agents` under the new-page protocol.
- [ ] Record stale 200% reflow and fallback evidence.
- [ ] Capture one stale screenshot outside the source tree.
- [ ] Record the stale aggregate Network timestamp corresponding to that screenshot.
- [ ] Stop the preview API in terminal B with Ctrl-C.
- [ ] Wait for terminal B's prompt.
- [ ] Stop Vite in terminal A with Ctrl-C.
- [ ] Wait for terminal A's prompt.
- [ ] Prove neither acceptance server remains. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && if lsof -nP -iTCP:8000 -sTCP:LISTEN || lsof -nP -iTCP:5173 -sTCP:LISTEN; then exit 1; fi`.
- [ ] Re-run the acceptance privacy allowlist after manual evidence. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && (cd api && .venv/bin/python -m pytest tests/test_agent_workbench_acceptance.py -q -k test_privacy_inventory_allows_only_parser_discard_literals)`.
- [ ] Stage exactly the four Task 11 support files. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git add -- api/tests/test_agent_workbench_acceptance.py api/tests/agent_workbench_live_app.py api/tests/agent_workbench_live_readback.py api/tests/agent_workbench_visual_fixture.py`.
- [ ] Assert the sorted staged-name set from the final checkpoint. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && AW_STAGED_NAMES="$(git diff --cached --name-only | LC_ALL=C sort)" && AW_EXPECTED_NAMES="$(printf '%s\n' api/tests/agent_workbench_live_app.py api/tests/agent_workbench_live_readback.py api/tests/agent_workbench_visual_fixture.py api/tests/test_agent_workbench_acceptance.py | LC_ALL=C sort)" && test "$AW_STAGED_NAMES" = "$AW_EXPECTED_NAMES" && printf '%s\n' "$AW_STAGED_NAMES"`.
- [ ] Inspect the complete staged patch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git diff --cached`.
- [ ] Check the staged patch for whitespace errors. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git diff --cached --check`.
- [ ] Commit only the inspected Task 11 support patch. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git commit -m "test: prove agent workbench truth path"`.
- [ ] Inspect final commit history. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && git log --oneline --decorate -12`.
- [ ] Prove the isolated worktree is clean before handoff. Exact feedback command: `cd "$(git rev-parse --show-toplevel)" && test -z "$(git status --porcelain)"`.

**Contract reference 11A: Running-to-terminal truth path**

Use a temporary SQLite database, logged-in TestClient, dependency-injected list-only Core AI fake, and a controllable aware clock. Inject three independent cancellation-aware parked lifespan coroutines—for the ordinary scheduler, Local Falcon scheduler, and Workbench loop—so the fake-backed test drives `sync_registered_agent_runs_once` explicitly and cannot race any background tick. Only the separate 11C scheduler-parked live app runs the real Workbench loop. Execute this exact sequence:

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

The mandatory checklist above is the only release/static execution sequence. Passing requires all four automated gates, both guarded forbidden-boundary searches, `git diff --check`, and the AST/schema privacy allowlist; a frontend build alone is not acceptance.

**Implementation and execution reference 11C: Read back configured Core AI without starting a Run**

Implement `api/tests/agent_workbench_live_app.py` as an acceptance-only module, never a production configuration switch. Its exported `app` must call Task 7's real `create_app(create_lifespan(initialize_writable_application, ...))`, inject distinct cancellation-aware parked coroutines in place of `scheduler_loop` and `fbr_scheduler_loop`, and inject the real `agent_workbench_sync_loop`; therefore startup still initializes/seeds/primes the real database and the Workbench proof worker actually runs, while automatic SEO scans, Local Falcon scheduling, and every scheduler-originated trigger are impossible. Its test injects event recorders, asserts full production route/auth parity, zero calls to either ordinary scheduler and all trigger clients, one Workbench-loop start, and cancellation/awaited finalization for all three tasks—even when one parked finalizer raises.

The separate `restart_probe_app` is guarded to a marker-owned pytest temporary database and chooses its callables only inside this test module. Write phase uses a guarded startup that calls the real writable initializer and inserts only the fixed terminal fixture, followed by three parked loops. Read phase uses a no-write startup that opens the existing database in SQLite URI `mode=ro`, validates the required schema/fixture, and closes; it never calls `init_db`, seed, prime, or a write helper. Build the same real app/router, override `get_db` with a request-owned `mode=ro`/`PRAGMA query_only=ON` connection, install a SQLite authorizer/test write hook that rejects INSERT/UPDATE/DELETE/DDL/ATTACH/writable PRAGMA, and use three independently instrumented parked loops. Assert module import/app construction is I/O-free, process-B connection `total_changes` stays zero, every attempted write would fail, and the database plus sidecar-file hashes/set are identical before/after B. The `mode=ro` rejected-write and unchanged-file checks are GREEN characterizations because that URI mode already supplies those properties. Prove the two additional defenses independently: inject a deliberately read-write request connection to make the missing-`query_only` case genuinely RED, then use a recording connection seam to make missing authorizer installation genuinely RED and assert its callback denies write action codes while permitting ordinary reads. Neither phase adds a route. Never run the live gate against normal `app.main:app`.

Implement `api/tests/agent_workbench_live_readback.py` as a read-only CLI with required arguments `--env-file`, `--api-url`, `--range`, and optional `--strict`, `--overall-timeout-seconds`, `--observe-run-id`, and `--observe-seconds`. Bound the one-shot reconciliation deadline to 1..240 seconds with default 240; it uses a monotonic deadline across all local brackets, Agent bundles, retry delay, and awaited cancellation, and exits fixed `LIVE_GATE_TIMEOUT` rather than assuming a small registry. `--observe-run-id` and `--observe-seconds` must appear together; bound the sanitized non-empty ID to 200 characters and observation duration to 1..3600 seconds. Observe mode may live longer as an asynchronously owned process, but each reconciliation round/final direct bundle still obeys the same remaining per-round deadline and cleans up workers. Before reading the named env file, local auth secret, or constructing a cookie, parse `--api-url` and accept only `http://127.0.0.1:<explicit-port>` or `http://localhost:<explicit-port>` with no userinfo, path, query, or fragment; reject every other target. After URL validation, parse the named env file into a private mapping without logging values. That file is authoritative for every local-auth, database, Core AI, and `SEO_OPS_*` value consumed by the CLI: ignore conflicting parent-process values, never fall back to ambient values for those keys, and do not mutate the global process environment. Use an HTTP client with `follow_redirects=False` and fail any 3xx response without following it. Only after those validations may the CLI create an operator session cookie from the configured local auth secret, GET the running app's aggregate, open SQLite read-only, and call only Core AI `get_agent()` plus bounded unfiltered/PENDING/RUNNING/PAUSED list GETs. The report contains IDs, statuses, counts, timestamps, and Token sums only; it must never serialize credentials, input, output, errors, stacks, artifacts, response bodies, or the session cookie. Before any stderr/JSON/exception boundary, map transport, HTTP, malformed, timeout, and unexpected failures directly to a stable code plus fixed generic message. Never inspect or sanitize-forward `CoreAiError.args`, an arbitrary exception string/message, repr, response body, header, cookie, or nested cause; only Workbench-defined safe contract codes and locally constructed validation messages may be emitted. Suppress raw exception chaining.

Freeze these reconciliation rules and cover them with fakes from `test_agent_workbench_acceptance.py` before the live run:

1. Compare the non-empty IDs from `configured_agent_slots(private_env_mapping)` with the registry by exact Core AI ID. The explicit mapping is the already validated named-file mapping and cannot borrow a missing value from the parent process environment. Configured IDs may be a subset of an arbitrary registry, but `configured_not_registered` must be empty after startup seeding.
2. Compare every registry ID and lifecycle with `aggregate.agents`, including retired rows, as an exact set-and-value match. Inside the short clock-sensitive local bracket defined below, compare every persisted Agent sync/count/quality/error/timestamp value with the same aggregate Agent item; retired rows are never exempt from aggregate/SQLite integrity. Do not reuse those clock fields as the stability marker for the longer direct-Core-AI segments.
3. Form the de-duplicated union of every active registry Core AI ID and every configured Core AI ID. For every ID in that union, perform one direct `get_agent()` plus bounded unfiltered/PENDING/RUNNING/PAUSED read in each reconciliation attempt regardless of persisted next-due timestamps; the CLI is a read-only validation probe, not the background scheduler. Require every direct metadata ID to equal its requested ID. Disabled/retired rows remain aggregate/SQLite checked but receive no direct live read unless also present in the configured-ID union.
4. Merge the unfiltered and three filtered returned rows by Run ID. Before any global-ID lookup, require every returned row's `agent_id` to equal the requested Core AI Agent for that bundle; then require the matching projected row's `seo_ops_agent_id` to equal that bundle's local registry ID. A wrong upstream owner is a structural mismatch and a wrong local projection owner is a reconciliation mismatch, including in truncated/subset branches. A same-cycle status conflict is itself a mismatch for that attempt. Every directly returned Run ID, not merely an overlap found by accident, must exist in `seo_ops_agent_runs`; for each non-conflicting ID compare raw status and a valid nullable Token pair. A missing projected ID is a mismatch even when upstream/projected totals happen to be equal. Independently enumerate every projected row with `last_synced_at IS NULL`, regardless of whether its raw status is PENDING, RUNNING, PAUSED, any known terminal/SKIPPED value, a future non-empty value, or NULL. Each is an unresolved accepted event and makes the clean live gate fail with `LIVE_GATE_UNCONFIRMED_RUN` until a valid direct page actually observes that exact ID and the persisted projection subsequently agrees on its list-confirmed status/identity. A truncated page may explain absence but cannot turn any such row into a clean pass. When the unfiltered page is untruncated and local history coverage is complete, require its ID set to equal all projected IDs for that exact Agent. When a filtered status page is untruncated and the matching local set quality is exact at the same proof watermark, require its ID set to equal that Agent projection's proven set for that status. For a truncated page require only same-owner returned-ID subset plus field equality after the independent unresolved-row gate has passed; extra list-confirmed projected history is not an error. Filtered PENDING/RUNNING/PAUSED IDs participate, not only the recent unfiltered page.
5. Report each direct unfiltered `total`, returned count, raw-status counts, bounded known-Token run count, bounded known input/output/total Tokens, and the projection's recorded remote total. A strict total mismatch fails only after one stable retry; when a page is truncated, label Token comparison `bounded_overlap` and never claim all-history Token equality.
6. Parse the authenticated aggregate's own `snapshot_at`, pass that exact aware instant plus the same range/timezone/history limit into `build_workbench_snapshot` on a read-only SQLite connection, and compare the complete canonical response, including persisted sync timestamps and request-time-derived freshness/elapsed fields. This avoids millisecond drift instead of maintaining an exclusion list. When `range_complete` is true, require the aggregate known Token sums to equal the complete projected range query; otherwise label them projected/incomplete rather than comparing them with a truncated Core AI page.
7. Treat missing configured registration and metadata ID mismatch as structural failures. Do not demand one global stability window across `5 × Agent count` upstream calls. First validate aggregate versus the same-range SQLite-built snapshot in its own short clock-sensitive double-read bracket: hash every local row/value that can affect the Workbench builder (all three Workbench tables plus referenced merchant/source association state), GET the aggregate, build the local snapshot at the aggregate's exact `snapshot_at`, then recompute that full local hash. Discard and retry this short bracket once if the hash changed; otherwise any response/readback difference is a stable mismatch. Next process Agent bundles with at most `MAX_LIVE_READBACK_WORKERS = 8` concurrent workers; calls within one Agent bundle remain serialized. Each bundle reads that Agent's local semantic snapshot and marker, performs metadata plus four direct lists, then rereads only that Agent. This longer-window marker is `(local_event_epoch, projection_revision, canonical projected-run/current-count/registry semantic hash)` and deliberately excludes observation/freshness/due/lease timestamps, so a clock-only 30-second proof may cross the bundle without false instability while any material identity/status/Token/association/quality/error/receipt/coverage/lifecycle change invalidates it. Compare direct data only with the post-read from the same stable segment, record its own observed interval, and never describe per-Agent segments as one simultaneous global upstream snapshot. After all bundles, rerun the short aggregate/SQLite bracket and reread each Agent's semantic marker; retry only a segment whose marker changed or whose first stable comparison mismatched, after one normal 30-second proof interval. Never splice remote data from one segment attempt to local data from another. The entire one-shot gate shares the validated monotonic deadline; stop dispatching, cancel/await workers, and return `LIVE_GATE_TIMEOUT` by 240 seconds even for an arbitrarily large registry. A clean stable local bracket plus one clean stable segment per Agent succeeds. Repeated identical stable mismatch exits non-zero `LIVE_GATE_MISMATCH`; a changed segment after its sole retry, differing stable mismatch fingerprints, or a local bracket that never stabilizes exits non-zero `LIVE_GATE_UNSTABLE`. Missing credentials/auth, inaccessible Core AI, or no registered Agent exits with `LIVE_GATE_UNAVAILABLE`. Every non-zero outcome prevents a live-acceptance claim.
8. Do not start a Run. A normal clean reconciliation emits `active_transition_candidates` only for already-authorized Runs that are list-confirmed, non-suspect RUNNING under an active registry owner with exact complete/fresh proof, no later poll error, and the same full server-side motion eligibility used by the page; PENDING, PAUSED, stale, incomplete, suspect, unconfirmed, disabled, and retired rows are excluded. Each candidate contains only sanitized Run/Agent IDs and exact raw status, with `transition_observed=not_applicable`; the snapshot gate may exit zero without a transition. To complete rollout step 5, immediately launch observe mode for one such candidate while it is still eligible RUNNING, passing its exact ID plus an operator-chosen bounded duration. Revalidate that exact Run as motion-eligible RUNNING at observe-mode start, poll only the local aggregate/SQLite snapshot at the server-recommended cadence without overlap, and, when it becomes any known terminal status—including SKIPPED—perform a fresh bracketed direct Agent list bundle and require the same terminal status and valid nullable Token pair in SQLite. Success emits exact `observe_run_id`, `start_raw_status='RUNNING'`, `start_motion_eligible=true`, `final_raw_status`, `terminal_token_match=true`, and `transition_observed=true` fields. If the ID is no longer eligible RUNNING at observe-mode start, remains RUNNING through the bound, becomes PAUSED/PENDING without later re-establishing eligible RUNNING, disappears outside evidence, or never obtains matching terminal/Token readback, exit non-zero `LIVE_TRANSITION_NOT_OBSERVED` (or the stricter reconciliation mismatch code). A PENDING/PAUSED-to-terminal path alone can never satisfy this active-to-terminal gate. This mode carries the candidate ID within one process, so it never infers a transition by comparing unrelated CLI invocations.

Only immediately before the real live gate, provision its operator-approved environment independently of bootstrap. Each check below is a separate silent action: verify the source is a regular file, verify it is readable, install exact bytes with owner-only permissions, read back byte identity, read back mode, and prove the destination is ignored. If the exact source is absent, unreadable, or not the operator-approved environment for this integration, do not synthesize credentials; record `LIVE_GATE_UNAVAILABLE` and continue only with fake-backed and disposable visual-fixture verification. Never stage or print `api/.env`; this real file is used only by the scheduler-parked live API/readback/observer, never by a disposable visual preview:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -f /Users/xander/git_repo/connexup-seo-ops/api/.env
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -r /Users/xander/git_repo/connexup-seo-ops/api/.env
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
install -m 600 /Users/xander/git_repo/connexup-seo-ops/api/.env api/.env
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
cmp -s /Users/xander/git_repo/connexup-seo-ops/api/.env api/.env
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test "$(stat -f '%Lp' api/.env)" = 600
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
git check-ignore -q -- api/.env
~~~

Confirm ports 8000 and 5173 are free, then start the scheduler-parked live-gate API and Vite in two terminals with that verified real local `.env`. The live API, strict readback, and observer process each start through `env -i` with only `PATH` and a safe temporary-directory path inherited; therefore the verified file is the sole authority for their local-auth, database, Core AI, and `SEO_OPS_*` configuration. Abort on any occupied port; do not accept an auto-selected replacement port or reuse an unidentified existing server:

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
(cd api && env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
  .venv/bin/uvicorn agent_workbench_live_app:app --app-dir tests --host 127.0.0.1 --port 8000 --env-file .env)
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
# AW_STRICT_LIVE_SNAPSHOT_SHELL_BEGIN
set +e
unset AW_LIVE_EVIDENCE_DIR AW_LIVE_EVIDENCE_LOCATOR AW_SNAPSHOT_EXIT_MARKER AW_SNAPSHOT_CLI_CODE AW_SNAPSHOT_TEE_CODE AW_SNAPSHOT_PIPELINE_CODE
AW_LIVE_EVIDENCE_DIR="$(mktemp -d)"
AW_LIVE_EVIDENCE_LOCATOR="$(mktemp)"
export AW_LIVE_EVIDENCE_DIR AW_LIVE_EVIDENCE_LOCATOR
AW_LIVE_EVIDENCE_READY=false
if test -n "$AW_LIVE_EVIDENCE_DIR" && test -d "$AW_LIVE_EVIDENCE_DIR" && test -n "$AW_LIVE_EVIDENCE_LOCATOR"; then
  AW_LIVE_EVIDENCE_LOCATOR_TMP="$AW_LIVE_EVIDENCE_LOCATOR.tmp.$$"
  if printf '%s\n' "$AW_LIVE_EVIDENCE_DIR" > "$AW_LIVE_EVIDENCE_LOCATOR_TMP" && mv -- "$AW_LIVE_EVIDENCE_LOCATOR_TMP" "$AW_LIVE_EVIDENCE_LOCATOR"; then
    AW_LIVE_EVIDENCE_READY=true
  fi
fi
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
printf 'AW_LIVE_EVIDENCE_LOCATOR=%s\n' "${AW_LIVE_EVIDENCE_LOCATOR:-UNSET}"
AW_SNAPSHOT_CLI_CODE=125
AW_SNAPSHOT_TEE_CODE=125
AW_SNAPSHOT_PIPELINE_CODE=125
if test "$AW_LIVE_EVIDENCE_READY" != true; then
  echo "CHECKLIST_NONPASS: strict snapshot evidence directory/locator was not persisted" >&2
elif test -n "${BASH_VERSION:-}"; then
  (cd api && env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    .venv/bin/python tests/agent_workbench_live_readback.py \
    --env-file .env \
    --api-url http://127.0.0.1:8000 \
    --range 30d \
    --overall-timeout-seconds 240 \
    --strict) | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"
  AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${PIPESTATUS[@]}")
  AW_SNAPSHOT_CLI_CODE="${AW_SNAPSHOT_PIPE_CODES[0]}"
  AW_SNAPSHOT_TEE_CODE="${AW_SNAPSHOT_PIPE_CODES[1]}"
elif test -n "${ZSH_VERSION:-}"; then
  (cd api && env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    .venv/bin/python tests/agent_workbench_live_readback.py \
    --env-file .env \
    --api-url http://127.0.0.1:8000 \
    --range 30d \
    --overall-timeout-seconds 240 \
    --strict) | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"
  AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${pipestatus[@]}")
  AW_SNAPSHOT_CLI_CODE="${AW_SNAPSHOT_PIPE_CODES[1]}"
  AW_SNAPSHOT_TEE_CODE="${AW_SNAPSHOT_PIPE_CODES[2]}"
else
  echo "CHECKLIST_NONPASS: strict snapshot requires Bash or zsh status semantics" >&2
fi
AW_SNAPSHOT_EXIT_MARKER=""
AW_SNAPSHOT_EXIT_MARKER_WRITTEN=false
if test "$AW_LIVE_EVIDENCE_READY" = true; then
  AW_SNAPSHOT_EXIT_MARKER="$AW_LIVE_EVIDENCE_DIR/snapshot.exit.json"
  AW_SNAPSHOT_EXIT_MARKER_TMP="$AW_SNAPSHOT_EXIT_MARKER.tmp.$$"
  if printf '{"cli_exit":%s,"pipeline_exit":%s,"schema_version":"agent_workbench_live_snapshot_exit.v1","tee_exit":%s}\n' "$AW_SNAPSHOT_CLI_CODE" "$AW_SNAPSHOT_PIPELINE_CODE" "$AW_SNAPSHOT_TEE_CODE" > "$AW_SNAPSHOT_EXIT_MARKER_TMP" && mv -- "$AW_SNAPSHOT_EXIT_MARKER_TMP" "$AW_SNAPSHOT_EXIT_MARKER"; then
    AW_SNAPSHOT_EXIT_MARKER_WRITTEN=true
  fi
fi
export AW_SNAPSHOT_EXIT_MARKER AW_SNAPSHOT_CLI_CODE AW_SNAPSHOT_TEE_CODE AW_SNAPSHOT_PIPELINE_CODE
if test "$AW_SNAPSHOT_EXIT_MARKER_WRITTEN" = true && test "$AW_SNAPSHOT_CLI_CODE" -eq 0 && test "$AW_SNAPSHOT_TEE_CODE" -eq 0 && test "$AW_SNAPSHOT_PIPELINE_CODE" -eq 0; then
  echo "LIVE_SNAPSHOT_EXIT_ZERO"
else
  printf 'CHECKLIST_NONPASS: strict snapshot cli_exit=%s tee_exit=%s pipeline_exit=%s marker_written=%s\n' "$AW_SNAPSHOT_CLI_CODE" "$AW_SNAPSHOT_TEE_CODE" "$AW_SNAPSHOT_PIPELINE_CODE" "$AW_SNAPSHOT_EXIT_MARKER_WRITTEN" >&2
fi
set -e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
printf 'AW_LIVE_EVIDENCE_LOCATOR=%s\n' "${AW_LIVE_EVIDENCE_LOCATOR:-UNSET}"
# AW_STRICT_LIVE_SNAPSHOT_SHELL_END
~~~

Run this exact static ordering audit against the marked block itself. It makes the pre-run locator/print, immediate Bash/zsh status captures, atomic exit marker, non-pass classification, and final `set -e` restoration mechanically reviewable rather than relying on prose:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
python3 - <<'PY'
from pathlib import Path

document = Path("docs/superpowers/plans/2026-09-03-agent-workbench.md").read_text(encoding="utf-8")
start = "# AW_STRICT_LIVE_SNAPSHOT_SHELL_BEGIN\n"
end = "# AW_STRICT_LIVE_SNAPSHOT_SHELL_END\n"
assert document.count(start) == 1
assert document.count(end) == 1
block = start + document.split(start, 1)[1].split(end, 1)[0] + end
set_plus = block.index("set +e\n")
locator_move = block.index('mv -- "$AW_LIVE_EVIDENCE_LOCATOR_TMP" "$AW_LIVE_EVIDENCE_LOCATOR"')
pre_run_print = block.index("printf 'AW_LIVE_EVIDENCE_DIR=%s\\n'")
bash_pipeline = block.index(') | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"')
bash_capture = block.index('AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${PIPESTATUS[@]}")')
zsh_pipeline = block.index(') | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"', bash_pipeline + 1)
zsh_capture = block.index('AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${pipestatus[@]}")')
marker_move = block.index('mv -- "$AW_SNAPSHOT_EXIT_MARKER_TMP" "$AW_SNAPSHOT_EXIT_MARKER"')
nonpass = block.index("CHECKLIST_NONPASS: strict snapshot cli_exit=")
restore = block.rindex("set -e\n")
final_safe_print = block.index("printf 'AW_LIVE_EVIDENCE_DIR=%s\\n'", restore)
assert set_plus < locator_move < pre_run_print < bash_pipeline < bash_capture < zsh_pipeline < zsh_capture < marker_move < nonpass < restore < final_safe_print
assert block[bash_pipeline:bash_capture].count("\n") == 1
assert block[zsh_pipeline:zsh_capture].count("\n") == 1
assert 'exit "$AW_SNAPSHOT_PIPELINE_CODE"' not in block
assert "LIVE_SNAPSHOT_PASS" not in block
print("STRICT_SNAPSHOT_STATIC_CONTRACT_OK")
PY
~~~

The Bash branch copies `${PIPESTATUS[@]}` in the same assignment that captures `$?`; the zsh branch does the corresponding immediate copy from `${pipestatus[@]}` and accounts for zsh's one-based array indexing. No intervening command may overwrite either shell's pipeline-status vector. Run this exact injected-nonpass audit before the real readback; it exercises those two branches with a synthetic CLI exit 23, real `tee`, the same atomic marker shape, and `set -e` restoration without contacting Core AI:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
python3 - <<'PY'
import json
import subprocess
import tempfile
from pathlib import Path

script = r'''
set +e
set -o pipefail
AW_LIVE_EVIDENCE_DIR="$1"
AW_LIVE_EVIDENCE_LOCATOR="$2"
AW_LOCATOR_TMP="$AW_LIVE_EVIDENCE_LOCATOR.tmp.$$"
printf '%s\n' "$AW_LIVE_EVIDENCE_DIR" > "$AW_LOCATOR_TMP" && mv -- "$AW_LOCATOR_TMP" "$AW_LIVE_EVIDENCE_LOCATOR"
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "$AW_LIVE_EVIDENCE_DIR"
printf 'AW_LIVE_EVIDENCE_LOCATOR=%s\n' "$AW_LIVE_EVIDENCE_LOCATOR"
if test -n "${BASH_VERSION:-}"; then
  (printf 'SYNTHETIC_CLI_STARTED\n'; exit 23) | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"
  AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${PIPESTATUS[@]}")
  AW_SNAPSHOT_CLI_CODE="${AW_SNAPSHOT_PIPE_CODES[0]}"
  AW_SNAPSHOT_TEE_CODE="${AW_SNAPSHOT_PIPE_CODES[1]}"
elif test -n "${ZSH_VERSION:-}"; then
  (printf 'SYNTHETIC_CLI_STARTED\n'; exit 23) | tee "$AW_LIVE_EVIDENCE_DIR/snapshot.json"
  AW_SNAPSHOT_PIPELINE_CODE=$? AW_SNAPSHOT_PIPE_CODES=("${pipestatus[@]}")
  AW_SNAPSHOT_CLI_CODE="${AW_SNAPSHOT_PIPE_CODES[1]}"
  AW_SNAPSHOT_TEE_CODE="${AW_SNAPSHOT_PIPE_CODES[2]}"
else
  exit 125
fi
AW_SNAPSHOT_EXIT_MARKER="$AW_LIVE_EVIDENCE_DIR/snapshot.exit.json"
AW_SNAPSHOT_EXIT_MARKER_TMP="$AW_SNAPSHOT_EXIT_MARKER.tmp.$$"
printf '{"cli_exit":%s,"pipeline_exit":%s,"schema_version":"agent_workbench_live_snapshot_exit.v1","tee_exit":%s}\n' "$AW_SNAPSHOT_CLI_CODE" "$AW_SNAPSHOT_PIPELINE_CODE" "$AW_SNAPSHOT_TEE_CODE" > "$AW_SNAPSHOT_EXIT_MARKER_TMP" && mv -- "$AW_SNAPSHOT_EXIT_MARKER_TMP" "$AW_SNAPSHOT_EXIT_MARKER"
if test "$AW_SNAPSHOT_CLI_CODE" -eq 0 && test "$AW_SNAPSHOT_TEE_CODE" -eq 0 && test "$AW_SNAPSHOT_PIPELINE_CODE" -eq 0; then
  echo "LIVE_SNAPSHOT_EXIT_ZERO"
else
  printf 'CHECKLIST_NONPASS: strict snapshot cli_exit=%s tee_exit=%s pipeline_exit=%s\n' "$AW_SNAPSHOT_CLI_CODE" "$AW_SNAPSHOT_TEE_CODE" "$AW_SNAPSHOT_PIPELINE_CODE" >&2
fi
set -e
echo "SHELL_ALIVE_AFTER_NONPASS"
'''

for shell in ("bash", "zsh"):
    with tempfile.TemporaryDirectory(prefix=f"agent-workbench-{shell}-snapshot-") as directory:
        evidence_dir = Path(directory) / "evidence"
        evidence_dir.mkdir()
        locator = Path(directory) / "evidence.locator"
        completed = subprocess.run(
            [shell, "-c", script, "strict-snapshot-audit", str(evidence_dir), str(locator)],
            check=False,
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, (shell, completed.returncode)
        assert locator.read_text(encoding="utf-8") == f"{evidence_dir}\n"
        assert completed.stdout.index(f"AW_LIVE_EVIDENCE_DIR={evidence_dir}\n") < completed.stdout.index("SYNTHETIC_CLI_STARTED\n")
        assert json.loads((evidence_dir / "snapshot.exit.json").read_text(encoding="utf-8")) == {
            "cli_exit": 23,
            "pipeline_exit": 23,
            "schema_version": "agent_workbench_live_snapshot_exit.v1",
            "tee_exit": 0,
        }
        assert not list(evidence_dir.glob("snapshot.exit.json.tmp.*"))
        assert "CHECKLIST_NONPASS: strict snapshot cli_exit=23 tee_exit=0 pipeline_exit=23" in completed.stderr
        assert "LIVE_SNAPSHOT_EXIT_ZERO" not in completed.stdout
        assert completed.stdout.endswith("SHELL_ALIVE_AFTER_NONPASS\n")
print("STRICT_SNAPSHOT_NONPASS_AUDIT_OK=bash,zsh")
PY
~~~

Read the real marker without allowing a malformed or non-zero result to terminate terminal C:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
set +e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
if test -n "${AW_SNAPSHOT_EXIT_MARKER:-}" && test -f "$AW_SNAPSHOT_EXIT_MARKER"; then
  (cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"cli_exit","pipeline_exit","schema_version","tee_exit"}; assert data["schema_version"] == "agent_workbench_live_snapshot_exit.v1"; assert all(type(data[key]) is int and 0 <= data[key] <= 255 for key in ("cli_exit","pipeline_exit","tee_exit")); ok=all(data[key] == 0 for key in ("cli_exit","pipeline_exit","tee_exit")); print("LIVE_SNAPSHOT_EXIT_ZERO" if ok else "CHECKLIST_NONPASS: strict snapshot exit marker is non-zero")' "$AW_SNAPSHOT_EXIT_MARKER")
  AW_SNAPSHOT_MARKER_READBACK_CODE=$?
else
  AW_SNAPSHOT_MARKER_READBACK_CODE=1
fi
if test "$AW_SNAPSHOT_MARKER_READBACK_CODE" -ne 0; then
  echo "CHECKLIST_NONPASS: strict snapshot exit marker is missing or malformed" >&2
fi
set -e
printf 'SHELL_ALIVE_AFTER_SNAPSHOT_MARKER_READBACK AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
~~~

The snapshot block itself ends successfully so terminal C remains available for marker inspection, sanitized JSON readback, and observer finalization; that shell completion is never live-acceptance evidence. `LIVE_SNAPSHOT_EXIT_ZERO` means only that the CLI, `tee`, and their pipefail pipeline all exited zero and the marker was atomically installed. Any other numeric marker, missing/malformed marker, or `CHECKLIST_NONPASS` output remains a non-pass and cannot be turned into PASS by the final safe print. The CLI performs one short local aggregate bracket and one independently bracketed bundle per Agent, with at most one retry for each unstable/mismatching segment after the normal 30-second proof interval. It never combines direct remote data from one segment attempt with SQLite state from another or calls the staggered results one global instantaneous snapshot. Require the all-zero marker plus a clean local bracket and clean stable Agent segments in retained sanitized JSON with per-segment observation intervals. Record `LIVE_GATE_UNAVAILABLE`, `LIVE_GATE_MISMATCH`, `LIVE_GATE_UNSTABLE`, or `LIVE_GATE_TIMEOUT` exactly for non-zero reconciliation outcomes.

Select the first already-active, motion-eligible RUNNING candidate from that exact report without triggering anything. If there is one, immediately observe the same Run for up to 15 minutes and require terminal/Token readback from the resulting JSON:

**Owned observer launch:** launch without waiting in this feedback slice:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
set +e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
if test -z "${AW_LIVE_EVIDENCE_DIR:-}" || test ! -d "$AW_LIVE_EVIDENCE_DIR"; then
  echo "LIVE_TRANSITION_NOT_OBSERVED: evidence directory is unavailable" >&2
elif ! AW_OBSERVE_RUN_ID="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); rows=data.get("active_transition_candidates", []); print(rows[0]["coreai_run_id"] if rows else "")' "$AW_LIVE_EVIDENCE_DIR/snapshot.json")"; then
  : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  echo "LIVE_TRANSITION_NOT_OBSERVED: candidate selection failed" >&2
elif test -n "$AW_OBSERVE_RUN_ID"; then
  export AW_OBSERVE_RUN_ID
  AW_OBSERVE_STDOUT="$AW_LIVE_EVIDENCE_DIR/transition.json"
  AW_OBSERVE_STDERR="$AW_LIVE_EVIDENCE_DIR/transition.stderr"
  AW_OBSERVE_EXIT="$AW_LIVE_EVIDENCE_DIR/transition.exit"
  export AW_OBSERVE_STDOUT AW_OBSERVE_STDERR AW_OBSERVE_EXIT
  if printf '%s\n' "$AW_OBSERVE_RUN_ID" > "$AW_LIVE_EVIDENCE_DIR/transition.run-id"; then
    (
      cd api
      exec env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
        .venv/bin/python tests/agent_workbench_live_readback.py \
        --env-file .env \
        --api-url http://127.0.0.1:8000 \
        --range 30d \
        --overall-timeout-seconds 240 \
        --strict \
        --observe-run-id "$AW_OBSERVE_RUN_ID" \
        --observe-seconds 900
    ) >"$AW_OBSERVE_STDOUT" 2>"$AW_OBSERVE_STDERR" &
    AW_OBSERVE_PID=$!
    export AW_OBSERVE_PID
    if printf '%s\n' "$AW_OBSERVE_PID" > "$AW_LIVE_EVIDENCE_DIR/transition.pid"; then
      printf 'LIVE_OBSERVER_STARTED pid=%s\n' "$AW_OBSERVE_PID"
    else
      : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
      echo "LIVE_TRANSITION_NOT_OBSERVED: PID marker could not be recorded" >&2
    fi
  else
    : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
    echo "LIVE_TRANSITION_NOT_OBSERVED: selected-ID marker could not be recorded" >&2
  fi
else
  : > "$AW_LIVE_EVIDENCE_DIR/transition.no-candidate"
  : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  echo "LIVE_TRANSITION_NOT_OBSERVED: no motion-eligible RUNNING candidate; rerun this read-only gate during authorized work" >&2
fi
set -e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
~~~

**Non-blocking observer inspection:** after other short gates, inspect without waiting. Run this in the same control terminal C so `wait` can reap the owned child. It either validates a completed result or returns immediately with `LIVE_OBSERVER_STILL_RUNNING`:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
set +e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
if test -z "${AW_LIVE_EVIDENCE_DIR:-}" || test ! -d "$AW_LIVE_EVIDENCE_DIR"; then
  echo "LIVE_TRANSITION_NOT_OBSERVED: evidence directory is unavailable" >&2
elif test -f "$AW_LIVE_EVIDENCE_DIR/transition.no-candidate"; then
  : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  echo "LIVE_TRANSITION_NOT_OBSERVED: no candidate" >&2
elif test -f "$AW_LIVE_EVIDENCE_DIR/transition.pid"; then
  AW_RECORDED_OBSERVE_PID="$(tr -d '\n' < "$AW_LIVE_EVIDENCE_DIR/transition.pid")"
  if test -z "${AW_OBSERVE_PID:-}" || test "$AW_OBSERVE_PID" != "$AW_RECORDED_OBSERVE_PID"; then
    : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
    echo "LIVE_TRANSITION_NOT_OBSERVED: observer PID ownership mismatch" >&2
  elif kill -0 "$AW_OBSERVE_PID" 2>/dev/null; then
    printf 'LIVE_OBSERVER_STILL_RUNNING pid=%s\n' "$AW_OBSERVE_PID"
  else
    wait "$AW_OBSERVE_PID"
    AW_OBSERVE_CODE=$?
    AW_OBSERVE_EXIT="${AW_OBSERVE_EXIT:-$AW_LIVE_EVIDENCE_DIR/transition.exit}"
    AW_OBSERVE_STDOUT="${AW_OBSERVE_STDOUT:-$AW_LIVE_EVIDENCE_DIR/transition.json}"
    AW_OBSERVE_EXIT_TMP="$AW_OBSERVE_EXIT.tmp"
    if printf '%s\n' "$AW_OBSERVE_CODE" > "$AW_OBSERVE_EXIT_TMP" && mv -- "$AW_OBSERVE_EXIT_TMP" "$AW_OBSERVE_EXIT" && test "$AW_OBSERVE_CODE" -eq 0 && (cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert data.get("observe_run_id") == sys.argv[2]; assert data.get("start_raw_status") == "RUNNING"; assert data.get("start_motion_eligible") is True; assert data.get("transition_observed") is True; assert data.get("final_raw_status") in {"COMPLETED","FAILED","TIMEOUT","CANCELLED","SKIPPED"}; assert data.get("terminal_token_match") is True' "$AW_OBSERVE_STDOUT" "$AW_OBSERVE_RUN_ID"); then
      AW_OBSERVER_MARK_TMP="$AW_LIVE_EVIDENCE_DIR/transition.validated.tmp"
      if : > "$AW_OBSERVER_MARK_TMP" && mv -- "$AW_OBSERVER_MARK_TMP" "$AW_LIVE_EVIDENCE_DIR/transition.validated"; then
        echo "LIVE_TRANSITION_VALIDATED"
      else
        : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
        echo "LIVE_TRANSITION_NOT_OBSERVED: validation marker could not be persisted" >&2
      fi
    else
      : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
      echo "LIVE_TRANSITION_NOT_OBSERVED: completed observer did not prove the same-ID transition" >&2
    fi
  fi
else
  : > "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  echo "LIVE_TRANSITION_NOT_OBSERVED: missing observer launch state" >&2
fi
set -e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
~~~

**Mandatory observer finalization:** run this for every candidate-present path after the non-blocking inspection, including the race where the child ends naturally immediately after that inspection. It validates an already-recorded result, reaps a naturally ended child, or cancels only the still-running recorded owned Python process. It atomically persists the exit code and an explicit validated/not-observed marker; a non-passing result is not permission to select another Run:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
set +e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
aw_observer_mark() {
  AW_OBSERVER_MARK_TARGET="$1"
  AW_OBSERVER_MARK_TMP="${AW_OBSERVER_MARK_TARGET}.tmp.$$"
  : > "$AW_OBSERVER_MARK_TMP" && mv -- "$AW_OBSERVER_MARK_TMP" "$AW_OBSERVER_MARK_TARGET"
}
AW_OBSERVER_FINAL_PASS=false
if test -z "${AW_LIVE_EVIDENCE_DIR:-}" || test ! -d "$AW_LIVE_EVIDENCE_DIR"; then
  echo "LIVE_TRANSITION_NOT_OBSERVED: evidence directory is unavailable" >&2
elif test -f "$AW_LIVE_EVIDENCE_DIR/transition.no-candidate"; then
  aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  echo "LIVE_TRANSITION_NOT_OBSERVED: no candidate" >&2
elif test -f "$AW_LIVE_EVIDENCE_DIR/transition.pid"; then
  AW_RECORDED_OBSERVE_PID="$(tr -d '\n' < "$AW_LIVE_EVIDENCE_DIR/transition.pid")"
  AW_OBSERVE_EXIT="${AW_OBSERVE_EXIT:-$AW_LIVE_EVIDENCE_DIR/transition.exit}"
  AW_OBSERVE_STDOUT="${AW_OBSERVE_STDOUT:-$AW_LIVE_EVIDENCE_DIR/transition.json}"
  AW_OBSERVE_CAN_REAP=false
  if test -n "${AW_OBSERVE_PID:-}" && test "$AW_OBSERVE_PID" = "$AW_RECORDED_OBSERVE_PID" && test -n "${AW_OBSERVE_RUN_ID:-}"; then
    AW_OBSERVE_CAN_REAP=true
  else
    aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
    echo "LIVE_TRANSITION_NOT_OBSERVED: observer ownership state is invalid" >&2
  fi
  if test "$AW_OBSERVE_CAN_REAP" = true && test ! -f "$AW_OBSERVE_EXIT"; then
    AW_OBSERVE_SAFE_TO_SIGNAL=true
    if kill -0 "$AW_OBSERVE_PID" 2>/dev/null; then
      AW_OBSERVE_PPID=""
      AW_OBSERVE_COMMAND=""
      if AW_OBSERVE_PPID="$(ps -p "$AW_OBSERVE_PID" -o ppid= 2>/dev/null)" && AW_OBSERVE_COMMAND="$(ps -ww -p "$AW_OBSERVE_PID" -o command= 2>/dev/null)"; then
        AW_OBSERVE_PPID="$(printf '%s' "$AW_OBSERVE_PPID" | tr -d '[:space:]')"
        if test "$AW_OBSERVE_PPID" != "$$"; then
          AW_OBSERVE_SAFE_TO_SIGNAL=false
        fi
        case "$AW_OBSERVE_COMMAND" in
          *agent_workbench_live_readback.py*--strict*--observe-run-id*--observe-seconds\ 900*) ;;
          *) AW_OBSERVE_SAFE_TO_SIGNAL=false ;;
        esac
        if ! printf '%s\n' "$AW_OBSERVE_COMMAND" | grep -Fq -- "--observe-run-id $AW_OBSERVE_RUN_ID"; then
          AW_OBSERVE_SAFE_TO_SIGNAL=false
        fi
        if test "$AW_OBSERVE_SAFE_TO_SIGNAL" = true; then
          if ! kill -INT "$AW_OBSERVE_PID" 2>/dev/null && kill -0 "$AW_OBSERVE_PID" 2>/dev/null; then
            AW_OBSERVE_CAN_REAP=false
          fi
        else
          AW_OBSERVE_CAN_REAP=false
        fi
      elif kill -0 "$AW_OBSERVE_PID" 2>/dev/null; then
        AW_OBSERVE_CAN_REAP=false
      fi
    fi
    if test "$AW_OBSERVE_CAN_REAP" = true; then
      wait "$AW_OBSERVE_PID"
      AW_OBSERVE_CODE=$?
      AW_OBSERVE_EXIT_TMP="$AW_OBSERVE_EXIT.tmp"
      if ! printf '%s\n' "$AW_OBSERVE_CODE" > "$AW_OBSERVE_EXIT_TMP" || ! mv -- "$AW_OBSERVE_EXIT_TMP" "$AW_OBSERVE_EXIT"; then
        AW_OBSERVE_CAN_REAP=false
      fi
    fi
    if test "$AW_OBSERVE_CAN_REAP" != true; then
      aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
      echo "LIVE_TRANSITION_NOT_OBSERVED: owned observer could not be safely finalized" >&2
    fi
  fi
  if test -f "$AW_OBSERVE_EXIT"; then
    AW_OBSERVE_CODE="$(tr -d '\n' < "$AW_OBSERVE_EXIT")"
    case "$AW_OBSERVE_CODE" in
      ''|*[!0-9]*)
        aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
        echo "LIVE_TRANSITION_NOT_OBSERVED: invalid observer exit marker" >&2
        ;;
      0)
        if (cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert data.get("observe_run_id") == sys.argv[2]; assert data.get("start_raw_status") == "RUNNING"; assert data.get("start_motion_eligible") is True; assert data.get("transition_observed") is True; assert data.get("final_raw_status") in {"COMPLETED","FAILED","TIMEOUT","CANCELLED","SKIPPED"}; assert data.get("terminal_token_match") is True' "$AW_OBSERVE_STDOUT" "$AW_OBSERVE_RUN_ID"); then
          if aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.validated"; then
            AW_OBSERVER_FINAL_PASS=true
            echo "LIVE_TRANSITION_VALIDATED"
          fi
        fi
        if test "$AW_OBSERVER_FINAL_PASS" != true; then
          aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
          echo "LIVE_TRANSITION_NOT_OBSERVED: observer result failed same-ID validation" >&2
        fi
        ;;
      *)
        aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
        echo "LIVE_TRANSITION_NOT_OBSERVED: observer ended without same-ID terminal proof" >&2
        ;;
    esac
  elif test "$AW_OBSERVER_FINAL_PASS" != true; then
    aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
    echo "LIVE_TRANSITION_NOT_OBSERVED: no observer exit evidence" >&2
  fi
else
  if test -n "${AW_LIVE_EVIDENCE_DIR:-}" && test -d "$AW_LIVE_EVIDENCE_DIR"; then
    aw_observer_mark "$AW_LIVE_EVIDENCE_DIR/transition.not-observed"
  fi
  echo "LIVE_TRANSITION_NOT_OBSERVED: missing observer launch state" >&2
fi
if test "$AW_OBSERVER_FINAL_PASS" != true; then
  echo "CHECKLIST_NONPASS: rollout step 5 remains LIVE_TRANSITION_NOT_OBSERVED" >&2
fi
unset -f aw_observer_mark
set -e
printf 'AW_LIVE_EVIDENCE_DIR=%s\n' "${AW_LIVE_EVIDENCE_DIR:-UNSET}"
~~~

The blocks deliberately preserve the owning terminal C even when observation does not pass; their shell completion status is never acceptance evidence. Only an atomically written `transition.validated` marker with no `transition.not-observed` marker may pass rollout step 5, and that marker requires `transition_observed=true` for the same ID after eligible RUNNING-at-start evidence and matching terminal/Token readback. Every expected non-pass and every integrity/finalization failure records `transition.not-observed`, prints the safe evidence-directory locator, and continues to marker inspection/readback without selecting another Run. PENDING or PAUSED at start is ineligible, and a direct PENDING/PAUSED-to-terminal transition cannot pass. The no-candidate branch is not a snapshot failure, but rollout step 5 remains explicitly `LIVE_TRANSITION_NOT_OBSERVED`; retain `snapshot.json` and rerun during later already-authorized work. An already-terminal/disappeared/timed-out candidate fails observe mode rather than silently choosing another ID. Do not claim full rollout acceptance merely because fake-backed tests or a clean single snapshot pass, and do not trigger an external Run during this check.

**Implementation reference 11D: Guarded disposable visual fixtures**

Implement `api/tests/agent_workbench_visual_fixture.py` with mutually exclusive CLI modes `--output-dir PATH` and `--refresh-scenario PATH`. For generation, `PATH` must already exist, resolve to an empty directory, be neither equal to, an ancestor of, nor a descendant of the configured default database directory, and have no existing `active.db`, `idle.db`, `partial.db`, or `stale.db`; otherwise exit non-zero before writing. Every generated database contains a private `agent_workbench_preview_fixture` marker with its scenario. Refresh accepts only a marked active, idle, or partial database whose filename agrees with its marker; it rejects the default database, stale scenario, mismatched marker/name, and every unmarked database, and never contacts Core AI.

Generation calls the real schema/aggregation helpers and creates exactly four databases named `active.db`, `idle.db`, `partial.db`, and `stale.db`, with timestamps relative to one captured aware UTC instant:

- `active.db`: twelve mixed-lifecycle Agents, a 110-character display name, three RUNNING Runs across two active Agents whose own current proof is fresh/complete, one PENDING, one PAUSED, one unknown-future static signal owned by a different disabled Agent, one local-archiving item whose immutable `terminal_observed_at` equals the generation instant while its exact local source remains `running`, one terminal receipt, one Agent with incomplete history coverage, and one immutable Agent ID owning exactly 21 deterministic receipt-expired terminal history rows whose `finished_at` values all lie inclusively within `[today_range_start, generated_at]`. Freeze generation 30 seconds after the operator-timezone midnight boundary; give all 21 rows identical `effective_started_at=finished_at=terminal_observed_at=today_range_start` and `receipt_expires_at=today_range_start+10 seconds`, then use deterministic unique Run IDs as the secondary ordering key. Thus every receipt is expired by `generated_at`, no row falls before `today`, and midnight cannot shrink the first page. Tests must assert that exact boundary, exact `2 个 Agent · 3 个 Run` inputs, require all three RUNNING signals to satisfy every `mayAnimateRunning` input, prove the separate unknown signal remains static and still forbids any aggregate idle claim, and require default history pagination to return the first 20 ordered rows plus the exact non-null cursor before returning the twenty-first row alone;
- `idle.db`: at least one active Agent, exact zero current counts, complete fresh proof, and one last terminal Run;
- `partial.db`: at least one healthy exact fresh Agent with an exact 110-character display name, plus a second Agent with a lower-bound status page, a third with a failed status page/prior observation, one never-confirmed Agent, and coverage with `remote_total_runs=NULL`; the real aggregate must preserve all 110 display-name characters and equal `sync_health='partial'`;
- `stale.db`: expired aggregate/signal boundaries and cached non-terminal rows that must remain visible but static.

`--refresh-scenario active.db` captures a new real UTC instant, refreshes only that marked fixture's proof timestamps, inserts a new uniquely identified preview receipt rather than extending an existing receipt, and sets the fresh RUNNING window to the production 15 seconds and the receipt window to the production 10 seconds. It must not rewrite the local-archiving row's immutable `terminal_observed_at`, its local-source status/timestamps, or any other factual lifecycle timer to make the row look younger. The inserted receipt's `coreai_run_id` is the refresh record's `new_receipt_id`; every successful active refresh must generate a value distinct from all prior fixture Run IDs. For idle, refresh only the exact-zero discovery/current proof timestamps needed for the production 90-second boundary, preserving all zero counts/qualities/history. For partial, refresh the healthy Agent's proof and the incomplete Agents' attempt/last-valid observation times while preserving every lower-bound/unknown quality, error, Run, total, and 110-character display name so the real aggregate remains `sync_health='partial'`. Idle and partial refreshes report `new_receipt_id=null`; they do not insert a receipt. Stale refresh is forbidden so it cannot accidentally become fresh. These modes exist only for just-in-time human inspection without falsifying production durations or semantic state. The preview server runs with lifespan disabled, so it cannot seed or poll.

On success, the helper writes exactly one UTF-8 canonical JSON object plus a trailing newline to stdout and nothing to stderr. Serialize with `json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"`. Generation output has exactly `database_paths`, `generated_at`, `output_dir`, and `schema_version="agent_workbench_visual_fixture_generation.v1"`; `database_paths` has exactly the `active`, `idle`, `partial`, and `stale` absolute paths, and `generated_at` is the one captured aware UTC fixture instant serialized with a `Z` suffix. Refresh output has exactly `new_receipt_id`, `refreshed_at`, `scenario`, and `schema_version="agent_workbench_visual_fixture_refresh.v1"`. `refreshed_at` is the same aware UTC instant used for the database mutation and is serialized with a `Z` suffix. Active emits its new non-empty preview receipt ID; idle and partial emit JSON null. These allowlisted records contain no environment values, auth material, Core AI payloads, marker contents, or database-row dumps.

Acceptance tests generate all four databases in a pytest temporary directory, build each real aggregate, and assert its defining conditions. For generation, inject a fixed aware UTC clock, capture exact raw stdout bytes, compare the canonical JSON line byte-for-byte before parsing those same bytes, and require the active local-archiving `terminal_observed_at` to equal captured `generated_at`. Independently freeze generation 30 seconds after the exact operator-timezone midnight edge, require all 21 expected history tuples for one Agent to have `effective_started_at=finished_at=terminal_observed_at=today_range_start`, `receipt_expires_at=today_range_start+10 seconds`, and therefore expired receipts at `generated_at`; require the real default-limit result to contain exactly the first 20 in `(effective_started_at DESC, coreai_run_id DESC)` order, compare its non-null `next_before` byte-for-byte with an independently encoded `[1, twentieth_effective_started_at, twentieth_coreai_run_id]`, then pass that exact cursor and require only the final row with no duplicate and a null next cursor. For refresh tests, inject a fixed aware UTC clock and deterministic unique preview receipt-ID values, capture the exact raw stdout bytes, and compare them to the canonical JSON line byte-for-byte before parsing the same captured bytes. After advancing beyond 90 seconds, exercise each allowed refresh and rebuild the aggregate. For active, assert the aggregate contains exactly one new receipt signal whose `coreai_run_id` equals the captured `new_receipt_id`, whose timing derives from the captured `refreshed_at`, and whose window is exactly ten seconds; also require the pre/post local-archiving observation plus local-source status/timestamp tuple to remain byte-identical. Repeat with another frozen ID and prove both new-ID uniqueness and immutability of the earlier receipt expiry. Prove there was no Core AI I/O. For idle and partial, require captured `new_receipt_id` to be null and prove their exact-idle/partial semantics, including the partial fixture's complete 110-character name, remain intact. Also prove the helper refuses the real/default database, stale/mismatched/unmarked databases, and a non-empty output directory. A separate GREEN characterization starts from a working directory with no `.env`, clears inherited auth/Core AI values, supplies only the fixed public preview exports below, proves `/api/auth/login` and `/api/agent-workbench` both return HTTP 200, and proves neither the fixture auth secret nor an inherited-secret sentinel reaches responses or captured output.

Do not generate the browser fixtures during the earlier automated-gate phase. Only after the scheduler-parked live API has stopped, its awaited lifespan prompt has returned, and port 8000 is free, run this guarded fresh generation in control terminal C. The port guard plus cleared exports prevents reuse of a database created before the live gate; the helper's empty-directory guard prevents overwriting any prior fixture:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if lsof -nP -iTCP:8000 -sTCP:LISTEN; then
  echo "Preview generation requires port 8000 to be free" >&2
  exit 1
fi
unset AW_PREVIEW_DIR AW_PREVIEW_GENERATION_OUTPUT AW_PREVIEW_GENERATED_AT AW_ACTIVE_REFRESH_OUTPUT AW_EXPECTED_REFRESHED_AT AW_EXPECTED_RECEIPT_ID AW_NONACTIVE_REFRESH_OUTPUT AW_EXPECTED_REFRESH_SCENARIO
export AW_PREVIEW_DIR="$(mktemp -d)"
export AW_PREVIEW_GENERATION_OUTPUT="$(mktemp)"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --output-dir "$AW_PREVIEW_DIR") | tee "$AW_PREVIEW_GENERATION_OUTPUT"
(cd api && .venv/bin/python -c 'from datetime import datetime,timedelta; import json,os,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"database_paths","generated_at","output_dir","schema_version"}; assert data["schema_version"] == "agent_workbench_visual_fixture_generation.v1"; assert data["output_dir"] == sys.argv[2]; scenarios=("active","idle","partial","stale"); assert data["database_paths"] == {name: os.path.join(sys.argv[2], name+".db") for name in scenarios}; value=data["generated_at"]; assert isinstance(value,str) and value.endswith("Z"); parsed=datetime.fromisoformat(value[:-1]+"+00:00"); assert parsed.utcoffset() == timedelta(0); print(data["output_dir"])' "$AW_PREVIEW_GENERATION_OUTPUT" "$AW_PREVIEW_DIR")
AW_PREVIEW_GENERATED_AT="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); print(data["generated_at"])' "$AW_PREVIEW_GENERATION_OUTPUT")"
export AW_PREVIEW_GENERATED_AT
~~~

Keep this fixture-generation shell open as **control terminal C**; it owns `AW_PREVIEW_DIR`, `AW_PREVIEW_GENERATION_OUTPUT`, `AW_PREVIEW_GENERATED_AT`, and every just-in-time refresh output. Copy the validated absolute directory once into **preview API terminal B** with `export AW_PREVIEW_DIR='…'`, using the exact value read back from the structured generation record, then run `test -d "$AW_PREVIEW_DIR" && test -f "$AW_PREVIEW_DIR/active.db"` there before starting any server. Vite remains in **terminal A**. Never expect a shell variable to cross terminals, and never run a refresh command in terminal B while its foreground uvicorn process owns that terminal.

**Manual acceptance reference 11E: Visual, cadence, and interaction matrix**

After the live readback in reference 11C finishes, stop the scheduler-parked live-gate API in terminal B with Ctrl-C, wait for the shell prompt (the awaited lifespan shutdown), and require port 8000 to be free before preview begins. Keep Vite running in terminal A. Only then run reference 11D's complete guarded fresh-generation block in control terminal C; no pre-live fixture directory is eligible for visual evidence. Next run **11E active refresh capture**:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_DIR:-}"
export AW_ACTIVE_REFRESH_OUTPUT="$(mktemp "$AW_PREVIEW_DIR/active-refresh.XXXXXX")"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/active.db") | tee "$AW_ACTIVE_REFRESH_OUTPUT"
~~~

Then run **11E active refresh readback** in the same control terminal. It accepts exactly the allowlisted structured record, freezes the emitted values used by this one browser proof, and rejects a missing, null, or malformed receipt ID:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_ACTIVE_REFRESH_OUTPUT:-}"
AW_EXPECTED_REFRESHED_AT="$(cd api && .venv/bin/python -c 'from datetime import datetime,timedelta; import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"new_receipt_id","refreshed_at","scenario","schema_version"}; assert data["schema_version"] == "agent_workbench_visual_fixture_refresh.v1"; assert data["scenario"] == "active"; value=data["refreshed_at"]; assert isinstance(value,str) and value.endswith("Z"); parsed=datetime.fromisoformat(value[:-1]+"+00:00"); assert parsed.utcoffset() == timedelta(0); print(value)' "$AW_ACTIVE_REFRESH_OUTPUT")"
AW_EXPECTED_RECEIPT_ID="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); value=data["new_receipt_id"]; assert isinstance(value,str) and value and value == value.strip(); print(value)' "$AW_ACTIVE_REFRESH_OUTPUT")"
export AW_EXPECTED_REFRESHED_AT AW_EXPECTED_RECEIPT_ID
~~~

Immediately before active preview launch, run this **pre-launch generation-age guard** in control terminal C. It reads only the exported safe generation timestamp. If it exits non-zero, do not update `terminal_observed_at`: keep the preview API stopped and repeat the complete guarded generation block into another new empty directory, copy that new directory to terminal B, and repeat active refresh capture/readback. A passing sixty-second guard leaves a four-minute margin before the production five-minute archiving cutoff; the first HTTP aggregate is still required to prove its actual age:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_GENERATED_AT:-}"
(cd api && .venv/bin/python -c 'from datetime import datetime,timezone; import sys; value=sys.argv[1]; assert value.endswith("Z"); generated=datetime.fromisoformat(value[:-1]+"+00:00"); age=(datetime.now(timezone.utc)-generated).total_seconds(); assert 0 <= age < 60, "REGENERATE_PREVIEW_FIXTURES"' "$AW_PREVIEW_GENERATED_AT")
~~~

In terminal B, export the exact validated absolute `AW_PREVIEW_DIR`, validate it, and run **11E active preview launch** below. For each scenario, stop the preview API in terminal B with Ctrl-C and wait for its prompt before changing databases. Refresh only from control terminal C. Start the next API from terminal B, where the same copied absolute `AW_PREVIEW_DIR` remains exported, with explicit fixed fixture-only auth, non-secret inert connection values, and lifespan disabled, so no `.env`, startup seed, scheduler, or synchronization worker can rewrite the fixtures. Each `env -i` invocation forwards only `PATH`, a safe temp-directory path, and the listed fixture values; inherited credentials cannot enter the preview process. The literals are public disposable fixture values, not credentials for any live service; use `preview-operator` / `preview-only-password` to log in, and never substitute values from the real live-gate `.env`:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/active.db"
  export SEO_OPS_AUTH_USERNAME="preview-operator"
  export SEO_OPS_AUTH_PASSWORD="preview-only-password"
  export SEO_OPS_AUTH_SECRET="preview-only-fixed-auth-secret-0001"
  export SEO_OPS_COOKIE_SECURE="false"
  export SEO_OPS_OPERATOR_TIMEZONE="Asia/Shanghai"
  export SEO_OPS_AGENT_HISTORY_LIMIT="200"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    SEO_OPS_DB="$SEO_OPS_DB" \
    SEO_OPS_AUTH_USERNAME="$SEO_OPS_AUTH_USERNAME" \
    SEO_OPS_AUTH_PASSWORD="$SEO_OPS_AUTH_PASSWORD" \
    SEO_OPS_AUTH_SECRET="$SEO_OPS_AUTH_SECRET" \
    SEO_OPS_COOKIE_SECURE="$SEO_OPS_COOKIE_SECURE" \
    SEO_OPS_OPERATOR_TIMEZONE="$SEO_OPS_OPERATOR_TIMEZONE" \
    SEO_OPS_AGENT_HISTORY_LIMIT="$SEO_OPS_AGENT_HISTORY_LIMIT" \
    COREAI_BASE_URL="$COREAI_BASE_URL" \
    COREAI_API_KEY="$COREAI_API_KEY" \
    COREAI_AGENT_ID="$COREAI_AGENT_ID" \
    COREAI_EXECUTION_AGENT_ID="$COREAI_EXECUTION_AGENT_ID" \
    COREAI_KEYWORD_AGENT_ID="$COREAI_KEYWORD_AGENT_ID" \
    COREAI_AUDIT_AGENT_ID="$COREAI_AUDIT_AGENT_ID" \
    COREAI_RANKING_AGENT_ID="$COREAI_RANKING_AGENT_ID" \
    COREAI_KEYWORD_SKILL_AGENT_ID="$COREAI_KEYWORD_SKILL_AGENT_ID" \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --lifespan off
)
~~~

For the first active HTTP 200 aggregate, require the local-archiving signal's `terminal_observed_at` to equal `AW_PREVIEW_GENERATED_AT` byte-for-byte, require `signal_state='archiving'`, require `0 <= snapshot_at - terminal_observed_at < 300 seconds`, and require `ARCHIVE_DELAY` to be absent. The fixture test's byte-identical pre/post source tuple proves the exact local source remains `running`; the HTTP signal and age prove that factual row is still inside the production window. Neither refresh nor manual inspection may rewrite the timer. For every active viewport/interaction that must show motion or the short receipt, keep the active preview server open, rerun the exact **active refresh capture** block followed by the exact **active refresh readback** block in control terminal C, then immediately press `刷新显示`. In the HTTP 200 aggregate response, locate the preview receipt signal and require its `coreai_run_id` to equal `AW_EXPECTED_RECEIPT_ID` byte-for-byte; do not infer identity from count, ordering, copy, or timestamps. Rerun both blocks to create and freeze a different receipt ID if the ten-second window expires:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_DIR:-}"
export AW_ACTIVE_REFRESH_OUTPUT="$(mktemp "$AW_PREVIEW_DIR/active-refresh.XXXXXX")"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/active.db") | tee "$AW_ACTIVE_REFRESH_OUTPUT"
~~~

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_ACTIVE_REFRESH_OUTPUT:-}"
AW_EXPECTED_REFRESHED_AT="$(cd api && .venv/bin/python -c 'from datetime import datetime,timedelta; import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"new_receipt_id","refreshed_at","scenario","schema_version"}; assert data["schema_version"] == "agent_workbench_visual_fixture_refresh.v1"; assert data["scenario"] == "active"; value=data["refreshed_at"]; assert isinstance(value,str) and value.endswith("Z"); parsed=datetime.fromisoformat(value[:-1]+"+00:00"); assert parsed.utcoffset() == timedelta(0); print(value)' "$AW_ACTIVE_REFRESH_OUTPUT")"
AW_EXPECTED_RECEIPT_ID="$(cd api && .venv/bin/python -c 'import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); value=data["new_receipt_id"]; assert isinstance(value,str) and value and value == value.strip(); print(value)' "$AW_ACTIVE_REFRESH_OUTPUT")"
export AW_EXPECTED_REFRESHED_AT AW_EXPECTED_RECEIPT_ID
~~~

Before stopping active, complete every paused and interaction checkbox: use the active fixture for pause/resume, pending-range/manual-refresh, drawer focus/inert behavior, Run tabs/history/copy links, reduced motion, and forced colors. For the paused receipt/focus-freeze row, first complete the manual-read-to-running setup in the checklist. Then run both active refresh blocks in control terminal C, immediately press `刷新显示`, require HTTP 200, compare the aggregate receipt `coreai_run_id` with the newly emitted `AW_EXPECTED_RECEIPT_ID`, focus that receipt's tab, and enter pause within the production ten-second receipt window. Stale has no receipt and must never be used for that row.

After all active/paused/interaction inspection, stop that preview server. Run **11E idle refresh capture** immediately before starting it, and rerun the capture/readback pair plus `刷新显示` immediately before any later idle viewport/new-page check whose 90-second window may have expired:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_DIR:-}"
export AW_NONACTIVE_REFRESH_OUTPUT="$(mktemp "$AW_PREVIEW_DIR/idle-refresh.XXXXXX")"
export AW_EXPECTED_REFRESH_SCENARIO="idle"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/idle.db") | tee "$AW_NONACTIVE_REFRESH_OUTPUT"
~~~

Run **11E non-active refresh readback** after every idle or partial refresh capture. This exact block proves the retained stdout is a canonical refresh record for the intended scenario and that no receipt was inserted:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_NONACTIVE_REFRESH_OUTPUT:-}"
test -n "${AW_EXPECTED_REFRESH_SCENARIO:-}"
(cd api && .venv/bin/python -c 'from datetime import datetime,timedelta; import json,sys; data=json.load(open(sys.argv[1], encoding="utf-8")); assert set(data) == {"new_receipt_id","refreshed_at","scenario","schema_version"}; assert data["schema_version"] == "agent_workbench_visual_fixture_refresh.v1"; assert data["scenario"] == sys.argv[2]; assert data["new_receipt_id"] is None; value=data["refreshed_at"]; assert isinstance(value,str) and value.endswith("Z"); parsed=datetime.fromisoformat(value[:-1]+"+00:00"); assert parsed.utcoffset() == timedelta(0); print(value)' "$AW_NONACTIVE_REFRESH_OUTPUT" "$AW_EXPECTED_REFRESH_SCENARIO")
~~~

Run **11E idle preview launch**:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/idle.db"
  export SEO_OPS_AUTH_USERNAME="preview-operator"
  export SEO_OPS_AUTH_PASSWORD="preview-only-password"
  export SEO_OPS_AUTH_SECRET="preview-only-fixed-auth-secret-0001"
  export SEO_OPS_COOKIE_SECURE="false"
  export SEO_OPS_OPERATOR_TIMEZONE="Asia/Shanghai"
  export SEO_OPS_AGENT_HISTORY_LIMIT="200"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    SEO_OPS_DB="$SEO_OPS_DB" \
    SEO_OPS_AUTH_USERNAME="$SEO_OPS_AUTH_USERNAME" \
    SEO_OPS_AUTH_PASSWORD="$SEO_OPS_AUTH_PASSWORD" \
    SEO_OPS_AUTH_SECRET="$SEO_OPS_AUTH_SECRET" \
    SEO_OPS_COOKIE_SECURE="$SEO_OPS_COOKIE_SECURE" \
    SEO_OPS_OPERATOR_TIMEZONE="$SEO_OPS_OPERATOR_TIMEZONE" \
    SEO_OPS_AGENT_HISTORY_LIMIT="$SEO_OPS_AGENT_HISTORY_LIMIT" \
    COREAI_BASE_URL="$COREAI_BASE_URL" \
    COREAI_API_KEY="$COREAI_API_KEY" \
    COREAI_AGENT_ID="$COREAI_AGENT_ID" \
    COREAI_EXECUTION_AGENT_ID="$COREAI_EXECUTION_AGENT_ID" \
    COREAI_KEYWORD_AGENT_ID="$COREAI_KEYWORD_AGENT_ID" \
    COREAI_AUDIT_AGENT_ID="$COREAI_AUDIT_AGENT_ID" \
    COREAI_RANKING_AGENT_ID="$COREAI_RANKING_AGENT_ID" \
    COREAI_KEYWORD_SKILL_AGENT_ID="$COREAI_KEYWORD_SKILL_AGENT_ID" \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --lifespan off
)
~~~

Stop idle before switching. Run **11E partial refresh capture** immediately before starting it, then run the same **11E non-active refresh readback** block. Rerun the capture/readback pair plus `刷新显示` immediately before any later partial viewport/new-page check whose proof window may have expired:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
test -n "${AW_PREVIEW_DIR:-}"
export AW_NONACTIVE_REFRESH_OUTPUT="$(mktemp "$AW_PREVIEW_DIR/partial-refresh.XXXXXX")"
export AW_EXPECTED_REFRESH_SCENARIO="partial"
(cd api && .venv/bin/python tests/agent_workbench_visual_fixture.py --refresh-scenario "$AW_PREVIEW_DIR/partial.db") | tee "$AW_NONACTIVE_REFRESH_OUTPUT"
~~~

Run **11E partial preview launch**:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/partial.db"
  export SEO_OPS_AUTH_USERNAME="preview-operator"
  export SEO_OPS_AUTH_PASSWORD="preview-only-password"
  export SEO_OPS_AUTH_SECRET="preview-only-fixed-auth-secret-0001"
  export SEO_OPS_COOKIE_SECURE="false"
  export SEO_OPS_OPERATOR_TIMEZONE="Asia/Shanghai"
  export SEO_OPS_AGENT_HISTORY_LIMIT="200"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    SEO_OPS_DB="$SEO_OPS_DB" \
    SEO_OPS_AUTH_USERNAME="$SEO_OPS_AUTH_USERNAME" \
    SEO_OPS_AUTH_PASSWORD="$SEO_OPS_AUTH_PASSWORD" \
    SEO_OPS_AUTH_SECRET="$SEO_OPS_AUTH_SECRET" \
    SEO_OPS_COOKIE_SECURE="$SEO_OPS_COOKIE_SECURE" \
    SEO_OPS_OPERATOR_TIMEZONE="$SEO_OPS_OPERATOR_TIMEZONE" \
    SEO_OPS_AGENT_HISTORY_LIMIT="$SEO_OPS_AGENT_HISTORY_LIMIT" \
    COREAI_BASE_URL="$COREAI_BASE_URL" \
    COREAI_API_KEY="$COREAI_API_KEY" \
    COREAI_AGENT_ID="$COREAI_AGENT_ID" \
    COREAI_EXECUTION_AGENT_ID="$COREAI_EXECUTION_AGENT_ID" \
    COREAI_KEYWORD_AGENT_ID="$COREAI_KEYWORD_AGENT_ID" \
    COREAI_AUDIT_AGENT_ID="$COREAI_AUDIT_AGENT_ID" \
    COREAI_RANKING_AGENT_ID="$COREAI_RANKING_AGENT_ID" \
    COREAI_KEYWORD_SKILL_AGENT_ID="$COREAI_KEYWORD_SKILL_AGENT_ID" \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --lifespan off
)
~~~

Stop partial. Never refresh stale; the helper must reject that request and its expired/static state is the acceptance subject. Run **11E stale preview launch**:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
(
  export SEO_OPS_DB="$AW_PREVIEW_DIR/stale.db"
  export SEO_OPS_AUTH_USERNAME="preview-operator"
  export SEO_OPS_AUTH_PASSWORD="preview-only-password"
  export SEO_OPS_AUTH_SECRET="preview-only-fixed-auth-secret-0001"
  export SEO_OPS_COOKIE_SECURE="false"
  export SEO_OPS_OPERATOR_TIMEZONE="Asia/Shanghai"
  export SEO_OPS_AGENT_HISTORY_LIMIT="200"
  export COREAI_BASE_URL="http://127.0.0.1:9"
  export COREAI_API_KEY="preview-only"
  export COREAI_AGENT_ID=""
  export COREAI_EXECUTION_AGENT_ID=""
  export COREAI_KEYWORD_AGENT_ID=""
  export COREAI_AUDIT_AGENT_ID=""
  export COREAI_RANKING_AGENT_ID=""
  export COREAI_KEYWORD_SKILL_AGENT_ID=""
  cd api
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" \
    SEO_OPS_DB="$SEO_OPS_DB" \
    SEO_OPS_AUTH_USERNAME="$SEO_OPS_AUTH_USERNAME" \
    SEO_OPS_AUTH_PASSWORD="$SEO_OPS_AUTH_PASSWORD" \
    SEO_OPS_AUTH_SECRET="$SEO_OPS_AUTH_SECRET" \
    SEO_OPS_COOKIE_SECURE="$SEO_OPS_COOKIE_SECURE" \
    SEO_OPS_OPERATOR_TIMEZONE="$SEO_OPS_OPERATOR_TIMEZONE" \
    SEO_OPS_AGENT_HISTORY_LIMIT="$SEO_OPS_AGENT_HISTORY_LIMIT" \
    COREAI_BASE_URL="$COREAI_BASE_URL" \
    COREAI_API_KEY="$COREAI_API_KEY" \
    COREAI_AGENT_ID="$COREAI_AGENT_ID" \
    COREAI_EXECUTION_AGENT_ID="$COREAI_EXECUTION_AGENT_ID" \
    COREAI_KEYWORD_AGENT_ID="$COREAI_KEYWORD_AGENT_ID" \
    COREAI_AUDIT_AGENT_ID="$COREAI_AUDIT_AGENT_ID" \
    COREAI_RANKING_AGENT_ID="$COREAI_RANKING_AGENT_ID" \
    COREAI_KEYWORD_SKILL_AGENT_ID="$COREAI_KEYWORD_SKILL_AGENT_ID" \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000 --lifespan off
)
~~~

In the authenticated `/agents` page, inspect 1180, 1440, and 1920 CSS-pixel widths plus 200% browser zoom. For every 200% row, set zoom first, then hard reload or open a new direct `/agents` navigation; observe first-load/paused hydration through the final snapshot, keyboard focus, page overflow, table reflow, and drawer reflow rather than zooming only an already-mounted page. Verify the complete matrix:

- active: the porcelain/white/navy/orange palette remains intact; bright teal and continuous motion appear only on the three fresh verified RUNNING signals across two owners; headline reads `2 个 Agent · 3 个 Run 进行中` and excludes the receipt/unknown signal, while queued, waiting, archiving, unknown, and terminal states remain textual/static;
- scale: all twelve Agents, the long name, multiple Runs from one Agent, the scrollable chip row/one detail panel, internal table scrolling, and drawer reflow remain usable without a five-card assumption;
- coverage: incomplete known total shows `基于已镜像 N/M 次`; unknown total shows `基于已镜像 N 次 · 上游总数未知`; never-confirmed counts show `当前数量未知 · 尚无成功确认`;
- idle: `当前全部空闲` appears only in the exact fresh fixture and the Network panel shows non-overlapping 30-second browser reads;
- active cadence: the Network panel shows non-overlapping five-second reads scheduled after prior completion;
- partial/stale: cached signals stay visible/static, exact-idle wording is absent, the partial 200% page preserves and reflows its tested 110-character display name, and no old motion returns after focus/visibility until a successful fresh response;
- pause: selecting a new range queues it without a request, `刷新显示` performs one read, clocks/receipt/focus freeze, resume expires old presentation first, and wording uses absolute snapshot time;
- interaction: keyboard-only Run tabs, row expansion, exact 20-plus-one history paging with the tested non-null `next_before`, native-browser drawer wrap plus inert-background exclusion, Escape/focus restoration, copy action, local links, focus rings, reduced motion, and forced-colors all follow their frozen contracts; this browser row, not jsdom, is the proof that sidebar/header/logout cannot receive sequential focus while the drawer is open.

Capture Network timestamps and one screenshot for active, idle, paused, partial, and stale states as acceptance evidence outside the source tree unless the project owner explicitly requests committed evidence.

After the last stale/browser row, stop the preview API in terminal B and Vite in terminal A with Ctrl-C, wait for both prompts, then prove no test server remains:

~~~bash
cd "$(git rev-parse --show-toplevel)"
set -e
set -o pipefail
if lsof -nP -iTCP:8000 -sTCP:LISTEN || lsof -nP -iTCP:5173 -sTCP:LISTEN; then
  echo "Agent Workbench acceptance server still running" >&2
  exit 1
fi
~~~

Final Task 11 acceptance is complete only after the separated checklist slices stage exactly four support files, inspect their cached diff, commit them, and prove the isolated worktree clean. No unrelated concurrent file may be staged or lost.

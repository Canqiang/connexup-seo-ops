# Task 9 implementation report

## Scope and truth boundary

- The original delivery changed only local SEO Ops desired-state Agent manifests, their schema, and manifest contract tests. Recorded fix-round rulings subsequently expanded Task 9 to the smallest honest SEO Ops runtime, persistence, Workbench, and task-detail UI paths described below.
- Did not call or mutate Core AI UAT and did not modify `core-ai`, `fbr-project`, or `fbr-agent`.
- Preserved every already-established tool and Skill ID. The three new specialists intentionally use `skill_ids: []`; no unpublished Skill ID was invented.
- These files describe desired state only. They do not prove UAT publication, binding, Run success, task persistence, external publication, or merchant-system mutation.

## TDD evidence

### RED — complete roster and API payload contract

Command:

```bash
cd server
npm test -- tests/coreAiAgentManifests.test.ts
```

Observed 8 expected failures before manifest edits:

- only 6 of the required 9 manifests existed;
- `manifest.schema.json` was absent;
- `response_schema` was a raw JSON object instead of the Core AI API's JSON string;
- common manifest metadata and explicit empty/null capability fields were absent;
- Planner lacked the explicit proposal-only wording;
- the GBP Post, Effect Review, and Report Packager manifests were absent.

### RED — merchant-facing report exclusion boundary

After the first GREEN pass, a new regression proved that the initial report output schema exposed `excluded_internal_artifact_ids`. The focused test failed until that field was removed from both `required` and `properties`.

### RED — Task and external-mutation boundary

A second focused regression failed because the existing six manifests did not uniformly state the shared boundary. Every prompt now states that the Agent never creates or persists SEO Ops Tasks and never alters external merchant systems.

### GREEN and verification

Focused contract and adapter command:

```bash
cd server
npm test -- tests/coreAiAgentManifests.test.ts tests/plannerAgent.test.ts tests/specialistAdapters.test.ts
```

Result: 3 files and 18 tests passed; the manifest contract alone has 9 passing tests.

Full server verification:

```bash
cd server
npm test
npm run typecheck
npm run build
git diff --check
```

Result: 28 files and 262 tests passed; TypeScript typecheck and build passed; diff check passed.

## Delivered behavior

- Added a versioned local JSON Schema for publishable desired-state manifests.
- Normalized all 9 manifests to include `manifest_version`, `thinking_effort`, bounded runtime, `enable_memory: false`, explicit `tools`/`skill_ids`/`subagent_ids`/`dataset_config`, `sandbox_config: null`, and string-encoded `response_schema`.
- Preserved the 5 known existing Skill IDs and 4 known read-only tool IDs without introducing new IDs.
- Kept Planner proposal-only with `seo_ops.task_proposals.v1`; it cannot persist, approve, dispatch, execute, or claim task completion.
- Preserved Keyword Set v2's US/`en-US`/Google method, accepted `seo-keyword-seed-generate` plus `seo-keyword-ranking-optimize` lineage, research fallback with `UNSCORED`, and explicit China/Wuhan/FBR prohibitions.
- Added GBP Post Content v1 as a US-English, exact-occurrence, versioned draft contract with no publication fields or publication claim.
- Added Effect Review v1 with baseline, action bundle, observed change, confounders, and conclusion tiers capped at `ASSOCIATIONAL`.
- Added Report Packager v1 for one frozen combined merchant-facing report from accepted artifact lineage, with internal-only material excluded and no send/upload/write behavior.

## Core AI API schema notes

- Read-only inspection of `CreateAgentRequest` and `UpdateAgentRequest` confirmed that `response_schema` is a Java `String`; all local manifests now encode the JSON Schema as a JSON string.
- `manifest_version` is local desired-state metadata and must be stripped by the later reconciler before a Core AI request.
- `thinking_effort` remains explicitly `null`, matching the API's nullable field and avoiding an unsupported reasoning-effort assumption for the selected model.

## Files

- Added: `server/core-ai-agents/manifest.schema.json`.
- Added: `server/core-ai-agents/seo-ops-gbp-post-content-v1.json`.
- Added: `server/core-ai-agents/seo-ops-effect-review-v1.json`.
- Added: `server/core-ai-agents/seo-ops-report-packager-v1.json`.
- Added: `server/tests/coreAiAgentManifests.test.ts`.
- Reconciled: Planner, Questionnaire Draft, Keyword Set v2, Evidence Audit, Ranking Baseline, and Execution Plan manifests.

## Self-review and residual Skill gaps

- Contract tests validate the exact nine-file roster, common local manifest schema, parseable object response schemas, bounded/no-memory/no-subagent posture, known tool and Skill allowlists, proposal-only Planner, US keyword/Post constraints, publication exclusion, causal cap, and merchant-report boundary.
- The new GBP Post Content, Effect Review, and Report Packager Agents have empty Skill lists because no verified published Skill ID was established in this task. This is the safe allowed state; selecting or creating a Skill requires separate inventory evidence and authorization.
- Local manifest tests do not validate UAT availability, model compatibility, publication, binding, or output quality. Those require the dry-run reconciler and independent UAT readback in Tasks 10/11.

## Fix round 1 — Core AI compatibility and reachable specialist paths

### Scope correction

- The review established that manifest-only desired state was insufficient: the three new specialists otherwise had no durable SEO Ops ingestion path, and GBP Post Content could not run before Gate 1. Per the recorded Task 9 ruling, this fix adds only the smallest server paths needed to make those roster entries honest.
- `GBP_POST` remains the content-generation binding. `GBP_EXECUTION` remains the approved external-write binding and is never called by the new content route.
- No Core AI UAT request was made. No file in `core-ai`, `fbr-project`, or `fbr-agent` was modified.

### RED evidence

Core AI schema compatibility and manifest-policy tests:

```bash
cd server
npm test -- --run tests/coreAiAgentManifests.test.ts
```

Observed: 4 failures. Response schemas still exposed unsupported `$schema`, schema-object `additionalProperties`, array-valued `type`, and conditional keywords; local manifest constraints, Planner proposal policy, Plan input prompt, and report freeze echo were also not yet aligned.

Planner/questionnaire/new-specialist runtime tests:

```bash
npm test -- --run tests/specialistAdapters.test.ts tests/plannerAgent.test.ts
```

Observed: 4 failures. Questionnaire accepted 7 questions, Planner could propose `PLANNER`, runtime policy exposed `PLANNER`, and Effect Review/Report Package parsers did not exist.

Durable REVIEW/REPORT_PACKAGE integration regression:

```bash
npm test -- --run tests/specialistAdapters.test.ts
```

Observed: REVIEW was dispatched through the generic unstructured payload rather than the versioned Effect Review request, and neither new output had its required artifact path.

Pre-Gate GBP content regression:

```bash
npm test -- --run tests/gbpPostContentAgent.test.ts
```

Observed: both tests returned route-level 404; there was no authenticated task-linked content Run, strict output ingestion, or idempotent Agent draft persistence.

### Implemented fixes

- Added a recursive contract test for the read-only Core AI `JsonSchema` subset. Every encoded response schema now uses a single string `type`, boolean `additionalProperties`, and only converter-supported keys. Nullable ranks use `anyOf`; unsupported keyword `if`/`then`/`uniqueItems` constraints remain enforced at the SEO Ops Zod boundary instead of being silently dropped by Core AI.
- Tightened the local manifest schema to `thinking_effort: null` and zero-capacity subagent/dataset arrays. Questionnaire cardinality is consistently 8–16 in both manifest and runtime.
- Kept internal `PLANNER` task support while excluding it from the Planner response schema, runtime parser, and allowed policy. Added distinct `REPORT_PACKAGE` task/mode/binding support.
- Added durable `EFFECT_REVIEW` and `MERCHANT_REPORT` specialist artifacts, strict parsers, structured request contracts, worker ingestion, exact report version/freeze validation, and deterministic run/type idempotency.
- Added `POST /api/seo-ops/tasks/:taskId/content-runs`: exact tenant/permission checks; `GBP_POST` content binding; task/location/style-profile/execution-spec validation; one task-linked `GBP_POST_CONTENT` Run; Core AI network I/O outside the transaction; and no execution attempt or external-write dispatch.
- Added strict `seo_ops.gbp_post_draft.v1` parsing and exact request-echo validation. Polling persists one `AGENT_GENERATED` draft via the existing content boundary. A partial unique `agent_run_id` index plus task-row locking makes concurrent pollers and crash replay converge on one versioned draft while leaving the Task before Gate 1.
- Plan prompt now requires `RANKING_SNAPSHOT`; Report Packager must echo `execution_spec.report_version` and `execution_spec.frozen_at` exactly. The three new Agents retain empty Skill lists pending authenticated Task 10 inventory.

### GREEN evidence

Focused contracts and adapters:

```bash
cd server
npm test -- --run \
  tests/coreAiAgentManifests.test.ts \
  tests/plannerAgent.test.ts \
  tests/specialistAdapters.test.ts \
  tests/gbpPostContentAgent.test.ts
```

Result: 4 files, 28 tests passed.

Full verification:

```bash
cd server
npm test -- --run
npm run typecheck
npm run build
cd ..
npm run build
git diff --check
```

Result: 29 backend test files and 272 tests passed; server typecheck/build, root production build, and diff check passed.

### Fix-round files and residual risks

- Manifests/schema/tests: `server/core-ai-agents/*`, `server/tests/coreAiAgentManifests.test.ts`, `server/tests/plannerAgent.test.ts`, `server/tests/specialistAdapters.test.ts`, `server/tests/gbpPostContentAgent.test.ts`.
- Runtime: task/Run/artifact/draft enums and repositories; draft migration; Planner/questionnaire/specialist adapters; content Run service, route, poller, views, and lifecycle projection compatibility.
- UAT publication and binding are still deliberately unproven. The new specialist Agents remain unbound until authenticated inventory/reconciliation in Task 10/11.
- Report packaging currently consumes only SEO Ops specialist artifacts supplied by the bounded adapter. A future explicit artifact-acceptance flag would make “accepted” independently queryable rather than relying on this existing persistence boundary.

## Fix round 2 — evidence-grade dispatch, frozen reports, and convergent content Runs

### RED evidence

Legacy draft migration:

```bash
npm --prefix server test -- --run tests/migrate.test.ts
```

Observed: the real legacy `seo_content_drafts` fixture failed with PostgreSQL `42703` (`column "agent_run_id" does not exist`) because the dependent unique index ran before the column migration.

Effect Review and Report Package:

```bash
npm --prefix server test -- --run tests/specialistAdapters.test.ts
```

Observed: the report request selected `newer-audit-not-frozen` instead of the explicit frozen `accepted-audit`. Follow-up REDs proved that an Effect Review could accept a forged action payload and that the manifest left action-bundle objects unconstrained.

GBP Post content:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts
```

Observed: concurrent equal inputs under different idempotency keys both returned `202` with separate Runs, and a second same-merchant Task bypassed the configured daily Run quota.

Frontend specialist artifacts:

```bash
npm run test:run -- src/features/tasks/SpecialistArtifactsPanel.test.tsx
```

Observed: an unrecognized artifact type crashed at `meta.icon`; the two new server artifact types had no wire metadata or rendering.

### Implemented fixes

- Removed the dependent draft unique index from pre-column schema execution. The idempotent column migration now adds nullable `agent_run_id` first and then creates the partial unique index. The regression covers fresh legacy upgrade, rerun, nullable duplicates, and non-null uniqueness.
- Added a strict Effect Review execution-spec packet: baseline, unique dated executed actions with evidence refs, bounded pre/post measurement windows with in-window observations, and non-empty confounders/limitations. Invalid packets fail in the adapter before any Core AI trigger. Persisted output must exactly echo every dispatched action field; it cannot invent, omit, or rewrite the action bundle.
- Report Package now requires server-stored `report_version`, `frozen_at`, and an explicit unique `source_artifact_ids` list. SEO Ops loads exactly those IDs in frozen order, rejects missing, foreign-merchant, duplicate, and non-merchant-safe/internal types, and requires an Audit source. It never selects a newer artifact dynamically. Report-level and every section lineage must be a unique subset of the frozen input allowlist before persistence.
- Tightened the Effect Review and Report Packager prompts to the same frozen/evidence boundaries. The Effect Review response schema now requires the exact action identity/type/date/evidence fields using only the Core AI-compatible JSON Schema subset.
- GBP content Runs now share the configured per-merchant daily Agent Run quota, use deterministic task/input fingerprints, converge equal fingerprints across different idempotency keys, reuse terminal same-fingerprint Runs/drafts, allow regeneration only after a changed fingerprint, and reject a different fingerprint while one Run is active. Partial unique indexes preserve these rules under concurrency.
- Added `EFFECT_REVIEW` and `MERCHANT_REPORT` frontend wire types, metadata, counts, evidence-limited details, and a safe unknown-type fallback that preserves title/summary/version instead of crashing.

### Verification evidence

Focused GREEN:

```bash
npm --prefix server test -- --run \
  tests/migrate.test.ts \
  tests/coreAiAgentManifests.test.ts \
  tests/specialistAdapters.test.ts \
  tests/gbpPostContentAgent.test.ts
npm run test:run -- src/features/tasks/SpecialistArtifactsPanel.test.tsx
```

Observed: all focused contracts passed.

Full verification:

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix server run build
npm run test:run
npm run build
git diff --check
```

Observed before final commit: backend 29 files / 274 tests passed; frontend 24 files / 143 tests passed; server typecheck/build and root production build passed. Frontend emitted only the pre-existing jsdom `--localstorage-file` and `window.scrollTo` warnings recorded in the SDD baseline.

### Boundaries and residual risks

- No Core AI UAT call or mutation occurred, and no file in `core-ai`, `fbr-project`, or `fbr-agent` was touched.
- The merchant-safe report allowlist is intentionally conservative: `KEYWORD_SET`, `AUDIT_REPORT`, and `RANKING_SNAPSHOT`. Adding another merchant-facing artifact type requires an explicit reviewed contract.
- Existing specialist-artifact persistence is the current accepted-artifact boundary; the schema still has no separate human acceptance flag. Report packaging therefore proves exact persisted lineage, same-merchant scope, and safe type, but not a future independent acceptance workflow.
- The three new Agents still have empty Skill IDs pending authenticated Task 10 inventory. Nothing in this fix claims UAT publication, binding, execution success, report delivery, or external merchant mutation.

## Fix round 3 — atomic quota, durable acceptance, exact effects, and audited retry lineage

### RED evidence

Atomic merchant quota and Effect Review equality:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/specialistAdapters.test.ts
```

Observed before implementation: two concurrent GBP content requests for different Tasks of the same merchant both returned `202`; the strict Effect parser accepted an extra output field; and output containing duplicate action A while omitting action B was persisted.

Artifact acceptance and legacy upgrade:

```bash
npm --prefix server test -- --run \
  tests/migrate.test.ts \
  tests/specialistArtifactAcceptance.test.ts \
  tests/specialistAdapters.test.ts
```

Observed before implementation: the legacy table had no `acceptance_status` column, artifact readback exposed no acceptance decision, the acceptance route returned `404`, and Report Package could not prove an independently accepted source.

Explicit GBP retry lineage:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts
```

Observed before implementation: failed Runs had no `business_input_fingerprint` or retry lineage columns, and the API had no explicit prior-Run/reason recovery contract.

Frontend acceptance-state projection:

```bash
npm test -- --run src/features/tasks/SpecialistArtifactsPanel.test.tsx
```

Observed before implementation: the panel did not render `ACCEPTED`, `PENDING`, `REJECTED`, or a safe legacy/unknown acceptance state.

### Implemented fixes

- GBP content quota enforcement now locks the persisted merchant row inside the same transaction that counts and inserts Agent Runs. The concurrent different-Task regression proves one `202`, one `429`, one database Run, and one Core AI trigger without relying on an in-memory mutex.
- Effect Review output now uses the same strict executed-action object schema as its input evidence packet. Extra fields fail parsing, duplicate IDs fail ingestion, and the unique action ID set plus every action field must exactly match the dispatched set bidirectionally.
- Specialist artifacts now persist a constrained acceptance decision: `PENDING`, `ACCEPTED`, or `REJECTED`, with actor, timestamp, and optional note. The legacy-safe idempotent migration adds and constrains the columns. `POST /api/seo-ops/artifacts/:artifactId/acceptance` requires exactly `seoops.approve`, applies tenant scope before mutation, replays the same decision without rewriting its audit record, and rejects a conflicting decision with `ARTIFACT_ACCEPTANCE_CONFLICT`.
- Artifact wire views and the frontend ledger expose acceptance state, including a safe unknown-state fallback. The previous misleading “accepted outputs” heading is now a neutral Agent output ledger.
- Report Package loads only the explicit frozen IDs from its execution spec and now additionally requires every source to be durably `ACCEPTED`; pending and rejected sources fail before Core AI dispatch. Existing same-merchant, conservative merchant-safe type, exact frozen-order, and output-lineage subset checks remain intact.
- GBP content Runs now persist a stable business-input fingerprint separately from the generation fingerprint, plus optional `retry_of_agent_run_id` and `retry_reason`. A completed same-input Run with a persisted draft remains a stable replay. `FAILED` (including trigger/strict-output failure) and `CANCELLED` Runs require an explicit same-task/same-business-input prior Run and reason; identical retry requests converge on one deterministic retry generation even under different idempotency keys. `TRIGGER_INTERRUPTED` remains blocked for manual reconciliation.
- Retry context is audit-visible in the Run view and dispatched input. No retry path creates an execution attempt or calls the `GBP_EXECUTION` external-write Agent.

### GREEN evidence

Focused backend and frontend verification:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/migrate.test.ts \
  tests/specialistArtifactAcceptance.test.ts \
  tests/specialistAdapters.test.ts
npm test -- --run src/features/tasks/SpecialistArtifactsPanel.test.tsx
```

Result: 4 backend files / 20 tests and 1 frontend file / 1 test passed.

Full verification:

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix server run build
npm run test:run
npm run build
git diff --check
```

Result: backend 30 files / 278 tests passed; frontend 24 files / 143 tests passed; backend typecheck/build, frontend production build, and diff check passed. Frontend emitted only the existing jsdom local-storage and unimplemented `scrollTo` warnings.

### Boundaries and residual risks

- No Core AI UAT request or mutation occurred. No file in `core-ai`, `fbr-project`, or `fbr-agent` was read for mutation or changed.
- The three new Agent manifests still intentionally contain no speculative Skill IDs. Authenticated inventory and UAT reconciliation remain Tasks 10/11.
- Acceptance mutation is server-complete and safely projected in the artifact panel; this Task does not add a new operator decision button to the existing task-detail UI.
- Retry lineage is application-validated and durable but deliberately does not add a database foreign key to legacy Agent Run rows. `TRIGGER_INTERRUPTED` recovery remains a manual reconciliation workflow rather than a generic retry.
- Nothing here claims report publication, merchant delivery, external GBP mutation, or causal proof.

## Fix round 4 — shared Run allocation, single retry chain, and operator artifact gate

### Scope correction

- This round supersedes the original manifest-only scope statement and the round-3 note that acceptance had no task-detail controls. The recorded review rulings require runtime and UI changes because Agent Run allocation, retry lineage, artifact acceptance, and the Workbench gate are part of the roster's honest reachable behavior.
- All changes remain inside the SEO Ops worktree. No Core AI UAT request or mutation occurred, and no file in `core-ai`, `fbr-project`, or `fbr-agent` was modified.

### RED evidence

Shared allocation and durable request semantics:

```bash
npm --prefix server test -- --run \
  tests/agentRuns.test.ts \
  tests/gbpPostContentAgent.test.ts
```

Observed before implementation: generic Stage and GBP creation used separate check-then-insert paths; two identical concurrent GBP requests under a daily limit of one returned `202` and `429` instead of converging; and a business-replay idempotency key could later be reused with changed retry semantics and still return `200`.

Retry lineage:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts
```

Observed before implementation: retry generation was not persisted, reason text participated in generation identity, stale ancestors could create a branch, the same key did not compare full retry semantics, and the latest completed/interrupted generation rules were incomplete.

Artifact insertion, migration, and Workbench projection:

```bash
npm --prefix server test -- --run \
  tests/migrate.test.ts \
  tests/specialistArtifactAcceptance.test.ts \
  tests/workbench.test.ts
```

Observed before implementation: ordinary repository input could forge `ACCEPTED`; decision metadata had no database consistency check; invalid/inconsistent legacy rows were not normalized; and pending artifacts produced no tenant-scoped `GATEKEEPING` action.

Task-detail controls and audit projection:

```bash
npm run test:run -- \
  src/features/tasks/SpecialistArtifactsPanel.test.tsx \
  src/features/workbench/WorkbenchPage.test.tsx \
  src/App.test.tsx
```

Observed before implementation: the task panel had no accept/reject controls, permission-aware read-only state, mutation/readback/refresh error handling, or retry lineage fields in technical audit output. A follow-up RED proved that a saved acceptance became visually ambiguous when the surrounding Task refresh failed.

### Implemented fixes

- Added one shared `allocateAgentRun` transaction boundary for Stage and GBP content Runs. It locks the merchant aggregate, resolves exact HTTP idempotency and business-equivalent replay before quota, counts every merchant Run for the UTC day, inserts the durable Run, commits, and only then permits the caller to trigger Core AI. The old outer quota checks are removed.
- Added `seo_agent_run_requests`, a durable request-key ledger pointing every accepted HTTP idempotency key to its converged Run. This preserves semantic conflicts even when a second key did not create the Run row. Migration backfills legacy creation keys and is idempotent.
- Made GBP retry lineage a single ordered chain per business fingerprint. Generation identity is parent Run plus numeric generation; reason remains audit metadata. Only the latest generation may be referenced. Failed/output-invalid/cancelled latest generations permit explicit retry; completed-with-draft replays; interrupted triggers remain reconciliation-only. A separate HTTP fingerprint covers prior Run, reason, generation, and current business inputs.
- Made ordinary specialist-artifact insertion unconditionally persist `PENDING` with null decision metadata. Only the permissioned acceptance service mutates a decision. Database checks enforce legal status plus decision actor/time consistency, while legacy invalid or incomplete rows are normalized to safe pending state before constraints are added.
- Projected pending artifacts into the authenticated operator's Workbench as `GATEKEEPING / ARTIFACT_ACCEPTANCE`, included them in filters, counts, and pagination, and exposed exactly one primary action back to the owning Task.
- Added task-detail acceptance controls for `seoops.approve` users, truthful read-only copy for users without permission, disabled pending mutation state, direct response readback, Task-resource refresh, and distinct mutation-versus-refresh failure messages. Existing accepted-source Report Package tests continue to prove that only an accepted artifact unlocks the packaging gate.
- Added retry parent, generation, reason, business fingerprint, and HTTP fingerprint to frontend Run/audit wire types and technical audit rendering.

### GREEN and verification evidence

Focused backend:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/migrate.test.ts \
  tests/specialistArtifactAcceptance.test.ts \
  tests/workbench.test.ts \
  tests/agentRuns.test.ts
```

Result: 5 files / 32 tests passed. The concurrency regressions assert HTTP outcomes, durable Run/request row counts, and Core AI trigger counts.

Focused frontend:

```bash
npm run test:run -- \
  src/features/tasks/SpecialistArtifactsPanel.test.tsx \
  src/features/workbench/WorkbenchPage.test.tsx \
  src/App.test.tsx
```

Result: 3 files / 44 tests passed.

Full verification:

```bash
npm --prefix server test
npm --prefix server run typecheck
npm --prefix server run build
npm run test:run
npm run build
git diff --check
```

Result: backend 30 files / 284 tests passed; frontend 24 files / 147 tests passed; server typecheck/build, root production build, and diff check passed. An initial simultaneous backend/frontend run caused two existing 5-second backend tests to time out under contention; both targeted reruns and the standalone full backend suite passed. Frontend emitted only the existing jsdom local-storage and unimplemented `scrollTo` warnings.

### Files and residual risks

- Run allocation/lineage: `server/src/services/agentRunAllocator.ts`, Stage/GBP services, Agent Run schema/types/repository/routes, and their migration/concurrency/retry tests.
- Artifact gate: specialist artifact schema/migration/repository, Workbench projection/tests, frontend API/types, task panel, audit projection, styles, and UI tests.
- `seo_agent_run_requests` intentionally follows the repository's existing no-foreign-key legacy posture; the allocator detects a request alias whose referenced Run is missing and fails closed. Retry branching remains intentionally unsupported.
- Workbench composition still follows the existing in-memory aggregate-then-page design. Pending artifact rows are tenant-scoped in SQL before payload material is read, but a future high-volume revision may move the combined multi-source ordering/pagination into a database projection.
- Nothing in this round proves UAT Agent publication/binding, Run output quality, report delivery, external merchant mutation, or four-merchant reconciliation.

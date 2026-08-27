# Task 9S security remediation report

## Status

**DONE**

Implementation commit: `24f3b9592b6fcb6a40732160d8a6103fd0947cf9` (`fix: enforce GBP run tenant scope`).

This remediation changed only the isolated SEO Ops worktree. It did not read or mutate Core AI UAT, did not create or reconcile real/UAT merchant records, and did not modify `core-ai`, `fbr-project`, or `fbr-agent`.

## Root-cause confirmation

The final Task 9 security review was correct:

1. `POST /api/seo-ops/tasks/:taskId/content-runs` authorized the requested Task, but discarded the authorized Task object. Early request-alias replay then compared only `taskId`, so a corrupt alias and referenced Run could retain Task A's ID while carrying merchant/location B and return B's full Run wire view, including `input_message`.
2. Explicit retry prior, latest business-generation lookup, active-Run lookup, creation-key compatibility replay, business replay, unique-race replay, and polled output ingestion did not all enforce the same exact Task/merchant/location scope.
3. Migration reconstructed lineage by `task_id` and parent Task equality, but did not load the referenced Task's merchant/location scope. Missing Task and cross-tenant/cross-location rows could therefore migrate.
4. The request ledger persisted only an opaque fingerprint. The creation-key alias was derivable from its Run, but aliases created when multiple HTTP keys converged on one business Run were not derivable after the HTTP fingerprint formula changed. Rewriting only the creation key left valid historical aliases conflicting.

The enforced runtime and migration invariant is now:

```text
run.task_id === task.id
run.merchant_id === task.merchant_id
run.location_id === task.location_id
```

Location equality is exact, including `null`. A persisted mismatch is a `CONTENT_RUN_RECONCILIATION_REQUIRED` integrity failure; it is never filtered away, returned to the caller, or replaced by a new Run.

## TDD RED evidence

Each regression exercised real routes/services/PostgreSQL state with literal expected outcomes. The production mutation caught by each test is recorded below.

### Early alias disclosure

Mutation caught: validate only `task_id` during early replay.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "authorized Task request alias"
```

RED: the real route returned `200` instead of `409` after the alias row and Run were changed to a foreign merchant/location; the foreign Run was eligible to expose its `input_message`.

### Creation-key compatibility replay and missing referenced Run

Mutations caught: omit location validation when the request-ledger row is absent; treat a missing referenced Run as an untyped server error.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "creation-key compatibility replay"
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "alias references a missing Run"
```

RED: wrong-location compatibility replay returned `200` instead of `409`; the missing referenced Run returned `500` instead of reconciliation-required `409`.

### Explicit retry prior scope

Mutations caught: omit merchant validation or omit exact location validation on the explicit prior generation.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "explicit retry whose prior Run"
```

RED: both merchant-corrupt and location-corrupt prior Runs returned `202` and triggered a replacement generation instead of returning `409`; both failures observed `expected 202 to be 409`.

### Latest and active lookup scope

Mutations caught: treat a corrupt latest generation as an ordinary failed generation; replay a corrupt active Run.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "latest business generation|active generation has"
```

RED: the corrupt latest row returned `CONTENT_RUN_RETRY_REQUIRED` instead of `CONTENT_RUN_RECONCILIATION_REQUIRED`; the corrupt active row returned `200` instead of `409` and was eligible to expose its foreign input.

### Polled output ingestion scope

Mutation caught: trust the Run's embedded request without independently loading and validating its Task scope before draft persistence.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "polled output ingestion"
```

RED: the corrupt Run became `COMPLETED` with no error instead of `FAILED / CONTENT_RUN_RECONCILIATION_REQUIRED`, and draft ingestion was not blocked.

### Migration Task and lineage scope

Mutations caught: do not load the referenced Task; omit merchant/location equality; accept a foreign parent.

```bash
npm --prefix server test -- --run tests/migrate.test.ts \
  -t "missing Task|Task merchant mismatch|Task location mismatch|foreign scope"
```

RED: all four migration cases resolved successfully instead of rejecting. Existing missing-parent and cycle regressions were also repaired to seed a real owning Task so their failures prove the intended lineage condition.

### Versioned aliases and rerunnable migration

Mutation caught: rewrite only the derivable creation key and leave two opaque business-convergence aliases incompatible.

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "pre-version creation key"
```

RED: after two migrations, a historical convergence key returned `409` instead of replaying the exact already-bound Run with `200`.

Mutation caught: accept a creation-key alias already bound to a different otherwise scope-valid Run.

```bash
npm --prefix server test -- --run tests/migrate.test.ts \
  -t "creation alias bound"
```

RED: migration resolved instead of rejecting the conflicting binding. The GREEN regression also proves transaction rollback leaves the original binding untouched.

### Generic alias compatibility

Mutation caught: allow `LEGACY_BOUND` to weaken non-GBP request comparison.

```bash
npm --prefix server test -- --run tests/agentRuns.test.ts \
  -t "never applies legacy-bound"
```

RED: a changed generic Stage Run request returned `200` instead of `409 IDEMPOTENCY_CONFLICT`.

The inherited fresh-alias regression `replays the same HTTP key and body after Gate 1 advances, but conflicts on a changed body` remains the strict-current behavior test. It proves a new `STRICT_CURRENT` alias still returns `409 IDEMPOTENCY_CONFLICT` for a different normalized body.

## Implementation decisions

### One exact runtime scope contract

- Added `AgentRunTaskScope` and one fail-closed assertion shared by the allocator, repository lookups, retry validation, and ingestion.
- The route now passes the already-authorized Task's `taskId`, `merchantId`, and exact `locationId` into the service before early alias replay.
- Both the request row's merchant and the referenced Run's Task/merchant/location are validated before a wire view is returned.
- Creation-key compatibility replay, business convergence, and unique-violation recovery use the same expected scope.
- Latest-generation, active-Run, and task-fingerprint repository contracts now require an explicit Task scope. Queries intentionally locate a conflicting Task-linked row first and then validate it, so corruption cannot be hidden by adding merchant/location predicates.
- Explicit retry prior validates Task, stage, merchant, location, and business fingerprint before allocation or Core AI trigger.
- Polled output ingestion independently reloads the Task and validates the Run before any draft is persisted. Integrity failures remain audit-visible as `CONTENT_RUN_RECONCILIATION_REQUIRED`, not `OUTPUT_INVALID`.
- Draft finalization and approval active-Run checks now pass the whole locked Task scope into the repository.

### Atomic migration scope reconciliation

- Migration loads every GBP content Run and the referenced Task scopes inside the existing single transaction.
- Missing Task, missing parent, cross-Task parent, Run/Task merchant mismatch, Run/Task exact-location mismatch, foreign-scope parent, parent/reason inconsistency, and lineage cycles throw actionable reconciliation errors.
- All Runs are scope-validated before retry generations or fingerprints are updated.
- A creation-key alias already bound to another Run is rejected and never rebound. Missing Run and alias/Run merchant mismatch also fail closed.
- Failure rolls back the entire migration; rerunning a successful migration is idempotent.

### Versioned request-ledger semantics

- Added persisted `semantics_version` with the closed database/runtime allowlist `STRICT_CURRENT` and `LEGACY_BOUND`.
- Fresh aliases are always `STRICT_CURRENT` and compare the current stable HTTP request fingerprint.
- A pre-version GBP alias whose key equals its Run's creation key is derivable: migration rebuilds the Run's current fingerprint and marks that alias `STRICT_CURRENT`.
- Every other pre-version GBP alias is `LEGACY_BOUND`: its opaque fingerprint and exact Run binding are preserved. It may replay only that scope-valid bound Run, even if the caller presents different request semantics; it can never be rebound by allocation or migration.
- Pre-version non-GBP aliases become `STRICT_CURRENT` without rewriting their stored fingerprint. Runtime also refuses to apply GBP legacy-bound behavior to generic Stage Run routes.
- Rerunning migration does not rewrite current aliases back to legacy or change legacy bindings.

## GREEN and full verification

Focused security, migration, generic compatibility, quota, and retry tests:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/migrate.test.ts \
  tests/agentRuns.test.ts
```

Result: **3 files / 51 tests passed**.

All Task 9 backend focused regressions:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/migrate.test.ts \
  tests/specialistArtifactAcceptance.test.ts \
  tests/workbench.test.ts \
  tests/agentRuns.test.ts \
  tests/coreAiAgentManifests.test.ts \
  tests/plannerAgent.test.ts \
  tests/specialistAdapters.test.ts
```

Result: **8 files / 82 tests passed**.

Full backend:

```bash
npm --prefix server test
```

Result: **30 files / 309 tests passed**.

Full frontend:

```bash
npm run test:run
```

Result: **24 files / 147 tests passed**. Output contained only the previously recorded jsdom `--localstorage-file` and unimplemented `window.scrollTo` warnings; there were no test failures.

Typecheck, builds, and diff hygiene:

```bash
npm --prefix server run typecheck
npm --prefix server run build
npm run build
git diff --check
```

Result: server TypeScript typecheck passed; server build passed; root Vite production build passed (`1865` modules transformed); `git diff --check` passed.

Final post-implementation migration/typecheck check:

```bash
npm --prefix server test -- --run tests/migrate.test.ts
npm --prefix server run typecheck
git diff --check
```

Result: **15 migration tests passed**, typecheck passed, and diff check passed.

## Changed files

Runtime and domain:

- `server/src/domain/agentRunRequestSemantics.ts`
- `server/src/domain/agentRunScope.ts`
- `server/src/services/agentRunAllocator.ts`
- `server/src/services/gbpPostContentService.ts`
- `server/src/services/agentRunPoller.ts`
- `server/src/services/taskService.ts`
- `server/src/routes/executionRoutes.ts`

Persistence, schema, and repository:

- `server/src/db/schema.ts`
- `server/src/db/migrate.ts`
- `server/src/repos/agentRunRepo.ts`
- `server/src/repos/agentRunTypes.ts`

Tests:

- `server/tests/gbpPostContentAgent.test.ts`
- `server/tests/migrate.test.ts`
- `server/tests/agentRuns.test.ts`

Report:

- `.superpowers/sdd/2026-08-26-seo-ops-operator-control-room-v2/task-9-security-remediation-report.md`

## Residual risks and boundaries

- The fail-closed migration intentionally turns pre-existing corrupt Task/Run/alias rows into an operational reconciliation requirement. No administrative repair tool is added in Task 9S; operators must repair such rows deliberately before startup migration can complete.
- `LEGACY_BOUND` intentionally favors the exact historical binding over fingerprint comparison because non-creation historical fingerprints are not derivable. Reusing such a key with a different body returns the historic Run only after exact Task/merchant/location validation; it never allocates or rebinds.
- The request ledger retains the repository's existing no-foreign-key posture. Runtime and migration perform explicit integrity validation instead.
- No Core AI UAT publication, binding, Run output, four-merchant reconciliation, or external GBP write was attempted or proven. Task 10/UAT work may proceed separately subject to its own credentials, stop rules, and acceptance conditions.

## Fix round 1/5 — pre-I/O scope enforcement and authorized-scope continuity

### Status and commit

**DONE**

Implementation commit: `09757be` (`fix: fail closed on corrupt GBP run scope`).

This fix remained confined to the isolated SEO Ops worktree. It did not call or mutate Core AI UAT, create merchant data outside test databases, perform an external GBP write, or modify `core-ai`, `fbr-project`, or `fbr-agent`.

### Root-cause confirmation

The independent review findings were reproduced against `945e3ce`:

1. `AgentRunPoller.processRun` called `client.getRun`, then persisted terminal deliverables, before GBP ingestion loaded the Task and detected a merchant/location mismatch. The late ingestion check could reject the draft but could not prevent foreign Core output or attachments from being materialized.
2. Task-linked replay scope omitted the expected stage. The runtime applied the GBP-stage check only to `LEGACY_BOUND`; a `STRICT_CURRENT` alias could therefore bind an authorized GBP Task to a same-Task/merchant/location non-GBP Run and return that wrong-stage Run view.
3. The route-authorized Task scope was not compared with the service-reloaded or transaction-locked Task. The allocator validated replay candidates but not the newly constructed `input.run`, so a mismatched Run could be inserted and subsequently triggered.
4. Direct Run/deliverable authorization trusted `run.merchant_id`, while merchant Run lists did not reconcile task-linked GBP rows with their Task. Corrupt rows were therefore visible to the corrupt Run merchant even though the Task merchant's task-audit query omitted them.

### RED evidence

Poll-before-scope mutation caught:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "terminalizes a corrupt RUNNING"
```

RED result: **1 failed / 27 skipped**. The zero-I/O assertion failed with `expected 1 to be 0`, proving the poller called `client.getRun` before validating the persisted GBP aggregate.

Strict-current wrong-stage mutation caught:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "strict-current alias that references"
```

RED result: **1 failed / 27 skipped**. The real route returned `200` instead of the hand-derived generic reconciliation `409`, proving `STRICT_CURRENT` did not enforce expected stage.

Reloaded/locked Task and new-Run mutations caught together:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "reloaded Task whose scope|transaction-locked Task whose scope|newly constructed Run"
```

RED result: **3 failed / 25 skipped**:

- reloaded corrupt Task produced an unrelated `400` instead of `409 CONTENT_RUN_RECONCILIATION_REQUIRED`;
- transaction-locked corrupt Task likewise returned `400` instead of the generic reconciliation `409`;
- mismatched `input.run` resolved with `{ inserted: true }` instead of rejecting before insertion.

These are behavior-first real service/route/PostgreSQL regressions. The concurrent test holds the authorized merchant aggregate lock, changes the Task scope while the route is blocked, releases the lock, and proves the locked recheck prevents both insertion and Core trigger.

### Implementation

- `AgentRunTaskScope` now requires literal stage `GBP_POST_CONTENT`; its shared assertion checks stage, Task ID, merchant ID, and null-sensitive location equality. Reconciliation uses the generic response `GBP Post content Run requires reconciliation` with `CONTENT_RUN_RECONCILIATION_REQUIRED`.
- Every task-linked replay contract supplies the expected stage. Both `STRICT_CURRENT` and `LEGACY_BOUND` aliases validate the same exact scope before returning a Run.
- The GBP content service compares the reloaded Task and transaction-locked Task with the route-authorized scope, validates the constructed Run before allocator entry, and revalidates it before Core trigger.
- The allocator validates task-linked `input.run` both at entry and immediately before insert. Replay, compatibility, business-convergence, and unique-race candidates retain the same full scope check.
- The poller loads and validates the linked Task before any Core `getRun`. It rechecks the fresh Run before terminal handling. A mismatch transitions the active Run to terminal `FAILED` with the generic reconciliation code/message, clears output, and returns before Core fetch, attachment download, deliverable persistence, draft ingestion, or terminal output persistence.
- Direct Run and deliverable authorization validates a task-linked GBP Run against its Task before merchant authorization, so neither the Task merchant nor a corrupt Run merchant can enumerate it. Merchant Run lists filter corrupt task-linked GBP rows before pagination/count. Task audit SQL applies exact GBP stage/Task/location predicates within the already-authorized Task merchant boundary, and deliverables are loaded only for visible Runs.

### GREEN and proportional verification

The five new security regressions:

```bash
npm --prefix server test -- --run tests/gbpPostContentAgent.test.ts \
  -t "terminalizes a corrupt RUNNING|strict-current alias that references|reloaded Task whose scope|transaction-locked Task whose scope|newly constructed Run"
```

Result: **1 file passed; 5 passed / 23 skipped**. The corrupt polling regression independently proves `getRunCount = 0`, attachment-download count `= 0`, no new deliverables, `output = null`, terminal generic reconciliation failure, empty task-merchant and corrupt-merchant lists, empty task audit Run list, and generic `404` for both Run detail and deliverable download.

Focused GBP/migration/generic alias compatibility:

```bash
npm --prefix server test -- --run \
  tests/gbpPostContentAgent.test.ts \
  tests/migrate.test.ts \
  tests/agentRuns.test.ts
```

Result: **3 files / 56 tests passed**.

Full backend:

```bash
npm --prefix server test
```

Result: **30 files / 314 tests passed**.

Full frontend and builds:

```bash
npm run test:run
npm --prefix server run typecheck
npm --prefix server run build
npm run build
git diff --check
```

Result: **24 frontend files / 147 tests passed**; server typecheck passed; server build passed; root production build passed with **1865 modules transformed**; `git diff --check` passed. Frontend output contained only the previously recorded jsdom `--localstorage-file` and unimplemented `window.scrollTo` warnings.

### Fix-round changed files

- `server/src/auth/httpAuth.ts`
- `server/src/domain/agentRunScope.ts`
- `server/src/repos/agentRunRepo.ts`
- `server/src/routes/executionRoutes.ts`
- `server/src/services/agentRunAllocator.ts`
- `server/src/services/agentRunPoller.ts`
- `server/src/services/agentRunScopeService.ts`
- `server/src/services/agentRunService.ts`
- `server/src/services/gbpPostContentService.ts`
- `server/src/services/taskService.ts`
- `server/tests/gbpPostContentAgent.test.ts`
- `.superpowers/sdd/2026-08-26-seo-ops-operator-control-room-v2/task-9-security-remediation-report.md`

### Residual risks and deferred Minors

- Corrupt rows are intentionally hidden from operator Run/deliverable surfaces and require an administrative reconciliation path not added in Task 9S. They remain directly auditable in the database by authorized maintainers.
- Merchant Run-list validation performs a Task lookup for each candidate GBP content Run before pagination. This is bounded by existing merchant history in the current implementation, but a future repository-level integrity projection may be preferable at larger scale.
- The review Minor requesting immutable raw runner logs remains deferred. This report records the exact commands, failure counts, distinguishing assertion output, and final suite counts, but does not add a new log-artifact subsystem.
- The allocator's generic-versus-task-linked input remains one API with an optional full `expectedReplayScope`; all current GBP callers now require exact stage/Task/merchant/location. A future discriminated allocator input can make that mode distinction structural without broadening this security fix.
- No Core AI UAT result, four-real-merchant reconciliation, or external persistence/readback was attempted; those remain separate acceptance work after review of this commit.

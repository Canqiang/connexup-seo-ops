# GBP Execution MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add a disabled-by-default, CREATE-only GBP publication path that schedules the exact approved Post, issues at most one write through Core AI, and completes only after exact readback.

**Architecture:** Keep generation and publication separate. Task 10B owns the versioned text/CTA/image draft; Task 11 snapshots that approved revision into an immutable GBP command, uses a dedicated write worker for one Core call, then uses a separate read-only worker to verify Google state. The generic worker remains available for non-GBP tasks and is explicitly barred from new GBP writes.

**Tech Stack:** TypeScript, Fastify, PostgreSQL, Zod, React, Vitest, existing Core AI HTTP client conventions.

**Spec:** .superpowers/sdd/2026-08-26-seo-ops-operator-control-room-v2/task-11-brief.md

## Global Constraints

- Modify only this SEO Ops worktree.
- Never modify Core AI, FBR Project, or FBR Agent source in this plan.
- CREATE_POST only; UPDATE_POST is rejected.
- No real GBP mutation during Tasks 1-4.
- No raw credential value may enter PostgreSQL, API JSON, logs, errors, tests, or Git.
- Core Run COMPLETED never implies provider success or Task completion.
- After trigger_started_at, the write command cannot be retried.
- Exact separate readback is the only DONE path.
- Use focused boundary tests plus typecheck/build; broad browser/UAT acceptance belongs to Task 12.

---

### Task 1: Immutable GBP contracts and persistence

**Files:**
- Create: server/src/domain/gbpExecutionContract.ts
- Create: server/src/repos/gbpExecutionRepo.ts
- Modify: server/src/db/schema.ts
- Modify: server/src/db/migrate.ts
- Modify: server/src/repos/types.ts
- Test: server/tests/gbpExecutionContract.test.ts
- Test: server/tests/gbpExecutionRepo.test.ts

**Interfaces:**
- Consumes: finalized execution_spec.content_draft from Task 10B and existing Task/approval transaction helpers.
- Produces: GbpExecutionCommandV1, GbpExecutionReceiptV1, GbpReadbackV1, canonicalGbpCommand(), hashGbpCommand(), and binding/command/claim/receipt/readback repository methods.

- [ ] **Step 1: Write failing contract tests**

~~~ts
expect(() => GbpExecutionCommandSchema.parse({...valid, operation: {kind: 'UPDATE_POST'}})).toThrow()
expect(hashGbpCommand(valid)).toBe(hashGbpCommand(structuredClone(valid)))
expect(() => GbpExecutionReceiptSchema.parse({...validReceipt, provider_mutation_count: 2})).toThrow()
expect(() => GbpExecutionReceiptSchema.parse({...validReceipt, extra: true})).toThrow()
~~~

- [ ] **Step 2: Run RED**

Run: cd server && npm test -- --run tests/gbpExecutionContract.test.ts

Expected: FAIL because the schemas/helpers do not exist.

- [ ] **Step 3: Implement strict parsed contracts**

~~~ts
export const GbpExecutionCommandSchema = z.object({
  schema_version: z.literal('seo_ops.gbp_execution_command.v1'),
  instruction_id: UuidSchema,
  task: TaskSnapshotSchema.strict(),
  core: CoreSnapshotSchema.strict(),
  gbp: GbpLocationSnapshotSchema.strict(),
  operation: z.object({kind: z.literal('CREATE_POST')}).strict(),
  draft: FinalizedDraftSnapshotSchema.strict(),
  scheduled_for: IsoInstantSchema,
  provider_idempotency_key: SafeOpaqueSchema,
  probe_ref: SafeOpaqueSchema,
}).strict()
~~~

Canonicalize only parsed JSON with the repository stable-JSON helper and hash UTF-8 bytes with SHA-256.

- [ ] **Step 4: Write failing repository/migration tests**

Assert additive rerunnable DDL, no token columns, unique (task_id, task_revision), CREATE-only operation constraint, one unresolved location command, complete lease tuple, and one immutable receipt.

- [ ] **Step 5: Implement tables and repository primitives**

Create seo_gbp_location_bindings, seo_gbp_commands, seo_gbp_command_states, seo_gbp_receipts, seo_gbp_readback_attempts, and nullable gbp_command_id on seo_execution_attempts. Store canonical JSON plus SHA and verify both on read. Claim with one transaction and FOR UPDATE SKIP LOCKED.

- [ ] **Step 6: Run GREEN and commit**

~~~bash
cd server
npm test -- --run tests/gbpExecutionContract.test.ts tests/gbpExecutionRepo.test.ts
npm run typecheck
git add server/src/domain/gbpExecutionContract.ts server/src/repos/gbpExecutionRepo.ts server/src/db/schema.ts server/src/db/migrate.ts server/src/repos/types.ts server/tests/gbpExecutionContract.test.ts server/tests/gbpExecutionRepo.test.ts
git commit -m "feat(gbp): add immutable execution contracts"
~~~

### Task 2: Gate 2 command snapshot and operator surfaces

**Files:**
- Create: server/src/services/gbpExecutionService.ts
- Modify: server/src/services/executionService.ts
- Modify: server/src/routes/executionRoutes.ts
- Modify: server/src/services/executionWorker.ts
- Modify: server/src/repos/executionRepo.ts
- Modify: server/src/views/mappers.ts
- Create: src/features/tasks/GbpExecutionPanel.tsx
- Create: src/features/settings/GbpLocationBindingPanel.tsx
- Modify: src/features/tasks/ExecutionPanel.tsx
- Modify: src/features/settings/AgentBindingsPanel.tsx
- Modify: src/api/types.ts
- Modify: src/api/seoOpsApi.ts
- Test: server/tests/gbpExecutionService.test.ts
- Test: src/features/tasks/GbpExecutionPanel.test.tsx

**Interfaces:**
- Consumes: Task 1 repository/contracts and Task 10B finalized draft.
- Produces: confirmGbpExecution(taskId, expectedTaskRevision, expectedExecutionSpecHash, scheduledFor, actor), exact binding GET/PUT, and GET /tasks/:id/gbp-execution.

- [ ] **Step 1: Add failing Gate 2 tests**

Cover exact approval revision/hash, merchant/location binding, active published write/readback Agent refs, one-image ownership/hash, duplicate confirmation convergence, and zero command/Core calls on drift.

- [ ] **Step 2: Run RED**

Run: cd server && npm test -- --run tests/gbpExecutionService.test.ts

- [ ] **Step 3: Implement atomic confirmation**

Inside one Task transaction, lock and reload Task, approval, finalized draft, deliverable and binding; parse/hash the command; insert or reuse one command/state/attempt; emit Task event; advance only to execution-confirmed. Reject route body/CTA/image fields with GBP_COMMAND_CONTENT_IMMUTABLE.

- [ ] **Step 4: Block generic GBP writes**

Exclude gbp_command_id attempts from the generic worker. New GBP auto-write Tasks without a dedicated command fail closed. Generic manual verification/reconciliation returns GBP_READBACK_REQUIRED or GBP_MANUAL_RECONCILIATION_FORBIDDEN.

- [ ] **Step 5: Add task/settings UI**

Render exact store, local/UTC schedule, body, CTA, authenticated local image, hashes and command state. Never render Core/provider image URLs or credential values.

- [ ] **Step 6: Run focused GREEN and commit**

~~~bash
cd server && npm test -- --run tests/gbpExecutionService.test.ts
cd .. && npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx
git add server/src/services/gbpExecutionService.ts server/src/services/executionService.ts server/src/routes/executionRoutes.ts server/src/services/executionWorker.ts server/src/repos/executionRepo.ts server/src/views/mappers.ts src/features/tasks/GbpExecutionPanel.tsx src/features/settings/GbpLocationBindingPanel.tsx src/features/tasks/ExecutionPanel.tsx src/features/settings/AgentBindingsPanel.tsx src/api/types.ts src/api/seoOpsApi.ts server/tests/gbpExecutionService.test.ts src/features/tasks/GbpExecutionPanel.test.tsx
git commit -m "feat(gbp): schedule approved post commands"
~~~

### Task 3: At-most-once Core write worker

**Files:**
- Create: server/src/services/gbpCredentialResolver.ts
- Create: server/src/services/gbpCoreAiClient.ts
- Create: server/src/services/gbpExecutionWorker.ts
- Modify: server/src/config.ts
- Modify: server/src/index.ts
- Test: server/tests/gbpExecutionWorker.test.ts

**Interfaces:**
- Consumes: Task 1 claim/state/receipt methods and exact command.
- Produces: runOneGbpExecution(workerId, now), with fake clients in tests and no implicit live call.

- [ ] **Step 1: Add failing at-most-once tests**

Cover two-worker single claim, pre-send drift, /api/auth/me mismatch, trigger timeout, lost Run ID, wrong Agent, Core failure/timeout/cancel, malformed receipt, command echo mismatch, and mutation count not equal to one.

- [ ] **Step 2: Run RED**

Run: cd server && npm test -- --run tests/gbpExecutionWorker.test.ts

- [ ] **Step 3: Implement fail-closed secret resolution**

Resolve basename-like references only under SEO_OPS_GBP_SECRET_DIR; reject path separators, symlinks, non-regular files, group/world-readable modes, oversized/empty values. Return an in-memory value and redact every error.

- [ ] **Step 4: Implement write lifecycle**

Claim one due command; validate snapshots; verify /api/auth/me; persist TRIGGERING and trigger_started_at before Core; trigger once; persist Run ID; poll only that ID; validate Agent ID and exact command input/hash; parse strict receipt. Valid APPLIED/ALREADY_APPLIED advances only to PENDING_VERIFY. Any ambiguity after the marker becomes OUTCOME_UNKNOWN and cannot re-trigger.

- [ ] **Step 5: Run focused GREEN and commit**

~~~bash
cd server
npm test -- --run tests/gbpExecutionWorker.test.ts
npm run typecheck
git add server/src/services/gbpCredentialResolver.ts server/src/services/gbpCoreAiClient.ts server/src/services/gbpExecutionWorker.ts server/src/config.ts server/src/index.ts server/tests/gbpExecutionWorker.test.ts
git commit -m "feat(gbp): dispatch one approved post safely"
~~~

### Task 4: Independent readback and exact completion

**Files:**
- Create: server/src/services/gbpReadbackWorker.ts
- Modify: server/src/services/gbpExecutionService.ts
- Modify: server/src/routes/executionRoutes.ts
- Modify: src/features/tasks/GbpExecutionPanel.tsx
- Modify: src/features/tasks/ReconciliationDialog.tsx
- Test: server/tests/gbpReadbackWorker.test.ts
- Test: src/features/tasks/GbpExecutionPanel.test.tsx

**Interfaces:**
- Consumes: valid receipt and readback identity from the immutable command.
- Produces: runOneGbpReadback(workerId, now), typed diff, and the sole exact DONE transition.

- [ ] **Step 1: Add failing readback tests**

Test transient read retry, account/location/post/body/CTA/media mismatch codes, extra/missing media, wrong Core Agent/Run, and exact match. Assert receipt alone is never DONE and exact match advances once.

- [ ] **Step 2: Run RED**

Run: cd server && npm test -- --run tests/gbpReadbackWorker.test.ts

- [ ] **Step 3: Implement read-only worker/comparator**

Use only the readback Agent/secret. Persist every strict observation before comparison. Retriable read failures may repeat; mismatch never enables a write. Only exact normalized comparison emits verified evidence and DONE transactionally.

- [ ] **Step 4: Finish operator UX**

Show receipt, latest readback, typed diffs, timestamps and safe probe. Replace GBP manual verification/reconciliation with read-only refresh and a no-write-retry explanation.

- [ ] **Step 5: Run focused suite/builds and commit**

~~~bash
cd server
npm test -- --run tests/gbpExecutionContract.test.ts tests/gbpExecutionRepo.test.ts tests/gbpExecutionService.test.ts tests/gbpExecutionWorker.test.ts tests/gbpReadbackWorker.test.ts
npm run typecheck
npm run build
cd ..
npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx
npm run build
git diff --check
git add server/src/services/gbpReadbackWorker.ts server/src/services/gbpExecutionService.ts server/src/routes/executionRoutes.ts src/features/tasks/GbpExecutionPanel.tsx src/features/tasks/ReconciliationDialog.tsx server/tests/gbpReadbackWorker.test.ts src/features/tasks/GbpExecutionPanel.test.tsx
git commit -m "feat(gbp): verify published posts by readback"
~~~

### Task 5: Authenticated UAT preflight and bounded enablement

**Files:**
- Create: scripts/uat/gbp-execution-preflight.mjs
- Modify: docs/RUNBOOK-v2.md
- Test: server/tests/gbpExecutionUatProjection.test.ts

**Interfaces:**
- Consumes: deployed Tasks 1-4, mounted credentials, authenticated Core/SEO Ops readback, and one user-selected George test location.
- Produces: redacted immutable preflight evidence. It issues no write.

- [ ] **Step 1: Implement GET-only preflight**

Verify exact write/readback Agent IDs and published refs, /api/auth/me identity, nonempty resource permissions, secret refs, GBP account/location, timezone, receipt schema, idempotency/probe behavior, and stable media readback identity. Never print tokens.

- [ ] **Step 2: Add stop-rule fixtures**

Missing/duplicate Agent, unrestricted API user, wrong location, URL-only image, missing mutation count, or unstable media identity must produce ready_for_live_write=false.

- [ ] **Step 3: Document live-write gate**

First write is one CREATE_POST on the exact George test location selected by the user. No partner write and no UPDATE. Independently read back before another command.

- [ ] **Step 4: Commit preflight**

~~~bash
git add scripts/uat/gbp-execution-preflight.mjs docs/RUNBOOK-v2.md server/tests/gbpExecutionUatProjection.test.ts
git commit -m "chore(gbp): add bounded UAT preflight"
~~~

Do not run live-write mode without the user naming the exact test location after reviewing preflight evidence.


# Task 11B report — Gate 2 command snapshot and operator surfaces

## Outcome

Task 11B is implemented locally on `codex/operator-control-room-v2-impl`, based on `5f96429acb328030c4991149bfe8f547f5f6e63f`.

The existing Gate 2 confirmation now branches approved `GBP_POST / AUTO_WRITE` Tasks into one immutable Task 11A command, command-state row, and linked generic attempt inside the locked Task transaction. This task does not add or start the dedicated provider worker: no network, Core, FBR, credential resolution, UAT, or GBP mutation occurred.

## Scope delivered

- Added exact merchant/location GBP execution binding GET/PUT routes.
  - GET requires `seoops.view`; PUT requires `seoops.schedule.manage`.
  - Create requires `expected_state_version=0`; updates use exact state-version CAS and return typed `GBP_BINDING_STALE` conflicts.
  - Binding input is strict. Secret fields accept Task 11A logical secret references only; validation errors do not echo rejected values.
  - `READY` requires the binding timezone and GBP location resource to match the current location record exactly.
  - Projection contains coordinates and logical secret references only, plus server-derived readiness/missing fields; it has no credential-value field.
- Branched the existing Gate 2 confirmation route for `GBP_POST / AUTO_WRITE`.
  - The accepted content-bearing inputs are only the schedule, expected Task state/revision/spec hash, and idempotency key.
  - Caller-supplied body, CTA, media, or any other content override is rejected with `GBP_COMMAND_CONTENT_IMMUTABLE` before command creation.
  - The locked transaction rechecks current Task status/revision/spec hash, matching approval, DONE dependencies, absence of unknown/in-flight chains, exact binding/location, finalized Task 10B draft, deliverable ownership/MIME/path/size/SHA, and local image bytes.
  - The Task 10B raw draft digest is verified with `draftSha256` and normalized to the Task 11A `sha256:` command contract without altering Task 10B persistence.
  - One canonical CREATE_POST command, initial state, and linked attempt are inserted atomically; Task advances only to `EXECUTION_CONFIRMED` and emits one event.
  - Repeating the same confirmation converges on the existing command. Drift creates zero commands and zero attempts.
- Made the generic path fail closed.
  - `gbp_command_id` attempts are excluded from generic dispatch and workbench unknown-attempt queries.
  - A legacy/new GBP AUTO_WRITE attempt without a dedicated command is rejected before Agent binding, Core client, or trigger logic.
  - Generic manual verification and reconciliation return typed `GBP_READBACK_REQUIRED` and `GBP_MANUAL_RECONCILIATION_FORBIDDEN` conflicts.
  - `GBP_UPDATE / AUTO_WRITE` remains disabled with `GBP_UPDATE_DISABLED`.
- Added safe operator projections and UI.
  - Task UI shows exact store/account/location, UTC and store-local schedule, approved body/CTA, authenticated local image, Task/draft/body/CTA/image/command hashes, and command state.
  - The projection omits Core/provider URLs, Core run identity, and all secret references/values.
  - Before confirmation, the panel shows the exact finalized Task 10B snapshot and disables Gate 2 when the exact location binding is absent or mismatched.
  - Settings exposes the exact binding editor, CAS state, readiness, and precise missing fields. Legacy `GBP_WRITE` and global `GBP_EXECUTION` are labelled insufficient for Gate 2.

## TDD evidence

### RED

Backend Gate 2 tests were added before the service/routes existed:

```text
cd server && npm test -- --run tests/gbpExecutionService.test.ts
Test Files  1 failed (1)
Tests       5 failed (5)
Key failures: exact binding routes were absent and the generic worker did not expose the required fail-closed behavior.
```

Frontend tests were added before the two panels existed:

```text
npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx src/features/settings/SettingsPage.test.tsx
GbpExecutionPanel import failed because the module did not exist.
SettingsPage did not render an exact GBP location binding panel.
```

### Final focused GREEN

```text
cd server && npm test -- --run tests/gbpExecutionService.test.ts
Test Files  1 passed (1)
Tests       10 passed (10)

npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx src/features/settings/SettingsPage.test.tsx
Test Files  2 passed (2)
Tests       15 passed (15)

cd server && npm run typecheck
exit 0

npm run build
exit 0; TypeScript project build and Vite production build completed

git diff --check
exit 0
```

The expanded backend matrix explicitly covers approval, finalized deliverable, binding, location identity, and local image-byte drift; each branch asserts zero command and zero attempt persistence. It also proves no Core call for command-bound or invalid legacy generic attempts, safe projection, duplicate convergence, immutable route content, binding CAS/secret validation, and typed generic verify/reconcile conflicts.

Per the delivery constraint, only these focused Task 11B tests, server typecheck, root build, and diff validation were run. No broad suite or browser pixel/UAT run was performed.

## Deterministic hashes

```text
SHA-256 server/src/services/gbpExecutionService.ts
82c232446bdfb83314daddaa7e50577ecd65f79360a49ef7e36d8ac9163b2b45

SHA-256 server/src/services/executionService.ts
bcc23dadfffb77f86e4ec619c716a36a3a38e9e273e935079b1c5c75d1eb0221

SHA-256 server/src/routes/executionRoutes.ts
c3f9dcb069a1dd7635587dccc2acc6c1fd0e11797f4a342b3e29248eebb46d24

SHA-256 server/src/services/executionWorker.ts
c85823f23ac250e5d1d4710b6635e97d68a0ab842a8b0b3bcc2daff74f4550c5

SHA-256 server/src/repos/executionRepo.ts
9337d78d7e461a6a663627ff5a5e5f31f10df892e2e7ab44f169ac9194e47200

SHA-256 server/src/views/mappers.ts
108010d1db29e2ed12cd597acb38dfd7d0478591030c1e61b34904869419d820

SHA-256 src/features/tasks/GbpExecutionPanel.tsx
95574320fcb054b327e21327d7af74db91d68be57bb211792821146d39e743aa

SHA-256 src/features/settings/GbpLocationBindingPanel.tsx
548ac5977b87506773e0c8a1dac49e08370fdb0407bc1cce19af94b3cf9ae766

SHA-256 server/tests/gbpExecutionService.test.ts
b62b7a8180da35e8007454cd945e916b27b76b3339e26d8cee2aad93bb090e48

SHA-256 src/features/tasks/GbpExecutionPanel.test.tsx
85094e726b75773faea09c668b663f903a3932c6fe90e5be6af685f2609c29a1
```

## Residual risks and deferred proof

- Task 11C/11D workers are intentionally absent. A confirmed command remains locally scheduled and cannot trigger Core or GBP in this task.
- No credentials were resolved and no live Agent/account/location/provider identity was authenticated. Exact live identities, provider CTA semantics, idempotency, receipt handling, and independent readback remain later stop-gated work.
- UI proof is jsdom component coverage plus a production build, not browser pixel acceptance.
- Broad non-GBP regression and migration integration remain Task 12 scope, per the explicit speed constraint. Existing generic execution behavior was changed only at the dedicated-command exclusion/fail-closed boundary.
- The branch and worktree are preserved after the narrow commit; no merge or push is performed.

## Fix Round 1 — minimal execution projection and full lifecycle UI

### Review findings closed

- The pre-confirmation Task execution projection no longer reuses the permissioned settings binding view. Its `binding` member is exactly `ready_for_gate2`, `missing_fields`, and `state_version`; account/location resources, Core API-user identities, write/readback Agent identities, published refs, secret refs, and binding audit identities are absent. Merchant/location display names and the location's own timezone remain available for the approved content/schedule preview. The settings GET/PUT projection remains unchanged and permissioned.
- `GBP_POST / AUTO_WRITE` now routes to `GbpExecutionPanel` for every Task lifecycle status. It cannot fall through to generic reconciliation, verification, DONE, or failure controls.
- Loading and failed GET states have explicit `载入中` and `读取失败` badges. `Gate2 已禁用` appears only after a successful projection reports missing/mismatched exact binding readiness.
- The immutable command panel now renders command status and state version, typed safe error, trigger marker/update time, immutable receipt status/mutation count, and independent readback diff/safe-error evidence already present in the strictly scoped non-secret projection.
- No Task 10A reconciler, Task 10B media logic, worker, credential path, Core/FBR integration, network/UAT behavior, or GBP write path was changed or invoked.

### Focused RED

The pre-confirmation leakage test failed against the full settings binding projection:

```text
cd server && npm test -- --run tests/gbpExecutionService.test.ts
Test Files  1 failed (1)
Tests       1 failed | 10 passed (11)
Key failure: binding returned 19 fields including Core/Agent/published/secret/account identities instead of the three readiness fields.
```

The initial UI review tests failed at the three missing behavior boundaries:

```text
npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx
Test Files  1 failed (1)
Tests       3 failed | 4 passed (7)
Failures: loading was labelled Gate2 disabled; state/receipt/readback evidence was absent; DONE used the generic panel.
```

After closing the named statuses, the exhaustive lifecycle test exposed the remaining whitelist boundary before its removal:

```text
npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx
Test Files  1 failed (1)
Tests       6 failed | 12 passed (18)
Failures: DRAFT, NEEDS_INPUT, BLOCKED, READY_FOR_APPROVAL, REVISION_REQUIRED, and APPROVAL_REVOKED still used the generic panel.
```

### Final focused GREEN

```text
cd server && npm test -- --run tests/gbpExecutionService.test.ts
Test Files  1 passed (1)
Tests       11 passed (11)

npm test -- --run src/features/tasks/GbpExecutionPanel.test.tsx
Test Files  1 passed (1)
Tests       18 passed (18)

cd server && npm run typecheck
exit 0

npm run build
exit 0; TypeScript project build and Vite production build completed

git diff --check
exit 0
```

The 18 frontend tests include explicit loading, error, OUTCOME_UNKNOWN, PENDING_VERIFY, and DONE coverage plus every other `SeoTaskStatus`. No broad suite or browser/UAT run was performed.

### Fix-round deterministic hashes

```text
SHA-256 server/src/views/mappers.ts
ee7a67c76e74199e2fad0650326797fb4de03b6c1afece5f649f17a63945be6a

SHA-256 server/tests/gbpExecutionService.test.ts
9b3ae18c96a57b56ccf64faf755cbb9e2f635ed69b0dac74caafd07d80096821

SHA-256 src/api/types.ts
f1787ed65312f60edf7e238b72177fa4d460688e0ba32a8c75d08a79ce92a138

SHA-256 src/features/tasks/ExecutionPanel.tsx
055fe30edc2adf8b9f364dc4e0d0f2f3adc5368d94808f570dbdb98343b580fb

SHA-256 src/features/tasks/GbpExecutionPanel.tsx
3de5c333fad0d74317820bbe5d5f78249b5598f9bbfdbfacc62494965aa533ee

SHA-256 src/features/tasks/GbpExecutionPanel.test.tsx
9d73d7c4093b6cb5e797b0b1ae6f849949f0684ab251d8c996e12a3f84c9aa29
```

### Remaining proof boundary

- Receipt/readback rendering is proven with strict wire fixtures and production build, not live worker/provider data. Task 11C/11D remain responsible for producing those records safely.
- Pre-approval GBP Tasks with no finalized Task 10B snapshot may correctly show a read error in the always-mounted dedicated panel; they are never mislabelled as a missing-binding Gate 2 decision.
- Broad non-GBP regression, browser visual QA, and live provider semantics remain deferred under the original stop rules.

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

# Task 11C report — at-most-once Core write worker

## Outcome

Task 11C is implemented locally on `codex/operator-control-room-v2-impl` as a disabled-by-default, dedicated `CREATE_POST` worker. It consumes only the immutable Task 11A command produced by Task 11B, resolves one merchant-scoped mounted Core credential in memory, writes the trigger marker before the Core call, accepts only an exact strict receipt, and advances a successful command only to `READBACK_PENDING`.

No UAT endpoint was accessed, no Core AI/FBR source was changed, no live Core Run was triggered, and no GBP provider write occurred during this task.

## Scope delivered

- Added a fail-closed mounted credential resolver.
  - Secret references must be short basename-only logical names.
  - Resolution is confined to the configured absolute secret directory.
  - Symlinks, non-regular files, group/world-readable modes, empty values, control/whitespace-bearing values, and values over 4096 bytes are rejected.
  - `O_NOFOLLOW`, pre/open inode comparison, and owner-only mode checks reduce link/race exposure.
  - Every failure becomes the same redacted `GBP credential unavailable` error; raw values, paths, and filesystem causes are discarded.
- Added a dedicated Core AI GBP client.
  - The per-location credential is used only in the bearer header.
  - `/api/auth/me`, trigger, and exact Run GET are bounded and parsed into minimal typed projections.
  - URLs, request content, remote bodies, and credentials are never reflected in errors.
  - The worker rejects a mismatched API-user ID or empty action-permission set before the trigger marker.
- Added the at-most-once worker lifecycle.
  - A read-only candidate-scope lookup feeds the existing Task 11A transactional, `FOR UPDATE SKIP LOCKED` claim because that repository interface requires exact merchant/location scope.
  - Before any Core call, the worker rechecks Task/revision/spec/approval, finalized draft digest/body/CTA/media, Agent Run and deliverable ownership, local image size/bytes/SHA, and the complete binding snapshot.
  - Drift becomes `BLOCKED_PRE_SEND`; no Core identity or trigger call is made.
  - `TRIGGERING` plus `trigger_started_at` is persisted before the one allowed trigger.
  - Missing/invalid Run ID or trigger failure becomes `OUTCOME_UNKNOWN`; the command cannot be claimed or triggered again.
  - An expired post-marker lease is atomically frozen as `OUTCOME_UNKNOWN` without contacting Core, covering a process crash between marker and durable outcome classification.
  - The lease is never shorter than the configured bounded poll window, preventing another worker from treating a live bounded poll as abandoned.
  - The worker polls only the returned Run ID and requires exact Run ID, write Agent ID, and byte-exact command input echo.
  - Core failure/timeout/cancel, wrong Agent/input, malformed receipt, mismatched command echo, or invalid mutation contract becomes `OUTCOME_UNKNOWN`.
  - Strict `APPLIED` / `ALREADY_APPLIED` receipt insertion and the two state transitions are one transaction. Receipt success reaches `READBACK_PENDING`, never Task `DONE`.
- Added a disabled-by-default boot gate.
  - `SEO_OPS_GBP_EXECUTION_ENABLED` accepts only exact `true` / `false` and defaults to false.
  - Enablement additionally requires `CORE_AI_BASE_URL` and an absolute `SEO_OPS_GBP_SECRET_DIR`.
  - `index.ts` starts/stops the dedicated worker independently from the generic execution worker.
  - The existing generic worker and global Core token are not used for dedicated GBP writes.

## TDD evidence

### RED 1 — missing worker modules

```text
cd server && npm test -- --run tests/gbpExecutionWorker.test.ts
Test Files  1 failed (1)
Cause: Cannot find module ../src/services/gbpCredentialResolver.js
```

### RED 2 — configuration gate absent

```text
cd server && npm test -- --run tests/gbpExecutionWorker.test.ts
Test Files  1 failed | 22 passed
Failure: loadConfig did not expose disabled GBP execution fields.
```

### RED 3 — abandoned trigger marker remained retriable/stuck

```text
cd server && npm test -- --run tests/gbpExecutionWorker.test.ts -t "expired post-marker"
Test Files  1 failed (1)
Expected OUTCOME_UNKNOWN; received TRIGGERING.
```

### Focused GREEN

```text
cd server
npm test -- --run tests/gbpExecutionWorker.test.ts
Test Files  1 passed (1)
Tests       24 passed (24)

npm run typecheck
exit 0
```

The focused matrix covers credential confinement/redaction, default-disable config, two-worker convergence, Task/draft/media/binding drift before Core, `/api/auth/me` mismatch, trigger timeout, lost Run ID, post-marker crash recovery, wrong Agent, input-echo mismatch, Core failed/timeout/cancel, malformed/mismatched receipt, invalid mutation count, receipt persistence, and the `READBACK_PENDING`-but-never-`DONE` boundary.

Per the speed constraint, no broad backend suite, browser/UAT acceptance, or live provider test was run.

## Deterministic hashes

```text
SHA-256 server/src/services/gbpCredentialResolver.ts
5daaa470bd592b2ffbbd0e2d7c8a30a985ee7865c38c031c22bda71c2b6996cc

SHA-256 server/src/services/gbpCoreAiClient.ts
f80a61af0d9ee6d1fa470fbf523711c95c348a18fc6504db074c3b950426b0ee

SHA-256 server/src/services/gbpExecutionWorker.ts
c3859a82038e3b3a13cb6ad72966743744a81690024c39f2763212dfe376001b

SHA-256 server/src/config.ts
2771faaaca23626f8fa20f1c8ac7ee4ba92dd14654859c6745eab91121933107

SHA-256 server/src/index.ts
ee252fea4383aa3d73fb61fdd04205020a4356341d47a345f6b4e096d7e5bbb9

SHA-256 server/tests/gbpExecutionWorker.test.ts
c99e25ea8a671c80752a1bb68fa2671cd8156a2cf31891869ab15edf952a7ad7
```

## Residual boundary

- The dedicated worker remains disabled unless deployment explicitly supplies the enable flag, Core base URL, and mounted merchant-specific secret directory.
- This phase does not prove a live UAT write Agent/Skill/tool contract, provider idempotency semantics, exact GBP account/location authorization, or stable provider media identity.
- Task 11D remains the sole exact persisted readback and Task `DONE` path. A receipt is intentionally insufficient.
- Task 11E preflight and an explicitly selected George test location remain mandatory before any live mutation. Partner locations remain read-only.

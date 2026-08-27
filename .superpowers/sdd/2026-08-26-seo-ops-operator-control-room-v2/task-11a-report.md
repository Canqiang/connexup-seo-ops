# Task 11A report — immutable GBP contracts and persistence

## Outcome

Task 11A is implemented locally on `codex/operator-control-room-v2-impl`.

- Initial implementation: `c929dd9cd8863dae43a4f3d0df591958e72560e3`
- Review Fix Round 1: `4c9bf2c11e9ea9f9336830af52f3f2ec0fc771a9`

The review fix replaces unrestricted state-row CAS with explicit legal transitions, hardens runtime and SQL invariants, and adds locked Task/approval/binding revalidation before command creation. It remains persistence-only: no worker, route, UI, credential access, Core/FBR edit, network/UAT action, or GBP write was added.

## Scope delivered

- Strict CREATE-only command, receipt, and readback schemas reject unknown keys before every repository write and reparse every read.
- Secret references are short lowercase logical names only. Token-shaped values, `coreai_` values, bearer strings, paths, whitespace, and overlong values are rejected without echoing rejected input.
- Scheduled UTC instants must be canonical millisecond `Z` timestamps. Local schedules require an explicit offset, represent the same instant, and match a valid IANA timezone.
- Canonical body, CTA, and image JSON/hash helpers are computed from the parsed command. Receipt hashes must match them exactly.
- Receipt status invariants are enforced:
  - `APPLIED`: mutation count 1, provider post identity, and applied time;
  - `ALREADY_APPLIED`: mutation count 0 and provider post identity;
  - `REJECTED_PRE_MUTATION`: mutation count 0 with no post identity or applied time.
- Safe failure persistence uses a closed typed error-code set; free-form error text is not stored.
- GBP schedule, lease, trigger, resolution, creation, and update columns use `TIMESTAMPTZ`, with chronological SQL checks.
- The command-state machine exposes only explicit legal transitions guarded by exact merchant/location scope, state version, current lease owner, and lease token.
  - `trigger_started_at` is monotonic and cannot be cleared.
  - A command cannot move backward to `SCHEDULED`.
  - `OUTCOME_UNKNOWN` must remain unresolved and occupies the unresolved-location uniqueness slot.
  - Only exact persisted readback completion can atomically move `OUTCOME_UNKNOWN` or `READBACK_RUNNING` to `DONE`.
- Every public command-state, receipt, and readback method joins `seo_gbp_commands` and requires exact merchant and location ownership.
- Claiming validates scope, canonical times, and lease ordering, then uses a transactional `FOR UPDATE OF s SKIP LOCKED` claim with a complete lease tuple.
- Command creation starts a transaction, locks and rereads the exact Task, approval decision, and location binding, and compares revision, hashes, identities, binding state/version, and schedule snapshots before inserting.
- Additive/rerunnable DDL includes `seo_execution_attempts.gbp_command_id -> seo_gbp_commands(id)` and rejects orphan references.
- Unique Task revision, instruction identity, and unresolved location-command constraints remain enforced.

## TDD evidence

### Original implementation RED

The initial Task 11A report recorded missing-module RED runs, a deliberately removed uniqueness constraint caught by tests, and an atomic command/state rollback failure caught before the transaction wrapper was added.

### Fix Round 1 RED

1. Contract hardening tests before implementation:

```text
npm test -- --run tests/gbpExecutionContract.test.ts
Test Files  1 failed (1)
Tests       4 failed | 3 passed (7)
```

The failures covered logical-name secret references, canonical/same-instant schedules, missing content-hash helpers, and rejected-pre-mutation receipt nullability.

2. Repository and migration hardening tests before implementation:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       6 failed (6)
```

The failures exposed free-form error storage, text timestamp/FK gaps, scope/state-claim gaps, and command creation that did not reject stale locked Task state.

3. Approval snapshot lock/revalidation test before implementation:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts -t "approval decision"
Test Files  1 failed (1)
Tests       1 failed | 6 skipped (7)
```

The command insert incorrectly succeeded when the locked Task's approval decision was absent.

### Final GREEN

```text
npm test -- --run tests/gbpExecutionContract.test.ts tests/gbpExecutionRepo.test.ts
Test Files  2 passed (2)
Tests       14 passed (14)

npm run typecheck
exit 0

git diff --check
exit 0
```

Only the two focused Task 11A test files were run, per the speed constraint. No broad suite was run.

## Deterministic hashes after Fix Round 1

```text
SHA-256 server/src/domain/gbpExecutionContract.ts
a4c880d604f348387465f1c6107ef06dcfdd839c9d6b48b59007d00fa5262ae2

SHA-256 server/src/repos/gbpExecutionRepo.ts
f61aed04bb1067ca57cade44012c7867c57c98531e2fe0642f2a16a8cae5cee0

SHA-256 server/src/db/schema.ts
8e13fc7312991f9027aed71ba4a1284020c8daf1c1c58fae023f26a3d9bdb6b5

SHA-256 server/src/db/migrate.ts
63f0b791d537a0d22fdd7ca5b3ed7e18209c3d7d32a9c1ec6a4de7e30dbbca7c
```

## Residual risks and deferred proof

- Tasks 2–4 remain unimplemented: no confirmation orchestration, provider worker, readback worker, route, or UI exists.
- The state machine permits `OUTCOME_UNKNOWN -> DONE` only through strict persisted exact-readback completion, but the future authenticated provider readback worker still needs its own contract and tests.
- Migration behavior was exercised against isolated local PostgreSQL schemas, including rerun after populated terminal state. No UAT or production migration/readback occurred.
- Exact live Core Agent/Skill/tool identity, merchant API-user authorization, provider idempotency, and provider receipt semantics remain deferred to the later authenticated GET-only preflight and explicitly approved bounded UAT.
- The dedicated execution path remains disabled and cannot perform provider mutation in this phase.

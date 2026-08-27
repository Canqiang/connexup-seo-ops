# Task 11A report — immutable GBP contracts and persistence

## Outcome

Task 11A is implemented locally on `codex/operator-control-room-v2-impl`.

- Initial implementation: `c929dd9cd8863dae43a4f3d0df591958e72560e3`
- Review Fix Round 1: `4c9bf2c11e9ea9f9336830af52f3f2ec0fc771a9`
- Review Fix Round 2: `505bdf570e21b2d1205b3a17924384597ae1a538`
- Review Fix Round 3: `f855072e5efb0fd5b107852aaff096a249464084`

The review fixes replace unrestricted state-row CAS with explicit legal transitions, make readback diffs server-owned and deterministic, preserve old-schema compatibility, harden runtime and SQL invariants, and add locked Task/approval/binding revalidation before command creation. The work remains persistence-only: no worker, route, UI, credential access, Core/FBR edit, network/UAT action, or GBP write was added.

## Scope delivered

- Strict CREATE-only command, receipt, and readback schemas reject unknown keys before every repository write and reparse every read.
- Secret references are short lowercase logical names only. Token-shaped values, `coreai_` values, bearer strings, paths, whitespace, and overlong values are rejected without echoing rejected input.
- Scheduled UTC instants must be canonical millisecond `Z` timestamps. Local schedules require an explicit offset, represent the same instant, and match a valid IANA timezone.
- Canonical body, CTA, and image JSON/hash helpers are computed from the parsed command. Receipt hashes must match them exactly.
- Receipt status invariants are enforced:
  - `APPLIED`: mutation count 1, provider post identity, and applied time;
  - `ALREADY_APPLIED`: mutation count 0 and provider post identity;
  - `REJECTED_PRE_MUTATION`: mutation count 0 with no post identity or applied time.
- Safe failure persistence uses a closed typed error-code set. The deprecated `safe_error_message` column is retained for additive compatibility, purged to `NULL`, protected by a validated always-NULL constraint, and never written by repository methods.
- GBP schedule, lease, trigger, resolution, creation, and update columns use `TIMESTAMPTZ`, with chronological SQL checks.
- The command-state machine exposes only explicit legal transitions. Write-side transitions require exact merchant/location scope, state version, current lease owner, and lease token; exact readback completion uses its separate proof and CAS.
  - `trigger_started_at` is monotonic and cannot be cleared.
  - A command cannot move backward to `SCHEDULED`.
  - `OUTCOME_UNKNOWN` must remain unresolved and occupies the unresolved-location uniqueness slot.
  - Only exact persisted readback completion can atomically move `OUTCOME_UNKNOWN` or `READBACK_RUNNING` to `DONE`.
- Every public command-state, receipt, and readback method joins `seo_gbp_commands` and requires exact merchant and location ownership.
- Public readback insertion rejects caller-supplied `diffCodes`. One deterministic comparator computes account, location, provider post, body, CTA, exact one-media identity presence/image hash, and readback-Agent diffs from the persisted strict command, valid receipt, and strict observation.
- Readback completion transactionally reloads and verifies command, receipt, and observation hashes, recomputes the comparator, and allows `DONE` only when the recomputed diff set is empty. It uses exact readback-attempt identity plus merchant/location/state-version CAS and never depends on or restores the historical write lease; mismatch remains `OUTCOME_UNKNOWN` and cannot reset to a write-enabled state.
- Claiming validates scope, canonical times, and lease ordering, then uses a transactional `FOR UPDATE OF s SKIP LOCKED` claim with a complete lease tuple.
- Command creation starts a transaction, locks and rereads the exact Task, approval decision, and location binding, and compares revision, hashes, identities, binding state/version, and schedule snapshots before inserting.
- Additive/rerunnable DDL includes `seo_execution_attempts.gbp_command_id -> seo_gbp_commands(id)` and rejects orphan references.
- Legacy incomplete `CLAIMED` leases are normalized before the strict lease constraint: no trigger marker returns safely to `SCHEDULED` with `CLAIM_LOST`; a trigger marker becomes unresolved `OUTCOME_UNKNOWN` with `TRIGGER_AMBIGUOUS`. Incomplete lease fields and legacy error text are cleared.
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

### Fix Round 2 RED

1. Initial server-owned diff and compatible-migration tests:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       3 failed | 5 passed (8)
```

The failures showed that the deprecated error column was dropped, an incomplete legacy lease prevented migration, and caller-provided empty diffs were accepted.

2. Comparator RED after the minimal caller-diff removal:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       3 failed | 5 passed (8)
```

The migration failures remained, and an account mismatch was rejected before a server-owned typed diff could be persisted. This established the missing deterministic comparator behavior before its implementation.

### Fix Round 3 RED

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       2 failed | 6 passed (8)
```

Both failures were `Invalid GBP exact-readback completion`: the migrated triggered command was correctly `OUTCOME_UNKNOWN` with its incomplete write lease cleared, but completion still required the historical write lease. The regression also covered mismatch remaining unresolved before an exact observation completes it.

### Final GREEN

```text
npm test -- --run tests/gbpExecutionContract.test.ts tests/gbpExecutionRepo.test.ts
Test Files  2 passed (2)
Tests       15 passed (15)

npm run typecheck
exit 0

git diff --check
exit 0
```

Only the two focused Task 11A test files were run, per the speed constraint. No broad suite was run.

## Deterministic hashes after Fix Round 3

```text
SHA-256 server/src/domain/gbpExecutionContract.ts
55d1ce35b5c130a71c5f12e49f12c55edec24c62bbb589d59160d31ce7e1262e

SHA-256 server/src/repos/gbpExecutionRepo.ts
4f7c8dc7631da90413d1307b20ff994dc524ad4afc056070e5a96313e61fc587

SHA-256 server/src/db/schema.ts
b048157e3ef4871005df9049752181f4b75c59b7cf250486d3960ac3e41b2488

SHA-256 server/src/db/migrate.ts
938c0ebaf134b8e5a54ba2ef2f1acbbc5a3e3b88f99e497e047732536b7cb69d
```

## Residual risks and deferred proof

- Tasks 2–4 remain unimplemented: no confirmation orchestration, provider worker, readback worker, route, or UI exists.
- The state machine permits `OUTCOME_UNKNOWN -> DONE` only through strict persisted exact-readback completion, but the future authenticated provider readback worker still needs its own contract and tests.
- `READBACK_RUNNING` currently uses exact attempt ID plus command state version because readback attempts do not yet have their own lease tuple; Task 11D must retain this fail-closed CAS or add an attempt-owned read lease without reusing the command write lease.
- Migration behavior was exercised against isolated local PostgreSQL schemas, including both incomplete legacy active-lease branches, rerun after normalization, and rerun after populated terminal state. No UAT or production migration/readback occurred.
- Exact live Core Agent/Skill/tool identity, merchant API-user authorization, provider idempotency, and provider receipt semantics remain deferred to the later authenticated GET-only preflight and explicitly approved bounded UAT.
- The dedicated execution path remains disabled and cannot perform provider mutation in this phase.

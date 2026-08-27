# Task 11A report — immutable GBP contracts and persistence

## Outcome

Task 11A is implemented locally on `codex/operator-control-room-v2-impl` in implementation commit `c929dd9cd8863dae43a4f3d0df591958e72560e3`.

The change adds strict CREATE-only command, receipt, and readback contracts; canonical parsed-JSON hashing; additive/rerunnable PostgreSQL persistence; exact tenant/location repository reads; immutable command/receipt storage; append-only readbacks; and a transactional `FOR UPDATE SKIP LOCKED` claim. It does not add workers, routes, UI, credentials, Core/FBR changes, network calls, UAT, or any GBP write.

## Scope delivered

- Added strict `seo_ops.gbp_execution_command.v1` parsing with:
  - UUID-bound instruction/Task/Core/draft identities;
  - exact Task revision, execution-spec hash, approval decision, Core user and Agent snapshots;
  - basename-only write/readback secret references, never secret values;
  - exact GBP account/location/timezone schedule snapshot;
  - one finalized body/normalized CTA/local image identity;
  - literal `CREATE_POST`; `UPDATE_POST` is rejected;
  - deterministic canonical JSON and `sha256:<hex>` over UTF-8 bytes after parsing.
- Added strict `seo_ops.gbp_execution_receipt.v1` and `seo_ops.gbp_readback.v1` parsing.
  - Unknown keys are rejected.
  - Provider mutation count is only `0 | 1`.
  - `APPLIED`, `ALREADY_APPLIED`, and `REJECTED_PRE_MUTATION` cross-field invariants are enforced.
  - Readback is exact structured observation; semantic similarity is not represented.
- Added five additive GBP tables and nullable `seo_execution_attempts.gbp_command_id`:
  - `seo_gbp_location_bindings`;
  - `seo_gbp_commands`;
  - `seo_gbp_command_states`;
  - `seo_gbp_receipts`;
  - `seo_gbp_readback_attempts`.
- Database constraints enforce:
  - exact location/binding and Task/merchant/location composite ownership;
  - unique `(task_id, task_revision)` and `instruction_id`;
  - CREATE-only operation;
  - one unresolved command state per merchant/location;
  - all-null or fully populated, ordered lease tuple;
  - one immutable receipt per command;
  - one generic execution-attempt projection per GBP command;
  - no token-named columns in the new GBP tables.
- Added repository primitives for:
  - exact location binding insert/read and state-version CAS update;
  - atomic standalone command+state insertion and a transaction-bound variant for Task 2;
  - exact command lookup by scope and Task revision;
  - command state read/CAS update;
  - due-command claim in one transaction with `FOR UPDATE OF s SKIP LOCKED`;
  - strict immutable receipt insert/read;
  - strict append-only readback insert/list.
- Every command, receipt, and successful readback read reparses strict JSON and verifies canonical bytes, SHA-256, duplicated identity columns, and immutable command linkage before returning data.

## TDD evidence

### RED

1. Contract test before implementation:

```text
npm test -- --run tests/gbpExecutionContract.test.ts
Test Files  1 failed (1)
Tests       no tests
Cause: missing ../src/domain/gbpExecutionContract.js
```

2. Repository/migration test before implementation:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       no tests
Cause: missing ../src/repos/gbpExecutionRepo.js
```

3. Constraint mutation check after adding explicit uniqueness/unresolved tests:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       1 failed | 3 passed (4)
Key failure: duplicate Task revision insert resolved instead of rejecting after the constraint was intentionally removed.
```

The constraints were restored before GREEN.

4. Atomic command/state regression before the transaction wrapper:

```text
npm test -- --run tests/gbpExecutionRepo.test.ts
Test Files  1 failed (1)
Tests       1 failed | 4 passed (5)
Key failure: state uniqueness rejected, but command-competing remained persisted.
```

The standalone wrapper now owns one transaction; Task 2 can use the exported transaction-bound primitive inside its aggregate transaction.

### GREEN

```text
npm test -- --run tests/gbpExecutionContract.test.ts tests/gbpExecutionRepo.test.ts
Test Files  2 passed (2)
Tests       9 passed (9)

npm run typecheck
exit 0

git diff --check
exit 0
```

One earlier parallel focused run hit the test framework's 10-second `beforeAll` hook timeout while migrating the isolated PostgreSQL schema and skipped four repo tests. The same repo file then passed 4/4 in 1.76 seconds, and the fresh final combined run passed 9/9 in 1.82 seconds. No timeout threshold was changed; this negative run is retained as transient local PostgreSQL/runner contention evidence.

## Deterministic hashes

```text
implementation commit
c929dd9cd8863dae43a4f3d0df591958e72560e3

SHA-256 server/src/domain/gbpExecutionContract.ts
efee91971953c429cabb9930e23cf45dbbb18210213dc83f08254ce1755f3541

SHA-256 server/src/repos/gbpExecutionRepo.ts
17d9907e9ebd47745f82e5501185a5cd165e26a75c595204401020b9675aab7a

SHA-256 server/src/db/schema.ts
c1ced6a028fa265f3c1cfecb36d8e7b353de3e4fc9fae62f2ba6359967d20b55

SHA-256 server/src/db/migrate.ts
8f0833e4f4ab0caa1e931971cba5d81b9e12ff71448ba6b0d32e23b84d230b8f
```

## Residual risks and deferred proof

- No Task 2 confirmation service exists yet, so approval/draft/deliverable snapshot selection and duplicate-confirmation convergence are not claimed by Task 11A.
- No write or readback worker exists yet. Lease/state primitives are persisted, but trigger ambiguity, receipt acceptance transitions, exact comparison, and the sole DONE transition remain Tasks 3–4.
- No API/UI projection exists yet. Secret references are stored; later projections must continue excluding them and later workers must sanitize all safe error fields before persistence.
- Migrations were exercised twice against isolated local PostgreSQL schemas. No UAT or production database migration/readback occurred.
- Exact live Core Agent/Skill/tool, merchant API-user authorization, provider idempotency, provider receipt semantics, and stable media identity remain blocked on the later authenticated GET-only preflight and explicit bounded UAT approval.
- The dedicated path remains disabled and cannot perform any provider mutation in this phase.

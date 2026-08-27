# Task 10A — Safe Core AI Agent reconciler implementation report

## Scope and external-state boundary

- Implementation commit: `228d30d` (`feat(agents): add safe UAT reconciliation tooling`).
- Changed only the Task 10A-owned client, script, tests, package script, and runbook before this report.
- No Core AI, FBR Project, FBR Agent, Agent manifest, GBP runtime, merchant data, binding, or credential was modified.
- No UAT/network request was made. The only command-interface smoke explicitly removed `CORE_AI_BASE_URL` and `CORE_AI_TOKEN` and stopped before client construction.
- No DELETE method or request exists. A newly created Agent has no automated deletion rollback.

## RED evidence

Initial behavior-first suite:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
```

Before production code: exit 1; 1 suite failed during collection because
`../src/services/coreAiAgentAdminClient.js` did not exist. This was the expected missing-feature failure.

The local read-only Core AI source-contract check then identified the real list envelope. The exact regression was changed to `{ agents, total }` and run before the parser fix:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts -t "requires one exact reference"
```

Before the fix: exit 1; 1 test failed / 10 skipped with `Core AI Agent list response is invalid`.

Core AI also normalizes persisted empty lists to `null`. The real-view regression ran before remote normalization:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts -t "null list views"
```

Before the fix: exit 1; 1 test failed / 11 skipped because `tools: null` was rejected instead of matching desired `tools: []`.

The bounded-response regression ran before streamed byte enforcement:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts -t "unknown-length JSON stream"
```

Before the fix: exit 1; 1 test failed / 12 skipped because the oversized unknown-length stream was fully consumed and not cancelled.

## Implemented safety contract

- HTTPS is mandatory except explicit localhost/127.0.0.1/IPv6-loopback test origins. Base URL credentials, query, fragment, and non-origin paths are rejected.
- Endpoint paths are internally fixed and dynamic path segments are encoded. Fetch uses `redirect: "error"`, timeout abort, JSON content checks, declared and streamed byte limits, and sanitized status/path-only errors.
- The bearer token is closed over by the client and used only in the Authorization header. Fetch error text and remote bodies are never copied into result/error/log/evidence output.
- Mutation payloads are rebuilt from the explicit local manifest/Core AI request allowlist; `manifest_version`, local metadata, and unknown remote fields do not cross the boundary.
- Desired names require `[SEO Ops]`; `GooglePost每周图文助手` is exact/unique-discovered and reported only as `EDITABLE_REFERENCE_ONLY`, with metadata and hashes rather than prompt text.
- Dry-run uses reads only and emits `CREATE`, `UPDATE`, `NO_CHANGE`, changed field names, and hashes.
- Apply uses the server-returned UUID for create, or an ownership-checked existing managed UUID for update; it then publishes and independently reads by ID. Any normalized field/status/name/ID mismatch aborts before later manifests.
- Reference IDs are rejected at create-response, update, publish, and rollback target gates, including malicious response fixtures.
- Rollback is ownership check + PUT + publish + independent GET. Evidence contains a managed coordinate and sanitized previous normalized fields/hashes, never a full prompt. New Agents explicitly have no DELETE rollback.
- Evidence paths must be absolute, repository-contained, and free of traversal/symlink escape; evidence is opened append-only with no-follow semantics and sanitized before writing.

## GREEN and full verification evidence

Focused client regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts tests/coreAiClient.test.ts
```

Result: 2 files / 21 tests passed (13 admin/reconciler tests and 8 existing Core AI client tests).

Full backend:

```bash
npm --prefix server test
```

Result: 31 files / 327 tests passed.

Full frontend:

```bash
npm run test:run
```

Result: 24 files / 147 tests passed. Output retained only the pre-existing jsdom `--localstorage-file` and unimplemented `window.scrollTo` warnings.

Build, type, script, and diff gates:

```bash
npm --prefix server run typecheck
npm --prefix server run build
npm run build
npx --prefix server tsc --noEmit --target ES2022 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck --types node \
  server/scripts/reconcile-core-ai-agents.ts
git diff --check
```

Result: all exit 0. Server TypeScript build passed; root TypeScript/Vite production build passed with 1865 modules transformed; script-only strict TypeScript check and diff check passed.

No-network command-interface smoke:

```bash
env -u CORE_AI_BASE_URL -u CORE_AI_TOKEN \
  npm --prefix server run agents:reconcile -- --mode=dry-run
```

Result: exit 1 before client/network use with `CORE_AI_BASE_URL and CORE_AI_TOKEN are required in the environment`, as expected.

## Residual risks and deferred external proof

- No UAT call, creation, update, publish, binding, or live readback was authorized in Task 10A; real API permission and deployment behavior remain unproved.
- The locally inspected Core AI source currently populates Agent view `created_by` through a display-name resolver, while the required fail-closed gate compares `existing.created_by` to `/api/auth/me.user_id`. The client intentionally does not weaken that rule. If deployed UAT has the same representation, existing-Agent apply will stop before mutation until Core AI exposes an owner ID; create/readback remains separately usable. The reference summary records owner ID only when an explicit `owner_id` exists and otherwise records null.
- Core AI GET/export is an editable definition view, not a guaranteed published runtime snapshot. Therefore reference hashes support inspection only and do not prove a clone of the published runtime.
- Core AI update semantics do not clear some nullable fields when sent null. A differing remote nullable field will therefore fail the independent readback instead of being silently accepted.
- A newly created Agent cannot be automatically rolled back without DELETE. The tool records that boundary and stops for manual handling.

---

## Fix round 1 — reviewed CREATE-only plan/apply contract (2026-08-27)

This section supersedes the earlier implementation-contract claims above wherever they conflict. In particular, this release has no existing-Agent UPDATE path and no executable rollback path. The corrected implementation commit is `720c48adfc05f20314a5894e2bd2be501c934e94` (`fix(agents): enforce reviewed create-only reconciliation`).

### Corrected behavior

- Reference and desired exact-name discovery exhausts the real paginated `{ agents, total, page, limit }` envelopes from global `query=...` requests. Existing desired Agents also require a complete `my=true&include_system_default=false` ownership roster. Duplicate, cross-owner, inconsistent-page, inconsistent-total, system-default, or ambiguous results stop before mutation.
- Reconciliation is versioned CREATE-only. An existing exact desired Agent is `NO_CHANGE` only when its complete normalized editable configuration matches and unsupported/unknown executable settings are empty. Any drift requires a new versioned `[SEO Ops] ... vN` manifest name. The client exposes GET, POST create, and POST publish only; no PUT or DELETE method exists.
- Dry-run requires exactly one explicit scope (`--all` or one-or-more `--manifest` paths), normalizes the whole selected roster before remote access, and writes a no-follow, repository-contained, file-and-parent-fsynced reviewed plan. The plan binds ordered paths, manifest hashes, reference coordinate/hash, remote pre-state/action hashes, and an overall digest.
- Apply accepts scope only from that plan. It re-reads/re-hashes all local files and re-discovers the reference and every desired remote pre-state before the first POST. File, ALL-scope, remote, reference, duplicate, symlink, unknown, malformed, or plan-schema drift stops before mutation.
- Apply validates and opens the repository-contained append-only journal before remote mutation. Each known-safe create/publish intent and response/readback outcome is appended and fsynced independently; a later failure leaves earlier success evidence durable. New Agents report `NO_DELETE_REMOTE_ROLLBACK`, which is a limitation statement rather than an executable rollback claim.
- The request deadline remains effective across response headers, streamed body reads, and JSON parsing. Declared and streamed byte limits, URL/origin constraints, redirects, content type, bounded errors, and credential/prompt non-persistence remain fail closed.
- Every apply uses the mandatory reference coordinate embedded in the reviewed plan. A create response that reuses the reference UUID is journaled and rejected before publish.
- Post-publish readback rejects unknown or non-empty unmanaged executable fields and proves only `EDITABLE_CONFIG_AND_STATUS_ONLY`; it never claims published runtime snapshot equivalence.

### RED evidence captured before fixes

Initial binding-review regressions:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "Task 10A create-only review regressions"
```

Result before production changes: exit 1; 5 failed / 13 skipped. The prior client incorrectly classified a cross-owner by-name miss as CREATE, classified existing drift as UPDATE, accepted non-empty `system_prompt_id` as NO_CHANGE, allowed apply without the mandatory reference coordinate, and cleared the abort deadline before a stalled response body completed.

Comprehensive replacement suite:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result before the corrected implementation: exit 1; 13 failed / 1 passed. Missing reviewed-plan dry-run/apply exports, incomplete pagination, mutable update/rollback behavior, scope/drift gates, journal durability, and stalled-body handling all failed; only immediate streamed byte-limit cancellation passed.

Explicit CLI scope regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "explicit CLI scope contract"
```

Result before the parser implementation: exit 1; 1 failed / 14 skipped because `parseAgentReconciliationArguments` was absent.

Strengthened later-roster readback regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result before the readback-context fix: exit 1; 1 failed / 14 passed. The second created Agent correctly stopped on a post-publish unmanaged `system_prompt_id`, but the thrown diagnostic lacked readback context. The fix preserves a typed `READBACK_FAILED` record and returns a bounded readback failure.

Absolute JSON-parse deadline regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "absolute deadline through synchronous JSON parsing"
```

Result before the deadline fix: exit 1; 1 failed / 15 skipped because a deliberately stalled parse resolved after the configured deadline. Absolute checks before/after parsing made the same regression pass.

Standalone script compilation also exposed an optional-temperature narrowing error (`TS2322`, `unknown` not assignable to `number`); the normalized optional number is now explicit.

### GREEN and full verification evidence

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts tests/coreAiClient.test.ts
```

Results on the implementation commit: 16/16 Task 10A tests passed; focused compatibility passed 2 files / 24 tests (16 admin/reconciler plus 8 existing Core AI client tests).

```bash
npm --prefix server test -- --maxWorkers=1
```

Result: 31 files / 330 tests passed. Two earlier high-contention diagnostic runs were not treated as green: the server suite run concurrently with the UI suite had four unrelated 5-second timeouts; a subsequent default-worker server run had one untouched GBP migration test time out at 5.061 seconds (30/31 files, 328/329 tests). That exact GBP test independently passed in 342 ms (1 passed / 27 skipped), and the contention-free full run above passed all 330 tests.

```bash
npm run test:run
npm --prefix server run typecheck
npm --prefix server run build
npm run build
cd server && npx tsc --noEmit --module NodeNext --moduleResolution NodeNext \
  --target ES2022 --types node scripts/reconcile-core-ai-agents.ts
git diff --check
```

Results: UI 24 files / 147 tests passed; server typecheck and build passed; root TypeScript/Vite build passed with 1865 modules transformed; standalone reconciler script compilation passed; diff check passed.

Credential-free command-interface smoke (no network/client construction):

```bash
env -u CORE_AI_BASE_URL -u CORE_AI_TOKEN \
  npm --prefix server run agents:reconcile -- --mode=dry-run --all \
  --plan=/Users/xander/git_repo/connexup-seo-ops/.worktrees/operator-control-room-v2-impl/docs/evidence/task-10a-no-env-smoke.plan.json
```

Result: expected exit 1 with `CORE_AI_BASE_URL and CORE_AI_TOKEN are required in the environment`; no plan/evidence file or network request was produced.

### External boundary and residual concerns

- No UAT/network call, Core AI/FBR change, Agent manifest edit, GBP runtime change, binding, merchant write, or credential use/persistence occurred. Live API permissions and deployment behavior remain unproved.
- GET/readback evidence remains an editable configuration/status view, not a published runtime snapshot or execution-equivalence proof.
- Created remote Agents cannot be automatically rolled back because DELETE is intentionally absent. The fsynced journal preserves the exact safe mutation coordinates for manual handling.
- The reviewed-plan SHA-256 digest detects accidental/local drift but is not a signature or independent authorization system; operator review of the repository-contained plan remains the authorization boundary.
- Complete discovery can prove only the Agents visible to the authenticated Core AI API principal. The reconciler fails closed on duplicate/inconsistent visible results and ownership ambiguity, but cannot independently prove server-side RBAC completeness without authorized live validation.

---

## Fix round 2 — immutable reference, inode-isolated artifacts, and pre-publish identity proof (2026-08-27)

Implementation commit: `42d696c2ae7994a412079a44168a06c96c9498dc` (`fix(agents): harden reconciliation identity gates`). This round changed only `server/src/services/coreAiAgentAdminClient.ts`, `server/tests/coreAiAgentAdminClient.test.ts`, and `docs/RUNBOOK-v2.md`. The existing Task 10A CLI script required no code change because every new boundary is enforced by the library entry points it invokes.

### RED evidence

Controller-ruling regression suite before production changes:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result: exit 1; 9 failed / 14 passed. The failures proved that callers could replace the reference name, unknown remote field names leaked in errors, a matching DRAFT could become `NO_CHANGE`, plan paths were not restricted to a fixed directory, hard-linked manifests were not identified by inode, reference `field_hashes` were not covered by `coordinate_hash`, evidence could alias a manifest/plan or reuse a pre-existing journal, the normal path lacked pre-publish validation events, and an unsafe create response was published before independent validation.

The first path-gate implementation run exposed a test-environment canonicalization bug:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result: exit 1; 16 failed / 7 passed because macOS temp paths entered as `/var/...` canonicalized to `/private/var/...`; the target basename was subsequently resolved against the already-realpathed fixed parent rather than comparing lexical aliases.

Ambiguous system-default regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "validates the created ID as a new owned exact DRAFT before publish"
```

Result before the exact-false gate: exit 1; 1 failed / 22 skipped. A created view with `system_default=null` was published. The corrected gate requires `system_default === false` before publish and after publish readback; the same exactness applies to existing-Agent `NO_CHANGE`.

Fixed-directory component-symlink regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "symlinked fixed artifact directory"
```

Result before component validation: exit 1; 1 failed / 23 skipped because a symlinked configured plan directory resolving to another repository directory was accepted. The corrected implementation lstat-checks every fixed directory component before realpath containment checks.

Pre-existing principal ID regression:

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts \
  -t "already present in the full principal roster"
```

Result before the pre-POST roster snapshot: exit 1; 1 failed / 24 skipped. A malicious fake service rewrote an existing principal-owned Agent into a matching DRAFT during POST and the reconciler published it. Apply now snapshots the complete authenticated-principal roster before any POST and rejects any returned ID already present there.

### Corrected safety contract

- The only reference coordinate is the private fixed constant `GooglePost每周图文助手`; dry-run has no `referenceName` input and CLI rejects `--reference`. Runtime objects containing an override-shaped property are ignored and never queried.
- The plan reference record binds fixed name, ID, status, timestamps, explicit `owner_id` when available, managed hash, per-managed-field hashes, per-unsupported-executable-field hashes, unmanaged-executable-empty and unknown-fields-empty summaries, label, and evidence scope. `coordinate_hash` covers that full record. Apply rediscovers and compares the complete canonical record before any POST.
- When Core AI does not expose a stable `owner_id`, the reference records null. It does not reinterpret display-name `created_by` as an owner ID.
- Plan files are restricted to `docs/evidence/core-ai-agent-plans/*.json`; journals are restricted to the distinct `docs/evidence/core-ai-agent-journals/*.jsonl`; both directories must exist, be non-symlink directory components, remain in the repository, and remain outside the manifest root.
- Plan, journal, and selected manifests must have distinct canonical paths and file identities. Existing files are checked by `dev/ino` and must have `nlink === 1`; symlinks, hardlinks, traversal, wrong extensions, and path/inode changes fail closed.
- New plan and journal files use exclusive create and `O_NOFOLLOW`. The implementation refuses to run if `O_NOFOLLOW` is unavailable. It rechecks descriptor/path `dev/ino`, canonical path, regular-file status, and link count around durable writes.
- Apply requires a nonexistent journal, durably creates and fsyncs its first typed record plus parent directory before reference/remote revalidation, and rechecks journal identity before and after every append. It never appends to a prior journal.
- Existing exact desired Agents may be `NO_CHANGE` only when status is exactly `PUBLISHED`, `system_default` is exactly false, ownership roster proof succeeds, and full managed/unmanaged state matches. Status and published timestamp participate in `remote_state_hash` and apply drift checks.
- Before any publish of a new Agent, apply has already snapshotted the complete principal roster. It then independently GETs the returned ID, completes global exact-name and full `my=true&include_system_default=false` pagination, and requires a previously unseen ID, exact desired name, exact DRAFT status, exact non-system-default state, full managed-field equality, and empty unsupported/unknown executable state. Failure writes a durable typed `PREPUBLISH_VALIDATION_FAILED` record and stops without publish, PUT, or DELETE.
- Unknown remote field names are no longer echoed in errors. Evidence and errors continue to omit prompt/token/body contents.

### GREEN and full verification evidence

```bash
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts
npm --prefix server test -- --run tests/coreAiAgentAdminClient.test.ts tests/coreAiClient.test.ts
```

Results: Task 10A 25/25 passed; focused compatibility 2 files / 33 tests passed (25 admin/reconciler plus 8 existing Core AI client tests).

```bash
npm --prefix server test -- --maxWorkers=1
```

Result: 31 files / 339 tests passed.

```bash
npm run test:run
npm --prefix server run typecheck
npm --prefix server run build
npm run build
cd server && npx tsc --noEmit --module NodeNext --moduleResolution NodeNext \
  --target ES2022 --types node scripts/reconcile-core-ai-agents.ts
git diff --check
```

Results: frontend 24 files / 147 tests passed; server typecheck/build, root TypeScript/Vite build (1865 modules), standalone reconciler script compilation, and diff check all exited 0. Frontend output retained only the existing jsdom local-storage and `window.scrollTo` warnings.

Credential-free command-interface smoke:

```bash
env -u CORE_AI_BASE_URL -u CORE_AI_TOKEN \
  npm --prefix server run agents:reconcile -- --mode=dry-run --all \
  --plan=/Users/xander/git_repo/connexup-seo-ops/.worktrees/operator-control-room-v2-impl/docs/evidence/core-ai-agent-plans/no-env-smoke.json
```

Result: expected exit 1 before client construction or artifact/network action with `CORE_AI_BASE_URL and CORE_AI_TOKEN are required in the environment`.

### External boundary and residual risks

- No UAT/network request, credential use/persistence, Core AI/FBR repository change, Agent manifest edit, GBP runtime change, binding, or merchant mutation occurred. Live API permissions, owner visibility, eventual consistency, and deployment behavior remain unproved.
- The pre-publish identity proof intentionally uses one immediate bounded readback sequence. A deployment with delayed list/read consistency will fail closed and require operator retry with a new reviewed plan; it will not guess or publish an unproved ID.
- `O_NOFOLLOW`, exclusive creation, repeated canonical/dev/ino/nlink checks, and descriptor-based I/O reduce filesystem races but cannot eliminate every TOCTOU action by another process that has write permission to the fixed directories or manifest tree. Those paths must remain operator-restricted.
- Reference and created-Agent GET evidence proves only editable configuration and status, never published runtime snapshot or execution equivalence.
- Created Agents still have `NO_DELETE_REMOTE_ROLLBACK`; there is no automated remote rollback, PUT, or DELETE capability.
- Complete discovery remains bounded by what the authenticated Core AI principal is allowed to list. Duplicate, inconsistent, or ambiguous visible state fails closed, but RBAC completeness requires authorized live validation outside Task 10A.

---

## Fix round 3 — write-all evidence journal and pre-publish negative coverage (2026-08-27)

Implementation commit: `3cfafe20ed36ce509ce3e23421aebfd3cd347be4` (`fix(agent-reconcile): make evidence writes complete`). This round changed only `server/src/services/coreAiAgentAdminClient.ts`, `server/tests/coreAiAgentAdminClient.test.ts`, and `docs/RUNBOOK-v2.md`.

### RED evidence

The behavior-first regressions were run before changing production code:

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result: exit 1; 4 failed / 27 passed (31 total). The failures were precise:

- repeated seven-byte writes left malformed JSON instead of completing each journal record;
- a zero-byte `JOURNAL_OPENED` write still allowed create and publish;
- a partial then zero-byte `CREATE_INTENT` still allowed create;
- a partial then zero-byte `PUBLISH_INTENT` still allowed publish.

The injected write exception regression already stopped before remote access, while the newly explicit post-create duplicate-global-exact, non-empty unmanaged executable field, unknown remote field, later-page principal roster, and later-page global discovery cases also already failed closed before publish. The latter cases parsed the resulting journal and required `PREPUBLISH_VALIDATION_FAILED` as the final complete record.

An earlier command used `server/tests/...` while already inside `server/` and therefore found no files; it was corrected to `tests/...` and was not counted as RED evidence.

### Corrected durability contract

- Every JSONL event is first encoded to a UTF-8 `Buffer`. `EvidenceJournal.append` loops over byte offsets until the complete record has been written.
- Each write must report a safe-integer `bytesWritten` greater than zero and no larger than the remaining bytes. Zero, negative, non-integer, oversized, or thrown writes stop immediately.
- `fsync` occurs only after the complete record has been written. Descriptor/path identity is still checked before writing and after fsync.
- An incomplete `JOURNAL_OPENED` stops before remote revalidation. An incomplete `CREATE_INTENT` stops before create, and an incomplete `PUBLISH_INTENT` stops before publish.
- The runbook now states the same write-all-then-fsync ordering and intent-before-POST gate implemented by the code.
- Pre-publish tests explicitly cover a duplicate exact name on a later global page, a returned existing ID on a later principal-roster page, non-empty unmanaged executable state, and unknown remote fields. Each path permits the create already requested, writes a complete typed validation failure, and makes zero publish calls.

### GREEN and full verification evidence

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result: 1 file / 31 tests passed.

```bash
cd server
npm test
npm run typecheck
npm run build
```

Results: server 31 files / 345 tests passed; server typecheck and TypeScript build exited 0.

```bash
npm run test:run
npm run build
git diff --check
```

Results: frontend 24 files / 147 tests passed; root TypeScript/Vite production build exited 0 with 1865 modules transformed; diff check exited 0. Frontend output retained only the existing jsdom local-storage and unimplemented `window.scrollTo` warnings.

### External boundary and residual risks

- No UAT/network request, credential use/persistence, Core AI/FBR repository change, Agent manifest edit, GBP runtime change, binding, or merchant mutation occurred.
- An underlying I/O failure after a short prefix can leave one incomplete trailing JSONL record. The reconciler stops without fsyncing or acting on that incomplete event; all earlier fsynced records remain durable for recovery.
- If `PUBLISH_INTENT` fails after create and pre-publish validation, the remote DRAFT may remain. The earlier complete `CREATE_OUTCOME` and validation outcome identify it, but the intentional no-PUT/no-DELETE contract means resolution is manual and remains `NO_DELETE_REMOTE_ROLLBACK`.
- `fsync` relies on the host filesystem and operating system honoring their documented durability semantics. Existing directory-permission and TOCTOU limitations from Fix Round 2 remain unchanged.
- Live Core AI visibility, owner/RBAC completeness, eventual consistency, and deployment behavior remain unproved because this task did not access UAT.

---

## Fix round 4 — legacy-compatible read-only reference snapshot (2026-08-27)

Implementation commit: `b6f48b11b74d79d236ec47b8c83e09811cdc2767` (`fix(agent-reconcile): accept legacy reference snapshots`). This round changed only `server/src/services/coreAiAgentAdminClient.ts`, `server/tests/coreAiAgentAdminClient.test.ts`, and `docs/RUNBOOK-v2.md`.

### Trigger and RED evidence

An authenticated read-only dry-run performed outside this implementation task reported that the fixed reference detail uses `max_turns=40`, nullable `model`/`response_schema`, nullable `dataset_config`/`skill_ids`/`subagent_ids`, and exact `{id,type,source}` tools. No plan or UAT mutation was created by that diagnostic.

The behavior-first regressions were then run locally without credentials or network access:

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result before production changes: exit 1; 3 failed / 32 passed (35 total). Legacy-reference dry-run and apply-drift setup both failed at the desired-manifest `max_turns <= 20` rule with `Agent manifest max_turns is invalid`. The strict desired-manifest regression already rejected each of `max_turns=40`, `model=null`, and `response_schema=null` before any remote call.

The first implementation run exposed that the old generic reference fixture omitted `source` from its tool object: 20 failed / 15 passed with `Reference Agent tool shape is invalid`. The fixture was corrected to mirror the authenticated detail shape; the dedicated missing-source negative test remains and fails closed.

### Corrected compatibility boundary

- `discoverReference` now uses a private `readOnlyReferenceSnapshot`; desired classification, created-DRAFT validation, published readback, and mutation payload construction continue using the strict `AgentManifest` normalizer.
- The read-only reference type is structurally separate from `AgentManifest`: nullable model/schema/arrays cannot be passed to `createAgent`, and the snapshot has no create/publish entry point.
- Reference numeric fields require finite/safe positive Core values where applicable, so legacy `max_turns=40` is accepted without relaxing the desired manifest maximum of 20.
- Nullable string/array fields are normalized explicitly. Null arrays remain null rather than becoming `[]`, and every editable/mutation field receives an individual hash; null-to-array and numeric drift therefore change the complete reference coordinate.
- Reference tools require the exact `{id,type,source}` key/type shape. Unknown remote fields and malformed known editable/executable fields fail closed without leaking values.
- Unsupported executable fields are type-checked, normalized, and individually hashed. The combined editable hash still includes managed state, unsupported state, and system-default state, while the plan persists hashes rather than prompt contents.
- Apply rediscovers the reference with the same independent normalizer. A `max_turns` change or `skill_ids: null -> []` change stops after the durable `JOURNAL_OPENED` record and before any POST.

### GREEN verification evidence

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
npm run typecheck
cd ..
git diff --check
```

Results: focused Task 10A 1 file / 35 tests passed; server typecheck exited 0; diff check exited 0.

### External boundary and residual risks

- This implementation round made no UAT/network request, used or persisted no credential, and changed no Core AI/FBR repository, Agent manifest, Task 10B/11 file, GBP runtime, binding, or merchant state.
- The legacy compatibility is intentionally fixed-reference-only. Any `[SEO Ops]` desired manifest with the same nullable fields or `max_turns=40` remains invalid.
- Nullable scalar fields that are absent are normalized to null for compatibility; nullable arrays preserve the security-relevant null-versus-array distinction required by the reviewed coordinate.
- Any future Core API reference field or tool-shape change fails closed and requires a reviewed compatibility update; this code does not infer a mutation payload from an unfamiliar reference response.
- GET/reference hashes remain editable configuration/status evidence only, not published snapshot or runtime-equivalence proof.

---

## Fix round 5 — roster-proven nullable system-default marker (2026-08-27)

Implementation commit: `2bd3e522bf53d25dc451ab1a85abc1b4f833d88f` (`fix(agent-reconcile): prove nullable system ownership`). This round changed only `server/src/services/coreAiAgentAdminClient.ts`, `server/tests/coreAiAgentAdminClient.test.ts`, and `docs/RUNBOOK-v2.md`.

### Trigger and RED evidence

An authenticated read-only diagnostic performed outside this implementation task showed that a newly created exact DRAFT was uniquely present in both complete global exact discovery and `my=true&include_system_default=false` discovery with the same ID, while detail returned `system_default=null`. The existing reconciler stopped before publish solely because it required detail `system_default === false`.

Local behavior-first regressions were added and run without network or credentials:

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
```

Result before production changes: exit 1; 3 failed / 35 passed (38 total):

- an existing exact PUBLISHED desired Agent with null detail marker and complete global/principal ownership proof was rejected;
- a newly created exact owned DRAFT with the same null marker stopped before publish;
- an Agent removed from the authenticated-principal roster after publish incorrectly passed detail-only readback.

The same suite already rejected a true marker, null without principal-roster membership, and invalid marker types.

### Corrected proof boundary

- A shared fail-closed assertion now requires exactly one global exact row, exactly one authenticated-principal exact row with the same ID, exact detail ID/name, and a detail marker of only boolean false or null.
- Null is never accepted from detail alone. True, missing, string, or any other marker remains invalid; false is still accepted under the same ownership proof.
- Existing desired classification uses the proof before allowing PUBLISHED `NO_CHANGE`; status, strict configuration, unmanaged-field, ownership, and create-only checks remain unchanged.
- New DRAFT validation uses the proof after the existing pre-create full principal-roster snapshot and before publish. Returned IDs still cannot be pre-existing, the reference ID, duplicated, non-DRAFT, misnamed, or configuration-drifted.
- Post-publish readback now independently repeats complete global exact and full `my=true&include_system_default=false` discovery, then rechecks exact PUBLISHED status, normalized managed configuration, unmanaged executable state, unknown fields, and the nullable non-system proof.
- A post-publish ownership/roster drift writes durable `READBACK_FAILED` evidence and stops. It does not PUT, DELETE, retry-publish, or claim rollback.
- The runbook records the nullable-marker proof and states that an exact DRAFT left by an earlier failed create is never reused, updated, or published. Cleanup versus a new version remains an explicit operator decision.

### GREEN verification evidence

```bash
cd server
npm test -- --run tests/coreAiAgentAdminClient.test.ts
npm run typecheck
cd ..
git diff --check
```

Results: focused Task 10A 1 file / 38 tests passed; server typecheck exited 0; diff check exited 0.

### External boundary and residual status

- This implementation round made no UAT/network request, used or persisted no credential, and changed no Task 10B/11 file, Agent manifest, GBP runtime, Core AI/FBR repository, binding, or merchant state.
- The exact DRAFT reported by the external diagnostic remains a create-only collision. This reconciler intentionally cannot reuse, publish, update, or delete it; UAT cleanup or a new versioned manifest decision remains explicit and outside this change.
- Roster proof is bounded by the authenticated Core API principal's visible complete result set. Server-side RBAC completeness and deployment behavior still require authorized operational validation.
- Published GET plus repeated discovery proves editable configuration/status and visible ownership classification only, not runtime snapshot equivalence.

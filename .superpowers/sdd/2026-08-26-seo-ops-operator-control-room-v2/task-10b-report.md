# Task 10B report — image-enabled GBP Post v2

## Outcome

Task 10B is implemented locally on `codex/operator-control-room-v2-impl` in implementation commit `1ea11b8b3814e2a79b42b72dcf2ee6d494f38b49`.

This work replaces the unshipped local GBP Post Content v1 desired state with `[SEO Ops] GBP Post Content v2`, makes the SEO Ops server authoritative for accepting exactly one bounded PNG/JPEG Core attachment, binds body + normalized CTA + canonical image reference into the draft hash, creates a new Task revision at finalization, and exposes only an authenticated local image preview before approval.

No Core AI UAT request, Agent creation/binding/publication, real image generation, credential use, network call, Task execution, or GBP write occurred.

## Scope delivered

- Replaced `server/core-ai-agents/seo-ops-gbp-post-content-v1.json` with `server/core-ai-agents/seo-ops-gbp-post-content-v2.json`.
  - Exact tool group: `builtin:builtin-media-generation`.
  - Prompt permits only `generate_image` exactly once with `n=1` and prohibits video/media editing/other tools.
  - Strict `seo_ops.gbp_post_draft.v2` response schema with CTA and one-image media brief.
- Added strict pre-download output validation:
  - exact request echoes;
  - CTA enum and cross-field URL policy;
  - exact supplied HTTPS URL requirement for link CTA types;
  - no phone number in copy.
- Added GBP-only attachment acceptance:
  - exactly one Core artifact;
  - declared `image/png` or `image/jpeg`;
  - existing same-origin/no-redirect client plus explicit 10 MiB byte limit;
  - PNG/JPEG signature verification and SHA-256;
  - deterministic local `ATTACHMENT` deliverable with no persisted/rendered Core remote URL;
  - exact failure taxonomy and zero draft on failure.
- Preserved generic non-GBP tolerant multi-artifact behavior and proved it still calls downloads without the GBP byte-limit option.
- Persisted one canonicalized `seo_ops.media_ref.v1` string in `content_draft.media`; the draft hash binds body, CTA type, CTA URL, deliverable ID, and image SHA.
- Changed draft finalization from evidence-only mutation to a locked new Task revision:
  - selected draft reloaded inside the Task transaction;
  - `execution_spec.content_draft === specBlockForDraft(draft)`;
  - new verified `CONTENT_DRAFT` evidence belongs to the new revision;
  - prior approval cannot authorize the changed execution-spec hash;
  - same idempotency key replays one revision.
- Added server-derived `media_previews` containing only `deliverable_id`, `sha256`, local authenticated `download_path`, and `alt_text`.
  - malformed/raw/external references are hidden;
  - cross-Task/cross-Run references are hidden and cannot be finalized;
  - preview resolution verifies Task, merchant, location, Run, deliverable, MIME, local bytes, and SHA ownership.
- Added the image, CTA, reserved square layout, lazy loading state, and error fallback to the Task decision hero before approval.
- No migration was needed; existing draft CTA/media and `agent_run_id` columns represent the invariant.

## TDD evidence

### RED

1. Manifest replacement first failed because v2 did not exist and v1 was still in the roster:

```text
cd server && npm test -- --run tests/coreAiAgentManifests.test.ts
Test Files  1 failed (1)
Tests       8 failed | 4 passed (12)
Key failure: expected seo-ops-gbp-post-content-v2.json, received v1; ENOENT for v2.
```

2. Runtime v2 tests first failed against the v1 parser/poller:

```text
cd server && npm test -- --run tests/gbpPostContentAgent.test.ts
Test Files  1 failed (1)
Tests       5 failed | 23 passed (28)
Key failures: parser expected seo_ops.gbp_post_draft.v1; no image-bound draft was created; valid v2 Runs ended FAILED.
```

The expanded failure matrix then observed the missing behaviors directly: attachment-specific errors were absent, invalid CTA still made one download call, and invalid bytes collapsed to `OUTPUT_INVALID`.

3. Immutable finalization first failed because the evidence-only path kept revision 1:

```text
cd server && npm test -- --run tests/gbpPostContentAgent.test.ts -t "replays the same HTTP key and body after Gate 1"
Tests 1 failed | 34 skipped
Key failure: expected task_revision 2, received 1.
```

4. Authenticated preview first failed because no image was rendered:

```text
npm test -- --run src/App.test.tsx -t "authenticated local GBP image|raw or malformed"
Tests 1 failed | 1 passed | 34 skipped
Key failure: unable to find role=img with name "Confirmed lunch plate".
```

5. Loading fallback first failed because the reserved preview had no status:

```text
npm test -- --run src/App.test.tsx -t "authenticated local GBP image"
Tests 1 failed | 35 skipped
Key failure: unable to find role=status.
```

6. Failed GBP Runs initially entered the generic artifact path:

```text
cd server && npm test -- --run tests/gbpPostContentAgent.test.ts -t "failed GBP content Run"
Tests 1 failed | 40 skipped
Key failure: expected zero downloads, received one.
```

### GREEN

```text
cd server && npm test -- --run tests/coreAiAgentManifests.test.ts tests/gbpPostContentAgent.test.ts tests/agentRunPoller.test.ts
Test Files  3 passed (3)
Tests       63 passed (63)

cd server && npm test -- --maxWorkers=4
Test Files  31 passed (31)
Tests       358 passed (358)

npm test -- --run
Test Files  24 passed (24)
Tests       149 passed (149)

cd server && npm run typecheck
exit 0

cd server && npm run build
exit 0

npm run build
exit 0; Vite production build completed

git diff --check
exit 0
```

The unconstrained full backend runner was also exercised. Two runs each hit one different pre-existing 5-second test timeout under high parallel database load; each timed-out test passed immediately alone. The complete suite was then rerun with `--maxWorkers=4` and passed 358/358. This is recorded as a negative result rather than hidden.

## Deterministic hashes

```text
implementation commit
1ea11b8b3814e2a79b42b72dcf2ee6d494f38b49

SHA-256 server/core-ai-agents/seo-ops-gbp-post-content-v2.json
a5bae85de0705493653084d2456f83a33fd0825ddc221e52b0c51e5f1a575824

SHA-256 server/src/services/gbpPostContentService.ts
540b10684be560564d26c9a867354eec144d60e8d39af27096e51d2a63bde508

SHA-256 server/src/services/contentService.ts
9238cecf823c52f2a6ece34db64e2962c3d823f4a3e7643a3ddd3339d6e8dd8d

SHA-256 src/features/tasks/TaskDecisionHero.tsx
78db5eff5e0564ac5525666733181cb2364b1052a82242109cbb13a5db34cf3b
```

## Local operator runbook / stop rules

1. Reconcile or bind v2 only in the later explicitly authorized UAT gate. This implementation task does not authorize any remote action.
2. Trigger content only for an exact authorized `AUTO_WRITE` `GBP_POST` Task while it is pre-Gate.
3. Treat Core `COMPLETED` as transport state only. The SEO Ops Run is successful only after strict output validation, one bounded image download, signature/SHA validation, deterministic deliverable persistence, and draft persistence.
4. On `IMAGE_ATTACHMENT_*` or `OUTPUT_INVALID`, do not patch the failed Run or manually advance the Task. Retry only through the existing explicit prior-Run/reason lineage.
5. Before approval, verify the Task hero shows the local authenticated image, body, and CTA. Absence/error of the image is a stop condition.
6. Finalize the selected draft. Confirm readback shows a new `task_revision`, the exact embedded `execution_spec.content_draft`, new verified `CONTENT_DRAFT` evidence, and a changed `execution_spec_hash`.
7. Never use a Core URL, local filesystem path, or raw `media[]` string as an image source. Only `media_previews[].download_path` is renderable.
8. Task 11 must independently validate live provider CTA mapping and execution/readback. Unsupported CTA mapping disables execution; it never rewrites the approved draft.

## Residual risks and deferred proof

- No UAT Agent inventory/create/publish/bind/readback was performed; the exact live visibility and published behavior of `builtin:builtin-media-generation` remain Task 11 acceptance work.
- No real model/image-provider response was generated. If Core returns only a URL, zero/multiple artifacts, an unsupported MIME, oversized bytes, or a MIME/signature mismatch, SEO Ops intentionally fails closed.
- The 10 MiB image ceiling is an internal safety policy. A later evidence-backed provider contract may justify changing it, which must receive new boundary tests.
- Automated component/API tests cover layout reservation, loading/error fallback, URL exclusion, and access-controlled download. Full browser pixel/playback-style human acceptance remains outside this no-UAT implementation task.
- CTA-to-live-provider mapping is deliberately not claimed here and remains a hard Task 11 execution gate.

## Fix Round 1 — review findings closed (2026-08-27)

Implementation commit: `dc64351a4370b24aac4d996bd53ede82eab139b8`

### Scope and invariants

- Keyed the entire Task route subtree by `taskId` and wrapped every Task-owned resource result with its request Task ID. A delayed or rejected cross-merchant navigation cannot render the previous Task title, body, CTA, image, artifacts, drafts, events, or audit references for even one retained route paint.
- The approval hero now resolves the exact `execution_spec.content_draft` snapshot and checks version, draft SHA, body, CTA type, CTA URL, and media array. A newer draft is rendered separately as `CANDIDATE / NOT FINALIZED`; both compact and detail approval controls fail closed when no exact snapshot-backed draft is displayed.
- One authoritative GBP validator now governs model-output copy/CTA policy, human GBP revisions, and GBP finalization. Human revisions require exactly one byte-verified, server-issued canonical `seo_ops.media_ref.v1` already owned by a GBP content Run for the same Task/merchant/location. Raw URLs/paths, missing/multiple media, rewritten references, cross-Task media, invalid CTA/URL, phone copy, missing bytes, changed bytes, bad signatures, size drift, and SHA drift are rejected without a draft revision.
- Each stored GBP input message now contains immutable `dispatch_identity.expected_agent_id`. Terminal acceptance checks both `core.id === stored core_run_id` and `core.agent_id === stored expected_agent_id` before output parsing, download, deliverable persistence, or draft persistence. Missing or mismatched identity produces `CORE_RUN_IDENTITY_MISMATCH` and zero new artifact/draft.
- Generic non-GBP draft revision behavior remains unchanged. No Task 11A schema, migration, or repository file was modified.

### RED evidence

Frontend command:

```text
npm test -- --run src/App.test.tsx -t "task navigation clears|task navigation error|GBP approval"
Test Files  1 failed (1)
Tests       3 failed | 1 passed | 36 skipped
```

The RED DOM retained the old Task subtree during delayed navigation and selected the newest candidate v2 as `当前稿件 v2`; the exact finalized-v1 heading and approval-blocked state were absent. The first delayed-navigation assertion also exposed an ambiguous generic status selector; it was narrowed to the explicit loading text before the GREEN proof.

Backend command:

```text
cd server && npm test -- gbpPostContentAgent.test.ts -t "Core run id differs|Core agent id differs|stored dispatched agent identity|unsafe GBP human revisions|cross-Task media in a GBP human revision|local image bytes"
Test Files  1 failed (1)
Tests       5 failed | 1 passed | 41 skipped
```

Behavioral RED failures showed image-less human revision returning `201`, cross-Task media revision returning `201`, and finalization after local byte tampering returning `201`. The first identity-table fixture reused a non-unique setup suffix and failed before its intended assertion; the fixture was corrected to unique explicit suffixes, then the stored-identity and zero-persistence checks were proven in GREEN. This test-fixture failure is recorded rather than presented as product evidence.

### GREEN evidence

```text
npm test -- --run src/App.test.tsx
Test Files  1 passed (1)
Tests       40 passed (40)

cd server && npm test -- gbpPostContentAgent.test.ts
Test Files  1 passed (1)
Tests       48 passed (48)

cd server && npm run typecheck
exit 0

cd server && npm run build
exit 0

npm run build
exit 0; TypeScript project build and Vite production build completed

git diff --check
exit 0
```

Per the speed constraint, verification was limited to the affected Task 10B frontend/backend files plus required builds; no broad repository test suite or UAT was run.

### Fix-round deterministic hashes

```text
SHA-256 server/src/services/contentService.ts
61562635966a434e76efef494d92976ed8ad1b9ababf8309283352daa82dfaec

SHA-256 server/src/services/gbpPostContentService.ts
b16cdf0ad58da21fb25220351adbefa260a848fe3fe0e4931b8aa7cf4afd6e6a

SHA-256 src/features/tasks/TaskDecisionHero.tsx
127ba1f938c8b4efef01ca77a02e9fafac99095f6793eab14e569aafb9f8ad0f

SHA-256 src/features/tasks/TaskPage.tsx
f2ddb03212ea6735eb49ff7dd9c9cb2f258a067afab8d635717e9716e710899f

SHA-256 src/App.test.tsx
3958a9ea2021da9369ad8c9f089afbab8a47b481d2b0b1699721d4636fa6e685

SHA-256 server/tests/gbpPostContentAgent.test.ts
6925a01d2c14d1514e49beb40a6234dea45dc1eeb35eca16877b021e6238deb7
```

### Residual risks

- No UAT, network, credentials, Core Agent mutation, FBR access, or GBP external write was performed. Live Core/provider identity and attachment behavior remain unproven here.
- Frontend proof is component-level under jsdom. It proves route-key and request-key isolation plus exact identity selection, but not browser pixel acceptance.
- Local image integrity is reread at human revision/finalization. Later filesystem corruption remains a preview/download stop condition; approval operators must still treat an unavailable image as a hard stop.

## Fix Round 2 — source Run and preview readiness (2026-08-27)

Implementation commit: `5861796fe35edfdc9ecb7e0f79c46fa82543687b`

### Closed invariant

- Added nullable `media_source_agent_run_id` for human revisions. The existing unique `agent_run_id` remains unchanged and continues to identify the single `AGENT_GENERATED` draft owned by a Run.
- The authoritative GBP media validator returns the verified deliverable's source Run ID. A legal human revision stores that ID separately, while keeping `agent_run_id = null`.
- Draft preview projection selects generated `agent_run_id` or human `media_source_agent_run_id` according to draft source, then revalidates deliverable-to-Run, Task, merchant, location, MIME, and SHA ownership before returning a local authenticated URL.
- Approval eligibility now requires one exact finalized draft, one canonical media reference, one matching authenticated preview with the same deliverable/SHA, the exact local download path, and a successful image `load` event. Missing, multiple, mismatched, loading, or `error` preview states block approval. Task route remounting resets image readiness.
- The migration is narrowly adjacent to the pre-existing Task 10B draft columns/index. No Task 11A GBP command, receipt, readback, execution repository, or domain contract was changed.

### RED

```text
cd server && npm test -- gbpPostContentAgent.test.ts -t "unsafe GBP human revisions"
Test Files  1 failed (1)
Tests       1 failed | 47 skipped
Key failure: legal HUMAN_EDIT draft returned agent_run_id=null and media_previews=[] instead of a persisted source Run and one preview.

npm test -- --run src/App.test.tsx -t "GBP approval displays|no authenticated preview|fails to load"
Test Files  1 failed (1)
Tests       3 failed | 39 skipped
Key failures: approval was available before image load, missing-preview blocker was absent, and onError did not remove approval eligibility.
```

### GREEN

```text
npm test -- --run src/App.test.tsx -t "GBP approval displays|no authenticated preview|mismatches the canonical|fails to load|readiness resets"
Test Files  1 passed (1)
Tests       5 passed | 39 skipped

cd server && npm test -- gbpPostContentAgent.test.ts -t "unsafe GBP human revisions"
Test Files  1 passed (1)
Tests       1 passed | 47 skipped

cd server && npm test -- migrate.test.ts -t "adds agent_run_id"
Test Files  1 passed (1)
Tests       1 passed | 14 skipped

cd server && npm run typecheck && npm run build
exit 0

npm run build
exit 0; TypeScript project build and Vite production build completed

git diff --check
exit 0
```

Verification stayed focused per the speed constraint; no broad suite was run.

### Fix-round hashes

```text
server/src/services/contentService.ts  a36aae40ebd976b4ec8484b15be9772b04b97437e2a86173b819d864cdb5e0f6
server/src/repos/draftRepo.ts           b15fafb0a3ed7cfdf1dfdd1c441720c7affe9ded66ff249fdd6152270edce438
src/features/tasks/TaskDecisionHero.tsx a3889710d6b3596d35d08815950887233cb4376aed58b6178effddc9eecd401a
src/features/tasks/TaskPage.tsx         d81096d64fb5663f15c6cf934ca18ed6ddc90a5bafde5fb23f81e3e930cf267b
src/App.test.tsx                         964426ed18716aa71ea128d37c7f2225e525cc51a119181e57ea1e4c4b164adf
server/tests/gbpPostContentAgent.test.ts 4878fe97bf84739144f00b5384040ed1d03cd2203d08d97b91bb50905ed710e1
server/src/db/migrate.ts                 ae7b5de795e0ddb956aa82fc5e30d70d357eba38e0ae140d1fe8ff0b75bf3855
```

### Residual risks

- No live browser image decode, UAT, network, credentials, Core/FBR action, or GBP write was performed. jsdom `load`/`error` tests prove the state gate, not live browser/provider behavior.
- Existing historical human drafts are not guessed or backfilled from mutable bindings. Those without a durable verified media source remain safely without previews and therefore cannot be approved until explicitly revised from a server-resolved source.

## UAT recovery desired-state bump (2026-08-27)

Implementation commit: `a3e6b0c`

- Replaced the desired-state file `server/core-ai-agents/seo-ops-gbp-post-content-v2.json` with `server/core-ai-agents/seo-ops-gbp-post-content-v3.json` and changed only the Agent name to `[SEO Ops] GBP Post Content v3` because the UAT v2 coordinate is an orphan DRAFT from a failed safe apply.
- A structural comparison against the committed v2 manifest confirmed every field except `name` is identical. The response contract remains `seo_ops.gbp_post_draft.v2`; prompt, tool, model, limits, and runtime fields are unchanged.

```text
RED: cd server && npm test -- coreAiAgentManifests.test.ts
     1 file failed; 8 failed, 4 passed; v3 file missing while v2 remained.
GREEN: cd server && npm test -- coreAiAgentManifests.test.ts
       1 file passed; 12 passed.
TYPECHECK: cd server && npm run typecheck
           exit 0.
DIFF: git diff --cached --check
      exit 0.
SHA-256 server/core-ai-agents/seo-ops-gbp-post-content-v3.json
dcdd8f7f83abb9992c7a510e6e61e20aa90ccdf5acc3667836ee09579f7f80e2
```

No UAT, network, credentials, Core/FBR mutation, Agent creation/publish, or GBP write was performed. The orphan remote v2 DRAFT remains an authenticated UAT reconciliation concern; this change only establishes the local v3 desired state.

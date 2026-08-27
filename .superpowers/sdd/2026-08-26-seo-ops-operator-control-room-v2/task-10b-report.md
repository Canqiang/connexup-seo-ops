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

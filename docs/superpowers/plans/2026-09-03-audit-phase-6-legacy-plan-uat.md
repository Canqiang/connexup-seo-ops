# Audit Phase 6 Legacy Migration Plan Handoff and UAT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring verifiable historical Audit data into the new immutable history without fabricating scores or execution, enable explicit Criterion-to-Plan draft delivery only after a real draft-first idempotency/readback contract is proven, and produce end-to-end release evidence.

**Architecture:** A deterministic two-pass migration freezes source identities/hashes, validates exact historical location binding and report time, precomputes stable Version order/bases, and publishes each Subject batch atomically while quarantining ambiguous sources. Plan handoff stores the operator's immutable selection and an outbox delivery locally before any network call; an asynchronous adapter creates or finds one draft by a deterministic key and links it only after content readback. Final UAT validates manual/scheduled Audit, exports, migration, and absence of automatic Tasks from persisted state through browser state.

**Tech Stack:** FastAPI, Pydantic v2, Python `sqlite3`, pytest, existing React workspace, actual UAT Plan/Core AI contracts.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Complete Phases 1–5 and preserve all original `audit_snapshots`, `merchant_seo_artifacts`, generic Runs, and Tasks.
- Migration is append-only and idempotent. Never update legacy source payloads, accepted Versions, Criterion rows, comparison bases, or original tables to make migration pass.
- A current single-location merchant is not proof of a historical location. Bind only from immutable historical request/input/Run/Artifact identity evidence.
- `ingested_at` and migration execution time can never substitute for an unknown `report_at`.
- Never infer score, Grade, Rubric, Criterion ID, applicability, Evidence, scope, Run, or Attempt from Markdown/free text.
- Plan creation is explicit operator action. Automatic Audit, migration, report viewing, comparison, and export cannot create a Plan or Task.
- Do not connect Audit to `/runs/:id/approve-plan` or any path that pre-creates locked Tasks. Capability remains disabled unless draft-first create/readback/idempotency is proven in UAT.
- Treat UAT evidence as redacted protocol evidence; do not store tokens, cookies, full payloads, signed URLs, or customer-sensitive content in Git.

---

## Task 1: Add legacy source registry and deterministic frozen batches

**Files:**

- Create: `api/migrations/0004_audit_legacy.sql`
- Create: `api/app/audit_legacy.py`
- Create: `api/tests/test_audit_legacy.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class FrozenLegacySource:
    source_kind: Literal["audit_snapshot_v1", "seo_audit_artifact"]
    source_id: str
    source_sha256: str
    raw_bytes: bytes

def freeze_legacy_batch(conn: sqlite3.Connection) -> FrozenLegacyBatch: ...
def analyze_legacy_batch(conn: sqlite3.Connection,
                         batch: FrozenLegacyBatch) -> LegacyMigrationPlan: ...
def apply_legacy_subject_batch(conn: sqlite3.Connection, *,
                               batch_id: str, subject_id: str,
                               candidates: tuple[LegacyCandidate, ...]) -> LegacyMigrationResult: ...
```

`0004_audit_legacy.sql` adds immutable batch/entry records if they are not already represented by core tables: `audit_legacy_batches(id, manifest_json, manifest_sha256, status, created_at, completed_at)` and `audit_legacy_batch_entries(batch_id, source_kind, source_id, source_sha256, ordinal, outcome, reason_code, audit_version_id)`. Unique source identities and existing `audit_legacy_sources` remain the canonical replay/conflict guard.

- [ ] Add fixtures containing valid v1, malformed v1, exact-bound v1, ambiguous v1, canonical-ready Artifact, unknown Artifact schema, unscored known Artifact, source ID/hash conflict, equal report times, missing report time, and shuffled enumeration orders.
- [ ] Freeze the full sorted `(source_kind, source_id, source_sha256)` manifest before validation. Derive batch ID and stable candidate Version IDs from namespace+source identity/hash, not enumeration or insertion time.
- [ ] Scan all `audit_snapshots` and all ready `AUDIT_REPORT` rows in `merchant_seo_artifacts`; do not filter by selected keyword cycle or current head.
- [ ] Record accepted/unbound/rejected with stable reason codes. A repeated source/hash is a no-op; a repeated source ID with different hash is rejected as `AUDIT_LEGACY_SOURCE_CONFLICT` and never overwrites the first record.
- [ ] Resolve exact historical Subject/generation only from immutable evidence. Missing or ambiguous identity/report time remains unbound and cannot update a head.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_audit_legacy.py -k 'freeze or source or binding' -q
```

- [ ] Commit as `feat: inventory legacy audit sources` when green.

## Task 2: Publish legacy Versions without fabricated v2 data

**Files:**

- Modify: `api/app/audit_legacy.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/tests/test_audit_legacy.py`

- [ ] Add tests proving `legacy_v1` and unadapted `legacy_artifact` have null Run/Attempt/Rubric/scoring/score/Grade/comparison/provenance fields, no Criterion rows, exact known legacy envelope payload, JCS payload hash, mandatory raw source hash, and restricted capabilities.
- [ ] Add explicit source adapters keyed by exact schema/version. A fully adapted Artifact may produce canonical v2 only if exact Subject/generation, stable Criterion IDs, known immutable Rubric hash, valid Evidence handles/assets, scoring, and producer provenance all validate. Unknown keys/shapes are rejected rather than guessed.
- [ ] Precompute each canonical candidate's comparison base using the migration-before Versions plus compatible earlier candidates in deterministic `(report_at, score tier, provenance tier, stable Version ID)` order. Never rewrite a base after insert.
- [ ] For each Subject/generation batch, use one transaction to insert sources, Versions, optional Criteria/Asset links, precomputed bases, and deterministic head CAS. Roll back that Subject batch on any inconsistency.
- [ ] Ensure `report_at` comes from immutable source records and `ingested_at`/`accepted_at` record only migration. Equal times resolve by score tier, provenance tier, and stable Version ID.
- [ ] Run the same frozen fixtures in two shuffled orders against fresh databases and compare byte-for-byte manifests plus Version IDs, version numbers, payload hashes, comparison bases, head pointers, and outcome counts.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_legacy.py -q
```

- [ ] Commit as `feat: migrate immutable legacy audit versions` when green.

## Task 3: Expose legacy inventory and guarded binding

**Files:**

- Modify: `api/app/audit_versions.py`
- Modify: `api/app/audit_legacy.py`
- Modify: `api/tests/test_audit_versions.py`
- Modify: `api/tests/test_audit_legacy.py`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`

**Endpoints:**

- `GET /api/audit-legacy-sources?binding_status=unbound&cursor=&limit=`
- `POST /api/audit-legacy-sources/{source_kind}/{source_id}/bind`

Bind body:

```json
{"subject_id":"...","source_sha256":"...","request_id":"<uuid>"}
```

- [ ] Add API tests for safe unbound summaries, cursor stability, exact hash replay, hash conflict, cross-merchant subject, operator-selected but unsupported identity, accepted binding, repeat binding, and head ordering by report time rather than bind time.
- [ ] Re-run the same adapter and exact historical evidence validation during bind. Operator selection narrows the candidate Subject but cannot override contradictory/missing identity evidence.
- [ ] Return a typed restricted Version on success or a stable reason without mutating the source on failure. Never construct a local Run/Attempt to represent migration.
- [ ] Add a small “待绑定旧报告” operator panel in the workspace context area. Show source kind, trustworthy report time if known, hash abbreviation, and reason; do not display raw payload by default.
- [ ] Run focused backend/frontend tests and commit as `feat: review unbound legacy audits` when green.

## Task 4: Verify the draft-first Plan service contract

**Files:**

- Modify: `api/app/config.py`
- Create: `api/app/plan_delivery_client.py`
- Modify: `api/.env.example`
- Create: `api/tests/test_plan_delivery_client.py`
- Create: `docs/evidence/audit-plan-uat-protocol-2026-09-03.md`

**Required protocol semantics:**

```python
class PlanDeliveryClient(Protocol):
    def create_draft(self, *, idempotency_key: str,
                     audit_version_sha256: str,
                     selection_sha256: str,
                     criteria: list[dict[str, object]]) -> PlanDraftAck: ...
    def find_draft(self, *, idempotency_key: str) -> PlanDraftLookup: ...
    def read_draft(self, *, plan_id: str) -> PlanDraftReadback: ...
```

- [ ] Inspect the actual UAT Plan API through the restored network route. Verify that create is draft-only, accepts a stable idempotency key, readback can find by that key after acknowledgement loss, and returned draft carries immutable Audit Version+selection references. Confirm no Task rows are materialized at create.
- [ ] Record exact redacted endpoints/fields/statuses and one acknowledgement-loss/readback result in the evidence file. Store no credentials or business payload.
- [ ] Add MockTransport/adapter tests matching the observed protocol, including same-key replay, same-key/different-payload conflict, unique lookup, ambiguous lookup, missing draft, content readback, and service unavailable.
- [ ] Add `AUDIT_PLAN_DELIVERY_ENABLED=false` by default plus actual base URL/auth settings. The capability can become enabled only when configuration is true and the protocol probe/readback contract passes startup validation.
- [ ] If UAT lacks any required semantic, keep `plan_draft.enabled=false` with `AUDIT_PLAN_SERVICE_UNVERIFIED`, commit only the safe disabled adapter/tests/evidence, and do not implement a workaround through existing Task APIs.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_plan_delivery_client.py tests/test_config.py -q
```

- [ ] Commit as `feat: verify audit plan delivery boundary` when green.

## Task 5: Persist immutable Criterion selections and Plan outbox delivery

**Files:**

- Create: `api/migrations/0005_audit_plan_delivery.sql`
- Create: `api/app/audit_plan_delivery.py`
- Modify: `api/app/audit_versions.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_plan_delivery.py`

**Tables:**

- `audit_plan_selections` with Version, sorted unique Criterion IDs JSON/hash, request ID/request hash, deterministic Plan idempotency key, operator/time, unique `(audit_version_id,request_id)` and unique key.
- `audit_plan_deliveries` with one-to-one Selection, queued/dispatching/unknown/linked/failed projection, current Attempt, safe error, timestamps.
- `audit_plan_delivery_attempts` with immutable attempt number/retry parent/request ID, lease generation/expiry, status/error/times.
- `audit_plan_delivery_events` append-only safe state events.
- `audit_plan_links` with one-to-one Selection and one-to-one Plan ID/revision plus readback SHA-256; immutable after insert.

**Endpoints:**

- `POST /api/audit-versions/{version_id}/plan-drafts`
- `GET /api/audit-plan-selections/{selection_id}`
- `POST /api/audit-plan-selections/{selection_id}/reconcile`

- [ ] Add tests for explicit auth/operator action, sorted/deduplicated Criterion selection, missing/foreign/legacy Criterion, request replay, same request/different selection conflict, atomic Selection+delivery creation, disabled capability, one active Attempt, timeout→unknown, orphan readback, mismatched Plan content, unique link, and no Task row before/after draft creation.
- [ ] Return `poll_after_ms=2000` only while delivery is queued/dispatching and `null` for unknown/linked/failed. Reconciliation is always explicit after unknown.
- [ ] Build selection content only from the accepted Version's frozen Criterion observations, Evidence summaries, recommendations, Version hash, and selection hash. Reject client-supplied report text/action text.
- [ ] Derive `plan_idempotency_key` from namespace, Version ID, request ID, and selection hash. Commit Selection and queued delivery together before any remote call.
- [ ] Worker claims/fences an Attempt, writes a dispatch barrier, calls create outside the transaction, and links only after `find_draft`/`read_draft` returns exactly one draft whose Audit Version hash, Criterion IDs, and selection hash match.
- [ ] Timeout/ambiguous acknowledgement becomes unknown and reuses the same key for reconciliation. It never creates a second Plan under a new key.
- [ ] Register worker only when the verified capability is enabled; otherwise endpoints return the stable disabled reason and write nothing.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_plan_delivery.py tests/test_plan_delivery_client.py -q
```

- [ ] Commit as `feat: deliver audit selections to plan drafts` only if the UAT gate passed. If it did not pass, keep the disabled capability and do not add enabled outbox routing.

## Task 6: Enable the Plan UI only from server capability

**Files:**

- Modify: `web/src/components/audit/AuditContextContent.tsx`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`

- [ ] Add tests for disabled reason, explicit Criterion selection, select-all-visible semantics, selection count, confirmation summary, one request ID, queued/unknown/linked/failed delivery, reconciliation, and linked Plan navigation.
- [ ] Keep checkboxes/action hidden for unscored legacy and unstable Criterion identities. For canonical Versions, show them only when the server returns the capability; do not infer availability.
- [ ] Require at least one selected Criterion and show exactly which immutable Version will feed the draft. “生成计划草案” must remain distinct from “批准计划” or “创建任务”.
- [ ] After submission, poll only while the server supplies a non-null cadence. Unknown stops and offers reconciliation. Linked state navigates to the Plan domain; it must not show Tasks as created.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/web
npm test -- src/pages/AuditWorkspace.test.tsx
npm test
npm run lint
npm run build
```

- [ ] Commit as `feat: generate plan drafts from audit selection` only when the backend capability is proven and enabled.

## Task 7: Run migration rehearsal and complete release/UAT readback

**Files:**

- Create: `api/scripts/migrate_audit_legacy.py`
- Create: `api/scripts/verify_audit_release.py`
- Create: `docs/evidence/audit-release-uat-2026-09-03.md`
- Modify: `api/app/audit_observability.py`
- Modify: `api/tests/test_audit_observability.py`
- Modify: `README.md`

- [ ] Make `migrate_audit_legacy.py --db <copied-db> --manifest-out <path> --dry-run` freeze and print accepted/unbound/rejected counts without writes; `--apply --expected-manifest-sha256 <hash>` applies only that exact batch. Refuse the live database path unless `--apply` and exact expected hash are both present.
- [ ] Copy a UAT database snapshot to a temporary path, run dry-run, apply, run again, and prove the second pass is a no-op. Repeat from another copy with shuffled source enumeration and compare exact Version IDs/order/bases/heads/hashes.
- [ ] Emit safe legacy batch accepted/unbound/rejected/conflict counts and Plan delivery queued/unknown/linked/failed/reconciliation counts; verify telemetry contains only stable IDs, counts, timings, and reason codes.
- [ ] Run all backend/frontend tests, lint, and build. Run `git diff --check` and inspect the full branch diff from `main`.
- [ ] With the user's restored UAT route, create one manual Audit and one controlled due scheduled Audit. Read back local Run/Attempt/events, Core AI Run, Agent/Skill provenance, terminal status, canonical Version, hash/scoring, current head, policy cursor, alert, and absence of automatically created Plan/Task.
- [ ] Exercise explicit failure, validation failure, timeout/unknown, reconciliation, and explicit retry without duplicate trigger or Version.
- [ ] Export one accepted Version to JSON/HTML/PDF and verify MIME, size, hash, content parsing, PDF pages, template/renderer identity, identical replay, and absence of SAS/token data.
- [ ] Verify legacy UI states and unbound inventory. If Plan UAT gate passed, simulate lost acknowledgement, reconcile the same key, verify one draft link, and confirm no Task until a separate Plan approval.
- [ ] Use `verify_audit_release.py` to query and emit a redacted JSON evidence summary. The script exits nonzero unless every persisted relation/hash/count and no-auto-Task assertion passes.
- [ ] Record command, environment identity, safe IDs/hash abbreviations, expected/actual result, and browser screenshots in `docs/evidence/audit-release-uat-2026-09-03.md`.
- [ ] Run final commands:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest -q
cd ../web
npm test
npm run lint
npm run build
cd ..
git status --short
git diff main...HEAD --check
git log --oneline --decorate -15
```

- [ ] Commit verified release scripts/evidence as `test: verify audit workspace end to end`. Do not merge or switch the demo checkout; report the branch and exact evidence to the user.

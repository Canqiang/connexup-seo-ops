# Audit Phase 1 Stable Identity and Immutable Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish stable location identity, strict Audit v2 contracts, frozen rubric/scoring, and immutable version persistence before any new remote Audit dispatch is allowed.

**Architecture:** Build on the Performance History foundation: reuse its ordered `api/app/migrations.py` runner, integer-keyed `merchant_locations`, versioned alias/status events, and `source_scopes`/`source_scope_bindings`. Reconcile each exact GBP location inside the existing GBP persistence transaction, then project active Audit Subjects from that shared registry. Validate producer output against a frozen evidence manifest and rubric, construct canonical v2 server-side, and accept Version/Criteria/head/policy/events atomically with immutable database guards and readback verification.

**Tech Stack:** FastAPI, Pydantic v2, Python `sqlite3`, `decimal.Decimal`, `rfc8785`, pytest.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Work only in the isolated `codex/audit-report-workspace` worktree named in the roadmap.
- Phase 1 has a hard dependency on the reviewed, full-suite-green Performance History foundation and its `0001_performance_history.sql`. If that foundation is absent, partially applied, or its postconditions fail, stop; do not create a parallel migration ledger or second location model.
- Reuse `schema_migrations(version, checksum, applied_at)` and allocate Audit schema changes only after `0001_performance_history.sql`. Never introduce a second `sha256` ledger column or another `merchant_locations`/alias/source-binding table.
- Do not change `audit_snapshots.py` or its v1 contract. Native v2 code lives in new modules.
- Existing `merchant_gbp_profiles` rows are replaceable snapshots; never reference their integer IDs from a stable Audit subject.
- Exact GBP location ID is the initial binding authority. Preserve Place ID observations as versioned aliases/evidence; do not merge identities by display name or address.
- All accepted JSON hashes use RFC 8785 JCS. All scoring uses Decimal/integer basis points and `ROUND_HALF_UP`; do not hash binary floating-point output.
- New immutable tables use `ON DELETE RESTRICT` and database triggers. Do not rely on Python conventions for immutability.
- Do not add dispatch, scheduler, UI, export, legacy migration, or Plan delivery behavior in this phase.

---

## Task 1: Adopt and harden the shared ordered migration runner

**Files:**

- Modify: `api/migrations/README.md`
- Modify: `api/app/migrations.py`
- Modify: `api/app/db.py`
- Modify: `api/tests/test_db.py`
- Modify: `api/tests/test_db_migrations.py`

**Interfaces:**

```python
MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "migrations"

def apply_migrations(conn: sqlite3.Connection,
                     migrations_dir: Path = MIGRATIONS_DIR) -> list[str]: ...
```

Reuse the Performance foundation's `schema_migrations(version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`. A file whose recorded checksum differs from its current bytes raises `RuntimeError("migration checksum mismatch: <version>")` before later migrations run.

- [ ] First run the Performance migration tests and assert `0001_performance_history.sql`, the `checksum` ledger, all postconditions, and both blank/legacy upgrades are present. Do not proceed by recreating these primitives in Audit code.
- [ ] Extend the existing tests with Audit-numbered temporary samples, filename ordering, no-op re-entry, checksum mismatch, and two connections that both end with one ledger row per migration and no partial schema.
- [ ] Run the focused tests and confirm the missing runner/schema failures:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_db.py -q
```

- [ ] Preserve the Performance runner's invariant registration and postcondition hooks. For each migration, acquire `BEGIN IMMEDIATE`, re-read the ledger under that lock, execute and data-migrate atomically, insert the version/checksum row, and commit; a concurrent caller must become a verified no-op rather than execute DDL twice.
- [ ] Keep the existing `init_db()` integration. Existing databases and fresh databases must converge on the same schema before any Audit table is added.
- [ ] Document that an applied numbered migration is immutable and that Audit starts at `0002`. Every later schema change receives a new higher-numbered file.
- [ ] Run the focused tests, `git diff --check`, and inspect only the migration-runner diff. Commit as `feat: add ordered schema migrations` when green.

## Task 2: Reuse the shared stable Location Registry for Audit

**Files:**

- Create: `api/app/location_registry.py`
- Modify: `api/app/merchant_profiles.py`
- Modify: `api/app/merchants.py`
- Create: `api/tests/test_location_registry.py`
- Modify: `api/tests/test_merchant_profiles.py`
- Modify: `api/tests/test_merchants.py`

**Existing shared tables and keys (do not recreate):**

- `merchant_locations(id INTEGER PRIMARY KEY, merchant_id INTEGER NOT NULL, ..., UNIQUE(merchant_id,id))` is the stable internal location identity.
- `merchant_location_aliases` owns versioned exact `GOOGLE_PLACE_ID` aliases and evidence; Audit never infers identity from display name/address.
- `merchant_location_status_events` owns immutable lifecycle/`needs_attention` generations and reason metadata.
- `source_scopes` owns canonical `GBP_LOCATION` scope identity; `source_scope_bindings` owns versioned exact binding generations back to `(merchant_id, merchant_location_id)`.
- Ambiguous/conflicting reconciliation appends a `needs_attention` status event with a bounded reason code and evidence hash; it does not introduce a parallel quality-issue identity table.

**Interfaces:**

```python
@dataclass(frozen=True)
class ResolvedMerchantLocation:
    merchant_location_id: int
    merchant_id: int
    binding_generation: int
    alias_generation: int | None
    status_generation: int
    identity_manifest: dict[str, object]
    identity_manifest_sha256: str

def reconcile_gbp_locations(conn: sqlite3.Connection, *, merchant_id: int,
                            account_scope: str, snapshots: list[dict[str, object]],
                            actor: str, observed_at: str) -> list[ResolvedMerchantLocation]: ...

def resolve_current_location(conn: sqlite3.Connection, *, merchant_id: int,
                             source_kind: str, source_scope: str,
                             external_location_id: str) -> ResolvedMerchantLocation | None: ...

def set_merchant_locations_archived(conn: sqlite3.Connection, *, merchant_id: int,
                                    archived: bool, actor: str, reason: str,
                                    changed_at: str) -> None: ...
```

- [ ] Add failing tests for first exact GBP binding, unchanged repeat sync, title/address-only display update, Place ID observation change, GBP location binding replacement, multiple exact locations, and ambiguous/conflicting binding quarantine.
- [ ] Assert that an unchanged exact identity preserves `merchant_location_id` and the current binding/alias/status generation vector; a binding or Place observation change appends the corresponding shared event and increments only that component; a fuzzy title/address match never creates a binding.
- [ ] Mint the integer `merchant_location_id` once through the Performance registry on first exact binding and persist/reuse it forever. Subsequent exact binding rotation appends a `source_scope_bindings` generation and never creates or recomputes a second Audit-owned location ID.
- [ ] When a new exact GBP binding has no current binding row, attach it to an existing active location only if its non-empty Place ID exactly matches one unique current Place alias for the same merchant. If there is no exact Place match, create a new location from the new binding; if more than one match exists, quarantine the source. Never use title/address similarity for this decision.
- [ ] Implement canonical Audit Location manifest creation and JCS/SHA-256 verification over the shared registry: merchant ID, integer location ID, current GBP source-scope/binding generation, exact GBP location ID, current Place alias/evidence generation, and current status generation. Exclude website and display-only title changes. Website belongs to the Audit Subject projection in Task 6, not location identity.
- [ ] Call `reconcile_gbp_locations` from `_persist_gbp_snapshots()` after lease revalidation and before commit. The snapshot delete/reinsert, binding reconciliation, location lifecycle events, and Audit Subject projection added in Task 6 must share the same transaction.
- [ ] Extend merchant archive/restore to call `set_merchant_locations_archived` in its existing transaction. Do not delete registry history.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_location_registry.py tests/test_merchant_profiles.py tests/test_merchants.py -q
```

- [ ] Inspect the exact diff and commit as `feat: add stable merchant location registry` when green.

## Task 3: Define producer and canonical v2 contracts

**Files:**

- Create: `api/app/audit_contracts.py`
- Create: `api/tests/fixtures/audit_result_v2.json`
- Create: `api/tests/fixtures/audit_report_v2.json`
- Create: `api/tests/test_audit_contracts.py`

**Public constants and interfaces:**

```python
PRODUCER_SCHEMA_VERSION = "seo_ops.audit_result.v2"
CANONICAL_SCHEMA_VERSION = "seo_ops.audit_report.v2"
MAX_PRODUCER_BYTES = 2 * 1024 * 1024
MAX_CANONICAL_BYTES = 5 * 1024 * 1024

def extract_single_json_object(output_text: str, *, max_bytes: int) -> dict[str, object]: ...
def parse_producer_result(output_text: str) -> AuditProducerResultV2: ...
def parse_canonical_report(value: object) -> AuditReportV2: ...
```

Use strict Pydantic models with `ConfigDict(extra="forbid")`. Define the `FrozenAuditManifest` contract here so Phase 1 scoring/acceptance can be tested from fixtures; Phase 2 owns only the builder that populates it from local data. The producer model owns only subject echoes, title/summary/language, Criterion ID/applicability/score/observation/evidence handle+fact+locator/recommendation, limitations, and recommended actions. The canonical model additionally owns frozen subject, rubric, dimensions, scopes, normalized severity, source metadata, score status, Decimal text totals, Grade, and evidence coverage.

- [ ] Add happy-path tests for a bare JSON object and one strict fenced `json` block.
- [ ] Add failures for text around the object, two objects, unknown fields, wrong schema, subject mismatch-ready data, duplicate/missing/extra Criterion IDs, invalid applicability/score pairs, missing Evidence, invalid locator, disallowed URL scheme, and every collection/text/byte limit in the spec.
- [ ] Ensure `APPLICABLE` requires an integer score 0–4 and Evidence; `NOT_APPLICABLE` and `EVIDENCE_UNAVAILABLE` require null score and a non-empty explanation.
- [ ] Ensure no model field can carry an Authorization header, cookie, SAS query, source hash, observed time, scope key, total score, Grade, or Agent/Skill identity from producer output.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_contracts.py -q
```

- [ ] Commit as `feat: define strict audit v2 contracts` after focused tests and `git diff --check` pass.

## Task 4: Add immutable rubric, JCS hashing, and deterministic scoring

**Files:**

- Create: `api/app/audit_rubrics/2026.09.json`
- Create: `api/app/audit_data/public_suffix_list_2026-09-03.dat`
- Create: `api/app/audit_rubric.py`
- Create: `api/tests/fixtures/audit_scoring_cases.json`
- Create: `api/tests/test_audit_rubric.py`
- Modify: `api/requirements.txt`

**Interfaces:**

```python
def canonical_json_bytes(value: object) -> bytes: ...
def canonical_sha256(value: object) -> str: ...
def load_rubric(version: str = "2026.09") -> FrozenAuditRubric: ...
def validate_producer_against_manifest(*, producer: AuditProducerResultV2,
                                       manifest: FrozenAuditManifest,
                                       rubric: FrozenAuditRubric) -> None: ...
def build_canonical_report(*, producer: AuditProducerResultV2,
                           manifest: FrozenAuditManifest,
                           rubric: FrozenAuditRubric,
                           accepted_at: str) -> AuditReportV2: ...
```

- [ ] Pin `rfc8785==0.1.4` and `publicsuffix2==2.20191221` in `api/requirements.txt`, reinstall in the worktree venv, and add published JCS fixtures plus Unicode/key-order/Decimal-text hash fixtures.
- [ ] Vendor a dated Public Suffix List snapshot from `https://publicsuffix.org/list/public_suffix_list.dat`, retain its license/header, record its source SHA-256 in the rubric metadata, and construct `publicsuffix2.PublicSuffixList` from that local file handle only. Add IDN, multi-level suffix, localhost/IP, and malformed-host tests; reject a website scope when a registrable domain cannot be derived.
- [ ] Encode the first rubric as immutable JSON with stable dimension/category/Criterion IDs, integer max scores, integer basis-point weights summing according to the rubric, required sources/dimensions, freshness limits, coverage threshold, Grade thresholds, scope type, and rounding rules.
- [ ] Make the first rubric's only required connected source the persisted GBP/FBR identity/profile snapshot. Treat `website_url` presence/absence as a frozen Subject fact; mark every Criterion that requires actual page-crawl content as `EVIDENCE_UNAVAILABLE` until a separate trusted website snapshot exists. The Agent receives no bare URL as permission to browse, and incomplete coverage remains visible rather than fabricated.
- [ ] Add scoring fixtures covering exact boundary Grades, `ROUND_HALF_UP`, N/A exclusion, unavailable Evidence reducing coverage, incomplete Grade suppression, dimension totals, and producer-declared score mismatch rejection.
- [ ] Build canonical Evidence only by resolving opaque handles in the frozen manifest. Inject source kind/reference, captured time, hash, Asset binding, freshness, scope type/key, max score, weight, dimension, category, and normalized severity on the server.
- [ ] Reject a rubric version whose bytes differ from an already stored `rubric_version` hash; never update or delete a stored rubric row.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_rubric.py tests/test_audit_contracts.py -q
```

- [ ] Commit as `feat: score audit reports from immutable rubric` when green.

## Task 5: Add Audit core tables, constraints, and immutable guards

**Files:**

- Create: `api/migrations/0002_audit_core.sql`
- Create: `api/app/audit_repository.py`
- Create: `api/tests/test_audit_schema.py`
- Create: `api/tests/test_audit_repository.py`

**Schema scope:**

Create all fields and discriminator CHECKs from Sections 7.1–7.12 of the spec for `audit_subjects`, `audit_subject_events`, `audit_policies`, `audit_runs`, `audit_run_attempts`, `audit_run_events`, `audit_rubric_versions`, `audit_versions`, `audit_criterion_results`, `audit_subject_heads`, `audit_assets`, `audit_version_assets`, `audit_exports`, `audit_export_attempts`, `audit_legacy_sources`, and `audit_change_alerts`. Reserve `audit_plan_selections`, `audit_plan_deliveries`, `audit_plan_delivery_attempts`, `audit_plan_delivery_events`, and `audit_plan_links` for Phase 6 migration `0004_audit_plan_delivery.sql`.

Required database enforcement includes:

- one active Run per Subject and one active Attempt per Run through partial unique indexes;
- exact manual/scheduled trigger shape CHECKs;
- unique request, occurrence, retry parent, dispatch key, remote run, Run→Version, Attempt→Version, Version number, Criterion ID, head generation, Export identity, and Alert Version keys;
- Version discriminator CHECKs for `native_v2`, `legacy_v1`, and `legacy_artifact`;
- `ON DELETE RESTRICT` for accepted Version/Rubric/ready Asset history;
- triggers rejecting UPDATE/DELETE of rubric rows, Versions, Criterion rows, Version-Asset links, terminal Attempts/events, ready Asset content metadata, and ready Export content metadata.
- `audit_assets.status` CHECK explicitly covering `pending|ready|failed|deleting`, with transition guards allowing only `pending → ready|failed|deleting` and `failed → deleting`; a ready publisher CAS must match both `status='pending'` and the expected `lease_generation`, and `deleting` can never become ready.
- Attempt columns for bounded producer-response byte count and SHA-256 so validation failure preserves identity without exposing invalid raw output through operator APIs.

**Repository interfaces:**

```python
ACTIVE_RUN_STATUSES = frozenset({"queued", "dispatching", "running", "validating", "unknown"})

def append_audit_event(conn: sqlite3.Connection, *, run_id: str,
                       attempt_id: str | None, event_kind: str,
                       safe_payload: dict[str, object], occurred_at: str) -> None: ...

def accept_audit_version(conn: sqlite3.Connection, *, run_id: str,
                         attempt_id: str, lease_generation: int,
                         producer_result: dict[str, object],
                         canonical_report: dict[str, object],
                         accepted_at: str) -> AcceptedAuditVersion: ...

def verify_audit_version_readback(conn: sqlite3.Connection,
                                  version_id: str) -> VerifiedAuditVersion: ...
```

- [ ] Write schema tests that attempt every invalid discriminator/status/null combination and every duplicate protected identity. Use two SQLite connections to prove the active Run/Attempt indexes under race.
- [ ] Assert through `sqlite_master`, `PRAGMA foreign_key_list`, and `PRAGMA index_list` that all Location Registry and Audit core tables/indexes/triggers exist after both blank initialization and upgrade from a pre-migration database.
- [ ] Write trigger tests proving immutable rows and ready content metadata cannot update/delete, while an Export projection may move from failed to queued only through a new explicit Attempt in its later service transaction.
- [ ] Add Asset lifecycle tests for `pending → ready|failed|deleting`, `failed → deleting`, rejection of every other transition, publisher rejection after `deleting`, and stale `lease_generation` CAS failure.
- [ ] Add acceptance tests for atomic Version/Criteria/Asset-link/Attempt/Run/head/policy/alert/event commit and inject a failure before each write boundary to prove the whole transaction rolls back.
- [ ] In `accept_audit_version`, re-read Run, Attempt, lease generation, current Subject status/generation/hash, ready Assets, prior generation head, and policy version. Fail with stable codes before inserting a Version if any fence changed.
- [ ] Freeze `comparison_base_version_id` by searching all earlier compatible same-generation Versions using `(report_at, score tier, provenance tier, stable Version ID)` order; skip unscored and incompatible candidates rather than stopping at the head.
- [ ] Assign `version_number` inside `BEGIN IMMEDIATE`, insert canonical payload and Criterion projection in the same transaction, and update the generation-scoped head only when the candidate wins the deterministic total ordering.
- [ ] Rebuild sorted Criterion projection hashes from canonical payload in `verify_audit_version_readback`; compare subject, rubric, producer, payload, input manifest, Criteria, Asset bindings, Attempt, Run, and head relations. Call this verifier inside the acceptance transaction before commit so a mismatch rolls back; fail closed on any later read mismatch.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_schema.py tests/test_audit_repository.py tests/test_audit_rubric.py -q
```

- [ ] Commit as `feat: persist immutable audit versions` when green.

## Task 6: Project Audit Subjects and protect immutable merchant history

**Files:**

- Create: `api/app/audit_subjects.py`
- Modify: `api/app/location_registry.py`
- Modify: `api/app/merchant_profiles.py`
- Modify: `api/app/merchants.py`
- Modify: `api/tests/test_location_registry.py`
- Modify: `api/tests/test_merchant_profiles.py`
- Modify: `api/tests/test_merchants.py`

**Interfaces:**

```python
def project_audit_subject(conn: sqlite3.Connection, *,
                          location: ResolvedMerchantLocation,
                          website_url: str | None, actor: str,
                          projected_at: str) -> str: ...

def invalidate_subject_generation(conn: sqlite3.Connection, *, subject_id: str,
                                  subject_event_id: str,
                                  new_generation: int,
                                  new_manifest_sha256: str,
                                  changed_at: str) -> None: ...
```

- [ ] Add tests that exact location reconciliation creates one Subject, unchanged sync is idempotent, website/identity changes append an event, queued Runs become blocked, acknowledged Runs become invalidated but remain tracked, and the current-generation head becomes empty without deleting old history.
- [ ] Keep Audit Subject `identity_generation` independent from the registry's binding/alias/status generation vector: the Subject manifest includes the current canonical Audit Location manifest/hash plus normalized website URL. Increment the Subject generation whenever that full Subject manifest changes, including website changes; a display-title-only change updates presentation without changing the registry vector or Subject generation.
- [ ] Ensure Subject creation/projection and source snapshot persistence commit together. If exact resolution fails, append a shared `needs_attention` status event with bounded reason/evidence and create no active Subject.
- [ ] On merchant/location archive or generation change, update Subject/policy/Run projections with policy-version CAS in the same transaction as the registry lifecycle event.
- [ ] Extend `merchant_has_active_work()` to include active Audit Runs.
- [ ] Before merchant hard delete, query accepted Audit Versions. Return HTTP 409 with structured code `MERCHANT_HAS_IMMUTABLE_AUDIT_HISTORY` and an archive recommendation when any exist. Also reject with `MERCHANT_HAS_AUDIT_ASSETS` while any Audit Asset metadata exists; Phase 5 extends this path with exact unaccepted-object cleanup.
- [ ] For a merchant with no Audit Version, no active work, and no Audit Asset rows, implement `delete_unaccepted_audit_state(conn, merchant_id)` and call it inside the existing delete transaction before the existing shared merchant/location cleanup. Delete only Audit-owned state in dependency order: Run events; terminal Attempts; terminal/blocked Runs; policies; Subject events; Subjects. Do not delete shared location aliases, bindings, status events, or locations from the Audit helper. Assert every Audit delete is scoped through the target merchant/Subject IDs and read back zero Audit dependents before the existing merchant lifecycle code handles shared registry rows.
- [ ] Add tests for a never-audited synced merchant, blocked-only history, failed-only history, active Run, accepted Version, and Asset metadata. The first three delete cleanly with no orphan/FK failure; active/history/Asset cases return their stable conflict without partial deletion.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_location_registry.py tests/test_merchant_profiles.py tests/test_merchants.py tests/test_audit_repository.py -q
```

- [ ] Run the full backend suite and require no v1/keyword/GBP/Task regressions:

```bash
.venv/bin/python -m pytest -q
```

- [ ] Inspect `git status --short` and `git diff --check`; commit as `feat: project audit subjects from location registry` when green.

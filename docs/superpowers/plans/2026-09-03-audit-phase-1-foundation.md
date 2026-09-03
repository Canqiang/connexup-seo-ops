# Audit Phase 1 Stable Identity and Immutable Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish stable location identity, strict Audit v2 contracts, frozen rubric/scoring, and immutable version persistence before any new remote Audit dispatch is allowed.

**Architecture:** Add an ordered SQL migration runner beside the existing bootstrap schema. Reconcile each exact GBP location into a shared Location Registry inside the existing GBP persistence transaction, then project active Audit Subjects from that registry. Validate producer output against a frozen evidence manifest and rubric, construct canonical v2 server-side, and accept Version/Criteria/head/policy/events atomically with immutable database guards and readback verification.

**Tech Stack:** FastAPI, Pydantic v2, Python `sqlite3`, `decimal.Decimal`, `rfc8785`, pytest.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Work only in the isolated `codex/audit-report-workspace` worktree named in the roadmap.
- Do not change `audit_snapshots.py` or its v1 contract. Native v2 code lives in new modules.
- Existing `merchant_gbp_profiles` rows are replaceable snapshots; never reference their integer IDs from a stable Audit subject.
- Exact GBP location ID is the initial binding authority. Preserve Place ID observations as versioned aliases/evidence; do not merge identities by display name or address.
- All accepted JSON hashes use RFC 8785 JCS. All scoring uses Decimal/integer basis points and `ROUND_HALF_UP`; do not hash binary floating-point output.
- New immutable tables use `ON DELETE RESTRICT` and database triggers. Do not rely on Python conventions for immutability.
- Do not add dispatch, scheduler, UI, export, legacy migration, or Plan delivery behavior in this phase.

---

## Task 1: Add an ordered, checksummed SQL migration runner

**Files:**

- Create: `api/migrations/README.md`
- Modify: `api/app/db.py`
- Modify: `api/tests/test_db.py`

**Interfaces:**

```python
MIGRATIONS_PATH = Path(__file__).resolve().parent.parent / "migrations"

def apply_schema_migrations(conn: sqlite3.Connection,
                            migrations_path: Path = MIGRATIONS_PATH) -> None: ...
def migration_sha256(path: Path) -> str: ...
def iter_complete_sql_statements(script: str) -> Iterator[str]: ...
```

`schema_migrations` has `version TEXT PRIMARY KEY`, `sha256 TEXT NOT NULL`, and `applied_at TEXT NOT NULL`. A file whose recorded hash differs from its current bytes raises `RuntimeError("schema migration checksum mismatch: <version>")` before later migrations run.

- [ ] Add failing tests that create temporary sample migration files outside the production migration directory, initialize a blank database, apply them in filename order, re-run initialization as a no-op, and reject a modified already-recorded migration checksum.
- [ ] Add a failing test opening the same SQLite file from two connections and assert both end with one row per migration and no partially applied schema.
- [ ] Run the focused tests and confirm the missing runner/schema failures:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_db.py -q
```

- [ ] Implement `iter_complete_sql_statements` with `sqlite3.complete_statement` so trigger bodies remain intact. For each migration, acquire `BEGIN IMMEDIATE`, re-read the migration ledger under that lock, execute each complete statement with `conn.execute` rather than `executescript`, insert the version/hash row, and commit. Roll back the whole file on any statement failure; this avoids `executescript`'s implicit pre-commit breaking migration atomicity.
- [ ] Call the ordered runner from `init_db()` after the existing `schema.sql` bootstrap and lightweight column migration. Existing databases and fresh databases must converge on the same schema.
- [ ] Document that an applied numbered migration is immutable. Every later schema change receives a new higher-numbered file; no later task may modify a migration after its checksum can have been recorded.
- [ ] Run the focused tests, `git diff --check`, and inspect only the migration-runner diff. Commit as `feat: add ordered schema migrations` when green.

## Task 2: Create the shared stable Location Registry

**Files:**

- Create: `api/migrations/0001_location_registry.sql`
- Create: `api/app/location_registry.py`
- Modify: `api/app/merchant_profiles.py`
- Modify: `api/app/merchants.py`
- Create: `api/tests/test_location_registry.py`
- Modify: `api/tests/test_merchant_profiles.py`
- Modify: `api/tests/test_merchants.py`

**Tables and keys:**

- `merchant_locations(id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','archived')), identity_generation INTEGER NOT NULL CHECK(identity_generation > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,merchant_id))`.
- `merchant_location_bindings(id TEXT PRIMARY KEY, merchant_location_id TEXT NOT NULL, merchant_id INTEGER NOT NULL, source_kind TEXT NOT NULL, source_scope TEXT NOT NULL, external_location_id TEXT NOT NULL, valid_from TEXT NOT NULL, valid_to TEXT, binding_generation INTEGER NOT NULL, evidence_sha256 TEXT NOT NULL, UNIQUE(source_kind,source_scope,external_location_id,valid_from), FOREIGN KEY(merchant_location_id,merchant_id) REFERENCES merchant_locations(id,merchant_id) ON DELETE RESTRICT)`.
- `merchant_location_aliases(id TEXT PRIMARY KEY, merchant_location_id TEXT NOT NULL, merchant_id INTEGER NOT NULL, alias_kind TEXT NOT NULL CHECK(alias_kind IN ('place_id')), alias_value TEXT NOT NULL, observed_at TEXT NOT NULL, valid_to TEXT, evidence_sha256 TEXT NOT NULL, alias_generation INTEGER NOT NULL, FOREIGN KEY(merchant_location_id,merchant_id) REFERENCES merchant_locations(id,merchant_id) ON DELETE RESTRICT)`.
- `merchant_location_events(id TEXT PRIMARY KEY, merchant_location_id TEXT NOT NULL, merchant_id INTEGER NOT NULL, event_kind TEXT NOT NULL, before_generation INTEGER, after_generation INTEGER NOT NULL, manifest_json TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(merchant_location_id,merchant_id) REFERENCES merchant_locations(id,merchant_id) ON DELETE RESTRICT)`.
- `merchant_location_quality_issues(id TEXT PRIMARY KEY, merchant_id INTEGER NOT NULL, source_kind TEXT NOT NULL, source_scope TEXT NOT NULL, external_location_id TEXT, reason_code TEXT NOT NULL, evidence_sha256 TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved')), created_at TEXT NOT NULL, resolved_at TEXT)`.

**Interfaces:**

```python
@dataclass(frozen=True)
class ResolvedMerchantLocation:
    merchant_location_id: str
    merchant_id: int
    identity_generation: int
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
- [ ] Assert that an unchanged exact identity preserves `merchant_location_id` and generation; an identity-affecting binding/Place change appends an event and increments generation; a fuzzy title/address match never creates a binding.
- [ ] Mint `merchant_location_id` once on the first exact binding as a deterministic UUIDv5 derived from the SEO Ops namespace plus `merchant_id`, `source_kind`, normalized account scope, and that initial external location ID. Persist and reuse that internal ID forever; subsequent exact binding rotation never recomputes it.
- [ ] When a new exact GBP binding has no current binding row, attach it to an existing active location only if its non-empty Place ID exactly matches one unique current Place alias for the same merchant. If there is no exact Place match, create a new location from the new binding; if more than one match exists, quarantine the source. Never use title/address similarity for this decision.
- [ ] Implement canonical Location Registry manifest creation and JCS/SHA-256 verification. Include merchant ID, internal location ID, active binding generation, exact GBP location ID, and current Place alias/evidence generation; exclude website and display-only title changes. Website belongs to the Audit Subject projection in Task 6, not the shared location identity.
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
- [ ] Keep Audit Subject `identity_generation` independent from `merchant_locations.identity_generation`: the Subject manifest includes the current Location Registry generation/hash plus normalized website URL. Increment the Subject generation whenever that full Subject manifest changes, including website changes; a display-title-only change updates presentation without incrementing either generation.
- [ ] Ensure Subject creation/projection and source snapshot persistence commit together. If exact resolution fails, write a location quality issue and create no active Subject.
- [ ] On merchant/location archive or generation change, update Subject/policy/Run projections with policy-version CAS in the same transaction as the registry lifecycle event.
- [ ] Extend `merchant_has_active_work()` to include active Audit Runs.
- [ ] Before merchant hard delete, query accepted Audit Versions. Return HTTP 409 with structured code `MERCHANT_HAS_IMMUTABLE_AUDIT_HISTORY` and an archive recommendation when any exist. Also reject with `MERCHANT_HAS_AUDIT_ASSETS` while any Audit Asset metadata exists; Phase 5 extends this path with exact unaccepted-object cleanup.
- [ ] For a merchant with no Audit Version, no active work, and no Audit Asset rows, implement `delete_unaccepted_audit_state(conn, merchant_id)` and call it inside the existing delete transaction before `DELETE FROM merchants`. Delete only in dependency order: Run events; terminal Attempts; terminal/blocked Runs; policies; Subject events; Subjects; location quality issues; aliases; bindings; lifecycle events; locations. Assert every delete is scoped through the target merchant/Subject IDs, then read back zero dependent rows before deleting the merchant.
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

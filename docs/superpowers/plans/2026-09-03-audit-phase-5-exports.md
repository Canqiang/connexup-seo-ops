# Audit Phase 5 Durable Report Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export an accepted Audit Version as deterministic internal JSON, self-contained HTML, and customer PDF, with durable content-addressed storage, immutable attempt history, authenticated download, and bytes-level readback proof.

**Architecture:** An Export command freezes Version, format, locale, template, renderer, and comparison base into an idempotent database resource. A dedicated worker builds one safe render model from the verified immutable Version, renders JSON or self-contained HTML, and uses pinned Playwright Chromium to print the same HTML to PDF. Files are written once to a configured durable Asset Store, reopened, validated, hashed, and only then published ready under a fenced Export Attempt.

**Tech Stack:** FastAPI streaming responses, Python filesystem APIs, Jinja2 3.1.6, Playwright 1.55.0 bundled Chromium, pypdf 6.0.0, pytest, React 19.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Complete Phases 1–3. Export only an accepted, readback-verified `audit_version_id`; never call Core AI, FBR, GBP, Local Falcon, or the scheduler to refresh content.
- Persist internal object keys only. Do not persist a public URL, SAS query, Authorization header, cookie, or browser credential.
- The Asset Store root must be an explicit durable path configured by `SEO_OPS_AUDIT_ASSET_DIR`; reject an empty value, relative path, `/tmp`, `/var/tmp`, or a path inside a known ephemeral container temp directory.
- Files use write-once/content-addressed semantics. A database row cannot become ready until reopened bytes match MIME, size, SHA-256, and format-specific validation.
- HTML contains no external scripts, styles, fonts, images, or network requests. PDF uses that HTML and the pinned renderer; it must not silently translate immutable report content.
- `unscored_legacy` always supports exact JSON wrapper export. HTML/PDF remain disabled unless Phase 6 registers a renderer for that exact legacy schema/version.
- A normal Export POST replay never launches another Attempt. A failed Export can retry only through the explicit retry command with a new request ID.

---

## Task 1: Add durable Asset Store configuration and write/readback protocol

**Files:**

- Create: `api/app/audit_assets.py`
- Create: `api/app/audit_asset_transport.py`
- Modify: `api/app/config.py`
- Modify: `api/.env.example`
- Create: `api/tests/test_audit_assets.py`
- Create: `api/tests/test_audit_asset_transport.py`
- Modify: `api/app/audit_worker.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/tests/test_audit_worker.py`
- Modify: `api/tests/test_config.py`

**Interfaces:**

```python
class AssetStore(Protocol):
    def put_verified(self, *, kind: str, extension: str,
                     content: bytes, mime_type: str) -> StoredObject: ...
    def read_verified(self, *, object_key: str, expected_size: int,
                      expected_sha256: str) -> bytes: ...
    def open_verified(self, *, object_key: str, expected_size: int,
                      expected_sha256: str) -> BinaryIO: ...

class FilesystemAssetStore:
    def __init__(self, root: Path): ...

class TrustedAuditAssetTransport:
    def download_coreai_attachment(self, *, run_id: str,
                                   attachment_id: str) -> DownloadedAsset: ...
    def download_registered_source(self, *, source_kind: str,
                                   artifact_reference: str) -> DownloadedAsset: ...
```

- [ ] Add config tests for accepted absolute durable path and rejection of relative/temp/root paths. Tests use their pytest temp directory through a direct constructor, not production config.
- [ ] Write Asset Store tests for atomic temp write+fsync+rename, deterministic object key, identical content replay, collision with different bytes, interrupted write, reopen/hash/size validation, path traversal, missing file, MIME allowlist, and concurrent same-content writers.
- [ ] Use keys `audit/<kind>/<sha256[0:2]>/<sha256>.<allowlisted-extension>`. Build paths from validated components, open with no-follow/exclusive semantics where supported, and verify resolved paths remain below the configured root.
- [ ] Return only object key, MIME, size, and SHA-256. Never return a filesystem absolute path through API DTOs.
- [ ] Accept Core AI attachments only through the proven opaque list/download methods from Phase 2. Accept FBR URLs only from a registered source-adapter field and a configured HTTPS host/port allowlist; never follow a URL extracted from model prose.
- [ ] For URL transport, validate scheme, explicit/default port, hostname allowlist, and every DNS answer before the first request and every redirect. Reject loopback, private, link-local, multicast, unspecified, reserved, metadata endpoints, protocol downgrade, userinfo, excessive redirects, disallowed MIME, declared/streamed/expanded size excess, connect/read/total timeout, and DNS result change. Strip query/fragment from all stored/logged references.
- [ ] Stream into a bounded pending object, then reopen and verify bytes before the Asset row can CAS from pending to ready. Optional transport failure produces `AUDIT_ASSET_TRANSPORT_UNAVAILABLE`; a rubric-required attachment prevents Version acceptance.
- [ ] The initial `2026.09` rubric has no required remote attachment. After this transport is installed, update the worker's post-completion/pre-acceptance path to list only trusted opaque attachments, internalize them through this transport/store, and bind ready metadata under the same Run. A future rubric may mark one required only after this path's readback tests pass; required means acceptance waits or fails closed, never that Phase 2 followed an arbitrary URL.
- [ ] Implement authenticated `GET /api/audit-assets/{asset_id}/preview` and `/download` only for ready metadata. Preview permits PNG/JPEG inline and renders JSON as escaped `text/plain`. In the first release, PDF/HTML preview returns 409 `AUDIT_ACTIVE_CONTENT_PREVIEW_UNAVAILABLE` because this repository has no isolated-origin deployment; authenticated download remains available. Do not serve untrusted PDF/HTML inline from the application origin.
- [ ] Set `Content-Security-Policy`, `X-Content-Type-Options: nosniff`, safe `Content-Disposition`, `Cache-Control: private, no-store`, and no-referrer headers.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_audit_assets.py tests/test_audit_asset_transport.py tests/test_config.py -q
```

- [ ] Commit as `feat: add durable audit asset store` when green.

## Task 2: Build one safe render model and deterministic JSON export

**Files:**

- Create: `api/app/audit_rendering.py`
- Create: `api/tests/test_audit_rendering.py`
- Create: `api/tests/fixtures/audit_export_expected.json`

**Interfaces:**

```python
AUDIT_TEMPLATE_VERSION = "customer-v1"
AUDIT_JSON_RENDERER_VERSION = "json-wrapper-v1"

def build_audit_render_model(*, version: VerifiedAuditVersion,
                             comparison: AuditComparison | None,
                             locale: str) -> AuditRenderModel: ...
def render_audit_json(*, version: VerifiedAuditVersion,
                      locale: str) -> bytes: ...
```

- [ ] Add snapshot-style structural tests for scored, incomplete, no comparison, comparison with added/persistent/resolved, shared scope, missing optional website, and unscored legacy.
- [ ] Whitelist render-model fields. Customer-facing views exclude operator identity, Core AI/Attempt/Run/database IDs, retries, internal source references, validation errors, and full provenance. Internal JSON puts safe trusted provenance in a separate top-level section.
- [ ] Produce a deterministic UTF-8 JSON wrapper containing safe Version metadata, version kind, score status, exact stored payload, payload hash mode/hash, raw source hash when legacy, and safe provenance. Serialize with JCS and a trailing newline.
- [ ] Recompute the inner payload hash from the stored payload before rendering; refuse export if it differs. Keep inner payload hash distinct from the outer file bytes hash.
- [ ] Locale changes labels/date/number formatting metadata only. Observation, evidence fact, recommendation, limitations, and summary remain in their original report language and the output declares that language.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_rendering.py -k json -q
```

- [ ] Commit as `feat: render deterministic audit json exports` when green.

## Task 3: Render self-contained CSP-safe HTML

**Files:**

- Create: `api/app/templates/audit/customer-v1.html.j2`
- Create: `api/app/templates/audit/customer-v1.css`
- Modify: `api/app/audit_rendering.py`
- Modify: `api/tests/test_audit_rendering.py`
- Modify: `api/requirements.txt`

**Renderer identity:** `html-jinja-3.1.6-customer-v1`.

- [ ] Pin `Jinja2==3.1.6`, install it in the worktree venv, and add tests that render the full canonical fixture and parse the result as HTML.
- [ ] Create a single document with inline CSS, no `<script>`, no `<link>`, no remote URL, and no active form. Use system-safe font fallbacks and inline data URIs only for fixed repository-owned decorative assets whose bytes/hash are part of the template version.
- [ ] Include cover identity, report date/version/Rubric/data-through, score/Grade/coverage, dimension scorecards, priority Criteria, Evidence summaries, recommendations, comparison changes when frozen, limitations, methodology, Version ID, template version, renderer version, and short hash.
- [ ] Escape every report string by default. Never mark producer/legacy HTML as safe. Validate resulting CSP-compatible tags/attributes and fail on external `src`, `href`, CSS `url()`, meta refresh, iframe, object, embed, or SVG script/event attributes.
- [ ] For incomplete reports, label partial score and “数据不完整”; do not show a Grade. Reject unscored legacy unless an exact renderer is registered in Phase 6.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_rendering.py -k html -q
```

- [ ] Commit as `feat: render self contained audit html` when green.

## Task 4: Render and validate customer PDF with pinned Chromium

**Files:**

- Create: `api/app/audit_pdf.py`
- Create: `api/scripts/install_audit_chromium.py`
- Create: `api/tests/test_audit_pdf.py`
- Modify: `api/requirements.txt`
- Modify: `README.md`

**Renderer identity:** `playwright-1.55.0-chromium-customer-v1` plus the exact bundled Chromium revision returned by Playwright at installation; store that resolved revision in each Export request identity and result metadata.

- [ ] Pin `playwright==1.55.0` and `pypdf==6.0.0`. Add setup instructions that run `.venv/bin/python -m playwright install chromium`; do not use an unversioned system browser.
- [ ] Add tests for missing browser capability, successful PDF signature, more than zero pages, extractable non-empty text, required report identifiers, no internal-only fields, long Criteria across pages, Chinese/English text, and deterministic renderer metadata.
- [ ] Load the HTML with request routing that aborts every `http://`, `https://`, `file://`, websocket, and other network request. Use `page.set_content`, print-background, fixed A4 margins/header/footer, and close browser/context on every outcome.
- [ ] Parse output with pypdf, verify `%PDF-`, page count, non-empty extracted report title/Version text, and configured maximum bytes before returning content to the Asset Store.
- [ ] At API startup, probe the exact browser executable/revision once and expose PDF capability false with `AUDIT_EXPORT_RUNTIME_UNAVAILABLE` if missing or mismatched. Do not fail the whole SEO Ops app; HTML/JSON remain available.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_pdf.py tests/test_audit_rendering.py -q
```

- [ ] Commit as `feat: render verified audit pdf reports` when green.

## Task 5: Implement Export commands, attempts, worker, and downloads

**Files:**

- Create: `api/app/audit_exports.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_exports.py`

**Endpoints:**

- `POST /api/audit-versions/{version_id}/exports`
- `GET /api/audit-exports/{export_id}`
- `POST /api/audit-exports/{export_id}/retry`
- `GET /api/audit-exports/{export_id}/download`

**Worker interfaces:**

```python
def process_audit_exports_once(*, now: str, worker_id: str,
                               store: AssetStore | None = None) -> int: ...
async def audit_export_worker_loop() -> None: ...
```

- [ ] Add API tests for auth, unsupported legacy format, format/locale/template/renderer/base validation, request replay, request-ID payload conflict, identity reuse, queued/running/failed/ready status, explicit retry, concurrent Attempt claim, and cross-merchant download isolation.
- [ ] Return `poll_after_ms=2000` only while Export status is queued/running and `null` for failed/ready. The browser must never invent its own polling cadence.
- [ ] Canonicalize the request fields and comparison-base key. In one short transaction, verify Version/capability/base, insert or replay one Export, and create the first queued Attempt only when the Export is new.
- [ ] Return 409 `AUDIT_IDEMPOTENCY_KEY_REUSED` when one request ID is paired with a different request hash. Return 409 `AUDIT_EXPORT_UNSUPPORTED_VERSION_KIND` for unsupported format/version combinations.
- [ ] Claim and fence one Export Attempt in a short transaction, render and store bytes outside the transaction, reopen/validate bytes, then publish object metadata and ready status under current lease-generation CAS.
- [ ] A normal POST returns an existing failed Export without rendering. Retry requires a new request ID, adds one immutable Attempt, and may move the Export projection back to queued; ready cannot retry or mutate.
- [ ] Stream ready downloads through authentication with safe filename `<location-slug>-audit-v<version>.<ext>` and verified bytes. Never redirect to or create a persistent signed URL.
- [ ] Register one export worker loop in lifespan and run:

```bash
.venv/bin/python -m pytest tests/test_audit_exports.py tests/test_audit_assets.py tests/test_audit_rendering.py tests/test_audit_pdf.py -q
```

- [ ] Commit as `feat: generate and download audit exports` when green.

## Task 6: Wire Export UX and durable cleanup

**Files:**

- Modify: `web/src/components/audit/AuditExportDialog.tsx`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`
- Create: `api/app/audit_asset_cleanup.py`
- Create: `api/tests/test_audit_asset_cleanup.py`
- Modify: `api/app/audit_observability.py`
- Modify: `api/tests/test_audit_observability.py`
- Modify: `api/app/merchants.py`
- Modify: `api/tests/test_merchants.py`
- Modify: `api/app/main.py`

- [ ] Add UI tests for PDF default, independent format capabilities, locale/report-language explanation, comparison inclusion, one request ID per command, ready replay, failed explicit retry, status polling only while queued/running, authenticated Blob download, filename, and stable errors.
- [ ] Display template and accepted Version identity in the confirmation. Disable unsupported formats with server text; do not let the browser infer PDF availability from environment assumptions.
- [ ] Use `requestBlob()` only after ready. Trigger a local object URL download, revoke it after click, and never display/persist a provider URL.
- [ ] Implement a daily cleanup loop that lists database-tracked pending/failed objects older than 24 hours, rechecks no ready Asset/Export references in a short transaction, deletes only the exact internal object key, and appends one safe cleanup event. Accepted/ready content is never ordinary-cleanup eligible.
- [ ] Extend explicit merchant hard delete for the no-Version/no-active-work case: enumerate only unreferenced pending/failed Audit objects, delete each exact verified object outside the database transaction, then begin the existing delete transaction, recheck all gates, delete their metadata, and call Phase 1 `delete_unaccepted_audit_state`. Any ready Asset or accepted Version still returns a stable 409 and preserves the merchant.
- [ ] Emit safe Export latency, format, size, failure-code, retry, ready, and cleanup counters through `audit_observability`; never emit filename, report text, source reference, or URL.
- [ ] Add tests for protected ready Version Asset, protected ready Export, young pending file, orphan pending file, path traversal/collision, crash between file delete and event, and idempotent next pass.
- [ ] Run complete suites and builds:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest -q
cd ../web
npm test
npm run lint
npm run build
```

- [ ] Generate all three formats from one fixture Version, reopen each file, recompute hashes, parse JSON/HTML, decode PDF, and record exact verification in `docs/evidence/audit-export-readback-2026-09-03.md`.
- [ ] Commit as `feat: complete audit export workflow` when all checks pass.

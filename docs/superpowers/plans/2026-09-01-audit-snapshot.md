# Audit Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist validated `seo_ops.audit_report.v1` results and render them as a concise internal Audit report while retaining legacy Markdown reports.

**Architecture:** A focused `audit_snapshots` module owns the strict Pydantic contract, normalization, persistence, and Run-scoped query. The scheduler attempts ingestion after a completed Run; the React report page prefers a snapshot and otherwise uses the existing Markdown path.

**Tech Stack:** FastAPI, Pydantic v2, SQLite, React, TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-audit-snapshot-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Do not modify Core AI or FBR Project code.
- Reject non-conforming Audit output; do not infer missing evidence.
- Preserve existing Markdown and Plan behavior.
- Keep the PC-first internal console visually simple.

---

### Task 1: Strict Audit contract and persistence

**Files:**
- Create: `api/app/audit_snapshots.py`
- Modify: `api/schema.sql`
- Test: `api/tests/test_audit_snapshots.py`

**Interfaces:**
- Produces: `parse_audit_report(raw: object, expected_merchant_id: int) -> AuditReportV1`.
- Produces: `persist_audit_snapshot(conn, run, raw, accepted_at) -> sqlite3.Row`.
- Produces: `GET /api/runs/{run_id}/audit`.

- [ ] **Step 1: Write failing contract and API tests**

Cover a valid report, Markdown rejection, extra-field rejection, merchant mismatch, normalized persistence, duplicate Run replacement prevention, 404 without a snapshot, and authenticated retrieval.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd api && .venv/bin/pytest tests/test_audit_snapshots.py -q`
Expected: collection fails because `app.audit_snapshots` does not exist.

- [ ] **Step 3: Implement the minimal contract and storage**

Use Pydantic models with `ConfigDict(extra="forbid")`. Parse only a JSON object whose `schema_version` is `seo_ops.audit_report.v1`, compare `merchant_id` with `str(expected_merchant_id)`, serialize with `model_dump_json()`, and insert once per Run.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `cd api && .venv/bin/pytest tests/test_audit_snapshots.py -q`
Expected: all focused tests pass.

### Task 2: Completed Run ingestion

**Files:**
- Modify: `api/app/scheduler.py`
- Test: `api/tests/test_scheduler.py`

**Interfaces:**
- Consumes: `persist_audit_snapshot` from Task 1.
- Preserves: `runs.report_text` and existing `extract_plan(report)` behavior.

- [ ] **Step 1: Write failing scheduler tests**

Assert that a completed strict Audit creates one Snapshot, while a completed legacy Markdown report succeeds without a Snapshot.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd api && .venv/bin/pytest tests/test_scheduler.py -q`
Expected: strict Audit Run has no `audit_snapshots` row.

- [ ] **Step 3: Implement best-effort strict ingestion**

After storing `report_text`, call `persist_audit_snapshot`. Catch only `ValueError`/Pydantic validation failures, log a concise legacy-output message, and continue the existing Plan parsing path.

- [ ] **Step 4: Run scheduler and backend suites**

Run: `cd api && .venv/bin/pytest tests/test_scheduler.py tests/test_audit_snapshots.py -q`
Expected: focused tests pass.

### Task 3: Structured Audit report UI

**Files:**
- Modify: `web/src/api.ts`
- Create: `web/src/components/AuditReport.tsx`
- Modify: `web/src/pages/RunDetail.tsx`
- Modify: `web/src/index.css`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Produces: `api.getRunAudit(runId) -> Promise<AuditSnapshot>`.
- Produces: `<AuditReport snapshot={snapshot} />`.
- Preserves: Markdown fallback and Plan side panel.

- [ ] **Step 1: Write failing UI tests**

Return a Snapshot fixture and assert the page shows summary, evidence mode, finding severity/area, observation, evidence, recommendation, limitations and next actions without showing raw JSON. Add a 404 fixture that proves Markdown remains visible.

- [ ] **Step 2: Run test to verify RED**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: the Audit fields are absent.

- [ ] **Step 3: Implement the restrained report component**

Use a conclusion header, vertically stacked finding rows, and a two-column limitations/actions footer. Do not add tabs, charts, metric cards, raw payload panels, or animation.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: all App tests pass.

### Task 4: Local demonstration and verification

**Files:**
- No production file changes unless verification exposes a tested defect.

**Interfaces:**
- Produces: one local Snapshot for the newest existing Run, constructed only from that Run's existing statements.

- [ ] **Step 1: Insert one evidence-preserving local demo Snapshot**

Use `persist_audit_snapshot` against the local SQLite database. Map the existing report's stated missing merchant identity, location, website and connected data into findings; add no score, ranking, traffic or business fact.

- [ ] **Step 2: Run all quality gates**

Run: `cd api && .venv/bin/pytest -q`
Run: `cd api && ruff check app tests`
Run: `cd web && npm test -- --run`
Run: `cd web && npm run lint`
Run: `cd web && npm run build`

- [ ] **Step 3: Read back local behavior**

Verify authenticated `GET /api/runs/{id}/audit` returns the persisted Snapshot and the browser report page displays its structured content while another historical Run still renders Markdown.

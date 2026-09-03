# Local Falcon Keyword Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prefer the merchant's persisted FBR keyword set, synchronize existing Local Falcon reports, display precise keyword metrics, and support an approval-controlled scored Top 20 scan workflow. Operators may explicitly regenerate and re-score keywords through the configured Seed and Ranking Skills.

**Architecture:** SEO Ops reads persisted keywords first and never regenerates them as a side effect of page load or Local Falcon synchronization. The separate regenerate action freezes the configured Seed and Ranking Skill identities, then accepts its result only after Core AI trace spans prove both Skills were loaded once, succeeded, and were loaded in order. Since Skills are Agent instructions rather than independently executed functions, an operator must still inspect and approve the frozen scored Top 20 before any Local Falcon spend. A narrow server-side Local Falcon adapter reads reports and submits only explicitly confirmed single-keyword scans. SQLite stores validated snapshots, keyword provenance, immutable operator approvals, idempotent scan batches, and per-keyword submission state. React keeps the full keyword set in one compact scrollable table, renders an accessible miniature point grid per report, and confirms the approved Top 20 before any credit-consuming call.

**Tech Stack:** Python 3, FastAPI, SQLite, httpx, Pydantic, pytest, React 19, TypeScript, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-local-falcon-keyword-ranking-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Do not modify or publish Core AI, FBR, or Local Falcon configuration.
- The readback path may call only `listLocalFalconScanReports` and `getLocalFalconReport`.
- `runLocalFalconScan` may be called only through the separately approved and credit-confirmed batch endpoint. Never call a campaign tool, auto-retry an uncertain paid submission, or trigger a scan from tests.
- Keyword refresh is database-only. It reads FBR persisted keywords and must not silently substitute generated or DataForSEO keywords.
- Keyword regeneration is an explicit operator action. A generated artifact is not eligible for Local Falcon until runtime trace evidence proves the configured Seed Skill followed by the configured Ranking Skill.
- Only a scored, deterministically ordered Top 20 cohort may enter approval or paid submission. Missing scores fail closed.
- Preserve all unrelated dirty-worktree changes.
- Desktop PC is the supported layout; mobile optimization is out of scope.

---

### Task 1: Add a strict Core AI MCP read adapter

**Files:**
- Modify: `api/app/config.py`
- Modify: `api/app/coreai.py`
- Create: `api/app/local_falcon.py`
- Modify: `api/.env.example`
- Test: `api/tests/test_coreai.py`
- Test: `api/tests/test_local_falcon.py`

**Interfaces:**
- Produces: `CoreAiClient.call_mcp_tool(server_id: str, tool_name: str, arguments: dict) -> dict`.
- Produces: `LocalFalconClient.list_latest_exact_report(place_id: str, keyword: str) -> dict | None` and `get_report(report_key: str) -> dict`.

- [ ] **Step 1: Write failing MCP response tests**

Assert that `call_mcp_tool` posts `{tool_name, arguments: <JSON string>}` to `/api/tools/mcp-servers/{id}/test-tool`, parses the nested result JSON, and rejects unsuccessful/non-object results.

- [ ] **Step 2: Run RED**

Run: `cd api && pytest tests/test_coreai.py -k mcp -q`

Expected: FAIL because `call_mcp_tool` is not defined.

- [ ] **Step 3: Implement the minimal MCP call and Local Falcon allowlist**

Add the method to `CoreAiClient`; create `LocalFalconClient` with two compact-field-mask read methods plus the separately gated `run_scan` submission method. Exact-match the returned Place ID and normalized keyword.

- [ ] **Step 4: Run GREEN**

Run: `cd api && pytest tests/test_coreai.py tests/test_local_falcon.py -q`

Expected: PASS.

### Task 2: Persist validated Local Falcon snapshots

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/seo_targets.py`
- Test: `api/tests/test_seo_targets.py`

**Interfaces:**
- Produces: `merchant_local_falcon_reports` keyed by `report_key`.
- Produces: `POST /api/merchants/{merchant_id}/local-falcon-sync`.
- Extends: SEO target state with `{local_falcon: {status, last_synced_at, missing_keywords, reports}}`.

- [ ] **Step 1: Write failing endpoint tests**

Create a ready local keyword set and synchronized Place ID. Assert exact report metrics and nine compact points for a 3x3 fixture are persisted and returned; organic keywords are not requested; missing exact reports appear in `missing_keywords`; an upstream exception preserves the prior row.

- [ ] **Step 2: Run RED**

Run: `cd api && pytest tests/test_seo_targets.py -k local_falcon -q`

Expected: FAIL with a missing route and missing state field.

- [ ] **Step 3: Add schema, validation, atomic upsert, and route**

Validate `report_key`, positive odd `grid_size`, metric ranges, `grid_size ** 2` compact points, and Place ID equality. Fetch all candidate reports before opening the upsert transaction. Do not delete historical rows or last-known snapshots.

- [ ] **Step 4: Run GREEN and backend regression**

Run: `cd api && pytest tests/test_seo_targets.py -k local_falcon -q && pytest -q`

Expected: all tests PASS.

### Task 3: Add compact keyword metrics and miniature rank grids

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantProfile.tsx`
- Modify: `web/src/index.css`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 2 `local_falcon` state and sync route.
- Produces: source/priority score/Local Pack/ARP/ATRP/SoLV/organic/scan-date columns and miniature heatmaps in one fixed-height table.

- [ ] **Step 1: Write failing UI tests**

Assert that a Local Falcon row renders `1.38`, `93.83%`, `9 × 9`, an accessible miniature heatmap with all supplied points, and a read-only sync button. Assert there is no row expansion or report drawer. Assert a DataForSEO-only row does not claim Local Falcon metrics.

- [ ] **Step 2: Run RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because Local Falcon types, action, and grid do not exist.

- [ ] **Step 3: Implement the minimal UI and grid ordering**

Join snapshots by normalized keyword identity. Sort unique latitudes descending and longitudes ascending, render the exact point count as a compact CSS heatmap in the row, and apply the four rank bands from the header legend. Keep the keyword table at a fixed height; do not add per-row expansion or a separate drawer.

- [ ] **Step 4: Run GREEN and frontend quality gates**

Run: `cd web && npm test -- --run src/App.test.tsx && npm run lint && npm run build`

Expected: all commands PASS.

### Task 4: Add approved Top 20 scan batches

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/local_falcon.py`
- Modify: `api/app/seo_targets.py`
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantProfile.tsx`
- Modify: `web/src/index.css`
- Test: `api/tests/test_local_falcon.py`
- Test: `api/tests/test_seo_targets.py`
- Test: `web/src/App.test.tsx`

- [x] Read the persisted FBR keyword set first; expose explicit database refresh and explicit regeneration as separate operations.
- [x] Freeze the configured Seed and Ranking Skill IDs/names in the regeneration request, and persist runtime `use_skill` trace evidence before treating generated keywords as trusted.
- [x] Reject missing, duplicate, failed, out-of-order, or unverifiable Skill invocations instead of accepting the Agent's declared configuration as proof.
- [x] Require numeric keyword scores, apply deterministic score ordering and tie-breakers, and select at most the first 20 unique local keywords.
- [x] Persist a canonical scored Top 20 SHA-256 and operator approval tied to the exact keyword artifact.
- [x] Persist a second explicit credit confirmation that freezes the request ID and exact scan-parameter hash before submitting scans.
- [x] Persist and claim the batch before every remote call; dispatch paid scans in a durable worker rather than the HTTP request.
- [x] Persist `submitting` before every remote call and never auto-retry `unknown` or partially acknowledged submissions.
- [x] Require manual reconciliation for an uncertain or partial batch before keyword regeneration, approval, or another paid batch can proceed.
- [x] Complete items only by exact acknowledged report-key readback with matching Place ID, keyword, grid, radius, measurement, and center.
- [x] Keep batch status summarized by default and use a fixed-height table with a header legend plus accessible miniature heatmaps; do not add inline expansion or a separate report drawer.
- [x] Keep regeneration disabled with a truthful explanation until the dedicated Agent plus both required Skill IDs are configured.

### Task 5: End-to-end verification

**Files:**
- Modify only files already listed if verification exposes a scoped defect.

**Interfaces:**
- Produces: verified local readback of a real existing UWS report without a paid scan.

- [ ] **Step 1: Run complete automated verification**

Run: `cd api && pytest -q`; then `cd ../web && npm test && npm run lint && npm run build`.

- [ ] **Step 2: Synchronize an existing UWS report locally**

Use merchant 3 and the configured UAT Core AI adapter. Confirm `breakfast upper west side` reads report `8aa3c7e1f6c599b` with ARP `1.38`, ATRP `1.38`, SoLV `93.83`, grid `9`, radius `0.5 km`, and 81 compact points. Do not invoke a run/campaign tool.

- [ ] **Step 3: Visual desktop verification**

At desktop width, verify the main table remains scannable, the database refresh and explicit regenerate actions are unambiguous, batch details do not expand, every 9x9 miniature grid fits without horizontal page overflow, and DataForSEO ranks remain separately labeled.

- [ ] **Step 4: Inspect scope and secrets**

Run: `git status --short`, `git diff --stat`, and a secret-pattern scan over the diff. Confirm every changed path belongs to `connexup-seo-ops` and no API key/token value is present.

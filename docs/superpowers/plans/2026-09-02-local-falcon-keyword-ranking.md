# Local Falcon Keyword Ranking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Synchronize existing Local Falcon reports through Core AI and display precise keyword metrics plus an interactive geographic rank grid.

**Architecture:** A narrow server-side Local Falcon adapter calls the existing Core AI MCP test-tool gateway with a strict read-only allowlist and compact field masks. SQLite stores validated source snapshots separately from the published Ranking Agent v1 artifact, and React joins snapshots to accepted keywords for a compact table and one detail panel.

**Tech Stack:** Python 3, FastAPI, SQLite, httpx, Pydantic, pytest, React 19, TypeScript, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-local-falcon-keyword-ranking-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Do not modify or publish Core AI, FBR, or Local Falcon configuration.
- The synchronization path may call only `listLocalFalconScanReports` and `getLocalFalconReport`.
- Never trigger a Local Falcon scan or campaign in this slice.
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

Add the method to `CoreAiClient`; create `LocalFalconClient` whose public methods use only the two read tools and the verified compact field masks. Exact-match the returned keyword after trimming and case-folding.

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

### Task 3: Add the compact keyword metrics and rank-grid interaction

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantProfile.tsx`
- Modify: `web/src/index.css`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: Task 2 `local_falcon` state and sync route.
- Produces: source/Local Pack/ARP/SoLV/organic/scan-date columns and one selected-report detail panel.

- [ ] **Step 1: Write failing UI tests**

Assert that a Local Falcon row renders `1.38`, `93.83%`, `9 × 9`, and a read-only sync button. Click the row and assert four supplied points render as rank cells; click again and assert the detail closes. Assert a DataForSEO-only row does not claim Local Falcon metrics.

- [ ] **Step 2: Run RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because Local Falcon types, action, and grid do not exist.

- [ ] **Step 3: Implement the minimal UI and grid ordering**

Join snapshots by case-folded keyword. Sort unique latitudes descending and longitudes ascending, render a CSS grid using `grid_size`, apply four rank bands, and keep only one report expanded at a time.

- [ ] **Step 4: Run GREEN and frontend quality gates**

Run: `cd web && npm test -- --run src/App.test.tsx && npm run lint && npm run build`

Expected: all commands PASS.

### Task 4: End-to-end verification

**Files:**
- Modify only files already listed if verification exposes a scoped defect.

**Interfaces:**
- Produces: verified local readback of a real existing UWS report without a paid scan.

- [ ] **Step 1: Run complete automated verification**

Run: `cd api && pytest -q`; then `cd ../web && npm test && npm run lint && npm run build`.

- [ ] **Step 2: Synchronize an existing UWS report locally**

Use merchant 3 and the configured UAT Core AI adapter. Confirm `breakfast upper west side` reads report `8aa3c7e1f6c599b` with ARP `1.38`, ATRP `1.38`, SoLV `93.83`, grid `9`, radius `0.5 km`, and 81 compact points. Do not invoke a run/campaign tool.

- [ ] **Step 3: Visual desktop verification**

At desktop width, verify the main table remains scannable, the sync action is unambiguous, only one detail panel opens, the 9x9 grid fits without horizontal page overflow, and DataForSEO ranks remain separately labeled.

- [ ] **Step 4: Inspect scope and secrets**

Run: `git status --short`, `git diff --stat`, and a secret-pattern scan over the diff. Confirm every changed path belongs to `connexup-seo-ops` and no API key/token value is present.

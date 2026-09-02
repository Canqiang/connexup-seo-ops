# Merchant GBP Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only FBR/GBP merchant profile view with explicit merchant binding, safe synchronization, local snapshots, and a restrained desktop UI.

**Architecture:** A server-side FBR adapter reads the existing SEO Integration API and normalizes raw GBP JSON into a local SQLite read model. FastAPI owns binding and synchronization; React reads only SEO Ops endpoints and presents merchant operations and merchant data as two adjacent views.

**Tech Stack:** Python 3, FastAPI, SQLite, urllib, Pydantic, pytest, React 19, TypeScript, React Router, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-merchant-gbp-profile-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`.
- Do not modify Core AI, FBR Project, or FBR Agent repositories.
- Never persist, return, log, or render OAuth access tokens or refresh tokens.
- The integration is read-only and performs no GBP mutation.
- Preserve current uncommitted Audit Snapshot changes and leave `docs/evidence/` untouched.
- Desktop PC is the supported layout; mobile optimization is out of scope.

---

### Task 1: Persist merchant-to-FBR links and GBP read snapshots

**Files:**
- Modify: `api/schema.sql`
- Test: `api/tests/test_merchant_profiles.py`

**Interfaces:**
- Produces: `merchant_fbr_links` and `merchant_gbp_profiles` SQLite tables.

- [ ] **Step 1: Write the failing schema test**

Create an API test that creates a merchant and asserts `GET /api/merchants/{id}/profile` returns `state: "unbound"`; it must fail because the route and tables do not exist.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd api && pytest tests/test_merchant_profiles.py::test_unbound_merchant_profile_is_explicit -q`

Expected: FAIL with a 404 response instead of the requested profile contract.

- [ ] **Step 3: Add the minimal tables**

Add `merchant_fbr_links` with `merchant_id`, `fbr_merchant_id`, `sync_status`, `last_synced_at`, `last_error`, `created_at`, and `updated_at`. Add `merchant_gbp_profiles` with resource identity, source field JSON, normalized JSON, source update time, and synchronization time; enforce one row per SEO Ops merchant and GBP location.

- [ ] **Step 4: Leave route implementation for Task 3**

Run `init_db()` through the test fixture and verify both tables exist with `PRAGMA table_info` while the profile endpoint remains RED for the expected missing-route reason.

### Task 2: Add the read-only FBR GBP client and normalizer

**Files:**
- Create: `api/app/fbr_gbp.py`
- Modify: `api/tests/test_merchant_profiles.py`

**Interfaces:**
- Produces: `FbrGbpClient.list_locations(fbr_merchant_id)`, `FbrGbpClient.get_field(fbr_merchant_id, gbp_location_id, field)`, `normalize_gbp_location(raw)`, and `fbr_gbp_client()`.

- [ ] **Step 1: Write failing parser tests**

Use a complete hand-written Google location payload and assert literal normalized values for title, primary phone, formatted address, website, primary/additional categories, opening status, description, and regular-hour periods. Add a malformed JSON test that must raise `FbrPayloadError`.

- [ ] **Step 2: Run parser tests and verify RED**

Run: `cd api && pytest tests/test_merchant_profiles.py -k normalize -q`

Expected: FAIL because `app.fbr_gbp` does not exist.

- [ ] **Step 3: Implement minimal settings, HTTP client, and parser**

Use `urllib.request` with a finite timeout. Build query strings with `urlencode`, add an optional bearer header, reject non-object JSON, and normalize only the approved presentation fields. Never include settings or response headers in exceptions.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `cd api && pytest tests/test_merchant_profiles.py -k normalize -q`

Expected: PASS.

### Task 3: Add binding, profile, and synchronization endpoints

**Files:**
- Create: `api/app/merchant_profiles.py`
- Modify: `api/app/main.py`
- Modify: `api/tests/conftest.py`
- Modify: `api/tests/test_merchant_profiles.py`

**Interfaces:**
- Consumes: `FbrGbpClient` and the Task 1 tables.
- Produces: `GET /api/merchants/{id}/profile`, `PUT /api/merchants/{id}/fbr-link`, and `POST /api/merchants/{id}/gbp-sync`.

- [ ] **Step 1: Complete endpoint behavior tests before implementation**

Assert: binding trims and persists the FBR ID; unbound sync returns 409; a full fake FBR response produces one cached location; missing optional fields remain null; a failed re-sync preserves the previous location and records `sync_status: "failed"`; returned JSON contains no token fields.

- [ ] **Step 2: Run endpoint tests and verify RED**

Run: `cd api && pytest tests/test_merchant_profiles.py -q`

Expected: FAIL on missing routes and dependency functions.

- [ ] **Step 3: Implement the minimal router and atomic cache update**

Fetch all list results, fetch each available field independently, normalize `LOCATION`, count collection items from their field payloads, and update cached rows inside one transaction. Keep the old cache when the remote call fails. Convert client configuration/unavailable errors to 503 without exposing secrets.

- [ ] **Step 4: Run endpoint and backend tests**

Run: `cd api && pytest tests/test_merchant_profiles.py -q && pytest -q`

Expected: all tests PASS.

### Task 4: Add the merchant profile desktop view

**Files:**
- Create: `web/src/components/MerchantSectionNav.tsx`
- Create: `web/src/pages/MerchantProfile.tsx`
- Modify: `web/src/pages/MerchantDetail.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: the Task 3 profile API.
- Produces: `/merchants/:id/profile`, shared `运营 / 商户资料` navigation, binding/sync interactions, and the GBP location record UI.

- [ ] **Step 1: Write the failing UI tests**

Test an unbound profile page with one labeled FBR ID input and one binding action. Test a synchronized profile with literal business name, address, phone, website, category, description, source time, and a location selector. Test that merchant operations expose the `商户资料` link.

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because the profile route and view do not exist.

- [ ] **Step 3: Add API types and build the profile view**

Add typed calls for get/bind/sync. Reuse the current merchant identity structure and tokens. Put identity/contact facts in a two-column definition grid, description and hours below, and synchronization metadata in a quiet footer. Do not render raw JSON or OAuth fields.

- [ ] **Step 4: Run UI tests and verify GREEN**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run frontend quality gates**

Run: `cd web && npm test && npm run lint && npm run build`

Expected: all commands PASS with no TypeScript errors.

### Task 5: Final verification and visual critique

**Files:**
- Modify only files already listed if verification finds a scoped defect.

**Interfaces:**
- Consumes: all previous tasks.
- Produces: a verified local merchant profile flow without external writes.

- [ ] **Step 1: Run the complete backend and frontend suites**

Run: `cd api && pytest -q`; then `cd ../web && npm test && npm run lint && npm run build`.

- [ ] **Step 2: Exercise the local flow**

Start the API and Vite application with FBR configuration absent. Verify login, merchant operations, profile navigation, unbound binding copy, and a truthful “integration not configured” sync failure. Confirm no outbound write endpoint is called.

- [ ] **Step 3: Review the desktop page visually**

At 1440px or wider, verify the profile is aligned with the existing workspace, primary facts scan left-to-right, no control crowds the title, empty fields say `未提供`, and only binding/sync actions use the orange action color.

- [ ] **Step 4: Inspect repository scope**

Run: `git status --short` and `git diff --stat`. Confirm all changed paths belong to `connexup-seo-ops`, `docs/evidence/` remains untouched, and no secret value appears in the diff.

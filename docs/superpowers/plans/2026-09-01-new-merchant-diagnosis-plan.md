# New Merchant Diagnosis and Plan Approval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a usable new-merchant flow that starts a Core AI-backed public diagnosis, produces candidate tasks, and requires one Plan approval before those tasks can start.

**Architecture:** Extend the existing FastAPI/SQLite merchant, run, and task modules rather than creating a parallel onboarding subsystem. The React UI derives the onboarding presentation from the latest Run and its generated tasks; SEO Ops remains the state owner while Core AI remains an external service behind `api/app/coreai.py`.

**Tech Stack:** Python 3.13, FastAPI, SQLite, pytest, React 19, TypeScript 6, Vite, Vitest, Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-01-new-merchant-diagnosis-plan-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`; do not modify Core AI or FBR Project.
- Preserve existing uncommitted UI work and `docs/evidence/`.
- New merchants remain persisted if Core AI diagnosis cannot start.
- Existing analysis runs and tasks must remain usable after migration.
- Tasks generated from an unapproved Plan cannot transition from `todo` to `doing`, including batch transitions.
- The desktop UI must remain concise: one diagnostic status card, one primary next action, technical details secondary.

---

### Task 1: Merchant diagnosis inputs and Core AI prompt

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Modify: `api/app/merchants.py`
- Modify: `api/app/runs.py`
- Test: `api/tests/test_merchants.py`
- Test: `api/tests/test_runs_api.py`

**Interfaces:**
- Consumes: existing `MerchantCreate`, `MerchantPatch`, `build_input(merchant)`.
- Produces: merchant JSON fields `primary_location: string | null` and `website_url: string | null`; a US-local-SEO diagnosis input passed to `CoreAiClient.trigger`.

- [ ] **Step 1: Write failing API tests**

Add tests that create and patch a merchant with `primary_location` and `website_url`, then assert both fields are returned. Add a run test that captures the real `FakeCoreAi.triggered` input and asserts it contains the merchant name, location, website, the phrase `United States local SEO`, and an instruction to return dated Plan JSON.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_merchants.py tests/test_runs_api.py -q`
Expected: failures because the merchant models/schema and diagnosis prompt do not yet support the fields or contract.

- [ ] **Step 3: Implement the minimal schema and prompt changes**

Add nullable `primary_location` and `website_url` columns to `merchants`, add both to `MIGRATION_COLUMNS`, accept them in create/patch Pydantic models, and build a structured diagnosis input from the stored merchant row. Do not make an external call from `POST /api/merchants`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `cd api && .venv/bin/python -m pytest tests/test_merchants.py tests/test_runs_api.py -q`
Expected: all focused tests pass.

### Task 2: Plan approval persistence and task gate

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Modify: `api/app/runs.py`
- Modify: `api/app/tasks.py`
- Test: `api/tests/test_runs_api.py`
- Test: `api/tests/test_tasks.py`

**Interfaces:**
- Produces: `POST /api/runs/{run_id}/approve-plan -> Run`; `Run.plan_approved_at: string | null`.
- Enforces: a task with `source_run_id` can enter `doing` only when its source Run has a non-null `plan_approved_at`.

- [ ] **Step 1: Write failing approval and gate tests**

Cover: rejecting approval for a running/failed Run; rejecting approval when a successful Run has no generated tasks; successful idempotent approval for a successful Run with tasks; rejecting single and batch starts before approval; allowing both after approval; leaving manual tasks unaffected.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_runs_api.py tests/test_tasks.py -q`
Expected: route missing and unapproved generated tasks still start.

- [ ] **Step 3: Implement approval and shared gate**

Add nullable `plan_approved_at` to `runs`. During migration only, backfill existing succeeded Runs to `COALESCE(finished_at, created_at)`. Add an idempotent approve route and a shared `can_start_task(conn, task)` check used by both patch and batch transitions.

- [ ] **Step 4: Run focused and complete backend suites**

Run: `cd api && .venv/bin/python -m pytest tests/test_runs_api.py tests/test_tasks.py -q`
Run: `cd api && .venv/bin/python -m pytest tests -q`
Expected: all tests pass.

### Task 3: New merchant creation starts diagnosis

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantList.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `api.createMerchant`, `api.createRun`, React Router navigation.
- Produces: a concise three-field create form and automatic navigation to the created merchant whether diagnosis starts or fails.

- [ ] **Step 1: Write failing UI tests**

Add one test proving the create form is hidden behind `新建商户`, collects name/location/website, calls `POST /api/merchants` before `POST /api/merchants/{id}/runs`, and navigates to the merchant workspace. Add a failure fixture proving diagnosis failure still navigates to the persisted merchant.

- [ ] **Step 2: Run the test and verify RED**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: the new fields and automatic diagnosis request are absent.

- [ ] **Step 3: Implement minimal create interaction**

Extend TypeScript merchant types and APIs. Replace the always-visible inline create form with a `新建商户` button and expanded form. On submit, create the merchant, attempt `createRun`, then navigate to `/merchants/{id}` with a short navigation-state notice on failure.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: focused UI tests pass.

### Task 4: Merchant diagnosis status and Plan confirmation

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/pages/MerchantDetail.tsx`
- Modify: `web/src/pages/RunDetail.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: latest `Run`, tasks whose `source_run_id` matches that Run, `api.approvePlan(runId)`.
- Produces: a single `初始诊断` status card on the merchant page and a `确认 Plan` action on the report page.

- [ ] **Step 1: Write failing UI tests**

Cover the five merchant states: no Run, running, failed, succeeded/unapproved, succeeded/approved. Assert only one next action is primary. Add a report test that approves a Plan and changes its UI to `Plan 已确认`.

- [ ] **Step 2: Run the test and verify RED**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: onboarding status and Plan approval controls are absent.

- [ ] **Step 3: Implement the concise UI**

Add a compact diagnostic card above the existing analysis history. Keep report content primary; put Plan status and confirmation above the existing generated-task side list. Do not add a progress timeline, wizard, Agent badges, or technical state grid.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd web && npm test -- --run App.test.tsx`
Expected: all App tests pass.

### Task 5: Full verification and local handoff

**Files:**
- Modify only if verification exposes a tested defect.

**Interfaces:**
- Produces: a locally runnable, source-backed new-merchant diagnosis and Plan approval demo.

- [ ] **Step 1: Run all quality gates**

Run: `cd api && .venv/bin/python -m pytest tests -q`
Run: `cd web && npm test`
Run: `cd web && npm run lint`
Run: `cd web && npm run build`
Expected: every command exits 0 without new warnings.

- [ ] **Step 2: Run local services and read back behavior**

Start FastAPI on port 8000 and Vite on port 5173 using the existing repo instructions. Create a test merchant in the UI, verify the merchant persists, verify the diagnosis request appears in the Run list, and verify Plan confirmation changes `plan_approved_at` through an API readback.

- [ ] **Step 3: Review the diff boundary**

Run: `git status --short` and `git diff --check`. Confirm no files under Core AI or FBR Project changed and preserve `docs/evidence/`.

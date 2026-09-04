# Audit Phase 3 Report Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agency operators a clear, compact location-level Audit workspace that keeps the last accepted report visible while showing execution state, evidence, history, comparison, policy, and export/Plan capabilities without stretching the merchant page indefinitely.

**Architecture:** Add a merchant-level summary and a dedicated routed workspace. `AuditWorkspace.tsx` owns URL/request orchestration; server DTOs remain discriminated in `auditTypes.ts`; pure labels/filter/delta logic lives in `auditPresentation.ts`; focused Audit components render a fixed-height instrument-panel layout. The desktop context rail becomes an accessible drawer below 1180 CSS px, and all long content scrolls inside the workspace rather than forcing page-level horizontal overflow.

**Tech Stack:** React 19, TypeScript 6, React Router 7, Vitest, Testing Library, plain CSS using the existing SEO Ops tokens.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Complete Phase 2 read APIs before wiring live UI. Tests may use fixtures first, but production code must not fabricate response fields.
- Preserve `web/src/components/AuditReport.tsx` and `/runs/:id` as the v1 compatibility view; do not mutate it into the v2 workspace.
- The product is an internal agency operations console, not a merchant-facing SaaS dashboard. Optimize for scanning, evidence review, and explicit operational decisions.
- Use server capability flags and reason codes. Never infer compare/export/Plan availability from `version_kind` in the browser.
- An active Run coexists with the last accepted Version. Never clear the report or display zero scores while a new Audit is running or fails.
- `unscored_legacy` is a distinct read-only state. Hide score/Grade/dimension/delta affordances rather than rendering dashes that look like zeros.
- Only poll when `poll_after_ms` is non-null. Use a one-shot timer, reuse the same manual request ID after an uncertain browser response, and stop at terminal or unknown.
- Do not introduce a UI framework, chart library, generic dashboard card kit, gradient decoration, or per-row hover animation.

## Visual Direction

The workspace should read like an evidence review instrument: a calm paper-white report surface, dark ink hierarchy, a single restrained cobalt selection line, and severity colors used only where they carry meaning.

**Palette:**

- `--audit-paper: #FCFDFE` — accepted report surface;
- `--audit-ink: #173047` — primary text and structural rules;
- `--audit-muted: #60778B` — metadata and secondary labels;
- `--audit-line: #CBD8E2` — section boundaries;
- `--audit-focus: #1F6F98` — selected dimension, links, and focus ring;
- existing semantic green/amber/red remain reserved for good/warning/critical states.

**Type:** Keep the repository's current system sans stack for language coverage and demo stability. Use tabular numerals for scores, coverage, dates, and versions; use weight and size—not letter-spaced all-caps eyebrows—to establish hierarchy.

**Layout:** Left-align all report content. The memorable element is the continuous scored Criterion ledger: a narrow colored score rail runs through rows and connects the high-level dimension filter to evidence details. Surrounding controls remain quiet and rectilinear.

```text
┌ identity / accepted version / run state ───────── actions ┐
├ score | grade | delta | high risk | evidence coverage ───┤
├────────────── fixed workbench viewport ───────────────────┤
│ dimensions │ criterion ledger              │ context      │
│ + priority │ score rail / finding / action │ changes      │
│ filters    │ evidence count                │ selection    │
│ scroll     │ scroll                        │ scope        │
└────────────┴───────────────────────────────┴──────────────┘
```

At narrow widths, dimensions become a horizontal filter strip and context opens as a drawer. This direction intentionally avoids a stack of identical rounded cards and decorative eyebrow labels: borders, rails, and badges exist only to encode report structure or state.

---

## Task 1: Add strict frontend Audit DTOs and structured API errors

**Files:**

- Create: `web/src/auditTypes.ts`
- Create: `web/src/testAuditFixtures.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/api.test.ts`

**Interfaces:**

```ts
export class ApiError extends Error {
  status: number
  code: string | null
  context: Record<string, unknown>
}

export type AuditCapability = { enabled: boolean; reason_code: string | null }
export type AuditVersionDetail = NativeAuditVersion | AdaptedAuditVersion | LegacyAuditVersion
export type AuditOverview = {
  subject: AuditSubject
  policy: AuditPolicy
  active_run: AuditRunSummary | null
  latest_terminal_run: AuditRunSummary | null
  latest_version: AuditVersionDetail | null
  capabilities: AuditCapabilities
}
```

- [ ] Add failing tests proving `request()` preserves status/code/message/context for structured errors and still handles existing string details.
- [ ] Define exhaustive literal unions for Run, Attempt, Version kind, score status, applicability, severity, scope, capability reason, Export state, and comparison state. Use a discriminated union so legacy payload cannot be passed to canonical KPI components.
- [ ] Add one fixture per state: scored, incomplete, unscored legacy, no Version with active Run, blocked-only, failed-only, unknown-only, identity generation changed, and capability-disabled.
- [ ] Add API methods for merchant subjects, overview, manual Run, Run read/events/retry/reconcile/abandon, policy update, Version list/detail/compare, assets, alerts, Export commands/status/download, and Plan selection status. Export and Plan methods can remain unused until their backend phases land.
- [ ] Add `requestBlob()` that preserves `Content-Disposition`, MIME, and structured errors without setting a JSON `Content-Type` on GET.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/web
npm test -- src/api.test.ts
npm run lint
```

- [ ] Commit as `feat: add typed audit api client` when green.

## Task 2: Extract accessible help and status primitives

**Files:**

- Create: `web/src/components/FieldHelp.tsx`
- Create: `web/src/components/AuditStatusBadge.tsx`
- Modify: `web/src/pages/MerchantProfile.tsx`
- Modify: `web/src/index.css`
- Modify: `web/src/App.test.tsx`

- [ ] Move the existing `FieldHelp` copy and visual anchor out of `MerchantProfile.tsx`, while fixing its trigger/content relationship: allocate a stable `useId()` value, connect the button with `aria-describedby`/`aria-controls` while open, expose the nonmodal explanatory content as `role="tooltip"`, keep focus on the trigger, close on Escape/outside click, and leave focus on the trigger after close.
- [ ] Add an exhaustive `AuditStatusBadge` map for queued, blocked, dispatching, running, validating, unknown, succeeded, failed, and abandoned. Active states alone receive one breathing dot; add `@media (prefers-reduced-motion: reduce)` to make it static.
- [ ] Add unit/integration tests for every label, stable unknown/failure wording, stable help IDs/ARIA relationship, keyboard toggle, Escape, trigger focus retention, focus visibility, and reduced-motion class behavior.
- [ ] Keep shared primitives quiet: no shadow by default, one border radius tier for controls, and semantic color only for state.
- [ ] Run:

```bash
npm test -- src/App.test.tsx
npm run lint
```

- [ ] Commit as `refactor: share field help and audit status` when green.

## Task 3: Add Audit routes, merchant navigation, and per-location summary

**Files:**

- Create: `web/src/components/audit/MerchantAuditSummary.tsx`
- Create: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/components/MerchantSectionNav.tsx`
- Modify: `web/src/pages/MerchantDetail.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

- [ ] Add failing route tests for `/merchants/:id/audits` and `/merchants/:id/audits/:subjectId`, a “审计报告” merchant-nav item, active navigation state, and selection of the first exact active Subject when the subject ID is omitted.
- [ ] Add merchant summary tests for multiple locations, latest scored, incomplete, unscored legacy, active+latest, failed+latest, never-success, shared-risk deduplication, next scheduled time, and archived Subject.
- [ ] Insert `MerchantAuditSummary` after the merchant operations KPI strip and before generic AI analysis. Each row shows location identity, report state/time, high-risk/delta only when supported, active status, policy cadence/next due, and one explicit “进入 Audit 工作区” action.
- [ ] Keep location ordering stable: active before archived, then display name and Subject ID. Do not compute a merchant total score.
- [ ] Extend `MerchantSectionNav` with `active: 'operations' | 'profile' | 'audit'` and add the two routes to `App.tsx`. Keep the sidebar Merchant section active for both.
- [ ] Create the routed `AuditWorkspace` shell in this task with authenticated loading, Subject-not-found, and selected-Subject identity states so route tests/build pass. Task 4 replaces its body with the full report workbench.
- [ ] Run:

```bash
npm test -- src/App.test.tsx
npm run lint
```

- [ ] Commit as `feat: add merchant audit summary and routes` when green.

## Task 4: Build the fixed-height report workbench and all truth states

**Files:**

- Modify: `web/src/pages/AuditWorkspace.tsx`
- Create: `web/src/pages/AuditWorkspace.test.tsx`
- Create: `web/src/auditPresentation.ts`
- Create: `web/src/auditPresentation.test.ts`
- Create: `web/src/components/audit/AuditWorkspaceHeader.tsx`
- Create: `web/src/components/audit/AuditRunStatus.tsx`
- Create: `web/src/components/audit/AuditKpiStrip.tsx`
- Create: `web/src/components/audit/AuditDimensionRail.tsx`
- Create: `web/src/components/audit/AuditCriterionList.tsx`
- Create: `web/src/components/audit/AuditCriterionRow.tsx`
- Create: `web/src/components/audit/AuditContextContent.tsx`
- Create: `web/src/audit.css`
- Modify: `web/src/App.tsx`
- Modify: `web/src/index.css`

**Pure presentation interfaces:**

```ts
export function formatAuditScore(version: AuditVersionDetail): string | null
export function capabilityMessage(reasonCode: string | null): string
export function selectCriteria(report: CanonicalAuditReport,
  filter: AuditCriterionFilter): AuditCriterion[]
export function groupComparison(delta: AuditComparison): AuditComparisonGroups
```

- [ ] Add pure tests for score/Grade/coverage formatting, no-zero legacy behavior, priority/dimension/category filters, score/NA rendering, shared-scope labels, capability messages, and new/persistent/resolved/uncomparable comparison groups.
- [ ] Add page tests for the nine fixtures from Task 1. Assert that active Run preserves the prior Version; `latest_terminal_run` makes blocked/failed-only states and actions discoverable; incomplete hides Grade; legacy hides KPI/dimension/Plan controls; failure shows a short actionable summary; and raw JSON/Pydantic/Trace text never appears.
- [ ] Render the header with frozen location identity, accepted Version, trigger/time/Rubric, manual Audit, policy, and export controls. Render KPI values as a continuous strip, not five disconnected cards.
- [ ] Render dimensions from the frozen rubric response, never from a hardcoded list. Default to priority issues; allow dimension/all filters without refetching the immutable Version.
- [ ] Render each Criterion as a compact disclosure row with score rail, category, severity, title/ID, score or explicit applicability, Evidence count, delta status, and shared-scope marker. Only priority findings start expanded; observation and recommendation live in the `aria-expanded` disclosure body, while long Evidence remains in the drawer. Preserve expansion state by Criterion ID while filtering.
- [ ] Wrap routed content in `App.tsx` with `.workspace-content`, make `.workspace` a `100dvh` grid with rows `66px minmax(0, 1fr)`, and give the Audit page its own `grid-template-rows: auto auto minmax(0, 1fr)`. The variable-height Audit header/status/KPI occupy auto rows; only the workbench row consumes remaining space. Apply internal `min-height: 0` and `overflow: auto` to each column so no guessed pixel offset is needed.
- [ ] Import `audit.css` from the workspace module and keep selectors under `.audit-workspace` to avoid changing unrelated pages.
- [ ] Run:

```bash
npm test -- src/auditPresentation.test.ts src/pages/AuditWorkspace.test.tsx
npm run lint
npm run build
```

- [ ] Commit as `feat: add audit report workbench` when green.

## Task 5: Add Evidence drawer, history, and Version comparison

**Files:**

- Create: `web/src/components/audit/AuditDetailDrawer.tsx`
- Create: `web/src/components/audit/AuditHistoryPanel.tsx`
- Create: `web/src/components/audit/AuditComparePanel.tsx`
- Modify: `web/src/components/audit/AuditCriterionList.tsx`
- Modify: `web/src/components/audit/AuditContextContent.tsx`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`
- Modify: `web/src/audit.css`

- [ ] Add tests for lazy Evidence metadata fetch, server-disabled preview/download with an explanation until Phase 5, no persistent external URL, cursor-based history pagination, selecting a historical Version, default frozen-base comparison, explicit-base comparison, not-comparable reasons, and generation-changed history.
- [ ] Implement a desktop right-hand context rail. Below 1180 CSS px, open the same content as `role="dialog" aria-modal="true"`; trap Tab/Shift+Tab, close on Escape or backdrop, restore focus to the invoking Criterion/control, and lock only background workspace scrolling.
- [ ] Display Evidence fact, source kind, captured time, freshness, safe reference, hash abbreviation, and Asset capability state. Phase 3 is metadata-only: preview/download controls stay disabled with the server reason until Phase 5 endpoints are enabled. Never embed untrusted HTML in the application origin.
- [ ] Keep history and compare in the same workbench. Selecting history updates `?version=<id>`; selecting an explicit comparison updates `?base=<id>` so reload/back navigation preserves the review state.
- [ ] Context defaults to “本次变化” when a compatible base exists and otherwise explains why no base is available. Resolved Criteria appear in comparison context without being injected into the target Version's Criterion list.
- [ ] Run:

```bash
npm test -- src/pages/AuditWorkspace.test.tsx
npm run lint
npm run build
```

- [ ] Commit as `feat: add audit evidence history and comparison` when green.

## Task 6: Wire manual Audit, policy status, Export shell, and disabled Plan capability

**Files:**

- Create: `web/src/components/audit/AuditExportDialog.tsx`
- Create: `web/src/components/audit/AuditPolicySummary.tsx`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`
- Modify: `web/src/audit.css`

- [ ] Add tests proving one random request ID is generated per manual action and retained across a network retry, a 409 active Run selects the returned active ID, and only a non-null `poll_after_ms` schedules the next one-shot read.
- [ ] Show progress for queued/dispatching/running/validating with start/last-confirmed time. Stop animation and polling for blocked/failed/unknown/abandoned/succeeded; unknown shows reconcile then guarded abandon, while failed/blocked shows explicit retry.
- [ ] Render the current policy as read-only cadence, timezone, next due, and disabled/active status from Overview. Until Phase 4 ships the optimistic policy endpoint, label editing as unavailable instead of issuing a request to a missing API.
- [ ] Add the Export dialog shell using server capabilities. PDF is the selected default; HTML/JSON are individually disabled with explanations until Phase 5 endpoints report enabled. Render queued/running/failed/ready states and expose download only when ready.
- [ ] Render a disabled “根据已选问题生成计划” capability summary for canonical content with the exact server reason `AUDIT_PLAN_SERVICE_UNVERIFIED`. Do not render Criterion selection checkboxes until Phase 6 enables the server capability, and do not call `/runs/:id/approve-plan`.
- [ ] Run:

```bash
npm test -- src/pages/AuditWorkspace.test.tsx src/App.test.tsx
npm test
npm run lint
npm run build
```

- [ ] Commit as `feat: wire audit workspace actions` when green.

## Task 7: Remove global overflow assumptions and perform visual/accessibility critique

**Files:**

- Modify: `web/src/index.css`
- Modify: `web/src/audit.css`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`
- Create: `docs/evidence/audit-workspace-visual-acceptance-2026-09-03.md`

- [ ] Remove global `body { min-width: 1180px; }`, rely on the `.workspace`/`.workspace-content` grid established in Task 4, and add route-owned overflow containers or responsive rules to every existing layout that previously relied on the global minimum. Preserve wide tables by scrolling only their table viewport.
- [ ] Add DOM behavior tests for ≥1180 three-column semantics, <1180 two-column+drawer semantics, and narrow single-column+horizontal-dimension-filter semantics. Treat these as behavior/class checks only; computed overflow and zoom acceptance must come from the real browser review below.
- [ ] Run the complete frontend suite/build before browser review.
- [ ] Use the local browser to capture and inspect Audit plus dashboard, merchant list/detail/profile, tasks list/detail, and legacy Run pages at 1440 CSS px, 1024 CSS px, and 200% zoom. Also test keyboard-only navigation, focus order/restoration, screen-reader names, Escape, reduced motion, long English/Chinese content, and long blocked/error status banners.
- [ ] Critique the screenshots against the Visual Direction: remove any decorative label, repeated container, redundant border, or color that does not encode identity, score, state, selection, or scope. Verify alignment baselines, 8/12/16/24 spacing rhythm, button hierarchy, and that the Criterion ledger—not generic cards—is the visual anchor.
- [ ] Record viewport, state, screenshot path, pass/fail, and exact corrections in `docs/evidence/audit-workspace-visual-acceptance-2026-09-03.md`.
- [ ] Re-run:

```bash
npm test
npm run lint
npm run build
```

- [ ] Commit the verified responsive polish and evidence as `fix: polish audit workspace responsiveness`.

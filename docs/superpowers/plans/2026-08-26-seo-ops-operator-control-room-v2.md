# SEO Ops Operator Control Room v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Connexup SEO Ops as an operator-first control room for 50–100 managed merchants, with a separate audit view and reconciled Core AI UAT specialist Agents.

**Architecture:** SEO Ops PostgreSQL remains the Task and business-state authority. New server-side projections compose existing Tasks, proposals, questionnaires, artifacts, attempts, reviews, cycle settings, and bindings into bounded operator views; React renders an operator-first four-navigation shell and progressively discloses audit state. Core AI UAT Agents are reconciled through existing HTTP APIs from versioned manifests in this repository; no Core AI or FBR Project source code changes are permitted.

**Tech Stack:** React 19, React Router 7, TypeScript 7, Vite 8, Vitest, Testing Library, Fastify 5, PostgreSQL, Zod 3, Core AI Agent/Run HTTP APIs.

**Spec:** `docs/superpowers/specs/2026-08-26-seo-ops-operator-control-room-v2-design.md`

## Global Constraints

- Modify product code only in `/Users/xander/git_repo/connexup-seo-ops`.
- Never modify `/Users/xander/git_repo/core-ai` or `/Users/xander/git_repo/fbr-project`; read-only contract inspection is allowed.
- Only create a missing Skill in `/Users/xander/git_repo/fbr-agent` after a manifest test proves no current Skill satisfies the contract.
- Copilot stays absent from both operator and audit UI.
- Operator UI never directly triggers specialist lifecycle-stage Runs.
- Planner/scheduler results remain proposals until a human adopts them; adoption is the only proposal-to-Task path.
- Core AI Run completion never marks an SEO Task complete.
- `OUTCOME_UNKNOWN` never exposes automatic retry.
- Production rendering uses backend data only; frontend demo tasks are removed.
- UAT Agent mutations require a dry-run diff, exact `[SEO Ops]` scope, publish/readback verification, and rollback evidence.
- Preserve unrelated `_to_delete/` and any user-owned dirty files.

---

### Task 1: Add the operator/audit view model and rebuild the application shell

**Files:**
- Create: `src/app/viewMode.ts`
- Create: `src/app/viewMode.test.ts`
- Modify: `src/app/AppShell.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Create: `src/styles/tokens.css`
- Create: `src/styles/base.css`
- Create: `src/styles/shell.css`
- Modify: `src/styles.css`

**Interfaces:**
- Produces: `type ViewMode = "operator" | "audit"`.
- Produces: `resolveViewMode(search: string, stored: string | null): ViewMode`.
- Produces: `writeViewMode(mode: ViewMode, storage: Pick<Storage, "setItem">): void`.
- Operator navigation: `工作台`, `商户`, `复盘`, `设置`.
- Audit navigation: `总览`, `商户`, `任务`, `运行`, `复盘`, `设置`.

- [ ] **Step 1: Write failing view-mode unit tests**

```ts
import { expect, test, vi } from "vitest";
import { resolveViewMode, writeViewMode } from "./viewMode";

test("operator mode is the default and audit query wins over storage", () => {
  expect(resolveViewMode("", null)).toBe("operator");
  expect(resolveViewMode("?view=audit", "operator")).toBe("audit");
  expect(resolveViewMode("?view=operator", "audit")).toBe("operator");
});

test("invalid query and storage values fail back to operator", () => {
  expect(resolveViewMode("?view=system", "admin")).toBe("operator");
});

test("view choice is persisted under one namespaced key", () => {
  const setItem = vi.fn();
  writeViewMode("audit", { setItem });
  expect(setItem).toHaveBeenCalledWith("seo-ops:view-mode", "audit");
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npm run test:run -- src/app/viewMode.test.ts`

Expected: FAIL because `viewMode.ts` does not exist.

- [ ] **Step 3: Implement the view-mode functions**

```ts
export type ViewMode = "operator" | "audit";
const STORAGE_KEY = "seo-ops:view-mode";

export function resolveViewMode(search: string, stored: string | null): ViewMode {
  const query = new URLSearchParams(search).get("view");
  if (query === "operator" || query === "audit") return query;
  return stored === "audit" ? "audit" : "operator";
}

export function writeViewMode(mode: ViewMode, storage: Pick<Storage, "setItem">) {
  storage.setItem(STORAGE_KEY, mode);
}
```

- [ ] **Step 4: Write failing shell behavior tests**

Add assertions to `src/App.test.tsx`:

```ts
test("operator shell exposes four human-facing destinations", async () => {
  renderApp("/");
  expect(await screen.findByRole("navigation", { name: "主导航" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "工作台" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "商户" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "复盘" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "运行" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Copilot/)).not.toBeInTheDocument();
});

test("audit view reveals the six-ledger navigation", async () => {
  renderApp("/?view=audit");
  expect(await screen.findByRole("link", { name: "总览" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "任务" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "运行" })).toBeInTheDocument();
});
```

- [ ] **Step 5: Run shell tests and verify RED**

Run: `npm run test:run -- src/App.test.tsx`

Expected: FAIL because the current shell always renders six entries and has no view selector.

- [ ] **Step 6: Implement the shell and route compatibility**

Refactor `AppShell` into small constants for operator and audit navigation. Add an accessible segmented control named `视角` with `操作员` and `管理审计`. Preserve the current merchant switcher and logout. Keep `/tasks/:taskId`, `/reports`, `/inbox`, and `/runs` routes valid; navigation visibility changes, not route authorization.

Use this shell structure:

```tsx
<div className={`app-shell view-${mode}`}>
  <aside className="sidebar">...</aside>
  <div className="workspace">
    <header className="topbar">
      <MerchantSwitcher ... />
      <ViewModeSwitch value={mode} onChange={changeMode} />
      <OperatorIdentity />
    </header>
    <main className="main-content"><Outlet context={{ mode }} /></main>
  </div>
</div>
```

- [ ] **Step 7: Establish the CSS token system**

Define the approved tokens in `tokens.css`:

```css
:root {
  --paper: #f3f6f8;
  --surface: #ffffff;
  --ink: #183247;
  --ink-muted: #657b8e;
  --rule: #cfd9e1;
  --amber: #b96b08;
  --teal: #167d7a;
  --cyan: #167d9a;
  --red: #c44444;
  --font-body: "Avenir Next", "PingFang SC", "Helvetica Neue", system-ui, sans-serif;
  --font-data: "SFMono-Regular", "SF Mono", "Roboto Mono", monospace;
}
```

Make `styles.css` import the split files and retain untouched page rules until later tasks migrate them.

- [ ] **Step 8: Verify and commit Task 1**

Run:

```bash
npm run test:run -- src/app/viewMode.test.ts src/App.test.tsx
npm run build
git diff --check
```

Commit:

```bash
git add src/app src/App.tsx src/App.test.tsx src/styles.css src/styles
git commit -m "feat(ui): add operator-first application shell"
```

---

### Task 2: Build the bounded human-action workbench projection

**Files:**
- Create: `server/src/services/workbenchService.ts`
- Create: `server/src/routes/workbenchRoutes.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/repos/taskRepo.ts`
- Modify: `server/src/repos/proposalRepo.ts`
- Modify: `server/src/repos/questionnaireRepo.ts`
- Create: `server/tests/workbench.test.ts`
- Modify: `src/api/types.ts`
- Modify: `src/api/seoOpsApi.ts`

**Interfaces:**
- Produces: `GET /api/seo-ops/workbench?group=&merchant_id=&q=&offset=&limit=`.
- Produces: `WorkbenchView { summary, items, offset, limit, total }`.
- `HumanActionGroup = "GATEKEEPING" | "EXCEPTION" | "MERCHANT_CONTACT"`.
- `HumanActionType = "PROPOSAL_DECISION" | "GATE_1_APPROVAL" | "GATE_2_CONFIRM" | "OUTCOME_RECONCILIATION" | "VERIFICATION_OVERDUE" | "CONFIRMED_FAILURE" | "QUESTIONNAIRE_FOLLOWUP" | "AUTHORIZATION_FOLLOWUP" | "CONTENT_CONFIRMATION" | "REPORT_DELIVERY"`.

- [ ] **Step 1: Write failing projection authorization and grouping tests**

Create `server/tests/workbench.test.ts` with a real test app/database fixture. Seed two merchants assigned to different operators, one pending proposal, one approval-ready Task, one `OUTCOME_UNKNOWN` attempt, and one sent questionnaire.

```ts
it("groups only the authenticated operator's human actions", async () => {
  const response = await app.inject({ method: "GET", url: "/api/seo-ops/workbench", cookies: operatorCookie });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.summary).toEqual({ gatekeeping: 2, exception: 1, merchant_contact: 1, total: 4 });
  expect(body.items.map((item: { group: string }) => item.group)).toEqual([
    "EXCEPTION", "GATEKEEPING", "GATEKEEPING", "MERCHANT_CONTACT",
  ]);
  expect(body.items.every((item: { merchant_id: string }) => item.merchant_id === merchantA.id)).toBe(true);
});

it("paginates before returning rows and rejects an invalid group", async () => {
  const page = await app.inject({ method: "GET", url: "/api/seo-ops/workbench?offset=1&limit=2", cookies: operatorCookie });
  expect(page.json()).toMatchObject({ offset: 1, limit: 2, total: 4 });
  const invalid = await app.inject({ method: "GET", url: "/api/seo-ops/workbench?group=RUNNING", cookies: operatorCookie });
  expect(invalid.statusCode).toBe(400);
});
```

- [ ] **Step 2: Run the workbench test and verify RED**

Run: `cd server && npm test -- tests/workbench.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Add repository queries with stable ordering**

Add scoped list functions that return only the fields required by the projection. Use SQL ordering:

```sql
ORDER BY
  CASE severity WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
  COALESCE(due_at, created_at),
  id
```

Proposal rows must come only from `PENDING` and `VALIDATION_FAILED`. Task rows must not infer proposal status from `proposal_id`; they remain separate records.

- [ ] **Step 4: Implement `workbenchService`**

Use one normalized internal record:

```ts
export interface HumanAction {
  id: string;
  group: HumanActionGroup;
  type: HumanActionType;
  merchantId: string;
  merchantName: string;
  locationName: string | null;
  title: string;
  reason: string;
  primaryAction: { label: string; href: string };
  secondaryHref: string | null;
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  dueAt: string | null;
  waitingSince: string;
}
```

Map enums to plain-language reasons server-side so every client receives the same action semantics. Never include secrets, task execution payloads, or full Agent output.

- [ ] **Step 5: Register the route and frontend client types**

Add Zod query validation with `offset` default 0 and `limit` default 50, maximum 100. Add:

```ts
workbench: (request: WorkbenchRequest = {}, signal?: AbortSignal) =>
  requestJson<WorkbenchView>(`/api/seo-ops/workbench${query(request)}`, { signal })
```

- [ ] **Step 6: Verify and commit Task 2**

Run:

```bash
cd server
npm test -- tests/workbench.test.ts tests/authorization.test.ts tests/queryService.test.ts
npm run typecheck
cd ..
npm run build
git diff --check
```

Commit:

```bash
git add server/src server/tests/workbench.test.ts src/api
git commit -m "feat(workbench): project human action queues"
```

---

### Task 3: Replace the overview with the operator workbench UI

**Files:**
- Create: `src/features/workbench/WorkbenchPage.tsx`
- Create: `src/features/workbench/WorkbenchPage.test.tsx`
- Create: `src/features/workbench/DecisionSummary.tsx`
- Create: `src/features/workbench/ActionQueue.tsx`
- Create: `src/features/workbench/actionCopy.ts`
- Modify: `src/features/overview/OverviewPage.tsx`
- Modify: `src/App.tsx`
- Create: `src/styles/ledger.css`
- Modify: `src/styles.css`

**Interfaces:**
- `/` renders `WorkbenchPage` in operator mode.
- `/?view=audit` renders the existing portfolio ledger as `OverviewPage`.
- `ActionQueue` accepts `items: HumanActionWire[]` and never derives status from CSS classes.

- [ ] **Step 1: Write failing operator workbench tests**

```tsx
test("workbench groups human actions and gives each row one primary action", async () => {
  renderApp("/");
  expect(await screen.findByRole("heading", { name: "今天需要我处理" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "例外" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "把关" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "商户联络" })).toBeInTheDocument();
  const row = screen.getByRole("article", { name: /Choice Brooklyn UWS.*结果不确定/ });
  expect(within(row).getAllByRole("button")).toHaveLength(1);
  expect(within(row).getByRole("button", { name: "去查证" })).toBeInTheDocument();
});

test("empty workbench explains the next automated windows without demo tasks", async () => {
  workbenchData = { summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 50, total: 0 };
  renderApp("/");
  expect(await screen.findByText("今天没有需要人工处理的事项")).toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:run -- src/features/workbench/WorkbenchPage.test.tsx src/App.test.tsx`

Expected: FAIL because the new workbench does not exist.

- [ ] **Step 3: Implement the workbench components**

Render compact summary cells as buttons, then grouped rows with a semantic decision rail:

```tsx
<article aria-label={`${item.merchant_name} ${item.reason}`} className={`action-row group-${item.group.toLowerCase()}`}>
  <span className="decision-rail" aria-hidden />
  <div className="action-copy"><strong>{item.title}</strong><p>{item.reason}</p></div>
  <span className="merchant-context">{item.merchant_name}<small>{item.location_name}</small></span>
  <time>{formatWaiting(item.waiting_since)}</time>
  <button onClick={() => navigate(item.primary_action.href)}>{item.primary_action.label}</button>
</article>
```

Do not render enum badges in operator mode. Expose the enum in an accessible `技术状态` description only in audit mode.

- [ ] **Step 4: Preserve the audit overview**

Keep the existing portfolio metrics/table under `/?view=audit`. Change its eyebrow to `PORTFOLIO LEDGER / 管理审计` and remove any copy suggesting it is the default operator page.

- [ ] **Step 5: Implement approved ledger styling**

Use white surfaces, 1 px rules, 36–44 px rows, 0–4 px radii, and decision-rail colors. Summary cells must read as filters, not generic elevated KPI cards. Add reduced-motion and `:focus-visible` rules.

- [ ] **Step 6: Verify and commit Task 3**

Run:

```bash
npm run test:run -- src/features/workbench/WorkbenchPage.test.tsx src/App.test.tsx
npm run build
git diff --check
```

Commit:

```bash
git add src/features/workbench src/features/overview src/App.tsx src/styles.css src/styles/ledger.css src/App.test.tsx
git commit -m "feat(workbench): add operator decision control room"
```

---

### Task 4: Add merchant cycle-ledger and Post-program projections

**Files:**
- Create: `server/src/services/merchantControlRoomService.ts`
- Create: `server/src/routes/merchantControlRoomRoutes.ts`
- Modify: `server/src/index.ts`
- Modify: `server/src/repos/proposalRepo.ts`
- Modify: `server/src/repos/taskRepo.ts`
- Modify: `server/src/repos/specialistArtifactRepo.ts`
- Create: `server/tests/merchantControlRoom.test.ts`
- Modify: `src/api/types.ts`
- Modify: `src/api/seoOpsApi.ts`

**Interfaces:**
- Produces: `GET /api/seo-ops/merchants/:id/cycle-ledger`.
- Produces: `GET /api/seo-ops/merchants/:id/post-program`.
- `CycleLedgerItem.record_kind` is exactly `TASK` or `PROPOSAL`.
- `PostProgramView` contains nullable `voice_profile`, real `cluster_signals`, `history`, and `proposals`; absence is explicit through `evidence_gaps`.

- [ ] **Step 1: Write failing cycle-ledger tests**

```ts
it("keeps accepted tasks and pending proposals distinct in one dated ledger", async () => {
  const response = await app.inject({ method: "GET", url: `/api/seo-ops/merchants/${merchant.id}/cycle-ledger`, cookies: operatorCookie });
  expect(response.statusCode).toBe(200);
  expect(response.json().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ record_kind: "TASK", task_id: adoptedTask.id, proposal_id: adoptedProposal.id }),
    expect.objectContaining({ record_kind: "PROPOSAL", task_id: null, proposal_id: pendingProposal.id }),
  ]));
});

it("does not manufacture a voice profile or performance signal", async () => {
  const response = await app.inject({ method: "GET", url: `/api/seo-ops/merchants/${merchant.id}/post-program`, cookies: operatorCookie });
  expect(response.json()).toMatchObject({ voice_profile: null, cluster_signals: [], history: [] });
  expect(response.json().evidence_gaps).toContain("VOICE_PROFILE_MISSING");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd server && npm test -- tests/merchantControlRoom.test.ts`

Expected: FAIL with both routes missing.

- [ ] **Step 3: Implement the cycle-ledger projection**

Load active-cycle Tasks and proposal batches for the merchant. Exclude adopted proposals from the proposal row set when their Task is already present. Sort by `due_at`, then `created_at`, then stable ID. Include dependency labels and validation errors without interpreting an unadopted proposal as executable.

- [ ] **Step 4: Implement the Post-program projection**

Read only persisted artifacts and Tasks:

- voice profile: latest explicit brand/voice artifact if present;
- cluster signals: latest effect-review or keyword-weekly artifact;
- history: GBP Post Tasks with both publication and verification state;
- proposals: unadopted GBP Post proposal items;
- gaps: exact missing artifact categories.

Validate artifact payload shapes with Zod. Invalid legacy artifacts are ignored and surfaced as `INVALID_*_ARTIFACT` gaps; they never become generated UI facts.

- [ ] **Step 5: Add routes and frontend types**

```ts
cycleLedger: (merchantId: string, signal?: AbortSignal) =>
  requestJson<CycleLedgerView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/cycle-ledger`, { signal }),
postProgram: (merchantId: string, signal?: AbortSignal) =>
  requestJson<PostProgramView>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/post-program`, { signal }),
```

- [ ] **Step 6: Verify and commit Task 4**

Run:

```bash
cd server
npm test -- tests/merchantControlRoom.test.ts tests/specialistAdapters.test.ts tests/authorization.test.ts
npm run typecheck
cd ..
npm run build
git diff --check
```

Commit:

```bash
git add server/src server/tests/merchantControlRoom.test.ts src/api
git commit -m "feat(merchant): add cycle and Post program projections"
```

---

### Task 5: Rebuild the merchant page as a dated control room

**Files:**
- Modify: `src/features/merchant/MerchantWorkspacePage.tsx`
- Create: `src/features/merchant/MerchantWorkspacePage.test.tsx`
- Create: `src/features/merchant/CurrentActionCard.tsx`
- Create: `src/features/merchant/CycleLedger.tsx`
- Create: `src/features/merchant/ReportsDataPanel.tsx`
- Create: `src/features/merchant/PostProgramPanel.tsx`
- Create: `src/features/merchant/MerchantAuditTools.tsx`
- Modify: `src/features/merchant/lifecycleCopy.ts`
- Create: `src/styles/merchant.css`
- Modify: `src/styles.css`

**Interfaces:**
- Operator mode consumes lifecycle, cycle ledger, artifacts/reports, and Post program.
- Audit mode alone may render `MerchantAuditTools` with direct diagnostic Stage Run controls.
- `CurrentActionCard` accepts one derived `MerchantNextAction` and renders one primary action.

- [ ] **Step 1: Write failing merchant behavior tests**

```tsx
test("operator merchant page leads with one action and never exposes direct specialist runs", async () => {
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "等待商家回复" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重发问卷" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /运行关键词 Agent/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /触发 Audit/ })).not.toBeInTheDocument();
});

test("proposal rows are muted and link to judgment without pretending to be tasks", async () => {
  renderApp("/merchants/keke");
  const proposal = await screen.findByRole("row", { name: /执行 GBP \+ 官网双审计.*建议待判定/ });
  expect(proposal).toHaveAttribute("data-record-kind", "PROPOSAL");
  expect(within(proposal).getByRole("link", { name: "去判定" })).toHaveAttribute("href", expect.stringContaining("tab=proposals"));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:run -- src/features/merchant/MerchantWorkspacePage.test.tsx`

Expected: FAIL because the current page exposes Stage Run cards and has no cycle-ledger semantics.

- [ ] **Step 3: Split and simplify the merchant page**

Keep the lifecycle rail. Replace operator-facing `StageRunCard` with `CurrentActionCard`. Load ledger and Post program through the new APIs. Use `MerchantAuditTools` only when `useOutletContext<{ mode: ViewMode }>().mode === "audit"`.

- [ ] **Step 4: Implement the dated cycle ledger**

Render date/time, title, wave/dependency, owner/mode, status, and one action. Use `<table>` at desktop and labeled rows below 900 px. Proposal rows use `data-record-kind="PROPOSAL"`, subdued surface, and the label `建议待判定`.

- [ ] **Step 5: Implement reports/data and Post program**

Show real freshness, source, version, and links. The Post panel displays type, voice version, target cluster, evidence signal, coverage, publication, and verification. If data is missing, show the corresponding `evidence_gaps` with a link to the relevant action; never synthesize example topics.

- [ ] **Step 6: Verify and commit Task 5**

Run:

```bash
npm run test:run -- src/features/merchant/MerchantWorkspacePage.test.tsx src/features/merchant/planItems.test.ts
npm run build
git diff --check
```

Commit:

```bash
git add src/features/merchant src/styles/merchant.css src/styles.css
git commit -m "feat(merchant): rebuild the dated operator control room"
```

---

### Task 6: Rebuild task detail around one decision and progressive audit disclosure

**Files:**
- Modify: `src/features/tasks/TaskPage.tsx`
- Modify: `src/features/tasks/ApprovalPanel.tsx`
- Modify: `src/features/tasks/ExecutionPanel.tsx`
- Modify: `src/features/tasks/DraftsPanel.tsx`
- Modify: `src/features/tasks/SpecialistArtifactsPanel.tsx`
- Create: `src/features/tasks/TaskDecisionHero.tsx`
- Create: `src/features/tasks/TechnicalDetails.tsx`
- Create: `src/features/tasks/ReconciliationDialog.tsx`
- Create: `src/features/tasks/ReconciliationDialog.test.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/app/statusCopy.ts`
- Create: `src/styles/task.css`
- Modify: `src/styles.css`

**Interfaces:**
- `TaskDecisionHero` receives `TaskDetail` and one permission-aware action descriptor.
- `TechnicalDetails` contains `rev`, `state_version`, `spec_hash`, attempts, Runs, traces, receipts, and event timeline in a collapsed `<details>`.
- Reconciliation API values remain exactly `NOT_HAPPENED` and `HAPPENED`; the operator labels are `确认未发生，可重新排队` and `确认已发生，进入核验`.

- [ ] **Step 1: Write failing operator-first task tests**

```tsx
test("task page presents one decision before technical state", async () => {
  renderApp("/tasks/task-1");
  expect(await screen.findByRole("heading", { name: "现在需要批准当前版本" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批准当前版本" })).toBeInTheDocument();
  expect(screen.getByText("批准不会立即发布")).toBeInTheDocument();
  expect(screen.getByText("技术详情（审计）").closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByText("sha256:abc123")).not.toBeVisible();
});
```

- [ ] **Step 2: Write failing reconciliation tests**

```tsx
test("unknown outcome offers two equal human conclusions and no retry", async () => {
  render(<ReconciliationDialog attempt={unknownAttempt} onClose={vi.fn()} onResolved={vi.fn()} />);
  expect(screen.getByRole("button", { name: "确认未发生，可重新排队" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认已发生，进入核验" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /自动重试|立即重试/ })).not.toBeInTheDocument();
});
```

- [ ] **Step 3: Run tests and verify RED**

Run: `npm run test:run -- src/features/tasks/ReconciliationDialog.test.tsx src/App.test.tsx`

Expected: FAIL because the components and hierarchy do not exist.

- [ ] **Step 4: Implement decision descriptors**

Add a pure mapping in `statusCopy.ts`:

```ts
export interface TaskDecisionDescriptor {
  heading: string;
  consequence: string;
  actionLabel: string | null;
  actionKind: "APPROVE" | "CONFIRM" | "VERIFY" | "RECONCILE" | "CONTACT" | "VIEW" | null;
}
```

Map each actionable state explicitly. Do not derive action kind from display text.

- [ ] **Step 5: Implement progressive disclosure and reconciliation**

Put the artifact/draft and action above the fold. Move technical state into `<TechnicalDetails>`. Reuse the existing outcome-resolution endpoint from `seoOpsApi.resolveOutcome` and require evidence plus a selected conclusion before enabling the final button.

- [ ] **Step 6: Preserve double-gate semantics**

Change operator copy to `批准当前版本` and `确认现在发布`. Keep server-side preview/confirm endpoints and permission checks unchanged. Render all gate checks only in audit mode; operator mode shows the first actionable failure or `校验通过`.

- [ ] **Step 7: Verify and commit Task 6**

Run:

```bash
npm run test:run -- src/features/tasks/ReconciliationDialog.test.tsx src/App.test.tsx src/features/tasks/SpecialistArtifactsPanel.test.tsx
npm run build
git diff --check
```

Commit:

```bash
git add src/features/tasks src/app/statusCopy.ts src/App.test.tsx src/styles/task.css src/styles.css
git commit -m "feat(tasks): focus task detail on human decisions"
```

---

### Task 7: Complete review, settings, and audit-only operational ledgers

**Files:**
- Modify: `src/features/reviews/ReviewsPage.tsx`
- Modify: `src/features/runs/RunsPage.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`
- Create: `src/features/settings/SystemStatusPanel.tsx`
- Create: `src/features/settings/AgentBindingsPanel.tsx`
- Create: `src/features/settings/CapabilityMatrixPanel.tsx`
- Create: `src/features/settings/CadencePanel.tsx`
- Create: `src/features/settings/SettingsPage.test.tsx`
- Create: `src/styles/review-settings.css`
- Modify: `src/styles.css`

**Interfaces:**
- Operator settings contains capability, cadence, Agent binding, permissions, and system-status sections.
- Full Runs ledger remains route-addressable but is linked only in audit mode.
- Review conclusion labels are capped at the backend classification and never upgraded client-side.

- [ ] **Step 1: Write failing settings and review tests**

```tsx
test("operator settings contains the five operational sections", async () => {
  renderApp("/settings");
  for (const name of ["能力矩阵", "周期配置", "Agent 绑定", "用户与权限", "系统状态"]) {
    expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
  }
});

test("review keeps associative conclusions explicit", async () => {
  renderApp("/reviews");
  expect(await screen.findByText("关联观察，不代表因果")).toBeInTheDocument();
  expect(screen.queryByText(/证明.*导致/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npm run test:run -- src/features/settings/SettingsPage.test.tsx src/App.test.tsx`

Expected: FAIL because settings is not split into the approved operational sections.

- [ ] **Step 3: Split SettingsPage and place Run status under system status**

Reuse existing cycle, capability, and binding APIs. `SystemStatusPanel` summarizes worker/scheduler status, Run capacity, quota, and recent failures. Its `查看完整运行账本` link includes `?view=audit`.

- [ ] **Step 4: Refine review cards**

Order each card as baseline → action bundle → observed change → confounders → conclusion → next planning input. Keep technical evidence links available without visually implying causal proof.

- [ ] **Step 5: Verify and commit Task 7**

Run:

```bash
npm run test:run -- src/features/settings/SettingsPage.test.tsx src/App.test.tsx
npm run build
git diff --check
```

Commit:

```bash
git add src/features/settings src/features/reviews src/features/runs src/styles/review-settings.css src/styles.css
git commit -m "feat(settings): separate operator settings from audit ledgers"
```

---

### Task 8: Remove production demo data and validate 100-merchant density

**Files:**
- Delete: `src/features/inbox/demoTasks.ts`
- Delete: `src/features/inbox/DemoTaskDrawer.tsx`
- Modify: `src/features/inbox/InboxPage.tsx`
- Modify: `src/features/merchant/MerchantWorkspacePage.tsx`
- Modify: `src/App.test.tsx`
- Create: `src/features/workbench/workbenchScale.test.tsx`
- Modify: `src/test/fixtures.ts`
- Modify: `src/styles/base.css`
- Modify: `src/styles/ledger.css`

**Interfaces:**
- Production components accept only API wire records.
- Tests may generate 100 merchant fixtures through test-only builders.

- [ ] **Step 1: Write a failing no-demo and scale test**

```tsx
test("100 merchant names remain searchable while the workbench renders one page", async () => {
  portfolioData = portfolioWithMerchants(100);
  workbenchData = workbenchWithActions(107, { pageSize: 50 });
  renderApp("/");
  expect(await screen.findAllByRole("article", { name: /商户/ })).toHaveLength(50);
  expect(screen.getByText("显示 1–50 / 107")).toBeInTheDocument();
  await userEvent.type(screen.getByRole("searchbox", { name: "搜索商户或任务" }), "Merchant 087");
  expect(screen.getByText("Merchant 087")).toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm run test:run -- src/features/workbench/workbenchScale.test.tsx`

Expected: FAIL because production demo fallbacks still exist and pagination copy is absent.

- [ ] **Step 3: Remove production demo paths**

Delete imports, fallback decisions, drawers, and CSS selectors that reference demo tasks. Preserve any useful static data only inside test fixtures.

- [ ] **Step 4: Implement responsive density and accessibility**

Verify 50 rows fit without horizontal page overflow at 1440 px, while the queue itself may scroll. Below 900 px, convert tables to labeled rows. Add visible focus, non-color text labels, and reduced-motion rules.

- [ ] **Step 5: Verify and commit Task 8**

Run:

```bash
npm run test:run
npm run build
git diff --check
```

Commit:

```bash
git add -A src
git commit -m "refactor(ui): remove demo fallbacks and validate portfolio scale"
```

---

### Task 9: Version and test the complete SEO Ops Agent roster

**Files:**
- Create: `server/core-ai-agents/manifest.schema.json`
- Modify: `server/core-ai-agents/seo-ops-planner-v1.json`
- Modify: `server/core-ai-agents/seo-ops-questionnaire-draft-v1.json`
- Modify: `server/core-ai-agents/seo-ops-audit-report-v1.json`
- Modify: `server/core-ai-agents/seo-ops-execution-plan-v1.json`
- Modify: `server/core-ai-agents/seo-ops-ranking-report-v1.json`
- Retain: `server/core-ai-agents/seo-ops-keyword-set-v2.json`
- Create: `server/core-ai-agents/seo-ops-gbp-post-content-v1.json`
- Create: `server/core-ai-agents/seo-ops-effect-review-v1.json`
- Create: `server/core-ai-agents/seo-ops-report-packager-v1.json`
- Create: `server/tests/coreAiAgentManifests.test.ts`

**Interfaces:**
- Every manifest contains `manifest_version`, `name`, `description`, `system_prompt`, `model`, `thinking_effort`, `max_turns`, `timeout_seconds`, `enable_memory`, `tools`, `skill_ids`, `subagent_ids`, `dataset_config`, `sandbox_config`, and `response_schema`.
- Every non-execution `[SEO Ops]` Agent has no external-write tool.
- Planner output schema is `seo_ops.task_proposals.v1`.
- GBP Post content output schema is `seo_ops.gbp_post_draft.v1` and never includes a publication success claim.

- [ ] **Step 1: Write failing manifest contract tests**

```ts
it("all SEO Ops manifests are versioned, publishable, and bounded", () => {
  for (const manifest of loadManifests()) {
    expect(manifest.name).toMatch(/^\[SEO Ops\]/);
    expect(manifest.enable_memory).toBe(false);
    expect(manifest.subagent_ids).toEqual([]);
    expect(manifest.dataset_config).toEqual([]);
    expect(manifest.sandbox_config).toBeNull();
    expect(JSON.parse(manifest.response_schema).type).toBe("object");
  }
});

it("planner and content Agents cannot create tasks or claim execution", () => {
  const planner = manifest("seo-ops-planner-v1.json");
  const post = manifest("seo-ops-gbp-post-content-v1.json");
  expect(planner.tools).toEqual([]);
  expect(planner.system_prompt).toContain("Return proposals only");
  expect(post.system_prompt).toContain("Never publish");
  expect(post.system_prompt).toContain("United States English");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd server && npm test -- tests/coreAiAgentManifests.test.ts`

Expected: FAIL because the new manifests and common manifest fields do not exist.

- [ ] **Step 3: Add the manifest schema and reconcile existing manifests**

Use Core AI `CreateAgentRequest`/`UpdateAgentRequest` field names exactly. The JSON Schema file validates local manifest metadata separately from the request body. Keep Skill IDs explicit and versioned. Do not add a Skill unless a required operational method is absent from the current published Skill inventory.

- [ ] **Step 4: Add the three missing specialist manifests**

- GBP Post Content: type × voice-profile version × keyword cluster × evidence references → versioned draft.
- Effect Review: baseline × action bundle × observed change × confounders → conclusion capped at `ASSOCIATIONAL`.
- Report Packager: input artifacts → one frozen combined merchant-facing report; no invented facts and no internal-only artifacts.

- [ ] **Step 5: Verify and commit Task 9**

Run:

```bash
cd server
npm test -- tests/coreAiAgentManifests.test.ts tests/plannerAgent.test.ts tests/specialistAdapters.test.ts
npm run typecheck
git diff --check
```

Commit:

```bash
git add server/core-ai-agents server/tests/coreAiAgentManifests.test.ts
git commit -m "feat(agents): version the SEO Ops specialist roster"
```

---

### Task 10: Add a safe Core AI UAT Agent reconciler

**Files:**
- Create: `server/scripts/reconcile-core-ai-agents.ts`
- Create: `server/src/services/coreAiAgentAdminClient.ts`
- Create: `server/tests/coreAiAgentAdminClient.test.ts`
- Modify: `server/package.json`
- Modify: `docs/RUNBOOK-v2.md`

**Interfaces:**
- Command: `npm run agents:reconcile -- --mode=dry-run`.
- Command: `npm run agents:reconcile -- --mode=apply --evidence=<absolute-path>`.
- Core AI endpoints: `GET /api/agents/name/:name`, `POST /api/agents`, `PUT /api/agents/:id`, `POST /api/agents/:id/publish`, `GET /api/agents/:id`.
- The reconciler never invokes `DELETE /api/agents/:id`.

- [ ] **Step 1: Write failing admin-client tests**

```ts
it("dry-run returns a sanitized diff without mutation", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(existingAgent));
  const result = await reconcileAgent({ client: createAdminClient(base, token, fetch), manifest, mode: "dry-run" });
  expect(result.action).toBe("UPDATE");
  expect(result.changed_fields).toEqual(["system_prompt", "response_schema"]);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain(token);
});

it("apply updates, publishes, and independently reads back without delete", async () => {
  const fetch = sequencedFetch(existingAgent, updatedAgent, publishedAgent, publishedAgent);
  const result = await reconcileAgent({ client: createAdminClient(base, token, fetch), manifest, mode: "apply" });
  expect(result.readback).toMatchObject({ status: "PUBLISHED", name: manifest.name });
  expect(fetch.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${url}`)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^DELETE /)]));
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `cd server && npm test -- tests/coreAiAgentAdminClient.test.ts`

Expected: FAIL because the admin client and reconciler do not exist.

- [ ] **Step 3: Implement the admin client**

The bearer token is accepted only in the constructor and placed only in the `Authorization` header. Errors include HTTP status and endpoint path, never token or full body. Normalize remote Agent views before diffing so timestamps and owner metadata cannot trigger updates.

- [ ] **Step 4: Implement dry-run/apply reconciliation**

For each manifest:

1. GET by encoded name;
2. classify `CREATE`, `UPDATE`, or `NO_CHANGE`;
3. print only changed field names and sanitized IDs in dry-run;
4. in apply mode, POST or PUT, POST publish, then GET by ID;
5. assert published state, exact name, Skill IDs, tools, memory, subagents, datasets, sandbox, and response schema hash;
6. append before/after sanitized metadata and rollback coordinates to the required evidence file.

Abort on the first mismatch. Do not continue with later Agents after a failed readback.

- [ ] **Step 5: Document commands and rollback**

Add to `RUNBOOK-v2.md`:

```bash
cd server
npm run agents:reconcile -- --mode=dry-run
npm run agents:reconcile -- --mode=apply --evidence="$PWD/../docs/evidence/2026-08-26-core-ai-agent-reconciliation.md"
```

Rollback means restoring the exact previous manifest through PUT + publish and reading it back. It never means deleting the Agent.

- [ ] **Step 6: Verify and commit Task 10**

Run:

```bash
cd server
npm test -- tests/coreAiAgentAdminClient.test.ts tests/coreAiClient.test.ts
npm run typecheck
npm run build
git diff --check
```

Commit:

```bash
git add server/scripts/reconcile-core-ai-agents.ts server/src/services/coreAiAgentAdminClient.ts server/tests/coreAiAgentAdminClient.test.ts server/package.json docs/RUNBOOK-v2.md
git commit -m "feat(agents): add safe UAT reconciliation tooling"
```

---

### Task 11: Reconcile UAT Agents, bind SEO Ops, and prove one real workflow

**Files:**
- Create: `docs/evidence/2026-08-26-core-ai-agent-reconciliation.md`
- Create: `docs/evidence/2026-08-26-operator-control-room-acceptance.md`
- Modify only if readback requires a corrected manifest: `server/core-ai-agents/*.json`
- Modify only through SEO Ops API/runtime data: Agent binding settings.

**Interfaces:**
- UAT Agent mutation uses `CORE_AI_BASE_URL` and `CORE_AI_TOKEN` from `server/.env` without printing either.
- SEO Ops bindings use `PUT /api/seo-ops/agent-bindings/:taskType` and are read back through `GET /api/seo-ops/agent-bindings`.
- Acceptance run uses one test merchant/location and one read-only or draft-generating task before any external-write Agent is tested.

- [ ] **Step 1: Capture sanitized pre-state**

Run the dry-run command and record for every desired Agent: current ID or `ABSENT`, status, published time, Skill IDs, tool names, schema hash, and proposed action. Record the current SEO Ops binding list. Do not record prompts containing secrets or the bearer token.

- [ ] **Step 2: Review the dry-run stop conditions**

Stop instead of applying if:

- an Agent name does not start with `[SEO Ops]`;
- a required Skill is missing or unpublished;
- a read-only/draft Agent contains an external-write tool;
- market is not US / `en-US` where applicable;
- Planner output is not proposal-only;
- rollback metadata is incomplete.

- [ ] **Step 3: Apply and publish the reconciled roster**

Run the apply command with the evidence path. Read back every Agent independently and assert the manifest predicate. Do not delete superseded Agents.

- [ ] **Step 4: Bind task types through SEO Ops settings**

Bind only verified published Agent IDs. Read the settings collection back and compare exact binding keys and IDs. Preserve every unrelated binding.

- [ ] **Step 5: Run a bounded real workflow**

Use the test merchant to create or adopt one GBP Post content proposal. Confirm:

1. proposal exists before Task;
2. adoption creates exactly one Task;
3. draft Agent Run completes;
4. versioned draft artifact is persisted and independently readable;
5. Task remains before gate 1 and no external write occurred;
6. the workbench and merchant cycle ledger show the same business truth.

Record proposal ID, Task ID, Run ID, trace ID, artifact ID, schema version, timestamps, and sanitized readback results.

- [ ] **Step 6: Commit evidence**

```bash
git add docs/evidence server/core-ai-agents
git commit -m "test(uat): record SEO Ops Agent reconciliation"
```

---

### Task 12: Perform full verification and visual acceptance

**Files:**
- Modify only for verified defects: files from Tasks 1–11.
- Complete: `docs/evidence/2026-08-26-operator-control-room-acceptance.md`

**Interfaces:**
- Acceptance URLs: `/`, `/merchants/:id`, `/tasks/:id`, `/reviews`, `/settings`, and `/?view=audit`.
- Visual widths: 1440 px desktop, 1024 px compact desktop, 390 px narrow.

- [ ] **Step 1: Run the complete automated gate**

```bash
npm run test:run
npm run build
cd server
npm test
npm run typecheck
npm run build
cd ..
git diff --check
```

Expected: frontend 0 failed, backend 0 failed, both builds exit 0, diff check empty.

- [ ] **Step 2: Verify operator journeys in a browser**

At 1440 px verify:

- four-entry operator navigation and no Copilot;
- audit toggle and six-entry audit navigation;
- workbench grouping and exactly one primary action per row;
- merchant current-action card, dated Task/proposal distinction, reports, and Post program;
- task progressive disclosure and separate approve/publish/verify states;
- reconciliation dialog with two equal conclusions and no retry;
- settings operational sections.

- [ ] **Step 3: Verify scale, responsive behavior, and accessibility**

At 100 merchants/107 actions verify 50-row pagination, search, stable sorting, no full-page horizontal overflow, keyboard focus order, visible focus, semantic headings, status text beyond color, and reduced-motion behavior. At 390 px verify labeled rows and visible primary actions.

- [ ] **Step 4: Verify repository and external boundaries**

```bash
git -C /Users/xander/git_repo/core-ai status --short
git -C /Users/xander/git_repo/fbr-project status --short
git status -sb
```

Expected: no SEO Ops changes in Core AI or FBR Project. Preserve any pre-existing unrelated dirt exactly as found.

- [ ] **Step 5: Commit final acceptance evidence**

```bash
git add docs/evidence/2026-08-26-operator-control-room-acceptance.md
git commit -m "docs: record operator control room acceptance"
```

- [ ] **Step 6: Prepare branch handoff**

Report commits, automated counts, browser journeys, UAT Agent IDs/readback, remaining evidence gaps, and the explicit statement that Core AI/FBR Project source repositories were not modified. Do not merge or push until the user requests it.

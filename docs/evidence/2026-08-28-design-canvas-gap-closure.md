# Design canvas gap closure — verification evidence — 2026-08-28

## Scope

- Repository under test: `connexup-seo-ops` branch `feat/design-canvas-gap-closure`, commit range `3739a6b..HEAD` (17 commits, Tasks 1–9 of `docs/superpowers/plans/2026-08-27-design-canvas-gap-closure.md`).
- Spec: design canvas `https://claude.ai/code/artifact/dcb2926c-12c6-43b2-93aa-abd0aebe237e` (17 artboards) and `docs/superpowers/specs/2026-08-26-seo-ops-operator-control-room-v2-design.md` (authoritative on conflict).
- Task 10 controller ruling replaced the plan's manual-browser Step 2 with (a) full automated suites/build and (b) a grep-verified route-render smoke check — no dev servers were started, no new browser/e2e harness was written.

## Verification summary

| Check | Result |
|---|---|
| `npm run test:run` (frontend) | 35 files / 224 tests passed — first run, no flake encountered |
| `cd server && npm test` | 44 files / 465 tests passed — first run, no flake encountered |
| `cd server && npm run typecheck` | clean (`tsc --noEmit`, no output) |
| `npm run build` | clean (`tsc -b && vite build`, 1878 modules, no errors) |
| `git diff --check` | clean, no whitespace errors |

Full verbatim command output and the route-render smoke-check table are recorded in `.superpowers/sdd/2026-08-27-design-canvas-gap-closure/task-10-report.md` (not committed — internal task artifact).

---

## Task 1 — Cross-merchant Agent Run ledger API

**Artboard:** Runs / 运行

**Shipped:**
- `GET /api/seo-ops/agent-runs?merchant_id&status&stage&include_content=true|false&offset&limit` — server/src/routes/seoOps.ts:341, backed by `runsLedger()` in `server/src/services/runsLedgerService.ts` (new). Read-only projection over `seo_agent_runs`; Run completion is never written back to Task state.
- `GET /api/seo-ops/config` now returns `core_ai_console_url: string | null`.
- `server/src/repos/agentRunRepo.ts`: new `listAgentRunsPage` (paginated, merchant/status/stage filtered) and `listAgentRunsForSummary` (today's-signal window) queries.

**Tests:** `server/tests/runsLedger.test.ts` (token-total helper, scoped newest-first listing with today's summary, content-run visibility toggle + status filter, operator merchant scoping, config exposing `core_ai_console_url`).

**Commits:** `9aed964` feat(runs): add cross-merchant agent run ledger projection

---

## Task 2 — Runs page: summary strip + Run ledger table

**Artboard:** Runs / 运行

**Shipped:**
- `src/features/runs/RunsSummaryStrip.tsx` (new) — 6-cell KPI strip: in-flight, queued, completed today, failed today, outcome-unknown (danger state + frozen-merchant count), today's tokens.
- `src/features/runs/RunLedgerTable.tsx` (new) — Run ledger table with status pill, duration, trigger source label, deliverable count, link to the owning Task.
- `src/features/runs/RunsPage.tsx` — wires both into the page, adds status/include-content filters, pagination, and a "打开 Core AI 控制台" external link driven by `config.core_ai_console_url`.
- `src/features/settings/SystemStatusPanel.tsx` — Run capacity and today's-failure cards now read real data from `/api/seo-ops/agent-runs` instead of listing them as unsupported.
- `src/styles/runs.css` (new).

**Tests:** `src/features/runs/RunsPage.test.tsx` (summary strip, ledger table rows, Core AI console link, include-content refetch), `src/features/settings/SettingsPage.test.tsx` (Run-capacity/failure cards no longer asserted unsupported).

**Commits:** `ebf00b2` feat(runs): render run summary strip and cross-merchant run ledger

---

## Task 3 — Overview: exception ledger, today's signals, verification-overdue

**Artboard:** Main / 总览

**Shipped:**
- `GET /api/seo-ops/activity?hours=24&limit=20` — server/src/routes/seoOps.ts:257, backed by `server/src/services/activityFeedService.ts` (new): merges Task audit events, completed/failed Agent Runs, and proposal batches into one time-ordered, plain-language feed (`describeTaskEvent` maps event types to copy + severity; unknown types degrade to their raw name instead of throwing).
- `server/src/routes/executionRoutes.ts` — inbox-summary now includes `verification_overdue`.
- `src/features/overview/exceptionGroups.ts` (new) — groups the exception ledger into the five design categories (结果不确定 / 等待商家 / 建议待判定 / 待审批与确认 / 核验与复查).
- `src/features/overview/OverviewPage.tsx` — leads with the grouped exception ledger, a "待处理汇总" strip, a "今日信号" activity feed section, and a "Run 容量" panel that explicitly labels concurrency/quota as 未接入 (Core AI provides no quota API).
- `src/styles/overview.css` (new).

**Tests:** `server/tests/activityFeed.test.ts` (event-copy mapping, newest-first merged feed with merchant names/links, scoped-to-zero for outside operators, `verification_overdue` on inbox-summary), `src/features/overview/exceptionGroups.test.ts`, `src/features/overview/OverviewPage.test.tsx` (exception ledger headings/rows, today's-signals link, Run-capacity 未接入 copy).

**Commits:** `3e60a46` feat(overview): add activity feed projection and verification overdue count · `a17a9bb` feat(overview): exception ledger, today's signals, and run capacity · `431f089` fix(overview): scope activity feed reads and cover run/overdue branches

---

## Task 4 — Inbox/Proposals: batch adoption, adopt-with-edits, manual Planner request

**Artboard:** Inbox+Proposals / 任务+待判定

**Shipped:**
- `POST /api/seo-ops/merchants/:merchantId/planner-requests` — server/src/routes/seoOps.ts:556, reuses `enqueuePlannerTaskIfBound`; returns `201 { task_id, replayed: false }` on first call, `200 { …, replayed: true }` on idempotent replay, `409 PLANNER_NOT_BOUND` when no Planner agent is bound.
- `src/features/inbox/AdoptDialog.tsx` (new) — adopt-with-edits dialog (override priority / due date) for a proposal.
- `src/features/inbox/PlannerRequestButton.tsx` (new) — manual "手动请求 Planner" trigger with idempotency key and replay handling (the merchant page's equivalent trigger is labelled "请求 Planner 刷新任务图").
- `src/features/inbox/ProposalsTab.tsx` — batch adoption flow wired to both.

**Tests:** `server/tests/plannerRequest.test.ts` (refuses when unbound, creates one pre-authorised task and replays on the same key), `src/features/inbox/ProposalsTab.test.tsx` (batch rendering, adoption, adopt-with-edits, planner-request button).

**Commits:** `eb10c06` feat(planner): allow operators to request a planner run manually · `5693ed3` feat(proposals): batch adoption, adopt-with-edits, and manual planner requests

---

## Task 5 — Red-line copy fixes (GBP publish rail, review window, review-tier vocabulary)

**Artboards:** Task / 任务详情 (GBP workflow rail, approval copy) · Reviews / 复盘 (classification/tier labels) · Settings / 设置 (cadence label)

**Shipped:**
- `src/features/tasks/GbpWorkflowRail.tsx` — the GBP Post operating rail is now 5 steps (生成图文 → 修改与定稿 → 人工批准 → 发布 → 生效核对), splitting "发布" (provider receipt) from "生效核对" (public-visibility verification); removed the "自动发布" (auto-publish) framing — publish is never implied by approval alone, and `OUTCOME_UNKNOWN` shows as "结果不确定 · 等人工查证" mid-rail instead of silently advancing.
- `src/features/tasks/ApprovalPanel.tsx` — "已批准，等待自动发布" → "已批准，等待发布" (approval authorizes; it does not itself publish).
- `server/src/services/schedulerService.ts` — the periodic REVIEW task title changed from "评论巡检与回评草拟 #N" (review-reply sweep) to "效果复盘 #N" (effect review), matching what the task actually is.
- `src/features/settings/CadencePanel.tsx` — the review-window field label changed from "评论巡检窗口（天）" to "复盘窗口（天）· 到窗自动出 REVIEW 建议".
- `src/features/reviews/reviewCopy.ts` — added `classificationLabel` (never promotes a correlational reading to causal) and `tierLabel` (ASSOCIATIONAL / DESCRIPTIVE / INSUFFICIENT wording).

**Tests:** `src/features/tasks/GbpWorkflowRail.test.tsx` (5-step rail state assertions, publish/verify state split), `src/features/reviews/reviewCopy.test.ts` (classification/tier label wording).

**Commits:** `1f9af2b` fix(copy): separate publish from verification and name the review window correctly

---

## Task 6 — Merchant workspace: ranking snapshot, round badge, Planner request, review signal, brand-profile row

**Artboard:** Merchant / 商户工作台

**Shipped:**
- `src/features/merchant/RankingSnapshotPanel.tsx` (new) — latest-vs-previous local/organic rank comparison, round count, new-keyword count.
- `src/features/merchant/ReviewSignalPanel.tsx` (new) — surfaces the latest `EFFECT_REVIEW` specialist artifact (title, tier, conclusion) with an explicit error/empty state.
- `src/features/merchant/MerchantWorkspacePage.tsx` — mounts both panels, adds the round badge and a "请求 Planner" action (Task 4's endpoint).
- `src/features/merchant/ReportsDataPanel.tsx` — tri-state brand-profile row (present / missing / unknown-due-to-error, not collapsed to a false empty state).

**Tests:** `src/features/merchant/MerchantWorkspacePage.test.tsx` (ranking snapshot rendering, round badge, planner-request action, review-signal panel incl. its error state, brand-profile tri-state row).

**Commits:** `86cde84` feat(merchant): ranking snapshot, round badge, planner request, and review signal · `6149bd3` fix(merchant): tri-state brand-profile row and review-signal error state

---

## Task 7 — Post content: weekly plan sub-page

**Artboard:** PostPlan / Post 周计划

**Shipped:**
- `GET/POST /api/seo-ops/merchants/:merchantId/style-profile` — server/src/routes/executionRoutes.ts:809/817, wire `{ id, merchant_id, version, voice, updated_by, created_at }`.
- `src/features/merchant/PostPlanPage.tsx` (new), routed at `/merchants/:merchantId/post-plan` (`src/App.tsx`) — combines cluster signals, weekly cadence, cycle ledger, and the voice profile for one merchant's Post program.
- `src/features/merchant/VoiceProfileEditor.tsx` (new) — versioned voice-profile editor (tone / address / banned words / example / source), preserves untouched fields on save and surfaces load errors instead of masking them.
- `src/features/merchant/PostProgramPanel.tsx` — entry link into the new sub-page.
- `src/styles/post-plan.css` (new).

**Tests:** `src/features/merchant/PostPlanPage.test.tsx` (cluster signals, cadence, cycle ledger, voice-profile load/save round-trip incl. field preservation and load-error state).

**Commits:** `4e5d34b` feat(merchant): GBP Post weekly plan sub-page with versioned voice profile · `a627a68` fix(merchant): preserve voice profile fields on save and surface load errors

---

## Task 8 — Reviews page: merchant·round review cards, Gate D windows, task-level evidence tiering

**Artboard:** Reviews / 复盘

**Shipped:**
- `GET /api/seo-ops/effect-reviews?merchant_id=` — server/src/routes/seoOps.ts:240, backed by `server/src/services/effectReviewService.ts` (new): `{ summary: { total, by_tier, due_count }, items: EffectReviewWire[], windows: ReviewWindowWire[] }`, projecting `EFFECT_REVIEW` specialist artifacts and cycle-config review windows (Gate D).
- `src/features/reviews/ReviewsPage.tsx` — renders one card per merchant·round with classification/tier labels (Task 5's `reviewCopy.ts`), a due-window queue, and audit-only task classification so causal claims never outrun the evidence.

**Tests:** `server/tests/effectReviews.test.ts`, `src/features/reviews/ReviewsPage.test.tsx` (review cards, due-window queue, tier labeling), `src/features/settings/SettingsPage.test.tsx` (existing review-window assertions kept green).

**Commits:** `aabd3c3` feat(reviews): merchant-round effect review projection with Gate D windows · `9d53ca7` feat(reviews): merchant-round review cards, Gate D windows, audit-only task classification

---

## Task 9 — Settings: cross-merchant capability matrix and cadence overview

**Artboard:** Settings / 设置

**Shipped:**
- `GET /api/seo-ops/capabilities` — server/src/routes/executionRoutes.ts:725, `{ items: Array<CapabilityWire & { merchant_name }> }`, scoped to the operator's merchants. Capability keys expanded to `GBP_WRITE / REVIEW_REPLY / WEBSITE_WRITE / WEBSITE_APPLY / XHS_PUBLISH`; only `GBP_WRITE` and `WEBSITE_WRITE` gate Gate 2 (`requiredCapabilityFor`), the rest are advisory and the panel says so explicitly.
- `src/features/settings/CapabilityMatrixPanel.tsx` — cross-merchant matrix view; keeps its heading and error state mounted through reloads instead of flashing empty.
- `src/features/settings/CadencePanel.tsx` — cross-merchant cadence overview.

**Tests:** `server/tests/capabilities.test.ts` (scoped cross-merchant listing with merchant names), `src/features/settings/SettingsPage.test.tsx` (matrix rendering, advisory-vs-gating capability distinction, heading/error persistence through reload).

**Commits:** `c813e35` feat(settings): expose scoped cross-merchant capability matrix · `e54bcdd` feat(settings): cross-merchant capability matrix and cadence overview · `16bb3e8` fix(settings): keep capability matrix heading and errors mounted during reloads

---

## Route-render coverage (Task 10 controller-ruling smoke check)

Confirmed by reading each test file's render call — every page below is mounted through the real `<App>` route tree (`MemoryRouter initialEntries={[route]}`), not a bare component render, and each asserts real (fixture-backed) content, not just "renders without crashing":

| Route | Test file | Renders via | Real-content assertion |
|---|---|---|---|
| `/` audit overview | `src/features/overview/OverviewPage.test.tsx` | `renderApp("/?view=audit")` | heading "总览", 待处理汇总 strip, 异常清单 grouped rows, 今日信号 feed, Run 容量 (未接入 quota copy) |
| `/` operator workbench | `src/features/workbench/WorkbenchPage.test.tsx` | `renderApp("/")` | headings 今天需要我处理/例外/把关/商户联络, decision rows with one primary action each |
| `/runs` | `src/features/runs/RunsPage.test.tsx` | `renderApp("/runs?view=audit")` | 运行汇总 region values, 运行记录 ledger row content, Core AI console link |
| `/inbox` tasks tab | `src/App.test.tsx` | `renderApp("/inbox")` | task rows, empty-state copy, pagination/offset correction |
| `/inbox` proposals tab | `src/features/inbox/ProposalsTab.test.tsx` | renders `<ProposalsTab>` directly (the exact component `InboxPage` mounts for `?tab=proposals`), wrapped in `MemoryRouter` — **not** through the literal `/inbox?tab=proposals` App route | batch title, proposal rows, adoption/adopt-with-edits, planner-request button |
| `/merchants/:id` | `src/features/merchant/MerchantWorkspacePage.test.tsx` | `renderApp("/merchants/only-bear?view=operator")` etc. | ranking snapshot, round badge, review-signal panel, brand-profile row |
| `/merchants/:id/post-plan` | `src/features/merchant/PostPlanPage.test.tsx` | `renderApp("/merchants/keke/post-plan?view=operator")` | cluster signals, cadence, voice-profile editor round-trip |
| `/reviews` | `src/features/reviews/ReviewsPage.test.tsx` | `renderApp("/reviews?view=audit")` | review cards, due-window queue |
| `/settings` | `src/features/settings/SettingsPage.test.tsx` | `renderApp("/settings")` | capability matrix, cadence overview, system-status cards |

**Gap noted, not fixed (per controller instruction to report rather than invent a test):** no test file renders the full `App` route tree at `/inbox?tab=proposals` and asserts the tab switch itself. The tasks tab is covered end-to-end through the real route in `App.test.tsx`; the proposals tab's content is covered by `ProposalsTab.test.tsx`, which renders the same `ProposalsTab` component `InboxPage` mounts for that tab, but does so directly rather than via the `/inbox` route with `?tab=proposals` and a tab-button click. Functionally the same component and API contract are exercised either way; only the literal route-level integration (tab click → URL → same component) is untested.

---

## 已知未覆盖

Verbatim from the plan's "明确不做（留给后续）" section (`docs/superpowers/plans/2026-08-27-design-canvas-gap-closure.md`):

- 用户与权限管理（用户列表 / 商户范围 / 权限点编辑）：后端没有用户列表接口与授权模型，设置页保持只读显示当前身份。
- Copilot 顶栏入口：规范明确排除。
- 操作员视角的「内容快审 连过」「分组催办话术」（压测稿）：需要新的批量接口与外发模板，另立计划。
- 运营期「节奏条」页头：需要「首轮复盘完成」的持久化标记，另立计划。
- 并发/配额数字：Core AI 未提供配额接口，页面明示「未接入」。

---

## 终审后修正

全分支终审发现 0 Critical / 7 Important（多为跨任务口径不一致），一次性修正如下（commit `PENDING_SHA`）：

1. Overview 待处理总数改用后端 `workbench.total`（原按渲染分组求和，超过分页上限即漏计）；超页时在异常清单标题下加一行截断提示并链接到「任务」页。
2. `groupExceptions` 改为穷举映射 `GROUP_BY_TYPE: Record<HumanActionType, ExceptionGroupKey>`，编译期强制覆盖每个 `HumanActionType`，防止新增类型悄悄漏出分组。
3. 「结果待查」在三处口径不同（全部未决 attempt / workbench 可处理子集 / 任务状态）——不合并数字，只补齐措辞：`RunsSummaryStrip` 提示语、`/runs` 的 `QueuePanel` 标题与提示、`exceptionGroups` 的 UNKNOWN 分组提示、Overview 汇总格的 `title` 提示。
4. Gate D 到窗队列的口径改为「参考值」——调度器按固定 epoch 桶触发，与 `last_review_at + review_window_days` 的推算窗口不保证重合，措辞不再暗示两者一致。
5. `effectReviewService` 的 `conclusion_tier` 改为白名单 `INSUFFICIENT_EVIDENCE | DESCRIPTIVE | ASSOCIATIONAL`，任何越权声称（如 `CAUSAL`）一律降级为 `INSUFFICIENT_EVIDENCE`；`ReviewsPage` 的分布统计改用 `tierLabel()` 渲染，不再直出原始 key。
6. `VoiceProfileEditor` 新增 `loading` prop：初始 GET 未回时不再误判「尚无风格档案」，且禁用「编辑（记版本）」，避免用空表单覆盖尚未加载出的字段。
7. `core_ai_console_url` 不再复用 `CORE_AI_BASE_URL`（API host）；新增独立的 `CORE_AI_CONSOLE_URL` 配置项（未设置时前端隐藏链接，`safeHref` 已校验）。
8. 三处收尾：`PlannerRequestButton` 的目标商户改为渲染时求值，修复 portfolio 异步解析后按钮保持禁用且无提示的问题；`ProposalsTab` 的 `planner_run_id` 与 `snapshot_note` 改为独立渲染；`capabilities.test.ts` 补一条与 `runsLedger.test.ts` 对齐的商户范围隔离测试。

本节以及上文两处措辞纠正（异常分组五类名称、Planner 按钮标签）均在同一提交内完成。

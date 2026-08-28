# SEO Ops v2 设计稿差距补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「SEO Ops 控制台 v2」设计画布里已定稿、但代码尚未实现的内容层补齐：运行页 Run 账本、总览异常清单与今日信号、建议批次判定与手动请求 Planner、红线文案修正、商户页排名/复盘信号、Post 周计划子页、商户·轮次复盘页、设置页跨商户矩阵。

**Architecture:** SEO Ops PostgreSQL 仍是 Task/业务状态真源。每个新页面由一个有界的服务端投影（`server/src/services/*Service.ts` + 一条 `GET` 路由）驱动，前端只读投影、只通过已有变更接口写入。Agent Run 账本只读 `seo_agent_runs`，永不把 Run 状态写回 Task。所有新路由沿用 `requirePermission` + `listMerchantsForOperator` 的商户范围过滤。

**Tech Stack:** React 19, React Router 7, TypeScript, Vite, Vitest + Testing Library (jsdom), Fastify 5, PostgreSQL (`pg`), Zod 3.

**Spec:** 设计画布 `https://claude.ai/code/artifact/dcb2926c-12c6-43b2-93aa-abd0aebe237e`（17 块画板；本地文本抽取见会话 scratchpad `txt/*.txt`）；文字规范 `docs/superpowers/specs/2026-08-26-seo-ops-operator-control-room-v2-design.md`。两者冲突时以文字规范为准（例：Copilot 不进 UI）。

## Global Constraints

- Modify product code only in `/Users/xander/git_repo/connexup-seo-ops`.
- Never modify `/Users/xander/git_repo/core-ai` or `/Users/xander/git_repo/fbr-project`; Core AI UAT 只允许通过浏览器/HTTP 只读查看。
- Copilot stays absent from both operator and audit UI（`CopilotPanel.tsx` 保持不挂载）。
- Operator UI never directly triggers specialist lifecycle-stage Runs.
- Planner/scheduler results remain proposals until a human adopts them; adoption is the only proposal-to-Task path.
- Core AI Run completion never marks an SEO Task complete.
- `OUTCOME_UNKNOWN` never exposes automatic retry.
- Production rendering uses backend data only; no frontend demo data.
- Preserve unrelated `_to_delete/` and any user-owned dirty files.
- 服务端测试需要本地 PostgreSQL（`postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev`，`pg_isready` 已确认可用）；命令：`cd server && npm test -- tests/<file>.test.ts`。前端测试：`npm run test:run -- src/<path>.test.tsx`。
- 服务端 import 一律带 `.js` 后缀；wire 字段一律 snake_case；新路由的 zod schema 与现有 `executionRoutes.ts` 风格一致。
- 每个任务结束提交一次；提交信息末尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

## File Structure

| 责任 | 文件 |
|---|---|
| Run 账本仓储/投影/路由 | `server/src/repos/agentRunRepo.ts`（新增两个查询）、`server/src/services/runsLedgerService.ts`（新建）、`server/src/routes/seoOps.ts` |
| 今日信号投影 | `server/src/services/activityFeedService.ts`（新建，含事件文案表） |
| 手动请求 Planner | `server/src/routes/seoOps.ts`（新路由，复用 `enqueuePlannerTaskIfBound`） |
| 复盘投影 | `server/src/services/effectReviewService.ts`（新建） |
| 跨商户能力矩阵 | `server/src/routes/executionRoutes.ts`（新路由，复用 `listCapabilities`） |
| 前端类型/客户端 | `src/api/types.ts`、`src/api/seoOpsApi.ts` |
| 运行页 | `src/features/runs/RunsPage.tsx`、`RunsSummaryStrip.tsx`、`RunLedgerTable.tsx`（新建）、`src/styles/runs.css`（新建） |
| 总览页 | `src/features/overview/OverviewPage.tsx`、`exceptionGroups.ts`（新建）、`src/styles/overview.css`（新建） |
| 待判定 | `src/features/inbox/ProposalsTab.tsx`、`AdoptDialog.tsx`（新建）、`PlannerRequestButton.tsx`（新建） |
| 商户页 | `src/features/merchant/MerchantWorkspacePage.tsx`、`RankingSnapshotPanel.tsx`、`ReviewSignalPanel.tsx`（新建）、`ReportsDataPanel.tsx` |
| Post 周计划 | `src/features/merchant/PostPlanPage.tsx`、`VoiceProfileEditor.tsx`（新建）、`src/styles/post-plan.css`（新建）、`src/App.tsx` |
| 复盘页 | `src/features/reviews/ReviewsPage.tsx`、`reviewCopy.ts` |
| 设置页 | `src/features/settings/CapabilityMatrixPanel.tsx`、`CadencePanel.tsx` |

---

### Task 1: 跨商户 Agent Run 账本 API

**Files:**
- Modify: `server/src/repos/agentRunRepo.ts`（在 `listActiveAgentRuns` 之后追加）
- Create: `server/src/services/runsLedgerService.ts`
- Modify: `server/src/routes/seoOps.ts`（`/api/seo-ops/config` 与新路由）
- Test: `server/tests/runsLedger.test.ts`

**Interfaces:**
- Consumes: `AgentRun`（`repos/agentRunTypes.ts`）、`listOpenUnknownAttempts`（`repos/executionRepo.ts`）、`listMerchants` / `listMerchantsForOperator`（`repos/merchantRepo.ts`）、`listDeliverablesByRunIds`。
- Produces: `GET /api/seo-ops/agent-runs?merchant_id&status&stage&include_content=true|false&offset&limit` → `RunsLedgerWire`；`GET /api/seo-ops/config` 新增 `core_ai_console_url: string | null`。

- [ ] **Step 1: 写失败测试**

`server/tests/runsLedger.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertAgentRun } from "../src/repos/agentRunRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";
import { createAuthenticatedTestApp, createTestUser, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { tokenTotal } from "../src/services/runsLedgerService.js";

const NOW = new Date("2026-08-27T15:00:00.000Z");

function run(merchantId: string, overrides: Partial<AgentRun>): AgentRun {
  const iso = NOW.toISOString();
  return {
    id: crypto.randomUUID(), merchantId, locationId: null, stage: "KEYWORDS", taskId: null,
    runType: "KEYWORD_RESEARCH", goal: null, status: "COMPLETED", coreRunId: "core-1", traceRef: null,
    coreStatus: "COMPLETED", inputMessage: "seed", output: "ok", error: null, errorCode: null,
    tokenUsage: { input_tokens: 100, output_tokens: 50 }, triggeredBy: "system:scheduler",
    triggeredAt: "2026-08-27T14:00:00.000Z", lastPolledAt: null, completedAt: "2026-08-27T14:11:02.000Z",
    creationIdempotencyKey: null, requestFingerprint: null, createdBy: null,
    createdAt: "2026-08-27T14:00:00.000Z", updatedAt: iso, ...overrides,
  };
}

describe("runs ledger", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "ledger-a", display_name: "Ledger A", operator_user_ids: [built.actor.userId], idempotency_key: "ledger-a" },
    })).json().id;
    await insertAgentRun(built.db, run(merchantId, { id: "run-done", tokenUsage: { total_tokens: 880 } }));
    await insertAgentRun(built.db, run(merchantId, { id: "run-live", status: "RUNNING", completedAt: null, coreStatus: "RUNNING" }));
    await insertAgentRun(built.db, run(merchantId, { id: "run-failed-old", status: "FAILED", errorCode: "TIMEOUT", createdAt: "2026-08-20T10:00:00.000Z", triggeredAt: "2026-08-20T10:00:00.000Z", completedAt: "2026-08-20T10:05:00.000Z" }));
    await insertAgentRun(built.db, run(merchantId, { id: "run-content", stage: "GBP_POST_CONTENT", runType: "GBP_POST_CONTENT", taskId: null }));
  });

  afterEach(async () => app.close());

  it("tokenTotal prefers total_tokens and otherwise sums numeric fields", () => {
    expect(tokenTotal({ total_tokens: 12, input_tokens: 5 })).toBe(12);
    expect(tokenTotal({ input_tokens: 5, output_tokens: 7 })).toBe(12);
    expect(tokenTotal({})).toBe(0);
  });

  it("lists scoped runs newest first, hides content runs by default, and summarises today", async () => {
    const response = await app.inject({ method: "GET", url: `/api/seo-ops/agent-runs?limit=10&now=${encodeURIComponent(NOW.toISOString())}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.map((r: { id: string }) => r.id)).toEqual(["run-done", "run-live", "run-failed-old"]);
    expect(body.total).toBe(3);
    expect(body.items[0]).toMatchObject({
      merchant_name: "Ledger A", stage: "KEYWORDS", status: "COMPLETED", token_total: 880,
      duration_ms: 662_000, deliverable_count: 0,
    });
    expect(body.summary).toMatchObject({
      in_flight: 1, completed_today: 1, failed_today: 0, content_runs_today: 1,
      token_total_today: 880 + 150, outcome_unknown: 0, frozen_merchant_ids: [],
    });
  });

  it("include_content=true reveals GBP content runs and status filter narrows", async () => {
    const all = (await app.inject({ method: "GET", url: "/api/seo-ops/agent-runs?include_content=true" })).json();
    expect(all.total).toBe(4);
    const running = (await app.inject({ method: "GET", url: "/api/seo-ops/agent-runs?status=RUNNING" })).json();
    expect(running.items.map((r: { id: string }) => r.id)).toEqual(["run-live"]);
  });

  it("scopes to the operator's merchants", async () => {
    const outsider = await createTestUser(built.db, { permissions: ["seoops.view"] });
    const other = await createAuthenticatedTestApp({ user: outsider, db: built.db });
    try {
      const body = (await other.app.inject({ method: "GET", url: "/api/seo-ops/agent-runs" })).json();
      expect(body.total).toBe(0);
      expect(body.summary.in_flight).toBe(0);
    } finally { await other.app.close(); }
  });

  it("exposes the Core AI console url in config only when configured", async () => {
    const config = (await app.inject({ method: "GET", url: "/api/seo-ops/config" })).json();
    expect(config).toHaveProperty("core_ai_console_url", null);
  });
});
```

注意：`createAuthenticatedTestApp` 的参数形状以 `server/tests/helpers/authTest.ts` 为准（本任务执行时先 `sed -n 80,200p` 读它；若不支持 `{ user, db }` 复用，改为新建 app 后用 `assignMerchantOperatorIds` 排除该用户，断言结果同样为空）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npm test -- tests/runsLedger.test.ts`
Expected: FAIL — `runsLedgerService.js` 不存在。

- [ ] **Step 3: 仓储查询**

在 `server/src/repos/agentRunRepo.ts` 的 `listActiveAgentRuns` 之后追加：

```ts
export interface AgentRunPageFilter {
  /** null = 全部商户（scopeAll）。 */
  merchantIds: readonly string[] | null;
  status?: string;
  stage?: string;
  includeContentRuns: boolean;
  offset: number;
  limit: number;
}

function runFilterClause(filter: Omit<AgentRunPageFilter, "offset" | "limit">, params: unknown[]): string {
  const where: string[] = [];
  if (filter.merchantIds !== null) {
    params.push([...filter.merchantIds]);
    where.push(`merchant_id = ANY($${params.length}::text[])`);
  }
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter.stage) { params.push(filter.stage); where.push(`stage = $${params.length}`); }
  if (!filter.includeContentRuns) where.push(`stage <> 'GBP_POST_CONTENT'`);
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

/** 跨商户 Run 账本分页（只读；不含 output 正文以外的任何裁决）。 */
export async function listAgentRunsPage(
  db: Db,
  filter: AgentRunPageFilter,
): Promise<{ items: AgentRun[]; total: number }> {
  const params: unknown[] = [];
  const clause = runFilterClause(filter, params);
  const count = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total FROM seo_agent_runs ${clause}`, params,
  );
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return { items: rows.map(toAgentRun), total: Number(count?.total ?? 0) };
}

/** 汇总用：某时刻之后创建的 Run + 仍在途的 Run（不分页）。 */
export async function listAgentRunsForSummary(
  db: Db,
  merchantIds: readonly string[] | null,
  sinceIso: string,
): Promise<AgentRun[]> {
  const params: unknown[] = [sinceIso];
  let scope = "";
  if (merchantIds !== null) { params.push([...merchantIds]); scope = `AND merchant_id = ANY($2::text[])`; }
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE (created_at >= $1 OR status IN ('TRIGGERING','RUNNING')) ${scope}
     ORDER BY created_at DESC, id DESC`,
    params,
  );
  return rows.map(toAgentRun);
}
```

- [ ] **Step 4: 投影服务**

`server/src/services/runsLedgerService.ts`:

```ts
import type { Db } from "../db/connection.js";
import { listAgentRunsForSummary, listAgentRunsPage, listDeliverablesByRunIds } from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { listOpenUnknownAttempts } from "../repos/executionRepo.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";

export interface RunLedgerRowWire {
  id: string; merchant_id: string; merchant_name: string; location_id: string | null;
  task_id: string | null; stage: string; run_type: string; status: string;
  core_run_id: string | null; trace_ref: string | null; error_code: string | null;
  triggered_by: string; triggered_at: string; completed_at: string | null;
  duration_ms: number | null; token_total: number; deliverable_count: number;
}

export interface RunsLedgerWire {
  summary: {
    in_flight: number; queued: number; completed_today: number; failed_today: number;
    content_runs_today: number; token_total_today: number;
    outcome_unknown: number; frozen_merchant_ids: string[];
    day_start: string;
  };
  items: RunLedgerRowWire[]; offset: number; limit: number; total: number;
}

export interface RunsLedgerQuery {
  actorUserId: string; scopeAll: boolean; merchantId?: string; status?: string; stage?: string;
  includeContentRuns: boolean; offset: number; limit: number;
}

/** Core AI 的 token_usage 字段不统一：有 total 用 total，否则把数值字段相加。 */
export function tokenTotal(usage: Record<string, number>): number {
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  if (typeof usage.total === "number") return usage.total;
  return Object.values(usage).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
}

function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function durationMs(run: AgentRun): number | null {
  if (!run.completedAt) return null;
  const ms = Date.parse(run.completedAt) - Date.parse(run.triggeredAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Run 账本：只读 seo_agent_runs；Run 完成 ≠ Task 完成，这里不碰任务状态。 */
export async function runsLedger(db: Db, query: RunsLedgerQuery, now: Date = new Date()): Promise<RunsLedgerWire> {
  const merchants = query.scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, query.actorUserId);
  const names = new Map(merchants.map((m) => [m.id, m.displayName]));
  const scopedIds = merchants.map((m) => m.id);
  const merchantIds = query.merchantId ? scopedIds.filter((id) => id === query.merchantId) : (query.scopeAll ? null : scopedIds);

  const page = await listAgentRunsPage(db, {
    merchantIds, status: query.status, stage: query.stage,
    includeContentRuns: query.includeContentRuns, offset: query.offset, limit: query.limit,
  });
  const deliverables = await listDeliverablesByRunIds(db, page.items.map((run) => run.id));

  const dayStart = utcDayStart(now);
  const recent = await listAgentRunsForSummary(db, query.scopeAll ? null : scopedIds, dayStart);
  const today = recent.filter((run) => run.createdAt >= dayStart);
  const unknown = (await listOpenUnknownAttempts(db)).filter((a) => query.scopeAll || names.has(a.merchantId));

  return {
    summary: {
      in_flight: recent.filter((run) => run.status === "RUNNING").length,
      queued: recent.filter((run) => run.status === "TRIGGERING").length,
      completed_today: today.filter((run) => run.status === "COMPLETED" && run.stage !== "GBP_POST_CONTENT").length,
      failed_today: today.filter((run) => run.status === "FAILED").length,
      content_runs_today: today.filter((run) => run.stage === "GBP_POST_CONTENT").length,
      token_total_today: today.reduce((sum, run) => sum + tokenTotal(run.tokenUsage), 0),
      outcome_unknown: unknown.length,
      frozen_merchant_ids: [...new Set(unknown.map((a) => a.merchantId))],
      day_start: dayStart,
    },
    items: page.items.map((run) => ({
      id: run.id, merchant_id: run.merchantId, merchant_name: names.get(run.merchantId) ?? run.merchantId,
      location_id: run.locationId, task_id: run.taskId, stage: run.stage, run_type: run.runType, status: run.status,
      core_run_id: run.coreRunId, trace_ref: run.traceRef, error_code: run.errorCode,
      triggered_by: run.triggeredBy, triggered_at: run.triggeredAt, completed_at: run.completedAt,
      duration_ms: durationMs(run), token_total: tokenTotal(run.tokenUsage),
      deliverable_count: (deliverables.get(run.id) ?? []).length,
    })),
    offset: query.offset, limit: query.limit, total: page.total,
  };
}
```

- [ ] **Step 5: 路由**

在 `server/src/routes/seoOps.ts`：
1. 顶部 import 追加 `import { runsLedger } from "../services/runsLedgerService.js";`
2. `/api/seo-ops/config` 处理函数返回对象里追加 `core_ai_console_url: ctx.config.coreAiBaseUrl ?? null,`（先 `sed -n 207,218p` 看现有返回结构，在同一对象内追加）。
3. 在 `app.get("/api/seo-ops/agent-runs/:runId", …)` **之前**追加：

```ts
  const agentRunsQuerySchema = z.object({
    merchant_id: z.string().min(1).optional(),
    status: z.enum(["TRIGGERING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]).optional(),
    stage: z.string().min(1).max(40).optional(),
    include_content: z.enum(["true", "false"]).optional(),
    /** 测试注入用；生产不传。 */
    now: z.string().datetime().optional(),
  });

  // 跨商户 Run 账本（只读）：Run 完成 ≠ Task 完成，这里不改任何任务状态。
  app.get("/api/seo-ops/agent-runs", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const query = agentRunsQuerySchema.parse(request.query);
    const { offset, limit } = parsePageParams(request.query as Record<string, unknown>);
    if (query.merchant_id) await requireMerchantAccess(ctx.db, actor, query.merchant_id);
    return runsLedger(ctx.db, {
      actorUserId: actor.userId, scopeAll: actor.scopeAll === true,
      merchantId: query.merchant_id, status: query.status, stage: query.stage,
      includeContentRuns: query.include_content === "true", offset, limit,
    }, query.now ? new Date(query.now) : new Date());
  });
```

`parsePageParams` 已从 `queryService.js` 导入（确认 import 列表里有，没有就加）。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd server && npm test -- tests/runsLedger.test.ts && npm run typecheck`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add server/src/repos/agentRunRepo.ts server/src/services/runsLedgerService.ts server/src/routes/seoOps.ts server/tests/runsLedger.test.ts
git commit -m "feat(runs): add cross-merchant agent run ledger projection"
```

---

### Task 2: 运行页 — KPI 条 + Run 账本表

**Files:**
- Modify: `src/api/types.ts`、`src/api/seoOpsApi.ts`
- Create: `src/features/runs/RunsSummaryStrip.tsx`、`src/features/runs/RunLedgerTable.tsx`、`src/styles/runs.css`
- Modify: `src/features/runs/RunsPage.tsx`、`src/styles.css`、`src/features/settings/SystemStatusPanel.tsx`
- Test: `src/features/runs/RunsPage.test.tsx`、`src/features/settings/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `GET /api/seo-ops/agent-runs`（Task 1）。
- Produces: `seoOpsApi.runsLedger(request, signal)`；类型 `RunLedgerRow`、`RunsLedgerView`、`RunsLedgerRequest`。

- [ ] **Step 1: 类型与客户端**

`src/api/types.ts` 末尾追加；`RuntimeConfig` 增加 `core_ai_console_url?: string | null;`：

```ts
export interface RunLedgerRow {
  id: string; merchant_id: string; merchant_name: string; location_id: string | null;
  task_id: string | null; stage: string; run_type: string; status: AgentRunStatus;
  core_run_id: string | null; trace_ref: string | null; error_code: string | null;
  triggered_by: string; triggered_at: string; completed_at: string | null;
  duration_ms: number | null; token_total: number; deliverable_count: number;
}
export interface RunsLedgerView {
  summary: {
    in_flight: number; queued: number; completed_today: number; failed_today: number;
    content_runs_today: number; token_total_today: number;
    outcome_unknown: number; frozen_merchant_ids: string[]; day_start: string;
  };
  items: RunLedgerRow[]; offset: number; limit: number; total: number;
}
export interface RunsLedgerRequest {
  merchant_id?: string; status?: AgentRunStatus; stage?: string; include_content?: "true" | "false";
  offset?: number; limit?: number;
}
```

`src/api/seoOpsApi.ts` 在 `stageRun:` 之前加：

```ts
  runsLedger: (request: RunsLedgerRequest = {}, signal?: AbortSignal) =>
    requestJson<RunsLedgerView>(`/api/seo-ops/agent-runs${query(request as SeoOpsPageRequest)}`, { signal }),
```

（`query()` 只读 key/value，用 `as SeoOpsPageRequest` 绕过类型即可；同时在 import 列表加 `RunsLedgerRequest, RunsLedgerView`。）

- [ ] **Step 2: 写失败测试**

在 `src/features/runs/RunsPage.test.tsx` 的 `fetch` mock 中加：

```ts
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: false, core_ai_console_url: "https://core-ai.uat.example" });
    if (path.startsWith("/api/seo-ops/agent-runs")) { ledgerCalls.push(path); return json(ledgerData); }
```

顶部声明：

```ts
const ledgerCalls: string[] = [];
let ledgerData: RunsLedgerView;
```

`beforeEach` 里重置：

```ts
  ledgerCalls.length = 0;
  ledgerData = {
    summary: { in_flight: 1, queued: 1, completed_today: 11, failed_today: 1, content_runs_today: 3, token_total_today: 41200, outcome_unknown: 0, frozen_merchant_ids: [], day_start: "2026-08-27T00:00:00.000Z" },
    items: [{
      id: "8d02b7e5-run", merchant_id: "only-bear", merchant_name: "Only Bear", location_id: null, task_id: null,
      stage: "AUDIT", run_type: "AUDIT", status: "RUNNING", core_run_id: "core-8d02", trace_ref: null, error_code: null,
      triggered_by: "system:scheduler", triggered_at: "2026-08-27T14:20:00.000Z", completed_at: null,
      duration_ms: null, token_total: 41200, deliverable_count: 0,
    }],
    offset: 0, limit: 25, total: 1,
  };
```

新增两个测试：

```ts
test("runs page shows the run summary strip, the ledger table, and the Core AI console link", async () => {
  renderApp();
  const strip = await screen.findByRole("region", { name: "运行汇总" });
  expect(within(strip).getByText("进行中").nextElementSibling).toHaveTextContent("1");
  expect(within(strip).getByText("今日完成").nextElementSibling).toHaveTextContent("11");
  expect(within(strip).getByText("今日 Token").nextElementSibling).toHaveTextContent("41.2k");
  const ledger = await screen.findByRole("region", { name: "运行记录" });
  const row = within(ledger).getByRole("row", { name: /Only Bear/ });
  expect(within(row).getByText("AUDIT")).toBeInTheDocument();
  expect(within(row).getByText("RUNNING")).toBeInTheDocument();
  expect(within(row).getByText("scheduler")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /打开 Core AI 控制台/ })).toHaveAttribute("href", "https://core-ai.uat.example");
});

test("showing content runs refetches the ledger with include_content=true", async () => {
  const user = userEvent.setup();
  renderApp();
  const toggle = await screen.findByRole("checkbox", { name: "显示内容生成 Run" });
  await user.click(toggle);
  expect(ledgerCalls.at(-1)).toContain("include_content=true");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test:run -- src/features/runs/RunsPage.test.tsx`
Expected: FAIL — 找不到 region「运行汇总」。

- [ ] **Step 4: 组件**

`src/features/runs/RunsSummaryStrip.tsx`:

```tsx
import type { RunsLedgerView } from "../../api/types";

export function formatTokens(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function RunsSummaryStrip({ summary, loading }: { summary?: RunsLedgerView["summary"]; loading: boolean }) {
  const cell = (label: string, value: string, hint: string, danger = false) =>
    <div className={`runs-summary-cell${danger ? " is-danger" : ""}`} key={label}><span>{label}</span><strong>{loading || !summary ? "—" : value}</strong><small>{hint}</small></div>;
  const s = summary;
  return <section aria-label="运行汇总" className="runs-summary">
    {cell("进行中", String(s?.in_flight ?? 0), "RUNNING · Core AI 已认领")}
    {cell("排队", String(s?.queued ?? 0), "TRIGGERING · 等 worker 认领")}
    {cell("今日完成", String(s?.completed_today ?? 0), `内容重写 ${s?.content_runs_today ?? 0} 条不计`)}
    {cell("今日失败", String(s?.failed_today ?? 0), "限次自动重试后升级人工")}
    {cell("结果待查", String(s?.outcome_unknown ?? 0), s?.frozen_merchant_ids.length ? `冻结 ${s.frozen_merchant_ids.length} 家商户` : "OUTCOME_UNKNOWN", (s?.outcome_unknown ?? 0) > 0)}
    {cell("今日 Token", formatTokens(s?.token_total_today ?? 0), "按 Core AI token_usage 汇总")}
  </section>;
}
```

`src/features/runs/RunLedgerTable.tsx`:

```tsx
import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { RunLedgerRow } from "../../api/types";
import { formatDateTime } from "../../app/format";
import { formatTokens } from "./RunsSummaryStrip";

export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes}′${String(seconds).padStart(2, "0")}″` : `${seconds}″`;
}

export function triggerLabel(triggeredBy: string): string {
  if (triggeredBy === "system:scheduler") return "scheduler";
  if (triggeredBy === "system:planner-router") return "planner-router";
  if (triggeredBy.startsWith("system:")) return triggeredBy.slice("system:".length);
  return "人工";
}

export function RunLedgerTable({ items, loading, error, onRetry }: { items: RunLedgerRow[]; loading: boolean; error?: unknown; onRetry: () => void }) {
  const navigate = useNavigate();
  return <div className="table-wrap run-ledger">
    {error ? <div className="page-state compact is-error" role="alert">运行记录读取失败。<button onClick={onRetry} type="button">重试</button></div> : null}
    {loading && !items.length ? <div className="page-state" role="status">读取运行记录…</div> : null}
    {items.length ? <table><thead><tr><th>RUN</th><th>商户 · 阶段</th><th>状态</th><th>Tokens</th><th>耗时</th><th>触发</th><th>交付物</th><th>时间</th><th /></tr></thead><tbody>
      {items.map((run) => <tr aria-label={`${run.merchant_name} ${run.stage} ${run.status}`} key={run.id}>
        <td><code>{run.core_run_id ? `${run.core_run_id.slice(0, 8)}…` : "——（无 run_id）"}</code></td>
        <td><strong>{run.merchant_name}</strong><small>{run.stage} · {run.run_type}</small></td>
        <td><span className={`status-pill is-${run.status.toLocaleLowerCase()}`}>{run.status}</span>{run.error_code ? <small>{run.error_code}</small> : null}</td>
        <td>{run.token_total ? formatTokens(run.token_total) : "—"}</td>
        <td>{formatDuration(run.duration_ms)}</td>
        <td>{triggerLabel(run.triggered_by)}</td>
        <td>{run.deliverable_count ? `${run.deliverable_count} 附件` : "—"}</td>
        <td>{formatDateTime(run.completed_at ?? run.triggered_at)}</td>
        <td>{run.task_id ? <button aria-label={`打开任务 ${run.task_id}`} className="row-arrow" onClick={() => navigate(`/tasks/${run.task_id}`)} type="button"><ArrowRight size={14} /></button> : null}</td>
      </tr>)}
    </tbody></table> : null}
    {!loading && !error && !items.length ? <div className="empty-state slim"><p>当前筛选没有 Run 记录。</p></div> : null}
  </div>;
}
```

- [ ] **Step 5: 改 RunsPage**

在 `AuditRunsLedger` 内新增状态与资源（放在现有 `usePagedInbox` 之后）：

```tsx
  const workspace = useWorkspace();
  const config = useResource((signal) => seoOpsApi.config(signal), []);
  const [includeContent, setIncludeContent] = useState(false);
  const [ledgerStatus, setLedgerStatus] = useState<AgentRunStatus | "">("");
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const ledger = useResource((signal) => seoOpsApi.runsLedger({
    merchant_id: workspace.merchantId, status: ledgerStatus || undefined,
    include_content: includeContent ? "true" : "false", offset: ledgerOffset, limit: 25,
  }, signal), [workspace.merchantId, ledgerStatus, includeContent, ledgerOffset]);
```

新增 import：`useWorkspace`、`useResource`、`AgentRunStatus` 类型、`RunsSummaryStrip`、`RunLedgerTable`、`safeHref`。`reloadAll` 里追加 `ledger.reload()`。

header 的 `heading-actions` 里在刷新按钮前加：

```tsx
      {safeHref(config.data?.core_ai_console_url) ? <a className="secondary-button" href={safeHref(config.data?.core_ai_console_url)!} rel="noreferrer" target="_blank">打开 Core AI 控制台 ↗</a> : null}
```

header 之后、第一个 `QueuePanel` 之前插入 `<RunsSummaryStrip loading={ledger.loading && !ledger.data} summary={ledger.data?.summary} />`。

最后一个 `QueuePanel` 之后、`{resolving ? …}` 之前插入：

```tsx
    <section aria-label="运行记录" className="data-panel run-ledger-panel">
      <div className="panel-heading"><div><span className="eyebrow">AGENT RUNS / CORE AI</span><h2>运行记录</h2><p className="quiet-copy">默认视图：阶段 + 执行 Run；内容重写默认隐藏（不占执行配额）。Run 完成 ≠ 任务完成。</p></div>
        <div className="filters">
          <label>状态<select onChange={(event) => { setLedgerStatus(event.target.value as AgentRunStatus | ""); setLedgerOffset(0); }} value={ledgerStatus}>
            <option value="">全部</option><option value="TRIGGERING">排队</option><option value="RUNNING">进行中</option><option value="COMPLETED">已完成</option><option value="FAILED">失败</option><option value="CANCELLED">已取消</option>
          </select></label>
          <label className="checkbox-label"><input checked={includeContent} onChange={(event) => { setIncludeContent(event.target.checked); setLedgerOffset(0); }} type="checkbox" /> 显示内容生成 Run</label>
        </div></div>
      <RunLedgerTable error={ledger.error} items={ledger.data?.items ?? []} loading={ledger.loading} onRetry={ledger.reload} />
      {ledger.data && ledger.data.total > ledger.data.limit ? <div className="pagination">
        <button disabled={ledger.data.offset === 0} onClick={() => setLedgerOffset(Math.max(0, ledger.data!.offset - ledger.data!.limit))} type="button">上一页</button>
        <span>显示 {ledger.data.offset + 1}–{Math.min(ledger.data.offset + ledger.data.limit, ledger.data.total)} / {ledger.data.total}</span>
        <button disabled={ledger.data.offset + ledger.data.limit >= ledger.data.total} onClick={() => setLedgerOffset(ledger.data!.offset + ledger.data!.limit)} type="button">下一页</button>
      </div> : null}
    </section>
```

- [ ] **Step 6: 样式**

`src/styles/runs.css`（并在 `src/styles.css` 的 `@import "./styles/review-settings.css";` 后加 `@import "./styles/runs.css";`）：

```css
/* 运行页：汇总条 + Run 账本 */
.runs-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); margin-bottom: 20px; border: 1px solid var(--rule); background: var(--surface); }
.runs-summary-cell { padding: 11px 13px; border-right: 1px solid var(--rule); }
.runs-summary-cell:last-child { border-right: 0; }
.runs-summary-cell span, .runs-summary-cell small { display: block; color: var(--ink-muted); font-size: 10px; line-height: 1.45; }
.runs-summary-cell strong { display: block; margin: 3px 0; font: 20px/1 var(--font-data); }
.runs-summary-cell small { font-size: 8px; }
.runs-summary-cell.is-danger strong { color: var(--red); }
.run-ledger-panel .filters { display: flex; align-items: end; gap: 12px; }
.run-ledger-panel .checkbox-label { display: inline-flex; align-items: center; gap: 6px; font-size: 10px; color: var(--ink-muted); }
.run-ledger td small { display: block; color: var(--ink-muted); font-size: 8px; }
.run-ledger code { font-size: 9px; }
.status-pill.is-running, .status-pill.is-triggering { background: #e8f3f4; color: #174a55; }
.status-pill.is-completed { background: #e6f4ee; color: #147a6c; }
.status-pill.is-failed, .status-pill.is-cancelled { background: var(--red-soft); color: var(--red); }
@media (max-width: 900px) { .runs-summary { grid-template-columns: repeat(2, 1fr); } .runs-summary-cell { border-bottom: 1px solid var(--rule); } }
```

- [ ] **Step 7: SystemStatusPanel 接入真实 Run 信号**

`src/features/settings/SystemStatusPanel.tsx`：把 `UNSUPPORTED_FIELDS` 改为 `["Scheduler 心跳", "Worker 心跳", "Core AI 配额"]`；新增 `const runs = useResource((signal) => seoOpsApi.runsLedger({ limit: 1 }, signal), []);`，刷新按钮里加 `runs.reload()`；在「结果待查」卡后面加两张卡：

```tsx
      <div className="system-truth-card"><span>Run 容量</span>{runs.loading ? <strong>读取中…</strong> : runs.error ? <strong className="danger-text">读取失败</strong> : <strong className="truth-available">{runs.data?.summary.in_flight ?? 0} 在途 · {runs.data?.summary.queued ?? 0} 排队</strong>}<small>来源：/api/seo-ops/agent-runs</small></div>
      <div className="system-truth-card"><span>近期失败数</span>{runs.loading ? <strong>读取中…</strong> : runs.error ? <strong className="danger-text">读取失败</strong> : <strong className={runs.data?.summary.failed_today ? "truth-attention" : "truth-available"}>{runs.data?.summary.failed_today ?? 0}</strong>}<small>今日 FAILED Run · 来源：/api/seo-ops/agent-runs</small></div>
```

`SettingsPage.test.tsx` 第 188 行附近的测试断言「不可用」字段列表：把 `Run 容量`/`近期失败数` 从不可用断言中移除，并在 mock 中给 `/api/seo-ops/agent-runs` 返回一个 summary（`in_flight: 0, queued: 0, failed_today: 0` 等）。先阅读该测试再改，保持其余断言不变。

- [ ] **Step 8: 跑测试与构建**

Run: `npm run test:run -- src/features/runs/RunsPage.test.tsx src/features/settings/SettingsPage.test.tsx && npm run build`
Expected: PASS；build 无类型错误。

- [ ] **Step 9: 提交**

```bash
git add src/api src/features/runs src/features/settings/SystemStatusPanel.tsx src/features/settings/SettingsPage.test.tsx src/styles/runs.css src/styles.css
git commit -m "feat(runs): render run summary strip and cross-merchant run ledger"
```

---

### Task 3: 总览 — 异常清单、今日信号、核验逾期

**Files:**
- Create: `server/src/services/activityFeedService.ts`
- Modify: `server/src/routes/seoOps.ts`（`GET /api/seo-ops/activity`）、`server/src/routes/executionRoutes.ts`（inbox-summary 加 `verification_overdue`）
- Test: `server/tests/activityFeed.test.ts`
- Modify: `src/api/types.ts`、`src/api/seoOpsApi.ts`
- Create: `src/features/overview/exceptionGroups.ts`、`src/features/overview/exceptionGroups.test.ts`、`src/features/overview/OverviewPage.test.tsx`、`src/styles/overview.css`
- Modify: `src/features/overview/OverviewPage.tsx`、`src/styles.css`

**Interfaces:**
- Consumes: `listTasks`、`listBatchViews`（`proposalService.js`）、`listAgentRunsForSummary`（Task 1）、`GET /api/seo-ops/workbench`（既有）、`GET /api/seo-ops/agent-runs`（Task 1）。
- Produces: `GET /api/seo-ops/activity?hours=24&limit=20` → `{ items: ActivityItem[], since: string }`；`InboxSummaryWire.verification_overdue: number`。

- [ ] **Step 1: 服务端失败测试**

`server/tests/activityFeed.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { describeTaskEvent } from "../src/services/activityFeedService.js";

describe("activity feed", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "feed-a", display_name: "Feed A", operator_user_ids: [built.actor.userId], idempotency_key: "feed-a" },
    })).json().id;
    await app.inject({
      method: "POST", url: "/api/seo-ops/proposal-batches",
      payload: { merchant_id: merchantId, origin: "MANUAL", trigger_reason: "问卷回收", idempotency_key: "feed-batch",
        items: [{ title: "建立排名基线", task_type: "REPORT", execution_mode: "MANUAL", priority: "MEDIUM", impact: "MEDIUM", execution_spec: "{}" }] },
    });
    await app.inject({
      method: "POST", url: "/api/seo-ops/tasks",
      payload: { merchant_id: merchantId, idempotency_key: "feed-task", definition: {
        title: "营业时间变更", task_type: "GBP_UPDATE", source: "OPERATOR", priority: "HIGH", impact: "MEDIUM",
        execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } },
    });
  });

  afterEach(async () => app.close());

  it("maps task event types to plain-language signals", () => {
    expect(describeTaskEvent("OUTCOME_UNKNOWN")).toMatchObject({ severity: "DANGER" });
    expect(describeTaskEvent("TASK_CREATED").title).toContain("创建");
    expect(describeTaskEvent("SOMETHING_NEW").title).toBe("SOMETHING_NEW");
  });

  it("lists recent task events and proposal batches newest first with merchant names and links", async () => {
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=10" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const created = items.find((i) => i.kind === "TASK_EVENT");
    expect(created).toMatchObject({ merchant_name: "Feed A", severity: "INFO" });
    expect(String(created?.href)).toMatch(/^\/tasks\//);
    const batch = items.find((i) => i.kind === "PROPOSAL_BATCH");
    expect(batch).toMatchObject({ merchant_name: "Feed A", href: `/inbox?tab=proposals&merchant_id=${merchantId}` });
    expect(String(batch?.title)).toContain("1 条");
    for (let i = 1; i < items.length; i += 1) {
      expect(String(items[i - 1]!.occurred_at) >= String(items[i]!.occurred_at)).toBe(true);
    }
  });

  it("inbox-summary reports verification_overdue", async () => {
    const summary = (await app.inject({ method: "GET", url: "/api/seo-ops/inbox-summary" })).json();
    expect(summary).toHaveProperty("verification_overdue", 0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd server && npm test -- tests/activityFeed.test.ts`
Expected: FAIL — 模块不存在。

- [ ] **Step 3: 服务**

`server/src/services/activityFeedService.ts`:

```ts
import type { Db } from "../db/connection.js";
import { listAgentRunsForSummary } from "../repos/agentRunRepo.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { listTasks } from "../repos/taskRepo.js";
import { listBatchViews } from "./proposalService.js";

export type ActivitySeverity = "INFO" | "WARN" | "DANGER";
export interface ActivityItemWire {
  id: string; kind: "TASK_EVENT" | "AGENT_RUN" | "PROPOSAL_BATCH";
  occurred_at: string; merchant_id: string; merchant_name: string;
  title: string; detail: string | null; href: string; severity: ActivitySeverity;
}
export interface ActivityFeedWire { items: ActivityItemWire[]; since: string }

const TASK_EVENT_COPY: Record<string, { title: string; severity: ActivitySeverity }> = {
  TASK_CREATED: { title: "任务已创建", severity: "INFO" },
  TASK_REVISED: { title: "任务新修订（旧审批作废）", severity: "INFO" },
  EVIDENCE_APPENDED: { title: "证据已附加", severity: "INFO" },
  CONTENT_DRAFT_REVISED: { title: "内容稿已更新", severity: "INFO" },
  AUTO_AUTHORIZED: { title: "只读任务按周期预授权", severity: "INFO" },
  EXECUTION_CONFIRMED: { title: "门 2 执行确认已登记", severity: "INFO" },
  GBP_EXECUTION_CONFIRMED: { title: "GBP 发布确认已登记", severity: "INFO" },
  ATTEMPT_DISPATCHING: { title: "已派发 attempt，等待 Core AI 终态", severity: "INFO" },
  EXECUTION_SUCCEEDED: { title: "执行成功 · 进入核验（发布 ≠ 已验证）", severity: "INFO" },
  EXECUTION_FAILED: { title: "执行失败已确认，未产生外部写入", severity: "WARN" },
  OUTCOME_UNKNOWN: { title: "执行结果不确定 · 该商户执行链已冻结", severity: "DANGER" },
  VERIFIED: { title: "核验通过", severity: "INFO" },
  TASK_DONE: { title: "任务已完成归档", severity: "INFO" },
  MANUAL_COMPLETED: { title: "人工完成已记录", severity: "INFO" },
  FAILED_RESET: { title: "排障后重置回已批准", severity: "WARN" },
  CONVERSATION_LINKED: { title: "对话已关联", severity: "INFO" },
};

export function describeTaskEvent(type: string): { title: string; severity: ActivitySeverity } {
  return TASK_EVENT_COPY[type] ?? { title: type, severity: type.includes("FAIL") || type.includes("REVOK") ? "WARN" : "INFO" };
}

/** 今日信号：任务事件 + Run 终态 + 建议批次，纯只读投影，按时间倒序。 */
export async function activityFeed(
  db: Db,
  actorUserId: string,
  scopeAll: boolean,
  options: { hours: number; limit: number },
  now: Date = new Date(),
): Promise<ActivityFeedWire> {
  const merchants = scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, actorUserId);
  const names = new Map(merchants.map((m) => [m.id, m.displayName]));
  const since = new Date(now.getTime() - options.hours * 3_600_000).toISOString();
  const items: ActivityItemWire[] = [];

  for (const task of (await listTasks(db)).filter((t) => names.has(t.merchantId))) {
    for (const event of task.events) {
      if (event.occurredAt < since) continue;
      const copy = describeTaskEvent(event.type);
      items.push({
        id: `event:${event.id}`, kind: "TASK_EVENT", occurred_at: event.occurredAt,
        merchant_id: task.merchantId, merchant_name: names.get(task.merchantId)!,
        title: copy.title, detail: task.title, href: `/tasks/${task.id}`, severity: copy.severity,
      });
    }
  }

  for (const run of await listAgentRunsForSummary(db, scopeAll ? null : [...names.keys()], since)) {
    if (!run.completedAt || run.completedAt < since || !names.has(run.merchantId)) continue;
    if (run.status !== "COMPLETED" && run.status !== "FAILED") continue;
    items.push({
      id: `run:${run.id}`, kind: "AGENT_RUN", occurred_at: run.completedAt,
      merchant_id: run.merchantId, merchant_name: names.get(run.merchantId)!,
      title: run.status === "COMPLETED" ? `${run.stage} Run 完成` : `${run.stage} Run 失败${run.errorCode ? ` · ${run.errorCode}` : ""}`,
      detail: run.goal, href: run.taskId ? `/tasks/${run.taskId}` : `/runs?view=audit`,
      severity: run.status === "FAILED" ? "WARN" : "INFO",
    });
  }

  for (const view of (await listBatchViews(db)).filter((v) => names.has(v.batch.merchantId))) {
    if (view.batch.createdAt < since) continue;
    const pending = view.proposals.filter((p) => p.status === "PENDING" || p.status === "VALIDATION_FAILED").length;
    items.push({
      id: `batch:${view.batch.id}`, kind: "PROPOSAL_BATCH", occurred_at: view.batch.createdAt,
      merchant_id: view.batch.merchantId, merchant_name: names.get(view.batch.merchantId)!,
      title: `Planner 建议 ${view.proposals.length} 条${pending ? `（${pending} 条待判定）` : "（已判定）"}`,
      detail: view.batch.triggerReason, href: `/inbox?tab=proposals&merchant_id=${view.batch.merchantId}`,
      severity: "INFO",
    });
  }

  items.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || a.id.localeCompare(b.id));
  return { items: items.slice(0, options.limit), since };
}
```

- [ ] **Step 4: 路由与 inbox-summary**

`seoOps.ts` import `activityFeed`，并在 `/api/seo-ops/reports` 路由后追加：

```ts
  const activityQuerySchema = z.object({
    hours: z.coerce.number().int().min(1).max(168).default(24),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  });

  app.get("/api/seo-ops/activity", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const query = activityQuerySchema.parse(request.query);
    return activityFeed(ctx.db, actor.userId, actor.scopeAll === true, query);
  });
```

`executionRoutes.ts` 的 `/api/seo-ops/inbox-summary` 返回对象追加：

```ts
      verification_overdue: pendingVerify.filter((t) => t.verifyDueAt && Date.parse(t.verifyDueAt) < Date.now()).length,
```

- [ ] **Step 5: 服务端测试通过并提交**

Run: `cd server && npm test -- tests/activityFeed.test.ts tests/workbench.test.ts && npm run typecheck`

```bash
git add server/src/services/activityFeedService.ts server/src/routes/seoOps.ts server/src/routes/executionRoutes.ts server/tests/activityFeed.test.ts
git commit -m "feat(overview): add activity feed projection and verification overdue count"
```

- [ ] **Step 6: 前端类型/客户端**

`src/api/types.ts`：`InboxSummaryWire` 加 `verification_overdue: number;`，并追加：

```ts
export type ActivitySeverity = "INFO" | "WARN" | "DANGER";
export interface ActivityItem {
  id: string; kind: "TASK_EVENT" | "AGENT_RUN" | "PROPOSAL_BATCH"; occurred_at: string;
  merchant_id: string; merchant_name: string; title: string; detail: string | null; href: string; severity: ActivitySeverity;
}
export interface ActivityFeedView { items: ActivityItem[]; since: string }
```

`seoOpsApi.ts` 在 `inboxSummary` 后加：

```ts
  activity: (request: { hours?: number; limit?: number } = {}, signal?: AbortSignal) =>
    requestJson<ActivityFeedView>(`/api/seo-ops/activity${query(request as SeoOpsPageRequest)}`, { signal }),
```

所有既有前端测试里 mock `/api/seo-ops/inbox-summary` 的对象都要补 `verification_overdue: 0`（`grep -rl "pending_proposals" src --include='*.test.tsx'` 逐个加），否则 TS 会因 fixture 类型不完整报错。

- [ ] **Step 7: 分组纯函数 + 单测**

`src/features/overview/exceptionGroups.ts`:

```ts
import type { HumanActionType, HumanActionWire } from "../../api/types";

export type ExceptionGroupKey = "UNKNOWN" | "MERCHANT" | "PROPOSAL" | "APPROVAL" | "VERIFY";

export const EXCEPTION_GROUPS: Array<{ key: ExceptionGroupKey; label: string; badge: string; hint: string; types: HumanActionType[] }> = [
  { key: "UNKNOWN", label: "结果不确定", badge: "待查", hint: "执行链路已冻结 · 查证是唯一出口", types: ["OUTCOME_RECONCILIATION", "CONFIRMED_FAILURE"] },
  { key: "MERCHANT", label: "等待商家", badge: "商家", hint: "外部依赖 · 到点提醒跟进", types: ["QUESTIONNAIRE_FOLLOWUP", "AUTHORIZATION_FOLLOWUP", "CONTENT_CONFIRMATION", "REPORT_DELIVERY"] },
  { key: "PROPOSAL", label: "建议待判定", badge: "建议", hint: "Agent 只能建议 · SEO Ops 判定落库", types: ["PROPOSAL_DECISION"] },
  { key: "APPROVAL", label: "待审批与确认", badge: "审批", hint: "门 1 仅授权 · 门 2 才派发", types: ["GATE_1_APPROVAL", "GATE_2_CONFIRM", "ARTIFACT_ACCEPTANCE"] },
  { key: "VERIFY", label: "核验与复查", badge: "核验", hint: "发布 ≠ 已验证", types: ["VERIFICATION_OVERDUE"] },
];

/** 按设计稿五组归类；组内按等待时长（waiting_since 升序 = 卡得最久在前）。 */
export function groupExceptions(items: HumanActionWire[]): Array<{ group: (typeof EXCEPTION_GROUPS)[number]; items: HumanActionWire[] }> {
  return EXCEPTION_GROUPS.map((group) => ({
    group,
    items: items.filter((item) => group.types.includes(item.type)).sort((a, b) => a.waiting_since.localeCompare(b.waiting_since)),
  })).filter((entry) => entry.items.length > 0);
}

export function waitingLabel(waitingSince: string, now = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(waitingSince)) / 3_600_000));
  if (hours < 1) return "刚刚";
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
```

`src/features/overview/exceptionGroups.test.ts`:

```ts
import { expect, test } from "vitest";
import type { HumanActionWire } from "../../api/types";
import { groupExceptions, waitingLabel } from "./exceptionGroups";

const base = (over: Partial<HumanActionWire>): HumanActionWire => ({
  id: "x", group: "EXCEPTION", type: "OUTCOME_RECONCILIATION", merchant_id: "m", merchant_name: "M", location_name: null,
  title: "t", reason: "r", primary_action: { label: "go", href: "/" }, secondary_href: null, priority: "HIGH", due_at: null,
  waiting_since: "2026-08-27T10:00:00Z", ...over,
});

test("groups by design categories and orders longest-waiting first", () => {
  const grouped = groupExceptions([
    base({ id: "a", type: "GATE_1_APPROVAL", waiting_since: "2026-08-27T12:00:00Z" }),
    base({ id: "b", type: "GATE_2_CONFIRM", waiting_since: "2026-08-25T12:00:00Z" }),
    base({ id: "c", type: "OUTCOME_RECONCILIATION" }),
  ]);
  expect(grouped.map((g) => g.group.key)).toEqual(["UNKNOWN", "APPROVAL"]);
  expect(grouped[1]!.items.map((i) => i.id)).toEqual(["b", "a"]);
});

test("waitingLabel renders hours under two days and days beyond", () => {
  const now = Date.parse("2026-08-27T15:00:00Z");
  expect(waitingLabel("2026-08-27T13:00:00Z", now)).toBe("2 小时");
  expect(waitingLabel("2026-08-22T13:00:00Z", now)).toBe("5 天");
});
```

- [ ] **Step 8: 页面失败测试**

`src/features/overview/OverviewPage.test.tsx`（沿用 `WorkbenchPage.test.tsx` 的 `renderApp` / `json` 写法，路径 `"/?view=audit"`）。mock：`/api/auth/me` → `userFixture`；`/api/seo-ops/portfolio` → `portfolioFixture`；`/api/seo-ops/inbox-summary` → `{ pending_proposals: 2, ready_for_approval: 12, awaiting_execution: 3, pending_verify: 4, outcome_unknown: 1, verification_overdue: 2, frozen_merchant_ids: ["only-bear"] }`；`/api/seo-ops/workbench` → 含一条 `OUTCOME_RECONCILIATION`（merchant Only Bear，waiting_since 2 小时前）与一条 `GATE_1_APPROVAL`；`/api/seo-ops/activity` → `{ items: [{ id: "e1", kind: "TASK_EVENT", occurred_at: "...", merchant_id: "only-bear", merchant_name: "Only Bear", title: "执行结果不确定 · 该商户执行链已冻结", detail: "GBP Post 发布", href: "/tasks/t1", severity: "DANGER" }], since: "..." }`；`/api/seo-ops/agent-runs` → Task 2 的 `ledgerData` 形状。

```tsx
test("overview leads with the exception ledger grouped by design category", async () => {
  renderApp("/?view=audit");
  expect(await screen.findByRole("heading", { name: "总览" })).toBeInTheDocument();
  const strip = screen.getByRole("region", { name: "待处理汇总" });
  expect(within(strip).getByText("核验逾期").nextElementSibling).toHaveTextContent("2");
  const ledger = await screen.findByRole("region", { name: "异常清单" });
  expect(within(ledger).getByRole("heading", { name: "结果不确定" })).toBeInTheDocument();
  const row = within(ledger).getByRole("article", { name: /Only Bear.*结果不确定/ });
  expect(within(row).getByRole("button", { name: "去查证" })).toBeInTheDocument();
  expect(within(ledger).getByRole("heading", { name: "待审批与确认" })).toBeInTheDocument();
});

test("overview renders today's signals and run capacity from backend projections", async () => {
  renderApp("/?view=audit");
  const signals = await screen.findByRole("region", { name: "今日信号" });
  expect(within(signals).getByText(/执行结果不确定/)).toBeInTheDocument();
  expect(within(signals).getByRole("link", { name: /GBP Post 发布/ })).toHaveAttribute("href", "/tasks/t1");
  const capacity = screen.getByRole("region", { name: "Run 容量" });
  expect(within(capacity).getByText("并发 / 配额")).toBeInTheDocument();
  expect(within(capacity).getByText(/未接入/)).toBeInTheDocument();
});
```

- [ ] **Step 9: 重写 OverviewPage**

```tsx
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { formatDateTime } from "../../app/format";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { formatTokens } from "../runs/RunsSummaryStrip";
import { groupExceptions, waitingLabel } from "./exceptionGroups";

/** 总览（管理审计）：先处理挡在路上的事——结果查证、商家等待、建议判定、审批与核验。
 * 异常清单直接复用 workbench 投影（同一批人工决策点），只是按设计稿五组重新归类。 */
export function OverviewPage() {
  const navigate = useNavigate();
  usePageTitle("总览");
  const workspace = useWorkspace();
  const summary = useResource((signal) => seoOpsApi.inboxSummary(signal), []);
  const actions = useResource((signal) => seoOpsApi.workbench({ limit: 100 }, signal), []);
  const activity = useResource((signal) => seoOpsApi.activity({ hours: 24, limit: 20 }, signal), []);
  const runs = useResource((signal) => seoOpsApi.runsLedger({ limit: 1 }, signal), []);
  const s = summary.data;
  const grouped = groupExceptions(actions.data?.items ?? []);
  const frozenNames = (s?.frozen_merchant_ids ?? []).map((id) => workspace.merchants.find((m) => m.id === id)?.display_name ?? id);
  const cells = [
    { label: "待判定建议", value: s?.pending_proposals, to: "/inbox?tab=proposals&view=audit" },
    { label: "待审批 · 门 1", value: s?.ready_for_approval, to: "/inbox?status=READY_FOR_APPROVAL&view=audit" },
    { label: "待执行确认 · 门 2", value: s?.awaiting_execution, to: "/runs?view=audit" },
    { label: "结果待查", value: s?.outcome_unknown, to: "/runs?view=audit", danger: true },
    { label: "核验逾期", value: s?.verification_overdue, to: "/inbox?status=PENDING_VERIFY&view=audit" },
    { label: "今日 Agent Run", value: runs.data ? runs.data.summary.completed_today + runs.data.summary.failed_today : undefined, to: "/runs?view=audit" },
  ];
  const total = grouped.reduce((n, g) => n + g.items.length, 0);
  const merchantsInvolved = new Set((actions.data?.items ?? []).map((i) => i.merchant_id)).size;

  return <>
    <header className="page-heading"><div><span className="eyebrow">PORTFOLIO · {new Date().toLocaleDateString("zh-CN")} · {workspace.merchants.length} 家商户</span><h1>总览</h1><p>先处理挡在路上的事：结果查证、商家等待、建议判定、审批与核验。其余商户在轨运行。</p></div>
      <div className="heading-actions"><button className="secondary-button" onClick={() => { summary.reload(); actions.reload(); activity.reload(); runs.reload(); }} type="button">刷新</button><button className="primary-button" onClick={() => navigate("/merchants?view=audit")} type="button">＋ 新商户</button></div>
    </header>

    <section aria-label="待处理汇总" className="overview-summary">
      <div className="overview-summary-lead"><span>待处理事项</span><strong>{actions.loading ? "—" : total}</strong><small>涉及 {merchantsInvolved} 家 / 共 {workspace.merchants.length} 家</small></div>
      {cells.map((cell) => <button className={`overview-summary-cell${cell.danger && (cell.value ?? 0) > 0 ? " is-danger" : ""}`} key={cell.label} onClick={() => navigate(cell.to)} type="button"><span>{cell.label}</span><strong>{cell.value ?? "—"}</strong></button>)}
    </section>

    {(s?.outcome_unknown ?? 0) > 0 ? <section className="frozen-banner" role="alert"><AlertTriangle size={16} /><div><strong>{s?.outcome_unknown} 个执行结果待查</strong><p>涉及商户：{frozenNames.join("、")} —— 查证完成前，这些商户的执行链全部冻结（结果不确定不重试）。</p></div><button className="danger-button" onClick={() => navigate("/runs?view=audit")} type="button">去查证 <ArrowRight size={13} /></button></section> : null}

    <div className="overview-grid">
      <section aria-label="异常清单" className="data-panel overview-exceptions">
        <div className="panel-heading"><div><span className="eyebrow">EXCEPTION LEDGER</span><h2>异常清单</h2><p className="quiet-copy">{total} 项待处理 · 组内按卡住时长排序</p></div></div>
        {actions.loading ? <div className="page-state" role="status">读取待处理事项…</div> : null}
        {actions.error ? <div className="page-state is-error" role="alert">异常清单读取失败。<button onClick={actions.reload} type="button">重试</button></div> : null}
        {!actions.loading && !actions.error && !total ? <div className="empty-state slim"><p>今天没有需要人工处理的事项。</p></div> : null}
        {grouped.map(({ group, items }) => <section className={`exception-group is-${group.key.toLowerCase()}`} key={group.key}>
          <header><span className="exception-badge">{group.badge}</span><h3>{group.label}</h3><small>{group.hint}</small><em>{items.length}</em></header>
          {items.map((item) => <article aria-label={`${item.merchant_name} ${group.label} ${item.title}`} className="exception-row" key={item.id}>
            <div className="exception-copy"><strong>{item.merchant_name}{item.location_name ? <small> · {item.location_name}</small> : null}</strong><p>{item.title} — {item.reason}</p></div>
            <time dateTime={item.waiting_since}>{waitingLabel(item.waiting_since)}</time>
            <button className="action-primary" onClick={() => navigate(item.primary_action.href)} type="button">{item.primary_action.label}</button>
          </article>)}
        </section>)}
      </section>

      <div className="overview-side">
        <section aria-label="今日信号" className="data-panel overview-signals">
          <div className="panel-heading"><div><span className="eyebrow">SCHEDULER · EVENT ROUTER</span><h2>今日信号</h2></div></div>
          {activity.loading ? <div className="page-state compact" role="status">读取信号…</div> : null}
          {activity.error ? <div className="page-state compact is-error" role="alert">信号读取失败。</div> : null}
          <ol className="signal-list">{(activity.data?.items ?? []).map((item) => <li className={`is-${item.severity.toLowerCase()}`} key={item.id}>
            <time dateTime={item.occurred_at}>{formatDateTime(item.occurred_at)}</time>
            <div><strong>{item.title}</strong><span>{item.merchant_name}{item.detail ? <> · <Link to={item.href}>{item.detail}</Link></> : <> · <Link to={item.href}>查看</Link></>}</span></div>
          </li>)}</ol>
          {activity.data && !activity.data.items.length ? <p className="quiet-copy">过去 24 小时没有信号。</p> : null}
        </section>

        <section aria-label="Run 容量" className="data-panel overview-capacity">
          <div className="panel-heading"><div><span className="eyebrow">CORE AI SERVER</span><h2>Run 容量</h2></div></div>
          <dl className="identity-ledger">
            <div><dt>在途 / 排队</dt><dd>{runs.data ? `${runs.data.summary.in_flight} / ${runs.data.summary.queued}` : "—"}</dd></div>
            <div><dt>今日完成 / 失败</dt><dd>{runs.data ? `${runs.data.summary.completed_today} / ${runs.data.summary.failed_today}` : "—"}</dd></div>
            <div><dt>今日 Token</dt><dd>{runs.data ? formatTokens(runs.data.summary.token_total_today) : "—"}</dd></div>
            <div><dt>并发 / 配额</dt><dd>配额未接入 · 当前 API 未提供</dd></div>
          </dl>
          <Link className="text-button" to="/runs?view=audit">查看完整运行账本 <ArrowRight size={12} /></Link>
        </section>
      </div>
    </div>
  </>;
}
```

- [ ] **Step 10: 样式**

`src/styles/overview.css`（并在 `styles.css` 里 import）：

```css
.overview-summary { display: grid; grid-template-columns: 1.4fr repeat(6, minmax(0, 1fr)); margin-bottom: 18px; border: 1px solid var(--rule); background: var(--surface); }
.overview-summary-lead, .overview-summary-cell { padding: 11px 13px; border-right: 1px solid var(--rule); text-align: left; }
.overview-summary-cell { border-top: 0; border-bottom: 0; border-left: 0; border-radius: 0; background: var(--surface); color: var(--ink); cursor: pointer; }
.overview-summary-cell:hover { background: #f1f6f8; box-shadow: inset 0 -2px var(--teal); }
.overview-summary > :last-child { border-right: 0; }
.overview-summary span, .overview-summary small { display: block; color: var(--ink-muted); font-size: 10px; line-height: 1.45; }
.overview-summary strong { display: block; margin: 3px 0; font: 20px/1 var(--font-data); }
.overview-summary-cell.is-danger strong { color: var(--red); }
.overview-grid { display: grid; grid-template-columns: minmax(0, 1.7fr) minmax(300px, 1fr); gap: 18px; align-items: start; }
.overview-side { display: grid; gap: 18px; }
.exception-group { border-top: 1px solid var(--rule); }
.exception-group > header { display: flex; align-items: baseline; gap: 9px; padding: 9px 12px 6px; }
.exception-group h3 { margin: 0; font-size: 12px; }
.exception-group header small { flex: 1; color: var(--ink-muted); font-size: 9px; }
.exception-group header em { color: var(--ink-muted); font: 10px var(--font-data); }
.exception-badge { padding: 1px 6px; border: 1px solid var(--rule); font: 8px var(--font-data); letter-spacing: .08em; }
.exception-group.is-unknown .exception-badge { border-color: var(--red); color: var(--red); }
.exception-group.is-proposal .exception-badge { border-color: var(--cyan); color: var(--cyan); }
.exception-group.is-approval .exception-badge { border-color: var(--amber); color: var(--amber); }
.exception-group.is-merchant .exception-badge, .exception-group.is-verify .exception-badge { border-color: var(--teal); color: var(--teal); }
.exception-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 12px; padding: 7px 12px; border-top: 1px solid var(--line-soft); }
.exception-copy strong { display: block; font-size: 10px; }
.exception-copy strong small { color: var(--ink-muted); font-weight: 400; }
.exception-copy p { margin: 2px 0 0; color: var(--ink-muted); font-size: 9px; line-height: 1.4; }
.exception-row time { color: var(--ink-muted); font: 9px var(--font-data); }
.signal-list { margin: 0; padding: 0; list-style: none; }
.signal-list li { display: grid; grid-template-columns: 62px minmax(0, 1fr); gap: 10px; padding: 7px 0; border-top: 1px solid var(--line-soft); font-size: 9px; }
.signal-list time { color: var(--ink-muted); font-family: var(--font-data); }
.signal-list strong { display: block; font-size: 10px; }
.signal-list span { color: var(--ink-muted); }
.signal-list li.is-danger strong { color: var(--red); }
.signal-list li.is-warn strong { color: var(--amber); }
.signal-list a { text-decoration: underline; text-underline-offset: 2px; }
@media (max-width: 1100px) { .overview-summary { grid-template-columns: repeat(4, 1fr); } .overview-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 11: 测试、构建、提交**

Run: `npm run test:run -- src/features/overview src/App.test.tsx && npm run build`

```bash
git add src/api src/features/overview src/styles/overview.css src/styles.css $(git ls-files -m src)
git commit -m "feat(overview): exception ledger, today's signals, and run capacity"
```

---

### Task 4: 待判定 — 批次判定、编辑后采纳、手动请求 Planner

**Files:**
- Modify: `server/src/routes/seoOps.ts`（`POST /api/seo-ops/merchants/:merchantId/planner-requests`）
- Test: `server/tests/plannerRequest.test.ts`
- Modify: `src/api/seoOpsApi.ts`、`src/features/inbox/ProposalsTab.tsx`
- Create: `src/features/inbox/AdoptDialog.tsx`、`src/features/inbox/PlannerRequestButton.tsx`、`src/features/inbox/ProposalsTab.test.tsx`

**Interfaces:**
- Consumes: `enqueuePlannerTaskIfBound`（已 import 于 seoOps.ts）、`getAgentBinding`（`repos/settingsRepo.js`）、`decideProposal` 的 `override_priority` / `override_due_at`。
- Produces: `POST …/planner-requests { reason, idempotency_key }` → `201 { task_id, replayed: false }` / `200 { …, replayed: true }` / `409 PLANNER_NOT_BOUND`；`seoOpsApi.requestPlanner(merchantId, body)`。

- [ ] **Step 1: 服务端失败测试**

`server/tests/plannerRequest.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("manual planner request", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "planner-req", display_name: "Planner Req", operator_user_ids: [built.actor.userId], idempotency_key: "planner-req" },
    })).json().id;
  });

  afterEach(async () => app.close());

  it("refuses when no PLANNER agent is bound", async () => {
    const response = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe("PLANNER_NOT_BOUND");
  });

  it("creates one pre-authorised PLANNER task and replays on the same key", async () => {
    await app.inject({ method: "PUT", url: "/api/seo-ops/agent-bindings/PLANNER", payload: { agent_id: "agent-planner", agent_label: "Planner" } });
    const first = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-2" } });
    expect(first.statusCode, first.body).toBe(201);
    const { task_id } = first.json();
    const task = (await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task_id}` })).json();
    expect(task).toMatchObject({ task_type: "PLANNER", execution_mode: "READ_ONLY", source: "SYSTEM" });
    expect(["APPROVED", "DISPATCHING"]).toContain(task.status);
    const again = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-2" } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ task_id, replayed: true });
  });
});
```

- [ ] **Step 2: 确认失败**

Run: `cd server && npm test -- tests/plannerRequest.test.ts` → FAIL (404)。

- [ ] **Step 3: 路由**

`seoOps.ts` 在 `/api/seo-ops/merchants/:merchantId/lifecycle` 路由前追加（import `getAgentBinding` from `../repos/settingsRepo.js`）：

```ts
  const plannerRequestSchema = z.object({
    reason: z.string().trim().min(1).max(500),
    idempotency_key: z.string().trim().min(1).max(200),
  });

  // 手动请求 Planner：只产生一个只读 PLANNER 任务，建议仍须人判定（红线①）。
  app.post("/api/seo-ops/merchants/:merchantId/planner-requests", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const body = plannerRequestSchema.parse(request.body);
    if (!(await getAgentBinding(ctx.db, "PLANNER"))) {
      throw new ApiError(409, "PLANNER agent is not bound; bind it in settings first", "PLANNER_NOT_BOUND");
    }
    const result = await enqueuePlannerTaskIfBound(ctx.db, merchantId, {
      key: `manual:${body.idempotency_key}`,
      type: "MANUAL_REQUEST",
      reason: body.reason,
    }, actor.userId);
    if (!result) throw new ApiError(409, "PLANNER agent is not bound", "PLANNER_NOT_BOUND");
    reply.status(result.replayed ? 200 : 201);
    return { task_id: result.task.id, replayed: result.replayed };
  });
```

- [ ] **Step 4: 通过并提交**

Run: `cd server && npm test -- tests/plannerRequest.test.ts && npm run typecheck`

```bash
git add server/src/routes/seoOps.ts server/tests/plannerRequest.test.ts
git commit -m "feat(planner): allow operators to request a planner run manually"
```

- [ ] **Step 5: 前端失败测试**

`src/features/inbox/ProposalsTab.test.tsx`（渲染 `<MemoryRouter><ProposalsTab merchantId="keke" /></MemoryRouter>`，mock fetch）：

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProposalBatchWire, ProposalWire } from "../../api/types";
import { ProposalsTab } from "./ProposalsTab";

const calls: Array<{ path: string; body?: unknown }> = [];
function proposal(over: Partial<ProposalWire>): ProposalWire {
  return { id: "p", batch_id: "b1", merchant_id: "keke", location_id: null, seq: 1, title: "t", task_type: "AUDIT", execution_mode: "READ_ONLY",
    executor_agent: "Audit Agent", depends_on: [], due_at: "2026-08-30T00:00:00Z", priority: "HIGH", impact: "HIGH", acceptance_criteria: "96 项评分",
    execution_spec: "{}", required_evidence_types: [], validation_failures: [], status: "PENDING", decided_by: null, decided_at: null,
    return_reason: null, task_id: null, created_at: "2026-08-25T04:15:00Z", updated_at: "2026-08-25T04:15:00Z", ...over };
}
const batch: ProposalBatchWire = { id: "b1", merchant_id: "keke", merchant_name: "可可小卤", origin: "PLANNER", trigger_reason: "问卷回收 + 关键词完成",
  planner_run_id: "pl-0825-kk", snapshot_note: "商户状态 08/25 12:14 · 服务范围 Local SEO", status: "OPEN", created_by: null,
  created_at: "2026-08-25T04:15:00Z", updated_at: "2026-08-25T04:15:00Z",
  proposals: [proposal({ id: "p1", seq: 1, title: "GBP 商家授权跟进" }), proposal({ id: "p2", seq: 2, title: "执行 GBP + 官网双审计" }),
    proposal({ id: "p5", seq: 5, title: "首批 GBP Post ×4", execution_mode: "AUTO_WRITE", status: "VALIDATION_FAILED", validation_failures: ["CAPABILITY_MISSING:GBP_WRITE"] })] };

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path.startsWith("/api/seo-ops/proposal-batches")) return json({ items: [batch] });
    if (path.includes("/decision")) return json({ proposal: { ...batch.proposals[0], status: "ADOPTED", task_id: "task-new" }, task_id: "task-new" });
    if (path.endsWith("/planner-requests")) return json({ task_id: "planner-task", replayed: false }, 201);
    return json({ message: "unhandled" }, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

test("batch header shows planner snapshot and rows show executor and due date", async () => {
  render(<MemoryRouter><ProposalsTab merchantId="keke" /></MemoryRouter>);
  expect(await screen.findByText(/pl-0825-kk/)).toBeInTheDocument();
  expect(screen.getByText(/服务范围 Local SEO/)).toBeInTheDocument();
  const row = screen.getByRole("row", { name: /GBP 商家授权跟进/ });
  expect(within(row).getByText("Audit Agent")).toBeInTheDocument();
});

test("selecting pending rows and adopting them decides each proposal in order; failed rows cannot be selected", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><ProposalsTab merchantId="keke" /></MemoryRouter>);
  await screen.findByText(/pl-0825-kk/);
  expect(screen.queryByRole("checkbox", { name: /首批 GBP Post/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "选择 #1 GBP 商家授权跟进" }));
  await user.click(screen.getByRole("checkbox", { name: "选择 #2 执行 GBP + 官网双审计" }));
  await user.click(screen.getByRole("button", { name: "采纳 2 条并创建 Task" }));
  const decisions = calls.filter((c) => c.path.includes("/decision"));
  expect(decisions.map((c) => c.path)).toEqual(["/api/seo-ops/proposals/p1/decision", "/api/seo-ops/proposals/p2/decision"]);
  expect(decisions[0]!.body).toEqual({ action: "ADOPT" });
});

test("edit-then-adopt sends priority and due overrides", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><ProposalsTab merchantId="keke" /></MemoryRouter>);
  await screen.findByText(/pl-0825-kk/);
  const row = screen.getByRole("row", { name: /GBP 商家授权跟进/ });
  await user.click(within(row).getByRole("button", { name: "编辑后采纳" }));
  await user.selectOptions(screen.getByLabelText("优先级"), "URGENT");
  await user.click(screen.getByRole("button", { name: "采纳并创建 Task" }));
  const decision = calls.find((c) => c.path === "/api/seo-ops/proposals/p1/decision");
  expect(decision?.body).toMatchObject({ action: "ADOPT", override_priority: "URGENT" });
});

test("manual planner request posts a reason for the scoped merchant", async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><ProposalsTab merchantId="keke" /></MemoryRouter>);
  await user.click(await screen.findByRole("button", { name: "手动请求 Planner" }));
  await user.type(screen.getByLabelText("请求原因"), "复盘后刷新任务图");
  await user.click(screen.getByRole("button", { name: "发送请求" }));
  const request = calls.find((c) => c.path === "/api/seo-ops/merchants/keke/planner-requests");
  expect(request?.body).toMatchObject({ reason: "复盘后刷新任务图" });
  expect(await screen.findByText(/已生成 Planner 任务/)).toBeInTheDocument();
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
```

- [ ] **Step 6: 确认失败**

Run: `npm run test:run -- src/features/inbox/ProposalsTab.test.tsx` → FAIL。

- [ ] **Step 7: 客户端与组件**

`seoOpsApi.ts` 建议层追加：

```ts
  requestPlanner: (merchantId: string, request: { reason: string; idempotency_key: string }) =>
    post<{ task_id: string; replayed: boolean }>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/planner-requests`, request),
```

`src/features/inbox/PlannerRequestButton.tsx`:

```tsx
import { useState } from "react";
import { ApiError } from "../../api/client";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { MerchantSummary } from "../../api/types";

/** 手动请求 Planner：只创建一个只读 PLANNER 任务；建议出来后仍要人判定。 */
export function PlannerRequestButton({ merchantId, merchants, onDone }: { merchantId?: string; merchants?: MerchantSummary[]; onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(merchantId ?? merchants?.[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const submit = async () => {
    const id = merchantId ?? target;
    if (!id || !reason.trim()) return;
    setBusy(true); setMessage(undefined);
    try {
      const result = await seoOpsApi.requestPlanner(id, { reason: reason.trim(), idempotency_key: crypto.randomUUID() });
      setMessage(result.replayed ? "同一请求已存在，未重复创建。" : `已生成 Planner 任务（${result.task_id.slice(0, 8)}…）；建议出来后在此判定。`);
      setReason(""); onDone?.();
    } catch (cause) {
      setMessage(cause instanceof ApiError && cause.code === "PLANNER_NOT_BOUND" ? "Planner 未绑定：先在「设置 · Agent 绑定」绑定 PLANNER。" : cause instanceof Error ? cause.message : "请求失败");
    } finally { setBusy(false); }
  };
  return <div className="planner-request">
    <button className="secondary-button" onClick={() => setOpen((v) => !v)} type="button">手动请求 Planner</button>
    {open ? <div className="planner-request-form">
      {!merchantId && merchants ? <label>商户<select onChange={(e) => setTarget(e.target.value)} value={target}>{merchants.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</select></label> : null}
      <label>请求原因<input onChange={(e) => setReason(e.target.value)} placeholder="例：复盘后刷新任务图" value={reason} /></label>
      <button className="primary-button" disabled={busy || !reason.trim() || !(merchantId ?? target)} onClick={() => void submit()} type="button">{busy ? "发送中…" : "发送请求"}</button>
    </div> : null}
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </div>;
}
```

`src/features/inbox/AdoptDialog.tsx`:

```tsx
import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { ProposalWire, TaskPriority } from "../../api/types";

/** 编辑后采纳：AM 只能改优先级/时限（服务端 override_*），不能改任务定义本身。 */
export function AdoptDialog({ proposal, onClose, onDone }: { proposal: ProposalWire; onClose: () => void; onDone: (taskId: string | null) => void }) {
  const [priority, setPriority] = useState<TaskPriority>(proposal.priority);
  const [dueAt, setDueAt] = useState(proposal.due_at ? proposal.due_at.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setBusy(true); setError(undefined);
    try {
      const result = await seoOpsApi.decideProposal(proposal.id, {
        action: "ADOPT",
        ...(priority !== proposal.priority ? { override_priority: priority } : {}),
        ...(dueAt && dueAt !== (proposal.due_at ?? "").slice(0, 10) ? { override_due_at: new Date(`${dueAt}T00:00:00Z`).toISOString() } : {}),
      });
      onDone(result.task_id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "采纳失败"); }
    finally { setBusy(false); }
  };
  return <div aria-label="编辑后采纳" aria-modal="true" className="modal-backdrop" role="dialog"><div className="modal-card slim">
    <header className="modal-head"><div><span className="eyebrow">ADOPT WITH EDITS</span><h2>#{proposal.seq} {proposal.title}</h2></div></header>
    <div className="modal-body">
      <label>优先级<select aria-label="优先级" onChange={(e) => setPriority(e.target.value as TaskPriority)} value={priority}><option value="LOW">LOW</option><option value="MEDIUM">MEDIUM</option><option value="HIGH">HIGH</option><option value="URGENT">URGENT</option></select></label>
      <label>到期日<input aria-label="到期日" onChange={(e) => setDueAt(e.target.value)} type="date" value={dueAt} /></label>
      <p className="quiet-copy">采纳 = 写入 seo_tasks（rev 1）并进入门 1 审批链；判定记录写入不可变审计时间线。</p>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
    </div>
    <footer className="modal-foot"><span /><div><button className="secondary-button" onClick={onClose} type="button">取消</button><button className="primary-button" disabled={busy} onClick={() => void submit()} type="button">{busy ? "提交中…" : "采纳并创建 Task"}</button></div></footer>
  </div></div>;
}
```

- [ ] **Step 8: 改 ProposalsTab**

在 `ProposalsTab` 内：
- 新增状态 `const [selected, setSelected] = useState<Set<string>>(new Set()); const [editing, setEditing] = useState<ProposalWire>(); const [bulkResult, setBulkResult] = useState<string>();`；`const workspace = useWorkspace();`（import）。
- `panel-heading` 右侧改为 `<div className="heading-actions"><PlannerRequestButton merchantId={merchantId} merchants={merchantId ? undefined : workspace.merchants} onDone={resource.reload} /><button aria-label="刷新建议" …/></div>`。
- 批次 header 的 `<small>` 后追加：`{batch.snapshot_note ? <p className="quiet-copy">读取快照：{batch.snapshot_note}{batch.planner_run_id ? <> · Planner run <code>{batch.planner_run_id}</code></> : null}</p> : null}`。
- 表头改为 `<th /><th>#</th><th>建议</th><th>类型 / 模式</th><th>executor</th><th>due</th><th>优先级</th><th>校验</th><th>判定</th>`；每行开头加：

```tsx
          <td>{p.status === "PENDING" ? <input aria-label={`选择 #${p.seq} ${p.title}`} checked={selected.has(p.id)} onChange={(e) => setSelected((cur) => { const next = new Set(cur); if (e.target.checked) next.add(p.id); else next.delete(p.id); return next; })} type="checkbox" /> : null}</td>
```

并在「类型 / 模式」后加 `<td>{p.executor_agent ?? (p.execution_mode === "MANUAL" ? "DRI · 人工" : "—")}</td><td>{p.due_at ? formatDateOnly(p.due_at) : "—"}</td>`（import `formatDateOnly`）。行要有可读名：`<tr aria-label={`#${p.seq} ${p.title}`} …>`。
- `decisionCell` 的 PENDING 分支增加 `<button className="secondary-button" disabled={busy === p.id} onClick={() => setEditing(p)} type="button">编辑后采纳</button>`。
- 每个 open 批次表格之后加批量条：

```tsx
      {(() => { const chosen = batch.proposals.filter((p) => selected.has(p.id)); const failed = batch.proposals.filter((p) => p.status === "VALIDATION_FAILED").length; return <footer className="batch-bulk">
        <span>已选 {chosen.length} / {batch.proposals.filter((p) => p.status === "PENDING").length} 条{failed ? ` · ${failed} 条校验失败只能附因退回` : ""}</span>
        <button className="primary-button" disabled={!chosen.length || Boolean(busy)} onClick={() => void adoptMany(chosen)} type="button">采纳 {chosen.length} 条并创建 Task</button>
      </footer>; })()}
```

- 新增函数：

```tsx
  const adoptMany = async (items: ProposalWire[]) => {
    setBusy("bulk"); setError(undefined); setBulkResult(undefined);
    const failures: string[] = []; let adopted = 0;
    for (const item of items) {
      try { await seoOpsApi.decideProposal(item.id, { action: "ADOPT" }); adopted += 1; }
      catch (cause) { failures.push(`#${item.seq} ${cause instanceof Error ? cause.message : "失败"}`); }
    }
    setSelected(new Set()); setBusy(undefined);
    setBulkResult(`已采纳 ${adopted} 条${failures.length ? `；失败：${failures.join("、")}` : ""}`);
    resource.reload();
  };
```

`bulkResult` 在 `error` 之后渲染 `<p className="form-message" role="status">`。`editing` 时渲染 `<AdoptDialog proposal={editing} onClose={() => setEditing(undefined)} onDone={(taskId) => { setEditing(undefined); resource.reload(); if (taskId) navigate(`/tasks/${taskId}`); }} />`。

样式（追加到 `src/styles/overview.css` 末尾，避免新文件）：

```css
.batch-bulk { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-top: 1px solid var(--rule); font-size: 9px; color: var(--ink-muted); }
.planner-request { position: relative; }
.planner-request-form { display: grid; gap: 8px; margin-top: 8px; padding: 10px; border: 1px solid var(--rule); background: var(--surface); }
.planner-request-form label { display: grid; gap: 4px; font-size: 9px; color: var(--ink-muted); }
```

- [ ] **Step 9: 测试、构建、提交**

Run: `npm run test:run -- src/features/inbox src/App.test.tsx && npm run build`

```bash
git add src/api/seoOpsApi.ts src/features/inbox src/styles/overview.css
git commit -m "feat(proposals): batch adoption, adopt-with-edits, and manual planner requests"
```

---

### Task 5: 红线文案修正（GBP 发布轨、复盘窗口、复盘分级词汇）

**Files:**
- Modify: `src/features/tasks/GbpWorkflowRail.tsx`、`src/features/tasks/GbpWorkflowRail.test.tsx`
- Modify: `server/src/services/schedulerService.ts`（REVIEW 标题）
- Modify: `src/features/settings/CadencePanel.tsx`（标签）
- Modify: `src/features/reviews/reviewCopy.ts`（新增 `classificationLabel`、`tierLabel`）+ `reviewCopy.test.ts`

- [ ] **Step 1: 改失败测试**

`GbpWorkflowRail.test.tsx` 的第一个测试改名为 "shows the five-step GBP Post operating path …"，断言：`生成图文` done、`修改与定稿` done、`人工批准` current、`发布` pending、`生效核对` pending；删除对「自动发布」的断言。再加一个测试：

```tsx
test("a published post shows 发布 done and 生效核对 current — publish never implies verified", () => {
  render(<GbpWorkflowRail hasDraft task={{ ...taskFixture, task_type: "GBP_POST", execution_mode: "AUTO_WRITE", status: "PENDING_VERIFY", evidence_refs: [] }} />);
  expect(screen.getByText("发布").closest("li")).toHaveAttribute("data-state", "done");
  expect(screen.getByText("生效核对").closest("li")).toHaveAttribute("data-state", "current");
});
```

`src/features/reviews/reviewCopy.test.ts` 追加：

```ts
test("classification labels never promote a correlational reading to causal", () => {
  expect(classificationLabel("CORRELATIONAL")).toBe("关联（上限 ASSOCIATIONAL）");
  expect(classificationLabel("CAUSAL_READY")).toBe("因果设计就绪（需单独批准）");
  expect(tierLabel("ASSOCIATIONAL")).toBe("正向/负向关联 · ASSOCIATIONAL");
  expect(tierLabel("INSUFFICIENT_EVIDENCE")).toBe("无法定论 · INSUFFICIENT");
});
```

- [ ] **Step 2: 确认失败**

Run: `npm run test:run -- src/features/tasks/GbpWorkflowRail.test.tsx src/features/reviews`

- [ ] **Step 3: 实现**

`GbpWorkflowRail.tsx` 的 `steps` 改为：

```tsx
  const approved = ["APPROVED", "EXECUTION_CONFIRMED", "DISPATCHING", "OUTCOME_UNKNOWN", "PENDING_VERIFY", "VERIFIED", "DONE"].includes(task.status);
  const published = ["PENDING_VERIFY", "VERIFIED", "DONE"].includes(task.status);
  const verified = ["VERIFIED", "DONE"].includes(task.status);
  const publishing = ["APPROVED", "EXECUTION_CONFIRMED", "DISPATCHING", "OUTCOME_UNKNOWN"].includes(task.status);
  const steps: Array<{ label: string; note: string; state: StepState }> = [
    { label: "生成图文", note: hasDraft ? "Core AI 草稿已保存" : "等待生成英文文案与图片", state: hasDraft ? "done" : "current" },
    { label: "修改与定稿", note: finalized ? "文案与最终图片已锁定" : "可改文案或上传商户菜品实拍", state: finalized ? "done" : hasDraft ? "current" : "pending" },
    { label: "人工批准", note: approved ? "当前版本已批准（仅授权）" : "批准后才进入发布确认", state: approved ? "done" : finalized ? "current" : "pending" },
    { label: "发布", note: published ? "已发布（provider 回执）" : task.status === "OUTCOME_UNKNOWN" ? "结果不确定 · 等人工查证" : publishing ? "门 2 确认后派发，等待回执" : "等待人工批准与发布时间", state: published ? "done" : publishing ? "current" : "pending" },
    { label: "生效核对", note: verified ? "公开可见已核验" : "发布 ≠ 已验证：到前台确认可见后归档", state: verified ? "done" : published ? "current" : "pending" },
  ];
```

`reviewCopy.ts` 追加：

```ts
export function classificationLabel(classification: ReviewClassification): string {
  switch (classification) {
    case "CAUSAL_READY": return "因果设计就绪（需单独批准）";
    case "CORRELATIONAL": return "关联（上限 ASSOCIATIONAL）";
    case "FACTUAL": return "事实记录";
    default: return "证据不足";
  }
}

export type ConclusionTier = "INSUFFICIENT_EVIDENCE" | "DESCRIPTIVE" | "ASSOCIATIONAL";
export function tierLabel(tier: string): string {
  if (tier === "ASSOCIATIONAL") return "正向/负向关联 · ASSOCIATIONAL";
  if (tier === "DESCRIPTIVE") return "仅描述 · DESCRIPTIVE";
  return "无法定论 · INSUFFICIENT";
}
```

`schedulerService.ts` 第 120 行标题改为 `` `效果复盘 #${bucket}` ``（先 `grep -rn "评论巡检" server/tests` 更新引用）。`CadencePanel.tsx` 的 `评论巡检窗口（天）` 改为 `复盘窗口（天）· 到窗自动出 REVIEW 建议`。

- [ ] **Step 4: 通过并提交**

Run: `npm run test:run -- src/features/tasks src/features/reviews src/features/settings && (cd server && npm test -- tests/ && npm run typecheck)`

```bash
git add src/features/tasks/GbpWorkflowRail.tsx src/features/tasks/GbpWorkflowRail.test.tsx src/features/reviews/reviewCopy.ts src/features/reviews/reviewCopy.test.ts src/features/settings/CadencePanel.tsx server/src/services/schedulerService.ts server/tests
git commit -m "fix(copy): separate publish from verification and name the review window correctly"
```

---

### Task 6: 商户页 — 排名快照、轮次徽标、请求 Planner、复盘信号、品牌档案行

**Files:**
- Create: `src/features/merchant/RankingSnapshotPanel.tsx`、`src/features/merchant/ReviewSignalPanel.tsx`
- Modify: `src/features/merchant/MerchantWorkspacePage.tsx`、`src/features/merchant/ReportsDataPanel.tsx`、`src/styles/merchant.css`
- Test: `src/features/merchant/MerchantWorkspacePage.test.tsx`

**Interfaces:**
- Consumes: `seoOpsApi.ranking`（`RankingOverviewView`）、`seoOpsApi.merchantArtifacts(id, "EFFECT_REVIEW")`、`seoOpsApi.requestPlanner`（Task 4）、`lifecycle.ranking_round_count` / `lifecycle.questionnaire`。

- [ ] **Step 1: 失败测试**

在 `MerchantWorkspacePage.test.tsx` mock 中把 `/ranking` 改为可变 `rankingData`，默认：

```ts
let rankingData: RankingOverviewView = { round_count: 2,
  latest: { run_id: "run-2", captured_at: "2026-08-25T09:00:00Z", keyword_count: 2, rows: [
    { keyword: "ramen near me", local_rank: 8, organic_rank: 12, local_delta: 4, organic_delta: -2, is_new: false },
    { keyword: "best ramen flushing", local_rank: null, organic_rank: 15, local_delta: null, organic_delta: null, is_new: true } ] },
  previous: { run_id: "run-1", captured_at: "2026-08-04T09:00:00Z" },
  comparison: { local_avg: { current: 8, previous: 12, delta: 4 }, organic_top10: { current: 0, previous: 1, total: 2 }, new_keyword_count: 1 } };
```

并把 `planner-requests` 与 `/artifacts?artifact_type=EFFECT_REVIEW` 加进 mock（后者返回一条 `{ artifact_type: "EFFECT_REVIEW", title: "第 2 轮复盘", summary: "...", payload: { conclusion_tier: "ASSOCIATIONAL", conclusion: "正向关联 · 建议续做 Post 周更" }, … }`）。新增测试：

```tsx
test("merchant header shows the ranking round and the ranking snapshot compares with the previous round", async () => {
  renderApp("/merchants/keke?view=operator");
  expect(await screen.findByText("第 2 轮")).toBeInTheDocument();
  const panel = screen.getByRole("region", { name: "排名快照" });
  expect(within(panel).getByText(/Local 平均 8/)).toBeInTheDocument();
  const row = within(panel).getByRole("row", { name: /ramen near me/ });
  expect(within(row).getByText("↑4")).toBeInTheDocument();
  expect(within(panel).getByText("新词")).toBeInTheDocument();
});

test("operators can request a planner refresh from the merchant page", async () => {
  const user = userEvent.setup();
  renderApp("/merchants/keke?view=operator");
  await user.click(await screen.findByRole("button", { name: "请求 Planner 刷新任务图" }));
  expect(await screen.findByText(/已生成 Planner 任务/)).toBeInTheDocument();
});

test("review signal panel shows the latest effect review capped at its tier", async () => {
  renderApp("/merchants/keke?view=operator");
  const panel = await screen.findByRole("region", { name: "复盘信号" });
  expect(within(panel).getByText(/ASSOCIATIONAL/)).toBeInTheDocument();
  expect(within(panel).getByRole("link", { name: /打开复盘/ })).toHaveAttribute("href", expect.stringContaining("/reviews"));
});
```

- [ ] **Step 2: 确认失败**，`npm run test:run -- src/features/merchant/MerchantWorkspacePage.test.tsx`。

- [ ] **Step 3: RankingSnapshotPanel**

```tsx
import type { RankingOverviewView } from "../../api/types";
import { formatDateOnly } from "../../app/format";

function delta(value: number | null): string { return value === null ? "—" : value > 0 ? `↑${value}` : value < 0 ? `↓${Math.abs(value)}` : "→0"; }

export function RankingSnapshotPanel({ data, loading, error, onRetry }: { data?: RankingOverviewView; loading: boolean; error?: unknown; onRetry: () => void }) {
  const latest = data?.latest;
  return <section aria-label="排名快照" className="data-panel ranking-panel">
    <div className="panel-heading"><div><span className="eyebrow">RANKING · LOCAL / ORGANIC</span><h2>排名快照</h2><p className="quiet-copy">{data?.round_count ? `第 ${data.round_count} 轮 · 最近 ${formatDateOnly(latest?.captured_at)}${data.previous ? ` · 对比 ${formatDateOnly(data.previous.captured_at)}` : " · 首个快照"}` : "排名基线未建立 · 基线任务判定并执行后生成首个快照"}</p></div></div>
    {error ? <div className="page-state compact is-error" role="alert">排名读取失败。<button onClick={onRetry} type="button">重试</button></div> : null}
    {loading && !data ? <div className="page-state compact" role="status">读取排名…</div> : null}
    {data?.comparison ? <div className="ranking-compare"><span>Local 平均 {data.comparison.local_avg.current ?? "—"}（{delta(data.comparison.local_avg.delta)}）</span><span>Organic 前 10：{data.comparison.organic_top10.current} / {data.comparison.organic_top10.total}（上期 {data.comparison.organic_top10.previous}）</span><span>新词 {data.comparison.new_keyword_count}</span></div> : null}
    {latest ? <div className="table-wrap"><table><thead><tr><th>关键词</th><th>Local</th><th>Organic</th><th /></tr></thead><tbody>
      {latest.rows.slice(0, 12).map((row) => <tr aria-label={row.keyword} key={row.keyword}><td>{row.keyword}</td><td>{row.local_rank ?? "出包"} <small>{delta(row.local_delta)}</small></td><td>{row.organic_rank ?? "出包"} <small>{delta(row.organic_delta)}</small></td><td>{row.is_new ? <span className="status-pill is-attention">新词</span> : null}</td></tr>)}
    </tbody></table>{latest.rows.length > 12 ? <p className="quiet-copy">仅显示前 12 / {latest.keyword_count} 词</p> : null}</div> : null}
  </section>;
}
```

- [ ] **Step 4: ReviewSignalPanel**

```tsx
import { Link } from "react-router-dom";
import type { SpecialistArtifactWire } from "../../api/types";
import { formatDateOnly } from "../../app/format";
import { tierLabel } from "../reviews/reviewCopy";

export function ReviewSignalPanel({ merchantId, artifacts, loading }: { merchantId: string; artifacts: SpecialistArtifactWire[]; loading: boolean }) {
  const latest = artifacts.filter((a) => a.artifact_type === "EFFECT_REVIEW").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const tier = typeof latest?.payload.conclusion_tier === "string" ? latest.payload.conclusion_tier : "INSUFFICIENT_EVIDENCE";
  return <section aria-label="复盘信号" className="data-panel review-signal-panel">
    <div className="panel-heading"><div><span className="eyebrow">OUTCOME REVIEW</span><h2>复盘信号</h2></div></div>
    {loading ? <div className="page-state compact" role="status">读取复盘…</div> : latest ? <>
      <p><strong>{latest.title}</strong> · {formatDateOnly(latest.created_at)}</p>
      <p><span className="status-pill is-stable">{tierLabel(tier)}</span></p>
      <p className="quiet-copy">{String(latest.payload.conclusion ?? latest.summary)}</p>
      <Link className="text-button" to={`/reviews?merchant_id=${encodeURIComponent(merchantId)}`}>打开复盘 ›</Link>
    </> : <p className="quiet-copy">首轮执行完成并到达复盘窗口后开启：基线 → 动作 → 可比复测 → 证据强度结论（上限 ASSOCIATIONAL）。</p>}
  </section>;
}
```

- [ ] **Step 5: 接入 MerchantWorkspacePage / ReportsDataPanel**

- 新增 `const ranking = useResource((signal) => seoOpsApi.ranking(merchantId, signal), [merchantId]);`
- header：`<h1>` 后加 `<span className="status-pill">{lifecycle.data ? lifecycle.data.ranking_round_count > 0 ? `第 ${lifecycle.data.ranking_round_count} 轮` : "首轮接入" : "—"}</span>`；右侧加 `canManage` 时的按钮：

```tsx
      <button className="secondary-button" disabled={plannerBusy} onClick={() => void requestPlanner()} type="button">{plannerBusy ? "请求中…" : "请求 Planner 刷新任务图"}</button>
```

配套：

```tsx
  const [plannerBusy, setPlannerBusy] = useState(false);
  const [plannerMessage, setPlannerMessage] = useState("");
  const requestPlanner = async () => {
    setPlannerBusy(true); setPlannerMessage("");
    try {
      const result = await seoOpsApi.requestPlanner(merchantId, { reason: "商户页人工请求刷新任务图", idempotency_key: crypto.randomUUID() });
      setPlannerMessage(result.replayed ? "同一请求已存在。" : "已生成 Planner 任务；建议出来后到「任务 · 待判定」判定。");
      ledger.reload();
    } catch (cause) { setPlannerMessage(cause instanceof ApiError && cause.code === "PLANNER_NOT_BOUND" ? "Planner 未绑定：请先在设置页绑定 PLANNER。" : "请求失败，请稍后重试。"); }
    finally { setPlannerBusy(false); }
  };
```

（`plannerMessage` 渲染为 `<p className="form-message" role="status">`）。
- `merchant-control-grid` 内追加 `<RankingSnapshotPanel data={ranking.data} error={ranking.error} loading={ranking.loading} onRetry={ranking.reload} />` 与 `<ReviewSignalPanel artifacts={artifacts.data?.items ?? []} loading={artifacts.loading} merchantId={merchantId} />`。
- `ReportsDataPanel` 增加 prop `questionnaire?: LifecycleView["questionnaire"]`，在列表最前渲染：

```tsx
    <ul className="evidence-list"><li><strong>品牌档案 · 来自问卷</strong><small>{questionnaire?.status === "FILLED" ? `${formatDate(questionnaire.filled_at!)} 回收 · 已落库` : questionnaire?.status === "SENT" ? "等问卷回收（已发出）" : "未生成问卷"}</small></li></ul>
```

- `merchant.css` 追加 `.ranking-compare { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: 10px; color: var(--ink-muted); } .ranking-panel td small { color: var(--ink-muted); font-family: var(--font-data); }`。

- [ ] **Step 6: 通过、构建、提交**

Run: `npm run test:run -- src/features/merchant src/App.test.tsx && npm run build`

```bash
git add src/features/merchant src/styles/merchant.css
git commit -m "feat(merchant): ranking snapshot, round badge, planner request, and review signal"
```

---

### Task 7: Post 内容 · 周计划子页

**Files:**
- Modify: `src/api/types.ts`（`StyleProfileWire`）、`src/api/seoOpsApi.ts`（`styleProfile`、`saveStyleProfile`）、`src/App.tsx`（路由）、`src/features/merchant/PostProgramPanel.tsx`（入口链接）、`src/styles.css`
- Create: `src/features/merchant/PostPlanPage.tsx`、`src/features/merchant/VoiceProfileEditor.tsx`、`src/styles/post-plan.css`、`src/features/merchant/PostPlanPage.test.tsx`

**Interfaces:**
- Consumes: `GET/POST /api/seo-ops/merchants/:id/style-profile`（wire：`{ id, merchant_id, version, voice: Record<string, unknown>, updated_by, created_at }`）、`postProgram`、`cycleConfig`、`cycleLedger`。

- [ ] **Step 1: 类型/客户端**

```ts
export interface StyleProfileWire { id: string; merchant_id: string; version: number; voice: Record<string, unknown>; updated_by: string | null; created_at: string }
```

```ts
  styleProfile: (merchantId: string, signal?: AbortSignal) =>
    requestJson<StyleProfileWire | null>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/style-profile`, { signal }),
  saveStyleProfile: (merchantId: string, request: { voice: Record<string, unknown> }) =>
    post<StyleProfileWire>(`/api/seo-ops/merchants/${encodeURIComponent(merchantId)}/style-profile`, request),
```

- [ ] **Step 2: 失败测试**

`PostPlanPage.test.tsx`（复用 MerchantWorkspacePage.test 的 mock 骨架；额外 mock `/style-profile`（GET 返回 `{ version: 2, voice: { tone: "邻里咖啡馆口吻", address: "we / neighbors", banned: ["best", "top-rated"], example: "Smashed avocado…", source: "问卷 + 人工校订" } }`，POST 记录 body 并返回 version 3）、`/cycle-config`（`{ post_weekday: 4, post_per_week: 1, snapshot_day: 5, review_window_days: 30, audit_interval_days: 90, enabled: true }`）、`/cycle-ledger`（含一条 `record_kind: "TASK"`、`task_type: "GBP_POST"`、`status: "APPROVED"`、title "Smashed Avocado 新品（周四档）"）、`/post-program`（`cluster_signals: [{ cluster: "smashed avocado sandwich", signal: "IMPROVED", … }]`、`proposals: [{ proposal_id: "p9", title: "周末 Bottomless 场次", … }]`、`history: [{ task_id: "t8", title: "Perfect brunch weather", published_ref: "https://…", … }]`）。

```tsx
test("post plan page shows cadence, weekly signals, voice profile, this week's slot, candidates, and history", async () => {
  renderApp("/merchants/keke/post-plan?view=operator");
  expect(await screen.findByRole("heading", { name: "Post 内容 · 周计划" })).toBeInTheDocument();
  expect(screen.getByText(/每周四 ×1/)).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "本周关键词表现" })).getByText("smashed avocado sandwich")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "风格档案" })).getByText(/uws-voice|v2/)).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "本周档期" })).getByText("Smashed Avocado 新品（周四档）")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "下周候选" })).getByText("周末 Bottomless 场次")).toBeInTheDocument();
  expect(within(screen.getByRole("region", { name: "历史发布" })).getByText("Perfect brunch weather")).toBeInTheDocument();
});

test("editing the voice profile posts a new version and never touches approved drafts", async () => {
  const user = userEvent.setup();
  renderApp("/merchants/keke/post-plan?view=operator");
  await user.click(await screen.findByRole("button", { name: "编辑（记版本）" }));
  await user.clear(screen.getByLabelText("语气"));
  await user.type(screen.getByLabelText("语气"), "短句直给");
  await user.click(screen.getByRole("button", { name: "保存为 v3" }));
  const saved = calls.find((c) => c.path.endsWith("/style-profile") && c.body);
  expect(saved?.body).toMatchObject({ voice: { tone: "短句直给" } });
  expect(screen.getByText(/档案更新不追溯已批准稿/)).toBeInTheDocument();
});
```

- [ ] **Step 3: 确认失败**：`npm run test:run -- src/features/merchant/PostPlanPage.test.tsx`。

- [ ] **Step 4: VoiceProfileEditor**

```tsx
import { useState } from "react";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { StyleProfileWire } from "../../api/types";

const FIELDS: Array<{ key: "tone" | "address" | "banned" | "example" | "source"; label: string; multi?: boolean }> = [
  { key: "tone", label: "语气" }, { key: "address", label: "称呼" }, { key: "banned", label: "禁用", multi: true }, { key: "example", label: "范例" }, { key: "source", label: "来源" },
];

function asText(value: unknown): string { return Array.isArray(value) ? value.join("、") : typeof value === "string" ? value : ""; }

export function VoiceProfileEditor({ merchantId, profile, canManage, onSaved }: { merchantId: string; profile: StyleProfileWire | null; canManage: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => Object.fromEntries(FIELDS.map((f) => [f.key, asText(profile?.voice[f.key])])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const nextVersion = (profile?.version ?? 0) + 1;
  const save = async () => {
    setBusy(true); setMessage(undefined);
    try {
      const voice: Record<string, unknown> = { ...(profile?.voice ?? {}) };
      for (const f of FIELDS) voice[f.key] = f.multi ? form[f.key]!.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) : form[f.key];
      await seoOpsApi.saveStyleProfile(merchantId, { voice });
      setEditing(false); setMessage(`已保存 v${nextVersion}`); onSaved();
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setBusy(false); }
  };
  return <section aria-label="风格档案" className="data-panel voice-panel">
    <div className="panel-heading"><div><span className="eyebrow">VOICE PROFILE</span><h2>风格档案 · v{profile?.version ?? 0}</h2></div>{canManage && !editing ? <button className="secondary-button" onClick={() => setEditing(true)} type="button">编辑（记版本）</button> : null}</div>
    {editing ? <div className="voice-form">{FIELDS.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} onChange={(e) => setForm((cur) => ({ ...cur, [f.key]: e.target.value }))} value={form[f.key]} /></label>)}
      <div><button className="primary-button" disabled={busy} onClick={() => void save()} type="button">{busy ? "保存中…" : `保存为 v${nextVersion}`}</button><button className="secondary-button" onClick={() => setEditing(false)} type="button">取消</button></div></div>
      : profile ? <dl className="identity-ledger">{FIELDS.map((f) => <div key={f.key}><dt>{f.label}</dt><dd>{asText(profile.voice[f.key]) || "—"}</dd></div>)}</dl> : <p className="quiet-copy">尚无风格档案；首个版本可由品牌档案 voice 派生后人工校订。</p>}
    <p className="quiet-copy">生成与重写按稿件引用固定版本，档案更新不追溯已批准稿。</p>
    {message ? <p className="form-message" role="status">{message}</p> : null}
  </section>;
}
```

- [ ] **Step 5: PostPlanPage**

```tsx
import { Link, useParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import { BackButton } from "../../app/BackButton";
import { formatDateOnly } from "../../app/format";
import { taskStatusLabel } from "../../app/statusCopy";
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { VoiceProfileEditor } from "./VoiceProfileEditor";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const POST_TYPES = [
  { key: "OFFER", label: "Offer", note: "促销转化 · 促销期 1–2/周 · CTA 直达" },
  { key: "STANDARD", label: "What's New", note: "新鲜度 + 关键词露出 · 默认档 ≥1/周" },
  { key: "EVENT", label: "Event", note: "活动发现流量 · 事件触发，不排固定档" },
];
const SIGNAL_LABEL: Record<string, string> = { IMPROVED: "↑ improved", FLAT: "→ flat", DECLINED: "↓ declined", INCONCLUSIVE: "？inconclusive" };

/** Post 周计划（商户子页）：选题由每周关键词分析驱动；类型与目标簇随稿件固定；
 * 建议未判定不落库。所有数据来自持久化投影，不展示推测值。 */
export function PostPlanPage() {
  const { merchantId = "" } = useParams<{ merchantId: string }>();
  const workspace = useWorkspace();
  const { user } = useAuth();
  usePageTitle("Post 周计划");
  const program = useResource((signal) => seoOpsApi.postProgram(merchantId, signal), [merchantId]);
  const cycle = useResource((signal) => seoOpsApi.cycleConfig(merchantId, signal), [merchantId]);
  const profile = useResource((signal) => seoOpsApi.styleProfile(merchantId, signal), [merchantId]);
  const ledger = useResource((signal) => seoOpsApi.cycleLedger(merchantId, signal), [merchantId]);
  const canManage = hasPermission(user?.permissions, "seoops.manage");
  const cfg = cycle.data;
  const cadence = cfg?.post_weekday !== null && cfg?.post_weekday !== undefined ? `每${WEEKDAYS[cfg.post_weekday]} ×${cfg.post_per_week}` : "暂停";
  const slots = (ledger.data?.items ?? []).filter((item) => item.record_kind === "TASK" && item.task_type === "GBP_POST");

  return <>
    <header className="page-heading"><div><BackButton fallback={`/merchants/${merchantId}`} label="返回商户" /><span className="eyebrow">MERCHANT · {workspace.merchant?.display_name ?? merchantId} · GBP POST</span><h1>Post 内容 · 周计划</h1>
      <p>周期 <strong>{cycle.loading ? "…" : cadence}</strong>（<Link to="/settings">设置 · 周期配置</Link>）· 选题由每周关键词分析驱动，类型与目标簇随稿件固定</p></div></header>

    <section aria-label="类型规约" className="post-types">{POST_TYPES.map((t) => <div key={t.key}><strong>{t.label}</strong><code>{t.key}</code><small>{t.note}</small></div>)}<p className="quiet-copy">类型不可合并为泛任务；类型 × 目标簇由选题建议给出，采纳后随 rev 固定。</p></section>

    <div className="post-plan-grid">
      <section aria-label="本周关键词表现" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">KEYWORD WEEKLY</span><h2>本周关键词表现</h2><p className="quiet-copy">按簇 · 周环比 · 关联信号（单店样本）</p></div></div>
        {program.loading ? <div className="page-state compact" role="status">读取周报…</div> : null}
        {program.data?.cluster_signals.length ? <div className="table-wrap"><table><thead><tr><th>关键词簇</th><th>表现</th><th>观察于</th></tr></thead><tbody>{program.data.cluster_signals.map((s) => <tr key={s.artifact_id + s.cluster}><td>{s.cluster}</td><td><span className={`status-pill is-${s.signal.toLowerCase()}`}>{SIGNAL_LABEL[s.signal]}</span></td><td>{formatDateOnly(s.observed_at)}</td></tr>)}</tbody></table></div> : program.data ? <p className="quiet-copy">本周尚无关键词周报信号。</p> : null}
        <p className="quiet-copy">表现分级为周环比关联信号；「处置」是 Planner 建议，判定采纳后才创建任务。</p>
      </section>

      <VoiceProfileEditor canManage={canManage} merchantId={merchantId} onSaved={profile.reload} profile={profile.data ?? null} />

      <section aria-label="本周档期" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">THIS WEEK</span><h2>本周档期</h2><p className="quiet-copy">采纳后即任务 · 双门与查证同 Task 页</p></div></div>
        {slots.length ? <ul className="program-list">{slots.map((s) => <li key={s.task_id}><strong>{s.title}</strong><span>{s.due_at ? formatDateOnly(s.due_at) : "未定时"} · {taskStatusLabel(s.status)}</span>{s.task_id ? <Link className="text-button" to={`/tasks/${s.task_id}`}>打开任务</Link> : null}</li>)}</ul> : <p className="quiet-copy">本周期没有 GBP Post 任务。</p>}
      </section>

      <section aria-label="下周候选" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">CANDIDATES · 建议未判定 · 不落库</span><h2>下周候选</h2></div></div>
        {program.data?.proposals.length ? <ul className="program-list">{program.data.proposals.map((p) => <li key={p.proposal_id}><strong>{p.title}</strong><span>{p.due_at ? formatDateOnly(p.due_at) : "—"} · {p.status === "VALIDATION_FAILED" ? `校验失败：${p.validation_failures.join("、")}` : "建议"}</span><Link className="text-button" to={`/inbox?tab=proposals&merchant_id=${encodeURIComponent(merchantId)}`}>去判定</Link></li>)}</ul> : <p className="quiet-copy">没有待判定的 Post 建议。</p>}
      </section>

      <section aria-label="历史发布" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">HISTORY · 发布 → 核验</span><h2>历史发布</h2><p className="quiet-copy">回读结论上限 ASSOCIATIONAL（单店样本）</p></div></div>
        {program.data?.history.length ? <ul className="program-list">{program.data.history.map((h) => <li key={h.task_id}><strong>{h.title}</strong><span>发布 {formatDateOnly(h.published_at)} · 核验 {formatDateOnly(h.verified_at)}</span><Link className="text-button" to={`/tasks/${h.task_id}`}>打开任务</Link></li>)}</ul> : <p className="quiet-copy">尚无已核验的发布。</p>}
      </section>
    </div>
    {program.data?.evidence_gaps.length ? <p className="quiet-copy">evidence_gaps：{program.data.evidence_gaps.join(" · ")}</p> : null}
  </>;
}
```

- [ ] **Step 6: 路由、入口、样式**

`App.tsx`：`<Route path="merchants/:merchantId/post-plan" element={<PostPlanPage />} />`（放在 `merchants/:merchantId` 之后）。`PostProgramPanel.tsx` 的 `panel-heading` 右侧加 `<Link className="text-button" to={`/merchants/${encodeURIComponent(merchantId)}/post-plan`}>打开 Post 周计划 ›</Link>`。

`src/styles/post-plan.css`（并 import）：

```css
.post-types { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; margin-bottom: 16px; border: 1px solid var(--rule); background: var(--surface); }
.post-types > div { padding: 10px 12px; border-right: 1px solid var(--rule); }
.post-types > div:nth-child(3) { border-right: 0; }
.post-types strong { display: block; font-size: 11px; }
.post-types code { font-size: 8px; color: var(--ink-muted); }
.post-types small { display: block; margin-top: 3px; color: var(--ink-muted); font-size: 9px; }
.post-types > p { grid-column: 1 / -1; margin: 0; padding: 6px 12px; border-top: 1px solid var(--rule); }
.post-plan-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.voice-form { display: grid; gap: 8px; }
.voice-form label { display: grid; gap: 3px; font-size: 9px; color: var(--ink-muted); }
.voice-form input { padding: 6px 8px; border: 1px solid var(--rule); font-size: 11px; }
.status-pill.is-improved { background: #e6f4ee; color: #147a6c; } .status-pill.is-declined { background: var(--red-soft); color: var(--red); } .status-pill.is-flat, .status-pill.is-inconclusive { background: #eef2f5; color: var(--ink-muted); }
@media (max-width: 900px) { .post-types, .post-plan-grid { grid-template-columns: 1fr; } .post-types > div { border-right: 0; border-bottom: 1px solid var(--rule); } }
```

- [ ] **Step 7: 通过、构建、提交**

Run: `npm run test:run -- src/features/merchant src/App.test.tsx && npm run build`

```bash
git add src/api src/App.tsx src/features/merchant src/styles/post-plan.css src/styles.css
git commit -m "feat(merchant): GBP Post weekly plan sub-page with versioned voice profile"
```

---

### Task 8: 复盘页 — 商户·轮次复盘卡、到窗口队列、任务级证据分级

**Files:**
- Create: `server/src/services/effectReviewService.ts`
- Modify: `server/src/routes/seoOps.ts`（`GET /api/seo-ops/effect-reviews`）
- Test: `server/tests/effectReviews.test.ts`
- Modify: `src/api/types.ts`、`src/api/seoOpsApi.ts`、`src/features/reviews/ReviewsPage.tsx`、`src/styles/review-settings.css`
- Test: `src/features/settings/SettingsPage.test.tsx`（既有复盘测试）、`src/features/reviews/ReviewsPage.test.tsx`（新建）

**Interfaces:**
- Consumes: `listSpecialistArtifactsByMerchant(db, merchantId, "EFFECT_REVIEW")`、`listCycleConfigs`、`listMerchants/ForOperator`。
- Produces: `GET /api/seo-ops/effect-reviews?merchant_id=` → `{ summary: { total, by_tier: Record<string, number>, due_count }, items: EffectReviewWire[], windows: ReviewWindowWire[] }`。

- [ ] **Step 1: 服务端失败测试**

`server/tests/effectReviews.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertSpecialistArtifact } from "../src/repos/specialistArtifactRepo.js";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("effect reviews projection", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;
  let taskId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({ method: "POST", url: "/api/seo-ops/merchants", payload: { slug: "review-a", display_name: "Review A", operator_user_ids: [built.actor.userId], idempotency_key: "review-a" } })).json().id;
    taskId = (await app.inject({ method: "POST", url: "/api/seo-ops/tasks", payload: { merchant_id: merchantId, idempotency_key: "review-task", definition: { title: "第 2 轮复盘", task_type: "REVIEW", source: "OPERATOR", priority: "LOW", impact: "LOW", execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } } })).json().id;
    await app.inject({ method: "PUT", url: `/api/seo-ops/merchants/${merchantId}/cycle-config`, payload: { snapshot_day: 5, post_weekday: 4, post_per_week: 1, review_window_days: 30, audit_interval_days: null, enabled: true } });
    await insertSpecialistArtifact(built.db, {
      id: "art-review-1", taskId, merchantId, artifactType: "EFFECT_REVIEW", schemaVersion: "seo_ops.effect_review.v1",
      title: "Review A · 第 2 轮", summary: "SoLV 14.4 → 26.2", coreRunId: "core-review-1", createdBy: null, createdAt: "2026-08-06T09:00:00.000Z",
      payload: { schema_version: "seo_ops.effect_review.v1", merchant_id: merchantId, title: "Review A · 第 2 轮", summary: "SoLV 14.4 → 26.2",
        baseline: { solv_mean: 14.4 }, action_bundle: [{ action_id: "post-weekly", description: "GBP Post 周更 ×6", executed_at: "2026-07-20T00:00:00Z", evidence_ref: "task:t1" }],
        observed_change: { solv_mean: 26.2 }, confounders: ["竞对 1 家同期降权", "无对照组"], conclusion_tier: "ASSOCIATIONAL",
        conclusion: "正向关联 · 建议 KEEP", planning_signals: [{ keep: "post-weekly" }], limitations: ["2 个目标词不升反降"] },
    });
  });

  afterEach(async () => app.close());

  it("lists review artifacts per merchant with tier, confounders, and next window", async () => {
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/effect-reviews?now=2026-08-27T00:00:00.000Z" });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.summary).toMatchObject({ total: 1, by_tier: { ASSOCIATIONAL: 1 }, due_count: 0 });
    expect(body.items[0]).toMatchObject({ merchant_name: "Review A", conclusion_tier: "ASSOCIATIONAL", confounders: ["竞对 1 家同期降权", "无对照组"], task_id: taskId, causal_identified: false });
    expect(body.windows[0]).toMatchObject({ merchant_name: "Review A", review_window_days: 30, last_review_at: "2026-08-06T09:00:00.000Z", next_window_at: "2026-09-05T09:00:00.000Z", status: "UPCOMING" });
  });
});
```

- [ ] **Step 2: 确认失败**：`cd server && npm test -- tests/effectReviews.test.ts`。

- [ ] **Step 3: 服务**

`server/src/services/effectReviewService.ts`:

```ts
import type { Db } from "../db/connection.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { listCycleConfigs } from "../repos/settingsRepo.js";
import { listSpecialistArtifactsByMerchant, type SpecialistArtifact } from "../repos/specialistArtifactRepo.js";

export interface EffectReviewWire {
  artifact_id: string; merchant_id: string; merchant_name: string; task_id: string; core_run_id: string;
  title: string; summary: string; conclusion_tier: string; conclusion: string;
  baseline: Record<string, unknown>; observed_change: Record<string, unknown>;
  action_bundle: Array<Record<string, unknown>>; confounders: string[]; limitations: string[];
  planning_signals: Array<Record<string, unknown>>; acceptance_status: string; created_at: string;
  /** 单店复盘永远为 false：没有对照组就没有因果识别。 */
  causal_identified: false;
}
export interface ReviewWindowWire {
  merchant_id: string; merchant_name: string; review_window_days: number | null;
  last_review_at: string | null; next_window_at: string | null; status: "DUE" | "UPCOMING" | "UNSCHEDULED";
}
export interface EffectReviewsWire {
  summary: { total: number; by_tier: Record<string, number>; due_count: number };
  items: EffectReviewWire[]; windows: ReviewWindowWire[];
}

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
function records(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === "object") : []; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function wire(a: SpecialistArtifact, merchantName: string): EffectReviewWire {
  const p = a.payload;
  return {
    artifact_id: a.id, merchant_id: a.merchantId, merchant_name: merchantName, task_id: a.taskId, core_run_id: a.coreRunId,
    title: a.title, summary: a.summary,
    conclusion_tier: typeof p.conclusion_tier === "string" ? p.conclusion_tier : "INSUFFICIENT_EVIDENCE",
    conclusion: typeof p.conclusion === "string" ? p.conclusion : a.summary,
    baseline: record(p.baseline), observed_change: record(p.observed_change),
    action_bundle: records(p.action_bundle), confounders: strings(p.confounders), limitations: strings(p.limitations),
    planning_signals: records(p.planning_signals), acceptance_status: a.acceptanceStatus, created_at: a.createdAt,
    causal_identified: false,
  };
}

/** 复盘投影：EFFECT_REVIEW 产物按商户聚合；窗口 = 上次复盘 + review_window_days（Gate D）。 */
export async function effectReviews(db: Db, actorUserId: string, scopeAll: boolean, merchantId: string | undefined, now: Date = new Date()): Promise<EffectReviewsWire> {
  const merchants = (scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, actorUserId)).filter((m) => !merchantId || m.id === merchantId);
  const configs = new Map((await listCycleConfigs(db)).map((c) => [c.merchantId, c]));
  const items: EffectReviewWire[] = [];
  const windows: ReviewWindowWire[] = [];
  for (const merchant of merchants) {
    const artifacts = await listSpecialistArtifactsByMerchant(db, merchant.id, "EFFECT_REVIEW");
    items.push(...artifacts.map((a) => wire(a, merchant.displayName)));
    const last = artifacts[0]?.createdAt ?? null;
    const windowDays = configs.get(merchant.id)?.reviewWindowDays ?? null;
    const next = last && windowDays ? new Date(Date.parse(last) + windowDays * 86_400_000).toISOString() : null;
    windows.push({
      merchant_id: merchant.id, merchant_name: merchant.displayName, review_window_days: windowDays,
      last_review_at: last, next_window_at: next,
      status: !windowDays ? "UNSCHEDULED" : next && Date.parse(next) <= now.getTime() ? "DUE" : "UPCOMING",
    });
  }
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const byTier: Record<string, number> = {};
  for (const item of items) byTier[item.conclusion_tier] = (byTier[item.conclusion_tier] ?? 0) + 1;
  return { summary: { total: items.length, by_tier: byTier, due_count: windows.filter((w) => w.status === "DUE").length }, items, windows };
}
```

- [ ] **Step 4: 路由**

`seoOps.ts` 在 `/api/seo-ops/reviews` 之后：

```ts
  const effectReviewsQuerySchema = z.object({ merchant_id: z.string().min(1).optional(), now: z.string().datetime().optional() });
  app.get("/api/seo-ops/effect-reviews", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const query = effectReviewsQuerySchema.parse(request.query);
    if (query.merchant_id) await requireMerchantAccess(ctx.db, actor, query.merchant_id);
    return effectReviews(ctx.db, actor.userId, actor.scopeAll === true, query.merchant_id, query.now ? new Date(query.now) : new Date());
  });
```

- [ ] **Step 5: 通过并提交服务端**

```bash
cd server && npm test -- tests/effectReviews.test.ts && npm run typecheck && cd ..
git add server/src/services/effectReviewService.ts server/src/routes/seoOps.ts server/tests/effectReviews.test.ts
git commit -m "feat(reviews): merchant-round effect review projection with Gate D windows"
```

- [ ] **Step 6: 前端类型/客户端**

```ts
export interface EffectReviewItem { artifact_id: string; merchant_id: string; merchant_name: string; task_id: string; core_run_id: string; title: string; summary: string; conclusion_tier: string; conclusion: string; baseline: Record<string, unknown>; observed_change: Record<string, unknown>; action_bundle: Array<Record<string, unknown>>; confounders: string[]; limitations: string[]; planning_signals: Array<Record<string, unknown>>; acceptance_status: string; created_at: string; causal_identified: false }
export interface ReviewWindow { merchant_id: string; merchant_name: string; review_window_days: number | null; last_review_at: string | null; next_window_at: string | null; status: "DUE" | "UPCOMING" | "UNSCHEDULED" }
export interface EffectReviewsView { summary: { total: number; by_tier: Record<string, number>; due_count: number }; items: EffectReviewItem[]; windows: ReviewWindow[] }
```

```ts
  effectReviews: (merchantId?: string, signal?: AbortSignal) =>
    requestJson<EffectReviewsView>(`/api/seo-ops/effect-reviews${merchantId ? `?merchant_id=${encodeURIComponent(merchantId)}` : ""}`, { signal }),
```

- [ ] **Step 7: 前端失败测试**

`src/features/reviews/ReviewsPage.test.tsx`（mock `/api/seo-ops/effect-reviews` 返回 Step 1 形状的一条 item + 一条 `DUE` window；`/api/seo-ops/reviews` 返回一条 `CORRELATIONAL` task item）：

```tsx
test("reviews page leads with merchant-round cards capped at ASSOCIATIONAL and lists Gate D windows", async () => {
  renderApp("/reviews?view=audit");
  expect(await screen.findByRole("heading", { name: "复盘" })).toBeInTheDocument();
  expect(screen.getByText(/不宣称因果/)).toBeInTheDocument();
  const card = screen.getByRole("article", { name: /Review A · 第 2 轮/ });
  expect(within(card).getByText("基线").nextElementSibling).toHaveTextContent("solv_mean: 14.4");
  expect(within(card).getByText("竞争与混杂").nextElementSibling).toHaveTextContent("竞对 1 家同期降权");
  expect(within(card).getByText(/ASSOCIATIONAL/)).toBeInTheDocument();
  expect(within(card).getByText("causalIdentified = false")).toBeInTheDocument();
  const queue = screen.getByRole("region", { name: "到窗口队列" });
  expect(within(queue).getByText("将到期")).toBeInTheDocument();
});

test("task-level evidence classification stays available without upgrading to causal language", async () => {
  renderApp("/reviews?view=audit");
  const section = await screen.findByRole("region", { name: "任务级证据分级" });
  expect(within(section).getByText("关联观察，不代表因果")).toBeInTheDocument();
  expect(within(section).getByText("CORRELATIONAL")).toBeInTheDocument();
});
```

- [ ] **Step 8: 重写 ReviewsPage**

```tsx
import { ArrowRight, FlaskConical } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { seoOpsApi } from "../../api/seoOpsApi";
import type { EffectReviewItem } from "../../api/types";
import { formatDateOnly } from "../../app/format";
import { usePageTitle } from "../../hooks/usePageTitle";
import { useResource } from "../../hooks/useResource";
import { useWorkspace } from "../../workspace/WorkspaceContext";
import { classificationLabel, reviewExplanation, tierLabel } from "./reviewCopy";

function kv(value: Record<string, unknown>): string {
  const entries = Object.entries(value);
  return entries.length ? entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`).join(" · ") : "数据不可用";
}

export function ReviewsPage() {
  usePageTitle("复盘");
  const workspace = useWorkspace();
  const [params] = useSearchParams();
  const merchantId = params.get("merchant_id") ?? workspace.merchantId;
  const effect = useResource((signal) => seoOpsApi.effectReviews(merchantId, signal), [merchantId]);
  const tasks = useResource((signal) => seoOpsApi.reviews({ merchant_id: merchantId, limit: 50 }, signal), [merchantId]);
  const s = effect.data?.summary;
  const tiers = s ? Object.entries(s.by_tier).map(([tier, n]) => `${tier} ×${n}`).join(" · ") : "—";
  return <>
    <header className="page-heading"><div><span className="eyebrow">OUTCOME REVIEW · 跨商户</span><h1>复盘</h1><p>动作之后发生了什么。单店结论上限 ASSOCIATIONAL（关联），不宣称因果；跨店聚合仅作模式探索，不进客户报告。</p></div><span className="scope-chip"><FlaskConical size={14} /> {workspace.merchants.find((m) => m.id === merchantId)?.display_name ?? "全部商户"}</span></header>

    <section aria-label="复盘汇总" className="runs-summary">
      <div className="runs-summary-cell"><span>已完成复盘</span><strong>{s?.total ?? "—"}</strong><small>快照冻结 · 可同快照重放</small></div>
      <div className={`runs-summary-cell${s?.due_count ? " is-danger" : ""}`}><span>到窗口待复盘</span><strong>{s?.due_count ?? "—"}</strong><small>Gate D · 窗口未到不复盘</small></div>
      <div className="runs-summary-cell"><span>结论分布</span><strong>{s ? Object.values(s.by_tier).reduce((a, b) => a + b, 0) : "—"}</strong><small>{tiers}</small></div>
      <div className="runs-summary-cell"><span>证据上限</span><strong>ASSOC.</strong><small>无对照组 · causalIdentified = false</small></div>
    </section>

    {effect.loading ? <div className="page-state" role="status">读取复盘…</div> : null}
    {effect.error ? <div className="page-state is-error" role="alert">复盘读取失败。<button onClick={effect.reload} type="button">重试</button></div> : null}
    <div className="review-list">{effect.data?.items.map((item) => <ReviewCard item={item} key={item.artifact_id} />)}</div>
    {effect.data && !effect.data.items.length ? <div className="empty-state slim"><p>还没有复盘产物。到达复盘窗口后由 REVIEW 任务自动出稿，结论上限 ASSOCIATIONAL。</p></div> : null}

    <section aria-label="到窗口队列" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">GATE D</span><h2>到窗口队列</h2><p className="quiet-copy">窗口未到不复盘 · 窗口 = 上次复盘 + 复盘窗口天数</p></div></div>
      <div className="table-wrap"><table><thead><tr><th>商户</th><th>上次复盘</th><th>下次窗口</th><th>状态</th></tr></thead><tbody>
        {(effect.data?.windows ?? []).map((w) => <tr key={w.merchant_id}><td>{w.merchant_name}</td><td>{formatDateOnly(w.last_review_at)}</td><td>{w.next_window_at ? formatDateOnly(w.next_window_at) : w.review_window_days ? "待首轮复盘" : "未配置窗口"}</td><td><span className={`status-pill ${w.status === "DUE" ? "is-attention" : "is-stable"}`}>{w.status === "DUE" ? "已到期" : w.status === "UPCOMING" ? "将到期" : "未排期"}</span></td></tr>)}
      </tbody></table></div></section>

    <section aria-label="任务级证据分级" className="data-panel"><div className="panel-heading"><div><span className="eyebrow">TASK EVIDENCE · 审计</span><h2>任务级证据分级</h2><p className="quiet-copy">按任务当前版本的已核实证据类型分级，不构成因果证明。</p></div></div>
      {tasks.loading ? <div className="page-state compact" role="status">读取任务证据…</div> : null}
      <div className="review-list">{tasks.data?.items.map((item) => <article aria-labelledby={`review-${item.task_id}`} className={`review-card review-${item.classification.toLocaleLowerCase()}`} key={item.task_id}>
        <header><div><span className="eyebrow">TASK {item.task_id}</span><h3 id={`review-${item.task_id}`}>{item.goal ?? "目标未记录"}</h3></div><span className={`classification is-${item.classification.toLocaleLowerCase()}`} title={classificationLabel(item.classification)}>{item.classification}</span></header>
        <p className={`review-explanation${item.classification === "CORRELATIONAL" ? " is-association" : ""}`}>{item.classification === "CORRELATIONAL" ? <strong>关联观察，不代表因果</strong> : null}<span>{reviewExplanation(item.classification)}</span></p>
        <footer><span>{item.evidence_ids.length} 条技术证据引用</span><Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>查看任务 <ArrowRight size={14} /></Link></footer>
      </article>)}</div>
    </section>
  </>;
}

function ReviewCard({ item }: { item: EffectReviewItem }) {
  const rows: Array<[string, string]> = [
    ["目标", item.summary],
    ["基线", kv(item.baseline)],
    ["动作束", item.action_bundle.length ? item.action_bundle.map((a) => String(a.description ?? a.action_id ?? "")).filter(Boolean).join(" · ") + "（bundle 不拆单归因）" : "数据不可用"],
    ["观察变化", kv(item.observed_change)],
    ["竞争与混杂", item.confounders.length ? item.confounders.join(" · ") : "未记录"],
    ["负向证据 / 局限", item.limitations.length ? item.limitations.join(" · ") : "未披露"],
    ["结论与建议", item.conclusion],
    ["下一轮输入", item.planning_signals.length ? item.planning_signals.map((p) => JSON.stringify(p)).join(" · ") : "—"],
  ];
  return <article aria-label={item.title} className={`review-card review-tier-${item.conclusion_tier.toLowerCase()}`}>
    <header><div><span className="eyebrow">{item.merchant_name} · {formatDateOnly(item.created_at)} · run {item.core_run_id.slice(0, 8)}</span><h2>{item.title}</h2></div><span className="classification">{tierLabel(item.conclusion_tier)}</span></header>
    <dl className="causal-chain is-review">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <footer><span>验收 {item.acceptance_status} · <code>causalIdentified = false</code></span><Link className="text-button" to={`/tasks/${encodeURIComponent(item.task_id)}`}>打开报告任务 <ArrowRight size={14} /></Link></footer>
  </article>;
}
```

`review-settings.css` 追加：`.causal-chain.is-review { grid-template-columns: repeat(4, minmax(160px, 1fr)); } .review-card.review-tier-associational::before { background: var(--teal); } .review-card.review-tier-insufficient_evidence::before { background: var(--amber); }`。

更新 `SettingsPage.test.tsx` 第 335 行的复盘测试：改为在 `region "任务级证据分级"` 内查找同样的文案；mock 增加 `/api/seo-ops/effect-reviews` → `{ summary: { total: 0, by_tier: {}, due_count: 0 }, items: [], windows: [] }`。

- [ ] **Step 9: 通过、构建、提交**

Run: `npm run test:run -- src/features/reviews src/features/settings && npm run build`

```bash
git add src/api src/features/reviews src/features/settings/SettingsPage.test.tsx src/styles/review-settings.css
git commit -m "feat(reviews): merchant-round review cards, Gate D windows, audit-only task classification"
```

---

### Task 9: 设置页 — 跨商户能力矩阵与周期总览

**Files:**
- Modify: `server/src/routes/executionRoutes.ts`（`GET /api/seo-ops/capabilities`）
- Test: `server/tests/capabilities.test.ts`
- Modify: `src/api/types.ts`、`src/api/seoOpsApi.ts`、`src/features/settings/CapabilityMatrixPanel.tsx`、`src/features/settings/CadencePanel.tsx`、`src/features/settings/SettingsPage.tsx`、`src/features/settings/SettingsPage.test.tsx`、`src/styles/review-settings.css`

**Interfaces:**
- Produces: `GET /api/seo-ops/capabilities` → `{ items: Array<CapabilityWire & { merchant_name: string }> }`（按操作员范围过滤）；`seoOpsApi.allCapabilities(signal)`；`seoOpsApi.cycleConfigs(signal)` → `{ items: CycleConfigWire[] }`（路由已存在）。
- 能力键扩为 `GBP_WRITE / REVIEW_REPLY / WEBSITE_WRITE / WEBSITE_APPLY / XHS_PUBLISH`；只有 `GBP_WRITE` 与 `WEBSITE_WRITE` 参与门 2 校验（`requiredCapabilityFor`），其余仅供建议校验与接入提醒——在面板里明示。

- [ ] **Step 1: 服务端失败测试**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("cross-merchant capabilities", () => {
  let built: AuthenticatedTestApp; let app: FastifyInstance; let merchantId: string;
  beforeEach(async () => {
    built = await createAuthenticatedTestApp(); app = built.app;
    merchantId = (await app.inject({ method: "POST", url: "/api/seo-ops/merchants", payload: { slug: "cap-a", display_name: "Cap A", operator_user_ids: [built.actor.userId], idempotency_key: "cap-a" } })).json().id;
    await app.inject({ method: "PUT", url: `/api/seo-ops/merchants/${merchantId}/capabilities/XHS_PUBLISH`, payload: { asset: "XHS", tech_connected: false, merchant_authorized: false, note: "账号待连接" } });
  });
  afterEach(async () => app.close());
  it("lists capabilities across scoped merchants with merchant names", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/seo-ops/capabilities" })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ merchant_id: merchantId, merchant_name: "Cap A", capability: "XHS_PUBLISH", status: "MISSING", note: "账号待连接" });
  });
});
```

- [ ] **Step 2: 确认失败**，然后在 `executionRoutes.ts` 的 `/api/seo-ops/cycle-configs` 后追加：

```ts
  app.get("/api/seo-ops/capabilities", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const merchants = actor.scopeAll ? await listMerchants(ctx.db) : await listMerchantsForOperator(ctx.db, actor.userId);
    const names = new Map(merchants.map((m) => [m.id, m.displayName]));
    return {
      items: (await listCapabilities(ctx.db)).filter((c) => names.has(c.merchantId))
        .map((c) => ({ ...capabilityView(c), merchant_name: names.get(c.merchantId) })),
    };
  });
```

（确认 `listMerchants`、`listCapabilities` 已 import；没有则补。）

- [ ] **Step 3: 通过并提交服务端**

```bash
cd server && npm test -- tests/capabilities.test.ts && npm run typecheck && cd ..
git add server/src/routes/executionRoutes.ts server/tests/capabilities.test.ts
git commit -m "feat(settings): expose scoped cross-merchant capability matrix"
```

- [ ] **Step 4: 前端客户端**

```ts
  allCapabilities: (signal?: AbortSignal) =>
    requestJson<{ items: Array<CapabilityWire & { merchant_name: string }> }>("/api/seo-ops/capabilities", { signal }),
  cycleConfigs: (signal?: AbortSignal) =>
    requestJson<{ items: CycleConfigWire[] }>("/api/seo-ops/cycle-configs", { signal }),
```

- [ ] **Step 5: 失败测试**

`SettingsPage.test.tsx` mock 追加 `/api/seo-ops/capabilities`（两家商户各一条 GBP_WRITE：一条 ACTIVE、一条 BLOCKED 带 `note: "待商家授权"`）与 `/api/seo-ops/cycle-configs`（一条 `post_weekday: 4`）。新增：

```tsx
test("capability matrix lists every scoped merchant × capability with impact copy and inline toggles", async () => {
  renderApp("/settings");
  const matrix = await screen.findByRole("region", { name: "能力矩阵" });
  expect(within(matrix).getByRole("row", { name: /Only Bear.*GBP_WRITE/ })).toHaveTextContent("可进双门执行（仍需门 1+2）");
  expect(within(matrix).getByRole("row", { name: /Keke Food.*GBP_WRITE/ })).toHaveTextContent("GBP 写入类建议一律校验失败");
  expect(within(matrix).getByRole("row", { name: /Only Bear.*XHS_PUBLISH/ })).toHaveTextContent("MISSING");
});

test("cadence overview summarises every merchant cycle before the per-merchant form", async () => {
  renderApp("/settings");
  const overview = await screen.findByRole("region", { name: "周期总览" });
  expect(within(overview).getByRole("row", { name: /Only Bear/ })).toHaveTextContent("每周四 ×1");
});
```

- [ ] **Step 6: 实现 CapabilityMatrixPanel（跨商户）**

`CAPABILITY_ROWS` 改为：

```ts
const CAPABILITY_ROWS = [
  { capability: "GBP_WRITE", asset: "GBP", label: "GBP 写入（Post / 资料修改）", gate2: true },
  { capability: "REVIEW_REPLY", asset: "GBP", label: "GBP 评论回复", gate2: false },
  { capability: "WEBSITE_WRITE", asset: "WEBSITE", label: "官网写入", gate2: true },
  { capability: "WEBSITE_APPLY", asset: "WEBSITE", label: "官网成品人工应用", gate2: false },
  { capability: "XHS_PUBLISH", asset: "XHS", label: "小红书发布", gate2: false },
];
export function impactCopy(status: string, capability: string): string {
  if (status === "ACTIVE") return capability === "GBP_WRITE" || capability === "WEBSITE_WRITE" ? "可进双门执行（仍需门 1+2）" : "建议校验可通过";
  if (status === "BLOCKED") return `${capability.startsWith("GBP") ? "GBP" : capability.startsWith("WEBSITE") ? "官网" : "该资产"} 写入类建议一律校验失败`;
  return "未连接 · 相关建议校验失败的数据源";
}
```

面板改为跨商户：数据源 `seoOpsApi.allCapabilities` + `workspace.merchants`；行 = 每个商户 × `CAPABILITY_ROWS`（`aria-label={`${merchant.display_name} ${capability}`}`）；列：商户 · 资产 / 能力 / 技术连接 (checkbox) / 商户授权 (checkbox) / 状态 / 最近核验 / 影响 / 备注（点击展开 inline `input` 编辑 `note`、`external_ref`，保存走 `upsertCapability`）。`merchantId` prop 仍保留：当前设置页选中的商户行高亮（`is-selected`）。`canManage` 为假时 checkbox disabled。保留 `PanelHeading`，副标题改为「三层缺一即挡：技术连接 → 商户授权 → 单次仍需门 1 + 门 2」。

- [ ] **Step 7: CadencePanel 周期总览**

在 `CadenceResource` 上方新增 `CadenceOverview` 组件（`aria-label="周期总览"`，用 `seoOpsApi.cycleConfigs` + `workspace.merchants` 拼名字）：列 商户 / 月度快照 / Post 节奏 / 复盘窗口 / 审计间隔 / 启用；Post 节奏文案 `每${WEEKDAYS[post_weekday]} ×${post_per_week}` 或「暂停」。`CadencePanel` 渲染顺序：`PanelHeading` → `CadenceOverview` → 既有表单。

- [ ] **Step 8: 通过、构建、提交**

Run: `npm run test:run -- src/features/settings && npm run build`

```bash
git add src/api src/features/settings src/styles/review-settings.css
git commit -m "feat(settings): cross-merchant capability matrix and cadence overview"
```

---

### Task 10: 全量验证与收尾

- [ ] **Step 1: 全量测试**

```bash
npm run test:run
cd server && npm test && npm run typecheck && cd ..
npm run build
git diff --check
```

Expected: 全部 PASS。

- [ ] **Step 2: 手工核对（浏览器，本地 dev）**

`npm run dev` + `cd server && npm run dev`，以 `?view=audit` 依次打开 `/`、`/runs`、`/inbox?tab=proposals`、`/merchants/:id`、`/merchants/:id/post-plan`、`/reviews`、`/settings`，对照画板确认：六导航无 Copilot；总览异常清单五组；运行页汇总条 + Run 账本；GBP 任务页轨为 5 步且「发布」「生效核对」分开；复盘页标题「复盘」。

- [ ] **Step 3: 记录证据**

在 `docs/evidence/` 下新建 `2026-08-27-design-canvas-gap-closure.md`，逐任务列出：路由、测试文件、提交哈希、与画板的对应画板名。提交：

```bash
git add docs/evidence/2026-08-27-design-canvas-gap-closure.md
git commit -m "docs: record design canvas gap closure evidence"
```

## 明确不做（留给后续）

- 用户与权限管理（用户列表 / 商户范围 / 权限点编辑）：后端没有用户列表接口与授权模型，设置页保持只读显示当前身份。
- Copilot 顶栏入口：规范明确排除。
- 操作员视角的「内容快审 连过」「分组催办话术」（压测稿）：需要新的批量接口与外发模板，另立计划。
- 运营期「节奏条」页头：需要「首轮复盘完成」的持久化标记，另立计划。
- 并发/配额数字：Core AI 未提供配额接口，页面明示「未接入」。

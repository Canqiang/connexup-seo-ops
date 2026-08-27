import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import type { AttemptWire, CycleLedgerView, DraftWire, LifecycleView, PostProgramView, RankingOverviewView, SpecialistArtifactWire, TaskAuditReferencesWire } from "./api/types";
import { portfolioFixture, stageRunRunningFixture, taskFixture, userFixture } from "./test/fixtures";

const navigateTo = vi.hoisted(() => vi.fn());

vi.mock("./auth/redirect", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth/redirect")>();
  return { ...original, navigateTo };
});

const lifecycleFixture: LifecycleView = {
  merchant_id: "only-bear", stage: "QUESTIONNAIRE",
  stages: [
    { key: "QUESTIONNAIRE", status: "CURRENT", note: "问卷未回收" },
    { key: "KEYWORDS", status: "OFF", note: "等问卷" },
    { key: "AUDIT", status: "OFF", note: "等关键词" },
    { key: "RANKING_BASELINE", status: "OFF", note: "等审计" },
    { key: "PLAN", status: "OFF", note: "等基线" },
    { key: "EXECUTE", status: "OFF", note: "等任务授权" },
    { key: "VERIFY", status: "OFF", note: "等执行回填" },
  ],
  questionnaire: { id: "q-1", status: "SENT", share_slug: "ab12cd34", send_count: 1, sent_at: "2026-08-18T08:00:00Z", last_sent_at: "2026-08-18T08:00:00Z", filled_at: null },
  latest_runs: {},
  plan_converted: false,
  open_task_count: 0, approved_task_count: 0, ready_for_approval_count: 0, unverified_evidence_count: 0,
  last_report: null,
  ranking_round_count: 0,
  exception: { type: "WAITING_MERCHANT", waiting_days: 1, send_count: 1, questionnaire_id: "q-1" },
};

const keywordsLifecycleFixture: LifecycleView = {
  ...lifecycleFixture,
  stage: "KEYWORDS",
  stages: [
    { key: "QUESTIONNAIRE", status: "DONE", note: "问卷已回收" },
    { key: "KEYWORDS", status: "CURRENT", note: "未生成" },
    { key: "AUDIT", status: "OFF", note: "等关键词" },
    { key: "RANKING_BASELINE", status: "OFF", note: "等审计" },
    { key: "PLAN", status: "OFF", note: "等基线" },
    { key: "EXECUTE", status: "OFF", note: "等任务授权" },
    { key: "VERIFY", status: "OFF", note: "等执行回填" },
  ],
  questionnaire: { ...lifecycleFixture.questionnaire!, status: "FILLED", filled_at: "2026-08-18T09:00:00Z" },
  exception: { type: "NONE" },
};

// 老店稳态：走完一整轮，处于第 2 轮（两次排名快照），带与上期对比。
const steadyLifecycleFixture: LifecycleView = {
  ...lifecycleFixture,
  stage: "EXECUTE",
  stages: [
    { key: "QUESTIONNAIRE", status: "DONE", note: "8-12 商家已填" },
    { key: "KEYWORDS", status: "DONE", note: "8-13" },
    { key: "AUDIT", status: "DONE", note: "8-14 GBP+站内" },
    { key: "RANKING_BASELINE", status: "DONE", note: "8-15 local+organic" },
    { key: "PLAN", status: "DONE", note: "已转执行任务" },
    { key: "EXECUTE", status: "CURRENT", note: "任务 1 个 · 人工执行" },
    { key: "VERIFY", status: "OFF", note: "—" },
  ],
  questionnaire: { ...lifecycleFixture.questionnaire!, status: "FILLED", filled_at: "2026-08-12T09:00:00Z" },
  plan_converted: true,
  open_task_count: 1,
  last_report: { captured_at: "2026-08-15T10:00:00Z", age_days: 4 },
  ranking_round_count: 2,
  exception: { type: "NONE" },
};

const emptyRankingFixture: RankingOverviewView = { round_count: 0, latest: null, previous: null, comparison: null };

const rankingFixture: RankingOverviewView = {
  round_count: 2,
  latest: {
    run_id: "run-new",
    captured_at: "2026-08-15T10:00:00.000Z",
    keyword_count: 2,
    rows: [
      { keyword: "ramen near me", local_rank: 9, organic_rank: 8, local_delta: 3, organic_delta: 3, is_new: false },
      { keyword: "ramen delivery", local_rank: 5, organic_rank: 30, local_delta: null, organic_delta: null, is_new: true },
    ],
  },
  previous: { run_id: "run-old", captured_at: "2026-08-08T10:00:00.000Z" },
  comparison: {
    local_avg: { current: 7, previous: 12, delta: 5 },
    organic_top10: { current: 1, previous: 1, total: 2 },
    new_keyword_count: 1,
  },
};

let lifecycleData: LifecycleView = lifecycleFixture;
let rankingData: RankingOverviewView = emptyRankingFixture;
let reportsData: unknown = { items: [], offset: 0, limit: 50, total: 0 };
let cycleLedgerData: CycleLedgerView = { items: [] };
let postProgramData: PostProgramView = { voice_profile: null, cluster_signals: [], history: [], proposals: [], evidence_gaps: [] };
let stageRunPostFails = false;
let portfolioData = portfolioFixture;
let authenticatedUser = userFixture;
let taskData = taskFixture;
let draftData: DraftWire[] = [];
let artifactData: SpecialistArtifactWire[] = [];
let attemptData: AttemptWire[] = [];
let auditReferenceData: TaskAuditReferencesWire = { agent_runs: [], artifacts: [] };
let auditReferencePages = new Map<number, TaskAuditReferencesWire>();
let delayedAuditLoadMore: Promise<Response> | undefined;
let inboxFails = false;
let inboxData: unknown = { items: [], offset: 0, limit: 50, total: 0 };
type InboxResponder = (offset: number, limit: number) => Response | Promise<Response>;
let inboxResponder: InboxResponder | undefined;
const calls: Array<{ path: string; init?: RequestInit }> = [];

beforeEach(() => {
  lifecycleData = lifecycleFixture;
  rankingData = emptyRankingFixture;
  reportsData = { items: [], offset: 0, limit: 50, total: 0 };
  cycleLedgerData = { items: [] };
  postProgramData = { voice_profile: null, cluster_signals: [], history: [], proposals: [], evidence_gaps: [] };
  stageRunPostFails = false;
  portfolioData = portfolioFixture;
  authenticatedUser = userFixture;
  taskData = taskFixture;
  draftData = [];
  artifactData = [];
  attemptData = [];
  auditReferenceData = { agent_runs: [], artifacts: [] };
  auditReferencePages = new Map();
  delayedAuditLoadMore = undefined;
  inboxFails = false;
  inboxData = { items: [], offset: 0, limit: 50, total: 0 };
  inboxResponder = undefined;
  calls.length = 0;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-2222-2222-222222222222");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/me") return json(authenticatedUser);
    if (path === "/api/auth/logout") return new Response(null, { status: 204 });
    if (path === "/api/seo-ops/portfolio") return json(portfolioData);
    if (path.startsWith("/api/seo-ops/workbench")) return json({ summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 50, total: 0 });
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: true, copilot_agent_id: "agent-safe", agent_run_enabled: true, agent_run_stages: ["KEYWORDS", "AUDIT", "RANKING_BASELINE", "PLAN", "REVIEW"] });
    if (path === "/api/seo-ops/tasks/task-1") return json(taskData);
    if (path === "/api/seo-ops/tasks/task-2") return json({ ...taskFixture, id: "task-2", title: "第二个任务" });
    if (path === "/api/seo-ops/merchants/only-bear/lifecycle") return json(lifecycleData);
    if (path === "/api/seo-ops/merchants/only-bear/ranking") return json(rankingData);
    if (path === "/api/seo-ops/merchants/only-bear/cycle-ledger") return json(cycleLedgerData);
    if (path === "/api/seo-ops/merchants/only-bear/post-program") return json(postProgramData);
    if (path === "/api/seo-ops/merchants/only-bear/artifacts") return json({ items: [] });
    if (path === "/api/seo-ops/merchants/only-bear/stage-runs" && init?.method === "POST") {
      if (stageRunPostFails) return json({ message: "diagnostic upstream unavailable" }, 503);
      return json(stageRunRunningFixture, 202);
    }
    if (path.startsWith("/api/seo-ops/merchants/only-bear/stage-runs")) return json({ items: [], offset: 0, limit: 1, total: 0 });
    if (path.startsWith("/api/seo-ops/agent-runs/")) return json(stageRunRunningFixture);
    if (path.startsWith("/api/seo-ops/tasks/task-1/events")) return json({ items: [], offset: 0, limit: 100, total: 0 });
    if (path.startsWith("/api/seo-ops/tasks/task-2/events")) return json({ items: [], offset: 0, limit: 100, total: 0 });
    if (path === "/api/seo-ops/inbox-summary") return json({ pending_proposals: 0, ready_for_approval: 0, awaiting_execution: 0, pending_verify: 0, outcome_unknown: 0, frozen_merchant_ids: [] });
    if (path.startsWith("/api/seo-ops/proposal-batches")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/tasks/task-1/attempts")) return json({ items: attemptData });
    if (path.startsWith("/api/seo-ops/tasks/task-1/audit-references")) {
      const offset = Number(new URL(path, "https://seo-ops.test").searchParams.get("offset") ?? "0");
      if (offset === 20 && delayedAuditLoadMore) return delayedAuditLoadMore;
      return json(auditReferencePages.get(offset) ?? auditReferenceData);
    }
    if (path.startsWith("/api/seo-ops/tasks/task-2/audit-references")) return json({
      offset: 0,
      limit: 20,
      total: 1,
      agent_runs: [{ id: "task-2-run", core_run_id: "task-2-core-run", deliverables: [] }],
      artifacts: [],
      execution_attempts: [],
    });
    if (path.startsWith("/api/seo-ops/tasks/task-1/execution-preview")) return json({ confirmable: true, attempt_count: 0, gate_ready_status: true, checks: [
      { key: "version", label: "当前版本一致", detail: "审批版本与任务一致", passed: true },
      { key: "authorization", label: "外部授权有效", detail: "商户授权仍有效", passed: true },
    ] });
    if (path.startsWith("/api/seo-ops/tasks/task-1/drafts")) return json({ items: draftData });
    if (path.startsWith("/api/seo-ops/tasks/task-1/artifacts")) return json({ items: artifactData });
    if (path.startsWith("/api/seo-ops/tasks/task-2/drafts")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/tasks/task-2/artifacts")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/inbox")) {
      if (inboxFails) return json({ message: "inbox unavailable" }, 503);
      if (inboxResponder) {
        const url = new URL(path, "https://seo-ops.test");
        return inboxResponder(Number(url.searchParams.get("offset") ?? "0"), Number(url.searchParams.get("limit") ?? "50"));
      }
      return json(inboxData);
    }
    if (path.startsWith("/api/seo-ops/reviews")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path.startsWith("/api/seo-ops/reports")) return json(reportsData);
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); navigateTo.mockReset(); });

test("logout posts the cookie-session endpoint before returning to internal login", async () => {
  const user = userEvent.setup();
  renderApp("/");

  await user.click(await screen.findByRole("button", { name: "退出登录" }));

  await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
    path: "/api/auth/logout",
    init: expect.objectContaining({ method: "POST", credentials: "same-origin" }),
  })));
  expect(navigateTo).toHaveBeenCalledWith("/seo-ops/login");
});

test("application shell does not expose a separate Copilot entry", async () => {
  renderApp("/?view=operator");

  expect(await screen.findByRole("heading", { name: "今天需要我处理" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开 SEO Ops Copilot" })).not.toBeInTheDocument();
  expect(screen.queryByText("Copilot 未配置")).not.toBeInTheDocument();
});

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

test("shareable audit view remains selected when merchant scope changes", async () => {
  const user = userEvent.setup();
  renderApp("/?view=audit");

  await user.click(await screen.findByRole("combobox", { name: "选择商户工作范围" }));
  await user.click(screen.getByRole("option", { name: /Only Bear Chicken & Boba/ }));

  expect(await screen.findByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "运行" })).toBeInTheDocument();
});

test("homepage is the operator workbench; merchants keep the searchable switcher at /merchants", async () => {
  const user = userEvent.setup();
  renderApp("/");
  expect(await screen.findByRole("heading", { name: "今天需要我处理" })).toBeInTheDocument();
  expect(await screen.findByText("今天没有需要人工处理的事项")).toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "选择商户工作范围" }));
  expect(screen.getByRole("option", { name: /Only Bear Chicken & Boba/ })).toBeInTheDocument();
});

test("merchants page keeps the exception list", async () => {
  renderApp("/merchants");
  expect(await screen.findByRole("heading", { name: "商户" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "周期内无待办" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Only Bear Chicken & Boba" })).not.toBeInTheDocument();
});

test("merchant lifecycle keeps its rail explanatory and leads with the persisted questionnaire action", async () => {
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "生命周期阶段（说明）" })).toBeInTheDocument();
  const action = screen.getByRole("region", { name: "当前动作" });
  expect(within(action).getByRole("heading", { name: "等待商家回复" })).toBeInTheDocument();
  expect(within(action).getByRole("button", { name: "重发问卷" })).toBeInTheDocument();
});

test("merchant workspace keeps onboarding in one current-action card and an empty persisted ledger", async () => {
  portfolioData = {
    ...portfolioFixture,
    merchants: [{ ...portfolioFixture.merchants[0], health: "STABLE", stage: "QUESTIONNAIRE" }],
  };

  renderApp("/merchants/only-bear");

  expect(await screen.findByRole("region", { name: "当前动作" })).toHaveTextContent("等待商家回复");
  expect(screen.getByRole("region", { name: "本周期账本" })).toHaveTextContent("活跃周期暂无持久化任务或建议");
});

test("merchant workspace does not replace an empty backend cycle with demo tasks", async () => {
  portfolioData = { ...portfolioFixture, totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 } };
  renderApp("/merchants/only-bear");

  expect(await screen.findByText("活跃周期暂无持久化任务或建议。")).toBeInTheDocument();
  expect(screen.queryByText("FRONTEND DEMO · 最近 4 项")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /打开任务摘要/ })).not.toBeInTheDocument();
});

test("operator keeps specialist runs absent while audit diagnostics send a bounded Stage Run", async () => {
  lifecycleData = keywordsLifecycleFixture;
  const user = userEvent.setup();
  const operator = renderApp("/merchants/only-bear?view=operator");
  expect(await screen.findByRole("region", { name: "当前动作" })).toHaveTextContent("补齐关键词证据");
  expect(screen.queryByRole("button", { name: "运行关键词 Agent" })).not.toBeInTheDocument();
  operator.unmount();

  renderApp("/merchants/only-bear?view=audit");
  expect(await screen.findByRole("region", { name: "管理审计工具" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "运行关键词 Agent" }));
  await vi.waitFor(() => expect(calls).toContainEqual(expect.objectContaining({ path: "/api/seo-ops/merchants/only-bear/stage-runs", init: expect.objectContaining({ method: "POST" }) })));
  const trigger = calls.find((call) => call.path === "/api/seo-ops/merchants/only-bear/stage-runs" && call.init?.method === "POST");
  expect(JSON.parse(String(trigger?.init?.body))).toEqual({ stage: "KEYWORDS", location_id: "mineola", idempotency_key: "audit-diagnostic-KEYWORDS-22222222-2222-2222-2222-222222222222" });
  expect(await screen.findByRole("status")).toHaveTextContent("已登记诊断运行");
  expect(calls.filter((call) => call.path === "/api/seo-ops/merchants/only-bear/lifecycle").length).toBeGreaterThanOrEqual(2);
  expect(calls.some((call) => call.path === "/api/seo-ops/tasks" && call.init?.method === "POST")).toBe(false);
});

test("audit diagnostic exposes a failed Stage Run without creating a task", async () => {
  lifecycleData = keywordsLifecycleFixture;
  stageRunPostFails = true;
  const user = userEvent.setup();
  renderApp("/merchants/only-bear?view=audit");

  await user.click(await screen.findByRole("button", { name: "运行关键词 Agent" }));
  expect(await screen.findByRole("status")).toHaveTextContent("诊断触发失败：diagnostic upstream unavailable");
  expect(calls.some((call) => call.path === "/api/seo-ops/tasks" && call.init?.method === "POST")).toBe(false);
});

test("first-round merchant shows current action and no fabricated ranking comparison", async () => {
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "当前动作" })).toHaveTextContent("等待商家回复");
  expect(screen.getByRole("region", { name: "报告与数据" })).toHaveTextContent("暂无持久化报告或数据产物");
  expect(screen.queryByText(/LOCAL 包内均值/)).not.toBeInTheDocument();
});

test("steady-state merchant uses the dated ledger and persisted panels instead of legacy ranking cards", async () => {
  lifecycleData = steadyLifecycleFixture;
  cycleLedgerData = { items: [{ record_kind: "TASK", task_id: "task-1", proposal_id: null, title: "菜单页发布证据复核", task_type: "WEBSITE_SEO", priority: "URGENT", owner_id: "user-1", due_at: "2026-08-25T08:00:00Z", created_at: "2026-08-24T08:00:00Z", status: "READY_FOR_APPROVAL", execution_mode: "MANUAL", dependency_labels: ["Audit 已完成"], validation_failures: [] }] };
  postProgramData = { voice_profile: { version: 3, summary: [{ key: "tone", label: "语气", value: "friendly" }], created_at: "2026-08-20T08:00:00Z" }, cluster_signals: [], history: [], proposals: [], evidence_gaps: [] };
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "审批本周期任务" })).toBeInTheDocument();
  const table = screen.getByRole("table");
  expect(table).toHaveTextContent("菜单页发布证据复核");
  expect(table).toHaveTextContent("Audit 已完成");
  expect(screen.getByRole("region", { name: "Post 计划" })).toHaveTextContent("语气版本 v3");
});

test("reports page opens the real Core AI attachment for a partner merchant", async () => {
  const coreUrl = "https://core-ai-server.connexup-uat.net/api/public/artifacts/demo-token/content";
  reportsData = {
    items: [{
      report_id: "core-ai:deliverable-1",
      source_type: "CORE_AI_ARTIFACT",
      merchant_id: "only-bear",
      merchant_name: "Only Bear Chicken & Boba",
      location_id: "mineola",
      location_name: "Mineola",
      agent_run_id: "run-1",
      core_run_id: "core-run-1",
      report_type: "AUDIT_REPORT",
      file_id: "file-1",
      file_name: "only-bear-audit.html",
      title: "Only Bear Local SEO Audit",
      content_type: "text/html",
      size: 54553,
      source_ref: coreUrl,
      download_path: "/api/seo-ops/deliverables/deliverable-1/download",
      sha256: "sha256:abc",
      captured_at: "2026-08-19T10:00:00Z",
      freshness: "FRESH",
    }],
    offset: 0,
    limit: 50,
    total: 1,
  };

  renderApp("/reports");

  expect(await screen.findByText("Only Bear Local SEO Audit")).toBeInTheDocument();
  expect(screen.getByText("Only Bear Chicken & Boba")).toBeInTheDocument();
  expect(screen.getByText("Core AI 附件")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "打开 Core AI 附件 only-bear-audit.html" })).toHaveAttribute("href", coreUrl);
});

test("empty inbox renders only the API-backed empty state", async () => {
  portfolioData = { ...portfolioFixture, totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 } };
  renderApp("/inbox");

  expect(await screen.findByText("当前筛选没有任务")).toBeInTheDocument();
  expect(screen.getByText("0 项")).toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: /演示任务/ })).not.toBeInTheDocument();
});

test("inbox API failure stays an error and never masquerades as an empty queue", async () => {
  inboxFails = true;
  renderApp("/inbox");

  expect(await screen.findByRole("alert")).toHaveTextContent("任务读取失败");
  expect(screen.queryByText("当前筛选没有任务")).not.toBeInTheDocument();
  expect(screen.queryByText(/FRONTEND DEMO/)).not.toBeInTheDocument();
});

test("inbox task rows expose labels for narrow readable cards", async () => {
  inboxData = {
    items: [{
      id: "task-mobile", merchant_id: "only-bear", merchant_name: "Only Bear Chicken & Boba",
      location_id: "mineola", location_name: "Mineola", title: "核验 GBP 发布结果", task_type: "GBP_POST",
      priority: "HIGH", impact: "HIGH", owner_id: "user-1", due_at: "2026-08-27T08:00:00Z",
      status: "PENDING_VERIFY", evidence_state: "VERIFIED", task_revision: 3, state_version: 6,
      updated_at: "2026-08-26T08:00:00Z",
    }],
    offset: 0, limit: 50, total: 1,
  };
  renderApp("/inbox");

  const title = await screen.findByText("核验 GBP 发布结果");
  const row = title.closest("tr");
  expect(row?.querySelector("[data-label='状态']")).toHaveTextContent("待核验");
  expect(row?.querySelector("[data-label='到期']")).toBeInTheDocument();
});

test("inbox normalizes repeated offsets and preserves the active filter", async () => {
  renderAppWithLocation("/inbox?status=APPROVED&offset=50&offset=0");

  await vi.waitFor(() => expect(calls.some(({ path }) => path === "/api/seo-ops/inbox?offset=0&limit=50&status=APPROVED")).toBe(true));
  await vi.waitFor(() => expect(screen.getByTestId("current-location")).toHaveTextContent("/inbox?status=APPROVED&offset=0"));
});

test("inbox recovers after the server total shrinks without flashing a false empty range", async () => {
  let resolveLastPage!: (response: Response) => void;
  const lastPage = new Promise<Response>((resolve) => { resolveLastPage = resolve; });
  inboxResponder = (offset, limit) => {
    if (offset === 100) return json({ items: [], offset, limit, total: 51 });
    if (offset === 50) return lastPage;
    return json({ items: [], offset, limit, total: 51 });
  };
  renderApp("/inbox?status=APPROVED&offset=100");

  await vi.waitFor(() => expect(calls.some(({ path }) => path === "/api/seo-ops/inbox?offset=50&limit=50&status=APPROVED")).toBe(true));
  expect(screen.queryByText("当前筛选没有任务")).not.toBeInTheDocument();
  expect(screen.queryByText(/101–51 \/ 51/)).not.toBeInTheDocument();
  expect(screen.getByText("正在校正分页…")).toHaveAttribute("role", "status");

  await act(async () => {
    resolveLastPage(json({
      items: [{
        id: "task-last", merchant_id: "only-bear", merchant_name: "Only Bear Chicken & Boba",
        location_id: "mineola", location_name: "Mineola", title: "最后一项待核验任务", task_type: "GBP_POST",
        priority: "HIGH", impact: "HIGH", owner_id: "user-1", due_at: "2026-08-27T08:00:00Z",
        status: "PENDING_VERIFY", evidence_state: "VERIFIED", task_revision: 3, state_version: 6,
        updated_at: "2026-08-26T08:00:00Z",
      }],
      offset: 50,
      limit: 50,
      total: 51,
    }));
    await lastPage;
  });
  expect(await screen.findByText("显示 51–51 / 51")).toBeInTheDocument();
  expect(screen.getByText("51 项")).toBeInTheDocument();
});

test("inbox shows only the actionable error when the recovery page request fails", async () => {
  inboxResponder = (offset, limit) => offset === 100
    ? json({ items: [], offset, limit, total: 51 })
    : json({ message: "recovery unavailable" }, 503);
  renderApp("/inbox?status=APPROVED&offset=100");

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("任务读取失败");
  expect(within(alert).getByRole("button", { name: "重试" })).toBeInTheDocument();
  expect(screen.queryByText("正在校正分页…")).not.toBeInTheDocument();
  expect(screen.queryByText("当前筛选没有任务")).not.toBeInTheDocument();
  expect(screen.queryByText("51 项")).not.toBeInTheDocument();
  expect(screen.getByText("— 项")).toBeInTheDocument();
});

test("task page presents one decision before technical state", async () => {
  renderApp("/tasks/task-1");
  expect(await screen.findByRole("heading", { name: "现在需要批准当前版本" })).toBeInTheDocument();
  expect(screen.getByText("菜单页发布证据复核")).toBeInTheDocument();
  expect(screen.getByText("Only Bear Chicken & Boba")).toBeInTheDocument();
  expect(screen.getByText('{"operation":"publish_menu"}')).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "批准当前版本" })).toBeInTheDocument();
  expect(screen.getByText("批准不会立即发布")).toBeInTheDocument();
  expect(screen.getByText("技术详情（审计）").closest("details")).not.toHaveAttribute("open");
  expect(screen.queryByText("sha256:abc123")).not.toBeVisible();
  expect(screen.queryByRole("button", { name: "打开 SEO Ops Copilot" })).not.toBeInTheDocument();
});

test("task page keeps an approval decision view-only without approval permission", async () => {
  authenticatedUser = { ...userFixture, permissions: ["seoops.manage"] };
  renderApp("/tasks/task-1");

  expect(await screen.findByRole("heading", { name: "现在需要批准当前版本" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "批准当前版本" })).not.toBeInTheDocument();
  expect(screen.getByText("当前账号可查看该决定，但没有执行权限。")).toBeInTheDocument();
});

test("operator gate two summarizes passing server checks before confirmation", async () => {
  taskData = { ...taskFixture, execution_mode: "AUTO_WRITE", status: "APPROVED" };
  renderApp("/tasks/task-1");

  expect(await screen.findByRole("heading", { name: "现在需要确认是否发布" })).toBeInTheDocument();
  const passSummaries = await screen.findAllByText("校验通过");
  expect(passSummaries[0]).toBeVisible();
  expect(passSummaries[1]).not.toBeVisible();
  const confirmationActions = screen.getAllByRole("button", { name: "确认现在发布" });
  expect(confirmationActions[0]).toBeVisible();
  expect(confirmationActions[1]).not.toBeVisible();
  expect(screen.queryByText("外部授权有效")).not.toBeInTheDocument();
});

test("approved MANUAL work stays on evidence guidance and never previews or confirms execution", async () => {
  taskData = { ...taskFixture, execution_mode: "MANUAL", status: "APPROVED" };
  renderApp("/tasks/task-1");

  expect(await screen.findByRole("heading", { name: "记录人工完成与证据" })).toBeInTheDocument();
  expect(screen.getByText("保存完成证据后归档；系统不会派发或立即发布。")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "记录人工完成" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "确认现在发布" })).not.toBeInTheDocument();
  expect(calls.some((call) => call.path.includes("execution-preview") || call.path.includes("execution-confirmations"))).toBe(false);
});

test("execute-only mutations are view-only without seoops.execute", async () => {
  authenticatedUser = { ...userFixture, permissions: ["seoops.manage", "seoops.approve"] };
  const cases: Array<{ status: typeof taskFixture.status; expected: string }> = [
    { status: "APPROVED", expected: "确认现在发布" },
    { status: "OUTCOME_UNKNOWN", expected: "开始查证" },
    { status: "PENDING_VERIFY", expected: "核验通过 → 归档" },
    { status: "FAILED", expected: "排障完成，重置回已批准" },
  ];
  for (const item of cases) {
    taskData = { ...taskFixture, execution_mode: "AUTO_WRITE", status: item.status };
    const view = renderApp("/tasks/task-1");
    await screen.findByText("当前账号可查看该决定，但没有执行权限。");
    expect(screen.queryByRole("button", { name: item.expected })).not.toBeInTheDocument();
    view.unmount();
  }
  expect(calls.some((call) => call.path.includes("execution-preview"))).toBe(false);
});

test("task hero shows the latest draft before technical details", async () => {
  draftData = [{ id: "draft-1", task_id: "task-1", version: 1, body: "今日午餐限定，欢迎到店。", cta_type: null, cta_url: null, media: [], source: "HUMAN_EDIT", feedback: null, sha256: "sha256:draft-full", created_by: "user-1", created_at: "2026-08-26T08:00:00Z" }];
  renderApp("/tasks/task-1");

  expect(await screen.findByText("当前稿件 v1")).toBeInTheDocument();
  expect(within(screen.getByLabelText("当前内容")).getByText("今日午餐限定，欢迎到店。")).toBeVisible();
  expect(screen.getByText("技术详情（审计）").closest("details")).not.toHaveAttribute("open");
});

test("task hero previews only the authenticated local GBP image and CTA before approval", async () => {
  draftData = [{
    id: "draft-image", task_id: "task-1", version: 2,
    body: "Order the confirmed lunch selection online.",
    cta_type: "ORDER", cta_url: "https://example.test/order",
    media: ["https://core-ai.example/remote-image.png"],
    media_previews: [{
      deliverable_id: "deliverable-image",
      sha256: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      download_path: "/api/seo-ops/deliverables/deliverable-image/download",
      alt_text: "Confirmed lunch plate",
    }],
    source: "AGENT_GENERATED", feedback: null,
    sha256: "sha256:draft-image", created_by: "system", created_at: "2026-08-27T08:00:00Z",
  } as DraftWire];
  renderApp("/tasks/task-1");

  const image = await screen.findByRole("img", { name: "Confirmed lunch plate" });
  expect(within(screen.getByLabelText("当前内容")).getByRole("status")).toHaveTextContent("图片加载中");
  expect(image).toHaveAttribute("src", "/api/seo-ops/deliverables/deliverable-image/download");
  expect(image).not.toHaveAttribute("src", expect.stringContaining("core-ai.example"));
  expect(screen.getByText("CTA：ORDER · https://example.test/order")).toBeVisible();
  const approval = screen.getByRole("button", { name: "批准当前版本" });
  expect(image.compareDocumentPosition(approval) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
});

test("task hero never turns raw or malformed draft media into an image source", async () => {
  draftData = [{
    id: "draft-unsafe-image", task_id: "task-1", version: 2, body: "Safe copy.",
    cta_type: "NONE", cta_url: null,
    media: ["https://core-ai.example/remote-image.png", "{malformed"],
    media_previews: [], source: "AGENT_GENERATED", feedback: null,
    sha256: "sha256:draft-unsafe-image", created_by: "system", created_at: "2026-08-27T08:00:00Z",
  } as DraftWire];
  renderApp("/tasks/task-1");

  await screen.findByText("Safe copy.");
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(document.querySelector('img[src*="core-ai.example"]')).toBeNull();
});

test("task hero shows an accepted artifact when no current draft exists", async () => {
  artifactData = [{ id: "artifact-full-1", task_id: "task-1", merchant_id: "only-bear", artifact_type: "AUDIT_REPORT", schema_version: "v1", title: "已接受的审计报告", summary: "当前可交付审计摘要", payload: {}, core_run_id: "core-run-full", created_by: "user-1", created_at: "2026-08-26T08:00:00Z" }];
  renderApp("/tasks/task-1");

  expect(await screen.findByText("当前产物")).toBeInTheDocument();
  expect(within(screen.getByLabelText("当前内容")).getByText("已接受的审计报告")).toBeVisible();
  expect(within(screen.getByLabelText("当前内容")).getByText("当前可交付审计摘要")).toBeVisible();
});

test("task hero chooses the newest-first persisted artifact", async () => {
  artifactData = [
    { id: "artifact-new", task_id: "task-1", merchant_id: "only-bear", artifact_type: "AUDIT_REPORT", schema_version: "v1", title: "最新已接受产物", summary: "newest", payload: {}, core_run_id: "core-new", created_by: "user-1", created_at: "2026-08-27T08:00:00Z" },
    { id: "artifact-old", task_id: "task-1", merchant_id: "only-bear", artifact_type: "AUDIT_REPORT", schema_version: "v1", title: "旧产物", summary: "oldest", payload: {}, core_run_id: "core-old", created_by: "user-1", created_at: "2026-08-26T08:00:00Z" },
  ];
  renderApp("/tasks/task-1");

  await screen.findByText("当前产物");
  expect(within(screen.getByLabelText("当前内容")).getByText("最新已接受产物")).toBeVisible();
  expect(within(screen.getByLabelText("当前内容")).queryByText("旧产物")).not.toBeInTheDocument();
});

test("closed technical audit exposes full identifiers, hashes and safe external evidence links", async () => {
  taskData = {
    ...taskFixture,
    published_ref: "https://example.test/receipts/publish-123",
    evidence_refs: [{ id: "evidence-full-1", task_revision: 2, type: "CONTENT_DRAFT", artifact_id: "artifact-evidence-full", sha256: "sha256:abcdef0123456789full", captured_at: "2026-08-26T08:00:00Z", verification_status: "VERIFIED", requirement_key: "CONTENT_DRAFT", created_by: "user-1", created_at: "2026-08-26T08:00:00Z" }, { id: "evidence-full-2", task_revision: 2, type: "SOURCE", source_ref: "https://example.test/source/full", captured_at: "2026-08-26T08:00:00Z", verification_status: "VERIFIED", requirement_key: "SOURCE", created_by: "user-1", created_at: "2026-08-26T08:00:00Z" }],
    agent_run_links: [{ agent_run_id: "agent-run-full-012345", relationship: "EXECUTION", linked_by: "user-1", linked_at: "2026-08-26T08:00:00Z" }],
  };
  auditReferenceData = {
    offset: 0,
    limit: 20,
    total: 1,
    agent_runs: [],
    artifacts: [],
    execution_attempts: [{
      id: "attempt-full-1",
      agent_run_id: "agent-run-attempt-full",
      core_run_id: "core-run-attempt-full",
      probe_ref: "https://example.test/probes/full",
      deliverables: [],
    }],
  };
  renderApp("/tasks/task-1");

  const audit = await screen.findByText("技术详情（审计）");
  await userEvent.setup().click(audit);
  expect(await screen.findByText("agent-run-attempt-full")).toBeVisible();
  expect(screen.getByText("core-run-attempt-full")).toBeVisible();
  expect(screen.getByText("agent-run-full-012345")).toBeVisible();
  expect(screen.getByText("sha256:abcdef0123456789full")).toBeVisible();
  expect(screen.getByRole("link", { name: "打开发布回执" })).toHaveAttribute("href", "https://example.test/receipts/publish-123");
  expect(screen.getByRole("link", { name: "打开证据来源" })).toHaveAttribute("href", "https://example.test/source/full");
});

test("technical audit renders persisted task-run traces and deliverable identifiers without inventing values", async () => {
  auditReferenceData = {
    agent_runs: [{
      id: "task-agent-run-full",
      core_run_id: "task-core-run-full",
      trace_ref: "https://example.test/traces/full",
      business_input_fingerprint: "business-fingerprint-full",
      http_request_fingerprint: "http-request-fingerprint-full",
      retry_of_agent_run_id: "prior-agent-run-full",
      retry_generation: 2,
      retry_reason: "Strict output validation rejected the prior generation.",
      deliverables: [{ id: "deliverable-full", file_id: "core-file-full", sha256: "sha256:deliverable-full", source_ref: "https://example.test/files/full" }],
    }],
    artifacts: [{ id: "specialist-artifact-full", core_run_id: "specialist-core-full" }],
    execution_attempts: [{ id: "execution-attempt-full", core_run_id: "execution-core-run-full", trace_ref: "execution-trace-full", probe_ref: "execution-probe-full", deliverables: [{ id: "execution-deliverable-full", file_id: "execution-file-full", sha256: "sha256:execution-deliverable-full", source_ref: "https://example.test/execution/files/full" }] }],
  };
  renderApp("/tasks/task-1");
  await userEvent.setup().click(await screen.findByText("技术详情（审计）"));
  expect(await screen.findByText("task-core-run-full")).toBeVisible();
  expect(screen.getByText("https://example.test/traces/full")).toBeVisible();
  expect(screen.getByText("core-file-full")).toBeVisible();
  expect(screen.getByText("sha256:deliverable-full")).toBeVisible();
  expect(screen.getByText("specialist-core-full")).toBeVisible();
  expect(screen.getByText("execution-core-run-full")).toBeVisible();
  expect(screen.getByText("execution-trace-full")).toBeVisible();
  expect(screen.getByText("execution-file-full")).toBeVisible();
  expect(screen.getByText("sha256:execution-deliverable-full")).toBeVisible();
  expect(screen.getByText("business-fingerprint-full")).toBeVisible();
  expect(screen.getByText("http-request-fingerprint-full")).toBeVisible();
  expect(screen.getByText("prior-agent-run-full")).toBeVisible();
  expect(screen.getByText("2")).toBeVisible();
  expect(screen.getByText("Strict output validation rejected the prior generation.")).toBeVisible();
});

test("task audit references are fetched only after the closed technical audit opens", async () => {
  renderApp("/tasks/task-1");
  await screen.findByText("技术详情（审计）");
  expect(calls.some(({ path }) => path.includes("/audit-references"))).toBe(false);
  expect(calls.some(({ path }) => path.endsWith("/attempts"))).toBe(false);

  await userEvent.setup().click(screen.getByText("技术详情（审计）"));
  await vi.waitFor(() => expect(calls.some(({ path }) => path.includes("/audit-references?offset=0&limit=20"))).toBe(true));
  expect(calls.some(({ path }) => path.endsWith("/attempts"))).toBe(false);
});

test("technical audit loads overlapping reference pages on demand and merges every collection without duplicates", async () => {
  auditReferencePages.set(0, {
    offset: 0,
    limit: 20,
    total: 21,
    agent_runs: [{ id: "paged-run-1", core_run_id: "paged-core-run-1", deliverables: [] }],
    artifacts: [{ id: "paged-artifact-1", core_run_id: "paged-core-artifact-1" }],
    execution_attempts: [{ id: "paged-attempt-1", core_run_id: "paged-core-attempt-1", probe_ref: "paged-probe-1", deliverables: [] }],
  });
  auditReferencePages.set(20, {
    offset: 20,
    limit: 20,
    total: 21,
    agent_runs: [
      { id: "paged-run-1", core_run_id: "paged-core-run-1", deliverables: [] },
      { id: "paged-run-2", core_run_id: "paged-core-run-2", deliverables: [] },
    ],
    artifacts: [
      { id: "paged-artifact-1", core_run_id: "paged-core-artifact-1" },
      { id: "paged-artifact-2", core_run_id: "paged-core-artifact-2" },
    ],
    execution_attempts: [
      { id: "paged-attempt-1", core_run_id: "paged-core-attempt-1", probe_ref: "paged-probe-1", deliverables: [] },
      { id: "paged-attempt-2", core_run_id: "paged-core-attempt-2", probe_ref: "paged-probe-2", deliverables: [] },
    ],
  });
  renderApp("/tasks/task-1");
  await userEvent.setup().click(await screen.findByText("技术详情（审计）"));

  expect(await screen.findByText("paged-run-1")).toBeVisible();
  expect(screen.getByLabelText("审计引用总数")).toHaveTextContent("21");
  const loadMore = screen.getByRole("button", { name: "加载更多审计引用" });
  await userEvent.setup().click(loadMore);

  expect(await screen.findByText("paged-run-2")).toBeVisible();
  expect(screen.getByText("paged-artifact-2")).toBeVisible();
  expect(screen.getByText("paged-attempt-2")).toBeVisible();
  expect(calls.some(({ path }) => path.includes("/audit-references?offset=20&limit=20"))).toBe(true);
  expect(screen.getAllByText("paged-run-1")).toHaveLength(1);
  expect(screen.getAllByText("paged-artifact-1")).toHaveLength(1);
  expect(screen.getAllByText("paged-attempt-1")).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "加载更多审计引用" })).not.toBeInTheDocument();
});

test("an old load-more response cannot repopulate audit references after navigating to another task", async () => {
  auditReferencePages.set(0, {
    offset: 0,
    limit: 20,
    total: 21,
    agent_runs: [{ id: "task-1-run", core_run_id: "task-1-core-run", deliverables: [] }],
    artifacts: [],
    execution_attempts: [],
  });
  let resolveOldPage!: (response: Response) => void;
  const oldPage = new Promise<Response>((resolve) => { resolveOldPage = resolve; });
  delayedAuditLoadMore = oldPage;
  renderAppWithNavigation("/tasks/task-1");
  const user = userEvent.setup();

  await user.click(await screen.findByText("技术详情（审计）"));
  await user.click(await screen.findByRole("button", { name: "加载更多审计引用" }));
  await vi.waitFor(() => expect(calls.some(({ path }) => path.includes("/tasks/task-1/audit-references?offset=20"))).toBe(true));

  await user.click(screen.getByRole("button", { name: "前往第二个任务" }));
  expect(await screen.findByRole("heading", { name: "第二个任务" })).toBeVisible();
  expect(await screen.findByText("task-2-run")).toBeVisible();

  await act(async () => {
    resolveOldPage(json({
      offset: 20,
      limit: 20,
      total: 21,
      agent_runs: [{ id: "stale-task-1-run", core_run_id: "stale-task-1-core-run", deliverables: [] }],
      artifacts: [],
      execution_attempts: [],
    }));
    await oldPage;
  });
  expect(screen.queryByText("stale-task-1-run")).not.toBeInTheDocument();
  expect(screen.getByText("task-2-run")).toBeVisible();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="current-location">{location.pathname}{location.search}</output>;
}

function renderAppWithLocation(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <LocationProbe />
    <AuthProvider><App /></AuthProvider>
  </MemoryRouter>);
}

function TestTaskNavigator() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/tasks/task-2")} type="button">前往第二个任务</button>;
}

function renderAppWithNavigation(route: string) {
  return render(<MemoryRouter initialEntries={[route]}>
    <TestTaskNavigator />
    <AuthProvider><App /></AuthProvider>
  </MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import type { CycleLedgerView, LifecycleView, PostProgramView, RankingOverviewView } from "./api/types";
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
    if (path === "/api/seo-ops/tasks/task-1") return json(taskFixture);
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
    if (path === "/api/seo-ops/inbox-summary") return json({ pending_proposals: 0, ready_for_approval: 0, awaiting_execution: 0, pending_verify: 0, outcome_unknown: 0, frozen_merchant_ids: [] });
    if (path.startsWith("/api/seo-ops/proposal-batches")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/tasks/task-1/attempts")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/tasks/task-1/drafts")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/inbox")) return json({ items: [], offset: 0, limit: 50, total: 0 });
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

test("empty inbox shows front-end demo work and opens details without requesting a fake task", async () => {
  portfolioData = { ...portfolioFixture, totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 } };
  const user = userEvent.setup();
  renderApp("/inbox");

  expect(await screen.findByText("7 个演示任务")).toBeInTheDocument();
  expect(screen.getAllByText(/\d{2}月\d{2}日发布 GBP Post｜/)).toHaveLength(4);
  expect(screen.getByText("复盘分析｜上周 SEO 动作与指标变化")).toBeInTheDocument();
  expect(screen.getByText("重新 Audit｜GBP + 官网本地页")).toBeInTheDocument();
  expect(screen.getByText("重新生成 Plan｜未来 30 天执行方案")).toBeInTheDocument();

  await user.click(screen.getByText("重新生成 Plan｜未来 30 天执行方案"));

  expect(screen.getByRole("dialog", { name: "演示任务详情" })).toBeInTheDocument();
  expect(screen.getByText("前端演示数据，不会写入后端或触发 Core AI。" )).toBeInTheDocument();
  expect(screen.getByText("等待重新 Audit 与新排名基线完成")).toBeInTheDocument();
  expect(calls.some((call) => call.path.includes("/api/seo-ops/tasks/demo-"))).toBe(false);
});

test("each GBP publishing date is an independent task with its own keyword brief", async () => {
  portfolioData = { ...portfolioFixture, totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 } };
  const user = userEvent.setup();
  renderApp("/inbox");

  await user.click(await screen.findByText(/发布 GBP Post｜午餐选择/));

  expect(screen.getByRole("heading", { name: "本次发布 Brief" })).toBeInTheDocument();
  expect(screen.getByText("来源：每周四 GBP 内容日历")).toBeInTheDocument();
  expect(screen.getByText("fried chicken lunch Mineola")).toBeInTheDocument();
  expect(screen.getByText("fried chicken near me")).toBeInTheDocument();
  expect(screen.getByText("待授权")).toBeInTheDocument();
  expect(screen.getByText("一篇 Post 只使用一个主要搜索意图 / 关键词簇。" )).toBeInTheDocument();
});

test("task deep link exposes revision hash evidence and approval boundary", async () => {
  renderApp("/tasks/task-1");
  expect(await screen.findByRole("heading", { name: "菜单页发布证据复核" })).toBeInTheDocument();
  expect(screen.getByText("rev 2")).toBeInTheDocument();
  expect(screen.getByText("sha256:abc123")).toBeInTheDocument();
  expect(screen.getByText("批准只记录授权，不触发执行")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "打开 SEO Ops Copilot" })).not.toBeInTheDocument();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "./auth/AuthContext";
import type { LifecycleView, RankingOverviewView } from "./api/types";
import { portfolioFixture, stageRunRunningFixture, taskFixture, userFixture } from "./test/fixtures";

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
let portfolioData = portfolioFixture;
const calls: Array<{ path: string; init?: RequestInit }> = [];

beforeEach(() => {
  lifecycleData = lifecycleFixture;
  rankingData = emptyRankingFixture;
  reportsData = { items: [], offset: 0, limit: 50, total: 0 };
  portfolioData = portfolioFixture;
  calls.length = 0;
  vi.spyOn(crypto, "randomUUID").mockReturnValue("22222222-2222-2222-2222-222222222222");
  localStorage.setItem("apiKey", "test-key");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioData);
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: true, copilot_agent_id: "agent-safe", agent_run_enabled: true, agent_run_stages: ["KEYWORDS", "AUDIT", "RANKING_BASELINE", "PLAN", "REVIEW"] });
    if (path === "/api/seo-ops/tasks/task-1") return json(taskFixture);
    if (path === "/api/seo-ops/merchants/only-bear/lifecycle") return json(lifecycleData);
    if (path === "/api/seo-ops/merchants/only-bear/ranking") return json(rankingData);
    if (path === "/api/seo-ops/merchants/only-bear/stage-runs" && init?.method === "POST") return json(stageRunRunningFixture, 202);
    if (path.startsWith("/api/seo-ops/merchants/only-bear/stage-runs")) return json({ items: [], offset: 0, limit: 1, total: 0 });
    if (path.startsWith("/api/seo-ops/agent-runs/")) return json(stageRunRunningFixture);
    if (path.startsWith("/api/seo-ops/tasks/task-1/events")) return json({ items: [], offset: 0, limit: 100, total: 0 });
    if (path.startsWith("/api/seo-ops/inbox")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path.startsWith("/api/seo-ops/reviews")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path.startsWith("/api/seo-ops/reports")) return json(reportsData);
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

test("homepage is an exception list with merchants in a searchable switcher", async () => {
  const user = userEvent.setup();
  renderApp("/");
  expect(await screen.findByRole("heading", { name: "商户" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "周期内无待办" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Only Bear Chicken & Boba" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("combobox", { name: "选择商户工作范围" }));
  expect(screen.getByRole("option", { name: /Only Bear Chicken & Boba/ })).toBeInTheDocument();
});

test("merchant lifecycle page walks the stage rail and surfaces the waiting questionnaire", async () => {
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "生命周期阶段" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "等待商家回复" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /重发问卷/ })).toBeInTheDocument();
  expect(screen.getByText(/q\/ab12cd34/)).toBeInTheDocument();
});

test("merchant workspace presents onboarding health in operator-facing Chinese", async () => {
  portfolioData = {
    ...portfolioFixture,
    merchants: [{ ...portfolioFixture.merchants[0], health: "STABLE", stage: "QUESTIONNAIRE" }],
  };

  renderApp("/merchants/only-bear");

  expect(await screen.findByText("接入中")).toBeInTheDocument();
  expect(screen.queryByText("ONBOARDING")).not.toBeInTheDocument();
});

test("merchant workspace previews four upcoming demo tasks when its real queue is empty", async () => {
  const user = userEvent.setup();
  renderApp("/merchants/only-bear");

  expect(await screen.findByText("FRONTEND DEMO · 最近 4 项")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: /打开任务摘要/ })).toHaveLength(4);
  expect(screen.getByText("fried chicken lunch Mineola")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: /打开任务摘要 .*发布 GBP Post｜午餐选择/ }));

  expect(screen.getByRole("dialog", { name: "演示任务详情" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "本次发布 Brief" })).toBeInTheDocument();
});

test("KEYWORDS stage card triggers a stage run in place, no task created", async () => {
  lifecycleData = keywordsLifecycleFixture;
  const user = userEvent.setup();
  renderApp("/merchants/only-bear");
  await user.click(await screen.findByRole("button", { name: /一键生成关键词/ }));

  const trigger = calls.find(
    (call) => call.path === "/api/seo-ops/merchants/only-bear/stage-runs" && call.init?.method === "POST",
  );
  expect(trigger).toBeDefined();
  expect(JSON.parse(String(trigger?.init?.body))).toEqual({
    stage: "KEYWORDS",
    location_id: "mineola",
    idempotency_key: "stage-KEYWORDS-22222222-2222-2222-2222-222222222222",
  });
  // 就地闭环：留在生命周期页，卡片自身变活（RUNNING + 可取消），不建任务、不跳转
  expect(await screen.findByRole("button", { name: "取消运行" })).toBeInTheDocument();
  expect(screen.getByText("RUNNING")).toBeInTheDocument();
  expect(calls.some((call) => call.path === "/api/seo-ops/tasks" && call.init?.method === "POST")).toBe(false);
  expect(screen.queryByRole("heading", { name: /Only Bear Chicken/ })).toBeInTheDocument();
});

test("first-round merchant shows the onboarding round badge and no ranking comparison", async () => {
  renderApp("/merchants/only-bear");
  expect(await screen.findByRole("heading", { name: "Only Bear Chicken & Boba" })).toBeInTheDocument();
  expect(screen.getByText("⟳ 首轮接入")).toBeInTheDocument();
  expect(screen.queryByText(/LOCAL 包内均值/)).not.toBeInTheDocument();
});

test("steady-state merchant shows round badge, ranking comparison numbers, and the snapshot table", async () => {
  lifecycleData = steadyLifecycleFixture;
  rankingData = rankingFixture;
  renderApp("/merchants/only-bear");
  expect(await screen.findByText("⟳ 第 2 轮 · 8 月")).toBeInTheDocument();
  // 与上期对比（只放数字）：均值 12 → 7、首页词占比、新挖机会词
  expect(await screen.findByText(/LOCAL 包内均值/)).toBeInTheDocument();
  expect(screen.getByText("12 → 7")).toBeInTheDocument();
  expect(screen.getByText(/上升 5 位/)).toBeInTheDocument();
  expect(screen.getByText("1 / 2")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: /排名快照/ })).toBeInTheDocument();
  // 快照表：词 / local / organic / 较上期；新词打标
  const table = screen.getByRole("table");
  expect(table).toHaveTextContent("ramen near me");
  expect(table).toHaveTextContent("ramen delivery");
  expect(screen.getByText("新词")).toBeInTheDocument();
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
  const user = userEvent.setup();
  renderApp("/tasks/task-1");
  expect(await screen.findByRole("heading", { name: "菜单页发布证据复核" })).toBeInTheDocument();
  expect(screen.getByText("rev 2")).toBeInTheDocument();
  expect(screen.getByText("sha256:abc123")).toBeInTheDocument();
  expect(screen.getByText("批准只记录授权，不触发执行")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "打开 SEO Ops Copilot" }));
  expect(screen.getByRole("button", { name: "执行外部写入（MVP 禁用）" })).toBeDisabled();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

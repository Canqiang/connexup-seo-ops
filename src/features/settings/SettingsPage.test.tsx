import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import type { CapabilityWire, CycleConfigWire, MerchantSummary, PortfolioResponse, RunsLedgerView } from "../../api/types";
import { AuthProvider } from "../../auth/AuthContext";
import { portfolioFixture, userFixture } from "../../test/fixtures";

const kekeFoodMerchant: MerchantSummary = {
  id: "keke-food", slug: "keke-food", display_name: "Keke Food Kitchen",
  operator_user_ids: ["user-1"], operators: [{ id: "user-1", name: "Xander" }], owner_ids: ["user-1"],
  locations: [], location_count: 0, task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0,
  health: "STABLE",
};

const calls: Array<{ path: string; init?: RequestInit }> = [];
let runtimeConfig: Record<string, unknown>;
let authenticatedUser: typeof userFixture;
let runtimeControls: Record<string, unknown>;
let ledgerData: RunsLedgerView;
let portfolioData: PortfolioResponse;
let capabilitiesData: { items: Array<CapabilityWire & { merchant_name: string }> };
let cycleConfigsData: { items: CycleConfigWire[] };

beforeEach(() => {
  calls.length = 0;
  portfolioData = { ...portfolioFixture, merchants: [...portfolioFixture.merchants, kekeFoodMerchant] };
  capabilitiesData = {
    items: [
      {
        id: "cap-only-bear-gbp-write", merchant_id: "only-bear", merchant_name: "Only Bear Chicken & Boba",
        asset: "GBP", capability: "GBP_WRITE", external_ref: null, tech_connected: true, merchant_authorized: true,
        status: "ACTIVE", verified_at: "2026-08-20T00:00:00Z", verified_by: "user-1", note: null,
        updated_at: "2026-08-20T00:00:00Z",
      },
      {
        id: "cap-keke-food-gbp-write", merchant_id: "keke-food", merchant_name: "Keke Food Kitchen",
        asset: "GBP", capability: "GBP_WRITE", external_ref: null, tech_connected: true, merchant_authorized: false,
        status: "BLOCKED", verified_at: null, verified_by: null, note: "待商家授权",
        updated_at: "2026-08-20T00:00:00Z",
      },
    ],
  };
  cycleConfigsData = {
    items: [
      {
        merchant_id: "only-bear", snapshot_day: 1, post_weekday: 4, post_per_week: 1,
        review_window_days: 7, audit_interval_days: 30, enabled: true,
        updated_by: "user-1", updated_at: "2026-08-20T00:00:00Z",
      },
    ],
  };
  runtimeConfig = {
    copilot_enabled: false,
    agent_run_enabled: true,
    agent_run_stages: ["KEYWORDS", "AUDIT", "RANKING_BASELINE", "PLAN", "REVIEW"],
  };
  runtimeControls = {
    global: null,
    merchant: null,
    effective_paused: false,
    effective_source: null,
    effective_reason: null,
  };
  ledgerData = {
    summary: { in_flight: 0, queued: 0, completed_today: 0, failed_today: 0, content_runs_today: 0, token_total_today: 0, outcome_unknown: 0, frozen_merchant_ids: [], day_start: "2026-08-27T00:00:00.000Z" },
    items: [], offset: 0, limit: 1, total: 0,
  };
  authenticatedUser = {
    ...userFixture,
    name: "George Operator",
    role: "SEO_OPERATOR",
    permissions: ["seoops.view", "seoops.manage", "seoops.execute"],
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/me") return json(authenticatedUser);
    if (path === "/api/seo-ops/portfolio") return json(portfolioData);
    if (path === "/api/seo-ops/inbox-summary") return json({
      pending_proposals: 3,
      ready_for_approval: 2,
      awaiting_execution: 1,
      pending_verify: 4,
      outcome_unknown: 1,
      verification_overdue: 0,
      frozen_merchant_ids: ["only-bear"],
    });
    if (path === "/api/seo-ops/config") return json(runtimeConfig);
    if (path.startsWith("/api/seo-ops/agent-runs")) return json(ledgerData);
    if (path === "/api/seo-ops/runtime-controls?merchant_id=only-bear" && !init?.method) {
      return json(runtimeControls);
    }
    if (path === "/api/seo-ops/runtime-controls" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      const record = {
        id: "runtime-control-1",
        scope: body.scope,
        merchant_id: body.merchant_id ?? null,
        paused: body.paused,
        reason: body.reason,
        changed_by: "operator-1",
        created_at: "2026-08-27T08:00:00Z",
      };
      runtimeControls = {
        ...runtimeControls,
        ...(body.scope === "GLOBAL" ? { global: record } : { merchant: record }),
        effective_paused: body.paused,
        effective_source: body.paused ? body.scope : null,
        effective_reason: body.paused ? body.reason : null,
      };
      return json(record, 201);
    }
    if (path === "/api/seo-ops/agent-bindings") return json({
      binding_keys: ["AUDIT"],
      items: [{
        task_type: "AUDIT",
        agent_id: "agent-audit-uat",
        agent_label: "Local SEO Audit",
        published_ref: "uat-revision-4",
        updated_by: "user-1",
        updated_at: "2026-08-26T08:00:00Z",
      }],
    });
    if (path === "/api/seo-ops/agent-bindings/AUDIT" && init?.method === "PUT") return json({
      task_type: "AUDIT",
      agent_id: "agent-audit-uat",
      agent_label: "Local SEO Audit",
      published_ref: "uat-revision-4",
      updated_by: "user-1",
      updated_at: "2026-08-26T08:00:00Z",
    });
    if (path === "/api/seo-ops/merchants/only-bear/capabilities") return json({ items: [] });
    if (path === "/api/seo-ops/merchants/only-bear/cycle-config") return json(null);
    if (path === "/api/seo-ops/capabilities") return json(capabilitiesData);
    if (path === "/api/seo-ops/cycle-configs") return json(cycleConfigsData);
    if (path === "/api/seo-ops/merchants/only-bear/capabilities/GBP_WRITE" && init?.method === "PUT") {
      return json({ message: "capability upsert failed" }, 500);
    }
    if (path === "/api/seo-ops/merchants/only-bear/locations/mineola/gbp-execution-binding") return json({
      merchant_id: "only-bear",
      location_id: "mineola",
      account_resource: null,
      location_resource: null,
      timezone: null,
      core_api_user_id: null,
      core_api_user_external_id: null,
      write_secret_ref: null,
      readback_secret_ref: null,
      write_agent_id: null,
      write_agent_published_ref: null,
      readback_agent_id: null,
      readback_agent_published_ref: null,
      status: "MISSING",
      state_version: 0,
      ready_for_gate2: false,
      missing_fields: ["account_resource", "location_resource", "write_agent_published_ref", "readback_agent_published_ref"],
      updated_by: null,
      updated_at: null,
    });
    if (path.startsWith("/api/seo-ops/effect-reviews")) return json({
      summary: { total: 0, by_tier: {}, due_count: 0 },
      items: [],
      windows: [],
    });
    if (path.startsWith("/api/seo-ops/reviews")) return json({
      items: [{
        task_id: "task-review-1",
        merchant_id: "only-bear",
        classification: "CORRELATIONAL",
        goal: "提升午餐搜索可见度",
        baseline: "Local Pack 平均第 12 位",
        action: "更新 GBP Post 与菜单页",
        observed_change: "Local Pack 平均第 9 位",
        competing_explanations: ["季节性需求", "竞品暂时下线"],
        conclusion_strength: "仅支持关联观察",
        follow_up_test: "保持其他页面不变，继续观察两周",
        evidence_ids: ["evidence-1", "evidence-2"],
        updated_at: "2026-08-26T08:00:00Z",
      }],
      offset: 0,
      limit: 50,
      total: 1,
    });
    if (path.startsWith("/api/seo-ops/inbox")) return json({ items: [], offset: 0, limit: 50, total: 0 });
    if (path === "/api/seo-ops/admin/scheduler-tick" && init?.method === "POST") return json({ created: [], dispatched: 0 });
    if (path === "/api/seo-ops/admin/execution-tick" && init?.method === "POST") return json({ status: "ok" });
    return json({ message: `Unhandled test request: ${path}` }, 404);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test("settings separates the five operator governance sections and reads existing APIs", async () => {
  renderApp("/settings");

  for (const name of ["能力矩阵", "周期配置", "GBP 地点执行绑定", "Agent 绑定", "用户与权限", "系统状态"]) {
    expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
  }
  expect(screen.getByDisplayValue("Local SEO Audit")).toBeInTheDocument();
  expect(calls.map(({ path }) => path)).toEqual(expect.arrayContaining([
    "/api/auth/me",
    "/api/seo-ops/config",
    "/api/seo-ops/inbox-summary",
    "/api/seo-ops/agent-bindings",
    "/api/seo-ops/capabilities",
    "/api/seo-ops/cycle-configs",
    "/api/seo-ops/merchants/only-bear/cycle-config",
  ]));
});

test("settings names exact GBP binding gaps and marks generic GBP signals as legacy", async () => {
  renderApp("/settings");

  const binding = await screen.findByRole("region", { name: "GBP 地点执行绑定" });
  expect(await within(binding).findByText("Mineola")).toBeInTheDocument();
  expect((await within(binding).findAllByText("account_resource")).length).toBeGreaterThan(0);
  for (const field of ["location_resource", "write_agent_published_ref", "readback_agent_published_ref"]) {
    expect(binding).toHaveTextContent(field);
  }
  expect(binding).toHaveTextContent("Gate2 已禁用");
  const agents = await screen.findByRole("region", { name: "Agent 绑定" });
  expect(agents).toHaveTextContent("GBP_EXECUTION 是旧通用信号，不能满足 GBP Gate2");
});

test("users and permissions shows the authenticated actor and exact permission codes without account controls", async () => {
  renderApp("/settings");

  const permissions = await screen.findByRole("region", { name: "用户与权限" });
  expect(permissions).toHaveTextContent("George Operator");
  expect(permissions).toHaveTextContent("SEO_OPERATOR");
  expect(within(permissions).getByText("seoops.view")).toBeInTheDocument();
  expect(within(permissions).getByText("seoops.manage")).toBeInTheDocument();
  expect(within(permissions).getByText("seoops.execute")).toBeInTheDocument();
  expect(within(permissions).queryByRole("button", { name: /新增|编辑|删除.*用户/ })).not.toBeInTheDocument();
});

test("system status uses real configuration and queue signals while marking unsupported fields unavailable", async () => {
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  expect(within(system).getByText("Agent Run 接口")).toBeInTheDocument();
  expect(await within(system).findByText("已启用")).toBeInTheDocument();
  expect(within(system).getByText("结果待查")).toBeInTheDocument();
  expect(await within(system).findByText("1")).toBeInTheDocument();
  for (const label of ["Scheduler 心跳", "Worker 心跳", "Core AI 配额"]) {
    const field = within(system).getByLabelText(label);
    expect(field).toHaveTextContent("不可用");
    expect(field).toHaveTextContent("当前 API 未提供证据");
  }
  const runCapacity = within(system).getByText("Run 容量").closest(".system-truth-card");
  if (!runCapacity) throw new Error("Missing Run 容量 card");
  expect(await within(runCapacity as HTMLElement).findByText("0 在途 · 0 排队")).toBeInTheDocument();
  const recentFailures = within(system).getByText("近期失败数").closest(".system-truth-card");
  if (!recentFailures) throw new Error("Missing 近期失败数 card");
  expect(await within(recentFailures as HTMLElement).findByText("0")).toBeInTheDocument();
});

test("system status does not turn an omitted Agent Run signal into a disabled fact", async () => {
  runtimeConfig = { copilot_enabled: false };
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  const agentRun = within(system).getByLabelText("Agent Run 接口");
  expect(await within(agentRun).findByText("不可用")).toBeInTheDocument();
  expect(within(agentRun).getByText("当前 API 未提供证据")).toBeInTheDocument();
  expect(within(agentRun).queryByText("未启用")).not.toBeInTheDocument();
});

test("manual runtime controls and the audit-qualified Runs link live under system status", async () => {
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  expect(within(system).getByRole("button", { name: "调度一轮" })).toBeInTheDocument();
  expect(within(system).getByRole("button", { name: "执行一轮" })).toBeInTheDocument();
  expect(within(system).getByRole("link", { name: "查看完整运行账本" })).toHaveAttribute("href", "/runs?view=audit");
  expect(screen.queryByRole("link", { name: "运行" })).not.toBeInTheDocument();
});

test("manual runtime controls require the exact scheduler management permission", async () => {
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  expect(within(system).getByRole("button", { name: "调度一轮" })).toBeDisabled();
  expect(within(system).getByRole("button", { name: "执行一轮" })).toBeDisabled();
});

test("merchant governance edits use their exact capability and scheduler permission codes", async () => {
  renderApp("/settings");

  expect(await screen.findByLabelText("Only Bear Chicken & Boba GBP 写入（Post / 资料修改） 技术连接")).toBeDisabled();
  expect(screen.getByLabelText("Only Bear Chicken & Boba GBP 写入（Post / 资料修改） 商户授权")).toBeDisabled();
  expect(screen.getByLabelText("AUDIT Agent ID")).toBeDisabled();
  expect(await screen.findByLabelText("启用自动周期")).toBeDisabled();
});

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

test("a failed capability toggle keeps the matrix heading and error visible without unmounting the panel", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: [...authenticatedUser.permissions, "seoops.capability.manage"] };
  const user = userEvent.setup();
  renderApp("/settings");

  const matrix = await screen.findByRole("region", { name: "能力矩阵" });
  const checkbox = within(matrix).getByLabelText("Only Bear Chicken & Boba GBP 写入（Post / 资料修改） 技术连接");
  await user.click(checkbox);

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("GBP_WRITE 保存失败");
  expect(screen.getByRole("heading", { name: "能力矩阵" })).toBeInTheDocument();
});

test("authorized runtime controls preserve the existing scheduler and worker mutations", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: [...authenticatedUser.permissions, "seoops.schedule.manage"] };
  const user = userEvent.setup();
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  await user.click(within(system).getByRole("button", { name: "调度一轮" }));
  await user.click(within(system).getByRole("button", { name: "执行一轮" }));
  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: "/api/seo-ops/admin/scheduler-tick", init: expect.objectContaining({ method: "POST" }) }),
    expect.objectContaining({ path: "/api/seo-ops/admin/execution-tick", init: expect.objectContaining({ method: "POST" }) }),
  ]));
});

test("authorized operators can pause new work only with an audited reason", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: [...authenticatedUser.permissions, "seoops.schedule.manage"] };
  const user = userEvent.setup();
  renderApp("/settings");

  const system = await screen.findByRole("region", { name: "系统状态" });
  const pause = within(system).getByRole("button", { name: "暂停全部新工作" });
  expect(pause).toBeDisabled();
  await user.type(within(system).getByLabelText("暂停或恢复原因"), "UAT incident review");
  expect(pause).toBeEnabled();
  await user.click(pause);

  expect(calls).toEqual(expect.arrayContaining([
    expect.objectContaining({
      path: "/api/seo-ops/runtime-controls",
      init: expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          scope: "GLOBAL",
          merchant_id: null,
          paused: true,
          reason: "UAT incident review",
        }),
      }),
    }),
  ]));
  expect(await within(system).findByText("全局已暂停")).toBeInTheDocument();
  expect(within(system).getByText("UAT incident review")).toBeInTheDocument();
});

test("editing an Agent label preserves the existing published revision provenance", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: [...authenticatedUser.permissions, "seoops.schedule.manage"] };
  const user = userEvent.setup();
  renderApp("/settings");

  const label = await screen.findByLabelText("AUDIT Agent 备注");
  await user.clear(label);
  await user.type(label, "Audit production binding");
  await user.click(screen.getByRole("button", { name: "保存" }));

  const request = calls.find(({ path, init }) => path === "/api/seo-ops/agent-bindings/AUDIT" && init?.method === "PUT");
  expect(request).toBeDefined();
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    agent_id: "agent-audit-uat",
    agent_label: "Audit production binding",
    published_ref: "uat-revision-4",
  });
});

test("changing an Agent ID explicitly clears the old Agent revision provenance", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: [...authenticatedUser.permissions, "seoops.schedule.manage"] };
  const user = userEvent.setup();
  renderApp("/settings");

  const agentId = await screen.findByLabelText("AUDIT Agent ID");
  await user.clear(agentId);
  await user.type(agentId, "agent-audit-v2");
  expect(screen.getByText("更换 Agent 将清除旧发布版本来源；需为新 Agent 重新绑定版本。")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存" }));

  const request = calls.find(({ path, init }) => path === "/api/seo-ops/agent-bindings/AUDIT" && init?.method === "PUT");
  expect(request).toBeDefined();
  expect(JSON.parse(String(request?.init?.body))).toEqual({
    agent_id: "agent-audit-v2",
    agent_label: "Local SEO Audit",
    published_ref: null,
  });
});

test("the full Runs ledger is audit-only while its explicit audit URL remains route-addressable", async () => {
  const operator = renderApp("/runs");
  expect(await screen.findByRole("heading", { name: "设置" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "系统状态" })).toBeInTheDocument();
  operator.unmount();

  renderApp("/runs?view=audit");
  expect(await screen.findByRole("heading", { name: "运行" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "运行" })).toBeInTheDocument();
});

test("review keeps backend association truth and presents the decision sequence in order", async () => {
  renderApp("/reviews");

  const section = await screen.findByRole("region", { name: "任务级证据分级" });
  const card = await within(section).findByRole("article", { name: "提升午餐搜索可见度" });
  expect(within(card).getByText("关联观察，不代表因果")).toBeInTheDocument();
  expect(within(card).getByText("CORRELATIONAL")).toBeInTheDocument();
  expect(within(card).queryByText("CAUSAL_READY")).not.toBeInTheDocument();
  expect(within(card).queryByText(/证明.*导致|已证实.*导致/)).not.toBeInTheDocument();
  expect(within(card).getByRole("link", { name: "查看任务" })).toHaveAttribute("href", "/tasks/task-review-1");
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

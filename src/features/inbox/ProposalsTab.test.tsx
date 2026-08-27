import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProposalBatchWire, ProposalWire } from "../../api/types";
import { portfolioFixture } from "../../test/fixtures";
import { WorkspaceProvider } from "../../workspace/WorkspaceContext";
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

function renderTab() {
  return render(<MemoryRouter><WorkspaceProvider><ProposalsTab merchantId="keke" /></WorkspaceProvider></MemoryRouter>);
}

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/seo-ops/portfolio") return json(portfolioFixture);
    if (path.startsWith("/api/seo-ops/proposal-batches")) return json({ items: [batch] });
    if (path.includes("/decision")) return json({ proposal: { ...batch.proposals[0], status: "ADOPTED", task_id: "task-new" }, task_id: "task-new" });
    if (path.endsWith("/planner-requests")) return json({ task_id: "planner-task", replayed: false }, 201);
    return json({ message: "unhandled" }, 404);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

test("batch header shows planner snapshot and rows show executor and due date", async () => {
  renderTab();
  expect(await screen.findByText(/pl-0825-kk/)).toBeInTheDocument();
  expect(screen.getByText(/服务范围 Local SEO/)).toBeInTheDocument();
  const row = screen.getByRole("row", { name: /GBP 商家授权跟进/ });
  expect(within(row).getByText("Audit Agent")).toBeInTheDocument();
});

test("selecting pending rows and adopting them decides each proposal in order; failed rows cannot be selected", async () => {
  const user = userEvent.setup();
  renderTab();
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
  renderTab();
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
  renderTab();
  await user.click(await screen.findByRole("button", { name: "手动请求 Planner" }));
  await user.type(screen.getByLabelText("请求原因"), "复盘后刷新任务图");
  await user.click(screen.getByRole("button", { name: "发送请求" }));
  const request = calls.find((c) => c.path === "/api/seo-ops/merchants/keke/planner-requests");
  expect(request?.body).toMatchObject({ reason: "复盘后刷新任务图" });
  expect(await screen.findByText(/已生成 Planner 任务/)).toBeInTheDocument();
});

function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }

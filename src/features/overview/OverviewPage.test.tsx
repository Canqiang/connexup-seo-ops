import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import type { ActivityFeedView, InboxSummaryWire, RunsLedgerView, WorkbenchView } from "../../api/types";
import { AuthProvider } from "../../auth/AuthContext";
import { portfolioFixture, userFixture } from "../../test/fixtures";

let summaryData: InboxSummaryWire;
let workbenchData: WorkbenchView;
let activityData: ActivityFeedView;
let ledgerData: RunsLedgerView;

beforeEach(() => {
  summaryData = {
    pending_proposals: 2, ready_for_approval: 12, awaiting_execution: 3,
    pending_verify: 4, outcome_unknown: 1, verification_overdue: 2,
    frozen_merchant_ids: ["only-bear"],
  };
  workbenchData = {
    summary: { gatekeeping: 1, exception: 1, merchant_contact: 0, total: 2 },
    items: [
      {
        id: "outcome:attempt-1", group: "EXCEPTION", type: "OUTCOME_RECONCILIATION",
        merchant_id: "only-bear", merchant_name: "Only Bear", location_name: "Mineola",
        title: "核对执行结果", reason: "结果不确定，需要人工查证后才能继续。",
        primary_action: { label: "去查证", href: "/runs?attempt=attempt-1" }, secondary_href: "/merchants/only-bear",
        priority: "URGENT", due_at: null, waiting_since: "2026-08-27T12:00:00.000Z",
      },
      {
        id: "task:task-approval", group: "GATEKEEPING", type: "GATE_1_APPROVAL",
        merchant_id: "only-bear", merchant_name: "Only Bear", location_name: "Mineola",
        title: "审批任务修订版", reason: "新的执行定义等待你的批准。",
        primary_action: { label: "去审批", href: "/inbox?status=READY_FOR_APPROVAL" }, secondary_href: null,
        priority: "HIGH", due_at: null, waiting_since: "2026-08-27T10:00:00.000Z",
      },
    ],
    offset: 0, limit: 100, total: 2,
  };
  activityData = {
    items: [{
      id: "e1", kind: "TASK_EVENT", occurred_at: "2026-08-27T14:00:00.000Z",
      merchant_id: "only-bear", merchant_name: "Only Bear",
      title: "执行结果不确定 · 该商户执行链已冻结", detail: "GBP Post 发布", href: "/tasks/t1", severity: "DANGER",
    }],
    since: "2026-08-26T14:00:00.000Z",
  };
  ledgerData = {
    summary: { in_flight: 1, queued: 1, completed_today: 11, failed_today: 1, content_runs_today: 3, token_total_today: 41200, outcome_unknown: 0, frozen_merchant_ids: [], day_start: "2026-08-27T00:00:00.000Z" },
    items: [], offset: 0, limit: 1, total: 0,
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioFixture);
    if (path === "/api/seo-ops/inbox-summary") return json(summaryData);
    if (path.startsWith("/api/seo-ops/workbench")) return json(workbenchData);
    if (path.startsWith("/api/seo-ops/activity")) return json(activityData);
    if (path.startsWith("/api/seo-ops/agent-runs")) return json(ledgerData);
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("overview leads with the exception ledger grouped by design category", async () => {
  renderApp("/?view=audit");

  expect(await screen.findByRole("heading", { name: "总览" })).toBeInTheDocument();
  const strip = screen.getByRole("region", { name: "待处理汇总" });
  const ledger = await screen.findByRole("region", { name: "异常清单" });
  await waitFor(() => {
    expect(within(strip).getByText("核验逾期").nextElementSibling).toHaveTextContent("2");
    expect(within(ledger).getByRole("heading", { name: "结果不确定" })).toBeInTheDocument();
  });
  const row = within(ledger).getByRole("article", { name: /Only Bear.*结果不确定/ });
  expect(within(row).getByRole("button", { name: "去查证" })).toBeInTheDocument();
  expect(within(ledger).getByRole("heading", { name: "待审批与确认" })).toBeInTheDocument();
});

test("overview renders today's signals and run capacity from backend projections", async () => {
  renderApp("/?view=audit");

  const signals = await screen.findByRole("region", { name: "今日信号" });
  await waitFor(() => {
    expect(within(signals).getByText(/执行结果不确定/)).toBeInTheDocument();
  });
  expect(within(signals).getByRole("link", { name: /GBP Post 发布/ })).toHaveAttribute("href", "/tasks/t1");
  const capacity = screen.getByRole("region", { name: "Run 容量" });
  expect(within(capacity).getByText("并发 / 配额")).toBeInTheDocument();
  expect(within(capacity).getByText(/未接入/)).toBeInTheDocument();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

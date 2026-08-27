import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import type { AuthenticatedUser, Page, RunsLedgerView, SeoTaskStatus, TaskSummary } from "../../api/types";
import { AuthProvider } from "../../auth/AuthContext";
import { portfolioFixture, taskFixture, userFixture } from "../../test/fixtures";

type InboxResponder = (offset: number, limit: number) => Response | Promise<Response>;

const calls: string[] = [];
const ledgerCalls: string[] = [];
let authenticatedUser: AuthenticatedUser;
let inboxResponders: Partial<Record<SeoTaskStatus, InboxResponder>>;
let ledgerData: RunsLedgerView;

beforeEach(() => {
  calls.length = 0;
  ledgerCalls.length = 0;
  authenticatedUser = { ...userFixture, permissions: ["seoops.view", "seoops.execute"] };
  inboxResponders = {};
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
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/auth/me") return json(authenticatedUser);
    if (path === "/api/seo-ops/portfolio") return json(portfolioFixture);
    if (path === "/api/seo-ops/config") return json({ copilot_enabled: false, core_ai_console_url: "https://core-ai.uat.example" });
    if (path.startsWith("/api/seo-ops/agent-runs")) { ledgerCalls.push(path); return json(ledgerData); }
    if (path === "/api/seo-ops/inbox-summary") return json({
      pending_proposals: 0,
      ready_for_approval: 0,
      awaiting_execution: 0,
      pending_verify: 0,
      outcome_unknown: 0,
      frozen_merchant_ids: [],
    });
    if (path.startsWith("/api/seo-ops/inbox?")) {
      const url = new URL(path, "http://seo-ops.test");
      const status = url.searchParams.get("status") as SeoTaskStatus;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return inboxResponders[status]?.(offset, limit) ?? json(page([], offset, limit, 0));
    }
    return json({ message: `Unhandled test request: ${path}` }, 404);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test("view-only operators can inspect outcome-unknown truth but cannot open the reconciliation mutation", async () => {
  authenticatedUser = { ...authenticatedUser, permissions: ["seoops.view"] };
  inboxResponders.OUTCOME_UNKNOWN = (offset, limit) => json(page([
    task({ id: "unknown-1", title: "GBP 写入结果待查", status: "OUTCOME_UNKNOWN" }),
  ], offset, limit, 1));
  const user = userEvent.setup();
  renderApp();

  const queue = await queueNamed("结果待查");
  expect(within(queue).getByText("当前账号可查看结果待查，但没有查证权限。")).toBeInTheDocument();
  const reconcile = await within(queue).findByRole("button", { name: /查证/ });
  expect(reconcile).toBeDisabled();
  await user.click(reconcile);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

test("Gate 2 can reach an eligible task beyond the first 50 raw APPROVED records", async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => task({
    id: `approved-read-only-${index + 1}`,
    title: `自动读取 ${index + 1}`,
    status: "APPROVED",
    execution_mode: "READ_ONLY",
  }));
  const eligible = task({
    id: "approved-write-51",
    title: "第 51 条 GBP 写入确认",
    status: "APPROVED",
    execution_mode: "AUTO_WRITE",
  });
  inboxResponders.APPROVED = (offset, limit) => json(page(offset === 0 ? firstPage : [eligible], offset, limit, 51));
  const user = userEvent.setup();
  renderApp();

  const queue = await queueNamed("待执行确认（门 2）");
  expect(await within(queue).findByText("已读取 50 / 51 条原始记录")).toBeInTheDocument();
  expect(within(queue).queryByText(eligible.title)).not.toBeInTheDocument();
  await user.click(within(queue).getByRole("button", { name: "加载更多待执行确认" }));

  expect(await within(queue).findByText(eligible.title)).toBeInTheDocument();
  expect(within(queue).getByText("已读取 51 / 51 条原始记录")).toBeInTheDocument();
  expect(calls).toContain("/api/seo-ops/inbox?status=APPROVED&offset=50&limit=50");
});

test("a failed queue readback is explicit and its retry restores backend truth", async () => {
  let attempts = 0;
  const recovered = task({ id: "dispatching-1", title: "Core AI 派发 #1", status: "DISPATCHING" });
  inboxResponders.DISPATCHING = (offset, limit) => {
    attempts += 1;
    return attempts === 1
      ? json({ message: "worker unavailable" }, 503)
      : json(page([recovered], offset, limit, 1));
  };
  const user = userEvent.setup();
  renderApp();

  const queue = await queueNamed("派发在途");
  expect(await within(queue).findByRole("alert")).toHaveTextContent("派发在途读取失败");
  expect(within(queue).queryByText("当前没有在途派发。")).not.toBeInTheDocument();
  await user.click(within(queue).getByRole("button", { name: "重试派发在途" }));

  expect(await within(queue).findByText(recovered.title)).toBeInTheDocument();
  expect(attempts).toBe(2);
});

test("runs page shows the run summary strip, the ledger table, and the Core AI console link", async () => {
  renderApp();
  const strip = await screen.findByRole("region", { name: "运行汇总" });
  await within(strip).findByText("41.2k");
  expect(within(strip).getByText("进行中").nextElementSibling).toHaveTextContent("1");
  expect(within(strip).getByText("今日完成").nextElementSibling).toHaveTextContent("11");
  expect(within(strip).getByText("今日 Token").nextElementSibling).toHaveTextContent("41.2k");
  const ledger = await screen.findByRole("region", { name: "运行记录" });
  const row = within(ledger).getByRole("row", { name: /Only Bear/ });
  expect(within(row).getByText(/AUDIT/)).toBeInTheDocument();
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

async function queueNamed(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  const queue = heading.closest("section");
  if (!queue) throw new Error(`Missing queue section for ${name}`);
  return queue;
}

function renderApp() {
  return render(<MemoryRouter initialEntries={["/runs?view=audit"]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function page(items: TaskSummary[], offset: number, limit: number, total: number): Page<TaskSummary> {
  return { items, offset, limit, total };
}

function task(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    ...taskFixture,
    status: "APPROVED",
    execution_mode: "READ_ONLY",
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

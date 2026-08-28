import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import type { EffectReviewsView, InboxSummaryWire, MerchantSummary, Page, PortfolioResponse, ReviewItem, WorkbenchView } from "../../api/types";
import { AuthProvider } from "../../auth/AuthContext";
import { userFixture } from "../../test/fixtures";

let calls: Array<{ path: string; init?: RequestInit }>;
let portfolioData: PortfolioResponse;
let inboxSummaryData: InboxSummaryWire;
let workbenchData: WorkbenchView;
let effectReviewsData: EffectReviewsView;
let reviewsData: Page<ReviewItem>;

const reviewAMerchant: MerchantSummary = {
  id: "review-a", slug: "review-a", display_name: "Review A", operator_user_ids: ["user-1"],
  operators: [{ id: "user-1", name: "Xander" }], owner_ids: ["user-1"],
  locations: [], location_count: 0, task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0,
  health: "STABLE",
};
const kekeMerchant: MerchantSummary = {
  id: "keke", slug: "keke", display_name: "Keke Food", operator_user_ids: ["user-1"],
  operators: [{ id: "user-1", name: "Xander" }], owner_ids: ["user-1"],
  locations: [], location_count: 0, task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0,
  health: "STABLE",
};

beforeEach(() => {
  calls = [];
  portfolioData = {
    merchants: [reviewAMerchant, kekeMerchant],
    totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 },
  };
  inboxSummaryData = {
    pending_proposals: 0, ready_for_approval: 0, awaiting_execution: 0,
    pending_verify: 0, outcome_unknown: 0, verification_overdue: 0, frozen_merchant_ids: [],
  };
  workbenchData = { summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 100, total: 0 };
  effectReviewsData = {
    summary: { total: 1, by_tier: { ASSOCIATIONAL: 1 }, due_count: 0 },
    items: [{
      artifact_id: "art-review-1", merchant_id: "review-a", merchant_name: "Review A", task_id: "task-review-1", core_run_id: "core-review-1",
      title: "Review A · 第 2 轮", summary: "SoLV 14.4 → 26.2", conclusion_tier: "ASSOCIATIONAL", conclusion: "正向关联 · 建议 KEEP",
      baseline: { solv_mean: 14.4 }, observed_change: { solv_mean: 26.2 },
      action_bundle: [{ action_id: "post-weekly", description: "GBP Post 周更 ×6", executed_at: "2026-07-20T00:00:00Z", evidence_ref: "task:t1" }],
      confounders: ["竞对 1 家同期降权", "无对照组"], limitations: ["2 个目标词不升反降"],
      planning_signals: [{ keep: "post-weekly" }], acceptance_status: "PENDING", created_at: "2026-08-06T09:00:00.000Z",
      causal_identified: false,
    }],
    windows: [{
      merchant_id: "review-a", merchant_name: "Review A", review_window_days: 30,
      last_review_at: "2026-08-06T09:00:00.000Z", next_window_at: "2026-09-05T09:00:00.000Z", status: "UPCOMING",
    }],
  };
  reviewsData = {
    items: [{
      task_id: "task-audit-1", merchant_id: "review-a", classification: "CORRELATIONAL",
      goal: "提升复盘证据密度", baseline: "关键词覆盖 40%", action: "补充证据链接",
      observed_change: "覆盖率提升至 55%", competing_explanations: ["自然波动"],
      conclusion_strength: "仅支持关联观察", follow_up_test: "观察下一轮", evidence_ids: ["evidence-1"],
      updated_at: "2026-08-20T00:00:00.000Z",
    }],
    offset: 0, limit: 50, total: 1,
  };

  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === "/api/auth/me") return json(userFixture);
    if (path === "/api/seo-ops/portfolio") return json(portfolioData);
    if (path === "/api/seo-ops/inbox-summary") return json(inboxSummaryData);
    if (path.startsWith("/api/seo-ops/workbench")) return json(workbenchData);
    if (path.startsWith("/api/seo-ops/effect-reviews")) return json(effectReviewsData);
    if (path.startsWith("/api/seo-ops/reviews")) return json(reviewsData);
    return json({ message: `Unhandled test request: ${path}` }, 404);
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("reviews page leads with merchant-round cards capped at ASSOCIATIONAL and lists Gate D windows", async () => {
  renderApp("/reviews?view=audit");
  expect(await screen.findByRole("heading", { name: "复盘" })).toBeInTheDocument();
  expect(screen.getByText(/不宣称因果/)).toBeInTheDocument();
  const card = await screen.findByRole("article", { name: /Review A · 第 2 轮/ });
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
  expect(await within(section).findByText("关联观察，不代表因果")).toBeInTheDocument();
  expect(within(section).getByText("CORRELATIONAL")).toBeInTheDocument();
});

test("honours a merchant_id carried from the merchant page's review-signal link", async () => {
  renderApp("/reviews?merchant_id=keke&view=audit");
  await screen.findByRole("heading", { name: "复盘" });
  await waitFor(() => {
    expect(calls.some(({ path }) => path.startsWith("/api/seo-ops/effect-reviews") && path.includes("merchant_id=keke"))).toBe(true);
  });
  expect(calls.some(({ path }) => path.startsWith("/api/seo-ops/reviews") && path.includes("merchant_id=keke"))).toBe(true);
  const chip = await screen.findByText("Keke Food");
  expect(chip.closest(".scope-chip")).toBeInTheDocument();
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

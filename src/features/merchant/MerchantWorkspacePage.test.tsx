import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import type { CycleLedgerView, LifecycleView, PostProgramView } from "../../api/types";

const onlyBearLifecycle: LifecycleView = {
  merchant_id: "only-bear", stage: "QUESTIONNAIRE",
  stages: [
    { key: "QUESTIONNAIRE", status: "CURRENT", note: "问卷已发出，等待商家填写" },
    { key: "KEYWORDS", status: "OFF", note: "等待问卷" },
    { key: "AUDIT", status: "OFF", note: "等待关键词" },
    { key: "RANKING_BASELINE", status: "OFF", note: "等待审计" },
    { key: "PLAN", status: "OFF", note: "等待基线" },
    { key: "EXECUTE", status: "OFF", note: "等待任务" },
    { key: "VERIFY", status: "OFF", note: "等待证据" },
  ],
  questionnaire: { id: "q-only-bear", status: "SENT", share_slug: "onlybear", send_count: 1, sent_at: "2026-08-20T08:00:00Z", last_sent_at: "2026-08-20T08:00:00Z", filled_at: null },
  latest_runs: {}, plan_converted: false, open_task_count: 0, approved_task_count: 0, ready_for_approval_count: 0,
  unverified_evidence_count: 0, last_report: null, ranking_round_count: 0,
  exception: { type: "WAITING_MERCHANT", waiting_days: 6, send_count: 1, questionnaire_id: "q-only-bear" },
};

const kekeLifecycle: LifecycleView = {
  ...onlyBearLifecycle,
  merchant_id: "keke",
  stage: "EXECUTE",
  questionnaire: { ...onlyBearLifecycle.questionnaire!, id: "q-keke", share_slug: "keke", status: "FILLED", filled_at: "2026-08-21T08:00:00Z" },
  stages: onlyBearLifecycle.stages.map((stage) => ({ ...stage, status: stage.key === "EXECUTE" ? "CURRENT" : stage.key === "VERIFY" ? "OFF" : "DONE" })),
  exception: { type: "NONE" },
};

const kekeLedger: CycleLedgerView = {
  items: [{
    record_kind: "PROPOSAL", task_id: null, proposal_id: "proposal-keke-audit", title: "执行 GBP + 官网双审计",
    task_type: "AUDIT", priority: "HIGH", owner_id: null, due_at: "2026-08-28T09:00:00Z", created_at: "2026-08-26T09:00:00Z",
    status: "PENDING", execution_mode: "MANUAL", dependency_labels: ["问卷已回收"], validation_failures: [],
  }],
};

let postProgramData: PostProgramView = { voice_profile: null, cluster_signals: [], history: [], proposals: [], evidence_gaps: ["VOICE_PROFILE_MISSING"] };
const failedPaths = new Set<string>();

beforeEach(() => {
  postProgramData = { voice_profile: null, cluster_signals: [], history: [], proposals: [], evidence_gaps: ["VOICE_PROFILE_MISSING"] };
  failedPaths.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    const merchantId = path.includes("/merchants/keke/") ? "keke" : "only-bear";
    if (failedPaths.has(path)) return new Response(JSON.stringify({ message: "projection unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
    if (path === "/api/auth/me") return json({ user_id: "operator-1", name: "Operator", role: "operator", permissions: ["seoops.manage", "seoops.approve"] });
    if (path === "/api/seo-ops/portfolio") return json({
      totals: { tasks: 1, blocked: 0, ready_for_approval: 0, overdue: 0 },
      merchants: [
        { id: "only-bear", slug: "only-bear", display_name: "Only Bear", operator_user_ids: ["operator-1"], operators: [], owner_ids: [], locations: [{ id: "mineola", display_name: "Mineola", readiness_status: "READY" }], location_count: 1, task_count: 0, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0, health: "ATTENTION" },
        { id: "keke", slug: "keke", display_name: "Keke Food", operator_user_ids: ["operator-1"], operators: [], owner_ids: [], locations: [{ id: "flushing", display_name: "Flushing", readiness_status: "READY" }], location_count: 1, task_count: 1, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0, health: "STABLE" },
      ],
    });
    if (path === "/api/seo-ops/inbox-summary") return json({ pending_proposals: 1, ready_for_approval: 0, awaiting_execution: 0, pending_verify: 0, outcome_unknown: 0, frozen_merchant_ids: [] });
    if (path.startsWith("/api/seo-ops/workbench")) return json({ summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 50, total: 0 });
    if (path.endsWith("/lifecycle")) return json(merchantId === "keke" ? kekeLifecycle : onlyBearLifecycle);
    if (path.endsWith("/ranking")) return json({ round_count: 0, latest: null, previous: null, comparison: null });
    if (path.endsWith("/cycle-ledger")) return json(merchantId === "keke" ? kekeLedger : { items: [] });
    if (path.endsWith("/post-program")) return json(postProgramData);
    if (path.includes("/artifacts")) return json({ items: [] });
    if (path.startsWith("/api/seo-ops/inbox")) return json({ items: [], offset: 0, limit: 8, total: 0 });
    if (path.startsWith("/api/seo-ops/reviews") || path.startsWith("/api/seo-ops/reports")) return json({ items: [], offset: 0, limit: 3, total: 0 });
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); });

test("operator merchant page leads with one action and never exposes direct specialist runs", async () => {
  renderApp("/merchants/only-bear?view=operator");

  const action = await screen.findByRole("region", { name: "当前动作" });
  expect(within(action).getByRole("heading", { name: "等待商家回复" })).toBeInTheDocument();
  expect(within(action).getByRole("button", { name: "重发问卷" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /运行关键词 Agent/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /触发 Audit/ })).not.toBeInTheDocument();
});

test("proposal rows are muted and link to judgment without pretending to be tasks", async () => {
  renderApp("/merchants/keke?view=operator");

  const proposal = await screen.findByRole("row", { name: /执行 GBP \+ 官网双审计.*建议待判定/ });
  expect(proposal).toHaveAttribute("data-record-kind", "PROPOSAL");
  expect(within(proposal).getByRole("link", { name: "去判定" })).toHaveAttribute("href", expect.stringContaining("tab=proposals"));
});

test("pending active-cycle proposal takes precedence over lifecycle task language", async () => {
  renderApp("/merchants/keke?view=operator");

  const action = await screen.findByRole("region", { name: "当前动作" });
  expect(within(action).getByRole("heading", { name: "判定本周期建议" })).toBeInTheDocument();
  expect(within(action).getByRole("link", { name: "去判定" })).toHaveAttribute("href", expect.stringContaining("tab=proposals"));
  expect(within(action).queryByText("推进已授权任务")).not.toBeInTheDocument();
});

test("projection failures are explicit and retryable instead of empty evidence", async () => {
  failedPaths.add("/api/seo-ops/merchants/only-bear/cycle-ledger");
  failedPaths.add("/api/seo-ops/merchants/only-bear/post-program");
  failedPaths.add("/api/seo-ops/merchants/only-bear/artifacts");
  failedPaths.add("/api/seo-ops/reports?merchant_id=only-bear&limit=8");
  renderApp("/merchants/only-bear?view=operator");

  expect(await screen.findByRole("alert", { name: "周期账本读取失败" })).toHaveTextContent("projection unavailable");
  expect(screen.getByRole("alert", { name: "报告与数据读取失败" })).toHaveTextContent("projection unavailable");
  expect(screen.getByRole("alert", { name: "Post 计划读取失败" })).toHaveTextContent("projection unavailable");
  expect(screen.getAllByRole("button", { name: "重试" })).toHaveLength(3);
  expect(screen.queryByText("活跃周期暂无持久化任务或建议。")).not.toBeInTheDocument();
});

test("post panel renders allowlisted persisted evidence and blocks hostile links", async () => {
  postProgramData = {
    voice_profile: {
      version: 4,
      summary: [{ key: "tone", label: "语气", value: "亲切直接" }, { key: "banned", label: "禁用表达", value: "保证" }],
      created_at: "2026-08-25T08:00:00Z",
    },
    cluster_signals: [{ artifact_id: "signal-1", task_id: "task-signal", cluster: "午餐套餐", signal: "IMPROVED", observed_at: "2026-08-25T08:00:00Z", evidence_ref: "javascript:alert(1)" }],
    history: [{ task_id: "task-post", title: "已核验 GBP Post", published_ref: "data:text/html,unsafe", published_at: "2026-08-24T08:00:00Z", verified_at: "2026-08-25T08:00:00Z", verified_by: "operator-1" }],
    proposals: [],
    evidence_gaps: ["POST_SIGNAL_TYPE_MISSING", "POST_SIGNAL_COVERAGE_MISSING"],
  } as unknown as PostProgramView;
  renderApp("/merchants/only-bear?view=operator");

  const post = await screen.findByRole("region", { name: "Post 计划" });
  expect(post).toHaveTextContent("语气：亲切直接");
  expect(post).toHaveTextContent("禁用表达：保证");
  expect(post).toHaveTextContent("目标簇：午餐套餐");
  expect(post).toHaveTextContent("证据信号：IMPROVED");
  expect(post).toHaveTextContent("已核验 GBP Post");
  expect(post).toHaveTextContent("POST_SIGNAL_TYPE_MISSING");
  expect(post).toHaveTextContent("POST_SIGNAL_COVERAGE_MISSING");
  expect(within(post).queryByRole("link", { name: "证据来源 ↗" })).not.toBeInTheDocument();
  expect(within(post).queryByRole("link", { name: "打开发布记录 ↗" })).not.toBeInTheDocument();
  expect(post).toHaveTextContent("证据链接不安全");
  expect(post).toHaveTextContent("发布链接不安全");
});

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

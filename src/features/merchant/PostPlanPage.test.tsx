import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import App from "../../App";
import { AuthProvider } from "../../auth/AuthContext";
import type { CycleConfigWire, CycleLedgerView, PostProgramView, StyleProfileWire } from "../../api/types";

const calls: Array<{ path: string; body?: unknown }> = [];

const kekeCycleConfig: CycleConfigWire = {
  merchant_id: "keke", snapshot_day: 5, post_weekday: 4, post_per_week: 1,
  review_window_days: 30, audit_interval_days: 90, enabled: true,
  updated_by: "operator-1", updated_at: "2026-08-20T08:00:00Z",
};

const kekeStyleProfile: StyleProfileWire = {
  id: "style-1", merchant_id: "keke", version: 2,
  voice: {
    tone: "邻里咖啡馆口吻", address: "we / neighbors", banned: ["best", "top-rated"],
    example: "Smashed avocado…", source: "问卷 + 人工校订",
  },
  updated_by: "operator-1", created_at: "2026-08-10T08:00:00Z",
};

const kekeCycleLedger: CycleLedgerView = {
  items: [{
    record_kind: "TASK", task_id: "t9", proposal_id: null,
    title: "Smashed Avocado 新品（周四档）", task_type: "GBP_POST", priority: "MEDIUM", owner_id: "operator-1",
    due_at: "2026-08-27T09:00:00Z", created_at: "2026-08-20T08:00:00Z", status: "APPROVED",
    execution_mode: "AUTO_WRITE", dependency_labels: [], validation_failures: [],
  }],
};

const kekePostProgram: PostProgramView = {
  voice_profile: null,
  cluster_signals: [{
    artifact_id: "a1", task_id: "t9", cluster: "smashed avocado sandwich", signal: "IMPROVED",
    observed_at: "2026-08-25T08:00:00Z", evidence_ref: null,
  }],
  history: [{
    task_id: "t8", title: "Perfect brunch weather", published_ref: "https://maps.google.com/post/1",
    published_at: "2026-08-13T08:00:00Z", verified_at: "2026-08-20T08:00:00Z", verified_by: "operator-1",
  }],
  proposals: [{
    proposal_id: "p9", title: "周末 Bottomless 场次", due_at: "2026-09-03T08:00:00Z",
    priority: "MEDIUM", status: "PENDING", validation_failures: [],
  }],
  evidence_gaps: [],
};

let styleProfileData: StyleProfileWire | null = kekeStyleProfile;

beforeEach(() => {
  calls.length = 0;
  styleProfileData = kekeStyleProfile;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/auth/me") return json({ user_id: "operator-1", name: "Operator", role: "operator", permissions: ["seoops.manage", "seoops.approve"] });
    if (path === "/api/seo-ops/portfolio") return json({
      totals: { tasks: 1, blocked: 0, ready_for_approval: 0, overdue: 0 },
      merchants: [
        { id: "keke", slug: "keke", display_name: "Keke Food", operator_user_ids: ["operator-1"], operators: [], owner_ids: [], locations: [{ id: "flushing", display_name: "Flushing", readiness_status: "READY" }], location_count: 1, task_count: 1, ready_for_approval_count: 0, blocked_count: 0, overdue_count: 0, health: "STABLE" },
      ],
    });
    if (path === "/api/seo-ops/inbox-summary") return json({ pending_proposals: 0, ready_for_approval: 0, awaiting_execution: 0, pending_verify: 0, outcome_unknown: 0, verification_overdue: 0, frozen_merchant_ids: [] });
    if (path.startsWith("/api/seo-ops/workbench")) return json({ summary: { gatekeeping: 0, exception: 0, merchant_contact: 0, total: 0 }, items: [], offset: 0, limit: 50, total: 0 });
    if (path.endsWith("/post-program")) return json(kekePostProgram);
    if (path.endsWith("/cycle-config")) return json(kekeCycleConfig);
    if (path.endsWith("/cycle-ledger")) return json(kekeCycleLedger);
    if (path.endsWith("/style-profile")) {
      if (init?.method === "POST") {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        styleProfileData = { ...kekeStyleProfile, version: 3, voice: body.voice };
        return json(styleProfileData, 201);
      }
      return json(styleProfileData);
    }
    return new Response(null, { status: 404 });
  }));
});

afterEach(() => { vi.unstubAllGlobals(); });

test("post plan page shows cadence, weekly signals, voice profile, this week's slot, candidates, and history", async () => {
  renderApp("/merchants/keke/post-plan?view=operator");
  expect(await screen.findByRole("heading", { name: "Post 内容 · 周计划" })).toBeInTheDocument();
  expect(await screen.findByText(/每周四 ×1/)).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "本周关键词表现" })).findByText("smashed avocado sandwich")).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "风格档案" })).findByText(/uws-voice|v2/)).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "本周档期" })).findByText("Smashed Avocado 新品（周四档）")).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "下周候选" })).findByText("周末 Bottomless 场次")).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "历史发布" })).findByText("Perfect brunch weather")).toBeInTheDocument();
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

function renderApp(route: string) {
  return render(<MemoryRouter initialEntries={[route]}><AuthProvider><App /></AuthProvider></MemoryRouter>);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

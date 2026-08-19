import type { AgentRunView, AuthenticatedUser, PortfolioResponse, SeoTask } from "../api/types";

export const userFixture: AuthenticatedUser = {
  user_id: "user-1", name: "Xander", role: "operator",
  permissions: ["seoops.manage", "seoops.approve", "chat.use"]
};

export const portfolioFixture: PortfolioResponse = {
  totals: { tasks: 7, blocked: 1, ready_for_approval: 2, overdue: 1 },
  merchants: [{
    id: "only-bear", slug: "only-bear", display_name: "Only Bear Chicken & Boba",
    operator_user_ids: ["user-1"], operators: [{ id: "user-1", name: "Xander" }], owner_ids: ["user-1"],
    locations: [{ id: "mineola", display_name: "Mineola", readiness_status: "READY" }],
    location_count: 1, task_count: 7, ready_for_approval_count: 2, blocked_count: 1, overdue_count: 1, health: "BLOCKED"
  }]
};

export const taskFixture: SeoTask = {
  id: "task-1", merchant_id: "only-bear", merchant_name: "Only Bear Chicken & Boba", location_id: "mineola",
  location_name: "Mineola", title: "菜单页发布证据复核", task_type: "WEBSITE_SEO", source: "AUDIT",
  priority: "URGENT", impact: "HIGH", owner_id: "user-1", status: "READY_FOR_APPROVAL", evidence_state: "VERIFIED",
  task_revision: 2, state_version: 5, updated_at: "2026-08-17T08:00:00Z", created_at: "2026-08-16T08:00:00Z",
  execution_spec: "{\"operation\":\"publish_menu\"}", execution_spec_hash: "sha256:abc123",
  required_evidence_types: ["BEFORE_SCREENSHOT", "AFTER_SCREENSHOT"],
  evidence_refs: [], approval_decisions: [], conversation_links: [], agent_run_links: []
};

export const agentRunRunningFixture: AgentRunView = {
  id: "run-1", task_id: "task-1", run_type: "AUDIT", goal: "关注 SoLV 排名", status: "RUNNING",
  core_run_id: "core-1", core_status: "RUNNING", input_message: "你是本地 SEO 统一代理…",
  output_preview: null, token_usage: { input_tokens: 120, output_tokens: 35 },
  triggered_by: "local-dev", triggered_at: "2026-08-18T08:00:00Z",
  created_at: "2026-08-18T08:00:00Z", updated_at: "2026-08-18T08:00:05Z",
};

export const agentRunCompletedFixture: AgentRunView = {
  ...agentRunRunningFixture,
  id: "run-2", run_type: "PLAN", goal: null, status: "COMPLETED", core_status: "COMPLETED",
  output_preview: "# 优化方案\n\n结论先行：优先补齐经营类别。",
  artifact_path: "data/artifacts/run-2.md", artifact_sha256: `sha256:${"a".repeat(64)}`,
  evidence_id: "ev-9", token_usage: { input_tokens: 900, output_tokens: 400 },
  completed_at: "2026-08-18T08:03:00Z", updated_at: "2026-08-18T08:03:00Z",
};

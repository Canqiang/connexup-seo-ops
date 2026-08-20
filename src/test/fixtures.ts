import type { AuthenticatedUser, PortfolioResponse, SeoTask, StageRunView } from "../api/types";

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

export const stageRunRunningFixture: StageRunView = {
  id: "run-1", merchant_id: "only-bear", location_id: "mineola",
  stage: "KEYWORDS", run_type: "KEYWORD_RESEARCH", goal: null, status: "RUNNING",
  core_run_id: "core-1", core_status: "RUNNING", input_message: "为该商户生成关键词库…",
  output_preview: null, token_usage: {},
  deliverables: [],
  triggered_by: "local-dev", triggered_at: "2026-08-18T08:00:00Z",
  created_at: "2026-08-18T08:00:00Z", updated_at: "2026-08-18T08:00:05Z",
};

export const stageRunCompletedFixture: StageRunView = {
  ...stageRunRunningFixture,
  id: "run-2", stage: "PLAN", run_type: "PLAN", status: "COMPLETED", core_status: "COMPLETED",
  output: "# 优化方案\n\n## 建议清单\n1. **补齐 GBP 经营类别（P0）**：主类别缺失导致 local pack 不入围。",
  output_preview: "# 优化方案\n\n## 建议清单\n1. **补齐 GBP 经营类别（P0）**：主类别缺失导致 local pack 不入围。",
  token_usage: { input_tokens: 900, output_tokens: 400 },
  deliverables: [
    { id: "run-2-summary", kind: "SUMMARY", file_name: "run-2-summary.md", content_type: "text/markdown",
      size: 2200, title: "优化方案摘要", description: null, sha256: `sha256:${"a".repeat(64)}`,
      downloaded: true, download_path: "/api/seo-ops/deliverables/run-2-summary/download",
      created_at: "2026-08-18T08:03:00Z" },
    { id: "run-2-att-f-1", kind: "ATTACHMENT", file_name: "plan.md", content_type: "text/markdown",
      size: 4096, title: "优化方案", description: null, sha256: `sha256:${"b".repeat(64)}`,
      downloaded: true, download_path: "/api/seo-ops/deliverables/run-2-att-f-1/download",
      created_at: "2026-08-18T08:03:00Z" },
  ],
  completed_at: "2026-08-18T08:03:00Z", updated_at: "2026-08-18T08:03:00Z",
};

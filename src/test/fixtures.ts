import type { AuthenticatedUser, PortfolioResponse, SeoTask } from "../api/types";

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

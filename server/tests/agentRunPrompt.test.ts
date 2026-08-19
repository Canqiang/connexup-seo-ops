import { describe, expect, it } from "vitest";
import { buildAgentRunMessage } from "../src/services/agentRunPrompt.js";
import type { AgentRunType } from "../src/domain/enums.js";
import type { Location, Merchant } from "../src/repos/types.js";
import type { Task } from "../src/repos/taskTypes.js";

const merchant: Merchant = {
  id: "m-1",
  slug: "only-bear",
  displayName: "Only Bear",
  tags: [],
  operatorUserIds: [],
  creationIdempotencyKey: null,
  requestFingerprint: null,
  createdBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const location: Location = {
  id: "l-1",
  merchantId: "m-1",
  slug: "mineola",
  displayName: "Mineola",
  timezone: "America/New_York",
  externalIdentities: { google_business: "gid-123" },
  readinessStatus: "READY",
  missingRequirements: [],
  creationIdempotencyKey: null,
  requestFingerprint: null,
  createdBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const task: Task = {
  id: "t-1",
  merchantId: "m-1",
  locationId: "l-1",
  taskType: "GBP_PROFILE",
  source: "SEO_AUDIT",
  priority: "HIGH",
  impact: "MEDIUM",
  ownerId: "op-1",
  dueAt: "2026-09-01T00:00:00.000Z",
  status: "NEEDS_INPUT",
  evidenceState: "NONE",
  taskRevision: 1,
  stateVersion: 1,
  title: "补齐 GBP 经营类别",
  executionSpec: '{"action":"update_categories","primary":"Korean fried chicken"}',
  executionSpecHash: "sha256:abc",
  requiredEvidenceTypes: ["AUDIT_REPORT"],
  revisions: [],
  evidenceRefs: [
    {
      id: "e-1",
      taskRevision: 1,
      type: "BASELINE_MEASUREMENT",
      sourceRef: "gsc://baseline",
      capturedAt: "2026-08-10T00:00:00.000Z",
      verificationStatus: "VERIFIED",
      requirementKey: "BASELINE_MEASUREMENT",
      createdBy: "local-dev",
      createdAt: "2026-08-10T00:00:00.000Z",
    },
  ],
  approvalDecisions: [],
  events: [],
  conversationLinks: [],
  agentRunLinks: [],
  mutationKeys: {},
  creationIdempotencyKey: "tk-1",
  requestFingerprint: "fp",
  createdBy: "local-dev",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

function message(runType: AgentRunType, goal?: string | null) {
  return buildAgentRunMessage({ runType, task, merchant, location, goal });
}

describe("buildAgentRunMessage", () => {
  it("includes the read-only red line and output rules", () => {
    const m = message("AUDIT");
    expect(m).toMatch(/只读分析任务/);
    expect(m).toMatch(/不得执行任何写入或变更操作/);
    expect(m).toMatch(/使用中文/);
    expect(m).toMatch(/不要编造数据/);
  });

  it("includes merchant, location, task fields and execution_spec verbatim", () => {
    const m = message("AUDIT");
    expect(m).toContain("Only Bear");
    expect(m).toContain("only-bear");
    expect(m).toContain("Mineola");
    expect(m).toContain('{"google_business":"gid-123"}');
    expect(m).toContain("补齐 GBP 经营类别");
    expect(m).toContain("GBP_PROFILE");
    expect(m).toContain("HIGH");
    expect(m).toContain("NEEDS_INPUT");
    expect(m).toContain(task.executionSpec);
    expect(m).toContain("AUDIT_REPORT");
    expect(m).toContain("BASELINE_MEASUREMENT:VERIFIED");
  });

  it("renders a distinct directive per run type", () => {
    const audit = message("AUDIT");
    const plan = message("PLAN");
    const review = message("REVIEW");
    expect(audit).not.toBe(plan);
    expect(audit).toMatch(/现状审计/);
    expect(plan).toMatch(/方案规划/);
    expect(review).toMatch(/效果复盘/);
  });

  it("appends the operator goal only when provided", () => {
    expect(message("AUDIT")).not.toMatch(/操作员补充目标/);
    expect(message("AUDIT", null)).not.toMatch(/操作员补充目标/);
    expect(message("AUDIT", "  关注 SoLV 排名  ")).toMatch(
      /操作员补充目标：关注 SoLV 排名/,
    );
  });

  it("degrades gracefully without merchant/location", () => {
    const m = buildAgentRunMessage({
      runType: "REPORT",
      task,
      merchant: null,
      location: null,
      goal: null,
    });
    expect(m).toContain("（未提供）");
    expect(m).toContain("（任务未绑定地点）");
  });
});

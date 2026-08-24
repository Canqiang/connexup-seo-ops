import { describe, expect, it } from "vitest";
import {
  buildStageRunMessage,
  excerptForPrompt,
  priorStagesFor,
  PRIOR_EXCERPT_LIMIT,
} from "../src/services/agentRunPrompt.js";
import type { AgentRunStage } from "../src/domain/enums.js";
import type { Location, Merchant } from "../src/repos/types.js";
import type { Questionnaire } from "../src/repos/questionnaireTypes.js";

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

const filledQuestionnaire: Questionnaire = {
  id: "q-1",
  merchantId: "m-1",
  shareSlug: "ab12cd34",
  status: "FILLED",
  baseInfo: { name: "Only Bear" },
  questions: [
    { id: "q1", question: "主营业务是什么？", required: true },
    { id: "q2", question: "服务覆盖范围？", required: true },
    { id: "q3", question: "其他补充", required: false },
  ],
  answers: { q1: "韩式炸鸡与奶茶", q2: "Mineola 周边 5 英里", q3: "  " },
  sendCount: 1,
  sentAt: "2026-08-18T08:00:00.000Z",
  lastSentAt: "2026-08-18T08:00:00.000Z",
  lastSentBy: "op-1",
  filledAt: "2026-08-18T09:00:00.000Z",
  creationIdempotencyKey: null,
  requestFingerprint: null,
  createdBy: null,
  createdAt: "2026-08-18T08:00:00.000Z",
  updatedAt: "2026-08-18T09:00:00.000Z",
};

function message(stage: AgentRunStage, overrides: Partial<Parameters<typeof buildStageRunMessage>[0]> = {}) {
  return buildStageRunMessage({
    stage,
    merchant,
    location,
    questionnaire: null,
    ...overrides,
  });
}

describe("buildStageRunMessage", () => {
  it("always opens with the read-only red line and closes with the output contract", () => {
    const m = message("KEYWORDS");
    expect(m.startsWith("你是本地 SEO 分析助手。这是一次只读分析任务")).toBe(true);
    expect(m).toMatch(/不得执行任何写入或变更操作/);
    expect(m).toMatch(/必须产出附件/);
    expect(m).toMatch(/不要编造数据/);
  });

  it("is a focused request: merchant + location facts, no task context dump", () => {
    const m = message("KEYWORDS");
    expect(m).toContain("Only Bear");
    expect(m).toContain("Mineola");
    expect(m).toContain("google_business=gid-123");
    expect(m).not.toMatch(/execution_spec|task_type|state_version/);
    expect(m.length).toBeLessThan(4000);
  });

  it("renders a distinct directive and deliverable contract per stage", () => {
    expect(message("KEYWORDS")).toMatch(/关键词库 CSV/);
    expect(message("AUDIT")).toMatch(/双审计/);
    expect(message("RANKING_BASELINE")).toMatch(/排名基线 CSV/);
    expect(message("PLAN")).toMatch(/\[P0\|P1\|P2\]/);
    expect(message("REVIEW")).toMatch(/复盘/);
  });

  it("embeds the FILLED questionnaire as Q&A, skipping blank answers", () => {
    const m = message("KEYWORDS", { questionnaire: filledQuestionnaire });
    expect(m).toContain("商家问卷回收");
    expect(m).toContain("问：主营业务是什么？");
    expect(m).toContain("答：韩式炸鸡与奶茶");
    expect(m).not.toContain("其他补充"); // whitespace-only answer dropped
    const sent = message("KEYWORDS", {
      questionnaire: { ...filledQuestionnaire, status: "SENT", answers: null },
    });
    expect(sent).not.toContain("商家问卷回收");
  });

  it("inlines prior-stage excerpts and marks missing ones as unknown", () => {
    const withExcerpt = message("RANKING_BASELINE", {
      priorExcerpts: { KEYWORDS: "keyword,intent\n炸鸡外卖,transactional" },
    });
    expect(withExcerpt).toContain("上游交付物——关键词库");
    expect(withExcerpt).toContain("炸鸡外卖,transactional");

    const missing = message("PLAN");
    expect(missing).toContain("上游交付物——审计问题清单：（未提供，按 unknown 处理");
    expect(missing).toContain("上游交付物——排名基线：（未提供，按 unknown 处理");
  });

  it("appends the operator goal only when provided", () => {
    expect(message("AUDIT")).not.toMatch(/操作员补充目标/);
    expect(message("AUDIT", { goal: "  关注 SoLV 排名  " })).toMatch(/操作员补充目标：关注 SoLV 排名/);
  });

  it("tolerates a merchant without locations", () => {
    const m = message("KEYWORDS", { location: null });
    expect(m).toContain("Only Bear");
    expect(m).not.toContain("地点：");
  });
});

describe("excerptForPrompt", () => {
  it("keeps short text verbatim and truncates long text on a line boundary", () => {
    expect(excerptForPrompt("短文本")).toBe("短文本");
    const long = Array.from({ length: 400 }, (_, i) => `keyword-${i},local`).join("\n");
    const cut = excerptForPrompt(long);
    expect(cut.length).toBeLessThan(PRIOR_EXCERPT_LIMIT + 100);
    expect(cut).toMatch(/已截断，原文共 \d+ 字符/);
    // 截断落在整行边界：截断标注前的最后一行是完整行
    const lines = cut.split("\n");
    expect(lines[lines.length - 2]).toMatch(/^keyword-\d+,local$/);
  });
});

describe("priorStagesFor", () => {
  it("encodes the stage chain", () => {
    expect(priorStagesFor("KEYWORDS")).toEqual([]);
    expect(priorStagesFor("RANKING_BASELINE")).toEqual(["KEYWORDS"]);
    expect(priorStagesFor("PLAN")).toEqual(["AUDIT", "RANKING_BASELINE"]);
    expect(priorStagesFor("REVIEW")).toEqual(["PLAN", "RANKING_BASELINE"]);
  });
});

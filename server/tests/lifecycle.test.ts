import { describe, expect, it } from "vitest";
import {
  deriveLifecycle,
  type LifecycleInputs,
  type TasksByMerchant,
} from "../src/services/lifecycleService.js";
import { RUN_TYPE_BY_STAGE, type AgentRunStage } from "../src/domain/enums.js";
import type { Questionnaire } from "../src/repos/questionnaireTypes.js";
import type { AgentRun, RunDeliverable } from "../src/repos/agentRunTypes.js";
import type { Task } from "../src/repos/taskTypes.js";

const M = "m-1";
const NOW = new Date("2026-08-19T12:00:00.000Z");
const DAYS = 24 * 60 * 60 * 1000;

function mkQuestionnaire(
  overrides: Partial<Questionnaire> = {},
): Questionnaire {
  return {
    id: "q-1",
    merchantId: M,
    shareSlug: "ab12cd34",
    status: "SENT",
    baseInfo: { name: "Only Bear" },
    questions: [],
    answers: null,
    sendCount: 1,
    sentAt: new Date(NOW.getTime() - 3 * DAYS).toISOString(),
    lastSentAt: new Date(NOW.getTime() - 3 * DAYS).toISOString(),
    filledAt: null,
    creationIdempotencyKey: null,
    requestFingerprint: null,
    createdBy: null,
    createdAt: new Date(NOW.getTime() - 3 * DAYS).toISOString(),
    updatedAt: new Date(NOW.getTime() - 3 * DAYS).toISOString(),
    ...overrides,
  };
}

function mkRun(
  stage: AgentRunStage,
  overrides: Partial<AgentRun> = {},
): AgentRun {
  const at = new Date(NOW.getTime() - 2 * DAYS).toISOString();
  return {
    id: `run-${stage}`,
    merchantId: M,
    locationId: null,
    stage,
    taskId: null,
    runType: RUN_TYPE_BY_STAGE[stage],
    goal: null,
    status: "COMPLETED",
    coreRunId: "core-1",
    coreStatus: "COMPLETED",
    inputMessage: "sop",
    output: "# 报告\n内容",
    error: null,
    errorCode: null,
    tokenUsage: {},
    triggeredBy: "local-dev",
    triggeredAt: at,
    lastPolledAt: null,
    completedAt: at,
    creationIdempotencyKey: null,
    requestFingerprint: null,
    createdBy: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** 默认给每个运行配一个已落盘的 ATTACHMENT（交付物才算数）。 */
function mkDeliverable(
  runId: string,
  overrides: Partial<RunDeliverable> = {},
): RunDeliverable {
  return {
    id: `${runId}-att-f1`,
    runId,
    kind: "ATTACHMENT",
    fileId: "f-1",
    fileName: "out.csv",
    contentType: "text/csv",
    size: 128,
    title: null,
    description: null,
    sha256: "sha256:abc",
    localPath: `data/artifacts/${runId}-0-out.csv`,
    remoteUrl: "https://core.example/files/f-1",
    downloadedAt: new Date(NOW.getTime() - 2 * DAYS).toISOString(),
    downloadError: null,
    createdAt: new Date(NOW.getTime() - 2 * DAYS).toISOString(),
    ...overrides,
  };
}

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    merchantId: M,
    locationId: null,
    taskType: "GBP_PROFILE",
    source: "SEO_AUDIT",
    priority: "HIGH",
    impact: "MEDIUM",
    ownerId: null,
    dueAt: null,
    status: "NEEDS_INPUT",
    evidenceState: "NONE",
    taskRevision: 1,
    stateVersion: 1,
    title: "补齐 GBP 经营类别",
    executionSpec: "{}",
    executionSpecHash: "sha256:x",
    requiredEvidenceTypes: [],
    revisions: [],
    evidenceRefs: [],
    approvalDecisions: [],
    events: [],
    conversationLinks: [],
    agentRunLinks: [],
    mutationKeys: {},
    creationIdempotencyKey: null,
    requestFingerprint: null,
    createdBy: null,
    createdAt: new Date(NOW.getTime() - DAYS).toISOString(),
    updatedAt: new Date(NOW.getTime() - DAYS).toISOString(),
    ...overrides,
  };
}

function inputs(
  questionnaire: Questionnaire | null,
  runs: AgentRun[],
  opts: { withoutDeliverables?: string[] } = {},
): LifecycleInputs {
  const skip = new Set(opts.withoutDeliverables ?? []);
  const deliverablesByRun = new Map<string, RunDeliverable[]>();
  for (const run of runs) {
    if (!skip.has(run.id)) deliverablesByRun.set(run.id, [mkDeliverable(run.id)]);
  }
  return {
    questionnaireByMerchant: questionnaire ? new Map([[M, questionnaire]]) : new Map(),
    runsByMerchant: new Map([[M, runs]]),
    deliverablesByRun,
  };
}

function tasks(...list: Task[]): TasksByMerchant {
  return new Map([[M, list]]);
}

function stageOf(wire: ReturnType<typeof deriveLifecycle>) {
  return wire.stages.find((s) => s.status === "CURRENT")?.key ?? "none";
}

describe("lifecycle derivation", () => {
  it("no questionnaire -> QUESTIONNAIRE current, no exception", () => {
    const wire = deriveLifecycle(M, inputs(null, []), tasks(), NOW);
    expect(wire.stage).toBe("QUESTIONNAIRE");
    expect(wire.exception.type).toBe("NONE");
    expect(wire.stages.find((s) => s.key === "QUESTIONNAIRE")?.note).toBe("未生成");
  });

  it("questionnaire SENT -> WAITING_MERCHANT with waiting days, stuck on rail", () => {
    const wire = deriveLifecycle(M, inputs(mkQuestionnaire(), []), tasks(), NOW);
    expect(wire.exception).toMatchObject({ type: "WAITING_MERCHANT", waiting_days: 3, send_count: 1 });
    expect(wire.stage).toBe("QUESTIONNAIRE");
    expect(wire.stages.find((s) => s.key === "QUESTIONNAIRE")?.note).toBe("等待商家回复 · 第 4 天");
  });

  it("filled questionnaire advances to KEYWORDS", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const wire = deriveLifecycle(M, inputs(q, []), tasks(), NOW);
    expect(wire.stage).toBe("KEYWORDS");
    expect(wire.exception.type).toBe("NONE");
  });

  it("stage runs with deliverables walk the rail: keywords -> audit -> ranking -> plan pending", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const keywords = mkRun("KEYWORDS");
    expect(stageOf(deriveLifecycle(M, inputs(q, [keywords]), tasks(), NOW))).toBe("AUDIT");

    const audit = mkRun("AUDIT");
    expect(stageOf(deriveLifecycle(M, inputs(q, [keywords, audit]), tasks(), NOW))).toBe("RANKING_BASELINE");

    const ranking = mkRun("RANKING_BASELINE");
    expect(stageOf(deriveLifecycle(M, inputs(q, [keywords, audit, ranking]), tasks(), NOW))).toBe("PLAN");

    const plan = mkRun("PLAN");
    const wire = deriveLifecycle(M, inputs(q, [keywords, audit, ranking, plan]), tasks(), NOW);
    expect(stageOf(wire)).toBe("PLAN");
    expect(wire.exception.type).toBe("PLAN_PENDING");
    expect(wire.latest_runs.PLAN?.run_id).toBe("run-PLAN");
    expect(wire.latest_runs.KEYWORDS?.deliverable_count).toBe(1);
  });

  it("a COMPLETED run without a usable deliverable does NOT complete the stage", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const keywords = mkRun("KEYWORDS");
    const wire = deriveLifecycle(
      M,
      inputs(q, [keywords], { withoutDeliverables: [keywords.id] }),
      tasks(),
      NOW,
    );
    expect(stageOf(wire)).toBe("KEYWORDS");
    expect(wire.stages.find((s) => s.key === "KEYWORDS")?.note).toContain("未产出附件");
  });

  it("plan converted (task with source PLAN) -> EXECUTE; READY_FOR_APPROVAL wins exception", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const runs = [mkRun("KEYWORDS"), mkRun("AUDIT"), mkRun("RANKING_BASELINE"), mkRun("PLAN")];
    const planTask = mkTask({ id: "task-plan", source: "PLAN" });
    const wire = deriveLifecycle(M, inputs(q, runs), tasks(planTask), NOW);
    expect(stageOf(wire)).toBe("EXECUTE");
    expect(wire.exception.type).toBe("NONE");

    const ready = mkTask({ id: "task-plan-2", source: "PLAN", status: "READY_FOR_APPROVAL" });
    const wire2 = deriveLifecycle(M, inputs(q, runs), tasks(planTask, ready), NOW);
    expect(wire2.exception).toMatchObject({ type: "APPROVAL", count: 1 });
  });

  it("unverified current-revision evidence -> VERIFY current + exception", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const runs = [mkRun("KEYWORDS"), mkRun("AUDIT"), mkRun("RANKING_BASELINE"), mkRun("PLAN")];
    const approved = mkTask({
      id: "task-plan",
      source: "PLAN",
      status: "APPROVED",
      taskRevision: 2,
      evidenceRefs: [{
        id: "ev-1",
        taskRevision: 2,
        type: "AFTER_SCREENSHOT",
        capturedAt: NOW.toISOString(),
        verificationStatus: "UNVERIFIED",
        requirementKey: "AFTER_SCREENSHOT",
        createdBy: "op",
        createdAt: NOW.toISOString(),
      }],
    });
    const wire = deriveLifecycle(M, inputs(q, runs), tasks(approved), NOW);
    // stage 取最早的 CURRENT（执行在前）；待核验由异常组表达
    expect(stageOf(wire)).toBe("EXECUTE");
    expect(wire.stages.find((s) => s.key === "VERIFY")?.status).toBe("CURRENT");
    expect(wire.exception).toMatchObject({ type: "VERIFY", count: 1 });
    // 旧 revision 的未核验证据不算数
    const stale = mkTask({
      ...approved,
      evidenceRefs: [{ ...approved.evidenceRefs[0]!, taskRevision: 1 }],
    });
    expect(deriveLifecycle(M, inputs(q, runs), tasks(stale), NOW).exception.type).not.toBe("VERIFY");
  });

  it("ranking baseline older than 7 days pulls the rail back and raises RANKING_DUE", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const staleAt = new Date(NOW.getTime() - 10 * DAYS).toISOString();
    const runs = [
      mkRun("KEYWORDS"),
      mkRun("AUDIT"),
      mkRun("RANKING_BASELINE", { completedAt: staleAt, createdAt: staleAt, updatedAt: staleAt }),
      mkRun("PLAN"),
    ];
    const planTask = mkTask({ id: "task-plan", source: "PLAN", status: "APPROVED" });
    const wire = deriveLifecycle(M, inputs(q, runs), tasks(planTask), NOW);
    expect(stageOf(wire)).toBe("RANKING_BASELINE");
    expect(wire.stages.find((s) => s.key === "RANKING_BASELINE")?.note).toContain("复查到期");
    expect(wire.exception).toMatchObject({ type: "RANKING_DUE", age_days: 10 });
    expect(wire.last_report?.age_days).toBe(10);

    // 7 天内的基线不算到期（稳态）
    const fresh = deriveLifecycle(
      M,
      inputs(q, [mkRun("KEYWORDS"), mkRun("AUDIT"), mkRun("RANKING_BASELINE"), mkRun("PLAN")]),
      tasks(planTask),
      NOW,
    );
    expect(fresh.exception.type).toBe("NONE");
  });

  it("ranking_round_count counts completed ranking runs with usable deliverables", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    expect(deriveLifecycle(M, inputs(q, []), tasks(), NOW).ranking_round_count).toBe(0);

    const first = mkRun("RANKING_BASELINE", { id: "run-rank-1" });
    const wire1 = deriveLifecycle(
      M,
      inputs(q, [mkRun("KEYWORDS"), mkRun("AUDIT"), first]),
      tasks(),
      NOW,
    );
    expect(wire1.ranking_round_count).toBe(1);

    // 复查一次 -> 第 2 轮；没有附件的运行不算轮次
    const recheck = mkRun("RANKING_BASELINE", { id: "run-rank-2" });
    const failed = mkRun("RANKING_BASELINE", { id: "run-rank-3" });
    const wire2 = deriveLifecycle(
      M,
      inputs(q, [mkRun("KEYWORDS"), mkRun("AUDIT"), first, recheck, failed], {
        withoutDeliverables: ["run-rank-3"],
      }),
      tasks(),
      NOW,
    );
    expect(wire2.ranking_round_count).toBe(2);
  });

  it("rerunning a stage is naturally supported: a fresh SENT questionnaire pulls the rail back", () => {
    const q = mkQuestionnaire({ status: "FILLED", filledAt: NOW.toISOString() });
    const runs = [mkRun("KEYWORDS"), mkRun("AUDIT"), mkRun("RANKING_BASELINE"), mkRun("PLAN")];
    const planTask = mkTask({ source: "PLAN" });
    const steady = deriveLifecycle(M, inputs(q, runs), tasks(planTask), NOW);
    expect(stageOf(steady)).toBe("EXECUTE");

    const resend = mkQuestionnaire({
      id: "q-2",
      status: "SENT",
      sentAt: NOW.toISOString(),
      sendCount: 1,
    });
    const regressed = deriveLifecycle(M, inputs(resend, runs), tasks(planTask), NOW);
    expect(stageOf(regressed)).toBe("QUESTIONNAIRE");
    expect(regressed.exception.type).toBe("WAITING_MERCHANT");
  });
});

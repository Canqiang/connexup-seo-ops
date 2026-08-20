import type { Db } from "../db/connection.js";
import type { Questionnaire } from "../repos/questionnaireTypes.js";
import type { AgentRun, RunDeliverable } from "../repos/agentRunTypes.js";
import type { Task } from "../repos/taskTypes.js";
import {
  listAgentRunsByMerchant,
  listDeliverablesByRunIds,
} from "../repos/agentRunRepo.js";
import { listTasksByMerchant } from "../repos/taskRepo.js";
import { latestQuestionnaireByMerchant } from "../repos/questionnaireRepo.js";
import type {
  AgentRunStage,
  LifecycleStage,
  MerchantExceptionType,
} from "../domain/enums.js";

export const RANKING_RECHECK_INTERVAL_DAYS = 7;

/** 每商户的问卷、全量 stage runs 及其交付物（一次预加载喂整组商户推导）。 */
export interface LifecycleInputs {
  questionnaireByMerchant: Map<string, Questionnaire>;
  runsByMerchant: Map<string, AgentRun[]>;
  deliverablesByRun: Map<string, RunDeliverable[]>;
}

/** 每商户任务（调用方预加载，避免逐商户 N+1；单商户场景可只装一条）。 */
export type TasksByMerchant = Map<string, Task[]>;

export function loadLifecycleInputs(
  db: Db,
  merchantIds: string[],
): LifecycleInputs {
  const questionnaireByMerchant = new Map<string, Questionnaire>();
  const runsByMerchant = new Map<string, AgentRun[]>();
  const allRunIds: string[] = [];
  for (const id of merchantIds) {
    const q = latestQuestionnaireByMerchant(db, id);
    if (q) questionnaireByMerchant.set(id, q);
    const runs = listAgentRunsByMerchant(db, id);
    runsByMerchant.set(id, runs);
    for (const run of runs) allRunIds.push(run.id);
  }
  return {
    questionnaireByMerchant,
    runsByMerchant,
    deliverablesByRun: listDeliverablesByRunIds(db, allRunIds),
  };
}

export function preloadTasksByMerchant(
  db: Db,
  merchantIds: string[],
): TasksByMerchant {
  const map: TasksByMerchant = new Map();
  for (const id of merchantIds) map.set(id, listTasksByMerchant(db, id));
  return map;
}

export type StageStatus = "DONE" | "CURRENT" | "OFF";

export interface StageWire {
  key: LifecycleStage;
  status: StageStatus;
  /** 状态说明（日期/计数），前端渲染在轨节点下方。 */
  note: string;
}

/** 各阶段最近一次「算数」的运行（COMPLETED 且有落盘附件）。附件详情走
 * /agent-runs/:id 或 stage-runs 列表——这里只带够阶段卡渲染的摘要。 */
export interface LatestRunWire {
  run_id: string;
  stage: AgentRunStage;
  run_type: string;
  completed_at: string;
  output_preview: string | null;
  deliverable_count: number;
}

export interface ExceptionWire {
  type: MerchantExceptionType | "NONE";
  /** 等待商家回复天数（WAITING_MERCHANT）。 */
  waiting_days?: number;
  /** 发放次数（WAITING_MERCHANT）。 */
  send_count?: number;
  /** 待重发问卷 id（WAITING_MERCHANT）。 */
  questionnaire_id?: string;
  /** 待审批任务数 / 待核验证据条数（APPROVAL / VERIFY）。 */
  count?: number;
  /** 上次排名基线距今天数（RANKING_DUE）。 */
  age_days?: number;
  since?: string;
}

export interface LifecycleWire {
  merchant_id: string;
  /** 第一个 CURRENT 阶段；全轨走完时为最后一个 DONE 阶段（稳态）。 */
  stage: LifecycleStage;
  stages: StageWire[];
  questionnaire: {
    id: string;
    status: Questionnaire["status"];
    share_slug: string;
    send_count: number;
    sent_at: string | null;
    last_sent_at: string | null;
    filled_at: string | null;
  } | null;
  latest_runs: Partial<Record<AgentRunStage, LatestRunWire>>;
  plan_converted: boolean;
  open_task_count: number;
  approved_task_count: number;
  ready_for_approval_count: number;
  unverified_evidence_count: number;
  /** 最新排名基线的年龄（复查节奏依据）。 */
  last_report: { captured_at: string; age_days: number } | null;
  /** 轮次 = 有附件的 COMPLETED 排名运行次数（首轮基线 + 每次复查各算一轮）。 */
  ranking_round_count: number;
  exception: ExceptionWire;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromIso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(fromIso)) / DAY_MS);
}

function dateLabel(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export interface DerivedFacts {
  q: Questionnaire | null;
  keywordsDone: AgentRun | null;
  auditDone: AgentRun | null;
  rankingDone: AgentRun | null;
  planDone: AgentRun | null;
  /** 某阶段有 COMPLETED 运行但没有任何落盘附件——卡片提示重跑/手工上传。 */
  missingDeliverableStage: AgentRunStage | null;
  planConverted: boolean;
  open: number;
  approved: number;
  ready: number;
  unverified: number;
  /** 最新排名基线完成时间与年龄。 */
  ranking: { completedAt: string; ageDays: number } | null;
  /** 有附件的 COMPLETED 排名运行次数（轮次徽标）。 */
  rankingRoundCount: number;
}

function currentRevisionEvidence(task: Task): Task["evidenceRefs"] {
  return task.evidenceRefs.filter((e) => e.taskRevision === task.taskRevision);
}

/** 交付物才算数：COMPLETED 且至少一个已落盘的非正文交付物（ATTACHMENT/MANUAL）。
 * 只回正文不回附件 ⇒ 阶段不算 DONE（兜底是重跑或手工上传）。 */
function hasUsableDeliverable(
  inputs: LifecycleInputs,
  run: AgentRun,
): boolean {
  return (inputs.deliverablesByRun.get(run.id) ?? []).some(
    (d) => d.kind !== "SUMMARY" && d.localPath !== null,
  );
}

function deriveFacts(
  merchantId: string,
  inputs: LifecycleInputs,
  tasks: Task[],
  now: Date,
): DerivedFacts {
  const q = inputs.questionnaireByMerchant.get(merchantId) ?? null;
  const runs = inputs.runsByMerchant.get(merchantId) ?? [];

  // runs 按 created_at DESC 排序，find 即最近一次。
  const doneOf = (stage: AgentRunStage): AgentRun | null =>
    runs.find(
      (r) =>
        r.stage === stage &&
        r.status === "COMPLETED" &&
        hasUsableDeliverable(inputs, r),
    ) ?? null;
  const completedWithoutDeliverable = (stage: AgentRunStage): boolean =>
    runs.some(
      (r) =>
        r.stage === stage &&
        r.status === "COMPLETED" &&
        !hasUsableDeliverable(inputs, r),
    );

  const keywordsDone = doneOf("KEYWORDS");
  const auditDone = doneOf("AUDIT");
  const rankingDone = doneOf("RANKING_BASELINE");
  const planDone = doneOf("PLAN");

  let missingDeliverableStage: AgentRunStage | null = null;
  for (const stage of ["KEYWORDS", "AUDIT", "RANKING_BASELINE", "PLAN"] as const) {
    if (!doneOf(stage) && completedWithoutDeliverable(stage)) {
      missingDeliverableStage = stage;
      break;
    }
  }

  const open = tasks.filter(
    (t) => t.status !== "APPROVED" && t.status !== "APPROVAL_REVOKED",
  ).length;
  const approved = tasks.filter((t) => t.status === "APPROVED").length;
  const ready = tasks.filter((t) => t.status === "READY_FOR_APPROVAL").length;
  let unverified = 0;
  for (const task of tasks) {
    for (const evidence of currentRevisionEvidence(task)) {
      if (evidence.verificationStatus === "UNVERIFIED") unverified += 1;
    }
  }

  const rankingAt = rankingDone
    ? (rankingDone.completedAt ?? rankingDone.createdAt)
    : null;

  return {
    q,
    keywordsDone,
    auditDone,
    rankingDone,
    planDone,
    missingDeliverableStage,
    planConverted: tasks.some((t) => t.source === "PLAN"),
    open,
    approved,
    ready,
    unverified,
    ranking: rankingAt
      ? { completedAt: rankingAt, ageDays: daysBetween(rankingAt, now) }
      : null,
    rankingRoundCount: runs.filter(
      (r) =>
        r.stage === "RANKING_BASELINE" &&
        r.status === "COMPLETED" &&
        hasUsableDeliverable(inputs, r),
    ).length,
  };
}

/** 首页异常分组：按优先级先命中先分组，与展示顺序一致（等待商家 > Plan 待确认
 * > 待审批 > 待核验 > ranking 到期 > 无待办）。 */
export function deriveException(facts: DerivedFacts, now: Date): ExceptionWire {
  if (facts.q?.status === "SENT") {
    return {
      type: "WAITING_MERCHANT",
      waiting_days: daysBetween(facts.q.sentAt ?? facts.q.createdAt, now),
      send_count: facts.q.sendCount,
      questionnaire_id: facts.q.id,
      since: facts.q.sentAt ?? undefined,
    };
  }
  if (facts.planDone && !facts.planConverted) {
    return {
      type: "PLAN_PENDING",
      since: facts.planDone.completedAt ?? facts.planDone.createdAt,
    };
  }
  if (facts.ready > 0) return { type: "APPROVAL", count: facts.ready };
  if (facts.unverified > 0) return { type: "VERIFY", count: facts.unverified };
  if (facts.ranking && facts.ranking.ageDays > RANKING_RECHECK_INTERVAL_DAYS) {
    return {
      type: "RANKING_DUE",
      age_days: facts.ranking.ageDays,
      since: facts.ranking.completedAt,
    };
  }
  return { type: "NONE" };
}

export function deriveLifecycle(
  merchantId: string,
  inputs: LifecycleInputs,
  tasksByMerchant: TasksByMerchant,
  now: Date = new Date(),
): LifecycleWire {
  const tasks = tasksByMerchant.get(merchantId) ?? [];
  const facts = deriveFacts(merchantId, inputs, tasks, now);
  const qFilled = facts.q?.status === "FILLED";

  const stages: StageWire[] = [];
  const push = (key: LifecycleStage, status: StageStatus, note: string): void => {
    stages.push({ key, status, note });
  };
  const missingNote = (stage: AgentRunStage, fallback: string): string =>
    facts.missingDeliverableStage === stage ? "运行完成但未产出附件 · 重跑或手工上传" : fallback;

  // 1) 问卷 —— 等待商家回复是首页最重要的状态（第二用户面）
  if (!facts.q) push("QUESTIONNAIRE", "CURRENT", "未生成");
  else if (facts.q.status === "DRAFT") push("QUESTIONNAIRE", "CURRENT", "已生成未发放");
  else if (facts.q.status === "SENT") {
    const days = daysBetween(facts.q.sentAt ?? facts.q.createdAt, now);
    push("QUESTIONNAIRE", "CURRENT", `等待商家回复 · 第 ${days + 1} 天`);
  } else push("QUESTIONNAIRE", "DONE", `${dateLabel(facts.q.filledAt)} 商家已填`);

  // 2) 关键词（DONE = 有附件交付物的 COMPLETED 运行）
  if (!qFilled) push("KEYWORDS", "OFF", "—");
  else if (facts.keywordsDone)
    push("KEYWORDS", "DONE", dateLabel(facts.keywordsDone.completedAt ?? facts.keywordsDone.createdAt));
  else push("KEYWORDS", "CURRENT", missingNote("KEYWORDS", "待生成关键词库"));

  // 3) 双审计（GBP + on-page）
  if (!facts.keywordsDone) push("AUDIT", "OFF", "—");
  else if (facts.auditDone)
    push("AUDIT", "DONE", `${dateLabel(facts.auditDone.completedAt ?? facts.auditDone.createdAt)} GBP+站内`);
  else push("AUDIT", "CURRENT", missingNote("AUDIT", "待运行双审计"));

  // 4) 排名基线：超复查周期自动回退为 CURRENT（老店稳态复查回到这一格）
  if (!facts.auditDone) push("RANKING_BASELINE", "OFF", "—");
  else if (facts.rankingDone && facts.ranking) {
    if (facts.ranking.ageDays > RANKING_RECHECK_INTERVAL_DAYS) {
      push("RANKING_BASELINE", "CURRENT", `复查到期 · 上次基线 ${facts.ranking.ageDays} 天前`);
    } else {
      push("RANKING_BASELINE", "DONE", `${dateLabel(facts.ranking.completedAt)} local+organic`);
    }
  } else push("RANKING_BASELINE", "CURRENT", missingNote("RANKING_BASELINE", "待建立排名基线"));

  // 5) Plan：生成 → 确认转任务（全系统唯一产生 task 的入口）
  if (!facts.rankingDone) push("PLAN", "OFF", "—");
  else if (!facts.planDone) push("PLAN", "CURRENT", missingNote("PLAN", "待生成优化 Plan"));
  else if (!facts.planConverted) push("PLAN", "CURRENT", "Plan 待确认转任务");
  else push("PLAN", "DONE", "已转执行任务");

  // 6) 执行（EXECUTE 自动化关闭：审批授权后人工按工单执行）
  if (!facts.planConverted) push("EXECUTE", "OFF", "审批后 · 人工");
  else if (facts.open > 0 || facts.approved > 0)
    push("EXECUTE", "CURRENT", `任务 ${facts.open + facts.approved} 个 · 人工执行`);
  else push("EXECUTE", "DONE", "本轮任务已执行");

  // 7) 核验
  if (facts.unverified > 0) push("VERIFY", "CURRENT", `${facts.unverified} 项证据待核验`);
  else if (facts.planConverted && facts.approved > 0) push("VERIFY", "DONE", "已核验");
  else push("VERIFY", "OFF", "—");

  const firstCurrent = stages.find((s) => s.status === "CURRENT");
  const lastDone = [...stages].reverse().find((s) => s.status === "DONE");
  const stage: LifecycleStage = firstCurrent?.key ?? lastDone?.key ?? "QUESTIONNAIRE";

  const latest = (run: AgentRun | null): LatestRunWire | undefined =>
    run
      ? {
          run_id: run.id,
          stage: run.stage,
          run_type: run.runType,
          completed_at: run.completedAt ?? run.createdAt,
          output_preview: run.output ? run.output.slice(0, 2000) : null,
          deliverable_count: (inputs.deliverablesByRun.get(run.id) ?? []).length,
        }
      : undefined;

  return {
    merchant_id: merchantId,
    stage,
    stages,
    questionnaire: facts.q
      ? {
          id: facts.q.id,
          status: facts.q.status,
          share_slug: facts.q.shareSlug,
          send_count: facts.q.sendCount,
          sent_at: facts.q.sentAt,
          last_sent_at: facts.q.lastSentAt,
          filled_at: facts.q.filledAt,
        }
      : null,
    latest_runs: {
      KEYWORDS: latest(facts.keywordsDone),
      AUDIT: latest(facts.auditDone),
      RANKING_BASELINE: latest(facts.rankingDone),
      PLAN: latest(facts.planDone),
    },
    plan_converted: facts.planConverted,
    open_task_count: facts.open,
    approved_task_count: facts.approved,
    ready_for_approval_count: facts.ready,
    unverified_evidence_count: facts.unverified,
    last_report: facts.ranking
      ? { captured_at: facts.ranking.completedAt, age_days: facts.ranking.ageDays }
      : null,
    ranking_round_count: facts.rankingRoundCount,
    exception: deriveException(facts, now),
  };
}

/** 首页/组合页用的轻量入口。 */
export function deriveLifecycleForDb(
  db: Db,
  merchantId: string,
  now: Date = new Date(),
): LifecycleWire {
  const inputs = loadLifecycleInputs(db, [merchantId]);
  const tasks = preloadTasksByMerchant(db, [merchantId]);
  return deriveLifecycle(merchantId, inputs, tasks, now);
}

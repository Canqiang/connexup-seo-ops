import type { Db } from "../db/connection.js";
import { listOpenUnknownAttempts } from "../repos/executionRepo.js";
import { listMerchants, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { listWorkbenchProposals } from "../repos/proposalRepo.js";
import { listWorkbenchSentQuestionnaires } from "../repos/questionnaireRepo.js";
import { listWorkbenchTasks, type WorkbenchTaskRow } from "../repos/taskRepo.js";

export type HumanActionGroup = "GATEKEEPING" | "EXCEPTION" | "MERCHANT_CONTACT";

export type HumanActionType =
  | "PROPOSAL_DECISION"
  | "GATE_1_APPROVAL"
  | "GATE_2_CONFIRM"
  | "OUTCOME_RECONCILIATION"
  | "VERIFICATION_OVERDUE"
  | "CONFIRMED_FAILURE"
  | "QUESTIONNAIRE_FOLLOWUP"
  | "AUTHORIZATION_FOLLOWUP"
  | "CONTENT_CONFIRMATION"
  | "REPORT_DELIVERY";

export interface HumanAction {
  id: string;
  group: HumanActionGroup;
  type: HumanActionType;
  merchantId: string;
  merchantName: string;
  locationName: string | null;
  title: string;
  reason: string;
  primaryAction: { label: string; href: string };
  secondaryHref: string | null;
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  dueAt: string | null;
  waitingSince: string;
}

export interface WorkbenchQuery {
  group?: HumanActionGroup;
  merchantId?: string;
  q?: string;
  offset: number;
  limit: number;
}

export interface WorkbenchView {
  summary: {
    gatekeeping: number;
    exception: number;
    merchant_contact: number;
    total: number;
  };
  items: Array<{
    id: string;
    group: HumanActionGroup;
    type: HumanActionType;
    merchant_id: string;
    merchant_name: string;
    location_name: string | null;
    title: string;
    reason: string;
    primary_action: { label: string; href: string };
    secondary_href: string | null;
    priority: HumanAction["priority"];
    due_at: string | null;
    waiting_since: string;
  }>;
  offset: number;
  limit: number;
  total: number;
}

const priorityRank: Record<HumanAction["priority"], number> = {
  URGENT: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
};

const groupRank: Record<HumanActionGroup, number> = {
  EXCEPTION: 0,
  GATEKEEPING: 1,
  MERCHANT_CONTACT: 2,
};

function taskAction(task: WorkbenchTaskRow, now: Date): HumanAction | null {
  const base = {
    merchantId: task.merchantId,
    merchantName: task.merchantName,
    locationName: task.locationName,
    title: task.title,
    priority: task.severity,
    dueAt: task.dueAt,
    waitingSince: task.createdAt,
  } as const;

  if (task.status === "READY_FOR_APPROVAL") {
    return {
      id: `task:${task.id}:gate-1`,
      group: "GATEKEEPING",
      type: "GATE_1_APPROVAL",
      ...base,
      reason: "当前版本已具备审批条件；批准的是当前版本，不会立即执行。",
      primaryAction: { label: "审批当前版本", href: `/tasks/${task.id}` },
      secondaryHref: null,
    };
  }
  if (task.status === "APPROVED" && task.executionMode !== "READ_ONLY") {
    return {
      id: `task:${task.id}:gate-2`,
      group: "GATEKEEPING",
      type: "GATE_2_CONFIRM",
      ...base,
      reason: "门 1 已批准；确认后才会创建一次执行尝试。",
      primaryAction: { label: "确认现在发布", href: `/tasks/${task.id}` },
      secondaryHref: null,
    };
  }
  if (task.status === "PENDING_VERIFY" && task.verifyDueAt && Date.parse(task.verifyDueAt) < now.getTime()) {
    return {
      id: `task:${task.id}:verification`,
      group: "EXCEPTION",
      type: "VERIFICATION_OVERDUE",
      ...base,
      reason: "发布已超过核验期限，需完成独立回读或记录人工观察。",
      primaryAction: { label: "完成核验", href: `/tasks/${task.id}` },
      secondaryHref: null,
    };
  }
  if (task.status === "FAILED") {
    return {
      id: `task:${task.id}:failure`,
      group: "EXCEPTION",
      type: "CONFIRMED_FAILURE",
      ...base,
      reason: "执行已确认失败，需要排查后决定是否重新排队。",
      primaryAction: { label: "处理失败", href: `/tasks/${task.id}` },
      secondaryHref: null,
    };
  }
  return null;
}

function matches(action: HumanAction, query: WorkbenchQuery): boolean {
  if (query.group && action.group !== query.group) return false;
  if (query.merchantId && action.merchantId !== query.merchantId) return false;
  if (!query.q) return true;
  const needle = query.q.toLocaleLowerCase();
  return [action.merchantName, action.locationName, action.title, action.reason]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

function compareActions(left: HumanAction, right: HumanAction): number {
  return groupRank[left.group] - groupRank[right.group]
    || priorityRank[left.priority] - priorityRank[right.priority]
    || (left.dueAt ?? left.waitingSince).localeCompare(right.dueAt ?? right.waitingSince)
    || left.id.localeCompare(right.id);
}

function wire(action: HumanAction): WorkbenchView["items"][number] {
  return {
    id: action.id,
    group: action.group,
    type: action.type,
    merchant_id: action.merchantId,
    merchant_name: action.merchantName,
    location_name: action.locationName,
    title: action.title,
    reason: action.reason,
    primary_action: action.primaryAction,
    secondary_href: action.secondaryHref,
    priority: action.priority,
    due_at: action.dueAt,
    waiting_since: action.waitingSince,
  };
}

/** Compose only persisted SEO Ops decision points.  In particular, an
 * external Core AI Run is never converted into a completed Task here. */
export async function workbench(
  db: Db,
  actorUserId: string,
  query: WorkbenchQuery,
  scopeAll = false,
  now: Date = new Date(),
): Promise<WorkbenchView> {
  const merchants = scopeAll ? await listMerchants(db) : await listMerchantsForOperator(db, actorUserId);
  const merchantIds = merchants.map((merchant) => merchant.id);
  const [tasks, proposals, questionnaires, unknownAttempts] = await Promise.all([
    listWorkbenchTasks(db, merchantIds),
    listWorkbenchProposals(db, merchantIds),
    listWorkbenchSentQuestionnaires(db, merchantIds),
    listOpenUnknownAttempts(db),
  ]);
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const allowedMerchants = new Set(merchantIds);
  const actions: HumanAction[] = [];

  for (const proposal of proposals) {
    actions.push({
      id: `proposal:${proposal.id}`,
      group: "GATEKEEPING",
      type: "PROPOSAL_DECISION",
      merchantId: proposal.merchantId,
      merchantName: proposal.merchantName,
      locationName: proposal.locationName,
      title: proposal.title,
      reason: proposal.status === "VALIDATION_FAILED"
        ? "建议未通过校验，需要退回或修正后再判定；它尚未成为任务。"
        : "Planner 建议等待你判定；只有采纳后才会创建任务。",
      primaryAction: {
        label: "去判定",
        href: `/inbox?tab=proposals&merchant_id=${encodeURIComponent(proposal.merchantId)}`,
      },
      secondaryHref: null,
      priority: proposal.severity,
      dueAt: proposal.dueAt,
      waitingSince: proposal.createdAt,
    });
  }

  for (const task of tasks) {
    const action = taskAction(task, now);
    if (action) actions.push(action);
  }

  for (const attempt of unknownAttempts) {
    if (!allowedMerchants.has(attempt.merchantId)) continue;
    const task = tasksById.get(attempt.taskId);
    if (!task) continue;
    actions.push({
      id: `attempt:${attempt.id}`,
      group: "EXCEPTION",
      type: "OUTCOME_RECONCILIATION",
      merchantId: task.merchantId,
      merchantName: task.merchantName,
      locationName: task.locationName,
      title: task.title,
      reason: "结果不确定，需人工查证发生与否；系统不会自动重试。",
      primaryAction: { label: "去查证", href: `/tasks/${task.id}` },
      secondaryHref: null,
      priority: task.severity,
      dueAt: task.dueAt,
      waitingSince: attempt.startedAt,
    });
  }

  for (const questionnaire of questionnaires) {
    actions.push({
      id: `questionnaire:${questionnaire.id}`,
      group: "MERCHANT_CONTACT",
      type: "QUESTIONNAIRE_FOLLOWUP",
      merchantId: questionnaire.merchantId,
      merchantName: questionnaire.merchantName,
      locationName: null,
      title: "等待商户填写问卷",
      reason: "问卷已发送，等待商户回复。",
      primaryAction: { label: "跟进问卷", href: `/merchants/${questionnaire.merchantId}` },
      secondaryHref: null,
      priority: "MEDIUM",
      dueAt: null,
      waitingSince: questionnaire.waitingSince,
    });
  }

  const filtered = actions.filter((action) => matches(action, query)).sort(compareActions);
  const summary = {
    gatekeeping: filtered.filter((action) => action.group === "GATEKEEPING").length,
    exception: filtered.filter((action) => action.group === "EXCEPTION").length,
    merchant_contact: filtered.filter((action) => action.group === "MERCHANT_CONTACT").length,
    total: filtered.length,
  };
  return {
    summary,
    items: filtered.slice(query.offset, query.offset + query.limit).map(wire),
    offset: query.offset,
    limit: query.limit,
    total: filtered.length,
  };
}

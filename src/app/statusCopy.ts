/** 全局状态文案：界面一律说人话，enum 只出现在详情/开发者视图。 */

import type { SeoTask } from "../api/types";

export const TASK_STATUS_LABELS: Record<string, string> = {
  DRAFT: "草稿",
  NEEDS_INPUT: "待输入",
  BLOCKED: "阻塞",
  READY_FOR_APPROVAL: "待审批",
  APPROVED: "已批准",
  REVISION_REQUIRED: "需修订",
  APPROVAL_REVOKED: "批准已撤销",
  EXECUTION_CONFIRMED: "已确认执行",
  DISPATCHING: "派发在途",
  OUTCOME_UNKNOWN: "结果待查",
  PENDING_VERIFY: "待核验",
  VERIFIED: "已核验",
  DONE: "已完成",
  FAILED: "失败·升级人工",
};

export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? status;
}

/** 证据状态（术语约定：齐备 / 部分 / 无法核实）。 */
export const EVIDENCE_STATE_LABELS: Record<string, string> = {
  NONE: "无",
  PARTIAL: "部分",
  VERIFIED: "齐备",
  UNVERIFIABLE: "无法核实",
};

export function evidenceStateLabel(state: string): string {
  return EVIDENCE_STATE_LABELS[state] ?? state;
}

export const EXECUTION_MODE_LABELS: Record<string, string> = {
  READ_ONLY: "Ⓐ 只读",
  ARTIFACT: "Ⓑ 成品",
  AUTO_WRITE: "Ⓒ 写入",
  MANUAL: "人工",
};

export function executionModeLabel(mode?: string): string {
  return (mode && EXECUTION_MODE_LABELS[mode]) || "人工";
}

export interface TaskDecisionDescriptor {
  heading: string;
  consequence: string;
  actionLabel: string | null;
  actionKind: "APPROVE" | "CONFIRM" | "VERIFY" | "RECONCILE" | "CONTACT" | "VIEW" | null;
}

type TaskDecisionPermissions = { canManage: boolean; canApprove: boolean; canExecute: boolean };

const TASK_DECISIONS: Record<string, TaskDecisionDescriptor> = {
  DRAFT: { heading: "先补齐任务定义", consequence: "补齐后会生成新的当前版本，旧版本不会被修改。", actionLabel: "补齐并新建修订", actionKind: "CONTACT" },
  NEEDS_INPUT: { heading: "需要补充商户信息", consequence: "补充信息不会触发执行或发布。", actionLabel: "补充信息", actionKind: "CONTACT" },
  BLOCKED: { heading: "先解除当前阻塞", consequence: "解除阻塞前不会尝试执行。", actionLabel: "查看阻塞原因", actionKind: "VIEW" },
  READY_FOR_APPROVAL: { heading: "现在需要批准当前版本", consequence: "批准不会立即发布", actionLabel: "批准当前版本", actionKind: "APPROVE" },
  APPROVED: { heading: "现在需要确认是否发布", consequence: "确认前会重新进行服务端校验。", actionLabel: "确认现在发布", actionKind: "CONFIRM" },
  REVISION_REQUIRED: { heading: "当前版本需要修订", consequence: "新建修订会保留当前版本的审批和证据记录。", actionLabel: "新建修订", actionKind: "CONTACT" },
  APPROVAL_REVOKED: { heading: "批准已撤销，需要复核", consequence: "重新批准前不会发布。", actionLabel: "新建修订", actionKind: "CONTACT" },
  EXECUTION_CONFIRMED: { heading: "发布确认已登记", consequence: "系统正在派发，不能把确认当成已发布。", actionLabel: "查看派发状态", actionKind: "VIEW" },
  DISPATCHING: { heading: "正在等待执行结果", consequence: "Run 结束不等于任务已完成，仍需结果回读。", actionLabel: "查看派发状态", actionKind: "VIEW" },
  OUTCOME_UNKNOWN: { heading: "需要人工确认动作是否发生", consequence: "查证不会自动重试；你的结论决定重新排队或进入核验。", actionLabel: "开始查证", actionKind: "RECONCILE" },
  PENDING_VERIFY: { heading: "现在需要核验外部结果", consequence: "核验通过才会归档，不会依据 Run 状态自动完成。", actionLabel: "提交核验", actionKind: "VERIFY" },
  VERIFIED: { heading: "核验已经完成", consequence: "保留证据和结论供后续审计。", actionLabel: "查看核验记录", actionKind: "VIEW" },
  DONE: { heading: "任务已经完成", consequence: "记录保持只读，可在审计详情查看完整证据链。", actionLabel: "查看完成记录", actionKind: "VIEW" },
  FAILED: { heading: "执行失败，需要人工排障", consequence: "不会自动重试；排障后仍需人工重新确认发布。", actionLabel: "排障后重新排队", actionKind: "RECONCILE" },
};

/** 把内部状态映射为一个面向操作员的下一步；权限不足时保留解释，但不伪造可执行动作。 */
export function taskDecisionDescriptor(task: SeoTask, permissions: TaskDecisionPermissions): TaskDecisionDescriptor {
  if (task.status === "APPROVED" && task.execution_mode === "MANUAL") {
    return {
      heading: "请补充人工完成证据",
      consequence: "人工完成后附加证据；系统不会派发或立即发布。",
      actionLabel: "查看人工完成指引",
      actionKind: "VIEW",
    };
  }
  const decision = TASK_DECISIONS[task.status] ?? {
    heading: "请查看任务状态",
    consequence: "状态记录已保留在技术详情中。",
    actionLabel: "查看技术详情（审计）",
    actionKind: "VIEW" as const,
  };
  const needsApproval = decision.actionKind === "APPROVE";
  const needsManage = decision.actionKind === "CONTACT";
  const needsExecute = decision.actionKind === "CONFIRM" || decision.actionKind === "VERIFY" || decision.actionKind === "RECONCILE";
  if ((needsApproval && !permissions.canApprove) || (needsManage && !permissions.canManage) || (needsExecute && !permissions.canExecute)) {
    return { ...decision, actionLabel: null };
  }
  if (task.status === "APPROVED" && task.execution_mode === "READ_ONLY") {
    return { heading: "当前任务按只读方式自动执行", consequence: "不会写入外部资产；可在审计详情查看派发与回读。", actionLabel: "查看派发状态", actionKind: "VIEW" };
  }
  return decision;
}

/** 可创建修订版的状态（与服务端 stateMachine.REVISION_ALLOWED_STATUSES 对齐）。 */
export const REVISABLE_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "REVISION_REQUIRED", "APPROVAL_REVOKED",
]);

/** 可附加证据的状态（与服务端 EVIDENCE_ALLOWED_STATUSES 对齐）。 */
export const EVIDENCE_ALLOWED_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL",
]);

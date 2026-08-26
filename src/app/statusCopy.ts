/** 全局状态文案：界面一律说人话，enum 只出现在详情/开发者视图。 */

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

/** 可创建修订版的状态（与服务端 stateMachine.REVISION_ALLOWED_STATUSES 对齐）。 */
export const REVISABLE_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "REVISION_REQUIRED", "APPROVAL_REVOKED",
]);

/** 可附加证据的状态（与服务端 EVIDENCE_ALLOWED_STATUSES 对齐）。 */
export const EVIDENCE_ALLOWED_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL",
]);

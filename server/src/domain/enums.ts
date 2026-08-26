export const SEO_TASK_STATUSES = [
  "DRAFT",
  "NEEDS_INPUT",
  "BLOCKED",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "REVISION_REQUIRED",
  "APPROVAL_REVOKED",
  // 执行域（双门之后）：见文件尾 EXECUTION_TASK_STATUSES 注释
  "EXECUTION_CONFIRMED",
  "DISPATCHING",
  "OUTCOME_UNKNOWN",
  "PENDING_VERIFY",
  "VERIFIED",
  "DONE",
  "FAILED",
] as const;
export type SeoTaskStatus = (typeof SEO_TASK_STATUSES)[number];

export const EVIDENCE_STATES = [
  "NONE",
  "PARTIAL",
  "VERIFIED",
  "UNVERIFIABLE",
] as const;
export type EvidenceState = (typeof EVIDENCE_STATES)[number];

export const APPROVAL_ACTIONS = ["APPROVE", "REJECT", "REVOKE"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_IMPACTS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type TaskImpact = (typeof TASK_IMPACTS)[number];

export const EVIDENCE_VERIFICATIONS = [
  "UNVERIFIED",
  "VERIFIED",
  "UNVERIFIABLE",
] as const;
export type EvidenceVerification = (typeof EVIDENCE_VERIFICATIONS)[number];

export const LOCATION_READINESSES = [
  "READY",
  "BLOCKED",
  "INCOMPLETE",
] as const;
export type LocationReadiness = (typeof LOCATION_READINESSES)[number];

/** 接入问卷状态：DRAFT 生成未发放 / SENT 已外发待商家 / FILLED 商家已提交。
 * OVERDUE 不是存储状态——由 sent_at + now 推导（催填用）。 */
export const QUESTIONNAIRE_STATUSES = [
  "DRAFT",
  "SENT",
  "FILLED",
] as const;
export type QuestionnaireStatus = (typeof QUESTIONNAIRE_STATUSES)[number];

/** 商户生命周期阶段轨（新店与老店共用同一条轨）。阶段永远从交付物链推导，
 * 不落存储列——重跑任一环节阶段自动回退，避免前向-only 枚举的回退谎言。 */
export const LIFECYCLE_STAGES = [
  "QUESTIONNAIRE",
  "KEYWORDS",
  "AUDIT",
  "RANKING_BASELINE",
  "PLAN",
  "EXECUTE",
  "VERIFY",
] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/** 首页异常分组的优先级顺序（先命中先分组）。 */
export const MERCHANT_EXCEPTIONS = [
  "WAITING_MERCHANT",
  "PLAN_PENDING",
  "APPROVAL",
  "VERIFY",
  "RANKING_DUE",
] as const;
export type MerchantExceptionType = (typeof MERCHANT_EXCEPTIONS)[number];

/** 可从阶段卡一键触发 agent 运行的阶段（EXECUTE/VERIFY 是人工环节，
 * 永不可触发——红线）。REVIEW 不在轨上，供老店复盘。 */
export const AGENT_RUN_STAGES = [
  "KEYWORDS",
  "AUDIT",
  "RANKING_BASELINE",
  "PLAN",
  "REVIEW",
] as const;
export type AgentRunStage = (typeof AGENT_RUN_STAGES)[number];
/** Task-linked GBP draft generation is persisted as a Run without becoming
 * a generic merchant lifecycle stage. */
export type StoredAgentRunStage = AgentRunStage | "GBP_POST_CONTENT";

export const AGENT_RUN_TYPES = [
  "AUDIT",
  "KEYWORD_RESEARCH",
  "PLAN",
  "REPORT",
  "REVIEW",
  "GBP_POST_CONTENT",
] as const;
export type AgentRunType = (typeof AGENT_RUN_TYPES)[number];

/** 阶段 → 只读 SOP 运行类型（统一 agent 侧的分类口径）。 */
export const RUN_TYPE_BY_STAGE: Record<AgentRunStage, AgentRunType> = {
  KEYWORDS: "KEYWORD_RESEARCH",
  AUDIT: "AUDIT",
  RANKING_BASELINE: "REPORT",
  PLAN: "PLAN",
  REVIEW: "REVIEW",
};

export const AGENT_RUN_STATUSES = [
  "TRIGGERING",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export const CORE_RUN_TERMINAL_STATUSES = [
  "COMPLETED",
  "FAILED",
  "TIMEOUT",
  "CANCELLED",
  "SKIPPED",
] as const;

/** 交付物来源：SUMMARY 运行正文 / ATTACHMENT agent 附件 / MANUAL 运营手工上传兜底。 */
export const DELIVERABLE_KINDS = ["SUMMARY", "ATTACHMENT", "MANUAL"] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

// ---------------- 执行域（双门 / attempt / 查证 / 核验） ----------------

/** 执行模式：外部写入 / 成品交付 / 只读采集 / 人工。 */
export const EXECUTION_MODES = [
  "AUTO_WRITE",
  "ARTIFACT",
  "READ_ONLY",
  "MANUAL",
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** 执行域任务状态（接在审批域之后）。
 * APPROVED -(门2)-> EXECUTION_CONFIRMED -> DISPATCHING -> attempt 终态：
 *   SUCCEEDED  -> PENDING_VERIFY（写入/成品）或 DONE（只读）
 *   FAILED_CONFIRMED -> 回 APPROVED（写入）或限次自动重试（只读Ⓐ）
 *   OUTCOME_UNKNOWN  -> 冻结，人工查证二选一
 * PENDING_VERIFY -(核验)-> VERIFIED -> DONE。 */
export const EXECUTION_TASK_STATUSES = [
  "EXECUTION_CONFIRMED",
  "DISPATCHING",
  "OUTCOME_UNKNOWN",
  "PENDING_VERIFY",
  "VERIFIED",
  "DONE",
  "FAILED",
] as const;

export const ATTEMPT_STATUSES = [
  "DISPATCHING",
  "SUCCEEDED",
  "FAILED_CONFIRMED",
  "OUTCOME_UNKNOWN",
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** 查证结论：这个写入动作到底发生没有（二选一，等权重）。 */
export const OUTCOME_RESOLUTIONS = ["HAPPENED", "NOT_HAPPENED"] as const;
export type OutcomeResolution = (typeof OUTCOME_RESOLUTIONS)[number];

/** 建议（TaskProposal）条目状态：判定前不落任务库。 */
export const PROPOSAL_STATUSES = [
  "PENDING",
  "VALIDATION_FAILED",
  "ADOPTED",
  "RETURNED",
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** 建议批次来源。 */
export const PROPOSAL_ORIGINS = ["PLANNER", "PLAN_CONVERT", "MANUAL"] as const;
export type ProposalOrigin = (typeof PROPOSAL_ORIGINS)[number];

/** 能力矩阵：资产接入状态（技术连接 × 商户授权 → 状态）。 */
export const CAPABILITY_STATUSES = ["ACTIVE", "BLOCKED", "MISSING"] as const;
export type CapabilityStatus = (typeof CAPABILITY_STATUSES)[number];

/** taskType 全集（Agent 绑定的键；执行域 worker 按此路由）。 */
export const TASK_TYPES = [
  "PLANNER",
  "QUESTIONNAIRE",
  "KEYWORD_RESEARCH",
  "KEYWORD_WEEKLY",
  "AUDIT",
  "REPORT",
  "REPORT_PACKAGE",
  "PLAN",
  "GBP_POST",
  "GBP_UPDATE",
  "WEBSITE_CONTENT",
  "REVIEW",
  "MANUAL_FOLLOWUP",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** Task types an Agent may propose. PLANNER is an internal deterministic
 * trigger envelope and must never recurse through Agent output. */
export const PLANNER_PROPOSABLE_TASK_TYPES = [
  "QUESTIONNAIRE",
  "KEYWORD_RESEARCH",
  "KEYWORD_WEEKLY",
  "AUDIT",
  "REPORT",
  "REPORT_PACKAGE",
  "PLAN",
  "GBP_POST",
  "GBP_UPDATE",
  "WEBSITE_CONTENT",
  "REVIEW",
  "MANUAL_FOLLOWUP",
] as const satisfies readonly TaskType[];
export type PlannerProposableTaskType = (typeof PLANNER_PROPOSABLE_TASK_TYPES)[number];

/** taskType × executionMode 兼容表（红线①的机器防线）：
 * 写入型任务类型不允许标成 READ_ONLY —— 否则一条 LLM 建议只要把
 * execution_mode 写成 READ_ONLY 就能绕过 G1/G2/能力矩阵直接派发到写入 agent。
 * MANUAL 任意类型可用（人工兜底）。 */
export const ALLOWED_EXECUTION_MODES: Record<TaskType, readonly string[]> = {
  PLANNER: ["READ_ONLY", "MANUAL"],
  QUESTIONNAIRE: ["READ_ONLY", "MANUAL"],
  KEYWORD_RESEARCH: ["READ_ONLY", "MANUAL"],
  KEYWORD_WEEKLY: ["READ_ONLY", "MANUAL"],
  AUDIT: ["READ_ONLY", "MANUAL"],
  REPORT: ["READ_ONLY", "MANUAL"],
  REPORT_PACKAGE: ["READ_ONLY", "MANUAL"],
  PLAN: ["READ_ONLY", "MANUAL"],
  GBP_POST: ["AUTO_WRITE", "MANUAL"],
  GBP_UPDATE: ["AUTO_WRITE", "MANUAL"],
  WEBSITE_CONTENT: ["AUTO_WRITE", "ARTIFACT", "MANUAL"],
  REVIEW: ["READ_ONLY", "MANUAL"],
  MANUAL_FOLLOWUP: ["MANUAL"],
};

export function isModeAllowedForType(taskType: string, executionMode: string): boolean {
  const allowed = ALLOWED_EXECUTION_MODES[taskType as TaskType];
  // 未知 taskType 由 TASK_TYPES 校验单独拦；这里不重复报错。
  if (!allowed) return true;
  return allowed.includes(executionMode);
}

/** 只读Ⓐ级任务失败的自动重试上限（超过则 FAILED 升级人工）。 */
export const READ_ONLY_AUTO_RETRY_LIMIT = 3;

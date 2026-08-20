export const SEO_TASK_STATUSES = [
  "DRAFT",
  "NEEDS_INPUT",
  "BLOCKED",
  "READY_FOR_APPROVAL",
  "APPROVED",
  "REVISION_REQUIRED",
  "APPROVAL_REVOKED",
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

export const AGENT_RUN_TYPES = [
  "AUDIT",
  "KEYWORD_RESEARCH",
  "PLAN",
  "REPORT",
  "REVIEW",
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

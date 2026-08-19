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

export const AGENT_RUN_TYPES = [
  "AUDIT",
  "KEYWORD_RESEARCH",
  "PLAN",
  "REPORT",
  "REVIEW",
] as const;
export type AgentRunType = (typeof AGENT_RUN_TYPES)[number];

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

/** run_type -> evidence.type appended when a run completes (requirement_key
 * uses the same value). Only *_REPORT values surface in the reports
 * projection; PLAN/REVIEW outputs are working documents, not data reports. */
export const EVIDENCE_TYPE_BY_RUN_TYPE: Record<AgentRunType, string> = {
  AUDIT: "AUDIT_REPORT",
  KEYWORD_RESEARCH: "KEYWORD_RESEARCH_REPORT",
  PLAN: "ACTION_PLAN",
  REPORT: "PERFORMANCE_REPORT",
  REVIEW: "REVIEW_SUMMARY",
};

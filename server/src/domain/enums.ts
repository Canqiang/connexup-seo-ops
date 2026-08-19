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

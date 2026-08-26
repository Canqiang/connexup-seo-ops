import type {
  ApprovalAction,
  EvidenceState,
  SeoTaskStatus,
} from "./enums.js";

/** Minimal evidence shape the state machine reasons over. */
export interface EvidenceLike {
  taskRevision: number;
  verificationStatus: string;
  requirementKey: string;
}

const REVISION_ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "NEEDS_INPUT",
  "BLOCKED",
  "READY_FOR_APPROVAL",
  "REVISION_REQUIRED",
  "APPROVAL_REVOKED",
]);

const EVIDENCE_ALLOWED_STATUSES: ReadonlySet<string> = new Set([
  "DRAFT",
  "NEEDS_INPUT",
  "BLOCKED",
  "READY_FOR_APPROVAL",
]);

/** action -> currentStatus -> nextStatus. Anything not listed is an illegal transition. */
const APPROVAL_TRANSITIONS: Record<string, Record<string, string>> = {
  APPROVE: { READY_FOR_APPROVAL: "APPROVED" },
  REJECT: { READY_FOR_APPROVAL: "REVISION_REQUIRED" },
  REVOKE: { APPROVED: "APPROVAL_REVOKED" },
};

export function canCreateRevision(status: string): boolean {
  return REVISION_ALLOWED_STATUSES.has(status);
}

export function canAppendEvidence(status: string): boolean {
  return EVIDENCE_ALLOWED_STATUSES.has(status);
}

/**
 * Resolve an approval transition. Returns the resulting status, or null when
 * the (action, currentStatus) pair is not permitted.
 */
export function decideApproval(
  currentStatus: string,
  action: ApprovalAction,
): SeoTaskStatus | null {
  const table = APPROVAL_TRANSITIONS[action];
  return (table?.[currentStatus] as SeoTaskStatus | undefined) ?? null;
}

/**
 * Derive the evidence state from the required types and the evidence bound to
 * the CURRENT revision only.
 *
 * - NONE: no evidence on this revision
 * - UNVERIFIABLE: some required type has an UNVERIFIABLE entry and no VERIFIED
 *   or UNVERIFIED (pending) replacement
 * - VERIFIED: every required type has a VERIFIED entry on this revision
 * - PARTIAL: otherwise
 */
export function evaluateEvidenceState(
  requiredTypes: string[],
  evidence: EvidenceLike[],
  revision: number,
): EvidenceState {
  const relevant = evidence.filter((e) => e.taskRevision === revision);
  if (relevant.length === 0 || requiredTypes.length === 0) return "NONE";

  // A required type with an UNVERIFIABLE entry and no VERIFIED/pending
  // replacement poisons the whole revision.
  for (const reqType of requiredTypes) {
    const entries = relevant.filter((e) => e.requirementKey === reqType);
    const verified = entries.some((e) => e.verificationStatus === "VERIFIED");
    if (verified) continue;
    const unverifiable = entries.some(
      (e) => e.verificationStatus === "UNVERIFIABLE",
    );
    const pending = entries.some((e) => e.verificationStatus === "UNVERIFIED");
    if (unverifiable && !pending) return "UNVERIFIABLE";
  }

  const allVerified = requiredTypes.every((reqType) => {
    const entries = relevant.filter((e) => e.requirementKey === reqType);
    return entries.some((e) => e.verificationStatus === "VERIFIED");
  });
  return allVerified ? "VERIFIED" : "PARTIAL";
}

export interface EvalResult {
  evidenceState: EvidenceState;
  status: SeoTaskStatus;
}

/**
 * Combine evidence state with the linked location's readiness to derive the
 * workflow status. Location blocked/missing -> BLOCKED wins over evidence.
 */
export function evaluate(
  requiredTypes: string[],
  evidence: EvidenceLike[],
  revision: number,
  locationReadiness: string | null,
): EvalResult {
  const evidenceState = evaluateEvidenceState(requiredTypes, evidence, revision);
  let status: SeoTaskStatus;
  if (locationReadiness && locationReadiness !== "READY") {
    status = "BLOCKED";
  } else if (evidenceState === "VERIFIED") {
    status = "READY_FOR_APPROVAL";
  } else if (evidenceState === "UNVERIFIABLE") {
    status = "BLOCKED";
  } else {
    status = "NEEDS_INPUT";
  }
  return { evidenceState, status };
}

// ---------------- 执行域（双门 / attempt / 查证 / 核验） ----------------

/** 门 2 可确认的前置状态（写入/成品类需先过门 1）。 */
export function canConfirmExecution(status: string): boolean {
  return status === "APPROVED";
}

/** attempt 成功后的任务终点：只读归档即完成；写入与成品进入核验。 */
export function statusAfterAttemptSuccess(executionMode: string): SeoTaskStatus {
  return executionMode === "READ_ONLY" ? "DONE" : "PENDING_VERIFY";
}

/** attempt 确认失败后的任务状态：回到已批准（授权仍有效，可再次确认）。 */
export const STATUS_AFTER_ATTEMPT_FAILURE: SeoTaskStatus = "APPROVED";

/** 查证结论 → (attempt 终态, 任务状态)。二选一，等权重。 */
export function resolveOutcome(
  resolution: "HAPPENED" | "NOT_HAPPENED",
  executionMode: string,
): { attemptStatus: "SUCCEEDED" | "FAILED_CONFIRMED"; taskStatus: SeoTaskStatus } {
  if (resolution === "HAPPENED") {
    return { attemptStatus: "SUCCEEDED", taskStatus: statusAfterAttemptSuccess(executionMode) };
  }
  return { attemptStatus: "FAILED_CONFIRMED", taskStatus: STATUS_AFTER_ATTEMPT_FAILURE };
}

/** 核验只针对 PENDING_VERIFY；核验通过 → VERIFIED（事件）→ DONE（终态）。 */
export function canVerify(status: string): boolean {
  return status === "PENDING_VERIFY";
}

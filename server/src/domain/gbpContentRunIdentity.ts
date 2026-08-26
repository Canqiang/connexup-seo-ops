import { requestFingerprint } from "./hashing.js";

export interface GbpContentRetryHttpSemantics {
  priorRunId: string;
  reason: string;
}

/** Route/body identity only. Mutable Task, style, binding, business, and
 * generation state must never participate in HTTP idempotency. */
export function gbpContentHttpRequestFingerprint(
  taskId: string,
  retry?: GbpContentRetryHttpSemantics,
): string {
  return requestFingerprint({
    task_id: taskId,
    retry_of_agent_run_id: retry?.priorRunId ?? null,
    retry_reason: retry ? retry.reason.trim() : null,
  });
}

import { requestFingerprint } from "./hashing.js";

export interface GbpContentRetryHttpSemantics {
  priorRunId: string;
  reason: string;
  mode?: "RETRY" | "REGENERATE";
}

/** Route/body identity only. Mutable Task, style, binding, business, and
 * generation state must never participate in HTTP idempotency. */
export function gbpContentHttpRequestFingerprint(
  taskId: string,
  retry?: GbpContentRetryHttpSemantics,
): string {
  const identity = {
    task_id: taskId,
    retry_of_agent_run_id: retry?.priorRunId ?? null,
    retry_reason: retry ? retry.reason.trim() : null,
  };
  // Preserve the deployed RETRY/no-retry fingerprint shape.  REGENERATE is a
  // distinct, explicit operator intent and therefore gets an extra identity bit.
  return requestFingerprint(retry?.mode === "REGENERATE"
    ? { ...identity, regenerate: true }
    : identity);
}

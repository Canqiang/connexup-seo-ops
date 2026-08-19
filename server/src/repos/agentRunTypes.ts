import type { AgentRunStatus, AgentRunType } from "../domain/enums.js";

/** Server-side record of one orchestrated core-ai agent run against a task.
 * `status` is our lifecycle (TRIGGERING → RUNNING → terminal); `coreStatus`
 * keeps the core-ai RunStatus verbatim for diagnostics. */
export interface AgentRun {
  id: string;
  taskId: string;
  runType: AgentRunType;
  goal: string | null;
  status: AgentRunStatus;
  coreRunId: string | null;
  coreStatus: string | null;
  inputMessage: string;
  output: string | null;
  error: string | null;
  errorCode: string | null;
  tokenUsage: Record<string, number>;
  artifactPath: string | null;
  artifactSha256: string | null;
  evidenceId: string | null;
  evidenceSkippedReason: string | null;
  triggeredBy: string;
  triggeredAt: string;
  lastPolledAt: string | null;
  completedAt: string | null;
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

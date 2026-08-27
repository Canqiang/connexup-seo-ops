import { conflict } from "../errors.js";
import type { AgentRun } from "../repos/agentRunTypes.js";

export interface AgentRunTaskScope {
  merchantId: string;
  taskId: string;
  locationId: string | null;
}

export function agentRunScopeReconciliationRequired(): never {
  throw conflict(
    "persisted GBP Post content Run scope does not match the authorized Task; reconciliation is required",
    "CONTENT_RUN_RECONCILIATION_REQUIRED",
  );
}

export function assertAgentRunTaskScope(run: AgentRun, expected: AgentRunTaskScope): void {
  if (run.taskId !== expected.taskId
    || run.merchantId !== expected.merchantId
    || run.locationId !== expected.locationId) {
    agentRunScopeReconciliationRequired();
  }
}

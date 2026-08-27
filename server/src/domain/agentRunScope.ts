import { conflict } from "../errors.js";
import type { AgentRun } from "../repos/agentRunTypes.js";

export interface AgentRunTaskScope {
  stage: "GBP_POST_CONTENT";
  merchantId: string;
  taskId: string;
  locationId: string | null;
}

export function agentRunScopeReconciliationRequired(): never {
  throw conflict(
    "GBP Post content Run requires reconciliation",
    "CONTENT_RUN_RECONCILIATION_REQUIRED",
  );
}

export function assertAgentRunTaskScope(run: AgentRun, expected: AgentRunTaskScope): void {
  if (run.stage !== expected.stage
    || run.taskId !== expected.taskId
    || run.merchantId !== expected.merchantId
    || run.locationId !== expected.locationId) {
    agentRunScopeReconciliationRequired();
  }
}

export function assertTaskMatchesAgentRunScope(
  task: { id: string; merchantId: string; locationId: string | null },
  expected: AgentRunTaskScope,
): void {
  if (expected.stage !== "GBP_POST_CONTENT"
    || task.id !== expected.taskId
    || task.merchantId !== expected.merchantId
    || task.locationId !== expected.locationId) {
    agentRunScopeReconciliationRequired();
  }
}

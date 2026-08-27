import type { Db } from "../db/connection.js";
import { getTask } from "../repos/taskRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";

/** A corrupt GBP content row may have either discriminator changed. Treat
 * either one as sufficient to keep the stricter task-linked boundary. */
export function isTaskLinkedGbpContentRun(run: AgentRun): boolean {
  return run.stage === "GBP_POST_CONTENT" || run.runType === "GBP_POST_CONTENT";
}

export async function hasValidTaskLinkedGbpContentScope(
  db: Db,
  run: AgentRun,
): Promise<boolean> {
  if (!isTaskLinkedGbpContentRun(run)) return true;
  if (!run.taskId) return false;
  const task = await getTask(db, run.taskId);
  if (!task) return false;
  return run.stage === "GBP_POST_CONTENT"
    && run.taskId === task.id
    && run.merchantId === task.merchantId
    && run.locationId === task.locationId;
}

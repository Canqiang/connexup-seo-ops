import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { requestFingerprint } from "../domain/hashing.js";
import type { Task } from "../repos/taskTypes.js";
import { buildEvent, mutateTaskRetry } from "./taskService.js";

/** Read-only work may be pre-authorized only by an explicit cycle rule, a
 * human-adopted proposal, or a deterministic internal planning event. */
export const AUTO_AUTHORIZABLE_SOURCES = new Set(["CYCLE", "PROPOSAL", "PLAN", "SYSTEM"]);

/** Ⓐ级授权：READ_ONLY 任务直接 APPROVED（留系统审批记录）。 */
export async function authorizeReadOnlyTask(
  db: Db,
  task: Task,
  actor: string,
  reason: string,
): Promise<void> {
  if (task.executionMode !== "READ_ONLY" || !AUTO_AUTHORIZABLE_SOURCES.has(task.source)) return;
  if (task.status !== "NEEDS_INPUT" && task.status !== "READY_FOR_APPROVAL") return;
  await mutateTaskRetry(
    db,
    task.id,
    `auto-authorize:${task.id}`,
    requestFingerprint({ action: "AUTO_AUTHORIZE" }),
    (current) => {
      if (current.status !== "NEEDS_INPUT" && current.status !== "READY_FOR_APPROVAL") {
        return current;
      }
      const resultingVersion = current.stateVersion + 1;
      const now = new Date().toISOString();
      return {
        ...current,
        status: "APPROVED",
        stateVersion: resultingVersion,
        updatedAt: now,
        approvalDecisions: [
          ...current.approvalDecisions,
          {
            id: crypto.randomUUID(),
            decision: "APPROVE",
            reason,
            taskRevision: current.taskRevision,
            executionSpecHash: current.executionSpecHash,
            expectedStateVersion: current.stateVersion,
            resultingStateVersion: resultingVersion,
            actorId: actor,
            decidedAt: now,
          },
        ],
        events: [
          ...current.events,
          buildEvent("AUTO_AUTHORIZED", current.taskRevision, resultingVersion, actor, {
            fromStatus: current.status,
            toStatus: "APPROVED",
          }),
        ],
      };
    },
  );
}

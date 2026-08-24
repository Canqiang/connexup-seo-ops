import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthActor, SeoPermission } from "./types.js";
import type { AppContext } from "../index.js";
import { ApiError } from "../errors.js";
import { resolveActorFromToken } from "../services/authService.js";
import type { Db } from "../db/connection.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getTask } from "../repos/taskRepo.js";
import { getAgentRun, getDeliverable } from "../repos/agentRunRepo.js";
import type { Merchant } from "../repos/types.js";
import type { Task } from "../repos/taskTypes.js";
import type { AgentRun, RunDeliverable } from "../repos/agentRunTypes.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: AuthActor | null;
  }
}

export function registerActorResolution(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (request) => {
    request.actor = null;
    const rawToken = request.cookies.seo_ops_session;
    if (rawToken) {
      request.actor = await resolveActorFromToken(ctx.db, rawToken, ctx.config);
    }
  });
}

export function requireActor(request: FastifyRequest): AuthActor {
  if (!request.actor) {
    throw new ApiError(401, "authentication required", "AUTH_REQUIRED");
  }
  return request.actor;
}

export function requirePermission(
  request: FastifyRequest,
  permission: SeoPermission,
): AuthActor {
  const actor = requireActor(request);
  if (!actor.permissions.includes(permission)) {
    throw new ApiError(403, "permission denied", "FORBIDDEN");
  }
  return actor;
}

function hiddenResource(): never {
  throw new ApiError(404, "resource not found");
}

/** A resource that is absent and one outside the actor's merchant scope are
 * deliberately indistinguishable to avoid identifier enumeration. */
export async function requireMerchantAccess(
  db: Db,
  actor: AuthActor,
  merchantId: string,
): Promise<Merchant> {
  const merchant = await getMerchant(db, merchantId);
  if (!merchant || !merchant.operatorUserIds.includes(actor.userId)) hiddenResource();
  return merchant;
}

export async function requireTaskAccess(
  db: Db,
  actor: AuthActor,
  taskId: string,
): Promise<Task> {
  const task = await getTask(db, taskId);
  if (!task) hiddenResource();
  await requireMerchantAccess(db, actor, task.merchantId);
  return task;
}

export async function requireRunAccess(
  db: Db,
  actor: AuthActor,
  runId: string,
): Promise<AgentRun> {
  const run = await getAgentRun(db, runId);
  if (!run) hiddenResource();
  await requireMerchantAccess(db, actor, run.merchantId);
  return run;
}

export async function requireDeliverableAccess(
  db: Db,
  actor: AuthActor,
  deliverableId: string,
): Promise<RunDeliverable> {
  const deliverable = await getDeliverable(db, deliverableId);
  if (!deliverable) hiddenResource();
  await requireRunAccess(db, actor, deliverable.runId);
  return deliverable;
}

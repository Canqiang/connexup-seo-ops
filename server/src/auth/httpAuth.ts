import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthActor, SeoPermission } from "./types.js";
import type { AppContext } from "../index.js";
import { ApiError } from "../errors.js";
import { resolveActorFromToken } from "../services/authService.js";

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

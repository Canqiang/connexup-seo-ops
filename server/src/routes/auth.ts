import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireActor } from "../auth/httpAuth.js";
import type { AuthActor } from "../auth/types.js";
import type { AppContext } from "../index.js";
import { logout, login } from "../services/authService.js";

const SESSION_COOKIE = "seo_ops_session";
const loginSchema = z.object({
  email: z.string(),
  password: z.string(),
});

function authenticatedUser(actor: AuthActor): {
  user_id: string;
  name: string;
  role: string;
  permissions: AuthActor["permissions"];
} {
  return {
    user_id: actor.userId,
    name: actor.name,
    role: actor.role,
    permissions: actor.permissions,
  };
}

function sessionCookieOptions(ctx: AppContext) {
  return {
    httpOnly: true,
    sameSite: "strict" as const,
    path: "/",
    secure: ctx.config.sessionCookieSecure,
  };
}

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    const result = await login(ctx.db, input, ctx.config, new Date());
    reply.setCookie(SESSION_COOKIE, result.rawToken, {
      ...sessionCookieOptions(ctx),
      expires: new Date(result.expiresAt),
    });
    return authenticatedUser(result.actor);
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const rawToken = request.cookies[SESSION_COOKIE];
    if (rawToken) await logout(ctx.db, rawToken, ctx.config);
    reply.clearCookie(SESSION_COOKIE, sessionCookieOptions(ctx));
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request) => authenticatedUser(requireActor(request)));
}

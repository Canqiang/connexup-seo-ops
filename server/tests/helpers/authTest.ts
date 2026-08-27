import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../../src/auth/password.js";
import type { AuthActor, IdentityType, SeoPermission, SeoUser } from "../../src/auth/types.js";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import type { Db } from "../../src/db/connection.js";
import { buildApp, type AppDeps } from "../../src/index.js";
import type { CoreAiAgentAdminClient } from "../../src/services/coreAiAgentAdminClient.js";
import { upsertUser } from "../../src/repos/userRepo.js";
import { insertSession } from "../../src/repos/sessionRepo.js";
import { createSessionToken, sessionTokenHash } from "../../src/services/authService.js";
import { createTestDb } from "./pgTest.js";

const PASSWORD = "Correct horse battery staple 42!";
const ALL_PERMISSIONS: SeoPermission[] = [
  "seoops.view",
  "seoops.manage",
  "seoops.approve",
  "seoops.execute",
  "seoops.capability.manage",
  "seoops.schedule.manage",
];

function draftOnlyAgentAdmin(): CoreAiAgentAdminClient {
  return {
    pageLimit: 50,
    async listAgentsPage() { return { agents: [], total: 0, page: 1, limit: 50 }; },
    async getAgent(id) {
      return {
        id,
        name: "[SEO Ops] GBP Post Content v4",
        status: "PUBLISHED",
        description: "Draft-only test Agent",
        system_prompt: "Return one GBP draft and never publish.",
        model: "test-model",
        temperature: 0,
        thinking_effort: null,
        max_turns: 10,
        timeout_seconds: 600,
        enable_memory: false,
        type: "AGENT",
        tools: [{ id: "builtin:builtin-media-generation", type: "BUILTIN", source: "builtin" }],
        skill_ids: [],
        skills: [],
        subagent_ids: [],
        sub_agents: [],
        dataset_config: [],
        sandbox_config: null,
        response_schema: JSON.stringify({
          type: "object",
          properties: { schema_version: { const: "seo_ops.gbp_post_draft.v2" } },
        }),
      };
    },
    async createAgent() { throw new Error("create Agent not expected in app tests"); },
    async publishAgent() { throw new Error("publish Agent not expected in app tests"); },
  };
}

export interface AuthenticatedTestApp {
  app: FastifyInstance;
  db: Db;
  actor: AuthActor;
  cookie: string;
  inject: FastifyInstance["inject"];
  rawInject: FastifyInstance["inject"];
}

function cookieFrom(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("expected login response to include Set-Cookie");
  return value.split(";", 1)[0];
}

export async function createTestUser(
  db: Db,
  overrides: Partial<SeoUser> = {},
): Promise<SeoUser> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  return upsertUser(db, {
    id,
    email: `${id}@example.test`,
    displayName: "Test operator",
    role: "seo_operator",
    identityType: "HUMAN",
    permissions: ALL_PERMISSIONS,
    passwordHash: await hashPassword(PASSWORD),
    status: "ACTIVE",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

/** Builds a real app and authenticates through the production login route.
 * `rawInject` does not add a cookie; it never bypasses production auth. */
export async function createAuthenticatedTestApp(options: {
  permissions?: SeoPermission[];
  identityType?: IdentityType;
  configOverrides?: Partial<ServerConfig>;
  deps?: Omit<AppDeps, "db">;
} = {}): Promise<AuthenticatedTestApp> {
  const testDb = await createTestDb();
  const appDeps = { ...options.deps };
  if (appDeps.coreAi && appDeps.coreAiAgentAdmin === undefined) {
    appDeps.coreAiAgentAdmin = draftOnlyAgentAdmin();
  }
  const { app, db } = await buildApp({
    ...loadConfig(),
    sessionSecret: "test-session-secret-must-have-at-least-32-characters",
    sessionCookieSecure: false,
    ...options.configOverrides,
  }, { ...appDeps, db: testDb.db });
  app.addHook("onClose", async () => testDb.teardown());

  const user = await createTestUser(db, {
    id: "op-1",
    email: "operator@example.test",
    permissions: options.permissions ?? ALL_PERMISSIONS,
    identityType: options.identityType ?? "HUMAN",
  });
  const rawToken = user.identityType === "HUMAN"
    ? await (async () => {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: user.email, password: PASSWORD },
      });
      if (login.statusCode !== 200) {
        await app.close();
        throw new Error(`test login failed with ${login.statusCode}`);
      }
      return cookieFrom(login).split("=", 2)[1]!;
    })()
    : await (async () => {
      const token = createSessionToken();
      const now = new Date();
      await insertSession(db, {
        id: crypto.randomUUID(),
        userId: user.id,
        tokenHash: sessionTokenHash("test-session-secret-must-have-at-least-32-characters", token),
        expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        revokedAt: null,
        createdAt: now.toISOString(),
        lastSeenAt: now.toISOString(),
      });
      return token;
    })();

  const actor: AuthActor = {
    userId: user.id,
    email: user.email,
    name: user.displayName,
    role: user.role,
    identityType: user.identityType,
    permissions: user.permissions,
  };
  const cookie = `seo_ops_session=${rawToken}`;
  const rawInject = app.inject.bind(app);
  const inject: FastifyInstance["inject"] = (options) => rawInject({
    ...options,
    headers: { ...options.headers, cookie: options.headers?.cookie ?? cookie },
  });
  // Existing route tests continue to exercise the authenticated production
  // path through `app.inject`; only `rawInject` omits the cookie.
  app.inject = inject;
  return { app, db, actor, cookie, inject, rawInject };
}

export { PASSWORD };

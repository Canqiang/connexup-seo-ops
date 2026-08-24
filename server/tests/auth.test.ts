import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashPassword } from "../src/auth/password.js";
import type { SeoUser } from "../src/auth/types.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { getUserById, upsertUser } from "../src/repos/userRepo.js";
import { createTestDb } from "./helpers/pgTest.js";

const PASSWORD = "Correct horse battery staple 42!";

function cookieFrom(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  const setCookie = response.headers["set-cookie"];
  const value = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!value) throw new Error("expected Set-Cookie header");
  return value.split(";", 1)[0];
}

function cookiesFrom(response: Awaited<ReturnType<FastifyInstance["inject"]>>): string {
  const setCookie = response.headers["set-cookie"];
  return Array.isArray(setCookie) ? setCookie.join("\n") : setCookie ?? "";
}

async function makeApp(sessionCookieSecure = false): Promise<{
  app: FastifyInstance;
  db: Awaited<ReturnType<typeof createTestDb>>["db"];
}> {
  const ctx = await createTestDb();
  const config = {
    ...loadConfig(),
    sessionSecret: "test-session-secret-must-have-at-least-32-characters",
    sessionTtlHours: 12,
    sessionCookieSecure,
  };
  const { app } = await buildApp(config, { db: ctx.db });
  app.addHook("onClose", async () => ctx.teardown());
  return { app, db: ctx.db };
}

async function seedUser(
  db: Awaited<ReturnType<typeof createTestDb>>["db"],
  overrides: Partial<SeoUser> = {},
): Promise<SeoUser> {
  const now = "2026-08-24T00:00:00.000Z";
  return upsertUser(db, {
    id: "operator-1",
    email: "operator@example.com",
    displayName: "Operator",
    role: "seo_lead",
    identityType: "HUMAN",
    permissions: ["seoops.view", "seoops.manage"],
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

describe("cookie session authentication", () => {
  let app: FastifyInstance;
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];

  beforeEach(async () => ({ app, db } = await makeApp()));
  afterEach(async () => app.close());

  it("rejects an unauthenticated /api/auth/me request", async () => {
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error_code: "AUTH_REQUIRED" });
  });

  it("logs in an active human, sets a strict cookie, and resolves /me", async () => {
    await seedUser(db);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "operator@example.com", password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({
      user_id: "operator-1",
      name: "Operator",
      role: "seo_lead",
      permissions: ["seoops.view", "seoops.manage"],
    });
    expect(cookiesFrom(login)).toContain("seo_ops_session=");
    expect(cookiesFrom(login)).toContain("HttpOnly");
    expect(cookiesFrom(login)).toContain("SameSite=Strict");
    expect(cookiesFrom(login)).toContain("Path=/");
    expect(cookiesFrom(login)).not.toContain("Secure");

    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cookieFrom(login) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(login.json());
  });

  it("sets Secure only when the session cookie configuration enables it", async () => {
    await app.close();
    ({ app, db } = await makeApp(true));
    await seedUser(db);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "operator@example.com", password: PASSWORD },
    });
    expect(cookiesFrom(login)).toContain("Secure");
    expect(cookiesFrom(login)).toContain("HttpOnly");
    expect(cookiesFrom(login)).toContain("SameSite=Strict");
    expect(cookiesFrom(login)).toContain("Path=/");
  });

  it("does not disclose why an invalid login failed", async () => {
    await seedUser(db);
    const attempts = await Promise.all([
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: "wrong password 123" } }),
      app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "unknown@example.com", password: PASSWORD } }),
    ]);
    for (const response of attempts) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
    }
  });

  it("allows only active human identities to log in", async () => {
    await seedUser(db, { status: "DISABLED" });
    const disabled = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: PASSWORD },
    });
    expect(disabled.statusCode).toBe(401);
    expect(disabled.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });

    await seedUser(db, {
      id: "service-1", email: "service@example.com", identityType: "SERVICE",
      permissions: ["seoops.view"], status: "ACTIVE",
    });
    const service = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: "service@example.com", password: PASSWORD },
    });
    expect(service.statusCode).toBe(401);
    expect(service.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
  });

  it("rejects an expired session and expires its cookie on logout", async () => {
    await seedUser(db);
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: PASSWORD },
    });
    const cookie = cookieFrom(login);
    const token = cookie.split("=", 2)[1];
    await db.exec(`UPDATE seo_sessions SET expires_at = $1 WHERE token_hash IS NOT NULL`, ["2000-01-01T00:00:00.000Z"]);

    const expired = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ error_code: "AUTH_REQUIRED" });
    expect(token).toBeTruthy();

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(204);
    expect(cookiesFrom(logout)).toContain("seo_ops_session=");
    expect(cookiesFrom(logout)).toMatch(/Max-Age=0|Expires=/);
  });

  it("locks an identity for fifteen minutes after five failures without changing the error", async () => {
    await seedUser(db);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: "wrong password 123" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
    }

    const correctWhileLocked = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: PASSWORD },
    });
    expect(correctWhileLocked.statusCode).toBe(401);
    expect(correctWhileLocked.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
  });

  it("atomically locks an identity after five concurrent failures", async () => {
    await seedUser(db);

    const attempts = await Promise.all(Array.from({ length: 5 }, () => app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "operator@example.com", password: "wrong password 123" },
    })));
    for (const response of attempts) {
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
    }
    expect(await getUserById(db, "operator-1")).toMatchObject({
      failedLoginCount: 5,
      lockedUntil: expect.any(String),
    });

    const correctWhileLocked = await app.inject({
      method: "POST", url: "/api/auth/login", payload: { email: "operator@example.com", password: PASSWORD },
    });
    expect(correctWhileLocked.statusCode).toBe(401);
    expect(correctWhileLocked.json()).toMatchObject({ error_code: "INVALID_CREDENTIALS" });
  });

  it("uses a fixed valid scrypt candidate for invalid password lengths", async () => {
    const authService = await import("../src/services/authService.js");
    const candidate = (authService as Record<string, unknown>).passwordForScryptVerification;
    expect(typeof candidate).toBe("function");
    if (typeof candidate !== "function") return;

    const normalize = candidate as (password: string) => string;
    expect(normalize(PASSWORD)).toBe(PASSWORD);
    expect(normalize("short")).toBe("invalid-password-verification-candidate");
    expect(normalize("a".repeat(129))).toBe("invalid-password-verification-candidate");
  });
});

describe("session configuration", () => {
  it("fails closed outside tests when SESSION_SECRET is missing or too short", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow("SESSION_SECRET");
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: "too-short" })).toThrow("SESSION_SECRET");
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      sessionTtlHours: 12,
      sessionCookieSecure: false,
    });
    const validSecret = "production-session-secret-must-have-at-least-32-characters";
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: validSecret, SESSION_TTL_HOURS: "0" })).toThrow("SESSION_TTL_HOURS");
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: validSecret, SESSION_TTL_HOURS: "12.5" })).toThrow("SESSION_TTL_HOURS");
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: validSecret, SESSION_TTL_HOURS: "9007199254740992" })).toThrow("SESSION_TTL_HOURS");
    expect(() => loadConfig({ NODE_ENV: "production", SESSION_SECRET: validSecret, SESSION_TTL_HOURS: "721" })).toThrow("SESSION_TTL_HOURS");
    expect(loadConfig({ NODE_ENV: "production", SESSION_SECRET: validSecret, SESSION_TTL_HOURS: "720", SESSION_COOKIE_SECURE: "true" }).sessionTtlHours).toBe(720);
  });

  it("parses SESSION_COOKIE_SECURE exactly and requires true in production", () => {
    const production = {
      NODE_ENV: "production",
      SESSION_SECRET: "production-session-secret-must-have-at-least-32-characters",
    };
    expect(() => loadConfig(production)).toThrow("SESSION_COOKIE_SECURE");
    expect(() => loadConfig({ ...production, SESSION_COOKIE_SECURE: "false" })).toThrow("SESSION_COOKIE_SECURE");
    expect(loadConfig({ ...production, SESSION_COOKIE_SECURE: "true" }).sessionCookieSecure).toBe(true);
    for (const invalid of ["TRUE", "1", "yes", "treu", "", " ", " true", "false "]) {
      expect(() => loadConfig({ ...production, SESSION_COOKIE_SECURE: invalid })).toThrow("SESSION_COOKIE_SECURE");
    }

    const development = {
      NODE_ENV: "development",
      SESSION_SECRET: "development-session-secret-must-have-at-least-32-characters",
    };
    expect(loadConfig(development).sessionCookieSecure).toBe(false);
    expect(loadConfig({ ...development, SESSION_COOKIE_SECURE: "false" }).sessionCookieSecure).toBe(false);
    expect(loadConfig({ ...development, SESSION_COOKIE_SECURE: "true" }).sessionCookieSecure).toBe(true);
  });
});

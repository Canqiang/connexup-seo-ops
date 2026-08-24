import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertAllowedIdentityPermissions, type SeoUser } from "../src/auth/types.js";
import {
  getUserByEmail,
  getUserById,
  recordLoginFailure,
  recordLoginSuccess,
  upsertUser,
} from "../src/repos/userRepo.js";
import {
  deleteExpiredSessions,
  getActiveSessionByHash,
  insertSession,
  revokeSessionByHash,
  type SeoSession,
} from "../src/repos/sessionRepo.js";
import { migrate } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
beforeAll(() => migrate(ctx.db));
afterAll(() => ctx.teardown());

function user(overrides: Partial<SeoUser> = {}): SeoUser {
  return {
    id: "user-1",
    email: "operator@example.com",
    displayName: "Operator",
    role: "seo_lead",
    identityType: "HUMAN",
    permissions: ["seoops.view", "seoops.manage"],
    passwordHash: "scrypt$16384$8$1$salt$key",
    status: "ACTIVE",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    ...overrides,
  };
}

describe("auth repositories", () => {
  it("normalizes emails and maps only catalog permissions from stored rows", async () => {
    const saved = await upsertUser(ctx.db, user());
    expect(saved.email).toBe("operator@example.com");

    const found = await getUserByEmail(ctx.db, "  OPERATOR@EXAMPLE.COM ");
    expect(found).toMatchObject({ id: "user-1", displayName: "Operator", permissions: ["seoops.view", "seoops.manage"] });

    await ctx.db.exec(`UPDATE seo_users SET permissions = $1 WHERE id = $2`, [
      JSON.stringify(["seoops.view", "*", "not.a.permission"]),
      "user-1",
    ]);
    expect((await getUserById(ctx.db, "user-1"))?.permissions).toEqual(["seoops.view"]);
  });

  it("updates login counters and clears a lock after successful login", async () => {
    await recordLoginFailure(ctx.db, "user-1", "2026-08-24T00:15:00.000Z");
    await recordLoginFailure(ctx.db, "user-1", "2026-08-24T00:15:00.000Z");
    expect(await getUserById(ctx.db, "user-1")).toMatchObject({
      failedLoginCount: 2,
      lockedUntil: "2026-08-24T00:15:00.000Z",
    });

    await recordLoginSuccess(ctx.db, "user-1", "2026-08-24T00:01:00.000Z");
    expect(await getUserById(ctx.db, "user-1")).toMatchObject({
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: "2026-08-24T00:01:00.000Z",
    });
  });

  it("rejects unknown and privileged service permissions", () => {
    let unknownError: unknown;
    let serviceError: unknown;
    try {
      assertAllowedIdentityPermissions("HUMAN", ["*"]);
    } catch (error) {
      unknownError = error;
    }
    try {
      assertAllowedIdentityPermissions("SERVICE", ["seoops.view", "seoops.approve"]);
    } catch (error) {
      serviceError = error;
    }
    expect(unknownError).toMatchObject({ status: 400 });
    expect(serviceError).toMatchObject({ status: 400 });
    expect(() => assertAllowedIdentityPermissions("SERVICE", ["seoops.view", "seoops.manage"])).not.toThrow();
  });

  it("returns only active sessions and removes expired sessions", async () => {
    const active: SeoSession = {
      id: "session-active", userId: "user-1", tokenHash: "hash-active",
      expiresAt: "2026-08-25T00:00:00.000Z", revokedAt: null,
      createdAt: "2026-08-24T00:00:00.000Z", lastSeenAt: "2026-08-24T00:00:00.000Z",
    };
    const expired: SeoSession = {
      ...active, id: "session-expired", tokenHash: "hash-expired",
      expiresAt: "2026-08-23T00:00:00.000Z",
    };
    await insertSession(ctx.db, active);
    await insertSession(ctx.db, expired);

    expect(await getActiveSessionByHash(ctx.db, "hash-active", "2026-08-24T12:00:00.000Z")).toEqual(active);
    expect(await getActiveSessionByHash(ctx.db, "hash-expired", "2026-08-24T12:00:00.000Z")).toBeNull();

    await revokeSessionByHash(ctx.db, "hash-active", "2026-08-24T12:00:00.000Z");
    expect(await getActiveSessionByHash(ctx.db, "hash-active", "2026-08-24T12:00:01.000Z")).toBeNull();
    expect(await deleteExpiredSessions(ctx.db, "2026-08-24T12:00:00.000Z")).toBe(1);
  });
});

import type { Db } from "../db/connection.js";
import { getUserById, upsertUser } from "../repos/userRepo.js";
import { SEO_PERMISSIONS, type AuthActor } from "./types.js";

/** Reserved local-development identity used only when SEO_OPS_SINGLE_USER=true. */
export const SINGLE_USER_ACTOR: AuthActor = {
  userId: "single-user-admin",
  email: "admin@local",
  name: "本地管理员",
  role: "ADMIN",
  identityType: "HUMAN",
  permissions: [...SEO_PERMISSIONS],
  scopeAll: true,
};

/**
 * Merchant ownership is backed by seo_users even in single-user mode. Keep the
 * synthetic request actor and the persisted ownership identity in sync so
 * local onboarding follows the same data invariants as authenticated mode.
 */
export async function ensureSingleUserIdentity(db: Db): Promise<void> {
  const existing = await getUserById(db, SINGLE_USER_ACTOR.userId);
  const now = new Date().toISOString();
  await upsertUser(db, {
    id: SINGLE_USER_ACTOR.userId,
    email: SINGLE_USER_ACTOR.email,
    displayName: SINGLE_USER_ACTOR.name,
    role: SINGLE_USER_ACTOR.role,
    identityType: "HUMAN",
    permissions: [...SINGLE_USER_ACTOR.permissions],
    passwordHash: null,
    status: "ACTIVE",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: existing?.lastLoginAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { verifyPassword } from "../auth/password.js";
import type { AuthActor, SeoUser } from "../auth/types.js";
import type { ServerConfig } from "../config.js";
import type { Db } from "../db/connection.js";
import { ApiError } from "../errors.js";
import {
  getActiveSessionByHash,
  insertSession,
  revokeSessionByHash,
} from "../repos/sessionRepo.js";
import {
  getUserByEmail,
  getUserById,
  recordLoginFailure,
  recordLoginSuccess,
} from "../repos/userRepo.js";

const SESSION_TOKEN_BYTES = 32;
const LOCKOUT_AFTER_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const DUMMY_SCRYPT_HASH = "scrypt$16384$8$1$MDEyMzQ1Njc4OWFiY2RlZg$FDHUUDaRNNA-jxValD5um46wGIkhMNYiIRrLwU1OVqL-rhA8YHdJmOFFPP35oNsSEglPcGn2oAViIBWLiaRRyw";

function invalidCredentials(): ApiError {
  return new ApiError(401, "invalid credentials", "INVALID_CREDENTIALS");
}

/** Keep unknown-user verification on scrypt even for passwords outside the
 * account-password length policy, so that existence is not exposed by timing. */
function dummyPasswordCandidate(password: string): string {
  const characters = Array.from(password).slice(0, 128);
  while (characters.length < 12) characters.push("_");
  return characters.join("");
}

async function verifyDummyPassword(password: string): Promise<void> {
  await verifyPassword(dummyPasswordCandidate(password), DUMMY_SCRYPT_HASH);
}

function isActiveHuman(user: SeoUser): boolean {
  return user.identityType === "HUMAN" && user.status === "ACTIVE";
}

function isLocked(user: SeoUser, now: Date): boolean {
  return user.lockedUntil !== null && new Date(user.lockedUntil).getTime() > now.getTime();
}

function toActor(user: SeoUser): AuthActor {
  return {
    userId: user.id,
    email: user.email,
    name: user.displayName,
    role: user.role,
    identityType: user.identityType,
    permissions: user.permissions,
  };
}

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

export function sessionTokenHash(secret: string, rawToken: string): string {
  return createHmac("sha256", secret).update(rawToken).digest("hex");
}

export async function login(
  db: Db,
  input: { email: string; password: string },
  config: Pick<ServerConfig, "sessionSecret" | "sessionTtlHours">,
  now: Date,
): Promise<{ actor: AuthActor; rawToken: string; expiresAt: string }> {
  const user = await getUserByEmail(db, input.email);
  if (!user) {
    await verifyDummyPassword(input.password);
    throw invalidCredentials();
  }

  const passwordMatches = user.passwordHash
    ? await verifyPassword(input.password, user.passwordHash)
    : (await verifyDummyPassword(input.password), false);
  if (!isActiveHuman(user) || isLocked(user, now) || !passwordMatches) {
    if (!isLocked(user, now) && !passwordMatches) {
      const nextFailureCount = user.failedLoginCount + 1;
      const lockedUntil = nextFailureCount >= LOCKOUT_AFTER_FAILURES
        ? new Date(now.getTime() + LOCKOUT_MS).toISOString()
        : null;
      await recordLoginFailure(db, user.id, lockedUntil);
    }
    throw invalidCredentials();
  }

  const rawToken = createSessionToken();
  const expiresAt = new Date(now.getTime() + config.sessionTtlHours * 60 * 60 * 1000).toISOString();
  await insertSession(db, {
    id: randomUUID(),
    userId: user.id,
    tokenHash: sessionTokenHash(config.sessionSecret, rawToken),
    expiresAt,
    revokedAt: null,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
  });
  await recordLoginSuccess(db, user.id, now.toISOString());
  return { actor: toActor(user), rawToken, expiresAt };
}

export async function resolveActorFromToken(
  db: Db,
  rawToken: string,
  config: Pick<ServerConfig, "sessionSecret">,
  now = new Date(),
): Promise<AuthActor | null> {
  const tokenHash = sessionTokenHash(config.sessionSecret, rawToken);
  const session = await getActiveSessionByHash(db, tokenHash, now.toISOString());
  if (!session) return null;
  const user = await getUserById(db, session.userId);
  return user && isActiveHuman(user) ? toActor(user) : null;
}

export async function logout(
  db: Db,
  rawToken: string,
  config: Pick<ServerConfig, "sessionSecret">,
  now = new Date(),
): Promise<void> {
  await revokeSessionByHash(db, sessionTokenHash(config.sessionSecret, rawToken), now.toISOString());
}

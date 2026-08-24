import type { Db } from "../db/connection.js";
import {
  assertAllowedIdentityPermissions,
  isIdentityType,
  isSeoPermission,
  type SeoPermission,
  type SeoUser,
} from "../auth/types.js";

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  identity_type: string;
  permissions: string;
  password_hash: string | null;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase("en-US");
}

function parsePermissions(value: string): SeoPermission[] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const permissions: SeoPermission[] = [];
    for (const permission of parsed) {
      if (!isSeoPermission(permission)) return null;
      permissions.push(permission);
    }
    return permissions;
  } catch {
    return null;
  }
}

function toUser(row: UserRow): SeoUser | null {
  if (!isIdentityType(row.identity_type)) return null;
  const permissions = parsePermissions(row.permissions);
  if (!permissions) return null;
  try {
    assertAllowedIdentityPermissions(row.identity_type, permissions);
  } catch {
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    identityType: row.identity_type,
    permissions,
    passwordHash: row.password_hash,
    status: row.status,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getUserByEmail(db: Db, email: string): Promise<SeoUser | null> {
  const row = await db.one<UserRow>(`SELECT * FROM seo_users WHERE email = $1`, [normalizeEmail(email)]);
  return row ? toUser(row) : null;
}

export async function getUserById(db: Db, id: string): Promise<SeoUser | null> {
  const row = await db.one<UserRow>(`SELECT * FROM seo_users WHERE id = $1`, [id]);
  return row ? toUser(row) : null;
}

export async function upsertUser(db: Db, user: SeoUser): Promise<SeoUser> {
  assertAllowedIdentityPermissions(user.identityType, user.permissions);
  const row = await db.one<UserRow>(
    `INSERT INTO seo_users
      (id, email, display_name, role, identity_type, permissions, password_hash, status,
       failed_login_count, locked_until, last_login_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (email) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       role = EXCLUDED.role,
       identity_type = EXCLUDED.identity_type,
       permissions = EXCLUDED.permissions,
       password_hash = EXCLUDED.password_hash,
       status = EXCLUDED.status,
       failed_login_count = EXCLUDED.failed_login_count,
       locked_until = EXCLUDED.locked_until,
       last_login_at = EXCLUDED.last_login_at,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      user.id,
      normalizeEmail(user.email),
      user.displayName,
      user.role,
      user.identityType,
      JSON.stringify(user.permissions),
      user.passwordHash,
      user.status,
      user.failedLoginCount,
      user.lockedUntil,
      user.lastLoginAt,
      user.createdAt,
      user.updatedAt,
    ],
  );
  const mapped = row ? toUser(row) : null;
  if (!mapped) throw new Error("user upsert did not return a valid row");
  return mapped;
}

export async function recordLoginFailure(db: Db, id: string, lockedUntil: string | null): Promise<void> {
  await db.exec(
    `UPDATE seo_users
     SET failed_login_count = failed_login_count + 1, locked_until = $2, updated_at = CURRENT_TIMESTAMP::text
     WHERE id = $1`,
    [id, lockedUntil],
  );
}

export async function recordLoginSuccess(db: Db, id: string, at: string): Promise<void> {
  await db.exec(
    `UPDATE seo_users
     SET failed_login_count = 0, locked_until = NULL, last_login_at = $2, updated_at = $2
     WHERE id = $1`,
    [id, at],
  );
}

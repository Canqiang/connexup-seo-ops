import { badRequest } from "../errors.js";

export const SEO_PERMISSIONS = [
  "seoops.view",
  "seoops.manage",
  "seoops.approve",
  "seoops.execute",
  "seoops.capability.manage",
  "seoops.schedule.manage",
] as const;

export type SeoPermission = typeof SEO_PERMISSIONS[number];
export type IdentityType = "HUMAN" | "SERVICE";

export interface SeoUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  identityType: IdentityType;
  permissions: SeoPermission[];
  passwordHash: string | null;
  status: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuthActor {
  userId: string;
  email: string;
  name: string;
  role: string;
  identityType: IdentityType;
  permissions: SeoPermission[];
}

const SERVICE_FORBIDDEN = new Set<SeoPermission>([
  "seoops.approve",
  "seoops.execute",
  "seoops.capability.manage",
  "seoops.schedule.manage",
]);

export function isSeoPermission(value: unknown): value is SeoPermission {
  return typeof value === "string" && (SEO_PERMISSIONS as readonly string[]).includes(value);
}

/** Reject unknown/wildcard permission strings and privileged service identities. */
export function assertAllowedIdentityPermissions(
  identityType: IdentityType,
  permissions: readonly string[],
): asserts permissions is readonly SeoPermission[] {
  for (const permission of permissions) {
    if (!isSeoPermission(permission)) {
      throw badRequest(`unknown SEO permission: ${permission}`);
    }
    if (identityType === "SERVICE" && SERVICE_FORBIDDEN.has(permission)) {
      throw badRequest(`SERVICE identities cannot hold ${permission}`);
    }
  }
}

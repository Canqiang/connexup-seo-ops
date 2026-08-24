import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertAllowedIdentityPermissions, isSeoPermission, type SeoPermission } from "../src/auth/types.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { replaceMerchantOperatorId } from "../src/repos/merchantRepo.js";
import { upsertUser } from "../src/repos/userRepo.js";

export interface BootstrapArgs {
  email: string;
  name: string;
  role: string;
  permissions: readonly SeoPermission[];
  claimLocalDevMerchants: boolean;
}

export interface BootstrapEnv {
  SEO_OPS_BOOTSTRAP_PASSWORD?: string;
}

export interface BootstrapOutput {
  id: string;
  email: string;
  role: string;
  permissions: SeoPermission[];
  claimedMerchantCount: number;
}

function requiredValue(args: string[], flag: string): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePermissions(value: string): SeoPermission[] {
  const permissions = value.split(",").map((permission) => permission.trim()).filter(Boolean);
  if (permissions.length === 0 || permissions.some((permission) => !isSeoPermission(permission))) {
    throw new Error("permissions must be comma-separated exact SEO permission codes");
  }
  return [...new Set(permissions)];
}

/** The CLI intentionally provisions HUMAN identities only; SERVICE identities
 * require a separate, non-password bootstrap path. */
export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  const remaining = [...argv];
  let email: string | undefined;
  let name: string | undefined;
  let role: string | undefined;
  let permissions: SeoPermission[] | undefined;
  let claimLocalDevMerchants = false;

  while (remaining.length > 0) {
    const argument = remaining.shift();
    switch (argument) {
      case "--email": email = requiredValue(remaining, argument); break;
      case "--name": name = requiredValue(remaining, argument); break;
      case "--role": role = requiredValue(remaining, argument); break;
      case "--permissions": permissions = parsePermissions(requiredValue(remaining, argument)); break;
      case "--claim-local-dev-merchants": claimLocalDevMerchants = true; break;
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!email || !name || !role || !permissions) {
    throw new Error("--email, --name, --role, and --permissions are required");
  }
  return { email, name, role, permissions, claimLocalDevMerchants };
}

export async function runBootstrap(
  args: BootstrapArgs,
  env: BootstrapEnv,
  db: Db,
): Promise<BootstrapOutput> {
  const password = env.SEO_OPS_BOOTSTRAP_PASSWORD;
  if (!password) throw new Error("SEO_OPS_BOOTSTRAP_PASSWORD is required");

  const normalizedEmail = args.email.trim().toLocaleLowerCase("en-US");
  if (!normalizedEmail || !args.name.trim() || !args.role.trim()) {
    throw new Error("email, name, and role must not be empty");
  }
  const permissions = [...args.permissions];
  assertAllowedIdentityPermissions("HUMAN", permissions);
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const user = await upsertUser(db, {
    id: randomUUID(),
    email: normalizedEmail,
    displayName: args.name.trim(),
    role: args.role.trim(),
    identityType: "HUMAN",
    permissions,
    passwordHash,
    status: "ACTIVE",
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  });
  const claimedMerchantCount = args.claimLocalDevMerchants
    ? await replaceMerchantOperatorId(db, "local-dev", user.id)
    : 0;
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    claimedMerchantCount,
  };
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const db = createDb(databaseUrl);
  try {
    await migrate(db);
    const output = await runBootstrap(parseBootstrapArgs(process.argv.slice(2)), process.env, db);
    console.log(JSON.stringify(output));
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "bootstrap failed");
    process.exitCode = 1;
  });
}

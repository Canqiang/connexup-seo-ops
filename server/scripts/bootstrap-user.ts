import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { assertAllowedIdentityPermissions, isSeoPermission, type SeoPermission } from "../src/auth/types.js";
import { hashPassword } from "../src/auth/password.js";
import { createDb, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import {
  assignMerchantOperatorIdsInTransaction,
  replaceMerchantOperatorIdInTransaction,
} from "../src/repos/merchantRepo.js";
import { upsertUser } from "../src/repos/userRepo.js";

export interface BootstrapArgs {
  email: string;
  name: string;
  role: string;
  permissions: readonly SeoPermission[];
  claimLocalDevMerchants: boolean;
  merchantIds: readonly string[];
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
  assignedMerchantCount: number;
}

export const DEFAULT_DATABASE_URL = "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev";
const PREFLIGHT_FAILURE = "bootstrap preflight failed";

export interface BootstrapCliDeps {
  createDb(databaseUrl: string): Db;
  migrate(db: Db): Promise<void>;
  writeStdout(line: string): void;
  writeStderr(line: string): void;
}

class BootstrapPreflightError extends Error {
  constructor() {
    super(PREFLIGHT_FAILURE);
  }
}

function requiredValue(args: string[]): string {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(PREFLIGHT_FAILURE);
  return value;
}

function parsePermissions(value: string): SeoPermission[] {
  const permissions = value.split(",").map((permission) => permission.trim()).filter(Boolean);
  if (permissions.length === 0 || permissions.some((permission) => !isSeoPermission(permission))) {
    throw new Error(PREFLIGHT_FAILURE);
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
  const merchantIds: string[] = [];

  while (remaining.length > 0) {
    const argument = remaining.shift();
    switch (argument) {
      case "--email": email = requiredValue(remaining); break;
      case "--name": name = requiredValue(remaining); break;
      case "--role": role = requiredValue(remaining); break;
      case "--permissions": permissions = parsePermissions(requiredValue(remaining)); break;
      case "--claim-local-dev-merchants": claimLocalDevMerchants = true; break;
      case "--merchant-id": merchantIds.push(requiredValue(remaining)); break;
      default: throw new Error(PREFLIGHT_FAILURE);
    }
  }

  if (!email || !name || !role || !permissions) {
    throw new Error(PREFLIGHT_FAILURE);
  }
  return { email, name, role, permissions, claimLocalDevMerchants, merchantIds: [...new Set(merchantIds)] };
}

interface ValidatedBootstrapInput {
  email: string;
  name: string;
  role: string;
  permissions: SeoPermission[];
  merchantIds: string[];
  password: string;
}

/** Pure, pre-database validation. Password values retain whitespace exactly as
 * supplied because they are credentials, while identity fields are trimmed. */
export function validateBootstrapInput(args: BootstrapArgs, env: BootstrapEnv): ValidatedBootstrapInput {
  const password = env.SEO_OPS_BOOTSTRAP_PASSWORD;
  if (!password) throw new Error("SEO_OPS_BOOTSTRAP_PASSWORD is required");

  const email = args.email.trim().toLocaleLowerCase("en-US");
  const name = args.name.trim();
  const role = args.role.trim();
  const permissions = [...args.permissions];
  const merchantIds = [...new Set(args.merchantIds.map((id) => id.trim()))];
  if (!email || !name || !role) throw new Error("email, name, and role must not be empty");
  if (merchantIds.some((id) => !id)) throw new Error("merchant ids must not be empty");
  if (permissions.length === 0 || permissions.some((permission) => !isSeoPermission(permission))) {
    throw new Error("permissions must be exact SEO permission codes");
  }
  try {
    assertAllowedIdentityPermissions("HUMAN", permissions);
  } catch {
    throw new Error("permissions must be exact SEO permission codes");
  }
  return { email, name, role, permissions: [...new Set(permissions)], merchantIds, password };
}

export async function runBootstrap(
  args: BootstrapArgs,
  env: BootstrapEnv,
  db: Db,
): Promise<BootstrapOutput> {
  const input = validateBootstrapInput(args, env);
  const passwordHash = await hashPassword(input.password);
  const now = new Date().toISOString();
  const { user, claimedMerchantCount, assignedMerchantCount } = await db.withTransaction(async (tx) => {
    const user = await upsertUser(tx, {
      id: randomUUID(),
      email: input.email,
      displayName: input.name,
      role: input.role,
      identityType: "HUMAN",
      permissions: input.permissions,
      passwordHash,
      status: "ACTIVE",
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const claimedMerchantCount = args.claimLocalDevMerchants
      ? await replaceMerchantOperatorIdInTransaction(tx, "local-dev", user.id)
      : 0;
    const assignedMerchantCount = await assignMerchantOperatorIdsInTransaction(tx, input.merchantIds, user.id);
    return { user, claimedMerchantCount, assignedMerchantCount };
  });
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    claimedMerchantCount,
    assignedMerchantCount,
  };
}

export async function runCli(
  argv: string[],
  env: BootstrapEnv & Pick<NodeJS.ProcessEnv, "DATABASE_URL">,
  deps: BootstrapCliDeps,
): Promise<BootstrapOutput> {
  let args: BootstrapArgs;
  try {
    args = parseBootstrapArgs(argv);
    validateBootstrapInput(args, env);
  } catch {
    deps.writeStderr(PREFLIGHT_FAILURE);
    throw new BootstrapPreflightError();
  }

  const db = deps.createDb(env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    await deps.migrate(db);
    const output = await runBootstrap(args, env, db);
    deps.writeStdout(JSON.stringify(output));
    return output;
  } finally {
    await db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2), process.env, {
    createDb,
    migrate,
    writeStdout: (line) => console.log(line),
    writeStderr: (line) => console.error(line),
  }).catch((error: unknown) => {
    if (!(error instanceof BootstrapPreflightError)) console.error("bootstrap failed");
    process.exitCode = 1;
  });
}

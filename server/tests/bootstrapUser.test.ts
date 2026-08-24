import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBootstrapArgs, runBootstrap, runCli } from "../scripts/bootstrap-user.js";
import { migrate } from "../src/db/migrate.js";
import { getMerchant, insertMerchant, replaceMerchantOperatorId } from "../src/repos/merchantRepo.js";
import { getUserByEmail, upsertUser } from "../src/repos/userRepo.js";
import { createTestDb } from "./helpers/pgTest.js";
import type { Db } from "../src/db/connection.js";
import type { SeoUser } from "../src/auth/types.js";

const ctx = await createTestDb();
beforeAll(() => migrate(ctx.db));
afterAll(() => ctx.teardown());

const args = {
  email: "  Operator@Example.COM ",
  name: "SEO Operator",
  role: "seo_lead",
  permissions: ["seoops.view", "seoops.manage"] as const,
  claimLocalDevMerchants: false,
};

const validCliArgv = [
  "--email", "operator@example.com", "--name", "Operator", "--role", "seo_lead",
  "--permissions", "seoops.view,seoops.manage",
];

async function preflightFailure(
  argv: string[],
  env: Record<string, string | undefined> = { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" },
): Promise<{ error: string; stdout: string[]; stderr: string[]; createDbCalls: number; migrateCalls: number }> {
  let createDbCalls = 0;
  let migrateCalls = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  let error = "";
  try {
    await runCli(argv, env, {
      createDb: () => {
        createDbCalls += 1;
        throw new Error("database must not be created during preflight");
      },
      migrate: async () => { migrateCalls += 1; },
      writeStdout: (line) => stdout.push(line),
      writeStderr: (line) => stderr.push(line),
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { error, stdout, stderr, createDbCalls, migrateCalls };
}

describe("user bootstrap", () => {
  it("fails before a database mutation when SEO_OPS_BOOTSTRAP_PASSWORD is missing", async () => {
    await expect(runBootstrap(args, {}, ctx.db)).rejects.toThrow("SEO_OPS_BOOTSTRAP_PASSWORD is required");
    expect(await getUserByEmail(ctx.db, "operator@example.com")).toBeNull();
  });

  it("normalizes email and idempotently updates the same HUMAN user", async () => {
    const env = { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" };
    const first = await runBootstrap(args, env, ctx.db);
    const second = await runBootstrap({ ...args, name: "Updated Operator" }, env, ctx.db);

    expect(first).toMatchObject({
      email: "operator@example.com",
      role: "seo_lead",
      permissions: ["seoops.view", "seoops.manage"],
      claimedMerchantCount: 0,
    });
    expect(second.id).toBe(first.id);
    expect(await getUserByEmail(ctx.db, " OPERATOR@example.com ")).toMatchObject({
      id: first.id,
      displayName: "Updated Operator",
      identityType: "HUMAN",
    });
    expect(await ctx.db.query<{ count: string }>("SELECT count(*)::text AS count FROM seo_users WHERE email = $1", ["operator@example.com"])).toEqual([{ count: "1" }]);
  });

  it("claims only exact local-dev membership when explicitly requested", async () => {
    await insertMerchant(ctx.db, {
      id: "merchant-claimable",
      slug: "claimable",
      displayName: "Claimable",
      tags: [],
      operatorUserIds: ["local-dev", "operator-existing", "local-dev"],
      creationIdempotencyKey: null,
      requestFingerprint: null,
      createdBy: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });
    const beforeClaim = await getMerchant(ctx.db, "merchant-claimable");
    await insertMerchant(ctx.db, {
      id: "merchant-unaffected",
      slug: "unaffected",
      displayName: "Unaffected",
      tags: [],
      operatorUserIds: ["local-dev-2", "operator-existing"],
      creationIdempotencyKey: null,
      requestFingerprint: null,
      createdBy: null,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    });

    const result = await runBootstrap(
      { ...args, claimLocalDevMerchants: true },
      { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" },
      ctx.db,
    );
    const rerun = await runBootstrap(
      { ...args, claimLocalDevMerchants: true },
      { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" },
      ctx.db,
    );

    expect(result.claimedMerchantCount).toBe(1);
    expect(rerun.claimedMerchantCount).toBe(0);
    expect((await getMerchant(ctx.db, "merchant-claimable"))?.operatorUserIds).toEqual([
      result.id, "operator-existing",
    ]);
    expect((await getMerchant(ctx.db, "merchant-claimable"))?.updatedAt).not.toBe(beforeClaim?.updatedAt);
    expect((await getMerchant(ctx.db, "merchant-unaffected"))?.operatorUserIds).toEqual([
      "local-dev-2", "operator-existing",
    ]);
  });

  it("returns and accepts no password, password hash, or session data", async () => {
    const result = await runBootstrap(args, { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" }, ctx.db);
    expect(JSON.stringify(result)).not.toMatch(/password|hash|session|correct horse/i);
    expect(() => parseBootstrapArgs([
      "--email", "operator@example.com", "--name", "Operator", "--role", "seo_lead",
      "--permissions", "seoops.view", "--password", "not-allowed",
    ])).toThrow("bootstrap preflight failed");
  });

  it.each([
    ["missing required argument", ["--email", "operator@example.com"], undefined],
    ["unknown arbitrary argument", [...validCliArgv, "--flag=SENTINEL"], "SENTINEL"],
    ["split password argument", [...validCliArgv, "--password", "SENTINEL"], "SENTINEL"],
    ["equals password argument", [...validCliArgv, "--password=SENTINEL"], "SENTINEL"],
    ["mixed-case password argument", [...validCliArgv, "--PassWord=SENTINEL"], "SENTINEL"],
    ["empty trimmed field", [...validCliArgv.slice(0, 2), "--name", "   ", "--role", "seo_lead", "--permissions", "seoops.view"], undefined],
    ["invalid permission", [...validCliArgv.slice(0, 6), "--permissions", "seoops.view,SENTINEL"], "SENTINEL"],
    ["missing bootstrap environment password", validCliArgv, undefined, {}],
  ])("runs %s entirely before database initialization", async (_label, argv, sentinel, env) => {
    const result = await preflightFailure(argv, env ?? undefined);
    const visible = [result.error, ...result.stdout, ...result.stderr].join("\n");
    expect(result.createDbCalls).toBe(0);
    expect(result.migrateCalls).toBe(0);
    expect(result.stdout).toEqual([]);
    expect(result.stderr).toEqual(["bootstrap preflight failed"]);
    if (sentinel) expect(visible).not.toContain(sentinel);
  });

  it("uses the server configuration database fallback after preflight", async () => {
    let databaseUrl: string | undefined;
    let closed = false;
    const db = { close: async () => { closed = true; } };
    await expect(runCli(validCliArgv, { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" }, {
      createDb: (url) => {
        databaseUrl = url;
        return db as never;
      },
      migrate: async () => { throw new Error("migration stopped for test"); },
      writeStdout: () => undefined,
      writeStderr: () => undefined,
    })).rejects.toThrow("migration stopped for test");
    expect(databaseUrl).toBe("postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev");
    expect(closed).toBe(true);
  });

  it("rejects malformed operator JSON and rolls back an earlier valid claim", async () => {
    const isolated = await createTestDb();
    try {
      await migrate(isolated.db);
      await insertMerchant(isolated.db, {
        id: "merchant-rollback-claimable", slug: "rollback-claimable", displayName: "Rollback claimable",
        tags: [], operatorUserIds: ["local-dev", "other"], creationIdempotencyKey: null,
        requestFingerprint: null, createdBy: null, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
      });
      await isolated.db.exec(
        `INSERT INTO seo_merchants (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["merchant-rollback-malformed", "rollback-malformed", "Rollback malformed", "[]", "", "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z"],
      );

      await expect(replaceMerchantOperatorId(isolated.db, "local-dev", "new-operator")).rejects.toThrow(/invalid operator_user_ids/);
      expect((await getMerchant(isolated.db, "merchant-rollback-claimable"))?.operatorUserIds).toEqual(["local-dev", "other"]);
    } finally {
      await isolated.teardown();
    }
  });

  it.each(["", "not-json", JSON.stringify("prefix-local-dev-suffix"), JSON.stringify({ ids: ["local-dev"] }), JSON.stringify(["local-dev", 7])])(
    "rejects non-string operator list encoding %j", async (operatorUserIds) => {
      const isolated = await createTestDb();
      try {
        await migrate(isolated.db);
        await isolated.db.exec(
          `INSERT INTO seo_merchants (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          ["merchant-invalid-list", "invalid-list", "Invalid list", "[]", operatorUserIds, "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z"],
        );
        await expect(replaceMerchantOperatorId(isolated.db, "local-dev", "new-operator")).rejects.toThrow(/invalid operator_user_ids/);
      } finally {
        await isolated.teardown();
      }
    },
  );

  it("locks operator rows while replacing the legacy marker", async () => {
    let selectText = "";
    const tx = {
      query: async <T>(text: string): Promise<T[]> => {
        selectText = text;
        return [{ id: "merchant-lock", operator_user_ids: JSON.stringify(["local-dev", "other"]) }] as T[];
      },
      exec: async () => 1,
    };
    const db = {
      withTransaction: async <T>(fn: (transaction: Db) => Promise<T>) => fn(tx as never),
    } as Db;

    await expect(replaceMerchantOperatorId(db, "local-dev", "new-operator")).resolves.toBe(1);
    expect(selectText).toMatch(/FOR UPDATE/);
  });

  it("rolls back every user and merchant write when a legacy claim is malformed", async () => {
    const isolated = await createTestDb();
    try {
      await migrate(isolated.db);
      const originalUser: SeoUser = {
        id: "atomic-existing-user",
        email: "atomic@example.com",
        displayName: "Original Operator",
        role: "viewer",
        identityType: "HUMAN",
        permissions: ["seoops.view"],
        passwordHash: "existing-password-hash",
        status: "SUSPENDED",
        failedLoginCount: 4,
        lockedUntil: "2026-08-25T00:00:00.000Z",
        lastLoginAt: "2026-08-23T00:00:00.000Z",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-23T00:00:00.000Z",
      };
      await upsertUser(isolated.db, originalUser);
      await insertMerchant(isolated.db, {
        id: "atomic-a-claimable", slug: "atomic-claimable", displayName: "Atomic claimable",
        tags: [], operatorUserIds: ["local-dev", "other-operator"], creationIdempotencyKey: null,
        requestFingerprint: null, createdBy: null, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
      });
      await isolated.db.exec(
        `INSERT INTO seo_merchants (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ["atomic-z-malformed", "atomic-malformed", "Atomic malformed", "[]", "not-json", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z"],
      );
      const beforeUser = await getUserByEmail(isolated.db, originalUser.email);
      const beforeMerchants = await isolated.db.query<{ id: string; operator_user_ids: string; updated_at: string }>(
        `SELECT id, operator_user_ids, updated_at FROM seo_merchants ORDER BY id`,
      );

      await expect(runBootstrap(
        { ...args, email: originalUser.email, name: "Replacement Operator", role: "admin", permissions: ["seoops.manage"], claimLocalDevMerchants: true },
        { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" },
        isolated.db,
      )).rejects.toThrow(/invalid operator_user_ids/);

      expect(await getUserByEmail(isolated.db, originalUser.email)).toEqual(beforeUser);
      expect(await isolated.db.query<{ id: string; operator_user_ids: string; updated_at: string }>(
        `SELECT id, operator_user_ids, updated_at FROM seo_merchants ORDER BY id`,
      )).toEqual(beforeMerchants);
    } finally {
      await isolated.teardown();
    }
  });

  it("commits user upsert and exact legacy claim together, then remains idempotent", async () => {
    const isolated = await createTestDb();
    try {
      await migrate(isolated.db);
      await insertMerchant(isolated.db, {
        id: "atomic-success-claimable", slug: "atomic-success-claimable", displayName: "Atomic success",
        tags: [], operatorUserIds: ["local-dev", "other-operator", "local-dev"], creationIdempotencyKey: null,
        requestFingerprint: null, createdBy: null, createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z",
      });
      const bootstrapArgs = { ...args, email: "atomic-success@example.com", claimLocalDevMerchants: true };
      const env = { SEO_OPS_BOOTSTRAP_PASSWORD: "correct horse battery staple" };

      const first = await runBootstrap(bootstrapArgs, env, isolated.db);
      const second = await runBootstrap(bootstrapArgs, env, isolated.db);

      expect(first.claimedMerchantCount).toBe(1);
      expect(second).toMatchObject({ id: first.id, claimedMerchantCount: 0 });
      expect(await getUserByEmail(isolated.db, bootstrapArgs.email)).toMatchObject({ id: first.id, status: "ACTIVE" });
      expect((await getMerchant(isolated.db, "atomic-success-claimable"))?.operatorUserIds).toEqual([
        first.id, "other-operator",
      ]);
    } finally {
      await isolated.teardown();
    }
  });
});

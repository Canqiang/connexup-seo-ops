import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBootstrapArgs, runBootstrap } from "../scripts/bootstrap-user.js";
import { migrate } from "../src/db/migrate.js";
import { getMerchant, insertMerchant } from "../src/repos/merchantRepo.js";
import { getUserByEmail } from "../src/repos/userRepo.js";
import { createTestDb } from "./helpers/pgTest.js";

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
    ])).toThrow(/unknown argument: --password/);
  });
});

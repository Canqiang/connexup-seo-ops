import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { getMerchant, listMerchantsForOperator } from "../src/repos/merchantRepo.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
beforeAll(() => migrate(ctx.db));
afterAll(() => ctx.teardown());

async function insertRawMerchant(id: string, operatorUserIds: string): Promise<void> {
  await ctx.db.exec(
    `INSERT INTO seo_merchants
       (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, id, id, "[]", operatorUserIds, "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z"],
  );
}

describe("merchant operator decoding", () => {
  it.each([
    ["JSON string", JSON.stringify("prefix-op-1-suffix")],
    ["object", JSON.stringify({ operator: "op-1" })],
    ["mixed array", JSON.stringify(["op-1", 7])],
    ["invalid JSON", "not-json"],
  ])("fails closed at runtime for a %s", async (label, encoded) => {
    const id = `malformed-${label.replaceAll(" ", "-")}`;
    await insertRawMerchant(id, encoded);

    expect((await getMerchant(ctx.db, id))?.operatorUserIds).toEqual([]);
    expect((await listMerchantsForOperator(ctx.db, "op-1")).map((merchant) => merchant.id)).not.toContain(id);
  });

  it("deduplicates a valid string array and keeps exact membership", async () => {
    await insertRawMerchant("valid-operators", JSON.stringify(["op-1", "op-1", "prefix-op-1-suffix"]));

    expect((await getMerchant(ctx.db, "valid-operators"))?.operatorUserIds).toEqual([
      "op-1",
      "prefix-op-1-suffix",
    ]);
    expect((await listMerchantsForOperator(ctx.db, "op-1")).map((merchant) => merchant.id)).toContain("valid-operators");
    expect((await listMerchantsForOperator(ctx.db, "op")).map((merchant) => merchant.id)).not.toContain("valid-operators");
  });
});

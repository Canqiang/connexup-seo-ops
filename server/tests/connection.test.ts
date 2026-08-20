import { afterAll, describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src/db/connection.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
afterAll(() => ctx.teardown());

describe("pg connection", () => {
  it("queries inside the isolated schema", async () => {
    await ctx.db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    await ctx.db.exec(`INSERT INTO t (id) VALUES ($1)`, ["a"]);
    expect(await ctx.db.one<{ id: string }>(`SELECT id FROM t WHERE id = $1`, ["a"])).toEqual({ id: "a" });
    expect(await ctx.db.query(`SELECT id FROM t`)).toHaveLength(1);
  });

  it("withTransaction rolls back on throw", async () => {
    await ctx.db.exec(`CREATE TABLE tx (id TEXT PRIMARY KEY)`);
    await expect(
      ctx.db.withTransaction(async (tx) => {
        await tx.exec(`INSERT INTO tx (id) VALUES ('x')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await ctx.db.query(`SELECT * FROM tx`)).toHaveLength(0);
  });

  it("detects unique violations by PG error code", async () => {
    await ctx.db.exec(`CREATE TABLE u (id TEXT PRIMARY KEY)`);
    await ctx.db.exec(`INSERT INTO u (id) VALUES ('a')`);
    const error = await ctx.db.exec(`INSERT INTO u (id) VALUES ('a')`).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });
});

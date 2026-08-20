import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
afterAll(() => ctx.teardown());

describe("migrate on postgres", () => {
  it("creates all tables and is idempotent", async () => {
    await migrate(ctx.db);
    await migrate(ctx.db); // 幂等:第二次不抛
    const tables = await ctx.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [ctx.schema],
    );
    const names = tables.map((t) => t.table_name).sort();
    for (const expected of [
      "seo_merchants",
      "seo_locations",
      "seo_tasks",
      "seo_agent_runs",
      "seo_run_deliverables",
      "seo_merchant_questionnaires",
    ]) {
      expect(names).toContain(expected);
    }
    // 增量列迁移生效
    const cols = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'seo_tasks'`,
      [ctx.schema],
    );
    expect(cols.map((c) => c.column_name)).toContain("mutation_keys");
  });
});

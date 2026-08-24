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
      "seo_users",
      "seo_sessions",
    ]) {
      expect(names).toContain(expected);
    }
    // 增量列迁移生效
    const cols = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'seo_tasks'`,
      [ctx.schema],
    );
    expect(cols.map((c) => c.column_name)).toContain("mutation_keys");

    const checks = await ctx.db.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = 'seo_users' AND c.contype = 'c'`,
      [ctx.schema],
    );
    expect(checks.some(({ definition }) =>
      definition.includes("identity_type") && definition.includes("HUMAN") && definition.includes("SERVICE"),
    )).toBe(true);
  });

  it("upgrades an existing seo_users table with an idempotent identity-type check", async () => {
    const legacy = await createTestDb();
    try {
      await legacy.db.exec(`CREATE TABLE seo_users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        identity_type TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '[]',
        password_hash TEXT,
        status TEXT NOT NULL,
        failed_login_count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      await migrate(legacy.db);
      await migrate(legacy.db);

      await expect(legacy.db.exec(
        `INSERT INTO seo_users
          (id, email, display_name, role, identity_type, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          "legacy-user", "legacy@example.com", "Legacy", "seo_lead", "MACHINE", "ACTIVE",
          "2026-08-24T00:00:00.000Z", "2026-08-24T00:00:00.000Z",
        ],
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await legacy.teardown();
    }
  });

  it("adds nullable last_sent_by to an existing questionnaire table idempotently", async () => {
    const legacy = await createTestDb();
    try {
      await legacy.db.exec(`CREATE TABLE seo_merchant_questionnaires (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        share_slug TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        base_info TEXT NOT NULL DEFAULT '{}',
        questions TEXT NOT NULL DEFAULT '[]',
        answers TEXT,
        send_count INTEGER NOT NULL DEFAULT 0,
        sent_at TEXT,
        last_sent_at TEXT,
        filled_at TEXT,
        creation_idempotency_key TEXT,
        request_fingerprint TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);

      await migrate(legacy.db);
      await migrate(legacy.db);

      const columns = await legacy.db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'seo_merchant_questionnaires'`,
        [legacy.schema],
      );
      expect(columns).toContainEqual({ column_name: "last_sent_by", is_nullable: "YES" });
    } finally {
      await legacy.teardown();
    }
  });
});

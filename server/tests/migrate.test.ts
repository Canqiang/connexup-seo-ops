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

  it("adds agent_run_id before creating the dependent draft uniqueness index", async () => {
    const legacy = await createTestDb();
    try {
      await legacy.db.exec(`CREATE TABLE seo_content_drafts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        source TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, version)
      )`);

      await migrate(legacy.db);
      await migrate(legacy.db);

      const columns = await legacy.db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'seo_content_drafts'`,
        [legacy.schema],
      );
      expect(columns).toContainEqual({ column_name: "agent_run_id", is_nullable: "YES" });

      const insert = async (id: string, version: number, agentRunId: string | null) => legacy.db.exec(
        `INSERT INTO seo_content_drafts
           (id, task_id, version, source, body, agent_run_id, created_at)
         VALUES ($1, 'legacy-task', $2, 'AGENT_GENERATED', '{}', $3, '2026-08-27T00:00:00.000Z')`,
        [id, version, agentRunId],
      );
      await insert("legacy-null-1", 1, null);
      await insert("legacy-null-2", 2, null);
      await insert("legacy-agent-1", 3, "agent-run-1");
      await expect(insert("legacy-agent-2", 4, "agent-run-1"))
        .rejects.toMatchObject({ code: "23505" });
    } finally {
      await legacy.teardown();
    }
  });

  it("upgrades legacy specialist artifacts with durable constrained acceptance state", async () => {
    const legacy = await createTestDb();
    try {
      await legacy.db.exec(`CREATE TABLE seo_specialist_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload TEXT NOT NULL,
        core_run_id TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(core_run_id, artifact_type)
      )`);
      await legacy.db.exec(`INSERT INTO seo_specialist_artifacts
        (id, task_id, merchant_id, artifact_type, schema_version, title, summary,
         payload, core_run_id, created_at)
        VALUES ('legacy-artifact', 'task-1', 'merchant-1', 'AUDIT_REPORT', 'v1',
                'Legacy', 'Legacy artifact', '{}', 'legacy-run',
                '2026-08-27T00:00:00.000Z')`);

      await migrate(legacy.db);
      await migrate(legacy.db);

      const row = await legacy.db.one<{
        acceptance_status: string;
        acceptance_decided_by: string | null;
        acceptance_decided_at: string | null;
        acceptance_note: string | null;
      }>(`SELECT acceptance_status, acceptance_decided_by,
                 acceptance_decided_at, acceptance_note
            FROM seo_specialist_artifacts WHERE id = 'legacy-artifact'`);
      expect(row).toEqual({
        acceptance_status: "PENDING",
        acceptance_decided_by: null,
        acceptance_decided_at: null,
        acceptance_note: null,
      });
      await expect(legacy.db.exec(
        `UPDATE seo_specialist_artifacts SET acceptance_status = 'PUBLISHED'
         WHERE id = 'legacy-artifact'`,
      )).rejects.toMatchObject({ code: "23514" });
    } finally {
      await legacy.teardown();
    }
  });
});

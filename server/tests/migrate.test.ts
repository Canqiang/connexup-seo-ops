import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { insertAgentRun } from "../src/repos/agentRunRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";
import { createTestDb } from "./helpers/pgTest.js";
import type { Db } from "../src/db/connection.js";

const ctx = await createTestDb();
afterAll(() => ctx.teardown());

function legacyGbpRun(overrides: Partial<AgentRun> & Pick<AgentRun, "id">): AgentRun {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    id: overrides.id,
    merchantId: "legacy-gbp-merchant",
    locationId: "legacy-gbp-location",
    stage: "GBP_POST_CONTENT",
    taskId: "legacy-gbp-task",
    runType: "GBP_POST_CONTENT",
    goal: null,
    status: "FAILED",
    coreRunId: null,
    traceRef: null,
    coreStatus: null,
    inputMessage: "{}",
    output: null,
    error: "legacy failure",
    errorCode: "TRIGGER_FAILED",
    tokenUsage: {},
    triggeredBy: "legacy-operator",
    triggeredAt: now,
    lastPolledAt: null,
    completedAt: now,
    creationIdempotencyKey: `${overrides.id}-key`,
    requestFingerprint: `sha256:generation-${overrides.id}`,
    httpRequestFingerprint: `sha256:legacy-http-${overrides.id}`,
    businessInputFingerprint: "sha256:legacy-business",
    retryOfAgentRunId: null,
    retryGeneration: 0,
    retryReason: null,
    createdBy: "legacy-operator",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function insertTaskScope(
  db: Db,
  overrides: { id?: string; merchantId?: string; locationId?: string | null } = {},
): Promise<void> {
  const now = "2026-08-26T00:00:00.000Z";
  await db.exec(
    `INSERT INTO seo_tasks
      (id, merchant_id, location_id, task_type, source, priority, impact,
       status, evidence_state, task_revision, state_version, title,
       execution_spec, execution_spec_hash, created_at, updated_at)
     VALUES ($1, $2, $3, 'GBP_POST', 'CYCLE', 'HIGH', 'HIGH',
             'DRAFT', 'MISSING', 1, 1, 'Legacy GBP Task', '{}',
             'sha256:legacy-task-spec', $4, $4)`,
    [
      overrides.id ?? "legacy-gbp-task",
      overrides.merchantId ?? "legacy-gbp-merchant",
      overrides.locationId === undefined ? "legacy-gbp-location" : overrides.locationId,
      now,
    ],
  );
}

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
      "seo_agent_run_requests",
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

  it("backfills durable HTTP idempotency aliases for legacy Agent Runs", async () => {
    const legacy = await createTestDb();
    try {
      await legacy.db.exec(`CREATE TABLE seo_agent_runs (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        task_id TEXT,
        status TEXT NOT NULL,
        creation_idempotency_key TEXT,
        request_fingerprint TEXT,
        created_at TEXT NOT NULL
      )`);
      await legacy.db.exec(
        `INSERT INTO seo_agent_runs
          (id, merchant_id, stage, status, creation_idempotency_key,
           request_fingerprint, created_at)
         VALUES ('legacy-run', 'merchant-1', 'KEYWORDS', 'COMPLETED',
                 'legacy-request-key', 'sha256:legacy-http-request',
                 '2026-08-26T00:00:00.000Z')`,
      );

      await migrate(legacy.db);
      await migrate(legacy.db);

      expect(await legacy.db.one(
        `SELECT idempotency_key, run_id, merchant_id, http_request_fingerprint,
                semantics_version
           FROM seo_agent_run_requests
          WHERE idempotency_key = 'legacy-request-key'`,
      )).toEqual({
        idempotency_key: "legacy-request-key",
        run_id: "legacy-run",
        merchant_id: "merchant-1",
        http_request_fingerprint: "sha256:legacy-http-request",
        semantics_version: "STRICT_CURRENT",
      });
    } finally {
      await legacy.teardown();
    }
  });

  it("rebuilds legacy GBP route fingerprints and recursively derives retry generations", async () => {
    const legacy = await createTestDb();
    try {
      // Real pre-generation/http-identity table shape: retry parent/reason was
      // persisted, but the round-4/5 columns do not exist yet.
      await legacy.db.exec(`CREATE TABLE seo_agent_runs (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        location_id TEXT,
        stage TEXT NOT NULL,
        task_id TEXT,
        run_type TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL,
        core_run_id TEXT,
        trace_ref TEXT,
        core_status TEXT,
        input_message TEXT NOT NULL,
        output TEXT,
        error TEXT,
        error_code TEXT,
        token_usage TEXT NOT NULL DEFAULT '{}',
        triggered_by TEXT NOT NULL,
        triggered_at TEXT NOT NULL,
        last_polled_at TEXT,
        completed_at TEXT,
        creation_idempotency_key TEXT,
        request_fingerprint TEXT,
        business_input_fingerprint TEXT,
        retry_of_agent_run_id TEXT,
        retry_reason TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await legacy.db.exec(`CREATE TABLE seo_tasks (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        location_id TEXT,
        task_type TEXT NOT NULL,
        source TEXT NOT NULL,
        priority TEXT NOT NULL,
        impact TEXT NOT NULL,
        owner_id TEXT,
        due_at TEXT,
        status TEXT NOT NULL,
        evidence_state TEXT NOT NULL,
        task_revision INTEGER NOT NULL,
        state_version INTEGER NOT NULL,
        title TEXT NOT NULL,
        execution_spec TEXT NOT NULL,
        execution_spec_hash TEXT NOT NULL,
        required_evidence_types TEXT NOT NULL DEFAULT '[]',
        revisions TEXT NOT NULL DEFAULT '[]',
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        approval_decisions TEXT NOT NULL DEFAULT '[]',
        events TEXT NOT NULL DEFAULT '[]',
        conversation_links TEXT NOT NULL DEFAULT '[]',
        agent_run_links TEXT NOT NULL DEFAULT '[]',
        mutation_keys TEXT NOT NULL DEFAULT '{}',
        depends_on_task_ids TEXT NOT NULL DEFAULT '[]',
        creation_idempotency_key TEXT,
        request_fingerprint TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`);
      await insertTaskScope(legacy.db);
      const insertLegacy = async (
        id: string,
        parent: string | null,
        reason: string | null,
      ) => legacy.db.exec(
        `INSERT INTO seo_agent_runs
          (id, merchant_id, location_id, stage, task_id, run_type, status,
           input_message, token_usage, triggered_by, triggered_at,
           creation_idempotency_key, request_fingerprint,
           business_input_fingerprint, retry_of_agent_run_id, retry_reason,
           created_by, created_at, updated_at)
         VALUES ($1, 'legacy-gbp-merchant', 'legacy-gbp-location',
                 'GBP_POST_CONTENT', 'legacy-gbp-task', 'GBP_POST_CONTENT', 'FAILED',
                 '{}', '{}', 'legacy-operator', '2026-08-26T00:00:00.000Z',
                 $2, $3, 'sha256:legacy-business', $4, $5,
                 'legacy-operator', '2026-08-26T00:00:00.000Z',
                 '2026-08-26T00:00:00.000Z')`,
        [id, `${id}-key`, `sha256:generation-${id}`, parent, reason],
      );
      await insertLegacy("legacy-gbp-0", null, null);
      await insertLegacy("legacy-gbp-1", "legacy-gbp-0", "  First explicit retry.  ");
      await insertLegacy("legacy-gbp-2", "legacy-gbp-1", "Second explicit retry.");

      await migrate(legacy.db);
      await migrate(legacy.db);

      expect(await legacy.db.query(
        `SELECT id, retry_generation, http_request_fingerprint
           FROM seo_agent_runs
          WHERE id LIKE 'legacy-gbp-%'
          ORDER BY id`,
      )).toEqual([
        {
          id: "legacy-gbp-0",
          retry_generation: 0,
          http_request_fingerprint: "sha256:f8b2bc3baeb5dc61901d2bda05fadf3a4500f5a85a4636a5a8a5111244358e7c",
        },
        {
          id: "legacy-gbp-1",
          retry_generation: 1,
          http_request_fingerprint: "sha256:1fcc9ccfab78a19cc9e044233a1d299d01458ce398f94d505953d012f30108d7",
        },
        {
          id: "legacy-gbp-2",
          retry_generation: 2,
          http_request_fingerprint: "sha256:4f54a2de32d100de6ee73eb603618366d091dd4df679ef824395a3be6a946676",
        },
      ]);
      expect(await legacy.db.query(
        `SELECT idempotency_key, http_request_fingerprint
           FROM seo_agent_run_requests
          WHERE run_id LIKE 'legacy-gbp-%'
          ORDER BY run_id`,
      )).toEqual([
        { idempotency_key: "legacy-gbp-0-key", http_request_fingerprint: "sha256:f8b2bc3baeb5dc61901d2bda05fadf3a4500f5a85a4636a5a8a5111244358e7c" },
        { idempotency_key: "legacy-gbp-1-key", http_request_fingerprint: "sha256:1fcc9ccfab78a19cc9e044233a1d299d01458ce398f94d505953d012f30108d7" },
        { idempotency_key: "legacy-gbp-2-key", http_request_fingerprint: "sha256:4f54a2de32d100de6ee73eb603618366d091dd4df679ef824395a3be6a946676" },
      ]);
    } finally {
      await legacy.teardown();
    }
  });

  it("fails migration closed when a legacy GBP retry parent is missing", async () => {
    const legacy = await createTestDb();
    try {
      await migrate(legacy.db);
      await insertTaskScope(legacy.db);
      await insertAgentRun(legacy.db, legacyGbpRun({
        id: "legacy-gbp-missing-parent",
        retryOfAgentRunId: "absent-parent",
        retryReason: "Missing parent must require reconciliation.",
      }));

      await expect(migrate(legacy.db)).rejects.toThrow(/legacy-gbp-missing-parent.*absent-parent/i);
      expect((await legacy.db.one<{ retry_generation: number }>(
        `SELECT retry_generation FROM seo_agent_runs WHERE id = 'legacy-gbp-missing-parent'`,
      ))?.retry_generation).toBe(0);
    } finally {
      await legacy.teardown();
    }
  });

  it("fails migration closed when legacy GBP retry lineage contains a cycle", async () => {
    const legacy = await createTestDb();
    try {
      await migrate(legacy.db);
      await insertTaskScope(legacy.db);
      await insertAgentRun(legacy.db, legacyGbpRun({
        id: "legacy-gbp-cycle-a",
        retryOfAgentRunId: "legacy-gbp-cycle-b",
        retryReason: "Cycle edge A.",
      }));
      await insertAgentRun(legacy.db, legacyGbpRun({
        id: "legacy-gbp-cycle-b",
        retryOfAgentRunId: "legacy-gbp-cycle-a",
        retryReason: "Cycle edge B.",
      }));

      await expect(migrate(legacy.db)).rejects.toThrow(/cycle.*legacy-gbp-cycle/i);
    } finally {
      await legacy.teardown();
    }
  });

  it("fails migration closed when a GBP content Run references a missing Task", async () => {
    const legacy = await createTestDb();
    try {
      await migrate(legacy.db);
      await insertAgentRun(legacy.db, legacyGbpRun({ id: "legacy-gbp-missing-task" }));

      await expect(migrate(legacy.db)).rejects.toThrow(/missing Task.*legacy-gbp-task/i);
    } finally {
      await legacy.teardown();
    }
  });

  for (const mismatch of ["merchant", "location"] as const) {
    it(`fails migration closed when a GBP content Run has a Task ${mismatch} mismatch`, async () => {
      const legacy = await createTestDb();
      try {
        await migrate(legacy.db);
        await insertTaskScope(legacy.db);
        await insertAgentRun(legacy.db, legacyGbpRun({
          id: `legacy-gbp-${mismatch}-mismatch`,
          ...(mismatch === "merchant"
            ? { merchantId: "foreign-merchant" }
            : { locationId: "wrong-location" }),
        }));

        await expect(migrate(legacy.db)).rejects.toThrow(
          new RegExp(`legacy-gbp-${mismatch}-mismatch.*${mismatch}.*reconciliation`, "i"),
        );
      } finally {
        await legacy.teardown();
      }
    });
  }

  it("fails migration closed when a GBP retry parent has a foreign scope", async () => {
    const legacy = await createTestDb();
    try {
      await migrate(legacy.db);
      await insertTaskScope(legacy.db);
      await insertAgentRun(legacy.db, legacyGbpRun({
        id: "legacy-gbp-foreign-parent",
        merchantId: "foreign-merchant",
        locationId: "foreign-location",
      }));
      await insertAgentRun(legacy.db, legacyGbpRun({
        id: "legacy-gbp-child-of-foreign-parent",
        retryOfAgentRunId: "legacy-gbp-foreign-parent",
        retryReason: "The parent must match the Task scope.",
      }));

      await expect(migrate(legacy.db)).rejects.toThrow(/foreign-parent.*reconciliation/i);
    } finally {
      await legacy.teardown();
    }
  });

  it("rejects a pre-version creation alias bound to a different scope-valid Run without rebinding it", async () => {
    const legacy = await createTestDb();
    try {
      await migrate(legacy.db);
      await insertTaskScope(legacy.db);
      const expectedRun = legacyGbpRun({
        id: "legacy-gbp-creation-owner",
        creationIdempotencyKey: "legacy-gbp-conflicting-creation-key",
      });
      const wronglyBoundRun = legacyGbpRun({
        id: "legacy-gbp-wrongly-bound",
        creationIdempotencyKey: "legacy-gbp-wrongly-bound-key",
        requestFingerprint: "sha256:wrongly-bound-generation",
      });
      await insertAgentRun(legacy.db, expectedRun);
      await insertAgentRun(legacy.db, wronglyBoundRun);
      await legacy.db.exec(`ALTER TABLE seo_agent_run_requests DROP COLUMN semantics_version`);
      await legacy.db.exec(
        `INSERT INTO seo_agent_run_requests
          (idempotency_key, run_id, merchant_id, http_request_fingerprint, created_at)
         VALUES ($1, $2, $3, 'sha256:pre-version-alias', $4)`,
        [
          expectedRun.creationIdempotencyKey,
          wronglyBoundRun.id,
          expectedRun.merchantId,
          expectedRun.createdAt,
        ],
      );

      await expect(migrate(legacy.db)).rejects.toThrow(/creation.*different Run.*reconciliation/i);
      expect(await legacy.db.one<{ run_id: string }>(
        `SELECT run_id FROM seo_agent_run_requests WHERE idempotency_key = $1`,
        [expectedRun.creationIdempotencyKey],
      )).toEqual({ run_id: wronglyBoundRun.id });
    } finally {
      await legacy.teardown();
    }
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
      expect(columns).toContainEqual({ column_name: "media_source_agent_run_id", is_nullable: "YES" });

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
      await expect(legacy.db.exec(
        `UPDATE seo_specialist_artifacts
            SET acceptance_decided_by = 'forged-actor',
                acceptance_decided_at = '2026-08-27T01:00:00.000Z'
          WHERE id = 'legacy-artifact'`,
      )).rejects.toMatchObject({ code: "23514" });
      await expect(legacy.db.exec(
        `UPDATE seo_specialist_artifacts
            SET acceptance_status = 'ACCEPTED'
          WHERE id = 'legacy-artifact'`,
      )).rejects.toMatchObject({ code: "23514" });

      await legacy.db.exec(
        `UPDATE seo_specialist_artifacts
            SET acceptance_status = 'ACCEPTED',
                acceptance_decided_by = 'operator-1',
                acceptance_decided_at = '2026-08-27T01:00:00.000Z'
          WHERE id = 'legacy-artifact'`,
      );
      const accepted = await legacy.db.one<{ acceptance_status: string; acceptance_note: string | null }>(
        `SELECT acceptance_status, acceptance_note
           FROM seo_specialist_artifacts WHERE id = 'legacy-artifact'`,
      );
      expect(accepted).toEqual({ acceptance_status: "ACCEPTED", acceptance_note: null });
    } finally {
      await legacy.teardown();
    }
  });

  it("normalizes inconsistent legacy acceptance metadata before adding the decision check", async () => {
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
        acceptance_status TEXT NOT NULL DEFAULT 'PENDING',
        acceptance_decided_by TEXT,
        acceptance_decided_at TEXT,
        acceptance_note TEXT,
        UNIQUE(core_run_id, artifact_type)
      )`);
      await legacy.db.exec(`INSERT INTO seo_specialist_artifacts
        (id, task_id, merchant_id, artifact_type, schema_version, title, summary,
         payload, core_run_id, created_at, acceptance_status, acceptance_decided_by)
        VALUES ('legacy-inconsistent', 'task-1', 'merchant-1', 'AUDIT_REPORT', 'v1',
                'Legacy', 'Legacy artifact', '{}', 'legacy-inconsistent-run',
                '2026-08-27T00:00:00.000Z', 'ACCEPTED', 'legacy-actor')`);
      await legacy.db.exec(`INSERT INTO seo_specialist_artifacts
        (id, task_id, merchant_id, artifact_type, schema_version, title, summary,
         payload, core_run_id, created_at, acceptance_status, acceptance_decided_by,
         acceptance_decided_at, acceptance_note)
        VALUES ('legacy-invalid-status', 'task-1', 'merchant-1', 'AUDIT_REPORT', 'v1',
                'Legacy invalid', 'Legacy invalid status', '{}', 'legacy-invalid-run',
                '2026-08-27T00:00:00.000Z', 'PUBLISHED', 'legacy-actor',
                '2026-08-27T01:00:00.000Z', 'legacy unsupported state')`);

      await migrate(legacy.db);
      await migrate(legacy.db);

      expect(await legacy.db.one(
        `SELECT acceptance_status, acceptance_decided_by,
                acceptance_decided_at, acceptance_note
           FROM seo_specialist_artifacts WHERE id = 'legacy-inconsistent'`,
      )).toEqual({
        acceptance_status: "PENDING",
        acceptance_decided_by: null,
        acceptance_decided_at: null,
        acceptance_note: null,
      });
      expect(await legacy.db.one(
        `SELECT acceptance_status, acceptance_decided_by,
                acceptance_decided_at, acceptance_note
           FROM seo_specialist_artifacts WHERE id = 'legacy-invalid-status'`,
      )).toEqual({
        acceptance_status: "PENDING",
        acceptance_decided_by: null,
        acceptance_decided_at: null,
        acceptance_note: null,
      });
    } finally {
      await legacy.teardown();
    }
  });
});

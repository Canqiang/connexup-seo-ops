import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import type { Db } from "../src/db/connection.js";
import { hashGbpCommand } from "../src/domain/gbpExecutionContract.js";
import {
  claimNextGbpCommand,
  getGbpCommand,
  getGbpLocationBinding,
  getGbpReceipt,
  insertGbpCommand,
  insertGbpLocationBinding,
  insertGbpReadbackAttempt,
  insertGbpReceipt,
  listGbpReadbackAttempts,
} from "../src/repos/gbpExecutionRepo.js";
import type { GbpLocationBinding } from "../src/repos/types.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
beforeAll(() => migrate(ctx.db));
afterAll(() => ctx.teardown());

const now = "2026-08-27T12:00:00.000Z";
const sha = (digit: string) => `sha256:${digit.repeat(64)}`;

const command = {
  schema_version: "seo_ops.gbp_execution_command.v1",
  instruction_id: "11111111-1111-4111-8111-111111111111",
  task: {
    id: "22222222-2222-4222-8222-222222222222",
    merchant_id: "33333333-3333-4333-8333-333333333333",
    location_id: "44444444-4444-4444-8444-444444444444",
    task_revision: 7,
    execution_spec_sha256: sha("a"),
    approval_decision_id: "55555555-5555-4555-8555-555555555555",
  },
  core: {
    api_user_id: "66666666-6666-4666-8666-666666666666",
    api_user_external_id: "merchant-api-user-9",
    write_secret_ref: "george-gbp-write",
    readback_secret_ref: "george-gbp-readback",
    write_agent_id: "77777777-7777-4777-8777-777777777777",
    write_agent_published_ref: "published:gbp-write:v1",
    readback_agent_id: "88888888-8888-4888-8888-888888888888",
    readback_agent_published_ref: "published:gbp-readback:v1",
  },
  gbp: {
    account_resource: "accounts/123456789",
    location_resource: "locations/987654321",
    timezone: "America/New_York",
    scheduled_for_local: "2026-08-27T08:30:00-04:00",
  },
  operation: { kind: "CREATE_POST" },
  draft: {
    id: "99999999-9999-4999-8999-999999999999",
    version: 3,
    sha256: sha("b"),
    body: "Fresh lunch specials are ready.",
    cta: { type: "ORDER", url: "https://example.test/order" },
    image: {
      deliverable_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sha256: sha("c"),
      alt_text: "Lunch special with rice and vegetables",
    },
  },
  scheduled_for: "2026-08-27T12:30:00.000Z",
  provider_idempotency_key: "gbp-create-11111111-rev7",
  probe_ref: "gbp-probe-11111111-rev7",
} as const;

const binding: GbpLocationBinding = {
  id: "binding-1",
  merchantId: command.task.merchant_id,
  locationId: command.task.location_id,
  accountResource: command.gbp.account_resource,
  locationResource: command.gbp.location_resource,
  timezone: command.gbp.timezone,
  coreApiUserId: command.core.api_user_id,
  coreApiUserExternalId: command.core.api_user_external_id,
  writeSecretRef: command.core.write_secret_ref,
  readbackSecretRef: command.core.readback_secret_ref,
  writeAgentId: command.core.write_agent_id,
  writeAgentPublishedRef: command.core.write_agent_published_ref,
  readbackAgentId: command.core.readback_agent_id,
  readbackAgentPublishedRef: command.core.readback_agent_published_ref,
  status: "READY",
  stateVersion: 1,
  updatedBy: "operator-1",
  createdAt: now,
  updatedAt: now,
};

async function insertScope(db: Db): Promise<void> {
  await db.exec(
    `INSERT INTO seo_merchants
      (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
     VALUES ($1, 'merchant', 'Merchant', '[]', '[]', $2, $2)`,
    [command.task.merchant_id, now],
  );
  await db.exec(
    `INSERT INTO seo_locations
      (id, merchant_id, slug, display_name, timezone, external_identities,
       readiness_status, missing_requirements, created_at, updated_at)
     VALUES ($1, $2, 'location', 'Location', $3, '{}', 'READY', '[]', $4, $4)`,
    [command.task.location_id, command.task.merchant_id, command.gbp.timezone, now],
  );
  await db.exec(
    `INSERT INTO seo_tasks
      (id, merchant_id, location_id, task_type, source, priority, impact,
       status, evidence_state, task_revision, state_version, title,
       execution_spec, execution_spec_hash, created_at, updated_at)
     VALUES ($1, $2, $3, 'GBP_POST', 'CYCLE', 'HIGH', 'HIGH', 'APPROVED',
             'VERIFIED', $4, 1, 'GBP Post', '{}', $5, $6, $6)`,
    [command.task.id, command.task.merchant_id, command.task.location_id,
      command.task.task_revision, command.task.execution_spec_sha256, now],
  );
}

async function seedCommand(db: Db): Promise<void> {
  await insertScope(db);
  await insertGbpLocationBinding(db, binding);
  await insertGbpCommand(db, {
    id: "command-1",
    bindingId: binding.id,
    bindingStateVersion: binding.stateVersion,
    command,
    createdBy: "operator-1",
    createdAt: now,
  });
}

describe("GBP persistence migration", () => {
  it("is additive/rerunnable and enforces the immutable safety constraints", async () => {
    await migrate(ctx.db);
    const tables = await ctx.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name LIKE 'seo_gbp_%' ORDER BY table_name`,
      [ctx.schema],
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "seo_gbp_command_states",
      "seo_gbp_commands",
      "seo_gbp_location_bindings",
      "seo_gbp_readback_attempts",
      "seo_gbp_receipts",
    ]);
    const tokenColumns = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name LIKE 'seo_gbp_%'
         AND column_name ILIKE '%token%'`,
      [ctx.schema],
    );
    expect(tokenColumns).toEqual([]);
    const attemptColumns = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'seo_execution_attempts'`,
      [ctx.schema],
    );
    expect(attemptColumns.map((row) => row.column_name)).toContain("gbp_command_id");

    await seedCommand(ctx.db);
    await expect(ctx.db.exec(
      `UPDATE seo_gbp_commands SET operation = 'UPDATE_POST' WHERE id = 'command-1'`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(ctx.db.exec(
      `UPDATE seo_gbp_command_states SET lease_owner = 'worker-only' WHERE command_id = 'command-1'`,
    )).rejects.toMatchObject({ code: "23514" });

    await expect(ctx.db.exec(
      `INSERT INTO seo_gbp_commands
       SELECT 'duplicate-task-revision', '21111111-1111-4111-8111-111111111111',
              task_id, merchant_id, location_id, task_revision, execution_spec_sha256,
              approval_decision_id, draft_id, draft_version, draft_sha256,
              image_deliverable_id, image_sha256, binding_id, binding_state_version,
              operation, scheduled_for, 'duplicate-task-provider-key',
              'duplicate-task-probe', canonical_json, command_sha256, created_by, created_at
         FROM seo_gbp_commands WHERE id = 'command-1'`,
    )).rejects.toMatchObject({ code: "23505" });

    await ctx.db.exec(
      `INSERT INTO seo_tasks
       SELECT 'task-2', merchant_id, location_id, task_type, source, priority, impact,
              owner_id, due_at, status, evidence_state, 8, state_version, title,
              execution_spec, execution_spec_hash, required_evidence_types, revisions,
              evidence_refs, approval_decisions, events, conversation_links,
              agent_run_links, mutation_keys, depends_on_task_ids, creation_idempotency_key,
              request_fingerprint, created_by, created_at, updated_at, execution_mode,
              proposal_id, attempt_count, published_ref, published_at, verify_due_at,
              verified_at, verified_by, cycle_id
         FROM seo_tasks WHERE id = $1`,
      [command.task.id],
    );
    await expect(ctx.db.exec(
      `INSERT INTO seo_gbp_commands
       SELECT 'duplicate-instruction', instruction_id, 'task-2', merchant_id, location_id,
              8, execution_spec_sha256, approval_decision_id, draft_id, draft_version,
              draft_sha256, image_deliverable_id, image_sha256, binding_id,
              binding_state_version, operation, scheduled_for,
              'duplicate-instruction-provider-key', 'duplicate-instruction-probe',
              canonical_json, command_sha256, created_by, created_at
         FROM seo_gbp_commands WHERE id = 'command-1'`,
    )).rejects.toMatchObject({ code: "23505" });

    await ctx.db.exec(
      `INSERT INTO seo_gbp_commands
       SELECT 'command-2', '31111111-1111-4111-8111-111111111111', 'task-2',
              merchant_id, location_id, 8, execution_spec_sha256, approval_decision_id,
              draft_id, draft_version, draft_sha256, image_deliverable_id, image_sha256,
              binding_id, binding_state_version, operation, scheduled_for,
              'second-provider-key', 'second-probe', canonical_json, command_sha256,
              created_by, created_at
         FROM seo_gbp_commands WHERE id = 'command-1'`,
    );
    await expect(ctx.db.exec(
      `INSERT INTO seo_gbp_command_states
        (command_id, merchant_id, location_id, status, scheduled_for, created_at, updated_at)
       SELECT 'command-2', merchant_id, location_id, 'SCHEDULED', scheduled_for, $1, $1
         FROM seo_gbp_commands WHERE id = 'command-2'`,
      [now],
    )).rejects.toMatchObject({ code: "23505" });
  });
});

describe("GBP execution repository", () => {
  it("uses exact tenant/location ownership and verifies canonical command JSON plus hash on read", async () => {
    expect(await getGbpLocationBinding(ctx.db, binding.merchantId, binding.locationId)).toEqual(binding);
    expect(await getGbpLocationBinding(ctx.db, "foreign-merchant", binding.locationId)).toBeNull();
    const stored = await getGbpCommand(ctx.db, "command-1", binding.merchantId, binding.locationId);
    expect(stored?.command).toEqual(command);
    expect(stored?.commandSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await getGbpCommand(ctx.db, "command-1", "foreign-merchant", binding.locationId)).toBeNull();

    await ctx.db.exec(
      `UPDATE seo_gbp_commands SET command_sha256 = $1 WHERE id = 'command-1'`,
      [sha("0")],
    );
    await expect(getGbpCommand(ctx.db, "command-1", binding.merchantId, binding.locationId))
      .rejects.toThrow(/integrity/i);
    await ctx.db.exec(
      `UPDATE seo_gbp_commands SET command_sha256 = $1 WHERE id = 'command-1'`,
      [hashGbpCommand(command)],
    );
  });

  it("rolls back a standalone command insert when its initial state cannot be created", async () => {
    const competing = structuredClone(command);
    competing.instruction_id = "41111111-1111-4111-8111-111111111111";
    competing.task.id = "c2222222-2222-4222-8222-222222222222";
    competing.task.task_revision = 9;
    competing.provider_idempotency_key = "competing-provider-key";
    competing.probe_ref = "competing-probe";
    await ctx.db.exec(
      `INSERT INTO seo_tasks
        (id, merchant_id, location_id, task_type, source, priority, impact,
         status, evidence_state, task_revision, state_version, title,
         execution_spec, execution_spec_hash, created_at, updated_at)
       VALUES ($1,$2,$3,'GBP_POST','CYCLE','HIGH','HIGH','APPROVED','VERIFIED',
               $4,1,'Competing GBP Post','{}',$5,$6,$6)`,
      [competing.task.id, competing.task.merchant_id, competing.task.location_id,
        competing.task.task_revision, competing.task.execution_spec_sha256, now],
    );
    await expect(insertGbpCommand(ctx.db, {
      id: "command-competing",
      bindingId: binding.id,
      bindingStateVersion: binding.stateVersion,
      command: competing,
      createdBy: "operator-1",
      createdAt: now,
    })).rejects.toMatchObject({ code: "23505" });
    expect(await ctx.db.one(
      `SELECT id FROM seo_gbp_commands WHERE id = 'command-competing'`,
    )).toBeNull();
  });

  it("claims a due command once across competing workers using a complete lease tuple", async () => {
    const [a, b] = await Promise.all([
      claimNextGbpCommand(ctx.db, {
        workerId: "worker-a",
        now: "2026-08-27T13:00:00.000Z",
        leaseExpiresAt: "2026-08-27T13:05:00.000Z",
      }),
      claimNextGbpCommand(ctx.db, {
        workerId: "worker-b",
        now: "2026-08-27T13:00:00.000Z",
        leaseExpiresAt: "2026-08-27T13:05:00.000Z",
      }),
    ]);
    const claims = [a, b].filter((value) => value !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.state).toMatchObject({
      status: "CLAIMED",
      leaseAcquiredAt: "2026-08-27T13:00:00.000Z",
      leaseExpiresAt: "2026-08-27T13:05:00.000Z",
    });
    expect(["worker-a", "worker-b"]).toContain(claims[0]?.state.leaseOwner);
  });

  it("persists one strict immutable receipt and append-only strict readbacks", async () => {
    const receipt = {
      schema_version: "seo_ops.gbp_execution_receipt.v1",
      instruction_id: command.instruction_id,
      command_sha256: (await ctx.db.one<{ command_sha256: string }>(
        `SELECT command_sha256 FROM seo_gbp_commands WHERE id = 'command-1'`,
      ))!.command_sha256,
      provider_idempotency_key: command.provider_idempotency_key,
      probe_ref: command.probe_ref,
      operation: { kind: "CREATE_POST" },
      core_api_user_id: command.core.api_user_id,
      account_resource: command.gbp.account_resource,
      location_resource: command.gbp.location_resource,
      status: "APPLIED",
      provider_mutation_count: 1,
      provider_post_resource: "accounts/123456789/locations/987654321/localPosts/post-1",
      provider_request_id: "request-1",
      applied_at: "2026-08-27T13:01:00.000Z",
      submitted: { body_sha256: sha("d"), cta_sha256: sha("e"), media_sha256: sha("c") },
    } as const;
    await insertGbpReceipt(ctx.db, { commandId: "command-1", receipt, createdAt: now });
    expect((await getGbpReceipt(ctx.db, "command-1"))?.receipt).toEqual(receipt);
    await expect(insertGbpReceipt(ctx.db, { commandId: "command-1", receipt, createdAt: now }))
      .rejects.toMatchObject({ code: "23505" });

    const readback = {
      schema_version: "seo_ops.gbp_readback.v1",
      instruction_id: command.instruction_id,
      command_sha256: receipt.command_sha256,
      core_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      readback_agent_id: command.core.readback_agent_id,
      account_resource: command.gbp.account_resource,
      location_resource: command.gbp.location_resource,
      provider_post_resource: receipt.provider_post_resource,
      observed_at: "2026-08-27T13:02:00.000Z",
      body: command.draft.body,
      cta: command.draft.cta,
      media: [{ provider_media_resource: "media/photo-1", sha256: command.draft.image.sha256 }],
    } as const;
    await insertGbpReadbackAttempt(ctx.db, {
      id: "readback-1",
      commandId: "command-1",
      observation: readback,
      diffCodes: [],
      safeErrorCode: null,
      createdAt: now,
    });
    expect((await listGbpReadbackAttempts(ctx.db, "command-1"))[0]).toMatchObject({
      observation: readback,
      diffCodes: [],
    });
  });
});

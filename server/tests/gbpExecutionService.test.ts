import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { executionSpecHash, sha256HashBytes } from "../src/domain/hashing.js";
import { draftSha256 } from "../src/services/contentService.js";
import { insertTask } from "../src/repos/taskRepo.js";
import { insertDraft } from "../src/repos/draftRepo.js";
import { insertAgentRun, upsertDeliverable } from "../src/repos/agentRunRepo.js";
import { getTask } from "../src/repos/taskRepo.js";
import { listAttemptsByTask } from "../src/repos/executionRepo.js";
import { ExecutionWorker } from "../src/services/executionWorker.js";
import type { CoreAiClient } from "../src/services/coreAiClient.js";

const ids = {
  merchant: "11111111-1111-4111-8111-111111111111",
  location: "22222222-2222-4222-8222-222222222222",
  task: "33333333-3333-4333-8333-333333333333",
  draft: "44444444-4444-4444-8444-444444444444",
  approval: "55555555-5555-4555-8555-555555555555",
  run: "66666666-6666-4666-8666-666666666666",
  deliverable: "77777777-7777-4777-8777-777777777777",
  apiUser: "88888888-8888-4888-8888-888888888888",
  writeAgent: "99999999-9999-4999-8999-999999999999",
  readAgent: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const now = "2026-08-27T12:00:00.000Z";
const schedule = "2026-08-28T15:30:00.000Z";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

async function seedApprovedGbpTask(built: AuthenticatedTestApp, imagePath: string) {
  const { db } = built;
  await db.exec(
    `INSERT INTO seo_merchants
      (id, slug, display_name, tags, operator_user_ids, created_at, updated_at)
     VALUES ($1, 'george', 'George Restaurant', '[]', '["op-1"]', $2, $2)`,
    [ids.merchant, now],
  );
  await db.exec(
    `INSERT INTO seo_locations
      (id, merchant_id, slug, display_name, timezone, external_identities,
       readiness_status, missing_requirements, created_at, updated_at)
     VALUES ($1,$2,'midtown','George Midtown','America/New_York',$3,'READY','[]',$4,$4)`,
    [ids.location, ids.merchant, JSON.stringify({ google_business: "locations/987654321" }), now],
  );
  const imageSha = sha256HashBytes(png);
  const mediaRef = JSON.stringify({
    alt_text: "George lunch special",
    deliverable_id: ids.deliverable,
    schema_version: "seo_ops.media_ref.v1",
    sha256: imageSha,
  });
  const draftBody = "Fresh lunch specials are ready.";
  const draftSha = draftSha256({
    body: draftBody, ctaType: "ORDER", ctaUrl: "https://example.test/order", media: [mediaRef],
  });
  const contentDraft = {
    draft_version: 1,
    draft_sha256: draftSha,
    body: draftBody,
    cta_type: "ORDER",
    cta_url: "https://example.test/order",
    media: [mediaRef],
  };
  const executionSpec = JSON.stringify({
    locationName: "locations/987654321",
    content_draft: contentDraft,
  });
  const taskExecutionSpecHash = executionSpecHash(executionSpec);
  const approval = {
    id: ids.approval,
    decision: "APPROVE" as const,
    taskRevision: 2,
    executionSpecHash: taskExecutionSpecHash,
    expectedStateVersion: 1,
    resultingStateVersion: 2,
    actorId: "op-1",
    decidedAt: now,
  };
  await insertTask(db, {
    id: ids.task, merchantId: ids.merchant, cycleId: null, locationId: ids.location,
    taskType: "GBP_POST", source: "CYCLE", priority: "HIGH", impact: "HIGH",
    ownerId: null, dueAt: null, status: "APPROVED", evidenceState: "VERIFIED",
    taskRevision: 2, stateVersion: 2, title: "George GBP Post", executionSpec,
    executionSpecHash: taskExecutionSpecHash, requiredEvidenceTypes: ["CONTENT_DRAFT"], revisions: [],
    evidenceRefs: [], approvalDecisions: [approval], events: [], conversationLinks: [],
    agentRunLinks: [], executionMode: "AUTO_WRITE", proposalId: null,
    dependsOnTaskIds: [], attemptCount: 0, publishedRef: null, publishedAt: null,
    verifyDueAt: null, verifiedAt: null, verifiedBy: null, mutationKeys: {},
    creationIdempotencyKey: null, requestFingerprint: null, createdBy: "op-1",
    createdAt: now, updatedAt: now,
  });
  await insertAgentRun(db, {
    id: ids.run, merchantId: ids.merchant, locationId: ids.location,
    stage: "GBP_POST_CONTENT", taskId: ids.task, runType: "REPORT",
    goal: null, status: "COMPLETED", coreRunId: "core-content-run", traceRef: null,
    coreStatus: "COMPLETED", inputMessage: "{}", output: "{}", error: null,
    errorCode: null, tokenUsage: {}, triggeredBy: "op-1", triggeredAt: now,
    lastPolledAt: now, completedAt: now, creationIdempotencyKey: null,
    requestFingerprint: null, httpRequestFingerprint: null,
    businessInputFingerprint: null, retryOfAgentRunId: null, retryGeneration: 0,
    retryReason: null, createdBy: "op-1", createdAt: now, updatedAt: now,
  });
  await upsertDeliverable(db, {
    id: ids.deliverable, runId: ids.run, kind: "ATTACHMENT", fileId: "image-1",
    fileName: "post.png", contentType: "image/png", size: png.byteLength,
    title: null, description: null, sha256: imageSha, localPath: imagePath,
    remoteUrl: "https://core.invalid/must-never-project", downloadedAt: now,
    downloadError: null, createdAt: now,
  });
  await insertDraft(db, {
    id: ids.draft, taskId: ids.task, agentRunId: ids.run, mediaSourceAgentRunId: null,
    version: 1, body: draftBody, ctaType: "ORDER", ctaUrl: "https://example.test/order",
    media: [mediaRef], source: "AGENT_GENERATED", feedback: null, sha256: draftSha,
    createdBy: "op-1", createdAt: now,
  });
  return { executionSpecHash: taskExecutionSpecHash, imageSha, draftSha: `sha256:${draftSha}` };
}

function bindingPayload(expectedStateVersion = 0) {
  return {
      expected_state_version: expectedStateVersion,
      account_resource: "accounts/123456789",
      location_resource: "locations/987654321",
      timezone: "America/New_York",
      core_api_user_id: ids.apiUser,
      core_api_user_external_id: "george-api-user",
      write_secret_ref: "george-gbp-write",
      readback_secret_ref: "george-gbp-readback",
      write_agent_id: ids.writeAgent,
      write_agent_published_ref: "published:gbp-write:v1",
      readback_agent_id: ids.readAgent,
      readback_agent_published_ref: "published:gbp-readback:v1",
      status: "READY",
  } as const;
}

async function putReadyBinding(app: FastifyInstance, expectedStateVersion = 0) {
  return app.inject({
    method: "PUT",
    url: `/api/seo-ops/merchants/${ids.merchant}/locations/${ids.location}/gbp-execution-binding`,
    payload: bindingPayload(expectedStateVersion),
  });
}

describe("GBP Gate 2 command and binding", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let tempDir: string;
  let seeded: Awaited<ReturnType<typeof seedApprovedGbpTask>>;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-ops-gbp-gate2-"));
    const imagePath = path.join(tempDir, "post.png");
    await fs.writeFile(imagePath, png);
    seeded = await seedApprovedGbpTask(built, imagePath);
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates and CAS-updates an exact binding without projecting credential values", async () => {
    const created = await putReadyBinding(app);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      merchant_id: ids.merchant,
      location_id: ids.location,
      account_resource: "accounts/123456789",
      write_secret_ref: "george-gbp-write",
      state_version: 1,
      ready_for_gate2: true,
      missing_fields: [],
    });
    expect(JSON.stringify(created.json())).not.toContain("Bearer ");

    const stale = await putReadyBinding(app, 0);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error_code: "GBP_BINDING_STALE" });
    expect(JSON.stringify(stale.json())).not.toContain("george-gbp-write-value");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${ids.merchant}/locations/${ids.location}/gbp-execution-binding`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(created.json());
  });

  it("rejects token/path-shaped secret refs without reflecting their values", async () => {
    const unsafe = "../Bearer_super-secret-token";
    const response = await app.inject({
      method: "PUT",
      url: `/api/seo-ops/merchants/${ids.merchant}/locations/${ids.location}/gbp-execution-binding`,
      payload: {
        ...bindingPayload(),
        write_secret_ref: unsafe,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).not.toContain(unsafe);
  });

  it("projects only minimal binding readiness before confirmation", async () => {
    expect((await putReadyBinding(app)).statusCode).toBe(201);

    const response = await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${ids.task}/gbp-execution`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().binding).toEqual({
      ready_for_gate2: true,
      missing_fields: [],
      state_version: 1,
    });
    const projection = JSON.stringify(response.json());
    for (const forbiddenKey of [
      "account_resource", "location_resource", "core_api_user_id",
      "core_api_user_external_id", "write_secret_ref", "readback_secret_ref",
      "write_agent_id", "write_agent_published_ref", "readback_agent_id",
      "readback_agent_published_ref", "updated_by",
    ]) {
      expect(projection).not.toContain(`"${forbiddenKey}"`);
    }
    for (const forbiddenValue of [
      ids.apiUser, ids.writeAgent, ids.readAgent, "accounts/123456789",
      "locations/987654321", "george-gbp-write", "george-gbp-readback",
      "published:gbp-write:v1", "published:gbp-readback:v1",
    ]) {
      expect(projection).not.toContain(forbiddenValue);
    }
  });

  it("atomically snapshots the approved draft and converges duplicate confirmation", async () => {
    expect((await putReadyBinding(app)).statusCode).toBe(201);
    const payload = {
      expected_state_version: 2,
      expected_task_revision: 2,
      expected_execution_spec_hash: seeded.executionSpecHash,
      scheduled_for: schedule,
      idempotency_key: "gate2-george-1",
    };
    const first = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`, payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      status: "EXECUTION_CONFIRMED", attempt_count: 1,
      gbp_execution: { available: true, schedule: { utc: schedule }, command_state: { status: "SCHEDULED" } },
    });
    const duplicate = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`, payload,
    });
    expect(duplicate.statusCode).toBe(200);

    const view = await app.inject({
      method: "GET", url: `/api/seo-ops/tasks/${ids.task}/gbp-execution`,
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      task_id: ids.task,
      store: { merchant_name: "George Restaurant", location_name: "George Midtown" },
      schedule: { utc: schedule, local: "2026-08-28T11:30:00-04:00" },
      approved: {
        body: "Fresh lunch specials are ready.",
        cta: { type: "ORDER", url: "https://example.test/order" },
        image: {
          deliverable_id: ids.deliverable,
          sha256: seeded.imageSha,
          download_path: `/api/seo-ops/deliverables/${ids.deliverable}/download`,
        },
      },
      hashes: { execution_spec: seeded.executionSpecHash, draft: seeded.draftSha },
      command_state: { status: "SCHEDULED" },
    });
    expect(JSON.stringify(view.json())).not.toMatch(/core\.invalid|secret_ref|core_run_id/i);

    const attempts = await listAttemptsByTask(built.db, ids.task, ids.merchant);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ gbpCommandId: expect.any(String), status: "DISPATCHING" });
    expect((await built.db.one<{ n: string }>("SELECT COUNT(*) AS n FROM seo_gbp_commands"))?.n).toBe("1");
    const trigger = vi.fn();
    const genericWorker = new ExecutionWorker({
      db: built.db,
      client: { trigger, getRun: vi.fn() } as unknown as CoreAiClient,
    });
    await genericWorker.pollOnce();
    expect(trigger).not.toHaveBeenCalled();
    expect((await listAttemptsByTask(built.db, ids.task, ids.merchant))[0]?.status).toBe("DISPATCHING");
  });

  it("rejects mutable content fields and leaves zero command/attempt rows after draft drift", async () => {
    expect((await putReadyBinding(app)).statusCode).toBe(201);
    const mutable = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`,
      payload: {
        expected_state_version: 2, expected_task_revision: 2,
        expected_execution_spec_hash: seeded.executionSpecHash, scheduled_for: schedule,
        idempotency_key: "gate2-mutable", body: "changed",
      },
    });
    expect(mutable.statusCode).toBe(400);
    expect(mutable.json()).toMatchObject({ error_code: "GBP_COMMAND_CONTENT_IMMUTABLE" });

    await built.db.exec("UPDATE seo_content_drafts SET body='drifted' WHERE id=$1", [ids.draft]);
    const drift = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`,
      payload: {
        expected_state_version: 2, expected_task_revision: 2,
        expected_execution_spec_hash: seeded.executionSpecHash, scheduled_for: schedule,
        idempotency_key: "gate2-drift",
      },
    });
    expect(drift.statusCode).toBe(409);
    expect(drift.json()).toMatchObject({ error_code: "GBP_DRAFT_DRIFT" });
    expect((await built.db.one<{ n: string }>("SELECT COUNT(*) AS n FROM seo_gbp_commands"))?.n).toBe("0");
    expect(await listAttemptsByTask(built.db, ids.task, ids.merchant)).toEqual([]);
  });

  it.each([
    ["approval", "GBP_APPROVAL_DRIFT", async (ctx: AuthenticatedTestApp) => {
      await ctx.db.exec("UPDATE seo_tasks SET approval_decisions='[]' WHERE id=$1", [ids.task]);
    }],
    ["deliverable", "GBP_IMAGE_DRIFT", async (ctx: AuthenticatedTestApp) => {
      await ctx.db.exec("UPDATE seo_run_deliverables SET sha256=$1 WHERE id=$2", [`sha256:${"f".repeat(64)}`, ids.deliverable]);
    }],
    ["binding", "GBP_BINDING_REQUIRED", async (ctx: AuthenticatedTestApp) => {
      await ctx.db.exec("UPDATE seo_gbp_location_bindings SET status='BLOCKED', state_version=state_version+1 WHERE location_id=$1", [ids.location]);
    }],
    ["location", "GBP_BINDING_REQUIRED", async (ctx: AuthenticatedTestApp) => {
      await ctx.db.exec("UPDATE seo_locations SET external_identities='{}' WHERE id=$1", [ids.location]);
    }],
    ["image bytes", "GBP_IMAGE_DRIFT", async (_ctx: AuthenticatedTestApp, dir: string) => {
      await fs.writeFile(path.join(dir, "post.png"), Uint8Array.from([...png, 9]));
    }],
  ] as const)("creates no command when %s drifts", async (_label, errorCode, mutate) => {
    expect((await putReadyBinding(app)).statusCode).toBe(201);
    await mutate(built, tempDir);
    const response = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`,
      payload: {
        expected_state_version: 2, expected_task_revision: 2,
        expected_execution_spec_hash: seeded.executionSpecHash, scheduled_for: schedule,
        idempotency_key: `gate2-${String(_label).replaceAll(" ", "-")}-drift`,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: errorCode });
    expect((await built.db.one<{ n: string }>("SELECT COUNT(*) AS n FROM seo_gbp_commands"))?.n).toBe("0");
    expect(await listAttemptsByTask(built.db, ids.task, ids.merchant)).toEqual([]);
  });

  it("keeps the generic worker and manual verification paths closed to GBP writes", async () => {
    const task = await getTask(built.db, ids.task);
    expect(task).not.toBeNull();
    await built.db.exec(
      `INSERT INTO seo_execution_attempts
        (id,task_id,merchant_id,attempt_no,status,gate,probe_ref,started_at,created_at,updated_at)
       VALUES ('legacy-gbp-attempt',$1,$2,1,'DISPATCHING','G2','legacy-probe',$3,$3,$3)`,
      [ids.task, ids.merchant, now],
    );
    const trigger = vi.fn();
    const client = { trigger, getRun: vi.fn() } as unknown as CoreAiClient;
    const worker = new ExecutionWorker({ db: built.db, client, mockMode: false });
    await worker.pollOnce();
    expect(trigger).not.toHaveBeenCalled();
    expect((await built.db.one<{ status: string }>(
      "SELECT status FROM seo_execution_attempts WHERE id='legacy-gbp-attempt'",
    ))?.status).toBe("FAILED_CONFIRMED");

    await built.db.exec(
      "UPDATE seo_tasks SET status='PENDING_VERIFY', state_version=state_version+1 WHERE id=$1",
      [ids.task],
    );
    const refreshed = await getTask(built.db, ids.task);
    const verify = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${ids.task}/verification`,
      payload: { expected_state_version: refreshed!.stateVersion, idempotency_key: "manual-gbp-verify" },
    });
    expect(verify.statusCode).toBe(409);
    expect(verify.json()).toMatchObject({ error_code: "GBP_READBACK_REQUIRED" });

    await built.db.exec(
      "UPDATE seo_execution_attempts SET status='OUTCOME_UNKNOWN' WHERE id='legacy-gbp-attempt'",
    );
    await built.db.exec(
      "UPDATE seo_tasks SET status='OUTCOME_UNKNOWN', state_version=state_version+1 WHERE id=$1",
      [ids.task],
    );
    const unknown = await getTask(built.db, ids.task);
    const reconcile = await app.inject({
      method: "POST", url: "/api/seo-ops/attempts/legacy-gbp-attempt/outcome",
      payload: {
        resolution: "NOT_HAPPENED", expected_state_version: unknown!.stateVersion,
        idempotency_key: "manual-gbp-reconcile",
      },
    });
    expect(reconcile.statusCode).toBe(409);
    expect(reconcile.json()).toMatchObject({ error_code: "GBP_MANUAL_RECONCILIATION_FORBIDDEN" });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { executionSpecHash, sha256HashBytes } from "../src/domain/hashing.js";
import { hashGbpCommandBody, hashGbpCommandCta, hashGbpCommandImage } from "../src/domain/gbpExecutionContract.js";
import {
  claimNextGbpCommand,
  getGbpCommandByTaskRevision,
  getGbpCommandState,
  getGbpReceipt,
  markGbpCommandTriggering,
} from "../src/repos/gbpExecutionRepo.js";
import { insertAgentRun, upsertDeliverable } from "../src/repos/agentRunRepo.js";
import { insertDraft } from "../src/repos/draftRepo.js";
import { insertTask } from "../src/repos/taskRepo.js";
import { draftSha256 } from "../src/services/contentService.js";
import { resolveGbpCredential } from "../src/services/gbpCredentialResolver.js";
import {
  createGbpCoreAiClient,
  type GbpCoreAiClient,
  type GbpCoreRun,
} from "../src/services/gbpCoreAiClient.js";
import { GbpExecutionWorker } from "../src/services/gbpExecutionWorker.js";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

const ids = {
  merchant: "11111111-1111-4111-8111-111111111111",
  location: "22222222-2222-4222-8222-222222222222",
  task: "33333333-3333-4333-8333-333333333333",
  draft: "44444444-4444-4444-8444-444444444444",
  approval: "55555555-5555-4555-8555-555555555555",
  contentRun: "66666666-6666-4666-8666-666666666666",
  deliverable: "77777777-7777-4777-8777-777777777777",
  apiUser: "api:88888888-8888-4888-8888-888888888888",
  writeAgent: "99999999-9999-4999-8999-999999999999",
  readAgent: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  coreRun: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const now = "2026-08-27T12:00:00.000Z";
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const secretValue = "test-mounted-core-token-never-persist";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface CoreBehavior {
  identityUserId?: string;
  identityError?: Error;
  triggerError?: Error;
  missingRunId?: boolean;
  statuses?: string[];
  wrongAgent?: boolean;
  wrongInput?: boolean;
  output?: string;
}

class FakeCore implements GbpCoreAiClient {
  identityCalls = 0;
  triggerCalls = 0;
  getRunCalls = 0;
  private lastInput = "";
  private readonly statuses: string[];

  constructor(readonly behavior: CoreBehavior = {}) {
    this.statuses = [...(behavior.statuses ?? ["COMPLETED"])];
  }

  async getIdentity() {
    this.identityCalls += 1;
    if (this.behavior.identityError) throw this.behavior.identityError;
    return {
      userId: this.behavior.identityUserId ?? ids.apiUser,
      name: "George API user",
      role: "API_USER",
      permissions: ["agent.run"],
    };
  }

  async trigger(_agentId: string, input: string) {
    this.triggerCalls += 1;
    this.lastInput = input;
    if (this.behavior.triggerError) throw this.behavior.triggerError;
    return { runId: this.behavior.missingRunId ? "" : ids.coreRun, status: "RUNNING" };
  }

  async getRun(_runId: string): Promise<GbpCoreRun> {
    this.getRunCalls += 1;
    const status = this.statuses.shift() ?? "RUNNING";
    return {
      id: ids.coreRun,
      agentId: this.behavior.wrongAgent ? ids.readAgent : ids.writeAgent,
      status,
      input: this.behavior.wrongInput ? "{}" : this.lastInput,
      output: status === "COMPLETED" ? (this.behavior.output ?? null) : null,
    };
  }
}

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
  const body = "Fresh lunch specials are ready.";
  const draftDigest = draftSha256({
    body, ctaType: "ORDER", ctaUrl: "https://example.test/order", media: [mediaRef],
  });
  const executionSpec = JSON.stringify({
    locationName: "locations/987654321",
    content_draft: {
      draft_version: 1,
      draft_sha256: draftDigest,
      body,
      cta_type: "ORDER",
      cta_url: "https://example.test/order",
      media: [mediaRef],
    },
  });
  const specHash = executionSpecHash(executionSpec);
  await insertTask(db, {
    id: ids.task, merchantId: ids.merchant, cycleId: null, locationId: ids.location,
    taskType: "GBP_POST", source: "CYCLE", priority: "HIGH", impact: "HIGH",
    ownerId: null, dueAt: null, status: "APPROVED", evidenceState: "VERIFIED",
    taskRevision: 2, stateVersion: 2, title: "George GBP Post", executionSpec,
    executionSpecHash: specHash, requiredEvidenceTypes: ["CONTENT_DRAFT"], revisions: [],
    evidenceRefs: [], approvalDecisions: [{
      id: ids.approval, decision: "APPROVE", taskRevision: 2, executionSpecHash: specHash,
      expectedStateVersion: 1, resultingStateVersion: 2, actorId: "op-1", decidedAt: now,
    }],
    events: [], conversationLinks: [], agentRunLinks: [], executionMode: "AUTO_WRITE",
    proposalId: null, dependsOnTaskIds: [], attemptCount: 0, publishedRef: null,
    publishedAt: null, verifyDueAt: null, verifiedAt: null, verifiedBy: null,
    mutationKeys: {}, creationIdempotencyKey: null, requestFingerprint: null,
    createdBy: "op-1", createdAt: now, updatedAt: now,
  });
  await insertAgentRun(db, {
    id: ids.contentRun, merchantId: ids.merchant, locationId: ids.location,
    stage: "GBP_POST_CONTENT", taskId: ids.task, runType: "REPORT", goal: null,
    status: "COMPLETED", coreRunId: "core-content-run", traceRef: null,
    coreStatus: "COMPLETED", inputMessage: "{}", output: "{}", error: null,
    errorCode: null, tokenUsage: {}, triggeredBy: "op-1", triggeredAt: now,
    lastPolledAt: now, completedAt: now, creationIdempotencyKey: null,
    requestFingerprint: null, httpRequestFingerprint: null, businessInputFingerprint: null,
    retryOfAgentRunId: null, retryGeneration: 0, retryReason: null,
    createdBy: "op-1", createdAt: now, updatedAt: now,
  });
  await upsertDeliverable(db, {
    id: ids.deliverable, runId: ids.contentRun, kind: "ATTACHMENT", fileId: "image-1",
    fileName: "post.png", contentType: "image/png", size: png.byteLength,
    title: null, description: null, sha256: imageSha, localPath: imagePath,
    remoteUrl: "https://core.invalid/must-never-project", downloadedAt: now,
    downloadError: null, createdAt: now,
  });
  await insertDraft(db, {
    id: ids.draft, taskId: ids.task, agentRunId: ids.contentRun, mediaSourceAgentRunId: null,
    version: 1, body, ctaType: "ORDER", ctaUrl: "https://example.test/order",
    media: [mediaRef], source: "AGENT_GENERATED", feedback: null, sha256: draftDigest,
    createdBy: "op-1", createdAt: now,
  });
  return { specHash };
}

async function fixture(behavior: CoreBehavior = {}) {
  const built = await createAuthenticatedTestApp();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "seo-ops-gbp-worker-"));
  const secretDir = path.join(tempDir, "secrets");
  const imagePath = path.join(tempDir, "post.png");
  await fs.mkdir(secretDir, { mode: 0o700 });
  await fs.writeFile(imagePath, png);
  const secretPath = path.join(secretDir, "george-gbp-write");
  await fs.writeFile(secretPath, `${secretValue}\n`, { mode: 0o600 });
  await fs.chmod(secretPath, 0o600);
  const seeded = await seedApprovedGbpTask(built, imagePath);
  const binding = await built.inject({
    method: "PUT",
    url: `/api/seo-ops/merchants/${ids.merchant}/locations/${ids.location}/gbp-execution-binding`,
    payload: {
      expected_state_version: 0,
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
    },
  });
  expect(binding.statusCode).toBe(201);
  const confirmation = await built.inject({
    method: "POST",
    url: `/api/seo-ops/tasks/${ids.task}/execution-confirmations`,
    payload: {
      expected_state_version: 2,
      expected_task_revision: 2,
      expected_execution_spec_hash: seeded.specHash,
      scheduled_for: now,
      idempotency_key: "gbp-worker-fixture",
    },
  });
  expect(confirmation.statusCode).toBe(201);
  const command = await getGbpCommandByTaskRevision(
    built.db, ids.task, 2, ids.merchant, ids.location,
  );
  expect(command).not.toBeNull();
  const core = new FakeCore(behavior);
  const worker = new GbpExecutionWorker({
    db: built.db,
    coreAiBaseUrl: "https://core.example.test",
    secretDir,
    createClient: () => core,
    pollIntervalMs: 0,
    maxPolls: 2,
    sleep: async () => undefined,
  });
  cleanups.push(async () => {
    worker.stop();
    await built.app.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return { built, command: command!, core, worker, imagePath, secretPath };
}

function validReceipt(command: NonNullable<Awaited<ReturnType<typeof getGbpCommandByTaskRevision>>>) {
  return {
    schema_version: "seo_ops.gbp_execution_receipt.v1",
    instruction_id: command.command.instruction_id,
    command_sha256: command.commandSha256,
    provider_idempotency_key: command.command.provider_idempotency_key,
    probe_ref: command.command.probe_ref,
    operation: { kind: "CREATE_POST" },
    core_api_user_id: command.command.core.api_user_id,
    account_resource: command.command.gbp.account_resource,
    location_resource: command.command.gbp.location_resource,
    status: "APPLIED",
    provider_mutation_count: 1,
    provider_post_resource: "accounts/123456789/locations/987654321/localPosts/42",
    provider_request_id: "provider-request-42",
    applied_at: now,
    submitted: {
      body_sha256: hashGbpCommandBody(command.command),
      cta_sha256: hashGbpCommandCta(command.command),
      media_sha256: hashGbpCommandImage(command.command),
    },
  } as const;
}

describe("GBP mounted credential resolver", () => {
  it("reads one owner-only regular-file secret and trims only its trailing line break", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seo-ops-gbp-secret-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, "george-gbp-write");
    await fs.writeFile(target, "mounted-value\n", { mode: 0o600 });
    await fs.chmod(target, 0o600);
    expect(await resolveGbpCredential(root, "george-gbp-write")).toBe("mounted-value");
  });

  it.each(["../escape", "nested/secret", "nested\\secret", ".", "Bearer token"])(
    "rejects a non-basename secret reference without reflecting it: %s",
    async (unsafe) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "seo-ops-gbp-secret-ref-"));
      cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
      await expect(resolveGbpCredential(root, unsafe)).rejects.toSatisfy((error: unknown) =>
        error instanceof Error && !error.message.includes(unsafe));
    },
  );

  it("rejects symlink, permissive, empty, oversized and non-regular secret files with one redacted error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seo-ops-gbp-secret-files-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "real-secret"), secretValue, { mode: 0o600 });
    await fs.symlink(path.join(root, "real-secret"), path.join(root, "link-secret"));
    await fs.writeFile(path.join(root, "wide-secret"), secretValue, { mode: 0o640 });
    await fs.chmod(path.join(root, "wide-secret"), 0o640);
    await fs.writeFile(path.join(root, "empty-secret"), "\n", { mode: 0o600 });
    await fs.writeFile(path.join(root, "large-secret"), "x".repeat(4097), { mode: 0o600 });
    await fs.mkdir(path.join(root, "directory-secret"));
    for (const ref of ["link-secret", "wide-secret", "empty-secret", "large-secret", "directory-secret"]) {
      await expect(resolveGbpCredential(root, ref)).rejects.toMatchObject({
        message: "GBP credential unavailable",
      });
    }
  });
});

describe("GBP Core identity contract", () => {
  function identityClient(userId: string) {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user_id: userId,
      name: "George API user",
      role: "API_USER",
      permissions: ["agent.run"],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
    return createGbpCoreAiClient({
      baseUrl: "https://core.example.test",
      token: secretValue,
      fetchImpl,
    });
  }

  it("returns the exact api:<uuid> identity without normalization", async () => {
    await expect(identityClient(ids.apiUser).getIdentity()).resolves.toMatchObject({
      userId: ids.apiUser,
    });
  });

  it("rejects a bare UUID identity from /api/auth/me", async () => {
    await expect(identityClient(ids.apiUser.slice(4)).getIdentity()).rejects.toMatchObject({
      phase: "IDENTITY",
    });
  });
});

describe("GBP write worker configuration gate", () => {
  it("stays disabled by default and rejects partial or ambiguous enablement", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      gbpExecutionEnabled: false,
      gbpSecretDir: null,
    });
    expect(() => loadConfig({
      NODE_ENV: "test",
      SEO_OPS_GBP_EXECUTION_ENABLED: "true",
      CORE_AI_BASE_URL: "https://core.example.test",
    })).toThrow("SEO_OPS_GBP_SECRET_DIR");
    expect(() => loadConfig({
      NODE_ENV: "test",
      SEO_OPS_GBP_EXECUTION_ENABLED: "1",
    })).toThrow("SEO_OPS_GBP_EXECUTION_ENABLED");
    expect(loadConfig({
      NODE_ENV: "test",
      SEO_OPS_GBP_EXECUTION_ENABLED: "true",
      SEO_OPS_GBP_SECRET_DIR: "/var/run/secrets/seo-ops-gbp",
      CORE_AI_BASE_URL: "https://core.example.test",
    })).toMatchObject({
      gbpExecutionEnabled: true,
      gbpSecretDir: "/var/run/secrets/seo-ops-gbp",
      gbpExecutionPollIntervalMs: 10_000,
      gbpCorePollIntervalMs: 3_000,
      gbpCoreMaxPolls: 120,
    });
  });
});

describe("at-most-once GBP Core write worker", () => {
  it("lets two workers converge on one claim and moves a valid receipt only to READBACK_PENDING", async () => {
    const base = await fixture();
    base.core.behavior.output = JSON.stringify(validReceipt(base.command));
    const peer = new GbpExecutionWorker({
      db: base.built.db,
      coreAiBaseUrl: "https://core.example.test",
      secretDir: path.dirname(base.secretPath),
      createClient: () => base.core,
      pollIntervalMs: 0,
      maxPolls: 2,
      sleep: async () => undefined,
    });
    cleanups.push(async () => peer.stop());

    await Promise.all([
      base.worker.runOneGbpExecution("worker-a", new Date(now)),
      peer.runOneGbpExecution("worker-b", new Date(now)),
    ]);

    expect(base.core.triggerCalls).toBe(1);
    const state = await getGbpCommandState(
      base.built.db, base.command.id, ids.merchant, ids.location,
    );
    expect(state?.status).toBe("READBACK_PENDING");
    expect(state?.triggerStartedAt).toBe(now);
    expect(await getGbpReceipt(base.built.db, base.command.id, ids.merchant, ids.location)).not.toBeNull();
    const task = await base.built.db.one<{ status: string }>("SELECT status FROM seo_tasks WHERE id=$1", [ids.task]);
    expect(task?.status).toBe("EXECUTION_CONFIRMED");
  });

  it("revalidates and dispatches an operator-uploaded image from the frozen content Run", async () => {
    const f = await fixture();
    await f.built.db.exec("UPDATE seo_run_deliverables SET kind='MANUAL' WHERE id=$1", [ids.deliverable]);
    f.core.behavior.output = JSON.stringify(validReceipt(f.command));

    await f.worker.runOneGbpExecution("worker-manual-image", new Date(now));

    expect(f.core.triggerCalls).toBe(1);
    expect(await getGbpCommandState(
      f.built.db, f.command.id, ids.merchant, ids.location,
    )).toMatchObject({ status: "READBACK_PENDING", safeErrorCode: null });
  });

  it.each([
    ["Task", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.built.db.exec("UPDATE seo_tasks SET execution_spec_hash=$1 WHERE id=$2", [`sha256:${"f".repeat(64)}`, ids.task]);
    }, "TASK_DRIFT"],
    ["draft", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.built.db.exec("UPDATE seo_content_drafts SET body='drifted' WHERE id=$1", [ids.draft]);
    }, "TASK_DRIFT"],
    ["media", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await fs.writeFile(f.imagePath, Uint8Array.from([0, 1, 2]));
    }, "TASK_DRIFT"],
    ["binding", async (f: Awaited<ReturnType<typeof fixture>>) => {
      await f.built.db.exec("UPDATE seo_gbp_location_bindings SET state_version=state_version+1 WHERE location_id=$1", [ids.location]);
    }, "BINDING_DRIFT"],
  ])("blocks %s drift before any Core call", async (_name, mutate, expectedCode) => {
    const f = await fixture();
    await mutate(f);
    await f.worker.runOneGbpExecution("worker-drift", new Date(now));
    expect(f.core.identityCalls).toBe(0);
    expect(f.core.triggerCalls).toBe(0);
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({ status: "BLOCKED_PRE_SEND", safeErrorCode: expectedCode });
  });

  it("blocks a mismatched /api/auth/me identity before the trigger marker", async () => {
    const f = await fixture({ identityUserId: ids.readAgent });
    await f.worker.runOneGbpExecution("worker-auth", new Date(now));
    expect(f.core.triggerCalls).toBe(0);
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({
      status: "BLOCKED_PRE_SEND", safeErrorCode: "CONFIG_INVALID", triggerStartedAt: null,
    });
  });

  it.each([
    ["trigger timeout", { triggerError: new Error(`network failed ${secretValue}`) }],
    ["lost Run ID", { missingRunId: true }],
  ])("freezes %s as OUTCOME_UNKNOWN and never retries", async (_name, behavior) => {
    const f = await fixture(behavior);
    await f.worker.runOneGbpExecution("worker-trigger", new Date(now));
    await f.worker.runOneGbpExecution("worker-trigger-retry", new Date(now));
    expect(f.core.triggerCalls).toBe(1);
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({ status: "OUTCOME_UNKNOWN", safeErrorCode: "TRIGGER_AMBIGUOUS" });
    expect(JSON.stringify(state)).not.toContain(secretValue);
  });

  it("converts an expired post-marker crash to OUTCOME_UNKNOWN without another Core call", async () => {
    const f = await fixture();
    const claim = await claimNextGbpCommand(f.built.db, {
      merchantId: ids.merchant,
      locationId: ids.location,
      workerId: "crashed-worker",
      leaseToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      now,
      leaseExpiresAt: "2026-08-27T12:00:01.000Z",
    });
    expect(claim).not.toBeNull();
    expect(await markGbpCommandTriggering(f.built.db, {
      commandId: f.command.id,
      merchantId: ids.merchant,
      locationId: ids.location,
      expectedStateVersion: claim!.state.stateVersion,
      leaseOwner: claim!.state.leaseOwner!,
      leaseToken: claim!.state.leaseToken!,
      triggerStartedAt: now,
      updatedAt: now,
    })).not.toBeNull();

    await f.worker.runOneGbpExecution("recovery-worker", new Date("2026-08-27T12:00:02.000Z"));

    expect(f.core.identityCalls).toBe(0);
    expect(f.core.triggerCalls).toBe(0);
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({ status: "OUTCOME_UNKNOWN", safeErrorCode: "TRIGGER_AMBIGUOUS" });
  });

  it.each([
    ["wrong Agent", { wrongAgent: true }, "RECEIPT_MISMATCH"],
    ["command echo mismatch", { wrongInput: true }, "RECEIPT_MISMATCH"],
    ["Core failure", { statuses: ["FAILED"] }, "CORE_RUN_FAILED"],
    ["Core timeout", { statuses: ["RUNNING", "RUNNING"] }, "CORE_RUN_TIMEOUT"],
    ["Core cancellation", { statuses: ["CANCELLED"] }, "CORE_RUN_CANCELLED"],
    ["malformed receipt", { output: "not-json" }, "RECEIPT_INVALID"],
  ])("maps %s after the marker to OUTCOME_UNKNOWN", async (_name, behavior, expectedCode) => {
    const f = await fixture(behavior);
    if (!behavior.output && !behavior.statuses && !behavior.wrongAgent && !behavior.wrongInput) {
      behavior.output = JSON.stringify(validReceipt(f.command));
    }
    if (behavior.wrongAgent || behavior.wrongInput) {
      f.core.behavior.output = JSON.stringify(validReceipt(f.command));
    }
    await f.worker.runOneGbpExecution("worker-terminal", new Date(now));
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({ status: "OUTCOME_UNKNOWN", safeErrorCode: expectedCode });
    expect(f.core.triggerCalls).toBe(1);
  });

  it("rejects a receipt whose command echo or mutation contract does not exactly match", async () => {
    const f = await fixture();
    const receipt = validReceipt(f.command);
    f.core.behavior.output = JSON.stringify({
      ...receipt,
      provider_mutation_count: 0,
    });
    await f.worker.runOneGbpExecution("worker-receipt", new Date(now));
    const state = await getGbpCommandState(f.built.db, f.command.id, ids.merchant, ids.location);
    expect(state).toMatchObject({ status: "OUTCOME_UNKNOWN", safeErrorCode: "RECEIPT_INVALID" });
    expect(await getGbpReceipt(f.built.db, f.command.id, ids.merchant, ids.location)).toBeNull();
  });
});

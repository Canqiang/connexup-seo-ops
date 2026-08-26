import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { settleAttemptUnknown } from "../src/services/executionService.js";
import {
  insertAttempt,
  listAttemptsByTask,
  upsertAttemptDeliverable,
  type ExecutionAttempt,
} from "../src/repos/executionRepo.js";
import { getProposal } from "../src/repos/proposalRepo.js";
import { insertAgentRun, upsertDeliverable } from "../src/repos/agentRunRepo.js";
import type { AgentRun, RunDeliverable } from "../src/repos/agentRunTypes.js";
import { getTaskForUpdate } from "../src/repos/taskRepo.js";
import { addDraft } from "../src/services/contentService.js";
import { ExecutionWorker } from "../src/services/executionWorker.js";
import type { CoreAiClient } from "../src/services/coreAiClient.js";
import { sha256HashBytes } from "../src/domain/hashing.js";
import {
  insertSpecialistArtifact,
  type SpecialistArtifact,
} from "../src/repos/specialistArtifactRepo.js";

/** 执行域端到端：双门 → mock 派发 → 结算 → 核验；建议层判定；Ⓐ级周期调度；
 * OUTCOME_UNKNOWN 冻结与查证。mock 执行模式（无外部副作用）。 */

async function makeApp(): Promise<AuthenticatedTestApp> {
  return createAuthenticatedTestApp({
    configOverrides: { mockExecution: true },
  });
}

async function seedMerchant(app: FastifyInstance) {
  const merchant = (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "uws-bistro",
        display_name: "UWS Bistro",
        operator_user_ids: ["op-1"],
        idempotency_key: "m-exec-1",
      },
    })
  ).json();
  const location = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "uws",
        display_name: "Upper West Side",
        external_identities: { google_business: "locations/gbp-123" },
        readiness_status: "READY",
        idempotency_key: "l-exec-1",
      },
    })
  ).json();
  return { merchant, location };
}

async function activateGbpWrite(app: FastifyInstance, merchantId: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/api/seo-ops/merchants/${merchantId}/capabilities/GBP_WRITE`,
    payload: {
      asset: "GBP",
      external_ref: "locations/gbp-123",
      tech_connected: true,
      merchant_authorized: true,
    },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().status).toBe("ACTIVE");
}

async function bindAgent(app: FastifyInstance, key: string, agentId: string) {
  const res = await app.inject({
    method: "PUT",
    url: `/api/seo-ops/agent-bindings/${key}`,
    payload: { agent_id: agentId, agent_label: `${key} agent` },
  });
  expect(res.statusCode).toBe(200);
}

/** 建 GBP_POST 写入任务并走完：草稿 → 定稿 → 门 1 批准 → APPROVED。 */
async function approvedWriteTask(
  app: FastifyInstance,
  merchantId: string,
  locationId: string,
  key = "wt-1",
  executionMode: "AUTO_WRITE" | "MANUAL" = "AUTO_WRITE",
  requiredEvidenceTypes = ["CONTENT_DRAFT"],
  carryVerifiedEvidence = false,
) {
  const created = (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchantId,
        location_id: locationId,
        definition: {
          title: "周三 Post",
          task_type: "GBP_POST",
          source: "CYCLE",
          priority: "MEDIUM",
          impact: "MEDIUM",
          execution_spec: JSON.stringify({
            locationName: "locations/gbp-123",
            post_type: "UPDATE",
          }),
          required_evidence_types: requiredEvidenceTypes,
          execution_mode: executionMode,
        },
        idempotency_key: key,
      },
    })
  ).json();
  expect(created.execution_mode).toBe(executionMode);
  expect(created.status).toBe("NEEDS_INPUT");

  const draft = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${created.id}/drafts`,
      payload: { body: "本周新菜上线，欢迎来店。", source: "HUMAN_EDIT" },
    })
  ).json();
  expect(draft.version).toBe(1);

  const finalized = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${created.id}/drafts/1/finalize`,
      payload: {
        expected_state_version: created.state_version,
        idempotency_key: `${key}-final`,
      },
    })
  ).json();
  expect(finalized.status).toBe(carryVerifiedEvidence ? "NEEDS_INPUT" : "READY_FOR_APPROVAL");

  const readyForApproval = carryVerifiedEvidence ? (
    await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${created.id}/evidence`,
      payload: {
        type: "BEFORE_SCREENSHOT", source_ref: "https://example.test/evidence/before",
        captured_at: "2026-08-26T08:00:00.000Z", verification_status: "VERIFIED",
        requirement_key: "BEFORE_SCREENSHOT", expected_state_version: finalized.state_version,
        idempotency_key: `${key}-before`,
      },
    })
  ).json() : finalized;
  const approved = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${created.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: readyForApproval.task_revision,
        execution_spec_hash: readyForApproval.execution_spec_hash,
        expected_state_version: readyForApproval.state_version,
        idempotency_key: `${key}-approve`,
      },
    })
  ).json();
  expect(approved.status).toBe("APPROVED");
  return approved;
}

describe("执行域：双门 + mock 派发 + 核验", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchant: { id: string };
  let location: { id: string };

  beforeEach(async () => {
    built = await makeApp();
    app = built.app;
    ({ merchant, location } = await seedMerchant(app));
    await activateGbpWrite(app, merchant.id);
    await bindAgent(app, "GBP_EXECUTION", "agent-gbp-exec");
  });
  afterEach(() => app.close());

  it("Ⓒ 全链路：批准 → 门 2 六项全过 → mock 执行 → PENDING_VERIFY → 核验 DONE", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id);

    const preview = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${task.id}/execution-preview`,
      })
    ).json();
    expect(preview.confirmable).toBe(true);
    expect(preview.checks).toHaveLength(6);
    expect(preview.checks.find((c: { key: string }) => c.key === "dependencies_done")?.passed).toBe(true);
    expect(preview.checks.every((c: { passed: boolean }) => c.passed)).toBe(true);

    const confirmed = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
        payload: {
          expected_state_version: task.state_version,
          idempotency_key: "exec-1",
        },
      })
    ).json();
    expect(confirmed.status).toBe("DISPATCHING");
    expect(confirmed.attempt_count).toBe(1);

    // mock worker tick：立即成功 → 写入类进入待核验
    const tick = await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(tick.statusCode).toBe(200);

    const afterRun = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` })
    ).json();
    expect(afterRun.status).toBe("PENDING_VERIFY");
    expect(afterRun.published_ref).toContain("mock:exec-");
    expect(afterRun.verify_due_at).toBeTruthy();

    const attempts = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/attempts` })
    ).json();
    expect(attempts.items).toHaveLength(1);
    expect(attempts.items[0]).toMatchObject({ status: "SUCCEEDED", gate: "G2", attempt_no: 1 });

    const done = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/verification`,
        payload: {
          note: "GBP 前台可见",
          expected_state_version: afterRun.state_version,
          idempotency_key: "verify-1",
        },
      })
    ).json();
    expect(done.status).toBe("DONE");
    expect(done.verified_by).toBeTruthy();
  });

  it("门 2 拒绝：能力 BLOCKED 时 preview 不可确认、confirm 409", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-2");
    // 商户撤销授权 → BLOCKED
    await app.inject({
      method: "PUT",
      url: `/api/seo-ops/merchants/${merchant.id}/capabilities/GBP_WRITE`,
      payload: {
        asset: "GBP",
        tech_connected: true,
        merchant_authorized: false,
      },
    });

    const preview = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${task.id}/execution-preview`,
      })
    ).json();
    expect(preview.confirmable).toBe(false);
    const capCheck = preview.checks.find((c: { key: string }) => c.key === "capability_active");
    expect(capCheck.passed).toBe(false);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "exec-2" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe("GATE2_CHECK_FAILED");
  });

  it("MANUAL is rejected by both execution preview and confirm, while explicit human completion records evidence without attempts", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-manual", "MANUAL");

    const preview = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/execution-preview` });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error_code).toBe("MANUAL_EXECUTION_ONLY");

    const confirm = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "manual-confirm" },
    });
    expect(confirm.statusCode).toBe(409);
    expect(confirm.json().error_code).toBe("MANUAL_EXECUTION_ONLY");
    expect((await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/attempts` })).json().items).toEqual([]);

    const completed = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${task.id}/manual-completions`,
      payload: {
        source_ref: "https://example.test/manual-proof/receipt-1",
        note: "运营已在外部资产完成该动作并回读。",
        expected_state_version: task.state_version,
        idempotency_key: "manual-complete",
      },
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json()).toMatchObject({ status: "DONE", state_version: task.state_version + 1 });
    expect(completed.json().evidence_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "MANUAL_COMPLETION", source_ref: "https://example.test/manual-proof/receipt-1" }),
    ]));
    const readback = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` });
    expect(readback.json()).toMatchObject({ status: "DONE", state_version: task.state_version + 1 });
    expect((await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/attempts` })).json().items).toEqual([]);
  });

  it("draft revisions serialize task state and leave no orphan draft or evidence on losing requests", async () => {
    const same = await approvedWriteTask(app, merchant.id, location.id, "wt-race-same");
    const samePayload = { body: "并发改稿内容", source: "HUMAN_EDIT", expected_state_version: same.state_version, idempotency_key: "same-key" };
    const [sameA, sameB] = await Promise.all([
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${same.id}/draft-revisions`, payload: samePayload }),
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${same.id}/draft-revisions`, payload: samePayload }),
    ]);
    expect([sameA.statusCode, sameB.statusCode].sort()).toEqual([200, 201]);
    expect(sameA.json().task_revision).toBe(sameB.json().task_revision);

    const clash = await approvedWriteTask(app, merchant.id, location.id, "wt-race-clash");
    const [clashA, clashB] = await Promise.all([
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${clash.id}/draft-revisions`, payload: { body: "版本 A", source: "HUMAN_EDIT", expected_state_version: clash.state_version, idempotency_key: "shared-key" } }),
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${clash.id}/draft-revisions`, payload: { body: "版本 B", source: "HUMAN_EDIT", expected_state_version: clash.state_version, idempotency_key: "shared-key" } }),
    ]);
    expect([clashA.statusCode, clashB.statusCode].sort()).toEqual([201, 409]);
    expect([clashA, clashB].find((result) => result.statusCode === 409)!.json().error_code).toBe("IDEMPOTENCY_CONFLICT");

    const stale = await approvedWriteTask(app, merchant.id, location.id, "wt-race-stale");
    const [staleA, staleB] = await Promise.all([
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${stale.id}/draft-revisions`, payload: { body: "版本 A", source: "HUMAN_EDIT", expected_state_version: stale.state_version, idempotency_key: "key-a" } }),
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${stale.id}/draft-revisions`, payload: { body: "版本 B", source: "HUMAN_EDIT", expected_state_version: stale.state_version, idempotency_key: "key-b" } }),
    ]);
    expect([staleA.statusCode, staleB.statusCode].sort()).toEqual([201, 409]);
    expect([staleA, staleB].find((result) => result.statusCode === 409)!.json().error_code).toBe("STALE_STATE");
    const drafts = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${stale.id}/drafts` });
    expect(drafts.json().items).toHaveLength(2);
    const readback = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${stale.id}` });
    expect(readback.json().evidence_refs.filter((item: { task_revision: number }) => item.task_revision === stale.task_revision + 1)).toHaveLength(1);
  });

  it("legacy drafts and revision drafts share the task lock without a duplicate-version 500", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-cross-draft-lock");
    const [legacy, revision] = await Promise.all([
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${task.id}/drafts`, payload: { body: "旧入口改稿", source: "HUMAN_EDIT" } }),
      app.inject({ method: "POST", url: `/api/seo-ops/tasks/${task.id}/draft-revisions`, payload: { body: "新入口改稿", source: "HUMAN_EDIT", expected_state_version: task.state_version, idempotency_key: "cross-endpoint-key" } }),
    ]);
    expect([legacy.statusCode, revision.statusCode]).not.toContain(500);
    expect([legacy.statusCode, revision.statusCode]).toContain(201);
    expect(revision.statusCode === 409 ? revision.json().error_code : revision.json().status).toBeTruthy();
    const drafts = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/drafts` });
    const versions = drafts.json().items.map((draft: { version: number }) => draft.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("legacy draft allocation waits for the Task aggregate lock", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-legacy-lock-wait");
    let releaseLock!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
    const lockTransaction = built.db.withTransaction(async (tx) => {
      await getTaskForUpdate(tx, task.id);
      locked();
      await lockReleased;
    });
    await lockReady;

    let created = false;
    const pending = addDraft(built.db, task.id, { body: "锁期间的旧入口草稿", source: "HUMAN_EDIT" }, "op-1")
      .then(() => { created = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(created).toBe(false);
    } finally {
      releaseLock();
      await lockTransaction;
      await pending;
    }
  });

  it("audit references fail closed for a cross-merchant task-linked Agent Run", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-audit-scope");
    const now = "2026-08-26T08:00:00.000Z";
    const foreignRun: AgentRun = {
      id: "foreign-task-linked-run", merchantId: "foreign-merchant", locationId: null,
      stage: "KEYWORDS", taskId: task.id, runType: "KEYWORD_RESEARCH", goal: null,
      status: "COMPLETED", coreRunId: "foreign-core-run", traceRef: "https://foreign.example/trace",
      coreStatus: "COMPLETED", inputMessage: "private", output: "private output", error: null,
      errorCode: null, tokenUsage: {}, triggeredBy: "foreign", triggeredAt: now,
      lastPolledAt: now, completedAt: now, creationIdempotencyKey: null,
      requestFingerprint: null, createdBy: "foreign", createdAt: now, updatedAt: now,
    };
    await insertAgentRun(built.db, foreignRun);
    await built.db.exec("UPDATE seo_tasks SET agent_run_links = $1 WHERE id = $2", [
      JSON.stringify([{ agentRunId: foreignRun.id, relationship: "EXECUTION", linkedBy: "foreign", linkedAt: now }]), task.id,
    ]);

    const response = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references` });
    expect(response.statusCode).toBe(200);
    expect(response.json().agent_runs).toEqual([]);
    expect(JSON.stringify(response.json())).not.toContain("foreign-core-run");
  });

  it("task audit and child reads exclude corrupt cross-merchant attempts, deliverables, and artifacts", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-audit-child-scope");
    const now = "2026-08-26T08:00:00.000Z";
    const foreignAttempt: ExecutionAttempt = {
      id: "foreign-task-attempt", taskId: task.id, merchantId: "foreign-merchant", attemptNo: 99,
      status: "SUCCEEDED", gate: "G2", agentRunId: "foreign-attempt-run",
      coreRunId: "foreign-attempt-core", traceRef: "foreign-attempt-trace",
      probeRef: "foreign-attempt-probe", error: null, startedAt: now, triggerStartedAt: null,
      resolvedAt: now, resolvedBy: "foreign-operator", resolution: null, resolutionNote: null,
      createdAt: now, updatedAt: now,
    };
    const foreignArtifact: SpecialistArtifact = {
      id: "foreign-task-artifact", taskId: task.id, merchantId: "foreign-merchant",
      artifactType: "AUDIT_REPORT", schemaVersion: "v1", title: "foreign title",
      summary: "foreign summary", payload: { private: true }, coreRunId: "foreign-artifact-core",
      createdBy: "foreign-operator", createdAt: now,
    };
    await insertAttempt(built.db, foreignAttempt);
    await upsertAttemptDeliverable(built.db, {
      id: "foreign-attempt-deliverable", attemptId: foreignAttempt.id, fileId: "foreign-file",
      fileName: "foreign.json", contentType: "application/json", sha256: "sha256:foreign",
      sourceRef: "https://foreign.example/private?token=secret", createdAt: now,
    });
    await insertSpecialistArtifact(built.db, foreignArtifact);

    const audit = await app.inject({
      method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references?limit=50`,
    });
    const attempts = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/attempts` });
    const artifacts = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/artifacts` });

    expect(audit.statusCode).toBe(200);
    expect(attempts.statusCode).toBe(200);
    expect(artifacts.statusCode).toBe(200);
    expect(JSON.stringify(audit.json())).not.toContain("foreign-");
    expect(attempts.json().items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: foreignAttempt.id }),
    ]));
    expect(artifacts.json().items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: foreignArtifact.id }),
    ]));
  });

  it("audit references page task runs and attach deliverables through the bounded batch projection", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-audit-page");
    const base: Omit<AgentRun, "id" | "coreRunId" | "createdAt" | "updatedAt"> = {
      merchantId: merchant.id, locationId: location.id, stage: "KEYWORDS", taskId: task.id,
      runType: "KEYWORD_RESEARCH", goal: null, status: "COMPLETED", traceRef: null,
      coreStatus: "COMPLETED", inputMessage: "bounded", output: null, error: null, errorCode: null,
      tokenUsage: {}, triggeredBy: "op-1", triggeredAt: "2026-08-26T08:00:00.000Z",
      lastPolledAt: null, completedAt: "2026-08-26T08:01:00.000Z", creationIdempotencyKey: null,
      requestFingerprint: null, createdBy: "op-1",
    };
    const older: AgentRun = { ...base, id: "audit-run-older", coreRunId: "audit-core-older", createdAt: "2026-08-26T08:00:00.000Z", updatedAt: "2026-08-26T08:00:00.000Z" };
    const newer: AgentRun = { ...base, id: "audit-run-newer", coreRunId: "audit-core-newer", createdAt: "2026-08-26T09:00:00.000Z", updatedAt: "2026-08-26T09:00:00.000Z" };
    await insertAgentRun(built.db, older);
    await insertAgentRun(built.db, newer);
    const deliverable: RunDeliverable = {
      id: "audit-deliverable-newer", runId: newer.id, kind: "ATTACHMENT", fileId: "audit-file-newer",
      fileName: "newer.json", contentType: "application/json", size: 4, title: null, description: null,
      sha256: "sha256:audit-newer", localPath: null, remoteUrl: "https://example.test/audit/newer",
      downloadedAt: null, downloadError: null, createdAt: newer.createdAt,
    };
    await upsertDeliverable(built.db, deliverable);

    const page = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references?limit=1&offset=0` });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ offset: 0, limit: 1, total: expect.any(Number) });
    expect(page.json().agent_runs).toEqual([expect.objectContaining({
      id: newer.id, deliverables: [expect.objectContaining({ id: deliverable.id, file_id: deliverable.fileId })],
    })]);
  });

  it("audit reference pagination rejects negative, fractional, non-finite, and over-bound offsets", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-audit-invalid-page");
    for (const offset of ["-1", "1.5", "NaN", "Infinity", "10001"]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${task.id}/audit-references?offset=${encodeURIComponent(offset)}&limit=20`,
      });
      expect(response.statusCode, `offset=${offset}`).toBe(400);
    }
  });

  it("terminal execution persists its Core trace and deliverable refs for the bounded task audit", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-execution-audit");
    const confirmed = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "execution-audit-confirm" },
    });
    expect(confirmed.statusCode).toBe(201);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const core: CoreAiClient = {
      async trigger() { return { run_id: "core-execution-audit", status: "RUNNING" }; },
      async getRun() {
        return {
          id: "core-execution-audit", agent_id: "agent-gbp-exec", status: "COMPLETED",
          trace_id: "trace-execution-audit-full", artifacts: [{
            file_id: "file-execution-audit-full", file_name: "receipt.json",
            content_type: "application/json", size: bytes.byteLength,
            download_url: "https://example.test/files/receipt.json?X-Amz-Signature=terminal-secret#download",
          }],
        };
      },
      async cancel() { /* no-op */ },
      async downloadArtifact() { return bytes; },
    };
    const worker = new ExecutionWorker({ db: built.db, client: core, mockMode: false });
    await worker.pollOnce();
    await worker.pollOnce();

    const audit = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references?limit=5` });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().execution_attempts).toEqual([expect.objectContaining({
      id: expect.any(String), core_run_id: "core-execution-audit", trace_ref: "trace-execution-audit-full",
      probe_ref: expect.stringContaining(`exec-${task.id.slice(0, 8)}-rev`),
      deliverables: [expect.objectContaining({ file_id: "file-execution-audit-full", sha256: sha256HashBytes(bytes), source_ref: "https://example.test/files/receipt.json" })],
    })]);
    expect(JSON.stringify(audit.json())).not.toContain("terminal-secret");
  });

  it("terminal reference hashing skips artifacts whose declared size exceeds the worker byte cap", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-execution-declared-oversize");
    const confirmed = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "execution-declared-oversize" },
    });
    expect(confirmed.statusCode).toBe(201);
    let downloadCount = 0;
    const core: CoreAiClient = {
      async trigger() { return { run_id: "core-declared-oversize", status: "RUNNING" }; },
      async getRun() {
        return {
          id: "core-declared-oversize", agent_id: "agent-gbp-exec", status: "COMPLETED",
          artifacts: [{
            file_id: "file-declared-oversize", file_name: "huge.bin",
            content_type: "application/octet-stream", size: 100_000_000,
            download_url: "https://core.example/files/huge.bin",
          }],
        };
      },
      async cancel() { /* no-op */ },
      async downloadArtifact() { downloadCount += 1; return new Uint8Array([1]); },
    };
    const worker = new ExecutionWorker({ db: built.db, client: core, mockMode: false });
    await worker.pollOnce();
    await worker.pollOnce();

    const audit = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references` });
    expect(downloadCount).toBe(0);
    expect(audit.json().execution_attempts[0].deliverables).toEqual([
      expect.objectContaining({ file_id: "file-declared-oversize" }),
    ]);
    expect(audit.json().execution_attempts[0].deliverables[0]).not.toHaveProperty("sha256");
  });

  it("terminal hashing shares one aggregate deadline and never logs artifact URLs or credentials", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-execution-hash-budget");
    const confirmed = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "execution-hash-budget" },
    });
    expect(confirmed.statusCode).toBe(201);
    const started: string[] = [];
    const logs: string[] = [];
    const core: CoreAiClient = {
      async trigger() { return { run_id: "core-hash-budget", status: "RUNNING" }; },
      async getRun() {
        return {
          id: "core-hash-budget", agent_id: "agent-gbp-exec", status: "COMPLETED",
          artifacts: [1, 2, 3].map((item) => ({
            file_id: `budget-file-${item}`, file_name: `budget-${item}.bin`, size: 1,
            download_url: `https://core.example/files/${item}?token=terminal-budget-secret`,
          })),
        };
      },
      async cancel() { /* no-op */ },
      async downloadArtifact(url, options) {
        started.push(url);
        return new Promise<Uint8Array>((resolve, reject) => {
          const timer = setTimeout(() => resolve(new Uint8Array([1])), 40);
          const rejectForAbort = () => {
            clearTimeout(timer);
            reject(new Error("download failed for ?token=terminal-budget-secret"));
          };
          if (options?.signal?.aborted) rejectForAbort();
          else options?.signal?.addEventListener("abort", rejectForAbort, { once: true });
        });
      },
    };
    const worker = new ExecutionWorker({
      db: built.db,
      client: core,
      mockMode: false,
      terminalArtifactHashBudgetMs: 10,
      log: (message, err) => logs.push(`${message} ${String(err ?? "")}`),
    });
    await worker.pollOnce();
    await worker.pollOnce();

    const audit = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/audit-references` });
    const deliverables = audit.json().execution_attempts[0].deliverables;
    expect(started).toHaveLength(1);
    expect(deliverables).toHaveLength(3);
    for (const deliverable of deliverables) expect(deliverable).not.toHaveProperty("sha256");
    expect(logs.join("\n")).not.toContain("terminal-budget-secret");
  });

  it("approved content edit atomically creates a new revision and requires fresh approval", async () => {
    const approved = await approvedWriteTask(app, merchant.id, location.id, "wt-content-edit");

    const edited = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${approved.id}/draft-revisions`,
      payload: {
        body: "本周新菜改版，欢迎到店。",
        source: "HUMAN_EDIT",
        expected_state_version: approved.state_version,
        idempotency_key: "wt-content-edit-revision",
      },
    });
    expect(edited.statusCode).toBe(201);
    expect(edited.json()).toMatchObject({
      task_revision: approved.task_revision + 1,
      state_version: approved.state_version + 1,
      status: "READY_FOR_APPROVAL",
    });
    expect(edited.json().execution_spec_hash).not.toBe(approved.execution_spec_hash);
    expect(edited.json().execution_spec).toContain("本周新菜改版，欢迎到店。");
    expect(edited.json().evidence_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_revision: approved.task_revision + 1, requirement_key: "CONTENT_DRAFT" }),
    ]));

    const readback = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${approved.id}` });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toMatchObject({
      task_revision: approved.task_revision + 1,
      state_version: approved.state_version + 1,
      status: "READY_FOR_APPROVAL",
    });
    const drafts = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${approved.id}/drafts` });
    expect(drafts.json().items).toHaveLength(2);
    expect(readback.json().approval_decisions).toHaveLength(1);
  });

  it("draft revision explicitly carries forward only verified non-content evidence", async () => {
    const approved = await approvedWriteTask(
      app, merchant.id, location.id, "wt-content-reuse", "AUTO_WRITE",
      ["CONTENT_DRAFT", "BEFORE_SCREENSHOT"], true,
    );
    const edited = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${approved.id}/draft-revisions`,
      payload: { body: "改稿后保留截图证据", source: "HUMAN_EDIT", expected_state_version: approved.state_version, idempotency_key: "reuse-edit" },
    });
    expect(edited.statusCode).toBe(201);
    expect(edited.json().status).toBe("READY_FOR_APPROVAL");
    const carried = edited.json().evidence_refs.filter((item: { task_revision: number }) => item.task_revision === approved.task_revision + 1);
    expect(carried).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "CONTENT_DRAFT" }),
      expect.objectContaining({ type: "BEFORE_SCREENSHOT", reused_from_evidence_id: expect.any(String) }),
    ]));

    const missing = (
      await app.inject({
        method: "POST", url: "/api/seo-ops/tasks",
        payload: {
          merchant_id: merchant.id, location_id: location.id,
          definition: {
            title: "缺少截图的内容任务", task_type: "GBP_POST", source: "CYCLE", priority: "MEDIUM", impact: "MEDIUM",
            execution_spec: JSON.stringify({ locationName: "locations/gbp-123" }),
            required_evidence_types: ["CONTENT_DRAFT", "BEFORE_SCREENSHOT"], execution_mode: "AUTO_WRITE",
          }, idempotency_key: "wt-content-missing",
        },
      })
    ).json();
    const missingEdited = await app.inject({
      method: "POST", url: `/api/seo-ops/tasks/${missing.id}/draft-revisions`,
      payload: { body: "只有内容，没有截图", source: "HUMAN_EDIT", expected_state_version: missing.state_version, idempotency_key: "missing-edit" },
    });
    expect(missingEdited.statusCode).toBe(201);
    expect(missingEdited.json()).toMatchObject({ status: "NEEDS_INPUT", evidence_state: "PARTIAL" });
  });

  it("OUTCOME_UNKNOWN 冻结商户执行链；查证「没发生」后任务回 APPROVED 并解冻", async () => {
    const task = await approvedWriteTask(app, merchant.id, location.id, "wt-3");
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/execution-confirmations`,
      payload: { expected_state_version: task.state_version, idempotency_key: "exec-3" },
    });
    // 人为制造结果不明（模拟超时/网络裂缝）
    const [attempt] = await listAttemptsByTask(built.db, task.id, task.merchant_id);
    await settleAttemptUnknown(built.db, attempt!, "simulated timeout", "system:test");

    const frozen = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` })
    ).json();
    expect(frozen.status).toBe("OUTCOME_UNKNOWN");

    // 同商户第二个任务：门 2 的在途/冻结面校验拦截
    const other = await approvedWriteTask(app, merchant.id, location.id, "wt-4");
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${other.id}/execution-confirmations`,
      payload: { expected_state_version: other.state_version, idempotency_key: "exec-4" },
    });
    expect(res.statusCode).toBe(409);

    // 总览徽标暴露冻结商户
    const summary = (
      await app.inject({ method: "GET", url: "/api/seo-ops/inbox-summary" })
    ).json();
    expect(summary.outcome_unknown).toBe(1);
    expect(summary.frozen_merchant_ids).toContain(merchant.id);

    // 查证：没发生 → attempt FAILED_CONFIRMED，任务回 APPROVED，冻结解除
    const resolved = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/attempts/${attempt!.id}/outcome`,
        payload: {
          resolution: "NOT_HAPPENED",
          note: "GBP 后台无该帖",
          expected_state_version: frozen.state_version,
          idempotency_key: "resolve-1",
        },
      })
    ).json();
    expect(resolved.status).toBe("APPROVED");

    const preview = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${other.id}/execution-preview`,
      })
    ).json();
    expect(preview.confirmable).toBe(true);
  });
});

describe("建议层：批次校验 → 判定 → 采纳建任务", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchant: { id: string };

  beforeEach(async () => {
    built = await makeApp();
    app = built.app;
    ({ merchant } = await seedMerchant(app));
    await bindAgent(app, "REPORT", "agent-report");
  });
  afterEach(() => app.close());

  const batchPayload = (key = "batch-1") => ({
    merchant_id: merchant.id,
    origin: "PLANNER",
    trigger_reason: "月度快照恶化",
    idempotency_key: key,
    items: [
      {
        title: "重跑表现报告",
        task_type: "REPORT",
        execution_mode: "READ_ONLY",
        priority: "MEDIUM",
        impact: "MEDIUM",
        execution_spec: '{"cycle":"ADHOC_REPORT"}',
      },
      {
        title: "依赖不存在的条目",
        task_type: "REPORT",
        execution_mode: "READ_ONLY",
        depends_on: [9],
        priority: "LOW",
        impact: "LOW",
        execution_spec: '{"x":1}',
      },
    ],
  });

  it("机器校验失败的条目只能退回；合法条目采纳后建出回链任务；批次判定完自动 CLOSED", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: batchPayload(),
    });
    expect(createRes.statusCode).toBe(201);
    const batch = createRes.json();
    expect(batch.proposals).toHaveLength(2);
    const [ok, bad] = batch.proposals;
    expect(ok.status).toBe("PENDING");
    expect(bad.status).toBe("VALIDATION_FAILED");
    expect(bad.validation_failures).toContain("DEPENDS_MISSING:9");

    // 幂等重放
    const replay = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: batchPayload(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(batch.id);

    // 坏建议采纳被拒
    const adoptBad = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${bad.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(adoptBad.statusCode).toBe(409);

    // 采纳好建议 → 任务落库并回链
    const adopted = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/proposals/${ok.id}/decision`,
        payload: { action: "ADOPT" },
      })
    ).json();
    expect(adopted.proposal.status).toBe("ADOPTED");
    expect(adopted.task_id).toBeTruthy();

    const task = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${adopted.task_id}` })
    ).json();
    expect(task.proposal_id).toBe(ok.id);
    expect(task.source).toBe("PROPOSAL");
    expect(task.execution_mode).toBe("READ_ONLY");
    // 采纳即授权（Ⓐ级只读）：判定人即批准人，任务直接进入派发，不再走二次 G1
    expect(task.status).toBe("DISPATCHING");
    expect(task.attempt_count).toBe(1);

    // 退回坏建议（必填理由）→ 批次自动关闭
    const returnNoReason = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${bad.id}/decision`,
      payload: { action: "RETURN" },
    });
    expect(returnNoReason.statusCode).toBe(400);

    await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${bad.id}/decision`,
      payload: { action: "RETURN", return_reason: "依赖无效，请 Planner 重新出" },
    });
    const closed = (
      await app.inject({ method: "GET", url: `/api/seo-ops/proposal-batches/${batch.id}` })
    ).json();
    expect(closed.status).toBe("CLOSED");
  });

  it("缺少 cycle 的遗留批次采纳失败时保持 PENDING，重试也不会留下孤儿 ADOPTED 建议", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "legacy-cycle-missing",
        items: [
          {
            title: "遗留建议",
            task_type: "REPORT",
            execution_mode: "READ_ONLY",
            priority: "MEDIUM",
            impact: "MEDIUM",
            execution_spec: "{}",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    const proposal = batch.proposals[0];
    await built.db.exec("UPDATE seo_proposal_batches SET cycle_id = NULL WHERE id = $1", [batch.id]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const adopted = await app.inject({
        method: "POST",
        url: `/api/seo-ops/proposals/${proposal.id}/decision`,
        payload: { action: "ADOPT" },
      });
      expect(adopted.statusCode).toBe(409);
      expect(adopted.json().error_code).toBe("CYCLE_MISSING");

      const persisted = await getProposal(built.db, proposal.id);
      expect(persisted?.status).toBe("PENDING");
      expect(persisted?.taskId).toBeNull();
      const taskCount = await built.db.one<{ count: string }>(
        "SELECT COUNT(*) AS count FROM seo_tasks WHERE proposal_id = $1",
        [proposal.id],
      );
      expect(Number(taskCount?.count ?? 0)).toBe(0);
    }
  });

  it("已关联任务的 ADOPTED 遗留批次回放仍返回原任务，不因缺 cycle 重新采纳", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "legacy-cycle-linked-replay",
        items: [
          {
            title: "已采纳遗留建议",
            task_type: "REPORT",
            execution_mode: "READ_ONLY",
            priority: "MEDIUM",
            impact: "MEDIUM",
            execution_spec: "{}",
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const batch = created.json();
    const proposal = batch.proposals[0];
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${proposal.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(first.statusCode).toBe(200);
    const taskId = first.json().task_id;
    await built.db.exec("UPDATE seo_proposal_batches SET cycle_id = NULL WHERE id = $1", [batch.id]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${proposal.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().task_id).toBe(taskId);
    const persisted = await getProposal(built.db, proposal.id);
    expect(persisted?.status).toBe("ADOPTED");
    expect(persisted?.taskId).toBe(taskId);
    const taskCount = await built.db.one<{ count: string }>(
      "SELECT COUNT(*) AS count FROM seo_tasks WHERE proposal_id = $1",
      [proposal.id],
    );
    expect(Number(taskCount?.count ?? 0)).toBe(1);
  });

  it("PLAN_CONVERT 采纳后保留 PLAN 来源并将只读任务视为已确认授权", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        ...batchPayload("batch-plan-convert"),
        origin: "PLAN_CONVERT",
        items: [batchPayload().items[0]],
      },
    });
    expect(created.statusCode).toBe(201);
    const proposal = created.json().proposals[0];

    const adopted = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${proposal.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(adopted.statusCode).toBe(200);

    const task = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${adopted.json().task_id}` })
    ).json();
    expect(task.source).toBe("PLAN");
    expect(task.status).toBe("DISPATCHING");
  });

  it("未绑定 agent 的写入建议在创建时报 AGENT_NOT_BOUND", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "batch-2",
        items: [
          {
            title: "改官网栏目",
            task_type: "WEBSITE_CONTENT",
            execution_mode: "AUTO_WRITE",
            priority: "HIGH",
            impact: "HIGH",
            execution_spec: "{}",
          },
        ],
      },
    });
    const [p] = res.json().proposals;
    expect(p.status).toBe("VALIDATION_FAILED");
    expect(p.validation_failures).toContain("AGENT_NOT_BOUND:WEBSITE_CONTENT");
    expect(p.validation_failures).toContain("CAPABILITY_MISSING:WEBSITE_WRITE");
  });

  it("红线①防线：写入型任务类型标 READ_ONLY 的建议只能 VALIDATION_FAILED，采纳建任务同样被拒", async () => {
    // 一条「伪装成只读」的 GBP_POST 建议：若放行会绕过 G1/G2/能力矩阵直接派发到写入 agent
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "PLANNER",
        idempotency_key: "batch-disguised",
        items: [
          {
            title: "发一条周末 Post（伪装只读）",
            task_type: "GBP_POST",
            execution_mode: "READ_ONLY",
            priority: "MEDIUM",
            impact: "MEDIUM",
            execution_spec: JSON.stringify({ locationName: "locations/x" }),
          },
        ],
      },
    });
    const [p] = res.json().proposals;
    expect(p.status).toBe("VALIDATION_FAILED");
    expect(p.validation_failures).toContain("MODE_NOT_ALLOWED:GBP_POST:READ_ONLY");

    // 直接建任务这条路也要被同一张兼容表拦住（防御纵深）
    const direct = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        idempotency_key: "task-disguised",
        definition: {
          title: "伪装只读的 Post",
          task_type: "GBP_POST",
          source: "MANUAL",
          priority: "MEDIUM",
          impact: "MEDIUM",
          execution_spec: "{}",
          required_evidence_types: [],
          execution_mode: "READ_ONLY",
        },
      },
    });
    expect(direct.statusCode).toBe(400);
    expect(direct.json().message).toContain("not allowed for task_type");
  });
});

describe("Ⓐ级周期调度：配置即预授权，自动建任务→授权→派发→DONE", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchant: { id: string };

  beforeEach(async () => {
    built = await makeApp();
    app = built.app;
    ({ merchant } = await seedMerchant(app));
    for (const key of ["KEYWORD_WEEKLY", "AUDIT", "REVIEW", "REPORT"]) {
      await bindAgent(app, key, `agent-${key.toLowerCase()}`);
    }
  });
  afterEach(() => app.close());

  it("周期任务幂等生成；只读任务自动授权派发，mock 执行后 DONE；Ⓑ Post 停在双门前", async () => {
    const now = new Date();
    const res = await app.inject({
      method: "PUT",
      url: `/api/seo-ops/merchants/${merchant.id}/cycle-config`,
      payload: {
        snapshot_day: null, // 月度报告不在本测试断言（避免依赖当天日期）
        post_weekday: now.getUTCDay(),
        post_per_week: 1,
        review_window_days: 7,
        audit_interval_days: 30,
        enabled: true,
      },
    });
    expect(res.statusCode).toBe(200);

    const tick1 = (
      await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" })
    ).json();
    const types1 = tick1.created.map((c: { task_type: string }) => c.task_type).sort();
    expect(types1).toEqual(["AUDIT", "GBP_POST", "KEYWORD_WEEKLY", "REVIEW"]);

    // 幂等：第二轮不重复建
    const tick2 = (
      await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" })
    ).json();
    expect(tick2.created).toHaveLength(0);

    // mock worker：Ⓐ级只读任务派发后立即成功 → DONE
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    const inbox = (
      await app.inject({ method: "GET", url: "/api/seo-ops/inbox?limit=50" })
    ).json();
    const byType = new Map(
      inbox.items.map((t: { task_type: string; status: string; execution_mode: string }) => [
        t.task_type,
        t,
      ]),
    );
    for (const readOnly of ["KEYWORD_WEEKLY", "AUDIT", "REVIEW"]) {
      expect((byType.get(readOnly) as { status: string }).status).toBe("DONE");
    }
    // Ⓑ：内容未定稿 → NEEDS_INPUT，绝不自动越过双门
    const post = byType.get("GBP_POST") as { status: string; execution_mode: string };
    expect(post.status).toBe("NEEDS_INPUT");
    expect(post.execution_mode).toBe("AUTO_WRITE");
  });
});

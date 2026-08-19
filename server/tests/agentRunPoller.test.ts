import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { sha256Hash } from "../src/domain/hashing.js";
import { createMerchant } from "../src/services/merchantService.js";
import {
  appendEvidence,
  approvalDecision,
  createTask,
} from "../src/services/taskService.js";
import { insertAgentRun, getAgentRun } from "../src/repos/agentRunRepo.js";
import { getTask } from "../src/repos/taskRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";
import { AgentRunPoller } from "../src/services/agentRunPoller.js";
import type { AgentRunPollerDeps } from "../src/services/agentRunPoller.js";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";

const T0 = "2026-08-19T10:00:00.000Z";

function fakeClient(
  coreByRun: Record<string, CoreAgentRunDetail | Error>,
): CoreAiClient {
  return {
    async trigger() {
      throw new Error("trigger not expected in poller tests");
    },
    async getRun(runId) {
      const value = coreByRun[runId];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`unexpected getRun for ${runId}`);
      return value;
    },
    async cancel() {
      throw new Error("cancel not expected in poller tests");
    },
  };
}

describe("AgentRunPoller", () => {
  let db: Db;
  let artifactsDir: string;
  let counter = 0;

  beforeEach(() => {
    db = openDatabase(":memory:");
    migrate(db);
    artifactsDir = mkdtempSync(path.join(tmpdir(), "agent-runs-"));
    counter = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function seedTask(requiredEvidenceTypes: string[] = ["AUDIT_REPORT"]) {
    counter += 1;
    const { entity: merchant } = createMerchant(db, {
      slug: `m-${counter}`,
      displayName: "Acme",
      idempotencyKey: `mk-${counter}`,
    });
    const { task } = createTask(db, {
      merchant_id: merchant.id,
      definition: {
        title: "补齐 GBP 经营类别",
        task_type: "GBP_PROFILE",
        source: "SEO_AUDIT",
        priority: "HIGH",
        impact: "MEDIUM",
        owner_id: "op-1",
        execution_spec: '{"action":"update_categories"}',
        required_evidence_types: requiredEvidenceTypes,
      },
      idempotency_key: `tk-${counter}`,
    });
    return task;
  }

  function seedRun(taskId: string, overrides: Partial<AgentRun> = {}): AgentRun {
    const run: AgentRun = {
      id: crypto.randomUUID(),
      taskId,
      runType: "AUDIT",
      goal: null,
      status: "RUNNING",
      coreRunId: "core-1",
      coreStatus: "RUNNING",
      inputMessage: "msg",
      output: null,
      error: null,
      errorCode: null,
      tokenUsage: {},
      artifactPath: null,
      artifactSha256: null,
      evidenceId: null,
      evidenceSkippedReason: null,
      triggeredBy: "local-dev",
      triggeredAt: T0,
      lastPolledAt: null,
      completedAt: null,
      creationIdempotencyKey: null,
      requestFingerprint: null,
      createdBy: "local-dev",
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    };
    insertAgentRun(db, run);
    return run;
  }

  function completedCore(output: string | null): CoreAgentRunDetail {
    return {
      id: "core-1",
      agent_id: "agent-1",
      status: "COMPLETED",
      output,
      token_usage: { input_tokens: 11, output_tokens: 22 },
      completed_at: "2026-08-19T10:01:00.000Z",
    };
  }

  function makePoller(
    coreByRun: Record<string, CoreAgentRunDetail | Error>,
    deps: Partial<AgentRunPollerDeps> = {},
  ) {
    return new AgentRunPoller({
      db,
      client: fakeClient(coreByRun),
      agentId: "agent-1",
      artifactsDir,
      ...deps,
    });
  }

  it("COMPLETED: writes artifact + UNVERIFIED evidence, syncs link and event", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const output = "# 审计报告\n\n结论先行。";
    const poller = makePoller({ "core-1": completedCore(output) });

    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.artifactPath).toBe(path.join(artifactsDir, `${run.id}.md`));
    expect(after?.artifactSha256).toBe(sha256Hash(output));
    expect(after?.tokenUsage).toEqual({ input_tokens: 11, output_tokens: 22 });
    expect(existsSync(after!.artifactPath!)).toBe(true);
    expect(readFileSync(after!.artifactPath!, "utf8")).toBe(output);

    const taskAfter = getTask(db, task.id)!;
    const evidence = taskAfter.evidenceRefs.find((e) => e.artifactId === run.id);
    expect(evidence).toMatchObject({
      type: "AUDIT_REPORT",
      verificationStatus: "UNVERIFIED",
      requirementKey: "AUDIT_REPORT",
      sha256: sha256Hash(output),
    });
    expect(after?.evidenceId).toBe(evidence?.id);
    expect(after?.evidenceSkippedReason).toBeNull();
    expect(
      taskAfter.agentRunLinks.find((l) => l.agentRunId === run.id)?.status,
    ).toBe("COMPLETED");
    expect(taskAfter.events.at(-1)?.type).toBe("AGENT_RUN_COMPLETED");
    expect(taskAfter.events.at(-1)?.referenceId).toBe(run.id);
    expect(taskAfter.stateVersion).toBe(task.stateVersion + 1);
  });

  it("second pollOnce after terminal is a no-op (crash-replay idempotence)", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const poller = makePoller({ "core-1": completedCore("# 报告") });

    await poller.pollOnce();
    const taskOnce = getTask(db, task.id)!;
    await poller.pollOnce();
    const taskTwice = getTask(db, task.id)!;

    expect(taskTwice.evidenceRefs.length).toBe(1);
    expect(taskTwice.stateVersion).toBe(taskOnce.stateVersion);
    expect(taskTwice.events.length).toBe(taskOnce.events.length);
  });

  it("FAILED: records error, no artifact/evidence, link FAILED + event", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const poller = makePoller({
      "core-1": {
        id: "core-1",
        agent_id: "agent-1",
        status: "FAILED",
        error: "model backend unavailable",
      },
    });

    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.error).toBe("model backend unavailable");
    expect(after?.artifactPath).toBeNull();

    const taskAfter = getTask(db, task.id)!;
    expect(taskAfter.evidenceRefs.length).toBe(0);
    expect(
      taskAfter.agentRunLinks.find((l) => l.agentRunId === run.id)?.status,
    ).toBe("FAILED");
    expect(taskAfter.events.at(-1)?.type).toBe("AGENT_RUN_FAILED");
  });

  it("APPROVED task: skips evidence with reason but still syncs link/event and artifact", async () => {
    const task = seedTask();
    appendEvidence(db, task.id, {
      type: "AUDIT_REPORT",
      source_ref: "gsc://baseline",
      captured_at: T0,
      verification_status: "VERIFIED",
      requirement_key: "AUDIT_REPORT",
      expected_state_version: 1,
      idempotency_key: "ev-1",
    });
    approvalDecision(db, task.id, {
      decision: "APPROVE",
      task_revision: 1,
      execution_spec_hash: task.executionSpecHash,
      expected_state_version: 2,
      idempotency_key: "ap-1",
    });
    const approved = getTask(db, task.id)!;
    expect(approved.status).toBe("APPROVED");

    const run = seedRun(approved.id);
    const poller = makePoller({ "core-1": completedCore("# 报告") });
    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.evidenceId).toBeNull();
    expect(after?.evidenceSkippedReason).toMatch(/does not accept evidence/);
    expect(existsSync(path.join(artifactsDir, `${run.id}.md`))).toBe(true);

    const taskAfter = getTask(db, task.id)!;
    expect(taskAfter.evidenceRefs.length).toBe(1); // only the manual VERIFIED one
    expect(
      taskAfter.agentRunLinks.find((l) => l.agentRunId === run.id)?.status,
    ).toBe("COMPLETED");
    expect(taskAfter.events.at(-1)?.type).toBe("AGENT_RUN_COMPLETED");
  });

  it("COMPLETED with empty output: no artifact, skip reason recorded", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const poller = makePoller({ "core-1": completedCore("") });
    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.artifactPath).toBeNull();
    expect(after?.evidenceSkippedReason).toBe("agent produced no output");
    expect(getTask(db, task.id)!.evidenceRefs.length).toBe(0);
  });

  it("non-terminal core status: stays RUNNING, core_status/last_polled_at updated", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const poller = makePoller({
      "core-1": { id: "core-1", agent_id: "agent-1", status: "RUNNING" },
    });
    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("RUNNING");
    expect(after?.coreStatus).toBe("RUNNING");
    expect(after?.lastPolledAt).not.toBeNull();
  });

  it("network error: run stays RUNNING for the next tick", async () => {
    const task = seedTask();
    const run = seedRun(task.id);
    const poller = makePoller({ "core-1": new Error("ECONNRESET") });
    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("RUNNING");
    expect(after?.error).toBeNull();
  });

  it("TRIGGERING orphan older than 60s fails as TRIGGER_INTERRUPTED", async () => {
    const task = seedTask();
    const run = seedRun(task.id, { status: "TRIGGERING", coreRunId: null });
    const poller = makePoller(
      {},
      { now: () => new Date(Date.parse(T0) + 61_000) },
    );
    await poller.pollOnce();

    const after = getAgentRun(db, run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.errorCode).toBe("TRIGGER_INTERRUPTED");
    expect(after?.completedAt).not.toBeNull();
  });

  it("TRIGGERING within the grace window is left alone", async () => {
    const task = seedTask();
    const run = seedRun(task.id, { status: "TRIGGERING", coreRunId: null });
    const poller = makePoller(
      {},
      { now: () => new Date(Date.parse(T0) + 5_000) },
    );
    await poller.pollOnce();

    expect(getAgentRun(db, run.id)?.status).toBe("TRIGGERING");
  });

  it("start() polls immediately and stop() clears the scheduler handle", async () => {
    const task = seedTask();
    const run = seedRun(task.id, { status: "TRIGGERING", coreRunId: null });
    const handles: unknown[] = [];
    let cleared = 0;
    const scheduler = {
      setInterval(_fn: () => void, ms: number) {
        expect(ms).toBe(250);
        const handle = { id: handles.length };
        handles.push(handle);
        return handle;
      },
      clearInterval(handle: unknown) {
        cleared += 1;
        expect(handles).toContain(handle);
      },
    };
    const poller = makePoller(
      {},
      { scheduler, intervalMs: 250, now: () => new Date(Date.parse(T0) + 61_000) },
    );

    poller.start();
    // The immediate boot poll already swept the orphan row.
    expect(getAgentRun(db, run.id)?.errorCode).toBe("TRIGGER_INTERRUPTED");
    expect(handles.length).toBe(1);

    poller.stop();
    expect(cleared).toBe(1);
    poller.stop(); // idempotent
    expect(cleared).toBe(1);
  });
});

import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { sha256Hash, sha256HashBytes } from "../src/domain/hashing.js";
import {
  insertAgentRun,
  getAgentRun,
  listDeliverablesByRun,
} from "../src/repos/agentRunRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";
import { AgentRunPoller } from "../src/services/agentRunPoller.js";
import type { AgentRunPollerDeps } from "../src/services/agentRunPoller.js";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { createTestDb } from "./helpers/pgTest.js";

const T0 = "2026-08-19T10:00:00.000Z";
const MERCHANT_ID = "m-1";

/** start() fires pollOnce() fire-and-forget (`void this.pollOnce()`); against
 * real async I/O that promise settles after start() returns, so poll for the
 * expected side effect instead of asserting immediately. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeClient(
  coreByRun: Record<string, CoreAgentRunDetail | Error>,
  artifactBytesByUrl: Record<string, Uint8Array | Error> = {},
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
    async downloadArtifact(url) {
      const value = artifactBytesByUrl[url];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`unexpected download for ${url}`);
      return value;
    },
  };
}

describe("AgentRunPoller", () => {
  let db: Db;
  let teardown: () => Promise<void>;
  let artifactsDir: string;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    teardown = ctx.teardown;
    await migrate(db);
    artifactsDir = mkdtempSync(path.join(tmpdir(), "stage-runs-"));
  });

  afterEach(async () => {
    await teardown();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  async function seedRun(overrides: Partial<AgentRun> = {}): Promise<AgentRun> {
    const run: AgentRun = {
      id: crypto.randomUUID(),
      merchantId: MERCHANT_ID,
      locationId: null,
      stage: "KEYWORDS",
      taskId: null,
      runType: "KEYWORD_RESEARCH",
      goal: null,
      status: "RUNNING",
      coreRunId: "core-1",
      coreStatus: "RUNNING",
      inputMessage: "msg",
      output: null,
      error: null,
      errorCode: null,
      tokenUsage: {},
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
    await insertAgentRun(db, run);
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
    artifactBytesByUrl: Record<string, Uint8Array | Error> = {},
  ) {
    return new AgentRunPoller({
      db,
      client: fakeClient(coreByRun, artifactBytesByUrl),
      agentId: "agent-1",
      artifactsDir,
      ...deps,
    });
  }

  it("COMPLETED: stores the body as a SUMMARY deliverable and flips the run", async () => {
    const run = await seedRun();
    const output = "# 关键词报告\n\n结论先行。";
    const poller = makePoller({ "core-1": completedCore(output) });

    await poller.pollOnce();

    const after = await getAgentRun(db, run.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.output).toBe(output);
    expect(after?.tokenUsage).toEqual({ input_tokens: 11, output_tokens: 22 });
    expect(after?.completedAt).toBe("2026-08-19T10:01:00.000Z");

    const deliverables = await listDeliverablesByRun(db, run.id);
    expect(deliverables).toHaveLength(1);
    const summary = deliverables[0];
    expect(summary.id).toBe(`${run.id}-summary`);
    expect(summary.kind).toBe("SUMMARY");
    expect(summary.sha256).toBe(sha256Hash(output));
    expect(summary.localPath).toBe(path.join(artifactsDir, `${run.id}.md`));
    expect(existsSync(summary.localPath!)).toBe(true);
    expect(readFileSync(summary.localPath!, "utf8")).toBe(output);
  });

  it("COMPLETED with artifacts: downloads attachments, failure keeps remote ref", async () => {
    const run = await seedRun();
    const csv = new TextEncoder().encode("keyword,volume\n炸鸡外卖,1300\n");
    const core = {
      ...completedCore("# 关键词报告"),
      artifacts: [
        { file_id: "f-1", file_name: "keywords.csv", content_type: "text/csv", size: csv.byteLength, download_url: "https://core.example/files/f-1" },
        { file_id: "f-2", file_name: "chart.png", content_type: "image/png", download_url: "https://core.example/files/f-2" },
      ],
    };
    const poller = makePoller(
      { "core-1": core },
      {},
      {
        "https://core.example/files/f-1": csv,
        "https://core.example/files/f-2": new Error("boom"),
      },
    );
    await poller.pollOnce();

    expect((await getAgentRun(db, run.id))?.status).toBe("COMPLETED");
    const deliverables = await listDeliverablesByRun(db, run.id);
    expect(deliverables).toHaveLength(3); // summary + 2 attachments

    const saved = deliverables.find((d) => d.fileName === "keywords.csv")!;
    expect(saved.kind).toBe("ATTACHMENT");
    expect(saved.localPath).not.toBeNull();
    expect(saved.sha256).toBe(sha256HashBytes(csv));
    expect(readFileSync(saved.localPath!).equals(csv)).toBe(true);
    expect(saved.downloadError).toBeNull();

    const failed = deliverables.find((d) => d.fileName === "chart.png")!;
    expect(failed.localPath).toBeNull();
    expect(failed.remoteUrl).toBe("https://core.example/files/f-2");
    expect(failed.downloadError).toBe("boom");
  });

  it("second pollOnce after terminal is a no-op (crash-replay idempotence)", async () => {
    const run = await seedRun();
    const poller = makePoller({ "core-1": completedCore("# 报告") });

    await poller.pollOnce();
    const once = await listDeliverablesByRun(db, run.id);
    await poller.pollOnce();
    const twice = await listDeliverablesByRun(db, run.id);

    expect(twice).toHaveLength(once.length);
    expect(twice.map((d) => d.id)).toEqual(once.map((d) => d.id));
  });

  it("FAILED: records error, no deliverables", async () => {
    const run = await seedRun();
    const poller = makePoller({
      "core-1": {
        id: "core-1",
        agent_id: "agent-1",
        status: "FAILED",
        error: "model backend unavailable",
      },
    });

    await poller.pollOnce();

    const after = await getAgentRun(db, run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.error).toBe("model backend unavailable");
    expect(await listDeliverablesByRun(db, run.id)).toHaveLength(0);
  });

  it("COMPLETED with empty output and no artifacts: zero deliverables, run still terminal", async () => {
    const run = await seedRun();
    const poller = makePoller({ "core-1": completedCore("") });
    await poller.pollOnce();

    expect((await getAgentRun(db, run.id))?.status).toBe("COMPLETED");
    expect(await listDeliverablesByRun(db, run.id)).toHaveLength(0);
  });

  it("non-terminal core status: stays RUNNING, core_status/last_polled_at updated", async () => {
    const run = await seedRun();
    const poller = makePoller({
      "core-1": { id: "core-1", agent_id: "agent-1", status: "RUNNING" },
    });
    await poller.pollOnce();

    const after = await getAgentRun(db, run.id);
    expect(after?.status).toBe("RUNNING");
    expect(after?.coreStatus).toBe("RUNNING");
    expect(after?.lastPolledAt).not.toBeNull();
  });

  it("network error: run stays RUNNING for the next tick", async () => {
    const run = await seedRun();
    const poller = makePoller({ "core-1": new Error("ECONNRESET") });
    await poller.pollOnce();

    const after = await getAgentRun(db, run.id);
    expect(after?.status).toBe("RUNNING");
    expect(after?.error).toBeNull();
  });

  it("TRIGGERING orphan older than 60s fails as TRIGGER_INTERRUPTED", async () => {
    const run = await seedRun({ status: "TRIGGERING", coreRunId: null });
    const poller = makePoller(
      {},
      { now: () => new Date(Date.parse(T0) + 61_000) },
    );
    await poller.pollOnce();

    const after = await getAgentRun(db, run.id);
    expect(after?.status).toBe("FAILED");
    expect(after?.errorCode).toBe("TRIGGER_INTERRUPTED");
    expect(after?.completedAt).not.toBeNull();
  });

  it("TRIGGERING within the grace window is left alone", async () => {
    const run = await seedRun({ status: "TRIGGERING", coreRunId: null });
    const poller = makePoller(
      {},
      { now: () => new Date(Date.parse(T0) + 5_000) },
    );
    await poller.pollOnce();

    expect((await getAgentRun(db, run.id))?.status).toBe("TRIGGERING");
  });

  it("start() polls immediately and stop() clears the scheduler handle", async () => {
    const run = await seedRun({ status: "TRIGGERING", coreRunId: null });
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
    // The immediate boot poll already swept the orphan row (fire-and-forget:
    // wait for it to land before asserting).
    await waitFor(async () => (await getAgentRun(db, run.id))?.errorCode === "TRIGGER_INTERRUPTED");
    expect((await getAgentRun(db, run.id))?.errorCode).toBe("TRIGGER_INTERRUPTED");
    expect(handles.length).toBe(1);

    poller.stop();
    expect(cleared).toBe(1);
    poller.stop(); // idempotent
    expect(cleared).toBe(1);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { getTask } from "../src/repos/taskRepo.js";
import { getAgentRun } from "../src/repos/agentRunRepo.js";

const MERCHANT = {
  slug: "acme",
  display_name: "Acme",
  idempotency_key: "mk-1",
};

const DEFINITION = {
  title: "补齐 GBP 经营类别",
  task_type: "GBP_PROFILE",
  source: "SEO_AUDIT",
  priority: "HIGH",
  impact: "MEDIUM",
  owner_id: "op-1",
  execution_spec: '{"action":"update_categories"}',
  required_evidence_types: ["AUDIT_REPORT"],
};

function fakeCoreAi(
  opts: {
    trigger?: () => Promise<{ run_id: string; status: string }>;
    getRun?: (id: string) => Promise<CoreAgentRunDetail>;
  } = {},
): CoreAiClient {
  return {
    async trigger() {
      if (opts.trigger) return opts.trigger();
      return { run_id: "core-run-1", status: "RUNNING" };
    },
    async getRun(id: string) {
      if (opts.getRun) return opts.getRun(id);
      return { id, agent_id: "agent-1", status: "RUNNING" };
    },
    async cancel() {
      /* 2xx empty */
    },
  };
}

describe("agent-run routes", () => {
  let artifactsDir: string;
  let counter = 0;

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), "agent-run-routes-"));
    counter = 0;
  });

  afterEach(() => {
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  function makeApp(coreAi: CoreAiClient | null = fakeCoreAi()) {
    return buildApp(
      {
        ...loadConfig(),
        dbPath: ":memory:",
        coreAiBaseUrl: coreAi ? "https://core-ai.example" : null,
        coreAiToken: coreAi ? "secret-token" : null,
        agentRunAgentId: coreAi ? "agent-1" : null,
      },
      { coreAi, artifactsDir },
    );
  }

  async function seedTask(app: { inject: ReturnType<typeof makeApp>["app"]["inject"] }) {
    counter += 1;
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: { ...MERCHANT, slug: `acme-${counter}`, idempotency_key: `mk-${counter}` },
      })
    ).json();
    return (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/tasks",
        payload: {
          merchant_id: merchant.id,
          definition: DEFINITION,
          idempotency_key: `tk-${counter}`,
        },
      })
    ).json();
  }

  it("POST returns 202 with core_run_id and persists row + link + event", async () => {
    const { app, db } = makeApp();
    const task = await seedTask(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "AUDIT", goal: " 关注 SoLV ", idempotency_key: "ar-1" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("RUNNING");
    expect(body.core_run_id).toBe("core-run-1");
    expect(body.run_type).toBe("AUDIT");
    expect(body.goal).toBe("关注 SoLV");
    expect(body.input_message).toMatch(/不得执行任何写入或变更操作/);

    const row = getAgentRun(db, body.id);
    expect(row?.status).toBe("RUNNING");
    expect(row?.coreRunId).toBe("core-run-1");

    const taskAfter = getTask(db, task.id)!;
    expect(taskAfter.agentRunLinks).toHaveLength(1);
    expect(taskAfter.agentRunLinks[0]).toMatchObject({
      agentRunId: body.id,
      relationship: "AUDIT",
      status: "RUNNING",
    });
    expect(taskAfter.events.at(-1)?.type).toBe("AGENT_RUN_TRIGGERED");
    expect(taskAfter.events.at(-1)?.referenceId).toBe(body.id);
    expect(taskAfter.stateVersion).toBe(task.state_version + 1);
  });

  it("replays the same key+body as 200 with the same id, rejects a different body", async () => {
    const { app, db } = makeApp();
    const task = await seedTask(app);
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
    });
    expect(first.statusCode).toBe(202);

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "PLAN", idempotency_key: "ar-1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("503 CORE_AI_NOT_CONFIGURED and config flag false without env", async () => {
    const { app, db } = makeApp(null);
    const task = await seedTask(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe("CORE_AI_NOT_CONFIGURED");

    const config = (await app.inject({ method: "GET", url: "/api/seo-ops/config" })).json();
    expect(config.copilot_enabled).toBe(false);
    expect(config.agent_run_enabled).toBe(false);
    expect(config.agent_run_types).toContain("AUDIT");
  });

  it("config reports agent_run_enabled when configured", async () => {
    const { app, db } = makeApp();
    const config = (await app.inject({ method: "GET", url: "/api/seo-ops/config" })).json();
    expect(config.agent_run_enabled).toBe(true);
    expect(config.copilot_enabled).toBe(false);
  });

  it("404 for a missing task, 400 for an invalid run_type", async () => {
    const { app, db } = makeApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks/nope/agent-runs",
      payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
    });
    expect(missing.statusCode).toBe(404);

    const task = await seedTask(app);
    const bad = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "EXECUTE", idempotency_key: "ar-2" },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error_code).toBe("VALIDATION_ERROR");
  });

  it("lists runs with output previews and paginates", async () => {
    const { app, db } = makeApp();
    const task = await seedTask(app);

    const run = getAgentRun(
      db,
      (await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
        payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
      })).json().id,
    )!;

    const page = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/agent-runs` })
    ).json();
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe(run.id);
    expect(page.items[0]).not.toHaveProperty("output");
    expect(page.items[0]).toHaveProperty("output_preview", null);

    const missing = await app.inject({
      method: "GET",
      url: "/api/seo-ops/tasks/nope/agent-runs",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("GET single run returns full output; 404 when unknown", async () => {
    const { app, db } = makeApp();
    const task = await seedTask(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
        payload: { run_type: "REPORT", idempotency_key: "ar-1" },
      })
    ).json();

    const detail = (
      await app.inject({ method: "GET", url: `/api/seo-ops/agent-runs/${created.id}` })
    ).json();
    expect(detail.output).toBeNull();

    const missing = await app.inject({
      method: "GET",
      url: "/api/seo-ops/agent-runs/nope",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("cancels a RUNNING run and then rejects a second cancel with 409", async () => {
    const client = fakeCoreAi({
      getRun: async (id) => ({
        id,
        agent_id: "agent-1",
        status: "CANCELLED",
        error: "cancelled",
        completed_at: "2026-08-19T11:00:00.000Z",
      }),
    });
    const { app, db } = makeApp(client);
    const task = await seedTask(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
        payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
      })
    ).json();

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/seo-ops/agent-runs/${created.id}/cancel`,
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe("CANCELLED");

    const again = await app.inject({
      method: "POST",
      url: `/api/seo-ops/agent-runs/${created.id}/cancel`,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error_code).toBe("RUN_NOT_ACTIVE");

    const taskAfter = getTask(db, task.id)!;
    expect(taskAfter.agentRunLinks[0].status).toBe("CANCELLED");
    expect(taskAfter.events.at(-1)?.type).toBe("AGENT_RUN_CANCELLED");
  });

  it("trigger failure returns 502 and archives a FAILED row", async () => {
    const client = fakeCoreAi({
      trigger: async () => {
        throw new Error("core-ai returned 429: daily token quota exceeded");
      },
    });
    const { app, db } = makeApp(client);
    const task = await seedTask(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/agent-runs`,
      payload: { run_type: "AUDIT", idempotency_key: "ar-1" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error_code).toBe("CORE_AI_TRIGGER_FAILED");
    expect(res.json().message).not.toContain("secret-token");

    const rows = (
      await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/agent-runs` })
    ).json();
    expect(rows.total).toBe(1);
    expect(rows.items[0].status).toBe("FAILED");
    expect(rows.items[0].error_code).toBe("TRIGGER_FAILED");

    // No link/event was recorded for the failed trigger.
    const taskAfter = getTask(db, task.id)!;
    expect(taskAfter.agentRunLinks).toHaveLength(0);
  });
});

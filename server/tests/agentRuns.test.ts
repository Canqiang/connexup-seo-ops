import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ServerConfig } from "../src/config.js";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import {
  getAgentRun,
  transitionAgentRun,
  upsertDeliverable,
} from "../src/repos/agentRunRepo.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

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
    async downloadArtifact() {
      throw new Error("download not expected in route tests");
    },
  };
}

describe("stage-run routes", () => {
  let artifactsDir: string;
  let counter = 0;
  let apps: Array<{ close(): Promise<void> }> = [];

  beforeEach(() => {
    artifactsDir = mkdtempSync(path.join(tmpdir(), "stage-run-routes-"));
    counter = 0;
    apps = [];
  });

  afterEach(async () => {
    for (const app of apps) await app.close();
    rmSync(artifactsDir, { recursive: true, force: true });
  });

  /** Fresh app + fresh schema-isolated postgres db per call. */
  async function makeApp(
    coreAi: CoreAiClient | null = fakeCoreAi(),
    configOverrides: Partial<ServerConfig> = {},
  ) {
    const result = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: coreAi ? "https://core-ai.example" : null,
        coreAiToken: coreAi ? "secret-token" : null,
        agentRunAgentId: coreAi ? "agent-1" : null,
        ...configOverrides,
      },
      deps: { coreAi, artifactsDir },
    });
    apps.push(result.app);
    return result;
  }

  async function seedMerchant(app: { inject: Awaited<ReturnType<typeof makeApp>>["app"]["inject"] }) {
    counter += 1;
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: { slug: `acme-${counter}`, display_name: "Acme", idempotency_key: `mk-${counter}` },
      })
    ).json();
    const location = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/locations`,
        payload: {
          slug: "mineola", display_name: "Mineola", readiness_status: "READY",
          external_identities: { google_business: "gid-123" },
          idempotency_key: `lk-${counter}`,
        },
      })
    ).json();
    return { merchant, location };
  }

  it("POST stage-runs returns 202: run belongs to (merchant, location, stage), no task", async () => {
    const { app, db } = await makeApp();
    const { merchant, location } = await seedMerchant(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
      payload: { stage: "KEYWORDS", goal: " 关注 SoLV ", idempotency_key: "sr-1" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe("RUNNING");
    expect(body.core_run_id).toBe("core-run-1");
    expect(body.stage).toBe("KEYWORDS");
    expect(body.run_type).toBe("KEYWORD_RESEARCH");
    expect(body.merchant_id).toBe(merchant.id);
    expect(body.location_id).toBe(location.id); // 单地点商户自动选中
    expect(body.goal).toBe("关注 SoLV");
    expect(body.deliverables).toEqual([]);
    expect(body.input_message).toMatch(/不得执行任何写入或变更操作/);
    expect(body.input_message).toContain("Mineola");

    const row = (await getAgentRun(db, body.id))!;
    expect(row.status).toBe("RUNNING");
    expect(row.taskId).toBeNull();
  });

  it("replays the same key+body as 200 with the same id, rejects a different body", async () => {
    const { app } = await makeApp();
    const { merchant } = await seedMerchant(app);
    const url = `/api/seo-ops/merchants/${merchant.id}/stage-runs`;

    const first = await app.inject({
      method: "POST", url,
      payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
    });
    expect(first.statusCode).toBe(202);

    const replay = await app.inject({
      method: "POST", url,
      payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);

    const conflict = await app.inject({
      method: "POST", url,
      payload: { stage: "AUDIT", idempotency_key: "sr-1" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("503 CORE_AI_NOT_CONFIGURED and config flags without env", async () => {
    const { app } = await makeApp(null);
    const { merchant } = await seedMerchant(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
      payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error_code).toBe("CORE_AI_NOT_CONFIGURED");

    const config = (await app.inject({ method: "GET", url: "/api/seo-ops/config" })).json();
    expect(config.copilot_enabled).toBe(false);
    expect(config.agent_run_enabled).toBe(false);
    expect(config.agent_run_stages).toContain("KEYWORDS");
  });

  it("404 unknown merchant, 400 invalid stage, 400 foreign location", async () => {
    const { app } = await makeApp();
    const missing = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants/nope/stage-runs",
      payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
    });
    expect(missing.statusCode).toBe(404);

    const { merchant } = await seedMerchant(app);
    const badStage = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
      payload: { stage: "EXECUTE", idempotency_key: "sr-2" },
    });
    expect(badStage.statusCode).toBe(400);
    expect(badStage.json().error_code).toBe("VALIDATION_ERROR");

    const { location: other } = await seedMerchant(app);
    const foreign = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
      payload: { stage: "KEYWORDS", location_id: other.id, idempotency_key: "sr-3" },
    });
    expect(foreign.statusCode).toBe(400);
  });

  it("enforces the per-merchant daily run limit with 429", async () => {
    const { app } = await makeApp(fakeCoreAi(), { agentRunDailyLimit: 1 });
    const { merchant } = await seedMerchant(app);
    const url = `/api/seo-ops/merchants/${merchant.id}/stage-runs`;

    const first = await app.inject({
      method: "POST", url,
      payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: "POST", url,
      payload: { stage: "AUDIT", idempotency_key: "sr-2" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error_code).toBe("RUN_LIMIT_REACHED");
  });

  it("lists stage runs with previews + deliverables, filters by stage", async () => {
    const { app, db } = await makeApp();
    const { merchant } = await seedMerchant(app);
    const url = `/api/seo-ops/merchants/${merchant.id}/stage-runs`;

    const created = (
      await app.inject({
        method: "POST", url,
        payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
      })
    ).json();
    await app.inject({
      method: "POST", url,
      payload: { stage: "AUDIT", idempotency_key: "sr-2" },
    });

    const csvPath = path.join(artifactsDir, "kw.csv");
    writeFileSync(csvPath, "keyword\n");
    await upsertDeliverable(db, {
      id: `${created.id}-att-f-1`, runId: created.id, kind: "ATTACHMENT",
      fileId: "f-1", fileName: "keywords.csv", contentType: "text/csv", size: 8,
      title: null, description: null, sha256: null, localPath: csvPath,
      remoteUrl: "https://core-ai.example/files/f-1",
      downloadedAt: "2026-08-19T10:01:00.000Z", downloadError: null,
      createdAt: "2026-08-19T10:01:00.000Z",
    });

    const all = (await app.inject({ method: "GET", url })).json();
    expect(all.total).toBe(2);
    expect(all.items[0]).not.toHaveProperty("output");
    expect(all.items[0]).toHaveProperty("output_preview");

    const filtered = (
      await app.inject({ method: "GET", url: `${url}?stage=KEYWORDS` })
    ).json();
    expect(filtered.total).toBe(1);
    expect(filtered.items[0].id).toBe(created.id);
    expect(filtered.items[0].deliverables).toHaveLength(1);
    expect(filtered.items[0].deliverables[0]).toMatchObject({
      file_name: "keywords.csv",
      downloaded: true,
      download_path: `/api/seo-ops/deliverables/${created.id}-att-f-1/download`,
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/seo-ops/merchants/nope/stage-runs",
    });
    expect(missing.statusCode).toBe(404);
  });

  it("serves deliverable bytes by id, 404s undownloaded and unknown ones", async () => {
    const { app, db } = await makeApp();
    const { merchant } = await seedMerchant(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
      })
    ).json();

    const csv = Buffer.from("keyword,volume\n");
    const csvPath = path.join(artifactsDir, `${created.id}-0-keywords.csv`);
    writeFileSync(csvPath, csv);
    await upsertDeliverable(db, {
      id: "d-ok", runId: created.id, kind: "ATTACHMENT", fileId: "f-1",
      fileName: "keywords.csv", contentType: "text/csv", size: csv.byteLength,
      title: null, description: null, sha256: null, localPath: csvPath,
      remoteUrl: "https://core-ai.example/files/f-1",
      downloadedAt: "2026-08-19T10:01:00.000Z", downloadError: null,
      createdAt: "2026-08-19T10:01:00.000Z",
    });
    await upsertDeliverable(db, {
      id: "d-miss", runId: created.id, kind: "ATTACHMENT", fileId: "f-2",
      fileName: "chart.png", contentType: "image/png", size: null,
      title: null, description: null, sha256: null, localPath: null,
      remoteUrl: "https://core-ai.example/files/f-2",
      downloadedAt: null, downloadError: "boom",
      createdAt: "2026-08-19T10:01:00.000Z",
    });

    const ok = await app.inject({ method: "GET", url: "/api/seo-ops/deliverables/d-ok/download" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/csv");
    expect(ok.rawPayload.equals(csv)).toBe(true);

    const miss = await app.inject({ method: "GET", url: "/api/seo-ops/deliverables/d-miss/download" });
    expect(miss.statusCode).toBe(404);
    expect(miss.json().error_code).toBe("DELIVERABLE_NOT_DOWNLOADED");

    const unknown = await app.inject({ method: "GET", url: "/api/seo-ops/deliverables/nope/download" });
    expect(unknown.statusCode).toBe(404);
  });

  it("manual deliverable upload unlocks a COMPLETED run without attachments", async () => {
    const { app, db } = await makeApp();
    const { merchant } = await seedMerchant(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
      })
    ).json();

    // 运行未到终态时拒绝兼容兼并
    const early = await app.inject({
      method: "POST",
      url: `/api/seo-ops/agent-runs/${created.id}/deliverables`,
      payload: { file_name: "kw.csv", content_base64: Buffer.from("a,b\n").toString("base64") },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json().error_code).toBe("RUN_NOT_COMPLETED");

    await transitionAgentRun(db, created.id, { status: "COMPLETED" }, ["RUNNING"]);

    const uploaded = await app.inject({
      method: "POST",
      url: `/api/seo-ops/agent-runs/${created.id}/deliverables`,
      payload: {
        file_name: "keywords.csv",
        content_type: "text/csv",
        content_base64: Buffer.from("keyword,volume\n炸鸡,1300\n").toString("base64"),
      },
    });
    expect(uploaded.statusCode).toBe(201);
    const wire = uploaded.json();
    expect(wire.kind).toBe("MANUAL");
    expect(wire.downloaded).toBe(true);

    const download = await app.inject({ method: "GET", url: wire.download_path });
    expect(download.statusCode).toBe(200);
    expect(download.body).toContain("炸鸡,1300");

    const detail = (
      await app.inject({ method: "GET", url: `/api/seo-ops/agent-runs/${created.id}` })
    ).json();
    expect(detail.deliverables).toHaveLength(1);
    expect(detail).toHaveProperty("output"); // detail carries full output
  });

  it("trigger message embeds the FILLED questionnaire and prior-stage deliverable excerpt", async () => {
    const { app, db } = await makeApp();
    const { merchant } = await seedMerchant(app);
    const q = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "qk-1" },
      })
    ).json();
    await app.inject({ method: "POST", url: `/api/seo-ops/questionnaires/${q.id}/send` });
    await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${q.share_slug}/submissions`,
      payload: { answers: Object.fromEntries(q.questions.map((item: { id: string }) => [item.id, "答案"])) },
    });

    const keywords = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "KEYWORDS", idempotency_key: "sr-1" },
      })
    ).json();
    expect(keywords.input_message).toContain("商家问卷回收");
    expect(keywords.input_message).toContain("答：答案");

    // 完成 KEYWORDS 并落盘一份关键词 CSV 交付物 → 下游阶段内联摘录
    await transitionAgentRun(db, keywords.id, { status: "COMPLETED" }, ["RUNNING"]);
    const csvPath = path.join(artifactsDir, "kw.csv");
    writeFileSync(csvPath, "keyword,intent\n炸鸡外卖,transactional\n");
    await upsertDeliverable(db, {
      id: `${keywords.id}-att-f-1`, runId: keywords.id, kind: "ATTACHMENT",
      fileId: "f-1", fileName: "keywords.csv", contentType: "text/csv", size: 30,
      title: null, description: null, sha256: null, localPath: csvPath,
      remoteUrl: null, downloadedAt: "2026-08-19T10:01:00.000Z", downloadError: null,
      createdAt: "2026-08-19T10:01:00.000Z",
    });

    const ranking = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "RANKING_BASELINE", idempotency_key: "sr-2" },
      })
    ).json();
    expect(ranking.input_message).toContain("上游交付物——关键词库");
    expect(ranking.input_message).toContain("炸鸡外卖,transactional");
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
    const { app } = await makeApp(client);
    const { merchant } = await seedMerchant(app);
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "AUDIT", idempotency_key: "sr-1" },
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
  });

  it("trigger failure returns 502 and archives a FAILED row without leaking the token", async () => {
    const client = fakeCoreAi({
      trigger: async () => {
        throw new Error("core-ai returned 429: daily token quota exceeded");
      },
    });
    const { app } = await makeApp(client);
    const { merchant } = await seedMerchant(app);

    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
      payload: { stage: "AUDIT", idempotency_key: "sr-1" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error_code).toBe("CORE_AI_TRIGGER_FAILED");
    expect(res.json().message).not.toContain("secret-token");

    const rows = (
      await app.inject({ method: "GET", url: `/api/seo-ops/merchants/${merchant.id}/stage-runs` })
    ).json();
    expect(rows.total).toBe(1);
    expect(rows.items[0].status).toBe("FAILED");
    expect(rows.items[0].error_code).toBe("TRIGGER_FAILED");
  });
});

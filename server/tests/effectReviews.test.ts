import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertSpecialistArtifact } from "../src/repos/specialistArtifactRepo.js";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("effect reviews projection", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;
  let taskId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({ method: "POST", url: "/api/seo-ops/merchants", payload: { slug: "review-a", display_name: "Review A", operator_user_ids: [built.actor.userId], idempotency_key: "review-a" } })).json().id;
    taskId = (await app.inject({ method: "POST", url: "/api/seo-ops/tasks", payload: { merchant_id: merchantId, idempotency_key: "review-task", definition: { title: "第 2 轮复盘", task_type: "REVIEW", source: "OPERATOR", priority: "LOW", impact: "LOW", execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } } })).json().id;
    await app.inject({ method: "PUT", url: `/api/seo-ops/merchants/${merchantId}/cycle-config`, payload: { snapshot_day: 5, post_weekday: 4, post_per_week: 1, review_window_days: 30, audit_interval_days: null, enabled: true } });
    await insertSpecialistArtifact(built.db, {
      id: "art-review-1", taskId, merchantId, artifactType: "EFFECT_REVIEW", schemaVersion: "seo_ops.effect_review.v1",
      title: "Review A · 第 2 轮", summary: "SoLV 14.4 → 26.2", coreRunId: "core-review-1", createdBy: null, createdAt: "2026-08-06T09:00:00.000Z",
      payload: { schema_version: "seo_ops.effect_review.v1", merchant_id: merchantId, title: "Review A · 第 2 轮", summary: "SoLV 14.4 → 26.2",
        baseline: { solv_mean: 14.4 }, action_bundle: [{ action_id: "post-weekly", description: "GBP Post 周更 ×6", executed_at: "2026-07-20T00:00:00Z", evidence_ref: "task:t1" }],
        observed_change: { solv_mean: 26.2 }, confounders: ["竞对 1 家同期降权", "无对照组"], conclusion_tier: "ASSOCIATIONAL",
        conclusion: "正向关联 · 建议 KEEP", planning_signals: [{ keep: "post-weekly" }], limitations: ["2 个目标词不升反降"] },
    });
  });

  afterEach(async () => app.close());

  it("lists review artifacts per merchant with tier, confounders, and next window", async () => {
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/effect-reviews?now=2026-08-27T00:00:00.000Z" });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.summary).toMatchObject({ total: 1, by_tier: { ASSOCIATIONAL: 1 }, due_count: 0 });
    expect(body.items[0]).toMatchObject({ merchant_name: "Review A", conclusion_tier: "ASSOCIATIONAL", confounders: ["竞对 1 家同期降权", "无对照组"], task_id: taskId, causal_identified: false });
    expect(body.windows[0]).toMatchObject({ merchant_name: "Review A", review_window_days: 30, last_review_at: "2026-08-06T09:00:00.000Z", next_window_at: "2026-09-05T09:00:00.000Z", status: "UPCOMING" });
  });

  it("caps a conclusion_tier claiming CAUSAL down to INSUFFICIENT_EVIDENCE", async () => {
    await insertSpecialistArtifact(built.db, {
      id: "art-review-2", taskId, merchantId, artifactType: "EFFECT_REVIEW", schemaVersion: "seo_ops.effect_review.v1",
      title: "Review A · 第 3 轮", summary: "越权声称因果", coreRunId: "core-review-2", createdBy: null, createdAt: "2026-08-20T09:00:00.000Z",
      payload: { schema_version: "seo_ops.effect_review.v1", merchant_id: merchantId, title: "Review A · 第 3 轮", summary: "越权声称因果",
        baseline: { solv_mean: 26.2 }, action_bundle: [], observed_change: { solv_mean: 30.1 }, confounders: [], conclusion_tier: "CAUSAL",
        conclusion: "声称因果（应被拒绝并降级）", planning_signals: [], limitations: [] },
    });
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/effect-reviews?now=2026-08-27T00:00:00.000Z" });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const item = body.items.find((i: { artifact_id: string }) => i.artifact_id === "art-review-2");
    expect(item).toMatchObject({ conclusion_tier: "INSUFFICIENT_EVIDENCE" });
    expect(body.summary.by_tier).not.toHaveProperty("CAUSAL");
  });
});

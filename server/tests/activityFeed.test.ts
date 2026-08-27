import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { describeTaskEvent } from "../src/services/activityFeedService.js";

describe("activity feed", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "feed-a", display_name: "Feed A", operator_user_ids: [built.actor.userId], idempotency_key: "feed-a" },
    })).json().id;
    await app.inject({
      method: "POST", url: "/api/seo-ops/proposal-batches",
      payload: { merchant_id: merchantId, origin: "MANUAL", trigger_reason: "问卷回收", idempotency_key: "feed-batch",
        items: [{ title: "建立排名基线", task_type: "REPORT", execution_mode: "MANUAL", priority: "MEDIUM", impact: "MEDIUM", execution_spec: "{}" }] },
    });
    await app.inject({
      method: "POST", url: "/api/seo-ops/tasks",
      payload: { merchant_id: merchantId, idempotency_key: "feed-task", definition: {
        title: "营业时间变更", task_type: "GBP_UPDATE", source: "OPERATOR", priority: "HIGH", impact: "MEDIUM",
        execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } },
    });
  });

  afterEach(async () => app.close());

  it("maps task event types to plain-language signals", () => {
    expect(describeTaskEvent("OUTCOME_UNKNOWN")).toMatchObject({ severity: "DANGER" });
    expect(describeTaskEvent("TASK_CREATED").title).toContain("创建");
    expect(describeTaskEvent("SOMETHING_NEW").title).toBe("SOMETHING_NEW");
  });

  it("lists recent task events and proposal batches newest first with merchant names and links", async () => {
    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=10" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(2);
    const created = items.find((i) => i.kind === "TASK_EVENT");
    expect(created).toMatchObject({ merchant_name: "Feed A", severity: "INFO" });
    expect(String(created?.href)).toMatch(/^\/tasks\//);
    const batch = items.find((i) => i.kind === "PROPOSAL_BATCH");
    expect(batch).toMatchObject({ merchant_name: "Feed A", href: `/inbox?tab=proposals&merchant_id=${merchantId}` });
    expect(String(batch?.title)).toContain("1 条");
    for (let i = 1; i < items.length; i += 1) {
      expect(String(items[i - 1]!.occurred_at) >= String(items[i]!.occurred_at)).toBe(true);
    }
  });

  it("inbox-summary reports verification_overdue", async () => {
    const summary = (await app.inject({ method: "GET", url: "/api/seo-ops/inbox-summary" })).json();
    expect(summary).toHaveProperty("verification_overdue", 0);
  });
});

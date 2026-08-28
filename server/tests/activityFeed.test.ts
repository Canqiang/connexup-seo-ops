import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, createTestUser, PASSWORD, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { describeTaskEvent } from "../src/services/activityFeedService.js";
import { insertAgentRun } from "../src/repos/agentRunRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";

function agentRunFixture(merchantId: string, overrides: Partial<AgentRun>): AgentRun {
  const iso = new Date().toISOString();
  return {
    id: crypto.randomUUID(), merchantId, locationId: null, stage: "KEYWORDS", taskId: null,
    runType: "KEYWORD_RESEARCH", goal: "关键词调研", status: "COMPLETED", coreRunId: "core-1", traceRef: null,
    coreStatus: "COMPLETED", inputMessage: "seed", output: "ok", error: null, errorCode: null,
    tokenUsage: { total_tokens: 100 }, triggeredBy: "system:scheduler",
    triggeredAt: iso, lastPolledAt: null, completedAt: iso,
    creationIdempotencyKey: null, requestFingerprint: null, createdBy: null,
    createdAt: iso, updatedAt: iso, ...overrides,
  };
}

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

  it("includes completed and failed run terminals but hides runs still in flight", async () => {
    const completedAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await insertAgentRun(built.db, agentRunFixture(merchantId, {
      id: "run-completed", status: "COMPLETED", completedAt: completedAgo, createdAt: completedAgo, triggeredAt: completedAgo,
    }));
    await insertAgentRun(built.db, agentRunFixture(merchantId, {
      id: "run-failed", status: "FAILED", errorCode: "TIMEOUT", completedAt: completedAgo, createdAt: completedAgo, triggeredAt: completedAgo,
    }));
    await insertAgentRun(built.db, agentRunFixture(merchantId, {
      id: "run-live", status: "RUNNING", completedAt: null,
    }));

    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=20" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;

    const completed = items.find((i) => i.id === "run:run-completed");
    expect(completed).toMatchObject({ kind: "AGENT_RUN", severity: "INFO" });
    expect(String(completed?.title)).toContain("Run 完成");

    const failed = items.find((i) => i.id === "run:run-failed");
    expect(failed).toMatchObject({ kind: "AGENT_RUN", severity: "WARN" });
    expect(String(failed?.title)).toContain("TIMEOUT");

    expect(items.find((i) => i.id === "run:run-live")).toBeUndefined();
  });

  it("keeps a Run whose lifetime straddles the window — created before it, completed inside it", async () => {
    const createdLongAgo = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const completedRecently = new Date(Date.now() - 1 * 3_600_000).toISOString();
    await insertAgentRun(built.db, agentRunFixture(merchantId, {
      id: "run-straddling", status: "COMPLETED",
      createdAt: createdLongAgo, triggeredAt: createdLongAgo, completedAt: completedRecently,
    }));

    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=20" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    const straddling = items.find((i) => i.id === "run:run-straddling");
    expect(straddling).toMatchObject({ kind: "AGENT_RUN" });
  });

  it("does not return a task whose only events predate the window", async () => {
    const task = (await app.inject({
      method: "POST", url: "/api/seo-ops/tasks",
      payload: { merchant_id: merchantId, idempotency_key: "feed-old-events-task", definition: {
        title: "过期事件任务", task_type: "GBP_UPDATE", source: "OPERATOR", priority: "HIGH", impact: "MEDIUM",
        execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } },
    })).json();

    const row = await built.db.one<{ events: string }>("SELECT events FROM seo_tasks WHERE id = $1", [task.id]);
    const oldTimestamp = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const oldEvents = (JSON.parse(row!.events) as Array<Record<string, unknown>>)
      .map((event) => ({ ...event, occurredAt: oldTimestamp }));
    await built.db.exec(
      "UPDATE seo_tasks SET updated_at = $1, events = $2 WHERE id = $3",
      [oldTimestamp, JSON.stringify(oldEvents), task.id],
    );

    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=50" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.kind === "TASK_EVENT" && i.href === `/tasks/${task.id}`)).toBeUndefined();
  });

  it("keeps a task event inside the window even when its task's updated_at sits just before the window — the clock-skew guard", async () => {
    const task = (await app.inject({
      method: "POST", url: "/api/seo-ops/tasks",
      payload: { merchant_id: merchantId, idempotency_key: "feed-skew-task", definition: {
        title: "时钟偏移回归用例", task_type: "GBP_UPDATE", source: "OPERATOR", priority: "HIGH", impact: "MEDIUM",
        execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } },
    })).json();

    // since = now - 24h below. Push updated_at to just before that boundary while leaving the
    // TASK_CREATED event's occurredAt (stamped at creation, well inside the window) untouched —
    // this is the regression test for the corrected invariant: occurredAt can be LATER than
    // updated_at, so a bare `updated_at >= since` bound would wrongly drop this task's event.
    const justBeforeWindow = new Date(Date.now() - 24 * 3_600_000 - 5 * 60_000).toISOString();
    await built.db.exec("UPDATE seo_tasks SET updated_at = $1 WHERE id = $2", [justBeforeWindow, task.id]);

    const response = await app.inject({ method: "GET", url: "/api/seo-ops/activity?hours=24&limit=50" });
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json().items as Array<Record<string, unknown>>;
    expect(items.find((i) => i.kind === "TASK_EVENT" && i.href === `/tasks/${task.id}`)).toBeDefined();
  });

  it("inbox-summary reports verification_overdue", async () => {
    const summary = (await app.inject({ method: "GET", url: "/api/seo-ops/inbox-summary" })).json();
    expect(summary).toHaveProperty("verification_overdue", 0);
  });

  it("counts a task whose verification deadline has passed as verification_overdue", async () => {
    const task = (await app.inject({
      method: "POST", url: "/api/seo-ops/tasks",
      payload: { merchant_id: merchantId, idempotency_key: "feed-overdue-task", definition: {
        title: "核验逾期演练", task_type: "GBP_UPDATE", source: "OPERATOR", priority: "HIGH", impact: "MEDIUM",
        execution_mode: "MANUAL", execution_spec: "{}", required_evidence_types: [] } },
    })).json();
    await built.db.exec(
      "UPDATE seo_tasks SET status = 'PENDING_VERIFY', verify_due_at = $1 WHERE id = $2",
      ["2026-01-01T00:00:00.000Z", task.id],
    );

    const summary = (await app.inject({ method: "GET", url: "/api/seo-ops/inbox-summary" })).json();
    expect(summary).toMatchObject({ verification_overdue: 1, pending_verify: 1 });
  });

  it("returns no items to a scoped view-only user outside the merchant's operators", async () => {
    const outsider = await createTestUser(built.db, { permissions: ["seoops.view"] });
    const login = await built.rawInject({
      method: "POST", url: "/api/auth/login",
      payload: { email: outsider.email, password: PASSWORD },
    });
    const setCookie = login.headers["set-cookie"];
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieValue) throw new Error("expected login response to include Set-Cookie");
    const cookie = cookieValue.split(";", 1)[0]!;

    const body = (await built.rawInject({
      method: "GET", url: "/api/seo-ops/activity",
      headers: { cookie },
    })).json();
    expect(body.items).toEqual([]);
  });
});

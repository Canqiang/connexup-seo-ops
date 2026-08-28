import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("manual planner request", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "planner-req", display_name: "Planner Req", operator_user_ids: [built.actor.userId], idempotency_key: "planner-req" },
    })).json().id;
  });

  afterEach(async () => app.close());

  it("refuses when no PLANNER agent is bound", async () => {
    const response = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe("PLANNER_NOT_BOUND");
  });

  it("creates one pre-authorised PLANNER task and replays on the same key", async () => {
    await app.inject({ method: "PUT", url: "/api/seo-ops/agent-bindings/PLANNER", payload: { agent_id: "agent-planner", agent_label: "Planner" } });
    const first = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-2" } });
    expect(first.statusCode, first.body).toBe(201);
    const { task_id } = first.json();
    const task = (await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task_id}` })).json();
    expect(task).toMatchObject({ task_type: "PLANNER", execution_mode: "READ_ONLY", source: "SYSTEM" });
    expect(["APPROVED", "DISPATCHING"]).toContain(task.status);
    const again = await app.inject({ method: "POST", url: `/api/seo-ops/merchants/${merchantId}/planner-requests`, payload: { reason: "人工刷新任务图", idempotency_key: "req-2" } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ task_id, replayed: true });
  });
});

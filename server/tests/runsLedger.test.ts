import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { insertAgentRun } from "../src/repos/agentRunRepo.js";
import type { AgentRun } from "../src/repos/agentRunTypes.js";
import { createAuthenticatedTestApp, createTestUser, PASSWORD, type AuthenticatedTestApp } from "./helpers/authTest.js";
import { tokenTotal } from "../src/services/runsLedgerService.js";

const NOW = new Date("2026-08-27T15:00:00.000Z");

function run(merchantId: string, overrides: Partial<AgentRun>): AgentRun {
  const iso = NOW.toISOString();
  return {
    id: crypto.randomUUID(), merchantId, locationId: null, stage: "KEYWORDS", taskId: null,
    runType: "KEYWORD_RESEARCH", goal: null, status: "COMPLETED", coreRunId: "core-1", traceRef: null,
    coreStatus: "COMPLETED", inputMessage: "seed", output: "ok", error: null, errorCode: null,
    tokenUsage: { input_tokens: 100, output_tokens: 50 }, triggeredBy: "system:scheduler",
    triggeredAt: "2026-08-27T14:00:00.000Z", lastPolledAt: null, completedAt: "2026-08-27T14:11:02.000Z",
    creationIdempotencyKey: null, requestFingerprint: null, createdBy: null,
    createdAt: "2026-08-27T14:00:00.000Z", updatedAt: iso, ...overrides,
  };
}

describe("runs ledger", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (await app.inject({
      method: "POST", url: "/api/seo-ops/merchants",
      payload: { slug: "ledger-a", display_name: "Ledger A", operator_user_ids: [built.actor.userId], idempotency_key: "ledger-a" },
    })).json().id;
    await insertAgentRun(built.db, run(merchantId, { id: "run-done", tokenUsage: { total_tokens: 880 } }));
    await insertAgentRun(built.db, run(merchantId, {
      id: "run-live", status: "RUNNING", completedAt: null, coreStatus: "RUNNING",
      createdAt: "2026-08-27T14:20:00.000Z", triggeredAt: "2026-08-27T14:20:00.000Z",
    }));
    await insertAgentRun(built.db, run(merchantId, { id: "run-failed-old", status: "FAILED", errorCode: "TIMEOUT", createdAt: "2026-08-20T10:00:00.000Z", triggeredAt: "2026-08-20T10:00:00.000Z", completedAt: "2026-08-20T10:05:00.000Z" }));
    await insertAgentRun(built.db, run(merchantId, { id: "run-content", stage: "GBP_POST_CONTENT", runType: "GBP_POST_CONTENT", taskId: null }));
  });

  afterEach(async () => app.close());

  it("tokenTotal prefers total_tokens and otherwise sums numeric fields", () => {
    expect(tokenTotal({ total_tokens: 12, input_tokens: 5 })).toBe(12);
    expect(tokenTotal({ input_tokens: 5, output_tokens: 7 })).toBe(12);
    expect(tokenTotal({})).toBe(0);
  });

  it("lists scoped runs newest first, hides content runs by default, and summarises today", async () => {
    const response = await app.inject({ method: "GET", url: `/api/seo-ops/agent-runs?limit=10&now=${encodeURIComponent(NOW.toISOString())}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.map((r: { id: string }) => r.id)).toEqual(["run-live", "run-done", "run-failed-old"]);
    expect(body.total).toBe(3);
    expect(body.items[1]).toMatchObject({
      merchant_name: "Ledger A", stage: "KEYWORDS", status: "COMPLETED", token_total: 880,
      duration_ms: 662_000, deliverable_count: 0,
    });
    expect(body.summary).toMatchObject({
      in_flight: 1, completed_today: 1, failed_today: 0, content_runs_today: 1,
      token_total_today: 880 + 150 + 150, outcome_unknown: 0, frozen_merchant_ids: [],
    });
  });

  it("completed_today counts a run created yesterday (UTC) but completed today", async () => {
    await insertAgentRun(built.db, run(merchantId, {
      id: "run-crossed-midnight",
      createdAt: "2026-08-26T23:50:00.000Z", triggeredAt: "2026-08-26T23:50:00.000Z",
      completedAt: "2026-08-27T00:10:00.000Z",
    }));

    const response = await app.inject({ method: "GET", url: `/api/seo-ops/agent-runs?limit=10&now=${encodeURIComponent(NOW.toISOString())}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.find((r: { id: string }) => r.id === "run-crossed-midnight")).toBeDefined();
    // run-done + run-crossed-midnight; run-failed-old is a week old, run-content is excluded by stage.
    expect(body.summary.completed_today).toBe(2);
  });

  it("tz_offset_minutes shifts the day boundary in both directions for the same run", async () => {
    // now = 2026-08-27T06:00:00Z is early in the UTC day (14:00 local at UTC+8).
    // UTC midnight (offset 0)   = 2026-08-27T00:00:00Z
    // UTC+8 local midnight      = 2026-08-26T16:00:00Z (expressed as a UTC instant)
    // A run completed at 2026-08-26T18:00:00Z falls after the UTC+8 local midnight but before
    // the UTC midnight — it must count as completed_today under tz_offset_minutes=480 and must
    // NOT count under tz_offset_minutes=0, proving the boundary actually shifts both ways.
    const nowTz = "2026-08-27T06:00:00.000Z";
    await insertAgentRun(built.db, run(merchantId, {
      id: "run-tz", createdAt: "2026-08-26T18:00:00.000Z", triggeredAt: "2026-08-26T18:00:00.000Z",
      completedAt: "2026-08-26T18:00:00.000Z",
    }));

    const utc = (await app.inject({
      method: "GET", url: `/api/seo-ops/agent-runs?now=${encodeURIComponent(nowTz)}&tz_offset_minutes=0`,
    })).json();
    expect(utc.summary.day_start).toBe("2026-08-27T00:00:00.000Z");
    expect(utc.summary.completed_today).toBe(1); // run-done only; run-tz falls in the prior UTC day

    const local = (await app.inject({
      method: "GET", url: `/api/seo-ops/agent-runs?now=${encodeURIComponent(nowTz)}&tz_offset_minutes=480`,
    })).json();
    expect(local.summary.day_start).toBe("2026-08-26T16:00:00.000Z");
    expect(local.summary.completed_today).toBe(2); // run-done + run-tz, now inside the UTC+8 local day
  });

  it("include_content=true reveals GBP content runs and status filter narrows", async () => {
    const all = (await app.inject({ method: "GET", url: "/api/seo-ops/agent-runs?include_content=true" })).json();
    expect(all.total).toBe(4);
    const running = (await app.inject({ method: "GET", url: "/api/seo-ops/agent-runs?status=RUNNING" })).json();
    expect(running.items.map((r: { id: string }) => r.id)).toEqual(["run-live"]);
  });

  it("scopes to the operator's merchants", async () => {
    const outsider = await createTestUser(built.db, { permissions: ["seoops.view"] });
    const login = await built.rawInject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: outsider.email, password: PASSWORD },
    });
    const setCookie = login.headers["set-cookie"];
    const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (!cookieValue) throw new Error("expected login response to include Set-Cookie");
    const cookie = cookieValue.split(";", 1)[0]!;
    const body = (await built.rawInject({
      method: "GET",
      url: "/api/seo-ops/agent-runs",
      headers: { cookie },
    })).json();
    expect(body.total).toBe(0);
    expect(body.summary.in_flight).toBe(0);
  });

  it("exposes the Core AI console url in config only when configured", async () => {
    const config = (await app.inject({ method: "GET", url: "/api/seo-ops/config" })).json();
    expect(config).toHaveProperty("core_ai_console_url", null);
  });
});

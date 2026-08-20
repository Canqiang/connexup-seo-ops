import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "./helpers/pgTest.js";

/** Fresh app + fresh schema-isolated postgres db per test. */
async function makeApp(): Promise<FastifyInstance> {
  const ctx = await createTestDb();
  const { app } = await buildApp({ ...loadConfig() }, { db: ctx.db });
  app.addHook("onClose", async () => {
    await ctx.teardown();
  });
  return app;
}

const definition = (overrides: Record<string, unknown> = {}) => ({
  title: "Task",
  task_type: "ON_PAGE_META",
  source: "SEO_AUDIT",
  priority: "MEDIUM",
  impact: "LOW",
  execution_spec: '{"a":1}',
  required_evidence_types: ["APPROVAL_REPORT"],
  ...overrides,
});

async function seedMerchantWithLocation(app: FastifyInstance) {
  const merchant = (
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "acme",
        display_name: "Acme",
        operator_user_ids: ["op-1"],
        idempotency_key: "m-1",
      },
    })
  ).json();
  const location = (
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "downtown",
        display_name: "Downtown",
        external_identities: { google_business: "g1" },
        readiness_status: "READY",
        idempotency_key: "l-1",
      },
    })
  ).json();
  return { merchant, location };
}

async function createTask(
  app: FastifyInstance,
  merchantId: string,
  locationId: string,
  overrides: Record<string, unknown> = {},
  key = "t",
) {
  const res = await app.inject({
    method: "POST",
    url: "/api/seo-ops/tasks",
    payload: {
      merchant_id: merchantId,
      location_id: locationId,
      definition: definition(overrides),
      idempotency_key: key,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("auth + config stubs", () => {
  it("GET /api/auth/me returns the fixed identity", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/auth/me" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        user_id: "local-dev",
        name: "Local Operator",
        role: "seo_lead",
        permissions: ["*"],
      });
    } finally {
      await app.close();
    }
  });

  it("GET /api/seo-ops/config reports copilot disabled and agent runs off without env", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({ method: "GET", url: "/api/seo-ops/config" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        copilot_enabled: false,
        agent_run_enabled: false,
        agent_run_stages: [
          "KEYWORDS",
          "AUDIT",
          "RANKING_BASELINE",
          "PLAN",
          "REVIEW",
        ],
      });
    } finally {
      await app.close();
    }
  });
});

describe("portfolio", () => {
  let app: FastifyInstance;
  let merchant: { id: string };
  let location: { id: string };

  beforeEach(async () => {
    app = await makeApp();
    ({ merchant, location } = await seedMerchantWithLocation(app));
  });
  afterEach(() => app.close());

  it("aggregates counts, owners, locations, and health", async () => {
    await createTask(app, merchant.id, location.id, { priority: "URGENT", owner_id: "op-1" }, "t1");
    const ready = await createTask(app, merchant.id, location.id, {}, "t2");
    // push t2 to READY_FOR_APPROVAL with verified evidence
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${ready.id}/evidence`,
      payload: {
        type: "APPROVAL_REPORT",
        source_ref: "s",
        captured_at: "2026-08-01T00:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "APPROVAL_REPORT",
        expected_state_version: 1,
        idempotency_key: "e1",
      },
    });

    const res = await app.inject({ method: "GET", url: "/api/seo-ops/portfolio" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.merchants).toHaveLength(1);
    const m = body.merchants[0];
    expect(m).toMatchObject({
      slug: "acme",
      display_name: "Acme",
      operator_user_ids: ["op-1"],
      operators: [{ id: "op-1", name: "op-1" }],
      owner_ids: ["op-1"],
      location_count: 1,
      task_count: 2,
      ready_for_approval_count: 1,
      blocked_count: 0,
    });
    expect(m.locations).toEqual([
      { id: location.id, display_name: "Downtown", readiness_status: "READY" },
    ]);
    // ready task exists -> ATTENTION
    expect(m.health).toBe("ATTENTION");
    expect(body.totals).toEqual({ tasks: 2, blocked: 0, ready_for_approval: 1, overdue: 0 });
  });

  it("empty merchant list -> empty portfolio", async () => {
    const emptyApp = await makeApp();
    try {
      const res = await emptyApp.inject({ method: "GET", url: "/api/seo-ops/portfolio" });
      expect(res.json()).toEqual({
        merchants: [],
        totals: { tasks: 0, blocked: 0, ready_for_approval: 0, overdue: 0 },
      });
    } finally {
      await emptyApp.close();
    }
  });
});

describe("inbox", () => {
  let app: FastifyInstance;
  let merchant: { id: string };
  let location: { id: string };

  beforeEach(async () => {
    app = await makeApp();
    ({ merchant, location } = await seedMerchantWithLocation(app));
  });
  afterEach(() => app.close());

  it("paginates, filters by status, sorts URGENT first", async () => {
    await createTask(app, merchant.id, location.id, { priority: "LOW" }, "t1");
    await createTask(app, merchant.id, location.id, { priority: "URGENT" }, "t2");
    await createTask(app, merchant.id, location.id, { priority: "HIGH" }, "t3");

    const page1 = (
      await app.inject({ method: "GET", url: "/api/seo-ops/inbox?limit=2" })
    ).json();
    expect(page1.total).toBe(3);
    expect(page1.items.map((i: { priority: string }) => i.priority)).toEqual(["URGENT", "HIGH"]);
    expect(page1.items[0]).toMatchObject({ merchant_name: "Acme", location_name: "Downtown" });

    const page2 = (
      await app.inject({ method: "GET", url: "/api/seo-ops/inbox?offset=2&limit=2" })
    ).json();
    expect(page2.items.map((i: { priority: string }) => i.priority)).toEqual(["LOW"]);

    const filtered = (
      await app.inject({ method: "GET", url: `/api/seo-ops/inbox?merchant_id=${merchant.id}&status=NEEDS_INPUT` })
    ).json();
    expect(filtered.total).toBe(3);

    const none = (
      await app.inject({ method: "GET", url: "/api/seo-ops/inbox?status=APPROVED" })
    ).json();
    expect(none.total).toBe(0);
  });

  it("rejects out-of-range pagination with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/seo-ops/inbox?limit=0" });
    expect(res.statusCode).toBe(400);
  });
});

describe("task detail + events", () => {
  let app: FastifyInstance;
  let task: { id: string };

  beforeEach(async () => {
    app = await makeApp();
    const { merchant, location } = await seedMerchantWithLocation(app);
    task = await createTask(app, merchant.id, location.id);
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: {
        type: "APPROVAL_REPORT",
        source_ref: "s",
        captured_at: "2026-08-01T00:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "APPROVAL_REPORT",
        expected_state_version: 1,
        idempotency_key: "e1",
      },
    });
  });
  afterEach(() => app.close());

  it("GET /tasks/:id returns the full aggregate", async () => {
    const res = await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(task.id);
    expect(body.evidence_refs).toHaveLength(1);
    expect(body.status).toBe("READY_FOR_APPROVAL");
  });

  it("GET /tasks/:id/events pages newest-first", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}/events?limit=1`,
    });
    expect(res.statusCode).toBe(200);
    const page = res.json();
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].type).toBe("EVIDENCE_APPENDED");
    expect(page.items[0]).toHaveProperty("resulting_state_version", 2);
  });

  it("404s for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/seo-ops/tasks/nope" });
    expect(res.statusCode).toBe(404);
    const events = await app.inject({ method: "GET", url: "/api/seo-ops/tasks/nope/events" });
    expect(events.statusCode).toBe(404);
  });
});

describe("reviews + reports", () => {
  let app: FastifyInstance;
  let merchant: { id: string };
  let location: { id: string };
  let task: { id: string };

  beforeEach(async () => {
    app = await makeApp();
    ({ merchant, location } = await seedMerchantWithLocation(app));
    task = await createTask(app, merchant.id, location.id);
  });
  afterEach(() => app.close());

  const addEvidence = async (
    type: string,
    key: string,
    capturedAt: string,
    verification = "UNVERIFIED",
  ) => {
    const current = (await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` })).json();
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: {
        type,
        source_ref: `ref-${type}`,
        captured_at: capturedAt,
        verification_status: verification,
        requirement_key: type,
        expected_state_version: current.state_version,
        idempotency_key: key,
      },
    });
    expect(res.statusCode).toBe(201);
  };

  it("classifies FACTUAL with a single verified report evidence", async () => {
    await addEvidence("SITE_AUDIT_REPORT", "r1", "2026-08-10T00:00:00.000Z", "VERIFIED");
    const res = await app.inject({ method: "GET", url: "/api/seo-ops/reviews" });
    const page = res.json();
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      task_id: task.id,
      classification: "FACTUAL",
      conclusion_strength: "LOW",
      competing_explanations: [],
    });
    expect(page.items[0].evidence_ids).toHaveLength(1);
  });

  it("empty reviews when no evidence on current revision", async () => {
    const res = await app.inject({ method: "GET", url: "/api/seo-ops/reviews" });
    expect(res.json().total).toBe(0);
  });

  it("projects *_REPORT evidence with freshness tiers and filters", async () => {
    // fresh (1 day ago), aging (10 days ago), stale (40 days ago) relative to 2026-08-19
    await addEvidence("SITE_AUDIT_REPORT", "r1", "2026-08-18T00:00:00.000Z");
    await addEvidence("SITE_AUDIT_REPORT", "r2", "2026-08-09T00:00:00.000Z");
    await addEvidence("KEYWORD_RANK_REPORT", "r3", "2026-07-10T00:00:00.000Z");

    const res = await app.inject({ method: "GET", url: "/api/seo-ops/reports" });
    const page = res.json();
    expect(page.total).toBe(3);
    const byType = new Map(page.items.map((i: { report_type: string; freshness: string }) => [i.report_type, i.freshness]));
    // two SITE_AUDIT_REPORT entries — map keeps the last; check directly instead
    const freshnesses = page.items
      .filter((i: { report_type: string }) => i.report_type === "SITE_AUDIT_REPORT")
      .map((i: { freshness: string }) => i.freshness)
      .sort();
    expect(freshnesses).toEqual(["AGING", "FRESH"]);
    expect(byType.get("KEYWORD_RANK_REPORT")).toBe("STALE");

    const fresh = (
      await app.inject({ method: "GET", url: "/api/seo-ops/reports?freshness=FRESH" })
    ).json();
    expect(fresh.total).toBe(1);
    expect(fresh.items[0].report_type).toBe("SITE_AUDIT_REPORT");

    const byTypeFilter = (
      await app.inject({ method: "GET", url: "/api/seo-ops/reports?report_type=KEYWORD_RANK_REPORT" })
    ).json();
    expect(byTypeFilter.total).toBe(1);

    const byWindow = (
      await app.inject({
        method: "GET",
        url: "/api/seo-ops/reports?captured_from=2026-08-15T00:00:00.000Z&captured_to=2026-08-20T00:00:00.000Z",
      })
    ).json();
    expect(byWindow.total).toBe(1);
  });

  it("rejects invalid captured_from with 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/seo-ops/reports?captured_from=garbage",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/captured_from/);
  });

  it("non-report evidence is not projected into reports", async () => {
    await addEvidence("APPROVAL_REPORT_NOTE", "r9", "2026-08-18T00:00:00.000Z");
    const res = await app.inject({ method: "GET", url: "/api/seo-ops/reports" });
    expect(res.json().total).toBe(0);
  });
});

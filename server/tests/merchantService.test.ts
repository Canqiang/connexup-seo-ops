import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

/** Fresh app + fresh schema-isolated postgres db per test. */
async function makeApp(): Promise<FastifyInstance> {
  return (await createAuthenticatedTestApp()).app;
}

const merchantBody = (overrides: Record<string, unknown> = {}) => ({
  slug: "acme-bakery",
  display_name: "Acme Bakery",
  tags: ["vip"],
  operator_user_ids: ["op-1"],
  idempotency_key: "idem-merchant-1",
  ...overrides,
});

describe("POST /api/seo-ops/merchants", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await makeApp();
  });

  afterEach(() => app.close());

  it("creates a merchant (201) with snake_case view", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      slug: "acme-bakery",
      display_name: "Acme Bakery",
      tags: ["vip"],
      operator_user_ids: ["op-1"],
      planner_enqueued: false,
      planner_task_id: null,
    });
    expect(body.id).toBeTruthy();
    expect(body.created_at).toBeTruthy();
  });

  it("normalizes slug to lowercase", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody({ slug: "  Acme-Bakery  " }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().slug).toBe("acme-bakery");
  });

  it("replays idempotently: same key + same body -> 200, same id", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody(),
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody({ tags: ["vip"] }), // key order differs, canonical hash equal
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  it("rejects same key + different body with 409 IDEMPOTENCY_CONFLICT", async () => {
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody({ display_name: "Different" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("rejects duplicate slug with 409 DUPLICATE_SLUG", async () => {
    await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody(),
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody({ idempotency_key: "idem-merchant-2" }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error_code).toBe("DUPLICATE_SLUG");
  });

  it("rejects invalid slug chars with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody({ slug: "not valid!" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/slug/);
  });

  it("rejects missing idempotency_key with 400", async () => {
    const { idempotency_key: _drop, ...rest } = merchantBody();
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: rest,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error_code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /api/seo-ops/merchants/:id/locations", () => {
  let app: FastifyInstance;
  let merchantId: string;

  beforeEach(async () => {
    app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: merchantBody(),
    });
    merchantId = res.json().id;
  });

  afterEach(() => app.close());

  const locationBody = (overrides: Record<string, unknown> = {}) => ({
    slug: "downtown",
    display_name: "Downtown",
    timezone: "America/Los_Angeles",
    external_identities: { google_business: "gid-123" },
    readiness_status: "READY",
    missing_requirements: [],
    idempotency_key: "idem-location-1",
    ...overrides,
  });

  it("creates a ready location (201)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody(),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      merchant_id: merchantId,
      slug: "downtown",
      readiness_status: "READY",
      missing_requirements: [],
      external_identities: { google_business: "gid-123" },
    });
  });

  it("READY with missing_requirements -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody({ missing_requirements: ["GOOGLE_ACCESS"] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("READY without external identities -> 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody({ external_identities: {} }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/external identity/i);
  });

  it("BLOCKED requires at least one missing_requirement", async () => {
    const ok = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody({
        readiness_status: "BLOCKED",
        missing_requirements: ["GOOGLE_ACCESS"],
        external_identities: {},
      }),
    });
    expect(ok.statusCode).toBe(201);

    const bad = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody({
        slug: "other",
        readiness_status: "BLOCKED",
        missing_requirements: [],
        idempotency_key: "idem-location-3",
      }),
    });
    expect(bad.statusCode).toBe(400);
  });

  it("replays idempotently and rejects fingerprint mismatch", async () => {
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody(),
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);

    const clash = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/locations`,
      payload: locationBody({ display_name: "Renamed" }),
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("404 for unknown merchant", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/nope/locations`,
      payload: locationBody(),
    });
    expect(res.statusCode).toBe(404);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

describe("cross-merchant capabilities", () => {
  let built: AuthenticatedTestApp;
  let app: FastifyInstance;
  let merchantId: string;
  beforeEach(async () => {
    built = await createAuthenticatedTestApp();
    app = built.app;
    merchantId = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "cap-a",
          display_name: "Cap A",
          operator_user_ids: [built.actor.userId],
          idempotency_key: "cap-a",
        },
      })
    ).json().id;
    await app.inject({
      method: "PUT",
      url: `/api/seo-ops/merchants/${merchantId}/capabilities/XHS_PUBLISH`,
      payload: { asset: "XHS", tech_connected: false, merchant_authorized: false, note: "账号待连接" },
    });
  });
  afterEach(async () => app.close());
  it("lists capabilities across scoped merchants with merchant names", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/seo-ops/capabilities" })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      merchant_id: merchantId,
      merchant_name: "Cap A",
      capability: "XHS_PUBLISH",
      status: "MISSING",
      note: "账号待连接",
    });
  });
});

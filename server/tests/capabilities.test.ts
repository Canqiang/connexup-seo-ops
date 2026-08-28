import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createAuthenticatedTestApp, createTestUser, PASSWORD, type AuthenticatedTestApp } from "./helpers/authTest.js";

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
      url: "/api/seo-ops/capabilities",
      headers: { cookie },
    })).json();
    expect(body.items).toEqual([]);
  });
});

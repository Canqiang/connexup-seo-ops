import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/index.js";
import { createTestDb } from "./helpers/pgTest.js";

describe("single-user mode", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
  });

  it("can create a merchant without a separately seeded database user", async () => {
    const isolated = await createTestDb();
    const built = await buildApp(
      {
        ...loadConfig(),
        singleUserMode: true,
      },
      { db: isolated.db, coreAi: null, poller: null },
    );
    app = built.app;
    app.addHook("onClose", isolated.teardown);

    const response = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "single-user-merchant",
        display_name: "Single User Merchant",
        idempotency_key: "single-user-merchant-create",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      slug: "single-user-merchant",
      operator_user_ids: ["single-user-admin"],
    });
  });

  it("enables binding-driven execution without the legacy stage-run agent id", async () => {
    const isolated = await createTestDb();
    const built = await buildApp(
      {
        ...loadConfig(),
        singleUserMode: true,
        coreAiBaseUrl: "https://core-ai.example.test",
        coreAiToken: "test-core-ai-token",
        agentRunAgentId: null,
      },
      { db: isolated.db, poller: null },
    );
    app = built.app;
    app.addHook("onClose", isolated.teardown);

    const response = await app.inject({
      method: "POST",
      url: "/api/seo-ops/admin/execution-tick",
    });

    expect(response.statusCode).toBe(200);
  });
});

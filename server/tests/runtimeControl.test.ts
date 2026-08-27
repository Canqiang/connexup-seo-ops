import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";
import {
  effectiveRuntimePause,
  listRuntimeControlHistory,
  setRuntimePause,
} from "../src/services/runtimeControlService.js";
import type { CoreAiClient } from "../src/services/coreAiClient.js";

const inertCoreAi: CoreAiClient = {
  async trigger() { return { run_id: "unexpected-core-run", status: "RUNNING" }; },
  async getRun(id) { return { id, agent_id: "agent-1", status: "RUNNING" }; },
  async cancel() { /* no-op */ },
  async downloadArtifact() { throw new Error("download not expected"); },
};

describe("runtime pause controls", () => {
  let built: AuthenticatedTestApp;
  let merchantId: string;

  beforeEach(async () => {
    built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: "agent-1",
      },
      deps: { coreAi: inertCoreAi },
    });
    merchantId = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "runtime-control-merchant",
        display_name: "Runtime Control Merchant",
        operator_user_ids: [built.actor.userId],
        idempotency_key: "runtime-control-merchant",
      },
    })).json().id;
  });

  afterEach(() => built.app.close());

  it("appends pause and resume decisions instead of overwriting audit history", async () => {
    await setRuntimePause(built.db, {
      scope: "MERCHANT",
      merchantId,
      paused: true,
      reason: "Merchant requested a temporary hold",
      actorId: built.actor.userId,
    });
    expect(await effectiveRuntimePause(built.db, merchantId)).toMatchObject({
      paused: true,
      source: "MERCHANT",
      reason: "Merchant requested a temporary hold",
    });

    await setRuntimePause(built.db, {
      scope: "MERCHANT",
      merchantId,
      paused: false,
      reason: "Merchant approved operations to resume",
      actorId: built.actor.userId,
    });
    expect(await effectiveRuntimePause(built.db, merchantId)).toMatchObject({
      paused: false,
      source: null,
    });
    expect(await listRuntimeControlHistory(built.db, "MERCHANT", merchantId)).toHaveLength(2);
  });

  it("lets a global pause override a resumed merchant control", async () => {
    await setRuntimePause(built.db, {
      scope: "MERCHANT", merchantId, paused: false,
      reason: "Merchant is ready", actorId: built.actor.userId,
    });
    await setRuntimePause(built.db, {
      scope: "GLOBAL", merchantId: null, paused: true,
      reason: "Incident response", actorId: built.actor.userId,
    });

    expect(await effectiveRuntimePause(built.db, merchantId)).toMatchObject({
      paused: true,
      source: "GLOBAL",
      reason: "Incident response",
    });
  });

  it("requires a reason and exposes independently read back global and merchant state", async () => {
    const missingReason = await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/runtime-controls",
      payload: { scope: "MERCHANT", merchant_id: merchantId, paused: true, reason: "" },
    });
    expect(missingReason.statusCode).toBe(400);

    const changed = await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/runtime-controls",
      payload: {
        scope: "MERCHANT", merchant_id: merchantId, paused: true,
        reason: "Pause while merchant reviews the plan",
      },
    });
    expect(changed.statusCode).toBe(201);

    const readback = await built.app.inject({
      method: "GET",
      url: `/api/seo-ops/runtime-controls?merchant_id=${merchantId}`,
    });
    expect(readback.statusCode).toBe(200);
    expect(readback.json()).toMatchObject({
      effective_paused: true,
      effective_source: "MERCHANT",
      merchant: {
        merchant_id: merchantId,
        paused: true,
        reason: "Pause while merchant reviews the plan",
        changed_by: built.actor.userId,
      },
    });
  });

  it("rejects new generic and GBP content Agent triggers while the merchant is paused", async () => {
    await setRuntimePause(built.db, {
      scope: "MERCHANT",
      merchantId,
      paused: true,
      reason: "Hold all new merchant work",
      actorId: built.actor.userId,
    });

    const stage = await built.app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchantId}/stage-runs`,
      payload: { stage: "KEYWORDS", idempotency_key: "paused-keywords" },
    });
    expect(stage.statusCode).toBe(409);
    expect(stage.json()).toMatchObject({ error_code: "RUNTIME_PAUSED" });

    const task = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchantId,
        definition: {
          title: "Paused GBP post",
          task_type: "GBP_POST",
          source: "MANUAL",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({}),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: "paused-gbp-task",
      },
    })).json();
    const content = await built.app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "paused-gbp-content" },
    });
    expect(content.statusCode).toBe(409);
    expect(content.json()).toMatchObject({ error_code: "RUNTIME_PAUSED" });
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { AgentRunPoller } from "../src/services/agentRunPoller.js";
import { parseGbpPostDraftOutput } from "../src/services/gbpPostContentService.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

describe("GBP Post Content Agent pre-Gate draft path", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function fakeCore(options: { failTriggerNumbers?: number[] } = {}) {
    let triggerCount = 0;
    let lastAgentId = "";
    const inputs = new Map<string, Record<string, unknown>>();
    const client: CoreAiClient = {
      async trigger(agentId, message) {
        triggerCount += 1;
        if (options.failTriggerNumbers?.includes(triggerCount)) {
          throw new Error(`simulated trigger failure ${triggerCount}`);
        }
        lastAgentId = agentId;
        const runId = `core-gbp-content-${triggerCount}`;
        inputs.set(runId, JSON.parse(message) as Record<string, unknown>);
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { run_id: runId, status: "RUNNING" };
      },
      async getRun(id): Promise<CoreAgentRunDetail> {
        const request = inputs.get(id) as {
          merchant: { id: string };
          location: { id: string };
          occurrence_at: string;
          post_type: string;
          voice_profile: { version_ref: string };
          primary_keyword_cluster: Record<string, unknown>;
          evidence_references: string[];
        };
        return {
          id,
          agent_id: "agent-gbp-content",
          status: "COMPLETED",
          output: JSON.stringify({
            schema_version: "seo_ops.gbp_post_draft.v1",
            merchant_id: request.merchant.id,
            location_id: request.location.id,
            occurrence_at: request.occurrence_at,
            market: { country_code: "US", language: "en-US", search_engine: "GOOGLE" },
            post_type: request.post_type,
            voice_profile_version: request.voice_profile.version_ref,
            primary_keyword_cluster: request.primary_keyword_cluster,
            evidence_references: request.evidence_references,
            copy: "Try our crispy chicken lunch in Mineola this Thursday.",
            media_brief: {
              concept: "Crispy chicken lunch plate in the restaurant.",
              alt_text: "Crispy chicken lunch served in Mineola.",
            },
            limitations: [],
          }),
        };
      },
      async cancel() {},
      async downloadArtifact() { throw new Error("GBP content has no attachments"); },
    };
    return {
      client,
      triggerCount: () => triggerCount,
      lastAgentId: () => lastAgentId,
    };
  }

  async function setupContentTask(coreAi: CoreAiClient, suffix: string) {
    const artifactsDir = mkdtempSync(join(tmpdir(), `seo-ops-gbp-${suffix}-`));
    tempDirs.push(artifactsDir);
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi, artifactsDir },
    });
    apps.push(built.app);
    const merchant = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: `${suffix}-store`,
        display_name: `${suffix} Store`,
        idempotency_key: `${suffix}-store`,
      },
    })).json();
    const location = (await built.app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: `${suffix}-mineola`,
        display_name: "Mineola, NY",
        timezone: "America/New_York",
        readiness_status: "READY",
        external_identities: { google_business: `locations/${suffix}` },
        missing_requirements: [],
        idempotency_key: `${suffix}-location`,
      },
    })).json();
    await built.app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/GBP_POST",
      payload: { agent_id: "agent-gbp-content", agent_label: "GBP content" },
    });
    await built.app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "warm and concise" } },
    });
    const task = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        location_id: location.id,
        definition: {
          title: `${suffix} GBP Post`,
          task_type: "GBP_POST",
          source: "CYCLE",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({
            occurrence_at: "2026-08-27T17:00:00.000-04:00",
            post_type: "STANDARD",
            primary_keyword_cluster: {
              cluster_id: `${suffix}-lunch`,
              search_intent: "local lunch discovery",
              keywords: ["crispy chicken lunch mineola"],
            },
            evidence_references: ["artifact:keyword-set-v2"],
          }),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: `${suffix}-task`,
      },
    })).json();
    return { ...built, merchant, location, task };
  }

  it("enforces auth and tenant scope before a Core AI trigger", async () => {
    const core = fakeCore();
    const artifactsDir = mkdtempSync(join(tmpdir(), "seo-ops-gbp-auth-"));
    tempDirs.push(artifactsDir);
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi: core.client, artifactsDir },
    });
    apps.push(built.app);
    const unauthenticated = await built.rawInject({
      method: "POST",
      url: "/api/seo-ops/tasks/hidden/content-runs",
      payload: { idempotency_key: "hidden" },
    });
    expect(unauthenticated.statusCode).toBe(401);

    const merchant = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "hidden-store", idempotency_key: "hidden-store" },
    })).json();
    const task = (await built.app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        definition: {
          title: "Hidden post",
          task_type: "GBP_POST",
          source: "MANUAL",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({}),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: "hidden-task",
      },
    })).json();
    await built.db.exec(
      `UPDATE seo_merchants SET operator_user_ids = $1 WHERE id = $2`,
      [JSON.stringify(["different-operator"]), merchant.id],
    );
    const hidden = await built.app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "hidden-run" },
    });
    expect(hidden.statusCode).toBe(404);
    expect(core.triggerCount()).toBe(0);

    const viewOnlyDir = mkdtempSync(join(tmpdir(), "seo-ops-gbp-view-only-"));
    tempDirs.push(viewOnlyDir);
    const viewOnly = await createAuthenticatedTestApp({
      permissions: ["seoops.view"],
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi: core.client, artifactsDir: viewOnlyDir },
    });
    apps.push(viewOnly.app);
    expect((await viewOnly.app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks/any/content-runs",
      payload: { idempotency_key: "view-only" },
    })).statusCode).toBe(403);
    expect(core.triggerCount()).toBe(0);
  });

  it("rejects publication claims at the strict output parser boundary", () => {
    const output = {
      schema_version: "seo_ops.gbp_post_draft.v1",
      merchant_id: "merchant-1",
      location_id: "location-1",
      occurrence_at: "2026-08-27T17:00:00.000-04:00",
      market: { country_code: "US", language: "en-US", search_engine: "GOOGLE" },
      post_type: "STANDARD",
      voice_profile_version: "voice-1:v1",
      primary_keyword_cluster: {
        cluster_id: "mineola-lunch",
        search_intent: "local lunch discovery",
        keywords: ["crispy chicken lunch mineola"],
      },
      evidence_references: ["artifact:keyword-set-v2"],
      copy: "Try our crispy chicken lunch in Mineola this Thursday.",
      media_brief: { concept: "Lunch plate", alt_text: "Crispy chicken lunch" },
      limitations: [],
    };
    expect(parseGbpPostDraftOutput(JSON.stringify(output))).toMatchObject({
      schema_version: "seo_ops.gbp_post_draft.v1",
    });
    expect(() => parseGbpPostDraftOutput(JSON.stringify({ ...output, published: true })))
      .toThrow(/published/);
  });

  it("triggers once, persists one Agent draft under concurrent polling, and stays before Gate 1", async () => {
    const core = fakeCore();
    const artifactsDir = mkdtempSync(join(tmpdir(), "seo-ops-gbp-content-"));
    tempDirs.push(artifactsDir);
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi: core.client, artifactsDir },
    });
    apps.push(built.app);
    const { app, db } = built;
    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "mineola-content-store",
        display_name: "Mineola Content Store",
        idempotency_key: "mineola-content-store",
      },
    })).json();
    const location = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "mineola",
        display_name: "Mineola, NY",
        timezone: "America/New_York",
        readiness_status: "READY",
        external_identities: { google_business: "locations/gbp-mineola" },
        missing_requirements: [],
        idempotency_key: "mineola-content-location",
      },
    })).json();
    expect((await app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/GBP_POST",
      payload: { agent_id: "agent-gbp-content", agent_label: "GBP content" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "warm", banned: ["best ever"] } },
    })).statusCode).toBe(201);
    const task = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        location_id: location.id,
        definition: {
          title: "August 27 GBP Post",
          task_type: "GBP_POST",
          source: "CYCLE",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({
            occurrence_at: "2026-08-27T17:00:00.000-04:00",
            post_type: "STANDARD",
            primary_keyword_cluster: {
              cluster_id: "mineola-lunch",
              search_intent: "local lunch discovery",
              keywords: ["crispy chicken lunch mineola"],
            },
            evidence_references: ["artifact:keyword-set-v2", "questionnaire:confirmed"],
          }),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: "mineola-content-task",
      },
    })).json();
    expect(task.status).toBe("NEEDS_INPUT");

    const calls = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: "mineola-content-run-a" },
      }),
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: "mineola-content-run-b" },
      }),
    ]);
    expect(calls.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(calls[0].json().id).toBe(calls[1].json().id);
    expect(calls[0].json()).toMatchObject({
      task_id: task.id,
      stage: "GBP_POST_CONTENT",
      run_type: "GBP_POST_CONTENT",
    });
    expect(core.triggerCount()).toBe(1);
    expect(core.lastAgentId()).toBe("agent-gbp-content");

    const beforePoll = (await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` })).json();
    expect(beforePoll).toMatchObject({ status: "NEEDS_INPUT", attempt_count: 0 });
    expect((await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/attempts` })).json().items)
      .toEqual([]);

    const pollerA = new AgentRunPoller({ db, client: core.client, artifactsDir });
    const pollerB = new AgentRunPoller({ db, client: core.client, artifactsDir });
    await Promise.all([pollerA.pollOnce(), pollerB.pollOnce()]);
    await pollerA.pollOnce();

    const drafts = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
    })).json().items;
    expect(drafts).toEqual([expect.objectContaining({
      version: 1,
      source: "AGENT_GENERATED",
      agent_run_id: calls[0].json().id,
      body: "Try our crispy chicken lunch in Mineola this Thursday.",
    })]);
    const afterPoll = (await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}` })).json();
    expect(afterPoll).toMatchObject({ status: "NEEDS_INPUT", attempt_count: 0 });
    const run = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/agent-runs/${calls[0].json().id}`,
    })).json();
    expect(run).toMatchObject({ status: "COMPLETED", task_id: task.id });

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "mineola-content-run-after-terminal" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(run.id);
    expect(core.triggerCount()).toBe(1);
    expect((await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${task.id}/drafts` }))
      .json().items).toHaveLength(1);

    expect((await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "warm and concise", banned: ["best ever"] } },
    })).statusCode).toBe(201);
    const regenerated = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "mineola-content-run-style-v2" },
    });
    expect(regenerated.statusCode).toBe(202);
    expect(regenerated.json().id).not.toBe(run.id);
    expect(core.triggerCount()).toBe(2);

    expect((await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "warm, concise, and seasonal", banned: ["best ever"] } },
    })).statusCode).toBe(201);
    const activeConflict = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "mineola-content-run-style-v3" },
    });
    expect(activeConflict.statusCode).toBe(409);
    expect(core.triggerCount()).toBe(2);
  });

  it("shares the merchant daily Agent Run quota before triggering Core AI", async () => {
    const core = fakeCore();
    const artifactsDir = mkdtempSync(join(tmpdir(), "seo-ops-gbp-quota-"));
    tempDirs.push(artifactsDir);
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        agentRunDailyLimit: 1,
        mockExecution: false,
      },
      deps: { coreAi: core.client, artifactsDir },
    });
    apps.push(built.app);
    const { app } = built;
    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "quota-store", display_name: "Quota Store", idempotency_key: "quota-store" },
    })).json();
    const location = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "mineola",
        display_name: "Mineola, NY",
        timezone: "America/New_York",
        readiness_status: "READY",
        external_identities: { google_business: "locations/gbp-quota" },
        missing_requirements: [],
        idempotency_key: "quota-location",
      },
    })).json();
    await app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/GBP_POST",
      payload: { agent_id: "agent-gbp-content", agent_label: "GBP content" },
    });
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "warm" } },
    });
    const createTask = async (suffix: string, occurrenceAt: string) => (await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: merchant.id,
        location_id: location.id,
        definition: {
          title: `GBP Post ${suffix}`,
          task_type: "GBP_POST",
          source: "CYCLE",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({
            occurrence_at: occurrenceAt,
            post_type: "STANDARD",
            primary_keyword_cluster: {
              cluster_id: `mineola-lunch-${suffix}`,
              search_intent: "local lunch discovery",
              keywords: ["crispy chicken lunch mineola"],
            },
            evidence_references: ["artifact:keyword-set-v2"],
          }),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: `quota-task-${suffix}`,
      },
    })).json();
    const firstTask = await createTask("one", "2026-08-27T17:00:00.000-04:00");
    const secondTask = await createTask("two", "2026-08-28T17:00:00.000-04:00");

    const attempts = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${firstTask.id}/content-runs`,
        payload: { idempotency_key: "quota-run-one" },
      }),
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${secondTask.id}/content-runs`,
        payload: { idempotency_key: "quota-run-two" },
      }),
    ]);
    expect(attempts.map((response) => response.statusCode).sort()).toEqual([202, 429]);
    const rejected = attempts.find((response) => response.statusCode === 429)!;
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ error_code: "RUN_LIMIT_REACHED" });
    const stored = await built.db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE merchant_id = $1`,
      [merchant.id],
    );
    expect(stored?.count).toBe("1");
    expect(core.triggerCount()).toBe(1);
  });

  it("requires explicit audited retry lineage for failed or cancelled generations", async () => {
    const core = fakeCore({ failTriggerNumbers: [1] });
    const built = await setupContentTask(core.client, "retry-taxonomy");
    const { app, db, task } = built;

    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "retry-first-trigger-fails" },
    });
    expect(first.statusCode).toBe(502);
    const triggerFailed = await db.one<{
      id: string; request_fingerprint: string; business_input_fingerprint: string;
      status: string; error_code: string; retry_of_agent_run_id: string | null;
    }>(`SELECT id, request_fingerprint, business_input_fingerprint, status, error_code,
               retry_of_agent_run_id
          FROM seo_agent_runs WHERE task_id = $1`, [task.id]);
    expect(triggerFailed).toMatchObject({
      status: "FAILED",
      error_code: "TRIGGER_FAILED",
      retry_of_agent_run_id: null,
    });
    expect(triggerFailed!.business_input_fingerprint).toBe(triggerFailed!.request_fingerprint);

    const implicitRetry = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "retry-without-audit" },
    });
    expect(implicitRetry.statusCode).toBe(409);
    expect(implicitRetry.json().error_code).toBe("CONTENT_RUN_RETRY_REQUIRED");

    const retryPayload = {
      idempotency_key: "retry-after-trigger-failure",
      retry: { prior_run_id: triggerFailed!.id, reason: "Core AI transport failed before a run id returned." },
    };
    const triggerRetry = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: retryPayload,
    });
    expect(triggerRetry.statusCode).toBe(202);
    expect(triggerRetry.json()).toMatchObject({
      retry_of_agent_run_id: triggerFailed!.id,
      retry_reason: retryPayload.retry.reason,
      business_input_fingerprint: triggerFailed!.business_input_fingerprint,
    });
    expect(triggerRetry.json().request_fingerprint).not.toBe(triggerFailed!.request_fingerprint);

    const sameRetryDifferentKey = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { ...retryPayload, idempotency_key: "retry-after-trigger-failure-replay" },
    });
    expect(sameRetryDifferentKey.statusCode).toBe(200);
    expect(sameRetryDifferentKey.json().id).toBe(triggerRetry.json().id);

    await db.exec(
      `UPDATE seo_agent_runs SET status = 'FAILED', error_code = 'OUTPUT_INVALID',
              completed_at = '2026-08-27T01:00:00.000Z'
        WHERE id = $1`,
      [triggerRetry.json().id],
    );
    const outputRetry = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-after-output-invalid",
        retry: {
          prior_run_id: triggerRetry.json().id,
          reason: "Strict output validation rejected the previous response.",
        },
      },
    });
    expect(outputRetry.statusCode).toBe(202);

    await db.exec(
      `UPDATE seo_agent_runs SET status = 'CANCELLED', error_code = NULL,
              completed_at = '2026-08-27T02:00:00.000Z'
        WHERE id = $1`,
      [outputRetry.json().id],
    );
    const cancelledRetry = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-after-cancelled",
        retry: {
          prior_run_id: outputRetry.json().id,
          reason: "Operator cancelled the previous generation after reviewing context.",
        },
      },
    });
    expect(cancelledRetry.statusCode).toBe(202);

    await db.exec(
      `UPDATE seo_agent_runs SET status = 'FAILED', error_code = 'TRIGGER_INTERRUPTED',
              completed_at = '2026-08-27T03:00:00.000Z'
        WHERE id = $1`,
      [cancelledRetry.json().id],
    );
    const interrupted = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-after-interrupted",
        retry: {
          prior_run_id: cancelledRetry.json().id,
          reason: "Attempt to bypass manual reconciliation must be blocked.",
        },
      },
    });
    expect(interrupted.statusCode).toBe(409);
    expect(interrupted.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(core.triggerCount()).toBe(4);
    const stored = await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
      [task.id],
    );
    expect(stored?.count).toBe("4");
  });
});

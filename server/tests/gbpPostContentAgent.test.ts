import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { AgentRunPoller } from "../src/services/agentRunPoller.js";
import { parseGbpPostDraftOutput } from "../src/services/gbpPostContentService.js";
import { addAgentGeneratedDraftFromRun } from "../src/services/contentService.js";
import { migrate } from "../src/db/migrate.js";
import { gbpContentHttpRequestFingerprint } from "../src/domain/gbpContentRunIdentity.js";
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

  function fakeCore(options: {
    failTriggerNumbers?: number[];
    onTriggerStarted?: () => void;
    waitBeforeTriggerReturn?: () => Promise<void>;
  } = {}) {
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
        try {
          inputs.set(runId, JSON.parse(message) as Record<string, unknown>);
        } catch {
          // Generic Stage Runs use a bounded text prompt; only GBP content
          // polling needs a structured request echo in this fake.
        }
        options.onTriggerStarted?.();
        await options.waitBeforeTriggerReturn?.();
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

  async function setupContentTask(
    coreAi: CoreAiClient,
    suffix: string,
    config: { dailyRunLimit?: number; stageAgentId?: string } = {},
  ) {
    const artifactsDir = mkdtempSync(join(tmpdir(), `seo-ops-gbp-${suffix}-`));
    tempDirs.push(artifactsDir);
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: config.stageAgentId ?? null,
        agentRunDailyLimit: config.dailyRunLimit ?? 20,
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
    return { ...built, artifactsDir, merchant, location, task };
  }

  async function holdMerchantLock(
    db: Awaited<ReturnType<typeof setupContentTask>>["db"],
    merchantId: string,
  ) {
    let release!: () => void;
    let locked!: (pid: number) => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<number>((resolve) => { locked = resolve; });
    const transaction = db.withTransaction(async (tx) => {
      const backend = await tx.one<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await tx.one("SELECT id FROM seo_merchants WHERE id = $1 FOR UPDATE", [merchantId]);
      locked(backend!.pid);
      await released;
    });
    return { blockerPid: await ready, release, transaction };
  }

  async function waitForBlockedBy(
    db: Awaited<ReturnType<typeof setupContentTask>>["db"],
    blockerPid: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await db.one<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
         ) AS blocked`,
        [blockerPid],
      );
      if (blocked?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Agent Run allocation did not reach the held merchant lock");
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

  it("fails closed when a legacy-bound authorized Task alias references a foreign merchant Run", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "corrupt-alias-scope");
    const { app, db, task } = built;
    const foreignMerchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "corrupt-alias-foreign-store",
        display_name: "Foreign Store",
        idempotency_key: "corrupt-alias-foreign-store",
      },
    })).json();
    const foreignLocation = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${foreignMerchant.id}/locations`,
      payload: {
        slug: "corrupt-alias-foreign-location",
        display_name: "Foreign Location",
        timezone: "America/Chicago",
        readiness_status: "READY",
        external_identities: { google_business: "locations/foreign-secret" },
        missing_requirements: [],
        idempotency_key: "corrupt-alias-foreign-location",
      },
    })).json();
    const key = "corrupt-alias-scope-run";
    const created = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(created.statusCode).toBe(202);

    await db.exec(
      `UPDATE seo_agent_runs
          SET merchant_id = $1, location_id = $2,
              input_message = 'FOREIGN_INPUT_MUST_NOT_LEAK'
        WHERE id = $3`,
      [foreignMerchant.id, foreignLocation.id, created.json().id],
    );
    await db.exec(
      `UPDATE seo_agent_run_requests
          SET merchant_id = $1, semantics_version = 'LEGACY_BOUND'
        WHERE idempotency_key = $2`,
      [foreignMerchant.id, key],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(replay.body).not.toContain("FOREIGN_INPUT_MUST_NOT_LEAK");
    expect(core.triggerCount()).toBe(1);
  });

  it("returns reconciliation-required when an authorized request alias references a missing Run", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "missing-alias-run");
    const { app, db, task } = built;
    const key = "missing-alias-run-key";
    const created = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(created.statusCode).toBe(202);
    await db.exec(`DELETE FROM seo_agent_runs WHERE id = $1`, [created.json().id]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(core.triggerCount()).toBe(1);
  });

  it("fails closed when creation-key compatibility replay finds a wrong-location Run", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "corrupt-creation-fallback");
    const { app, db, task, merchant } = built;
    const key = "corrupt-creation-fallback-run";
    const created = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(created.statusCode).toBe(202);
    const wrongLocation = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "corrupt-creation-fallback-location",
        timezone: "America/Phoenix",
        readiness_status: "READY",
        external_identities: {},
        missing_requirements: [],
        idempotency_key: "corrupt-creation-fallback-location",
      },
    })).json();
    await db.exec(`DELETE FROM seo_agent_run_requests WHERE idempotency_key = $1`, [key]);
    await db.exec(
      `UPDATE seo_agent_runs
          SET location_id = $1, input_message = 'FALLBACK_FOREIGN_INPUT_MUST_NOT_LEAK'
        WHERE id = $2`,
      [wrongLocation.id, created.json().id],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(replay.body).not.toContain("FALLBACK_FOREIGN_INPUT_MUST_NOT_LEAK");
    expect(core.triggerCount()).toBe(1);
  });

  for (const corruption of ["merchant", "location"] as const) {
    it(`rejects an explicit retry whose prior Run has a corrupt ${corruption} scope`, async () => {
      const core = fakeCore({ failTriggerNumbers: [1] });
      const built = await setupContentTask(core.client, `corrupt-retry-${corruption}`);
      const { app, db, task, merchant } = built;
      const first = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: `corrupt-retry-${corruption}-first` },
      });
      expect(first.statusCode).toBe(502);
      const prior = await db.one<{ id: string }>(
        `SELECT id FROM seo_agent_runs WHERE task_id = $1`,
        [task.id],
      );
      expect(prior).not.toBeNull();

      if (corruption === "merchant") {
        const foreignMerchant = (await app.inject({
          method: "POST",
          url: "/api/seo-ops/merchants",
          payload: {
            slug: "corrupt-retry-foreign-merchant",
            idempotency_key: "corrupt-retry-foreign-merchant",
          },
        })).json();
        await db.exec(
          `UPDATE seo_agent_runs SET merchant_id = $1 WHERE id = $2`,
          [foreignMerchant.id, prior!.id],
        );
      } else {
        const wrongLocation = (await app.inject({
          method: "POST",
          url: `/api/seo-ops/merchants/${merchant.id}/locations`,
          payload: {
            slug: "corrupt-retry-wrong-location",
            timezone: "America/Los_Angeles",
            readiness_status: "READY",
            external_identities: {},
            missing_requirements: [],
            idempotency_key: "corrupt-retry-wrong-location",
          },
        })).json();
        await db.exec(
          `UPDATE seo_agent_runs SET location_id = $1 WHERE id = $2`,
          [wrongLocation.id, prior!.id],
        );
      }

      const retry = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: {
          idempotency_key: `corrupt-retry-${corruption}-second`,
          retry: {
            prior_run_id: prior!.id,
            reason: `The ${corruption} boundary must be validated before retry.`,
          },
        },
      });
      expect(retry.statusCode).toBe(409);
      expect(retry.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
      expect(core.triggerCount()).toBe(1);
      expect(await db.one<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
        [task.id],
      )).toEqual({ count: "1" });
    });
  }

  it("fails closed when the latest business generation has a corrupt merchant scope", async () => {
    const core = fakeCore({ failTriggerNumbers: [1] });
    const built = await setupContentTask(core.client, "corrupt-latest-scope");
    const { app, db, task } = built;
    expect((await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "corrupt-latest-first" },
    })).statusCode).toBe(502);
    const foreignMerchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "corrupt-latest-foreign-merchant",
        idempotency_key: "corrupt-latest-foreign-merchant",
      },
    })).json();
    await db.exec(
      `UPDATE seo_agent_runs SET merchant_id = $1 WHERE task_id = $2`,
      [foreignMerchant.id, task.id],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "corrupt-latest-second" },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(core.triggerCount()).toBe(1);
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
      [task.id],
    )).toEqual({ count: "1" });
  });

  it("fails closed when an active generation has a corrupt location scope", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "corrupt-active-scope");
    const { app, db, task, merchant } = built;
    const created = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "corrupt-active-first" },
    });
    expect(created.statusCode).toBe(202);
    const wrongLocation = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "corrupt-active-wrong-location",
        timezone: "America/Denver",
        readiness_status: "READY",
        external_identities: {},
        missing_requirements: [],
        idempotency_key: "corrupt-active-wrong-location",
      },
    })).json();
    await db.exec(
      `UPDATE seo_agent_runs
          SET location_id = $1, input_message = 'ACTIVE_FOREIGN_INPUT_MUST_NOT_LEAK'
        WHERE id = $2`,
      [wrongLocation.id, created.json().id],
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "corrupt-active-second" },
    });
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(replay.body).not.toContain("ACTIVE_FOREIGN_INPUT_MUST_NOT_LEAK");
    expect(core.triggerCount()).toBe(1);
  });

  it("rejects polled output ingestion when the persisted Run no longer matches its Task scope", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "corrupt-ingestion-scope");
    const { app, db, task } = built;
    const created = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "corrupt-ingestion-run" },
    });
    expect(created.statusCode).toBe(202);
    const foreignMerchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "corrupt-ingestion-foreign-merchant",
        idempotency_key: "corrupt-ingestion-foreign-merchant",
      },
    })).json();
    await db.exec(
      `UPDATE seo_agent_runs SET merchant_id = $1 WHERE id = $2`,
      [foreignMerchant.id, created.json().id],
    );

    await new AgentRunPoller({
      db,
      client: core.client,
      artifactsDir: built.artifactsDir,
    }).pollOnce();

    expect(await db.one<{ status: string; error_code: string }>(
      `SELECT status, error_code FROM seo_agent_runs WHERE id = $1`,
      [created.json().id],
    )).toEqual({
      status: "FAILED",
      error_code: "CONTENT_RUN_RECONCILIATION_REQUIRED",
    });
    expect((await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
    })).json().items).toEqual([]);
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

  it("serializes Stage and GBP content allocation through one merchant quota boundary", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "shared-stage-gbp-quota", {
      dailyRunLimit: 1,
      stageAgentId: "agent-stage",
    });
    const { app, db, merchant, task } = built;

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/stage-runs`,
        payload: { stage: "KEYWORDS", idempotency_key: "shared-quota-stage" },
      }),
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: "shared-quota-content" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 429]);
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE merchant_id = $1`,
      [merchant.id],
    )).toEqual({ count: "1" });
    expect(core.triggerCount()).toBe(1);
  });

  it("converges identical concurrent GBP allocation before checking a limit of one", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "same-gbp-quota", { dailyRunLimit: 1 });
    const { app, db, task, merchant } = built;

    const responses = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: "same-gbp-quota-a" },
      }),
      app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: "same-gbp-quota-b" },
      }),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 202]);
    expect(responses[0].json().id).toBe(responses[1].json().id);
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE merchant_id = $1`,
      [merchant.id],
    )).toEqual({ count: "1" });
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_run_requests WHERE merchant_id = $1`,
      [merchant.id],
    )).toEqual({ count: "2" });
    expect(core.triggerCount()).toBe(1);

    const replayIndex = responses.findIndex((response) => response.statusCode === 200);
    const replayKey = replayIndex === 0 ? "same-gbp-quota-a" : "same-gbp-quota-b";
    expect((await db.one<{ creation_idempotency_key: string }>(
      `SELECT creation_idempotency_key FROM seo_agent_runs WHERE merchant_id = $1`,
      [merchant.id],
    ))?.creation_idempotency_key).not.toBe(replayKey);
    const changedReplayRequest = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: replayKey,
        retry: {
          prior_run_id: responses[0].json().id,
          reason: "A business-replay idempotency key cannot later change its HTTP semantics.",
        },
      },
    });
    expect(changedReplayRequest.statusCode).toBe(409);
    expect(changedReplayRequest.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("replays the same HTTP key and body after Gate 1 advances, but conflicts on a changed body", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "stable-http-after-gate");
    const { app, db, task } = built;
    const key = "stable-http-after-gate-run";
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(first.statusCode).toBe(202);
    await new AgentRunPoller({ db, client: core.client, artifactsDir: built.artifactsDir }).pollOnce();
    const draft = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
    })).json().items[0];
    const beforeFinalize = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}`,
    })).json();
    const finalized = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/drafts/${draft.version}/finalize`,
      payload: {
        expected_state_version: beforeFinalize.state_version,
        idempotency_key: "stable-http-after-gate-finalize",
      },
    });
    expect(finalized.statusCode).toBe(201);
    expect(finalized.json().status).toBe("READY_FOR_APPROVAL");
    const approved = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: finalized.json().task_revision,
        execution_spec_hash: finalized.json().execution_spec_hash,
        expected_state_version: finalized.json().state_version,
        idempotency_key: "stable-http-after-gate-approve",
      },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json().status).toBe("APPROVED");

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(core.triggerCount()).toBe(1);

    const changedBody = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: key,
        retry: {
          prior_run_id: first.json().id,
          reason: "The HTTP request body changed after the original completed generation.",
        },
      },
    });
    expect(changedBody.statusCode).toBe(409);
    expect(changedBody.json().error_code).toBe("IDEMPOTENCY_CONFLICT");
    expect(core.triggerCount()).toBe(1);
  });

  it("replays the same HTTP key after style and Task revision changes", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "stable-http-after-mutable-input");
    const { app, task, merchant } = built;
    const key = "stable-http-after-mutable-input-run";
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(first.statusCode).toBe(202);
    expect((await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/style-profile`,
      payload: { voice: { tone: "direct, seasonal, and concise" } },
    })).statusCode).toBe(201);
    const revised = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/draft-revisions`,
      payload: {
        body: "A human revision changes the Task definition while the original request remains stable.",
        source: "HUMAN_EDIT",
        expected_state_version: task.state_version,
        idempotency_key: "stable-http-task-revision",
      },
    });
    expect(revised.statusCode).toBe(201);
    expect(revised.json().task_revision).toBe(task.task_revision + 1);

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(core.triggerCount()).toBe(1);
  });

  it("rebuilds a legacy GBP request alias that the real route can replay", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "legacy-route-replay");
    const { app, db, task } = built;
    const key = "legacy-route-replay-run";
    const first = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(first.statusCode).toBe(202);

    await db.exec(
      `UPDATE seo_agent_runs
          SET http_request_fingerprint = 'sha256:legacy-mutable-request'
        WHERE id = $1`,
      [first.json().id],
    );
    await db.exec(
      `UPDATE seo_agent_run_requests
          SET http_request_fingerprint = 'sha256:legacy-mutable-request'
        WHERE idempotency_key = $1`,
      [key],
    );
    await db.exec(`ALTER TABLE seo_agent_run_requests DROP COLUMN semantics_version`);
    await migrate(db);

    const expected = gbpContentHttpRequestFingerprint(task.id);
    expect(await db.one(
      `SELECT r.http_request_fingerprint, q.http_request_fingerprint AS alias_fingerprint
         FROM seo_agent_runs r
         JOIN seo_agent_run_requests q ON q.run_id = r.id
        WHERE r.id = $1 AND q.idempotency_key = $2`,
      [first.json().id, key],
    )).toEqual({
      http_request_fingerprint: expected,
      alias_fingerprint: expected,
    });

    const replay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: key },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(core.triggerCount()).toBe(1);
  });

  it("preserves a pre-version creation key and two business-convergence aliases across two migrations", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "legacy-multi-alias");
    const { app, db, task } = built;
    const keys = [
      "legacy-multi-alias-creation",
      "legacy-multi-alias-convergence-a",
      "legacy-multi-alias-convergence-b",
    ];
    const responses = [];
    for (const key of keys) {
      responses.push(await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: key },
      }));
    }
    expect(responses.map((response) => response.statusCode)).toEqual([202, 200, 200]);
    const runId = responses[0].json().id;
    expect(responses.map((response) => response.json().id)).toEqual([runId, runId, runId]);

    await db.exec(`ALTER TABLE seo_agent_run_requests DROP COLUMN IF EXISTS semantics_version`);
    await db.exec(
      `UPDATE seo_agent_run_requests
          SET http_request_fingerprint = 'sha256:pre-version:' || idempotency_key
        WHERE run_id = $1`,
      [runId],
    );
    await db.exec(
      `UPDATE seo_agent_runs SET http_request_fingerprint = 'sha256:pre-version-run' WHERE id = $1`,
      [runId],
    );

    await migrate(db);
    await migrate(db);

    expect(await db.query(
      `SELECT idempotency_key, run_id, semantics_version
         FROM seo_agent_run_requests
        WHERE run_id = $1
        ORDER BY idempotency_key`,
      [runId],
    )).toEqual([
      {
        idempotency_key: "legacy-multi-alias-convergence-a",
        run_id: runId,
        semantics_version: "LEGACY_BOUND",
      },
      {
        idempotency_key: "legacy-multi-alias-convergence-b",
        run_id: runId,
        semantics_version: "LEGACY_BOUND",
      },
      {
        idempotency_key: "legacy-multi-alias-creation",
        run_id: runId,
        semantics_version: "STRICT_CURRENT",
      },
    ]);

    for (const key of keys) {
      const replay = await app.inject({
        method: "POST",
        url: `/api/seo-ops/tasks/${task.id}/content-runs`,
        payload: { idempotency_key: key },
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().id).toBe(runId);
    }
    const changedLegacyRequest = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "legacy-multi-alias-convergence-a",
        retry: {
          prior_run_id: "a-different-run-must-never-rebind-this-alias",
          reason: "Legacy-bound request semantics preserve the exact historic Run.",
        },
      },
    });
    expect(changedLegacyRequest.statusCode).toBe(200);
    expect(changedLegacyRequest.json().id).toBe(runId);
    expect(await db.one<{ run_id: string }>(
      `SELECT run_id FROM seo_agent_run_requests WHERE idempotency_key = $1`,
      ["legacy-multi-alias-convergence-a"],
    )).toEqual({ run_id: runId });

    const otherTask = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/tasks",
      payload: {
        merchant_id: built.merchant.id,
        location_id: built.location.id,
        definition: {
          title: "A different Task cannot claim a legacy alias",
          task_type: "GBP_POST",
          source: "CYCLE",
          priority: "HIGH",
          impact: "HIGH",
          execution_spec: JSON.stringify({
            occurrence_at: "2026-08-28T17:00:00.000-04:00",
            post_type: "STANDARD",
            primary_keyword_cluster: {
              cluster_id: "legacy-other-task",
              search_intent: "different Task identity",
              keywords: ["different legacy task"],
            },
            evidence_references: ["artifact:keyword-set-v2"],
          }),
          required_evidence_types: ["CONTENT_DRAFT"],
          execution_mode: "AUTO_WRITE",
        },
        idempotency_key: "legacy-multi-alias-other-task",
      },
    })).json();
    const crossTaskReplay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${otherTask.id}/content-runs`,
      payload: { idempotency_key: "legacy-multi-alias-convergence-a" },
    });
    expect(crossTaskReplay.statusCode).toBe(409);
    expect(crossTaskReplay.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(core.triggerCount()).toBe(1);
  });

  it("rejects draft finalization while allocation owns an active GBP Run, then accepts valid output", async () => {
    let triggerStarted!: () => void;
    let releaseTrigger!: () => void;
    const triggerReady = new Promise<void>((resolve) => { triggerStarted = resolve; });
    const triggerReleased = new Promise<void>((resolve) => { releaseTrigger = resolve; });
    const core = fakeCore({
      onTriggerStarted: triggerStarted,
      waitBeforeTriggerReturn: () => triggerReleased,
    });
    const built = await setupContentTask(core.client, "allocation-wins-finalize");
    const { app, db, task } = built;
    const manualDraft = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
      payload: { body: "Manual draft waiting for finalization.", source: "HUMAN_EDIT" },
    })).json();

    const allocation = app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "allocation-wins-finalize-run" },
    });
    await triggerReady;
    const finalize = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/drafts/${manualDraft.version}/finalize`,
      payload: {
        expected_state_version: task.state_version,
        idempotency_key: "allocation-wins-finalize-evidence",
      },
    });
    expect(finalize.statusCode).toBe(409);
    expect(finalize.json().error_code).toBe("CONTENT_RUN_ACTIVE");

    releaseTrigger();
    const allocated = await allocation;
    expect(allocated.statusCode).toBe(202);
    await new AgentRunPoller({ db, client: core.client, artifactsDir: built.artifactsDir }).pollOnce();
    const completed = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/agent-runs/${allocated.json().id}`,
    })).json();
    expect(completed.status).toBe("COMPLETED");
    expect(completed.error_code).not.toBe("OUTPUT_INVALID");
    expect((await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
    })).json().items).toHaveLength(2);
  });

  it("rejects stale allocation after draft finalization wins the Task lock", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "finalize-wins-allocation");
    const { app, db, task, merchant } = built;
    const manualDraft = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/drafts`,
      payload: { body: "Finalize before allocation can lock the Task.", source: "HUMAN_EDIT" },
    })).json();
    const held = await holdMerchantLock(db, merchant.id);
    const allocation = app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "finalize-wins-allocation-run" },
    });
    await waitForBlockedBy(db, held.blockerPid);
    const finalized = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/drafts/${manualDraft.version}/finalize`,
      payload: {
        expected_state_version: task.state_version,
        idempotency_key: "finalize-wins-allocation-evidence",
      },
    });
    expect(finalized.statusCode).toBe(201);
    expect(finalized.json().status).toBe("READY_FOR_APPROVAL");
    held.release();
    await held.transaction;

    const rejected = await allocation;
    expect(rejected.statusCode).toBe(409);
    expect(core.triggerCount()).toBe(0);
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
      [task.id],
    )).toEqual({ count: "0" });
  });

  it("rejects Gate 1 approval while allocation owns an active GBP Run without invalidating valid output", async () => {
    let triggerStarted!: () => void;
    let releaseTrigger!: () => void;
    const triggerReady = new Promise<void>((resolve) => { triggerStarted = resolve; });
    const triggerReleased = new Promise<void>((resolve) => { releaseTrigger = resolve; });
    const core = fakeCore({
      onTriggerStarted: triggerStarted,
      waitBeforeTriggerReturn: () => triggerReleased,
    });
    const built = await setupContentTask(core.client, "allocation-wins-approval");
    const { app, db, task } = built;
    const allocation = app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "allocation-wins-approval-run" },
    });
    await triggerReady;
    const evidence = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: {
        type: "CONTENT_DRAFT",
        source_ref: "draft:operator-proof",
        captured_at: "2026-08-27T12:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "CONTENT_DRAFT",
        expected_state_version: task.state_version,
        idempotency_key: "allocation-wins-approval-evidence",
      },
    });
    expect(evidence.statusCode).toBe(201);
    expect(evidence.json().status).toBe("READY_FOR_APPROVAL");
    const approval = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: evidence.json().task_revision,
        execution_spec_hash: evidence.json().execution_spec_hash,
        expected_state_version: evidence.json().state_version,
        idempotency_key: "allocation-wins-approval-decision",
      },
    });
    expect(approval.statusCode).toBe(409);
    expect(approval.json().error_code).toBe("CONTENT_RUN_ACTIVE");

    releaseTrigger();
    const allocated = await allocation;
    expect(allocated.statusCode).toBe(202);
    await new AgentRunPoller({ db, client: core.client, artifactsDir: built.artifactsDir }).pollOnce();
    const completed = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/agent-runs/${allocated.json().id}`,
    })).json();
    expect(completed.status).toBe("COMPLETED");
    expect(completed.error_code).not.toBe("OUTPUT_INVALID");
  });

  it("rejects stale allocation after Gate 1 approval wins the Task lock", async () => {
    const core = fakeCore();
    const built = await setupContentTask(core.client, "approval-wins-allocation");
    const { app, db, task, merchant } = built;
    const held = await holdMerchantLock(db, merchant.id);
    const allocation = app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { idempotency_key: "approval-wins-allocation-run" },
    });
    await waitForBlockedBy(db, held.blockerPid);
    const evidence = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/evidence`,
      payload: {
        type: "CONTENT_DRAFT",
        source_ref: "draft:approval-wins-proof",
        captured_at: "2026-08-27T12:00:00.000Z",
        verification_status: "VERIFIED",
        requirement_key: "CONTENT_DRAFT",
        expected_state_version: task.state_version,
        idempotency_key: "approval-wins-allocation-evidence",
      },
    });
    expect(evidence.json().status).toBe("READY_FOR_APPROVAL");
    const approved = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/approval-decisions`,
      payload: {
        decision: "APPROVE",
        task_revision: evidence.json().task_revision,
        execution_spec_hash: evidence.json().execution_spec_hash,
        expected_state_version: evidence.json().state_version,
        idempotency_key: "approval-wins-allocation-decision",
      },
    });
    expect(approved.statusCode).toBe(201);
    expect(approved.json().status).toBe("APPROVED");
    held.release();
    await held.transaction;

    const rejected = await allocation;
    expect(rejected.statusCode).toBe(409);
    expect(core.triggerCount()).toBe(0);
    expect(await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
      [task.id],
    )).toEqual({ count: "0" });
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
      http_request_fingerprint: string; retry_generation: number;
      status: string; error_code: string; retry_of_agent_run_id: string | null;
    }>(`SELECT id, request_fingerprint, http_request_fingerprint,
               business_input_fingerprint, retry_generation, status, error_code,
               retry_of_agent_run_id
          FROM seo_agent_runs WHERE task_id = $1`, [task.id]);
    expect(triggerFailed).toMatchObject({
      status: "FAILED",
      error_code: "TRIGGER_FAILED",
      retry_of_agent_run_id: null,
      retry_generation: 0,
    });
    expect(triggerFailed!.business_input_fingerprint).not.toBe(triggerFailed!.request_fingerprint);
    expect(triggerFailed!.http_request_fingerprint).toEqual(expect.stringMatching(/^sha256:/));

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
      retry_generation: 1,
    });
    expect(triggerRetry.json().request_fingerprint).not.toBe(triggerFailed!.request_fingerprint);

    const sameRetryDifferentKey = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: { ...retryPayload, idempotency_key: "retry-after-trigger-failure-replay" },
    });
    expect(sameRetryDifferentKey.statusCode).toBe(200);
    expect(sameRetryDifferentKey.json().id).toBe(triggerRetry.json().id);

    const samePriorDifferentReason = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-after-trigger-failure-new-reason",
        retry: {
          prior_run_id: triggerFailed!.id,
          reason: "A different operator explanation must not branch the same generation.",
        },
      },
    });
    expect(samePriorDifferentReason.statusCode).toBe(200);
    expect(samePriorDifferentReason.json().id).toBe(triggerRetry.json().id);

    const sameKeyDifferentRequest = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        ...retryPayload,
        retry: {
          ...retryPayload.retry,
          reason: "The same HTTP idempotency key cannot silently change its retry semantics.",
        },
      },
    });
    expect(sameKeyDifferentRequest.statusCode).toBe(409);
    expect(sameKeyDifferentRequest.json().error_code).toBe("IDEMPOTENCY_CONFLICT");

    await db.exec(
      `UPDATE seo_agent_runs SET status = 'FAILED', error_code = 'OUTPUT_INVALID',
              completed_at = '2026-08-27T01:00:00.000Z'
        WHERE id = $1`,
      [triggerRetry.json().id],
    );
    const ancestorBypass = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-ancestor-bypass",
        retry: {
          prior_run_id: triggerFailed!.id,
          reason: "A stale ancestor cannot create a second retry branch.",
        },
      },
    });
    expect(ancestorBypass.statusCode).toBe(409);
    expect(ancestorBypass.json().error_code).toBe("CONTENT_RUN_RETRY_LINEAGE_MISMATCH");

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
    expect(outputRetry.json()).toMatchObject({
      retry_of_agent_run_id: triggerRetry.json().id,
      retry_generation: 2,
    });

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
    expect(cancelledRetry.json()).toMatchObject({
      retry_of_agent_run_id: outputRetry.json().id,
      retry_generation: 3,
    });

    await db.exec(
      `UPDATE seo_agent_runs SET status = 'COMPLETED', error_code = NULL,
              completed_at = '2026-08-27T02:30:00.000Z'
        WHERE id = $1`,
      [cancelledRetry.json().id],
    );
    await addAgentGeneratedDraftFromRun(
      db,
      task.id,
      cancelledRetry.json().id,
      "Completed retry draft.",
      "system:test",
    );
    const completedReplay = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-completed-generation-replay",
        retry: {
          prior_run_id: cancelledRetry.json().id,
          reason: "A completed generation with a persisted draft must remain stable.",
        },
      },
    });
    expect(completedReplay.statusCode).toBe(200);
    expect(completedReplay.json().id).toBe(cancelledRetry.json().id);
    expect(core.triggerCount()).toBe(4);

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

    const interruptedAncestorBypass = await app.inject({
      method: "POST",
      url: `/api/seo-ops/tasks/${task.id}/content-runs`,
      payload: {
        idempotency_key: "retry-interrupted-ancestor-bypass",
        retry: {
          prior_run_id: outputRetry.json().id,
          reason: "A stale ancestor cannot bypass the latest interrupted generation.",
        },
      },
    });
    expect(interruptedAncestorBypass.statusCode).toBe(409);
    expect(interruptedAncestorBypass.json().error_code).toBe("CONTENT_RUN_RECONCILIATION_REQUIRED");
    expect(core.triggerCount()).toBe(4);
    const stored = await db.one<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM seo_agent_runs WHERE task_id = $1`,
      [task.id],
    );
    expect(stored?.count).toBe("4");
  });
});

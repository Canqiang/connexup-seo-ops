import { afterEach, describe, expect, it } from "vitest";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { parsePlannerOutput } from "../src/services/plannerService.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

/**
 * Break caught: binding a Planner must turn a new-merchant event into one
 * Planner Run, then ingest its structured TaskProposal[] as a review batch.
 * Without that bridge the proposal UI can only be filled manually.
 */
describe("Planner Agent bridge", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("plans a newly created merchant and persists the returned proposal graph", async () => {
    let plannerOutput = "";
    let plannerInput = "";
    const coreAi: CoreAiClient = {
      async trigger(_agentId, input) {
        plannerInput = input;
        return { run_id: "core-planner-run-1", status: "RUNNING" };
      },
      async getRun(id): Promise<CoreAgentRunDetail> {
        return {
          id,
          agent_id: "agent-planner",
          status: "COMPLETED",
          output: plannerOutput,
        };
      },
      async cancel() {},
      async downloadArtifact() {
        throw new Error("planner test does not download artifacts");
      },
    };
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: "legacy-stage-agent",
        mockExecution: false,
      },
      deps: { coreAi },
    });
    apps.push(built.app);
    const { app } = built;

    for (const [key, id] of [
      ["PLANNER", "agent-planner"],
      ["QUESTIONNAIRE", "agent-questionnaire"],
      ["KEYWORD_RESEARCH", "agent-keywords"],
    ] as const) {
      const binding = await app.inject({
        method: "PUT",
        url: `/api/seo-ops/agent-bindings/${key}`,
        payload: { agent_id: id, agent_label: key },
      });
      expect(binding.statusCode).toBe(200);
    }

    const merchantResponse = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "new-store",
        display_name: "New Store",
        website: "https://new-store.example",
        idempotency_key: "merchant-new-store",
      },
    });
    expect(merchantResponse.statusCode).toBe(201);
    const merchant = merchantResponse.json();
    expect(merchant).toMatchObject({
      planner_enqueued: true,
    });
    expect(merchant.planner_task_id).toBeTruthy();

    plannerOutput = JSON.stringify({
      schema_version: "seo_ops.task_proposals.v1",
      trigger_key: `merchant_created:${merchant.id}`,
      snapshot_note: "新商户尚未完成接入。",
      items: [
        {
          title: "生成并检查新店问卷",
          task_type: "QUESTIONNAIRE",
          execution_mode: "READ_ONLY",
          depends_on: [],
          priority: "HIGH",
          impact: "HIGH",
          acceptance_criteria: "问卷草稿可由运营预览后发给商户",
          execution_spec: { action: "GENERATE_QUESTIONNAIRE" },
          required_evidence_types: [],
        },
        {
          title: "基于确认事实生成关键词",
          task_type: "KEYWORD_RESEARCH",
          execution_mode: "READ_ONLY",
          depends_on: [1],
          priority: "HIGH",
          impact: "HIGH",
          acceptance_criteria: "产出本地与自然搜索关键词清单",
          execution_spec: { action: "GENERATE_KEYWORDS" },
          required_evidence_types: [],
        },
      ],
    });

    const before = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/inbox?merchant_id=${merchant.id}&limit=50`,
      })
    ).json();
    expect(before.items).toHaveLength(1);
    expect(before.items[0]).toMatchObject({
      task_type: "PLANNER",
      execution_mode: "READ_ONLY",
      status: "DISPATCHING",
    });

    // First tick triggers Core AI; second tick reads the terminal result.
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(plannerInput).trigger.signals).toEqual([
      { website: "https://new-store.example" },
    ]);
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    const after = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/inbox?merchant_id=${merchant.id}&limit=50`,
      })
    ).json();
    expect(after.items[0].status).toBe("DONE");

    const batches = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/proposal-batches?merchant_id=${merchant.id}`,
      })
    ).json();
    expect(batches.items).toHaveLength(1);
    expect(batches.items[0]).toMatchObject({
      origin: "PLANNER",
      planner_run_id: "core-planner-run-1",
      status: "OPEN",
    });
    expect(batches.items[0].proposals).toHaveLength(2);
    expect(batches.items[0].proposals[1]).toMatchObject({
      task_type: "KEYWORD_RESEARCH",
      depends_on: [1],
      status: "PENDING",
    });
  });

  it("routes due cycle signals through one Planner task instead of creating specialist tasks directly", async () => {
    const built = await createAuthenticatedTestApp({
      configOverrides: { mockExecution: true },
    });
    apps.push(built.app);
    const { app } = built;

    // The merchant predates Planner enablement, matching an existing partner store.
    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "existing-store",
          display_name: "Existing Store",
          idempotency_key: "merchant-existing-store",
        },
      })
    ).json();
    const binding = await app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/PLANNER",
      payload: { agent_id: "agent-planner", agent_label: "Planner" },
    });
    expect(binding.statusCode).toBe(200);

    const now = new Date();
    await app.inject({
      method: "PUT",
      url: `/api/seo-ops/merchants/${merchant.id}/cycle-config`,
      payload: {
        snapshot_day: null,
        post_weekday: now.getUTCDay(),
        post_per_week: 1,
        review_window_days: 7,
        audit_interval_days: 30,
        enabled: true,
      },
    });

    const first = (
      await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" })
    ).json();
    expect(first.created).toHaveLength(1);
    expect(first.created[0]).toMatchObject({
      merchant_id: merchant.id,
      task_type: "PLANNER",
    });

    const inbox = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/inbox?merchant_id=${merchant.id}&limit=50`,
      })
    ).json();
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      task_type: "PLANNER",
      status: "DISPATCHING",
    });
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${inbox.items[0].id}`,
      })
    ).json();
    const trigger = JSON.parse(detail.execution_spec);
    expect(trigger.trigger_type).toBe("CYCLE_DUE");
    expect(trigger.signals.map((signal: { task_type: string }) => signal.task_type).sort())
      .toEqual(["AUDIT", "GBP_POST", "KEYWORD_WEEKLY", "REVIEW"]);

    const replay = (
      await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" })
    ).json();
    expect(replay.created).toHaveLength(0);
  });

  it("replans after the merchant submits a questionnaire", async () => {
    const built = await createAuthenticatedTestApp({
      configOverrides: { mockExecution: true },
    });
    apps.push(built.app);
    const { app, rawInject } = built;

    const merchant = (
      await app.inject({
        method: "POST",
        url: "/api/seo-ops/merchants",
        payload: {
          slug: "questionnaire-store",
          display_name: "Questionnaire Store",
          idempotency_key: "merchant-questionnaire-store",
        },
      })
    ).json();
    const questionnaire = (
      await app.inject({
        method: "POST",
        url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
        payload: { idempotency_key: "questionnaire-for-planner" },
      })
    ).json();
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });

    await app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/PLANNER",
      payload: { agent_id: "agent-planner", agent_label: "Planner" },
    });
    const answers = Object.fromEntries(
      questionnaire.questions
        .filter((item: { required: boolean }) => item.required)
        .map((item: { id: string }) => [item.id, "已确认"]),
    );
    const submitted = await rawInject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    expect(submitted.statusCode).toBe(201);

    const inbox = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/inbox?merchant_id=${merchant.id}&limit=50`,
      })
    ).json();
    expect(inbox.items).toHaveLength(1);
    const task = (
      await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${inbox.items[0].id}`,
      })
    ).json();
    expect(task).toMatchObject({ task_type: "PLANNER", status: "DISPATCHING" });
    const trigger = JSON.parse(task.execution_spec);
    expect(trigger).toMatchObject({
      trigger_type: "QUESTIONNAIRE_FILLED",
      trigger_key: `questionnaire_filled:${questionnaire.id}`,
    });
  });
});

describe("Planner Agent output contract", () => {
  it("rejects a proposal without explicit acceptance criteria", () => {
    expect(() => parsePlannerOutput(JSON.stringify({
      schema_version: "seo_ops.task_proposals.v1",
      trigger_key: "merchant_created:merchant-1",
      items: [{
        title: "Generate questionnaire",
        task_type: "QUESTIONNAIRE",
        execution_mode: "READ_ONLY",
        depends_on: [],
        priority: "HIGH",
        impact: "HIGH",
        execution_spec: { action: "GENERATE_QUESTIONNAIRE" },
        required_evidence_types: [],
      }],
    }))).toThrow(/acceptance_criteria/);
  });
});

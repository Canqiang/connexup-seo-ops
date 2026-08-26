import { afterEach, describe, expect, it } from "vitest";
import type { CoreAgentRunDetail, CoreAiClient } from "../src/services/coreAiClient.js";
import { insertSpecialistArtifact } from "../src/repos/specialistArtifactRepo.js";
import { getTask } from "../src/repos/taskRepo.js";
import { parseQuestionnaireOutput } from "../src/services/questionnaireAdapterService.js";
import {
  buildSpecialistRunInput,
  parseEffectReviewOutput,
  parseKeywordOutput,
  parseReportPackageOutput,
  ingestSpecialistRunOutput,
} from "../src/services/specialistAdapterService.js";
import type { ExecutionAttempt } from "../src/repos/executionRepo.js";
import { createAuthenticatedTestApp } from "./helpers/authTest.js";

describe("specialist result adapters", () => {
  const apps: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it("persists a completed QUESTIONNAIRE run as a merchant questionnaire draft", async () => {
    let dispatchedInput = "";
    let merchantId = "";
    const coreAi: CoreAiClient = {
      async trigger(_agentId, input) {
        dispatchedInput = input;
        return { run_id: "core-questionnaire-run-1", status: "RUNNING" };
      },
      async getRun(id): Promise<CoreAgentRunDetail> {
        return {
          id,
          agent_id: "agent-questionnaire",
          status: "COMPLETED",
          output: JSON.stringify({
            schema_version: "seo_ops.questionnaire_draft.v1",
            merchant_id: merchantId,
            base_info: {
              name: "New Store",
              website: "https://new-store.example",
            },
            questions: [
              {
                id: "business-summary",
                question: "请用一句话描述门店主营业务",
                required: true,
              },
              {
                id: "priority-products",
                question: "本季度优先推广哪些产品？",
                hint: "请列出 3–5 项",
                required: false,
              },
              ...Array.from({ length: 6 }, (_, index) => ({
                id: `onboarding-${index + 3}`,
                question: `Onboarding question ${index + 3}?`,
                required: false,
              })),
            ],
          }),
        };
      },
      async cancel() {},
      async downloadArtifact() {
        throw new Error("questionnaire adapter does not download artifacts");
      },
    };
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi },
    });
    apps.push(built.app);
    const { app } = built;

    const merchantResponse = await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "new-store",
        display_name: "New Store",
        idempotency_key: "specialist-new-store",
      },
    });
    expect(merchantResponse.statusCode).toBe(201);
    const merchant = merchantResponse.json();
    merchantId = merchant.id;

    const binding = await app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/QUESTIONNAIRE",
      payload: { agent_id: "agent-questionnaire", agent_label: "Questionnaire specialist" },
    });
    expect(binding.statusCode).toBe(200);

    const batchResponse = await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        trigger_reason: "new merchant onboarding",
        idempotency_key: "specialist-questionnaire-batch",
        items: [{
          title: "Generate onboarding questionnaire",
          task_type: "QUESTIONNAIRE",
          execution_mode: "READ_ONLY",
          depends_on: [],
          priority: "HIGH",
          impact: "HIGH",
          acceptance_criteria: "A reviewable questionnaire draft is persisted in SEO Ops.",
          execution_spec: JSON.stringify({
            action: "GENERATE_QUESTIONNAIRE",
            website: "https://new-store.example",
          }),
          required_evidence_types: [],
        }],
      },
    });
    expect(batchResponse.statusCode).toBe(201);
    const proposal = batchResponse.json().proposals[0];
    expect(proposal.validation_failures).toEqual([]);

    const decision = await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${proposal.id}/decision`,
      payload: { action: "ADOPT" },
    });
    expect(decision.statusCode).toBe(200);
    const taskId = decision.json().task_id as string;

    // The real worker boundary is preserved; only the remote Core AI transport is faked.
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    const dispatched = JSON.parse(dispatchedInput);
    expect(dispatched).toMatchObject({
      schema_version: "seo_ops.questionnaire_request.v1",
      merchant: { id: merchant.id, display_name: "New Store" },
      output_schema_version: "seo_ops.questionnaire_draft.v1",
    });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchant.id}/lifecycle`,
    });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json().questionnaire).toMatchObject({ status: "DRAFT" });

    const task = await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${taskId}`,
    });
    expect(task.json().status).toBe("DONE");
  });

  it("rejects prose, duplicate IDs, and non-string base facts at the Questionnaire boundary", () => {
    expect(() => parseQuestionnaireOutput("```json\n{}\n```")).toThrow(
      "questionnaire output must be strict JSON",
    );

    expect(() => parseQuestionnaireOutput(JSON.stringify({
      schema_version: "seo_ops.questionnaire_draft.v1",
      merchant_id: "merchant-1",
      base_info: { location_count: 2 },
      questions: [{ id: "business", question: "What do you sell?", required: true }],
    }))).toThrow("questionnaire output schema mismatch at base_info.location_count");

    expect(() => parseQuestionnaireOutput(JSON.stringify({
      schema_version: "seo_ops.questionnaire_draft.v1",
      merchant_id: "merchant-1",
      base_info: { name: "Store" },
      questions: [
        { id: "business", question: "What do you sell?", required: true },
        { id: "business", question: "What matters most?", required: false },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `detail-${index + 1}`,
          question: `Detail ${index + 1}?`,
          required: false,
        })),
      ],
    }))).toThrow("duplicate question id: business");
  });

  it("requires 8 to 16 generated questionnaire questions", () => {
    const output = (count: number) => JSON.stringify({
      schema_version: "seo_ops.questionnaire_draft.v1",
      merchant_id: "merchant-1",
      base_info: { name: "Store" },
      questions: Array.from({ length: count }, (_, index) => ({
        id: `question-${index + 1}`,
        question: `Question ${index + 1}?`,
        required: index < 4,
      })),
    });
    expect(() => parseQuestionnaireOutput(output(7))).toThrow(/questions/);
    expect(parseQuestionnaireOutput(output(8)).questions).toHaveLength(8);
    expect(() => parseQuestionnaireOutput(output(17))).toThrow(/questions/);
  });

  it("strictly parses durable Effect Review and frozen Report Package outputs", () => {
    expect(parseEffectReviewOutput(JSON.stringify({
      schema_version: "seo_ops.effect_review.v1",
      merchant_id: "merchant-1",
      title: "30-day effect review",
      summary: "Observed visibility changed after the dated action bundle.",
      baseline: { captured_at: "2026-07-01T00:00:00.000Z" },
      action_bundle: [{ action: "GBP post", occurred_at: "2026-07-10T00:00:00.000Z" }],
      observed_change: { direction: "IMPROVED" },
      confounders: ["Seasonality was not controlled."],
      conclusion_tier: "ASSOCIATIONAL",
      conclusion: "The change is associated with, but not proven caused by, the action bundle.",
      planning_signals: [{ signal: "continue measurement" }],
      limitations: ["No randomized control."],
    }))).toMatchObject({ conclusion_tier: "ASSOCIATIONAL" });

    const report = {
      schema_version: "seo_ops.merchant_report.v1",
      merchant_id: "merchant-1",
      report_version: "2026-08-v1",
      frozen_at: "2026-08-27T00:00:00.000Z",
      title: "Merchant SEO report",
      executive_summary: "Accepted evidence summary.",
      sections: [{
        id: "audit",
        title: "Audit",
        body: "Accepted audit facts.",
        source_artifact_ids: ["artifact-audit"],
      }],
      source_artifact_ids: ["artifact-audit"],
      limitations: [],
    };
    expect(parseReportPackageOutput(JSON.stringify(report))).toMatchObject({
      report_version: "2026-08-v1",
    });
    expect(() => parseReportPackageOutput(JSON.stringify({ ...report, delivery_status: "SENT" })))
      .toThrow(/delivery_status/);
  });

  it("accepts only a US, lineage-labeled keyword v2 artifact", () => {
    const valid = {
      schema_version: "seo_ops.keyword_set.v2",
      merchant_id: "merchant-1",
      market: {
        country_code: "US",
        language: "en-US",
        search_engine: "GOOGLE",
        location_name: "Flushing, Queens, NY",
      },
      generation_method: "UPSTREAM_DETERMINISTIC_ADAPTER",
      title: "US local and organic keyword set",
      summary: "Adapted from the accepted seed and ranking pipeline output.",
      keywords: [{
        keyword: "chinese braised food flushing",
        strategy: "LOCAL",
        intent: "LOCAL",
        priority: "P1",
        rationale: "Confirmed cuisine paired with the accepted location term.",
        source_tags: ["user_input.business_summary", "merchant.location"],
        target_surface_types: ["GBP", "WEBSITE"],
        target_location: "Flushing, Queens, NY",
      }],
      evidence_gaps: [],
    };

    expect(parseKeywordOutput(JSON.stringify(valid))).toMatchObject({
      market: { country_code: "US" },
      generation_method: "UPSTREAM_DETERMINISTIC_ADAPTER",
      keywords: [{ priority: "P1", strategy: "LOCAL" }],
    });
    expect(() => parseKeywordOutput(JSON.stringify({
      ...valid,
      market: { ...valid.market, country_code: "CN" },
    }))).toThrow("keyword output schema mismatch at market.country_code");
  });

  it("keeps an adopted downstream task parked until every upstream task is DONE", async () => {
    const built = await createAuthenticatedTestApp({
      configOverrides: { mockExecution: true },
    });
    apps.push(built.app);
    const { app } = built;

    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "dependency-store",
        display_name: "Dependency Store",
        idempotency_key: "dependency-store-create",
      },
    })).json();

    for (const key of ["QUESTIONNAIRE", "KEYWORD_RESEARCH"]) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/seo-ops/agent-bindings/${key}`,
        payload: { agent_id: `agent-${key.toLowerCase()}` },
      });
      expect(response.statusCode).toBe(200);
    }

    const batch = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "dependency-batch",
        items: [
          {
            title: "Generate questionnaire",
            task_type: "QUESTIONNAIRE",
            execution_mode: "READ_ONLY",
            depends_on: [],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "Questionnaire task completes.",
            execution_spec: JSON.stringify({ action: "GENERATE_QUESTIONNAIRE" }),
            required_evidence_types: [],
          },
          {
            title: "Generate confirmed keyword set",
            task_type: "KEYWORD_RESEARCH",
            execution_mode: "READ_ONLY",
            depends_on: [1],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "Keyword task starts only after questionnaire completion.",
            execution_spec: JSON.stringify({ action: "GENERATE_KEYWORDS" }),
            required_evidence_types: [],
          },
        ],
      },
    })).json();

    const upstreamDecision = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${batch.proposals[0].id}/decision`,
      payload: { action: "ADOPT" },
    })).json();
    const downstreamDecision = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/proposals/${batch.proposals[1].id}/decision`,
      payload: { action: "ADOPT" },
    })).json();

    const parked = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${downstreamDecision.task_id}`,
    })).json();
    expect(parked).toMatchObject({
      status: "APPROVED",
      attempt_count: 0,
      depends_on_task_ids: [upstreamDecision.task_id],
    });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    const upstream = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${upstreamDecision.task_id}`,
    })).json();
    expect(upstream.status).toBe("DONE");

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" });
    const released = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${downstreamDecision.task_id}`,
    })).json();
    expect(released).toMatchObject({ status: "DISPATCHING", attempt_count: 1 });
  });

  it("dispatches REVIEW and REPORT_PACKAGE through distinct durable artifact contracts", async () => {
    let merchantId = "";
    const dispatchedInputs = new Map<string, string>();
    const coreAi: CoreAiClient = {
      async trigger(agentId, input) {
        dispatchedInputs.set(agentId, input);
        return {
          run_id: agentId === "agent-review" ? "core-review-run-1" : "core-package-run-1",
          status: "RUNNING",
        };
      },
      async getRun(id): Promise<CoreAgentRunDetail> {
        if (id === "core-review-run-1") {
          return {
            id,
            agent_id: "agent-review",
            status: "COMPLETED",
            output: JSON.stringify({
              schema_version: "seo_ops.effect_review.v1",
              merchant_id: merchantId,
              title: "30-day effect review",
              summary: "Observed visibility changed after the accepted actions.",
              baseline: { captured_at: "2026-07-01T00:00:00.000Z" },
              action_bundle: [{
                action_id: "gbp-post-2026-07-10",
                action_type: "GBP_POST",
                executed_at: "2026-07-10T17:00:00.000Z",
                evidence_ref: "provider:gbp-post-1",
              }],
              observed_change: { direction: "IMPROVED" },
              confounders: ["Seasonality was not controlled."],
              conclusion_tier: "ASSOCIATIONAL",
              conclusion: "The observed change is associated with the dated action bundle.",
              planning_signals: [{ signal: "continue measurement" }],
              limitations: ["No causal experiment."],
            }),
          };
        }
        return {
          id,
          agent_id: "agent-package",
          status: "COMPLETED",
          output: JSON.stringify({
            schema_version: "seo_ops.merchant_report.v1",
            merchant_id: merchantId,
            report_version: "2026-08-v1",
            frozen_at: "2026-08-27T00:00:00.000Z",
            title: "August merchant SEO report",
            executive_summary: "Accepted audit and review evidence only.",
            sections: [{
              id: "audit",
              title: "Audit",
              body: "Accepted audit facts.",
              source_artifact_ids: ["accepted-audit"],
            }],
            source_artifact_ids: ["accepted-audit"],
            limitations: [],
          }),
        };
      },
      async cancel() {},
      async downloadArtifact() { throw new Error("no specialist attachments"); },
    };
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi },
    });
    apps.push(built.app);
    const { app, db } = built;
    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "review-store", display_name: "Review Store", idempotency_key: "review-store" },
    })).json();
    merchantId = merchant.id;
    const questionnaire = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
      payload: { idempotency_key: "review-questionnaire" },
    })).json();
    await app.inject({ method: "POST", url: `/api/seo-ops/questionnaires/${questionnaire.id}/send` });
    await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: {
        answers: Object.fromEntries(
          questionnaire.questions.map((question: { id: string }) => [question.id, "Confirmed"]),
        ),
      },
    });
    for (const [taskType, agentId] of [["REVIEW", "agent-review"], ["REPORT_PACKAGE", "agent-package"]] as const) {
      expect((await app.inject({
        method: "PUT",
        url: `/api/seo-ops/agent-bindings/${taskType}`,
        payload: { agent_id: agentId, agent_label: taskType },
      })).statusCode).toBe(200);
    }
    const effectEvidencePacket = {
      baseline: {
        captured_at: "2026-07-01T00:00:00.000Z",
        summary: "Mineola local visibility baseline before accepted work.",
      },
      executed_actions: [{
        action_id: "gbp-post-2026-07-10",
        action_type: "GBP_POST",
        executed_at: "2026-07-10T17:00:00.000Z",
        evidence_ref: "provider:gbp-post-1",
      }],
      pre_measurements: {
        window_start: "2026-07-01T00:00:00.000Z",
        window_end: "2026-07-07T23:59:59.000Z",
        measurements: [{
          metric: "local_rank",
          value: 18,
          observed_at: "2026-07-05T12:00:00.000Z",
          source_ref: "ranking:pre-1",
        }],
      },
      post_measurements: {
        window_start: "2026-07-20T00:00:00.000Z",
        window_end: "2026-07-26T23:59:59.000Z",
        measurements: [{
          metric: "local_rank",
          value: 12,
          observed_at: "2026-07-24T12:00:00.000Z",
          source_ref: "ranking:post-1",
        }],
      },
      confounders: ["Seasonality was not controlled."],
      limitations: ["No randomized control."],
    };
    const batch = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "review-package-batch",
        items: [
          {
            title: "Review observed effects",
            task_type: "REVIEW",
            execution_mode: "READ_ONLY",
            depends_on: [],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "An association-capped review artifact is persisted.",
            execution_spec: JSON.stringify(effectEvidencePacket),
            required_evidence_types: [],
          },
          {
            title: "Package accepted report",
            task_type: "REPORT_PACKAGE",
            execution_mode: "READ_ONLY",
            depends_on: [],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "A frozen merchant report artifact is persisted.",
            execution_spec: JSON.stringify({
              report_version: "2026-08-v1",
              frozen_at: "2026-08-27T00:00:00.000Z",
              source_artifact_ids: ["accepted-audit"],
            }),
            required_evidence_types: [],
          },
        ],
      },
    })).json();
    const taskIds: string[] = [];
    for (const proposal of batch.proposals) {
      taskIds.push((await app.inject({
        method: "POST",
        url: `/api/seo-ops/proposals/${proposal.id}/decision`,
        payload: { action: "ADOPT" },
      })).json().task_id);
    }
    await insertSpecialistArtifact(db, {
      id: "accepted-audit",
      taskId: taskIds[1]!,
      merchantId,
      artifactType: "AUDIT_REPORT",
      schemaVersion: "seo_ops.audit_report.v1",
      title: "Accepted audit",
      summary: "Accepted audit facts.",
      payload: { accepted: true },
      coreRunId: "accepted-audit-run",
      createdBy: "test",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    await insertSpecialistArtifact(db, {
      id: "newer-audit-not-frozen",
      taskId: taskIds[1]!,
      merchantId,
      artifactType: "AUDIT_REPORT",
      schemaVersion: "seo_ops.audit_report.v1",
      title: "Newer audit",
      summary: "This later artifact is outside the frozen report snapshot.",
      payload: { accepted: true, newer: true },
      coreRunId: "newer-audit-run",
      createdBy: "test",
      createdAt: "2026-08-27T01:00:00.000Z",
    });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(dispatchedInputs.get("agent-review") ?? "null")).toMatchObject({
      output_schema_version: "seo_ops.effect_review.v1",
    });
    expect(JSON.parse(dispatchedInputs.get("agent-package") ?? "null")).toMatchObject({
      output_schema_version: "seo_ops.merchant_report.v1",
      execution_spec: {
        report_version: "2026-08-v1",
        frozen_at: "2026-08-27T00:00:00.000Z",
        source_artifact_ids: ["accepted-audit"],
      },
      upstream_artifacts: [expect.objectContaining({ artifact_id: "accepted-audit" })],
    });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    expect((await app.inject({ method: "GET", url: `/api/seo-ops/tasks/${taskIds[0]}/artifacts` }))
      .json().items).toEqual([expect.objectContaining({ artifact_type: "EFFECT_REVIEW" })]);
    const packaged = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${taskIds[1]}/artifacts`,
    })).json().items;
    expect(packaged).toEqual(expect.arrayContaining([expect.objectContaining({
      artifact_type: "MERCHANT_REPORT",
      schema_version: "seo_ops.merchant_report.v1",
      summary: "Accepted audit and review evidence only.",
    })]));
    expect(packaged.find((item: { artifact_type: string }) => item.artifact_type === "MERCHANT_REPORT").payload)
      .toMatchObject({
      report_version: "2026-08-v1",
      frozen_at: "2026-08-27T00:00:00.000Z",
    });
    const reportTask = await getTask(db, taskIds[1]!);
    expect(reportTask).not.toBeNull();
    const attempt = {
      attemptNo: 1,
      probeRef: `exec-${reportTask!.id}-rev1-attempt1`,
    } as ExecutionAttempt;
    const firstFrozenInput = JSON.parse(await buildSpecialistRunInput(db, reportTask!, attempt));
    await insertSpecialistArtifact(db, {
      id: "late-ranking-not-frozen",
      taskId: reportTask!.id,
      merchantId,
      artifactType: "RANKING_SNAPSHOT",
      schemaVersion: "seo_ops.ranking_report.v1",
      title: "Late ranking snapshot",
      summary: "Created after the report snapshot was frozen.",
      payload: { captured_at: "2026-08-27T02:00:00.000Z" },
      coreRunId: "late-ranking-run",
      createdBy: "test",
      createdAt: "2026-08-27T02:00:00.000Z",
    });
    const replayedFrozenInput = JSON.parse(await buildSpecialistRunInput(db, reportTask!, attempt));
    expect(replayedFrozenInput.upstream_artifacts).toEqual(firstFrozenInput.upstream_artifacts);
    expect(replayedFrozenInput.upstream_artifacts.map((item: { artifact_id: string }) => item.artifact_id))
      .toEqual(["accepted-audit"]);

    await expect(ingestSpecialistRunOutput(
      db,
      reportTask!,
      "core-package-run-wrong-freeze",
      JSON.stringify({
        ...packaged.find((item: { artifact_type: string }) => item.artifact_type === "MERCHANT_REPORT").payload,
        frozen_at: "2026-08-28T00:00:00.000Z",
      }),
    )).rejects.toThrow("frozen_at does not match execution_spec");

    const reportPayload = packaged.find(
      (item: { artifact_type: string }) => item.artifact_type === "MERCHANT_REPORT",
    ).payload;
    await expect(ingestSpecialistRunOutput(
      db,
      reportTask!,
      "core-package-run-forged-lineage",
      JSON.stringify({
        ...reportPayload,
        sections: [{
          ...reportPayload.sections[0],
          source_artifact_ids: ["forged-artifact"],
        }],
        source_artifact_ids: ["accepted-audit", "forged-artifact"],
      }),
    )).rejects.toThrow(/source_artifact_ids/);

    const reviewTask = await getTask(db, taskIds[0]!);
    expect(reviewTask).not.toBeNull();
    const effectArtifact = (await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${taskIds[0]}/artifacts`,
    })).json().items.find((item: { artifact_type: string }) => item.artifact_type === "EFFECT_REVIEW");
    await expect(ingestSpecialistRunOutput(
      db,
      reviewTask!,
      "core-review-run-forged-action",
      JSON.stringify({
        ...effectArtifact.payload,
        action_bundle: [{
          action_id: "gbp-post-2026-07-10",
          action_type: "GBP_POST",
          executed_at: "2026-07-10T17:00:00.000Z",
          evidence_ref: "provider:forged",
        }],
      }),
    )).rejects.toThrow(/action_bundle/);
    await expect(buildSpecialistRunInput(db, {
      ...reviewTask!,
      executionSpec: JSON.stringify({ review_window: "2026-07" }),
    }, attempt)).rejects.toThrow(/effect review evidence packet/);

    const foreignMerchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: { slug: "foreign-review-store", idempotency_key: "foreign-review-store" },
    })).json();
    await insertSpecialistArtifact(db, {
      id: "foreign-audit",
      taskId: reportTask!.id,
      merchantId: foreignMerchant.id,
      artifactType: "AUDIT_REPORT",
      schemaVersion: "seo_ops.audit_report.v1",
      title: "Foreign audit",
      summary: "Must never cross tenant boundaries.",
      payload: { accepted: true },
      coreRunId: "foreign-audit-run",
      createdBy: "test",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    await insertSpecialistArtifact(db, {
      id: "internal-plan",
      taskId: reportTask!.id,
      merchantId,
      artifactType: "EXECUTION_PLAN",
      schemaVersion: "seo_ops.execution_plan.v1",
      title: "Internal execution plan",
      summary: "Internal work product.",
      payload: { internal: true },
      coreRunId: "internal-plan-run",
      createdBy: "test",
      createdAt: "2026-08-26T00:00:00.000Z",
    });
    const withSourceIds = (sourceArtifactIds: string[]) => ({
      ...reportTask!,
      executionSpec: JSON.stringify({
        report_version: "2026-08-v1",
        frozen_at: "2026-08-27T00:00:00.000Z",
        source_artifact_ids: sourceArtifactIds,
      }),
    });
    for (const [sourceIds, expectedError] of [
      [["missing-artifact"], /missing source artifact/],
      [["accepted-audit", "accepted-audit"], /duplicate source_artifact_ids/],
      [["foreign-audit"], /same merchant/],
      [["internal-plan"], /not merchant-safe/],
    ] as const) {
      await expect(buildSpecialistRunInput(
        db,
        withSourceIds([...sourceIds]),
        attempt,
      )).rejects.toThrow(expectedError);
    }
  });

  it("persists Keyword, Audit, Ranking, and Plan artifacts in dependency order with upstream context", async () => {
    let merchantId = "";
    const dispatchedInputs = new Map<string, string>();
    const coreAi: CoreAiClient = {
      async trigger(agentId, input) {
        dispatchedInputs.set(agentId, input);
        const runIds: Record<string, string> = {
          "agent-keyword": "core-keyword-run-1",
          "agent-audit": "core-audit-run-1",
          "agent-report": "core-report-run-1",
          "agent-plan": "core-plan-run-1",
        };
        return { run_id: runIds[agentId] ?? `unexpected-${agentId}`, status: "RUNNING" };
      },
      async getRun(id): Promise<CoreAgentRunDetail> {
        if (id === "core-audit-run-1") {
          return {
            id,
            agent_id: "agent-audit",
            status: "COMPLETED",
            output: JSON.stringify({
              schema_version: "seo_ops.audit_report.v1",
              merchant_id: merchantId,
              title: "Evidence-bounded local SEO audit",
              summary: "Audit findings based on supplied public and confirmed evidence.",
              evidence_mode: "PUBLIC_AND_CONFIRMED",
              findings: [{
                id: "website-local-signal",
                area: "WEBSITE",
                severity: "HIGH",
                observation: "The supplied website needs a location-specific service page.",
                evidence: ["Confirmed Mineola service area", "Supplied website URL"],
                recommendation: "Create a Mineola landing page tied to confirmed services.",
              }],
              limitations: ["GBP and Search Console are not connected."],
              next_actions: ["Create the location page before remeasurement."],
            }),
          };
        }
        if (id === "core-plan-run-1") {
          return {
            id,
            agent_id: "agent-plan",
            status: "COMPLETED",
            output: JSON.stringify({
              schema_version: "seo_ops.execution_plan.v1",
              merchant_id: merchantId,
              title: "30-day local SEO execution plan",
              summary: "Prioritized work derived from confirmed facts and audit findings.",
              horizon_days: 30,
              objectives: ["Improve Mineola relevance"],
              work_items: [{
                id: "mineola-location-page",
                title: "Draft Mineola location page",
                task_type: "WEBSITE_CONTENT",
                execution_mode: "ARTIFACT",
                priority: "HIGH",
                depends_on: [],
                rationale: "Addresses the highest-severity audit finding.",
                acceptance_criteria: "A reviewable location-page draft is available.",
              }],
              review_cadence: "Review evidence and rankings weekly.",
              assumptions: ["Merchant facts remain current."],
            }),
          };
        }
        if (id === "core-report-run-1") {
          return {
            id,
            agent_id: "agent-report",
            status: "COMPLETED",
            output: JSON.stringify({
              schema_version: "seo_ops.ranking_report.v1",
              merchant_id: merchantId,
              title: "Initial local and organic ranking baseline",
              summary: "A baseline with explicit unavailable measurements.",
              captured_at: "2026-08-26T10:00:00.000Z",
              source_mode: "CONFIRMED_FACTS_ONLY",
              keywords: [{
                keyword: "family lunch mineola",
                local_rank: null,
                organic_rank: null,
                source: "UNAVAILABLE",
                note: "Live rank source was not connected.",
              }],
              limitations: ["Local grid and organic rank sources are not connected."],
            }),
          };
        }
        return {
          id,
          agent_id: "agent-keyword",
          status: "COMPLETED",
          output: JSON.stringify({
            schema_version: "seo_ops.keyword_set.v2",
            merchant_id: merchantId,
            market: {
              country_code: "US",
              language: "en-US",
              search_engine: "GOOGLE",
              location_name: "Mineola, NY",
            },
            generation_method: "EVIDENCE_BOUNDED_RESEARCH",
            title: "Confirmed local keyword set",
            summary: "Keywords derived from merchant-confirmed services and location facts.",
            keywords: [
              {
                keyword: "family lunch mineola",
                strategy: "LOCAL",
                intent: "LOCAL",
                priority: "UNSCORED",
                rationale: "Matches the confirmed location and lunch service.",
                source_tags: ["questionnaire", "merchant.location"],
                target_surface_types: ["GBP"],
              },
              {
                keyword: "restaurant catering mineola",
                strategy: "ORGANIC",
                intent: "ORGANIC",
                priority: "UNSCORED",
                rationale: "Covers the confirmed catering offer.",
                source_tags: ["questionnaire", "merchant.location"],
                target_surface_types: ["WEBSITE"],
              },
            ],
            evidence_gaps: ["Search volume and live SERP positions are not connected."],
          }),
        };
      },
      async cancel() {},
      async downloadArtifact() {
        throw new Error("structured adapters do not download attachments");
      },
    };
    const built = await createAuthenticatedTestApp({
      configOverrides: {
        coreAiBaseUrl: "https://core-ai.example",
        coreAiToken: "test-token",
        agentRunAgentId: null,
        mockExecution: false,
      },
      deps: { coreAi },
    });
    apps.push(built.app);
    const { app } = built;

    const merchant = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/merchants",
      payload: {
        slug: "keyword-store",
        display_name: "Keyword Store",
        idempotency_key: "keyword-store-create",
      },
    })).json();
    merchantId = merchant.id;

    const questionnaire = (await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/questionnaires`,
      payload: {
        website: "https://keyword-store.example",
        idempotency_key: "keyword-store-questionnaire",
      },
    })).json();
    const location = await app.inject({
      method: "POST",
      url: `/api/seo-ops/merchants/${merchant.id}/locations`,
      payload: {
        slug: "mineola",
        display_name: "Mineola, NY",
        timezone: "America/New_York",
        external_identities: { google_business: "place-mineola-123" },
        readiness_status: "READY",
        missing_requirements: [],
        idempotency_key: "keyword-store-location",
      },
    });
    expect(location.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: `/api/seo-ops/questionnaires/${questionnaire.id}/send`,
    });
    const form = (await app.inject({
      method: "GET",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}`,
    })).json();
    const answers = Object.fromEntries(
      form.questions.map((question: { id: string }) => [question.id, "Confirmed merchant answer"]),
    );
    const submitted = await app.inject({
      method: "POST",
      url: `/api/public/questionnaire-forms/${questionnaire.share_slug}/submissions`,
      payload: { answers },
    });
    expect(submitted.statusCode).toBe(201);

    for (const [taskType, agentId, agentLabel] of [
      ["KEYWORD_RESEARCH", "agent-keyword", "Keyword specialist"],
      ["AUDIT", "agent-audit", "Audit specialist"],
      ["REPORT", "agent-report", "Ranking report specialist"],
      ["PLAN", "agent-plan", "Plan specialist"],
    ] as const) {
      const binding = await app.inject({
        method: "PUT",
        url: `/api/seo-ops/agent-bindings/${taskType}`,
        payload: { agent_id: agentId, agent_label: agentLabel },
      });
      expect(binding.statusCode).toBe(200);
    }

    const batch = (await app.inject({
      method: "POST",
      url: "/api/seo-ops/proposal-batches",
      payload: {
        merchant_id: merchant.id,
        origin: "MANUAL",
        idempotency_key: "keyword-store-batch",
        items: [
          {
            title: "Generate confirmed keyword set",
            task_type: "KEYWORD_RESEARCH",
            execution_mode: "READ_ONLY",
            depends_on: [],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "A strict keyword artifact is persisted from confirmed facts.",
            execution_spec: JSON.stringify({ action: "GENERATE_KEYWORDS" }),
            required_evidence_types: [],
          },
          {
            title: "Audit confirmed local SEO scope",
            task_type: "AUDIT",
            execution_mode: "READ_ONLY",
            depends_on: [1],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "An evidence-bounded audit artifact is persisted.",
            execution_spec: JSON.stringify({ action: "RUN_LOCAL_SEO_AUDIT" }),
            required_evidence_types: [],
          },
          {
            title: "Capture ranking baseline",
            task_type: "REPORT",
            execution_mode: "READ_ONLY",
            depends_on: [2],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "A source-labeled ranking baseline is persisted.",
            execution_spec: JSON.stringify({ action: "CAPTURE_RANKING_BASELINE" }),
            required_evidence_types: [],
          },
          {
            title: "Generate 30-day execution plan",
            task_type: "PLAN",
            execution_mode: "READ_ONLY",
            depends_on: [2, 3],
            priority: "HIGH",
            impact: "HIGH",
            acceptance_criteria: "A dependency-aware plan artifact is persisted.",
            execution_spec: JSON.stringify({ action: "GENERATE_EXECUTION_PLAN", horizon_days: 30 }),
            required_evidence_types: [],
          },
        ],
      },
    })).json();
    const decisions = [];
    for (const proposal of batch.proposals) {
      decisions.push((await app.inject({
        method: "POST",
        url: `/api/seo-ops/proposals/${proposal.id}/decision`,
        payload: { action: "ADOPT" },
      })).json());
    }

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(dispatchedInputs.get("agent-keyword") ?? "null")).toMatchObject({
      schema_version: "seo_ops.keyword_request.v2",
      market: { country_code: "US", language: "en-US", search_engine: "GOOGLE" },
      merchant: {
        id: merchant.id,
        display_name: "Keyword Store",
        locations: [{
          display_name: "Mineola, NY",
          timezone: "America/New_York",
          external_identities: { google_business: "place-mineola-123" },
        }],
      },
      questionnaire: { status: "FILLED" },
      output_schema_version: "seo_ops.keyword_set.v2",
    });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(dispatchedInputs.get("agent-audit") ?? "null")).toMatchObject({
      schema_version: "seo_ops.audit_request.v1",
      output_schema_version: "seo_ops.audit_report.v1",
      upstream_artifacts: [expect.objectContaining({ artifact_type: "KEYWORD_SET" })],
    });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(dispatchedInputs.get("agent-report") ?? "null")).toMatchObject({
      schema_version: "seo_ops.ranking_request.v1",
      output_schema_version: "seo_ops.ranking_report.v1",
      upstream_artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact_type: "KEYWORD_SET" }),
        expect.objectContaining({ artifact_type: "AUDIT_REPORT" }),
      ]),
    });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    await app.inject({ method: "POST", url: "/api/seo-ops/admin/scheduler-tick" });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });
    expect(JSON.parse(dispatchedInputs.get("agent-plan") ?? "null")).toMatchObject({
      schema_version: "seo_ops.plan_request.v1",
      output_schema_version: "seo_ops.execution_plan.v1",
      upstream_artifacts: expect.arrayContaining([
        expect.objectContaining({ artifact_type: "KEYWORD_SET" }),
        expect.objectContaining({ artifact_type: "AUDIT_REPORT" }),
        expect.objectContaining({ artifact_type: "RANKING_SNAPSHOT" }),
      ]),
    });
    await app.inject({ method: "POST", url: "/api/seo-ops/admin/execution-tick" });

    const keywordArtifacts = await app.inject({
      method: "GET",
      url: `/api/seo-ops/tasks/${decisions[0].task_id}/artifacts`,
    });
    expect(keywordArtifacts.statusCode).toBe(200);
    expect(keywordArtifacts.json().items).toEqual([
      expect.objectContaining({
        task_id: decisions[0].task_id,
        merchant_id: merchant.id,
        artifact_type: "KEYWORD_SET",
        schema_version: "seo_ops.keyword_set.v2",
        title: "Confirmed local keyword set",
        summary: "Keywords derived from merchant-confirmed services and location facts.",
        core_run_id: "core-keyword-run-1",
      }),
    ]);
    expect(keywordArtifacts.json().items[0].payload.keywords).toHaveLength(2);

    const merchantArtifacts = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchant.id}/artifacts`,
    });
    expect(merchantArtifacts.statusCode).toBe(200);
    expect(merchantArtifacts.json().items.map((item: { artifact_type: string }) => item.artifact_type))
      .toEqual(["EXECUTION_PLAN", "RANKING_SNAPSHOT", "AUDIT_REPORT", "KEYWORD_SET"]);

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/seo-ops/merchants/${merchant.id}/lifecycle`,
    });
    expect(lifecycle.statusCode).toBe(200);
    expect(lifecycle.json()).toMatchObject({
      stage: "PLAN",
      ranking_round_count: 1,
      latest_runs: {
        KEYWORDS: { run_type: "KEYWORD_RESEARCH", deliverable_count: 1 },
        AUDIT: { run_type: "AUDIT", deliverable_count: 1 },
        RANKING_BASELINE: { run_type: "REPORT", deliverable_count: 1 },
        PLAN: { run_type: "PLAN", deliverable_count: 1 },
      },
    });

    for (const decision of decisions) {
      const task = (await app.inject({
        method: "GET",
        url: `/api/seo-ops/tasks/${decision.task_id}`,
      })).json();
      expect(task.status).toBe("DONE");
    }
  });
});

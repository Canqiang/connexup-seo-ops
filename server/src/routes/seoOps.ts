import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fsPromises from "node:fs/promises";
import type { AppContext } from "../index.js";
import { ApiError } from "../errors.js";
import {
  requireDeliverableAccess,
  requireLocationAccess,
  requireMerchantAccess,
  requirePermission,
  requireRunAccess,
  requireTaskAccess,
} from "../auth/httpAuth.js";
import {
  createLocation,
  createMerchant,
} from "../services/merchantService.js";
import {
  createQuestionnaire,
  getQuestionnaire,
  sendQuestionnaire,
  submitQuestionnaire,
} from "../services/questionnaireService.js";
import { deriveLifecycleForDb } from "../services/lifecycleService.js";
import {
  deriveRankingOverview,
  loadRankingSnapshots,
} from "../services/rankingService.js";
import {
  appendEvidence,
  approvalDecision,
  approvalPreview,
  createRevision,
  createTask,
  linkConversation,
} from "../services/taskService.js";
import {
  inbox,
  parsePageParams,
  portfolio,
  reports,
  reviews,
  taskEvents,
} from "../services/queryService.js";
import {
  addManualDeliverable,
  cancelStageRun,
  deliverableView,
  listStageRuns,
  stageRunView,
  triggerStageRun,
  type AgentRunDeps,
} from "../services/agentRunService.js";
import {
  listDeliverablesByRun,
  listDeliverablesByRunIds,
} from "../repos/agentRunRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getQuestionnaireByShareSlug } from "../repos/questionnaireRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { locationView, merchantView, taskView, questionnaireView } from "../views/mappers.js";
import {
  AGENT_RUN_STAGES,
  EVIDENCE_VERIFICATIONS,
  LOCATION_READINESSES,
} from "../domain/enums.js";

const createMerchantSchema = z.object({
  slug: z.string(),
  display_name: z.string().optional().nullable(),
  tags: z.array(z.string()).optional().nullable(),
  operator_user_ids: z.array(z.string()).optional().nullable(),
  idempotency_key: z.string(),
});

const createLocationSchema = z.object({
  slug: z.string(),
  display_name: z.string().optional().nullable(),
  timezone: z.string().optional().nullable(),
  external_identities: z.record(z.string()).optional().nullable(),
  readiness_status: z.enum(LOCATION_READINESSES),
  missing_requirements: z.array(z.string()).optional().nullable(),
  idempotency_key: z.string(),
});

const definitionSchema = z.object({
  title: z.string(),
  task_type: z.string(),
  source: z.string(),
  priority: z.string(),
  impact: z.string(),
  owner_id: z.string().optional(),
  due_at: z.string().optional(),
  execution_spec: z.string(),
  required_evidence_types: z.array(z.string()),
  conversation_id: z.string().optional(),
});

const createTaskSchema = z.object({
  merchant_id: z.string(),
  location_id: z.string().optional(),
  definition: definitionSchema,
  idempotency_key: z.string(),
});

const createRevisionSchema = z.object({
  definition: definitionSchema,
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const appendEvidenceSchema = z.object({
  type: z.string(),
  artifact_id: z.string().optional(),
  file_id: z.string().optional(),
  source_ref: z.string().optional(),
  sha256: z.string().optional(),
  captured_at: z.string(),
  verification_status: z.enum(EVIDENCE_VERIFICATIONS),
  requirement_key: z.string(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const approvalPreviewSchema = z.object({
  task_revision: z.number().int().nonnegative(),
  expected_state_version: z.number().int().nonnegative(),
});

const approvalDecisionSchema = z.object({
  decision: z.string(),
  reason: z.string().optional(),
  task_revision: z.number().int().nonnegative(),
  execution_spec_hash: z.string(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const linkConversationSchema = z.object({
  conversation_id: z.string(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const triggerStageRunSchema = z.object({
  stage: z.enum(AGENT_RUN_STAGES),
  location_id: z.string().optional().nullable(),
  goal: z.string().max(2000).optional().nullable(),
  idempotency_key: z.string(),
});

const manualDeliverableSchema = z.object({
  file_name: z.string().min(1).max(200),
  content_type: z.string().max(100).optional().nullable(),
  content_base64: z.string().min(1),
});

const createQuestionnaireSchema = z.object({
  website: z.string().max(500).optional().nullable(),
  idempotency_key: z.string(),
});

const submitQuestionnaireSchema = z.object({
  answers: z.record(z.string()),
});

/** ASCII-only fallback filename for the Content-Disposition header
 * (non-ASCII names would need RFC 5987 encoding; keep it simple). */
function attachmentFileNameForHeader(fileName: string): string {
  const safe = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return safe === "" ? "attachment" : safe;
}

/** Resolve the merchant/location names a task wire view needs. */
async function taskNames(ctx: AppContext, task: Task): Promise<{
  merchantName: string;
  locationName?: string;
}> {
  const merchant = await getMerchant(ctx.db, task.merchantId);
  const location = task.locationId ? await getLocation(ctx.db, task.locationId) : null;
  return {
    merchantName: merchant?.displayName ?? task.merchantId,
    ...(location ? { locationName: location.displayName } : {}),
  };
}

async function getQuestionnaireByShareSlugOr404(
  ctx: AppContext,
  slug: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getQuestionnaireByShareSlug>>>> {
  const questionnaire = await getQuestionnaireByShareSlug(ctx.db, slug);
  if (!questionnaire) {
    throw new ApiError(404, `questionnaire form ${slug} not found`, undefined);
  }
  return questionnaire;
}

/** Register all /api/seo-ops/* routes. */
export function registerSeoOpsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  app.get("/api/seo-ops/config", async (request) => {
    requirePermission(request, "seoops.view");
    // Copilot is intentionally not wired this phase. Hardcode false so stray
    // CORE_AI_* env vars can't surface a UI that calls unimplemented
    // /api/sessions endpoints.
    return {
      copilot_enabled: false,
      agent_run_enabled: ctx.coreAi !== null && ctx.config.agentRunAgentId !== null,
      agent_run_stages: AGENT_RUN_STAGES,
    };
  });

  app.get("/api/seo-ops/portfolio", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    return portfolio(ctx.db, actor.userId);
  });

  app.get("/api/seo-ops/inbox", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    return inbox(ctx.db, request.query as Record<string, unknown>, actor.userId);
  });

  app.get("/api/seo-ops/reviews", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    return reviews(ctx.db, request.query as Record<string, unknown>, actor.userId);
  });

  app.get("/api/seo-ops/reports", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    return reports(ctx.db, request.query as Record<string, unknown>, actor.userId);
  });

  app.get("/api/seo-ops/tasks/:taskId", async (request, reply) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    const task = await requireTaskAccess(ctx.db, actor, taskId);
    reply.status(200);
    return taskView(task, await taskNames(ctx, task));
  });

  app.get("/api/seo-ops/tasks/:taskId/events", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    return taskEvents(ctx.db, taskId, request.query as Record<string, unknown>);
  });

  // ---- 阶段运行（归属商户，不建任务） ----

  app.post(
    "/api/seo-ops/merchants/:merchantId/stage-runs",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { merchantId } = request.params as { merchantId: string };
      await requireMerchantAccess(ctx.db, actor, merchantId);
      const body = triggerStageRunSchema.parse(request.body);
      if (body.location_id) {
        await requireLocationAccess(ctx.db, actor, merchantId, body.location_id);
      }
      if (!ctx.coreAi || !ctx.config.agentRunAgentId) {
        throw new ApiError(
          503,
          "core-ai is not configured on this server",
          "CORE_AI_NOT_CONFIGURED",
        );
      }
      const deps: AgentRunDeps = {
        db: ctx.db,
        client: ctx.coreAi,
        agentId: ctx.config.agentRunAgentId,
        artifactsDir: ctx.artifactsDir,
        dailyRunLimit: ctx.config.agentRunDailyLimit,
        log: { warn: (message) => request.log.warn(message) },
      };
      const { run, replayed } = await triggerStageRun(deps, merchantId, body, actor.userId);
      reply.status(replayed ? 200 : 202);
      return stageRunView(run, await listDeliverablesByRun(ctx.db, run.id));
    },
  );

  app.get("/api/seo-ops/merchants/:merchantId/stage-runs", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const query = request.query as Record<string, unknown>;
    const { offset, limit } = parsePageParams(query);
    const stage = typeof query.stage === "string" && query.stage !== "" ? query.stage : undefined;
    const page = await listStageRuns(ctx.db, merchantId, { stage, offset, limit });
    const deliverablesByRun = await listDeliverablesByRunIds(
      ctx.db,
      page.items.map((run) => run.id),
    );
    return {
      ...page,
      items: page.items.map((run) =>
        stageRunView(run, deliverablesByRun.get(run.id) ?? []),
      ),
    };
  });

  app.get("/api/seo-ops/agent-runs/:runId", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { runId } = request.params as { runId: string };
    const run = await requireRunAccess(ctx.db, actor, runId);
    return stageRunView(run, await listDeliverablesByRun(ctx.db, run.id), {
      includeFullOutput: true,
    });
  });

  // 兜底：agent 只回正文不回附件时，运营手工上传交付物解锁阶段。
  app.post(
    "/api/seo-ops/agent-runs/:runId/deliverables",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { runId } = request.params as { runId: string };
      await requireRunAccess(ctx.db, actor, runId);
      const body = manualDeliverableSchema.parse(request.body);
      const deliverable = await addManualDeliverable(
        { db: ctx.db, artifactsDir: ctx.artifactsDir },
        runId,
        body,
      );
      reply.status(201);
      return deliverableView(deliverable);
    },
  );

  app.get(
    "/api/seo-ops/deliverables/:deliverableId/download",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.view");
      const { deliverableId } = request.params as { deliverableId: string };
      const deliverable = await requireDeliverableAccess(ctx.db, actor, deliverableId);
      if (!deliverable.localPath) {
        throw new ApiError(
          404,
          `deliverable ${deliverable.fileName} was not downloaded (remote fetch failed)`,
          "DELIVERABLE_NOT_DOWNLOADED",
        );
      }
      const buffer = await fsPromises.readFile(deliverable.localPath);
      reply.header(
        "Content-Type",
        deliverable.contentType ?? "application/octet-stream",
      );
      reply.header(
        "Content-Disposition",
        `attachment; filename="${attachmentFileNameForHeader(deliverable.fileName)}"`,
      );
      return reply.send(buffer);
    },
  );

  app.post("/api/seo-ops/agent-runs/:runId/cancel", async (request) => {
    const actor = requirePermission(request, "seoops.manage");
    const { runId } = request.params as { runId: string };
    await requireRunAccess(ctx.db, actor, runId);
    if (!ctx.coreAi || !ctx.config.agentRunAgentId) {
      throw new ApiError(
        503,
        "core-ai is not configured on this server",
        "CORE_AI_NOT_CONFIGURED",
      );
    }
    const run = await cancelStageRun(
      {
        db: ctx.db,
        client: ctx.coreAi,
        agentId: ctx.config.agentRunAgentId,
        artifactsDir: ctx.artifactsDir,
        log: { warn: (message) => request.log.warn(message) },
      },
      runId,
    );
    return stageRunView(run, await listDeliverablesByRun(ctx.db, run.id), {
      includeFullOutput: true,
    });
  });

  app.post("/api/seo-ops/merchants", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const body = createMerchantSchema.parse(request.body);
    const result = await createMerchant(ctx.db, {
      slug: body.slug,
      displayName: body.display_name,
      tags: body.tags,
      operatorUserIds: body.operator_user_ids,
      idempotencyKey: body.idempotency_key,
      createdBy: actor.userId,
      actorUserId: actor.userId,
    });
    reply.status(result.replayed ? 200 : 201);
    return merchantView(result.entity);
  });

  app.post(
    "/api/seo-ops/merchants/:merchantId/locations",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { merchantId } = request.params as { merchantId: string };
      await requireMerchantAccess(ctx.db, actor, merchantId);
      const body = createLocationSchema.parse(request.body);
      const result = await createLocation(ctx.db, merchantId, {
        slug: body.slug,
        displayName: body.display_name,
        timezone: body.timezone,
        externalIdentities: body.external_identities,
        readinessStatus: body.readiness_status,
        missingRequirements: body.missing_requirements,
        idempotencyKey: body.idempotency_key,
        createdBy: actor.userId,
      });
      reply.status(result.replayed ? 200 : 201);
      return locationView(result.entity);
    },
  );

  // ---- 问卷（新店接入入口） ----

  app.post(
    "/api/seo-ops/merchants/:merchantId/questionnaires",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { merchantId } = request.params as { merchantId: string };
      await requireMerchantAccess(ctx.db, actor, merchantId);
      const body = createQuestionnaireSchema.parse(request.body);
      const result = await createQuestionnaire(ctx.db, merchantId, {
        website: body.website ?? null,
        idempotencyKey: body.idempotency_key,
        createdBy: actor.userId,
      });
      reply.status(result.replayed ? 200 : 201);
      return questionnaireView(result.entity);
    },
  );

  app.post(
    "/api/seo-ops/questionnaires/:questionnaireId/send",
    async (request) => {
      const actor = requirePermission(request, "seoops.manage");
      const { questionnaireId } = request.params as { questionnaireId: string };
      const questionnaire = await getQuestionnaire(ctx.db, questionnaireId);
      if (!questionnaire) throw new ApiError(404, "resource not found");
      await requireMerchantAccess(ctx.db, actor, questionnaire.merchantId);
      return questionnaireView(await sendQuestionnaire(ctx.db, questionnaireId, actor.userId));
    },
  );

  // 公开回收面（商家填写，无鉴权；只暴露题目，不回传答案与内部 id）。
  app.get("/api/public/questionnaire-forms/:slug", async (request) => {
    const { slug } = request.params as { slug: string };
    const questionnaire = await getQuestionnaireByShareSlugOr404(ctx, slug);
    const merchant = await getMerchant(ctx.db, questionnaire.merchantId);
    return {
      status: questionnaire.status,
      merchant_name: merchant?.displayName ?? questionnaire.merchantId,
      base_info: questionnaire.baseInfo,
      ...(questionnaire.status === "FILLED"
        ? {}
        : { questions: questionnaire.questions }),
    };
  });

  app.post(
    "/api/public/questionnaire-forms/:slug/submissions",
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = submitQuestionnaireSchema.parse(request.body);
      const questionnaire = await submitQuestionnaire(ctx.db, slug, body.answers);
      reply.status(questionnaire.filledAt ? 200 : 201);
      return { status: questionnaire.status };
    },
  );

  // ---- 生命周期（阶段轨 + 异常，全部从证据链推导） ----

  app.get("/api/seo-ops/merchants/:merchantId/lifecycle", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return deriveLifecycleForDb(ctx.db, merchantId);
  });

  // 排名快照 + 与上期对比（老店轮次骨架）；数据源是排名运行的 CSV 附件。
  app.get("/api/seo-ops/merchants/:merchantId/ranking", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return deriveRankingOverview(await loadRankingSnapshots(ctx.db, merchantId));
  });

  app.post("/api/seo-ops/tasks", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const body = createTaskSchema.parse(request.body);
    await requireMerchantAccess(ctx.db, actor, body.merchant_id);
    if (body.location_id) {
      await requireLocationAccess(ctx.db, actor, body.merchant_id, body.location_id);
    }
    const { task, replayed } = await createTask(ctx.db, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  app.post("/api/seo-ops/tasks/:taskId/revisions", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = createRevisionSchema.parse(request.body);
    const { task, replayed } = await createRevision(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  app.post("/api/seo-ops/tasks/:taskId/evidence", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = appendEvidenceSchema.parse(request.body);
    const { task, replayed } = await appendEvidence(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  app.post(
    "/api/seo-ops/tasks/:taskId/conversation-links",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { taskId } = request.params as { taskId: string };
      await requireTaskAccess(ctx.db, actor, taskId);
      const body = linkConversationSchema.parse(request.body);
      const { task, replayed } = await linkConversation(ctx.db, taskId, body, actor.userId);
      reply.status(replayed ? 200 : 201);
      return taskView(task, await taskNames(ctx, task));
    },
  );

  app.post(
    "/api/seo-ops/tasks/:taskId/approval-previews",
    async (request) => {
      const actor = requirePermission(request, "seoops.approve");
      const { taskId } = request.params as { taskId: string };
      await requireTaskAccess(ctx.db, actor, taskId);
      const body = approvalPreviewSchema.parse(request.body);
      return approvalPreview(ctx.db, taskId, body);
    },
  );

  app.post(
    "/api/seo-ops/tasks/:taskId/approval-decisions",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.approve");
      const { taskId } = request.params as { taskId: string };
      await requireTaskAccess(ctx.db, actor, taskId);
      const body = approvalDecisionSchema.parse(request.body);
      const { task, replayed } = await approvalDecision(ctx.db, taskId, body, actor.userId);
      reply.status(replayed ? 200 : 201);
      return taskView(task, await taskNames(ctx, task));
    },
  );
}

/** Render ApiError as `{message, error_code?}` and zod failures as 400. */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.status).send({
        message: error.message,
        ...(error.code ? { error_code: error.code } : {}),
      });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.status(400).send({
        message: error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
        error_code: "VALIDATION_ERROR",
      });
      return;
    }
    reply.status(500).send({ message: "internal server error" });
  });
}

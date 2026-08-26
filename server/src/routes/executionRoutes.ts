import type { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "node:crypto";
import type { AppContext } from "../index.js";
import { ApiError } from "../errors.js";
import {
  requireMerchantAccess,
  requirePermission,
  requireTaskAccess,
} from "../auth/httpAuth.js";
import {
  batchView as loadBatch,
  createProposalBatch,
  decideProposal,
  listBatchViews,
} from "../services/proposalService.js";
import {
  attemptsView,
  confirmExecution,
  completeManualTask,
  executionPreview,
  markVerified,
  resetFailedTask,
  resolveAttemptOutcome,
} from "../services/executionService.js";
import { addDraft, addDraftRevision, draftsView } from "../services/contentService.js";
import { appendEvidence } from "../services/taskService.js";
import { schedulerTick } from "../services/schedulerService.js";
import {
  deriveCapabilityStatus,
  getCapability,
  getCycleConfig,
  latestStyleProfile,
  listAgentBindings,
  listCapabilities,
  listCycleConfigs,
  upsertAgentBinding,
  upsertCapability,
  upsertCycleConfig,
  insertStyleProfile,
} from "../repos/settingsRepo.js";
import {
  getAttempt,
  listAttemptDeliverablesByAttemptIds,
  listAttemptsByTaskPage,
  listOpenUnknownAttempts,
} from "../repos/executionRepo.js";
import { listAgentRunsForTaskAudit, listDeliverablesByRunIds } from "../repos/agentRunRepo.js";
import { countPendingProposals, getProposal } from "../repos/proposalRepo.js";
import { getTask, listTasksByStatus } from "../repos/taskRepo.js";
import { getMerchant, listMerchantsForOperator } from "../repos/merchantRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import type { Task } from "../repos/taskTypes.js";
import {
  listSpecialistArtifactsByMerchant,
  listSpecialistArtifactReferencesByTask,
  listSpecialistArtifactsByTask,
  type SpecialistArtifactType,
} from "../repos/specialistArtifactRepo.js";
import {
  agentBindingView,
  attemptView,
  capabilityView,
  cycleConfigView,
  draftView,
  proposalBatchView,
  proposalView,
  specialistArtifactView,
  styleProfileView,
  taskView,
} from "../views/mappers.js";
import { TASK_TYPES } from "../domain/enums.js";

/** agent 绑定键 = 任务类型 + 执行专用键（GBP 写入由 GBP_EXECUTION agent 执行）。 */
const BINDING_KEYS = [...TASK_TYPES, "GBP_EXECUTION"] as const;

const proposalItemSchema = z.object({
  title: z.string(),
  task_type: z.string(),
  execution_mode: z.string(),
  executor_agent: z.string().optional(),
  location_id: z.string().optional(),
  depends_on: z.array(z.number().int().positive()).optional(),
  due_at: z.string().optional(),
  priority: z.string(),
  impact: z.string(),
  acceptance_criteria: z.string().optional(),
  execution_spec: z.string(),
  required_evidence_types: z.array(z.string()).optional(),
});

const createBatchSchema = z.object({
  merchant_id: z.string(),
  origin: z.string(),
  trigger_reason: z.string().max(2000).optional(),
  planner_run_id: z.string().optional(),
  snapshot_note: z.string().max(4000).optional(),
  idempotency_key: z.string(),
  items: z.array(proposalItemSchema).min(1).max(50),
});

const decideProposalSchema = z.object({
  action: z.enum(["ADOPT", "RETURN"]),
  return_reason: z.string().max(2000).optional(),
  override_priority: z.string().optional(),
  override_due_at: z.string().optional(),
});

const confirmExecutionSchema = z.object({
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const completeManualSchema = z.object({
  source_ref: z.string().min(1).max(1000),
  note: z.string().max(4000).optional(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const resolveOutcomeSchema = z.object({
  resolution: z.enum(["HAPPENED", "NOT_HAPPENED"]),
  note: z.string().max(4000).optional(),
  published_ref: z.string().max(1000).optional(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const verifySchema = z.object({
  note: z.string().max(4000).optional(),
  published_ref: z.string().max(1000).optional(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const resetFailedSchema = z.object({
  note: z.string().max(2000).optional(),
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const addDraftSchema = z.object({
  body: z.string().min(1).max(20000),
  cta_type: z.string().max(50).optional(),
  cta_url: z.string().max(1000).optional(),
  media: z.array(z.string().max(1000)).max(10).optional(),
  source: z.enum(["AGENT_GENERATED", "AGENT_REWRITE", "HUMAN_EDIT"]),
  feedback: z.string().max(4000).optional(),
});

const addDraftRevisionSchema = addDraftSchema.extend({
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const finalizeDraftSchema = z.object({
  expected_state_version: z.number().int().nonnegative(),
  idempotency_key: z.string(),
});

const upsertCapabilitySchema = z.object({
  asset: z.string().min(1).max(100),
  external_ref: z.string().max(500).optional().nullable(),
  tech_connected: z.boolean(),
  merchant_authorized: z.boolean(),
  note: z.string().max(2000).optional().nullable(),
});

const upsertCycleSchema = z.object({
  snapshot_day: z.number().int().min(1).max(28).nullable(),
  post_weekday: z.number().int().min(0).max(6).nullable(),
  post_per_week: z.number().int().min(0).max(7),
  review_window_days: z.number().int().min(1).max(90),
  audit_interval_days: z.number().int().min(1).max(365).nullable(),
  enabled: z.boolean(),
});

const upsertBindingSchema = z.object({
  agent_id: z.string().min(1).max(200),
  agent_label: z.string().max(200).optional().nullable(),
  published_ref: z.string().max(200).optional().nullable(),
});

const styleProfileSchema = z.object({
  voice: z.record(z.unknown()),
});

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

export function registerExecutionRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---- 建议层（Planner 产出 / 人工提报 → 判定 → 采纳建任务） ----

  app.post("/api/seo-ops/proposal-batches", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const body = createBatchSchema.parse(request.body);
    await requireMerchantAccess(ctx.db, actor, body.merchant_id);
    const { result, replayed } = await createProposalBatch(ctx.db, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    const merchant = await getMerchant(ctx.db, result.batch.merchantId);
    return proposalBatchView(result.batch, result.proposals, merchant?.displayName);
  });

  app.get("/api/seo-ops/proposal-batches", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const query = request.query as { merchant_id?: string };
    if (query.merchant_id) {
      await requireMerchantAccess(ctx.db, actor, query.merchant_id);
      const views = await listBatchViews(ctx.db, query.merchant_id);
      const merchant = await getMerchant(ctx.db, query.merchant_id);
      return {
        items: views.map((v) => proposalBatchView(v.batch, v.proposals, merchant?.displayName)),
      };
    }
    const allowed = actor.scopeAll
      ? null
      : new Set((await listMerchantsForOperator(ctx.db, actor.userId)).map((m) => m.id));
    const views = (await listBatchViews(ctx.db)).filter(
      (v) => allowed === null || allowed.has(v.batch.merchantId),
    );
    const names = new Map<string, string>();
    for (const v of views) {
      if (!names.has(v.batch.merchantId)) {
        const merchant = await getMerchant(ctx.db, v.batch.merchantId);
        names.set(v.batch.merchantId, merchant?.displayName ?? v.batch.merchantId);
      }
    }
    return {
      items: views.map((v) =>
        proposalBatchView(v.batch, v.proposals, names.get(v.batch.merchantId)),
      ),
    };
  });

  app.get("/api/seo-ops/proposal-batches/:batchId", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { batchId } = request.params as { batchId: string };
    const view = await loadBatch(ctx.db, batchId);
    await requireMerchantAccess(ctx.db, actor, view.batch.merchantId);
    const merchant = await getMerchant(ctx.db, view.batch.merchantId);
    return proposalBatchView(view.batch, view.proposals, merchant?.displayName);
  });

  // 判定是 AM 的判断权：采纳 → 建任务并回链；退回 → 必填理由留痕。
  app.post("/api/seo-ops/proposals/:proposalId/decision", async (request, reply) => {
    const actor = requirePermission(request, "seoops.approve");
    const { proposalId } = request.params as { proposalId: string };
    // 商户归属校验必须先于判定（对未授权商户按 404 收敛，不泄露存在性）。
    const found = await getProposal(ctx.db, proposalId);
    if (!found) throw new ApiError(404, "resource not found");
    await requireMerchantAccess(ctx.db, actor, found.merchantId);
    const body = decideProposalSchema.parse(request.body);
    const result = await decideProposal(ctx.db, proposalId, body, actor.userId);
    reply.status(200);
    return { proposal: proposalView(result.proposal), task_id: result.taskId };
  });

  // ---- 执行域（门 2 / attempts / 查证 / 核验） ----

  app.get("/api/seo-ops/tasks/:taskId/execution-preview", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    return executionPreview(ctx.db, taskId);
  });

  app.post(
    "/api/seo-ops/tasks/:taskId/execution-confirmations",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.execute");
      const { taskId } = request.params as { taskId: string };
      await requireTaskAccess(ctx.db, actor, taskId);
      const body = confirmExecutionSchema.parse(request.body);
      const { task, replayed } = await confirmExecution(ctx.db, taskId, body, actor.userId);
      reply.status(replayed ? 200 : 201);
      return taskView(task, await taskNames(ctx, task));
    },
  );

  app.post("/api/seo-ops/tasks/:taskId/manual-completions", async (request, reply) => {
    const actor = requirePermission(request, "seoops.execute");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = completeManualSchema.parse(request.body);
    const { task, replayed } = await completeManualTask(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  app.get("/api/seo-ops/tasks/:taskId/attempts", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    return { items: (await attemptsView(ctx.db, taskId)).map(attemptView) };
  });

  app.get("/api/seo-ops/tasks/:taskId/artifacts", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    return {
      items: (await listSpecialistArtifactsByTask(ctx.db, taskId)).map(specialistArtifactView),
    };
  });

  app.get("/api/seo-ops/tasks/:taskId/audit-references", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const task = await getTask(ctx.db, taskId);
    if (!task) throw new ApiError(404, "resource not found");
    const query = request.query as { offset?: string; limit?: string };
    const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);
    const limit = Math.min(50, Math.max(1, Number.parseInt(query.limit ?? "20", 10) || 20));
    const runs = await listAgentRunsForTaskAudit(
      ctx.db, task.id, task.merchantId, task.agentRunLinks.map((link) => link.agentRunId), offset, limit,
    );
    const deliverablesByRun = await listDeliverablesByRunIds(ctx.db, runs.items.map((run) => run.id));
    const attempts = await listAttemptsByTaskPage(ctx.db, task.id, offset, limit);
    const deliverablesByAttempt = await listAttemptDeliverablesByAttemptIds(
      ctx.db, attempts.items.map((attempt) => attempt.id),
    );
    const artifacts = await listSpecialistArtifactReferencesByTask(ctx.db, taskId, offset, limit);
    return {
      offset, limit, total: Math.max(runs.total, attempts.total, artifacts.total),
      agent_runs: runs.items.map((run) => ({
        id: run.id, ...(run.coreRunId ? { core_run_id: run.coreRunId } : {}),
        ...(run.traceRef ? { trace_ref: run.traceRef } : {}),
        deliverables: (deliverablesByRun.get(run.id) ?? []).map((deliverable) => ({
          id: deliverable.id, ...(deliverable.fileId ? { file_id: deliverable.fileId } : {}),
          ...(deliverable.sha256 ? { sha256: deliverable.sha256 } : {}),
          ...(deliverable.remoteUrl ? { source_ref: deliverable.remoteUrl } : {}),
        })),
      })),
      artifacts: artifacts.items.map((artifact) => ({
        id: artifact.id, core_run_id: artifact.coreRunId,
      })),
      execution_attempts: attempts.items.map((attempt) => ({
        id: attempt.id, ...(attempt.coreRunId ? { core_run_id: attempt.coreRunId } : {}),
        ...(attempt.traceRef ? { trace_ref: attempt.traceRef } : {}),
        deliverables: (deliverablesByAttempt.get(attempt.id) ?? []).map((deliverable) => ({
          id: deliverable.id, file_id: deliverable.fileId,
          ...(deliverable.sha256 ? { sha256: deliverable.sha256 } : {}),
          ...(deliverable.sourceRef ? { source_ref: deliverable.sourceRef } : {}),
        })),
      })),
    };
  });

  app.get("/api/seo-ops/merchants/:merchantId/artifacts", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    const { artifact_type: artifactType } = request.query as {
      artifact_type?: SpecialistArtifactType;
    };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return {
      items: (await listSpecialistArtifactsByMerchant(ctx.db, merchantId, artifactType))
        .map(specialistArtifactView),
    };
  });

  // 查证：OUTCOME_UNKNOWN 的二选一裁决（动作发生没有），解除商户冻结。
  app.post("/api/seo-ops/attempts/:attemptId/outcome", async (request, reply) => {
    const actor = requirePermission(request, "seoops.execute");
    const { attemptId } = request.params as { attemptId: string };
    const attempt = await getAttempt(ctx.db, attemptId);
    if (!attempt) throw new ApiError(404, "resource not found");
    await requireTaskAccess(ctx.db, actor, attempt.taskId);
    const body = resolveOutcomeSchema.parse(request.body);
    const { task, replayed } = await resolveAttemptOutcome(
      ctx.db,
      attempt.taskId,
      attemptId,
      body,
      actor.userId,
    );
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  // 核验：变更生效没有（PENDING_VERIFY → DONE）。
  app.post("/api/seo-ops/tasks/:taskId/verification", async (request, reply) => {
    const actor = requirePermission(request, "seoops.execute");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = verifySchema.parse(request.body);
    const { task, replayed } = await markVerified(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  // FAILED（自动重试耗尽）的人工出口：排障后重置回 APPROVED 重新进入派发。
  app.post("/api/seo-ops/tasks/:taskId/failed-reset", async (request, reply) => {
    const actor = requirePermission(request, "seoops.execute");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = resetFailedSchema.parse(request.body);
    const { task, replayed } = await resetFailedTask(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  // ---- 内容稿（Ⓑ 级：稿子迭代在任务下留痕；定稿进证据链锁定审批哈希） ----

  app.get("/api/seo-ops/tasks/:taskId/drafts", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    return { items: (await draftsView(ctx.db, taskId)).map(draftView) };
  });

  app.post("/api/seo-ops/tasks/:taskId/drafts", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = addDraftSchema.parse(request.body);
    const draft = await addDraft(ctx.db, taskId, body, actor.userId);
    reply.status(201);
    return draftView(draft);
  });

  app.post("/api/seo-ops/tasks/:taskId/draft-revisions", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { taskId } = request.params as { taskId: string };
    await requireTaskAccess(ctx.db, actor, taskId);
    const body = addDraftRevisionSchema.parse(request.body);
    const { task, replayed } = await addDraftRevision(ctx.db, taskId, body, actor.userId);
    reply.status(replayed ? 200 : 201);
    return taskView(task, await taskNames(ctx, task));
  });

  // 定稿 = 把指定版本的稿子作为 CONTENT_DRAFT 证据挂到当前修订版。
  app.post(
    "/api/seo-ops/tasks/:taskId/drafts/:version/finalize",
    async (request, reply) => {
      const actor = requirePermission(request, "seoops.manage");
      const { taskId, version } = request.params as { taskId: string; version: string };
      await requireTaskAccess(ctx.db, actor, taskId);
      const body = finalizeDraftSchema.parse(request.body);
      const versionNo = Number(version);
      if (!Number.isInteger(versionNo) || versionNo < 1) {
        throw new ApiError(400, "version must be a positive integer");
      }
      const drafts = await draftsView(ctx.db, taskId);
      const draft = drafts.find((d) => d.version === versionNo);
      if (!draft) throw new ApiError(404, `draft v${versionNo} not found`);
      const { task, replayed } = await appendEvidence(
        ctx.db,
        taskId,
        {
          type: "CONTENT_DRAFT",
          source_ref: `draft:${taskId}:v${draft.version}`,
          sha256: draft.sha256,
          // 取稿子自身的创建时间（确定性）：同 key 重试的指纹才能一致，网络重试走 replay 而不是 409。
          captured_at: draft.createdAt,
          verification_status: "VERIFIED",
          requirement_key: "CONTENT_DRAFT",
          expected_state_version: body.expected_state_version,
          idempotency_key: body.idempotency_key,
        },
        actor.userId,
      );
      reply.status(replayed ? 200 : 201);
      return taskView(task, await taskNames(ctx, task));
    },
  );

  // ---- 设置：能力矩阵 / 周期配置 / agent 绑定 / 风格档案 ----

  app.get("/api/seo-ops/merchants/:merchantId/capabilities", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    return { items: (await listCapabilities(ctx.db, merchantId)).map(capabilityView) };
  });

  app.put(
    "/api/seo-ops/merchants/:merchantId/capabilities/:capability",
    async (request) => {
      const actor = requirePermission(request, "seoops.capability.manage");
      const { merchantId, capability } = request.params as {
        merchantId: string;
        capability: string;
      };
      await requireMerchantAccess(ctx.db, actor, merchantId);
      const body = upsertCapabilitySchema.parse(request.body);
      const existing = await getCapability(ctx.db, merchantId, capability);
      const now = new Date().toISOString();
      const status = deriveCapabilityStatus(body.tech_connected, body.merchant_authorized);
      const saved = await upsertCapability(ctx.db, {
        id: existing?.id ?? crypto.randomUUID(),
        merchantId,
        asset: body.asset,
        capability,
        externalRef: body.external_ref ?? null,
        techConnected: body.tech_connected,
        merchantAuthorized: body.merchant_authorized,
        status,
        verifiedAt: status === "ACTIVE" ? now : existing?.verifiedAt ?? null,
        verifiedBy: status === "ACTIVE" ? actor.userId : existing?.verifiedBy ?? null,
        note: body.note ?? null,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      return capabilityView(saved);
    },
  );

  app.get("/api/seo-ops/merchants/:merchantId/cycle-config", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const cfg = await getCycleConfig(ctx.db, merchantId);
    return cfg ? cycleConfigView(cfg) : null;
  });

  app.put("/api/seo-ops/merchants/:merchantId/cycle-config", async (request) => {
    const actor = requirePermission(request, "seoops.schedule.manage");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const body = upsertCycleSchema.parse(request.body);
    const existing = await getCycleConfig(ctx.db, merchantId);
    const now = new Date().toISOString();
    const saved = await upsertCycleConfig(ctx.db, {
      merchantId,
      snapshotDay: body.snapshot_day,
      postWeekday: body.post_weekday,
      postPerWeek: body.post_per_week,
      reviewWindowDays: body.review_window_days,
      auditIntervalDays: body.audit_interval_days,
      enabled: body.enabled,
      updatedBy: actor.userId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    return cycleConfigView(saved);
  });

  app.get("/api/seo-ops/cycle-configs", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const allowed = actor.scopeAll
      ? null
      : new Set((await listMerchantsForOperator(ctx.db, actor.userId)).map((m) => m.id));
    const configs = (await listCycleConfigs(ctx.db)).filter(
      (c) => allowed === null || allowed.has(c.merchantId),
    );
    return { items: configs.map(cycleConfigView) };
  });

  app.get("/api/seo-ops/agent-bindings", async (request) => {
    requirePermission(request, "seoops.view");
    return {
      items: (await listAgentBindings(ctx.db)).map(agentBindingView),
      binding_keys: BINDING_KEYS,
    };
  });

  app.put("/api/seo-ops/agent-bindings/:taskType", async (request) => {
    const actor = requirePermission(request, "seoops.schedule.manage");
    const { taskType } = request.params as { taskType: string };
    if (!(BINDING_KEYS as readonly string[]).includes(taskType)) {
      throw new ApiError(
        400,
        `taskType must be one of ${BINDING_KEYS.join("/")}`,
        "VALIDATION_ERROR",
      );
    }
    const body = upsertBindingSchema.parse(request.body);
    const now = new Date().toISOString();
    const saved = await upsertAgentBinding(ctx.db, {
      taskType,
      agentId: body.agent_id,
      agentLabel: body.agent_label ?? null,
      publishedRef: body.published_ref ?? null,
      updatedBy: actor.userId,
      createdAt: now,
      updatedAt: now,
    });
    return agentBindingView(saved);
  });

  app.get("/api/seo-ops/merchants/:merchantId/style-profile", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const profile = await latestStyleProfile(ctx.db, merchantId);
    return profile ? styleProfileView(profile) : null;
  });

  app.post("/api/seo-ops/merchants/:merchantId/style-profile", async (request, reply) => {
    const actor = requirePermission(request, "seoops.manage");
    const { merchantId } = request.params as { merchantId: string };
    await requireMerchantAccess(ctx.db, actor, merchantId);
    const body = styleProfileSchema.parse(request.body);
    const latest = await latestStyleProfile(ctx.db, merchantId);
    const saved = await insertStyleProfile(ctx.db, {
      id: crypto.randomUUID(),
      merchantId,
      version: (latest?.version ?? 0) + 1,
      voice: body.voice as Record<string, unknown>,
      updatedBy: actor.userId,
      createdAt: new Date().toISOString(),
    });
    reply.status(201);
    return styleProfileView(saved);
  });

  // ---- 总览徽标 / 管理入口 ----

  app.get("/api/seo-ops/inbox-summary", async (request) => {
    const actor = requirePermission(request, "seoops.view");
    const allowed = actor.scopeAll
      ? null
      : new Set((await listMerchantsForOperator(ctx.db, actor.userId)).map((m) => m.id));
    const inScope = <T extends { merchantId: string }>(rows: T[]): T[] =>
      allowed === null ? rows : rows.filter((r) => allowed.has(r.merchantId));

    const pendingProposals = allowed === null
      ? await countPendingProposals(ctx.db)
      : inScope(
          (await Promise.all(
            [...allowed].map(async (m) => ({
              merchantId: m,
              n: await countPendingProposals(ctx.db, m),
            })),
          )),
        ).reduce((sum, r) => sum + r.n, 0);

    const readyForApproval = inScope(await listTasksByStatus(ctx.db, ["READY_FOR_APPROVAL"]));
    const approved = inScope(await listTasksByStatus(ctx.db, ["APPROVED"]));
    const pendingVerify = inScope(await listTasksByStatus(ctx.db, ["PENDING_VERIFY"]));
    const unknown = inScope(await listOpenUnknownAttempts(ctx.db));

    return {
      pending_proposals: pendingProposals,
      ready_for_approval: readyForApproval.length,
      awaiting_execution: approved.filter((t) => t.executionMode !== "READ_ONLY").length,
      pending_verify: pendingVerify.length,
      outcome_unknown: unknown.length,
      frozen_merchant_ids: [...new Set(unknown.map((a) => a.merchantId))],
    };
  });

  // 手动触发一轮周期调度（冒烟/演示；平时由定时器自动跑）。
  app.post("/api/seo-ops/admin/scheduler-tick", async (request) => {
    requirePermission(request, "seoops.schedule.manage");
    return schedulerTick({
      db: ctx.db,
      log: (message, err) => request.log.warn({ err }, message),
    });
  });

  // 手动触发一轮执行 worker（冒烟/演示；平时由定时器自动跑）。
  app.post("/api/seo-ops/admin/execution-tick", async (request) => {
    requirePermission(request, "seoops.schedule.manage");
    if (!ctx.executionWorker) {
      throw new ApiError(503, "execution worker is not configured", "WORKER_NOT_CONFIGURED");
    }
    await ctx.executionWorker.pollOnce();
    return { status: "ok" };
  });
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../index.js";
import { ApiError } from "../errors.js";
import {
  createLocation,
  createMerchant,
} from "../services/merchantService.js";
import {
  ACTOR_ID,
  appendEvidence,
  approvalDecision,
  approvalPreview,
  createRevision,
  createTask,
  linkConversation,
} from "../services/taskService.js";
import {
  inbox,
  portfolio,
  reports,
  reviews,
  taskEvents,
} from "../services/queryService.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import { getTask } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { locationView, merchantView, taskView } from "../views/mappers.js";
import {
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

/** Resolve the merchant/location names a task wire view needs. */
function taskNames(ctx: AppContext, task: Task): {
  merchantName: string;
  locationName?: string;
} {
  const merchant = getMerchant(ctx.db, task.merchantId);
  const location = task.locationId ? getLocation(ctx.db, task.locationId) : null;
  return {
    merchantName: merchant?.displayName ?? task.merchantId,
    ...(location ? { locationName: location.displayName } : {}),
  };
}

function taskOr404(ctx: AppContext, taskId: string): Task {
  const task = getTask(ctx.db, taskId);
  if (!task) {
    const err = new ApiError(404, `task ${taskId} not found`, undefined);
    throw err;
  }
  return task;
}

/** Register all /api/seo-ops/* routes + auth/config stubs. */
export function registerSeoOpsRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): void {
  // Fixed identity until real auth exists; `*` lets every frontend
  // hasPermission() check pass.
  app.get("/api/auth/me", async () => ({
    user_id: ACTOR_ID,
    name: "Local Operator",
    role: "seo_lead",
    permissions: ["*"],
  }));

  app.get("/api/seo-ops/config", async () => {
    // Copilot is intentionally not wired this phase. Hardcode false so stray
    // CORE_AI_* env vars can't surface a UI that calls unimplemented
    // /api/sessions endpoints.
    return { copilot_enabled: false };
  });

  app.get("/api/seo-ops/portfolio", async () => portfolio(ctx.db));

  app.get("/api/seo-ops/inbox", async (request) =>
    inbox(ctx.db, request.query as Record<string, unknown>),
  );

  app.get("/api/seo-ops/reviews", async (request) =>
    reviews(ctx.db, request.query as Record<string, unknown>),
  );

  app.get("/api/seo-ops/reports", async (request) =>
    reports(ctx.db, request.query as Record<string, unknown>),
  );

  app.get("/api/seo-ops/tasks/:taskId", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    const task = taskOr404(ctx, taskId);
    reply.status(200);
    return taskView(task, taskNames(ctx, task));
  });

  app.get("/api/seo-ops/tasks/:taskId/events", async (request) => {
    const { taskId } = request.params as { taskId: string };
    return taskEvents(ctx.db, taskId, request.query as Record<string, unknown>);
  });

  app.post("/api/seo-ops/merchants", async (request, reply) => {
    const body = createMerchantSchema.parse(request.body);
    const result = createMerchant(ctx.db, {
      slug: body.slug,
      displayName: body.display_name,
      tags: body.tags,
      operatorUserIds: body.operator_user_ids,
      idempotencyKey: body.idempotency_key,
      createdBy: "local-dev",
    });
    reply.status(result.replayed ? 200 : 201);
    return merchantView(result.entity);
  });

  app.post(
    "/api/seo-ops/merchants/:merchantId/locations",
    async (request, reply) => {
      const { merchantId } = request.params as { merchantId: string };
      const body = createLocationSchema.parse(request.body);
      const result = createLocation(ctx.db, merchantId, {
        slug: body.slug,
        displayName: body.display_name,
        timezone: body.timezone,
        externalIdentities: body.external_identities,
        readinessStatus: body.readiness_status,
        missingRequirements: body.missing_requirements,
        idempotencyKey: body.idempotency_key,
        createdBy: "local-dev",
      });
      reply.status(result.replayed ? 200 : 201);
      return locationView(result.entity);
    },
  );

  app.post("/api/seo-ops/tasks", async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    const { task, replayed } = createTask(ctx.db, body);
    reply.status(replayed ? 200 : 201);
    return taskView(task, taskNames(ctx, task));
  });

  app.post("/api/seo-ops/tasks/:taskId/revisions", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    taskOr404(ctx, taskId);
    const body = createRevisionSchema.parse(request.body);
    const { task, replayed } = createRevision(ctx.db, taskId, body);
    reply.status(replayed ? 200 : 201);
    return taskView(task, taskNames(ctx, task));
  });

  app.post("/api/seo-ops/tasks/:taskId/evidence", async (request, reply) => {
    const { taskId } = request.params as { taskId: string };
    taskOr404(ctx, taskId);
    const body = appendEvidenceSchema.parse(request.body);
    const { task, replayed } = appendEvidence(ctx.db, taskId, body);
    reply.status(replayed ? 200 : 201);
    return taskView(task, taskNames(ctx, task));
  });

  app.post(
    "/api/seo-ops/tasks/:taskId/conversation-links",
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      taskOr404(ctx, taskId);
      const body = linkConversationSchema.parse(request.body);
      const { task, replayed } = linkConversation(ctx.db, taskId, body);
      reply.status(replayed ? 200 : 201);
      return taskView(task, taskNames(ctx, task));
    },
  );

  app.post(
    "/api/seo-ops/tasks/:taskId/approval-previews",
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      taskOr404(ctx, taskId);
      const body = approvalPreviewSchema.parse(request.body);
      return approvalPreview(ctx.db, taskId, body);
    },
  );

  app.post(
    "/api/seo-ops/tasks/:taskId/approval-decisions",
    async (request, reply) => {
      const { taskId } = request.params as { taskId: string };
      taskOr404(ctx, taskId);
      const body = approvalDecisionSchema.parse(request.body);
      const { task, replayed } = approvalDecision(ctx.db, taskId, body);
      reply.status(replayed ? 200 : 201);
      return taskView(task, taskNames(ctx, task));
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

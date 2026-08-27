import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import { canonicalize, requestFingerprint } from "../domain/hashing.js";
import { gbpContentHttpRequestFingerprint } from "../domain/gbpContentRunIdentity.js";
import {
  agentRunScopeReconciliationRequired,
  assertAgentRunTaskScope,
  assertTaskMatchesAgentRunScope,
  type AgentRunTaskScope,
} from "../domain/agentRunScope.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import {
  findActiveGbpContentRunByTask,
  findAgentRunByTaskFingerprint,
  findLatestGbpContentRunByBusinessFingerprint,
  getAgentRun,
  transitionAgentRun,
} from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { getLocation } from "../repos/locationRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getAgentBinding, latestStyleProfile } from "../repos/settingsRepo.js";
import { getTask, getTaskForUpdate } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { addAgentGeneratedDraftFromRun } from "./contentService.js";
import { getDraftByAgentRunId } from "../repos/draftRepo.js";
import type { CoreAiClient } from "./coreAiClient.js";
import { requireIdempotencyKey } from "./merchantService.js";
import { allocateAgentRun, resolveAgentRunRequestReplay } from "./agentRunAllocator.js";

export const GBP_POST_CONTENT_REQUEST_SCHEMA_VERSION = "seo_ops.gbp_post_request.v1";
export const GBP_POST_CONTENT_OUTPUT_SCHEMA_VERSION = "seo_ops.gbp_post_draft.v1";

const clusterSchema = z.object({
  cluster_id: z.string().trim().min(1).max(200),
  search_intent: z.string().trim().min(1).max(500),
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
}).strict();

const contentExecutionSpecSchema = z.object({
  occurrence_at: z.string().datetime({ offset: true }),
  post_type: z.enum(["STANDARD", "OFFER", "EVENT"]),
  primary_keyword_cluster: clusterSchema,
  evidence_references: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
}).passthrough();

const gbpPostDraftOutputSchema = z.object({
  schema_version: z.literal(GBP_POST_CONTENT_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  location_id: z.string().trim().min(1),
  occurrence_at: z.string().datetime({ offset: true }),
  market: z.object({
    country_code: z.literal("US"),
    language: z.literal("en-US"),
    search_engine: z.literal("GOOGLE"),
  }).strict(),
  post_type: z.enum(["STANDARD", "OFFER", "EVENT"]),
  voice_profile_version: z.string().trim().min(1).max(100),
  primary_keyword_cluster: clusterSchema,
  evidence_references: z.array(z.string().trim().min(1).max(500)).min(1).max(50),
  copy: z.string().trim().min(1).max(1500),
  media_brief: z.object({
    concept: z.string().trim().min(1).max(1000),
    alt_text: z.string().trim().min(1).max(500),
  }).strict(),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(30),
}).strict();

const PRE_GATE_CONTENT_STATUSES = new Set([
  "DRAFT",
  "NEEDS_INPUT",
  "BLOCKED",
  "REVISION_REQUIRED",
  "APPROVAL_REVOKED",
]);

export interface GbpPostContentDeps {
  db: Db;
  client: CoreAiClient;
  dailyRunLimit?: number;
  log?: { warn(message: string): void };
}

export interface GbpPostContentRetry {
  priorRunId: string;
  reason: string;
}

const DEFAULT_DAILY_RUN_LIMIT = 20;

function nowIso(): string {
  return new Date().toISOString();
}

function throwActiveFingerprintConflict(taskId: string): never {
  throw conflict(
    `task ${taskId} already has an active GBP Post content run for a different input fingerprint`,
    "CONTENT_RUN_ACTIVE",
  );
}

function parseExecutionSpec(task: Task) {
  let raw: unknown;
  try {
    raw = JSON.parse(task.executionSpec);
  } catch {
    throw badRequest("GBP_POST execution_spec must be valid JSON");
  }
  const parsed = contentExecutionSpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw badRequest(
      `GBP_POST execution_spec mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return parsed.data;
}

export function parseGbpPostDraftOutput(output: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("GBP Post content output must be strict JSON");
  }
  const parsed = gbpPostDraftOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `GBP Post content output schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return parsed.data;
}

async function buildRun(
  deps: GbpPostContentDeps,
  task: Task,
  key: string,
  actorId: string,
  retry?: GbpPostContentRetry,
  retryGeneration = 0,
) {
  assertPreGateContentTask(task);
  const [merchant, location, binding, styleProfile] = await Promise.all([
    getMerchant(deps.db, task.merchantId),
    getLocation(deps.db, task.locationId!),
    getAgentBinding(deps.db, "GBP_POST"),
    latestStyleProfile(deps.db, task.merchantId),
  ]);
  if (!merchant) throw notFound(`merchant ${task.merchantId} not found`);
  if (!location || location.merchantId !== task.merchantId) {
    throw badRequest(`location ${task.locationId} does not belong to merchant ${task.merchantId}`);
  }
  if (!binding) throw conflict("GBP_POST content Agent is not bound", "AGENT_NOT_BOUND");
  if (!styleProfile) throw conflict("GBP_POST content requires a versioned style profile", "STYLE_PROFILE_MISSING");
  const spec = parseExecutionSpec(task);
  const versionRef = `${styleProfile.id}:v${styleProfile.version}`;
  const businessFingerprint = requestFingerprint({
    task_id: task.id,
    task_revision: task.taskRevision,
    execution_spec_hash: task.executionSpecHash,
    binding_agent_id: binding.agentId,
    style_profile_id: styleProfile.id,
    style_profile_version: styleProfile.version,
  });
  const fingerprint = requestFingerprint({
    business_input_fingerprint: businessFingerprint,
    retry_of_agent_run_id: retry?.priorRunId ?? null,
    retry_generation: retryGeneration,
  });
  const httpRequestFingerprint = gbpContentHttpRequestFingerprint(task.id, retry);
  const message = JSON.stringify({
    schema_version: GBP_POST_CONTENT_REQUEST_SCHEMA_VERSION,
    seo_ops_task_id: task.id,
    market: { country_code: "US", language: "en-US", search_engine: "GOOGLE" },
    merchant: { id: merchant.id, slug: merchant.slug, display_name: merchant.displayName },
    location: {
      id: location.id,
      slug: location.slug,
      display_name: location.displayName,
      timezone: location.timezone,
      external_identities: location.externalIdentities,
    },
    occurrence_at: spec.occurrence_at,
    post_type: spec.post_type,
    voice_profile: {
      id: styleProfile.id,
      version: styleProfile.version,
      version_ref: versionRef,
      voice: styleProfile.voice,
    },
    primary_keyword_cluster: spec.primary_keyword_cluster,
    evidence_references: spec.evidence_references,
    business_input_fingerprint: businessFingerprint,
    ...(retry ? {
      retry_context: {
        prior_run_id: retry.priorRunId,
        reason: retry.reason,
      },
    } : {}),
    execution_spec: spec,
    output_schema_version: GBP_POST_CONTENT_OUTPUT_SCHEMA_VERSION,
    rules: [
      "return_strict_json_only",
      "use_united_states_english",
      "never_publish_schedule_send_or_mutate_gbp",
      "never_claim_persistence_or_task_completion",
    ],
  });
  const now = nowIso();
  const run: AgentRun = {
    id: crypto.randomUUID(),
    merchantId: task.merchantId,
    locationId: task.locationId,
    stage: "GBP_POST_CONTENT",
    taskId: task.id,
    runType: "GBP_POST_CONTENT",
    goal: null,
    status: "TRIGGERING",
    coreRunId: null,
    traceRef: null,
    coreStatus: null,
    inputMessage: message,
    output: null,
    error: null,
    errorCode: null,
    tokenUsage: {},
    triggeredBy: actorId,
    triggeredAt: now,
    lastPolledAt: null,
    completedAt: null,
    creationIdempotencyKey: key,
    requestFingerprint: fingerprint,
    httpRequestFingerprint,
    businessInputFingerprint: businessFingerprint,
    retryOfAgentRunId: retry?.priorRunId ?? null,
    retryGeneration,
    retryReason: retry?.reason ?? null,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
  return {
    run,
    agentId: binding.agentId,
    fingerprint,
    httpRequestFingerprint,
    businessFingerprint,
  };
}

function assertPreGateContentTask(task: Task): void {
  if (task.taskType !== "GBP_POST" || task.executionMode !== "AUTO_WRITE") {
    throw badRequest("content Agent runs require an AUTO_WRITE GBP_POST task");
  }
  if (!PRE_GATE_CONTENT_STATUSES.has(task.status)) {
    throw conflict(`content Agent run is not allowed in status ${task.status}`, "INVALID_TRANSITION");
  }
  if (!task.locationId) throw badRequest("GBP_POST content requires one exact location_id");
}

async function replayOrRequireExplicitRetry(
  db: Db,
  run: AgentRun,
): Promise<{ run: AgentRun; replayed: true }> {
  if (run.status === "TRIGGERING" || run.status === "RUNNING") {
    return { run, replayed: true };
  }
  if (run.status === "COMPLETED") {
    if (await getDraftByAgentRunId(db, run.id)) return { run, replayed: true };
    throw conflict(
      "completed GBP Post content run has no persisted draft; manual reconciliation is required",
      "CONTENT_RUN_RECONCILIATION_REQUIRED",
    );
  }
  if (run.errorCode === "TRIGGER_INTERRUPTED") {
    throw conflict(
      "interrupted GBP Post content trigger requires manual reconciliation",
      "CONTENT_RUN_RECONCILIATION_REQUIRED",
    );
  }
  if (run.status === "FAILED" || run.status === "CANCELLED") {
    throw conflict(
      "failed or cancelled GBP Post content generation requires an explicit prior run and retry reason",
      "CONTENT_RUN_RETRY_REQUIRED",
    );
  }
  throw conflict(`GBP Post content run cannot be replayed from ${run.status}`, "INVALID_TRANSITION");
}

async function validateRetryPrior(
  db: Db,
  task: Task,
  retry: GbpPostContentRetry,
  businessFingerprint: string,
): Promise<AgentRun> {
  const prior = await getAgentRun(db, retry.priorRunId);
  if (!prior || prior.taskId !== task.id || prior.stage !== "GBP_POST_CONTENT") {
    throw badRequest("retry prior_run_id must identify a GBP Post content run for this task");
  }
  assertAgentRunTaskScope(prior, {
    stage: "GBP_POST_CONTENT",
    taskId: task.id,
    merchantId: task.merchantId,
    locationId: task.locationId,
  });
  const priorBusinessFingerprint = prior.businessInputFingerprint ?? prior.requestFingerprint;
  if (priorBusinessFingerprint !== businessFingerprint) {
    throw conflict(
      "retry prior run does not share the current business input fingerprint",
      "CONTENT_RUN_RETRY_LINEAGE_MISMATCH",
    );
  }
  return prior;
}

async function triggerOnce(
  deps: GbpPostContentDeps,
  taskId: string,
  authorizedScope: AgentRunTaskScope,
  key: string,
  actorId: string,
  retry?: GbpPostContentRetry,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const task = await getTask(deps.db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  assertTaskMatchesAgentRunScope(task, authorizedScope);

  const httpRequestFingerprint = gbpContentHttpRequestFingerprint(taskId, retry);
  const requestReplay = await resolveAgentRunRequestReplay(
    deps.db,
    key,
    httpRequestFingerprint,
    authorizedScope,
  );
  if (requestReplay) return { run: requestReplay, replayed: true };

  const base = await buildRun(deps, task, key, actorId, undefined, 0);
  const prior = retry
    ? await validateRetryPrior(deps.db, task, retry, base.businessFingerprint)
    : null;
  const retryGeneration = prior ? (prior.retryGeneration ?? 0) + 1 : 0;
  const built = await buildRun(deps, task, key, actorId, retry, retryGeneration);
  assertAgentRunTaskScope(built.run, authorizedScope);

  const allocation = await allocateAgentRun({
    db: deps.db,
    run: built.run,
    httpRequestFingerprint: built.httpRequestFingerprint,
    expectedReplayScope: authorizedScope,
    dailyRunLimit: deps.dailyRunLimit ?? DEFAULT_DAILY_RUN_LIMIT,
    validateBeforeInsert: async (tx) => {
      const current = await getTaskForUpdate(tx, taskId);
      if (!current) throw notFound(`task ${taskId} not found`);
      assertTaskMatchesAgentRunScope(current, authorizedScope);
      if (current.taskRevision !== task.taskRevision
        || current.executionSpecHash !== task.executionSpecHash) {
        throw conflict("task revision changed while allocating GBP Post content", "STALE_STATE");
      }
      assertPreGateContentTask(current);
    },
    findBusinessReplay: async (tx) => {
      const latest = await findLatestGbpContentRunByBusinessFingerprint(
        tx,
        authorizedScope,
        built.businessFingerprint,
      );
      if (!retry) {
        if (latest) return (await replayOrRequireExplicitRetry(tx, latest)).run;
      } else if (latest) {
        if (latest.id === retry.priorRunId) {
          if (latest.status === "FAILED" || latest.status === "CANCELLED") {
            if (latest.errorCode === "TRIGGER_INTERRUPTED") {
              return (await replayOrRequireExplicitRetry(tx, latest)).run;
            }
            return null;
          }
          return (await replayOrRequireExplicitRetry(tx, latest)).run;
        }
        const sameGeneration = latest.requestFingerprint === built.fingerprint
          && latest.retryOfAgentRunId === retry.priorRunId
          && (latest.retryGeneration ?? 0) === retryGeneration;
        if (sameGeneration && (
          latest.status === "TRIGGERING"
          || latest.status === "RUNNING"
          || latest.status === "COMPLETED"
        )) {
          return (await replayOrRequireExplicitRetry(tx, latest)).run;
        }
        if (latest.errorCode === "TRIGGER_INTERRUPTED") {
          return (await replayOrRequireExplicitRetry(tx, latest)).run;
        }
        if (latest.status === "COMPLETED") {
          return (await replayOrRequireExplicitRetry(tx, latest)).run;
        }
        throw conflict(
          "retry prior run is not the latest generation for this business input",
          "CONTENT_RUN_RETRY_LINEAGE_MISMATCH",
        );
      } else {
        throw badRequest("retry prior_run_id does not belong to an existing generation chain");
      }

      const active = await findActiveGbpContentRunByTask(tx, authorizedScope);
      if (active) throwActiveFingerprintConflict(taskId);
      return null;
    },
  });
  if (!allocation.inserted) return { run: allocation.run, replayed: true };

  try {
    assertAgentRunTaskScope(built.run, authorizedScope);
    const triggered = await deps.client.trigger(built.agentId, built.run.inputMessage);
    const adopted = await transitionAgentRun(deps.db, built.run.id, {
      coreRunId: triggered.run_id,
      coreStatus: triggered.status,
      status: "RUNNING",
    }, ["TRIGGERING"]);
    if (!adopted) {
      try { await deps.client.cancel(triggered.run_id); } catch { /* best effort orphan cleanup */ }
      return { run: await getAgentRun(deps.db, built.run.id) ?? built.run, replayed: false };
    }
    return { run: adopted, replayed: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "network error";
    await transitionAgentRun(deps.db, built.run.id, {
      status: "FAILED",
      error: detail,
      errorCode: "TRIGGER_FAILED",
      completedAt: nowIso(),
    }, ["TRIGGERING"]);
    throw new ApiError(502, `core-ai trigger failed: ${detail}`, "CORE_AI_TRIGGER_FAILED");
  }
}

export async function triggerGbpPostContentRun(
  deps: GbpPostContentDeps,
  authorizedScope: AgentRunTaskScope,
  idempotencyKey: string,
  actorId: string,
  retry?: GbpPostContentRetry,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const key = requireIdempotencyKey(idempotencyKey, "idempotency_key");
  return triggerOnce(deps, authorizedScope.taskId, authorizedScope, key, actorId, retry);
}

export async function ingestGbpPostContentRunOutput(
  db: Db,
  run: AgentRun,
  output: string | null | undefined,
  actor = "system:gbp-post-content-agent",
) {
  if (!run.taskId || run.stage !== "GBP_POST_CONTENT") {
    throw new Error("GBP Post content output requires a task-linked content run");
  }
  const task = await getTask(db, run.taskId);
  if (!task) agentRunScopeReconciliationRequired();
  assertAgentRunTaskScope(run, {
    stage: "GBP_POST_CONTENT",
    taskId: task.id,
    merchantId: task.merchantId,
    locationId: task.locationId,
  });
  if (!output) throw new Error("GBP Post content run completed without output");
  const parsed = parseGbpPostDraftOutput(output);
  const request = JSON.parse(run.inputMessage) as {
    merchant: { id: string };
    location: { id: string };
    occurrence_at: string;
    post_type: string;
    voice_profile: { version_ref: string };
    primary_keyword_cluster: unknown;
    evidence_references: unknown;
  };
  const exactChecks: Array<[unknown, unknown, string]> = [
    [parsed.merchant_id, request.merchant.id, "merchant_id"],
    [parsed.location_id, request.location.id, "location_id"],
    [parsed.occurrence_at, request.occurrence_at, "occurrence_at"],
    [parsed.post_type, request.post_type, "post_type"],
    [parsed.voice_profile_version, request.voice_profile.version_ref, "voice_profile_version"],
    [canonicalize(JSON.stringify(parsed.primary_keyword_cluster)), canonicalize(JSON.stringify(request.primary_keyword_cluster)), "primary_keyword_cluster"],
    [canonicalize(JSON.stringify(parsed.evidence_references)), canonicalize(JSON.stringify(request.evidence_references)), "evidence_references"],
  ];
  for (const [actual, expected, field] of exactChecks) {
    if (actual !== expected) throw new Error(`GBP Post content output ${field} does not match the dispatched request`);
  }
  return addAgentGeneratedDraftFromRun(db, run.taskId, run.id, parsed.copy, actor);
}

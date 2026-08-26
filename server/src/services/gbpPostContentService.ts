import crypto from "node:crypto";
import { z } from "zod";
import { isUniqueViolation, type Db } from "../db/connection.js";
import { canonicalize, requestFingerprint } from "../domain/hashing.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import {
  findAgentRunByIdempotencyKey,
  getAgentRun,
  insertAgentRun,
  transitionAgentRun,
} from "../repos/agentRunRepo.js";
import type { AgentRun } from "../repos/agentRunTypes.js";
import { getLocation } from "../repos/locationRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getAgentBinding, latestStyleProfile } from "../repos/settingsRepo.js";
import { getTask } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { addAgentGeneratedDraftFromRun } from "./contentService.js";
import type { CoreAiClient } from "./coreAiClient.js";
import { requireIdempotencyKey, resolveIdempotentCreate } from "./merchantService.js";

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
  log?: { warn(message: string): void };
}

function nowIso(): string {
  return new Date().toISOString();
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

async function buildRun(deps: GbpPostContentDeps, task: Task, key: string, actorId: string) {
  if (task.taskType !== "GBP_POST" || task.executionMode !== "AUTO_WRITE") {
    throw badRequest("content Agent runs require an AUTO_WRITE GBP_POST task");
  }
  if (!PRE_GATE_CONTENT_STATUSES.has(task.status)) {
    throw conflict(`content Agent run is not allowed in status ${task.status}`, "INVALID_TRANSITION");
  }
  if (!task.locationId) throw badRequest("GBP_POST content requires one exact location_id");
  const [merchant, location, binding, styleProfile] = await Promise.all([
    getMerchant(deps.db, task.merchantId),
    getLocation(deps.db, task.locationId),
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
    execution_spec: spec,
    output_schema_version: GBP_POST_CONTENT_OUTPUT_SCHEMA_VERSION,
    rules: [
      "return_strict_json_only",
      "use_united_states_english",
      "never_publish_schedule_send_or_mutate_gbp",
      "never_claim_persistence_or_task_completion",
    ],
  });
  const fingerprint = requestFingerprint({
    task_id: task.id,
    task_revision: task.taskRevision,
    execution_spec_hash: task.executionSpecHash,
    binding_agent_id: binding.agentId,
    style_profile_id: styleProfile.id,
    style_profile_version: styleProfile.version,
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
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  };
  return { run, agentId: binding.agentId, fingerprint };
}

async function triggerOnce(
  deps: GbpPostContentDeps,
  taskId: string,
  key: string,
  actorId: string,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const existing = await findAgentRunByIdempotencyKey(deps.db, key);
  if (existing) {
    if (existing.taskId !== taskId) {
      throw conflict(
        "idempotency key already used for a different task",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    return { run: existing, replayed: true };
  }
  const task = await getTask(deps.db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  const built = await buildRun(deps, task, key, actorId);
  const raced = await deps.db.withTransaction(async (tx) => {
    const found = await findAgentRunByIdempotencyKey(tx, key);
    const replay = resolveIdempotentCreate(found, built.fingerprint);
    if (replay) return replay;
    await insertAgentRun(tx, built.run);
    return built.run;
  });
  if (raced.id !== built.run.id) return { run: raced, replayed: true };

  try {
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
  taskId: string,
  idempotencyKey: string,
  actorId: string,
): Promise<{ run: AgentRun; replayed: boolean }> {
  const key = requireIdempotencyKey(idempotencyKey, "idempotency_key");
  try {
    return await triggerOnce(deps, taskId, key, actorId);
  } catch (error) {
    if (isUniqueViolation(error)) return triggerOnce(deps, taskId, key, actorId);
    throw error;
  }
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

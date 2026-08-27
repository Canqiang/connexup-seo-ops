import crypto from "node:crypto";
import fs from "node:fs/promises";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import {
  GbpCanonicalUtcInstantSchema,
  GbpExecutionCommandSchema,
  GbpSecretRefSchema,
  hashGbpCommandBody,
  hashGbpCommandCta,
  hashGbpCommandImage,
  type GbpExecutionCommandV1,
} from "../domain/gbpExecutionContract.js";
import { canonicalize, executionSpecHash, sha256HashBytes, requestFingerprint } from "../domain/hashing.js";
import { conflict, notFound } from "../errors.js";
import { getLocation } from "../repos/locationRepo.js";
import {
  getGbpCommandByTaskRevision,
  getGbpCommandState,
  getGbpLocationBinding,
  getGbpReceipt,
  insertGbpCommandInTransaction,
  insertGbpLocationBinding,
  listGbpReadbackAttempts,
  updateGbpLocationBinding,
} from "../repos/gbpExecutionRepo.js";
import {
  insertAttempt,
  listInFlightAttempts,
  listOpenUnknownAttempts,
  type ExecutionAttempt,
} from "../repos/executionRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getTask } from "../repos/taskRepo.js";
import type { GbpLocationBinding } from "../repos/types.js";
import type { Task } from "../repos/taskTypes.js";
import { buildEvent, mutateTask } from "./taskService.js";
import { draftSha256 } from "./contentService.js";

const UuidSchema = z.string().uuid();
const SafeCoordinateSchema = z.string().min(1).max(500).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const BindingWriteSchema = z.object({
  account_resource: SafeCoordinateSchema,
  location_resource: SafeCoordinateSchema,
  timezone: z.string().min(1).max(100),
  core_api_user_id: UuidSchema,
  core_api_user_external_id: SafeCoordinateSchema,
  write_secret_ref: GbpSecretRefSchema,
  readback_secret_ref: GbpSecretRefSchema,
  write_agent_id: UuidSchema,
  write_agent_published_ref: SafeCoordinateSchema,
  readback_agent_id: UuidSchema,
  readback_agent_published_ref: SafeCoordinateSchema,
  status: z.enum(["DISABLED", "READY", "BLOCKED"]),
  expected_state_version: z.number().int().nonnegative(),
}).strict();

export type GbpLocationBindingWrite = z.infer<typeof BindingWriteSchema>;

const ConfirmationSchema = z.object({
  expected_state_version: z.number().int().nonnegative(),
  expected_task_revision: z.number().int().positive(),
  expected_execution_spec_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  scheduled_for: GbpCanonicalUtcInstantSchema,
  idempotency_key: z.string().min(1).max(200),
}).strict();

export type ConfirmGbpExecutionInput = z.infer<typeof ConfirmationSchema>;

interface DraftRow {
  id: string; task_id: string; agent_run_id: string | null; media_source_agent_run_id: string | null;
  version: number; body: string; cta_type: string | null; cta_url: string | null;
  media: string; sha256: string;
}

interface DeliverableRunRow {
  id: string; run_id: string; kind: string; content_type: string | null; size: number | null;
  sha256: string | null; local_path: string | null; task_id: string | null;
  merchant_id: string; location_id: string | null; stage: string;
}

interface CanonicalMediaRef {
  schema_version: "seo_ops.media_ref.v1";
  deliverable_id: string;
  sha256: string;
  alt_text: string;
}

function parseMediaRef(raw: string): CanonicalMediaRef {
  try {
    if (canonicalize(raw) !== raw) throw new Error("non-canonical");
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "alt_text,deliverable_id,schema_version,sha256"
      || value.schema_version !== "seo_ops.media_ref.v1"
      || typeof value.deliverable_id !== "string" || !UuidSchema.safeParse(value.deliverable_id).success
      || typeof value.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.sha256)
      || typeof value.alt_text !== "string" || value.alt_text.trim() === "") throw new Error("shape");
    return value as unknown as CanonicalMediaRef;
  } catch {
    throw conflict("finalized GBP media reference is invalid", "GBP_DRAFT_DRIFT");
  }
}

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value === "UTC" || value.includes("/");
  } catch { return false; }
}

function localSchedule(utcIso: string, timezone: string): string {
  const date = new Date(utcIso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  const offset = parts.timeZoneName === "GMT" || parts.timeZoneName === "UTC"
    ? "+00:00"
    : String(parts.timeZoneName).replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

function exactLocationReady(task: Task, binding: GbpLocationBinding, location: Awaited<ReturnType<typeof getLocation>>): boolean {
  if (!location || location.id !== task.locationId || location.merchantId !== task.merchantId) return false;
  const identities = Object.values(location.externalIdentities);
  return binding.status === "READY"
    && binding.timezone === location.timezone
    && identities.length > 0
    && identities.includes(binding.locationResource);
}

export async function putGbpLocationBinding(
  db: Db,
  merchantId: string,
  locationId: string,
  rawInput: unknown,
  actorId: string,
): Promise<{ binding: GbpLocationBinding; created: boolean }> {
  const parsed = BindingWriteSchema.safeParse(rawInput);
  if (!parsed.success) throw new z.ZodError(parsed.error.issues.map((issue) => ({ ...issue, message: "invalid binding field" })));
  const input = parsed.data;
  if (!isIanaTimezone(input.timezone)) throw conflict("GBP binding timezone is invalid", "GBP_BINDING_INVALID");
  const location = await getLocation(db, locationId);
  if (!location || location.merchantId !== merchantId) throw notFound("location binding scope not found");
  if (input.status === "READY") {
    const identities = Object.values(location.externalIdentities);
    if (location.timezone !== input.timezone || identities.length === 0 || !identities.includes(input.location_resource)) {
      throw conflict("GBP binding does not match the exact location", "GBP_BINDING_LOCATION_MISMATCH");
    }
  }
  const existing = await getGbpLocationBinding(db, merchantId, locationId);
  const timestamp = new Date().toISOString();
  if (!existing) {
    if (input.expected_state_version !== 0) throw conflict("GBP binding state is stale", "GBP_BINDING_STALE");
    const binding: GbpLocationBinding = {
      id: crypto.randomUUID(), merchantId, locationId,
      accountResource: input.account_resource, locationResource: input.location_resource,
      timezone: input.timezone, coreApiUserId: input.core_api_user_id,
      coreApiUserExternalId: input.core_api_user_external_id,
      writeSecretRef: input.write_secret_ref, readbackSecretRef: input.readback_secret_ref,
      writeAgentId: input.write_agent_id, writeAgentPublishedRef: input.write_agent_published_ref,
      readbackAgentId: input.readback_agent_id,
      readbackAgentPublishedRef: input.readback_agent_published_ref,
      status: input.status, stateVersion: 1, updatedBy: actorId,
      createdAt: timestamp, updatedAt: timestamp,
    };
    try { await insertGbpLocationBinding(db, binding); } catch {
      throw conflict("GBP binding state is stale", "GBP_BINDING_STALE");
    }
    return { binding, created: true };
  }
  if (input.expected_state_version !== existing.stateVersion) {
    throw conflict("GBP binding state is stale", "GBP_BINDING_STALE");
  }
  const updated = await updateGbpLocationBinding(db, {
    ...existing,
    accountResource: input.account_resource, locationResource: input.location_resource,
    timezone: input.timezone, coreApiUserId: input.core_api_user_id,
    coreApiUserExternalId: input.core_api_user_external_id,
    writeSecretRef: input.write_secret_ref, readbackSecretRef: input.readback_secret_ref,
    writeAgentId: input.write_agent_id, writeAgentPublishedRef: input.write_agent_published_ref,
    readbackAgentId: input.readback_agent_id,
    readbackAgentPublishedRef: input.readback_agent_published_ref,
    status: input.status, stateVersion: existing.stateVersion + 1,
    updatedBy: actorId, updatedAt: timestamp,
  }, existing.stateVersion);
  if (!updated) throw conflict("GBP binding state is stale", "GBP_BINDING_STALE");
  return { binding: updated, created: false };
}

async function loadExactDraftSnapshot(tx: Db, task: Task) {
  let spec: unknown;
  try { spec = JSON.parse(task.executionSpec); } catch { throw conflict("GBP execution spec is invalid", "GBP_DRAFT_DRIFT"); }
  const block = (spec && typeof spec === "object" && !Array.isArray(spec))
    ? (spec as Record<string, unknown>).content_draft : null;
  const parsedBlock = z.object({
    draft_version: z.number().int().positive(), draft_sha256: z.string().regex(/^(?:sha256:)?[0-9a-f]{64}$/),
    body: z.string().min(1).max(1500), cta_type: z.enum(["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]).nullable(),
    cta_url: z.string().nullable(), media: z.array(z.string()).length(1),
  }).strict().safeParse(block);
  if (!parsedBlock.success) throw conflict("finalized GBP draft is missing or invalid", "GBP_DRAFT_DRIFT");
  const snapshot = parsedBlock.data;
  const draft = await tx.one<DraftRow>(
    `SELECT id,task_id,agent_run_id,media_source_agent_run_id,version,body,cta_type,cta_url,media,sha256
       FROM seo_content_drafts WHERE task_id=$1 AND version=$2 FOR SHARE`,
    [task.id, snapshot.draft_version],
  );
  const storedMedia = draft ? JSON.parse(draft.media || "[]") as unknown : null;
  const storedDraftDigest = draft?.sha256.replace(/^sha256:/, "") ?? null;
  const snapshotDraftDigest = snapshot.draft_sha256.replace(/^sha256:/, "");
  const recomputedDraftDigest = draft ? draftSha256({
    body: draft.body, ctaType: draft.cta_type, ctaUrl: draft.cta_url,
    media: Array.isArray(storedMedia) ? storedMedia as string[] : [],
  }) : null;
  if (!draft || draft.task_id !== task.id || draft.version !== snapshot.draft_version
    || storedDraftDigest !== snapshotDraftDigest || recomputedDraftDigest !== storedDraftDigest
    || draft.body !== snapshot.body
    || draft.cta_type !== snapshot.cta_type || draft.cta_url !== snapshot.cta_url
    || canonicalize(JSON.stringify(storedMedia)) !== canonicalize(JSON.stringify(snapshot.media))) {
    throw conflict("finalized GBP draft changed after approval", "GBP_DRAFT_DRIFT");
  }
  const media = parseMediaRef(snapshot.media[0]!);
  const sourceRunId = draft.agent_run_id ?? draft.media_source_agent_run_id;
  const row = await tx.one<DeliverableRunRow>(
    `SELECT d.id,d.run_id,d.kind,d.content_type,d.size,d.sha256,d.local_path,
            r.task_id,r.merchant_id,r.location_id,r.stage
       FROM seo_run_deliverables d JOIN seo_agent_runs r ON r.id=d.run_id
      WHERE d.id=$1 FOR SHARE`,
    [media.deliverable_id],
  );
  if (!row || !sourceRunId || row.run_id !== sourceRunId || row.task_id !== task.id
    || row.merchant_id !== task.merchantId || row.location_id !== task.locationId
    || row.stage !== "GBP_POST_CONTENT" || row.kind !== "ATTACHMENT"
    || !["image/png", "image/jpeg"].includes(row.content_type ?? "")
    || row.sha256 !== media.sha256 || row.local_path === null || row.size === null) {
    throw conflict("finalized GBP image ownership changed after approval", "GBP_IMAGE_DRIFT");
  }
  let bytes: Uint8Array;
  try { bytes = await fs.readFile(row.local_path); } catch {
    throw conflict("finalized GBP image is unavailable", "GBP_IMAGE_DRIFT");
  }
  if (bytes.byteLength !== row.size || sha256HashBytes(bytes) !== media.sha256) {
    throw conflict("finalized GBP image bytes changed after approval", "GBP_IMAGE_DRIFT");
  }
  return {
    id: draft.id, version: draft.version, sha256: `sha256:${storedDraftDigest}`, body: draft.body,
    cta: { type: (draft.cta_type ?? "NONE") as GbpExecutionCommandV1["draft"]["cta"]["type"], url: draft.cta_url },
    image: { deliverable_id: media.deliverable_id, sha256: media.sha256, alt_text: media.alt_text },
  };
}

export async function confirmGbpExecution(
  db: Db,
  taskId: string,
  rawInput: unknown,
  actorId: string,
): Promise<{ task: Task; replayed: boolean; commandId: string }> {
  const input = ConfirmationSchema.parse(rawInput);
  const current = await getTask(db, taskId);
  if (!current) throw notFound(`task ${taskId} not found`);
  if (current.taskType !== "GBP_POST" || current.executionMode !== "AUTO_WRITE") {
    throw conflict("dedicated GBP execution requires an AUTO_WRITE GBP_POST Task", "GBP_EXECUTION_NOT_APPLICABLE");
  }
  if (!current.locationId) throw conflict("GBP execution requires an exact location", "GBP_BINDING_REQUIRED");
  let currentSpecHash: string;
  try { currentSpecHash = executionSpecHash(current.executionSpec); } catch {
    throw conflict("Task execution spec is invalid", "GBP_TASK_DRIFT");
  }
  if (currentSpecHash !== current.executionSpecHash) {
    throw conflict("Task execution spec hash changed", "GBP_TASK_DRIFT");
  }
  const existing = await getGbpCommandByTaskRevision(db, current.id, current.taskRevision, current.merchantId, current.locationId);
  if (existing) {
    if (input.expected_task_revision !== current.taskRevision
      || input.expected_execution_spec_hash !== current.executionSpecHash
      || existing.command.scheduled_for !== input.scheduled_for) {
      throw conflict("existing GBP command does not match this confirmation", "GBP_COMMAND_CONFLICT");
    }
    return { task: current, replayed: true, commandId: existing.id };
  }
  if (current.taskRevision !== input.expected_task_revision
    || current.executionSpecHash !== input.expected_execution_spec_hash) {
    throw conflict("Task revision or execution spec changed", "GBP_TASK_DRIFT");
  }
  const fingerprint = requestFingerprint({
    action: "CONFIRM_GBP_EXECUTION", task_revision: input.expected_task_revision,
    execution_spec_hash: input.expected_execution_spec_hash, scheduled_for: input.scheduled_for,
  });
  const commandId = crypto.randomUUID();
  const instructionId = crypto.randomUUID();
  const result = await mutateTask(
    db, taskId, input.idempotency_key, fingerprint, input.expected_state_version,
    async (task, tx) => {
      if (task.status !== "APPROVED" || task.taskType !== "GBP_POST"
        || task.executionMode !== "AUTO_WRITE" || !task.locationId) {
        throw conflict("Task is not an approved GBP write", "GBP_TASK_DRIFT");
      }
      if (task.taskRevision !== input.expected_task_revision
        || task.executionSpecHash !== input.expected_execution_spec_hash) {
        throw conflict("Task revision or execution spec changed", "GBP_TASK_DRIFT");
      }
      try {
        if (executionSpecHash(task.executionSpec) !== task.executionSpecHash) {
          throw conflict("Task execution spec hash changed", "GBP_TASK_DRIFT");
        }
      } catch (error) {
        if (error instanceof Error && error.name === "ApiError") throw error;
        throw conflict("Task execution spec is invalid", "GBP_TASK_DRIFT");
      }
      const approval = [...task.approvalDecisions].reverse().find((decision) =>
        decision.decision === "APPROVE"
        && decision.taskRevision === task.taskRevision
        && decision.executionSpecHash === task.executionSpecHash,
      );
      if (!approval) throw conflict("exact approval is missing", "GBP_APPROVAL_DRIFT");
      const dependencies = await Promise.all(task.dependsOnTaskIds.map((id) => getTask(tx, id)));
      if (dependencies.some((dependency) => !dependency || dependency.status !== "DONE")) {
        throw conflict("GBP Task dependencies are not DONE", "TASK_DEPENDENCY_NOT_DONE");
      }
      if ((await listOpenUnknownAttempts(tx, task.merchantId)).length > 0
        || (await listInFlightAttempts(tx, task.id)).length > 0) {
        throw conflict("GBP execution chain is not clear", "GATE2_CHECK_FAILED");
      }
      const binding = await getGbpLocationBinding(tx, task.merchantId, task.locationId);
      const lockedLocation = await tx.one<{ id: string }>(
        "SELECT id FROM seo_locations WHERE id=$1 AND merchant_id=$2 FOR SHARE",
        [task.locationId, task.merchantId],
      );
      const location = await getLocation(tx, task.locationId);
      if (!lockedLocation || !binding || !exactLocationReady(task, binding, location)) {
        throw conflict("exact GBP location binding is not ready", "GBP_BINDING_REQUIRED");
      }
      const draft = await loadExactDraftSnapshot(tx, task);
      const createdAt = new Date().toISOString();
      const command = GbpExecutionCommandSchema.parse({
        schema_version: "seo_ops.gbp_execution_command.v1",
        instruction_id: instructionId,
        task: {
          id: task.id, merchant_id: task.merchantId, location_id: task.locationId,
          task_revision: task.taskRevision, execution_spec_sha256: task.executionSpecHash,
          approval_decision_id: approval.id,
        },
        core: {
          api_user_id: binding.coreApiUserId,
          api_user_external_id: binding.coreApiUserExternalId,
          write_secret_ref: binding.writeSecretRef, readback_secret_ref: binding.readbackSecretRef,
          write_agent_id: binding.writeAgentId, write_agent_published_ref: binding.writeAgentPublishedRef,
          readback_agent_id: binding.readbackAgentId,
          readback_agent_published_ref: binding.readbackAgentPublishedRef,
        },
        gbp: {
          account_resource: binding.accountResource, location_resource: binding.locationResource,
          timezone: binding.timezone, scheduled_for_local: localSchedule(input.scheduled_for, binding.timezone),
        },
        operation: { kind: "CREATE_POST" }, draft, scheduled_for: input.scheduled_for,
        provider_idempotency_key: `gbp-create-${task.id}-rev${task.taskRevision}`,
        probe_ref: `gbp-probe-${task.id}-rev${task.taskRevision}`,
      });
      const record = await insertGbpCommandInTransaction(tx, {
        id: commandId, bindingId: binding.id, bindingStateVersion: binding.stateVersion,
        command, createdBy: actorId, createdAt,
      });
      const attempt: ExecutionAttempt = {
        id: crypto.randomUUID(), taskId: task.id, merchantId: task.merchantId,
        attemptNo: task.attemptCount + 1, status: "DISPATCHING", gate: "G2",
        agentRunId: null, coreRunId: null, traceRef: null, gbpCommandId: record.id,
        probeRef: command.probe_ref, error: null, startedAt: createdAt,
        triggerStartedAt: null, resolvedAt: null, resolvedBy: null, resolution: null,
        resolutionNote: null, createdAt, updatedAt: createdAt,
      };
      await insertAttempt(tx, attempt);
      const stateVersion = task.stateVersion + 1;
      return {
        ...task, status: "EXECUTION_CONFIRMED", attemptCount: attempt.attemptNo,
        stateVersion, updatedAt: createdAt,
        events: [...task.events, buildEvent("GBP_EXECUTION_CONFIRMED", task.taskRevision, stateVersion, actorId, {
          fromStatus: task.status, toStatus: "EXECUTION_CONFIRMED", referenceId: record.id,
        })],
      };
    },
  );
  return { ...result, commandId };
}

export async function getGbpExecution(db: Db, taskId: string) {
  const task = await getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  if (task.taskType !== "GBP_POST" || task.executionMode !== "AUTO_WRITE" || !task.locationId) return null;
  const locationId = task.locationId;
  const command = await getGbpCommandByTaskRevision(db, task.id, task.taskRevision, task.merchantId, locationId);
  const binding = await getGbpLocationBinding(db, task.merchantId, locationId);
  if (!command) {
    const [previewDraft, merchant, location] = await Promise.all([
      db.withTransaction((tx) => loadExactDraftSnapshot(tx, task)),
      getMerchant(db, task.merchantId), getLocation(db, locationId),
    ]);
    return {
      task, binding, command: null, state: null, receipt: null, readbacks: [],
      previewDraft, merchant, location,
    };
  }
  const [state, receipt, readbacks, merchant, location] = await Promise.all([
    getGbpCommandState(db, command.id, task.merchantId, locationId),
    getGbpReceipt(db, command.id, task.merchantId, locationId),
    getGbpReceipt(db, command.id, task.merchantId, locationId)
      .then((found) => found ? listGbpReadbackAttempts(db, command.id, task.merchantId, locationId) : []),
    getMerchant(db, task.merchantId), getLocation(db, locationId),
  ]);
  return { task, binding, command, state, receipt, readbacks, merchant, location,
    bodySha256: hashGbpCommandBody(command.command), ctaSha256: hashGbpCommandCta(command.command),
    imageSha256: hashGbpCommandImage(command.command) };
}

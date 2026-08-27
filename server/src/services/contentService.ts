import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { getTask, getTaskForUpdate } from "../repos/taskRepo.js";
import type { EvidenceRefRecord, Task, TaskDefinitionRecord } from "../repos/taskTypes.js";
import { canonicalize, executionSpecHash, requestFingerprint, sha256HashBytes } from "../domain/hashing.js";
import { buildEvent, mutateTask, reevaluate } from "./taskService.js";
import {
  insertDraft,
  getDraftByAgentRunId,
  getDraftByTaskVersion,
  latestDraft,
  listDraftsByTask,
  type ContentDraft,
} from "../repos/draftRepo.js";
import { findActiveGbpContentRunByTask, getAgentRun, getDeliverable } from "../repos/agentRunRepo.js";
import { canAppendEvidence } from "../domain/stateMachine.js";

function nowIso(): string {
  return new Date().toISOString();
}

/** 内容稿指纹：正文 + CTA + 媒体的稳定哈希。审批哈希锁定的 execution_spec
 * 引用 {draft_version, sha256}，改稿必然改哈希 → 批过的稿子改一个字就得重批。 */
export function draftSha256(input: {
  body: string;
  ctaType: string | null;
  ctaUrl: string | null;
  media: string[];
}): string {
  const canonical = JSON.stringify({
    body: input.body,
    cta_type: input.ctaType,
    cta_url: input.ctaUrl,
    media: [...input.media].sort(),
  });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export interface AddDraftInput {
  body: string;
  cta_type?: string;
  cta_url?: string;
  media?: string[];
  source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT";
  /** AGENT_REWRITE 必填：触发重写的人工反馈原文（留痕）。 */
  feedback?: string;
}

export interface AddDraftRevisionInput extends AddDraftInput {
  expected_state_version: number;
  idempotency_key: string;
}

const DRAFT_SOURCES = new Set(["AGENT_GENERATED", "AGENT_REWRITE", "HUMAN_EDIT"]);
const CONTENT_REVISION_ALLOWED_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "REVISION_REQUIRED", "APPROVAL_REVOKED", "APPROVED",
]);
const AGENT_DRAFT_ALLOWED_STATUSES = new Set([
  "DRAFT", "NEEDS_INPUT", "BLOCKED", "READY_FOR_APPROVAL", "REVISION_REQUIRED", "APPROVAL_REVOKED",
]);

const GBP_CTA_TYPES = new Set(["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);
const GBP_PHONE_PATTERN = /(?:\+?1[\s.()-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;
const GBP_POST_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function collectStrings(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === "string") result.add(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, result));
  else if (value !== null && typeof value === "object") {
    Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, result));
  }
  return result;
}

/** One authoritative GBP copy/CTA policy used both at Core output ingestion
 * and again when a persisted draft is selected or edited by a human. */
export function validateGbpPostTextAndCta(input: {
  body: string;
  ctaType: string | null;
  ctaUrl: string | null;
}, acceptedContext: unknown): void {
  if (!GBP_CTA_TYPES.has(input.ctaType ?? "")) {
    throw new Error("GBP Post cta_type must be one of the supported CTA values");
  }
  if ((input.ctaType === "NONE" || input.ctaType === "CALL") && input.ctaUrl !== null) {
    throw new Error(`GBP Post ${input.ctaType} forbids cta_url`);
  }
  if (input.ctaType !== "NONE" && input.ctaType !== "CALL") {
    if (!input.ctaUrl) throw new Error(`GBP Post ${input.ctaType} requires cta_url`);
    let url: URL;
    try { url = new URL(input.ctaUrl); } catch { throw new Error("GBP Post cta_url must be absolute HTTPS"); }
    if (url.protocol !== "https:") throw new Error("GBP Post cta_url must be absolute HTTPS");
    if (!collectStrings(acceptedContext).has(input.ctaUrl)) {
      throw new Error("GBP Post cta_url was not supplied in accepted evidence or execution_spec");
    }
  }
  if (GBP_PHONE_PATTERN.test(input.body)) throw new Error("GBP Post copy must contain no phone number");
}

function validateDraftInput(input: AddDraftInput): void {
  if (typeof input.body !== "string" || input.body.trim() === "") {
    throw badRequest("body is required and must be a non-empty string");
  }
  if (!DRAFT_SOURCES.has(input.source)) {
    throw badRequest("source must be AGENT_GENERATED, AGENT_REWRITE or HUMAN_EDIT");
  }
  if (input.source === "AGENT_REWRITE" && !input.feedback?.trim()) {
    throw badRequest("feedback is required for AGENT_REWRITE drafts");
  }
}

function buildDraft(
  taskId: string,
  version: number,
  input: AddDraftInput,
  actorId: string,
  agentRunId: string | null = null,
  mediaSourceAgentRunId: string | null = null,
): ContentDraft {
  const media = input.media ?? [];
  return {
    id: crypto.randomUUID(), taskId, agentRunId, mediaSourceAgentRunId, version, body: input.body,
    ctaType: input.cta_type ?? null, ctaUrl: input.cta_url ?? null, media,
    source: input.source, feedback: input.feedback ?? null,
    sha256: draftSha256({ body: input.body, ctaType: input.cta_type ?? null, ctaUrl: input.cta_url ?? null, media }),
    createdBy: actorId, createdAt: nowIso(),
  };
}

/** Core AI content ingestion boundary. The task row lock serializes competing
 * pollers; agent_run_id makes replay durable across restarts. This adds a
 * draft only and intentionally does not mutate Task state or approval data. */
export async function addAgentGeneratedDraftFromRun(
  db: Db,
  taskId: string,
  agentRunId: string,
  input: Pick<AddDraftInput, "body" | "cta_type" | "cta_url" | "media">,
  actorId: string,
  expectedTaskVersion: { taskRevision: number; executionSpecHash: string },
): Promise<{ draft: ContentDraft; replayed: boolean }> {
  validateDraftInput({ ...input, source: "AGENT_GENERATED" });
  return db.withTransaction(async (tx) => {
    const task = await getTaskForUpdate(tx, taskId);
    if (!task) throw notFound(`task ${taskId} not found`);
    const existing = await getDraftByAgentRunId(tx, agentRunId);
    if (existing) {
      if (existing.taskId !== taskId) throw conflict("agent run draft belongs to another task");
      return { draft: existing, replayed: true };
    }
    if (!AGENT_DRAFT_ALLOWED_STATUSES.has(task.status)) {
      throw conflict(`cannot ingest Agent content in status ${task.status}`, "INVALID_TRANSITION");
    }
    if (task.taskRevision !== expectedTaskVersion.taskRevision
      || task.executionSpecHash !== expectedTaskVersion.executionSpecHash) {
      throw conflict(
        "Agent content no longer matches the current Task revision",
        "STALE_STATE",
      );
    }
    const last = await latestDraft(tx, taskId);
    const draft = buildDraft(
      taskId,
      (last?.version ?? 0) + 1,
      { ...input, source: "AGENT_GENERATED" },
      actorId,
      agentRunId,
    );
    await insertDraft(tx, draft);
    return { draft, replayed: false };
  });
}

export async function addDraft(
  db: Db,
  taskId: string,
  input: AddDraftInput,
  actorId: string,
): Promise<ContentDraft> {
  validateDraftInput(input);

  return db.withTransaction(async (tx) => {
    const task = await getTaskForUpdate(tx, taskId);
    if (!task) throw notFound(`task ${taskId} not found`);

    const last = await latestDraft(tx, taskId);
    const version = (last?.version ?? 0) + 1;
    const draft = buildDraft(taskId, version, input, actorId);
    await insertDraft(tx, draft);
    return draft;
  });
}

/** A human edit is a task-definition mutation, not only an attached row.
 * The new execution spec embeds the immutable draft body/hash and the new
 * revision receives verified CONTENT_DRAFT evidence, so prior approval is
 * retained as history but cannot authorize this changed version. */
export async function addDraftRevision(
  db: Db,
  taskId: string,
  input: AddDraftRevisionInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  validateDraftInput(input);
  if (input.source !== "HUMAN_EDIT") {
    throw badRequest("draft revisions require source HUMAN_EDIT");
  }
  const fingerprint = requestFingerprint({
    body: input.body, cta_type: input.cta_type ?? null, cta_url: input.cta_url ?? null,
    media: input.media ?? [], source: input.source, feedback: input.feedback ?? null,
  });
  return mutateTask(db, taskId, input.idempotency_key, fingerprint, input.expected_state_version,
    async (task, tx) => {
      if (await findActiveGbpContentRunByTask(tx, {
        stage: "GBP_POST_CONTENT", taskId: task.id, merchantId: task.merchantId, locationId: task.locationId,
      })) {
        throw conflict("cannot edit a GBP Post draft while content generation is active", "CONTENT_RUN_ACTIVE");
      }
      if (!CONTENT_REVISION_ALLOWED_STATUSES.has(task.status)) {
        throw conflict(`cannot edit content in status ${task.status}`, "INVALID_TRANSITION");
      }
      let mediaSourceAgentRunId: string | null = null;
      if (task.taskType === "GBP_POST") {
        try {
          const resolved = await validateGbpDraftForTask(tx, task, {
            body: input.body,
            ctaType: input.cta_type ?? null,
            ctaUrl: input.cta_url ?? null,
            media: input.media ?? [],
          });
          mediaSourceAgentRunId = resolved.sourceAgentRunId;
        } catch (error) {
          if (error instanceof ApiDraftMediaError) {
            throw conflict(error.message, "DRAFT_MEDIA_INVALID");
          }
          throw badRequest(error instanceof Error ? error.message : "invalid GBP Post draft");
        }
      }
      const last = await latestDraft(tx, taskId);
      const draft = buildDraft(taskId, (last?.version ?? 0) + 1, input, actorId, null, mediaSourceAgentRunId);
      await insertDraft(tx, draft);
      let original: unknown;
      try { original = JSON.parse(task.executionSpec); } catch { original = task.executionSpec; }
      const executionSpec = JSON.stringify(
        original !== null && typeof original === "object" && !Array.isArray(original)
          ? { ...(original as Record<string, unknown>), content_draft: specBlockForDraft(draft) }
          : { execution: original, content_draft: specBlockForDraft(draft) },
      );
      const revision: TaskDefinitionRecord = {
        ...task.revisions.at(-1)!, revision: task.taskRevision + 1,
        executionSpec, executionSpecHash: executionSpecHash(executionSpec), createdBy: actorId, createdAt: nowIso(),
      };
      const evidence: EvidenceRefRecord = {
        id: crypto.randomUUID(), taskRevision: revision.revision, type: "CONTENT_DRAFT",
        sourceRef: `draft:${taskId}:v${draft.version}`, sha256: draft.sha256,
        capturedAt: draft.createdAt, verificationStatus: "VERIFIED", requirementKey: "CONTENT_DRAFT",
        createdBy: actorId, createdAt: nowIso(),
      };
      const reusableEvidence: EvidenceRefRecord[] = task.evidenceRefs
        .filter((item) => item.taskRevision === task.taskRevision && item.type !== "CONTENT_DRAFT" && item.verificationStatus === "VERIFIED")
        .map((item) => ({
          ...item, id: crypto.randomUUID(), taskRevision: revision.revision,
          createdBy: actorId, createdAt: nowIso(), reusedFromEvidenceId: item.id,
        }));
      const updated: Task = {
        ...task, executionSpec, executionSpecHash: revision.executionSpecHash,
        taskRevision: revision.revision, revisions: [...task.revisions, revision],
        evidenceRefs: [...task.evidenceRefs, evidence, ...reusableEvidence], stateVersion: task.stateVersion + 1, updatedAt: nowIso(),
      };
      const derived = await reevaluate(tx, updated);
      updated.status = derived.status;
      updated.evidenceState = derived.evidenceState;
      updated.events = [...task.events, buildEvent("CONTENT_DRAFT_REVISED", updated.taskRevision, updated.stateVersion, actorId, {
        fromStatus: task.status, toStatus: updated.status, referenceId: draft.id,
      })];
      return updated;
    });
}

export async function draftsView(db: Db, taskId: string): Promise<ContentDraft[]> {
  const task = await getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  return listDraftsByTask(db, taskId);
}

export interface DraftMediaPreview {
  deliverable_id: string;
  sha256: string;
  download_path: string;
  alt_text: string;
  origin: "AI_GENERATED" | "OPERATOR_UPLOAD";
}

interface CanonicalMediaRef {
  schema_version: "seo_ops.media_ref.v1";
  deliverable_id: string;
  sha256: string;
  alt_text: string;
}

function parseCanonicalMediaRef(raw: string): CanonicalMediaRef | null {
  let value: unknown;
  try {
    if (canonicalize(raw) !== raw) return null;
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "alt_text,deliverable_id,schema_version,sha256") return null;
  if (record.schema_version !== "seo_ops.media_ref.v1"
    || typeof record.deliverable_id !== "string" || record.deliverable_id === ""
    || typeof record.sha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(record.sha256)
    || typeof record.alt_text !== "string" || record.alt_text.trim() === "") return null;
  return record as unknown as CanonicalMediaRef;
}

class ApiDraftMediaError extends Error {}

function hasImageSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    const png = [137, 80, 78, 71, 13, 10, 26, 10];
    return bytes.byteLength >= png.length && png.every((value, index) => bytes[index] === value);
  }
  return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Resolves the canonical local media reference from server state and verifies
 * exact Task/Run/tenant ownership plus the bytes currently on disk. */
async function validateGbpDraftForTask(
  db: Db,
  task: Task,
  draft: {
    body: string;
    ctaType: string | null;
    ctaUrl: string | null;
    media: string[];
    agentRunId?: string | null;
    mediaSourceAgentRunId?: string | null;
  },
): Promise<{ sourceAgentRunId: string }> {
  let acceptedContext: unknown;
  try { acceptedContext = JSON.parse(task.executionSpec); } catch { acceptedContext = task.executionSpec; }
  validateGbpPostTextAndCta(draft, acceptedContext);
  if (draft.media.length !== 1) {
    throw new ApiDraftMediaError("GBP Post drafts require exactly one canonical image reference");
  }
  const ref = parseCanonicalMediaRef(draft.media[0]!);
  if (!ref) throw new ApiDraftMediaError("GBP Post draft media must be one canonical seo_ops.media_ref.v1");
  const deliverable = await getDeliverable(db, ref.deliverable_id);
  const run = deliverable ? await getAgentRun(db, deliverable.runId) : null;
  if (!deliverable || !run
    || (draft.agentRunId != null && run.id !== draft.agentRunId)
    || (draft.mediaSourceAgentRunId != null && run.id !== draft.mediaSourceAgentRunId)
    || run.taskId !== task.id
    || run.stage !== "GBP_POST_CONTENT"
    || run.merchantId !== task.merchantId
    || run.locationId !== task.locationId
    || (deliverable.kind !== "ATTACHMENT" && deliverable.kind !== "MANUAL")
    || deliverable.localPath === null
    || deliverable.sha256 !== ref.sha256
    || (deliverable.contentType !== "image/png" && deliverable.contentType !== "image/jpeg")) {
    throw new ApiDraftMediaError("draft media does not belong to this exact Task-linked GBP Run");
  }
  if (draft.agentRunId == null && deliverable.kind !== "MANUAL") {
    const generatedOwner = (await listDraftsByTask(db, task.id)).find((item) =>
      item.agentRunId === run.id && item.media.includes(draft.media[0]!),
    );
    if (!generatedOwner) {
      throw new ApiDraftMediaError("GBP Post human revisions must preserve a server-issued canonical media reference");
    }
  }
  let bytes: Uint8Array;
  try { bytes = await fs.readFile(deliverable.localPath); } catch {
    throw new ApiDraftMediaError("draft media local bytes are unavailable");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > GBP_POST_IMAGE_MAX_BYTES
    || !hasImageSignature(bytes, deliverable.contentType)
    || sha256HashBytes(bytes) !== ref.sha256
    || deliverable.size !== bytes.byteLength) {
    throw new ApiDraftMediaError("draft media local bytes do not match the verified image record");
  }
  return { sourceAgentRunId: run.id };
}

async function mediaPreviewForRef(
  db: Db,
  task: Task,
  draft: ContentDraft,
  raw: string,
): Promise<DraftMediaPreview | null> {
  const ref = parseCanonicalMediaRef(raw);
  const mediaSourceRunId = draft.source === "HUMAN_EDIT"
    ? draft.agentRunId === null ? draft.mediaSourceAgentRunId : null
    : draft.mediaSourceAgentRunId === null ? draft.agentRunId : null;
  if (!ref || !mediaSourceRunId) return null;
  const [deliverable, run] = await Promise.all([
    getDeliverable(db, ref.deliverable_id),
    getAgentRun(db, mediaSourceRunId),
  ]);
  if (!deliverable || !run
    || deliverable.runId !== mediaSourceRunId
    || run.id !== mediaSourceRunId
    || run.taskId !== task.id
    || run.stage !== "GBP_POST_CONTENT"
    || run.merchantId !== task.merchantId
    || run.locationId !== task.locationId
    || (deliverable.kind !== "ATTACHMENT" && deliverable.kind !== "MANUAL")
    || deliverable.localPath === null
    || deliverable.sha256 !== ref.sha256
    || (deliverable.contentType !== "image/png" && deliverable.contentType !== "image/jpeg")) return null;
  return {
    deliverable_id: deliverable.id,
    sha256: ref.sha256,
    download_path: `/api/seo-ops/deliverables/${encodeURIComponent(deliverable.id)}/download`,
    alt_text: ref.alt_text,
    origin: deliverable.kind === "MANUAL" ? "OPERATOR_UPLOAD" : "AI_GENERATED",
  };
}

export async function mediaPreviewsForDraft(
  db: Db,
  task: Task,
  draft: ContentDraft,
): Promise<DraftMediaPreview[]> {
  const previews = await Promise.all(draft.media.map((raw) => mediaPreviewForRef(db, task, draft, raw)));
  return previews.filter((item): item is DraftMediaPreview => item !== null);
}

export interface FinalizeDraftInput {
  version: number;
  expected_state_version: number;
  idempotency_key: string;
}

/** Finalization is a definition mutation. The selected draft is reloaded under
 * the Task lock and embedded byte-for-byte into a new revision so approval
 * binds body, CTA, deliverable identity, and image SHA. */
export function finalizeDraftRevision(
  db: Db,
  taskId: string,
  input: FinalizeDraftInput,
  actorId: string,
): Promise<{ task: Task; replayed: boolean }> {
  const fingerprint = requestFingerprint({ draft_version: input.version });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    async (task, tx) => {
      if (await findActiveGbpContentRunByTask(tx, {
        stage: "GBP_POST_CONTENT", taskId: task.id, merchantId: task.merchantId, locationId: task.locationId,
      })) {
        throw conflict("cannot finalize a GBP Post draft while content generation is active", "CONTENT_RUN_ACTIVE");
      }
      if (!canAppendEvidence(task.status)) {
        throw conflict(`cannot finalize content in status ${task.status}`, "INVALID_TRANSITION");
      }
      const draft = await getDraftByTaskVersion(tx, task.id, input.version);
      if (!draft) throw notFound(`draft v${input.version} not found`);
      if (task.taskType === "GBP_POST") {
        try {
          await validateGbpDraftForTask(tx, task, draft);
        } catch (error) {
          throw conflict(error instanceof Error ? error.message : "invalid GBP Post draft", "DRAFT_MEDIA_INVALID");
        }
      }
      let original: unknown;
      try { original = JSON.parse(task.executionSpec); } catch { original = task.executionSpec; }
      const executionSpec = JSON.stringify(
        original !== null && typeof original === "object" && !Array.isArray(original)
          ? { ...(original as Record<string, unknown>), content_draft: specBlockForDraft(draft) }
          : { execution: original, content_draft: specBlockForDraft(draft) },
      );
      const createdAt = nowIso();
      const revision: TaskDefinitionRecord = {
        ...task.revisions.at(-1)!,
        revision: task.taskRevision + 1,
        executionSpec,
        executionSpecHash: executionSpecHash(executionSpec),
        createdBy: actorId,
        createdAt,
      };
      const evidence: EvidenceRefRecord = {
        id: crypto.randomUUID(), taskRevision: revision.revision, type: "CONTENT_DRAFT",
        sourceRef: `draft:${taskId}:v${draft.version}`, sha256: draft.sha256,
        capturedAt: draft.createdAt, verificationStatus: "VERIFIED", requirementKey: "CONTENT_DRAFT",
        createdBy: actorId, createdAt,
      };
      const reusableEvidence = task.evidenceRefs
        .filter((item) => item.taskRevision === task.taskRevision
          && item.type !== "CONTENT_DRAFT" && item.verificationStatus === "VERIFIED")
        .map((item) => ({
          ...item, id: crypto.randomUUID(), taskRevision: revision.revision,
          createdBy: actorId, createdAt, reusedFromEvidenceId: item.id,
        }));
      const updated: Task = {
        ...task,
        executionSpec,
        executionSpecHash: revision.executionSpecHash,
        taskRevision: revision.revision,
        revisions: [...task.revisions, revision],
        evidenceRefs: [...task.evidenceRefs, evidence, ...reusableEvidence],
        stateVersion: task.stateVersion + 1,
        updatedAt: createdAt,
      };
      const derived = await reevaluate(tx, updated);
      updated.status = derived.status;
      updated.evidenceState = derived.evidenceState;
      updated.events = [...task.events, buildEvent(
        "CONTENT_DRAFT_FINALIZED", updated.taskRevision, updated.stateVersion, actorId,
        { fromStatus: task.status, toStatus: updated.status, referenceId: draft.id },
      )];
      return updated;
    },
  );
}

/** 定稿引用：写进任务修订版 execution_spec 的内容块。审批哈希由 taskService
 * 对整个 spec 计算，这里只负责给出稳定的引用结构。 */
export function specBlockForDraft(draft: ContentDraft): Record<string, unknown> {
  return {
    draft_version: draft.version,
    draft_sha256: draft.sha256,
    body: draft.body,
    cta_type: draft.ctaType,
    cta_url: draft.ctaUrl,
    media: draft.media,
  };
}

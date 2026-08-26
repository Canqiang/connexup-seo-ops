import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { getTask, getTaskForUpdate } from "../repos/taskRepo.js";
import type { EvidenceRefRecord, Task, TaskDefinitionRecord } from "../repos/taskTypes.js";
import { executionSpecHash, requestFingerprint } from "../domain/hashing.js";
import { buildEvent, mutateTask, reevaluate } from "./taskService.js";
import {
  insertDraft,
  getDraftByAgentRunId,
  latestDraft,
  listDraftsByTask,
  type ContentDraft,
} from "../repos/draftRepo.js";

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
): ContentDraft {
  const media = input.media ?? [];
  return {
    id: crypto.randomUUID(), taskId, agentRunId, version, body: input.body,
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
  body: string,
  actorId: string,
): Promise<{ draft: ContentDraft; replayed: boolean }> {
  validateDraftInput({ body, source: "AGENT_GENERATED" });
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
    const last = await latestDraft(tx, taskId);
    const draft = buildDraft(
      taskId,
      (last?.version ?? 0) + 1,
      { body, source: "AGENT_GENERATED" },
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
      if (!CONTENT_REVISION_ALLOWED_STATUSES.has(task.status)) {
        throw conflict(`cannot edit content in status ${task.status}`, "INVALID_TRANSITION");
      }
      const last = await latestDraft(tx, taskId);
      const draft = buildDraft(taskId, (last?.version ?? 0) + 1, input, actorId);
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

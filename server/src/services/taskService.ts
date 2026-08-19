import crypto from "node:crypto";
import type { Db } from "../db/connection.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import {
  canonicalize,
  executionSpecHash,
  requestFingerprint,
} from "../domain/hashing.js";
import {
  canAppendEvidence,
  canCreateRevision,
  decideApproval,
  evaluate,
} from "../domain/stateMachine.js";
import {
  TASK_IMPACTS,
  TASK_PRIORITIES,
  type ApprovalAction,
  type EvidenceVerification,
  type TaskImpact,
  type TaskPriority,
} from "../domain/enums.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { getLocation } from "../repos/locationRepo.js";
import {
  findTaskByIdempotencyKey,
  getTask,
  insertTask,
  updateTaskCas,
} from "../repos/taskRepo.js";
import type {
  ConversationLinkRecord,
  EvidenceRefRecord,
  Task,
  TaskDefinitionRecord,
  TaskEventRecord,
} from "../repos/taskTypes.js";
import { requireIdempotencyKey, resolveIdempotentCreate } from "./merchantService.js";

/** Fixed actor until real auth exists (matches /api/auth/me stub). */
export const ACTOR_ID = "local-dev";

function nowIso(): string {
  return new Date().toISOString();
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw badRequest(`${field} is required and must be a non-empty string`);
  }
  return value;
}

function requireIso(value: string, field: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw badRequest(`${field} must be an ISO-8601 timestamp`);
  }
  return value;
}

export interface DefinitionInput {
  title: string;
  task_type: string;
  source: string;
  priority: string;
  impact: string;
  owner_id?: string;
  due_at?: string;
  execution_spec: string;
  required_evidence_types: string[];
  conversation_id?: string;
}

function validateDefinition(def: DefinitionInput): void {
  requireNonEmpty(def.title, "definition.title");
  requireNonEmpty(def.task_type, "definition.task_type");
  requireNonEmpty(def.source, "definition.source");
  requireNonEmpty(def.execution_spec, "definition.execution_spec");
  try {
    canonicalize(def.execution_spec);
  } catch {
    // Without this the failure surfaces later as a 500 from executionSpecHash.
    throw badRequest("definition.execution_spec must be valid JSON");
  }
  if (!TASK_PRIORITIES.includes(def.priority as TaskPriority)) {
    throw badRequest(`definition.priority must be one of ${TASK_PRIORITIES.join("/")}`);
  }
  if (!TASK_IMPACTS.includes(def.impact as TaskImpact)) {
    throw badRequest(`definition.impact must be one of ${TASK_IMPACTS.join("/")}`);
  }
  if (def.owner_id !== undefined && typeof def.owner_id !== "string") {
    throw badRequest("definition.owner_id must be a string");
  }
  if (def.due_at !== undefined) {
    if (typeof def.due_at !== "string") {
      throw badRequest("definition.due_at must be an ISO-8601 string");
    }
    requireIso(def.due_at, "definition.due_at");
  }
  if (
    !Array.isArray(def.required_evidence_types) ||
    def.required_evidence_types.some((t) => typeof t !== "string" || t.trim() === "")
  ) {
    throw badRequest(
      "definition.required_evidence_types must be an array of non-empty strings",
    );
  }
}

function buildRevision(
  def: DefinitionInput,
  revision: number,
  createdAt: string,
): TaskDefinitionRecord {
  return {
    revision,
    title: def.title,
    taskType: def.task_type,
    source: def.source,
    priority: def.priority as TaskPriority,
    impact: def.impact as TaskImpact,
    ownerId: def.owner_id ?? null,
    dueAt: def.due_at ?? null,
    executionSpec: def.execution_spec,
    executionSpecHash: executionSpecHash(def.execution_spec),
    requiredEvidenceTypes: def.required_evidence_types,
    createdBy: ACTOR_ID,
    createdAt,
  };
}

export function buildEvent(
  type: string,
  taskRevision: number,
  resultingStateVersion: number,
  options: {
    fromStatus?: Task["status"];
    toStatus?: Task["status"];
    referenceId?: string;
  } = {},
): TaskEventRecord {
  return {
    id: crypto.randomUUID(),
    type,
    actorId: ACTOR_ID,
    ...(options.fromStatus ? { fromStatus: options.fromStatus } : {}),
    ...(options.toStatus ? { toStatus: options.toStatus } : {}),
    taskRevision,
    resultingStateVersion,
    ...(options.referenceId ? { referenceId: options.referenceId } : {}),
    occurredAt: nowIso(),
  };
}

function locationReadiness(db: Db, task: Task): string | null {
  if (!task.locationId) return null;
  return getLocation(db, task.locationId)?.readinessStatus ?? null;
}

export function reevaluate(db: Db, task: Task): { status: Task["status"]; evidenceState: Task["evidenceState"] } {
  return evaluate(
    task.requiredEvidenceTypes,
    task.evidenceRefs,
    task.taskRevision,
    locationReadiness(db, task),
  );
}

/** Idempotency + optimistic-lock wrapper shared by all task sub-mutations. */
function mutateTask(
  db: Db,
  taskId: string,
  idempotencyKey: string,
  fingerprint: string,
  expectedStateVersion: number,
  mutate: (task: Task) => Task,
): { task: Task; replayed: boolean } {
  requireIdempotencyKey(idempotencyKey, "idempotency_key");
  return db.transaction(() => {
    const task = getTask(db, taskId);
    if (!task) throw notFound(`task ${taskId} not found`);

    const seen = task.mutationKeys[idempotencyKey];
    if (seen !== undefined) {
      if (seen === fingerprint) return { task, replayed: true };
      throw conflict(
        "idempotency key already used with a different request body",
        "IDEMPOTENCY_CONFLICT",
      );
    }
    if (task.stateVersion !== expectedStateVersion) {
      throw conflict(
        `expected_state_version ${expectedStateVersion} is stale (current ${task.stateVersion})`,
        "STALE_STATE",
      );
    }

    const updated = mutate(task);
    updated.mutationKeys[idempotencyKey] = fingerprint;
    if (!updateTaskCas(db, updated, expectedStateVersion)) {
      const fresh = getTask(db, taskId);
      if (fresh && fresh.mutationKeys[idempotencyKey] === fingerprint) {
        return { task: fresh, replayed: true };
      }
      throw conflict(
        `task state changed concurrently (expected state_version ${expectedStateVersion})`,
        "STALE_STATE",
      );
    }
    return { task: updated, replayed: false };
  })();
}

/** Server-initiated mutation (no client expected_state_version): re-read the
 * freshest version and retry the CAS on STALE_STATE. Replay semantics still
 * come from mutationKeys — a crash between task commit and caller bookkeeping
 * replays instead of duplicating. */
export function mutateTaskRetry(
  db: Db,
  taskId: string,
  idempotencyKey: string,
  fingerprint: string,
  mutate: (task: Task) => Task,
  attempts = 5,
): { task: Task; replayed: boolean } {
  let lastStale: ApiError | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = getTask(db, taskId);
    if (!current) throw notFound(`task ${taskId} not found`);
    try {
      return mutateTask(
        db,
        taskId,
        idempotencyKey,
        fingerprint,
        current.stateVersion,
        mutate,
      );
    } catch (err) {
      if (err instanceof ApiError && err.code === "STALE_STATE") {
        lastStale = err;
        continue;
      }
      throw err;
    }
  }
  throw lastStale ?? conflict("task state contention", "STALE_STATE");
}

export interface CreateTaskInput {
  merchant_id: string;
  location_id?: string;
  definition: DefinitionInput;
  idempotency_key: string;
}

export function createTask(db: Db, input: CreateTaskInput): { task: Task; replayed: boolean } {
  const key = requireIdempotencyKey(input.idempotency_key, "idempotency_key");
  validateDefinition(input.definition);

  const fingerprint = requestFingerprint({
    merchant_id: input.merchant_id,
    location_id: input.location_id ?? null,
    definition: input.definition,
  });

  return db.transaction(() => {
    const existing = findTaskByIdempotencyKey(db, key);
    const replay = resolveIdempotentCreate(existing, fingerprint);
    if (replay) return { task: replay, replayed: true };

    const merchant = getMerchant(db, input.merchant_id);
    if (!merchant) throw notFound(`merchant ${input.merchant_id} not found`);
    let locationId: string | null = null;
    if (input.location_id !== undefined) {
      const location = getLocation(db, input.location_id);
      if (!location) throw notFound(`location ${input.location_id} not found`);
      if (location.merchantId !== merchant.id) {
        throw badRequest(`location ${input.location_id} belongs to a different merchant`);
      }
      locationId = location.id;
    }

    const createdAt = nowIso();
    const revision = buildRevision(input.definition, 1, createdAt);
    const conversationLinks: ConversationLinkRecord[] = [];
    if (input.definition.conversation_id) {
      conversationLinks.push({
        conversationId: input.definition.conversation_id,
        relationship: "ORIGINATING_DRAFT",
        linkedBy: ACTOR_ID,
        linkedAt: createdAt,
      });
    }

    const base: Task = {
      id: crypto.randomUUID(),
      merchantId: merchant.id,
      locationId,
      taskType: revision.taskType,
      source: revision.source,
      priority: revision.priority,
      impact: revision.impact,
      ownerId: revision.ownerId,
      dueAt: revision.dueAt,
      status: "NEEDS_INPUT",
      evidenceState: "NONE",
      taskRevision: 1,
      stateVersion: 1,
      title: revision.title,
      executionSpec: revision.executionSpec,
      executionSpecHash: revision.executionSpecHash,
      requiredEvidenceTypes: revision.requiredEvidenceTypes,
      revisions: [revision],
      evidenceRefs: [],
      approvalDecisions: [],
      events: [],
      conversationLinks,
      agentRunLinks: [],
      mutationKeys: {},
      creationIdempotencyKey: key,
      requestFingerprint: fingerprint,
      createdBy: ACTOR_ID,
      createdAt,
      updatedAt: createdAt,
    };
    const derived = evaluate(
      base.requiredEvidenceTypes,
      [],
      1,
      locationId ? (getLocation(db, locationId)?.readinessStatus ?? null) : null,
    );
    base.status = derived.status;
    base.evidenceState = derived.evidenceState;
    base.events = [
      buildEvent("TASK_CREATED", 1, 1, { toStatus: derived.status }),
    ];

    insertTask(db, base);
    return { task: base, replayed: false };
  })();
}

export interface CreateRevisionInput {
  definition: DefinitionInput;
  expected_state_version: number;
  idempotency_key: string;
}

export function createRevision(
  db: Db,
  taskId: string,
  input: CreateRevisionInput,
): { task: Task; replayed: boolean } {
  validateDefinition(input.definition);
  const fingerprint = requestFingerprint({ definition: input.definition });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      if (!canCreateRevision(task.status)) {
        throw conflict(
          `cannot revise a task in status ${task.status} (revoke approval first)`,
          "INVALID_TRANSITION",
        );
      }
      const revision = buildRevision(input.definition, task.taskRevision + 1, nowIso());
      const updated: Task = {
        ...task,
        taskType: revision.taskType,
        source: revision.source,
        priority: revision.priority,
        impact: revision.impact,
        ownerId: revision.ownerId,
        dueAt: revision.dueAt,
        title: revision.title,
        executionSpec: revision.executionSpec,
        executionSpecHash: revision.executionSpecHash,
        requiredEvidenceTypes: revision.requiredEvidenceTypes,
        taskRevision: revision.revision,
        revisions: [...task.revisions, revision],
        stateVersion: task.stateVersion + 1,
        updatedAt: nowIso(),
      };
      const derived = reevaluate(db, updated);
      updated.status = derived.status;
      updated.evidenceState = derived.evidenceState;
      updated.events = [
        ...task.events,
        buildEvent("TASK_REVISED", updated.taskRevision, updated.stateVersion, {
          fromStatus: task.status,
          toStatus: updated.status,
        }),
      ];
      return updated;
    },
  );
}

export interface AppendEvidenceInput {
  type: string;
  artifact_id?: string;
  file_id?: string;
  source_ref?: string;
  sha256?: string;
  captured_at: string;
  verification_status: string;
  requirement_key: string;
  expected_state_version: number;
  idempotency_key: string;
}

export function appendEvidence(
  db: Db,
  taskId: string,
  input: AppendEvidenceInput,
): { task: Task; replayed: boolean } {
  requireNonEmpty(input.type, "type");
  requireNonEmpty(input.requirement_key, "requirement_key");
  requireIso(input.captured_at, "captured_at");
  if (!["UNVERIFIED", "VERIFIED", "UNVERIFIABLE"].includes(input.verification_status)) {
    throw badRequest(
      `verification_status must be one of UNVERIFIED/VERIFIED/UNVERIFIABLE`,
    );
  }
  const sources = [input.artifact_id, input.file_id, input.source_ref].filter(
    (v) => v !== undefined && v !== null && v !== "",
  );
  if (sources.length !== 1) {
    throw badRequest(
      `exactly one of artifact_id/file_id/source_ref is required, got ${sources.length}`,
    );
  }
  const byteBacked = input.artifact_id ?? input.file_id;
  if (byteBacked !== undefined && (input.sha256 === undefined || input.sha256.trim() === "")) {
    throw badRequest(`sha256 is required for byte-backed evidence (artifact_id/file_id)`);
  }

  const fingerprint = requestFingerprint({
    type: input.type,
    artifact_id: input.artifact_id ?? null,
    file_id: input.file_id ?? null,
    source_ref: input.source_ref ?? null,
    sha256: input.sha256 ?? null,
    captured_at: input.captured_at,
    verification_status: input.verification_status,
    requirement_key: input.requirement_key,
  });

  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      if (!canAppendEvidence(task.status)) {
        throw conflict(
          `cannot append evidence to a task in status ${task.status}`,
          "INVALID_TRANSITION",
        );
      }
      const evidence: EvidenceRefRecord = {
        id: crypto.randomUUID(),
        taskRevision: task.taskRevision,
        type: input.type,
        ...(input.artifact_id ? { artifactId: input.artifact_id } : {}),
        ...(input.file_id ? { fileId: input.file_id } : {}),
        ...(input.source_ref ? { sourceRef: input.source_ref } : {}),
        ...(input.sha256 ? { sha256: input.sha256 } : {}),
        capturedAt: input.captured_at,
        verificationStatus: input.verification_status as EvidenceVerification,
        requirementKey: input.requirement_key,
        createdBy: ACTOR_ID,
        createdAt: nowIso(),
      };
      const updated: Task = {
        ...task,
        evidenceRefs: [...task.evidenceRefs, evidence],
        stateVersion: task.stateVersion + 1,
        updatedAt: nowIso(),
      };
      const derived = reevaluate(db, updated);
      updated.status = derived.status;
      updated.evidenceState = derived.evidenceState;
      updated.events = [
        ...task.events,
        buildEvent("EVIDENCE_APPENDED", updated.taskRevision, updated.stateVersion, {
          fromStatus: task.status,
          toStatus: updated.status,
          referenceId: evidence.id,
        }),
      ];
      return updated;
    },
  );
}

export interface LinkConversationInput {
  conversation_id: string;
  expected_state_version: number;
  idempotency_key: string;
}

export function linkConversation(
  db: Db,
  taskId: string,
  input: LinkConversationInput,
): { task: Task; replayed: boolean } {
  requireNonEmpty(input.conversation_id, "conversation_id");
  const fingerprint = requestFingerprint({ conversation_id: input.conversation_id });
  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      const link: ConversationLinkRecord = {
        conversationId: input.conversation_id,
        relationship: "TASK_CHAT",
        linkedBy: ACTOR_ID,
        linkedAt: nowIso(),
      };
      const updated: Task = {
        ...task,
        conversationLinks: [...task.conversationLinks, link],
        stateVersion: task.stateVersion + 1,
        updatedAt: nowIso(),
      };
      updated.events = [
        ...task.events,
        buildEvent("CONVERSATION_LINKED", updated.taskRevision, updated.stateVersion),
      ];
      return updated;
    },
  );
}

export interface ApprovalPreviewInput {
  task_revision: number;
  expected_state_version: number;
}

export interface ApprovalPreviewResult {
  reviewable: boolean;
  blockers: string[];
  task_revision: number;
  state_version: number;
  execution_spec_hash: string;
  evidence_state: Task["evidenceState"];
  current_status: Task["status"];
}

/** Non-mutating re-check of whether the task can be approved right now. */
export function approvalPreview(
  db: Db,
  taskId: string,
  input: ApprovalPreviewInput,
): ApprovalPreviewResult {
  const task = getTask(db, taskId);
  if (!task) throw notFound(`task ${taskId} not found`);
  if (task.taskRevision !== input.task_revision) {
    throw conflict(
      `task_revision ${input.task_revision} is stale (current ${task.taskRevision})`,
      "STALE_STATE",
    );
  }
  if (task.stateVersion !== input.expected_state_version) {
    throw conflict(
      `expected_state_version ${input.expected_state_version} is stale (current ${task.stateVersion})`,
      "STALE_STATE",
    );
  }

  const { evidenceState } = reevaluate(db, task);
  const blockers: string[] = [];
  if (task.status !== "READY_FOR_APPROVAL") {
    blockers.push(`status_must_be_ready_for_approval (current ${task.status})`);
  }
  if (evidenceState !== "VERIFIED") {
    blockers.push(`evidence_not_verified (current ${evidenceState})`);
  }
  const readiness = locationReadiness(db, task);
  if (readiness !== null && readiness !== "READY") {
    blockers.push(`location_not_ready (current ${readiness})`);
  }
  return {
    reviewable: blockers.length === 0,
    blockers,
    task_revision: task.taskRevision,
    state_version: task.stateVersion,
    execution_spec_hash: task.executionSpecHash,
    evidence_state: evidenceState,
    current_status: task.status,
  };
}

export interface ApprovalDecisionInput {
  decision: string;
  reason?: string;
  task_revision: number;
  execution_spec_hash: string;
  expected_state_version: number;
  idempotency_key: string;
}

export function approvalDecision(
  db: Db,
  taskId: string,
  input: ApprovalDecisionInput,
): { task: Task; replayed: boolean } {
  const action = input.decision as ApprovalAction;
  if (!["APPROVE", "REJECT", "REVOKE"].includes(action)) {
    throw badRequest(`decision must be one of APPROVE/REJECT/REVOKE`);
  }
  if ((action === "REJECT" || action === "REVOKE") && (input.reason ?? "").trim() === "") {
    throw badRequest(`reason is required for ${action} decisions`);
  }

  const fingerprint = requestFingerprint({
    decision: input.decision,
    reason: input.reason ?? null,
    task_revision: input.task_revision,
    execution_spec_hash: input.execution_spec_hash,
  });

  return mutateTask(
    db,
    taskId,
    input.idempotency_key,
    fingerprint,
    input.expected_state_version,
    (task) => {
      if (task.taskRevision !== input.task_revision) {
        throw conflict(
          `task_revision ${input.task_revision} is stale (current ${task.taskRevision})`,
          "STALE_STATE",
        );
      }
      if (task.executionSpecHash !== input.execution_spec_hash) {
        throw conflict(
          `execution_spec_hash does not match the current revision's spec`,
          "STALE_STATE",
        );
      }
      const next = decideApproval(task.status, action);
      if (next === null) {
        throw conflict(
          `cannot ${action} a task in status ${task.status}`,
          "INVALID_TRANSITION",
        );
      }
      const resultingVersion = task.stateVersion + 1;
      const decision = {
        id: crypto.randomUUID(),
        decision: action,
        ...(input.reason ? { reason: input.reason } : {}),
        taskRevision: task.taskRevision,
        executionSpecHash: task.executionSpecHash,
        expectedStateVersion: input.expected_state_version,
        resultingStateVersion: resultingVersion,
        actorId: ACTOR_ID,
        decidedAt: nowIso(),
      };
      const eventType =
        action === "APPROVE" ? "TASK_APPROVED"
        : action === "REJECT" ? "TASK_REJECTED"
        : "APPROVAL_REVOKED";
      return {
        ...task,
        status: next,
        approvalDecisions: [...task.approvalDecisions, decision],
        events: [
          ...task.events,
          buildEvent(eventType, task.taskRevision, resultingVersion, {
            fromStatus: task.status,
            toStatus: next,
            referenceId: decision.id,
          }),
        ],
        stateVersion: resultingVersion,
        updatedAt: nowIso(),
      } satisfies Task;
    },
  );
}

import type { Db } from "../db/connection.js";
import type {
  AgentRunLinkRecord,
  ApprovalDecisionRecord,
  ConversationLinkRecord,
  EvidenceRefRecord,
  Task,
  TaskDefinitionRecord,
  TaskEventRecord,
} from "./taskTypes.js";

interface TaskRow {
  id: string;
  merchant_id: string;
  location_id: string | null;
  task_type: string;
  source: string;
  priority: string;
  impact: string;
  owner_id: string | null;
  due_at: string | null;
  status: string;
  evidence_state: string;
  task_revision: number;
  state_version: number;
  title: string;
  execution_spec: string;
  execution_spec_hash: string;
  required_evidence_types: string;
  revisions: string;
  evidence_refs: string;
  approval_decisions: string;
  events: string;
  conversation_links: string;
  agent_run_links: string;
  mutation_keys: string;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    taskType: row.task_type,
    source: row.source,
    priority: row.priority as Task["priority"],
    impact: row.impact as Task["impact"],
    ownerId: row.owner_id,
    dueAt: row.due_at,
    status: row.status as Task["status"],
    evidenceState: row.evidence_state as Task["evidenceState"],
    taskRevision: row.task_revision,
    stateVersion: row.state_version,
    title: row.title,
    executionSpec: row.execution_spec,
    executionSpecHash: row.execution_spec_hash,
    requiredEvidenceTypes: JSON.parse(row.required_evidence_types || "[]"),
    revisions: JSON.parse(row.revisions || "[]") as TaskDefinitionRecord[],
    evidenceRefs: JSON.parse(row.evidence_refs || "[]") as EvidenceRefRecord[],
    approvalDecisions: JSON.parse(
      row.approval_decisions || "[]",
    ) as ApprovalDecisionRecord[],
    events: JSON.parse(row.events || "[]") as TaskEventRecord[],
    conversationLinks: JSON.parse(
      row.conversation_links || "[]",
    ) as ConversationLinkRecord[],
    agentRunLinks: JSON.parse(
      row.agent_run_links || "[]",
    ) as AgentRunLinkRecord[],
    mutationKeys: JSON.parse(row.mutation_keys || "{}"),
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INSERT_SQL = `INSERT INTO seo_tasks
  (id, merchant_id, location_id, task_type, source, priority, impact, owner_id, due_at,
   status, evidence_state, task_revision, state_version, title, execution_spec,
   execution_spec_hash, required_evidence_types, revisions, evidence_refs,
   approval_decisions, events, conversation_links, agent_run_links, mutation_keys,
   creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_SQL = `UPDATE seo_tasks SET
   location_id = ?, task_type = ?, source = ?, priority = ?, impact = ?, owner_id = ?, due_at = ?,
   status = ?, evidence_state = ?, task_revision = ?, state_version = ?, title = ?,
   execution_spec = ?, execution_spec_hash = ?, required_evidence_types = ?, revisions = ?,
   evidence_refs = ?, approval_decisions = ?, events = ?, conversation_links = ?,
   agent_run_links = ?, mutation_keys = ?, updated_at = ?
 WHERE id = ? AND state_version = ?`;

// Sanity: placeholders must line up with taskParams() + (updated_at, id, prev).

/** Column values shared by INSERT and UPDATE, in column order after
 * (id, merchant_id) — location_id .. mutation_keys. updatedAt and the
 * creation fields are appended by each caller in its own order. */
function taskParams(task: Task): unknown[] {
  return [
    task.locationId,
    task.taskType,
    task.source,
    task.priority,
    task.impact,
    task.ownerId,
    task.dueAt,
    task.status,
    task.evidenceState,
    task.taskRevision,
    task.stateVersion,
    task.title,
    task.executionSpec,
    task.executionSpecHash,
    JSON.stringify(task.requiredEvidenceTypes),
    JSON.stringify(task.revisions),
    JSON.stringify(task.evidenceRefs),
    JSON.stringify(task.approvalDecisions),
    JSON.stringify(task.events),
    JSON.stringify(task.conversationLinks),
    JSON.stringify(task.agentRunLinks),
    JSON.stringify(task.mutationKeys),
  ];
}

export function insertTask(db: Db, task: Task): Task {
  db.prepare(INSERT_SQL).run(
    task.id,
    task.merchantId,
    ...taskParams(task), // location_id .. mutation_keys
    task.creationIdempotencyKey,
    task.requestFingerprint,
    task.createdBy,
    task.createdAt,
    task.updatedAt, // last column in INSERT column list
  );
  return task;
}

/**
 * Optimistic-lock update. `task.stateVersion` must be the NEW version; the
 * WHERE clause pins the previous one. Returns false when the row moved
 * underneath us (caller re-reads and decides replay vs 409).
 */
export function updateTaskCas(
  db: Db,
  task: Task,
  previousStateVersion: number,
): boolean {
  const result = db.prepare(UPDATE_SQL).run(
    ...taskParams(task),
    task.updatedAt,
    task.id,
    previousStateVersion,
  );
  return result.changes === 1;
}

export function getTask(db: Db, id: string): Task | null {
  const row = db
    .prepare(`SELECT * FROM seo_tasks WHERE id = ?`)
    .get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function findTaskByIdempotencyKey(db: Db, key: string): Task | null {
  const row = db
    .prepare(`SELECT * FROM seo_tasks WHERE creation_idempotency_key = ?`)
    .get(key) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function listTasks(db: Db): Task[] {
  const rows = db
    .prepare(`SELECT * FROM seo_tasks ORDER BY updated_at DESC`)
    .all() as TaskRow[];
  return rows.map(toTask);
}

export function listTasksByMerchant(db: Db, merchantId: string): Task[] {
  const rows = db
    .prepare(
      `SELECT * FROM seo_tasks WHERE merchant_id = ? ORDER BY updated_at DESC`,
    )
    .all(merchantId) as TaskRow[];
  return rows.map(toTask);
}

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
  execution_mode: string;
  proposal_id: string | null;
  depends_on_task_ids: string;
  attempt_count: number;
  published_ref: string | null;
  published_at: string | null;
  verify_due_at: string | null;
  verified_at: string | null;
  verified_by: string | null;
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
    executionMode: (row.execution_mode || "MANUAL") as Task["executionMode"],
    proposalId: row.proposal_id,
    dependsOnTaskIds: JSON.parse(row.depends_on_task_ids || "[]") as string[],
    attemptCount: row.attempt_count ?? 0,
    publishedRef: row.published_ref,
    publishedAt: row.published_at,
    verifyDueAt: row.verify_due_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
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
   execution_mode, proposal_id, depends_on_task_ids, attempt_count, published_ref, published_at,
   verify_due_at, verified_at, verified_by,
   creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
   $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38)`;

const UPDATE_SQL = `UPDATE seo_tasks SET
   location_id = $1, task_type = $2, source = $3, priority = $4, impact = $5, owner_id = $6, due_at = $7,
   status = $8, evidence_state = $9, task_revision = $10, state_version = $11, title = $12,
   execution_spec = $13, execution_spec_hash = $14, required_evidence_types = $15, revisions = $16,
   evidence_refs = $17, approval_decisions = $18, events = $19, conversation_links = $20,
   agent_run_links = $21, mutation_keys = $22, execution_mode = $23, proposal_id = $24,
   depends_on_task_ids = $25, attempt_count = $26, published_ref = $27, published_at = $28,
   verify_due_at = $29, verified_at = $30, verified_by = $31, updated_at = $32
 WHERE id = $33 AND state_version = $34`;

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
    task.executionMode,
    task.proposalId,
    JSON.stringify(task.dependsOnTaskIds),
    task.attemptCount,
    task.publishedRef,
    task.publishedAt,
    task.verifyDueAt,
    task.verifiedAt,
    task.verifiedBy,
  ];
}

export async function insertTask(db: Db, task: Task): Promise<Task> {
  await db.exec(INSERT_SQL, [
    task.id,
    task.merchantId,
    ...taskParams(task), // location_id .. mutation_keys
    task.creationIdempotencyKey,
    task.requestFingerprint,
    task.createdBy,
    task.createdAt,
    task.updatedAt, // last column in INSERT column list
  ]);
  return task;
}

/**
 * Optimistic-lock update. `task.stateVersion` must be the NEW version; the
 * WHERE clause pins the previous one. Returns false when the row moved
 * underneath us (caller re-reads and decides replay vs 409).
 */
export async function updateTaskCas(
  db: Db,
  task: Task,
  previousStateVersion: number,
): Promise<boolean> {
  const rowCount = await db.exec(UPDATE_SQL, [
    ...taskParams(task),
    task.updatedAt,
    task.id,
    previousStateVersion,
  ]);
  return rowCount === 1;
}

export async function getTask(db: Db, id: string): Promise<Task | null> {
  const row = await db.one<TaskRow>(`SELECT * FROM seo_tasks WHERE id = $1`, [id]);
  return row ? toTask(row) : null;
}

export async function findTaskByIdempotencyKey(db: Db, key: string): Promise<Task | null> {
  const row = await db.one<TaskRow>(
    `SELECT * FROM seo_tasks WHERE creation_idempotency_key = $1`,
    [key],
  );
  return row ? toTask(row) : null;
}

export async function listTasks(db: Db): Promise<Task[]> {
  const rows = await db.query<TaskRow>(`SELECT * FROM seo_tasks ORDER BY updated_at DESC`);
  return rows.map(toTask);
}

export async function listTasksByMerchant(db: Db, merchantId: string): Promise<Task[]> {
  const rows = await db.query<TaskRow>(
    `SELECT * FROM seo_tasks WHERE merchant_id = $1 ORDER BY updated_at DESC`,
    [merchantId],
  );
  return rows.map(toTask);
}

/** Scheduler / worker 扫描用：按状态取任务（如 APPROVED 的Ⓐ级待派发）。 */
export async function listTasksByStatus(db: Db, statuses: string[]): Promise<Task[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map((_, i) => `$${i + 1}`).join(",");
  const rows = await db.query<TaskRow>(
    `SELECT * FROM seo_tasks WHERE status IN (${placeholders}) ORDER BY updated_at`,
    statuses,
  );
  return rows.map(toTask);
}

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
  cycle_id: string | null;
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

export interface WorkbenchTaskRow {
  id: string;
  merchantId: string;
  merchantName: string;
  locationName: string | null;
  title: string;
  severity: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  dueAt: string | null;
  status: string;
  executionMode: string;
  verifyDueAt: string | null;
  createdAt: string;
}

/** The merchant ledger deliberately projects only operational columns.  It
 * must not load task specs, evidence blobs, or Agent-run metadata just to
 * render a dated control-room row. */
export interface CycleLedgerTaskRow {
  id: string;
  proposalId: string | null;
  title: string;
  taskType: string;
  ownerId: string | null;
  dueAt: string | null;
  status: string;
  executionMode: string;
  dependsOnTaskIds: string[];
  createdAt: string;
}

export interface PostHistoryTaskRow {
  id: string;
  title: string;
  publishedRef: string;
  publishedAt: string;
  verifiedAt: string;
  verifiedBy: string | null;
}

interface WorkbenchTaskDbRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  location_name: string | null;
  title: string;
  severity: WorkbenchTaskRow["severity"];
  due_at: string | null;
  status: string;
  execution_mode: string;
  verify_due_at: string | null;
  created_at: string;
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    cycleId: row.cycle_id,
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
  (id, merchant_id, cycle_id, location_id, task_type, source, priority, impact, owner_id, due_at,
   status, evidence_state, task_revision, state_version, title, execution_spec,
   execution_spec_hash, required_evidence_types, revisions, evidence_refs,
   approval_decisions, events, conversation_links, agent_run_links, mutation_keys,
   execution_mode, proposal_id, depends_on_task_ids, attempt_count, published_ref, published_at,
   verify_due_at, verified_at, verified_by,
   creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
   $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39)`;

const UPDATE_SQL = `UPDATE seo_tasks SET
   cycle_id = $1, location_id = $2, task_type = $3, source = $4, priority = $5, impact = $6, owner_id = $7, due_at = $8,
   status = $9, evidence_state = $10, task_revision = $11, state_version = $12, title = $13,
   execution_spec = $14, execution_spec_hash = $15, required_evidence_types = $16, revisions = $17,
   evidence_refs = $18, approval_decisions = $19, events = $20, conversation_links = $21,
   agent_run_links = $22, mutation_keys = $23, execution_mode = $24, proposal_id = $25,
   depends_on_task_ids = $26, attempt_count = $27, published_ref = $28, published_at = $29,
   verify_due_at = $30, verified_at = $31, verified_by = $32, updated_at = $33
 WHERE id = $34 AND state_version = $35`;

// Sanity: placeholders must line up with taskParams() + (updated_at, id, prev).

/** Column values shared by INSERT and UPDATE, in column order after
 * (id, merchant_id) — location_id .. mutation_keys. updatedAt and the
 * creation fields are appended by each caller in its own order. */
function taskParams(task: Task): unknown[] {
  return [
    task.cycleId,
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
    ...taskParams(task), // cycle_id .. mutation_keys
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

/** Transaction-only aggregate lock for mutations that allocate child sequence
 * numbers (draft versions, attempts) before the task CAS is written. */
export async function getTaskForUpdate(db: Db, id: string): Promise<Task | null> {
  const row = await db.one<TaskRow>(`SELECT * FROM seo_tasks WHERE id = $1 FOR UPDATE`, [id]);
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

/** Accepted work only: proposal rows remain in proposalRepo until a human
 * adopts them.  Keeping this slim query separate protects the merchant view
 * from accidentally receiving execution specs or evidence payloads. */
export async function listCycleLedgerTasks(
  db: Db,
  merchantId: string,
  cycleId: string,
): Promise<CycleLedgerTaskRow[]> {
  const rows = await db.query<{
    id: string; proposal_id: string | null; title: string; task_type: string;
    owner_id: string | null; due_at: string | null; status: string;
    execution_mode: string; depends_on_task_ids: string; created_at: string;
  }>(
    `SELECT id, proposal_id, title, task_type, owner_id, due_at, status,
            execution_mode, depends_on_task_ids, created_at
       FROM seo_tasks
      WHERE merchant_id = $1 AND cycle_id = $2
      ORDER BY due_at NULLS LAST, created_at, id`,
    [merchantId, cycleId],
  );
  return rows.map((row) => ({
    id: row.id,
    proposalId: row.proposal_id,
    title: row.title,
    taskType: row.task_type,
    ownerId: row.owner_id,
    dueAt: row.due_at,
    status: row.status,
    executionMode: row.execution_mode,
    dependsOnTaskIds: JSON.parse(row.depends_on_task_ids || "[]") as string[],
    createdAt: row.created_at,
  }));
}

/** Publication history is intentionally stricter than dispatch history:
 * both a provider publication reference and independent verification must be
 * persisted before it can be represented as program history. */
export async function listVerifiedGbpPostHistory(
  db: Db,
  merchantId: string,
): Promise<PostHistoryTaskRow[]> {
  const rows = await db.query<{
    id: string; title: string; published_ref: string; published_at: string;
    verified_at: string; verified_by: string | null;
  }>(
    `SELECT id, title, published_ref, published_at, verified_at, verified_by
       FROM seo_tasks
      WHERE merchant_id = $1
        AND task_type = 'GBP_POST'
        AND published_ref IS NOT NULL
        AND published_at IS NOT NULL
        AND verified_at IS NOT NULL
      ORDER BY published_at DESC, id DESC`,
    [merchantId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    publishedRef: row.published_ref,
    publishedAt: row.published_at,
    verifiedAt: row.verified_at,
    verifiedBy: row.verified_by,
  }));
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

/** Small, scope-ready task projection for the operator workbench.  It avoids
 * loading execution specifications, evidence, run links, and other audit-only
 * task aggregate fields into the daily action queue. */
export async function listWorkbenchTasks(
  db: Db,
  merchantIds: readonly string[],
): Promise<WorkbenchTaskRow[]> {
  if (merchantIds.length === 0) return [];
  const rows = await db.query<WorkbenchTaskDbRow>(
    `SELECT * FROM (
       SELECT
         t.id,
         t.merchant_id,
         m.display_name AS merchant_name,
         l.display_name AS location_name,
         t.title,
         t.priority AS severity,
         t.due_at,
         t.status,
         t.execution_mode,
         t.verify_due_at,
         t.created_at
       FROM seo_tasks t
       JOIN seo_merchants m ON m.id = t.merchant_id
       LEFT JOIN seo_locations l ON l.id = t.location_id
       WHERE t.merchant_id = ANY($1::text[])
         AND t.status IN ('READY_FOR_APPROVAL', 'APPROVED', 'PENDING_VERIFY', 'FAILED', 'OUTCOME_UNKNOWN')
     ) AS workbench_tasks
     ORDER BY
       CASE severity WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END,
       COALESCE(due_at, created_at),
       id`,
    [merchantIds],
  );
  return rows.map((row) => ({
    id: row.id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    locationName: row.location_name,
    title: row.title,
    severity: row.severity,
    dueAt: row.due_at,
    status: row.status,
    executionMode: row.execution_mode,
    verifyDueAt: row.verify_due_at,
    createdAt: row.created_at,
  }));
}

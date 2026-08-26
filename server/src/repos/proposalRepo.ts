import type { Db } from "../db/connection.js";
import type { ProposalOrigin, ProposalStatus } from "../domain/enums.js";

export interface ProposalBatch {
  id: string;
  merchantId: string;
  /** Null only for legacy batches; new batches are always attached to active cycle. */
  cycleId: string | null;
  origin: ProposalOrigin;
  triggerReason: string | null;
  plannerRunId: string | null;
  snapshotNote: string | null;
  status: "OPEN" | "CLOSED";
  creationIdempotencyKey: string | null;
  requestFingerprint: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Proposal {
  id: string;
  batchId: string;
  merchantId: string;
  locationId: string | null;
  seq: number;
  title: string;
  taskType: string;
  executionMode: string;
  executorAgent: string | null;
  /** 依赖同批次条目的 seq 列表。 */
  dependsOn: number[];
  dueAt: string | null;
  priority: string;
  impact: string;
  acceptanceCriteria: string | null;
  executionSpec: string;
  requiredEvidenceTypes: string[];
  /** 机器校验失败原因；非空则只能退回，不可采纳（红线：坏建议不落库）。 */
  validationFailures: string[];
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  returnReason: string | null;
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BatchRow {
  id: string; merchant_id: string; cycle_id: string | null; origin: string; trigger_reason: string | null;
  planner_run_id: string | null; snapshot_note: string | null; status: string;
  creation_idempotency_key: string | null; request_fingerprint: string | null;
  created_by: string | null; created_at: string; updated_at: string;
}

interface ProposalRow {
  id: string; batch_id: string; merchant_id: string; location_id: string | null;
  seq: number; title: string; task_type: string; execution_mode: string;
  executor_agent: string | null; depends_on: string; due_at: string | null;
  priority: string; impact: string; acceptance_criteria: string | null;
  execution_spec: string; required_evidence_types: string; validation_failures: string;
  status: string; decided_by: string | null; decided_at: string | null;
  return_reason: string | null; task_id: string | null;
  created_at: string; updated_at: string;
}

export interface WorkbenchProposalRow {
  id: string;
  merchantId: string;
  merchantName: string;
  locationName: string | null;
  title: string;
  severity: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  dueAt: string | null;
  status: "PENDING" | "VALIDATION_FAILED";
  createdAt: string;
}

/** Dated proposal projection.  It intentionally includes only items that
 * remain undecided; a proposal that produced a Task is represented by that
 * Task alone in the merchant ledger. */
export interface CycleLedgerProposalRow {
  id: string;
  batchId: string;
  seq: number;
  title: string;
  taskType: string;
  executionMode: string;
  dueAt: string | null;
  priority: string;
  status: "PENDING" | "VALIDATION_FAILED";
  validationFailures: string[];
  dependsOn: number[];
  createdAt: string;
}

export interface ProposalDependencyLabelRow {
  batchId: string;
  seq: number;
  title: string;
}

interface WorkbenchProposalDbRow {
  id: string;
  merchant_id: string;
  merchant_name: string;
  location_name: string | null;
  title: string;
  severity: WorkbenchProposalRow["severity"];
  due_at: string | null;
  status: WorkbenchProposalRow["status"];
  created_at: string;
}

function toBatch(row: BatchRow): ProposalBatch {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    cycleId: row.cycle_id,
    origin: row.origin as ProposalOrigin,
    triggerReason: row.trigger_reason,
    plannerRunId: row.planner_run_id,
    snapshotNote: row.snapshot_note,
    status: row.status as ProposalBatch["status"],
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    batchId: row.batch_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    seq: row.seq,
    title: row.title,
    taskType: row.task_type,
    executionMode: row.execution_mode,
    executorAgent: row.executor_agent,
    dependsOn: JSON.parse(row.depends_on || "[]"),
    dueAt: row.due_at,
    priority: row.priority,
    impact: row.impact,
    acceptanceCriteria: row.acceptance_criteria,
    executionSpec: row.execution_spec,
    requiredEvidenceTypes: JSON.parse(row.required_evidence_types || "[]"),
    validationFailures: JSON.parse(row.validation_failures || "[]"),
    status: row.status as ProposalStatus,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    returnReason: row.return_reason,
    taskId: row.task_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertBatch(db: Db, b: ProposalBatch): Promise<ProposalBatch> {
  await db.exec(
    `INSERT INTO seo_proposal_batches
      (id, merchant_id, cycle_id, origin, trigger_reason, planner_run_id, snapshot_note, status,
       creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [b.id, b.merchantId, b.cycleId, b.origin, b.triggerReason, b.plannerRunId, b.snapshotNote,
     b.status, b.creationIdempotencyKey, b.requestFingerprint, b.createdBy,
     b.createdAt, b.updatedAt],
  );
  return b;
}

export async function insertProposal(db: Db, p: Proposal): Promise<Proposal> {
  await db.exec(
    `INSERT INTO seo_proposals
      (id, batch_id, merchant_id, location_id, seq, title, task_type, execution_mode,
       executor_agent, depends_on, due_at, priority, impact, acceptance_criteria,
       execution_spec, required_evidence_types, validation_failures, status,
       decided_by, decided_at, return_reason, task_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
    [p.id, p.batchId, p.merchantId, p.locationId, p.seq, p.title, p.taskType,
     p.executionMode, p.executorAgent, JSON.stringify(p.dependsOn), p.dueAt,
     p.priority, p.impact, p.acceptanceCriteria, p.executionSpec,
     JSON.stringify(p.requiredEvidenceTypes), JSON.stringify(p.validationFailures),
     p.status, p.decidedBy, p.decidedAt, p.returnReason, p.taskId,
     p.createdAt, p.updatedAt],
  );
  return p;
}

/** 判定写入（CAS）：只有仍处于 expectedStatuses 之一的行才会被改写；
 * 返回 false = 并发判定已先落，调用方应按冲突处理。 */
export async function updateProposalDecisionIf(
  db: Db,
  p: Proposal,
  expectedStatuses: string[],
): Promise<boolean> {
  const count = await db.exec(
    `UPDATE seo_proposals SET
       status = $1, decided_by = $2, decided_at = $3, return_reason = $4,
       task_id = $5, updated_at = $6
     WHERE id = $7 AND status = ANY($8)`,
    [p.status, p.decidedBy, p.decidedAt, p.returnReason, p.taskId, p.updatedAt, p.id, expectedStatuses],
  );
  return count > 0;
}

/** 采纳两段式的第二步：任务创建成功后回填 task_id（幂等）。 */
export async function setProposalTaskId(
  db: Db,
  proposalId: string,
  taskId: string,
  now: string,
): Promise<void> {
  await db.exec(
    `UPDATE seo_proposals SET task_id = $2, updated_at = $3 WHERE id = $1 AND status = 'ADOPTED'`,
    [proposalId, taskId, now],
  );
}

/** 事务内行锁读：判定路径必须先锁行再校验状态（防 ADOPT/RETURN 竞态）。 */
export async function getProposalForUpdate(tx: Db, id: string): Promise<Proposal | null> {
  const row = await tx.one<ProposalRow>(
    `SELECT * FROM seo_proposals WHERE id = $1 FOR UPDATE`, [id]);
  return row ? toProposal(row) : null;
}

/** 同批次多条建议按 seq 查（依赖检查用）。 */
export async function getProposalBySeq(
  db: Db,
  batchId: string,
  seq: number,
): Promise<Proposal | null> {
  const row = await db.one<ProposalRow>(
    `SELECT * FROM seo_proposals WHERE batch_id = $1 AND seq = $2`, [batchId, seq]);
  return row ? toProposal(row) : null;
}

export async function closeBatchIfDecided(db: Db, batchId: string, now: string): Promise<void> {
  await db.exec(
    `UPDATE seo_proposal_batches SET status = 'CLOSED', updated_at = $2
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM seo_proposals WHERE batch_id = $1 AND status IN ('PENDING','VALIDATION_FAILED'))`,
    [batchId, now],
  );
}

export async function getBatch(db: Db, id: string): Promise<ProposalBatch | null> {
  const row = await db.one<BatchRow>(`SELECT * FROM seo_proposal_batches WHERE id = $1`, [id]);
  return row ? toBatch(row) : null;
}

/** Adoption locks its batch before changing proposal state so a missing cycle
 * cannot leave a legacy proposal permanently ADOPTED without a Task. */
export async function getBatchForUpdate(tx: Db, id: string): Promise<ProposalBatch | null> {
  const row = await tx.one<BatchRow>(
    `SELECT * FROM seo_proposal_batches WHERE id = $1 FOR UPDATE`, [id]);
  return row ? toBatch(row) : null;
}

export async function findBatchByIdempotencyKey(db: Db, key: string): Promise<ProposalBatch | null> {
  const row = await db.one<BatchRow>(
    `SELECT * FROM seo_proposal_batches WHERE creation_idempotency_key = $1`, [key]);
  return row ? toBatch(row) : null;
}

export async function listBatches(db: Db, merchantId?: string): Promise<ProposalBatch[]> {
  const rows = merchantId
    ? await db.query<BatchRow>(
        `SELECT * FROM seo_proposal_batches WHERE merchant_id = $1 ORDER BY created_at DESC`, [merchantId])
    : await db.query<BatchRow>(`SELECT * FROM seo_proposal_batches ORDER BY created_at DESC`);
  return rows.map(toBatch);
}

export async function getProposal(db: Db, id: string): Promise<Proposal | null> {
  const row = await db.one<ProposalRow>(`SELECT * FROM seo_proposals WHERE id = $1`, [id]);
  return row ? toProposal(row) : null;
}

export async function listProposalsByBatch(db: Db, batchId: string): Promise<Proposal[]> {
  const rows = await db.query<ProposalRow>(
    `SELECT * FROM seo_proposals WHERE batch_id = $1 ORDER BY seq`, [batchId]);
  return rows.map(toProposal);
}

export async function countPendingProposals(db: Db, merchantId?: string): Promise<number> {
  const row = merchantId
    ? await db.one<{ n: string }>(
        `SELECT COUNT(*) AS n FROM seo_proposals WHERE status IN ('PENDING','VALIDATION_FAILED') AND merchant_id = $1`,
        [merchantId])
    : await db.one<{ n: string }>(
        `SELECT COUNT(*) AS n FROM seo_proposals WHERE status IN ('PENDING','VALIDATION_FAILED')`);
  return Number(row?.n ?? 0);
}

export async function listPendingProposalsByMerchant(db: Db, merchantId: string): Promise<Proposal[]> {
  const rows = await db.query<ProposalRow>(
    `SELECT * FROM seo_proposals
     WHERE merchant_id = $1 AND status IN ('PENDING','VALIDATION_FAILED')
     ORDER BY due_at NULLS LAST, seq`,
    [merchantId],
  );
  return rows.map(toProposal);
}

export async function listCycleLedgerProposals(
  db: Db,
  merchantId: string,
  cycleId: string,
): Promise<CycleLedgerProposalRow[]> {
  const rows = await db.query<{
    id: string; batch_id: string; seq: number; title: string; task_type: string;
    execution_mode: string; due_at: string | null; priority: string; status: "PENDING" | "VALIDATION_FAILED";
    validation_failures: string; depends_on: string; created_at: string;
  }>(
    `SELECT p.id, p.batch_id, p.seq, p.title, p.task_type, p.execution_mode, p.due_at,
            p.priority, p.status, p.validation_failures, p.depends_on, p.created_at
       FROM seo_proposals p
       JOIN seo_proposal_batches b ON b.id = p.batch_id
      WHERE p.merchant_id = $1 AND b.cycle_id = $2
        AND p.status IN ('PENDING', 'VALIDATION_FAILED')
      ORDER BY p.due_at NULLS LAST, p.created_at, p.id`,
    [merchantId, cycleId],
  );
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    title: row.title,
    taskType: row.task_type,
    executionMode: row.execution_mode,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    validationFailures: JSON.parse(row.validation_failures || "[]") as string[],
    dependsOn: JSON.parse(row.depends_on || "[]") as number[],
    createdAt: row.created_at,
  }));
}

/** Dependency labels are needed only for the batches represented by the
 * scoped ledger rows.  This returns names, not proposal execution specs. */
export async function listProposalDependencyLabels(
  db: Db,
  merchantId: string,
  batchIds: readonly string[],
): Promise<ProposalDependencyLabelRow[]> {
  if (batchIds.length === 0) return [];
  const rows = await db.query<{
    batch_id: string; seq: number; title: string;
  }>(
    `SELECT batch_id, seq, title
       FROM seo_proposals
      WHERE merchant_id = $1 AND batch_id = ANY($2::text[])
      ORDER BY batch_id, seq`,
    [merchantId, batchIds],
  );
  return rows.map((row) => ({ batchId: row.batch_id, seq: row.seq, title: row.title }));
}

export async function listPendingGbpPostProposals(
  db: Db,
  merchantId: string,
  cycleId: string,
): Promise<CycleLedgerProposalRow[]> {
  const rows = await db.query<{
    id: string; batch_id: string; seq: number; title: string; task_type: string;
    execution_mode: string; due_at: string | null; priority: string; status: "PENDING" | "VALIDATION_FAILED";
    validation_failures: string; depends_on: string; created_at: string;
  }>(
    `SELECT p.id, p.batch_id, p.seq, p.title, p.task_type, p.execution_mode,
            p.due_at, p.priority, p.status, p.validation_failures, p.depends_on, p.created_at
       FROM seo_proposals p
       JOIN seo_proposal_batches b ON b.id = p.batch_id
      WHERE p.merchant_id = $1 AND b.cycle_id = $2
        AND p.task_type = 'GBP_POST'
        AND p.status IN ('PENDING', 'VALIDATION_FAILED')
      ORDER BY p.due_at NULLS LAST, p.created_at, p.id`,
    [merchantId, cycleId],
  );
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batch_id,
    seq: row.seq,
    title: row.title,
    taskType: row.task_type,
    executionMode: row.execution_mode,
    dueAt: row.due_at,
    priority: row.priority,
    status: row.status,
    validationFailures: JSON.parse(row.validation_failures || "[]") as string[],
    dependsOn: JSON.parse(row.depends_on || "[]") as number[],
    createdAt: row.created_at,
  }));
}

/** Bounded fields for proposals that still require a human decision.  An
 * adopted proposal never appears here, even when it is linked to a task. */
export async function listWorkbenchProposals(
  db: Db,
  merchantIds: readonly string[],
): Promise<WorkbenchProposalRow[]> {
  if (merchantIds.length === 0) return [];
  const rows = await db.query<WorkbenchProposalDbRow>(
    `SELECT * FROM (
       SELECT
         p.id,
         p.merchant_id,
         m.display_name AS merchant_name,
         l.display_name AS location_name,
         p.title,
         p.priority AS severity,
         p.due_at,
         p.status,
         p.created_at
       FROM seo_proposals p
       JOIN seo_merchants m ON m.id = p.merchant_id
       LEFT JOIN seo_locations l ON l.id = p.location_id
       WHERE p.merchant_id = ANY($1::text[])
         AND p.status IN ('PENDING', 'VALIDATION_FAILED')
     ) AS workbench_proposals
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
    createdAt: row.created_at,
  }));
}

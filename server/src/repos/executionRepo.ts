import type { Db } from "../db/connection.js";
import type { AttemptStatus, OutcomeResolution } from "../domain/enums.js";

/** 一次派发一行（禁止自动重试：attempt 只由门 2 / 系统规则显式创建）。 */
export interface ExecutionAttempt {
  id: string;
  taskId: string;
  merchantId: string;
  attemptNo: number;
  status: AttemptStatus;
  /** G2 = 人工执行确认；AUTO = Ⓐ 级规则预授权派发。 */
  gate: "G2" | "AUTO";
  agentRunId: string | null;
  coreRunId: string | null;
  traceRef: string | null;
  /** 查证线索编号 exec-<task>-rev<r>-attempt<n>。 */
  probeRef: string;
  error: string | null;
  startedAt: string;
  /** 写入类触发前先落此标记：崩溃重启后见到「有标记、无 run id」即判结果不明，禁止重触发。 */
  triggerStartedAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: OutcomeResolution | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionAttemptDeliverable {
  id: string;
  attemptId: string;
  fileId: string;
  fileName: string;
  contentType: string | null;
  sha256: string | null;
  sourceRef: string | null;
  createdAt: string;
}

/** Least-data input for the workbench's outcome-reconciliation action. */
export interface WorkbenchUnknownAttempt {
  id: string;
  taskId: string;
  merchantId: string;
  startedAt: string;
}

interface AttemptRow {
  id: string;
  task_id: string;
  merchant_id: string;
  attempt_no: number;
  status: string;
  gate: string;
  agent_run_id: string | null;
  core_run_id: string | null;
  trace_ref: string | null;
  probe_ref: string;
  error: string | null;
  started_at: string;
  trigger_started_at: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

interface AttemptDeliverableRow {
  id: string;
  attempt_id: string;
  file_id: string;
  file_name: string;
  content_type: string | null;
  sha256: string | null;
  source_ref: string | null;
  created_at: string;
}

function toAttempt(row: AttemptRow): ExecutionAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    merchantId: row.merchant_id,
    attemptNo: row.attempt_no,
    status: row.status as AttemptStatus,
    gate: row.gate as "G2" | "AUTO",
    agentRunId: row.agent_run_id,
    coreRunId: row.core_run_id,
    traceRef: row.trace_ref,
    probeRef: row.probe_ref,
    error: row.error,
    startedAt: row.started_at,
    triggerStartedAt: row.trigger_started_at ?? null,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: (row.resolution as OutcomeResolution | null) ?? null,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertAttempt(db: Db, a: ExecutionAttempt): Promise<ExecutionAttempt> {
  await db.exec(
    `INSERT INTO seo_execution_attempts
      (id, task_id, merchant_id, attempt_no, status, gate, agent_run_id, core_run_id, trace_ref,
       probe_ref, error, started_at, trigger_started_at, resolved_at, resolved_by,
       resolution, resolution_note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      a.id, a.taskId, a.merchantId, a.attemptNo, a.status, a.gate, a.agentRunId,
      a.coreRunId, a.traceRef, a.probeRef, a.error, a.startedAt, a.triggerStartedAt, a.resolvedAt,
      a.resolvedBy, a.resolution, a.resolutionNote, a.createdAt, a.updatedAt,
    ],
  );
  return a;
}

export async function updateAttempt(db: Db, a: ExecutionAttempt): Promise<void> {
  await db.exec(
    `UPDATE seo_execution_attempts SET
       status = $1, agent_run_id = $2, core_run_id = $3, trace_ref = $4, error = $5,
       trigger_started_at = $6, resolved_at = $7, resolved_by = $8, resolution = $9,
       resolution_note = $10, updated_at = $11
     WHERE id = $12`,
    [
      a.status, a.agentRunId, a.coreRunId, a.traceRef, a.error, a.triggerStartedAt, a.resolvedAt,
      a.resolvedBy, a.resolution, a.resolutionNote, a.updatedAt, a.id,
    ],
  );
}

export async function getAttempt(db: Db, id: string): Promise<ExecutionAttempt | null> {
  const row = await db.one<AttemptRow>(
    `SELECT * FROM seo_execution_attempts WHERE id = $1`, [id]);
  return row ? toAttempt(row) : null;
}

export async function getAttemptByRunId(db: Db, agentRunId: string): Promise<ExecutionAttempt | null> {
  const row = await db.one<AttemptRow>(
    `SELECT * FROM seo_execution_attempts WHERE agent_run_id = $1`, [agentRunId]);
  return row ? toAttempt(row) : null;
}

export async function listAttemptsByTask(
  db: Db,
  taskId: string,
  merchantId: string,
): Promise<ExecutionAttempt[]> {
  const rows = await db.query<AttemptRow>(
    `SELECT * FROM seo_execution_attempts
     WHERE task_id = $1 AND merchant_id = $2 ORDER BY attempt_no DESC`,
    [taskId, merchantId],
  );
  return rows.map(toAttempt);
}

export async function listAttemptsByTaskPage(
  db: Db, taskId: string, merchantId: string, offset: number, limit: number,
): Promise<{ items: ExecutionAttempt[]; total: number }> {
  const count = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total FROM seo_execution_attempts
     WHERE task_id = $1 AND merchant_id = $2`,
    [taskId, merchantId],
  );
  const rows = await db.query<AttemptRow>(
    `SELECT * FROM seo_execution_attempts
     WHERE task_id = $1 AND merchant_id = $2
     ORDER BY attempt_no DESC LIMIT $3 OFFSET $4`,
    [taskId, merchantId, limit, offset],
  );
  return { items: rows.map(toAttempt), total: Number(count?.total ?? 0) };
}

function toAttemptDeliverable(row: AttemptDeliverableRow): ExecutionAttemptDeliverable {
  return {
    id: row.id, attemptId: row.attempt_id, fileId: row.file_id, fileName: row.file_name,
    contentType: row.content_type, sha256: row.sha256, sourceRef: row.source_ref, createdAt: row.created_at,
  };
}

export async function upsertAttemptDeliverable(db: Db, deliverable: ExecutionAttemptDeliverable): Promise<void> {
  await db.exec(
    `INSERT INTO seo_execution_attempt_deliverables
      (id, attempt_id, file_id, file_name, content_type, sha256, source_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (attempt_id, file_id) DO UPDATE SET
       file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
       sha256 = EXCLUDED.sha256, source_ref = EXCLUDED.source_ref`,
    [deliverable.id, deliverable.attemptId, deliverable.fileId, deliverable.fileName,
      deliverable.contentType, deliverable.sha256, deliverable.sourceRef, deliverable.createdAt],
  );
}

export async function listAttemptDeliverablesByAttemptIds(
  db: Db, attemptIds: readonly string[],
): Promise<Map<string, ExecutionAttemptDeliverable[]>> {
  const byAttempt = new Map<string, ExecutionAttemptDeliverable[]>();
  if (attemptIds.length === 0) return byAttempt;
  const rows = await db.query<AttemptDeliverableRow>(
    `SELECT * FROM seo_execution_attempt_deliverables
     WHERE attempt_id = ANY($1::text[]) ORDER BY created_at ASC, id ASC`, [attemptIds],
  );
  for (const row of rows) {
    const deliverable = toAttemptDeliverable(row);
    const values = byAttempt.get(deliverable.attemptId) ?? [];
    values.push(deliverable);
    byAttempt.set(deliverable.attemptId, values);
  }
  return byAttempt;
}

/** 该商户是否有未决 OUTCOME_UNKNOWN attempt（有则冻结整条执行链，红线③）。 */
export async function listOpenUnknownAttempts(
  db: Db,
  merchantId?: string,
): Promise<ExecutionAttempt[]> {
  const rows = merchantId
    ? await db.query<AttemptRow>(
        `SELECT * FROM seo_execution_attempts WHERE status = 'OUTCOME_UNKNOWN' AND merchant_id = $1 ORDER BY started_at`,
        [merchantId],
      )
    : await db.query<AttemptRow>(
        `SELECT * FROM seo_execution_attempts WHERE status = 'OUTCOME_UNKNOWN' ORDER BY started_at`,
      );
  return rows.map(toAttempt);
}

/** Scope outcome-reconciliation reads to the authorized merchant set and
 * avoid loading run references, errors, or resolution/audit payloads. */
export async function listWorkbenchUnknownAttempts(
  db: Db,
  merchantIds: readonly string[],
): Promise<WorkbenchUnknownAttempt[]> {
  if (merchantIds.length === 0) return [];
  const rows = await db.query<Pick<AttemptRow, "id" | "task_id" | "merchant_id" | "started_at">>(
    `SELECT id, task_id, merchant_id, started_at
     FROM seo_execution_attempts
     WHERE status = 'OUTCOME_UNKNOWN' AND merchant_id = ANY($1::text[])
     ORDER BY started_at, id`,
    [merchantIds],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    merchantId: row.merchant_id,
    startedAt: row.started_at,
  }));
}

/** 在途（已派发未终态）attempt：门 2 在途/冻结面校验的数据源。 */
export async function listInFlightAttempts(
  db: Db,
  taskId: string,
): Promise<ExecutionAttempt[]> {
  const rows = await db.query<AttemptRow>(
    `SELECT * FROM seo_execution_attempts
     WHERE task_id = $1 AND status IN ('DISPATCHING','OUTCOME_UNKNOWN')
     ORDER BY attempt_no DESC`,
    [taskId],
  );
  return rows.map(toAttempt);
}

export async function listDispatchingAttempts(db: Db): Promise<ExecutionAttempt[]> {
  const rows = await db.query<AttemptRow>(
    `SELECT * FROM seo_execution_attempts WHERE status = 'DISPATCHING' ORDER BY started_at`,
  );
  return rows.map(toAttempt);
}

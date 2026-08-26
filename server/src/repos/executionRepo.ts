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

interface AttemptRow {
  id: string;
  task_id: string;
  merchant_id: string;
  attempt_no: number;
  status: string;
  gate: string;
  agent_run_id: string | null;
  core_run_id: string | null;
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
      (id, task_id, merchant_id, attempt_no, status, gate, agent_run_id, core_run_id,
       probe_ref, error, started_at, trigger_started_at, resolved_at, resolved_by,
       resolution, resolution_note, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      a.id, a.taskId, a.merchantId, a.attemptNo, a.status, a.gate, a.agentRunId,
      a.coreRunId, a.probeRef, a.error, a.startedAt, a.triggerStartedAt, a.resolvedAt,
      a.resolvedBy, a.resolution, a.resolutionNote, a.createdAt, a.updatedAt,
    ],
  );
  return a;
}

export async function updateAttempt(db: Db, a: ExecutionAttempt): Promise<void> {
  await db.exec(
    `UPDATE seo_execution_attempts SET
       status = $1, agent_run_id = $2, core_run_id = $3, error = $4,
       trigger_started_at = $5, resolved_at = $6, resolved_by = $7, resolution = $8,
       resolution_note = $9, updated_at = $10
     WHERE id = $11`,
    [
      a.status, a.agentRunId, a.coreRunId, a.error, a.triggerStartedAt, a.resolvedAt,
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

export async function listAttemptsByTask(db: Db, taskId: string): Promise<ExecutionAttempt[]> {
  const rows = await db.query<AttemptRow>(
    `SELECT * FROM seo_execution_attempts WHERE task_id = $1 ORDER BY attempt_no DESC`, [taskId]);
  return rows.map(toAttempt);
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

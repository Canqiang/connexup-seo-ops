import type { Db } from "../db/connection.js";
import type { AgentRunStatus } from "../domain/enums.js";
import type { AgentRun, RunDeliverable } from "./agentRunTypes.js";

interface AgentRunRow {
  id: string;
  merchant_id: string;
  location_id: string | null;
  stage: string;
  task_id: string | null;
  run_type: string;
  goal: string | null;
  status: string;
  core_run_id: string | null;
  core_status: string | null;
  input_message: string;
  output: string | null;
  error: string | null;
  error_code: string | null;
  token_usage: string;
  triggered_by: string;
  triggered_at: string;
  last_polled_at: string | null;
  completed_at: string | null;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export function toAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    stage: row.stage as AgentRun["stage"],
    taskId: row.task_id,
    runType: row.run_type as AgentRun["runType"],
    goal: row.goal,
    status: row.status as AgentRunStatus,
    coreRunId: row.core_run_id,
    coreStatus: row.core_status,
    inputMessage: row.input_message,
    output: row.output,
    error: row.error,
    errorCode: row.error_code,
    tokenUsage: JSON.parse(row.token_usage || "{}"),
    triggeredBy: row.triggered_by,
    triggeredAt: row.triggered_at,
    lastPolledAt: row.last_polled_at,
    completedAt: row.completed_at,
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RUN_COLUMNS = `id, merchant_id, location_id, stage, task_id, run_type, goal, status,
  core_run_id, core_status, input_message, output, error, error_code, token_usage,
  triggered_by, triggered_at, last_polled_at, completed_at,
  creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at`;

const RUN_COLUMN_COUNT = 24;

function runParams(run: AgentRun): unknown[] {
  return [
    run.merchantId,
    run.locationId,
    run.stage,
    run.taskId,
    run.runType,
    run.goal,
    run.status,
    run.coreRunId,
    run.coreStatus,
    run.inputMessage,
    run.output,
    run.error,
    run.errorCode,
    JSON.stringify(run.tokenUsage),
    run.triggeredBy,
    run.triggeredAt,
    run.lastPolledAt,
    run.completedAt,
    run.creationIdempotencyKey,
    run.requestFingerprint,
    run.createdBy,
    run.createdAt,
    run.updatedAt,
  ];
}

export function insertAgentRun(db: Db, run: AgentRun): AgentRun {
  db.prepare(
    `INSERT INTO seo_agent_runs (${RUN_COLUMNS}) VALUES (${"?, ".repeat(RUN_COLUMN_COUNT - 1)}?)`,
  ).run(run.id, ...runParams(run));
  return run;
}

/** Full-row update by id (trigger path only — terminal transitions must go
 * through transitionAgentRun so exactly one writer wins). */
export function updateAgentRun(db: Db, run: AgentRun): void {
  db.prepare(
    `UPDATE seo_agent_runs SET merchant_id = ?, location_id = ?, stage = ?, task_id = ?,
       run_type = ?, goal = ?, status = ?, core_run_id = ?, core_status = ?,
       input_message = ?, output = ?, error = ?, error_code = ?, token_usage = ?,
       triggered_by = ?, triggered_at = ?, last_polled_at = ?, completed_at = ?,
       creation_idempotency_key = ?, request_fingerprint = ?, created_by = ?,
       created_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(...runParams(run), run.id);
}

/** camelCase AgentRun key -> snake_case column. */
const COLUMN_BY_KEY: Record<keyof AgentRun, string> = {
  id: "id",
  merchantId: "merchant_id",
  locationId: "location_id",
  stage: "stage",
  taskId: "task_id",
  runType: "run_type",
  goal: "goal",
  status: "status",
  coreRunId: "core_run_id",
  coreStatus: "core_status",
  inputMessage: "input_message",
  output: "output",
  error: "error",
  errorCode: "error_code",
  tokenUsage: "token_usage",
  triggeredBy: "triggered_by",
  triggeredAt: "triggered_at",
  lastPolledAt: "last_polled_at",
  completedAt: "completed_at",
  creationIdempotencyKey: "creation_idempotency_key",
  requestFingerprint: "request_fingerprint",
  createdBy: "created_by",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

/** Conditional update pinned on the current status — the single-winner guard
 * so the poller and the cancel route cannot both record a terminal state. */
export function transitionAgentRun(
  db: Db,
  id: string,
  changes: Partial<AgentRun>,
  fromStatuses: AgentRunStatus[],
): AgentRun | null {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(changes) as [keyof AgentRun, unknown][]) {
    const column = COLUMN_BY_KEY[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(key === "tokenUsage" ? JSON.stringify(value ?? {}) : value);
  }
  if (sets.length === 0) return getAgentRun(db, id);
  const placeholders = fromStatuses.map(() => "?").join(", ");
  const result = db
    .prepare(
      `UPDATE seo_agent_runs SET ${sets.join(", ")}, updated_at = ?
       WHERE id = ? AND status IN (${placeholders})`,
    )
    .run(...values, new Date().toISOString(), id, ...fromStatuses);
  return result.changes === 1 ? getAgentRun(db, id) : null;
}

export function getAgentRun(db: Db, id: string): AgentRun | null {
  const row = db
    .prepare(`SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE id = ?`)
    .get(id) as AgentRunRow | undefined;
  return row ? toAgentRun(row) : null;
}

export function findAgentRunByIdempotencyKey(
  db: Db,
  key: string,
): AgentRun | null {
  const row = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE creation_idempotency_key = ?`,
    )
    .get(key) as AgentRunRow | undefined;
  return row ? toAgentRun(row) : null;
}

export function listAgentRunsByMerchant(
  db: Db,
  merchantId: string,
  stage?: string,
): AgentRun[] {
  const rows = (
    stage
      ? db
          .prepare(
            `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
             WHERE merchant_id = ? AND stage = ? ORDER BY created_at DESC, id DESC`,
          )
          .all(merchantId, stage)
      : db
          .prepare(
            `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
             WHERE merchant_id = ? ORDER BY created_at DESC, id DESC`,
          )
          .all(merchantId)
  ) as AgentRunRow[];
  return rows.map(toAgentRun);
}

export function countAgentRunsByMerchantSince(
  db: Db,
  merchantId: string,
  sinceIso: string,
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM seo_agent_runs WHERE merchant_id = ? AND created_at >= ?`,
    )
    .get(merchantId, sinceIso) as { n: number };
  return row.n;
}

export function listActiveAgentRuns(db: Db): AgentRun[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
       WHERE status IN ('TRIGGERING', 'RUNNING') ORDER BY created_at ASC`,
    )
    .all() as AgentRunRow[];
  return rows.map(toAgentRun);
}

// ---------------------------------------------------------------------------
// Deliverables

interface DeliverableRow {
  id: string;
  run_id: string;
  kind: string;
  file_id: string | null;
  file_name: string;
  content_type: string | null;
  size: number | null;
  title: string | null;
  description: string | null;
  sha256: string | null;
  local_path: string | null;
  remote_url: string | null;
  downloaded_at: string | null;
  download_error: string | null;
  created_at: string;
}

function toDeliverable(row: DeliverableRow): RunDeliverable {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind as RunDeliverable["kind"],
    fileId: row.file_id,
    fileName: row.file_name,
    contentType: row.content_type,
    size: row.size,
    title: row.title,
    description: row.description,
    sha256: row.sha256,
    localPath: row.local_path,
    remoteUrl: row.remote_url,
    downloadedAt: row.downloaded_at,
    downloadError: row.download_error,
    createdAt: row.created_at,
  };
}

const DELIVERABLE_COLUMNS = `id, run_id, kind, file_id, file_name, content_type, size,
  title, description, sha256, local_path, remote_url, downloaded_at, download_error, created_at`;

/** Idempotent by primary key — crash-replay may re-insert the same rows. */
export function upsertDeliverable(db: Db, d: RunDeliverable): RunDeliverable {
  db.prepare(
    `INSERT INTO seo_run_deliverables (${DELIVERABLE_COLUMNS})
     VALUES (${"?, ".repeat(14)}?)
     ON CONFLICT(id) DO UPDATE SET
       sha256 = excluded.sha256,
       size = excluded.size,
       local_path = excluded.local_path,
       downloaded_at = excluded.downloaded_at,
       download_error = excluded.download_error`,
  ).run(
    d.id,
    d.runId,
    d.kind,
    d.fileId,
    d.fileName,
    d.contentType,
    d.size,
    d.title,
    d.description,
    d.sha256,
    d.localPath,
    d.remoteUrl,
    d.downloadedAt,
    d.downloadError,
    d.createdAt,
  );
  return d;
}

export function getDeliverable(db: Db, id: string): RunDeliverable | null {
  const row = db
    .prepare(`SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables WHERE id = ?`)
    .get(id) as DeliverableRow | undefined;
  return row ? toDeliverable(row) : null;
}

export function listDeliverablesByRun(db: Db, runId: string): RunDeliverable[] {
  const rows = db
    .prepare(
      `SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables
       WHERE run_id = ? ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as DeliverableRow[];
  return rows.map(toDeliverable);
}

export function listDeliverablesByRunIds(
  db: Db,
  runIds: string[],
): Map<string, RunDeliverable[]> {
  const byRun = new Map<string, RunDeliverable[]>();
  if (runIds.length === 0) return byRun;
  const placeholders = runIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables
       WHERE run_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    )
    .all(...runIds) as DeliverableRow[];
  for (const row of rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(toDeliverable(row));
    byRun.set(row.run_id, list);
  }
  return byRun;
}

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

export async function insertAgentRun(db: Db, run: AgentRun): Promise<AgentRun> {
  const placeholders = Array.from({ length: RUN_COLUMN_COUNT }, (_, i) => `$${i + 1}`).join(", ");
  await db.exec(
    `INSERT INTO seo_agent_runs (${RUN_COLUMNS}) VALUES (${placeholders})`,
    [run.id, ...runParams(run)],
  );
  return run;
}

/** Full-row update by id (trigger path only — terminal transitions must go
 * through transitionAgentRun so exactly one writer wins). */
export async function updateAgentRun(db: Db, run: AgentRun): Promise<void> {
  await db.exec(
    `UPDATE seo_agent_runs SET merchant_id = $1, location_id = $2, stage = $3, task_id = $4,
       run_type = $5, goal = $6, status = $7, core_run_id = $8, core_status = $9,
       input_message = $10, output = $11, error = $12, error_code = $13, token_usage = $14,
       triggered_by = $15, triggered_at = $16, last_polled_at = $17, completed_at = $18,
       creation_idempotency_key = $19, request_fingerprint = $20, created_by = $21,
       created_at = $22, updated_at = $23
     WHERE id = $24`,
    [...runParams(run), run.id],
  );
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
export async function transitionAgentRun(
  db: Db,
  id: string,
  changes: Partial<AgentRun>,
  fromStatuses: AgentRunStatus[],
): Promise<AgentRun | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;
  for (const [key, value] of Object.entries(changes) as [keyof AgentRun, unknown][]) {
    const column = COLUMN_BY_KEY[key];
    if (!column) continue;
    sets.push(`${column} = $${paramIndex++}`);
    values.push(key === "tokenUsage" ? JSON.stringify(value ?? {}) : value);
  }
  if (sets.length === 0) return getAgentRun(db, id);
  if (fromStatuses.length === 0) return null;
  values.push(new Date().toISOString());
  const updatedAtIndex = paramIndex++;
  values.push(id);
  const idIndex = paramIndex++;
  const placeholders = fromStatuses.map(() => `$${paramIndex++}`).join(", ");
  values.push(...fromStatuses);
  const rowCount = await db.exec(
    `UPDATE seo_agent_runs SET ${sets.join(", ")}, updated_at = $${updatedAtIndex}
     WHERE id = $${idIndex} AND status IN (${placeholders})`,
    values,
  );
  return rowCount === 1 ? getAgentRun(db, id) : null;
}

export async function getAgentRun(db: Db, id: string): Promise<AgentRun | null> {
  const row = await db.one<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE id = $1`,
    [id],
  );
  return row ? toAgentRun(row) : null;
}

export async function findAgentRunByIdempotencyKey(
  db: Db,
  key: string,
): Promise<AgentRun | null> {
  const row = await db.one<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE creation_idempotency_key = $1`,
    [key],
  );
  return row ? toAgentRun(row) : null;
}

export async function listAgentRunsByMerchant(
  db: Db,
  merchantId: string,
  stage?: string,
): Promise<AgentRun[]> {
  const rows = stage
    ? await db.query<AgentRunRow>(
        `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
         WHERE merchant_id = $1 AND stage = $2 ORDER BY created_at DESC, id DESC`,
        [merchantId, stage],
      )
    : await db.query<AgentRunRow>(
        `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
         WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC`,
        [merchantId],
      );
  return rows.map(toAgentRun);
}

export async function countAgentRunsByMerchantSince(
  db: Db,
  merchantId: string,
  sinceIso: string,
): Promise<number> {
  const row = await db.one<{ n: string }>(
    `SELECT COUNT(*) AS n FROM seo_agent_runs WHERE merchant_id = $1 AND created_at >= $2`,
    [merchantId, sinceIso],
  );
  return Number(row?.n ?? 0);
}

export async function listActiveAgentRuns(db: Db): Promise<AgentRun[]> {
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE status IN ('TRIGGERING', 'RUNNING') ORDER BY created_at ASC`,
  );
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

const DELIVERABLE_COLUMN_COUNT = 15;

/** Idempotent by primary key — crash-replay may re-insert the same rows. */
export async function upsertDeliverable(db: Db, d: RunDeliverable): Promise<RunDeliverable> {
  const placeholders = Array.from(
    { length: DELIVERABLE_COLUMN_COUNT },
    (_, i) => `$${i + 1}`,
  ).join(", ");
  await db.exec(
    `INSERT INTO seo_run_deliverables (${DELIVERABLE_COLUMNS})
     VALUES (${placeholders})
     ON CONFLICT(id) DO UPDATE SET
       sha256 = excluded.sha256,
       size = excluded.size,
       local_path = excluded.local_path,
       downloaded_at = excluded.downloaded_at,
       download_error = excluded.download_error`,
    [
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
    ],
  );
  return d;
}

export async function getDeliverable(db: Db, id: string): Promise<RunDeliverable | null> {
  const row = await db.one<DeliverableRow>(
    `SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables WHERE id = $1`,
    [id],
  );
  return row ? toDeliverable(row) : null;
}

export async function listDeliverablesByRun(db: Db, runId: string): Promise<RunDeliverable[]> {
  const rows = await db.query<DeliverableRow>(
    `SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables
     WHERE run_id = $1 ORDER BY created_at ASC, id ASC`,
    [runId],
  );
  return rows.map(toDeliverable);
}

export async function listDeliverablesByRunIds(
  db: Db,
  runIds: string[],
): Promise<Map<string, RunDeliverable[]>> {
  const byRun = new Map<string, RunDeliverable[]>();
  if (runIds.length === 0) return byRun;
  const placeholders = runIds.map((_, i) => `$${i + 1}`).join(", ");
  const rows = await db.query<DeliverableRow>(
    `SELECT ${DELIVERABLE_COLUMNS} FROM seo_run_deliverables
     WHERE run_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`,
    runIds,
  );
  for (const row of rows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push(toDeliverable(row));
    byRun.set(row.run_id, list);
  }
  return byRun;
}

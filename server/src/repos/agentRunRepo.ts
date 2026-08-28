import type { Db } from "../db/connection.js";
import type { AgentRunStatus } from "../domain/enums.js";
import { assertAgentRunTaskScope, type AgentRunTaskScope } from "../domain/agentRunScope.js";
import type { AgentRunRequestSemantics } from "../domain/agentRunRequestSemantics.js";
import type { AgentRun, AgentRunRequest, RunDeliverable } from "./agentRunTypes.js";

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
  trace_ref: string | null;
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
  http_request_fingerprint: string | null;
  business_input_fingerprint: string | null;
  retry_of_agent_run_id: string | null;
  retry_generation: number;
  retry_reason: string | null;
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
    traceRef: row.trace_ref,
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
    httpRequestFingerprint: row.http_request_fingerprint,
    businessInputFingerprint: row.business_input_fingerprint,
    retryOfAgentRunId: row.retry_of_agent_run_id,
    retryGeneration: row.retry_generation,
    retryReason: row.retry_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RUN_COLUMNS = `id, merchant_id, location_id, stage, task_id, run_type, goal, status,
  core_run_id, trace_ref, core_status, input_message, output, error, error_code, token_usage,
  triggered_by, triggered_at, last_polled_at, completed_at,
  creation_idempotency_key, request_fingerprint, http_request_fingerprint,
  business_input_fingerprint, retry_of_agent_run_id, retry_generation,
  retry_reason, created_by, created_at, updated_at`;

const RUN_COLUMN_COUNT = 30;

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
    run.traceRef,
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
    run.httpRequestFingerprint ?? run.requestFingerprint,
    run.businessInputFingerprint ?? null,
    run.retryOfAgentRunId ?? null,
    run.retryGeneration ?? 0,
    run.retryReason ?? null,
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
       run_type = $5, goal = $6, status = $7, core_run_id = $8, trace_ref = $9, core_status = $10,
       input_message = $11, output = $12, error = $13, error_code = $14, token_usage = $15,
       triggered_by = $16, triggered_at = $17, last_polled_at = $18, completed_at = $19,
       creation_idempotency_key = $20, request_fingerprint = $21,
       http_request_fingerprint = $22, business_input_fingerprint = $23,
       retry_of_agent_run_id = $24, retry_generation = $25, retry_reason = $26,
       created_by = $27, created_at = $28, updated_at = $29
     WHERE id = $30`,
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
  traceRef: "trace_ref",
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
  httpRequestFingerprint: "http_request_fingerprint",
  businessInputFingerprint: "business_input_fingerprint",
  retryOfAgentRunId: "retry_of_agent_run_id",
  retryGeneration: "retry_generation",
  retryReason: "retry_reason",
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

export async function findAgentRunRequestByIdempotencyKey(
  db: Db,
  key: string,
): Promise<AgentRunRequest | null> {
  const row = await db.one<{
    idempotency_key: string;
    run_id: string;
    merchant_id: string;
    http_request_fingerprint: string;
    semantics_version: AgentRunRequestSemantics;
    created_at: string;
  }>(
    `SELECT idempotency_key, run_id, merchant_id, http_request_fingerprint,
            semantics_version, created_at
       FROM seo_agent_run_requests WHERE idempotency_key = $1`,
    [key],
  );
  return row ? {
    idempotencyKey: row.idempotency_key,
    runId: row.run_id,
    merchantId: row.merchant_id,
    httpRequestFingerprint: row.http_request_fingerprint,
    semanticsVersion: row.semantics_version,
    createdAt: row.created_at,
  } : null;
}

export async function insertAgentRunRequest(
  db: Db,
  request: AgentRunRequest,
): Promise<void> {
  await db.exec(
    `INSERT INTO seo_agent_run_requests
      (idempotency_key, run_id, merchant_id, http_request_fingerprint,
       semantics_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [request.idempotencyKey, request.runId, request.merchantId,
      request.httpRequestFingerprint, request.semanticsVersion, request.createdAt],
  );
}

export async function findAgentRunByTaskFingerprint(
  db: Db,
  scope: AgentRunTaskScope,
  fingerprint: string,
): Promise<AgentRun | null> {
  const row = await db.one<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE task_id = $1 AND stage = 'GBP_POST_CONTENT' AND request_fingerprint = $2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope.taskId, fingerprint],
  );
  if (!row) return null;
  const run = toAgentRun(row);
  assertAgentRunTaskScope(run, scope);
  return run;
}

export async function findLatestGbpContentRunByBusinessFingerprint(
  db: Db,
  scope: AgentRunTaskScope,
  fingerprint: string,
): Promise<AgentRun | null> {
  const row = await db.one<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE task_id = $1 AND stage = 'GBP_POST_CONTENT'
       AND COALESCE(business_input_fingerprint, request_fingerprint) = $2
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope.taskId, fingerprint],
  );
  if (!row) return null;
  const run = toAgentRun(row);
  assertAgentRunTaskScope(run, scope);
  return run;
}

export async function findActiveGbpContentRunByTask(
  db: Db,
  scope: AgentRunTaskScope,
): Promise<AgentRun | null> {
  const row = await db.one<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE task_id = $1 AND stage = 'GBP_POST_CONTENT'
       AND status IN ('TRIGGERING', 'RUNNING')
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope.taskId],
  );
  if (!row) return null;
  const run = toAgentRun(row);
  assertAgentRunTaskScope(run, scope);
  return run;
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

export async function listAgentRunsByTask(db: Db, taskId: string): Promise<AgentRun[]> {
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE task_id = $1 ORDER BY created_at DESC, id DESC`, [taskId],
  );
  return rows.map(toAgentRun);
}

/** Audit reads are scoped to the task merchant even when legacy links were
 * corrupted. Linked ids remain useful provenance, but must never widen the
 * authorization boundary beyond the task aggregate. */
export async function listAgentRunsForTaskAudit(
  db: Db,
  scope: AgentRunTaskScope,
  linkedRunIds: readonly string[],
  offset: number,
  limit: number,
): Promise<{ items: AgentRun[]; total: number }> {
  const ids = [...new Set(linkedRunIds)];
  const params = [scope.merchantId, scope.taskId, ids, scope.locationId];
  const clauses = `
    (task_id = $2 OR id = ANY($3::text[]))
    AND (
      NOT (stage = 'GBP_POST_CONTENT' OR run_type = 'GBP_POST_CONTENT')
      OR (
        stage = 'GBP_POST_CONTENT'
        AND task_id = $2
        AND location_id IS NOT DISTINCT FROM $4
      )
    )`;
  const count = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total FROM seo_agent_runs WHERE merchant_id = $1 AND ${clauses}`,
    params,
  );
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE merchant_id = $1 AND ${clauses}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { items: rows.map(toAgentRun), total: Number(count?.total ?? 0) };
}

export async function listAgentRuns(db: Db): Promise<AgentRun[]> {
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     ORDER BY created_at DESC, id DESC`,
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

export interface AgentRunPageFilter {
  /** null = 全部商户（scopeAll）。 */
  merchantIds: readonly string[] | null;
  status?: string;
  stage?: string;
  includeContentRuns: boolean;
  offset: number;
  limit: number;
}

function runFilterClause(filter: Omit<AgentRunPageFilter, "offset" | "limit">, params: unknown[]): string {
  const where: string[] = [];
  if (filter.merchantIds !== null) {
    params.push([...filter.merchantIds]);
    where.push(`merchant_id = ANY($${params.length}::text[])`);
  }
  if (filter.status) { params.push(filter.status); where.push(`status = $${params.length}`); }
  if (filter.stage) { params.push(filter.stage); where.push(`stage = $${params.length}`); }
  if (!filter.includeContentRuns) where.push(`stage <> 'GBP_POST_CONTENT'`);
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

/** 跨商户 Run 账本分页（只读；不含 output 正文以外的任何裁决）。 */
export async function listAgentRunsPage(
  db: Db,
  filter: AgentRunPageFilter,
): Promise<{ items: AgentRun[]; total: number }> {
  const params: unknown[] = [];
  const clause = runFilterClause(filter, params);
  const count = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total FROM seo_agent_runs ${clause}`, params,
  );
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs ${clause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.limit, filter.offset],
  );
  return { items: rows.map(toAgentRun), total: Number(count?.total ?? 0) };
}

/** 汇总用：某时刻之后创建的 Run + 仍在途的 Run（不分页）。 */
export async function listAgentRunsForSummary(
  db: Db,
  merchantIds: readonly string[] | null,
  sinceIso: string,
): Promise<AgentRun[]> {
  const params: unknown[] = [sinceIso];
  let scope = "";
  if (merchantIds !== null) { params.push([...merchantIds]); scope = `AND merchant_id = ANY($2::text[])`; }
  const rows = await db.query<AgentRunRow>(
    `SELECT ${RUN_COLUMNS} FROM seo_agent_runs
     WHERE (created_at >= $1 OR status IN ('TRIGGERING','RUNNING')) ${scope}
     ORDER BY created_at DESC, id DESC`,
    params,
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

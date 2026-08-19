import type { Db } from "../db/connection.js";
import type { AgentRunStatus } from "../domain/enums.js";
import type { AgentRun } from "./agentRunTypes.js";

interface AgentRunRow {
  id: string;
  task_id: string;
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
  artifact_path: string | null;
  artifact_sha256: string | null;
  evidence_id: string | null;
  evidence_skipped_reason: string | null;
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
    artifactPath: row.artifact_path,
    artifactSha256: row.artifact_sha256,
    evidenceId: row.evidence_id,
    evidenceSkippedReason: row.evidence_skipped_reason,
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

const RUN_COLUMNS = `id, task_id, run_type, goal, status, core_run_id, core_status,
  input_message, output, error, error_code, token_usage, artifact_path, artifact_sha256,
  evidence_id, evidence_skipped_reason, triggered_by, triggered_at, last_polled_at,
  completed_at, creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at`;

function runParams(run: AgentRun): unknown[] {
  return [
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
    run.artifactPath,
    run.artifactSha256,
    run.evidenceId,
    run.evidenceSkippedReason,
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
    `INSERT INTO seo_agent_runs (${RUN_COLUMNS}) VALUES (${"?, ".repeat(24)}?)`,
  ).run(run.id, ...runParams(run));
  return run;
}

/** Full-row update by id (trigger path only — terminal transitions must go
 * through transitionAgentRun so exactly one writer wins). */
export function updateAgentRun(db: Db, run: AgentRun): void {
  db.prepare(
    `UPDATE seo_agent_runs SET task_id = ?, run_type = ?, goal = ?, status = ?,
       core_run_id = ?, core_status = ?, input_message = ?, output = ?, error = ?,
       error_code = ?, token_usage = ?, artifact_path = ?, artifact_sha256 = ?,
       evidence_id = ?, evidence_skipped_reason = ?, triggered_by = ?, triggered_at = ?,
       last_polled_at = ?, completed_at = ?, creation_idempotency_key = ?,
       request_fingerprint = ?, created_by = ?, created_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(...runParams(run), run.id);
}

/** camelCase AgentRun key -> snake_case column. */
const COLUMN_BY_KEY: Record<keyof AgentRun, string> = {
  id: "id",
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
  artifactPath: "artifact_path",
  artifactSha256: "artifact_sha256",
  evidenceId: "evidence_id",
  evidenceSkippedReason: "evidence_skipped_reason",
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

export function listAgentRunsByTask(db: Db, taskId: string): AgentRun[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM seo_agent_runs WHERE task_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(taskId) as AgentRunRow[];
  return rows.map(toAgentRun);
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

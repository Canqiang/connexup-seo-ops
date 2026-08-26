import type { Db } from "../db/connection.js";

export type SpecialistArtifactType =
  | "KEYWORD_SET"
  | "KEYWORD_WEEKLY"
  | "AUDIT_REPORT"
  | "RANKING_SNAPSHOT"
  | "EXECUTION_PLAN";

export interface SpecialistArtifact {
  id: string;
  taskId: string;
  merchantId: string;
  artifactType: SpecialistArtifactType;
  schemaVersion: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  coreRunId: string;
  createdBy: string | null;
  createdAt: string;
}

/** Raw persisted evidence for the Post-program projection.  The service owns
 * semantic validation, while the repository deliberately returns no title,
 * summary, or Core AI identifiers that the view does not need. */
export interface PostProgramArtifactRow {
  id: string;
  taskId: string;
  artifactType: "KEYWORD_WEEKLY";
  schemaVersion: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

function parseProjectionPayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    // Legacy rows are still evidence records.  The projection service turns
    // this empty sentinel into an explicit INVALID_* gap rather than failing
    // the merchant page or fabricating a replacement signal.
    return {};
  }
}

interface SpecialistArtifactRow {
  id: string;
  task_id: string;
  merchant_id: string;
  artifact_type: string;
  schema_version: string;
  title: string;
  summary: string;
  payload: string;
  core_run_id: string;
  created_by: string | null;
  created_at: string;
}

function toArtifact(row: SpecialistArtifactRow): SpecialistArtifact {
  return {
    id: row.id,
    taskId: row.task_id,
    merchantId: row.merchant_id,
    artifactType: row.artifact_type as SpecialistArtifactType,
    schemaVersion: row.schema_version,
    title: row.title,
    summary: row.summary,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    coreRunId: row.core_run_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function insertSpecialistArtifact(
  db: Db,
  artifact: SpecialistArtifact,
): Promise<SpecialistArtifact> {
  await db.exec(
    `INSERT INTO seo_specialist_artifacts
      (id, task_id, merchant_id, artifact_type, schema_version, title, summary,
       payload, core_run_id, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (core_run_id, artifact_type) DO NOTHING`,
    [
      artifact.id,
      artifact.taskId,
      artifact.merchantId,
      artifact.artifactType,
      artifact.schemaVersion,
      artifact.title,
      artifact.summary,
      JSON.stringify(artifact.payload),
      artifact.coreRunId,
      artifact.createdBy,
      artifact.createdAt,
    ],
  );
  const saved = await getSpecialistArtifactByRun(
    db,
    artifact.coreRunId,
    artifact.artifactType,
  );
  if (!saved) throw new Error("specialist artifact insert did not produce a readable record");
  return saved;
}

export async function getSpecialistArtifactByRun(
  db: Db,
  coreRunId: string,
  artifactType: SpecialistArtifactType,
): Promise<SpecialistArtifact | null> {
  const row = await db.one<SpecialistArtifactRow>(
    `SELECT * FROM seo_specialist_artifacts WHERE core_run_id = $1 AND artifact_type = $2`,
    [coreRunId, artifactType],
  );
  return row ? toArtifact(row) : null;
}

export async function listSpecialistArtifactsByTask(
  db: Db,
  taskId: string,
  merchantId: string,
): Promise<SpecialistArtifact[]> {
  const rows = await db.query<SpecialistArtifactRow>(
    `SELECT * FROM seo_specialist_artifacts
     WHERE task_id = $1 AND merchant_id = $2 ORDER BY created_at DESC, id DESC`,
    [taskId, merchantId],
  );
  return rows.map(toArtifact);
}

/** Audit projection only: page compact identifiers rather than loading full
 * specialist payloads or an unbounded task history. */
export async function listSpecialistArtifactReferencesByTask(
  db: Db, taskId: string, merchantId: string, offset: number, limit: number,
): Promise<{ items: Array<Pick<SpecialistArtifact, "id" | "coreRunId">>; total: number }> {
  const count = await db.one<{ total: string }>(
    `SELECT COUNT(*) AS total FROM seo_specialist_artifacts
     WHERE task_id = $1 AND merchant_id = $2`,
    [taskId, merchantId],
  );
  const rows = await db.query<Pick<SpecialistArtifactRow, "id" | "core_run_id">>(
    `SELECT id, core_run_id FROM seo_specialist_artifacts
     WHERE task_id = $1 AND merchant_id = $2
     ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4`,
    [taskId, merchantId, limit, offset],
  );
  return {
    items: rows.map((row) => ({ id: row.id, coreRunId: row.core_run_id })),
    total: Number(count?.total ?? 0),
  };
}

export async function listSpecialistArtifactsByMerchant(
  db: Db,
  merchantId: string,
  artifactType?: SpecialistArtifactType,
): Promise<SpecialistArtifact[]> {
  const rows = artifactType
    ? await db.query<SpecialistArtifactRow>(
        `SELECT * FROM seo_specialist_artifacts
         WHERE merchant_id = $1 AND artifact_type = $2 ORDER BY created_at DESC, id DESC`,
        [merchantId, artifactType],
      )
    : await db.query<SpecialistArtifactRow>(
        `SELECT * FROM seo_specialist_artifacts
         WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC`,
        [merchantId],
      );
  return rows.map(toArtifact);
}

export async function listPostProgramArtifacts(
  db: Db,
  merchantId: string,
  cycleId: string,
): Promise<PostProgramArtifactRow[]> {
  const rows = await db.query<{
    id: string; task_id: string; artifact_type: "KEYWORD_WEEKLY";
    schema_version: string; payload: string; created_at: string;
  }>(
    `SELECT a.id, a.task_id, a.artifact_type, a.schema_version, a.payload, a.created_at
       FROM seo_specialist_artifacts a
       JOIN seo_tasks t ON t.id = a.task_id
      WHERE a.merchant_id = $1 AND t.cycle_id = $2
        AND a.artifact_type = 'KEYWORD_WEEKLY'
      ORDER BY a.created_at DESC, a.id DESC`,
    [merchantId, cycleId],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    artifactType: row.artifact_type,
    schemaVersion: row.schema_version,
    payload: parseProjectionPayload(row.payload),
    createdAt: row.created_at,
  }));
}

import type { Db } from "../db/connection.js";

export type SpecialistArtifactType =
  | "KEYWORD_SET"
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
): Promise<SpecialistArtifact[]> {
  const rows = await db.query<SpecialistArtifactRow>(
    `SELECT * FROM seo_specialist_artifacts WHERE task_id = $1 ORDER BY created_at DESC, id DESC`,
    [taskId],
  );
  return rows.map(toArtifact);
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

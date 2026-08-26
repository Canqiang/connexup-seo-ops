import type { Db } from "../db/connection.js";

export type SpecialistArtifactType =
  | "KEYWORD_SET"
  | "KEYWORD_WEEKLY"
  | "AUDIT_REPORT"
  | "RANKING_SNAPSHOT"
  | "EXECUTION_PLAN"
  | "EFFECT_REVIEW"
  | "MERCHANT_REPORT";

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
  acceptanceStatus: "PENDING" | "ACCEPTED" | "REJECTED";
  acceptanceDecidedBy: string | null;
  acceptanceDecidedAt: string | null;
  acceptanceNote: string | null;
}

export type SpecialistArtifactInsert = Omit<
  SpecialistArtifact,
  "acceptanceStatus" | "acceptanceDecidedBy" | "acceptanceDecidedAt" | "acceptanceNote"
>;

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

export interface PendingArtifactWorkbenchRow {
  id: string;
  taskId: string;
  merchantId: string;
  merchantName: string;
  locationName: string | null;
  title: string;
  artifactType: SpecialistArtifactType;
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  dueAt: string | null;
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
  acceptance_status: "PENDING" | "ACCEPTED" | "REJECTED";
  acceptance_decided_by: string | null;
  acceptance_decided_at: string | null;
  acceptance_note: string | null;
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
    acceptanceStatus: row.acceptance_status,
    acceptanceDecidedBy: row.acceptance_decided_by,
    acceptanceDecidedAt: row.acceptance_decided_at,
    acceptanceNote: row.acceptance_note,
  };
}

export async function insertSpecialistArtifact(
  db: Db,
  artifact: SpecialistArtifactInsert,
): Promise<SpecialistArtifact> {
  await db.exec(
    `INSERT INTO seo_specialist_artifacts
      (id, task_id, merchant_id, artifact_type, schema_version, title, summary,
       payload, core_run_id, created_by, created_at, acceptance_status,
       acceptance_decided_by, acceptance_decided_at, acceptance_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
      "PENDING",
      null,
      null,
      null,
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

export async function getSpecialistArtifact(
  db: Db,
  artifactId: string,
): Promise<SpecialistArtifact | null> {
  const row = await db.one<SpecialistArtifactRow>(
    `SELECT * FROM seo_specialist_artifacts WHERE id = $1`,
    [artifactId],
  );
  return row ? toArtifact(row) : null;
}

export async function setPendingSpecialistArtifactAcceptance(
  db: Db,
  artifactId: string,
  decision: "ACCEPTED" | "REJECTED",
  actor: string,
  note: string | null,
  decidedAt: string,
): Promise<SpecialistArtifact | null> {
  const row = await db.one<SpecialistArtifactRow>(
    `UPDATE seo_specialist_artifacts
        SET acceptance_status = $2,
            acceptance_decided_by = $3,
            acceptance_decided_at = $4,
            acceptance_note = $5
      WHERE id = $1 AND acceptance_status = 'PENDING'
      RETURNING *`,
    [artifactId, decision, actor, decidedAt, note],
  );
  return row ? toArtifact(row) : null;
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

/** Bounded by the actor's merchant scope before any artifact row is read. */
export async function listPendingSpecialistArtifactsForWorkbench(
  db: Db,
  merchantIds: readonly string[],
): Promise<PendingArtifactWorkbenchRow[]> {
  if (merchantIds.length === 0) return [];
  const rows = await db.query<{
    id: string; task_id: string; merchant_id: string; merchant_name: string;
    location_name: string | null; title: string; artifact_type: SpecialistArtifactType;
    priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW"; due_at: string | null;
    created_at: string;
  }>(
    `SELECT a.id, a.task_id, a.merchant_id,
            COALESCE(m.display_name, m.slug) AS merchant_name,
            COALESCE(l.display_name, l.slug) AS location_name,
            a.title, a.artifact_type, t.priority, t.due_at, a.created_at
       FROM seo_specialist_artifacts a
       JOIN seo_tasks t ON t.id = a.task_id AND t.merchant_id = a.merchant_id
       JOIN seo_merchants m ON m.id = a.merchant_id
       LEFT JOIN seo_locations l ON l.id = t.location_id AND l.merchant_id = a.merchant_id
      WHERE a.merchant_id = ANY($1::text[])
        AND a.acceptance_status = 'PENDING'
      ORDER BY a.created_at ASC, a.id ASC`,
    [[...merchantIds]],
  );
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    locationName: row.location_name,
    title: row.title,
    artifactType: row.artifact_type,
    priority: row.priority,
    dueAt: row.due_at,
    createdAt: row.created_at,
  }));
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

/** Exact-id lookup for frozen report snapshots. Authorization and merchant-safe
 * type checks stay in the service, while this repository never substitutes a
 * newer artifact for a missing requested id. */
export async function listSpecialistArtifactsByIds(
  db: Db,
  artifactIds: readonly string[],
): Promise<SpecialistArtifact[]> {
  if (artifactIds.length === 0) return [];
  const rows = await db.query<SpecialistArtifactRow>(
    `SELECT * FROM seo_specialist_artifacts WHERE id = ANY($1::text[])`,
    [[...artifactIds]],
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

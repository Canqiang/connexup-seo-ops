import crypto from "node:crypto";
import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";

/** Additive column migrations for databases created before the column
 * existed. Fails harmlessly when the column is already present. */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE seo_tasks ADD COLUMN mutation_keys TEXT NOT NULL DEFAULT '{}'`,
];

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: Db, table: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) !== undefined
  );
}

interface LegacyRunRow {
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
  attachments: string | null;
  triggered_by: string;
  triggered_at: string;
  last_polled_at: string | null;
  completed_at: string | null;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  merchant_id: string | null;
  location_id: string | null;
}

interface LegacyAttachment {
  fileId?: string | null;
  fileName?: string | null;
  contentType?: string | null;
  size?: number | null;
  url?: string | null;
  title?: string | null;
  description?: string | null;
  localPath?: string | null;
  sha256?: string | null;
}

const LEGACY_RUN_TYPE_TO_STAGE: Record<string, string> = {
  KEYWORD_RESEARCH: "KEYWORDS",
  AUDIT: "AUDIT",
  REPORT: "RANKING_BASELINE",
  PLAN: "PLAN",
  REVIEW: "REVIEW",
};

/** One-time rebuild: legacy runs were task-bound (task_id NOT NULL, no
 * merchant/stage columns, attachments as a JSON column). Rebuild the table on
 * the new shape, backfilling merchant/location from the owning task and
 * expanding attachments + the body artifact into seo_run_deliverables rows.
 * Orphan runs whose task no longer exists are dropped (analysis history
 * without an owner is unaddressable in the new model). */
function rebuildAgentRunsIfLegacy(db: Db): void {
  if (!tableExists(db, "seo_agent_runs")) return;
  if (hasColumn(db, "seo_agent_runs", "stage")) return;

  db.exec(`ALTER TABLE seo_agent_runs RENAME TO seo_agent_runs_legacy`);
  for (const statement of SCHEMA_STATEMENTS) {
    db.exec(statement);
  }

  const legacyHasAttachments = hasColumn(db, "seo_agent_runs_legacy", "attachments");
  const rows = db
    .prepare(
      `SELECT r.*, t.merchant_id AS merchant_id, t.location_id AS location_id
       FROM seo_agent_runs_legacy r
       LEFT JOIN seo_tasks t ON t.id = r.task_id`,
    )
    .all() as LegacyRunRow[];

  const insertRun = db.prepare(
    `INSERT INTO seo_agent_runs (
       id, merchant_id, location_id, stage, task_id, run_type, goal, status,
       core_run_id, core_status, input_message, output, error, error_code, token_usage,
       triggered_by, triggered_at, last_polled_at, completed_at,
       creation_idempotency_key, request_fingerprint, created_by, created_at, updated_at
     ) VALUES (${"?, ".repeat(23)}?)`,
  );
  const insertDeliverable = db.prepare(
    `INSERT INTO seo_run_deliverables (
       id, run_id, kind, file_id, file_name, content_type, size, title, description,
       sha256, local_path, remote_url, downloaded_at, download_error, created_at
     ) VALUES (${"?, ".repeat(14)}?)`,
  );

  for (const row of rows) {
    if (!row.merchant_id) continue;
    const stage = LEGACY_RUN_TYPE_TO_STAGE[row.run_type] ?? "AUDIT";
    insertRun.run(
      row.id,
      row.merchant_id,
      row.location_id,
      stage,
      row.task_id,
      row.run_type,
      row.goal,
      row.status,
      row.core_run_id,
      row.core_status,
      row.input_message,
      row.output,
      row.error,
      row.error_code,
      row.token_usage ?? "{}",
      row.triggered_by,
      row.triggered_at,
      row.last_polled_at,
      row.completed_at,
      row.creation_idempotency_key,
      row.request_fingerprint,
      row.created_by,
      row.created_at,
      row.updated_at,
    );

    if (row.artifact_path) {
      insertDeliverable.run(
        crypto.randomUUID(),
        row.id,
        "SUMMARY",
        null,
        `${row.id}.md`,
        "text/markdown",
        null,
        null,
        null,
        row.artifact_sha256,
        row.artifact_path,
        null,
        row.completed_at ?? row.updated_at,
        null,
        row.completed_at ?? row.updated_at,
      );
    }

    if (legacyHasAttachments && row.attachments) {
      let parsed: LegacyAttachment[] = [];
      try {
        const raw = JSON.parse(row.attachments) as unknown;
        if (Array.isArray(raw)) parsed = raw as LegacyAttachment[];
      } catch {
        parsed = [];
      }
      for (const attachment of parsed) {
        insertDeliverable.run(
          crypto.randomUUID(),
          row.id,
          "ATTACHMENT",
          attachment.fileId ?? null,
          attachment.fileName ?? "attachment",
          attachment.contentType ?? null,
          attachment.size ?? null,
          attachment.title ?? null,
          attachment.description ?? null,
          attachment.sha256 ?? null,
          attachment.localPath ?? null,
          attachment.url ?? null,
          attachment.localPath ? (row.completed_at ?? row.updated_at) : null,
          null,
          row.completed_at ?? row.updated_at,
        );
      }
    }
  }

  db.exec(`DROP TABLE seo_agent_runs_legacy`);
}

export function migrate(db: Db): void {
  const apply = db.transaction(() => {
    rebuildAgentRunsIfLegacy(db);
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    for (const statement of COLUMN_MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
    }
  });
  apply();
}

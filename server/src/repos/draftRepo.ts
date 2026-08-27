import type { Db } from "../db/connection.js";

/** Post 内容稿：每版一行；任务的执行定义只引用定稿（draftRef + sha256）。 */
export interface ContentDraft {
  id: string;
  taskId: string;
  agentRunId: string | null;
  mediaSourceAgentRunId: string | null;
  version: number;
  body: string;
  ctaType: string | null;
  ctaUrl: string | null;
  media: string[];
  /** AGENT_GENERATED（v1 初稿）/ AGENT_REWRITE（按反馈重写）/ HUMAN_EDIT（人工直接改）。 */
  source: "AGENT_GENERATED" | "AGENT_REWRITE" | "HUMAN_EDIT";
  /** 触发重写的人工反馈原文（AGENT_REWRITE 时有值）。 */
  feedback: string | null;
  sha256: string;
  createdBy: string | null;
  createdAt: string;
}

interface DraftRow {
  id: string; task_id: string; agent_run_id: string | null; media_source_agent_run_id: string | null; version: number; body: string;
  cta_type: string | null; cta_url: string | null; media: string;
  source: string; feedback: string | null; sha256: string;
  created_by: string | null; created_at: string;
}

function toDraft(row: DraftRow): ContentDraft {
  return {
    id: row.id, taskId: row.task_id, agentRunId: row.agent_run_id,
    mediaSourceAgentRunId: row.media_source_agent_run_id,
    version: row.version, body: row.body,
    ctaType: row.cta_type, ctaUrl: row.cta_url,
    media: JSON.parse(row.media || "[]"),
    source: row.source as ContentDraft["source"],
    feedback: row.feedback, sha256: row.sha256,
    createdBy: row.created_by, createdAt: row.created_at,
  };
}

export async function insertDraft(db: Db, d: ContentDraft): Promise<ContentDraft> {
  await db.exec(
    `INSERT INTO seo_content_drafts
      (id, task_id, agent_run_id, media_source_agent_run_id, version, body, cta_type, cta_url, media, source, feedback,
       sha256, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [d.id, d.taskId, d.agentRunId, d.mediaSourceAgentRunId, d.version, d.body, d.ctaType, d.ctaUrl,
     JSON.stringify(d.media), d.source, d.feedback, d.sha256, d.createdBy, d.createdAt],
  );
  return d;
}

export async function getDraftByAgentRunId(db: Db, agentRunId: string): Promise<ContentDraft | null> {
  const row = await db.one<DraftRow>(
    `SELECT * FROM seo_content_drafts WHERE agent_run_id = $1`,
    [agentRunId],
  );
  return row ? toDraft(row) : null;
}

export async function listDraftsByTask(db: Db, taskId: string): Promise<ContentDraft[]> {
  const rows = await db.query<DraftRow>(
    `SELECT * FROM seo_content_drafts WHERE task_id = $1 ORDER BY version`, [taskId]);
  return rows.map(toDraft);
}

export async function getDraftByTaskVersion(
  db: Db,
  taskId: string,
  version: number,
): Promise<ContentDraft | null> {
  const row = await db.one<DraftRow>(
    `SELECT * FROM seo_content_drafts WHERE task_id = $1 AND version = $2`,
    [taskId, version],
  );
  return row ? toDraft(row) : null;
}

export async function latestDraft(db: Db, taskId: string): Promise<ContentDraft | null> {
  const row = await db.one<DraftRow>(
    `SELECT * FROM seo_content_drafts WHERE task_id = $1 ORDER BY version DESC LIMIT 1`,
    [taskId],
  );
  return row ? toDraft(row) : null;
}

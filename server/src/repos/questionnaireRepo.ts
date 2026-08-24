import type { Db } from "../db/connection.js";
import type { Questionnaire, QuestionnaireItem } from "./questionnaireTypes.js";

interface QuestionnaireRow {
  id: string;
  merchant_id: string;
  share_slug: string;
  status: string;
  base_info: string;
  questions: string;
  answers: string | null;
  send_count: number;
  sent_at: string | null;
  last_sent_at: string | null;
  last_sent_by: string | null;
  filled_at: string | null;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toQuestionnaire(row: QuestionnaireRow): Questionnaire {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    shareSlug: row.share_slug,
    status: row.status as Questionnaire["status"],
    baseInfo: JSON.parse(row.base_info || "{}"),
    questions: JSON.parse(row.questions || "[]") as QuestionnaireItem[],
    answers: row.answers ? JSON.parse(row.answers) : null,
    sendCount: row.send_count,
    sentAt: row.sent_at,
    lastSentAt: row.last_sent_at,
    lastSentBy: row.last_sent_by,
    filledAt: row.filled_at,
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertQuestionnaire(
  db: Db,
  questionnaire: Questionnaire,
): Promise<Questionnaire> {
  await db.exec(
    `INSERT INTO seo_merchant_questionnaires
      (id, merchant_id, share_slug, status, base_info, questions, answers,
       send_count, sent_at, last_sent_at, last_sent_by, filled_at,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      questionnaire.id,
      questionnaire.merchantId,
      questionnaire.shareSlug,
      questionnaire.status,
      JSON.stringify(questionnaire.baseInfo),
      JSON.stringify(questionnaire.questions),
      questionnaire.answers ? JSON.stringify(questionnaire.answers) : null,
      questionnaire.sendCount,
      questionnaire.sentAt,
      questionnaire.lastSentAt,
      questionnaire.lastSentBy,
      questionnaire.filledAt,
      questionnaire.creationIdempotencyKey,
      questionnaire.requestFingerprint,
      questionnaire.createdBy,
      questionnaire.createdAt,
      questionnaire.updatedAt,
    ],
  );
  return questionnaire;
}

export async function updateQuestionnaire(
  db: Db,
  questionnaire: Questionnaire,
): Promise<Questionnaire> {
  await db.exec(
    `UPDATE seo_merchant_questionnaires SET status = $1, answers = $2,
       send_count = $3, sent_at = $4, last_sent_at = $5, last_sent_by = $6,
       filled_at = $7, updated_at = $8
     WHERE id = $9`,
    [
      questionnaire.status,
      questionnaire.answers ? JSON.stringify(questionnaire.answers) : null,
      questionnaire.sendCount,
      questionnaire.sentAt,
      questionnaire.lastSentAt,
      questionnaire.lastSentBy,
      questionnaire.filledAt,
      questionnaire.updatedAt,
      questionnaire.id,
    ],
  );
  return questionnaire;
}

/** Atomically records a questionnaire send/re-send. `RETURNING` makes the
 * caller's response authoritative even when another operator sends at once. */
export async function incrementQuestionnaireSend(
  db: Db,
  questionnaireId: string,
  actorId: string,
  at: string,
): Promise<Questionnaire | null> {
  const row = await db.one<QuestionnaireRow>(
    `UPDATE seo_merchant_questionnaires
     SET status = 'SENT',
         send_count = send_count + 1,
         sent_at = COALESCE(sent_at, $1),
         last_sent_at = $1,
         last_sent_by = $2,
         updated_at = $1
     WHERE id = $3 AND status <> 'FILLED'
     RETURNING *`,
    [at, actorId, questionnaireId],
  );
  return row ? toQuestionnaire(row) : null;
}

export async function getQuestionnaire(db: Db, id: string): Promise<Questionnaire | null> {
  const row = await db.one<QuestionnaireRow>(
    `SELECT * FROM seo_merchant_questionnaires WHERE id = $1`,
    [id],
  );
  return row ? toQuestionnaire(row) : null;
}

export async function getQuestionnaireByShareSlug(
  db: Db,
  shareSlug: string,
): Promise<Questionnaire | null> {
  const row = await db.one<QuestionnaireRow>(
    `SELECT * FROM seo_merchant_questionnaires WHERE share_slug = $1`,
    [shareSlug],
  );
  return row ? toQuestionnaire(row) : null;
}

export async function findQuestionnaireByIdempotencyKey(
  db: Db,
  key: string,
): Promise<Questionnaire | null> {
  const row = await db.one<QuestionnaireRow>(
    `SELECT * FROM seo_merchant_questionnaires WHERE creation_idempotency_key = $1`,
    [key],
  );
  return row ? toQuestionnaire(row) : null;
}

export async function latestQuestionnaireByMerchant(
  db: Db,
  merchantId: string,
): Promise<Questionnaire | null> {
  const row = await db.one<QuestionnaireRow>(
    `SELECT * FROM seo_merchant_questionnaires
     WHERE merchant_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [merchantId],
  );
  return row ? toQuestionnaire(row) : null;
}

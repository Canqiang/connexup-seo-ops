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
    filledAt: row.filled_at,
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertQuestionnaire(
  db: Db,
  questionnaire: Questionnaire,
): Questionnaire {
  db.prepare(
    `INSERT INTO seo_merchant_questionnaires
      (id, merchant_id, share_slug, status, base_info, questions, answers,
       send_count, sent_at, last_sent_at, filled_at,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
    questionnaire.filledAt,
    questionnaire.creationIdempotencyKey,
    questionnaire.requestFingerprint,
    questionnaire.createdBy,
    questionnaire.createdAt,
    questionnaire.updatedAt,
  );
  return questionnaire;
}

export function updateQuestionnaire(
  db: Db,
  questionnaire: Questionnaire,
): Questionnaire {
  db.prepare(
    `UPDATE seo_merchant_questionnaires SET status = ?, answers = ?,
       send_count = ?, sent_at = ?, last_sent_at = ?, filled_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    questionnaire.status,
    questionnaire.answers ? JSON.stringify(questionnaire.answers) : null,
    questionnaire.sendCount,
    questionnaire.sentAt,
    questionnaire.lastSentAt,
    questionnaire.filledAt,
    questionnaire.updatedAt,
    questionnaire.id,
  );
  return questionnaire;
}

export function getQuestionnaire(db: Db, id: string): Questionnaire | null {
  const row = db
    .prepare(`SELECT * FROM seo_merchant_questionnaires WHERE id = ?`)
    .get(id) as QuestionnaireRow | undefined;
  return row ? toQuestionnaire(row) : null;
}

export function getQuestionnaireByShareSlug(
  db: Db,
  shareSlug: string,
): Questionnaire | null {
  const row = db
    .prepare(`SELECT * FROM seo_merchant_questionnaires WHERE share_slug = ?`)
    .get(shareSlug) as QuestionnaireRow | undefined;
  return row ? toQuestionnaire(row) : null;
}

export function findQuestionnaireByIdempotencyKey(
  db: Db,
  key: string,
): Questionnaire | null {
  const row = db
    .prepare(
      `SELECT * FROM seo_merchant_questionnaires WHERE creation_idempotency_key = ?`,
    )
    .get(key) as QuestionnaireRow | undefined;
  return row ? toQuestionnaire(row) : null;
}

export function latestQuestionnaireByMerchant(
  db: Db,
  merchantId: string,
): Questionnaire | null {
  const row = db
    .prepare(
      `SELECT * FROM seo_merchant_questionnaires
       WHERE merchant_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(merchantId) as QuestionnaireRow | undefined;
  return row ? toQuestionnaire(row) : null;
}

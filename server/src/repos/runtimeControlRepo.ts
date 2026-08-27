import type { Db } from "../db/connection.js";

export type RuntimeControlScope = "GLOBAL" | "MERCHANT";

export interface RuntimeControlRecord {
  id: string;
  scope: RuntimeControlScope;
  merchantId: string | null;
  paused: boolean;
  reason: string;
  changedBy: string;
  createdAt: string;
}

interface RuntimeControlRow {
  id: string;
  scope: RuntimeControlScope;
  merchant_id: string | null;
  paused: boolean;
  reason: string;
  changed_by: string;
  created_at: string;
}

function toRecord(row: RuntimeControlRow): RuntimeControlRecord {
  return {
    id: row.id,
    scope: row.scope,
    merchantId: row.merchant_id,
    paused: row.paused,
    reason: row.reason,
    changedBy: row.changed_by,
    createdAt: row.created_at,
  };
}

export async function insertRuntimeControl(
  db: Db,
  record: RuntimeControlRecord,
): Promise<RuntimeControlRecord> {
  await db.exec(
    `INSERT INTO seo_runtime_controls
      (id, scope, merchant_id, paused, reason, changed_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [record.id, record.scope, record.merchantId, record.paused, record.reason,
      record.changedBy, record.createdAt],
  );
  return record;
}

export async function latestRuntimeControl(
  db: Db,
  scope: RuntimeControlScope,
  merchantId: string | null,
): Promise<RuntimeControlRecord | null> {
  const row = await db.one<RuntimeControlRow>(
    `SELECT * FROM seo_runtime_controls
      WHERE scope=$1 AND (($2::text IS NULL AND merchant_id IS NULL) OR merchant_id=$2)
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [scope, merchantId],
  );
  return row ? toRecord(row) : null;
}

export async function listRuntimeControls(
  db: Db,
  scope: RuntimeControlScope,
  merchantId: string | null,
): Promise<RuntimeControlRecord[]> {
  return (await db.query<RuntimeControlRow>(
    `SELECT * FROM seo_runtime_controls
      WHERE scope=$1 AND (($2::text IS NULL AND merchant_id IS NULL) OR merchant_id=$2)
      ORDER BY created_at, id`,
    [scope, merchantId],
  )).map(toRecord);
}

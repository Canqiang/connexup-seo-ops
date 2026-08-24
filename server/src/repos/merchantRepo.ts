import type { Db } from "../db/connection.js";
import type { Merchant } from "./types.js";

interface MerchantRow {
  id: string;
  slug: string;
  display_name: string;
  tags: string;
  operator_user_ids: string;
  creation_idempotency_key: string | null;
  request_fingerprint: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    tags: JSON.parse(row.tags || "[]"),
    operatorUserIds: JSON.parse(row.operator_user_ids || "[]"),
    creationIdempotencyKey: row.creation_idempotency_key,
    requestFingerprint: row.request_fingerprint,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function insertMerchant(db: Db, merchant: Merchant): Promise<Merchant> {
  await db.exec(
    `INSERT INTO seo_merchants
      (id, slug, display_name, tags, operator_user_ids,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      merchant.id,
      merchant.slug,
      merchant.displayName,
      JSON.stringify(merchant.tags),
      JSON.stringify(merchant.operatorUserIds),
      merchant.creationIdempotencyKey,
      merchant.requestFingerprint,
      merchant.createdBy,
      merchant.createdAt,
      merchant.updatedAt,
    ],
  );
  return merchant;
}

export async function getMerchant(db: Db, id: string): Promise<Merchant | null> {
  const row = await db.one<MerchantRow>(`SELECT * FROM seo_merchants WHERE id = $1`, [id]);
  return row ? toMerchant(row) : null;
}

export async function findMerchantByIdempotencyKey(
  db: Db,
  key: string,
): Promise<Merchant | null> {
  const row = await db.one<MerchantRow>(
    `SELECT * FROM seo_merchants WHERE creation_idempotency_key = $1`,
    [key],
  );
  return row ? toMerchant(row) : null;
}

export async function findMerchantBySlug(db: Db, slug: string): Promise<Merchant | null> {
  const row = await db.one<MerchantRow>(`SELECT * FROM seo_merchants WHERE slug = $1`, [slug]);
  return row ? toMerchant(row) : null;
}

export async function listMerchants(db: Db): Promise<Merchant[]> {
  const rows = await db.query<MerchantRow>(`SELECT * FROM seo_merchants ORDER BY display_name`);
  return rows.map(toMerchant);
}

/** Scope collection roots before callers join locations, tasks, runs, or
 * deliverables. JSON operator lists are stored portably, so membership is
 * checked after decoding rather than relying on database-specific JSON SQL. */
export async function listMerchantsForOperator(db: Db, userId: string): Promise<Merchant[]> {
  return (await listMerchants(db)).filter((merchant) => merchant.operatorUserIds.includes(userId));
}

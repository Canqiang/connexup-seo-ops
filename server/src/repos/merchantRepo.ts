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

export function insertMerchant(db: Db, merchant: Merchant): Merchant {
  db.prepare(
    `INSERT INTO seo_merchants
      (id, slug, display_name, tags, operator_user_ids,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
  );
  return merchant;
}

export function getMerchant(db: Db, id: string): Merchant | null {
  const row = db
    .prepare(`SELECT * FROM seo_merchants WHERE id = ?`)
    .get(id) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByIdempotencyKey(
  db: Db,
  key: string,
): Merchant | null {
  const row = db
    .prepare(`SELECT * FROM seo_merchants WHERE creation_idempotency_key = ?`)
    .get(key) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantBySlug(db: Db, slug: string): Merchant | null {
  const row = db
    .prepare(`SELECT * FROM seo_merchants WHERE slug = ?`)
    .get(slug) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function listMerchants(db: Db): Merchant[] {
  const rows = db
    .prepare(`SELECT * FROM seo_merchants ORDER BY display_name`)
    .all() as MerchantRow[];
  return rows.map(toMerchant);
}

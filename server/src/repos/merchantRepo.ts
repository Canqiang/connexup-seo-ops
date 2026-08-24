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

/** Decode the persisted operator list without allowing strings, objects, or
 * mixed arrays to masquerade as a list of user IDs. */
function decodeOperatorUserIds(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new Error("invalid operator_user_ids");
  }
  return [...new Set(parsed)];
}

/** Runtime reads fail closed so malformed legacy data cannot grant scope or
 * turn portfolio/resource reads into 500 responses. */
function decodeOperatorUserIdsForRuntime(value: string): string[] {
  try {
    return decodeOperatorUserIds(value);
  } catch {
    return [];
  }
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    tags: JSON.parse(row.tags || "[]"),
    operatorUserIds: decodeOperatorUserIdsForRuntime(row.operator_user_ids),
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

/** Replace only a precise legacy operator marker. The JSON list is decoded in
 * application code for PostgreSQL portability, while the full read/update
 * sequence remains bound to one database transaction. */
export async function replaceMerchantOperatorId(
  db: Db,
  fromUserId: string,
  toUserId: string,
): Promise<number> {
  return db.withTransaction(async (tx) => {
    const rows = await tx.query<Pick<MerchantRow, "id" | "operator_user_ids">>(
      `SELECT id, operator_user_ids FROM seo_merchants ORDER BY id FOR UPDATE`,
    );
    let updated = 0;
    for (const row of rows) {
      let operatorUserIds: string[];
      try {
        operatorUserIds = decodeOperatorUserIds(row.operator_user_ids);
      } catch {
        throw new Error(`merchant ${row.id} has invalid operator_user_ids`);
      }
      if (!operatorUserIds.includes(fromUserId)) continue;
      const replacement = [...new Set(operatorUserIds.map((id) => id === fromUserId ? toUserId : id))];
      await tx.exec(
        `UPDATE seo_merchants
         SET operator_user_ids = $2, updated_at = CURRENT_TIMESTAMP::text
         WHERE id = $1`,
        [row.id, JSON.stringify(replacement)],
      );
      updated += 1;
    }
    return updated;
  });
}

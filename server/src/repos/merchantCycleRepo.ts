import crypto from "node:crypto";
import type { Db } from "../db/connection.js";

export interface MerchantCycle {
  id: string;
  merchantId: string;
  startsAt: string;
  status: "ACTIVE" | "CLOSED";
  createdAt: string;
  updatedAt: string;
}

interface MerchantCycleRow {
  id: string;
  merchant_id: string;
  starts_at: string;
  status: "ACTIVE" | "CLOSED";
  created_at: string;
  updated_at: string;
}

function toCycle(row: MerchantCycleRow): MerchantCycle {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    startsAt: row.starts_at,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getActiveMerchantCycle(
  db: Db,
  merchantId: string,
): Promise<MerchantCycle | null> {
  const row = await db.one<MerchantCycleRow>(
    `SELECT id, merchant_id, starts_at, status, created_at, updated_at
       FROM seo_merchant_cycles
      WHERE merchant_id = $1 AND status = 'ACTIVE'
      ORDER BY starts_at DESC, id DESC
      LIMIT 1`,
    [merchantId],
  );
  return row ? toCycle(row) : null;
}

/** Creation paths call this inside their own transaction.  The partial unique
 * index is the concurrent safety net; a loser reads the winner's cycle. */
export async function ensureActiveMerchantCycle(
  db: Db,
  merchantId: string,
  now: string,
): Promise<MerchantCycle> {
  const existing = await getActiveMerchantCycle(db, merchantId);
  if (existing) return existing;
  await db.exec(
    `INSERT INTO seo_merchant_cycles
       (id, merchant_id, starts_at, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'ACTIVE', $3, $3)
     ON CONFLICT (merchant_id) WHERE status = 'ACTIVE' DO NOTHING`,
    [crypto.randomUUID(), merchantId, now],
  );
  const created = await getActiveMerchantCycle(db, merchantId);
  if (!created) throw new Error("active merchant cycle insert did not produce a readable record");
  return created;
}

export async function getMerchantCycle(
  db: Db,
  cycleId: string,
): Promise<MerchantCycle | null> {
  const row = await db.one<MerchantCycleRow>(
    `SELECT id, merchant_id, starts_at, status, created_at, updated_at
       FROM seo_merchant_cycles WHERE id = $1`,
    [cycleId],
  );
  return row ? toCycle(row) : null;
}

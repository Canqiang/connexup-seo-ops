import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";

/** 老库补列(PG 版:用 IF NOT EXISTS,天然幂等)。 */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS mutation_keys TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE seo_merchant_questionnaires ADD COLUMN IF NOT EXISTS last_sent_by TEXT`,
];

const IDENTITY_TYPE_CHECK = "seo_users_identity_type_check";

async function ensureUserIdentityTypeCheck(db: Db): Promise<void> {
  const existing = await db.one<{ constraint_name: string }>(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = current_schema()
       AND table_name = 'seo_users'
       AND constraint_name = $1
       AND constraint_type = 'CHECK'`,
    [IDENTITY_TYPE_CHECK],
  );
  if (existing) return;

  await db.exec(
    `ALTER TABLE seo_users
     ADD CONSTRAINT seo_users_identity_type_check
     CHECK (identity_type IN ('HUMAN', 'SERVICE'))`,
  );
}

export async function migrate(db: Db): Promise<void> {
  await db.withTransaction(async (tx) => {
    for (const statement of SCHEMA_STATEMENTS) await tx.exec(statement);
    for (const statement of COLUMN_MIGRATIONS) await tx.exec(statement);
    await ensureUserIdentityTypeCheck(tx);
  });
}

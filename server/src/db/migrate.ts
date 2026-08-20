import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";

/** 老库补列(PG 版:用 IF NOT EXISTS,天然幂等)。 */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS mutation_keys TEXT NOT NULL DEFAULT '{}'`,
];

export async function migrate(db: Db): Promise<void> {
  await db.withTransaction(async (tx) => {
    for (const statement of SCHEMA_STATEMENTS) await tx.exec(statement);
    for (const statement of COLUMN_MIGRATIONS) await tx.exec(statement);
  });
}

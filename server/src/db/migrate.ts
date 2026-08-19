import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";

/** Additive column migrations for databases created before the column
 * existed. Fails harmlessly when the column is already present. */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE seo_tasks ADD COLUMN mutation_keys TEXT NOT NULL DEFAULT '{}'`,
];

export function migrate(db: Db): void {
  const apply = db.transaction(() => {
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    for (const statement of COLUMN_MIGRATIONS) {
      try {
        db.exec(statement);
      } catch (err) {
        if (!(err instanceof Error && err.message.includes("duplicate column"))) {
          throw err;
        }
      }
    }
  });
  apply();
}

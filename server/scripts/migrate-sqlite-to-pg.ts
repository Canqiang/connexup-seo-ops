// server/scripts/migrate-sqlite-to-pg.ts —— 一次性:把现有 SQLite 开发库导入 PG。
// 用法: DATABASE_URL=... npx tsx scripts/migrate-sqlite-to-pg.ts ../data/seo-ops.db
import Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";

const TABLES = [
  "seo_merchants", "seo_locations", "seo_tasks",
  "seo_agent_runs", "seo_run_deliverables", "seo_merchant_questionnaires",
]; // 以 schema.ts 的 CREATE TABLE 清单为准,缺一不可

const sqlitePath = process.argv[2];
if (!sqlitePath) throw new Error("usage: migrate-sqlite-to-pg.ts <sqlite-file>");
const sqlite = new Database(sqlitePath, { readonly: true });
const pgDb = createDb(process.env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev");

await migrate(pgDb);
for (const table of TABLES) {
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const cols = Object.keys(row);
    await pgDb.exec(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT DO NOTHING`,
      cols.map((c) => row[c]),
    );
  }
  const [{ count }] = await pgDb.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  console.log(`${table}: sqlite=${rows.length} pg=${count}`);
  if (Number(count) < rows.length) throw new Error(`row count mismatch on ${table}`);
}
await pgDb.close();

import crypto from "node:crypto";
import pg from "pg";
import { createDb, type Db } from "../../src/db/connection.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev";

/** 每次调用建一个随机 schema,连接池 search_path 钉在该 schema 上;
 * teardown 时 CASCADE 删除。多个测试文件并行互不干扰。 */
export async function createTestDb(): Promise<{ db: Db; schema: string; teardown(): Promise<void> }> {
  const schema = `test_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const db = createDb(url, { searchPath: schema });
  return {
    db,
    schema,
    async teardown() {
      await db.close();
      const cleaner = new pg.Client({ connectionString: url });
      await cleaner.connect();
      await cleaner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await cleaner.end();
    },
  };
}

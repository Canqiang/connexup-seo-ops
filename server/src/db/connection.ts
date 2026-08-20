import pg from "pg";

export interface Db {
  query<T = unknown>(text: string, params?: unknown[]): Promise<T[]>;
  one<T = unknown>(text: string, params?: unknown[]): Promise<T | null>;
  exec(text: string, params?: unknown[]): Promise<number>;
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function clientDb(client: pg.PoolClient): Db {
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await client.query(text, params)).rows as T[];
    },
    async one<T>(text: string, params?: unknown[]) {
      const rows = (await client.query(text, params)).rows as T[];
      return rows[0] ?? null;
    },
    async exec(text: string, params?: unknown[]) {
      return (await client.query(text, params)).rowCount ?? 0;
    },
    async withTransaction() {
      throw new Error("nested transactions are not supported");
    },
    async close() {
      /* owned by the pool */
    },
  };
}

export function createDb(databaseUrl: string, opts: { searchPath?: string } = {}): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    ...(opts.searchPath ? { options: `-c search_path=${opts.searchPath}` } : {}),
  });
  return {
    async query<T>(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rows as T[];
    },
    async one<T>(text: string, params?: unknown[]) {
      const rows = (await pool.query(text, params)).rows as T[];
      return rows[0] ?? null;
    },
    async exec(text: string, params?: unknown[]) {
      return (await pool.query(text, params)).rowCount ?? 0;
    },
    async withTransaction<T>(fn: (tx: Db) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(clientDb(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

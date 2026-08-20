# PostgreSQL 迁移实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `connexup-seo-ops/server` 的存储层从 better-sqlite3(同步)迁到 PostgreSQL(异步),行为零变化——现有 122 个服务端测试是验收标准。

**Architecture:** 引入 `pg` 连接池并定义统一的异步 `Db` 接口;DDL 移植到 PG 方言;全部 repo/service/route/poller 按固定转换规则改异步;测试改用"每测试文件一个隔离 schema"的真实 PG;最后用一次性脚本把现有 SQLite 开发数据导入 PG。这是行为保持型迁移:**中间任务以 `tsc --noEmit` 为门,测试在 Task 6 统一转绿**(sync→async 是全量翻转,无法半绿)。

**Tech Stack:** PostgreSQL 16、pg(node-postgres)、docker compose(本地 PG)、TypeScript、Vitest

**Spec:** `docs/superpowers/specs/2026-08-20-seo-ops-execution-agent-design.md` §5

## Global Constraints

- 不改 `core-ai` 仓库任何代码。
- 行为零变化:不新增功能、不改 wire 格式、不改业务逻辑;时间戳仍存 ISO-8601 TEXT,JSON 列仍存 TEXT(JSON.stringify)——最小化行为差异,JSONB 留给后续计划。
- 本计划在分支 `pg-migration` 上执行(执行时用 superpowers:using-git-worktrees 建隔离工作区),Task 3–5 允许"typecheck 绿、测试暂红"的提交;合入 main 前必须全绿。
- 环境变量:`DATABASE_URL`(默认 `postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev`)取代 `DB_PATH`;测试用 `TEST_DATABASE_URL ?? DATABASE_URL`。
- Placeholder 规则:SQLite `?` 一律按出现顺序改成 `$1..$n`。
- 前端零改动。

---

### Task 1: PG 基础设施(compose、连接池、测试 schema 隔离)

**Files:**
- Create: `docker-compose.yml`(仓库根)
- Modify: `server/src/config.ts`(dbPath → databaseUrl)
- Modify: `server/src/db/connection.ts`(全量重写)
- Create: `server/tests/helpers/pgTest.ts`
- Create: `server/tests/connection.test.ts`
- Modify: `server/package.json`(deps + `pretest` 提示)

**Interfaces:**
- Produces(后续所有任务依赖):
  - `interface Db { query<T>(text, params?): Promise<T[]>; one<T>(text, params?): Promise<T|null>; exec(text, params?): Promise<number>; withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>; close(): Promise<void> }`
  - `createDb(databaseUrl: string, opts?: { searchPath?: string }): Db`
  - `createTestDb(): Promise<{ db: Db; schema: string; teardown(): Promise<void> }>`(pgTest)
  - `isUniqueViolation(error: unknown): boolean`(PG 错误码 `23505`)

- [ ] **Step 1: 写 docker-compose.yml 并启动 PG**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: seo_ops
      POSTGRES_PASSWORD: seo_ops
      POSTGRES_DB: seo_ops_dev
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata: {}
```

Run: `docker compose up -d && docker compose ps`
Expected: postgres 容器 running。(机器无 docker 时先装 Docker Desktop 或 `brew install colima docker && colima start`。)

- [ ] **Step 2: 安装依赖**

Run: `npm --prefix server i pg && npm --prefix server i -D @types/pg`
Expected: 安装成功;better-sqlite3 暂不移除(Task 7 的导入脚本还要用)。

- [ ] **Step 3: 写失败测试(连接、隔离 schema、事务、唯一冲突探测)**

`server/tests/connection.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src/db/connection.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
afterAll(() => ctx.teardown());

describe("pg connection", () => {
  it("queries inside the isolated schema", async () => {
    await ctx.db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    await ctx.db.exec(`INSERT INTO t (id) VALUES ($1)`, ["a"]);
    expect(await ctx.db.one<{ id: string }>(`SELECT id FROM t WHERE id = $1`, ["a"])).toEqual({ id: "a" });
    expect(await ctx.db.query(`SELECT id FROM t`)).toHaveLength(1);
  });

  it("withTransaction rolls back on throw", async () => {
    await ctx.db.exec(`CREATE TABLE tx (id TEXT PRIMARY KEY)`);
    await expect(
      ctx.db.withTransaction(async (tx) => {
        await tx.exec(`INSERT INTO tx (id) VALUES ('x')`);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await ctx.db.query(`SELECT * FROM tx`)).toHaveLength(0);
  });

  it("detects unique violations by PG error code", async () => {
    await ctx.db.exec(`CREATE TABLE u (id TEXT PRIMARY KEY)`);
    await ctx.db.exec(`INSERT INTO u (id) VALUES ('a')`);
    const error = await ctx.db.exec(`INSERT INTO u (id) VALUES ('a')`).catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error("other"))).toBe(false);
  });
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `npm --prefix server test -- tests/connection.test.ts`
Expected: FAIL——`createTestDb`/新 `Db` 尚不存在(模块解析错误即为正确失败)。

- [ ] **Step 5: 实现 connection.ts 与 pgTest.ts**

`server/src/db/connection.ts`(全量替换):

```ts
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
```

`server/tests/helpers/pgTest.ts`:

```ts
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
```

`server/src/config.ts`:把 `dbPath: string` 改为 `databaseUrl: string`,加载处改为
`databaseUrl: env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev"`,删除 `path.resolve(...data/seo-ops.db)` 与相关 import(config 其余字段不动)。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm --prefix server test -- tests/connection.test.ts`
Expected: 3 PASS。(此时其他文件编译已坏——本任务只跑该文件。)

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml server/src/db/connection.ts server/src/config.ts server/tests/helpers/pgTest.ts server/tests/connection.test.ts server/package.json server/package-lock.json
git commit -m "feat(pg): pg pool Db interface, compose, schema-isolated test harness"
```

---

### Task 2: Schema DDL 与 migrate 移植

**Files:**
- Modify: `server/src/db/schema.ts`(方言移植)
- Modify: `server/src/db/migrate.ts`(全量重写)
- Create: `server/tests/migrate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Db`/`createTestDb`
- Produces: `migrate(db: Db): Promise<void>`(幂等);`SCHEMA_STATEMENTS: string[]` 保持导出名不变

- [ ] **Step 1: 写失败测试**

`server/tests/migrate.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pgTest.js";

const ctx = await createTestDb();
afterAll(() => ctx.teardown());

describe("migrate on postgres", () => {
  it("creates all tables and is idempotent", async () => {
    await migrate(ctx.db);
    await migrate(ctx.db); // 幂等:第二次不抛
    const tables = await ctx.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [ctx.schema],
    );
    const names = tables.map((t) => t.table_name).sort();
    for (const expected of [
      "seo_merchants", "seo_locations", "seo_tasks",
      "seo_agent_runs", "seo_run_deliverables", "seo_merchant_questionnaires",
    ]) {
      expect(names).toContain(expected);
    }
    // 增量列迁移生效
    const cols = await ctx.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'seo_tasks'`,
      [ctx.schema],
    );
    expect(cols.map((c) => c.column_name)).toContain("mutation_keys");
  });
});
```

(若现库表名与上面清单不一致,以 `schema.ts` 现有 CREATE TABLE 语句为准修正清单——先 `grep "CREATE TABLE" server/src/db/schema.ts` 对齐。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npm --prefix server test -- tests/migrate.test.ts`
Expected: FAIL(migrate 仍是同步 SQLite 版,类型/运行错误)。

- [ ] **Step 3: 移植 schema.ts 方言**

逐条改写 `SCHEMA_STATEMENTS`,规则:

| SQLite | PostgreSQL |
| --- | --- |
| `TEXT` / `INTEGER` / `REAL` | 不变(PG 原生支持) |
| `INTEGER` 存布尔的列 | 保持 `INTEGER`(0/1,行为零变化) |
| `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` | 语法相同,保留 |
| `AUTOINCREMENT`(如有) | `GENERATED ALWAYS AS IDENTITY` |
| `WITHOUT ROWID`(如有) | 删除 |
| 双引号/反引号标识符 | 统一小写蛇形,不加引号 |

时间戳列保持 TEXT(ISO-8601),JSON 列保持 TEXT——见全局约束。

- [ ] **Step 4: 重写 migrate.ts**

```ts
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
```

删除原文件里的 SQLite 专用内容:`PRAGMA table_info`、`sqlite_master` 探测、`rebuildAgentRunsIfLegacy` 整段及其 Legacy 类型(历史 SQLite 库的一次性重建已完成使命;PG 库从空库+导入脚本开始,永远不会有 legacy 形态)。若 migrate.ts 中还有其他 `crypto` 等仅供 legacy 段使用的 import,一并删除。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm --prefix server test -- tests/migrate.test.ts tests/connection.test.ts`
Expected: 全 PASS。

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.ts server/src/db/migrate.ts server/tests/migrate.test.ts
git commit -m "feat(pg): port DDL and idempotent migrate, drop sqlite legacy rebuild"
```

---

### Task 3: Repo 层异步移植(5 个文件)

**Files:**
- Modify: `server/src/repos/merchantRepo.ts`、`locationRepo.ts`、`taskRepo.ts`、`agentRunRepo.ts`、`questionnaireRepo.ts`

**Interfaces:**
- Consumes: Task 1 `Db`
- Produces: 每个导出函数**名字与参数不变**,返回类型包一层 Promise(如 `getMerchant(db, id): Promise<Merchant | null>`)。

**统一转换规则(每个函数照此机械改写):**

| better-sqlite3 | pg 版 |
| --- | --- |
| `db.prepare(sql).get(...args) as Row \| undefined` | `await db.one<Row>(sql$, [args])`(返回 `Row \| null`;调用处 `undefined` 判断改 `null`) |
| `db.prepare(sql).all(...args) as Row[]` | `await db.query<Row>(sql$, [args])` |
| `db.prepare(sql).run(...args)` | `await db.exec(sql$, [args])` |
| `.run(...)` 后取 `changes` | `exec` 的返回值就是 rowCount |
| SQL 里的 `?` | 按顺序 `$1..$n`(上表记为 sql$) |
| `IN (${ids.map(() => "?").join(", ")})` 动态占位 | `IN (${ids.map((_, i) => `$${i + 1}`).join(", ")})` |
| 函数签名 `function f(db: Db, ...): T` | `async function f(db: Db, ...): Promise<T>` |

**范例(merchantRepo.ts 的 insert/get,其余函数同规则逐个改):**

```ts
export async function insertMerchant(db: Db, merchant: Merchant): Promise<Merchant> {
  await db.exec(
    `INSERT INTO seo_merchants
      (id, slug, display_name, tags, operator_user_ids,
       creation_idempotency_key, request_fingerprint, created_by,
       created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      merchant.id, merchant.slug, merchant.displayName,
      JSON.stringify(merchant.tags), JSON.stringify(merchant.operatorUserIds),
      merchant.creationIdempotencyKey, merchant.requestFingerprint,
      merchant.createdBy, merchant.createdAt, merchant.updatedAt,
    ],
  );
  return merchant;
}

export async function getMerchant(db: Db, id: string): Promise<Merchant | null> {
  const row = await db.one<MerchantRow>(`SELECT * FROM seo_merchants WHERE id = $1`, [id]);
  return row ? toMerchant(row) : null;
}
```

**各文件特别注意点:**
- `agentRunRepo.ts`:`upsertDeliverable` 的 `ON CONFLICT(id) DO UPDATE SET ... = excluded.*` 语法 PG 兼容,只改占位符;`transitionAgentRun` 是条件更新(乐观锁),`WHERE status IN (...)` 动态占位按规则处理,返回布尔的地方用 rowCount 判断;`listDeliverablesByRunIds` 空数组入参时直接返回空 Map,不发 SQL(`IN ()` 在 PG 是语法错误)。
- `taskRepo.ts`:多子表读取(revisions/evidence/approvals/events/links)全部 await;保持读取顺序。
- 整数列:pg 对 `INTEGER` 返回 number,与现行为一致,无需处理;若有 `COUNT(*)`,PG 返回 **string**(bigint),用 `Number(...)` 包一层——`grep -n "COUNT(" server/src/repos server/src/services` 逐处检查。

- [ ] **Step 1: 按规则移植全部 5 个 repo 文件**
- [ ] **Step 2: typecheck 门**

Run: `npm --prefix server run typecheck`
Expected: repos 目录无错误;services/routes 的调用处报错属预期(Task 4/5 处理)。用 `npx tsc --noEmit 2>&1 | grep "src/repos"` 验证 repos 自身干净。

- [ ] **Step 3: Commit**

```bash
git add server/src/repos
git commit -m "refactor(pg): async repo layer on pg placeholders"
```

---

### Task 4: Service 层与 poller 异步移植

**Files:**
- Modify: `server/src/services/merchantService.ts`、`taskService.ts`、`questionnaireService.ts`、`agentRunService.ts`、`queryService.ts`、`lifecycleService.ts`、`rankingService.ts`、`agentRunPoller.ts`

**Interfaces:**
- Consumes: Task 3 异步 repo
- Produces: 所有导出函数异步化(名字参数不变,返回包 Promise);`loadLifecycleInputs`/`preloadTasksByMerchant`/`deriveLifecycleForDb`/`loadRankingSnapshots` 变 async;**纯函数不动**(`deriveLifecycle`、`deriveException`、`deriveRankingOverview`、`parseRankingCsv` 保持同步——它们不碰 db)。

**转换要点:**
1. 所有 repo 调用前加 `await`;函数签名加 `async`/`Promise`。
2. `db.transaction(() => {...})` 共 6 处(merchantService×2、taskService×2、questionnaireService、agentRunService)→ `await db.withTransaction(async (tx) => {...})`,**回调内部所有 repo 调用把 `db` 换成 `tx`**——这是本任务最容易漏的点,逐处检查回调体。
3. `agentRunService.ts:222` 注释"Network I/O must stay OUTSIDE db.transaction"——语义保留:Core AI HTTP 调用仍在事务外,只是事务变异步。
4. `merchantService.ts:157` 的 UNIQUE 冲突探测(better-sqlite3 错误形状)→ 改用 Task 1 的 `isUniqueViolation`(PG `23505`),删除旧探测函数。
5. `agentRunPoller.ts`:循环体内 repo 调用 await 化;`pollOnce` 变 async(现有测试已按调用其返回值写,签名不变仅包 Promise)。
6. `rankingService.ts` 的 `fs.readFileSync` 保留(读本地附件与 db 无关)。

- [ ] **Step 1: 按要点移植全部 8 个文件**
- [ ] **Step 2: typecheck 门**

Run: `npx tsc --noEmit 2>&1 | grep -v "tests/"` (在 server/ 下)
Expected: src/ 下仅剩 routes 与 index 的调用处错误(Task 5 处理);services 自身干净。

- [ ] **Step 3: Commit**

```bash
git add server/src/services
git commit -m "refactor(pg): async services and poller, pg unique-violation detection"
```

---

### Task 5: 路由层与 buildApp

**Files:**
- Modify: `server/src/routes/seoOps.ts`(handler 内加 await)
- Modify: `server/src/index.ts`(openDatabase → createDb;onClose 关池;deps.db 注入口)
- Modify: `server/src/views/mappers.ts`(若有 db 读取则 await 化;纯映射不动)

**Interfaces:**
- Consumes: Task 4 异步 services
- Produces: `buildApp(config?, deps?)` 新增 `deps.db?: Db`(测试注入隔离 schema 的 Db);返回值仍为 `{ app, config, db, poller }`,其中 `db: Db`。

- [ ] **Step 1: index.ts 改造**

```ts
// 原: const db = openDatabase(config.dbPath); migrate(db);
const db = deps.db ?? createDb(config.databaseUrl);
// migrate 变异步:buildApp 无法 await(保持同步签名会破坏所有调用点吗?
// —— buildApp 本身改为 async function buildApp(...): Promise<{...}>,
// 生产入口与全部测试调用点同步跟进(测试改法见 Task 6)。
await migrate(db);
```

`app.addHook("onClose", ...)` 中 `db.close()` 变 `await db.close()`;`deps.db` 注入时 onClose **不关**(归测试 harness 管)——用布尔 `ownsDb = !deps.db` 区分。生产入口 `if (isMain)` 块加 `await`(顶层 await,ESM 可用)。

- [ ] **Step 2: seoOps.ts 全部 handler 加 await**

规则:每个 `async (request, reply) => { ... }` 体内,凡调用 service/repo 的表达式加 `await`(handler 本就 async,只是原先调用是同步的)。逐个 route 过一遍,`npx tsc --noEmit` 提示的每个 "Promise<...> is not assignable" 就是漏掉的点。

- [ ] **Step 3: typecheck 门(src 全绿)**

Run: `npx tsc --noEmit 2>&1 | grep -v "tests/"`
Expected: 无输出(src/ 全部干净;tests/ 的错误 Task 6 处理)。

- [ ] **Step 4: Commit**

```bash
git add server/src
git commit -m "refactor(pg): async buildApp with injectable Db, awaited route handlers"
```

---

### Task 6: 测试全量转绿(验收门)

**Files:**
- Modify: `server/tests/*.test.ts` 全部 11 个既有文件(+ Task 1/2 新增的 2 个已是 PG 形态)

**Interfaces:**
- Consumes: Task 1 `createTestDb`、Task 5 异步 `buildApp`

**统一改法:**

1. 用 buildApp 的文件(merchantService/taskService/queryService/questionnaires/agentRuns/ranking):

```ts
// 旧
const { app, db } = buildApp({ ...loadConfig(), dbPath: ":memory:" }, { coreAi, artifactsDir });
// 新
import { createTestDb } from "./helpers/pgTest.js";
const ctx = await createTestDb();            // 文件顶层一次
afterAll(() => ctx.teardown());
async function makeApp(...) {
  return await buildApp(
    { ...loadConfig(), /* dbPath 字段已删,不再传 */ ...overrides },
    { coreAi, artifactsDir, db: ctx.db },
  );
}
```

   同一文件多个测试共享一个 schema 时,若既有测试依赖"每 app 空库"(如按 slug 断言唯一),给 makeApp 加 per-test schema:改为每个 makeApp 调用 `createTestDb()` 并在测试内 teardown——**以现有断言为准,哪个文件红了按此升级隔离粒度**。
2. 直接 `openDatabase(":memory:")` 的文件(agentRunPoller):改 `const ctx = await createTestDb(); await migrate(ctx.db);` 取 `ctx.db`。
3. 纯函数测试(lifecycle、agentRunPrompt、hashing、stateMachine)理论上零改动;若 import 链上类型变了按编译器提示修。
4. 所有对原同步 service/repo 的直接调用加 `await`。

- [ ] **Step 1: 逐文件转换并跑通(建议顺序:纯函数 → poller → 各路由文件)**

Run(每转一个): `npm --prefix server test -- tests/<file>.test.ts`
Expected: 该文件 PASS。

- [ ] **Step 2: 全量验收**

Run: `npm --prefix server test && npm --prefix server run typecheck`
Expected: **126 个测试全绿(122 既有 + connection 3 + migrate 1,以实际数为准)**、typecheck 无错。红一个修一个,不许跳过。

- [ ] **Step 3: Commit**

```bash
git add server/tests
git commit -m "test(pg): full suite green on schema-isolated postgres"
```

---

### Task 7: 数据导入、收尾与合入

**Files:**
- Create: `server/scripts/migrate-sqlite-to-pg.ts`
- Modify: `server/package.json`(better-sqlite3 移到 devDependencies;加 script `migrate:from-sqlite`)
- Modify: `server/.env`(本地 DATABASE_URL;不提交敏感值)、`README.md`(PG 前置条件一段)

- [ ] **Step 1: 写导入脚本**

```ts
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
```

- [ ] **Step 2: 对开发库实跑并核对行数**

Run: `cd server && npx tsx scripts/migrate-sqlite-to-pg.ts ../data/seo-ops.db`
Expected: 每表打印 sqlite=N pg=N,无 mismatch。

- [ ] **Step 3: 依赖与文档收尾**

better-sqlite3/@types/better-sqlite3 移到 devDependencies(仅导入脚本用);README 加"本地开发需 `docker compose up -d`,连接串 DATABASE_URL"一段;`server/.env` 示例更新。确认生产代码无 better-sqlite3 import:`grep -rn "better-sqlite3" server/src` 应只剩 scripts/。

- [ ] **Step 4: 终验收**

Run: `npm --prefix server test && npm --prefix server run typecheck && npm run test:run && npm run build`
Expected: 服务端全绿、前端全绿(前端零改动)、构建成功。手动冒烟:`npm --prefix server run dev` + 前端 `npm run dev`,打开商户页确认数据来自 PG。

- [ ] **Step 5: Commit 并合入**

```bash
git add server/scripts server/package.json server/package-lock.json README.md
git commit -m "feat(pg): sqlite data import script, dependency and docs cleanup"
# 分支全绿后回 main 合并(fast-forward 或 merge,按 superpowers:finishing-a-development-branch)
```

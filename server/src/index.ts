import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { registerActorResolution } from "./auth/httpAuth.js";
import { loadConfig, type ServerConfig } from "./config.js";
import { createDb, type Db } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import {
  registerErrorHandler,
  registerSeoOpsRoutes,
} from "./routes/seoOps.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerExecutionRoutes } from "./routes/executionRoutes.js";
import { registerWorkbenchRoutes } from "./routes/workbenchRoutes.js";
import { registerMerchantControlRoomRoutes } from "./routes/merchantControlRoomRoutes.js";
import { createCoreAiClient, type CoreAiClient } from "./services/coreAiClient.js";
import { AgentRunPoller } from "./services/agentRunPoller.js";
import { ExecutionWorker } from "./services/executionWorker.js";
import { CycleScheduler } from "./services/schedulerService.js";
import { ensureSingleUserIdentity } from "./auth/singleUser.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface AppContext {
  config: ServerConfig;
  db: Db;
  /** Null when core-ai env is not fully configured (agent runs disabled). */
  coreAi: CoreAiClient | null;
  /** Directory where completed run outputs are persisted as artifacts. */
  artifactsDir: string;
  /** 执行 worker（attempt 派发/结算）；mock 或 core-ai 配置齐时非 null。 */
  executionWorker: ExecutionWorker | null;
  /** 周期 scheduler（Ⓐ级任务自动生成+派发清扫）。 */
  scheduler: CycleScheduler | null;
}

/** Test seams: inject a fake client/poller/db, or pass null to force-disable. */
export interface AppDeps {
  coreAi?: CoreAiClient | null;
  poller?: AgentRunPoller | null;
  artifactsDir?: string;
  /** Injected Db (e.g. an isolated test schema). When set, buildApp does not
   * close it in onClose — that stays the caller's responsibility. */
  db?: Db;
}

export async function buildApp(
  config: ServerConfig = loadConfig(),
  deps: AppDeps = {},
): Promise<{ app: FastifyInstance; config: ServerConfig; db: Db; poller: AgentRunPoller | null }> {
  const ownsDb = !deps.db;
  const db = deps.db ?? createDb(config.databaseUrl);
  await migrate(db);
  if (config.singleUserMode) await ensureSingleUserIdentity(db);

  const coreAi =
    deps.coreAi !== undefined
      ? deps.coreAi
      : config.coreAiBaseUrl && config.coreAiToken
        ? createCoreAiClient({
            baseUrl: config.coreAiBaseUrl,
            token: config.coreAiToken,
            timeoutMs: config.agentRunHttpTimeoutMs,
          })
        : null;
  const artifactsDir =
    deps.artifactsDir ?? path.resolve(moduleDir, "../../data/artifacts");

  // 执行 worker：mock 模式（无外部副作用）或 core-ai 配置齐全时可用。
  const executionWorker =
    config.mockExecution || coreAi
      ? new ExecutionWorker({
          db,
          client: coreAi,
          mockMode: config.mockExecution,
          intervalMs: config.executionPollIntervalMs,
          log: (message, err) => console.warn(message, err ?? ""),
        })
      : null;
  const scheduler = new CycleScheduler(
    { db, log: (message, err) => console.warn(message, err ?? "") },
    config.schedulerIntervalMs,
  );

  const ctx: AppContext = { config, db, coreAi, artifactsDir, executionWorker, scheduler };

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  await app.register(cookie);

  app.get("/health-check", async () => ({ status: "ok" }));

  registerErrorHandler(app);
  registerActorResolution(app, ctx);
  registerAuthRoutes(app, ctx);
  registerSeoOpsRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
  registerWorkbenchRoutes(app, ctx);
  registerMerchantControlRoomRoutes(app, ctx);

  // 定时器不在测试环境下启动；手动 tick 端点始终可用。
  if (process.env.NODE_ENV !== "test") {
    executionWorker?.start();
    scheduler.start();
  }

  let poller: AgentRunPoller | null = null;
  if (ctx.coreAi && deps.poller !== null) {
    poller =
      deps.poller ??
      new AgentRunPoller({
        db,
        client: ctx.coreAi,
        artifactsDir,
        intervalMs: config.agentRunPollIntervalMs,
        log: app.log,
      });
    // Never started under vitest; boot pollOnce adopts leftover RUNNING rows.
    if (process.env.NODE_ENV !== "test") poller.start();
  }

  app.addHook("onClose", async () => {
    // Stop the poller/workers before closing the pool so they can't fire a
    // query against an already-closed connection.
    poller?.stop();
    executionWorker?.stop();
    scheduler.stop();
    if (ownsDb) await db.close();
  });

  return { app, config, db, poller };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, config } = await buildApp();
  app.listen({ port: config.port, host: config.host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

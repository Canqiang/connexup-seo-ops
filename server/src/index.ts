import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import {
  registerErrorHandler,
  registerSeoOpsRoutes,
} from "./routes/seoOps.js";
import { createCoreAiClient, type CoreAiClient } from "./services/coreAiClient.js";
import { AgentRunPoller } from "./services/agentRunPoller.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface AppContext {
  config: ServerConfig;
  db: Db;
  /** Null when core-ai env is not fully configured (agent runs disabled). */
  coreAi: CoreAiClient | null;
  /** Directory where completed run outputs are persisted as artifacts. */
  artifactsDir: string;
}

/** Test seams: inject a fake client/poller, or pass null to force-disable. */
export interface AppDeps {
  coreAi?: CoreAiClient | null;
  poller?: AgentRunPoller | null;
  artifactsDir?: string;
}

export function buildApp(config: ServerConfig = loadConfig(), deps: AppDeps = {}) {
  const db = openDatabase(config.dbPath);
  migrate(db);

  const coreAi =
    deps.coreAi !== undefined
      ? deps.coreAi
      : config.coreAiBaseUrl && config.coreAiToken && config.agentRunAgentId
        ? createCoreAiClient({
            baseUrl: config.coreAiBaseUrl,
            token: config.coreAiToken,
            timeoutMs: config.agentRunHttpTimeoutMs,
          })
        : null;
  const artifactsDir =
    deps.artifactsDir ?? path.resolve(moduleDir, "../../data/artifacts");
  const ctx: AppContext = { config, db, coreAi, artifactsDir };

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });

  app.get("/health-check", async () => ({ status: "ok" }));

  registerErrorHandler(app);
  registerSeoOpsRoutes(app, ctx);

  let poller: AgentRunPoller | null = null;
  if (ctx.coreAi && config.agentRunAgentId && deps.poller !== null) {
    poller =
      deps.poller ??
      new AgentRunPoller({
        db,
        client: ctx.coreAi,
        agentId: config.agentRunAgentId,
        artifactsDir,
        intervalMs: config.agentRunPollIntervalMs,
        log: app.log,
      });
    // Never started under vitest; boot pollOnce adopts leftover RUNNING rows.
    if (process.env.NODE_ENV !== "test") poller.start();
  }

  app.addHook("onClose", async () => {
    poller?.stop();
    db.close();
  });

  return { app, config, db, poller };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, config } = buildApp();
  app.listen({ port: config.port, host: config.host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

import Fastify from "fastify";
import { fileURLToPath } from "node:url";
import { loadConfig, type ServerConfig } from "./config.js";
import { openDatabase, type Db } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import {
  registerErrorHandler,
  registerSeoOpsRoutes,
} from "./routes/seoOps.js";

export interface AppContext {
  config: ServerConfig;
  db: Db;
}

export function buildApp(config: ServerConfig = loadConfig()) {
  const db = openDatabase(config.dbPath);
  migrate(db);

  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  const ctx: AppContext = { config, db };

  app.get("/health-check", async () => ({ status: "ok" }));

  registerErrorHandler(app);
  registerSeoOpsRoutes(app, ctx);

  app.addHook("onClose", async () => {
    db.close();
  });

  return { app, config, db };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, config } = buildApp();
  app.listen({ port: config.port, host: config.host }).catch((error) => {
    app.log.error(error);
    process.exit(1);
  });
}

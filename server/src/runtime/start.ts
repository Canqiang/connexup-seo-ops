import type { RuntimeRole } from "./role.js";
import { runtimePolicy, resolveRuntimeRole } from "./role.js";
import { fileURLToPath } from "node:url";
import { loadConfig, type ServerConfig } from "../config.js";
import { buildApp } from "../index.js";

interface Startable {
  start(): void;
  stop(): void;
}

export interface RuntimeComponents {
  poller: Startable | null;
  executionWorker: Startable | null;
  gbpExecutionWorker: Startable | null;
  scheduler: Startable | null;
}

export function startRuntimeComponents(
  role: RuntimeRole,
  components: RuntimeComponents,
): void {
  const policy = runtimePolicy(role);
  if (policy.workers) {
    components.poller?.start();
    components.executionWorker?.start();
    components.gbpExecutionWorker?.start();
  }
  if (policy.scheduler) components.scheduler?.start();
}

export async function startRuntime(
  config: ServerConfig = loadConfig(),
  role: RuntimeRole = resolveRuntimeRole(
    process.env.SEO_OPS_RUNTIME_ROLE,
    process.env.NODE_ENV,
  ),
) {
  const built = await buildApp(config);
  startRuntimeComponents(role, built);
  if (runtimePolicy(role).http) {
    await built.app.listen({ port: config.port, host: config.host });
  } else {
    built.app.log.info({ role }, "SEO Ops background runtime started");
  }
  return {
    ...built,
    role,
    close: () => built.app.close(),
  };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const runtime = await startRuntime().catch((error) => {
    console.error(error);
    process.exit(1);
  });
  if (runtime) {
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      await runtime.close();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  coreAiBaseUrl: string | null;
  coreAiToken: string | null;
  copilotAgentId: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? "8787"),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? path.resolve(moduleDir, "../../data/seo-ops.db"),
    coreAiBaseUrl: env.CORE_AI_BASE_URL?.trim() || null,
    coreAiToken: env.CORE_AI_TOKEN?.trim() || null,
    copilotAgentId: env.COPILOT_AGENT_ID?.trim() || null,
  };
}

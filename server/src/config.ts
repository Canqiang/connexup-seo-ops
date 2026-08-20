import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ServerConfig {
  port: number;
  host: string;
  dbPath: string;
  coreAiBaseUrl: string | null;
  coreAiToken: string | null;
  copilotAgentId: string | null;
  /** Agent the operator agent-run panel drives (unified local SEO agent). */
  agentRunAgentId: string | null;
  agentRunPollIntervalMs: number;
  agentRunHttpTimeoutMs: number;
  /** Per-merchant daily stage-run cap (core-ai token quota protection). */
  agentRunDailyLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? "8787"),
    host: env.HOST ?? "127.0.0.1",
    dbPath: env.DB_PATH ?? path.resolve(moduleDir, "../../data/seo-ops.db"),
    coreAiBaseUrl: env.CORE_AI_BASE_URL?.trim() || null,
    coreAiToken: env.CORE_AI_TOKEN?.trim() || null,
    copilotAgentId: env.COPILOT_AGENT_ID?.trim() || null,
    agentRunAgentId: env.AGENT_RUN_AGENT_ID?.trim() || null,
    agentRunPollIntervalMs: positiveInt(env.AGENT_RUN_POLL_INTERVAL_MS, 3000),
    agentRunHttpTimeoutMs: positiveInt(env.AGENT_RUN_HTTP_TIMEOUT_MS, 15000),
    agentRunDailyLimit: positiveInt(env.AGENT_RUN_DAILY_LIMIT, 20),
  };
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ServerConfig {
  port: number;
  host: string;
  databaseUrl: string;
  sessionSecret: string;
  sessionTtlHours: number;
  sessionCookieSecure: boolean;
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
  const sessionSecret = env.SESSION_SECRET?.trim()
    || (env.NODE_ENV === "test" ? "test-session-secret-must-have-at-least-32-characters" : "");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  return {
    port: Number(env.PORT ?? "8787"),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev",
    sessionSecret,
    sessionTtlHours: positiveInt(env.SESSION_TTL_HOURS, 12),
    sessionCookieSecure: env.SESSION_COOKIE_SECURE === "true",
    coreAiBaseUrl: env.CORE_AI_BASE_URL?.trim() || null,
    coreAiToken: env.CORE_AI_TOKEN?.trim() || null,
    copilotAgentId: env.COPILOT_AGENT_ID?.trim() || null,
    agentRunAgentId: env.AGENT_RUN_AGENT_ID?.trim() || null,
    agentRunPollIntervalMs: positiveInt(env.AGENT_RUN_POLL_INTERVAL_MS, 3000),
    agentRunHttpTimeoutMs: positiveInt(env.AGENT_RUN_HTTP_TIMEOUT_MS, 15000),
    agentRunDailyLimit: positiveInt(env.AGENT_RUN_DAILY_LIMIT, 20),
  };
}

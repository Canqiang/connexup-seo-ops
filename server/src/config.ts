function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionTtlHours(raw: string | undefined): number {
  if (raw === undefined) return 12;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 720) {
    throw new Error("SESSION_TTL_HOURS must be a safe integer between 1 and 720");
  }
  return parsed;
}

function sessionCookieSecure(raw: string | undefined, nodeEnv: string | undefined): boolean {
  if (raw === undefined) {
    if (nodeEnv === "production") {
      throw new Error("SESSION_COOKIE_SECURE must be explicitly true in production");
    }
    return false;
  }
  if (raw !== "true" && raw !== "false") {
    throw new Error("SESSION_COOKIE_SECURE must be exactly true or false");
  }
  if (nodeEnv === "production" && raw !== "true") {
    throw new Error("SESSION_COOKIE_SECURE must be explicitly true in production");
  }
  return raw === "true";
}

function rejectRetiredAuthenticationBypass(raw: string | undefined): void {
  if (raw !== undefined && raw !== "false") {
    throw new Error("SEO_OPS_AUTH_DISABLED is no longer supported");
  }
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
  /** 单人模式：每个请求都视为本地管理员（全权限、全商户范围），跳过登录。
   * 仅限单人自用部署；多人环境必须关闭。 */
  singleUserMode: boolean;
  /** 冒烟模式：执行派发不打 core-ai，本地模拟成功（无外部副作用）。 */
  mockExecution: boolean;
  /** 周期 scheduler tick 间隔（Ⓐ级任务自动生成+派发清扫）。 */
  schedulerIntervalMs: number;
  /** 执行 worker 轮询间隔（DISPATCHING attempt 派发与终态结算）。 */
  executionPollIntervalMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  rejectRetiredAuthenticationBypass(env.SEO_OPS_AUTH_DISABLED);
  const sessionSecret = env.SESSION_SECRET?.trim()
    || (env.NODE_ENV === "test" ? "test-session-secret-must-have-at-least-32-characters" : "");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }
  // 开发便利开关不许带进生产：单用户模式 = 完全绕过鉴权；mock 执行 = 伪造发布证据链。
  if (env.NODE_ENV === "production") {
    if (env.SEO_OPS_SINGLE_USER === "true") {
      throw new Error("SEO_OPS_SINGLE_USER must not be enabled in production");
    }
    if (env.SEO_OPS_MOCK_EXECUTION === "true") {
      throw new Error("SEO_OPS_MOCK_EXECUTION must not be enabled in production");
    }
  }
  return {
    port: Number(env.PORT ?? "8787"),
    host: env.HOST ?? "127.0.0.1",
    databaseUrl: env.DATABASE_URL ?? "postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev",
    sessionSecret,
    sessionTtlHours: sessionTtlHours(env.SESSION_TTL_HOURS),
    sessionCookieSecure: sessionCookieSecure(env.SESSION_COOKIE_SECURE, env.NODE_ENV),
    coreAiBaseUrl: env.CORE_AI_BASE_URL?.trim() || null,
    coreAiToken: env.CORE_AI_TOKEN?.trim() || null,
    copilotAgentId: env.COPILOT_AGENT_ID?.trim() || null,
    agentRunAgentId: env.AGENT_RUN_AGENT_ID?.trim() || null,
    agentRunPollIntervalMs: positiveInt(env.AGENT_RUN_POLL_INTERVAL_MS, 3000),
    agentRunHttpTimeoutMs: positiveInt(env.AGENT_RUN_HTTP_TIMEOUT_MS, 15000),
    agentRunDailyLimit: positiveInt(env.AGENT_RUN_DAILY_LIMIT, 20),
    singleUserMode: env.SEO_OPS_SINGLE_USER === "true",
    mockExecution: env.SEO_OPS_MOCK_EXECUTION === "true",
    schedulerIntervalMs: positiveInt(env.SEO_OPS_SCHEDULER_INTERVAL_MS, 60_000),
    executionPollIntervalMs: positiveInt(env.SEO_OPS_EXECUTION_POLL_INTERVAL_MS, 10_000),
  };
}

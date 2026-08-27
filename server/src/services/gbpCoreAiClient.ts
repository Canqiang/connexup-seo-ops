import { z } from "zod";
import { GbpCoreApiUserIdSchema } from "../domain/gbpExecutionContract.js";

const UuidSchema = z.string().uuid();
const IdentitySchema = z.object({
  user_id: GbpCoreApiUserIdSchema,
  name: z.string().min(1).max(500),
  role: z.string().min(1).max(100),
  permissions: z.array(z.string().min(1).max(200)).min(1).max(500),
}).passthrough();
const TriggerSchema = z.object({
  run_id: z.string(),
  status: z.string().min(1).max(100),
}).passthrough();
const RunSchema = z.object({
  id: UuidSchema,
  agent_id: UuidSchema,
  status: z.string().min(1).max(100),
  input: z.string().nullable().optional(),
  output: z.string().nullable().optional(),
}).passthrough();

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GbpCoreIdentity {
  userId: string;
  name: string;
  role: string;
  permissions: string[];
}

export interface GbpCoreRun {
  id: string;
  agentId: string;
  status: string;
  input: string | null;
  output: string | null;
}

export interface GbpCoreAiClient {
  getIdentity(): Promise<GbpCoreIdentity>;
  trigger(agentId: string, input: string): Promise<{ runId: string; status: string }>;
  getRun(runId: string): Promise<GbpCoreRun>;
}

/** Safe-only error: response bodies, URLs, request input and bearer values are discarded. */
export class GbpCoreAiError extends Error {
  constructor(public readonly phase: "IDENTITY" | "TRIGGER" | "POLL") {
    super("Core AI GBP request failed");
    this.name = "GbpCoreAiError";
  }
}

function normalizedBaseUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new GbpCoreAiError("IDENTITY"); }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if ((parsed.protocol !== "https:" && !(local && parsed.protocol === "http:"))
    || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new GbpCoreAiError("IDENTITY");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function createGbpCoreAiClient(options: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): GbpCoreAiClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const token = options.token;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const doFetch = options.fetchImpl ?? fetch;

  async function request(
    phase: GbpCoreAiError["phase"],
    method: "GET" | "POST",
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    try {
      const response = await doFetch(`${baseUrl}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new GbpCoreAiError(phase);
      }
      const declaredLength = response.headers.get("content-length");
      if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new GbpCoreAiError(phase);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new GbpCoreAiError(phase);
      return JSON.parse(text);
    } catch (error) {
      if (error instanceof GbpCoreAiError) throw error;
      throw new GbpCoreAiError(phase);
    }
  }

  return {
    async getIdentity() {
      const parsed = IdentitySchema.safeParse(await request("IDENTITY", "GET", "/api/auth/me"));
      if (!parsed.success) throw new GbpCoreAiError("IDENTITY");
      return {
        userId: parsed.data.user_id,
        name: parsed.data.name,
        role: parsed.data.role,
        permissions: [...parsed.data.permissions],
      };
    },
    async trigger(agentId, input) {
      if (!UuidSchema.safeParse(agentId).success || input.length === 0 || input.length > 512_000) {
        throw new GbpCoreAiError("TRIGGER");
      }
      const parsed = TriggerSchema.safeParse(await request(
        "TRIGGER", "POST", `/api/runs/agent/${encodeURIComponent(agentId)}/trigger`, { input },
      ));
      if (!parsed.success) throw new GbpCoreAiError("TRIGGER");
      return { runId: parsed.data.run_id, status: parsed.data.status };
    },
    async getRun(runId) {
      if (!UuidSchema.safeParse(runId).success) throw new GbpCoreAiError("POLL");
      const parsed = RunSchema.safeParse(await request(
        "POLL", "GET", `/api/runs/${encodeURIComponent(runId)}`,
      ));
      if (!parsed.success) throw new GbpCoreAiError("POLL");
      return {
        id: parsed.data.id,
        agentId: parsed.data.agent_id,
        status: parsed.data.status,
        input: parsed.data.input ?? null,
        output: parsed.data.output ?? null,
      };
    },
  };
}

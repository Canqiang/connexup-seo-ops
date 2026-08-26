/** Typed client for the core-ai server-to-server run API.
 *
 * Contract (verified against core-ai Java source):
 * - POST /api/runs/agent/:agentId/trigger  body {"input"} -> 202 {run_id, status}
 * - GET  /api/runs/:id                     -> run detail (snake_case fields)
 * - POST /api/runs/:id/cancel              -> 2xx empty body
 *
 * The bearer token is used ONLY in the Authorization header — never in URLs,
 * error messages, or logs. Non-2xx responses surface as CoreAiError with the
 * remote status and (when JSON) its `message` field only. */

export interface CoreAgentRunDetail {
  id: string;
  agent_id: string;
  triggered_by?: string;
  status: string;
  input?: string | null;
  output?: string | null;
  error?: string | null;
  token_usage?: Record<string, number>;
  trace_id?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  /** File references produced by the agent run (identity + download URL, never bytes). */
  artifacts?: CoreRunArtifact[];
}

export interface CoreRunArtifact {
  file_id: string;
  file_name: string;
  content_type?: string | null;
  size?: number | null;
  /** Public attachment link returned by AgentRunDetailView.ArtifactView. */
  download_url: string;
  title?: string | null;
  description?: string | null;
}

export interface ArtifactDownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
}

export interface CoreAiClient {
  trigger(agentId: string, input: string): Promise<{ run_id: string; status: string }>;
  getRun(runId: string): Promise<CoreAgentRunDetail>;
  cancel(runId: string): Promise<void>;
  /** Download an artifact's bytes; the token goes only in the Authorization header. */
  downloadArtifact(url: string, options?: ArtifactDownloadOptions): Promise<Uint8Array>;
}

export class CoreAiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "CoreAiError";
  }
}

export function createCoreAiClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): CoreAiClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? 15000;
  const doFetch = opts.fetchImpl ?? fetch;

  async function request(
    method: "POST" | "GET",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Never include the token or full URL (query strings) in messages.
      throw new CoreAiError(
        0,
        `core-ai request failed (${method} ${path}): ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let message = `core-ai returned ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed.message === "string" && parsed.message.trim() !== "") {
          message = `core-ai returned ${response.status}: ${parsed.message}`;
        }
      } catch {
        // keep the generic message
      }
      throw new CoreAiError(response.status, message);
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text === "" ? null : JSON.parse(text);
  }

  return {
    async trigger(agentId, input) {
      const body = (await request(
        "POST",
        `/api/runs/agent/${encodeURIComponent(agentId)}/trigger`,
        { input },
      )) as { run_id?: string; status?: string };
      if (!body || typeof body.run_id !== "string" || body.run_id === "") {
        throw new CoreAiError(0, "core-ai trigger response missing run_id");
      }
      return { run_id: body.run_id, status: body.status ?? "RUNNING" };
    },
    async getRun(runId) {
      const body = (await request(
        "GET",
        `/api/runs/${encodeURIComponent(runId)}`,
      )) as CoreAgentRunDetail;
      if (!body || typeof body.status !== "string") {
        throw new CoreAiError(0, "core-ai run detail missing status");
      }
      return body;
    },
    async cancel(runId) {
      await request("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`);
    },
    async downloadArtifact(url, options) {
      let target: URL;
      let configuredBase: URL;
      try {
        configuredBase = new URL(baseUrl);
        target = new URL(url, configuredBase);
      } catch {
        throw new CoreAiError(0, "artifact download URL is invalid");
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new CoreAiError(0, "artifact download URL must use http(s)");
      }
      if (target.origin !== configuredBase.origin) {
        throw new CoreAiError(0, "artifact download origin is not allowed");
      }
      let response: Response;
      try {
        const requestSignal = options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);
        response = await doFetch(target, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: requestSignal,
        });
      } catch {
        throw new CoreAiError(0, "artifact download failed");
      }
      if (!response.ok) {
        throw new CoreAiError(response.status, `artifact download returned ${response.status}`);
      }
      const declaredLength = response.headers.get("content-length");
      const maxBytes = options?.maxBytes ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
        throw new CoreAiError(0, "artifact download byte limit is invalid");
      }
      if (declaredLength !== null && /^\d+$/.test(declaredLength)) {
        const declaredBytes = Number(declaredLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) {
          await response.body?.cancel().catch(() => undefined);
          throw new CoreAiError(0, "artifact download exceeds byte limit");
        }
      }
      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new CoreAiError(0, "artifact download exceeds byte limit");
          }
          chunks.push(value);
        }
      } catch (err) {
        if (err instanceof CoreAiError) throw err;
        throw new CoreAiError(0, "artifact download failed");
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
  };
}

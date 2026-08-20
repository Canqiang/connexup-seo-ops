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
  url: string;
  title?: string | null;
  description?: string | null;
}

export interface CoreAiClient {
  trigger(agentId: string, input: string): Promise<{ run_id: string; status: string }>;
  getRun(runId: string): Promise<CoreAgentRunDetail>;
  cancel(runId: string): Promise<void>;
  /** Download an artifact's bytes; the token goes only in the Authorization header. */
  downloadArtifact(url: string): Promise<Uint8Array>;
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
    async downloadArtifact(url) {
      // Absolute caller-resolvable URL per the core-ai ArtifactRef contract;
      // tolerate relative paths by resolving against the configured base.
      const target = /^https?:\/\//i.test(url) ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
      let response: Response;
      try {
        response = await doFetch(target, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new CoreAiError(0, `artifact download failed: ${err instanceof Error ? err.message : "network error"}`);
      }
      if (!response.ok) {
        throw new CoreAiError(response.status, `artifact download returned ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}

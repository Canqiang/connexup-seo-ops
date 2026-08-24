import { requestJson } from "./client";
import type { IdName } from "./types";
import { redirectToLogin } from "../auth/redirect";

export type SessionCreateResponse = { sessionId: string; loaded_tools?: IdName[]; loaded_skills?: IdName[]; loaded_sub_agents?: IdName[] };
export type StreamEvent = { type: string; content?: string; message?: string; status?: string; output?: string };

export const sessionApi = {
  createSession: (agentId: string) => requestJson<SessionCreateResponse>("/api/sessions", { method: "POST", body: JSON.stringify({ agent_id: agentId }) }),
  closeSession: (sessionId: string) => requestJson<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  streamMessage: (sessionId: string, message: string, handlers: { onEvent: (event: StreamEvent) => void; onError: (error: Error) => void; onClose?: () => void }) => {
    const controller = new AbortController();
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/sessions/messages/stream?agent-session-id=${encodeURIComponent(sessionId)}`, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    let lastIndex = 0;
    let buffer = "";
    let redirectedForUnauthorized = false;
    xhr.onreadystatechange = () => {
      if (xhr.readyState === xhr.HEADERS_RECEIVED || xhr.readyState === xhr.LOADING) {
        buffer += xhr.responseText.slice(lastIndex); lastIndex = xhr.responseText.length;
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        lines.filter((line) => line.startsWith("data:")).forEach((line) => {
          try { handlers.onEvent(JSON.parse(line.slice(5).trim()) as StreamEvent); } catch { /* ignore malformed chunks */ }
        });
      }
      if (xhr.readyState === xhr.DONE) {
        if (xhr.status === 401 && !redirectedForUnauthorized) {
          redirectedForUnauthorized = true;
          redirectToLogin();
        }
        if (xhr.status >= 400) handlers.onError(new Error(`SSE connection failed: ${xhr.status}`));
        handlers.onClose?.();
      }
    };
    xhr.onerror = () => handlers.onError(new Error("SSE connection error"));
    controller.signal.addEventListener("abort", () => xhr.abort());
    xhr.send(JSON.stringify({ message }));
    return controller;
  }
};

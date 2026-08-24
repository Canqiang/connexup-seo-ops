import { afterEach, expect, test, vi } from "vitest";
import { sessionApi } from "./sessionApi";

class FakeXMLHttpRequest {
  readonly HEADERS_RECEIVED = 2;
  readonly LOADING = 3;
  readonly DONE = 4;
  method = "";
  url = "";
  async = false;
  readyState = 0;
  status = 200;
  responseText = "";
  requestHeaders: Record<string, string> = {};
  requestBody: string | undefined;
  aborted = false;
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(method: string, url: string, async: boolean) {
    this.method = method;
    this.url = url;
    this.async = async;
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body?: string) {
    this.requestBody = body;
  }

  abort() {
    this.aborted = true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("streams through the same-origin session without forwarding a stored API key", () => {
  const xhr = new FakeXMLHttpRequest();
  const onEvent = vi.fn();
  vi.stubGlobal("XMLHttpRequest", class { constructor() { return xhr; } });
  localStorage.setItem("apiKey", "legacy-key");

  const controller = sessionApi.streamMessage("session-1", "summarize current work", { onEvent, onError: vi.fn() });

  expect(xhr.method).toBe("POST");
  expect(xhr.url).toBe("/api/sessions/messages/stream?agent-session-id=session-1");
  expect(xhr.async).toBe(true);
  expect(xhr.requestHeaders).toEqual({
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
  expect(xhr.requestBody).toBe(JSON.stringify({ message: "summarize current work" }));

  xhr.readyState = xhr.LOADING;
  xhr.responseText = 'data: {"type":"message","content":"ready"}\n';
  xhr.onreadystatechange?.();
  expect(onEvent).toHaveBeenCalledWith({ type: "message", content: "ready" });

  controller.abort();
  expect(xhr.aborted).toBe(true);
});

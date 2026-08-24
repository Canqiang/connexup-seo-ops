import { afterEach, expect, test, vi } from "vitest";
import { ApiError, requestJson } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test("preserves structured conflict responses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
    JSON.stringify({ message: "stale", error_code: "STALE_STATE" }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  )));

  await expect(requestJson("/api/seo-ops/tasks/1")).rejects.toMatchObject({
    status: 409,
    code: "STALE_STATE",
    message: "stale"
  } satisfies Partial<ApiError>);
});

test("uses same-origin cookies and never forwards a persisted API key", async () => {
  localStorage.setItem("apiKey", "key-1");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);

  await requestJson("/api/seo-ops/config");

  expect(fetchMock).toHaveBeenCalledWith("/api/seo-ops/config", expect.objectContaining({
    credentials: "same-origin",
    headers: expect.not.objectContaining({ Authorization: expect.anything() })
  }));
});

test("uses one Headers object, preserves explicit defaults, and strips caller authorization", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);

  await requestJson("/api/seo-ops/config", {
    body: "{}",
    headers: new Headers({ Accept: "application/problem+json", Authorization: "Bearer supplied", "Content-Type": "text/plain", "X-Trace": "keep" }),
  });

  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  expect(init.headers).toBeInstanceOf(Headers);
  const headers = new Headers(init.headers);
  expect(headers.get("Accept")).toBe("application/problem+json");
  expect(headers.get("Content-Type")).toBe("text/plain");
  expect(headers.get("X-Trace")).toBe("keep");
  expect(headers.get("Authorization")).toBeNull();
});

test("adds JSON defaults only when the caller has not supplied them", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);

  await requestJson("/api/seo-ops/config", { body: "{}" });

  const headers = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers);
  expect(headers.get("Accept")).toBe("application/json");
  expect(headers.get("Content-Type")).toBe("application/json");
});

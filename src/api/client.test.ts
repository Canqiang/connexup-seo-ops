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

test("adds bearer auth without inventing a fixture fallback", async () => {
  localStorage.setItem("apiKey", "key-1");
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  }));
  vi.stubGlobal("fetch", fetchMock);

  await requestJson("/api/seo-ops/config");

  expect(fetchMock).toHaveBeenCalledWith("/api/seo-ops/config", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer key-1" })
  }));
});

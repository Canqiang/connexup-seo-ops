import { describe, expect, it, vi } from "vitest";
import { createCoreAiClient } from "../src/services/coreAiClient.js";

const BASE_URL = "https://core.internal.example/api";
const TEST_TOKEN = "test-server-token";

function response(bytes: number[] = [1, 2, 3]): Response {
  return new Response(new Uint8Array(bytes));
}

describe("Core AI artifact downloads", () => {
  it("sends the bearer token to same-origin artifact URLs", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return response();
    }) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await client.downloadArtifact("/artifacts/relative");
    await client.downloadArtifact("https://core.internal.example/artifacts/absolute");

    expect(calls).toEqual([
      { url: "https://core.internal.example/artifacts/relative", authorization: `Bearer ${TEST_TOKEN}` },
      { url: "https://core.internal.example/artifacts/absolute", authorization: `Bearer ${TEST_TOKEN}` },
    ]);
  });

  it("rejects artifact origins outside the configured Core boundary without fetching", async () => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("https://storage.example/download?signature=presigned"))
      .rejects.toMatchObject({ status: 0, message: "artifact download origin is not allowed" });
    await expect(client.downloadArtifact("http://core.internal.example/artifact"))
      .rejects.toMatchObject({ status: 0, message: "artifact download origin is not allowed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("follows one HTTPS object-store redirect from the Core public artifact endpoint without forwarding auth", async () => {
    const calls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        redirect: init?.redirect,
      });
      if (calls.length === 1) return new Response(null, {
        status: 307,
        headers: { Location: "https://objects.example/presigned-image" },
      });
      return response([9]);
    }) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("/api/public/artifacts/safe-id/content"))
      .resolves.toEqual(new Uint8Array([9]));
    expect(calls).toEqual([
      {
        url: "https://core.internal.example/api/public/artifacts/safe-id/content",
        authorization: `Bearer ${TEST_TOKEN}`,
        redirect: "manual",
      },
      {
        url: "https://objects.example/presigned-image",
        authorization: null,
        redirect: "error",
      },
    ]);
  });

  it("rejects off-origin redirects from any non-public Core path", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 307,
      headers: { Location: "https://objects.example/presigned-image" },
    })) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("/artifacts/redirect-to-storage"))
      .rejects.toMatchObject({ status: 0, message: "artifact download redirect is not allowed" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels an oversized Content-Length response before rejecting", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(body, {
      headers: { "Content-Length": "4" },
    })) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("/artifacts/declared-oversize", { maxBytes: 3 }))
      .rejects.toMatchObject({ status: 0, message: "artifact download exceeds byte limit" });
    expect(cancelled).toBe(true);
  });

  it("cancels and rejects an unknown-length artifact stream when counted bytes exceed the limit", async () => {
    let pull = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pull += 1;
        if (pull === 1) controller.enqueue(new Uint8Array([1, 2]));
        else if (pull === 2) controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("/artifacts/streamed-oversize", { maxBytes: 3 }))
      .rejects.toMatchObject({ status: 0, message: "artifact download exceeds byte limit" });
    expect(cancelled).toBe(true);
  });

  it("honors an already-aborted aggregate signal without starting an artifact response", async () => {
    let observedAborted = false;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedAborted = init?.signal?.aborted ?? false;
      if (observedAborted) throw new DOMException("aborted", "AbortError");
      return response();
    }) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(client.downloadArtifact("/artifacts/aggregate-budget", {
      maxBytes: 3,
      signal: controller.signal,
    })).rejects.toMatchObject({ status: 0, message: "artifact download failed" });
    expect(observedAborted).toBe(true);
  });

  it("rejects non-http artifact URLs without fetching or exposing credentials", async () => {
    const fetchImpl = vi.fn(async () => response()) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("ftp://files.example/artifact"))
      .rejects.toMatchObject({ status: 0, message: "artifact download URL must use http(s)" });
    await expect(client.downloadArtifact("data:text/plain,artifact"))
      .rejects.toMatchObject({ status: 0, message: "artifact download URL must use http(s)" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not include a fetch failure's credential-like detail in its error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`upstream credentials included ${TEST_TOKEN}`);
    }) as unknown as typeof fetch;
    const client = createCoreAiClient({ baseUrl: BASE_URL, token: TEST_TOKEN, fetchImpl });

    await expect(client.downloadArtifact("/artifacts/failing"))
      .rejects.toMatchObject({ status: 0, message: "artifact download failed" });
  });
});

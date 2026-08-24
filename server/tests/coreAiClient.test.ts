import { describe, expect, it, vi } from "vitest";
import { createCoreAiClient } from "../src/services/coreAiClient.js";

const BASE_URL = "https://core.internal.example/api";
const TEST_TOKEN = "test-server-token";

function response(bytes: number[] = [1, 2, 3]): Response {
  return new Response(new Uint8Array(bytes));
}

describe("Core AI artifact downloads", () => {
  it("sends the bearer token only to same-origin artifact URLs", async () => {
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
    await client.downloadArtifact("https://storage.example/download?signature=presigned");
    await client.downloadArtifact("http://downloads.example/artifact");
    await client.downloadArtifact("//cdn.example/artifact");

    expect(calls).toEqual([
      { url: "https://core.internal.example/artifacts/relative", authorization: `Bearer ${TEST_TOKEN}` },
      { url: "https://core.internal.example/artifacts/absolute", authorization: `Bearer ${TEST_TOKEN}` },
      { url: "https://storage.example/download?signature=presigned", authorization: null },
      { url: "http://downloads.example/artifact", authorization: null },
      { url: "https://cdn.example/artifact", authorization: null },
    ]);
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

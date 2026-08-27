import { mkdtemp, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendReconciliationEvidence,
  createCoreAiAgentAdminClient,
  discoverEditableReference,
  reconcileAgent,
  reconcileAgents,
  rollbackManagedAgent,
  type AgentManifest,
  type CoreAiAgentView,
} from "../src/services/coreAiAgentAdminClient.js";

const TOKEN_SENTINEL = "TOKEN_SENTINEL_do_not_leak";
const PROMPT_SENTINEL = "PROMPT_SENTINEL_do_not_leak";
const BASE_URL = "https://core-ai.example.test";
const REFERENCE_ID = "00000000-0000-4000-8000-000000000001";
const MANAGED_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_ID = "00000000-0000-4000-8000-000000000003";

const manifest: AgentManifest = {
  name: "[SEO Ops] Test Agent v1",
  description: "Safe test Agent",
  system_prompt: PROMPT_SENTINEL,
  model: "test-model",
  temperature: 0.1,
  thinking_effort: null,
  max_turns: 10,
  timeout_seconds: 300,
  enable_memory: false,
  type: "AGENT",
  tools: [{ id: "tool-one", type: "MCP" }],
  skill_ids: ["skill-one"],
  subagent_ids: [],
  dataset_config: [],
  sandbox_config: null,
  response_schema: '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
};

function agent(overrides: Partial<CoreAiAgentView> = {}): CoreAiAgentView {
  return {
    id: MANAGED_ID,
    ...manifest,
    status: "DRAFT",
    created_by: "operator-user",
    system_default: false,
    created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z",
    ...overrides,
  };
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestLog(fetchImpl: ReturnType<typeof vi.fn>): string[] {
  return fetchImpl.mock.calls.map(([input, init]) => {
    const url = new URL(String(input));
    return `${init?.method ?? "GET"} ${url.pathname}`;
  });
}

describe("safe Core AI Agent administration", () => {
  it("dry-run emits only changed names and hashes and never mutates", async () => {
    const remote = agent({ description: "old", response_schema: '{"type":"string"}' });
    const fetchImpl = vi.fn(async () => json(remote)) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    const result = await reconcileAgent({ client, manifest, mode: "dry-run", referenceAgentId: REFERENCE_ID });

    expect(result).toMatchObject({ action: "UPDATE", agent_id: MANAGED_ID });
    expect(result.changed_fields).toEqual(["description", "response_schema"]);
    expect(result.changed_field_hashes).toEqual({
      description: { current: expect.stringMatching(/^[a-f0-9]{64}$/), desired: expect.stringMatching(/^[a-f0-9]{64}$/) },
      response_schema: { current: expect.stringMatching(/^[a-f0-9]{64}$/), desired: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(requestLog(fetchImpl as never)).toEqual(["GET /api/agents/name/%5BSEO%20Ops%5D%20Test%20Agent%20v1"]);
    expect(JSON.stringify(result)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(PROMPT_SENTINEL);
  });

  it("apply creates, publishes, and reads back only the new server UUID", async () => {
    const published = agent({ id: CREATED_ID, status: "PUBLISHED" });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ message: "missing" }, 404))
      .mockResolvedValueOnce(json({ id: CREATED_ID, ...manifest, status: "DRAFT", created_by: "operator-user", system_default: false }))
      .mockResolvedValueOnce(json({ id: CREATED_ID, status: "PUBLISHED" }))
      .mockResolvedValueOnce(json(published)) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    const desiredWithLocalMetadata = {
      ...manifest,
      manifest_version: "seo_ops.core_ai_agent_manifest.v1",
      local_metadata: { must_not_reach_core_ai: true },
    };
    const result = await reconcileAgent({ client, manifest: desiredWithLocalMetadata, mode: "apply", referenceAgentId: REFERENCE_ID });

    expect(result).toMatchObject({ action: "CREATE", agent_id: CREATED_ID, readback: { name: manifest.name, status: "PUBLISHED" } });
    expect(requestLog(fetchImpl as never)).toEqual([
      "GET /api/agents/name/%5BSEO%20Ops%5D%20Test%20Agent%20v1",
      "POST /api/agents",
      `POST /api/agents/${CREATED_ID}/publish`,
      `GET /api/agents/${CREATED_ID}`,
    ]);
    expect(requestLog(fetchImpl as never).join("\n")).not.toContain(REFERENCE_ID);
    const createCall = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1];
    const createBody = JSON.parse(String(createCall?.[1]?.body)) as Record<string, unknown>;
    expect(Object.keys(createBody).sort()).toEqual([
      "dataset_config", "description", "enable_memory", "max_turns", "model", "name",
      "response_schema", "sandbox_config", "skill_ids", "subagent_ids", "system_prompt",
      "temperature", "thinking_effort", "timeout_seconds", "tools", "type",
    ].sort());
    expect(createBody).not.toHaveProperty("manifest_version");
    expect(createBody).not.toHaveProperty("local_metadata");
    expect(new Headers(createCall?.[1]?.headers).get("authorization")).toBe(`Bearer ${TOKEN_SENTINEL}`);
    expect(String(createCall?.[0])).not.toContain(TOKEN_SENTINEL);
    expect(String(createCall?.[1]?.body)).not.toContain(TOKEN_SENTINEL);
  });

  it("updates an owned managed Agent but fails closed on unowned, system-default, and name collisions", async () => {
    const ownedFetch = vi.fn()
      .mockResolvedValueOnce(json(agent({ description: "old" })))
      .mockResolvedValueOnce(json({ user_id: "operator-user" }))
      .mockResolvedValueOnce(json(agent()))
      .mockResolvedValueOnce(json({ id: MANAGED_ID, status: "PUBLISHED" }))
      .mockResolvedValueOnce(json(agent({ status: "PUBLISHED" }))) as unknown as typeof fetch;
    const owned = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: ownedFetch });
    await expect(reconcileAgent({ client: owned, manifest, mode: "apply", referenceAgentId: REFERENCE_ID }))
      .resolves.toMatchObject({ action: "UPDATE", agent_id: MANAGED_ID });
    expect(requestLog(ownedFetch as never)).toContain(`PUT /api/agents/${MANAGED_ID}`);

    for (const collision of [
      agent({ created_by: "another-user", description: "old" }),
      agent({ system_default: true, description: "old" }),
      agent({ name: "GooglePost每周图文助手", description: "old" }),
    ]) {
      const desired = collision.name === manifest.name ? manifest : { ...manifest, name: collision.name };
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(json(collision))
        .mockResolvedValueOnce(json({ user_id: "operator-user" })) as unknown as typeof fetch;
      const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });
      await expect(reconcileAgent({ client, manifest: desired, mode: "apply", referenceAgentId: REFERENCE_ID }))
        .rejects.toThrow(/managed Agent|reference Agent/i);
      expect(requestLog(fetchImpl as never).some((call) => /^(POST|PUT)/.test(call))).toBe(false);
    }
  });

  it("requires one exact reference and returns metadata/hashes without its prompt", async () => {
    const reference = agent({ id: REFERENCE_ID, name: "GooglePost每周图文助手", status: "PUBLISHED", system_prompt: PROMPT_SENTINEL });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ agents: [reference, agent({ id: CREATED_ID, name: "GooglePost每周图文助手 copy" })], total: 2 }))
      .mockResolvedValueOnce(json(reference)) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    const result = await discoverEditableReference({ client, referenceName: "GooglePost每周图文助手" });

    expect(result).toMatchObject({ id: REFERENCE_ID, name: "GooglePost每周图文助手", label: "EDITABLE_REFERENCE_ONLY" });
    expect(result).toHaveProperty("field_hashes.system_prompt");
    expect(JSON.stringify(result)).not.toContain(PROMPT_SENTINEL);
    expect(requestLog(fetchImpl as never)).toEqual([
      "GET /api/agents",
      "GET /api/agents/name/GooglePost%E6%AF%8F%E5%91%A8%E5%9B%BE%E6%96%87%E5%8A%A9%E6%89%8B",
    ]);

    for (const listed of [[], [reference, { ...reference, id: CREATED_ID }]]) {
      const duplicateFetch = vi.fn().mockResolvedValueOnce(json({ agents: listed, total: listed.length })) as unknown as typeof fetch;
      const duplicateClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: duplicateFetch });
      await expect(discoverEditableReference({ client: duplicateClient, referenceName: "GooglePost每周图文助手" }))
        .rejects.toThrow(/exactly one/i);
      expect(duplicateFetch).toHaveBeenCalledTimes(1);
    }
  });

  it("normalizes Core AI null list views to the desired empty-list contract", async () => {
    const remote = {
      ...agent({ status: "PUBLISHED" }),
      tools: null,
      skill_ids: null,
      subagent_ids: null,
      dataset_config: null,
    } as unknown as CoreAiAgentView;
    const desired = { ...manifest, tools: [], skill_ids: [], subagent_ids: [], dataset_config: [] };
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(remote)) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    await expect(reconcileAgent({ client, manifest: desired, mode: "dry-run", referenceAgentId: REFERENCE_ID }))
      .resolves.toMatchObject({ action: "NO_CHANGE", changed_fields: [] });
  });

  it("never permits a reference UUID as update, publish, or rollback target", async () => {
    const maliciousCreate = vi.fn()
      .mockResolvedValueOnce(json({ message: "missing" }, 404))
      .mockResolvedValueOnce(json({ id: REFERENCE_ID, ...manifest })) as unknown as typeof fetch;
    const createClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: maliciousCreate });
    await expect(reconcileAgent({ client: createClient, manifest, mode: "apply", referenceAgentId: REFERENCE_ID }))
      .rejects.toThrow(/reference Agent/i);
    expect(maliciousCreate).toHaveBeenCalledTimes(2);

    const maliciousExisting = vi.fn().mockResolvedValueOnce(json(agent({ id: REFERENCE_ID, description: "old" }))) as unknown as typeof fetch;
    const existingClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: maliciousExisting });
    await expect(reconcileAgent({ client: existingClient, manifest, mode: "apply", referenceAgentId: REFERENCE_ID }))
      .rejects.toThrow(/reference Agent/i);
    expect(maliciousExisting).toHaveBeenCalledTimes(1);

    await expect(rollbackManagedAgent({
      client: existingClient,
      referenceAgentId: REFERENCE_ID,
      evidence: { managed_agent_id: REFERENCE_ID, prior_normalized_fields: manifest },
    })).rejects.toThrow(/reference Agent/i);
    expect(maliciousExisting).toHaveBeenCalledTimes(1);
  });

  it("keeps token and prompt sentinels out of errors and console output", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`${TOKEN_SENTINEL} ${PROMPT_SENTINEL}`);
    }) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });
    const error = await reconcileAgent({ client, manifest, mode: "dry-run", referenceAgentId: REFERENCE_ID }).catch((caught) => caught);
    expect(String(error)).not.toContain(TOKEN_SENTINEL);
    expect(String(error)).not.toContain(PROMPT_SENTINEL);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const noChangeFetch = vi.fn().mockResolvedValueOnce(json(agent({ status: "PUBLISHED" }))) as unknown as typeof fetch;
    const noChangeClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: noChangeFetch });
    await reconcileAgents({ client: noChangeClient, manifests: [manifest], mode: "dry-run", referenceAgentId: REFERENCE_ID, logger: console.log });
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(TOKEN_SENTINEL);
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(PROMPT_SENTINEL);
    consoleSpy.mockRestore();
  });

  it("aborts the roster on the first readback mismatch before later mutation", async () => {
    const second = { ...manifest, name: "[SEO Ops] Later Agent v1" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ message: "missing" }, 404))
      .mockResolvedValueOnce(json({ id: CREATED_ID, ...manifest }))
      .mockResolvedValueOnce(json({ id: CREATED_ID, status: "PUBLISHED" }))
      .mockResolvedValueOnce(json(agent({ id: CREATED_ID, status: "PUBLISHED", skill_ids: [] }))) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    await expect(reconcileAgents({ client, manifests: [manifest, second], mode: "apply", referenceAgentId: REFERENCE_ID }))
      .rejects.toThrow(/readback mismatch/i);
    expect(requestLog(fetchImpl as never).some((call) => call.includes("Later%20Agent"))).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("validates HTTPS/loopback URLs, encodes path segments, rejects redirects, and times out", async () => {
    expect(() => createCoreAiAgentAdminClient({ baseUrl: "http://core-ai.example.test", token: TOKEN_SENTINEL })).toThrow(/HTTPS/i);
    expect(() => createCoreAiAgentAdminClient({ baseUrl: "https://user:pass@core-ai.example.test", token: TOKEN_SENTINEL })).toThrow(/credentials/i);
    expect(() => createCoreAiAgentAdminClient({ baseUrl: "https://core-ai.example.test?token=bad", token: TOKEN_SENTINEL })).toThrow(/query/i);
    expect(() => createCoreAiAgentAdminClient({ baseUrl: "http://127.0.0.1:8080", token: TOKEN_SENTINEL })).not.toThrow();

    const encodedFetch = vi.fn().mockResolvedValueOnce(json(agent())) as unknown as typeof fetch;
    const encodedClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: encodedFetch });
    await encodedClient.getAgentByName("Agent / ? # %");
    expect(String((encodedFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toBe(
      `${BASE_URL}/api/agents/name/Agent%20%2F%20%3F%20%23%20%25`,
    );

    const redirectFetch = vi.fn().mockResolvedValueOnce(json({}, 302, { location: "https://evil.example" })) as unknown as typeof fetch;
    const redirectClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: redirectFetch });
    await expect(redirectClient.getAgent(MANAGED_ID)).rejects.toThrow(/302/);
    expect((redirectFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });

    const timeoutFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const timeoutClient = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: timeoutFetch, timeoutMs: 5 });
    await expect(timeoutClient.getAgent(MANAGED_ID)).rejects.toThrow(/request failed/i);
  });

  it("rejects non-JSON and oversized responses without exposing their bodies", async () => {
    for (const response of [
      new Response(`${TOKEN_SENTINEL} ${PROMPT_SENTINEL}`, { status: 200, headers: { "content-type": "text/plain" } }),
      json({ secret: TOKEN_SENTINEL }, 200, { "content-length": "9999" }),
      new Response(`{"padding":"${"x".repeat(100)}${TOKEN_SENTINEL}"}`, { status: 200, headers: { "content-type": "application/json" } }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response) as unknown as typeof fetch;
      const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, maxResponseBytes: 64 });
      const error = await client.getAgent(MANAGED_ID).catch((caught) => caught);
      expect(String(error)).toMatch(/JSON|byte limit/i);
      expect(String(error)).not.toContain(TOKEN_SENTINEL);
      expect(String(error)).not.toContain(PROMPT_SENTINEL);
    }
  });

  it("cancels an unknown-length JSON stream as soon as it crosses the response limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls <= 10) controller.enqueue(new Uint8Array(16).fill(32));
        else controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(body, {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, maxResponseBytes: 64 });

    await expect(client.getAgent(MANAGED_ID)).rejects.toThrow(/byte limit/i);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });

  it("rejects evidence traversal and symlink escape while appending sanitized evidence in-repo", async () => {
    const temp = await mkdtemp(join(tmpdir(), "seo-ops-evidence-"));
    const repoRoot = resolve(temp, "repo");
    const outside = resolve(temp, "outside");
    await mkdir(resolve(repoRoot, "docs/evidence"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, resolve(repoRoot, "docs/escape"));
    const validPath = resolve(repoRoot, "docs/evidence/reconcile.md");

    await appendReconciliationEvidence({
      repositoryRoot: repoRoot,
      evidencePath: validPath,
      records: [{ action: "NO_CHANGE", agent_id: MANAGED_ID, token: TOKEN_SENTINEL, system_prompt: PROMPT_SENTINEL } as never],
    });
    const evidence = await readFile(validPath, "utf8");
    expect(evidence).toContain("NO_CHANGE");
    expect(evidence).not.toContain(TOKEN_SENTINEL);
    expect(evidence).not.toContain(PROMPT_SENTINEL);
    await expect(appendReconciliationEvidence({ repositoryRoot: repoRoot, evidencePath: resolve(temp, "outside.md"), records: [] }))
      .rejects.toThrow(/repository/i);
    await expect(appendReconciliationEvidence({ repositoryRoot: repoRoot, evidencePath: resolve(repoRoot, "docs/escape/out.md"), records: [] }))
      .rejects.toThrow(/repository|symlink/i);
    await expect(appendReconciliationEvidence({ repositoryRoot: repoRoot, evidencePath: "relative.md", records: [] }))
      .rejects.toThrow(/absolute/i);
  });

  it("rolls back an owned managed Agent with PUT/publish/GET and exposes no DELETE capability", async () => {
    const prior = { ...manifest, description: "prior safe description" };
    const published = agent({ ...prior, status: "PUBLISHED" });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ user_id: "operator-user" }))
      .mockResolvedValueOnce(json(agent({ ...prior })))
      .mockResolvedValueOnce(json(agent({ ...prior })))
      .mockResolvedValueOnce(json({ id: MANAGED_ID, status: "PUBLISHED" }))
      .mockResolvedValueOnce(json(published)) as unknown as typeof fetch;
    const client = createCoreAiAgentAdminClient({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl });

    const result = await rollbackManagedAgent({
      client,
      referenceAgentId: REFERENCE_ID,
      evidence: { managed_agent_id: MANAGED_ID, prior_normalized_fields: prior },
    });

    expect(result).toMatchObject({ action: "ROLLBACK", agent_id: MANAGED_ID, readback: { status: "PUBLISHED" } });
    expect(requestLog(fetchImpl as never)).toEqual([
      "GET /api/auth/me",
      `GET /api/agents/${MANAGED_ID}`,
      `PUT /api/agents/${MANAGED_ID}`,
      `POST /api/agents/${MANAGED_ID}/publish`,
      `GET /api/agents/${MANAGED_ID}`,
    ]);
    expect("deleteAgent" in client).toBe(false);
    expect(requestLog(fetchImpl as never).some((call) => call.startsWith("DELETE"))).toBe(false);
  });
});

import { mkdtemp, mkdir, readFile, writeFile, symlink, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as admin from "../src/services/coreAiAgentAdminClient.js";

const TOKEN_SENTINEL = "TOKEN_SENTINEL_do_not_leak";
const PROMPT_SENTINEL = "PROMPT_SENTINEL_do_not_leak";
const BASE_URL = "https://core-ai.example.test";
const REFERENCE_NAME = "GooglePost每周图文助手";
const REFERENCE_ID = "00000000-0000-4000-8000-000000000001";
const MANAGED_ID = "00000000-0000-4000-8000-000000000002";
const CREATED_ID = "00000000-0000-4000-8000-000000000003";
const SECOND_CREATED_ID = "00000000-0000-4000-8000-000000000004";

type AgentManifest = {
  name: string; description: string; system_prompt: string; model: string; temperature: number;
  thinking_effort: null; max_turns: number; timeout_seconds: number; enable_memory: boolean;
  type: "AGENT"; tools: Array<{ id: string; type: string; source?: string }>;
  skill_ids: string[]; subagent_ids: string[]; dataset_config: unknown[];
  sandbox_config: null; response_schema: string;
};

type RemoteAgent = AgentManifest & {
  id: string; status: string; created_by: string; system_default: boolean;
  created_at: string; updated_at: string; published_at: string | null;
  system_prompt_id: string | null; multi_modal_model: string | null;
  prefer_caption_path: boolean | null; input_template: string | null;
  variables: Record<string, string> | null; mine?: boolean; [key: string]: unknown;
};

const manifest: AgentManifest = {
  name: "[SEO Ops] Test Agent v1", description: "Safe test Agent", system_prompt: PROMPT_SENTINEL,
  model: "test-model", temperature: 0.1, thinking_effort: null, max_turns: 10,
  timeout_seconds: 300, enable_memory: false, type: "AGENT",
  tools: [{ id: "tool-one", type: "MCP" }], skill_ids: ["skill-one"], subagent_ids: [],
  dataset_config: [], sandbox_config: null,
  response_schema: '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
};

function remoteAgent(overrides: Partial<RemoteAgent> = {}): RemoteAgent {
  return {
    id: MANAGED_ID, ...manifest, status: "PUBLISHED", created_by: "operator-display-name",
    system_default: false, created_at: "2026-08-26T00:00:00.000Z",
    updated_at: "2026-08-26T00:00:00.000Z", published_at: "2026-08-26T00:00:01.000Z",
    system_prompt_id: null, multi_modal_model: null, prefer_caption_path: null,
    input_template: null, variables: null, mine: true, ...overrides,
  };
}

function referenceAgent(overrides: Partial<RemoteAgent> = {}): RemoteAgent {
  return remoteAgent({
    id: REFERENCE_ID, name: REFERENCE_NAME,
    system_prompt: "REFERENCE_PROMPT_SENTINEL_do_not_leak", mine: false, ...overrides,
  });
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { "content-type": "application/json", ...headers },
  });
}

function publicAgent(agent: RemoteAgent): Record<string, unknown> {
  const { mine: _mine, ...view } = agent;
  return view;
}

class FakeCore {
  readonly calls: Array<{ method: string; url: URL; body?: unknown }> = [];
  agents: RemoteAgent[];
  createIds: string[] = [CREATED_ID, SECOND_CREATED_ID];
  inconsistentTotalPage: number | null = null;
  onCreate?: (agent: RemoteAgent) => void | Promise<void>;
  onPublish?: (agent: RemoteAgent) => void | Promise<void>;

  constructor(agents: RemoteAgent[]) { this.agents = agents; }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const parsedBody = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    this.calls.push({ method, url, ...(parsedBody === undefined ? {} : { body: parsedBody }) });

    if (method === "GET" && url.pathname === "/api/agents") {
      const query = url.searchParams.get("query") ?? "";
      const page = Number(url.searchParams.get("page"));
      const limit = Number(url.searchParams.get("limit"));
      const mine = url.searchParams.get("my") === "true";
      const includeSystem = url.searchParams.get("include_system_default") !== "false";
      const matching = this.agents.filter((agent) => agent.name.includes(query)
        && (!mine || agent.mine === true) && (includeSystem || agent.system_default !== true));
      const start = (page - 1) * limit;
      const total = this.inconsistentTotalPage === page ? matching.length + 1 : matching.length;
      return json({ agents: matching.slice(start, start + limit).map(publicAgent), total, page, limit });
    }

    const idMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (method === "GET" && idMatch) {
      const found = this.agents.find((agent) => agent.id === decodeURIComponent(idMatch[1]!));
      return found ? json(publicAgent(found)) : json({ error: "missing" }, 404);
    }

    if (method === "POST" && url.pathname === "/api/agents") {
      const id = this.createIds.shift() ?? "00000000-0000-4000-8000-000000000099";
      const created = remoteAgent({ ...(parsedBody as AgentManifest), id, status: "DRAFT", published_at: null, mine: true });
      this.agents.push(created);
      await this.onCreate?.(created);
      return json(publicAgent(created), 201);
    }

    const publishMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/publish$/);
    if (method === "POST" && publishMatch) {
      const found = this.agents.find((agent) => agent.id === decodeURIComponent(publishMatch[1]!));
      if (!found) return json({ error: "missing" }, 404);
      found.status = "PUBLISHED";
      found.published_at = "2026-08-27T00:00:00.000Z";
      await this.onPublish?.(found);
      return json(publicAgent(found));
    }
    return json({ error: "unexpected" }, 500);
  };

  mutations(): string[] {
    return this.calls.filter((call) => call.method !== "GET")
      .map((call) => `${call.method} ${call.url.pathname}`);
  }
}

type DryRun = (input: {
  client: unknown; repositoryRoot: string; manifestRoot: string;
  selection: { kind: "ALL" } | { kind: "EXPLICIT"; paths: string[] };
  planPath: string; referenceName?: string;
}) => Promise<any>;
type Apply = (input: {
  client: unknown; repositoryRoot: string; manifestRoot: string;
  planPath: string; evidencePath: string;
}) => Promise<any>;

function exported<T>(name: string): T {
  const value = (admin as Record<string, unknown>)[name];
  expect(value, `${name} must be exported`).toBeTypeOf("function");
  return value as T;
}

function createClient(fake: FakeCore, pageLimit = 2): any {
  return (admin.createCoreAiAgentAdminClient as any)({
    baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: fake.fetch, pageLimit,
  });
}

async function makeRepository(entries: Array<{ file: string; value: unknown }> = [
  { file: "test-agent.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...manifest } },
]): Promise<{ root: string; manifestRoot: string; paths: string[]; planPath: string; evidencePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "seo-ops-reconcile-"));
  const manifestRoot = resolve(root, "server/core-ai-agents");
  await mkdir(manifestRoot, { recursive: true });
  await mkdir(resolve(root, "docs/evidence"), { recursive: true });
  const paths: string[] = [];
  for (const entry of entries) {
    const path = resolve(manifestRoot, entry.file);
    await writeFile(path, `${JSON.stringify(entry.value, null, 2)}\n`, "utf8");
    paths.push(path);
  }
  return {
    root, manifestRoot, paths,
    planPath: resolve(root, "docs/evidence/plan.json"),
    evidencePath: resolve(root, "docs/evidence/journal.jsonl"),
  };
}

async function readJournal(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, "utf8");
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("complete paginated discovery and create-only classification", () => {
  it("finds one exact reference on a later fuzzy page and labels only editable-config evidence", async () => {
    const repo = await makeRepository();
    const fake = new FakeCore([
      referenceAgent({ id: "00000000-0000-4000-8000-000000000010", name: `${REFERENCE_NAME} copy` }),
      referenceAgent(),
    ]);
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const plan = await dryRun({
      client: createClient(fake, 1), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath,
    });
    expect(plan.reference).toMatchObject({
      id: REFERENCE_ID, name: REFERENCE_NAME, label: "EDITABLE_REFERENCE_ONLY",
      evidence_scope: "EDITABLE_CONFIG_AND_STATUS_ONLY",
    });
    expect(plan.selected).toMatchObject([{ path: "server/core-ai-agents/test-agent.json", action: "CREATE" }]);
    const referencePages = fake.calls.filter((call) => call.url.searchParams.get("query") === REFERENCE_NAME);
    expect(referencePages.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2"]);
    expect(JSON.stringify(plan)).not.toContain(PROMPT_SENTINEL);
    expect(JSON.stringify(plan)).not.toContain("REFERENCE_PROMPT_SENTINEL");
  });

  it("fails closed for absent, duplicate-across-pages, and inconsistent-total reference discovery", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    for (const setup of [
      { agents: [] as RemoteAgent[], pattern: /exactly one/i },
      { agents: [referenceAgent(), referenceAgent({ id: "00000000-0000-4000-8000-000000000011" })], pattern: /exactly one|duplicate/i },
    ]) {
      const repo = await makeRepository();
      const fake = new FakeCore(setup.agents);
      await expect(dryRun({
        client: createClient(fake, 1), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
        selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath,
      })).rejects.toThrow(setup.pattern);
    }
    const repo = await makeRepository();
    const inconsistent = new FakeCore([referenceAgent({ name: `${REFERENCE_NAME} copy` }), referenceAgent()]);
    inconsistent.inconsistentTotalPage = 2;
    await expect(dryRun({
      client: createClient(inconsistent, 1), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath,
    })).rejects.toThrow(/total|pagination/i);
  });

  it("stops on an exact cross-owner desired collision and never classifies it CREATE", async () => {
    const repo = await makeRepository();
    const fake = new FakeCore([referenceAgent(), remoteAgent({ mine: false, created_by: "other-owner" })]);
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    await expect(dryRun({
      client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath,
    })).rejects.toThrow(/owned|collision/i);
    expect(fake.mutations()).toEqual([]);
  });

  it("allows existing exact agents only as safe owned NO_CHANGE and stops on drift or unmanaged execution", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const matchingRepo = await makeRepository();
    const matchingFake = new FakeCore([referenceAgent(), remoteAgent()]);
    const matching = await dryRun({
      client: createClient(matchingFake), repositoryRoot: matchingRepo.root, manifestRoot: matchingRepo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: matchingRepo.paths }, planPath: matchingRepo.planPath,
    });
    expect(matching.selected[0]).toMatchObject({ action: "NO_CHANGE", remote_agent_id: MANAGED_ID });

    for (const unsafe of [
      remoteAgent({ description: "drift" }), remoteAgent({ system_prompt_id: "prompt-id" }),
      remoteAgent({ multi_modal_model: "vision-model" }), remoteAgent({ prefer_caption_path: true }),
      remoteAgent({ input_template: "{{input}}" }), remoteAgent({ variables: { executable: "value" } }),
      { ...remoteAgent(), future_executable_setting: "on" } as RemoteAgent,
    ]) {
      const repo = await makeRepository();
      const fake = new FakeCore([referenceAgent(), unsafe]);
      await expect(dryRun({
        client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
        selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath,
      })).rejects.toThrow(/create-only|new version|unmanaged|executable/i);
      expect(fake.mutations()).toEqual([]);
    }
  });
});

describe("reviewed plan scope and drift gates", () => {
  it("preflights every selected manifest before network use and rejects duplicates, symlinks, and invalid later files", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const invalid = await makeRepository([
      { file: "first.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...manifest } },
      { file: "later.json", value: { ...manifest, name: "unsafe later name" } },
    ]);
    const fake = new FakeCore([referenceAgent()]);
    await expect(dryRun({ client: createClient(fake), repositoryRoot: invalid.root, manifestRoot: invalid.manifestRoot,
      selection: { kind: "EXPLICIT", paths: invalid.paths }, planPath: invalid.planPath })).rejects.toThrow(/\[SEO Ops\]|manifest/i);
    expect(fake.calls).toEqual([]);

    const duplicate = await makeRepository();
    await expect(dryRun({ client: createClient(fake), repositoryRoot: duplicate.root, manifestRoot: duplicate.manifestRoot,
      selection: { kind: "EXPLICIT", paths: [duplicate.paths[0]!, duplicate.paths[0]!] }, planPath: duplicate.planPath })).rejects.toThrow(/duplicate/i);
    const link = resolve(duplicate.manifestRoot, "linked.json");
    await symlink(duplicate.paths[0]!, link);
    await expect(dryRun({ client: createClient(fake), repositoryRoot: duplicate.root, manifestRoot: duplicate.manifestRoot,
      selection: { kind: "EXPLICIT", paths: [link] }, planPath: resolve(duplicate.root, "docs/evidence/link-plan.json") })).rejects.toThrow(/symlink/i);
  });

  it("binds apply to manifest bytes, ALL scope, remote pre-state, and the reference coordinate", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const apply = exported<Apply>("applyAgentReconciliationPlan");

    const fileDrift = await makeRepository();
    const fileFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(fileFake), repositoryRoot: fileDrift.root, manifestRoot: fileDrift.manifestRoot,
      selection: { kind: "EXPLICIT", paths: fileDrift.paths }, planPath: fileDrift.planPath });
    await writeFile(fileDrift.paths[0]!, `${JSON.stringify({ ...manifest, description: "changed after review" })}\n`);
    await expect(apply({ client: createClient(fileFake), repositoryRoot: fileDrift.root, manifestRoot: fileDrift.manifestRoot,
      planPath: fileDrift.planPath, evidencePath: fileDrift.evidencePath })).rejects.toThrow(/manifest|plan|drift/i);
    expect(fileFake.mutations()).toEqual([]);

    const allScope = await makeRepository();
    const allFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(allFake), repositoryRoot: allScope.root, manifestRoot: allScope.manifestRoot,
      selection: { kind: "ALL" }, planPath: allScope.planPath });
    await writeFile(resolve(allScope.manifestRoot, "added-later.json"), JSON.stringify({
      manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...manifest, name: "[SEO Ops] Added Later v1",
    }));
    await expect(apply({ client: createClient(allFake), repositoryRoot: allScope.root, manifestRoot: allScope.manifestRoot,
      planPath: allScope.planPath, evidencePath: allScope.evidencePath })).rejects.toThrow(/scope|plan|drift/i);
    expect(allFake.mutations()).toEqual([]);

    const laterRemoteManifest = { ...manifest, name: "[SEO Ops] Later Remote Agent v1" };
    const remoteDrift = await makeRepository([
      { file: "first.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...manifest } },
      { file: "later.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...laterRemoteManifest } },
    ]);
    const remoteFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(remoteFake), repositoryRoot: remoteDrift.root, manifestRoot: remoteDrift.manifestRoot,
      selection: { kind: "EXPLICIT", paths: remoteDrift.paths }, planPath: remoteDrift.planPath });
    remoteFake.agents.push(remoteAgent({ id: SECOND_CREATED_ID, ...laterRemoteManifest }));
    await expect(apply({ client: createClient(remoteFake), repositoryRoot: remoteDrift.root, manifestRoot: remoteDrift.manifestRoot,
      planPath: remoteDrift.planPath, evidencePath: remoteDrift.evidencePath })).rejects.toThrow(/remote|plan|drift/i);
    expect(remoteFake.mutations()).toEqual([]);

    const referenceDrift = await makeRepository();
    const referenceFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(referenceFake), repositoryRoot: referenceDrift.root, manifestRoot: referenceDrift.manifestRoot,
      selection: { kind: "EXPLICIT", paths: referenceDrift.paths }, planPath: referenceDrift.planPath });
    referenceFake.agents[0]!.description = "reference changed";
    await expect(apply({ client: createClient(referenceFake), repositoryRoot: referenceDrift.root, manifestRoot: referenceDrift.manifestRoot,
      planPath: referenceDrift.planPath, evidencePath: referenceDrift.evidencePath })).rejects.toThrow(/reference|plan|drift/i);
    expect(referenceFake.mutations()).toEqual([]);
  });

  it("requires a mandatory reviewed reference coordinate and rejects unsafe evidence paths before mutation", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const apply = exported<Apply>("applyAgentReconciliationPlan");
    const repo = await makeRepository();
    const fake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath });
    const plan = JSON.parse(await readFile(repo.planPath, "utf8")) as Record<string, unknown>;
    delete plan.reference;
    await writeFile(repo.planPath, JSON.stringify(plan));
    await expect(apply({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      planPath: repo.planPath, evidencePath: repo.evidencePath })).rejects.toThrow(/reference/i);
    expect(fake.mutations()).toEqual([]);

    const outsideRepo = await makeRepository();
    const outsideFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(outsideFake), repositoryRoot: outsideRepo.root, manifestRoot: outsideRepo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: outsideRepo.paths }, planPath: outsideRepo.planPath });
    await expect(apply({ client: createClient(outsideFake), repositoryRoot: outsideRepo.root, manifestRoot: outsideRepo.manifestRoot,
      planPath: outsideRepo.planPath, evidencePath: resolve(outsideRepo.root, "../outside.jsonl") })).rejects.toThrow(/repository/i);
    expect(outsideFake.mutations()).toEqual([]);

    const symlinkRepo = await makeRepository();
    const symlinkFake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(symlinkFake), repositoryRoot: symlinkRepo.root, manifestRoot: symlinkRepo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: symlinkRepo.paths }, planPath: symlinkRepo.planPath });
    const outsideTarget = resolve(await mkdtemp(join(tmpdir(), "seo-ops-outside-")), "journal.jsonl");
    await writeFile(outsideTarget, "");
    await symlink(outsideTarget, symlinkRepo.evidencePath);
    await expect(apply({ client: createClient(symlinkFake), repositoryRoot: symlinkRepo.root, manifestRoot: symlinkRepo.manifestRoot,
      planPath: symlinkRepo.planPath, evidencePath: symlinkRepo.evidencePath })).rejects.toThrow(/symlink/i);
    expect(symlinkFake.mutations()).toEqual([]);
  });
});

describe("durable apply journal and immutable create boundary", () => {
  it("pre-opens and fsyncs the journal, records every intent/outcome, and publishes only the new non-reference UUID", async () => {
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const apply = exported<Apply>("applyAgentReconciliationPlan");
    const repo = await makeRepository();
    const fake = new FakeCore([referenceAgent()]);
    await dryRun({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath });

    let journalWasDurableBeforeCreate = false;
    fake.onCreate = async () => {
      const records = await readJournal(repo.evidencePath);
      journalWasDurableBeforeCreate = records.some((record) => record.type === "CREATE_INTENT");
    };
    const probePath = resolve(repo.root, "sync-probe");
    const probe = await open(probePath, "w");
    const syncSpy = vi.spyOn(Object.getPrototypeOf(probe) as { sync: () => Promise<void> }, "sync");
    await probe.close();
    await unlink(probePath);

    const result = await apply({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      planPath: repo.planPath, evidencePath: repo.evidencePath });
    expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    syncSpy.mockRestore();

    expect(journalWasDurableBeforeCreate).toBe(true);
    expect(result).toMatchObject([{ action: "CREATE", agent_id: CREATED_ID, remote_rollback: "NO_DELETE_REMOTE_ROLLBACK" }]);
    expect(fake.mutations()).toEqual(["POST /api/agents", `POST /api/agents/${CREATED_ID}/publish`]);
    const records = await readJournal(repo.evidencePath);
    expect(records.map((record) => record.type)).toEqual([
      "JOURNAL_OPENED", "CREATE_INTENT", "CREATE_OUTCOME", "PUBLISH_INTENT", "PUBLISH_OUTCOME", "READBACK_OUTCOME",
    ]);
    expect(records.at(-1)).toMatchObject({ evidence_scope: "EDITABLE_CONFIG_AND_STATUS_ONLY" });
    const persisted = `${await readFile(repo.planPath, "utf8")}\n${await readFile(repo.evidencePath, "utf8")}`;
    expect(persisted).not.toContain(TOKEN_SENTINEL);
    expect(persisted).not.toContain(PROMPT_SENTINEL);
    expect(persisted).not.toContain("REFERENCE_PROMPT_SENTINEL");
  });

  it("keeps earlier Agent outcomes durable when a later readback fails", async () => {
    const secondManifest = { ...manifest, name: "[SEO Ops] Second Agent v1" };
    const repo = await makeRepository([
      { file: "first.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...manifest } },
      { file: "second.json", value: { manifest_version: "seo_ops.core_ai_agent_manifest.v1", ...secondManifest } },
    ]);
    const fake = new FakeCore([referenceAgent()]);
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const apply = exported<Apply>("applyAgentReconciliationPlan");
    await dryRun({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath });
    fake.onPublish = (created) => { if (created.id === SECOND_CREATED_ID) created.system_prompt_id = "unsafe-after-publish"; };

    await expect(apply({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      planPath: repo.planPath, evidencePath: repo.evidencePath })).rejects.toThrow(/readback|mismatch/i);
    const records = await readJournal(repo.evidencePath);
    expect(records.some((record) => record.type === "READBACK_OUTCOME" && record.agent_id === CREATED_ID)).toBe(true);
    expect(records.some((record) => record.type === "READBACK_FAILED" && record.agent_id === SECOND_CREATED_ID)).toBe(true);
    expect(fake.mutations()).toEqual([
      "POST /api/agents", `POST /api/agents/${CREATED_ID}/publish`,
      "POST /api/agents", `POST /api/agents/${SECOND_CREATED_ID}/publish`,
    ]);
  });

  it("rejects a malicious create response that reuses the mandatory reference UUID before publish", async () => {
    const repo = await makeRepository();
    const fake = new FakeCore([referenceAgent()]);
    const dryRun = exported<DryRun>("dryRunAgentReconciliation");
    const apply = exported<Apply>("applyAgentReconciliationPlan");
    await dryRun({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      selection: { kind: "EXPLICIT", paths: repo.paths }, planPath: repo.planPath });
    fake.createIds = [REFERENCE_ID];
    await expect(apply({ client: createClient(fake), repositoryRoot: repo.root, manifestRoot: repo.manifestRoot,
      planPath: repo.planPath, evidencePath: repo.evidencePath })).rejects.toThrow(/reference/i);
    expect(fake.mutations()).toEqual(["POST /api/agents"]);
    expect((await readJournal(repo.evidencePath)).map((record) => record.type)).toEqual([
      "JOURNAL_OPENED", "CREATE_INTENT", "CREATE_OUTCOME", "CREATE_REJECTED",
    ]);
  });

  it("has no PUT, DELETE, or executable rollback capability", () => {
    const client = createClient(new FakeCore([]));
    expect("updateAgent" in client).toBe(false);
    expect("deleteAgent" in client).toBe(false);
    expect("rollbackManagedAgent" in admin).toBe(false);
  });
});

describe("HTTP and response safety", () => {
  it("keeps the abort deadline active while a body stalls after headers", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode("{")); },
      });
      init?.signal?.addEventListener("abort", () => bodyController?.error(new DOMException("aborted", "AbortError")), { once: true });
      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = (admin.createCoreAiAgentAdminClient as any)({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, timeoutMs: 5 });
    await expect(client.getAgent(MANAGED_ID)).rejects.toThrow(/request failed|deadline/i);
  });

  it("enforces the absolute deadline through synchronous JSON parsing", async () => {
    const response = json(publicAgent(remoteAgent()));
    const fetchImpl = vi.fn().mockResolvedValueOnce(response) as unknown as typeof fetch;
    const originalParse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text: string) => {
      const started = Date.now();
      while (Date.now() - started < 15) { /* deliberate parser stall */ }
      return originalParse(text) as unknown;
    });
    try {
      const client = (admin.createCoreAiAgentAdminClient as any)({
        baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, timeoutMs: 5,
      });
      await expect(client.getAgent(MANAGED_ID)).rejects.toThrow(/deadline|request failed/i);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it("validates origins, encodes pagination queries, rejects bad responses, and contains secrets", async () => {
    expect(() => (admin.createCoreAiAgentAdminClient as any)({ baseUrl: "http://core.example.test", token: TOKEN_SENTINEL })).toThrow(/HTTPS/i);
    expect(() => (admin.createCoreAiAgentAdminClient as any)({ baseUrl: "https://user:pass@core.example.test", token: TOKEN_SENTINEL })).toThrow(/credentials/i);
    expect(() => (admin.createCoreAiAgentAdminClient as any)({ baseUrl: "http://127.0.0.1:9999", token: TOKEN_SENTINEL })).not.toThrow();

    const queryFetch = vi.fn().mockResolvedValueOnce(json({ agents: [], total: 0, page: 1, limit: 2 })) as unknown as typeof fetch;
    const queryClient = (admin.createCoreAiAgentAdminClient as any)({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl: queryFetch, pageLimit: 2 });
    await queryClient.listAgentsPage({ query: "Agent / ? # %", page: 1, my: true, includeSystemDefault: false });
    const queryUrl = new URL(String((queryFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]));
    expect(queryUrl.searchParams.get("query")).toBe("Agent / ? # %");
    expect(queryUrl.searchParams.get("my")).toBe("true");
    expect(queryUrl.searchParams.get("include_system_default")).toBe("false");
    expect(queryUrl.toString()).not.toContain(TOKEN_SENTINEL);

    for (const response of [
      json({}, 302, { location: "https://evil.example" }),
      new Response(`${TOKEN_SENTINEL} ${PROMPT_SENTINEL}`, { headers: { "content-type": "text/plain" } }),
      json({}, 200, { "content-length": "999999" }),
    ]) {
      const fetchImpl = vi.fn().mockResolvedValueOnce(response) as unknown as typeof fetch;
      const client = (admin.createCoreAiAgentAdminClient as any)({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, maxResponseBytes: 64 });
      const error = await client.getAgent(MANAGED_ID).catch((caught: unknown) => caught);
      expect(String(error)).not.toContain(TOKEN_SENTINEL);
      expect(String(error)).not.toContain(PROMPT_SENTINEL);
    }
  });

  it("cancels an unknown-length body immediately after the byte limit", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; if (pulls <= 10) controller.enqueue(new Uint8Array(16).fill(32)); else controller.close(); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = (admin.createCoreAiAgentAdminClient as any)({ baseUrl: BASE_URL, token: TOKEN_SENTINEL, fetchImpl, maxResponseBytes: 64 });
    await expect(client.getAgent(MANAGED_ID)).rejects.toThrow(/byte limit/i);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(10);
  });
});

describe("explicit CLI scope contract", () => {
  it("requires one reviewed dry-run scope and makes apply consume only plan plus evidence", () => {
    const parse = exported<(argv: string[]) => any>("parseAgentReconciliationArguments");
    expect(() => parse(["--mode=dry-run", "--plan=/repo/plan.json"])).toThrow(/scope|--all|--manifest/i);
    expect(() => parse(["--mode=dry-run", "--all", "--manifest=a.json", "--plan=/repo/plan.json"])).toThrow(/scope|both/i);
    expect(parse(["--mode=dry-run", "--all", "--plan=/repo/plan.json"])).toMatchObject({
      mode: "dry-run", selection: { kind: "ALL" }, planPath: "/repo/plan.json",
    });
    expect(parse(["--mode=dry-run", "--manifest=a.json", "--manifest=b.json", "--plan=/repo/plan.json"])).toMatchObject({
      mode: "dry-run", selection: { kind: "EXPLICIT", paths: ["a.json", "b.json"] },
    });
    expect(() => parse(["--mode=apply", "--plan=/repo/plan.json"])).toThrow(/evidence/i);
    expect(() => parse(["--mode=apply", "--all", "--plan=/repo/plan.json", "--evidence=/repo/evidence.jsonl"])).toThrow(/scope|plan/i);
    expect(parse(["--mode=apply", "--plan=/repo/plan.json", "--evidence=/repo/evidence.jsonl"])).toEqual({
      mode: "apply", planPath: "/repo/plan.json", evidencePath: "/repo/evidence.jsonl",
    });
    expect(() => parse(["--mode=dry-run", "--all", "--plan=/repo/plan.json", "--token=SECRET_VALUE"])).toThrow(/environment|credential/i);
  });
});

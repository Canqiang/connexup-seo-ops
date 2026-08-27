import { constants } from "node:fs";
import { appendFile, open, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute, dirname, relative } from "node:path";

export const EDITABLE_REFERENCE_ONLY = "EDITABLE_REFERENCE_ONLY" as const;
export const DEFAULT_REFERENCE_AGENT_NAME = "GooglePost每周图文助手";

export interface AgentTool {
  id: string;
  type: string;
  source?: string;
}

export interface AgentManifest {
  name: string;
  description: string;
  system_prompt: string;
  model: string;
  temperature?: number;
  thinking_effort: string | null;
  max_turns: number;
  timeout_seconds: number;
  enable_memory: boolean;
  type: string;
  tools: AgentTool[];
  skill_ids: string[];
  subagent_ids: string[];
  dataset_config: unknown[];
  sandbox_config: unknown;
  response_schema: string;
}

export interface CoreAiAgentView extends AgentManifest {
  id: string;
  status?: string;
  created_by?: string | null;
  owner_id?: string | null;
  system_default?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  published_at?: string | null;
  [key: string]: unknown;
}

export interface CoreAiAgentAdminClient {
  getMe(): Promise<{ user_id: string }>;
  listAgents(): Promise<CoreAiAgentView[]>;
  getAgentByName(name: string): Promise<CoreAiAgentView | null>;
  getAgent(id: string): Promise<CoreAiAgentView>;
  createAgent(fields: AgentManifest): Promise<{ id: string }>;
  updateAgent(id: string, fields: AgentManifest): Promise<void>;
  publishAgent(id: string): Promise<void>;
}

export class CoreAiAgentAdminError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
    public readonly endpointPath?: string,
  ) {
    super(message);
    this.name = "CoreAiAgentAdminError";
  }
}

export type ReconcileAction = "CREATE" | "UPDATE" | "NO_CHANGE";

export interface SanitizedReadback {
  id: string;
  name: string;
  status: string | null;
  field_hashes: Record<string, string>;
}

export interface ReconcileResult {
  action: ReconcileAction;
  agent_id: string | null;
  name: string;
  changed_fields: string[];
  changed_field_hashes: Record<string, { current: string | null; desired: string }>;
  readback?: SanitizedReadback;
  rollback?: {
    managed_agent_id: string;
    prior_normalized_fields: Record<string, unknown> | null;
    method: "PUT_PUBLISH_GET" | "NO_DELETE_ROLLBACK_FOR_NEW_AGENT";
  };
}

export interface ReferenceSummary {
  id: string;
  name: string;
  status: string | null;
  owner_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  published_at: string | null;
  field_hashes: Record<string, string>;
  tools_hash: string;
  skill_ids_hash: string;
  label: typeof EDITABLE_REFERENCE_ONLY;
}

export interface RollbackEvidence {
  managed_agent_id: string;
  prior_normalized_fields: AgentManifest;
}

const MUTATION_FIELDS = [
  "name",
  "description",
  "system_prompt",
  "model",
  "temperature",
  "thinking_effort",
  "max_turns",
  "timeout_seconds",
  "enable_memory",
  "type",
  "tools",
  "skill_ids",
  "subagent_ids",
  "dataset_config",
  "sandbox_config",
  "response_schema",
] as const;

type MutationField = (typeof MUTATION_FIELDS)[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new CoreAiAgentAdminError(`Agent field ${key} must be a non-empty string`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CoreAiAgentAdminError(`Agent field ${key} must be a finite number`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new CoreAiAgentAdminError(`Agent field ${key} must be a string array`);
  }
  return [...value] as string[];
}

function jsonArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new CoreAiAgentAdminError(`Agent field ${key} must be an array`);
  return structuredClone(value);
}

function normalizeTools(value: unknown): AgentTool[] {
  if (!Array.isArray(value)) throw new CoreAiAgentAdminError("Agent field tools must be an array");
  return value.map((item) => {
    if (!isRecord(item)) throw new CoreAiAgentAdminError("Agent tool must be an object");
    const tool: AgentTool = { id: requiredString(item, "id"), type: requiredString(item, "type") };
    if (item.source !== undefined) tool.source = requiredString(item, "source");
    return tool;
  });
}

/** Copies only fields accepted by Core AI CreateAgentRequest/UpdateAgentRequest. */
export function normalizeAgentFields(value: unknown): AgentManifest {
  if (!isRecord(value)) throw new CoreAiAgentAdminError("Agent manifest must be an object");
  const temperature = value.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || !Number.isFinite(temperature))) {
    throw new CoreAiAgentAdminError("Agent field temperature must be a finite number");
  }
  if (typeof value.enable_memory !== "boolean") {
    throw new CoreAiAgentAdminError("Agent field enable_memory must be a boolean");
  }
  const normalized: AgentManifest = {
    name: requiredString(value, "name"),
    description: requiredString(value, "description"),
    system_prompt: requiredString(value, "system_prompt"),
    model: requiredString(value, "model"),
    ...(temperature === undefined ? {} : { temperature }),
    thinking_effort: value.thinking_effort === null ? null : requiredString(value, "thinking_effort"),
    max_turns: requiredNumber(value, "max_turns"),
    timeout_seconds: requiredNumber(value, "timeout_seconds"),
    enable_memory: value.enable_memory,
    type: requiredString(value, "type"),
    tools: normalizeTools(value.tools),
    skill_ids: stringArray(value, "skill_ids"),
    subagent_ids: stringArray(value, "subagent_ids"),
    dataset_config: jsonArray(value, "dataset_config"),
    sandbox_config: structuredClone(value.sandbox_config),
    response_schema: requiredString(value, "response_schema"),
  };
  return normalized;
}

/** Core AI serializes persisted empty lists as null; desired manifests use explicit empty arrays. */
function normalizeRemoteAgentFields(value: unknown): AgentManifest {
  if (!isRecord(value)) throw new CoreAiAgentAdminError("Core AI Agent response is invalid");
  const remote: Record<string, unknown> = { ...value };
  for (const key of ["tools", "skill_ids", "subagent_ids", "dataset_config"]) {
    if (remote[key] === null) remote[key] = [];
  }
  if (Array.isArray(remote.tools)) {
    remote.tools = remote.tools.map((tool) => {
      if (!isRecord(tool) || tool.source !== null) return tool;
      const { source: _source, ...withoutNullSource } = tool;
      return withoutNullSource;
    });
  }
  return normalizeAgentFields(remote);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function fieldHashes(fields: AgentManifest): Record<string, string> {
  return Object.fromEntries(MUTATION_FIELDS
    .filter((field) => fields[field] !== undefined)
    .map((field) => [field, hash(fields[field])])) as Record<string, string>;
}

function sanitizedPriorFields(fields: AgentManifest): Record<string, unknown> {
  return {
    name: fields.name,
    description: fields.description,
    model: fields.model,
    ...(fields.temperature === undefined ? {} : { temperature: fields.temperature }),
    thinking_effort: fields.thinking_effort,
    max_turns: fields.max_turns,
    timeout_seconds: fields.timeout_seconds,
    enable_memory: fields.enable_memory,
    type: fields.type,
    system_prompt_hash: hash(fields.system_prompt),
    tools_hash: hash(fields.tools),
    skill_ids_hash: hash(fields.skill_ids),
    subagent_ids_hash: hash(fields.subagent_ids),
    dataset_config_hash: hash(fields.dataset_config),
    sandbox_config_hash: hash(fields.sandbox_config),
    response_schema_hash: hash(fields.response_schema),
  };
}

function loopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "::1" || lower === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(lower);
}

function checkedBaseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CoreAiAgentAdminError("Core AI base URL is invalid");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new CoreAiAgentAdminError("Core AI base URL must not contain credentials");
  }
  if (parsed.search !== "") throw new CoreAiAgentAdminError("Core AI base URL must not contain a query");
  if (parsed.hash !== "") throw new CoreAiAgentAdminError("Core AI base URL must not contain a fragment");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback(parsed.hostname))) {
    throw new CoreAiAgentAdminError("Core AI base URL must use HTTPS except for explicit loopback URLs");
  }
  if (parsed.pathname !== "/") {
    throw new CoreAiAgentAdminError("Core AI base URL must be an origin without a path");
  }
  return parsed;
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (!uuid(value)) throw new CoreAiAgentAdminError(`${label} must be a server-returned UUID`);
}

function responseList(value: unknown): CoreAiAgentView[] {
  const possible = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : isRecord(value) && Array.isArray(value.items)
      ? value.items
      : isRecord(value) && Array.isArray(value.content)
        ? value.content
        : isRecord(value) && Array.isArray(value.data)
          ? value.data
          : null;
  if (!possible || possible.some((item) => !isRecord(item))) {
    throw new CoreAiAgentAdminError("Core AI Agent list response is invalid");
  }
  return possible as CoreAiAgentView[];
}

export function createCoreAiAgentAdminClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}): CoreAiAgentAdminClient {
  const base = checkedBaseUrl(opts.baseUrl);
  if (typeof opts.token !== "string" || opts.token.length === 0) {
    throw new CoreAiAgentAdminError("Core AI token is required");
  }
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxResponseBytes = opts.maxResponseBytes ?? 1_048_576;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new CoreAiAgentAdminError("timeoutMs is invalid");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new CoreAiAgentAdminError("maxResponseBytes is invalid");

  async function request(method: "GET" | "POST" | "PUT", path: string, requestBody?: AgentManifest): Promise<unknown> {
    if (!path.startsWith("/api/") || path.includes("?") || path.includes("#")) {
      throw new CoreAiAgentAdminError("Core AI endpoint path is invalid");
    }
    const target = new URL(path, base);
    if (target.origin !== base.origin) throw new CoreAiAgentAdminError("Core AI endpoint origin is invalid");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new CoreAiAgentAdminError(`Core AI request failed (${method} ${path})`, 0, path);
    } finally {
      clearTimeout(timer);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CoreAiAgentAdminError(`Core AI returned ${response.status} (${method} ${path})`, response.status, path);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CoreAiAgentAdminError(`Core AI returned ${response.status} (${method} ${path})`, response.status, path);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json") && !contentType.includes("+json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new CoreAiAgentAdminError(`Core AI returned a non-JSON response (${method} ${path})`, response.status, path);
    }
    const declared = response.headers.get("content-length");
    if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new CoreAiAgentAdminError(`Core AI response exceeds byte limit (${method} ${path})`, response.status, path);
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader !== undefined) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxResponseBytes) {
            await reader.cancel().catch(() => undefined);
            throw new CoreAiAgentAdminError(`Core AI response exceeds byte limit (${method} ${path})`, response.status, path);
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof CoreAiAgentAdminError) throw error;
        throw new CoreAiAgentAdminError(`Core AI response read failed (${method} ${path})`, response.status, path);
      } finally {
        reader.releaseLock();
      }
    }
    const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CoreAiAgentAdminError(`Core AI returned invalid JSON (${method} ${path})`, response.status, path);
    }
  }

  return {
    async getMe() {
      const body = await request("GET", "/api/auth/me");
      if (!isRecord(body) || typeof body.user_id !== "string" || body.user_id.length === 0) {
        throw new CoreAiAgentAdminError("Core AI /api/auth/me response is invalid");
      }
      return { user_id: body.user_id };
    },
    async listAgents() {
      return responseList(await request("GET", "/api/agents"));
    },
    async getAgentByName(name) {
      const path = `/api/agents/name/${encodeURIComponent(name)}`;
      try {
        const body = await request("GET", path);
        if (!isRecord(body)) throw new CoreAiAgentAdminError("Core AI Agent response is invalid");
        return body as CoreAiAgentView;
      } catch (error) {
        if (error instanceof CoreAiAgentAdminError && error.status === 404) return null;
        throw error;
      }
    },
    async getAgent(id) {
      assertUuid(id, "Agent ID");
      const body = await request("GET", `/api/agents/${encodeURIComponent(id)}`);
      if (!isRecord(body)) throw new CoreAiAgentAdminError("Core AI Agent response is invalid");
      return body as CoreAiAgentView;
    },
    async createAgent(fields) {
      const body = await request("POST", "/api/agents", normalizeAgentFields(fields));
      if (!isRecord(body)) throw new CoreAiAgentAdminError("Core AI create response is invalid");
      assertUuid(body.id, "Created Agent ID");
      return { id: body.id };
    },
    async updateAgent(id, fields) {
      assertUuid(id, "Agent ID");
      await request("PUT", `/api/agents/${encodeURIComponent(id)}`, normalizeAgentFields(fields));
    },
    async publishAgent(id) {
      assertUuid(id, "Agent ID");
      await request("POST", `/api/agents/${encodeURIComponent(id)}/publish`);
    },
  };
}

function assertDesiredName(name: string): void {
  if (!name.startsWith("[SEO Ops]")) {
    throw new CoreAiAgentAdminError("Desired managed Agent name must begin [SEO Ops]");
  }
  if (name === DEFAULT_REFERENCE_AGENT_NAME) {
    throw new CoreAiAgentAdminError("Desired Agent name may not equal the reference Agent name");
  }
}

function assertMutationTarget(id: string, referenceAgentId?: string): void {
  assertUuid(id, "Mutation target Agent ID");
  if (referenceAgentId !== undefined && id === referenceAgentId) {
    throw new CoreAiAgentAdminError("The reference Agent is read-only and cannot be a mutation target");
  }
}

function diffFields(current: AgentManifest, desired: AgentManifest): {
  names: string[];
  hashes: Record<string, { current: string | null; desired: string }>;
} {
  const names: string[] = [];
  const hashes: Record<string, { current: string | null; desired: string }> = {};
  for (const field of MUTATION_FIELDS) {
    if (desired[field] === undefined) continue;
    if (canonical(current[field]) !== canonical(desired[field])) {
      names.push(field);
      hashes[field] = {
        current: current[field] === undefined ? null : hash(current[field]),
        desired: hash(desired[field]),
      };
    }
  }
  return { names, hashes };
}

function sanitizedReadback(view: CoreAiAgentView, fields: AgentManifest): SanitizedReadback {
  return {
    id: view.id,
    name: view.name,
    status: typeof view.status === "string" ? view.status : null,
    field_hashes: fieldHashes(fields),
  };
}

function assertReadback(view: CoreAiAgentView, expectedId: string, desired: AgentManifest): SanitizedReadback {
  if (view.id !== expectedId) throw new CoreAiAgentAdminError("Core AI Agent readback mismatch: id");
  if (view.name !== desired.name) throw new CoreAiAgentAdminError("Core AI Agent readback mismatch: name");
  if (view.status !== "PUBLISHED") throw new CoreAiAgentAdminError("Core AI Agent readback mismatch: status");
  const actual = normalizeRemoteAgentFields(view);
  const differences = diffFields(actual, desired).names;
  if (differences.length > 0) {
    throw new CoreAiAgentAdminError(`Core AI Agent readback mismatch: ${differences.join(", ")}`);
  }
  return sanitizedReadback(view, actual);
}

function assertOwnedManaged(view: CoreAiAgentView, userId: string): void {
  assertDesiredName(view.name);
  if (view.created_by !== userId) {
    throw new CoreAiAgentAdminError("Existing managed Agent is not owned by the current Core AI user");
  }
  if (view.system_default === true) {
    throw new CoreAiAgentAdminError("Existing managed Agent is system-default and cannot be mutated");
  }
}

export async function reconcileAgent(input: {
  client: CoreAiAgentAdminClient;
  manifest: AgentManifest | Record<string, unknown>;
  mode: "dry-run" | "apply";
  referenceAgentId?: string;
}): Promise<ReconcileResult> {
  const desired = normalizeAgentFields(input.manifest);
  assertDesiredName(desired.name);
  const existing = await input.client.getAgentByName(desired.name);
  if (existing === null) {
    if (input.mode === "dry-run") {
      return {
        action: "CREATE",
        agent_id: null,
        name: desired.name,
        changed_fields: [...MUTATION_FIELDS].filter((field) => desired[field] !== undefined),
        changed_field_hashes: Object.fromEntries(MUTATION_FIELDS
          .filter((field) => desired[field] !== undefined)
          .map((field) => [field, { current: null, desired: hash(desired[field]) }])),
      };
    }
    const created = await input.client.createAgent(desired);
    assertMutationTarget(created.id, input.referenceAgentId);
    await input.client.publishAgent(created.id);
    const readback = await input.client.getAgent(created.id);
    return {
      action: "CREATE",
      agent_id: created.id,
      name: desired.name,
      changed_fields: [...MUTATION_FIELDS].filter((field) => desired[field] !== undefined),
      changed_field_hashes: Object.fromEntries(MUTATION_FIELDS
        .filter((field) => desired[field] !== undefined)
        .map((field) => [field, { current: null, desired: hash(desired[field]) }])),
      readback: assertReadback(readback, created.id, desired),
      rollback: {
        managed_agent_id: created.id,
        prior_normalized_fields: null,
        method: "NO_DELETE_ROLLBACK_FOR_NEW_AGENT",
      },
    };
  }
  if (existing.name !== desired.name) {
    throw new CoreAiAgentAdminError("Core AI returned a name-collision Agent instead of the exact desired name");
  }
  assertMutationTarget(existing.id, input.referenceAgentId);
  const current = normalizeRemoteAgentFields(existing);
  const differences = diffFields(current, desired);
  if (differences.names.length === 0) {
    return {
      action: "NO_CHANGE",
      agent_id: existing.id,
      name: desired.name,
      changed_fields: [],
      changed_field_hashes: {},
    };
  }
  if (input.mode === "dry-run") {
    return {
      action: "UPDATE",
      agent_id: existing.id,
      name: desired.name,
      changed_fields: differences.names,
      changed_field_hashes: differences.hashes,
    };
  }
  const me = await input.client.getMe();
  assertOwnedManaged(existing, me.user_id);
  await input.client.updateAgent(existing.id, desired);
  await input.client.publishAgent(existing.id);
  const readback = await input.client.getAgent(existing.id);
  return {
    action: "UPDATE",
    agent_id: existing.id,
    name: desired.name,
    changed_fields: differences.names,
    changed_field_hashes: differences.hashes,
    readback: assertReadback(readback, existing.id, desired),
    rollback: {
      managed_agent_id: existing.id,
      prior_normalized_fields: sanitizedPriorFields(current),
      method: "PUT_PUBLISH_GET",
    },
  };
}

export async function reconcileAgents(input: {
  client: CoreAiAgentAdminClient;
  manifests: Array<AgentManifest | Record<string, unknown>>;
  mode: "dry-run" | "apply";
  referenceAgentId?: string;
  logger?: (message: string) => void;
}): Promise<ReconcileResult[]> {
  const results: ReconcileResult[] = [];
  for (const manifest of input.manifests) {
    const result = await reconcileAgent({
      client: input.client,
      manifest,
      mode: input.mode,
      ...(input.referenceAgentId === undefined ? {} : { referenceAgentId: input.referenceAgentId }),
    });
    results.push(result);
    input.logger?.(JSON.stringify(result));
  }
  return results;
}

export async function discoverEditableReference(input: {
  client: CoreAiAgentAdminClient;
  referenceName?: string;
}): Promise<ReferenceSummary> {
  const referenceName = input.referenceName ?? DEFAULT_REFERENCE_AGENT_NAME;
  const listed = await input.client.listAgents();
  const exact = listed.filter((view) => view.name === referenceName);
  if (exact.length !== 1) {
    throw new CoreAiAgentAdminError(`Reference discovery requires exactly one exact-name Agent; found ${exact.length}`);
  }
  const detail = await input.client.getAgentByName(referenceName);
  if (detail === null || detail.id !== exact[0]?.id || detail.name !== referenceName) {
    throw new CoreAiAgentAdminError("Reference discovery readback did not match the unique exact-name Agent");
  }
  assertUuid(detail.id, "Reference Agent ID");
  const fields = normalizeRemoteAgentFields(detail);
  return {
    id: detail.id,
    name: detail.name,
    status: typeof detail.status === "string" ? detail.status : null,
    owner_id: typeof detail.owner_id === "string" ? detail.owner_id : null,
    created_at: typeof detail.created_at === "string" ? detail.created_at : null,
    updated_at: typeof detail.updated_at === "string" ? detail.updated_at : null,
    published_at: typeof detail.published_at === "string" ? detail.published_at : null,
    field_hashes: fieldHashes(fields),
    tools_hash: hash(fields.tools),
    skill_ids_hash: hash(fields.skill_ids),
    label: EDITABLE_REFERENCE_ONLY,
  };
}

export async function rollbackManagedAgent(input: {
  client: CoreAiAgentAdminClient;
  evidence: RollbackEvidence;
  referenceAgentId?: string;
}): Promise<{ action: "ROLLBACK"; agent_id: string; readback: SanitizedReadback }> {
  const desired = normalizeAgentFields(input.evidence.prior_normalized_fields);
  assertDesiredName(desired.name);
  assertMutationTarget(input.evidence.managed_agent_id, input.referenceAgentId);
  const me = await input.client.getMe();
  const existing = await input.client.getAgent(input.evidence.managed_agent_id);
  if (existing.id !== input.evidence.managed_agent_id) {
    throw new CoreAiAgentAdminError("Rollback target readback mismatch");
  }
  assertOwnedManaged(existing, me.user_id);
  if (existing.name !== desired.name) throw new CoreAiAgentAdminError("Rollback name collision");
  await input.client.updateAgent(existing.id, desired);
  await input.client.publishAgent(existing.id);
  const readback = await input.client.getAgent(existing.id);
  return { action: "ROLLBACK", agent_id: existing.id, readback: assertReadback(readback, existing.id, desired) };
}

function safeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeEvidence);
  if (!isRecord(value)) return value;
  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|authorization|cookie|header|prompt|body|secret)/i.test(key)) continue;
    sanitized[key] = safeEvidence(child);
  }
  return sanitized;
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export async function appendReconciliationEvidence(input: {
  repositoryRoot: string;
  evidencePath: string;
  records: unknown[];
}): Promise<void> {
  if (!isAbsolute(input.evidencePath)) throw new CoreAiAgentAdminError("Evidence path must be absolute");
  const root = await realpath(input.repositoryRoot);
  const parent = await realpath(dirname(input.evidencePath));
  if (!pathInside(root, parent)) throw new CoreAiAgentAdminError("Evidence path must remain inside the current repository");
  try {
    const existing = await realpath(input.evidencePath);
    if (!pathInside(root, existing)) throw new CoreAiAgentAdminError("Evidence symlink escapes the current repository");
  } catch (error) {
    if (error instanceof CoreAiAgentAdminError) throw error;
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  const payload = `${input.records.length === 0 ? "" : "\n## Core AI Agent reconciliation\n\n"}`
    + `${input.records.length === 0 ? "" : `\`\`\`json\n${JSON.stringify(safeEvidence(input.records), null, 2)}\n\`\`\`\n`}`;
  const handle = await open(
    input.evidencePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await appendFile(handle, payload, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

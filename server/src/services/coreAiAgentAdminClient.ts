import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

const FIXED_REFERENCE_AGENT_NAME = "GooglePost每周图文助手" as const;
export const EDITABLE_REFERENCE_ONLY = "EDITABLE_REFERENCE_ONLY" as const;
export const EDITABLE_CONFIG_AND_STATUS_ONLY = "EDITABLE_CONFIG_AND_STATUS_ONLY" as const;
export const NO_DELETE_REMOTE_ROLLBACK = "NO_DELETE_REMOTE_ROLLBACK" as const;

const PLAN_VERSION = "seo_ops.agent_reconciliation_plan.v1";
const MANIFEST_VERSION = "seo_ops.core_ai_agent_manifest.v1";
const PLAN_DIRECTORY = "docs/evidence/core-ai-agent-plans";
const JOURNAL_DIRECTORY = "docs/evidence/core-ai-agent-journals";

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
  thinking_effort: null;
  max_turns: number;
  timeout_seconds: number;
  enable_memory: boolean;
  type: "AGENT";
  tools: AgentTool[];
  skill_ids: string[];
  subagent_ids: string[];
  dataset_config: unknown[];
  sandbox_config: null;
  response_schema: string;
}

export interface CoreAiAgentView extends Record<string, unknown> {
  id: string;
  name: string;
  status?: string;
  system_default?: boolean | null;
}

export interface AgentListPage {
  agents: CoreAiAgentView[];
  total: number;
  page: number;
  limit: number;
}

export interface CoreAiAgentAdminClient {
  readonly pageLimit: number;
  listAgentsPage(input: {
    query: string;
    page: number;
    my?: boolean;
    includeSystemDefault?: boolean;
  }): Promise<AgentListPage>;
  getAgent(id: string): Promise<CoreAiAgentView>;
  createAgent(fields: AgentManifest): Promise<{ id: string }>;
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

interface PreparedManifest {
  path: string;
  absolutePath: string;
  fileIdentity: string;
  manifest: AgentManifest;
  manifestHash: string;
}

interface RemoteClassification {
  action: "CREATE" | "NO_CHANGE";
  remote_agent_id: string | null;
  remote_state_hash: string;
  action_hash: string;
}

interface ReferenceCoordinate {
  id: string;
  name: typeof FIXED_REFERENCE_AGENT_NAME;
  status: string | null;
  owner_id: string | null;
  updated_at: string | null;
  published_at: string | null;
  editable_hash: string;
  managed_hash: string;
  field_hashes: Record<string, string>;
  executable_field_hashes: Record<string, string>;
  unmanaged_executable_empty: boolean;
  unknown_fields_empty: true;
  label: typeof EDITABLE_REFERENCE_ONLY;
  evidence_scope: typeof EDITABLE_CONFIG_AND_STATUS_ONLY;
  coordinate_hash: string;
}

interface PlanEntry extends RemoteClassification {
  path: string;
  name: string;
  manifest_hash: string;
}

export interface ReconciliationPlan {
  schema_version: typeof PLAN_VERSION;
  created_at: string;
  scope: { kind: "ALL" } | { kind: "EXPLICIT" };
  selected: PlanEntry[];
  reference: ReferenceCoordinate;
  digest: string;
}

const MUTATION_FIELDS = [
  "name", "description", "system_prompt", "model", "temperature", "thinking_effort",
  "max_turns", "timeout_seconds", "enable_memory", "type", "tools", "skill_ids",
  "subagent_ids", "dataset_config", "sandbox_config", "response_schema",
] as const;
type MutationField = (typeof MUTATION_FIELDS)[number];

const UNSUPPORTED_EXECUTABLE_FIELDS = [
  "system_prompt_id", "multi_modal_model", "prefer_caption_path", "input_template", "variables",
] as const;

const REMOTE_METADATA_FIELDS = new Set([
  "id", "status", "created_by", "owner_id", "system_default", "created_at", "updated_at",
  "published_at", "updated_by", "sub_agents", "skills",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new CoreAiAgentAdminError(`Agent manifest field ${key} must be a non-empty string`);
  }
  return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new CoreAiAgentAdminError(`Agent manifest field ${key} must be a string array`);
  }
  return [...value] as string[];
}

function normalizeTools(value: unknown): AgentTool[] {
  if (!Array.isArray(value)) throw new CoreAiAgentAdminError("Agent manifest field tools must be an array");
  return value.map((item) => {
    if (!isRecord(item)) throw new CoreAiAgentAdminError("Agent tool must be an object");
    const allowed = new Set(["id", "type", "source"]);
    if (Object.keys(item).some((key) => !allowed.has(key))) {
      throw new CoreAiAgentAdminError("Agent tool contains an unknown field");
    }
    const tool: AgentTool = { id: requiredString(item, "id"), type: requiredString(item, "type") };
    if (item.source !== undefined && item.source !== null) tool.source = requiredString(item, "source");
    return tool;
  });
}

function normalizeManifest(value: unknown, validateDesiredName = true): AgentManifest {
  if (!isRecord(value)) throw new CoreAiAgentAdminError("Agent manifest must be an object");
  const allowed = new Set<string>(["manifest_version", ...MUTATION_FIELDS]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new CoreAiAgentAdminError(`Agent manifest contains unknown fields: ${unknown.join(", ")}`);
  if (value.manifest_version !== MANIFEST_VERSION) {
    throw new CoreAiAgentAdminError(`Agent manifest_version must be ${MANIFEST_VERSION}`);
  }
  const name = requiredString(value, "name");
  if (validateDesiredName && !/^\[SEO Ops\] .+ v\d+$/.test(name)) {
    throw new CoreAiAgentAdminError("Desired Agent manifest name must be versioned and begin [SEO Ops]");
  }
  if (validateDesiredName && name === FIXED_REFERENCE_AGENT_NAME) throw new CoreAiAgentAdminError("Reference Agent name is read-only");
  const temperature = value.temperature;
  if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 2)) {
    throw new CoreAiAgentAdminError("Agent manifest temperature is invalid");
  }
  const normalizedTemperature = temperature === undefined ? undefined : temperature as number;
  if (value.thinking_effort !== null) throw new CoreAiAgentAdminError("Agent manifest thinking_effort must be null");
  if (!Number.isInteger(value.max_turns) || (value.max_turns as number) < 1 || (value.max_turns as number) > 20) {
    throw new CoreAiAgentAdminError("Agent manifest max_turns is invalid");
  }
  if (!Number.isInteger(value.timeout_seconds) || (value.timeout_seconds as number) < 30 || (value.timeout_seconds as number) > 600) {
    throw new CoreAiAgentAdminError("Agent manifest timeout_seconds is invalid");
  }
  if (value.enable_memory !== false) throw new CoreAiAgentAdminError("Agent manifest enable_memory must be false");
  if (value.type !== "AGENT") throw new CoreAiAgentAdminError("Agent manifest type must be AGENT");
  const subagentIds = stringArray(value, "subagent_ids");
  if (subagentIds.length !== 0) throw new CoreAiAgentAdminError("Agent manifest subagent_ids must be empty");
  if (!Array.isArray(value.dataset_config) || value.dataset_config.length !== 0) {
    throw new CoreAiAgentAdminError("Agent manifest dataset_config must be empty");
  }
  if (value.sandbox_config !== null) throw new CoreAiAgentAdminError("Agent manifest sandbox_config must be null");
  const responseSchema = requiredString(value, "response_schema");
  try {
    const parsed = JSON.parse(responseSchema) as unknown;
    if (!isRecord(parsed) || parsed.type !== "object") throw new Error("not object schema");
  } catch {
    throw new CoreAiAgentAdminError("Agent manifest response_schema must encode an object schema");
  }
  return {
    name,
    description: requiredString(value, "description"),
    system_prompt: requiredString(value, "system_prompt"),
    model: requiredString(value, "model"),
    ...(normalizedTemperature === undefined ? {} : { temperature: normalizedTemperature }),
    thinking_effort: null,
    max_turns: value.max_turns as number,
    timeout_seconds: value.timeout_seconds as number,
    enable_memory: false,
    type: "AGENT",
    tools: normalizeTools(value.tools),
    skill_ids: stringArray(value, "skill_ids"),
    subagent_ids: subagentIds,
    dataset_config: [],
    sandbox_config: null,
    response_schema: responseSchema,
  };
}

function normalizeRemoteManaged(value: Record<string, unknown>): AgentManifest {
  const remote: Record<string, unknown> = {
    manifest_version: MANIFEST_VERSION,
    ...Object.fromEntries(MUTATION_FIELDS.map((field) => [field, value[field]])),
  };
  if (remote.temperature === null) delete remote.temperature;
  for (const key of ["tools", "skill_ids", "subagent_ids", "dataset_config"] as const) {
    if (remote[key] === null) remote[key] = [];
  }
  return normalizeManifest(remote, false);
}

type ReferenceManagedSnapshot = {
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  temperature: number | null;
  thinking_effort: string | null;
  max_turns: number;
  timeout_seconds: number;
  enable_memory: boolean;
  type: "AGENT";
  tools: Array<{ id: string; type: string; source: string }>;
  skill_ids: string[] | null;
  subagent_ids: string[] | null;
  dataset_config: unknown[] | null;
  sandbox_config: Record<string, unknown> | null;
  response_schema: string | null;
};

function referenceString(value: unknown, field: string, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string") throw new CoreAiAgentAdminError(`Reference Agent ${field} type is invalid`);
  return value;
}

function referenceStringArray(value: unknown, field: string): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CoreAiAgentAdminError(`Reference Agent ${field} type is invalid`);
  }
  return [...value] as string[];
}

function referenceTools(value: unknown): ReferenceManagedSnapshot["tools"] {
  if (!Array.isArray(value)) throw new CoreAiAgentAdminError("Reference Agent tools type is invalid");
  return value.map((item) => {
    if (!isRecord(item)) throw new CoreAiAgentAdminError("Reference Agent tool type is invalid");
    const keys = Object.keys(item).sort();
    if (keys.length !== 3 || keys[0] !== "id" || keys[1] !== "source" || keys[2] !== "type"
      || typeof item.id !== "string" || typeof item.type !== "string" || typeof item.source !== "string") {
      throw new CoreAiAgentAdminError("Reference Agent tool shape is invalid");
    }
    return { id: item.id, type: item.type, source: item.source };
  });
}

function referenceManagedSnapshot(view: CoreAiAgentView): ReferenceManagedSnapshot {
  const temperature = view.temperature;
  if (temperature !== null && temperature !== undefined
    && (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0)) {
    throw new CoreAiAgentAdminError("Reference Agent temperature type is invalid");
  }
  if (!Number.isSafeInteger(view.max_turns) || (view.max_turns as number) <= 0) {
    throw new CoreAiAgentAdminError("Reference Agent max_turns type is invalid");
  }
  if (!Number.isSafeInteger(view.timeout_seconds) || (view.timeout_seconds as number) <= 0) {
    throw new CoreAiAgentAdminError("Reference Agent timeout_seconds type is invalid");
  }
  if (typeof view.enable_memory !== "boolean") {
    throw new CoreAiAgentAdminError("Reference Agent enable_memory type is invalid");
  }
  if (view.type !== "AGENT") throw new CoreAiAgentAdminError("Reference Agent type is invalid");
  if (view.thinking_effort !== null && view.thinking_effort !== undefined
    && typeof view.thinking_effort !== "string") {
    throw new CoreAiAgentAdminError("Reference Agent thinking_effort type is invalid");
  }
  if (view.dataset_config !== null && view.dataset_config !== undefined && !Array.isArray(view.dataset_config)) {
    throw new CoreAiAgentAdminError("Reference Agent dataset_config type is invalid");
  }
  if (view.sandbox_config !== null && view.sandbox_config !== undefined && !isRecord(view.sandbox_config)) {
    throw new CoreAiAgentAdminError("Reference Agent sandbox_config type is invalid");
  }
  return {
    name: referenceString(view.name, "name")!,
    description: referenceString(view.description, "description")!,
    system_prompt: referenceString(view.system_prompt, "system_prompt")!,
    model: referenceString(view.model, "model", true),
    temperature: temperature === null || temperature === undefined ? null : temperature as number,
    thinking_effort: view.thinking_effort === null || view.thinking_effort === undefined
      ? null : view.thinking_effort as string,
    max_turns: view.max_turns as number,
    timeout_seconds: view.timeout_seconds as number,
    enable_memory: view.enable_memory,
    type: "AGENT",
    tools: referenceTools(view.tools),
    skill_ids: referenceStringArray(view.skill_ids, "skill_ids"),
    subagent_ids: referenceStringArray(view.subagent_ids, "subagent_ids"),
    dataset_config: view.dataset_config === null || view.dataset_config === undefined
      ? null : [...view.dataset_config] as unknown[],
    sandbox_config: view.sandbox_config === null || view.sandbox_config === undefined
      ? null : { ...view.sandbox_config } as Record<string, unknown>,
    response_schema: referenceString(view.response_schema, "response_schema", true),
  };
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertUuid(value: unknown, label: string): asserts value is string {
  if (!uuid(value)) throw new CoreAiAgentAdminError(`${label} must be a UUID`);
}

function loopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "::1" || lower === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(lower);
}

function checkedBaseUrl(raw: string): URL {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new CoreAiAgentAdminError("Core AI base URL is invalid"); }
  if (parsed.username || parsed.password) throw new CoreAiAgentAdminError("Core AI base URL must not contain credentials");
  if (parsed.search) throw new CoreAiAgentAdminError("Core AI base URL must not contain a query");
  if (parsed.hash) throw new CoreAiAgentAdminError("Core AI base URL must not contain a fragment");
  if (parsed.pathname !== "/") throw new CoreAiAgentAdminError("Core AI base URL must be an origin");
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback(parsed.hostname))) {
    throw new CoreAiAgentAdminError("Core AI base URL must use HTTPS except for loopback");
  }
  return parsed;
}

function assertBeforeDeadline(deadline: number, method: string, endpointPath: string): void {
  if (performance.now() >= deadline) {
    throw new CoreAiAgentAdminError(`Core AI request deadline exceeded (${method} ${endpointPath})`, 0, endpointPath);
  }
}

async function boundedJson(
  response: Response,
  maxBytes: number,
  method: string,
  endpointPath: string,
  deadline: number,
): Promise<unknown> {
  assertBeforeDeadline(deadline, method, endpointPath);
  if (response.status === 204) return null;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new CoreAiAgentAdminError(`Core AI returned non-JSON (${method} ${endpointPath})`, response.status, endpointPath);
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CoreAiAgentAdminError(`Core AI response exceeds byte limit (${method} ${endpointPath})`, response.status, endpointPath);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader !== undefined) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        assertBeforeDeadline(deadline, method, endpointPath);
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new CoreAiAgentAdminError(`Core AI response exceeds byte limit (${method} ${endpointPath})`, response.status, endpointPath);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const text = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  assertBeforeDeadline(deadline, method, endpointPath);
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch {
    throw new CoreAiAgentAdminError(`Core AI returned invalid JSON (${method} ${endpointPath})`, response.status, endpointPath);
  }
  assertBeforeDeadline(deadline, method, endpointPath);
  return parsed;
}

export function createCoreAiAgentAdminClient(opts: {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  pageLimit?: number;
  fetchImpl?: typeof fetch;
}): CoreAiAgentAdminClient {
  const base = checkedBaseUrl(opts.baseUrl);
  if (!opts.token) throw new CoreAiAgentAdminError("Core AI token is required");
  const token = opts.token;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxResponseBytes = opts.maxResponseBytes ?? 1_048_576;
  const pageLimit = opts.pageLimit ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new CoreAiAgentAdminError("timeoutMs is invalid");
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new CoreAiAgentAdminError("maxResponseBytes is invalid");
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 200) throw new CoreAiAgentAdminError("pageLimit is invalid");

  async function request(
    method: "GET" | "POST",
    endpointPath: string,
    query?: Record<string, string>,
    requestBody?: AgentManifest,
  ): Promise<unknown> {
    if (!endpointPath.startsWith("/api/") || endpointPath.includes("?") || endpointPath.includes("#")) {
      throw new CoreAiAgentAdminError("Core AI endpoint path is invalid");
    }
    const target = new URL(endpointPath, base);
    if (target.origin !== base.origin) throw new CoreAiAgentAdminError("Core AI endpoint origin is invalid");
    for (const [key, value] of Object.entries(query ?? {})) target.searchParams.set(key, value);
    const controller = new AbortController();
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
        redirect: "error",
        signal: controller.signal,
      });
      assertBeforeDeadline(deadline, method, endpointPath);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new CoreAiAgentAdminError(`Core AI returned ${response.status} (${method} ${endpointPath})`, response.status, endpointPath);
      }
      return await boundedJson(response, maxResponseBytes, method, endpointPath, deadline);
    } catch (error) {
      if (error instanceof CoreAiAgentAdminError) throw error;
      throw new CoreAiAgentAdminError(`Core AI request failed (${method} ${endpointPath})`, 0, endpointPath);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    pageLimit,
    async listAgentsPage(input) {
      if (!Number.isSafeInteger(input.page) || input.page < 1) throw new CoreAiAgentAdminError("Agent list page is invalid");
      const body = await request("GET", "/api/agents", {
        query: input.query,
        page: String(input.page),
        limit: String(pageLimit),
        ...(input.my === undefined ? {} : { my: String(input.my) }),
        ...(input.includeSystemDefault === undefined ? {} : { include_system_default: String(input.includeSystemDefault) }),
      });
      if (!isRecord(body) || !Array.isArray(body.agents)
        || !Number.isSafeInteger(body.total) || (body.total as number) < 0
        || !Number.isSafeInteger(body.page) || !Number.isSafeInteger(body.limit)
        || body.agents.some((agent) => !isRecord(agent))) {
        throw new CoreAiAgentAdminError("Core AI Agent page envelope is invalid");
      }
      return {
        agents: body.agents as CoreAiAgentView[], total: body.total as number,
        page: body.page as number, limit: body.limit as number,
      };
    },
    async getAgent(id) {
      assertUuid(id, "Agent ID");
      const body = await request("GET", `/api/agents/${encodeURIComponent(id)}`);
      if (!isRecord(body)) throw new CoreAiAgentAdminError("Core AI Agent response is invalid");
      return body as CoreAiAgentView;
    },
    async createAgent(fields) {
      const body = await request("POST", "/api/agents", undefined, fields);
      if (!isRecord(body)) throw new CoreAiAgentAdminError("Core AI create response is invalid");
      assertUuid(body.id, "Created Agent ID");
      return { id: body.id };
    },
    async publishAgent(id) {
      assertUuid(id, "Agent ID");
      await request("POST", `/api/agents/${encodeURIComponent(id)}/publish`);
    },
  };
}

async function collectAllAgents(
  client: CoreAiAgentAdminClient,
  input: { query: string; my?: boolean; includeSystemDefault?: boolean },
): Promise<CoreAiAgentView[]> {
  const collected: CoreAiAgentView[] = [];
  const ids = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 10_000; page += 1) {
    const result = await client.listAgentsPage({ ...input, page });
    if (result.page !== page || result.limit !== client.pageLimit) {
      throw new CoreAiAgentAdminError("Core AI Agent pagination page/limit is inconsistent");
    }
    if (expectedTotal === undefined) expectedTotal = result.total;
    if (result.total !== expectedTotal) throw new CoreAiAgentAdminError("Core AI Agent pagination total changed");
    if (result.agents.length > client.pageLimit) throw new CoreAiAgentAdminError("Core AI Agent page exceeds limit");
    for (const agent of result.agents) {
      if (!uuid(agent.id) || typeof agent.name !== "string") throw new CoreAiAgentAdminError("Core AI Agent list row is invalid");
      if (ids.has(agent.id)) throw new CoreAiAgentAdminError("Core AI Agent pagination repeated an ID");
      ids.add(agent.id);
      collected.push(agent);
    }
    if (collected.length > expectedTotal) throw new CoreAiAgentAdminError("Core AI Agent pagination exceeds total");
    if (collected.length === expectedTotal) return collected;
    if (result.agents.length === 0) throw new CoreAiAgentAdminError("Core AI Agent pagination ended before total");
  }
  throw new CoreAiAgentAdminError("Core AI Agent pagination exceeded safety limit");
}

function safeUnsupported(view: Record<string, unknown>): boolean {
  const emptyString = (value: unknown) => value === undefined || value === null || value === "";
  const variables = view.variables;
  return emptyString(view.system_prompt_id)
    && emptyString(view.multi_modal_model)
    && (view.prefer_caption_path === undefined || view.prefer_caption_path === null || view.prefer_caption_path === false)
    && emptyString(view.input_template)
    && (variables === undefined || variables === null || (isRecord(variables) && Object.keys(variables).length === 0));
}

function editableSnapshot(view: CoreAiAgentView, requireSafeUnsupported: boolean): {
  managed: AgentManifest;
  editableHash: string;
  fieldHashes: Record<string, string>;
  executableFieldHashes: Record<string, string>;
  unmanagedExecutableEmpty: boolean;
  unknownFieldsEmpty: true;
} {
  const known = new Set<string>([...MUTATION_FIELDS, ...UNSUPPORTED_EXECUTABLE_FIELDS, ...REMOTE_METADATA_FIELDS]);
  const unknown = Object.keys(view).filter((key) => !known.has(key));
  if (unknown.length > 0) throw new CoreAiAgentAdminError("Agent has unknown unmanaged fields");
  const unmanagedExecutableEmpty = safeUnsupported(view);
  if (requireSafeUnsupported && !unmanagedExecutableEmpty) {
    throw new CoreAiAgentAdminError("Agent has unmanaged executable settings; create a new versioned manifest name");
  }
  const managed = normalizeRemoteManaged(view);
  const unsupported = Object.fromEntries(UNSUPPORTED_EXECUTABLE_FIELDS.map((field) => [field, view[field] ?? null]));
  const fieldHashes = Object.fromEntries(MUTATION_FIELDS.map((field) => [field, sha256(managed[field])])) as Record<string, string>;
  const executableFieldHashes = Object.fromEntries(
    UNSUPPORTED_EXECUTABLE_FIELDS.map((field) => [field, sha256(view[field] ?? null)]),
  ) as Record<string, string>;
  return {
    managed,
    editableHash: sha256({ managed, unsupported, system_default: view.system_default ?? null }),
    fieldHashes,
    executableFieldHashes,
    unmanagedExecutableEmpty,
    unknownFieldsEmpty: true,
  };
}

function readOnlyReferenceSnapshot(view: CoreAiAgentView): {
  managed: ReferenceManagedSnapshot;
  editableHash: string;
  fieldHashes: Record<string, string>;
  executableFieldHashes: Record<string, string>;
  unmanagedExecutableEmpty: boolean;
  unknownFieldsEmpty: true;
} {
  const known = new Set<string>([...MUTATION_FIELDS, ...UNSUPPORTED_EXECUTABLE_FIELDS, ...REMOTE_METADATA_FIELDS]);
  if (Object.keys(view).some((key) => !known.has(key))) {
    throw new CoreAiAgentAdminError("Reference Agent has unknown unmanaged fields");
  }
  const managed = referenceManagedSnapshot(view);
  const systemPromptId = referenceString(view.system_prompt_id, "system_prompt_id", true);
  const multiModalModel = referenceString(view.multi_modal_model, "multi_modal_model", true);
  const inputTemplate = referenceString(view.input_template, "input_template", true);
  if (view.prefer_caption_path !== null && view.prefer_caption_path !== undefined
    && typeof view.prefer_caption_path !== "boolean") {
    throw new CoreAiAgentAdminError("Reference Agent prefer_caption_path type is invalid");
  }
  if (view.variables !== null && view.variables !== undefined && !isRecord(view.variables)) {
    throw new CoreAiAgentAdminError("Reference Agent variables type is invalid");
  }
  if (view.system_default !== null && view.system_default !== undefined
    && typeof view.system_default !== "boolean") {
    throw new CoreAiAgentAdminError("Reference Agent system_default type is invalid");
  }
  const unsupported = {
    system_prompt_id: systemPromptId,
    multi_modal_model: multiModalModel,
    prefer_caption_path: view.prefer_caption_path === null || view.prefer_caption_path === undefined
      ? null : view.prefer_caption_path,
    input_template: inputTemplate,
    variables: view.variables === null || view.variables === undefined ? null : { ...view.variables },
  };
  const unmanagedExecutableEmpty = safeUnsupported(unsupported);
  const fieldHashes = Object.fromEntries(
    MUTATION_FIELDS.map((field) => [field, sha256(managed[field])]),
  ) as Record<string, string>;
  const executableFieldHashes = Object.fromEntries(
    UNSUPPORTED_EXECUTABLE_FIELDS.map((field) => [field, sha256(unsupported[field])]),
  ) as Record<string, string>;
  return {
    managed,
    editableHash: sha256({
      managed,
      unsupported,
      system_default: view.system_default === undefined ? null : view.system_default,
    }),
    fieldHashes,
    executableFieldHashes,
    unmanagedExecutableEmpty,
    unknownFieldsEmpty: true,
  };
}

async function discoverReference(client: CoreAiAgentAdminClient): Promise<ReferenceCoordinate> {
  const listed = await collectAllAgents(client, { query: FIXED_REFERENCE_AGENT_NAME });
  const exact = listed.filter((agent) => agent.name === FIXED_REFERENCE_AGENT_NAME);
  if (exact.length !== 1) throw new CoreAiAgentAdminError(`Reference discovery requires exactly one exact-name Agent; found ${exact.length}`);
  const summary = exact[0]!;
  const detail = await client.getAgent(summary.id);
  if (detail.id !== summary.id || detail.name !== FIXED_REFERENCE_AGENT_NAME) {
    throw new CoreAiAgentAdminError("Reference detail does not match fixed exact discovery");
  }
  const snapshot = readOnlyReferenceSnapshot(detail);
  const status = referenceString(detail.status, "status", true);
  const ownerId = referenceString(detail.owner_id, "owner_id", true);
  const updatedAt = referenceString(detail.updated_at, "updated_at", true);
  const publishedAt = referenceString(detail.published_at, "published_at", true);
  const coordinateBase: Omit<ReferenceCoordinate, "coordinate_hash"> = {
    id: detail.id,
    name: FIXED_REFERENCE_AGENT_NAME,
    status,
    owner_id: ownerId === "" ? null : ownerId,
    updated_at: updatedAt,
    published_at: publishedAt,
    editable_hash: snapshot.editableHash,
    managed_hash: sha256(snapshot.managed),
    field_hashes: snapshot.fieldHashes,
    executable_field_hashes: snapshot.executableFieldHashes,
    unmanaged_executable_empty: snapshot.unmanagedExecutableEmpty,
    unknown_fields_empty: snapshot.unknownFieldsEmpty,
    label: EDITABLE_REFERENCE_ONLY,
    evidence_scope: EDITABLE_CONFIG_AND_STATUS_ONLY,
  };
  return {
    ...coordinateBase,
    coordinate_hash: sha256(coordinateBase),
  };
}

function assertOwnedExactNonSystem(input: {
  detail: CoreAiAgentView;
  expectedId: string;
  expectedName: string;
  globalExact: CoreAiAgentView[];
  myExact: CoreAiAgentView[];
}): void {
  if (input.globalExact.length !== 1 || input.globalExact[0]!.id !== input.expectedId
    || input.myExact.length !== 1 || input.myExact[0]!.id !== input.expectedId
    || input.detail.id !== input.expectedId || input.detail.name !== input.expectedName
    || (input.detail.system_default !== false && input.detail.system_default !== null)) {
    throw new CoreAiAgentAdminError("Agent ownership/system/name proof is ambiguous");
  }
}

async function classifyDesired(
  client: CoreAiAgentAdminClient,
  prepared: PreparedManifest,
): Promise<RemoteClassification> {
  const global = await collectAllAgents(client, { query: prepared.manifest.name });
  const exact = global.filter((agent) => agent.name === prepared.manifest.name);
  if (exact.length > 1) throw new CoreAiAgentAdminError(`Desired Agent exact-name collision: ${prepared.manifest.name}`);
  if (exact.length === 0) {
    const remoteStateHash = sha256({ state: "ABSENT", name: prepared.manifest.name });
    return {
      action: "CREATE", remote_agent_id: null, remote_state_hash: remoteStateHash,
      action_hash: sha256({ action: "CREATE", manifest_hash: prepared.manifestHash, remote_state_hash: remoteStateHash }),
    };
  }
  const selected = exact[0]!;
  const mine = await collectAllAgents(client, {
    query: prepared.manifest.name,
    my: true,
    includeSystemDefault: false,
  });
  const myExact = mine.filter((agent) => agent.name === prepared.manifest.name);
  if (myExact.length !== 1 || myExact[0]!.id !== selected.id) {
    throw new CoreAiAgentAdminError(`Desired Agent exact-name collision is not proven owned: ${prepared.manifest.name}`);
  }
  const detail = await client.getAgent(selected.id);
  assertOwnedExactNonSystem({
    detail, expectedId: selected.id, expectedName: prepared.manifest.name,
    globalExact: exact, myExact,
  });
  if (detail.status !== "PUBLISHED") {
    throw new CoreAiAgentAdminError("Existing Agent is not PUBLISHED; CREATE-ONLY requires a new versioned manifest name");
  }
  const snapshot = editableSnapshot(detail, true);
  if (sha256(snapshot.managed) !== prepared.manifestHash) {
    throw new CoreAiAgentAdminError(`Existing Agent drift is CREATE-ONLY; use a new versioned manifest name: ${prepared.manifest.name}`);
  }
  const remoteStateHash = sha256({
    state: "EXISTING", id: detail.id, status: detail.status,
    published_at: typeof detail.published_at === "string" ? detail.published_at : null,
    system_default: detail.system_default ?? null,
    editable_hash: snapshot.editableHash, owned: true,
  });
  return {
    action: "NO_CHANGE", remote_agent_id: detail.id, remote_state_hash: remoteStateHash,
    action_hash: sha256({ action: "NO_CHANGE", manifest_hash: prepared.manifestHash, remote_state_hash: remoteStateHash }),
  };
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function roots(repositoryRoot: string, manifestRoot: string): Promise<{ repository: string; manifests: string }> {
  const repository = await realpath(repositoryRoot);
  const manifests = await realpath(manifestRoot);
  if (!pathInside(repository, manifests)) throw new CoreAiAgentAdminError("Manifest root must be inside repository");
  return { repository, manifests };
}

async function selectedPaths(
  repositoryRoot: string,
  manifestRoot: string,
  selection: { kind: "ALL" } | { kind: "EXPLICIT"; paths: string[] },
): Promise<string[]> {
  const checked = await roots(repositoryRoot, manifestRoot);
  let candidates: string[];
  if (selection.kind === "ALL") {
    const entries = await readdir(checked.manifests, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() && entry.name.endsWith(".json")) throw new CoreAiAgentAdminError("Manifest symlink is forbidden");
    }
    candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.schema.json")
      .map((entry) => resolve(checked.manifests, entry.name))
      .sort();
  } else {
    if (selection.paths.length === 0) throw new CoreAiAgentAdminError("Explicit manifest selection is empty");
    candidates = selection.paths.map((path) => isAbsolute(path) ? resolve(path) : resolve(checked.repository, path));
  }
  if (new Set(candidates).size !== candidates.length) throw new CoreAiAgentAdminError("Duplicate manifest path selected");
  const normalizedCandidates: string[] = [];
  const fileIdentities = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.endsWith(".json") || basename(candidate) === "manifest.schema.json") {
      throw new CoreAiAgentAdminError("Unknown manifest path selected");
    }
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw new CoreAiAgentAdminError("Manifest symlink is forbidden");
    if (!stat.isFile()) throw new CoreAiAgentAdminError("Manifest path must be a file");
    if (stat.nlink !== 1) throw new CoreAiAgentAdminError("Manifest hardlink alias is forbidden");
    const actual = await realpath(candidate);
    if (!pathInside(checked.manifests, actual)) throw new CoreAiAgentAdminError("Manifest path must remain in manifest root");
    const identity = `${stat.dev}:${stat.ino}`;
    if (fileIdentities.has(identity)) throw new CoreAiAgentAdminError("Selected manifests share a hardlink inode identity");
    fileIdentities.add(identity);
    normalizedCandidates.push(actual);
  }
  if (new Set(normalizedCandidates).size !== normalizedCandidates.length) throw new CoreAiAgentAdminError("Duplicate manifest path selected");
  return normalizedCandidates;
}

async function prepareManifests(
  repositoryRoot: string,
  manifestRoot: string,
  selection: { kind: "ALL" } | { kind: "EXPLICIT"; paths: string[] },
): Promise<PreparedManifest[]> {
  const checked = await roots(repositoryRoot, manifestRoot);
  const paths = await selectedPaths(repositoryRoot, manifestRoot, selection);
  if (paths.length === 0) throw new CoreAiAgentAdminError("Manifest selection is empty");
  const prepared: PreparedManifest[] = [];
  const names = new Set<string>();
  for (const absolutePath of paths) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(absolutePath, "utf8")) as unknown; }
    catch { throw new CoreAiAgentAdminError(`Manifest JSON is invalid: ${relative(checked.repository, absolutePath)}`); }
    const normalized = normalizeManifest(raw);
    if (names.has(normalized.name)) throw new CoreAiAgentAdminError(`Duplicate desired Agent name: ${normalized.name}`);
    names.add(normalized.name);
    const stat = await lstat(absolutePath);
    prepared.push({
      path: relative(checked.repository, absolutePath), absolutePath,
      fileIdentity: `${stat.dev}:${stat.ino}`,
      manifest: normalized, manifestHash: sha256(normalized),
    });
  }
  return prepared;
}

type ArtifactKind = "plan" | "journal";

interface ArtifactTarget {
  path: string;
  parent: string;
  existed: boolean;
  fileIdentity: string | null;
}

function noFollowFlag(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
    throw new CoreAiAgentAdminError("O_NOFOLLOW is unavailable; refusing artifact access");
  }
  return constants.O_NOFOLLOW;
}

async function assertDirectoryHasNoSymlinkComponents(repository: string, relativeDirectory: string): Promise<void> {
  let current = repository;
  for (const component of relativeDirectory.split("/")) {
    current = resolve(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new CoreAiAgentAdminError("Fixed artifact directory contains a symlink or non-directory component");
    }
  }
}

async function checkedArtifactTarget(input: {
  repositoryRoot: string;
  manifestRoot: string;
  targetPath: string;
  kind: ArtifactKind;
  require: "EXISTING" | "NEW";
}): Promise<ArtifactTarget> {
  if (!isAbsolute(input.targetPath)) throw new CoreAiAgentAdminError(`${input.kind} artifact path must be absolute`);
  const { repository, manifests } = await roots(input.repositoryRoot, input.manifestRoot);
  const relativeDirectory = input.kind === "plan" ? PLAN_DIRECTORY : JOURNAL_DIRECTORY;
  const otherRelativeDirectory = input.kind === "plan" ? JOURNAL_DIRECTORY : PLAN_DIRECTORY;
  await assertDirectoryHasNoSymlinkComponents(repository, relativeDirectory);
  await assertDirectoryHasNoSymlinkComponents(repository, otherRelativeDirectory);
  const artifactDirectory = await realpath(resolve(repository, relativeDirectory));
  const otherDirectory = await realpath(resolve(repository, otherRelativeDirectory));
  if (!pathInside(repository, artifactDirectory) || artifactDirectory === otherDirectory
    || pathInside(manifests, artifactDirectory) || pathInside(artifactDirectory, manifests)) {
    throw new CoreAiAgentAdminError("Artifact directories must be fixed, distinct, and outside the manifest root");
  }
  const parent = await realpath(dirname(input.targetPath));
  const targetPath = resolve(parent, basename(input.targetPath));
  if (parent !== artifactDirectory || dirname(targetPath) !== artifactDirectory) {
    throw new CoreAiAgentAdminError(`${input.kind} artifact path must remain in its fixed artifact directory`);
  }
  if (input.kind === "plan" ? !targetPath.endsWith(".json") : !targetPath.endsWith(".jsonl")) {
    throw new CoreAiAgentAdminError(`${input.kind} artifact extension is invalid`);
  }
  let existed = false;
  let fileIdentity: string | null = null;
  try {
    const stat = await lstat(targetPath);
    if (stat.isSymbolicLink()) throw new CoreAiAgentAdminError(`${input.kind} artifact symlink is forbidden`);
    if (!stat.isFile()) throw new CoreAiAgentAdminError(`${input.kind} artifact must be a regular file`);
    if (stat.nlink !== 1) throw new CoreAiAgentAdminError(`${input.kind} artifact hardlink alias is forbidden`);
    if (await realpath(targetPath) !== targetPath) throw new CoreAiAgentAdminError(`${input.kind} artifact canonical path mismatch`);
    existed = true;
    fileIdentity = `${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (error instanceof CoreAiAgentAdminError) throw error;
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  if (input.require === "NEW" && existed) throw new CoreAiAgentAdminError(`${input.kind} artifact must not already exist`);
  if (input.require === "EXISTING" && !existed) throw new CoreAiAgentAdminError(`${input.kind} artifact does not exist`);
  return { path: targetPath, parent, existed, fileIdentity };
}

async function verifyOpenedIdentity(handle: FileHandle, target: ArtifactTarget): Promise<string> {
  const descriptorStat = await handle.stat();
  const pathStat = await lstat(target.path);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()
    || pathStat.nlink !== 1 || descriptorStat.nlink !== 1
    || descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino
    || await realpath(target.path) !== target.path) {
    throw new CoreAiAgentAdminError("Artifact inode/canonical identity changed");
  }
  const identity = `${pathStat.dev}:${pathStat.ino}`;
  if (target.fileIdentity !== null && target.fileIdentity !== identity) {
    throw new CoreAiAgentAdminError("Artifact inode identity changed");
  }
  return identity;
}

function assertArtifactManifestIsolation(target: ArtifactTarget, prepared: PreparedManifest[]): void {
  if (prepared.some((manifest) => manifest.absolutePath === target.path
    || (target.fileIdentity !== null && manifest.fileIdentity === target.fileIdentity))) {
    throw new CoreAiAgentAdminError("Artifact and manifest path/inode identities must be distinct");
  }
}

async function syncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writePlan(target: ArtifactTarget, plan: ReconciliationPlan): Promise<void> {
  const handle = await open(target.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(), 0o600);
  try {
    await verifyOpenedIdentity(handle, target);
    await handle.writeFile(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
    await handle.sync();
    await verifyOpenedIdentity(handle, { ...target, fileIdentity: null });
  } finally { await handle.close(); }
  await syncDirectory(target.parent);
}

function planDigest(plan: Omit<ReconciliationPlan, "digest">): string {
  return sha256(plan);
}

export async function dryRunAgentReconciliation(input: {
  client: CoreAiAgentAdminClient;
  repositoryRoot: string;
  manifestRoot: string;
  selection: { kind: "ALL" } | { kind: "EXPLICIT"; paths: string[] };
  planPath: string;
}): Promise<ReconciliationPlan> {
  const planTarget = await checkedArtifactTarget({
    repositoryRoot: input.repositoryRoot, manifestRoot: input.manifestRoot,
    targetPath: input.planPath, kind: "plan", require: "NEW",
  });
  const prepared = await prepareManifests(input.repositoryRoot, input.manifestRoot, input.selection);
  assertArtifactManifestIsolation(planTarget, prepared);
  const reference = await discoverReference(input.client);
  const selected: PlanEntry[] = [];
  for (const manifest of prepared) {
    const classification = await classifyDesired(input.client, manifest);
    selected.push({
      path: manifest.path, name: manifest.manifest.name, manifest_hash: manifest.manifestHash,
      ...classification,
    });
  }
  const withoutDigest = {
    schema_version: PLAN_VERSION as typeof PLAN_VERSION,
    created_at: new Date().toISOString(),
    scope: { kind: input.selection.kind } as { kind: "ALL" } | { kind: "EXPLICIT" },
    selected,
    reference,
  };
  const plan: ReconciliationPlan = { ...withoutDigest, digest: planDigest(withoutDigest) };
  await writePlan(planTarget, plan);
  return plan;
}

function parsePlan(value: unknown): ReconciliationPlan {
  if (!isRecord(value)) throw new CoreAiAgentAdminError("Reviewed plan is invalid");
  const exactKeys = (record: Record<string, unknown>, expected: string[]) => {
    const actual = Object.keys(record).sort();
    return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
  };
  const hash = (input: unknown) => typeof input === "string" && /^[0-9a-f]{64}$/.test(input);
  if (!isRecord(value.reference)) throw new CoreAiAgentAdminError("Reviewed plan requires a reference coordinate");
  if (!exactKeys(value, ["schema_version", "created_at", "scope", "selected", "reference", "digest"])) {
    throw new CoreAiAgentAdminError("Reviewed plan shape is invalid");
  }
  if (!exactKeys(value.reference, [
      "id", "name", "status", "owner_id", "updated_at", "published_at", "editable_hash", "managed_hash",
      "field_hashes", "executable_field_hashes", "unmanaged_executable_empty", "unknown_fields_empty",
      "label", "evidence_scope", "coordinate_hash",
    ])
    || !uuid(value.reference.id) || value.reference.name !== FIXED_REFERENCE_AGENT_NAME
    || !(value.reference.status === null || typeof value.reference.status === "string")
    || !(value.reference.owner_id === null || typeof value.reference.owner_id === "string")
    || !(value.reference.updated_at === null || typeof value.reference.updated_at === "string")
    || !(value.reference.published_at === null || typeof value.reference.published_at === "string")
    || !hash(value.reference.editable_hash) || !hash(value.reference.managed_hash) || !hash(value.reference.coordinate_hash)
    || !isRecord(value.reference.field_hashes)
    || !exactKeys(value.reference.field_hashes, [...MUTATION_FIELDS])
    || Object.values(value.reference.field_hashes).some((fieldHash) => !hash(fieldHash))
    || !isRecord(value.reference.executable_field_hashes)
    || !exactKeys(value.reference.executable_field_hashes, [...UNSUPPORTED_EXECUTABLE_FIELDS])
    || Object.values(value.reference.executable_field_hashes).some((fieldHash) => !hash(fieldHash))
    || typeof value.reference.unmanaged_executable_empty !== "boolean"
    || value.reference.unknown_fields_empty !== true
    || value.reference.label !== EDITABLE_REFERENCE_ONLY
    || value.reference.evidence_scope !== EDITABLE_CONFIG_AND_STATUS_ONLY) {
    throw new CoreAiAgentAdminError("Reviewed plan requires a reference coordinate");
  }
  const { coordinate_hash: coordinateHash, ...referenceRecord } = value.reference;
  if (coordinateHash !== sha256(referenceRecord)) {
    throw new CoreAiAgentAdminError("Reviewed plan reference coordinate hash mismatch");
  }
  if (value.schema_version !== PLAN_VERSION || typeof value.created_at !== "string"
    || !isRecord(value.scope) || !exactKeys(value.scope, ["kind"])
    || (value.scope.kind !== "ALL" && value.scope.kind !== "EXPLICIT")
    || !Array.isArray(value.selected) || !hash(value.digest)) {
    throw new CoreAiAgentAdminError("Reviewed plan shape is invalid");
  }
  const plan = value as unknown as ReconciliationPlan;
  for (const entry of plan.selected) {
    if (!isRecord(entry)
      || !exactKeys(entry, [
        "path", "name", "manifest_hash", "action", "remote_agent_id", "remote_state_hash", "action_hash",
      ])
      || typeof entry.path !== "string" || typeof entry.name !== "string"
      || !hash(entry.manifest_hash) || (entry.action !== "CREATE" && entry.action !== "NO_CHANGE")
      || !(entry.remote_agent_id === null || uuid(entry.remote_agent_id))
      || !hash(entry.remote_state_hash) || !hash(entry.action_hash)) {
      throw new CoreAiAgentAdminError("Reviewed plan entry is invalid");
    }
  }
  const { digest, ...withoutDigest } = plan;
  if (digest !== planDigest(withoutDigest)) throw new CoreAiAgentAdminError("Reviewed plan digest mismatch");
  return plan;
}

async function readPlan(
  repositoryRoot: string,
  manifestRoot: string,
  planPath: string,
): Promise<{ plan: ReconciliationPlan; target: ArtifactTarget }> {
  const target = await checkedArtifactTarget({
    repositoryRoot, manifestRoot, targetPath: planPath, kind: "plan", require: "EXISTING",
  });
  const handle = await open(target.path, constants.O_RDONLY | noFollowFlag());
  let value: unknown;
  try {
    await verifyOpenedIdentity(handle, target);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1_048_576) throw new CoreAiAgentAdminError("Reviewed plan file is invalid");
    value = JSON.parse(await handle.readFile("utf8")) as unknown;
    await verifyOpenedIdentity(handle, target);
  } catch (error) {
    if (error instanceof CoreAiAgentAdminError) throw error;
    throw new CoreAiAgentAdminError("Reviewed plan JSON is invalid");
  } finally { await handle.close(); }
  return { plan: parsePlan(value), target };
}

type JournalEvent =
  | { type: "JOURNAL_OPENED"; plan_digest: string; reference_id: string; selected_paths_hash: string }
  | { type: "NO_CHANGE_OUTCOME"; sequence: number; manifest_path: string; name: string; agent_id: string }
  | { type: "CREATE_INTENT"; sequence: number; manifest_path: string; name: string; manifest_hash: string }
  | { type: "CREATE_OUTCOME"; sequence: number; manifest_path: string; name: string; agent_id: string }
  | { type: "CREATE_REJECTED"; sequence: number; manifest_path: string; name: string; agent_id: string; reason_code: "REFERENCE_UUID" }
  | { type: "CREATE_FAILED"; sequence: number; manifest_path: string; name: string; status: number; endpoint_path: string | null }
  | { type: "PREPUBLISH_VALIDATION_INTENT"; sequence: number; manifest_path: string; name: string; agent_id: string }
  | { type: "PREPUBLISH_VALIDATION_OUTCOME"; sequence: number; manifest_path: string; name: string; agent_id: string; status: "DRAFT"; editable_hash: string }
  | { type: "PREPUBLISH_VALIDATION_FAILED"; sequence: number; manifest_path: string; name: string; agent_id: string; reason_code: "NOT_NEW_OWNED_EXACT_DRAFT" }
  | { type: "PUBLISH_INTENT"; sequence: number; manifest_path: string; name: string; agent_id: string }
  | { type: "PUBLISH_OUTCOME"; sequence: number; manifest_path: string; name: string; agent_id: string }
  | { type: "PUBLISH_FAILED"; sequence: number; manifest_path: string; name: string; agent_id: string; status: number; endpoint_path: string | null }
  | { type: "READBACK_OUTCOME"; sequence: number; manifest_path: string; name: string; agent_id: string; status: "PUBLISHED"; editable_hash: string; evidence_scope: typeof EDITABLE_CONFIG_AND_STATUS_ONLY }
  | { type: "READBACK_FAILED"; sequence: number; manifest_path: string; name: string; agent_id: string; reason_code: "MISMATCH_OR_UNMANAGED_EXECUTABLE" };

class EvidenceJournal {
  constructor(
    private readonly handle: FileHandle,
    private readonly target: ArtifactTarget,
  ) {}
  async append(event: JournalEvent): Promise<void> {
    await verifyOpenedIdentity(this.handle, this.target);
    const record = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    let offset = 0;
    while (offset < record.byteLength) {
      const remaining = record.byteLength - offset;
      const result = await this.handle.write(record, offset, remaining, null);
      if (!Number.isSafeInteger(result.bytesWritten)
        || result.bytesWritten <= 0
        || result.bytesWritten > remaining) {
        throw new CoreAiAgentAdminError("Evidence journal write did not make safe forward progress");
      }
      offset += result.bytesWritten;
    }
    await this.handle.sync();
    await verifyOpenedIdentity(this.handle, this.target);
  }
  async close(): Promise<void> { await this.handle.close(); }
}

async function openJournal(input: {
  repositoryRoot: string;
  manifestRoot: string;
  evidencePath: string;
  planTarget: ArtifactTarget;
  prepared: PreparedManifest[];
  plan: ReconciliationPlan;
}): Promise<EvidenceJournal> {
  const target = await checkedArtifactTarget({
    repositoryRoot: input.repositoryRoot, manifestRoot: input.manifestRoot,
    targetPath: input.evidencePath, kind: "journal", require: "NEW",
  });
  if (target.path === input.planTarget.path || target.parent === input.planTarget.parent) {
    throw new CoreAiAgentAdminError("Plan and journal artifacts must be isolated");
  }
  assertArtifactManifestIsolation(target, input.prepared);
  const handle = await open(
    target.path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
    0o600,
  );
  try {
    const fileIdentity = await verifyOpenedIdentity(handle, target);
    const durableTarget = { ...target, fileIdentity };
    const journal = new EvidenceJournal(handle, durableTarget);
    await journal.append({
      type: "JOURNAL_OPENED",
      plan_digest: input.plan.digest,
      reference_id: input.plan.reference.id,
      selected_paths_hash: sha256(input.plan.selected.map((entry) => entry.path)),
    });
    await syncDirectory(target.parent);
    return journal;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function errorCoordinate(error: unknown): { status: number; endpoint_path: string | null } {
  return error instanceof CoreAiAgentAdminError
    ? { status: error.status, endpoint_path: error.endpointPath ?? null }
    : { status: 0, endpoint_path: null };
}

function sameClassification(planned: PlanEntry, current: RemoteClassification): boolean {
  return planned.action === current.action
    && planned.remote_agent_id === current.remote_agent_id
    && planned.remote_state_hash === current.remote_state_hash
    && planned.action_hash === current.action_hash;
}

async function validateCreatedDraft(input: {
  client: CoreAiAgentAdminClient;
  createdId: string;
  prepared: PreparedManifest;
  preexistingPrincipalIds: ReadonlySet<string>;
}): Promise<{ editableHash: string }> {
  if (input.preexistingPrincipalIds.has(input.createdId)) {
    throw new CoreAiAgentAdminError("Create response reused an existing principal Agent ID");
  }
  const detail = await input.client.getAgent(input.createdId);
  const global = await collectAllAgents(input.client, { query: input.prepared.manifest.name });
  const globalExact = global.filter((agent) => agent.name === input.prepared.manifest.name);
  const mine = await collectAllAgents(input.client, {
    query: "",
    my: true,
    includeSystemDefault: false,
  });
  const myExact = mine.filter((agent) => agent.id === input.createdId && agent.name === input.prepared.manifest.name);
  try {
    assertOwnedExactNonSystem({
      detail, expectedId: input.createdId, expectedName: input.prepared.manifest.name,
      globalExact, myExact,
    });
  } catch {
    throw new CoreAiAgentAdminError("Created Agent is not a new owned exact DRAFT");
  }
  if (detail.status !== "DRAFT") throw new CoreAiAgentAdminError("Created Agent is not a new owned exact DRAFT");
  const snapshot = editableSnapshot(detail, true);
  if (sha256(snapshot.managed) !== input.prepared.manifestHash) {
    throw new CoreAiAgentAdminError("Created Agent DRAFT editable configuration mismatch");
  }
  return { editableHash: snapshot.editableHash };
}

export async function applyAgentReconciliationPlan(input: {
  client: CoreAiAgentAdminClient;
  repositoryRoot: string;
  manifestRoot: string;
  planPath: string;
  evidencePath: string;
}): Promise<Array<{
  action: "CREATE" | "NO_CHANGE";
  name: string;
  agent_id: string;
  evidence_scope: typeof EDITABLE_CONFIG_AND_STATUS_ONLY;
  remote_rollback?: typeof NO_DELETE_REMOTE_ROLLBACK;
}>> {
  const { plan, target: planTarget } = await readPlan(input.repositoryRoot, input.manifestRoot, input.planPath);
  const selection = plan.scope.kind === "ALL"
    ? { kind: "ALL" as const }
    : { kind: "EXPLICIT" as const, paths: plan.selected.map((entry) => entry.path) };
  const prepared = await prepareManifests(input.repositoryRoot, input.manifestRoot, selection);
  assertArtifactManifestIsolation(planTarget, prepared);
  if (prepared.length !== plan.selected.length) throw new CoreAiAgentAdminError("Reviewed plan scope drift");
  for (let index = 0; index < prepared.length; index += 1) {
    const local = prepared[index]!;
    const planned = plan.selected[index]!;
    if (local.path !== planned.path || local.manifest.name !== planned.name || local.manifestHash !== planned.manifest_hash) {
      throw new CoreAiAgentAdminError("Reviewed plan manifest drift");
    }
  }

  const journal = await openJournal({
    repositoryRoot: input.repositoryRoot,
    manifestRoot: input.manifestRoot,
    evidencePath: input.evidencePath,
    planTarget,
    prepared,
    plan,
  });
  try {
    const reference = await discoverReference(input.client);
    if (canonical(reference) !== canonical(plan.reference)) {
      throw new CoreAiAgentAdminError("Reviewed plan reference drift");
    }
    const current: RemoteClassification[] = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const classification = await classifyDesired(input.client, prepared[index]!);
      if (!sameClassification(plan.selected[index]!, classification)) {
        throw new CoreAiAgentAdminError("Reviewed plan remote pre-state drift");
      }
      current.push(classification);
    }
    const principalRoster = await collectAllAgents(input.client, {
      query: "",
      my: true,
      includeSystemDefault: false,
    });
    const preexistingPrincipalIds = new Set(principalRoster.map((agent) => agent.id));

    const results: Array<{
      action: "CREATE" | "NO_CHANGE";
      name: string;
      agent_id: string;
      evidence_scope: typeof EDITABLE_CONFIG_AND_STATUS_ONLY;
      remote_rollback?: typeof NO_DELETE_REMOTE_ROLLBACK;
    }> = [];
    for (let index = 0; index < prepared.length; index += 1) {
      const sequence = index + 1;
      const local = prepared[index]!;
      const classification = current[index]!;
      if (classification.action === "NO_CHANGE") {
        const id = classification.remote_agent_id!;
        await journal.append({ type: "NO_CHANGE_OUTCOME", sequence, manifest_path: local.path, name: local.manifest.name, agent_id: id });
        results.push({ action: "NO_CHANGE", name: local.manifest.name, agent_id: id, evidence_scope: EDITABLE_CONFIG_AND_STATUS_ONLY });
        continue;
      }

      await journal.append({
        type: "CREATE_INTENT", sequence, manifest_path: local.path,
        name: local.manifest.name, manifest_hash: local.manifestHash,
      });
      let created: { id: string };
      try {
        created = await input.client.createAgent(local.manifest);
      } catch (error) {
        await journal.append({ type: "CREATE_FAILED", sequence, manifest_path: local.path, name: local.manifest.name, ...errorCoordinate(error) });
        throw error;
      }
      await journal.append({ type: "CREATE_OUTCOME", sequence, manifest_path: local.path, name: local.manifest.name, agent_id: created.id });
      if (created.id === plan.reference.id) {
        await journal.append({
          type: "CREATE_REJECTED", sequence, manifest_path: local.path, name: local.manifest.name,
          agent_id: created.id, reason_code: "REFERENCE_UUID",
        });
        throw new CoreAiAgentAdminError("Create response reused the mandatory reference Agent UUID");
      }

      await journal.append({
        type: "PREPUBLISH_VALIDATION_INTENT", sequence, manifest_path: local.path,
        name: local.manifest.name, agent_id: created.id,
      });
      try {
        const validated = await validateCreatedDraft({
          client: input.client,
          createdId: created.id,
          prepared: local,
          preexistingPrincipalIds,
        });
        await journal.append({
          type: "PREPUBLISH_VALIDATION_OUTCOME", sequence, manifest_path: local.path,
          name: local.manifest.name, agent_id: created.id, status: "DRAFT", editable_hash: validated.editableHash,
        });
        preexistingPrincipalIds.add(created.id);
      } catch {
        await journal.append({
          type: "PREPUBLISH_VALIDATION_FAILED", sequence, manifest_path: local.path,
          name: local.manifest.name, agent_id: created.id, reason_code: "NOT_NEW_OWNED_EXACT_DRAFT",
        });
        throw new CoreAiAgentAdminError("Created Agent pre-publish validation failed closed");
      }

      await journal.append({ type: "PUBLISH_INTENT", sequence, manifest_path: local.path, name: local.manifest.name, agent_id: created.id });
      try {
        await input.client.publishAgent(created.id);
      } catch (error) {
        await journal.append({ type: "PUBLISH_FAILED", sequence, manifest_path: local.path, name: local.manifest.name, agent_id: created.id, ...errorCoordinate(error) });
        throw error;
      }
      await journal.append({ type: "PUBLISH_OUTCOME", sequence, manifest_path: local.path, name: local.manifest.name, agent_id: created.id });

      try {
        const readback = await input.client.getAgent(created.id);
        const global = await collectAllAgents(input.client, { query: local.manifest.name });
        const globalExact = global.filter((agent) => agent.name === local.manifest.name);
        const mine = await collectAllAgents(input.client, {
          query: "",
          my: true,
          includeSystemDefault: false,
        });
        const myExact = mine.filter((agent) => agent.id === created.id && agent.name === local.manifest.name);
        assertOwnedExactNonSystem({
          detail: readback, expectedId: created.id, expectedName: local.manifest.name,
          globalExact, myExact,
        });
        if (readback.status !== "PUBLISHED") throw new CoreAiAgentAdminError("Created Agent readback mismatch");
        const snapshot = editableSnapshot(readback, true);
        if (sha256(snapshot.managed) !== local.manifestHash) throw new CoreAiAgentAdminError("Created Agent readback mismatch");
        await journal.append({
          type: "READBACK_OUTCOME", sequence, manifest_path: local.path, name: local.manifest.name,
          agent_id: created.id, status: "PUBLISHED", editable_hash: snapshot.editableHash,
          evidence_scope: EDITABLE_CONFIG_AND_STATUS_ONLY,
        });
      } catch (error) {
        await journal.append({
          type: "READBACK_FAILED", sequence, manifest_path: local.path, name: local.manifest.name,
          agent_id: created.id, reason_code: "MISMATCH_OR_UNMANAGED_EXECUTABLE",
        });
        const coordinate = errorCoordinate(error);
        throw new CoreAiAgentAdminError("Created Agent readback failed closed", coordinate.status, coordinate.endpoint_path ?? undefined);
      }
      results.push({
        action: "CREATE", name: local.manifest.name, agent_id: created.id,
        evidence_scope: EDITABLE_CONFIG_AND_STATUS_ONLY,
        remote_rollback: NO_DELETE_REMOTE_ROLLBACK,
      });
    }
    return results;
  } finally {
    await journal.close();
  }
}

export type AgentReconciliationArguments =
  | {
      mode: "dry-run";
      planPath: string;
      selection: { kind: "ALL" } | { kind: "EXPLICIT"; paths: string[] };
    }
  | {
      mode: "apply";
      planPath: string;
      evidencePath: string;
    };

export function parseAgentReconciliationArguments(argv: string[]): AgentReconciliationArguments {
  let mode: "dry-run" | "apply" | undefined;
  let planPath: string | undefined;
  let evidencePath: string | undefined;
  let all = false;
  const manifests: string[] = [];
  for (const argument of argv) {
    if (/(?:token|authorization|cookie|secret)/i.test(argument)) {
      throw new CoreAiAgentAdminError("Credentials are accepted only through the environment");
    }
    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) throw new CoreAiAgentAdminError("--mode may be supplied once");
      const value = argument.slice("--mode=".length);
      if (value !== "dry-run" && value !== "apply") throw new CoreAiAgentAdminError("--mode must be dry-run or apply");
      mode = value;
    } else if (argument === "--all") {
      all = true;
    } else if (argument.startsWith("--manifest=")) {
      const path = argument.slice("--manifest=".length);
      if (!path) throw new CoreAiAgentAdminError("--manifest path is empty");
      manifests.push(path);
    } else if (argument.startsWith("--plan=")) {
      if (planPath !== undefined) throw new CoreAiAgentAdminError("--plan may be supplied once");
      planPath = argument.slice("--plan=".length);
    } else if (argument.startsWith("--evidence=")) {
      if (evidencePath !== undefined) throw new CoreAiAgentAdminError("--evidence may be supplied once");
      evidencePath = argument.slice("--evidence=".length);
    } else {
      throw new CoreAiAgentAdminError(`Unknown argument: ${argument.split("=")[0]}`);
    }
  }
  if (mode === undefined) throw new CoreAiAgentAdminError("--mode is required");
  if (!planPath || !isAbsolute(planPath)) throw new CoreAiAgentAdminError("--plan must be an absolute path");
  if (mode === "dry-run") {
    if (evidencePath !== undefined) throw new CoreAiAgentAdminError("Dry-run does not accept --evidence");
    if (all === (manifests.length > 0)) {
      throw new CoreAiAgentAdminError("Dry-run scope requires exactly one of --all or --manifest");
    }
    return {
      mode,
      planPath,
      selection: all ? { kind: "ALL" } : { kind: "EXPLICIT", paths: manifests },
    };
  }
  if (all || manifests.length > 0) throw new CoreAiAgentAdminError("Apply scope comes only from the reviewed plan");
  if (!evidencePath || !isAbsolute(evidencePath)) throw new CoreAiAgentAdminError("Apply requires an absolute --evidence path");
  return { mode, planPath, evidencePath };
}

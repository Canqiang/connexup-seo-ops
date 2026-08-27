import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import type {
  CoreAiAgentAdminClient,
  CoreAiAgentView,
} from "./coreAiAgentAdminClient.js";

const POLICY_PREFIX = "core-ai-agent-policy:v1:sha256:";
const MEDIA_TOOL_ID = "builtin:builtin-media-generation";
const OUTPUT_SCHEMA = "seo_ops.gbp_post_draft.v2";
const CACHE_TTL_MS = 60_000;

export class AgentCapabilityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentCapabilityPolicyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function noItems(value: unknown): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function outputSchemaVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.type !== "object" || !isRecord(parsed.properties)) return null;
    const schemaVersion = parsed.properties.schema_version;
    return isRecord(schemaVersion) && typeof schemaVersion.const === "string"
      ? schemaVersion.const
      : null;
  } catch {
    return null;
  }
}

export function assertGbpContentAgentPolicy(view: CoreAiAgentView): void {
  if (view.status !== "PUBLISHED") {
    throw new AgentCapabilityPolicyError("GBP content Agent must be PUBLISHED");
  }
  if (view.type !== "AGENT") {
    throw new AgentCapabilityPolicyError("GBP content Agent type must be AGENT");
  }
  if (view.enable_memory !== false) {
    throw new AgentCapabilityPolicyError("GBP content Agent memory must be disabled");
  }
  const tools = view.tools;
  if (!Array.isArray(tools) || tools.length !== 1 || !isRecord(tools[0])
    || tools[0].id !== MEDIA_TOOL_ID || tools[0].type !== "BUILTIN"
    || (tools[0].source !== undefined && tools[0].source !== "builtin")) {
    throw new AgentCapabilityPolicyError(
      "GBP content Agent must expose exactly one built-in media-generation tool and no external-write tool",
    );
  }
  if (!noItems(view.skill_ids) || !noItems(view.skills)) {
    throw new AgentCapabilityPolicyError("GBP content Agent skills must be empty");
  }
  if (!noItems(view.subagent_ids) || !noItems(view.sub_agents)) {
    throw new AgentCapabilityPolicyError("GBP content Agent subagents must be empty");
  }
  if (!noItems(view.dataset_config)) {
    throw new AgentCapabilityPolicyError("GBP content Agent dataset configuration must be empty");
  }
  if (view.sandbox_config !== null && view.sandbox_config !== undefined) {
    throw new AgentCapabilityPolicyError("GBP content Agent sandbox must be disabled");
  }
  if (outputSchemaVersion(view.response_schema) !== OUTPUT_SCHEMA) {
    throw new AgentCapabilityPolicyError(`GBP content Agent response schema must be ${OUTPUT_SCHEMA}`);
  }
}

function sanitizedEditableConfig(view: CoreAiAgentView): Record<string, unknown> {
  return {
    id: view.id,
    name: view.name,
    status: view.status,
    description: view.description,
    system_prompt: view.system_prompt,
    model: view.model,
    temperature: view.temperature,
    thinking_effort: view.thinking_effort,
    max_turns: view.max_turns,
    timeout_seconds: view.timeout_seconds,
    enable_memory: view.enable_memory,
    type: view.type,
    tools: view.tools,
    skill_ids: view.skill_ids ?? [],
    subagent_ids: view.subagent_ids ?? [],
    dataset_config: view.dataset_config ?? [],
    sandbox_config: view.sandbox_config ?? null,
    response_schema: view.response_schema,
  };
}

export function gbpContentAgentCoordinate(view: CoreAiAgentView): string {
  assertGbpContentAgentPolicy(view);
  const hash = createHash("sha256").update(canonical(sanitizedEditableConfig(view))).digest("hex");
  return `${POLICY_PREFIX}${hash}`;
}

const verificationCache = new Map<string, { coordinate: string; expiresAt: number }>();

export async function inspectGbpContentAgent(
  client: CoreAiAgentAdminClient,
  agentId: string,
): Promise<{ view: CoreAiAgentView; coordinate: string }> {
  try {
    const view = await client.getAgent(agentId);
    const coordinate = gbpContentAgentCoordinate(view);
    verificationCache.set(agentId, { coordinate, expiresAt: Date.now() + CACHE_TTL_MS });
    return { view, coordinate };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent detail readback failed";
    throw new ApiError(409, `GBP content Agent policy verification failed: ${message}`, "CONTENT_AGENT_POLICY_UNVERIFIED");
  }
}

export async function verifyGbpContentAgentBinding(
  client: CoreAiAgentAdminClient,
  agentId: string,
  publishedRef: string | null,
): Promise<void> {
  if (!publishedRef?.startsWith(POLICY_PREFIX)) {
    throw new ApiError(409, "GBP content Agent binding has no verified policy coordinate", "CONTENT_AGENT_POLICY_UNVERIFIED");
  }
  const cached = verificationCache.get(agentId);
  if (cached && cached.expiresAt > Date.now() && cached.coordinate === publishedRef) return;
  const inspected = await inspectGbpContentAgent(client, agentId);
  if (inspected.coordinate !== publishedRef) {
    verificationCache.delete(agentId);
    throw new ApiError(409, "GBP content Agent configuration changed after binding verification", "CONTENT_AGENT_POLICY_UNVERIFIED");
  }
}

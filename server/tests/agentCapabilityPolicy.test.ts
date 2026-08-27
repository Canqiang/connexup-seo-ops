import { describe, expect, it } from "vitest";
import {
  assertGbpContentAgentPolicy,
  gbpContentAgentCoordinate,
  verifyGbpContentAgentBinding,
} from "../src/services/agentCapabilityPolicy.js";
import type { CoreAiAgentAdminClient, CoreAiAgentView } from "../src/services/coreAiAgentAdminClient.js";

function validAgent(overrides: Partial<CoreAiAgentView> = {}): CoreAiAgentView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "[SEO Ops] GBP Post Content v4",
    status: "PUBLISHED",
    description: "Draft only",
    system_prompt: "Return one draft and never publish.",
    model: "deepseek-v4-pro",
    temperature: 0.1,
    thinking_effort: null,
    max_turns: 10,
    timeout_seconds: 600,
    enable_memory: false,
    type: "AGENT",
    tools: [{ id: "builtin:builtin-media-generation", type: "BUILTIN", source: "builtin" }],
    skill_ids: [],
    skills: [],
    subagent_ids: [],
    sub_agents: [],
    dataset_config: [],
    sandbox_config: null,
    response_schema: JSON.stringify({
      type: "object",
      properties: { schema_version: { const: "seo_ops.gbp_post_draft.v2" } },
    }),
    ...overrides,
  };
}

describe("GBP content Agent capability policy", () => {
  it("accepts the exact published draft-only media Agent", () => {
    expect(() => assertGbpContentAgentPolicy(validAgent())).not.toThrow();
    expect(gbpContentAgentCoordinate(validAgent())).toMatch(
      /^core-ai-agent-policy:v1:sha256:[0-9a-f]{64}$/,
    );
  });

  it("rejects an external-write tool even when image generation is also present", () => {
    expect(() => assertGbpContentAgentPolicy(validAgent({
      tools: [
        { id: "builtin:builtin-media-generation", type: "BUILTIN", source: "builtin" },
        { id: "google-business-create-post", type: "MCP", source: "merchant" },
      ],
    }))).toThrow(/exactly one built-in media-generation tool/);
  });

  it("rejects draft, memory, skill, subagent, dataset, and sandbox capabilities", () => {
    for (const override of [
      { status: "DRAFT" },
      { enable_memory: true },
      { skill_ids: ["seo-local"] },
      { subagent_ids: ["writer"] },
      { dataset_config: [{ id: "merchant-private" }] },
      { sandbox_config: { enabled: true } },
    ]) {
      expect(() => assertGbpContentAgentPolicy(validAgent(override))).toThrow();
    }
  });

  it("rejects a response schema that is not the GBP draft v2 contract", () => {
    expect(() => assertGbpContentAgentPolicy(validAgent({
      response_schema: JSON.stringify({
        type: "object",
        properties: { schema_version: { const: "seo_ops.gbp_post_draft.v1" } },
      }),
    }))).toThrow(/seo_ops\.gbp_post_draft\.v2/);
  });

  it("changes the sanitized coordinate when executable configuration drifts", () => {
    expect(gbpContentAgentCoordinate(validAgent({ system_prompt: "draft prompt v1" })))
      .not.toBe(gbpContentAgentCoordinate(validAgent({ system_prompt: "draft prompt v2" })));
  });

  it("fails closed when the stored verified coordinate is absent or drifted", async () => {
    let reads = 0;
    const client: CoreAiAgentAdminClient = {
      pageLimit: 50,
      async listAgentsPage() { return { agents: [], total: 0, page: 1, limit: 50 }; },
      async getAgent() { reads += 1; return validAgent({ system_prompt: "remote v2" }); },
      async createAgent() { throw new Error("not expected"); },
      async publishAgent() { throw new Error("not expected"); },
    };
    await expect(verifyGbpContentAgentBinding(
      client,
      "11111111-1111-4111-8111-111111111111",
      null,
    )).rejects.toMatchObject({ code: "CONTENT_AGENT_POLICY_UNVERIFIED" });
    expect(reads).toBe(0);

    await expect(verifyGbpContentAgentBinding(
      client,
      "11111111-1111-4111-8111-111111111111",
      gbpContentAgentCoordinate(validAgent({ system_prompt: "bound v1" })),
    )).rejects.toMatchObject({ code: "CONTENT_AGENT_POLICY_UNVERIFIED" });
    expect(reads).toBe(1);
  });
});

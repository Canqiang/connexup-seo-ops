import { afterEach, describe, expect, it } from "vitest";
import type { CoreAiClient } from "../src/services/coreAiClient.js";
import type { CoreAiAgentAdminClient, CoreAiAgentView } from "../src/services/coreAiAgentAdminClient.js";
import { createAuthenticatedTestApp, type AuthenticatedTestApp } from "./helpers/authTest.js";

const coreAi: CoreAiClient = {
  async trigger() { return { run_id: "core-run", status: "RUNNING" }; },
  async getRun(id) { return { id, agent_id: "agent", status: "RUNNING" }; },
  async cancel() { /* no-op */ },
  async downloadArtifact() { throw new Error("not expected"); },
};

function agent(status = "PUBLISHED"): CoreAiAgentView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "[SEO Ops] GBP Post Content v4",
    status,
    description: "Draft only",
    system_prompt: "Never publish.",
    model: "test",
    temperature: 0,
    thinking_effort: null,
    max_turns: 10,
    timeout_seconds: 600,
    enable_memory: false,
    type: "AGENT",
    tools: [{ id: "builtin:builtin-media-generation", type: "BUILTIN", source: "builtin" }],
    skill_ids: [], skills: [], subagent_ids: [], sub_agents: [], dataset_config: [],
    sandbox_config: null,
    response_schema: JSON.stringify({
      type: "object",
      properties: { schema_version: { const: "seo_ops.gbp_post_draft.v2" } },
    }),
  };
}

function admin(view: CoreAiAgentView): CoreAiAgentAdminClient {
  return {
    pageLimit: 50,
    async listAgentsPage() { return { agents: [], total: 0, page: 1, limit: 50 }; },
    async getAgent() { return view; },
    async createAgent() { throw new Error("not expected"); },
    async publishAgent() { throw new Error("not expected"); },
  };
}

describe("GBP content Agent verified binding route", () => {
  let built: AuthenticatedTestApp | undefined;
  afterEach(async () => built?.app.close());

  it("ignores a caller-supplied coordinate and stores independently read-back policy provenance", async () => {
    built = await createAuthenticatedTestApp({
      configOverrides: { coreAiBaseUrl: "https://core-ai.example", coreAiToken: "test-token" },
      deps: { coreAi, coreAiAgentAdmin: admin(agent()) },
    });
    const response = await built.app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/GBP_POST",
      payload: {
        agent_id: "11111111-1111-4111-8111-111111111111",
        agent_label: "Draft-only GBP content",
        published_ref: "caller-forged-coordinate",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().published_ref).toMatch(/^core-ai-agent-policy:v1:sha256:[0-9a-f]{64}$/);
    expect(response.json().published_ref).not.toBe("caller-forged-coordinate");
  });

  it("does not persist a draft or over-capable Agent binding", async () => {
    built = await createAuthenticatedTestApp({
      configOverrides: { coreAiBaseUrl: "https://core-ai.example", coreAiToken: "test-token" },
      deps: { coreAi, coreAiAgentAdmin: admin(agent("DRAFT")) },
    });
    const response = await built.app.inject({
      method: "PUT",
      url: "/api/seo-ops/agent-bindings/GBP_POST",
      payload: { agent_id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error_code: "CONTENT_AGENT_POLICY_UNVERIFIED" });
    expect(await built.db.one(`SELECT task_type FROM seo_agent_bindings WHERE task_type='GBP_POST'`)).toBeNull();
  });
});

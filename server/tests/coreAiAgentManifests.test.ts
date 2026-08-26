import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type JsonSchema = {
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
};

type AgentManifest = Record<string, unknown> & {
  name: string;
  system_prompt: string;
  response_schema: string;
  tools: Array<{ id: string; type: string; source?: string }>;
  skill_ids: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const manifestDir = resolve(here, "../core-ai-agents");
const schemaPath = resolve(manifestDir, "manifest.schema.json");

const expectedRoster = {
  "seo-ops-audit-report-v1.json": {
    name: "[SEO Ops] Evidence Audit v1",
    output: "seo_ops.audit_report.v1",
  },
  "seo-ops-effect-review-v1.json": {
    name: "[SEO Ops] Effect Review v1",
    output: "seo_ops.effect_review.v1",
  },
  "seo-ops-execution-plan-v1.json": {
    name: "[SEO Ops] Execution Plan v1",
    output: "seo_ops.execution_plan.v1",
  },
  "seo-ops-gbp-post-content-v1.json": {
    name: "[SEO Ops] GBP Post Content v1",
    output: "seo_ops.gbp_post_draft.v1",
  },
  "seo-ops-keyword-set-v2.json": {
    name: "[SEO Ops] Keyword Set v2",
    output: "seo_ops.keyword_set.v2",
  },
  "seo-ops-planner-v1.json": {
    name: "[SEO Ops] Planner & Task Generator v1",
    output: "seo_ops.task_proposals.v1",
  },
  "seo-ops-questionnaire-draft-v1.json": {
    name: "[SEO Ops] Questionnaire Draft v1",
    output: "seo_ops.questionnaire_draft.v1",
  },
  "seo-ops-ranking-report-v1.json": {
    name: "[SEO Ops] Ranking Baseline v1",
    output: "seo_ops.ranking_report.v1",
  },
  "seo-ops-report-packager-v1.json": {
    name: "[SEO Ops] Report Packager v1",
    output: "seo_ops.merchant_report.v1",
  },
} as const;

function jsonFiles(): string[] {
  return readdirSync(manifestDir)
    .filter((file) => file.endsWith(".json") && file !== "manifest.schema.json")
    .sort();
}

function loadManifest(file: keyof typeof expectedRoster): AgentManifest {
  return JSON.parse(readFileSync(resolve(manifestDir, file), "utf8")) as AgentManifest;
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function validate(schema: JsonSchema, value: unknown, path = "$" ): string[] {
  const errors: string[] = [];
  const acceptedTypes = schema.type === undefined
    ? []
    : Array.isArray(schema.type) ? schema.type : [schema.type];
  const actualType = valueType(value);

  if (acceptedTypes.length > 0 && !acceptedTypes.includes(actualType)) {
    return [`${path} must be ${acceptedTypes.join(" or ")}, got ${actualType}`];
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(", ")}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} above maximum`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path} too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match pattern`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validate(schema.items!, item, `${path}[${index}]`)));
  }
  if (actualType === "object") {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(record, key)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(record, key)) errors.push(...validate(propertySchema, record[key], `${path}.${key}`));
    }
  }
  return errors;
}

describe("Core AI SEO Ops Agent manifests", () => {
  it("contains exactly the complete nine-Agent roster", () => {
    expect(jsonFiles()).toEqual(Object.keys(expectedRoster).sort());
  });

  it("validates every desired-state manifest against the versioned local schema", () => {
    expect(existsSync(schemaPath), "manifest.schema.json must exist").toBe(true);
    if (!existsSync(schemaPath)) return;

    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchema;
    for (const file of Object.keys(expectedRoster) as Array<keyof typeof expectedRoster>) {
      expect(validate(schema, loadManifest(file)), file).toEqual([]);
    }
  });

  it("uses exact versioned names and string-encoded object response schemas", () => {
    for (const [file, expected] of Object.entries(expectedRoster) as Array<
      [keyof typeof expectedRoster, (typeof expectedRoster)[keyof typeof expectedRoster]]
    >) {
      const manifest = loadManifest(file);
      expect(manifest.name, file).toBe(expected.name);
      expect(typeof manifest.response_schema, file).toBe("string");
      const responseSchema = JSON.parse(manifest.response_schema);
      expect(responseSchema.type, file).toBe("object");
      expect(responseSchema.properties.schema_version.const, file).toBe(expected.output);
    }
  });

  it("keeps every Agent bounded and without memory, subagents, datasets, or sandbox", () => {
    for (const file of Object.keys(expectedRoster) as Array<keyof typeof expectedRoster>) {
      const manifest = loadManifest(file);
      expect(manifest.manifest_version, file).toBe("seo_ops.core_ai_agent_manifest.v1");
      expect(manifest.max_turns, file).toEqual(expect.any(Number));
      expect(manifest.max_turns, file).toBeGreaterThanOrEqual(1);
      expect(manifest.max_turns, file).toBeLessThanOrEqual(20);
      expect(manifest.timeout_seconds, file).toBeGreaterThanOrEqual(30);
      expect(manifest.timeout_seconds, file).toBeLessThanOrEqual(600);
      expect(manifest.enable_memory, file).toBe(false);
      expect(manifest.subagent_ids, file).toEqual([]);
      expect(manifest.dataset_config, file).toEqual([]);
      expect(manifest.sandbox_config, file).toBeNull();
    }
  });

  it("allows only established read-only tools and never invents Skill IDs", () => {
    const establishedReadOnlyToolIds = new Set([
      "builtin:builtin-web",
      "6a0a7e45eb39b5c74eac135e",
      "6a0a885a3021009253d31dac",
      "6a168c5724e0e8925acb7802",
    ]);
    const establishedSkillIds = new Set([
      "6a8eba18225bdefec335aef9",
      "6a8ec15eccb92906b8117cce",
      "6a8ec15fccb92906b8117ccf",
      "6a8ec5d4ccb92906b8117cd0",
      "6a8ec15f225bdefec335aefa",
    ]);

    for (const file of Object.keys(expectedRoster) as Array<keyof typeof expectedRoster>) {
      const manifest = loadManifest(file);
      for (const tool of manifest.tools) expect(establishedReadOnlyToolIds.has(tool.id), `${file}: ${tool.id}`).toBe(true);
      for (const skillId of manifest.skill_ids) expect(establishedSkillIds.has(skillId), `${file}: ${skillId}`).toBe(true);
    }
  });

  it("keeps Task persistence and external merchant mutation outside every Agent", () => {
    for (const file of Object.keys(expectedRoster) as Array<keyof typeof expectedRoster>) {
      const prompt = loadManifest(file).system_prompt;
      expect(prompt, file).toMatch(/never (?:creates|create) or persists SEO Ops Tasks/i);
      expect(prompt, file).toMatch(/never alters external merchant systems/i);
    }
  });

  it("keeps Planner proposal-only and preserves the US keyword method boundary", () => {
    const planner = loadManifest("seo-ops-planner-v1.json");
    expect(planner.tools).toEqual([]);
    expect(planner.system_prompt).toContain("Return proposals only");
    expect(planner.system_prompt).toContain("does not persist Task");

    const keyword = loadManifest("seo-ops-keyword-set-v2.json");
    expect(keyword.system_prompt).toContain("country_code=US");
    expect(keyword.system_prompt).toContain("en-US");
    expect(keyword.system_prompt).toContain("Google");
    expect(keyword.system_prompt).toContain("seo-keyword-seed-generate");
    expect(keyword.system_prompt).toContain("seo-keyword-ranking-optimize");
    expect(keyword.system_prompt).toContain("UNSCORED");
    expect(keyword.system_prompt).toMatch(/never infer China or Wuhan/i);
    expect(keyword.system_prompt).toContain("Never write to FBR");
  });

  it("makes GBP content an exact US-English draft and never a publication claim", () => {
    const post = loadManifest("seo-ops-gbp-post-content-v1.json");
    expect(post.tools).toEqual([]);
    expect(post.skill_ids).toEqual([]);
    expect(post.system_prompt).toContain("one exact dated occurrence");
    expect(post.system_prompt).toContain("voice-profile version");
    expect(post.system_prompt).toContain("primary keyword cluster");
    expect(post.system_prompt).toContain("United States English");
    expect(post.system_prompt).toContain("Never publish");
    expect(post.system_prompt).not.toMatch(/publication_(?:id|status|success)/i);

    const schema = JSON.parse(post.response_schema);
    expect(Object.keys(schema.properties)).not.toEqual(
      expect.arrayContaining(["publication_id", "published", "publication_success"]),
    );
  });

  it("caps Effect Review at association and keeps Report Packager merchant-safe", () => {
    const review = loadManifest("seo-ops-effect-review-v1.json");
    expect(review.tools).toEqual([]);
    expect(review.system_prompt).toContain("baseline");
    expect(review.system_prompt).toContain("action bundle");
    expect(review.system_prompt).toContain("observed change");
    expect(review.system_prompt).toContain("confounders");
    expect(review.system_prompt).toContain("ASSOCIATIONAL");
    expect(JSON.parse(review.response_schema).properties.conclusion_tier.enum).toEqual([
      "INSUFFICIENT_EVIDENCE",
      "DESCRIPTIVE",
      "ASSOCIATIONAL",
    ]);

    const report = loadManifest("seo-ops-report-packager-v1.json");
    expect(report.tools).toEqual([]);
    expect(report.system_prompt).toContain("one frozen combined merchant-facing report");
    expect(report.system_prompt).toContain("Never include internal-only artifacts");
    expect(report.system_prompt).toContain("Never invent facts");
    expect(report.system_prompt).toContain("Never send, upload, publish, or write");
    expect(JSON.parse(report.response_schema).properties).not.toHaveProperty(
      "excluded_internal_artifact_ids",
    );
  });
});

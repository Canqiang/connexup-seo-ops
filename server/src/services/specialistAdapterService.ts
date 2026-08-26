import crypto from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/connection.js";
import { EXECUTION_MODES, TASK_PRIORITIES, TASK_TYPES } from "../domain/enums.js";
import { listLocationsByMerchant } from "../repos/locationRepo.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { latestQuestionnaireByMerchant } from "../repos/questionnaireRepo.js";
import {
  insertSpecialistArtifact,
  listSpecialistArtifactsByMerchant,
  type SpecialistArtifact,
  type SpecialistArtifactType,
} from "../repos/specialistArtifactRepo.js";
import type { ExecutionAttempt } from "../repos/executionRepo.js";
import type { Task } from "../repos/taskTypes.js";

export const KEYWORD_REQUEST_SCHEMA_VERSION = "seo_ops.keyword_request.v2";
export const KEYWORD_OUTPUT_SCHEMA_VERSION = "seo_ops.keyword_set.v2";
export const AUDIT_REQUEST_SCHEMA_VERSION = "seo_ops.audit_request.v1";
export const AUDIT_OUTPUT_SCHEMA_VERSION = "seo_ops.audit_report.v1";
export const RANKING_REQUEST_SCHEMA_VERSION = "seo_ops.ranking_request.v1";
export const RANKING_OUTPUT_SCHEMA_VERSION = "seo_ops.ranking_report.v1";
export const PLAN_REQUEST_SCHEMA_VERSION = "seo_ops.plan_request.v1";
export const PLAN_OUTPUT_SCHEMA_VERSION = "seo_ops.execution_plan.v1";

const safeIdSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/);

const keywordItemSchema = z.object({
  keyword: z.string().trim().min(1).max(200),
  strategy: z.enum(["LOCAL", "ORGANIC"]),
  intent: z.enum(["LOCAL", "ORGANIC", "BRAND", "MENU", "NEAR_ME"]),
  priority: z.enum(["P0", "P1", "P2", "P3", "UNSCORED"]),
  rationale: z.string().trim().min(1).max(1000),
  source_tags: z.array(z.string().trim().min(1).max(200)).min(1).max(30),
  target_surface_types: z.array(z.enum(["GBP", "WEBSITE"])).max(2),
  target_location: z.string().trim().min(1).max(300).optional(),
}).strict();

const keywordOutputSchema = z.object({
  schema_version: z.literal(KEYWORD_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  market: z.object({
    country_code: z.literal("US"),
    language: z.literal("en-US"),
    search_engine: z.literal("GOOGLE"),
    location_name: z.string().trim().min(1).max(300).optional(),
  }).strict(),
  generation_method: z.enum([
    "UPSTREAM_DETERMINISTIC_ADAPTER",
    "EVIDENCE_BOUNDED_RESEARCH",
  ]),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  keywords: z.array(keywordItemSchema).min(1).max(200),
  evidence_gaps: z.array(z.string().trim().min(1).max(1000)).max(50),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of value.keywords.entries()) {
    const key = item.keyword.toLocaleLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "keyword"],
        message: `duplicate keyword: ${item.keyword}`,
      });
    }
    seen.add(key);
    if (value.generation_method === "UPSTREAM_DETERMINISTIC_ADAPTER" && item.priority === "UNSCORED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "priority"],
        message: "deterministic adapter output must preserve a P0-P3 priority",
      });
    }
    if (value.generation_method === "EVIDENCE_BOUNDED_RESEARCH" && item.priority !== "UNSCORED") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "priority"],
        message: "evidence-bounded research cannot claim deterministic P0-P3 priority",
      });
    }
  }
});

const auditFindingSchema = z.object({
  id: safeIdSchema,
  area: z.enum([
    "GBP",
    "WEBSITE",
    "LOCAL_CONTENT",
    "TECHNICAL",
    "CITATIONS",
    "REVIEWS",
    "ANALYTICS",
    "OTHER",
  ]),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
  observation: z.string().trim().min(1).max(2000),
  evidence: z.array(z.string().trim().min(1).max(1000)).max(10),
  recommendation: z.string().trim().min(1).max(2000),
}).strict();

const auditOutputSchema = z.object({
  schema_version: z.literal(AUDIT_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  evidence_mode: z.enum([
    "PUBLIC_AND_CONFIRMED",
    "CONNECTED_AND_CONFIRMED",
    "CONFIRMED_FACTS_ONLY",
  ]),
  findings: z.array(auditFindingSchema).min(1).max(100),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(50),
  next_actions: z.array(z.string().trim().min(1).max(1000)).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, finding] of value.findings.entries()) {
    if (seen.has(finding.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["findings", index, "id"],
        message: `duplicate finding id: ${finding.id}`,
      });
    }
    seen.add(finding.id);
  }
});

const rankingKeywordSchema = z.object({
  keyword: z.string().trim().min(1).max(200),
  local_rank: z.number().int().min(1).max(200).nullable(),
  organic_rank: z.number().int().min(1).max(200).nullable(),
  source: z.enum(["LIVE_READ_ONLY", "UNAVAILABLE"]),
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();

const rankingOutputSchema = z.object({
  schema_version: z.literal(RANKING_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  captured_at: z.string().datetime({ offset: true }),
  source_mode: z.enum(["LIVE_READ_ONLY", "CONFIRMED_FACTS_ONLY"]),
  keywords: z.array(rankingKeywordSchema).min(1).max(200),
  limitations: z.array(z.string().trim().min(1).max(1000)).max(50),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, keyword] of value.keywords.entries()) {
    const key = keyword.keyword.toLocaleLowerCase();
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "keyword"],
        message: `duplicate ranking keyword: ${keyword.keyword}`,
      });
    }
    seen.add(key);
    if (keyword.source === "UNAVAILABLE" && keyword.local_rank !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "local_rank"],
        message: "UNAVAILABLE source cannot claim a local rank",
      });
    }
    if (keyword.source === "UNAVAILABLE" && keyword.organic_rank !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["keywords", index, "organic_rank"],
        message: "UNAVAILABLE source cannot claim an organic rank",
      });
    }
  }
});

const planWorkItemSchema = z.object({
  id: safeIdSchema,
  title: z.string().trim().min(1).max(300),
  task_type: z.enum(TASK_TYPES),
  execution_mode: z.enum(EXECUTION_MODES),
  priority: z.enum(TASK_PRIORITIES),
  depends_on: z.array(safeIdSchema).max(20),
  rationale: z.string().trim().min(1).max(2000),
  acceptance_criteria: z.string().trim().min(1).max(2000),
  due_offset_days: z.number().int().min(0).max(365).optional(),
}).strict();

const planOutputSchema = z.object({
  schema_version: z.literal(PLAN_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().min(1).max(4000),
  horizon_days: z.number().int().min(1).max(365),
  objectives: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  work_items: z.array(planWorkItemSchema).min(1).max(100),
  review_cadence: z.string().trim().min(1).max(1000),
  assumptions: z.array(z.string().trim().min(1).max(1000)).max(50),
}).strict().superRefine((value, ctx) => {
  const indexes = new Map<string, number>();
  for (const [index, item] of value.work_items.entries()) {
    if (indexes.has(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["work_items", index, "id"],
        message: `duplicate work item id: ${item.id}`,
      });
    } else {
      indexes.set(item.id, index);
    }
  }
  for (const [index, item] of value.work_items.entries()) {
    for (const dependency of item.depends_on) {
      const dependencyIndex = indexes.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex >= index) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["work_items", index, "depends_on"],
          message: `dependency must reference an earlier work item: ${dependency}`,
        });
      }
    }
  }
});

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`${label} must be a JSON object`);
  }
}

export function parseKeywordOutput(output: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("keyword output must be strict JSON");
  }
  const parsed = keywordOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `keyword output schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return parsed.data;
}

function parseStrictOutput<T>(
  output: string,
  label: string,
  schema: z.ZodType<T>,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error(`${label} output must be strict JSON`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `${label} output schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return parsed.data;
}

export function parseAuditOutput(output: string) {
  return parseStrictOutput(output, "audit", auditOutputSchema);
}

export function parseRankingOutput(output: string) {
  return parseStrictOutput(output, "ranking", rankingOutputSchema);
}

export function parsePlanOutput(output: string) {
  return parseStrictOutput(output, "plan", planOutputSchema);
}

export function isStructuredSpecialistTask(taskType: string): boolean {
  return taskType === "KEYWORD_RESEARCH"
    || taskType === "KEYWORD_WEEKLY"
    || taskType === "AUDIT"
    || taskType === "REPORT"
    || taskType === "PLAN";
}

function specialistContract(taskType: string): {
  requestSchemaVersion: string;
  outputSchemaVersion: string;
  requiredArtifactTypes: SpecialistArtifactType[];
  contextArtifactTypes: SpecialistArtifactType[];
  rules: string[];
} {
  if (taskType === "KEYWORD_RESEARCH" || taskType === "KEYWORD_WEEKLY") {
    return {
      requestSchemaVersion: KEYWORD_REQUEST_SCHEMA_VERSION,
      outputSchemaVersion: KEYWORD_OUTPUT_SCHEMA_VERSION,
      requiredArtifactTypes: [],
      contextArtifactTypes: taskType === "KEYWORD_WEEKLY"
        ? ["KEYWORD_SET", "RANKING_SNAPSHOT"]
        : [],
      rules: [
        "require_us_market_and_structured_location",
        "preserve_established_seed_and_ranking_method_lineage",
        "use_unscored_when_deterministic_upstream_is_absent",
        "label_missing_live_search_evidence",
        "never_write_fbr_or_call_saveKeyword",
      ],
    };
  }
  if (taskType === "AUDIT") {
    return {
      requestSchemaVersion: AUDIT_REQUEST_SCHEMA_VERSION,
      outputSchemaVersion: AUDIT_OUTPUT_SCHEMA_VERSION,
      requiredArtifactTypes: ["KEYWORD_SET"],
      contextArtifactTypes: ["KEYWORD_SET"],
      rules: ["audit_against_confirmed_scope", "cite_supplied_evidence", "state_access_limitations"],
    };
  }
  if (taskType === "PLAN") {
    return {
      requestSchemaVersion: PLAN_REQUEST_SCHEMA_VERSION,
      outputSchemaVersion: PLAN_OUTPUT_SCHEMA_VERSION,
      requiredArtifactTypes: ["KEYWORD_SET", "AUDIT_REPORT", "RANKING_SNAPSHOT"],
      contextArtifactTypes: ["KEYWORD_SET", "AUDIT_REPORT", "RANKING_SNAPSHOT"],
      rules: ["derive_plan_from_upstream_artifacts", "order_dependencies_before_dependents"],
    };
  }
  if (taskType === "REPORT") {
    return {
      requestSchemaVersion: RANKING_REQUEST_SCHEMA_VERSION,
      outputSchemaVersion: RANKING_OUTPUT_SCHEMA_VERSION,
      requiredArtifactTypes: ["KEYWORD_SET", "AUDIT_REPORT"],
      contextArtifactTypes: ["KEYWORD_SET", "AUDIT_REPORT"],
      rules: ["measure_only_supplied_keywords", "use_null_for_unavailable_ranks", "label_every_measurement_source"],
    };
  }
  throw new Error(`no structured specialist contract for ${taskType}`);
}

export async function buildSpecialistRunInput(
  db: Db,
  task: Task,
  attempt: ExecutionAttempt,
): Promise<string> {
  const merchant = await getMerchant(db, task.merchantId);
  if (!merchant) throw new Error(`specialist merchant ${task.merchantId} no longer exists`);
  const questionnaire = await latestQuestionnaireByMerchant(db, task.merchantId);
  if (!questionnaire || questionnaire.status !== "FILLED" || !questionnaire.answers) {
    throw new Error(`${task.taskType} work requires a FILLED questionnaire`);
  }
  const contract = specialistContract(task.taskType);
  const locations = await listLocationsByMerchant(db, task.merchantId);
  const priorArtifacts = await listSpecialistArtifactsByMerchant(db, task.merchantId);
  for (const artifactType of contract.requiredArtifactTypes) {
    if (!priorArtifacts.some((artifact) => artifact.artifactType === artifactType)) {
      throw new Error(`${task.taskType} work requires a persisted ${artifactType} artifact`);
    }
  }
  const contextualArtifacts = contract.contextArtifactTypes
    .map((artifactType) => priorArtifacts.find((artifact) => artifact.artifactType === artifactType))
    .filter((artifact): artifact is SpecialistArtifact => artifact !== undefined);
  return JSON.stringify({
    schema_version: contract.requestSchemaVersion,
    seo_ops_task_id: task.id,
    probe_ref: attempt.probeRef,
    attempt_no: attempt.attemptNo,
    market: {
      country_code: "US",
      language: "en-US",
      search_engine: "GOOGLE",
    },
    merchant: {
      id: merchant.id,
      slug: merchant.slug,
      display_name: merchant.displayName,
      tags: merchant.tags,
      locations: locations.map((location) => ({
        id: location.id,
        slug: location.slug,
        display_name: location.displayName,
        timezone: location.timezone,
        external_identities: location.externalIdentities,
        readiness_status: location.readinessStatus,
      })),
    },
    questionnaire: {
      id: questionnaire.id,
      status: questionnaire.status,
      base_info: questionnaire.baseInfo,
      answers: questionnaire.answers,
    },
    upstream_artifacts: contextualArtifacts.map((artifact) => ({
      artifact_id: artifact.id,
      artifact_type: artifact.artifactType,
      schema_version: artifact.schemaVersion,
      title: artifact.title,
      summary: artifact.summary,
      payload: artifact.payload,
      created_at: artifact.createdAt,
    })),
    execution_spec: parseJsonObject(task.executionSpec, "specialist task execution_spec"),
    output_schema_version: contract.outputSchemaVersion,
    rules: [
      "return_strict_json_only",
      "use_confirmed_merchant_facts_only",
      "do_not_claim_persistence_or_task_completion",
      ...contract.rules,
    ],
  });
}

async function persistParsedArtifact(
  db: Db,
  task: Task,
  coreRunId: string,
  artifactType: SpecialistArtifactType,
  parsed: { schema_version: string; title: string; summary: string } & Record<string, unknown>,
  actor: string,
): Promise<SpecialistArtifact> {
  return insertSpecialistArtifact(db, {
    id: crypto.randomUUID(),
    taskId: task.id,
    merchantId: task.merchantId,
    artifactType,
    schemaVersion: parsed.schema_version,
    title: parsed.title,
    summary: parsed.summary,
    payload: parsed,
    coreRunId,
    createdBy: actor,
    createdAt: new Date().toISOString(),
  });
}

export async function ingestSpecialistRunOutput(
  db: Db,
  task: Task,
  coreRunId: string,
  output: string | null | undefined,
  actor = "system:specialist-agent",
): Promise<SpecialistArtifact> {
  if (!output) throw new Error("specialist run completed without output");
  if (task.taskType === "KEYWORD_RESEARCH" || task.taskType === "KEYWORD_WEEKLY") {
    const parsed = parseKeywordOutput(output);
    if (parsed.merchant_id !== task.merchantId) {
      throw new Error("keyword output merchant_id does not match the dispatched task");
    }
    return persistParsedArtifact(db, task, coreRunId, "KEYWORD_SET", parsed, actor);
  }
  if (task.taskType === "AUDIT") {
    const parsed = parseAuditOutput(output);
    if (parsed.merchant_id !== task.merchantId) {
      throw new Error("audit output merchant_id does not match the dispatched task");
    }
    return persistParsedArtifact(db, task, coreRunId, "AUDIT_REPORT", parsed, actor);
  }
  if (task.taskType === "REPORT") {
    const parsed = parseRankingOutput(output);
    if (parsed.merchant_id !== task.merchantId) {
      throw new Error("ranking output merchant_id does not match the dispatched task");
    }
    return persistParsedArtifact(db, task, coreRunId, "RANKING_SNAPSHOT", parsed, actor);
  }
  if (task.taskType === "PLAN") {
    const parsed = parsePlanOutput(output);
    if (parsed.merchant_id !== task.merchantId) {
      throw new Error("plan output merchant_id does not match the dispatched task");
    }
    return persistParsedArtifact(db, task, coreRunId, "EXECUTION_PLAN", parsed, actor);
  }
  throw new Error(`no structured specialist adapter for ${task.taskType}`);
}

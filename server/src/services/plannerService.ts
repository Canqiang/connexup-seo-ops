import { z } from "zod";
import type { Db } from "../db/connection.js";
import { canonicalize, sha256Hash } from "../domain/hashing.js";
import {
  ALLOWED_EXECUTION_MODES,
  EXECUTION_MODES,
  PLANNER_PROPOSABLE_TASK_TYPES,
  TASK_IMPACTS,
  TASK_PRIORITIES,
} from "../domain/enums.js";
import { getMerchant } from "../repos/merchantRepo.js";
import { listLocationsByMerchant } from "../repos/locationRepo.js";
import { latestQuestionnaireByMerchant } from "../repos/questionnaireRepo.js";
import { findTaskByIdempotencyKey, getTask, listTasksByMerchant } from "../repos/taskRepo.js";
import type { Task } from "../repos/taskTypes.js";
import type { ExecutionAttempt } from "../repos/executionRepo.js";
import {
  getAgentBinding,
  getCycleConfig,
  listCapabilities,
} from "../repos/settingsRepo.js";
import { createProposalBatch, type ProposalItemInput } from "./proposalService.js";
import { autoDispatch } from "./executionService.js";
import { authorizeReadOnlyTask } from "./readOnlyAuthorizationService.js";
import { createTask } from "./taskService.js";

export const PLANNER_OUTPUT_SCHEMA_VERSION = "seo_ops.task_proposals.v1";
export const PLANNER_TRIGGER_SCHEMA_VERSION = "seo_ops.planner_trigger.v1";

const plannerItemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  task_type: z.enum(PLANNER_PROPOSABLE_TASK_TYPES),
  execution_mode: z.enum(EXECUTION_MODES),
  executor_agent: z.string().trim().min(1).max(200).optional(),
  location_id: z.string().trim().min(1).optional(),
  depends_on: z.array(z.number().int().positive()).max(50).default([]),
  due_at: z.string().datetime().nullable().optional(),
  priority: z.enum(TASK_PRIORITIES),
  impact: z.enum(TASK_IMPACTS),
  acceptance_criteria: z.string().trim().min(1).max(4000),
  execution_spec: z.record(z.unknown()),
  required_evidence_types: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
}).strict();

const plannerOutputSchema = z.object({
  schema_version: z.literal(PLANNER_OUTPUT_SCHEMA_VERSION),
  trigger_key: z.string().trim().min(1).max(500),
  snapshot_note: z.string().trim().max(4000).optional(),
  items: z.array(plannerItemSchema).min(1).max(50),
}).strict();

const plannerTriggerSchema = z.object({
  schema_version: z.literal(PLANNER_TRIGGER_SCHEMA_VERSION),
  trigger_key: z.string().trim().min(1),
  trigger_type: z.string().trim().min(1),
  trigger_reason: z.string().trim().min(1),
  occurred_at: z.string().datetime(),
  signals: z.array(z.record(z.unknown())).default([]),
}).strict();

export interface PlannerTrigger {
  key: string;
  type: string;
  reason: string;
  occurredAt?: string;
  signals?: Array<Record<string, unknown>>;
}

export interface EnqueuePlannerResult {
  task: Task;
  replayed: boolean;
}

export interface ParsedPlannerOutput {
  triggerKey: string;
  snapshotNote: string | null;
  items: ProposalItemInput[];
}

function parsePlannerTrigger(task: Task) {
  let raw: unknown;
  try {
    raw = JSON.parse(task.executionSpec);
  } catch {
    throw new Error("planner task execution_spec is not valid JSON");
  }
  const parsed = plannerTriggerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`planner task execution_spec is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  return parsed.data;
}

/** Strict boundary parser: Core AI must return one JSON object, never prose or Markdown fences. */
export function parsePlannerOutput(output: string): ParsedPlannerOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("planner output must be strict JSON");
  }
  const parsed = plannerOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `planner output schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return {
    triggerKey: parsed.data.trigger_key,
    snapshotNote: parsed.data.snapshot_note ?? null,
    items: parsed.data.items.map((item) => ({
      title: item.title,
      task_type: item.task_type,
      execution_mode: item.execution_mode,
      ...(item.executor_agent ? { executor_agent: item.executor_agent } : {}),
      ...(item.location_id ? { location_id: item.location_id } : {}),
      depends_on: item.depends_on,
      ...(item.due_at ? { due_at: item.due_at } : {}),
      priority: item.priority,
      impact: item.impact,
      acceptance_criteria: item.acceptance_criteria,
      execution_spec: canonicalize(JSON.stringify(item.execution_spec)),
      required_evidence_types: item.required_evidence_types,
    })),
  };
}

function plannerTaskIdempotencyKey(merchantId: string, triggerKey: string): string {
  const digest = sha256Hash(`${merchantId}:${triggerKey}`).slice("sha256:".length, 39);
  return `planner:${digest}`;
}

/**
 * Turns a deterministic domain event into one automatically authorized PLANNER
 * task. If no Planner is bound, the event remains represented by its source
 * record and can be replayed after configuration; no generic Agent is used.
 */
export async function enqueuePlannerTaskIfBound(
  db: Db,
  merchantId: string,
  trigger: PlannerTrigger,
  actor = "system:planner-router",
): Promise<EnqueuePlannerResult | null> {
  if (!(await getAgentBinding(db, "PLANNER"))) return null;
  const merchant = await getMerchant(db, merchantId);
  if (!merchant) throw new Error(`merchant ${merchantId} not found for planner trigger`);

  const idempotencyKey = plannerTaskIdempotencyKey(merchantId, trigger.key);
  const existing = await findTaskByIdempotencyKey(db, idempotencyKey);
  if (existing) {
    if (existing.merchantId !== merchantId || existing.taskType !== "PLANNER") {
      throw new Error(`planner trigger ${trigger.key} resolves to an invalid existing task`);
    }
    return { task: existing, replayed: true };
  }

  const occurredAt = trigger.occurredAt ?? new Date().toISOString();
  const executionSpec = canonicalize(JSON.stringify({
    schema_version: PLANNER_TRIGGER_SCHEMA_VERSION,
    trigger_key: trigger.key,
    trigger_type: trigger.type,
    trigger_reason: trigger.reason,
    occurred_at: occurredAt,
    signals: trigger.signals ?? [],
  }));
  const created = await createTask(
    db,
    {
      merchant_id: merchantId,
      definition: {
        title: `生成任务图｜${trigger.reason}`,
        task_type: "PLANNER",
        source: "SYSTEM",
        priority: "HIGH",
        impact: "HIGH",
        execution_spec: executionSpec,
        required_evidence_types: [],
        execution_mode: "READ_ONLY",
      },
      idempotency_key: idempotencyKey,
    },
    actor,
  );
  const { task } = created;
  await authorizeReadOnlyTask(db, task, actor, "Planner 只读任务由确定性事件预授权");
  await autoDispatch(db, task.id, actor);
  const current = await getTask(db, task.id);
  if (!current) throw new Error(`planner task ${task.id} disappeared after creation`);
  return { task: current, replayed: created.replayed };
}

/** Build the current SEO Ops snapshot passed to the Planner at dispatch time. */
export async function buildPlannerRunInput(
  db: Db,
  task: Task,
  attempt: ExecutionAttempt,
): Promise<string> {
  const trigger = parsePlannerTrigger(task);
  const merchant = await getMerchant(db, task.merchantId);
  if (!merchant) throw new Error(`planner merchant ${task.merchantId} no longer exists`);
  const [locations, cycleConfig, capabilities, questionnaire, tasks] = await Promise.all([
    listLocationsByMerchant(db, task.merchantId),
    getCycleConfig(db, task.merchantId),
    listCapabilities(db, task.merchantId),
    latestQuestionnaireByMerchant(db, task.merchantId),
    listTasksByMerchant(db, task.merchantId),
  ]);

  const allowedExecutionModes = Object.fromEntries(
    PLANNER_PROPOSABLE_TASK_TYPES.map((taskType) => [taskType, ALLOWED_EXECUTION_MODES[taskType]]),
  );
  return JSON.stringify({
    schema_version: "seo_ops.planner_context.v1",
    seo_ops_task_id: task.id,
    probe_ref: attempt.probeRef,
    attempt_no: attempt.attemptNo,
    generated_at: new Date().toISOString(),
    trigger,
    merchant: {
      id: merchant.id,
      slug: merchant.slug,
      display_name: merchant.displayName,
      tags: merchant.tags,
    },
    locations: locations.map((location) => ({
      id: location.id,
      slug: location.slug,
      display_name: location.displayName,
      timezone: location.timezone,
      readiness_status: location.readinessStatus,
      missing_requirements: location.missingRequirements,
      external_identities: location.externalIdentities,
    })),
    questionnaire: questionnaire
      ? { id: questionnaire.id, status: questionnaire.status, filled_at: questionnaire.filledAt }
      : null,
    cycle_config: cycleConfig,
    capabilities: capabilities.map((capability) => ({
      capability: capability.capability,
      asset: capability.asset,
      status: capability.status,
      external_ref: capability.externalRef,
    })),
    existing_tasks: tasks.map((existing) => ({
      id: existing.id,
      task_type: existing.taskType,
      title: existing.title,
      status: existing.status,
      execution_mode: existing.executionMode,
      due_at: existing.dueAt,
      proposal_id: existing.proposalId,
      updated_at: existing.updatedAt,
    })),
    policy: {
      allowed_task_types: PLANNER_PROPOSABLE_TASK_TYPES,
      allowed_execution_modes_by_task_type: allowedExecutionModes,
      output_schema_version: PLANNER_OUTPUT_SCHEMA_VERSION,
      max_items: 50,
      rules: [
        "do_not_duplicate_active_tasks",
        "dependencies_reference_item_sequence_numbers",
        "auto_write_requires_active_capability_and_exact_location",
        "agent_proposes_only_seo_ops_persists",
      ],
    },
  });
}

/** Convert a completed Planner Run into one idempotent human-review batch. */
export async function ingestPlannerRunOutput(
  db: Db,
  task: Task,
  coreRunId: string,
  output: string | null | undefined,
  actor = "system:planner",
): Promise<void> {
  if (!output) throw new Error("planner run completed without output");
  const trigger = parsePlannerTrigger(task);
  const parsed = parsePlannerOutput(output);
  if (parsed.triggerKey !== trigger.trigger_key) {
    throw new Error("planner output trigger_key does not match the dispatched trigger");
  }
  await createProposalBatch(
    db,
    {
      merchant_id: task.merchantId,
      origin: "PLANNER",
      trigger_reason: trigger.trigger_reason,
      planner_run_id: coreRunId,
      snapshot_note: parsed.snapshotNote ?? undefined,
      idempotency_key: `planner-output:${coreRunId}`,
      items: parsed.items,
    },
    actor,
  );
}

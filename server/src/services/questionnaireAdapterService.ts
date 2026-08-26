import { z } from "zod";
import type { Db } from "../db/connection.js";
import { getMerchant } from "../repos/merchantRepo.js";
import type { ExecutionAttempt } from "../repos/executionRepo.js";
import type { Task } from "../repos/taskTypes.js";
import { createGeneratedQuestionnaire } from "./questionnaireService.js";

export const QUESTIONNAIRE_REQUEST_SCHEMA_VERSION = "seo_ops.questionnaire_request.v1";
export const QUESTIONNAIRE_OUTPUT_SCHEMA_VERSION = "seo_ops.questionnaire_draft.v1";

const questionnaireItemSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  question: z.string().trim().min(1).max(500),
  hint: z.string().trim().min(1).max(500).optional(),
  required: z.boolean(),
}).strict();

const questionnaireOutputSchema = z.object({
  schema_version: z.literal(QUESTIONNAIRE_OUTPUT_SCHEMA_VERSION),
  merchant_id: z.string().trim().min(1),
  base_info: z.record(z.string().max(2000)),
  questions: z.array(questionnaireItemSchema).min(8).max(16),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, item] of value.questions.entries()) {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["questions", index, "id"],
        message: `duplicate question id: ${item.id}`,
      });
    }
    seen.add(item.id);
  }
});

export function parseQuestionnaireOutput(output: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    throw new Error("questionnaire output must be strict JSON");
  }
  const parsed = questionnaireOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `questionnaire output schema mismatch at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid value"}`,
    );
  }
  return parsed.data;
}

export async function buildQuestionnaireRunInput(
  db: Db,
  task: Task,
  attempt: ExecutionAttempt,
): Promise<string> {
  const merchant = await getMerchant(db, task.merchantId);
  if (!merchant) throw new Error(`questionnaire merchant ${task.merchantId} no longer exists`);
  let executionSpec: unknown;
  try {
    executionSpec = JSON.parse(task.executionSpec);
  } catch {
    throw new Error("questionnaire task execution_spec is not valid JSON");
  }
  return JSON.stringify({
    schema_version: QUESTIONNAIRE_REQUEST_SCHEMA_VERSION,
    seo_ops_task_id: task.id,
    probe_ref: attempt.probeRef,
    attempt_no: attempt.attemptNo,
    merchant: {
      id: merchant.id,
      slug: merchant.slug,
      display_name: merchant.displayName,
      tags: merchant.tags,
    },
    execution_spec: executionSpec,
    output_schema_version: QUESTIONNAIRE_OUTPUT_SCHEMA_VERSION,
    rules: [
      "return_strict_json_only",
      "questions_are_for_merchant_confirmation",
      "do_not_invent_business_facts",
      "do_not_send_the_questionnaire",
    ],
  });
}

export async function ingestQuestionnaireRunOutput(
  db: Db,
  task: Task,
  coreRunId: string,
  output: string | null | undefined,
  actor = "system:questionnaire-agent",
): Promise<void> {
  if (!output) throw new Error("questionnaire run completed without output");
  const parsed = parseQuestionnaireOutput(output);
  if (parsed.merchant_id !== task.merchantId) {
    throw new Error("questionnaire output merchant_id does not match the dispatched task");
  }
  await createGeneratedQuestionnaire(db, task.merchantId, {
    baseInfo: parsed.base_info,
    questions: parsed.questions,
    idempotencyKey: `questionnaire-output:${coreRunId}`,
    createdBy: actor,
  });
}

import { z } from "zod";
import { canonicalize, sha256Hash } from "./hashing.js";

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoInstantSchema = z.string().datetime({ offset: true });
const SafeOpaqueSchema = z.string().min(1).max(500).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const SecretRefSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..", "secret reference must be a basename");
const HttpsUrlSchema = z.string().url().max(2_000).refine(
  (value) => new URL(value).protocol === "https:",
  "CTA URL must use HTTPS",
);
const CtaTypeSchema = z.enum(["NONE", "BOOK", "ORDER", "SHOP", "LEARN_MORE", "SIGN_UP", "CALL"]);

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

const CtaSchema = z.object({
  type: CtaTypeSchema,
  url: HttpsUrlSchema.nullable(),
}).strict().superRefine((cta, ctx) => {
  const forbidsUrl = cta.type === "NONE" || cta.type === "CALL";
  if (forbidsUrl && cta.url !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: `${cta.type} forbids a CTA URL` });
  }
  if (!forbidsUrl && cta.url === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: `${cta.type} requires a CTA URL` });
  }
});

const TaskSnapshotSchema = z.object({
  id: UuidSchema,
  merchant_id: UuidSchema,
  location_id: UuidSchema,
  task_revision: z.number().int().positive(),
  execution_spec_sha256: Sha256Schema,
  approval_decision_id: UuidSchema,
}).strict();

const CoreSnapshotSchema = z.object({
  api_user_id: UuidSchema,
  api_user_external_id: SafeOpaqueSchema,
  write_secret_ref: SecretRefSchema,
  readback_secret_ref: SecretRefSchema,
  write_agent_id: UuidSchema,
  write_agent_published_ref: SafeOpaqueSchema,
  readback_agent_id: UuidSchema,
  readback_agent_published_ref: SafeOpaqueSchema,
}).strict();

const GbpLocationSnapshotSchema = z.object({
  account_resource: SafeOpaqueSchema,
  location_resource: SafeOpaqueSchema,
  timezone: z.string().min(1).max(100).refine(isIanaTimezone, "invalid IANA timezone"),
  scheduled_for_local: IsoInstantSchema,
}).strict();

const FinalizedDraftSnapshotSchema = z.object({
  id: UuidSchema,
  version: z.number().int().positive(),
  sha256: Sha256Schema,
  body: z.string().min(1).max(1_500),
  cta: CtaSchema,
  image: z.object({
    deliverable_id: UuidSchema,
    sha256: Sha256Schema,
    alt_text: z.string().min(1).max(500),
  }).strict(),
}).strict();

const CreatePostOperationSchema = z.object({ kind: z.literal("CREATE_POST") }).strict();

export const GbpExecutionCommandSchema = z.object({
  schema_version: z.literal("seo_ops.gbp_execution_command.v1"),
  instruction_id: UuidSchema,
  task: TaskSnapshotSchema,
  core: CoreSnapshotSchema,
  gbp: GbpLocationSnapshotSchema,
  operation: CreatePostOperationSchema,
  draft: FinalizedDraftSnapshotSchema,
  scheduled_for: IsoInstantSchema,
  provider_idempotency_key: SafeOpaqueSchema,
  probe_ref: SafeOpaqueSchema,
}).strict();

export type GbpExecutionCommandV1 = z.infer<typeof GbpExecutionCommandSchema>;

/** Parse first so unknown or malformed fields can never influence durable identity. */
export function canonicalGbpCommand(input: unknown): string {
  const parsed = GbpExecutionCommandSchema.parse(input);
  return canonicalize(JSON.stringify(parsed));
}

export function hashGbpCommand(input: unknown): string {
  return sha256Hash(canonicalGbpCommand(input));
}

export const GbpExecutionReceiptSchema = z.object({
  schema_version: z.literal("seo_ops.gbp_execution_receipt.v1"),
  instruction_id: UuidSchema,
  command_sha256: Sha256Schema,
  provider_idempotency_key: SafeOpaqueSchema,
  probe_ref: SafeOpaqueSchema,
  operation: CreatePostOperationSchema,
  core_api_user_id: UuidSchema,
  account_resource: SafeOpaqueSchema,
  location_resource: SafeOpaqueSchema,
  status: z.enum(["APPLIED", "ALREADY_APPLIED", "REJECTED_PRE_MUTATION", "UNKNOWN"]),
  provider_mutation_count: z.union([z.literal(0), z.literal(1)]),
  provider_post_resource: SafeOpaqueSchema.nullable(),
  provider_request_id: SafeOpaqueSchema.nullable(),
  applied_at: IsoInstantSchema.nullable(),
  submitted: z.object({
    body_sha256: Sha256Schema,
    cta_sha256: Sha256Schema,
    media_sha256: Sha256Schema,
  }).strict(),
}).strict().superRefine((receipt, ctx) => {
  if (receipt.status === "APPLIED"
    && (receipt.provider_mutation_count !== 1
      || receipt.provider_post_resource === null
      || receipt.applied_at === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "APPLIED requires one mutation, post resource, and applied time" });
  }
  if (receipt.status === "ALREADY_APPLIED"
    && (receipt.provider_mutation_count !== 0 || receipt.provider_post_resource === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ALREADY_APPLIED requires zero new mutations and a matched post" });
  }
  if (receipt.status === "REJECTED_PRE_MUTATION" && receipt.provider_mutation_count !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "REJECTED_PRE_MUTATION requires zero mutations" });
  }
});

export type GbpExecutionReceiptV1 = z.infer<typeof GbpExecutionReceiptSchema>;

export const GbpReadbackSchema = z.object({
  schema_version: z.literal("seo_ops.gbp_readback.v1"),
  instruction_id: UuidSchema,
  command_sha256: Sha256Schema,
  core_run_id: UuidSchema,
  readback_agent_id: UuidSchema,
  account_resource: SafeOpaqueSchema,
  location_resource: SafeOpaqueSchema,
  provider_post_resource: SafeOpaqueSchema,
  observed_at: IsoInstantSchema,
  body: z.string().min(1).max(1_500),
  cta: CtaSchema,
  media: z.array(z.object({
    provider_media_resource: SafeOpaqueSchema,
    sha256: Sha256Schema,
  }).strict()).max(20),
}).strict();

export type GbpReadbackV1 = z.infer<typeof GbpReadbackSchema>;

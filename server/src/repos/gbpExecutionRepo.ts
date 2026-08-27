import { z } from "zod";
import type { Db } from "../db/connection.js";
import {
  GbpCanonicalUtcInstantSchema,
  GbpExecutionCommandSchema,
  GbpExecutionReceiptSchema,
  GbpReadbackSchema,
  GbpSafeErrorCodeSchema,
  GbpSecretRefSchema,
  canonicalGbpCommand,
  hashGbpCommand,
  hashGbpCommandBody,
  hashGbpCommandCta,
  hashGbpCommandImage,
  type GbpExecutionCommandV1,
  type GbpExecutionReceiptV1,
  type GbpReadbackV1,
  type GbpSafeErrorCode,
} from "../domain/gbpExecutionContract.js";
import { canonicalize, sha256Hash } from "../domain/hashing.js";
import type {
  GbpCommandClaim,
  GbpCommandRecord,
  GbpCommandState,
  GbpCommandStateStatus,
  GbpLocationBinding,
  GbpReadbackAttempt,
  GbpReceiptRecord,
} from "./types.js";

const IdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const SafeCoordinateSchema = z.string().min(1).max(500).regex(/^[^\s\u0000-\u001f\u007f]+$/);
const UuidSchema = z.string().uuid();
const ScopeSchema = z.object({
  commandId: IdentifierSchema,
  merchantId: IdentifierSchema,
  locationId: IdentifierSchema,
}).strict();

function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return value.includes("/") || value === "UTC";
  } catch {
    return false;
  }
}

const BindingSchema = z.object({
  id: IdentifierSchema,
  merchantId: UuidSchema,
  locationId: UuidSchema,
  accountResource: SafeCoordinateSchema,
  locationResource: SafeCoordinateSchema,
  timezone: z.string().min(1).max(100).refine(isIanaTimezone),
  coreApiUserId: UuidSchema,
  coreApiUserExternalId: IdentifierSchema,
  writeSecretRef: GbpSecretRefSchema,
  readbackSecretRef: GbpSecretRefSchema,
  writeAgentId: UuidSchema,
  writeAgentPublishedRef: SafeCoordinateSchema,
  readbackAgentId: UuidSchema,
  readbackAgentPublishedRef: SafeCoordinateSchema,
  status: z.enum(["DISABLED", "READY", "BLOCKED"]),
  stateVersion: z.number().int().positive(),
  updatedBy: IdentifierSchema,
  createdAt: GbpCanonicalUtcInstantSchema,
  updatedAt: GbpCanonicalUtcInstantSchema,
}).strict();

const InsertCommandInputSchema = z.object({
  id: IdentifierSchema,
  bindingId: IdentifierSchema,
  bindingStateVersion: z.number().int().positive(),
  command: z.unknown(),
  createdBy: IdentifierSchema,
  createdAt: GbpCanonicalUtcInstantSchema,
}).strict();

const ApprovalDecisionSchema = z.object({
  id: UuidSchema,
  decision: z.literal("APPROVE"),
  reason: z.string().optional(),
  taskRevision: z.number().int().positive(),
  executionSpecHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  expectedStateVersion: z.number().int().nonnegative(),
  resultingStateVersion: z.number().int().positive(),
  actorId: IdentifierSchema,
  decidedAt: GbpCanonicalUtcInstantSchema,
}).strict();

const ClaimInputSchema = z.object({
  merchantId: IdentifierSchema,
  locationId: IdentifierSchema,
  workerId: IdentifierSchema,
  leaseToken: UuidSchema,
  now: GbpCanonicalUtcInstantSchema,
  leaseExpiresAt: GbpCanonicalUtcInstantSchema,
}).strict().superRefine((input, ctx) => {
  if (Date.parse(input.leaseExpiresAt) <= Date.parse(input.now)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["leaseExpiresAt"], message: "invalid lease window" });
  }
});

const LeasedTransitionBaseSchema = ScopeSchema.extend({
  expectedStateVersion: z.number().int().positive(),
  leaseOwner: IdentifierSchema,
  leaseToken: UuidSchema,
  updatedAt: GbpCanonicalUtcInstantSchema,
}).strict();

const SafeDiffCodeSchema = z.enum([
  "ACCOUNT_MISMATCH",
  "LOCATION_MISMATCH",
  "POST_MISMATCH",
  "BODY_MISMATCH",
  "CTA_MISMATCH",
  "MEDIA_MISSING",
  "MEDIA_EXTRA",
  "MEDIA_MISMATCH",
  "CORE_AGENT_MISMATCH",
  "CORE_RUN_MISMATCH",
]);

function parseStrict<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid ${label}`);
  return parsed.data;
}

type DbTime = string | Date;
function toIso(value: DbTime): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error("GBP timestamp integrity check failed");
  return parsed.toISOString();
}

interface BindingRow {
  id: string; merchant_id: string; location_id: string;
  account_resource: string; location_resource: string; timezone: string;
  core_api_user_id: string; core_api_user_external_id: string;
  write_secret_ref: string; readback_secret_ref: string;
  write_agent_id: string; write_agent_published_ref: string;
  readback_agent_id: string; readback_agent_published_ref: string;
  status: GbpLocationBinding["status"]; state_version: number; updated_by: string;
  created_at: DbTime; updated_at: DbTime;
}

interface CommandRow {
  id: string; instruction_id: string; task_id: string; merchant_id: string; location_id: string;
  task_revision: number; execution_spec_sha256: string; approval_decision_id: string;
  draft_id: string; draft_version: number; draft_sha256: string;
  image_deliverable_id: string; image_sha256: string;
  binding_id: string; binding_state_version: number; operation: string;
  scheduled_for: DbTime; provider_idempotency_key: string; probe_ref: string;
  canonical_json: string; command_sha256: string; created_by: string; created_at: DbTime;
}

interface StateRow {
  command_id: string; merchant_id: string; location_id: string;
  status: GbpCommandStateStatus; state_version: number; scheduled_for: DbTime;
  lease_owner: string | null; lease_token: string | null;
  lease_acquired_at: DbTime | null; lease_expires_at: DbTime | null;
  trigger_started_at: DbTime | null; core_run_id: string | null;
  safe_error_code: GbpSafeErrorCode | null; resolved_at: DbTime | null;
  created_at: DbTime; updated_at: DbTime;
}

interface ReceiptRow {
  command_id: string; instruction_id: string; canonical_json: string;
  receipt_sha256: string; created_at: DbTime;
}

interface ReadbackRow {
  id: string; command_id: string; observation_json: string | null;
  observation_sha256: string | null; diff_codes: string;
  safe_error_code: GbpSafeErrorCode | null; created_at: DbTime;
}

function toBinding(row: BindingRow): GbpLocationBinding {
  return parseStrict(BindingSchema, {
    id: row.id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    accountResource: row.account_resource,
    locationResource: row.location_resource,
    timezone: row.timezone,
    coreApiUserId: row.core_api_user_id,
    coreApiUserExternalId: row.core_api_user_external_id,
    writeSecretRef: row.write_secret_ref,
    readbackSecretRef: row.readback_secret_ref,
    writeAgentId: row.write_agent_id,
    writeAgentPublishedRef: row.write_agent_published_ref,
    readbackAgentId: row.readback_agent_id,
    readbackAgentPublishedRef: row.readback_agent_published_ref,
    status: row.status,
    stateVersion: row.state_version,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }, "GBP location binding row");
}

function toState(row: StateRow): GbpCommandState {
  const safeErrorCode = row.safe_error_code === null
    ? null
    : parseStrict(GbpSafeErrorCodeSchema, row.safe_error_code, "GBP safe error code row");
  return {
    commandId: row.command_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    status: row.status,
    stateVersion: row.state_version,
    scheduledFor: toIso(row.scheduled_for),
    leaseOwner: row.lease_owner,
    leaseToken: row.lease_token,
    leaseAcquiredAt: row.lease_acquired_at === null ? null : toIso(row.lease_acquired_at),
    leaseExpiresAt: row.lease_expires_at === null ? null : toIso(row.lease_expires_at),
    triggerStartedAt: row.trigger_started_at === null ? null : toIso(row.trigger_started_at),
    coreRunId: row.core_run_id,
    safeErrorCode,
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} integrity check failed`);
  }
}

function assertCommandRow(row: CommandRow): GbpExecutionCommandV1 {
  try {
    const command = GbpExecutionCommandSchema.parse(parseJson(row.canonical_json, "GBP command"));
    const canonical = canonicalGbpCommand(command);
    const fieldsMatch = canonical === row.canonical_json
      && hashGbpCommand(command) === row.command_sha256
      && command.instruction_id === row.instruction_id
      && command.task.id === row.task_id
      && command.task.merchant_id === row.merchant_id
      && command.task.location_id === row.location_id
      && command.task.task_revision === row.task_revision
      && command.task.execution_spec_sha256 === row.execution_spec_sha256
      && command.task.approval_decision_id === row.approval_decision_id
      && command.draft.id === row.draft_id
      && command.draft.version === row.draft_version
      && command.draft.sha256 === row.draft_sha256
      && command.draft.image.deliverable_id === row.image_deliverable_id
      && command.draft.image.sha256 === row.image_sha256
      && command.operation.kind === row.operation
      && command.scheduled_for === toIso(row.scheduled_for)
      && command.provider_idempotency_key === row.provider_idempotency_key
      && command.probe_ref === row.probe_ref;
    if (!fieldsMatch) throw new Error("mismatch");
    return command;
  } catch {
    throw new Error("GBP command integrity check failed");
  }
}

function toCommand(row: CommandRow): GbpCommandRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    bindingStateVersion: row.binding_state_version,
    command: assertCommandRow(row),
    commandSha256: row.command_sha256,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
  };
}

async function getCommandById(db: Db, id: string): Promise<GbpCommandRecord | null> {
  const row = await db.one<CommandRow>(`SELECT * FROM seo_gbp_commands WHERE id = $1`, [id]);
  return row ? toCommand(row) : null;
}

export async function insertGbpLocationBinding(db: Db, input: GbpLocationBinding): Promise<void> {
  const binding = parseStrict(BindingSchema, input, "GBP location binding input");
  await db.exec(
    `INSERT INTO seo_gbp_location_bindings
      (id, merchant_id, location_id, account_resource, location_resource, timezone,
       core_api_user_id, core_api_user_external_id, write_secret_ref, readback_secret_ref,
       write_agent_id, write_agent_published_ref, readback_agent_id,
       readback_agent_published_ref, status, state_version, updated_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      binding.id, binding.merchantId, binding.locationId, binding.accountResource,
      binding.locationResource, binding.timezone, binding.coreApiUserId,
      binding.coreApiUserExternalId, binding.writeSecretRef, binding.readbackSecretRef,
      binding.writeAgentId, binding.writeAgentPublishedRef, binding.readbackAgentId,
      binding.readbackAgentPublishedRef, binding.status, binding.stateVersion,
      binding.updatedBy, binding.createdAt, binding.updatedAt,
    ],
  );
}

export async function getGbpLocationBinding(
  db: Db,
  merchantId: string,
  locationId: string,
): Promise<GbpLocationBinding | null> {
  const scope = parseStrict(z.object({ merchantId: IdentifierSchema, locationId: IdentifierSchema }).strict(),
    { merchantId, locationId }, "GBP location scope");
  const row = await db.one<BindingRow>(
    `SELECT * FROM seo_gbp_location_bindings WHERE merchant_id = $1 AND location_id = $2`,
    [scope.merchantId, scope.locationId],
  );
  return row ? toBinding(row) : null;
}

export async function updateGbpLocationBinding(
  db: Db,
  input: GbpLocationBinding,
  expectedStateVersion: number,
): Promise<GbpLocationBinding | null> {
  const binding = parseStrict(BindingSchema, input, "GBP location binding input");
  const version = parseStrict(z.number().int().positive(), expectedStateVersion, "GBP binding version");
  const rows = await db.query<BindingRow>(
    `UPDATE seo_gbp_location_bindings SET
       account_resource=$1, location_resource=$2, timezone=$3, core_api_user_id=$4,
       core_api_user_external_id=$5, write_secret_ref=$6, readback_secret_ref=$7,
       write_agent_id=$8, write_agent_published_ref=$9, readback_agent_id=$10,
       readback_agent_published_ref=$11, status=$12, state_version=state_version+1,
       updated_by=$13, updated_at=$14
     WHERE id=$15 AND merchant_id=$16 AND location_id=$17 AND state_version=$18
     RETURNING *`,
    [
      binding.accountResource, binding.locationResource, binding.timezone,
      binding.coreApiUserId, binding.coreApiUserExternalId, binding.writeSecretRef,
      binding.readbackSecretRef, binding.writeAgentId, binding.writeAgentPublishedRef,
      binding.readbackAgentId, binding.readbackAgentPublishedRef, binding.status,
      binding.updatedBy, binding.updatedAt, binding.id, binding.merchantId,
      binding.locationId, version,
    ],
  );
  return rows[0] ? toBinding(rows[0]) : null;
}

export interface InsertGbpCommandInput {
  id: string; bindingId: string; bindingStateVersion: number;
  command: unknown; createdBy: string; createdAt: string;
}

export async function insertGbpCommandInTransaction(
  db: Db,
  rawInput: InsertGbpCommandInput,
): Promise<GbpCommandRecord> {
  const input = parseStrict(InsertCommandInputSchema, rawInput, "GBP command insert input");
  const command = parseStrict(GbpExecutionCommandSchema, input.command, "GBP command payload");
  const task = await db.one<{
    id: string; merchant_id: string; location_id: string | null;
    task_revision: number; execution_spec_hash: string; status: string;
    approval_decisions: string;
  }>(
    `SELECT id, merchant_id, location_id, task_revision, execution_spec_hash,
            status, approval_decisions
       FROM seo_tasks
      WHERE id=$1 AND merchant_id=$2 AND location_id=$3
      FOR UPDATE`,
    [command.task.id, command.task.merchant_id, command.task.location_id],
  );
  if (!task || task.status !== "APPROVED" || task.task_revision !== command.task.task_revision
    || task.execution_spec_hash !== command.task.execution_spec_sha256) {
    throw new Error("GBP command Task scope or revision mismatch");
  }
  const approvals = parseStrict(
    z.array(ApprovalDecisionSchema),
    parseJson(task.approval_decisions, "GBP approval snapshot"),
    "GBP approval snapshot",
  );
  const approval = approvals.find((decision) => decision.id === command.task.approval_decision_id);
  if (!approval || approval.taskRevision !== command.task.task_revision
    || approval.executionSpecHash !== command.task.execution_spec_sha256) {
    throw new Error("GBP command approval snapshot mismatch");
  }
  const bindingRow = await db.one<BindingRow>(
    `SELECT * FROM seo_gbp_location_bindings
      WHERE id=$1 AND merchant_id=$2 AND location_id=$3
      FOR UPDATE`,
    [input.bindingId, command.task.merchant_id, command.task.location_id],
  );
  const binding = bindingRow ? toBinding(bindingRow) : null;
  if (!binding || binding.status !== "READY" || binding.stateVersion !== input.bindingStateVersion) {
    throw new Error("GBP binding scope or version mismatch");
  }
  if (binding.accountResource !== command.gbp.account_resource
    || binding.locationResource !== command.gbp.location_resource
    || binding.timezone !== command.gbp.timezone
    || binding.coreApiUserId !== command.core.api_user_id
    || binding.coreApiUserExternalId !== command.core.api_user_external_id
    || binding.writeSecretRef !== command.core.write_secret_ref
    || binding.readbackSecretRef !== command.core.readback_secret_ref
    || binding.writeAgentId !== command.core.write_agent_id
    || binding.writeAgentPublishedRef !== command.core.write_agent_published_ref
    || binding.readbackAgentId !== command.core.readback_agent_id
    || binding.readbackAgentPublishedRef !== command.core.readback_agent_published_ref) {
    throw new Error("GBP command binding snapshot mismatch");
  }
  const canonical = canonicalGbpCommand(command);
  const commandSha256 = hashGbpCommand(command);
  await db.exec(
    `INSERT INTO seo_gbp_commands
      (id,instruction_id,task_id,merchant_id,location_id,task_revision,
       execution_spec_sha256,approval_decision_id,draft_id,draft_version,draft_sha256,
       image_deliverable_id,image_sha256,binding_id,binding_state_version,operation,
       scheduled_for,provider_idempotency_key,probe_ref,canonical_json,command_sha256,
       created_by,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      input.id, command.instruction_id, command.task.id, command.task.merchant_id,
      command.task.location_id, command.task.task_revision, command.task.execution_spec_sha256,
      command.task.approval_decision_id, command.draft.id, command.draft.version,
      command.draft.sha256, command.draft.image.deliverable_id, command.draft.image.sha256,
      input.bindingId, input.bindingStateVersion, command.operation.kind, command.scheduled_for,
      command.provider_idempotency_key, command.probe_ref, canonical, commandSha256,
      input.createdBy, input.createdAt,
    ],
  );
  await db.exec(
    `INSERT INTO seo_gbp_command_states
      (command_id,merchant_id,location_id,status,state_version,scheduled_for,created_at,updated_at)
     VALUES ($1,$2,$3,'SCHEDULED',1,$4,$5,$5)`,
    [input.id, command.task.merchant_id, command.task.location_id, command.scheduled_for, input.createdAt],
  );
  return {
    id: input.id, bindingId: input.bindingId, bindingStateVersion: input.bindingStateVersion,
    command, commandSha256, createdBy: input.createdBy, createdAt: input.createdAt,
  };
}

export async function insertGbpCommand(db: Db, input: InsertGbpCommandInput): Promise<GbpCommandRecord> {
  return db.withTransaction((tx) => insertGbpCommandInTransaction(tx, input));
}

export async function getGbpCommand(
  db: Db, id: string, merchantId: string, locationId: string,
): Promise<GbpCommandRecord | null> {
  const scope = parseStrict(ScopeSchema, { commandId: id, merchantId, locationId }, "GBP command scope");
  const row = await db.one<CommandRow>(
    `SELECT * FROM seo_gbp_commands WHERE id=$1 AND merchant_id=$2 AND location_id=$3`,
    [scope.commandId, scope.merchantId, scope.locationId],
  );
  return row ? toCommand(row) : null;
}

export async function getGbpCommandByTaskRevision(
  db: Db, taskId: string, taskRevision: number, merchantId: string, locationId: string,
): Promise<GbpCommandRecord | null> {
  const parsed = parseStrict(z.object({
    taskId: UuidSchema, taskRevision: z.number().int().positive(),
    merchantId: IdentifierSchema, locationId: IdentifierSchema,
  }).strict(), { taskId, taskRevision, merchantId, locationId }, "GBP Task revision scope");
  const row = await db.one<CommandRow>(
    `SELECT * FROM seo_gbp_commands
      WHERE task_id=$1 AND task_revision=$2 AND merchant_id=$3 AND location_id=$4`,
    [parsed.taskId, parsed.taskRevision, parsed.merchantId, parsed.locationId],
  );
  return row ? toCommand(row) : null;
}

export async function getGbpCommandState(
  db: Db, commandId: string, merchantId: string, locationId: string,
): Promise<GbpCommandState | null> {
  const scope = parseStrict(ScopeSchema, { commandId, merchantId, locationId }, "GBP state scope");
  const row = await db.one<StateRow>(
    `SELECT s.* FROM seo_gbp_command_states s
       JOIN seo_gbp_commands c ON c.id=s.command_id
      WHERE s.command_id=$1 AND c.merchant_id=$2 AND c.location_id=$3
        AND s.merchant_id=c.merchant_id AND s.location_id=c.location_id`,
    [scope.commandId, scope.merchantId, scope.locationId],
  );
  return row ? toState(row) : null;
}

export async function claimNextGbpCommand(
  db: Db,
  rawInput: z.input<typeof ClaimInputSchema>,
): Promise<GbpCommandClaim | null> {
  const input = parseStrict(ClaimInputSchema, rawInput, "GBP claim input");
  return db.withTransaction(async (tx) => {
    const candidate = await tx.one<StateRow>(
      `SELECT s.* FROM seo_gbp_command_states s
         JOIN seo_gbp_commands c ON c.id=s.command_id
        WHERE c.merchant_id=$1 AND c.location_id=$2
          AND s.merchant_id=c.merchant_id AND s.location_id=c.location_id
          AND s.resolved_at IS NULL AND s.trigger_started_at IS NULL
          AND s.scheduled_for <= $3::timestamptz
          AND (s.status='SCHEDULED'
               OR (s.status='CLAIMED' AND s.lease_expires_at <= $3::timestamptz))
        ORDER BY s.scheduled_for, s.command_id
        FOR UPDATE OF s SKIP LOCKED LIMIT 1`,
      [input.merchantId, input.locationId, input.now],
    );
    if (!candidate) return null;
    const updated = await tx.one<StateRow>(
      `UPDATE seo_gbp_command_states s SET
         status='CLAIMED', state_version=s.state_version+1,
         lease_owner=$1, lease_token=$2, lease_acquired_at=$3::timestamptz,
         lease_expires_at=$4::timestamptz, updated_at=$3::timestamptz
        FROM seo_gbp_commands c
       WHERE s.command_id=$5 AND c.id=s.command_id
         AND c.merchant_id=$6 AND c.location_id=$7
       RETURNING s.*`,
      [input.workerId, input.leaseToken, input.now, input.leaseExpiresAt,
        candidate.command_id, input.merchantId, input.locationId],
    );
    if (!updated) return null;
    const command = await getCommandById(tx, candidate.command_id);
    if (!command) throw new Error("GBP command claim integrity check failed");
    return { command, state: toState(updated) };
  });
}

function leasedWhereParams(input: {
  commandId: string; merchantId: string; locationId: string; expectedStateVersion: number;
  leaseOwner: string; leaseToken: string;
}): unknown[] {
  return [input.commandId, input.merchantId, input.locationId, input.expectedStateVersion,
    input.leaseOwner, input.leaseToken];
}

export async function markGbpCommandTriggering(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const schema = LeasedTransitionBaseSchema.extend({ triggerStartedAt: GbpCanonicalUtcInstantSchema }).strict();
  const input = parseStrict(schema, rawInput, "GBP triggering transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='TRIGGERING',
       state_version=s.state_version+1, trigger_started_at=$7::timestamptz,
       updated_at=$8::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status='CLAIMED' AND s.trigger_started_at IS NULL
     RETURNING s.*`,
    [...leasedWhereParams(input), input.triggerStartedAt, input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandRunning(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const schema = LeasedTransitionBaseSchema.extend({ coreRunId: UuidSchema }).strict();
  const input = parseStrict(schema, rawInput, "GBP running transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='RUNNING', state_version=s.state_version+1,
       core_run_id=$7, updated_at=$8::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status='TRIGGERING' AND s.trigger_started_at IS NOT NULL
     RETURNING s.*`,
    [...leasedWhereParams(input), input.coreRunId, input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandOutcomeUnknown(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const schema = LeasedTransitionBaseSchema.extend({ safeErrorCode: GbpSafeErrorCodeSchema }).strict();
  const input = parseStrict(schema, rawInput, "GBP unknown-outcome transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='OUTCOME_UNKNOWN',
       state_version=s.state_version+1, safe_error_code=$7, updated_at=$8::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status IN ('TRIGGERING','RUNNING') AND s.trigger_started_at IS NOT NULL
       AND s.resolved_at IS NULL
     RETURNING s.*`,
    [...leasedWhereParams(input), input.safeErrorCode, input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandBlockedPreSend(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const schema = LeasedTransitionBaseSchema.extend({
    safeErrorCode: GbpSafeErrorCodeSchema,
    resolvedAt: GbpCanonicalUtcInstantSchema,
  }).strict();
  const input = parseStrict(schema, rawInput, "GBP blocked transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='BLOCKED_PRE_SEND',
       state_version=s.state_version+1, safe_error_code=$7, resolved_at=$8::timestamptz,
       lease_owner=NULL, lease_token=NULL, lease_acquired_at=NULL, lease_expires_at=NULL,
       updated_at=$9::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status='CLAIMED' AND s.trigger_started_at IS NULL
     RETURNING s.*`,
    [...leasedWhereParams(input), input.safeErrorCode, input.resolvedAt, input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandReceiptAccepted(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const input = parseStrict(LeasedTransitionBaseSchema, rawInput, "GBP receipt transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='RECEIPT_ACCEPTED',
       state_version=s.state_version+1, safe_error_code=NULL, updated_at=$7::timestamptz
      FROM seo_gbp_commands c, seo_gbp_receipts r
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND r.command_id=s.command_id
       AND (r.canonical_json::jsonb->>'status') IN ('APPLIED','ALREADY_APPLIED')
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6 AND s.status='RUNNING'
     RETURNING s.*`,
    [...leasedWhereParams(input), input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandReadbackPending(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const input = parseStrict(LeasedTransitionBaseSchema, rawInput, "GBP readback-pending transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='READBACK_PENDING',
       state_version=s.state_version+1, updated_at=$7::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status IN ('RECEIPT_ACCEPTED','READBACK_RUNNING')
     RETURNING s.*`,
    [...leasedWhereParams(input), input.updatedAt],
  );
  return row ? toState(row) : null;
}

export async function markGbpCommandReadbackRunning(db: Db, rawInput: unknown): Promise<GbpCommandState | null> {
  const input = parseStrict(LeasedTransitionBaseSchema, rawInput, "GBP readback-running transition");
  const row = await db.one<StateRow>(
    `UPDATE seo_gbp_command_states s SET status='READBACK_RUNNING',
       state_version=s.state_version+1, updated_at=$7::timestamptz
      FROM seo_gbp_commands c
     WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
       AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
       AND s.status='READBACK_PENDING'
     RETURNING s.*`,
    [...leasedWhereParams(input), input.updatedAt],
  );
  return row ? toState(row) : null;
}

function canonicalReceipt(receipt: GbpExecutionReceiptV1): string {
  return canonicalize(JSON.stringify(receipt));
}

function assertReceiptMatchesCommand(receipt: GbpExecutionReceiptV1, command: GbpCommandRecord): void {
  if (receipt.instruction_id !== command.command.instruction_id
    || receipt.command_sha256 !== command.commandSha256
    || receipt.provider_idempotency_key !== command.command.provider_idempotency_key
    || receipt.probe_ref !== command.command.probe_ref
    || receipt.operation.kind !== command.command.operation.kind
    || receipt.core_api_user_id !== command.command.core.api_user_id
    || receipt.account_resource !== command.command.gbp.account_resource
    || receipt.location_resource !== command.command.gbp.location_resource
    || receipt.submitted.body_sha256 !== hashGbpCommandBody(command.command)
    || receipt.submitted.cta_sha256 !== hashGbpCommandCta(command.command)
    || receipt.submitted.media_sha256 !== hashGbpCommandImage(command.command)) {
    throw new Error("GBP receipt does not match its immutable command");
  }
}

const ReceiptInputSchema = ScopeSchema.extend({
  receipt: z.unknown(), createdAt: GbpCanonicalUtcInstantSchema,
}).strict();

export async function insertGbpReceipt(db: Db, rawInput: unknown): Promise<GbpReceiptRecord> {
  const input = parseStrict(ReceiptInputSchema, rawInput, "GBP receipt input");
  const receipt = parseStrict(GbpExecutionReceiptSchema, input.receipt, "GBP receipt payload");
  const command = await getGbpCommand(db, input.commandId, input.merchantId, input.locationId);
  if (!command) throw new Error("GBP receipt scope mismatch");
  assertReceiptMatchesCommand(receipt, command);
  const canonical = canonicalReceipt(receipt);
  const receiptSha256 = sha256Hash(canonical);
  await db.exec(
    `INSERT INTO seo_gbp_receipts(command_id,instruction_id,canonical_json,receipt_sha256,created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.commandId, receipt.instruction_id, canonical, receiptSha256, input.createdAt],
  );
  return { commandId: input.commandId, receipt, receiptSha256, createdAt: input.createdAt };
}

export async function getGbpReceipt(
  db: Db, commandId: string, merchantId: string, locationId: string,
): Promise<GbpReceiptRecord | null> {
  const scope = parseStrict(ScopeSchema, { commandId, merchantId, locationId }, "GBP receipt scope");
  const row = await db.one<ReceiptRow>(
    `SELECT r.* FROM seo_gbp_receipts r
       JOIN seo_gbp_commands c ON c.id=r.command_id
      WHERE r.command_id=$1 AND c.merchant_id=$2 AND c.location_id=$3`,
    [scope.commandId, scope.merchantId, scope.locationId],
  );
  if (!row) return null;
  try {
    const receipt = GbpExecutionReceiptSchema.parse(parseJson(row.canonical_json, "GBP receipt"));
    const canonical = canonicalReceipt(receipt);
    if (canonical !== row.canonical_json || sha256Hash(canonical) !== row.receipt_sha256
      || receipt.instruction_id !== row.instruction_id) throw new Error("mismatch");
    const command = await getGbpCommand(db, scope.commandId, scope.merchantId, scope.locationId);
    if (!command) throw new Error("missing command");
    assertReceiptMatchesCommand(receipt, command);
    return {
      commandId: row.command_id, receipt, receiptSha256: row.receipt_sha256,
      createdAt: toIso(row.created_at),
    };
  } catch {
    throw new Error("GBP receipt integrity check failed");
  }
}

function canonicalReadback(readback: GbpReadbackV1): string {
  return canonicalize(JSON.stringify(readback));
}

function assertReadbackMatchesCommand(readback: GbpReadbackV1, command: GbpCommandRecord): void {
  if (readback.instruction_id !== command.command.instruction_id
    || readback.command_sha256 !== command.commandSha256
    || readback.readback_agent_id !== command.command.core.readback_agent_id
    || readback.account_resource !== command.command.gbp.account_resource
    || readback.location_resource !== command.command.gbp.location_resource) {
    throw new Error("GBP readback does not match its immutable command");
  }
}

const ReadbackInputSchema = ScopeSchema.extend({
  id: IdentifierSchema,
  observation: z.unknown().nullable(),
  diffCodes: z.array(SafeDiffCodeSchema).max(20),
  safeErrorCode: GbpSafeErrorCodeSchema.nullable(),
  createdAt: GbpCanonicalUtcInstantSchema,
}).strict().superRefine((input, ctx) => {
  if (input.observation === null && input.safeErrorCode === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "failed readback requires a code" });
  }
});

export async function insertGbpReadbackAttempt(db: Db, rawInput: unknown): Promise<GbpReadbackAttempt> {
  const input = parseStrict(ReadbackInputSchema, rawInput, "GBP readback input");
  const command = await getGbpCommand(db, input.commandId, input.merchantId, input.locationId);
  if (!command) throw new Error("GBP readback scope mismatch");
  let observation: GbpReadbackV1 | null = null;
  let observationJson: string | null = null;
  let observationSha256: string | null = null;
  if (input.observation !== null) {
    observation = parseStrict(GbpReadbackSchema, input.observation, "GBP readback payload");
    assertReadbackMatchesCommand(observation, command);
    observationJson = canonicalReadback(observation);
    observationSha256 = sha256Hash(observationJson);
  }
  await db.exec(
    `INSERT INTO seo_gbp_readback_attempts
      (id,command_id,observation_json,observation_sha256,diff_codes,safe_error_code,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [input.id, input.commandId, observationJson, observationSha256,
      JSON.stringify(input.diffCodes), input.safeErrorCode, input.createdAt],
  );
  return {
    id: input.id, commandId: input.commandId, observation, observationSha256,
    diffCodes: input.diffCodes, safeErrorCode: input.safeErrorCode, createdAt: input.createdAt,
  };
}

function toReadback(row: ReadbackRow, command: GbpCommandRecord): GbpReadbackAttempt {
  try {
    const rawCodes: unknown = JSON.parse(row.diff_codes);
    const diffCodes = z.array(SafeDiffCodeSchema).max(20).parse(rawCodes);
    const safeErrorCode = row.safe_error_code === null
      ? null
      : GbpSafeErrorCodeSchema.parse(row.safe_error_code);
    let observation: GbpReadbackV1 | null = null;
    if (row.observation_json !== null) {
      observation = GbpReadbackSchema.parse(parseJson(row.observation_json, "GBP readback"));
      const canonical = canonicalReadback(observation);
      if (canonical !== row.observation_json || sha256Hash(canonical) !== row.observation_sha256) {
        throw new Error("observation mismatch");
      }
      assertReadbackMatchesCommand(observation, command);
    } else if (row.observation_sha256 !== null || safeErrorCode === null) {
      throw new Error("observation tuple mismatch");
    }
    return {
      id: row.id, commandId: row.command_id, observation,
      observationSha256: row.observation_sha256, diffCodes, safeErrorCode,
      createdAt: toIso(row.created_at),
    };
  } catch {
    throw new Error("GBP readback integrity check failed");
  }
}

export async function listGbpReadbackAttempts(
  db: Db, commandId: string, merchantId: string, locationId: string,
): Promise<GbpReadbackAttempt[]> {
  const scope = parseStrict(ScopeSchema, { commandId, merchantId, locationId }, "GBP readback scope");
  const command = await getGbpCommand(db, scope.commandId, scope.merchantId, scope.locationId);
  if (!command) return [];
  const rows = await db.query<ReadbackRow>(
    `SELECT r.* FROM seo_gbp_readback_attempts r
       JOIN seo_gbp_commands c ON c.id=r.command_id
      WHERE r.command_id=$1 AND c.merchant_id=$2 AND c.location_id=$3
      ORDER BY r.created_at DESC, r.id DESC`,
    [scope.commandId, scope.merchantId, scope.locationId],
  );
  return rows.map((row) => toReadback(row, command));
}

const CompleteReadbackSchema = LeasedTransitionBaseSchema.extend({
  readbackAttemptId: IdentifierSchema,
  resolvedAt: GbpCanonicalUtcInstantSchema,
}).strict();

export async function completeGbpCommandFromExactReadback(
  db: Db,
  rawInput: unknown,
): Promise<GbpCommandState | null> {
  const input = parseStrict(CompleteReadbackSchema, rawInput, "GBP exact-readback completion");
  return db.withTransaction(async (tx) => {
    const command = await getGbpCommand(tx, input.commandId, input.merchantId, input.locationId);
    if (!command) return null;
    const readbackRow = await tx.one<ReadbackRow>(
      `SELECT r.* FROM seo_gbp_readback_attempts r
         JOIN seo_gbp_commands c ON c.id=r.command_id
        WHERE r.id=$1 AND r.command_id=$2 AND c.merchant_id=$3 AND c.location_id=$4
          AND r.observation_json IS NOT NULL AND r.safe_error_code IS NULL
        FOR UPDATE OF r`,
      [input.readbackAttemptId, input.commandId, input.merchantId, input.locationId],
    );
    if (!readbackRow) return null;
    const readback = toReadback(readbackRow, command);
    if (readback.diffCodes.length !== 0 || readback.observation === null) return null;
    const row = await tx.one<StateRow>(
      `UPDATE seo_gbp_command_states s SET status='DONE', state_version=s.state_version+1,
         resolved_at=$7::timestamptz, safe_error_code=NULL,
         lease_owner=NULL, lease_token=NULL, lease_acquired_at=NULL, lease_expires_at=NULL,
         updated_at=$8::timestamptz
        FROM seo_gbp_commands c
       WHERE s.command_id=$1 AND c.id=s.command_id AND c.merchant_id=$2 AND c.location_id=$3
         AND s.state_version=$4 AND s.lease_owner=$5 AND s.lease_token=$6
         AND s.status IN ('READBACK_RUNNING','OUTCOME_UNKNOWN')
       RETURNING s.*`,
      [...leasedWhereParams(input), input.resolvedAt, input.updatedAt],
    );
    return row ? toState(row) : null;
  });
}

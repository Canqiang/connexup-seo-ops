import type { Db } from "../db/connection.js";
import {
  GbpExecutionCommandSchema,
  GbpExecutionReceiptSchema,
  GbpReadbackSchema,
  canonicalGbpCommand,
  hashGbpCommand,
  type GbpExecutionCommandV1,
  type GbpExecutionReceiptV1,
  type GbpReadbackV1,
} from "../domain/gbpExecutionContract.js";
import { canonicalize, sha256Hash } from "../domain/hashing.js";
import type {
  GbpCommandClaim,
  GbpCommandRecord,
  GbpCommandState,
  GbpLocationBinding,
  GbpReadbackAttempt,
  GbpReceiptRecord,
} from "./types.js";

interface BindingRow {
  id: string;
  merchant_id: string;
  location_id: string;
  account_resource: string;
  location_resource: string;
  timezone: string;
  core_api_user_id: string;
  core_api_user_external_id: string;
  write_secret_ref: string;
  readback_secret_ref: string;
  write_agent_id: string;
  write_agent_published_ref: string;
  readback_agent_id: string;
  readback_agent_published_ref: string;
  status: GbpLocationBinding["status"];
  state_version: number;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface CommandRow {
  id: string;
  instruction_id: string;
  task_id: string;
  merchant_id: string;
  location_id: string;
  task_revision: number;
  execution_spec_sha256: string;
  approval_decision_id: string;
  draft_id: string;
  draft_version: number;
  draft_sha256: string;
  image_deliverable_id: string;
  image_sha256: string;
  binding_id: string;
  binding_state_version: number;
  operation: string;
  scheduled_for: string;
  provider_idempotency_key: string;
  probe_ref: string;
  canonical_json: string;
  command_sha256: string;
  created_by: string;
  created_at: string;
}

interface StateRow {
  command_id: string;
  merchant_id: string;
  location_id: string;
  status: GbpCommandState["status"];
  scheduled_for: string;
  lease_owner: string | null;
  lease_acquired_at: string | null;
  lease_expires_at: string | null;
  trigger_started_at: string | null;
  core_run_id: string | null;
  safe_error_code: string | null;
  safe_error_message: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ReceiptRow {
  command_id: string;
  instruction_id: string;
  canonical_json: string;
  receipt_sha256: string;
  created_at: string;
}

interface ReadbackRow {
  id: string;
  command_id: string;
  observation_json: string | null;
  observation_sha256: string | null;
  diff_codes: string;
  safe_error_code: string | null;
  created_at: string;
}

function toBinding(row: BindingRow): GbpLocationBinding {
  return {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toState(row: StateRow): GbpCommandState {
  return {
    commandId: row.command_id,
    merchantId: row.merchant_id,
    locationId: row.location_id,
    status: row.status,
    scheduledFor: row.scheduled_for,
    leaseOwner: row.lease_owner,
    leaseAcquiredAt: row.lease_acquired_at,
    leaseExpiresAt: row.lease_expires_at,
    triggerStartedAt: row.trigger_started_at,
    coreRunId: row.core_run_id,
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    const hash = hashGbpCommand(command);
    const fieldsMatch = canonical === row.canonical_json
      && hash === row.command_sha256
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
      && command.scheduled_for === row.scheduled_for
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
    createdAt: row.created_at,
  };
}

async function getGbpCommandById(db: Db, id: string): Promise<GbpCommandRecord | null> {
  const row = await db.one<CommandRow>(`SELECT * FROM seo_gbp_commands WHERE id = $1`, [id]);
  return row ? toCommand(row) : null;
}

export async function insertGbpLocationBinding(db: Db, binding: GbpLocationBinding): Promise<void> {
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
  const row = await db.one<BindingRow>(
    `SELECT * FROM seo_gbp_location_bindings
     WHERE merchant_id = $1 AND location_id = $2`,
    [merchantId, locationId],
  );
  return row ? toBinding(row) : null;
}

/** Exact state-version CAS; callers must read back the returned binding before
 * presenting readiness. A stale or cross-scope update returns null. */
export async function updateGbpLocationBinding(
  db: Db,
  binding: GbpLocationBinding,
  expectedStateVersion: number,
): Promise<GbpLocationBinding | null> {
  const rows = await db.query<BindingRow>(
    `UPDATE seo_gbp_location_bindings SET
       account_resource = $1, location_resource = $2, timezone = $3,
       core_api_user_id = $4, core_api_user_external_id = $5,
       write_secret_ref = $6, readback_secret_ref = $7,
       write_agent_id = $8, write_agent_published_ref = $9,
       readback_agent_id = $10, readback_agent_published_ref = $11,
       status = $12, state_version = state_version + 1, updated_by = $13, updated_at = $14
     WHERE id = $15 AND merchant_id = $16 AND location_id = $17 AND state_version = $18
     RETURNING *`,
    [
      binding.accountResource, binding.locationResource, binding.timezone,
      binding.coreApiUserId, binding.coreApiUserExternalId, binding.writeSecretRef,
      binding.readbackSecretRef, binding.writeAgentId, binding.writeAgentPublishedRef,
      binding.readbackAgentId, binding.readbackAgentPublishedRef, binding.status,
      binding.updatedBy, binding.updatedAt, binding.id, binding.merchantId,
      binding.locationId, expectedStateVersion,
    ],
  );
  return rows[0] ? toBinding(rows[0]) : null;
}

export interface InsertGbpCommandInput {
  id: string;
  bindingId: string;
  bindingStateVersion: number;
  command: unknown;
  createdBy: string;
  createdAt: string;
}

/** Transaction-bound primitive for Task 2's approval/command aggregate commit. */
export async function insertGbpCommandInTransaction(
  db: Db,
  input: InsertGbpCommandInput,
): Promise<GbpCommandRecord> {
  const command = GbpExecutionCommandSchema.parse(input.command);
  const binding = await getGbpLocationBinding(db, command.task.merchant_id, command.task.location_id);
  if (!binding || binding.id !== input.bindingId || binding.stateVersion !== input.bindingStateVersion) {
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
    throw new Error("GBP command does not match the exact location binding snapshot");
  }
  const task = await db.one<{
    id: string; merchant_id: string; location_id: string | null;
    task_revision: number; execution_spec_hash: string;
  }>(
    `SELECT id, merchant_id, location_id, task_revision, execution_spec_hash
       FROM seo_tasks WHERE id = $1 AND merchant_id = $2 AND location_id = $3`,
    [command.task.id, command.task.merchant_id, command.task.location_id],
  );
  if (!task || task.task_revision !== command.task.task_revision
    || task.execution_spec_hash !== command.task.execution_spec_sha256) {
    throw new Error("GBP command Task scope or revision mismatch");
  }
  const canonical = canonicalGbpCommand(command);
  const commandSha256 = hashGbpCommand(command);
  await db.exec(
    `INSERT INTO seo_gbp_commands
      (id, instruction_id, task_id, merchant_id, location_id, task_revision,
       execution_spec_sha256, approval_decision_id, draft_id, draft_version,
       draft_sha256, image_deliverable_id, image_sha256, binding_id,
       binding_state_version, operation, scheduled_for, provider_idempotency_key,
       probe_ref, canonical_json, command_sha256, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
    [
      input.id, command.instruction_id, command.task.id, command.task.merchant_id,
      command.task.location_id, command.task.task_revision,
      command.task.execution_spec_sha256, command.task.approval_decision_id,
      command.draft.id, command.draft.version, command.draft.sha256,
      command.draft.image.deliverable_id, command.draft.image.sha256,
      input.bindingId, input.bindingStateVersion, command.operation.kind,
      command.scheduled_for, command.provider_idempotency_key, command.probe_ref,
      canonical, commandSha256, input.createdBy, input.createdAt,
    ],
  );
  await db.exec(
    `INSERT INTO seo_gbp_command_states
      (command_id, merchant_id, location_id, status, scheduled_for, created_at, updated_at)
     VALUES ($1,$2,$3,'SCHEDULED',$4,$5,$5)`,
    [input.id, command.task.merchant_id, command.task.location_id, command.scheduled_for, input.createdAt],
  );
  return {
    id: input.id,
    bindingId: input.bindingId,
    bindingStateVersion: input.bindingStateVersion,
    command,
    commandSha256,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
  };
}

/** Standalone insertion is also atomic: a state constraint failure cannot
 * strand an immutable command without its lifecycle row. */
export async function insertGbpCommand(db: Db, input: InsertGbpCommandInput): Promise<GbpCommandRecord> {
  return db.withTransaction((tx) => insertGbpCommandInTransaction(tx, input));
}

export async function getGbpCommand(
  db: Db,
  id: string,
  merchantId: string,
  locationId: string,
): Promise<GbpCommandRecord | null> {
  const row = await db.one<CommandRow>(
    `SELECT * FROM seo_gbp_commands
     WHERE id = $1 AND merchant_id = $2 AND location_id = $3`,
    [id, merchantId, locationId],
  );
  return row ? toCommand(row) : null;
}

export async function getGbpCommandByTaskRevision(
  db: Db,
  taskId: string,
  taskRevision: number,
  merchantId: string,
  locationId: string,
): Promise<GbpCommandRecord | null> {
  const row = await db.one<CommandRow>(
    `SELECT * FROM seo_gbp_commands
     WHERE task_id = $1 AND task_revision = $2 AND merchant_id = $3 AND location_id = $4`,
    [taskId, taskRevision, merchantId, locationId],
  );
  return row ? toCommand(row) : null;
}

export async function getGbpCommandState(db: Db, commandId: string): Promise<GbpCommandState | null> {
  const row = await db.one<StateRow>(
    `SELECT * FROM seo_gbp_command_states WHERE command_id = $1`,
    [commandId],
  );
  return row ? toState(row) : null;
}

export async function updateGbpCommandState(
  db: Db,
  state: GbpCommandState,
  expectedStatus: GbpCommandState["status"],
): Promise<boolean> {
  const count = await db.exec(
    `UPDATE seo_gbp_command_states SET
       status = $1, lease_owner = $2, lease_acquired_at = $3, lease_expires_at = $4,
       trigger_started_at = $5, core_run_id = $6, safe_error_code = $7,
       safe_error_message = $8, resolved_at = $9, updated_at = $10
     WHERE command_id = $11 AND merchant_id = $12 AND location_id = $13 AND status = $14`,
    [
      state.status, state.leaseOwner, state.leaseAcquiredAt, state.leaseExpiresAt,
      state.triggerStartedAt, state.coreRunId, state.safeErrorCode,
      state.safeErrorMessage, state.resolvedAt, state.updatedAt, state.commandId,
      state.merchantId, state.locationId, expectedStatus,
    ],
  );
  return count === 1;
}

export async function claimNextGbpCommand(
  db: Db,
  input: { workerId: string; now: string; leaseExpiresAt: string },
): Promise<GbpCommandClaim | null> {
  return db.withTransaction(async (tx) => {
    const candidate = await tx.one<StateRow>(
      `SELECT s.* FROM seo_gbp_command_states s
       JOIN seo_gbp_commands c ON c.id = s.command_id
       WHERE s.resolved_at IS NULL
         AND s.trigger_started_at IS NULL
         AND s.scheduled_for <= $1
         AND (
           s.status = 'SCHEDULED'
           OR (s.status = 'CLAIMED' AND s.lease_expires_at <= $1)
         )
       ORDER BY s.scheduled_for, s.command_id
       FOR UPDATE OF s SKIP LOCKED
       LIMIT 1`,
      [input.now],
    );
    if (!candidate) return null;
    const updated = await tx.one<StateRow>(
      `UPDATE seo_gbp_command_states SET
         status = 'CLAIMED', lease_owner = $1, lease_acquired_at = $2,
         lease_expires_at = $3, updated_at = $2
       WHERE command_id = $4
       RETURNING *`,
      [input.workerId, input.now, input.leaseExpiresAt, candidate.command_id],
    );
    if (!updated) throw new Error("GBP command claim update failed");
    const command = await getGbpCommandById(tx, candidate.command_id);
    if (!command) throw new Error("GBP command claim lost its command");
    return { command, state: toState(updated) };
  });
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
    || receipt.location_resource !== command.command.gbp.location_resource) {
    throw new Error("GBP receipt does not match its immutable command");
  }
}

export async function insertGbpReceipt(
  db: Db,
  input: { commandId: string; receipt: unknown; createdAt: string },
): Promise<GbpReceiptRecord> {
  const receipt = GbpExecutionReceiptSchema.parse(input.receipt);
  const command = await getGbpCommandById(db, input.commandId);
  if (!command) throw new Error("GBP receipt command not found");
  assertReceiptMatchesCommand(receipt, command);
  const canonical = canonicalReceipt(receipt);
  const receiptSha256 = sha256Hash(canonical);
  await db.exec(
    `INSERT INTO seo_gbp_receipts
      (command_id, instruction_id, canonical_json, receipt_sha256, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.commandId, receipt.instruction_id, canonical, receiptSha256, input.createdAt],
  );
  return { commandId: input.commandId, receipt, receiptSha256, createdAt: input.createdAt };
}

export async function getGbpReceipt(db: Db, commandId: string): Promise<GbpReceiptRecord | null> {
  const row = await db.one<ReceiptRow>(
    `SELECT * FROM seo_gbp_receipts WHERE command_id = $1`,
    [commandId],
  );
  if (!row) return null;
  try {
    const receipt = GbpExecutionReceiptSchema.parse(parseJson(row.canonical_json, "GBP receipt"));
    const canonical = canonicalReceipt(receipt);
    if (canonical !== row.canonical_json || sha256Hash(canonical) !== row.receipt_sha256
      || receipt.instruction_id !== row.instruction_id) throw new Error("mismatch");
    const command = await getGbpCommandById(db, commandId);
    if (!command) throw new Error("missing command");
    assertReceiptMatchesCommand(receipt, command);
    return {
      commandId: row.command_id,
      receipt,
      receiptSha256: row.receipt_sha256,
      createdAt: row.created_at,
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

export async function insertGbpReadbackAttempt(
  db: Db,
  input: {
    id: string;
    commandId: string;
    observation: unknown | null;
    diffCodes: string[];
    safeErrorCode: string | null;
    createdAt: string;
  },
): Promise<GbpReadbackAttempt> {
  if (!input.observation && !input.safeErrorCode) {
    throw new Error("Failed GBP readback requires a safe error code");
  }
  if (!input.diffCodes.every((code) => typeof code === "string" && code.length > 0 && code.length <= 100)) {
    throw new Error("Invalid GBP readback diff code");
  }
  const command = await getGbpCommandById(db, input.commandId);
  if (!command) throw new Error("GBP readback command not found");
  let observation: GbpReadbackV1 | null = null;
  let observationJson: string | null = null;
  let observationSha256: string | null = null;
  if (input.observation !== null) {
    observation = GbpReadbackSchema.parse(input.observation);
    assertReadbackMatchesCommand(observation, command);
    observationJson = canonicalReadback(observation);
    observationSha256 = sha256Hash(observationJson);
  }
  await db.exec(
    `INSERT INTO seo_gbp_readback_attempts
      (id, command_id, observation_json, observation_sha256, diff_codes,
       safe_error_code, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.id, input.commandId, observationJson, observationSha256,
      JSON.stringify(input.diffCodes), input.safeErrorCode, input.createdAt,
    ],
  );
  return {
    id: input.id,
    commandId: input.commandId,
    observation,
    observationSha256,
    diffCodes: [...input.diffCodes],
    safeErrorCode: input.safeErrorCode,
    createdAt: input.createdAt,
  };
}

export async function listGbpReadbackAttempts(db: Db, commandId: string): Promise<GbpReadbackAttempt[]> {
  const rows = await db.query<ReadbackRow>(
    `SELECT * FROM seo_gbp_readback_attempts
     WHERE command_id = $1 ORDER BY created_at DESC, id DESC`,
    [commandId],
  );
  const command = rows.length > 0 ? await getGbpCommandById(db, commandId) : null;
  if (rows.length > 0 && !command) throw new Error("GBP readback command integrity check failed");
  return rows.map((row) => {
    try {
      const diffCodes: unknown = JSON.parse(row.diff_codes);
      if (!Array.isArray(diffCodes) || !diffCodes.every((code) => typeof code === "string")) {
        throw new Error("diff code mismatch");
      }
      let observation: GbpReadbackV1 | null = null;
      if (row.observation_json !== null) {
        observation = GbpReadbackSchema.parse(parseJson(row.observation_json, "GBP readback"));
        const canonical = canonicalReadback(observation);
        if (canonical !== row.observation_json || sha256Hash(canonical) !== row.observation_sha256) {
          throw new Error("observation mismatch");
        }
        assertReadbackMatchesCommand(observation, command!);
      } else if (row.observation_sha256 !== null || row.safe_error_code === null) {
        throw new Error("observation tuple mismatch");
      }
      return {
        id: row.id,
        commandId: row.command_id,
        observation,
        observationSha256: row.observation_sha256,
        diffCodes,
        safeErrorCode: row.safe_error_code,
        createdAt: row.created_at,
      };
    } catch {
      throw new Error("GBP readback integrity check failed");
    }
  });
}

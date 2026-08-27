import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { gbpContentHttpRequestFingerprint } from "../domain/gbpContentRunIdentity.js";
import {
  CURRENT_AGENT_RUN_REQUEST_SEMANTICS,
  LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS,
  type AgentRunRequestSemantics,
} from "../domain/agentRunRequestSemantics.js";

/** 老库补列(PG 版:用 IF NOT EXISTS,天然幂等)。 */
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS mutation_keys TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE seo_merchant_questionnaires ADD COLUMN IF NOT EXISTS last_sent_by TEXT`,
  // 执行域扩展列（0827）
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'MANUAL'`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS proposal_id TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS depends_on_task_ids TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS published_ref TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS published_at TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS verify_due_at TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS verified_at TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS verified_by TEXT`,
  `ALTER TABLE seo_tasks ADD COLUMN IF NOT EXISTS cycle_id TEXT`,
  `ALTER TABLE seo_proposal_batches ADD COLUMN IF NOT EXISTS cycle_id TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_merchant_cycle_due
     ON seo_tasks(merchant_id, cycle_id, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_proposal_batches_merchant_cycle
     ON seo_proposal_batches(merchant_id, cycle_id, created_at DESC)`,
  // 触发标记（0827 review）：写入类 attempt 触发前先落标记，崩溃后禁止再触发
  `ALTER TABLE seo_execution_attempts ADD COLUMN IF NOT EXISTS trigger_started_at TEXT`,
  `ALTER TABLE seo_execution_attempts ADD COLUMN IF NOT EXISTS trace_ref TEXT`,
  `ALTER TABLE seo_execution_attempts ADD COLUMN IF NOT EXISTS gbp_command_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_attempts_gbp_command
     ON seo_execution_attempts(gbp_command_id) WHERE gbp_command_id IS NOT NULL`,
  `ALTER TABLE seo_gbp_location_bindings
     ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
     ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz`,
  `ALTER TABLE seo_gbp_commands
     ALTER COLUMN scheduled_for TYPE TIMESTAMPTZ USING scheduled_for::timestamptz,
     ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz`,
  `ALTER TABLE seo_gbp_command_states ADD COLUMN IF NOT EXISTS state_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE seo_gbp_command_states ADD COLUMN IF NOT EXISTS lease_token TEXT`,
  `ALTER TABLE seo_gbp_command_states DROP COLUMN IF EXISTS safe_error_message`,
  `ALTER TABLE seo_gbp_command_states
     ALTER COLUMN scheduled_for TYPE TIMESTAMPTZ USING scheduled_for::timestamptz,
     ALTER COLUMN lease_acquired_at TYPE TIMESTAMPTZ USING lease_acquired_at::timestamptz,
     ALTER COLUMN lease_expires_at TYPE TIMESTAMPTZ USING lease_expires_at::timestamptz,
     ALTER COLUMN trigger_started_at TYPE TIMESTAMPTZ USING trigger_started_at::timestamptz,
     ALTER COLUMN resolved_at TYPE TIMESTAMPTZ USING resolved_at::timestamptz,
     ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
     ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz`,
  `ALTER TABLE seo_gbp_receipts
     ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz`,
  `ALTER TABLE seo_gbp_readback_attempts
     ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz`,
  `ALTER TABLE seo_gbp_command_states
     DROP CONSTRAINT IF EXISTS seo_gbp_command_states_lease_tuple_check`,
  `ALTER TABLE seo_gbp_command_states
     ADD CONSTRAINT seo_gbp_command_states_lease_tuple_check CHECK (
       (lease_owner IS NULL AND lease_token IS NULL
        AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
       OR
       (lease_owner IS NOT NULL AND lease_token IS NOT NULL
        AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL
        AND lease_expires_at > lease_acquired_at)
     )`,
  `ALTER TABLE seo_gbp_command_states
     DROP CONSTRAINT IF EXISTS seo_gbp_command_states_unknown_unresolved_check`,
  `ALTER TABLE seo_gbp_command_states
     ADD CONSTRAINT seo_gbp_command_states_unknown_unresolved_check
     CHECK (status <> 'OUTCOME_UNKNOWN' OR resolved_at IS NULL)`,
  `ALTER TABLE seo_gbp_command_states
     DROP CONSTRAINT IF EXISTS seo_gbp_command_states_done_resolved_check`,
  `ALTER TABLE seo_gbp_command_states
     ADD CONSTRAINT seo_gbp_command_states_done_resolved_check
     CHECK (status <> 'DONE' OR resolved_at IS NOT NULL)`,
  `ALTER TABLE seo_gbp_command_states
     DROP CONSTRAINT IF EXISTS seo_gbp_command_states_safe_error_code_check`,
  `ALTER TABLE seo_gbp_command_states
     ADD CONSTRAINT seo_gbp_command_states_safe_error_code_check CHECK (
       safe_error_code IS NULL OR safe_error_code IN (
         'TASK_DRIFT', 'BINDING_DRIFT', 'CLAIM_LOST', 'CONFIG_INVALID',
         'TRIGGER_AMBIGUOUS', 'CORE_RUN_FAILED', 'CORE_RUN_TIMEOUT',
         'CORE_RUN_CANCELLED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH',
         'READBACK_FAILED', 'READBACK_MISMATCH'
       )
     )`,
  `ALTER TABLE seo_gbp_readback_attempts
     DROP CONSTRAINT IF EXISTS seo_gbp_readback_safe_error_code_check`,
  `ALTER TABLE seo_gbp_readback_attempts
     ADD CONSTRAINT seo_gbp_readback_safe_error_code_check CHECK (
       safe_error_code IS NULL OR safe_error_code IN (
         'TASK_DRIFT', 'BINDING_DRIFT', 'CLAIM_LOST', 'CONFIG_INVALID',
         'TRIGGER_AMBIGUOUS', 'CORE_RUN_FAILED', 'CORE_RUN_TIMEOUT',
         'CORE_RUN_CANCELLED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH',
         'READBACK_FAILED', 'READBACK_MISMATCH'
       )
     )`,
  `ALTER TABLE seo_content_drafts ADD COLUMN IF NOT EXISTS agent_run_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_agent_run
     ON seo_content_drafts(agent_run_id) WHERE agent_run_id IS NOT NULL`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_status TEXT NOT NULL DEFAULT 'PENDING'`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_decided_by TEXT`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_decided_at TEXT`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_note TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS business_input_fingerprint TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS location_id TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_of_agent_run_id TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS http_request_fingerprint TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_generation INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_reason TEXT`,
  `ALTER TABLE seo_agent_run_requests ADD COLUMN IF NOT EXISTS semantics_version TEXT`,
  `UPDATE seo_agent_runs
      SET http_request_fingerprint = request_fingerprint
    WHERE http_request_fingerprint IS NULL
      AND request_fingerprint IS NOT NULL`,
  `UPDATE seo_agent_runs
      SET business_input_fingerprint = request_fingerprint
    WHERE stage = 'GBP_POST_CONTENT'
      AND business_input_fingerprint IS NULL
      AND request_fingerprint IS NOT NULL`,
];

const IDENTITY_TYPE_CHECK = "seo_users_identity_type_check";
const ARTIFACT_ACCEPTANCE_STATUS_CHECK = "seo_specialist_artifacts_acceptance_status_check";
const ARTIFACT_ACCEPTANCE_DECISION_CHECK = "seo_specialist_artifacts_acceptance_decision_check";
const AGENT_RUN_REQUEST_SEMANTICS_CHECK = "seo_agent_run_requests_semantics_version_check";

interface LegacyGbpRunIdentityRow {
  id: string;
  merchant_id: string;
  location_id: string | null;
  task_id: string | null;
  retry_of_agent_run_id: string | null;
  retry_reason: string | null;
}

async function rebuildGbpRunIdentity(db: Db): Promise<void> {
  const rows = await db.query<LegacyGbpRunIdentityRow>(
    `SELECT id, merchant_id, location_id, task_id, retry_of_agent_run_id, retry_reason
       FROM seo_agent_runs
      WHERE stage = 'GBP_POST_CONTENT'`,
  );
  const taskIds = [...new Set(rows.flatMap((row) => row.task_id ? [row.task_id] : []))];
  const taskScopes = taskIds.length === 0
    ? []
    : await db.query<{ id: string; merchant_id: string; location_id: string | null }>(
        `SELECT id, merchant_id, location_id FROM seo_tasks WHERE id = ANY($1::text[])`,
        [taskIds],
      );
  const taskScopeById = new Map(taskScopes.map((task) => [task.id, task]));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const generations = new Map<string, number>();
  const visiting = new Set<string>();

  for (const row of rows) {
    if (!row.task_id) {
      throw new Error(`GBP retry lineage reconciliation required: Run ${row.id} has no task_id`);
    }
    const task = taskScopeById.get(row.task_id);
    if (!task) {
      throw new Error(
        `GBP content migration missing Task ${row.task_id} for Run ${row.id}; reconciliation required`,
      );
    }
    if (row.merchant_id !== task.merchant_id) {
      throw new Error(
        `GBP content Run ${row.id} merchant mismatch with Task ${task.id}; reconciliation required`,
      );
    }
    if (row.location_id !== task.location_id) {
      throw new Error(
        `GBP content Run ${row.id} location mismatch with Task ${task.id}; reconciliation required`,
      );
    }
  }

  const generationFor = (row: LegacyGbpRunIdentityRow): number => {
    const known = generations.get(row.id);
    if (known !== undefined) return known;
    if (visiting.has(row.id)) {
      throw new Error(`GBP retry lineage cycle requires reconciliation at Run ${row.id}`);
    }
    visiting.add(row.id);
    try {
      if (!row.retry_of_agent_run_id) {
        if (row.retry_reason?.trim()) {
          throw new Error(`GBP retry lineage reconciliation required: Run ${row.id} has a reason without a parent`);
        }
        generations.set(row.id, 0);
        return 0;
      }
      if (!row.retry_reason?.trim()) {
        throw new Error(`GBP retry lineage reconciliation required: Run ${row.id} has a parent without a reason`);
      }
      const parent = byId.get(row.retry_of_agent_run_id);
      if (!parent) {
        throw new Error(
          `GBP retry lineage reconciliation required: Run ${row.id} references missing parent ${row.retry_of_agent_run_id}`,
        );
      }
      if (parent.task_id !== row.task_id) {
        throw new Error(
          `GBP retry lineage reconciliation required: Run ${row.id} parent ${parent.id} belongs to another Task`,
        );
      }
      const generation = generationFor(parent) + 1;
      generations.set(row.id, generation);
      return generation;
    } finally {
      visiting.delete(row.id);
    }
  };

  for (const row of rows) {
    const retry = row.retry_of_agent_run_id
      ? { priorRunId: row.retry_of_agent_run_id, reason: row.retry_reason! }
      : undefined;
    await db.exec(
      `UPDATE seo_agent_runs
          SET retry_generation = $1,
              retry_reason = $2,
              http_request_fingerprint = $3
        WHERE id = $4`,
      [
        generationFor(row),
        retry ? retry.reason.trim() : null,
        gbpContentHttpRequestFingerprint(row.task_id!, retry),
        row.id,
      ],
    );
  }
}

async function rebuildAgentRunRequestLedger(db: Db): Promise<void> {
  const creationOwners = await db.query<{
    id: string;
    creation_idempotency_key: string;
  }>(
    `SELECT id, creation_idempotency_key
       FROM seo_agent_runs
      WHERE creation_idempotency_key IS NOT NULL`,
  );
  const creationOwnerByKey = new Map(
    creationOwners.map((run) => [run.creation_idempotency_key, run.id]),
  );
  await db.exec(
    `INSERT INTO seo_agent_run_requests
      (idempotency_key, run_id, merchant_id, http_request_fingerprint,
       semantics_version, created_at)
    SELECT creation_idempotency_key, id, merchant_id,
           COALESCE(http_request_fingerprint, request_fingerprint, 'legacy:unknown'),
           $1,
           created_at
      FROM seo_agent_runs
     WHERE creation_idempotency_key IS NOT NULL
    ON CONFLICT (idempotency_key) DO NOTHING`,
    [CURRENT_AGENT_RUN_REQUEST_SEMANTICS],
  );

  const aliases = await db.query<{
    idempotency_key: string;
    run_id: string;
    alias_merchant_id: string;
    http_request_fingerprint: string;
    semantics_version: AgentRunRequestSemantics | null;
    run_merchant_id: string | null;
    run_location_id: string | null;
    stage: string | null;
    task_id: string | null;
    creation_idempotency_key: string | null;
    run_http_request_fingerprint: string | null;
    task_merchant_id: string | null;
    task_location_id: string | null;
  }>(
    `SELECT q.idempotency_key, q.run_id,
            q.merchant_id AS alias_merchant_id,
            q.http_request_fingerprint, q.semantics_version,
            r.merchant_id AS run_merchant_id, r.location_id AS run_location_id,
            r.stage, r.task_id, r.creation_idempotency_key,
            r.http_request_fingerprint AS run_http_request_fingerprint,
            t.merchant_id AS task_merchant_id, t.location_id AS task_location_id
       FROM seo_agent_run_requests q
       LEFT JOIN seo_agent_runs r ON r.id = q.run_id
       LEFT JOIN seo_tasks t ON t.id = r.task_id
      ORDER BY q.idempotency_key`,
  );
  for (const alias of aliases) {
    const creationOwner = creationOwnerByKey.get(alias.idempotency_key);
    if (creationOwner && creationOwner !== alias.run_id) {
      throw new Error(
        `Agent Run creation alias ${alias.idempotency_key} is bound to a different Run; reconciliation required`,
      );
    }
    if (!alias.run_merchant_id) {
      throw new Error(
        `Agent Run request ${alias.idempotency_key} references missing Run ${alias.run_id}; reconciliation required`,
      );
    }
    if (alias.alias_merchant_id !== alias.run_merchant_id) {
      throw new Error(
        `Agent Run request ${alias.idempotency_key} merchant mismatch; reconciliation required`,
      );
    }
    if (alias.stage === "GBP_POST_CONTENT") {
      if (!alias.task_id || !alias.task_merchant_id) {
        throw new Error(
          `GBP Agent Run request ${alias.idempotency_key} references a missing Task; reconciliation required`,
        );
      }
      if (alias.run_merchant_id !== alias.task_merchant_id
        || alias.run_location_id !== alias.task_location_id) {
        throw new Error(
          `GBP Agent Run request ${alias.idempotency_key} has corrupt Task scope; reconciliation required`,
        );
      }
    }
    if (alias.semantics_version !== null) continue;
    const isDerivableGbpCreationAlias = alias.stage === "GBP_POST_CONTENT"
      && alias.idempotency_key === alias.creation_idempotency_key;
    const semanticsVersion = alias.stage === "GBP_POST_CONTENT" && !isDerivableGbpCreationAlias
      ? LEGACY_BOUND_AGENT_RUN_REQUEST_SEMANTICS
      : CURRENT_AGENT_RUN_REQUEST_SEMANTICS;
    await db.exec(
      `UPDATE seo_agent_run_requests
          SET semantics_version = $1,
              http_request_fingerprint = CASE WHEN $2 THEN $3 ELSE http_request_fingerprint END
        WHERE idempotency_key = $4 AND semantics_version IS NULL`,
      [
        semanticsVersion,
        isDerivableGbpCreationAlias,
        alias.run_http_request_fingerprint,
        alias.idempotency_key,
      ],
    );
  }
}

async function ensureAgentRunRequestSemanticsCheck(db: Db): Promise<void> {
  await db.exec(
    `ALTER TABLE seo_agent_run_requests
       ALTER COLUMN semantics_version SET DEFAULT 'STRICT_CURRENT',
       ALTER COLUMN semantics_version SET NOT NULL`,
  );
  const existing = await db.one<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = current_schema()
        AND table_name = 'seo_agent_run_requests'
        AND constraint_name = $1
        AND constraint_type = 'CHECK'`,
    [AGENT_RUN_REQUEST_SEMANTICS_CHECK],
  );
  if (existing) return;
  await db.exec(
    `ALTER TABLE seo_agent_run_requests
       ADD CONSTRAINT seo_agent_run_requests_semantics_version_check
       CHECK (semantics_version IN ('STRICT_CURRENT', 'LEGACY_BOUND'))`,
  );
}

async function ensureUserIdentityTypeCheck(db: Db): Promise<void> {
  const existing = await db.one<{ constraint_name: string }>(
    `SELECT constraint_name
     FROM information_schema.table_constraints
     WHERE table_schema = current_schema()
       AND table_name = 'seo_users'
       AND constraint_name = $1
       AND constraint_type = 'CHECK'`,
    [IDENTITY_TYPE_CHECK],
  );
  if (existing) return;

  await db.exec(
    `ALTER TABLE seo_users
     ADD CONSTRAINT seo_users_identity_type_check
     CHECK (identity_type IN ('HUMAN', 'SERVICE'))`,
  );
}

async function ensureArtifactAcceptanceStatusCheck(db: Db): Promise<void> {
  const existing = await db.one<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = current_schema()
        AND table_name = 'seo_specialist_artifacts'
        AND constraint_name = $1
        AND constraint_type = 'CHECK'`,
    [ARTIFACT_ACCEPTANCE_STATUS_CHECK],
  );
  if (existing) return;
  await db.exec(
    `UPDATE seo_specialist_artifacts
        SET acceptance_status = 'PENDING',
            acceptance_decided_by = NULL,
            acceptance_decided_at = NULL,
            acceptance_note = NULL
      WHERE acceptance_status NOT IN ('PENDING', 'ACCEPTED', 'REJECTED')`,
  );
  await db.exec(
    `ALTER TABLE seo_specialist_artifacts
       ADD CONSTRAINT seo_specialist_artifacts_acceptance_status_check
       CHECK (acceptance_status IN ('PENDING', 'ACCEPTED', 'REJECTED'))`,
  );
}

async function ensureArtifactAcceptanceDecisionCheck(db: Db): Promise<void> {
  const existing = await db.one<{ constraint_name: string }>(
    `SELECT constraint_name
       FROM information_schema.table_constraints
      WHERE table_schema = current_schema()
        AND table_name = 'seo_specialist_artifacts'
        AND constraint_name = $1
        AND constraint_type = 'CHECK'`,
    [ARTIFACT_ACCEPTANCE_DECISION_CHECK],
  );
  if (existing) return;
  await db.exec(
    `UPDATE seo_specialist_artifacts
        SET acceptance_status = 'PENDING',
            acceptance_decided_by = NULL,
            acceptance_decided_at = NULL,
            acceptance_note = NULL
      WHERE (acceptance_status = 'PENDING'
              AND (acceptance_decided_by IS NOT NULL
                   OR acceptance_decided_at IS NOT NULL
                   OR acceptance_note IS NOT NULL))
         OR (acceptance_status IN ('ACCEPTED', 'REJECTED')
              AND (acceptance_decided_by IS NULL OR acceptance_decided_at IS NULL))`,
  );
  await db.exec(
    `ALTER TABLE seo_specialist_artifacts
       ADD CONSTRAINT seo_specialist_artifacts_acceptance_decision_check
       CHECK (
         (acceptance_status = 'PENDING'
           AND acceptance_decided_by IS NULL
           AND acceptance_decided_at IS NULL
           AND acceptance_note IS NULL)
         OR
         (acceptance_status IN ('ACCEPTED', 'REJECTED')
           AND acceptance_decided_by IS NOT NULL
           AND acceptance_decided_at IS NOT NULL)
       )`,
  );
}

export async function migrate(db: Db): Promise<void> {
  await db.withTransaction(async (tx) => {
    for (const statement of SCHEMA_STATEMENTS) await tx.exec(statement);
    for (const statement of COLUMN_MIGRATIONS) await tx.exec(statement);
    await rebuildGbpRunIdentity(tx);
    await rebuildAgentRunRequestLedger(tx);
    await ensureAgentRunRequestSemanticsCheck(tx);
    await ensureUserIdentityTypeCheck(tx);
    await ensureArtifactAcceptanceStatusCheck(tx);
    await ensureArtifactAcceptanceDecisionCheck(tx);
  });
}

import type { Db } from "./connection.js";
import { SCHEMA_STATEMENTS } from "./schema.js";
import { gbpContentHttpRequestFingerprint } from "../domain/gbpContentRunIdentity.js";

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
  `ALTER TABLE seo_content_drafts ADD COLUMN IF NOT EXISTS agent_run_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_agent_run
     ON seo_content_drafts(agent_run_id) WHERE agent_run_id IS NOT NULL`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_status TEXT NOT NULL DEFAULT 'PENDING'`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_decided_by TEXT`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_decided_at TEXT`,
  `ALTER TABLE seo_specialist_artifacts ADD COLUMN IF NOT EXISTS acceptance_note TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS business_input_fingerprint TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_of_agent_run_id TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS http_request_fingerprint TEXT`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_generation INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS retry_reason TEXT`,
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

interface LegacyGbpRunIdentityRow {
  id: string;
  task_id: string | null;
  retry_of_agent_run_id: string | null;
  retry_reason: string | null;
}

async function rebuildGbpRunIdentity(db: Db): Promise<void> {
  const rows = await db.query<LegacyGbpRunIdentityRow>(
    `SELECT id, task_id, retry_of_agent_run_id, retry_reason
       FROM seo_agent_runs
      WHERE stage = 'GBP_POST_CONTENT'`,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const generations = new Map<string, number>();
  const visiting = new Set<string>();

  const generationFor = (row: LegacyGbpRunIdentityRow): number => {
    const known = generations.get(row.id);
    if (known !== undefined) return known;
    if (!row.task_id) {
      throw new Error(`GBP retry lineage reconciliation required: Run ${row.id} has no task_id`);
    }
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
  await db.exec(
    `INSERT INTO seo_agent_run_requests
      (idempotency_key, run_id, merchant_id, http_request_fingerprint, created_at)
    SELECT creation_idempotency_key, id, merchant_id,
           COALESCE(http_request_fingerprint, request_fingerprint, 'legacy:unknown'),
           created_at
      FROM seo_agent_runs
     WHERE creation_idempotency_key IS NOT NULL
    ON CONFLICT (idempotency_key) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          merchant_id = EXCLUDED.merchant_id,
          http_request_fingerprint = EXCLUDED.http_request_fingerprint`,
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
    await ensureUserIdentityTypeCheck(tx);
    await ensureArtifactAcceptanceStatusCheck(tx);
    await ensureArtifactAcceptanceDecisionCheck(tx);
  });
}

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS seo_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL,
    identity_type TEXT NOT NULL CONSTRAINT seo_users_identity_type_check CHECK (identity_type IN ('HUMAN', 'SERVICE')),
    permissions TEXT NOT NULL DEFAULT '[]',
    password_hash TEXT,
    status TEXT NOT NULL,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_status ON seo_users(status)`,

  `CREATE TABLE IF NOT EXISTS seo_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON seo_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON seo_sessions(expires_at)`,

  `CREATE TABLE IF NOT EXISTS seo_merchants (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    operator_user_ids TEXT NOT NULL DEFAULT '[]',
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS seo_locations (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    display_name TEXT NOT NULL,
    timezone TEXT,
    external_identities TEXT NOT NULL DEFAULT '{}',
    readiness_status TEXT NOT NULL,
    missing_requirements TEXT NOT NULL DEFAULT '[]',
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(merchant_id, slug)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_locations_merchant ON seo_locations(merchant_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_identity_scope
     ON seo_locations(id, merchant_id)`,

  `CREATE TABLE IF NOT EXISTS seo_tasks (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    location_id TEXT,
    task_type TEXT NOT NULL,
    source TEXT NOT NULL,
    priority TEXT NOT NULL,
    impact TEXT NOT NULL,
    owner_id TEXT,
    due_at TEXT,
    status TEXT NOT NULL,
    evidence_state TEXT NOT NULL,
    task_revision INTEGER NOT NULL,
    state_version INTEGER NOT NULL,
    title TEXT NOT NULL,
    execution_spec TEXT NOT NULL,
    execution_spec_hash TEXT NOT NULL,
    required_evidence_types TEXT NOT NULL DEFAULT '[]',
    revisions TEXT NOT NULL DEFAULT '[]',
    evidence_refs TEXT NOT NULL DEFAULT '[]',
    approval_decisions TEXT NOT NULL DEFAULT '[]',
    events TEXT NOT NULL DEFAULT '[]',
    conversation_links TEXT NOT NULL DEFAULT '[]',
    agent_run_links TEXT NOT NULL DEFAULT '[]',
    mutation_keys TEXT NOT NULL DEFAULT '{}',
    depends_on_task_ids TEXT NOT NULL DEFAULT '[]',
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_merchant_status_due ON seo_tasks(merchant_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_due ON seo_tasks(owner_id, status, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_merchant_updated ON seo_tasks(merchant_id, updated_at DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_identity_scope
     ON seo_tasks(id, merchant_id, location_id)`,

  /** 阶段运行：归属于（商户，地点，阶段），不挂在 task 上。task_id 仅作溯源
   * （Plan 转出的任务回指来源运行），永远可空。 */
  `CREATE TABLE IF NOT EXISTS seo_agent_runs (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    location_id TEXT,
    stage TEXT NOT NULL,
    task_id TEXT,
    run_type TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL,
    core_run_id TEXT,
    trace_ref TEXT,
    core_status TEXT,
    input_message TEXT NOT NULL,
    output TEXT,
    error TEXT,
    error_code TEXT,
    token_usage TEXT NOT NULL DEFAULT '{}',
    triggered_by TEXT NOT NULL,
    triggered_at TEXT NOT NULL,
    last_polled_at TEXT,
    completed_at TEXT,
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    http_request_fingerprint TEXT,
    business_input_fingerprint TEXT,
    retry_of_agent_run_id TEXT,
    retry_generation INTEGER NOT NULL DEFAULT 0,
    retry_reason TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `ALTER TABLE seo_agent_runs ADD COLUMN IF NOT EXISTS trace_ref TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_merchant_stage ON seo_agent_runs(merchant_id, stage, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON seo_agent_runs(status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_gbp_content_task_fingerprint
     ON seo_agent_runs(task_id, request_fingerprint)
     WHERE stage = 'GBP_POST_CONTENT' AND task_id IS NOT NULL AND request_fingerprint IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_gbp_content_active_task
     ON seo_agent_runs(task_id)
     WHERE stage = 'GBP_POST_CONTENT' AND task_id IS NOT NULL
       AND status IN ('TRIGGERING', 'RUNNING')`,

  /** Every accepted HTTP idempotency key is durable, including keys which
   * converge onto a business-equivalent Run created by another request. */
  `CREATE TABLE IF NOT EXISTS seo_agent_run_requests (
    idempotency_key TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    http_request_fingerprint TEXT NOT NULL,
    semantics_version TEXT NOT NULL DEFAULT 'STRICT_CURRENT',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_run_requests_run
     ON seo_agent_run_requests(run_id, created_at)`,

  /** 交付物：一文件一行。SUMMARY = 运行正文落盘；ATTACHMENT = agent 返回的附件；
   * MANUAL = 运营手工上传兜底。按 id 服务下载（数组下标会因补下载而错位）。
   * id 由 (run_id, 来源) 决定性生成，终态重放时 INSERT OR REPLACE 天然幂等。 */
  `CREATE TABLE IF NOT EXISTS seo_run_deliverables (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    file_id TEXT,
    file_name TEXT NOT NULL,
    content_type TEXT,
    size INTEGER,
    title TEXT,
    description TEXT,
    sha256 TEXT,
    local_path TEXT,
    remote_url TEXT,
    downloaded_at TEXT,
    download_error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_deliverables_run ON seo_run_deliverables(run_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliverables_sha ON seo_run_deliverables(sha256)`,

  `CREATE TABLE IF NOT EXISTS seo_merchant_questionnaires (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    share_slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    base_info TEXT NOT NULL DEFAULT '{}',
    questions TEXT NOT NULL DEFAULT '[]',
    answers TEXT,
    send_count INTEGER NOT NULL DEFAULT 0,
    sent_at TEXT,
    last_sent_at TEXT,
    last_sent_by TEXT,
    filled_at TEXT,
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_questionnaires_merchant_created ON seo_merchant_questionnaires(merchant_id, created_at DESC)`,

  /** Specialist 结构化业务产物：Core AI 只生成，SEO Ops 严格解析后独立持久化。 */
  `CREATE TABLE IF NOT EXISTS seo_specialist_artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload TEXT NOT NULL,
    core_run_id TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    acceptance_status TEXT NOT NULL DEFAULT 'PENDING',
    acceptance_decided_by TEXT,
    acceptance_decided_at TEXT,
    acceptance_note TEXT,
    CONSTRAINT seo_specialist_artifacts_acceptance_status_check
      CHECK (acceptance_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
    CONSTRAINT seo_specialist_artifacts_acceptance_decision_check
      CHECK (
        (acceptance_status = 'PENDING'
          AND acceptance_decided_by IS NULL
          AND acceptance_decided_at IS NULL
          AND acceptance_note IS NULL)
        OR
        (acceptance_status IN ('ACCEPTED', 'REJECTED')
          AND acceptance_decided_by IS NOT NULL
          AND acceptance_decided_at IS NOT NULL)
      ),
    UNIQUE(core_run_id, artifact_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_specialist_artifacts_task ON seo_specialist_artifacts(task_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_specialist_artifacts_merchant ON seo_specialist_artifacts(merchant_id, artifact_type, created_at DESC)`,
  // ---------------- 执行域 / 建议层 / 设置面（0827 扩展） ----------------

  /** Cycle is an explicit merchant boundary, not a date heuristic.  Legacy
   * Tasks/batches intentionally remain unassigned until a human creates new
   * work; projections never infer or backfill membership. */
  `CREATE TABLE IF NOT EXISTS seo_merchant_cycles (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    starts_at TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_active_cycle
     ON seo_merchant_cycles(merchant_id) WHERE status = 'ACTIVE'`,
  `CREATE INDEX IF NOT EXISTS idx_merchant_cycles_merchant_status
     ON seo_merchant_cycles(merchant_id, status, starts_at DESC)`,

  `CREATE TABLE IF NOT EXISTS seo_proposal_batches (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    trigger_reason TEXT,
    planner_run_id TEXT,
    snapshot_note TEXT,
    status TEXT NOT NULL,
    creation_idempotency_key TEXT,
    request_fingerprint TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proposal_batches_merchant ON seo_proposal_batches(merchant_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS seo_proposals (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    location_id TEXT,
    seq INTEGER NOT NULL,
    title TEXT NOT NULL,
    task_type TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    executor_agent TEXT,
    depends_on TEXT NOT NULL DEFAULT '[]',
    due_at TEXT,
    priority TEXT NOT NULL,
    impact TEXT NOT NULL,
    acceptance_criteria TEXT,
    execution_spec TEXT NOT NULL,
    required_evidence_types TEXT NOT NULL DEFAULT '[]',
    validation_failures TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    decided_by TEXT,
    decided_at TEXT,
    return_reason TEXT,
    task_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(batch_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_batch ON seo_proposals(batch_id, seq)`,
  `CREATE INDEX IF NOT EXISTS idx_proposals_merchant_status ON seo_proposals(merchant_id, status)`,

  /** attempt：一次派发一行；OUTCOME_UNKNOWN 未决即冻结该商户执行链（红线③）。 */
  `CREATE TABLE IF NOT EXISTS seo_execution_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL,
    status TEXT NOT NULL,
    gate TEXT NOT NULL,
    agent_run_id TEXT,
    core_run_id TEXT,
    trace_ref TEXT,
    probe_ref TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    trigger_started_at TEXT,
    resolved_at TEXT,
    resolved_by TEXT,
    resolution TEXT,
    resolution_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(task_id, attempt_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_task ON seo_execution_attempts(task_id, attempt_no DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_attempts_merchant_status ON seo_execution_attempts(merchant_id, status)`,
  /** Terminal Core run attachments for task execution.  These are bounded
   * metadata rows; bytes remain with Core and are never copied into audit. */
  `CREATE TABLE IF NOT EXISTS seo_execution_attempt_deliverables (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    content_type TEXT,
    sha256 TEXT,
    source_ref TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(attempt_id, file_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attempt_deliverables_attempt ON seo_execution_attempt_deliverables(attempt_id, created_at ASC, id ASC)`,

  /** Dedicated GBP execution path. Immutable command/receipt payloads remain
   * separate from mutable lifecycle state and generic execution attempts. */
  `CREATE TABLE IF NOT EXISTS seo_gbp_location_bindings (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    account_resource TEXT NOT NULL,
    location_resource TEXT NOT NULL,
    timezone TEXT NOT NULL,
    core_api_user_id TEXT NOT NULL,
    core_api_user_external_id TEXT NOT NULL,
    write_secret_ref TEXT NOT NULL,
    readback_secret_ref TEXT NOT NULL,
    write_agent_id TEXT NOT NULL,
    write_agent_published_ref TEXT NOT NULL,
    readback_agent_id TEXT NOT NULL,
    readback_agent_published_ref TEXT NOT NULL,
    status TEXT NOT NULL CONSTRAINT seo_gbp_location_bindings_status_check
      CHECK (status IN ('DISABLED', 'READY', 'BLOCKED')),
    state_version INTEGER NOT NULL CHECK (state_version > 0),
    updated_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE(merchant_id, location_id),
    UNIQUE(id, merchant_id, location_id),
    FOREIGN KEY (location_id, merchant_id) REFERENCES seo_locations(id, merchant_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gbp_bindings_status
     ON seo_gbp_location_bindings(status, merchant_id, location_id)`,

  `CREATE TABLE IF NOT EXISTS seo_gbp_commands (
    id TEXT PRIMARY KEY,
    instruction_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    merchant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    task_revision INTEGER NOT NULL CHECK (task_revision > 0),
    execution_spec_sha256 TEXT NOT NULL,
    approval_decision_id TEXT NOT NULL,
    draft_id TEXT NOT NULL,
    draft_version INTEGER NOT NULL CHECK (draft_version > 0),
    draft_sha256 TEXT NOT NULL,
    image_deliverable_id TEXT NOT NULL,
    image_sha256 TEXT NOT NULL,
    binding_id TEXT NOT NULL,
    binding_state_version INTEGER NOT NULL CHECK (binding_state_version > 0),
    operation TEXT NOT NULL CONSTRAINT seo_gbp_commands_create_only_check
      CHECK (operation = 'CREATE_POST'),
    scheduled_for TIMESTAMPTZ NOT NULL,
    provider_idempotency_key TEXT NOT NULL UNIQUE,
    probe_ref TEXT NOT NULL UNIQUE,
    canonical_json TEXT NOT NULL,
    command_sha256 TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE(task_id, task_revision),
    UNIQUE(id, merchant_id, location_id),
    FOREIGN KEY (task_id, merchant_id, location_id)
      REFERENCES seo_tasks(id, merchant_id, location_id),
    FOREIGN KEY (binding_id, merchant_id, location_id)
      REFERENCES seo_gbp_location_bindings(id, merchant_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gbp_commands_location_created
     ON seo_gbp_commands(merchant_id, location_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS seo_gbp_command_states (
    command_id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    location_id TEXT NOT NULL,
    status TEXT NOT NULL CONSTRAINT seo_gbp_command_states_status_check CHECK (status IN (
      'SCHEDULED', 'CLAIMED', 'TRIGGERING', 'RUNNING', 'RECEIPT_ACCEPTED',
      'READBACK_PENDING', 'READBACK_RUNNING', 'DONE', 'BLOCKED_PRE_SEND', 'OUTCOME_UNKNOWN'
    )),
    state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
    scheduled_for TIMESTAMPTZ NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    trigger_started_at TIMESTAMPTZ,
    core_run_id TEXT,
    safe_error_code TEXT CONSTRAINT seo_gbp_command_states_safe_error_code_check CHECK (
      safe_error_code IS NULL OR safe_error_code IN (
        'TASK_DRIFT', 'BINDING_DRIFT', 'CLAIM_LOST', 'CONFIG_INVALID',
        'TRIGGER_AMBIGUOUS', 'CORE_RUN_FAILED', 'CORE_RUN_TIMEOUT',
        'CORE_RUN_CANCELLED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH',
        'READBACK_FAILED', 'READBACK_MISMATCH'
      )
    ),
    safe_error_message TEXT,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT seo_gbp_command_states_lease_tuple_check CHECK (
      (lease_owner IS NULL AND lease_token IS NULL
       AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
      OR
      (lease_owner IS NOT NULL AND lease_token IS NOT NULL
       AND lease_acquired_at IS NOT NULL
       AND lease_expires_at IS NOT NULL AND lease_expires_at > lease_acquired_at)
    ),
    CONSTRAINT seo_gbp_command_states_unknown_unresolved_check CHECK (
      status <> 'OUTCOME_UNKNOWN' OR resolved_at IS NULL
    ),
    CONSTRAINT seo_gbp_command_states_done_resolved_check CHECK (
      status <> 'DONE' OR resolved_at IS NOT NULL
    ),
    CONSTRAINT seo_gbp_command_states_safe_error_message_null_check CHECK (
      safe_error_message IS NULL
    ),
    FOREIGN KEY (command_id, merchant_id, location_id)
      REFERENCES seo_gbp_commands(id, merchant_id, location_id)
  )`,
  `CREATE OR REPLACE FUNCTION seo_gbp_guard_command_state_update()
   RETURNS trigger AS $$
   BEGIN
     IF NEW.state_version <> OLD.state_version + 1 THEN
       RAISE EXCEPTION 'illegal GBP command state version';
     END IF;
     IF OLD.trigger_started_at IS NOT NULL
        AND NEW.trigger_started_at IS DISTINCT FROM OLD.trigger_started_at THEN
       RAISE EXCEPTION 'GBP trigger marker is immutable';
     END IF;
     IF OLD.trigger_started_at IS NULL AND NEW.trigger_started_at IS NOT NULL
        AND NOT (OLD.status = 'CLAIMED' AND NEW.status = 'TRIGGERING') THEN
       RAISE EXCEPTION 'GBP trigger marker requires CLAIMED to TRIGGERING';
     END IF;
     IF OLD.resolved_at IS NOT NULL
        AND NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
       RAISE EXCEPTION 'GBP resolution marker is immutable';
     END IF;
     IF OLD.status = NEW.status AND OLD.status <> 'CLAIMED' THEN
       RAISE EXCEPTION 'GBP state updates require an explicit transition';
     END IF;
     IF OLD.status = 'CLAIMED' AND NEW.status = 'CLAIMED' AND (
       NEW.trigger_started_at IS DISTINCT FROM OLD.trigger_started_at OR
       NEW.core_run_id IS DISTINCT FROM OLD.core_run_id OR
       NEW.safe_error_code IS DISTINCT FROM OLD.safe_error_code OR
       NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
     ) THEN
       RAISE EXCEPTION 'GBP claim renewal may change only its lease tuple';
     END IF;
     IF OLD.status <> NEW.status AND NOT (
       (OLD.status = 'SCHEDULED' AND NEW.status = 'CLAIMED') OR
       (OLD.status = 'CLAIMED' AND NEW.status IN ('TRIGGERING', 'BLOCKED_PRE_SEND')) OR
       (OLD.status = 'TRIGGERING' AND NEW.status IN ('RUNNING', 'OUTCOME_UNKNOWN')) OR
       (OLD.status = 'RUNNING' AND NEW.status IN ('RECEIPT_ACCEPTED', 'OUTCOME_UNKNOWN')) OR
       (OLD.status = 'RECEIPT_ACCEPTED' AND NEW.status = 'READBACK_PENDING') OR
       (OLD.status = 'READBACK_PENDING' AND NEW.status = 'READBACK_RUNNING') OR
       (OLD.status = 'READBACK_RUNNING' AND NEW.status IN ('READBACK_PENDING', 'DONE')) OR
       (OLD.status = 'OUTCOME_UNKNOWN' AND NEW.status = 'DONE')
     ) THEN
       RAISE EXCEPTION 'illegal GBP command state transition';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'seo_gbp_command_states'::regclass
          AND tgname = 'trg_seo_gbp_guard_command_state_update'
          AND NOT tgisinternal
     ) THEN
       CREATE TRIGGER trg_seo_gbp_guard_command_state_update
       BEFORE UPDATE ON seo_gbp_command_states
       FOR EACH ROW EXECUTE FUNCTION seo_gbp_guard_command_state_update();
     END IF;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_gbp_command_states_due
     ON seo_gbp_command_states(status, scheduled_for, lease_expires_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_gbp_command_states_unresolved_location
     ON seo_gbp_command_states(merchant_id, location_id)
     WHERE resolved_at IS NULL`,

  `CREATE TABLE IF NOT EXISTS seo_gbp_receipts (
    command_id TEXT PRIMARY KEY REFERENCES seo_gbp_commands(id),
    instruction_id TEXT NOT NULL UNIQUE,
    canonical_json TEXT NOT NULL,
    receipt_sha256 TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS seo_gbp_readback_attempts (
    id TEXT PRIMARY KEY,
    command_id TEXT NOT NULL REFERENCES seo_gbp_commands(id),
    observation_json TEXT,
    observation_sha256 TEXT,
    diff_codes TEXT NOT NULL DEFAULT '[]',
    safe_error_code TEXT CONSTRAINT seo_gbp_readback_safe_error_code_check CHECK (
      safe_error_code IS NULL OR safe_error_code IN (
        'TASK_DRIFT', 'BINDING_DRIFT', 'CLAIM_LOST', 'CONFIG_INVALID',
        'TRIGGER_AMBIGUOUS', 'CORE_RUN_FAILED', 'CORE_RUN_TIMEOUT',
        'CORE_RUN_CANCELLED', 'RECEIPT_INVALID', 'RECEIPT_MISMATCH',
        'READBACK_FAILED', 'READBACK_MISMATCH'
      )
    ),
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT seo_gbp_readback_observation_tuple_check CHECK (
      (observation_json IS NULL AND observation_sha256 IS NULL)
      OR (observation_json IS NOT NULL AND observation_sha256 IS NOT NULL)
    )
  )`,
  `CREATE INDEX IF NOT EXISTS idx_gbp_readback_attempts_command
     ON seo_gbp_readback_attempts(command_id, created_at DESC, id DESC)`,

  `ALTER TABLE seo_execution_attempts
     ADD COLUMN IF NOT EXISTS gbp_command_id TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_execution_attempts_gbp_command
     ON seo_execution_attempts(gbp_command_id) WHERE gbp_command_id IS NOT NULL`,
  `DO $$
   BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'seo_execution_attempts'::regclass
          AND conname = 'seo_execution_attempts_gbp_command_fk'
     ) THEN
       ALTER TABLE seo_execution_attempts
         ADD CONSTRAINT seo_execution_attempts_gbp_command_fk
         FOREIGN KEY (gbp_command_id) REFERENCES seo_gbp_commands(id);
     END IF;
   END $$`,

  /** 幂等键唯一索引：并发同 key 双创建靠数据库兜底（23505 → 重试走 replay）。 */
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_idem_key ON seo_tasks(creation_idempotency_key) WHERE creation_idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_proposal_batches_idem_key ON seo_proposal_batches(creation_idempotency_key) WHERE creation_idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_runs_idem_key ON seo_agent_runs(creation_idempotency_key) WHERE creation_idempotency_key IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_questionnaires_idem_key ON seo_merchant_questionnaires(creation_idempotency_key) WHERE creation_idempotency_key IS NOT NULL`,

  /** 能力矩阵：技术连接 × 商户授权 → ACTIVE/BLOCKED/MISSING（门2第3项校验的数据源）。 */
  `CREATE TABLE IF NOT EXISTS seo_capabilities (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    asset TEXT NOT NULL,
    capability TEXT NOT NULL,
    external_ref TEXT,
    tech_connected BOOLEAN NOT NULL DEFAULT FALSE,
    merchant_authorized BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL,
    verified_at TEXT,
    verified_by TEXT,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(merchant_id, capability)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_capabilities_merchant ON seo_capabilities(merchant_id)`,

  /** 周期配置 = Ⓐ级预授权：scheduler 据此自动出任务（人批规则，不逐件批）。 */
  `CREATE TABLE IF NOT EXISTS seo_cycle_configs (
    merchant_id TEXT PRIMARY KEY,
    snapshot_day INTEGER,
    post_weekday INTEGER,
    post_per_week INTEGER NOT NULL DEFAULT 1,
    review_window_days INTEGER NOT NULL DEFAULT 30,
    audit_interval_days INTEGER,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /** taskType → core-ai published agent 绑定（换绑记审计走事件日志）。 */
  `CREATE TABLE IF NOT EXISTS seo_agent_bindings (
    task_type TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    agent_label TEXT,
    published_ref TEXT,
    updated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,

  /** Post 内容稿：v1 生成 → v2 反馈重写 → v3 人工改；每版一行，任务经 rev 引用定稿。 */
  `CREATE TABLE IF NOT EXISTS seo_content_drafts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    agent_run_id TEXT,
    media_source_agent_run_id TEXT,
    version INTEGER NOT NULL,
    body TEXT NOT NULL,
    cta_type TEXT,
    cta_url TEXT,
    media TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL,
    feedback TEXT,
    sha256 TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(task_id, version)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_task ON seo_content_drafts(task_id, version DESC)`,

  /** 商户风格档案：品牌档案 voice + 人工校订，按版本引用（更新不追溯已批准稿）。 */
  `CREATE TABLE IF NOT EXISTS seo_style_profiles (
    id TEXT PRIMARY KEY,
    merchant_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    voice TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(merchant_id, version)
  )`,
];

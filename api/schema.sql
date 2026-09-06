CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes TEXT,
  primary_location TEXT,
  website_url TEXT,
  auto_run_interval_days INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_gbp_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  fbr_merchant_id TEXT NOT NULL,
  gbp_location_id TEXT NOT NULL,
  google_account_id TEXT,
  source_name TEXT,
  source_title TEXT,
  location_json TEXT,
  attributes_json TEXT,
  food_menus_json TEXT,
  local_posts_json TEXT,
  media_json TEXT,
  customer_media_json TEXT,
  questions_json TEXT,
  place_action_links_json TEXT,
  verifications_json TEXT,
  normalized_json TEXT NOT NULL,
  source_updated_at TEXT,
  synced_at TEXT NOT NULL,
  UNIQUE (merchant_id, gbp_location_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_gbp_profiles_merchant
  ON merchant_gbp_profiles(merchant_id, gbp_location_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  coreai_run_id TEXT,
  dispatch_state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')),
  dispatch_token TEXT,
  dispatch_started_at TEXT,
  poll_failure_started_at TEXT,
  provider_candidate_run_id TEXT,
  source_agent_id TEXT,
  merchant_lifecycle_generation INTEGER,
  merchant_lifecycle_sha256 TEXT,
  input_sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','auto')),
  report_text TEXT,
  error TEXT,
  plan_approved_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_merchant ON runs(merchant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_coreai_run_id
  ON runs(coreai_run_id) WHERE coreai_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatch_token
  ON runs(dispatch_token) WHERE dispatch_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_dispatch_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('NOT_CREATED','BIND_EXISTING')),
  provider_run_id TEXT,
  operator_id TEXT NOT NULL CHECK (length(trim(operator_id)) > 0),
  prior_dispatch_state TEXT NOT NULL
    CHECK (prior_dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')),
  result_dispatch_state TEXT NOT NULL
    CHECK (result_dispatch_state IN ('DISPATCHING','DISPATCHED','UNKNOWN','FAILED')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_dispatch_reconciliations_run
  ON run_dispatch_reconciliations(run_id, id);

CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_reconciliations_no_update
BEFORE UPDATE ON run_dispatch_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'run dispatch reconciliations are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_run_dispatch_reconciliations_no_delete
BEFORE DELETE ON run_dispatch_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'run dispatch reconciliations are append-only');
END;

CREATE TABLE IF NOT EXISTS audit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  schema_version TEXT NOT NULL CHECK (schema_version = 'seo_ops.audit_report.v1'),
  payload_json TEXT NOT NULL,
  evidence_mode TEXT NOT NULL CHECK (evidence_mode IN ('PUBLIC_AND_CONFIRMED','CONNECTED_AND_CONFIRMED','CONFIRMED_FACTS_ONLY')),
  finding_count INTEGER NOT NULL CHECK (finding_count > 0),
  source_ref TEXT,
  accepted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_snapshots_merchant
  ON audit_snapshots(merchant_id, accepted_at DESC);

CREATE TABLE IF NOT EXISTS merchant_seo_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  cycle_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('KEYWORD_SET','AUDIT_REPORT','RANKING_REPORT')),
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ready','failed')),
  source_agent_id TEXT NOT NULL,
  coreai_run_id TEXT UNIQUE,
  dispatch_state TEXT NOT NULL DEFAULT 'not_required'
    CHECK (dispatch_state IN ('not_required','pending','dispatching','dispatched','unknown')),
  dispatch_started_at TEXT,
  request_json TEXT NOT NULL,
  payload_json TEXT,
  provenance_json TEXT,
  verification_started_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_merchant_seo_artifacts_latest
  ON merchant_seo_artifacts(merchant_id, id DESC);

CREATE TABLE IF NOT EXISTS merchant_keyword_heads (
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  active_artifact_id INTEGER REFERENCES merchant_seo_artifacts(id) ON DELETE RESTRICT,
  activated_by TEXT,
  activation_reason TEXT CHECK (
    activation_reason IS NULL OR activation_reason IN (
      'SKILL_GENERATION',
      'SYSTEM_BOOTSTRAP',
      'RESTORE_SKILL',
      'ADOPT_FBR'
    )
  ),
  activated_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (active_artifact_id IS NULL AND activated_by IS NULL
      AND activation_reason IS NULL AND activated_at IS NULL)
    OR
    (active_artifact_id IS NOT NULL AND activated_by IS NOT NULL
      AND activation_reason IS NOT NULL AND activated_at IS NOT NULL)
  ),
  PRIMARY KEY (merchant_id, place_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_keyword_heads_active
  ON merchant_keyword_heads(active_artifact_id);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_syncs (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  place_id TEXT,
  keyword_artifact_id INTEGER REFERENCES merchant_seo_artifacts(id) ON DELETE SET NULL,
  cohort_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('synced','failed')),
  last_attempt_at TEXT NOT NULL,
  last_synced_at TEXT,
  last_error TEXT,
  missing_keywords_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  place_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform = 'google'),
  captured_at TEXT NOT NULL,
  center_lat REAL NOT NULL,
  center_lng REAL NOT NULL,
  grid_size INTEGER NOT NULL,
  radius REAL NOT NULL,
  measurement TEXT NOT NULL CHECK (measurement IN ('mi','km')),
  arp REAL NOT NULL,
  atrp REAL NOT NULL,
  solv REAL NOT NULL,
  found_in INTEGER NOT NULL,
  image_url TEXT,
  heatmap_url TEXT,
  grid_points_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  UNIQUE (merchant_id, report_key)
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_latest
  ON merchant_local_falcon_reports(merchant_id, keyword, captured_at DESC);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  keyword_artifact_id INTEGER NOT NULL REFERENCES merchant_seo_artifacts(id) ON DELETE CASCADE,
  cohort_sha256 TEXT NOT NULL CHECK (length(cohort_sha256) = 64),
  cohort_json TEXT NOT NULL,
  place_id TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  UNIQUE (merchant_id, keyword_artifact_id, cohort_sha256)
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_approvals_latest
  ON merchant_local_falcon_approvals(merchant_id, id DESC);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_scan_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  approval_id INTEGER NOT NULL REFERENCES merchant_local_falcon_approvals(id) ON DELETE RESTRICT,
  confirmation_request_id TEXT NOT NULL,
  scan_config_sha256 TEXT NOT NULL CHECK (length(scan_config_sha256) = 64),
  scan_config_json TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL,
  UNIQUE (merchant_id, confirmation_request_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_scan_confirmations_latest
  ON merchant_local_falcon_scan_confirmations(merchant_id, id DESC);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_scan_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  approval_id INTEGER NOT NULL REFERENCES merchant_local_falcon_approvals(id) ON DELETE RESTRICT,
  confirmation_id INTEGER NOT NULL REFERENCES merchant_local_falcon_scan_confirmations(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitting','submitted','partial','completed','failed','unknown')),
  scan_config_json TEXT NOT NULL,
  dispatch_token TEXT,
  dispatch_started_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (confirmation_id),
  UNIQUE (merchant_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_scan_batches_latest
  ON merchant_local_falcon_scan_batches(merchant_id, id DESC);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_scan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES merchant_local_falcon_scan_batches(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','submitting','submitted','completed','failed','unknown')),
  ack_report_key TEXT,
  response_json TEXT,
  error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, keyword)
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_scan_items_batch
  ON merchant_local_falcon_scan_items(batch_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_local_falcon_scan_items_report_key
  ON merchant_local_falcon_scan_items(ack_report_key)
  WHERE ack_report_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS merchant_local_falcon_reconciliations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES merchant_local_falcon_scan_batches(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES merchant_local_falcon_scan_items(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('BIND_ACKNOWLEDGED_REPORT','CONFIRM_NOT_SUBMITTED','CLOSE_WITHOUT_RETRY')),
  report_key TEXT,
  reason TEXT NOT NULL,
  details_json TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  reconciled_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_local_falcon_reconciliations_batch
  ON merchant_local_falcon_reconciliations(batch_id, id);

CREATE TABLE IF NOT EXISTS task_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('AGENT','OPERATOR','MIGRATION')),
  source_run_id INTEGER UNIQUE REFERENCES runs(id),
  state TEXT NOT NULL CHECK (state IN ('OPEN','REJECTED','CLOSED')),
  latest_revision INTEGER NOT NULL,
  approved_revision INTEGER,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TRIGGER IF NOT EXISTS guard_merchants_delete_with_task_plan_history
BEFORE DELETE ON merchants
WHEN EXISTS (SELECT 1 FROM task_plans WHERE merchant_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'merchant_has_durable_history');
END;

CREATE TABLE IF NOT EXISTS task_plan_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES task_plans(id),
  revision INTEGER NOT NULL,
  decision_state TEXT NOT NULL CHECK (decision_state IN ('DRAFT','APPROVED','REJECTED','SUPERSEDED')),
  schema_version TEXT NOT NULL CHECK (schema_version = 'seo_ops.task_plan.v1'),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  source TEXT NOT NULL CHECK (source IN ('AGENT','OPERATOR','MIGRATION')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  UNIQUE (plan_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_task_plan_revisions_checksum
  ON task_plan_revisions(plan_id, checksum);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_plan_revisions_one_draft
  ON task_plan_revisions(plan_id) WHERE decision_state = 'DRAFT';

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  plan_id INTEGER NOT NULL REFERENCES task_plans(id),
  plan_revision INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  task_type TEXT NOT NULL,
  workflow_version INTEGER NOT NULL CHECK (workflow_version > 0),
  parameters_json TEXT NOT NULL,
  definition_checksum TEXT NOT NULL CHECK (length(definition_checksum) = 64),
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  expected_outcome TEXT,
  category TEXT,
  scheduled_start TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PREPARING','AWAITING_APPROVAL','EXECUTING','VERIFYING','NEEDS_ATTENTION','DONE','CANCELLED')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  assignee TEXT,
  labels_json TEXT NOT NULL DEFAULT '[]',
  operator_note TEXT,
  evidence_note TEXT,
  source_run_id INTEGER REFERENCES runs(id),
  source_key TEXT,
  replaces_task_id INTEGER REFERENCES tasks(id),
  replaced_by_task_id INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  UNIQUE (plan_id, task_key),
  FOREIGN KEY (plan_id, plan_revision)
    REFERENCES task_plan_revisions(plan_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_tasks_merchant ON tasks(merchant_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, plan_revision);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key
  ON tasks(source_key) WHERE source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
  CHECK (task_id != depends_on_task_id),
  UNIQUE (task_id, depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_task
  ON task_dependencies(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream
  ON task_dependencies(depends_on_task_id, id);

CREATE TABLE IF NOT EXISTS task_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  stage TEXT NOT NULL CHECK (stage IN ('PREPARATION','PUBLICATION','VERIFICATION')),
  status TEXT NOT NULL
    CHECK (status IN ('PENDING','DISPATCHING','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  approval_id INTEGER,
  artifact_id INTEGER,
  request_json TEXT NOT NULL,
  request_checksum TEXT NOT NULL CHECK (length(request_checksum) = 64),
  idempotency_key TEXT NOT NULL UNIQUE,
  dispatch_token TEXT UNIQUE,
  dispatch_started_at TEXT,
  coreai_run_id TEXT,
  provider_resource_id TEXT,
  result_json TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  review_note TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  reviewed_at TEXT,
  UNIQUE (task_id, stage, attempt)
);

CREATE INDEX IF NOT EXISTS idx_task_executions_task
  ON task_executions(task_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_active
  ON task_executions(task_id)
  WHERE status IN ('PENDING','DISPATCHING','RUNNING');

CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_entity
  ON task_events(entity_type, entity_id, id);

CREATE TRIGGER IF NOT EXISTS trg_task_events_no_update
BEFORE UPDATE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task events are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_task_events_no_delete
BEFORE DELETE ON task_events
BEGIN
  SELECT RAISE(ABORT, 'task events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_no_delete
BEFORE DELETE ON tasks
BEGIN
  SELECT RAISE(ABORT, 'formal tasks cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_plan_revisions_definition_immutable
BEFORE UPDATE OF payload_json, checksum, schema_version, plan_id, revision
ON task_plan_revisions
WHEN OLD.payload_json IS NOT NEW.payload_json
  OR OLD.checksum IS NOT NEW.checksum
  OR OLD.schema_version IS NOT NEW.schema_version
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.revision IS NOT NEW.revision
BEGIN
  SELECT RAISE(ABORT, 'plan revision definition is immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_plan_revisions_no_delete
BEFORE DELETE ON task_plan_revisions
BEGIN
  SELECT RAISE(ABORT, 'plan revisions cannot be deleted');
END;

-- Core AI Run IDs are global upstream identities.  Keep every new local
-- binding unique across both audit Runs and Task execution history.  Triggers
-- are used instead of adding a UNIQUE column constraint so an existing legacy
-- database can install the guard without rewriting or discarding old rows.
CREATE TRIGGER IF NOT EXISTS trg_runs_coreai_run_id_unique_insert
BEFORE INSERT ON runs
WHEN NEW.coreai_run_id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM runs AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
    OR EXISTS (
      SELECT 1 FROM task_executions AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'core-ai run id already bound');
END;

CREATE TRIGGER IF NOT EXISTS trg_runs_coreai_run_id_unique_update
BEFORE UPDATE OF coreai_run_id ON runs
WHEN NEW.coreai_run_id IS NOT NULL
  AND NEW.coreai_run_id IS NOT OLD.coreai_run_id
  AND (
    EXISTS (
      SELECT 1 FROM runs AS existing
      WHERE existing.id != OLD.id
        AND existing.coreai_run_id = NEW.coreai_run_id
    )
    OR EXISTS (
      SELECT 1 FROM task_executions AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'core-ai run id already bound');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_executions_coreai_run_id_unique_insert
BEFORE INSERT ON task_executions
WHEN NEW.coreai_run_id IS NOT NULL
  AND (
    EXISTS (
      SELECT 1 FROM task_executions AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
    OR EXISTS (
      SELECT 1 FROM runs AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'core-ai run id already bound');
END;

CREATE TRIGGER IF NOT EXISTS trg_task_executions_coreai_run_id_unique_update
BEFORE UPDATE OF coreai_run_id ON task_executions
WHEN NEW.coreai_run_id IS NOT NULL
  AND NEW.coreai_run_id IS NOT OLD.coreai_run_id
  AND (
    EXISTS (
      SELECT 1 FROM task_executions AS existing
      WHERE existing.id != OLD.id
        AND existing.coreai_run_id = NEW.coreai_run_id
    )
    OR EXISTS (
      SELECT 1 FROM runs AS existing
      WHERE existing.coreai_run_id = NEW.coreai_run_id
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'core-ai run id already bound');
END;

CREATE TABLE IF NOT EXISTS seo_ops_agents (
  id TEXT PRIMARY KEY NOT NULL,
  agent_key TEXT NOT NULL,
  coreai_agent_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(sort_order) = 'integer' AND sort_order BETWEEN -10000 AND 10000
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'retired')),
  coreai_name TEXT,
  coreai_model TEXT,
  coreai_timeout_hint_seconds INTEGER CHECK (
    coreai_timeout_hint_seconds IS NULL OR (
      typeof(coreai_timeout_hint_seconds) = 'integer'
      AND coreai_timeout_hint_seconds > 0
    )
  ),
  suspect_after_seconds INTEGER NOT NULL DEFAULT 1800
    CHECK (
      typeof(suspect_after_seconds) = 'integer'
      AND suspect_after_seconds BETWEEN 60 AND 86400
    ),
  last_verification_attempt_at TEXT,
  last_verified_at TEXT,
  last_verification_error TEXT,
  verification_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(verification_failure_count) = 'integer'
    AND verification_failure_count >= 0
  ),
  next_verification_at TEXT,
  metadata_lease_owner TEXT,
  metadata_lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(metadata_lease_epoch) = 'integer' AND metadata_lease_epoch >= 0
  ),
  metadata_lease_until TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (length(trim(agent_key)) BETWEEN 1 AND 80),
  CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  CHECK (length(trim(role)) BETWEEN 1 AND 240),
  CHECK (
    (status = 'retired' AND retired_at IS NOT NULL)
    OR (status <> 'retired' AND retired_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS seo_ops_agent_runs (
  coreai_run_id TEXT PRIMARY KEY NOT NULL,
  seo_ops_agent_id TEXT NOT NULL REFERENCES seo_ops_agents(id),
  raw_status TEXT CHECK (raw_status IS NULL OR length(trim(raw_status)) > 0),
  trigger_type TEXT,
  started_at TEXT,
  completed_at TEXT,
  terminal_observed_at TEXT,
  receipt_expires_at TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  trace_id TEXT,
  error_summary TEXT,
  source_kind TEXT CHECK (
    source_kind IS NULL OR source_kind IN ('run', 'task_execution', 'merchant_seo_artifact')
  ),
  source_local_id INTEGER CHECK (
    source_local_id IS NULL OR (
      typeof(source_local_id) = 'integer' AND source_local_id > 0
    )
  ),
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL CHECK (datetime(first_seen_at) IS NOT NULL),
  last_poll_attempt_at TEXT,
  last_synced_at TEXT,
  last_poll_error TEXT,
  data_warning_codes_json TEXT NOT NULL DEFAULT '[]',
  CHECK (
    (source_kind IS NULL AND source_local_id IS NULL)
    OR (source_kind IS NOT NULL AND source_local_id IS NOT NULL)
  ),
  CHECK ((input_tokens IS NULL) = (output_tokens IS NULL)),
  CHECK (
    input_tokens IS NULL OR (
      typeof(input_tokens) = 'integer' AND input_tokens >= 0
    )
  ),
  CHECK (
    output_tokens IS NULL OR (
      typeof(output_tokens) = 'integer' AND output_tokens >= 0
    )
  ),
  CHECK (
    raw_status IS NOT NULL OR (
      source_kind IS NOT NULL
      AND source_local_id IS NOT NULL
      AND trigger_type IS NULL
      AND started_at IS NULL
      AND completed_at IS NULL
      AND terminal_observed_at IS NULL
      AND receipt_expires_at IS NULL
      AND input_tokens IS NULL
      AND output_tokens IS NULL
      AND trace_id IS NULL
      AND error_summary IS NULL
      AND last_poll_attempt_at IS NULL
      AND last_synced_at IS NULL
      AND last_poll_error IS NULL
    )
  )
);

CREATE TABLE IF NOT EXISTS seo_ops_agent_sync_state (
  seo_ops_agent_id TEXT PRIMARY KEY NOT NULL REFERENCES seo_ops_agents(id),
  remote_total_runs INTEGER CHECK (
    remote_total_runs IS NULL OR (typeof(remote_total_runs) = 'integer' AND remote_total_runs >= 0)
  ),
  last_discovery_attempt_at TEXT,
  last_discovery_success_at TEXT,
  last_discovery_error TEXT,
  last_discovery_returned_count INTEGER CHECK (
    last_discovery_returned_count IS NULL OR (
      typeof(last_discovery_returned_count) = 'integer' AND last_discovery_returned_count >= 0
    )
  ),
  coverage_start_at TEXT,
  finite_range_proven_start_at TEXT CHECK (
    finite_range_proven_start_at IS NULL OR datetime(finite_range_proven_start_at) IS NOT NULL
  ),
  current_state_checked_at TEXT,
  pending_observed_count INTEGER CHECK (
    pending_observed_count IS NULL OR (typeof(pending_observed_count) = 'integer' AND pending_observed_count >= 0)
  ),
  pending_upstream_total INTEGER CHECK (
    pending_upstream_total IS NULL OR (typeof(pending_upstream_total) = 'integer' AND pending_upstream_total >= 0)
  ),
  pending_last_observed_at TEXT,
  pending_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (pending_set_quality IN ('exact', 'lower_bound', 'unknown')),
  running_observed_count INTEGER CHECK (
    running_observed_count IS NULL OR (typeof(running_observed_count) = 'integer' AND running_observed_count >= 0)
  ),
  running_upstream_total INTEGER CHECK (
    running_upstream_total IS NULL OR (typeof(running_upstream_total) = 'integer' AND running_upstream_total >= 0)
  ),
  running_last_observed_at TEXT,
  running_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (running_set_quality IN ('exact', 'lower_bound', 'unknown')),
  paused_observed_count INTEGER CHECK (
    paused_observed_count IS NULL OR (typeof(paused_observed_count) = 'integer' AND paused_observed_count >= 0)
  ),
  paused_upstream_total INTEGER CHECK (
    paused_upstream_total IS NULL OR (typeof(paused_upstream_total) = 'integer' AND paused_upstream_total >= 0)
  ),
  paused_last_observed_at TEXT,
  paused_set_quality TEXT NOT NULL DEFAULT 'unknown'
    CHECK (paused_set_quality IN ('exact', 'lower_bound', 'unknown')),
  unresolved_unknown_status_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(unresolved_unknown_status_count) = 'integer' AND unresolved_unknown_status_count >= 0
  ),
  current_state_complete INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(current_state_complete) = 'integer' AND current_state_complete IN (0, 1)
  ),
  current_state_error TEXT,
  sync_pending INTEGER NOT NULL DEFAULT 1 CHECK (
    typeof(sync_pending) = 'integer' AND sync_pending IN (0, 1)
  ),
  local_event_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(local_event_epoch) = 'integer' AND local_event_epoch >= 0
  ),
  history_event_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(history_event_epoch) = 'integer' AND history_event_epoch >= 0
  ),
  unfiltered_proven_event_epoch INTEGER CHECK (
    unfiltered_proven_event_epoch IS NULL OR (
      typeof(unfiltered_proven_event_epoch) = 'integer'
      AND unfiltered_proven_event_epoch >= 0
      AND unfiltered_proven_event_epoch <= history_event_epoch
    )
  ),
  projection_revision INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(projection_revision) = 'integer' AND projection_revision >= 0
  ),
  next_discovery_at TEXT,
  last_fast_poll_attempt_at TEXT,
  last_fast_poll_success_at TEXT,
  last_fast_poll_error TEXT,
  next_fast_poll_at TEXT,
  discovery_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(discovery_failure_count) = 'integer' AND discovery_failure_count >= 0
  ),
  fast_poll_failure_count INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(fast_poll_failure_count) = 'integer' AND fast_poll_failure_count >= 0
  ),
  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(lease_epoch) = 'integer' AND lease_epoch >= 0
  ),
  lease_until TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_seo_ops_agents_current_key
ON seo_ops_agents(agent_key) WHERE status <> 'retired';

CREATE INDEX IF NOT EXISTS idx_seo_ops_agents_next_verification_at
ON seo_ops_agents(next_verification_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agents_metadata_lease_until
ON seo_ops_agents(metadata_lease_until);

CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_agent_effective_history
ON seo_ops_agent_runs(
  seo_ops_agent_id,
  COALESCE(started_at, first_seen_at) DESC,
  coreai_run_id DESC
);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_raw_status
ON seo_ops_agent_runs(raw_status);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_runs_source
ON seo_ops_agent_runs(source_kind, source_local_id);

CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_next_discovery_at
ON seo_ops_agent_sync_state(next_discovery_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_next_fast_poll_at
ON seo_ops_agent_sync_state(next_fast_poll_at);
CREATE INDEX IF NOT EXISTS idx_seo_ops_agent_sync_lease_until
ON seo_ops_agent_sync_state(lease_until);

CREATE INDEX IF NOT EXISTS idx_task_executions_coreai_run_id
ON task_executions(coreai_run_id) WHERE coreai_run_id IS NOT NULL;

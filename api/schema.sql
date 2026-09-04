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

CREATE TABLE IF NOT EXISTS merchant_fbr_links (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  fbr_merchant_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (sync_status IN ('not_synced','syncing','synced','failed')),
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_merchant_fbr_links_external
  ON merchant_fbr_links(fbr_merchant_id);

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
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','auto')),
  report_text TEXT,
  error TEXT,
  plan_approved_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_merchant ON runs(merchant_id);

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

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  expected_outcome TEXT,
  category TEXT,
  scheduled_start TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done','cancelled')),
  evidence_note TEXT,
  source_run_id INTEGER REFERENCES runs(id),
  source_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_merchant ON tasks(merchant_id);

CREATE TABLE IF NOT EXISTS task_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  coreai_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ready','failed','approved','returned')),
  attempt INTEGER NOT NULL,
  output_text TEXT,
  error TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_executions_task ON task_executions(task_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_active
  ON task_executions(task_id) WHERE status IN ('running','ready');

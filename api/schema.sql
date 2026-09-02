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

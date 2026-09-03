CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

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
  request_json TEXT NOT NULL,
  payload_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_merchant_seo_artifacts_latest
  ON merchant_seo_artifacts(merchant_id, id DESC);

CREATE TABLE IF NOT EXISTS merchant_local_falcon_syncs (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
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
    CHECK (status IN ('PENDING','PREPARING','AWAITING_APPROVAL','NEEDS_ATTENTION','DONE','CANCELLED')),
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

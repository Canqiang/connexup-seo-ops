PRAGMA foreign_keys = ON;

CREATE TABLE merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  notes TEXT,
  primary_location TEXT,
  website_url TEXT,
  auto_run_interval_days INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE merchant_fbr_links (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  fbr_merchant_id TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (sync_status IN ('not_synced','syncing','synced','failed')),
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_merchant_fbr_links_external
  ON merchant_fbr_links(fbr_merchant_id);

CREATE TABLE merchant_gbp_profiles (
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

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  coreai_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual','auto')),
  report_text TEXT,
  error TEXT,
  plan_approved_at TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE audit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES runs(id),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  evidence_mode TEXT NOT NULL,
  finding_count INTEGER NOT NULL,
  source_ref TEXT,
  accepted_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  expected_outcome TEXT,
  category TEXT,
  scheduled_start TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  evidence_note TEXT,
  source_run_id INTEGER REFERENCES runs(id),
  source_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE merchant_local_falcon_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  report_key TEXT NOT NULL,
  place_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  platform TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  center_lat REAL NOT NULL,
  center_lng REAL NOT NULL,
  grid_size INTEGER NOT NULL,
  radius REAL NOT NULL,
  measurement TEXT NOT NULL,
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

INSERT INTO merchants (
  id, name, status, notes, primary_location, website_url,
  auto_run_interval_days, created_at
) VALUES
  (1, 'Legacy Active', 'active', 'migration fixture', 'Flushing, NY',
   'https://example.test', 7, '2024-01-01T00:00:00.000000Z'),
  (2, 'Legacy Archived', 'archived', NULL, 'Queens, NY', NULL, NULL,
   '2024-02-01T00:00:00.000000Z');

INSERT INTO merchant_fbr_links (
  merchant_id, fbr_merchant_id, sync_status, last_synced_at, last_error,
  created_at, updated_at
) VALUES (
  1, 'legacy-fbr-merchant-001', 'synced', '2025-12-31T23:59:59.000000Z', NULL,
  '2024-01-02T00:00:00.000000Z', '2025-12-31T23:59:59.000000Z'
);

INSERT INTO merchant_gbp_profiles (
  id, merchant_id, fbr_merchant_id, gbp_location_id, source_name, source_title,
  normalized_json, source_updated_at, synced_at
) VALUES
  (1, 1, 'legacy-fbr-merchant-001', 'locations/valid-001',
   'Legacy Active', 'Legacy Active',
   '{"performance_metrics":[{"date":"2026-08-01","metric":"CALL_CLICKS","value":3}]}',
   '2026-08-02T00:00:00.000000Z', '2026-08-02T00:05:00.000000Z'),
  (2, 2, 'archived-fbr-002', 'locations/invalid-json-002',
   'Legacy Archived', 'Legacy Archived', '{not-json', NULL,
   '2026-08-02T00:06:00.000000Z');

INSERT INTO runs (
  id, merchant_id, coreai_run_id, status, trigger_kind, report_text,
  plan_approved_at, created_at, finished_at
) VALUES (
  1, 1, 'legacy-run-001', 'succeeded', 'manual', 'legacy audit complete',
  '2026-01-01T01:00:00.000000Z', '2026-01-01T00:00:00.000000Z',
  '2026-01-01T01:00:00.000000Z'
);

INSERT INTO audit_snapshots (
  id, run_id, merchant_id, schema_version, payload_json, evidence_mode,
  finding_count, source_ref, accepted_at
) VALUES (
  1, 1, 1, 'seo_ops.audit_report.v1', '{"findings":[{"id":"legacy-1"}]}',
  'CONFIRMED_FACTS_ONLY', 1, 'legacy-fixture', '2026-01-01T01:00:00.000000Z'
);

INSERT INTO tasks (
  id, merchant_id, title, description, rationale, expected_outcome, category,
  status, evidence_note, source_run_id, source_key, created_at
) VALUES (
  1, 1, 'Preserve legacy task', 'Fixture task', 'Migration evidence',
  'Still present', 'technical', 'done', 'verified', 1, 'legacy-task-001',
  '2026-01-02T00:00:00.000000Z'
);

INSERT INTO merchant_local_falcon_reports (
  id, merchant_id, report_key, place_id, keyword, platform, captured_at,
  center_lat, center_lng, grid_size, radius, measurement, arp, atrp, solv,
  found_in, image_url, heatmap_url, grid_points_json, synced_at
) VALUES (
  1, 1, 'legacy-rank-001', 'ChIJlegacyPlace001', 'restaurant flushing',
  'google', '2026-01-03T00:00:00.000000Z', 40.759, -73.83, 9, 2.0, 'mi',
  4.2, 6.1, 78.5, 72, NULL, NULL, '[{"rank":1}]',
  '2026-01-03T00:05:00.000000Z'
);

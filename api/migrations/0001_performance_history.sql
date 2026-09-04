CREATE TABLE merchant_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL,
  canonical_address TEXT,
  timezone_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','archived','needs_attention')),
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at) = 1),
  UNIQUE (merchant_id, id)
);

CREATE INDEX idx_merchant_locations_merchant
  ON merchant_locations(merchant_id, status, id);

CREATE TRIGGER protect_merchant_location_identity
BEFORE UPDATE ON merchant_locations
WHEN NEW.merchant_id != OLD.merchant_id OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'merchant_location_identity_immutable');
END;

CREATE TABLE merchant_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active','archived')),
  effective_at TEXT NOT NULL CHECK (is_canonical_utc_instant(effective_at) = 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at) = 1),
  UNIQUE (merchant_id, generation)
);

CREATE INDEX idx_merchant_status_events_effective
  ON merchant_status_events(merchant_id, effective_at, generation);

CREATE TRIGGER reject_merchant_status_event_update
BEFORE UPDATE ON merchant_status_events
BEGIN
  SELECT RAISE(ABORT, 'merchant_status_events are append-only');
END;

CREATE TRIGGER reject_merchant_status_event_delete
BEFORE DELETE ON merchant_status_events
WHEN EXISTS (SELECT 1 FROM merchants WHERE id = OLD.merchant_id)
BEGIN
  SELECT RAISE(ABORT, 'merchant_status_events are append-only');
END;

CREATE TABLE merchant_location_status_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_location_id INTEGER NOT NULL REFERENCES merchant_locations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active','archived','needs_attention')),
  timezone_name TEXT,
  metadata_json TEXT NOT NULL,
  effective_at TEXT NOT NULL CHECK (is_canonical_utc_instant(effective_at) = 1),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at) = 1),
  UNIQUE (merchant_location_id, generation)
);

CREATE TRIGGER reject_merchant_location_status_event_update
BEFORE UPDATE ON merchant_location_status_events
BEGIN
  SELECT RAISE(ABORT, 'merchant_location_status_events are append-only');
END;

CREATE TRIGGER reject_merchant_location_status_event_delete
BEFORE DELETE ON merchant_location_status_events
BEGIN
  SELECT RAISE(ABORT, 'merchant_location_status_events are append-only');
END;

DROP INDEX IF EXISTS idx_merchant_fbr_links_external;
ALTER TABLE merchant_fbr_links RENAME TO merchant_fbr_links_legacy;

CREATE TABLE merchant_fbr_binding_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  fbr_merchant_id TEXT NOT NULL,
  canonical_fbr_merchant_sha256 TEXT
    GENERATED ALWAYS AS (fbr_identity_sha256(fbr_merchant_id)) STORED,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  opened_by TEXT NOT NULL,
  open_reason TEXT NOT NULL,
  content_sha256 TEXT GENERATED ALWAYS AS (
    fbr_binding_open_sha256(
      merchant_id, fbr_merchant_id, generation, valid_from, opened_by, open_reason
    )
  ) STORED,
  closed_by TEXT,
  close_reason TEXT,
  close_content_sha256 TEXT GENERATED ALWAYS AS (
    CASE WHEN valid_to IS NULL THEN NULL ELSE
      fbr_binding_close_sha256(id, content_sha256, valid_to, closed_by, close_reason)
    END
  ) STORED,
  created_at TEXT NOT NULL,
  CONSTRAINT fbr_identity_not_canonical
    CHECK (length(fbr_merchant_id) > 0 AND fbr_merchant_id = canonical_fbr_id(fbr_merchant_id)),
  CONSTRAINT canonical_utc_instant_valid_from
    CHECK (is_canonical_utc_instant(valid_from) = 1),
  CONSTRAINT canonical_utc_instant_created_at
    CHECK (is_canonical_utc_instant(created_at) = 1),
  CONSTRAINT canonical_utc_instant_valid_to CHECK (valid_to IS NULL OR (
    is_canonical_utc_instant(valid_to) = 1 AND valid_to > valid_from
  )),
  CHECK (
    (valid_to IS NULL AND closed_by IS NULL AND close_reason IS NULL)
    OR
    (valid_to IS NOT NULL AND length(trim(COALESCE(closed_by, ''))) > 0
                          AND length(trim(COALESCE(close_reason, ''))) > 0)
  ),
  UNIQUE (merchant_id, generation)
);

CREATE UNIQUE INDEX uq_current_merchant_fbr_binding
  ON merchant_fbr_binding_events(merchant_id) WHERE valid_to IS NULL;
CREATE UNIQUE INDEX uq_current_exact_fbr_identity
  ON merchant_fbr_binding_events(fbr_merchant_id) WHERE valid_to IS NULL;
CREATE INDEX idx_fbr_binding_identity_interval
  ON merchant_fbr_binding_events(fbr_merchant_id, valid_from, valid_to);

CREATE TRIGGER validate_fbr_binding_generation_insert
BEFORE INSERT ON merchant_fbr_binding_events
WHEN NEW.generation != 1 + COALESCE((
  SELECT MAX(generation) FROM merchant_fbr_binding_events
  WHERE merchant_id = NEW.merchant_id
), 0)
BEGIN
  SELECT RAISE(ABORT, 'fbr_binding_generation_invalid');
END;

CREATE TRIGGER reject_fbr_binding_interval_overlap_insert
BEFORE INSERT ON merchant_fbr_binding_events
WHEN EXISTS (
  SELECT 1 FROM merchant_fbr_binding_events AS prior
  WHERE prior.merchant_id = NEW.merchant_id
    AND NEW.valid_from < COALESCE(prior.valid_to, '9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to, '9999-12-31T23:59:59.999999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'fbr_binding_interval_overlap');
END;

CREATE TRIGGER reject_fbr_identity_interval_overlap_insert
BEFORE INSERT ON merchant_fbr_binding_events
WHEN EXISTS (
  SELECT 1 FROM merchant_fbr_binding_events AS prior
  WHERE prior.fbr_merchant_id = NEW.fbr_merchant_id
    AND NEW.valid_from < COALESCE(prior.valid_to, '9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to, '9999-12-31T23:59:59.999999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'fbr_identity_interval_overlap');
END;

CREATE TRIGGER protect_fbr_binding_event_update
BEFORE UPDATE ON merchant_fbr_binding_events
WHEN NEW.merchant_id != OLD.merchant_id
  OR NEW.fbr_merchant_id != OLD.fbr_merchant_id
  OR NEW.generation != OLD.generation
  OR NEW.valid_from != OLD.valid_from
  OR NEW.opened_by != OLD.opened_by
  OR NEW.open_reason != OLD.open_reason
  OR NEW.created_at != OLD.created_at
  OR OLD.valid_to IS NOT NULL
  OR NEW.valid_to IS NULL
  OR (is_canonical_utc_instant(NEW.valid_to) = 1 AND NEW.valid_to <= OLD.valid_from)
  OR length(trim(NEW.closed_by)) = 0
  OR length(trim(NEW.close_reason)) = 0
BEGIN
  SELECT RAISE(ABORT, 'fbr_binding_event_immutable');
END;

CREATE TRIGGER reject_fbr_binding_event_delete
BEFORE DELETE ON merchant_fbr_binding_events
BEGIN
  SELECT RAISE(ABORT, 'fbr_binding_event_delete_forbidden');
END;

CREATE TABLE merchant_fbr_link_state (
  merchant_id INTEGER PRIMARY KEY REFERENCES merchants(id) ON DELETE RESTRICT,
  sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (sync_status IN ('not_synced','syncing','synced','failed')),
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIEW merchant_fbr_links AS
SELECT state.merchant_id,
       event.fbr_merchant_id,
       state.sync_status,
       state.last_synced_at,
       state.last_error,
       state.created_at,
       state.updated_at,
       event.id AS binding_event_id
FROM merchant_fbr_link_state AS state
JOIN merchant_fbr_binding_events AS event
  ON event.merchant_id = state.merchant_id AND event.valid_to IS NULL;

CREATE TRIGGER update_merchant_fbr_link_sync_projection
INSTEAD OF UPDATE OF sync_status, last_synced_at, last_error, updated_at
ON merchant_fbr_links
BEGIN
  UPDATE merchant_fbr_link_state
  SET sync_status = NEW.sync_status,
      last_synced_at = NEW.last_synced_at,
      last_error = NEW.last_error,
      updated_at = NEW.updated_at
  WHERE merchant_id = OLD.merchant_id;
END;

CREATE TRIGGER reject_merchant_fbr_projection_identity_update
INSTEAD OF UPDATE OF merchant_id, fbr_merchant_id, binding_event_id
ON merchant_fbr_links
BEGIN
  SELECT RAISE(ABORT, 'cannot modify merchant_fbr_links identity projection');
END;

CREATE TABLE merchant_location_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_location_id INTEGER NOT NULL REFERENCES merchant_locations(id) ON DELETE RESTRICT,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('GOOGLE_PLACE_ID')),
  canonical_value TEXT NOT NULL CHECK (length(trim(canonical_value)) > 0),
  alias_generation INTEGER NOT NULL CHECK (alias_generation >= 1),
  valid_from TEXT NOT NULL CHECK (is_canonical_utc_instant(valid_from) = 1),
  valid_to TEXT CHECK (valid_to IS NULL OR is_canonical_utc_instant(valid_to) = 1),
  verified_source TEXT NOT NULL,
  verified_by TEXT NOT NULL,
  verified_at TEXT NOT NULL CHECK (is_canonical_utc_instant(verified_at) = 1),
  metadata_json TEXT NOT NULL,
  closed_by TEXT,
  close_reason TEXT,
  close_content_sha256 TEXT GENERATED ALWAYS AS (
    CASE WHEN valid_to IS NULL THEN NULL ELSE
      content_sha256(id, alias_type, canonical_value, alias_generation,
                     valid_to, closed_by, close_reason)
    END
  ) STORED,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((valid_to IS NULL AND closed_by IS NULL AND close_reason IS NULL)
      OR (valid_to IS NOT NULL AND length(trim(COALESCE(closed_by, ''))) > 0
                               AND length(trim(COALESCE(close_reason, ''))) > 0)),
  UNIQUE (alias_type, canonical_value, alias_generation),
  UNIQUE (merchant_location_id, alias_type, alias_generation)
);

CREATE UNIQUE INDEX uq_current_location_alias
  ON merchant_location_aliases(alias_type, canonical_value) WHERE valid_to IS NULL;
CREATE INDEX idx_location_alias_location
  ON merchant_location_aliases(merchant_location_id, alias_type, valid_from);

CREATE TRIGGER validate_location_alias_generation_insert
BEFORE INSERT ON merchant_location_aliases
WHEN NEW.alias_generation != 1 + COALESCE((
  SELECT MAX(alias_generation) FROM merchant_location_aliases
  WHERE alias_type=NEW.alias_type AND canonical_value=NEW.canonical_value
), 0)
BEGIN
  SELECT RAISE(ABORT, 'location_alias_generation_invalid');
END;

CREATE TRIGGER reject_location_alias_overlap_insert
BEFORE INSERT ON merchant_location_aliases
WHEN EXISTS (
  SELECT 1 FROM merchant_location_aliases prior
  WHERE prior.alias_type=NEW.alias_type AND prior.canonical_value=NEW.canonical_value
    AND NEW.valid_from < COALESCE(prior.valid_to, '9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to, '9999-12-31T23:59:59.999999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'location_alias_interval_overlap');
END;

CREATE TRIGGER protect_location_alias_update
BEFORE UPDATE ON merchant_location_aliases
WHEN NEW.merchant_location_id != OLD.merchant_location_id
  OR NEW.alias_type != OLD.alias_type OR NEW.canonical_value != OLD.canonical_value
  OR NEW.alias_generation != OLD.alias_generation OR NEW.valid_from != OLD.valid_from
  OR NEW.verified_source != OLD.verified_source OR NEW.verified_by != OLD.verified_by
  OR NEW.verified_at != OLD.verified_at OR OLD.valid_to IS NOT NULL
  OR NEW.valid_to IS NULL OR NEW.valid_to <= OLD.valid_from
  OR is_canonical_utc_instant(NEW.valid_to) != 1
  OR length(trim(COALESCE(NEW.closed_by, ''))) = 0
  OR length(trim(COALESCE(NEW.close_reason, ''))) = 0
BEGIN
  SELECT RAISE(ABORT, 'merchant_location_alias_immutable');
END;

CREATE TRIGGER reject_location_alias_overlap_update
BEFORE UPDATE OF valid_to ON merchant_location_aliases
WHEN EXISTS (
  SELECT 1 FROM merchant_location_aliases prior
  WHERE prior.id!=OLD.id AND prior.alias_type=NEW.alias_type
    AND prior.canonical_value=NEW.canonical_value
    AND NEW.valid_from < COALESCE(prior.valid_to, '9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to, '9999-12-31T23:59:59.999999Z')
)
BEGIN
  SELECT RAISE(ABORT, 'location_alias_interval_overlap');
END;

CREATE TRIGGER reject_location_alias_delete
BEFORE DELETE ON merchant_location_aliases
BEGIN
  SELECT RAISE(ABORT, 'merchant_location_alias_delete_forbidden');
END;

CREATE TABLE merchant_location_alias_evidence_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_location_alias_id INTEGER NOT NULL REFERENCES merchant_location_aliases(id) ON DELETE RESTRICT,
  observed_at TEXT NOT NULL CHECK (is_canonical_utc_instant(observed_at) = 1),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('LEGACY_LOCAL_RANK_REPORT')),
  evidence_reference TEXT NOT NULL,
  evidence_manifest_json TEXT NOT NULL,
  evidence_manifest_sha256 TEXT NOT NULL CHECK (length(evidence_manifest_sha256) = 64),
  confirmed_by TEXT NOT NULL,
  confirmed_at TEXT NOT NULL CHECK (is_canonical_utc_instant(confirmed_at) = 1),
  UNIQUE (merchant_location_alias_id, observed_at, evidence_kind, evidence_reference)
);

CREATE TRIGGER reject_alias_evidence_update BEFORE UPDATE ON merchant_location_alias_evidence_points
BEGIN SELECT RAISE(ABORT, 'merchant_location_alias_evidence_points are append-only'); END;
CREATE TRIGGER reject_alias_evidence_delete BEFORE DELETE ON merchant_location_alias_evidence_points
BEGIN SELECT RAISE(ABORT, 'merchant_location_alias_evidence_points are append-only'); END;

CREATE TABLE source_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  canonical_key TEXT NOT NULL,
  timezone_name TEXT,
  date_basis TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at) = 1),
  CHECK (
    (source = 'GBP' AND scope_type = 'GBP_LOCATION') OR
    (source = 'GSC' AND scope_type = 'GSC_PROPERTY') OR
    (source = 'REVIEWS' AND scope_type = 'REVIEW_LOCATION') OR
    (source = 'LOCAL_FALCON' AND scope_type = 'LOCAL_RANK_COHORT')
  ),
  UNIQUE (source, scope_type, canonical_key)
);

CREATE TRIGGER protect_source_scope_identity
BEFORE UPDATE ON source_scopes
WHEN NEW.source != OLD.source OR NEW.scope_type != OLD.scope_type
  OR NEW.external_id != OLD.external_id OR NEW.canonical_key != OLD.canonical_key
  OR NEW.date_basis != OLD.date_basis OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'source_scope_identity_immutable'); END;
CREATE TRIGGER reject_source_scope_delete BEFORE DELETE ON source_scopes
BEGIN SELECT RAISE(ABORT, 'source_scope_delete_forbidden'); END;

CREATE TABLE source_scope_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_scope_id INTEGER NOT NULL REFERENCES source_scopes(id) ON DELETE RESTRICT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  merchant_location_id INTEGER REFERENCES merchant_locations(id) ON DELETE RESTRICT,
  binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
  valid_from TEXT NOT NULL CHECK (is_canonical_utc_instant(valid_from) = 1),
  valid_to TEXT CHECK (valid_to IS NULL OR is_canonical_utc_instant(valid_to) = 1),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at) = 1),
  closed_by TEXT,
  close_reason TEXT,
  close_content_sha256 TEXT GENERATED ALWAYS AS (
    CASE WHEN valid_to IS NULL THEN NULL ELSE
      content_sha256(id, source_scope_id, merchant_id, merchant_location_id,
                     binding_generation, valid_to, closed_by, close_reason)
    END
  ) STORED,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK ((valid_to IS NULL AND closed_by IS NULL AND close_reason IS NULL)
      OR (valid_to IS NOT NULL AND length(trim(COALESCE(closed_by, ''))) > 0
                               AND length(trim(COALESCE(close_reason, ''))) > 0)),
  UNIQUE (source_scope_id, merchant_id, binding_generation),
  FOREIGN KEY (merchant_id, merchant_location_id)
    REFERENCES merchant_locations(merchant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_location_scope_binding_generation
  ON source_scope_bindings(source_scope_id, binding_generation)
  WHERE merchant_location_id IS NOT NULL;
CREATE INDEX idx_scope_bindings_merchant
  ON source_scope_bindings(merchant_id, merchant_location_id, valid_from);

CREATE TRIGGER validate_source_scope_binding_generation_insert
BEFORE INSERT ON source_scope_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_scopes AS scope WHERE scope.id=NEW.source_scope_id AND (
      (scope.scope_type IN ('GBP_LOCATION','REVIEW_LOCATION','LOCAL_RANK_COHORT')
       AND NEW.binding_generation=1+COALESCE((SELECT MAX(binding_generation)
         FROM source_scope_bindings WHERE source_scope_id=NEW.source_scope_id),0))
      OR
      (scope.scope_type='GSC_PROPERTY'
       AND NEW.binding_generation=1+COALESCE((SELECT MAX(binding_generation)
         FROM source_scope_bindings WHERE source_scope_id=NEW.source_scope_id
           AND merchant_id=NEW.merchant_id),0))
    )
  ) THEN RAISE(ABORT, 'source_scope_binding_generation_invalid') END;
END;

CREATE TRIGGER validate_source_scope_binding_cardinality_insert
BEFORE INSERT ON source_scope_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_scopes AS scope WHERE scope.id=NEW.source_scope_id AND (
      (scope.scope_type IN ('GBP_LOCATION','REVIEW_LOCATION','LOCAL_RANK_COHORT')
       AND NEW.merchant_location_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM merchant_locations location
         WHERE location.id=NEW.merchant_location_id AND location.merchant_id=NEW.merchant_id))
      OR (scope.scope_type='GSC_PROPERTY' AND NEW.merchant_location_id IS NULL)
    )
  ) THEN RAISE(ABORT, 'source_scope_binding_cardinality_invalid') END;
END;

CREATE TRIGGER validate_source_scope_binding_cardinality_update
BEFORE UPDATE OF source_scope_id, merchant_id, merchant_location_id ON source_scope_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM source_scopes AS scope WHERE scope.id=NEW.source_scope_id AND (
      (scope.scope_type IN ('GBP_LOCATION','REVIEW_LOCATION','LOCAL_RANK_COHORT')
       AND NEW.merchant_location_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM merchant_locations location
         WHERE location.id=NEW.merchant_location_id AND location.merchant_id=NEW.merchant_id))
      OR (scope.scope_type='GSC_PROPERTY' AND NEW.merchant_location_id IS NULL)
    )
  ) THEN RAISE(ABORT, 'source_scope_binding_cardinality_invalid') END;
END;

CREATE TRIGGER reject_source_scope_binding_overlap_insert
BEFORE INSERT ON source_scope_bindings
WHEN EXISTS (
  SELECT 1 FROM source_scope_bindings prior JOIN source_scopes scope ON scope.id=prior.source_scope_id
  WHERE prior.source_scope_id=NEW.source_scope_id
    AND (scope.scope_type!='GSC_PROPERTY' OR prior.merchant_id=NEW.merchant_id)
    AND NEW.valid_from < COALESCE(prior.valid_to,'9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to,'9999-12-31T23:59:59.999999Z')
)
BEGIN SELECT RAISE(ABORT, 'source_scope_binding_interval_overlap'); END;

CREATE TRIGGER protect_source_scope_binding_update
BEFORE UPDATE ON source_scope_bindings
WHEN NEW.source_scope_id!=OLD.source_scope_id OR NEW.merchant_id!=OLD.merchant_id
  OR COALESCE(NEW.merchant_location_id,-1)!=COALESCE(OLD.merchant_location_id,-1)
  OR NEW.binding_generation!=OLD.binding_generation OR NEW.valid_from!=OLD.valid_from
  OR NEW.created_by!=OLD.created_by OR NEW.created_at!=OLD.created_at
  OR OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL OR NEW.valid_to<=OLD.valid_from
  OR is_canonical_utc_instant(NEW.valid_to)!=1
  OR length(trim(COALESCE(NEW.closed_by, '')))=0
  OR length(trim(COALESCE(NEW.close_reason, '')))=0
BEGIN SELECT RAISE(ABORT, 'source_scope_binding_immutable'); END;

CREATE TRIGGER reject_source_scope_binding_overlap_update
BEFORE UPDATE OF valid_to ON source_scope_bindings
WHEN EXISTS (
  SELECT 1 FROM source_scope_bindings prior JOIN source_scopes scope ON scope.id=prior.source_scope_id
  WHERE prior.id!=OLD.id AND prior.source_scope_id=NEW.source_scope_id
    AND (scope.scope_type!='GSC_PROPERTY' OR prior.merchant_id=NEW.merchant_id)
    AND NEW.valid_from < COALESCE(prior.valid_to,'9999-12-31T23:59:59.999999Z')
    AND prior.valid_from < COALESCE(NEW.valid_to,'9999-12-31T23:59:59.999999Z')
)
BEGIN SELECT RAISE(ABORT, 'source_scope_binding_interval_overlap'); END;
CREATE TRIGGER reject_source_scope_binding_delete BEFORE DELETE ON source_scope_bindings
BEGIN SELECT RAISE(ABORT, 'source_scope_binding_delete_forbidden'); END;

CREATE TABLE metric_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL CHECK (job_type IN ('daily','backfill','retry','legacy_import')),
  request_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  scope_manifest_json TEXT NOT NULL,
  scope_manifest_sha256 TEXT NOT NULL CHECK (length(scope_manifest_sha256)=64),
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','partial','succeeded','failed','cancelled')),
  batch_count INTEGER NOT NULL DEFAULT 0 CHECK (batch_count>=0),
  completed_batch_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_batch_count>=0),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (requested_by, request_id)
);
CREATE INDEX idx_metric_sync_jobs_status ON metric_sync_jobs(status, created_at);

CREATE TABLE metric_sync_job_merchants (
  job_id INTEGER NOT NULL REFERENCES metric_sync_jobs(id) ON DELETE RESTRICT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  PRIMARY KEY (job_id, merchant_id)
);
CREATE INDEX idx_metric_sync_job_merchants_merchant
  ON metric_sync_job_merchants(merchant_id, job_id);

CREATE TABLE metric_sync_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES metric_sync_jobs(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('GBP','GSC','REVIEWS','LOCAL_FALCON')),
  source_scope_id INTEGER NOT NULL REFERENCES source_scopes(id) ON DELETE RESTRICT,
  partition_month TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt>=1),
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','leased','running','published','retryable','blocked','failed')),
  request_sha256 TEXT,
  response_sha256 TEXT,
  source_cursor TEXT,
  adapter_version TEXT NOT NULL,
  data_through TEXT,
  retrieved_at TEXT,
  error_category TEXT,
  error_summary TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (job_id, source_scope_id, partition_month, attempt)
);
CREATE INDEX idx_metric_sync_batches_lease ON metric_sync_batches(status, lease_expires_at);
CREATE INDEX idx_metric_sync_batches_scope ON metric_sync_batches(source_scope_id, partition_month, attempt);

CREATE TRIGGER protect_metric_sync_batch_transition
BEFORE UPDATE ON metric_sync_batches
WHEN OLD.status IN ('published','retryable','blocked','failed')
  OR (NEW.status!=OLD.status AND NOT (
       (OLD.status='queued' AND NEW.status='leased')
       OR (OLD.status='leased' AND NEW.status IN ('running','published','retryable','blocked','failed'))
       OR (OLD.status='running' AND NEW.status IN ('published','retryable','blocked','failed'))
     ))
BEGIN SELECT RAISE(ABORT, 'metric_sync_batch_transition_invalid'); END;
CREATE TRIGGER protect_metric_sync_batch_identity
BEFORE UPDATE ON metric_sync_batches
WHEN NEW.job_id!=OLD.job_id OR NEW.source!=OLD.source
  OR NEW.source_scope_id!=OLD.source_scope_id
  OR NEW.partition_month!=OLD.partition_month OR NEW.attempt!=OLD.attempt
  OR NEW.adapter_version!=OLD.adapter_version OR NEW.created_at!=OLD.created_at
BEGIN SELECT RAISE(ABORT, 'metric_sync_batch_identity_immutable'); END;
CREATE TRIGGER reject_metric_sync_batch_delete BEFORE DELETE ON metric_sync_batches
BEGIN SELECT RAISE(ABORT, 'metric_sync_batch_delete_forbidden'); END;

CREATE TABLE metric_source_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES metric_sync_batches(id) ON DELETE RESTRICT,
  payload BLOB NOT NULL,
  content_type TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256)=64),
  source_updated_at TEXT,
  saved_at TEXT NOT NULL,
  UNIQUE (batch_id, payload_sha256)
);
CREATE INDEX idx_metric_source_artifacts_batch ON metric_source_artifacts(batch_id, id);
CREATE TRIGGER reject_metric_source_artifact_update BEFORE UPDATE ON metric_source_artifacts
BEGIN SELECT RAISE(ABORT, 'metric_source_artifacts are append-only'); END;
CREATE TRIGGER reject_metric_source_artifact_delete BEFORE DELETE ON metric_source_artifacts
BEGIN SELECT RAISE(ABORT, 'metric_source_artifacts are append-only'); END;

CREATE TABLE metric_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL REFERENCES metric_sync_batches(id) ON DELETE RESTRICT,
  source_scope_id INTEGER NOT NULL REFERENCES source_scopes(id) ON DELETE RESTRICT,
  metric_key TEXT NOT NULL,
  business_date TEXT NOT NULL,
  date_basis TEXT NOT NULL,
  dimension_json TEXT NOT NULL,
  dimension_sha256 TEXT NOT NULL CHECK (length(dimension_sha256)=64),
  logical_key_json TEXT NOT NULL,
  logical_key_sha256 TEXT NOT NULL CHECK (length(logical_key_sha256)=64),
  numeric_value REAL,
  numerator REAL,
  denominator REAL,
  availability TEXT NOT NULL CHECK (availability IN ('available','unavailable','not_applicable')),
  completeness TEXT NOT NULL CHECK (completeness IN ('complete','partial','unknown')),
  source_updated_at TEXT,
  formula_version TEXT NOT NULL,
  published_sequence INTEGER NOT NULL CHECK (published_sequence>=1),
  supersedes_observation_id INTEGER REFERENCES metric_observations(id) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64),
  created_at TEXT NOT NULL,
  UNIQUE (batch_id, source_scope_id, business_date, metric_key, dimension_sha256)
);
CREATE INDEX idx_metric_observations_lookup
  ON metric_observations(source_scope_id, business_date, metric_key);
CREATE INDEX idx_metric_observations_logical ON metric_observations(logical_key_sha256, published_sequence);
CREATE TRIGGER protect_published_metric_observation_update
BEFORE UPDATE ON metric_observations
WHEN EXISTS (SELECT 1 FROM metric_sync_batches WHERE id=OLD.batch_id AND status='published')
BEGIN SELECT RAISE(ABORT, 'published_metric_observation_immutable'); END;
CREATE TRIGGER protect_published_metric_observation_delete
BEFORE DELETE ON metric_observations
WHEN EXISTS (SELECT 1 FROM metric_sync_batches WHERE id=OLD.batch_id AND status='published')
BEGIN SELECT RAISE(ABORT, 'published_metric_observation_immutable'); END;

CREATE TABLE metric_observation_heads (
  logical_key_sha256 TEXT PRIMARY KEY,
  observation_id INTEGER NOT NULL UNIQUE REFERENCES metric_observations(id) ON DELETE RESTRICT,
  head_generation INTEGER NOT NULL CHECK (head_generation>=1),
  updated_at TEXT NOT NULL
);

CREATE TRIGGER validate_metric_observation_head_insert
BEFORE INSERT ON metric_observation_heads
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM metric_observations observation
    JOIN metric_sync_batches batch ON batch.id=observation.batch_id
    WHERE observation.id=NEW.observation_id AND batch.status='published'
  ) THEN RAISE(ABORT, 'head_observation_not_published') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM metric_observations observation
    WHERE observation.id=NEW.observation_id
      AND observation.logical_key_sha256=NEW.logical_key_sha256
  ) THEN RAISE(ABORT, 'head_logical_key_mismatch') END;
  SELECT CASE WHEN NEW.head_generation!=1
    THEN RAISE(ABORT, 'head_generation_invalid') END;
END;

CREATE TRIGGER validate_metric_observation_head_update
BEFORE UPDATE ON metric_observation_heads
BEGIN
  SELECT CASE WHEN NEW.logical_key_sha256!=OLD.logical_key_sha256
    THEN RAISE(ABORT, 'head_logical_key_immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM metric_observations observation
    JOIN metric_sync_batches batch ON batch.id=observation.batch_id
    WHERE observation.id=NEW.observation_id AND batch.status='published'
  ) THEN RAISE(ABORT, 'head_observation_not_published') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM metric_observations observation
    WHERE observation.id=NEW.observation_id
      AND observation.logical_key_sha256=NEW.logical_key_sha256
  ) THEN RAISE(ABORT, 'head_logical_key_mismatch') END;
  SELECT CASE WHEN (
    SELECT published_sequence FROM metric_observations
    WHERE id=NEW.observation_id
  ) <= (
    SELECT published_sequence FROM metric_observations
    WHERE id=OLD.observation_id
  ) THEN RAISE(ABORT, 'head_sequence_not_newer') END;
  SELECT CASE WHEN NEW.head_generation!=OLD.head_generation+1
    THEN RAISE(ABORT, 'head_generation_invalid') END;
END;

CREATE TRIGGER reject_metric_observation_head_delete
BEFORE DELETE ON metric_observation_heads
BEGIN
  SELECT RAISE(ABORT, 'head_delete_forbidden');
END;

CREATE TABLE data_quality_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_scope_id INTEGER REFERENCES source_scopes(id) ON DELETE RESTRICT,
  merchant_id INTEGER REFERENCES merchants(id) ON DELETE RESTRICT,
  merchant_location_id INTEGER REFERENCES merchant_locations(id) ON DELETE RESTRICT,
  start_date TEXT,
  end_date TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','yellow','red')),
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  details_json TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  batch_id INTEGER REFERENCES metric_sync_batches(id) ON DELETE RESTRICT,
  observation_id INTEGER REFERENCES metric_observations(id) ON DELETE RESTRICT
);
CREATE INDEX idx_data_quality_unresolved ON data_quality_events(status, severity, first_seen_at);

CREATE TABLE storage_capacity_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  database_bytes INTEGER NOT NULL CHECK (database_bytes>=0),
  batch_growth_bytes INTEGER NOT NULL CHECK (batch_growth_bytes>=0),
  backup_duration_ms INTEGER NOT NULL CHECK (backup_duration_ms>=0),
  write_lock_failure_count INTEGER NOT NULL CHECK (write_lock_failure_count>=0),
  free_bytes INTEGER,
  sample_reason TEXT NOT NULL,
  measured_at TEXT NOT NULL
);

CREATE TABLE operator_command_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_kind TEXT NOT NULL CHECK (command_kind IN ('RETRY_JOB','GBP_REBIND','FBR_RELINK')),
  requested_by TEXT NOT NULL,
  request_id TEXT NOT NULL,
  command_envelope_json TEXT NOT NULL,
  command_envelope_sha256 TEXT NOT NULL CHECK (length(command_envelope_sha256)=64),
  target_kind TEXT NOT NULL,
  target_stable_id TEXT NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  result_json TEXT NOT NULL,
  result_sha256 TEXT NOT NULL CHECK (length(result_sha256)=64),
  job_id INTEGER REFERENCES metric_sync_jobs(id) ON DELETE RESTRICT,
  source_scope_binding_id INTEGER REFERENCES source_scope_bindings(id) ON DELETE RESTRICT,
  fbr_binding_event_id INTEGER REFERENCES merchant_fbr_binding_events(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (requested_by, request_id),
  CHECK (
    command_kind!='FBR_RELINK'
    OR (http_status BETWEEN 200 AND 299 AND fbr_binding_event_id IS NOT NULL)
    OR (http_status NOT BETWEEN 200 AND 299 AND fbr_binding_event_id IS NULL)
  )
);
CREATE INDEX idx_operator_command_target ON operator_command_ledger(target_kind, target_stable_id, created_at);
CREATE TRIGGER reject_operator_command_update BEFORE UPDATE ON operator_command_ledger
BEGIN SELECT RAISE(ABORT, 'operator_command_ledger is append-only'); END;
CREATE TRIGGER reject_operator_command_delete BEFORE DELETE ON operator_command_ledger
BEGIN SELECT RAISE(ABORT, 'operator_command_ledger is append-only'); END;

CREATE TRIGGER guard_merchants_delete_with_durable_history
BEFORE DELETE ON merchants
WHEN OLD.status!='archived'
  OR EXISTS (SELECT 1 FROM merchant_fbr_binding_events WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_fbr_link_state WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_locations WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM source_scope_bindings WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM metric_sync_job_merchants WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM data_quality_events WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_gbp_profiles WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_seo_artifacts WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_syncs WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_reports WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_approvals WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_scan_confirmations WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_scan_batches WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM merchant_local_falcon_reconciliations WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM audit_snapshots WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM tasks WHERE merchant_id=OLD.id)
  OR EXISTS (SELECT 1 FROM runs WHERE merchant_id=OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'merchant_has_durable_history');
END;

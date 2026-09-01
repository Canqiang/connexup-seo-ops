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

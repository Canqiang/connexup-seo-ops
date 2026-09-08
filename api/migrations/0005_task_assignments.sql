CREATE TABLE task_assignments (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  assignee_type TEXT NOT NULL CHECK (assignee_type IN ('HUMAN', 'AGENT')),
  operator_username TEXT,
  agent_id TEXT REFERENCES seo_ops_agents(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL,
  CHECK (
    (assignee_type = 'HUMAN' AND operator_username IS NOT NULL
      AND length(trim(operator_username)) > 0 AND agent_id IS NULL)
    OR (assignee_type = 'AGENT' AND operator_username IS NULL AND agent_id IS NOT NULL)
  )
);

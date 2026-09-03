# Task Plan Dependencies Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace pre-approved generated Tasks with strict, editable, revisioned Plans that atomically materialize dependency-aware Tasks and support audited operator CRUD.

**Architecture:** Add a strict Plan contract, immutable Plan revisions, a fixed Workflow Template registry, and a one-time SQLite rebuild migration around the existing FastAPI modules. Keep the existing Core AI preparation Agent read-only; Phase 1 changes when Tasks are created, how readiness is computed, and which server-owned transitions are legal, without enabling any new external write.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, SQLite, pytest, React 19, TypeScript 6, React Router, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-generated-task-dependencies-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`; do not modify Core AI, FBR, or Operation Assistant.
- Begin execution from an isolated worktree created with `superpowers:using-git-worktrees`; the current checkout contains unrelated work from other sessions.
- Preserve all unrelated modified and untracked files, especially Dashboard/Performance work and `docs/evidence/`.
- Accept only `schema_version = "seo_ops.task_plan.v1"` for new executable Plans.
- A Plan contains 1–50 Tasks; each Task has at most 20 dependencies; normalized parameters are at most 64 KiB and the normalized Plan is at most 1 MiB.
- Dependencies are hard `AND` dependencies within one logical Plan; reject missing references, self-dependencies, duplicate edges, and cycles.
- Plan revision approval is atomic and binds the exact revision plus SHA-256 checksum.
- `BLOCKED` is derived readiness, never a persisted or client-writable Task state.
- Persisted Task states are `PENDING`, `PREPARING`, `AWAITING_APPROVAL`, `EXECUTING`, `VERIFYING`, `DONE`, `NEEDS_ATTENTION`, and `CANCELLED`.
- Phase 1 enables only `PREPARE_ONLY`; `GBP_POST` remains disabled until Phase 3.
- Formal Tasks are cancelled, never physically deleted; all operator mutations append audit events.
- Keep the existing Preparation Agent capability-free and read-only.
- Do not modify Dashboard or Performance routes, components, styles, or tests.

## File and Responsibility Map

- `api/app/task_plan_contract.py`: strict Plan DTOs, canonical JSON, checksum, dependency validation, and execution-wave calculation.
- `api/app/task_workflows.py`: fixed Task states, enabled template registry, server-owned transitions, and derived readiness.
- `api/app/task_events.py`: one append-only audit-event writer.
- `api/app/task_migrations.py`: idempotent legacy Run/Task/execution conversion and SQLite table rebuild.
- `api/app/task_plans.py`: Plan read, full-draft replacement, rejection, atomic approval, and materialization APIs.
- `api/app/tasks.py`: formal Task query, operator implicit-Plan creation, metadata patch, cancellation, and read-only preparation execution.
- `api/app/runs.py`: prompts the Agent for the strict contract and exposes the Plan through the new Plan resource.
- `api/app/scheduler.py`: persists a valid Plan revision when a Run completes; it no longer materializes Tasks before approval.
- `api/schema.sql`, `api/app/db.py`, `api/app/main.py`: fresh schema, migration registration, and router registration.
- `web/src/taskPlan.ts`: client-side wave projection used only for presentation.
- `web/src/pages/PlanReview.tsx`: per-Task draft editor and atomic Plan decision UI.
- `web/src/pages/RunDetail.tsx`: links to the Plan review instead of treating candidates as formal Tasks.
- `web/src/components/TaskTable.tsx`, `web/src/pages/TaskDetail.tsx`, `web/src/pages/TasksOverview.tsx`: blocker-aware formal Task UI.
- `web/src/api.ts`, `web/src/labels.ts`, `web/src/App.tsx`, `web/src/index.css`: shared contracts, routing, labels, and scoped presentation.

---

### Task 1: Strict Plan contract and dependency validation

**Files:**
- Create: `api/app/task_plan_contract.py`
- Create: `api/tests/test_task_plan_contract.py`

**Interfaces:**
- Consumes: an untrusted Python object or one fenced JSON object returned in a Run report.
- Produces: `validate_task_plan(raw: object, enabled_task_types: set[str]) -> ValidatedTaskPlan`.
- Produces: `extract_task_plan(report_text: object, enabled_task_types: set[str]) -> ValidatedTaskPlan | None`.
- Produces: `ValidatedTaskPlan.payload`, `.canonical_json`, `.checksum`, and `.waves`.

- [ ] **Step 1: Write strict happy-path and normalization tests**

```python
def test_valid_plan_is_canonical_and_sorted_into_waves():
    from app.task_plan_contract import validate_task_plan

    plan = validate_task_plan(
        {
            "schema_version": "seo_ops.task_plan.v1",
            "tasks": [
                {
                    "key": "review",
                    "task_type": "PREPARE_ONLY",
                    "title": "Review content",
                    "rationale": "Catch unsupported claims",
                    "expected_outcome": "A reviewable decision",
                    "depends_on": ["draft"],
                    "parameters": {"description": "Review the prepared copy"},
                },
                {
                    "key": "draft",
                    "task_type": "PREPARE_ONLY",
                    "title": "Draft content",
                    "rationale": "Create the content first",
                    "expected_outcome": "A reviewable draft",
                    "depends_on": [],
                    "parameters": {"description": "Draft one post"},
                },
            ],
        },
        {"PREPARE_ONLY"},
    )

    assert plan.waves == [["draft"], ["review"]]
    assert plan.checksum == __import__("hashlib").sha256(plan.canonical_json.encode()).hexdigest()
    assert plan.canonical_json == __import__("json").dumps(
        plan.payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
```

- [ ] **Step 2: Write rejection-table tests**

```python
@pytest.mark.parametrize(
    "mutate,error_code",
    [
        (lambda p: p.update(extra=True), "unknown_field"),
        (lambda p: p.update(schema_version="seo_ops.task_plan.v0"), "schema_version"),
        (lambda p: p["tasks"][0].update(key="Bad Key"), "task_key"),
        (lambda p: p["tasks"][0].update(task_type="GBP_POST"), "task_type_disabled"),
        (lambda p: p["tasks"][0].update(depends_on=["missing"]), "missing_dependency"),
        (lambda p: p["tasks"][0].update(depends_on=["draft"]), "self_dependency"),
    ],
)
def test_invalid_plan_is_rejected_as_one_revision(valid_plan, mutate, error_code):
    from app.task_plan_contract import TaskPlanValidationError, validate_task_plan

    mutate(valid_plan)
    with pytest.raises(TaskPlanValidationError) as exc:
        validate_task_plan(valid_plan, {"PREPARE_ONLY"})
    assert error_code in exc.value.codes
```

Add separate literal tests for duplicate keys, duplicate edges, a two-node cycle, 51 Tasks, 21 dependencies, a naive `scheduled_start`, parameters above 64 KiB, and a Plan above 1 MiB.
Also assert that a report containing two valid `seo_ops.task_plan.v1` objects is rejected as ambiguous instead of selecting the first one.

- [ ] **Step 3: Run the focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plan_contract.py -q`

Expected: FAIL because `app.task_plan_contract` does not exist.

- [ ] **Step 4: Implement the contract and deterministic topology**

```python
class TaskPlanItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=r"^[a-z0-9_-]{1,80}$")
    task_type: str
    title: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=1, max_length=2000)
    expected_outcome: str = Field(min_length=1, max_length=1000)
    depends_on: list[str] = Field(default_factory=list, max_length=20)
    scheduled_start: AwareDatetime | None = None
    parameters: dict[str, object] = Field(default_factory=dict)


class TaskPlanPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["seo_ops.task_plan.v1"]
    tasks: list[TaskPlanItem] = Field(min_length=1, max_length=50)


class PrepareOnlyParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    description: str | None = Field(default=None, max_length=4000)
    category: Literal["gbp", "content", "review", "citation", "technical", "other"] | None = None


TASK_PARAMETER_MODELS: dict[str, type[BaseModel]] = {
    "PREPARE_ONLY": PrepareOnlyParameters,
}


@dataclass(frozen=True)
class ValidatedTaskPlan:
    payload: dict[str, object]
    canonical_json: str
    checksum: str
    waves: list[list[str]]
```

Validate `parameters` through the exact model in `TASK_PARAMETER_MODELS` before graph validation. Build waves with Kahn's algorithm, selecting zero-indegree keys in their original Plan order so repeat validation produces the same output. Raise `TaskPlanValidationError(codes: list[str])`; never return a partially accepted task list.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plan_contract.py -q`

Expected: PASS.

```bash
git add api/app/task_plan_contract.py api/tests/test_task_plan_contract.py
git commit -m "feat: validate strict task plans"
```

---

### Task 2: Fixed workflow registry and readiness calculation

**Files:**
- Create: `api/app/task_workflows.py`
- Create: `api/tests/test_task_workflows.py`

**Interfaces:**
- Produces: `WorkflowTemplate`, `WORKFLOW_TEMPLATES`, and `enabled_task_types()`.
- Produces: `assert_transition(task_type: str, current: str, target: str) -> None`.
- Produces: `task_blocker(conn, task, now: datetime | None = None) -> dict[str, object] | None`.

- [ ] **Step 1: Write registry, transition, and blocker tests**

```python
def test_phase_one_enables_only_prepare_only():
    from app.task_workflows import enabled_task_types
    assert enabled_task_types() == {"PREPARE_ONLY"}


def test_dependency_blocker_names_the_first_incomplete_upstream(seed_task_graph, db):
    from app.task_workflows import task_blocker
    downstream = db.execute("SELECT * FROM tasks WHERE task_key = 'review'").fetchone()
    assert task_blocker(db, downstream) == {
        "code": "UPSTREAM_NOT_DONE",
        "task_id": seed_task_graph["draft"],
        "task_key": "draft",
        "task_title": "Draft content",
    }
```

Also assert scheduled time, archived merchant, and inactive approved revision blockers; all upstream `DONE` plus elapsed schedule returns `None`; callers cannot transition directly to `DONE`; `PREPARE_ONLY` accepts only the server path `PENDING -> PREPARING -> AWAITING_APPROVAL -> DONE` plus safe cancellation/attention transitions.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_workflows.py -q`

Expected: FAIL because the registry and readiness helper do not exist.

- [ ] **Step 3: Implement immutable templates and ordered blockers**

```python
@dataclass(frozen=True)
class WorkflowTemplate:
    task_type: str
    version: int
    transitions: dict[str, frozenset[str]]
    terminal_after_approval: bool


WORKFLOW_TEMPLATES = {
    "PREPARE_ONLY": WorkflowTemplate(
        task_type="PREPARE_ONLY",
        version=1,
        transitions={
            "PENDING": frozenset({"PREPARING", "NEEDS_ATTENTION", "CANCELLED"}),
            "PREPARING": frozenset({"AWAITING_APPROVAL", "NEEDS_ATTENTION", "CANCELLED"}),
            "AWAITING_APPROVAL": frozenset({"DONE", "PENDING", "NEEDS_ATTENTION", "CANCELLED"}),
            "NEEDS_ATTENTION": frozenset({"PENDING", "CANCELLED"}),
            "DONE": frozenset(),
            "CANCELLED": frozenset(),
        },
        terminal_after_approval=True,
    )
}
```

Evaluate blockers in stable order: merchant archived, revision inactive, future schedule, then incomplete dependencies ordered by dependency row ID. Return only the first blocker to list views.

- [ ] **Step 4: Run focused tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_workflows.py -q`

Expected: PASS.

```bash
git add api/app/task_workflows.py api/tests/test_task_workflows.py
git commit -m "feat: define task workflow readiness"
```

---

### Task 3: Fresh schema and idempotent legacy migration

**Files:**
- Create: `api/app/task_migrations.py`
- Create: `api/app/task_events.py`
- Create: `api/tests/test_task_workflow_migration.py`
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Modify: `api/tests/test_db.py`

**Interfaces:**
- Produces: `migrate_task_workflow_v1(conn: sqlite3.Connection) -> None`.
- Produces: `append_task_event(conn, *, entity_type, entity_id, event_type, actor_type, actor_id, payload) -> int`.
- Creates: `task_plans`, `task_plan_revisions`, `task_dependencies`, `task_events`, rebuilt `tasks`, and rebuilt `task_executions`.

- [ ] **Step 1: Build a real legacy-database migration fixture**

```python
def test_legacy_tasks_are_converted_without_losing_history(legacy_task_db, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(legacy_task_db))
    from app.db import init_db

    init_db()
    conn = sqlite3.connect(legacy_task_db)
    conn.row_factory = sqlite3.Row
    states = {row["source_key"]: row["status"] for row in conn.execute("SELECT * FROM tasks")}
    assert states["manual-todo"] == "PENDING"
    assert states["manual-done"] == "DONE"
    assert states["running"] == "PREPARING"
    assert states["ready"] == "AWAITING_APPROVAL"
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
```

The fixture must also contain an approved Run with two Tasks, an unapproved Run with candidates but no execution, a returned execution, and a failed execution. Assert the unapproved candidates become one `DRAFT` Plan revision and do not remain in `tasks`; ambiguous `doing` rows become `NEEDS_ATTENTION`; running and ready executions remain linked.

- [ ] **Step 2: Run migration tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_workflow_migration.py tests/test_db.py -q`

Expected: FAIL because the new tables, uppercase states, and migration marker are absent.

- [ ] **Step 3: Add fresh-schema tables and constraints**

```sql
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
```

Add a non-unique `(plan_id, checksum)` lookup index and a partial unique index allowing only one `DRAFT` revision per Plan. This permits a user to intentionally return to an older payload in a new revision while making repeated submission of the current draft an idempotent no-op.

Define the rebuilt `tasks` table with `plan_id`, `plan_revision`, `task_key`, `task_type`, `workflow_version`, `parameters_json`, `definition_checksum`, uppercase `status`, `version INTEGER NOT NULL DEFAULT 1`, `assignee`, `labels_json NOT NULL DEFAULT '[]'`, `operator_note`, nullable self-references `replaces_task_id`/`replaced_by_task_id`, and lifecycle timestamps. Materialization binds `workflow_version` from the server registry; an in-flight Task never silently adopts a later template version. Define unique `(plan_id, task_key)`. Define dependencies with unique `(task_id, depends_on_task_id)` and `CHECK(task_id != depends_on_task_id)`. Define append-only events with canonical `payload_json`.

Define rebuilt `task_executions` with these stable columns so later phases extend behavior without another destructive rebuild: `task_id`, `stage IN ('PREPARATION','PUBLICATION','VERIFICATION')`, `status IN ('PENDING','DISPATCHING','RUNNING','SUCCEEDED','FAILED','UNKNOWN','CANCELLED')`, `attempt`, nullable `approval_id`, nullable `artifact_id`, `request_json`, `request_checksum`, `idempotency_key`, `dispatch_token`, `dispatch_started_at`, `coreai_run_id`, `provider_resource_id`, `result_json`, `evidence_json`, `error`, `review_note`, `next_attempt_at`, `created_at`, and `finished_at`. Phase 1 uses only `PREPARATION`; publication/verification values exist for forward-compatible constraints but cannot be reached through the enabled template.

Add `BEFORE UPDATE` and `BEFORE DELETE` abort triggers on `task_events`, a `BEFORE DELETE` abort trigger on formal `tasks`, and revision triggers that reject changes to `payload_json`, `checksum`, `schema_version`, `plan_id`, or `revision` while still permitting controlled decision-state fields to change.

- [ ] **Step 4: Implement a transaction-safe table rebuild**

```python
TASK_WORKFLOW_MIGRATION = "task_workflow_v1"


def migrate_task_workflow_v1(conn: sqlite3.Connection) -> None:
    if _migration_applied(conn, TASK_WORKFLOW_MIGRATION):
        return
    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN IMMEDIATE")
        _create_plan_tables(conn)
        _create_replacement_task_tables(conn)
        _convert_legacy_runs_and_tasks(conn)
        _swap_replacement_tables(conn)
        conn.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            (TASK_WORKFLOW_MIGRATION, now_iso()),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("task workflow migration left broken foreign keys")
```

Before creating replacement tables, inspect the current `tasks` table SQL. A fresh database already containing the uppercase-state schema only receives the migration marker; a legacy lowercase-state database takes the rebuild path. Convert manual Tasks to one approved implicit `OPERATOR` Plan each. Group Run Tasks into one Plan per Run. Materialize approved Run Plans; save unapproved Run rows only inside a normalized draft revision. Map legacy execution states `running -> RUNNING`, `ready/approved -> SUCCEEDED`, and `failed/returned -> FAILED`; copy `output_text` into `result_json`, keep errors/review notes, and derive Task state from both the legacy Task and latest execution. Refuse startup with a clear `RuntimeError` if an unapproved candidate has an execution, because silently dropping its history would violate the design.

- [ ] **Step 5: Register migration and run it twice**

Update `init_db()` so legacy additive columns run first, fresh schema is applied, `migrate_task_workflow_v1()` runs, indexes are recreated, and a second `init_db()` is a no-op. Do not edit the Performance migration entries.

```python
def init_db() -> None:
    Path(db_path()).parent.mkdir(parents=True, exist_ok=True)
    conn = connect()
    try:
        _migrate(conn)
        conn.executescript(SCHEMA_PATH.read_text())
        migrate_task_workflow_v1(conn)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()
```

Run: `cd api && .venv/bin/python -m pytest tests/test_task_workflow_migration.py tests/test_db.py -q`

Expected: PASS, including two consecutive `init_db()` calls and an empty `PRAGMA foreign_key_check`.

- [ ] **Step 6: Commit the migration boundary**

```bash
git add api/schema.sql api/app/db.py api/app/task_migrations.py api/app/task_events.py api/tests/test_db.py api/tests/test_task_workflow_migration.py
git commit -m "feat: migrate revisioned task workflows"
```

---

### Task 4: Persist Agent Plans without pre-creating Tasks

**Files:**
- Create: `api/app/task_plans.py`
- Create: `api/tests/test_task_plans.py`
- Modify: `api/app/runs.py`
- Modify: `api/app/scheduler.py`
- Modify: `api/app/main.py`
- Modify: `api/tests/test_runs_api.py`
- Modify: `api/tests/test_scheduler.py`
- Keep: `api/app/plan_parser.py` as legacy read-only compatibility code.

**Interfaces:**
- Produces: `persist_agent_plan(conn, *, merchant_id, run_id, coreai_run_id, validated) -> sqlite3.Row`.
- Produces: `GET /api/runs/{run_id}/task-plan`.
- Produces: `GET /api/task-plans/{plan_id}` for the editor and Task-detail links.
- Changes: a completed Run stores one draft Plan revision and zero formal Tasks until approval.

- [ ] **Step 1: Write Run prompt and persistence tests**

```python
def test_completed_run_persists_draft_plan_without_tasks(client, fake_coreai):
    run = start_completed_run_with_strict_plan(client, fake_coreai)
    poll_runs_once(fake_coreai)

    response = client.get(f"/api/runs/{run['id']}/task-plan")
    assert response.status_code == 200
    assert response.json()["current_revision"]["decision_state"] == "DRAFT"
    assert client.get(f"/api/runs/{run['id']}/tasks").json() == []
```

Assert repeated polling with the same Run and checksum returns the same Plan/revision. Assert both Plan GET routes return the same current/approved revision view. Assert invalid strict output remains in `runs.report_text`, returns 404 from the Plan endpoint, and creates no Plan or Task. Assert `build_input()` contains `seo_ops.task_plan.v1`, the exact allowed fields, and forbids approval/status/tool IDs.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plans.py tests/test_runs_api.py tests/test_scheduler.py -q`

Expected: FAIL because Run polling still calls `create_tasks_from_plan`.

- [ ] **Step 3: Implement Plan persistence and Run read API**

```python
def persist_agent_plan(conn, *, merchant_id, run_id, coreai_run_id, validated):
    existing = conn.execute(
        "SELECT * FROM task_plans WHERE source_run_id = ?", (run_id,)
    ).fetchone()
    if existing is not None:
        revision = conn.execute(
            "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND checksum = ?",
            (existing["id"], validated.checksum),
        ).fetchone()
        if revision is None:
            raise ValueError("a completed Run cannot replace its original Agent Plan")
        return revision
    # Insert logical Plan plus revision 1 in the caller transaction.
```

Make `poll_runs_once()` call `extract_task_plan(..., enabled_task_types())` and then `persist_agent_plan()`. Catch Plan validation errors only to log a concise summary; retain the raw report. Do not call `create_tasks_from_plan()` for new Runs.

- [ ] **Step 4: Register the router and preserve the legacy parser**

Include `task_plans.router` in `api/app/main.py`. Keep `plan_parser.py` and its tests unchanged for legacy report display and migration only; no new execution path may import `create_tasks_from_plan`.

```python
from .task_plans import router as task_plans_router

app.include_router(task_plans_router, dependencies=operator_dependencies)
```

- [ ] **Step 5: Run focused and backend tests, then commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plans.py tests/test_runs_api.py tests/test_scheduler.py tests/test_plan_parser.py -q`

Expected: PASS.

```bash
git add api/app/task_plans.py api/app/runs.py api/app/scheduler.py api/app/main.py api/tests/test_task_plans.py api/tests/test_runs_api.py api/tests/test_scheduler.py
git commit -m "feat: persist generated task plan drafts"
```

---

### Task 5: Full-draft revision, rejection, and atomic approval APIs

**Files:**
- Modify: `api/app/task_plans.py`
- Modify: `api/tests/test_task_plans.py`

**Interfaces:**
- Produces: `PUT /api/task-plans/{plan_id}/draft` with `{expected_revision, plan}`.
- Produces: `POST /api/task-plans/{plan_id}/approve` with `{revision, checksum}`.
- Produces: `POST /api/task-plans/{plan_id}/reject` with `{expected_revision, reason}`.
- Produces: `materialize_plan_revision(conn, plan, revision, operator) -> list[int]`.

- [ ] **Step 1: Write revision and approval transaction tests**

```python
def test_operator_edits_then_atomically_approves_exact_revision(client, draft_plan):
    edited = client.put(
        f"/api/task-plans/{draft_plan['id']}/draft",
        json={"expected_revision": 1, "plan": two_wave_plan_payload()},
    )
    assert edited.status_code == 200
    revision = edited.json()["current_revision"]

    approved = client.post(
        f"/api/task-plans/{draft_plan['id']}/approve",
        json={"revision": revision["revision"], "checksum": revision["checksum"]},
    )
    assert approved.status_code == 200
    assert [task["task_key"] for task in approved.json()["tasks"]] == ["draft", "review"]
```

Also test stale `expected_revision` and checksum return 409; a cycle returns 422 and creates no revision; approval failure rolls back every Task and edge; every persisted dependency joins two Tasks in the same logical Plan; saving another draft supersedes the previous draft; reverting to an older payload creates a new revision even though its checksum appeared before; a new revision cannot remove or alter a Task already past `PENDING`; approving a new revision cancels removed `PENDING` Tasks, updates retained `PENDING` definitions, inserts new keys, and supersedes the previous approved revision in one transaction.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plans.py -q`

Expected: FAIL on missing draft and decision endpoints.

- [ ] **Step 3: Implement immutable draft replacement**

```python
class DraftPlanBody(BaseModel):
    expected_revision: int = Field(ge=1)
    plan: TaskPlanPayload


@router.put("/task-plans/{plan_id}/draft")
def replace_draft(plan_id: int, body: DraftPlanBody, operator=Depends(require_operator), conn=Depends(get_db)):
    validated = validate_task_plan(body.plan.model_dump(mode="json"), enabled_task_types())
    conn.execute("BEGIN IMMEDIATE")
    # Re-read latest_revision, require equality, insert revision + 1, update pointer, append event, commit.
```

If the exact checksum equals the current draft, return it as an idempotent no-op. Otherwise mark the current draft `SUPERSEDED` and insert the next revision, even when the checksum matches an older approved, rejected, or superseded revision. Never change an earlier revision payload/checksum.

- [ ] **Step 4: Implement atomic approval/materialization**

Within `BEGIN IMMEDIATE`, re-read revision/checksum, revalidate stored payload, compare active Task definitions, then insert/update/cancel Tasks and replace only dependency edges whose downstream Task is still `PENDING`. Insert `PLAN_APPROVED` and per-Task materialization events before one commit. Any mismatch rolls back.

```python
updated = conn.execute(
    "UPDATE task_plan_revisions SET decision_state = 'APPROVED', decided_by = ?, decided_at = ? "
    "WHERE plan_id = ? AND revision = ? AND decision_state = 'DRAFT' AND checksum = ?",
    (operator, now_iso(), plan_id, body.revision, body.checksum),
)
if updated.rowcount != 1:
    raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
```

When a new revision is approved, mark the formerly approved revision `SUPERSEDED`. `reject` marks only the selected draft rejected; set the logical Plan to `REJECTED` only when it has no approved revision. Add `refresh_plan_lifecycle(conn, plan_id)` and call it after terminal Task transitions: a Plan becomes `CLOSED` only when it has no draft and every materialized Task is `DONE` or `CANCELLED`.

- [ ] **Step 5: Run focused tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_plans.py -q`

Expected: PASS.

```bash
git add api/app/task_plans.py api/tests/test_task_plans.py
git commit -m "feat: approve exact task plan revisions"
```

---

### Task 6: Operator Task CRUD, dependency-aware queries, and safe preparation gate

**Files:**
- Modify: `api/app/tasks.py`
- Modify: `api/app/scheduler.py`
- Modify: `api/tests/test_tasks.py`
- Modify: `api/tests/test_scheduler.py`

**Interfaces:**
- Produces: `POST /api/merchants/{merchant_id}/tasks` creating one approved implicit `OPERATOR` Plan, optionally linked by `replaces_task_id`.
- Produces: `GET /api/tasks?merchant_id=&plan_id=&task_type=&status=&readiness=&source_kind=&scheduled_before=&scheduled_after=` and `GET /api/tasks/{task_id}` full dependency detail.
- Produces: `PATCH /api/tasks/{task_id}` for metadata only with `expected_version`.
- Produces: `POST /api/tasks/{task_id}/cancel` with `expected_version` and reason.
- Produces: `POST /api/tasks/{task_id}/retry-preparation` with `expected_version` and reason.
- Keeps: `/execute`, `/approve-execution`, and `/return-execution` as Phase-1 PREPARE_ONLY compatibility actions, all guarded by the template and readiness.

- [ ] **Step 1: Replace legacy CRUD tests with versioned behavior tests**

```python
def test_operator_create_wraps_task_in_an_approved_implicit_plan(client, merchant):
    response = client.post(
        f"/api/merchants/{merchant['id']}/tasks",
        json={
            "task_type": "PREPARE_ONLY",
            "title": "Prepare a review response",
            "rationale": "A response is needed",
            "expected_outcome": "A reviewable response",
            "parameters": {"description": "Draft only; do not publish"},
            "replaces_task_id": None,
        },
    )
    task = response.json()
    assert response.status_code == 201
    assert task["status"] == "PENDING"
    assert task["readiness"] == "READY"
    assert task["plan"]["source_kind"] == "OPERATOR"
    assert task["plan"]["approved_revision"] == 1
```

Add tests for list filters, one blocker in list, all upstream/downstream items in detail, stale metadata patch returning 409, PENDING definition edits rejected with a linkable `plan_id`, active cancellation rules, no delete route, database-level delete rejection, and direct client attempts to write `BLOCKED`/`DONE` returning 422. Assert a cancelled or attention-required upstream leaves its downstream blocked and never auto-cancels it. A replacement must reference a same-merchant `CANCELLED` or safely stopped `NEEDS_ATTENTION` Task, creates a new implicit Plan/Task, and stores both replacement directions without altering the original history.

- [ ] **Step 2: Write execution-gate and state tests**

Assert `/execute` rejects a blocked Task without contacting Core AI; two concurrent execute requests create one Preparation execution; polling success moves `PREPARING -> AWAITING_APPROVAL`; PREPARE_ONLY approval moves to `DONE`, refreshes Plan lifecycle, and unlocks its downstream; return safely resets to `PENDING` with an event because no external write occurred. `retry-preparation` only accepts `NEEDS_ATTENTION` whose latest attempt is stage `PREPARATION`, has no provider resource/write evidence, and is not active; it resets to `PENDING` under compare-and-set. It rejects publication/verification uncertainty.

```python
def test_blocked_task_never_contacts_core_ai(client, blocked_task, fake_coreai):
    response = client.post(f"/api/tasks/{blocked_task['id']}/execute")
    assert response.status_code == 409
    assert response.json()["detail"] == "task is blocked by an upstream task"
    assert fake_coreai.triggered == []


def test_retry_preparation_rejects_publication_uncertainty(client, uncertain_task):
    response = client.post(
        f"/api/tasks/{uncertain_task['id']}/retry-preparation",
        json={"expected_version": uncertain_task["version"], "reason": "retry"},
    )
    assert response.status_code == 409
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_tasks.py tests/test_scheduler.py -q`

Expected: FAIL because Task APIs still accept legacy statuses and have no Plan/version/readiness data.

- [ ] **Step 4: Implement typed Task responses and implicit Plans**

```python
class OperatorTaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_type: Literal["PREPARE_ONLY"]
    title: str = Field(min_length=1, max_length=200)
    rationale: str = Field(min_length=1, max_length=2000)
    expected_outcome: str = Field(min_length=1, max_length=1000)
    scheduled_start: AwareDatetime | None = None
    parameters: dict[str, object] = Field(default_factory=dict)
    replaces_task_id: int | None = Field(default=None, ge=1)


class TaskMetadataPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    assignee: str | None = Field(default=None, max_length=100)
    labels: list[str] | None = Field(default=None, max_length=20)
    operator_note: str | None = Field(default=None, max_length=2000)
```

Create the implicit Plan, approved revision, Task, and events inside one transaction. Compute readiness on reads; do not persist it.

- [ ] **Step 5: Enforce compare-and-set mutations and server transitions**

All writes must include `WHERE id = ? AND version = ?`; increment `version` exactly once per accepted operation. Cancellation calls `assert_transition()` and refuses `EXECUTING`, `VERIFYING`, and `DONE`. Execution rechecks `task_blocker()` under `BEGIN IMMEDIATE` before inserting the unique active Preparation execution.

```python
updated = conn.execute(
    "UPDATE tasks SET operator_note = ?, version = version + 1 "
    "WHERE id = ? AND version = ?",
    (body.operator_note, task_id, body.expected_version),
)
if updated.rowcount != 1:
    conn.rollback()
    raise HTTPException(status_code=409, detail="task changed; refresh and retry")
```

- [ ] **Step 6: Run focused and full backend tests, then commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_tasks.py tests/test_scheduler.py tests/test_task_plans.py -q`

Run: `cd api && .venv/bin/python -m pytest tests -q`

Expected: PASS.

```bash
git add api/app/tasks.py api/app/scheduler.py api/tests/test_tasks.py api/tests/test_scheduler.py
git commit -m "feat: add audited dependency-aware task crud"
```

---

### Task 7: Plan review UI with execution waves and atomic approval

**Files:**
- Create: `web/src/taskPlan.ts`
- Create: `web/src/taskPlan.test.ts`
- Create: `web/src/pages/PlanReview.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/RunDetail.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: `/task-plans/:id`.
- Produces: typed `TaskPlan`, `TaskPlanRevision`, and `TaskPlanItem` API contracts.
- Consumes: full-draft PUT and exact revision/checksum approval APIs from Task 5.

- [ ] **Step 1: Write deterministic wave helper tests**

```typescript
it('groups a valid plan into stable execution waves', () => {
  expect(executionWaves([
    task('review', ['draft']),
    task('publish', ['review']),
    task('draft', []),
  ]).map(wave => wave.map(item => item.key))).toEqual([
    ['draft'], ['review'], ['publish'],
  ])
})
```

Assert the helper throws for missing references and cycles so the UI never silently renders an invalid graph.

- [ ] **Step 2: Write Plan page interaction tests**

Test editing a title, adding/removing a Task, changing dependencies through a labeled multi-select, saving the full draft with `expected_revision`, disabling approval on a local cycle, and approving with the returned revision/checksum. Assert no formal Task rows appear on the Run page before approval.

```typescript
fireEvent.change(screen.getByRole('textbox', { name: '任务标题 draft' }), {
  target: { value: 'Draft the weekly post' },
})
fireEvent.click(screen.getByRole('button', { name: '保存 Plan 草稿' }))
await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
  '/api/task-plans/7/draft',
  expect.objectContaining({ method: 'PUT' }),
))
fireEvent.click(screen.getByRole('button', { name: '批准当前 Plan' }))
```

- [ ] **Step 3: Run UI tests and verify RED**

Run: `cd web && npm test -- --run src/taskPlan.test.ts src/App.test.tsx`

Expected: FAIL because the route, types, and editor do not exist.

- [ ] **Step 4: Add exact API types and calls**

```typescript
export type TaskPlanItem = {
  key: string
  task_type: 'PREPARE_ONLY'
  title: string
  rationale: string
  expected_outcome: string
  depends_on: string[]
  scheduled_start: string | null
  parameters: Record<string, unknown>
}

export type TaskPlanRevision = {
  revision: number
  decision_state: 'DRAFT' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED'
  checksum: string
  payload: { schema_version: 'seo_ops.task_plan.v1'; tasks: TaskPlanItem[] }
}
```

Add `getRunTaskPlan`, `getTaskPlan`, `replaceTaskPlanDraft`, `approveTaskPlan`, and `rejectTaskPlan` methods. Preserve backend error text for 409 refresh prompts.

- [ ] **Step 5: Build the simple wave editor**

Render cards under `第 1 波`, `第 2 波`, and so on. Each dependency control lists only keys in the current draft and excludes the Task itself. Use ordinary inputs/selects and explicit add/remove buttons; do not build a draggable graph. After save, replace local state with the server revision/checksum before enabling approval.

```tsx
{executionWaves(draft.tasks).map((wave, index) => (
  <section key={index} aria-label={`第 ${index + 1} 波`}>
    {wave.map(item => <PlanTaskEditor key={item.key} item={item} allTasks={draft.tasks} />)}
  </section>
))}
```

- [ ] **Step 6: Run focused tests and commit**

Run: `cd web && npm test -- --run src/taskPlan.test.ts src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/taskPlan.ts web/src/taskPlan.test.ts web/src/pages/PlanReview.tsx web/src/api.ts web/src/App.tsx web/src/pages/RunDetail.tsx web/src/App.test.tsx web/src/index.css
git commit -m "feat: add task plan review workspace"
```

---

### Task 8: Blocker-aware Task list/detail UI and Phase-1 verification

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/labels.ts`
- Modify: `web/src/components/TaskTable.tsx`
- Modify: `web/src/pages/TaskDetail.tsx`
- Modify: `web/src/pages/TasksOverview.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`
- Modify: `README.md`

**Interfaces:**
- Consumes: uppercase authoritative Task states, derived readiness, one blocker in lists, and full dependency detail.
- Produces: operator-visible status/blocker copy without a full DAG in the queue.

- [ ] **Step 1: Write list and detail rendering tests**

```typescript
it('shows one blocker in the queue and the full chain in task detail', async () => {
  render(<App />)
  await screen.findByText('被「Draft content」阻塞')
  fireEvent.click(screen.getByRole('link', { name: '查看任务：Review content' }))
  await screen.findByRole('heading', { name: '上游任务' })
  screen.getByRole('link', { name: 'Draft content' })
  screen.getByRole('heading', { name: '下游任务' })
})
```

Also assert `EXECUTING` renders `发布中`, `VERIFYING` renders `验证中`, and no UI offers physical deletion or direct completion.

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because the frontend still models `todo/doing/done/cancelled`.

- [ ] **Step 3: Update contracts, labels, filters, and actions**

```typescript
export type TaskStatus =
  | 'PENDING' | 'PREPARING' | 'AWAITING_APPROVAL' | 'EXECUTING'
  | 'VERIFYING' | 'DONE' | 'NEEDS_ATTENTION' | 'CANCELLED'

export type TaskBlocker = {
  code: 'MERCHANT_ARCHIVED' | 'REVISION_INACTIVE' | 'SCHEDULED_FOR_FUTURE' | 'UPSTREAM_NOT_DONE'
  task_id?: number
  task_key?: string
  task_title?: string
  scheduled_start?: string
}
```

The queue shows only the blocker summary. Task detail shows upstream/downstream links, current Plan revision, stage trail, version, and audit metadata already available in Phase 1. Metadata edit and cancel requests send the current `expected_version` and replace state with server readback.

- [ ] **Step 4: Update operator documentation**

Document the new lifecycle, explain that generated Tasks appear only after Plan approval, and state that Phase 1 still performs no external mutation. Remove the obsolete claim that Run completion directly creates candidate Tasks.

- [ ] **Step 5: Run all quality gates**

Run: `cd api && .venv/bin/python -m pytest tests -q`

Run: `cd web && npm test`

Run: `cd web && npm run lint`

Run: `cd web && npm run build`

Run: `git diff --check`

Expected: every command exits 0.

- [ ] **Step 6: Verify migration and API readback against a copied database**

Copy the configured SQLite database to a temporary path outside the repository, set `SEO_OPS_DB` to that copy, run `init_db()`, and query exact counts for legacy Tasks, Plan revisions, formal Tasks, executions, dependencies, and events. Confirm `PRAGMA foreign_key_check` is empty, unapproved legacy candidates are absent from the formal queue, and running/ready execution rows remain attached to the expected Task IDs.

- [ ] **Step 7: Commit Phase 1 completion**

```bash
git add web/src/api.ts web/src/labels.ts web/src/components/TaskTable.tsx web/src/pages/TaskDetail.tsx web/src/pages/TasksOverview.tsx web/src/App.test.tsx web/src/index.css README.md
git commit -m "feat: present dependency-aware task operations"
```

Do not start Phase 2 until this commit is independently deployable with all external write capabilities still disabled.

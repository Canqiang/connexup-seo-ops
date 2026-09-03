# Task Artifacts and Authorization Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn read-only Agent preparation results into immutable versioned Artifacts and authorize exact Artifacts through either human approval or a deterministic, versioned automation policy.

**Architecture:** Extend the Phase-1 Task workflow with immutable artifact storage, one shared ApprovalGrant model, strict policy contracts, and an orchestrator that automatically prepares ready Tasks. Deterministic server code—not Agent text—validates artifacts, matches policy scope, creates grants, and chooses the next template state; no external publishing capability is enabled in this phase.

**Tech Stack:** Python 3.13, FastAPI, Pydantic, SQLite, pytest, React 19, TypeScript 6, React Router, Vitest, Testing Library, CSS.

**Spec:** `docs/superpowers/specs/2026-09-02-agent-generated-task-dependencies-design.md`

## Global Constraints

- Complete and deploy `docs/superpowers/plans/2026-09-03-task-plan-dependencies-phase-1.md` first.
- Work in an isolated worktree and preserve unrelated Dashboard/Performance changes and `docs/evidence/`.
- Plan approval authorizes preparation only; it never authorizes a future external write.
- Artifact payloads are immutable, canonical JSON with SHA-256; changing content creates a new revision.
- Approval binds `task_id`, exact artifact ID/revision/checksum, merchant, target, operation, grant type, issuer, time, expiry, and revocation state.
- Default mode is per-Artifact human approval.
- An automation policy creates a grant only on complete, unambiguous scope match; missing or ambiguous fields fall back to `AWAITING_APPROVAL`.
- Agents cannot create or edit ApprovalGrants or policies and cannot decide that a Task is complete.
- The existing Preparation Agent remains capability-free and must return `external_write_performed: false`.
- Phase 2 still enables only `PREPARE_ONLY`; `GBP_POST` schemas may be referenced by policy tests but the live template and write path remain disabled until Phase 3.
- Formal history is append-only: old Artifacts, grants, policy versions, attempts, and events are never overwritten or deleted.
- Do not modify Dashboard or Performance files.

## File and Responsibility Map

- `api/app/task_artifacts.py`: artifact schemas, strict parser, canonical persistence, and artifact read helpers.
- `api/app/task_authorization.py`: authorization context, human/policy grant creation, deterministic next-state decision, and grant revocation.
- `api/app/automation_policies.py`: strict policy schema, versioned policy CRUD, exact matcher, and merchant policy API.
- `api/app/task_orchestrator.py`: dependency-aware preparation claim/dispatch and post-preparation authorization resolution.
- `api/app/tasks.py`: Artifact list/detail, approve, return, and reconcile-safe Task response fields.
- `api/app/scheduler.py`: calls the orchestrator and turns completed Preparation runs into validated Artifacts.
- `api/schema.sql`, `api/app/db.py`, `api/app/main.py`: artifact/approval/policy tables, additive migration, and router registration.
- `web/src/pages/TaskDetail.tsx`: Artifact revision, exact approval, return feedback, authorization, and Attempt history.
- `web/src/pages/AutomationPolicies.tsx`: merchant-scoped policy list, version creation, pause, and revoke controls.
- `web/src/api.ts`, `web/src/App.tsx`, `web/src/pages/MerchantDetail.tsx`, `web/src/App.test.tsx`, `web/src/index.css`: typed APIs, routes, navigation, tests, and scoped UI.

---

### Task 1: Artifact, ApprovalGrant, and policy persistence

**Files:**
- Modify: `api/schema.sql`
- Modify: `api/app/db.py`
- Create: `api/tests/test_task_authorization_schema.py`
- Modify: `api/tests/test_db.py`

**Interfaces:**
- Creates: `task_artifacts`, `task_approvals`, and version-row `automation_policies`.
- Extends: `task_executions` only if the Phase-1 table does not yet contain `artifact_id` and `request_checksum`.
- Migrates: legacy Phase-1 `AWAITING_APPROVAL` and `DONE` PREPARE_ONLY results into immutable Artifacts and historical grants when the stored result is valid.

- [ ] **Step 1: Write schema and immutability tests**

```python
def test_authorization_tables_and_constraints(client):
    from app.db import connect

    conn = connect()
    tables = {row["name"] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    )}
    assert {"task_artifacts", "task_approvals", "automation_policies"} <= tables
    assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
```

Seed a Task and assert duplicate `(task_id, revision)` and `(task_id, checksum)` artifacts fail; an active grant cannot be duplicated for the same Task/Artifact/operation; policy `(policy_key, version)` is unique; deleting a Task with any Artifact or grant fails through `ON DELETE RESTRICT`.

Assert database triggers reject Artifact update/delete, policy-version update/delete, and changes to a grant's Task, Artifact, checksum, target, operation, type, issuer, or policy binding. The grant trigger may update only `revoked_at`, `revoked_by`, and `revocation_reason` together.

Seed one Phase-1 `AWAITING_APPROVAL` Task with a valid legacy structured result and one `DONE` Task with an approved result. After migration, assert both have Artifact revision 1; only the historical DONE Task has a `HUMAN` grant issued by `migration:legacy-approved`. Seed malformed legacy output and assert the Task becomes `NEEDS_ATTENTION` with an audit event rather than a fabricated Artifact.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_authorization_schema.py tests/test_db.py -q`

Expected: FAIL because the authorization tables do not exist.

- [ ] **Step 3: Add exact fresh-schema tables**

```sql
CREATE TABLE IF NOT EXISTS task_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  execution_id INTEGER NOT NULL REFERENCES task_executions(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  schema_version TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, revision),
  UNIQUE (task_id, checksum)
);

CREATE TABLE IF NOT EXISTS automation_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','PAUSED','REVOKED')),
  schema_version TEXT NOT NULL CHECK (schema_version = 'seo_ops.automation_policy.v1'),
  payload_json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  supersedes_id INTEGER REFERENCES automation_policies(id) ON DELETE RESTRICT,
  UNIQUE (policy_key, version)
);

CREATE TABLE IF NOT EXISTS task_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  artifact_id INTEGER NOT NULL REFERENCES task_artifacts(id) ON DELETE RESTRICT,
  artifact_revision INTEGER NOT NULL,
  artifact_checksum TEXT NOT NULL CHECK (length(artifact_checksum) = 64),
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  operation TEXT NOT NULL,
  target_json TEXT NOT NULL,
  grant_type TEXT NOT NULL CHECK (grant_type IN ('HUMAN','POLICY')),
  granted_by TEXT NOT NULL,
  policy_id INTEGER REFERENCES automation_policies(id) ON DELETE RESTRICT,
  policy_version INTEGER,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revocation_reason TEXT,
  CHECK (
    (grant_type = 'HUMAN' AND policy_id IS NULL AND policy_version IS NULL)
    OR
    (grant_type = 'POLICY' AND policy_id IS NOT NULL AND policy_version IS NOT NULL)
  )
);
```

Create `automation_policies` before `task_approvals` so the policy foreign key resolves cleanly. Add merchant/status indexes. Add a partial unique index preventing two unrevoked grants for the same `(task_id, artifact_id, operation)`.

- [ ] **Step 4: Add an idempotent additive migration**

```python
AUTHORIZATION_MIGRATION = "task_authorization_v1"


def _migrate_task_authorization(conn: sqlite3.Connection) -> None:
    if _migration_applied(conn, AUTHORIZATION_MIGRATION):
        return
    conn.executescript(AUTHORIZATION_TABLE_SQL)
    conn.execute(
        "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        (AUTHORIZATION_MIGRATION, now_iso()),
    )
```

After table creation, adapt only valid legacy result objects with keys `outcome`, `summary`, `artifact_refs`, `evidence`, and `external_write_performed=false` into `seo_ops.preparation_artifact.v1`. For historical DONE rows, bind the exact migrated Artifact in a grant whose `granted_at` and `expires_at` equal the legacy review timestamp; it is historical evidence, not a reusable authorization. Keep this conversion in the migration module without importing the FastAPI router or opening a second database connection. Do not rebuild Phase-1 tables unless a missing execution column requires it. Run `init_db()` twice and require the same table/index counts and Artifact/grant counts.

- [ ] **Step 5: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_authorization_schema.py tests/test_db.py -q`

Expected: PASS.

```bash
git add api/schema.sql api/app/db.py api/tests/test_task_authorization_schema.py api/tests/test_db.py
git commit -m "feat: persist task artifacts and grants"
```

---

### Task 2: Strict immutable Artifact creation from Preparation runs

**Files:**
- Create: `api/app/task_artifacts.py`
- Create: `api/tests/test_task_artifacts.py`
- Modify: `api/app/execution_result.py`
- Modify: `api/app/tasks.py`
- Modify: `api/app/scheduler.py`
- Modify: `api/tests/test_tasks.py`
- Modify: `api/tests/test_scheduler.py`

**Interfaces:**
- Produces: `CanonicalArtifact(payload, canonical_json, checksum, schema_version)`.
- Produces: `parse_preparation_artifact(task_type: str, raw: object) -> CanonicalArtifact`.
- Produces: `persist_artifact(conn, *, task, execution, artifact, creator) -> sqlite3.Row`.
- Changes: successful Preparation polling stores an Artifact and transitions the Task to `AWAITING_APPROVAL` in one transaction.

- [ ] **Step 1: Write parser and persistence tests**

```python
def test_prepare_only_result_becomes_a_canonical_artifact():
    from app.task_artifacts import parse_preparation_artifact

    artifact = parse_preparation_artifact("PREPARE_ONLY", {
        "schema_version": "seo_ops.preparation_artifact.v1",
        "summary": "Prepared a response draft",
        "artifact_refs": ["artifact://response-v1"],
        "evidence": ["Based on the persisted review"],
        "external_write_performed": False,
    })
    assert artifact.payload["external_write_performed"] is False
    assert len(artifact.checksum) == 64
```

Reject unknown fields, empty summary, non-string references/evidence, no evidence and no reference, `external_write_performed` missing/true, unsupported task type, and payloads above 64 KiB. Assert identical output for the same Task is an idempotent readback of the existing artifact rather than a second revision. When revision 2 is created, any unrevoked grant for revision 1 is revoked with reason `ARTIFACT_SUPERSEDED`; the historical grant row remains readable but can no longer authorize progress.

- [ ] **Step 2: Write atomic scheduler tests**

Assert a completed valid Preparation run updates execution to `SUCCEEDED`, inserts artifact revision 1, attaches `artifact_id`, transitions `PREPARING -> AWAITING_APPROVAL`, increments Task version, and appends events in one commit. Invalid output sets execution `FAILED`, moves Task to `NEEDS_ATTENTION`, and creates no artifact.

```python
def test_valid_preparation_result_and_state_commit_together(preparing_task, fake_coreai, client):
    fake_coreai.complete(preparing_task["coreai_run_id"], VALID_PREPARATION_ARTIFACT)
    poll_task_executions_once(fake_coreai)
    detail = client.get(f"/api/tasks/{preparing_task['id']}").json()
    assert detail["status"] == "AWAITING_APPROVAL"
    assert detail["current_artifact"]["revision"] == 1
    assert detail["executions"][-1]["status"] == "SUCCEEDED"
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_artifacts.py tests/test_scheduler.py -q`

Expected: FAIL because preparation output is still stored as mutable `output_text` only.

- [ ] **Step 4: Implement the Artifact schema registry**

```python
class PrepareOnlyArtifact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["seo_ops.preparation_artifact.v1"]
    summary: str = Field(min_length=1, max_length=4000)
    artifact_refs: list[str] = Field(default_factory=list, max_length=50)
    evidence: list[str] = Field(default_factory=list, max_length=100)
    external_write_performed: Literal[False]


ARTIFACT_MODELS: dict[str, type[BaseModel]] = {
    "PREPARE_ONLY": PrepareOnlyArtifact,
}
```

Serialize with `ensure_ascii=False`, `sort_keys=True`, and compact separators. Derive the next revision under `BEGIN IMMEDIATE`; on an existing checksum return the existing row without changing history.

Update `build_execution_input()` to require one `seo_ops.preparation_artifact.v1` JSON object with the exact fields above. Parse either a raw object or one fenced JSON object; reject prose plus multiple candidate objects as ambiguous.

- [ ] **Step 5: Persist Artifact and state atomically**

In `poll_task_executions_once()`, re-read both execution and Task under a write transaction before accepting output. Require stage `PREPARATION`, execution `RUNNING`, and Task `PREPARING`. Insert/pick the Artifact, mark execution `SUCCEEDED`, update Task with compare-and-set, and append `ARTIFACT_CREATED` plus `TASK_STATE_CHANGED` events before commit.

```python
changed = conn.execute(
    "UPDATE tasks SET status = 'AWAITING_APPROVAL', version = version + 1 "
    "WHERE id = ? AND status = 'PREPARING' AND version = ?",
    (task["id"], task["version"]),
)
if changed.rowcount != 1:
    conn.rollback()
    raise RuntimeError("task changed while its artifact was being persisted")
```

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_artifacts.py tests/test_scheduler.py tests/test_tasks.py -q`

Expected: PASS.

```bash
git add api/app/task_artifacts.py api/app/execution_result.py api/app/tasks.py api/app/scheduler.py api/tests/test_task_artifacts.py api/tests/test_tasks.py api/tests/test_scheduler.py
git commit -m "feat: persist immutable preparation artifacts"
```

---

### Task 3: Exact human Artifact approval and return flow

**Files:**
- Create: `api/app/task_authorization.py`
- Create: `api/tests/test_task_authorization.py`
- Modify: `api/app/tasks.py`
- Modify: `api/app/task_workflows.py`
- Modify: `api/tests/test_tasks.py`
- Modify: `api/tests/test_task_workflows.py`

**Interfaces:**
- Produces: `AuthorizationContext` and `create_human_grant(...) -> sqlite3.Row`.
- Extends: `WorkflowTemplate` with `operation: str` and `policy_authorizable: bool`.
- Produces: `POST /api/tasks/{task_id}/approve-artifact`.
- Produces: `POST /api/tasks/{task_id}/return-artifact`.
- Produces: `GET /api/tasks/{task_id}/artifacts` and Artifact/grant data in Task detail.
- Extends: `GET /api/tasks` with `grant_type=HUMAN|POLICY|NONE` and `needs_attention=true|false` filters.

- [ ] **Step 1: Write exact-binding approval tests**

```python
def test_human_approval_binds_exact_artifact_and_completes_prepare_only(client, awaiting_task):
    artifact = awaiting_task["artifacts"][0]
    response = client.post(
        f"/api/tasks/{awaiting_task['id']}/approve-artifact",
        json={
            "expected_version": awaiting_task["version"],
            "artifact_revision": artifact["revision"],
            "artifact_checksum": artifact["checksum"],
        },
    )
    assert response.status_code == 200
    assert response.json()["task"]["status"] == "DONE"
    assert response.json()["approval"]["grant_type"] == "HUMAN"
```

Assert stale Task version, stale artifact revision/checksum, wrong merchant/target, expired Task context, archived merchant, and a second approval fail closed. Assert `PREPARE_ONLY` operation is exactly `COMPLETE_PREPARATION` and target is the Task itself. Assert list filters distinguish human grants, policy grants, no grant, and attention-required Tasks without dropping historical rows.

- [ ] **Step 2: Write return/revision tests**

Return requires a non-empty reason and exact current artifact. It appends `ARTIFACT_RETURNED`, keeps the old Artifact immutable, transitions safely to `PENDING`, and places feedback in the next Preparation Agent input. The next valid output becomes artifact revision 2 and requires a new approval.

```python
def test_return_keeps_revision_one_and_requires_revision_two_approval(client, awaiting_task):
    first = awaiting_task["current_artifact"]
    returned = client.post(
        f"/api/tasks/{awaiting_task['id']}/return-artifact",
        json={
            "expected_version": awaiting_task["version"],
            "artifact_revision": first["revision"],
            "artifact_checksum": first["checksum"],
            "reason": "Remove the unsupported claim",
        },
    )
    assert returned.json()["task"]["status"] == "PENDING"
    assert client.get(f"/api/tasks/{awaiting_task['id']}/artifacts").json()[0]["id"] == first["id"]
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_authorization.py tests/test_tasks.py -q`

Expected: FAIL because only the legacy execution approval endpoint exists.

- [ ] **Step 4: Implement shared authorization context and human grant**

```python
@dataclass(frozen=True)
class AuthorizationContext:
    task_id: int
    artifact_id: int
    artifact_revision: int
    artifact_checksum: str
    merchant_id: int
    task_type: str
    operation: str
    target: dict[str, object]


def create_human_grant(conn, *, context: AuthorizationContext, operator: str, expires_at: str):
    return _insert_grant(
        conn,
        context=context,
        grant_type="HUMAN",
        granted_by=operator,
        policy=None,
        expires_at=expires_at,
    )
```

Derive context from persisted Task/Artifact/template data only. For Phase-2 `PREPARE_ONLY`, use a 24-hour grant expiry and transition to `DONE` inside the same transaction. Never trust operation or target from the request body.

Set `PREPARE_ONLY.operation = "COMPLETE_PREPARATION"` and `policy_authorizable = False`. Phase 3 will register `GBP_POST` with `operation = "CREATE_GBP_POST"` and `policy_authorizable = True`.

- [ ] **Step 5: Replace legacy review APIs**

Remove frontend use of `/approve-execution` and `/return-execution`. Keep backend compatibility routes only as HTTP 410 responses naming the new Artifact endpoints for one release; they must never create a grant or transition a Task.

```python
@router.post("/tasks/{task_id}/approve-execution", status_code=410)
def legacy_approve_execution(task_id: int):
    raise HTTPException(status_code=410, detail=f"use /api/tasks/{task_id}/approve-artifact")
```

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_authorization.py tests/test_tasks.py tests/test_scheduler.py -q`

Expected: PASS.

```bash
git add api/app/task_authorization.py api/app/tasks.py api/app/task_workflows.py api/tests/test_task_authorization.py api/tests/test_tasks.py api/tests/test_task_workflows.py
git commit -m "feat: approve exact task artifacts"
```

---

### Task 4: Versioned automation-policy contract and exact matcher

**Files:**
- Create: `api/app/automation_policies.py`
- Create: `api/tests/test_automation_policies.py`
- Modify: `api/app/main.py`
- Modify: `api/tests/conftest.py`

**Interfaces:**
- Produces: `AutomationPolicyPayload` with schema `seo_ops.automation_policy.v1`.
- Produces: `match_automation_policy(conn, context, artifact_payload, now) -> sqlite3.Row | None`.
- Produces: list/create-version/pause/revoke merchant policy APIs.
- Produces: `GET /api/merchants/{merchant_id}/automation-policies` response `{policies, capabilities}` where Phase 2 always reports `capabilities.gbp_post_enabled=false` and `capabilities.can_activate=false`.

- [ ] **Step 1: Write strict policy contract tests**

```python
VALID_POLICY = {
    "schema_version": "seo_ops.automation_policy.v1",
    "task_type": "GBP_POST",
    "operation": "CREATE_GBP_POST",
    "location_ids": ["locations/123"],
    "allowed_cta_types": ["LEARN_MORE", "ORDER"],
    "require_media": True,
    "max_summary_chars": 1500,
    "max_grants_per_day": 2,
    "valid_from": "2026-09-03T00:00:00Z",
    "expires_at": "2026-10-03T00:00:00Z",
}
```

Reject unknown fields, empty locations, duplicate locations/CTA types, unsupported operation, naive dates, `expires_at <= valid_from`, non-positive/daily limit above 100, and summary limit above 1500.

- [ ] **Step 2: Write exact-match and fallback tests**

Assert a match requires same merchant, task type, operation, location, allowed CTA, media requirement, summary length, active current version, current time window, and unused daily quota. For every missing/ambiguous field return `None`; never partially match. Assert the oldest matching policy by `policy_key` is selected deterministically if two valid policies have identical scope.

```python
@pytest.mark.parametrize(
    "change",
    [
        {"merchant_id": 999},
        {"operation": "UPDATE_GBP_POST"},
        {"target": {"location_id": "locations/other"}},
        {"artifact": {**VALID_GBP_ARTIFACT, "media": []}},
    ],
)
def test_policy_mismatch_falls_back_to_human(policy_db, authorization_context, change):
    context, artifact = apply_policy_test_change(authorization_context, change)
    assert match_automation_policy(policy_db, context, artifact, NOW) is None
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_automation_policies.py -q`

Expected: FAIL because the policy module and endpoints do not exist.

- [ ] **Step 4: Implement immutable version CRUD**

```python
class AutomationPolicyPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["seo_ops.automation_policy.v1"]
    task_type: Literal["GBP_POST"]
    operation: Literal["CREATE_GBP_POST"]
    location_ids: list[str] = Field(min_length=1, max_length=50)
    allowed_cta_types: list[Literal["NONE", "LEARN_MORE", "ORDER", "SIGN_UP"]] = Field(min_length=1, max_length=4)
    require_media: bool
    max_summary_chars: int = Field(ge=1, le=1500)
    max_grants_per_day: int = Field(ge=1, le=100)
    valid_from: AwareDatetime
    expires_at: AwareDatetime
```

`POST /api/merchants/{merchant_id}/automation-policies` creates version 1 in `PAUSED` state while `GBP_POST` is disabled. `POST /api/automation-policies/{policy_key}/versions` creates the next immutable `PAUSED` version with `expected_version`. Pause/revoke operations create a new version-row state; they do not update historical rows. Activation is intentionally absent until Phase 3 can gate it on complete publishing configuration.

The list endpoint returns the complete current-version policy rows plus a server-owned capability object:

```python
return {
    "policies": serialize_current_policy_versions(rows),
    "capabilities": {
        "gbp_post_enabled": False,
        "can_activate": False,
    },
}
```

- [ ] **Step 5: Implement deterministic matching and policy grants**

Count `POLICY` grants using the exact policy ID/version and UTC calendar day. Match only the latest `ACTIVE` version per policy key. Keep `match_automation_policy()` a pure persisted-scope check; the orchestrator separately requires an enabled Workflow Template with `policy_authorizable=True` before it may turn a match into a grant. In Phase 2, `PREPARE_ONLY` is false and `GBP_POST` is disabled, so no stored policy can advance a Task.

```python
def resolve_artifact_authorization(conn, task, artifact, now):
    template = workflow_template(task["task_type"], task["workflow_version"])
    if not template.policy_authorizable:
        return None
    context = authorization_context(conn, task, artifact)
    policy = match_automation_policy(conn, context, artifact.payload, now)
    return create_policy_grant(conn, context=context, policy=policy, now=now) if policy else None
```

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_automation_policies.py tests/test_auth.py -q`

Expected: PASS.

```bash
git add api/app/automation_policies.py api/app/main.py api/tests/test_automation_policies.py api/tests/conftest.py
git commit -m "feat: add versioned task automation policies"
```

---

### Task 5: Automatic read-only preparation and authorization resolution

**Files:**
- Create: `api/app/task_orchestrator.py`
- Create: `api/tests/test_task_orchestrator.py`
- Modify: `api/app/scheduler.py`
- Modify: `api/app/tasks.py`
- Modify: `api/tests/test_scheduler.py`

**Interfaces:**
- Produces: `claim_preparation_task(conn, now) -> PreparationClaim | None`.
- Produces: `dispatch_preparation_once(client, llm_call_id) -> int`.
- Produces: `resolve_artifact_authorization(conn, task_id, artifact_id, now) -> sqlite3.Row | None`.
- Changes: scheduler automatically prepares ready PENDING Tasks; matching policies can create grants, otherwise Tasks wait for a human.

- [ ] **Step 1: Write claim concurrency and ordering tests**

```python
def test_two_workers_claim_only_one_ready_task(seeded_ready_task):
    with ThreadPoolExecutor(max_workers=2) as pool:
        claims = list(pool.map(lambda _: claim_from_new_connection(), range(2)))
    assert sum(claim is not None for claim in claims) == 1
```

Assert blocked/future/archived Tasks are skipped; ordering is `scheduled_start NULLS FIRST`, then ID; one active Preparation execution blocks another claim; capability verification happens before remote trigger; a trigger failure records `FAILED` or `UNKNOWN` according to whether Core AI acknowledged a run.

- [ ] **Step 2: Write automatic/fallback authorization tests**

Assert the resolver requires `template.policy_authorizable=True` before calling the matcher. In Phase 2, exact stored GBP policy scope still cannot create a grant because `GBP_POST` is disabled; expired/paused/ambiguous/quota-exhausted policies also create no grant. `PREPARE_ONLY` always stays `AWAITING_APPROVAL` for human review. Phase 3 adds the first enabled policy-authorizable template and its end-to-end policy-grant test.

```python
def test_prepare_only_never_auto_grants(prepared_task, db):
    grant = resolve_artifact_authorization(
        db, prepared_task.task, prepared_task.artifact, prepared_task.now
    )
    assert grant is None
    assert db.execute("SELECT status FROM tasks WHERE id = ?", (prepared_task.task["id"],)).fetchone()[0] == "AWAITING_APPROVAL"
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_orchestrator.py tests/test_scheduler.py -q`

Expected: FAIL because Tasks are currently dispatched only from an operator endpoint.

- [ ] **Step 4: Implement database claim and shared dispatch**

```python
def claim_preparation_task(conn, now: datetime) -> PreparationClaim | None:
    conn.execute("BEGIN IMMEDIATE")
    for task in _pending_candidates(conn, now):
        if task_blocker(conn, task, now) is not None:
            continue
        changed = conn.execute(
            "UPDATE tasks SET status = 'PREPARING', version = version + 1, started_at = COALESCE(started_at, ?) "
            "WHERE id = ? AND status = 'PENDING' AND version = ?",
            (now.isoformat(), task["id"], task["version"]),
        )
        if changed.rowcount == 1:
            return _insert_preparation_execution_and_commit(conn, task, now)
    conn.commit()
    return None
```

Use the same dispatcher from the manual `/execute` compatibility action and scheduler. Do not hold a SQLite transaction open during Core AI network calls.

- [ ] **Step 5: Wire scheduler phases**

On each tick: recover stale local dispatches, poll existing Run and Task executions, then dispatch at most one ready Preparation Task. If Core AI is not configured, database-only recovery still runs and no Task state changes. After Artifact persistence, call `resolve_artifact_authorization()` in the same transaction.

```python
if client is not None:
    poll_runs_once(client)
    poll_task_executions_once(client)
    if settings.preparation_llm_call_id is not None:
        dispatch_preparation_once(client, settings.preparation_llm_call_id)
```

- [ ] **Step 6: Run tests and commit**

Run: `cd api && .venv/bin/python -m pytest tests/test_task_orchestrator.py tests/test_scheduler.py tests/test_tasks.py -q`

Expected: PASS.

```bash
git add api/app/task_orchestrator.py api/app/scheduler.py api/app/tasks.py api/tests/test_task_orchestrator.py api/tests/test_scheduler.py
git commit -m "feat: automate safe task preparation"
```

---

### Task 6: Artifact review and automation-policy UI

**Files:**
- Create: `web/src/pages/AutomationPolicies.tsx`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/pages/MerchantDetail.tsx`
- Modify: `web/src/pages/TaskDetail.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: `/merchants/:id/automation` and a merchant navigation link labeled `自动化托管`.
- Consumes: Artifact, ApprovalGrant, Attempt, and policy APIs from Tasks 3–5.

- [ ] **Step 1: Write Task Artifact review UI tests**

Assert Task detail renders artifact revision/checksum, summary, references/evidence, attempt number, and `人工审批` or `托管策略 vN`. Clicking approval sends exact Task version plus artifact revision/checksum. Returning requires a reason. After any mutation, UI uses the response body/readback rather than optimistic completion.

```typescript
fireEvent.click(screen.getByRole('button', { name: '批准当前内容' }))
await waitFor(() => expect(JSON.parse(String(approvalCall?.[1]?.body))).toEqual({
  expected_version: 4,
  artifact_revision: 2,
  artifact_checksum: 'a'.repeat(64),
}))
```

- [ ] **Step 2: Write policy UI tests**

Assert the page shows policy scope, locations, CTA types, media requirement, quota, effective window, current version, and status. Creating a policy version sends the complete payload; pause and revoke require the current version and update from server readback. Show `GBP_POST 尚未启用` while Phase 3 is absent.

```typescript
fireEvent.click(screen.getByRole('button', { name: '暂停托管策略' }))
await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
  '/api/automation-policies/weekly-post/pause',
  expect.objectContaining({ method: 'POST', body: JSON.stringify({ expected_version: 2 }) }),
))
```

- [ ] **Step 3: Run focused tests and verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: FAIL because Task detail still reviews execution text and no policy page exists.

- [ ] **Step 4: Add exact frontend contracts and actions**

```typescript
export type TaskArtifact = {
  id: number
  task_id: number
  revision: number
  schema_version: string
  payload: Record<string, unknown>
  checksum: string
  created_by: string
  created_at: string
}

export type ApprovalGrant = {
  id: number
  grant_type: 'HUMAN' | 'POLICY'
  operation: string
  artifact_id: number
  artifact_revision: number
  artifact_checksum: string
  policy_id: number | null
  policy_version: number | null
  expires_at: string
  revoked_at: string | null
}
```

Add `approveTaskArtifact`, `returnTaskArtifact`, `listAutomationPolicies`, `createAutomationPolicy`, `createAutomationPolicyVersion`, `pauseAutomationPolicy`, and `revokeAutomationPolicy`. Type `listAutomationPolicies` as `{policies: AutomationPolicy[]; capabilities: AutomationCapabilities}`; the page renders `GBP_POST 尚未启用` from `capabilities`, never from a frontend environment variable.

- [ ] **Step 5: Replace execution approval presentation**

Task detail treats the latest Artifact as the review object. Keep Attempt output and errors in a secondary history section. Hide approval controls unless status is `AWAITING_APPROVAL`, artifact is current, merchant is active, and no valid grant exists. Show policy match fallback as ordinary `待人工审批`, not as an execution failure.

```tsx
{task.status === 'AWAITING_APPROVAL' && task.current_artifact && !task.current_approval && (
  <ArtifactReview artifact={task.current_artifact} onApprove={approve} onReturn={returnArtifact} />
)}
<details><summary>执行记录</summary><ExecutionHistory items={task.executions} /></details>
```

- [ ] **Step 6: Run tests and commit**

Run: `cd web && npm test -- --run src/App.test.tsx`

Expected: PASS.

```bash
git add web/src/pages/AutomationPolicies.tsx web/src/api.ts web/src/App.tsx web/src/pages/MerchantDetail.tsx web/src/pages/TaskDetail.tsx web/src/App.test.tsx web/src/index.css
git commit -m "feat: review artifacts and manage automation policies"
```

---

### Task 7: Phase-2 regression, readback, and documentation

**Files:**
- Modify: `README.md`
- Modify only previously listed Phase-2 files if verification exposes a scoped defect.

**Interfaces:**
- Produces: an independently deployable preparation/authorization system with zero external mutation capability.

- [ ] **Step 1: Update runtime documentation**

Document automatic read-only preparation, immutable Artifact revisions, exact human approval, automation-policy fallback, and the fact that GBP publishing remains disabled. List no publishing Agent/tool environment variables yet.

- [ ] **Step 2: Run all quality gates**

Run: `cd api && .venv/bin/python -m pytest tests -q`

Run: `cd web && npm test`

Run: `cd web && npm run lint`

Run: `cd web && npm run build`

Run: `git diff --check`

Expected: every command exits 0.

- [ ] **Step 3: Verify persistence through process restart**

Using a temporary SQLite database, create and approve a Plan, let one PREPARE_ONLY run create Artifact revision 1, restart the FastAPI process, read back the same artifact/checksum, return it, create revision 2, approve revision 2, restart again, and assert the Task is `DONE` with both Artifacts, one unrevoked grant for revision 2, and complete events. Assert no Core AI Agent with tools was contacted.

- [ ] **Step 4: Verify policy safety matrix**

Run the policy matcher tests for exact match plus wrong merchant, location, Task type, operation, CTA, media, summary length, effective time, expiry, state, version, and quota. Confirm every mismatch produces no grant and leaves the Task awaiting human review.

- [ ] **Step 5: Commit Phase 2 completion**

```bash
git add README.md
git commit -m "docs: document task artifact authorization"
```

Do not start Phase 3 until the persisted Artifact and grant readback proves that content changes invalidate prior authorization and no enabled Agent has external write capability.

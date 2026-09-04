"""One-time conversion from legacy lowercase Tasks to revisioned workflows."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any, cast

from .task_plan_contract import validate_task_plan
from .task_workflows import WORKFLOW_TEMPLATES, enabled_task_types

TASK_WORKFLOW_MIGRATION = "0002_task_workflows"
LEGACY_TASK_WORKFLOW_MIGRATION = "task_workflow_v1"
LEGACY_TASK_WORKFLOW_STATES_MIGRATION = "task_workflow_states_v2"
# Exact checksum written by the frozen revision-2 hook contract.  It is the
# only historical 0002 checksum eligible for forward adoption.
TASK_WORKFLOW_REVISION_2_CHECKSUM = (
    "f6a40dfff14d0ee728ffc8c24e1ec5f2b82a99344bf03f226e0753b41f9fbac2"
)
TASK_WORKFLOW_REVISION_3_CHECKSUM = (
    "b07692c200e516392e278fae360926a90d5e1ebca366ce2bbc3cd7a38009009c"
)
_TASK_STATES = (
    "PENDING",
    "PREPARING",
    "AWAITING_APPROVAL",
    "EXECUTING",
    "VERIFYING",
    "NEEDS_ATTENTION",
    "DONE",
    "CANCELLED",
)
_TASK_KEY_RE = re.compile(r"^[a-z0-9_-]{1,80}$")
_CATEGORIES = {"gbp", "content", "review", "citation", "technical", "other"}


def _normalized_ddl(value: str) -> str:
    return " ".join(value.strip().rstrip(";").split())


def _suspend_performance_delete_guard(conn: sqlite3.Connection) -> str | None:
    """Temporarily remove 0001's Task-dependent merchant delete guard.

    SQLite reparses all schema objects while ``tasks`` is swapped.  Preserve
    the exact installed DDL and reject any drift before removing it; the outer
    migration transaction restores the dropped trigger automatically on
    failure, while the success path recreates the captured definition.
    """

    from .migrations import (
        PERFORMANCE_DELETE_GUARD_NAME,
        performance_delete_guard_contract_sql,
    )

    row = conn.execute(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?",
        (PERFORMANCE_DELETE_GUARD_NAME,),
    ).fetchone()
    if row is None:
        return None
    object_type, table_name, installed_sql = row
    expected_sql = performance_delete_guard_contract_sql()
    if (
        object_type != "trigger"
        or table_name != "merchants"
        or not isinstance(installed_sql, str)
        or _normalized_ddl(installed_sql) != _normalized_ddl(expected_sql)
    ):
        raise RuntimeError("performance delete guard contract mismatch")
    conn.execute(f"DROP TRIGGER {PERFORMANCE_DELETE_GUARD_NAME}")
    return installed_sql


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return (
        conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        is not None
    )


def _table_sql(conn: sqlite3.Connection, table: str) -> str | None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
    ).fetchone()
    return None if row is None else str(row[0])


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _fetch_dicts(conn: sqlite3.Connection, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    cursor = conn.execute(sql, params)
    names = [description[0] for description in cursor.description or ()]
    return [dict(zip(names, row, strict=True)) for row in cursor.fetchall()]


def assert_unique_coreai_run_bindings(conn: sqlite3.Connection) -> None:
    sources: list[str] = []
    for table in ("runs", "task_executions"):
        columns = _table_columns(conn, table) if _table_exists(conn, table) else set()
        if "coreai_run_id" in columns:
            sources.append(
                f"SELECT coreai_run_id FROM {table} WHERE coreai_run_id IS NOT NULL"
            )
    if not sources:
        return
    duplicate = conn.execute(
        "SELECT coreai_run_id FROM ("
        + " UNION ALL ".join(sources)
        + ") GROUP BY coreai_run_id HAVING COUNT(*) > 1 LIMIT 1"
    ).fetchone()
    if duplicate is not None:
        raise RuntimeError("database contains duplicate coreai_run_id bindings")


def task_table_kind(conn: sqlite3.Connection) -> str:
    """Classify the current Task table after inspecting its defining SQL."""

    sql = _table_sql(conn, "tasks")
    if sql is None:
        return "missing"
    columns = _table_columns(conn, "tasks")
    formal_columns = {
        "plan_id",
        "plan_revision",
        "task_key",
        "task_type",
        "workflow_version",
        "definition_checksum",
        "version",
    }
    normalized_sql = " ".join(sql.upper().split())
    if formal_columns <= columns and "'PENDING'" in normalized_sql and "'NEEDS_ATTENTION'" in normalized_sql:
        return "formal"
    legacy_columns = {"merchant_id", "title", "status", "created_at"}
    formal_identity_columns = formal_columns - {"task_type"}
    if legacy_columns <= columns and formal_identity_columns.isdisjoint(columns):
        legacy_sql = " ".join(sql.lower().split())
        invalid_status = conn.execute(
            "SELECT status FROM tasks WHERE status IS NULL OR lower(status) NOT IN "
            "('todo','doing','done','cancelled') LIMIT 1"
        ).fetchone()
        # The deployed legacy table did not constrain every state in its DDL;
        # its stable signature is the lowercase ``todo`` default plus the
        # absence of every formal workflow column.  Validate persisted values
        # as well so a look-alike or partially rebuilt table remains fail-closed.
        if "default 'todo'" in legacy_sql and invalid_status is None:
            return "legacy"
    raise RuntimeError("unrecognized tasks schema; refusing task workflow migration")


def _create_plan_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
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
        )
        """
    )
    conn.execute(
        """
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
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS task_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL,
          actor_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        )
        """
    )


def _create_replacement_task_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE _task_workflow_tasks (
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
          replaces_task_id INTEGER REFERENCES _task_workflow_tasks(id),
          replaced_by_task_id INTEGER REFERENCES _task_workflow_tasks(id),
          created_at TEXT NOT NULL,
          updated_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          UNIQUE (plan_id, task_key),
          FOREIGN KEY (plan_id, plan_revision)
            REFERENCES task_plan_revisions(plan_id, revision)
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE _task_workflow_task_executions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES _task_workflow_tasks(id),
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
        )
        """
    )


def _task_key(task: dict[str, Any], used: set[str]) -> str:
    candidate = task.get("source_key")
    if not isinstance(candidate, str) or not _TASK_KEY_RE.fullmatch(candidate) or candidate in used:
        candidate = f"legacy-task-{task['id']}"
    used.add(candidate)
    return candidate


def _scheduled_start(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(
            "legacy scheduled_start must be a timezone-aware ISO instant or NULL"
        )
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise RuntimeError(
            "legacy scheduled_start must be a timezone-aware ISO instant or NULL"
        ) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RuntimeError("legacy scheduled_start must include a timezone offset")
    return value


def _plan_item(task: dict[str, Any], used: set[str]) -> dict[str, object]:
    description = task.get("description") if isinstance(task.get("description"), str) else None
    category = task.get("category") if task.get("category") in _CATEGORIES else None
    title = str(task["title"])
    return {
        "key": _task_key(task, used),
        "task_type": task["task_type"] if "task_type" in task else "PREPARE_ONLY",
        "title": title,
        "rationale": task.get("rationale") or f"Migrated legacy task: {title}",
        "expected_outcome": task.get("expected_outcome") or "A reviewable migrated task result",
        "depends_on": [],
        "scheduled_start": _scheduled_start(task.get("scheduled_start")),
        "parameters": {"description": description, "category": category},
    }


def _create_plan(
    conn: sqlite3.Connection,
    *,
    tasks: list[dict[str, Any]],
    source_kind: str,
    source_run_id: int | None,
    approved: bool,
    decided_at: str | None,
) -> tuple[int, list[dict[str, object]]]:
    used: set[str] = set()
    candidate = {
        "schema_version": "seo_ops.task_plan.v1",
        "tasks": [_plan_item(task, used) for task in tasks],
    }
    validated = validate_task_plan(candidate, enabled_task_types())
    items = cast(list[dict[str, object]], validated.payload["tasks"])
    payload_json = validated.canonical_json
    created_at = str(tasks[0]["created_at"]) if tasks else _now_iso()
    terminal = approved and all(
        _task_status(task, _legacy_executions_for_task(conn, int(task["id"])))
        in {"DONE", "CANCELLED"}
        for task in tasks
    )
    cursor = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, source_run_id, state, latest_revision, approved_revision, created_at, closed_at) "
        "VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
        (
            tasks[0]["merchant_id"],
            source_kind,
            source_run_id,
            "CLOSED" if terminal else "OPEN",
            1 if approved else None,
            created_at,
            decided_at if terminal else None,
        ),
    )
    plan_id = int(cursor.lastrowid)
    conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, created_by, created_at, decided_by, decided_at) "
        "VALUES (?, 1, ?, 'seo_ops.task_plan.v1', ?, ?, 'MIGRATION', 'legacy-migration', ?, ?, ?)",
        (
            plan_id,
            "APPROVED" if approved else "DRAFT",
            payload_json,
            validated.checksum,
            created_at,
            "legacy-migration" if approved else None,
            decided_at if approved else None,
        ),
    )
    return plan_id, items


def _legacy_executions_for_task(
    conn: sqlite3.Connection, task_id: int
) -> list[dict[str, Any]]:
    if not _table_exists(conn, "task_executions"):
        return []
    return _fetch_dicts(
        conn, "SELECT * FROM task_executions WHERE task_id = ? ORDER BY id", (task_id,)
    )


def _validate_legacy_execution_owners(
    conn: sqlite3.Connection, tasks: list[dict[str, Any]]
) -> list[int]:
    task_ids = {int(task["id"]) for task in tasks}
    if not _table_exists(conn, "task_executions"):
        return []
    executions = conn.execute(
        "SELECT id, task_id FROM task_executions ORDER BY id"
    ).fetchall()
    for execution_id, task_id in executions:
        if int(task_id) not in task_ids:
            raise RuntimeError(
                f"legacy execution {execution_id} references missing task {task_id}"
            )
    return [int(row[0]) for row in executions]


def _task_status(task: dict[str, Any], executions: list[dict[str, Any]]) -> str:
    latest = executions[-1] if executions else None
    execution_status = str(latest.get("status")).lower() if latest else None
    if execution_status == "approved":
        return "DONE"
    if execution_status == "running":
        return "PREPARING"
    if execution_status == "ready":
        return "AWAITING_APPROVAL"
    if execution_status in {"failed", "returned"}:
        return "NEEDS_ATTENTION"
    return {
        "todo": "PENDING",
        "done": "DONE",
        "cancelled": "CANCELLED",
        "doing": "NEEDS_ATTENTION",
    }.get(str(task.get("status")).lower(), "NEEDS_ATTENTION")


def _legacy_task_is_pristine(
    conn: sqlite3.Connection, task: dict[str, Any]
) -> bool:
    """Return true only when no persisted operator or execution trace exists."""

    return (
        str(task.get("status")).lower() == "todo"
        and task.get("evidence_note") is None
        and task.get("completed_at") is None
        and not _legacy_executions_for_task(conn, int(task["id"]))
    )


def _materialize_task(
    conn: sqlite3.Connection,
    *,
    task: dict[str, Any],
    plan_id: int,
    item: dict[str, object],
) -> None:
    executions = _legacy_executions_for_task(conn, int(task["id"]))
    status = _task_status(task, executions)
    item_json = _canonical_json(item)
    parameters = cast(dict[str, object], item["parameters"])
    parameters_json = _canonical_json(parameters)
    task_type = str(item["task_type"])
    started_at = executions[0]["created_at"] if executions else None
    updated_at = task.get("completed_at") or (executions[-1].get("finished_at") if executions else None)
    conn.execute(
        "INSERT INTO _task_workflow_tasks "
        "(id, merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, parameters_json, definition_checksum, "
        "title, description, rationale, expected_outcome, category, scheduled_start, status, version, assignee, labels_json, "
        "operator_note, evidence_note, source_run_id, source_key, replaces_task_id, replaced_by_task_id, created_at, updated_at, "
        "started_at, completed_at, cancelled_at) "
        "VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, '[]', NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)",
        (
            task["id"],
            task["merchant_id"],
            plan_id,
            item["key"],
            task_type,
            WORKFLOW_TEMPLATES[task_type].version,
            parameters_json,
            _checksum(item_json),
            item["title"],
            parameters.get("description"),
            item["rationale"],
            item["expected_outcome"],
            parameters.get("category"),
            item["scheduled_start"],
            status,
            task.get("evidence_note"),
            task.get("source_run_id"),
            task.get("source_key"),
            task["created_at"],
            updated_at,
            started_at,
            task.get("completed_at") if status == "DONE" else None,
            task.get("completed_at") if status == "CANCELLED" else None,
        ),
    )
    for execution in executions:
        _materialize_execution(conn, execution)


def _materialize_execution(conn: sqlite3.Connection, execution: dict[str, Any]) -> None:
    request_json = "{}"
    status = {
        "running": "RUNNING",
        "ready": "SUCCEEDED",
        "approved": "SUCCEEDED",
        "failed": "FAILED",
        "returned": "FAILED",
    }[str(execution["status"])]
    conn.execute(
        "INSERT INTO _task_workflow_task_executions "
        "(id, task_id, stage, status, attempt, approval_id, artifact_id, request_json, request_checksum, idempotency_key, "
        "dispatch_token, dispatch_started_at, coreai_run_id, provider_resource_id, result_json, evidence_json, error, "
        "review_note, next_attempt_at, created_at, finished_at, reviewed_at) "
        "VALUES (?, ?, 'PREPARATION', ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL, ?, '[]', ?, ?, NULL, ?, ?, ?)",
        (
            execution["id"],
            execution["task_id"],
            status,
            execution["attempt"],
            request_json,
            _checksum(request_json),
            f"legacy-task-execution-{execution['id']}",
            execution["created_at"] if status == "RUNNING" else None,
            execution.get("coreai_run_id"),
            execution.get("output_text"),
            execution.get("error"),
            execution.get("review_note"),
            execution["created_at"],
            execution.get("finished_at"),
            execution.get("reviewed_at"),
        ),
    )


def _convert_legacy_runs_and_tasks(conn: sqlite3.Connection) -> None:
    tasks = _fetch_dicts(conn, "SELECT * FROM tasks ORDER BY id")
    source_execution_ids = _validate_legacy_execution_owners(conn, tasks)
    manual_tasks = [task for task in tasks if task.get("source_run_id") is None]
    run_ids = sorted({int(task["source_run_id"]) for task in tasks if task.get("source_run_id") is not None})

    for task in manual_tasks:
        decided_at = task.get("completed_at") or task["created_at"]
        plan_id, items = _create_plan(
            conn,
            tasks=[task],
            source_kind="OPERATOR",
            source_run_id=None,
            approved=True,
            decided_at=str(decided_at),
        )
        _materialize_task(conn, task=task, plan_id=plan_id, item=items[0])

    for run_id in run_ids:
        run_tasks = [task for task in tasks if task.get("source_run_id") == run_id]
        run_rows = _fetch_dicts(conn, "SELECT * FROM runs WHERE id = ?", (run_id,))
        if not run_rows:
            raise RuntimeError(f"legacy task references missing run {run_id}")
        run = run_rows[0]
        mismatched_task_ids = [
            int(task["id"])
            for task in run_tasks
            if int(task["merchant_id"]) != int(run["merchant_id"])
        ]
        if mismatched_task_ids:
            raise RuntimeError(
                f"legacy run {run_id} merchant {run['merchant_id']} does not match "
                f"task merchant for tasks {mismatched_task_ids}"
            )
        approved = run.get("plan_approved_at") is not None
        if not approved:
            pristine_tasks = [
                task
                for task in run_tasks
                if _legacy_task_is_pristine(conn, task)
            ]
            non_pristine_tasks = [
                task for task in run_tasks if task not in pristine_tasks
            ]
            if pristine_tasks:
                _create_plan(
                    conn,
                    tasks=pristine_tasks,
                    source_kind="AGENT",
                    source_run_id=run_id,
                    approved=False,
                    decided_at=None,
                )
            if non_pristine_tasks:
                decided_at = str(
                    run.get("finished_at") or run.get("created_at") or _now_iso()
                )
                migration_plan_id, migration_items = _create_plan(
                    conn,
                    tasks=non_pristine_tasks,
                    source_kind="MIGRATION",
                    source_run_id=None,
                    approved=True,
                    decided_at=decided_at,
                )
                for task, item in zip(
                    non_pristine_tasks, migration_items, strict=True
                ):
                    _materialize_task(
                        conn,
                        task=task,
                        plan_id=migration_plan_id,
                        item=item,
                    )
            continue

        plan_id, items = _create_plan(
            conn,
            tasks=run_tasks,
            source_kind="AGENT",
            source_run_id=run_id,
            approved=True,
            decided_at=run.get("plan_approved_at"),
        )
        for task, item in zip(run_tasks, items, strict=True):
            _materialize_task(conn, task=task, plan_id=plan_id, item=item)

    migrated_execution_ids = [
        int(row[0])
        for row in conn.execute(
            "SELECT id FROM _task_workflow_task_executions ORDER BY id"
        ).fetchall()
    ]
    if migrated_execution_ids != source_execution_ids:
        raise RuntimeError(
            "legacy task execution migration did not preserve exact IDs and count"
        )


def _swap_replacement_tables(conn: sqlite3.Connection) -> None:
    if _table_exists(conn, "task_executions"):
        conn.execute("DROP TABLE task_executions")
    conn.execute("DROP TABLE tasks")
    conn.execute("ALTER TABLE _task_workflow_tasks RENAME TO tasks")
    conn.execute("ALTER TABLE _task_workflow_task_executions RENAME TO task_executions")
    conn.execute(
        """
        CREATE TABLE task_dependencies (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          task_id INTEGER NOT NULL REFERENCES tasks(id),
          depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
          CHECK (task_id != depends_on_task_id),
          UNIQUE (task_id, depends_on_task_id)
        )
        """
    )


def _task_workflow_table_statements() -> dict[str, str]:
    """Return the frozen final table definitions owned by migration 0002."""

    return {
        "task_plans": """
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
            )
        """,
        "task_plan_revisions": """
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
            )
        """,
        "tasks": """
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
            )
        """,
        "task_dependencies": """
            CREATE TABLE IF NOT EXISTS task_dependencies (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id INTEGER NOT NULL REFERENCES tasks(id),
              depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
              CHECK (task_id != depends_on_task_id),
              UNIQUE (task_id, depends_on_task_id)
            )
        """,
        "task_executions": """
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
            )
        """,
        "task_events": """
            CREATE TABLE IF NOT EXISTS task_events (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              entity_type TEXT NOT NULL,
              entity_id INTEGER NOT NULL,
              event_type TEXT NOT NULL,
              actor_type TEXT NOT NULL,
              actor_id TEXT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
        """,
    }


def _normalized_table_ddl(value: str) -> str:
    normalized = _normalized_ddl(value)
    normalized = re.sub(
        r"^CREATE TABLE IF NOT EXISTS ", "CREATE TABLE ", normalized, count=1
    )
    # SQLite quotes tables and self-references when ALTER TABLE ... RENAME is
    # used by the legacy conversion. Quoting is not a semantic difference.
    return re.sub(
        r'(?:"([a-z_][a-z0-9_]*)"|`([a-z_][a-z0-9_]*)`|\[([a-z_][a-z0-9_]*)\])',
        lambda match: next(group for group in match.groups() if group is not None),
        normalized,
        flags=re.IGNORECASE,
    )


def _assert_task_workflow_table_contracts(conn: sqlite3.Connection) -> None:
    """Validate columns and every table-owned PK/FK/default/check/unique."""

    expected_unique_indexes: dict[
        str, set[tuple[str | None, tuple[str, ...], bool, str]]
    ] = {
        "task_plans": {(None, ("source_run_id",), False, "u")},
        "task_plan_revisions": {
            (None, ("plan_id", "revision"), False, "u"),
            ("idx_task_plan_revisions_one_draft", ("plan_id",), True, "c"),
        },
        "tasks": {
            (None, ("plan_id", "task_key"), False, "u"),
            ("idx_tasks_source_key", ("source_key",), True, "c"),
        },
        "task_dependencies": {
            (None, ("task_id", "depends_on_task_id"), False, "u")
        },
        "task_executions": {
            (None, ("idempotency_key",), False, "u"),
            (None, ("dispatch_token",), False, "u"),
            (None, ("task_id", "stage", "attempt"), False, "u"),
            ("idx_task_executions_active", ("task_id",), True, "c"),
        },
        "task_events": set(),
    }
    for table_name, expected_statement in _task_workflow_table_statements().items():
        row = conn.execute(
            "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?",
            (table_name,),
        ).fetchone()
        if (
            row is None
            or row[0] != "table"
            or row[1] != table_name
            or not isinstance(row[2], str)
            or _normalized_table_ddl(row[2])
            != _normalized_table_ddl(expected_statement)
        ):
            raise RuntimeError(
                f"{table_name} task workflow table contract mismatch"
            )
        actual_unique_indexes: set[
            tuple[str | None, tuple[str, ...], bool, str]
        ] = set()
        for index_row in conn.execute(f"PRAGMA index_list({table_name})"):
            if not bool(index_row[2]):
                continue
            index_name = str(index_row[1])
            origin = str(index_row[3])
            columns = tuple(
                str(column_row[2])
                for column_row in conn.execute(f"PRAGMA index_info({index_name})")
            )
            actual_unique_indexes.add(
                (
                    None if origin == "u" else index_name,
                    columns,
                    bool(index_row[4]),
                    origin,
                )
            )
        if actual_unique_indexes != expected_unique_indexes[table_name]:
            raise RuntimeError(
                "task workflow index contract mismatch: "
                f"{table_name} unique-index set"
            )


def _task_workflow_schema_object_statements() -> tuple[str, ...]:
    """Return the frozen index and trigger definitions owned by migration 0002."""

    return (
        "CREATE INDEX IF NOT EXISTS idx_task_plan_revisions_checksum "
        "ON task_plan_revisions(plan_id, checksum)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_plan_revisions_one_draft "
        "ON task_plan_revisions(plan_id) WHERE decision_state = 'DRAFT'",
        "CREATE INDEX IF NOT EXISTS idx_tasks_merchant ON tasks(merchant_id)",
        "CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id, plan_revision)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_key "
        "ON tasks(source_key) WHERE source_key IS NOT NULL",
        "CREATE INDEX IF NOT EXISTS idx_task_dependencies_task "
        "ON task_dependencies(task_id, id)",
        "CREATE INDEX IF NOT EXISTS idx_task_dependencies_upstream "
        "ON task_dependencies(depends_on_task_id, id)",
        "CREATE INDEX IF NOT EXISTS idx_task_executions_task "
        "ON task_executions(task_id, id DESC)",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_executions_active "
        "ON task_executions(task_id) "
        "WHERE status IN ('PENDING','DISPATCHING','RUNNING')",
        "CREATE INDEX IF NOT EXISTS idx_task_events_entity "
        "ON task_events(entity_type, entity_id, id)",
        """
        CREATE TRIGGER IF NOT EXISTS trg_task_events_no_update
        BEFORE UPDATE ON task_events
        BEGIN
          SELECT RAISE(ABORT, 'task events are append-only');
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_task_events_no_delete
        BEFORE DELETE ON task_events
        BEGIN
          SELECT RAISE(ABORT, 'task events are append-only');
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_tasks_no_delete
        BEFORE DELETE ON tasks
        BEGIN
          SELECT RAISE(ABORT, 'formal tasks cannot be deleted');
        END
        """,
        """
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
        END
        """,
        """
        CREATE TRIGGER IF NOT EXISTS trg_task_plan_revisions_no_delete
        BEFORE DELETE ON task_plan_revisions
        BEGIN
          SELECT RAISE(ABORT, 'plan revisions cannot be deleted');
        END
        """,
        """
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
        END
        """,
        """
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
        END
        """,
        """
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
        END
        """,
        """
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
        END
        """,
    )


def _create_task_workflow_indexes_and_triggers(conn: sqlite3.Connection) -> None:
    """Install every workflow object whose acceptance depends on migrated data."""

    for statement in _task_workflow_schema_object_statements():
        conn.execute(statement)


def _normalized_schema_object_ddl(value: str) -> str:
    normalized = _normalized_ddl(value)
    return re.sub(
        r"^(CREATE(?: UNIQUE)? (?:INDEX|TRIGGER)) IF NOT EXISTS ",
        r"\1 ",
        normalized,
        count=1,
    )


def _task_workflow_schema_object_contracts(
) -> dict[str, tuple[str, str, str]]:
    contracts: dict[str, tuple[str, str, str]] = {}
    pattern = re.compile(
        r"^CREATE (?:UNIQUE )?(INDEX|TRIGGER) IF NOT EXISTS "
        r"([a-z0-9_]+).*?\bON ([a-z0-9_]+)\b",
        re.IGNORECASE,
    )
    for statement in _task_workflow_schema_object_statements():
        match = pattern.match(_normalized_ddl(statement))
        if match is None:
            raise AssertionError("invalid task workflow schema object contract")
        object_type, name, table_name = match.groups()
        if name in contracts:
            raise AssertionError(f"duplicate task workflow schema object: {name}")
        contracts[name] = (
            object_type.lower(),
            table_name,
            _normalized_schema_object_ddl(statement),
        )
    return contracts


def _assert_task_workflow_schema_object_contracts(
    conn: sqlite3.Connection,
) -> None:
    contracts = _task_workflow_schema_object_contracts()
    installed: dict[str, tuple[Any, ...] | None] = {
        name: conn.execute(
            "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?",
            (name,),
        ).fetchone()
        for name in contracts
    }
    missing_triggers = sorted(
        name
        for name, (object_type, _table_name, _sql) in contracts.items()
        if object_type == "trigger" and installed[name] is None
    )
    if missing_triggers:
        raise RuntimeError(
            f"task workflow migration triggers are missing: {missing_triggers!r}"
        )
    for name, (expected_type, expected_table, expected_sql) in contracts.items():
        row = installed[name]
        if (
            row is None
            or row[0] != expected_type
            or row[1] != expected_table
            or not isinstance(row[2], str)
            or _normalized_schema_object_ddl(row[2]) != expected_sql
        ):
            raise RuntimeError(
                f"task workflow {expected_type} contract mismatch: {name}"
            )


def _task_states_are_current(conn: sqlite3.Connection) -> bool:
    sql = _table_sql(conn, "tasks")
    if sql is None:
        return False
    normalized_sql = " ".join(sql.upper().split())
    return all(f"'{state}'" in normalized_sql for state in _TASK_STATES)


def _create_states_v2_task_table(conn: sqlite3.Connection) -> None:
    conn.execute(
        """
        CREATE TABLE _task_workflow_tasks_v2 (
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
          replaces_task_id INTEGER REFERENCES _task_workflow_tasks_v2(id),
          replaced_by_task_id INTEGER REFERENCES _task_workflow_tasks_v2(id),
          created_at TEXT NOT NULL,
          updated_at TEXT,
          started_at TEXT,
          completed_at TEXT,
          cancelled_at TEXT,
          UNIQUE (plan_id, task_key),
          FOREIGN KEY (plan_id, plan_revision)
            REFERENCES task_plan_revisions(plan_id, revision)
        )
        """
    )


def _rebuild_tasks_for_states_v2(conn: sqlite3.Connection) -> None:
    columns = (
        "id, merchant_id, plan_id, plan_revision, task_key, task_type, "
        "workflow_version, parameters_json, definition_checksum, title, description, "
        "rationale, expected_outcome, category, scheduled_start, status, version, "
        "assignee, labels_json, operator_note, evidence_note, source_run_id, source_key, "
        "replaces_task_id, replaced_by_task_id, created_at, updated_at, started_at, "
        "completed_at, cancelled_at"
    )
    _create_states_v2_task_table(conn)
    conn.execute(
        f"INSERT INTO _task_workflow_tasks_v2 ({columns}) SELECT {columns} FROM tasks"
    )
    conn.execute("DROP TABLE tasks")
    conn.execute("ALTER TABLE _task_workflow_tasks_v2 RENAME TO tasks")
    _create_task_workflow_indexes_and_triggers(conn)


def run_task_workflow_migration_hook(
    conn: sqlite3.Connection, _migration_instant: str
) -> None:
    """Apply 0002 inside the shared runner's single writer transaction."""

    if not conn.in_transaction:
        raise RuntimeError("task workflow migration hook requires an active transaction")
    assert_unique_coreai_run_bindings(conn)
    kind = task_table_kind(conn)
    if kind == "missing":
        raise RuntimeError("tasks table is missing; apply the fresh schema before migration")
    guard_sql = _suspend_performance_delete_guard(conn)
    _create_plan_tables(conn)
    if kind == "legacy":
        _create_replacement_task_tables(conn)
        _convert_legacy_runs_and_tasks(conn)
        _swap_replacement_tables(conn)
    if not _task_states_are_current(conn):
        _rebuild_tasks_for_states_v2(conn)
    _create_task_workflow_indexes_and_triggers(conn)
    if guard_sql is not None:
        conn.execute(guard_sql)


def assert_task_workflow_table_contracts(conn: sqlite3.Connection) -> None:
    """Validate only the tables owned by the recorded Task migration."""

    if task_table_kind(conn) != "formal" or not _task_states_are_current(conn):
        raise RuntimeError("task workflow migration schema is incomplete")
    required_tables = {
        "task_plans",
        "task_plan_revisions",
        "task_dependencies",
        "task_executions",
        "task_events",
    }
    missing = sorted(
        table for table in required_tables if not _table_exists(conn, table)
    )
    if missing:
        raise RuntimeError(f"task workflow migration tables are missing: {missing!r}")
    _assert_task_workflow_table_contracts(conn)


def assert_task_workflow_migration_postconditions(conn: sqlite3.Connection) -> None:
    assert_unique_coreai_run_bindings(conn)
    assert_task_workflow_table_contracts(conn)
    _assert_task_workflow_schema_object_contracts(conn)
    foreign_key_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
    if foreign_key_errors:
        raise RuntimeError(
            f"task workflow migration left broken foreign keys: {foreign_key_errors!r}"
        )
    _assert_performance_delete_guard_if_recorded(conn)
    _validate_task_workflow_content(conn)


def _assert_performance_delete_guard_if_recorded(
    conn: sqlite3.Connection,
) -> None:
    from .migrations import (
        PERFORMANCE_DELETE_GUARD_NAME,
        PERFORMANCE_MIGRATION,
        performance_delete_guard_contract_sql,
    )

    if not _table_exists(conn, "schema_migrations"):
        return
    ledger_columns = _table_columns(conn, "schema_migrations")
    if ledger_columns != {"version", "checksum", "applied_at"}:
        return
    recorded = conn.execute(
        "SELECT 1 FROM schema_migrations WHERE version=?",
        (PERFORMANCE_MIGRATION,),
    ).fetchone()
    if recorded is None:
        return
    row = conn.execute(
        "SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?",
        (PERFORMANCE_DELETE_GUARD_NAME,),
    ).fetchone()
    expected_sql = performance_delete_guard_contract_sql()
    if (
        row is None
        or row[0] != "trigger"
        or row[1] != "merchants"
        or not isinstance(row[2], str)
        or _normalized_ddl(row[2]) != _normalized_ddl(expected_sql)
    ):
        raise RuntimeError("performance delete guard contract mismatch")


def _validated_revision_payloads(
    conn: sqlite3.Connection,
) -> dict[tuple[int, int], tuple[dict[str, object], str]]:
    """Parse and verify every immutable revision against the frozen contract."""

    validated_by_revision: dict[
        tuple[int, int], tuple[dict[str, object], str]
    ] = {}
    revisions = _fetch_dicts(
        conn, "SELECT * FROM task_plan_revisions ORDER BY plan_id,revision"
    )
    for revision in revisions:
        revision_id = int(revision["id"])
        try:
            raw = json.loads(str(revision["payload_json"]))
            validated = validate_task_plan(raw, enabled_task_types())
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise RuntimeError(
                f"task plan revision payload invalid: revision_id={revision_id}"
            ) from exc
        if (
            revision["payload_json"] != validated.canonical_json
            or revision["checksum"] != validated.checksum
            or revision["schema_version"] != "seo_ops.task_plan.v1"
        ):
            raise RuntimeError(
                f"task plan revision checksum invalid: revision_id={revision_id}"
            )
        decision_state = str(revision["decision_state"])
        decided_by = revision.get("decided_by")
        decided_at = revision.get("decided_at")
        decision_reason = revision.get("decision_reason")
        if decision_state == "DRAFT":
            if any(
                value is not None
                for value in (decided_by, decided_at, decision_reason)
            ):
                raise RuntimeError(
                    f"task plan draft decision metadata invalid: revision_id={revision_id}"
                )
        else:
            if (
                not isinstance(decided_by, str)
                or not decided_by.strip()
                or not isinstance(decided_at, str)
                or not decided_at.strip()
            ):
                raise RuntimeError(
                    f"task plan decision metadata missing: revision_id={revision_id}"
                )
            if decision_state == "REJECTED" and (
                not isinstance(decision_reason, str) or not decision_reason.strip()
            ):
                raise RuntimeError(
                    f"task plan rejection reason missing: revision_id={revision_id}"
                )
        key = (int(revision["plan_id"]), int(revision["revision"]))
        validated_by_revision[key] = (
            cast(dict[str, object], validated.payload),
            decision_state,
        )
    return validated_by_revision


def _revision_items_by_key(
    payload: dict[str, object],
) -> dict[str, dict[str, object]]:
    items = cast(list[dict[str, object]], payload["tasks"])
    return {str(item["key"]): item for item in items}


def _assert_plan_pointers_and_ownership(
    conn: sqlite3.Connection,
    validated_revisions: dict[
        tuple[int, int], tuple[dict[str, object], str]
    ],
) -> dict[int, dict[str, Any]]:
    plans = {
        int(plan["id"]): plan
        for plan in _fetch_dicts(conn, "SELECT * FROM task_plans ORDER BY id")
    }
    runs = {
        int(run["id"]): run
        for run in _fetch_dicts(
            conn,
            "SELECT id,merchant_id,status,plan_approved_at FROM runs ORDER BY id",
        )
    }
    for plan_id, plan in plans.items():
        revision_numbers = sorted(
            revision
            for candidate_plan_id, revision in validated_revisions
            if candidate_plan_id == plan_id
        )
        if (
            not revision_numbers
            or revision_numbers != list(range(1, revision_numbers[-1] + 1))
            or int(plan["latest_revision"]) != revision_numbers[-1]
        ):
            raise RuntimeError(
                f"task plan revision pointer invalid: plan_id={plan_id}"
            )
        states = {
            revision: validated_revisions[(plan_id, revision)][1]
            for revision in revision_numbers
        }
        drafts = [revision for revision, state in states.items() if state == "DRAFT"]
        approved = [
            revision for revision, state in states.items() if state == "APPROVED"
        ]
        if drafts and drafts != [revision_numbers[-1]]:
            raise RuntimeError(f"task plan draft pointer invalid: plan_id={plan_id}")
        approved_pointer = plan.get("approved_revision")
        if approved_pointer is None:
            if approved:
                raise RuntimeError(
                    f"task plan approved pointer missing: plan_id={plan_id}"
                )
        elif approved != [int(approved_pointer)]:
            raise RuntimeError(
                f"task plan approved pointer invalid: plan_id={plan_id}"
            )

        latest_state = states[revision_numbers[-1]]
        if latest_state == "SUPERSEDED":
            raise RuntimeError(
                f"task plan latest revision is superseded: plan_id={plan_id}"
            )
        plan_state = str(plan["state"])
        if approved_pointer is None:
            expected_state = "OPEN" if latest_state == "DRAFT" else "REJECTED"
            if latest_state not in {"DRAFT", "REJECTED"} or plan_state != expected_state:
                raise RuntimeError(
                    f"task plan decision state invalid: plan_id={plan_id}"
                )
        elif plan_state not in {"OPEN", "CLOSED"}:
            raise RuntimeError(f"task plan lifecycle invalid: plan_id={plan_id}")
        if (plan_state == "CLOSED") != (plan.get("closed_at") is not None):
            raise RuntimeError(
                f"task plan closed pointer invalid: plan_id={plan_id}"
            )

        source_kind = str(plan["source_kind"])
        source_run_id = plan.get("source_run_id")
        if source_run_id is None:
            if source_kind == "AGENT":
                raise RuntimeError(
                    f"agent task plan source run missing: plan_id={plan_id}"
                )
        else:
            if source_kind != "AGENT":
                raise RuntimeError(
                    f"task plan source run kind invalid: plan_id={plan_id}"
                )
            run = runs.get(int(source_run_id))
            if (
                run is None
                or int(run["merchant_id"]) != int(plan["merchant_id"])
                or run["status"] != "succeeded"
            ):
                raise RuntimeError(
                    f"task plan source run ownership invalid: plan_id={plan_id}"
                )
            if approved_pointer is not None and run["plan_approved_at"] is None:
                raise RuntimeError(
                    f"task plan approval run pointer invalid: plan_id={plan_id}"
                )
    orphan_revision = next(
        (
            plan_id
            for plan_id, _revision in validated_revisions
            if plan_id not in plans
        ),
        None,
    )
    if orphan_revision is not None:
        raise RuntimeError(
            f"task plan revision owner missing: plan_id={orphan_revision}"
        )
    return plans


def _assert_materialized_task_projection(
    conn: sqlite3.Connection,
    *,
    plans: dict[int, dict[str, Any]],
    validated_revisions: dict[
        tuple[int, int], tuple[dict[str, object], str]
    ],
) -> None:
    tasks = _fetch_dicts(conn, "SELECT * FROM tasks ORDER BY id")
    tasks_by_plan_key: dict[tuple[int, str], dict[str, Any]] = {}
    runs = {
        int(run["id"]): int(run["merchant_id"])
        for run in _fetch_dicts(conn, "SELECT id,merchant_id FROM runs ORDER BY id")
    }
    for task in tasks:
        task_id = int(task["id"])
        plan_id = int(task["plan_id"])
        plan = plans.get(plan_id)
        if plan is None or int(task["merchant_id"]) != int(plan["merchant_id"]):
            raise RuntimeError(
                f"materialized task plan ownership invalid: task_id={task_id}"
            )
        if plan.get("approved_revision") is None:
            raise RuntimeError(
                f"materialized task belongs to unapproved plan: task_id={task_id}"
            )
        source_run_id = task.get("source_run_id")
        if source_run_id is not None and runs.get(int(source_run_id)) != int(
            task["merchant_id"]
        ):
            raise RuntimeError(
                f"materialized task source run ownership invalid: task_id={task_id}"
            )
        if plan["source_kind"] != "MIGRATION" and source_run_id != plan.get(
            "source_run_id"
        ):
            raise RuntimeError(
                f"materialized task source run pointer invalid: task_id={task_id}"
            )
        revision_key = (plan_id, int(task["plan_revision"]))
        revision = validated_revisions.get(revision_key)
        if revision is None or revision[1] not in {"APPROVED", "SUPERSEDED"}:
            raise RuntimeError(
                f"materialized task revision invalid: task_id={task_id}"
            )
        item = _revision_items_by_key(revision[0]).get(str(task["task_key"]))
        if item is None:
            raise RuntimeError(
                f"materialized task definition missing: task_id={task_id}"
            )
        parameters = cast(dict[str, object], item["parameters"])
        task_type = str(item["task_type"])
        expected_projection = (
            task_type,
            WORKFLOW_TEMPLATES[task_type].version,
            _canonical_json(parameters),
            _checksum(_canonical_json(item)),
            item["title"],
            parameters.get("description"),
            item["rationale"],
            item["expected_outcome"],
            parameters.get("category"),
            item["scheduled_start"],
        )
        actual_projection = (
            task["task_type"],
            task["workflow_version"],
            task["parameters_json"],
            task["definition_checksum"],
            task["title"],
            task.get("description"),
            task.get("rationale"),
            task.get("expected_outcome"),
            task.get("category"),
            task.get("scheduled_start"),
        )
        if actual_projection != expected_projection:
            raise RuntimeError(
                f"materialized task definition checksum invalid: task_id={task_id}"
            )
        tasks_by_plan_key[(plan_id, str(task["task_key"]))] = task

    for plan_id, plan in plans.items():
        approved_revision = plan.get("approved_revision")
        if approved_revision is None:
            continue
        payload = validated_revisions[(plan_id, int(approved_revision))][0]
        for key, item in _revision_items_by_key(payload).items():
            task = tasks_by_plan_key.get((plan_id, key))
            if task is None or task["definition_checksum"] != _checksum(
                _canonical_json(item)
            ):
                raise RuntimeError(
                    f"approved task was not materialized: plan_id={plan_id},key={key}"
                )
        plan_tasks = [task for task in tasks if int(task["plan_id"]) == plan_id]
        has_draft = any(
            state == "DRAFT"
            for (candidate_plan_id, _revision), (_payload, state) in (
                validated_revisions.items()
            )
            if candidate_plan_id == plan_id
        )
        should_be_closed = (
            bool(plan_tasks)
            and not has_draft
            and all(
                task["status"] in {"DONE", "CANCELLED"}
                for task in plan_tasks
            )
        )
        if (plan["state"] == "CLOSED") != should_be_closed:
            raise RuntimeError(
                f"task plan lifecycle projection invalid: plan_id={plan_id}"
            )

    dependency_rows = conn.execute(
        "SELECT task_id,depends_on_task_id FROM task_dependencies "
        "ORDER BY task_id,depends_on_task_id"
    ).fetchall()
    actual_dependencies: dict[int, set[int]] = {}
    for task_id, depends_on_task_id in dependency_rows:
        actual_dependencies.setdefault(int(task_id), set()).add(
            int(depends_on_task_id)
        )
    task_by_id = {int(task["id"]): task for task in tasks}
    for task in tasks:
        task_id = int(task["id"])
        plan_id = int(task["plan_id"])
        payload = validated_revisions[(plan_id, int(task["plan_revision"]))][0]
        item = _revision_items_by_key(payload)[str(task["task_key"])]
        expected_dependencies = {
            int(tasks_by_plan_key[(plan_id, dependency_key)]["id"])
            for dependency_key in cast(list[str], item["depends_on"])
        }
        if actual_dependencies.get(task_id, set()) != expected_dependencies:
            raise RuntimeError(
                f"materialized task dependencies invalid: task_id={task_id}"
            )
    for task_id, dependency_ids in actual_dependencies.items():
        task = task_by_id.get(task_id)
        if task is None or any(
            dependency_id not in task_by_id
            or task_by_id[dependency_id]["plan_id"] != task["plan_id"]
            for dependency_id in dependency_ids
        ):
            raise RuntimeError(
                f"materialized task dependency ownership invalid: task_id={task_id}"
            )


def _validate_task_workflow_content(conn: sqlite3.Connection) -> None:
    validated_revisions = _validated_revision_payloads(conn)
    plans = _assert_plan_pointers_and_ownership(conn, validated_revisions)
    _assert_materialized_task_projection(
        conn,
        plans=plans,
        validated_revisions=validated_revisions,
    )


def validate_legacy_task_workflow_adoption(conn: sqlite3.Connection) -> None:
    """Prove both old markers describe the final frozen Task schema."""

    if task_table_kind(conn) != "formal":
        raise RuntimeError("legacy task workflow marker conflicts with tasks schema")
    if not _task_states_are_current(conn):
        raise RuntimeError(
            "legacy task workflow states marker conflicts with tasks schema"
        )
    assert_task_workflow_migration_postconditions(conn)


def validate_task_workflow_revision_2_compatibility(
    conn: sqlite3.Connection,
) -> None:
    """Adopt only a complete, internally consistent revision-2 database."""

    validate_legacy_task_workflow_adoption(conn)


def migrate_task_workflow_v1(conn: sqlite3.Connection) -> None:
    """Compatibility entry point backed by the shared migration runner."""

    from .migrations import apply_migrations

    apply_migrations(
        conn,
        python_migrations=task_workflow_python_migrations(),
        only_versions=frozenset({TASK_WORKFLOW_MIGRATION}),
    )
    assert_task_workflow_migration_postconditions(conn)


def migrate_task_workflow_states_v2(conn: sqlite3.Connection) -> None:
    """Compatibility alias for callers from the interim two-marker release."""

    migrate_task_workflow_v1(conn)


def task_workflow_python_migrations():
    """Register the immutable 0002 hook with the shared migration runner."""

    from .migrations import (
        MIGRATIONS_DIR,
        PythonMigration,
        python_migration_checksum,
    )

    contract_path = MIGRATIONS_DIR / f"{TASK_WORKFLOW_MIGRATION}.hook.json"
    contract = contract_path.read_text(encoding="utf-8")
    try:
        manifest = json.loads(contract)
    except json.JSONDecodeError as exc:
        raise RuntimeError("invalid task workflow migration contract") from exc
    if not isinstance(manifest, dict):
        raise RuntimeError("invalid task workflow migration contract")
    if manifest.get("version") != TASK_WORKFLOW_MIGRATION:
        raise RuntimeError("task workflow migration contract version mismatch")
    if manifest.get("hook_revision") != 4:
        raise RuntimeError("task workflow migration contract revision mismatch")
    if (
        manifest.get("entrypoint")
        != "app.task_migrations:run_task_workflow_migration_hook"
    ):
        raise RuntimeError("task workflow migration contract entrypoint mismatch")
    checksum = python_migration_checksum(
        TASK_WORKFLOW_MIGRATION, contract=contract
    )
    return (
        PythonMigration(
            version=TASK_WORKFLOW_MIGRATION,
            checksum=checksum,
            apply=run_task_workflow_migration_hook,
            foreign_keys_off=True,
            legacy_ledger_names=(
                LEGACY_TASK_WORKFLOW_MIGRATION,
                LEGACY_TASK_WORKFLOW_STATES_MIGRATION,
            ),
            validate_legacy_adoption=validate_legacy_task_workflow_adoption,
            compatible_checksums=(
                (
                    TASK_WORKFLOW_REVISION_2_CHECKSUM,
                    validate_task_workflow_revision_2_compatibility,
                ),
                (
                    TASK_WORKFLOW_REVISION_3_CHECKSUM,
                    validate_task_workflow_revision_2_compatibility,
                ),
            ),
        ),
    )


__all__ = [
    "TASK_WORKFLOW_MIGRATION",
    "TASK_WORKFLOW_REVISION_2_CHECKSUM",
    "TASK_WORKFLOW_REVISION_3_CHECKSUM",
    "LEGACY_TASK_WORKFLOW_MIGRATION",
    "LEGACY_TASK_WORKFLOW_STATES_MIGRATION",
    "assert_task_workflow_migration_postconditions",
    "assert_task_workflow_table_contracts",
    "assert_unique_coreai_run_bindings",
    "migrate_task_workflow_v1",
    "migrate_task_workflow_states_v2",
    "run_task_workflow_migration_hook",
    "task_workflow_python_migrations",
    "task_table_kind",
    "validate_legacy_task_workflow_adoption",
    "validate_task_workflow_revision_2_compatibility",
]

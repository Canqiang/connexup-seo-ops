"""One-time conversion from legacy lowercase Tasks to revisioned workflows."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .task_workflows import WORKFLOW_TEMPLATES

TASK_WORKFLOW_MIGRATION = "task_workflow_v1"
_TASK_KEY_RE = re.compile(r"^[a-z0-9_-]{1,80}$")
_CATEGORIES = {"gbp", "content", "review", "citation", "technical", "other"}


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


def _migration_applied(conn: sqlite3.Connection, name: str) -> bool:
    if not _table_exists(conn, "schema_migrations"):
        return False
    return conn.execute("SELECT 1 FROM schema_migrations WHERE name = ?", (name,)).fetchone() is not None


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
    if {"merchant_id", "title", "status", "created_at"} <= columns:
        legacy_sql = sql.lower()
        if "'todo'" in legacy_sql and "'doing'" in legacy_sql:
            return "legacy"
    raise RuntimeError("unrecognized tasks schema; refusing task workflow migration")


def _create_plan_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
        if not _table_exists(conn, "schema_migrations")
        else "SELECT 1"
    )
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
            CHECK (status IN ('PENDING','PREPARING','AWAITING_APPROVAL','NEEDS_ATTENTION','DONE','CANCELLED')),
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
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return value if parsed.tzinfo is not None else None


def _plan_item(task: dict[str, Any], used: set[str]) -> dict[str, object]:
    description = task.get("description") if isinstance(task.get("description"), str) else None
    category = task.get("category") if task.get("category") in _CATEGORIES else None
    title = str(task["title"])
    return {
        "key": _task_key(task, used),
        "task_type": "PREPARE_ONLY",
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
    items = [_plan_item(task, used) for task in tasks]
    payload_json = _canonical_json({"schema_version": "seo_ops.task_plan.v1", "tasks": items})
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
            _checksum(payload_json),
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


def _task_status(task: dict[str, Any], executions: list[dict[str, Any]]) -> str:
    latest = executions[-1] if executions else None
    execution_status = latest.get("status") if latest else None
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
    }.get(str(task.get("status")), "NEEDS_ATTENTION")


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
    parameters_json = _canonical_json(item["parameters"])
    started_at = executions[0]["created_at"] if executions else None
    updated_at = task.get("completed_at") or (executions[-1].get("finished_at") if executions else None)
    conn.execute(
        "INSERT INTO _task_workflow_tasks "
        "(id, merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, parameters_json, definition_checksum, "
        "title, description, rationale, expected_outcome, category, scheduled_start, status, version, assignee, labels_json, "
        "operator_note, evidence_note, source_run_id, source_key, replaces_task_id, replaced_by_task_id, created_at, updated_at, "
        "started_at, completed_at, cancelled_at) "
        "VALUES (?, ?, ?, 1, ?, 'PREPARE_ONLY', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, '[]', NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)",
        (
            task["id"],
            task["merchant_id"],
            plan_id,
            item["key"],
            WORKFLOW_TEMPLATES["PREPARE_ONLY"].version,
            parameters_json,
            _checksum(item_json),
            task["title"],
            task.get("description"),
            task.get("rationale"),
            task.get("expected_outcome"),
            task.get("category"),
            task.get("scheduled_start"),
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
        "review_note, next_attempt_at, created_at, finished_at) "
        "VALUES (?, ?, 'PREPARATION', ?, ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, NULL, ?, '[]', ?, ?, NULL, ?, ?)",
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
        ),
    )


def _convert_legacy_runs_and_tasks(conn: sqlite3.Connection) -> None:
    tasks = _fetch_dicts(conn, "SELECT * FROM tasks ORDER BY id")
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
        approved = run.get("plan_approved_at") is not None
        if not approved:
            execution_count = sum(
                len(_legacy_executions_for_task(conn, int(task["id"]))) for task in run_tasks
            )
            if execution_count:
                raise RuntimeError(
                    f"unapproved run {run_id} has execution history; refusing to drop candidate tasks"
                )
        plan_id, items = _create_plan(
            conn,
            tasks=run_tasks,
            source_kind="AGENT",
            source_run_id=run_id,
            approved=approved,
            decided_at=run.get("plan_approved_at"),
        )
        if approved:
            for task, item in zip(run_tasks, items, strict=True):
                _materialize_task(conn, task=task, plan_id=plan_id, item=item)


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


def migrate_task_workflow_v1(conn: sqlite3.Connection) -> None:
    """Apply the idempotent Task workflow migration in one rebuild transaction."""

    if _migration_applied(conn, TASK_WORKFLOW_MIGRATION):
        return
    if conn.in_transaction:
        raise RuntimeError("task workflow migration requires no active transaction")

    kind = task_table_kind(conn)
    if kind == "missing":
        raise RuntimeError("tasks table is missing; apply the fresh schema before migration")

    conn.execute("PRAGMA foreign_keys = OFF")
    try:
        conn.execute("BEGIN IMMEDIATE")
        _create_plan_tables(conn)
        if kind == "legacy":
            _create_replacement_task_tables(conn)
            _convert_legacy_runs_and_tasks(conn)
            _swap_replacement_tables(conn)
        conn.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            (TASK_WORKFLOW_MIGRATION, _now_iso()),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
    if conn.execute("PRAGMA foreign_key_check").fetchall():
        raise RuntimeError("task workflow migration left broken foreign keys")


__all__ = ["TASK_WORKFLOW_MIGRATION", "migrate_task_workflow_v1", "task_table_kind"]

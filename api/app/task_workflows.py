"""Server-owned task workflow templates and derived readiness checks.

The registry is intentionally small in Phase 1.  A task's lifecycle is
selected by its persisted type and template version; callers cannot invent a
transition or mark a task complete outside that lifecycle.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any


@dataclass(frozen=True)
class WorkflowTemplate:
    task_type: str
    version: int
    transitions: Mapping[str, frozenset[str]]
    terminal_after_approval: bool


class TaskWorkflowDataError(RuntimeError):
    """Raised when persisted workflow relationships fail integrity checks."""


_PREPARE_ONLY_TRANSITIONS = MappingProxyType(
    {
        "PENDING": frozenset({"PREPARING", "NEEDS_ATTENTION", "CANCELLED"}),
        "PREPARING": frozenset({"AWAITING_APPROVAL", "NEEDS_ATTENTION", "CANCELLED"}),
        "AWAITING_APPROVAL": frozenset({"DONE", "PENDING", "NEEDS_ATTENTION", "CANCELLED"}),
        "NEEDS_ATTENTION": frozenset({"PENDING", "CANCELLED"}),
        "DONE": frozenset(),
        "CANCELLED": frozenset(),
    }
)


WORKFLOW_TEMPLATES: Mapping[str, WorkflowTemplate] = MappingProxyType(
    {
        "PREPARE_ONLY": WorkflowTemplate(
            task_type="PREPARE_ONLY",
            version=1,
            transitions=_PREPARE_ONLY_TRANSITIONS,
            terminal_after_approval=True,
        )
    }
)


def enabled_task_types() -> set[str]:
    """Return the task types enabled by this server build."""

    return set(WORKFLOW_TEMPLATES)


def assert_transition(task_type: str, current: str, target: str) -> None:
    """Raise ``ValueError`` unless a template permits this state transition."""

    template = WORKFLOW_TEMPLATES.get(task_type)
    if template is None:
        raise ValueError(f"task type is not enabled: {task_type}")
    if target not in template.transitions.get(current, frozenset()):
        raise ValueError(f"illegal transition for {task_type}: {current} -> {target}")


def _row_keys(row: Any) -> set[str]:
    if hasattr(row, "keys"):
        return set(row.keys())
    if isinstance(row, dict):
        return set(row)
    return set()


def _value(row: Any, key: str, default: Any = None) -> Any:
    try:
        return row[key]
    except (IndexError, KeyError, TypeError):
        return default


def _table_has_columns(conn: sqlite3.Connection, table: str, columns: set[str]) -> bool:
    try:
        existing = {item[1] for item in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.DatabaseError:
        return False
    return columns <= existing


def _merchant_archived(conn: sqlite3.Connection, task: Any) -> bool:
    merchant_id = _value(task, "merchant_id")
    if merchant_id is None or not _table_has_columns(conn, "merchants", {"id", "status"}):
        return False
    merchant = conn.execute("SELECT status FROM merchants WHERE id = ?", (merchant_id,)).fetchone()
    return merchant is not None and str(merchant["status"]).upper() == "ARCHIVED"


def _revision_active(conn: sqlite3.Connection, task: Any) -> bool:
    if not _row_keys(task).issuperset({"plan_id", "plan_revision"}):
        return True
    if not _table_has_columns(conn, "task_plans", {"id", "approved_revision"}):
        return True
    plan = conn.execute(
        "SELECT approved_revision FROM task_plans WHERE id = ?", (_value(task, "plan_id"),)
    ).fetchone()
    if plan is None or plan["approved_revision"] is None:
        return False
    return plan["approved_revision"] == _value(task, "plan_revision")


def _parse_datetime(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _future_schedule(task: Any, now: datetime | None) -> bool:
    scheduled = _parse_datetime(_value(task, "scheduled_start"))
    if scheduled is None:
        return False
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return scheduled > current


def _first_incomplete_dependency(conn: sqlite3.Connection, task: Any) -> dict[str, object] | None:
    if not _row_keys(task).issuperset({"id"}):
        return None
    if not _table_has_columns(conn, "task_dependencies", {"id", "task_id", "depends_on_task_id"}):
        return None
    upstream_rows = conn.execute(
        "SELECT d.id AS dependency_id, d.depends_on_task_id, "
        "t.id AS upstream_id, t.task_key, t.title, t.status "
        "FROM task_dependencies d LEFT JOIN tasks t ON t.id = d.depends_on_task_id "
        "WHERE d.task_id = ? ORDER BY d.id",
        (_value(task, "id"),),
    ).fetchall()
    first_incomplete: dict[str, object] | None = None
    for upstream in upstream_rows:
        if _value(upstream, "upstream_id") is None:
            raise TaskWorkflowDataError(
                "dangling dependency "
                f"{_value(upstream, 'dependency_id')}: task {_value(task, 'id')} "
                f"references missing task {_value(upstream, 'depends_on_task_id')}"
            )
        if first_incomplete is None and str(_value(upstream, "status", "")).upper() != "DONE":
            first_incomplete = {
                "code": "UPSTREAM_NOT_DONE",
                "task_id": _value(upstream, "upstream_id"),
                "task_key": _value(upstream, "task_key"),
                "task_title": _value(upstream, "title"),
            }
    return first_incomplete


def task_blocker(
    conn: sqlite3.Connection, task: Any, now: datetime | None = None
) -> dict[str, object] | None:
    """Return the first readiness blocker for ``task`` in stable priority order."""

    if _merchant_archived(conn, task):
        return {"code": "MERCHANT_ARCHIVED"}
    if not _revision_active(conn, task):
        return {"code": "REVISION_INACTIVE"}
    if _future_schedule(task, now):
        return {
            "code": "SCHEDULED_FOR_FUTURE",
            "scheduled_start": _value(task, "scheduled_start"),
        }
    return _first_incomplete_dependency(conn, task)


__all__ = [
    "WORKFLOW_TEMPLATES",
    "TaskWorkflowDataError",
    "WorkflowTemplate",
    "assert_transition",
    "enabled_task_types",
    "task_blocker",
]

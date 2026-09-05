"""Persistence and read views for immutable, revisioned Task Plans."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from typing import Any, cast

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import require_operator
from .db import get_db
from .merchants import fetch_active_merchant, now_iso
from .task_events import append_task_event
from .task_plan_contract import (
    TaskPlanPayload,
    TaskPlanValidationError,
    ValidatedTaskPlan,
    validate_task_plan,
)
from .task_workflows import WORKFLOW_TEMPLATES, enabled_task_types

router = APIRouter(prefix="/api", tags=["task-plans"])


class DraftRemoval(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(pattern=r"^[a-z0-9_-]{1,80}$")
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("removal reason must not be blank")
        return reason


class DraftPlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)
    plan: TaskPlanPayload
    removals: list[DraftRemoval] = Field(default_factory=list)


class ApprovePlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    revision: int = Field(ge=1)
    checksum: str = Field(pattern=r"^[0-9a-f]{64}$")


class RejectPlanBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: int = Field(ge=1)
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value: str) -> str:
        reason = value.strip()
        if not reason:
            raise ValueError("rejection reason must not be blank")
        return reason


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _checksum(value: object) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _validate_plan(raw: object) -> ValidatedTaskPlan:
    try:
        return validate_task_plan(raw, enabled_task_types())
    except TaskPlanValidationError as exc:
        raise HTTPException(status_code=422, detail={"codes": exc.codes}) from exc


def _fetch_plan(conn: sqlite3.Connection, plan_id: int) -> sqlite3.Row:
    plan = conn.execute("SELECT * FROM task_plans WHERE id = ?", (plan_id,)).fetchone()
    if plan is None:
        raise HTTPException(status_code=404, detail="task plan not found")
    return plan


def _revision_payload(revision: sqlite3.Row) -> dict[str, object]:
    try:
        payload = json.loads(revision["payload_json"])
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=409, detail="stored plan revision is invalid") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=409, detail="stored plan revision is invalid")
    return cast(dict[str, object], payload)


def _validated_revision(revision: sqlite3.Row) -> ValidatedTaskPlan:
    try:
        validated = validate_task_plan(_revision_payload(revision), enabled_task_types())
    except TaskPlanValidationError as exc:
        raise HTTPException(status_code=409, detail="stored plan revision is invalid") from exc
    if (
        validated.canonical_json != revision["payload_json"]
        or validated.checksum != revision["checksum"]
    ):
        raise HTTPException(status_code=409, detail="stored plan revision checksum changed")
    return validated


def _plan_items(payload: dict[str, object]) -> list[dict[str, object]]:
    return cast(list[dict[str, object]], payload["tasks"])


def _item_map(payload: dict[str, object]) -> dict[str, dict[str, object]]:
    return {str(item["key"]): item for item in _plan_items(payload)}


def _approved_items(
    conn: sqlite3.Connection, plan: sqlite3.Row
) -> dict[str, dict[str, object]]:
    if plan["approved_revision"] is None:
        return {}
    revision = conn.execute(
        "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND revision = ?",
        (plan["id"], plan["approved_revision"]),
    ).fetchone()
    if revision is None:
        raise HTTPException(status_code=409, detail="approved plan revision not found")
    return _item_map(_validated_revision(revision).payload)


def _assert_active_task_anchors(
    conn: sqlite3.Connection, plan: sqlite3.Row, candidate: ValidatedTaskPlan
) -> None:
    """Prevent a later revision from rewriting a Task that already started."""

    approved_items = _approved_items(conn, plan)
    candidate_items = _item_map(candidate.payload)
    rows = conn.execute(
        "SELECT * FROM tasks WHERE plan_id = ? AND status != 'PENDING' ORDER BY id",
        (plan["id"],),
    ).fetchall()
    for task in rows:
        key = str(task["task_key"])
        candidate_item = candidate_items.get(key)
        if key not in approved_items:
            if candidate_item is not None:
                raise HTTPException(
                    status_code=409,
                    detail=f"task {key} cannot reuse a terminal historical key",
                )
            continue
        if candidate_item is None or _checksum(candidate_item) != task["definition_checksum"]:
            raise HTTPException(
                status_code=409,
                detail=f"task {key} already advanced past PENDING",
            )


def _validated_removals(
    previous: ValidatedTaskPlan,
    candidate: ValidatedTaskPlan,
    removals: list[DraftRemoval],
) -> list[dict[str, str]]:
    previous_keys = [str(item["key"]) for item in _plan_items(previous.payload)]
    candidate_keys = set(_item_map(candidate.payload))
    removed_keys = [key for key in previous_keys if key not in candidate_keys]
    submitted_keys = [removal.key for removal in removals]
    if len(submitted_keys) != len(set(submitted_keys)) or set(submitted_keys) != set(removed_keys):
        raise HTTPException(
            status_code=422,
            detail="removals must contain exactly one reason for every removed task key",
        )
    reasons = {removal.key: removal.reason for removal in removals}
    return [{"key": key, "reason": reasons[key]} for key in removed_keys]


def persist_agent_plan(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    run_id: int,
    coreai_run_id: str,
    validated: ValidatedTaskPlan,
) -> sqlite3.Row:
    """Persist exactly one immutable Agent revision in the caller transaction."""

    if not conn.in_transaction:
        raise RuntimeError("Agent Plan persistence requires an active transaction")
    fetch_active_merchant(conn, merchant_id)
    run = conn.execute(
        "SELECT merchant_id,coreai_run_id,status FROM runs WHERE id=?", (run_id,)
    ).fetchone()
    if run is None:
        raise ValueError("run not found")
    if int(run["merchant_id"]) != merchant_id:
        raise ValueError("run does not belong to merchant")
    if run["coreai_run_id"] != coreai_run_id:
        raise ValueError("core ai run id mismatch")
    if run["status"] != "succeeded":
        raise ValueError("run has not succeeded")

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

    created_at = now_iso()
    cursor = conn.execute(
        "INSERT INTO task_plans "
        "(merchant_id, source_kind, source_run_id, state, latest_revision, approved_revision, created_at) "
        "VALUES (?, 'AGENT', ?, 'OPEN', 1, NULL, ?)",
        (merchant_id, run_id, created_at),
    )
    plan_id = int(cursor.lastrowid)
    revision_cursor = conn.execute(
        "INSERT INTO task_plan_revisions "
        "(plan_id, revision, decision_state, schema_version, payload_json, checksum, source, created_by, created_at) "
        "VALUES (?, 1, 'DRAFT', 'seo_ops.task_plan.v1', ?, ?, 'AGENT', ?, ?)",
        (plan_id, validated.canonical_json, validated.checksum, coreai_run_id, created_at),
    )
    return conn.execute(
        "SELECT * FROM task_plan_revisions WHERE id = ?", (revision_cursor.lastrowid,)
    ).fetchone()


def _revision_view(revision: sqlite3.Row) -> dict[str, Any]:
    view = dict(revision)
    view["payload"] = json.loads(view.pop("payload_json"))
    return view


def _plan_view(conn: sqlite3.Connection, plan: sqlite3.Row) -> dict[str, Any]:
    current = conn.execute(
        "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND revision = ?",
        (plan["id"], plan["latest_revision"]),
    ).fetchone()
    if current is None:
        raise HTTPException(status_code=500, detail="task plan current revision not found")
    return {**dict(plan), "current_revision": _revision_view(current)}


def _task_view(task: sqlite3.Row) -> dict[str, Any]:
    view = dict(task)
    view["parameters"] = json.loads(view.pop("parameters_json"))
    view["labels"] = json.loads(view.pop("labels_json"))
    return view


def _tasks_in_payload_order(
    conn: sqlite3.Connection, plan_id: int, payload: dict[str, object]
) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM tasks WHERE plan_id = ? ORDER BY id", (plan_id,)
    ).fetchall()
    by_key = {str(row["task_key"]): row for row in rows}
    tasks: list[dict[str, Any]] = []
    for item in _plan_items(payload):
        row = by_key.get(str(item["key"]))
        if row is None:
            raise HTTPException(status_code=500, detail="approved task was not materialized")
        tasks.append(_task_view(row))
    return tasks


def _task_definition_values(item: dict[str, object]) -> tuple[object, ...]:
    parameters = cast(dict[str, object], item["parameters"])
    task_type = str(item["task_type"])
    return (
        task_type,
        WORKFLOW_TEMPLATES[task_type].version,
        _canonical_json(parameters),
        _checksum(item),
        item["title"],
        parameters.get("description"),
        item["rationale"],
        item["expected_outcome"],
        parameters.get("category"),
        item["scheduled_start"],
    )


def materialize_plan_revision(
    conn: sqlite3.Connection,
    plan: sqlite3.Row,
    revision: sqlite3.Row,
    operator: str,
) -> list[int]:
    """Apply one validated revision without committing the caller transaction."""

    if revision["plan_id"] != plan["id"]:
        raise HTTPException(status_code=409, detail="plan revision does not belong to plan")
    validated = _validated_revision(revision)
    _assert_active_task_anchors(conn, plan, validated)
    items = _plan_items(validated.payload)
    target = _item_map(validated.payload)
    existing_rows = conn.execute(
        "SELECT * FROM tasks WHERE plan_id = ? ORDER BY id", (plan["id"],)
    ).fetchall()
    existing = {str(row["task_key"]): row for row in existing_rows}
    mutable_rows = [row for row in existing_rows if row["status"] == "PENDING"]
    changed_at = now_iso()

    # Remove only the edge sets owned by still-pending downstream Tasks that
    # this revision redefines.  Edges attached to started/terminal Tasks are
    # immutable history, and a pending Task that this revision removes keeps
    # its edges too: it stays bound to the revision that defined it, and the
    # cold-start projection checks its edges against that frozen definition.
    for task in mutable_rows:
        if str(task["task_key"]) not in target:
            continue
        conn.execute("DELETE FROM task_dependencies WHERE task_id = ?", (task["id"],))

    for task in mutable_rows:
        key = str(task["task_key"])
        if key in target:
            continue
        conn.execute(
            "UPDATE tasks SET status = 'CANCELLED', version = version + 1, "
            "updated_at = ?, cancelled_at = ? WHERE id = ? AND status = 'PENDING'",
            (changed_at, changed_at, task["id"]),
        )
        append_task_event(
            conn,
            entity_type="TASK",
            entity_id=int(task["id"]),
            event_type="TASK_MATERIALIZED",
            actor_type="OPERATOR",
            actor_id=operator,
            payload={
                "action": "CANCELLED",
                "plan_id": plan["id"],
                "plan_revision": revision["revision"],
                "task_key": key,
            },
        )

    materialized_ids: list[int] = []
    for item in items:
        key = str(item["key"])
        current = existing.get(key)
        definition = _task_definition_values(item)
        if current is None:
            cursor = conn.execute(
                "INSERT INTO tasks "
                "(merchant_id, plan_id, plan_revision, task_key, task_type, workflow_version, "
                "parameters_json, definition_checksum, title, description, rationale, "
                "expected_outcome, category, scheduled_start, status, version, labels_json, "
                "source_run_id, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, '[]', ?, ?)",
                (
                    plan["merchant_id"],
                    plan["id"],
                    revision["revision"],
                    key,
                    *definition,
                    plan["source_run_id"],
                    changed_at,
                ),
            )
            task_id = int(cursor.lastrowid)
            action = "CREATED"
        elif current["status"] == "PENDING":
            updated = conn.execute(
                "UPDATE tasks SET plan_revision = ?, task_type = ?, workflow_version = ?, "
                "parameters_json = ?, definition_checksum = ?, title = ?, description = ?, "
                "rationale = ?, expected_outcome = ?, category = ?, scheduled_start = ?, "
                "version = version + 1, updated_at = ? "
                "WHERE id = ? AND status = 'PENDING'",
                (revision["revision"], *definition, changed_at, current["id"]),
            )
            if updated.rowcount != 1:
                raise HTTPException(status_code=409, detail=f"task {key} changed; refresh and retry")
            task_id = int(current["id"])
            action = "UPDATED"
        else:
            # _assert_active_task_anchors proved that this definition is an
            # unchanged historical anchor.  Do not rewrite its revision.
            task_id = int(current["id"])
            action = "RETAINED"
        materialized_ids.append(task_id)
        append_task_event(
            conn,
            entity_type="TASK",
            entity_id=task_id,
            event_type="TASK_MATERIALIZED",
            actor_type="OPERATOR",
            actor_id=operator,
            payload={
                "action": action,
                "definition_checksum": _checksum(item),
                "plan_id": plan["id"],
                "plan_revision": revision["revision"],
                "task_key": key,
            },
        )

    refreshed_rows = conn.execute(
        "SELECT * FROM tasks WHERE plan_id = ? ORDER BY id", (plan["id"],)
    ).fetchall()
    refreshed = {str(row["task_key"]): row for row in refreshed_rows}
    for item in items:
        downstream = refreshed[str(item["key"])]
        if downstream["status"] != "PENDING":
            continue
        for upstream_key in cast(list[str], item["depends_on"]):
            upstream = refreshed[upstream_key]
            if upstream["plan_id"] != plan["id"] or downstream["plan_id"] != plan["id"]:
                raise HTTPException(status_code=409, detail="dependency crosses logical Plans")
            conn.execute(
                "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
                (downstream["id"], upstream["id"]),
            )
    return materialized_ids


def refresh_plan_lifecycle(conn: sqlite3.Connection, plan_id: int) -> None:
    """Refresh OPEN/CLOSED while preserving a rejected unapproved Plan."""

    plan = _fetch_plan(conn, plan_id)
    has_draft = conn.execute(
        "SELECT 1 FROM task_plan_revisions WHERE plan_id = ? AND decision_state = 'DRAFT'",
        (plan_id,),
    ).fetchone()
    counts = conn.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN status NOT IN ('DONE','CANCELLED') THEN 1 ELSE 0 END) AS active "
        "FROM tasks WHERE plan_id = ?",
        (plan_id,),
    ).fetchone()
    if has_draft is not None:
        conn.execute(
            "UPDATE task_plans SET state = 'OPEN', closed_at = NULL WHERE id = ?", (plan_id,)
        )
    elif (
        plan["approved_revision"] is not None
        and counts["total"] > 0
        and int(counts["active"] or 0) == 0
    ):
        conn.execute(
            "UPDATE task_plans SET state = 'CLOSED', closed_at = COALESCE(closed_at, ?) "
            "WHERE id = ?",
            (now_iso(), plan_id),
        )
    elif plan["approved_revision"] is not None or plan["state"] != "REJECTED":
        conn.execute(
            "UPDATE task_plans SET state = 'OPEN', closed_at = NULL WHERE id = ?", (plan_id,)
        )


@router.get("/runs/{run_id}/task-plan")
def get_run_task_plan(run_id: int, conn=Depends(get_db)):
    plan = conn.execute(
        "SELECT * FROM task_plans WHERE source_run_id = ?", (run_id,)
    ).fetchone()
    if plan is None:
        raise HTTPException(status_code=404, detail="task plan not found")
    return _plan_view(conn, plan)


@router.get("/task-plans/{plan_id}")
def get_task_plan(plan_id: int, conn=Depends(get_db)):
    return _plan_view(conn, _fetch_plan(conn, plan_id))


@router.put("/task-plans/{plan_id}/draft")
def replace_draft(
    plan_id: int,
    body: DraftPlanBody,
    operator: str = Depends(require_operator),
    conn=Depends(get_db),
):
    validated = _validate_plan(body.plan.model_dump(mode="json"))
    conn.execute("BEGIN IMMEDIATE")
    try:
        plan = _fetch_plan(conn, plan_id)
        fetch_active_merchant(conn, int(plan["merchant_id"]))
        if plan["latest_revision"] != body.expected_revision:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        current = conn.execute(
            "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND revision = ?",
            (plan_id, body.expected_revision),
        ).fetchone()
        if current is None:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        current_validated = _validated_revision(current)
        audited_removals = _validated_removals(current_validated, validated, body.removals)
        _assert_active_task_anchors(conn, plan, validated)
        if current["decision_state"] == "DRAFT" and current["checksum"] == validated.checksum:
            conn.commit()
            return _plan_view(conn, _fetch_plan(conn, plan_id))

        created_at = now_iso()
        next_revision = body.expected_revision + 1
        if current["decision_state"] == "DRAFT":
            updated = conn.execute(
                "UPDATE task_plan_revisions SET decision_state = 'SUPERSEDED', "
                "decided_by = ?, decided_at = ? WHERE plan_id = ? AND revision = ? "
                "AND decision_state = 'DRAFT'",
                (operator, created_at, plan_id, body.expected_revision),
            )
            if updated.rowcount != 1:
                raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        conn.execute(
            "INSERT INTO task_plan_revisions "
            "(plan_id, revision, decision_state, schema_version, payload_json, checksum, "
            "source, created_by, created_at) "
            "VALUES (?, ?, 'DRAFT', 'seo_ops.task_plan.v1', ?, ?, 'OPERATOR', ?, ?)",
            (
                plan_id,
                next_revision,
                validated.canonical_json,
                validated.checksum,
                operator,
                created_at,
            ),
        )
        conn.execute(
            "UPDATE task_plans SET latest_revision = ?, state = 'OPEN', closed_at = NULL "
            "WHERE id = ? AND latest_revision = ?",
            (next_revision, plan_id, body.expected_revision),
        )
        append_task_event(
            conn,
            entity_type="PLAN",
            entity_id=plan_id,
            event_type="PLAN_DRAFT_REPLACED",
            actor_type="OPERATOR",
            actor_id=operator,
            payload={
                "checksum": validated.checksum,
                "previous_revision": body.expected_revision,
                "removed_keys": [removal["key"] for removal in audited_removals],
                "removals": audited_removals,
                "revision": next_revision,
            },
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _plan_view(conn, _fetch_plan(conn, plan_id))


@router.post("/task-plans/{plan_id}/approve")
def approve_plan(
    plan_id: int,
    body: ApprovePlanBody,
    operator: str = Depends(require_operator),
    conn=Depends(get_db),
):
    conn.execute("BEGIN IMMEDIATE")
    try:
        plan = _fetch_plan(conn, plan_id)
        fetch_active_merchant(conn, int(plan["merchant_id"]))
        if plan["latest_revision"] != body.revision:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        revision = conn.execute(
            "SELECT * FROM task_plan_revisions WHERE plan_id = ? AND revision = ?",
            (plan_id, body.revision),
        ).fetchone()
        if revision is None or revision["checksum"] != body.checksum:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        validated = _validated_revision(revision)
        decided_at = now_iso()
        updated = conn.execute(
            "UPDATE task_plan_revisions SET decision_state = 'APPROVED', decided_by = ?, decided_at = ? "
            "WHERE plan_id = ? AND revision = ? AND decision_state = 'DRAFT' AND checksum = ?",
            (operator, decided_at, plan_id, body.revision, body.checksum),
        )
        if updated.rowcount != 1:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        if plan["approved_revision"] is not None:
            superseded = conn.execute(
                "UPDATE task_plan_revisions SET decision_state = 'SUPERSEDED' "
                "WHERE plan_id = ? AND revision = ? AND decision_state = 'APPROVED'",
                (plan_id, plan["approved_revision"]),
            )
            if superseded.rowcount != 1:
                raise HTTPException(status_code=409, detail="approved plan revision changed")

        task_ids = materialize_plan_revision(conn, plan, revision, operator)
        pointer = conn.execute(
            "UPDATE task_plans SET approved_revision = ?, state = 'OPEN', closed_at = NULL "
            "WHERE id = ? AND latest_revision = ?",
            (body.revision, plan_id, body.revision),
        )
        if pointer.rowcount != 1:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        if plan["source_run_id"] is not None:
            conn.execute(
                "UPDATE runs SET plan_approved_at = COALESCE(plan_approved_at, ?) WHERE id = ?",
                (decided_at, plan["source_run_id"]),
            )
        append_task_event(
            conn,
            entity_type="PLAN",
            entity_id=plan_id,
            event_type="PLAN_APPROVED",
            actor_type="OPERATOR",
            actor_id=operator,
            payload={
                "checksum": body.checksum,
                "previous_approved_revision": plan["approved_revision"],
                "revision": body.revision,
                "task_ids": task_ids,
            },
        )
        refresh_plan_lifecycle(conn, plan_id)
        result = _plan_view(conn, _fetch_plan(conn, plan_id))
        result["tasks"] = _tasks_in_payload_order(conn, plan_id, validated.payload)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return result


@router.post("/task-plans/{plan_id}/reject")
def reject_plan(
    plan_id: int,
    body: RejectPlanBody,
    operator: str = Depends(require_operator),
    conn=Depends(get_db),
):
    conn.execute("BEGIN IMMEDIATE")
    try:
        plan = _fetch_plan(conn, plan_id)
        fetch_active_merchant(conn, int(plan["merchant_id"]))
        if plan["latest_revision"] != body.expected_revision:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        decided_at = now_iso()
        updated = conn.execute(
            "UPDATE task_plan_revisions SET decision_state = 'REJECTED', decided_by = ?, "
            "decided_at = ?, decision_reason = ? WHERE plan_id = ? AND revision = ? "
            "AND decision_state = 'DRAFT'",
            (operator, decided_at, body.reason, plan_id, body.expected_revision),
        )
        if updated.rowcount != 1:
            raise HTTPException(status_code=409, detail="plan revision changed; refresh and retry")
        if plan["approved_revision"] is None:
            conn.execute(
                "UPDATE task_plans SET state = 'REJECTED', closed_at = NULL WHERE id = ?",
                (plan_id,),
            )
        else:
            refresh_plan_lifecycle(conn, plan_id)
        append_task_event(
            conn,
            entity_type="PLAN",
            entity_id=plan_id,
            event_type="PLAN_REJECTED",
            actor_type="OPERATOR",
            actor_id=operator,
            payload={"reason": body.reason, "revision": body.expected_revision},
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _plan_view(conn, _fetch_plan(conn, plan_id))


__all__ = [
    "materialize_plan_revision",
    "persist_agent_plan",
    "refresh_plan_lifecycle",
    "router",
]

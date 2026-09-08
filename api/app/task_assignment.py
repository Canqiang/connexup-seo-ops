"""Validated Task ownership; assigning an Agent does not dispatch it."""

import sqlite3
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .merchants import now_iso
from .task_events import append_task_event


class AssignmentBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    assignee_type: Literal["HUMAN", "AGENT"] | None
    assignee_id: str | None = Field(max_length=200)
    reason: str = Field(min_length=1, max_length=2000)

    @field_validator("reason")
    @classmethod
    def nonblank_reason(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("reason must not be blank")
        return value.strip()

    @model_validator(mode="after")
    def valid_pair(self):
        if (self.assignee_type is None) != (self.assignee_id is None):
            raise ValueError("assignee type and identity must be provided together")
        if self.assignee_id is not None and not self.assignee_id.strip():
            raise ValueError("assignee identity must not be blank")
        return self


def assignment_view(conn: sqlite3.Connection, task_id: int) -> dict | None:
    row = conn.execute(
        "SELECT a.*, g.display_name, g.status AS agent_status FROM task_assignments a "
        "LEFT JOIN seo_ops_agents g ON g.id=a.agent_id WHERE a.task_id=?", (task_id,)
    ).fetchone()
    if row is None:
        return None
    human = row["assignee_type"] == "HUMAN"
    return {
        "assignee_type": row["assignee_type"],
        "assignee_id": row["operator_username"] if human else row["agent_id"],
        "display_name": f"AM · {row['operator_username']}" if human else row["display_name"],
        "agent_status": row["agent_status"],
    }


def assignment_options(conn: sqlite3.Connection, operator: str) -> list[dict]:
    return [
        {"assignee_type": "HUMAN", "assignee_id": operator, "display_name": f"AM · {operator}"},
        *[dict(assignee_type="AGENT", assignee_id=row["id"], display_name=row["display_name"])
          for row in conn.execute("SELECT id,display_name FROM seo_ops_agents "
                                  "WHERE status='active' ORDER BY sort_order,id")],
    ]


def assignment_lock_reason(conn: sqlite3.Connection, task: sqlite3.Row) -> str | None:
    merchant = conn.execute("SELECT status FROM merchants WHERE id=?", (task["merchant_id"],)).fetchone()
    if merchant is None or merchant["status"] != "active":
        return "商户已归档，不能分配任务"
    if task["replaced_by_task_id"] is not None:
        return "任务已被替代，不能转交"
    if task["status"] not in ("PENDING", "NEEDS_ATTENTION"):
        return "仅待处理或需要处理的任务可以转交；运行中及待审批任务须先处理当前执行"
    if conn.execute("SELECT 1 FROM task_executions WHERE task_id=? AND status IN "
                    "('PENDING','DISPATCHING','RUNNING','UNKNOWN') LIMIT 1", (task["id"],)).fetchone():
        return "存在进行中或结果未知的执行，请先核实执行结果"
    return None


def set_assignment(conn: sqlite3.Connection, task: sqlite3.Row, body: AssignmentBody, operator: str) -> None:
    """Caller owns BEGIN IMMEDIATE, merchant authorization and commit/rollback."""
    if body.expected_version != task["version"]:
        raise HTTPException(409, "task changed; refresh and retry")
    if reason := assignment_lock_reason(conn, task):
        raise HTTPException(409, reason)
    if body.assignee_type == "HUMAN" and body.assignee_id != operator:
        raise HTTPException(422, "人工负责人只能是当前登录的 AM")
    if body.assignee_type == "AGENT" and not conn.execute(
        "SELECT 1 FROM seo_ops_agents WHERE id=? AND status='active'", (body.assignee_id,)
    ).fetchone():
        raise HTTPException(422, "请选择已注册且启用的 Agent")
    before = assignment_view(conn, task["id"])
    if (before is None and body.assignee_type is None) or (before is not None and
        (before["assignee_type"], before["assignee_id"]) == (body.assignee_type, body.assignee_id)):
        return
    stamp = now_iso()
    if body.assignee_type is None:
        conn.execute("DELETE FROM task_assignments WHERE task_id=?", (task["id"],))
    else:
        conn.execute(
            "INSERT INTO task_assignments (task_id,assignee_type,operator_username,agent_id,updated_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET "
            "assignee_type=excluded.assignee_type,operator_username=excluded.operator_username,"
            "agent_id=excluded.agent_id,updated_at=excluded.updated_at",
            (task["id"], body.assignee_type, body.assignee_id if body.assignee_type == "HUMAN" else None,
             body.assignee_id if body.assignee_type == "AGENT" else None, stamp),
        )
    updated = conn.execute("UPDATE tasks SET version=version+1,updated_at=? WHERE id=? AND version=?",
                           (stamp, task["id"], body.expected_version))
    if updated.rowcount != 1:
        raise HTTPException(409, "task changed; refresh and retry")
    append_task_event(conn, entity_type="TASK", entity_id=task["id"], event_type="TASK_ASSIGNED",
                      actor_type="OPERATOR", actor_id=operator,
                      payload={"before": before, "after": assignment_view(conn, task["id"]),
                               "reason": body.reason, "expected_version": body.expected_version})

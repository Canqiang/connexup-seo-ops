"""One-shot manual Agent dispatch and fenced read-only reconciliation."""
import json
import uuid

from fastapi import HTTPException

from .coreai import CoreAiError, TERMINAL_STATUSES, sanitize_coreai_error, validate_run_detail
from .execution_result import normalize_execution_output
from .merchants import fetch_active_merchant, now_iso
from .task_events import append_task_event
from .task_plans import refresh_plan_lifecycle
from .task_workflows import assert_transition
from .task_agent_protocol import (PROTOCOL, agent_snapshot, binding_for_task, canonical,
                                  digest, valid_id, validate_agent_request)


def start_agent_preparation(conn, task_id, expected_version, operator, client):
    from . import tasks
    task = tasks.fetch_task(conn, task_id)
    binding = binding_for_task(conn, task_id)
    if not binding:
        raise HTTPException(409, "专用 Agent 未配置执行绑定或已停用")
    if task["version"] != expected_version or task["status"] != "PENDING":
        raise HTTPException(409, "task changed; refresh and retry")
    lifecycle = tasks._merchant_lifecycle_token(conn, task["merchant_id"])
    try:
        snapshot = agent_snapshot(client.get_agent(binding["coreai_agent_id"]), binding["coreai_agent_id"])
        if digest(snapshot) != binding["config_sha256"]:
            raise ValueError("Agent 配置已变化，请创建替代 Agent 并重新绑定")
    except (ValueError, CoreAiError) as exc:
        raise HTTPException(409, sanitize_coreai_error(str(exc))) from exc
    conn.execute("BEGIN IMMEDIATE")
    try:
        task = tasks.fetch_task(conn, task_id)
        merchant = fetch_active_merchant(conn, task["merchant_id"])
        if (task["version"] != expected_version or task["status"] != "PENDING"
                or task["task_type"] != "PREPARE_ONLY"
                or task["workflow_version"] != tasks.WORKFLOW_TEMPLATES["PREPARE_ONLY"].version
                or task["replaced_by_task_id"] is not None
                or binding_for_task(conn, task_id) != binding
                or tasks._merchant_lifecycle_token(conn, task["merchant_id"]) != lifecycle
                or tasks._blocker(conn, task) is not None
                or conn.execute("SELECT 1 FROM task_executions WHERE task_id=? AND status IN "
                                "('PENDING','DISPATCHING','RUNNING','UNKNOWN')", (task_id,)).fetchone()):
            raise HTTPException(409, "task changed or is not ready for Agent preparation")
        request = dict(executor_kind=PROTOCOL, task_id=task_id, workflow_version=task["workflow_version"],
                       definition_checksum=task["definition_checksum"], stage="PREPARATION",
                       input=tasks.build_execution_input(task, merchant, tasks.latest_execution(conn, task_id)),
                       local_agent_id=binding["local_agent_id"], coreai_agent_id=binding["coreai_agent_id"],
                       agent_name=binding["display_name"], config_sha256=binding["config_sha256"],
                       agent_snapshot=snapshot, operator=operator, merchant_lifecycle=list(lifecycle))
        checksum = digest(request)
        attempt = conn.execute("SELECT COALESCE(MAX(attempt),0)+1 FROM task_executions WHERE task_id=? AND stage='PREPARATION'", (task_id,)).fetchone()[0]
        stamp, token = now_iso(), uuid.uuid4().hex
        assert_transition(task["task_type"], task["status"], "PREPARING")
        conn.execute("UPDATE tasks SET status='PREPARING',version=version+1,updated_at=?,started_at=COALESCE(started_at,?) WHERE id=?", (stamp, stamp, task_id))
        execution_id = conn.execute(
            "INSERT INTO task_executions (task_id,stage,status,attempt,request_json,request_checksum,"
            "idempotency_key,dispatch_token,dispatch_started_at,evidence_json,created_at) "
            "VALUES (?,'PREPARATION','DISPATCHING',?,?,?,?,?,?,'[]',?)",
            (task_id, attempt, canonical(request), checksum, f"task:{task_id}:preparation:{attempt}:{checksum[:16]}", token, stamp, stamp),
        ).lastrowid
        append_task_event(conn, entity_type="TASK", entity_id=task_id, event_type="TASK_PREPARATION_CLAIMED",
                          actor_type="OPERATOR", actor_id=operator,
                          payload={"execution_id": execution_id, "attempt": attempt, "agent_id": binding["local_agent_id"]})
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    # A network failure is conservatively unknown; never repeat trigger automatically.
    try:
        response = client.trigger(binding["coreai_agent_id"], request["input"])
        if not isinstance(response, dict) or not valid_id(response.get("run_id")):
            raise ValueError("Agent trigger returned no valid run ID")
        run_id = response["run_id"]
        conn.execute("BEGIN IMMEDIATE")
        current_task = tasks.fetch_task(conn, task_id)
        current = conn.execute("SELECT * FROM task_executions WHERE id=?", (execution_id,)).fetchone()
        if (current_task["version"] != expected_version + 1 or current_task["status"] != "PREPARING"
                or tasks._merchant_lifecycle_token(conn, task["merchant_id"]) != lifecycle
                or current["status"] != "DISPATCHING" or current["dispatch_token"] != token):
            raise ValueError("Agent dispatch lifecycle changed; reconcile before retry")
        if conn.execute("SELECT 1 FROM task_executions WHERE coreai_run_id=?", (run_id,)).fetchone():
            raise ValueError("Agent run ID is already bound to another execution")
        conn.execute("UPDATE task_executions SET status='RUNNING',coreai_run_id=? WHERE id=?", (run_id, execution_id))
        append_task_event(conn, entity_type="TASK", entity_id=task_id, event_type="TASK_PREPARATION_STARTED",
                          actor_type="SYSTEM", actor_id=binding["coreai_agent_id"],
                          payload={"execution_id": execution_id, "coreai_run_id": run_id})
        conn.commit()
    except Exception as exc:
        conn.rollback()
        tasks._finish_failed_dispatch(conn, execution_id, task_id, sanitize_coreai_error(str(exc)),
                                      dispatch_token=token, expected_task_version=expected_version + 1,
                                      merchant_lifecycle=lifecycle, ambiguous=True)
    return tasks._execution_response(conn, conn.execute("SELECT * FROM task_executions WHERE id=?", (execution_id,)).fetchone())


def poll_agent_preparation(conn, execution, client):
    from . import tasks
    from .scheduler import _task_execution_poll_is_stale
    from datetime import datetime, timezone

    task = tasks.fetch_task(conn, execution["task_id"])
    if task["status"] != "PREPARING":
        return
    lifecycle = tasks._merchant_lifecycle_token(conn, task["merchant_id"])
    stamp = now_iso()
    result_json, error, execution_status = None, None, "UNKNOWN"
    try:
        request = validate_agent_request(execution, task)
        if list(lifecycle) != request["merchant_lifecycle"]:
            return
        fetch_active_merchant(conn, task["merchant_id"])
        core = validate_run_detail(client.get_run(execution["coreai_run_id"]), execution["coreai_run_id"])
        if core.get("agent_id") != request["coreai_agent_id"] or core.get("input") != request["input"]:
            raise ValueError("Agent run identity or input mismatch")
        if core["status"] not in TERMINAL_STATUSES:
            if _task_execution_poll_is_stale(execution, datetime.now(timezone.utc)):
                raise ValueError("Agent run polling exceeded confirmation deadline")
            return
        if core["status"] == "COMPLETED":
            current_config = agent_snapshot(client.get_agent(request["coreai_agent_id"]), request["coreai_agent_id"])
            if digest(current_config) != request["config_sha256"]:
                raise ValueError("Agent configuration changed during preparation")
            try:
                result_json = normalize_execution_output(core.get("output"))
            except ValueError as exc:
                execution_status = "FAILED"
                raise ValueError(str(exc)) from exc
            execution_status = "SUCCEEDED"
        else:
            execution_status = "FAILED"
            error = sanitize_coreai_error(core.get("error"), f"Agent run {core['status']}")
    except CoreAiError as exc:
        if exc.status_code not in (404, 410) and not _task_execution_poll_is_stale(execution, datetime.now(timezone.utc)):
            return
        error = sanitize_coreai_error(str(exc))
    except (KeyError, TypeError, ValueError) as exc:
        error = sanitize_coreai_error(str(exc))
    target = "AWAITING_APPROVAL" if execution_status == "SUCCEEDED" else "NEEDS_ATTENTION"
    conn.execute("BEGIN IMMEDIATE")
    try:
        current_task = tasks.fetch_task(conn, task["id"])
        current = conn.execute("SELECT * FROM task_executions WHERE id=?", (execution["id"],)).fetchone()
        if (current is None or current["status"] != "RUNNING" or current["coreai_run_id"] != execution["coreai_run_id"]
                or current["dispatch_token"] != execution["dispatch_token"] or current["request_json"] != execution["request_json"]
                or current["request_checksum"] != execution["request_checksum"]
                or current_task["version"] != task["version"] or current_task["status"] != "PREPARING"
                or current_task["definition_checksum"] != task["definition_checksum"]
                or tasks._merchant_lifecycle_token(conn, task["merchant_id"]) != lifecycle):
            conn.rollback()
            return
        fetch_active_merchant(conn, task["merchant_id"])
        assert_transition(task["task_type"], "PREPARING", target)
        evidence = canonical(json.loads(result_json)["evidence"]) if result_json else "[]"
        conn.execute("UPDATE task_executions SET status=?,result_json=?,evidence_json=?,error=?,finished_at=? WHERE id=?",
                     (execution_status, result_json, evidence, error, stamp, execution["id"]))
        conn.execute("UPDATE tasks SET status=?,version=version+1,updated_at=? WHERE id=?", (target, stamp, task["id"]))
        append_task_event(conn, entity_type="TASK", entity_id=task["id"], event_type=f"TASK_PREPARATION_{execution_status}",
                          actor_type="SYSTEM", actor_id=None,
                          payload={"execution_id": execution["id"], "coreai_run_id": execution["coreai_run_id"], "error": error})
        refresh_plan_lifecycle(conn, int(task["plan_id"]))
        conn.commit()
    except Exception:
        conn.rollback()
        raise

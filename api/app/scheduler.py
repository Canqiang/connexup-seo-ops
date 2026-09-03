import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from .audit_snapshots import persist_audit_snapshot
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect
from .execution_result import normalize_execution_output
from .merchants import now_iso
from .runs import has_running_run, start_run
from .seo_targets import SeoAgentIds, poll_seo_targets_once
from .task_events import append_task_event
from .task_plan_contract import TaskPlanValidationError, extract_task_plan
from .task_plans import persist_agent_plan, refresh_plan_lifecycle
from .task_workflows import assert_transition, enabled_task_types

logger = logging.getLogger("seo_ops.scheduler")

POLL_INTERVAL_SECONDS = 30
SCAN_EVERY_TICKS = 120  # 120 * 30s = 1 小时


def poll_runs_once(client) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM runs WHERE status = 'running' AND coreai_run_id IS NOT NULL"
        ).fetchall()
        for run in rows:
            try:
                core = client.get_run(run["coreai_run_id"])
            except CoreAiError as e:
                logger.warning("poll run %s failed, stays running: %s", run["id"], e)
                continue
            status = core["status"]
            if status not in TERMINAL_STATUSES:
                continue
            # Validate completed_at timestamp; fall back to now_iso() on invalid
            # format, wrong type, or a naive (no-tzinfo) value.
            completed_at = core.get("completed_at")
            finished_at = now_iso()
            if isinstance(completed_at, str) and completed_at:
                try:
                    parsed = datetime.fromisoformat(completed_at)
                except (ValueError, TypeError):
                    logger.warning("poll run %s has malformed completed_at %r, using now", run["id"], completed_at)
                else:
                    if parsed.tzinfo is not None:
                        finished_at = completed_at
                    else:
                        logger.warning("poll run %s has naive completed_at %r, using now", run["id"], completed_at)
            elif completed_at:
                logger.warning("poll run %s has non-string completed_at %r, using now", run["id"], completed_at)
            if status == "COMPLETED":
                report = core.get("output") or None
                conn.execute(
                    "UPDATE runs SET status = 'succeeded', report_text = ?, finished_at = ? WHERE id = ?",
                    (report, finished_at, run["id"]),
                )
                try:
                    persist_audit_snapshot(conn, run, report, finished_at)
                except ValueError:
                    logger.info("run %s returned a legacy non-Audit report", run["id"])
                try:
                    validated = extract_task_plan(report, enabled_task_types())
                except TaskPlanValidationError as exc:
                    logger.info(
                        "run %s returned an invalid strict Task Plan: %s",
                        run["id"],
                        ",".join(exc.codes),
                    )
                else:
                    if validated is not None:
                        persist_agent_plan(
                            conn,
                            merchant_id=run["merchant_id"],
                            run_id=run["id"],
                            coreai_run_id=run["coreai_run_id"],
                            validated=validated,
                        )
            else:
                conn.execute(
                    "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                    (core.get("error") or f"core-ai status {status}", finished_at, run["id"]),
                )
            conn.commit()
    finally:
        conn.close()


def poll_task_executions_once(client) -> None:
    conn = connect()
    try:
        executions = conn.execute(
            "SELECT * FROM task_executions WHERE stage = 'PREPARATION' "
            "AND status = 'RUNNING' AND coreai_run_id IS NOT NULL ORDER BY id"
        ).fetchall()
        for execution in executions:
            try:
                core = client.get_run(execution["coreai_run_id"])
            except CoreAiError as exc:
                logger.warning("poll task execution %s failed, stays running: %s", execution["id"], exc)
                continue
            status = core["status"]
            if status not in TERMINAL_STATUSES:
                continue
            finished_at = now_iso()
            completed_at = core.get("completed_at")
            if isinstance(completed_at, str) and completed_at:
                try:
                    parsed = datetime.fromisoformat(completed_at)
                except (ValueError, TypeError):
                    logger.warning("task execution %s has malformed completed_at %r", execution["id"], completed_at)
                else:
                    if parsed.tzinfo is not None:
                        finished_at = completed_at
            result_json: str | None = None
            error: str | None = None
            if status == "COMPLETED":
                try:
                    result_json = normalize_execution_output(core.get("output"))
                except ValueError as exc:
                    error = str(exc)
            else:
                error = core.get("error") or f"core-ai status {status}"

            conn.execute("BEGIN IMMEDIATE")
            try:
                current = conn.execute(
                    "SELECT * FROM task_executions WHERE id = ?", (execution["id"],)
                ).fetchone()
                if current is None or current["status"] != "RUNNING":
                    conn.rollback()
                    continue
                task = conn.execute(
                    "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
                ).fetchone()
                if task is None or task["status"] != "PREPARING":
                    raise RuntimeError("active preparation is detached from its PREPARING Task")

                if result_json is not None:
                    assert_transition(task["task_type"], task["status"], "AWAITING_APPROVAL")
                    evidence_json = json.dumps(
                        json.loads(result_json)["evidence"],
                        ensure_ascii=False,
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                    execution_update = conn.execute(
                        "UPDATE task_executions SET status = 'SUCCEEDED', result_json = ?, "
                        "evidence_json = ?, error = NULL, finished_at = ? "
                        "WHERE id = ? AND status = 'RUNNING'",
                        (result_json, evidence_json, finished_at, current["id"]),
                    )
                    task_update = conn.execute(
                        "UPDATE tasks SET status = 'AWAITING_APPROVAL', version = version + 1, "
                        "updated_at = ? WHERE id = ? AND version = ? AND status = 'PREPARING'",
                        (finished_at, task["id"], task["version"]),
                    )
                    event_type = "TASK_PREPARATION_SUCCEEDED"
                    payload = {"execution_id": current["id"], "to_status": "AWAITING_APPROVAL"}
                else:
                    assert_transition(task["task_type"], task["status"], "NEEDS_ATTENTION")
                    execution_update = conn.execute(
                        "UPDATE task_executions SET status = 'FAILED', error = ?, finished_at = ? "
                        "WHERE id = ? AND status = 'RUNNING'",
                        (error, finished_at, current["id"]),
                    )
                    task_update = conn.execute(
                        "UPDATE tasks SET status = 'NEEDS_ATTENTION', version = version + 1, "
                        "updated_at = ? WHERE id = ? AND version = ? AND status = 'PREPARING'",
                        (finished_at, task["id"], task["version"]),
                    )
                    event_type = "TASK_PREPARATION_FAILED"
                    payload = {"error": error, "execution_id": current["id"]}
                if execution_update.rowcount != 1 or task_update.rowcount != 1:
                    raise RuntimeError("task preparation state changed during polling")
                append_task_event(
                    conn,
                    entity_type="TASK",
                    entity_id=int(task["id"]),
                    event_type=event_type,
                    actor_type="SYSTEM",
                    actor_id=None,
                    payload=payload,
                )
                refresh_plan_lifecycle(conn, int(task["plan_id"]))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
    finally:
        conn.close()


def auto_scan_once(client, agent_id: str) -> None:
    conn = connect()
    try:
        merchants = conn.execute(
            "SELECT * FROM merchants WHERE status = 'active' AND auto_run_interval_days IS NOT NULL"
        ).fetchall()
        now = datetime.now(timezone.utc)
        for merchant in merchants:
            try:
                if has_running_run(conn, merchant["id"]):
                    continue
                last = conn.execute(
                    "SELECT finished_at, created_at FROM runs WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
                    (merchant["id"],),
                ).fetchone()
                if last is not None:
                    anchor = datetime.fromisoformat(last["finished_at"] or last["created_at"])
                    if now - anchor < timedelta(days=merchant["auto_run_interval_days"]):
                        continue
                start_run(conn, client, agent_id, merchant, "auto")
            except Exception:
                logger.exception("auto_scan merchant %s failed, continuing", merchant["id"])
    finally:
        conn.close()


async def scheduler_loop() -> None:
    settings = coreai_settings()
    if settings is None:
        logger.info("core-ai not configured; scheduler disabled")
        return
    client = CoreAiClient(settings.base_url, settings.api_key)
    tick = 0
    while True:
        try:
            await asyncio.to_thread(poll_runs_once, client)
            await asyncio.to_thread(poll_task_executions_once, client)
            if settings.keyword_agent_id and settings.audit_agent_id and settings.ranking_agent_id:
                await asyncio.to_thread(
                    poll_seo_targets_once,
                    client,
                    SeoAgentIds(
                        settings.keyword_agent_id,
                        settings.audit_agent_id,
                        settings.ranking_agent_id,
                    ),
                )
            if tick % SCAN_EVERY_TICKS == 0:
                await asyncio.to_thread(auto_scan_once, client, settings.agent_id)
        except Exception:
            logger.exception("scheduler tick failed")
        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)

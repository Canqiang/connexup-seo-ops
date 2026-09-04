import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from .audit_snapshots import persist_audit_snapshot
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES, validate_run_detail
from .db import connect
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
TASK_LLM_DISPATCH_STALE_AFTER = timedelta(minutes=15)
TASK_COREAI_POLL_STALE_AFTER = timedelta(minutes=15)
TASK_LLM_DISPATCH_STALE_ERROR = (
    "synchronous LLM call exceeded the 15-minute dispatch recovery ceiling; "
    "outcome unknown"
)
TASK_LEGACY_AGENT_UNREVIEWABLE_ERROR = (
    "historical Agent preparation completed without a trusted LLM Call envelope; "
    "result is unreviewable"
)


def poll_runs_once(client) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM runs WHERE status = 'running' AND coreai_run_id IS NOT NULL"
        ).fetchall()
        for run in rows:
            try:
                core = validate_run_detail(
                    client.get_run(run["coreai_run_id"]), run["coreai_run_id"]
                )
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


def _recover_stale_task_dispatches(conn) -> None:
    from .tasks import _validated_llm_call_request

    now = datetime.now(timezone.utc)
    candidates = conn.execute(
        "SELECT * FROM task_executions WHERE stage = 'PREPARATION' "
        "AND status = 'DISPATCHING' AND coreai_run_id IS NULL ORDER BY id"
    ).fetchall()
    for candidate in candidates:
        try:
            dispatch_started_at = datetime.fromisoformat(candidate["dispatch_started_at"])
            request = _validated_llm_call_request(candidate)
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            logger.warning(
                "stale task dispatch %s has an invalid recovery envelope; left untouched",
                candidate["id"],
            )
            continue
        if (
            dispatch_started_at.tzinfo is None
            or now - dispatch_started_at < TASK_LLM_DISPATCH_STALE_AFTER
        ):
            continue

        conn.execute("BEGIN IMMEDIATE")
        try:
            current = conn.execute(
                "SELECT * FROM task_executions WHERE id = ?", (candidate["id"],)
            ).fetchone()
            if (
                current is None
                or current["status"] != "DISPATCHING"
                or current["coreai_run_id"] is not None
                or current["dispatch_token"] != candidate["dispatch_token"]
                or current["dispatch_started_at"] != candidate["dispatch_started_at"]
            ):
                conn.rollback()
                continue
            current_started_at = datetime.fromisoformat(current["dispatch_started_at"])
            current_request = _validated_llm_call_request(current)
            if (
                current_started_at.tzinfo is None
                or now - current_started_at < TASK_LLM_DISPATCH_STALE_AFTER
            ):
                conn.rollback()
                continue
            task = conn.execute(
                "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
            ).fetchone()
            if (
                task is None
                or task["status"] != "PREPARING"
                or current_request != request
                or current_request["task_id"] != task["id"]
                or current_request["workflow_version"] != task["workflow_version"]
                or current_request["definition_checksum"] != task["definition_checksum"]
            ):
                conn.rollback()
                logger.warning(
                    "stale task dispatch %s is detached from its exact PREPARING Task; left untouched",
                    current["id"],
                )
                continue

            assert_transition(task["task_type"], task["status"], "NEEDS_ATTENTION")
            finished_at = now_iso()
            execution_update = conn.execute(
                "UPDATE task_executions SET status = 'UNKNOWN', error = ?, finished_at = ? "
                "WHERE id = ? AND status = 'DISPATCHING' AND coreai_run_id IS NULL "
                "AND dispatch_token = ? AND dispatch_started_at = ?",
                (
                    TASK_LLM_DISPATCH_STALE_ERROR,
                    finished_at,
                    current["id"],
                    current["dispatch_token"],
                    current["dispatch_started_at"],
                ),
            )
            task_update = conn.execute(
                "UPDATE tasks SET status = 'NEEDS_ATTENTION', version = version + 1, "
                "updated_at = ? WHERE id = ? AND version = ? AND status = 'PREPARING'",
                (finished_at, task["id"], task["version"]),
            )
            if execution_update.rowcount != 1 or task_update.rowcount != 1:
                conn.rollback()
                continue
            append_task_event(
                conn,
                entity_type="TASK",
                entity_id=int(task["id"]),
                event_type="TASK_PREPARATION_UNKNOWN",
                actor_type="SYSTEM",
                actor_id=None,
                payload={
                    "ambiguous": True,
                    "error": TASK_LLM_DISPATCH_STALE_ERROR,
                    "execution_id": current["id"],
                    "reason": "stale_dispatch_timeout",
                },
            )
            refresh_plan_lifecycle(conn, int(task["plan_id"]))
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def recover_stale_task_dispatches_once() -> None:
    """Run durable recovery without requiring any Core AI configuration."""

    conn = connect()
    try:
        _recover_stale_task_dispatches(conn)
    finally:
        conn.close()


def _task_execution_poll_is_stale(execution, now: datetime) -> bool:
    started_at = execution["dispatch_started_at"] or execution["created_at"]
    try:
        parsed = datetime.fromisoformat(started_at)
    except (TypeError, ValueError):
        return True
    if parsed.tzinfo is None or parsed > now:
        return True
    return now - parsed >= TASK_COREAI_POLL_STALE_AFTER


def _mark_task_execution_poll_unknown(
    conn,
    execution,
    *,
    error: str,
    reason: str,
) -> None:
    """Atomically stop an unresolvable historical Agent preparation."""

    conn.execute("BEGIN IMMEDIATE")
    try:
        current = conn.execute(
            "SELECT * FROM task_executions WHERE id = ?", (execution["id"],)
        ).fetchone()
        if (
            current is None
            or current["status"] != "RUNNING"
            or current["coreai_run_id"] != execution["coreai_run_id"]
        ):
            conn.rollback()
            return
        task = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
        ).fetchone()
        if task is None or task["status"] != "PREPARING":
            raise RuntimeError("active preparation is detached from its PREPARING Task")

        assert_transition(task["task_type"], task["status"], "NEEDS_ATTENTION")
        finished_at = now_iso()
        execution_update = conn.execute(
            "UPDATE task_executions SET status = 'UNKNOWN', error = ?, finished_at = ? "
            "WHERE id = ? AND status = 'RUNNING' AND coreai_run_id = ?",
            (error, finished_at, current["id"], current["coreai_run_id"]),
        )
        task_update = conn.execute(
            "UPDATE tasks SET status = 'NEEDS_ATTENTION', version = version + 1, "
            "updated_at = ? WHERE id = ? AND version = ? AND status = 'PREPARING'",
            (finished_at, task["id"], task["version"]),
        )
        if execution_update.rowcount != 1 or task_update.rowcount != 1:
            raise RuntimeError("task preparation state changed during polling")
        append_task_event(
            conn,
            entity_type="TASK",
            entity_id=int(task["id"]),
            event_type="TASK_PREPARATION_UNKNOWN",
            actor_type="SYSTEM",
            actor_id=None,
            payload={
                "ambiguous": True,
                "error": error,
                "execution_id": current["id"],
                "reason": reason,
            },
        )
        refresh_plan_lifecycle(conn, int(task["plan_id"]))
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def poll_task_executions_once(client) -> None:
    conn = connect()
    try:
        _recover_stale_task_dispatches(conn)
        executions = conn.execute(
            "SELECT * FROM task_executions WHERE stage = 'PREPARATION' "
            "AND status = 'RUNNING' AND coreai_run_id IS NOT NULL ORDER BY id"
        ).fetchall()
        for execution in executions:
            try:
                core = validate_run_detail(
                    client.get_run(execution["coreai_run_id"]),
                    execution["coreai_run_id"],
                )
            except CoreAiError as exc:
                missing = exc.status_code in {404, 410}
                stale = _task_execution_poll_is_stale(
                    execution, datetime.now(timezone.utc)
                )
                if missing or stale:
                    reason = "coreai_run_not_found" if missing else "coreai_poll_stale"
                    _mark_task_execution_poll_unknown(
                        conn,
                        execution,
                        error=f"core-ai run polling could not confirm outcome: {exc}",
                        reason=reason,
                    )
                else:
                    logger.warning(
                        "poll task execution %s failed, stays running: %s",
                        execution["id"],
                        exc,
                    )
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
            if status == "COMPLETED":
                execution_status = "UNKNOWN"
                error = TASK_LEGACY_AGENT_UNREVIEWABLE_ERROR
                event_type = "TASK_PREPARATION_UNKNOWN"
                payload = {
                    "ambiguous": True,
                    "error": error,
                    "execution_id": execution["id"],
                    "reason": "legacy_agent_unreviewable",
                }
            else:
                execution_status = "FAILED"
                error = core.get("error") or f"core-ai status {status}"
                event_type = "TASK_PREPARATION_FAILED"
                payload = {"error": error, "execution_id": execution["id"]}

            conn.execute("BEGIN IMMEDIATE")
            try:
                current = conn.execute(
                    "SELECT * FROM task_executions WHERE id = ?", (execution["id"],)
                ).fetchone()
                if (
                    current is None
                    or current["status"] != "RUNNING"
                    or current["coreai_run_id"] != execution["coreai_run_id"]
                ):
                    conn.rollback()
                    continue
                task = conn.execute(
                    "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
                ).fetchone()
                if task is None or task["status"] != "PREPARING":
                    raise RuntimeError("active preparation is detached from its PREPARING Task")

                assert_transition(task["task_type"], task["status"], "NEEDS_ATTENTION")
                execution_update = conn.execute(
                    "UPDATE task_executions SET status = ?, error = ?, finished_at = ? "
                    "WHERE id = ? AND status = 'RUNNING' AND coreai_run_id = ?",
                    (
                        execution_status,
                        error,
                        finished_at,
                        current["id"],
                        current["coreai_run_id"],
                    ),
                )
                task_update = conn.execute(
                    "UPDATE tasks SET status = 'NEEDS_ATTENTION', version = version + 1, "
                    "updated_at = ? WHERE id = ? AND version = ? AND status = 'PREPARING'",
                    (finished_at, task["id"], task["version"]),
                )
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
        logger.info(
            "core-ai not configured; network jobs disabled, "
            "DB stale-dispatch recovery remains active"
        )
        client = None
    else:
        client = CoreAiClient(settings.base_url, settings.api_key)
    tick = 0
    while True:
        try:
            if client is None:
                await asyncio.to_thread(recover_stale_task_dispatches_once)
            else:
                await asyncio.to_thread(poll_runs_once, client)
                await asyncio.to_thread(poll_task_executions_once, client)
                if (
                    settings.keyword_agent_id
                    and settings.audit_agent_id
                    and settings.ranking_agent_id
                ):
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

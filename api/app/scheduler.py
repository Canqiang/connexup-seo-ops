import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Callable

from .audit_snapshots import persist_audit_snapshot
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES, validate_run_detail
from .db import connect
from .local_falcon import LocalFalconClient
from .merchant_profiles import (
    gbp_sync_due,
    get_fbr_client,
    sync_gbp_profile_once,
)
from .merchants import merchant_lifecycle_token, now_iso
from .runs import has_running_run, recover_stale_run_dispatches_once, start_run
from .seo_targets import (
    SeoAgentIds,
    poll_acknowledged_local_falcon_reports_once,
    poll_seo_targets_once,
    recover_stale_seo_dispatches_once,
    submit_local_falcon_batches_once,
)
from .task_events import append_task_event
from .task_plan_contract import TaskPlanValidationError, extract_task_plan
from .task_plans import persist_agent_plan, refresh_plan_lifecycle
from .task_workflows import assert_transition, enabled_task_types

logger = logging.getLogger("seo_ops.scheduler")

POLL_INTERVAL_SECONDS = 30
SCAN_EVERY_TICKS = 120  # 120 * 30s = 1 小时
FBR_DUE_CHECK_EVERY_TICKS = 1
TASK_LLM_DISPATCH_STALE_AFTER = timedelta(minutes=15)
TASK_COREAI_POLL_STALE_AFTER = timedelta(minutes=15)
RUN_COREAI_POLL_STALE_AFTER = timedelta(minutes=15)
COREAI_RUN_NO_LONGER_AVAILABLE = "COREAI_RUN_NO_LONGER_AVAILABLE"
COREAI_RUN_POLL_STALE = "COREAI_RUN_POLL_STALE"
TASK_LLM_DISPATCH_STALE_ERROR = (
    "synchronous LLM call exceeded the 15-minute dispatch recovery ceiling; "
    "outcome unknown"
)
TASK_LEGACY_AGENT_UNREVIEWABLE_ERROR = (
    "historical Agent preparation completed without a trusted LLM Call envelope; "
    "result is unreviewable"
)
MERCHANT_LIFECYCLE_CHANGED_DURING_RUN = "MERCHANT_LIFECYCLE_CHANGED_DURING_RUN"


def seo_target_poll_agents(settings) -> SeoAgentIds | None:
    """Return poll routing for legacy Agents or Skill-backed keywords."""

    legacy_configured = bool(
        settings.keyword_agent_id
        and settings.audit_agent_id
        and settings.ranking_agent_id
    )
    skill_workflow_configured = bool(
        settings.keyword_skill_agent_id
        and settings.keyword_seed_skill_id
        and settings.keyword_ranking_skill_id
    )
    if not (legacy_configured or skill_workflow_configured):
        return None
    return SeoAgentIds(
        settings.keyword_agent_id or settings.keyword_skill_agent_id or "",
        settings.audit_agent_id or "",
        settings.ranking_agent_id or "",
    )


def _merchant_lifecycle_token(conn, merchant_id: int) -> tuple[str, int, str]:
    return merchant_lifecycle_token(conn, merchant_id)


def _run_lifecycle_claim(run) -> tuple[int, str] | None:
    generation = run["merchant_lifecycle_generation"]
    content_sha = run["merchant_lifecycle_sha256"]
    if not isinstance(generation, int) or not isinstance(content_sha, str):
        return None
    if len(content_sha) != 64:
        return None
    return generation, content_sha


def _run_matches_poll_claim(current, run, lifecycle_claim) -> bool:
    return bool(
        current is not None
        and current["status"] == "running"
        and current["dispatch_state"] == "DISPATCHED"
        and current["coreai_run_id"] == run["coreai_run_id"]
        and current["dispatch_token"] == run["dispatch_token"]
        and current["dispatch_started_at"] == run["dispatch_started_at"]
        and current["provider_candidate_run_id"] == run["provider_candidate_run_id"]
        and current["merchant_id"] == run["merchant_id"]
        and current["merchant_lifecycle_generation"] == lifecycle_claim[0]
        and current["merchant_lifecycle_sha256"] == lifecycle_claim[1]
    )


def _lifecycle_is_current(conn, run, lifecycle_claim) -> bool:
    try:
        current = _merchant_lifecycle_token(conn, int(run["merchant_id"]))
    except RuntimeError:
        return False
    return current == ("active", lifecycle_claim[0], lifecycle_claim[1])


def _terminalize_bound_run(conn, current, *, error: str) -> bool:
    """Detach a bound run whose result can no longer be accepted locally."""

    updated = conn.execute(
        "UPDATE runs SET provider_candidate_run_id="
        "COALESCE(provider_candidate_run_id,coreai_run_id),coreai_run_id=NULL,"
        "status='failed',dispatch_state='FAILED',error=?,finished_at=?,"
        "poll_failure_started_at=NULL WHERE id=? AND status='running' "
        "AND dispatch_state='DISPATCHED' AND coreai_run_id=? "
        "AND merchant_lifecycle_generation IS ? AND merchant_lifecycle_sha256 IS ?",
        (
            error,
            now_iso(),
            current["id"],
            current["coreai_run_id"],
            current["merchant_lifecycle_generation"],
            current["merchant_lifecycle_sha256"],
        ),
    )
    return updated.rowcount == 1


def _fence_run_poll(
    conn, run, lifecycle_claim, *, clear_poll_failure: bool = False
) -> bool:
    """Atomically verify the original lifecycle claim or finalize stale work."""

    conn.execute("BEGIN IMMEDIATE")
    try:
        current = conn.execute("SELECT * FROM runs WHERE id=?", (run["id"],)).fetchone()
        if not _run_matches_poll_claim(current, run, lifecycle_claim):
            conn.rollback()
            return False
        if _lifecycle_is_current(conn, current, lifecycle_claim):
            if clear_poll_failure:
                if current["poll_failure_started_at"] != run["poll_failure_started_at"]:
                    conn.rollback()
                    return False
                updated = conn.execute(
                    "UPDATE runs SET poll_failure_started_at=NULL WHERE id=? "
                    "AND status='running' AND dispatch_state='DISPATCHED' "
                    "AND coreai_run_id=? AND poll_failure_started_at IS ?",
                    (
                        current["id"],
                        current["coreai_run_id"],
                        current["poll_failure_started_at"],
                    ),
                )
                if updated.rowcount != 1:
                    conn.rollback()
                    return False
            conn.commit()
            return True
        _terminalize_bound_run(
            conn, current, error=MERCHANT_LIFECYCLE_CHANGED_DURING_RUN
        )
        conn.commit()
        return False
    except Exception:
        conn.rollback()
        raise


def _handle_run_poll_error(
    conn, run, lifecycle_claim, *, missing: bool, now: datetime
) -> bool:
    """Record a consecutive poll failure or enter operator reconciliation."""

    conn.execute("BEGIN IMMEDIATE")
    try:
        current = conn.execute("SELECT * FROM runs WHERE id=?", (run["id"],)).fetchone()
        if not _run_matches_poll_claim(current, run, lifecycle_claim):
            conn.rollback()
            return False
        if current["poll_failure_started_at"] != run["poll_failure_started_at"]:
            conn.rollback()
            return False
        if not _lifecycle_is_current(conn, current, lifecycle_claim):
            _terminalize_bound_run(
                conn, current, error=MERCHANT_LIFECYCLE_CHANGED_DURING_RUN
            )
            conn.commit()
            return False
        failure_started_at = current["poll_failure_started_at"]
        if not missing and failure_started_at is None:
            updated = conn.execute(
                "UPDATE runs SET poll_failure_started_at=? WHERE id=? "
                "AND status='running' AND dispatch_state='DISPATCHED' "
                "AND coreai_run_id=? AND poll_failure_started_at IS NULL",
                (now.isoformat(), current["id"], current["coreai_run_id"]),
            )
            if updated.rowcount != 1:
                conn.rollback()
                return False
            conn.commit()
            return False
        stale = False
        if not missing:
            try:
                parsed = datetime.fromisoformat(failure_started_at)
            except (TypeError, ValueError):
                stale = True
            else:
                stale = (
                    parsed.tzinfo is None
                    or parsed > now
                    or now - parsed >= RUN_COREAI_POLL_STALE_AFTER
                )
            if not stale:
                conn.commit()
                return False
        error = COREAI_RUN_NO_LONGER_AVAILABLE if missing else COREAI_RUN_POLL_STALE
        if not _terminalize_bound_run(conn, current, error=error):
            conn.rollback()
            return False
        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise


def poll_runs_once(client) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM runs WHERE status='running' "
            "AND dispatch_state='DISPATCHED' AND coreai_run_id IS NOT NULL"
        ).fetchall()
        for run in rows:
            lifecycle_claim = _run_lifecycle_claim(run)
            if lifecycle_claim is None:
                # A legacy binding cannot be trusted for the current lifecycle.
                # Terminalize it locally so it cannot block all future diagnosis.
                conn.execute("BEGIN IMMEDIATE")
                try:
                    current = conn.execute(
                        "SELECT * FROM runs WHERE id=?", (run["id"],)
                    ).fetchone()
                    if current is not None:
                        _terminalize_bound_run(
                            conn,
                            current,
                            error=MERCHANT_LIFECYCLE_CHANGED_DURING_RUN,
                        )
                    conn.commit()
                except Exception:
                    conn.rollback()
                    raise
                continue
            if not _fence_run_poll(conn, run, lifecycle_claim):
                continue
            try:
                core = validate_run_detail(
                    client.get_run(run["coreai_run_id"]), run["coreai_run_id"]
                )
            except CoreAiError as e:
                missing = e.status_code in {404, 410}
                terminalized = _handle_run_poll_error(
                    conn,
                    run,
                    lifecycle_claim,
                    missing=missing,
                    now=datetime.now(timezone.utc),
                )
                if terminalized:
                    logger.warning(
                        "poll run %s terminalized after provider error: %s",
                        run["id"],
                        e,
                    )
                else:
                    logger.warning(
                        "poll run %s failed without accepting a result: %s",
                        run["id"],
                        e,
                    )
                continue
            if not _fence_run_poll(conn, run, lifecycle_claim, clear_poll_failure=True):
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
                    logger.warning(
                        "poll run %s has malformed completed_at %r, using now",
                        run["id"],
                        completed_at,
                    )
                else:
                    if parsed.tzinfo is not None:
                        finished_at = completed_at
                    else:
                        logger.warning(
                            "poll run %s has naive completed_at %r, using now",
                            run["id"],
                            completed_at,
                        )
            elif completed_at:
                logger.warning(
                    "poll run %s has non-string completed_at %r, using now",
                    run["id"],
                    completed_at,
                )
            report = (core.get("output") or None) if status == "COMPLETED" else None
            validated = None
            if status == "COMPLETED":
                try:
                    validated = extract_task_plan(report, enabled_task_types())
                except TaskPlanValidationError as exc:
                    logger.info(
                        "run %s returned an invalid strict Task Plan: %s",
                        run["id"],
                        ",".join(exc.codes),
                    )

            conn.execute("BEGIN IMMEDIATE")
            try:
                current = conn.execute(
                    "SELECT * FROM runs WHERE id=?", (run["id"],)
                ).fetchone()
                if not _run_matches_poll_claim(current, run, lifecycle_claim):
                    conn.rollback()
                    continue
                if not _lifecycle_is_current(conn, current, lifecycle_claim):
                    _terminalize_bound_run(
                        conn,
                        current,
                        error=MERCHANT_LIFECYCLE_CHANGED_DURING_RUN,
                    )
                    conn.commit()
                    continue
                if status == "COMPLETED":
                    updated = conn.execute(
                        "UPDATE runs SET status='succeeded',report_text=?,finished_at=? "
                        "WHERE id=? AND status='running' AND dispatch_state='DISPATCHED' "
                        "AND coreai_run_id=? AND merchant_lifecycle_generation=? "
                        "AND merchant_lifecycle_sha256=?",
                        (
                            report,
                            finished_at,
                            current["id"],
                            current["coreai_run_id"],
                            lifecycle_claim[0],
                            lifecycle_claim[1],
                        ),
                    )
                    if updated.rowcount != 1:
                        conn.rollback()
                        continue
                    succeeded = conn.execute(
                        "SELECT * FROM runs WHERE id=?", (current["id"],)
                    ).fetchone()
                    try:
                        persist_audit_snapshot(conn, succeeded, report, finished_at)
                    except ValueError:
                        logger.info(
                            "run %s returned a legacy non-Audit report", run["id"]
                        )
                    if validated is not None:
                        persist_agent_plan(
                            conn,
                            merchant_id=int(succeeded["merchant_id"]),
                            run_id=int(succeeded["id"]),
                            coreai_run_id=str(succeeded["coreai_run_id"]),
                            validated=validated,
                        )
                else:
                    updated = conn.execute(
                        "UPDATE runs SET status='failed',error=?,finished_at=? "
                        "WHERE id=? AND status='running' AND dispatch_state='DISPATCHED' "
                        "AND coreai_run_id=? AND merchant_lifecycle_generation=? "
                        "AND merchant_lifecycle_sha256=?",
                        (
                            core.get("error") or f"core-ai status {status}",
                            finished_at,
                            current["id"],
                            current["coreai_run_id"],
                            lifecycle_claim[0],
                            lifecycle_claim[1],
                        ),
                    )
                    if updated.rowcount != 1:
                        conn.rollback()
                        continue
                conn.commit()
            except Exception:
                conn.rollback()
                raise
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
            dispatch_started_at = datetime.fromisoformat(
                candidate["dispatch_started_at"]
            )
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
                or _merchant_lifecycle_token(conn, int(task["merchant_id"]))[0]
                != "active"
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


def _task_execution_claim(conn, execution) -> dict[str, object] | None:
    task = conn.execute(
        "SELECT * FROM tasks WHERE id=?", (execution["task_id"],)
    ).fetchone()
    if task is None or task["status"] != "PREPARING":
        return None
    lifecycle_token = _merchant_lifecycle_token(conn, int(task["merchant_id"]))
    if lifecycle_token[0] != "active":
        return None
    return {
        "execution_id": int(execution["id"]),
        "execution_status": str(execution["status"]),
        "coreai_run_id": str(execution["coreai_run_id"]),
        "dispatch_token": execution["dispatch_token"],
        "dispatch_started_at": execution["dispatch_started_at"],
        "task_id": int(task["id"]),
        "task_status": str(task["status"]),
        "task_version": int(task["version"]),
        "workflow_version": int(task["workflow_version"]),
        "definition_checksum": str(task["definition_checksum"]),
        "merchant_id": int(task["merchant_id"]),
        "merchant_lifecycle": lifecycle_token,
    }


def _mark_task_execution_poll_unknown(
    conn,
    execution,
    *,
    claim: dict[str, object],
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
            or current["coreai_run_id"] != claim["coreai_run_id"]
            or current["dispatch_token"] != claim["dispatch_token"]
            or current["dispatch_started_at"] != claim["dispatch_started_at"]
            or current["task_id"] != claim["task_id"]
        ):
            conn.rollback()
            return
        task = conn.execute(
            "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
        ).fetchone()
        if (
            task is None
            or task["status"] != claim["task_status"]
            or task["version"] != claim["task_version"]
            or task["workflow_version"] != claim["workflow_version"]
            or task["definition_checksum"] != claim["definition_checksum"]
            or task["merchant_id"] != claim["merchant_id"]
            or _merchant_lifecycle_token(conn, int(task["merchant_id"]))
            != claim["merchant_lifecycle"]
            or claim["merchant_lifecycle"][0] != "active"
        ):
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
            claim = _task_execution_claim(conn, execution)
            if claim is None:
                continue
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
                        claim=claim,
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
                    logger.warning(
                        "task execution %s has malformed completed_at %r",
                        execution["id"],
                        completed_at,
                    )
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
                    or current["coreai_run_id"] != claim["coreai_run_id"]
                    or current["dispatch_token"] != claim["dispatch_token"]
                    or current["dispatch_started_at"] != claim["dispatch_started_at"]
                    or current["task_id"] != claim["task_id"]
                ):
                    conn.rollback()
                    continue
                task = conn.execute(
                    "SELECT * FROM tasks WHERE id = ?", (current["task_id"],)
                ).fetchone()
                if (
                    task is None
                    or task["status"] != claim["task_status"]
                    or task["version"] != claim["task_version"]
                    or task["workflow_version"] != claim["workflow_version"]
                    or task["definition_checksum"] != claim["definition_checksum"]
                    or task["merchant_id"] != claim["merchant_id"]
                    or _merchant_lifecycle_token(conn, int(task["merchant_id"]))
                    != claim["merchant_lifecycle"]
                    or claim["merchant_lifecycle"][0] != "active"
                ):
                    raise RuntimeError(
                        "active preparation is detached from its PREPARING Task"
                    )

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
                    anchor = datetime.fromisoformat(
                        last["finished_at"] or last["created_at"]
                    )
                    if now - anchor < timedelta(
                        days=merchant["auto_run_interval_days"]
                    ):
                        continue
                start_run(conn, client, agent_id, merchant, "auto")
            except Exception:
                logger.exception(
                    "auto_scan merchant %s failed, continuing", merchant["id"]
                )
    finally:
        conn.close()


def sync_due_fbr_profiles_once(
    client,
    *,
    current_time: datetime | None = None,
    clock: Callable[[], datetime] | None = None,
) -> dict[str, int]:
    """Synchronize due FBR links while isolating per-merchant failures."""

    lookup = connect()
    try:
        rows = lookup.execute(
            "SELECT l.* FROM merchant_fbr_links AS l "
            "JOIN merchants AS m ON m.id=l.merchant_id "
            "WHERE m.status='active' ORDER BY l.merchant_id"
        ).fetchall()
    finally:
        lookup.close()

    result = {"attempted": 0, "synced": 0, "failed": 0}
    read_clock = clock or (lambda: datetime.now(timezone.utc))
    for link in rows:
        merchant_time = current_time or read_clock()
        if not gbp_sync_due(link, merchant_time):
            continue
        result["attempted"] += 1
        conn = connect()
        try:
            sync_kwargs = (
                {"current_time": merchant_time} if current_time is not None else {}
            )
            completed = sync_gbp_profile_once(
                conn,
                client,
                link["merchant_id"],
                **sync_kwargs,
            )
        except Exception:
            result["failed"] += 1
            logger.exception(
                "hourly FBR sync for merchant %s failed, continuing",
                link["merchant_id"],
            )
        else:
            if completed:
                result["synced"] += 1
        finally:
            conn.close()
    return result


async def scheduler_loop() -> None:
    settings = coreai_settings()
    if settings is None:
        logger.info(
            "core-ai not configured; network jobs disabled, "
            "DB stale-dispatch recovery remains active"
        )
        client = None
        local_falcon = None
        seo_poll_agents = None
    else:
        client = CoreAiClient(settings.base_url, settings.api_key)
        local_falcon = (
            LocalFalconClient(client, settings.local_falcon_tool_id)
            if settings.local_falcon_tool_id
            else None
        )
        seo_poll_agents = seo_target_poll_agents(settings)
    tick = 0
    while True:
        try:
            await asyncio.to_thread(recover_stale_run_dispatches_once)
            await asyncio.to_thread(recover_stale_seo_dispatches_once)
            await asyncio.to_thread(recover_stale_task_dispatches_once)
            if client is not None:
                await asyncio.to_thread(poll_runs_once, client)
                await asyncio.to_thread(poll_task_executions_once, client)
                if seo_poll_agents is not None:
                    await asyncio.to_thread(
                        poll_seo_targets_once,
                        client,
                        seo_poll_agents,
                    )
                if local_falcon is not None:
                    await asyncio.to_thread(
                        poll_acknowledged_local_falcon_reports_once,
                        local_falcon,
                    )
                    await asyncio.to_thread(
                        submit_local_falcon_batches_once,
                        local_falcon,
                    )
                if tick % SCAN_EVERY_TICKS == 0:
                    await asyncio.to_thread(auto_scan_once, client, settings.agent_id)
        except Exception:
            logger.exception("scheduler tick failed")
        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def fbr_scheduler_loop() -> None:
    """Refresh due FBR snapshots independently from Core AI polling."""

    tick = 0
    while True:
        try:
            if tick % FBR_DUE_CHECK_EVERY_TICKS == 0:
                fbr_client = get_fbr_client()
                if fbr_client is not None:
                    await asyncio.to_thread(
                        sync_due_fbr_profiles_once,
                        fbr_client,
                    )
        except Exception:
            logger.exception("hourly FBR scheduler tick failed")
        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)

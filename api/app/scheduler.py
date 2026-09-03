import asyncio
import logging
from datetime import datetime, timedelta, timezone

from .audit_snapshots import persist_audit_snapshot
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect
from .execution_result import normalize_execution_output
from .local_falcon import LocalFalconClient
from .merchant_profiles import (
    gbp_sync_due,
    get_fbr_client,
    sync_gbp_profile_once,
)
from .merchants import now_iso
from .plan_parser import create_tasks_from_plan, extract_plan
from .runs import has_running_run, start_run
from .seo_targets import (
    SeoAgentIds,
    poll_acknowledged_local_falcon_reports_once,
    poll_seo_targets_once,
    recover_stale_seo_dispatches_once,
    submit_local_falcon_batches_once,
)

logger = logging.getLogger("seo_ops.scheduler")

POLL_INTERVAL_SECONDS = 30
SCAN_EVERY_TICKS = 120  # 120 * 30s = 1 小时
# Eligibility is cheap and guarded by the persisted one-hour due predicate.
# Check it every scheduler tick so a boundary miss or stale lease is recovered
# within one polling interval rather than almost another hour later.
FBR_DUE_CHECK_EVERY_TICKS = 1


def seo_target_poll_agents(settings) -> SeoAgentIds | None:
    """Return poll routing for either the legacy pipeline or Skill regeneration.

    Skill-based keyword regeneration is terminal after its verified keyword
    artifact, so it does not require audit/ranking Agents merely to be polled.
    """
    legacy_configured = bool(
        settings.keyword_agent_id and settings.audit_agent_id and settings.ranking_agent_id
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
                items = extract_plan(report)
                if items:
                    create_tasks_from_plan(conn, run["merchant_id"], run["id"], run["coreai_run_id"], items)
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
            "SELECT * FROM task_executions WHERE status = 'running' AND coreai_run_id IS NOT NULL"
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
            if status == "COMPLETED":
                try:
                    output = normalize_execution_output(core.get("output"))
                except ValueError as exc:
                    conn.execute(
                        "UPDATE task_executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                        (str(exc), finished_at, execution["id"]),
                    )
                else:
                    conn.execute(
                        "UPDATE task_executions SET status = 'ready', output_text = ?, finished_at = ? WHERE id = ?",
                        (output, finished_at, execution["id"]),
                    )
            else:
                conn.execute(
                    "UPDATE task_executions SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
                    (core.get("error") or f"core-ai status {status}", finished_at, execution["id"]),
                )
            conn.commit()
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


def sync_due_fbr_profiles_once(
    client,
    *,
    current_time: datetime | None = None,
) -> dict[str, int]:
    """Synchronize due FBR links, isolating each merchant's failure."""
    lookup = connect()
    try:
        rows = lookup.execute(
            "SELECT l.* FROM merchant_fbr_links AS l"
            " JOIN merchants AS m ON m.id = l.merchant_id"
            " WHERE m.status = 'active'"
            " ORDER BY l.merchant_id"
        ).fetchall()
    finally:
        lookup.close()

    result = {"attempted": 0, "synced": 0, "failed": 0}
    for link in rows:
        merchant_time = current_time or datetime.now(timezone.utc)
        if not gbp_sync_due(link, merchant_time):
            continue
        result["attempted"] += 1
        conn = connect()
        try:
            sync_kwargs = (
                {"current_time": merchant_time}
                if current_time is not None
                else {}
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
            "core-ai not configured; network scheduler jobs disabled, "
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
            await asyncio.to_thread(recover_stale_seo_dispatches_once)
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
            logger.exception("core-ai scheduler tick failed")

        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def fbr_scheduler_loop() -> None:
    """Refresh due FBR snapshots independently from Core AI polling.

    The persisted due predicate keeps each merchant to an hourly cadence while
    the short check interval gives boundary misses and stale leases prompt
    recovery. Keeping this in a separate task prevents a slow FBR batch from
    delaying Core AI and Local Falcon state polling.
    """
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

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect
from .merchants import now_iso
from .plan_parser import create_tasks_from_plan, extract_plan
from .runs import has_running_run, start_run

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
            # Validate completed_at timestamp; fall back to now_iso() on invalid format
            completed_at = core.get("completed_at")
            if completed_at:
                try:
                    datetime.fromisoformat(completed_at)
                    finished_at = completed_at
                except ValueError:
                    logger.warning("poll run %s has malformed completed_at %r, using now", run["id"], completed_at)
                    finished_at = now_iso()
            else:
                finished_at = now_iso()
            if status == "COMPLETED":
                report = core.get("output") or None
                conn.execute(
                    "UPDATE runs SET status = 'succeeded', report_text = ?, finished_at = ? WHERE id = ?",
                    (report, finished_at, run["id"]),
                )
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
            if tick % SCAN_EVERY_TICKS == 0:
                await asyncio.to_thread(auto_scan_once, client, settings.agent_id)
        except Exception:
            logger.exception("scheduler tick failed")
        tick += 1
        await asyncio.sleep(POLL_INTERVAL_SECONDS)

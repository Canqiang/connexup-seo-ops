import base64
import json
import math
import os
import re
import unicodedata
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal, Sequence
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator
from pydantic_core import PydanticCustomError

from .config import (
    agent_workbench_settings,
    configured_agent_slots,
    coreai_connection_settings,
)
from .coreai import CoreAiClient, CoreAiContractError, CoreAiError
from .db import get_db


router = APIRouter(prefix="/api/agent-workbench", tags=["agent-workbench"])

TOKEN_USAGE_INPUT_FIELD = "input"
TOKEN_USAGE_OUTPUT_FIELD = "output"
DISCARDED_UPSTREAM_FIELDS = frozenset(
    {
        TOKEN_USAGE_INPUT_FIELD,
        TOKEN_USAGE_OUTPUT_FIELD,
        "transcript",
        "artifacts",
        "error_stack",
    }
)
KNOWN_NONTERMINAL = frozenset({"PENDING", "RUNNING", "PAUSED"})
KNOWN_TERMINAL = frozenset(
    {"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"}
)
WORKBENCH_RANGES = frozenset({"today", "7d", "30d", "all"})
OUTCOME_STATUSES = frozenset({"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED"})
SUCCESS_STATUSES = frozenset({"COMPLETED"})


def _is_unknown_status(status: str | None) -> bool:
    return (
        status is not None
        and status not in KNOWN_NONTERMINAL | KNOWN_TERMINAL
    )


def classify_workbench_status(status):
    if status in KNOWN_NONTERMINAL:
        return {
            "presentation_group": {
                "PENDING": "queued", "RUNNING": "active", "PAUSED": "waiting"
            }[status],
            "counts_as_run": True,
            "outcome": False,
            "token_eligible": False,
            "motion_eligible": status == "RUNNING",
        }
    if status in OUTCOME_STATUSES:
        return {
            "presentation_group": {
                "COMPLETED": "success", "FAILED": "failure",
                "TIMEOUT": "failure", "CANCELLED": "cancelled",
            }[status],
            "counts_as_run": True,
            "outcome": True,
            "token_eligible": True,
            "motion_eligible": False,
        }
    if status == "SKIPPED":
        return {
            "presentation_group": "skipped",
            "counts_as_run": False,
            "outcome": False,
            "token_eligible": False,
            "motion_eligible": False,
        }
    return {
        "presentation_group": "unknown",
        "counts_as_run": True,
        "outcome": False,
        "token_eligible": False,
        "motion_eligible": False,
    }


def _workbench_warning(code, message, local_agent_id=None, coreai_run_id=None):
    return {
        "code": code,
        "message": message,
        "local_agent_id": local_agent_id,
        "coreai_run_id": coreai_run_id,
    }


def _serialize_association(row):
    if row is None or row.get("source_kind") is None:
        return None
    return {
        "kind": row["source_kind"],
        "source_local_id": row["source_local_id"],
        "merchant_id": row.get("merchant_id"),
        "merchant_name": row.get("merchant_name"),
        "local_href": row.get("local_href"),
        "local_label": row["local_label"],
    }


SIGNAL_FIELDS = (
    "coreai_run_id", "local_agent_id", "agent_name", "agent_role",
    "lifecycle_status", "agent_current_state_complete", "raw_status",
    "presentation_group", "signal_state", "trigger_type", "fresh", "suspect",
    "suspect_reason", "started_at", "effective_started_at", "completed_at",
    "terminal_observed_at", "receipt_expires_at", "elapsed_seconds",
    "last_synced_at", "fresh_until", "suspect_at", "input_tokens",
    "output_tokens", "total_tokens", "token_state", "association",
)


def _serialize_signal(values):
    return {field: values[field] for field in SIGNAL_FIELDS}


def _serialize_registry_record(row):
    return {
        "id": row["id"],
        "agent_key": row["agent_key"],
        "coreai_agent_id": row["coreai_agent_id"],
        "display_name": row["display_name"],
        "role": row["role"],
        "sort_order": row["sort_order"],
        "lifecycle_status": row["status"],
        "coreai_metadata": {
            "name": row["coreai_name"],
            "model": row["coreai_model"],
            "timeout_hint_seconds": row["coreai_timeout_hint_seconds"],
            "last_verified_at": row["last_verified_at"],
            "verification_error": row["last_verification_error"],
        },
        "suspect_after_seconds": row["suspect_after_seconds"],
        "sync_pending": bool(row["sync_pending"]),
    }


def build_workbench_snapshot(conn, range_key, now, timezone, history_limit) -> dict:
    if range_key not in WORKBENCH_RANGES:
        raise WorkbenchError(
            422,
            "INVALID_RANGE",
            "不支持的时间范围",
            {"range": "仅支持 today、7d、30d 或 all"},
        )
    conn.execute("BEGIN")
    try:
        agents = conn.execute(
            "SELECT a.*,s.* FROM seo_ops_agents a "
            "JOIN seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id "
            "ORDER BY a.sort_order,a.id"
        ).fetchall()
        runs = conn.execute(
            "SELECT * FROM seo_ops_agent_runs ORDER BY coreai_run_id"
        ).fetchall()
        return _workbench_snapshot_from_rows(
            conn, agents, runs, range_key, now, timezone, history_limit
        )
    finally:
        conn.rollback()


def _workbench_snapshot_from_rows(
    conn, agents, runs, range_key, now, timezone, history_limit
) -> dict:
    range_start_dt, range_end_dt = _range_bounds(range_key, now, timezone)
    range_start = _utc_iso(range_start_dt) if range_start_dt else None
    range_end = _utc_iso(range_end_dt)
    agent_rows = [dict(row) for row in agents]
    run_rows = [dict(row) for row in runs]
    runs_by_agent = {
        agent["id"]: [
            row for row in run_rows if row["seo_ops_agent_id"] == agent["id"]
        ]
        for agent in agent_rows
    }
    active_agents = [row for row in agent_rows if row["status"] == "active"]
    archived_agents = [row for row in agent_rows if row["status"] != "active"]
    configured = coreai_connection_settings() is not None
    agent_dtos = []
    all_warnings = []
    signals = []
    per_agent_coverages = []
    per_agent_health = []
    per_agent_fresh_until = []
    any_archiving = False

    unknown_rows = [
        row for row in run_rows
        if row["raw_status"] is None or _is_unknown_status(row["raw_status"])
    ]
    for agent in agent_rows:
        owned_runs = runs_by_agent[agent["id"]]
        selected_runs = [
            row for row in owned_runs
            if _in_workbench_range(row, range_start_dt, range_end_dt)
        ]
        counts = {
            output: _current_count(agent, prefix, active=agent["status"] == "active")
            for output, prefix in (
                ("running", "running"), ("queued", "pending"),
                ("waiting", "paused"),
            )
        }
        agent_unknown = any(
            row["raw_status"] is None or _is_unknown_status(row["raw_status"])
            for row in owned_runs
        )
        agent_complete = bool(
            agent["status"] == "active"
            and not agent["sync_pending"]
            and agent["current_state_complete"]
            and all(count["quality"] == "exact" for count in counts.values())
            and not agent_unknown
        )
        health, agent_fresh_until = _agent_health(
            agent, owned_runs, now, configured, agent_complete
        )
        coverage, coverage_warnings = _agent_coverage(
            agent, owned_runs, selected_runs, range_start_dt, range_key
        )
        metrics = _range_metrics(selected_runs)
        warnings = list(coverage_warnings)
        warnings.extend(_agent_sync_warnings(agent))
        rendered_runs = []
        for row in owned_runs:
            association, local_running = _run_association(conn, row)
            rendered = _projected_run_summary(
                row, association, local_running, now, agent["suspect_after_seconds"]
            )
            rendered_runs.append(rendered)
            for code in rendered["warning_codes"]:
                warnings.append(
                    _workbench_warning(
                        code, _warning_message(code), agent["id"], row["coreai_run_id"]
                    )
                )
            signal = _workbench_signal(
                row, agent, association, local_running, now,
                agent_complete, health, agent_fresh_until,
            )
            if signal is not None:
                signals.append(signal)
                any_archiving = any_archiving or signal["signal_state"] == "archiving"
        warning_map = {
            (warning["code"], warning["local_agent_id"], warning["coreai_run_id"]): warning
            for warning in warnings
        }
        warnings = sorted(
            warning_map.values(),
            key=lambda item: (
                item["code"], item["local_agent_id"] or "", item["coreai_run_id"] or ""
            ),
        )
        terminal = [
            item for row, item in zip(owned_runs, rendered_runs)
            if row["raw_status"] in KNOWN_TERMINAL
        ]
        terminal.sort(
            key=lambda item: (item["effective_started_at"], item["coreai_run_id"]),
            reverse=True,
        )
        dto = _serialize_registry_record(agent)
        dto.update(
            {
                "sync": {
                    "health": health,
                    "last_discovery_attempt_at": agent["last_discovery_attempt_at"],
                    "last_discovery_success_at": agent["last_discovery_success_at"],
                    "discovery_error": agent["last_discovery_error"],
                    "current_state_checked_at": agent["current_state_checked_at"],
                    "current_state_error": agent["current_state_error"],
                    "next_discovery_at": agent["next_discovery_at"],
                    "last_fast_poll_attempt_at": agent["last_fast_poll_attempt_at"],
                    "last_fast_poll_success_at": agent["last_fast_poll_success_at"],
                    "fast_poll_error": agent["last_fast_poll_error"],
                },
                "current_state_complete": agent_complete,
                "current_counts": counts,
                "range_metrics": metrics,
                "coverage": coverage,
                "last_terminal_run": terminal[0] if terminal else None,
                "warnings": warnings,
            }
        )
        agent_dtos.append(dto)
        all_warnings.extend(warnings)
        per_agent_coverages.append(coverage)
        if agent["status"] == "active":
            per_agent_health.append(health)
            if agent_fresh_until is not None:
                per_agent_fresh_until.append(agent_fresh_until)

    active_counts = {
        name: _aggregate_counts(
            [_current_count(agent, prefix, active=True) for agent in active_agents]
        )
        for name, prefix in (
            ("running", "running"), ("queued", "pending"),
            ("waiting", "paused"),
        )
    }
    legacy_parts = [
        _current_count(agent, prefix, active=False)
        for agent in archived_agents
        for prefix in ("pending", "running", "paused")
    ]
    legacy_count = _aggregate_counts(legacy_parts)
    aggregate_coverage = _aggregate_coverages(per_agent_coverages)
    summary = _range_metrics(
        [row for row in run_rows if _in_workbench_range(row, range_start_dt, range_end_dt)]
    )
    aggregate_health = _aggregate_health(per_agent_health)
    incomplete = []
    for status, count_name in (
        ("PENDING", "queued"), ("RUNNING", "running"), ("PAUSED", "waiting")
    ):
        if active_agents and active_counts[count_name]["quality"] != "exact":
            incomplete.append(status)
    if unknown_rows:
        incomplete.append("UNKNOWN")
    current_complete = (
        None if not active_agents else
        all(
            agent["current_state_complete"]
            for agent in agent_dtos
            if agent["lifecycle_status"] == "active"
        )
        and not unknown_rows
    )
    all_warnings.extend(_configuration_snapshot_warnings(conn))
    all_warnings.extend(_association_snapshot_warnings(conn))
    warning_map = {
        (warning["code"], warning["local_agent_id"], warning["coreai_run_id"]): warning
        for warning in all_warnings
    }
    all_warnings = sorted(
        warning_map.values(),
        key=lambda item: (
            item["code"], item["local_agent_id"] or "", item["coreai_run_id"] or ""
        ),
    )
    signals.sort(
        key=lambda item: (item["effective_started_at"], item["coreai_run_id"]),
        reverse=True,
    )
    fresh_signal = any(
        signal["fresh"] and signal["presentation_group"] in {"queued", "active"}
        for signal in signals
    )
    due_retries = []
    for agent in active_agents:
        discovery_retry = _parse_time(agent["next_discovery_at"])
        if (
            agent["last_discovery_error"] or agent["current_state_error"]
        ) and discovery_retry:
            due_retries.append(discovery_retry)
        fast_retry = _parse_time(agent["next_fast_poll_at"])
        owns_failed_run = any(
            _latest_failure(
                row["last_poll_attempt_at"], row["last_synced_at"],
                row["last_poll_error"],
            )
            for row in runs_by_agent[agent["id"]]
        )
        if fast_retry and (
            agent["last_fast_poll_error"]
            or agent["current_state_error"]
            or owns_failed_run
        ):
            due_retries.append(fast_retry)
    base_refresh = 5000 if fresh_signal or any_archiving else 30000
    if due_retries and not fresh_signal:
        retry_ms = max(1000, min(60000, math.floor(
            (min(due_retries) - now).total_seconds() * 1000
        )))
        base_refresh = min(base_refresh, retry_ms)
    return {
        "snapshot_at": _utc_iso(now),
        "last_complete_discovery_at": _oldest_or_none(
            [agent["last_discovery_success_at"] for agent in active_agents]
        ),
        "sync_health": aggregate_health,
        "stale": aggregate_health in {"partial", "stale", "unavailable"},
        "current_state_complete": current_complete,
        "current_state_checked_at": _oldest_or_none(
            [agent["current_state_checked_at"] for agent in active_agents]
        ),
        "current_state_incomplete_statuses": incomplete,
        "fresh_until": (
            _utc_iso(min(per_agent_fresh_until))
            if len(per_agent_fresh_until) == len(active_agents) and active_agents else None
        ),
        "has_active_runs": _count_presence(active_counts["running"]),
        "has_queued_runs": _count_presence(active_counts["queued"]),
        "has_waiting_runs": _count_presence(active_counts["waiting"]),
        "current_counts": {**active_counts, "legacy_nonterminal": legacy_count},
        "refresh_after_ms": base_refresh,
        "range": range_key,
        "timezone": timezone,
        "range_start": range_start,
        "range_end": range_end,
        "metrics_complete_for_range": (
            aggregate_coverage["range_complete"]
            and all(not _latest_discovery_failed(agent) for agent in agent_rows)
            and not any(
                row["raw_status"] is None or _is_unknown_status(row["raw_status"])
                for row in run_rows
                if _in_workbench_range(row, range_start_dt, range_end_dt)
            )
        ),
        "coverage": aggregate_coverage,
        "summary": summary,
        "signals": signals,
        "agents": agent_dtos,
        "sync_warnings": all_warnings,
    }


def _range_bounds(range_key, now, timezone_name):
    zone = ZoneInfo(timezone_name)
    local_now = now.astimezone(zone)
    end_date = local_now.date() + timedelta(days=1)
    end = datetime.combine(end_date, datetime.min.time(), zone).astimezone(timezone.utc)
    days = {"today": 1, "7d": 7, "30d": 30}.get(range_key)
    start = None
    if days is not None:
        start = datetime.combine(
            end_date - timedelta(days=days), datetime.min.time(), zone
        ).astimezone(timezone.utc)
    return start, end


def _parse_time(value):
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed.astimezone(timezone.utc)


def _effective_start(row):
    return _parse_time(row["started_at"]) or _parse_time(row["first_seen_at"])


def _in_workbench_range(row, start, end):
    effective = _effective_start(row)
    return effective is not None and effective < end and (start is None or effective >= start)


def _range_metrics(rows):
    selected = [row for row in rows if classify_workbench_status(row["raw_status"])["counts_as_run"]]
    outcomes = [row for row in selected if row["raw_status"] in OUTCOME_STATUSES]
    known = [
        row for row in outcomes
        if row["input_tokens"] is not None and row["output_tokens"] is not None
        and row["last_synced_at"] is not None
    ]
    successful = sum(row["raw_status"] in SUCCESS_STATUSES for row in outcomes)
    return {
        "run_count": len(selected),
        "terminal_runs": len(outcomes),
        "successful_runs": successful,
        "success_rate": successful / len(outcomes) if outcomes else None,
        "known_input_tokens": sum(row["input_tokens"] for row in known),
        "known_output_tokens": sum(row["output_tokens"] for row in known),
        "known_total_tokens": sum(
            row["input_tokens"] + row["output_tokens"] for row in known
        ),
        "token_known_runs": len(known),
        "token_eligible_runs": len(outcomes),
    }


def _current_count(agent, prefix, *, active):
    quality = agent[f"{prefix}_set_quality"]
    observed = agent[f"{prefix}_observed_count"]
    observed_at = agent[f"{prefix}_last_observed_at"]
    if active and agent["sync_pending"]:
        quality = "unknown"
    return {
        "value": observed if quality in {"exact", "lower_bound"} else None,
        "quality": quality,
        "last_observed_value": observed,
        "last_observed_at": observed_at,
    }


def _aggregate_counts(parts):
    if not parts:
        return {
            "value": 0, "quality": "exact", "last_observed_value": None,
            "last_observed_at": None,
        }
    qualities = {part["quality"] for part in parts}
    quality = "unknown" if "unknown" in qualities else (
        "lower_bound" if "lower_bound" in qualities else "exact"
    )
    observations = [
        part["last_observed_value"] for part in parts
        if part["last_observed_value"] is not None
    ]
    times = [part["last_observed_at"] for part in parts if part["last_observed_at"]]
    return {
        "value": (
            sum(part["value"] for part in parts if part["value"] is not None)
            if quality != "unknown" else None
        ),
        "quality": quality,
        "last_observed_value": sum(observations) if observations else None,
        "last_observed_at": min(times, key=lambda value: _parse_time(value)) if times else None,
    }


def _count_presence(count):
    if count["value"] is not None and count["value"] > 0:
        return True
    if count["quality"] == "exact" and count["value"] == 0:
        return False
    return None


def _latest_failure(attempt, success, error):
    attempt_at = _parse_time(attempt)
    success_at = _parse_time(success)
    return bool(error and attempt_at and (success_at is None or attempt_at >= success_at))


def _latest_discovery_failed(agent):
    return _latest_failure(
        agent["last_discovery_attempt_at"], agent["last_discovery_success_at"],
        agent["last_discovery_error"],
    )


def _agent_health(agent, runs, now, configured, complete):
    discovery = _parse_time(agent["last_discovery_success_at"])
    checked = _parse_time(agent["current_state_checked_at"])
    if agent["status"] == "active" and not configured:
        return "unavailable", None
    if discovery is None or (agent["status"] == "active" and checked is None):
        return "unavailable", None
    deadlines = [discovery + timedelta(seconds=90)]
    if agent["status"] == "active":
        deadlines.append(checked + timedelta(seconds=90))
    for row in runs:
        if row["raw_status"] not in {"PENDING", "RUNNING"}:
            continue
        synced = _parse_time(row["last_synced_at"])
        effective = _effective_start(row)
        if synced:
            deadlines.append(synced + timedelta(seconds=15))
        if effective:
            deadlines.append(effective + timedelta(seconds=agent["suspect_after_seconds"]))
    boundary = min(deadlines)
    failed = (
        _latest_discovery_failed(agent)
        or _latest_failure(
            agent["last_fast_poll_attempt_at"], agent["last_fast_poll_success_at"],
            agent["last_fast_poll_error"],
        )
        or bool(agent["current_state_error"])
        or any(
            _latest_failure(
                row["last_poll_attempt_at"], row["last_synced_at"],
                row["last_poll_error"],
            )
            for row in runs
        )
    )
    if agent["status"] == "active" and (agent["sync_pending"] or not complete):
        return "stale", boundary
    if failed or now >= boundary:
        return "stale", boundary
    return "fresh", boundary


def _agent_coverage(agent, runs, selected_runs, range_start, range_key):
    mirrored = len(runs)
    unconfirmed = any(row["last_synced_at"] is None for row in runs)
    history_dirty = (
        agent["unfiltered_proven_event_epoch"] is None
        or agent["unfiltered_proven_event_epoch"] < agent["history_event_epoch"]
    )
    contradiction = (
        agent["remote_total_runs"] is not None
        and agent["remote_total_runs"] < mirrored
    )
    history_complete = bool(
        not history_dirty and not unconfirmed and not contradiction
        and agent["remote_total_runs"] is not None
        and agent["last_discovery_returned_count"] == agent["remote_total_runs"] == mirrored
    )
    finite_proof = _parse_time(agent["finite_range_proven_start_at"])
    range_complete = history_complete
    if range_key != "all" and range_start is not None:
        range_complete = bool(finite_proof and range_start >= finite_proof) or history_complete
        if any(
            row["last_synced_at"] is None or _parse_time(row["started_at"]) is None
            for row in selected_runs
        ):
            range_complete = False
    warnings = []
    if history_dirty:
        warnings.append(_workbench_warning(
            "HISTORY_PROOF_DIRTY", _warning_message("HISTORY_PROOF_DIRTY"), agent["id"]
        ))
    if contradiction:
        warnings.append(_workbench_warning(
            "REMOTE_TOTAL_BELOW_MIRRORED",
            _warning_message("REMOTE_TOTAL_BELOW_MIRRORED"), agent["id"]
        ))
    return {
        "mirrored_run_count": mirrored,
        "remote_total_runs": (
            agent["remote_total_runs"]
            if not history_dirty and not unconfirmed and not contradiction else None
        ),
        "history_complete": history_complete,
        "range_complete": range_complete,
        "coverage_start_at": agent["coverage_start_at"],
        "coverage_as_of": agent["last_discovery_success_at"],
    }, warnings


def _empty_coverage():
    return {
        "mirrored_run_count": 0, "remote_total_runs": 0,
        "history_complete": True, "range_complete": True,
        "coverage_start_at": None, "coverage_as_of": None,
    }


def _aggregate_coverages(coverages):
    if not coverages:
        return _empty_coverage()
    return {
        "mirrored_run_count": sum(
            coverage["mirrored_run_count"] for coverage in coverages
        ),
        "remote_total_runs": (
            sum(coverage["remote_total_runs"] for coverage in coverages)
            if all(coverage["remote_total_runs"] is not None for coverage in coverages)
            else None
        ),
        "history_complete": all(
            coverage["history_complete"] for coverage in coverages
        ),
        "range_complete": all(
            coverage["range_complete"] for coverage in coverages
        ),
        "coverage_start_at": _aggregate_boundary(
            [coverage["coverage_start_at"] for coverage in coverages], max
        ),
        "coverage_as_of": _aggregate_boundary(
            [coverage["coverage_as_of"] for coverage in coverages], min
        ),
    }


def _aggregate_boundary(values, selector):
    if not values or any(value is None for value in values):
        return None
    return selector(values, key=lambda value: _parse_time(value))


def _oldest_or_none(values):
    if not values or any(value is None for value in values):
        return None
    return min(values, key=lambda value: _parse_time(value))


def _aggregate_health(healths):
    if not healths:
        return "not_configured"
    unique = set(healths)
    if unique == {"fresh"}:
        return "fresh"
    if unique == {"stale"}:
        return "stale"
    if unique == {"unavailable"}:
        return "unavailable"
    return "partial"


WARNING_MESSAGES = {
    "ARCHIVE_DELAY": "本地归档延迟",
    "CURRENT_STATE_FAILED": "当前状态同步失败",
    "DISCOVERY_FAILED": "Run 列表同步失败",
    "FAST_POLL_FAILED": "Run 状态确认失败",
    "HISTORY_PROOF_DIRTY": "历史覆盖证明待更新",
    "INVALID_COMPLETED_AT": "完成时间不可用",
    "INVALID_STARTED_AT": "开始时间不可用",
    "LOCAL_ASSOCIATION_CONFLICT": "Core AI Run ID 对应多个本地记录",
    "LOCAL_RUN_UNCONFIRMED": "本地 Run 尚未由列表确认",
    "LOCAL_TRIGGER_STATUS_MISSING": "状态待确认（上游未返回状态）",
    "METADATA_VERIFICATION_FAILED": "Agent 元数据验证失败",
    "REMOTE_TOTAL_BELOW_MIRRORED": "上游总数小于已镜像 Run 数",
    "TERMINAL_STATUS_CONFLICT": "终态状态冲突",
    "TOKEN_USAGE_INVALID": "Token 用量不可用",
    "UNKNOWN_STATUS": "发现未知 Core AI 状态",
}


def _warning_message(code):
    return WARNING_MESSAGES.get(code, "Agent Workbench 数据待确认")


def _agent_sync_warnings(agent):
    warnings = []
    for error_field, code in (
        ("last_discovery_error", "DISCOVERY_FAILED"),
        ("current_state_error", "CURRENT_STATE_FAILED"),
        ("last_fast_poll_error", "FAST_POLL_FAILED"),
        ("last_verification_error", "METADATA_VERIFICATION_FAILED"),
    ):
        if agent[error_field]:
            warnings.append(_workbench_warning(
                code, _warning_message(code), agent["id"]
            ))
    return warnings


def _configuration_snapshot_warnings(conn):
    return [
        _workbench_warning(warning.code, warning.message)
        for warning in bootstrap_configuration_warnings(conn, configured_agent_slots())
    ]


def _association_snapshot_warnings(conn):
    return [
        _workbench_warning(
            warning["code"], warning["message"],
            coreai_run_id=warning["fields"].get("coreai_run_id"),
        )
        for warning in association_preflight_warnings(conn)
    ]


def _run_association(conn, row):
    if row["source_kind"] is None:
        return None, False
    source_id = row["source_local_id"]
    merchant_id = row["merchant_id"]
    merchant = conn.execute(
        "SELECT name FROM merchants WHERE id=?", (merchant_id,)
    ).fetchone() if merchant_id is not None else None
    merchant_name = merchant[0] if merchant else None
    local_href = None
    local_label = f"{row['source_kind']} #{source_id}"
    status = None
    if row["source_kind"] == "run":
        source = conn.execute("SELECT status FROM runs WHERE id=?", (source_id,)).fetchone()
        status = source[0] if source else None
        local_href = f"/runs/{source_id}" if source else None
        local_label = f"Run #{source_id}"
    elif row["source_kind"] == "task_execution":
        source = conn.execute(
            "SELECT e.status,t.id,t.title FROM task_executions e "
            "JOIN tasks t ON t.id=e.task_id WHERE e.id=?", (source_id,)
        ).fetchone()
        if source:
            status, task_id, local_label = source
            local_href = f"/tasks/{task_id}"
    else:
        source = conn.execute(
            "SELECT status,artifact_type FROM merchant_seo_artifacts WHERE id=?",
            (source_id,),
        ).fetchone()
        if source:
            status, artifact_type = source
            local_href = f"/merchants/{merchant_id}/profile" if merchant_id else None
            local_label = f"{artifact_type} #{source_id}"
    association = _serialize_association({
        "source_kind": row["source_kind"], "source_local_id": source_id,
        "merchant_id": merchant_id, "merchant_name": merchant_name,
        "local_href": local_href, "local_label": local_label,
    })
    return association, str(status).lower() == "running"


def _token_state(row):
    classification = classify_workbench_status(row["raw_status"])
    if row["raw_status"] in KNOWN_NONTERMINAL:
        return "pending"
    if row["last_synced_at"] is None or classification["presentation_group"] == "unknown":
        return "unconfirmed"
    if row["raw_status"] == "SKIPPED":
        return "unavailable"
    if classification["token_eligible"]:
        return "known" if row["input_tokens"] is not None else "unavailable"
    return "unconfirmed"


def _elapsed_seconds(now, effective):
    return max(0, math.floor((now - effective).total_seconds()))


def _duration_seconds(row, effective):
    if row["raw_status"] not in KNOWN_TERMINAL:
        return None
    completed = _parse_time(row["completed_at"])
    if completed is None:
        return None
    return max(0, math.floor((completed - effective).total_seconds()))


def _archive_delayed(row, local_running, now):
    observed = _parse_time(row["terminal_observed_at"])
    return bool(local_running and observed and now >= observed + timedelta(minutes=5))


def _projected_run_summary(row, association, local_running, now, suspect_seconds):
    effective = _effective_start(row)
    classification = classify_workbench_status(row["raw_status"])
    suspect_at = (
        effective + timedelta(seconds=suspect_seconds)
        if row["raw_status"] in {"PENDING", "RUNNING"} else None
    )
    suspect = bool(suspect_at and now >= suspect_at)
    warnings = set(json.loads(row["data_warning_codes_json"] or "[]"))
    if row["last_synced_at"] is None:
        warnings.add("LOCAL_RUN_UNCONFIRMED")
    if row["raw_status"] is None:
        warnings.add("LOCAL_TRIGGER_STATUS_MISSING")
    if _is_unknown_status(row["raw_status"]):
        warnings.add("UNKNOWN_STATUS")
    delayed = _archive_delayed(row, local_running, now)
    if delayed:
        warnings.add("ARCHIVE_DELAY")
    archiving = bool(
        row["raw_status"] in KNOWN_TERMINAL and local_running and not delayed
    )
    return {
        "coreai_run_id": row["coreai_run_id"],
        "raw_status": row["raw_status"],
        "presentation_group": classification["presentation_group"],
        "trigger_type": row["trigger_type"],
        "started_at": row["started_at"],
        "effective_started_at": _utc_iso(effective),
        "completed_at": row["completed_at"],
        "terminal_observed_at": row["terminal_observed_at"],
        "receipt_expires_at": row["receipt_expires_at"],
        "elapsed_seconds": _elapsed_seconds(now, effective),
        "duration_seconds": _duration_seconds(row, effective),
        "input_tokens": row["input_tokens"],
        "output_tokens": row["output_tokens"],
        "total_tokens": (
            row["input_tokens"] + row["output_tokens"]
            if row["input_tokens"] is not None else None
        ),
        "token_state": _token_state(row),
        "last_synced_at": row["last_synced_at"],
        "suspect": suspect,
        "suspect_reason": "状态待确认" if suspect else None,
        "archiving": archiving,
        "archive_delayed": delayed,
        "warning_codes": sorted(warnings),
        "association": association,
        "error_summary": row["error_summary"],
    }


def _workbench_signal(
    row, agent, association, local_running, now, agent_complete, health, agent_boundary
):
    classification = classify_workbench_status(row["raw_status"])
    effective = _effective_start(row)
    delayed = _archive_delayed(row, local_running, now)
    archiving = bool(row["raw_status"] in KNOWN_TERMINAL and local_running and not delayed)
    receipt = _parse_time(row["receipt_expires_at"])
    has_receipt = bool(receipt and now < receipt)
    uncertain_status = row["raw_status"] is None or _is_unknown_status(row["raw_status"])
    known_nonterminal = row["raw_status"] in KNOWN_NONTERMINAL
    if not (known_nonterminal or uncertain_status or archiving or has_receipt):
        return None
    suspect_at = (
        effective + timedelta(seconds=agent["suspect_after_seconds"])
        if row["raw_status"] in {"PENDING", "RUNNING"} else None
    )
    suspect = bool(suspect_at and now >= suspect_at)
    poll_failed = _latest_failure(
        row["last_poll_attempt_at"], row["last_synced_at"], row["last_poll_error"]
    )
    unconfirmed = row["last_synced_at"] is None
    proof_failed = (
        poll_failed or _latest_discovery_failed(agent)
        or _latest_failure(
            agent["last_fast_poll_attempt_at"], agent["last_fast_poll_success_at"],
            agent["last_fast_poll_error"],
        )
        or bool(agent["current_state_error"])
    )
    fresh = False
    fresh_until = None
    if archiving:
        fresh = bool(
            row["last_synced_at"] and not poll_failed and health == "fresh"
        )
        fresh_until = now + timedelta(seconds=15) if fresh else None
        signal_state = "archiving"
    elif has_receipt:
        signal_state = "completed"
    elif uncertain_status or unconfirmed or suspect or proof_failed:
        signal_state = "uncertain"
    else:
        signal_state = classification["presentation_group"]
        if agent["status"] == "active" and health == "fresh" and agent_complete:
            if row["raw_status"] in {"PENDING", "RUNNING"}:
                synced = _parse_time(row["last_synced_at"])
                candidates = [candidate for candidate in (
                    agent_boundary, synced + timedelta(seconds=15) if synced else None,
                    suspect_at,
                ) if candidate]
                fresh_until = min(candidates) if candidates else None
                fresh = bool(fresh_until and now < fresh_until)
            elif row["raw_status"] == "PAUSED":
                fresh_until = agent_boundary
                fresh = bool(fresh_until and now < fresh_until)
    reason = None
    if row["raw_status"] is None:
        reason = "状态待确认（上游未返回状态）"
    elif uncertain_status or unconfirmed or suspect or proof_failed:
        reason = "状态待确认"
    values = {
        "coreai_run_id": row["coreai_run_id"], "local_agent_id": agent["id"],
        "agent_name": agent["display_name"], "agent_role": agent["role"],
        "lifecycle_status": agent["status"],
        "agent_current_state_complete": agent_complete,
        "raw_status": row["raw_status"],
        "presentation_group": classification["presentation_group"],
        "signal_state": signal_state, "trigger_type": row["trigger_type"],
        "fresh": fresh, "suspect": suspect,
        "suspect_reason": reason, "started_at": row["started_at"],
        "effective_started_at": _utc_iso(effective), "completed_at": row["completed_at"],
        "terminal_observed_at": row["terminal_observed_at"],
        "receipt_expires_at": row["receipt_expires_at"],
        "elapsed_seconds": _elapsed_seconds(now, effective),
        "last_synced_at": row["last_synced_at"],
        "fresh_until": _utc_iso(fresh_until) if fresh_until else None,
        "suspect_at": _utc_iso(suspect_at) if suspect_at else None,
        "input_tokens": row["input_tokens"], "output_tokens": row["output_tokens"],
        "total_tokens": (
            row["input_tokens"] + row["output_tokens"]
            if row["input_tokens"] is not None else None
        ),
        "token_state": _token_state(row), "association": association,
    }
    return _serialize_signal(values)


def _encode_history_cursor(effective_started_at, coreai_run_id):
    payload = json.dumps(
        [1, effective_started_at, coreai_run_id], separators=(",", ":")
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_history_cursor(value):
    try:
        padded = value + "=" * (-len(value) % 4)
        raw = base64.b64decode(padded, altchars=b"-_", validate=True)
        payload = json.loads(raw)
        if (
            not isinstance(payload, list) or len(payload) != 3
            or not isinstance(payload[0], int) or isinstance(payload[0], bool)
            or payload[0] != 1
            or not isinstance(payload[1], str) or _parse_time(payload[1]) is None
            or not isinstance(payload[2], str) or not payload[2].strip()
        ):
            raise ValueError
        return _utc_iso(_parse_time(payload[1])), payload[2]
    except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
        raise WorkbenchError(
            422, "INVALID_CURSOR", "历史游标无效", {"before": "游标格式无效"}
        ) from None


def list_projected_agent_runs(
    conn, local_agent_id, range_key, limit, before, now, timezone
) -> dict:
    if range_key not in WORKBENCH_RANGES:
        raise WorkbenchError(
            422, "INVALID_RANGE", "不支持的时间范围",
            {"range": "仅支持 today、7d、30d 或 all"},
        )
    bounded_limit = max(1, min(100, int(limit)))
    cursor = _decode_history_cursor(before) if before is not None else None
    range_start, range_end = _range_bounds(range_key, now, timezone)
    conn.execute("BEGIN")
    try:
        agent_row = conn.execute(
            "SELECT a.*,s.* FROM seo_ops_agents a "
            "JOIN seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id "
            "WHERE a.id=?", (local_agent_id,),
        ).fetchone()
        if agent_row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "未找到 Agent")
        rows = [dict(row) for row in conn.execute(
            "SELECT * FROM seo_ops_agent_runs WHERE seo_ops_agent_id=?",
            (local_agent_id,),
        ).fetchall()]
        rows = [row for row in rows if _in_workbench_range(row, range_start, range_end)]
        rows.sort(
            key=lambda row: (_effective_start(row), row["coreai_run_id"]), reverse=True
        )
        if cursor:
            cursor_time = _parse_time(cursor[0])
            rows = [
                row for row in rows
                if (_effective_start(row), row["coreai_run_id"])
                < (cursor_time, cursor[1])
            ]
        has_more = len(rows) > bounded_limit
        page = rows[:bounded_limit]
        items = []
        agent = dict(agent_row)
        for row in page:
            association, local_running = _run_association(conn, row)
            items.append(_projected_run_summary(
                row, association, local_running, now, agent["suspect_after_seconds"]
            ))
        next_before = None
        if has_more and items:
            last = items[-1]
            next_before = _encode_history_cursor(
                last["effective_started_at"], last["coreai_run_id"]
            )
        return {
            "items": items,
            "next_before": next_before,
            "range": range_key,
            "timezone": timezone,
            "range_start": _utc_iso(range_start) if range_start else None,
            "range_end": _utc_iso(range_end),
        }
    finally:
        conn.rollback()


@dataclass(frozen=True)
class ParsedAgentRun:
    coreai_run_id: str
    coreai_agent_id: str
    raw_status: str
    trigger_type: str
    started_at: str | None
    completed_at: str | None
    completed_at_state: Literal["valid", "missing", "invalid"]
    input_tokens: int | None
    output_tokens: int | None
    trace_id: str | None
    error_summary: str | None
    warnings: Sequence[str]


@dataclass(frozen=True)
class ParsedAgentRunPage:
    runs: Sequence[ParsedAgentRun]
    total: int
    returned_count: int
    observed_at: str


LocalSourceKind = Literal["run", "task_execution", "merchant_seo_artifact"]


@dataclass(frozen=True)
class LocalRunBinding:
    source_kind: LocalSourceKind
    source_local_id: int


ProjectionDisposition = Literal[
    "inserted",
    "updated",
    "unchanged",
    "older_ignored",
    "conflict_ignored",
]


@dataclass(frozen=True)
class ProjectionResult:
    coreai_run_id: str
    disposition: ProjectionDisposition
    warning_codes: tuple[str, ...]


@dataclass(frozen=True)
class LocalAssociationResolution:
    binding: LocalRunBinding | None
    merchant_id: int | None
    local_href: str | None
    local_label: str | None
    warning_codes: tuple[str, ...]


class RegisterAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    coreai_agent_id: str
    agent_key: str
    display_name: str
    role: str
    sort_order: int
    suspect_after_seconds: int

    @field_validator("agent_key")
    @classmethod
    def validate_agent_key(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 80:
            raise PydanticCustomError(
                "agent_key_length",
                "长度必须为 1 到 80 个字符",
            )
        return trimmed

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 120:
            raise PydanticCustomError(
                "display_name_length",
                "长度必须为 1 到 120 个字符",
            )
        return trimmed

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        trimmed = value.strip()
        if not 1 <= len(trimmed) <= 240:
            raise PydanticCustomError(
                "role_length",
                "长度必须为 1 到 240 个字符",
            )
        return trimmed

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        if not -10000 <= value <= 10000:
            raise PydanticCustomError(
                "sort_order_range",
                "必须介于 -10000 和 10000 之间",
            )
        return value

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        if not 60 <= value <= 86400:
            raise PydanticCustomError(
                "suspect_after_seconds_range",
                "必须介于 60 和 86400 之间",
            )
        return value


class UpdateAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    display_name: str = None
    role: str = None
    sort_order: int = None
    suspect_after_seconds: int = None
    lifecycle_status: Literal["active", "disabled"] = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        return RegisterAgentRequest.validate_display_name(value)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        return RegisterAgentRequest.validate_role(value)

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        return RegisterAgentRequest.validate_sort_order(value)

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        return RegisterAgentRequest.validate_suspect_after_seconds(value)

    @model_validator(mode="after")
    def require_update(self):
        if not self.model_fields_set:
            raise PydanticCustomError(
                "empty_patch",
                "至少提供一个要更新的字段",
            )
        return self


class ReplaceAgentRequest(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    coreai_agent_id: str
    display_name: str = None
    role: str = None
    sort_order: int = None
    suspect_after_seconds: int = None

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, value: str) -> str:
        return RegisterAgentRequest.validate_display_name(value)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        return RegisterAgentRequest.validate_role(value)

    @field_validator("sort_order")
    @classmethod
    def validate_sort_order(cls, value: int) -> int:
        return RegisterAgentRequest.validate_sort_order(value)

    @field_validator("suspect_after_seconds")
    @classmethod
    def validate_suspect_after_seconds(cls, value: int) -> int:
        return RegisterAgentRequest.validate_suspect_after_seconds(value)


class WorkbenchError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        fields: dict[str, str] | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            detail={"code": code, "message": message, "fields": fields or {}},
        )


def parse_workbench_mutation(model_type, raw: object) -> BaseModel:
    if isinstance(raw, dict):
        null_fields = {
            key: "Field may not be null"
            for key, value in raw.items()
            if value is None and key in model_type.model_fields
        }
        if null_fields:
            raise WorkbenchError(
                422,
                "VALIDATION_ERROR",
                "请求数据校验失败",
                null_fields,
            )
    try:
        return model_type.model_validate(raw)
    except ValidationError as exc:
        fields = {}
        for error in exc.errors(include_url=False, include_input=False):
            location = error.get("loc", ())
            field = ".".join(str(part) for part in location) or "body"
            fields[field] = sanitize_operator_text(error.get("msg"))
        raise WorkbenchError(
            422,
            "VALIDATION_ERROR",
            "请求数据校验失败",
            fields,
        ) from None


def get_agent_workbench_coreai():
    settings = coreai_connection_settings()
    if settings is None:
        raise WorkbenchError(
            503,
            "COREAI_NOT_CONFIGURED",
            "Core AI 连接未配置",
        )
    client = CoreAiClient(settings.base_url, settings.api_key)
    try:
        yield client
    finally:
        client.close()


def get_agent_workbench_coreai_factory():
    return get_agent_workbench_coreai


@router.get("")
def get_workbench_snapshot(
    range_key: str = Query("30d", alias="range"),
    conn=Depends(get_db),
):
    settings = agent_workbench_settings()
    return build_workbench_snapshot(
        conn, range_key, utc_now(), str(settings.timezone), settings.history_limit
    )


@router.get("/agents/{local_agent_id}/runs")
def get_projected_agent_runs(
    local_agent_id: str,
    range_key: str = Query("30d", alias="range"),
    limit: int = 20,
    before: str | None = None,
    conn=Depends(get_db),
):
    settings = agent_workbench_settings()
    return list_projected_agent_runs(
        conn, local_agent_id, range_key, limit, before, utc_now(), str(settings.timezone)
    )


@router.post("/agents", status_code=201)
async def register_agent(
    request: Request,
    conn=Depends(get_db),
    client=Depends(get_agent_workbench_coreai),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(RegisterAgentRequest, raw)
    metadata = verify_agent_metadata(
        client,
        body.coreai_agent_id,
        utc_now(),
        sensitive_values=_request_sensitive_values(),
    )
    return _register_agent(conn, body, metadata, utc_now())


@router.patch("/agents/{local_agent_id}")
async def update_agent(
    local_agent_id: str,
    request: Request,
    conn=Depends(get_db),
    client_factory=Depends(get_agent_workbench_coreai_factory),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(UpdateAgentRequest, raw)
    metadata = None
    if body.lifecycle_status == "active":
        row = conn.execute(
            "SELECT coreai_agent_id,status FROM seo_ops_agents WHERE id=?",
            (local_agent_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "disabled":
            client_dependency = client_factory()
            attempt_at = utc_now()
            sensitive_values = _request_sensitive_values()
            try:
                try:
                    client = next(client_dependency)
                    metadata = verify_agent_metadata(
                        client,
                        row["coreai_agent_id"],
                        attempt_at,
                        sensitive_values=sensitive_values,
                    )
                except WorkbenchError as exc:
                    _record_reenable_verification_failure(
                        conn,
                        local_agent_id,
                        row["coreai_agent_id"],
                        attempt_at,
                        exc,
                        sensitive_values,
                    )
                    raise
            finally:
                client_dependency.close()
    return _update_agent(conn, local_agent_id, body, utc_now(), metadata)


@router.post("/agents/{local_agent_id}/retire")
async def retire_agent(local_agent_id: str, request: Request, conn=Depends(get_db)):
    await require_empty_workbench_body(request)
    return _retire_agent(conn, local_agent_id, utc_now())


@router.post("/agents/{local_agent_id}/replace")
async def replace_agent(
    local_agent_id: str,
    request: Request,
    conn=Depends(get_db),
    client=Depends(get_agent_workbench_coreai),
):
    raw = await read_workbench_json(request)
    body = parse_workbench_mutation(ReplaceAgentRequest, raw)
    metadata = verify_agent_metadata(
        client,
        body.coreai_agent_id,
        utc_now(),
        sensitive_values=_request_sensitive_values(),
    )
    return _replace_agent(conn, local_agent_id, body, metadata, utc_now())


def sanitize_operator_text(
    value: object,
    sensitive_values: tuple[str, ...] = (),
) -> str:
    if isinstance(value, str):
        text = value
    elif isinstance(value, dict) and isinstance(value.get("message"), str):
        text = value["message"]
    else:
        return "上游消息不可用"
    for sensitive in sorted(
        {sensitive for sensitive in sensitive_values if sensitive},
        key=len,
        reverse=True,
    ):
        text = text.replace(sensitive, "[REDACTED]")
    text = re.sub(
        r"(?i)(?P<prefix>[?&;])"
        r"(?P<key>api[_-]?key|apikey|access[_-]?token|token|key|secret|authorization)"
        r"(?P<equals>=)[^&#;\s]*",
        lambda match: (
            f"{match.group('prefix')}{match.group('key')}"
            f"{match.group('equals')}[REDACTED]"
        ),
        text,
    )
    credential_label = (
        r"(?:authorization|api[-_ ]?key|access[-_ ]?token|token|secret)"
    )
    quoted_or_plain_label = (
        rf'(?:"{credential_label}"|\'{credential_label}\'|{credential_label})'
    )
    text = re.sub(
        rf'(?i)(?P<prefix>{quoted_or_plain_label}\s*[:=]\s*")'
        r'(?:(?:Basic|Bearer)\s+)?(?:\\.|[^"\\])*"',
        lambda match: f"{match.group('prefix')}[REDACTED]\"",
        text,
    )
    text = re.sub(
        rf"(?i)(?P<prefix>{quoted_or_plain_label}\s*[:=]\s*')"
        r"(?:(?:Basic|Bearer)\s+)?(?:\\.|[^'\\])*'",
        lambda match: f"{match.group('prefix')}[REDACTED]'",
        text,
    )
    text = re.sub(
        r"(?i)\bBearer\s+[^\s,;}&]+",
        "Bearer [REDACTED]",
        text,
    )
    text = re.sub(
        rf"(?i)(?P<prefix>{credential_label}\s*[:=]\s*)"
        r"(?:(?:Basic|Bearer)\s+)?[^\s,;}&\#]+",
        r"\g<prefix>[REDACTED]",
        text,
    )
    text = "".join(
        " " if unicodedata.category(char).startswith("C") else char
        for char in text
    )
    return " ".join(text.split())[:240].rstrip()


def parse_agent_run_page(
    expected_agent_id: str,
    page: dict,
    observed_at: datetime,
    *,
    expected_status: str | None = None,
    sensitive_values: Sequence[str] = (),
) -> ParsedAgentRunPage:
    parsed_runs = []
    seen_runs = {}
    for upstream_row in page["runs"]:
        row = {
            key: value
            for key, value in upstream_row.items()
            if key not in DISCARDED_UPSTREAM_FIELDS
        }
        for field_name in ("id", "status", "triggered_by"):
            value = row.get(field_name)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"invalid {field_name}")
        if row.get("agent_id") != expected_agent_id:
            raise ValueError("invalid agent_id")
        if expected_status is not None and row["status"] != expected_status:
            raise ValueError("invalid expected_status")
        warnings = []
        started_value = row.get("started_at")
        completed_value = row.get("completed_at")
        started_at, started_invalid = _parse_upstream_timestamp(started_value)
        completed_at, completed_invalid = _parse_upstream_timestamp(completed_value)
        if started_invalid:
            warnings.append("INVALID_STARTED_AT")
        if completed_invalid:
            warnings.append("INVALID_COMPLETED_AT")
        token_usage = row.get("token_usage")
        input_tokens = None
        output_tokens = None
        if isinstance(token_usage, dict):
            has_input = TOKEN_USAGE_INPUT_FIELD in token_usage
            has_output = TOKEN_USAGE_OUTPUT_FIELD in token_usage
            if has_input != has_output:
                warnings.append("TOKEN_USAGE_INVALID")
            input_value = token_usage.get(TOKEN_USAGE_INPUT_FIELD)
            output_value = token_usage.get(TOKEN_USAGE_OUTPUT_FIELD)
            if isinstance(input_value, bool) or isinstance(output_value, bool):
                if "TOKEN_USAGE_INVALID" not in warnings:
                    warnings.append("TOKEN_USAGE_INVALID")
            elif (
                isinstance(input_value, int)
                and isinstance(output_value, int)
                and (input_value < 0 or output_value < 0)
            ):
                if "TOKEN_USAGE_INVALID" not in warnings:
                    warnings.append("TOKEN_USAGE_INVALID")
            elif (
                isinstance(input_value, int)
                and input_value >= 0
                and isinstance(output_value, int)
                and output_value >= 0
            ):
                input_tokens = input_value
                output_tokens = output_value
            elif "TOKEN_USAGE_INVALID" not in warnings:
                warnings.append("TOKEN_USAGE_INVALID")
        raw_error = row.get("error")
        error_summary = None
        if isinstance(raw_error, str) or (
            isinstance(raw_error, dict)
            and isinstance(raw_error.get("message"), str)
        ):
            error_summary = sanitize_operator_text(
                raw_error,
                sensitive_values=tuple(sensitive_values),
            )
        elif "error" in row and raw_error is not None:
            error_summary = "上游消息不可用"
        parsed_run = ParsedAgentRun(
            coreai_run_id=row["id"],
            coreai_agent_id=row["agent_id"],
            raw_status=row["status"],
            trigger_type=row["triggered_by"],
            started_at=started_at,
            completed_at=completed_at,
            completed_at_state=(
                "invalid"
                if completed_invalid
                else "missing" if completed_value is None else "valid"
            ),
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            trace_id=(
                row.get("trace_id")
                if isinstance(row.get("trace_id"), str)
                else None
            ),
            error_summary=error_summary,
            warnings=tuple(warnings),
        )
        previous = seen_runs.get(parsed_run.coreai_run_id)
        if previous == parsed_run:
            continue
        if previous is not None:
            raise ValueError("conflicting duplicate run id")
        seen_runs[parsed_run.coreai_run_id] = parsed_run
        parsed_runs.append(parsed_run)
    total = page.get("total")
    if (
        not isinstance(total, int)
        or isinstance(total, bool)
        or total < len(parsed_runs)
    ):
        raise ValueError("invalid total")
    return ParsedAgentRunPage(
        runs=tuple(parsed_runs),
        total=total,
        returned_count=len(parsed_runs),
        observed_at=_utc_iso(observed_at),
    )


def _parse_upstream_timestamp(value: object) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    try:
        parsed = datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None, True
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None, True
    return _utc_iso(parsed), False


def receipt_expiry(
    *,
    previous_raw_status: str | None,
    previous_last_synced_at: datetime | None,
    incoming: ParsedAgentRun,
    terminal_observed_at: datetime,
) -> datetime | None:
    if incoming.raw_status not in KNOWN_TERMINAL:
        return None
    if incoming.completed_at_state == "valid":
        completed = datetime.fromisoformat(incoming.completed_at)
        delta = (terminal_observed_at - completed).total_seconds()
        return (
            terminal_observed_at + timedelta(seconds=10)
            if 0 <= delta <= 10
            else None
        )
    if incoming.completed_at_state == "invalid":
        return None
    recently_seen = (
        previous_last_synced_at is not None
        and 0
        <= (terminal_observed_at - previous_last_synced_at).total_seconds()
        <= 15
    )
    return (
        terminal_observed_at + timedelta(seconds=10)
        if previous_raw_status in KNOWN_NONTERMINAL and recently_seen
        else None
    )


def _binding_merchant_id(conn, binding: LocalRunBinding | None) -> int | None:
    if binding is None:
        return None
    queries = {
        "run": "SELECT merchant_id FROM runs WHERE id=?",
        "task_execution": (
            "SELECT t.merchant_id FROM task_executions e "
            "JOIN tasks t ON t.id=e.task_id WHERE e.id=?"
        ),
        "merchant_seo_artifact": (
            "SELECT merchant_id FROM merchant_seo_artifacts WHERE id=?"
        ),
    }
    query = queries.get(binding.source_kind)
    if query is None:
        raise ValueError("invalid source_kind")
    row = conn.execute(query, (binding.source_local_id,)).fetchone()
    if row is None:
        raise ValueError("invalid source_local_id")
    return row[0]


def resolve_local_association(conn, coreai_run_id: str) -> LocalAssociationResolution:
    conn.execute("BEGIN IMMEDIATE")
    try:
        projected = conn.execute(
            "SELECT source_kind,source_local_id,merchant_id "
            "FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (coreai_run_id,),
        ).fetchone()
        if projected is None:
            raise ValueError("projected run not found")
        matches = conn.execute(
            "SELECT 'run' AS source_kind,id AS source_local_id,merchant_id,"
            "'/runs/' || id AS local_href,'Run #' || id AS local_label "
            "FROM runs WHERE coreai_run_id=? "
            "UNION ALL "
            "SELECT 'task_execution',e.id,t.merchant_id,"
            "'/tasks/' || t.id,t.title "
            "FROM task_executions e JOIN tasks t ON t.id=e.task_id "
            "WHERE e.coreai_run_id=? "
            "UNION ALL "
            "SELECT 'merchant_seo_artifact',id,merchant_id,"
            "'/merchants/' || merchant_id || '/profile',"
            "artifact_type || ' #' || id "
            "FROM merchant_seo_artifacts WHERE coreai_run_id=?",
            (coreai_run_id, coreai_run_id, coreai_run_id),
        ).fetchall()
        existing_binding = (
            LocalRunBinding(projected[0], projected[1])
            if projected[0] is not None and projected[1] is not None
            else None
        )
        if existing_binding is not None:
            bound_match = next(
                (
                    match
                    for match in matches
                    if match[0] == existing_binding.source_kind
                    and match[1] == existing_binding.source_local_id
                ),
                None,
            )
            warnings = (
                ("LOCAL_ASSOCIATION_CONFLICT",)
                if len(matches) > 1 or (matches and bound_match is None)
                else ()
            )
            result = LocalAssociationResolution(
                existing_binding,
                projected[2],
                (
                    bound_match[3]
                    if bound_match is not None and projected[2] is not None
                    else None
                ),
                (
                    bound_match[4]
                    if bound_match is not None and projected[2] is not None
                    else None
                ),
                warnings,
            )
        elif not matches:
            result = LocalAssociationResolution(None, None, None, None, ())
        elif len(matches) == 1:
            match = matches[0]
            binding = LocalRunBinding(match[0], match[1])
            conn.execute(
                "UPDATE seo_ops_agent_runs SET source_kind=?,source_local_id=?,"
                "merchant_id=? WHERE coreai_run_id=? AND source_kind IS NULL "
                "AND source_local_id IS NULL",
                (binding.source_kind, binding.source_local_id, match[2], coreai_run_id),
            )
            result = LocalAssociationResolution(
                binding, match[2], match[3], match[4], ()
            )
        else:
            result = LocalAssociationResolution(
                None, None, None, None, ("LOCAL_ASSOCIATION_CONFLICT",)
            )
        conn.commit()
        return result
    except Exception:
        conn.rollback()
        raise


def association_preflight_warnings(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT coreai_run_id,source_kind FROM ("
        "SELECT coreai_run_id,'run' AS source_kind FROM runs "
        "WHERE coreai_run_id IS NOT NULL "
        "UNION ALL "
        "SELECT coreai_run_id,'task_execution' FROM task_executions "
        "WHERE coreai_run_id IS NOT NULL "
        "UNION ALL "
        "SELECT coreai_run_id,'merchant_seo_artifact' "
        "FROM merchant_seo_artifacts WHERE coreai_run_id IS NOT NULL"
        ") ORDER BY coreai_run_id,source_kind"
    ).fetchall()
    bindings: dict[str, list[str]] = {}
    for coreai_run_id, source_kind in rows:
        bindings.setdefault(coreai_run_id, []).append(source_kind)
    return [
        {
            "code": "LOCAL_ASSOCIATION_CONFLICT",
            "message": "Core AI Run ID 对应多个本地记录",
            "fields": {
                "coreai_run_id": coreai_run_id,
                "source_kinds": ",".join(sorted(set(source_kinds))),
            },
        }
        for coreai_run_id, source_kinds in bindings.items()
        if len(source_kinds) > 1
    ]


def upsert_projected_run(
    conn,
    local_agent_id,
    run: ParsedAgentRun,
    observed_at,
    binding: LocalRunBinding | None = None,
) -> ProjectionResult:
    stamp = _utc_iso(observed_at)
    warning_codes = tuple(sorted(set(run.warnings)))
    conn.execute("BEGIN IMMEDIATE")
    try:
        owner = conn.execute(
            "SELECT coreai_agent_id FROM seo_ops_agents WHERE id=?",
            (local_agent_id,),
        ).fetchone()
        if owner is None or owner[0] != run.coreai_agent_id:
            raise ValueError("invalid projected run owner")
        existing = conn.execute(
            "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run.coreai_run_id,),
        ).fetchone()
        if existing is not None and existing["seo_ops_agent_id"] != local_agent_id:
            raise ValueError("projected run already has another owner")
        if existing is not None:
            existing_warning_set = set(
                json.loads(existing["data_warning_codes_json"])
            )
            if "TERMINAL_STATUS_CONFLICT" in existing_warning_set:
                warning_codes = tuple(
                    sorted(set(warning_codes) | {"TERMINAL_STATUS_CONFLICT"})
                )
        if existing is not None and existing["last_synced_at"] is not None:
            previous_sync = datetime.fromisoformat(existing["last_synced_at"])
            current_sync = datetime.fromisoformat(stamp)
        else:
            previous_sync = None
            current_sync = None
        if (
            previous_sync is not None
            and current_sync is not None
            and current_sync <= previous_sync
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id,
                "unchanged" if current_sync == previous_sync else "older_ignored",
                existing_warnings,
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status in KNOWN_NONTERMINAL
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL WHERE coreai_run_id=?",
                (stamp, stamp, run.coreai_run_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "conflict_ignored", existing_warnings
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status == existing["raw_status"]
        ):
            existing_warnings = tuple(
                sorted(json.loads(existing["data_warning_codes_json"]))
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL WHERE coreai_run_id=?",
                (stamp, stamp, run.coreai_run_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "updated", existing_warnings
            )
        if (
            existing is not None
            and existing["raw_status"] in KNOWN_TERMINAL
            and run.raw_status not in KNOWN_NONTERMINAL
        ):
            conflict_warnings = tuple(
                sorted(
                    set(json.loads(existing["data_warning_codes_json"]))
                    | {"TERMINAL_STATUS_CONFLICT"}
                )
            )
            conn.execute(
                "UPDATE seo_ops_agent_runs SET last_poll_attempt_at=?,"
                "last_synced_at=?,last_poll_error=NULL,data_warning_codes_json=? "
                "WHERE coreai_run_id=?",
                (
                    stamp,
                    stamp,
                    json.dumps(conflict_warnings, separators=(",", ":")),
                    run.coreai_run_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1 "
                "WHERE seo_ops_agent_id=?",
                (local_agent_id,),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "conflict_ignored", conflict_warnings
            )
        if existing is not None and (
            existing["raw_status"] is None
            or existing["raw_status"] == run.raw_status
            or existing["raw_status"] in KNOWN_NONTERMINAL
            or _is_unknown_status(existing["raw_status"])
        ):
            terminal_observed_at = existing["terminal_observed_at"]
            receipt_expires_at = existing["receipt_expires_at"]
            if (
                run.raw_status in KNOWN_TERMINAL
                and existing["raw_status"] not in KNOWN_TERMINAL
                and terminal_observed_at is None
            ):
                terminal_observation = datetime.fromisoformat(stamp)
                expiry = receipt_expiry(
                    previous_raw_status=existing["raw_status"],
                    previous_last_synced_at=previous_sync,
                    incoming=run,
                    terminal_observed_at=terminal_observation,
                )
                terminal_observed_at = stamp
                receipt_expires_at = _utc_iso(expiry) if expiry is not None else None
            conn.execute(
                "UPDATE seo_ops_agent_runs SET raw_status=?,trigger_type=?,started_at=?,"
                "completed_at=?,terminal_observed_at=?,receipt_expires_at=?,"
                "input_tokens=?,output_tokens=?,trace_id=?,"
                "error_summary=?,last_poll_attempt_at=?,last_synced_at=?,"
                "last_poll_error=NULL,data_warning_codes_json=? "
                "WHERE coreai_run_id=?",
                (
                    run.raw_status,
                    run.trigger_type,
                    run.started_at,
                    run.completed_at,
                    terminal_observed_at,
                    receipt_expires_at,
                    run.input_tokens,
                    run.output_tokens,
                    run.trace_id,
                    run.error_summary,
                    stamp,
                    stamp,
                    json.dumps(warning_codes, separators=(",", ":")),
                    run.coreai_run_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "projection_revision=projection_revision+1,"
                "unresolved_unknown_status_count="
                "unresolved_unknown_status_count+? "
                "WHERE seo_ops_agent_id=?",
                (
                    int(_is_unknown_status(run.raw_status))
                    - int(
                        existing["raw_status"] is None
                        or _is_unknown_status(existing["raw_status"])
                    ),
                    local_agent_id,
                ),
            )
            conn.commit()
            return ProjectionResult(
                run.coreai_run_id, "updated", warning_codes
            )
        merchant_id = _binding_merchant_id(conn, binding)
        terminal_observed = (
            datetime.fromisoformat(stamp)
            if run.raw_status in KNOWN_TERMINAL
            else None
        )
        expires = (
            receipt_expiry(
                previous_raw_status=None,
                previous_last_synced_at=None,
                incoming=run,
                terminal_observed_at=terminal_observed,
            )
            if terminal_observed is not None
            else None
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_runs ("
            "coreai_run_id,seo_ops_agent_id,raw_status,trigger_type,started_at,"
            "completed_at,terminal_observed_at,receipt_expires_at,"
            "input_tokens,output_tokens,trace_id,error_summary,"
            "source_kind,source_local_id,merchant_id,first_seen_at,"
            "last_poll_attempt_at,last_synced_at,last_poll_error,"
            "data_warning_codes_json"
            ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)",
            (
                run.coreai_run_id,
                local_agent_id,
                run.raw_status,
                run.trigger_type,
                run.started_at,
                run.completed_at,
                _utc_iso(terminal_observed) if terminal_observed is not None else None,
                _utc_iso(expires) if expires is not None else None,
                run.input_tokens,
                run.output_tokens,
                run.trace_id,
                run.error_summary,
                binding.source_kind if binding is not None else None,
                binding.source_local_id if binding is not None else None,
                merchant_id,
                stamp,
                stamp,
                stamp,
                json.dumps(warning_codes, separators=(",", ":")),
            ),
        )
        inserted = conn.execute(
            "SELECT coreai_run_id FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run.coreai_run_id,),
        ).fetchone()
        if inserted is None:
            raise RuntimeError("projected run insert readback failed")
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET "
            "projection_revision=projection_revision+1,"
            "unresolved_unknown_status_count="
            "unresolved_unknown_status_count+? "
            "WHERE seo_ops_agent_id=?",
            (int(_is_unknown_status(run.raw_status)), local_agent_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return ProjectionResult(run.coreai_run_id, "inserted", warning_codes)


def _utc_iso(now: datetime) -> str:
    return now.astimezone(timezone.utc).isoformat()


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass(frozen=True)
class VerifiedAgentMetadata:
    coreai_agent_id: str
    name: str
    model: str | None
    timeout_hint_seconds: int | None
    verified_at: str


def verify_agent_metadata(
    client,
    coreai_agent_id: str,
    now: datetime,
    sensitive_values=(),
) -> VerifiedAgentMetadata:
    try:
        raw = client.get_agent(coreai_agent_id)
    except CoreAiContractError as exc:
        if exc.code == "AGENT_ID_MISMATCH":
            raise WorkbenchError(
                422,
                "AGENT_ID_MISMATCH",
                "Core AI Agent ID 不匹配",
            ) from None
        raise WorkbenchError(
            422,
            "AGENT_METADATA_INVALID",
            "Core AI Agent 元数据不可用",
        ) from None
    except CoreAiError:
        raise WorkbenchError(
            503,
            "COREAI_VERIFICATION_FAILED",
            "Core AI 暂时不可用，稍后重试",
        ) from None
    if raw.get("id") != coreai_agent_id:
        raise WorkbenchError(
            422,
            "AGENT_ID_MISMATCH",
            "Core AI Agent ID 不匹配",
        )
    if raw.get("type") != "AGENT":
        raise WorkbenchError(
            422,
            "AGENT_TYPE_INVALID",
            "该 Core AI 定义不是 Agent",
        )
    if raw.get("status") != "PUBLISHED":
        raise WorkbenchError(
            422,
            "AGENT_NOT_PUBLISHED",
            "Core AI Agent 尚未发布",
        )
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        raise WorkbenchError(
            422,
            "AGENT_NAME_INVALID",
            "Core AI Agent 名称不可用",
        )
    model = raw.get("model")
    timeout = raw.get("timeout_seconds")
    timeout_hint = (
        timeout
        if isinstance(timeout, int)
        and not isinstance(timeout, bool)
        and timeout > 0
        else None
    )
    safe_name = sanitize_operator_text(name, sensitive_values=sensitive_values)
    if not safe_name:
        raise WorkbenchError(
            422,
            "AGENT_NAME_INVALID",
            "Core AI Agent 名称不可用",
        )
    return VerifiedAgentMetadata(
        coreai_agent_id=coreai_agent_id,
        name=safe_name,
        model=(
            sanitize_operator_text(model, sensitive_values=sensitive_values)
            if isinstance(model, str) and model.strip()
            else None
        ),
        timeout_hint_seconds=timeout_hint,
        verified_at=_utc_iso(now),
    )


def _request_sensitive_values() -> tuple[str, ...]:
    settings = coreai_connection_settings()
    candidates = (
        settings.api_key if settings is not None else "",
        os.environ.get("SEO_OPS_AUTH_PASSWORD", ""),
        os.environ.get("SEO_OPS_AUTH_SECRET", ""),
    )
    return tuple(value for value in candidates if value)


def _register_agent(conn, body, metadata: VerifiedAgentMetadata, now: datetime):
    local_id = str(uuid.uuid4())
    stamp = _utc_iso(now)
    next_verification = _utc_iso(now + timedelta(hours=24))
    conn.execute("BEGIN IMMEDIATE")
    try:
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id=?",
            (body.coreai_agent_id,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "该 Core AI Agent 已注册",
                {"coreai_agent_id": "已存在"},
            )
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE agent_key=? AND status<>'retired'",
            (body.agent_key,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "AGENT_KEY_CONFLICT",
                "该 Agent 角色键已在使用",
                {"agent_key": "已存在"},
            )
        conn.execute(
            "INSERT INTO seo_ops_agents ("
            "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
            "coreai_name,coreai_model,coreai_timeout_hint_seconds,"
            "suspect_after_seconds,last_verification_attempt_at,last_verified_at,"
            "last_verification_error,verification_failure_count,next_verification_at,"
            "created_at,updated_at"
            ") VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,NULL,0,?,?,?)",
            (
                local_id,
                body.agent_key,
                body.coreai_agent_id,
                body.display_name,
                body.role,
                body.sort_order,
                metadata.name,
                metadata.model,
                metadata.timeout_hint_seconds,
                body.suspect_after_seconds,
                stamp,
                metadata.verified_at,
                next_verification,
                stamp,
                stamp,
            ),
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_sync_state "
            "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
            (local_id, stamp),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _update_agent(
    conn,
    local_id: str,
    body: UpdateAgentRequest,
    now: datetime,
    metadata: VerifiedAgentMetadata | None = None,
):
    fields = body.model_fields_set - {"lifecycle_status"}
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT status FROM seo_ops_agents WHERE id=?",
            (local_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "retired":
            raise WorkbenchError(409, "AGENT_RETIRED", "已归档 Agent 不可修改")
        if fields:
            assignments = ",".join(f"{field}=?" for field in sorted(fields))
            values = [getattr(body, field) for field in sorted(fields)]
            conn.execute(
                f"UPDATE seo_ops_agents SET {assignments},updated_at=? WHERE id=?",
                (*values, _utc_iso(now), local_id),
            )
        if (
            "lifecycle_status" in body.model_fields_set
            and body.lifecycle_status == "disabled"
            and row["status"] == "active"
        ):
            stamp = _utc_iso(now)
            conn.execute(
                "UPDATE seo_ops_agents SET status='disabled',updated_at=? WHERE id=?",
                (stamp, local_id),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
                "WHERE seo_ops_agent_id=?",
                (_utc_iso(now + timedelta(minutes=15)), local_id),
            )
        if (
            "lifecycle_status" in body.model_fields_set
            and body.lifecycle_status == "active"
            and row["status"] == "disabled"
            and metadata is not None
        ):
            stamp = _utc_iso(now)
            conn.execute(
                "UPDATE seo_ops_agents SET status='active',coreai_name=?,"
                "coreai_model=?,coreai_timeout_hint_seconds=?,"
                "last_verification_attempt_at=?,last_verified_at=?,"
                "last_verification_error=NULL,verification_failure_count=0,"
                "next_verification_at=?,updated_at=? WHERE id=?",
                (
                    metadata.name,
                    metadata.model,
                    metadata.timeout_hint_seconds,
                    stamp,
                    metadata.verified_at,
                    _utc_iso(now + timedelta(hours=24)),
                    stamp,
                    local_id,
                ),
            )
            conn.execute(
                "UPDATE seo_ops_agent_sync_state SET "
                "local_event_epoch=local_event_epoch+1,sync_pending=1,"
                "pending_set_quality='unknown',running_set_quality='unknown',"
                "paused_set_quality='unknown',current_state_complete=0,"
                "next_discovery_at=? WHERE seo_ops_agent_id=?",
                (stamp, local_id),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _record_reenable_verification_failure(
    conn,
    local_id: str,
    coreai_agent_id: str,
    now: datetime,
    error: WorkbenchError,
    sensitive_values: tuple[str, ...],
) -> None:
    detail = error.detail if isinstance(error.detail, dict) else {}
    code = detail.get("code")
    message = detail.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        code = "COREAI_VERIFICATION_FAILED"
        message = "Core AI 暂时不可用，稍后重试"
    error_summary = sanitize_operator_text(
        f"{code}: {message}",
        sensitive_values=sensitive_values,
    )
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT verification_failure_count FROM seo_ops_agents "
            "WHERE id=? AND coreai_agent_id=? AND status='disabled'",
            (local_id, coreai_agent_id),
        ).fetchone()
        if row is not None:
            failure_count = row["verification_failure_count"] + 1
            retry_seconds = min(60 * (2 ** min(failure_count - 1, 6)), 3600)
            conn.execute(
                "UPDATE seo_ops_agents SET last_verification_attempt_at=?,"
                "last_verification_error=?,verification_failure_count=?,"
                "next_verification_at=? "
                "WHERE id=? AND coreai_agent_id=? AND status='disabled'",
                (
                    stamp,
                    error_summary,
                    failure_count,
                    _utc_iso(now + timedelta(seconds=retry_seconds)),
                    local_id,
                    coreai_agent_id,
                ),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _retire_agent(conn, local_id: str, now: datetime):
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT status FROM seo_ops_agents WHERE id=?",
            (local_id,),
        ).fetchone()
        if row is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if row["status"] == "retired":
            raise WorkbenchError(
                409,
                "AGENT_RETIRED",
                "Agent 已归档，不能重复归档",
            )
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=?,updated_at=? "
            "WHERE id=?",
            (stamp, stamp, local_id),
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
            "WHERE seo_ops_agent_id=?",
            (_utc_iso(now + timedelta(hours=24)), local_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, local_id)


def _replace_agent(
    conn,
    old_local_id: str,
    body: ReplaceAgentRequest,
    metadata: VerifiedAgentMetadata,
    now: datetime,
):
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        old = conn.execute(
            "SELECT * FROM seo_ops_agents WHERE id=?",
            (old_local_id,),
        ).fetchone()
        if old is None:
            raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
        if old["status"] == "retired":
            raise WorkbenchError(409, "AGENT_RETIRED", "已归档 Agent 不可替换")
        if body.coreai_agent_id == old["coreai_agent_id"]:
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "替换 Agent 必须使用新的 Core AI Agent ID",
                {"coreai_agent_id": "必须与当前 ID 不同"},
            )
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id=?",
            (body.coreai_agent_id,),
        ).fetchone():
            raise WorkbenchError(
                409,
                "COREAI_AGENT_ID_CONFLICT",
                "该 Core AI Agent 已注册",
                {"coreai_agent_id": "已存在"},
            )

        new_local_id = str(uuid.uuid4())
        inherited = {
            field: (
                getattr(body, field)
                if field in body.model_fields_set
                else old[field]
            )
            for field in (
                "display_name",
                "role",
                "sort_order",
                "suspect_after_seconds",
            )
        }
        conn.execute(
            "UPDATE seo_ops_agents SET status='retired',retired_at=?,updated_at=? "
            "WHERE id=?",
            (stamp, stamp, old_local_id),
        )
        conn.execute(
            "UPDATE seo_ops_agent_sync_state SET next_discovery_at=? "
            "WHERE seo_ops_agent_id=?",
            (_utc_iso(now + timedelta(hours=24)), old_local_id),
        )
        conn.execute(
            "INSERT INTO seo_ops_agents ("
            "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
            "coreai_name,coreai_model,coreai_timeout_hint_seconds,"
            "suspect_after_seconds,last_verification_attempt_at,last_verified_at,"
            "last_verification_error,verification_failure_count,next_verification_at,"
            "created_at,updated_at"
            ") VALUES (?,?,?,?,?,?,'active',?,?,?,?,?,?,NULL,0,?,?,?)",
            (
                new_local_id,
                old["agent_key"],
                body.coreai_agent_id,
                inherited["display_name"],
                inherited["role"],
                inherited["sort_order"],
                metadata.name,
                metadata.model,
                metadata.timeout_hint_seconds,
                inherited["suspect_after_seconds"],
                stamp,
                metadata.verified_at,
                _utc_iso(now + timedelta(hours=24)),
                stamp,
                stamp,
            ),
        )
        conn.execute(
            "INSERT INTO seo_ops_agent_sync_state "
            "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
            (new_local_id, stamp),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _mutation_response(conn, new_local_id)


def _mutation_response(conn, local_id: str) -> dict:
    row = conn.execute(
        "SELECT a.*, s.sync_pending FROM seo_ops_agents a "
        "JOIN seo_ops_agent_sync_state s ON s.seo_ops_agent_id=a.id "
        "WHERE a.id=?",
        (local_id,),
    ).fetchone()
    if row is None:
        raise WorkbenchError(404, "AGENT_NOT_FOUND", "Agent 不存在")
    sync_pending = bool(row["sync_pending"])
    return {
        "agent": {
            "id": row["id"],
            "agent_key": row["agent_key"],
            "coreai_agent_id": row["coreai_agent_id"],
            "display_name": row["display_name"],
            "role": row["role"],
            "sort_order": row["sort_order"],
            "lifecycle_status": row["status"],
            "coreai_metadata": {
                "name": row["coreai_name"],
                "model": row["coreai_model"],
                "timeout_hint_seconds": row["coreai_timeout_hint_seconds"],
                "last_verified_at": row["last_verified_at"],
                "verification_error": row["last_verification_error"],
            },
            "suspect_after_seconds": row["suspect_after_seconds"],
            "sync_pending": sync_pending,
        },
        "sync_pending": sync_pending,
    }


@dataclass(frozen=True)
class WorkbenchWarning:
    code: str
    message: str
    fields: dict[str, str]


def _configuration_plan(conn, slots):
    selected_by_id: dict[str, object] = {}
    accepted = []
    warnings: list[WorkbenchWarning] = []
    for slot in slots:
        selected = selected_by_id.get(slot.coreai_agent_id)
        if selected is not None:
            warnings.append(
                WorkbenchWarning(
                    code="CONFIG_DUPLICATE_AGENT_ID",
                    message="多个配置槽使用同一个 Core AI Agent ID",
                    fields={
                        "coreai_agent_id": slot.coreai_agent_id,
                        "selected_env": selected.env_name,
                        "ignored_env": slot.env_name,
                    },
                )
            )
            continue
        selected_by_id[slot.coreai_agent_id] = slot
        if conn.execute(
            "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id = ?",
            (slot.coreai_agent_id,),
        ).fetchone():
            accepted.append(slot)
            continue
        current = conn.execute(
            "SELECT coreai_agent_id FROM seo_ops_agents "
            "WHERE agent_key = ? AND status <> 'retired'",
            (slot.agent_key,),
        ).fetchone()
        if current is not None:
            warnings.append(
                WorkbenchWarning(
                    code="CONFIG_ROLE_CONFLICT",
                    message="配置角色已绑定另一个 Core AI Agent ID",
                    fields={
                        "agent_key": slot.agent_key,
                        "configured_coreai_agent_id": slot.coreai_agent_id,
                        "registered_coreai_agent_id": current[0],
                        "env_name": slot.env_name,
                    },
                )
            )
            continue
        accepted.append(slot)
    return accepted, warnings


def bootstrap_configuration_warnings(conn, slots) -> list[WorkbenchWarning]:
    return _configuration_plan(conn, slots)[1]


async def read_workbench_json(request) -> object:
    raw = await request.body()
    if raw == b"":
        raise WorkbenchError(
            422,
            "REQUEST_BODY_REQUIRED",
            "请求正文不能为空",
            {"body": "请求正文不能为空"},
        )
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, ValueError):
        raise WorkbenchError(
            422,
            "INVALID_JSON",
            "请求正文不是有效的 JSON",
            {"body": "请求正文不是有效的 JSON"},
        ) from None
    if not isinstance(parsed, dict):
        raise WorkbenchError(
            422,
            "VALIDATION_ERROR",
            "请求数据校验失败",
            {"body": "必须是 JSON 对象"},
        )
    return parsed


async def require_empty_workbench_body(request) -> None:
    raw = await request.body()
    if raw == b"":
        return None
    raise WorkbenchError(
        422,
        "UNEXPECTED_REQUEST_BODY",
        "此操作不接受请求正文",
        {"body": "此操作不接受请求正文"},
    )


def seed_configured_agents(conn, slots, now: datetime) -> list[dict]:
    stamp = _utc_iso(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        accepted, warnings = _configuration_plan(conn, slots)
        for slot in accepted:
            if conn.execute(
                "SELECT 1 FROM seo_ops_agents WHERE coreai_agent_id = ?",
                (slot.coreai_agent_id,),
            ).fetchone():
                continue
            local_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO seo_ops_agents ("
                "id,agent_key,coreai_agent_id,display_name,role,sort_order,status,"
                "suspect_after_seconds,created_at,updated_at"
                ") VALUES (?,?,?,?,?,?,'active',1800,?,?)",
                (
                    local_id,
                    slot.agent_key,
                    slot.coreai_agent_id,
                    slot.display_name,
                    slot.role,
                    slot.sort_order,
                    stamp,
                    stamp,
                ),
            )
            conn.execute(
                "INSERT INTO seo_ops_agent_sync_state "
                "(seo_ops_agent_id,sync_pending,next_discovery_at) VALUES (?,1,?)",
                (local_id, stamp),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return [asdict(warning) for warning in warnings]

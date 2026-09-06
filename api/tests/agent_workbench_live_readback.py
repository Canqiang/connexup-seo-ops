"""Read-only Agent Workbench live reconciliation gate.

The command is intentionally acceptance-only.  It validates the loopback API
target before loading the named environment, opens SQLite in read-only mode,
and uses only Core AI Agent metadata and Agent-run list endpoints.  Its output
is one canonical, allow-listed JSON record; arbitrary exception text and HTTP
bodies never cross the diagnostic boundary.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import multiprocessing
import re
import sqlite3
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable, Mapping
from urllib.parse import quote, urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import agent_workbench
from app.auth import COOKIE_NAME, make_session
from app.config import CoreAiConnectionSettings, configured_agent_slots
from app.coreai import CoreAiClient, CoreAiContractError, CoreAiError


SCHEMA_VERSION = "agent_workbench_live_readback.v1"
MAX_LIVE_READBACK_WORKERS = 8
LIST_LIMIT = 200
DEFAULT_TIMEOUT_SECONDS = 240
NORMAL_PROOF_INTERVAL_SECONDS = 30
RESULT_OK = "LIVE_GATE_OK"
RESULT_UNAVAILABLE = "LIVE_GATE_UNAVAILABLE"
RESULT_MISMATCH = "LIVE_GATE_MISMATCH"
RESULT_UNSTABLE = "LIVE_GATE_UNSTABLE"
RESULT_TIMEOUT = "LIVE_GATE_TIMEOUT"
RESULT_UNCONFIRMED = "LIVE_GATE_UNCONFIRMED_RUN"
RESULT_TRANSITION_MISSING = "LIVE_TRANSITION_NOT_OBSERVED"
EXIT_CODES = {
    RESULT_OK: 0,
    RESULT_UNAVAILABLE: 20,
    RESULT_MISMATCH: 21,
    RESULT_UNSTABLE: 22,
    RESULT_TIMEOUT: 23,
    RESULT_UNCONFIRMED: 24,
    RESULT_TRANSITION_MISSING: 25,
}
TERMINAL = frozenset({"COMPLETED", "FAILED", "TIMEOUT", "CANCELLED", "SKIPPED"})
FILTERS = (None, "PENDING", "RUNNING", "PAUSED")
_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ID = re.compile(r"^[^\x00-\x1f\x7f]{1,200}$")
_AGENT_SEMANTIC_FIELDS = (
    "id",
    "agent_key",
    "coreai_agent_id",
    "display_name",
    "role",
    "sort_order",
    "status",
    "coreai_name",
    "coreai_model",
    "coreai_timeout_hint_seconds",
    "suspect_after_seconds",
    "last_verification_error",
    "verification_failure_count",
)
_SYNC_SEMANTIC_FIELDS = (
    "seo_ops_agent_id",
    "remote_total_runs",
    "last_discovery_error",
    "last_discovery_returned_count",
    "coverage_start_at",
    "finite_range_proven_start_at",
    "pending_observed_count",
    "pending_upstream_total",
    "pending_set_quality",
    "running_observed_count",
    "running_upstream_total",
    "running_set_quality",
    "paused_observed_count",
    "paused_upstream_total",
    "paused_set_quality",
    "unresolved_unknown_status_count",
    "current_state_complete",
    "current_state_error",
    "sync_pending",
    "local_event_epoch",
    "history_event_epoch",
    "unfiltered_proven_event_epoch",
    "projection_revision",
    "last_fast_poll_error",
    "discovery_failure_count",
    "fast_poll_failure_count",
)
_RUN_SEMANTIC_FIELDS = (
    "coreai_run_id",
    "seo_ops_agent_id",
    "raw_status",
    "trigger_type",
    "started_at",
    "completed_at",
    "terminal_observed_at",
    "receipt_expires_at",
    "input_tokens",
    "output_tokens",
    "trace_id",
    "error_summary",
    "source_kind",
    "source_local_id",
    "merchant_id",
    "first_seen_at",
    "last_poll_error",
    "data_warning_codes_json",
)


class GateFailure(Exception):
    """A fixed-code acceptance failure; its args are never serialized."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class Deadline:
    expires_at: float
    monotonic: Callable[[], float] = time.monotonic

    @classmethod
    def start(
        cls, seconds: int, monotonic: Callable[[], float] = time.monotonic
    ) -> "Deadline":
        return cls(monotonic() + seconds, monotonic)

    def remaining(self) -> float:
        value = self.expires_at - self.monotonic()
        if value <= 0:
            raise GateFailure(RESULT_TIMEOUT)
        return value


def _canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"


def validate_api_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise GateFailure(RESULT_UNAVAILABLE) from None
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost"}
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != ""
        or parsed.query
        or parsed.fragment
    ):
        raise GateFailure(RESULT_UNAVAILABLE)
    return f"http://{parsed.hostname}:{port}"


def _decode_env_value(raw: str) -> str:
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == "'":
        return raw[1:-1]
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        body = raw[1:-1]
        return bytes(body, "utf-8").decode("unicode_escape")
    # Inline comments are accepted only when preceded by whitespace.
    return re.split(r"\s+#", raw, maxsplit=1)[0].rstrip()


def load_named_environment(path_value: str) -> dict[str, str]:
    path = Path(path_value).expanduser()
    try:
        if not path.is_file():
            raise OSError
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        raise GateFailure(RESULT_UNAVAILABLE) from None
    values: dict[str, str] = {}
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[7:].lstrip()
        key, separator, raw = stripped.partition("=")
        key = key.strip()
        if not separator or not _ENV_KEY.fullmatch(key):
            raise GateFailure(RESULT_UNAVAILABLE)
        values[key] = _decode_env_value(raw)
    return values


def _required(values: Mapping[str, str], key: str) -> str:
    value = values.get(key, "")
    if not isinstance(value, str) or not value.strip():
        raise GateFailure(RESULT_UNAVAILABLE)
    return value.strip()


def _positive_int(values: Mapping[str, str], key: str, default: int) -> int:
    raw = values.get(key, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        raise GateFailure(RESULT_UNAVAILABLE) from None
    if value < 1 or value > 1000:
        raise GateFailure(RESULT_UNAVAILABLE)
    return value


def _read_connection(path_value: str) -> sqlite3.Connection:
    path = Path(path_value).expanduser().absolute()
    if not path.is_file():
        raise GateFailure(RESULT_UNAVAILABLE)
    uri = f"file:{quote(str(path), safe='/')}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
    except sqlite3.Error:
        raise GateFailure(RESULT_UNAVAILABLE) from None
    return conn


def _request_aggregate(
    api_url: str,
    range_key: str,
    values: Mapping[str, str],
    deadline: Deadline,
    *,
    client_factory: Callable[..., httpx.Client] = httpx.Client,
) -> dict:
    username = _required(values, "SEO_OPS_AUTH_USERNAME")
    secret = _required(values, "SEO_OPS_AUTH_SECRET")
    if len(secret) < 32:
        raise GateFailure(RESULT_UNAVAILABLE)
    try:
        with client_factory(
            base_url=api_url,
            follow_redirects=False,
            timeout=min(30.0, deadline.remaining()),
            cookies={COOKIE_NAME: make_session(username, secret)},
        ) as client:
            response = client.get("/api/agent-workbench", params={"range": range_key})
            if 300 <= response.status_code < 400:
                raise GateFailure(RESULT_UNAVAILABLE)
            if response.status_code != 200:
                raise GateFailure(RESULT_UNAVAILABLE)
            body = response.json()
    except GateFailure:
        raise
    except (httpx.HTTPError, json.JSONDecodeError, ValueError, TypeError):
        raise GateFailure(RESULT_UNAVAILABLE) from None
    if not isinstance(body, dict):
        raise GateFailure(RESULT_UNAVAILABLE)
    return body


def _table_rows(conn: sqlite3.Connection, table: str) -> list[dict]:
    return [dict(row) for row in conn.execute(f"SELECT * FROM {table}").fetchall()]


def _local_hash(conn: sqlite3.Connection) -> str:
    payload = {
        table: sorted(
            _table_rows(conn, table), key=lambda row: _canonical(row)
        )
        for table in (
            "seo_ops_agents",
            "seo_ops_agent_runs",
            "seo_ops_agent_sync_state",
            "merchants",
            "runs",
            "task_executions",
            "merchant_seo_artifacts",
        )
    }
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def _parse_snapshot_time(body: dict) -> datetime:
    raw = body.get("snapshot_at")
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        raise GateFailure(RESULT_MISMATCH) from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise GateFailure(RESULT_MISMATCH)
    return parsed.astimezone(timezone.utc)


def _local_bracket(
    conn: sqlite3.Connection,
    api_url: str,
    range_key: str,
    values: Mapping[str, str],
    deadline: Deadline,
    client_factory: Callable[..., httpx.Client],
) -> tuple[dict, str]:
    before = _local_hash(conn)
    aggregate = _request_aggregate(
        api_url, range_key, values, deadline, client_factory=client_factory
    )
    snapshot_at = _parse_snapshot_time(aggregate)
    timezone_name = values.get("SEO_OPS_OPERATOR_TIMEZONE", "").strip() or "Asia/Shanghai"
    history_limit = _positive_int(values, "SEO_OPS_AGENT_HISTORY_LIMIT", 200)
    configured = CoreAiConnectionSettings(
        base_url=_required(values, "COREAI_BASE_URL").rstrip("/"),
        api_key=_required(values, "COREAI_API_KEY"),
    )
    original = agent_workbench.coreai_connection_settings
    original_slots = agent_workbench.configured_agent_slots
    agent_workbench.coreai_connection_settings = lambda: configured
    agent_workbench.configured_agent_slots = lambda: configured_agent_slots(values)
    try:
        rebuilt = agent_workbench.build_workbench_snapshot(
            conn, range_key, snapshot_at, timezone_name, history_limit
        )
    except (ValueError, sqlite3.Error):
        raise GateFailure(RESULT_MISMATCH) from None
    finally:
        agent_workbench.coreai_connection_settings = original
        agent_workbench.configured_agent_slots = original_slots
    after = _local_hash(conn)
    if before != after:
        raise GateFailure(RESULT_UNSTABLE)
    if aggregate != rebuilt:
        raise GateFailure(RESULT_MISMATCH)
    return aggregate, before


def _stable_local_bracket(
    conn: sqlite3.Connection,
    api_url: str,
    range_key: str,
    values: Mapping[str, str],
    deadline: Deadline,
    client_factory: Callable[..., httpx.Client],
    sleep: Callable[[float], None],
) -> tuple[dict, str]:
    """Discard one locally moving snapshot, then require a stable bracket."""

    for attempt in range(2):
        try:
            return _local_bracket(
                conn, api_url, range_key, values, deadline, client_factory
            )
        except GateFailure as failure:
            if failure.code != RESULT_UNSTABLE or attempt == 1:
                raise
            sleep(min(NORMAL_PROOF_INTERVAL_SECONDS, deadline.remaining()))
    raise AssertionError("unreachable stable-bracket retry state")


def _allowlisted_row(row: sqlite3.Row, fields: tuple[str, ...]) -> dict:
    available = set(row.keys())
    if not set(fields).issubset(available):
        raise GateFailure(RESULT_MISMATCH)
    return {field: row[field] for field in fields}


def _agent_marker(conn: sqlite3.Connection, local_id: str) -> str:
    agent = conn.execute(
        "SELECT * FROM seo_ops_agents WHERE id=?", (local_id,)
    ).fetchone()
    sync = conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?", (local_id,)
    ).fetchone()
    runs = conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE seo_ops_agent_id=? "
        "ORDER BY coreai_run_id",
        (local_id,),
    ).fetchall()
    if agent is None or sync is None:
        raise GateFailure(RESULT_MISMATCH)
    run_semantics = []
    for row in runs:
        association, local_running = agent_workbench._run_association(conn, row)
        run_semantics.append(
            {
                "association": association,
                "confirmed": row["last_synced_at"] is not None,
                "local_running": local_running,
                "poll_attempted": row["last_poll_attempt_at"] is not None,
                "run": _allowlisted_row(row, _RUN_SEMANTIC_FIELDS),
            }
        )
    payload = {
        "agent": _allowlisted_row(agent, _AGENT_SEMANTIC_FIELDS),
        "sync": _allowlisted_row(sync, _SYNC_SEMANTIC_FIELDS),
        "runs": run_semantics,
    }
    return hashlib.sha256(_canonical(payload).encode()).hexdigest()


def _normal_tokens(row: Mapping[str, object]) -> tuple[int, int] | None:
    usage = row.get("token_usage")
    if not isinstance(usage, dict):
        return None
    left, right = usage.get("input"), usage.get("output")
    if (
        isinstance(left, bool)
        or isinstance(right, bool)
        or not isinstance(left, int)
        or not isinstance(right, int)
        or left < 0
        or right < 0
    ):
        return None
    return left, right


def _request_time_remaining(
    deadline: Deadline, cancel_event: threading.Event | None
) -> float:
    if cancel_event is not None and cancel_event.is_set():
        raise GateFailure(RESULT_TIMEOUT)
    return min(30.0, deadline.remaining())


def _bind_core_request_timeout(client: object, timeout: float) -> None:
    """Narrow production CoreAiClient's next request to the global deadline."""

    underlying = getattr(client, "_client", None)
    if isinstance(underlying, httpx.Client):
        underlying.timeout = httpx.Timeout(timeout)


def _direct_bundle(
    core_id: str,
    values: Mapping[str, str],
    deadline: Deadline,
    *,
    core_client_factory: Callable[..., object] = CoreAiClient,
    cancel_event: threading.Event | None = None,
) -> dict:
    request_timeout = _request_time_remaining(deadline, cancel_event)
    base_url = _required(values, "COREAI_BASE_URL").rstrip("/")
    api_key = _required(values, "COREAI_API_KEY")
    try:
        client = core_client_factory(base_url, api_key, timeout=request_timeout)
    except TypeError:
        # Small list-only test doubles intentionally expose the historical
        # two-argument constructor. Production CoreAiClient receives the
        # remaining global bound so a worker cannot outlive the gate forever.
        client = core_client_factory(base_url, api_key)
    try:
        request_timeout = _request_time_remaining(deadline, cancel_event)
        _bind_core_request_timeout(client, request_timeout)
        metadata = client.get_agent(core_id)
        if not isinstance(metadata, dict) or metadata.get("id") != core_id:
            raise GateFailure(RESULT_UNAVAILABLE)
        pages = {}
        for status in FILTERS:
            request_timeout = _request_time_remaining(deadline, cancel_event)
            _bind_core_request_timeout(client, request_timeout)
            page = client.list_agent_runs(core_id, status, LIST_LIMIT)
            pages[status or "ALL"] = agent_workbench.parse_agent_run_page(
                core_id,
                page,
                datetime.now(timezone.utc),
                expected_status=status,
            )
    except GateFailure:
        raise
    except (CoreAiError, CoreAiContractError, KeyError, TypeError, ValueError):
        raise GateFailure(RESULT_UNAVAILABLE) from None
    except BaseException:
        raise GateFailure(RESULT_UNAVAILABLE) from None
    finally:
        try:
            client.close()
        except BaseException:
            pass
    return {"coreai_agent_id": core_id, "pages": pages}


def _compare_bundle(
    conn: sqlite3.Connection,
    local_id: str,
    bundle: dict,
) -> dict:
    core_id = bundle["coreai_agent_id"]
    local_rows = {
        row["coreai_run_id"]: dict(row)
        for row in conn.execute(
            "SELECT * FROM seo_ops_agent_runs WHERE seo_ops_agent_id=?", (local_id,)
        ).fetchall()
    }
    unconfirmed = sorted(
        run_id for run_id, row in local_rows.items() if row["last_synced_at"] is None
    )
    if unconfirmed:
        raise GateFailure(RESULT_UNCONFIRMED)
    sync = conn.execute(
        "SELECT * FROM seo_ops_agent_sync_state WHERE seo_ops_agent_id=?",
        (local_id,),
    ).fetchone()
    if sync is None:
        raise GateFailure(RESULT_MISMATCH)
    merged = {}
    conflict = False
    for page in bundle["pages"].values():
        for run in page.runs:
            if run.coreai_agent_id != core_id:
                raise GateFailure(RESULT_UNAVAILABLE)
            previous = merged.get(run.coreai_run_id)
            if previous is not None and (
                previous.raw_status != run.raw_status
                or (previous.input_tokens, previous.output_tokens)
                != (run.input_tokens, run.output_tokens)
            ):
                conflict = True
            merged[run.coreai_run_id] = run
    if conflict:
        raise GateFailure(RESULT_MISMATCH)
    for run_id, run in merged.items():
        owner = conn.execute(
            "SELECT seo_ops_agent_id FROM seo_ops_agent_runs WHERE coreai_run_id=?",
            (run_id,),
        ).fetchone()
        local = local_rows.get(run_id)
        if (
            owner is None
            or owner["seo_ops_agent_id"] != local_id
            or local is None
            or local["seo_ops_agent_id"] != local_id
        ):
            raise GateFailure(RESULT_MISMATCH)
        if local["raw_status"] != run.raw_status:
            raise GateFailure(RESULT_MISMATCH)
        if (local["input_tokens"] is None) != (local["output_tokens"] is None):
            raise GateFailure(RESULT_MISMATCH)
        if (run.input_tokens is None) != (run.output_tokens is None):
            raise GateFailure(RESULT_MISMATCH)
        if (local["input_tokens"], local["output_tokens"]) != (
            run.input_tokens,
            run.output_tokens,
        ):
            raise GateFailure(RESULT_MISMATCH)
    all_page = bundle["pages"]["ALL"]
    all_ids = sorted(run.coreai_run_id for run in all_page.runs)
    exact = all_page.returned_count == all_page.total
    if exact and set(all_ids) != set(local_rows):
        raise GateFailure(RESULT_MISMATCH)
    recorded_remote_total = sync["remote_total_runs"]
    if recorded_remote_total is not None and recorded_remote_total != all_page.total:
        raise GateFailure(RESULT_MISMATCH)
    for status, prefix in (
        ("PENDING", "pending"),
        ("RUNNING", "running"),
        ("PAUSED", "paused"),
    ):
        page = bundle["pages"][status]
        if (
            page.returned_count == page.total
            and sync[f"{prefix}_set_quality"] == "exact"
        ):
            expected = {
                run_id
                for run_id, row in local_rows.items()
                if row["raw_status"] == status
            }
            returned = {run.coreai_run_id for run in page.runs}
            if returned != expected:
                raise GateFailure(RESULT_MISMATCH)
    known = [
        run for run in all_page.runs
        if run.input_tokens is not None and run.output_tokens is not None
    ]
    raw_status_counts: dict[str, int] = {}
    for run in all_page.runs:
        raw_status_counts[run.raw_status] = raw_status_counts.get(run.raw_status, 0) + 1
    return {
        "coreai_agent_id": core_id,
        "local_agent_id": local_id,
        "returned_ids": all_ids,
        "returned_count": all_page.returned_count,
        "remote_total": all_page.total,
        "projected_remote_total": recorded_remote_total,
        "comparison": "exact" if exact else "bounded_overlap",
        "raw_status_counts": raw_status_counts,
        "known_token_runs": len(known),
        "known_input_tokens": sum(run.input_tokens for run in known),
        "known_output_tokens": sum(run.output_tokens for run in known),
        "known_total_tokens": sum(
            run.input_tokens + run.output_tokens for run in known
        ),
    }


def _wire_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _bundle_fingerprint(bundle: dict) -> dict:
    """Return only reconciliation fields, never arbitrary upstream payloads."""

    pages = {}
    for name, page in sorted(bundle["pages"].items()):
        pages[name] = {
            "returned_count": page.returned_count,
            "runs": [
                {
                    "agent_id": run.coreai_agent_id,
                    "id": run.coreai_run_id,
                    "input_tokens": run.input_tokens,
                    "output_tokens": run.output_tokens,
                    "status": run.raw_status,
                }
                for run in page.runs
            ],
            "total": page.total,
        }
    return {"coreai_agent_id": bundle["coreai_agent_id"], "pages": pages}


@dataclass(frozen=True)
class SegmentAttempt:
    result_code: str
    fingerprint: str
    marker_before: str
    marker_after: str
    observed_from: str
    observed_through: str
    segment: dict | None
    bundle: dict


def _segment_attempt_record(
    conn: sqlite3.Connection,
    local_id: str,
    bundle: dict,
    marker_before: str,
    observed_from: datetime,
    observed_through: datetime,
) -> SegmentAttempt:
    marker_after = _agent_marker(conn, local_id)
    result_code = RESULT_OK
    segment = None
    if marker_before != marker_after:
        result_code = RESULT_UNSTABLE
    else:
        try:
            segment = _compare_bundle(conn, local_id, bundle)
        except GateFailure as failure:
            if failure.code not in {RESULT_MISMATCH, RESULT_UNSTABLE}:
                raise
            result_code = failure.code
    fingerprint_payload = {
        "bundle": _bundle_fingerprint(bundle),
        "marker_after": marker_after,
        "marker_before": marker_before,
        "result_code": result_code,
    }
    return SegmentAttempt(
        result_code=result_code,
        fingerprint=hashlib.sha256(
            _canonical(fingerprint_payload).encode()
        ).hexdigest(),
        marker_before=marker_before,
        marker_after=marker_after,
        observed_from=_wire_time(observed_from),
        observed_through=_wire_time(observed_through),
        segment=segment,
        bundle=bundle,
    )


def _fetch_bundles_in_supervisor(
    selected: tuple[str, ...],
    values: Mapping[str, str],
    timeout_seconds: float,
    core_client_factory: Callable[..., object],
) -> dict[str, dict]:
    """Run bounded fan-out inside a process the caller can terminate."""

    deadline = Deadline.start(timeout_seconds)
    cancel_event = threading.Event()
    bundles: dict[str, dict] = {}
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(MAX_LIVE_READBACK_WORKERS, len(selected))
    ) as executor:
        futures = {
            executor.submit(
                _direct_bundle,
                core_id,
                values,
                deadline,
                core_client_factory=core_client_factory,
                cancel_event=cancel_event,
            ): core_id
            for core_id in selected
        }
        try:
            for future in concurrent.futures.as_completed(futures):
                bundles[futures[future]] = future.result()
        except BaseException:
            cancel_event.set()
            for future in futures:
                future.cancel()
            raise
    return bundles


def _send_supervised_bundles(
    sender,
    selected: tuple[str, ...],
    values: dict[str, str],
    timeout_seconds: float,
    core_client_factory: Callable[..., object],
) -> None:
    try:
        try:
            payload = (
                "ok",
                _fetch_bundles_in_supervisor(
                    selected, values, timeout_seconds, core_client_factory
                ),
            )
        except GateFailure as failure:
            payload = (
                "failure",
                failure.code if failure.code in EXIT_CODES else RESULT_UNAVAILABLE,
            )
        except BaseException:
            payload = ("failure", RESULT_UNAVAILABLE)
        try:
            sender.send(payload)
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        sender.close()


def _spawn_coreai_bundle_process(
    sender,
    selected: tuple[str, ...],
    coreai_values: dict[str, str],
    timeout_seconds: float,
) -> None:
    """Fresh-interpreter entry point for the production CoreAiClient path."""

    _send_supervised_bundles(
        sender, selected, coreai_values, timeout_seconds, CoreAiClient
    )


def _fork_injected_bundle_process(
    sender,
    selected: tuple[str, ...],
    values: dict[str, str],
    timeout_seconds: float,
    core_client_factory: Callable[..., object],
) -> None:
    """Fork-only seam for local, intentionally non-pickleable test doubles."""

    _send_supervised_bundles(
        sender, selected, values, timeout_seconds, core_client_factory
    )


def _terminate_supervisor(process: multiprocessing.Process) -> None:
    if process.is_alive():
        process.terminate()
        process.join(timeout=0.05)
    if process.is_alive():
        process.kill()
        process.join(timeout=0.05)
    if process.is_alive():
        raise RuntimeError("live-readback supervisor could not be terminated")


def _supervised_direct_bundles(
    selected: tuple[str, ...],
    values: Mapping[str, str],
    deadline: Deadline,
    core_client_factory: Callable[..., object],
) -> dict[str, dict]:
    default_client = core_client_factory is CoreAiClient
    start_method = "spawn" if default_client else "fork"
    if start_method not in multiprocessing.get_all_start_methods():
        raise GateFailure(RESULT_UNAVAILABLE)
    context = multiprocessing.get_context(start_method)
    receiver, sender = context.Pipe(duplex=False)
    if default_client:
        process_target = _spawn_coreai_bundle_process
        process_args = (
            sender,
            selected,
            {
                "COREAI_BASE_URL": _required(values, "COREAI_BASE_URL"),
                "COREAI_API_KEY": _required(values, "COREAI_API_KEY"),
            },
            deadline.remaining(),
        )
    else:
        process_target = _fork_injected_bundle_process
        process_args = (
            sender,
            selected,
            dict(values),
            deadline.remaining(),
            core_client_factory,
        )
    process = context.Process(
        target=process_target,
        args=process_args,
        name="agent-workbench-live-readback",
        daemon=True,
    )
    started = False
    try:
        process.start()
        started = True
        sender.close()
        if not receiver.poll(deadline.remaining()):
            raise GateFailure(RESULT_TIMEOUT)
        try:
            outcome, payload = receiver.recv()
        except (EOFError, OSError):
            raise GateFailure(RESULT_UNAVAILABLE) from None
        try:
            process.join(timeout=deadline.remaining())
        except GateFailure:
            raise GateFailure(RESULT_TIMEOUT) from None
        if process.is_alive():
            raise GateFailure(RESULT_TIMEOUT)
        if outcome == "failure" and payload in EXIT_CODES:
            raise GateFailure(payload)
        if outcome != "ok" or not isinstance(payload, dict):
            raise GateFailure(RESULT_UNAVAILABLE)
        return payload
    finally:
        try:
            sender.close()
        except OSError:
            pass
        receiver.close()
        if started:
            _terminate_supervisor(process)
            process.close()


def _collect_segment_attempts(
    conn: sqlite3.Connection,
    core_ids: Iterable[str],
    registry_by_core: Mapping[str, Mapping[str, object]],
    values: Mapping[str, str],
    deadline: Deadline,
    core_client_factory: Callable[..., object],
) -> dict[str, SegmentAttempt]:
    selected = tuple(sorted(core_ids))
    if not selected:
        return {}
    markers = {
        core_id: _agent_marker(conn, str(registry_by_core[core_id]["id"]))
        for core_id in selected
    }
    started = {core_id: datetime.now(timezone.utc) for core_id in selected}
    bundles = _supervised_direct_bundles(
        selected, values, deadline, core_client_factory
    )
    if set(bundles) != set(selected):
        raise GateFailure(RESULT_UNAVAILABLE)
    return {
        core_id: _segment_attempt_record(
            conn,
            str(registry_by_core[core_id]["id"]),
            bundles[core_id],
            markers[core_id],
            started[core_id],
            datetime.now(timezone.utc),
        )
        for core_id in selected
    }


def _retry_failure(first: SegmentAttempt, second: SegmentAttempt) -> str:
    if second.result_code == RESULT_OK:
        return RESULT_OK
    if (
        first.result_code == RESULT_MISMATCH
        and second.result_code == RESULT_MISMATCH
        and first.fingerprint == second.fingerprint
    ):
        return RESULT_MISMATCH
    return RESULT_UNSTABLE


def _require_terminal_match(
    conn: sqlite3.Connection,
    local_id: str,
    run_id: str,
    raw_status: str,
    bundle: dict,
) -> None:
    local = conn.execute(
        "SELECT * FROM seo_ops_agent_runs WHERE coreai_run_id=?",
        (run_id,),
    ).fetchone()
    matches = [
        run
        for run in bundle["pages"]["ALL"].runs
        if run.coreai_run_id == run_id
    ]
    if (
        local is None
        or local["seo_ops_agent_id"] != local_id
        or local["raw_status"] != raw_status
        or len(matches) != 1
        or matches[0].raw_status != raw_status
    ):
        raise GateFailure(RESULT_MISMATCH)
    remote_tokens = (matches[0].input_tokens, matches[0].output_tokens)
    local_tokens = (local["input_tokens"], local["output_tokens"])
    if (
        (remote_tokens[0] is None) != (remote_tokens[1] is None)
        or (local_tokens[0] is None) != (local_tokens[1] is None)
        or remote_tokens != local_tokens
    ):
        raise GateFailure(RESULT_MISMATCH)


def _motion_candidates(aggregate: dict) -> list[dict]:
    candidates = []
    for signal in aggregate.get("signals", []):
        if not isinstance(signal, dict):
            continue
        if (
            signal.get("raw_status") == "RUNNING"
            and signal.get("lifecycle_status") == "active"
            and signal.get("agent_current_state_complete") is True
            and signal.get("fresh") is True
            and signal.get("suspect") is False
            and signal.get("signal_state") == "active"
            and isinstance(signal.get("coreai_run_id"), str)
            and isinstance(signal.get("local_agent_id"), str)
        ):
            candidates.append(
                {
                    "coreai_run_id": signal["coreai_run_id"],
                    "local_agent_id": signal["local_agent_id"],
                    "raw_status": "RUNNING",
                    "transition_observed": "not_applicable",
                }
            )
    return candidates


def reconcile(
    values: Mapping[str, str],
    api_url: str,
    range_key: str,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    http_client_factory: Callable[..., httpx.Client] = httpx.Client,
    core_client_factory: Callable[..., object] = CoreAiClient,
) -> dict:
    if range_key not in agent_workbench.WORKBENCH_RANGES:
        raise GateFailure(RESULT_UNAVAILABLE)
    deadline = Deadline.start(timeout_seconds, monotonic)
    conn = _read_connection(_required(values, "SEO_OPS_DB"))
    try:
        aggregate, _local_hash_value = _stable_local_bracket(
            conn,
            api_url,
            range_key,
            values,
            deadline,
            http_client_factory,
            sleep,
        )
        registry = _table_rows(conn, "seo_ops_agents")
        registry_by_core = {row["coreai_agent_id"]: row for row in registry}
        aggregate_agents = {
            row.get("coreai_agent_id"): row for row in aggregate.get("agents", [])
            if isinstance(row, dict)
        }
        if set(aggregate_agents) != set(registry_by_core):
            raise GateFailure(RESULT_MISMATCH)
        for core_id, row in registry_by_core.items():
            item = aggregate_agents[core_id]
            if item.get("id") != row["id"] or item.get("lifecycle_status") != row["status"]:
                raise GateFailure(RESULT_MISMATCH)
        configured_ids = {slot.coreai_agent_id for slot in configured_agent_slots(values)}
        missing = sorted(configured_ids - set(registry_by_core))
        if missing:
            raise GateFailure(RESULT_UNAVAILABLE)
        direct_ids = sorted(
            configured_ids
            | {
                row["coreai_agent_id"]
                for row in registry
                if row["status"] == "active"
            }
        )
        if not registry or not direct_ids:
            raise GateFailure(RESULT_UNAVAILABLE)
        first_attempts = _collect_segment_attempts(
            conn,
            direct_ids,
            registry_by_core,
            values,
            deadline,
            core_client_factory,
        )
        final_aggregate, final_hash = _stable_local_bracket(
            conn,
            api_url,
            range_key,
            values,
            deadline,
            http_client_factory,
            sleep,
        )
        retry_ids = {
            core_id
            for core_id, attempt in first_attempts.items()
            if attempt.result_code != RESULT_OK
            or _agent_marker(
                conn, str(registry_by_core[core_id]["id"])
            ) != attempt.marker_after
        }
        attempts = dict(first_attempts)
        if retry_ids:
            sleep(min(NORMAL_PROOF_INTERVAL_SECONDS, deadline.remaining()))
            second_attempts = _collect_segment_attempts(
                conn,
                retry_ids,
                registry_by_core,
                values,
                deadline,
                core_client_factory,
            )
            final_aggregate, final_hash = _stable_local_bracket(
                conn,
                api_url,
                range_key,
                values,
                deadline,
                http_client_factory,
                sleep,
            )
            for core_id in sorted(retry_ids):
                first = first_attempts[core_id]
                second = second_attempts[core_id]
                if (
                    second.result_code == RESULT_OK
                    and _agent_marker(
                        conn, str(registry_by_core[core_id]["id"])
                    ) == second.marker_after
                ):
                    attempts[core_id] = second
                    continue
                failure_code = _retry_failure(first, second)
                raise GateFailure(failure_code)
        for core_id, attempt in attempts.items():
            if attempt.result_code != RESULT_OK or attempt.segment is None:
                raise GateFailure(attempt.result_code)
            if _agent_marker(
                conn, str(registry_by_core[core_id]["id"])
            ) != attempt.marker_after:
                raise GateFailure(RESULT_UNSTABLE)
        segments = []
        for core_id in sorted(attempts):
            attempt = attempts[core_id]
            segments.append(
                {
                    **attempt.segment,
                    "observed_from": attempt.observed_from,
                    "observed_through": attempt.observed_through,
                }
            )
        return {
            "active_transition_candidates": _motion_candidates(final_aggregate),
            "agent_segments": segments,
            "configured_not_registered": [],
            "local_snapshot_hash": final_hash,
            "range": range_key,
            "result_code": RESULT_OK,
            "schema_version": SCHEMA_VERSION,
        }
    finally:
        conn.close()


def observe_transition(
    values: Mapping[str, str],
    api_url: str,
    range_key: str,
    run_id: str,
    observe_seconds: int,
    *,
    timeout_seconds: int,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    http_client_factory: Callable[..., httpx.Client] = httpx.Client,
    core_client_factory: Callable[..., object] = CoreAiClient,
) -> dict:
    if not _ID.fullmatch(run_id) or not 1 <= observe_seconds <= 3600:
        raise GateFailure(RESULT_UNAVAILABLE)
    deadline = Deadline.start(timeout_seconds, monotonic)
    initial = _request_aggregate(
        api_url, range_key, values, deadline, client_factory=http_client_factory
    )
    candidate = next(
        (
            item for item in _motion_candidates(initial)
            if item["coreai_run_id"] == run_id
        ),
        None,
    )
    if candidate is None:
        raise GateFailure(RESULT_TRANSITION_MISSING)
    running_proven = True
    stop_at = monotonic() + observe_seconds
    while monotonic() < stop_at:
        cadence = max(1.0, min(60.0, initial.get("refresh_after_ms", 30000) / 1000))
        sleep(min(cadence, max(0.0, stop_at - monotonic())))
        if monotonic() >= stop_at:
            break
        current = _request_aggregate(
            api_url, range_key, values, deadline, client_factory=http_client_factory
        )
        signal = next(
            (
                row for row in current.get("signals", [])
                if isinstance(row, dict) and row.get("coreai_run_id") == run_id
            ),
            None,
        )
        history = [
            run for agent in current.get("agents", [])
            if isinstance(agent, dict)
            for run in [agent.get("last_terminal_run")]
            if isinstance(run, dict) and run.get("coreai_run_id") == run_id
        ]
        terminal = signal if signal and signal.get("raw_status") in TERMINAL else (
            history[0] if history and history[0].get("raw_status") in TERMINAL else None
        )
        if terminal is not None and running_proven:
            local_id = candidate["local_agent_id"]
            conn = _read_connection(_required(values, "SEO_OPS_DB"))
            try:
                owner = conn.execute(
                    "SELECT * FROM seo_ops_agents WHERE id=?", (local_id,)
                ).fetchone()
                if owner is None or owner["status"] != "active":
                    raise GateFailure(RESULT_MISMATCH)
                registry = {owner["coreai_agent_id"]: dict(owner)}
                attempts = _collect_segment_attempts(
                    conn,
                    (owner["coreai_agent_id"],),
                    registry,
                    values,
                    deadline,
                    core_client_factory,
                )
                attempt = attempts[owner["coreai_agent_id"]]
                if attempt.result_code != RESULT_OK:
                    raise GateFailure(
                        RESULT_MISMATCH
                        if attempt.result_code == RESULT_MISMATCH
                        else attempt.result_code
                    )
                final, _ = _stable_local_bracket(
                    conn,
                    api_url,
                    range_key,
                    values,
                    deadline,
                    http_client_factory,
                    sleep,
                )
                final_terminal = next(
                    (
                        row
                        for row in final.get("signals", [])
                        if isinstance(row, dict)
                        and row.get("coreai_run_id") == run_id
                        and row.get("raw_status") in TERMINAL
                    ),
                    None,
                )
                if final_terminal is None:
                    final_terminal = next(
                        (
                            run
                            for agent in final.get("agents", [])
                            if isinstance(agent, dict)
                            for run in [agent.get("last_terminal_run")]
                            if isinstance(run, dict)
                            and run.get("coreai_run_id") == run_id
                            and run.get("raw_status") in TERMINAL
                        ),
                        None,
                    )
                if (
                    final_terminal is None
                    or final_terminal["raw_status"] != terminal["raw_status"]
                ):
                    raise GateFailure(RESULT_MISMATCH)
                _require_terminal_match(
                    conn,
                    local_id,
                    run_id,
                    terminal["raw_status"],
                    attempt.bundle,
                )
            finally:
                conn.close()
            return {
                "final_raw_status": terminal["raw_status"],
                "observe_run_id": run_id,
                "result_code": RESULT_OK,
                "schema_version": SCHEMA_VERSION,
                "start_motion_eligible": True,
                "start_raw_status": "RUNNING",
                "terminal_token_match": True,
                "transition_observed": True,
            }
        renewed_candidate = next(
            (
                item
                for item in _motion_candidates(current)
                if item["coreai_run_id"] == run_id
            ),
            None,
        )
        running_proven = renewed_candidate is not None
        if renewed_candidate is not None:
            candidate = renewed_candidate
        initial = current
    raise GateFailure(RESULT_TRANSITION_MISSING)


def _bounded_int(value: str, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("invalid bounded integer") from None
    if not minimum <= parsed <= maximum:
        raise argparse.ArgumentTypeError("invalid bounded integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Agent Workbench live readback")
    parser.add_argument("--env-file", required=True)
    parser.add_argument("--api-url", required=True)
    parser.add_argument("--range", required=True, dest="range_key", choices=sorted(agent_workbench.WORKBENCH_RANGES))
    parser.add_argument("--strict", action="store_true")
    parser.add_argument(
        "--overall-timeout-seconds",
        type=lambda value: _bounded_int(value, 1, 240),
        default=DEFAULT_TIMEOUT_SECONDS,
    )
    parser.add_argument("--observe-run-id")
    parser.add_argument(
        "--observe-seconds", type=lambda value: _bounded_int(value, 1, 3600)
    )
    return parser


def run_cli(args: argparse.Namespace) -> tuple[int, dict]:
    api_url = validate_api_url(args.api_url)
    if (args.observe_run_id is None) != (args.observe_seconds is None):
        raise GateFailure(RESULT_UNAVAILABLE)
    if args.observe_run_id is not None and not _ID.fullmatch(args.observe_run_id):
        raise GateFailure(RESULT_UNAVAILABLE)
    values = load_named_environment(args.env_file)
    if args.observe_run_id is not None:
        report = observe_transition(
            values,
            api_url,
            args.range_key,
            args.observe_run_id,
            args.observe_seconds,
            timeout_seconds=args.overall_timeout_seconds,
        )
    else:
        report = reconcile(
            values,
            api_url,
            args.range_key,
            timeout_seconds=args.overall_timeout_seconds,
        )
    return EXIT_CODES[report["result_code"]], report


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        code, report = run_cli(args)
    except GateFailure as failure:
        code = EXIT_CODES.get(failure.code, EXIT_CODES[RESULT_UNAVAILABLE])
        report = {
            "active_transition_candidates": [],
            "agent_segments": [],
            "configured_not_registered": [],
            "range": None,
            "result_code": failure.code,
            "schema_version": SCHEMA_VERSION,
        }
        print(failure.code, file=sys.stderr)
    except BaseException:
        code = EXIT_CODES[RESULT_UNAVAILABLE]
        report = {
            "active_transition_candidates": [],
            "agent_segments": [],
            "configured_not_registered": [],
            "range": None,
            "result_code": RESULT_UNAVAILABLE,
            "schema_version": SCHEMA_VERSION,
        }
        print(RESULT_UNAVAILABLE, file=sys.stderr)
    sys.stdout.write(_canonical(report))
    return code


if __name__ == "__main__":
    raise SystemExit(main())

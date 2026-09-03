import json
import sqlite3
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError
from .db import get_db
from .merchants import fetch_active_merchant, fetch_merchant, now_iso

router = APIRouter(prefix="/api", tags=["runs"])

RUN_LIST_COLUMNS = (
    "id, merchant_id, coreai_run_id, status, trigger_kind, error,"
    " plan_approved_at, created_at, finished_at"
)

_client: CoreAiClient | None = None

MAX_GBP_CONTEXT_LOCATIONS = 10
MAX_GBP_TEXT_LENGTH = 800
MAX_GBP_LIST_ITEMS = 10
MAX_GBP_METADATA_LENGTH = 256
MAX_GBP_CONTEXT_LENGTH = 7_000
MAX_MERCHANT_PROMPT_FIELD_LENGTH = 512
MAX_RUN_INPUT_LENGTH = 12_000

GBP_SYNC_REQUIRED_DETAIL = "GBP 资料尚未完成当前同步，请先同步 GBP 后再开始诊断"

GBP_SCALAR_FACT_KEYS = (
    "title",
    "store_code",
    "language_code",
    "phone",
    "address",
    "locality",
    "administrative_area",
    "postal_code",
    "region_code",
    "website_url",
    "primary_category",
    "open_status",
    "description",
    "place_id",
    "attribute_count",
    "menu_count",
    "menu_section_count",
    "menu_item_count",
    "post_count",
    "live_post_count",
    "review_count",
    "review_average_rating",
    "review_reply_rate",
    "media_count",
    "customer_media_count",
    "question_count",
    "place_action_link_count",
    "verification_count",
)
GBP_TEXT_LIST_FACT_KEYS = (
    "additional_phones",
    "address_lines",
    "additional_categories",
)


def get_coreai() -> tuple[CoreAiClient, str]:
    global _client
    settings = coreai_settings()
    if settings is None:
        raise HTTPException(status_code=503, detail="core-ai not configured")
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return _client, settings.agent_id


def _bounded_text(value: object, limit: int = MAX_GBP_TEXT_LENGTH) -> str | None:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value:
        return None
    return value[:limit]


def _is_aware_iso_timestamp(value: object) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return False
    return parsed.tzinfo is not None and parsed.utcoffset() is not None


def _normalized_gbp_facts(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        payload = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}

    facts: dict[str, Any] = {}
    for key in GBP_SCALAR_FACT_KEYS:
        value = payload.get(key)
        if isinstance(value, str):
            value = _bounded_text(value)
        if value is not None and isinstance(value, (str, int, float, bool)):
            facts[key] = value

    for key in GBP_TEXT_LIST_FACT_KEYS:
        values = payload.get(key)
        if not isinstance(values, list):
            continue
        normalized = [
            text
            for text in (_bounded_text(value) for value in values[:MAX_GBP_LIST_ITEMS])
            if text is not None
        ]
        if normalized:
            facts[key] = normalized

    hours = payload.get("regular_hours")
    if isinstance(hours, list):
        normalized_hours = []
        for period in hours[:MAX_GBP_LIST_ITEMS]:
            if not isinstance(period, dict):
                continue
            normalized_period = {
                key: text
                for key in ("open_day", "open_time", "close_day", "close_time")
                if (text := _bounded_text(period.get(key))) is not None
            }
            if normalized_period:
                normalized_hours.append(normalized_period)
        if normalized_hours:
            facts["regular_hours"] = normalized_hours
    return facts


def _diagnosis_evidence_context(conn: sqlite3.Connection, merchant_id: int) -> str:
    link = conn.execute(
        "SELECT * FROM merchant_fbr_links WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    if link is None:
        return "Diagnosis evidence mode: BASIC_PUBLIC_ONLY (no connected GBP)."

    if link["sync_status"] != "synced":
        raise HTTPException(status_code=409, detail=GBP_SYNC_REQUIRED_DETAIL)

    last_synced_at = link["last_synced_at"]
    if not _is_aware_iso_timestamp(last_synced_at):
        raise HTTPException(status_code=409, detail=GBP_SYNC_REQUIRED_DETAIL)

    snapshot_count = conn.execute(
        "SELECT COUNT(*) AS n FROM merchant_gbp_profiles WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()["n"]
    rows = conn.execute(
        "SELECT fbr_merchant_id, gbp_location_id, google_account_id, source_name, source_title,"
        " normalized_json, source_updated_at, synced_at"
        " FROM merchant_gbp_profiles"
        " WHERE merchant_id = ? AND fbr_merchant_id = ? AND synced_at = ?"
        " ORDER BY gbp_location_id LIMIT ?",
        (
            merchant_id,
            link["fbr_merchant_id"],
            last_synced_at,
            MAX_GBP_CONTEXT_LOCATIONS,
        ),
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=409, detail=GBP_SYNC_REQUIRED_DETAIL)

    usable_locations = []
    for row in rows:
        facts = _normalized_gbp_facts(row["normalized_json"])
        if not facts:
            continue
        usable_locations.append(
            {
                "gbp_location_id": _bounded_text(
                    row["gbp_location_id"], MAX_GBP_METADATA_LENGTH
                ),
                "google_account_id": _bounded_text(
                    row["google_account_id"], MAX_GBP_METADATA_LENGTH
                ),
                "resource_name": _bounded_text(
                    row["source_name"], MAX_GBP_METADATA_LENGTH
                ),
                "source_title": _bounded_text(row["source_title"]),
                "source_updated_at": _bounded_text(
                    row["source_updated_at"], MAX_GBP_METADATA_LENGTH
                ),
                "snapshot_synced_at": _bounded_text(
                    row["synced_at"], MAX_GBP_METADATA_LENGTH
                ),
                "normalized_facts_available": True,
                "facts": facts,
            }
        )
    if not usable_locations:
        raise HTTPException(status_code=409, detail=GBP_SYNC_REQUIRED_DETAIL)

    context = {
        "fbr_merchant_id": _bounded_text(
            link["fbr_merchant_id"], MAX_GBP_METADATA_LENGTH
        ),
        "sync_status": link["sync_status"],
        "last_successful_sync_at": _bounded_text(
            last_synced_at, MAX_GBP_METADATA_LENGTH
        ),
        "persisted_snapshot_count": snapshot_count,
        "eligible_snapshot_count": len(usable_locations),
        "included_location_count": 0,
        "locations": [],
    }
    prefix = "\n".join(
        (
            "Diagnosis evidence mode: CONNECTED_GBP_SNAPSHOT.",
            "Use only these persisted snapshot facts as connected GBP evidence; they are not a live read.",
            "Connected GBP snapshot context:",
        )
    )
    json_budget = MAX_GBP_CONTEXT_LENGTH - len(prefix)
    for location in usable_locations:
        packed_location = {key: value for key, value in location.items() if key != "facts"}
        packed_location["facts"] = {}
        for fact_key, fact_value in location["facts"].items():
            candidate_location = {
                **packed_location,
                "facts": {**packed_location["facts"], fact_key: fact_value},
            }
            candidate_context = {
                **context,
                "included_location_count": len(context["locations"]) + 1,
                "locations": [*context["locations"], candidate_location],
            }
            serialized = json.dumps(
                candidate_context, ensure_ascii=False, separators=(",", ":")
            )
            if len(serialized) <= json_budget:
                packed_location = candidate_location
        if not packed_location["facts"]:
            continue
        candidate_context = {
            **context,
            "included_location_count": len(context["locations"]) + 1,
            "locations": [*context["locations"], packed_location],
        }
        serialized = json.dumps(
            candidate_context, ensure_ascii=False, separators=(",", ":")
        )
        if len(serialized) > json_budget:
            break
        context = candidate_context

    if not context["locations"]:
        raise HTTPException(status_code=409, detail=GBP_SYNC_REQUIRED_DETAIL)
    serialized = json.dumps(context, ensure_ascii=False, separators=(",", ":"))
    return prefix + serialized


def build_input(merchant: sqlite3.Row, evidence_context: str = "") -> str:
    prompt = "\n".join(
        [
            "Perform an evidence-led United States local SEO diagnosis for this merchant.",
            "Use English keywords and the merchant's real US location. Do not invent rankings, access, or business facts.",
            f"Merchant: {_bounded_text(merchant['name'], MAX_MERCHANT_PROMPT_FIELD_LENGTH)}",
            "Primary location: "
            + (
                _bounded_text(
                    merchant["primary_location"], MAX_MERCHANT_PROMPT_FIELD_LENGTH
                )
                or "Not provided"
            ),
            "Website: "
            + (
                _bounded_text(merchant["website_url"], MAX_MERCHANT_PROMPT_FIELD_LENGTH)
                or "Not provided"
            ),
            "Operator notes: "
            + (
                _bounded_text(merchant["notes"], MAX_MERCHANT_PROMPT_FIELD_LENGTH)
                or "None"
            ),
            "If the website is Not provided, treat the missing website and possible website build as a verified missing input or recommendation. Do not invent a website URL.",
            evidence_context,
            "First report verified issues, evidence, severity, expected impact, and missing inputs.",
            "Then return the proposed dated Plan as a JSON array in a fenced json block.",
            "Each Plan item must include id, title, rationale, expected_outcome, category, description, and start_after_days.",
            "Allowed categories: gbp, content, review, citation, technical, other.",
        ]
    )
    if len(prompt) > MAX_RUN_INPUT_LENGTH:
        raise HTTPException(status_code=500, detail="diagnosis prompt exceeds safe size limit")
    return prompt


def has_running_run(conn: sqlite3.Connection, merchant_id: int) -> bool:
    row = conn.execute(
        "SELECT 1 FROM runs WHERE merchant_id = ? AND status = 'running' LIMIT 1",
        (merchant_id,),
    ).fetchone()
    return row is not None


def start_run(
    conn: sqlite3.Connection,
    client: CoreAiClient,
    agent_id: str,
    merchant: sqlite3.Row,
    trigger_kind: str,
) -> sqlite3.Row:
    conn.execute("BEGIN IMMEDIATE")
    try:
        if has_running_run(conn, merchant["id"]):
            raise HTTPException(
                status_code=409,
                detail="a run is already in progress for this merchant",
            )
        evidence_context = _diagnosis_evidence_context(conn, merchant["id"])
        input_text = build_input(merchant, evidence_context)
        cur = conn.execute(
            "INSERT INTO runs (merchant_id, status, trigger_kind, created_at)"
            " VALUES (?, 'running', ?, ?)",
            (merchant["id"], trigger_kind, now_iso()),
        )
        run_id = cur.lastrowid
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    try:
        res = client.trigger(agent_id, input_text)
    except CoreAiError as exc:
        conn.execute(
            "UPDATE runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
            (str(exc), now_iso(), run_id),
        )
    else:
        conn.execute(
            "UPDATE runs SET coreai_run_id = ? WHERE id = ?",
            (res["run_id"], run_id),
        )
    conn.commit()
    return conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()


@router.post("/merchants/{merchant_id}/runs", status_code=201)
def create_run(merchant_id: int, coreai=Depends(get_coreai), conn=Depends(get_db)):
    merchant = fetch_active_merchant(conn, merchant_id)
    client, agent_id = coreai
    return dict(start_run(conn, client, agent_id, merchant, "manual"))


@router.get("/merchants/{merchant_id}/runs")
def list_runs(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    rows = conn.execute(
        f"SELECT {RUN_LIST_COLUMNS} FROM runs WHERE merchant_id = ? ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/runs/{run_id}")
def get_run(run_id: int, conn=Depends(get_db)):
    row = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="run not found")
    return dict(row)


@router.post("/runs/{run_id}/approve-plan")
def approve_plan(run_id: int, conn=Depends(get_db)):
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if run is None:
        raise HTTPException(status_code=404, detail="run not found")
    fetch_active_merchant(conn, run["merchant_id"])
    if run["status"] != "succeeded":
        raise HTTPException(status_code=409, detail="only a succeeded run can be approved")
    task_count = conn.execute(
        "SELECT COUNT(*) AS n FROM tasks WHERE source_run_id = ?", (run_id,)
    ).fetchone()["n"]
    if task_count == 0:
        raise HTTPException(status_code=409, detail="run has no generated plan")
    if run["plan_approved_at"] is None:
        conn.execute(
            "UPDATE runs SET plan_approved_at = ? WHERE id = ?",
            (now_iso(), run_id),
        )
        conn.commit()
    return dict(conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone())


@router.get("/runs/{run_id}/tasks")
def get_run_tasks(run_id: int, conn=Depends(get_db)):
    if conn.execute("SELECT 1 FROM runs WHERE id = ?", (run_id,)).fetchone() is None:
        raise HTTPException(status_code=404, detail="run not found")
    rows = conn.execute(
        "SELECT * FROM tasks WHERE source_run_id = ? ORDER BY id", (run_id,)
    ).fetchall()
    return [dict(r) for r in rows]

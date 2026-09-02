import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from .audit_snapshots import parse_audit_report
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect, get_db
from . import fbr_gbp
from .fbr_gbp import FbrConfigurationError, FbrPayloadError, FbrUnavailableError
from .local_falcon import LocalFalconClient, normalize_local_falcon_report
from .merchants import fetch_merchant, now_iso


router = APIRouter(prefix="/api", tags=["seo-targets"])


@dataclass(frozen=True)
class SeoAgentIds:
    keyword: str
    audit: str
    ranking: str


@dataclass(frozen=True)
class KeywordSkillWorkflow:
    agent_id: str
    seed_skill_id: str
    ranking_skill_id: str


_client: CoreAiClient | None = None


class KeywordMarketV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    country_code: Literal["US"]
    language: Literal["en-US"]
    search_engine: Literal["GOOGLE"]
    location_name: str | None = None


class KeywordItemV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(min_length=1, max_length=300)
    strategy: Literal["LOCAL", "ORGANIC"]
    intent: Literal["LOCAL", "ORGANIC", "BRAND", "MENU", "NEAR_ME"]
    priority: Literal["P0", "P1", "P2", "P3", "UNSCORED"]
    rationale: str = Field(min_length=1, max_length=1000)
    source_tags: list[str] = Field(min_length=1, max_length=30)
    target_surface_types: list[Literal["GBP", "WEBSITE"]] = Field(max_length=2)
    target_location: str | None = Field(default=None, min_length=1, max_length=300)


class KeywordSetV2(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.keyword_set.v2"]
    merchant_id: str = Field(min_length=1)
    market: KeywordMarketV2
    generation_method: Literal[
        "PERSISTED_FBR_READBACK",
        "UPSTREAM_DETERMINISTIC_ADAPTER",
        "EVIDENCE_BOUNDED_RESEARCH",
    ]
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=4000)
    keywords: list[KeywordItemV2] = Field(min_length=1, max_length=200)
    evidence_gaps: list[str] = Field(max_length=50)


class RankingItemV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(min_length=1, max_length=300)
    local_rank: int | None = Field(default=None, ge=1, le=200)
    organic_rank: int | None = Field(default=None, ge=1, le=200)
    source: Literal["LIVE_READ_ONLY", "UNAVAILABLE"]
    note: str | None = Field(default=None, min_length=1, max_length=1000)


class RankingReportV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.ranking_report.v1"]
    merchant_id: str = Field(min_length=1)
    title: str = Field(min_length=1, max_length=300)
    summary: str = Field(min_length=1, max_length=4000)
    captured_at: datetime
    source_mode: Literal["LIVE_READ_ONLY", "CONFIRMED_FACTS_ONLY"]
    keywords: list[RankingItemV1] = Field(min_length=1, max_length=200)
    limitations: list[str] = Field(max_length=50)


def get_seo_coreai() -> tuple[CoreAiClient, SeoAgentIds]:
    global _client
    settings = coreai_settings()
    if settings is None or not (
        settings.keyword_agent_id and settings.audit_agent_id and settings.ranking_agent_id
    ):
        raise HTTPException(status_code=503, detail="SEO target agents are not configured")
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return _client, SeoAgentIds(
        settings.keyword_agent_id,
        settings.audit_agent_id,
        settings.ranking_agent_id,
    )


def _keyword_skill_workflow_settings() -> KeywordSkillWorkflow | None:
    settings = coreai_settings()
    if settings is None or not (
        settings.keyword_skill_agent_id
        and settings.keyword_seed_skill_id
        and settings.keyword_ranking_skill_id
    ):
        return None
    return KeywordSkillWorkflow(
        settings.keyword_skill_agent_id,
        settings.keyword_seed_skill_id,
        settings.keyword_ranking_skill_id,
    )


def get_keyword_skill_workflow() -> tuple[CoreAiClient, KeywordSkillWorkflow]:
    global _client
    settings = coreai_settings()
    workflow = _keyword_skill_workflow_settings()
    if settings is None or workflow is None:
        raise HTTPException(
            status_code=503,
            detail="deterministic keyword Skill workflow is not configured",
        )
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return _client, workflow


def get_local_falcon() -> LocalFalconClient:
    global _client
    settings = coreai_settings()
    if settings is None or not settings.local_falcon_tool_id:
        raise HTTPException(status_code=503, detail="Local Falcon integration is not configured")
    if _client is None:
        _client = CoreAiClient(settings.base_url, settings.api_key)
    return LocalFalconClient(_client, settings.local_falcon_tool_id)


def _slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return result or "merchant"


def _location_context(conn: sqlite3.Connection, merchant: sqlite3.Row) -> dict:
    rows = conn.execute(
        "SELECT * FROM merchant_gbp_profiles WHERE merchant_id = ? ORDER BY id",
        (merchant["id"],),
    ).fetchall()
    if not rows:
        raise HTTPException(status_code=409, detail="sync GBP data before generating SEO targets")
    values = [(row, json.loads(row["normalized_json"])) for row in rows]
    selected = next(
        (item for item in values if item[1].get("title") == merchant["name"]),
        values[0],
    )
    return selected[1]


def _confirmed_context(conn: sqlite3.Connection, merchant: sqlite3.Row) -> tuple[dict, dict, dict]:
    location = _location_context(conn, merchant)
    title = location.get("title") or merchant["name"]
    address = location.get("address") or merchant["primary_location"] or "Not provided"
    website = location.get("website_url") or merchant["website_url"] or "Not provided"
    place_id = location.get("place_id")
    location_id = location.get("gbp_location_id") or f"merchant-{merchant['id']}-location"
    location_slug = _slug(f"{location.get('locality') or title}-{location.get('administrative_area') or ''}")
    external = {"google_business": place_id} if place_id else {}
    merchant_payload = {
        "id": str(merchant["id"]),
        "slug": _slug(merchant["name"]),
        "display_name": merchant["name"],
        "tags": ["restaurant", "us", "local-seo"],
        "locations": [
            {
                "id": location_id,
                "slug": location_slug,
                "display_name": address,
                "external_identities": external,
                "readiness_status": "READY",
            }
        ],
    }
    categories = [
        value
        for value in [location.get("primary_category"), *(location.get("additional_categories") or [])]
        if value
    ]
    questionnaire = {
        "id": f"seo-ops-merchant-{merchant['id']}-confirmed-facts",
        "status": "FILLED",
        "base_info": {"name": title, "slug": _slug(title), "website": website},
        "answers": {
            "business-description": location.get("description") or "Not provided by the connected GBP source.",
            "priority-items": ", ".join(categories) or "Not confirmed.",
            "service-modes": "Not confirmed.",
            "service-area": address,
            "hours": json.dumps(location.get("regular_hours") or [], ensure_ascii=False),
            "locations": address,
            "differentiators": "Not confirmed.",
            "target-customers": "Not confirmed.",
            "known-competitors": "Not confirmed.",
            "desired-search-situations": "Observed GBP search terms are supplied as a separate evidence artifact.",
            "website-access": f"Public website identified as {website}; write access is not claimed.",
            "gbp-access": (
                f"Read-only GBP data synced for Place ID {place_id}." if place_id else "GBP Place ID not available."
            ),
            "important-promotions": "No current promotion is confirmed.",
        },
    }
    execution = {
        "location_id": location_id,
        "location_slug": location_slug,
        "merchant_id": str(merchant["id"]),
        "display_name": address,
        "google_business_id": place_id,
    }
    return merchant_payload, questionnaire, {"location": location, "execution": execution}


def build_keyword_request(conn: sqlite3.Connection, merchant: sqlite3.Row) -> dict:
    merchant_payload, questionnaire, context = _confirmed_context(conn, merchant)
    location = context["location"]
    return {
        "schema_version": "seo_ops.keyword_request.v2",
        "seo_ops_task_id": f"seo-targets-{merchant['id']}",
        "market": {"country_code": "US", "language": "en-US", "search_engine": "GOOGLE"},
        "merchant": merchant_payload,
        "questionnaire": questionnaire,
        "upstream_artifacts": [
            {
                "artifact_type": "GBP_SEARCH_KEYWORDS",
                "schema_version": "fbr.gbp.search_keyword_metric.v1",
                "title": "Connected GBP search terms",
                "payload": {"keywords": location.get("search_keywords") or []},
            }
        ],
        "execution_spec": {"action": "GENERATE_KEYWORD_SET", **context["execution"]},
        "output_schema_version": "seo_ops.keyword_set.v2",
        "rules": [
            "return_strict_json_only",
            "use_confirmed_merchant_facts_only",
            "do_not_claim_persistence_or_task_completion",
            "use_us_english_keywords",
            "return_10_to_20_distinct_keywords",
        ],
    }


def _fbr_local_keyword_set(merchant: sqlite3.Row, location: dict, payload: dict) -> dict | None:
    place_id = location.get("place_id")
    if payload.get("place_id") != place_id:
        raise FbrPayloadError("FBR persisted keyword Place ID does not match the selected GBP location")
    groups = payload.get("local_keywords")
    if not isinstance(groups, list) or any(not isinstance(group, dict) for group in groups):
        raise FbrPayloadError("FBR persisted local keyword list is invalid")

    keywords = []
    seen = set()
    for group in groups:
        local_keyword_id = group.get("local_keyword_id")
        items = group.get("keywords")
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise FbrPayloadError("FBR persisted keyword group is invalid")
        for item in items:
            keyword = item.get("keyword")
            if not isinstance(keyword, str) or not keyword.strip():
                raise FbrPayloadError("FBR persisted keyword is missing keyword text")
            keyword = keyword.strip()
            key = keyword.casefold()
            if key in seen:
                continue
            seen.add(key)
            priority = item.get("priority")
            if priority not in {"P0", "P1", "P2", "P3"}:
                priority = "UNSCORED"
            surfaces = item.get("target_surface_types")
            if not isinstance(surfaces, list):
                surfaces = []
            surfaces = [value for value in surfaces if value in {"GBP", "WEBSITE"}]
            source_tags = ["FBR_KEYWORD_STORE"]
            if isinstance(local_keyword_id, str) and local_keyword_id:
                source_tags.append(f"FBR_LOCAL_KEYWORD_ID:{local_keyword_id}")
            keywords.append(
                {
                    "keyword": keyword,
                    "strategy": "LOCAL",
                    "intent": "NEAR_ME" if "near me" in key else "LOCAL",
                    "priority": priority,
                    "rationale": "Read from the persisted FBR local keyword repository for this GBP Place ID.",
                    "source_tags": source_tags,
                    "target_surface_types": surfaces,
                    "target_location": location.get("address") or location.get("title"),
                }
            )
    if not keywords:
        return None
    title = location.get("title") or merchant["name"]
    result = {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": str(merchant["id"]),
        "market": {
            "country_code": "US",
            "language": "en-US",
            "search_engine": "GOOGLE",
            "location_name": location.get("address") or title,
        },
        "generation_method": "PERSISTED_FBR_READBACK",
        "title": f"{title} persisted keyword set",
        "summary": f"Read {len(keywords)} existing local keywords from FBR without regenerating them.",
        "keywords": keywords,
        "evidence_gaps": [
            "This location-scoped read contains local keywords only; organic keywords require the merchant-scoped FBR read contract."
        ],
    }
    return KeywordSetV2.model_validate(result).model_dump(mode="json")


def _persist_fbr_keyword_set(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
    keyword_set: dict,
) -> str:
    cycle_id = str(uuid4())
    synced_at = now_iso()
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " request_json, payload_json, created_at, completed_at)"
        " VALUES (?, ?, 'KEYWORD_SET', 'seo_ops.keyword_set.v2', 'ready',"
        " 'fbr-keyword-store', ?, ?, ?, ?)",
        (
            merchant_id,
            cycle_id,
            json.dumps(
                {"source": "FBR_KEYWORD_STORE", "place_id": place_id},
                ensure_ascii=False,
            ),
            json.dumps(keyword_set, ensure_ascii=False),
            synced_at,
            synced_at,
        ),
    )
    conn.commit()
    return cycle_id


def _start_keyword_skill_cycle(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
    client: CoreAiClient,
    workflow: KeywordSkillWorkflow,
) -> str:
    try:
        agent = client.get_agent(workflow.agent_id)
    except CoreAiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    skill_ids = agent.get("skill_ids")
    if not isinstance(skill_ids, list) or not {
        workflow.seed_skill_id,
        workflow.ranking_skill_id,
    }.issubset({value for value in skill_ids if isinstance(value, str)}):
        raise HTTPException(
            status_code=409,
            detail="configured keyword generation Agent is missing required seed and ranking Skills",
        )

    request = build_keyword_request(conn, merchant)
    request["execution_spec"]["action"] = "REGENERATE_KEYWORD_SET_WITH_SKILLS"
    request["workflow"] = {
        "seed_skill_id": workflow.seed_skill_id,
        "ranking_skill_id": workflow.ranking_skill_id,
        "stages": ["SEED", "RANK_AND_PRIORITIZE"],
    }
    request["rules"].extend(
        [
            "invoke_the_configured_seed_skill_first",
            "invoke_the_configured_ranking_skill_on_the_seed_output",
            "do_not_substitute_ad_hoc_mcp_research_for_either_skill",
        ]
    )
    try:
        triggered = client.trigger(workflow.agent_id, json.dumps(request, ensure_ascii=False))
    except CoreAiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    cycle_id = str(uuid4())
    _insert_running_artifact(
        conn,
        merchant_id=merchant["id"],
        cycle_id=cycle_id,
        artifact_type="KEYWORD_SET",
        schema_version="seo_ops.keyword_set.v2",
        agent_id=workflow.agent_id,
        run_id=triggered["run_id"],
        request=request,
    )
    conn.commit()
    return cycle_id


def _parse_json_object(raw: object, label: str) -> dict:
    value = raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _parse_keyword_set(raw: object, merchant_id: int) -> dict:
    report = KeywordSetV2.model_validate(_parse_json_object(raw, "keyword result"))
    if report.merchant_id != str(merchant_id):
        raise ValueError("keyword merchant_id does not match the run merchant")
    if report.generation_method == "EVIDENCE_BOUNDED_RESEARCH" and any(
        item.priority != "UNSCORED" for item in report.keywords
    ):
        raise ValueError("evidence-bounded keywords must remain UNSCORED")
    return report.model_dump(mode="json")


def _parse_ranking_report(raw: object, merchant_id: int) -> dict:
    report = RankingReportV1.model_validate(_parse_json_object(raw, "ranking result"))
    if report.merchant_id != str(merchant_id):
        raise ValueError("ranking merchant_id does not match the run merchant")
    for item in report.keywords:
        if item.source == "UNAVAILABLE" and (item.local_rank is not None or item.organic_rank is not None):
            raise ValueError("unavailable ranking rows cannot contain measured ranks")
    return report.model_dump(mode="json")


def _upstream(kind: str, schema_version: str, title: str, payload: dict) -> dict:
    return {
        "artifact_type": kind,
        "schema_version": schema_version,
        "title": title,
        "payload": payload,
    }


def _build_audit_request(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
    keyword_set: dict,
) -> dict:
    merchant_payload, questionnaire, context = _confirmed_context(conn, merchant)
    return {
        "schema_version": "seo_ops.audit_request.v1",
        "seo_ops_task_id": f"seo-targets-{merchant['id']}",
        "merchant": merchant_payload,
        "questionnaire": questionnaire,
        "upstream_artifacts": [
            _upstream("KEYWORD_SET", keyword_set["schema_version"], keyword_set["title"], keyword_set)
        ],
        "execution_spec": {"action": "GENERATE_AUDIT", **context["execution"]},
        "output_schema_version": "seo_ops.audit_report.v1",
        "rules": [
            "return_strict_json_only",
            "use_confirmed_evidence_only",
            "do_not_claim_persistence_or_task_completion",
        ],
    }


def _build_ranking_request(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
    keyword_set: dict,
    audit_report: dict,
) -> dict:
    merchant_payload, questionnaire, context = _confirmed_context(conn, merchant)
    return {
        "schema_version": "seo_ops.ranking_request.v1",
        "seo_ops_task_id": f"seo-targets-{merchant['id']}",
        "merchant": merchant_payload,
        "questionnaire": questionnaire,
        "upstream_artifacts": [
            _upstream("KEYWORD_SET", keyword_set["schema_version"], keyword_set["title"], keyword_set),
            _upstream("AUDIT_REPORT", audit_report["schema_version"], audit_report["title"], audit_report),
        ],
        "execution_spec": {"action": "GENERATE_REPORT", **context["execution"]},
        "report_spec": {"report_type": "LOCAL_SEO_RANKING_BASELINE", "mode": "READ_ONLY"},
        "output_schema_version": "seo_ops.ranking_report.v1",
        "rules": [
            "return_strict_json_only",
            "use_live_read_only_rank_sources_only",
            "return_null_and_unavailable_when_not_measured",
            "do_not_claim_persistence_or_task_completion",
        ],
    }


def _insert_running_artifact(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    cycle_id: str,
    artifact_type: str,
    schema_version: str,
    agent_id: str,
    run_id: str,
    request: dict,
) -> None:
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " coreai_run_id, request_json, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)",
        (
            merchant_id,
            cycle_id,
            artifact_type,
            schema_version,
            agent_id,
            run_id,
            json.dumps(request, ensure_ascii=False),
            now_iso(),
        ),
    )


def _insert_failed_artifact(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    cycle_id: str,
    artifact_type: str,
    schema_version: str,
    agent_id: str,
    request: dict,
    error: str,
) -> None:
    conn.execute(
        "INSERT INTO merchant_seo_artifacts"
        " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
        " request_json, error, created_at, completed_at) VALUES (?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)",
        (
            merchant_id,
            cycle_id,
            artifact_type,
            schema_version,
            agent_id,
            json.dumps(request, ensure_ascii=False),
            error,
            now_iso(),
            now_iso(),
        ),
    )


def poll_seo_targets_once(client: CoreAiClient, agents: SeoAgentIds) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM merchant_seo_artifacts"
            " WHERE status = 'running' AND coreai_run_id IS NOT NULL ORDER BY id"
        ).fetchall()
        for row in rows:
            try:
                core = client.get_run(row["coreai_run_id"])
            except CoreAiError:
                continue
            core_status = core["status"]
            if core_status not in TERMINAL_STATUSES:
                continue
            finished_at = core.get("completed_at") if isinstance(core.get("completed_at"), str) else now_iso()
            if core_status != "COMPLETED":
                conn.execute(
                    "UPDATE merchant_seo_artifacts SET status = 'failed', error = ?, completed_at = ?"
                    " WHERE id = ?",
                    (core.get("error") or f"core-ai status {core_status}", finished_at, row["id"]),
                )
                conn.commit()
                continue

            try:
                if row["artifact_type"] == "KEYWORD_SET":
                    payload = _parse_keyword_set(core.get("output"), row["merchant_id"])
                elif row["artifact_type"] == "AUDIT_REPORT":
                    payload = parse_audit_report(core.get("output"), row["merchant_id"]).model_dump(mode="json")
                elif row["artifact_type"] == "RANKING_REPORT":
                    payload = _parse_ranking_report(core.get("output"), row["merchant_id"])
                else:
                    raise ValueError(f"unsupported SEO artifact type {row['artifact_type']}")
            except (ValueError, TypeError) as exc:
                conn.execute(
                    "UPDATE merchant_seo_artifacts SET status = 'failed', error = ?, completed_at = ?"
                    " WHERE id = ?",
                    (str(exc), finished_at, row["id"]),
                )
                conn.commit()
                continue

            conn.execute(
                "UPDATE merchant_seo_artifacts SET status = 'ready', payload_json = ?, completed_at = ?"
                " WHERE id = ?",
                (json.dumps(payload, ensure_ascii=False), finished_at, row["id"]),
            )
            if row["artifact_type"] == "RANKING_REPORT":
                conn.commit()
                continue

            merchant = fetch_merchant(conn, row["merchant_id"])
            if row["artifact_type"] == "KEYWORD_SET":
                next_type = "AUDIT_REPORT"
                next_schema = "seo_ops.audit_report.v1"
                next_agent = agents.audit
                next_request = _build_audit_request(conn, merchant, payload)
            else:
                keyword_row = conn.execute(
                    "SELECT payload_json FROM merchant_seo_artifacts"
                    " WHERE merchant_id = ? AND cycle_id = ? AND artifact_type = 'KEYWORD_SET'"
                    " AND status = 'ready' ORDER BY id DESC LIMIT 1",
                    (row["merchant_id"], row["cycle_id"]),
                ).fetchone()
                if keyword_row is None:
                    conn.execute(
                        "UPDATE merchant_seo_artifacts SET status = 'failed', error = ?, completed_at = ?"
                        " WHERE id = ?",
                        ("ready keyword set is missing", now_iso(), row["id"]),
                    )
                    conn.commit()
                    continue
                next_type = "RANKING_REPORT"
                next_schema = "seo_ops.ranking_report.v1"
                next_agent = agents.ranking
                next_request = _build_ranking_request(
                    conn, merchant, json.loads(keyword_row["payload_json"]), payload
                )
            try:
                triggered = client.trigger(next_agent, json.dumps(next_request, ensure_ascii=False))
            except CoreAiError as exc:
                _insert_failed_artifact(
                    conn,
                    merchant_id=row["merchant_id"],
                    cycle_id=row["cycle_id"],
                    artifact_type=next_type,
                    schema_version=next_schema,
                    agent_id=next_agent,
                    request=next_request,
                    error=str(exc),
                )
            else:
                _insert_running_artifact(
                    conn,
                    merchant_id=row["merchant_id"],
                    cycle_id=row["cycle_id"],
                    artifact_type=next_type,
                    schema_version=next_schema,
                    agent_id=next_agent,
                    run_id=triggered["run_id"],
                    request=next_request,
                )
            conn.commit()
    finally:
        conn.close()


def _local_falcon_state(
    conn: sqlite3.Connection,
    merchant_id: int,
    keyword_set: dict | None,
) -> dict:
    sync = conn.execute(
        "SELECT * FROM merchant_local_falcon_syncs WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    accepted = {
        item.get("keyword", "").strip().casefold()
        for item in (keyword_set or {}).get("keywords", [])
        if item.get("strategy") == "LOCAL" and item.get("keyword", "").strip()
    }
    rows = conn.execute(
        "SELECT * FROM merchant_local_falcon_reports"
        " WHERE merchant_id = ? ORDER BY captured_at DESC, id DESC",
        (merchant_id,),
    ).fetchall()
    reports = []
    seen = set()
    for row in rows:
        key = row["keyword"].strip().casefold()
        if key not in accepted or key in seen:
            continue
        seen.add(key)
        reports.append(
            {
                "schema_version": "seo_ops.local_falcon_snapshot.v1",
                "report_key": row["report_key"],
                "place_id": row["place_id"],
                "keyword": row["keyword"],
                "platform": row["platform"],
                "captured_at": row["captured_at"],
                "center_lat": row["center_lat"],
                "center_lng": row["center_lng"],
                "grid_size": row["grid_size"],
                "radius": row["radius"],
                "measurement": row["measurement"],
                "arp": row["arp"],
                "atrp": row["atrp"],
                "solv": row["solv"],
                "found_in": row["found_in"],
                "image_url": row["image_url"],
                "heatmap_url": row["heatmap_url"],
                "grid_points": json.loads(row["grid_points_json"]),
            }
        )
    return {
        "status": sync["status"] if sync else "not_synced",
        "last_synced_at": sync["last_synced_at"] if sync else None,
        "last_error": sync["last_error"] if sync else None,
        "missing_keywords": json.loads(sync["missing_keywords_json"]) if sync else [],
        "reports": reports,
    }


def _state(conn: sqlite3.Connection, merchant_id: int, cycle_id: str | None = None) -> dict:
    capabilities = {
        "can_regenerate": _keyword_skill_workflow_settings() is not None,
    }
    if cycle_id is None:
        row = conn.execute(
            "SELECT cycle_id FROM merchant_seo_artifacts WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
            (merchant_id,),
        ).fetchone()
        cycle_id = row["cycle_id"] if row else None
    if cycle_id is None:
        return {
            "merchant_id": merchant_id,
            "cycle_status": "empty",
            "active_stage": None,
            "keyword_set": None,
            "audit_report": None,
            "ranking_report": None,
            "local_falcon": _local_falcon_state(conn, merchant_id, None),
            "capabilities": capabilities,
            "error": None,
        }
    rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts WHERE merchant_id = ? AND cycle_id = ? ORDER BY id",
        (merchant_id, cycle_id),
    ).fetchall()
    running = next((row for row in rows if row["status"] == "running"), None)
    failed = next((row for row in reversed(rows) if row["status"] == "failed"), None)

    keyword_row = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'ready'"
        " AND payload_json IS NOT NULL"
        " ORDER BY (cycle_id = ?) DESC, id DESC LIMIT 1",
        (merchant_id, cycle_id),
    ).fetchone()
    display_cycle_id = keyword_row["cycle_id"] if keyword_row else None
    display_rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND cycle_id = ? AND status = 'ready' ORDER BY id",
        (merchant_id, display_cycle_id),
    ).fetchall() if display_cycle_id else []
    display_by_type = {row["artifact_type"]: row for row in display_rows}

    def payload(kind: str):
        row = display_by_type.get(kind)
        return json.loads(row["payload_json"]) if row and row["payload_json"] else None

    keyword_payload = payload("KEYWORD_SET")
    return {
        "merchant_id": merchant_id,
        "cycle_id": cycle_id,
        "cycle_status": "running" if running else "failed" if failed else "ready",
        "active_stage": running["artifact_type"] if running else None,
        "keyword_set": keyword_payload,
        "audit_report": payload("AUDIT_REPORT"),
        "ranking_report": payload("RANKING_REPORT"),
        "local_falcon": _local_falcon_state(conn, merchant_id, keyword_payload),
        "capabilities": capabilities,
        "error": failed["error"] if failed else None,
    }


@router.get("/merchants/{merchant_id}/seo-targets")
def get_seo_targets(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    return _state(conn, merchant_id)


def _record_local_falcon_failure(conn: sqlite3.Connection, merchant_id: int, error: str) -> None:
    attempted_at = now_iso()
    conn.execute(
        "INSERT INTO merchant_local_falcon_syncs"
        " (merchant_id, status, last_attempt_at, last_error) VALUES (?, 'failed', ?, ?)"
        " ON CONFLICT(merchant_id) DO UPDATE SET"
        " status = 'failed', last_attempt_at = excluded.last_attempt_at,"
        " last_error = excluded.last_error",
        (merchant_id, attempted_at, error[:500]),
    )
    conn.commit()


@router.post("/merchants/{merchant_id}/local-falcon-sync")
def sync_local_falcon_reports(
    merchant_id: int,
    local_falcon=Depends(get_local_falcon),
    conn=Depends(get_db),
):
    merchant = fetch_merchant(conn, merchant_id)
    location = _location_context(conn, merchant)
    place_id = location.get("place_id")
    if not place_id:
        raise HTTPException(status_code=409, detail="GBP Place ID is required for Local Falcon")
    keyword_row = conn.execute(
        "SELECT payload_json FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'ready'"
        " AND payload_json IS NOT NULL ORDER BY id DESC LIMIT 1",
        (merchant_id,),
    ).fetchone()
    if keyword_row is None:
        raise HTTPException(status_code=409, detail="generate and accept keywords before Local Falcon sync")
    keyword_set = json.loads(keyword_row["payload_json"])
    keywords = []
    seen = set()
    for item in keyword_set.get("keywords", []):
        keyword = item.get("keyword", "").strip()
        key = keyword.casefold()
        if item.get("strategy") == "LOCAL" and keyword and key not in seen:
            seen.add(key)
            keywords.append(keyword)

    snapshots = []
    missing = []
    try:
        for keyword in keywords:
            listed = local_falcon.list_latest_exact_report(place_id, keyword)
            if listed is None:
                missing.append(keyword)
                continue
            report_key = listed.get("report_key")
            if not isinstance(report_key, str):
                raise ValueError("Local Falcon report key is missing")
            snapshots.append(
                normalize_local_falcon_report(
                    local_falcon.get_report(report_key),
                    expected_place_id=place_id,
                    expected_keyword=keyword,
                )
            )
    except (CoreAiError, ValueError) as exc:
        _record_local_falcon_failure(conn, merchant_id, str(exc))
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    synced_at = now_iso()
    for snapshot in snapshots:
        conn.execute(
            "INSERT INTO merchant_local_falcon_reports"
            " (merchant_id, report_key, place_id, keyword, platform, captured_at,"
            " center_lat, center_lng, grid_size, radius, measurement, arp, atrp, solv,"
            " found_in, image_url, heatmap_url, grid_points_json, synced_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(merchant_id, report_key) DO UPDATE SET"
            " place_id = excluded.place_id, keyword = excluded.keyword,"
            " platform = excluded.platform, captured_at = excluded.captured_at,"
            " center_lat = excluded.center_lat, center_lng = excluded.center_lng,"
            " grid_size = excluded.grid_size, radius = excluded.radius,"
            " measurement = excluded.measurement, arp = excluded.arp, atrp = excluded.atrp,"
            " solv = excluded.solv, found_in = excluded.found_in,"
            " image_url = excluded.image_url, heatmap_url = excluded.heatmap_url,"
            " grid_points_json = excluded.grid_points_json, synced_at = excluded.synced_at",
            (
                merchant_id,
                snapshot["report_key"],
                snapshot["place_id"],
                snapshot["keyword"],
                snapshot["platform"],
                snapshot["captured_at"],
                snapshot["center_lat"],
                snapshot["center_lng"],
                snapshot["grid_size"],
                snapshot["radius"],
                snapshot["measurement"],
                snapshot["arp"],
                snapshot["atrp"],
                snapshot["solv"],
                snapshot["found_in"],
                snapshot["image_url"],
                snapshot["heatmap_url"],
                json.dumps(snapshot["grid_points"], ensure_ascii=False),
                synced_at,
            ),
        )
    conn.execute(
        "INSERT INTO merchant_local_falcon_syncs"
        " (merchant_id, status, last_attempt_at, last_synced_at, last_error, missing_keywords_json)"
        " VALUES (?, 'synced', ?, ?, NULL, ?)"
        " ON CONFLICT(merchant_id) DO UPDATE SET"
        " status = 'synced', last_attempt_at = excluded.last_attempt_at,"
        " last_synced_at = excluded.last_synced_at, last_error = NULL,"
        " missing_keywords_json = excluded.missing_keywords_json",
        (merchant_id, synced_at, synced_at, json.dumps(missing, ensure_ascii=False)),
    )
    conn.commit()
    return _state(conn, merchant_id)


@router.post(
    "/merchants/{merchant_id}/seo-targets/refresh",
    status_code=status.HTTP_202_ACCEPTED,
)
def refresh_seo_targets(
    merchant_id: int,
    conn=Depends(get_db),
):
    merchant = fetch_merchant(conn, merchant_id)
    if conn.execute(
        "SELECT 1 FROM merchant_seo_artifacts WHERE merchant_id = ? AND status = 'running' LIMIT 1",
        (merchant_id,),
    ).fetchone():
        raise HTTPException(status_code=409, detail="SEO target refresh already running")
    location = _location_context(conn, merchant)
    place_id = location.get("place_id")
    if not place_id:
        raise HTTPException(status_code=409, detail="GBP Place ID is required for keyword lookup")
    try:
        fbr_client = fbr_gbp.fbr_gbp_client()
    except FbrConfigurationError as exc:
        raise HTTPException(
            status_code=503,
            detail="FBR keyword repository is not configured",
        ) from exc
    try:
        persisted = _fbr_local_keyword_set(
            merchant,
            location,
            fbr_client.get_local_keywords(place_id),
        )
    except (FbrPayloadError, FbrUnavailableError) as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if persisted is None:
        if _keyword_skill_workflow_settings() is None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "FBR has no persisted keywords for this GBP location; "
                    "configure the deterministic keyword Skill workflow before generating a new set"
                ),
            )
        client, workflow = get_keyword_skill_workflow()
        cycle_id = _start_keyword_skill_cycle(conn, merchant, client, workflow)
        return _state(conn, merchant_id, cycle_id)
    cycle_id = _persist_fbr_keyword_set(conn, merchant_id, place_id, persisted)
    return _state(conn, merchant_id, cycle_id)


@router.post(
    "/merchants/{merchant_id}/seo-targets/regenerate",
    status_code=status.HTTP_202_ACCEPTED,
)
def regenerate_seo_targets(
    merchant_id: int,
    workflow_client=Depends(get_keyword_skill_workflow),
    conn=Depends(get_db),
):
    merchant = fetch_merchant(conn, merchant_id)
    if conn.execute(
        "SELECT 1 FROM merchant_seo_artifacts WHERE merchant_id = ? AND status = 'running' LIMIT 1",
        (merchant_id,),
    ).fetchone():
        raise HTTPException(status_code=409, detail="SEO target refresh already running")

    client, workflow = workflow_client
    cycle_id = _start_keyword_skill_cycle(conn, merchant, client, workflow)
    return _state(conn, merchant_id, cycle_id)

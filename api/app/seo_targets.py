import hashlib
import json
import math
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    ValidationError,
    field_validator,
)

from .auth import require_operator
from .audit_snapshots import parse_audit_report
from .config import coreai_settings
from .coreai import CoreAiClient, CoreAiError, TERMINAL_STATUSES
from .db import connect, get_db
from . import fbr_gbp
from .fbr_gbp import FbrConfigurationError, FbrPayloadError, FbrUnavailableError
from .keyword_identity import _keyword_identity
from .local_falcon import LocalFalconClient, normalize_local_falcon_report
from .merchants import fetch_active_merchant, fetch_merchant, now_iso


router = APIRouter(prefix="/api", tags=["seo-targets"])

LOCAL_FALCON_KEYWORD_LIMIT = 20
LOCAL_FALCON_PAID_KEYWORD_METHODS = {
    "PERSISTED_FBR_READBACK",
    "UPSTREAM_DETERMINISTIC_ADAPTER",
}
LOCAL_FALCON_UNRESOLVED_BATCH_STATUSES = (
    "submitting",
    "submitted",
    "partial",
    "unknown",
)
LOCAL_FALCON_DISPATCH_STALE_AFTER = timedelta(minutes=10)
KEYWORD_DISPATCH_STALE_AFTER = timedelta(minutes=10)
KEYWORD_SKILL_PROVENANCE_WAIT = timedelta(seconds=30)
RANKING_SKILL_OUTPUT_ADAPTER_VERSION = "seo_ops.ranking_skill_output_adapter.v1"
RANKING_SKILL_KEYWORD_SET_ADAPTER_VERSION = (
    "seo_ops.ranking_skill_keyword_set_adapter.v2"
)
KEYWORD_ACTIVATION_REASONS = {
    "SKILL_GENERATION",
    "SYSTEM_BOOTSTRAP",
    "RESTORE_SKILL",
    "ADOPT_FBR",
}
# The current Local Falcon report contract has neither a timezone-aware
# submission timestamp nor a batch/request correlation id. A report with the
# same keyword and scan parameters could therefore belong to another paid run.
LOCAL_FALCON_MANUAL_REPORT_BINDING_ENABLED = False


class KeywordSkillProvenancePending(Exception):
    """Core AI run is terminal but its trace evidence is not fully readable yet."""


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
    score: StrictInt | StrictFloat | None = Field(default=None, ge=0, le=200)
    score_rank: int | None = Field(default=None, ge=1, le=200)
    local_falcon_selected: bool = False
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


class KeywordWorkflowResultV1(BaseModel):
    """Agent-authored handoff evidence around the two loaded Skill instructions."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.keyword_workflow_result.v1"]
    seed_output: dict[str, object] = Field(min_length=1)
    ranking_input: dict[str, object] = Field(min_length=1)
    ranking_output: dict[str, object] = Field(min_length=1)


class RankingSkillHybridExternalIdentitiesV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    google_business: str = Field(min_length=1, max_length=300)


class RankingSkillHybridLocationV1(BaseModel):
    """Observed UAT location envelope emitted when Agent response schema is skipped."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=300)
    slug: str = Field(min_length=1, max_length=300)
    display_name: str = Field(min_length=1, max_length=300)
    external_identities: RankingSkillHybridExternalIdentitiesV1
    readiness_status: Literal["READY"]


class RankingSkillHybridItemV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword: str = Field(min_length=1, max_length=300)
    strategy: Literal["LOCAL", "ORGANIC"]
    intent: Literal["transactional", "navigational", "commercial", "informational"]
    priority: Literal["P0", "P1", "P2", "P3"]
    score: StrictInt | StrictFloat = Field(ge=0, le=200)
    score_rank: StrictInt | None = Field(default=None, ge=1, le=200)
    local_falcon_selected: StrictBool
    rationale: str = Field(min_length=1, max_length=1000)
    source_tags: list[str] = Field(min_length=1, max_length=30)
    target_surface_types: list[Literal["GBP", "WEBSITE"]] = Field(max_length=2)
    target_location: str | None = Field(default=None, min_length=1, max_length=300)


class RankingSkillHybridOutputV1(BaseModel):
    """Narrow, versioned contract for the hybrid shape observed in UAT."""

    model_config = ConfigDict(extra="forbid")

    merchant_id: str = Field(min_length=1)
    market: KeywordMarketV2
    location: RankingSkillHybridLocationV1
    generation_method: Literal["UPSTREAM_DETERMINISTIC_ADAPTER"]
    keywords: list[RankingSkillHybridItemV1] = Field(min_length=1, max_length=200)


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


class LocalFalconApprovalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    keyword_artifact_id: int = Field(ge=1)
    expected_cohort_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class LocalFalconScanBatchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    approval_id: int = Field(ge=1)
    request_id: str = Field(min_length=1, max_length=200)
    expected_scan_config_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    confirm_credit_spend: StrictBool


class LocalFalconReconciliationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal[
        "BIND_ACKNOWLEDGED_REPORT",
        "CONFIRM_NOT_SUBMITTED",
        "CLOSE_WITHOUT_RETRY",
    ]
    keyword: str | None = Field(default=None, min_length=1, max_length=300)
    report_key: str | None = Field(default=None, pattern=r"^[a-f0-9]{15}$")
    reason: str = Field(min_length=10, max_length=1000)

    @field_validator("reason")
    @classmethod
    def validate_reason(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 10:
            raise ValueError("reason must contain at least 10 non-whitespace characters")
        return value


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


def get_reconciliation_local_falcon() -> LocalFalconClient | None:
    """Allow non-network reconciliation actions even after config is removed."""
    try:
        return get_local_falcon()
    except HTTPException as exc:
        if exc.status_code == 503:
            return None
        raise


def _slug(value: str) -> str:
    result = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return result or "merchant"


def _selected_location_context(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
) -> dict | None:
    rows = conn.execute(
        "SELECT * FROM merchant_gbp_profiles WHERE merchant_id = ? ORDER BY id",
        (merchant["id"],),
    ).fetchall()
    if not rows:
        return None
    values = [(row, json.loads(row["normalized_json"])) for row in rows]
    matches = [item for item in values if item[1].get("title") == merchant["name"]]
    if len(matches) == 1:
        return matches[0][1]
    if len(values) == 1:
        return values[0][1]
    return None


def _location_context(conn: sqlite3.Connection, merchant: sqlite3.Row) -> dict:
    selected = _selected_location_context(conn, merchant)
    if selected is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "select an unambiguous GBP location for this merchant before generating SEO targets"
            ),
        )
    return selected


def _keyword_artifact_place_id(row: sqlite3.Row | None) -> str | None:
    if row is None or not row["request_json"]:
        return None
    try:
        request = json.loads(row["request_json"])
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(request, dict):
        return None
    direct = request.get("place_id")
    if isinstance(direct, str) and direct:
        return direct
    execution = request.get("execution_spec")
    if isinstance(execution, dict):
        value = execution.get("google_business_id")
        if isinstance(value, str) and value:
            return value
    return None


def _sha256_json(value: object) -> str:
    canonical = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _trace_time(value: object, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise KeywordSkillProvenancePending(f"{label} is not available yet")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} is malformed") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone")
    return parsed


def _workflow_lineage_v2_matches_artifact(
    lineage: dict,
    artifact_sha256: str,
    expected_place_id: str,
) -> bool:
    adapter_version = lineage.get("adapter_version")
    seed_output_sha256 = lineage.get("seed_output_sha256")
    ranking_output_sha256 = lineage.get("ranking_output_sha256")
    source_seed_output = lineage.get("source_seed_output")
    source_ranking_output = lineage.get("source_ranking_output")
    seed_snapshot_matches = bool(
        isinstance(source_seed_output, dict)
        and source_seed_output.get("place_id") == expected_place_id
        and _sha256_json(source_seed_output) == seed_output_sha256
    )
    source_snapshot_matches = bool(
        isinstance(source_ranking_output, dict)
        and _sha256_json(source_ranking_output) == ranking_output_sha256
    )
    source_hash_is_valid = bool(
        ranking_output_sha256 == artifact_sha256
        if adapter_version is None
        else adapter_version
        in {
            RANKING_SKILL_OUTPUT_ADAPTER_VERSION,
            RANKING_SKILL_KEYWORD_SET_ADAPTER_VERSION,
        }
        and source_snapshot_matches
    )
    return bool(
        lineage.get("schema_version") == "seo_ops.keyword_workflow_lineage.v2"
        and seed_output_sha256 == lineage.get("ranking_input_sha256")
        and seed_snapshot_matches
        and source_snapshot_matches
        and source_hash_is_valid
        and lineage.get("adapter_output_sha256") == artifact_sha256
        and lineage.get("artifact_sha256") == artifact_sha256
    )


def _verify_keyword_skill_provenance(
    client: CoreAiClient,
    *,
    core: dict,
    request: dict,
    source_agent_id: str,
    run_id: str,
    payload: dict,
    lineage: dict,
) -> dict:
    workflow = request.get("workflow")
    if not isinstance(workflow, dict):
        raise ValueError("keyword Skill workflow snapshot is missing")
    expected = []
    for stage, key in (("SEED", "seed_skill"), ("RANK_AND_PRIORITIZE", "ranking_skill")):
        skill = workflow.get(key)
        if not isinstance(skill, dict):
            raise ValueError(f"keyword {stage} Skill snapshot is missing")
        skill_id = skill.get("id")
        qualified_name = skill.get("qualified_name")
        if not isinstance(skill_id, str) or not skill_id:
            raise ValueError(f"keyword {stage} Skill id is missing")
        if not isinstance(qualified_name, str) or not qualified_name:
            raise ValueError(f"keyword {stage} Skill qualified name is missing")
        expected.append(
            {
                "stage": stage,
                "id": skill_id,
                "qualified_name": qualified_name,
                "version": skill.get("version"),
                "updated_at": skill.get("updated_at"),
            }
        )
    if expected[0]["qualified_name"] == expected[1]["qualified_name"]:
        raise ValueError("keyword Seed and Ranking Skills must be distinct")

    trace_id = core.get("trace_id")
    if not isinstance(trace_id, str) or not trace_id:
        raise KeywordSkillProvenancePending("Core AI run trace_id is not available yet")
    try:
        trace = client.get_trace(trace_id)
        spans = client.list_trace_spans(trace_id)
    except CoreAiError as exc:
        raise KeywordSkillProvenancePending(str(exc)) from exc
    if trace.get("status") != "COMPLETED":
        raise KeywordSkillProvenancePending("Core AI trace is not completed yet")
    if trace.get("agentId") != source_agent_id:
        raise ValueError("Core AI trace agent does not match the keyword generation Agent")

    instruction_loads: dict[str, list[dict]] = {
        expected[0]["qualified_name"]: [],
        expected[1]["qualified_name"]: [],
    }
    for summary in spans:
        if summary.get("name") != "use_skill" or summary.get("type") != "TOOL":
            continue
        span_id = summary.get("spanId")
        if not isinstance(span_id, str) or not span_id:
            raise KeywordSkillProvenancePending("Core AI use_skill span id is not available yet")
        try:
            detail = client.get_trace_span(trace_id, span_id)
        except CoreAiError as exc:
            raise KeywordSkillProvenancePending(str(exc)) from exc
        raw_input = detail.get("input")
        raw_output = detail.get("output")
        if raw_input is None or raw_output is None:
            raise KeywordSkillProvenancePending("Core AI use_skill span detail is not complete yet")
        if not isinstance(raw_input, str) or not isinstance(raw_output, str):
            raise ValueError("Core AI use_skill span evidence is malformed")
        try:
            arguments = json.loads(raw_input)
        except json.JSONDecodeError as exc:
            raise ValueError("Core AI use_skill input is not valid JSON") from exc
        if not isinstance(arguments, dict) or set(arguments) != {"name"}:
            raise ValueError("Core AI use_skill input must contain only the Skill name")
        qualified_name = arguments.get("name")
        if qualified_name not in instruction_loads:
            continue
        if detail.get("name") != "use_skill" or detail.get("type") != "TOOL":
            raise ValueError("Core AI use_skill span detail type does not match its summary")
        if detail.get("status") != "OK" or re.match(
            r"^ToolCallResult\{status=COMPLETED,",
            raw_output,
        ) is None:
            raise ValueError(
                f"keyword Skill instruction load {qualified_name} did not complete successfully"
            )
        instruction_load = {
            "span_id": span_id,
            "qualified_name": qualified_name,
            "started_at": detail.get("startedAt"),
            "completed_at": detail.get("completedAt"),
            "input_sha256": hashlib.sha256(raw_input.encode("utf-8")).hexdigest(),
            "output_sha256": hashlib.sha256(raw_output.encode("utf-8")).hexdigest(),
        }
        _trace_time(instruction_load["started_at"], "Core AI use_skill startedAt")
        _trace_time(instruction_load["completed_at"], "Core AI use_skill completedAt")
        instruction_loads[qualified_name].append(instruction_load)

    for item in expected:
        matches = instruction_loads[item["qualified_name"]]
        if not matches:
            raise KeywordSkillProvenancePending(
                f"keyword {item['stage']} Skill instruction load is not available yet"
            )
        if len(matches) != 1:
            raise ValueError(
                f"keyword {item['stage']} Skill instructions must be loaded exactly once"
            )
    seed = instruction_loads[expected[0]["qualified_name"]][0]
    ranking = instruction_loads[expected[1]["qualified_name"]][0]
    if _trace_time(seed["completed_at"], "Seed completedAt") > _trace_time(
        ranking["started_at"],
        "Ranking startedAt",
    ):
        raise ValueError(
            "keyword Ranking Skill instructions were loaded before the Seed Skill instruction load completed"
        )

    artifact_sha256 = _sha256_json(payload)
    execution = request.get("execution_spec")
    expected_place_id = (
        execution.get("google_business_id") if isinstance(execution, dict) else None
    )
    if not isinstance(expected_place_id, str) or not expected_place_id:
        raise ValueError("keyword workflow request Google Business identity is missing")
    if not _workflow_lineage_v2_matches_artifact(
        lineage,
        artifact_sha256,
        expected_place_id,
    ):
        raise ValueError("keyword workflow lineage does not match the accepted artifact")

    return {
        "status": "VERIFIED",
        "method": "CORE_AI_SKILL_LOAD_TRACE_AND_WORKFLOW_LINEAGE_V2",
        "run_id": run_id,
        "trace_id": trace_id,
        "source_agent_id": source_agent_id,
        "expected_skills": expected,
        "skill_instruction_loads": [seed, ranking],
        "workflow_lineage": lineage,
        "artifact_sha256": artifact_sha256,
        "verified_at": now_iso(),
        "limitations": [
            "Core AI span detail proves qualified Skill instruction loads and their order; "
            "the workflow envelope and versioned adapter preserve source and artifact hashes. "
            "They do not prove that a Skill executed independently of the Agent."
        ],
    }


def _keyword_artifact_paid_eligible(
    row: sqlite3.Row | None,
    keyword_set: dict | None,
    current_place_id: str | None,
) -> bool:
    if (
        row is None
        or keyword_set is None
        or not current_place_id
        or _keyword_artifact_place_id(row) != current_place_id
    ):
        return False
    try:
        request = json.loads(row["request_json"])
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(request, dict):
        return False
    if not _has_deterministic_scored_local_cohort(keyword_set):
        return False

    method = keyword_set.get("generation_method")
    if method == "PERSISTED_FBR_READBACK":
        return (
            row["source_agent_id"] == "fbr-keyword-store"
            and request.get("source") == "FBR_KEYWORD_STORE"
            and request.get("place_id") == current_place_id
        )
    if method != "UPSTREAM_DETERMINISTIC_ADAPTER":
        return False

    execution = request.get("execution_spec")
    requested_workflow = request.get("workflow")
    if (
        not isinstance(execution, dict)
        or execution.get("action") != "REGENERATE_KEYWORD_SET_WITH_SKILLS"
        or execution.get("google_business_id") != current_place_id
        or not isinstance(requested_workflow, dict)
        or requested_workflow.get("stages") != ["SEED", "RANK_AND_PRIORITIZE"]
        or request.get("output_schema_version")
        != "seo_ops.keyword_workflow_result.v1"
    ):
        return False
    try:
        provenance = json.loads(row["provenance_json"] or "null")
    except (TypeError, json.JSONDecodeError):
        return False
    if not isinstance(provenance, dict):
        return False
    seed = requested_workflow.get("seed_skill")
    ranking = requested_workflow.get("ranking_skill")
    expected = provenance.get("expected_skills")
    instruction_loads = provenance.get("skill_instruction_loads")
    lineage = provenance.get("workflow_lineage")
    artifact_sha256 = _sha256_json(keyword_set)
    current_lineage_matches = bool(
        provenance.get("method")
        == "CORE_AI_SKILL_LOAD_TRACE_AND_WORKFLOW_LINEAGE_V2"
        and isinstance(lineage, dict)
        and _workflow_lineage_v2_matches_artifact(
            lineage,
            artifact_sha256,
            current_place_id,
        )
    )
    return bool(
        isinstance(seed, dict)
        and isinstance(ranking, dict)
        and requested_workflow.get("seed_skill_id") == seed.get("id")
        and requested_workflow.get("ranking_skill_id") == ranking.get("id")
        and provenance.get("status") == "VERIFIED"
        and current_lineage_matches
        and provenance.get("run_id") == row["coreai_run_id"]
        and provenance.get("source_agent_id") == row["source_agent_id"]
        and provenance.get("artifact_sha256") == artifact_sha256
        and isinstance(expected, list)
        and [item.get("id") for item in expected if isinstance(item, dict)]
        == [seed.get("id"), ranking.get("id")]
        and [item.get("qualified_name") for item in expected if isinstance(item, dict)]
        == [seed.get("qualified_name"), ranking.get("qualified_name")]
        and isinstance(instruction_loads, list)
        and [
            item.get("qualified_name")
            for item in instruction_loads
            if isinstance(item, dict)
        ]
        == [seed.get("qualified_name"), ranking.get("qualified_name")]
    )


def _unresolved_local_falcon_batch(
    conn: sqlite3.Connection,
    merchant_id: int,
) -> sqlite3.Row | None:
    placeholders = ",".join("?" for _ in LOCAL_FALCON_UNRESOLVED_BATCH_STATUSES)
    return conn.execute(
        "SELECT * FROM merchant_local_falcon_scan_batches"
        f" WHERE merchant_id = ? AND status IN ({placeholders})"
        " ORDER BY id DESC LIMIT 1",
        (merchant_id, *LOCAL_FALCON_UNRESOLVED_BATCH_STATUSES),
    ).fetchone()


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
            "return_numeric_score_for_every_local_keyword",
            "rank_local_keywords_by_score_descending",
        ],
    }


def _ranking_output_contract() -> dict:
    """Compact contract copied into every run because Agent response_schema is not enforced."""
    return {
        "schema_version": "seo_ops.keyword_set.v2",
        "required": [
            "schema_version",
            "merchant_id",
            "market",
            "generation_method",
            "title",
            "summary",
            "keywords",
            "evidence_gaps",
        ],
        "intent_values": ["LOCAL", "ORGANIC", "BRAND", "MENU", "NEAR_ME"],
        "strategy_values": ["LOCAL", "ORGANIC"],
        "market_required": [
            "country_code",
            "language",
            "search_engine",
            "location_name",
        ],
        "intent_mapping": {
            "brand_navigation": "BRAND",
            "literal_near_me": "NEAR_ME",
            "remaining_local": "LOCAL",
            "remaining_organic": "ORGANIC",
        },
        "additional_properties": False,
        "fallback_adapter_version": RANKING_SKILL_OUTPUT_ADAPTER_VERSION,
    }


def _is_numeric_keyword_score(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and 0 <= value <= 200
    )


def _rank_keyword_scores(keyword_set: dict) -> dict:
    keywords = keyword_set.get("keywords", [])
    for item in keywords:
        item["score_rank"] = None
        item["local_falcon_selected"] = False

    local_keywords = [item for item in keywords if item.get("strategy") == "LOCAL"]
    complete_scores = bool(local_keywords) and all(
        _is_numeric_keyword_score(item.get("score")) for item in local_keywords
    )
    if not complete_scores:
        if local_keywords:
            gap = (
                "FBR did not return a numeric score for every local keyword; "
                "the Local Falcon Top 20 cohort cannot be selected."
            )
            gaps = keyword_set.setdefault("evidence_gaps", [])
            if gap not in gaps:
                gaps.append(gap)
        return keyword_set

    ranked_local = sorted(
        enumerate(local_keywords),
        key=lambda value: (-value[1]["score"], value[0]),
    )
    ordered_local = []
    for rank, (_, item) in enumerate(ranked_local, start=1):
        item["score_rank"] = rank
        item["local_falcon_selected"] = rank <= LOCAL_FALCON_KEYWORD_LIMIT
        ordered_local.append(item)
    keyword_set["keywords"] = ordered_local + [
        item for item in keywords if item.get("strategy") != "LOCAL"
    ]
    return keyword_set


def _has_deterministic_scored_local_cohort(keyword_set: dict) -> bool:
    keywords = keyword_set.get("keywords")
    if not isinstance(keywords, list):
        return False
    local_keywords = [
        item
        for item in keywords
        if isinstance(item, dict) and item.get("strategy") == "LOCAL"
    ]
    if not local_keywords or not all(
        _is_numeric_keyword_score(item.get("score")) for item in local_keywords
    ):
        return False
    expected = sorted(
        enumerate(local_keywords),
        key=lambda value: (-value[1]["score"], value[0]),
    )
    return all(
        item.get("score_rank") == rank
        and item.get("local_falcon_selected") == (rank <= LOCAL_FALCON_KEYWORD_LIMIT)
        for rank, (_, item) in enumerate(expected, start=1)
    )


def _preferred_ready_keyword_artifact(
    conn: sqlite3.Connection,
    merchant_id: int,
    current_place_id: str | None,
) -> tuple[sqlite3.Row | None, dict | None]:
    rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'ready'"
        " AND payload_json IS NOT NULL ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    candidates: list[tuple[sqlite3.Row, dict]] = []
    for row in rows:
        if (
            current_place_id is not None
            and _keyword_artifact_place_id(row) != current_place_id
        ):
            continue
        try:
            keyword_set = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(keyword_set, dict):
            candidates.append((row, keyword_set))

    for row, keyword_set in candidates:
        if _keyword_artifact_paid_eligible(row, keyword_set, current_place_id):
            return row, keyword_set
    return candidates[0] if candidates else (None, None)


def _ready_keyword_artifact_candidates(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
) -> list[tuple[sqlite3.Row, dict]]:
    rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'ready'"
        " AND payload_json IS NOT NULL ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    candidates: list[tuple[sqlite3.Row, dict]] = []
    for row in rows:
        if _keyword_artifact_place_id(row) != place_id:
            continue
        try:
            keyword_set = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(keyword_set, dict):
            candidates.append((row, keyword_set))
    return candidates


def _is_valid_fbr_keyword_artifact(
    row: sqlite3.Row,
    keyword_set: dict,
    place_id: str,
) -> bool:
    if (
        keyword_set.get("generation_method") != "PERSISTED_FBR_READBACK"
        or _keyword_artifact_place_id(row) != place_id
        or row["source_agent_id"] != "fbr-keyword-store"
    ):
        return False
    try:
        request = json.loads(row["request_json"])
    except (TypeError, json.JSONDecodeError):
        return False
    return bool(
        isinstance(request, dict)
        and request.get("source") == "FBR_KEYWORD_STORE"
        and request.get("place_id") == place_id
    )


def _ensure_keyword_head(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
) -> sqlite3.Row:
    head = conn.execute(
        "SELECT * FROM merchant_keyword_heads WHERE merchant_id = ? AND place_id = ?",
        (merchant_id, place_id),
    ).fetchone()
    if head is not None:
        return head

    owns_transaction = not conn.in_transaction
    if owns_transaction:
        conn.execute("BEGIN IMMEDIATE")
    try:
        head = conn.execute(
            "SELECT * FROM merchant_keyword_heads WHERE merchant_id = ? AND place_id = ?",
            (merchant_id, place_id),
        ).fetchone()
        if head is not None:
            if owns_transaction:
                conn.commit()
            return head

        candidates = _ready_keyword_artifact_candidates(conn, merchant_id, place_id)
        active_artifact_id = next(
            (
                row["id"]
                for row, keyword_set in candidates
                if keyword_set.get("generation_method")
                == "UPSTREAM_DETERMINISTIC_ADAPTER"
                and _has_deterministic_scored_local_cohort(keyword_set)
                and _keyword_artifact_paid_eligible(row, keyword_set, place_id)
            ),
            None,
        )
        timestamp = now_iso()
        activation_values = (
            ("system-bootstrap", "SYSTEM_BOOTSTRAP", timestamp)
            if active_artifact_id is not None
            else (None, None, None)
        )
        conn.execute(
            "INSERT INTO merchant_keyword_heads"
            " (merchant_id, place_id, active_artifact_id, activated_by, activation_reason,"
            " activated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (merchant_id, place_id, active_artifact_id, *activation_values, timestamp),
        )
        head = conn.execute(
            "SELECT * FROM merchant_keyword_heads WHERE merchant_id = ? AND place_id = ?",
            (merchant_id, place_id),
        ).fetchone()
        if owns_transaction:
            conn.commit()
        return head
    except Exception:
        if owns_transaction:
            conn.rollback()
        raise


def _move_keyword_head(
    conn: sqlite3.Connection,
    *,
    merchant_id: int,
    place_id: str,
    artifact_id: int,
    expected_active_artifact_id: int | None,
    activated_by: str,
    activation_reason: str,
) -> bool:
    if activation_reason not in {"SKILL_GENERATION", "RESTORE_SKILL", "ADOPT_FBR"}:
        raise ValueError("unsupported keyword activation reason")
    if not activated_by:
        raise ValueError("keyword activation actor is required")

    artifact = conn.execute(
        "SELECT * FROM merchant_seo_artifacts WHERE id = ?",
        (artifact_id,),
    ).fetchone()
    if (
        artifact is None
        or artifact["merchant_id"] != merchant_id
        or artifact["artifact_type"] != "KEYWORD_SET"
        or artifact["status"] != "ready"
        or _keyword_artifact_place_id(artifact) != place_id
    ):
        raise ValueError("keyword activation target is not a ready exact-place artifact")
    try:
        keyword_set = json.loads(artifact["payload_json"] or "null")
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("keyword activation target payload is invalid") from exc
    if not isinstance(keyword_set, dict):
        raise ValueError("keyword activation target payload is invalid")
    if activation_reason in {"SKILL_GENERATION", "RESTORE_SKILL"}:
        if (
            keyword_set.get("generation_method") != "UPSTREAM_DETERMINISTIC_ADAPTER"
            or not _keyword_artifact_paid_eligible(
                artifact,
                keyword_set,
                place_id,
            )
        ):
            raise ValueError("keyword activation target is not a verified scored Skill artifact")
    elif not _is_valid_fbr_keyword_artifact(artifact, keyword_set, place_id):
        raise ValueError("keyword activation target is not a trusted FBR artifact")

    timestamp = now_iso()
    return (
        conn.execute(
            "UPDATE merchant_keyword_heads"
            " SET active_artifact_id = ?, activated_by = ?, activation_reason = ?,"
            " activated_at = ?, updated_at = ?"
            " WHERE merchant_id = ? AND place_id = ? AND active_artifact_id IS ?",
            (
                artifact_id,
                activated_by,
                activation_reason,
                timestamp,
                timestamp,
                merchant_id,
                place_id,
                expected_active_artifact_id,
            ),
        ).rowcount
        == 1
    )


def _active_ready_keyword_artifact(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
) -> tuple[sqlite3.Row | None, dict | None]:
    head = conn.execute(
        "SELECT * FROM merchant_keyword_heads WHERE merchant_id = ? AND place_id = ?",
        (merchant_id, place_id),
    ).fetchone()
    if head is None or head["active_artifact_id"] is None:
        return None, None

    row = conn.execute(
        "SELECT artifact.* FROM merchant_keyword_heads AS head"
        " JOIN merchant_seo_artifacts AS artifact ON artifact.id = head.active_artifact_id"
        " WHERE head.merchant_id = ? AND head.place_id = ?",
        (merchant_id, place_id),
    ).fetchone()
    if (
        row is None
        or row["merchant_id"] != merchant_id
        or row["artifact_type"] != "KEYWORD_SET"
        or row["status"] != "ready"
        or _keyword_artifact_place_id(row) != place_id
    ):
        raise HTTPException(status_code=409, detail="active keyword artifact is invalid")
    try:
        keyword_set = json.loads(row["payload_json"])
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=409, detail="active keyword artifact is invalid") from exc
    if not isinstance(keyword_set, dict):
        raise HTTPException(status_code=409, detail="active keyword artifact is invalid")
    return row, keyword_set


def _keyword_version_source(keyword_set: dict) -> str | None:
    generation_method = keyword_set.get("generation_method")
    if generation_method == "UPSTREAM_DETERMINISTIC_ADAPTER":
        return "SKILL"
    if generation_method == "PERSISTED_FBR_READBACK":
        return "FBR"
    if generation_method is None:
        return None
    return "LEGACY"


def _keyword_score_status(
    row: sqlite3.Row,
    keyword_set: dict,
    place_id: str,
) -> str:
    if (
        _keyword_version_source(keyword_set) == "SKILL"
        and _keyword_artifact_paid_eligible(row, keyword_set, place_id)
    ):
        return "VERIFIED_SKILL"
    keywords = keyword_set.get("keywords")
    valid_keywords = (
        [item for item in keywords if isinstance(item, dict)]
        if isinstance(keywords, list)
        else []
    )
    scored_keyword_count = sum(
        _is_numeric_keyword_score(item.get("score")) for item in valid_keywords
    )
    if scored_keyword_count == 0:
        return "UNSCORED"
    if scored_keyword_count == len(valid_keywords):
        return "SCORED_UNVERIFIED"
    return "PARTIAL"


def _keyword_version_summaries(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
    active_artifact_id: int | None,
) -> list[dict]:
    summaries = []
    for row, keyword_set in _ready_keyword_artifact_candidates(
        conn, merchant_id, place_id
    ):
        keywords = keyword_set.get("keywords")
        valid_keywords = (
            [item for item in keywords if isinstance(item, dict)]
            if isinstance(keywords, list)
            else []
        )
        summaries.append(
            {
                "artifact_id": row["id"],
                "place_id": place_id,
                "source": _keyword_version_source(keyword_set),
                "generation_method": keyword_set.get("generation_method"),
                "keyword_count": len(valid_keywords),
                "local_keyword_count": sum(
                    item.get("strategy") == "LOCAL" for item in valid_keywords
                ),
                "organic_keyword_count": sum(
                    item.get("strategy") == "ORGANIC" for item in valid_keywords
                ),
                "scored_keyword_count": sum(
                    _is_numeric_keyword_score(item.get("score"))
                    for item in valid_keywords
                ),
                "score_status": _keyword_score_status(row, keyword_set, place_id),
                "completed_at": row["completed_at"],
                "is_active": row["id"] == active_artifact_id,
            }
        )
    return summaries


def _compare_fbr_local_candidate(
    active_keyword_set: dict | None,
    fbr_keyword_set: dict | None,
) -> dict:
    def local_keywords_by_identity(keyword_set: dict | None) -> dict[str, dict]:
        if not isinstance(keyword_set, dict):
            return {}
        keywords = keyword_set.get("keywords")
        if not isinstance(keywords, list):
            return {}
        by_identity: dict[str, dict] = {}
        for item in keywords:
            if (
                not isinstance(item, dict)
                or item.get("strategy") != "LOCAL"
                or not isinstance(item.get("keyword"), str)
                or not item["keyword"].strip()
            ):
                continue
            identity = _keyword_identity(item["keyword"])
            by_identity.setdefault(identity, item)
        return by_identity

    def normalized_surfaces(item: dict) -> list[str]:
        values = item.get("target_surface_types")
        if not isinstance(values, list):
            return []
        return sorted({value for value in values if isinstance(value, str)})

    active = local_keywords_by_identity(active_keyword_set)
    fbr = local_keywords_by_identity(fbr_keyword_set)
    active_keys = set(active)
    fbr_keys = set(fbr)
    changed_keywords = []
    priority_changed_count = 0
    target_surfaces_changed_count = 0
    for keyword in sorted(active_keys & fbr_keys):
        priority = None
        if active[keyword].get("priority") != fbr[keyword].get("priority"):
            priority = {
                "active": active[keyword].get("priority"),
                "fbr": fbr[keyword].get("priority"),
            }
            priority_changed_count += 1
        target_surfaces = None
        active_surfaces = normalized_surfaces(active[keyword])
        fbr_surfaces = normalized_surfaces(fbr[keyword])
        if active_surfaces != fbr_surfaces:
            target_surfaces = {"active": active_surfaces, "fbr": fbr_surfaces}
            target_surfaces_changed_count += 1
        if priority is not None or target_surfaces is not None:
            changed_keywords.append(
                {
                    "keyword": keyword,
                    "priority": priority,
                    "target_surfaces": target_surfaces,
                }
            )
    return {
        "active_local_count": len(active),
        "fbr_local_count": len(fbr),
        "added_count": len(fbr_keys - active_keys),
        "removed_count": len(active_keys - fbr_keys),
        "priority_changed_count": priority_changed_count,
        "target_surfaces_changed_count": target_surfaces_changed_count,
        "added_keywords": sorted(fbr_keys - active_keys),
        "removed_keywords": sorted(active_keys - fbr_keys),
        "changed_keywords": changed_keywords,
    }


def _latest_fbr_keyword_import(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
) -> tuple[sqlite3.Row | None, dict | None]:
    for row, keyword_set in _ready_keyword_artifact_candidates(
        conn, merchant_id, place_id
    ):
        if _is_valid_fbr_keyword_artifact(row, keyword_set, place_id):
            return row, keyword_set
    return None, None


def _latest_fbr_import_state(
    row: sqlite3.Row | None,
    keyword_set: dict | None,
    active_keyword_set: dict | None,
    active_artifact_id: int | None,
) -> dict | None:
    if row is None or keyword_set is None:
        return None
    return {
        "artifact_id": row["id"],
        "imported_at": row["completed_at"],
        "is_active": row["id"] == active_artifact_id,
        "comparison": _compare_fbr_local_candidate(active_keyword_set, keyword_set),
    }


def _ready_keyword_artifact_for_another_place(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
) -> sqlite3.Row | None:
    rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'ready'"
        " AND payload_json IS NOT NULL ORDER BY id DESC",
        (merchant_id,),
    ).fetchall()
    for row in rows:
        if _keyword_artifact_place_id(row) == place_id:
            continue
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            return row
    return None


def _local_falcon_cohort(keyword_set: dict | None) -> list[dict]:
    if (
        not keyword_set
        or keyword_set.get("generation_method") not in LOCAL_FALCON_PAID_KEYWORD_METHODS
    ):
        return []
    cohort = [
        item
        for item in keyword_set.get("keywords", [])
        if item.get("strategy") == "LOCAL"
        and item.get("local_falcon_selected") is True
        and _is_numeric_keyword_score(item.get("score"))
        and isinstance(item.get("score_rank"), int)
        and 1 <= item["score_rank"] <= LOCAL_FALCON_KEYWORD_LIMIT
    ]
    unique = []
    seen = set()
    for item in sorted(cohort, key=lambda value: value["score_rank"]):
        keyword = item.get("keyword")
        if not isinstance(keyword, str) or not keyword.strip():
            continue
        key = _keyword_identity(keyword)
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    return unique[:LOCAL_FALCON_KEYWORD_LIMIT]


def _local_falcon_cohort_snapshot(keyword_set: dict | None) -> list[dict]:
    return [
        {
            "keyword": item["keyword"].strip(),
            "score": item["score"],
            "score_rank": item["score_rank"],
        }
        for item in _local_falcon_cohort(keyword_set)
    ]


def _local_falcon_cohort_sha256(keyword_set: dict | None) -> str | None:
    cohort = _local_falcon_cohort_snapshot(keyword_set)
    if not cohort:
        return None
    identity_cohort = [
        {
            "keyword": _keyword_identity(item["keyword"]),
            "score": item["score"],
            "score_rank": item["score_rank"],
        }
        for item in cohort
    ]
    canonical = json.dumps(
        identity_cohort,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _fbr_local_keyword_set(merchant: sqlite3.Row, location: dict, payload: dict) -> dict | None:
    place_id = location.get("place_id")
    if payload.get("place_id") != place_id:
        raise FbrPayloadError("FBR persisted keyword Place ID does not match the selected GBP location")
    groups = payload.get("local_keywords")
    if not isinstance(groups, list) or any(not isinstance(group, dict) for group in groups):
        raise FbrPayloadError("FBR persisted local keyword list is invalid")

    keyword_order: list[str] = []
    selected_keywords: dict[str, dict] = {}
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
            key = _keyword_identity(keyword)
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
            score = item.get("score")
            if score is not None and not _is_numeric_keyword_score(score):
                raise FbrPayloadError("FBR persisted keyword score is invalid")
            candidate = {
                "keyword": keyword,
                "strategy": "LOCAL",
                "intent": "NEAR_ME" if "near me" in key else "LOCAL",
                "priority": priority,
                "score": score,
                "score_rank": None,
                "local_falcon_selected": False,
                "rationale": "Read from the persisted FBR local keyword repository for this GBP Place ID.",
                "source_tags": source_tags,
                "target_surface_types": surfaces,
                "target_location": location.get("address") or location.get("title"),
            }
            previous = selected_keywords.get(key)
            if previous is None:
                keyword_order.append(key)
                selected_keywords[key] = candidate
                continue
            previous_score = previous.get("score")
            # A scored record is stronger than a missing score, and conflicting
            # scores resolve to the highest valid value. Equal scores keep the
            # earliest display spelling and source metadata. The identity's
            # original position is retained so equal-score ranking stays stable.
            if score is not None and (
                previous_score is None or score > previous_score
            ):
                selected_keywords[key] = candidate
    keywords = [selected_keywords[key] for key in keyword_order]
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
    result = _rank_keyword_scores(result)
    return KeywordSetV2.model_validate(result).model_dump(mode="json")


def _persist_fbr_keyword_set(
    conn: sqlite3.Connection,
    artifact_id: int,
    place_id: str,
    keyword_set: dict,
) -> str:
    synced_at = now_iso()
    updated = conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET status = 'ready', source_agent_id = 'fbr-keyword-store',"
        " dispatch_state = 'not_required',"
        " request_json = ?, payload_json = ?, error = NULL, completed_at = ?"
        " WHERE id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'running'",
        (
            json.dumps(
                {"source": "FBR_KEYWORD_STORE", "place_id": place_id},
                ensure_ascii=False,
            ),
            json.dumps(keyword_set, ensure_ascii=False),
            synced_at,
            artifact_id,
        ),
    ).rowcount
    if updated != 1:
        conn.rollback()
        raise HTTPException(status_code=409, detail="keyword refresh claim is no longer active")
    row = conn.execute(
        "SELECT cycle_id FROM merchant_seo_artifacts WHERE id = ?",
        (artifact_id,),
    ).fetchone()
    conn.commit()
    return row["cycle_id"]


def _claim_keyword_cycle(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
    operation: Literal["refresh", "regenerate"],
) -> tuple[int, str, dict, str]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        unresolved = _unresolved_local_falcon_batch(conn, merchant["id"])
        if unresolved is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Local Falcon scan batch {unresolved['id']} is unresolved; "
                    "sync or reconcile it before changing keywords"
                ),
            )
        if conn.execute(
            "SELECT 1 FROM merchant_seo_artifacts"
            " WHERE merchant_id = ? AND status = 'running' LIMIT 1",
            (merchant["id"],),
        ).fetchone():
            raise HTTPException(status_code=409, detail="SEO target refresh already running")
        location = _location_context(conn, merchant)
        place_id = location.get("place_id")
        if not place_id:
            raise HTTPException(
                status_code=409,
                detail="GBP Place ID is required for keyword lookup",
            )
        expected_active_artifact_id = None
        if operation == "regenerate":
            keyword_head = _ensure_keyword_head(conn, merchant["id"], place_id)
            expected_active_artifact_id = keyword_head["active_artifact_id"]
        cycle_id = str(uuid4())
        claim_request = {
            "operation": operation,
            "place_id": place_id,
            "claim_id": cycle_id,
        }
        if operation == "regenerate":
            claim_request["expected_active_artifact_id"] = (
                expected_active_artifact_id
            )
        cursor = conn.execute(
            "INSERT INTO merchant_seo_artifacts"
            " (merchant_id, cycle_id, artifact_type, schema_version, status, source_agent_id,"
            " dispatch_state, dispatch_started_at, request_json, created_at)"
            " VALUES (?, ?, 'KEYWORD_SET', 'seo_ops.keyword_set.v2', 'running', ?,"
            " 'pending', ?, ?, ?)",
            (
                merchant["id"],
                cycle_id,
                "fbr-keyword-store" if operation == "refresh" else "keyword-skill-workflow",
                now_iso(),
                json.dumps(claim_request, ensure_ascii=False),
                now_iso(),
            ),
        )
    except Exception:
        conn.rollback()
        raise
    conn.commit()
    return cursor.lastrowid, cycle_id, location, place_id


def _fail_keyword_claim(
    conn: sqlite3.Connection,
    artifact_id: int,
    error: str,
) -> None:
    conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET status = 'failed', error = ?, completed_at = ?"
        " WHERE id = ? AND status = 'running'",
        (error[:500], now_iso(), artifact_id),
    )
    conn.commit()


def _fail_keyword_dispatch_unknown(
    conn: sqlite3.Connection,
    artifact_id: int,
    error: str,
) -> None:
    conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET status = 'failed', dispatch_state = 'unknown', error = ?, completed_at = ?"
        " WHERE id = ? AND status = 'running' AND coreai_run_id IS NULL",
        (error[:500], now_iso(), artifact_id),
    )
    conn.commit()


def _start_keyword_skill_cycle(
    conn: sqlite3.Connection,
    merchant: sqlite3.Row,
    client: CoreAiClient,
    workflow: KeywordSkillWorkflow,
    artifact_id: int,
    cycle_id: str,
) -> str:
    try:
        agent = client.get_agent(workflow.agent_id)
        seed_skill = client.get_skill(workflow.seed_skill_id)
        ranking_skill = client.get_skill(workflow.ranking_skill_id)
    except CoreAiError as exc:
        _fail_keyword_claim(conn, artifact_id, str(exc))
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    bound_skill_ids = agent.get("skill_ids", agent.get("skillIds"))
    if not isinstance(bound_skill_ids, list):
        bound_skill_ids = []
    bound_skill_ids = {
        item.get("id") if isinstance(item, dict) else item
        for item in bound_skill_ids
    }
    if not {workflow.seed_skill_id, workflow.ranking_skill_id}.issubset(bound_skill_ids):
        detail = (
            "keyword Skill Agent is not bound to both configured Seed and Ranking Skills"
        )
        _fail_keyword_claim(conn, artifact_id, detail)
        raise HTTPException(status_code=409, detail=detail)
    if seed_skill["qualified_name"] == ranking_skill["qualified_name"]:
        _fail_keyword_claim(
            conn,
            artifact_id,
            "configured keyword Seed and Ranking Skills must be distinct",
        )
        raise HTTPException(
            status_code=409,
            detail="configured keyword Seed and Ranking Skills must be distinct",
        )

    claim = conn.execute(
        "SELECT request_json FROM merchant_seo_artifacts"
        " WHERE id = ? AND cycle_id = ? AND status = 'running'",
        (artifact_id, cycle_id),
    ).fetchone()
    try:
        claim_request = json.loads(claim["request_json"] if claim is not None else "null")
    except (TypeError, json.JSONDecodeError) as exc:
        _fail_keyword_claim(conn, artifact_id, "keyword workflow claim is invalid")
        raise HTTPException(status_code=409, detail="keyword workflow claim is invalid") from exc
    if not isinstance(claim_request, dict) or "expected_active_artifact_id" not in claim_request:
        _fail_keyword_claim(conn, artifact_id, "keyword workflow claim is invalid")
        raise HTTPException(status_code=409, detail="keyword workflow claim is invalid")

    request = build_keyword_request(conn, merchant)
    request["expected_active_artifact_id"] = claim_request[
        "expected_active_artifact_id"
    ]
    request["execution_spec"]["action"] = "REGENERATE_KEYWORD_SET_WITH_SKILLS"
    request["output_schema_version"] = "seo_ops.keyword_workflow_result.v1"
    request["workflow"] = {
        "seed_skill_id": workflow.seed_skill_id,
        "ranking_skill_id": workflow.ranking_skill_id,
        "seed_skill": {
            "id": seed_skill["id"],
            "qualified_name": seed_skill["qualified_name"],
            "version": seed_skill.get("version"),
            "updated_at": seed_skill.get("updated_at"),
        },
        "ranking_skill": {
            "id": ranking_skill["id"],
            "qualified_name": ranking_skill["qualified_name"],
            "version": ranking_skill.get("version"),
            "updated_at": ranking_skill.get("updated_at"),
        },
        "stages": ["SEED", "RANK_AND_PRIORITIZE"],
        "result_schema_version": "seo_ops.keyword_workflow_result.v1",
        "ranking_output_contract": _ranking_output_contract(),
    }
    request["rules"].extend(
        [
            "load_the_configured_seed_skill_instructions_first",
            "record_the_agent_seed_output_in_seed_output",
            "copy_seed_output_exactly_to_ranking_input_before_loading_ranking_skill_instructions",
            "record_the_final_ranked_keyword_set_in_ranking_output",
            "do_not_wrap_json_in_markdown_code_fences",
            "do_not_substitute_ad_hoc_mcp_research_for_either_skill",
        ]
    )
    dispatch_started_at = now_iso()
    marked_dispatching = conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET source_agent_id = ?, dispatch_state = 'dispatching',"
        " dispatch_started_at = ?, request_json = ?, error = NULL"
        " WHERE id = ? AND cycle_id = ? AND status = 'running'"
        " AND coreai_run_id IS NULL AND dispatch_state = 'pending'",
        (
            workflow.agent_id,
            dispatch_started_at,
            json.dumps(request, ensure_ascii=False),
            artifact_id,
            cycle_id,
        ),
    ).rowcount
    if marked_dispatching != 1:
        conn.rollback()
        raise HTTPException(status_code=409, detail="keyword refresh claim is no longer active")
    conn.commit()
    try:
        triggered = client.trigger(workflow.agent_id, json.dumps(request, ensure_ascii=False))
    except CoreAiError as exc:
        _fail_keyword_dispatch_unknown(
            conn,
            artifact_id,
            (
                "keyword Skill dispatch failed before a Core AI run ID was persisted; "
                "the dispatch outcome is unknown. Verify Core AI run history before "
                f"manually retrying: {str(exc)}"
            ),
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    updated = conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET source_agent_id = ?, coreai_run_id = ?, dispatch_state = 'dispatched',"
        " request_json = ?, error = NULL"
        " WHERE id = ? AND cycle_id = ? AND status = 'running'"
        " AND coreai_run_id IS NULL AND dispatch_state = 'dispatching'",
        (
            workflow.agent_id,
            triggered["run_id"],
            json.dumps(request, ensure_ascii=False),
            artifact_id,
            cycle_id,
        ),
    ).rowcount
    if updated != 1:
        conn.rollback()
        raise HTTPException(status_code=409, detail="keyword refresh claim is no longer active")
    conn.commit()
    return cycle_id


def _mark_stale_keyword_dispatches_unknown(conn: sqlite3.Connection) -> None:
    cutoff = (datetime.now(timezone.utc) - KEYWORD_DISPATCH_STALE_AFTER).isoformat()
    error = (
        "keyword Skill dispatch stopped before a Core AI run ID was persisted; "
        "the dispatch outcome is unknown. Verify Core AI run history before manually retrying"
    )
    conn.execute(
        "UPDATE merchant_seo_artifacts"
        " SET status = 'failed', dispatch_state = 'unknown', error = ?, completed_at = ?"
        " WHERE artifact_type = 'KEYWORD_SET' AND status = 'running'"
        " AND coreai_run_id IS NULL AND dispatch_state IN ('pending', 'dispatching')"
        " AND COALESCE(dispatch_started_at, created_at) < ?",
        (error, now_iso(), cutoff),
    )


def _parse_json_object(raw: object, label: str) -> dict:
    value = raw
    if isinstance(raw, str):
        stripped = raw.strip()
        lines = stripped.splitlines()
        if (
            len(lines) >= 3
            and lines[0].strip().lower() in {"```", "```json"}
            and lines[-1].strip() == "```"
        ):
            candidate = "\n".join(lines[1:-1]).strip()
            if "```" not in candidate:
                stripped = candidate
        try:
            value = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{label} must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _parse_keyword_set(raw: object, merchant_id: int) -> dict:
    report = KeywordSetV2.model_validate(_parse_json_object(raw, "keyword result"))
    if report.merchant_id != str(merchant_id):
        raise ValueError("keyword merchant_id does not match the run merchant")
    seen = set()
    for item in report.keywords:
        item.keyword = item.keyword.strip()
        key = _keyword_identity(item.keyword)
        if key in seen:
            raise ValueError("keyword result contains a semantic duplicate keyword")
        seen.add(key)
    if report.generation_method == "EVIDENCE_BOUNDED_RESEARCH":
        if any(
            item.priority != "UNSCORED"
            or item.score is not None
            or item.score_rank is not None
            or item.local_falcon_selected
            for item in report.keywords
        ):
            raise ValueError("evidence-bounded keywords must remain fully UNSCORED")
    return _rank_keyword_scores(report.model_dump(mode="json"))


def _adapt_ranking_skill_hybrid_output(
    raw: dict,
    merchant_id: int,
    expected_place_id: str,
    expected_location_name: str,
) -> dict:
    """Convert only the exact observed UAT hybrid shape into KeywordSetV2."""
    source = RankingSkillHybridOutputV1.model_validate(raw)
    if source.merchant_id != str(merchant_id):
        raise ValueError("keyword merchant_id does not match the run merchant")
    if source.location.external_identities.google_business != expected_place_id:
        raise ValueError("keyword Google Business identity does not match the run request")
    if source.location.display_name != expected_location_name:
        raise ValueError("keyword location name does not match the run request")

    keywords = []
    for source_item in source.keywords:
        item = source_item.model_dump(mode="json")
        identity = _keyword_identity(source_item.keyword)
        if source_item.intent == "navigational":
            intent = "BRAND"
        elif "near me" in identity:
            intent = "NEAR_ME"
        elif source_item.strategy == "LOCAL":
            intent = "LOCAL"
        else:
            intent = "ORGANIC"
        item["intent"] = intent
        keywords.append(item)

    return {
        "schema_version": "seo_ops.keyword_set.v2",
        "merchant_id": source.merchant_id,
        "market": {
            **source.market.model_dump(mode="json"),
            "location_name": source.location.display_name,
        },
        "generation_method": "UPSTREAM_DETERMINISTIC_ADAPTER",
        "title": f"Merchant {merchant_id} Skill-ranked keyword set",
        "summary": (
            f"Accepted {len(keywords)} scored keywords from the configured Seed and "
            "Ranking Skill workflow through a deterministic SEO Ops adapter."
        ),
        "keywords": keywords,
        "evidence_gaps": [
            "The Ranking Skill source shape does not declare evidence gaps; "
            "SEO Ops applied its versioned deterministic adapter."
        ],
    }


def _adapt_ranking_skill_keyword_set_output(
    raw: dict,
    expected_location_name: str,
) -> dict:
    """Normalize only the exact near-canonical shape observed from UAT."""
    expected_keys = {
        "schema_version",
        "merchant_id",
        "market",
        "generation_method",
        "title",
        "summary",
        "keywords",
        "evidence_gaps",
    }
    if set(raw) != expected_keys or raw.get("schema_version") != "seo_ops.keyword_set.v2":
        raise ValueError("ranking output is not the observed keyword-set variant")
    market = raw.get("market")
    if not isinstance(market, dict) or set(market) != {
        "country_code",
        "language",
        "search_engine",
    }:
        raise ValueError("ranking output market is not the observed keyword-set variant")
    keywords = raw.get("keywords")
    if not isinstance(keywords, list) or not keywords:
        raise ValueError("ranking output keywords are not the observed keyword-set variant")
    if any(
        not isinstance(item, dict) or item.get("strategy") not in {"local", "organic"}
        for item in keywords
    ):
        raise ValueError("ranking output strategy is not the observed keyword-set variant")

    candidate = {
        **raw,
        "market": {**market, "location_name": expected_location_name},
        "keywords": [
            {**item, "strategy": item["strategy"].upper()} for item in keywords
        ],
    }
    return KeywordSetV2.model_validate(candidate).model_dump(mode="json")


def _normalize_workflow_ranking_output(
    raw: dict,
    merchant_id: int,
    expected_place_id: str,
    expected_location_name: str,
) -> tuple[dict, str | None]:
    try:
        direct = KeywordSetV2.model_validate(raw)
    except ValidationError:
        try:
            return (
                _adapt_ranking_skill_keyword_set_output(
                    raw,
                    expected_location_name,
                ),
                RANKING_SKILL_KEYWORD_SET_ADAPTER_VERSION,
            )
        except (ValidationError, ValueError):
            return (
                _adapt_ranking_skill_hybrid_output(
                    raw,
                    merchant_id,
                    expected_place_id,
                    expected_location_name,
                ),
                RANKING_SKILL_OUTPUT_ADAPTER_VERSION,
            )
    if direct.market.location_name != expected_location_name:
        raise ValueError("keyword location name does not match the run request")
    return direct.model_dump(mode="json"), None


def _parse_keyword_workflow_result(
    raw: object,
    merchant_id: int,
    expected_place_id: str,
    expected_location_name: str,
) -> tuple[dict, dict]:
    envelope = KeywordWorkflowResultV1.model_validate(
        _parse_json_object(raw, "keyword workflow result")
    )
    seed_output = envelope.seed_output
    ranking_input = envelope.ranking_input
    if seed_output.get("place_id") != expected_place_id:
        raise ValueError("keyword Seed output Google Business identity does not match the run request")
    seed_output_sha256 = _sha256_json(seed_output)
    ranking_input_sha256 = _sha256_json(ranking_input)
    if seed_output_sha256 != ranking_input_sha256:
        raise ValueError("keyword workflow ranking_input must exactly match seed_output")

    ranking_output = envelope.ranking_output
    ranking_output_sha256 = _sha256_json(ranking_output)
    adapter_output, adapter_version = _normalize_workflow_ranking_output(
        ranking_output,
        merchant_id,
        expected_place_id,
        expected_location_name,
    )
    adapter_output_sha256 = _sha256_json(adapter_output)
    artifact = _parse_keyword_set(adapter_output, merchant_id)
    artifact_sha256 = _sha256_json(artifact)
    if adapter_output_sha256 != artifact_sha256:
        raise ValueError(
            "keyword workflow ranking_output must be the final accepted KeywordSetV2"
        )
    if artifact.get("generation_method") != "UPSTREAM_DETERMINISTIC_ADAPTER":
        raise ValueError(
            "keyword workflow ranking_output must use UPSTREAM_DETERMINISTIC_ADAPTER"
        )
    return artifact, {
        "schema_version": "seo_ops.keyword_workflow_lineage.v2",
        "seed_output_sha256": seed_output_sha256,
        "source_seed_output": seed_output,
        "ranking_input_sha256": ranking_input_sha256,
        "ranking_output_sha256": ranking_output_sha256,
        "source_ranking_output": ranking_output,
        "adapter_version": adapter_version,
        "adapter_output_sha256": adapter_output_sha256,
        "artifact_sha256": artifact_sha256,
    }


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
        # A process can stop after claiming or remotely dispatching a keyword
        # cycle but before persisting Core AI's run ID. Never guess that the
        # remote call was absent and never auto-retry it: expire the local lock
        # into an explicit unknown outcome so an operator can verify Core AI
        # and then choose whether to submit a fresh regeneration.
        _mark_stale_keyword_dispatches_unknown(conn)
        conn.commit()
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

            request = None
            requires_skill_provenance = False
            workflow_lineage = None
            if row["artifact_type"] == "KEYWORD_SET":
                try:
                    request = json.loads(row["request_json"])
                except (TypeError, json.JSONDecodeError):
                    request = None
                requires_skill_provenance = bool(
                    isinstance(request, dict)
                    and isinstance(request.get("execution_spec"), dict)
                    and request["execution_spec"].get("action")
                    == "REGENERATE_KEYWORD_SET_WITH_SKILLS"
                )

            try:
                if row["artifact_type"] == "KEYWORD_SET":
                    if requires_skill_provenance:
                        expected_place_id = request["execution_spec"].get(
                            "google_business_id"
                        )
                        expected_location_name = request["execution_spec"].get(
                            "display_name"
                        )
                        if not isinstance(expected_place_id, str) or not expected_place_id:
                            raise ValueError(
                                "keyword workflow request Google Business identity is missing"
                            )
                        if (
                            not isinstance(expected_location_name, str)
                            or not expected_location_name
                        ):
                            raise ValueError(
                                "keyword workflow request location name is missing"
                            )
                        payload, workflow_lineage = _parse_keyword_workflow_result(
                            core.get("output"),
                            row["merchant_id"],
                            expected_place_id,
                            expected_location_name,
                        )
                    else:
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

            provenance = None
            if row["artifact_type"] == "KEYWORD_SET":
                if requires_skill_provenance:
                    try:
                        provenance = _verify_keyword_skill_provenance(
                            client,
                            core=core,
                            request=request,
                            source_agent_id=row["source_agent_id"],
                            run_id=row["coreai_run_id"],
                            payload=payload,
                            lineage=workflow_lineage,
                        )
                    except KeywordSkillProvenancePending as exc:
                        now = datetime.now(timezone.utc)
                        verification_started_at = row["verification_started_at"]
                        if not verification_started_at:
                            conn.execute(
                                "UPDATE merchant_seo_artifacts"
                                " SET verification_started_at = ?, error = ? WHERE id = ?",
                                (now.isoformat(), str(exc)[:500], row["id"]),
                            )
                            conn.commit()
                            continue
                        try:
                            started = datetime.fromisoformat(verification_started_at)
                        except (TypeError, ValueError):
                            started = now - KEYWORD_SKILL_PROVENANCE_WAIT
                        if started.tzinfo is None:
                            started = started.replace(tzinfo=timezone.utc)
                        if now - started < KEYWORD_SKILL_PROVENANCE_WAIT:
                            conn.execute(
                                "UPDATE merchant_seo_artifacts SET error = ? WHERE id = ?",
                                (str(exc)[:500], row["id"]),
                            )
                            conn.commit()
                            continue
                        conn.execute(
                            "UPDATE merchant_seo_artifacts"
                            " SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
                            (
                                (
                                    "keyword Skill instruction-load verification timed out: "
                                    f"{str(exc)}"
                                )[:500],
                                finished_at,
                                row["id"],
                            ),
                        )
                        conn.commit()
                        continue
                    except ValueError as exc:
                        conn.execute(
                            "UPDATE merchant_seo_artifacts"
                            " SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
                            (str(exc)[:500], finished_at, row["id"]),
                        )
                        conn.commit()
                        continue
                    expected_active_artifact_id = request.get(
                        "expected_active_artifact_id"
                    )
                    if (
                        "expected_active_artifact_id" not in request
                        or isinstance(expected_active_artifact_id, bool)
                        or (
                            expected_active_artifact_id is not None
                            and not isinstance(expected_active_artifact_id, int)
                        )
                    ):
                        conn.execute(
                            "UPDATE merchant_seo_artifacts"
                            " SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
                            (
                                "keyword workflow expected active artifact is invalid",
                                finished_at,
                                row["id"],
                            ),
                        )
                        conn.commit()
                        continue
                    if not _has_deterministic_scored_local_cohort(payload):
                        conn.execute(
                            "UPDATE merchant_seo_artifacts"
                            " SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
                            (
                                "keyword Skill result is missing complete deterministic scores and ranks",
                                finished_at,
                                row["id"],
                            ),
                        )
                        conn.commit()
                        continue

            updated = conn.execute(
                "UPDATE merchant_seo_artifacts"
                " SET status = 'ready', payload_json = ?, provenance_json = ?,"
                " error = NULL, completed_at = ?"
                " WHERE id = ? AND status = 'running'",
                (
                    json.dumps(payload, ensure_ascii=False),
                    json.dumps(provenance, ensure_ascii=False) if provenance else None,
                    finished_at,
                    row["id"],
                ),
            ).rowcount
            if updated != 1:
                conn.rollback()
                continue
            # Explicit keyword regeneration is a self-contained workflow. Once
            # its Seed + Ranking Skill trace is attested, expose the scored
            # cohort for approval; do not silently launch audit/ranking Agents.
            if row["artifact_type"] == "KEYWORD_SET" and requires_skill_provenance:
                activated = _move_keyword_head(
                    conn,
                    merchant_id=row["merchant_id"],
                    place_id=request["execution_spec"]["google_business_id"],
                    artifact_id=row["id"],
                    expected_active_artifact_id=expected_active_artifact_id,
                    activated_by="system-skill-workflow",
                    activation_reason="SKILL_GENERATION",
                )
                if not activated:
                    conn.execute(
                        "UPDATE merchant_seo_artifacts SET error = ? WHERE id = ?",
                        (
                            "keyword activation conflict: active version changed while "
                            "Skill generation was running",
                            row["id"],
                        ),
                    )
                conn.commit()
                continue
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
            if not next_agent:
                _insert_failed_artifact(
                    conn,
                    merchant_id=row["merchant_id"],
                    cycle_id=row["cycle_id"],
                    artifact_type=next_type,
                    schema_version=next_schema,
                    agent_id="unconfigured",
                    request=next_request,
                    error=f"{next_type} Agent is not configured",
                )
                conn.commit()
                continue
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


def _local_falcon_scan_defaults(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str | None,
) -> dict | None:
    if not place_id:
        return None
    row = conn.execute(
        "SELECT place_id, center_lat, center_lng, grid_size, radius, measurement"
        " FROM merchant_local_falcon_reports WHERE merchant_id = ? AND place_id = ?"
        " ORDER BY captured_at DESC, id DESC LIMIT 1",
        (merchant_id, place_id),
    ).fetchone()
    if row is None:
        return None
    return {
        "place_id": row["place_id"],
        "lat": row["center_lat"],
        "lng": row["center_lng"],
        "grid_size": row["grid_size"],
        "radius": row["radius"],
        "measurement": row["measurement"],
        "platform": "google",
    }


def _local_falcon_scan_config_sha256(scan_config: dict | None) -> str | None:
    if scan_config is None:
        return None
    canonical = json.dumps(
        scan_config,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _local_falcon_approval_json(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {
        "id": row["id"],
        "keyword_artifact_id": row["keyword_artifact_id"],
        "cohort_sha256": row["cohort_sha256"],
        "cohort": json.loads(row["cohort_json"]),
        "place_id": row["place_id"],
        "approved_by": row["approved_by"],
        "approved_at": row["approved_at"],
    }


def _local_falcon_scan_batch_json(
    conn: sqlite3.Connection,
    row: sqlite3.Row | None,
) -> dict | None:
    if row is None:
        return None
    item_rows = conn.execute(
        "SELECT keyword, status, ack_report_key, error, updated_at"
        " FROM merchant_local_falcon_scan_items"
        " WHERE batch_id = ? ORDER BY id",
        (row["id"],),
    ).fetchall()
    counts = {
        status_name: sum(1 for item in item_rows if item["status"] == status_name)
        for status_name in ("pending", "submitting", "submitted", "completed", "failed", "unknown")
    }
    unclaimed_queued_batch = (
        row["status"] == "submitting"
        and row["dispatch_token"] is None
        and row["dispatch_started_at"] is None
        and bool(item_rows)
        and counts["pending"] == len(item_rows)
        and all(item["ack_report_key"] is None for item in item_rows)
    )
    no_accepted_items = (
        counts["submitting"] == 0
        and counts["submitted"] == 0
        and counts["completed"] == 0
        and all(item["ack_report_key"] is None for item in item_rows)
    )
    can_confirm_not_submitted = (
        unclaimed_queued_batch
        or (
            row["status"] in {"unknown", "partial"}
            and no_accepted_items
            and counts["pending"] + counts["unknown"] == len(item_rows)
        )
    )
    return {
        "id": row["id"],
        "approval_id": row["approval_id"],
        "confirmation_id": row["confirmation_id"],
        "request_id": row["request_id"],
        "status": row["status"],
        "scan_config": json.loads(row["scan_config_json"]),
        "scan_config_sha256": _local_falcon_scan_config_sha256(
            json.loads(row["scan_config_json"])
        ),
        "total_count": len(item_rows),
        "pending_count": counts["pending"],
        "submitting_count": counts["submitting"],
        "submitted_count": counts["submitted"],
        "completed_count": counts["completed"],
        "unknown_count": counts["unknown"],
        "failed_count": counts["failed"],
        "needs_reconciliation": row["status"] in {"partial", "unknown"},
        "can_confirm_not_submitted": can_confirm_not_submitted,
        # Local Falcon's current report payload exposes a wall-clock value but
        # no verifiable timezone or submission correlation id. Keep the manual
        # bind endpoint as a guarded future capability, but do not advertise it
        # to operators until the upstream contract can prove batch ownership.
        "can_bind_acknowledged_report": False,
        "report_binding_blocker": (
            "Local Falcon 当前未返回可验证的提交时间或关联 ID，"
            "无法安全确认报告属于本批次。"
        ),
        "items": [
            {
                "keyword": item["keyword"],
                "status": item["status"],
                "report_key": item["ack_report_key"],
                "error": item["error"],
                "updated_at": item["updated_at"],
            }
            for item in item_rows
        ],
        "error": row["error"],
        "created_at": row["created_at"],
        "completed_at": row["completed_at"],
    }


def _local_falcon_state(
    conn: sqlite3.Connection,
    merchant_id: int,
    keyword_set: dict | None,
    keyword_artifact_id: int | None = None,
    current_place_id: str | None = None,
    paid_eligible: bool = False,
) -> dict:
    sync = conn.execute(
        "SELECT * FROM merchant_local_falcon_syncs WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    visible_cohort = _local_falcon_cohort(keyword_set)
    cohort_sha256 = _local_falcon_cohort_sha256(keyword_set) if paid_eligible else None
    sync_is_current = bool(
        sync is not None
        and current_place_id
        and sync["place_id"] == current_place_id
        and sync["keyword_artifact_id"] == keyword_artifact_id
        and sync["cohort_sha256"] == cohort_sha256
    )
    visible_items = visible_cohort or [
        item
        for item in (keyword_set or {}).get("keywords", [])
        if item.get("strategy") == "LOCAL"
    ]
    accepted = {
        _keyword_identity(item["keyword"])
        for item in visible_items
        if isinstance(item.get("keyword"), str) and item["keyword"].strip()
    }
    rows = conn.execute(
        "SELECT * FROM merchant_local_falcon_reports"
        " WHERE merchant_id = ? AND place_id = ? ORDER BY captured_at DESC, id DESC",
        (merchant_id, current_place_id),
    ).fetchall()
    reports = []
    seen = set()
    for row in rows:
        key = _keyword_identity(row["keyword"])
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
    approval = None
    if (
        keyword_artifact_id is not None
        and cohort_sha256 is not None
        and current_place_id is not None
    ):
        approval = conn.execute(
            "SELECT * FROM merchant_local_falcon_approvals"
            " WHERE merchant_id = ? AND keyword_artifact_id = ? AND cohort_sha256 = ?"
            " AND place_id = ?"
            " ORDER BY id DESC LIMIT 1",
            (merchant_id, keyword_artifact_id, cohort_sha256, current_place_id),
        ).fetchone()
    scan_batch = _unresolved_local_falcon_batch(conn, merchant_id)
    if scan_batch is None and approval is not None:
        scan_batch = conn.execute(
            "SELECT * FROM merchant_local_falcon_scan_batches"
            " WHERE merchant_id = ? AND approval_id = ? ORDER BY id DESC LIMIT 1",
            (merchant_id, approval["id"]),
        ).fetchone()
    scan_defaults = _local_falcon_scan_defaults(conn, merchant_id, current_place_id)
    return {
        "current_place_id": current_place_id,
        "status": sync["status"] if sync_is_current else "not_synced",
        "last_synced_at": sync["last_synced_at"] if sync_is_current else None,
        "last_error": sync["last_error"] if sync_is_current else None,
        "missing_keywords": (
            json.loads(sync["missing_keywords_json"]) if sync_is_current else []
        ),
        "reports": reports,
        "scan_defaults": scan_defaults,
        "scan_defaults_sha256": _local_falcon_scan_config_sha256(scan_defaults),
        "approval": _local_falcon_approval_json(approval),
        "scan_batch": _local_falcon_scan_batch_json(conn, scan_batch),
    }


def _public_seo_artifact_error(row: sqlite3.Row | None) -> str | None:
    if row is None or not row["error"]:
        return None
    error = str(row["error"])
    incompatible_keyword_contract = (
        "validation error" in error
        and any(
            model_name in error
            for model_name in (
                "KeywordWorkflowResultV1",
                "RankingSkillHybridOutputV1",
                "KeywordSetV2",
            )
        )
    )
    if row["artifact_type"] == "KEYWORD_SET" and incompatible_keyword_contract:
        return (
            "关键词生成结果格式不兼容；已保留上一次成功关键词。"
            "请重新生成，Local Falcon 未启动。"
        )
    if row["artifact_type"] == "KEYWORD_SET" and (
        "Google Business identity" in error
        or "keyword location name" in error
    ):
        return (
            "关键词结果与当前 GBP 门店不匹配；已拒绝该结果并保留上一次成功关键词。"
            "Local Falcon 未启动。"
        )
    return error


def _state(conn: sqlite3.Connection, merchant_id: int, cycle_id: str | None = None) -> dict:
    settings = coreai_settings()
    local_falcon_configured = bool(settings and settings.local_falcon_tool_id)
    keyword_workflow_configured = _keyword_skill_workflow_settings() is not None
    merchant = conn.execute("SELECT * FROM merchants WHERE id = ?", (merchant_id,)).fetchone()
    location = _selected_location_context(conn, merchant) if merchant is not None else None
    current_place_id = location.get("place_id") if location else None
    keyword_head = (
        _ensure_keyword_head(conn, merchant_id, current_place_id)
        if current_place_id
        else None
    )
    keyword_row, keyword_payload = (
        _active_ready_keyword_artifact(conn, merchant_id, current_place_id)
        if current_place_id
        else (None, None)
    )
    active_artifact_id = keyword_row["id"] if keyword_row else None
    keyword_versions = (
        _keyword_version_summaries(
            conn, merchant_id, current_place_id, active_artifact_id
        )
        if current_place_id
        else []
    )
    latest_fbr_row, latest_fbr_payload = (
        _latest_fbr_keyword_import(conn, merchant_id, current_place_id)
        if current_place_id
        else (None, None)
    )
    latest_fbr_import = _latest_fbr_import_state(
        latest_fbr_row,
        latest_fbr_payload,
        keyword_payload,
        active_artifact_id,
    )
    unresolved_batch = _unresolved_local_falcon_batch(conn, merchant_id)
    regenerate_blockers = []
    if not current_place_id:
        regenerate_blockers.append("unambiguous_location_required")
    if not keyword_workflow_configured:
        regenerate_blockers.append("keyword_skill_unconfigured")
    if unresolved_batch is not None:
        regenerate_blockers.append("unresolved_scan_batch")
    keyword_regeneration_running = bool(
        conn.execute(
            "SELECT 1 FROM merchant_seo_artifacts"
            " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET'"
            " AND status = 'running' LIMIT 1",
            (merchant_id,),
        ).fetchone()
    )
    if keyword_regeneration_running:
        regenerate_blockers.append("keyword_regeneration_running")
    capabilities = {
        "can_regenerate": not regenerate_blockers,
        "can_sync_local_falcon": False,
        "can_approve_local_falcon": False,
        "can_generate_local_falcon": False,
        "blockers": {
            "regenerate": regenerate_blockers,
            "sync_local_falcon": [
                *([] if current_place_id else ["unambiguous_location_required"]),
                "no_trusted_scored_cohort",
                *([] if local_falcon_configured else ["local_falcon_integration_unconfigured"]),
            ],
            "approve_local_falcon": [
                *([] if current_place_id else ["unambiguous_location_required"]),
                "no_trusted_scored_cohort",
                *([] if unresolved_batch is None else ["unresolved_scan_batch"]),
            ],
            "generate_local_falcon": [
                *([] if current_place_id else ["unambiguous_location_required"]),
                "no_trusted_scored_cohort",
                "scan_defaults_missing",
                *([] if local_falcon_configured else ["local_falcon_integration_unconfigured"]),
                *([] if unresolved_batch is None else ["unresolved_scan_batch"]),
            ],
        },
    }
    if cycle_id is None:
        row = conn.execute(
            "SELECT cycle_id FROM merchant_seo_artifacts WHERE merchant_id = ? ORDER BY id DESC LIMIT 1",
            (merchant_id,),
        ).fetchone()
        cycle_id = row["cycle_id"] if row else None
    if cycle_id is None:
        paid_eligible = _keyword_artifact_paid_eligible(
            keyword_row,
            keyword_payload,
            current_place_id,
        )
        return {
            "merchant_id": merchant_id,
            "cycle_status": "empty",
            "active_stage": None,
            "keyword_set_artifact_id": active_artifact_id,
            "active_keyword_artifact_id": active_artifact_id,
            "active_keyword_source": (
                _keyword_version_source(keyword_payload) if keyword_payload else None
            ),
            "active_keyword_activated_at": (
                keyword_head["activated_at"] if keyword_head else None
            ),
            "local_falcon_cohort_sha256": (
                _local_falcon_cohort_sha256(keyword_payload)
                if paid_eligible
                else None
            ),
            "keyword_set": keyword_payload,
            "keyword_versions": keyword_versions,
            "latest_fbr_import": latest_fbr_import,
            "audit_report": None,
            "ranking_report": None,
            "local_falcon": _local_falcon_state(
                conn,
                merchant_id,
                keyword_payload,
                active_artifact_id,
                current_place_id=current_place_id,
                paid_eligible=paid_eligible,
            ),
            "capabilities": capabilities,
            "error": None,
        }
    rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts WHERE merchant_id = ? AND cycle_id = ? ORDER BY id",
        (merchant_id, cycle_id),
    ).fetchall()
    running = next((row for row in rows if row["status"] == "running"), None)
    failed = next((row for row in reversed(rows) if row["status"] == "failed"), None)
    activation_conflict = next(
        (
            row
            for row in reversed(rows)
            if row["status"] == "ready" and row["error"]
        ),
        None,
    )

    display_cycle_id = keyword_row["cycle_id"] if keyword_row else cycle_id
    display_rows = conn.execute(
        "SELECT * FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND cycle_id = ? AND status = 'ready' ORDER BY id",
        (merchant_id, display_cycle_id),
    ).fetchall() if display_cycle_id else []
    display_by_type = {row["artifact_type"]: row for row in display_rows}

    def payload(kind: str):
        if kind == "KEYWORD_SET":
            return keyword_payload
        row = display_by_type.get(kind)
        return json.loads(row["payload_json"]) if row and row["payload_json"] else None

    paid_eligible = _keyword_artifact_paid_eligible(
        keyword_row,
        keyword_payload,
        current_place_id,
    )
    cohort = _local_falcon_cohort(keyword_payload) if paid_eligible else []
    cohort_sha256 = (
        _local_falcon_cohort_sha256(keyword_payload) if paid_eligible else None
    )
    local_falcon = _local_falcon_state(
        conn,
        merchant_id,
        keyword_payload,
        keyword_row["id"] if keyword_row else None,
        current_place_id,
        paid_eligible,
    )
    cohort_blockers = [] if cohort and paid_eligible else ["no_trusted_scored_cohort"]
    location_blockers = [] if current_place_id else ["unambiguous_location_required"]
    running_blockers = ["keyword_regeneration_running"] if keyword_regeneration_running else []
    unresolved_blockers = ["unresolved_scan_batch"] if unresolved_batch is not None else []
    integration_blockers = [] if local_falcon_configured else ["local_falcon_integration_unconfigured"]
    scan_default_blockers = [] if local_falcon["scan_defaults"] else ["scan_defaults_missing"]
    sync_blockers = [*location_blockers, *cohort_blockers, *integration_blockers]
    approval_blockers = [
        *location_blockers,
        *cohort_blockers,
        *running_blockers,
        *unresolved_blockers,
    ]
    generation_blockers = [
        *approval_blockers,
        *scan_default_blockers,
        *integration_blockers,
    ]
    capabilities["can_sync_local_falcon"] = not sync_blockers
    capabilities["can_approve_local_falcon"] = not approval_blockers
    capabilities["can_generate_local_falcon"] = not generation_blockers
    capabilities["blockers"] = {
        "regenerate": regenerate_blockers,
        "sync_local_falcon": sync_blockers,
        "approve_local_falcon": approval_blockers,
        "generate_local_falcon": generation_blockers,
    }
    return {
        "merchant_id": merchant_id,
        "cycle_id": cycle_id,
        "cycle_status": "running" if running else "failed" if failed else "ready",
        "active_stage": running["artifact_type"] if running else None,
        "keyword_set_artifact_id": active_artifact_id,
        "active_keyword_artifact_id": active_artifact_id,
        "active_keyword_source": (
            _keyword_version_source(keyword_payload) if keyword_payload else None
        ),
        "active_keyword_activated_at": (
            keyword_head["activated_at"] if keyword_head else None
        ),
        "local_falcon_cohort_sha256": cohort_sha256,
        "keyword_set": keyword_payload,
        "keyword_versions": keyword_versions,
        "latest_fbr_import": latest_fbr_import,
        "audit_report": payload("AUDIT_REPORT"),
        "ranking_report": payload("RANKING_REPORT"),
        "local_falcon": local_falcon,
        "capabilities": capabilities,
        "error": _public_seo_artifact_error(failed or activation_conflict),
    }


@router.get("/merchants/{merchant_id}/seo-targets")
def get_seo_targets(merchant_id: int, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    return _state(conn, merchant_id)


@router.post(
    "/merchants/{merchant_id}/local-falcon-approvals",
    status_code=status.HTTP_201_CREATED,
)
def approve_local_falcon_cohort(
    merchant_id: int,
    body: LocalFalconApprovalRequest,
    operator: str = Depends(require_operator),
    conn=Depends(get_db),
):
    merchant = fetch_active_merchant(conn, merchant_id)
    location = _location_context(conn, merchant)
    place_id = location.get("place_id")
    if not place_id:
        raise HTTPException(status_code=409, detail="GBP Place ID is required for Local Falcon")
    if conn.execute(
        "SELECT 1 FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'running'"
        " LIMIT 1",
        (merchant_id,),
    ).fetchone():
        raise HTTPException(
            status_code=409,
            detail="wait for keyword regeneration to finish before approval",
        )

    _ensure_keyword_head(conn, merchant_id, place_id)
    latest_keyword_row, keyword_set = _active_ready_keyword_artifact(
        conn, merchant_id, place_id
    )
    if latest_keyword_row is None:
        latest_other_location = _ready_keyword_artifact_for_another_place(
            conn, merchant_id, place_id
        )
        if latest_other_location is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "keyword artifact belongs to another GBP location; "
                    "refresh or regenerate keywords for the current location"
                ),
            )
        raise HTTPException(status_code=409, detail="generate and score keywords before approval")
    if latest_keyword_row["id"] != body.keyword_artifact_id:
        raise HTTPException(
            status_code=409,
            detail="keyword cohort changed; review the latest Top 20",
        )
    if _keyword_artifact_place_id(latest_keyword_row) != place_id:
        raise HTTPException(
            status_code=409,
            detail=(
                "keyword artifact belongs to another GBP location; "
                "refresh or regenerate keywords for the current location"
            ),
        )

    if not _has_deterministic_scored_local_cohort(keyword_set):
        raise HTTPException(
            status_code=409,
            detail="keyword scores are required before approving the Local Falcon Top 20 cohort",
        )
    if not _keyword_artifact_paid_eligible(latest_keyword_row, keyword_set, place_id):
        raise HTTPException(
            status_code=409,
            detail="keyword artifact does not have trusted FBR or configured Skill provenance",
        )
    cohort = _local_falcon_cohort_snapshot(keyword_set)
    cohort_sha256 = _local_falcon_cohort_sha256(keyword_set)
    if not cohort or cohort_sha256 is None:
        raise HTTPException(
            status_code=409,
            detail="keyword scores are required before approving the Local Falcon Top 20 cohort",
        )
    if cohort_sha256 != body.expected_cohort_sha256:
        raise HTTPException(
            status_code=409,
            detail="keyword cohort changed; review the latest Top 20",
        )

    approved_at = now_iso()
    conn.execute(
        "INSERT INTO merchant_local_falcon_approvals"
        " (merchant_id, keyword_artifact_id, cohort_sha256, cohort_json, place_id,"
        " approved_by, approved_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT(merchant_id, keyword_artifact_id, cohort_sha256) DO NOTHING",
        (
            merchant_id,
            latest_keyword_row["id"],
            cohort_sha256,
            json.dumps(cohort, ensure_ascii=False),
            place_id,
            operator,
            approved_at,
        ),
    )
    conn.commit()
    return _state(conn, merchant_id)


@router.post(
    "/merchants/{merchant_id}/local-falcon-scan-batches",
    status_code=status.HTTP_202_ACCEPTED,
)
def create_local_falcon_scan_batch(
    merchant_id: int,
    body: LocalFalconScanBatchRequest,
    operator: str = Depends(require_operator),
    _local_falcon=Depends(get_local_falcon),
    conn=Depends(get_db),
):
    if not body.confirm_credit_spend:
        raise HTTPException(
            status_code=409,
            detail="confirm the credit-consuming Local Falcon scans",
        )
    merchant = fetch_active_merchant(conn, merchant_id)

    conn.execute("BEGIN IMMEDIATE")
    existing_confirmation = conn.execute(
        "SELECT * FROM merchant_local_falcon_scan_confirmations"
        " WHERE merchant_id = ? AND confirmation_request_id = ?",
        (merchant_id, body.request_id),
    ).fetchone()
    if existing_confirmation is not None:
        if (
            existing_confirmation["approval_id"] != body.approval_id
            or existing_confirmation["scan_config_sha256"]
            != body.expected_scan_config_sha256
            or existing_confirmation["confirmed_by"] != operator
        ):
            conn.rollback()
            raise HTTPException(
                status_code=409,
                detail="request_id is already bound to another Local Falcon confirmation",
            )
        existing = conn.execute(
            "SELECT * FROM merchant_local_falcon_scan_batches WHERE confirmation_id = ?",
            (existing_confirmation["id"],),
        ).fetchone()
        if existing is not None:
            conn.commit()
            state = _state(conn, merchant_id)
            state["local_falcon"]["scan_batch"] = _local_falcon_scan_batch_json(
                conn,
                existing,
            )
            return state

    if conn.execute(
        "SELECT 1 FROM merchant_seo_artifacts"
        " WHERE merchant_id = ? AND artifact_type = 'KEYWORD_SET' AND status = 'running'"
        " LIMIT 1",
        (merchant_id,),
    ).fetchone():
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="wait for keyword regeneration to finish before creating scans",
        )

    approval = conn.execute(
        "SELECT * FROM merchant_local_falcon_approvals"
        " WHERE id = ? AND merchant_id = ?",
        (body.approval_id, merchant_id),
    ).fetchone()
    if approval is None:
        conn.rollback()
        raise HTTPException(status_code=404, detail="Local Falcon approval not found")

    unresolved = _unresolved_local_falcon_batch(conn, merchant_id)
    if unresolved is not None:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail=(
                f"Local Falcon scan batch {unresolved['id']} is unresolved; "
                "sync or reconcile it before confirming another paid scan"
            ),
        )

    _ensure_keyword_head(conn, merchant_id, approval["place_id"])
    latest_keyword_row, latest_keyword_set = _active_ready_keyword_artifact(
        conn, merchant_id, approval["place_id"]
    )
    latest_sha256 = _local_falcon_cohort_sha256(latest_keyword_set)
    if (
        latest_keyword_row is None
        or not _keyword_artifact_paid_eligible(
            latest_keyword_row,
            latest_keyword_set,
            approval["place_id"],
        )
        or latest_keyword_row["id"] != approval["keyword_artifact_id"]
        or latest_sha256 != approval["cohort_sha256"]
    ):
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="approved keyword cohort is stale; review and approve the latest Top 20",
        )

    location = _location_context(conn, merchant)
    if location.get("place_id") != approval["place_id"]:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="GBP location changed after keyword approval",
        )
    scan_defaults = _local_falcon_scan_defaults(conn, merchant_id, approval["place_id"])
    if scan_defaults is None or scan_defaults["place_id"] != approval["place_id"]:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="sync an existing Local Falcon report before generating a new scan batch",
        )
    scan_config_sha256 = _local_falcon_scan_config_sha256(scan_defaults)
    if scan_config_sha256 != body.expected_scan_config_sha256:
        conn.rollback()
        raise HTTPException(
            status_code=409,
            detail="scan parameters changed; review the latest settings",
        )

    cohort = json.loads(approval["cohort_json"])
    created_at = now_iso()
    scan_config_json = json.dumps(
        scan_defaults,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    if existing_confirmation is None:
        confirmation_cursor = conn.execute(
            "INSERT INTO merchant_local_falcon_scan_confirmations"
            " (merchant_id, approval_id, confirmation_request_id, scan_config_sha256,"
            " scan_config_json, confirmed_by, confirmed_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                merchant_id,
                approval["id"],
                body.request_id,
                scan_config_sha256,
                scan_config_json,
                operator,
                created_at,
            ),
        )
        confirmation_id = confirmation_cursor.lastrowid
    else:
        confirmation_id = existing_confirmation["id"]
    cursor = conn.execute(
        "INSERT INTO merchant_local_falcon_scan_batches"
        " (merchant_id, approval_id, confirmation_id, request_id, status,"
        " scan_config_json, created_at)"
        " VALUES (?, ?, ?, ?, 'submitting', ?, ?)",
        (
            merchant_id,
            approval["id"],
            confirmation_id,
            body.request_id,
            scan_config_json,
            created_at,
        ),
    )
    batch_id = cursor.lastrowid
    conn.executemany(
        "INSERT INTO merchant_local_falcon_scan_items"
        " (batch_id, keyword, status, updated_at) VALUES (?, ?, 'pending', ?)",
        [(batch_id, item["keyword"], created_at) for item in cohort],
    )
    conn.commit()
    state = _state(conn, merchant_id)
    exact_batch = conn.execute(
        "SELECT * FROM merchant_local_falcon_scan_batches WHERE id = ?",
        (batch_id,),
    ).fetchone()
    state["local_falcon"]["scan_batch"] = _local_falcon_scan_batch_json(
        conn,
        exact_batch,
    )
    return state


def _reconciliation_batch_state(
    conn: sqlite3.Connection,
    batch_id: int,
    reconciled_at: str,
) -> str:
    statuses = [
        row["status"]
        for row in conn.execute(
            "SELECT status FROM merchant_local_falcon_scan_items"
            " WHERE batch_id = ? ORDER BY id",
            (batch_id,),
        ).fetchall()
    ]
    if statuses and all(item_status == "completed" for item_status in statuses):
        status_value = "completed"
        completed_at = reconciled_at
        error = None
    else:
        status_value = "partial"
        completed_at = None
        error = "Manual reconciliation is incomplete; no automatic retry is allowed"
    conn.execute(
        "UPDATE merchant_local_falcon_scan_batches"
        " SET status = ?, dispatch_token = NULL, dispatch_started_at = NULL,"
        " error = ?, completed_at = ? WHERE id = ?",
        (status_value, error, completed_at, batch_id),
    )
    return status_value


def _verified_reconciliation_report_time(value: object) -> datetime:
    """Require an upstream timestamp that can be compared to the paid batch in UTC."""
    if not isinstance(value, str):
        raise HTTPException(
            status_code=409,
            detail="Local Falcon report timestamp is missing; the report cannot be safely bound",
        )
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(
            status_code=409,
            detail=(
                "Local Falcon report timestamp does not include a verifiable timezone; "
                "the report cannot be safely bound"
            ),
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Local Falcon report timestamp does not include a verifiable timezone; "
                "the report cannot be safely bound"
            ),
        )
    return parsed.astimezone(timezone.utc)


@router.post(
    "/merchants/{merchant_id}/local-falcon-scan-batches/{batch_id}/reconcile"
)
def reconcile_local_falcon_scan_batch(
    merchant_id: int,
    batch_id: int,
    body: LocalFalconReconciliationRequest,
    operator: str = Depends(require_operator),
    local_falcon=Depends(get_reconciliation_local_falcon),
    conn=Depends(get_db),
):
    fetch_active_merchant(conn, merchant_id)
    batch = conn.execute(
        "SELECT * FROM merchant_local_falcon_scan_batches"
        " WHERE id = ? AND merchant_id = ?",
        (batch_id, merchant_id),
    ).fetchone()
    if batch is None:
        raise HTTPException(status_code=404, detail="Local Falcon scan batch not found")
    initially_reconcilable = batch["status"] in {"unknown", "partial"} or (
        body.action == "CONFIRM_NOT_SUBMITTED" and batch["status"] == "submitting"
    )
    if not initially_reconcilable:
        raise HTTPException(
            status_code=409,
            detail=(
                "only unknown or partial Local Falcon batches, or an unclaimed queued "
                "batch confirmed not submitted, can be reconciled"
            ),
        )

    reconciled_at = now_iso()
    item = None
    snapshot = None
    if body.action == "BIND_ACKNOWLEDGED_REPORT":
        if not LOCAL_FALCON_MANUAL_REPORT_BINDING_ENABLED:
            raise HTTPException(
                status_code=409,
                detail=(
                    "manual Local Falcon report binding is disabled until the upstream "
                    "report exposes a verifiable submission correlation id"
                ),
            )
        if not body.keyword or not body.report_key:
            raise HTTPException(
                status_code=422,
                detail="keyword and report_key are required when binding a report",
            )
        item = next(
            (
                row
                for row in conn.execute(
                    "SELECT * FROM merchant_local_falcon_scan_items"
                    " WHERE batch_id = ? ORDER BY id",
                    (batch_id,),
                ).fetchall()
                if _keyword_identity(row["keyword"]) == _keyword_identity(body.keyword)
            ),
            None,
        )
        if item is None or item["status"] != "unknown":
            raise HTTPException(
                status_code=409,
                detail="the selected keyword is not an unknown item in this batch",
            )
        reused = conn.execute(
            "SELECT 1 FROM merchant_local_falcon_scan_items"
            " WHERE ack_report_key = ? AND id != ? LIMIT 1",
            (body.report_key, item["id"]),
        ).fetchone()
        if reused is not None:
            raise HTTPException(
                status_code=409,
                detail="this Local Falcon report key is already bound to another scan item",
            )
        if local_falcon is None:
            raise HTTPException(
                status_code=503,
                detail="Local Falcon integration is required to verify a report binding",
            )
        scan_config = json.loads(batch["scan_config_json"])
        try:
            raw_report = local_falcon.get_report(body.report_key)
            report_time = _verified_reconciliation_report_time(raw_report.get("date"))
            snapshot = normalize_local_falcon_report(
                raw_report,
                expected_place_id=scan_config["place_id"],
                expected_keyword=item["keyword"],
            )
        except (CoreAiError, ValueError) as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        if snapshot["report_key"] != body.report_key:
            raise HTTPException(
                status_code=409,
                detail="Local Falcon report readback does not match the supplied report key",
            )
        if not _local_falcon_scan_config_matches_snapshot(scan_config, snapshot):
            raise HTTPException(
                status_code=409,
                detail="Local Falcon report does not match the frozen scan configuration",
            )
        try:
            batch_time = datetime.fromisoformat(batch["created_at"].replace("Z", "+00:00"))
        except (AttributeError, ValueError) as exc:
            raise HTTPException(
                status_code=409,
                detail="paid scan batch timestamp is invalid; the report cannot be safely bound",
            ) from exc
        if batch_time.tzinfo is None or batch_time.utcoffset() is None:
            raise HTTPException(
                status_code=409,
                detail="paid scan batch timestamp has no timezone; the report cannot be safely bound",
            )
        if report_time <= batch_time.astimezone(timezone.utc):
            raise HTTPException(
                status_code=409,
                detail="Local Falcon report predates this paid scan batch",
            )
    elif body.keyword is not None or body.report_key is not None:
        raise HTTPException(
            status_code=422,
            detail="keyword and report_key are only valid when binding a report",
        )

    conn.execute("BEGIN IMMEDIATE")
    try:
        current_batch = conn.execute(
            "SELECT * FROM merchant_local_falcon_scan_batches"
            " WHERE id = ? AND merchant_id = ?",
            (batch_id, merchant_id),
        ).fetchone()
        currently_reconcilable = current_batch is not None and (
            current_batch["status"] in {"unknown", "partial"}
            or (
                body.action == "CONFIRM_NOT_SUBMITTED"
                and current_batch["status"] == "submitting"
            )
        )
        if not currently_reconcilable:
            raise HTTPException(
                status_code=409,
                detail="Local Falcon scan batch changed while it was being reconciled",
            )

        details: dict[str, object] = {
            "batch_status_before": current_batch["status"],
            "automatic_retry": False,
        }
        item_id = None
        report_key = None
        if body.action == "BIND_ACKNOWLEDGED_REPORT":
            current_item = conn.execute(
                "SELECT * FROM merchant_local_falcon_scan_items"
                " WHERE id = ? AND batch_id = ?",
                (item["id"], batch_id),
            ).fetchone()
            if current_item is None or current_item["status"] != "unknown":
                raise HTTPException(
                    status_code=409,
                    detail="scan item changed while its report was being verified",
                )
            reused = conn.execute(
                "SELECT 1 FROM merchant_local_falcon_scan_items"
                " WHERE ack_report_key = ? AND id != ? LIMIT 1",
                (body.report_key, current_item["id"]),
            ).fetchone()
            if reused is not None:
                raise HTTPException(
                    status_code=409,
                    detail="this Local Falcon report key is already bound to another scan item",
                )
            _upsert_local_falcon_snapshot(conn, merchant_id, snapshot, reconciled_at)
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'completed', ack_report_key = ?, response_json = ?,"
                " error = NULL, updated_at = ? WHERE id = ? AND status = 'unknown'",
                (
                    body.report_key,
                    json.dumps(snapshot, ensure_ascii=False),
                    reconciled_at,
                    current_item["id"],
                ),
            )
            batch_status = _reconciliation_batch_state(conn, batch_id, reconciled_at)
            item_id = current_item["id"]
            report_key = body.report_key
            details.update(
                {
                    "keyword": current_item["keyword"],
                    "snapshot_sha256": _sha256_json(snapshot),
                    "batch_status_after": batch_status,
                }
            )
        elif body.action == "CONFIRM_NOT_SUBMITTED":
            current_items = conn.execute(
                "SELECT status, ack_report_key FROM merchant_local_falcon_scan_items"
                " WHERE batch_id = ? ORDER BY id",
                (batch_id,),
            ).fetchall()
            if current_batch["status"] == "submitting" and (
                current_batch["dispatch_token"] is not None
                or current_batch["dispatch_started_at"] is not None
                or not current_items
                or any(
                    candidate["status"] != "pending"
                    or candidate["ack_report_key"] is not None
                    for candidate in current_items
                )
            ):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "queued batch was claimed or changed; verify its external state before "
                        "confirming it was not submitted"
                    ),
                )
            previously_accepted = conn.execute(
                "SELECT COUNT(*) FROM merchant_local_falcon_scan_items"
                " WHERE batch_id = ?"
                " AND (status IN ('submitting', 'submitted', 'completed')"
                " OR ack_report_key IS NOT NULL)",
                (batch_id,),
            ).fetchone()[0]
            if previously_accepted:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "CONFIRM_NOT_SUBMITTED is only valid when the batch has no accepted, "
                        "completed, or in-flight items"
                    ),
                )
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'failed', error = ?, updated_at = ?"
                " WHERE batch_id = ? AND status IN ('unknown', 'pending')",
                (
                    "Operator confirmed that Local Falcon did not accept this submission",
                    reconciled_at,
                    batch_id,
                ),
            )
            conn.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET status = 'failed', dispatch_token = NULL, dispatch_started_at = NULL,"
                " error = ?, completed_at = ? WHERE id = ?",
                (
                    "Closed by operator after confirming no submission was accepted",
                    reconciled_at,
                    batch_id,
                ),
            )
            details["batch_status_after"] = "failed"
            details["queue_claimed"] = False
            details["item_count"] = len(current_items)
        else:
            blocking = conn.execute(
                "SELECT COUNT(*) FROM merchant_local_falcon_scan_items"
                " WHERE batch_id = ? AND status IN ('unknown', 'submitting', 'submitted')",
                (batch_id,),
            ).fetchone()[0]
            if blocking:
                raise HTTPException(
                    status_code=409,
                    detail="resolve every unknown or acknowledged item before closing the remainder",
                )
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'failed', error = ?, updated_at = ?"
                " WHERE batch_id = ? AND status = 'pending'",
                (
                    "Operator closed the remaining item without retry",
                    reconciled_at,
                    batch_id,
                ),
            )
            conn.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET status = 'failed', dispatch_token = NULL, dispatch_started_at = NULL,"
                " error = ?, completed_at = ? WHERE id = ?",
                (
                    "Closed by operator without retrying remaining items",
                    reconciled_at,
                    batch_id,
                ),
            )
            details["batch_status_after"] = "failed"

        conn.execute(
            "INSERT INTO merchant_local_falcon_reconciliations"
            " (merchant_id, batch_id, item_id, action, report_key, reason, details_json,"
            " reconciled_by, reconciled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                merchant_id,
                batch_id,
                item_id,
                body.action,
                report_key,
                body.reason,
                json.dumps(details, ensure_ascii=False),
                operator,
                reconciled_at,
            ),
        )
    except Exception:
        conn.rollback()
        raise
    conn.commit()
    return _state(conn, merchant_id)


def _mark_stale_local_falcon_dispatches_unknown(conn: sqlite3.Connection) -> None:
    cutoff = (datetime.now(timezone.utc) - LOCAL_FALCON_DISPATCH_STALE_AFTER).isoformat()
    stale_batches = conn.execute(
        "SELECT id, dispatch_token FROM merchant_local_falcon_scan_batches"
        " WHERE status = 'submitting' AND dispatch_token IS NOT NULL"
        " AND dispatch_started_at < ? ORDER BY id",
        (cutoff,),
    ).fetchall()
    for batch in stale_batches:
        # The candidate list is only a hint. A live worker may heartbeat after
        # it is read, so re-check the exact lease under a write transaction and
        # keep the cutoff in every state-changing predicate.
        transitioned_at = now_iso()
        error = (
            "Local Falcon dispatch worker stopped after claiming this batch; "
            "manual reconciliation is required before any retry"
        )
        conn.execute("BEGIN IMMEDIATE")
        try:
            lease = conn.execute(
                "SELECT id FROM merchant_local_falcon_scan_batches"
                " WHERE id = ? AND status = 'submitting' AND dispatch_token = ?"
                " AND dispatch_started_at < ?",
                (batch["id"], batch["dispatch_token"], cutoff),
            ).fetchone()
            if lease is None:
                conn.commit()
                continue
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'unknown', error = ?, updated_at = ?"
                " WHERE batch_id = ? AND status = 'submitting'"
                " AND EXISTS (SELECT 1 FROM merchant_local_falcon_scan_batches b"
                " WHERE b.id = ? AND b.status = 'submitting'"
                " AND b.dispatch_token = ? AND b.dispatch_started_at < ?)",
                (
                    error,
                    transitioned_at,
                    batch["id"],
                    batch["id"],
                    batch["dispatch_token"],
                    cutoff,
                ),
            )
            acknowledged = conn.execute(
                "SELECT COUNT(*) FROM merchant_local_falcon_scan_items"
                " WHERE batch_id = ? AND status IN ('submitted', 'completed')",
                (batch["id"],),
            ).fetchone()[0]
            transitioned = conn.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET status = ?, dispatch_token = NULL, dispatch_started_at = NULL,"
                " error = ? WHERE id = ? AND status = 'submitting'"
                " AND dispatch_token = ? AND dispatch_started_at < ?",
                (
                    "partial" if acknowledged else "unknown",
                    error,
                    batch["id"],
                    batch["dispatch_token"],
                    cutoff,
                ),
            ).rowcount
            if transitioned != 1:
                conn.rollback()
                continue
            conn.commit()
        except Exception:
            conn.rollback()
            raise


def recover_stale_seo_dispatches_once() -> None:
    """Release ambiguous durable dispatch leases without any network client."""
    conn = connect()
    try:
        _mark_stale_keyword_dispatches_unknown(conn)
        conn.commit()
        _mark_stale_local_falcon_dispatches_unknown(conn)
    finally:
        conn.close()


def _claim_local_falcon_scan_batch(conn: sqlite3.Connection) -> tuple[int, str] | None:
    token = str(uuid4())
    conn.execute("BEGIN IMMEDIATE")
    batch = conn.execute(
        "SELECT id FROM merchant_local_falcon_scan_batches"
        " WHERE status = 'submitting' AND dispatch_token IS NULL"
        " ORDER BY id LIMIT 1"
    ).fetchone()
    if batch is None:
        conn.commit()
        return None
    claimed = conn.execute(
        "UPDATE merchant_local_falcon_scan_batches"
        " SET dispatch_token = ?, dispatch_started_at = ?"
        " WHERE id = ? AND status = 'submitting' AND dispatch_token IS NULL",
        (token, now_iso(), batch["id"]),
    ).rowcount
    conn.commit()
    return (batch["id"], token) if claimed == 1 else None


def _heartbeat_local_falcon_dispatch(
    conn: sqlite3.Connection,
    batch_id: int,
    dispatch_token: str,
) -> bool:
    alive = conn.execute(
        "UPDATE merchant_local_falcon_scan_batches"
        " SET dispatch_started_at = ?"
        " WHERE id = ? AND status = 'submitting' AND dispatch_token = ?",
        (now_iso(), batch_id, dispatch_token),
    ).rowcount
    conn.commit()
    return alive == 1


def _submit_claimed_local_falcon_batch(
    conn: sqlite3.Connection,
    local_falcon,
    batch_id: int,
    dispatch_token: str,
) -> None:
    batch = conn.execute(
        "SELECT * FROM merchant_local_falcon_scan_batches"
        " WHERE id = ? AND status = 'submitting' AND dispatch_token = ?",
        (batch_id, dispatch_token),
    ).fetchone()
    if batch is None:
        return
    scan_config = json.loads(batch["scan_config_json"])
    items = conn.execute(
        "SELECT id, keyword FROM merchant_local_falcon_scan_items"
        " WHERE batch_id = ? AND status = 'pending' ORDER BY id",
        (batch_id,),
    ).fetchall()
    submitted_count = conn.execute(
        "SELECT COUNT(*) FROM merchant_local_falcon_scan_items"
        " WHERE batch_id = ? AND status IN ('submitted', 'completed')",
        (batch_id,),
    ).fetchone()[0]

    for item in items:
        if not _heartbeat_local_falcon_dispatch(conn, batch_id, dispatch_token):
            return
        claimed = conn.execute(
            "UPDATE merchant_local_falcon_scan_items"
            " SET status = 'submitting', updated_at = ?"
            " WHERE id = ? AND batch_id = ? AND status = 'pending'"
            " AND EXISTS (SELECT 1 FROM merchant_local_falcon_scan_batches b"
            " WHERE b.id = ? AND b.status = 'submitting' AND b.dispatch_token = ?)",
            (now_iso(), item["id"], batch_id, batch_id, dispatch_token),
        ).rowcount
        conn.commit()
        if claimed != 1:
            return
        try:
            result = local_falcon.run_scan(
                place_id=scan_config["place_id"],
                keyword=item["keyword"],
                lat=scan_config["lat"],
                lng=scan_config["lng"],
                grid_size=scan_config["grid_size"],
                radius=scan_config["radius"],
                measurement=scan_config["measurement"],
            )
            if result.get("success") is not True:
                raise ValueError("Local Falcon scan submission was not acknowledged")
            report_key = result.get("report_key")
            if not isinstance(report_key, str) or re.fullmatch(r"[a-f0-9]{15}", report_key) is None:
                raise ValueError("Local Falcon scan submission did not return a valid report key")
        except (CoreAiError, ValueError) as exc:
            batch_error = str(exc)[:500]
            marked_unknown = conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'unknown', error = ?, updated_at = ?"
                " WHERE id = ? AND status = 'submitting'"
                " AND EXISTS (SELECT 1 FROM merchant_local_falcon_scan_batches b"
                " WHERE b.id = ? AND b.status = 'submitting' AND b.dispatch_token = ?)",
                (batch_error, now_iso(), item["id"], batch_id, dispatch_token),
            ).rowcount
            if marked_unknown != 1:
                conn.commit()
                return
            conn.execute(
                "UPDATE merchant_local_falcon_scan_batches SET status = ?, error = ?"
                " WHERE id = ? AND status = 'submitting' AND dispatch_token = ?",
                ("partial" if submitted_count else "unknown", batch_error, batch_id, dispatch_token),
            )
            conn.commit()
            return

        acknowledged = conn.execute(
            "UPDATE merchant_local_falcon_scan_items"
            " SET status = 'submitted', ack_report_key = ?, response_json = ?,"
            " error = NULL, updated_at = ? WHERE id = ? AND status = 'submitting'"
            " AND EXISTS (SELECT 1 FROM merchant_local_falcon_scan_batches b"
            " WHERE b.id = ? AND b.status = 'submitting' AND b.dispatch_token = ?)",
            (
                report_key,
                json.dumps(result, ensure_ascii=False),
                now_iso(),
                item["id"],
                batch_id,
                dispatch_token,
            ),
        ).rowcount
        conn.commit()
        if acknowledged != 1:
            return
        submitted_count += 1

    conn.execute(
        "UPDATE merchant_local_falcon_scan_batches"
        " SET status = 'submitted', error = NULL"
        " WHERE id = ? AND status = 'submitting' AND dispatch_token = ?",
        (batch_id, dispatch_token),
    )
    conn.commit()


def submit_local_falcon_batches_once(local_falcon, max_batches: int = 1) -> int:
    """Claim and dispatch durable batches outside the HTTP request path."""
    conn = connect()
    processed = 0
    try:
        _mark_stale_local_falcon_dispatches_unknown(conn)
        while processed < max_batches:
            claim = _claim_local_falcon_scan_batch(conn)
            if claim is None:
                break
            _submit_claimed_local_falcon_batch(conn, local_falcon, *claim)
            processed += 1
        return processed
    finally:
        conn.close()


def _record_local_falcon_failure(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
    keyword_artifact_id: int,
    cohort_sha256: str,
    error: str,
) -> None:
    attempted_at = now_iso()
    conn.execute(
        "INSERT INTO merchant_local_falcon_syncs"
        " (merchant_id, place_id, keyword_artifact_id, cohort_sha256, status,"
        " last_attempt_at, last_error) VALUES (?, ?, ?, ?, 'failed', ?, ?)"
        " ON CONFLICT(merchant_id) DO UPDATE SET"
        " place_id = excluded.place_id, keyword_artifact_id = excluded.keyword_artifact_id,"
        " cohort_sha256 = excluded.cohort_sha256, status = 'failed',"
        " last_attempt_at = excluded.last_attempt_at,"
        " last_error = excluded.last_error",
        (
            merchant_id,
            place_id,
            keyword_artifact_id,
            cohort_sha256,
            attempted_at,
            error[:500],
        ),
    )
    conn.commit()


def _local_falcon_scan_config_matches_snapshot(
    scan_config: dict,
    snapshot: dict,
) -> bool:
    try:
        return (
            scan_config["place_id"] == snapshot["place_id"]
            and scan_config.get("platform", "google") == snapshot["platform"]
            and int(scan_config["grid_size"]) == int(snapshot["grid_size"])
            and scan_config["measurement"] == snapshot["measurement"]
            and math.isclose(float(scan_config["radius"]), float(snapshot["radius"]), abs_tol=1e-9)
            and math.isclose(float(scan_config["lat"]), float(snapshot["center_lat"]), abs_tol=1e-7)
            and math.isclose(float(scan_config["lng"]), float(snapshot["center_lng"]), abs_tol=1e-7)
        )
    except (KeyError, TypeError, ValueError):
        return False


def _complete_acknowledged_local_falcon_items(
    conn: sqlite3.Connection,
    merchant_id: int,
    snapshots: list[dict],
    completed_at: str,
) -> None:
    for snapshot in snapshots:
        candidates = conn.execute(
            "SELECT i.id, i.keyword, b.scan_config_json"
            " FROM merchant_local_falcon_scan_items i"
            " JOIN merchant_local_falcon_scan_batches b ON b.id = i.batch_id"
            " WHERE b.merchant_id = ? AND i.status = 'submitted'"
            " AND i.ack_report_key = ?",
            (merchant_id, snapshot["report_key"]),
        ).fetchall()
        for candidate in candidates:
            if _keyword_identity(candidate["keyword"]) != _keyword_identity(snapshot["keyword"]):
                continue
            scan_config = json.loads(candidate["scan_config_json"])
            if not _local_falcon_scan_config_matches_snapshot(scan_config, snapshot):
                continue
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET status = 'completed', error = NULL, updated_at = ? WHERE id = ?",
                (completed_at, candidate["id"]),
            )

    batch_rows = conn.execute(
        "SELECT id FROM merchant_local_falcon_scan_batches"
        " WHERE merchant_id = ? AND status IN ('submitting', 'submitted', 'partial')",
        (merchant_id,),
    ).fetchall()
    for batch in batch_rows:
        statuses = [
            row["status"]
            for row in conn.execute(
                "SELECT status FROM merchant_local_falcon_scan_items WHERE batch_id = ?",
                (batch["id"],),
            ).fetchall()
        ]
        if statuses and all(item_status == "completed" for item_status in statuses):
            conn.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET status = 'completed', error = NULL, completed_at = ? WHERE id = ?",
                (completed_at, batch["id"]),
            )


def _read_acknowledged_local_falcon_snapshots(
    conn: sqlite3.Connection,
    merchant_id: int,
    place_id: str,
    local_falcon,
) -> tuple[list[dict], set[str]]:
    """Persist each exact paid-scan readback independently.

    A not-ready or malformed acknowledgement remains ``submitted`` with its own
    readback error. Successful siblings are committed immediately so one bad
    report cannot make the whole paid batch all-or-nothing.
    """
    rows = conn.execute(
        "SELECT i.id, i.keyword, i.ack_report_key, b.scan_config_json"
        " FROM merchant_local_falcon_scan_items i"
        " JOIN merchant_local_falcon_scan_batches b ON b.id = i.batch_id"
        " WHERE b.merchant_id = ? AND i.status = 'submitted'"
        " AND i.ack_report_key IS NOT NULL ORDER BY i.id",
        (merchant_id,),
    ).fetchall()
    snapshots = []
    attempted_keywords: set[str] = set()
    for row in rows:
        attempted_keywords.add(_keyword_identity(row["keyword"]))
        attempted_at = now_iso()
        try:
            scan_config = json.loads(row["scan_config_json"])
            if not isinstance(scan_config, dict):
                raise ValueError("Local Falcon frozen scan config is not an object")
            if scan_config.get("place_id") != place_id:
                continue
            raw_report = local_falcon.get_report(row["ack_report_key"])
            if not isinstance(raw_report, dict):
                raise ValueError("Local Falcon acknowledged report response is not an object")
            snapshot = normalize_local_falcon_report(
                raw_report,
                expected_place_id=place_id,
                expected_keyword=row["keyword"],
            )
            if snapshot["report_key"] != row["ack_report_key"]:
                raise ValueError("Local Falcon acknowledged report key does not match readback")
            if not _local_falcon_scan_config_matches_snapshot(scan_config, snapshot):
                raise ValueError(
                    "Local Falcon acknowledged report does not match frozen scan config"
                )
        except (CoreAiError, ValueError, TypeError, KeyError) as exc:
            readback_error = str(exc).strip() or "Local Falcon acknowledged report readback failed"
            conn.execute(
                "UPDATE merchant_local_falcon_scan_items"
                " SET error = ?, updated_at = ?"
                " WHERE id = ? AND status = 'submitted' AND ack_report_key = ?",
                (readback_error[:500], attempted_at, row["id"], row["ack_report_key"]),
            )
            conn.commit()
            continue

        _upsert_local_falcon_snapshot(conn, merchant_id, snapshot, attempted_at)
        conn.execute(
            "UPDATE merchant_local_falcon_scan_items"
            " SET status = 'completed', error = NULL, updated_at = ?"
            " WHERE id = ? AND status = 'submitted' AND ack_report_key = ?",
            (attempted_at, row["id"], row["ack_report_key"]),
        )
        batch_id = conn.execute(
            "SELECT batch_id FROM merchant_local_falcon_scan_items WHERE id = ?",
            (row["id"],),
        ).fetchone()[0]
        incomplete = conn.execute(
            "SELECT COUNT(*) FROM merchant_local_falcon_scan_items"
            " WHERE batch_id = ? AND status != 'completed'",
            (batch_id,),
        ).fetchone()[0]
        if incomplete == 0:
            conn.execute(
                "UPDATE merchant_local_falcon_scan_batches"
                " SET status = 'completed', error = NULL, completed_at = ? WHERE id = ?",
                (attempted_at, batch_id),
            )
        conn.commit()
        snapshots.append(snapshot)
    return snapshots, attempted_keywords


def poll_acknowledged_local_falcon_reports_once(local_falcon) -> int:
    """Read back already-acknowledged reports without submitting any scans.

    Each distinct merchant/place pair is processed through the same exact-key
    validation and per-item persistence used by the operator sync endpoint.
    Not-ready or malformed reports remain ``submitted`` with an error and are
    eligible only for another read-only poll, never an automatic scan retry.
    """
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT b.id, b.merchant_id, b.scan_config_json"
            " FROM merchant_local_falcon_scan_batches b"
            " JOIN merchant_local_falcon_scan_items i ON i.batch_id = b.id"
            " WHERE i.status = 'submitted' AND i.ack_report_key IS NOT NULL"
            " ORDER BY b.merchant_id, b.id"
        ).fetchall()
        pairs: list[tuple[int, str]] = []
        seen: set[tuple[int, str]] = set()
        for row in rows:
            try:
                scan_config = json.loads(row["scan_config_json"])
                place_id = scan_config.get("place_id") if isinstance(scan_config, dict) else None
                if not isinstance(place_id, str) or not place_id.strip():
                    raise ValueError("Local Falcon frozen scan config has no place_id")
            except (json.JSONDecodeError, TypeError, ValueError) as exc:
                conn.execute(
                    "UPDATE merchant_local_falcon_scan_items"
                    " SET error = ?, updated_at = ?"
                    " WHERE batch_id = ? AND status = 'submitted'"
                    " AND ack_report_key IS NOT NULL",
                    (str(exc)[:500], now_iso(), row["id"]),
                )
                conn.commit()
                continue
            pair = (row["merchant_id"], place_id.strip())
            if pair not in seen:
                seen.add(pair)
                pairs.append(pair)

        for merchant_id, place_id in pairs:
            _read_acknowledged_local_falcon_snapshots(
                conn,
                merchant_id,
                place_id,
                local_falcon,
            )
        return len(pairs)
    finally:
        conn.close()


def _upsert_local_falcon_snapshot(
    conn: sqlite3.Connection,
    merchant_id: int,
    snapshot: dict,
    synced_at: str,
) -> None:
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


@router.post("/merchants/{merchant_id}/local-falcon-sync")
def sync_local_falcon_reports(
    merchant_id: int,
    local_falcon=Depends(get_local_falcon),
    conn=Depends(get_db),
):
    merchant = fetch_active_merchant(conn, merchant_id)
    location = _location_context(conn, merchant)
    place_id = location.get("place_id")
    if not place_id:
        raise HTTPException(status_code=409, detail="GBP Place ID is required for Local Falcon")
    _ensure_keyword_head(conn, merchant_id, place_id)
    keyword_row, keyword_set = _active_ready_keyword_artifact(
        conn, merchant_id, place_id
    )
    if keyword_row is None:
        latest_other_location = _ready_keyword_artifact_for_another_place(
            conn, merchant_id, place_id
        )
        if latest_other_location is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    "keyword artifact belongs to another GBP location; "
                    "refresh or regenerate keywords for the current location"
                ),
            )
        raise HTTPException(status_code=409, detail="generate and accept keywords before Local Falcon sync")
    if _keyword_artifact_place_id(keyword_row) != place_id:
        raise HTTPException(
            status_code=409,
            detail=(
                "keyword artifact belongs to another GBP location; "
                "refresh or regenerate keywords for the current location"
            ),
        )
    if not _has_deterministic_scored_local_cohort(keyword_set):
        raise HTTPException(
            status_code=409,
            detail="keyword scores are required before selecting the Local Falcon Top 20 cohort",
        )
    if not _keyword_artifact_paid_eligible(keyword_row, keyword_set, place_id):
        raise HTTPException(
            status_code=409,
            detail="keyword artifact does not have trusted FBR or configured Skill provenance",
        )
    cohort_sha256 = _local_falcon_cohort_sha256(keyword_set)
    keywords = []
    seen = set()
    for item in _local_falcon_cohort(keyword_set):
        keyword = item.get("keyword", "").strip()
        key = _keyword_identity(keyword)
        if keyword and key not in seen:
            seen.add(key)
            keywords.append(keyword)
    if not keywords:
        raise HTTPException(
            status_code=409,
            detail="keyword scores are required before selecting the Local Falcon Top 20 cohort",
        )

    snapshots = []
    missing = []
    try:
        acknowledged_snapshots, acknowledged_keywords = (
            _read_acknowledged_local_falcon_snapshots(
                conn, merchant_id, place_id, local_falcon
            )
        )
        snapshots.extend(acknowledged_snapshots)
        seen_report_keys = {snapshot["report_key"] for snapshot in snapshots}
        readback_keywords = {
            _keyword_identity(snapshot["keyword"]) for snapshot in snapshots
        }
        for keyword in keywords:
            keyword_key = _keyword_identity(keyword)
            if keyword_key in acknowledged_keywords and keyword_key not in readback_keywords:
                missing.append(keyword)
                continue
            listed = local_falcon.list_latest_exact_report(place_id, keyword)
            if listed is None:
                if keyword_key not in readback_keywords:
                    missing.append(keyword)
                continue
            report_key = listed.get("report_key")
            if not isinstance(report_key, str):
                raise ValueError("Local Falcon report key is missing")
            if report_key in seen_report_keys:
                continue
            snapshot = normalize_local_falcon_report(
                local_falcon.get_report(report_key),
                expected_place_id=place_id,
                expected_keyword=keyword,
            )
            snapshots.append(snapshot)
            seen_report_keys.add(report_key)
    except (CoreAiError, ValueError) as exc:
        if cohort_sha256 is None:
            raise HTTPException(
                status_code=409,
                detail="keyword scores are required before selecting the Local Falcon Top 20 cohort",
            ) from exc
        _record_local_falcon_failure(
            conn,
            merchant_id,
            place_id,
            keyword_row["id"],
            cohort_sha256,
            str(exc),
        )
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    synced_at = now_iso()
    for snapshot in snapshots:
        _upsert_local_falcon_snapshot(conn, merchant_id, snapshot, synced_at)
    _complete_acknowledged_local_falcon_items(
        conn,
        merchant_id,
        snapshots,
        synced_at,
    )
    conn.execute(
        "INSERT INTO merchant_local_falcon_syncs"
        " (merchant_id, place_id, keyword_artifact_id, cohort_sha256, status,"
        " last_attempt_at, last_synced_at, last_error, missing_keywords_json)"
        " VALUES (?, ?, ?, ?, 'synced', ?, ?, NULL, ?)"
        " ON CONFLICT(merchant_id) DO UPDATE SET"
        " place_id = excluded.place_id, keyword_artifact_id = excluded.keyword_artifact_id,"
        " cohort_sha256 = excluded.cohort_sha256, status = 'synced',"
        " last_attempt_at = excluded.last_attempt_at,"
        " last_synced_at = excluded.last_synced_at, last_error = NULL,"
        " missing_keywords_json = excluded.missing_keywords_json",
        (
            merchant_id,
            place_id,
            keyword_row["id"],
            cohort_sha256,
            synced_at,
            synced_at,
            json.dumps(missing, ensure_ascii=False),
        ),
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
    merchant = fetch_active_merchant(conn, merchant_id)
    artifact_id, cycle_id, location, place_id = _claim_keyword_cycle(
        conn,
        merchant,
        "refresh",
    )
    try:
        fbr_client = fbr_gbp.fbr_gbp_client()
    except FbrConfigurationError as exc:
        _fail_keyword_claim(conn, artifact_id, "FBR keyword repository is not configured")
        raise HTTPException(
            status_code=503,
            detail="FBR keyword repository is not configured",
        ) from exc
    try:
        fbr_response = fbr_client.get_local_keywords(place_id)
        if not isinstance(fbr_response, dict):
            raise FbrPayloadError("FBR persisted local keyword response is invalid")
        if fbr_response.get("place_id") != place_id:
            raise FbrPayloadError(
                "FBR persisted keyword Place ID does not match the selected GBP location"
            )
        persisted = _fbr_local_keyword_set(
            merchant,
            location,
            fbr_response,
        )
    except (FbrPayloadError, FbrUnavailableError) as exc:
        _fail_keyword_claim(conn, artifact_id, str(exc))
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    if persisted is None:
        detail = (
            "FBR has no persisted keywords for this GBP location; "
            "use the explicit regenerate action to create a new scored set"
        )
        _fail_keyword_claim(conn, artifact_id, detail)
        raise HTTPException(status_code=409, detail=detail)
    cycle_id = _persist_fbr_keyword_set(conn, artifact_id, place_id, persisted)
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
    merchant = fetch_active_merchant(conn, merchant_id)
    client, workflow = workflow_client
    artifact_id, cycle_id, _location, _place_id = _claim_keyword_cycle(
        conn,
        merchant,
        "regenerate",
    )
    cycle_id = _start_keyword_skill_cycle(
        conn,
        merchant,
        client,
        workflow,
        artifact_id,
        cycle_id,
    )
    return _state(conn, merchant_id, cycle_id)

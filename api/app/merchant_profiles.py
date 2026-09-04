import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .auth import require_operator
from .db import get_db
from .fbr_gbp import (
    GBP_FIELDS,
    FbrConfigurationError,
    FbrGbpClient,
    FbrPayloadError,
    FbrUnavailableError,
    fbr_gbp_client,
    normalize_gbp_location,
)
from .merchants import (
    fetch_active_merchant,
    fetch_merchant,
    merchant_has_active_work,
)

router = APIRouter(prefix="/api/merchants", tags=["merchant-profile"])
identity_router = APIRouter(
    prefix="/api/performance-identities",
    tags=["performance-identities"],
)


FIELD_COLUMNS = {
    "LOCATION": "location_json",
    "ATTRIBUTES": "attributes_json",
    "FOOD_MENUS": "food_menus_json",
    "LOCAL_POSTS": "local_posts_json",
    "MEDIA": "media_json",
    "CUSTOMER_MEDIA": "customer_media_json",
    "QUESTIONS": "questions_json",
    "PLACE_ACTION_LINKS": "place_action_links_json",
    "VERIFICATIONS": "verifications_json",
}

OPTIONAL_FIELD_LIST_KEYS = {
    "ATTRIBUTES": ("attributes",),
    "FOOD_MENUS": ("menus", "foodMenus"),
    "LOCAL_POSTS": ("posts", "localPosts"),
    "MEDIA": ("mediaItems", "media_items", "media"),
    "CUSTOMER_MEDIA": ("mediaItems", "media_items", "media"),
    "QUESTIONS": ("questions",),
    "PLACE_ACTION_LINKS": ("placeActionLinks", "place_action_links"),
    "VERIFICATIONS": ("verifications",),
}

GBP_SYNC_INTERVAL = timedelta(hours=1)
GBP_SYNC_LEASE_TIMEOUT = timedelta(minutes=15)


@dataclass(frozen=True)
class GbpSyncClaim:
    merchant_id: int
    merchant_status_generation: int
    merchant_status_content_sha256: str
    fbr_merchant_id: str
    binding_event_id: int
    canonical_fbr_merchant_sha256: str
    binding_content_sha256: str
    lease_started_at: str


class FbrLinkBody(BaseModel):
    fbr_merchant_id: str = Field(min_length=1, max_length=200)


class FbrRelinkRequestV1(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=200)
    merchant_id: int = Field(ge=1)
    expected_current_binding_generation: int = Field(ge=1)
    expected_current_fbr_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    new_fbr_merchant_id: str = Field(min_length=1, max_length=200)
    reason: str = Field(min_length=1, max_length=500)
    confirmed: Literal[True]

    @field_validator("request_id", "new_fbr_merchant_id", "reason", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _utc_now(current_time: datetime | None = None) -> datetime:
    value = current_time or datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _canonical_utc_instant(current_time: datetime | None = None) -> str:
    return _utc_now(current_time).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _canonical_json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _current_fbr_binding_checked(
    conn: sqlite3.Connection, merchant_id: int
) -> sqlite3.Row:
    state = conn.execute(
        "SELECT merchant_id FROM merchant_fbr_link_state WHERE merchant_id=?",
        (merchant_id,),
    ).fetchone()
    events = conn.execute(
        "SELECT * FROM merchant_fbr_binding_events "
        "WHERE merchant_id=? AND valid_to IS NULL",
        (merchant_id,),
    ).fetchall()
    projection = conn.execute(
        "SELECT fbr_merchant_id,binding_event_id FROM merchant_fbr_links "
        "WHERE merchant_id=?",
        (merchant_id,),
    ).fetchone()
    if state is None and not events and projection is None:
        raise HTTPException(status_code=409, detail="FBR Merchant ID 未绑定")
    if state is None or len(events) != 1 or projection is None:
        raise HTTPException(status_code=409, detail="FBR 绑定历史不一致")
    event = events[0]
    maximum_generation = conn.execute(
        "SELECT MAX(generation) FROM merchant_fbr_binding_events WHERE merchant_id=?",
        (merchant_id,),
    ).fetchone()[0]
    if (
        int(event["generation"]) != int(maximum_generation)
        or int(projection["binding_event_id"]) != int(event["id"])
        or projection["fbr_merchant_id"] != event["fbr_merchant_id"]
    ):
        raise HTTPException(status_code=409, detail="FBR 绑定历史不一致")
    return event


def _fbr_binding_response(event: sqlite3.Row) -> dict[str, object]:
    return {
        "event_id": int(event["id"]),
        "merchant_id": int(event["merchant_id"]),
        "fbr_merchant_id": str(event["fbr_merchant_id"]),
        "canonical_fbr_merchant_sha256": str(event["canonical_fbr_merchant_sha256"]),
        "generation": int(event["generation"]),
        "valid_from": str(event["valid_from"]),
        "valid_to": event["valid_to"],
        "content_sha256": str(event["content_sha256"]),
        "close_content_sha256": event["close_content_sha256"],
    }


def _commit_fbr_relink_command_result(
    conn: sqlite3.Connection,
    *,
    operator: str,
    request_id: str,
    envelope_json: str,
    envelope_sha256: str,
    target_stable_id: str,
    http_status: int,
    result: dict[str, object],
    fbr_binding_event_id: int | None,
    created_at: str,
) -> Response:
    """Persist and byte-freeze one deterministic FBR relink outcome."""

    result_json = _canonical_json(result)
    result_sha256 = _sha256_text(result_json)
    conn.execute(
        "INSERT INTO operator_command_ledger("
        "command_kind,requested_by,request_id,command_envelope_json,"
        "command_envelope_sha256,target_kind,target_stable_id,http_status,"
        "result_json,result_sha256,fbr_binding_event_id,created_at"
        ") VALUES ('FBR_RELINK',?,?,?,?,?,?,?,?,?,?,?)",
        (
            operator,
            request_id,
            envelope_json,
            envelope_sha256,
            "MERCHANT",
            target_stable_id,
            http_status,
            result_json,
            result_sha256,
            fbr_binding_event_id,
            created_at,
        ),
    )
    readback = conn.execute(
        "SELECT command_envelope_json,command_envelope_sha256,http_status,"
        "result_json,result_sha256,fbr_binding_event_id "
        "FROM operator_command_ledger WHERE requested_by=? AND request_id=?",
        (operator, request_id),
    ).fetchone()
    if (
        readback is None
        or readback["command_envelope_json"] != envelope_json
        or readback["command_envelope_sha256"] != envelope_sha256
        or int(readback["http_status"]) != http_status
        or readback["result_json"] != result_json
        or readback["result_sha256"] != result_sha256
        or readback["fbr_binding_event_id"] != fbr_binding_event_id
    ):
        raise RuntimeError("FBR relink command ledger readback failed")
    conn.commit()
    return Response(
        content=result_json,
        status_code=http_status,
        media_type="application/json",
    )


def _commit_fbr_relink_rejection(
    conn: sqlite3.Connection,
    *,
    operator: str,
    request_id: str,
    envelope_json: str,
    envelope_sha256: str,
    target_stable_id: str,
    status_code: int,
    detail: object,
    created_at: str,
) -> Response:
    if not 400 <= status_code < 500:
        raise RuntimeError("FBR relink rejection must be a deterministic 4xx")
    return _commit_fbr_relink_command_result(
        conn,
        operator=operator,
        request_id=request_id,
        envelope_json=envelope_json,
        envelope_sha256=envelope_sha256,
        target_stable_id=target_stable_id,
        http_status=status_code,
        result={"detail": detail},
        fbr_binding_event_id=None,
        created_at=created_at,
    )


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def gbp_sync_due(link: sqlite3.Row, current_time: datetime | None = None) -> bool:
    """Return whether a bound profile is eligible for an automatic sync."""
    current = _utc_now(current_time)
    status = link["sync_status"]
    if status == "not_synced":
        return True
    if status == "synced":
        anchor = _parse_timestamp(link["last_synced_at"])
        return anchor is None or current - anchor >= GBP_SYNC_INTERVAL
    if status == "failed":
        anchor = _parse_timestamp(link["updated_at"])
        return anchor is None or current - anchor >= GBP_SYNC_INTERVAL
    if status == "syncing":
        anchor = _parse_timestamp(link["updated_at"])
        return anchor is None or current - anchor >= GBP_SYNC_LEASE_TIMEOUT
    return False


def get_fbr_client() -> FbrGbpClient | None:
    try:
        return fbr_gbp_client()
    except FbrConfigurationError:
        return None


def _profile_response(conn: sqlite3.Connection, merchant_id: int) -> dict[str, Any]:
    fetch_merchant(conn, merchant_id)
    link = conn.execute(
        "SELECT link.*,event.generation AS binding_generation,"
        "event.canonical_fbr_merchant_sha256 AS binding_sha256 "
        "FROM merchant_fbr_links AS link "
        "JOIN merchant_fbr_binding_events AS event "
        "ON event.id=link.binding_event_id AND event.valid_to IS NULL "
        "WHERE link.merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    if link is None:
        return {
            "merchant_id": merchant_id,
            "state": "unbound",
            "fbr_merchant_id": None,
            "binding_generation": None,
            "binding_sha256": None,
            "sync_status": None,
            "last_synced_at": None,
            "last_error": None,
            "locations": [],
        }

    rows = conn.execute(
        "SELECT * FROM merchant_gbp_profiles WHERE merchant_id = ? ORDER BY source_title, gbp_location_id",
        (merchant_id,),
    ).fetchall()
    locations = []
    for row in rows:
        normalized = json.loads(row["normalized_json"])
        normalized.update(
            {
                "gbp_location_id": row["gbp_location_id"],
                "google_account_id": row["google_account_id"],
                "name": row["source_name"],
                "title": normalized.get("title") or row["source_title"],
                "source_updated_at": row["source_updated_at"],
                "synced_at": row["synced_at"],
            }
        )
        locations.append(normalized)
    return {
        "merchant_id": merchant_id,
        "state": link["sync_status"],
        "fbr_merchant_id": link["fbr_merchant_id"],
        "binding_generation": link["binding_generation"],
        "binding_sha256": link["binding_sha256"],
        "sync_status": link["sync_status"],
        "last_synced_at": link["last_synced_at"],
        "last_error": link["last_error"],
        "locations": locations,
    }


def _json_object(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return payload if isinstance(payload, dict) else None


def _collection_count(raw: str | None) -> int | None:
    payload = _json_object(raw)
    if payload is None:
        return None
    if isinstance(payload, list):
        return len(payload)
    for value in payload.values():
        if isinstance(value, list):
            return len(value)
    return 0


def _first_list(payload: dict[str, Any] | None, *keys: str) -> list[Any] | None:
    if payload is None:
        return None
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _label(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    labels = value.get("labels")
    if not isinstance(labels, list):
        return _safe_text(value.get("display_name")) or _safe_text(
            value.get("displayName")
        )
    for candidate in labels:
        if not isinstance(candidate, dict):
            continue
        text = _safe_text(candidate.get("display_name")) or _safe_text(
            candidate.get("displayName")
        )
        if text:
            return text
    return None


def _description(value: object) -> str | None:
    if not isinstance(value, dict):
        return None
    labels = value.get("labels")
    if not isinstance(labels, list):
        return _safe_text(value.get("description"))
    for candidate in labels:
        if not isinstance(candidate, dict):
            continue
        text = _safe_text(candidate.get("description"))
        if text:
            return text
    return None


def _price_amount(value: object) -> float | None:
    if not isinstance(value, dict):
        return None
    units = value.get("units")
    nanos = value.get("nanos")
    if units is None and nanos is None:
        return None
    try:
        units_value = float(units or 0)
        nanos_value = float(nanos or 0)
    except (TypeError, ValueError):
        return None
    return round(units_value + nanos_value / 1_000_000_000, 9)


def _menu_media_url(item: dict[str, Any]) -> str | None:
    media_keys = item.get("media_keys") or item.get("mediaKeys")
    if not isinstance(media_keys, list) or not media_keys:
        return None
    media_key = _safe_text(media_keys[0])
    if not media_key:
        return None
    if media_key.startswith("https://") or media_key.startswith("http://"):
        return media_key
    return f"https://lh3.googleusercontent.com/p/{media_key}"


def _menu_summary(raw: str | None) -> dict[str, Any]:
    menus = _first_list(_json_object(raw), "menus", "foodMenus")
    if menus is None:
        return {
            "menu_count": None,
            "menu_section_count": None,
            "menu_item_count": None,
            "menu_sections": [],
            "menu_items": [],
        }
    section_summaries: list[dict[str, Any]] = []
    menu_items: list[dict[str, Any]] = []
    item_count = 0
    for menu in menus:
        if not isinstance(menu, dict):
            continue
        sections = menu.get("sections")
        if not isinstance(sections, list):
            continue
        for index, section in enumerate(sections, start=1):
            if not isinstance(section, dict):
                continue
            items = section.get("items")
            count = len(items) if isinstance(items, list) else 0
            item_count += count
            section_name = _label(section) or f"分类 {index}"
            section_summaries.append({"name": section_name, "item_count": count})
            for item in items if isinstance(items, list) else []:
                if not isinstance(item, dict):
                    continue
                price = item.get("price")
                menu_items.append(
                    {
                        "section_name": section_name,
                        "name": _label(item) or "未命名菜品",
                        "description": _description(item),
                        "price_amount": _price_amount(price),
                        "currency_code": _safe_text(price.get("currency_code"))
                        or _safe_text(price.get("currencyCode"))
                        if isinstance(price, dict)
                        else None,
                        "media_url": _menu_media_url(item),
                    }
                )
    return {
        "menu_count": len(menus),
        "menu_section_count": len(section_summaries),
        "menu_item_count": item_count,
        "menu_sections": section_summaries,
        "menu_items": menu_items,
    }


def _post_summary(raw: str | None) -> dict[str, Any]:
    posts = _first_list(_json_object(raw), "posts", "localPosts")
    if posts is None:
        return {"post_count": None, "live_post_count": None, "recent_posts": []}
    recent_posts = []
    live_count = 0
    for post in posts:
        if not isinstance(post, dict):
            continue
        state = _safe_text(post.get("state"))
        if state == "LIVE":
            live_count += 1
        media = post.get("media")
        first_media = (
            media[0]
            if isinstance(media, list) and media and isinstance(media[0], dict)
            else {}
        )
        call_to_action = post.get("call_to_action") or post.get("callToAction")
        call_to_action = call_to_action if isinstance(call_to_action, dict) else {}
        recent_posts.append(
            {
                "post_id": _safe_text(post.get("post_id"))
                or _safe_text(post.get("postId")),
                "state": state,
                "summary": _safe_text(post.get("summary")),
                "created_at": _safe_text(post.get("create_time"))
                or _safe_text(post.get("createTime")),
                "updated_at": _safe_text(post.get("update_time"))
                or _safe_text(post.get("updateTime")),
                "media_count": len(media) if isinstance(media, list) else 0,
                "media_url": _safe_text(first_media.get("google_url"))
                or _safe_text(first_media.get("googleUrl")),
                "media_format": _safe_text(first_media.get("media_format"))
                or _safe_text(first_media.get("mediaFormat")),
                "cta_type": _safe_text(call_to_action.get("action_type"))
                or _safe_text(call_to_action.get("actionType")),
                "cta_url": _safe_text(call_to_action.get("url")),
            }
        )
    return {
        "post_count": len(posts),
        "live_post_count": live_count,
        "recent_posts": recent_posts,
    }


def _rating(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    if isinstance(value, str):
        named = {"ONE": 1.0, "TWO": 2.0, "THREE": 3.0, "FOUR": 4.0, "FIVE": 5.0}
        if value.upper() in named:
            return named[value.upper()]
        try:
            return float(value)
        except ValueError:
            return None
    return None


def _review_summary(payload: dict[str, Any] | None) -> dict[str, Any]:
    reviews = _first_list(payload, "reviews")
    if reviews is None:
        return {"review_count": None, "recent_reviews": []}
    recent_reviews = []
    for review in reviews:
        if not isinstance(review, dict):
            continue
        reviewer = review.get("reviewer")
        reviewer_name = (
            _safe_text(review.get("reviewer_name"))
            or _safe_text(review.get("reviewerName"))
            or (
                _safe_text(reviewer.get("display_name"))
                if isinstance(reviewer, dict)
                else None
            )
            or (
                _safe_text(reviewer.get("displayName"))
                if isinstance(reviewer, dict)
                else None
            )
        )
        reply = (
            review.get("reply")
            or review.get("review_reply")
            or review.get("reviewReply")
        )
        recent_reviews.append(
            {
                "review_id": _safe_text(review.get("google_review_id"))
                or _safe_text(review.get("reviewId")),
                "rating": _rating(
                    review.get("rating")
                    if "rating" in review
                    else review.get("star_rating")
                ),
                "content": _safe_text(review.get("content"))
                or _safe_text(review.get("comment")),
                "reviewer_name": reviewer_name,
                "created_at": _safe_text(review.get("created_time"))
                or _safe_text(review.get("createTime")),
                "has_reply": bool(reply),
            }
        )
    total = payload.get("total") if payload else None
    review_count = (
        total
        if isinstance(total, int) and not isinstance(total, bool)
        else len(reviews)
    )
    return {"review_count": review_count, "recent_reviews": recent_reviews[:5]}


def _attribute_count(raw: str | None) -> int | None:
    attributes = _first_list(_json_object(raw), "attributes")
    if attributes is None:
        return None
    populated = 0
    for attribute in attributes:
        if not isinstance(attribute, dict):
            continue
        values = (
            attribute.get("values")
            or attribute.get("uri_values")
            or attribute.get("uriValues")
            or attribute.get("repeated_enum_value")
            or attribute.get("repeatedEnumValue")
        )
        if values:
            populated += 1
    return populated


def _safe_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _month_key(value: date) -> str:
    return f"{value.year:04d}-{value.month:02d}"


def _months_ago(value: date, count: int) -> date:
    month_index = value.year * 12 + value.month - 1 - count
    return date(month_index // 12, month_index % 12 + 1, 1)


def _insight_rows(payload: dict[str, Any] | None, key: str) -> list[dict[str, Any]]:
    values = _first_list(payload, key)
    if values is None:
        return []
    return [value for value in values if isinstance(value, dict)]


def _has_list(payload: object, *keys: str) -> bool:
    if not isinstance(payload, dict):
        return False
    for key in keys:
        values = payload.get(key)
        if isinstance(values, list):
            return all(isinstance(value, dict) for value in values)
    return False


def _optional_field_payload_ready(field: str, raw: object) -> bool:
    if not isinstance(raw, str) or not raw.strip():
        return False
    payload = _json_object(raw)
    keys = OPTIONAL_FIELD_LIST_KEYS.get(field)
    return payload is not None and keys is not None and _has_list(payload, *keys)


def _review_payload_ready(payload: object) -> bool:
    if not _has_list(payload, "reviews"):
        return False
    total = payload.get("total")
    return isinstance(total, int) and not isinstance(total, bool) and total >= 0


def _review_overview_payload_ready(payload: object) -> bool:
    if not _has_list(payload, "reviews"):
        return False
    count = payload.get("current_month_review_count")
    if not isinstance(count, int) or isinstance(count, bool) or count < 0:
        return False
    rating = payload.get("current_month_rating")
    if rating is not None and _rating(rating) is None:
        return False
    reply_rate = payload.get("reply_rate")
    return reply_rate is None or (
        isinstance(reply_rate, (int, float)) and not isinstance(reply_rate, bool)
    )


def _location_payload_meaningful(normalized: dict[str, Any]) -> bool:
    scalar_fact = any(
        normalized.get(key)
        for key in (
            "title",
            "store_code",
            "phone",
            "address",
            "website_url",
            "primary_category",
            "open_status",
            "description",
        )
    )
    hours = normalized.get("regular_hours")
    meaningful_hours = isinstance(hours, list) and any(
        isinstance(period, dict) and any(period.values()) for period in hours
    )
    return scalar_fact or meaningful_hours


def _fetch_location(
    client: FbrGbpClient,
    fbr_merchant_id: str,
    identity: dict[str, Any],
    previous_snapshot: sqlite3.Row | None = None,
    *,
    query_time: datetime | None = None,
):
    gbp_location_id = _safe_text(identity.get("gbp_location_id"))
    place_id = _safe_text(identity.get("place_id"))
    if not gbp_location_id:
        raise FbrPayloadError("FBR GBP location is missing gbp_location_id")
    previous_normalized = (
        _json_object(previous_snapshot["normalized_json"])
        if previous_snapshot is not None
        else None
    ) or {}
    place_id = place_id or _safe_text(previous_normalized.get("place_id"))
    google_account_id = _safe_text(identity.get("google_account_id")) or (
        _safe_text(previous_snapshot["google_account_id"])
        if previous_snapshot is not None
        else None
    )
    source_name = _safe_text(identity.get("name")) or (
        _safe_text(previous_snapshot["source_name"])
        if previous_snapshot is not None
        else None
    )
    source_title = _safe_text(identity.get("title")) or (
        _safe_text(previous_snapshot["source_title"])
        if previous_snapshot is not None
        else None
    )
    fields: dict[str, str | None] = {
        field: previous_snapshot[FIELD_COLUMNS[field]]
        if previous_snapshot is not None
        else None
        for field in GBP_FIELDS
    }
    normalized_location: dict[str, Any] | None = None
    source_times: list[str] = []
    for field in GBP_FIELDS:
        try:
            response = client.get_field(fbr_merchant_id, gbp_location_id, field)
        except (FbrUnavailableError, FbrPayloadError):
            if field == "LOCATION":
                raise
            continue
        raw = response.get("value")
        if field == "LOCATION":
            if not isinstance(raw, str) or not raw.strip():
                raise FbrPayloadError("FBR LOCATION field value is invalid")
            normalized_location = normalize_gbp_location(raw)
            if not _location_payload_meaningful(normalized_location):
                raise FbrPayloadError("FBR LOCATION field value is incomplete")
        elif not _optional_field_payload_ready(field, raw):
            continue
        fields[field] = raw
        updated_at = _safe_text(response.get("updated_time"))
        if updated_at:
            source_times.append(updated_at)

    today = _utc_now(query_time).date()
    reviews: dict[str, Any] | None = None
    review_sync_status = "unavailable"
    review_scope: str | None = None
    review_average_rating: float | None = None
    review_reply_rate: float | None = None
    review_source_ready = False
    persisted_review_ready = False
    try:
        review_payload = client.get_reviews(fbr_merchant_id, gbp_location_id)
        if _review_payload_ready(review_payload):
            reviews = review_payload
            persisted_review_ready = True
    except (FbrUnavailableError, FbrPayloadError):
        pass

    persisted_review_total = reviews.get("total") if persisted_review_ready else None
    if not persisted_review_ready or persisted_review_total == 0:
        try:
            overview = client.get_review_overview(
                fbr_merchant_id,
                gbp_location_id,
                query_date=today.isoformat(),
            )
        except (FbrUnavailableError, FbrPayloadError):
            overview = None
        if _review_overview_payload_ready(overview):
            overview_count = overview.get("current_month_review_count")
            overview_reviews = _first_list(overview, "reviews")
            reviews = {
                "total": overview_count,
                "reviews": [
                    {
                        "rating": item.get("rating"),
                        "content": item.get("content"),
                        "reply": item.get("reply_content"),
                    }
                    for item in (overview_reviews or [])
                    if isinstance(item, dict)
                ],
            }
            review_source_ready = True
            review_sync_status = "ready"
            review_scope = "recent_month"
            review_average_rating = _rating(overview.get("current_month_rating"))
            reply_rate = overview.get("reply_rate")
            if isinstance(reply_rate, (int, float)) and not isinstance(
                reply_rate, bool
            ):
                review_reply_rate = float(reply_rate)
    if persisted_review_ready and persisted_review_total != 0:
        review_source_ready = True
        review_sync_status = "ready"
        review_scope = "all_synced"

    performance: dict[str, Any] | None = None
    search_keywords: dict[str, Any] | None = None
    performance_source_ready = False
    search_keyword_source_ready = False
    if place_id:
        try:
            performance = client.list_performance_metrics(
                fbr_merchant_id,
                place_id,
                from_date=(today - timedelta(days=30)).isoformat(),
                to_date=today.isoformat(),
            )
            performance_source_ready = _has_list(performance, "metrics")
        except (FbrUnavailableError, FbrPayloadError):
            pass
        try:
            search_keywords = client.list_search_keyword_metrics(
                fbr_merchant_id,
                place_id,
                from_month=_month_key(_months_ago(today, 2)),
                to_month=_month_key(today),
            )
            search_keyword_source_ready = _has_list(search_keywords, "keywords")
        except (FbrUnavailableError, FbrPayloadError):
            pass

    if normalized_location is None:
        raise FbrPayloadError("FBR LOCATION field value is missing")
    normalized = normalized_location
    menu = _menu_summary(fields["FOOD_MENUS"])
    posts = _post_summary(fields["LOCAL_POSTS"])
    review_values = {
        **_review_summary(reviews),
        "review_sync_status": review_sync_status,
        "review_scope": review_scope,
        "review_average_rating": review_average_rating,
        "review_reply_rate": review_reply_rate,
    }
    if not review_source_ready:
        for key in tuple(review_values):
            if key in previous_normalized:
                review_values[key] = previous_normalized[key]
    performance_metrics = _insight_rows(performance, "metrics")
    if not performance_source_ready:
        performance_metrics = previous_normalized.get(
            "performance_metrics",
            performance_metrics,
        )
    search_keyword_metrics = _insight_rows(search_keywords, "keywords")
    if not search_keyword_source_ready:
        search_keyword_metrics = previous_normalized.get(
            "search_keywords",
            search_keyword_metrics,
        )
    source_updated_at = max(source_times) if source_times else None
    if source_updated_at is None and previous_snapshot is not None:
        source_updated_at = previous_snapshot["source_updated_at"]
    normalized.update(
        {
            "place_id": place_id,
            "attribute_count": _attribute_count(fields["ATTRIBUTES"]),
            **menu,
            **posts,
            **review_values,
            "media_count": _collection_count(fields["MEDIA"]),
            "customer_media_count": _collection_count(fields["CUSTOMER_MEDIA"]),
            "question_count": _collection_count(fields["QUESTIONS"]),
            "place_action_link_count": _collection_count(fields["PLACE_ACTION_LINKS"]),
            "verification_count": _collection_count(fields["VERIFICATIONS"]),
            "performance_metrics": performance_metrics,
            "search_keywords": search_keyword_metrics,
        }
    )
    return {
        "gbp_location_id": gbp_location_id,
        "google_account_id": google_account_id,
        "source_name": source_name,
        "source_title": source_title,
        "fields": fields,
        "normalized_json": json.dumps(
            normalized, ensure_ascii=False, separators=(",", ":")
        ),
        "source_updated_at": source_updated_at,
        "synced_at": None,
    }


@router.get("/{merchant_id}/profile")
def get_profile(merchant_id: int, conn=Depends(get_db)):
    return _profile_response(conn, merchant_id)


@router.put("/{merchant_id}/fbr-link")
def put_fbr_link(
    merchant_id: int,
    body: FbrLinkBody,
    conn=Depends(get_db),
    operator: str = Depends(require_operator),
):
    fbr_merchant_id = body.fbr_merchant_id.strip()
    if not fbr_merchant_id:
        raise HTTPException(status_code=422, detail="FBR Merchant ID 不能为空")
    conn.execute("BEGIN IMMEDIATE")
    try:
        fetch_active_merchant(conn, merchant_id)
        current = conn.execute(
            "SELECT fbr_merchant_id FROM merchant_fbr_links WHERE merchant_id=?",
            (merchant_id,),
        ).fetchone()
        if current is not None:
            if current["fbr_merchant_id"] != fbr_merchant_id:
                raise HTTPException(
                    status_code=409,
                    detail="FBR Merchant ID 已绑定；请使用重新绑定流程",
                )
            conn.commit()
            return _profile_response(conn, merchant_id)
        partial = conn.execute(
            "SELECT 1 FROM merchant_fbr_binding_events WHERE merchant_id=? "
            "UNION ALL SELECT 1 FROM merchant_fbr_link_state WHERE merchant_id=? LIMIT 1",
            (merchant_id, merchant_id),
        ).fetchone()
        if partial is not None:
            raise HTTPException(
                status_code=409,
                detail="FBR 绑定历史不一致；请先修复绑定状态",
            )

        now = _canonical_utc_instant()
        conn.execute(
            "INSERT INTO merchant_fbr_binding_events("
            "merchant_id,fbr_merchant_id,generation,valid_from,opened_by,open_reason,created_at"
            ") VALUES (?,?,1,?,?,'initial_fbr_link',?)",
            (merchant_id, fbr_merchant_id, now, operator, now),
        )
        conn.execute(
            "INSERT INTO merchant_fbr_link_state("
            "merchant_id,sync_status,last_synced_at,last_error,created_at,updated_at"
            ") VALUES (?,'not_synced',NULL,NULL,?,?)",
            (merchant_id, now, now),
        )
        conn.execute(
            "DELETE FROM merchant_gbp_profiles WHERE merchant_id = ?", (merchant_id,)
        )
        projected = conn.execute(
            "SELECT fbr_merchant_id FROM merchant_fbr_links WHERE merchant_id=?",
            (merchant_id,),
        ).fetchone()
        if projected is None or projected["fbr_merchant_id"] != fbr_merchant_id:
            raise RuntimeError("FBR binding projection readback failed")
        conn.commit()
    except HTTPException:
        conn.rollback()
        raise
    except sqlite3.IntegrityError as exc:
        conn.rollback()
        if "fbr_identity_interval_overlap" in str(
            exc
        ) or "merchant_fbr_binding_events.fbr_merchant_id" in str(exc):
            raise HTTPException(
                status_code=409,
                detail="FBR Merchant ID 已绑定到其他商户",
            ) from exc
        raise
    except Exception:
        conn.rollback()
        raise
    return _profile_response(conn, merchant_id)


@identity_router.post("/fbr/relink")
def relink_fbr_merchant(
    body: FbrRelinkRequestV1,
    conn=Depends(get_db),
    operator: str = Depends(require_operator),
) -> Response:
    request_payload = body.model_dump(mode="json")
    envelope_json = _canonical_json(
        {
            "command_kind": "FBR_RELINK",
            "request": request_payload,
            "schema_version": "seo_ops.fbr_relink_command.v1",
        }
    )
    envelope_sha256 = _sha256_text(envelope_json)
    target_stable_id = str(body.merchant_id)

    conn.execute("BEGIN IMMEDIATE")
    try:
        # Idempotency is the first database decision. A network replay must not
        # be reinterpreted against a later binding, lifecycle, or server clock.
        previous_command = conn.execute(
            "SELECT * FROM operator_command_ledger "
            "WHERE requested_by=? AND request_id=?",
            (operator, body.request_id),
        ).fetchone()
        if previous_command is not None:
            if (
                previous_command["command_kind"] != "FBR_RELINK"
                or previous_command["target_kind"] != "MERCHANT"
                or previous_command["target_stable_id"] != target_stable_id
                or previous_command["command_envelope_json"] != envelope_json
                or previous_command["command_envelope_sha256"] != envelope_sha256
            ):
                raise HTTPException(status_code=409, detail="request_id_body_conflict")
            result_json = str(previous_command["result_json"])
            if _sha256_text(result_json) != previous_command["result_sha256"]:
                raise RuntimeError("FBR relink command result readback failed")
            status_code = int(previous_command["http_status"])
            conn.commit()
            return Response(
                content=result_json,
                status_code=status_code,
                media_type="application/json",
            )

        command_at = _canonical_utc_instant()
        try:
            fetch_active_merchant(conn, body.merchant_id)
        except HTTPException as exc:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=exc.status_code,
                detail=exc.detail,
                created_at=command_at,
            )
        if merchant_has_active_work(conn, body.merchant_id):
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="merchant has active work; resolve it before relinking FBR",
                created_at=command_at,
            )
        try:
            current = _current_fbr_binding_checked(conn, body.merchant_id)
        except HTTPException as exc:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=exc.status_code,
                detail=exc.detail,
                created_at=command_at,
            )
        if (
            int(current["generation"]) != body.expected_current_binding_generation
            or current["canonical_fbr_merchant_sha256"]
            != body.expected_current_fbr_sha256
        ):
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="stale_fbr_binding",
                created_at=command_at,
            )
        if current["fbr_merchant_id"] == body.new_fbr_merchant_id:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="new_fbr_identity_matches_current",
                created_at=command_at,
            )
        conflicting_owner = conn.execute(
            "SELECT merchant_id FROM merchant_fbr_binding_events "
            "WHERE fbr_merchant_id=? AND valid_to IS NULL LIMIT 1",
            (body.new_fbr_merchant_id,),
        ).fetchone()
        if conflicting_owner is not None:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="FBR Merchant ID 已绑定到其他商户",
                created_at=command_at,
            )

        effective_at = command_at
        if effective_at <= current["valid_from"]:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="fbr_relink_clock_not_monotonic",
                created_at=command_at,
            )
        closed = conn.execute(
            "UPDATE merchant_fbr_binding_events "
            "SET valid_to=?,closed_by=?,close_reason=? "
            "WHERE id=? AND merchant_id=? AND generation=? AND valid_to IS NULL "
            "AND canonical_fbr_merchant_sha256=?",
            (
                effective_at,
                operator,
                body.reason,
                current["id"],
                body.merchant_id,
                body.expected_current_binding_generation,
                body.expected_current_fbr_sha256,
            ),
        )
        if closed.rowcount != 1:
            return _commit_fbr_relink_rejection(
                conn,
                operator=operator,
                request_id=body.request_id,
                envelope_json=envelope_json,
                envelope_sha256=envelope_sha256,
                target_stable_id=target_stable_id,
                status_code=409,
                detail="stale_fbr_binding",
                created_at=command_at,
            )

        inserted = conn.execute(
            "INSERT INTO merchant_fbr_binding_events("
            "merchant_id,fbr_merchant_id,generation,valid_from,opened_by,open_reason,created_at"
            ") VALUES (?,?,?,?,?,?,?)",
            (
                body.merchant_id,
                body.new_fbr_merchant_id,
                body.expected_current_binding_generation + 1,
                effective_at,
                operator,
                body.reason,
                effective_at,
            ),
        )
        replacement_event_id = int(inserted.lastrowid)
        reset = conn.execute(
            "UPDATE merchant_fbr_link_state SET sync_status='not_synced',"
            "last_synced_at=NULL,last_error=NULL,updated_at=? WHERE merchant_id=?",
            (effective_at, body.merchant_id),
        )
        if reset.rowcount != 1:
            raise RuntimeError("FBR link-state reset readback failed")

        replacement = _current_fbr_binding_checked(conn, body.merchant_id)
        projection = conn.execute(
            "SELECT binding_event_id FROM merchant_fbr_links WHERE merchant_id=?",
            (body.merchant_id,),
        ).fetchone()
        if (
            int(replacement["id"]) != replacement_event_id
            or int(replacement["generation"])
            != body.expected_current_binding_generation + 1
            or replacement["fbr_merchant_id"] != body.new_fbr_merchant_id
            or int(projection["binding_event_id"]) != replacement_event_id
        ):
            raise RuntimeError("FBR replacement projection readback failed")

        # These rows are replaceable current snapshots. Historical binding,
        # observations, reports, and source-scope records are retained.
        conn.execute(
            "DELETE FROM merchant_gbp_profiles WHERE merchant_id=?",
            (body.merchant_id,),
        )
        result = {
            "request_id": body.request_id,
            "previous_event_id": int(current["id"]),
            "binding": _fbr_binding_response(replacement),
            "projection_binding_event_id": replacement_event_id,
        }
        return _commit_fbr_relink_command_result(
            conn,
            operator=operator,
            request_id=body.request_id,
            envelope_json=envelope_json,
            envelope_sha256=envelope_sha256,
            target_stable_id=target_stable_id,
            http_status=200,
            result=result,
            fbr_binding_event_id=replacement_event_id,
            created_at=effective_at,
        )
    except HTTPException:
        conn.rollback()
        raise
    except Exception:
        conn.rollback()
        raise


def _claim_gbp_sync(
    conn: sqlite3.Connection,
    merchant_id: int,
    *,
    force: bool,
    current_time: datetime,
) -> GbpSyncClaim | None:
    fetch_active_merchant(conn, merchant_id)
    lifecycle = conn.execute(
        "SELECT status,generation,content_sha256 FROM merchant_status_events "
        "WHERE merchant_id=? ORDER BY generation DESC LIMIT 1",
        (merchant_id,),
    ).fetchone()
    if lifecycle is None or lifecycle["status"] != "active":
        raise HTTPException(
            status_code=409,
            detail="商户生命周期记录与当前状态不一致",
        )
    link = conn.execute(
        "SELECT link.*,event.canonical_fbr_merchant_sha256,event.content_sha256 "
        "FROM merchant_fbr_links AS link "
        "JOIN merchant_fbr_binding_events AS event ON event.id=link.binding_event_id "
        "WHERE link.merchant_id = ? AND event.valid_to IS NULL",
        (merchant_id,),
    ).fetchone()
    if link is None:
        raise HTTPException(status_code=409, detail="请先绑定 FBR Merchant ID")

    # A recent syncing row is an active lease. A stale one can be reclaimed by
    # either the scheduler or a manual retry after the lease timeout.
    if link["sync_status"] == "syncing" and not gbp_sync_due(link, current_time):
        return None
    if not force and not gbp_sync_due(link, current_time):
        return None

    lease_started_at = current_time.isoformat()
    claimed = conn.execute(
        "UPDATE merchant_fbr_link_state"
        " SET sync_status = 'syncing', last_error = NULL, updated_at = ?"
        " WHERE merchant_id = ?"
        " AND sync_status = ? AND updated_at = ?"
        " AND EXISTS (SELECT 1 FROM merchant_fbr_binding_events AS event"
        "             WHERE event.id = ?"
        "               AND event.merchant_id = merchant_fbr_link_state.merchant_id"
        "               AND event.fbr_merchant_id = ?"
        "               AND event.canonical_fbr_merchant_sha256 = ?"
        "               AND event.content_sha256 = ?"
        "               AND event.valid_to IS NULL)"
        " AND EXISTS (SELECT 1 FROM merchants"
        "             WHERE merchants.id = merchant_fbr_link_state.merchant_id"
        "               AND merchants.status = 'active')"
        " AND EXISTS (SELECT 1 FROM merchant_status_events AS status_event"
        "             WHERE status_event.merchant_id = merchant_fbr_link_state.merchant_id"
        "               AND status_event.status = 'active'"
        "               AND status_event.generation = ?"
        "               AND status_event.content_sha256 = ?"
        "               AND status_event.generation = ("
        "                 SELECT MAX(current_event.generation)"
        "                 FROM merchant_status_events AS current_event"
        "                 WHERE current_event.merchant_id = merchant_fbr_link_state.merchant_id))"
        " RETURNING merchant_id",
        (
            lease_started_at,
            merchant_id,
            link["sync_status"],
            link["updated_at"],
            link["binding_event_id"],
            link["fbr_merchant_id"],
            link["canonical_fbr_merchant_sha256"],
            link["content_sha256"],
            lifecycle["generation"],
            lifecycle["content_sha256"],
        ),
    ).fetchone()
    conn.commit()
    if claimed is None:
        return None
    return GbpSyncClaim(
        merchant_id=merchant_id,
        merchant_status_generation=int(lifecycle["generation"]),
        merchant_status_content_sha256=lifecycle["content_sha256"],
        fbr_merchant_id=link["fbr_merchant_id"],
        binding_event_id=link["binding_event_id"],
        canonical_fbr_merchant_sha256=link["canonical_fbr_merchant_sha256"],
        binding_content_sha256=link["content_sha256"],
        lease_started_at=lease_started_at,
    )


def _claim_where_sql() -> str:
    return (
        " merchant_id = ?"
        " AND sync_status = 'syncing' AND updated_at = ?"
        " AND EXISTS (SELECT 1 FROM merchant_fbr_binding_events AS event"
        "             WHERE event.id = ?"
        "               AND event.merchant_id = merchant_fbr_link_state.merchant_id"
        "               AND event.fbr_merchant_id = ?"
        "               AND event.canonical_fbr_merchant_sha256 = ?"
        "               AND event.content_sha256 = ?"
        "               AND event.valid_to IS NULL)"
        " AND EXISTS (SELECT 1 FROM merchants"
        "             WHERE merchants.id = merchant_fbr_link_state.merchant_id"
        "               AND merchants.status = 'active')"
        " AND EXISTS (SELECT 1 FROM merchant_status_events AS status_event"
        "             WHERE status_event.merchant_id = merchant_fbr_link_state.merchant_id"
        "               AND status_event.status = 'active'"
        "               AND status_event.generation = ?"
        "               AND status_event.content_sha256 = ?"
        "               AND status_event.generation = ("
        "                 SELECT MAX(current_event.generation)"
        "                 FROM merchant_status_events AS current_event"
        "                 WHERE current_event.merchant_id = merchant_fbr_link_state.merchant_id))"
    )


def _claim_where_params(claim: GbpSyncClaim) -> tuple[Any, ...]:
    return (
        claim.merchant_id,
        claim.lease_started_at,
        claim.binding_event_id,
        claim.fbr_merchant_id,
        claim.canonical_fbr_merchant_sha256,
        claim.binding_content_sha256,
        claim.merchant_status_generation,
        claim.merchant_status_content_sha256,
    )


def _mark_gbp_sync_failed(
    conn: sqlite3.Connection,
    claim: GbpSyncClaim,
    message: str,
    failed_at: datetime,
) -> bool:
    if conn.in_transaction:
        conn.rollback()
    updated = conn.execute(
        "UPDATE merchant_fbr_link_state"
        " SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE"
        + _claim_where_sql()
        + " RETURNING merchant_id",
        (
            message,
            failed_at.isoformat(),
            *_claim_where_params(claim),
        ),
    ).fetchone()
    conn.commit()
    return updated is not None


def _persist_gbp_snapshots(
    conn: sqlite3.Connection,
    claim: GbpSyncClaim,
    snapshots: list[dict[str, Any]],
    synced_at: str,
) -> bool:
    # Acquire the writer lock only after all network reads have completed. The
    # lease tuple is the fence: rebinding or a newer lease makes this a no-op.
    conn.execute("BEGIN IMMEDIATE")
    owned = conn.execute(
        "SELECT 1 FROM merchant_fbr_link_state WHERE" + _claim_where_sql(),
        _claim_where_params(claim),
    ).fetchone()
    if owned is None:
        conn.rollback()
        return False

    conn.execute(
        "DELETE FROM merchant_gbp_profiles WHERE merchant_id = ?",
        (claim.merchant_id,),
    )
    for snapshot in snapshots:
        fields = snapshot["fields"]
        conn.execute(
            "INSERT INTO merchant_gbp_profiles"
            " (merchant_id, fbr_merchant_id, gbp_location_id, google_account_id, source_name, source_title,"
            " location_json, attributes_json, food_menus_json, local_posts_json, media_json, customer_media_json,"
            " questions_json, place_action_links_json, verifications_json, normalized_json, source_updated_at, synced_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                claim.merchant_id,
                claim.fbr_merchant_id,
                snapshot["gbp_location_id"],
                snapshot["google_account_id"],
                snapshot["source_name"],
                snapshot["source_title"],
                fields["LOCATION"],
                fields["ATTRIBUTES"],
                fields["FOOD_MENUS"],
                fields["LOCAL_POSTS"],
                fields["MEDIA"],
                fields["CUSTOMER_MEDIA"],
                fields["QUESTIONS"],
                fields["PLACE_ACTION_LINKS"],
                fields["VERIFICATIONS"],
                snapshot["normalized_json"],
                snapshot["source_updated_at"],
                snapshot["synced_at"],
            ),
        )
    finished = conn.execute(
        "UPDATE merchant_fbr_link_state"
        " SET sync_status = 'synced', last_synced_at = ?, last_error = NULL, updated_at = ?"
        " WHERE" + _claim_where_sql() + " RETURNING merchant_id",
        (
            synced_at,
            synced_at,
            *_claim_where_params(claim),
        ),
    ).fetchone()
    if finished is None:
        conn.rollback()
        return False
    conn.commit()
    return True


def sync_gbp_profile_once(
    conn: sqlite3.Connection,
    client: FbrGbpClient | None,
    merchant_id: int,
    *,
    force: bool = False,
    current_time: datetime | None = None,
) -> bool:
    """Synchronize one merchant using a short CAS lease and fenced writes.

    No database transaction remains open while the FBR service is called.
    False means the profile was not due, another worker owns a fresh lease, or
    the binding changed while the remote read was in flight.
    """
    current = _utc_now(current_time)
    claim = _claim_gbp_sync(
        conn,
        merchant_id,
        force=force,
        current_time=current,
    )
    if claim is None:
        return False

    try:
        if client is None:
            raise FbrConfigurationError("FBR SEO integration is not configured")
        previous_rows = conn.execute(
            "SELECT * FROM merchant_gbp_profiles WHERE merchant_id = ?",
            (claim.merchant_id,),
        ).fetchall()
        previous_by_location = {row["gbp_location_id"]: row for row in previous_rows}
        identities = client.list_locations(claim.fbr_merchant_id)
        if not identities and previous_by_location:
            raise FbrPayloadError("FBR returned an empty GBP location list")
        returned_location_ids = {
            location_id
            for identity in identities
            if (location_id := _safe_text(identity.get("gbp_location_id")))
        }
        if set(previous_by_location) - returned_location_ids:
            raise FbrPayloadError("FBR returned an incomplete GBP location list")
        snapshots = [
            _fetch_location(
                client,
                claim.fbr_merchant_id,
                identity,
                previous_by_location.get(_safe_text(identity.get("gbp_location_id"))),
                query_time=current,
            )
            for identity in identities
        ]
        finished_at = current if current_time is not None else _utc_now()
        synced_at = finished_at.isoformat()
        for snapshot in snapshots:
            snapshot["synced_at"] = synced_at
        return _persist_gbp_snapshots(conn, claim, snapshots, synced_at)
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        _mark_gbp_sync_failed(
            conn,
            claim,
            message,
            current if current_time is not None else _utc_now(),
        )
        raise


@router.post("/{merchant_id}/gbp-sync")
def sync_gbp_profile(
    merchant_id: int,
    client: FbrGbpClient | None = Depends(get_fbr_client),
    conn=Depends(get_db),
):
    try:
        completed = sync_gbp_profile_once(
            conn,
            client,
            merchant_id,
            force=True,
        )
    except (FbrUnavailableError, FbrPayloadError, FbrConfigurationError) as exc:
        message = str(exc)
        detail = (
            message
            if isinstance(exc, FbrConfigurationError)
            else f"{message}; last successful data was preserved"
        )
        raise HTTPException(
            status_code=503,
            detail=detail,
        ) from exc
    if not completed:
        raise HTTPException(
            status_code=409,
            detail="GBP sync is already running or the FBR binding changed",
        )
    return _profile_response(conn, merchant_id)

import json
import sqlite3
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

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
from .merchants import fetch_merchant

router = APIRouter(prefix="/api/merchants", tags=["merchant-profile"])


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


class FbrLinkBody(BaseModel):
    fbr_merchant_id: str = Field(min_length=1, max_length=200)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_fbr_client() -> FbrGbpClient | None:
    try:
        return fbr_gbp_client()
    except FbrConfigurationError:
        return None


def _profile_response(conn: sqlite3.Connection, merchant_id: int) -> dict[str, Any]:
    fetch_merchant(conn, merchant_id)
    link = conn.execute(
        "SELECT * FROM merchant_fbr_links WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    if link is None:
        return {
            "merchant_id": merchant_id,
            "state": "unbound",
            "fbr_merchant_id": None,
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
        return _safe_text(value.get("display_name")) or _safe_text(value.get("displayName"))
    for candidate in labels:
        if not isinstance(candidate, dict):
            continue
        text = _safe_text(candidate.get("display_name")) or _safe_text(candidate.get("displayName"))
        if text:
            return text
    return None


def _menu_summary(raw: str | None) -> dict[str, Any]:
    menus = _first_list(_json_object(raw), "menus", "foodMenus")
    if menus is None:
        return {
            "menu_count": None,
            "menu_section_count": None,
            "menu_item_count": None,
            "menu_sections": [],
        }
    section_summaries: list[dict[str, Any]] = []
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
            section_summaries.append(
                {"name": _label(section) or f"分类 {index}", "item_count": count}
            )
    return {
        "menu_count": len(menus),
        "menu_section_count": len(section_summaries),
        "menu_item_count": item_count,
        "menu_sections": section_summaries,
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
        first_media = media[0] if isinstance(media, list) and media and isinstance(media[0], dict) else {}
        call_to_action = post.get("call_to_action") or post.get("callToAction")
        call_to_action = call_to_action if isinstance(call_to_action, dict) else {}
        recent_posts.append(
            {
                "post_id": _safe_text(post.get("post_id")) or _safe_text(post.get("postId")),
                "state": state,
                "summary": _safe_text(post.get("summary")),
                "created_at": _safe_text(post.get("create_time")) or _safe_text(post.get("createTime")),
                "updated_at": _safe_text(post.get("update_time")) or _safe_text(post.get("updateTime")),
                "media_count": len(media) if isinstance(media, list) else 0,
                "media_url": _safe_text(first_media.get("google_url")) or _safe_text(first_media.get("googleUrl")),
                "media_format": _safe_text(first_media.get("media_format")) or _safe_text(first_media.get("mediaFormat")),
                "cta_type": _safe_text(call_to_action.get("action_type")) or _safe_text(call_to_action.get("actionType")),
                "cta_url": _safe_text(call_to_action.get("url")),
            }
        )
    return {
        "post_count": len(posts),
        "live_post_count": live_count,
        "recent_posts": recent_posts[:5],
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
            or (_safe_text(reviewer.get("display_name")) if isinstance(reviewer, dict) else None)
            or (_safe_text(reviewer.get("displayName")) if isinstance(reviewer, dict) else None)
        )
        reply = review.get("reply") or review.get("review_reply") or review.get("reviewReply")
        recent_reviews.append(
            {
                "review_id": _safe_text(review.get("google_review_id")) or _safe_text(review.get("reviewId")),
                "rating": _rating(review.get("rating") if "rating" in review else review.get("star_rating")),
                "content": _safe_text(review.get("content")) or _safe_text(review.get("comment")),
                "reviewer_name": reviewer_name,
                "created_at": _safe_text(review.get("created_time")) or _safe_text(review.get("createTime")),
                "has_reply": bool(reply),
            }
        )
    total = payload.get("total") if payload else None
    review_count = total if isinstance(total, int) and not isinstance(total, bool) else len(reviews)
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


def _fetch_location(client: FbrGbpClient, fbr_merchant_id: str, identity: dict[str, Any], synced_at: str):
    gbp_location_id = _safe_text(identity.get("gbp_location_id"))
    if not gbp_location_id:
        raise FbrPayloadError("FBR GBP location is missing gbp_location_id")
    fields: dict[str, str | None] = {field: None for field in GBP_FIELDS}
    source_times: list[str] = []
    for field in GBP_FIELDS:
        try:
            response = client.get_field(fbr_merchant_id, gbp_location_id, field)
        except (FbrUnavailableError, FbrPayloadError):
            continue
        raw = response.get("value")
        if isinstance(raw, str):
            fields[field] = raw
        updated_at = _safe_text(response.get("updated_time"))
        if updated_at:
            source_times.append(updated_at)

    reviews: dict[str, Any] | None = None
    try:
        reviews = client.get_reviews(fbr_merchant_id, gbp_location_id)
    except (FbrUnavailableError, FbrPayloadError):
        pass

    location_raw = fields["LOCATION"]
    normalized = normalize_gbp_location(location_raw) if location_raw else normalize_gbp_location("{}")
    menu = _menu_summary(fields["FOOD_MENUS"])
    posts = _post_summary(fields["LOCAL_POSTS"])
    review_summary = _review_summary(reviews)
    normalized.update(
        {
            "attribute_count": _attribute_count(fields["ATTRIBUTES"]),
            **menu,
            **posts,
            **review_summary,
            "media_count": _collection_count(fields["MEDIA"]),
            "customer_media_count": _collection_count(fields["CUSTOMER_MEDIA"]),
            "question_count": _collection_count(fields["QUESTIONS"]),
            "place_action_link_count": _collection_count(fields["PLACE_ACTION_LINKS"]),
            "verification_count": _collection_count(fields["VERIFICATIONS"]),
        }
    )
    return {
        "gbp_location_id": gbp_location_id,
        "google_account_id": _safe_text(identity.get("google_account_id")),
        "source_name": _safe_text(identity.get("name")),
        "source_title": _safe_text(identity.get("title")),
        "fields": fields,
        "normalized_json": json.dumps(normalized, ensure_ascii=False, separators=(",", ":")),
        "source_updated_at": max(source_times) if source_times else None,
        "synced_at": synced_at,
    }


@router.get("/{merchant_id}/profile")
def get_profile(merchant_id: int, conn=Depends(get_db)):
    return _profile_response(conn, merchant_id)


@router.put("/{merchant_id}/fbr-link")
def put_fbr_link(merchant_id: int, body: FbrLinkBody, conn=Depends(get_db)):
    fetch_merchant(conn, merchant_id)
    fbr_merchant_id = body.fbr_merchant_id.strip()
    if not fbr_merchant_id:
        raise HTTPException(status_code=422, detail="FBR Merchant ID 不能为空")
    now = now_iso()
    conn.execute("DELETE FROM merchant_gbp_profiles WHERE merchant_id = ?", (merchant_id,))
    conn.execute(
        "INSERT INTO merchant_fbr_links"
        " (merchant_id, fbr_merchant_id, sync_status, last_synced_at, last_error, created_at, updated_at)"
        " VALUES (?, ?, 'not_synced', NULL, NULL, ?, ?)"
        " ON CONFLICT(merchant_id) DO UPDATE SET"
        " fbr_merchant_id = excluded.fbr_merchant_id, sync_status = 'not_synced',"
        " last_synced_at = NULL, last_error = NULL, updated_at = excluded.updated_at",
        (merchant_id, fbr_merchant_id, now, now),
    )
    conn.commit()
    return _profile_response(conn, merchant_id)


@router.post("/{merchant_id}/gbp-sync")
def sync_gbp_profile(
    merchant_id: int,
    client: FbrGbpClient | None = Depends(get_fbr_client),
    conn=Depends(get_db),
):
    fetch_merchant(conn, merchant_id)
    link = conn.execute(
        "SELECT * FROM merchant_fbr_links WHERE merchant_id = ?",
        (merchant_id,),
    ).fetchone()
    if link is None:
        raise HTTPException(status_code=409, detail="请先绑定 FBR Merchant ID")
    if client is None:
        message = "FBR SEO integration is not configured"
        conn.execute(
            "UPDATE merchant_fbr_links SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE merchant_id = ?",
            (message, now_iso(), merchant_id),
        )
        conn.commit()
        raise HTTPException(status_code=503, detail=message)

    fbr_merchant_id = link["fbr_merchant_id"]
    synced_at = now_iso()
    conn.execute(
        "UPDATE merchant_fbr_links SET sync_status = 'syncing', last_error = NULL, updated_at = ? WHERE merchant_id = ?",
        (synced_at, merchant_id),
    )
    conn.commit()
    try:
        identities = client.list_locations(fbr_merchant_id)
        snapshots = [_fetch_location(client, fbr_merchant_id, identity, synced_at) for identity in identities]
    except (FbrUnavailableError, FbrPayloadError, FbrConfigurationError) as exc:
        message = str(exc)
        conn.execute(
            "UPDATE merchant_fbr_links SET sync_status = 'failed', last_error = ?, updated_at = ? WHERE merchant_id = ?",
            (message, now_iso(), merchant_id),
        )
        conn.commit()
        raise HTTPException(
            status_code=503,
            detail=f"{message}; last successful data was preserved",
        ) from exc

    conn.execute("DELETE FROM merchant_gbp_profiles WHERE merchant_id = ?", (merchant_id,))
    for snapshot in snapshots:
        fields = snapshot["fields"]
        conn.execute(
            "INSERT INTO merchant_gbp_profiles"
            " (merchant_id, fbr_merchant_id, gbp_location_id, google_account_id, source_name, source_title,"
            " location_json, attributes_json, food_menus_json, local_posts_json, media_json, customer_media_json,"
            " questions_json, place_action_links_json, verifications_json, normalized_json, source_updated_at, synced_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                merchant_id,
                fbr_merchant_id,
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
    conn.execute(
        "UPDATE merchant_fbr_links SET sync_status = 'synced', last_synced_at = ?, last_error = NULL, updated_at = ?"
        " WHERE merchant_id = ?",
        (synced_at, synced_at, merchant_id),
    )
    conn.commit()
    return _profile_response(conn, merchant_id)

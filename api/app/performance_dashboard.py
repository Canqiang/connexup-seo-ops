import json
import math
from collections import defaultdict
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends

from .db import get_db

router = APIRouter(prefix="/api/dashboard", tags=["performance-dashboard"])

WINDOW_LABEL = "各商户最近一次同步快照（最多近 30 天）"
METRIC_GROUPS = {
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS": "map_views",
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": "map_views",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": "search_views",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": "search_views",
    "WEBSITE_CLICKS": "website_clicks",
    "BUSINESS_DIRECTION_REQUESTS": "direction_requests",
    "CALL_CLICKS": "call_clicks",
}
METRIC_KEYS = (
    "total_views",
    "map_views",
    "search_views",
    "website_clicks",
    "direction_requests",
    "call_clicks",
    "action_events",
)


def _json_object(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def _number(value: object) -> int | float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _metric_rows(payload: dict[str, Any] | None) -> list[tuple[str, str, int | float]]:
    if payload is None:
        return []
    metrics = payload.get("performance_metrics")
    if not isinstance(metrics, list):
        return []

    rows = []
    for item in metrics:
        if not isinstance(item, dict):
            continue
        metric_date = item.get("metric_date")
        metric = item.get("metric")
        value = _number(item.get("value"))
        if not isinstance(metric_date, str) or not isinstance(metric, str) or value is None:
            continue
        try:
            date.fromisoformat(metric_date)
        except ValueError:
            continue
        if metric in METRIC_GROUPS:
            rows.append((metric_date, METRIC_GROUPS[metric], value))
    return rows


def _sum_or_none(values: list[int | float]) -> int | float | None:
    return sum(values) if values else None


def _aggregate_metric_values(rows: list[tuple[str, str, int | float]]) -> dict[str, int | float | None]:
    grouped: dict[str, list[int | float]] = defaultdict(list)
    for _metric_date, group, value in rows:
        grouped[group].append(value)

    values = {
        "map_views": _sum_or_none(grouped["map_views"]),
        "search_views": _sum_or_none(grouped["search_views"]),
        "website_clicks": _sum_or_none(grouped["website_clicks"]),
        "direction_requests": _sum_or_none(grouped["direction_requests"]),
        "call_clicks": _sum_or_none(grouped["call_clicks"]),
    }
    values["total_views"] = (
        values["map_views"] + values["search_views"]
        if values["map_views"] is not None and values["search_views"] is not None
        else None
    )
    actions = [
        values["website_clicks"],
        values["direction_requests"],
        values["call_clicks"],
    ]
    values["action_events"] = sum(value for value in actions if value is not None) if any(
        value is not None for value in actions
    ) else None
    return values


def _merchant_metric_values(
    location_values: list[dict[str, int | float | None]],
) -> dict[str, int | float | None]:
    values: dict[str, int | float | None] = {}
    for key in (
        "map_views",
        "search_views",
        "website_clicks",
        "direction_requests",
        "call_clicks",
    ):
        per_location = [location[key] for location in location_values]
        values[key] = (
            sum(per_location)
            if per_location and all(value is not None for value in per_location)
            else None
        )
    values["total_views"] = (
        values["map_views"] + values["search_views"]
        if values["map_views"] is not None and values["search_views"] is not None
        else None
    )
    per_location_actions = [location["action_events"] for location in location_values]
    values["action_events"] = (
        sum(per_location_actions)
        if per_location_actions and all(value is not None for value in per_location_actions)
        else None
    )
    return values


def _location_daily_views(
    rows: list[tuple[str, str, int | float]],
) -> dict[str, dict[str, int | float | None]]:
    grouped: dict[str, dict[str, list[int | float]]] = defaultdict(
        lambda: {"map_views": [], "search_views": []}
    )
    for metric_date, group, value in rows:
        if group in {"map_views", "search_views"}:
            grouped[metric_date][group].append(value)
    return {
        metric_date: {
            "map_views": _sum_or_none(values["map_views"]),
            "search_views": _sum_or_none(values["search_views"]),
        }
        for metric_date, values in grouped.items()
    }


def _review_value(payload: dict[str, Any] | None, key: str) -> int | float | None:
    return _number(payload.get(key)) if payload is not None else None


def _review_scope(payloads: list[dict[str, Any] | None]) -> str | None:
    scopes = {
        value.strip()
        for payload in payloads
        if payload is not None
        for value in [payload.get("review_scope")]
        if isinstance(value, str) and value.strip()
    }
    return scopes.pop() if len(scopes) == 1 else None


def _merchant_review(payloads: list[dict[str, Any] | None], key: str) -> int | float | None:
    values = [value for payload in payloads if (value := _review_value(payload, key)) is not None]
    return values[0] if len(values) == 1 else None


def _data_status(link_status: str | None, has_performance: bool) -> str:
    if link_status is None:
        return "unbound"
    if link_status in {"failed", "syncing", "not_synced"}:
        return link_status
    return "ready" if has_performance else "no_performance"


@router.get("/performance")
def get_performance_dashboard(conn=Depends(get_db)):
    rows = conn.execute(
        """
        SELECT
          m.id AS merchant_id,
          m.name,
          m.primary_location,
          l.sync_status,
          p.id AS profile_id,
          p.normalized_json,
          p.synced_at
        FROM merchants AS m
        LEFT JOIN merchant_fbr_links AS l ON l.merchant_id = m.id
        LEFT JOIN merchant_gbp_profiles AS p ON p.merchant_id = m.id
        WHERE m.status = 'active'
        ORDER BY m.id, p.id
        """
    ).fetchall()

    by_merchant: dict[int, dict[str, Any]] = {}
    for row in rows:
        merchant_id = row["merchant_id"]
        entry = by_merchant.setdefault(
            merchant_id,
            {
                "merchant_id": merchant_id,
                "name": row["name"],
                "primary_location": row["primary_location"],
                "sync_status": row["sync_status"],
                "profiles": [],
            },
        )
        if row["profile_id"] is not None:
            entry["profiles"].append(
                {
                    "payload": _json_object(row["normalized_json"]),
                    "synced_at": row["synced_at"],
                }
            )

    trend_values: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"map_views": 0, "search_views": 0, "merchant_ids": set()}
    )
    metric_dates: set[str] = set()
    merchants = []
    merchant_metrics: dict[int, dict[str, int | float | None]] = {}
    latest_synced_at: str | None = None
    merchants_with_performance = 0
    locations_with_performance = 0

    for merchant in by_merchant.values():
        profiles = merchant["profiles"]
        profile_rows = [_metric_rows(profile["payload"]) for profile in profiles]
        performance_profiles = [
            (profile, metric_rows)
            for profile, metric_rows in zip(profiles, profile_rows)
            if metric_rows
        ]
        has_performance = bool(performance_profiles)
        merchants_with_performance += int(has_performance)
        location_count = len(profiles)
        locations_with_performance += len(performance_profiles)

        flattened_rows = [metric_row for metric_rows in profile_rows for metric_row in metric_rows]
        location_values = [_aggregate_metric_values(metric_rows) for metric_rows in profile_rows]
        values = _merchant_metric_values(location_values)
        merchant_metrics[merchant["merchant_id"]] = values
        data_status = _data_status(merchant["sync_status"], has_performance)
        performance_syncs = [profile["synced_at"] for profile, _rows in performance_profiles]
        synced_at = max(performance_syncs) if performance_syncs else (
            max((profile["synced_at"] for profile in profiles), default=None)
        )
        if has_performance and synced_at and (latest_synced_at is None or synced_at > latest_synced_at):
            latest_synced_at = synced_at

        payloads = [profile["payload"] for profile in profiles]
        review_values = (
            {
                "review_average_rating": _merchant_review(payloads, "review_average_rating"),
                "review_reply_rate": _merchant_review(payloads, "review_reply_rate"),
                "review_scope": _review_scope(payloads),
            }
            if location_count == 1
            else {
                "review_average_rating": None,
                "review_reply_rate": None,
                "review_scope": None,
            }
        )
        merchants.append(
            {
                "merchant_id": merchant["merchant_id"],
                "name": merchant["name"],
                "primary_location": merchant["primary_location"],
                "data_status": data_status,
                "synced_at": synced_at,
                "location_count": location_count,
                **{
                    key: values[key]
                    for key in (
                        "total_views",
                        "map_views",
                        "search_views",
                        "website_clicks",
                        "direction_requests",
                        "call_clicks",
                    )
                },
                **review_values,
            }
        )

        metric_dates.update(metric_date for metric_date, _group, _value in flattened_rows)
        location_days = [_location_daily_views(metric_rows) for metric_rows in profile_rows]
        candidate_dates = {metric_date for days in location_days for metric_date in days}
        for metric_date in candidate_dates:
            day_values = [days.get(metric_date) for days in location_days]
            if not day_values or any(
                values is None
                or values["map_views"] is None
                or values["search_views"] is None
                for values in day_values
            ):
                continue
            trend = trend_values[metric_date]
            trend["map_views"] += sum(values["map_views"] for values in day_values)
            trend["search_views"] += sum(values["search_views"] for values in day_values)
            trend["merchant_ids"].add(merchant["merchant_id"])

    merchants.sort(key=lambda item: (0 if item["data_status"] == "ready" else 1, item["name"].casefold()))
    totals = {}
    for key in METRIC_KEYS:
        values = [
            merchant_metrics[merchant["merchant_id"]][key]
            for merchant in merchants
            if merchant_metrics[merchant["merchant_id"]][key] is not None
        ]
        totals[key] = {"value": sum(values) if values else None, "merchant_coverage": len(values)}

    return {
        "window": {
            "label": WINDOW_LABEL,
            "start": min(metric_dates) if metric_dates else None,
            "end": max(metric_dates) if metric_dates else None,
            "historical_comparison_available": False,
        },
        "coverage": {
            "active_merchants": len(by_merchant),
            "merchants_with_performance": merchants_with_performance,
            "locations_with_performance": locations_with_performance,
            "latest_synced_at": latest_synced_at,
        },
        "totals": totals,
        "trends": [
            {
                "metric_date": metric_date,
                "map_views": trend_values[metric_date]["map_views"],
                "search_views": trend_values[metric_date]["search_views"],
                "merchant_coverage": len(trend_values[metric_date]["merchant_ids"]),
            }
            for metric_date in sorted(trend_values)
        ],
        "merchants": merchants,
    }

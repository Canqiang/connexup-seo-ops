import json
import os
import sqlite3

from helpers import seed_fbr_link


def _insert_link(conn, merchant_id, sync_status="synced"):
    seed_fbr_link(
        conn,
        merchant_id,
        fbr_merchant_id=f"fbr-{merchant_id}",
        sync_status=sync_status,
    )


def _insert_profile(conn, merchant_id, location_id, normalized_json, synced_at):
    conn.execute(
        "INSERT INTO merchant_gbp_profiles "
        "(merchant_id, fbr_merchant_id, gbp_location_id, normalized_json, synced_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (merchant_id, f"fbr-{merchant_id}", location_id, normalized_json, synced_at),
    )


def _merchant(client, name, primary_location="Mineola, NY"):
    response = client.post(
        "/api/merchants", json={"name": name, "primary_location": primary_location}
    )
    assert response.status_code == 201
    return response.json()


def test_performance_dashboard_aggregates_locations_merchants_and_daily_trends(client):
    alpha = _merchant(client, "alpha Foods", "Alpha Town")
    beta = _merchant(client, "Beta Bakery", "Beta City")
    archived = _merchant(client, "Archived Giant", "Hidden")

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    _insert_link(conn, alpha["id"])
    _insert_link(conn, beta["id"])
    _insert_link(conn, archived["id"])
    _insert_profile(
        conn,
        alpha["id"],
        "alpha-one",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 10},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 5},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 8},
                    {"metric_date": "2026-08-30", "metric": "WEBSITE_CLICKS", "value": 2},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_DIRECTION_REQUESTS", "value": 1},
                    {"metric_date": "2026-08-31", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 3},
                    {"metric_date": "2026-08-31", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "value": 7},
                    {"metric_date": "2026-08-31", "metric": "CALL_CLICKS", "value": 4},
                ],
                "review_average_rating": 4.5,
                "review_reply_rate": 0.5,
                "review_scope": "all_synced",
            }
        ),
        "2026-09-01T08:00:00Z",
    )
    _insert_profile(
        conn,
        alpha["id"],
        "alpha-two",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 4},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 0},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 1},
                    {"metric_date": "2026-08-30", "metric": "WEBSITE_CLICKS", "value": 3},
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 6},
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 5},
                ],
            }
        ),
        "2026-09-02T09:00:00Z",
    )
    _insert_profile(
        conn,
        beta["id"],
        "beta-one",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 2},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "value": 3},
                    {"metric_date": "2026-08-30", "metric": "WEBSITE_CLICKS", "value": 4},
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_DIRECTION_REQUESTS", "value": 2},
                    {"metric_date": "2026-08-30", "metric": "CALL_CLICKS", "value": 1},
                ],
                "review_average_rating": 4.8,
                "review_reply_rate": 0.8,
                "review_scope": "recent_month",
            }
        ),
        "2026-09-01T10:00:00Z",
    )
    _insert_profile(
        conn,
        archived["id"],
        "archived-one",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-08-30", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 999}
                ]
            }
        ),
        "2026-09-02T11:00:00Z",
    )
    conn.execute("UPDATE merchants SET status = 'archived' WHERE id = ?", (archived["id"],))
    conn.commit()
    conn.close()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 200
    assert response.json() == {
        "window": {
            "label": "各商户最近一次同步快照（最多近 30 天）",
            "start": "2026-08-30",
            "end": "2026-09-01",
            "historical_comparison_available": False,
        },
        "coverage": {
            "active_merchants": 2,
            "merchants_with_performance": 2,
            "locations_with_performance": 3,
            "latest_synced_at": "2026-09-02T09:00:00Z",
        },
        "totals": {
            "total_views": {"value": 54, "merchant_coverage": 2},
            "map_views": {"value": 30, "merchant_coverage": 2},
            "search_views": {"value": 24, "merchant_coverage": 2},
            "website_clicks": {"value": 9, "merchant_coverage": 2},
            "direction_requests": {"value": 2, "merchant_coverage": 1},
            "call_clicks": {"value": 1, "merchant_coverage": 1},
            "action_events": {"value": 17, "merchant_coverage": 2},
        },
        "trends": [
            {"metric_date": "2026-08-30", "map_views": 21, "search_views": 12, "merchant_coverage": 2},
        ],
        "merchants": [
            {
                "merchant_id": alpha["id"], "name": "alpha Foods", "primary_location": "Alpha Town",
                "data_status": "ready", "synced_at": "2026-09-02T09:00:00Z", "location_count": 2,
                "total_views": 49, "map_views": 28, "search_views": 21,
                "website_clicks": 5, "direction_requests": None, "call_clicks": None,
                "review_average_rating": None, "review_reply_rate": None, "review_scope": None,
            },
            {
                "merchant_id": beta["id"], "name": "Beta Bakery", "primary_location": "Beta City",
                "data_status": "ready", "synced_at": "2026-09-01T10:00:00Z", "location_count": 1,
                "total_views": 5, "map_views": 2, "search_views": 3,
                "website_clicks": 4, "direction_requests": 2, "call_clicks": 1,
                "review_average_rating": 4.8, "review_reply_rate": 0.8, "review_scope": "recent_month",
            },
        ],
    }


def test_performance_dashboard_keeps_missing_metrics_unknown_and_handles_bad_snapshots(client):
    partial = _merchant(client, "Partial")
    no_performance = _merchant(client, "No Performance")

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    _insert_link(conn, partial["id"])
    _insert_link(conn, no_performance["id"])
    _insert_profile(
        conn,
        partial["id"],
        "partial-one",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 7}
                ]
            }
        ),
        "2026-09-02T08:00:00Z",
    )
    _insert_profile(conn, partial["id"], "partial-bad", "{not-json", "2026-09-02T09:00:00Z")
    _insert_profile(
        conn,
        no_performance["id"],
        "invalid-rows",
        json.dumps({"performance_metrics": [{"metric": "WEBSITE_CLICKS", "value": "not-a-number"}]}),
        "2026-09-02T10:00:00Z",
    )
    conn.commit()
    conn.close()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 200
    dashboard = response.json()
    assert dashboard["totals"] == {
        "total_views": {"value": None, "merchant_coverage": 0},
        "map_views": {"value": None, "merchant_coverage": 0},
        "search_views": {"value": None, "merchant_coverage": 0},
        "website_clicks": {"value": None, "merchant_coverage": 0},
        "direction_requests": {"value": None, "merchant_coverage": 0},
        "call_clicks": {"value": None, "merchant_coverage": 0},
        "action_events": {"value": None, "merchant_coverage": 0},
    }
    assert dashboard["trends"] == []
    assert dashboard["merchants"] == [
        {
            "merchant_id": partial["id"], "name": "Partial", "primary_location": "Mineola, NY",
            "data_status": "ready", "synced_at": "2026-09-02T08:00:00Z", "location_count": 2,
            "total_views": None, "map_views": None, "search_views": None,
            "website_clicks": None, "direction_requests": None, "call_clicks": None,
            "review_average_rating": None, "review_reply_rate": None, "review_scope": None,
        },
        {
            "merchant_id": no_performance["id"], "name": "No Performance",
            "primary_location": "Mineola, NY",
            "data_status": "no_performance", "synced_at": "2026-09-02T10:00:00Z", "location_count": 1,
            "total_views": None, "map_views": None, "search_views": None,
            "website_clicks": None, "direction_requests": None, "call_clicks": None,
            "review_average_rating": None, "review_reply_rate": None, "review_scope": None,
        },
    ]


def test_performance_dashboard_reports_unbound_and_link_sync_states(client):
    unbound = _merchant(client, "Unbound")
    failed = _merchant(client, "Failed")
    syncing = _merchant(client, "Syncing")
    not_synced = _merchant(client, "Not Synced")

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    _insert_link(conn, failed["id"], "failed")
    _insert_link(conn, syncing["id"], "syncing")
    _insert_link(conn, not_synced["id"], "not_synced")
    _insert_profile(
        conn,
        failed["id"],
        "failed-but-cached",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 3}
                ]
            }
        ),
        "2026-09-02T11:00:00Z",
    )
    conn.commit()
    conn.close()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 200
    rows = {row["merchant_id"]: row for row in response.json()["merchants"]}
    assert {merchant_id: row["data_status"] for merchant_id, row in rows.items()} == {
        unbound["id"]: "unbound",
        failed["id"]: "failed",
        syncing["id"]: "syncing",
        not_synced["id"]: "not_synced",
    }
    assert response.json()["coverage"] == {
        "active_merchants": 4,
        "merchants_with_performance": 1,
        "locations_with_performance": 1,
        "latest_synced_at": "2026-09-02T11:00:00Z",
    }


def test_performance_dashboard_trends_use_only_merchants_complete_for_each_day(client):
    complete = _merchant(client, "Complete")
    split_across_locations = _merchant(client, "Split")
    maps_only = _merchant(client, "Maps Only")
    search_only = _merchant(client, "Search Only")

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    for merchant in (complete, split_across_locations, maps_only, search_only):
        _insert_link(conn, merchant["id"])
    _insert_profile(
        conn,
        complete["id"],
        "complete-location",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 2},
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 3},
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    _insert_profile(
        conn,
        split_across_locations["id"],
        "split-maps",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 5}
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    _insert_profile(
        conn,
        split_across_locations["id"],
        "split-search",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 7}
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    _insert_profile(
        conn,
        maps_only["id"],
        "maps-only",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 100},
                    {"metric_date": "2026-09-02", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 9},
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    _insert_profile(
        conn,
        search_only["id"],
        "search-only",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 200}
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    conn.commit()
    conn.close()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 200
    assert response.json()["trends"] == [
        {"metric_date": "2026-09-01", "map_views": 2, "search_views": 3, "merchant_coverage": 1}
    ]


def test_performance_dashboard_requires_every_location_to_have_each_metric(client):
    merchant = _merchant(client, "Coverage Guard")

    conn = sqlite3.connect(os.environ["SEO_OPS_DB"])
    _insert_link(conn, merchant["id"])
    _insert_profile(
        conn,
        merchant["id"],
        "complete-location",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 2},
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 3},
                    {"metric_date": "2026-09-01", "metric": "WEBSITE_CLICKS", "value": 4},
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    _insert_profile(
        conn,
        merchant["id"],
        "map-missing-location",
        json.dumps(
            {
                "performance_metrics": [
                    {"metric_date": "2026-09-01", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 5},
                    {"metric_date": "2026-09-01", "metric": "WEBSITE_CLICKS", "value": 6},
                ]
            }
        ),
        "2026-09-02T00:00:00Z",
    )
    conn.commit()
    conn.close()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 200
    assert response.json()["merchants"] == [
        {
            "merchant_id": merchant["id"], "name": "Coverage Guard",
            "primary_location": "Mineola, NY",
            "data_status": "ready", "synced_at": "2026-09-02T00:00:00Z", "location_count": 2,
            "total_views": None, "map_views": None, "search_views": 8,
            "website_clicks": 10, "direction_requests": None, "call_clicks": None,
            "review_average_rating": None, "review_reply_rate": None, "review_scope": None,
        }
    ]
    assert response.json()["totals"] == {
        "total_views": {"value": None, "merchant_coverage": 0},
        "map_views": {"value": None, "merchant_coverage": 0},
        "search_views": {"value": 8, "merchant_coverage": 1},
        "website_clicks": {"value": 10, "merchant_coverage": 1},
        "direction_requests": {"value": None, "merchant_coverage": 0},
        "call_clicks": {"value": None, "merchant_coverage": 0},
        "action_events": {"value": 10, "merchant_coverage": 1},
    }
    assert response.json()["trends"] == []


def test_performance_dashboard_requires_login(client):
    client.cookies.clear()

    response = client.get("/api/dashboard/performance")

    assert response.status_code == 401
    assert response.json() == {"detail": "operator authentication required"}

import json

import pytest


def create_merchant(client):
    response = client.post(
        "/api/merchants",
        json={
            "name": "Only Bear Chicken & Boba",
            "primary_location": "Mineola, NY",
        },
    )
    assert response.status_code == 201
    return response.json()


def test_unbound_merchant_profile_is_explicit(client):
    merchant = create_merchant(client)

    response = client.get(f"/api/merchants/{merchant['id']}/profile")

    assert response.status_code == 200
    assert response.json() == {
        "merchant_id": merchant["id"],
        "state": "unbound",
        "fbr_merchant_id": None,
        "sync_status": None,
        "last_synced_at": None,
        "last_error": None,
        "locations": [],
    }


def test_archived_merchant_rejects_fbr_binding(client):
    merchant = create_merchant(client)
    client.patch(f"/api/merchants/{merchant['id']}", json={"status": "archived"})

    response = client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-must-not-bind"},
    )

    assert response.status_code == 409
    assert response.json()["detail"] == "merchant is archived"
    assert client.get(f"/api/merchants/{merchant['id']}/profile").json()["state"] == "unbound"


def test_normalize_gbp_location_extracts_operator_facts():
    from app.fbr_gbp import normalize_gbp_location

    raw = json.dumps(
        {
            "name": "locations/123",
            "title": "George's Hakka Kitchen",
            "storeCode": "UWS-2020",
            "languageCode": "en",
            "phoneNumbers": {
                "primaryPhone": "+1 212-555-2020",
                "additionalPhones": ["+1 212-555-2021"],
            },
            "storefrontAddress": {
                "addressLines": ["2020 Broadway"],
                "locality": "New York",
                "administrativeArea": "NY",
                "postalCode": "10023",
                "regionCode": "US",
            },
            "websiteUri": "https://george.example.com",
            "categories": {
                "primaryCategory": {"displayName": "Hakka restaurant"},
                "additionalCategories": [{"displayName": "Chinese restaurant"}],
            },
            "openInfo": {"status": "OPEN"},
            "profile": {"description": "Neighborhood Hakka dishes near Broadway."},
            "regularHours": {
                "periods": [
                    {
                        "openDay": "MONDAY",
                        "openTime": {"hours": 11, "minutes": 30},
                        "closeDay": "MONDAY",
                        "closeTime": {"hours": 21, "minutes": 0},
                    }
                ]
            },
        }
    )

    assert normalize_gbp_location(raw) == {
        "title": "George's Hakka Kitchen",
        "store_code": "UWS-2020",
        "language_code": "en",
        "phone": "+1 212-555-2020",
        "additional_phones": ["+1 212-555-2021"],
        "address": "2020 Broadway, New York, NY 10023, US",
        "address_lines": ["2020 Broadway"],
        "locality": "New York",
        "administrative_area": "NY",
        "postal_code": "10023",
        "region_code": "US",
        "website_url": "https://george.example.com",
        "primary_category": "Hakka restaurant",
        "additional_categories": ["Chinese restaurant"],
        "open_status": "OPEN",
        "description": "Neighborhood Hakka dishes near Broadway.",
        "regular_hours": [
            {
                "open_day": "MONDAY",
                "open_time": "11:30",
                "close_day": "MONDAY",
                "close_time": "21:00",
            }
        ],
    }


def test_normalize_gbp_location_rejects_malformed_json():
    from app.fbr_gbp import FbrPayloadError, normalize_gbp_location

    with pytest.raises(FbrPayloadError, match="LOCATION payload is not valid JSON"):
        normalize_gbp_location("{not-json")


def test_normalize_gbp_location_treats_null_minutes_as_an_exact_hour():
    from app.fbr_gbp import normalize_gbp_location

    normalized = normalize_gbp_location(
        json.dumps(
            {
                "regularHours": {
                    "periods": [
                        {
                            "openDay": "MONDAY",
                            "openTime": {"hours": 8, "minutes": None},
                            "closeDay": "MONDAY",
                            "closeTime": {"hours": 20, "minutes": None},
                        }
                    ]
                }
            }
        )
    )

    assert normalized["regular_hours"] == [
        {
            "open_day": "MONDAY",
            "open_time": "08:00",
            "close_day": "MONDAY",
            "close_time": "20:00",
        }
    ]


def test_post_summary_preserves_every_post_returned_by_fbr():
    from app.merchant_profiles import _post_summary

    raw = json.dumps(
        {
            "posts": [
                {"post_id": "post-1", "state": "LIVE", "summary": "Post one"},
                {"post_id": "post-2", "state": "LIVE", "summary": "Post two"},
                {"post_id": "post-3", "state": "LIVE", "summary": "Post three"},
                {"post_id": "post-4", "state": "LIVE", "summary": "Post four"},
                {"post_id": "post-5", "state": "LIVE", "summary": "Post five"},
                {"post_id": "post-6", "state": "LIVE", "summary": "Post six"},
            ]
        }
    )

    summary = _post_summary(raw)

    assert summary["post_count"] == 6
    assert [post["post_id"] for post in summary["recent_posts"]] == [
        "post-1",
        "post-2",
        "post-3",
        "post-4",
        "post-5",
        "post-6",
    ]


def test_fbr_client_encodes_resource_ids_as_one_path_parameter(monkeypatch):
    from app.fbr_gbp import FbrGbpClient, FbrGbpSettings

    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"field":"LOCATION","value":"{}"}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("app.fbr_gbp.urlopen", fake_urlopen)
    client = FbrGbpClient(FbrGbpSettings("https://fbr.example", None, 3.0))

    client.get_field("merchant 1", "locations/123", "LOCATION")

    assert captured == {
        "url": "https://fbr.example/google-business-profile/locations%2F123/field/LOCATION?merchant_id=merchant+1",
        "timeout": 3.0,
    }


def test_operation_assistant_client_uses_merchant_scoped_location_snapshot(monkeypatch):
    from app.fbr_gbp import FbrGbpClient, FbrGbpSettings, normalize_gbp_location

    captured = []
    source_location = {
        "name": "locations/24300588970198995",
        "title": "Choice Brooklyn - Upper West Side",
        "store_code": "15623312503909704756",
        "categories": {
            "primary_category": {"display_name": "Cafe"},
            "additional_categories": [{"display_name": "Bakery"}],
        },
        "storefront_address": {
            "address_lines": ["2040 Broadway"],
            "locality": "New York",
            "administrative_area": "NY",
            "postal_code": "10023",
            "region_code": "US",
        },
        "metadata": {"place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE"},
        "phone_numbers": {"primary_phone": "(646) 302-0129"},
        "website_uri": None,
        "regular_hours": None,
        "profile": {"description": "Upper West Side neighborhood cafe."},
        "open_info": {"status": "OPEN", "can_reopen": True, "opening_date": None},
    }

    location_detail = {
        "location_id": "24300588970198995",
        "website_uri": "https://www.choicebrooklyn.com/",
        "phone_numbers": {"primary_phone": "(646) 302-0129"},
        "categories": source_location["categories"],
        "regular_hours": {
            "periods": [
                {
                    "open_day": "MONDAY",
                    "open_time": {"hours": 8},
                    "close_day": "MONDAY",
                    "close_time": {"hours": 20},
                }
            ]
        },
        "special_hours": {"special_hour_periods": []},
        "open_info": source_location["open_info"],
        "profile": source_location["profile"],
        "more_hours": [],
        "service_items": [],
    }

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(self.payload).encode()

    def fake_urlopen(request, timeout):
        captured.append((request.full_url, request.get_header("X-merchant-id"), timeout))
        url = request.full_url
        if "/gbp/location?" in url:
            return Response({"locations": [source_location]})
        if "/gbp/location/24300588970198995?" in url:
            return Response(location_detail)
        if "/gbp/location/24300588970198995/menu?" in url:
            return Response({"menus": [{"sections": [{"items": [{"labels": [{"display_name": "Cold Brew"}]}]}]}]})
        if "/gbp/location/24300588970198995/post?" in url:
            return Response({"posts": [{"post_id": "post-1", "state": "LIVE", "summary": "Fresh pastries"}]})
        if "/gbp/location/24300588970198995/attribute?" in url:
            return Response({"attributes": [{"attribute_id": "has_takeout", "values": [True]}]})
        if "/gbp/review/24300588970198995/review?" in url:
            return Response({"reviews": [], "total": 0})
        if "/location/monthly-overview?" in url:
            return Response({
                "query_date": "2026-09-02",
                "current_month_rating": 4.8,
                "current_month_review_count": 17,
                "reply_rate": 0.94,
                "reviews": [{"rating": 5, "content": "Excellent brunch", "reply_content": "Thank you"}],
            })
        raise AssertionError(f"unexpected URL: {url}")

    monkeypatch.setattr("app.fbr_gbp.urlopen", fake_urlopen)
    client = FbrGbpClient(
        FbrGbpSettings("http://operation-assistant.test", None, 4.0, "operation_assistant")
    )

    identities = client.list_locations("merchant 1")
    field = client.get_field("merchant 1", "24300588970198995", "LOCATION")
    menu = client.get_field("merchant 1", "24300588970198995", "FOOD_MENUS")
    posts = client.get_field("merchant 1", "24300588970198995", "LOCAL_POSTS")
    attributes = client.get_field("merchant 1", "24300588970198995", "ATTRIBUTES")
    reviews = client.get_reviews("merchant 1", "24300588970198995")
    overview = client.get_review_overview("merchant 1", "24300588970198995", query_date="2026-09-02")
    normalized = normalize_gbp_location(field["value"])

    assert all(merchant_header == "merchant 1" for _, merchant_header, _ in captured)
    assert all(timeout == 4.0 for _, _, timeout in captured)
    assert captured[0][0] == "http://operation-assistant.test/gbp/location?merchant_id=merchant+1"
    assert identities == [
        {
            "merchant_id": "merchant 1",
            "gbp_location_id": "24300588970198995",
            "google_account_id": None,
            "name": "locations/24300588970198995",
            "title": "Choice Brooklyn - Upper West Side",
            "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        }
    ]
    assert normalized["title"] == "Choice Brooklyn - Upper West Side"
    assert normalized["address"] == "2040 Broadway, New York, NY 10023, US"
    assert normalized["phone"] == "(646) 302-0129"
    assert normalized["primary_category"] == "Cafe"
    assert normalized["additional_categories"] == ["Bakery"]
    assert normalized["open_status"] == "OPEN"
    assert normalized["description"] == "Upper West Side neighborhood cafe."
    assert normalized["website_url"] == "https://www.choicebrooklyn.com/"
    assert normalized["regular_hours"] == [
        {"open_day": "MONDAY", "open_time": "08:00", "close_day": "MONDAY", "close_time": "20:00"}
    ]
    assert json.loads(menu["value"])["menus"][0]["sections"][0]["items"][0]["labels"][0]["display_name"] == "Cold Brew"
    assert json.loads(posts["value"])["posts"][0]["state"] == "LIVE"
    assert json.loads(attributes["value"])["attributes"][0]["attribute_id"] == "has_takeout"
    assert reviews == {"reviews": [], "total": 0}
    assert overview["current_month_review_count"] == 17


def test_operation_assistant_client_uses_place_id_for_gbp_insights(monkeypatch):
    from app.fbr_gbp import FbrGbpClient, FbrGbpSettings

    captured = []

    class Response:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(self.payload).encode()

    def fake_urlopen(request, timeout):
        captured.append((request.full_url, request.get_header("X-merchant-id"), timeout))
        if "/gbp/performance-metric?" in request.full_url:
            return Response(
                {
                    "metrics": [
                        {
                            "metric_date": "2026-09-01",
                            "metric": "WEBSITE_CLICKS",
                            "value": 14,
                        }
                    ]
                }
            )
        if "/gbp/search-keyword-metric?" in request.full_url:
            return Response(
                {
                    "keywords": [
                        {"month": "2026-08", "keyword": "coffee", "value": 6246}
                    ]
                }
            )
        raise AssertionError(f"unexpected URL: {request.full_url}")

    monkeypatch.setattr("app.fbr_gbp.urlopen", fake_urlopen)
    client = FbrGbpClient(
        FbrGbpSettings("http://operation-assistant.test", None, 4.0, "operation_assistant")
    )

    performance = client.list_performance_metrics(
        "merchant 1",
        "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        from_date="2026-08-03",
        to_date="2026-09-02",
    )
    keywords = client.list_search_keyword_metrics(
        "merchant 1",
        "ChIJH8iZh-5ZwokRPLzzADeSnYE",
        from_month="2026-07",
        to_month="2026-09",
    )

    assert performance["metrics"][0]["value"] == 14
    assert keywords["keywords"][0]["keyword"] == "coffee"
    assert captured == [
        (
            "http://operation-assistant.test/gbp/performance-metric?"
            "from_date=2026-08-03&to_date=2026-09-02&place_id=ChIJH8iZh-5ZwokRPLzzADeSnYE",
            "merchant 1",
            4.0,
        ),
        (
            "http://operation-assistant.test/gbp/search-keyword-metric?"
            "from_month=2026-07&to_month=2026-09&place_id=ChIJH8iZh-5ZwokRPLzzADeSnYE",
            "merchant 1",
            4.0,
        ),
    ]


def test_operation_assistant_client_reads_persisted_local_keywords_by_place_id(monkeypatch):
    from app.fbr_gbp import FbrGbpClient, FbrGbpSettings

    captured = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps(
                {
                    "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                    "local_keywords": [
                        {
                            "local_keyword_id": "local-keywords-uws",
                            "merchant_id": "fbr-choice",
                            "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
                            "keywords": [
                                {
                                    "keyword": "breakfast Upper West Side",
                                    "priority": "P1",
                                    "target_surface_types": ["GBP"],
                                }
                            ],
                        }
                    ],
                }
            ).encode()

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr("app.fbr_gbp.urlopen", fake_urlopen)
    client = FbrGbpClient(
        FbrGbpSettings("http://operation-assistant.test", None, 4.0, "operation_assistant")
    )

    payload = client.get_local_keywords("ChIJH8iZh-5ZwokRPLzzADeSnYE")

    assert payload["local_keywords"][0]["keywords"][0] == {
        "keyword": "breakfast Upper West Side",
        "priority": "P1",
        "target_surface_types": ["GBP"],
    }
    assert captured == {
        "url": (
            "http://operation-assistant.test/seo/keyword/local/"
            "ChIJH8iZh-5ZwokRPLzzADeSnYE?"
        ),
        "timeout": 4.0,
    }


def test_binding_fbr_merchant_is_explicit_and_trimmed(client):
    merchant = create_merchant(client)

    response = client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "  fbr-merchant-123  "},
    )

    assert response.status_code == 200
    assert response.json()["state"] == "not_synced"
    assert response.json()["fbr_merchant_id"] == "fbr-merchant-123"
    assert response.json()["locations"] == []
    from app.db import connect

    conn = connect()
    try:
        event = conn.execute(
            "SELECT fbr_merchant_id,generation,valid_to "
            "FROM merchant_fbr_binding_events WHERE merchant_id=?",
            (merchant["id"],),
        ).fetchone()
        state = conn.execute(
            "SELECT sync_status FROM merchant_fbr_link_state WHERE merchant_id=?",
            (merchant["id"],),
        ).fetchone()
    finally:
        conn.close()
    assert tuple(event) == ("fbr-merchant-123", 1, None)
    assert state["sync_status"] == "not_synced"


def test_put_fbr_link_rejects_replacement_without_rewriting_binding_history(client):
    merchant = create_merchant(client)
    first = client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-old"},
    )
    second = client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-new"},
    )

    assert first.status_code == 200
    assert second.status_code == 409
    assert second.json()["detail"] == "FBR Merchant ID 已绑定；请使用重新绑定流程"
    from app.db import connect

    conn = connect()
    try:
        events = conn.execute(
            "SELECT fbr_merchant_id,generation,valid_from,valid_to "
            "FROM merchant_fbr_binding_events WHERE merchant_id=? ORDER BY generation",
            (merchant["id"],),
        ).fetchall()
        projection = conn.execute(
            "SELECT fbr_merchant_id,binding_event_id FROM merchant_fbr_links "
            "WHERE merchant_id=?",
            (merchant["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert [(row["fbr_merchant_id"], row["generation"]) for row in events] == [
        ("fbr-merchant-old", 1),
    ]
    assert events[0]["valid_to"] is None
    assert projection["fbr_merchant_id"] == "fbr-merchant-old"


def test_unbound_merchant_cannot_sync_gbp(client):
    merchant = create_merchant(client)

    response = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")

    assert response.status_code == 409
    assert response.json()["detail"] == "请先绑定 FBR Merchant ID"


class FakeFbrGbpClient:
    def __init__(self):
        self.fail_list = False

    def list_locations(self, fbr_merchant_id):
        if self.fail_list:
            from app.fbr_gbp import FbrUnavailableError

            raise FbrUnavailableError("FBR SEO service is unavailable")
        assert fbr_merchant_id == "fbr-merchant-123"
        return [
            {
                "merchant_id": "fbr-merchant-123",
                "gbp_location_id": "locations/123",
                "google_account_id": "accounts/77",
                "name": "locations/123",
                "title": "George's Hakka Kitchen",
                "place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE",
            }
        ]

    def get_field(self, fbr_merchant_id, gbp_location_id, field):
        assert fbr_merchant_id == "fbr-merchant-123"
        assert gbp_location_id == "locations/123"
        values = {
            "LOCATION": {
                "title": "George's Hakka Kitchen",
                "phoneNumbers": {"primaryPhone": "+1 212-555-2020"},
                "storefrontAddress": {
                    "addressLines": ["2020 Broadway"],
                    "locality": "New York",
                    "administrativeArea": "NY",
                    "postalCode": "10023",
                    "regionCode": "US",
                },
                "websiteUri": "https://george.example.com",
                "categories": {
                    "primaryCategory": {"displayName": "Hakka restaurant"},
                    "additionalCategories": [{"displayName": "Chinese restaurant"}],
                },
                "openInfo": {"status": "OPEN"},
                "profile": {"description": "Neighborhood Hakka dishes near Broadway."},
                "regularHours": {
                    "periods": [
                        {
                            "openDay": "MONDAY",
                            "openTime": {"hours": 11, "minutes": 30},
                            "closeDay": "MONDAY",
                            "closeTime": {"hours": 21},
                        }
                    ]
                },
            },
            "ATTRIBUTES": {"attributes": [{"name": "attributes/takeout"}]},
            "FOOD_MENUS": {
                "menus": [
                    {
                        "labels": [{"display_name": "Main menu"}],
                        "sections": [
                            {
                                "labels": [{"display_name": "Lunch"}],
                                "items": [
                                    {
                                        "labels": [{"display_name": "Avocado sandwich", "description": "House-made lunch favorite"}],
                                        "price": {"currency_code": "USD", "units": "12", "nanos": 500000000},
                                        "media_keys": ["AF1QipMenuPhoto"],
                                    }
                                ],
                            }
                        ],
                    }
                ]
            },
            "LOCAL_POSTS": {
                "posts": [
                    {
                        "post_id": "post-1",
                        "state": "LIVE",
                        "summary": "Fresh pastries near Broadway",
                        "create_time": "2026-09-01T10:00:00Z",
                        "call_to_action": {"action_type": "ORDER", "url": "https://order.example.com"},
                        "media": [{"media_format": "PHOTO", "google_url": "https://images.example/post-1.jpg"}],
                    },
                    {"post_id": "post-2", "state": "PROCESSING", "summary": "Weekend brunch"},
                ]
            },
            "MEDIA": {"mediaItems": [{"name": "media/1"}]},
            "CUSTOMER_MEDIA": {"mediaItems": []},
            "QUESTIONS": {"questions": [{"name": "questions/1"}]},
            "PLACE_ACTION_LINKS": {"placeActionLinks": []},
            "VERIFICATIONS": {"verifications": [{"state": "COMPLETED"}]},
        }
        return {
            "field": field,
            "value": json.dumps(values[field]),
            "updated_time": "2026-09-02T02:30:00Z",
        }

    def get_reviews(self, fbr_merchant_id, gbp_location_id):
        assert fbr_merchant_id == "fbr-merchant-123"
        assert gbp_location_id == "locations/123"
        return {
            "total": 1,
            "reviews": [
                {
                    "google_review_id": "review-1",
                    "rating": 5,
                    "content": "Great neighborhood cafe",
                    "reviewer_name": "Jamie",
                    "created_time": "2026-09-01T12:00:00Z",
                    "reply": None,
                }
            ],
        }

    def list_performance_metrics(self, fbr_merchant_id, place_id, *, from_date, to_date):
        assert fbr_merchant_id == "fbr-merchant-123"
        assert place_id == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
        assert from_date <= to_date
        return {
            "metrics": [
                {
                    "metric_date": "2026-09-01",
                    "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
                    "value": 1215,
                },
                {
                    "metric_date": "2026-09-01",
                    "metric": "WEBSITE_CLICKS",
                    "value": 14,
                },
            ]
        }

    def list_search_keyword_metrics(self, fbr_merchant_id, place_id, *, from_month, to_month):
        assert fbr_merchant_id == "fbr-merchant-123"
        assert place_id == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
        assert from_month <= to_month
        return {
            "keywords": [
                {"month": "2026-08", "keyword": "coffee", "value": 6246},
                {"month": "2026-08", "keyword": "brunch", "value": 2376},
            ]
        }


def test_sync_caches_real_gbp_facts_without_credentials(client):
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert response.status_code == 200
    profile = response.json()
    assert profile["state"] == "synced"
    assert profile["sync_status"] == "synced"
    assert profile["last_error"] is None
    assert len(profile["locations"]) == 1
    location = profile["locations"][0]
    assert location["gbp_location_id"] == "locations/123"
    assert location["title"] == "George's Hakka Kitchen"
    assert location["address"] == "2020 Broadway, New York, NY 10023, US"
    assert location["phone"] == "+1 212-555-2020"
    assert location["website_url"] == "https://george.example.com"
    assert location["primary_category"] == "Hakka restaurant"
    assert location["post_count"] == 2
    assert location["live_post_count"] == 1
    assert location["recent_posts"] == [
        {
            "post_id": "post-1",
            "state": "LIVE",
            "summary": "Fresh pastries near Broadway",
            "created_at": "2026-09-01T10:00:00Z",
            "updated_at": None,
            "media_count": 1,
            "media_url": "https://images.example/post-1.jpg",
            "media_format": "PHOTO",
            "cta_type": "ORDER",
            "cta_url": "https://order.example.com",
        },
        {
            "post_id": "post-2",
            "state": "PROCESSING",
            "summary": "Weekend brunch",
            "created_at": None,
            "updated_at": None,
            "media_count": 0,
            "media_url": None,
            "media_format": None,
            "cta_type": None,
            "cta_url": None,
        },
    ]
    assert location["menu_count"] == 1
    assert location["menu_section_count"] == 1
    assert location["menu_item_count"] == 1
    assert location["menu_sections"] == [{"name": "Lunch", "item_count": 1}]
    assert location["menu_items"] == [
        {
            "section_name": "Lunch",
            "name": "Avocado sandwich",
            "description": "House-made lunch favorite",
            "price_amount": 12.5,
            "currency_code": "USD",
            "media_url": "https://lh3.googleusercontent.com/p/AF1QipMenuPhoto",
        }
    ]
    assert location["review_count"] == 1
    assert location["review_sync_status"] == "ready"
    assert location["review_scope"] == "all_synced"
    assert location["recent_reviews"] == [
        {
            "review_id": "review-1",
            "rating": 5.0,
            "content": "Great neighborhood cafe",
            "reviewer_name": "Jamie",
            "created_at": "2026-09-01T12:00:00Z",
            "has_reply": False,
        }
    ]
    assert location["media_count"] == 1
    assert location["question_count"] == 1
    assert location["place_id"] == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
    assert location["performance_metrics"] == [
        {
            "metric_date": "2026-09-01",
            "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
            "value": 1215,
        },
        {
            "metric_date": "2026-09-01",
            "metric": "WEBSITE_CLICKS",
            "value": 14,
        },
    ]
    assert location["search_keywords"] == [
        {"month": "2026-08", "keyword": "coffee", "value": 6246},
        {"month": "2026-08", "keyword": "brunch", "value": 2376},
    ]
    assert location["source_updated_at"] == "2026-09-02T02:30:00Z"
    assert "access_token" not in json.dumps(profile).lower()
    assert "refresh_token" not in json.dumps(profile).lower()


def test_unavailable_gbp_collections_are_unknown_instead_of_zero(client):
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    original_get_field = fake.get_field

    def partial_get_field(fbr_merchant_id, gbp_location_id, field):
        if field in {"MEDIA", "CUSTOMER_MEDIA", "QUESTIONS", "PLACE_ACTION_LINKS", "VERIFICATIONS"}:
            raise FbrUnavailableError(f"{field} is not exposed")
        return original_get_field(fbr_merchant_id, gbp_location_id, field)

    fake.get_field = partial_get_field
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert response.status_code == 200
    location = response.json()["locations"][0]
    assert location["post_count"] == 2
    assert location["menu_count"] == 1
    assert location["review_count"] == 1
    assert location["media_count"] is None
    assert location["question_count"] is None
    assert location["verification_count"] is None


def test_unavailable_review_source_is_not_reported_as_zero_reviews(client):
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()

    def unavailable_reviews(*_args, **_kwargs):
        raise FbrUnavailableError("GBP location not found")

    fake.get_reviews = unavailable_reviews
    fake.get_review_overview = unavailable_reviews
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert response.status_code == 200
    location = response.json()["locations"][0]
    assert location["review_sync_status"] == "unavailable"
    assert location["review_count"] is None
    assert location["recent_reviews"] == []


def test_live_review_overview_fills_empty_persisted_review_snapshot(client):
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    fake.get_reviews = lambda *_args: {"total": 0, "reviews": []}
    fake.get_review_overview = lambda *_args, **_kwargs: {
        "query_date": "2026-09-02",
        "current_month_rating": 4.8,
        "current_month_review_count": 17,
        "reply_rate": 0.94,
        "reviews": [
            {"rating": 5, "content": "Excellent brunch", "reply_content": "Thank you"},
            {"rating": 4, "content": "Good coffee", "reply_content": None},
        ],
    }
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        response = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert response.status_code == 200
    location = response.json()["locations"][0]
    assert location["review_sync_status"] == "ready"
    assert location["review_scope"] == "recent_month"
    assert location["review_count"] == 17
    assert location["review_average_rating"] == 4.8
    assert location["review_reply_rate"] == 0.94
    assert location["recent_reviews"][0] == {
        "review_id": None,
        "rating": 5.0,
        "content": "Excellent brunch",
        "reviewer_name": None,
        "created_at": None,
        "has_reply": True,
    }


def test_failed_resync_preserves_last_successful_snapshot(client):
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        successful = client.get(f"/api/merchants/{merchant['id']}/profile").json()
        fake.fail_list = True
        failed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
        cached = client.get(f"/api/merchants/{merchant['id']}/profile")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert failed.status_code == 503
    assert failed.json()["detail"] == "FBR SEO service is unavailable; last successful data was preserved"
    assert cached.status_code == 200
    assert cached.json()["sync_status"] == "failed"
    assert cached.json()["last_error"] == "FBR SEO service is unavailable"
    assert cached.json()["last_synced_at"] == successful["last_synced_at"]
    assert cached.json()["locations"][0]["title"] == "George's Hakka Kitchen"


def test_empty_location_list_on_resync_preserves_last_successful_snapshot(client):
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        successful = client.get(f"/api/merchants/{merchant['id']}/profile").json()
        fake.list_locations = lambda _fbr_merchant_id: []

        failed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
        cached = client.get(f"/api/merchants/{merchant['id']}/profile").json()
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert failed.status_code == 503
    assert cached["sync_status"] == "failed"
    assert cached["last_synced_at"] == successful["last_synced_at"]
    assert cached["locations"] == successful["locations"]


@pytest.mark.parametrize(
    ("failure_mode", "invalid_value"),
    [
        ("exception", None),
        ("empty", ""),
        ("malformed", "{broken-json"),
        ("scalar", "null"),
        ("empty-object", "{}"),
        ("empty-hours", '{"regularHours":{"periods":[{}]}}'),
    ],
)
def test_location_field_failure_on_resync_preserves_last_successful_snapshot(
    client,
    failure_mode,
    invalid_value,
):
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        successful = client.get(f"/api/merchants/{merchant['id']}/profile").json()
        original_get_field = fake.get_field

        def fail_location_field(fbr_merchant_id, gbp_location_id, field):
            if field == "LOCATION":
                if failure_mode == "exception":
                    raise FbrUnavailableError("LOCATION is temporarily unavailable")
                response = original_get_field(fbr_merchant_id, gbp_location_id, field)
                return {**response, "value": invalid_value}
            return original_get_field(fbr_merchant_id, gbp_location_id, field)

        fake.get_field = fail_location_field
        failed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
        cached = client.get(f"/api/merchants/{merchant['id']}/profile").json()
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert failed.status_code == 503
    assert cached["sync_status"] == "failed"
    assert cached["last_synced_at"] == successful["last_synced_at"]
    assert cached["locations"] == successful["locations"]


@pytest.mark.parametrize(
    ("failure_mode", "invalid_value"),
    [
        ("exception", None),
        ("empty", ""),
        ("malformed", "{broken-json"),
        ("scalar", "null"),
        ("missing-list", "{}"),
        ("invalid-list-item", '{"menus":[null]}'),
    ],
)
def test_optional_field_failure_keeps_old_value_while_successful_fields_update(
    client,
    failure_mode,
    invalid_value,
):
    from app.db import connect
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        conn = connect()
        try:
            old_menu_json = conn.execute(
                "SELECT food_menus_json FROM merchant_gbp_profiles"
                " WHERE merchant_id = ? AND gbp_location_id = ?",
                (merchant["id"], "locations/123"),
            ).fetchone()["food_menus_json"]
        finally:
            conn.close()

        original_get_field = fake.get_field

        def partially_updated_fields(fbr_merchant_id, gbp_location_id, field):
            if field == "FOOD_MENUS":
                if failure_mode == "exception":
                    raise FbrUnavailableError("FOOD_MENUS is temporarily unavailable")
                response = original_get_field(fbr_merchant_id, gbp_location_id, field)
                return {**response, "value": invalid_value}
            response = original_get_field(fbr_merchant_id, gbp_location_id, field)
            if field == "LOCATION":
                value = json.loads(response["value"])
                value["title"] = "George's Updated Kitchen"
                response = {**response, "value": json.dumps(value)}
            elif field == "LOCAL_POSTS":
                response = {
                    **response,
                    "value": json.dumps(
                        {
                            "posts": [
                                {
                                    "post_id": "post-new",
                                    "state": "LIVE",
                                    "summary": "A newly synced post",
                                }
                            ]
                        }
                    ),
                }
            return response

        fake.get_field = partially_updated_fields
        refreshed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert refreshed.status_code == 200
    location = refreshed.json()["locations"][0]
    assert location["title"] == "George's Updated Kitchen"
    assert location["menu_items"][0]["name"] == "Avocado sandwich"
    assert location["recent_posts"] == [
        {
            "post_id": "post-new",
            "state": "LIVE",
            "summary": "A newly synced post",
            "created_at": None,
            "updated_at": None,
            "media_count": 0,
            "media_url": None,
            "media_format": None,
            "cta_type": None,
            "cta_url": None,
        }
    ]
    conn = connect()
    try:
        refreshed_menu_json = conn.execute(
            "SELECT food_menus_json FROM merchant_gbp_profiles"
            " WHERE merchant_id = ? AND gbp_location_id = ?",
            (merchant["id"], "locations/123"),
        ).fetchone()["food_menus_json"]
    finally:
        conn.close()
    assert refreshed_menu_json == old_menu_json


def test_incomplete_location_identity_keeps_previous_identity_values(client):
    from app.db import connect
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        fake.list_locations = lambda _fbr_merchant_id: [
            {
                "gbp_location_id": "locations/123",
                "google_account_id": " ",
                "name": None,
                "title": {},
                "place_id": "",
            }
        ]

        refreshed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
        conn = connect()
        try:
            row = conn.execute(
                "SELECT google_account_id, source_name, source_title"
                " FROM merchant_gbp_profiles"
                " WHERE merchant_id = ? AND gbp_location_id = ?",
                (merchant["id"], "locations/123"),
            ).fetchone()
        finally:
            conn.close()
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert refreshed.status_code == 200
    location = refreshed.json()["locations"][0]
    assert location["google_account_id"] == "accounts/77"
    assert location["name"] == "locations/123"
    assert location["place_id"] == "ChIJH8iZh-5ZwokRPLzzADeSnYE"
    assert dict(row) == {
        "google_account_id": "accounts/77",
        "source_name": "locations/123",
        "source_title": "George's Hakka Kitchen",
    }


def test_auxiliary_source_failures_preserve_old_normalized_values(client):
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        before = client.get(f"/api/merchants/{merchant['id']}/profile").json()[
            "locations"
        ][0]
        original_get_field = fake.get_field

        def updated_location(fbr_merchant_id, gbp_location_id, field):
            response = original_get_field(fbr_merchant_id, gbp_location_id, field)
            if field == "LOCATION":
                value = json.loads(response["value"])
                value["title"] = "George's Updated Kitchen"
                return {**response, "value": json.dumps(value)}
            return response

        def unavailable(*_args, **_kwargs):
            raise FbrUnavailableError("auxiliary source is temporarily unavailable")

        fake.get_field = updated_location
        fake.get_reviews = unavailable
        fake.get_review_overview = unavailable
        fake.list_performance_metrics = unavailable
        fake.list_search_keyword_metrics = unavailable
        refreshed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert refreshed.status_code == 200
    after = refreshed.json()["locations"][0]
    assert after["title"] == "George's Updated Kitchen"
    preserved_keys = (
        "review_count",
        "recent_reviews",
        "review_sync_status",
        "review_scope",
        "review_average_rating",
        "review_reply_rate",
        "performance_metrics",
        "search_keywords",
    )
    assert {key: after[key] for key in preserved_keys} == {
        key: before[key] for key in preserved_keys
    }


@pytest.mark.parametrize("invalid_list_items", [False, True])
def test_invalid_auxiliary_payloads_preserve_old_normalized_values(
    client,
    invalid_list_items,
):
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        before = client.get(f"/api/merchants/{merchant['id']}/profile").json()[
            "locations"
        ][0]
        fake.get_reviews = lambda *_args, **_kwargs: (
            {"total": 1, "reviews": [None]} if invalid_list_items else {}
        )
        fake.get_review_overview = lambda *_args, **_kwargs: (
            {"current_month_review_count": 1, "reviews": [None]}
            if invalid_list_items
            else {}
        )
        fake.list_performance_metrics = lambda *_args, **_kwargs: (
            {"metrics": [None]} if invalid_list_items else {}
        )
        fake.list_search_keyword_metrics = lambda *_args, **_kwargs: (
            {"keywords": [None]} if invalid_list_items else {}
        )

        refreshed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert refreshed.status_code == 200
    after = refreshed.json()["locations"][0]
    preserved_keys = (
        "review_count",
        "recent_reviews",
        "review_sync_status",
        "review_scope",
        "review_average_rating",
        "review_reply_rate",
        "performance_metrics",
        "search_keywords",
    )
    assert {key: after[key] for key in preserved_keys} == {
        key: before[key] for key in preserved_keys
    }


def test_zero_review_snapshot_with_failed_overview_preserves_previous_overview(client):
    from app.fbr_gbp import FbrUnavailableError
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    fake.get_reviews = lambda *_args, **_kwargs: {"total": 0, "reviews": []}
    fake.get_review_overview = lambda *_args, **_kwargs: {
        "current_month_rating": 4.8,
        "current_month_review_count": 17,
        "reply_rate": 0.94,
        "reviews": [{"rating": 5, "content": "Excellent brunch"}],
    }
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        before = client.get(f"/api/merchants/{merchant['id']}/profile").json()[
            "locations"
        ][0]

        def unavailable_overview(*_args, **_kwargs):
            raise FbrUnavailableError("review overview is temporarily unavailable")

        fake.get_review_overview = unavailable_overview
        refreshed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert refreshed.status_code == 200
    after = refreshed.json()["locations"][0]
    preserved_keys = (
        "review_count",
        "recent_reviews",
        "review_sync_status",
        "review_scope",
        "review_average_rating",
        "review_reply_rate",
    )
    assert {key: after[key] for key in preserved_keys} == {
        key: before[key] for key in preserved_keys
    }


def test_incomplete_location_list_on_resync_preserves_entire_old_snapshot(client):
    from app.db import connect
    from app.main import app
    from app.merchant_profiles import get_fbr_client

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    app.dependency_overrides[get_fbr_client] = lambda: fake
    try:
        assert client.post(f"/api/merchants/{merchant['id']}/gbp-sync").status_code == 200
        conn = connect()
        try:
            conn.execute(
                "INSERT INTO merchant_gbp_profiles"
                " (merchant_id, fbr_merchant_id, gbp_location_id, google_account_id,"
                " source_name, source_title, location_json, attributes_json,"
                " food_menus_json, local_posts_json, media_json, customer_media_json,"
                " questions_json, place_action_links_json, verifications_json,"
                " normalized_json, source_updated_at, synced_at)"
                " SELECT merchant_id, fbr_merchant_id, 'locations/456', google_account_id,"
                " 'locations/456', 'Second Location', location_json, attributes_json,"
                " food_menus_json, local_posts_json, media_json, customer_media_json,"
                " questions_json, place_action_links_json, verifications_json,"
                " normalized_json, source_updated_at, synced_at"
                " FROM merchant_gbp_profiles"
                " WHERE merchant_id = ? AND gbp_location_id = 'locations/123'",
                (merchant["id"],),
            )
            conn.commit()
        finally:
            conn.close()

        successful = client.get(f"/api/merchants/{merchant['id']}/profile").json()
        assert {item["gbp_location_id"] for item in successful["locations"]} == {
            "locations/123",
            "locations/456",
        }

        failed = client.post(f"/api/merchants/{merchant['id']}/gbp-sync")
        cached = client.get(f"/api/merchants/{merchant['id']}/profile").json()
    finally:
        app.dependency_overrides.pop(get_fbr_client, None)

    assert failed.status_code == 503
    assert cached["sync_status"] == "failed"
    assert cached["last_synced_at"] == successful["last_synced_at"]
    assert cached["locations"] == successful["locations"]


def test_gbp_sync_records_remote_read_completion_time_when_clock_is_not_injected(
    client,
    monkeypatch,
):
    from datetime import datetime, timezone

    from app.db import connect
    from app import merchant_profiles

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    started_at = datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)
    completed_at = datetime(2026, 9, 3, 12, 7, tzinfo=timezone.utc)
    clock = iter((started_at, completed_at))

    def fake_utc_now(current_time=None):
        return current_time if current_time is not None else next(clock)

    monkeypatch.setattr(merchant_profiles, "_utc_now", fake_utc_now)

    class EmptyFirstSyncClient:
        def list_locations(self, fbr_merchant_id):
            assert fbr_merchant_id == "fbr-merchant-123"
            return []

    conn = connect()
    try:
        assert merchant_profiles.sync_gbp_profile_once(
            conn,
            EmptyFirstSyncClient(),
            merchant["id"],
            force=True,
        ) is True
        link = conn.execute(
            "SELECT sync_status, last_synced_at, updated_at"
            " FROM merchant_fbr_links WHERE merchant_id = ?",
            (merchant["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert dict(link) == {
        "sync_status": "synced",
        "last_synced_at": completed_at.isoformat(),
        "updated_at": completed_at.isoformat(),
    }


def test_injected_sync_time_controls_all_auxiliary_query_windows(client):
    from datetime import datetime, timezone

    from app.db import connect
    from app.merchant_profiles import sync_gbp_profile_once

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    fake = FakeFbrGbpClient()
    captured = {}
    fake.get_reviews = lambda *_args, **_kwargs: {"total": 0, "reviews": []}

    def review_overview(*_args, query_date, **_kwargs):
        captured["review_date"] = query_date
        return {"current_month_review_count": 0, "reviews": []}

    def performance(*_args, from_date, to_date, **_kwargs):
        captured["performance"] = (from_date, to_date)
        return {"metrics": []}

    def search_keywords(*_args, from_month, to_month, **_kwargs):
        captured["search"] = (from_month, to_month)
        return {"keywords": []}

    fake.get_review_overview = review_overview
    fake.list_performance_metrics = performance
    fake.list_search_keyword_metrics = search_keywords
    conn = connect()
    try:
        synced = sync_gbp_profile_once(
            conn,
            fake,
            merchant["id"],
            force=True,
            current_time=datetime(2026, 1, 15, 8, 30, tzinfo=timezone.utc),
        )
    finally:
        conn.close()

    assert synced is True
    assert captured == {
        "review_date": "2026-01-15",
        "performance": ("2025-12-16", "2026-01-15"),
        "search": ("2025-11", "2026-01"),
    }


def test_reusable_gbp_sync_releases_database_transaction_during_fbr_io(client):
    from datetime import datetime, timezone

    from app.db import connect
    from app.merchant_profiles import sync_gbp_profile_once

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    conn = connect()

    class TransactionCheckingClient:
        def list_locations(self, fbr_merchant_id):
            assert fbr_merchant_id == "fbr-merchant-123"
            assert conn.in_transaction is False
            return []

    try:
        synced = sync_gbp_profile_once(
            conn,
            TransactionCheckingClient(),
            merchant["id"],
            force=True,
            current_time=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc),
        )
        row = conn.execute(
            "SELECT sync_status, last_synced_at FROM merchant_fbr_links WHERE merchant_id = ?",
            (merchant["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert synced is True
    assert row["sync_status"] == "synced"
    assert row["last_synced_at"] == "2026-09-03T12:00:00+00:00"


def test_gbp_sync_discards_stale_result_when_fbr_binding_changes(client):
    from datetime import datetime, timedelta, timezone

    from app.db import connect
    from app.merchant_profiles import sync_gbp_profile_once

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    conn = connect()

    class RebindingClient:
        def list_locations(self, fbr_merchant_id):
            assert fbr_merchant_id == "fbr-merchant-123"
            other = connect()
            try:
                other.execute("BEGIN IMMEDIATE")
                current = other.execute(
                    "SELECT id,generation,valid_from FROM merchant_fbr_binding_events "
                    "WHERE merchant_id=? AND valid_to IS NULL",
                    (merchant["id"],),
                ).fetchone()
                rebound_at = (
                    datetime.strptime(
                        current["valid_from"], "%Y-%m-%dT%H:%M:%S.%fZ"
                    ).replace(tzinfo=timezone.utc)
                    + timedelta(microseconds=1)
                ).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
                other.execute(
                    "UPDATE merchant_fbr_binding_events "
                    "SET valid_to=?,closed_by='test',close_reason='stale worker fence' "
                    "WHERE id=?",
                    (rebound_at, current["id"]),
                )
                other.execute(
                    "INSERT INTO merchant_fbr_binding_events("
                    "merchant_id,fbr_merchant_id,generation,valid_from,opened_by,open_reason,created_at"
                    ") VALUES (?,?,?,?,?,?,?)",
                    (
                        merchant["id"],
                        "fbr-merchant-new",
                        current["generation"] + 1,
                        rebound_at,
                        "test",
                        "stale worker fence",
                        rebound_at,
                    ),
                )
                other.execute(
                    "UPDATE merchant_fbr_link_state SET sync_status='not_synced',"
                    "last_synced_at=NULL,last_error=NULL,updated_at=? WHERE merchant_id=?",
                    (rebound_at, merchant["id"]),
                )
                other.execute(
                    "DELETE FROM merchant_gbp_profiles WHERE merchant_id = ?",
                    (merchant["id"],),
                )
                other.commit()
            finally:
                other.close()
            return []

    try:
        synced = sync_gbp_profile_once(
            conn,
            RebindingClient(),
            merchant["id"],
            force=True,
            current_time=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc),
        )
        row = conn.execute(
            "SELECT fbr_merchant_id, sync_status, last_synced_at"
            " FROM merchant_fbr_links WHERE merchant_id = ?",
            (merchant["id"],),
        ).fetchone()
    finally:
        conn.close()

    assert synced is False
    assert dict(row) == {
        "fbr_merchant_id": "fbr-merchant-new",
        "sync_status": "not_synced",
        "last_synced_at": None,
    }


def test_gbp_sync_does_not_take_over_a_fresh_sync_lease(client):
    from datetime import datetime, timezone

    from app.db import connect
    from app.merchant_profiles import sync_gbp_profile_once

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    conn = connect()
    conn.execute(
        "UPDATE merchant_fbr_links SET sync_status = 'syncing', updated_at = ?"
        " WHERE merchant_id = ?",
        ("2026-09-03T11:59:00+00:00", merchant["id"]),
    )
    conn.commit()

    class MustNotBeCalled:
        def list_locations(self, _fbr_merchant_id):
            raise AssertionError("fresh lease must not be stolen")

    try:
        synced = sync_gbp_profile_once(
            conn,
            MustNotBeCalled(),
            merchant["id"],
            force=True,
            current_time=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc),
        )
    finally:
        conn.close()

    assert synced is False


def test_manual_and_scheduled_gbp_sync_share_one_cas_lease(client):
    from datetime import datetime, timedelta, timezone

    from app.db import connect
    from app.merchant_profiles import sync_gbp_profile_once

    merchant = create_merchant(client)
    client.put(
        f"/api/merchants/{merchant['id']}/fbr-link",
        json={"fbr_merchant_id": "fbr-merchant-123"},
    )
    first_conn = connect()
    collision_results = []

    class MustNotBeCalled:
        def list_locations(self, _fbr_merchant_id):
            raise AssertionError("the second worker must not reach FBR")

    class CollidingClient:
        def list_locations(self, _fbr_merchant_id):
            second_conn = connect()
            try:
                collision_results.append(
                    sync_gbp_profile_once(
                        second_conn,
                        MustNotBeCalled(),
                        merchant["id"],
                        current_time=(
                            datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc)
                            + timedelta(minutes=1)
                        ),
                    )
                )
            finally:
                second_conn.close()
            return []

    try:
        completed = sync_gbp_profile_once(
            first_conn,
            CollidingClient(),
            merchant["id"],
            force=True,
            current_time=datetime(2026, 9, 3, 12, 0, tzinfo=timezone.utc),
        )
    finally:
        first_conn.close()

    assert completed is True
    assert collision_results == [False]

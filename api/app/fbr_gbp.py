import json
import os
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen


GBP_FIELDS = (
    "LOCATION",
    "ATTRIBUTES",
    "FOOD_MENUS",
    "LOCAL_POSTS",
    "MEDIA",
    "CUSTOMER_MEDIA",
    "QUESTIONS",
    "PLACE_ACTION_LINKS",
    "VERIFICATIONS",
)

OPERATION_ASSISTANT_LOCATION_READ_MASK = ",".join(
    (
        "websiteUri",
        "phoneNumbers",
        "categories",
        "regularHours",
        "specialHours",
        "openInfo",
        "profile",
        "moreHours",
        "serviceItems",
    )
)


class FbrConfigurationError(RuntimeError):
    pass


class FbrUnavailableError(RuntimeError):
    pass


class FbrPayloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class FbrGbpSettings:
    base_url: str
    bearer_token: str | None
    timeout_seconds: float
    api_style: str = "seo_integration"


def fbr_gbp_settings() -> FbrGbpSettings | None:
    base_url = os.environ.get("FBR_SEO_BASE_URL", "").strip().rstrip("/")
    if not base_url:
        return None
    bearer_token = os.environ.get("FBR_SEO_BEARER_TOKEN", "").strip() or None
    timeout_raw = os.environ.get("FBR_SEO_TIMEOUT_SECONDS", "10").strip()
    try:
        timeout_seconds = float(timeout_raw)
    except ValueError as exc:
        raise FbrConfigurationError("FBR_SEO_TIMEOUT_SECONDS must be numeric") from exc
    if timeout_seconds <= 0:
        raise FbrConfigurationError("FBR_SEO_TIMEOUT_SECONDS must be positive")
    api_style = os.environ.get("FBR_SEO_API_STYLE", "seo_integration").strip().lower()
    if api_style not in {"seo_integration", "operation_assistant"}:
        raise FbrConfigurationError(
            "FBR_SEO_API_STYLE must be seo_integration or operation_assistant"
        )
    return FbrGbpSettings(base_url, bearer_token, timeout_seconds, api_style)


class FbrGbpClient:
    def __init__(self, settings: FbrGbpSettings):
        self.settings = settings
        self._operation_assistant_locations: dict[tuple[str, str], dict[str, Any]] = {}

    def _get_json(
        self,
        path: str,
        query: dict[str, str],
        extra_headers: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.settings.base_url}{path}?{urlencode(query)}"
        headers = {"Accept": "application/json"}
        if self.settings.bearer_token:
            headers["Authorization"] = f"Bearer {self.settings.bearer_token}"
        if extra_headers:
            headers.update(extra_headers)
        request = Request(url, headers=headers, method="GET")
        try:
            with urlopen(request, timeout=self.settings.timeout_seconds) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise FbrUnavailableError(f"FBR SEO service returned HTTP {exc.code}") from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise FbrUnavailableError("FBR SEO service is unavailable") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise FbrPayloadError("FBR SEO service returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise FbrPayloadError("FBR SEO service returned a non-object payload")
        return payload

    def list_locations(self, fbr_merchant_id: str) -> list[dict[str, Any]]:
        if self.settings.api_style == "operation_assistant":
            payload = self._get_json(
                "/gbp/location",
                {"merchant_id": fbr_merchant_id},
                {"x-merchant-id": fbr_merchant_id},
            )
        else:
            payload = self._get_json(
                "/google-business-profile", {"merchant_id": fbr_merchant_id}
            )
        locations = payload.get("locations")
        if not isinstance(locations, list) or any(not isinstance(item, dict) for item in locations):
            raise FbrPayloadError("FBR GBP location list is invalid")
        if self.settings.api_style == "operation_assistant":
            identities = []
            for location in locations:
                resource_name = _text(location.get("name"))
                gbp_location_id = resource_name.rsplit("/", 1)[-1] if resource_name else None
                if not gbp_location_id:
                    raise FbrPayloadError("FBR GBP location is missing name")
                self._operation_assistant_locations[(fbr_merchant_id, gbp_location_id)] = location
                identities.append(
                    {
                        "merchant_id": fbr_merchant_id,
                        "gbp_location_id": gbp_location_id,
                        "google_account_id": None,
                        "name": resource_name,
                        "title": _text(location.get("title")),
                        "place_id": _text(_as_dict(location.get("metadata")).get("place_id")),
                    }
                )
            return identities
        return locations

    def get_field(self, fbr_merchant_id: str, gbp_location_id: str, field: str) -> dict[str, Any]:
        if field not in GBP_FIELDS:
            raise ValueError(f"unsupported GBP field: {field}")
        if self.settings.api_style == "operation_assistant":
            encoded_location_id = quote(gbp_location_id, safe="")
            headers = {"x-merchant-id": fbr_merchant_id}
            if field == "LOCATION":
                location = self._operation_assistant_locations.get((fbr_merchant_id, gbp_location_id))
                if location is None:
                    raise FbrPayloadError("FBR GBP location was not loaded")
                detail = self._get_json(
                    f"/gbp/location/{encoded_location_id}",
                    {"read_mask": OPERATION_ASSISTANT_LOCATION_READ_MASK},
                    headers,
                )
                location = {**location, **detail}
            elif field == "ATTRIBUTES":
                location = self._get_json(
                    f"/gbp/location/{encoded_location_id}/attribute", {}, headers
                )
            elif field == "FOOD_MENUS":
                location = self._get_json(
                    f"/gbp/location/{encoded_location_id}/menu", {}, headers
                )
            elif field == "LOCAL_POSTS":
                location = self._get_json(
                    f"/gbp/location/{encoded_location_id}/post", {"limit": "20"}, headers
                )
            else:
                raise FbrUnavailableError(
                    f"FBR Operation Assistant does not expose persisted {field} snapshots"
                )
            return {
                "field": field,
                "value": json.dumps(
                    _operation_assistant_location_payload(location) if field == "LOCATION" else location,
                    ensure_ascii=False,
                    separators=(",", ":"),
                ),
                "updated_time": None,
            }
        encoded_location_id = quote(gbp_location_id, safe="")
        return self._get_json(
            f"/google-business-profile/{encoded_location_id}/field/{field}",
            {"merchant_id": fbr_merchant_id},
        )

    def get_reviews(self, fbr_merchant_id: str, gbp_location_id: str) -> dict[str, Any]:
        if self.settings.api_style != "operation_assistant":
            raise FbrUnavailableError("FBR SEO Integration does not expose reviews through this client")
        encoded_location_id = quote(gbp_location_id, safe="")
        return self._get_json(
            f"/gbp/review/{encoded_location_id}/review",
            {"unreplied_only": "false", "skip": "0", "limit": "50"},
            {"x-merchant-id": fbr_merchant_id},
        )

    def get_review_overview(
        self,
        fbr_merchant_id: str,
        gbp_location_id: str,
        *,
        query_date: str,
    ) -> dict[str, Any]:
        if self.settings.api_style != "operation_assistant":
            raise FbrUnavailableError(
                "FBR SEO Integration does not expose live review overview through this client"
            )
        return self._get_json(
            "/location/monthly-overview",
            {
                "location_id": gbp_location_id,
                "query_date": query_date,
                "start_rating": "1",
                "end_rating": "5",
            },
            {"x-merchant-id": fbr_merchant_id},
        )

    def list_performance_metrics(
        self,
        fbr_merchant_id: str,
        place_id: str,
        *,
        from_date: str,
        to_date: str,
    ) -> dict[str, Any]:
        if self.settings.api_style != "operation_assistant":
            raise FbrUnavailableError(
                "FBR SEO Integration does not expose GBP performance through this client"
            )
        return self._get_json(
            "/gbp/performance-metric",
            {"from_date": from_date, "to_date": to_date, "place_id": place_id},
            {"x-merchant-id": fbr_merchant_id},
        )

    def list_search_keyword_metrics(
        self,
        fbr_merchant_id: str,
        place_id: str,
        *,
        from_month: str,
        to_month: str,
    ) -> dict[str, Any]:
        if self.settings.api_style != "operation_assistant":
            raise FbrUnavailableError(
                "FBR SEO Integration does not expose GBP search keywords through this client"
            )
        return self._get_json(
            "/gbp/search-keyword-metric",
            {"from_month": from_month, "to_month": to_month, "place_id": place_id},
            {"x-merchant-id": fbr_merchant_id},
        )

    def get_local_keywords(self, place_id: str) -> dict[str, Any]:
        if self.settings.api_style != "operation_assistant":
            raise FbrUnavailableError(
                "FBR SEO Integration does not expose persisted local keywords through this client"
            )
        encoded_place_id = quote(place_id, safe="")
        return self._get_json(f"/seo/keyword/local/{encoded_place_id}", {})


def fbr_gbp_client() -> FbrGbpClient:
    settings = fbr_gbp_settings()
    if settings is None:
        raise FbrConfigurationError("FBR SEO integration is not configured")
    return FbrGbpClient(settings)


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _time(value: object) -> str | None:
    data = _as_dict(value)
    hours = data.get("hours")
    minutes = data.get("minutes", 0)
    if not isinstance(hours, int) or not isinstance(minutes, int):
        return None
    return f"{hours:02d}:{minutes:02d}"


def _category_name(value: object) -> str | None:
    category = _as_dict(value)
    return _text(category.get("displayName")) or _text(category.get("name"))


def _operation_assistant_location_payload(location: dict[str, Any]) -> dict[str, Any]:
    categories = _as_dict(location.get("categories"))
    address = _as_dict(location.get("storefront_address"))
    phones = _as_dict(location.get("phone_numbers"))
    hours = _as_dict(location.get("regular_hours"))
    profile = _as_dict(location.get("profile"))
    open_info = _as_dict(location.get("open_info"))

    def category(value: object) -> dict[str, Any]:
        source = _as_dict(value)
        return {
            "name": source.get("name"),
            "displayName": source.get("display_name"),
        }

    periods = []
    for value in _as_list(hours.get("periods")):
        source = _as_dict(value)
        periods.append(
            {
                "openDay": source.get("open_day"),
                "openTime": source.get("open_time"),
                "closeDay": source.get("close_day"),
                "closeTime": source.get("close_time"),
            }
        )

    return {
        "name": location.get("name"),
        "title": location.get("title"),
        "storeCode": location.get("store_code"),
        "languageCode": location.get("language_code"),
        "phoneNumbers": {
            "primaryPhone": phones.get("primary_phone"),
            "additionalPhones": phones.get("additional_phones"),
        },
        "storefrontAddress": {
            "addressLines": address.get("address_lines"),
            "locality": address.get("locality"),
            "administrativeArea": address.get("administrative_area"),
            "postalCode": address.get("postal_code"),
            "regionCode": address.get("region_code"),
        },
        "websiteUri": location.get("website_uri"),
        "categories": {
            "primaryCategory": category(categories.get("primary_category")),
            "additionalCategories": [
                category(value) for value in _as_list(categories.get("additional_categories"))
            ],
        },
        "openInfo": {
            "status": open_info.get("status"),
            "canReopen": open_info.get("can_reopen"),
            "openingDate": open_info.get("opening_date"),
        },
        "profile": {"description": profile.get("description")},
        "regularHours": {"periods": periods} if periods else None,
    }


def normalize_gbp_location(raw: str) -> dict[str, Any]:
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise FbrPayloadError("LOCATION payload is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise FbrPayloadError("LOCATION payload must be an object")

    phones = _as_dict(payload.get("phoneNumbers"))
    address = _as_dict(payload.get("storefrontAddress"))
    lines = [text for value in _as_list(address.get("addressLines")) if (text := _text(value))]
    locality = _text(address.get("locality"))
    administrative_area = _text(address.get("administrativeArea"))
    postal_code = _text(address.get("postalCode"))
    region_code = _text(address.get("regionCode"))
    area_postal = " ".join(value for value in (administrative_area, postal_code) if value)
    formatted_address = ", ".join(value for value in (*lines, locality, area_postal, region_code) if value)

    categories = _as_dict(payload.get("categories"))
    additional_categories = [
        name
        for item in _as_list(categories.get("additionalCategories"))
        if (name := _category_name(item))
    ]
    hours = []
    for period in _as_list(_as_dict(payload.get("regularHours")).get("periods")):
        item = _as_dict(period)
        hours.append(
            {
                "open_day": _text(item.get("openDay")),
                "open_time": _time(item.get("openTime")),
                "close_day": _text(item.get("closeDay")),
                "close_time": _time(item.get("closeTime")),
            }
        )

    return {
        "title": _text(payload.get("title")),
        "store_code": _text(payload.get("storeCode")),
        "language_code": _text(payload.get("languageCode")),
        "phone": _text(phones.get("primaryPhone")),
        "additional_phones": [
            text for value in _as_list(phones.get("additionalPhones")) if (text := _text(value))
        ],
        "address": formatted_address or None,
        "address_lines": lines,
        "locality": locality,
        "administrative_area": administrative_area,
        "postal_code": postal_code,
        "region_code": region_code,
        "website_url": _text(payload.get("websiteUri")),
        "primary_category": _category_name(categories.get("primaryCategory")),
        "additional_categories": additional_categories,
        "open_status": _text(_as_dict(payload.get("openInfo")).get("status")),
        "description": _text(_as_dict(payload.get("profile")).get("description")),
        "regular_hours": hours,
    }

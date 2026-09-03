import math
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .coreai import CoreAiClient
from .keyword_identity import _keyword_identity


LIST_FIELD_MASK = (
    "report_key,date,place_id,keyword,platform,arp,atrp,solv,"
    "grid_size,radius,measurement"
)

REPORT_FIELD_MASK = (
    "report_key,date,place_id,platform,keyword,lat,lng,grid_size,radius,measurement,"
    "arp,atrp,solv,found_in,image,heatmap,data_points.*.lat,data_points.*.lng,"
    "data_points.*.found,data_points.*.rank"
)


def _report_date(value: object) -> datetime:
    if not isinstance(value, str):
        return datetime.min
    for pattern in ("%m/%d/%Y %I:%M %p", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            parsed = datetime.strptime(value, pattern)
        except ValueError:
            continue
        return parsed.replace(tzinfo=None)
    return datetime.min


class LocalFalconClient:
    def __init__(self, coreai: CoreAiClient, server_id: str):
        self._coreai = coreai
        self._server_id = server_id

    def list_latest_exact_report(self, place_id: str, keyword: str) -> dict | None:
        body = self._coreai.call_mcp_tool(
            self._server_id,
            "listLocalFalconScanReports",
            {
                "placeId": place_id,
                "keyword": keyword,
                "platform": "google",
                "fieldmask": LIST_FIELD_MASK,
            },
        )
        reports = body.get("reports")
        if not isinstance(reports, list):
            raise ValueError("Local Falcon report list response is malformed")
        normalized = _keyword_identity(keyword)
        exact = [
            report
            for report in reports
            if isinstance(report, dict)
            and report.get("place_id") == place_id
            and isinstance(report.get("keyword"), str)
            and _keyword_identity(report["keyword"]) == normalized
            and report.get("platform", "google") == "google"
        ]
        return max(exact, key=lambda report: _report_date(report.get("date")), default=None)

    def get_report(self, report_key: str) -> dict:
        return self._coreai.call_mcp_tool(
            self._server_id,
            "getLocalFalconReport",
            {"reportKey": report_key, "fieldmask": REPORT_FIELD_MASK},
        )

    def run_scan(
        self,
        *,
        place_id: str,
        keyword: str,
        lat: float,
        lng: float,
        grid_size: int,
        radius: float,
        measurement: Literal["mi", "km"],
    ) -> dict:
        return self._coreai.call_mcp_tool(
            self._server_id,
            "runLocalFalconScan",
            {
                "placeId": place_id,
                "keyword": keyword,
                "lat": lat,
                "lng": lng,
                "gridSize": str(grid_size),
                "radius": radius,
                "measurement": measurement,
                "platform": "google",
                "aiAnalysis": False,
            },
        )


class LocalFalconGridPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    found: bool
    rank: int | None = Field(default=None, ge=1, le=200)

    @model_validator(mode="after")
    def validate_found_rank(self):
        if self.found and self.rank is None:
            raise ValueError("found Local Falcon points require a rank")
        if not self.found and self.rank is not None:
            raise ValueError("unfound Local Falcon points cannot contain a rank")
        return self


class LocalFalconSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["seo_ops.local_falcon_snapshot.v1"]
    report_key: str = Field(pattern=r"^[a-f0-9]{15}$")
    place_id: str = Field(min_length=1, max_length=300)
    keyword: str = Field(min_length=1, max_length=300)
    platform: Literal["google"]
    captured_at: str = Field(min_length=1, max_length=50)
    center_lat: float = Field(ge=-90, le=90)
    center_lng: float = Field(ge=-180, le=180)
    # The operator UI and the persisted scan contract currently support the
    # Local Falcon 3x3, 5x5, 7x7 and 9x9 grids. Reject larger reports instead
    # of rendering an unreviewed shape or silently truncating it.
    grid_size: int = Field(ge=3, le=9)
    radius: float = Field(gt=0, le=100)
    measurement: Literal["mi", "km"]
    arp: float = Field(ge=0, le=200)
    atrp: float = Field(ge=0, le=200)
    solv: float = Field(ge=0, le=100)
    found_in: int = Field(ge=0)
    image_url: str | None = Field(default=None, max_length=2000)
    heatmap_url: str | None = Field(default=None, max_length=2000)
    grid_points: list[LocalFalconGridPoint]

    @model_validator(mode="after")
    def validate_grid(self):
        if self.grid_size % 2 == 0:
            raise ValueError("Local Falcon grid size must be odd")
        expected = self.grid_size * self.grid_size
        if len(self.grid_points) != expected:
            raise ValueError(f"Local Falcon grid requires {expected} points")
        coordinates = [(point.lat, point.lng) for point in self.grid_points]
        if len(set(coordinates)) != expected:
            raise ValueError("Local Falcon grid contains a duplicate coordinate")
        latitudes = set(point.lat for point in self.grid_points)
        longitudes = set(point.lng for point in self.grid_points)
        rectangle = {
            (latitude, longitude)
            for latitude in latitudes
            for longitude in longitudes
        }
        if (
            len(latitudes) != self.grid_size
            or len(longitudes) != self.grid_size
            or set(coordinates) != rectangle
        ):
            raise ValueError("Local Falcon points must form a complete rectangular grid")
        if self.found_in > expected:
            raise ValueError("Local Falcon found_in exceeds grid point count")
        if self.found_in != sum(1 for point in self.grid_points if point.found):
            raise ValueError("Local Falcon found_in does not match the grid points")
        return self


def _float(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"Local Falcon {label} is not numeric")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Local Falcon {label} is not numeric") from exc
    if not math.isfinite(result):
        raise ValueError(f"Local Falcon {label} is not finite")
    return result


def _int(value: object, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"Local Falcon {label} is not an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isfinite(value) and value.is_integer():
            return int(value)
        raise ValueError(f"Local Falcon {label} is not an integer")
    if isinstance(value, str) and re.fullmatch(r"[+-]?\d+", value.strip()):
        return int(value)
    raise ValueError(f"Local Falcon {label} is not an integer")


def _captured_at(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Local Falcon date is missing")
    for pattern in ("%m/%d/%Y %I:%M %p", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            parsed = datetime.strptime(value, pattern)
        except ValueError:
            continue
        return parsed.replace(tzinfo=None).isoformat()
    raise ValueError("Local Falcon date format is unsupported")


def normalize_local_falcon_report(
    raw: dict,
    *,
    expected_place_id: str,
    expected_keyword: str,
) -> dict:
    points = raw.get("data_points")
    if not isinstance(points, list):
        raise ValueError("Local Falcon data_points are missing")
    normalized_points = []
    for item in points:
        if not isinstance(item, dict):
            raise ValueError("Local Falcon grid point is not an object")
        found = item.get("found")
        if not isinstance(found, bool):
            raise ValueError("Local Falcon grid point found is not boolean")
        raw_rank = item.get("rank")
        rank = None if raw_rank in (None, False, "", "0", 0) else _int(raw_rank, "rank")
        normalized_points.append(
            {
                "lat": _float(item.get("lat"), "point latitude"),
                "lng": _float(item.get("lng"), "point longitude"),
                "found": found,
                "rank": rank,
            }
        )

    place_id = raw.get("place_id")
    if place_id != expected_place_id:
        raise ValueError("Local Falcon Place ID does not match the merchant")
    keyword = raw.get("keyword")
    if (
        not isinstance(keyword, str)
        or _keyword_identity(keyword) != _keyword_identity(expected_keyword)
    ):
        raise ValueError("Local Falcon keyword does not match the accepted keyword")

    snapshot = LocalFalconSnapshot.model_validate(
        {
            "schema_version": "seo_ops.local_falcon_snapshot.v1",
            "report_key": raw.get("report_key"),
            "place_id": place_id,
            "keyword": keyword.strip(),
            "platform": raw.get("platform"),
            "captured_at": _captured_at(raw.get("date")),
            "center_lat": _float(raw.get("lat"), "center latitude"),
            "center_lng": _float(raw.get("lng"), "center longitude"),
            "grid_size": _int(raw.get("grid_size"), "grid_size"),
            "radius": _float(raw.get("radius"), "radius"),
            "measurement": raw.get("measurement"),
            "arp": _float(raw.get("arp"), "ARP"),
            "atrp": _float(raw.get("atrp"), "ATRP"),
            "solv": _float(raw.get("solv"), "SoLV"),
            "found_in": _int(raw.get("found_in"), "found_in"),
            "image_url": raw.get("image") or None,
            "heatmap_url": raw.get("heatmap") or None,
            "grid_points": normalized_points,
        }
    )
    return snapshot.model_dump(mode="json")

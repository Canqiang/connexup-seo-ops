"""Stable GBP location identity, store timezone state and frozen query populations."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .canonical_json import canonical_sha256

CANONICAL_INSTANT_FORMAT = "%Y-%m-%dT%H:%M:%S.%fZ"
GBP_LOCATION_PREFIX = "locations/"


class TimezoneUnresolved(RuntimeError):
    """Raised when a population cannot be aggregated on store-local days."""


class IdentityConflict(RuntimeError):
    """Raised when a GBP location is already bound to a different merchant."""


@dataclass(frozen=True)
class MerchantLocationRow:
    id: int
    merchant_id: int
    display_name: str
    timezone_name: str | None
    status: str


@dataclass(frozen=True)
class BoundScope:
    location: MerchantLocationRow
    scope_id: int
    external_id: str
    place_id: str | None
    binding_generation: int


@dataclass(frozen=True)
class PopulationManifest:
    merchant_id: int
    scopes: tuple[BoundScope, ...]
    manifest: dict
    manifest_sha256: str


def canonical_instant(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("naive datetimes are not accepted")
    return value.astimezone(ZoneInfo("UTC")).strftime(CANONICAL_INSTANT_FORMAT)


def canonical_gbp_external_id(raw: str) -> str:
    value = raw.strip()
    if value.startswith(GBP_LOCATION_PREFIX):
        value = value[len(GBP_LOCATION_PREFIX) :]
    if not value:
        raise IdentityConflict("GBP location id is required")
    return value


def _location_row(conn: sqlite3.Connection, location_id: int) -> MerchantLocationRow:
    row = conn.execute(
        "SELECT id, merchant_id, display_name, timezone_name, status FROM merchant_locations WHERE id = ?",
        (location_id,),
    ).fetchone()
    return MerchantLocationRow(row["id"], row["merchant_id"], row["display_name"], row["timezone_name"], row["status"])


def seed_gbp_locations_from_profiles(
    conn: sqlite3.Connection, merchant_id: int, *, actor: str, observed_at: datetime
) -> tuple[BoundScope, ...]:
    """Create one location, scope and binding per stored GBP profile. Idempotent."""
    stamp = canonical_instant(observed_at)
    profiles = conn.execute(
        "SELECT gbp_location_id, source_title, normalized_json FROM merchant_gbp_profiles"
        " WHERE merchant_id = ? ORDER BY gbp_location_id",
        (merchant_id,),
    ).fetchall()
    scopes: list[BoundScope] = []
    for profile in profiles:
        external_id = canonical_gbp_external_id(profile["gbp_location_id"])
        canonical_key = f"gbp_location:{external_id}"
        normalized = json.loads(profile["normalized_json"] or "{}")
        place_id = normalized.get("place_id")
        display_name = profile["source_title"] or normalized.get("title") or external_id
        existing = conn.execute(
            "SELECT id FROM source_scopes WHERE source='GBP' AND scope_type='GBP_LOCATION' AND canonical_key = ?",
            (canonical_key,),
        ).fetchone()
        if existing is None:
            cursor = conn.execute(
                "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
                " date_basis, metadata_json, created_at) VALUES ('GBP','GBP_LOCATION',?,?,NULL,'store_local',?,?)",
                (external_id, canonical_key, json.dumps({"place_id": place_id}, sort_keys=True), stamp),
            )
            scope_id = int(cursor.lastrowid)
        else:
            scope_id = int(existing["id"])
        binding = conn.execute(
            "SELECT merchant_id, merchant_location_id, binding_generation FROM source_scope_bindings"
            " WHERE source_scope_id = ? AND valid_to IS NULL",
            (scope_id,),
        ).fetchone()
        if binding is not None:
            if binding["merchant_id"] != merchant_id:
                raise IdentityConflict("GBP location is bound to another merchant")
            location = _location_row(conn, binding["merchant_location_id"])
            scopes.append(BoundScope(location, scope_id, external_id, place_id, binding["binding_generation"]))
            continue
        cursor = conn.execute(
            "INSERT INTO merchant_locations (merchant_id, display_name, canonical_address, timezone_name,"
            " status, created_at) VALUES (?,?,NULL,NULL,'needs_attention',?)",
            (merchant_id, display_name, stamp),
        )
        location_id = int(cursor.lastrowid)
        conn.execute(
            "INSERT INTO merchant_location_status_events (merchant_location_id, status, timezone_name,"
            " metadata_json, effective_at, generation, actor, reason, created_at)"
            " VALUES (?, 'needs_attention', NULL, '{}', ?, 1, ?, 'seeded_from_gbp_profile', ?)",
            (location_id, stamp, actor, stamp),
        )
        conn.execute(
            "INSERT INTO source_scope_bindings (source_scope_id, merchant_id, merchant_location_id,"
            " binding_generation, valid_from, valid_to, created_by, created_at) VALUES (?,?,?,1,?,NULL,?,?)",
            (scope_id, merchant_id, location_id, stamp, actor, stamp),
        )
        scopes.append(BoundScope(_location_row(conn, location_id), scope_id, external_id, place_id, 1))
    conn.commit()
    return tuple(scopes)


def set_location_timezone(
    conn: sqlite3.Connection, location_id: int, timezone_name: str, *, actor: str, effective_at: datetime
) -> MerchantLocationRow:
    try:
        ZoneInfo(timezone_name)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise ValueError(f"invalid IANA timezone: {timezone_name}") from exc
    stamp = canonical_instant(effective_at)
    conn.execute("BEGIN IMMEDIATE")
    try:
        generation = conn.execute(
            "SELECT COALESCE(MAX(generation), 0) + 1 FROM merchant_location_status_events"
            " WHERE merchant_location_id = ?",
            (location_id,),
        ).fetchone()[0]
        conn.execute(
            "UPDATE merchant_locations SET timezone_name = ?, status = 'active' WHERE id = ?",
            (timezone_name, location_id),
        )
        conn.execute(
            "INSERT INTO merchant_location_status_events (merchant_location_id, status, timezone_name,"
            " metadata_json, effective_at, generation, actor, reason, created_at)"
            " VALUES (?, 'active', ?, '{}', ?, ?, ?, 'operator_set_timezone', ?)",
            (location_id, timezone_name, stamp, generation, actor, stamp),
        )
        conn.execute(
            "UPDATE source_scopes SET timezone_name = ? WHERE id IN"
            " (SELECT source_scope_id FROM source_scope_bindings"
            "  WHERE merchant_location_id = ? AND valid_to IS NULL)",
            (timezone_name, location_id),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return _location_row(conn, location_id)


def resolve_bound_scopes(
    conn: sqlite3.Connection, merchant_id: int, location_ids: tuple[int, ...] | None, *, as_of: datetime
) -> tuple[BoundScope, ...]:
    stamp = canonical_instant(as_of)
    rows = conn.execute(
        "SELECT b.source_scope_id, b.merchant_location_id, b.binding_generation, s.external_id, s.metadata_json"
        " FROM source_scope_bindings b JOIN source_scopes s ON s.id = b.source_scope_id"
        " WHERE b.merchant_id = ? AND s.source = 'GBP' AND b.valid_from <= ?"
        "   AND (b.valid_to IS NULL OR b.valid_to > ?)"
        " ORDER BY b.merchant_location_id",
        (merchant_id, stamp, stamp),
    ).fetchall()
    scopes = []
    for row in rows:
        if location_ids is not None and row["merchant_location_id"] not in location_ids:
            continue
        location = _location_row(conn, row["merchant_location_id"])
        if location.status == "archived":
            continue
        metadata = json.loads(row["metadata_json"] or "{}")
        scopes.append(
            BoundScope(location, row["source_scope_id"], row["external_id"], metadata.get("place_id"), row["binding_generation"])
        )
    return tuple(scopes)


def build_population_manifest(
    conn: sqlite3.Connection, merchant_id: int, location_ids: tuple[int, ...] | None, *, as_of: datetime
) -> PopulationManifest:
    scopes = resolve_bound_scopes(conn, merchant_id, location_ids, as_of=as_of)
    manifest = {
        "contract": "seo_ops.performance_population.v1",
        "merchant_id": merchant_id,
        "as_of": canonical_instant(as_of),
        "locations": [
            {
                "location_id": scope.location.id,
                "scope_id": scope.scope_id,
                "external_id": scope.external_id,
                "binding_generation": scope.binding_generation,
                "timezone_name": scope.location.timezone_name,
                "date_basis": "store_local",
                "status": scope.location.status,
            }
            for scope in scopes
        ],
    }
    return PopulationManifest(merchant_id, scopes, manifest, canonical_sha256(manifest))


def resolve_default_end(population: PopulationManifest, *, as_of: datetime) -> date:
    if not population.scopes:
        raise TimezoneUnresolved("population_empty_for_default_period")
    candidates: list[date] = []
    for scope in population.scopes:
        if not scope.location.timezone_name:
            raise TimezoneUnresolved("default_period_date_basis_unresolved")
        local_today = as_of.astimezone(ZoneInfo(scope.location.timezone_name)).date()
        candidates.append(local_today - timedelta(days=1))
    return min(candidates)

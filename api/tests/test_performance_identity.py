from datetime import date, datetime, timezone

import pytest

from app.performance_identity import (
    TimezoneUnresolved,
    build_population_manifest,
    resolve_default_end,
    seed_gbp_locations_from_profiles,
    set_location_timezone,
)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def test_seeding_creates_one_scope_and_binding_per_gbp_location(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    assert [scope.external_id for scope in scopes] == ["1860638126797610816", "24300588970198995"]
    assert all(scope.binding_generation == 1 for scope in scopes)
    assert all(scope.location.timezone_name is None for scope in scopes)


def test_seeding_twice_does_not_duplicate_scopes_or_bindings(conn, merchant_with_gbp_profiles):
    first = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    second = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    assert [s.location.id for s in first] == [s.location.id for s in second]
    assert conn.execute("SELECT COUNT(*) FROM source_scope_bindings").fetchone()[0] == 2


def test_population_manifest_hash_is_stable_and_changes_with_timezone(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    before = build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW)
    assert (
        before.manifest_sha256
        == build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW).manifest_sha256
    )
    set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=NOW)
    after = build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW)
    assert after.manifest_sha256 != before.manifest_sha256


def test_default_end_is_yesterday_in_the_slowest_store_timezone(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=NOW)
    set_location_timezone(conn, scopes[1].location.id, "Asia/Tokyo", actor="test", effective_at=NOW)
    population = build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW)
    # 2026-09-09T12:00Z is 08:00 in New York and 21:00 in Tokyo.
    assert resolve_default_end(population, as_of=NOW) == date(2026, 9, 8)


def test_missing_timezone_fails_closed_instead_of_guessing(conn, merchant_with_gbp_profiles):
    seed_gbp_locations_from_profiles(conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW)
    population = build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW)
    with pytest.raises(TimezoneUnresolved):
        resolve_default_end(population, as_of=NOW)


def test_invalid_timezone_is_rejected_without_writing(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    with pytest.raises(ValueError):
        set_location_timezone(conn, scopes[0].location.id, "Mars/Olympus", actor="test", effective_at=NOW)
    assert conn.execute(
        "SELECT timezone_name FROM merchant_locations WHERE id = ?", (scopes[0].location.id,)
    ).fetchone()[0] is None

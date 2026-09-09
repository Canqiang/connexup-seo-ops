import json
from datetime import date, datetime, timezone

import pytest

from app.performance_identity import (
    IdentityConflict,
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
    # The population identifies *which* scopes a query ran against, not *when* it was
    # resolved: a different as_of over an unchanged population must hash the same.
    later = datetime(2026, 9, 9, 18, 0, tzinfo=timezone.utc)
    assert (
        before.manifest_sha256
        == build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=later).manifest_sha256
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
    # 2026-09-09T12:00Z is 08:00 in New York and 21:00 in Tokyo: both yesterdays land
    # on 09-08, so this case alone cannot distinguish min() from max().
    assert resolve_default_end(population, as_of=NOW) == date(2026, 9, 8)
    # 2026-09-09T20:00Z is 16:00 in New York (yesterday is still 09-08) but already
    # 05:00 on 09-10 in Tokyo (yesterday is 09-09) -- this discriminates min from max:
    # only min() correctly returns the New York date.
    later = datetime(2026, 9, 9, 20, 0, tzinfo=timezone.utc)
    assert resolve_default_end(population, as_of=later) == date(2026, 9, 8)


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


def test_resolve_default_end_rejects_naive_as_of(conn, merchant_with_gbp_profiles):
    scopes = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )
    set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=NOW)
    set_location_timezone(conn, scopes[1].location.id, "Asia/Tokyo", actor="test", effective_at=NOW)
    population = build_population_manifest(conn, merchant_with_gbp_profiles, None, as_of=NOW)
    naive = datetime(2026, 9, 9, 12, 0)
    with pytest.raises(ValueError):
        resolve_default_end(population, as_of=naive)


def test_conflicting_binding_rolls_back_and_leaves_the_connection_usable(conn, merchant_with_gbp_profiles):
    # Bind merchant 3's real locations first.
    seeded = seed_gbp_locations_from_profiles(
        conn, merchant_with_gbp_profiles, actor="test", observed_at=NOW
    )

    # A second merchant whose profile list has one brand-new location (sorts first,
    # so its location/status-event/binding rows are written before the conflict) and
    # one location that collides with a GBP location already bound to merchant 3.
    conflicting_merchant_id = 5
    conn.execute(
        "INSERT INTO merchants (id, name, status, created_at) VALUES"
        " (5,'Rival Claimant','active','2026-09-01T00:00:00.000000Z')"
    )
    for location_id, title, place_id in (
        ("0000000000000000001", "Phantom Branch", "ChIJphantombranch"),
        ("1860638126797610816", "Clinton Hill", "ChIJaYcllU0N7ocR4lWiLngfEYg"),
    ):
        conn.execute(
            "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id,"
            " source_title, location_json, normalized_json, synced_at) VALUES"
            " (5,'fbr-5',?,?,'{}',?,'2026-09-03T00:00:00.000000Z')",
            (location_id, title, json.dumps({"title": title, "place_id": place_id})),
        )
    conn.commit()

    with pytest.raises(IdentityConflict):
        seed_gbp_locations_from_profiles(conn, conflicting_merchant_id, actor="test", observed_at=NOW)

    # Nothing from the rejected merchant's transaction survives, including the
    # first (non-conflicting) profile that was inserted before the conflict fired.
    assert conn.execute(
        "SELECT COUNT(*) FROM merchant_locations WHERE merchant_id = ?", (conflicting_merchant_id,)
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM source_scopes WHERE canonical_key = 'gbp_location:0000000000000000001'"
    ).fetchone()[0] == 0
    assert conn.execute(
        "SELECT COUNT(*) FROM source_scope_bindings WHERE merchant_id = ?", (conflicting_merchant_id,)
    ).fetchone()[0] == 0

    # The connection is not left mid-transaction: a following writer can still
    # BEGIN IMMEDIATE instead of dying with "cannot start a transaction within a
    # transaction".
    updated = set_location_timezone(
        conn, seeded[0].location.id, "America/New_York", actor="test", effective_at=NOW
    )
    assert updated.timezone_name == "America/New_York"

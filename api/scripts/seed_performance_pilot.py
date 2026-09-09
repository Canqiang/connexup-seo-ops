# api/scripts/seed_performance_pilot.py
"""Seed GBP location scopes and store timezones for one pilot merchant."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone

from app.db import connect
from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--merchant-id", type=int, required=True)
    parser.add_argument("--timezone", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    conn = connect()
    try:
        profiles = conn.execute(
            "SELECT gbp_location_id, source_title FROM merchant_gbp_profiles WHERE merchant_id = ?"
            " ORDER BY gbp_location_id",
            (args.merchant_id,),
        ).fetchall()
        for row in profiles:
            print(f"location {row['gbp_location_id']} · {row['source_title']} → timezone {args.timezone}")
        if not args.apply:
            print(f"dry run: {len(profiles)} location(s); rerun with --apply to write")
            return 0
        scopes = seed_gbp_locations_from_profiles(conn, args.merchant_id, actor="operator", observed_at=now)
        for scope in scopes:
            set_location_timezone(conn, scope.location.id, args.timezone, actor="operator", effective_at=now)
            print(f"seeded location_id={scope.location.id} scope_id={scope.scope_id}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

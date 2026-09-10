# V1 pilot run — Choice Brooklyn

Executed 2026-09-10 by the operator session, following
`docs/operations/performance-history-v1-pilot.md` on merged `main` @ 930c895.

## What ran

| Step | Result |
|---|---|
| 1 Backup + integrity | `data/seo-ops-v3.backup-20260910-080754.db` (2,342,912 bytes); `PRAGMA integrity_check` through the app connection returned `[('ok',)]`; `foreign_key_check` empty |
| 2 Rehearsal on a copy | Dry run printed both locations and wrote nothing (bindings stayed 0); two `--apply` runs both printed `location_id=1 scope_id=1` and `location_id=2 scope_id=2`; final binding count exactly 2; copy deleted |
| 3 Real seed | Both locations seeded, `America/New_York`, `date_basis=store_local`, binding generation 1 |
| 4 Flags | `SEO_OPS_PERFORMANCE_SYNC_ENABLED=true`, `SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED=true`, `SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS=3` appended to `api/.env` (backed up first) |
| 5 Tunnel | `kubectl port-forward svc/operation-assistant-api -n uat 18791:80`, `FBR_SEO_BASE_URL` temporarily pointed at it |
| 6 Backfill | Preflight clamped `2026-08-01` to `2026-08-18`, 2 partitions x 2 locations = 4 batches, no blockers. Job 1 confirmed, reached `succeeded` with `partitions_published: 4, failed: 0, pending: 0` |
| 7 Verification | Two identical queries byte-identical (`diff` silent). Impressions total and every daily value matched the raw observation heads exactly |

## V1 claims, as tested

**历史能查准 — PASS (partial scope).** Query for `2026-08-20`..`2026-09-02`
returned `gbp_impressions_total` of `37516`; the same sum computed directly
from `metric_observation_heads` is `37516.0`, and all 14 daily values match
one for one. `population_hash` `02e909a2e3fd87e2`.

**同一查询可重复 — PASS.** Two identical requests two seconds apart produced
byte-identical responses (`query-2026-09.json` vs `query-repeat.json`).

**过去完整月 — NOT YET TESTABLE.** The source starts at `2026-08-18`, so
September 2026 is the first complete month and cannot be checked before
October. This is the limitation the runbook already records.

## What the run confirmed about the corrected runbook

Step 7's corrected wording was right. The `previous_equal_length` comparison
window (`2026-08-06`..`2026-08-19`) overlaps the source start by two days, so
the comparison is `observed: 2, expected: 14, completeness: partial` and every
KPI reports a computed percent (impressions `+557.1`) rather than
`comparison_unavailable`. That percent compares a full 14-day sum against two
observed days and must not be read as a real change — exactly what the runbook
now tells the operator to check.

## Stored facts after the run

| Table | Rows |
|---|---|
| `metric_observations` | 384 |
| `metric_observation_heads` | 320 (20 days x 8 metrics x 2 locations) |
| `metric_sync_batches` | 6 (4 backfill + 2 from the daily trailing window) |
| `metric_sync_jobs` | 2 (1 backfill + 1 daily) |
| `metric_source_artifacts` | 6 |
| `data_quality_events` | 73, all `source_omits_metric_rows` |

`backfill_notes` was empty: republishing the trailing window changed no value,
which is what a value-based `superseded` should report.

**The quality-event dedupe held under real republication.** 73 rows, 73
distinct on the dedupe key, and 34 of them carry `last_seen_at != first_seen_at`
— the daily job re-saw those omissions and updated them in place instead of
inserting duplicates. That was the whole-branch review's first Important
finding, and this run exercises the fix.

## Rollback

Set both flags to `false` in `api/.env` and restart. No data is deleted; the
observations, heads and quality events stay queryable if the flags are turned
back on. `data/seo-ops-v3.backup-20260910-080754.db` restores the pre-pilot
state entirely.

## Files

- `query-2026-09.json` — the verification query response
- `query-repeat.json` — the same request repeated, byte-identical

# Performance History V1 — Choice Brooklyn pilot cutover

Operator runbook for turning on GBP daily-metrics history (Task 11 of the
`history-slice-v1` slice) for exactly one pilot merchant. It assumes no
prior familiarity with how the feature was built — only that you can run
commands in this repository, have `sqlite3` and `kubectl` available, and
have UAT operator credentials for the SEO Ops API.

## Status of this document

`api/scripts/seed_performance_pilot.py` exists and has been rehearsed
against a throwaway copy of the database (see the engineering task report
for the transcript). **Nothing in this runbook has been run against the
real database, the live FBR source, or the UAT cluster.** Steps 3 onward
below are the operator's remaining work — follow them in order, in the
main checkout (`/Users/xander/git_repo/connexup-seo-ops`), not in a worktree.

## What this does

Seeds two `merchant_locations` rows (one GBP location scope each) for
merchant id `3`, **Choice Brooklyn**, and sets both to `America/New_York`:

| GBP location id | Display name |
|---|---|
| `1860638126797610816` | Choice Brooklyn - Clinton Hill |
| `24300588970198995` | Choice Brooklyn - Upper West Side |

Then it turns on the sync/read feature flags for merchant `3` only, backfills
history through a port-forwarded FBR tunnel, and proves the result is
deterministic and hand-checkable against the raw observation rows.

Nothing here is destructive: seeding only inserts rows (idempotently), and
the rollback at the end only flips two flags back off.

---

## Step 1 — Back up the database and verify it

```bash
cd /Users/xander/git_repo/connexup-seo-ops
cp data/seo-ops-v3.db "data/seo-ops-v3.backup-$(date +%Y%m%d-%H%M%S).db"
```

Record the exact backup filename this prints/creates — you'll want it in
your own evidence notes.

**Do not use `sqlite3 data/seo-ops-v3.db "PRAGMA integrity_check;"` for the
check.** This schema declares several `CHECK` constraints that call a
custom SQL function (`is_canonical_utc_instant`, registered only by the
application's own `sqlite3.Connection`, see `api/app/migrations.py`). The
bare `sqlite3` CLI does not have that function, so `PRAGMA integrity_check`
(and `PRAGMA quick_check`) fails there with:

```
Error: in prepare, unknown function: is_canonical_utc_instant()
```

That is not a corruption signal — it is the CLI missing a UDF the schema
depends on. Run the integrity check through the app's own connection
helper instead, which registers it:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
SEO_OPS_DB=../data/seo-ops-v3.backup-<timestamp>.db .venv/bin/python -c "
from app.db import connect
conn = connect()
print([tuple(r) for r in conn.execute('PRAGMA integrity_check;').fetchall()])
conn.close()
"
```

Expected: `[('ok',)]`. Do this against the **backup** file (not the live
`data/seo-ops-v3.db`) so nothing else can be writing to it while you check.

---

## Step 2 — Rehearse the seeding script on a copy

Never run `--apply` against the real database on the first try. Copy it out
and rehearse first:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
cp ../data/seo-ops-v3.db /tmp/seo-ops-rehearsal.db
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot \
  --merchant-id 3 --timezone America/New_York
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot \
  --merchant-id 3 --timezone America/New_York --apply
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot \
  --merchant-id 3 --timezone America/New_York --apply
sqlite3 /tmp/seo-ops-rehearsal.db "SELECT COUNT(*) FROM source_scope_bindings;"
```

Expected:

- The first run (no `--apply`) prints the two locations above and
  `dry run: 2 location(s); rerun with --apply to write` — it writes
  nothing (`SELECT COUNT(*) FROM source_scope_bindings` on the copy stays
  `0` afterwards).
- Both `--apply` runs print `seeded location_id=1 scope_id=1` and
  `seeded location_id=2 scope_id=2` (or whatever ids the copy already had
  in use — the point is the **same** two ids both times).
- The final `SELECT COUNT(*)` is exactly `2`.

Delete `/tmp/seo-ops-rehearsal.db` when you're done with it; it is a scratch
copy, not evidence.

---

## Step 3 — Seed the real database

Once Step 2 rehearsed clean:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York --apply
```

This writes to `data/seo-ops-v3.db` (the default `SEO_OPS_DB`) — do **not**
set `SEO_OPS_DB` this time. Confirm it printed `seeded location_id=... scope_id=...`
for both locations before moving on.

It is safe to re-run this command — the resulting location ids, scope ids,
binding count, and timezone all converge to the same values every time —
but it is not silent on repeat: `set_location_timezone` appends a fresh
`merchant_location_status_events` row on every `--apply` run even when the
timezone doesn't change, so re-running Step 3 more than once grows that
table's audit trail (two runs leave three events per location, not two).
That is expected and harmless, not a sign something went wrong.

---

## Step 4 — Turn on the two feature flags, scoped to this merchant only

Edit `api/.env` (gitignored; never commit real values) and set:

```dotenv
SEO_OPS_PERFORMANCE_SYNC_ENABLED=true
SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED=true
SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS=3
```

`SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS` is a comma-separated allowlist of
merchant ids — every route behind these flags (`_require_pilot` in
`app/performance_sync_api.py`, `_require_read_gate` in
`app/performance_query_api.py`) checks both "is the flag on" and "is this
merchant id in the list" before doing anything, and returns HTTP 409
otherwise. **Both flags default to off/empty in every other environment
(`api/.env.example` ships them `false`/empty) — leave them that way
everywhere except the environment you're piloting in, until this evidence
is accepted.**

Restart (or start) the API after editing `.env` so it picks up the new
values:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/uvicorn app.main:app --reload --port 8000 --env-file .env
```

Log in as an operator to get a session cookie for the calls below (username
and password come from `SEO_OPS_AUTH_USERNAME` / `SEO_OPS_AUTH_PASSWORD` in
`api/.env` — never paste the actual values into this runbook, your shell
history file, or any evidence file):

```bash
curl -s -X POST localhost:8000/api/auth/login -c cookies.txt \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$SEO_OPS_AUTH_USERNAME\",\"password\":\"$SEO_OPS_AUTH_PASSWORD\"}"
```

Expected: `{"username":"...","role":"operator"}` and a `cookies.txt` file
now holding a `seo_ops_session` cookie. Every `-b cookies.txt` call below
depends on this having succeeded.

---

## Step 5 — Open the port-forward to FBR

`FBR_SEO_BASE_URL` in a UAT-like environment points at a cluster-internal
address the API host can't reach directly. In a **separate shell**, open a
tunnel and leave it running for the whole backfill:

```bash
kubectl port-forward svc/operation-assistant-api -n uat 18791:80
```

Set (in the shell where you'll run/restart the API):

```dotenv
FBR_SEO_BASE_URL=http://127.0.0.1:18791
```

and restart the API from Step 4 so it picks up the new base URL. Close the
port-forward shell only after Step 6 finishes (the job status polling and
the queries in Step 7 do not need FBR directly, but leave the tunnel open
until the job reaches a terminal status so a retry can still reach the
source).

---

## Step 6 — Preflight, confirm, and poll the backfill job

Preflight is read-only — it never calls FBR, it only reports what a
backfill of the requested window *would* do against locally stored state:

```bash
curl -s -X POST localhost:8000/api/merchants/3/performance/backfill/preflight \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"start":"2026-08-01","end":"2026-09-06"}'
```

Expected shape: `clamped_start` reads `"2026-08-18"` (the source has no
data before that date — see Known limitations), `clamped_end` reads
`"2026-09-06"`, `partitions` lists two entries (`2026-08` and `2026-09`),
`locations` lists both bound locations with their timezone already set,
`batch_estimate` is `4` (2 partitions × 2 locations), and `blockers` is `[]`.

Confirm the same window to actually plan the job:

```bash
curl -s -X POST localhost:8000/api/merchants/3/performance/backfill \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"request_id":"v1-pilot-1","start":"2026-08-01","end":"2026-09-06","confirmed":true}'
```

Expected shape: `{"job_id": <int>, "batch_ids": [<4 ints>], "clamped_start":
"2026-08-18", "clamped_end": "2026-09-06"}` — four batch ids (one per
partition per location). Re-posting the same `request_id` later replays
the same `job_id` with an empty `batch_ids` list rather than creating
duplicates — safe to retry if the request itself fails before you see a
response.

Poll the job until it finishes:

```bash
curl -s localhost:8000/api/performance-sync/jobs/<job_id> -b cookies.txt
```

Expected shape:

```json
{
  "job_id": <int>,
  "job_type": "backfill",
  "status": "succeeded",
  "requested_start_date": "2026-08-01",
  "requested_end_date": "2026-09-06",
  "progress": {
    "partitions_total": 4,
    "partitions_published": 4,
    "partitions_failed": 0,
    "partitions_pending": 0
  },
  "raw_attempt_counts": {"batch_count": <int>, "completed_batch_count": <int>},
  "batches": [ ... ]
}
```

`progress` is derived per partition-group (the latest attempt per
`source_scope_id` + `partition_month`), not a raw batch-attempt ratio — a
job that needed a retry can show `raw_attempt_counts.batch_count` higher
than `progress.partitions_total` and that is expected, not a bug. Keep
polling (a few seconds apart) until `status` reads `"succeeded"`. If it
reads `"failed"` or a batch shows `status: "blocked"`, stop and escalate —
do not retry blindly.

Once `status` is `"succeeded"`, you may close the port-forward from Step 5.

---

## Step 7 — Prove V1 with two identical queries and one hand-check

Run the same query twice and diff the results — the contract promises
byte-identical repeats:

```bash
mkdir -p ../docs/evidence/2026-09-09-history-slice-v1
curl -s -X POST localhost:8000/api/merchants/3/performance/query -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"current":{"start":"2026-08-20","end":"2026-09-02"},"comparison":{"mode":"previous_equal_length"}}' \
  > ../docs/evidence/2026-09-09-history-slice-v1/query-2026-09.json
curl -s -X POST localhost:8000/api/merchants/3/performance/query -b cookies.txt \
  -H 'Content-Type: application/json' \
  -d '{"current":{"start":"2026-08-20","end":"2026-09-02"},"comparison":{"mode":"previous_equal_length"}}' \
  > ../docs/evidence/2026-09-09-history-slice-v1/query-repeat.json
diff ../docs/evidence/2026-09-09-history-slice-v1/query-2026-09.json \
     ../docs/evidence/2026-09-09-history-slice-v1/query-repeat.json
```

Expected: `diff` prints nothing (silent = byte-identical = deterministic).
If it prints anything, stop — that is a contract violation, not a formatting
quirk.

Then hand-check three facts against the raw observation rows, independent
of the API's own aggregation code:

```bash
sqlite3 ../data/seo-ops-v3.db \
  "SELECT business_date, SUM(numeric_value) FROM metric_observations o
   JOIN metric_observation_heads h ON h.observation_id = o.id
   WHERE o.metric_key LIKE 'BUSINESS_IMPRESSIONS%' AND o.business_date BETWEEN '2026-08-20' AND '2026-09-02'
   GROUP BY business_date ORDER BY business_date;"
```

Reconcile against `query-2026-09.json`:

1. **Per-day sums match.** For each `business_date` this prints, the sum
   should equal the corresponding point's `value` in the `gbp_impressions_total`
   entry of the response's `series` array (that series derives from summing
   the four `BUSINESS_IMPRESSIONS_*` component metrics — see
   `DERIVED_IMPRESSIONS_KEY` in `api/app/performance_metrics.py`).
2. **Missing days are absent, not zero.** Any `business_date` in the
   requested range that this query does *not* return a row for should show
   up in the response's series as `"availability": "unavailable"` with a
   `missing_reason` (`"no_observation"` or `"metric_unavailable"`) — never
   as a silent `0`.
3. **The comparison window overlaps the backfilled range — expect a
   computed (and likely skewed) percent here, not
   `delta_reason: "comparison_unavailable"`.** The `previous_equal_length`
   comparison window for this exact query is `2026-08-06`..`2026-08-19` —
   14 days — and it contains `2026-08-18` and `2026-08-19`, both inside
   the range Step 6 backfilled (the source starts exactly on
   `2026-08-18`). `_aggregate` (`api/app/performance_query.py`) reports
   `unavailable` only when `observed == 0` across the whole comparison
   period, and `compute_delta` (`api/app/performance_periods.py`) takes
   its `comparison_unavailable` branch only when the comparison total is
   `None` — with two of fourteen days observed, neither condition is met,
   so every KPI here will most likely show a real, computed percent
   instead. Because `previous_equal_length` compares equal-length windows
   it uses `basis: "total"`, so that percent is a straight ratio between a
   full 14-day current total and a comparison total built from only one or
   two observed days out of fourteen — **before trusting any percent from
   this query, read that KPI's `comparison.observed` against
   `comparison.expected` and its `completeness`, and treat a percent built
   from a handful of observed days as meaningless, not as a real
   month-over-month change.** A genuine `delta_reason:
   "comparison_unavailable"` only appears when the comparison window has
   zero observed days anywhere in it (for example, a window that falls
   entirely before `2026-08-18`) — that is not the case for this query, so
   do not expect to see it here.

---

## Rollback

**This deletes no data.** Set both flags back to `false` in `api/.env`:

```dotenv
SEO_OPS_PERFORMANCE_SYNC_ENABLED=false
SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED=false
```

(`SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS` can be left as `3` or cleared —
with `SEO_OPS_PERFORMANCE_SYNC_ENABLED` and `SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED`
both off, every route behind them returns HTTP 409 before touching the
database regardless of the allowlist.) Restart the API. Every location,
scope, binding, sync job, batch, and observation row seeded or backfilled
above stays exactly where it is — rollback is a read/write gate, not a
data-deletion procedure. Re-enabling the flags later resumes from the same
state; nothing needs to be re-seeded or re-backfilled.

---

## Known limitations

- **Source start date.** The GBP source returns nothing before
  `2026-08-18` (`SOURCE_START_DATE` in `api/app/performance_gbp.py`),
  proven by one read-only probe run on 2026-09-09. Every backfill window is
  clamped to it; a window that ends before it is rejected with a
  `window_before_source_start` blocker instead of a silent empty success.
  If FBR later exposes earlier data, that constant changes and the
  backfill re-runs for the earlier window — no existing observation is
  rewritten (observations are immutable; only the head pointer can move to
  a newer, corrected observation).
- **"Past complete month" is not yet checkable.** August 2026 is not a
  complete month from the source's point of view (only `2026-08-18` through
  `2026-08-31` exist), and as of this pilot September 2026 has not finished
  either — it will be the first calendar month the source could report in
  full, but only once it has actually elapsed. `previous_complete_calendar_month`
  as a comparison mode exists in the contract and is exercised by the
  automated test suite, but this pilot cannot yet hand-verify it end to end
  against a real, fully-elapsed month. Re-verify once September 2026 is over.
- **A day the source omits is recorded as unavailable, not zero, pending
  FBR confirmation.** When the source returns no row for a given
  business-date/metric combination, this system records that as
  `availability: "unavailable"` (a `metric_unavailable`/`no_observation`
  quality event, severity `yellow`) rather than inserting a `0`. This is
  believed correct — a `0` from the source and "the source said nothing"
  are different facts — but it has not yet been confirmed with FBR that
  omission always means "genuinely zero activity" rather than "the source
  itself failed to compute that day." Treat a run of unavailable days as
  worth asking FBR about, not as proof of zero activity.
- **`numeric_value` is a SQLite `REAL` column.** All eight GBP metrics
  seeded and backfilled here are integer counts (impressions, clicks,
  requests), so this is safe today. If a future metric on this same table
  carries a fractional value, `REAL` can lose precision silently — that
  would need a schema change (e.g. storing scaled integers or a decimal
  string) before being trusted, not just a code change in the aggregation
  layer.

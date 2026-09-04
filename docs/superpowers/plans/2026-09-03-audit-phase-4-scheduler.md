# Audit Phase 4 Policy and Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-location automatic Audit policies whose due occurrences use the same frozen-manifest Run/Attempt pipeline as manual Audit, with deterministic time-zone behavior, concurrency-safe claims, bounded scheduled retries, and in-app change alerts.

**Architecture:** A versioned policy stores cadence, IANA timezone, local anchor, and UTC next due. A dedicated scheduler wakes every 30 seconds, claims due policies in short SQLite transactions, performs only local preflight, creates one scheduled Run per occurrence, and advances the cursor through compare-and-set. The existing Audit worker handles dispatch; scheduled failures create immutable successor Attempts at 15m/1h/6h while ambiguous outcomes stay unknown. Accepted scheduled Versions generate deduplicated change alerts against their frozen comparison base.

**Tech Stack:** FastAPI, Python `zoneinfo`, `sqlite3`, asyncio, pytest, existing Audit repository/worker.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Complete Phases 1–2. Reuse `build_audit_preflight`, Audit Run/Attempt tables, dispatch fencing, validation, and acceptance; do not create a second scheduled execution contract.
- Do not reuse the generic `auto_run_interval_days`, `scheduler_loop()` tick counter, `fbr_scheduler_loop()`, merchant-wide Run lock, or current automatic Plan/Task extraction.
- The scheduler polls every 30 seconds; cadence comes only from each policy's `next_due_at`.
- All policy writers—operator API, scheduler, manual/scheduled acceptance, and identity/archive lifecycle—must compare and increment `version` in the same transaction.
- A Subject with any active Audit Run, including unknown, does not create or advance a due occurrence. Avoid writing the same blocker event every tick.
- Automatic retries are only for a scheduled Run with a proven retryable failure. They create a new immutable Attempt under the same Run and occurrence; manual Run failures never enter this schedule.
- No automatic Audit action creates a Plan or Task.

---

## Task 1: Implement deterministic policy time calculation

**Files:**

- Create: `api/app/audit_schedule.py`
- Create: `api/tests/test_audit_schedule.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class ScheduleAnchor:
    local_time: time
    timezone: ZoneInfo

def next_occurrence(*, after_utc: datetime, cadence_days: int,
                    anchor: ScheduleAnchor) -> datetime: ...

def advance_past_now(*, scheduled_for_utc: datetime, now_utc: datetime,
                     cadence_days: int, anchor: ScheduleAnchor) -> tuple[datetime, int]: ...

def occurrence_key(*, policy_id: str, subject_id: str,
                   scheduled_for_utc: datetime) -> str: ...
```

- [ ] Add table-driven tests for UTC, Asia/Shanghai, America/New_York normal dates, spring-forward nonexistent local time, fall-back ambiguous local time, month/year boundaries, leap day, and invalid timezone/cadence/anchor.
- [ ] For nonexistent local time, select the first valid instant later that local date. For an ambiguous local time, select `fold=0`, the earlier offset. Persist the resolved UTC time, not a floating local timestamp.
- [ ] `advance_past_now` returns the first occurrence strictly after now plus the exact count of skipped occurrences; do not loop without a tested upper bound. Support cadence 1–365 days.
- [ ] Derive occurrence key as a SHA-256 namespace hash over policy ID, Subject ID, and normalized scheduled UTC instant; identical inputs must be stable across restarts.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_audit_schedule.py -q
```

- [ ] Commit as `feat: calculate audit policy occurrences` when green.

## Task 2: Add optimistic-versioned policy API

**Files:**

- Modify: `api/app/audit_runs.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/tests/test_audit_runs.py`
- Create: `web/src/components/audit/AuditPolicyControl.tsx`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`

**Endpoint:**

`PUT /api/audit-subjects/{subject_id}/policy`

```json
{
  "enabled": true,
  "cadence_days": 30,
  "timezone": "America/New_York",
  "anchor_local_time": "03:30:00",
  "expected_version": 4
}
```

- [ ] Add failing tests for first creation, enable/disable, 7/30/90/custom cadence, timezone/anchor validation, archived Subject, stale expected version, and two concurrent updates.
- [ ] On a successful operator update, compute the next future occurrence from a new anchor at the request time, update all fields with `WHERE version = expected_version`, set `updated_by` to the authenticated operator, and increment version exactly once.
- [ ] On CAS failure, return 409 `AUDIT_POLICY_VERSION_CONFLICT` with the current safe policy projection. Do not retry an operator's stale intention server-side.
- [ ] Disabling blocks every queued or retry-wait scheduled Run that has no nonterminal/ambiguous remote work, including a Run whose latest Attempt is terminal failed and whose successor has not been created. Continue tracking only acknowledged/possibly dispatched work.
- [ ] Re-enabling starts from the new anchor and current time; do not enqueue disabled-period backlog.
- [ ] Replace the Phase 3 read-only policy summary with choices off/7/30/90/custom, timezone, local anchor, and `expected_version`. On 409, show the returned current policy and require the operator to reapply rather than silently overwriting it.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_runs.py -k policy -q
cd ../web
npm test -- src/pages/AuditWorkspace.test.tsx
```

- [ ] Commit as `feat: manage audit schedule policies` when green.

## Task 3: Create due scheduled Runs exactly once

**Files:**

- Create: `api/app/audit_scheduler.py`
- Modify: `api/app/main.py`
- Create: `api/tests/test_audit_scheduler.py`

**Interfaces:**

```python
def schedule_due_audits_once(*, now: datetime) -> int: ...
async def audit_scheduler_loop() -> None: ...
```

- [ ] Add tests for not-due/due policy, inactive merchant/Subject, one exact occurrence, blocked local preflight, active Run, active unknown, duplicate callbacks, two SQLite connections, process restart, multi-cycle downtime, and no repeated blocker event while an active Run holds due.
- [ ] Claim each due policy in one short `BEGIN IMMEDIATE` transaction. Re-read policy version, Subject/location state, and active lock; execute local preflight; create one scheduled Run with `request_id`, `scheduled_for`, occurrence key, frozen complete/partial manifest; update `last_scheduled_for`, future `next_due_at`, and policy version by CAS; commit together.
- [ ] A local source blocker creates a terminal blocked scheduled Run/event and still advances that claimed occurrence. Identity/archive conflicts create no Run and leave an explicit policy/Subject state.
- [ ] When downtime spans multiple intervals, create only the latest due catch-up represented by one Run and advance to the first future occurrence; record `skipped_occurrence_count` once.
- [ ] When an active Run holds the Subject, leave `next_due_at` unchanged and return without inserting a Run or per-tick event. After it becomes terminal, the next callback claims at most one catch-up.
- [ ] Register `audit_scheduler_loop()` as a separate lifespan task with a 30-second wait and cancellation handling. First tick may run immediately, but must rely on database due time rather than an in-memory counter.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_scheduler.py -q
```

- [ ] Commit as `feat: schedule due location audits` when green.

## Task 4: Add scheduled Attempt retry timing and terminal behavior

**Files:**

- Modify: `api/app/audit_worker.py`
- Modify: `api/app/audit_repository.py`
- Modify: `api/tests/test_audit_worker.py`
- Modify: `api/tests/test_audit_scheduler.py`

**Retry delays:**

```python
SCHEDULED_RETRY_DELAYS = (
    timedelta(minutes=15),
    timedelta(hours=1),
    timedelta(hours=6),
)
```

- [ ] Add tests for initial Attempt plus exactly three successors, unique retry-parent enforcement, `retry_at` gating, non-retryable failure, exhausted failure, normal next due remaining independent, manual failure remaining terminal without an Attempt successor, and disable-while-running followed by a transient terminal failure.
- [ ] Classify as retryable only an acknowledged Core AI Run whose terminal provider status is explicitly transient, or a UAT-proven dispatch rejection that guarantees no remote Run was created. Any generic HTTP/transport error after `dispatch_started_at` is ambiguous and becomes unknown. Invalid JSON/schema/provenance/score/identity, blocked preflight, and operator abandonment are not automatically retryable.
- [ ] On a retryable scheduled failure, make the current Attempt terminal failed and re-read the current policy in that same transaction. If the policy is still enabled, set the Run back to queued with its calculated `retry_at`, retain the same occurrence and frozen manifest, and append one retry-scheduled event. If it is disabled, immediately mark the Run blocked, leave `retry_at` null, append one policy-disabled event, and release the Subject active lock; never leave a disabled Run queued until a future retry poll.
- [ ] At `retry_at`, re-read the current policy and require it to remain enabled before creating Attempt N+1. A disabled policy terminally blocks the retry-wait Run without a successor whenever no nonterminal/ambiguous remote work exists. Otherwise claim creates Attempt N+1 with unique `retry_of_attempt_id` and a new deterministically derived dispatch key. Never update/revive Attempt N.
- [ ] After the third retry fails, make Run terminal failed and surface “需要处理”; do not shift the next normal policy occurrence.
- [ ] An ambiguous result always becomes unknown, ignores retry timing, retains the active Subject lock, and requires reconciliation.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_worker.py tests/test_audit_scheduler.py -q
```

- [ ] Commit as `feat: retry scheduled audit attempts safely` when green.

## Task 5: Recalculate due time on acceptance with policy CAS

**Files:**

- Modify: `api/app/audit_repository.py`
- Modify: `api/app/audit_schedule.py`
- Modify: `api/tests/test_audit_repository.py`
- Modify: `api/tests/test_audit_scheduler.py`

- [ ] Add acceptance race tests for manual success just before scheduled due, scheduler CAS concurrent with manual success, stale browser policy update, scheduled success, policy disabled during running, and identity generation reset.
- [ ] During Version acceptance, read the current policy/version and set `last_success_version_id` under CAS. For a manual success with an enabled policy, recompute `next_due_at` from accepted time and the policy anchor. For a scheduled success, preserve the future `next_due_at` already advanced when its occurrence was claimed; execution duration must not drift the cadence.
- [ ] On head/policy CAS conflict, roll back the entire acceptance transaction, re-read, and retry the short transaction a bounded three times. Never leave a Version without terminal Run/Attempt/head/policy/events.
- [ ] Manual success suppresses an immediately due scheduled Run by moving due to the next cadence anchor. Manual failure and blocked/unknown Runs do not move due.
- [ ] Identity generation change clears current-generation policy last-success under CAS and recomputes future due only after the Subject is active/ready; it never restores an old-generation head.
- [ ] Run:

```bash
.venv/bin/python -m pytest tests/test_audit_repository.py tests/test_audit_scheduler.py -q
```

- [ ] Commit as `fix: coordinate audit acceptance and policy cursor` when green.

## Task 6: Generate and expose in-app change alerts

**Files:**

- Modify: `api/app/audit_repository.py`
- Modify: `api/app/audit_versions.py`
- Modify: `api/tests/test_audit_repository.py`
- Modify: `api/tests/test_audit_versions.py`
- Modify: `web/src/pages/AuditWorkspace.tsx`
- Modify: `web/src/pages/AuditWorkspace.test.tsx`

- [ ] Add tests for scheduled Version with material changes, no changes, first report, incompatible Rubric, identity-generation change, one alert per Version, unread pagination, and idempotent operator read.
- [ ] Build alert summary from the same frozen comparison used by the Version. Store canonical JSON+hash with severity and reason. Create no alert for no material change; use information severity and explicit “无可比较基线” for first/incompatible/generation-change cases.
- [ ] Insert the Alert inside the Version acceptance transaction so it cannot reference a partially accepted Version.
- [ ] Show unread count and alert context in the Audit workspace; reading it changes only Alert status/operator/time and never the immutable Version.
- [ ] Run focused backend/frontend tests, then the complete suites:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_audit_repository.py tests/test_audit_versions.py tests/test_audit_scheduler.py -q
cd ../web
npm test -- src/pages/AuditWorkspace.test.tsx
npm test
npm run lint
npm run build
```

- [ ] Commit as `feat: surface scheduled audit change alerts` when green.

## Task 7: Add safe Audit operational telemetry

**Files:**

- Create: `api/app/audit_observability.py`
- Modify: `api/app/audit_worker.py`
- Modify: `api/app/audit_scheduler.py`
- Create: `api/tests/test_audit_observability.py`

**Interfaces:**

```python
def audit_counter(event: str, *, subject_id: str | None = None,
                  run_id: str | None = None, version_id: str | None = None,
                  reason_code: str | None = None, value: int = 1) -> None: ...
def audit_duration(event: str, *, seconds: float, run_id: str | None = None,
                   export_id: str | None = None,
                   reason_code: str | None = None) -> None: ...
```

- [ ] Add capture tests for due policies, claimed Runs, dispatch acknowledgements, state duration, validation codes, accepted Versions, retries, unknown/reconciliation, and scheduler lease conflicts.
- [ ] Emit one-line structured JSON through the application logger with stable event names and IDs. Do not use merchant name, address, keyword, report content, URL query, payload, Trace, token, or exception stack as labels/fields.
- [ ] Derive durable operational counts from append-only Run/Attempt/Export/legacy events where possible; telemetry emission failure must not roll back or alter the domain transaction.
- [ ] Add a test that injects secrets and oversized exceptions into lower-level failures and asserts captured telemetry contains only safe reason codes, IDs, duration, count, format, and size.
- [ ] Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest tests/test_audit_observability.py tests/test_audit_worker.py tests/test_audit_scheduler.py -q
```

- [ ] Commit as `feat: add safe audit operational telemetry` when green.

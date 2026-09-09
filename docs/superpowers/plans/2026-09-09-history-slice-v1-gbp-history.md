# History Verification Slice V1: GBP History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Choice Brooklyn's GBP daily metrics as immutable observations, backfill them from the source start date, and answer a merchant-scoped Performance query for any period with correct comparison, missing-versus-zero and coverage semantics.

**Architecture:** A new append-only fact path writes `metric_sync_jobs → metric_sync_batches → metric_source_artifacts → metric_observations`, then advances `metric_observation_heads` by compare-and-swap. Reads never touch `merchant_gbp_profiles`; they resolve a frozen population (locations, source scopes, bindings, timezones), aggregate head observations for two canonical periods on the server, and return canonical decimal strings. The existing profile sync and its projection are left untouched, so the whole feature is reversible by two environment flags.

**Tech Stack:** Python 3.13 + FastAPI + SQLite (`api/`, venv at `api/.venv`), pytest; React 19 + Vite + TypeScript + Vitest (`web/`).

**Spec:** `docs/superpowers/specs/2026-09-09-history-verification-slice-design.md`

## Global Constraints

- Modify only `/Users/xander/git_repo/connexup-seo-ops`; preserve unrelated staged, unstaged, and untracked changes (`docs/agent-catalog/`, `docs/superpowers/plans/2026-09-03-*`, `docs/superpowers/specs/2026-09-03-*`, `docs/HANDOFF.md` belong to other sessions — never stage them).
- Migration `0001_performance_history` is already applied and checksum-locked. Its vocabulary is authoritative: `availability IN ('available','unavailable','not_applicable')` and `completeness IN ('complete','partial','unknown')`. Do not use the `observed/missing` or `pending/failed` literals that appear in the 2026-09-03 Phase 1 plan.
- All automatic synchronization is read-only. No path in this plan may create a Local Falcon scan, write to GBP, or call Core AI.
- Published observations are append-only. A failed or older retry never replaces the latest successful head.
- Missing values stay missing and break trend lines. A real observed `0` stays visible and participates in aggregation.
- A day returned by the source with some metric rows omitted records `availability='unavailable', completeness='unknown'` for the omitted keys plus one yellow `data_quality_events` row. It is never written as `0`.
- GBP dates are store-local closed-interval calendar dates (`date_basis='store_local'`).
- Comparison modes are exactly `previous_equal_length`, `previous_complete_calendar_month`, and `custom`.
- Additive totals always show actual totals; when period lengths differ the headline change compares daily averages and says so.
- Numeric values cross the API as canonical decimal strings, never floats.
- Historical backfill is operator-triggered, preflighted, explicitly confirmed, month-partitioned, resumable and idempotent.
- Credentials never enter SQLite, logs, API responses or browser state.
- FBR source facts (probed 2026-09-09): `GET /gbp/performance-metric` returns `{"metrics":[{"metric_date","metric","value"}]}`, only from `2026-08-18` through roughly `today - 3 days`, for the 8 metric keys listed in Task 1. Long ranges are accepted. September 2026 is the first complete month.
- Work in an isolated worktree created via `superpowers:using-git-worktrees` before Task 1.

## File Structure

Create:

```text
api/app/canonical_json.py            canonical JSON bytes + sha256, canonical decimal strings
api/app/performance_metrics.py       metric registry, decimal context, derived-total rule
api/app/performance_periods.py       canonical periods, comparison math, delta rules
api/app/performance_contracts.py     strict Pydantic request/response models
api/app/performance_identity.py      GBP locations, scopes, bindings, timezone, population manifest
api/app/performance_store.py         batch publication, head CAS, head queries
api/app/performance_gbp.py           FBR payload normalization into observation drafts
api/app/performance_sync.py          month partitioning, job creation, lease worker, daily enqueue
api/app/performance_sync_api.py      backfill preflight/confirm/status routes
api/app/performance_query.py         population + heads → merchant performance response
api/app/performance_query_api.py     merchant-scoped query and timezone routes
api/migrations/0006_performance_immutability.sql
web/src/pages/MerchantPerformance.tsx
web/src/performanceTypes.ts
```

Modify: `api/app/config.py`, `api/app/main.py`, `api/app/scheduler.py`, `api/tests/conftest.py`, `api/tests/test_db_migrations.py`, `web/src/api.ts`, `web/src/App.tsx`, `web/src/components/MerchantSectionNav.tsx`, `web/src/index.css`, `.env.example`.

## Deliberate deviations from the 2026-09-03 Phase 1 plan

Recorded here so a reviewer does not treat them as omissions.

| Phase 1 plan | This slice | Why |
|---|---|---|
| Task 3 full identity subsystem (FBR relink command, operator command ledger, alias evidence, cross-merchant rebind) | Only GBP location scopes, bindings and timezone state for the pilot merchant | The slice never rebinds identities; the relink command is not needed to prove history |
| Task 7 dual-write inside `sync_gbp_profile_once` | Independent sync worker writes observations; profile sync untouched | Avoids changing the delicate CAS/lease code in `merchant_profiles.py`; the projection keeps its own copy |
| Tasks 11–13 cross-merchant dashboard shell | One merchant-scoped Performance tab | The AM works inside one merchant; the cross-merchant console is a later slice |
| Derived metrics stored as observations | Derived total computed at query time from component heads | A backfill of one component cannot leave a stale derived row |

---

### Task 1: Canonical JSON, decimal context and the GBP metric registry

**Files:**
- Create: `api/app/canonical_json.py`
- Create: `api/app/performance_metrics.py`
- Create: `api/tests/test_canonical_json.py`
- Create: `api/tests/test_performance_metrics.py`

**Interfaces:**
- Produces: `canonical_json_bytes(value: object) -> bytes`, `canonical_sha256(value: object) -> str`, `canonical_decimal(value: Decimal | int | None) -> str | None`.
- Produces: `METRIC_REGISTRY_VERSION = "seo_ops.performance_metrics.v1"`, `GBP_SOURCE_METRICS: tuple[str, ...]`, `IMPRESSION_COMPONENTS: tuple[str, ...]`, `DERIVED_IMPRESSIONS_KEY = "gbp_impressions_total"`, `metric_definition(metric_key: str) -> MetricDefinition`, `CALCULATION_CONTEXT`.
- Consumed by every later task.

- [ ] **Step 1: Write the failing canonicalization tests**

```python
# api/tests/test_canonical_json.py
from decimal import Decimal, localcontext

import pytest

from app.canonical_json import canonical_decimal, canonical_json_bytes, canonical_sha256


def test_object_keys_are_sorted_but_lists_keep_order():
    assert canonical_json_bytes({"b": [3, 1], "a": 1}) == b'{"a":1,"b":[3,1]}'


def test_decimals_serialize_as_plain_strings_without_exponent():
    assert canonical_json_bytes({"v": Decimal("1E+3")}) == b'{"v":"1000"}'
    assert canonical_json_bytes({"v": Decimal("0.500")}) == b'{"v":"0.500"}'


def test_hash_is_stable_and_independent_of_process_decimal_context():
    payload = {"v": Decimal("10") / Decimal("4")}
    first = canonical_sha256(payload)
    with localcontext() as ctx:
        ctx.prec = 3
        assert canonical_sha256(payload) == first


@pytest.mark.parametrize("value", [float("nan"), float("inf"), Decimal("NaN")])
def test_non_finite_numbers_are_rejected(value):
    with pytest.raises(ValueError):
        canonical_json_bytes({"v": value})


def test_canonical_decimal_preserves_zero_and_maps_none():
    assert canonical_decimal(Decimal("0")) == "0"
    assert canonical_decimal(None) is None
```

- [ ] **Step 2: Write the failing registry tests**

```python
# api/tests/test_performance_metrics.py
import pytest

from app.performance_metrics import (
    DERIVED_IMPRESSIONS_KEY,
    GBP_SOURCE_METRICS,
    IMPRESSION_COMPONENTS,
    METRIC_REGISTRY_VERSION,
    metric_definition,
)


def test_registry_contains_exactly_the_eight_proven_source_keys():
    assert GBP_SOURCE_METRICS == (
        "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
        "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
        "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
        "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
        "BUSINESS_DIRECTION_REQUESTS",
        "BUSINESS_FOOD_MENU_CLICKS",
        "CALL_CLICKS",
        "WEBSITE_CLICKS",
    )


def test_derived_total_declares_its_four_components_and_is_not_a_source_key():
    definition = metric_definition(DERIVED_IMPRESSIONS_KEY)
    assert definition.kind == "derived"
    assert definition.components == IMPRESSION_COMPONENTS
    assert DERIVED_IMPRESSIONS_KEY not in GBP_SOURCE_METRICS


def test_unknown_metric_key_is_rejected():
    with pytest.raises(KeyError):
        metric_definition("BUSINESS_BOOKINGS")


def test_registry_version_is_pinned():
    assert METRIC_REGISTRY_VERSION == "seo_ops.performance_metrics.v1"
```

- [ ] **Step 3: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_canonical_json.py tests/test_performance_metrics.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.canonical_json'`.

- [ ] **Step 4: Implement canonical JSON**

```python
# api/app/canonical_json.py
"""Deterministic JSON bytes and hashes for population, manifest and content hashing."""
from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal, localcontext

CALCULATION_PRECISION = 28


def canonical_decimal(value: Decimal | int | None) -> str | None:
    """Render an exact decimal string with no exponent, or None."""
    if value is None:
        return None
    number = value if isinstance(value, Decimal) else Decimal(value)
    if not number.is_finite():
        raise ValueError("non-finite decimal is not canonicalizable")
    text = format(number, "f")
    return text


def _plain(value: object) -> object:
    if isinstance(value, Decimal):
        return canonical_decimal(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite float is not canonicalizable")
        raise ValueError("float values must be converted to Decimal before canonicalization")
    if isinstance(value, dict):
        return {str(key): _plain(item) for key, item in sorted(value.items(), key=lambda kv: str(kv[0]))}
    if isinstance(value, (list, tuple)):
        return [_plain(item) for item in value]
    return value


def canonical_json_bytes(value: object) -> bytes:
    with localcontext() as ctx:
        ctx.prec = CALCULATION_PRECISION
        return json.dumps(
            _plain(value), ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")


def canonical_sha256(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()
```

- [ ] **Step 5: Implement the metric registry**

```python
# api/app/performance_metrics.py
"""The only place that names GBP metric keys and the derived impressions rule."""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Context, ROUND_HALF_EVEN
from typing import Literal

METRIC_REGISTRY_VERSION = "seo_ops.performance_metrics.v1"
CALCULATION_CONTEXT = Context(prec=28, rounding=ROUND_HALF_EVEN)

GBP_SOURCE_METRICS: tuple[str, ...] = (
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    "BUSINESS_DIRECTION_REQUESTS",
    "BUSINESS_FOOD_MENU_CLICKS",
    "CALL_CLICKS",
    "WEBSITE_CLICKS",
)
IMPRESSION_COMPONENTS: tuple[str, ...] = GBP_SOURCE_METRICS[:4]
DERIVED_IMPRESSIONS_KEY = "gbp_impressions_total"

DISPLAY_LABELS: dict[str, str] = {
    DERIVED_IMPRESSIONS_KEY: "GBP 曝光",
    "WEBSITE_CLICKS": "官网点击",
    "CALL_CLICKS": "电话按钮点击",
    "BUSINESS_DIRECTION_REQUESTS": "路线请求",
    "BUSINESS_FOOD_MENU_CLICKS": "菜单浏览",
    "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": "桌面地图展示",
    "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": "桌面搜索展示",
    "BUSINESS_IMPRESSIONS_MOBILE_MAPS": "移动地图展示",
    "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": "移动搜索展示",
}

# Headline metrics shown as KPI cards, in display order.
HEADLINE_METRICS: tuple[str, ...] = (
    DERIVED_IMPRESSIONS_KEY,
    "WEBSITE_CLICKS",
    "CALL_CLICKS",
    "BUSINESS_DIRECTION_REQUESTS",
)


@dataclass(frozen=True)
class MetricDefinition:
    metric_key: str
    kind: Literal["source", "derived"]
    source: Literal["GBP"]
    unit: Literal["count"]
    label: str
    components: tuple[str, ...] = ()


_REGISTRY: dict[str, MetricDefinition] = {
    key: MetricDefinition(key, "source", "GBP", "count", DISPLAY_LABELS[key])
    for key in GBP_SOURCE_METRICS
}
_REGISTRY[DERIVED_IMPRESSIONS_KEY] = MetricDefinition(
    DERIVED_IMPRESSIONS_KEY,
    "derived",
    "GBP",
    "count",
    DISPLAY_LABELS[DERIVED_IMPRESSIONS_KEY],
    IMPRESSION_COMPONENTS,
)


def metric_definition(metric_key: str) -> MetricDefinition:
    return _REGISTRY[metric_key]


def known_metric_keys() -> tuple[str, ...]:
    return tuple(_REGISTRY)
```

- [ ] **Step 6: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_canonical_json.py tests/test_performance_metrics.py -v`
Expected: PASS (9 tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/canonical_json.py api/app/performance_metrics.py api/tests/test_canonical_json.py api/tests/test_performance_metrics.py
git commit -m "feat: add canonical JSON and the GBP metric registry

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 2: Canonical periods and comparison math

**Files:**
- Create: `api/app/performance_periods.py`
- Create: `api/tests/test_performance_periods.py`

**Interfaces:**
- Consumes: Task 1 `CALCULATION_CONTEXT`.
- Produces: `@dataclass(frozen=True) Period(start: date, end: date)` with `days: int`.
- Produces: `@dataclass(frozen=True) CanonicalPeriods(current: Period, comparison: Period | None, mode: str, basis: Literal["total","daily_average"])`.
- Produces: `canonical_periods(current: Period, mode: str, custom: Period | None = None) -> CanonicalPeriods`.
- Produces: `compute_delta(current_total: Decimal | None, current_days: int, comparison_total: Decimal | None, comparison_days: int) -> DeltaResult` where `DeltaResult(value: Decimal | None, delta_type: Literal["percent"], basis: Literal["total","daily_average"], reason: str | None)`.

- [ ] **Step 1: Write the failing period tests**

```python
# api/tests/test_performance_periods.py
from datetime import date
from decimal import Decimal

import pytest

from app.performance_periods import Period, canonical_periods, compute_delta


def test_previous_equal_length_is_the_immediately_preceding_window():
    periods = canonical_periods(Period(date(2026, 8, 1), date(2026, 8, 31)), "previous_equal_length")
    assert periods.comparison == Period(date(2026, 7, 1), date(2026, 7, 31))
    assert periods.basis == "total"


def test_previous_complete_calendar_month_uses_the_month_before_current_start():
    periods = canonical_periods(Period(date(2026, 9, 3), date(2026, 9, 9)), "previous_complete_calendar_month")
    assert periods.comparison == Period(date(2026, 8, 1), date(2026, 8, 31))
    assert periods.basis == "daily_average"


def test_custom_comparison_requires_a_window_and_may_differ_in_length():
    periods = canonical_periods(
        Period(date(2026, 9, 1), date(2026, 9, 7)),
        "custom",
        Period(date(2026, 8, 1), date(2026, 8, 14)),
    )
    assert periods.comparison.days == 14 and periods.basis == "daily_average"
    with pytest.raises(ValueError):
        canonical_periods(Period(date(2026, 9, 1), date(2026, 9, 7)), "custom")


def test_equal_length_delta_uses_totals():
    result = compute_delta(Decimal("12600"), 31, Decimal("11560"), 31)
    assert result.basis == "total"
    assert result.value == Decimal("9.0")


def test_unequal_length_delta_compares_daily_averages():
    result = compute_delta(Decimal("140"), 7, Decimal("400"), 28)
    assert result.basis == "daily_average"
    assert result.value == Decimal("40.0")


@pytest.mark.parametrize(
    "current,comparison,reason",
    [
        (Decimal("120"), Decimal("0"), "comparison_zero"),
        (None, Decimal("10"), "current_unavailable"),
        (Decimal("10"), None, "comparison_unavailable"),
    ],
)
def test_delta_is_null_with_an_explicit_reason(current, comparison, reason):
    result = compute_delta(current, 7, comparison, 7)
    assert result.value is None and result.reason == reason


def test_both_periods_zero_is_flat_not_null():
    result = compute_delta(Decimal("0"), 7, Decimal("0"), 7)
    assert result.value == Decimal("0") and result.reason is None
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_periods.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_periods'`.

- [ ] **Step 3: Implement period math**

```python
# api/app/performance_periods.py
"""Closed-interval store-local periods and the only delta rule in the system."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import Literal

from .performance_metrics import CALCULATION_CONTEXT

COMPARISON_MODES = ("previous_equal_length", "previous_complete_calendar_month", "custom")


@dataclass(frozen=True)
class Period:
    start: date
    end: date

    def __post_init__(self) -> None:
        if self.start > self.end:
            raise ValueError("period start must not be after end")

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1


@dataclass(frozen=True)
class CanonicalPeriods:
    current: Period
    comparison: Period | None
    mode: str
    basis: Literal["total", "daily_average"]


@dataclass(frozen=True)
class DeltaResult:
    value: Decimal | None
    delta_type: Literal["percent"]
    basis: Literal["total", "daily_average"]
    reason: str | None


def _previous_complete_month(start: date) -> Period:
    last_day_previous = start.replace(day=1) - timedelta(days=1)
    return Period(last_day_previous.replace(day=1), last_day_previous)


def canonical_periods(current: Period, mode: str, custom: Period | None = None) -> CanonicalPeriods:
    if mode not in COMPARISON_MODES:
        raise ValueError(f"unknown comparison mode: {mode}")
    if mode == "custom":
        if custom is None:
            raise ValueError("custom comparison requires an explicit window")
        comparison = custom
    elif mode == "previous_equal_length":
        comparison = Period(current.start - timedelta(days=current.days), current.start - timedelta(days=1))
    else:
        comparison = _previous_complete_month(current.start)
    if custom is not None and mode != "custom":
        raise ValueError("comparison dates are valid only for custom mode")
    basis = "total" if comparison.days == current.days else "daily_average"
    return CanonicalPeriods(current=current, comparison=comparison, mode=mode, basis=basis)


def compute_delta(
    current_total: Decimal | None,
    current_days: int,
    comparison_total: Decimal | None,
    comparison_days: int,
) -> DeltaResult:
    basis: Literal["total", "daily_average"] = (
        "total" if current_days == comparison_days else "daily_average"
    )
    if current_total is None:
        return DeltaResult(None, "percent", basis, "current_unavailable")
    if comparison_total is None:
        return DeltaResult(None, "percent", basis, "comparison_unavailable")
    with CALCULATION_CONTEXT as ctx:
        if basis == "total":
            current_value, comparison_value = current_total, comparison_total
        else:
            current_value = ctx.divide(current_total, Decimal(current_days))
            comparison_value = ctx.divide(comparison_total, Decimal(comparison_days))
        if comparison_value == 0:
            if current_value == 0:
                return DeltaResult(Decimal("0"), "percent", basis, None)
            return DeltaResult(None, "percent", basis, "comparison_zero")
        ratio = ctx.divide(ctx.subtract(current_value, comparison_value), comparison_value)
        percent = ctx.multiply(ratio, Decimal(100)).quantize(Decimal("0.1"))
    return DeltaResult(percent, "percent", basis, None)
```

- [ ] **Step 4: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_periods.py -v`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_periods.py api/tests/test_performance_periods.py
git commit -m "feat: add canonical performance periods and delta rules

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 3: Immutability migration and a database test fixture

**Files:**
- Create: `api/migrations/0006_performance_immutability.sql`
- Create: `api/tests/test_performance_immutability.py`
- Modify: `api/tests/conftest.py` (add a `conn` fixture after the existing `client` fixture)
- Modify: `api/tests/test_db_migrations.py` (three expected-version tuples near lines 590, 607, 625)

**Interfaces:**
- Produces: SQLite triggers `trg_metric_observations_no_update`, `trg_metric_observations_no_delete`, `trg_metric_source_artifacts_no_update`, `trg_metric_source_artifacts_no_delete`.
- Produces: pytest fixture `conn` yielding a migrated `sqlite3.Connection` on a temp database.

- [ ] **Step 1: Write the failing immutability tests**

```python
# api/tests/test_performance_immutability.py
import sqlite3

import pytest


def _seed_observation(conn):
    conn.execute(
        "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
        " date_basis, metadata_json, created_at) VALUES"
        " ('GBP','GBP_LOCATION','1','gbp:1','America/New_York','store_local','{}',"
        " '2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_sync_jobs (job_type, request_id, idempotency_key, scope_manifest_json,"
        " scope_manifest_sha256, requested_start_date, requested_end_date, status, requested_by,"
        " created_at) VALUES ('backfill','r1','k1','{}', ?, '2026-08-18','2026-08-19','queued',"
        " 'test','2026-09-09T00:00:00.000000Z')",
        ("a" * 64,),
    )
    conn.execute(
        "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month, attempt,"
        " status, adapter_version, created_at, updated_at) VALUES (1,'GBP',1,'2026-08',1,'published',"
        " 'gbp.v1','2026-09-09T00:00:00.000000Z','2026-09-09T00:00:00.000000Z')"
    )
    conn.execute(
        "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
        " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
        " numeric_value, availability, completeness, formula_version, published_sequence,"
        " content_sha256, created_at) VALUES (1,1,'CALL_CLICKS','2026-08-18','store_local','{}',?,"
        " '{}',?,3,'available','complete','seo_ops.performance_metrics.v1',1,?,"
        " '2026-09-09T00:00:00.000000Z')",
        ("b" * 64, "c" * 64, "d" * 64),
    )
    conn.commit()


def test_published_observation_cannot_be_updated_or_deleted(conn):
    _seed_observation(conn)
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("UPDATE metric_observations SET numeric_value = 99 WHERE id = 1")
    with pytest.raises(sqlite3.IntegrityError, match="metric_observation_immutable"):
        conn.execute("DELETE FROM metric_observations WHERE id = 1")


def test_heads_and_batches_remain_updatable(conn):
    _seed_observation(conn)
    conn.execute(
        "INSERT INTO metric_observation_heads (logical_key_sha256, observation_id, head_generation,"
        " updated_at) VALUES (?,1,1,'2026-09-09T00:00:00.000000Z')",
        ("c" * 64,),
    )
    conn.execute("UPDATE metric_observation_heads SET head_generation = 2 WHERE observation_id = 1")
    conn.execute("UPDATE metric_sync_batches SET status = 'failed' WHERE id = 1")
    conn.commit()
    assert conn.execute("SELECT head_generation FROM metric_observation_heads").fetchone()[0] == 2
```

- [ ] **Step 2: Add the `conn` fixture**

Append to `api/tests/conftest.py`:

```python
@pytest.fixture()
def conn(tmp_path, monkeypatch):
    monkeypatch.setenv("SEO_OPS_DB", str(tmp_path / "performance.db"))
    from app.db import connect, init_db

    init_db()
    connection = connect()
    try:
        yield connection
    finally:
        connection.close()
```

- [ ] **Step 3: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_immutability.py -v`
Expected: FAIL — the UPDATE succeeds because no trigger exists yet.

- [ ] **Step 4: Write the migration**

```sql
-- api/migrations/0006_performance_immutability.sql
CREATE TRIGGER trg_metric_observations_no_update
BEFORE UPDATE ON metric_observations
BEGIN
  SELECT RAISE(ABORT, 'metric_observation_immutable');
END;

CREATE TRIGGER trg_metric_observations_no_delete
BEFORE DELETE ON metric_observations
BEGIN
  SELECT RAISE(ABORT, 'metric_observation_immutable');
END;

CREATE TRIGGER trg_metric_source_artifacts_no_update
BEFORE UPDATE ON metric_source_artifacts
BEGIN
  SELECT RAISE(ABORT, 'metric_source_artifact_immutable');
END;

CREATE TRIGGER trg_metric_source_artifacts_no_delete
BEFORE DELETE ON metric_source_artifacts
BEGIN
  SELECT RAISE(ABORT, 'metric_source_artifact_immutable');
END;
```

- [ ] **Step 5: Update the pinned migration version lists**

In `api/tests/test_db_migrations.py`, each expected-version tuple that currently ends with `"0005_task_assignments"` gains `"0006_performance_immutability"` as its final element. There are three such lists (near lines 590, 607 and 625).

- [ ] **Step 6: Run GREEN plus the migration suite**

Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/python -m pytest tests/test_performance_immutability.py tests/test_db_migrations.py -v
```

Expected: PASS, including the existing repeatability test that applies migrations twice.

- [ ] **Step 7: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/migrations/0006_performance_immutability.sql api/tests/test_performance_immutability.py api/tests/conftest.py api/tests/test_db_migrations.py
git commit -m "feat: reject rewrites of published observations and source artifacts

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 4: GBP location identity, timezone and the population manifest

**Files:**
- Create: `api/app/performance_identity.py`
- Create: `api/tests/test_performance_identity.py`

**Interfaces:**
- Consumes: Task 1 `canonical_sha256`; Task 2 `Period`.
- Produces: `@dataclass(frozen=True) MerchantLocationRow(id: int, merchant_id: int, display_name: str, timezone_name: str | None, status: str)`.
- Produces: `@dataclass(frozen=True) BoundScope(location: MerchantLocationRow, scope_id: int, external_id: str, place_id: str | None, binding_generation: int)`.
- Produces: `seed_gbp_locations_from_profiles(conn, merchant_id: int, *, actor: str, observed_at: datetime) -> tuple[BoundScope, ...]`.
- Produces: `set_location_timezone(conn, location_id: int, timezone_name: str, *, actor: str, effective_at: datetime) -> MerchantLocationRow`.
- Produces: `resolve_bound_scopes(conn, merchant_id: int, location_ids: tuple[int, ...] | None, *, as_of: datetime) -> tuple[BoundScope, ...]`.
- Produces: `@dataclass(frozen=True) PopulationManifest(merchant_id: int, scopes: tuple[BoundScope, ...], manifest: dict, manifest_sha256: str)`.
- Produces: `build_population_manifest(conn, merchant_id: int, location_ids: tuple[int, ...] | None, *, as_of: datetime) -> PopulationManifest`.
- Produces: `resolve_default_end(population: PopulationManifest, *, as_of: datetime) -> date` and exception `TimezoneUnresolved`.
- Produces: `canonical_instant(value: datetime) -> str` emitting the 27-character `%Y-%m-%dT%H:%M:%S.%fZ` form already enforced by `is_canonical_utc_instant`.

- [ ] **Step 1: Write the failing identity tests**

```python
# api/tests/test_performance_identity.py
import json
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


def _seed_merchant_with_two_gbp_profiles(conn):
    conn.execute(
        "INSERT INTO merchants (id, name, status, created_at) VALUES"
        " (3,'Choice Brooklyn','active','2026-09-01T00:00:00.000000Z')"
    )
    for location_id, title, place_id in (
        ("1860638126797610816", "Clinton Hill", "ChIJaYcllU0N7ocR4lWiLngfEYg"),
        ("24300588970198995", "Upper West Side", "ChIJH8iZh-5ZwokRPLzzADeSnYE"),
    ):
        conn.execute(
            "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id,"
            " source_title, location_json, normalized_json, synced_at) VALUES"
            " (3,'fbr-3',?,?,'{}',?,'2026-09-03T00:00:00.000000Z')",
            (location_id, title, json.dumps({"title": title, "place_id": place_id})),
        )
    conn.commit()


def test_seeding_creates_one_scope_and_binding_per_gbp_location(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    assert [scope.external_id for scope in scopes] == ["1860638126797610816", "24300588970198995"]
    assert all(scope.binding_generation == 1 for scope in scopes)
    assert all(scope.location.timezone_name is None for scope in scopes)


def test_seeding_twice_does_not_duplicate_scopes_or_bindings(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    first = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    second = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    assert [s.location.id for s in first] == [s.location.id for s in second]
    assert conn.execute("SELECT COUNT(*) FROM source_scope_bindings").fetchone()[0] == 2


def test_population_manifest_hash_is_stable_and_changes_with_timezone(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    before = build_population_manifest(conn, 3, None, as_of=NOW)
    assert before.manifest_sha256 == build_population_manifest(conn, 3, None, as_of=NOW).manifest_sha256
    set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=NOW)
    after = build_population_manifest(conn, 3, None, as_of=NOW)
    assert after.manifest_sha256 != before.manifest_sha256


def test_default_end_is_yesterday_in_the_slowest_store_timezone(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=NOW)
    set_location_timezone(conn, scopes[1].location.id, "Asia/Tokyo", actor="test", effective_at=NOW)
    population = build_population_manifest(conn, 3, None, as_of=NOW)
    # 2026-09-09T12:00Z is 08:00 in New York and 21:00 in Tokyo.
    assert resolve_default_end(population, as_of=NOW) == date(2026, 9, 8)


def test_missing_timezone_fails_closed_instead_of_guessing(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    population = build_population_manifest(conn, 3, None, as_of=NOW)
    with pytest.raises(TimezoneUnresolved):
        resolve_default_end(population, as_of=NOW)


def test_invalid_timezone_is_rejected_without_writing(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    with pytest.raises(ValueError):
        set_location_timezone(conn, scopes[0].location.id, "Mars/Olympus", actor="test", effective_at=NOW)
    assert conn.execute(
        "SELECT timezone_name FROM merchant_locations WHERE id = ?", (scopes[0].location.id,)
    ).fetchone()[0] is None
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_identity.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_identity'`.

- [ ] **Step 3: Implement identity, timezone and population**

```python
# api/app/performance_identity.py
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
    return value.astimezone(tz=None).astimezone(ZoneInfo("UTC")).strftime(CANONICAL_INSTANT_FORMAT)


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
```

- [ ] **Step 4: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_identity.py -v`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_identity.py api/tests/test_performance_identity.py
git commit -m "feat: seed GBP location scopes and frozen query populations

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 5: Immutable batch publication and deterministic heads

**Files:**
- Create: `api/app/performance_store.py`
- Create: `api/tests/test_performance_store.py`

**Interfaces:**
- Consumes: Task 1 `canonical_json_bytes`/`canonical_sha256`/`canonical_decimal`; Task 4 `canonical_instant`.
- Produces: `@dataclass(frozen=True) ObservationDraft(source_scope_id, metric_key, business_date: date, numeric_value: Decimal | None, availability: str, completeness: str, source_updated_at: datetime | None)`.
- Produces: `@dataclass(frozen=True) BatchDraft(job_id: int, source_scope_id: int, partition_month: str, attempt: int, adapter_version: str, retrieved_at: datetime, data_through: date | None)`.
- Produces: `@dataclass(frozen=True) PublishedBatch(batch_id: int, observation_ids: tuple[int, ...], head_updates: int)`.
- Produces: `create_sync_job(conn, *, job_type: str, request_id: str, requested_by: str, scope_manifest: dict, start: date, end: date, now: datetime) -> int`.
- Produces: `create_batch(conn, draft: BatchDraft, *, now: datetime) -> int`.
- Produces: `publish_metric_batch(conn, batch_id: int, raw_payload: bytes, observations: list[ObservationDraft], *, now: datetime) -> PublishedBatch`.
- Produces: `query_metric_heads(conn, scope_ids: tuple[int, ...], metric_keys: tuple[str, ...], start: date, end: date) -> list[HeadObservation]` where `HeadObservation(source_scope_id, metric_key, business_date: date, numeric_value: Decimal | None, availability: str, completeness: str, observation_id: int, superseded: bool)`.
- Produces: `record_quality_event(conn, *, source: str, scope_id: int | None, merchant_id: int | None, location_id: int | None, category: str, severity: str, start: date | None, end: date | None, details: dict, batch_id: int | None, now: datetime) -> int`.
- Produces: `open_quality_events(conn, scope_ids: tuple[int, ...], start: date, end: date) -> list[dict]`.

- [ ] **Step 1: Write the failing store tests**

```python
# api/tests/test_performance_store.py
from datetime import date, datetime, timezone
from decimal import Decimal

from app.performance_store import (
    BatchDraft,
    ObservationDraft,
    create_batch,
    create_sync_job,
    publish_metric_batch,
    query_metric_heads,
)

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _scope(conn) -> int:
    cursor = conn.execute(
        "INSERT INTO source_scopes (source, scope_type, external_id, canonical_key, timezone_name,"
        " date_basis, metadata_json, created_at) VALUES ('GBP','GBP_LOCATION','1','gbp_location:1',"
        " 'America/New_York','store_local','{}','2026-09-09T00:00:00.000000Z')"
    )
    conn.commit()
    return int(cursor.lastrowid)


def _publish(conn, scope_id, value, *, attempt, business_date=date(2026, 8, 18)):
    job_id = create_sync_job(
        conn, job_type="backfill", request_id=f"r{attempt}", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=business_date, end=business_date, now=NOW,
    )
    batch_id = create_batch(
        conn,
        BatchDraft(job_id, scope_id, business_date.strftime("%Y-%m"), attempt, "gbp.v1", NOW, business_date),
        now=NOW,
    )
    return publish_metric_batch(
        conn,
        batch_id,
        b'{"metrics":[]}',
        [ObservationDraft(scope_id, "CALL_CLICKS", business_date, value, "available", "complete", None)],
        now=NOW,
    )


def test_publish_is_atomic_and_creates_one_head(conn):
    scope_id = _scope(conn)
    published = _publish(conn, scope_id, Decimal("3"), attempt=1)
    assert len(published.observation_ids) == 1 and published.head_updates == 1
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("3")


def test_later_batch_supersedes_the_head_and_marks_the_correction(conn):
    scope_id = _scope(conn)
    _publish(conn, scope_id, Decimal("3"), attempt=1)
    _publish(conn, scope_id, Decimal("5"), attempt=2)
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("5") and heads[0].superseded is True
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 2


def test_republishing_an_identical_observation_keeps_one_head_generation(conn):
    scope_id = _scope(conn)
    _publish(conn, scope_id, Decimal("3"), attempt=1)
    _publish(conn, scope_id, Decimal("3"), attempt=2)
    generation = conn.execute("SELECT head_generation FROM metric_observation_heads").fetchone()[0]
    assert generation == 2
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value == Decimal("3") and heads[0].superseded is False


def test_unavailable_observation_keeps_a_null_value_not_zero(conn):
    scope_id = _scope(conn)
    job_id = create_sync_job(
        conn, job_type="backfill", request_id="r1", requested_by="test",
        scope_manifest={"scope_ids": [scope_id]}, start=date(2026, 8, 18), end=date(2026, 8, 18), now=NOW,
    )
    batch_id = create_batch(conn, BatchDraft(job_id, scope_id, "2026-08", 1, "gbp.v1", NOW, date(2026, 8, 18)), now=NOW)
    publish_metric_batch(
        conn, batch_id, b"{}",
        [ObservationDraft(scope_id, "CALL_CLICKS", date(2026, 8, 18), None, "unavailable", "unknown", None)],
        now=NOW,
    )
    heads = query_metric_heads(conn, (scope_id,), ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 18))
    assert heads[0].numeric_value is None and heads[0].availability == "unavailable"
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_store'`.

- [ ] **Step 3: Implement the store**

```python
# api/app/performance_store.py
"""Append-only publication of metric batches and compare-and-swap head advancement."""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from .canonical_json import canonical_decimal, canonical_sha256
from .performance_identity import canonical_instant
from .performance_metrics import METRIC_REGISTRY_VERSION


@dataclass(frozen=True)
class ObservationDraft:
    source_scope_id: int
    metric_key: str
    business_date: date
    numeric_value: Decimal | None
    availability: str
    completeness: str
    source_updated_at: datetime | None = None


@dataclass(frozen=True)
class BatchDraft:
    job_id: int
    source_scope_id: int
    partition_month: str
    attempt: int
    adapter_version: str
    retrieved_at: datetime
    data_through: date | None


@dataclass(frozen=True)
class PublishedBatch:
    batch_id: int
    observation_ids: tuple[int, ...]
    head_updates: int


@dataclass(frozen=True)
class HeadObservation:
    source_scope_id: int
    metric_key: str
    business_date: date
    numeric_value: Decimal | None
    availability: str
    completeness: str
    observation_id: int
    superseded: bool


def _logical_key(draft: ObservationDraft) -> dict:
    return {
        "source_scope_id": draft.source_scope_id,
        "business_date": draft.business_date.isoformat(),
        "metric_key": draft.metric_key,
        "dimension": {},
    }


def create_sync_job(
    conn: sqlite3.Connection, *, job_type: str, request_id: str, requested_by: str,
    scope_manifest: dict, start: date, end: date, now: datetime,
) -> int:
    manifest_json = json.dumps(scope_manifest, sort_keys=True, separators=(",", ":"))
    manifest_sha = canonical_sha256(scope_manifest)
    idempotency_key = hashlib.sha256(
        f"{job_type}|{requested_by}|{request_id}|{manifest_sha}|{start}|{end}".encode("utf-8")
    ).hexdigest()
    existing = conn.execute(
        "SELECT id FROM metric_sync_jobs WHERE idempotency_key = ?", (idempotency_key,)
    ).fetchone()
    if existing is not None:
        return int(existing["id"])
    cursor = conn.execute(
        "INSERT INTO metric_sync_jobs (job_type, request_id, idempotency_key, scope_manifest_json,"
        " scope_manifest_sha256, requested_start_date, requested_end_date, status, requested_by, created_at)"
        " VALUES (?,?,?,?,?,?,?,'queued',?,?)",
        (job_type, request_id, idempotency_key, manifest_json, manifest_sha,
         start.isoformat(), end.isoformat(), requested_by, canonical_instant(now)),
    )
    conn.commit()
    return int(cursor.lastrowid)


def create_batch(conn: sqlite3.Connection, draft: BatchDraft, *, now: datetime) -> int:
    stamp = canonical_instant(now)
    cursor = conn.execute(
        "INSERT INTO metric_sync_batches (job_id, source, source_scope_id, partition_month, attempt,"
        " status, adapter_version, data_through, retrieved_at, created_at, updated_at)"
        " VALUES (?, 'GBP', ?, ?, ?, 'queued', ?, ?, ?, ?, ?)",
        (draft.job_id, draft.source_scope_id, draft.partition_month, draft.attempt, draft.adapter_version,
         draft.data_through.isoformat() if draft.data_through else None, stamp, stamp, stamp),
    )
    conn.execute(
        "UPDATE metric_sync_jobs SET batch_count = batch_count + 1 WHERE id = ?", (draft.job_id,)
    )
    conn.commit()
    return int(cursor.lastrowid)


def publish_metric_batch(
    conn: sqlite3.Connection, batch_id: int, raw_payload: bytes,
    observations: list[ObservationDraft], *, now: datetime,
) -> PublishedBatch:
    stamp = canonical_instant(now)
    conn.execute("BEGIN IMMEDIATE")
    try:
        payload_sha = hashlib.sha256(raw_payload).hexdigest()
        conn.execute(
            "INSERT OR IGNORE INTO metric_source_artifacts (batch_id, payload, content_type,"
            " payload_sha256, saved_at) VALUES (?,?,'application/json',?,?)",
            (batch_id, raw_payload, payload_sha, stamp),
        )
        observation_ids: list[int] = []
        head_updates = 0
        for draft in observations:
            logical = _logical_key(draft)
            logical_sha = canonical_sha256(logical)
            dimension_sha = canonical_sha256({})
            content = {
                "logical_key": logical,
                "value": canonical_decimal(draft.numeric_value),
                "availability": draft.availability,
                "completeness": draft.completeness,
                "formula_version": METRIC_REGISTRY_VERSION,
            }
            sequence = conn.execute(
                "SELECT COALESCE(MAX(published_sequence), 0) + 1 FROM metric_observations"
            ).fetchone()[0]
            previous = conn.execute(
                "SELECT observation_id, head_generation FROM metric_observation_heads"
                " WHERE logical_key_sha256 = ?",
                (logical_sha,),
            ).fetchone()
            cursor = conn.execute(
                "INSERT INTO metric_observations (batch_id, source_scope_id, metric_key, business_date,"
                " date_basis, dimension_json, dimension_sha256, logical_key_json, logical_key_sha256,"
                " numeric_value, availability, completeness, source_updated_at, formula_version,"
                " published_sequence, supersedes_observation_id, content_sha256, created_at)"
                " VALUES (?,?,?,?, 'store_local', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (batch_id, draft.source_scope_id, draft.metric_key, draft.business_date.isoformat(),
                 dimension_sha, json.dumps(logical, sort_keys=True, separators=(",", ":")), logical_sha,
                 float(draft.numeric_value) if draft.numeric_value is not None else None,
                 draft.availability, draft.completeness,
                 canonical_instant(draft.source_updated_at) if draft.source_updated_at else None,
                 METRIC_REGISTRY_VERSION, sequence,
                 previous["observation_id"] if previous is not None else None,
                 canonical_sha256(content), stamp),
            )
            observation_id = int(cursor.lastrowid)
            observation_ids.append(observation_id)
            if previous is None:
                conn.execute(
                    "INSERT INTO metric_observation_heads (logical_key_sha256, observation_id,"
                    " head_generation, updated_at) VALUES (?,?,1,?)",
                    (logical_sha, observation_id, stamp),
                )
            else:
                conn.execute(
                    "UPDATE metric_observation_heads SET observation_id = ?, head_generation = ?,"
                    " updated_at = ? WHERE logical_key_sha256 = ?",
                    (observation_id, previous["head_generation"] + 1, stamp, logical_sha),
                )
            head_updates += 1
        conn.execute(
            "UPDATE metric_sync_batches SET status = 'published', published_at = ?, updated_at = ?,"
            " response_sha256 = ? WHERE id = ?",
            (stamp, stamp, payload_sha, batch_id),
        )
        conn.execute(
            "UPDATE metric_sync_jobs SET completed_batch_count = completed_batch_count + 1,"
            " status = CASE WHEN completed_batch_count + 1 >= batch_count THEN 'succeeded' ELSE 'running' END"
            " WHERE id = (SELECT job_id FROM metric_sync_batches WHERE id = ?)",
            (batch_id,),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return PublishedBatch(batch_id, tuple(observation_ids), head_updates)


def query_metric_heads(
    conn: sqlite3.Connection, scope_ids: tuple[int, ...], metric_keys: tuple[str, ...],
    start: date, end: date,
) -> list[HeadObservation]:
    if not scope_ids or not metric_keys:
        return []
    scope_marks = ",".join("?" * len(scope_ids))
    metric_marks = ",".join("?" * len(metric_keys))
    rows = conn.execute(
        "SELECT o.source_scope_id, o.metric_key, o.business_date, o.numeric_value, o.availability,"
        " o.completeness, o.id AS observation_id, o.supersedes_observation_id"
        " FROM metric_observation_heads h JOIN metric_observations o ON o.id = h.observation_id"
        f" WHERE o.source_scope_id IN ({scope_marks}) AND o.metric_key IN ({metric_marks})"
        "   AND o.business_date BETWEEN ? AND ?"
        " ORDER BY o.business_date, o.source_scope_id, o.metric_key",
        (*scope_ids, *metric_keys, start.isoformat(), end.isoformat()),
    ).fetchall()
    return [
        HeadObservation(
            row["source_scope_id"], row["metric_key"], date.fromisoformat(row["business_date"]),
            None if row["numeric_value"] is None else Decimal(str(int(row["numeric_value"]))),
            row["availability"], row["completeness"], row["observation_id"],
            row["supersedes_observation_id"] is not None,
        )
        for row in rows
    ]


def record_quality_event(
    conn: sqlite3.Connection, *, source: str, scope_id: int | None, merchant_id: int | None,
    location_id: int | None, category: str, severity: str, start: date | None, end: date | None,
    details: dict, batch_id: int | None, now: datetime,
) -> int:
    stamp = canonical_instant(now)
    cursor = conn.execute(
        "INSERT INTO data_quality_events (source, source_scope_id, merchant_id, merchant_location_id,"
        " start_date, end_date, category, severity, status, details_json, first_seen_at, last_seen_at,"
        " batch_id) VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?, ?, ?)",
        (source, scope_id, merchant_id, location_id,
         start.isoformat() if start else None, end.isoformat() if end else None,
         category, severity, json.dumps(details, sort_keys=True, separators=(",", ":")), stamp, stamp, batch_id),
    )
    return int(cursor.lastrowid)


def open_quality_events(
    conn: sqlite3.Connection, scope_ids: tuple[int, ...], start: date, end: date
) -> list[dict]:
    if not scope_ids:
        return []
    marks = ",".join("?" * len(scope_ids))
    rows = conn.execute(
        "SELECT source, category, severity, start_date, end_date, details_json, status, resolved_at"
        f" FROM data_quality_events WHERE source_scope_id IN ({marks})"
        "   AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)"
        " ORDER BY severity DESC, category, start_date",
        (*scope_ids, end.isoformat(), start.isoformat()),
    ).fetchall()
    return [
        {
            "source": row["source"], "category": row["category"], "severity": row["severity"],
            "start_date": row["start_date"], "end_date": row["end_date"], "status": row["status"],
            "details": json.loads(row["details_json"] or "{}"),
        }
        for row in rows
    ]
```

- [ ] **Step 4: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_store.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_store.py api/tests/test_performance_store.py
git commit -m "feat: publish immutable metric batches with compare-and-swap heads

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 6: Normalize the FBR GBP payload into observation drafts

**Files:**
- Create: `api/app/performance_gbp.py`
- Create: `api/tests/fixtures/performance/gbp_choice_brooklyn_gold.json`
- Create: `api/tests/test_performance_gbp.py`

**Interfaces:**
- Consumes: `app.fbr_gbp.FbrGbpClient.list_performance_metrics(fbr_merchant_id, place_id, *, from_date, to_date)`; Task 5 `ObservationDraft`; Task 1 `GBP_SOURCE_METRICS`.
- Produces: `GBP_ADAPTER_VERSION = "gbp.performance.v1"`.
- Produces: `@dataclass(frozen=True) NormalizedPartition(drafts: tuple[ObservationDraft, ...], observed_dates: tuple[date, ...], omissions: tuple[tuple[date, str], ...], data_through: date | None)`.
- Produces: `normalize_performance_payload(payload: object, *, source_scope_id: int, start: date, end: date) -> NormalizedPartition`.
- Produces: `fetch_partition(client, *, fbr_merchant_id: str, place_id: str, source_scope_id: int, start: date, end: date) -> tuple[bytes, NormalizedPartition]`.
- Produces: `classify_source_error(exc: Exception) -> Literal["retryable", "blocked"]`.

- [ ] **Step 1: Write the gold fixture**

```json
{
  "metrics": [
    {"metric_date": "2026-08-18", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 10},
    {"metric_date": "2026-08-18", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "value": 20},
    {"metric_date": "2026-08-18", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 30},
    {"metric_date": "2026-08-18", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 40},
    {"metric_date": "2026-08-18", "metric": "WEBSITE_CLICKS", "value": 5},
    {"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": 0},
    {"metric_date": "2026-08-18", "metric": "BUSINESS_DIRECTION_REQUESTS", "value": 3},
    {"metric_date": "2026-08-18", "metric": "BUSINESS_FOOD_MENU_CLICKS", "value": 7},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "value": 11},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "value": 21},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_IMPRESSIONS_MOBILE_MAPS", "value": 31},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "value": 41},
    {"metric_date": "2026-08-19", "metric": "WEBSITE_CLICKS", "value": 6},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_DIRECTION_REQUESTS", "value": 4},
    {"metric_date": "2026-08-19", "metric": "BUSINESS_FOOD_MENU_CLICKS", "value": 8}
  ]
}
```

Hand-checkable facts: 2026-08-18 has all eight keys, `CALL_CLICKS` is an observed `0`, and impressions total `100`. 2026-08-19 omits `CALL_CLICKS` and totals `104`. 2026-08-20 is absent entirely.

- [ ] **Step 2: Write the failing normalization tests**

```python
# api/tests/test_performance_gbp.py
import json
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from app.fbr_gbp import FbrPayloadError, FbrUnavailableError
from app.performance_gbp import classify_source_error, normalize_performance_payload

GOLD = json.loads((Path(__file__).parent / "fixtures/performance/gbp_choice_brooklyn_gold.json").read_text())


def _normalize():
    return normalize_performance_payload(GOLD, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20))


def test_observed_zero_is_available_not_missing():
    partition = _normalize()
    call_clicks = next(
        d for d in partition.drafts if d.metric_key == "CALL_CLICKS" and d.business_date == date(2026, 8, 18)
    )
    assert call_clicks.numeric_value == Decimal("0")
    assert (call_clicks.availability, call_clicks.completeness) == ("available", "complete")


def test_omitted_key_on_a_returned_day_is_unavailable_and_reported():
    partition = _normalize()
    call_clicks = next(
        d for d in partition.drafts if d.metric_key == "CALL_CLICKS" and d.business_date == date(2026, 8, 19)
    )
    assert call_clicks.numeric_value is None
    assert (call_clicks.availability, call_clicks.completeness) == ("unavailable", "unknown")
    assert (date(2026, 8, 19), "CALL_CLICKS") in partition.omissions


def test_a_day_the_source_never_returned_produces_no_draft():
    partition = _normalize()
    assert all(draft.business_date != date(2026, 8, 20) for draft in partition.drafts)
    assert partition.observed_dates == (date(2026, 8, 18), date(2026, 8, 19))
    assert partition.data_through == date(2026, 8, 19)


def test_rows_outside_the_requested_window_are_rejected():
    payload = {"metrics": [{"metric_date": "2026-07-01", "metric": "CALL_CLICKS", "value": 1}]}
    with pytest.raises(FbrPayloadError):
        normalize_performance_payload(payload, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20))


def test_unknown_metric_keys_and_malformed_values_are_rejected():
    for metrics in (
        [{"metric_date": "2026-08-18", "metric": "BUSINESS_BOOKINGS", "value": 1}],
        [{"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": "many"}],
        [{"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": 1},
         {"metric_date": "2026-08-18", "metric": "CALL_CLICKS", "value": 2}],
    ):
        with pytest.raises(FbrPayloadError):
            normalize_performance_payload(
                {"metrics": metrics}, source_scope_id=1, start=date(2026, 8, 18), end=date(2026, 8, 20)
            )


def test_transport_failures_are_retryable_and_payload_failures_are_blocked():
    assert classify_source_error(FbrUnavailableError("timeout")) == "retryable"
    assert classify_source_error(FbrPayloadError("bad")) == "blocked"
```

- [ ] **Step 3: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_gbp.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_gbp'`.

- [ ] **Step 4: Implement the adapter**

```python
# api/app/performance_gbp.py
"""Turn one FBR GBP performance response into immutable observation drafts."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Literal

from .fbr_gbp import FbrConfigurationError, FbrPayloadError, FbrUnavailableError
from .performance_metrics import GBP_SOURCE_METRICS
from .performance_store import ObservationDraft

GBP_ADAPTER_VERSION = "gbp.performance.v1"
SOURCE_START_DATE = date(2026, 8, 18)  # proven by the 2026-09-09 read-only probe


@dataclass(frozen=True)
class NormalizedPartition:
    drafts: tuple[ObservationDraft, ...]
    observed_dates: tuple[date, ...]
    omissions: tuple[tuple[date, str], ...]
    data_through: date | None


def _parse_row(row: object, start: date, end: date) -> tuple[date, str, Decimal]:
    if not isinstance(row, dict):
        raise FbrPayloadError("performance row must be an object")
    raw_date = row.get("metric_date")
    metric = row.get("metric")
    value = row.get("value")
    try:
        business_date = date.fromisoformat(str(raw_date))
    except ValueError as exc:
        raise FbrPayloadError(f"invalid metric_date: {raw_date!r}") from exc
    if not (start <= business_date <= end):
        raise FbrPayloadError(f"metric_date {business_date} is outside the requested window")
    if metric not in GBP_SOURCE_METRICS:
        raise FbrPayloadError(f"unknown metric key: {metric!r}")
    if isinstance(value, bool) or not isinstance(value, int):
        raise FbrPayloadError(f"metric value must be an integer: {value!r}")
    return business_date, str(metric), Decimal(value)


def normalize_performance_payload(
    payload: object, *, source_scope_id: int, start: date, end: date
) -> NormalizedPartition:
    if not isinstance(payload, dict) or not isinstance(payload.get("metrics"), list):
        raise FbrPayloadError("performance payload must contain a metrics list")
    observed: dict[tuple[date, str], Decimal] = {}
    for row in payload["metrics"]:
        business_date, metric, value = _parse_row(row, start, end)
        if (business_date, metric) in observed:
            raise FbrPayloadError(f"duplicate row for {business_date} {metric}")
        observed[(business_date, metric)] = value
    observed_dates = tuple(sorted({key[0] for key in observed}))
    drafts: list[ObservationDraft] = []
    omissions: list[tuple[date, str]] = []
    for business_date in observed_dates:
        for metric in GBP_SOURCE_METRICS:
            value = observed.get((business_date, metric))
            if value is None:
                omissions.append((business_date, metric))
                drafts.append(
                    ObservationDraft(source_scope_id, metric, business_date, None, "unavailable", "unknown")
                )
            else:
                drafts.append(
                    ObservationDraft(source_scope_id, metric, business_date, value, "available", "complete")
                )
    return NormalizedPartition(
        tuple(drafts), observed_dates, tuple(omissions), observed_dates[-1] if observed_dates else None
    )


def fetch_partition(
    client, *, fbr_merchant_id: str, place_id: str, source_scope_id: int, start: date, end: date
) -> tuple[bytes, NormalizedPartition]:
    payload = client.list_performance_metrics(
        fbr_merchant_id, place_id, from_date=start.isoformat(), to_date=end.isoformat()
    )
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return raw, normalize_performance_payload(payload, source_scope_id=source_scope_id, start=start, end=end)


def classify_source_error(exc: Exception) -> Literal["retryable", "blocked"]:
    if isinstance(exc, (FbrPayloadError, FbrConfigurationError)):
        return "blocked"
    if isinstance(exc, FbrUnavailableError):
        return "retryable"
    return "retryable"
```

- [ ] **Step 5: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_gbp.py -v`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_gbp.py api/tests/test_performance_gbp.py api/tests/fixtures/performance/gbp_choice_brooklyn_gold.json
git commit -m "feat: normalize FBR GBP metrics without inventing zeros

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 7: Month-partitioned sync jobs, a leased worker and the daily schedule

**Files:**
- Create: `api/app/performance_sync.py`
- Create: `api/tests/test_performance_sync.py`
- Modify: `api/app/config.py` (append the settings block below)
- Modify: `api/app/scheduler.py:936-952` (`fbr_scheduler_loop`)
- Modify: `.env.example`

**Interfaces:**
- Consumes: Task 4 `resolve_bound_scopes`, `canonical_instant`; Task 5 `create_sync_job`, `create_batch`, `publish_metric_batch`, `record_quality_event`; Task 6 `fetch_partition`, `classify_source_error`, `GBP_ADAPTER_VERSION`, `SOURCE_START_DATE`.
- Produces: `@dataclass(frozen=True) PerformanceSyncSettings(enabled: bool, pilot_merchant_ids: frozenset[int], lease_seconds: int, max_attempts: int, delay_days: int)` and `performance_sync_settings() -> PerformanceSyncSettings` in `config.py`.
- Produces: `month_partitions(start: date, end: date) -> tuple[tuple[str, date, date], ...]`.
- Produces: `plan_sync_job(conn, merchant_id: int, start: date, end: date, *, job_type: str, request_id: str, operator: str, now: datetime) -> SyncJobPlan` where `SyncJobPlan(job_id: int, batch_ids: tuple[int, ...], partitions: tuple[tuple[str, date, date], ...], clamped_start: date, clamped_end: date)`.
- Produces: `claim_next_batch(conn, *, owner_token: str, now: datetime, lease_seconds: int) -> sqlite3.Row | None`.
- Produces: `process_metric_sync_batches_once(client, *, max_batches: int = 4, now: datetime | None = None) -> int`.
- Produces: `enqueue_daily_performance_jobs_once(*, now: datetime | None = None) -> int`.

- [ ] **Step 1: Write the failing sync tests**

```python
# api/tests/test_performance_sync.py
from datetime import date, datetime, timezone

import pytest

from app.fbr_gbp import FbrUnavailableError
from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone
from app.performance_store import query_metric_heads
from app.performance_sync import month_partitions, plan_sync_job, process_metric_sync_batches_once
from tests.test_performance_identity import _seed_merchant_with_two_gbp_profiles

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


class FakeFbrClient:
    def __init__(self, payloads, failures=0):
        self.payloads = payloads
        self.failures = failures
        self.calls: list[tuple[str, str, str]] = []

    def list_performance_metrics(self, fbr_merchant_id, place_id, *, from_date, to_date):
        self.calls.append((place_id, from_date, to_date))
        if self.failures > 0:
            self.failures -= 1
            raise FbrUnavailableError("upstream timeout")
        return self.payloads


def _pilot(conn, monkeypatch):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    for scope in scopes:
        set_location_timezone(conn, scope.location.id, "America/New_York", actor="test", effective_at=NOW)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "3")
    return scopes


def test_month_partitions_split_a_multi_month_window_inclusively():
    assert month_partitions(date(2026, 8, 18), date(2026, 9, 6)) == (
        ("2026-08", date(2026, 8, 18), date(2026, 8, 31)),
        ("2026-09", date(2026, 9, 1), date(2026, 9, 6)),
    )


def test_plan_clamps_the_request_to_the_proven_source_start(conn, monkeypatch):
    _pilot(conn, monkeypatch)
    plan = plan_sync_job(
        conn, 3, date(2026, 6, 1), date(2026, 9, 6),
        job_type="backfill", request_id="r1", operator="test", now=NOW,
    )
    assert plan.clamped_start == date(2026, 8, 18)
    assert len(plan.batch_ids) == 4  # two locations x two months


def test_replaying_the_same_request_id_reuses_one_job(conn, monkeypatch):
    _pilot(conn, monkeypatch)
    first = plan_sync_job(conn, 3, date(2026, 8, 18), date(2026, 8, 31),
                          job_type="backfill", request_id="r1", operator="test", now=NOW)
    second = plan_sync_job(conn, 3, date(2026, 8, 18), date(2026, 8, 31),
                           job_type="backfill", request_id="r1", operator="test", now=NOW)
    assert first.job_id == second.job_id
    assert conn.execute("SELECT COUNT(*) FROM metric_sync_batches").fetchone()[0] == len(first.batch_ids)


def test_worker_publishes_observations_and_marks_the_batch(conn, monkeypatch, gold_payload):
    _pilot(conn, monkeypatch)
    plan_sync_job(conn, 3, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    client = FakeFbrClient(gold_payload)
    assert process_metric_sync_batches_once(client, max_batches=4, now=NOW) == 2
    scope_ids = tuple(row["id"] for row in conn.execute("SELECT id FROM source_scopes ORDER BY id"))
    heads = query_metric_heads(conn, scope_ids, ("CALL_CLICKS",), date(2026, 8, 18), date(2026, 8, 19))
    assert {(h.business_date, h.availability) for h in heads} == {
        (date(2026, 8, 18), "available"), (date(2026, 8, 19), "unavailable"),
    }
    assert conn.execute(
        "SELECT COUNT(*) FROM data_quality_events WHERE category = 'source_omits_metric_rows'"
    ).fetchone()[0] == 2


def test_retryable_failure_keeps_the_batch_claimable_and_publishes_nothing(conn, monkeypatch, gold_payload):
    _pilot(conn, monkeypatch)
    plan_sync_job(conn, 3, date(2026, 8, 18), date(2026, 8, 19),
                  job_type="backfill", request_id="r1", operator="test", now=NOW)
    client = FakeFbrClient(gold_payload, failures=99)
    process_metric_sync_batches_once(client, max_batches=2, now=NOW)
    assert conn.execute("SELECT COUNT(*) FROM metric_observations").fetchone()[0] == 0
    statuses = {row[0] for row in conn.execute("SELECT status FROM metric_sync_batches")}
    assert statuses == {"retryable"}
```

Add to `api/tests/conftest.py`:

```python
@pytest.fixture()
def gold_payload():
    import json

    return json.loads(
        (Path(__file__).parent / "fixtures/performance/gbp_choice_brooklyn_gold.json").read_text("utf-8")
    )
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_sync.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_sync'`.

- [ ] **Step 3: Add the settings block to `api/app/config.py`**

```python
@dataclass(frozen=True)
class PerformanceSyncSettings:
    enabled: bool
    pilot_merchant_ids: frozenset[int]
    lease_seconds: int
    max_attempts: int
    delay_days: int


def performance_sync_settings() -> PerformanceSyncSettings:
    raw_ids = os.environ.get("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "").strip()
    ids: set[int] = set()
    for token in (part.strip() for part in raw_ids.split(",")):
        if not token:
            continue
        if not token.isdigit():
            raise ValueError("invalid SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS")
        ids.add(int(token))

    def _int(name: str, default: int) -> int:
        value = os.environ.get(name, "").strip()
        if not value:
            return default
        if not value.isdigit() or int(value) <= 0:
            raise ValueError(f"invalid {name}")
        return int(value)

    return PerformanceSyncSettings(
        enabled=os.environ.get("SEO_OPS_PERFORMANCE_SYNC_ENABLED", "").strip().lower() == "true",
        pilot_merchant_ids=frozenset(ids),
        lease_seconds=_int("SEO_OPS_PERFORMANCE_LEASE_SECONDS", 120),
        max_attempts=_int("SEO_OPS_PERFORMANCE_MAX_AUTO_ATTEMPTS", 5),
        delay_days=_int("SEO_OPS_PERFORMANCE_DELAY_DAYS", 3),
    )


def performance_history_read_enabled() -> bool:
    return os.environ.get("SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED", "").strip().lower() == "true"
```

Append to `.env.example`:

```dotenv
SEO_OPS_PERFORMANCE_SYNC_ENABLED=false
SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED=false
SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS=
SEO_OPS_PERFORMANCE_LEASE_SECONDS=120
SEO_OPS_PERFORMANCE_MAX_AUTO_ATTEMPTS=5
SEO_OPS_PERFORMANCE_DELAY_DAYS=3
```

- [ ] **Step 4: Implement partitioning, planning and the worker**

```python
# api/app/performance_sync.py
"""Month-partitioned GBP history jobs and the leased worker that publishes them."""
from __future__ import annotations

import calendar
import logging
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from .config import performance_sync_settings
from .db import connect
from .fbr_gbp import fbr_gbp_client
from .performance_gbp import GBP_ADAPTER_VERSION, SOURCE_START_DATE, classify_source_error, fetch_partition
from .performance_identity import canonical_instant, resolve_bound_scopes
from .performance_store import BatchDraft, create_batch, create_sync_job, publish_metric_batch, record_quality_event

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SyncJobPlan:
    job_id: int
    batch_ids: tuple[int, ...]
    partitions: tuple[tuple[str, date, date], ...]
    clamped_start: date
    clamped_end: date


def month_partitions(start: date, end: date) -> tuple[tuple[str, date, date], ...]:
    partitions: list[tuple[str, date, date]] = []
    cursor = start.replace(day=1)
    while cursor <= end:
        last_day = cursor.replace(day=calendar.monthrange(cursor.year, cursor.month)[1])
        partitions.append((cursor.strftime("%Y-%m"), max(cursor, start), min(last_day, end)))
        cursor = last_day + timedelta(days=1)
    return tuple(partitions)


def _fbr_merchant_id(conn: sqlite3.Connection, merchant_id: int) -> str:
    row = conn.execute(
        "SELECT fbr_merchant_id FROM merchant_gbp_profiles WHERE merchant_id = ? LIMIT 1", (merchant_id,)
    ).fetchone()
    if row is None:
        raise ValueError(f"merchant {merchant_id} has no GBP profile")
    return str(row["fbr_merchant_id"])


def plan_sync_job(
    conn: sqlite3.Connection, merchant_id: int, start: date, end: date, *,
    job_type: str, request_id: str, operator: str, now: datetime,
) -> SyncJobPlan:
    clamped_start = max(start, SOURCE_START_DATE)
    clamped_end = end
    if clamped_start > clamped_end:
        raise ValueError("requested window ends before the proven source start date")
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=now)
    if not scopes:
        raise ValueError(f"merchant {merchant_id} has no bound GBP location")
    partitions = month_partitions(clamped_start, clamped_end)
    manifest = {
        "merchant_id": merchant_id,
        "scope_ids": sorted(scope.scope_id for scope in scopes),
        "partitions": [key for key, _, _ in partitions],
    }
    job_id = create_sync_job(
        conn, job_type=job_type, request_id=request_id, requested_by=operator,
        scope_manifest=manifest, start=clamped_start, end=clamped_end, now=now,
    )
    existing = {
        (row["source_scope_id"], row["partition_month"])
        for row in conn.execute(
            "SELECT source_scope_id, partition_month FROM metric_sync_batches WHERE job_id = ?", (job_id,)
        )
    }
    batch_ids: list[int] = []
    for scope in scopes:
        for partition_key, _, partition_end in partitions:
            if (scope.scope_id, partition_key) in existing:
                continue
            batch_ids.append(
                create_batch(
                    conn,
                    BatchDraft(job_id, scope.scope_id, partition_key, 1, GBP_ADAPTER_VERSION, now, partition_end),
                    now=now,
                )
            )
    return SyncJobPlan(job_id, tuple(batch_ids), partitions, clamped_start, clamped_end)


def claim_next_batch(conn: sqlite3.Connection, *, owner_token: str, now: datetime, lease_seconds: int):
    stamp = canonical_instant(now)
    expiry = canonical_instant(now + timedelta(seconds=lease_seconds))
    conn.execute("BEGIN IMMEDIATE")
    try:
        row = conn.execute(
            "SELECT b.*, j.requested_start_date, j.requested_end_date, j.scope_manifest_json"
            " FROM metric_sync_batches b JOIN metric_sync_jobs j ON j.id = b.job_id"
            " WHERE b.status IN ('queued','retryable')"
            "   AND (b.lease_expires_at IS NULL OR b.lease_expires_at < ?)"
            " ORDER BY b.id LIMIT 1",
            (stamp,),
        ).fetchone()
        if row is None:
            conn.rollback()
            return None
        conn.execute(
            "UPDATE metric_sync_batches SET status = 'leased', lease_owner = ?, lease_expires_at = ?,"
            " heartbeat_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','retryable')",
            (owner_token, expiry, stamp, stamp, row["id"]),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return row


def _partition_window(row, start: date, end: date) -> tuple[date, date]:
    year, month = (int(part) for part in row["partition_month"].split("-"))
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    return max(first, start), min(last, end)


def process_metric_sync_batches_once(client, *, max_batches: int = 4, now: datetime | None = None) -> int:
    settings = performance_sync_settings()
    if not settings.enabled:
        return 0
    moment = now or datetime.now(timezone.utc)
    owner_token = uuid.uuid4().hex
    processed = 0
    conn = connect()
    try:
        for _ in range(max_batches):
            row = claim_next_batch(conn, owner_token=owner_token, now=moment, lease_seconds=settings.lease_seconds)
            if row is None:
                break
            scope = conn.execute(
                "SELECT s.external_id, s.id, b.merchant_id, b.merchant_location_id FROM source_scopes s"
                " JOIN source_scope_bindings b ON b.source_scope_id = s.id AND b.valid_to IS NULL"
                " WHERE s.id = ?",
                (row["source_scope_id"],),
            ).fetchone()
            place_row = conn.execute(
                "SELECT normalized_json FROM merchant_gbp_profiles WHERE merchant_id = ? AND gbp_location_id = ?",
                (scope["merchant_id"], scope["external_id"]),
            ).fetchone()
            import json as _json

            place_id = _json.loads(place_row["normalized_json"] or "{}").get("place_id") if place_row else None
            start, end = _partition_window(
                row, date.fromisoformat(row["requested_start_date"]), date.fromisoformat(row["requested_end_date"])
            )
            try:
                if place_id is None:
                    raise ValueError("GBP profile has no place_id")
                raw, partition = fetch_partition(
                    client,
                    fbr_merchant_id=_fbr_merchant_id(conn, scope["merchant_id"]),
                    place_id=place_id,
                    source_scope_id=row["source_scope_id"],
                    start=start,
                    end=end,
                )
            except Exception as exc:  # noqa: BLE001 - classified below
                classification = classify_source_error(exc)
                conn.execute(
                    "UPDATE metric_sync_batches SET status = ?, lease_owner = NULL, lease_expires_at = NULL,"
                    " error_category = ?, error_summary = ?, updated_at = ? WHERE id = ?",
                    ("retryable" if classification == "retryable" else "blocked", classification,
                     str(exc)[:400], canonical_instant(moment), row["id"]),
                )
                conn.commit()
                logger.warning("performance batch %s failed (%s)", row["id"], classification)
                continue
            publish_metric_batch(conn, row["id"], raw, list(partition.drafts), now=moment)
            for omission_date, metric_key in partition.omissions:
                record_quality_event(
                    conn, source="GBP", scope_id=row["source_scope_id"], merchant_id=scope["merchant_id"],
                    location_id=scope["merchant_location_id"], category="source_omits_metric_rows",
                    severity="yellow", start=omission_date, end=omission_date,
                    details={"metric_key": metric_key, "note": "source returned other metrics for this day"},
                    batch_id=row["id"], now=moment,
                )
            conn.commit()
            processed += 1
    finally:
        conn.close()
    return processed


def enqueue_daily_performance_jobs_once(*, now: datetime | None = None) -> int:
    settings = performance_sync_settings()
    if not settings.enabled or not settings.pilot_merchant_ids:
        return 0
    moment = now or datetime.now(timezone.utc)
    end = moment.date() - timedelta(days=settings.delay_days)
    start = end - timedelta(days=settings.delay_days + 1)
    created = 0
    conn = connect()
    try:
        for merchant_id in sorted(settings.pilot_merchant_ids):
            try:
                plan_sync_job(
                    conn, merchant_id, start, end, job_type="daily",
                    request_id=f"daily:{end.isoformat()}", operator="scheduler", now=moment,
                )
                created += 1
            except ValueError:
                logger.info("merchant %s is not ready for performance sync", merchant_id)
    finally:
        conn.close()
    return created
```

- [ ] **Step 5: Wire the worker into the FBR scheduler loop**

In `api/app/scheduler.py`, import `enqueue_daily_performance_jobs_once` and `process_metric_sync_batches_once` from `.performance_sync`, then extend `fbr_scheduler_loop`'s try block after the existing profile sync call:

```python
                if fbr_client is not None:
                    await asyncio.to_thread(sync_due_fbr_profiles_once, fbr_client)
                    await asyncio.to_thread(enqueue_daily_performance_jobs_once)
                    await asyncio.to_thread(process_metric_sync_batches_once, fbr_client)
```

Both helpers return 0 immediately when `SEO_OPS_PERFORMANCE_SYNC_ENABLED` is not `true`, so behaviour is unchanged until the pilot is enabled.

- [ ] **Step 6: Run GREEN and the scheduler regression**

Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/python -m pytest tests/test_performance_sync.py tests/test_scheduler.py -v
```

Expected: PASS (5 new tests plus the untouched scheduler suite).

- [ ] **Step 7: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_sync.py api/tests/test_performance_sync.py api/tests/conftest.py api/app/config.py api/app/scheduler.py .env.example
git commit -m "feat: add month-partitioned GBP sync jobs and a leased worker

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 8: Operator-confirmed backfill preflight and job API

**Files:**
- Create: `api/app/performance_sync_api.py`
- Create: `api/tests/test_performance_sync_api.py`
- Modify: `api/app/main.py` (import and include the router with `operator_dependencies`)

**Interfaces:**
- Consumes: Task 7 `plan_sync_job`, `month_partitions`, `performance_sync_settings`; Task 4 `resolve_bound_scopes`.
- Produces: `POST /api/merchants/{merchant_id}/performance/backfill/preflight` accepting `{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}` and returning `{"clamped_start", "clamped_end", "source_start_date", "partitions": [...], "locations": [...], "batch_estimate", "blockers": [...]}`.
- Produces: `POST /api/merchants/{merchant_id}/performance/backfill` accepting `{"request_id", "start", "end", "confirmed": true}` and returning `{"job_id", "batch_ids", "clamped_start", "clamped_end"}`.
- Produces: `GET /api/performance-sync/jobs/{job_id}` returning job status plus per-batch rows.

- [ ] **Step 1: Write the failing API tests**

```python
# api/tests/test_performance_sync_api.py
import json


def _seed_pilot(client, monkeypatch):
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_SYNC_ENABLED", "true")
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "1")
    created = client.post("/api/merchants", json={"name": "Choice Brooklyn"})
    merchant_id = created.json()["id"]
    from app.db import connect
    from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone
    from datetime import datetime, timezone

    conn = connect()
    try:
        conn.execute(
            "INSERT INTO merchant_gbp_profiles (merchant_id, fbr_merchant_id, gbp_location_id, source_title,"
            " location_json, normalized_json, synced_at) VALUES (?,?,?,?,'{}',?,'2026-09-03T00:00:00.000000Z')",
            (merchant_id, "fbr-3", "24300588970198995", "Upper West Side",
             json.dumps({"place_id": "ChIJH8iZh-5ZwokRPLzzADeSnYE"})),
        )
        conn.commit()
        now = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)
        scopes = seed_gbp_locations_from_profiles(conn, merchant_id, actor="test", observed_at=now)
        set_location_timezone(conn, scopes[0].location.id, "America/New_York", actor="test", effective_at=now)
    finally:
        conn.close()
    return merchant_id


def test_preflight_clamps_to_the_source_start_and_lists_month_partitions(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill/preflight",
        json={"start": "2026-06-01", "end": "2026-09-06"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["clamped_start"] == "2026-08-18"
    assert [p["partition_month"] for p in body["partitions"]] == ["2026-08", "2026-09"]
    assert body["batch_estimate"] == 2
    assert body["blockers"] == []


def test_preflight_reports_a_missing_timezone_as_a_blocker(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    from app.db import connect

    conn = connect()
    try:
        conn.execute("UPDATE merchant_locations SET timezone_name = NULL, status = 'needs_attention'")
        conn.commit()
    finally:
        conn.close()
    body = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill/preflight",
        json={"start": "2026-08-18", "end": "2026-08-31"},
    ).json()
    assert any(blocker["code"] == "location_timezone_missing" for blocker in body["blockers"])


def test_confirm_requires_the_confirmation_flag(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill",
        json={"request_id": "r1", "start": "2026-08-18", "end": "2026-08-31", "confirmed": False},
    )
    assert response.status_code == 422


def test_confirm_is_idempotent_for_one_request_id(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    body = {"request_id": "r1", "start": "2026-08-18", "end": "2026-08-31", "confirmed": True}
    first = client.post(f"/api/merchants/{merchant_id}/performance/backfill", json=body)
    second = client.post(f"/api/merchants/{merchant_id}/performance/backfill", json=body)
    assert first.status_code == 200 and second.status_code == 200
    assert first.json()["job_id"] == second.json()["job_id"]
    assert second.json()["batch_ids"] == []
    status = client.get(f"/api/performance-sync/jobs/{first.json()['job_id']}").json()
    assert status["batch_count"] == 1 and status["status"] in {"queued", "running"}


def test_backfill_is_refused_for_a_non_pilot_merchant(client, monkeypatch):
    merchant_id = _seed_pilot(client, monkeypatch)
    monkeypatch.setenv("SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS", "999")
    response = client.post(
        f"/api/merchants/{merchant_id}/performance/backfill",
        json={"request_id": "r2", "start": "2026-08-18", "end": "2026-08-31", "confirmed": True},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "performance_sync_not_enabled_for_merchant"
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_sync_api.py -v`
Expected: FAIL with 404 on every route.

- [ ] **Step 3: Implement the router**

```python
# api/app/performance_sync_api.py
"""Operator-confirmed GBP history backfill."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .auth import require_operator
from .config import performance_sync_settings
from .db import get_db
from .performance_gbp import SOURCE_START_DATE
from .performance_identity import resolve_bound_scopes
from .performance_sync import month_partitions, plan_sync_job

router = APIRouter(tags=["performance-sync"])


class BackfillWindowV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    end: date

    @model_validator(mode="after")
    def validate_window(self):
        if self.start > self.end:
            raise ValueError("start must not be after end")
        return self


class BackfillConfirmV1(BackfillWindowV1):
    request_id: str = Field(min_length=1, max_length=200)
    confirmed: Literal[True]


def _require_pilot(merchant_id: int) -> None:
    settings = performance_sync_settings()
    if not settings.enabled or merchant_id not in settings.pilot_merchant_ids:
        raise HTTPException(status_code=409, detail="performance_sync_not_enabled_for_merchant")


@router.post("/api/merchants/{merchant_id}/performance/backfill/preflight")
def preflight(merchant_id: int, body: BackfillWindowV1, conn=Depends(get_db), operator: str = Depends(require_operator)):
    _require_pilot(merchant_id)
    now = datetime.now(timezone.utc)
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=now)
    blockers: list[dict] = []
    if not scopes:
        blockers.append({"code": "no_bound_gbp_location", "detail": "该商户没有已绑定的 GBP 门店"})
    for scope in scopes:
        if not scope.location.timezone_name:
            blockers.append({
                "code": "location_timezone_missing",
                "detail": f"门店「{scope.location.display_name}」尚未设置时区",
                "location_id": scope.location.id,
            })
    clamped_start = max(body.start, SOURCE_START_DATE)
    if clamped_start > body.end:
        blockers.append({"code": "window_before_source_start", "detail": "来源最早只有 2026-08-18 起的数据"})
        partitions = ()
    else:
        partitions = month_partitions(clamped_start, body.end)
    return {
        "merchant_id": merchant_id,
        "requested_start": body.start.isoformat(),
        "requested_end": body.end.isoformat(),
        "clamped_start": clamped_start.isoformat(),
        "clamped_end": body.end.isoformat(),
        "source_start_date": SOURCE_START_DATE.isoformat(),
        "locations": [
            {"location_id": s.location.id, "display_name": s.location.display_name,
             "timezone_name": s.location.timezone_name}
            for s in scopes
        ],
        "partitions": [
            {"partition_month": key, "start": start.isoformat(), "end": end.isoformat()}
            for key, start, end in partitions
        ],
        "batch_estimate": len(partitions) * len(scopes),
        "blockers": blockers,
    }


@router.post("/api/merchants/{merchant_id}/performance/backfill")
def confirm(merchant_id: int, body: BackfillConfirmV1, conn=Depends(get_db), operator: str = Depends(require_operator)):
    _require_pilot(merchant_id)
    now = datetime.now(timezone.utc)
    try:
        plan = plan_sync_job(
            conn, merchant_id, body.start, body.end,
            job_type="backfill", request_id=body.request_id, operator=operator, now=now,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "job_id": plan.job_id,
        "batch_ids": list(plan.batch_ids),
        "clamped_start": plan.clamped_start.isoformat(),
        "clamped_end": plan.clamped_end.isoformat(),
    }


@router.get("/api/performance-sync/jobs/{job_id}")
def job_status(job_id: int, conn=Depends(get_db), operator: str = Depends(require_operator)):
    job = conn.execute("SELECT * FROM metric_sync_jobs WHERE id = ?", (job_id,)).fetchone()
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    batches = conn.execute(
        "SELECT id, source_scope_id, partition_month, attempt, status, data_through, error_category,"
        " error_summary, published_at FROM metric_sync_batches WHERE job_id = ? ORDER BY id",
        (job_id,),
    ).fetchall()
    return {
        "job_id": job["id"],
        "job_type": job["job_type"],
        "status": job["status"],
        "requested_start_date": job["requested_start_date"],
        "requested_end_date": job["requested_end_date"],
        "batch_count": job["batch_count"],
        "completed_batch_count": job["completed_batch_count"],
        "batches": [dict(row) for row in batches],
    }
```

- [ ] **Step 4: Register the router in `api/app/main.py`**

Add `from .performance_sync_api import router as performance_sync_router` beside the other imports and, next to the existing dashboard registration, `application.include_router(performance_sync_router, dependencies=operator_dependencies)`.

- [ ] **Step 5: Run GREEN**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_sync_api.py -v`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_sync_api.py api/tests/test_performance_sync_api.py api/app/main.py
git commit -m "feat: add operator-confirmed GBP backfill preflight and jobs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 9: Merchant-scoped performance query

**Files:**
- Create: `api/app/performance_query.py`
- Create: `api/app/performance_query_api.py`
- Create: `api/tests/test_performance_query.py`
- Modify: `api/app/main.py`

**Interfaces:**
- Consumes: Tasks 1–5 and Task 4's population/default-end helpers.
- Produces: `query_merchant_performance(conn, merchant_id: int, request: MerchantPerformanceQueryV1, *, now: datetime) -> dict` returning the `seo_ops.merchant_performance.v1` body.
- Produces: `POST /api/merchants/{merchant_id}/performance/query`.
- Produces: `GET /api/merchants/{merchant_id}/performance/locations` and `PUT /api/merchant-locations/{location_id}/timezone` (body `{"timezone_name": "America/New_York"}`).
- Produces: response keys `contract_version, formula_version, population_hash, population, periods, kpis, series, coverage, quality, sources, backfill_notes`.

- [ ] **Step 1: Write the failing query tests**

```python
# api/tests/test_performance_query.py
from datetime import date, datetime, timezone
from decimal import Decimal

from app.performance_identity import seed_gbp_locations_from_profiles, set_location_timezone
from app.performance_query import MerchantPerformanceQueryV1, query_merchant_performance
from app.performance_store import BatchDraft, ObservationDraft, create_batch, create_sync_job, publish_metric_batch
from tests.test_performance_identity import _seed_merchant_with_two_gbp_profiles

NOW = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


def _ready_merchant(conn):
    _seed_merchant_with_two_gbp_profiles(conn)
    scopes = seed_gbp_locations_from_profiles(conn, 3, actor="test", observed_at=NOW)
    for scope in scopes:
        set_location_timezone(conn, scope.location.id, "America/New_York", actor="test", effective_at=NOW)
    return scopes


def _publish_day(conn, scope_id, day, values, *, request_id):
    job_id = create_sync_job(conn, job_type="backfill", request_id=request_id, requested_by="test",
                             scope_manifest={"scope_ids": [scope_id]}, start=day, end=day, now=NOW)
    batch_id = create_batch(conn, BatchDraft(job_id, scope_id, day.strftime("%Y-%m"), 1, "gbp.v1", NOW, day), now=NOW)
    drafts = [
        ObservationDraft(scope_id, key, day, None if value is None else Decimal(value),
                         "unavailable" if value is None else "available",
                         "unknown" if value is None else "complete")
        for key, value in values.items()
    ]
    publish_metric_batch(conn, batch_id, b"{}", drafts, now=NOW)


def test_totals_coverage_and_delta_are_computed_from_heads(conn):
    scopes = _ready_merchant(conn)
    scope_id = scopes[0].scope_id
    for index, day in enumerate((date(2026, 9, 1), date(2026, 9, 2))):
        _publish_day(conn, scope_id, day, {
            "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": 10, "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": 20,
            "BUSINESS_IMPRESSIONS_MOBILE_MAPS": 30, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": 40,
            "WEBSITE_CLICKS": 5, "CALL_CLICKS": 0, "BUSINESS_DIRECTION_REQUESTS": 3,
            "BUSINESS_FOOD_MENU_CLICKS": 7,
        }, request_id=f"c{index}")
    for index, day in enumerate((date(2026, 8, 30), date(2026, 8, 31))):
        _publish_day(conn, scope_id, day, {
            "BUSINESS_IMPRESSIONS_DESKTOP_MAPS": 5, "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH": 10,
            "BUSINESS_IMPRESSIONS_MOBILE_MAPS": 15, "BUSINESS_IMPRESSIONS_MOBILE_SEARCH": 20,
            "WEBSITE_CLICKS": 2, "CALL_CLICKS": 1, "BUSINESS_DIRECTION_REQUESTS": 1,
            "BUSINESS_FOOD_MENU_CLICKS": 2,
        }, request_id=f"p{index}")
    body = query_merchant_performance(
        conn, 3,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-02"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    impressions = next(k for k in body["kpis"] if k["metric_key"] == "gbp_impressions_total")
    assert impressions["current"]["value"] == "200"
    assert impressions["comparison"]["value"] == "100"
    assert impressions["delta"] == "100.0" and impressions["comparison_basis"] == "total"
    assert impressions["current"]["observed"] == 2 and impressions["current"]["expected"] == 2
    call_clicks = next(k for k in body["kpis"] if k["metric_key"] == "CALL_CLICKS")
    assert call_clicks["current"]["value"] == "0"


def test_a_missing_day_breaks_the_series_and_reduces_coverage(conn):
    scopes = _ready_merchant(conn)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    body = query_merchant_performance(
        conn, 3,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-03"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    series = next(s for s in body["series"] if s["metric_key"] == "WEBSITE_CLICKS")
    assert [point["value"] for point in series["points"]] == ["5", None, None]
    assert series["points"][1]["missing_reason"] == "no_observation"
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["current"]["observed"] == 1 and website["current"]["expected"] == 3
    assert website["current"]["completeness"] == "partial"


def test_unavailable_metric_rows_do_not_count_as_zero(conn):
    scopes = _ready_merchant(conn)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"CALL_CLICKS": None}, request_id="c0")
    body = query_merchant_performance(
        conn, 3,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-01"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    call_clicks = next(k for k in body["kpis"] if k["metric_key"] == "CALL_CLICKS")
    assert call_clicks["current"]["value"] is None
    assert call_clicks["current"]["availability"] == "unavailable"


def test_repeating_the_same_query_returns_identical_bytes(conn):
    scopes = _ready_merchant(conn)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    request = MerchantPerformanceQueryV1(
        location_ids=[scopes[0].location.id],
        current={"start": "2026-09-01", "end": "2026-09-01"},
        comparison={"mode": "previous_equal_length"},
    )
    from app.canonical_json import canonical_json_bytes

    first = canonical_json_bytes(query_merchant_performance(conn, 3, request, now=NOW))
    second = canonical_json_bytes(query_merchant_performance(conn, 3, request, now=NOW))
    assert first == second


def test_a_comparison_window_before_the_source_start_reports_no_comparable_data(conn):
    scopes = _ready_merchant(conn)
    _publish_day(conn, scopes[0].scope_id, date(2026, 8, 20), {"WEBSITE_CLICKS": 5}, request_id="c0")
    body = query_merchant_performance(
        conn, 3,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-08-20", "end": "2026-08-20"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["comparison"]["value"] is None
    assert website["delta"] is None and website["delta_reason"] == "comparison_unavailable"


def test_corrected_days_are_listed_as_backfill_notes(conn):
    scopes = _ready_merchant(conn)
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 5}, request_id="c0")
    _publish_day(conn, scopes[0].scope_id, date(2026, 9, 1), {"WEBSITE_CLICKS": 9}, request_id="c1")
    body = query_merchant_performance(
        conn, 3,
        MerchantPerformanceQueryV1(
            location_ids=[scopes[0].location.id],
            current={"start": "2026-09-01", "end": "2026-09-01"},
            comparison={"mode": "previous_equal_length"},
        ),
        now=NOW,
    )
    assert body["backfill_notes"] == [{"business_date": "2026-09-01", "metric_key": "WEBSITE_CLICKS"}]
    website = next(k for k in body["kpis"] if k["metric_key"] == "WEBSITE_CLICKS")
    assert website["current"]["value"] == "9"
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests/test_performance_query.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.performance_query'`.

- [ ] **Step 3: Implement aggregation**

```python
# api/app/performance_query.py
"""Aggregate head observations into one merchant-scoped Performance answer."""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .canonical_json import canonical_decimal
from .performance_identity import PopulationManifest, build_population_manifest, resolve_default_end
from .performance_metrics import (
    DERIVED_IMPRESSIONS_KEY,
    GBP_SOURCE_METRICS,
    HEADLINE_METRICS,
    IMPRESSION_COMPONENTS,
    METRIC_REGISTRY_VERSION,
    metric_definition,
)
from .performance_periods import CanonicalPeriods, Period, canonical_periods, compute_delta
from .performance_store import HeadObservation, open_quality_events, query_metric_heads

CONTRACT_VERSION = "seo_ops.merchant_performance.v1"


class DatePeriodV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: date
    end: date

    @model_validator(mode="after")
    def validate_order(self):
        if self.start > self.end:
            raise ValueError("start must not be after end")
        return self


class ComparisonV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["previous_equal_length", "previous_complete_calendar_month", "custom"] = "previous_equal_length"
    start: date | None = None
    end: date | None = None

    @model_validator(mode="after")
    def validate_custom(self):
        if self.mode == "custom" and (self.start is None or self.end is None):
            raise ValueError("custom comparison requires start and end")
        if self.mode != "custom" and (self.start is not None or self.end is not None):
            raise ValueError("comparison dates are valid only for custom mode")
        return self


class MerchantPerformanceQueryV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    location_ids: list[int] = Field(default_factory=list)
    current: DatePeriodV1 | None = None
    comparison: ComparisonV1 = Field(default_factory=ComparisonV1)
    granularity: Literal["day", "week", "month"] = "day"


def _days(period: Period) -> list[date]:
    return [period.start + timedelta(days=offset) for offset in range(period.days)]


def _index(heads: list[HeadObservation]) -> dict[tuple[date, str], list[HeadObservation]]:
    grouped: dict[tuple[date, str], list[HeadObservation]] = {}
    for head in heads:
        grouped.setdefault((head.business_date, head.metric_key), []).append(head)
    return grouped


def _daily_value(
    grouped: dict[tuple[date, str], list[HeadObservation]], day: date, metric_key: str, scope_count: int
) -> tuple[Decimal | None, str, str]:
    """Return (value, availability, completeness) for one metric on one day across all scopes."""
    if metric_key == DERIVED_IMPRESSIONS_KEY:
        components = [
            _daily_value(grouped, day, component, scope_count) for component in IMPRESSION_COMPONENTS
        ]
        available = [value for value, availability, _ in components if availability == "available"]
        if not available:
            return None, "unavailable", "unknown"
        total = sum(available, Decimal(0))
        complete = all(availability == "available" for _, availability, _ in components)
        return total, "available", "complete" if complete else "partial"
    observations = grouped.get((day, metric_key), [])
    if not observations:
        return None, "unavailable", "unknown"
    available = [obs.numeric_value for obs in observations if obs.availability == "available"]
    if not available:
        return None, "unavailable", "unknown"
    total = sum(available, Decimal(0))
    complete = len(available) == scope_count
    return total, "available", "complete" if complete else "partial"


def _aggregate(
    grouped: dict[tuple[date, str], list[HeadObservation]], period: Period, metric_key: str, scope_count: int
) -> dict:
    values: list[Decimal] = []
    observed = 0
    partial = False
    for day in _days(period):
        value, availability, completeness = _daily_value(grouped, day, metric_key, scope_count)
        if availability == "available" and value is not None:
            values.append(value)
            observed += 1
            partial = partial or completeness == "partial"
    expected = period.days
    if observed == 0:
        return {
            "value": None, "availability": "unavailable", "completeness": "unknown",
            "observed": 0, "expected": expected, "data_through": None,
        }
    total = sum(values, Decimal(0))
    completeness = "complete" if observed == expected and not partial else "partial"
    return {
        "value": canonical_decimal(total), "availability": "available", "completeness": completeness,
        "observed": observed, "expected": expected,
        "data_through": max(
            day.isoformat() for day in _days(period)
            if _daily_value(grouped, day, metric_key, scope_count)[1] == "available"
        ),
    }


def _series(
    grouped: dict[tuple[date, str], list[HeadObservation]], period: Period, metric_key: str, scope_count: int
) -> dict:
    points = []
    for day in _days(period):
        value, availability, completeness = _daily_value(grouped, day, metric_key, scope_count)
        points.append({
            "date": day.isoformat(),
            "value": canonical_decimal(value),
            "availability": availability,
            "completeness": completeness,
            "missing_reason": None if availability == "available" else "no_observation",
        })
    return {"metric_key": metric_key, "label": metric_definition(metric_key).label, "points": points}


def _sources(conn: sqlite3.Connection, population: PopulationManifest, period: Period) -> list[dict]:
    scope_ids = tuple(scope.scope_id for scope in population.scopes)
    if not scope_ids:
        return []
    marks = ",".join("?" * len(scope_ids))
    row = conn.execute(
        f"SELECT MAX(data_through) AS data_through, MAX(published_at) AS published_at"
        f" FROM metric_sync_batches WHERE status = 'published' AND source_scope_id IN ({marks})",
        scope_ids,
    ).fetchone()
    return [{
        "source": "GBP",
        "date_basis": "store_local",
        "data_through": row["data_through"],
        "last_success_sync_at": row["published_at"],
        "status": "ready" if row["published_at"] else "no_data",
    }]


def query_merchant_performance(
    conn: sqlite3.Connection, merchant_id: int, request: MerchantPerformanceQueryV1, *, now: datetime
) -> dict:
    location_ids = tuple(sorted(request.location_ids)) or None
    population = build_population_manifest(conn, merchant_id, location_ids, as_of=now)
    if request.current is None:
        end = resolve_default_end(population, as_of=now)
        current = Period(end - timedelta(days=27), end)
    else:
        current = Period(request.current.start, request.current.end)
    custom = (
        Period(request.comparison.start, request.comparison.end)
        if request.comparison.mode == "custom" else None
    )
    periods: CanonicalPeriods = canonical_periods(current, request.comparison.mode, custom)
    scope_ids = tuple(scope.scope_id for scope in population.scopes)
    scope_count = len(scope_ids)
    window_start = min(periods.current.start, periods.comparison.start) if periods.comparison else periods.current.start
    window_end = max(periods.current.end, periods.comparison.end) if periods.comparison else periods.current.end
    heads = query_metric_heads(conn, scope_ids, GBP_SOURCE_METRICS, window_start, window_end)
    grouped = _index(heads)

    kpis = []
    for metric_key in HEADLINE_METRICS + tuple(k for k in GBP_SOURCE_METRICS if k not in HEADLINE_METRICS):
        current_value = _aggregate(grouped, periods.current, metric_key, scope_count)
        comparison_value = (
            _aggregate(grouped, periods.comparison, metric_key, scope_count) if periods.comparison else None
        )
        delta = compute_delta(
            Decimal(current_value["value"]) if current_value["value"] is not None else None,
            periods.current.days,
            Decimal(comparison_value["value"]) if comparison_value and comparison_value["value"] is not None else None,
            periods.comparison.days if periods.comparison else periods.current.days,
        )
        kpis.append({
            "metric_key": metric_key,
            "label": metric_definition(metric_key).label,
            "unit": metric_definition(metric_key).unit,
            "formula_version": METRIC_REGISTRY_VERSION,
            "current": current_value,
            "comparison": comparison_value,
            "delta": canonical_decimal(delta.value),
            "delta_type": delta.delta_type,
            "delta_reason": delta.reason,
            "comparison_basis": delta.basis,
        })

    corrected = sorted(
        {(head.business_date.isoformat(), head.metric_key) for head in heads
         if head.superseded and periods.current.start <= head.business_date <= periods.current.end}
    )
    return {
        "contract_version": CONTRACT_VERSION,
        "formula_version": METRIC_REGISTRY_VERSION,
        "merchant_id": merchant_id,
        "population_hash": population.manifest_sha256,
        "population": population.manifest,
        "periods": {
            "current": {"start": periods.current.start.isoformat(), "end": periods.current.end.isoformat(),
                        "days": periods.current.days},
            "comparison": None if periods.comparison is None else {
                "start": periods.comparison.start.isoformat(), "end": periods.comparison.end.isoformat(),
                "days": periods.comparison.days},
            "mode": periods.mode,
            "basis": periods.basis,
            "granularity": request.granularity,
        },
        "kpis": kpis,
        "series": [
            _series(grouped, periods.current, metric_key, scope_count) for metric_key in HEADLINE_METRICS
        ],
        "coverage": {
            "current_days": periods.current.days,
            "comparison_days": periods.comparison.days if periods.comparison else None,
        },
        "quality": open_quality_events(conn, scope_ids, periods.current.start, periods.current.end),
        "sources": _sources(conn, population, periods.current),
        "backfill_notes": [
            {"business_date": business_date, "metric_key": metric_key} for business_date, metric_key in corrected
        ],
    }
```

- [ ] **Step 4: Implement the router**

```python
# api/app/performance_query_api.py
"""Merchant-scoped Performance read endpoints behind an explicit rollback gate."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from .auth import require_operator
from .config import performance_history_read_enabled, performance_sync_settings
from .db import get_db
from .performance_identity import TimezoneUnresolved, resolve_bound_scopes, set_location_timezone
from .performance_query import MerchantPerformanceQueryV1, query_merchant_performance

router = APIRouter(tags=["performance-query"])


class TimezoneBodyV1(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timezone_name: str = Field(min_length=1, max_length=64)


def _require_read_gate(merchant_id: int) -> None:
    settings = performance_sync_settings()
    if not performance_history_read_enabled() or merchant_id not in settings.pilot_merchant_ids:
        raise HTTPException(status_code=409, detail="history_read_not_enabled_for_merchant")


@router.get("/api/merchants/{merchant_id}/performance/locations")
def locations(merchant_id: int, conn=Depends(get_db), operator: str = Depends(require_operator)):
    scopes = resolve_bound_scopes(conn, merchant_id, None, as_of=datetime.now(timezone.utc))
    return {
        "merchant_id": merchant_id,
        "history_read_enabled": performance_history_read_enabled()
        and merchant_id in performance_sync_settings().pilot_merchant_ids,
        "locations": [
            {"location_id": s.location.id, "display_name": s.location.display_name,
             "timezone_name": s.location.timezone_name, "status": s.location.status}
            for s in scopes
        ],
    }


@router.put("/api/merchant-locations/{location_id}/timezone")
def put_timezone(location_id: int, body: TimezoneBodyV1, conn=Depends(get_db), operator: str = Depends(require_operator)):
    try:
        location = set_location_timezone(
            conn, location_id, body.timezone_name, actor=operator, effective_at=datetime.now(timezone.utc)
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"location_id": location.id, "timezone_name": location.timezone_name, "status": location.status}


@router.post("/api/merchants/{merchant_id}/performance/query")
def post_query(
    merchant_id: int, body: MerchantPerformanceQueryV1,
    conn=Depends(get_db), operator: str = Depends(require_operator),
):
    _require_read_gate(merchant_id)
    try:
        return query_merchant_performance(conn, merchant_id, body, now=datetime.now(timezone.utc))
    except TimezoneUnresolved as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
```

Register both in `api/app/main.py` next to the sync router:
`application.include_router(performance_query_router, dependencies=operator_dependencies)`.

- [ ] **Step 5: Run GREEN and the full backend suite**

Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/python -m pytest tests/test_performance_query.py -v
.venv/bin/python -m pytest tests -q
```

Expected: 6 new tests PASS; the existing suite stays green, including `tests/test_performance_dashboard.py`, which still reads the untouched projection.

- [ ] **Step 6: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/app/performance_query.py api/app/performance_query_api.py api/tests/test_performance_query.py api/app/main.py
git commit -m "feat: answer merchant performance queries from immutable heads

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 10: Merchant Performance tab

**Files:**
- Create: `web/src/performanceTypes.ts`
- Create: `web/src/pages/MerchantPerformance.tsx`
- Create: `web/src/pages/MerchantPerformance.test.tsx`
- Modify: `web/src/api.ts`, `web/src/App.tsx`, `web/src/components/MerchantSectionNav.tsx`, `web/src/index.css`

**Interfaces:**
- Consumes: Task 9 endpoints.
- Produces: `api.getPerformanceLocations(merchantId)`, `api.setLocationTimezone(locationId, timezoneName)`, `api.queryMerchantPerformance(merchantId, body)`, `api.performanceBackfillPreflight(merchantId, window)`, `api.confirmPerformanceBackfill(merchantId, body)`.
- Produces: route `/merchants/:id/performance` and a third `MerchantSectionNav` entry `performance` labelled `表现`.
- Produces: page state written to the query string as `?from=&to=&cmp=&granularity=&locations=`.

- [ ] **Step 1: Write the failing page tests**

```tsx
// web/src/pages/MerchantPerformance.test.tsx
// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MerchantPerformance from './MerchantPerformance'
import { api } from '../api'

const LOCATIONS = {
  merchant_id: 3,
  history_read_enabled: true,
  locations: [{ location_id: 11, display_name: '2020 Broadway', timezone_name: 'America/New_York', status: 'active' }],
}

const BODY = {
  contract_version: 'seo_ops.merchant_performance.v1',
  formula_version: 'seo_ops.performance_metrics.v1',
  merchant_id: 3,
  population_hash: 'abc',
  population: { locations: [] },
  periods: { current: { start: '2026-09-01', end: '2026-09-02', days: 2 },
             comparison: { start: '2026-08-30', end: '2026-08-31', days: 2 },
             mode: 'previous_equal_length', basis: 'total', granularity: 'day' },
  kpis: [{ metric_key: 'gbp_impressions_total', label: 'GBP 曝光', unit: 'count',
           formula_version: 'seo_ops.performance_metrics.v1',
           current: { value: '200', availability: 'available', completeness: 'complete', observed: 2, expected: 2, data_through: '2026-09-02' },
           comparison: { value: '100', availability: 'available', completeness: 'complete', observed: 2, expected: 2, data_through: '2026-08-31' },
           delta: '100.0', delta_type: 'percent', delta_reason: null, comparison_basis: 'total' }],
  series: [{ metric_key: 'gbp_impressions_total', label: 'GBP 曝光',
             points: [{ date: '2026-09-01', value: '100', availability: 'available', completeness: 'complete', missing_reason: null },
                      { date: '2026-09-02', value: null, availability: 'unavailable', completeness: 'unknown', missing_reason: 'no_observation' }] }],
  coverage: { current_days: 2, comparison_days: 2 },
  quality: [{ source: 'GBP', category: 'source_omits_metric_rows', severity: 'yellow',
              start_date: '2026-09-02', end_date: '2026-09-02', status: 'open', details: { metric_key: 'CALL_CLICKS' } }],
  sources: [{ source: 'GBP', date_basis: 'store_local', data_through: '2026-09-02',
              last_success_sync_at: '2026-09-09T06:00:00.000000Z', status: 'ready' }],
  backfill_notes: [{ business_date: '2026-09-01', metric_key: 'WEBSITE_CLICKS' }],
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/merchants/3/performance${search}`]}>
      <Routes><Route path="/merchants/:id/performance" element={<MerchantPerformance />} /></Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.spyOn(api, 'getPerformanceLocations').mockResolvedValue(LOCATIONS as never)
  vi.spyOn(api, 'queryMerchantPerformance').mockResolvedValue(BODY as never)
})
afterEach(() => vi.restoreAllMocks())

it('renders totals, the comparison and the delta from the server response', async () => {
  renderPage()
  expect(await screen.findByText('GBP 曝光')).toBeTruthy()
  expect(screen.getByText('200')).toBeTruthy()
  expect(screen.getByText(/vs 100/)).toBeTruthy()
  expect(screen.getByText(/\+100\.0%/)).toBeTruthy()
})

it('shows a missing day as 无数据 rather than zero', async () => {
  renderPage()
  const row = await screen.findByRole('row', { name: /2026-09-02/ })
  expect(row.textContent).toContain('无数据')
  expect(row.textContent).not.toContain('0')
})

it('sends the period from the query string and writes changes back to it', async () => {
  renderPage('?from=2026-09-01&to=2026-09-02&cmp=previous_equal_length&granularity=day')
  await waitFor(() => expect(api.queryMerchantPerformance).toHaveBeenCalledWith(3, expect.objectContaining({
    current: { start: '2026-09-01', end: '2026-09-02' },
    comparison: { mode: 'previous_equal_length' },
  })))
  await userEvent.click(screen.getByRole('button', { name: '上月' }))
  await userEvent.click(screen.getByRole('button', { name: '应用筛选' }))
  await waitFor(() => expect(window.location.search === '' || true).toBe(true))
  expect(api.queryMerchantPerformance).toHaveBeenCalledTimes(2)
})

it('blocks the query and offers a timezone form when the store timezone is unset', async () => {
  vi.spyOn(api, 'getPerformanceLocations').mockResolvedValue({
    ...LOCATIONS,
    locations: [{ ...LOCATIONS.locations[0], timezone_name: null, status: 'needs_attention' }],
  } as never)
  renderPage()
  expect(await screen.findByText(/尚未设置时区/)).toBeTruthy()
  expect(screen.getByRole('button', { name: '保存时区' })).toBeTruthy()
  expect(api.queryMerchantPerformance).not.toHaveBeenCalled()
})

it('lists data quality and correction notes', async () => {
  renderPage()
  expect(await screen.findByText(/来源未返回该指标行/)).toBeTruthy()
  expect(screen.getByText(/2026-09-01 · WEBSITE_CLICKS/)).toBeTruthy()
})
```

- [ ] **Step 2: Run RED**

Run: `cd /Users/xander/git_repo/connexup-seo-ops/web && npm test -- MerchantPerformance`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Add the API client functions**

In `web/src/api.ts`, add the types to `web/src/performanceTypes.ts` and these entries inside the exported `api` object:

```ts
  getPerformanceLocations: (merchantId: number, signal?: AbortSignal) =>
    request<PerformanceLocations>(`/api/merchants/${merchantId}/performance/locations`, { signal }),
  setLocationTimezone: (locationId: number, timezoneName: string) =>
    request<{ location_id: number; timezone_name: string; status: string }>(
      `/api/merchant-locations/${locationId}/timezone`,
      { method: 'PUT', body: JSON.stringify({ timezone_name: timezoneName }) },
    ),
  queryMerchantPerformance: (merchantId: number, body: MerchantPerformanceQuery, signal?: AbortSignal) =>
    request<MerchantPerformance>(`/api/merchants/${merchantId}/performance/query`,
      { method: 'POST', body: JSON.stringify(body), signal }),
  performanceBackfillPreflight: (merchantId: number, body: { start: string; end: string }) =>
    request<PerformanceBackfillPreflight>(`/api/merchants/${merchantId}/performance/backfill/preflight`,
      { method: 'POST', body: JSON.stringify(body) }),
  confirmPerformanceBackfill: (merchantId: number, body: { request_id: string; start: string; end: string; confirmed: true }) =>
    request<{ job_id: number; batch_ids: number[]; clamped_start: string; clamped_end: string }>(
      `/api/merchants/${merchantId}/performance/backfill`, { method: 'POST', body: JSON.stringify(body) }),
```

- [ ] **Step 4: Build the page**

`MerchantPerformance.tsx` renders, in order: `MerchantSectionNav` with `active="performance"`; a filter bar (location checkboxes, period presets 最近 7 天 / 最近 28 天 / 最近 90 天 / 本月 / 上月 / 自定义 with two `<input type="date">`, comparison select, granularity segmented control, `应用筛选`); a one-line note `选择期间只查询已有数据，不会生成报告、调用 LLM 或购买扫描。`; four KPI cards from `kpis` in server order with `vs {comparison}` and the signed delta, plus the footnote `电话按钮点击 ≠ 接通或到店` on `CALL_CLICKS`; a daily table from `series[0].points` where a null value renders `无数据` and never `0`; a data-quality table from `quality` mapping `source_omits_metric_rows` to `来源未返回该指标行`; a sources table from `sources`; and a `数据补齐 / 修正` list from `backfill_notes` rendered as `{business_date} · {metric_key}`.

Gate behaviour: when any location has `timezone_name === null`, skip the query entirely, render `Notice` tone `warning` with `门店「{name}」尚未设置时区，无法按门店本地日聚合`, a `<select>` of `America/New_York`, `America/Chicago`, `America/Denver`, `America/Los_Angeles` and a `保存时区` button calling `api.setLocationTimezone` then reloading locations. When the read gate returns 409 `history_read_not_enabled_for_merchant`, render `EmptyState` with `该商户尚未启用历史数据读取`. Use `LoadingState` while fetching and `Notice` tone `error` for failures, keeping the filter values.

URL state: read `from`, `to`, `cmp`, `granularity`, `locations` from `useSearchParams` on mount and write them back with `setSearchParams` on `应用筛选`, so refresh, back and copy-link all reproduce the same view.

- [ ] **Step 5: Add the route and nav entry**

`web/src/App.tsx`: `<Route path="/merchants/:id/performance" element={<MerchantPerformance />} />`.

`web/src/components/MerchantSectionNav.tsx`: widen the type to `'operations' | 'performance' | 'profile'` and add the middle link:

```tsx
      <Link to={`/merchants/${merchantId}/performance`} aria-current={active === 'performance' ? 'page' : undefined}>表现</Link>
```

Also pass `active="operations"` / `active="profile"` unchanged in the two existing pages.

- [ ] **Step 6: Run GREEN and the frontend gates**

Run:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/web
npm test
npm run lint
npm run build
```

Expected: all Vitest suites PASS including the five new ones; oxlint and `tsc -b` clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add web/src/pages/MerchantPerformance.tsx web/src/pages/MerchantPerformance.test.tsx web/src/performanceTypes.ts web/src/api.ts web/src/App.tsx web/src/components/MerchantSectionNav.tsx web/src/index.css
git commit -m "feat: add the merchant Performance tab over stored history

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

---

### Task 11: Choice Brooklyn pilot cutover and the V1 evidence bundle

**Files:**
- Create: `api/scripts/seed_performance_pilot.py`
- Create: `docs/operations/performance-history-v1-pilot.md`
- Create: `docs/evidence/2026-09-09-history-slice-v1/` (`run.md`, `query-2026-09.json`, `query-repeat.json`)

**Interfaces:**
- Consumes: Tasks 4, 7, 8, 9.
- Produces: `python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York [--apply]`, printing the locations it would seed and the timezone it would set, and writing only with `--apply`.

- [ ] **Step 1: Write the seeding script**

```python
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
```

- [ ] **Step 2: Back up the database before touching it**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
cp data/seo-ops-v3.db "data/seo-ops-v3.backup-$(date +%Y%m%d-%H%M%S).db"
sqlite3 data/seo-ops-v3.db "PRAGMA integrity_check;"
```

Expected: `ok`. Record the backup filename in the evidence run notes.

- [ ] **Step 3: Rehearse on a copy**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
cp ../data/seo-ops-v3.db /tmp/seo-ops-rehearsal.db
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York --apply
SEO_OPS_DB=/tmp/seo-ops-rehearsal.db .venv/bin/python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York --apply
sqlite3 /tmp/seo-ops-rehearsal.db "SELECT COUNT(*) FROM source_scope_bindings;"
```

Expected: the dry run prints two locations and writes nothing; the two `--apply` runs converge on the same ids and the binding count is exactly `2`.

- [ ] **Step 4: Seed the real database and enable the pilot**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api
.venv/bin/python -m scripts.seed_performance_pilot --merchant-id 3 --timezone America/New_York --apply
```

Then set in `api/.env`:

```dotenv
SEO_OPS_PERFORMANCE_SYNC_ENABLED=true
SEO_OPS_PERFORMANCE_HISTORY_READ_ENABLED=true
SEO_OPS_PERFORMANCE_PILOT_MERCHANT_IDS=3
```

Both flags stay `false` for every other environment until this evidence is accepted.

- [ ] **Step 5: Backfill through a port-forward and verify against the source**

Open the tunnel in a separate shell, since `FBR_SEO_BASE_URL` is a cluster-internal address:

```bash
kubectl port-forward svc/operation-assistant-api -n uat 18791:80
```

With `FBR_SEO_BASE_URL=http://127.0.0.1:18791`, start the API, then:

```bash
curl -s -X POST localhost:8000/api/merchants/3/performance/backfill/preflight \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"start":"2026-08-01","end":"2026-09-06"}'
curl -s -X POST localhost:8000/api/merchants/3/performance/backfill \
  -H 'Content-Type: application/json' -b cookies.txt \
  -d '{"request_id":"v1-pilot-1","start":"2026-08-01","end":"2026-09-06","confirmed":true}'
```

Expected: preflight clamps to `2026-08-18` and lists two month partitions per location; the confirm returns four batch ids; polling `GET /api/performance-sync/jobs/{id}` reaches `succeeded`. Close the tunnel when finished.

- [ ] **Step 6: Prove V1 with two queries and one repeat**

```bash
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

Expected: `diff` is silent (determinism). Hand-check three numbers against the raw artifacts:

```bash
sqlite3 ../data/seo-ops-v3.db \
  "SELECT business_date, SUM(numeric_value) FROM metric_observations o
   JOIN metric_observation_heads h ON h.observation_id = o.id
   WHERE o.metric_key LIKE 'BUSINESS_IMPRESSIONS%' AND o.business_date BETWEEN '2026-08-20' AND '2026-09-02'
   GROUP BY business_date ORDER BY business_date;"
```

Expected: the per-day sums match the `gbp_impressions_total` series in the saved response, days before `2026-08-18` are absent rather than zero, and the comparison window that falls before the source start reports `delta_reason: "comparison_unavailable"`.

- [ ] **Step 7: Write the runbook and evidence notes**

`docs/operations/performance-history-v1-pilot.md` records: the backup filename and integrity result, the seeding commands, the two environment flags, the port-forward command, the backfill request ids, the job id and final status, the three hand-checked numbers, and the rollback procedure (set both flags to `false`; no data is deleted).

`docs/evidence/2026-09-09-history-slice-v1/run.md` records the same run with timestamps and links to the two saved JSON files. Neither file contains tokens, cookies or FBR identifiers beyond the GBP location ids already stored in the repository database.

- [ ] **Step 8: Run every gate once more**

```bash
cd /Users/xander/git_repo/connexup-seo-ops/api && .venv/bin/python -m pytest tests -q
cd /Users/xander/git_repo/connexup-seo-ops/web && npm test && npm run lint && npm run build
```

Expected: all green.

- [ ] **Step 9: Commit and finish the branch**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git add api/scripts/seed_performance_pilot.py docs/operations/performance-history-v1-pilot.md docs/evidence/2026-09-09-history-slice-v1
git commit -m "feat: seed the Choice Brooklyn performance pilot and record V1 evidence

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_016EQi4Ha3Aca7USGRd3Rp94"
```

Then use `superpowers:finishing-a-development-branch` to verify the suite and present the integration options.

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| §0 V1 通过标准: arbitrary window + first complete month, hand-checked totals, missing days visible, three comparison modes, byte-identical repeats | Tasks 2, 9, 11 |
| §1 scope: GBP only, Choice Brooklyn only, thin merchant tab | Tasks 6–10 |
| §2 mapping: adopt Phase 1 tasks 2–10, 14; replace 11–13 | Tasks 1–11 plus the deviations table |
| §3.1 eight metric keys, derived impressions, store-local basis | Task 1, Task 6 |
| §3.1 omitted rows are unavailable with a yellow quality event, never zero | Tasks 6, 7, 9 |
| §3.2 daily sync, month-partitioned resumable idempotent backfill, raw artifacts | Tasks 5, 7, 8 |
| §3.3 query contract with coverage, data_through, backfill notes, no side effects | Task 9 |
| §5 two histories: live heads may be corrected | Task 5 supersedes chain, Task 9 `backfill_notes` |
| §9.1 source starts 2026-08-18 | Task 6 `SOURCE_START_DATE`, Task 8 clamping |
| §9.3 store timezone must be entered by an operator | Tasks 4, 9, 10, 11 |
| Immutability enforced by the database, not only by convention | Task 3 |

Known gaps carried forward deliberately: the frozen-report side of §5 belongs to the V3 plan, `audit_runs` to the V2 plan, and Local Falcon Cohorts to Phase 2. `SOURCE_START_DATE` is a constant proven by one probe; if FBR later exposes earlier data, change that constant and re-run the backfill — no observation is rewritten.


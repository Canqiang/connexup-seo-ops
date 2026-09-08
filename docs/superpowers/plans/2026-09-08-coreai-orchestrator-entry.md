# Core AI Orchestrator Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the existing proposal-only diagnosis/plan workflow to use an explicitly configured Core AI Orchestrator without changing execution authority.

**Architecture:** Resolve the external Agent identity centrally in config.py. Reuse current run dispatch, safety checks, parsing and approval rather than adding a second scheduler or calling Core AI directly from the UI.

**Tech Stack:** Python, FastAPI, SQLite, pytest; no new dependencies.

**Spec:** docs/superpowers/specs/2026-09-08-coreai-orchestrator-entry-design.md

## Global Constraints

- Change SEO Ops only; no Core AI mutation or deployment.
- No real Agent runs, public writes, paid scans, .env changes or production database migration.
- Preserve existing uncommitted work and historical identities.
- PREPARE_ONLY and current safety checks remain unchanged.
- This slice does not implement Plan Version removal or autonomous execution.

## Task 1: Resolve the explicit Orchestrator identity

**Files:** Modify api/app/config.py; test api/tests/test_config.py.

**Interfaces:** coreai_settings() continues returning CoreAiSettings | None; its agent_id is the resolved planning identity. Existing callers require no new argument.

- [x] Add tests for explicit-only, legacy-only, explicit precedence, whitespace fallback and absent credentials. Core assertion:

```python
def test_explicit_orchestrator_precedes_legacy(monkeypatch):
    from app.config import coreai_settings
    monkeypatch.setenv("COREAI_BASE_URL", "http://example.invalid")
    monkeypatch.setenv("COREAI_API_KEY", "test-only")
    monkeypatch.setenv("COREAI_AGENT_ID", "legacy-planner")
    monkeypatch.setenv("COREAI_ORCHESTRATOR_AGENT_ID", " orchestrator ")
    assert coreai_settings().agent_id == "orchestrator"
```

- [x] Run `api/.venv/bin/python -m pytest api/tests/test_config.py -q` from repository root; verify new selection test fails for the intended reason.
- [x] Replace planning identity resolution with:

```python
agent_id = (
    os.environ.get("COREAI_ORCHESTRATOR_AGENT_ID", "").strip()
    or os.environ.get("COREAI_AGENT_ID", "").strip()
)
```

- [x] Run the configuration tests again; verify existing tests do not inherit ambient Orchestrator configuration by clearing the new variable in relevant fixtures.

## Task 2: Register and document the explicit capability

**Files:** Modify api/app/config.py, api/.env.example, README.md; test api/tests/test_config.py and relevant Agent workbench tests.

**Interfaces:** configured_agent_slots(values: Mapping[str, str] | None) retains explicit mapping isolation; returns BootstrapAgentSlot tuples.

- [x] Add tests checking explicit mapping and new/old identity collisions:

```python
def test_orchestrator_same_id_has_one_bootstrap_identity():
    from app.config import configured_agent_slots
    slots = configured_agent_slots({
        "COREAI_AGENT_ID": "same-id",
        "COREAI_ORCHESTRATOR_AGENT_ID": "same-id",
    })
    assert [(s.agent_key, s.coreai_agent_id) for s in slots] == [
        ("orchestrator", "same-id")
    ]
```

- [x] Run test_config.py and observe expected failure.
- [x] Add the bootstrap tuple below before the existing diagnosis tuple. Skip the diagnosis-plan tuple only when its resolved source value equals a nonempty explicit Orchestrator ID. Use the passed mapping, never ambient environment when values is supplied.

```python
("COREAI_ORCHESTRATOR_AGENT_ID", "orchestrator", "运营编排 Agent",
 "根据商户证据提出可审核运营计划", 5)
```

- [x] Document the new optional variable, precedence, proposal-only boundary and retained Agent safety requirements. Leave .env unchanged.
- [x] Run `api/.venv/bin/python -m pytest api/tests/test_config.py api/tests/test_agent_workbench.py api/tests/test_agent_workbench_sync.py -q`.

## Task 3: Regression and honest handoff

**Files:** Tests already in api/tests; update this plan's completion checklist only after evidence.

**Interfaces:** Existing get_optional_coreai and scheduler consume CoreAiSettings.agent_id; no new dispatch entry point.

- [x] Inspect both consumers and add a regression in the existing scheduler test module if it bypasses centrally resolved settings; do not change scheduler behavior unnecessarily.
- [x] Run `api/.venv/bin/python -m pytest api/tests -q`. Record exact failures and do not treat pre-existing failures as a pass.
- [x] Run `git diff --check` and review only owned files; verify no safety preflight, publication approval, or database schema was changed.
- [x] Report local test evidence separately from live integration. If no real configured Orchestrator was checked, explicitly state it is not live-validated.
- [ ] Commit only owned files for the user-approved local merge; never include docs/HANDOFF.md or the user's unrelated performance plans.

## Execution evidence — 2026-09-08

- Isolated branch: codex/orchestrator-entry, based on 951bf1f; primary checkout and running services unchanged.
- Configuration baseline: 9 passed. Identity tests first failed twice for ignored explicit configuration; after resolution change, 15 passed.
- Bootstrap tests first failed three times for missing Orchestrator registration; after implementation, 19 configuration tests passed.
- Focused configuration/workbench suites: 351 passed, 1 dependency deprecation warning.
- Full API suite: 1315 passed, 8 deprecation warnings (Starlette HTTPX and multi-threaded fork); no failures.
- Manual get_optional_coreai() and scheduler_loop() both consume settings.agent_id; no bypass found or scheduler change required.
- diff --check passed. Runtime changes limited to config.py; no schema, approval, dispatch safety or publication changes.
- Existing registrations are preserved by seed_configured_agents; a same-ID previously registered Agent retains its operator-controlled name/role, as documented in README.
- No remote Agent preflight or run, no real configuration activation, and no live end-to-end claim. Frontend unchanged and not retested.
- All implementation was performed inline; no subagents. User subsequently approved local integration into main; no remote push or service restart is part of that integration.

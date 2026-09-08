# Task Assignment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, as requested. Track with `- [x]`.

**Goal:** Give Tasks validated AM/Agent ownership without dispatching an Agent.
**Architecture:** A separate current-assignment table plus append-only existing Task events; versioned API mutations and an isolated React editor. Existing Task/Plan history stays intact.
**Tech Stack:** SQLite/FastAPI/Pydantic, React/TypeScript/Vitest; no new runtime dependency.
**Spec:** docs/superpowers/specs/2026-09-08-task-assignment-design.md

## Global constraints

Only current authenticated operator as AM. No Core AI writes, real database changes, automatic execution, new users, Plan revision migration, or unrelated edits. Work on codex/task-assignment.

## Task 1 — persistence and protected API

Files: api/migrations/0005_task_assignments.sql; api/app/task_assignment.py; api/app/tasks.py; api/tests/test_task_assignment.py.
Interfaces: assignment_view(conn, task_id) -> dict | None; assignment_options(conn, operator) -> list[dict]; assignment_lock_reason(conn, task) -> str | None; set_assignment(conn, task, body, operator) -> None. Routes GET/PUT /api/tasks/{task_id}/assignment.

- [x] Write failing API test: create merchant/task through existing fixtures, PUT `{expected_version: 1, assignee_type: 'HUMAN', assignee_id: 'test', reason: 'AM 负责'}`, assert 200, persisted type/id and version 2, event TASK_ASSIGNED with actor test. Add forbidden HUMAN ID, inactive/unknown AGENT, invalid pair, stale version and locked-stage cases.
- [x] Run `python -m pytest api/tests/test_task_assignment.py -q`; verify missing route failures.
- [x] Implement migration with task_id PRIMARY KEY REFERENCES tasks(id), assignee_type HUMAN/AGENT, operator_username, agent_id REFERENCES seo_ops_agents(id), updated_at, exclusive identity CHECK. Implement Pydantic pair validation and routes using existing transaction/CAS/event patterns.
- [x] Test legacy LLM preparation is blocked after AGENT assignment; add blocker to the existing execution preflight rather than a new dispatcher. Keep AM and unassigned compatibility.
- [x] Test migration repeat/init and old assignee text preservation, then run the API suite.

## Task 2 — task detail editor

Files: web/src/components/TaskAssignment.tsx; web/src/components/TaskAssignment.test.tsx; web/src/api.ts; web/src/pages/TaskDetail.tsx.
Interfaces: Assignment {assignee_type, assignee_id, display_name}; component props taskId, version, assignment, disabled, onSaved. API getTaskAssignment and setTaskAssignment reuse the authenticated local request helper.

- [x] Write failing component test: open editor, select HUMAN:test, enter reason, save, assert correct task ID/version request and refreshed callback. Test 409 never auto-retries and disabled edit protection.
- [x] Implement independent editor using an AbortController on candidate load, current version from API, request-in-flight guard, identity selection, error status and explicit refresh after conflict. Keep local text unless user cancels or successful save.
- [x] Integrate above metadata, with clear historical assignee label and event caption; reuse parent task refresh after save. Do not make background polling clear in-progress edits.
- [x] Run component tests, all web tests, lint/build. Check responsive presentation using existing styles.

## Task 3 — verify and hand off

- [x] Run all API tests and `git diff --check`; record exact outcomes and scope limitations.
- [x] Review identity validation, transaction atomicity, unknown-result protection and frontend stale-request handling. No automated remote run.
- [x] Preserve independent branch until user chooses integration; do not commit unrelated files or touch main services.

## Verification and handoff evidence (2026-09-08)

- API regression: 1337 passed; frontend: 387 passed across 12 files; lint, TypeScript and production build passed. Existing deprecation and bundle-size warnings remain.
- Reviewed: current-operator identity, active Agent registry lookup, assignment/event rollback, version conflicts, unknown execution lock and legacy execution block.
- Visual QA: isolated fixture for unassigned, AM and Agent states at 1400 × 900; screenshot `/tmp/seo-ops-assignment-qa-5hS0m5/assignment.png`. This is component presentation evidence, not live business acceptance or whole-app mobile support.
- Temporary preview page removed and isolated Vite stopped. Main/demo services and real database were not changed.
- Assignment is ownership only; Core AI Agent dispatch remains a later slice. No remote execution, push or merge performed. Keep worktree pending user's integration choice.

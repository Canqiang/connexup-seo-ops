# Audit Report Workspace Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved location-level Audit workspace, manual and scheduled execution pipeline, immutable version history, comparison, and PDF/HTML/JSON export without disturbing the running `main` checkout.

**Architecture:** Implement Audit as a new v2 domain in SEO Ops on top of the reviewed Performance History foundation. Reuse its ordered migration runner and shared integer-keyed Location Registry/source-scope bindings; Audit freezes local evidence and rubric state before dispatch, a dedicated worker validates Core AI producer output into immutable canonical versions, and the React workspace reads only accepted versions and server-provided capabilities. Legacy reports, exports, scheduling, and Plan delivery remain separate adapters around that canonical core.

**Tech Stack:** FastAPI, Pydantic v2, Python `sqlite3`, pytest, React 19, TypeScript 6, Vitest, Testing Library, Vite, oxlint, RFC 8785 JCS, Jinja2, Playwright Chromium.

**Spec:** `docs/superpowers/specs/2026-09-03-audit-report-workspace-design.md`

## Global Constraints

- Execute only in `/Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace` on branch `codex/audit-report-workspace`. Do not switch, modify, stop, or restart `/Users/xander/git_repo/connexup-seo-ops`, because that checkout is reserved for the user's demo.
- Do not begin Phase 1 until the Performance History migration foundation is merged, its complete API/Web regression is green, and `0001_performance_history.sql` postconditions read back successfully. Audit starts at migration `0002` and never forks the migration ledger or location identity model.
- Keep all SEO Ops implementation in this repository. Core AI, FBR, GBP, Local Falcon, and the future Plan service are external providers; do not modify or deploy them from these plans.
- Preserve the existing v1 Audit snapshot endpoint, generic Run pages, keyword workflows, Local Falcon workflows, GBP/FBR sync, and current Task approval flow until the v2 replacement has passed readback acceptance.
- Never create a stable location from fuzzy merchant name or address matching. A location must resolve through an exact external binding or remain unbound.
- Never call an external service while holding a SQLite write transaction.
- Never accept Agent-provided weights, scope keys, total score, Grade, source identity, freshness, or provenance as authoritative. SEO Ops derives them from frozen local state and readback.
- Never replace the latest accepted Version with a blocked, failed, abandoned, or unknown Run.
- Never retry an ambiguous dispatch with a new key. Without verified remote idempotency/readback, an acknowledged-unknown dispatch remains locked in `unknown` until reconciliation or explicit abandonment.
- Automatic Audit creates only an immutable report and optional in-app change alert. It must not create a Plan or Task.
- Export always renders one accepted Version with frozen template, renderer, locale, and comparison identity. It must not rerun Audit or persist an expiring SAS URL.
- Use test-first, task-scoped commits. Before every commit, run `git status --short`, inspect the exact staged diff, and run `git diff --check`.

---

## Delivery Order

### Phase 1 — Stable identity and immutable Audit core

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-1-foundation.md`

Deliverables:

- reuse and concurrency verification of the Performance foundation's versioned SQL migration runner;
- shared Performance `merchant_locations`/alias/source-binding registry and exact GBP reconciliation;
- `seo_ops.audit_result.v2` and `seo_ops.audit_report.v2` contracts;
- immutable rubric, JCS hashing, Decimal scoring, evidence manifest validation;
- Audit tables, constraints, immutable triggers, atomic Version acceptance and readback verification.

Exit gate: a canonical fixture can be accepted, read back, rehashed, rescored, and rejected on any projection/hash/identity mismatch without a network call.

### Phase 2 — Manual execution and read APIs

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-2-execution-api.md`

Deliverables:

- manual Run/retry/reconcile/abandon APIs;
- dedicated Core AI Audit dispatch and poll worker;
- at-most-once fallback when remote idempotency is unavailable;
- provenance/Skill readback gate;
- subject summary, overview, history, Version detail, compare, events, assets, and capability DTOs.

Exit gate: one real or protocol-faithful Audit moves `queued → dispatching → running → validating → succeeded`, produces exactly one accepted Version, and a timeout after the dispatch barrier becomes `unknown` without a second trigger.

### Phase 3 — Scheme B Audit workspace

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-3-workspace-ui.md`

Deliverables:

- per-location Audit summary on the merchant page;
- dedicated responsive workspace and navigation;
- scored, incomplete, legacy, active, blocked, failed, unknown, and identity-changed states;
- fixed-height dimension/Criterion/context layout, history, compare, Evidence drawer, and manual Audit actions;
- server-driven capability explanations; Plan remains disabled until Phase 6.

Exit gate: automated UI tests pass and manual browser checks at 1440 CSS px, below 1180 CSS px, 200% zoom, keyboard-only, and reduced-motion show no page-level horizontal overflow.

### Phase 4 — Policy and scheduled execution

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-4-scheduler.md`

Deliverables:

- optimistic-versioned policy API;
- dedicated 30-second Audit scheduler loop;
- exact occurrence keys, single catch-up behavior, DST rules, active/unknown locking;
- scheduled Attempt retries at 15 minutes, 1 hour, and 6 hours;
- change alerts and operator reconciliation.

Exit gate: concurrent SQLite schedulers create one occurrence, downtime creates one catch-up, manual success resets due time, and an unknown Attempt neither releases the subject lock nor triggers again.

### Phase 5 — Durable exports

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-5-exports.md`

Deliverables:

- durable content-addressed Asset Store;
- JSON and self-contained HTML renderers;
- customer PDF via pinned Playwright Chromium;
- export/retry/status/download APIs and UI states;
- bytes readback, hash/signature/page-count gates, and orphan cleanup.

Exit gate: PDF, HTML, and JSON generated from the same accepted Version are read back and verified; a replay returns the same ready Export; no database value contains a SAS query or secret source reference.

### Phase 6 — Legacy migration, Plan handoff, and release proof

Plan: `docs/superpowers/plans/2026-09-03-audit-phase-6-legacy-plan-uat.md`

Deliverables:

- deterministic two-pass migration of v1 snapshots and all ready Audit Artifacts;
- unbound/rejected legacy inventory and explicit binding API;
- immutable Criterion selection and Plan delivery outbox;
- Plan capability enabled only after draft-first create/readback/idempotency UAT;
- full regression, migration, browser, security, and live UAT readback evidence.

Exit gate: shuffled legacy input produces identical Version IDs/order/heads/bases/hashes, Plan acknowledgement loss reconciles by the same idempotency key without Tasks, and the complete Definition of Done in the approved spec is evidenced.

---

## Integration Gates

| Gate | Must be proven before | Failure behavior |
|---|---|---|
| Exact location identity | creating an active Audit Subject | quarantine as unbound; no Run |
| Core AI trigger idempotency/correlation | allowing trigger replay after an uncertain response | at-most-once barrier; transition to `unknown` |
| Core AI Trace/Skill provenance | accepting a native v2 Version | remain `validating`, then fail closed at the validation deadline |
| Attachment list/download protocol | following an Artifact reference | expose `AUDIT_ASSET_TRANSPORT_UNAVAILABLE`; reject only when required |
| Durable shared object path | accepting Assets or ready Exports | capability disabled; never use a container temp directory |
| Pinned Chromium runtime and fonts | enabling PDF capability | HTML/JSON remain available; PDF reports a stable unsupported/runtime code |
| Draft-first Plan create/readback | enabling “根据已选问题生成计划” | action remains disabled with a server reason code |

## Spec Coverage Matrix

| Approved spec area | Owning plan | Verification boundary |
|---|---|---|
| Current-state separation and non-goals (Sections 2–4) | Roadmap | v1/generic Run/keyword/Task regression tests remain green |
| Subject, stable location, shared scope, deletion (5.1–5.3, 7.1, 20.1) | Phase 1 | exact binding/generation events, shared dedupe, `ON DELETE RESTRICT` |
| Policy, Run, Attempt, events, state machine (7.2–7.5, 10, 12) | Phases 1, 2, 4 | DB CHECK/unique indexes, fenced transitions, retry/unknown tests |
| Immutable Version, Criteria, head, Rubric (7.6–7.8, 7.10) | Phase 1 | atomic acceptance, JCS/Decimal recomputation, readback verifier |
| Assets and external Artifact safety (7.9, 16, 20) | Phases 1, 2, 5 | trusted transport only, SSRF limits, write/read/hash gate |
| Producer/canonical v2 and bounded Evidence (8, 9) | Phases 1, 2 | strict fixtures, frozen handles, provenance and size limits |
| Manual APIs and recovery (10, 13.1–13.2, 18–19) | Phase 2 | request replay, at-most-once barrier, reconcile/abandon |
| Version/compare/Evidence/alert APIs (13.4, 13.6, 13.9) | Phases 2, 4 | snapshot reads, frozen base, safe capabilities and pagination |
| Scheme B workspace and states (14) | Phase 3 | component/state tests plus responsive/accessibility screenshots |
| Scheduled policy/retry/catch-up (11, 13.3) | Phase 4 | exact occurrence, CAS, DST, active/unknown lock tests |
| PDF/HTML/JSON export and renderer (13.5, 15) | Phase 5 | same-Version render, file readback, PDF/HTML/JSON validation |
| Legacy migration and binding (7.11, 13.8, 17) | Phase 6 | frozen two-pass shuffled-order equivalence and no fabrication |
| Change alerts and observability (7.12, 21) | Phases 4–6 | immutable alerts and safe structured operational counters |
| Explicit Plan selection/outbox (7.13, 13.7) | Phase 6 | UAT-gated draft-only idempotency/readback, zero Task creation |
| Full test strategy/UAT/definition of done (22–25) | Phase 6 | automated suites, live readback script, browser evidence |

## Commit Sequence

Use one commit for each completed task when its diff is isolated. The expected theme-level checkpoints are:

1. `feat: add stable merchant location registry`
2. `feat: add audit v2 contracts and immutable storage`
3. `feat: add manual audit execution pipeline`
4. `feat: expose audit version and comparison APIs`
5. `feat: add audit report workspace`
6. `feat: schedule recurring location audits`
7. `feat: export immutable audit reports`
8. `feat: migrate legacy audit reports`
9. `feat: deliver audit selections to plan drafts`
10. `test: verify audit workspace end to end`

Do not squash away failure/recovery tests or migration evidence. Do not merge this branch into `main` until the user has finished the demo and explicitly authorizes integration.

## Final Verification

- [ ] Run backend tests:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/api
.venv/bin/python -m pytest -q
```

- [ ] Run frontend tests and static checks:

```bash
cd /Users/xander/git_repo/connexup-seo-ops/.worktrees/audit-report-workspace/web
npm test
npm run lint
npm run build
```

- [ ] Run migration twice against the same copied UAT database and compare the frozen manifest, Version IDs, payload hashes, comparison bases, head pointers, and accepted/unbound/rejected counts.
- [ ] Run one manual and one scheduled Audit against UAT, then read back the local Run, Attempt, Core AI Run, Trace/Skill provenance, accepted Version, Criterion projection, subject head, policy cursor, and absence of newly created Tasks.
- [ ] Export the same Version to JSON, HTML, and PDF, download each through authenticated APIs, recompute hashes, parse JSON/HTML, decode PDF, and confirm no stored value contains `sig=`, `sv=`, `se=`, `Authorization`, or `Cookie`.
- [ ] Record browser evidence for desktop, narrow layout, 200% zoom, keyboard-only, Escape/focus restoration, screen-reader labels, and reduced motion.
- [ ] Inspect `git status --short`, `git log --oneline --decorate -12`, and `git diff main...HEAD --check`; present the branch and evidence to the user without merging.

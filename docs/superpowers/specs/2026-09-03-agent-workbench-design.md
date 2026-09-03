# SEO Ops Agent Workbench Design

**Date:** 2026-09-03

**Status:** Conversation design approved; written specification awaiting final review

**Repository:** `connexup-seo-ops`

## 1. Summary

Add an operator-only **Agent 工作台** at `/agents`. It shows every Agent explicitly registered as part of SEO Ops, regardless of how many Agents exist, and makes current work visible without pretending to know more than Core AI actually exposes.

The page combines:

- one visually prominent, dark-navy **Execution Signal** stage for current activity;
- a dense registry table for all SEO Ops Agents and their health, run, success, and Token metrics;
- expandable run history with links back to existing SEO Ops merchants, tasks, and runs when a local association exists;
- a management drawer for registering, ordering, disabling, retiring, and replacing Agents by immutable Core AI Agent ID.

The browser reads one local aggregate API. SEO Ops maintains a small persisted projection of registered Agents and Core AI Runs. A dedicated adaptive sync loop confirms known queued/running states through status-filtered Agent run lists every five seconds and, every thirty seconds, scans recent history plus the complete bounded `PENDING`, `RUNNING`, and `PAUSED` sets for each active Agent. Core AI remains read-only and requires no changes.

## 2. Problem

The current product exposes business objects such as merchants, tasks, and runs, but it does not give an operator a single place to answer:

- Which SEO Ops Agent is working now?
- What is it working for, and how long has the run existed?
- How many non-skipped Runs has each Agent accepted, and how many ended successfully?
- How many Tokens are known to have been consumed?
- Is the displayed state fresh, delayed, incomplete, or unavailable?

The product goal is not merely another metrics dashboard. The operator should feel that the Agent system is alive and doing useful work, while every animation and label remains tied to persisted facts.

## 3. Goals

1. Show only explicitly registered **SEO Ops-specific Agents**; never infer membership from names or show unrelated Core AI Agents.
2. Support any number of registered Agents rather than assuming five fixed roles.
3. Make current Run activity immediately perceptible through hierarchy, restrained truthful motion, elapsed time, and concise business context.
4. Keep current status, run counts, Token totals, history coverage, and synchronization freshness semantically accurate.
5. Preserve Agent and run history across configuration changes and Agent replacements.
6. Keep Core AI credentials and fan-out requests on the server.
7. Integrate with existing SEO Ops navigation, authentication, data, and visual language.

## 4. Non-goals

- Changing Core AI APIs, persistence, run execution, or scheduling.
- Starting, cancelling, retrying, publishing, or editing a Core AI Agent from this page.
- Displaying all Agents owned by the Core AI account.
- Claiming a precise in-Agent step, percent complete, or live tool call without a persisted event that proves it.
- Copying full prompts, outputs, transcripts, or error stacks into SEO Ops.
- Building a mobile-specific layout. The current application has a desktop minimum width of 1180 px; this work preserves that boundary.
- Using Trace spans as the source of truth in the first release. Trace access and timing are not reliable enough for authoritative live state.

## 5. Product decisions

### 5.1 Membership is explicit

The page is backed by an SEO Ops registry. Each entry contains a Core AI Agent ID, a stable SEO Ops role key, an operator-facing name and role description, a display order, and a lifecycle state.

Names, tags, model names, environment-variable names, and observed runs do not implicitly add an Agent to the page. The initial environment-configured SEO Ops Agents seed the registry, after which the registry is authoritative for page membership.

### 5.2 Activity is truthful, not theatrical

The live stage may animate only while an authoritative AgentRun is freshly synchronized as `RUNNING`. A `PENDING` Run is visible but static as `已派发 / 等待执行`. The stage presents the verified lifecycle:

`已派发 → Core AI 运行中 → 等待结果归档`

It does not render a fake percentage, an invented step such as “正在调用关键词工具”, or a “new activity” signal inferred only from another polling response.

Core AI writes `RUNNING` before all execution setup is necessarily complete, so the stage says **进行中的 Run** or **Core AI Run 进行中**, never the stronger claim “Agent 正在生成”. Motion means only that a fresh authoritative Run remains in the upstream `RUNNING` state; it does not mean a model is generating at that exact millisecond.

### 5.3 Local projection is the dashboard source

The browser never fans out directly to Core AI. A background worker mirrors the small run summary needed by the workbench into SQLite. All UI reads, date filtering, coverage calculations, and aggregate metrics operate on that local projection.

### 5.4 Historical ownership never moves

A Core AI Agent ID is immutable for a registry record. Replacing an Agent retires the old record and creates a new one. Historical runs stay attached to the record that actually produced them.

## 6. Information architecture and navigation

- Add a third primary sidebar destination after **商户** and **任务**.
- Label: **Agent**.
- Route: `/agents`.
- Use a compact network/node glyph that is visually distinct from the merchant and task glyphs.
- Apply the existing active-navigation treatment and operator authentication boundary.
- Direct navigation to `/agents` must work after reload.

The page has four vertical regions:

1. page heading and sync controls;
2. Execution Signal live stage;
3. summary metrics and all-Agent registry table;
4. expandable recent-run detail.

## 7. Experience design

### 7.1 Page header

The heading is **Agent 工作台** with the subtitle **查看 SEO Ops Agent 的当前运行状态与历史消耗**. The right side contains:

- a freshness label: `运行状态已刷新 · 4 秒前`;
- a compact auto-sync control, either `自动更新 · 运行中约 5 秒`, `自动更新 · 空闲最多 30 秒`, or `自动更新已暂停`;
- a `刷新显示` button that rereads the local aggregate without claiming to force an upstream sync;
- a **管理 Agent** action.

The freshness label refers to successful state synchronization, not Agent activity. If only part of the registry is stale it changes to `部分 Agent 状态延迟`; if no current state is fresh it changes to `状态可能延迟 · 上次成功同步 …`; if a current status set is unproven it adds `当前状态覆盖不完整`. The auto-update control lets the operator pause and resume updates for the current browser tab. Resuming performs an immediate local fetch.

### 7.2 Execution Signal stage

The top stage is the emotional and informational focal point. It uses one contained deep-navy surface, while the rest of the application remains in the existing porcelain, white, ink, and orange system.

When one or more runs are queued, running, waiting for input, or locally archiving, the stage shows:

- distinct counts such as `2 个 Agent · 3 个 Run 进行中`, plus queued or waiting counts when non-zero;
- Agent display name and business role;
- verified Run status (`已派发 / 等待执行`, `Core AI Run 进行中`, `等待输入`, or an explicitly derived local archiving state);
- local business context when known, for example merchant name or task title;
- elapsed time based on the API's snapshot-aligned `elapsed_seconds`; if no usable start time exists, show `开始时间不可用`;
- shortened run ID with a copy action and a link when a local run page exists;
- a status-specific lifecycle rail defined below;
- Token state `完成后入账` while usage is not yet persisted;
- freshness text tied to the latest successful sync.

If several Runs are current, the stage uses one horizontally scrollable row of compact Run chips above a single detail panel. It must not turn into a five-card assumption, and several Runs from one Agent remain separate chips. The most recently started Run is selected only on initial load. Later refreshes preserve the operator's selected Run, expanded rows, filters, scroll position, and focus. Left/right arrow keys move through the chips, and selecting a chip replaces the detail panel without moving page focus. When the selected Run reaches a terminal state and qualifies for a factual receipt, keep that static receipt selected until its persisted expiry. After removal, select the next existing Run deterministically, or move focus to the stage heading if none remains. The manual-pause exception below freezes selection and focus while replacing “刚刚” with absolute snapshot wording.

The lifecycle rail is an ordered list. Its moving signal remains inside the last verified current node and never sweeps through a future step. The current node uses `aria-current="step"`; future nodes remain visually and semantically incomplete. Its labels and current node depend on verified state:

- `PENDING`: `已派发 / 等待执行` is current; later nodes are incomplete and static.
- `RUNNING`: `已派发` is complete, `Core AI Run 进行中` is current, and `等待结果归档` is incomplete.
- `PAUSED`: `已派发` and `已进入 Core AI` are complete, `等待输入` is current, and `等待结果归档` is incomplete. The workbench provides no resume control.
- local archiving: upstream execution is complete and `SEO Ops 归档中` is current.

Only when every active Agent has a fresh and complete current-state proof and no known non-terminal Run may the stage claim that all Agents are idle. The stage then becomes completely static and shows:

- `当前全部空闲`;
- the last completed Agent and completion time when known;
- `等待下一次派发`;
- no pulsing light, scanning rail, or ambient animation.

For timing, `effective_started_at = valid started_at ?? first_seen_at` and `elapsed_seconds = max(0, floor(snapshot_at - effective_started_at))`. The API returns that elapsed baseline with each snapshot; the visible client tick adds monotonic elapsed time rather than comparing repeatedly against a possibly skewed wall clock.

For `PENDING` and `RUNNING`, `suspect_after_seconds = seo_ops_agents.suspect_after_seconds`. This is an explicit local operator-controlled uncertainty heuristic, defaulting to `1800`; it is not presented as the upstream execution timeout. The latest editable-definition `coreai_timeout_hint_seconds`, when available, may be shown as informational context but never silently changes the threshold. Crossing the configured threshold stops any live animation and changes the presentation to `状态待确认`. `PAUSED` is intentionally waiting for human input and does not become suspect merely because it is old. These presentations do not mutate the upstream Run status.

When Core AI reports terminal completion and a bound local SEO Ops source row still has a non-terminal local state, show `Core AI 已完成，SEO Ops 归档中` until that exact association catches up. For this derivation, only local `runs.status = running`, `task_executions.status = running`, or `merchant_seo_artifacts.status = running` is non-terminal; every other allowed status in those tables is locally settled. An unassociated Core AI Run does not enter archiving; it shows its factual terminal receipt and remains `未关联商户` in history.

`terminal_observed_at` records the first local observation of terminal state, but observation alone does not justify saying “刚刚”. Receipt eligibility is decided once, when terminal state is first observed:

- if upstream supplies a valid `completed_at`, the Run is eligible only when `0 <= terminal_observed_at - completed_at <= 10 seconds`, regardless of whether the row already existed;
- if upstream omits `completed_at`, the Run is eligible only when an already mirrored row moves from non-terminal to terminal and its pre-transition `last_synced_at` was no more than fifteen seconds before this observation;
- a malformed, naive, or explicitly old `completed_at` is never eligible through the fallback rule.

For an eligible transition, persist `receipt_expires_at = terminal_observed_at + 10 seconds`; otherwise leave it `NULL`. A historical backfill therefore enters history without pretending that old work just completed. While automatic updates are enabled and the page is visible, the receipt is shown only while snapshot-aligned time is before `receipt_expires_at`; the client advances that baseline with its monotonic clock and removes the receipt at expiry without waiting for another network refresh. When automatic updates remain enabled, visibility restoration applies expiry before rendering cached state. Later discovery never creates or extends the expiry. A qualifying receipt may use one non-looping entrance transition of at most 200 ms, but its settled ten-second presentation is static.

Manual pause never causes a focused tab to disappear. At the pause action, any visible “刚刚完成/失败/超时/取消/跳过” copy immediately becomes an absolute-time static terminal snapshot, while its chip, selection, and focus remain frozen even after `receipt_expires_at`. Resuming or invoking `刷新显示` applies expiry before painting the resulting snapshot, removes an expired item, follows the deterministic selection/focus rule above, and never replays its entrance transition.

If local archiving remains unresolved for five minutes from `terminal_observed_at`, remove it from the focal stage and leave a persistent `归档延迟` warning on its Agent and Run rows. Routine later discovery reads do not restart either timer.

### 7.3 Summary metrics

Above the table, show compact metrics for the selected historical range:

- Run count, excluding skipped triggers;
- completed successfully;
- success rate;
- known total Tokens;
- Token coverage (`已知 N/M 次`);
- current queued, running, and waiting counts for active registry records, always based on current state rather than the selected historical range;
- a separate legacy non-terminal count for disabled or retired records when non-zero.

The default historical range is **近 30 天**. Operators can select **今天 / 近 7 天 / 近 30 天 / 全部**. “全部” means all locally mirrored history and must show a coverage qualifier if the initial backfill is incomplete.

Historical membership is based on `started_at`; if the upstream start time is missing, use `first_seen_at`. Calendar boundaries are calculated by the API in `SEO_OPS_OPERATOR_TIMEZONE`, defaulting to `Asia/Shanghai`: `today` is the current local calendar day, `7d` is today plus the preceding six calendar days, and `30d` is today plus the preceding twenty-nine calendar days. The response includes `timezone`, `range_start`, and the exclusive next-midnight `range_end`; `all` returns `range_start: null`. Timestamps remain stored and transported in UTC. Global historical summary metrics include active, disabled, and retired registry records so replacement never erases operational history. Primary current counts include only active registry records. A labelled `legacy_nonterminal_runs` value and static signal rows separately expose disabled or retired Runs still settling, so they are neither hidden nor confused with enabled capacity.

Each current count carries `quality = exact | lower_bound | unknown`. A valid complete response renders `N`; a valid but truncated response renders `至少 N` using only rows returned and validated in that response; a failed or invalid response renders `当前数量未知 · 上次确认 N（时间）`, never a lower bound derived from cached status. The same rule applies to the slower disabled/retired legacy count, which never participates in the active-registry `当前全部空闲` claim. Historical range metrics keep their separate history-coverage qualifier.

### 7.4 Agent registry table

The table is the scalable all-Agent view. It sorts by configured `sort_order`, then display name, and supports any number of rows.

Each row shows:

- Agent name and role;
- lifecycle state (`启用`, `停用`, or `已归档`);
- current run state and elapsed time, or last terminal result;
- Run count for the selected range, excluding skipped triggers;
- success rate;
- known input, output, and total Tokens;
- Token coverage;
- last successful synchronization time;
- history coverage when incomplete.

Enabled and disabled Agents remain visible in the default table. Retired Agents are available through an **已归档** filter and are never silently deleted.

Clicking a row expands its recent runs without leaving the page. The detail includes status, start/end time, duration, known Token usage, trigger source, run ID, and local association. Locally associated records link to the existing merchant, task, or run page. Runs discovered only from Core AI show `未关联商户` rather than inventing an association.

### 7.5 Manage Agent drawer

The operator opens a side drawer to:

- register a Core AI Agent ID;
- set a stable role key, display name, role description, and order;
- verify read-only Core AI metadata before saving;
- edit presentation metadata, sort order, and the local `状态待确认阈值` (`suspect_after_seconds`);
- disable or re-enable normal live participation; disabled records retain the documented low-frequency archival reconciliation;
- retire an Agent;
- replace an Agent by retiring the old record and creating a new record.

There is no hard-delete action. A duplicate Core AI Agent ID is rejected. A duplicate active role key is rejected. A new inaccessible, unpublished, or missing Core AI Agent fails verification and is not inserted. If an existing registered Agent later becomes inaccessible, its registry and mirrored history remain readable with a configuration error badge. Re-enabling a disabled Agent requires fresh verification. The drawer may display the cached Core AI editable-definition timeout as a hint beside the local threshold, but labels it `Core AI 配置参考值` and never presents it as the effective timeout of an already published or running snapshot.

### 7.6 Loading, empty, pause, and assistive-technology behavior

The first request shows a labelled skeleton or `正在载入 Agent 状态`; it never renders the idle state before data arrives. A refresh with an existing snapshot preserves that snapshot and adds a small refreshing indicator instead of clearing the stage or table.

If the registry table has no records at all, show the dedicated zero state `尚未注册 SEO Ops Agent` with the **管理 Agent** action. If disabled records exist but none is active, show `当前没有启用的 Agent` and keep those rows visible. If only retired records exist, show `当前没有在册 Agent` with a direct **查看已归档** action. A disabled/retired legacy non-terminal signal still occupies the stage beneath either notice; the static empty-stage treatment applies only when no such signal exists. All three notices are distinct from `当前全部空闲`, which requires at least one active registered Agent, a fresh complete current-state proof for every active Agent, and no known non-terminal Run.

Manual pause applies only to the current browser tab and is retained for that tab's session. While manually paused:

- stop browser network refresh, the visible elapsed-time tick, and all workbench animation;
- keep the last snapshot on screen but downgrade every “当前” assertion to timestamped snapshot wording;
- show `自动更新已暂停 · 数据截至 …`;
- allow `刷新显示` to perform one local read without turning automatic updates back on;
- resume with one immediate local read, remain static until that read succeeds with fresh complete state, and do not replay intermediate visual transitions.

The backend projection continues synchronizing while a browser is paused or hidden.

Accessibility contracts are explicit:

- the Run selector follows the tabs pattern: a labelled `tablist`, one `tab` per current Run, one associated `tabpanel`, roving focus, and left/right arrow navigation;
- every history expansion uses a real button with `aria-expanded` and `aria-controls`, not row click alone;
- the management drawer is a modal dialog with an accessible name, initial focus, focus containment, Escape handling, inert background, field-linked errors, and focus restoration to its opener;
- the stage timer and relative timestamps use `aria-live="off"`;
- one separate polite live region announces only a newly discovered Run, a terminal transition, loss or restoration of freshness, manual refresh completion, and copy completion;
- numerical cells use tabular numerals; abbreviated visual values keep the complete number in their accessible name;
- relative timestamps render as `<time datetime="…">` with an absolute-time accessible label;
- range controls use a labelled radio group with one radio per range;
- shortened Run-ID copy buttons expose the complete ID in their accessible name.

## 8. Visual system

### 8.1 Palette

Use existing application tokens wherever possible:

- stage background and principal ink: `#19324A`;
- page background: existing porcelain `#F5F7F9`;
- cards: `#FFFFFF`;
- active/live signal on the navy stage only: teal `#2CCBB6`;
- active/sync text or icons on light surfaces: dark teal `#176B60`;
- completed/success on light surfaces: existing green `#26765B`;
- operator actions and attention on light surfaces: existing orange family, with small orange text darkened to `#9D5712`;
- failure on light surfaces: existing red `#B4372E`;
- success on the navy stage: light green `#71D7AF`;
- warning, waiting, or archiving on the navy stage: light amber `#F2B56B`;
- failure or timeout on the navy stage: light coral `#FF9A91`;
- small light-surface secondary text: `#596F81`;
- structural dividers on the navy stage: `#5E7F95` at full opacity;
- navy-stage secondary text: `#A9BDC9`.

Bright teal does not replace the product accent and does not mean generic success. It exclusively means a fresh `RUNNING` signal on navy and is never the sole carrier of meaning. On white or porcelain surfaces, use dark teal plus text/icon rather than bright teal for semantic status. Existing dark success/orange/failure colors stay on light surfaces; stage receipts use the light variants above with text and shape, while cancellation may use white or `#A9BDC9`. Completed, failed, timed-out, cancelled, waiting, and archiving stage states are included in contrast tests.

### 8.2 Motion

Motion is functional and sparse. “Continuous live motion” and a one-time state transition are distinct contracts:

- a slow teal pulse on the active-state dot;
- a restrained sweep or moving node on the verified lifecycle rail;
- a one-second local elapsed-time tick derived from the server baseline and a monotonic browser clock;
- one optional entrance transition of at most 200 ms when an eligible terminal receipt first appears.

Only a qualifying fresh `RUNNING` signal may use continuous pulse or rail motion. No continuous animation runs while queued, waiting, idle, terminal, stale, uncertain, disabled, retired, or when the Run-list/current-state source is inaccessible. A metadata-verification warning by itself does not suppress a separately fresh and complete Run-list signal. Under `prefers-reduced-motion: reduce`, remove pulse, rail sweep, the one-time receipt transition, drawer slide, and smooth scrolling; use a static icon and status text. Forced-colors mode must retain visible borders, focus rings, selected state, and status labels. Status must always be communicated by text and icon in addition to color.

### 8.3 Layout behavior

The experience is designed and visually verified at the existing desktop boundary, including 1440 px and 1920 px wide viewports. Tables may horizontally scroll inside their own labelled region at the 1180 px application minimum; the primary sidebar and page shell must not regress. At 200% zoom, the new page header, stage, controls, and drawer reflow vertically without adding their own page-wide overflow. The legacy shell's 1180 px minimum remains an explicit existing reflow limitation, so this release does not claim full WCAG reflow conformance for the application as a whole.

## 9. Source-of-truth semantics

### 9.1 Status mapping

Persist the upstream status verbatim as `raw_status`. Presentation groups are explicit:

| Core AI status | Presentation group | Included in Run count | Terminal | Continuous motion |
|---|---|---:|---:|---:|
| `PENDING` | queued / waiting to execute | yes | no | no |
| `RUNNING` | in progress | yes | no | only when fresh and not suspect |
| `PAUSED` | waiting for input | yes | no | no |
| `COMPLETED` | success | yes | yes | no |
| `FAILED` | failure | yes | yes | no |
| `TIMEOUT` | failure | yes | yes | no |
| `CANCELLED` | cancelled | yes | yes | no |
| `SKIPPED` | skipped trigger | no | yes | no |

Unknown future statuses are retained verbatim, displayed as `未知状态`, excluded from success-rate denominators, and never assumed terminal or active until the mapper is deliberately updated. Any unresolved mirrored unknown status forces `current_state_complete = false`, adds `UNKNOWN` to the incomplete-status set, and blocks `当前全部空闲` even if all three known non-terminal sets were otherwise proven.

The persisted Core AI AgentRun domain includes `PAUSED` for a workflow waiting on human input, although the current AgentRun detail API enum omits it. The workbench therefore recognizes `PAUSED` from the thirty-second Agent run-list response and does not call the incompatible detail endpoint for a paused Run. A later `PENDING`, `RUNNING`, or terminal list value resumes the normal mapping. This compatibility handling stays in SEO Ops and does not require a Core AI change.

`current_counts.running`, `.queued`, and `.waiting` cover active registry records; `.legacy_nonterminal` covers disabled or retired records. Each count exposes the quality contract in section 7.3 plus its last valid observation. The convenience booleans `has_active_runs`, `has_queued_runs`, and `has_waiting_runs` are three-state: `true` when at least one valid current response proves a matching Run, `false` only when the aggregate count is exact zero, and `null` when presence is unknown. They must never turn an incomplete `false` into a claim that nothing is running.

The stage's `signals` collection includes currently observed Runs, cached non-terminal Runs retained as uncertain after a failed proof, disabled/retired legacy Runs, terminal Runs still waiting for local SEO Ops materialization, and Runs carrying an unexpired `receipt_expires_at`. Cached or legacy signals carry their qualifier and remain static. Each signal has a derived `signal_state` of `queued`, `active`, `waiting`, `uncertain`, `archiving`, or `completed`; only a fresh, non-suspect `active` signal on an active registry record with a complete current-state proof may animate.

### 9.2 Counts and success rate

- **Trigger records** include every mirrored Core AI Run, including `SKIPPED`.
- **Run count** includes every mirrored AgentRun except `SKIPPED`. The UI calls this `Run 数`, not “已实际执行次数”, because `PENDING` does not prove execution has begun.
- **Success-rate denominator** includes only terminal, non-skipped Runs: `COMPLETED`, `FAILED`, `TIMEOUT`, and `CANCELLED`.
- **Success-rate numerator** includes only `COMPLETED`.
- `PENDING`, `RUNNING`, and `PAUSED` never enter the success-rate denominator.
- If the denominator is zero, display `—`, not `0%`.

If trigger-record totals are exposed in detail, label them explicitly as “触发记录”.

### 9.3 Token accounting

- Store upstream input and output Token usage as nullable integers.
- A known value of zero remains zero; a missing value remains `NULL`.
- Accept usage only when both upstream components are present, integral, and non-negative. If either component is missing or invalid, persist both as `NULL` and emit a sanitized Token-data warning; do not partially coerce the upstream object.
- A run has complete Token data only when both input and output fields are present. Its total is the sum of those two fields.
- Aggregate input, output, and total Token values include only runs with complete Token data, so every displayed total has one consistent coverage population.
- Token coverage is `complete Token runs / terminal non-skipped runs` in the selected range. `PENDING`, `RUNNING`, `PAUSED`, and `SKIPPED` records are not Token-eligible.
- Aggregate totals always show that coverage (`已知 N/M 次`).
- During a non-terminal run display `完成后入账`.
- A terminal run with missing usage displays `不可用`, never `0`.
- The workbench reports Core AI Agent-run usage only; it does not estimate infrastructure cost or add unrelated local API consumption.

This rule prevents SEO Ops from inventing zeroes. It cannot recover a missing Core AI component that the upstream serializer has already emitted as numeric `0`; such a value is treated as the upstream-reported value and remains an explicit integration limitation.

### 9.4 Freshness and uncertainty

The API distinguishes:

- snapshot generation time;
- last successful upstream synchronization;
- current per-Agent sync failure;
- completeness of the bounded current-state proof;
- metadata-verification health, which is a separate configuration signal;
- active authoritative status;
- suspect non-terminal status.

A Run-list or current-state error never rewrites a Run as failed. The UI keeps the last good snapshot, shows a freshness warning, stops affected live motion, and clearly dates the last successful synchronization. A metadata-only verification error follows the separate rule below.

Each active registry record has one synchronization health:

- `fresh`: `last_discovery_error` and `current_state_error` are clear, discovery and `current_state_checked_at` are no older than ninety seconds, `current_state_complete = true`, and every non-suspect `PENDING` or `RUNNING` Run has a successful status confirmation no older than fifteen seconds;
- `stale`: it has cached data, but discovery or current-state proof failed, is incomplete, or is older than ninety seconds, or any required current-Run status confirmation failed or is older than fifteen seconds;
- `unavailable`: it has never synchronized successfully or required Core AI configuration is absent.

The aggregate `sync_health` is:

- `fresh` when every active registry record is fresh;
- `partial` when at least one active record is fresh and at least one is stale or unavailable;
- `stale` when none is fresh but at least one has cached data;
- `unavailable` when active records exist but none has a usable snapshot, including missing Core AI configuration;
- `not_configured` when there are no active registry records, which drives the zero state rather than an error banner.

The compatibility boolean `stale` is true for aggregate `partial`, `stale`, and `unavailable`. The header uses `部分 Agent 状态延迟` for `partial`; it does not let one healthy Agent hide another Agent's failure. If any active Agent has `current_state_complete = false`, the page also shows `当前状态覆盖不完整`, applies the per-count `lower_bound` or `unknown` presentation, and must not show `当前全部空闲`.

Each `RUNNING` signal independently qualifies as fresh only when its registry record is active, the record has a complete current-state proof, its latest status-confirmation attempt succeeded, `last_synced_at` is no older than fifteen seconds, and it is below the local suspect threshold. Only that conjunction permits motion. `PENDING`, `PAUSED`, disabled, retired, stale, incomplete, and suspect signals are always static. A `last_verification_error` from the separate metadata endpoint adds a configuration badge but does not suppress a Run whose list-based state independently meets this freshness rule. Backoff and recovery state are isolated per Agent, so a failing Agent does not slow healthy Agents.

For an active Agent, the server computes `fresh_until` as the earliest applicable expiry among `last_discovery_success_at + 90 seconds`, `current_state_checked_at + 90 seconds`, and each non-suspect `PENDING`/`RUNNING` Run's `last_synced_at + 15 seconds`. The aggregate uses the earliest Agent expiry. A response generated at or after that instant is already stale. This timestamp is a downgrade boundary only: passing it can revoke “current”, exact-zero, or motion claims but can never upgrade a status.

## 10. Architecture

```text
Core AI read-only APIs
  ├─ GET /api/agents/{agent_id}
  └─ GET /api/runs/agent/{agent_id}/list?status=...&limit=...
                  │
                  ▼
SEO Ops agent_workbench_sync_loop
  ├─ validates explicit registry membership
  ├─ discovers and upserts run summaries
  ├─ proves queued/running/paused sets every 30 seconds
  ├─ confirms known queued/running sets at the fast cadence
  └─ records freshness, coverage, errors, and lease state
                  │
                  ▼
SQLite projection and registry
                  │
                  ▼
GET /api/agent-workbench?range=30d
                  │
                  ▼
Agent 工作台 in the operator browser
```

SEO Ops-triggered Runs are also upserted immediately at existing run-creation call sites. This puts local activity in the projection without waiting for discovery. Runs started outside SEO Ops are discovered by the next thirty-second registry scan, whether other Runs are active or idle.

## 11. Persistence design

### 11.1 `seo_ops_agents`

| Column | Semantics |
|---|---|
| `id` | Local immutable primary key |
| `agent_key` | Stable SEO Ops role key; unique among non-retired records |
| `coreai_agent_id` | Immutable Core AI ID; globally unique in this table |
| `display_name` | Operator-facing name |
| `role` | Short business responsibility |
| `sort_order` | Integer display order |
| `status` | `active`, `disabled`, or `retired` |
| `coreai_name` | Last verified upstream name, nullable |
| `coreai_model` | Last verified model, nullable |
| `coreai_timeout_hint_seconds` | Last verified editable-definition timeout, nullable and informational only |
| `suspect_after_seconds` | Local operator-controlled uncertainty threshold, default `1800` |
| `last_verification_attempt_at` | Latest metadata verification attempt, nullable |
| `last_verified_at` | Last successful metadata verification, nullable |
| `last_verification_error` | Short sanitized metadata error, cleared by success |
| `next_verification_at` | Independent metadata-verification due time |
| `retired_at` | Retirement timestamp, nullable |
| `created_at` / `updated_at` | Audit timestamps |

Constraints:

- unique `coreai_agent_id`;
- partial unique `agent_key` where `status <> 'retired'`;
- non-empty trimmed `agent_key`, `display_name`, and `role`;
- positive `suspect_after_seconds` constrained to `60..86400`;
- `sort_order` may collide; display name provides deterministic tie-breaking.

All persisted timestamps use timezone-aware UTC ISO-8601 values.

Upstream timestamps must parse as timezone-aware values before persistence. A missing, malformed, or naive upstream timestamp remains `NULL` with a sanitized data warning; SEO Ops does not replace it with the current time. Locally owned observation and audit timestamps use the server's UTC clock.

### 11.2 `seo_ops_agent_runs`

| Column | Semantics |
|---|---|
| `coreai_run_id` | Primary key and idempotency key |
| `seo_ops_agent_id` | Foreign key to the producing registry record |
| `raw_status` | Exact Core AI status |
| `trigger_type` | Exact upstream `triggered_by` value; it denotes trigger type, not user identity |
| `started_at` / `completed_at` | Upstream timestamps, nullable as supplied |
| `terminal_observed_at` | First local observation of a terminal status; immutable and nullable |
| `receipt_expires_at` | Nullable immutable expiry for an eligible factual terminal receipt |
| `input_tokens` / `output_tokens` | Nullable usage values |
| `trace_id` | Optional reference only; not fetched for v1 live state |
| `error_summary` | Short sanitized upstream summary, nullable |
| `source_kind` | Optional local association kind: `run`, `task_execution`, or `merchant_seo_artifact` |
| `source_local_id` | Optional local object ID |
| `merchant_id` | Optional merchant association |
| `first_seen_at` | First local observation |
| `last_poll_attempt_at` | Latest upstream status/list attempt affecting this Run |
| `last_synced_at` | Latest successful upstream read of this run |
| `last_poll_error` | Short sanitized latest Run-specific sync error, cleared by success |

The table never stores full input, output, transcript, delivered files, or stack traces. `seo_ops_agent_id` is immutable. A terminal status can never regress to a non-terminal status. Allowed non-terminal transitions include `PENDING → RUNNING`, `RUNNING → PAUSED`, and `PAUSED → PENDING` on resume; any non-terminal status may advance to a terminal status. A local immediate-registration upsert inserts a missing row and fills an empty local association, but it never overwrites an upstream status already present. An unexpected conflicting terminal status is retained as a warning for operator review rather than resolved by arrival order. `receipt_expires_at` is assigned only by the eligibility rule in section 7.2; a historical terminal backfill leaves it `NULL`, and no subsequent observation may extend or create it.

Database constraints allow `source_kind` only as `run`, `task_execution`, or `merchant_seo_artifact`, and allow Token values only as `NULL` or non-negative integers. Before enabling association reconciliation, migration validation reports duplicate non-null `coreai_run_id` values within or across the three existing local source tables; it does not silently choose among them.

The local trigger path that created a Run owns its primary `source_kind` and `source_local_id`; the first valid binding is immutable. `merchant_id` is derived by reading that local object and is never accepted as an independent caller-supplied association. Discovery fills an empty association only when exactly one row across `runs`, `task_executions`, and `merchant_seo_artifacts` matches `coreai_run_id`. If no row matches, keep `未关联商户`. If several rows conflict, preserve any already recorded origin; otherwise keep all association fields empty and emit `LOCAL_ASSOCIATION_CONFLICT`. A later scan never silently moves a Run between local business objects.

### 11.3 `seo_ops_agent_sync_state`

One row per registered Agent stores:

- `seo_ops_agent_id` primary/foreign key;
- `remote_total_runs`;
- `last_discovery_attempt_at` and `last_discovery_success_at`;
- a short sanitized `last_discovery_error`, cleared by success;
- `coverage_start_at`, the earliest effective Run start represented by the latest successful unfiltered response;
- `current_state_checked_at`, updated after each atomic current-state proof attempt;
- for each of `pending`, `running`, and `paused`: `observed_count`, upstream `total`, `last_observed_at`, and `set_quality` (`exact`, `lower_bound`, or `unknown`); a valid response replaces the observation, while a failed or invalid request preserves its count/time and changes only current quality to `unknown`;
- `unresolved_unknown_status_count`, derived and stored with the proof from mirrored raw statuses that the mapper cannot classify;
- `current_state_complete`, persisted in the same transaction and true only when all three known sets are exact and no unresolved unknown status exists;
- a short sanitized `current_state_error`, cleared only by a complete current-state proof;
- `sync_pending`, set by registration/replacement/re-enable and cleared only by the lease owner's first complete proof;
- `next_discovery_at`;
- `lease_owner`, monotonically increasing `lease_epoch`, and `lease_until` for fenced multi-worker exclusion.

`mirrored_run_count`, overall history completeness, and range completeness are derived from `seo_ops_agent_runs` plus the latest upstream total and coverage boundary; they are not separately persisted counters that can drift. Metrics are computed from `seo_ops_agent_runs`; there is no duplicate aggregate table.

## 12. Registry initialization and lifecycle

At database initialization, map current configured SEO Ops Agent slots to stable role keys and default display metadata:

| Configuration slot | Default `agent_key` | Default display name |
|---|---|---|
| `COREAI_AGENT_ID` | `diagnosis-plan` | 诊断与计划 Agent |
| `COREAI_EXECUTION_AGENT_ID` | `task-preparation` | 任务准备 Agent |
| `COREAI_KEYWORD_AGENT_ID` | `keyword-research` | 关键词研究 Agent |
| `COREAI_AUDIT_AGENT_ID` | `seo-audit` | SEO 审计 Agent |
| `COREAI_RANKING_AGENT_ID` | `ranking-analysis` | 排名分析 Agent |
| `COREAI_KEYWORD_SKILL_AGENT_ID` | `keyword-skill-workflow` | 关键词 Skill Agent |

The two configured Skill IDs and the Local Falcon Tool ID are not Agents and are not seeded. These slots are only bootstrap adapters; operators can register additional arbitrary SEO Ops Agents without adding another environment variable or changing code.

For each non-empty configured Core AI Agent ID:

1. If that exact ID already exists, leave its ownership and history unchanged and refresh only verified upstream metadata when allowed.
2. If the role key has no current record, insert an active registry record.
3. If the role key points to a different current Agent ID, do not silently replace it during startup. Surface a configuration conflict in the workbench and require the explicit replacement action.

If the same Core AI Agent ID appears in more than one configured slot, insert at most one registry record using the first slot in the table above and expose a configuration warning naming the duplicate slots. Do not duplicate its runs or silently assign two role keys.

Removing an environment variable does not delete or retire a registry record. Lifecycle changes are explicit operator actions.

Replacement is one transaction:

1. verify the new Core AI Agent metadata;
2. mark the old record `retired` and set `retired_at`;
3. create the new current record with the same role key;
4. preserve every old run association;
5. set the new record's discovery due-time to now and return it as synchronization pending.

Disabled and retired Agents stay in history and metrics. They stop normal live discovery but retain low-frequency archival discovery: every fifteen minutes for disabled records and every twenty-four hours for retired records. Each archival cycle performs the same bounded unfiltered plus `PENDING`, `RUNNING`, and `PAUSED` current-set proof used for active Agents, only at the lower lifecycle cadence.

Registration, replacement, and re-enable synchronously verify metadata, then transact the lifecycle change with `next_discovery_at = now` and return the persisted record with `sync_pending = true`. They do not wait for a bounded Run scan, take over an existing lease, or run that scan in the HTTP worker. The current lease owner performs the due scan and clears `sync_pending` only after committing its first valid current-state proof. The one-off `get_agent` metadata verification writes only metadata-verification columns under normal SQLite transaction serialization; it is not projection synchronization and does not require or mutate the per-Agent Run-sync lease.

Any already known non-terminal legacy Run continues status-filtered/list reconciliation at its Agent lifecycle's archival cadence. Because Core AI exposes no run-ID summary endpoint or pagination, a sufficiently old Run can be pushed outside every bounded list after it changes status. In that case it remains `状态待确认` indefinitely unless it reappears; the workbench explicitly does not guarantee eventual terminal or Token recovery. These legacy Runs remain labelled with the Agent lifecycle state and never regain continuous motion.

## 13. Adaptive synchronization

### 13.1 Dedicated loop

Add an independent `agent_workbench_sync_loop`; do not change the existing scheduler's global thirty-second interval. The existing scheduler cadence also controls other work, so reusing it at five seconds would unintentionally accelerate unrelated jobs.

The FastAPI lifespan starts both loops as separate tasks and cancels and awaits both during shutdown.

### 13.2 Server cadence

- **Metadata verification:** verify active configured/registered Agent metadata at startup, synchronously during registration/replacement/re-enable, and every 24 hours after a success. A periodic failure retries after an independent exponential delay beginning at 60 seconds and capped at 1 hour. Its due-time and backoff are separate from discovery and status confirmation. Verification success clears only `last_verification_error`; it never clears discovery or Run-poll errors.
- **Registry discovery and current-state proof:** every 30 seconds, whether the system is idle or active, issue four bounded list requests for every active registered Agent: one unfiltered recent-history request and one request for each of `status=PENDING`, `status=RUNNING`, and `status=PAUSED`. The three status requests run even when no such Run is already mirrored, so a long-lived Run cannot disappear merely because it fell outside the recent-history window. Disabled records receive the same four-request archival cycle every 15 minutes and retired records every 24 hours. This preserves historical and current-state visibility without treating retired capacity as live.
- **Fast status confirmation:** while an Agent has a mirrored non-suspect `PENDING` or `RUNNING` Run, request that Agent's status-filtered run list every 5 seconds, once per distinct active status rather than once per Run. This both confirms known Runs and discovers additional same-Agent Runs in that status.
- **Transition resolution:** merge all valid same-cycle status responses before deciding that a previously known Run disappeared. If it moved between `PENDING`, `RUNNING`, and `PAUSED`, persist that new status directly. Otherwise perform one unfiltered bounded Agent list read if the cycle has not already done so. If the Run is present, persist its new status and terminal fields. If it is outside the bounded response, retain the last raw status, mark it uncertain, and let normal discovery retry; absence alone never implies completion or failure.
- **Paused reconciliation:** the mandatory `status=PAUSED` request proves and updates the waiting set every 30 seconds for active Agents, including old paused Runs outside recent history.
- **Suspect reconciliation:** after a non-terminal Run exceeds its local suspect threshold, keep its raw status, stop the live signal, and reduce its status confirmation to the 30-second current-state proof cadence so a later terminal transition can still recover automatically.
- **Terminal transition:** the same list read that discovers a terminal status persists status, completion time, Token fields, and the sanitized error summary, then removes only that Run from the fast-status set.
- **Immediate local registration:** after SEO Ops successfully starts a Core AI run, idempotently insert its known Agent/run association before returning the local response.
- **Startup:** seed the registry, acquire eligible per-Agent leases, perform one four-request discovery/current-state proof for each acquired Agent, then enter adaptive cadence.
- **Backoff:** transport or upstream errors preserve data and use a per-Agent bounded exponential backoff capped at 60 seconds; a successful read resets only that Agent's cadence.

Each registered Agent's synchronization lease is acquired atomically in SQLite. Every acquisition uses a unique owner token and increments `lease_epoch`; the worker captures both values before an upstream request and renews before expiry. A response may commit only inside a transaction that still matches owner and epoch and has not passed `lease_until`; otherwise it is discarded. Different workers may own different Agents. A slow request can briefly overlap a new owner's request after lease expiry, which SQLite cannot prevent, but fencing guarantees that the expired owner cannot write stale data. All web workers continue serving the shared snapshot, and a crashed owner loses its leases naturally without destructive recovery.

Discovery and fast status confirmation use independent due-times. A five-second status cycle never postpones an Agent's thirty-second discovery scan, and one Agent's backoff never changes another Agent's due-times.

The four-request proof is assembled under one Agent lease and committed as one coherent current-state observation. Valid responses may still upsert their parsed Runs when another request in the cycle fails, but the same transaction records each status set's quality. `sync_pending` clears only after this transaction commits a complete proof. A fully valid, untruncated unfiltered response can derive exact counts and prove all three known current sets; otherwise each set depends on its own filtered response. Any unresolved unknown raw status still makes the overall proof incomplete.

Upstream calls are serialized within each Agent lease. Every response carries a local observation time, and an older response cannot overwrite a row with a newer successful observation. Status transition guards and the local-registration rule in section 11.2 apply even when trigger handling and synchronization race.

Each Agent list response is parsed and validated completely before its projection transaction begins. A malformed row, Agent-ID mismatch, or duplicate conflicting Run aborts freshness advancement for that response, preserves the previous snapshot, and records the corresponding sanitized warning; it never leaves a half-fresh cycle. Invalid Token usage follows section 9.3: status and timing may still synchronize, while both usage fields remain unknown with a Token-data warning.

The workbench deliberately does not use `GET /api/runs/{run_id}`. The current Core AI detail mapper returns large content fields and may call file sharing while constructing artifact download URLs, so treating it as a lightweight side-effect-free status read would be false. The list response still contains fields the workbench does not need; a narrow parser extracts only the projection columns, immediately discards input/output/error stack, and never logs or persists those fields.

### 13.3 Initial and incremental history

Core AI's Agent run list has a limit but no offset or date cursor. Initial discovery therefore uses `SEO_OPS_AGENT_HISTORY_LIMIT`, default `200` and constrained to `1..1000`, and compares the number of unique mirrored runs with the upstream `total`.

All workbench list calls use this hard limit. Only an unfiltered successful response updates `remote_total_runs` and `coverage_start_at`; a status-filtered `total` describes that current status set and cannot stand in for all-Agent history.

- Derive `mirrored_run_count` from the projection at query time.
- Overall `history_complete = true` only when the latest successful unfiltered response is not truncated (`returned_count == remote_total_runs`) and every returned Run ID is mirrored. Accumulated local count alone never proves complete remote identity coverage.
- A bounded response establishes a contiguous recent coverage window beginning at its earliest effective Run start, recorded as `coverage_start_at`.
- If a truncated response contains a missing or invalid upstream `started_at`, its local fallback remains usable for display but cannot prove a contiguous remote range; selected-range completeness stays false for that Agent.
- A selected range is complete when overall history is complete or its `range_start >= coverage_start_at` and the latest successful response proves that all returned Runs in that window were mirrored.
- The `all` range has no finite start and is complete only when overall history is complete.
- Aggregate `metrics_complete_for_range` is true only when the selected range has ID coverage for every included Agent, each included Agent's latest due discovery succeeded, and the range contains no unresolved uncertain or unknown-status Run.
- Whenever overall or selected-range coverage is incomplete, return `mirrored_run_count`, `remote_total_runs`, and `coverage_start_at`, and display `基于已镜像 N/M 次` beside every affected count, rate, and Token metric.
- No metric may be labelled “全部历史” while overall coverage is incomplete.
- Incremental scans upsert known rows and discover newly returned rows; they do not claim that older truncated rows were recovered.

History-ID completeness alone never proves outcome or Token completeness. `coverage_as_of` records the oldest successful discovery represented across included Agents, and every aggregate is explicitly an as-of snapshot. An unresolved Run forces outcome-, success-rate-, and Token-related range metrics to the incomplete presentation even if all known IDs are mirrored.

For each of `PENDING`, `RUNNING`, and `PAUSED`, assign quality as follows:

- `exact` only when that filtered response is valid and not truncated (`returned_count == total`), or when a valid unfiltered response is itself fully untruncated and all its IDs were mirrored;
- `lower_bound` when the filtered response is valid but truncated, with `observed_count` set only to unique rows returned and validated in that response;
- `unknown` when that filtered request fails or is invalid, retaining the preceding valid `observed_count` and `last_observed_at` only as a labelled historical observation.

`ACTIVE_SET_TRUNCATED` can clear only after a valid, untruncated response for that same status or a fully valid and untruncated unfiltered response; a successful but truncated unfiltered reconciliation cannot clear it. A fetch error clears under the same proof rule. `current_state_complete` is true only when all three set qualities are `exact` and no unresolved unknown status exists.

While `current_state_complete = false`, missing Runs are never inferred terminal and the stage cannot claim `当前全部空闲` or animate the affected Agent. A `lower_bound` count displays `至少 N`; an `unknown` count displays `当前数量未知 · 上次确认 N（时间）` and never repackages cached rows as a current lower bound. This current-state qualifier is independent of historical range coverage: both qualifiers are returned when both are incomplete.

If complete historical recovery later becomes necessary beyond this API limit, it requires a separate Core AI pagination or batch-summary design and is outside this release.

### 13.4 Browser cadence

The aggregate response includes a server recommendation:

- `refresh_after_ms = 5000` when a fresh queued, active, or local-archiving signal exists;
- `refresh_after_ms = 30000` when all runs are idle or only suspect runs remain;
- when health is partial or stale, the earlier of the normal UI cadence and the next per-Agent retry, capped at 60 seconds; a failing Agent never replaces a healthy active signal's five-second cadence.

The browser schedules the next fetch only after the previous one finishes, so requests never overlap. Automatic fetch and the one-second monotonic elapsed tick run only when `autoUpdateEnabled && document.visibilityState === 'visible'`. Becoming hidden immediately stops stage motion. Returning to visibility or focus marks the cached snapshot presentation-only stale, keeps it static, and performs an immediate fetch when automatic update remains enabled; old motion or an old idle claim cannot resume before that fetch returns a fresh complete snapshot.

Using `snapshot_at` plus a monotonic clock, the client schedules a local downgrade at aggregate and per-signal `fresh_until`, and, while automatic updates are enabled, removes a receipt at `receipt_expires_at`. Downgrade may only stop motion, change current count quality to an unknown presentation, treat the three convenience presence booleans as `null`, and replace `当前全部空闲` with `截至 … 未发现运行 · 等待刷新`; it never changes `raw_status`, invents a transition, or upgrades stale data. If a fetch fails, the downgraded presentation stays in place until a later successful response establishes freshness again.

Manual pause takes precedence over visibility and focus events. While paused, only an explicit `刷新显示` may perform one local read, elapsed display remains frozen, and all motion remains off. Current wording is immediately converted to snapshot wording: idle becomes `截至 … 未发现运行`, a cached running row becomes `截至 … 状态为 RUNNING`, count labels use `数据截至 …`, and a terminal receipt uses absolute completion/observation time instead of “刚刚”; no unbounded “当前” claim survives the pause. Receipt tabs, selection, and focus stay frozen across their nominal expiry. A manual refresh applies receipt expiry before paint but leaves the refreshed page in paused snapshot mode. Resuming automatic updates also applies receipt expiry before paint, never replays an entrance transition, and keeps remaining current-state presentation static until an immediate fetch succeeds with fresh complete data.

Server discovery and browser refresh are independent polling layers. Under healthy conditions, an external Run reaches the SQLite projection within thirty seconds, but an already-open idle browser can display it as late as its following thirty-second local refresh: the explicit end-to-end worst-case target is sixty seconds. Direct navigation, focus restoration, or a manual `刷新显示` reads the projection immediately. SEO Ops-created Runs are inserted into the projection synchronously after upstream acceptance and therefore appear on a newly opened workbench without waiting for discovery.

The aggregate `last_complete_discovery_at` is the oldest `last_discovery_success_at` across currently active registry records. It is `null` if any active record has never synchronized or no active record exists. This watermark cannot advance past an Agent that is failing or overdue, so a success from one Agent cannot hide another Agent's stale state. Each signal separately returns its Run-level `last_synced_at` for the active-stage freshness label.

## 14. API design

All routes use the existing operator authentication dependency.

### 14.1 Aggregate workbench

`GET /api/agent-workbench?range=today|7d|30d|all`

Returns one coherent local snapshot:

```json
{
  "snapshot_at": "2026-09-03T10:00:04Z",
  "last_complete_discovery_at": "2026-09-03T09:59:42Z",
  "sync_health": "fresh",
  "stale": false,
  "current_state_complete": true,
  "current_state_checked_at": "2026-09-03T10:00:00Z",
  "current_state_incomplete_statuses": [],
  "fresh_until": "2026-09-03T10:00:15Z",
  "has_active_runs": true,
  "has_queued_runs": false,
  "has_waiting_runs": false,
  "current_counts": {
    "running": {
      "value": 1,
      "quality": "exact",
      "last_observed_value": 1,
      "last_observed_at": "2026-09-03T10:00:00Z"
    },
    "queued": {
      "value": 0,
      "quality": "exact",
      "last_observed_value": 0,
      "last_observed_at": "2026-09-03T10:00:00Z"
    },
    "waiting": {
      "value": 0,
      "quality": "exact",
      "last_observed_value": 0,
      "last_observed_at": "2026-09-03T10:00:00Z"
    },
    "legacy_nonterminal": {
      "value": 0,
      "quality": "exact",
      "last_observed_value": 0,
      "last_observed_at": null
    }
  },
  "refresh_after_ms": 5000,
  "range": "30d",
  "timezone": "Asia/Shanghai",
  "range_start": "2026-08-05T00:00:00+08:00",
  "range_end": "2026-09-04T00:00:00+08:00",
  "metrics_complete_for_range": true,
  "coverage": {
    "mirrored_run_count": 26,
    "remote_total_runs": 26,
    "coverage_start_at": "2026-07-12T03:40:00Z",
    "coverage_as_of": "2026-09-03T09:59:42Z"
  },
  "summary": {
    "run_count": 24,
    "terminal_runs": 23,
    "successful_runs": 21,
    "success_rate": 0.913043,
    "known_input_tokens": 5200000,
    "known_output_tokens": 2880000,
    "known_total_tokens": 8080000,
    "token_known_runs": 19,
    "token_eligible_runs": 23
  },
  "signals": [
    {
      "coreai_run_id": "run-example",
      "local_agent_id": "agent-example",
      "agent_name": "关键词研究 Agent",
      "raw_status": "RUNNING",
      "signal_state": "active",
      "fresh": true,
      "suspect": false,
      "started_at": "2026-09-03T09:56:00Z",
      "elapsed_seconds": 244,
      "last_synced_at": "2026-09-03T10:00:00Z",
      "fresh_until": "2026-09-03T10:00:15Z",
      "merchant_id": 42,
      "merchant_name": "Choice Brooklyn – Upper West Side"
    }
  ],
  "agents": [],
  "sync_warnings": []
}
```

`snapshot_at` is local response-generation time. `last_complete_discovery_at` is the full active-registry discovery watermark defined above. Aggregate `current_state_complete` is true only when at least one active registry record exists, every active record has all three known sets exact, and no unresolved unknown status exists; it is false when any is incomplete and `null` when no active record exists. Aggregate `current_state_checked_at` is the oldest latest proof-attempt time across active registry records and is `null` if none exists. `current_state_incomplete_statuses` is the union of incomplete per-Agent status sets, including `UNKNOWN`. The response never equates any of these timestamps with a run's own `last_synced_at`.

Each `current_counts` entry has `quality = exact | lower_bound | unknown`. Aggregate quality is `exact` only when every included Agent/set is exact, `lower_bound` when none is unknown and at least one is truncated, and `unknown` when any included Agent/set failed or was invalid. For `unknown`, `value` is `null`; `last_observed_value` is the sum of the most recent valid per-Agent observations and is explicitly historical, with `last_observed_at` set to the oldest contributing observation. For `lower_bound`, `value` sums only rows in current valid responses. The three `has_*` fields follow the tri-state semantics in section 9.1.

`fresh_until` is the earliest server-computed expiry of every fact required for the aggregate current claim; it may already be in the past for a stale response and is `null` when no active current claim exists. Each signal also carries its own nullable expiry. These values let the browser downgrade a once-fresh snapshot without inventing a later upstream observation.

The aggregate coverage counts are sums across included Agents. Its `coverage_start_at` is the latest per-Agent coverage start, the earliest point from which every included Agent is known to be covered; it is `null` if any included Agent lacks a boundary. `coverage_as_of` is the oldest per-Agent successful discovery used by the aggregate. `metrics_complete_for_range` is the authoritative qualifier.

Each Agent item includes registry metadata, local suspect threshold, current-count values and quality, current-state completeness, `sync_pending`, range metrics, Token coverage, history coverage, last terminal run, and per-Agent synchronization state. Signal items contain only verified fields needed by the stage, including `signal_state`, freshness, `fresh_until`, suspect reason, optional `receipt_expires_at`, snapshot-aligned `elapsed_seconds`, and optional local association.

### 14.2 Agent run history

`GET /api/agent-workbench/agents/{local_agent_id}/runs?range=30d&limit=20&before=...`

Pagination is local and cursor-based, sorted by `(effective_started_at DESC, coreai_run_id DESC)`, where effective start uses `started_at` and then `first_seen_at`. `limit` defaults to 20 and is clamped to `1..100`. `before` is an opaque encoded tuple of those two sort keys. The endpoint returns projected run summaries and local link metadata, not full Core AI content.

### 14.3 Registry mutations

- `POST /api/agent-workbench/agents` registers and verifies a new Agent.
- `PATCH /api/agent-workbench/agents/{local_agent_id}` edits display metadata, order, or active/disabled lifecycle state.
- `POST /api/agent-workbench/agents/{local_agent_id}/retire` archives the record.
- `POST /api/agent-workbench/agents/{local_agent_id}/replace` performs the transactional retire-and-create operation.

There is no `DELETE` endpoint. Mutation responses return `{ "agent": <persisted record>, "sync_pending": <boolean> }` so the client can read back the exact lifecycle result. Registration, replacement, and re-enable return `sync_pending: true`; they do not imply that Run discovery completed inside the request.

### 14.4 Core AI client extension

Reuse and strengthen the existing Core AI client boundary:

- reuse `get_agent(agent_id)` and validate returned ID, `type = AGENT`, `status = PUBLISHED`, and a non-empty name before registration, replacement, or re-enable; any returned editable-definition timeout is cached only as `coreai_timeout_hint_seconds` and never treated as the effective published-snapshot timeout;
- add `list_agent_runs(agent_id, status, limit)` with optional status filtering.

Every listed run must be validated against the requested registered `agent_id` before insertion. An unexpected Agent ID is rejected and recorded as a sync warning.

## 15. Backend module boundaries

Create `api/app/agent_workbench.py` to own:

- registry CRUD and replacement transaction;
- projection upserts;
- status and metric semantics;
- aggregate and history routes;
- discovery, fast status confirmation, backoff, freshness, and fenced lease logic;
- initialization from configured Agent slots.

Extend:

- `api/app/config.py` with validated operator timezone and history-limit settings;
- `api/app/coreai.py` by strengthening existing read-only Agent validation and adding run-list calls;
- `api/schema.sql` and existing initialization/migration logic with the three tables and indexes;
- `api/app/main.py` with the operator-only router and independent lifecycle task;
- existing Core AI run-trigger call sites in `runs.py`, `tasks.py`, and `seo_targets.py` with a small idempotent projection upsert after a successful start.

The trigger path must remain successful if the optional projection upsert fails after Core AI has already accepted a run. That failure is logged and repaired by discovery; it must not cause the caller to retry and accidentally create a duplicate upstream run.

## 16. Frontend module boundaries

Create `web/src/pages/AgentWorkbench.tsx` and split focused components when needed:

- `LiveRunStage`;
- `AgentRegistryTable`;
- `AgentRunHistory`;
- `AgentManagerDrawer`.

Extend:

- `web/src/App.tsx` with the `/agents` route, sidebar item, glyph, and active state;
- `web/src/api.ts` with typed workbench, history, and registry calls;
- `web/src/index.css` with scoped workbench tokens, stage, table, drawer, status, motion, and reduced-motion rules;
- existing application tests with direct-route and navigation coverage.

The client treats `refresh_after_ms` as the server's cadence contract, aborts fetches on unmount, prevents overlapping refreshes, and never derives upstream truth from its own timer.

## 17. Failure and degraded states

| Condition | Required behavior |
|---|---|
| Core AI base URL/key is missing | Show persisted registry/history; mark live sync unavailable |
| Core AI transport or server error | Keep last snapshot; show partial or stale health as derived per Agent; stop affected live animation |
| Periodic Agent metadata verification fails while Run-list sync remains healthy | Preserve history and fresh list-based status; show a separate configuration badge; do not suppress otherwise-qualified live motion |
| A new or re-enabled Agent is missing, unpublished, or inaccessible | Reject activation; preserve any existing history and show the verification error |
| Non-terminal run exceeds the local suspect threshold | Show `状态待确认`; retain raw status; stop green/teal motion |
| Token fields are absent | Show `完成后入账` while active or `不可用` when terminal; never coerce to zero |
| History list is truncated | Show `基于已镜像 N/M 次`; qualify every incomplete selected-range metric, not only all-time aggregates |
| A current-state status list is valid but truncated | Show `当前状态覆盖不完整`; render only current validated rows as `至少 N`; never claim all idle or animate that Agent |
| A current-state status list fails or is invalid | Show `当前状态覆盖不完整`; render `当前数量未知 · 上次确认 N（时间）`; never rebrand cached state as a lower bound, claim all idle, or animate that Agent |
| Local merchant/task association is absent | Show `未关联商户`; keep the Core AI run visible |
| Core AI terminal state precedes local materialization | Show `Core AI 已完成，SEO Ops 归档中` |
| Another process owns a valid sync lease | Serve the shared snapshot and do not schedule that Agent locally; if an expired in-flight request overlaps a new owner, epoch fencing rejects the old response |
| Unknown future Core AI status | Preserve raw value; show `未知状态`; exclude from success calculation and live animation; mark current state incomplete and block idle until mapped or resolved |

## 18. Security and data handling

- The browser receives no Core AI API key or direct upstream URL requiring credentials.
- All workbench endpoints require the existing SEO Ops operator session.
- Registry mutations are operator-only and validated server-side.
- Error summaries are truncated and sanitized before persistence and response.
- Full prompts, outputs, transcripts, files, and stack traces are not mirrored.
- Although Core AI's Agent detail and run-list responses contain unused content fields, narrow metadata/run parsers retain only the columns defined in section 11, discard prompts, tools, input, output, transcript, artifacts, and error stack at the integration boundary, and never include them in logs, persistence, or browser responses.
- Core AI integration is read-only for this feature; run creation continues only through existing authorized SEO Ops workflows.
- Logs identify local Agent/run IDs and error categories without recording secrets or full payloads.

## 19. Test strategy

### 19.1 Backend unit and API tests

Cover:

- schema initialization and safe migration of an existing database;
- configured-slot seeding, idempotency, and explicit configuration conflicts;
- registration verification, duplicates, invalid metadata, disable/re-enable, retirement, transactional replacement, local suspect-threshold validation, and mutation readback;
- immutable historical Agent ownership;
- strict validation that listed runs belong to the requested Agent;
- narrow parsing that discards content-heavy Agent/run fields and never exposes them through persistence or responses;
- idempotent projection upserts from discovery and local trigger call sites, including terminal non-regression, association immutability, and immutable receipt expiry;
- all eight known status mappings, `PAUSED` list-only compatibility, and unknown status forcing incomplete current state and blocking idle;
- Run count, terminal denominator, success-rate, range, and `SKIPPED` semantics;
- nullable Token validation, non-negative constraints, totals, and coverage calculations;
- complete and incomplete history and selected-range coverage;
- independent five-second status confirmation and the mandatory thirty-second unfiltered plus `PENDING`/`RUNNING`/`PAUSED` proof, including discovery of an old non-terminal Run outside recent history, transition resolution, and per-Agent bounded error backoff using a fake clock;
- per-status `exact`/`lower_bound`/`unknown` quality, tri-state presence booleans, failure preserving only a timestamped prior observation, exact clearing only by the same complete filtered set or a fully untruncated unfiltered list, and prohibition of false idle/fresh claims;
- fifteen-minute disabled and twenty-four-hour retired four-request archival discovery;
- registration/replacement/re-enable returning `sync_pending = true`, setting discovery due now, respecting an existing lease, and clearing pending only after the lease owner's complete proof;
- startup/24-hour metadata verification with independent 60-second-to-1-hour retry backoff and error-domain isolation;
- metadata-only verification failure leaving independently fresh, complete Run-list motion eligible;
- bounded-list disappearance remaining uncertain, never inferred terminal, and forcing affected metrics incomplete;
- receipt eligibility for a fresh observed transition or genuinely recent `completed_at`, with historical backfill and repeated discovery never creating or extending a “刚刚” receipt;
- a guard proving the workbench never invokes the Core AI single-Run detail endpoint;
- lease acquisition, epoch fencing, renewal, expiry, normal single-owner polling, transient in-flight overlap, and rejection of an expired owner's response;
- fresh/partial/stale/unavailable/not-configured aggregation and suspect-Run calculation;
- upstream failures preserving prior status;
- local merchant/task/run link resolution and `LOCAL_ASSOCIATION_CONFLICT` handling;
- operator authentication on every route.

### 19.2 Frontend tests

Cover:

- sidebar navigation and direct `/agents` routing;
- loading, zero-registry, queued, active, multi-active, paused, idle, partial, stale, unavailable, uncertain, archiving, and just-completed stage states;
- current-state-incomplete presentation distinguishing valid truncation (`至少 N`) from failure (`当前数量未知 · 上次确认 N`), with no false idle message or live motion;
- all-Agent rendering without a fixed row count;
- range switching and current active count remaining range-independent;
- run-row expansion and associated/unassociated links;
- Token `完成后入账`, `不可用`, zero, totals, and coverage presentation;
- incomplete-history and incomplete-selected-range qualifiers;
- server-directed 5-second/30-second cadence;
- no overlapping requests;
- local downgrade at aggregate/signal `fresh_until`, including revoking old motion and exact-zero idle wording without changing raw status;
- hidden-tab pause and focus/visibility immediate refresh, with no cached motion or idle claim restored before a successful fresh response;
- manual auto-update pause/resume, timestamped snapshot wording, frozen timer/motion, and static-until-success resume behavior;
- receipt removal at persisted expiry without waiting for network refresh, one optional non-looping entrance transition, and no receipt transition under reduced motion;
- pausing while focus is on a receipt tab, crossing its expiry without selection/focus movement, then applying expiry before paint on refresh or resume without replay;
- `刷新显示` rereading the local aggregate without triggering direct Core AI fan-out;
- drawer validation for the local suspect threshold, `Core AI 配置参考值` labelling, `sync_pending`, and persisted-response readback;
- reduced-motion, forced-colors, 200%-zoom behavior, and non-color status labels;
- tabs-pattern Run selection, button-based table expansion, modal drawer focus management, quiet timers, and event-only polite announcements;
- preservation of selection, expansion, filters, scroll, and focus across snapshot replacement.

### 19.3 Integration and acceptance tests

Use a fake Core AI service to prove the full sequence:

1. return a truncated recent-history list while an older registered-Agent Run remains `RUNNING` outside that window;
2. discover that Run through the mandatory `status=RUNNING` proof and persist `current_state_complete = true` only after all three current sets are proven;
3. return a five-second refresh recommendation and confirm the Run without using the side-effecting detail mapper;
4. resolve its disappearance by merging the status sets and one bounded unfiltered list, then observe `COMPLETED` with terminal timestamps and Token usage;
5. persist and reread the terminal projection with an eligible, non-restarting receipt expiry;
6. return to the thirty-second idle recommendation only after a complete current-state proof;
7. render the persisted run and aggregate totals from the workbench API;
8. repeat initial discovery with an old terminal Run and prove it creates no “刚刚完成” receipt;
9. separately exercise a truncated status set, a failed status request, and an unknown status to prove their distinct lower-bound, unknown, and idle-blocking outputs;
10. advance browser time beyond `fresh_until` and `receipt_expires_at` to prove local downgrade and receipt removal without another network response.

Perform a read-only validation against currently configured Core AI Agents to compare registered IDs, latest statuses, run totals, and known Token totals. The acceptance pass must not start an external Run.

Visually verify the page at 1440 px and 1920 px, including queued, active, paused, idle, partial, stale, long-name, many-Agent, incomplete-history, drawer, keyboard-focus, forced-colors, 200%-zoom, and reduced-motion states.

## 20. Acceptance criteria

The feature is complete when:

1. `/agents` is visible in the sidebar and protected by the operator boundary.
2. Only explicitly registered SEO Ops Agents appear, and adding more than five requires no code or layout change.
3. A newly started SEO Ops Run is persisted immediately by its local upsert and appears on a newly opened workbench; an already-open idle workbench shows local or external changes by its next adaptive refresh, with the documented healthy worst case of sixty seconds for an external Run.
4. Only a fresh, non-suspect `RUNNING` Run on an active registry record with complete current-state proof uses continuous live motion. A qualifying terminal receipt may use one entrance transition of at most 200 ms; otherwise `PENDING`, `PAUSED`, terminal, idle, disabled, retired, incomplete, partial/stale affected, and uncertain states remain static. A metadata-only warning does not negate independently healthy Run-list proof.
5. The page never shows fake progress, invented tool activity, or missing Token values as zero.
6. Terminal status and Token usage survive server restart and can be read back from SQLite.
7. Counts, success rate, time ranges, `SKIPPED`, Token coverage, and history coverage follow this specification.
8. Replacing an Agent preserves old registry and run history and creates a separate new owner for future runs.
9. Upstream failure preserves the last known data and visibly marks freshness degradation without changing run outcomes.
10. Under a valid lease only one worker schedules synchronization for an Agent; after lease expiry, any late old-owner response fails the transactional owner/epoch fence and cannot overwrite the projection.
11. All automated backend, frontend, and fake-Core-AI integration tests pass.
12. Desktop visual, keyboard, focus, contrast, forced-colors, reduced-motion, and new-page 200%-zoom checks pass at the application's supported width boundary; the legacy shell's documented 1180 px reflow limitation is not worsened or misreported as fixed.
13. Every active Agent receives `PENDING`, `RUNNING`, and `PAUSED` proof at least every healthy thirty-second cycle even when no non-terminal Run is already mirrored; a truncated set produces a current-response lower bound, a failed set produces an unknown count with timestamped last observation, and neither permits an “全部空闲” claim.
14. Historical terminal backfill never produces a “刚刚完成/失败” receipt, while a qualifying fresh transition receives one immutable ten-second receipt.
15. Registration, replacement, and re-enable return a persisted `sync_pending` state without bypassing the fenced sync lease; only the lease owner's complete proof clears it.
16. Any mirrored unknown upstream status blocks the idle claim until the mapper recognizes it or that Run later enters a known status.
17. A visible snapshot locally downgrades at `fresh_until`; pause, hiding, and focus restoration cannot keep or revive stale “当前空闲” wording or live motion before a successful fresh read.

## 21. Rollout

1. Ship the additive database schema and registry seeding logic.
2. Start the sync loop in observation-safe mode and validate projection/readback against configured Agents without triggering runs.
3. Enable the operator API and verify adaptive cadence, lease ownership, stale behavior, and aggregate semantics.
4. Release the `/agents` route and sidebar entry.
5. Validate active-to-terminal behavior with an existing authorized SEO Ops workflow, then confirm persisted status and Token readback.

Rollback may remove the route and stop the workbench sync task while leaving the additive tables intact. Preserving those tables makes rollback non-destructive and retains Agent/run history for a later re-enable.

## 22. Trade-offs and rationale

The local projection adds a small synchronization subsystem, but it prevents browser fan-out, protects credentials, supports consistent snapshots and historical filtering, and scales independently of the number of open operator tabs. It also lets the UI be honest about incomplete history and missing Token data.

The five-second upstream cadence is intentionally limited to Agents with known queued or running Runs. Every healthy active Agent still receives four bounded requests at the thirty-second proof cadence, which is the deliberate cost of discovering old `PENDING`, `RUNNING`, or `PAUSED` records without Core AI pagination. A healthy external Run reaches the projection at that next proof cycle; because the idle browser also refreshes at up to thirty seconds, the honest already-open-page worst case is sixty seconds. This preserves the approved 5s/30s adaptive model without pulling every registered Agent's content-heavy list response every five seconds.

The navy stage makes work perceptible without replacing the product's established palette. Restricting teal and motion to fresh active state gives both signals a stable meaning; the page becomes visually quiet as soon as that meaning is no longer justified.

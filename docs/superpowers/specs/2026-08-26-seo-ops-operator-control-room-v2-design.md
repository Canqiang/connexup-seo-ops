# SEO Ops Operator Control Room v2 Design

**Date:** 2026-08-26  
**Status:** Proposed for implementation review  
**Product:** Connexup internal managed-service SEO operations control plane  
**Source of truth:** Safari artifact “SEO Ops 控制台 v2” plus the approved option A: operator-first UI with an explicit management/audit view.

## 1. Outcome

Rebuild SEO Ops around the work an internal account manager must perform while serving 50–100 merchants. The default experience is an action-oriented operator control room. System state, Agent Runs, hashes, revisions, quotas, and audit details remain available, but they do not dominate the default workflow.

The product must make three human responsibilities obvious:

1. **把关:** judge Planner proposals, approve an exact task revision, and confirm an external execution.
2. **例外:** reconcile unknown outcomes, handle failures, and resolve overdue verification.
3. **商户联络:** obtain questionnaires, authorization, content confirmation, and report delivery acknowledgement.

A routine decision should usually take no more than 30 seconds. The interface must lead with the next decision and its consequence, not the internal state-machine implementation.

## 2. Fixed boundaries

- All SEO Ops product code, persistence, routes, workers, projections, UI, deployment assets, and Agent manifests live in `Canqiang/connexup-seo-ops`.
- Core AI Server is an external Agent/Run/File/Artifact capability. Agents may be created or updated in UAT through existing Core AI APIs. The `/Users/xander/git_repo/core-ai` source repository must not be modified.
- FBR Project is a read-only business-data dependency. `/Users/xander/git_repo/fbr-project` must not be modified.
- A missing reusable Skill may be created in `/Users/xander/git_repo/fbr-agent` on its own branch, then published through the existing Core AI Skill API. No Skill is created merely to reproduce scheduler, task, approval, dispatch, or verification logic.
- Copilot is not part of the operator or audit UI.
- Production-facing screens must not use frontend demo tasks. Missing data produces a truthful empty state.

## 3. Product model

### 3.1 Decision ownership

| Decision | Owner |
| --- | --- |
| When a lifecycle or recurring planning cycle is due | SEO Ops scheduler/event router |
| What work should exist | Planner Agent, returning `TaskProposal[]` |
| Whether a proposal becomes a Task | Human operator through SEO Ops |
| How a specialist task is performed | Bound specialist Agent on Core AI Server |
| Whether an external write is authorized | Human approval and execution-confirmation gates |
| Whether work is complete | SEO Ops receipt validation, independent readback, and verification |

Core AI Run completion is never sufficient to mark an SEO Task complete.

### 3.2 Proposal-to-task rule

Planner and scheduler output is a proposal, not a Task. A proposal is displayed as a muted row with its validation status, dependency graph, proposed due date, mode, and reason. Only an explicit `ADOPT` decision creates the Task. `REJECT` requires a reason and remains auditable.

Specialist Agents never create Tasks, approve revisions, confirm execution, change capability authorization, or certify their own success.

### 3.3 Lifecycle

New merchant:

`Questionnaire proposal → questionnaire returned → keyword proposal/task → keyword adoption → audit + ranking tasks → plan artifact → plan-item proposals → adopted execution tasks → verification → review`

Existing merchant:

`Cadence/event due → routine proposal or Planner replan → adopted task → draft/evidence → gate 1 → gate 2 when required → attempt/run → receipt/readback → verification → review signal → next planning cycle`

Routine deterministic cadence does not consume Planner tokens. Planner is used for onboarding, material changes, failed assumptions, new evidence, plan refresh, and review-driven reprioritization.

## 4. Information architecture

### 4.1 Default operator view

The left navigation contains four entries:

1. **工作台** `/`
2. **商户** `/merchants`
3. **复盘** `/reviews`
4. **设置** `/settings`

The top bar contains the merchant/portfolio scope switcher, current operator, and a two-state view selector: `操作员` / `管理审计`. The default is `操作员`. The choice is stored locally for the current browser and represented by `?view=audit` in shareable audit links.

### 4.2 Management/audit view

Audit view reveals the six-ledger navigation without changing business truth:

1. 总览
2. 商户
3. 任务
4. 运行
5. 复盘
6. 设置

Existing deep links remain valid. In operator view, `/inbox` resolves into the workbench queue and `/runs` resolves into the relevant exception workflow or the settings system-status page. In audit view they remain full ledger pages.

### 4.3 Page hierarchy

```text
SEO Ops
├── 工作台
│   ├── 今日需要我处理
│   ├── 把关
│   ├── 例外
│   └── 商户联络
├── 商户
│   ├── 商户列表
│   └── 商户工作台
│       ├── 生命周期与当前动作
│       ├── 本轮任务（按日期）
│       ├── 待判定建议
│       ├── 报告与数据
│       └── GBP Post 周计划
├── 任务详情
│   ├── 当前判断
│   ├── 内容/成品
│   ├── 证据与双门
│   ├── 发布与核验
│   └── 技术详情（折叠）
├── 复盘
└── 设置
    ├── 周期
    ├── 能力矩阵
    ├── Agent 绑定
    ├── 用户权限
    └── 系统状态 / Run
```

## 5. Operator workbench

The workbench replaces the current card-only overview as the main daily surface.

### 5.1 Header

- Portfolio scope and date.
- One sentence: “先处理需要人判断、查证或联络的事项；其余工作由系统推进。”
- Primary action: `新商户`.
- Secondary action: `刷新`.

### 5.2 Decision summary

Compact ledger cells show real counts for:

- 待处理事项
- 待判定建议
- 待审批（门 1）
- 待执行确认（门 2）
- 结果待查
- 核验逾期

Counts are navigation controls, not decorative KPI cards.

### 5.3 Unified action queue

The default queue is grouped by human responsibility rather than backend enum:

- **例外:** `OUTCOME_UNKNOWN`, confirmed failures, verification overdue.
- **把关:** proposal decision, gate 1 approval, gate 2 confirmation, artifact acceptance.
- **商户联络:** questionnaire waiting, authorization missing, content confirmation, report delivery.

Each row contains one plain-language issue, merchant/location, waiting duration or due date, one primary action, and at most one secondary link. Technical identifiers remain hidden until expanded.

Saved views and filters remain available, but the default view is “我的今天”. Search supports merchant, location, task title, and keyword.

Bulk review is allowed only for same-type, low-risk, prevalidated gate-1 items. Gate 2 and outcome reconciliation are always single-item operations.

### 5.4 Empty state

When there is no human action, show “今天没有需要人工处理的事项” and the next scheduled windows. Do not fill the page with healthy merchants or fake demo tasks.

## 6. Merchant workspace

### 6.1 Header

The header states merchant name, location, onboarding/operating phase, cycle number, and the one current blocker or next window. Merchant settings and `请求 Planner 刷新任务图` are secondary actions.

### 6.2 Lifecycle rail

The rail remains visible but is explanatory, not directly executable. It derives stages from accepted Tasks and verified deliverables. Operator view does not expose direct specialist-stage Run buttons.

### 6.3 Current action card

One card explains:

- what is waiting;
- who must act;
- what evidence or dependency is missing;
- what the primary button does;
- what becomes available afterward.

Examples: `发放问卷`, `采纳关键词并解锁下一波`, `判定 Planner 建议`, `审批当前成品`, `确认发布`, `记录商户回复`.

### 6.4 Dated cycle ledger

Accepted Tasks and unadopted proposals share a chronological ledger but remain visually and semantically distinct:

- Task row: solid white surface, real status, due time, owner, execution mode, and next action.
- Proposal row: muted surface with a `建议` marker, validation result, dependency note, and `去判定` action. It must never imply that a Task already exists.
- Completed rows remain visible for the current cycle and collapse by default after the cycle boundary.

### 6.5 Reports and data

The merchant page shows the latest brand profile, keyword set, audit, ranking snapshot, plan, and review with freshness, source, and version. Full history opens the reports page. File links use real Core AI attachment URLs or SEO Ops persisted artifacts.

### 6.6 GBP Post weekly plan

An operating merchant receives a dedicated section that joins:

- Post type: Offer / What’s New / Event;
- versioned merchant voice profile;
- weekly keyword-cluster signal: improved / flat / declined / inconclusive;
- coverage history and next proposed topic;
- publish → verify → next-week readback.

Topic disposition is a proposal until adopted. Review statements are limited to association and are not inserted into merchant-facing reports as causal claims.

## 7. Task detail

### 7.1 Operator-first hierarchy

The first viewport contains:

- task title and merchant;
- one sentence describing the current decision;
- current artifact/content preview;
- one primary action;
- consequence copy for that action.

Statuses are translated into operator language. Internal enums, `rev`, `state_version`, `spec_hash`, Run IDs, trace IDs, receipts, and attempt records live in a collapsed `技术详情（审计）` section.

### 7.2 Draft and artifact work

- Editable content supports manual correction, feedback-driven Agent rewrite, media attachment, and revision creation.
- Any content change creates a new revision and invalidates prior approval.
- Artifact tasks provide a readable preview, download/copy controls, and an application-evidence form.

### 7.3 Gates

- Gate 1 copy: `批准当前版本` — authorizes the exact revision and hash; it does not execute.
- Gate 2 copy: `确认现在发布` — immediately creates one dispatch attempt after server-side checks.
- The normal UI reduces the gate-2 validation list to `校验通过` or one actionable failure. Audit view exposes all checks.

### 7.4 Publish and verification

Publishing and verification use separate progress and labels. `SUCCEEDED` means a dispatch receipt exists, not that the public result is verified. Verification requires independent readback, uploaded evidence, or a recorded manual observation under the existing contract.

### 7.5 Outcome reconciliation

`OUTCOME_UNKNOWN` opens a step-by-step dialog:

1. explain why the result is unknown;
2. show available run, trace, receipt, and readback clues;
3. require exactly one human conclusion: `确认未发生，可重新排队` or `确认已发生，进入核验`;
4. record evidence and actor.

The two conclusions receive equal visual weight. There is no automatic retry button.

## 8. Review and reporting

The review page is a cross-merchant decision surface, not a causal-claim generator. Each review card separates:

- baseline;
- action bundle;
- observed change;
- confounders and missing evidence;
- conclusion tier, capped at `ASSOCIATIONAL` unless a separately approved causal design exists;
- proposed next planning input.

Live dashboards, analysis, and reports remain distinct:

- dashboard: current changing state;
- analysis/review: comparison, diagnosis, and next decision;
- report: frozen, validated, versioned artifact.

## 9. Settings and audit surfaces

Settings contains:

- capability matrix: technically connected / merchant authorized / task approved;
- merchant cadence with actor and version history;
- Core AI Agent binding by task type;
- users and permissions;
- system status, worker/scheduler heartbeat, Run capacity, quota, and recent failures.

Audit view may expose the existing full Runs ledger and Tasks ledger. Operator view reaches those records through the task or exception being handled.

## 10. Visual system

### 10.1 Direction

The visual identity is a **control-room operations ledger**: compact, calm, and highly scannable. It must not resemble a consumer SaaS card dashboard or an AI chat interface.

### 10.2 Tokens

| Token | Value | Purpose |
| --- | --- | --- |
| Paper | `#F3F6F8` | application background |
| Surface | `#FFFFFF` | active ledger surfaces |
| Ink | `#183247` | primary text and strong rules |
| Muted ink | `#657B8E` | explanatory text |
| Rule | `#CFD9E1` | borders and table structure |
| Amber | `#B96B08` | waiting, decision, primary human action |
| Teal | `#167D7A` | verified, completed, safe progress |
| Cyan | `#167D9A` | information, read-only Agent work |
| Red | `#C44444` | unknown result, destructive or overdue state |

Typography:

- Display/body: `Avenir Next`, `PingFang SC`, `Helvetica Neue`, system sans-serif.
- Data/labels: `SFMono-Regular`, `SF Mono`, `Roboto Mono`, monospace.
- Desktop scale: 10 / 11 / 12 / 13 / 15 / 24 px. The 24 px size is reserved for page titles; routine UI stays compact.

Geometry:

- 4 px base spacing unit; 8 px content rhythm.
- 1 px structural rules.
- 0–4 px corner radius; pills only for true compact states.
- 36–44 px task rows in dense desktop mode.
- Shadows only for drawers/dialogs, never for routine ledger sections.

### 10.3 Signature interaction

The memorable element is the **decision rail**: every queue or task row carries a narrow semantic rail showing why a human is involved—amber for judgment/waiting, red for exception, cyan for information, teal for completion. The rail encodes responsibility and makes 100-merchant scanning possible without turning every state into a badge.

### 10.4 Motion and accessibility

- Motion is limited to view transitions, row expansion, and dialog steps, 120–180 ms.
- `prefers-reduced-motion` removes transitions.
- Every action has visible keyboard focus.
- Color is never the only status signal.
- Desktop is optimized for 1280–1600 px. At narrower widths, tables become labeled rows; primary actions remain visible.

## 11. Data and API changes

Existing SEO Ops APIs remain the source of truth. Add or reshape projections only where operator screens otherwise require many unbounded client requests.

Required projections:

1. `GET /api/seo-ops/workbench` — paginated human-action rows grouped by `GATEKEEPING`, `EXCEPTION`, or `MERCHANT_CONTACT`, plus exact summary counts.
2. `GET /api/seo-ops/merchants/:id/cycle-ledger` — accepted Tasks and proposals for the active cycle with explicit `record_kind`.
3. `GET /api/seo-ops/merchants/:id/post-program` — current voice-profile version, cluster signals, coverage, published/verified history, and proposals.

All projections enforce the existing user, permission, and merchant scope. They do not copy Core AI Run state into Task truth. Existing `/inbox`, proposal, lifecycle, artifact, report, review, and attempt endpoints remain valid for audit/deep-link use.

The frontend removes `demoTasks` from production rendering. Test fixtures remain in test files only.

## 12. Core AI Agent roster

### 12.1 System functions that are not Agents

The following remain deterministic SEO Ops services:

- cadence calculation;
- event routing;
- proposal validation;
- Task creation after adoption;
- approval and execution gates;
- dispatch and at-most-once attempt ownership;
- receipt validation;
- readback and verification state;
- outcome reconciliation decisions.

### 12.2 Specialist roster

| Role | Desired UAT action | Output ownership |
| --- | --- | --- |
| Planner & Task Generator | reconcile existing Agent to the approved `TaskProposal[]` contract | proposal batch only |
| Questionnaire Draft | reconcile existing Agent | questionnaire draft artifact |
| Keyword Set | retain/reconcile v2 US `en-US` contract | keyword artifact, scored only with valid upstream method |
| Evidence Audit | reconcile existing Agent | combined evidence-bounded audit artifact |
| Ranking Baseline/Refresh | reconcile existing Agent | ranking snapshot/report artifact |
| Execution Plan | reconcile existing Agent | plan artifact and plan-item proposals |
| GBP Post Content | create if no compliant Agent exists | versioned draft and media brief, never publication |
| Effect Review | reuse or reconcile an existing compliant Agent | associative review artifact and planning signals |
| Report Packager | create only if existing audit/review Agents cannot produce the required combined deliverable | frozen merchant-facing report artifact |
| External Execution | bind existing capability-specific Agent where authorized; create only for a supported, testable write channel | receipt returned to SEO Ops, never self-verification |

### 12.3 Reconciliation process

Agent changes use Core AI Server UAT APIs, never Core AI source edits:

1. read current Agent, Skill, binding, and published-state metadata;
2. compare against versioned manifests stored under `server/core-ai-agents/`;
3. produce a sanitized dry-run diff;
4. create or update only `[SEO Ops]` scoped Agents;
5. publish only after schema, tool/Skill boundary, market, and mutation-policy checks pass;
6. read back Agent ID, published status, Skill IDs, and prohibited capability absence;
7. update SEO Ops task-type binding through its own settings API;
8. run one bounded UAT contract test and independently read back the resulting artifact/Run.

Existing Agents are not deleted during reconciliation. Prior IDs and manifests are recorded for rollback. API tokens remain in server-side environment variables and never enter browser code, logs, manifests, commits, or reports.

## 13. Error, empty, and concurrency states

- `409 state_version` conflict: inline banner `已被他人更新，刷新后重试` with a refresh action.
- No proposal batch: explain the next scheduler/Planner trigger instead of showing a blank table.
- New merchant with no cycle ledger: primary action `请求 Planner 生成`.
- No reconciliation items: hide the workbench exception section and show zero only in the summary.
- Missing authorization: route to merchant-contact work; never silently downgrade `AUTO_WRITE`.
- Core AI unavailable: preserve Task/attempt truth, show the capability outage, and do not claim dispatch.
- Unknown external result: freeze the merchant execution chain until a human conclusion is recorded.

## 14. Validation and acceptance

### 14.1 Product acceptance

- An operator can identify the next five actions for 50–100 merchants without opening individual merchant pages.
- Default navigation contains four entries and no Copilot.
- Management/audit view exposes the six-ledger structure without duplicating business state.
- A Planner suggestion cannot appear as an accepted Task before adoption readback.
- No operator-facing merchant page offers a direct specialist-stage Run trigger.
- Task detail clearly separates approval, dispatch, publication receipt, and verification.
- `OUTCOME_UNKNOWN` offers no automatic retry.
- Merchant GBP Post planning visibly joins type, voice version, keyword signal, and coverage.
- Every production row comes from backend data; empty states are truthful.

### 14.2 Technical acceptance

- Frontend component and interaction tests cover both views, navigation, workbench grouping, proposal rows, task progressive disclosure, reconciliation dialog, and empty/error states.
- Backend tests cover projection authorization, pagination, grouping, stable sorting, proposal/task separation, and 409 behavior.
- Full frontend and backend suites pass; both production builds pass.
- Desktop screenshots are reviewed at 1440 px for workbench, merchant, task, review, and settings; a 100-merchant fixture validates density and overflow behavior.
- Keyboard navigation, visible focus, reduced motion, and responsive labeled-row behavior are verified.
- UAT Agent reconciliation includes dry-run diff, API mutation result, independent readback, one real output artifact, and rollback coordinates.

## 15. Delivery slices

1. **Operator shell and workbench:** visual tokens, four-entry navigation, view selector, unified human-action projection and queue.
2. **Merchant control room:** current-action card, dated cycle ledger, proposal separation, reports/data, and Post program.
3. **Task decision flow:** operator-first task page, drafts/artifacts, double gate, progressive audit details, and reconciliation dialog.
4. **Review, settings, and audit view:** review surface, capability/cadence/Agent settings, Run status, and six-ledger audit navigation.
5. **Agent reconciliation:** dry-run inventory, manifests, create/update/publish through UAT APIs, SEO Ops binding, and end-to-end readback.

Each slice must be usable and testable independently. No slice may weaken authorization, at-most-once dispatch, evidence, or verification boundaries for visual convenience.

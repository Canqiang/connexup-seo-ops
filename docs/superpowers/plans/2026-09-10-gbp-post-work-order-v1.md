# GBP 内容工作单 v1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一张 GBP 内容工作单从创建走到「Google 门店上真的出现这篇帖子、且服务端读回证实」，四步各有独立负责人、状态与证据。

**Architecture:** 工作单是一个分组对象，聚合三个独立 Task（草稿 / 审核 / 发布）；远端核验是发布 Task 的 VERIFYING 阶段，由服务端执行。草稿复用现有 `task_agent_preparation` 的一次性 trigger / attempt / dispatch_token 链路调 Core AI 内容 Agent。审核是分派给操作员的人工 Task，产出一条绑定五要素的批准。发布由服务端用已批准的字节直连 FBR `createLocationPost` 恰好一次。核验用 `getLocationPost` 按 post_id 精确读回。

**Tech Stack:** FastAPI + SQLite（有序迁移 + 触发器不可变约束）、React 19 + Vite + TS + Vitest、Core AI（内容 Agent）、FBR operation-assistant-api（GBP 写与读回）。

**Spec:** `docs/superpowers/specs/2026-09-09-gbp-post-task-design.md`，**必须连同第 15 节一起读**——第 15 节是写本计划前的七项实测，其中 §15.2 与 §15.6 推翻了 spec 前文的一部分，本计划按第 15 节执行。

---

## Global Constraints

以下每条都绑定所有任务，实施者不得自行放宽。

1. **只改本仓库。** 不改 Core AI 代码，不改 FBR 代码。Agent 与 Skill 的配置文件放本仓库，通过接口提交。
2. **规范时刻格式**：写库的 UTC 时刻一律 27 字符 `%Y-%m-%dT%H:%M:%S.%fZ`，由 `is_canonical_utc_instant` 强制。
3. **迁移**：新增文件 `api/migrations/NNNN_name.sql`，校验和锁定，不得修改已存在的迁移。迁移版本号列表钉在多处，改动时用 `grep -rn` 全仓搜索后逐处更新，不要只改想当然的那三处。
4. **裸 `sqlite3` CLI 不能对本库跑 `PRAGMA integrity_check`**，因为 schema 依赖 `register_sqlite_invariants` 注册的 UDF。校验一律走 `api/.venv/bin/python` 加载 `app.db`。
5. **外部写恰好一次**：任何通往 FBR 的写调用都必须先落库 request、checksum 与 idempotency key，再发出；结果不确定时一律进核验，**绝不重发**。
6. **只有服务端能把任务推到 DONE**，且发布 Task 的 DONE 只能由读回核对产生。
7. **批准绑定五要素**：artifact checksum（正文）、media 指纹、cta_type + cta_url、location_id、发布时间窗。任一变化或过期即失效。
8. **就绪性只有 READY / BLOCKED 两态**，`WAITING_*` 是 blocker code 不是就绪态（spec §15.7）。
9. **第一版不带新图**（spec §15.2）：图片候选只能是该门店已有帖子的 `media[].google_url`，或不带图。不做生图、不做上传、不建 `merchant_photos` / `merchant_promotions`。
10. **不做「转交给…」**（spec §15.6）：系统只有一个操作员账号。人工任务次操作只有三个：暂时受阻、请求协助、取消任务。
11. **前端**：复用 `web/src/components/feedback` 的 `Notice` / `EmptyState` / `LoadingState` / `ConflictBanner`；不得使用 `window.confirm`；宽内容放进自带 `overflow-x: auto` 的容器，不得用 `overflow-x: hidden` 掩盖溢出。
12. **测试**：后端 pytest，前端 Vitest + `fireEvent`（`@testing-library/user-event` 未安装）。前端涉及日期的测试自行钉 `process.env.TZ`。
13. **功能开关**：所有 GBP 工作单入口受 `SEO_OPS_GBP_POST_ENABLED` 门控，默认 `false`。关掉即完整回滚到当前行为。

## 计划前裁定（Ruling，实施者按此执行，不要按 spec 前文）

**R-1：发布这一步由服务端直连 FBR，不经 Core AI 发布 Agent。**

spec §4 与 §9.2 原定发布 Task 的执行者是一个只挂 `createLocationPost` 的 Core AI Agent。本计划改为服务端用已批准的字节原样构造请求并发出。

- 为什么：那一步没有任何判断可做。spec 自己把该 Agent 约束到 temperature 0、`max_turns=2`、单工具、不许读、不许改字段——这是把 LLM 当 HTTP 客户端用。而 LLM 转写请求体意味着它可能改动已被逐字批准的正文；核验能发现，但发现时错误内容已经出现在一家真实营业商户的公开主页上。服务端直发从结构上消除这一类失败，同时消掉 spec §15.5 那项未验证风险和一整个 Agent 的建设。
- 保留了什么：发布 Task 仍然是独立 Task，仍有 assignee 模型与 PUBLICATION attempt，`executor_type` 记为 `SYSTEM`。「Agent 驱动」体现在任务与执行者模型上，而不是体现在谁序列化 HTTP body。
- 如果这条裁定错了，代价是：将来要把发布执行者换成 Agent 时，需要在 `gbp_publish.py` 里加一条 Agent 分支并重跑发布路径的测试。发布 Agent 路径在 spec 里保留为下一个增量，等 §15.5 对着可丢弃目标验证通过后再接。

**R-2：内容 Agent 保留。** 写稿有判断，那是 LLM 真正的用处。

**R-3：第一次真实发布前必须由用户逐字确认。** 落地对象是 Choice Brooklyn - Upper West Side，一家真实营业、GBP 正在被人运营的商户（spec §15.9）。Task 14 在发出前停下，把确切正文、CTA、目标门店交给用户确认，不得自行发出。

---

## File Structure

**新建（后端）**

| 文件 | 职责 |
|---|---|
| `api/migrations/0007_gbp_work_order.sql` | 四张新表、两个新列、不可变触发器 |
| `api/app/gbp_work_order.py` | 工作单对象：创建（一个事务建三任务+依赖+分派）、聚合视图、取消 |
| `api/app/gbp_post_contract.py` | `seo_ops.gbp_post_request.v1` 组装与 `seo_ops.gbp_post_draft.v2` 严格解析 |
| `api/app/gbp_calendar.py` | 美国联邦节假日静态表与窗口查询 |
| `api/app/merchant_voice_profile.py` | 风格档案的版本化读写 |
| `api/app/gbp_draft.py` | 草稿 Task 的触发、轮询、artifact 落库、推进审核 Task |
| `api/app/gbp_review.py` | 审核决定：批准（写五要素 grant）/ 退回（建下一版） |
| `api/app/gbp_publish.py` | 批准复核、audit_id 解析、PUBLICATION attempt、服务端直发 |
| `api/app/gbp_verify.py` | 读回核对、退避、终态判定 |
| `api/app/gbp_api.py` | 以上的 HTTP 路由 |

**新建（Agent 交付物，本仓库）**

`docs/agents/gbp-post/content-skill/SKILL.md`、`content-skill/references/*.md`、`content-agent.json`、`2026-09-10-readback.md`

**新建（前端）**

`web/src/pages/WorkOrder.tsx`、`web/src/components/work-order/`（四步流水线、审核视图、发布清单、核验证据）、`web/src/workOrderTypes.ts`

**修改**

`api/app/task_workflows.py`（三个模板 + 两个 blocker）、`api/app/main.py`（挂路由）、`api/app/task_plan_contract.py`（放行 `GBP_POST`）、`web/src/App.tsx`（路由）、`web/src/api.ts`、`web/src/pages/TasksOverview.tsx`（blocker 选项）、`web/src/pages/MerchantProfile.tsx`（风格档案卡、新建工作单）

---

## 现场事实（实施者必读，省去重新摸索）

- `tasks.status` 的 CHECK 已经允许 `EXECUTING` 与 `VERIFYING`，不需要改。
- `task_executions.stage` 的 CHECK 已经允许 `PREPARATION` / `PUBLICATION` / `VERIFICATION`，`approval_id` 与 `artifact_id` 已是普通 INTEGER 列（当时目标表还不存在，没建外键）。
- `tasks` 的 `plan_id` NOT NULL 且有 `(plan_id, plan_revision)` 复合外键指向 `task_plan_revisions`。**任何任务都必须挂在一个 Plan 上。** 商户页手建工作单要复用 `api/app/tasks.py:752-760` 那段隐式 OPERATOR Plan 的建法（建 plan + 建 revision 1 + 直接 APPROVED）。
- 迁移版本号列表钉死在 **17 处，分布在 4 个文件**：`api/tests/test_db_migrations.py`(13)、`api/tests/test_migration_ledger_compatibility.py`(2)、`api/tests/test_db.py`(1)、`api/tests/test_task_workflow_migration.py`(1)。加迁移时先 `grep -rn "0006_performance_immutability" api/app api/tests` 拿到完整清单再逐处加，不要凭印象改。
- FBR 客户端在 `api/app/fbr_gbp.py`，用 `Authorization: Bearer $FBR_SEO_BEARER_TOKEN` 加 `x-merchant-id: <fbr_merchant_id>` 头，目前**只有 GET 封装**，写方法要新加。
- Core AI 客户端在 `api/app/coreai.py`，`CoreAiClient._request(method, path)`。
- 落地商户：merchant 3 = Choice Brooklyn，`fbr_merchant_id` `47c65660-ade7-4431-8d46-9ec9c58aef5b`；UWS 门店 `gbp_location_id` `24300588970198995`，place `ChIJH8iZh-5ZwokRPLzzADeSnYE`，时区 `America/New_York`。

---

### Task 1: 迁移与 schema

**Files:**
- Create: `api/migrations/0007_gbp_work_order.sql`
- Modify: 上述 4 个测试文件的 17 处迁移清单
- Test: `api/tests/test_gbp_work_order_migration.py`

**Interfaces:**
- Produces: 表 `task_work_orders`、`task_artifacts`、`task_approvals`、`merchant_voice_profiles`；列 `tasks.work_order_id`、`task_executions.executor_type`。后续所有任务消费这些。

DDL 按现有风格写，全部时刻列用规范 UTC 并加 `CHECK (is_canonical_utc_instant(<col>))`：

```sql
CREATE TABLE task_work_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  plan_id INTEGER NOT NULL REFERENCES task_plans(id),
  kind TEXT NOT NULL CHECK (kind IN ('GBP_POST')),
  location_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 500),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at)),
  cancelled_at TEXT CHECK (cancelled_at IS NULL OR is_canonical_utc_instant(cancelled_at)),
  cancel_reason TEXT,
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL))
);

CREATE TABLE task_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES "tasks"(id),
  execution_id INTEGER NOT NULL REFERENCES task_executions(id),
  schema_version TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  artifact_json TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at)),
  UNIQUE (task_id, version)
);

CREATE TABLE task_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_order_id INTEGER NOT NULL REFERENCES task_work_orders(id),
  review_task_id INTEGER NOT NULL REFERENCES "tasks"(id),
  draft_task_id INTEGER NOT NULL REFERENCES "tasks"(id),
  artifact_checksum TEXT NOT NULL CHECK (length(artifact_checksum) = 64),
  media_fingerprint TEXT NOT NULL,
  cta_type TEXT NOT NULL,
  cta_url TEXT,
  location_id TEXT NOT NULL,
  publish_window_start TEXT NOT NULL CHECK (is_canonical_utc_instant(publish_window_start)),
  publish_window_end TEXT NOT NULL CHECK (is_canonical_utc_instant(publish_window_end)),
  operator TEXT NOT NULL,
  grant_type TEXT NOT NULL CHECK (grant_type IN ('HUMAN')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','RETURNED','INVALIDATED','REVOKED','EXPIRED')),
  reason TEXT,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at)),
  revoked_at TEXT CHECK (revoked_at IS NULL OR is_canonical_utc_instant(revoked_at)),
  revoked_by TEXT,
  CHECK (publish_window_end > publish_window_start),
  CHECK (status <> 'RETURNED' OR reason IS NOT NULL)
);

CREATE TABLE merchant_voice_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id INTEGER NOT NULL REFERENCES merchants(id),
  version INTEGER NOT NULL CHECK (version > 0),
  tone_json TEXT NOT NULL,
  structure_json TEXT NOT NULL,
  avoid_json TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (is_canonical_utc_instant(created_at)),
  UNIQUE (merchant_id, version)
);

ALTER TABLE "tasks" ADD COLUMN work_order_id INTEGER REFERENCES task_work_orders(id);
ALTER TABLE task_executions ADD COLUMN executor_type TEXT
  CHECK (executor_type IS NULL OR executor_type IN ('AGENT','HUMAN','SYSTEM'));
```

不可变触发器（草稿产物与批准记录一旦写下就是证据）：

```sql
CREATE TRIGGER trg_task_artifacts_no_update
BEFORE UPDATE ON task_artifacts
BEGIN SELECT RAISE(ABORT, 'task_artifact_immutable'); END;

CREATE TRIGGER trg_task_artifacts_no_delete
BEFORE DELETE ON task_artifacts
BEGIN SELECT RAISE(ABORT, 'task_artifact_immutable'); END;
```

`task_approvals` **不能**用同样的全禁触发器——批准需要从 `ACTIVE` 变到 `INVALIDATED` / `REVOKED` / `EXPIRED`。改为只锁住五要素与不可回头的状态：

```sql
CREATE TRIGGER trg_task_approvals_bind_immutable
BEFORE UPDATE ON task_approvals
WHEN OLD.artifact_checksum <> NEW.artifact_checksum
  OR OLD.media_fingerprint <> NEW.media_fingerprint
  OR OLD.cta_type <> NEW.cta_type
  OR COALESCE(OLD.cta_url,'') <> COALESCE(NEW.cta_url,'')
  OR OLD.location_id <> NEW.location_id
  OR OLD.operator <> NEW.operator
  OR OLD.publish_window_start <> NEW.publish_window_start
  OR OLD.publish_window_end <> NEW.publish_window_end
BEGIN SELECT RAISE(ABORT, 'approval_binding_immutable'); END;

CREATE TRIGGER trg_task_approvals_terminal
BEFORE UPDATE ON task_approvals
WHEN OLD.status <> 'ACTIVE' AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'approval_status_terminal'); END;

CREATE TRIGGER trg_task_approvals_no_delete
BEFORE DELETE ON task_approvals
BEGIN SELECT RAISE(ABORT, 'approval_immutable'); END;
```

- [ ] **Step 1: 先写失败测试** `api/tests/test_gbp_work_order_migration.py`：迁移后四张表存在；`tasks` 有 `work_order_id`；`task_executions` 有 `executor_type`；`INSERT` 一条 artifact 后 `UPDATE` 抛 `task_artifact_immutable`；批准从 `ACTIVE` 改 `status` 成功、再改抛 `approval_status_terminal`；改 `artifact_checksum` 抛 `approval_binding_immutable`；`publish_window_end <= start` 被 CHECK 拒绝。
- [ ] **Step 2:** `api/.venv/bin/python -m pytest tests/test_gbp_work_order_migration.py -v`，预期全红。
- [ ] **Step 3:** 写 `0007_gbp_work_order.sql`。
- [ ] **Step 4:** `grep -rn "0006_performance_immutability" api/app api/tests` 拿到全部 17 处，逐处补 `"0007_gbp_work_order"`。
- [ ] **Step 5:** 跑全量后端测试 `api/.venv/bin/python -m pytest -q`，必须全绿（迁移清单漏一处就会红）。
- [ ] **Step 6: Commit** `feat: add GBP work order schema`

---

### Task 2: Workflow 模板与就绪性 blocker

**Files:**
- Modify: `api/app/task_workflows.py`
- Test: `api/tests/test_gbp_workflow_templates.py`

**Interfaces:**
- Consumes: Task 1 的 `task_approvals`、`merchant_voice_profiles`。
- Produces: `WORKFLOW_TEMPLATES` 新增 `GBP_POST_DRAFT` / `GBP_POST_REVIEW` / `GBP_POST_PUBLISH`（均 v1，`terminal_after_approval=False`）；`task_blocker` 新增两个 code。

三张转移表按 spec §5.1：

```python
_GBP_DRAFT_TRANSITIONS = MappingProxyType({
    "PENDING": frozenset({"PREPARING", "NEEDS_ATTENTION", "CANCELLED"}),
    "PREPARING": frozenset({"DONE", "NEEDS_ATTENTION", "CANCELLED"}),
    "NEEDS_ATTENTION": frozenset({"PENDING", "CANCELLED"}),
    "DONE": frozenset(), "CANCELLED": frozenset(),
})
_GBP_REVIEW_TRANSITIONS = MappingProxyType({
    "PENDING": frozenset({"EXECUTING", "CANCELLED"}),
    "EXECUTING": frozenset({"DONE", "NEEDS_ATTENTION", "CANCELLED"}),
    "NEEDS_ATTENTION": frozenset({"EXECUTING", "CANCELLED"}),
    "DONE": frozenset(), "CANCELLED": frozenset(),
})
_GBP_PUBLISH_TRANSITIONS = MappingProxyType({
    "PENDING": frozenset({"EXECUTING", "CANCELLED"}),
    "EXECUTING": frozenset({"VERIFYING", "NEEDS_ATTENTION"}),
    "VERIFYING": frozenset({"DONE", "NEEDS_ATTENTION"}),
    "NEEDS_ATTENTION": frozenset({"VERIFYING", "PENDING", "CANCELLED"}),
    "DONE": frozenset(), "CANCELLED": frozenset(),
})
```

注意 `EXECUTING` 不能直接回 `PENDING`：一旦发出外部写就不允许「当作没发生过」，只能进核验。`NEEDS_ATTENTION → PENDING` 保留，但调用方只有在证明未发生外部写时才允许走（在 `gbp_publish.py` 里判，不在模板里判）。

`enabled_task_types()` 改为按开关返回：

```python
def enabled_task_types() -> set[str]:
    names = {"PREPARE_ONLY"}
    if os.environ.get("SEO_OPS_GBP_POST_ENABLED", "").lower() in {"1", "true", "yes"}:
        names |= {"GBP_POST_DRAFT", "GBP_POST_REVIEW", "GBP_POST_PUBLISH"}
    return names
```

两个新 blocker，插在 `_first_incomplete_dependency` 之后（依赖优先，因为依赖未满足时谈授权没有意义）：

```python
def _voice_profile_missing(conn, task):
    if _value(task, "task_type") != "GBP_POST_DRAFT": return False
    if not _table_has_columns(conn, "merchant_voice_profiles", {"merchant_id"}): return True
    return conn.execute("SELECT 1 FROM merchant_voice_profiles WHERE merchant_id=? LIMIT 1",
                        (_value(task, "merchant_id"),)).fetchone() is None

def _no_valid_approval(conn, task, now):
    if _value(task, "task_type") != "GBP_POST_PUBLISH": return False
    wo = _value(task, "work_order_id")
    if wo is None: return True
    row = conn.execute(
        "SELECT publish_window_end FROM task_approvals "
        "WHERE work_order_id=? AND status='ACTIVE' ORDER BY id DESC LIMIT 1", (wo,)).fetchone()
    if row is None: return True
    current = (now or datetime.now(timezone.utc))
    return parse_stored_schedule(row["publish_window_end"]) <= current
```

`task_blocker` 末尾按此顺序追加：依赖 → `VOICE_PROFILE_MISSING` → `AWAITING_VALID_APPROVAL`。

- [ ] **Step 1: 失败测试**：三张模板存在且 `terminal_after_approval is False`；`assert_transition("GBP_POST_PUBLISH","EXECUTING","PENDING")` 抛 `ValueError`；开关关闭时 `enabled_task_types()` 不含三者；草稿任务在无风格档案时 blocker 为 `VOICE_PROFILE_MISSING`，有档案后为 None；发布任务无 ACTIVE 批准时 `AWAITING_VALID_APPROVAL`，批准过期后同样是它；**依赖未完成时返回的是 `UPSTREAM_NOT_DONE` 而不是授权 blocker**（优先级测试）。
- [ ] **Step 2:** 跑测试，预期红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 `api/.venv/bin/python -m pytest tests/test_gbp_workflow_templates.py tests/test_task_workflow_migration.py -q`，绿。
- [ ] **Step 5: Commit** `feat: add GBP work order workflow templates and approval blockers`

---

### Task 3: 风格档案

**Files:**
- Create: `api/app/merchant_voice_profile.py`
- Modify: `api/app/merchant_profiles.py`（视图里带出当前版本）、`api/app/main.py`
- Test: `api/tests/test_merchant_voice_profile.py`

**Interfaces:**
- Produces: `current_voice_profile(conn, merchant_id) -> dict | None`（含 `version_ref` 形如 `"<merchant_id>:v<version>"`）、`put_voice_profile(conn, merchant_id, body, operator) -> dict`（永远新建版本，不改旧行）。路由 `GET/PUT /api/merchants/{id}/voice-profile`。

Pydantic body：`tone: list[str]`（1–10 项，每项 1–60 字）、`post_structure: list[str]`（1–10 项）、`avoid: list[str]`（0–20 项）、`note: str | None`（≤1000）。`extra="forbid"`。

- [ ] **Step 1: 失败测试**：首次 PUT 建 version 1；再 PUT 建 version 2 且 version 1 仍在；`current_voice_profile` 取最大版本；空 `tone` 被 422 拒绝；未登录 401。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: add versioned merchant voice profiles`

---

### Task 4: 工作单创建与聚合视图

**Files:**
- Create: `api/app/gbp_work_order.py`
- Test: `api/tests/test_gbp_work_order.py`

**Interfaces:**
- Consumes: Task 1 的表、Task 2 的模板。
- Produces:
  - `create_work_order(conn, *, merchant_id, location_id, topic, operator, plan_id=None) -> int`
  - `work_order_view(conn, work_order_id) -> dict`
  - `cancel_work_order(conn, work_order_id, reason, operator) -> None`

`create_work_order` 在**一个事务**里做完：校验 `location_id` 在该商户 `merchant_gbp_profiles` 的门店里；`plan_id` 为空时按 `api/app/tasks.py:752-760` 的写法建隐式 OPERATOR Plan 与 revision 1（APPROVED）；插 `task_work_orders`；建三个 Task（`task_key` 分别 `gbp-post-draft-v1`、`gbp-post-review-v1`、`gbp-post-publish-v1`，`parameters_json` 带 `work_order_id`，草稿另带 `version: 1`）；写两条 `task_dependencies`（审核依赖草稿、发布依赖审核）；写三条 `task_assignments`（草稿→内容 Agent 的本地注册 id、审核→当前操作员 HUMAN、发布→SYSTEM 用 `assignee_type=NULL` 表示服务端持有）；写 `task_events`。任一步失败整体回滚。

`work_order_view` 返回 `steps[]` 四项（草稿 / 审核 / 发布 / 核验），每项 `{step, title, owner, task_id, status, status_label_zh, readiness, blocker, deliverable, updated_at}`；`versions[]` 给历次草稿与审核；`current_action` 是 `{who, what, task_id}`，指出现在需要谁做什么。核验步没有独立 task_id，读发布 Task 最近一条 `VERIFICATION` attempt。

派生工作单状态（spec §5.1）：任一成员 `NEEDS_ATTENTION` → `需要处理`；全 `CANCELLED` 或工作单已取消 → `已取消`；否则按草稿/审核/发布的进度取 `草稿中 / 待审核 / 待发布 / 发布中 / 核对中 / 已上线`。

- [ ] **Step 1: 失败测试**：创建后恰好 3 个 task、2 条依赖、1 个工作单；审核 Task 的 blocker 是 `UPSTREAM_NOT_DONE`；发布 Task 的 blocker 也是 `UPSTREAM_NOT_DONE`（依赖优先于授权）；`location_id` 不属于该商户时 422 且**库里没有残留**（回滚测试）；`work_order_view` 的 `current_action.who` 在初始状态是内容 Agent；取消后所有非终态任务变 `CANCELLED`。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: create GBP work orders as one transaction`

---

### Task 5: 请求组装与节假日

**Files:**
- Create: `api/app/gbp_calendar.py`、`api/app/gbp_post_contract.py`
- Test: `api/tests/test_gbp_post_contract.py`

**Interfaces:**
- Consumes: Task 3 的 `current_voice_profile`。
- Produces:
  - `us_federal_holidays(start: date, end: date) -> list[dict]`，每项 `{"id": "holiday:<iso>:<slug>", "kind": "HOLIDAY", "title", "starts_on", "ends_on"}`
  - `build_post_request(conn, task, merchant, work_order) -> dict`，产出 `seo_ops.gbp_post_request.v1`
  - `parse_post_draft(payload) -> PostDraft`，严格解析 `seo_ops.gbp_post_draft.v2`
  - `DRAFT_SCHEMA_VERSION = "seo_ops.gbp_post_draft.v2"`

节假日用静态规则算，不联网：New Year's Day、MLK Day（1 月第三个周一）、Presidents' Day（2 月第三个周一）、Memorial Day（5 月最后一个周一）、Juneteenth、Independence Day、Labor Day（9 月第一个周一）、Columbus Day（10 月第二个周一）、Veterans Day、Thanksgiving（11 月第四个周四）、Christmas Day。取 `occurrence_at` 起未来 30 天内的。

请求按 spec 附录 A，但**按 §15.2 删掉 `photo_candidates` 的生图与上传来源**：候选只从该门店 `merchant_gbp_profiles.local_posts_json` 里已有帖子的 `media[].google_url` 提取，每项 `{"id": "post-media:<post_id>:<idx>", "url", "source": "FBR_POST", "authorized": true}`。`calendar_context` 只有节假日（第一版无 `merchant_promotions`）。`business_input_fingerprint` 是整个请求（去掉自身字段后）规范化 JSON 的 sha256，复用 `api/app/canonical_json.py` 的 `canonical_sha256`。

`parse_post_draft` 必须**严格**：未知键即报错；`outcome` 只允许 `ready` / `needs_input`；`ready` 时 `copy` 非空且 ≤1500 字符；`cta_type` 在 `NONE|BOOK|ORDER|SHOP|LEARN_MORE|SIGN_UP|CALL` 内；非 `NONE`/`CALL` 时 `cta_url` 必须是 `https://` 且**必须出现在请求的 `cta_targets` 里**（不允许模型编造链接）；`media` 若给了 `selected_candidate_id`，必须在本次 `photo_candidates` 的 id 集合里；`needs_input` 时 `missing_inputs` 非空。

- [ ] **Step 1: 失败测试**：2026 年 Labor Day 落在 9 月 7 日；窗口只返回 30 天内的；`build_post_request` 在无风格档案时抛；候选图只来自已有帖子且 URL 原样；同一输入两次组装的 `business_input_fingerprint` 相同；`parse_post_draft` 拒绝未知键、拒绝不在 `cta_targets` 里的 URL、拒绝不存在的 `selected_candidate_id`、拒绝 1501 字的 `copy`。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: assemble GBP post requests and parse drafts strictly`

---

### Task 6: 内容 Agent 交付物（本仓库文件，不上传）

**Files:**
- Create: `docs/agents/gbp-post/content-skill/SKILL.md`、`content-skill/references/authenticity.md`、`references/input-contract.md`、`references/output-contract.md`、`content-agent.json`
- Test: `api/tests/test_gbp_content_agent_config.py`

**Interfaces:**
- Produces: `content-agent.json`，字段与 `docs/agents/task-preparation-2026-09-08.json` 同构。模型 `deepseek-v4-pro`，temperature 0.1，`max_turns` 4，timeout 600，`enable_memory=false`，`response_schema` 强制 `seo_ops.gbp_post_draft.v2`。

Skill 正文的红线（吸收自「GooglePost每周图文助手」，去掉提问与排期）：严禁编造任何商家事实；不确定即不写；SEO 关键词不等于商家事实；只能引用 `calendar_context` 里的条目并把 id 写进 `evidence_references`；缺关键输入时返回 `outcome: "needs_input"` 并列出缺什么，**不提问、不猜**。第一版不生图：`photo_candidates` 非空时选一张 `authorized=true` 的并输出 `media.selected_candidate_id`；为空时 `media` 留空，**不得调用任何生图能力**。

- [ ] **Step 1: 失败测试**：`content-agent.json` 可解析；`tools` 为空、`skill_ids` 恰好一项、`subagent_ids` 为空、`enable_memory` 为 false；`response_schema` 的 `schema_version` 常量等于 `DRAFT_SCHEMA_VERSION`；SKILL.md 含「needs_input」且不含任何生图工具名。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 写文件。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: add GBP content agent skill package and config`

---

### Task 7: 草稿 Task 的执行

**Files:**
- Create: `api/app/gbp_draft.py`
- Modify: `api/app/task_agent_preparation.py`（把写死的 `PREPARE_ONLY` 与 `build_execution_input` 改为按模板分发）
- Test: `api/tests/test_gbp_draft.py`

**Interfaces:**
- Consumes: Task 5 的 `build_post_request` / `parse_post_draft`；现有 `task_agent_preparation` 的 trigger / attempt / dispatch_token 链路。
- Produces: `start_gbp_draft(conn, task_id, expected_version, operator, client)`、`reconcile_gbp_draft(conn, task_id, client)`。

**改造要点：`task_agent_preparation.start_agent_preparation` 现在把 `PREPARE_ONLY` 和 `tasks.build_execution_input` 写死在两处**（`task["task_type"] != "PREPARE_ONLY"` 的守卫，和 `input=tasks.build_execution_input(...)`）。改为查一张分发表：

```python
REQUEST_BUILDERS = {
    "PREPARE_ONLY": lambda conn, task, merchant: tasks.build_execution_input(task, merchant, tasks.latest_execution(conn, task["id"])),
    "GBP_POST_DRAFT": lambda conn, task, merchant: gbp_post_contract.build_post_request(conn, task, merchant, work_order_of(conn, task)),
}
```
守卫改为 `task["task_type"] not in REQUEST_BUILDERS`。**现有 `PREPARE_ONLY` 的行为必须逐字不变**，这是回归红线。

结果处理：run COMPLETED → `parse_post_draft`。`outcome == "needs_input"` → attempt FAILED，草稿 Task 转 `NEEDS_ATTENTION`，`missing_inputs` 落 `evidence_json`。`outcome == "ready"` → 在**一个事务**里写 `task_artifacts`（`schema_version`、`version` 取草稿 Task 参数里的 version、规范化 `artifact_json`、`checksum`）、把草稿 Task 转 `DONE`、把审核 Task 从 `PENDING` 转 `EXECUTING`、写两条 `task_events`。

- [ ] **Step 1: 失败测试**：`PREPARE_ONLY` 的现有测试全部仍绿（先跑一遍确认基线）；`GBP_POST_DRAFT` 触发后 attempt 落 `PREPARATION`；`needs_input` 时草稿进 `NEEDS_ATTENTION` 且**审核 Task 仍是 PENDING**；`ready` 时 artifact 落库、草稿 `DONE`、审核 `EXECUTING`；同一 run 重复对账不产生第二条 artifact（幂等）；artifact 写完后再 UPDATE 抛 `task_artifact_immutable`。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 `api/.venv/bin/python -m pytest tests/ -q`，全绿。
- [ ] **Step 5: Commit** `feat: run GBP draft tasks through the content agent`

---

### Task 8: 审核决定

**Files:**
- Create: `api/app/gbp_review.py`
- Test: `api/tests/test_gbp_review.py`

**Interfaces:**
- Produces: `submit_review_decision(conn, task_id, expected_version, decision, reason, operator) -> dict`。路由 `POST /api/tasks/{id}/review-decision`。

守卫：任务类型必须 `GBP_POST_REVIEW`；状态必须 `EXECUTING`；**当前登录者必须是该任务的 assignee**（`task_assignments` 里 `assignee_type='HUMAN'` 且 `operator_username` 等于当前登录者）；`decision` 只能 `APPROVED` / `RETURNED`；`RETURNED` 时 `reason` 必填非空。

`APPROVED`：读草稿 Task 最新 artifact，取 `checksum`、`media_fingerprint`（有选图时是候选 URL 的 sha256，无图时是固定串 `"none"`）、`cta_type`、`cta_url`、工作单 `location_id`；写 `task_approvals` 一行 `status='ACTIVE'`，`publish_window_start` = 现在，`publish_window_end` = 现在 + 7 天；审核 Task 转 `DONE`；把发布 Task 的 `parameters_json` 补上 `approved_artifact_checksum`。此后发布 Task 的 blocker 自然消失（Task 2 的 `_no_valid_approval` 查得到 ACTIVE 批准）。

`RETURNED`：写 `task_approvals` 一行 `status='RETURNED'` 带 `reason`；审核 Task 转 `DONE`；在**同一事务**里建草稿 v(N+1)（`replaces_task_id` 指向旧草稿，参数带 `version: N+1` 与 `reviewer_feedback`）与新的审核 Task；给发布 Task 加一条对新审核 Task 的依赖。旧 artifact 与旧审核记录保留只读。

- [ ] **Step 1: 失败测试**：非 assignee 提交 403；`RETURNED` 无理由 422；`APPROVED` 后 `task_approvals` 恰好一行 ACTIVE 且五要素与 artifact 一致；`APPROVED` 后发布 Task 的 blocker 为 None；`RETURNED` 后新增两个 Task 且发布 Task 依赖变成新审核 Task；`RETURNED` 后发布 Task 的 blocker 回到 `UPSTREAM_NOT_DONE`；批准记录改 `artifact_checksum` 抛 `approval_binding_immutable`；重复提交同一决定 409。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: bind GBP approvals to the exact reviewed version`

---

### Task 9: 发布（服务端直发，恰好一次）

**Files:**
- Create: `api/app/gbp_publish.py`
- Modify: `api/app/fbr_gbp.py`（新增写方法与 audit 搜索）
- Test: `api/tests/test_gbp_publish.py`

**Interfaces:**
- Produces:
  - `FbrGbpClient.search_audits(fbr_merchant_id, place_id) -> list[dict]`（`PUT /seo/audit`）
  - `FbrGbpClient.create_location_post(fbr_merchant_id, location_id, payload) -> dict`（`POST /gbp/location/{id}/post`）
  - `start_publish(conn, task_id, expected_version, operator, client) -> dict`

**这是全系统唯一一处外部写，按 Global Constraint 5 严格执行。**

顺序不可调换：

1. 复核批准（spec §9.1 末条）：grant `ACTIVE`、未过期、`artifact_checksum` 与当前 artifact 一致、`media_fingerprint` 一致、`location_id` 一致、grant 的 `operator` 与审核 Task 的 assignee 一致。任一不符 → 发布 Task 转 `NEEDS_ATTENTION`，**不发布**，并把 grant 置 `INVALIDATED`。
2. 解析 `audit_id`：`search_audits` 取 `generated_time` 最新一条。没有 → `NEEDS_ATTENTION`，blocker 说明 `FBR_AUDIT_MISSING`，**不自动 saveAudit**。
3. 构造请求体，字段**逐字取自已批准的 artifact**，不做任何改写：
   ```python
   payload = {"audit_id": audit_id, "topic_type": "STANDARD", "language_code": "en",
              "summary": artifact["copy"]}
   if artifact["cta_type"] not in ("NONE",):
       payload["call_to_action"] = {"action_type": artifact["cta_type"], "url": artifact.get("cta_url")}
   if selected_media_url:
       payload["media"] = [{"media_format": "PHOTO", "source_url": selected_media_url}]
   ```
4. 先落库：`task_executions` 一行 `stage='PUBLICATION'`、`status='DISPATCHING'`、`executor_type='SYSTEM'`、`request_json` 为上面的 payload、`request_checksum`、`idempotency_key = f"workorder:{wo}:publish:{attempt}:{checksum[:16]}"`。commit。发布 Task 转 `EXECUTING`。
5. 再发出。返回 `post_id` → 记 `provider_resource_id`，attempt `SUCCEEDED`，发布 Task 转 `VERIFYING`。
6. **任何其他结果**（超时、非 2xx、无 `post_id`、连接中断）→ attempt `UNKNOWN`，发布 Task 仍转 `VERIFYING`，由核验判定。**绝不重发。**

唯一允许重发的情形：能证明请求从未离开本机（连接建立前失败），且同一 `idempotency_key` 尚未成功，限 2 次。这个判断写在 `gbp_publish.py` 里并有独立测试。

- [ ] **Step 1: 失败测试**（FBR 客户端用 stub）：批准过期时不发且转 `NEEDS_ATTENTION`；artifact 被改过时不发且 grant 转 `INVALIDATED`；无 audit 时不发；正常路径下 payload 的 `summary` 与 artifact 的 `copy` **逐字节相同**；先落库后发出（stub 在被调用时断言 `task_executions` 已有该行）；stub 抛超时 → attempt `UNKNOWN` 且任务进 `VERIFYING` 且 stub **只被调用一次**；重复调用 `start_publish` 时 409 不产生第二次外部调用。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: publish approved GBP posts from the server exactly once`

---

### Task 10: 远端核验

**Files:**
- Create: `api/app/gbp_verify.py`
- Modify: `api/app/fbr_gbp.py`（`get_location_post`）
- Test: `api/tests/test_gbp_verify.py`

**Interfaces:**
- Produces: `FbrGbpClient.get_location_post(fbr_merchant_id, location_id, post_id) -> dict`、`verify_publication(conn, task_id, client) -> dict`、`BACKOFF_MINUTES = (1, 5, 15, 60, 60, 60)`

按 spec §15.4 的裁定：**优先 `getLocationPost` 按 `post_id` 精确取**，`provider_resource_id` 为空（发布结果未知）时才退回 `listLocationPosts?limit=20` 逐条匹配。

规范化：换行统一 `\n`，只去首尾空白，**不改内部空格与 URL**。匹配条件：`summary` 与已批准 artifact 的 `copy` 相同，且 `call_to_action.action_type` 相同，且非 `CALL` 时 `url` 相同。

结果：
- 唯一匹配且 `state == "LIVE"` → 发布 Task `DONE`，`evidence_json` 记读回快照与匹配依据。
- `PROCESSING` / `SCHEDULED` → 保持 `VERIFYING`，`next_attempt_at` 按退避表排下一次。
- 无匹配 / 多匹配 / `REJECTED` / 退避用尽 → `NEEDS_ATTENTION`，`evidence_json` 附完整读回列表。
- 每次核验都是一条新的 `VERIFICATION` attempt（`executor_type='SYSTEM'`），只读，手动「重新核对」无次数限制。

- [ ] **Step 1: 失败测试**：精确取到且 LIVE → `DONE`；取到但 `PROCESSING` → 仍 `VERIFYING` 且 `next_attempt_at` 是 1 分钟后；第六次退避后仍 `PROCESSING` → `NEEDS_ATTENTION`；`REJECTED` → `NEEDS_ATTENTION`；`provider_resource_id` 为空时走列表且找到唯一匹配 → `DONE`；列表里两条内容完全相同 → `NEEDS_ATTENTION` 且证据里有两条；正文只差一个内部空格 → **不算匹配**；核验永远不调用任何写方法（stub 断言）。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑，绿。
- [ ] **Step 5: Commit** `feat: verify GBP publication by exact read-back`

---

### Task 11: HTTP 路由

**Files:**
- Create: `api/app/gbp_api.py`
- Modify: `api/app/main.py`
- Test: `api/tests/test_gbp_api.py`

**Interfaces:**
- Produces:
  - `POST /api/merchants/{id}/work-orders` `{kind, location_id, topic}`
  - `GET /api/work-orders/{id}`
  - `POST /api/tasks/{id}/review-decision` `{expected_version, decision, reason?}`
  - `POST /api/tasks/{id}/publish` `{expected_version}`
  - `POST /api/tasks/{id}/verify`
  - `POST /api/work-orders/{id}/cancel` `{reason}`
  - `GET /api/merchants/{id}/voice-profile`、`PUT /api/merchants/{id}/voice-profile`

全部要求登录。全部 GBP 路由在 `SEO_OPS_GBP_POST_ENABLED` 关闭时返回 404（不是 403——关闭时这些能力在这个 build 里不存在）。写操作全部带 `expected_version` 乐观锁，冲突返回 409 且消息可直接展示。

- [ ] **Step 1: 失败测试**：开关关闭时六个路由全 404；开关打开且未登录 401；`expected_version` 不匹配 409；`GET /api/work-orders/{id}` 返回四步且 `current_action` 存在；跨商户越权访问 404。
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 `api/.venv/bin/python -m pytest -q`，全绿。
- [ ] **Step 5: Commit** `feat: expose GBP work order routes behind a feature flag`

---

### Task 12: 工作单页

**Files:**
- Create: `web/src/pages/WorkOrder.tsx`、`web/src/components/work-order/WorkOrderPipeline.tsx`、`ReviewPanel.tsx`、`VerificationEvidence.tsx`、`web/src/workOrderTypes.ts`
- Modify: `web/src/App.tsx`、`web/src/api.ts`、`web/src/index.css`
- Test: `web/src/WorkOrder.test.tsx`

**Interfaces:**
- Consumes: Task 11 的路由。
- 路由 `/work-orders/:id`。

页面结构（spec §13）：标题「GBP 内容工作单 · {主题} · {商户}」；主区一条竖向流水线四步，每步显示负责人、中文状态、交付物、时间；**当前需要动作的一步默认展开，其余折叠**。首屏 = 当前产物 + 现在需要谁做什么；依据、历史、技术 trace 折叠在后面。

第 ② 步展开即审核视图：完整正文不截断；选中的图片及来源标注；CTA 类型与真实目标网址；目标门店；版本号与 artifact checksum；两个按钮「批准这一版」与「退回并说明」。批准走 `ConfirmDialog`，文案逐字用 spec 附录 C：「批准后系统会把帖子 v{N} 写入 Google 门店 {门店}。发布后不能退回草稿，修改或撤下需要新建补偿任务。确认？」——**注意按 R-1 把原文的「发布 Agent」改为「系统」**。退回要求填理由，提示语用附录 C 原句。

第 ④ 步显示最近一次核验的状态与证据。发布结果未知时显示「上次发布结果未知，需要你核验」，主按钮「开始核验」，次按钮「查看读回列表」，并显示「不会自动重发」。

宽内容（读回列表）放进自带 `overflow-x: auto` 的容器。

- [ ] **Step 1: 失败测试**（Vitest + `fireEvent`）：四步都渲染且只有当前步展开；审核步展示的正文与接口返回**逐字相同**（不截断）；点「批准这一版」先出确认框、确认后才发请求；点「退回并说明」在理由为空时按钮禁用；发布结果未知时出现「不会自动重发」；核验证据区渲染读回快照。
- [ ] **Step 2:** `cd web && npx vitest run src/WorkOrder.test.tsx`，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 `npx vitest run` 与 `npx oxlint`，全绿。
- [ ] **Step 5: Commit** `feat: add the GBP work order page`

---

### Task 13: 入口与筛选

**Files:**
- Modify: `web/src/pages/MerchantProfile.tsx`（风格档案卡、新建工作单表单）、`web/src/pages/TasksOverview.tsx`（两个新 blocker 选项）、`web/src/components/TaskTable.tsx`（工作单跳转）、首页卡片组件
- Test: 各自的 `.test.tsx`

**Interfaces:**
- Consumes: Task 11 的路由。

`TasksOverview.tsx` 的 `BLOCKER_OPTIONS` 必须加 `['VOICE_PROFILE_MISSING', '缺风格档案']` 与 `['AWAITING_VALID_APPROVAL', '等待有效批准']`，否则查询串里的新值会被 `readFilter` 静默丢掉（这个 helper 是上一轮刚加的，行为是「不认识就丢」）。

首页「需要我决定」：审核 Task 卡只留结论、影响、操作三行加 80 字预览，标注「完整内容在审阅页」，主按钮「审阅草稿」跳工作单；**不提供「批准并发布」**。

- [ ] **Step 1: 失败测试**：新 blocker 值在查询串里能存活一次往返；审核卡没有「批准并发布」按钮；「审阅草稿」跳到 `/work-orders/:id`；商户页在无风格档案时「新建工作单」按钮禁用并提示「该商户尚未填写风格档案，内容 Agent 无法开始。」
- [ ] **Step 2:** 跑，红。
- [ ] **Step 3:** 实现。
- [ ] **Step 4:** 跑 `npx vitest run`，全绿。
- [ ] **Step 5: Commit** `feat: add GBP work order entry points`

---

### Task 14: 上线内容 Agent 并跑一张真实工作单

**这个任务对外部系统产生真实写入，分两段，中间有一个必须停下的闸门。**

**Files:**
- Create: `docs/agents/gbp-post/2026-09-10-readback.md`、`docs/operations/gbp-work-order-v1-pilot.md`
- Modify: `api/.env`（不进 git）

**第一段：内容 Agent 上线（对 Core AI 写，不碰商户）**

按 `docs/agents/task-preparation-2026-09-08-readback.md` 的惯例：
1. 先按目标名称查重，确认 `total=0`。
2. `POST /api/skills` 提交内容 Skill（body 用 §15.1 确认的 download 形状），`GET` 读回比对 `digest`。
3. `POST /api/agents` 一次，`GET` 按返回 ID 读回，逐字比对 prompt、`response_schema`、模型与限制参数。
4. `POST /api/agents/{id}/publish` 一次，再独立 `GET` 读回确认 `PUBLISHED`。
5. 记录配置文件 SHA-256 与远端快照散列到 `2026-09-10-readback.md`。
6. 写 `.env`：`SEO_OPS_GBP_POST_CONTENT_AGENT={"coreai_agent_id":"…","config_sha256":"…"}`、`SEO_OPS_GBP_POST_ENABLED=true`。

- [ ] **Step 1:** 查重，确认无同名 Agent。
- [ ] **Step 2:** 上传 Skill，读回比对 digest。
- [ ] **Step 3:** 建 Agent，读回逐字比对。
- [ ] **Step 4:** 发布，独立读回确认 PUBLISHED。
- [ ] **Step 5:** 写 readback 记录并 commit（`.env` 不进 git）。

**第二段：真实工作单（对 Choice Brooklyn 的公开主页写）**

- [ ] **Step 6:** 备份数据库到 `data/seo-ops-v3.backup-<stamp>.db`，用 `api/.venv/bin/python` 加载 `app.db` 跑 `PRAGMA integrity_check`（裸 CLI 不行，见 Global Constraint 4）。
- [ ] **Step 7:** 给 merchant 3 填风格档案（真实语气，参考该门店已有 14 条帖子的写法）。
- [ ] **Step 8:** 建工作单：merchant 3、location `24300588970198995`、topic 由用户给或取一个与现有帖子不重复的主题。
- [ ] **Step 9:** 触发草稿，等内容 Agent 返回，确认 artifact 落库、审核 Task 进 `EXECUTING`。
- [ ] **Step 10: 闸门 —— 停下。** 把草稿的**确切正文、CTA 类型与目标网址、目标门店、是否带图**原样交给用户，等待用户逐字确认。**在用户明确确认之前，不得批准、不得发布。** 用户要求改则走「退回并说明」，让内容 Agent 出下一版，再回到本闸门。
- [ ] **Step 11:** 用户确认后，在工作单审核视图里批准这一版。
- [ ] **Step 12:** 触发发布，观察 attempt 落库先于外部调用，记录 `post_id`。
- [ ] **Step 13:** 核验：`getLocationPost` 精确读回，确认 `state == LIVE` 且正文逐字匹配，发布 Task 转 `DONE`。**记录从创建到 LIVE 的实际时长，回填 spec §15.4 的退避表。**
- [ ] **Step 14:** 写 `docs/operations/gbp-work-order-v1-pilot.md`：每一步的时间、id、散列、读回快照，以及回滚办法（关 `SEO_OPS_GBP_POST_ENABLED` 即完整回滚本地能力；已发布的帖子只能用 `deleteLocationPost` 手动撤下，这是外部写不可自动回滚的部分）。
- [ ] **Step 15: Commit** `docs: record the first real GBP work order run`

---

## Self-Review

**Spec 覆盖：** §5.1 三模板 → Task 2；§5.3 参数 → Task 4；§7 请求组装 → Task 5；§8 草稿 → Task 7；§9.1 审核 → Task 8；§9.2 发布 → Task 9（按 R-1 改为服务端直发）；§10 核对 → Task 10；§11 数据模型 → Task 1（按 §15.2 去掉 `task_media` / `merchant_photos` / `merchant_promotions`）；§12 API → Task 11；§13 UI → Task 12、13；§6 Agent → Task 6、14。

**已知未覆盖（有意，且都有出处）：** OFFER / EVENT 帖子、排期日历、图片子系统（§15.2）、「转交给…」（§15.6）、`merchant_promotions`、发布 Agent 路径（R-1，留作下一增量）、Orchestrator `CREATE_TASK` 入口（第一版只做商户页手建与 Plan 物化两个入口中的手建；Plan 物化在 `task_plan_contract` 放行 `GBP_POST` 后自然可用，但不单独做验收）。

**类型一致性：** `DRAFT_SCHEMA_VERSION` 在 Task 5 定义、Task 6 与 Task 7 消费；`build_post_request` / `parse_post_draft` 签名在 Task 5 定义、Task 7 消费；`create_work_order` / `work_order_view` 在 Task 4 定义、Task 11 与 12 消费；两个 blocker code 在 Task 2 定义、Task 13 的前端选项消费。

**风险最高的三处：** Task 7 改动 `task_agent_preparation` 会碰到已在生产路径上的 `PREPARE_ONLY`（回归红线已写进步骤）；Task 9 是唯一外部写（顺序与「绝不重发」已写死）；Task 14 第二段动真实商户（闸门已写死在 Step 10）。

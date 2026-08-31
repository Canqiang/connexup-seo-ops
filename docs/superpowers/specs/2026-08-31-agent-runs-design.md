# SEO Ops 第二块砖设计 — Agent 跑批（core-ai-server 集成）

日期：2026-08-31
状态：设计已在会话中确认，待书面评审
前置：第一块砖（商户台账+任务工单，`2026-08-31-seo-ops-rebuild-slice1-design.md`）已合入 main

## 目标

让商户的 SEO 分析由 core-ai-server 上的 agent 完成：人工或按周期自动发起一次 agent run，run 产出报告，系统把报告中的 plan 条目自动解析成带 `rationale` 的待办任务，供运营审核后执行。

## 约束与红线

- **不改 core-ai 的任何代码和数据**，只调用其 API：`POST /api/runs/agent/{agent_id}/trigger` → `{run_id,status}`、`GET /api/runs/{run_id}`（轮询 + 取产物）。
- **EXECUTE/VERIFY 永不自动触发**：本系统的自动化止步于"创建 todo 任务"（提案）；状态流转永远由人在页面上操作。
- agent 未定，`COREAI_AGENT_ID` 走配置，随时可换。
- 单商户同时最多一个进行中 run（重复发起返回 409）。

## 配置

`api/.env`（gitignored，提交 `api/.env.example`）：

| 变量 | 说明 |
|---|---|
| COREAI_BASE_URL | 如 `https://core-ai-server.connexup-uat.net` |
| COREAI_API_KEY | Bearer token（Mongo `core-ai.users.api_key`；v2 旧值可从 `_to_delete/v2-leftovers/server/.env` 找） |
| COREAI_AGENT_ID | 要触发的 agent id |

FastAPI 启动时读取；缺失时 run 相关接口返回 503（台账功能不受影响）。

## 数据模型变更

`merchants` 加列：

| 字段 | 类型 | 说明 |
|---|---|---|
| auto_run_interval_days | INTEGER | 自动分析周期（天），NULL=关闭（默认） |

新表 `runs`：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| merchant_id | INTEGER FK → merchants | 所属商户 |
| coreai_run_id | TEXT | core-ai 侧 run id，可空（触发失败时无） |
| status | TEXT | `running` / `succeeded` / `failed` |
| trigger | TEXT | `manual` / `auto` |
| report_text | TEXT | 产物全文，可空 |
| error | TEXT | 失败原因，可空 |
| created_at | TEXT | UTC ISO |
| finished_at | TEXT | 可空 |

`tasks` 加列：

| 字段 | 类型 | 说明 |
|---|---|---|
| source_run_id | INTEGER FK → runs | 来源 run；人工建任务为 NULL |
| source_key | TEXT UNIQUE | 幂等键 `plan-{coreai_run_id}-{itemId}`，人工建任务为 NULL |

schema 变更直接改 `api/schema.sql`（CREATE TABLE IF NOT EXISTS + 对已有表用 ALTER TABLE ... ADD COLUMN 的幂等启动迁移，写在 init_db 里，列存在即跳过）。

## 解析契约

agent 产物文本中须包含一个 ```json 代码块，内容为：

```json
[{"id": "item-1", "title": "...", "rationale": "...", "description": "..."}]
```

- `id`、`title`、`rationale` 必填，`description` 可选。
- 每条生成一个 `todo` 任务：title/rationale/description 落对应字段，`source_run_id`、`source_key` 落来源。
- `source_key` 唯一冲突时跳过该条（幂等，重复解析不重复建任务）。
- 产物中找不到合法 JSON 块：run 仍标 `succeeded`，报告可读，不建任务——格式问题不丢报告。
- 实现完成后需拿真实 agent 验证一次输出格式；对不上时在 core-ai 平台上调整 agent 的输出约定（不改代码）。

## 流程

1. **手动发起**：`POST /api/merchants/{id}/runs` → 校验无进行中 run → 调 core-ai trigger → 存 `runs(status=running, trigger=manual)`。core-ai 调用失败 → 存 `failed` + error。
2. **轮询**：后台循环每 30 秒对所有 `running` 的 run 调 `GET /api/runs/{coreai_run_id}`；完成 → 取产物存 `report_text` → 解析建任务 → 标 `succeeded` + finished_at；core-ai 报失败 → 标 `failed` + error。
3. **自动发起**：后台循环每小时扫描一次：`status=active` 且 `auto_run_interval_days` 非空的商户，若无进行中 run 且（从未跑过 或 最近一次 run 的 finished_at 距今 ≥ 周期天数）→ 以 `trigger=auto` 发起。
4. 后台循环用 FastAPI lifespan 里的 asyncio task 实现，单进程部署（uvicorn 单 worker）为前提；多 worker 部署会重复调度，暂不支持。

## 接口

- `POST /api/merchants/{id}/runs` → 201 run JSON；进行中冲突 409；core-ai 未配置 503
- `GET /api/merchants/{id}/runs` → 该商户 run 列表（倒序，不含 report_text）
- `GET /api/runs/{id}` → run 详情（含 report_text）
- `PATCH /api/merchants/{id}` 扩展：接受 `auto_run_interval_days`（正整数或 null）

## 前端

商户详情页新增：

1. **发起分析按钮**：进行中时禁用并显示状态（每 10 秒轮询商户 run 列表刷新）。
2. **自动周期下拉**：关闭 / 7 天 / 30 天（写 `auto_run_interval_days`）。
3. **Run 历史列表**：时间、触发方式、状态；点开跳 run 详情页看报告全文（`<pre>` 纯文本渲染）。

任务列表中来自 run 的任务显示一个"AI"小标记（`source_run_id` 非空）。新增 run 详情页路由 `/runs/:id`。

## 测试

- core-ai 客户端注入假实现（测试不打真 UAT）。
- 单测：解析器（合法块、缺字段、无块、幂等冲突）、调度判定（到期计算、并发守卫）、runs 接口（409/503/404）。
- 全链路：假 core-ai 走通 发起→轮询完成→解析→任务出现（带 source 标记）。
- 前端仍只要求 `npm run build` 通过。

## 明确不做

- run 取消、失败自动重试
- 报告结构化展示（先纯文本）
- 多 agent 编排、webhook/SSE
- 多 worker 下的分布式调度

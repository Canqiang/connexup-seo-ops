# seo-ops 交接文档（截至 2026-09-01）

给下一个开发会话的完整交接：系统是什么、做到哪了、还有什么没做、从哪继续。

## 系统一句话

商户本地 SEO 运营台账：商户 → AI 分析（core-ai agent 跑批）→ 生成带依据的任务提案 → **人工授权**（可批量）→ 人工执行留痕。红线：EXECUTE/VERIFY 永不自动触发，自动化止步于创建 todo 任务。

## 背景

v2（33k 行 TS、13 前端模块、35 服务）因过度复杂于 2026-08-28 放弃，代码在 `backup/main-2026-08-28-design-canvas` 分支和 `_to_delete/seoops-v2-0826.tgz`。重建原则：**一次一块砖**、概念极简、前后端分离、AI 一律走 core-ai-server 的 API（不改其代码）。

## 架构

- `api/`：Python + FastAPI + SQLite（库 `data/seo-ops-v3.db`，schema 单文件 `api/schema.sql` + `init_db` 幂等 ALTER 迁移，无 ORM）。venv 在 `api/.venv`。
- `web/`：React + Vite + TS，开发期 `/api` 由 Vite 代理到 :8000（无 CORS）。
- AI：core-ai-server UAT 的异步 run API（trigger → 30 秒轮询）；调度器是 FastAPI lifespan 里的 asyncio 循环（**单 uvicorn worker 前提**，多 worker 会重复调度）。
- 配置：`api/.env`（**gitignored**，已配好三个变量）。运行：`uvicorn app.main:app --reload --port 8000 --env-file .env`。完整运行说明见 `README.md`。

## 已完成

### 砖 1：商户台账 + 任务工单（已合 main）
商户 CRUD（归档/删除守卫 409）、任务状态机（todo→doing→done，todo/doing→cancelled，非法流转 422）、证据回填。
Spec：`docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md`

### 砖 2：AI 跑批（已合 main）
runs 表 + 手动/每商户周期自动发起、core-ai 客户端（token 只进 Authorization 头）、报告解析成任务（幂等键 `plan-{coreai_run_id}-{itemId}`，UNIQUE 部分索引）、失败不丢报告。core-ai 未配置时 run 接口 503、台账不受影响。
Spec：`docs/superpowers/specs/2026-08-31-agent-runs-design.md`

### 专属 Agent（core-ai UAT 平台上，已发布）
**[SEO Ops v3] Merchant Analyst v1**，id `423010a0-d80c-4e62-affe-d384bb616d65`，deepseek-v4-pro，temperature 0.1。
输出契约（prompt 已多轮加固）：中文 markdown 报告 + 末尾闭合的 ```json 块，数组项：
`{id, title, rationale(必), expected_outcome(必), category(六枚举,必), start_after_days(非负整数,必), description?}`
已修过的真实输出问题：JSON 内英文引号（规则：引用用「」）、围栏未闭合（解析器也做了容错）。
改 agent 用 `PUT /api/agents/{id}` + `POST /api/agents/{id}/publish`（token 同 `api/.env`）。

### 任务模型（当前字段）
`rationale`（为什么做）+ `expected_outcome`（预期效果）+ `category`（gbp/content/review/citation/technical/other）+ `scheduled_start`（agent 输出相对天数→落库绝对 UTC；真跑验证 agent 会按依赖阶梯排期）+ `source_run_id/source_key`（溯源）+ `evidence_note`（执行留痕）。

### 界面（台账视觉系统 + 全站表格化）
- 视觉：瓷灰底/白卡/墨蓝主色/戳记状态徽标/深墨顶栏（用户明确偏好：**运营界面要表格不要卡片**；版心 1080px）
- 商户列表 = 工作队列表（待办/进行中数、最近分析、自动周期）——后端列表接口带聚合子查询
- 商户详情：状态统计条（点击筛选）、run 历史折叠、建任务折叠、任务总表
- `/tasks` 任务总览：跨商户总表（商户列）+ 全局状态/类别筛选 + **勾选批量授权**（`POST /api/tasks/batch`，非法流转跳过并报数）
- 行内流转按钮（开始/完成/取消），操作后行不跳位；取消行标题划线
- run 详情：markdown 渲染报告（react-markdown）+ 本次生成任务表；任务↔run 双向溯源
- 时间统一 `web/src/format.ts` 本地格式；标签映射统一 `web/src/labels.ts`；共享表组件 `web/src/components/TaskTable.tsx`

### 质量现状
- 后端 pytest **65/65**（`cd api && .venv/bin/python -m pytest tests`）；前端约定 build-only（`cd web && npm run build`）
- 全程 TDD + 每块砖过独立评审；测试不打真 core-ai（假客户端 + MockTransport，conftest 清空 COREAI_* 环境变量）

## 未做 / 待办（按优先级建议）

1. **执行 agent 砖（用户明确的方向）**：任务将来交 agent 自动执行。**接口约定已谈定**：人工授权（待办→进行中，可批量）是闸门；执行 agent 领活判据 = 已授权 + `scheduled_start` 已到。未设计未实现——开工前先走设计确认。
2. **给 agent 喂真实数据**（用户已提）：现在 `build_input` 只有商户名+备注，agent 满篇"信息不足"。两条路线：a) 我方逐砖累积数据后加进输入；b) 平台侧给 agent 挂工具自己拉 GBP/GSC/audit（v2 的 unified-agent 模式）。建议与砖 3 一起设计。
3. **砖 3：ranking 快照**（路线图既定，未设计）。
4. **相似任务去重**（用户提过的痛点）：幂等键按 run 算，连跑多次会堆相近待办。候选：新 run 自动取消上一轮未授权的 AI 任务 / 语义去重。未决策。
5. **递延小项**（历次评审确认可延）：runs 进行中守卫是 check-then-act（durable 修法：`CREATE UNIQUE INDEX ... ON runs(merchant_id) WHERE status='running'`）；`get_coreai` 进程内缓存配置；NaN 路由参数走普通错误路径；人工建任务表单没有 scheduled_start 输入。
6. **部署**：无登录/权限（UAT 部署前必须加）；UAT 发布流程未建（v2 的发布计划已随归档作废）。
7. **git 远端**：main 本地领先 origin/main 若干提交（用户此前自行 push 过一次），推送需用户决定。

## 工作方式约定（本仓库的既定节奏）

- 每块砖/每个特性：设计确认 → （大块走 spec+plan+subagent 流程，小块直接 TDD）→ 分支开发 → 真跑验证（agent 契约改动必须真跑一次）→ 合并前跑全量测试 → 询问用户后合回 main。
- 改 agent 契约 = 三处同步：`api/app/plan_parser.py` + 平台 prompt（PUT+publish）+ 真跑验证。
- 项目记忆（auto-memory）里有浓缩版状态，和本文档互为备份。

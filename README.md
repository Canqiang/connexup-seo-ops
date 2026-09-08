# connexup-seo-ops

商户 SEO 运营台账（重建版，一次一块砖）。当前系统覆盖商户台账、AI 分析、Task Plan 审批和依赖感知的正式 Task 操作。
设计文档：docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md、docs/superpowers/specs/2026-08-31-agent-runs-design.md 与 docs/superpowers/specs/2026-09-02-agent-generated-task-dependencies-design.md

## 结构

- `api/` — FastAPI + SQLite 后端（库文件 `data/seo-ops-v3.db`，schema 见 `api/schema.sql`）
- `web/` — React + Vite + TS 前端（开发期 `/api` 代理到 8000）

## Plan、Task 与内容准备

- 商户详情页可手动发起分析，或设置每商户自动周期（7/30 天）；后台每 30 秒轮询进行中的 Run，每小时扫描到期商户。
- 成功的分析 Run 可以产生严格、版本化的 Task Plan 草案。草案不是正式 Task：操作人可以逐项修改，只有整份 revision 通过校验并由人工批准后，服务端才原子物化对应 Task 和依赖边。
- 逻辑 Plan 使用 `OPEN`、`REJECTED`、`CLOSED`；其不可变 revision 使用 `DRAFT`、`APPROVED`、`REJECTED`、`SUPERSEDED`。批准新 revision 不会静默改写已开始或已完成的 Task 历史。
- Task 间依赖只表达“所有上游必须为 `DONE`”。队列展示服务端计算的 `READY` / `BLOCKED` 和一个首要阻塞原因，详情保留完整上下游链路；客户端不能直接写 readiness 或完成状态。
- Phase 1 正式启用的模板是 `PREPARE_ONLY`：`PENDING -> PREPARING -> AWAITING_APPROVAL -> DONE`。`EXECUTING`（发布中）和 `VERIFYING`（验证中）目前只作兼容展示，外部发布与真实回读验证属于后续阶段。
- 诊断/Plan 入口优先使用 `COREAI_ORCHESTRATOR_AGENT_ID` 指定的 Core AI Agent；未配置或为空白时兼容 `COREAI_AGENT_ID`。手动和定时入口使用同一解析规则。内容准备仍通过 `COREAI_PREPARATION_LLM_CALL_ID` 调用 Core AI 已发布的 LLM Call 定义。SEO Ops 不修改 Core AI 仓库中的 Agent 或 LLM Call 定义。
- 当前 Orchestrator 接入仅用于提出 `PREPARE_ONLY` 计划草稿，不代表已支持自主分派、修改任务或公开发布。原有无工具/Skill/子 Agent 等安全预检保持不变，不符合要求的 Agent 会被拒绝；计划仍须人工审批。只配置 ID 不等于远端 Agent 已通过真实验证。
- Agent 工作台会播种显式配置的 Orchestrator；新旧配置指向同一外部 ID 时不会重复播种。已有注册名称、角色和 Run 历史不会被自动改写，因此已注册的同 ID Agent 可能仍显示原名称；两项配置指向不同 ID 时可分别保留注册。
- Preparation LLM Call 是无工具内容准备：不加载 Agent Tool、Skill、Sub-agent、Memory、Sandbox 或 Dataset，也不接收附件。它只能生成草稿、审计和操作建议，不能发布或修改任何外部系统。
- 每次准备都会创建独立 Attempt。只有符合本地严格结构且声明未外写的 `SUCCEEDED` 结果可供审批；审批和退回精确绑定 Task version、execution id 与 result checksum。
- 网络超时或服务端错误会记为 `UNKNOWN`，不会被当成成功。操作人确认后才能创建新的准备 Attempt，并会看到可能重复产生模型成本的提示；这个阶段仍没有外部业务写入。
- 人工批准 `PREPARE_ONLY` 结果只会完成该内容准备 Task，不会发布，也不会验证外部资源。

## 操作人 Task 操作

- **新增：** 商户页创建普通独立 `PREPARE_ONLY` Task；标题、动因和预期效果必填，计划时间按带时区 ISO 时间提交。
- **修改：** 正式 Task 只允许更新负责人、内部标签和操作人备注。执行定义与依赖必须回到对应 Plan revision 修改，不能在 Task 上原地覆盖。
- **取消：** UI 使用“取消任务并保留历史”，要求填写原因并携带 expected version；不存在物理删除或直接标记 `DONE` 的操作。
- **查询：** 任务总览使用服务端状态、readiness、blocker 和来源过滤，并在写操作后读取 TaskDetail，以服务端返回的 version 为准。
- 所有写操作都使用乐观锁；版本或审批对象变化的 `409` 会要求刷新，其他安全拒绝会保留服务端原因，任何 `409` 都不自动重试。Attempts 与 Task events 是 append-only 审计历史。

## FBR / GBP 只读资料

- 商户页的“商户资料”通过 SEO Ops 后端读取 FBR / Operation Assistant 暴露的只读 GBP 信息，浏览器不会直连 FBR。
- `FBR_SEO_BASE_URL` 指向 GBP 数据入口。当前 UAT 使用 Operation Assistant，配置 `FBR_SEO_API_STYLE=operation_assistant`；以后直接接 SEO Integration 时使用 `seo_integration`。如服务要求服务端鉴权，可通过 `FBR_SEO_BEARER_TOKEN` 注入只读调用凭证。
- SEO Ops 只保存明确绑定的 FBR Merchant ID、GBP 资源 ID 和当前资料快照；不会保存或返回 Google access token / refresh token。
- 同步失败会保留上一次成功快照，不会修改 FBR 或 Google 的任何数据。

## 关键词与 Local Falcon

- 页面加载和“从 FBR 重新读取”只读 FBR 已落库关键词；库为空时返回空态，不会自动启动 Agent。
- “重新生成关键词并评分”是独立的人工操作。它只会调用由 `COREAI_KEYWORD_SKILL_AGENT_ID` 指定的专用 Agent，并在触发前校验该 Agent 同时绑定 `COREAI_KEYWORD_SEED_SKILL_ID` 与 `COREAI_KEYWORD_RANKING_SKILL_ID`。
- 生成结果只有在 Core AI trace 能读回两项 Skill 各调用一次、均成功且顺序为 Seed → Ranking 时，才可进入候选 Top 20。Skill 目前是 Agent 指令而非独立可执行函数，因此这项校验能证明实际加载顺序，不能替代运营人员对关键词与评分的复核。
- Local Falcon 新扫描会冻结评分 Top 20、Place ID 与扫描参数；运营人员需要先审批关键词批次，再二次确认可能消耗 credits 的提交。页面上的“只同步已有报告”不会创建新扫描。
- `COREAI_LOCAL_FALCON_TOOL_ID` 指向 Core AI 中的 Local Falcon 工具。任何缺失评分、来源未验证、门店不匹配、参数漂移或未完成批次都会阻止付费提交。

## 内部账号

所有业务接口都要求内部操作员 Session。首次运行至少配置：

    SEO_OPS_AUTH_USERNAME=test
    SEO_OPS_AUTH_PASSWORD=<replace-with-a-strong-password>
    SEO_OPS_AUTH_SECRET=<at-least-32-random-characters>
    SEO_OPS_COOKIE_SECURE=false

本地 HTTP 使用 `SEO_OPS_COOKIE_SECURE=false`；UAT/生产 HTTPS 必须使用 `true`。账号、密码、Session secret 只放在 `.env` 或 Pod Secret 中，不提交 Git。

## 开发运行

后端：

    cd api
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    cp .env.example .env   # 填入内部账号和 core-ai 配置；不配置 Agent 时 AI 功能返回 503，台账仍可登录使用
    .venv/bin/uvicorn app.main:app --reload --port 8000 --env-file .env

前端：

    cd web
    npm install
    npm run dev

浏览器打开 http://localhost:5173 。接口文档在 http://localhost:8000/docs 。

当前 SQLite 内同时运行后台轮询器；UAT Pod 应先保持单副本，并把数据库挂载到持久卷。扩展到多副本前需要把任务锁和 scheduler 迁移到共享数据库/队列。

## 测试

    cd api && .venv/bin/python -m pytest tests -v

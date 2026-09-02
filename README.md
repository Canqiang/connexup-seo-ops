# connexup-seo-ops

商户 SEO 运营台账（重建版，一次一块砖）。当前系统已覆盖商户台账 + 任务工单 与 AI 分析（agent 跑批）。
设计文档：docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md 与 docs/superpowers/specs/2026-08-31-agent-runs-design.md

## 结构

- `api/` — FastAPI + SQLite 后端（库文件 `data/seo-ops-v3.db`，schema 见 `api/schema.sql`）
- `web/` — React + Vite + TS 前端（开发期 `/api` 代理到 8000）

## AI 分析与任务执行

- 商户详情页可手动"发起分析"，或设置每商户自动周期（7/30 天）
- 后台每 30 秒轮询进行中的 run，每小时扫描到期商户
- 报告中的 ```json 计划块自动解析为待办任务（幂等，不重复创建）；无计划块时报告仍可在 run 详情页查看
- 诊断/Plan Agent 通过 `COREAI_AGENT_ID` 配置；任务只读准备 Agent 通过 `COREAI_EXECUTION_AGENT_ID` 配置
- Plan 经人工确认后任务才能交给 Agent；Agent 结果自动回填，人工只负责批准或退回重做
- 当前任务 Agent 只允许生成草稿、审计和操作建议，不允许发布或修改任何外部系统；只有结构化、明确声明未外写的结果才能进入人工审批
- `COREAI_EXECUTION_AGENT_ID` 必须指向已发布且不含 Tool、Skill、Sub-agent、Sandbox 或 Dataset 的专用只读 Agent；SEO Ops 每次派发前都会从 Core AI Server 读回并校验，配置漂移时拒绝执行
- 任务只有在人工批准 Agent 结果后才会完成；批量操作和普通状态修改都不能绕过审批
- 设计文档：docs/superpowers/specs/2026-08-31-agent-runs-design.md

## FBR / GBP 只读资料

- 商户页的“商户资料”通过 SEO Ops 后端读取 FBR / Operation Assistant 暴露的只读 GBP 信息，浏览器不会直连 FBR。
- `FBR_SEO_BASE_URL` 指向 GBP 数据入口。当前 UAT 使用 Operation Assistant，配置 `FBR_SEO_API_STYLE=operation_assistant`；以后直接接 SEO Integration 时使用 `seo_integration`。如服务要求服务端鉴权，可通过 `FBR_SEO_BEARER_TOKEN` 注入只读调用凭证。
- SEO Ops 只保存明确绑定的 FBR Merchant ID、GBP 资源 ID 和当前资料快照；不会保存或返回 Google access token / refresh token。
- 同步失败会保留上一次成功快照，不会修改 FBR 或 Google 的任何数据。

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

# connexup-seo-ops

商户 SEO 运营台账（重建版，一次一块砖）。当前系统已覆盖商户台账 + 任务工单 与 AI 分析（agent 跑批）。
设计文档：docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md 与 docs/superpowers/specs/2026-08-31-agent-runs-design.md

## 结构

- `api/` — FastAPI + SQLite 后端（库文件 `data/seo-ops-v3.db`，schema 见 `api/schema.sql`）
- `web/` — React + Vite + TS 前端（开发期 `/api` 代理到 8000）

## AI 分析（第二块砖）

- 商户详情页可手动"发起分析"，或设置每商户自动周期（7/30 天）
- 后台每 30 秒轮询进行中的 run，每小时扫描到期商户
- 报告中的 ```json 计划块自动解析为待办任务（幂等，不重复创建）；无计划块时报告仍可在 run 详情页查看
- agent 通过 COREAI_AGENT_ID 配置；执行/验证永不自动触发，任务状态永远人工流转
- 设计文档：docs/superpowers/specs/2026-08-31-agent-runs-design.md

## 开发运行

后端：

    cd api
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    cp .env.example .env   # 填入 core-ai 配置；不配置则 AI 分析功能返回 503，台账不受影响
    .venv/bin/uvicorn app.main:app --reload --port 8000 --env-file .env

前端：

    cd web
    npm install
    npm run dev

浏览器打开 http://localhost:5173 。接口文档在 http://localhost:8000/docs 。

## 测试

    cd api && .venv/bin/python -m pytest tests -v

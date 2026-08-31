# connexup-seo-ops

商户 SEO 运营台账（重建版，一次一块砖）。当前砖：商户台账 + 任务工单。
设计文档：docs/superpowers/specs/2026-08-31-seo-ops-rebuild-slice1-design.md

## 结构

- `api/` — FastAPI + SQLite 后端（库文件 `data/seo-ops-v3.db`，schema 见 `api/schema.sql`）
- `web/` — React + Vite + TS 前端（开发期 `/api` 代理到 8000）

## 开发运行

后端：

    cd api
    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/uvicorn app.main:app --reload --port 8000

前端：

    cd web
    npm install
    npm run dev

浏览器打开 http://localhost:5173 。接口文档在 http://localhost:8000/docs 。

## 测试

    cd api && .venv/bin/python -m pytest tests -v

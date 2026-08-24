# Connexup SEO Operations

面向内部 SEO 代运营团队的执行控制台，支持一名操作员在同一套流程中管理几十家商户，而不把商户做成永久按钮墙。

## 产品范围

- 组合级商户风险、容量、阻塞、逾期和待审批汇总
- 可搜索、可收藏、按当前用户隔离偏好的商户切换器
- 服务端分页的跨商户 Execution Task 收件箱
- 任务版本、状态版本、执行规范哈希和不可变审计时间线
- 证据追加、独立 GET 回读和 `409` 过期状态处理
- 正式审批预览与批准/退回/撤销；审批不触发执行
- 报告来源、新鲜度和哈希展示
- 事实、相关、因果就绪度分级的复盘分析
- 无工具、无技能、无记忆、无外部写入的上下文 Copilot

## Core AI 边界

前端从同源 Core AI 调用 `/api/auth/me`、`/api/seo-ops/*` 和最小会话接口。认证使用现有 `apiKey`；身份与权限必须由 `/api/auth/me` 回读后才进入受保护页面。

权限分为：

- `seoops.view`：读取组合、任务、报告、复盘和事件
- `seoops.manage`：创建商户/地点/任务、修订和证据、链接对话
- `seoops.approve`：审批预览与正式决定
- `chat.use`：显示只读 Copilot

任何页面都没有可用的外部执行按钮。`APPROVED` 只是一条授权记录；实际执行、第三方写入与执行后回读属于独立阶段。

## 本地开发前置（server）

`server/` 使用 PostgreSQL（见 `server/src/db`）。本地起库：

```bash
docker compose up -d          # 启动 postgres:16-alpine，seo_ops_dev 库
cp server/.env.example server/.env   # 按需填写，DATABASE_URL 默认已指向本地库
npm --prefix server run migrate:from-sqlite -- ../data/seo-ops.db  # 可选：导入旧 SQLite 开发数据
npm --prefix server run dev
```

`DATABASE_URL` 默认值为 `postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev`，与 `docker-compose.yml` 中的凭据一致。

## 本地运行

```bash
npm ci
npm run dev
```

Vite 开发入口为 `http://localhost:5173/seo-ops/`。生产环境必须把 `/seo-ops/api` 所需的同源 `/api/*` 请求转发给 Core AI。

## 验证与容器

```bash
npm run test:run
npm run build
npm audit --audit-level=high
docker build -t connexup-seo-ops:local .
docker run --rm -p 18080:8080 connexup-seo-ops:local
curl --fail http://127.0.0.1:18080/seo-ops/healthz
```

Nginx 以非 root 镜像在 8080 端口运行；`/seo-ops/*` 深链接回退到 SPA，`/seo-ops/healthz` 返回纯文本 `ok`。

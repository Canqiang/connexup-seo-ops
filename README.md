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
- 受控的 Core AI specialist 运行、结构化产物验收与独立回读

## 服务拓扑与 Core AI 边界

浏览器仅通过同源 Cookie 调用本项目 SEO Ops backend。`/api/auth/*` 与 `/api/seo-ops/*` 都由本服务提供；浏览器不会接收或发送 API key、令牌或任何后端凭据。公开问卷路径同样由本服务在 `/api/public/*` 提供。

权限分为：

- `seoops.view`：读取组合、任务、报告、复盘和事件
- `seoops.manage`：创建商户/地点/任务、修订和证据、链接对话
- `seoops.approve`：审批预览与正式决定
- `seoops.execute`：触发受控阶段运行
- `seoops.capability.manage`：管理已批准的执行能力
- `seoops.schedule.manage`：管理已批准的运行计划

本服务仅在后端通过 `CORE_AI_BASE_URL` 与 `CORE_AI_TOKEN` 调用现有 Core AI API（例如受控阶段运行和工件读取）。`CORE_AI_TOKEN` 永不进入浏览器；此集成不要求、也不暗示修改 Core AI 服务，且不提供浏览器到 Core AI 的转发层。

GBP Post 支持生成、人工改稿/换商户实拍、定稿、门 1 审批，以及门 2 的“立即发布或定时发布”。审批本身不触发写入；只有门 2 再次绑定精确 Task revision/hash、图片、地点与凭据引用后，专用 Worker 才能执行 `CREATE_POST`，随后必须独立回读。`OUTCOME_UNKNOWN` 不会自动重试。

`GBP_POST` 内容 Agent 绑定不是自由文本引用：后端会通过 Core AI 服务端凭据独立读取精确 Agent，确认其已发布、仅有内置图片生成工具且没有 Skill、Subagent、Dataset、Sandbox、Memory 或外部写工具，再保存脱敏配置哈希。生成前会重新验证该坐标；配置漂移时以 `CONTENT_AGENT_POLICY_UNVERIFIED` 关闭失败。内容 Agent 与 GBP 写入/回读 Agent 必须是不同身份。

## 本地开发前置（server）

`server/` 使用 PostgreSQL（见 `server/src/db`）。本地起库：

```bash
docker compose up -d          # 启动 postgres:16-alpine，seo_ops_dev 库
cp server/.env.example server/.env   # 按需填写，DATABASE_URL 默认已指向本地库
npm --prefix server run migrate:from-sqlite -- ../data/seo-ops.db  # 可选：导入旧 SQLite 开发数据
npm --prefix server run dev
```

`DATABASE_URL` 默认值为 `postgres://seo_ops:seo_ops@localhost:5432/seo_ops_dev`，与 `docker-compose.yml` 中的凭据一致。

### 内部用户 bootstrap 与 UAT 认证契约

bootstrap CLI 仅创建 `HUMAN` 身份；它只接受精确的权限目录代码（不接受通配符），并从当前 shell 的环境变量读取密码，绝不从 argv 读取或输出密码、密码哈希或会话数据。

```bash
# 先启动 PG；SESSION_SECRET 至少 32 个字符，并仅保存在 gitignored 的 server/.env 中
# Bash: 隐藏输入；密码不会进入 argv 或 shell history。
read -r -s -p 'Bootstrap password: ' SEO_OPS_BOOTSTRAP_PASSWORD
printf '\n'
export SEO_OPS_BOOTSTRAP_PASSWORD
npm --prefix server run user:bootstrap -- \
  --email operator@example.com --name 'SEO Operator' --role seo_lead \
  --permissions seoops.view,seoops.manage \
  --merchant-id <merchant-id> --merchant-id <another-merchant-id>
unset SEO_OPS_BOOTSTRAP_PASSWORD
npm --prefix server run dev
```

随后从 `/seo-ops/login` 登录。不要把 bootstrap password 放在命令行参数、shell history、脚本或仓库；自动化 UAT 时由受控 Secret manager / Kubernetes Secret 注入当前 Job。重复的 `--merchant-id` 只会把该账号追加到明确指定的商户范围，并保留已有 operator；任一 ID 不存在时用户与商户修改会整体回滚。遗留的 `--claim-local-dev-merchants` 只替换精确成员 ID `local-dev`，不会改变其他 operator ID。

UAT 使用 Kubernetes Secrets 提供 `DATABASE_URL`、`SESSION_SECRET`、`CORE_AI_TOKEN` 和 `SEO_OPS_BOOTSTRAP_PASSWORD`；不得将它们提交或打印。UAT 必须设置 `SESSION_COOKIE_SECURE=true`，并使用至少 32 个字符的 `SESSION_SECRET`。bootstrap 密码仅在执行 bootstrap 的当前 shell 或受控 Job 中注入，完成后撤销/清除。

## 本地运行

```bash
npm ci
npm run dev
```

Vite 开发入口为 `http://localhost:5173/seo-ops/`，开发服务器把根路径 `/api/*` 代理到本项目 SEO Ops backend（默认 `http://localhost:8787`）。生产部署也必须把根路径 `/api/*` 反代到该 Fastify backend；不能改写为 `/seo-ops/api/*`。静态 Nginx 镜像只承载 SPA 与 `/seo-ops/healthz`，部署网关负责把 `/seo-ops/*` 的 UI 与根路径 `/api/*` 的 backend 路由组合为同源站点。

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

后端同一镜像按 `SEO_OPS_RUNTIME_ROLE` 分为三个生产进程：`api` 只监听 HTTP，`worker` 只运行 Agent/执行/GBP 后台循环，`scheduler` 只运行周期调度；生产环境禁止 `all`。UAT 清单和 Secret/PVC 前置见 `deploy/uat/README.md`。

设置页的全局/单商户暂停控制会追加保存操作人、时间和原因。暂停只阻止新建、派发、领取和 Agent 触发；已进入 Core AI/GBP 回读的工作继续收敛，避免制造孤儿执行。恢复同样必须填写审计原因。

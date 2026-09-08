# 专用 Agent 本地页面验收 — 2026-09-08

分支：`codex/task-agent-preparation`。本记录只证明本地实现，不是 UAT Agent 真实执行证明。

## 隔离方式

- 使用本分支的 production web build 与真实 FastAPI Task/审批路由。
- 单独监听 `127.0.0.1:8187`，临时 SQLite 位于 `/tmp/seo-agent-preview.IlPGWQ/preview.db`。
- 测试账号 `qa-am`、商户和 Agent 名称均标明 `[LOCAL QA]`。
- 模型边界替换为模拟 Agent，所有真实 Core AI 网络方法显式拒绝；未启动后台同步或诊断调度。
- 没有修改真实环境配置、主分支数据库或远端 Agent，没有生成付费报告或发布内容。

## 浏览器实测与回读

通过 Codex 内置浏览器，在默认 1280×720 视口检查实际页面及控件。

1. Task 3：从页面点击开始，出现运行中和 `local-qa-run-2`，转交负责人入口禁用。
2. 模拟返回后，实际轮询/刷新显示待内容审批，摘要、依据和审批按钮可读；旧“运行中”提示不再残留。
3. 点击批准后，页面显示已完成；重新读取临时数据库：Task 3 = `DONE`、version 5；execution 2 = `SUCCEEDED`，run ID 不变，reviewed_at 有值；存在 actor=`qa-am` 的 `TASK_PREPARATION_APPROVED` 事件，payload 指向 execution 2。
4. 刷新页面后，结果以只读历史展示，不能再次审批，已完成任务不再显示 READY/可执行。
5. Task 2：模拟 trigger 超时后进入 `NEEDS_ATTENTION` / `UNKNOWN`，明确提示人工介入；无开始、重试或审批入口，转交负责人禁用。刷新不触发新的运行。

## 验收发现并修复

- 启动响应被存成永久“当前状态”提示，异步完成后仍显示运行中：删除重复状态快照，以回读的 Task/Attempt 状态为准。
- 已处理结果因不可再次审批而被当作异常：只在当前结果符合结构且存在精确 execution ID 对应的人工处理事件时，显示只读历史；不恢复可审批权限，也不声称重新核验外部数据。事件不匹配或结果异常仍保留警告。
- 生命周期模块将无阻塞当成可执行：仅待办任务显示 readiness，其他阶段显示实际状态。

## 自动化验证

- 后端全量：1366 passed，8 项现有依赖/进程弃用警告。
- 前端全量：395 passed；新增状态提示、处理后只读历史、错配事件及已完成 readiness 回归覆盖。
- lint、production build、git diff --check：通过。构建仍有 >500 kB bundle 警告。
- 确认新增状态提示与只读历史测试在修复前失败、修复后通过。没有修改审批 API 的安全规则。

## 剩余门槛

真实 UAT 闭环仍需单独授权：在隔离数据库建立专用 Agent 绑定，运行一次不带工具的测试任务，按精确 run ID 独立读取结果并完成 AM 审批回读。不得把本记录的模拟 run ID 当作 UAT 证据。

未合并、提交或 push；主分支演示代码和用户未提交文档保持不动。

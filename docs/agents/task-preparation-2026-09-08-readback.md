# UAT 专用任务准备 Agent 创建记录

时间：2026-09-08。用户批准创建新专用 Agent，采用不原地修改的管理约定；不运行任务。

- 名称：SEO Ops Task Preparation - 2026-09-08
- Core AI Agent ID：`a2c3443a-672f-4ca6-8b60-46f977fd4667`
- 环境：`https://core-ai-server.connexup-uat.net`
- 模型：`deepseek-v4-pro`，沿用已有任务准备 Agent 的模型选择；temperature=0.2，max_turns=1，timeout_seconds=180。
- 提交配置：同目录 `task-preparation-2026-09-08.json`
- 配置文件 SHA-256：`d81a8a5cd34f20c99004c0a195541e50d440b18e5e5a6b2d68affac6e89fa524`

## 写入与独立读回

创建前按目标名称查询，total=0。POST /api/agents 一次，201；再按返回的精确 ID GET，200、DRAFT，Prompt、response_schema、模型、限制参数与提交内容一致。

再次核对新 Agent 后，POST /api/agents/{id}/publish 一次，200；随后独立 GET 读回 PUBLISHED。published_at 与 updated_at 均为 `2026-09-08T07:54:26.162Z`。未对已有 Agent 发送写请求。

已核验 tools、skill_ids、subagent_ids、dataset_config 均为空，sandbox_config 为空，enable_memory=false；未启用 system_default。Prompt 只允许依据传入资料准备草稿；缺资料返回 needs_input，不伪造产物链接、评分或已发布结果。

发布后 GET /api/runs/agent/{id}/list，total=0。没有 trigger/call 请求，没有模型输出或任务闭环验收证据。平台 PUBLISHED 仅表示 Agent 配置已发布，不代表任何商户内容已发布。

## 后续绑定边界

尚未写入 SEO Ops 的真实 Agent 注册表或 `.env`，尚未改动 main 演示代码，也未 push。本 ID 是 Core AI 远端 ID，不是 SEO Ops 本地注册 ID；后续绑定时必须先通过本地注册表建立精确映射，不能混用。

不原地修改是管理约定，不是技术锁；后续配置升级创建替代 Agent 并重新验证。保存配置校验和只证明提交/核对内容，不证明远端运行时强制使用该快照。

# 专用任务准备 Agent 的绑定与验收

本功能仅支持 `PREPARE_ONLY`：AM 手动开始 → 已分配 Agent 准备 → 读取远端 run → 校验结果 → AM 审批完成。不会发布商户内容、触发排名扫描或自动重试 trigger。

## 配置

1. 在 Core AI 创建并发布专用 Agent，禁止原地修改。必须明确关闭 tools、skills、subagents、sandbox、datasets 和 memory；缺少能力字段也拒绝执行。
2. 在 SEO Ops Agent 注册表建立本地 ID 到远端 ID 的映射，再将 Task 分配给该本地 Agent。
3. 独立读取远端 `GET /api/agents/{id}` 的完整详情，将 JSON 响应保存在受控临时文件。使用与服务端相同的快照算法生成散列（在 `api` 目录执行）：

```sh
python -c 'import json,sys; from app.task_agent_protocol import agent_snapshot,digest; detail=json.load(sys.stdin); print(digest(agent_snapshot(detail, sys.argv[1])))' REMOTE_AGENT_ID < /absolute/path/to/agent-detail.json
```

4. 配置 `COREAI_BASE_URL`、`COREAI_API_KEY` 和如下环境变量，并重启对应隔离 API 实例：

```dotenv
SEO_OPS_TASK_AGENT_BINDINGS={"LOCAL_AGENT_ID":{"coreai_agent_id":"REMOTE_AGENT_ID","config_sha256":"CANONICAL_SNAPSHOT_SHA256"}}
```

LOCAL_AGENT_ID 不是远端 UUID。散列不是提交配置文件的文件 SHA；它包含实际读回的发布时间及能力字段，使用排序、紧凑、UTF-8 JSON。示例占位符不可直接运行。绑定缺失、Agent 停用或配置变化均拒绝启动，不会回退到默认 LLM Call。

仅有专用 Agent 时无需填写诊断 Agent 或 LLM Call ID，Task 轮询仍可运行；这不会开启诊断自动任务。

## 安全与状态

- 启动前核验配置，在 SQLite 事务中重新检查 Task 版本、负责人、依赖、商户生命周期，再保存派发记录；网络触发只调用一次。
- 保存远端 run ID。轮询必须匹配 run ID、Agent ID、输入和配置散列；COMPLETED 本身不代表可审批。
- 结构化结果必须符合已有准备结果契约，包含证据/产物引用、ready 和无外写声明；这不是对引用内容的独立事实核验。
- 有效结果进入待 AM 审批。审批绑定任务版本、execution ID 和结果散列，不会执行发布。
- 派发超时或结果身份不明进入 UNKNOWN / NEEDS_ATTENTION，不自动重新触发。先人工核对 Core AI 运行记录；本轮未提供 UNKNOWN Agent 的解除或重试入口。
- 缺资料或格式不合要求不能审批；旧 LLM Call 与历史不可审 Agent 记录仍维持原有规则。
- 商户归档、任务取消或版本变化后，迟到结果不能把任务恢复为待审批。

配置散列是漂移检测，**不是 Core AI 强制的版本锁**。仍依赖不原地编辑/重新发布的管理约定；需要更新时创建替代 Agent，重新核验并绑定。

## 本轮部署边界

UAT 已创建的专用 Agent 记录见 `task-preparation-2026-09-08-readback.md`。用户随后批准的一次真实隔离 UAT 验收已通过，见 `task-preparation-uat-acceptance-2026-09-08.md`。未修改真实 `.env`/注册表/数据库，未合并主分支。

已完成：配置隔离实例 → 创建测试 Task 并分配 → AM 手动开始 → 独立回读 run 与 Task → 测试 AM 审批 → 再读取持久化终态。仅证明 PREPARE_ONLY 准备与审批链路；不证明 Orchestrator 自动生成计划或生产启用。

后续启用需要单独选择代码合并与实例配置。真实实例必须读取自己的本地 Agent ID 后建立绑定，不可照搬临时数据库 ID；重新只读核验专用 Agent 配置散列，漂移则停止。启用不会自动触发 Task，也不得重跑验收脚本产生第二次远端调用。

# Core AI Orchestrator 接入：第一阶段

状态：用户已批准在当前会话实施；本地配置接入切片，不代表远端上线。

## 目标与边界

Orchestrator 是 core-ai-server 上的 Agent。SEO Ops 保存业务真相并负责权限、审批、派发、结果校验和历史。只修改 connexup-seo-ops，不修改、发布或部署 Core AI，不触发真实 Agent、公开写入或付费扫描。

本阶段把既有“诊断并提出计划”入口接到显式配置的 Orchestrator；不是完整的持续自主编排。沿用已有 Run 落库、未知结果对账、严格计划校验、人工批准后物化任务的路径。尚不增加任务修改/取消命令、自动分派或新执行类型。

## 当前证据

- 基线 HEAD：951bf1f。
- `api/app/config.py` 通过 COREAI_AGENT_ID 配置诊断与计划 Agent。
- `api/app/runs.py` 已保存 source_agent_id 和派发记录，调用 trigger，验证 Agent 配置安全性。
- `api/app/runs.py` 当前计划提示词只允许 PREPARE_ONLY，禁止工具、Skill、子 Agent 和外部写入。
- `api/app/task_plans.py` 在人工批准后创建正式 Task。
- Task 仍依赖 plan_revision/task_key；本阶段不声称实现无 Plan Version 模型。

## 配置与兼容

新增 COREAI_ORCHESTRATOR_AGENT_ID。显式配置时优先于 COREAI_AGENT_ID；未配置时维持原入口。CoreAiSettings.agent_id 保留为既有诊断/计划调用方使用的最终解析 ID，避免手动入口与 scheduler 使用不同 Agent。其他专业 Agent 配置不变。

工作台显式登记配置的 Orchestrator（agent_key=orchestrator，名称=运营编排 Agent）。没有新配置时保留原 diagnosis-plan 登记行为。若新旧配置指向同一个外部 ID，配置播种只返回 Orchestrator 一个身份；若不同则允许分别登记。保留历史注册和旧 Run，不自动退役旧 Agent。

不把任意已注册 Agent 默认为 Orchestrator，不按名称猜测身份。现有 Agent 安全预检不放宽；不满足当前只读决策条件的 Agent 被拒绝，不能为了接通绕过检查。

## 业务语义

本阶段仍只提出计划草稿，不允许 Agent 直接批准或执行。原来的调用结果和审批格式不变，因此不会把旧提示词当作已经支持新增/修改/取消任务的完整决策协议。

未配置真实 Orchestrator ID 时只报告兼容模式，不能宣称真实 Orchestrator 已上线。远端 Agent 是否存在、是否满足安全配置及输出契约，需要独立只读预检；本阶段本地测试不代替真实验收。

## 后续阶段

1. 任务模型迁移：仅以 plan_id 关联来源，保留历史审批快照；结构化负责人和执行输入快照。
2. 决策协议：固定当前任务/证据上下文，新增/修改/取消建议的结构校验、业务去重、并发控制、审批后应用。
3. 执行闭环：先只读准备与人工任务，再扩展授权后的外部执行和独立验收。
4. 事件反馈：持久事件处理、有限重试、预算和停止条件，最后接入周期复盘。

各阶段单独规格和验收；不一次性删除旧 schema 或替换现有工作流。

## 验收

- 新配置单独存在时可解析；新旧同时存在时显式新配置优先；仅旧配置时行为不变；缺连接凭据时不可用。
- 手动与定时入口均使用同一个解析后的 ID。
- 工作台登记正确且不因同 ID 新旧配置产生重复播种。
- Run 保存实际调用身份，历史不变。
- 安全预检、未知派发对账、计划审批和任务创建相关回归通过。
- 不修改 .env、真实数据库、用户已有修改，不启动服务或触发真实外部执行。

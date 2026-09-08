# Task 指定 Agent 内容准备闭环

日期：2026-09-08。状态：范围已口头确认，详细设计待审阅；尚未实施。

## 1. 目标与边界

AM 人工启动已分配 Agent 的 PREPARE_ONLY Task；SEO Ops 保存执行快照、跟踪远端运行、校验结果，最后由当前登录 AM 审批。分配不等于启动，远端完成不等于 Task 完成。Orchestrator 负责 Plan/Task 提案，不代替 AM 授权执行。

本次仅修改 connexup-seo-ops，不修改或发布 core-ai-server Agent，不运行真实任务，不配置真实环境，不迁移真实数据库。实现使用独立 codex 分支，合并由用户另行选择。多用户、自动启动、GBP/官网发布、付费扫描、Plan revision 数据迁移均不在范围内。

## 2. 已验证代码现状

- `api/app/tasks.py::execute_task` 只接受 PREPARE_ONLY，固定调用 `COREAI_PREPARATION_LLM_CALL_ID`；AGENT 分配当前被明确阻止。
- `CoreAiClient.trigger/get_run/get_agent` 已存在；可复用客户端，不新建直接访问 Core AI 的前端路径。
- `scheduler.py::poll_task_executions_once` 已有运行轮询、商户生命周期与执行身份校验，但旧 Agent COMPLETED 必须落为 UNKNOWN，不是可审批结果。
- `_validated_reviewable_preparation` 明确排除带 coreai_run_id 的旧执行；新支持必须按协议区分，不能删除原有保护。
- `normalize_execution_output` 已校验结构化结果、证据和 external_write_performed=false。这个自报字段不是权限限制，不能单独用于证明安全。
- `task_assignments` 保存当前负责人；注册 Agent 的 active 状态不代表已具备安全执行资格。

## 3. 方案选择

采用“新执行协议 + 复用现有 Task 生命周期与轮询”。不采用把 Agent 包装成旧 LLM Call 的方式，以免丢失异步运行身份；也不另建一套任务引擎，避免重复审批与历史。

先交付一个内容准备执行类型，不建立通用 Agent 编排平台。人工或未分配旧任务保留原来的 LLM Call 内容准备路径。

## 4. Agent 资格与安全门槛

执行必须同时满足：当前任务绑定的本地 Agent 存在且 active；本地 ID 精确映射到 coreai_agent_id；服务端显式允许该 Agent 执行本协议；远端已发布身份与能力配置通过验证。角色名称、显示名称和模型自报都不能作为资格依据。

第一版只开放无工具的内容准备 Agent：tools、skill_ids、subagent_ids、dataset_config 为空，sandbox_config 为空，memory 关闭，字段缺失也拒绝。沿用当前诊断安全校验的字段契约，抽取纯校验逻辑复用，不改变诊断行为。业务资料由 SEO Ops 作为输入提供。需要 Skill、检索或工具的 Agent 留到后续能力授权设计，不能以 Prompt 中“禁止写入”替代权限隔离。

绑定通过服务器配置的本地 Agent ID 白名单表达，不新增普通用户编辑能力策略的界面。默认空名单，部署时显式启用，不把现有全部 active Agent 自动开放。

重要限制：普通 Agent 详情读取与 trigger 之间存在配置变化窗口。实施前以本地客户端契约测试确认是否能证明实际执行版本/能力快照；上线验收必须确认远端发布快照与运行绑定。若现有接口不能提供所需证明，保持入口阻止真实执行并报告该缺口，不宣称已经安全接通，不擅自修改 Core AI。

## 5. 请求、持久化与一次性触发

复用任务的人工“开始准备”入口与 expected_version；根据已持久化负责人选择执行器，而非让浏览器传入任意 Agent ID。AGENT 路径不要求旧 LLM Call 配置存在。

新请求使用独立、严格的 `COREAI_AGENT_PREPARATION_V1` 协议。保存到 task_executions.request_json 的冻结内容包括：协议标识、本地及远端 Agent ID、允许策略/已验证能力快照及校验和、Task ID/定义校验和/工作流版本、PREPARATION 阶段、输入文本和启动 AM。整个请求规范化并计算校验和。仍使用现有 attempt、dispatch_token 和本地幂等键。

安全详情检查在网络阶段完成；写事务中重新检查任务版本、负责人映射、Agent 状态、商户生命周期、依赖/计划生效状态及无活动执行。原子保存 DISPATCHING 执行、Task PREPARING 和事件后提交，再调用 trigger 一次。网络请求不占 SQLite 写锁。

取得有效 run_id 后，带原始 dispatch_token、任务与生命周期条件回写 RUNNING，并阻止同一远端运行绑定多个新执行。远端触发结果不确定、响应身份无效或回写失败时保留 UNKNOWN/恢复依据；不能当作未启动自动重试。本地幂等键不被描述为远端幂等保证。孤立 DISPATCHING 沿用超时恢复，但必须能识别新协议。

## 6. 状态、轮询与结果审批

正常路径：Task PENDING → PREPARING → AWAITING_APPROVAL → AM 批准 → DONE。这里 DONE 只代表内容准备任务被验收，不代表内容已发布。AM 驳回沿用现有流程。

复用现有调度循环做只读 get_run；刷新页面不重复触发。新执行先验证冻结请求与协议、run_id 及远端 Agent 身份，再处理状态。不能用名称、最近一次运行或模糊搜索匹配。每次结果落库再次校验任务/执行版本及生命周期，重复完成回调不重复写事件或审批。

COMPLETED 只是远端状态：只有新协议结果通过现有结构化输出规范，并满足已定义的运行身份/安全证据契约，才保存 SUCCEEDED 和结果校验和、进入 AWAITING_APPROVAL。展示摘要、产物引用、依据及远端运行 ID。外部引用只作为引用，不自动抓取或执行。

FAILED/CANCELLED/TIMEOUT、无效 JSON、缺失安全证据、身份不符进入 NEEDS_ATTENTION，并明确区分失败和结果未知。暂时性只读轮询错误可以重读；触发不可自动重试。UNKNOWN 状态不提供“直接重跑”按钮，保留执行核实信息。

审批验证按执行协议分派：旧 LLM Call 保持原有严格规则，新 Agent 请求严格校验自己的冻结身份、规范化结果及结果校验和。所有历史无新协议的 Agent 运行继续不可审批，不能因为此功能上线变成可信结果。

## 7. 前端与 AM 交互

- 负责人区域保留 AM/Agent 分配；未获执行资格的 Agent 显示具体阻止原因。
- 符合条件时显示“开始准备”，明确由哪个 Agent 执行；按钮有提交中状态并防连点。
- 运行中展示状态、开始时间、Agent、run_id；不以假百分比表示进度。
- 完成后进入现有审批区域；失败/未知展示简短原因与执行详情，不把底层长错误直接堆到页面。
- 运行中、结果未知和待审批阶段继续禁止转交负责人。人工身份仍只取当前登录操作员，业务角色 AM。

## 8. 代码组织与兼容性

将新协议校验、资格验证、触发与回写放入独立任务准备服务，不继续把全部实现堆进 tasks.py。tasks.py 负责鉴权和路由；scheduler.py 调用新服务处理新协议，保留旧协议处理分支；execution_result.py 复用输出规范。工作台可通过既有 Agent/run ID 展示运行，但不额外建立第二份权威执行状态。

优先复用已有执行字段；如需保证新协议 run_id 唯一性，采用只约束新协议的增量迁移，不能让旧历史数据阻止升级，也不重写旧记录。迁移必须在临时数据库/副本验证，包含重复初始化和老数据保留测试。

## 9. 验收与推进门槛

本地测试覆盖：AM 发起、指定 Agent 精确匹配、无 LLM Call 配置也能走新路径、未授权 Agent 不触发、能力字段缺失/非空拒绝、并发连点只有一次 trigger、任务/商户在网络期间改变、触发未知不重试、异常/重复 run_id、进程恢复、轮询身份不符、合法完成、无效输出、重复完成、审批冻结校验、旧历史继续不可审批、停用/转交限制、前端状态和失败展示。

全量 API/前端回归、lint/build 和隔离界面检查通过后，只能报告“本地协议实现已验证”。真实闭环需要用户另行授权，用指定无工具 Agent 完成一次触发、按精确 run_id 读回、验证输出与审批记录；未完成不得声称 UAT 或生产接通。

本次最可能改变后续决定的未知是远端能否证明执行时的 Agent 发布快照。最低成本先用仓库内客户端、响应校验器及测试样本检查契约，不启动 Agent。若证明链不足，先交付默认关闭的本地支持并明确阻塞；若足够，再申请隔离真实验收。此设计不授权该真实运行。

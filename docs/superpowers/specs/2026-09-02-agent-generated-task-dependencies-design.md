# Agent 生成 Task、依赖、审批与托管设计

日期：2026-09-02

状态：已与 Xander 逐段确认，待书面评审

## 目标

让 SEO Ops 接受 Agent 生成的结构化任务计划，同时保持执行简单、稳定、可审批、可托管和可恢复。系统需要支持：

- Agent 在一个 Plan 内提出 Task 及简单前置依赖；
- 运营人员逐项修改、移除或补充 Task，再批准冻结后的完整 Plan；
- Task 按系统内置 Workflow Template 执行，Agent 不能自定义状态机；
- 人工逐项审批或预先授权的自动化托管策略；
- 获得发布授权后，由 Agent 自动发布并自动回读验证；
- 操作人对 Task 的新增、修改、取消和查询；
- 发布结果不确定时绝不盲目重发。

稳定性优先于通用性。本设计不引入通用工作流语言、条件表达式或任意 DAG 编排器。

## 与既有设计的关系

本设计扩展并在对应范围内替代以下旧约束：

- `2026-08-31-agent-runs-design.md` 中“EXECUTE/VERIFY 永不自动触发”继续适用于分析 Run 本身，但不再适用于已获明确授权的 Task Workflow。受限执行 Agent 可以在 Task 获得授权后自动执行和验证。
- `2026-09-01-new-merchant-diagnosis-plan-design.md` 中“先创建候选 Task、再确认 Plan”的方式改为“先保存可编辑 Plan revision，批准时原子物化正式 Task 与依赖”。未批准 Plan 的条目不进入正式任务队列。
- 当前宽松的 JSON 列表解析仍可作为历史报告兼容路径，但不能创建带依赖、可自动执行的新式 Task Plan。

Core AI 仍只是 Agent 能力提供者。SEO Ops 数据库是 Plan、Task、依赖、授权、执行状态和验证证据的唯一业务真相。

## 核心原则

1. **Agent 提议，系统约束。** Agent 可以描述做什么和先后关系，不能决定权限、审批模式、状态迁移或完成事实。
2. **两层依赖。** Task 之间只支持 Plan 内简单硬依赖；Task 内部使用系统固定 Workflow Template。
3. **Plan 审批与发布授权分离。** Plan 审批允许准备工作，不能授权尚未生成的具体内容发布。
4. **审批绑定不可变版本。** 发布授权绑定 artifact checksum、目标、操作和有效期；内容变化立即使旧授权失效。
5. **验证定义完成。** 外部写入返回成功不等于 Task 完成，只有真实回读匹配才能进入 `DONE`。
6. **历史不可改写。** 正在执行和已经完成的 Task、Attempt、授权与证据不能被静默修改或物理删除。
7. **托管是策略级授权。** 自动化托管不是绕过人工授权，而是由人预先批准一个范围有限、有版本和有效期的策略。

## 方案选择

采用系统模板驱动方案：

- Agent 返回一个严格的 Task Plan；
- 服务端校验并保存 Plan revision；
- 用户逐项编辑后批准完整 revision；
- 服务端根据 `task_type` 选择 Workflow Template；
- Workflow Template 决定准备、审批、执行和验证阶段；
- Agent 不能返回任意节点、条件或转移规则。

不采用以下方案：

- **Agent 生成线性脚本：** 比模板灵活，但仍可能遗漏审批或验证步骤。
- **Agent 生成任意 DAG：** 表达能力最强，但会引入循环、死锁、条件漂移、任务爆炸和难以恢复的执行状态。

## 两层依赖模型

### Task 间依赖

Agent 可以在同一个逻辑 Plan 内用稳定 `key` 声明依赖：

```json
{
  "key": "publish_campaign_post",
  "depends_on": ["prepare_campaign_landing_page"]
}
```

第一版约束：

- 依赖只能引用同一个逻辑 Plan 内的 Task key；
- 只支持“所有上游 Task 必须为 `DONE`”这一种硬条件；
- 不支持软依赖、OR 条件、自定义表达式、跨商户或独立 Task 的依赖；
- `key` 在 Plan 内唯一，依赖不得通过标题或数组位置引用；
- 不允许缺失引用、自依赖、重复边或循环；
- 任一依赖错误都会使整个 revision 无法进入可审批状态；
- 上游 `NEEDS_ATTENTION` 或 `CANCELLED` 时，下游保持阻塞，不自动取消。

`BLOCKED` 是根据 Plan 审批和上游状态计算出的 readiness，不是允许人工直接写入的持久状态。

### Task 内工作流

每个 `task_type` 映射到一个版本化 Workflow Template。模板固定：

- 合法状态；
- 合法转移；
- 每一阶段允许的 Agent 能力；
- Artifact Schema；
- 审批要求；
- 执行和验证成功条件；
- 可安全重试的范围。

首个需要端到端外部写入的模板是 `GBP_POST`：

```text
PENDING
  -> PREPARING
  -> AWAITING_APPROVAL
  -> EXECUTING       （UI 可显示“发布中”）
  -> VERIFYING
  -> DONE
```

现有只生成分析、草稿或说明的任务使用 `PREPARE_ONLY`：

```text
PENDING
  -> PREPARING
  -> AWAITING_APPROVAL
  -> DONE
```

所有模板都可以从非终态进入 `NEEDS_ATTENTION`。`DONE` 和 `CANCELLED` 是终态。

从 `NEEDS_ATTENTION` 恢复必须由确定性服务端规则决定：能够证明未发生外部写入的 Preparation/Execution 失败可以经人工确认回到 `PENDING`；不确定发布只能进入 `VERIFYING` 做 reconcile，不能回到 `EXECUTING`；已经存在但不匹配批准 Artifact 的外部资源通过新的补偿 Task 处理，原 Task 保持可追溯的问题状态。

## Agent Task Plan 契约

新式 Plan 使用严格、版本化的单个 JSON 对象：

```json
{
  "schema_version": "seo_ops.task_plan.v1",
  "tasks": [
    {
      "key": "publish_campaign_post",
      "task_type": "GBP_POST",
      "title": "Prepare and publish the campaign Google Post",
      "rationale": "The approved campaign has no current GBP coverage",
      "expected_outcome": "Publish one verified customer-facing campaign update",
      "depends_on": ["prepare_campaign_landing_page"],
      "scheduled_start": "2026-09-05T13:00:00Z",
      "parameters": {
        "location_id": "location-1",
        "topic": "weekday lunch campaign"
      }
    }
  ]
}
```

校验规则：

- 顶层和 Task 对象拒绝未知字段；
- `schema_version` 必须精确匹配受支持版本；
- `tasks` 包含 1–50 项；
- `key` 只允许 ASCII 小写字母、数字、`-` 和 `_`，长度 1–80，且在 Plan 内唯一；
- `task_type` 必须存在已启用的 Workflow Template；
- `title`、`rationale`、`expected_outcome` 必须为非空字符串，最大长度分别为 200、2,000 和 1,000；
- 每项 `depends_on` 最多包含 20 个唯一 key；
- `scheduled_start` 可省略；提供时必须是带时区的 RFC 3339 时间；
- `parameters` 必须通过对应 `task_type` 的独立 Schema，规范化 JSON 最大 64 KiB；
- 整份规范化 Plan JSON 最大 1 MiB；
- Agent 无权提供审批模式、授权、最终状态、执行 Agent ID 或工具 ID；
- 完成字段校验后必须运行依赖引用校验和拓扑排序；
- 任一错误都拒绝整份 Plan，不跳过单条 Task。

无效输出仍保存在原始 Run 报告中，但不创建 Plan revision 或 Task。保存成功的 revision 存储规范化 JSON 和 SHA-256，同一个 Run 与相同 hash 的重复处理为幂等 no-op。

## Plan 编辑、版本与审批

Agent 原始 Plan 永久保留。用户不被限制为整份全收或全拒，而是在 Plan 审批页逐项操作：

- 修改 Task 标题、理由、预期结果、参数和计划时间；
- 调整同 Plan 内的前置依赖；
- 移除不想执行的 Task，并记录原因；
- 添加受支持类型的新 Task；
- 拒绝整份 Plan。

后端不在原 revision 上打补丁。每次保存把当前完整草稿重新规范化、严格校验并创建下一个不可变 revision。请求必须携带 `expected_revision`，避免并发编辑覆盖。

用户点击“批准当前 Plan”时，服务端在一个事务中：

1. 重新读取当前 revision；
2. 校验请求中的 revision 和 checksum；
3. 再次执行字段、依赖和循环校验；
4. 冻结批准人、批准时间、revision 与 checksum；
5. 原子物化正式 Tasks 和 dependencies；
6. 提交后唤醒调度器。

Plan 未整体批准前，不允许任何条目进入执行。若用户只想执行部分任务，应先移除其余条目，再批准精简后的完整 revision。

已批准 Plan 不允许原地修改。后续调整创建同一逻辑 Plan 的新 revision：

- `PENDING` Task 可以被新定义替换、取消或重新连边；
- 已进入 `PREPARING` 的 Task 作为只读锚点保留；
- 活跃或终态 Task 的执行定义和历史不变；
- 新 revision 批准前不得影响正在运行的旧 revision；
- 批准新 revision 时只切换尚未开始的 Task 定义，并在同一事务中重建相关依赖。

## Plan 审批与发布授权

Plan 审批只授权系统准备 Task，不授权具体外部写入。`GBP_POST` 在 Preparation Agent 生成不可变 Artifact 后进入 `AWAITING_APPROVAL`。

发布授权只能来自：

1. 运营人员批准当前 Artifact；或
2. 当前 Artifact 与上下文满足一份有效的自动化托管策略。

两种路径都产生同一种 `ApprovalGrant`，至少绑定：

- `task_id`；
- `artifact_id`、revision 和 checksum；
- merchant、location 和目标资源；
- 明确 operation；
- `HUMAN` 或 `POLICY` grant type；
- operator identity 或 policy ID/version；
- 批准时间、有效期和撤销状态。

Agent 不能创建、修改或声称一个 ApprovalGrant。授权判断由确定性的服务端逻辑完成。

Artifact 内容变化必须创建新 revision，并使旧 Artifact 的授权不再适用。策略变更不追溯影响已经开始的 Attempt；执行记录保存当时使用的完整 policy version 和 grant。

## 自动化托管策略

托管模式是人预先批准的策略级授权。策略至少限定：

- merchant；
- 可选 location；
- `task_type`；
- 允许的 operation 和参数约束；
- 允许的目标、素材或 destination 范围；
- 频率/数量上限；
- 生效时间和失效时间；
- 状态：`ACTIVE`、`PAUSED` 或 `REVOKED`；
- 创建人、版本和审批记录。

策略只在所有字段确定匹配时生成 `POLICY` grant。缺数据、边界歧义、不支持的内容、策略过期或策略被暂停时，一律降级到人工审批，不做猜测或部分匹配。

人工模式与托管模式共用相同的执行、幂等和验证链路，不能为托管模式创建安全性较弱的旁路。

## 分阶段 Agent 权限

运营人员看到一个 Task，服务端可以按阶段路由到权限不同的 Agent：

### Preparation Agent

- 读取已确认事实和允许的数据源；
- 生成符合 Artifact Schema 的草稿；
- 不拥有任何外部写入、发布或 mutation 能力。

### Publishing Agent

- 只获得当前 Workflow Template 所需的最小发布能力；
- 不接收未经结构化校验的自然语言发布指令；
- 只接收批准的 Artifact、checksum、ApprovalGrant、目标和 idempotency key；
- 不能改变内容、目标、operation 或授权范围。

### Verification Agent

- 只读回查平台状态；
- 使用 provider resource ID、目标、checksum 和预期字段做精确匹配；
- 不拥有创建或更新能力。

当前 capability-free 的 Task Preparation Agent 必须保持只读。实现 `GBP_POST` 自动发布前，需要单独配置并验证受限 Publishing/Verification 能力；不得直接给现有 Preparation Agent 增加全量工具。

## 状态、调度与并发

Task 使用一个权威持久状态：

- `PENDING`
- `PREPARING`
- `AWAITING_APPROVAL`
- `EXECUTING`
- `VERIFYING`
- `DONE`
- `NEEDS_ATTENTION`
- `CANCELLED`

readiness 由服务端计算：Plan 未批准、计划时间未到或任一上游不是 `DONE` 时均不可执行。UI 可以显示 `BLOCKED`，但 API 不接受客户端写入该值。

调度器只选择满足以下全部条件的 `PENDING` Task：

- 批准的 Plan revision 仍是当前有效 revision；
- 所有依赖均为 `DONE`；
- `scheduled_start` 已到；
- 没有活跃 Attempt；
- Task 未被取消或替代。

调度器用带预期状态和版本号的原子更新执行 `PENDING -> PREPARING`。活跃 Attempt 使用数据库唯一约束，保证多个调度器或重复请求只能有一个成功 claim。

客户端不能直接把 Task 改为 `DONE`。每个状态转移都由 Workflow Template 和服务端 compare-and-set 校验。

## 发布、验证与恢复

每次外部执行都有稳定 idempotency key，并在远程调用前持久化 Attempt 和 request checksum。

重试规则：

- Preparation 明确失败且未产生 Artifact 时，可以创建新 Attempt；
- Verification 是只读操作，可以按固定退避和次数限制自动重试；
- 发布明确失败且 provider 能证明资源未创建时，可以在同一幂等身份下限次重试；
- 发布请求超时、连接中断或返回无法证明是否创建的结果时，Attempt 进入不确定状态，禁止再次创建；
- 不确定发布先通过 provider resource ID、idempotency reference、内容 checksum、目标和时间窗口回查；
- 回查仍无法确认时，Task 进入 `NEEDS_ATTENTION`；
- 只有回读的目标、内容和平台状态与批准 Artifact 一致时才能进入 `DONE`。

若进程在 `EXECUTING` 或 `VERIFYING` 中重启，恢复器读取持久 Attempt 并从回查开始，不能重新执行创建动作。

取消规则：

- `PENDING` 和安全停止的 `AWAITING_APPROVAL` 可以取消；
- `PREPARING` 只能在确认没有活跃 Agent Attempt 后取消；
- `EXECUTING` 或 `VERIFYING` 不能直接取消，必须先完成状态对账；
- `DONE` 不可取消或删除；补偿/撤回必须是新的、独立授权 Task。

## 操作人 Task CRUD

### 新增

- 操作人可以在 Plan 草稿中添加受支持类型的 Task，并设置同 Plan 依赖；
- 操作人也可以创建无依赖的独立 Task；
- 独立 Task 由服务端在同一事务中包装为一个隐式、单 Task 的 `OPERATOR` Plan，并把创建动作记录为 Plan 决策；
- 人工创建不绕过 Artifact 发布授权。

### 修改

- Plan 草稿和 `PENDING` Task 可以通过新 Plan revision 修改执行定义；
- `PREPARING` 以后，只有操作人备注、负责人和内部标签等不参与执行输入的元数据可以按权限修改；标题、理由、预期结果、执行参数和依赖不可原地修改；
- 执行定义变化需要在安全取消后创建 replacement Task；
- Artifact 内容变化创建新 Artifact revision，并要求重新授权；
- `DONE` Task 的执行定义不可修改。

### 删除/取消

- 未批准 Plan 中的条目可以从当前 revision 移除，但保留 Agent 原始建议和移除审计；
- 已持久化 Task 使用 `CANCELLED`，不物理删除；
- 活跃写入、验证和 `DONE` Task 禁止删除；
- UI 的“删除”对正式 Task 表达为“取消任务”，并明确说明历史会保留。

### 查询

列表和详情至少支持按以下条件检索：

- merchant、逻辑 Plan 和 Plan revision；
- Task type、权威状态和派生 readiness；
- 当前阻塞原因、上游和下游；
- 计划时间；
- Agent 或操作人来源；
- 人工审批或托管授权模式；
- `NEEDS_ATTENTION`；
- Artifact、Attempt、provider resource 和验证结果。

所有操作人变更写入 append-only audit event，包含 operator、时间、动作、原因、前后 revision 或 checksum。写接口必须携带预期版本，冲突返回 409，不做最后写入者覆盖。

## 持久化模型

### `task_plans`

逻辑 Plan 身份，关联 merchant、来源 Run、最新草稿 revision 和当前生效的 approved revision。逻辑 Plan 生命周期只使用 `OPEN`、`REJECTED` 和 `CLOSED`，从而允许一个已生效 revision 与一个正在编辑的新草稿同时存在。

### `task_plan_revisions`

Plan payload 的不可变快照，保存 revision、规范化 payload、SHA-256、来源、创建者和创建时间。同一逻辑 Plan 的 revision 单调递增。其受控 decision state 使用 `DRAFT`、`APPROVED`、`REJECTED` 和 `SUPERSEDED`；批准新的 revision 时，前一个生效 revision 才转为 `SUPERSEDED`。

### `tasks`

扩展现有表，保存逻辑 Plan、稳定 key、Task type、当前有效定义 revision、权威状态、调度时间、乐观锁版本、来源和终态时间。`(plan_id, key)` 唯一。

### `task_dependencies`

保存 `task_id -> depends_on_task_id` 的唯一有向边。服务端保证两端属于同一逻辑 Plan；数据库禁止自依赖并建立正反向索引。

### `task_artifacts`

保存不可变 Artifact revision、规范化 payload 或 artifact reference、checksum、creator 和时间。`(task_id, revision)` 与 `(task_id, checksum)` 唯一。

### `task_approvals`

保存不可变 ApprovalGrant 及撤销状态。授权对象、checksum、目标和 policy version 不能原地修改。

### `automation_policies`

保存版本化托管策略。修改策略创建新版本；历史 Task 继续引用实际使用的版本。

### `task_executions`

扩展现有 Attempt 表，增加 stage、request checksum、idempotency key、provider resource ID、结构化结果、verification evidence、uncertainty state 和完成时间。每个 Task 同时只能有一个活跃 Attempt。

### `task_events`

append-only 审计流，记录 Plan 物化、状态转换、操作人 CRUD、审批、策略匹配、调度 claim、执行结果、回读和人工介入。事件不替代各聚合的当前权威状态。

## API 方向

具体 DTO 在实施计划中按现有 FastAPI/Pydantic 模式细化，接口边界固定如下。

### Plan

- `GET /api/runs/{run_id}/task-plan`：读取原始建议、当前 revision、校验结果和审批状态；
- `PUT /api/task-plans/{plan_id}/draft`：提交完整草稿和 `expected_revision`，成功后创建新 revision；
- `POST /api/task-plans/{plan_id}/approve`：按 revision + checksum 批准并原子物化 Task；
- `POST /api/task-plans/{plan_id}/reject`：记录整份 Plan 拒绝原因。

### Task

- `POST /api/merchants/{merchant_id}/tasks`：创建操作人独立 Task；
- `GET /api/tasks`、`GET /api/tasks/{task_id}`：查询过滤列表和详情；
- `PATCH /api/tasks/{task_id}`：只允许当前状态下可修改的字段，并要求 expected version；
- `POST /api/tasks/{task_id}/cancel`：执行可审计取消；
- `POST /api/tasks/{task_id}/approve-artifact`：批准精确 Artifact revision/checksum；
- `POST /api/tasks/{task_id}/return-artifact`：退回并记录原因；
- `POST /api/tasks/{task_id}/reconcile`：只触发安全回查，不重复发布。

没有“客户端直接完成 Task”的接口。调度、发布和验证由后台 Workflow Orchestrator 根据持久状态自动推进。

### 托管策略

- 商户范围的策略列表、创建新版本、暂停和撤销接口；
- 策略 API 只管理授权规则，不直接触发 Task 或外部发布。

## UI 设计

### Plan 审批页

不实现复杂图编辑器。任务按拓扑执行波次排列，每项显示：

- Task type、标题、理由、预期结果和计划时间；
- 前置 Task 标签；
- 编辑、移除和“用户已修改”标记；
- 字段或依赖校验错误。

依赖选择器只显示当前 Plan Task。缺失引用或循环时禁用“批准当前 Plan”。页面底部保留“拒绝 Plan”和“批准当前 Plan”两个主要动作。

### 任务队列

正式队列只显示已批准 Plan 的 Task。列表不画完整 DAG，只展示当前最重要的运营状态：

- 等待计划时间；
- 被具体上游 Task 阻塞；
- Agent 准备中；
- 待内容审批；
- 托管策略已授权；
- 发布中；
- 验证中；
- 需要人工处理；
- 已完成。

### Task 详情

详情页显示上游/下游、固定阶段轨迹、当前 Artifact/checksum、人工或策略授权、全部 Attempt、provider resource ID 和验证证据。技术字段默认降级展示，不挤占运营结论。

## 错误处理

- Agent Plan 结构错误：Run 保持可读，Plan 不创建，显示可操作的校验摘要；
- Plan 并发编辑：返回 409 和当前 revision，不自动合并；
- 依赖无效：Plan 无法审批，不做部分物化；
- Preparation 失败：保留 Attempt，Task 进入 `NEEDS_ATTENTION` 或按模板创建安全重试；
- 授权缺失/过期：停在 `AWAITING_APPROVAL`；
- 策略不匹配：降级人工，不视为 Task 失败；
- 发布明确失败：记录 provider 响应，并只在可证明未创建时重试；
- 发布不确定：停止写入，优先 reconcile，最终转人工；
- Verification 暂时失败：保留 `VERIFYING` 并安全重试；
- Verification 明确不匹配：进入 `NEEDS_ATTENTION`，禁止解锁下游。

## 安全与授权边界

- 浏览器不能直接调用 Core AI、GBP provider 或写入工具；
- merchant、location、Agent、tool 和 provider identity 由服务端解析；
- Agent 输出和商户数据都视为不可信数据，不得成为越权指令；
- OAuth connection 只证明技术连接，不等于 Plan 审批、Artifact 审批或托管授权；
- ApprovalGrant、policy match、状态迁移、幂等和完成判断必须由确定性代码控制；
- 密钥、OAuth token 和原始授权凭证不进入 Task、Artifact、事件、日志或前端响应。

## 兼容与迁移

- 现有人工 Task 包装为隐式单 Task `OPERATOR` Plan；
- 现有 `source_run_id` Task 按对应 Run 聚合为逻辑 Plan；
- 已有 `plan_approved_at` 的 Run 生成已批准迁移 revision；
- 未批准 Run 的候选 Task 迁移为 Plan 草稿条目，不进入正式队列；
- 当前 `todo` 映射为 `PENDING`；有 running execution 的 `doing` 映射为 `PREPARING`；最新 execution 为 `ready` 的 `doing` 映射为 `AWAITING_APPROVAL`；已批准结果映射为 `DONE`；
- 无法无歧义映射的历史状态标记为 `NEEDS_ATTENTION`，不得猜测为完成；
- 历史宽松 Plan 保留原报告和 legacy 展示，新式依赖与托管只接受 `seo_ops.task_plan.v1`。

迁移必须在一个可回滚的本地数据库副本上验证记录数量、终态、活跃 Attempt 和 Plan/Task 对应关系，再进入正式数据库。

## 验收标准

### Plan 与依赖

- 合法 `seo_ops.task_plan.v1` 可以保存、编辑、批准并原子物化；
- 缺字段、未知字段、非法参数、缺失依赖、自依赖和循环依赖均导致整份 revision 被拒绝；
- 同一 Run/hash 重复处理不产生重复 Plan、Task 或 dependency；
- Plan 草稿允许逐项编辑、移除和新增；批准绑定最终 revision/checksum；
- 未批准 Plan 的条目不进入正式任务队列；
- 上游未 `DONE` 时下游永远不会被 claim。

### 审批与托管

- Plan 审批不能被当作 Artifact 发布授权；
- 人工批准绑定精确 Artifact revision/checksum；
- 内容变化使旧授权不可用；
- 托管策略只有完整匹配时产生 grant；越界、过期、暂停和歧义全部降级人工；
- 策略修改不改变历史 Attempt 所引用的 policy version。

### 执行与验证

- 两个调度器同时 claim 时只有一个成功；
- 未授权 Artifact 不能进入外部执行；
- 发布结果不确定时不会产生第二次创建调用；
- Verification 可以限次自动重试，并能在进程重启后恢复；
- 只有精确回读匹配才能将 Task 标为 `DONE`；
- `DONE` Task 的 Plan、依赖、Artifact、授权、Attempt 和验证证据均可追溯；
- 当前只读 Preparation Agent 不会因该功能获得发布权限。

### 操作人 CRUD 与 UI

- 操作人可以新增、修改、查询和取消 Task，且所有动作可审计；
- 正在写入、验证和已完成 Task 不能被物理删除或静默改写；
- 并发更新不会覆盖另一操作人的修改；
- Plan 页能编辑依赖并阻止无效图审批；
- 任务列表显示一个明确阻塞原因，详情页显示完整链路；
- 后端测试、前端测试、lint、build、数据库迁移验证和 `git diff --check` 全部通过。

## 分阶段启用

1. **Plan/Dependency 基础：** 严格契约、revision、编辑审批、依赖校验、操作人 CRUD、readiness 和 UI；不启用新外部写入。
2. **Artifact/Authorization：** Preparation、不可变 Artifact、人工审批、托管策略和统一 ApprovalGrant。
3. **GBP_POST 执行闭环：** 受限 Publishing Agent、幂等 Attempt、安全恢复、Verification 和真实 provider readback。

每一阶段必须独立通过数据迁移和并发/恢复测试。第三阶段只有在受限写入配置、测试账号、真实回读和不确定结果演练全部通过后才能启用托管策略。

## 非目标

- 通用 BPMN、任意 DAG 或用户编写的条件表达式；
- 跨商户依赖；
- 独立 Task 的任意跨 Plan 依赖；
- Agent 自行创建 ApprovalGrant、托管策略或工具权限；
- 将 API 200、Core AI Run 完成或 Agent 文本声明当作外部发布完成；
- 物理删除已持久化 Task、Attempt、授权或验证证据；
- 在本设计阶段修改 Dashboard 或 Performance 图表。

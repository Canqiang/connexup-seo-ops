# SEO Ops v2 运行手册（执行域 + 建议层 + 周期调度）

本轮（2026-08-26）把系统从「任务台账」推进为可联调的 **AI Agent native 代运营控制面**：
建议层（Core AI Planner 产出 → SEO Ops 严格校验并持久化 → 人判定）、执行域
（双门 → attempt → 查证/核验）、周期调度、内容稿证据链与单人免登录模式。
当前已接通 Planner、Questionnaire、Keyword、Audit、Ranking 与 Plan specialist 的严格 JSON
闭环。Core AI 负责运行 Agent；SEO Ops 负责输入快照、结构校验、产物落库、Task 结算、审批与
独立回读。SEO Ops UAT Pod 发布仍是部署阶段事项，不影响本地连接 Core AI UAT 使用。

## 快速启动（本机单人模式）

前置：PostgreSQL 运行中，存在用户/库 `seo_ops / seo_ops_dev`（首次：
`createuser seo_ops -P; createdb seo_ops_dev -O seo_ops`）。

```bash
# 1. 后端（8787）：单人免登录 + mock 执行（不打 core-ai，演示/开发用）
cd server && npm install
SEO_OPS_SINGLE_USER=true SEO_OPS_MOCK_EXECUTION=true \
SESSION_SECRET=dev-secret-please-rotate-32-characters-min npm run dev

# 2. 种子样本世界（3 商户 + 建议批次 + Post 双门链路 + 跑一轮调度）
cd server && npm run seed:demo

# 3. 前端（5173，/api 代理到 8787）
npm install && npm run dev
# 打开 http://localhost:5173/seo-ops/
```

接真 core-ai（UAT）时把 mock 关掉：

```bash
SEO_OPS_SINGLE_USER=true \
CORE_AI_BASE_URL=https://core-ai-server.connexup-uat.net \
CORE_AI_TOKEN=<uat token> \
SESSION_SECRET=<32+ chars> npm run dev
```

任务执行由「设置 → Agent 绑定」中的 published Agent ID 路由，不依赖旧版
`AGENT_RUN_AGENT_ID`。后者只供旧的 stage-run 面板使用，可选。

当前 UAT Planner：`d058d5ff-c7e5-48cb-9e34-cf480d167e99`
（`[SEO Ops] Planner & Task Generator v1`，PUBLISHED）。

当前 UAT Questionnaire specialist：`109020ca-2940-4ff7-8042-1138dad83092`
（`[SEO Ops] Questionnaire Draft v1`，PUBLISHED），绑定独立 Skill
`6a8eba18225bdefec335aef9`（`Xander/seo-ops-questionnaire-draft`）。它只返回
`seo_ops.questionnaire_draft.v1` JSON；SEO Ops 严格解析并持久化 DRAFT，Agent 不负责发放、
Task 状态或商户阶段推进。本地开发库的 `QUESTIONNAIRE` binding 已切到此 Agent。

### 当前 Core AI UAT Agent / Skill 清单

| SEO Ops binding | UAT Agent ID | Skill ID | 严格输出 |
| --- | --- | --- | --- |
| `PLANNER` | `d058d5ff-c7e5-48cb-9e34-cf480d167e99` | Planner 内置配置 | `seo_ops.task_proposals.v1` |
| `QUESTIONNAIRE` | `109020ca-2940-4ff7-8042-1138dad83092` | `6a8eba18225bdefec335aef9` | `seo_ops.questionnaire_draft.v1` |
| `KEYWORD_RESEARCH` / `KEYWORD_WEEKLY` | `741da7c0-e297-411e-9ccc-417f775db3d6` | `6a8ec15eccb92906b8117cce` | `seo_ops.keyword_set.v2` |
| `AUDIT` | `35ae0cf6-cda8-48eb-aa83-1a4c73104ddb` | `6a8ec15fccb92906b8117ccf` | `seo_ops.audit_report.v1` |
| `REPORT` | `2445e5d6-6110-4985-b3f8-b21885c11c22` | `6a8ec5d4ccb92906b8117cd0` | `seo_ops.ranking_report.v1` |
| `PLAN` | `41a71719-9638-4ded-9e14-1ffefa672351` | `6a8ec15f225bdefec335aefa` | `seo_ops.execution_plan.v1` |

以上 Agent 均已发布并通过 API 独立回读；本地开发库的六类 binding 也已回读确认。UAT API
凭证只放服务端环境变量/Secret，不能写入仓库或发到浏览器。

### Keyword 方法与 FBR 边界

`seo-ops-keyword-set` 是安全适配层，不重新发明关键词方法：

- `seo-keyword-seed-generate` 仍定义事实/菜单/服务/geo seed、source tag、confidence 与 volume；
- `seo-keyword-ranking-optimize` 仍定义 LOCAL/ORGANIC、确定性评分、P0-P3 与 target surface；
- 接收到完整旧链路产物时，SEO Ops 以 `UPSTREAM_DETERMINISTIC_ADAPTER` 原样映射；没有该产物时，
  只能返回 `EVIDENCE_BOUNDED_RESEARCH + UNSCORED`，不能伪装成 P0-P3 正式评分；
- `seo_ops.keyword_request.v2` 固定 `US / en-US / GOOGLE`，并携带结构化
  `merchant.locations`，问卷自由文本不能覆盖市场与地点；
- FBR 现有只读契约为 `PUT /seo/keywords`（按 `merchant_id` 查询）和
  `GET /seo/keyword/local/:placeId`。未来 SEO Ops 只通过适配器读回，不修改 FBR 仓库；
- FBR 写入 `/seo/keyword`、旧 Skill 的 `saveKeyword` 与报告上传不属于 Keyword Agent 的权限。

## 环境变量（新增）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SEO_OPS_SINGLE_USER` | false | true = 每个请求都是本地管理员（全权限全商户），跳过登录。仅限单人自用。 |
| `SEO_OPS_MOCK_EXECUTION` | false | true = 执行派发不打 core-ai，本地立即成功（写入类给 `mock:` 引用）。 |
| `SEO_OPS_SCHEDULER_INTERVAL_MS` | 60000 | 周期调度 tick 间隔。 |
| `SEO_OPS_EXECUTION_POLL_INTERVAL_MS` | 10000 | 执行 worker 轮询间隔。 |

旧变量（DATABASE_URL / CORE_AI_* / SESSION_*）不变。`SEO_OPS_AUTH_DISABLED` 仍被拒绝。

## Core AI Agent 对账工具（本地管理面）

该工具只读取本仓库 `server/core-ai-agents/*.json` 作为 desired state。凭证只能通过服务端环境
变量 `CORE_AI_BASE_URL`、`CORE_AI_TOKEN` 注入，禁止作为 CLI 参数、日志或 evidence 内容传入。
首个版本是 **versioned CREATE-ONLY**。dry-run 必须显式选择全部 manifest 或逐个选择 manifest，
并生成一个仓库内、不可覆盖、已 fsync 的 reviewed plan；人工审核该 plan 后，apply 只能消费这一个
plan，不能重新声明 scope：

```bash
REPO_ROOT="$(pwd)"
PLAN_DIR="$REPO_ROOT/docs/evidence/core-ai-agent-plans"
JOURNAL_DIR="$REPO_ROOT/docs/evidence/core-ai-agent-journals"
mkdir -p -- "$PLAN_DIR" "$JOURNAL_DIR"
PLAN="$PLAN_DIR/2026-08-27-core-ai-agent-plan.json"
JOURNAL="$JOURNAL_DIR/2026-08-27-core-ai-agent-journal.jsonl"
test ! -e "$PLAN" && test ! -e "$JOURNAL"

npm --prefix server run agents:reconcile -- --mode=dry-run --all --plan="$PLAN"
# 或：重复 --manifest=server/core-ai-agents/<file>.json 进行显式子集审核

# 人工核对 PLAN 中的 ordered paths、manifest/action/reference hashes 与 overall digest 后：
npm --prefix server run agents:reconcile -- --mode=apply \
  --plan="$PLAN" --evidence="$JOURNAL"
```

- 非 loopback URL 必须使用 HTTPS；redirect、跨 origin、非 JSON、超限响应均 fail closed。
- `GooglePost每周图文助手` 只作为 `EDITABLE_REFERENCE_ONLY`：GET/export 是可编辑视图，不代表
  已发布 runtime snapshot，也不构成 clone 证明；名称固定且没有 CLI/library override。plan 绑定完整安全
  reference coordinate（状态、managed/executable field hashes、未管理字段空值摘要和 API 明确提供时的 owner ID），
  输出证据范围固定为 `EDITABLE_CONFIG_AND_STATUS_ONLY`。API 未提供稳定 `owner_id` 时记录 null；不会把
  display-name `created_by` 猜成 owner ID。
- reference 与 desired name 都通过完整分页 global query 做 exact/unique 判断；既有 desired Agent 还必须在
  完整 `my=true&include_system_default=false` roster 中唯一对应。跨 owner、system-default 或重复同名一律停止。
- 既有 `[SEO Ops]` Agent 只有状态精确为 `PUBLISHED`、完整 editable config 相同且所有未管理执行字段为空时
  可返回 `NO_CHANGE`；
  任一漂移都要求新建更高版本名（例如 v2 → v3），工具没有 PUT existing Agent 能力。
- apply 在任何 POST 前重新校验全部本地文件、ALL/explicit scope、reference coordinate 和远端 pre-state；
  任一文件、scope、reference 或 remote hash 漂移都会停止。
- plan 只能位于 `docs/evidence/core-ai-agent-plans/`，journal 只能位于独立的
  `docs/evidence/core-ai-agent-journals/`；两者必须在 manifest root 外，且 canonical path 与所有 manifest
  不同。symlink、hardlink inode alias、路径穿越和预先存在的 journal 都会被拒绝。journal 以 exclusive
  create + no-follow 打开，在任何远端重验/POST 前 fsync；每次 create/validate/publish intent 与 outcome
  都逐条 append + fsync。
- create 后先按返回 UUID 独立 GET，并通过完整 `my=true&include_system_default=false` roster 与 global exact
  discovery 证明它是当前主体新建的 exact-name、`DRAFT`、非 system-default、完整配置匹配且无未管理执行字段
  的 Agent；验证失败只写 durable failure 并停止，不 publish、不 PUT、不 DELETE。验证通过后才 publish，
  再独立 GET；readback 会再次拒绝未管理执行字段。
  它只证明 editable config/status，不证明 published runtime snapshot 等价。
- 新 Agent 的远端恢复事实固定记录为 `NO_DELETE_REMOTE_ROLLBACK`。工具没有 PUT、DELETE 或可执行 rollback；
  reference UUID 也不能作为 create response 后的 publish/readback 坐标。
- 工具要求运行平台提供 `O_NOFOLLOW`，否则 fail closed；同时在打开/写入前后复核 canonical path 与 `dev/ino`。
  这些检查缩小但不能消除同一主机上拥有目录写权限的攻击者造成的 TOCTOU 竞争，因此 plan/journal 目录权限
  仍必须仅授予执行对账的操作员。

## 六导航（账本视角）

1. **总览 `/`** —— 四个人工队列（待判定 / 门1 / 门2 / 待核验）+ 冻结商户横幅 + 商户面。
2. **商户 `/merchants`** —— 原异常清单；商户页保留接入期阶段轨。
3. **任务 `/inbox`** —— 执行任务表 + 「待判定·建议」tab（Planner 只提交 proposal；采纳→SEO Ops 建任务回链；退回必填理由；校验失败只能退回）。
4. **运行 `/runs`** —— 门2待确认 → 派发在途 → 结果待查（查证弹层，二选一裁决）→ 待核验。
5. **复盘 `/reviews`** —— 证据分级复盘（原样保留）。
6. **设置 `/settings`** —— Agent 绑定（含 PLANNER 与 specialist）/ 能力矩阵（三层推导）/ 周期配置（Ⓐ级授权书）+ 手动「调度一轮 / 执行一轮」。

## 自动化分级（后端强制，不是 UI 约定）

- **Ⓐ READ_ONLY**（报告/关键词周分析/审计/评论巡检）：周期配置 = 预授权。
  已绑定 PLANNER 时，scheduler 将同一轮到期信号聚合为一个 Planner Task，由 Planner 决定
  具体 occurrence proposals；未绑定 PLANNER 时保留旧的直接建任务兼容路径。
  采纳只读 proposal 后直接 APPROVED（留系统审批记录 `AUTO_AUTHORIZED`）→ 自动派发；
  失败自动重试 ≤3 次（`READ_ONLY_AUTO_RETRY_LIMIT`）后 FAILED 升级人工。
- **Ⓑ ARTIFACT / 内容生成**：周期自动建 GBP_POST 任务，但 `required_evidence_types=["CONTENT_DRAFT"]`
  ——没有定稿进不了审批，永远停在双门前。
- **Ⓒ AUTO_WRITE**（GBP/官网写入、Post 发布）：门1 审批（rev+hash）+ 门2 执行确认
  （六项服务端校验：rev/hash 一致、审批有效、能力 ACTIVE、locationName 匹配、无在途/未冻结、前置任务已完成），
  发布后进 PENDING_VERIFY（7 天核验窗口）。

红线③：结果不明（超时/网络裂缝/取消）→ attempt `OUTCOME_UNKNOWN`，**该商户执行链冻结**，
查证（发生了/没发生）是唯一出口；只读任务不受此限。

`SEO_OPS_MOCK_EXECUTION=true` 只验证 Task/attempt 状态机，不调用 specialist，也不会生成
真实问卷草稿或其他业务成品；验证 Agent 结果适配器时必须关闭 mock 并配置对应绑定。

结构化 specialist 的成功门是：Core AI Run 完成 → SEO Ops 严格解析 schema → 产物写入
`seo_specialist_artifacts` → 独立读回 → attempt/Task 才结算成功。缺一项都不能把 Task 标为 DONE。

## 已验证路径

```
seed:demo → 总览显示 2 待判定
任务/待判定 → 采纳 REPORT 建议 → 任务落库（source=PROPOSAL, proposal_id 回链）
Only Bear Post：drafts v1→v2（含反馈留痕）→ v2 定稿 → G1 批准
→ /runs 门2队列 → 任务页执行面板六灯全绿 → 确认执行 → mock worker 结算
→ PENDING_VERIFY（mock:exec-… 引用 + 7 天窗口）→ 核验 → DONE
事件链：TASK_CREATED → EVIDENCE_APPENDED → TASK_APPROVED → EXECUTION_CONFIRMED
→ ATTEMPT_DISPATCHING → EXECUTION_SUCCEEDED → VERIFIED → TASK_DONE
```

真实 Planner 联调（2026-08-26）：

```text
新建合成商户 15ece7f6-3a6f-4e1d-8629-07da32dbfce8
→ SEO Ops 自动建立并授权 PLANNER Task 8be0bceb-6a4e-4eba-a4f5-3fceb55b4e58
→ Core AI Run 54808219-16a4-40cc-a3e5-919537cd0b30 COMPLETED
   trace 3931f64be6473f63e2bd1d77c917d7d5
→ SEO Ops 严格解析 seo_ops.task_proposals.v1
→ Proposal Batch 7e143850-3a24-4afb-a22f-b7a0953f95ad 持久化
→ 仅生成一个 QUESTIONNAIRE / READ_ONLY / PENDING proposal
```

Agent response schema 加严并重新发布后，又用固定 fixture 独立触发：Run
`91f32e6c-43d8-4f0c-96b5-b33a1f68e121`，trace
`1941b8eb81709f3be3d5899ce0ca55ff`；UAT 状态回读为 COMPLETED，且本仓库
`parsePlannerOutput` 严格解析通过。早期不完整字段输出未被 SEO Ops 接纳，保留为负向契约证据。

Questionnaire 与网站透传联调（2026-08-26）：

```text
Planner fixture（trigger.signals.website）
→ Core AI Run 195b95a8-8362-4649-a581-124ccca0ac49 COMPLETED
→ parsePlannerOutput 严格解析通过
→ QUESTIONNAIRE proposal.execution_spec.website 原样保留

Questionnaire fixture（seo_ops.questionnaire_request.v1）
→ Core AI Run d3de3618-0bc7-4169-8a73-706eae195a87 COMPLETED
→ 返回 14 个问题的 seo_ops.questionnaire_draft.v1
→ parseQuestionnaireOutput 严格解析通过
```

以上真实 UAT Run 证明 Agent 输出契约可被本地适配器接受；它不是“SEO Ops Task 已完成”的
独立证明。Task 完成仍要求 worker 回读该 Run、成功持久化问卷 DRAFT，再结算 attempt 与 Task。

完整跨系统验收也在隔离 PostgreSQL schema 中跑通：

```text
Merchant aded0828-72b2-4054-833f-30ff649134ea
→ Planner Task 633bb32a-617b-4125-9dad-5438e3498a82
→ Planner Run 9836ce24-644d-4567-88a3-c479d831959c
→ QUESTIONNAIRE Proposal f33503cd-7b97-46b1-8028-0a331099bd92（website 原样保留）
→ Adopt → Task 283df17c-dd4f-4bda-9d93-1a4098ba0025
→ Questionnaire Run dc874d05-6aef-43ac-9d6c-b0131cd75bc4 COMPLETED
→ Attempt SUCCEEDED
→ Questionnaire 4e93845a-2a56-48ed-8362-52446fbddc34 持久化为 DRAFT（13 题）
→ Task DONE
```

验收后已停止临时服务并删除明确命名的隔离 schema；现有开发数据未参与该验收。

完整新店 specialist 链也已通过真实 Core AI UAT 与本地 SEO Ops（2026-08-26）：

```text
Merchant 1d067564-cdbd-4186-87dc-e53a2399a3e9
Keke Food · Complete Agent Chain（slug: keke-ready-pipeline-185545）
→ Planner 首轮：QUESTIONNAIRE proposal → Adopt
→ Questionnaire Agent → DRAFT 落库 → 发放 → 填写
→ Planner 次轮：KEYWORD_RESEARCH → AUDIT → REPORT → PLAN + MANUAL_FOLLOWUP
→ 四个 specialist Task 依赖顺序执行并全部 DONE

KEYWORD_SET      Core Run 35ef2b6d-a117-4f89-9b0e-b8f0506065cf
AUDIT_REPORT     Core Run be866d56-d562-4ff3-8199-1013df2beeb2
RANKING_SNAPSHOT Core Run 01153b6b-34e8-4e27-b5e9-8c438beb3711
EXECUTION_PLAN   Core Run 8d6f4ed5-a046-47db-83f3-3423226221ce

Lifecycle 独立回读：stage=PLAN，ranking_round_count=1；
KEYWORDS/AUDIT/RANKING_BASELINE/PLAN 各有 1 个已接纳产物。
```

上述 `keke-ready-pipeline-185545` 是早期结构联调样本，问卷误放入 Wuhan，不能作为美国市场
关键词业务验收。已另建美国门店样本 `Keke Food · Flushing NY`
（merchant `c18ebb72-d3d9-44f3-a1b2-b76492100c02`，地点 `Flushing, Queens, NY`，
timezone `America/New_York`，带 Google Place ID）用于纠正验证。Keyword v2 已完成真实重跑：

```text
KEYWORD_WEEKLY Task 6c3548af-45e9-4bb7-88c2-64db793a2dce
→ 第 1 次 Run 2c857026-842b-4f07-9a2e-601d8377284d 在 UAT Pod rollout 时成为孤儿 Run
→ 精确取消并读回 CANCELLED；SEO Ops 记录 attempt 1 = FAILED_CONFIRMED
→ 只读自动重试 attempt 2 / Run c2f843c1-9fdd-48f0-ad1a-48fa6e2b0824
→ Core AI COMPLETED / trace e95ecc5f746cde48b0ffadf20f09dcd1
→ SEO Ops 严格解析并独立读回 artifact bf397155-4f20-4ed7-b122-a4344e01e4fd
→ Task DONE

产物：seo_ops.keyword_set.v2 / US / en-US / GOOGLE / Flushing, Queens, NY
方法：EVIDENCE_BOUNDED_RESEARCH
关键词：27 个，LOCAL + ORGANIC，全部 UNSCORED；无 Wuhan/武汉地点词
边界：未收到旧确定性 local_keywords/organic_keywords + P0-P3 产物，故不冒充正式评分
```

旧 Wuhan 产物不得复用。本次还验证了 UAT 滚动期间的只读失败可追踪与自动重试；Run
`RUNNING` 本身不是完成证据，只有 Core AI COMPLETED、SEO Ops schema 校验、artifact 独立读回
以及 Task DONE 才算闭环。

另保留一次真实负向证据：早期商户 `b252a3d6-5d77-4be9-8437-59734480ccc4`
在尚未绑定 `REPORT` 时，建议被标记 `VALIDATION_FAILED: AGENT_NOT_BOUND:REPORT`，未绕过校验。

最终测试数量以当前命令输出为准：`cd server && npm test && npm run typecheck && npm run build`；
仓库根目录 `npm run test:run && npm run build`。不得沿用旧计数宣称通过。

## 数据模型增量（migrate.ts 自动建表/补列，无需手工 SQL）

新表：`seo_proposal_batches` / `seo_proposals` / `seo_execution_attempts` /
`seo_capabilities` / `seo_cycle_configs` / `seo_agent_bindings` /
`seo_content_drafts` / `seo_style_profiles` / `seo_specialist_artifacts`。
`seo_tasks` 新列：`execution_mode / proposal_id / depends_on_task_ids / attempt_count / published_ref /
published_at / verify_due_at / verified_at / verified_by`。

## 尚未完成的下一段

1. 增加依赖图的运营可视化、批量采纳与失败后的重规划策略。
2. 完成 SEO Ops UAT Pod 的 Secret、进程拆分、监控、发布与回滚验收，并在 UAT 数据库配置
   全部 Agent bindings（本地开发库绑定不能替代 UAT 配置）。

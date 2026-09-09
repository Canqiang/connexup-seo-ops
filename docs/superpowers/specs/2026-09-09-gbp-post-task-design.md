# GBP Post 任务设计（第一个外部写闭环）

日期：2026-09-09
状态：待用户审阅。第二版（2026-09-09 下午）：按用户审阅 AM 工作台原型时的裁定，把第一版的「单任务三阶段」改为「草稿 → 审核 → 发布」三个独立 Task，聚合成一张「GBP 内容工作单」。工作单界面原型见 `docs/evidence/2026-09-09-am-workspace-ui/`（`am-gbp-work-order` 区块）；帖子卡视觉沿用 `docs/evidence/2026-09-09-gbp-post-ui/`。
取代：`2026-09-03-gbp-post-execution-phase-3.md` 里「发布 Agent + 验证 Agent + 托管策略」的实施假设，以及本文件第一版的单任务三阶段模型；沿用 `2026-09-02-agent-generated-task-dependencies-design.md` 的状态机、ApprovalGrant 与「只有读回才算 DONE」原则；与 `2026-09-09-agent-driven-local-seo-am-os-design.md` §6.3、§6.4、§9.2、§18.2 一致。

## 1. 目标

让一张 GBP 内容工作单从「诊断 Plan、Orchestrator 或 AM 提出」走到「Google Business Profile 上真的出现这篇帖子」，全程满足三条红线：

1. 任何外部写入必须经 AM 在一个分派给他的审核任务里显式批准，且批准精确绑定要发布的那一版内容与图片。
2. 发布动作由能力受限的 Agent 执行，SEO Ops 只触发一次，任何不确定结果都不重发。
3. 只有服务端从 FBR 读回、与批准内容精确匹配、状态 LIVE，任务才 DONE。

## 2. 已拍板的决定（2026-09-09 讨论）

**总原则：Agent 驱动；AM（人）是执行者类型之一。** 任何阶段的执行者都建模为 `assignee(AGENT|HUMAN)`，共用同一条 attempt、授权、读回核对链路；不为「人工」单独造旁路。

| 问题 | 决定 |
|---|---|
| 任务粒度（2026-09-09 下午裁定） | 拆成三个独立 Task：草稿（内容 Agent）、审核（分派给 AM 的人工任务）、发布（发布 Agent，或 AM 自己）；远端核验是发布任务的验收阶段，由服务端执行。三者聚合成一张「GBP 内容工作单」展示，AM 不必来回打开多页，但每一步的负责人、状态、交付物独立明确。取代第一版的单任务三阶段 |
| 派单方式 | 工作单在 Plan 授权范围内由服务端一次性创建三个任务并派单，审核任务自动分派给商户负责 AM；不需要 AM 逐个「应用提案」。超出授权范围（新增预算、超过条数）时整组进审批，不只创建前半段 |
| 谁生成内容 | 草稿任务的执行者默认是内容 Agent（Core AI），输入由 SEO Ops 服务端组装；执行者模型允许 HUMAN，但第一版不开放人工写稿 |
| 操作员能否改内容 | 不能。审核任务只有两种交付：批准这一版 / 退回并说明；退回后由服务端新建下一版草稿任务 |
| 图片来源 | Agent 决定：候选图库有真实照片就选，没有才生成一次；操作员不按任务选图 |
| 谁发布 | 发布任务的执行者默认是绑定的发布 Agent（Core AI，只挂 `createLocationPost`）；AM 可把发布任务改派给自己（HUMAN 执行者），用现有任务分派机制，不在批准对话框里选 |
| 从哪里批准 | 只能在工作单的审核视图里，看完整正文、真实图片、CTA 目标网址、目标门店后批准确定的这一版；首页卡只有「审阅草稿」，没有「批准并发布」 |
| 怎么验收 | 服务端读 FBR 帖子列表，正文 + CTA 精确匹配、唯一、LIVE 才 DONE |
| 任务来源 | 诊断 Plan 提出、Orchestrator 在授权范围内创建、商户页手建；一张工作单一篇，不做排期日历 |
| 本地活动与节日 | 服务端算节假日 + 操作员录入活动优惠；第一版不让 Agent 上网 |
| Agent 配置归属 | Skill 与 Agent 配置文件放本仓库，导入 Core AI 新建，不改仓库外代码 |

## 3. 范围

做：
- 工作单对象与三个 Workflow Template（`GBP_POST_DRAFT`、`GBP_POST_REVIEW`、`GBP_POST_PUBLISH`）及参数 schema；Plan 物化、Orchestrator `CREATE_TASK` 与商户页手建三个入口都展开成同一张工作单。
- 商户风格档案、商户图库（含首个文件上传接口）、本期活动与优惠三个新数据对象及其页面。
- 内容 Agent 的 Skill 包与 Agent 配置（本仓库）、发布 Agent 的 Skill 包与 Agent 配置（本仓库）、导入与绑定记录。
- 服务端：请求组装、草稿 attempt、artifact 落库与图片下载、审核决定与授权、退回后的下一版草稿、`audit_id` 解析、发布 attempt、trace 核实、FBR 读回核对与退避、依赖的显式解除。
- 工作单页、首页「审阅草稿」与「开始核验」两类卡、商户页与资料页新增区块、任务总览类型筛选。

不做（第一版）：
- OFFER / EVENT 类型帖子；排期日历；自动化托管策略；Agent 上网找活动；图片参与验收；补偿任务的自动化（补救一律新建任务）；改 Core AI 或 FBR 代码。

## 4. 角色与数据流

```
Plan 物化 / Orchestrator CREATE_TASK / AM 手建 ──在授权范围内创建并派单──▶ 工作单 GBP_POST
    ├─ 草稿 Task   执行者：内容 Agent        前置：风格档案存在（可选：人工输入任务）
    ├─ 审核 Task   执行者：商户负责 AM（HUMAN） 前置：草稿 DONE
    └─ 发布 Task   执行者：发布 Agent（可改派 AM） 前置：工作单存在有效批准

草稿：服务端组装 seo_ops.gbp_post_request.v1 ──▶ 内容 Agent ──▶ draft.v2 + 图片 artifact
      ──▶ 服务端下载图片、落 task_artifacts ──▶ 草稿 DONE，交付物「帖子 vN」──▶ 审核 Task 进入 EXECUTING，AM 首页出现「审阅草稿」
审核：AM 在工作单里看完整正文、真实图片、CTA 目标网址、目标门店、版本 checksum
      ──▶ 批准这一版（grant 绑 artifact checksum + 图片 sha256 + 门店） ──▶ 审核 DONE(APPROVED)，发布 Task 变 READY
      ──▶ 退回并说明 ──▶ 审核 DONE(RETURNED) ──▶ 服务端建草稿 v(N+1) + 新审核 Task，发布 Task 继续等有效批准
发布：服务端重新校验批准有效 ──▶ 解析 audit_id ──▶ PUBLICATION attempt ──▶ 发布 Agent 调 createLocationPost 恰好一次 ──▶ post_id ──▶ VERIFYING
核验：服务端读 FBR /gbp/location/:id/post ──▶ 唯一精确匹配 + LIVE ──▶ 发布 DONE（工作单「已上线」）
      ──▶ 其他 ──▶ 发布 NEEDS_ATTENTION，AM 首页「上次发布结果未知，需要你核验」，绝不重发
```

五个执行角色的能力边界：

| 角色 | 运行位置 | 能力 | 禁止 |
|---|---|---|---|
| 内容 Agent（草稿 Task） | Core AI | `builtin-media-generation`（生图一次） | 任何写 GBP、上网、文件、子 Agent |
| AM（审核 Task） | 工作台 | 批准这一版 / 退回并说明；暂时受阻、请求协助、转交、取消 | 改正文、改图、改 CTA、改门店；替模型「代批」 |
| 发布 Agent（发布 Task） | Core AI | `api-operation:operation-assistant-api:GBPOperationWebService:createLocationPost` | 改内容、改目标、任何读或第二次写 |
| AM 作为发布执行者（HUMAN） | 操作员 | 按发布清单在 GBP 后台发布，声明「我已发布」 | 改内容、改目标；DONE 仍只由服务端读回决定 |
| 核验 | SEO Ops 服务端 | FBR 只读 | 无 |

服务端是唯一能把任务推到 DONE 的角色；Orchestrator 只能提 `CREATE_TASK` / `ASSIGN_TASK` / `REQUEST_HUMAN_INPUT` 等提案，不能 `SET_DONE`，也不能替 AM 提交批准。

## 5. 任务模型

### 5.1 工作单与三个模板

工作单不是任务，是一个分组：`task_work_orders` 一行，加上通过 `tasks.work_order_id` 归属它的若干 Task（初始三个，每次退回再加两个）。每个 Task 有自己的模板、执行者、状态、交付物；工作单的状态是派生的，不单独存。

| 步骤 | 模板 | 执行者 | 交付物 | 前置 |
|---|---|---|---|---|
| ① 草稿 | `GBP_POST_DRAFT` v1 | AGENT：内容 Agent | `task_artifacts` 一行：帖子 vN（正文 + 图片 + CTA） | 风格档案存在；可选：人工输入任务（如价格确认） |
| ② 审核 | `GBP_POST_REVIEW` v1 | HUMAN：商户负责 AM | `task_approvals` 一行：APPROVED 或 RETURNED（含理由） | 草稿 DONE |
| ③ 发布 | `GBP_POST_PUBLISH` v1 | AGENT：发布 Agent（可改派给 AM） | `provider_resource_id`（post_id）+ 核验证据 | 工作单存在**有效批准**（不是只看审核 DONE） |
| ④ 远端核验 | 发布 Task 的 VERIFYING 阶段 | SYSTEM：服务端 | VERIFICATION attempt 的读回快照与匹配依据 | 发布 attempt 结束 |

远端核验不拆成第四个 Task：它没有独立交接价值（AM OS §6.3 的拆分标准），而且发布 Task 的 DONE 就是由它定义的。工作单界面仍把它画成独立的第 ④ 步，负责人「系统」，有自己的状态与证据。

合法路径（复用现有状态词，AM OS §6.4）：

```
GBP_POST_DRAFT   : PENDING → PREPARING → DONE
                   PREPARING → NEEDS_ATTENTION（needs_input / 图片下载失败）→ PENDING | CANCELLED
GBP_POST_REVIEW  : PENDING → EXECUTING（草稿 DONE 时服务端自动推进并通知 AM）→ DONE（批准或退回都是完成）
                   EXECUTING → NEEDS_ATTENTION（暂时受阻）→ EXECUTING | CANCELLED
GBP_POST_PUBLISH : PENDING → EXECUTING → VERIFYING → DONE
                   EXECUTING | VERIFYING → NEEDS_ATTENTION → VERIFYING（重新核验）| PENDING（仅当证明未发生外部写）| CANCELLED
三个模板 terminal_after_approval = False；GBP 不再使用 AWAITING_APPROVAL——批准是一个任务，不是一个状态。
```

就绪性按现有规则派生，不允许手改：审核 Task 在草稿未 DONE 时 `WAITING_DEPENDENCY`；发布 Task 在没有有效批准时 `WAITING_AUTHORIZATION`（审核已 DONE 但结果是退回时，依赖满足、授权不存在，显示的必须是 WAITING_AUTHORIZATION）；草稿 Task 风格档案缺失时 `WAITING_INPUT`（blocker `VOICE_PROFILE_MISSING`）。

中文状态（卡片上只出现这些，枚举进详情的技术信息）：草稿「准备中 / 已完成 / 需要处理」；审核「待前置 / 分派给你 / 已批准 / 已退回 / 受阻」；发布「待前置 / 发布中 / 核对中 / 已上线 / 需要处理」。工作单派生状态：草稿中 → 待审核 → 待发布 → 发布中 → 核对中 → 已上线；任一任务 NEEDS_ATTENTION 时「需要处理」；取消时「已取消」。

取消：草稿 PENDING 可取消，PREPARING 需确认无活跃 attempt；审核可取消，等于取消整张工作单（草稿产物保留只读）；发布 PENDING 可取消；EXECUTING / VERIFYING 不可取消，必须先核验；DONE 不可取消。取消工作单 = 取消其所有非终态任务并撤销有效批准（`REVOKED`）。

### 5.2 依赖与显式解除

草稿 Task 可以依赖人工输入任务（例如「确认 Weekday Brunch Set 的价格与有效期」），依赖是硬的：未满足则草稿 `WAITING_DEPENDENCY`，内容 Agent 不会被触发。

如果决定「先出不含价格的版本」，不允许静默绕过。解除依赖是一次显式操作：`DELETE /api/tasks/{id}/dependencies/{dep_id}` 带理由，记录 `task_events` 一条 `DEPENDENCY_WAIVED`（actor、时间、理由）。Orchestrator 在授权范围内通过提案请求解除，AM 可以直接操作。工作单在第 ② 步的依赖说明里原样显示：「本版不含价格。价格确认任务 T-1205 已解除对本版的阻塞；含价格的更新帖会另建工作单。」就绪性永远从当前 blocker 派生，所以界面不会同时出现「被阻塞」和「可发布」。

### 5.3 参数

工作单：

```json
{ "location_id": "<商户已绑定的 GBP location resource id>", "topic": "<1–500 字>" }
```

每个 Task 的 `parameters` 带 `work_order_id`；草稿 Task 另带 `version`（从 1 起）和 `reviewer_feedback`（v ≥ 2 时为上一版退回理由，进入请求的同名字段）；发布 Task 另带 `approved_artifact_checksum`（批准时写入）。Plan 校验：`location_id` 必须存在于该商户 `merchant_gbp_profiles` 的门店列表；`topic` 非空。第一版 `post_type` 固定 STANDARD，不入参数。

### 5.4 来源与派单

- 诊断 Plan：Agent 在 `seo_ops.task_plan.v1` 里提出 `task_type: "GBP_POST"`，Plan 审批物化时由服务端规则（不是 LLM）展开成一张工作单 + 三个任务。
- Orchestrator：`CREATE_TASK` 命令带 `task_type: "GBP_POST"`，在 Plan 授权范围内（例如「GBP 帖子发布（逐条审批）」且未超本周期条数）直接创建并派单，对话里显示「已在 Plan #N 授权范围内创建并分派」；超出范围时整组进 `REQUEST_APPROVAL`，AM 整体批准或退回。
- 商户页手建：新建工作单表单（类型、门店、主题）；服务端包装为隐式 OPERATOR Plan（现有机制）后走同一展开。

派单：草稿 Task 分派给绑定的内容 Agent；审核 Task 分派给商户的负责 AM（服务端路径，不走操作员自派接口）；发布 Task 分派给绑定的发布 Agent。三者一次创建，依赖同时写入 `task_dependencies`。

首页归类：审核 Task 因为决定一次外部写，进「需要我决定」，卡片主按钮「审阅草稿」；发布 Task 核验失败进「需要我决定」，主按钮「开始核验」；草稿 Task 的 needs_input 生成的人工输入任务进「分派给我」。

## 6. Agent 配置（本仓库交付）

目录 `docs/agents/gbp-post/`：

```
content-skill/SKILL.md               内容 Agent 的 Skill 正文
content-skill/references/*.md        真实性规则、输入契约、输出契约、图片策略
content-agent.json                   POST /api/agents 的提交配置
publisher-skill/SKILL.md             发布 Agent 的 Skill 正文
publisher-skill/references/*.md      FBR 帖子字段规则（裁剪自 fbradmin/seo-gbp-execution posts.md）、响应契约
publisher-agent.json                 提交配置
<date>-readback.md                   创建、发布、读回、散列记录（沿用 task-preparation 惯例）
```

导入流程沿用 `docs/agents/task-preparation-2026-09-08-readback.md`：先按名查重、POST 一次、GET 读回比对、publish、再 GET 读回；记录配置文件 SHA-256 与远端快照散列；不原地修改，升级即新建替代 Agent。Skill 用 Core AI 的上传接口，格式与 `GET /api/skills/{id}/download` 相同（`content` + `resources[]`）；确切路径在实施前用只读探测确认。

绑定：扩展 `SEO_OPS_TASK_AGENT_BINDINGS` 的语义，为每个 GBP_POST 角色单独配置：

```dotenv
SEO_OPS_GBP_POST_CONTENT_AGENT={"coreai_agent_id":"…","config_sha256":"…"}
SEO_OPS_GBP_POST_PUBLISHER_AGENT={"coreai_agent_id":"…","config_sha256":"…"}
SEO_OPS_GBP_POST_ENABLED=false
```
启动时按现有 `task_agent_protocol.agent_snapshot` 读回并校验散列、能力字段（内容 Agent 只能有 media-generation；发布 Agent 只能有那一个 API 工具，`max_turns ≤ 3`，无 skill 以外的能力）。不匹配即拒绝启用 GBP_POST，不回退。

### 6.1 内容 Agent Skill 要点

- 吸收「GooglePost每周图文助手」的全部真实性规则（严禁编造、不确定即不写、SEO 关键词不等于商家事实、图片同样遵守），但去掉「向用户提问」与「一周 3–5 篇排期」：缺关键输入时返回 `outcome: "needs_input"` 并列出缺什么，不提问、不猜。
- 输入固定为 `seo_ops.gbp_post_request.v1`（附录 A），输出固定为 `seo_ops.gbp_post_draft.v2`（附录 B），`response_schema` 强制。
- 图片策略：`photo_candidates` 非空 → 选一张 `authorized=true` 的，输出 `media.selected_candidate_id`，不调用生图；为空 → 调用 `generate_image` 恰好一次，`media_brief` 必须声明 AI 生成，alt 文本以「AI-generated」开头。
- 日历使用规则：只允许引用 `calendar_context` 里的条目；引用时把条目 id 写进 `evidence_references`。
- 模型与参数：`deepseek-v4-pro`，temperature 0.1，`max_turns` 4，timeout 600s，`enable_memory=false`。

### 6.2 发布 Agent Skill 要点

- 输入 `seo_ops.gbp_post_publish_request.v1`：`task_id`、`attempt`、`idempotency_key`、`approval_id`、`audit_id`、`location_id`、批准的 `post`（`topic_type`、`language_code`、`summary`、`call_to_action`、`media[]`）、`artifact_checksum`。
- 行为：校验字段完整 → 调用 `createLocationPost` 恰好一次 → 返回 `seo_ops.gbp_post_publish_result.v1`：`{outcome: "created"|"rejected"|"error", post_id?, provider_status?, error?}`。任何情况下不得第二次调用、不得读、不得改字段。
- 模型 `deepseek-v4-pro`，temperature 0，`max_turns` 2，timeout 180s。

## 7. 服务端组装的输入

| 字段 | 来源 |
|---|---|
| `merchant` / `location` | `merchants` + `merchant_gbp_profiles` 快照（名称、地址、电话、营业时间、服务方式、FBR 与 Google 身份） |
| `occurrence_at` | Task `scheduled_start`，缺省为当前时间（商户时区） |
| `voice_profile` | `merchant_voice_profiles` 当前版本（新表） |
| `calendar_context` | 服务端：美国联邦节假日静态表（未来 30 天内的）+ `merchant_promotions`（新表，操作员录入的活动与优惠，取 `occurrence_at` 前后 30 天内有效的） |
| `primary_keyword_cluster` | 当前活动关键词版本 Top 关键词（≤20）+ 搜索意图 |
| `evidence_references` | 关键词版本 id、GBP 快照 id、风格档案版本、日历条目 id |
| `photo_candidates` | `merchant_photos`（新表）：FBR 菜品图与帖子图（只读引用）+ 操作员上传且 `authorized=true` 的图，每张含 `id`、`url`、`alt`、`source` |
| `business_input_fingerprint` | 以上全部规范化 JSON 的 sha256，写入 attempt |

风格档案缺失 → 草稿 Task 在 PENDING 被阻断（blocker `VOICE_PROFILE_MISSING`，就绪性 WAITING_INPUT），工作单第 ① 步提示去填写；不用默认档案。

## 8. 草稿 Task

（草稿 Task，执行者内容 Agent）

- 触发条件：草稿 Task READY（风格档案存在、依赖满足）。沿用 `task_agent_preparation.start_agent_preparation` 的一次性 trigger、attempt、dispatch_token；按模板分发请求构造器与结果解析器（`gbp_post_contract.py`）。
- 轮询到 COMPLETED：严格解析 draft；`outcome == "needs_input"` → attempt FAILED，草稿 Task NEEDS_ATTENTION，工作单第 ① 步展示缺失项。Orchestrator 可据此提案 `REQUEST_HUMAN_INPUT` 建人工输入任务并加为草稿的依赖；输入完成后草稿回 PENDING 重新触发。
- 图片：`media.selected_candidate_id` 必须在本次候选里；否则 run 的 `artifacts[]` 必须恰好一张 image/png|jpeg，立即下载到 `data/task-media/<task_id>/<attempt>/<sha256>.<ext>`，记录 sha256、字节数、content_type、`source=AI_GENERATED`、原始 `download_url`（仅审计）。下载失败 → attempt FAILED，可重新准备。
- 落库 `task_artifacts`：规范化 artifact JSON、checksum、`media_id`、`version`；草稿 Task → DONE，交付物「帖子 vN」。服务端同一事务把审核 Task 从 PENDING 推到 EXECUTING，写事件并通知负责 AM。
- 草稿 DONE 后产物不可变；任何修改都是新版本、新草稿 Task。

## 9. 审核 Task 与发布 Task

### 9.1 审核 Task（HUMAN，分派给商户负责 AM）

- 审核视图就是工作单第 ② 步的展开：完整正文不截断；真实图片及其来源与授权标注（如「商户照片 · 来源：FBR 菜品图 #17 · 已授权」或「AI 生成」）；CTA 类型与真实目标网址；目标门店；版本号与 artifact checksum；依赖说明（§5.2）。首页卡只保留结论、影响、操作三行和 80 字预览（标注「完整内容在审阅页」），主按钮「审阅草稿」，不提供「批准并发布」。
- 决定 A「批准这一版」：ConfirmDialog（文案见附录 C）。服务端校验当前登录身份是审核 Task 的 assignee，不接受任何由模型提交的「AM 已批准」。写 `task_approvals`：review_task_id、draft_task_id、artifact checksum、media sha256、location_id、operator、时间、`grant_type=HUMAN`、`status=ACTIVE`、`expires_at`（默认 7 天）。审核 Task → DONE(APPROVED)，发布 Task 就绪性变 READY，`parameters.approved_artifact_checksum` 写入。
- 决定 B「退回并说明」：理由必填。写 `task_approvals` `status=RETURNED`；审核 Task → DONE(RETURNED)。服务端同一事务创建草稿 v(N+1)（`replaces_task_id` 指向旧草稿，`reviewer_feedback` 进请求）和新的审核 Task（同一 AM），并为发布 Task 新增对新审核 Task 的依赖；旧版产物与旧审核记录保留只读。退回理由同时作为「待确认经验」候选进入记忆（AM OS §10），需 AM 在记忆页确认才成为规则，不自动生效。
- 人工任务通用次操作（不再有「标记为无法完成」）：「暂时受阻」= 加 blocker 与备注，任务 NEEDS_ATTENTION，不关闭；「请求协助」= 写事件交 Orchestrator 接续（它可提案 `CREATE_TASK`），不关闭；「转交给…」= 改派给另一位 AM（需要把现有 `set_assignment` 的「HUMAN 只能派给自己」放宽为「AM 可转交给其他 AM」，见 §14）；「取消任务」= 理由必填 + 确认，等于取消整张工作单。
- 批准有效性在发布前重新校验（AM OS §9.2）：grant `ACTIVE`、未过期、artifact checksum 与图片 sha256 未变、location 未变、审核 Task 的 assignee 与 grant 的 operator 一致。任何不一致 → 发布 Task NEEDS_ATTENTION，不发布。

### 9.2 发布 Task

- 执行者：默认绑定的发布 Agent；AM 想自己发布时在发布 Task 上改派给自己（HUMAN），用现有任务分派机制。两种执行者创建同一种 PUBLICATION attempt（`executor_type ∈ AGENT|HUMAN` 记录在 attempt 上）。
- `audit_id` 解析（发布前，服务端）：`PUT /seo/audit` searchAudits 按 `merchant_id + place_id` 取最新；没有 → 发布 Task NEEDS_ATTENTION（blocker `FBR_AUDIT_MISSING`），提示先在 FBR 建立审计。不自动 saveAudit。
- 图片公网 URL：`MERCHANT_PHOTO` 用其 Google URL；`AI_GENERATED` / `OPERATOR_UPLOAD` 先用现有 FBR `upload-media` 把图片上传为门店照片得到 Google URL，再用于帖子（避免依赖 Core AI 公开链接的有效期）。这一步也是写，纳入同一次批准的授权范围，并在 attempt 里记录 media key。（待用户拍板，见 §14.2）
- AGENT 执行：先落库 request JSON 与 checksum、idempotency key，再 trigger 发布 Agent 一次。
- HUMAN 执行：attempt 落库后发布 Task 进 EXECUTING，工作单第 ③ 步给发布清单（正文复制、图片下载、CTA、目标门店、audit_id）；AM 点「我已发布，去核对」即写入声明并进入 VERIFYING。声明不是完成，核对规则与 AGENT 完全相同。
- 结果处理：COMPLETED 且 trace 里 `createLocationPost` 恰好一次且返回 `post_id` → 记 `provider_resource_id`，发布 Task → VERIFYING。trace 显示零次调用且 run 失败 → 可重新发布（同幂等身份，限 2 次）。其他任何情况（超时、多次调用、无 post_id、响应丢失）→ 直接 VERIFYING 以读回为准，绝不重发。
- 结果未知的通知：核验最终失败时发布 Task NEEDS_ATTENTION，核验责任人 = 商户负责 AM，首页「需要我决定」出现「上次发布结果未知，需要你核验」，主按钮「开始核验」（新建 VERIFICATION attempt），次按钮「查看读回列表」，提示「不会自动重发」。这条不能放进「需要关注」或「仅知会」。

## 10. 核对

（发布 Task 的 VERIFYING 阶段，执行者 SYSTEM；工作单第 ④ 步）

- 每次核对是一条 VERIFICATION attempt（`executor_type=SYSTEM`），有自己的时间、读回快照与结论；工作单第 ④ 步显示最近一次的状态与证据。
- 读 `GET /gbp/location/:id/post?limit=20`。规范化：换行统一 `\n`，仅去首尾空白，不改内部空格与 URL。
- 匹配：`summary` 相同且 `call_to_action.action_type` 相同且（非 CALL 时）`url` 相同，且与批准的 artifact checksum 对应的内容一致。有 `provider_resource_id` 时先按 `post_id` 精确取。
- 结果：唯一匹配且 `state == LIVE` → 发布 Task DONE，工作单「已上线」，`evidence_json` 记读回快照与匹配依据；`PROCESSING` / `SCHEDULED` → 保持 VERIFYING，按 1、5、15、60、60、60 分钟退避自动重读；无匹配 / 多匹配 / `REJECTED` / 重读用尽 → NEEDS_ATTENTION 附读回列表（§9.2 最后一条）。
- 「开始核验 / 重新核对」：创建新的 VERIFICATION attempt，只读，无次数限制。
- 进程重启：从持久 attempt 恢复，只做读回，绝不重新 create。

## 11. 数据模型变更

新表：
- `task_work_orders`（id, merchant_id, location_id, kind ∈ GBP_POST, topic, plan_id, created_by, created_at, cancelled_at, cancel_reason）。状态不存，从成员任务派生。
- `task_artifacts`（task_id, execution_id, schema_version, version, artifact_json, checksum, media_id, created_at）。
- `task_media`（id, task_id, source ∈ AI_GENERATED|MERCHANT_PHOTO|OPERATOR_UPLOAD, local_path, public_url, sha256, bytes, content_type, alt_text, created_at）。
- `task_approvals`（id, work_order_id, review_task_id, draft_task_id, artifact_checksum, media_sha256, location_id, operator, grant_type ∈ HUMAN, status ∈ ACTIVE|RETURNED|REVOKED|EXPIRED, reason, created_at, expires_at, revoked_at, revoked_by）。
- `merchant_voice_profiles`（merchant_id, version, tone_json, structure_json, avoid_json, image_policy_json, note, created_by, created_at）。
- `merchant_promotions`（merchant_id, kind ∈ EVENT|OFFER, title, starts_on, ends_on, terms, source_note, created_by, created_at）。
- `merchant_photos`（merchant_id, source ∈ FBR_MENU|FBR_POST|OPERATOR_UPLOAD, url, local_path, alt_text, authorized, sha256, created_at）。

`tasks` 新列：`work_order_id`、`replaces_task_id`、`related_task_id`（AM OS §6.3）。`task_dependencies` 与 `task_assignments` 现有表直接复用；依赖解除写 `task_events`（`DEPENDENCY_WAIVED`），不删历史。`task_executions` 现有列已够用（stage、approval_id、artifact_id、provider_resource_id、evidence_json），新增 `executor_type ∈ AGENT|HUMAN|SYSTEM`。

`WORKFLOW_TEMPLATES` 新增三个模板（§5.1 的路径），`enabled_task_types()` 只在 `SEO_OPS_GBP_POST_ENABLED=true` 且两个 Agent 绑定校验通过时包含它们。迁移按现有有序迁移与 fail-closed 契约校验方式加；第一版数据库里没有 GBP 任务，不需要兼容旧 stage 数据。

## 12. API 变更

- `POST /api/merchants/{id}/work-orders`（kind=GBP_POST，location_id，topic）：创建工作单 + 三个任务 + 依赖 + 分派，一个事务。Plan 物化与 Orchestrator `CREATE_TASK` 走同一内部函数。
- `GET /api/work-orders/{id}`：聚合视图，`steps[]` 四步各带 task、assignee、status、readiness、中文状态、交付物、attempts、依赖说明；`versions[]` 给出历次草稿/审核链；`current_action` 指出「现在需要谁做什么」。
- `POST /api/tasks/{id}/review-decision` `{decision: APPROVED|RETURNED, reason?}`：只接受 `GBP_POST_REVIEW` 且 assignee 是当前登录者；RETURNED 时理由必填；返回新建的下一版任务 id。
- 人工任务次操作：`POST /api/tasks/{id}/block` `{note}`、`POST /api/tasks/{id}/assist-request` `{note}`、转交复用 `PUT /api/tasks/{id}/assignment`（放宽为可派给其他 AM）、`POST /api/tasks/{id}/cancel` `{reason}`。
- `DELETE /api/tasks/{id}/dependencies/{dep_id}` `{reason}`：显式解除依赖，写事件。
- `POST /api/tasks/{id}/verify`：发布 Task 的「开始核验 / 重新核对」。
- `GET /api/merchants/{id}/profile` 增加 `voice_profile`、`photos`；新增 `PUT …/voice-profile`（新版本）、`POST …/photos`（multipart 上传，jpg/png ≤ 8 MiB）、`PATCH …/photos/{id}`（alt、authorized）、`GET/POST/DELETE …/promotions`。
- `GET /api/tasks/{id}` 与 `/execution` 对三类 GBP 任务分别返回 artifact 与 media（本地预览 URL）、approval、publication 与 verification attempts、读回列表；并带 `work_order_id` 供前端跳到工作单。
- 所有 GBP 入口受 `SEO_OPS_GBP_POST_ENABLED` 与两个 Agent 绑定校验共同门控。

## 13. UI

- 工作单页（原型 `docs/evidence/2026-09-09-am-workspace-ui/` 的 `am-gbp-work-order` 区块）：标题「GBP 内容工作单 · {主题} · {商户}」；主区一条竖向流水线四步，每步独立显示负责人、中文状态、交付物、时间；当前需要动作的一步展开，其余折叠。第 ② 步展开即审核视图（§9.1）；第 ③ 步 HUMAN 执行时展开发布清单；第 ④ 步展示最近一次核验证据。首屏 = 当前产物 + 现在需要谁做什么；依据、历史、技术 trace 放后面并折叠。
- 首页「需要我决定」：审核 Task 卡只留结论、影响、操作三行，依据折叠，主按钮「审阅草稿」进工作单；发布结果未知卡主按钮「开始核验」、次按钮「查看读回列表」、提示「不会自动重发」。
- 帖子卡视觉（图片、正文、CTA、门店、「AI 生成」角标）沿用 `docs/evidence/2026-09-09-gbp-post-ui/` 原型；该原型「单任务按阶段切换」的页面结构作废。
- 人工任务详情（审核 Task、人工输入 Task）次操作固定四个：暂时受阻、请求协助、转交给…、取消任务（取消需理由 + 确认）；说明行「受阻和协助请求会交给 Orchestrator 接续处理，不会关闭任务」。
- 商户页新增「新建工作单」（类型、门店、主题）与「本期活动与优惠」；资料页新增「风格档案」「图库」卡；任务总览加类型筛选并可按工作单分组。全部复用 `components/feedback`。

## 14. 待验证（写实施计划前各做一次）

1. Core AI Skill 上传接口路径与请求格式。
2. FBR `upload-media` 用 Core AI artifact 链接能否成功取图；若不能，改为 SEO Ops 先下载再以自身可公网访问的地址上传，或由发布 Agent 用 base64。
3. FBR `searchAudits` 是否返回可用 `audit_id`，`createLocationPost` 是否校验其存在。
4. FBR 帖子列表新帖出现的延迟与 `PROCESSING` 时长。
5. 发布 Agent 在 `max_turns=2` 下能否稳定完成一次调用并返回结构化结果。
6. `merchants` 是否已有「负责 AM」字段（审核 Task 自动分派的目标）；现有 `task_assignments.set_assignment` 的「HUMAN 只能派给自己」限制放宽为「AM 可转交」是否影响已有测试。
7. 现有就绪性派生能否表达「有效批准」这种非任务依赖（发布 Task 的 WAITING_AUTHORIZATION），还是需要新增 blocker 类型。

## 附录 A：`seo_ops.gbp_post_request.v1`

```json
{
  "schema_version": "seo_ops.gbp_post_request.v1",
  "seo_ops_task_id": "…", "task_version": 3, "attempt": 1,
  "market": {"country_code": "US", "language": "en-US", "search_engine": "GOOGLE"},
  "merchant": {"id": "…", "display_name": "…", "facts": {"address": "…", "phone": "…", "hours": {...}, "service_options": ["DINE_IN","TAKEOUT"]}},
  "location": {"id": "…", "display_name": "…", "timezone": "America/New_York",
               "external_identities": {"fbr_merchant_id": "…", "fbr_location_id": "…", "google_location": "accounts/…/locations/…", "google_place": "ChIJ…"}},
  "occurrence_at": "2026-09-12T11:00:00-04:00",
  "post_type": "STANDARD",
  "topic": "brunch",
  "reviewer_feedback": null,
  "voice_profile": {"version_ref": "<id>:v1", "tone": [...], "post_structure": [...], "avoid": [...], "image_policy": {...}, "source_note": "…"},
  "calendar_context": [{"id": "holiday:2026-09-07:labor-day", "kind": "HOLIDAY", "title": "Labor Day", "starts_on": "2026-09-07", "ends_on": "2026-09-07"},
                       {"id": "promo:42", "kind": "OFFER", "title": "Weekday Brunch Set", "starts_on": "2026-09-01", "ends_on": "2026-09-30", "terms": "…", "source_note": "商户提供"}],
  "primary_keyword_cluster": {"cluster_id": "…", "search_intent": "…", "keywords": ["hakka", "chinese", "brunch"]},
  "evidence_references": ["keyword-set:…", "gbp-location-readback:…", "voice-profile:…:v1", "promo:42"],
  "photo_candidates": [{"id": "photo:17", "url": "https://…googleusercontent…", "alt": "…", "source": "FBR_MENU", "authorized": true}],
  "cta_targets": {"website": "https://…", "order": null, "book": null},
  "business_input_fingerprint": "sha256:…"
}
```

## 附录 B：`seo_ops.gbp_post_draft.v2`（沿用 Core AI 上 v4 Agent 的 schema，加 `media.selected_candidate_id` 与 `outcome`）

必填：`schema_version`、`outcome ∈ ready|needs_input`、`merchant_id`、`location_id`、`occurrence_at`、`market`、`post_type`、`voice_profile_version`、`primary_keyword_cluster`、`evidence_references`、`copy`（≤1500）、`cta_type ∈ NONE|BOOK|ORDER|SHOP|LEARN_MORE|SIGN_UP|CALL`、`cta_url`（非 NONE/CALL 时必须是输入里给过的 https URL）、`media`（`{selected_candidate_id}` 或 `{brief: {concept, image_prompt, alt_text, expected_attachment_count: 1}}` 二选一）、`limitations[]`、`missing_inputs[]`（仅 needs_input）。禁止任何未列出的键。

## 附录 C：文案与红线原句

- 首页审核卡主按钮：「审阅草稿」；预览角标：「完整内容在审阅页」。
- 批准对话框：「批准后发布 Agent 会把帖子 v{N} 写入 Google 门店 {门店}。发布后不能退回草稿，修改或撤下需要新建补偿任务。确认？」
- 退回说明框提示：「退回后内容 Agent 会按你的说明重新准备一版（v{N+1}），当前版本保留只读。」
- 依赖解除行：「本版不含价格。价格确认任务 {T} 已解除对本版的阻塞；含价格的更新帖会另建工作单。」
- 发布结果未知卡：「上次发布结果未知，需要你核验」/「发布 Agent 收到超时，未取得 post_id。系统已读回门店帖子列表，未找到精确匹配。」/「不会自动重发」。
- NEEDS_ATTENTION 横幅（多匹配）：「Google 上读到 {N} 条内容完全一致的帖子，无法确定哪一条是本次发布。」
- 风格档案缺失：「该商户尚未填写风格档案，内容 Agent 无法开始。」
- 人工任务次操作说明：「受阻和协助请求会交给 Orchestrator 接续处理，不会关闭任务。」
- 补救提示：「补救请新建补偿任务，本工作单不可修改。」


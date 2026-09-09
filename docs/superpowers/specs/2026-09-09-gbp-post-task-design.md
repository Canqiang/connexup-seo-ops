# GBP Post 任务设计（第一个外部写闭环）

日期：2026-09-09
状态：待用户审阅（UI 原型已由 OpenDesign 生成并归档，待定稿：`docs/evidence/2026-09-09-gbp-post-ui/`）
取代：`2026-09-03-gbp-post-execution-phase-3.md` 里「发布 Agent + 验证 Agent + 托管策略」的实施假设；沿用 `2026-09-02-agent-generated-task-dependencies-design.md` 的状态机、ApprovalGrant 与「只有读回才算 DONE」原则。

## 1. 目标

让一个 `GBP_POST` 任务从「诊断 Plan 或操作员提出」走到「Google Business Profile 上真的出现这篇帖子」，全程满足三条红线：

1. 任何外部写入必须经操作员显式批准，且批准精确绑定要发布的那一版内容与图片。
2. 发布动作由能力受限的 Agent 执行，SEO Ops 只触发一次，任何不确定结果都不重发。
3. 只有服务端从 FBR 读回、与批准内容精确匹配、状态 LIVE，任务才 DONE。

## 2. 已拍板的决定（2026-09-09 讨论）

**总原则：Agent 驱动；AM（人）是执行者类型之一。** 任何阶段的执行者都建模为 `assignee(AGENT|HUMAN)`，共用同一条 attempt、授权、读回核对链路；不为「人工」单独造旁路。

| 问题 | 决定 |
|---|---|
| 谁生成内容 | PREPARATION 阶段执行者默认是内容 Agent（Core AI），输入由 SEO Ops 服务端组装；执行者模型允许 HUMAN，但第一版不开放人工写稿 |
| 操作员能否改内容 | 不能，只能批准或退回重新准备 |
| 图片来源 | Agent 决定：候选图库有真实照片就选，没有才生成一次；操作员不按任务选图 |
| 谁发布 | PUBLICATION 阶段的执行者：默认绑定的发布 Agent（Core AI，只挂 `createLocationPost`），AM 可在批准时选择「由我发布」作为 HUMAN 执行者 |
| 怎么验收 | 服务端读 FBR 帖子列表，正文 + CTA 精确匹配、唯一、LIVE 才 DONE |
| 任务来源 | 诊断 Plan 提出 + 商户页手建，一任务一篇，不做排期日历 |
| 本地活动与节日 | 服务端算节假日 + 操作员录入活动优惠；第一版不让 Agent 上网 |
| Agent 配置归属 | Skill 与 Agent 配置文件放本仓库，导入 Core AI 新建，不改仓库外代码 |

## 3. 范围

做：
- `GBP_POST` Workflow Template 与参数 schema；Plan 校验与商户页手建入口。
- 商户风格档案、商户图库（含首个文件上传接口）、本期活动与优惠三个新数据对象及其页面。
- 内容 Agent 的 Skill 包与 Agent 配置（本仓库）、发布 Agent 的 Skill 包与 Agent 配置（本仓库）、导入与绑定记录。
- 服务端：请求组装、准备 attempt、artifact 落库与图片下载、审批授权、`audit_id` 解析、发布 attempt、trace 核实、FBR 读回核对与退避。
- 任务页 GBP_POST 变体、商户页与资料页新增区块、任务总览类型筛选。

不做（第一版）：
- OFFER / EVENT 类型帖子；排期日历；自动化托管策略；Agent 上网找活动；图片参与验收；补偿任务的自动化（补救一律新建任务）；改 Core AI 或 FBR 代码。

## 4. 角色与数据流

```
Plan / 操作员 ──创建──▶ Task(GBP_POST, PENDING)
   │
   ▼ 服务端组装 seo_ops.gbp_post_request.v1（事实 + 风格档案 + 日历 + 关键词 + 候选图）
内容 Agent(Core AI) ──▶ seo_ops.gbp_post_draft.v2 + 图片 artifact ──▶ 服务端下载图片、落 artifact ──▶ AWAITING_APPROVAL
   │
   ▼ 操作员批准（HUMAN grant 绑 artifact checksum + 图片 sha256）
服务端解析 audit_id ──▶ PUBLICATION attempt ──▶ 发布 Agent(Core AI, 只有 createLocationPost) ──▶ post_id ──▶ VERIFYING
   │
   ▼ 服务端读 FBR /gbp/location/:id/post
精确匹配 + LIVE ──▶ DONE ；其他 ──▶ NEEDS_ATTENTION（可重新核对）
```

三个执行角色的能力边界：

| 角色 | 运行位置 | 能力 | 禁止 |
|---|---|---|---|
| 内容 Agent | Core AI | `builtin-media-generation`（生图一次） | 任何写 GBP、上网、文件、子 Agent |
| 发布 Agent | Core AI | `api-operation:operation-assistant-api:GBPOperationWebService:createLocationPost` | 改内容、改目标、任何读或第二次写 |
| 核对 | SEO Ops 服务端 | FBR 只读 | 无 |
| AM 作为发布执行者（HUMAN） | 操作员 | 按发布清单在 GBP 后台发布，声明「我已发布」 | 改内容、改目标；DONE 仍只由服务端读回决定 |

## 5. 任务模型

### 5.1 模板

```
GBP_POST v1
PENDING → PREPARING → AWAITING_APPROVAL → EXECUTING → VERIFYING → DONE
非终态 → NEEDS_ATTENTION；NEEDS_ATTENTION → PENDING（仅当证明未发生外部写）| CANCELLED
AWAITING_APPROVAL → PENDING（退回）
terminal_after_approval = False；operation = CREATE_GBP_POST
```

UI 标签：EXECUTING「发布中」，VERIFYING「核对中」，NEEDS_ATTENTION「需要处理」。

取消：PENDING、AWAITING_APPROVAL 可取消；PREPARING 需确认无活跃 attempt；EXECUTING / VERIFYING 不可取消，必须先对账；DONE 不可取消。

### 5.2 参数

```json
{ "location_id": "<商户已绑定的 GBP location resource id>", "topic": "<1–500 字>" }
```
Plan 校验：`location_id` 必须存在于该商户 `merchant_gbp_profiles` 的门店列表；`topic` 非空。第一版 `post_type` 固定 STANDARD，不入参数。

### 5.3 来源

- 诊断 Plan：Agent 在 `seo_ops.task_plan.v1` 里提出 `task_type: "GBP_POST"`，走现有 Plan 审批物化。
- 商户页手建：新建任务表单加类型选择与门店下拉；服务端包装为隐式 OPERATOR Plan（现有机制）。

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

风格档案缺失 → 任务在 PENDING 被阻断（blocker `VOICE_PROFILE_MISSING`），UI 提示去填写；不用默认档案。

## 8. 准备阶段

- 沿用 `task_agent_preparation.start_agent_preparation` 的一次性 trigger、attempt、dispatch_token；按模板分发请求构造器与结果解析器（`gbp_post_contract.py`）。
- 轮询到 COMPLETED：严格解析 draft；`outcome == "needs_input"` → attempt FAILED，任务 NEEDS_ATTENTION 并展示缺失项。
- 图片：`media.selected_candidate_id` 必须在本次候选里；否则 run 的 `artifacts[]` 必须恰好一张 image/png|jpeg，立即下载到 `data/task-media/<task_id>/<attempt>/<sha256>.<ext>`，记录 sha256、字节数、content_type、`source=AI_GENERATED`、原始 `download_url`（仅审计）。下载失败 → attempt FAILED，可重新准备。
- 落库 `task_artifacts`（新表）：规范化 artifact JSON、checksum、`media_id`；任务 → AWAITING_APPROVAL。

## 9. 审批与发布

- 批准：现有 `approve-execution` 扩展为写 `task_approvals`（新表）：task version、execution id、artifact checksum、media sha256、operator、时间、`grant_type=HUMAN`。任务 → EXECUTING。退回：原因必填，任务 → PENDING，artifact 保留。
- `audit_id` 解析（发布前，服务端）：`PUT /seo/audit` searchAudits 按 `merchant_id + place_id` 取最新；没有 → 任务 NEEDS_ATTENTION（blocker `FBR_AUDIT_MISSING`），提示先在 FBR 建立审计。不自动 saveAudit。
- 图片公网 URL：`MERCHANT_PHOTO` 用其 Google URL；`AI_GENERATED` / `OPERATOR_UPLOAD` 先用现有 FBR `upload-media` 把图片上传为门店照片得到 Google URL，再用于帖子（避免依赖 Core AI 公开链接的有效期）。这一步也是写，纳入同一次批准的授权范围，并在 attempt 里记录 media key。
- 执行者选择：批准时 AM 选择本次 PUBLICATION 的执行者，默认是绑定的发布 Agent，也可以选「由我发布」。两种执行者创建同一种 PUBLICATION attempt（`executor_type ∈ AGENT|HUMAN` 记录在 attempt 上）。
- AGENT 执行：先落库 request JSON 与 checksum、idempotency key，再 trigger 发布 Agent 一次。
- HUMAN 执行：attempt 落库后任务进 EXECUTING，页面给发布清单（正文复制、图片下载、CTA、目标门店、audit_id）；AM 点「我已发布，去核对」即写入声明并进入 VERIFYING。声明不是完成，核对规则与 AGENT 完全相同。
- 结果处理：COMPLETED 且 trace 里 `createLocationPost` 恰好一次且返回 `post_id` → 记 `provider_resource_id`，任务 → VERIFYING。trace 显示零次调用且 run 失败 → 可重新发布（同幂等身份，限 2 次）。其他任何情况（超时、多次调用、无 post_id、响应丢失）→ 直接 VERIFYING 以读回为准，绝不重发。

## 10. 核对

- 读 `GET /gbp/location/:id/post?limit=20`。规范化：换行统一 `\n`，仅去首尾空白，不改内部空格与 URL。
- 匹配：`summary` 相同且 `call_to_action.action_type` 相同且（非 CALL 时）`url` 相同。有 `provider_resource_id` 时先按 `post_id` 精确取。
- 结果：唯一匹配且 `state == LIVE` → DONE，`evidence_json` 记读回快照与匹配依据；`PROCESSING` / `SCHEDULED` → 保持 VERIFYING，按 1、5、15、60、60、60 分钟退避自动重读；无匹配 / 多匹配 / `REJECTED` / 重读用尽 → NEEDS_ATTENTION 附读回列表。
- 「重新核对」按钮：创建新的 VERIFICATION attempt，只读，无次数限制。
- 进程重启：从持久 attempt 恢复，只做读回，绝不重新 create。

## 11. 数据模型变更

新表：`task_artifacts`（task_id, execution_id, schema_version, artifact_json, checksum, media_id, created_at）、`task_media`（id, task_id, source ∈ AI_GENERATED|MERCHANT_PHOTO|OPERATOR_UPLOAD, local_path, public_url, sha256, bytes, content_type, alt_text, created_at）、`task_approvals`（grant 字段见 §9）、`merchant_voice_profiles`（merchant_id, version, tone_json, structure_json, avoid_json, image_policy_json, note, created_by, created_at）、`merchant_promotions`（merchant_id, kind ∈ EVENT|OFFER, title, starts_on, ends_on, terms, source_note, created_by, created_at）、`merchant_photos`（merchant_id, source ∈ FBR_MENU|FBR_POST|OPERATOR_UPLOAD, url, local_path, alt_text, authorized, sha256, created_at）。

`task_executions` 现有列已够用（stage、approval_id、artifact_id、provider_resource_id、evidence_json）。迁移按现有有序迁移与 fail-closed 契约校验方式加。

## 12. API 变更

- `POST /api/merchants/{id}/tasks` 接受 `task_type=GBP_POST` + `parameters`。
- `GET /api/merchants/{id}/profile` 增加 `voice_profile`、`photos`；新增 `PUT …/voice-profile`（新版本）、`POST …/photos`（multipart 上传，jpg/png ≤ 8 MiB）、`PATCH …/photos/{id}`（alt、authorized）、`GET/POST/DELETE …/promotions`。
- `GET /api/tasks/{id}` 与 `/execution` 返回 artifact、media（本地预览 URL）、approval、publication 与 verification attempts、读回列表。
- 新增 `POST /api/tasks/{id}/verify`（重新核对）。
- 所有 GBP_POST 入口受 `SEO_OPS_GBP_POST_ENABLED` 与两个 Agent 绑定校验共同门控。

## 13. UI

任务页 GBP_POST 变体按阶段切换帖子卡（PREPARING 骨架屏与输入清单 / 阻断提示；AWAITING_APPROVAL 完整帖子卡 + 依据 + 批准并发布（ConfirmDialog）与退回；EXECUTING 只读加锁 + status（AGENT 执行者显示 attempt 进度；HUMAN 执行者显示发布清单和「我已发布，去核对」）；VERIFYING 倒计时 + 立即重新核对；DONE 已上线戳记 + post_id + search_url；NEEDS_ATTENTION 顶部横幅 + 左批准卡右读回列表）。rail 增加「发布身份」卡。商户页新增类型选择与门店下拉、「本期活动与优惠」；资料页新增「风格档案」「图库」卡；任务总览加类型筛选。全部复用 `components/feedback`。视觉以 OpenDesign 原型定稿为准（`docs/evidence/2026-09-09-gbp-post-ui/`）。

## 14. 待验证（写实施计划前各做一次）

1. Core AI Skill 上传接口路径与请求格式。
2. FBR `upload-media` 用 Core AI artifact 链接能否成功取图；若不能，改为 SEO Ops 先下载再以自身可公网访问的地址上传，或由发布 Agent 用 base64。
3. FBR `searchAudits` 是否返回可用 `audit_id`，`createLocationPost` 是否校验其存在。
4. FBR 帖子列表新帖出现的延迟与 `PROCESSING` 时长。
5. 发布 Agent 在 `max_turns=2` 下能否稳定完成一次调用并返回结构化结果。

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

- 批准对话框：「发布 Agent 会把这一版内容和图片写入 Google 门店 {门店}。发布后不能撤回，只能新建补偿任务修改。确认发布？」
- NEEDS_ATTENTION 横幅（多匹配）：「Google 上读到 {N} 条内容完全一致的帖子，无法确定哪一条是本次发布。」
- 风格档案缺失：「该商户尚未填写风格档案，内容 Agent 无法开始。」
- 补救提示：「补救请新建补偿任务，本任务不可修改。」

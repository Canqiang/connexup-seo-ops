# SEO Ops 执行 Agent 与自动周期设计(flow v4)

日期:2026-08-20(rev 2,按 P0 评审修订)
状态:已修订,待复审
事实依据:Obsidian vault `~/Documents/vault/chancetop`(引用见文末)

## 0. 版本与废止声明

本设计**废止** `2026-08-17-seo-ops-control-plane-core-ai-uat-design.md` 中一切"Core AI 作为 SEO Ops 后端 / 系统真源 / 服务 `/api/seo-ops`"的内容。自本版起:

- **所有前端、后端、数据库、Dispatcher、Worker、Scheduler 都在 `connexup-seo-ops` 仓库内。**
- Core AI 只作为能力提供方,**只通过其现有 API 调用**(触发 Agent Run、轮询状态、下载 Artifact、取消)。
- **禁止**新增或修改 Core AI 的 Endpoint、权限、Migration、登录、Agent Runtime 代码。实施计划中不得出现任何对 `core-ai` 仓库的改动项。
- 旧设计中与上述冲突的章节全部失效;其 UAT 发布机制(镜像 digest、ingress、回滚)仍可参考。

## 1. 目标与背景

给代运营人员(Connexup DRI / Local SEO 负责人)一套端到端控制面板:

- **新店**:生成问卷(基于店名/官网)→ 商家填写 → 生成关键词 → GBP + on-page 双审计 → local/organic ranking 基线 → 优化 Plan → 任务落库 → 执行 agent 从任务队列执行。
- **老店**:定期 audit + keyword ranking 自动跑,基于结果自动生成调整 Plan 与候选任务(如把关键词埋进 GBP post);**一切外部写入保留人类关口**。

### 已确认的产品决策

| 决策点 | 结论 |
| --- | --- |
| 执行边界 | 混合:GBP 类动作 agent 真实写入;官网/站内类 agent 产成品,人应用 |
| 审批门 | 分级:产成品任务免审即执行;写入任务必须审批 |
| **审批与执行双门** | 审批(APPROVED)与执行确认(EXECUTION_CONFIRMED)是两个独立人工动作,缺一不可 |
| 老店周期 | 自动闭环止于内部产物:自动分析、自动 Plan、自动候选任务;写入过双门 |
| Plan 确认 | 新店保留人工勾选确认;老店自动生成候选任务 |
| 鉴权 | 必须有(见 §4),不再豁免 |
| 结果定性 | 未知结果绝不自动记失败或自动记完成(见 §6.4/§6.5) |

## 2. 系统边界

```
connexup-seo-ops(本仓库,唯一实施对象)
├── web(React 前端)
├── server
│   ├── api        —— HTTP API + 事务写入(Task/Attempt/Outbox)
│   ├── worker     —— 执行 Worker(lease 认领 Outbox → 调 Core AI → 回写)
│   └── scheduler  —— 周期调度(老店自动分析/Plan/候选任务、核验超时扫描)
└── PostgreSQL(自有数据库)

Core AI(只读依赖):POST trigger-run / GET run / GET artifact / POST cancel —— 现有 API,原样使用
operation-assistant(间接依赖):由执行 agent 的 seo-gbp-execution skill 调用,本系统不直连
```

## 3. 来自 vault 的硬约束

1. **写入通道已存在**:`seo-gbp-execution` skill → operation-assistant DEV API,支持 15 个操作(改 location 单字段/单属性、传一张图、改一个菜品、发/改 GBP post、Place Action Link 增删改)。没有"改服务区域",不能删整篇 post。
2. **单写入原则**:一次调用最多一个逻辑写入 → 写入任务必须拆到单写入粒度。
3. **执行 skill 不生成内容**:CREATE_POST 等字段必须由调用方完整给定 → 内容起草在上游完成,执行指令带完整终值。
4. **写入失败不自动重试、写后不自动复查**;API SUCCESS ≠ Google 已展示。
5. **调用即授权**(skill 内不再确认)→ 授权门与执行门必须由本控制面承担。
6. **三态分离**:技术已连接 / 商户已授权该资产 / 本次变更已审批。现状:UWS 有 GBP 写入且已实际执行;Only Bear 仅官网(WordPress)授权;可可小卤均未授权。
7. **审批绑定内容版本**:批准一个明确版本(checksum),批准后只执行该版本。
8. **任务状态语义对齐 FBR-7060**(operation-assistant tasks collection):本期不做双写同步,只对齐语义。

## 4. 鉴权与身份(最低集)

- SEO Ops **自有登录 + 服务端 Session**(用户表落本库;密码散列存储;Session Cookie HttpOnly)。
- 权限点:`seoops.view`、`seoops.manage`、`seoops.approve`、`seoops.execute`、`seoops.capability.manage`、`seoops.schedule.manage`。审批与执行确认可以是同一人,但都必须持对应权限。
- **商户/地点访问范围**:用户绑定可见商户集合(operator_user_ids 已有雏形),范围外不可见不可操作。
- **身份审计**:审批决定、执行确认、成品应用、授权矩阵修改、自动周期开关,全部记录真实 user_id + 时间,不可用 `local-dev` 占位。
- **Core AI Token 只存在于后端 Secret**(env/K8s Secret),前端与日志永不接触。
- Copilot/Chat、Scheduler、Agent 的服务身份**没有** `approve`/`execute`/`capability.manage` 权限(见 §13 红线)。

## 5. 数据模型(PostgreSQL)

数据库从 SQLite 迁到 **PostgreSQL**(多进程/多副本 + 事务性 Outbox 的前提)。

核心表(在现有 schema 基础上演进):

- `seo_tasks` —— **只承担业务状态**(见 §6.1),不承担队列与运行历史。新增列:`execution_mode`、`requested_mode`、`task_type`(细化枚举)、`verify_deadline_at`。
- `seo_execution_attempts` —— **每次执行尝试一行**:`id, task_id, task_revision, spec_hash, attempt_no, mode(AUTO_WRITE|ARTIFACT|DEGRADED_ARTIFACT), status(见 §6.2), agent_run_id, receipt(jsonb), error, confirmed_by, confirmed_at, lease_owner, lease_expires_at, created_at, finished_at`。
- `seo_outbox` —— 事务性发件箱:`id, attempt_id, kind, payload(jsonb), status(PENDING|CLAIMED|DONE|DEAD), claimed_by, lease_expires_at, retry_count, created_at`。
- `seo_merchant_capabilities` —— 资产级授权(见 §9)。
- `seo_auto_cycle_configs` —— 商户级周期配置 + 开启审计(见 §10)。
- `seo_users` / `seo_sessions` —— 鉴权(§4)。
- 现有 merchants/locations/questionnaires/agent_runs/deliverables 表结构平移。

**迁移策略**:schema 层已抽象(`db/schema.ts`/`migrate.ts`),迁移分三步——① 引入 pg 驱动与连接配置,SQL 方言改写(better-sqlite3 → pg,同步 API 改 async);② 迁移脚本把现有 SQLite 数据导入 PG(开发数据量小,一次性脚本);③ 本地开发默认连本机 PG(docker compose 提供),不再支持 SQLite。UAT 用托管/集群内 PostgreSQL 实例。

## 6. 任务模型与状态机

### 6.1 Task(业务状态)

- `execution_mode`:`AUTO_WRITE` | `ARTIFACT`,创建时由 task_type 映射定型。`requested_mode` 永久保留原始意图;降级不改写它(见 §6.6)。
- 写入类 task_type(与 seo-gbp-execution 操作一一对应):`GBP_POST_CREATE`、`GBP_POST_UPDATE`、`GBP_LOCATION_FIELD`、`GBP_ATTRIBUTE`、`GBP_MEDIA_UPLOAD`、`GBP_MENU_ITEM`、`GBP_PLACE_ACTION_LINK`。产成品类:`WEBSITE_PAGE`、`WEBSITE_SCHEMA`、`CONTENT_DRAFT` 等。
- `execution_spec`(结构化 JSON,过 Zod 校验,见 §12)带完整终值;`executionSpecHash` 即批准与执行确认绑定的 checksum。

```
ARTIFACT:   创建 → QUEUED → EXECUTING → AWAITING_APPLY → COMPLETED
                 (免审入队)              (成品就绪)     (记录应用人/时间/成品Hash/证据)

AUTO_WRITE: 创建 → READY_FOR_APPROVAL → APPROVED → EXECUTION_CONFIRMED → QUEUED → EXECUTING
                    (待授权)   (审批门,门1)      (执行门,门2,独立人工动作)
            EXECUTING → PENDING_VERIFY → VERIFIED → COMPLETED
                        (回执+证据已回填) (真实读回/人工核验)
            EXECUTING → EXECUTION_FAILED        (确认未发生写入,可人工重新走门2)
            EXECUTING → OUTCOME_UNKNOWN → RECONCILIATION_REQUIRED(见 §6.4)
            PENDING_VERIFY 超时 → VERIFICATION_OVERDUE(见 §6.5)

(execution_spec 不完整的写入任务先落 NEEDS_INPUT,草拟运行补全后进 READY_FOR_APPROVAL;
 Plan 转出的任务自带完整终值,直接 READY_FOR_APPROVAL)
取消:QUEUED / READY_FOR_APPROVAL / APPROVED / EXECUTION_FAILED → CANCELLED
```

### 6.2 Execution Attempt(运行状态,独立表)

`PENDING(outbox 已建) → CLAIMED → RUNNING → SUCCEEDED | FAILED_CONFIRMED | OUTCOME_UNKNOWN | CANCELLED`

Task 状态由 attempt 终态驱动;历史尝试全部保留可查。

### 6.3 双门(P0)

- **门 1 审批**:`READY_FOR_APPROVAL → APPROVED`,持 `seoops.approve` 的人对当前 revision+hash 批准。内容修订即失效(现有 revision 机制)。
- **门 2 执行确认**:`APPROVED → EXECUTION_CONFIRMED`,持 `seoops.execute` 的人显式点击,服务端在**同一事务**内再次校验:
  1. 当前 task_revision 与 spec_hash 与审批记录一致;
  2. 审批仍有效(未撤销、未过期);
  3. 资产授权仍有效(§9);
  4. locationName 与外部资产身份匹配(capability 表中的外部资产 ID 与 execution_spec 一致);
  5. 同一业务指令(task_id+revision)没有 PENDING/CLAIMED/RUNNING/OUTCOME_UNKNOWN 的尝试。
  校验全过才创建 attempt + outbox(同事务)。**Chat、Scheduler、Agent 都不能代替此动作**。

### 6.4 未知结果(P0)

超时、回执缺失、回执解析失败、Core AI 状态不明——一律 **`OUTCOME_UNKNOWN`**,任务落 **`RECONCILIATION_REQUIRED`**:

- **禁止任何重试**(按钮禁用 + 服务端拒绝),直到人工对账:公开读回(LIST_POSTS/GET_LOCATION)、operation-assistant 日志(log_id)、Core AI Trace 三选一确认写入是否发生;
- 对账结论二选一:已发生 → 人工补录回执转 PENDING_VERIFY;未发生 → 转 EXECUTION_FAILED(此后才可重新走门 2)。
- `EXECUTION_FAILED` 仅代表**确认未发生写入**的失败。

### 6.5 核验(P0)

- `PENDING_VERIFY → VERIFIED` 只能由三种来源产生:公开读回一致(独立读操作)、人工核验(记录 user_id)、可信第三方测量。**没有自动完成。**
- 超过 `verify_deadline_at`(默认 7 天)→ `VERIFICATION_OVERDUE`,**进入首页异常清单**,直到核验完成。
- 「已发布」(有 postId 回执)与「已验证」(VERIFIED)始终分开呈现。

### 6.6 尝试与幂等语义(P0)

- 每次执行 = 一行 attempt,`attempt_no` 单调递增;幂等键 = `exec-{taskId}-rev{revision}-attempt{attemptNo}`,绑定业务指令。
- **AUTO_WRITE**:新 attempt 只能从 EXECUTION_FAILED(确认未写入)经门 2 产生;OUTCOME_UNKNOWN 期间禁产生。无自动重试。
- **ARTIFACT**:失败可自动重试(新 attempt,上限 2,指数退避)——无外部副作用。
- **降级不静默**:AUTO_WRITE 任务缺资产授权时,不改任务模式;操作员可显式选择「按成品执行」,产生 `mode=DEGRADED_ARTIFACT` 的 attempt(免门 2,因无外部写入),任务 UI 始终显示 `requested_mode=AUTO_WRITE` + 降级标识。

### 6.7 成品应用(P0)

`AWAITING_APPLY → COMPLETED` 必须提交:应用人(session 身份)、应用时间、所应用成品的 sha256、应用证据(URL 或截图,append 到 evidence)。只点按钮不带证据不放行。

## 7. 执行链路与可靠性

1. **API(门 2)**:PostgreSQL 事务内写 attempt(PENDING)+ outbox(PENDING)+ task→QUEUED。事务失败则全部回滚,不存在"确认了但没入队"。
2. **Worker(独立进程)**:`SELECT ... FOR UPDATE SKIP LOCKED` + lease(`claimed_by, lease_expires_at`)认领 outbox;认领后触发 Core AI Agent Run(幂等键见 §6.6),轮询至终态,下载 Artifact,校验回执(§12),事务内回写 attempt 终态 + task 状态 + evidence。
3. **崩溃/重启安全**:lease 过期后条目可被其他副本接管;接管者先查 Core AI 侧是否已有该幂等键的 run——有则续接轮询,**绝不重复触发**;查不到且无法确认 → OUTCOME_UNKNOWN(宁可人工对账,不可能重复写入)。
4. **多副本安全**:SKIP LOCKED + lease 保证一条 outbox 同时只有一个 owner;门 2 的"无在途尝试"校验保证一条业务指令同时只有一个 attempt。
5. **并发上限**:每商户在途 1、全局在途 2(可配),worker 认领时检查。
6. **Dead Letter**:outbox `retry_count` 超限(基础设施性失败,如 Core AI 不可达)→ `DEAD`,进监控告警与首页异常,人工处置。
7. **暂停/恢复**:全局与商户级 pause 开关(库表配置),worker/scheduler 每轮读取;暂停只停新认领,不中断在途。

## 8. 进程拓扑

同一仓库、同一镜像,**三个独立进程/Pod**(启动参数区分角色):

| 进程 | 职责 | 副本 |
| --- | --- | --- |
| `api` | HTTP API、事务写入、鉴权 | ≥1 |
| `worker` | Outbox 认领、Core AI 调用、回写 | ≥1(可横向扩) |
| `scheduler` | 老店周期、核验超时扫描、7 天线、lease 清理 | 1(leader 即副本数 1) |

本地开发:`npm run dev` 以单进程同时挂三个角色(仅 dev flag),行为与生产一致(同走 outbox)。

## 9. 资产授权矩阵(一等对象,资产级)

`seo_merchant_capabilities`:

```
id, merchant_id, location_id, capability(GBP_WRITE|WEBSITE_CMS|MENU_PLATFORM),
external_asset_id      -- 如 gbpLocationId / CMS 站点标识
scope                  -- 授权范围说明(如"仅 posts 与菜单")
credential_ref         -- 后端 Secret 引用名,绝不存凭证本体
connected(bool), authorized(bool),
authorized_by, authorized_at, evidence_ref,   -- 授权人/时间/授权证据(截图或文件)
expires_at, revoked_at, revoked_by, note
```

- 修改需 `seoops.capability.manage`,全量留痕(不可物理删除,撤销=revoked 记录)。
- 门 2 校验与 worker 派发都以此表为准;`expires_at` 过期视同未授权。
- 初始数据:UWS GBP_WRITE connected+authorized;Only Bear WEBSITE_CMS authorized、GBP_WRITE 未授权;可可小卤全未授权。

## 10. 老店自动周期(scheduler)

- **显式开启**:自动周期默认关闭;持 `seoops.schedule.manage` 的人在商户页开启,记录 `enabled_by, enabled_at, config_version`;修改配置同样留痕。
- **周期配置**(商户级,默认取运营文档):local ranking 7 天、audit 30 天、performance 30 天、GBP Post 每周 1 条(月≥4)、技术审计 90 天。
- **只读环节自动跑**:到期且无活跃同阶段运行 → 自动触发,`triggeredBy=scheduler`。
- **结果驱动调整**:新 audit + ranking 齐备后自动触发调整 Plan → 完成即自动解析(结构化 JSON,§12)生成**候选任务**:ARTIFACT 即刻入队;AUTO_WRITE 停在 READY_FOR_APPROVAL——**scheduler 无权过任何一道门**。
- **GBP Post 周任务**:每周创建 `GBP_POST_CREATE` 任务(NEEDS_INPUT)→ 草拟运行(P3 场景词,`gbp_posts` ≤1500 字符,已授权素材)填充 execution_spec → READY_FOR_APPROVAL → 人过双门 → 执行。
- **护栏**:每商户每日自动运行上限(默认 6);ranking 运行计数(Local Falcon credits 成本可见);暂停开关;自动触发失败不重试,报异常。
- 新店(未完成首轮)不参与自动周期。

## 11. 前端 IA(代运营视角)

- **首页异常清单**:等待商家 / Plan 待确认(新店) / 待授权写入 / **待执行确认** / 成品待应用 / **核验超时** / **待对账(OUTCOME_UNKNOWN)** / 执行失败 / 周期内无待办。轮次徽标、对比条、快照表保留。
- **商户页**:阶段轨保留;EXECUTE 阶段卡=执行队列卡(各状态计数 + 行内主按钮:审批 / **确认执行** / 查看成品并提交应用证据 / 对账 / 处理失败);资产授权矩阵卡(资产级三态 + 有效期);老店周期状态行(下次自动运行时间、开启人、暂停开关)。
- **任务页**:AUTO_WRITE 显示 requested_mode、批准与执行确认双记录(人+时间+hash)、attempt 历史、回执(postId/log_id)、before/after、「已发布≠已验证」双徽标;ARTIFACT 显示成品阅读区 + 复制 + 应用证据表单。审批文案:「批准 = 授权此写入内容(绑定当前版本)」;执行确认文案:「确认执行 = 立即由 agent 对 GBP 发起此写入」。

## 12. 结构化契约(禁 Markdown 解析)

执行链路上的三类数据全部定义 JSON Schema 并以 Zod 校验,校验失败即拒绝(不进入下一环节):

1. **Plan 产物**:Plan/REVIEW 运行必须产出结构化 JSON artifact(条目:task_type、优先级、locationName、目标字段、完整终值、依据引用)。前端 `parsePlanItems` 的 Markdown 解析仅保留给旧数据展示,**不再作为转任务依据**。
2. **执行指令**(execution_spec):按 task_type 分 schema(如 CREATE_POST 必填 summary/topic_type/CTA/媒体)。
3. **执行回执**(receipt):operation、location_id、postId/log_id/media_key、status;解析或校验失败 → OUTCOME_UNKNOWN(§6.4)。

## 13. 红线对照

| 红线 | 落点 |
| --- | --- |
| 不修改 Core AI | §0 废止声明;实施计划无 core-ai 改动项 |
| Plan 拆单写入、完整终值 | §6.1 + §12 |
| 可验证人工授权;内容变更即失效 | §6.3 门 1 |
| **审批≠执行**,执行是独立人工动作 | §6.3 门 2(五项事务内校验) |
| read-only 不触发写入 | 只读 SOP 与执行 agent 分 id;scheduler 只产候选 |
| 失败/超时/不确定如实返回 | §6.4 OUTCOME_UNKNOWN / RECONCILIATION_REQUIRED |
| CREATE/UPLOAD 不自动盲重试 | §6.6;对账前禁重试 |
| 写入回执 + Trace 关联计划项 | attempt.receipt + evidence 链 |
| 写后复查独立;SUCCESS≠已展示 | §6.5 VERIFIED 三来源;VERIFICATION_OVERDUE 进异常清单 |
| 幂等键绑业务指令 | §6.6 |
| 权限是 capability 不是数据流 | §9 资产级授权矩阵 |
| Agent 草稿 ≠ 已上线 | AWAITING_APPLY / PENDING_VERIFY / VERIFIED 分离 |
| **Copilot/Chat 禁执行** | Chat/Copilot 服务身份无 approve/execute/capability.manage/requeue 权限,对应 API 拒绝;前端 Copilot 面板不渲染这些动作 |

## 14. 运维与部署(UAT)

- 拓扑:`api` / `worker` / `scheduler` 三 Deployment(同镜像不同 args)+ PostgreSQL(集群内实例或托管)+ 前端静态 Deployment(沿用现有 ingress 结构)。
- Secret:Core AI Token、PG 连接串、Session 密钥,全部 K8s Secret,不入镜像不入日志。
- 监控最低集:outbox 深度与 DEAD 数、OUTCOME_UNKNOWN 数、VERIFICATION_OVERDUE 数、scheduler 心跳、worker lease 过期数;超阈值告警。
- 暂停/恢复:全局与商户级开关(§7.7);发布顺序:PG 迁移 → api → worker/scheduler → 前端;回滚按镜像 digest。

## 15. 测试策略(全程 TDD)

- **状态机**:两 mode 全部合法/非法转换;双门顺序与越权拒绝;revision 使门 1 失效;OUTCOME_UNKNOWN 禁重试;VERIFIED 三来源;VERIFICATION_OVERDUE 触发;降级 attempt 不改 requested_mode;应用证据缺失不放行。
- **门 2 事务校验**:五项校验各自失败路径;并发确认只成功一次(事务+唯一在途约束)。
- **Worker**:SKIP LOCKED 互斥(两 worker 并发认领不重复);lease 过期接管先查 Core AI 幂等 run;崩溃重放不重复触发;并发上限;回执 Zod 校验失败 → OUTCOME_UNKNOWN;DEAD letter。
- **Scheduler**:显式开启前不跑;到期判定;活跃抑制;日上限;暂停;候选任务停在门外。
- **鉴权**:权限点与商户范围;Chat/服务身份调执行/授权/requeue/capability 接口被拒。
- **契约**:三类 schema 的正反例。
- **前端**:双门按钮与文案、异常新分组、对账流、应用证据表单、降级标识。
- Core AI 以 fake client 模拟;PG 用测试容器或事务回滚夹具。

## 16. 明确不做(本期)

- 与 operation-assistant tasks collection 的双写或同步(仅语义对齐)。
- 官网 CMS 自动写入(无系统通道,WordPress/MealKeyway 仍人工,走 ARTIFACT)。
- 效果复盘(effect-review)自动触发执行。
- Local Falcon campaign 排期管理细节(只做运行计数与成本可见)。
- 整篇 post 删除、服务区域修改(执行通道不支持)。
- SSO/多租户(自有登录之上的企业鉴权后续再议)。

## 17. vault 引用

- 执行通道与红线:`SEO Skills 原文/seo-gbp-execution/SKILL.md`;`餐饮 Local SEO 项目/Skill 解读/13 seo-gbp-execution:GBP授权执行.md`
- 任务队列语义:`餐饮 Local SEO 项目/14 SEO Task 落库:Operation Assistant API Design v2(FBR-7060).md`
- PostBrief 与测试清单:`餐饮 Local SEO 项目/08 SEO 项目进度管理.md`
- 三态分离/Gate/Tier:`餐饮 Local SEO 项目/07 全景图详解.md`、`05 SEO 项目 DRI 工作模式.md`、`15 Connexup Local SEO Agent Demo 视频制作说明与大纲.md`
- 授权现状:`合作伙伴/Only Bear/10 本周官网与 Local SEO 优化内部执行版.md`、`Choice Brooklyn UWS ChangeEvent 补录与能力缺口清单.md`、`合作伙伴/可可小卤/00 可可小卤合作档案.md`
- 周期节奏:`合作伙伴/可可小卤/…合作执行与验收计划 商家版 V3.md`、`合作伙伴/Choice Brooklyn UWS/01 每周 GBP Post 关键词台账.md`
- 关键词埋入位:`SEO Skills 原文/seo-keyword-ranking-optimize/references/embedding-positions.md`

# SEO Ops 执行 Agent 与自动周期设计(flow v4)

日期:2026-08-20
状态:已与产品负责人逐节确认,待实施计划
上一版:`2026-08-17-seo-ops-control-plane-core-ai-uat-design.md`(其"EXECUTE 自动化关闭"红线由本设计有条件解除)
事实依据:Obsidian vault `~/Documents/vault/chancetop`(引用见文末)

## 1. 目标与背景

给代运营人员(Connexup DRI / Local SEO 负责人)一套端到端控制面板:

- **新店**:生成问卷(基于店名/官网)→ 商家填写 → 生成关键词 → GBP + on-page 双审计 → local/organic ranking 基线 → 优化 Plan → 任务落库 → **execution agent 从任务队列捞取执行**。
- **老店**:定期 audit + keyword ranking **自动跑**,基于结果**自动生成调整 Plan 并自动转任务**(如把关键词埋进 GBP post);人的把关点收敛到两处:**授权外部写入** 与 **应用成品**。
- 鉴权暂不考虑(单团队内部工具)。

### 已确认的四个产品决策

| 决策点 | 结论 |
| --- | --- |
| 执行边界 | **混合**:GBP 类动作 agent 真实写入;官网/站内类 agent 产成品,人应用 |
| 审批门 | **分级**:产成品任务免审即执行;写入任务必须批准(=授权写入)后才入队 |
| 老店周期 | **全自动闭环**:定期 audit/ranking 自动跑 → 自动调整 Plan → 自动转任务 |
| Plan 确认 | **新店保留人工勾选确认;老店自动全量转任务** |

### 架构取向(方案 A)

复用现有 agent-run 机械:任务表即队列,新增执行调度器认领任务、触发挂在任务上的 core-ai 执行运行,用现有触发/轮询/附件落盘/sha256 链路收结果。不引入独立 worker 进程,不把编排交给 core-ai 侧。

## 2. 来自 vault 的硬约束(设计地基)

1. **写入通道已存在**:`seo-gbp-execution` skill → operation-assistant DEV API,支持 15 个操作(改 location 单字段/单属性、传一张图、改一个菜品、发/改 GBP post、Place Action Link 增删改)。**没有"改服务区域",不能删整篇 post**。
2. **单写入原则**:一次调用最多一个逻辑写入 → 写入任务必须拆到单写入粒度。
3. **执行 skill 不生成内容**:CREATE_POST 等的字段必须由调用方完整给定 → 内容起草在上游完成,execution_spec 带完整终值。
4. **写入失败不自动重试、写后不自动复查**;API SUCCESS ≠ Google 已展示。
5. **调用即授权**(skill 内不再确认)→ 授权门必须由本控制面承担。
6. **三态分离**:技术已连接 / 商户已授权该资产 / 本次变更已审批,不可合并。现状:UWS 有 GBP 写入且已实际执行;Only Bear 仅官网(WordPress)授权,GBP 未授权;可可小卤均未授权。
7. **审批绑定内容版本**:PostBrief 规范要求批准一个明确版本(checksum),批准后只发布该版本 → 复用现有 task_revision + executionSpecHash + 审批撤销机制。
8. **任务状态语义对齐 FBR-7060**(operation-assistant tasks collection 设计):READY/IN_PROGRESS/DONE/FAILED、plannedExecutionTime、expectedStatus CAS、IN_PROGRESS 不可取消已在跑的 agent。本期不做双写同步,只对齐语义。

## 3. 任务模型与状态机

### 3.1 执行维度

- `execution_mode`:`AUTO_WRITE` | `ARTIFACT`,任务创建时由 task_type 映射定型,不可变。
- 写入类 task_type(与 seo-gbp-execution 操作一一对应):
  `GBP_POST_CREATE`、`GBP_POST_UPDATE`、`GBP_LOCATION_FIELD`(单字段)、`GBP_ATTRIBUTE`(单属性)、`GBP_MEDIA_UPLOAD`、`GBP_MENU_ITEM`(单菜品)、`GBP_PLACE_ACTION_LINK`。
- 产成品类 task_type:`WEBSITE_PAGE`、`WEBSITE_SCHEMA`、`CONTENT_DRAFT` 及其他一切非 GBP 写入动作。
- `execution_spec`(JSON)携带完整终值:精确 canonical `locationName`、目标字段与完整替换值;CREATE_POST 必须含 summary/topic_type/CTA/媒体等全部适用字段。`executionSpecHash`(sha256)即批准绑定的内容 checksum。

### 3.2 状态机(在现有状态上延伸)

```
ARTIFACT:   创建 ──────────────────────→ QUEUED → EXECUTING → AWAITING_APPLY → COMPLETED
                                          (免审入队)  (已认领)   (成品就绪)   (人点「已应用」)
AUTO_WRITE: 创建 → READY_FOR_APPROVAL → QUEUED → EXECUTING → PENDING_VERIFY → COMPLETED
                    (待授权写入)      (批准即入队)          (证据已自动回填)
            (execution_spec 不完整时,创建先落 NEEDS_INPUT,草拟运行补全后进 READY_FOR_APPROVAL;
             Plan 转出的任务自带完整终值,直接 READY_FOR_APPROVAL)
失败:       EXECUTING → EXECUTION_FAILED
取消:       QUEUED / READY_FOR_APPROVAL / EXECUTION_FAILED → CANCELLED
```

转换规则:

- **ARTIFACT**:创建即 QUEUED。运行失败可自动重试(上限 2 次,指数退避)——无外部副作用。
- **AUTO_WRITE**:批准 = 授权写入 = 入队。**失败绝不自动重试**,落 EXECUTION_FAILED 等人处理(重试 = 人工点「重新入队」,生成新尝试号)。
- **内容变更使授权失效**:QUEUED/READY_FOR_APPROVAL 状态下修订 execution_spec → 回 READY_FOR_APPROVAL(现有 revision 机制)。
- **撤销授权**:QUEUED → 撤出队列回 READY_FOR_APPROVAL;EXECUTING → 尽力请求取消运行,若写入已发生则如实记录(不可撤销的写入不假装撤销)。
- **PENDING_VERIFY 不阻塞周期**:证据(before/after、postId、log_id)由运行自动回填(UNVERIFIED);操作员可抽查核验;7 天无异议自动转 COMPLETED。首页不把它列为异常组。
- 幂等:任务创建幂等键沿用 `plan-{runId}-{itemId}`;执行运行幂等键 `exec-{taskId}-rev{revision}-try{n}`(写入类 n 恒为 1),绑定业务指令而非随机 run id。

## 4. 执行调度器(executionDispatcher)

与 agentRunPoller 同进程的定时循环(默认 15s):

1. **捞取**:QUEUED 任务按优先级(URGENT>HIGH>MEDIUM>LOW)+ 同级 FIFO;**每商户在途 1、全局在途 2**(可配)。
2. **认领**:`state_version` 乐观锁 CAS → EXECUTING;挂 `agentRun(stage=EXECUTE, runType=EXECUTION, taskId)`。执行 agent 用独立 core-ai agent id(配置 `EXECUTION_AGENT_ID`,带 seo-gbp-execution skill),与只读 SOP agent 分开。
3. **Prompt 组装**:
   - AUTO_WRITE:要求执行**恰好一个**逻辑操作,给出精确 locationName + 完整终值(来自 execution_spec),要求回传 before/after 证据与执行回执(postId/log_id/media_key);明令禁止拆单多写、禁止改写内容、禁止失败重试。
   - ARTIFACT:要求产出可直接应用的成品附件(文案/代码/清单),按现有附件链路落盘。
4. **收终态**(现有 poller 机械):COMPLETED → ARTIFACT 落 AWAITING_APPLY;AUTO_WRITE 解析回执、证据 append(UNVERIFIED)、落 PENDING_VERIFY。FAILED/TIMEOUT/解析不出回执 → EXECUTION_FAILED(**不确定状态按失败处理,不包装成成功**)。
5. **能力降级**:派发 AUTO_WRITE 前查授权矩阵;商户缺 GBP 写入授权 → 本次按 ARTIFACT 模式跑(产出待人工张贴的成品),任务标 `degraded=true`,UI 明示"写入能力未授权,已降级为成品"。

## 5. 资产授权矩阵(一等对象)

新表 `seo_merchant_capabilities`:`merchant_id, capability(GBP_WRITE|WEBSITE_CMS|MENU_PLATFORM), connected(bool), authorized(bool), note, updated_at`。

- **connected**(技术已连接)与 **authorized**(商户已授权)分列;第三态"本次变更已审批"由任务审批承担。
- 商户页渲染授权矩阵卡,可编辑;调度器据此降级;首页「待授权写入」组的商户若缺授权,提示先补授权而非空等。
- 初始数据:UWS GBP_WRITE connected+authorized;Only Bear WEBSITE_CMS authorized、GBP_WRITE 未授权;可可小卤全未授权。

## 6. 老店自动周期(lifecycleScheduler)

每小时扫描 `auto_cycle_enabled` 的商户(首轮 EXECUTE 走完后默认开启,可手动开关):

- **周期配置**(商户级可调,默认取自运营文档):local ranking 7 天、audit 30 天、performance 月报 30 天、GBP Post 每周 1 条(月≥4)、技术审计 90 天(官网侧,产成品)。
- **只读环节自动跑**:到期且无活跃同阶段运行 → 自动触发,`triggeredBy=scheduler`。
- **结果驱动调整**:新 audit + ranking 齐备后自动触发调整 Plan(REVIEW 运行)→ 完成即自动全量解析转任务(单写入粒度;幂等键防重)。ARTIFACT 即刻入队,AUTO_WRITE 挂待授权。
- **GBP Post 周任务**:每周创建一条 `GBP_POST_CREATE` 任务(NEEDS_INPUT)→ 调度器先跑**草拟运行**(选词:关键词库 P3 场景词,`gbp_posts` 位 ≤1500 字符;素材:已授权素材)填充 execution_spec → READY_FOR_APPROVAL → 人批该版本 → 执行。「已发布」与「已验证」分开记录(postId 回执 = 已发布;公开可见核验 = 已验证)。
- **护栏**:每商户每日自动运行上限(默认 6);ranking 运行计数(Local Falcon credits 成本可见);全局暂停开关(config + 首页显著展示调度状态);自动触发失败不重试,报异常等人。
- **新店不自动**:未完成首轮的商户维持人工节奏 + Plan 勾选确认(现有 UI)。

## 7. 前端 IA(代运营视角)

- **首页异常清单**分组更新为:等待商家 / Plan 待确认(新店) / **待授权写入** / **成品待应用** / **执行失败** / 周期内无待办。轮次徽标、与上期对比条、排名快照表保留。
- **商户页**:同一条阶段轨;EXECUTE 阶段卡换成**执行队列卡**(执行中 x · 待授权 y · 待应用 z · 失败 n;行内主按钮 = 授权 / 查看成品并标记已应用 / 处理失败);新增资产授权矩阵卡;老店显示周期状态行(各环节下次自动运行时间 + 暂停开关)。
- **任务页**:ARTIFACT = 成品阅读区 + 复制 + 「已应用,标记完成」;AUTO_WRITE = 批准版本 checksum、执行回执(postId/log_id)、before/after 证据、降级标识。审批文案:「批准 = 授权 agent 对 GBP 执行此写入(绑定当前内容版本)」。

## 8. 红线对照(vault P0 清单 → 本设计的落点)

| vault 红线 | 落点 |
| --- | --- |
| Plan 必须拆成一次一个精确操作 | §3.1 单写入粒度 task_type + execution_spec 完整终值 |
| 外部写入前存在可验证人工授权;内容变更即失效 | §3.2 批准=入队;revision 使授权失效 |
| read-only 不触发写入 | 只读 SOP 与执行 agent 分 id;ARTIFACT prompt 无写入指令 |
| 失败/超时/不确定如实返回,不包装成功 | §4.4 不确定按失败;EXECUTION_FAILED 一等状态 |
| CREATE/UPLOAD 不自动盲重试 | §3.2 写入不自动重试;重试是人工动作 |
| 写入回执落 operation/log_id/Trace 并关联计划项 | §4.4 回执入 evidence;任务↔run↔plan 链路已有 |
| 写后复查是独立步骤;SUCCESS≠已展示 | PENDING_VERIFY 独立态;已发布≠已验证 |
| 幂等键绑业务指令 | §3.2 `exec-{taskId}-rev{N}` |
| 权限是 capability 不是数据流 | §5 授权矩阵一等对象 + 降级 |
| Agent 草稿 ≠ 修改已上线 | AWAITING_APPLY / PENDING_VERIFY / COMPLETED 三态分离 |

## 9. 测试策略

- **状态机单测**:两种 mode 的全部合法/非法转换、降级、撤销授权中断、revision 失效授权、PENDING_VERIFY 7 天自动完成。
- **调度器单测**:CAS 认领互斥、优先级与 FIFO、每商户并发 1/全局 2、ARTIFACT 重试上限与退避、写入不重试、两种终态回写、回执解析失败按失败处理、降级路径。
- **周期单测**:到期判定、活跃运行抑制、日上限、暂停开关、周 post 任务草拟链、新店不受自动周期影响。
- **路由/集成**:队列视图 wire、授权动作、成品应用动作、授权矩阵 CRUD。
- **前端**:首页新分组、执行队列卡、成品应用流、授权按钮与文案、降级标识。
- 全程 TDD;执行 agent 的 core-ai 调用在测试中以 fake client 模拟(沿用现有 fakeCoreAi 模式)。

## 10. 明确不做(本期)

- 鉴权/多租户。
- 与 operation-assistant tasks collection 的双写或同步(仅语义对齐)。
- 官网 CMS 自动写入(无系统通道,WordPress/MealKeyway 仍人工,走 ARTIFACT)。
- 效果复盘(effect-review)自动触发执行——复盘只读展示,建议不落任务。
- Local Falcon campaign 的排期管理细节(只做运行计数与成本可见)。
- 整篇 post 删除、服务区域修改(执行通道不支持)。

## 11. vault 引用

- 执行通道与红线:`SEO Skills 原文/seo-gbp-execution/SKILL.md`;`餐饮 Local SEO 项目/Skill 解读/13 seo-gbp-execution:GBP授权执行.md`
- 任务队列语义:`餐饮 Local SEO 项目/14 SEO Task 落库:Operation Assistant API Design v2(FBR-7060).md`
- PostBrief 与测试清单:`餐饮 Local SEO 项目/08 SEO 项目进度管理.md`
- 三态分离/Gate/Tier:`餐饮 Local SEO 项目/07 全景图详解.md`、`05 SEO 项目 DRI 工作模式.md`、`15 Connexup Local SEO Agent Demo 视频制作说明与大纲.md`
- 授权现状:`合作伙伴/Only Bear/10 本周官网与 Local SEO 优化内部执行版.md`、`Choice Brooklyn UWS ChangeEvent 补录与能力缺口清单.md`、`合作伙伴/可可小卤/00 可可小卤合作档案.md`
- 周期节奏:`合作伙伴/可可小卤/…合作执行与验收计划 商家版 V3.md`、`合作伙伴/Choice Brooklyn UWS/01 每周 GBP Post 关键词台账.md`
- 关键词埋入位:`SEO Skills 原文/seo-keyword-ranking-optimize/references/embedding-positions.md`

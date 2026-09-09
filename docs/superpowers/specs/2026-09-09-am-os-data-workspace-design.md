# AM OS 数据工作空间设计 v1：Audit、Performance 与交付报告

日期：2026-09-09
状态：待用户审阅
地位：`2026-09-09-am-os-business-contract-design.md`（契约）在数据模块上的展开；Performance 历史、比较规则、冻结报告的底层设计**复用** `2026-09-03-performance-dashboard-history-design.md`（下称「历史看板 spec」，另一会话所写，本文不重写它，只引用并记录差异）。
来源：用户 2026-09-09 对 AM 工作台原型 v3 的审阅意见。

## 0. 三个问题与三条边界

| 问题 | 模块 | 回答方式 |
|---|---|---|
| 现在有什么问题？ | Audit | 一次固定输入的诊断 Task 的结果，可与历史对比 |
| 一段时间内表现怎样、有没有改善？ | Performance | 对已有历史观测的查询与比较，不生成任何东西 |
| 当时向老板交付了什么？ | 报告 | 冻结快照 + 文件 + 交付记录，不随后续数据变化 |

三者关联但不混成一个页面、一份数据或一个「生成」按钮。三条边界：

1. 选择期间只是查询已有数据，不自动生成报告、调用 LLM 或购买扫描。「分析这段表现」「生成报告」「同步数据」是三个独立的明确操作，各自创建各自的 Task。
2. 打开历史 Audit 或历史报告不重新调用 Agent。
3. 两种历史分开：现在查看过去某月的 Performance 用当前已获得的有效历史数据并标明补数；打开当时交付的报告保持冻结。

## 1. 商户内入口

商户空间 tab 固定为：**概览｜计划与任务｜Performance｜Audit｜资料与记忆｜报告**。

- 全局「数据与报告」用于跨商户查看（历史看板 spec §3.1 的四层看板保留在那里）；从某家商户进入 Performance / Audit / 报告时自动带上当前商户范围，不跳到混有其他商户的页面。
- 概览只放摘要与入口，四张卡：最近一次有效 Audit（时间、覆盖度、主要未解决问题）；当前期间 Performance（关键变化、数据缺口）；下次诊断时间与正在执行的诊断任务；最近一期报告及交付状态。详细分析放各自页面。

## 2. Audit：周期规则 + 每次独立 Task

### 2.1 流程

```
已授权的周期规则 / AM 手动触发
  → 创建 Audit Task（契约 R1：周期规则在服务 Plan 授权范围内，自动创建并派单给审计 Agent）
  → 获取并固定输入数据（输入清单 + hash 落库；之后 Agent 只读这份固定输入）
  → 审计 Agent 分析
  → 服务端校验并保存诊断结果（结构化：维度得分、覆盖、问题列表、证据引用；规则版本、检查范围版本）
  → Orchestrator 判断是否需要调整 Plan 或任务（新增问题 → 提案；持续问题 → 关联既有任务，不重派）
```

周期 Audit 归属已授权的服务 Plan；首次入驻诊断归入初始化 Plan，不必先有完整 SEO 策略。周期规则和每次执行的 Task 分开存：规则是配置（`audit_schedules`），执行是 Task + 结果（`audit_runs`）。

### 2.2 页面四部分

**1）当前诊断状态**：最近有效报告、数据截至时间、覆盖范围、进行中的任务、下次执行时间。三个操作分开：查看最近诊断（只读）、立即诊断（创建 Task；同范围已有运行中的诊断时提示查看当前任务，不重复执行和付费）、周期设置。

**2）诊断历史**：每次独立保留，列：执行时间与诊断类型（完整 Audit / 专项复查 / 首次入驻）；触发（手动 / 周期）与关联 Task；数据期间与数据截至（区分「什么时候诊断」和「分析了哪段数据」）；覆盖度与结果状态（完整 / 部分覆盖 / 执行失败）；得分与主要变化。**执行失败的一次不能覆盖上一次有效结果，也不能显示成 0 分**；专项复查不计总分。

**3）诊断详情与对比**：可选「与上一次 / 首次基线 / 指定一次」比较。四组问题：新增、持续存在、已核验解决、再次出现；每条带优先级、关联 Plan / Task、证据引用。规则：同一问题反复出现时关联已有任务，不每次重新派单（问题身份 = 维度 + 检查项 + 资产的稳定 key）；评分规则或检查范围版本不同时提示「不可直接比较」并只并列展示；「Task 已完成」不等于问题已解决，「已核验解决」需要新一次诊断的证据。

**4）周期配置**：频率、时区、检查范围、每次预算、数据新鲜度要求（不满足则标部分覆盖）、暂停条件（凭证失效、商户归档、连续失败次数）。「每月完整诊断 + 每周重点问题复查」作为服务方案选项，不默认每周全量。修改从下一次执行生效，不改历史。

### 2.3 评分

总分 = 已评分维度的等权平均；N/A（未覆盖）不计入；0 分 = 已检查且完全缺失。若将来改加权，公式与版本写进结果并在页面解释。原型 v3 的「62 分」与六个分项（78/90/55/41/20/0）不一致，正确值 47.3。

### 2.4 数据对象

- `audit_schedules`（merchant_id, plan_id, kind ∈ FULL|FOCUSED, cadence, timezone, scope_version, budget_per_run, freshness_rule, pause_conditions, active, created_by, created_at, superseded_by）——配置只追加新版本。
- `audit_runs`（id, task_id, merchant_id, schedule_id|null, trigger ∈ SCHEDULE|MANUAL|ONBOARDING, kind, input_manifest_json/hash, data_period_start/end, data_through, executed_at, rule_version, scope_version, coverage_json, status ∈ COMPLETE|PARTIAL|FAILED, total_score|null, dimensions_json, issues_json, evidence_refs_json, agent_run_id）——不可变。
- `audit_issue_links`（issue_key, merchant_id, first_seen_run_id, last_seen_run_id, resolved_run_id|null, linked_task_id|null, status ∈ OPEN|LINKED|RESOLVED|REOPENED）——支撑「持续 / 已解决 / 再次出现」与关联既有任务。
- 现有 `audit_snapshots`（0 行）与 `merchant_seo_artifacts.AUDIT_REPORT` 作为历史来源迁入 `audit_runs`，标 `trigger=MANUAL`、`rule_version=legacy`。

## 3. Performance：自由时间分析

底层沿用历史看板 spec：不可变观测 `metric_observations` + head 读模型（§6.4）、日期基准与比较模式（§8）、指标语义（§9）、数据质量模型（§10）、冻结报告（§6.6、§13）。本文只规定商户内 Performance 页的呈现与三条硬约束的落地。

### 3.1 统一筛选栏

门店范围｜统计期间｜比较期间｜日 / 周 / 月粒度｜数据状态。期间至少支持：最近 7 / 28 / 90 天；本周、上周、本月、上月；服务周期；自定义起止。比较：上一等长期间、上一自然周期、去年同期、指定期间（历史看板 spec §8.2 的三种模式加「上一自然周期 / 去年同期」两个快捷项，语义仍归到 previous_equal_length / previous_complete_calendar_month / custom）。

### 3.2 分层内容

| 区域 | 内容 | 约束 |
|---|---|---|
| 表现摘要 | GBP 曝光、官网点击、电话按钮点击、路线请求；有权限时加 GSC | 四个行动指标分开显示，不合成「导航与来电」一个数；电话按钮点击 ≠ 接通或到店（Google `DailyMetric` 定义） |
| 趋势 | 当前期与比较期逐日 / 周 / 月 | 缺失日期断线并标明原因，不补零不插值 |
| 渠道明细 | GBP、GSC、评价分开 | 未授权来源显示「无数据」不是 0 |
| 关键词与排名 | 我们生成的关键词、评分、当期监测集、ARP / ATRP / SoLV、点阵图、历史扫描 | 见 §3.3 |
| 本期执行 | 发布、修复、审核、阻塞等事件 | 与趋势横轴对齐 |
| 数据质量 | 来源、覆盖期间、最后成功同步、未完成或缺失 | 每个来源自己的数据截至时间与日期口径 |

### 3.3 历史比较硬规则

- 日度表现按期间聚合；Local Falcon 按实际扫描时间展示，没扫描的日期不补成排名曲线。
- 点阵图比较需要关键词、中心点、网格、半径一致（历史看板 spec §9.4 的 Cohort 锁定）。
- Top 20 变化时保留当时的监测集；不能拿今天的 Top 20 替换历史后再算「增长」（监测集版本冻结，`merchant_keyword_heads` 只是当前指针）。
- 缺数据不是零；前期为零时不显示误导性的增长百分比（历史看板 spec §8.3）。
- GSC 日期按太平洋时间，区分已最终确定与较新的未完整数据；GSC property 服务多家门店时未经映射不算单店表现（历史看板 spec §5.2、§8.1）。

## 4. 报告：冻结交付物

- 冻结报告绑定生成时的数据批次、人口、公式版本、渲染 payload 与文件字节（历史看板 spec §6.6）；补数、修正、公式升级不改既有报告，只能生成 v2 修订版并保留 v1 与 supersedes 关系。
- 报告页列表每行：报告、商户、数据截至、冻结快照、AM 审阅、导出、交付、操作。内部草稿可导出但带「草稿 · 未审核」标识；正式交付需审核。生成文件、下载、对客户发送是三个动作，各自留记录（契约 §8.3）。
- 旧报告（周报 PDF、月报 PPTX、Audit 总分与维度、评价摘要、排名网格截图、竞品对比表等）逐项映射到新页面形成覆盖清单；未覆盖项明示。历史看板 spec 第一期只做 HTML / canonical JSON，PDF / PPTX 是 AM OS 目标中的独立子项目，覆盖清单里如实标「待 PDF renderer」。

## 5. 两种历史（实现前最关键）

| 历史类型 | 数据来源 | 行为 |
|---|---|---|
| 现在查看过去某月的 Performance | `metric_observation_heads`（最新有效版本） | 可随补数更新，页面标明「数据已于 {日期} 补齐 / 修正」 |
| 打开当时交付的月报 | `report_snapshots` + `report_artifacts`（冻结） | 不变；更新交付物 = 新修订版，旧版保留 |

例：9 月补到 8 月缺失的三天，8 月 Performance 更新并说明已补齐；已交付的 8 月月报不变；如需更新交付物生成 v2。因此数据库不能只保留「最后一次同步结果」，要保留足以支持查询的历史观测、来源与修订记录，以及独立冻结的报告快照。

## 6. 现有数据库核对结果（2026-09-09 只读检查）

用户提出「本轮没有检查实际数据库，不能确认现有系统已具备历史数据」。已对 `data/seo-ops-v3.db`（2026-09-08 版本）只读核对：

| 对象 | 现状 | 结论 |
|---|---|---|
| 历史观测层（`metric_observations`、`metric_observation_heads`、`metric_sync_jobs/batches`、`source_scopes`、`merchant_locations`、`data_quality_events`） | 表已由迁移 `0001_performance_history`、`0003_performance_lifecycle_baseline`（2026-09-04）建立，**全部 0 行** | 历史看板 spec 第一期只落了 schema，同步与查询路径未实现；`performance_dashboard.py` 仍读旧投影 |
| GBP 日度指标 | 只在 `merchant_gbp_profiles.normalized_json` 里，每商户一份最新快照：8 项指标，仅 2026-08-18 至 08-29/30 共 12–13 天；搜索关键词仅 2026-07 一个月；4 份档案覆盖 Choice Brooklyn（2 门店）、Only Bear、可可小卤 | **没有可查询的历史；George Merchant 没有任何 GBP 档案和指标** |
| Local Falcon | `merchant_local_falcon_reports` 54 行，仅 Choice Brooklyn：50 个关键词、5 个扫描日期（2026-06-24 至 09-03）、9×9、0.5 mi | 唯一有跨期历史的来源，可做扫描历史与点阵比较验证 |
| Audit | `audit_snapshots` 0 行；`merchant_seo_artifacts` 有 AUDIT_REPORT 2 行（Choice Brooklyn，09-02）、RANKING_REPORT 2 行、KEYWORD_SET 16 行 | 有两份同商户的 Audit 产物可做「两次对比」验证；无周期、无固定输入记录 |
| 冻结报告 | 无 `report_snapshots` / `report_artifacts` 表 | 尚不存在 |

结论：**现有系统不具备支撑「历史能查准、报告不会变」的数据**。George 当前没有 GBP 指标，不能用它做 Performance 历史验证；Choice Brooklyn 是唯一同时有 GBP 快照、Local Falcon 历史和两份 Audit 产物的商户。

## 7. 最低成本验证（改用可行的目标）

| 验证 | 目标商户 | 前提 | 通过标准 |
|---|---|---|---|
| V1 过去完整月 + 任意区间能从历史算出指标 | Choice Brooklyn | 实现历史看板 spec Phase 1 的同步与观测写入，并补采至少两个完整月 | 两种期间的曝光 / 行动指标与手算一致；缺失日期显示为缺失 |
| V2 两次 Audit 可对比 | Choice Brooklyn（两份 AUDIT_REPORT）或 George（跑两次固定输入的 Audit Task） | `audit_runs` + `audit_issue_links` 落库 | 新增 / 持续 / 已解决 / 再次出现四组正确；失败 run 不覆盖有效结果 |
| V3 旧报告不随当前数据变 | Choice Brooklyn | 冻结一份 8 月报告快照后再补采 8 月数据 | 报告字节 hash 不变；Performance 页显示已补齐并与报告数字不同 |

顺序：先 V1 的数据层（同步 + 补采 + 观测查询），再 V2、V3；三项通过后再把 Audit Task 接到 Orchestrator 的持续诊断。

## 8. 原型 v4 范围

只补三组画面（prompt：`docs/evidence/2026-09-09-am-workspace-ui/prompt-v4.md`）：商户 Audit 中心（最近诊断、历史、周期设置、运行中与失败状态）；Audit 对比详情（新增 / 持续 / 已解决 / 再次出现及关联任务）；商户 Performance（真正展开的自定义日期与比较期选择、趋势、历史扫描、无数据 / 部分数据状态、两种历史并排）。同时清理 v3 的五处：时间筛选与趋势由示意改为实画；Audit 只一份改为历史列表；09-01 至 09-07 期间不混入 09-08 扫描（作「最新补充观测」）；总分 62 改 47；人工任务取消弹窗的「下游一直等待，需要重新派单」改为「进入等待依赖，由 Orchestrator 重新规划」。

另按 `2026-09-09-am-os-interaction-contract-design.md` §12 补交互契约：每个按钮带 `data-target` / `data-effect` / `title`，锚点指向正确对象（为此增加轻量的商户列表与任务列表两个区块），并用「批准这一版」画出六种情况样例。验收脚本检查所有 `href="#…"` 可解析、所有按钮带 `data-target`。

## 9. 与历史看板 spec 的差异

| 项 | 历史看板 spec | 本文 |
|---|---|---|
| 导航 | `看板 → 商户 → 任务`，看板在首位 | AM OS 五入口；跨商户看板在「数据与报告」，商户内六 tab |
| Audit | 不在范围 | §2 周期规则 + 独立 Task + 历史对比 |
| 报告文件 | HTML + canonical JSON，PDF 不在 DoD | 覆盖清单如实标 PDF / PPTX 待独立子项目 |
| 草稿导出 | 黄色数据可生成「不完整」报告需二次确认 | 另加「草稿 · 未审核」标识规则（契约 §8.3），不冲突 |
| 比较快捷项 | 三种模式 | 加「上一自然周期 / 去年同期」快捷项，映射到同三种模式 |

其余（观测不可变、head 读模型、日期基准、变化计算、Local Rank Cohort、数据质量、冻结报告生命周期、永久保留、迁移）全部沿用，不另写。

# 证据分级、任务完成语义与不完整数据比较

日期：2026-09-10
状态：待用户审阅
地位：`2026-09-09-am-os-business-contract-design.md`（业务契约）在「系统用证据判断完成」这条原则上的具体化。与 `2026-09-09-am-os-data-workspace-design.md`（数据工作空间）、`2026-09-09-gbp-post-task-design.md`（GBP 工作单）一致；本文更具体、更晚，冲突以本文为准。
来源：用户 2026-09-10 对运行中系统的对照审阅。

## 0. 为什么这三件必须一起定

它们共用同一个判断：**我们现在到底知道什么。**

一次诊断把「没取到数据」写成「发现问题」，一张工单就会承诺一件系统做不到的事，一份表现报告就会把覆盖不足的两段时间当成可比。三者各自看都像界面问题，合起来是同一个缺陷：系统没有区分「已知」「未知」和「不适用」，于是把未知一路当成已知向下传递。自动化越强，扩散越快。

分开修会互相拆台：只加证据分级而不改任务类型，诊断会正确地说「缺电话」，然后仍然只能生成一个 `PREPARE_ONLY` 任务去「准备电话的材料」；只改任务类型而不管比较口径，AM 仍会因为一个虚假跌幅去开一张真实工单。

## 1. 现状（2026-09-10 实测）

George Merchant 的诊断 run 15，报告正文是自由格式 Markdown，其中一节标题是 `## Verified Issues, Evidence, Severity & Expected Impact`，下面六条里：

| 条目 | 它写的证据 | 实际是什么 |
|---|---|---|
| 5. No citation/NAP consistency evidence available | `No citation data present; BASIC_PUBLIC_ONLY mode.` | 数据未接入 |
| 6. Core listing fields missing (category, phone, hours) | `None of these fields are present in the evidence.` | 数据未接入 |
| 2. Website is a dev/staging domain | `website_url` 主机名含 `dev`、`.online` TLD | 观察已验证，但结论「Weak domain authority and trust」是推断 |

报告另有 `## Missing Inputs` 一节，列出十项缺失输入，其中就包括 category、phone、hours 和 citation。**同一批事实同时出现在两节里，但只有「Verified Issues」那一份会变成任务。**

任务侧：`plan_parser.extract_plan` 从 Markdown 的 ```json 围栏里取出 `seo_ops.task_plan.v1`，plan 8 的六个任务全部是 `PREPARE_ONLY`，包括「向老板核实真实名称、类目、电话、营业时间」「认领并修正 GBP」「建设生产环境网站」。这不是 Agent 偷懒：`task_workflows.WORKFLOW_TEMPLATES` 只有 `PREPARE_ONLY` 一个模板，契约会以 `task_type_disabled` 拒绝其它任何取值。**系统只提供一种工作流，于是所有事都叫这个名字。**

另有一个结构性事实：已定义并带校验的 `seo_ops.audit_report.v1`（`audit_snapshots.py`）在库里是 0 行。带 schema 的那条路径没有被这次诊断使用，报告以自由文本落在 `runs.report_text`。所以闸门不能只加在 schema 上。

表现侧：最近 7 天筛选同时显示 GBP 曝光 −12.3%、当前数据完整度 5/7 天、菜单浏览 −72.6% 且只有 2/7 天。页面已有「数据不完整（N/M 天）」提示（`MerchantPerformance.tsx:197`），但百分比照常算、照常显示，两者并排，读者会先看百分比。

## 2. 证据分级

### 2.1 四类

每条 finding 必须带 `evidence_class`，取值恰好四个：

| 取值 | 含义 | 硬性要求 |
|---|---|---|
| `VERIFIED_ISSUE` | 依据我们持有的证据观察到的问题 | `evidence[]` 非空，且每一项必须是可解析的证据引用（见 §2.3），不能是散文 |
| `UNCONFIRMED` | 有信号，但把信号变成结论还需要确认 | 必须写明「已观察到什么」和「还需要确认什么」两件事 |
| `DATA_NOT_CONNECTED` | 这次没有取到该数据，商户有没有问题未知 | 必须写明缺哪个来源、以及接入它需要什么 |
| `NOT_APPLICABLE` | 该检查项对这家商户不适用 | 必须写明为什么不适用 |

### 2.2 观察与推断分开

`VERIFIED_ISSUE` 再拆两个字段：

- `observation`：证据直接支持的陈述。例：`website_url 主机名为 ordering.connexup-dev.online`。
- `inference`：由观察推出的判断，可为空。例：`该域名可能被搜索引擎视为非生产站点`。

规则：**severity 依据 observation，不依据 inference。** 一条只有推断支撑的严重性不能进入 Plan。George 报告第 2 条现在会是：observation 已验证（主机名确实含 dev），inference 未确认（域名权威性未测量），因此它是 `UNCONFIRMED`，不是 `VERIFIED_ISSUE`。

### 2.3 证据引用是引用，不是描述

`evidence[]` 每项是一个结构化引用，指向系统里真实存在的东西：

```
gbp-location-readback:<merchant_gbp_profiles.id>#website_url
metric-observation:<metric_observations.id>
local-falcon-report:<merchant_local_falcon_reports.id>
seo-artifact:<merchant_seo_artifacts.id>
operator-note:<task_events.id>
```

服务端在接收诊断结果时校验每个引用可解析、且属于该商户。解析不了就拒绝该条 finding，而不是降级放行。`No citation data present` 这种句子不再是合法证据。

### 2.4 从 finding 到任务的映射

这是本节的执行闸门，落在 Plan 物化处（不是 Agent 的提示词里）：

| evidence_class | 允许生成的任务 | 禁止 |
|---|---|---|
| `VERIFIED_ISSUE` | 整改类任务 | — |
| `UNCONFIRMED` | 核实类任务（去测量、去确认） | 整改类任务 |
| `DATA_NOT_CONNECTED` | 接入类任务（拿授权、连数据源）或人工输入任务 | 整改类任务 |
| `NOT_APPLICABLE` | 不生成任务 | 一切 |

违反即拒绝整份 Plan 并说明是哪一条，不做部分物化。理由与契约 §1.1 一致：一次拒绝比一个半对的 Plan 便宜。

按这套规则重跑 George 那份诊断，第 5、6 条会从「整改门店资料缺失」变成「接入 GBP 后重新评估」和「向商户核实类目、电话、营业时间」——后者正是它现在的任务标题，但那时它的来源会是诚实的。

## 3. 任务完成语义

### 3.1 问题不是模板少，是承诺与能力不符

现在 `PREPARE_ONLY` 的 DONE 含义是「操作员批准了准备好的材料」。用它表示「老板已经告诉我们电话号码了」或「GBP 已经认领成功了」，是把一段建议文本当成事实。

### 3.2 四种任务种类，各自定义完成证据

| 种类 | 谁执行 | DONE 的充分条件 | 例 |
|---|---|---|---|
| `PREPARE_ONLY` | AGENT | 操作员批准了产出的材料。**它明确不改变外部世界** | 起草落地页文案 |
| `HUMAN_INPUT` | HUMAN | 提交了被索取的字段值，带来源说明，可附凭证 | 向老板核实电话与营业时间 |
| `EXTERNAL_ACTION` | HUMAN 或 AGENT | 服务端从外部系统读回并匹配 | 认领 GBP、发布帖子、修正目录信息 |
| `VERIFICATION` | SYSTEM | 一次只读核验的证据快照与匹配依据 | 读回 GBP 确认营业时间已生效 |

`PREPARE_ONLY` 保留且语义收紧；它是四种里唯一一种完成后世界没有变化的。

### 3.3 三条硬规则

1. **没有任何任务可以靠一段建议文本变成 DONE。** 每个种类的完成证据在上表里，服务端校验。
2. **`EXTERNAL_ACTION` 的 DONE 只由服务端读回决定。** 执行者声明「我做完了」只能把任务推进到 VERIFYING，不能推到 DONE。这与 GBP 工单 spec 的裁定一致。
3. **`HUMAN_INPUT` 的产出是结构化字段，不是自由文本。** 任务定义时声明要哪几个字段；提交时按字段校验；下游任务读字段，不读备注。George 那条「核实名称、类目、电话、营业时间」因此会声明四个字段，而不是「记在共享笔记里」。

### 3.4 与已定工单模型的关系

GBP 内容工作单已定为「草稿 Task → 人工审核 Task → 发布 Task〔含远端核验〕」。它是本节的一个实例：草稿是 `PREPARE_ONLY`，审核是 `HUMAN_INPUT` 的一个特化（产出是批准或退回的决定），发布是 `EXTERNAL_ACTION`，核验是发布任务内部的 `VERIFICATION` 阶段。本 spec 不改那个模型，只把它的类型体系推广到其它工作。

## 4. 覆盖不足时的比较

### 4.1 先例

09-03 的历史看板 spec §8.3 已经定过：「数据覆盖不同：变化只使用两期共同存在的配对人口，并显示 matched population / cohort count」。V1 实现了按门店配对，没有实现按天配对。本节是把同一条规则补到天这一维，不是新规则。

### 4.2 三条规则

**规则一：总量永远是真实总量。** 不因为覆盖不足而缩放、外推或补零。今天已经如此，保留。

**规则二：变化率只在配对日上计算。** 两期都观测到的日期集合叫配对日。变化率 = 当前期配对日总量 与 比较期配对日总量 之比。响应里同时给出 `matched_days`、两期各自的 `observed`/`expected`，以及用于计算变化的那两个配对总量——它们与展示的总量不同，这一点必须显式，不能让读者以为百分比是那两个大数算出来的。

**规则三：配对日太少就不给百分比。** 配对日少于当前期长度的一半，或少于 3 天，则不返回变化率，返回 `delta: null` 与 `delta_reason: "insufficient_matched_days"`。界面显示两期实际值与各自覆盖，配以一句「数据不完整，暂不形成趋势结论」。

按这三条，你实测的那两个数会变成：GBP 曝光 5/7 天，配对日若为 5 天则给出配对日上的变化率并标注「基于 5 个配对日」；菜单浏览 2/7 天不足 3 天，不显示百分比，只显示两期实际值和 2/7 的覆盖。

### 4.3 界面

- 变化率与覆盖不再并排平权。覆盖不足时，覆盖说明在上，数值在下，百分比不出现。
- 有百分比时，其旁必须写明它的基数（`基于 N 个配对日`）。
- 「数据不完整，暂不形成趋势结论」是固定文案，不随指标变化。

## 5. 数据与接口变更

新增或修改：

- `seo_ops.audit_report.v2`：`findings[]` 增加 `evidence_class`、`observation`、`inference`、`check_id`（用于历次对比，见数据工作空间 spec §2.4）；`evidence[]` 改为结构化引用；`severity` 的取值不变但绑定 observation。
- 诊断结果落库路径统一走校验：自由文本报告仍可保留供人阅读，但 finding 与 plan 必须来自校验通过的结构化部分。`runs.report_text` 里的 ```json 围栏不再是 Plan 的唯一来源。
- `WORKFLOW_TEMPLATES` 增加 `HUMAN_INPUT`、`EXTERNAL_ACTION` 两个模板及其状态路径；`PREPARE_ONLY` 保持不变。
- `tasks` 增加 `required_fields_json`（`HUMAN_INPUT` 用）与 `completion_evidence_json`（各种类的完成证据）。
- Plan 物化处增加 §2.4 的映射校验。
- `POST /api/merchants/{id}/performance/query` 的 KPI 增加 `matched_days`、`matched_current`、`matched_comparison`；`delta_reason` 增加 `insufficient_matched_days`。

## 6. 迁移与既有数据

- 已存在的 `PREPARE_ONLY` 任务不重新分类，保持原样并在详情页标注「按旧语义完成」。不追溯改写历史。
- 已生成但未批准的 Plan（如 plan 8）在新规则下重新物化会被拒绝。处理方式：保留原 Plan 只读，提示需要重新诊断，不自动改写它的任务类型。
- `seo_ops.audit_report.v1` 的历史产物导入为 `rule_version=legacy`、`comparable=false`，与数据工作空间 spec §4.2 一致。

## 7. 不做什么

- 不改 Core AI 的 Agent、模型或记忆能力。SEO Ops 管业务关系、权限与交付；诊断能力继续复用 Core AI。
- 不在本 spec 内实现周期 Audit 调度、冻结报告、PDF/PPTX。
- 不做工作台、商户页、团队页的信息重排——那是用户建议顺序里的第三步。

## 8. 待用户裁定

1. **配对日阈值**。我取的是「少于当前期一半或少于 3 天则不给百分比」。这两个数字是判断，不是推导。
2. **`UNCONFIRMED` 是否允许进入 Plan 作为核实任务，还是只进「需要关注」不建任务。** 我倾向前者，因为核实本身是真实工作，但它会让 Plan 变长。
3. **自由文本报告的去留**。我保留了它供人阅读，但它不再是任务来源。也可以更激进：诊断只返回结构化结果，正文由 SEO Ops 渲染。

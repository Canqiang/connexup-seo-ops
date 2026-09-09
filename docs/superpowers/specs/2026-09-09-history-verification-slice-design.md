# 历史验证切片 v1：用 Choice Brooklyn 证明「历史能查准、诊断能追溯、报告不会变」

日期：2026-09-09
状态：待用户审阅
地位：`2026-09-09-am-os-data-workspace-design.md` §7 的第一个实施切片；底层沿用 `2026-09-03-performance-dashboard-history-design.md`（历史看板 spec）与其 Phase 1 计划 `2026-09-03-performance-dashboard-phase-1-gbp-history.md`（下称「Phase 1 计划」，另一会话所写；本文只裁剪与映射，不重写）。业务规则遵守 `2026-09-09-am-os-business-contract-design.md`，界面遵守 `2026-09-09-am-os-interaction-contract-design.md`。
原则：先证明三件事，再把 Audit 与 Performance 接到 Agent 的持续诊断。

## 0. 三条证明与通过标准

| 证明 | 目标 | 通过标准 |
|---|---|---|
| V1 历史能查准 | 对 Choice Brooklyn 任选一个任意日期区间（来源起点 2026-08-18 之后）和第一个完整月（2026-09，10 月 1 日后可验），从已存历史观测得到 GBP 指标与比较 | 总量、逐日值与手算 gold fixture 一致；缺失日期显示为缺失且不参与均值；比较期按三种模式正确（比较期早于来源起点时显示「无可比数据」）；同一查询重复执行结果字节一致 |
| V2 诊断能追溯 | 每次 Audit 是独立、不可变的一条记录；失败不覆盖有效结果；两次可比的 Audit 能算出新增 / 持续 / 已核验解决 / 再次出现 | 历史列表含成功、失败、专项；失败行无得分；对比引擎对固定输入给出确定结果；规则版本不同返回「不可直接比较」 |
| V3 报告不会变 | 冻结一份 8 月报告后再补采 8 月数据，报告不变 | 快照与文件 SHA-256 不变；Performance 查询结果改变并标「已补齐」；报告页显示 `has_newer_source_data`；更新交付物只能生成 v2 且 v1 保留 |

## 1. 范围

做：
- **V1**：GBP 日度指标的历史观测层（同步、补采、查询）与商户内 Performance tab 的最小页面。只做 GBP 一个来源、Choice Brooklyn 一个商户（两家门店）作为试点 allowlist。
- **V2**：`audit_runs` / `audit_issue_links` 落库，导入现有两份 AUDIT_REPORT 产物为不可比的历史，对比引擎与固定输入测试，商户内 Audit tab 的历史列表与对比页（只读）。
- **V3**：手动冻结报告的最小子集（`report_snapshots` / `report_artifacts` / `report_snapshot_batches`，canonical JSON + 自包含 HTML），报告页列表、查看指定版本、生成 v2；「已补齐」与 `has_newer_source_data` 标记。

不做（本切片）：GSC、评价、Local Rank Cohort 化（Phase 2）；自动月报、资格账本、容量预留（历史看板 spec §6.6 后半、§13）；PDF / PPTX；跨商户看板的图表（Phase 1 计划 Task 11–13 的 report-fusion 界面）；周期 Audit 规则的调度与新的审计 Agent 配置；把任何结果交给 Orchestrator。

## 2. 与 Phase 1 计划的任务映射

现状：Phase 1 计划 Task 1（迁移 `0001_performance_history`、`0003_performance_lifecycle_baseline`）已落库，Task 2–14 未实现；`performance_dashboard.py` 仍读 `merchant_gbp_profiles` 旧投影。

| Phase 1 任务 | 本切片 | 说明 |
|---|---|---|
| 2 canonical JSON、期间数学、指标注册表 | 全部采用 | 三种比较模式、日均比较、8 个 GBP 指标键 |
| 3 门店、生命周期、来源绑定 | 只为 Choice Brooklyn 两家门店建 `merchant_locations` 与 `source_scopes(GBP_LOCATION)` | 时区必须显式录入（见 §9.3） |
| 4 批次发布与 head | 全部采用 | 观测不可变、head 只进不退 |
| 5 现有快照导入 | 采用 | 把 `normalized_json.performance_metrics` 的 12–13 天导为 `legacy_current_snapshot` 批次，只声明真实存在的日期 |
| 6 GBP 归一化与能力探测 | 采用 | 先跑 §9.1 的历史深度探测 |
| 7 成功同步双写 | 采用 | 旧投影继续更新，商户资料页不变 |
| 8 补采预检与作业 API | 采用（只 GBP） | 操作员显式确认、按月分片 |
| 9 租约执行与每日同步 | 采用 | 只读；与 Core AI 无关 |
| 10 人口安全的历史查询契约 | 采用，但入口改为商户内 `POST /api/merchants/{id}/performance/query` | 单商户 / 单门店；跨商户人口留给全局看板 |
| 11–13 看板界面 | **不采用**，改为 §6 的最小页面 | 报告融合风图表留到数据模块下一切片 |
| 14 迁移演练与试点 | 采用其中：迁移可重复、备份读回、试点 allowlist 只含 Choice Brooklyn | 容量记录保留 |

## 3. V1 设计：GBP 历史观测

### 3.1 来源与键

- FBR operation-assistant-api `GET /gbp/performance-metric?from_date&to_date&place_id`（现有 `FbrGbpClient.list_performance_metrics`）。**2026-09-09 只读探测结果（§9.1）：两家门店无论请求 06-01 还是 08-09 起，都只返回 2026-08-18 至 09-06 的数据；来源起点固定为 08-18（GBP 接入日），数据延迟约 2–3 天；区间长度不受 30 天限制。** 因此本切片没有「过去完整月」可补采；补采的价值在于把 08-18 起的全部日期一次拉齐并从此按日累积，第一个完整月是 2026-09。
- **缺行不等于 0**：同一门店同一天，来源对部分指标不返回行（20 天里 `CALL_CLICKS` 只有 8–13 行、曝光类 16–19 行）。本切片把「该天该门店有任一指标行、但缺某指标行」记为该指标 `availability=unavailable, completeness=unknown`，并记一条 `data_quality_events(category=source_omits_metric_rows, severity=yellow)`；不写 0，不插值。待 FBR 确认「省略 = 0」后，可用新的 `formula_version` 重新发布，旧观测不改。
- 指标键固定为现有 8 个：`BUSINESS_IMPRESSIONS_DESKTOP_MAPS / DESKTOP_SEARCH / MOBILE_MAPS / MOBILE_SEARCH`、`WEBSITE_CLICKS`、`CALL_CLICKS`、`BUSINESS_DIRECTION_REQUESTS`、`BUSINESS_FOOD_MENU_CLICKS`。曝光 = 四项之和（公式版本 `gbp_impressions_v1`）；四个行动指标分开展示，不合并。
- 日期基准：门店本地日（`date_basis=store_local`）。

### 3.2 同步与补采

- 每日同步：对试点 allowlist 内的 active 商户，按门店拉取「昨日 − 3 天 … 昨日」（GBP 数据延迟），成功批次发布后更新 head；失败只记批次与 `data_quality_events`，不改旧值。
- 补采：`POST /api/performance/backfill/preflight` → 展示分片（按月）、预计请求数、来源起点 → `POST /api/performance/backfill` 显式确认创建 `metric_sync_jobs(job_type=backfill)`；worker 逐月租约执行，可重试、可续跑、幂等（同 request_id 返回同 job）。
- 每个批次保存原始响应 `metric_source_artifacts`（sha256），观测 `content_sha256` 可从原始响应重算。

### 3.3 查询契约

`POST /api/merchants/{id}/performance/query`

```json
{ "locations": ["<merchant_location_id>"] | "all",
  "current": {"start": "2026-08-01", "end": "2026-08-31"},
  "comparison": {"mode": "previous_equal_length" | "previous_complete_calendar_month" | "custom", "start": "…", "end": "…"},
  "granularity": "day" | "week" | "month" }
```

返回：`population_hash`；每个指标的当前期总量、比较期总量、变化（按历史看板 spec §8.3：天数不同用日均，上期 0 显示「新增 +N」，任一期缺失不算变化）；逐日序列（`value | null`，null = 缺失，附原因类别）；`coverage`（已观测天数 / 期间天数）；`data_through`；`sources[]` 各自的最后成功同步时间；`backfill_notes[]`（哪些日期在何时补齐 / 修正，来自 observation `supersedes` 链）。查询只读 head，不触发同步、Agent 或付费。

## 4. V2 设计：Audit 历史与对比

### 4.1 数据对象

按数据工作空间 spec §2.4：`audit_runs`（不可变）、`audit_issue_links`。本切片不建 `audit_schedules`（周期规则留给下一切片），`trigger` 取 `MANUAL | LEGACY_IMPORT`。

### 4.2 问题身份

现有 `seo_ops.audit_report.v1` 的 `findings[].id` 由 Agent 自由生成（两份产物同一问题的 id 不同），不能作为跨次身份。规则：
- `issue_key` 只来自固定检查清单的 `check_id`（新 schema `seo_ops.audit_report.v2` 增加 `findings[].check_id`，清单版本进 `rule_version`）。
- v1 产物导入为 `rule_version=legacy`、`comparable=false`；对比页对 legacy 只并列展示，标「不可直接比较：规则版本 legacy」。
- 对比引擎：同 `rule_version` 且同 `scope_version` 才计算；新增 = 本次有、上次无；持续 = 两次都有；已核验解决 = 上次有、本次无且本次覆盖了该 check；再次出现 = 本次有、上次无、更早某次有。「已核验解决」以本次诊断证据为准，与关联 Task 是否 DONE 无关。

### 4.3 本切片的证明方式

- 导入现有两份 AUDIT_REPORT 为两条 legacy `audit_runs`；历史列表能显示它们，且显示「不可直接比较」。
- 用固定输入的 fixture（三份 v2 报告：基线、失败、复查）测试：失败 run 不成为「最近有效」、不显示得分；对比四组正确；规则版本不同返回 409 `not_comparable`。
- 不在本切片新建审计 Agent v2 配置；schema v2 只在服务端契约与 fixture 中定义，Agent 侧升级是 Audit 子项目的下一步。

## 5. V3 设计：冻结报告最小子集

- 只实现 `manual_snapshot` 与显式 `revision`：`report_snapshots`（`report_series_key = hash(kind + target_scope + period + comparison)`，`version`，`supersedes_report_id`，`population_manifest`、`data_manifest`（精确 observation id + `content_sha256`）、`render_payload_json`、hash、`as_of`、生成者）；`report_snapshot_batches`；`report_artifacts`（canonical JSON 与自包含 HTML 的字节与 sha256）。
- 生成 = 一次 V1 查询 + 冻结：先在同一读事务里取 population 与 heads，写 manifest，再渲染 payload 与 HTML，写 BLOB，最后校验 hash 后 `succeeded`。
- 查看 = 返回保存的字节，不重渲染。列表每行显示 `has_newer_source_data`（当前 heads 与 `data_manifest` 的 observation id 集合是否不同）与「数据已于 {日期} 补齐」（来自 supersedes 链）。
- 生成 v2 = 同 series 新版本，`supersedes_report_id` 指 v1；v1 与其交付记录不动。交付记录本切片只做「记录交付」（接收人、渠道、时间、备注），不发送。
- 数据库层：对 `report_snapshots` / `report_artifacts` / `metric_observations` 加 `UPDATE/DELETE` 触发器拒绝（历史看板 spec §6.4 建议），让不可变不只靠应用约定。
- 暂不做：自动月报、资格账本、容量预留、宽限期、PDF。

## 6. 最小页面（商户内，复用 `components/feedback`）

- **Performance tab**：统一筛选栏（门店 / 期间快捷项 + 自定义 / 比较模式 / 粒度）→ 指标卡四张（曝光、官网点击、电话按钮点击、路线请求；电话按钮点击注脚）→ 逐日表格（缺失显示「—」与原因，不画图表）→ 数据质量小表（来源、覆盖、最后同步、日期口径）→ 「补采」入口（预检 → 确认对话框 → 进度）。三个动作按钮只保留「同步数据」与「生成报告」；「分析这段表现」本切片不做，按钮不出现。筛选全部进 URL。
- **Audit tab**：当前状态（最近有效 / 进行中无 / 下次执行「未配置」）→ 历史列表 → 某次详情 → 对比（选择另一次；不可比时提示）。「立即诊断」「周期设置」本切片不出现。
- **报告 tab**：列表（报告、期间、数据截至、版本、AM 审阅、`has_newer_source_data`、交付）→ 查看指定版本（保存的 HTML）→ 「生成报告」（带入当前 Performance 筛选）→ 「生成修订版」→ 「记录交付」。「审核通过 / 退回」本切片做成对版本的记录字段，不做导出 PDF / PPTX。
- 每个按钮按交互契约 §11 覆盖六种情况；提交类请求带 `row_version` / hash 前置条件。

## 7. API

| 方法与路径 | 作用 |
|---|---|
| `POST /api/merchants/{id}/performance/query` | §3.3 |
| `POST /api/performance/backfill/preflight`、`POST /api/performance/backfill`、`GET /api/performance/jobs/{id}` | 补采预检、确认、进度 |
| `GET /api/merchants/{id}/audits`、`GET /api/audits/{runId}`、`GET /api/audits/{runId}/compare/{otherRunId}` | 历史、详情、对比（不可比 → 409 `not_comparable`，带原因） |
| `POST /api/merchants/{id}/reports`（manual_snapshot）、`GET /api/merchants/{id}/reports`、`GET /api/reports/{id}`、`GET /api/reports/{id}/artifact?type=html|json`、`POST /api/reports/{id}/revisions`、`POST /api/reports/{id}/review`、`POST /api/reports/{id}/deliveries` | 冻结报告最小生命周期 |

所有写入需登录操作员；同步与补采路径只读外部系统，不触碰 Core AI、Local Falcon、GBP 写接口。

## 8. 验收测试（实施计划逐条展开）

1. gold fixture：手算的 Choice Brooklyn 两门店 8 月每日 8 指标（含 3 天缺失）→ 查询 8 月 vs 7 月、任意 08-10 至 08-24 vs 上一等长期间；总量、日均比较、缺失语义、`population_hash` 稳定。
2. 补采幂等：同 request_id 二次提交返回同 job；分片失败重试不产生重复观测；head 不回退。
3. 导入现有快照：只声明 12–13 天，不补零；旧投影不变。
4. 迁移可重复：第二次执行 no-op，表计数与 payload hash 不变。
5. Audit：legacy 导入两条；fixture 三份 v2 报告的历史、最近有效、失败不覆盖、对比四组、不可比 409。
6. 冻结报告：生成 → 记录 hash → 补采改变 08-12 至 08-14 → 报告 artifact 字节与 hash 不变、`has_newer_source_data=true`、查询结果改变并有 backfill_notes → 生成 v2 → v1 仍可读、交付记录仍挂 v1。
7. 不可变触发器：对已发布观测与快照的 UPDATE / DELETE 被数据库拒绝。
8. 页面：Performance / Audit / 报告三 tab 的六种情况（正常 / 处理中 / 失败 / 结果未知 / 409 重新载入 / 返回恢复筛选）各有测试；筛选在 URL 里，刷新后一致。

## 9. 待验证（写实施计划前各做一次，全部只读）

1. **FBR 历史深度：已探测（2026-09-09，只读，经 `kubectl port-forward svc/operation-assistant-api -n uat`）。** Clinton Hill（place `ChIJaYcl…`）与 Upper West Side（place `ChIJH8iZ…`）请求 06-01 至 09-08 与 08-09 至 09-08 两种区间，均返回 08-18 至 09-06 共 20 个日期、126 / 121 行；响应形如 `{"metrics": [{"metric_date", "metric", "value"}]}`，只含现有 8 个指标键，没有 `BUSINESS_BOOKINGS` 等其他键。结论：来源起点 08-18，数据延迟 2–3 天，长区间可用，V1 的「过去完整月」改为 2026-09（见 §0）。
2. **缺行语义**：同一天部分指标无行（见 §3.1）。需向 FBR 确认省略是否表示 0；确认前按 unavailable 处理。
3. **门店时区**：`location_json` 没有时区字段，两家门店需操作员录入 `America/New_York`（Phase 1 Task 3 的前提）；确认录入入口放在商户资料页。
4. 现有 `merchant_local_falcon_reports` 能否作为 Phase 2 的扫描历史来源（本切片不用，但迁移时不得删除）。
5. 现有 `metric_*` 表的触发器 / 约束与 Phase 1 计划 Task 1 的 SQL 是否一致（迁移已跑过，需 checksum 核对）。

## 10. 判断记录

- V2 不在本切片新建审计 Agent v2：先用服务端契约与 fixture 证明追溯与对比逻辑，Agent 侧升级放到 Audit 子项目，避免本切片同时改 Core AI 配置。
- 看板图表延后：三条证明靠表格与数字即可验收，图表是数据模块下一切片（复用 Phase 1 计划 Task 11–13）。
- 试点只放 Choice Brooklyn：它是唯一同时有 GBP 快照、Local Falcon 历史和两份 Audit 产物的商户；George 在 GBP 连接后自动进入同一路径。

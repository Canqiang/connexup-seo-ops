# SEO Ops Audit 报告工作区与调度设计

**日期：** 2026-09-03

**状态：** 已确认；实现限定于 `codex/audit-report-workspace` 隔离分支

**仓库：** `/Users/xander/git_repo/connexup-seo-ops`

## 1. 摘要

在 SEO Ops 中建立第一等、门店级、可版本化的 Audit 领域。运营人员可以主动触发 Audit，也可以为每个门店配置自动周期。两种触发方式使用同一套执行、验证、持久化与展示管道。

每次成功的新 Audit 产生一个不可变 canonical v2 报告版本。页面以该结构化 JSON 为权威数据源，按总分、等级、维度、Criterion、证据、问题、限制和建议行动展示；历史 legacy 报告作为明确受限的只读版本呈现。PDF、HTML 和 JSON 均从同一个已验收版本导出，不重新运行 Audit，也不依赖会过期的外部 SAS URL。

自动 Audit 只创建报告和变化提醒，不自动创建正式任务。运营人员需要在报告中显式选择问题并生成优化 Plan 草案；正式任务仍遵守现有人工确认边界。

Audit 的最小主体是门店。商户页面只汇总其门店的最新成功报告、风险和新鲜度。品牌或共用官网问题带有共享作用域，在商户汇总中去重，不被伪装成多个独立门店问题。

## 2. 当前系统事实

当前代码中存在两条互相断开的 Audit 路径。

### 2.1 通用分析 Run

- `POST /api/merchants/{merchant_id}/runs` 使用通用 `COREAI_AGENT_ID`。
- Scheduler 每 30 秒轮询进行中的 Core AI Run。
- 完成后先保存 `runs.report_text`，再尝试将整个输出解析为 `seo_ops.audit_report.v1`。
- 解析失败不会使通用 Run 失败；页面继续以 Markdown 显示历史报告。
- `auto_run_interval_days` 每小时检查一次，但触发的是通用分析，不是独立 Audit。
- 通用输入同时要求报告正文和 fenced Plan JSON，而 Audit v1 解析器要求整个输出是单一 JSON 对象，两个契约天然冲突。

### 2.2 SEO Artifact Audit

- `merchant_seo_artifacts` 已能保存 `KEYWORD_SET`、`AUDIT_REPORT` 和 `RANKING_REPORT`。
- Audit Artifact 使用专用 `COREAI_AUDIT_AGENT_ID`。
- 当前没有第一等手动 Audit API、Audit 历史 API或独立 Audit Policy。
- 页面没有展示 Artifact Audit。
- SEO Target 状态只读取所选关键词 Artifact 同一 cycle 内的 Audit，因此其他已验收历史 Audit 可能存在于数据库但不可见。

### 2.3 现有 Audit v1

`seo_ops.audit_report.v1` 适合呈现结论型报告，支持：

- 标题与摘要；
- evidence mode；
- area、severity、observation、evidence、recommendation；
- limitations 与 next actions。

它不支持代表性完整 Audit 中的：

- 总分和 Grade；
- 多个加权维度；
- 稳定 Criterion ID；
- 0–4 分与 N/A；
- 分类、权重、适用性和结构化证据。

v1 使用严格 `extra="forbid"` 是正确的安全边界。新结构通过版本化 v2 和显式适配器实现，不放宽 v1。

### 2.4 外部 HTML Artifact

用户提供的 Azure Blob HTML 使用短期 SAS URL，评审时已经返回 HTTP 403。此类 URL 不能作为长期报告地址、数据库权威字段或页面 iframe 的持久来源。

## 3. 产品目标

1. 让运营人员从商户工作区看到每个门店的最新成功 Audit、当前运行状态、自动策略和历史版本。
2. 让手动和自动 Audit 共用同一条可验证、可恢复、幂等的执行管道。
3. 保存不可变 Audit 版本，并能和任一历史版本进行可复现比较。
4. 原生展示完整评分体系，不向运营人员暴露原始 JSON 或超长验证错误。
5. 从同一个已验收版本生成客户版 PDF、离线 HTML 和内部 JSON。
6. 将报告与正式任务分开；只有显式运营动作才能生成 Plan 草案或任务。
7. 迁移可验证的 v1 Snapshot 和历史 Audit Artifact，不删除或伪造旧数据。
8. 保留真实数据边界：缺失、过期、N/A 和无法确认必须明确显示，不能补零或猜测。

## 4. 非目标

- 不修改、部署或提交 Core AI、FBR、GBP 或 Local Falcon 服务。
- 不在自动 Audit 后自动生成、审批或执行正式任务。
- 不自动修改 GBP、官网、菜单、Schema、评论或第三方目录。
- 不把 Audit 建设扩大成通用 Report Center、Performance 历史仓库或 Local Rank 报告平台。
- 不把历史 Markdown 推断或改写成结构化评分。
- 不把外部 HTML 当作可信可执行代码。
- 不在第一版提供商户外部登录或公开分享链接。
- 不为缺失数据生成虚构分数、证据、时间或来源。

## 5. 已确认的产品决策

### 5.1 报告主体

- Audit 以门店为最小主体。
- 主体必须绑定内部 `merchant_id` 和稳定的 GBP location identity。
- 有 Place ID 时一并绑定并冻结；不能仅凭商户名称或地址模糊匹配。
- `website_url` 可以为空。没有官网时，可验证的“没有官网”本身可以成为一个 Criterion 事实；依赖页面抓取的其他 Criterion 必须明确为不适用或证据不可用。
- 多门店必须分别 Audit 和评分。
- 商户层只汇总各门店最新成功版本，不生成未经定义的商户总分。

### 5.2 共享问题

每个 Criterion 结果必须带作用域：

- `LOCATION`：仅影响当前门店；
- `WEBSITE_SHARED`：影响共用官网；
- `MERCHANT_SHARED`：影响同一商户的多个门店。

商户汇总按 `(scope_type, scope_key, criterion_id)` 去重共享问题。门店报告仍展示该问题，但明确标记为共享问题。

### 5.3 报告与任务

- 手动和自动 Audit 都产生报告；自动 Audit 还按规则产生站内变化提醒。两者都不自动创建 Plan 或正式任务。
- 报告中的 recommendation、recommended actions 或选中 Criterion 不是正式任务。
- 运营人员点击“根据已选问题生成计划”后，系统创建独立 Plan 草案。
- Plan 审批和正式 Task materialization 继续使用现有人工确认流程。
- 重复 Audit 不会自动重复创建任务。

### 5.4 页面结构

采用已确认的方案 B：

- 商户页显示每个门店的 Audit 摘要、最新状态和入口；
- 复杂报告进入专用 Audit 工作区；
- 工作区使用固定高度的维度栏、Criterion 列表和证据/行动区域；
- 维度与 Criterion 在内部滚动，不把整个商户页面无限拉长；
- 历史与版本比较属于同一工作区，不另建第一版全局报告中心。

### 5.5 导出

- 默认导出格式是客户版 PDF。
- 同一版本还可以导出自包含 HTML 和内部 JSON。
- 导出绑定一个已验收 `audit_version_id` 和一个固定 `template_version`。
- 导出不触发新 Audit，也不读取“当前最新数据”替换原版本内容。

## 6. 总体架构

```text
运营手动触发 ─┐
              ├─> Audit Run Service ─> Core AI Audit Agent
门店自动策略 ─┘          │                    │
                         │                    v
                         │             严格 Audit v2 JSON
                         │                    │
                         v                    v
             audit_runs/attempts/events Validator + frozen Rubric
                                              │
                                              v
                                    不可变 audit_version
                                      │       │       │
                                      v       v       v
                                  原生 UI    比较    导出资产
                                      │
                                      v
                              人工选择问题生成 Plan 草案
```

Audit 是独立领域，但复用现有基础设施：

- operator authentication；
- Core AI server-side client；
- SQLite transaction helper；
- FastAPI lifespan 与独立 scheduler task；
- React shell、商户路由和现有 Plan/Task 人工确认边界。

Audit 不复用通用 `runs` 的输出契约或 merchant-wide running lock。

历史迁移走另一条只读入口：legacy source registry → 显式版本适配/校验 → `audit_versions` 联合类型。它不经过 Core AI、不创建 Audit Run/Attempt，也不为缺失字段补造 Rubric、Criterion 或评分。

第一版遵守仓库现有部署边界：一个 UAT application replica、一个 uvicorn worker、一个挂载持久卷上的 SQLite 数据库。Lease、唯一约束和 fencing 用于同一数据库内的并发任务与进程重启恢复，不宣称支持多 Pod。扩到多副本前必须先迁移到所有副本共享且具备正确事务语义的数据库/队列，再重新完成 dispatch 与 scheduler UAT。

## 7. 领域模型

### 7.1 `audit_subjects`

表示一个稳定的门店 Audit 主体。

核心字段：

- `id`；
- `merchant_id`；
- `merchant_location_id`：共享 `merchant_locations` 的稳定内部 FK；
- `current_identity_manifest_sha256`；
- `display_name`；
- `website_url`，可空；
- `status`：`active` 或 `archived`；
- `identity_generation`；
- `created_at`、`updated_at`。

约束：

- `merchant_location_id` 唯一，且和 `merchant_id` 形成受数据库检查的同商户关系；
- 共享 `merchant_locations.id` 是 Audit 的稳定内部 location identity；
- `merchant_gbp_profiles.id` 不能作为稳定键，因为当前同步会删除并重建这些行；
- 外部 GBP location ID、Place ID 和 FBR ID 不能作为 Subject 主键；
- Place ID 或 GBP scope binding 变化必须来自共享 location/source binding/alias 事件，Audit 不能无痕覆盖；
- 商户归档时主体进入 archived，历史版本保留。

`audit_subject_events` 以 append-only 方式保存 created、identity_projection_changed、website_changed、archived 和 restored。每条事件保存前后 Audit generation、引用的共享 location lifecycle event、GBP source-scope binding generation、Place alias/evidence generation、规范化 identity manifest/hash、原因、operator/system actor 与时间，不复制或重写共享 alias 历史。

Audit 不创建第二套门店主数据。它硬依赖 Performance History foundation 已部署并完成全量回归：复用 `api/app/migrations.py`、`schema_migrations(version, checksum, applied_at)`、整数键 `merchant_locations`、`source_scopes`/`source_scope_bindings`、`merchant_location_aliases` 和 `merchant_location_status_events`。Audit migration 从该 foundation 的 `0001_performance_history.sql` 之后编号；不能创建第二个 migration ledger、另一组 location/binding/alias 表，也不能把现有 `merchant_gbp_profiles.id` 或名称/地址当稳定键。

Subject 由共享 Location Registry 投影创建，不由名称搜索临时生成：

1. GBP/FBR 同步成功并读回 exact location identity；
2. 共享 resolver 按有效期 bindings/aliases 返回唯一 `merchant_location_id` 与 generation evidence；
3. 同一事务 upsert Audit Subject projection，并在 identity manifest hash 变化时追加 Subject event、递增 Audit generation；
4. identity 未变只更新非身份展示字段；
5. 不能唯一解析时写入共享 quality/unbound 记录，不创建或激活 Subject，也不允许触发 Audit；
6. 归档/恢复商户或门店时同步归档/恢复其 Subject，但不改写历史 Version。

Identity generation 变化或归档必须与 Audit projection 更新处于同一事务：

- queued Run 立即转 `blocked`；
- 已 dispatch 的 Run 记录 `invalidated_by_subject_event_id` 并继续追踪远端到可确认状态，但永远不能验收为新 Version；
- policy `last_success_version_id` 对当前 generation 置空，当前 generation head 不存在；旧 generation head 只供历史读取；
- identity 恢复为 active 且来源 ready 后，policy 可以从当前时间计算新的 due；不能把旧 generation head 重新设为 current。

### 7.2 `audit_policies`

保存门店级自动 Audit 策略。

核心字段：

- `audit_subject_id`，唯一；
- `enabled`；
- `cadence_days`；
- `timezone`；
- `schedule_anchor_at`；
- `next_due_at`；
- `last_scheduled_for`；
- `last_success_version_id`；
- `updated_by`、`updated_at`；
- `version`，供 UI、scheduler、验收与 identity lifecycle 的所有写入做并发 CAS。

第一版 UI 提供关闭、7 天、30 天、90 天和自定义天数。存储使用明确时区与 anchor；下一次发生时间从最近成功验收和策略计算，不以最近失败尝试为锚点。

手动 Audit 成功后视为完成一次有效 Audit：若 policy enabled，在 Version 验收事务中将 `next_due_at` 重算为 accepted time 加一个 cadence 后的下一个合法本地 anchor，避免刚手动刷新又立即自动运行。手动失败不移动 due。修改策略从新的 anchor 计算未来 occurrence，不自动补跑过去遗漏的周期。

Policy 的每个 writer 都必须在同一事务先读取当前 `version`，再以 `UPDATE ... WHERE id=? AND version=?` 修改并令 `version=version+1`：UI PUT 冲突返回 409 并要求刷新；scheduler、Version acceptance 和 identity reset 冲突时回滚本次短事务、重新读取并有界重试。任何系统写都不能绕过 version，避免稍后到达的旧 UI expected-version 覆盖 `next_due_at`、`last_scheduled_for` 或 `last_success_version_id`。

### 7.3 `audit_runs`

表示一次手动或自动 Audit 意图。

核心字段：

- `id`；
- `run_key`：全局唯一 UUID/ULID；
- `audit_subject_id`；
- `trigger_kind`：`manual` 或 `scheduled`；
- `request_id`；
- `retry_of_run_id`，operator 对 terminal Run 重试时使用；
- `scheduled_for`，手动为空；
- `occurrence_key`，自动 Run 使用；
- `status`：`queued`、`blocked`、`dispatching`、`running`、`validating`、`unknown`、`succeeded`、`failed` 或 `abandoned`；
- `current_attempt_id`，可空；
- `attempt_count`、`retry_at`；
- `input_manifest_json`、`input_manifest_sha256`；
- `subject_identity_generation`、`subject_identity_manifest_sha256`；
- `invalidated_by_subject_event_id`，可空；
- `error_code`、`error_summary`；
- `created_by`、`created_at`、`started_at`、`finished_at`。

手动 Run 的 `created_by` 是已认证 operator；自动 Run 使用固定 system actor `system:audit-scheduler`，不能伪装成人工操作。

唯一约束：

- `(audit_subject_id, request_id)` 唯一；
- `(audit_subject_id, occurrence_key)` 对非空 occurrence 唯一；
- `trigger_kind` 使用数据库 CHECK：`manual` 必须有非空 request ID，且 `scheduled_for`/`occurrence_key` 均为空；`scheduled` 必须有非空 request ID、`scheduled_for` 和 `occurrence_key`；
- 数据库 partial unique index `UNIQUE(audit_subject_id) WHERE status IN ('queued','dispatching','running','validating','unknown')` 保证一个主体最多一个 active Run，而不是只依赖应用层查询。

Active state 为 `queued`、`dispatching`、`running`、`validating` 和 `unknown`。`unknown` 会继续占用主体级 Audit lock，直到可靠对账或人工放弃，避免不确定远端执行与新 Audit 并发。其他工作类型不受 Audit lock 影响。

`queued` 必须已经拥有非空、hash 已验证的冻结 input manifest。Worker 的 claim SQL 必须同时检查 Run status、manifest hash、无非 terminal Attempt 和当前 lease 条件；不存在“queued 但仍等待异步 preflight”的可派发窗口。

### 7.4 `audit_run_attempts`

表示一个 Audit Run 的一次远端执行尝试。Run 是业务意图，Attempt 才绑定具体 Core AI Run；重试绝不覆盖上一 Attempt。

核心字段：

- `id`；
- `audit_run_id`；
- `attempt_number`；
- `retry_of_attempt_id`，首轮为空；
- `status`：`dispatching`、`running`、`validating`、`unknown`、`succeeded`、`failed` 或 `abandoned`；
- 非空 `dispatch_idempotency_key`；
- `coreai_run_id`，收到 acknowledgement 后写入；
- `dispatch_started_at`、`acknowledged_at`；
- `lease_owner`、单调递增 `lease_generation`、`lease_expires_at`；
- `error_code`、`error_summary`；
- `created_at`、`started_at`、`finished_at`。

约束：

- `(audit_run_id, attempt_number)` 唯一；
- 非空 `retry_of_attempt_id` 唯一，保证一个失败 Attempt 只产生一个后继；
- 非空 `coreai_run_id` 全局唯一；
- `dispatch_idempotency_key` 全局唯一，并确定性派生自 namespace + 全局唯一 Run key + attempt number + input manifest hash；
- 数据库 partial unique index `UNIQUE(audit_run_id) WHERE status IN ('dispatching','running','validating','unknown')` 保证一个 Run 同时最多一个非 terminal Attempt；
- 失败 Attempt 保持 terminal，不从 `failed` 改回 `dispatching`；重试创建新的 Attempt。

### 7.5 `audit_run_events`

Append-only 记录每次状态变化、lease claim、dispatch acknowledgement、retry scheduling、validation outcome 和 operator reconciliation。

事件只保存安全摘要、状态和引用，不保存 access token、SAS query、完整 Core AI transcript 或未清洗异常堆栈。

### 7.6 `audit_versions`

保存原生验收报告与可被严格识别的历史报告。它是受约束的联合类型，不能为旧数据伪造新 Run、Attempt、Rubric 或分数。

核心字段：

- `id`；
- `audit_subject_id`；
- `version_kind`：`native_v2`、`legacy_v1` 或 `legacy_artifact`；
- `audit_run_id`，原生 v2 必填且唯一，legacy 为空；
- `audit_run_attempt_id`，原生 v2 必填、唯一且必须是该 Run 的成功 Attempt，legacy 为空；
- `legacy_source_id`，legacy 必填且唯一，原生 v2 为空；
- `version_number`，主体内递增；
- `subject_identity_generation`；
- `subject_snapshot_json`；
- `subject_snapshot_sha256`；
- `schema_version`；
- `producer_schema_version`，legacy 可空；
- `producer_result_json`、`producer_result_sha256`，legacy 可空；
- `adapter_version`，原生 v2 时为 `native-v2`；
- `rubric_version`，未评分 legacy 可空；
- `rubric_sha256`，未评分 legacy 可空；
- `scoring_algorithm_version`，未评分 legacy 可空；
- `payload_json`、`payload_hash_mode`、`payload_sha256`；第一版 hash mode 固定为 `rfc8785-jcs`；
- `raw_source_sha256`，legacy 必填，原生仅在有显式外部来源适配器时使用；
- `input_manifest_sha256`，legacy 可空；
- `evidence_mode`，未评分 legacy 可空；
- `evidence_coverage`，canonical decimal text，未评分 legacy 可空；
- `score_status`：`scored`、`incomplete` 或 `unscored_legacy`；
- `total_score`，可空的 canonical decimal text，不使用 SQLite REAL；
- `grade`，可空；
- `comparison_base_version_id`，可空；
- `producer_agent_id`，legacy 可空；
- `producer_coreai_run_id`，legacy 可空；
- `producer_provenance_json`，legacy 可空；
- `report_at`，来自可信原始记录的报告生效时间；
- `ingested_at`，进入新 Audit 领域的时间；
- `accepted_at`。

约束：

- `(audit_subject_id, version_number)` 唯一；
- 所有 `payload_sha256` 都按声明的 RFC 8785 JCS 对 `payload_json` 复算：原生/完整适配行的 payload 是 canonical v2，`unscored_legacy` 的 payload 是经已知 schema 验证且字段不改写的 legacy envelope；legacy 原始输入 bytes 的身份另由必填 `raw_source_sha256` 保留；
- `native_v2` 必须绑定本地 Run、成功 Attempt、producer v2、冻结 Rubric 与 scoring algorithm，`legacy_source_id` 必须为空；
- `legacy_v1` 和 `legacy_artifact` 必须绑定 `audit_legacy_sources`，本地 Run/Attempt 必须为空；不得为了满足模型而补建虚假执行记录；
- 没有可验证评分结构的 legacy Version 使用 `score_status=unscored_legacy`，其 Rubric、scoring algorithm、total score 和 Grade 均为空；
- `legacy_artifact` 只有在显式适配器能完整验证 Criterion identity、Rubric hash 和评分时才允许保留 `scored` 或 `incomplete`；否则同样为 `unscored_legacy`；
- `unscored_legacy` 的 evidence mode/coverage、comparison base 与 producer 字段为空；其 `payload_json` 是经已知 legacy schema 验证但不改写字段的 envelope，JCS hash 对应该保存对象；
- `report_at` 只取可信来源时间；无法确定时该 Version 不能成为 current head；`ingested_at` 或迁移时间不能冒充报告时间；
- 原生 v2 的 `report_at` 等于服务端验收提交时间；legacy 的 `report_at` 取不可变 source record 的原始报告/完成时间，并在 provenance 中记录时间来源；
- Version、producer result、payload、score、grade、rubric、subject snapshot 与 provenance 一经插入不得 UPDATE 或 DELETE；
- 原生 Run 失败或验证失败不能创建 Version；legacy 来源未确认、schema 未知或 payload hash 冲突不能创建 Version。

判别矩阵如下；数据库 CHECK、FK/unique index 与验收代码共同拒绝矩阵外组合：

| Version 形态 | Run / Attempt | Legacy source | Payload | 允许的 score status | Rubric / Criterion rows | Compare / Plan | Export |
|---|---|---|---|---|---|---|---|
| `native_v2` | 必填，Attempt succeeded | 必须为空 | canonical v2 | `scored` / `incomplete` | 必填且完整 | 按兼容性开放 | PDF / HTML / JSON |
| `legacy_artifact` 完整适配 | 必须为空 | 必填且唯一 | canonical v2 + preserved raw hash | `scored` / `incomplete` | 必填且完整 | 按兼容性开放 | PDF / HTML / JSON |
| `legacy_artifact` 未评分 | 必须为空 | 必填且唯一 | 已知 legacy envelope | `unscored_legacy` | 必须为空 / 无 rows | 禁止 | JSON；HTML/PDF 需注册 renderer |
| `legacy_v1` | 必须为空 | 必填且唯一 | v1 envelope | 仅 `unscored_legacy` | 必须为空 / 无 rows | 禁止 | JSON；HTML/PDF 需注册 renderer |

所有具有 exact current generation 和可信 `report_at` 的行都可以作为只读 head 候选。若 `report_at` 完全相同，先比较 score tier（`scored` > `incomplete` > `unscored_legacy`），再比较 provenance tier（`native_v2` > `legacy_artifact` > `legacy_v1`），最后用稳定 Version ID 破平局；因此未评分 `legacy_artifact` 也有确定顺序。

### 7.7 `audit_criterion_results`

从不可变、含稳定 Criterion IDs 的 canonical payload 投影出可查询的 Criterion 索引。`legacy_v1` 和未完整适配的 `legacy_artifact` 不创建 Criterion rows，也不从自由文本猜测 Criterion。

核心字段：

- `id`；
- `audit_version_id`；
- `criterion_id`；
- `dimension_id`、`category_id`；
- `scope_type`、`scope_key`；
- `applicability`；
- integer `score`、`max_score`、`weight_basis_points`；
- `severity`；
- `observation`；
- `recommendation`；
- `evidence_count`；
- `content_sha256`。

`(audit_version_id, criterion_id)` 唯一。索引行和 payload 在同一验收事务中生成；DB trigger 禁止 UPDATE/DELETE。Version readback 必须从 canonical payload 重建排序后的投影 hash，并与所有 rows/content hashes 核对；任一不一致使验收回滚或后续读取失败关闭，不能让 UI 查询投影偏离或改写 canonical 报告。

### 7.8 `audit_subject_heads`

保存每个主体、每个 identity generation 的最新成功 Version 指针。

- 验收或迁移事务插入 Version、适用的 Criterion rows，并以 compare-and-set 更新 head；
- `(audit_subject_id, subject_identity_generation)` 唯一；
- head 的 compare-and-set 比较冻结的 `(report_at, score tier, provenance tier, version ID)` 全序，而不是比较插入或迁移时间；
- failed、blocked、unknown 或 abandoned Run 不改变 head；
- `GET latest` 只读取 Subject 当前 generation 的 head，不把旧 generation 的成功报告冒充当前报告；旧版本仍在历史中可见。

创建每个 canonical Version 时，在同一事务中确定并冻结 `comparison_base_version_id`：正常验收从同 Subject、同 identity generation、排序键严格早于目标 Version 的全部既有 Versions 中，跳过 `unscored_legacy` 和不兼容项，选择满足相同 Rubric hash、scoring algorithm 与完整 Criterion ID 集合的最大排序键。初始 legacy migration 则使用第 17 节冻结批次的两阶段预计算，把同批中排序更早的兼容候选也纳入。搜索不会因中间 head、未评分或不兼容版本而停止；没有候选时写空。后续增量 backfill 永不重写既有 Version 的基线。

### 7.9 `audit_assets` 与 `audit_exports`

`audit_assets` 保存输入证据附件和来源 Artifact 的内部对象元数据：

- `id`；
- 可空 `audit_run_id` 与可空 `legacy_source_id`，二者必须恰好一个非空；
- `asset_kind` 与 `status`：`pending`、`ready` 或 `failed`；
- 内部 object key；
- MIME、大小、SHA-256；
- source kind；
- created_at、ready_at。

只有内部对象 bytes 已写入、重新读取、MIME/大小/hash 验证一致后，Asset 才能以 CAS 从 `pending` 标记 `ready`。对象 key 使用 content-addressed 或 write-once 语义。DB trigger 禁止 ready Asset 的 object key、MIME、大小、hash 被 UPDATE 或 DELETE。

`audit_version_assets` 是验收或迁移事务创建的不可变连接表，保存 `audit_version_id`、可空 `audit_criterion_result_id`、可空 `evidence_id` 与 `audit_asset_id`。原生 canonical Evidence 必须同时绑定 Criterion 与 Evidence ID，并且只能引用同一 Run 的 ready Asset；legacy source-level 附件允许两者都为空，但只能引用从该 Version 唯一 `legacy_source_id` 内部化、读回并校验 hash 的 ready Asset。required Evidence Asset 未 ready 时不得验收。连接行和关联 ready Asset 均受 UPDATE/DELETE trigger 保护，避免 Version Evidence bytes 漂移。

`audit_exports` 保存导出任务及冻结结果：

- `audit_version_id`；
- `format`：`pdf`、`html` 或 `json`；
- `request_id`；
- `request_payload_sha256`，覆盖 format、locale、template、renderer 和 comparison base 的 canonical request；
- `locale`；
- `template_version`；
- `renderer_version`；
- `comparison_base_version_id`，客户版包含变化时固定；
- 非空 `comparison_base_key`：无基线使用 `none`，有基线使用规范化 Version ID；
- `status`：`queued`、`running`、`ready` 或 `failed`；
- `current_attempt_id`、`attempt_count`；
- 内部 object key；
- MIME、大小、SHA-256；
- created_by、created_at、completed_at；
- 安全错误码与摘要。

`(audit_version_id, request_id)` 唯一，`(audit_version_id, format, locale, template_version, renderer_version, comparison_base_key)` 也唯一。相同 request ID 只有 request payload hash 相同才是 replay；hash 不同返回稳定冲突，不能静默返回另一种导出。Ready Export 的内容元数据不可修改；Export 只有通过 bytes readback gate 后才能进入 ready。使用非空 key 避免 SQLite 对 NULL 唯一值允许重复。

`audit_export_attempts` 为每次 renderer 执行保存 `export_id`、attempt number、可空 retry parent、retry `request_id`、status、lease owner/generation/expiry、错误和时间。`(export_id, request_id)` 唯一。Attempt terminal 后不可修改；一个 Export 同时最多一个 active Attempt。普通 Export POST 的 request-id replay 只读回原 Export，绝不隐式启动第二次 render；失败后只有显式 retry command 才创建新 Attempt。

### 7.10 `audit_rubric_versions`

保存不可变评分规则，而不是只存一个可被复用或覆盖的版本字符串：

- `rubric_version`；
- canonical `rubric_json` 与 SHA-256；
- `scoring_algorithm_version`；
- Criterion identity、dimension/category、适用 scope、max score 与整数 basis-point weight；
- coverage、required source、Grade threshold 与 rounding 规则；
- created_at。

Rubric 行插入后不得更新或删除。Audit Version 同时引用 `rubric_version` 和 `rubric_sha256`；字符串相同但 hash 不同视为配置冲突并停止验收。

### 7.11 `audit_legacy_sources`

记录历史来源与迁移结果：

- `source_kind`、`source_id` 与 source payload hash；
- `binding_status`：`accepted`、`unbound` 或 `rejected`；
- adapter/version、reason code、created_at。

`(source_kind, source_id)` 唯一；相同 source ID 但 payload hash 改变视为来源冲突，不覆盖旧记录。该表既保证迁移幂等，也承载 unbound legacy 清单。成功迁移关系由 `audit_versions.legacy_source_id` 单向、唯一地指回来源，避免两表互相持有可漂移的关联。

### 7.12 `audit_change_alerts`

自动 Audit 验收后，与上一可比较 Version 生成站内变化提醒：

- `audit_version_id`，唯一；
- `comparison_base_version_id`，可空；
- `severity`；
- 冻结 summary JSON 与 SHA-256；
- `status`：`unread` 或 `read`；
- created_at、read_by、read_at。

第一版只提供 SEO Ops 站内 badge/列表，不发邮件、短信或第三方通知。首次报告生成、Rubric 不可比或 identity generation 变化也可以生成信息型提醒，但必须说明“无可比较基线”；没有变化时不创建提醒。读取和确认提醒不改变 Audit Version。

### 7.13 `audit_plan_selections` 与交付 outbox

Audit 领域只保存不可变的选择命令：

- `id`；
- `audit_version_id`；
- 排序后的 Criterion IDs JSON 与 selection SHA-256；
- `request_id`；
- `request_payload_sha256`，覆盖 Version ID 与排序去重后的 Criterion IDs；
- `plan_idempotency_key`，由 namespace + Version ID + request ID + selection hash 确定性生成；
- operator 与 created_at。

`(audit_version_id, request_id)` 与 `plan_idempotency_key` 均唯一；相同 request ID 只有 payload hash 相同才返回既有 Selection，不同 Criterion 集返回稳定冲突。同一 selection hash 可以在不同时间生成新的 Plan 草案，但每次都必须由新的显式 operator request 发起。Plan 正文和生命周期属于独立、可修订的 Plan 领域。

跨 Plan 领域使用持久化 outbox，而不是在 HTTP 请求中“先创建 Plan、稍后补本地关联”：

- 创建 Selection 的同一事务同时创建唯一 `audit_plan_delivery`，初始为 `queued`；
- delivery 保存 current attempt、`queued`/`dispatching`/`unknown`/`linked`/`failed` projection 与安全错误，Attempt/event 记录 append-only；
- worker 向 draft-first Plan API 传递同一 `plan_idempotency_key`、Version hash 和 selection hash；Plan API 必须支持按该 key 幂等创建和读回；
- timeout 或 acknowledgement 未落库时进入 `unknown`，只按原 key 对账，不能换 key 重建；
- 读回的 Plan draft 必须逐项匹配 Audit Version、Criterion IDs 与 selection hash，随后插入不可变、双向唯一的 `audit_plan_link(selection_id, plan_id, plan_revision_id, readback_sha256)` 并把 delivery 标为 `linked`；
- 孤儿 Plan 可通过 idempotency key 被下一次 reconciliation 找回；没有通过 readback 的 Plan 不在 Audit UI 中宣称已生成。

当前通用 Run 会在 Plan 审批前创建受锁 Task 行，不能用于本入口。Audit Plan endpoint 只能接入真正的 draft-first Plan 服务：先创建 Plan/Revision 草案，运营确认时再原子 materialize Tasks。上述幂等 create/readback 契约未通过 UAT 前，Audit 报告和导出可以上线，但“生成计划”必须保持不可用并显示明确原因，不能退化为预建 Task。

## 8. Producer Result 与 `seo_ops.audit_report.v2` 契约

必须区分 Agent 生成结果与服务端验收报告：

- Core AI Audit Agent 返回严格的 `seo_ops.audit_result.v2` producer result；
- SEO Ops 根据冻结 Subject、Rubric 与输入 manifest 验证并组装 `seo_ops.audit_report.v2` canonical report；
- 原生页面、比较、导出和 Version hash 只使用 canonical report；
- `legacy_v1` 保留并返回类型化的只读 legacy envelope，不冒充 canonical v2；只有显式适配且完整通过 v2 契约的 `legacy_artifact` 才进入 canonical v2 能力路径。

Audit Agent 输出只允许：

- 一个 JSON object；或
- 一个内容恰好为单一 JSON object 的严格 fenced `json` block。

不允许在对象前后混入 Markdown、Plan、解释或第二个 JSON 文档。

Producer result 只包含主体回声、结论和原始 Criterion 判断。它不能决定 Rubric weight、max score、dimension/category、scope key、总分或 Grade。SEO Ops 必须用冻结 Rubric 和 Subject 生成这些权威字段。

验收后的 canonical payload 包含：

```json
{
  "schema_version": "seo_ops.audit_report.v2",
  "subject": {
    "merchant_id": "3",
    "gbp_location_id": "locations/123",
    "place_id": "ChIJ...",
    "location_name": "Choice Brooklyn – Upper West Side",
    "address": "2040 Broadway, New York, NY 10023, US",
    "website_url": "https://www.choicebrooklyn.com/"
  },
  "report": {
    "title": "Local SEO Audit",
    "summary": "Evidence-bounded summary",
    "language": "en-US",
    "rubric": {
      "version": "2026.08",
      "sha256": "...",
      "scoring_algorithm_version": "weighted-v1"
    },
    "evidence_mode": "CONNECTED_AND_CONFIRMED",
    "scores": {
      "status": "scored",
      "total": "46.20",
      "grade": "F",
      "coverage": "0.82",
      "dimensions": []
    },
    "criteria": [],
    "limitations": [],
    "recommended_actions": []
  }
}
```

服务端根据冻结 Rubric 和 producer Criterion results 计算总分、维度分、coverage 与 Grade。Agent 可以返回声明值供交叉检查，但声明值不是权威数据；不一致时拒绝验收。

Canonical JSON 使用 RFC 8785 JSON Canonicalization Scheme 后计算 SHA-256。分数计算使用十进制定点数：Criterion score 为整数，weight 用整数 basis points，归一化和总分使用 Rubric 指定公式，最终展示值按 `ROUND_HALF_UP` 保留两位。禁止用二进制浮点结果直接生成 hash 或 Grade。

### 8.1 Criterion

Producer result 中每个 Criterion 必须包含：

- 稳定 `criterion_id`；
- applicability；
- 0–4 分或 null；
- observation；
- 至少一个结构化 Evidence，除非 applicability 说明无法取证；
- recommendation；
- 可选的声明 severity。

验收时，服务端从冻结 Rubric 注入 dimension、category、max score、weight 和规范化 severity，并依据冻结 Subject 生成 scope type 与 scope key。`LOCATION` 使用稳定 merchant location ID + Audit identity generation，`WEBSITE_SHARED` 使用冻结 website URL 的规范化 registrable domain，`MERCHANT_SHARED` 使用内部 merchant identity；不接受 Agent 自报的 scope key。

Applicability 取值：

- `APPLICABLE`：必须有数值 score 和 Evidence；
- `NOT_APPLICABLE`：score 为 null，必须说明原因；
- `EVIDENCE_UNAVAILABLE`：score 为 null，必须说明缺少来源、时间或权限。

`EVIDENCE_UNAVAILABLE` 不能等同 0 分或 `NOT_APPLICABLE`。

Preflight 从冻结 Rubric 生成排序后的 expected Criterion ID 集合并写入 input manifest。Producer 必须对该集合逐项、恰好一次返回结果：duplicate、unknown extra 或 missing ID 都使整个输出验证失败。服务端不会替 Agent 为缺失项补造 `EVIDENCE_UNAVAILABLE`；若无法判断，Producer 必须显式返回该 applicability、原因和允许的 Evidence handles。Possible points、coverage 和 Grade 只从完整、已验证的集合计算。

### 8.2 Evidence

Producer Evidence 只允许返回：

- input manifest 中存在的 opaque `evidence_handle`；
- concise fact；
- 可空、受边界验证的 JSON pointer/page/region locator。

它不能自报 source kind/reference、observed time、freshness、source hash 或 Asset identity。验收时服务端用 handle 精确解析冻结 manifest/ready Asset，并注入 canonical Evidence：

- `evidence_id` 与 opaque handle；
- source kind 与安全 source reference；
- observed/captured time；
- source/asset SHA-256；
- concise fact；
- 可空 ready Asset reference；
- 服务端根据 captured time 与冻结 Rubric 计算的 freshness state。

Handle 不存在、属于其他 Run/Subject、hash 不一致、locator 越界或 required Asset 未 ready 时拒绝验收。这样 accepted Evidence 的来源与时间不依赖模型自报。

不允许把 SAS token、Authorization header、cookie 或 access token 放入 payload。

### 8.3 评分与完整度

- 服务端只使用 Rubric 中声明为适用且 Evidence 有效的 Criterion 计算得分。
- 每个 Dimension 返回 earned points、possible points、normalized score 与 coverage。
- Rubric 定义 `minimum_coverage_for_grade` 和 required dimensions。
- 未达到 Grade 条件时，`score_status=incomplete`，Grade 显示“数据不完整”，即使可以展示部分分数。
- 不补零、不插值、不根据历史版本推断当前分数。

### 8.4 来源适配器

外部 FBR/Agent rich Audit JSON 只能通过显式版本适配器进入 v2：

- 适配器按 source schema/version 注册；
- 未知结构拒绝，不进行宽松 key 猜测；
- 原始 canonical JSON 保存 SHA-256；
- 适配后重新验证主体、Criterion、Evidence 和评分；
- 适配器版本写入 trusted provenance。

### 8.5 有界输入与输出

第一版服务端硬限制：

- producer JSON 最大 2 MiB，accepted canonical JSON 最大 5 MiB；
- Dimension 最多 32 个，Criterion 最多 500 个；
- 每个 Criterion 最多 20 条 Evidence，整份报告最多 2,000 条；
- title 256 字符、summary 8,000 字符、observation/recommendation 各 8,000 字符、单条 Evidence fact 4,000 字符；
- 单个 source reference 2,048 字符，超出或协议不在 allowlist 时拒绝；
- 附件数量、单文件和总 bytes 由部署配置设置硬上限，并在 dispatch manifest 中冻结该上限版本。

超限以稳定验证错误终止，不截断后继续验收，因为静默截断会改变 Evidence 和评分含义。

## 9. 可信来源与输入快照

每个 Audit Run 在 dispatch 前冻结输入 manifest：

- Audit subject identity generation；
- GBP/FBR 最近成功 Snapshot IDs、captured/synced time 与 hashes；
- website URL 与网站抓取 evidence reference；
- 本地关键词版本，仅当 Rubric 明确使用；
- 可用/缺失/过期来源清单；
- Rubric version；
- expected Audit Agent ID 和 expected Skill IDs；
- request schema version。

Manifest 中每个 Evidence item 都分配不可猜测的 opaque handle，并冻结 Subject binding、source kind、安全内部 reference、captured time、source/Asset hash、ready state 和允许的 locator 范围。Agent 只看到完成分析所需的内容与 handle；验收端以 handle 反查同一个 manifest，不接受输出新增来源。

Audit 使用已持久化证据，不把页面加载变成外部同步。手动触发前可以提示运营人员先执行 GBP/FBR 同步，但 Audit 本身不偷偷修改外部数据。

来源新鲜度由 Rubric 定义：

- 身份不明确或主体不匹配：阻止 dispatch；
- 可选来源缺失：允许继续，但必须降低 coverage 并记录 limitation；
- 来源超过 soft max age：允许继续并标记 stale；
- 来源超过 hard max age：对应 Criterion 进入 `EVIDENCE_UNAVAILABLE`，Required source 不满足时报告为 incomplete。

Agent/Skill provenance 由服务端从 Core AI Run 和 Trace 读回，不相信模型在输出中自报的 Agent ID 或 Skill 调用。Trace 未确认时 Run 保持 `validating`；超过验证窗口后失败，不创建 Version。

## 10. 手动执行流程

1. 前端生成一次性的随机 `request_id`。
2. `POST` 在一个短 `BEGIN IMMEDIATE` 事务内同步执行纯本地 eligibility/preflight：重读 Subject/event projection、冻结 Rubric 与已持久化 Evidence manifest，不执行网络请求。
3. Preflight 通过则创建带完整 manifest/hash 的 queued Run；来源 blocker 则创建 terminal blocked Run。二者提交后立即返回。
4. Worker 只 claim manifest 已冻结的 queued Run，创建并 claim当前 Attempt，写入 dispatching event 与单调 lease generation。
5. Worker调用专用 Core AI Audit Agent。
6. 收到明确 acknowledgement 后把 Core AI Run ID 保存到当前 Attempt。
7. Scheduler 轮询 Core AI 状态。
8. 完成后解析输出、读取 provenance、适配并验证 v2。
9. 一个带当前 Attempt lease-generation CAS 的验收事务内：读取旧 head/按确定性算法冻结比较基线，插入 Version 与 Criterion rows、绑定 ready Assets、将 Attempt/Run 置为 succeeded、以 policy version CAS 更新 `last_success_version_id` 和按规则重算 manual next due、更新 Subject Head、为自动 Run 写 change alert 或 no-change event，并写成功 events；任一步失败全部回滚。
10. 原始 POST 不等待完整 Audit；前端按 `poll_after_ms` 查询 Run。验收完成后的 subsequent Overview read 才返回新 Version，页面据此切换。

同一 `request_id` 重放返回原 Run。主体已有其他 active Audit 时返回 409 和 `active_run_id`，不创建第二个。

手动 Run 的首次明确远端失败即进入 terminal `failed`，不在同一 Run 内等待 15 分钟或自动创建下一 Attempt。运营人员需要显式调用 Run retry endpoint；该命令创建新的 Run、重新冻结当前输入，并保留 `retry_of_run_id` 关系。

## 11. 自动调度流程

- Audit scheduler 是独立 lifespan task，不复用通用分析或 FBR 同步计数器。
- 每 30 秒检查 due policy，但真实 Audit 周期由 `next_due_at` 决定。
- Claim 使用短事务、lease 和唯一 occurrence key。
- occurrence key 由 policy、subject 和 planned `scheduled_for` 计算。
- Scheduler 在同一短事务中执行纯本地 preflight、创建 queued/blocked scheduled Run、冻结 manifest/partial manifest，并以 policy version CAS 写 `last_scheduled_for`、推进 `next_due_at` 和递增 version；CAS 冲突则整个事务回滚后有界重试，不在事务内发网络请求。
- 同一 SQLite 文件上的并发 scheduler callbacks 只有一个能创建 Run；第一版不运行多个 application replicas。
- 服务停机跨过多个周期时只创建一个 catch-up Run，并将 next due 跳到首个未来 occurrence，不追赶全部漏跑周期；事件中记录 skipped occurrence count。
- due 时若同一 Subject 有任何 active Audit Run（包括 `unknown`），scheduler 保持当前 due 不动，不创建新 Run，也不在每次 30 秒 tick 重复写 blocker event。
- 占用 due 的 active Run terminal 后：若它是成功的手动 Run，则按上节从 cadence anchor 重算 due；其他 terminal 结果由下一次 scheduler claim 创建且只创建一个 catch-up Run，并把 `next_due_at` 跳到首个未来 occurrence，在单一事件中记录 skipped occurrence count。
- 商户或 Audit subject archived 时不创建新 occurrence。
- 禁用 policy 后，所有没有 nonterminal/ambiguous 远端工作的 queued 或 retry-wait scheduled Run 都安全标记 blocked，包括最后一个 Attempt 已明确失败但后继 Attempt 尚未创建的 Run；已获 Core AI acknowledgement 或结果不明确的 Run 继续追踪到 terminal，不伪装取消远端执行。创建每个重试后继 Attempt 前必须重新确认 policy 仍启用。
- 策略重新启用从新的 anchor 计算未来 occurrence，不自动补跑关闭期间。
- 本地 anchor 使用 IANA timezone。DST 不存在时间顺延到当日第一个合法 instant；重复时间固定选择较早 offset，并把解析后的 UTC instant 写入 occurrence event。

### 11.1 Scheduled Run 自动重试

只有 `trigger_kind=scheduled` 的明确、可重试失败会按同一 occurrence 和 Run 创建新的 Attempt：

1. 15 分钟；
2. 1 小时；
3. 6 小时。

这里的“三次”是初次 Attempt 之后最多三次重试，即一个 scheduled Run 最多四个 Attempts。失败 Attempt 保持 terminal；Run 重新置为 `queued`，写入 `retry_at`，到期后以唯一 `retry_of_attempt_id` 创建 Attempt N+1。它仍受同一 active Run 唯一约束。用尽后 Run 才进入 terminal `failed`，并在 UI 显示“需要处理”。下一次正常 schedule occurrence 仍按 policy 发生，不被本次失败永久推迟。手动 Run 不进入本节的 Attempt retry schedule。

网络超时导致“可能已 dispatch”时 Attempt 和 Run 进入 `unknown`，不自动重试，也不释放主体 Audit lock。只有可靠 correlation/readback 或运营对账才能继续。

## 12. Run 状态机

```text
request / scheduled occurrence
  ├─ local preflight blocker ─> blocked
  └─ manifest frozen ─> queued ─> create Attempt N ─> dispatching
                          ├─ acknowledged ─> running ─> validating ─> succeeded
                          ├─ scheduled retryable failure ─> Attempt N failed; Run queued (retry_at)
                          ├─ manual failure ─> Attempt N failed; Run failed
                          ├─ exhausted/non-retryable failure ─> failed
                          └─ ambiguous outcome ─> unknown
                                                       ├─ proven remote Run ─> running / validating
                                                       ├─ proven no remote Run ─> manual failed / scheduled queued retry
                                                       └─ explicit operator close ─> abandoned
```

规则：

- `succeeded` 必须引用一个已读回且 hash 可验证的 Audit Version。
- `blocked`、`failed` 和 `unknown` 不更新 latest head。
- `queued` 只有在 `retry_at` 为空或已到期时才能再次 claim。
- `unknown` 是隔离中的非 terminal state，不自动变化；它只能通过显式 reconciliation 转到图中状态。
- `blocked`、`succeeded`、`failed` 和 `abandoned` 是 Run terminal state，terminal state 不回退。
- Attempt 的 `failed`、`succeeded` 和 `abandoned` 为 terminal；重试创建后继 Attempt，不复活旧 Attempt。
- 状态变化写入 append-only events。
- UI 动画只用于新鲜的 `dispatching`、`running` 或 `validating`；其他状态静态显示。

## 13. API 设计

所有接口继续使用现有 operator authentication。

### 13.1 Subject 与 Overview

- `GET /api/merchants/{merchant_id}/audit-subjects`
  - 返回门店主体、最新成功版本摘要、active run 和 policy。
- `GET /api/audit-subjects/{subject_id}/overview`
  - 返回工作区首屏所需的一致 Snapshot。

### 13.2 Run

- `POST /api/audit-subjects/{subject_id}/runs`
  - Body：`request_id`。
  - 同步检查 Subject、权限、active lock，并在同一短事务内从本地持久化数据冻结 Subject/Rubric/Evidence manifest；不发外部请求。
  - Preflight 通过返回 201 queued Run；可审计的来源 blocker 返回 201 blocked Run；同一 request id 重放以 200 返回原 Run。
  - 若同一 Subject 已有其他 active Run，返回 409 `AUDIT_ALREADY_RUNNING`，并在安全响应中附 `active_run_id`，不创建第二个 Run。
  - archived、尚未绑定稳定 location identity 等创建前可判定的主体冲突返回 409，且不创建 Run。
  - 对合法主体发现的来源缺失、hard stale 或 Rubric preflight 问题，创建 `blocked` Run 并保留 event/partial manifest，不用 409 丢失本次操作记录。
- `GET /api/audit-runs/{run_id}`
  - 返回安全状态、时间、重试、错误摘要和服务端建议的 `poll_after_ms`；terminal 或 unknown 时为 null。
- `GET /api/audit-runs/{run_id}/events`
  - 分页返回 operator-safe 事件和字段级验证摘要，不返回原始 Trace/secret。
- `POST /api/audit-runs/{run_id}/reconcile`
  - 仅用于 `unknown`；通过 dispatch key、correlation 和 Core AI readback 查找唯一远端结果。
  - 可靠找到远端 Run 后继续追踪；可靠证明未创建时按重试策略处理；仍不确定时保持 unknown。
- `POST /api/audit-runs/{run_id}/abandon`
  - 仅在至少一次 reconciliation 仍无法确认后允许 operator 显式关闭。
  - Body 必须包含 request id 和非空原因；写 operator/event 后进入 `abandoned`，不声称远端执行已取消。
- `POST /api/audit-runs/{run_id}/retry`
  - Body：`request_id`。
  - 仅用于 terminal `blocked` 或 `failed` Run；创建带 `retry_of_run_id` 的新 Run，并重新执行 eligibility/manifest preflight。
  - 相同 `(subject, request_id)` 返回同一个新 Run；不同 request 遇到 active Run 返回 409 与 `active_run_id`。
  - 不修改旧 Run，也不复用可能已过期的输入 manifest。

### 13.3 Policy

- `PUT /api/audit-subjects/{subject_id}/policy`
  - Body：enabled、cadence days、timezone、anchor、expected version。
  - 使用和所有 system writers 共用的 optimistic version；CAS 失败返回 409 与当前安全 policy projection，避免浏览器或系统写互相覆盖。

### 13.4 Version 与比较

- `GET /api/audit-subjects/{subject_id}/versions?cursor=`
  - 分页返回不可变历史、`version_kind`、`score_status` 和服务端计算的 capability flags/reason codes。
- `GET /api/audit-versions/{version_id}`
  - `native_v2` 和完整适配的 `legacy_artifact` 返回 canonical v2 DTO；`legacy_v1`/未完整适配 Artifact 返回类型化只读 legacy DTO，并明确 `unscored_legacy`。
- `GET /api/audit-versions/{version_id}/compare?base_version_id=`
  - 返回新增、持续、已解决、评分变化和无法比较原因。

未传 `base_version_id` 时，API 必须读取目标 Version 已冻结的 `comparison_base_version_id`，不能在查询时重新搜索“上一版本”；因此后续 migration/backfill 不会改变既有默认 delta。只有显式传入 base 才允许临时比较另一 Version。Rubric 不兼容、主体 generation 不同、Criterion identity 变化或任一 Version 为 `unscored_legacy` 时，API 返回明确 `not_comparable`，不计算伪 delta。

Capability 由服务端依据不可变 Version 内容计算，不由前端猜测：`native_v2` 支持 compare/export/Plan；`legacy_v1` 不支持 compare 或 Plan，JSON 可导出原始 legacy envelope，HTML/PDF 只有存在已注册且版本化的 legacy renderer 时才开放；`legacy_artifact` 只有完整适配为 canonical v2 且具有稳定 Criterion IDs/Rubric 时才支持 compare 与 Plan，否则按 `legacy_v1` 边界处理。权限、主体 generation 与比较兼容性仍可进一步收窄这些能力。

### 13.5 导出

- `POST /api/audit-versions/{version_id}/exports`
  - Body：format、locale、template version、renderer version、可空 comparison base version、request id。
  - 客户版需要变化章节时固定 comparison base；不兼容则明确拒绝该比较，不能改用另一个版本。
  - 相同 identity 的 ready/running/failed Export 已存在时直接返回该资源；只有不存在时创建 queued Export 和首个 Attempt。
  - 同 request id 且 canonical request hash 相同才重放同一资源，不触发新的 renderer Attempt；相同 id 但 format/locale/template/renderer/comparison base 任一不同则返回 409 `AUDIT_IDEMPOTENCY_KEY_REUSED`。
  - 不支持所请求格式的 legacy Version 返回 409 与稳定 `AUDIT_EXPORT_UNSUPPORTED_VERSION_KIND`，不临时调用模型补写报告。
- `GET /api/audit-exports/{export_id}`
  - 返回生成状态与安全错误摘要。
- `POST /api/audit-exports/{export_id}/retry`
  - Body：新的 `request_id`。
  - 仅 failed Export 可调用；同一 retry request 幂等返回同一 Attempt，另一个 active Attempt 存在时返回 409。
  - 新 Attempt 可以把 Export projection 改回 queued/running，但不覆盖任何旧 Attempt；ready 后禁止再次 retry。
- `GET /api/audit-exports/{export_id}/download`
  - 通过认证流式下载或按请求生成极短期下载 URL；数据库不持久化签名 URL。

### 13.6 Evidence Assets

- `GET /api/audit-versions/{version_id}/assets`
  - 返回当前 operator 可见的 ready Asset 元数据和 Criterion binding。
- `GET /api/audit-assets/{asset_id}/preview`
  - 通过认证、隔离 origin 和安全响应头预览 allowlisted MIME。
- `GET /api/audit-assets/{asset_id}/download`
  - 认证下载，不暴露持久外部 URL。

### 13.7 Plan 草案

- `POST /api/audit-versions/{version_id}/plan-drafts`
  - Body：稳定 Criterion IDs、request id。
  - 在一个本地事务中创建不可变 Selection 与 queued delivery，返回 202；异步 worker 才通过幂等 Plan API 创建草案，不创建正式 Task。
  - 必须使用当前 Version 的冻结 observation、evidence 与 recommendation。
  - 相同 request id 且 Version/排序 Criterion 集的 canonical request hash 相同才幂等返回原 Selection/delivery；相同 id 搭配不同选择返回 409 `AUDIT_IDEMPOTENCY_KEY_REUSED`，绝不产生第二个 Plan idempotency key。
  - `unscored_legacy` 或没有稳定 Criterion IDs/Rubric 的 Version 返回 409 `AUDIT_PLAN_UNSUPPORTED_VERSION_KIND`。
- `GET /api/audit-plan-selections/{selection_id}`
  - 返回冻结选择、delivery 状态和经 readback 的 Plan link；不返回或创建 Task。
- `POST /api/audit-plan-selections/{selection_id}/reconcile`
  - 仅用于 `unknown` delivery；按原 `plan_idempotency_key` 从 Plan 服务读回，找到并验证唯一草案后链接，仍不确定则保持 unknown。
- Plan 的读取、修订、批准、拒绝和 materialization 使用独立 draft-first Plan API；Audit API 不复制该状态机。

### 13.8 Legacy Binding

- `GET /api/audit-legacy-sources?binding_status=unbound`
  - 只返回可安全展示的来源摘要、hash 和未绑定原因。
- `POST /api/audit-legacy-sources/{source_kind}/{source_id}/bind`
  - Body：subject id、source hash、request id。
  - 重新验证 exact historical identity；只有证据足够才创建 Version。operator 选择本身不能覆盖不匹配证据。

### 13.9 变化提醒

- `GET /api/audit-change-alerts?merchant_id=&status=unread`
  - 分页返回站内变化提醒。
- `POST /api/audit-change-alerts/{alert_id}/read`
  - 幂等记录 operator 和 read time；只改变提醒状态，不改变报告。

## 14. 工作区信息架构

### 14.1 商户页摘要

每个门店只针对当前 identity generation 显示：

- canonical `scored` 显示最新成功分数与 Grade；`incomplete` 显示“数据不完整”；`unscored_legacy` 单独显示“旧版未提供评分”，不能混入 incomplete；
- 高风险数量；
- 和上一可比较版本的变化；
- 最近成功时间；
- active Run 状态；
- 自动策略和下一次时间；
- “进入 Audit 工作区”。

存在失败 Run 时同时显示失败状态，但不能用失败时间替换最近成功报告时间。

`unscored_legacy` 摘要隐藏高风险数量和 delta，保留报告时间、来源类型与“查看旧版报告”入口，并使用服务端 capability reason code 禁用 compare/Plan；不能从旧文本估算风险数。

### 14.2 Audit 工作区

顶部：

- 门店 identity；
- 当前已验收版本、触发方式、时间、Rubric；
- “立即 Audit”；
- 自动策略；
- “导出报告”。

KPI strip：

- 总分；
- Grade；
- 较上次变化；
- 高风险数量；
- Evidence coverage。

固定高度主体：

- 左栏：优先问题、冻结 Rubric 返回的维度、全部标准，不硬编码“七个维度”；
- 中栏：问题与建议、评分明细、Evidence、版本比较、历史；
- 右栏：本次变化、选择问题生成 Plan、报告范围与 data-through。

1180 px 下右栏进入 drawer；200% zoom 时三栏按维度 → 内容 → 抽屉重排，不产生页面级横向滚动。

工作区必须有独立空态/异常态：

- 从未成功但有 active Run：显示进度，不渲染空评分；
- 只有 blocked、failed 或 unknown：显示可操作状态和最近事件，不显示虚假报告；
- legacy v1：显示只读原报告并标记“旧版未提供评分”；不展示伪造的总分、Grade、维度或 Criterion；
- incomplete：显示部分分数与 coverage，但 Grade 为“数据不完整”；
- Subject identity generation 已变化：历史版本只读，默认不与当前 generation 比较；
- 当前 Version 不支持 compare/export/Plan：对应入口禁用并显示稳定原因码；支持的 legacy JSON 或模板化 HTML/PDF 仍按 capability 单独开放。

### 14.3 Criterion 行

每行显示：

- area/category；
- severity；
- stable ID 的可读标题；
- score/max score 或 N/A 状态；
- observation；
- Evidence 数量与入口；
- recommendation；
- 新增、持续、已解决或不可比较状态；
- shared scope 标识。

默认只展开优先问题。完整 Evidence 在 drawer 中查看，避免长文本把列表撑高。

### 14.4 Active 与失败状态

- Active Run 显示阶段、开始时间和最近确认时间。
- 页面只在服务器返回 `poll_after_ms` 时轮询；terminal 或 unknown 后停止。unknown 保持静态并显示“对账”入口。
- Validation failure 显示简短中文错误、错误码和“查看技术详情”入口。
- 不向主页面输出整段 Pydantic validation dump、Trace、HTML 或 JSON。
- “重试”只有在服务器证明上次 dispatch 明确失败时可用；unknown 必须先对账。

## 15. 导出内容

### 15.1 客户版 PDF

PDF 包含：

- 品牌封面、商户和门店；
- Audit 日期、Version、Rubric 与数据范围；
- 总分、Grade、Evidence coverage；
- Dimension scorecards；
- 优先问题、Evidence 摘要和 recommendations；
- 新增、持续、已解决问题；
- limitations 与 methodology；
- Version ID、模板版本和短校验值。

内部 operator、Core AI ID、内部错误、重试、数据库 ID 和敏感 source reference 不进入客户版。

`unscored_legacy` 只有注册了对应 source schema 的版本化 legacy renderer 时才允许 PDF；模板必须醒目标记“旧版未提供评分”，省略分数、Grade、Dimension scorecards 与变化章节，不能把缺失值渲染为 0。

### 15.2 HTML

- 原生和完整适配 Version 从 canonical v2 生成；`unscored_legacy` 只有注册的版本化 legacy renderer 才能生成；
- 单文件、自包含 CSS、无外部脚本和网络请求；
- 使用严格 CSP；
- 内容和 PDF 使用同一 render model；
- 保存 SHA-256 后才标记 ready。

### 15.3 JSON

- 下载文件是一个确定性 JSON export wrapper，分别包含非敏感 Version metadata、`version_kind`、`score_status`、原报告 `payload`、`payload_hash_mode` 与 `payload_sha256`；
- 原生或完整适配 Version 的 `payload` 是 canonical v2；`unscored_legacy` 的 `payload` 是保存的原始 legacy envelope JSON value，不转换、不补字段；
- `payload_sha256` 按 Version 声明的 RFC 8785 JCS mode 复算并等于 Version hash；legacy 的 `raw_source_sha256` 另行保留原始输入 bytes 身份；`audit_exports.sha256` 单独覆盖整个 export wrapper bytes，三者不要求相等；
- 只供内部 operator 使用；
- trusted provenance 单独分区，不混入 Agent 生成 payload。

### 15.4 Renderer

服务端 Export worker 从 Audit Version 构造固定 render model，先生成自包含 HTML，再由固定版本的 headless browser 生成 PDF。模板、字体、locale 和 renderer version 均进入 export identity。生成后重新读取 bytes、计算 hash、验证 PDF/HTML 签名和非空页数，再发布 Asset。

第一版的 `locale` 只控制模板标签、日期与数字格式，不翻译 canonical report 中的 observation、evidence 或 recommendation。默认使用报告 `language`；若请求另一 locale，原始报告内容仍保持不变，并在导出中标示报告语言。自动翻译报告属于后续独立的版本化能力，不能在导出时静默改写已验收结论。

## 16. 外部 Artifact 安全

`seo_ops.audit_result.v2` JSON 是必需输出，外部 Artifact 只能是可选附件，不能用一个 HTML/PDF URL 代替 producer result。附件引用只接受以下两类可信传输：

- 经 UAT 验证的 Core AI attachment list/download API 返回的 opaque attachment ID；
- 已注册 FBR source adapter 从受信响应字段解析出的 artifact reference。

当前 `CoreAiClient` 尚无已验证的 attachment list/download 能力，因此实现必须先验证并补齐该协议。未具备时不跟随模型文本中的任意 URL；可选附件显示 `AUDIT_ASSET_TRANSPORT_UNAVAILABLE`，required attachment 则阻止验收。

如果可信协议返回 JSON、HTML、PDF 或图片引用：

1. 只接受配置允许的 HTTPS host。
2. 首次连接及每个 redirect hop 都重新校验 scheme、host、明确 port 和 DNS 解析结果；拒绝 loopback、private、link-local、multicast、metadata endpoint、协议降级和 DNS rebinding。需要访问内部服务的正式 connector 使用另一套显式 host/network allowlist，不复用外部 Artifact fetcher。
3. 下载时设置连接、读取和总时长超时。
4. 限制 MIME、文件大小、重定向次数和压缩展开大小。
5. 不把 URL query、Authorization 或 cookie 写入数据库和日志。
6. 下载后计算 SHA-256，并保存到内部 Asset Store。
7. HTML 作为不可信附件，不成为 canonical report。
8. HTML 预览使用隔离 origin、CSP 和 `sandbox`，不允许访问主应用凭证。
9. 下载失败只影响附件状态；除非 Rubric 将该附件定义为 required evidence，否则不破坏已验证的 JSON Version。

Asset Store provider 通过部署配置选择，并必须是 API/worker 共用的耐久存储，不能把容器临时目录作为 accepted Version 的唯一副本。被 accepted Version 或 ready Export 引用的对象遵循对应报告的数据保留期，不做普通 orphan 清理。清理超过 24 小时、没有 ready DB 引用的 pending/failed 上传时，必须先在短事务内把 exact metadata/lease 以 CAS 围栏为 `deleting`；ready publisher 必须拒绝该状态。事务外只删除该已围栏 object key，再以第二次 CAS 完成 metadata/event，崩溃后可幂等续跑。任何正式销毁走第 20 节的受控流程。

## 17. 历史迁移

迁移是可重复、append-only、可审计的。

初始 migration 对每个冻结批次采用两阶段算法，不能按数据库/对象存储的偶然枚举顺序边读边发布：

1. 先枚举并冻结整个 batch 的 `(source kind, source ID, source hash)` 清单；
2. 验证 schema、exact Subject/generation、可信 `report_at`、adapter/Rubric 与 payload hash，生成 accepted/unbound/rejected 候选；
3. 为 accepted 候选生成 source-derived 稳定 Version ID，按 Subject/generation 分组，再按 `(report_at, score tier, provenance tier, stable Version ID)` 全序升序排序；
4. 基于迁移前既有 Versions 与同 batch 中排序更早的候选预计算每个 canonical 候选的 comparison base；
5. 每个 Subject batch 在事务中按该顺序插入 Version/Criteria/Asset links、legacy source 结果和 head CAS；失败整体回滚，重跑使用同一 frozen batch identity；
6. 输入枚举顺序不会改变 Version IDs、version numbers、comparison bases、head 或 hashes。

迁移完成后发现的新历史来源作为新的增量 batch 追加；它可以拥有自己的正确基线，但不能回写已冻结 Version 的 comparison base。

### 17.1 v1 `audit_snapshots`

- v1 只有 `merchant_id`，通常没有 location/Place identity；不能因为商户当前只有一家门店就反推历史归属。
- 只有同时点的原始 request、Run input 或其他不可变记录能够唯一证明 exact historical Subject/generation，且能给出可信 `report_at` 时，严格通过 v1 校验的 Snapshot 才创建 `legacy_v1` Audit Version。
- 无法证明或多门店有歧义时，只写 `audit_legacy_sources.unbound`，不创建 Version、不更新 head；UI 提供待绑定清单。
- 成功迁移时保留原 run ID、source ref、原报告时间、identity evidence 和 source payload hash；这些值进入 legacy provenance，不伪造新 `audit_run_id`、Attempt 或 Rubric。
- 没有分数、Grade、Dimension 或 Criterion score 时显示“旧版未提供”，不从自然语言 observation 推断分数。

### 17.2 `AUDIT_REPORT` Artifact

- 枚举所有 ready Artifact，不受当前关键词 cycle 限制。
- payload 通过已知 v1、v2 或显式 source adapter 后才迁移；完整通过 canonical v2 契约的标记为可评分 `legacy_artifact`，其余只读迁移为 `unscored_legacy`。
- 能按 exact merchant/location/Place ID 绑定的进入该 Subject 历史。
- 无法确认 location identity 的进入 `unbound legacy` 清单，不更新任何 head。
- source artifact ID 唯一，重复执行迁移不创建重复 Version。

### 17.3 Markdown Run

- 继续在历史 Run 页面显示。
- 不迁移成结构化 Audit Version，除非其中存在一个能被严格解析和校验的完整 v1/v2 object。
- 不调用模型重新解释历史 Markdown。

### 17.4 Head 选择

- 每个 Subject 从已迁移和新生成、具有可信 `report_at` 的有效 Versions 中选择全序最大的候选；时间相同按 score tier（`scored` > `incomplete` > `unscored_legacy`）、provenance tier（`native_v2` > `legacy_artifact` > `legacy_v1`）和稳定 Version ID 依次破平局。
- 主体 identity generation 不匹配的 Version 不能成为当前 head。
- 迁移时的 `ingested_at`/`accepted_at` 只记录本次接纳，不参与 head 排序；较晚执行的 migration 不能凭迁移时间覆盖较新的线上报告。
- `unscored_legacy` 可以在没有更新报告时成为只读 current head，但 Overview 必须返回其受限 capabilities，不得显示伪评分、比较或 Plan 动作。
- 迁移前后记录 counts、source IDs、payload hashes 和 head changes。
- 不删除原表或原 Artifact；兼容读取保留到迁移验收完成后的独立清理阶段。

## 18. 错误与恢复

服务端使用稳定错误码和短消息，例如：

- `AUDIT_SUBJECT_UNBOUND`；
- `AUDIT_ALREADY_RUNNING`；
- `AUDIT_SOURCE_IDENTITY_MISMATCH`；
- `AUDIT_SUBJECT_CHANGED_DURING_RUN`；
- `AUDIT_SOURCE_TOO_STALE`；
- `AUDIT_DISPATCH_UNKNOWN`；
- `AUDIT_OUTPUT_NOT_JSON`；
- `AUDIT_OUTPUT_SCHEMA_INVALID`；
- `AUDIT_SCORE_MISMATCH`；
- `AUDIT_PROVENANCE_UNVERIFIED`；
- `AUDIT_ASSET_TRANSPORT_UNAVAILABLE`；
- `AUDIT_IDEMPOTENCY_KEY_REUSED`；
- `AUDIT_EXPORT_FAILED`；
- `AUDIT_EXPORT_UNSUPPORTED_VERSION_KIND`；
- `AUDIT_PLAN_UNSUPPORTED_VERSION_KIND`；
- `AUDIT_VERSION_NOT_COMPARABLE`；
- `MERCHANT_HAS_IMMUTABLE_AUDIT_HISTORY`。

规则：

- UI 主状态只显示可操作摘要，不显示原始异常全文。
- 技术详情按需显示字段路径、错误码、Run ID 和安全 correlation ID。
- 失败永不覆盖 latest successful Version。
- 验证失败保留原始 payload hash 和安全失败记录，但不把不合格 payload 当成报告展示。
- Unknown dispatch 不自动重发。
- Export 失败不改变 Audit Version；普通 POST 的同 request id 只读回失败资源。用户通过显式 Export retry endpoint 和新的 request id 创建后继 Attempt。

## 19. 并发、事务与幂等

- 所有 Run claim、Version acceptance、head update 和 policy update 使用短 `BEGIN IMMEDIATE` 事务。
- 外部网络请求不在 SQLite write transaction 中执行。
- 每次 claim/续租单调递增 `lease_generation`；只有持有当前 generation 的 worker 可以 dispatch、提交 acknowledgement 或写状态。旧 worker 恢复后必须停止。
- Run 创建先于远端 trigger 持久化。
- Worker 必须在发出网络请求前，以 lease-generation CAS 持久化 `dispatch_started_at`；该字段是不可逆的“可能已发送”屏障。
- 每次 remote acknowledgement、poll、validate 和 export publish 都验证当前 lease generation。
- Manual request id、scheduled occurrence key、Attempt number/retry parent、Core AI Run ID、Version Run/Attempt ID 和 Export identity 都有唯一约束。
- 调用方重试返回已存在资源，不产生第二次外部调用。

本地数据库幂等不能自动提供远端 exactly-once。实现前必须对实际 Core AI UAT 能力做读回验证：

- 若 trigger API 支持 idempotency key，并能按该 key/correlation 查询唯一 Run，则将 Attempt `dispatch_idempotency_key` 纳入请求和 reconciliation 协议；
- 若不支持，系统只承诺单个 Attempt 的 at-most-once trigger：调用超时立即进入 `unknown`，stale worker 或新 lease 绝不能再次调用 trigger；
- 接管过期 `dispatching` Attempt 时：`dispatch_started_at` 为空才允许新 lease 首次 trigger；非空但没有 acknowledgement 时，只有已在 UAT 验证的远端幂等 key 可以用原 key 重放并读回同一个远端 Run，否则必须原子转为 `unknown` 并进入 reconciliation，禁止再次 trigger 或新建 Attempt；
- 只有证明远端没有创建 Run，才可创建下一 Attempt；仅凭本地没有 `coreai_run_id` 不足以重试；
- 该能力验证是 dispatch 上线门槛，不得用代码注释或假设替代。

Version acceptance 只能通过一个事务函数完成。它必须以 Run/Attempt 仍为 `validating`、Attempt lease generation 未变化、Subject/merchant/location 仍 active、Subject 当前 identity generation/manifest hash 仍等于 Run 冻结值、旧 generation head 仍等于比较时读到的 head、policy version 仍等于事务读取值为 CAS 条件。Version/Criteria/Asset bindings、Attempt/Run terminal 状态、generation-scoped head、policy last-success/manual due/version increment、change alert 和 events 必须一起提交。任一 identity/archive 条件变化则 Run 以 `AUDIT_SUBJECT_CHANGED_DURING_RUN` 失败，不创建 Version；仅 policy/head 并发冲突则整个短事务回滚、重读并有界重试。不存在“先发布 Version、稍后补 Run 状态或 policy”的成功路径。

## 20. 权限与隐私

- 所有 API 仅限已登录内部 operator。
- 第一版沿用单一 operator role，但保存 created/updated/confirmed by，为未来 RBAC 留证据。
- 客户版导出只包含显式允许字段。
- JSON 导出仍不包含 access token、SAS token、完整 headers、cookies 或未清洗 Trace。
- 数据库只保存内部 object key，不保存长期公开 URL。
- 日志不得输出完整 Audit payload、HTML bytes 或签名下载 URL。

### 20.1 不可变历史与商户删除

新 Audit Version、Rubric、ready Asset 和其关联表使用 `ON DELETE RESTRICT`，不能被现有商户 hard-delete 级联清除：

- 只要商户存在 accepted Audit Version，普通 `DELETE merchant` 返回 409 `MERCHANT_HAS_IMMUTABLE_AUDIT_HISTORY`，UI 引导归档；
- 没有 accepted Version 且通过现有依赖检查的误建商户仍可按原流程删除；
- 法律/合规销毁属于单独的高权限、双确认 purge 流程，必须先生成对象/行清单及 hash、记录批准人与原因，再删除 bytes 和数据并保留最小非内容 tombstone；第一版普通 operator API 不提供该能力。

## 21. 可观测性

至少记录：

- due policies、claimed runs、dispatch acknowledgements；
- Run state duration；
- validation failure codes；
- accepted Versions；
- retry、unknown 和 reconciliation counts；
- Export latency、format、size 与 failure code；
- scheduler lease conflicts；
- legacy migration accepted/unbound/rejected counts。

日志和指标用 Run/Version/Subject ID 关联，不用商户名称或完整地址作为高基数字段。

## 22. 测试策略

### 22.1 契约与评分

- v2 happy path；
- unknown fields；
- subject/Place ID mismatch；
- duplicate Criterion IDs；
- missing/extra Criterion IDs against frozen expected set；
- invalid applicability/score combinations；
- missing Evidence；
- Dimension/total/Grade recomputation；
- insufficient coverage；
- explicit FBR/source adapter fixtures；
- strict fenced JSON extraction；
- producer/canonical separation and server-owned scope metadata；
- RFC 8785 canonical hash and Decimal rounding fixtures；
- payload, collection and text size limits。

### 22.2 执行与调度

- manual request id replay；
- one active Run per Subject；
- trigger-kind CHECKs reject malformed manual/scheduled rows, including NULL occurrence fields；
- active Run and nonterminal Attempt partial unique indexes hold under concurrent SQLite connections；
- unrelated task/keyword work does not block Audit；
- exact due occurrence creation；
- 同一 SQLite 文件的多连接 lease race；
- disable/archive behavior；
- 15m/1h/6h retry schedule；
- only scheduled Run uses automatic Attempt retries; manual explicit failure becomes terminal and explicit retry creates a new Run；
- failed Attempt remains terminal and creates exactly one successor；
- failed attempt does not shift normal next due；
- manual success resets next due without duplicate scheduled Run；
- downtime creates one catch-up and skips backlog storm；
- scheduled due held by any active Run, including unknown, creates no Run and no repeated per-tick blocker event；
- active Run terminal transition produces at most one catch-up and one skipped-count event；
- DST nonexistent/ambiguous anchor behavior；
- unknown dispatch never auto-retries and retains subject lock；
- reconciliation and explicit abandon transitions；
- stale lease generation cannot dispatch or commit；
- expired dispatching Attempt with `dispatch_started_at` never retriggers without verified remote idempotency; otherwise becomes unknown and reconciles；
- every policy writer uses version CAS/increment, and stale UI PUT cannot overwrite scheduler/acceptance cursor fields；
- Core AI idempotency-supported and at-most-once fallback contracts；
- terminal state never regresses。

### 22.3 持久化与迁移

- Version/Criteria/head atomicity；
- Version acceptance atomically commits Attempt/Run/policy/alert/events or rolls all back；
- Subject generation/archive change during Run prevents Version/head publication；
- immutable triggers；
- Subject generation events and frozen subject hash；
- immutable Rubric/hash conflict；
- hash readback；
- v1 Snapshot migration；
- ready Artifact migration independent of keyword cycle；
- Version union CHECKs reject native rows without successful Run/Attempt and legacy rows without a unique legacy source；
- legacy migration never fabricates Run, Attempt, Rubric, Criterion rows, score or Grade；
- `unscored_legacy` capability flags disable compare/Plan and gate HTML/PDF on a registered legacy renderer while preserving exact JSON export；
- head selection uses trusted `report_at`, not later migration/accepted time；
- unbound location quarantine；
- Markdown remains legacy；
- repeat migration no-op；
- shuffled initial legacy source enumeration produces identical Version order, comparison bases, head and hashes；
- source ID/hash conflict quarantine；
- no original history deletion；
- merchant hard-delete is restricted when accepted history exists。

### 22.4 API 与权限

- authenticated access；
- inactive merchant behavior；
- pagination/cursor stability；
- compare compatibility and not-comparable cases；
- frozen comparison-base selection skips newer unscored/incompatible Versions and deterministically chooses the greatest compatible prior Version；
- legacy DTO and capability/reason-code boundaries；
- omitted compare base uses frozen `comparison_base_version_id` even after backfill；
- safe error DTO；
- Plan draft only after explicit operator request；
- Plan Selection/outbox creation is atomic, request replay is idempotent, timeout becomes unknown, reconciliation finds an orphan by the same key, and only verified readback creates a unique link；
- reusing a Plan or Export request ID with a different canonical request hash returns `AUDIT_IDEMPOTENCY_KEY_REUSED` and creates nothing；
- Run events, retry, reconcile, abandon and poll cadence；
- alert unread/read idempotency；
- Evidence preview/download permission and isolation。

### 22.5 导出

- same Version/template/locale returns same ready Asset；
- HTML is self-contained and CSP-safe；
- PDF header, page count and non-empty text；
- JSON payload and envelope hashes；
- JSON inner payload hash and outer Export Asset bytes hash are independently recomputed；
- unscored legacy JSON preserves the exact stored envelope; unsupported legacy HTML/PDF returns the stable capability error；
- customer PDF excludes internal fields；
- expired/external SAS URL never persists；
- interrupted Export remains retryable without duplicate publication。
- ordinary request replay never creates a second render；explicit retry creates one immutable successor Attempt。
- comparison base and renderer version participate in Export identity；
- ready Asset requires object bytes readback before publication。
- ready Asset DB/object immutability and pending orphan cleanup。

### 22.6 前端

- merchant summary and latest-success semantics；
- active/failed/unknown state presentation；
- first-run, legacy, incomplete, generation-changed and unsupported-action empty states；
- fixed-height internal scrolling；
- Dimension/filter/history/compare behavior；
- Evidence drawer；
- explicit Criterion selection before Plan draft；
- dimensions render from frozen Rubric rather than a hardcoded count；
- export menu and status；
- keyboard focus, screen reader labels, reduced motion and 200% zoom；
- 1180、1440 和 1920 CSS px visual regression checks。

## 23. UAT 验收证据

### 23.1 手动 Audit

对一个已绑定门店执行一次真实手动 Audit，并读回：

1. POST 返回本地 Audit Run；
2. 独立 Attempt、Core AI Run ID 与专用 Agent identity；
3. expected Skill trace/provenance；
4. terminal Attempt/Run state；
5. producer result 与服务端 accepted v2 payload；
6. 冻结 Subject/Rubric hashes、重算分数与 payload hash；
7. Subject head 指向该 Version；
8. authenticated Overview/Version API；
9. 浏览器展示同一分数、Grade、Criterion 和 coverage；
10. 没有自动创建 Plan 或正式 Task。

另用明确失败 fixture 证明手动 Run 第一个 Attempt 后即 terminal failed，只有显式 retry 命令才创建带关联的新 Run。

### 23.2 自动 Audit

使用可控短周期 fixture 或显式 due time，证明：

- 一个 occurrence 只创建一个 Run；
- 单 replica 内并发 scheduler callback 不重复 trigger；
- manual success 将 scheduled due 重算到下一个 cadence anchor；
- 明确失败按同一 occurrence 重试；
- unknown 不自动重发；
- active/unknown Run 跨 due 时不重复建 Run/写 blocker，terminal 后只产生一个 catch-up；
- scheduler、验收和 UI policy 写入都通过 version CAS，旧 UI 请求不能覆盖新游标；
- 服务停机后只创建一个 catch-up；
- terminal failure 不覆盖 latest success。

### 23.3 导出

对同一 Version 生成 PDF、HTML、JSON并读回：

- format、MIME、size、SHA-256；
- template/locale/renderer version；
- PDF 可以完整解码且页数大于零；
- HTML 无外部脚本/请求；
- JSON wrapper 解析后内嵌 `payload_sha256` 按声明 mode 复算并等于 Version payload hash；整个文件 bytes 另行复算并等于 Export Asset hash；
- 再次请求复用相同 ready Export；
- 数据库不存在 SAS query。

### 23.4 历史迁移

读回迁移清单，证明：

- 合格 v1 Snapshot 和 Artifact 可见；
- 旧 Audit 不再因为关键词 cycle 不同而隐藏；
- 无评分旧报告明确显示缺失；
- legacy Version 读回为空的 Run/Attempt/Rubric/score 字段与真实 `legacy_source_id`，证明没有伪造新执行或评分；
- 较晚迁移的旧报告不会凭 `accepted_at` 覆盖 `report_at` 更新的 current head；
- 用相同 frozen source batch 的两种乱序输入运行 migration fixture，Version 顺序、comparison bases、head 和 hashes 完全一致；
- 无法绑定门店的数据留在 unbound 清单；
- 原始历史数据未删除。

### 23.5 Plan 草案交接

在 draft-first Plan API 契约可用后，显式选择 Criteria 并证明：

- Selection 与 outbox delivery 在一个本地事务中存在；
- 相同 request ID 重放仍指向同一 Selection 和 idempotency key；
- 模拟 Plan 已创建但 acknowledgement 丢失后，delivery 进入 unknown，reconciliation 用原 key 找回唯一草案；
- Plan Version/selection readback hash 一致后才创建唯一 link；
- 草案创建后仍无正式 Task，直到运营人员在 Plan 领域明确批准。

## 24. 发布顺序

1. 先交付或读回验证共享稳定 Location Registry；禁止创建 Audit 专属平行门店主数据。
2. Producer/canonical v2 contract、immutable Rubric、validator 与 adapter fixtures。
3. Audit domain tables、Attempt model、migration、immutable constraints 和 readback verifier。
4. Manual Run service、Core AI dispatch/poll/reconciliation/provenance validation。
5. Subject overview、Version/history/compare APIs。
6. 方案 B 的商户摘要与 Audit 工作区；“生成计划”先以有原因的 disabled 状态发布。
7. Policy、scheduler、lease、retry 和 unknown reconciliation。
8. HTML/JSON Export，再加入 PDF renderer。
9. v1 Snapshot 与 ready Artifact migration。
10. 接入 draft-first Plan 服务后启用 Criterion selection → Plan draft；不得接入当前预建 Task 路径。
11. 全量自动测试、UAT readback、响应式/无障碍检查。

每一步保持现有通用 Run、Audit v1 Markdown fallback、关键词、Local Falcon、GBP/FBR 和 Task 流程可用。新 Audit 成功路径完成读回前，不移除旧接口。

## 25. 完成定义

只有以下条件全部成立，第一版才算完成：

- 手动和自动 Audit 使用同一专用、幂等、可恢复管道，并以独立 Attempt 保存每次远端调用；
- 每个成功 Run 产生一个可重算、hash 可验证、不可变的门店级 Version；
- 冻结 Subject 与 Rubric hash 能完整复现 scope、评分、Grade 和比较边界；
- 失败和 unknown 不覆盖 latest success，unknown 不自动重试且可安全对账；
- 方案 B 工作区能展示完整 v2、历史和比较；
- 自动 Audit 不创建正式任务；
- Plan 只能由显式运营操作创建，且通过持久化 outbox、稳定 idempotency key 与 readback 关联，不产生孤儿或重复草案；
- PDF、HTML、JSON 均来自同一 Version 并完成 bytes readback；
- 历史 v1/Artifact 迁移不伪造评分、不删除原数据；
- 外部签名 URL 不进入持久化；
- 有 accepted Audit 历史的商户普通操作只能归档，不能 hard-delete；
- 后端、前端、scheduler、migration、export、security、accessibility 和真实 UAT 验收全部通过。

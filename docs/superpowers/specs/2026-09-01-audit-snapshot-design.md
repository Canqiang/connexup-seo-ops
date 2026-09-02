# SEO Ops Audit Snapshot 设计

日期：2026-09-01
状态：已由 Xander 确认实施

## 目标

分析报告页不再把任意 Core AI 文本当成 Audit。系统只把通过严格契约校验的 `seo_ops.audit_report.v1` 保存为 Audit Snapshot，并以结构化方式展示结论、问题、证据、限制和下一步行动。旧 Run 的 Markdown 报告继续可读。

## 边界

- 只修改 `connexup-seo-ops`。
- Core AI 只提供 Run 输出，不拥有 SEO Ops 的 Audit 接受状态。
- 不修改 FBR Project；FBR 最新 Audit 接口将来可作为上游证据适配器，本阶段不伪造远端数据。
- Audit 与 Plan 分离。Audit 的 `next_actions` 是建议，不自动成为已批准任务。
- 原始 JSON 不直接铺在页面上；运营界面展示可决策信息。

## 数据模型

新增 `audit_snapshots`：

- `id`：本地 ID。
- `run_id`：唯一关联分析 Run。
- `merchant_id`：关联商户。
- `schema_version`：固定为 `seo_ops.audit_report.v1`。
- `payload_json`：通过校验后规范化序列化的完整 JSON。
- `evidence_mode`、`finding_count`：供列表和状态判断使用。
- `source_ref`：Core AI Run ID 或明确的导入来源。
- `accepted_at`：SEO Ops 接受时间。

## 接受规则

`AuditReportV1` 使用 Pydantic 严格校验：拒绝额外字段、缺少字段、非法枚举、空 findings、超长内容和非 JSON 文本。`merchant_id` 必须等于本地 Run 的商户 ID 字符串。校验失败只意味着“没有可接受 Audit”，不会把旧 Run 改成失败，也不会把 Markdown 冒充 Audit。

## 数据流

1. 调度器读取 Core AI Run 的 `output`。
2. 原始输出仍保存到 `runs.report_text`，用于旧版兼容和追踪。
3. 若输出严格符合 `seo_ops.audit_report.v1`，则原子写入 Audit Snapshot。
4. `GET /api/runs/{run_id}/audit` 返回已接受 Snapshot；不存在时返回 404。
5. 分析页优先加载 Snapshot；存在时展示结构化 Audit，不存在时展示旧 Markdown。

## 页面设计

页面只有一条主阅读路径：

1. 顶部结论：标题、摘要、证据范围。
2. 问题清单：按返回顺序展示 area、severity、observation。
3. 展开内容：证据和建议紧邻问题，不另建复杂标签页。
4. 底部两栏：数据限制、下一步行动。
5. 右侧保留现有 Plan 确认与任务清单。

视觉沿用浅色内部运营控制台。严重级别使用克制的状态色；结构线和留白编码信息层级，不新增仪表盘装饰、技术 ID 网格或动画。

## 验收

- 合法 Audit JSON 被持久化并可按 Run 查询。
- 非法、跨商户或 Markdown 输出不会生成 Snapshot。
- 有 Snapshot 的分析页展示所有核心字段，不展示原始 JSON。
- 无 Snapshot 的历史 Run 仍展示现有 Markdown。
- 现有 Plan 审批、任务和鉴权测试不回归。

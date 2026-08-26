# 执行 Agent 落地路线图(flow v4)

**Spec:** `docs/superpowers/specs/2026-08-20-seo-ops-execution-agent-design.md`(rev 3,已评审通过)

spec 横跨多个独立子系统,按依赖顺序拆成六份计划;**每份独立交付、全绿后才写下一份**(代码形态会随前序计划变化,提前写会失真)。

| # | 计划 | 覆盖 spec 章节 | 交付判据 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `2026-08-20-pg-migration.md` | §5(数据库底座) | 现有 122 服务端测试在 PostgreSQL 上全绿,行为零变化 | 已写 |
| 2 | `2026-08-24-auth-identity.md` | §4 | 自有登录+Session、六权限点、商户范围、关键动作真实身份;`local-dev` 占位清除 | 已完成 |
| 3 | 任务执行域 | §6(状态机/双门)+ §9(授权矩阵)+ §12(契约) | 双门可走通(门 2 六项事务校验，含前置任务完成)、attempts 分表、资产授权矩阵 CRUD、Zod 契约;前端双门/矩阵/任务页 | 已实现，待独立提交验收 |
| 4 | 执行链路 | §7 + §8(api/worker 拆分) | outbox + 独立 worker、at-most-once、核验/对账/DEAD/暂停;前端对账流与应用证据 | 部分实现：worker/未知结果冻结/核验已落地；outbox 与 specialist 结果适配器未完成 |
| 5 | 自动周期 | §10 + §11 剩余 | scheduler 进程、显式开启、周期触发、周 post 草拟链、首页分组齐全 | 部分实现：周期信号可聚合到 Planner；周 Post 成品链未完成 |
| 6 | UAT 部署 | §14 | 三进程 Deployment、PG、Secret、监控告警、发布/回滚记录 | 待写 |

红线(每份计划的隐含全局约束):**不改 core-ai 仓库任何代码**;写入类无自动重试;未知结果不自动定性;Chat/Scheduler 不越门。

## 2026-08-26 Planner bridge 验收记录

- UAT Planner Agent：`d058d5ff-c7e5-48cb-9e34-cf480d167e99`（PUBLISHED）。
- 新商户、问卷回收、周期到期三类确定性事件可建立 PLANNER Task；周期信号一轮聚合一次。
- Planner dispatch 输入为 `seo_ops.planner_context.v1`；输出必须通过
  `seo_ops.task_proposals.v1` 严格解析且 `trigger_key` 原样回显。
- Planner 只产生 Proposal Batch；Task 的持久化、授权、派发和完成仍由 SEO Ops 控制。
- 本地 SEO Ops → UAT Core AI → 本地 Proposal Batch 的真实闭环已通过，证据见 `docs/RUNBOOK-v2.md`。

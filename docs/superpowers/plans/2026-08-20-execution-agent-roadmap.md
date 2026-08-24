# 执行 Agent 落地路线图(flow v4)

**Spec:** `docs/superpowers/specs/2026-08-20-seo-ops-execution-agent-design.md`(rev 3,已评审通过)

spec 横跨多个独立子系统,按依赖顺序拆成六份计划;**每份独立交付、全绿后才写下一份**(代码形态会随前序计划变化,提前写会失真)。

| # | 计划 | 覆盖 spec 章节 | 交付判据 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | `2026-08-20-pg-migration.md` | §5(数据库底座) | 现有 122 服务端测试在 PostgreSQL 上全绿,行为零变化 | 已写 |
| 2 | `2026-08-24-auth-identity.md` | §4 | 自有登录+Session、六权限点、商户范围、关键动作真实身份;`local-dev` 占位清除 | 已写 |
| 3 | 任务执行域 | §6(状态机/双门)+ §9(授权矩阵)+ §12(契约) | 双门可走通(门 2 五项事务校验)、attempts 分表、资产授权矩阵 CRUD、Zod 契约;前端双门/矩阵/任务页 | 待写 |
| 4 | 执行链路 | §7 + §8(api/worker 拆分) | outbox + 独立 worker、at-most-once、核验/对账/DEAD/暂停;前端对账流与应用证据 | 待写 |
| 5 | 自动周期 | §10 + §11 剩余 | scheduler 进程、显式开启、周期触发、周 post 草拟链、首页分组齐全 | 待写 |
| 6 | UAT 部署 | §14 | 三进程 Deployment、PG、Secret、监控告警、发布/回滚记录 | 待写 |

红线(每份计划的隐含全局约束):**不改 core-ai 仓库任何代码**;写入类无自动重试;未知结果不自动定性;Chat/Scheduler 不越门。

# 专用 Agent 真实 UAT 验收

2026-09-08 用户批准一次真实模型调用，仅使用隔离测试数据。无内容发布、真实商户写入、主库配置变更或主分支合并。

## 已验证

- 专用 Agent：`a2c3443a-672f-4ca6-8b60-46f977fd4667`。
- Run：`ff38cbf5-1a23-440a-9e87-7d35adfbc1cd`，一次 trigger，远端独立回读 `COMPLETED`。
- 配置快照 SHA256：`1aced337ffe54e009971ce69f73b7d78cd4c4d889663f41189651a718636931e`；触发前后相同，无 tools、skills、subagents、sandbox、datasets、memory。
- 远端 Agent ID、run ID、input 与本地冻结请求精确匹配。
- 真实 API 路由完成创建测试 Task、分配 Agent、手动执行、轮询及审批；未替换远端客户端。后台生命周期停用，未启动其他自动任务。
- 合成商户 Example Cafe，仅提供纽约、咖啡、可颂事实；返回英文欢迎草稿，有输入依据，无编造价格/营业时间，无外写声明。
- 本地 Task：`PREPARING → AWAITING_APPROVAL → DONE`，最终 version 5。
- Execution 1：`SUCCEEDED`，attempt 1；结果 checksum `6156c540ecded391b009e114910e8662f22faa9308b5533c80ae52e13e40aa86`。
- 测试 AM `uat-am` 审批事件绑定 execution 1，时间 `2026-09-08T08:37:56.539855+00:00`。
- 审批后使用独立只读 SQLite 连接回读 DONE / SUCCEEDED / reviewed_at，execution 总数为 1。

## 证据与边界

临时数据库：`/tmp/seo-agent-uat.TtLcIH/acceptance.db`。验证脚本同目录；不得重新运行触发脚本。未启动预览服务器。

测试脚本首次本地登录因测试 secret 长度不足失败，修正后才触发唯一远端 run。审批后的首次独立 SQL 查询误把 API 计算字段 result_checksum 当作数据库列；改用实际持久化字段只读回查通过。两项均为验收脚本问题，不是产品流程失败，未因此重触发模型或重复审批。

本次证明准备与本地 AM 审批链路可用，不证明 Orchestrator 自动生成计划、真实发布、生产配置或 UI 端到端链路。配置散列仍是漂移检测，不是平台强制版本锁。本次未重跑全量单测；先前本地测试结果另见本地验收记录。

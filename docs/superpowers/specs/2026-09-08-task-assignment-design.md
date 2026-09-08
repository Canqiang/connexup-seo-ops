# Task 结构化负责人（AM / Agent）

用户批准：人工仅当前登录操作员，业务角色 AM；不建设多用户系统。接续已合并的 Orchestrator 配置入口，本切片只建立责任分配，不派发远端 Agent。

## 边界

- 独立表 task_assignments 保存每个 Task 的当前负责人，未分配时无记录。HUMAN 使用认证返回的实际用户名；AGENT 外键关联本地 seo_ops_agents.id。AM 是角色不是共用身份。
- 不改 tasks、Plan Revision 或旧 assignee 字段含义。旧文字保留并在页面明确标成历史备注，不自动推断身份。
- GET /api/tasks/{id}/assignment 返回当前负责人、实际版本、可分配候选和是否允许修改；候选只有当前 AM 与 status=active 的已注册 Agent。不按 Core AI 名称猜测，注册有效不代表执行能力已验证。
- PUT 同一路径接收 expected_version、assignee_type、assignee_id、reason；两个身份字段必须同为空或同时有效。HUMAN 的 ID 必须等于当前登录用户名，AGENT 必须存在且 active。
- 修改在 BEGIN IMMEDIATE 下检查商户 active、Task 未替代、状态 PENDING/NEEDS_ATTENTION、没有 PENDING/DISPATCHING/RUNNING/UNKNOWN 的执行，再使用 Task version CAS 更新。完整前后快照与原因写入已有 task_events，和负责人变更同一事务。
- 已完成、取消、运行中、待审批、结果未知的任务不能转交。重复提交旧 version 返回 409，前端不自动重试。无变化请求不递增版本。
- task_dict 暴露 assignment。历史执行不重写。AGENT 已分配任务在旧 LLM Call 准备通道中必须失败关闭，不能悄悄改用默认执行者；AM 与未分配旧任务保留现有人工发起准备流程（AM 是负责人，不伪称模型执行者）。
- 页面使用紧凑、左对齐的负责人区域：当前身份、显式编辑、分配下拉框、原因、保存与取消。按需读取候选，失败保留旧数据。保存成功刷新任务详情；409 要求重新加载再决定，不重发。沿用现有字体、按钮、间距与色彩，不重做整个 Task 页面。

## 数据迁移与验证

使用新的 0005 SQL 迁移；不回填猜测身份，不连接真实数据库。测试空库、重复初始化、旧库升级与旧文字保留、身份/FK 校验、并发保护、危险阶段转交拒绝、事件读回以及 Agent 分配后的错误执行阻止。

前端测试真实组件经 fetch 边界模拟 API，覆盖 AM、Agent、未分配、冲突、失败、取消与已锁定状态。API 全量回归、前端测试/lint/build，视觉检查尽量使用隔离测试数据，不使用主服务。

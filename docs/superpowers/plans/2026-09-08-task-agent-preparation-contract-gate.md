# Task Agent Preparation — Contract Gate

更新：2026-09-08 用户已批准使用新建专用 Agent 加不原地修改的管理约定替代接口版本锁定。下文保留为历史核查证据，不再是阻止本地实施的现行门槛。当前决定见对应设计文档；新 Agent 创建记录见 `docs/agents/task-preparation-2026-09-08-readback.md`。真实运行仍未授权。

日期：2026-09-08。状态：详细设计已由用户确认；实施计划在前置契约核查处暂停，未开始业务代码。

## 已完成

- 独立工作区 `.worktrees/task-agent-preparation`，分支 `codex/task-agent-preparation`，基于 SEO Ops `e454a32`。
- 基线命令：在该工作区 api 中使用主仓库 api/.venv/bin/python 运行 `-m pytest tests/test_tasks.py tests/test_task_assignment.py tests/test_coreai.py -q`。
- 结果：188 passed，1 项已有 Starlette 弃用警告。
- 没有执行远端调用、改动配置、迁移真实数据库或修改 Core AI 代码。

## 本地证据

读取 Core AI 工作区源文件，其 HEAD 为 `9b2890447dd04f72155be27c62d44e5605683382`。此结论针对当前本地文件，不等价于 UAT 已部署版本。

1. `core-ai-api/src/main/java/ai/core/api/server/run/TriggerRunRequest.java:10`：只有 input、attachments，没有期望发布版本或能力快照前置条件。
2. `core-ai-server/src/main/java/ai/core/server/run/AgentRunService.java:56`：trigger 按 Agent ID 重新读取定义并交给 runner，未比较调用方已验证的版本。
3. `core-ai-api/src/main/java/ai/core/api/server/run/TriggerRunResponse.java`：只有 run_id、status。
4. `core-ai-api/src/main/java/ai/core/api/server/run/AgentRunDetailView.java:13`：有 agent_id、状态、输入输出、trace、产物等，但没有执行发布版本或能力快照绑定。
5. `core-ai-server/src/main/java/ai/core/server/run/AgentRunner.java:341`：createRunRecord 保存 Agent ID、用户、输入等，没有保存本设计要求的执行配置校验和。
6. `AgentCallRequest.java` 同样只接受 input、attachments；改走同步 Agent call 不能解决该问题。

## 为什么是阻塞

设计要求“限定无工具 Agent”，而不仅是运行结束后让模型自报没有写入。详情检查与 trigger 是两次请求；期间若发生重新发布，启动的能力集合可能已经变化。事后读取当前 Agent 配置、读取输出中的 external_write_performed=false 或重复查询前后时间，都不能替代服务端对执行版本的约束。

当前不能凭空定义一个远端不存在的 snapshot 字段，再用 mock 测试将其当作真实能力。旧 LLM Call、旧 Agent 历史审批规则和当前 AGENT 执行阻止行为均保持不变。

## 解除门槛

优先核对 UAT 的实际接口定义是否已有本地尚未包含的执行版本约束；这个核查不应触发 Agent。如果已有，记录真实请求/响应契约及版本，再完成实施计划。

如果 UAT 也没有，需要用户授权扩展 Core AI 接口范围，或明确另行批准替代安全方案。建议的服务端能力是：在创建运行前原子校验调用方期望的不可变发布版本，将实际版本/能力摘要绑定到该运行，并可按精确 run_id 读回。这里是契约需求，不是本次已获授权的 Core AI 改动。

工作区保留，未合并、未 push。下一步需要用户选择解除这个边界的方向，不将本次标为完整执行闭环已实现。

## UAT 只读核对（2026-09-08 07:48 UTC）

用户授权只读核对后，使用 SEO Ops 已配置的 UAT 地址与服务端凭证，仅发送 GET；未输出凭证或业务输入输出，未发送 trigger/call/发布请求。

- `GET /api/agents/{已配置任务准备 Agent ID}`：200；字段包含 published_at、updated_at，没有独立发布版本/执行快照字段。该详情的两个时间均为 `2026-09-01T10:09:26.902Z`，这不构成运行时版本锁定。
- `GET /api/runs/agent/{同一 Agent ID}/list?limit=1`：200；从返回的已有记录选择一条，再 GET 精确 run ID。
- `GET /api/runs/{已有 run ID}`：200、COMPLETED，agent_id 与请求 Agent 一致。字段为 agent_id、artifacts、completed_at、error、error_stack、id、input、output、started_at、status、token_usage、trace_id、transcript、triggered_by；未返回版本、快照或校验和字段。没有读取另一个商户或按名称猜测运行。
- `GET /openapi.json`：404；`GET /_sys/api` 在未认证及携带现有凭证时均为 403，没有绕过权限限制。因此未获得完整 UAT 接口定义，不能由这次抽样证明所有接口都不支持版本绑定。
- Kubernetes 只读部署核对：uat-ai/core-ai-server 的两个 Pod 使用相同镜像 digest `sha256:91609d6223fa9a645623791045196b6689a82feb67debea0d2f76990e7f33568`，启动时间分别为 2026-09-08T06:50:59Z 和 06:50:34Z。标签为 latest，未证明其对应本地 Git HEAD，不将镜像标签当作源码版本。

结论：已验证的 UAT Agent/运行详情没有补齐本设计要求的证明链；完整 trigger 契约仍需服务端团队提供。继续保持真实执行入口关闭。建议向 Core AI 团队确认原子发布版本前置条件与运行快照读回契约；未获得扩展 Core AI 修改权限。

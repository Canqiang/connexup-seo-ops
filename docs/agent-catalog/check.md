# 只读依赖核验

在本分支的 `api` 目录运行，明确指定需要检查的环境文件和数据库：

```sh
/Users/xander/git_repo/connexup-seo-ops/api/.venv/bin/python -m app.agent_catalog \
  --env-file /Users/xander/git_repo/connexup-seo-ops/api/.env \
  --db /Users/xander/git_repo/connexup-seo-ops/data/seo-ops-v3.db
```

JSON 只写标准输出。可将经审查的输出保存为观测文件，再传 `--baseline /absolute/path/observation.json` 比较。工具自身不写文件或数据库，不触发 Agent，所有远端请求为 GET。

- 退出 0：本次可见列表完整、依赖读取成功且没有环境/注册绑定冲突。不是所有权、运行绑定或业务端到端通过证明。
- 退出 2：读取失败、列表覆盖不完整、绑定冲突或无效输入。错误输出固定代码，不回显上游正文或凭据。
- `matches`：环境角色与数据库注册一致。
- `registry_only`：仅数据库注册，不代表闲置或应该删除。
- `configuration_only`：环境已配置、数据库未注册。
- `mismatch`：同一角色指向不同远端 ID，不自动修复。
- `changed`：相对提供的基线，执行配置摘要或 Skill digest 改变；不是自动升级授权。
- `unknown`：缺少可靠远端读数，不视为删除。

首次运行 `not_compared`，不会把第一次发现资源叫做漂移。基线必须属于相同远端地址摘要与本地角色/远端 ID 集合；角色增删或换绑后需要明确建立新基线。

Agent 摘要覆盖显式列出的执行配置字段，排除显示名称和时间戳；数组次序仍参与摘要。新增平台字段不会自动纳入，适配器需要更新。Skill 使用远端提供的 digest，未读完整正文。原始提示词不出现在结果中。

共享引用统计仅覆盖当前账号可见 Agent 的直接 Skill 声明；列表不完整则明确标示，不猜测分页协议。无法发现按名称动态加载、隐藏账号或服务端运行时依赖。单一引用不证明专用所有权。

## 本次验证

2026-09-09：UAT 连续两次 GET 核验，165/165 个可见 Agent，7 个本地注册 Agent、5 个 Skill，全都 unchanged。六个环境槽位 matches；专用准备 Agent registry_only。两个共享关键词 Skill 可见直接引用数为 6、5。

实际 CLI 子进程退出 0，输出 schema 为 `seo_ops.agent_catalog.v1`。后端全量测试 1,377 项通过（8 条依赖/多线程 fork 警告）；随后补充重复基线角色拒绝校验，最终相关测试 80 项通过。全量结果对应补充校验前的版本，最终校验改动由针对性测试覆盖。

未接管理 UI，未修改运行进程环境、绑定、远端配置、报告生成或客户交付。下一步可将本只读观测能力接入现有工作台，但不得将 CLI 文件或结果变成第二份运行注册表。

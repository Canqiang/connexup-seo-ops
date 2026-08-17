# Connexup SEO Operations

面向内部代运营团队的 SEO 执行控制台。首版聚焦一个操作人员同时服务多家商户时最容易出错的链路：商户上下文、行动队列、任务证据链、人工审批和 Agent 执行边界。

## 当前纵向切片

- 可搜索的商户 / 门店上下文切换
- 跨商户行动队列，按“需要判断、阻塞、今天执行、执行后”分组
- 任务详情与五段证据链：来源 → 预览 → 审批 → 执行 → 回读
- Copilot 上下文显示与外部写入审批门
- Agent Run、任务与业务结果分层展示
- 复盘 / 因果分析入口

当前数据为产品验证用的本地 fixture；所有外部写入按钮都保持禁止状态。

## 本地运行

```bash
npm install
npm run dev
```

## 验证

```bash
npm run test:run
npm run build
```

## 下一步架构边界

后端接入时保持四个核心对象独立：`Merchant/Location`、`Task`、`AgentRun`、`Evidence`。任务是业务工作单元；Agent Run 只是某次执行尝试；外部动作必须经过 `preview → approval → execute → readback`，回读证据未建立前不能自动结项。

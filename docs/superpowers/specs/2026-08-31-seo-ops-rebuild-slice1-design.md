# SEO Ops 重建设计 — 第一块砖：商户台账 + 任务工单

日期：2026-08-31
状态：已与 xander 口头确认，待书面评审

## 背景

旧系统（v2，保存在 `backup/main-2026-08-28-design-canvas` 分支及 `_to_delete/seoops-v2-0826.tgz`）长到了 213 个源文件、约 3.3 万行 TypeScript：前端 13 个 feature 模块、服务端约 35 个 service。概念层（生命周期阶段、Gate、轮次、审批红线）和实现层互相咬合，单人已维护不动。2026-08-28 main 已重置为空树，决定推倒重建。

本文档定义重建的总体原则、技术栈，以及第一个增量（"第一块砖"）的完整范围。

## 总体原则

1. **一次一个功能**：每个增量做完系统都能投入使用，用了再加下一个。不预埋"以后会用到"的抽象或字段。
2. **概念极简**：第一版只有两个实体——商户、任务。生命周期、Gate、轮次、异常清单、问卷等旧概念一律不进入新系统，除非真实运营逼出来。
3. **AI 边界清晰**：agent/LLM 的一切能力走 core-ai-server 的 API（`/api/agents`、`/api/skills` 等）。不修改 core-ai 的任何代码，本系统只是调用方。第一块砖完全不涉及 AI。
4. **前后端分离**：后端 Python、前端独立构建，纯 REST 通信。

## 技术栈与仓库结构

| 部分 | 选择 | 理由 |
|---|---|---|
| 后端 `api/` | Python + FastAPI + SQLite | 自带 OpenAPI 文档，Pydantic 做类型校验，单人维护成本最低 |
| 数据库 | SQLite 单文件（`data/seo-ops-v3.db`），schema 用单个 SQL 文件管理 | 不上重型 ORM / 迁移框架 |
| 前端 `web/` | React + Vite + TypeScript | 沿用熟悉的栈 |
| 认证 | 第一版无登录（内网/本地使用） | 部署 UAT 前再加最简认证 |

清理与归档：

- `dist/`、`server/`（仅剩构建产物与 node_modules）、`tsconfig.*.tsbuildinfo` 挪入 `_to_delete/`。
- `data/` 内旧库（`seo-ops.db`、`partner-demo.db` 等）原地归档，不迁移、不读写；新系统全新建库。商户基础信息人工录入，或需要时写一次性导入脚本（只导商户名称等基础字段）。

## 第一块砖：范围

### 数据模型

`merchants`：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| name | TEXT NOT NULL | 商户名称 |
| status | TEXT | `active` / `archived`，默认 `active` |
| notes | TEXT | 备注，可空 |
| created_at | TEXT | ISO 时间戳 |

`tasks`：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增 |
| merchant_id | INTEGER FK → merchants | 所属商户 |
| title | TEXT NOT NULL | 标题 |
| description | TEXT | 描述，可空 |
| rationale | TEXT | 任务动因——为什么要做这件事。人工建任务可填；后续砖里由 LLM 生成任务时必填，是运营审核任务的依据 |
| status | TEXT | `todo` / `doing` / `done` / `cancelled`，默认 `todo` |
| evidence_note | TEXT | 证据文本——做了什么的留痕，可空；需要截图时先在文本里贴链接/路径 |
| created_at | TEXT | ISO 时间戳 |
| completed_at | TEXT | 进入 `done` 时写入，可空 |

`rationale` 与 `evidence_note` 对称：一个记录"为什么做"（事前，审核依据），一个记录"做了什么"（事后，执行留痕）。不做附件表和文件上传。

状态流转规则：`todo → doing → done`；`todo`/`doing` 可转 `cancelled`；`done`/`cancelled` 为终态，不可再流转。进入 `done` 时写 `completed_at`。

### API（REST，JSON）

- `GET/POST /api/merchants`，`GET/PATCH/DELETE /api/merchants/{id}`（删除仅允许无任务的商户；有任务的用 `archived`）
- `GET/POST /api/merchants/{id}/tasks`，`GET/PATCH /api/tasks/{id}`（PATCH 含状态流转与 rationale/evidence_note 更新，非法流转返回 422）

### 页面（3 个）

1. **商户列表**：全部商户 + 状态筛选，可新建商户。
2. **商户详情**：商户信息 + 该商户任务列表（按状态分组），可新建任务。
3. **任务详情**：看动因（rationale）、改状态、填证据文本。

### 测试

- 后端：pytest 覆盖全部接口与状态流转（含非法流转、删除有任务的商户等错误路径）。
- 前端：保证构建与运行，不铺测试面。

## 明确不做（第一块砖）

- 登录/权限、多用户
- 证据附件上传（先在证据文本里贴链接/路径，文本不够用再加）
- 一切 AI 能力（第二块砖：经 core-ai-server 的 agent 跑批）
- 排名/效果数据（第三块砖）
- 生命周期阶段、Gate、轮次、问卷、异常清单、能力矩阵、GBP 执行
- 旧数据迁移

## 后续路线（只列方向，不预先设计）

- 第二块砖：通过 core-ai-server 发起 agent run、拿回 plan/报告、解析成任务；保留"EXECUTE/VERIFY 永不自动触发"的红线。
- 第三块砖：ranking 快照与轮次对比。
- 每块砖开工前单独走设计确认。

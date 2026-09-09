# 反馈一致性设计（全局交互骨架 · 第一块）

日期：2026-09-09
状态：待用户审阅
上游决定：优化范围 = 全局交互骨架；首要目标 = 反馈一致性；方式 = OpenDesign 原型先行，再移植。

## 1. 背景与目标

`web/` 有 9 个页面，反馈类交互各自为政：

| 模式 | 现状（证据） |
|---|---|
| 确认对话框 | 3 处原生 `window.confirm`：`MerchantList.tsx:101` 删除空白草稿、`MerchantDetail.tsx:294` 归档商户、`RunDetail.tsx:286` Run 标记 NOT_CREATED。同时 `MerchantProfile.tsx` 已有 3 个内联的 `operation-confirm-dialog` 样式对话框（Local Falcon 付费扫描、关键词版本、人工对账），但没有抽成组件。 |
| 409 冲突 | 3 种写法：`TaskDetail.tsx` `isStaleIdentityConflict` → `conflict` 状态 + 「刷新任务」按钮；`PlanReview.tsx` `markConflict` → `conflicted` + `.plan-conflict-note` + 「重新载入服务器 Plan」；`MerchantProfile.tsx:1800` 4xx 清 relink ref 后只显示错误文本。 |
| 错误 / 成功 | `.error`（红框）、`.notice`（绿条）、对话框内 `.scan-confirm-error`，各页自行拼装；`role="alert"` 用得广但不统一。 |
| 加载 | 各页各自的「加载中…」文本 + `busy` 布尔；无骨架屏；`role="status"` 只在部分页面。 |
| 空态 | `.empty-state` 存在，文案与是否带主操作各页不同。 |

目标：五种反馈模式各只有一种实现，视觉先在 OpenDesign 里定稿，再落成 `web/src/components/feedback/` 下的共享组件，并把上面所有站点替换掉。

## 2. 范围

做：
- OpenDesign 自定义设计系统包 `seo-ops`（从 `index.css` 的 token 派生）。
- OpenDesign 项目「seo-ops 反馈模式套件」+ 一次 `frontend-design` 驱动的 run，产出单页 HTML 原型供审阅。
- 原型定稿后：5 个共享组件 + CSS；替换 3 处 `window.confirm`、统一 3 处 409、统一加载与空态；更新受影响测试。

不做：
- 导航、路由、页面布局、token 重构、视觉大改。
- 引入任何 UI 库或 CSS 框架。
- 后端改动。
- `MerchantProfile.tsx` 里 3 个业务对话框的内容重写（只把外壳换成共享 `ConfirmDialog`，内容原样保留；若外壳无法容纳则保留原实现并在 spec 附录记录）。

## 3. 两阶段流程

```
阶段 1（OpenDesign）                       阶段 2（web/）
─────────────────────                      ─────────────────
装设计系统包 seo-ops                        writing-plans 出实施计划
  → create_project(designSystem=seo-ops)     → TDD 实现 5 个组件
  → start_run(skill=frontend-design)         → 逐站点替换
  → get_run 轮询 → previewUrl                → 测试 / lint / build 全绿
  → 用户在 Studio 审阅、改、定稿
```

阶段 2 只有在用户对阶段 1 原型明确说「定稿」后才开始。两个阶段各出一份实施计划：阶段 1 的计划在本 spec 审阅通过后立即写；阶段 2 的计划在定稿后、拿到最终 HTML 之后再写。

## 4. 阶段 1：OpenDesign 原型

### 4.1 设计系统包 `seo-ops`

安装位置（OpenDesign 用户设计系统目录，daemon 启动即扫描）：
`~/Library/Application Support/Open Design/namespaces/release-stable/data/design-systems/seo-ops/`

三个文件，遵循 `od-design-system-project/v1`：

- `manifest.json`：`id: "seo-ops"`，`name: "SEO Ops"`，`category: "Productivity & SaaS"`，`source.type: "local"`，`files: { design: "DESIGN.md", tokens: "tokens.css" }`。
- `tokens.css`：把 `index.css` 的 token 映射到 OpenDesign 的 A1/A2 契约名，值不变：

| OpenDesign token | 取自 index.css | 值 |
|---|---|---|
| `--bg` | `--paper` | `#f5f7f9` |
| `--surface` | `--card` | `#ffffff` |
| `--surface-warm` | `--paper-blue` | `#e8eff5` |
| `--fg` | `--ink` | `#19324a` |
| `--fg-2` | `--ink-2` | `#4f6578` |
| `--muted` | `--muted` | `#8394a4` |
| `--meta` | `--brand-ink` | `#205d7b` |
| `--border` | `--line` | `#d5dfe7` |
| `--border-soft` | 别名 `var(--border)`（现有体系没有更浅的线色） | — |
| `--accent` | `--accent`（主按钮橙） | `#c8731a` |
| `--accent-on` | 固定 | `#ffffff` |
| `--accent-hover` | `button.primary:hover` | `#9d5712` |
| `--success` | `--ok` | `#26765b` |
| `--warn` | `--accent` | `#c8731a` |
| `--danger` | `--bad` | `#b4372e` |
| `--font-body` / `--font-display` | `:root font-family` | `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif` |
| `--font-mono` | `.section-code` | `ui-monospace, "SF Mono", Menlo, monospace` |
| `--text-base` | `body` | `14px` |
| `--leading-body` | `body` | `1.65` |

  额外以 C 层扩展保留原名：`--brand`、`--brand-soft`、`--line-strong`、`--accent-soft`、`--ok-soft`、`--bad-soft`、`--ai`、`--ai-soft`，供原型直接引用。
- `DESIGN.md`：描述现有视觉语言，不发明新方向。要点：瓷灰底 / 白卡片 / 墨蓝主色 / 戳记式状态；`section-code` 眉标（10px 等宽、0.16em 字距、`--brand-ink`）；按钮 8px 圆角、`primary` 橙底白字、`quiet` 透明灰字、`danger-button` 红字白底；对话框骨架 = `header(眉标 + h4 + ×)` / 正文 / `footer(quiet 取消 + primary 确认)`，640px 宽，24px 70px 投影；桌面最小宽 1180；中文界面；`prefers-reduced-motion` 必须降级。

### 4.2 OpenDesign 项目与 run

- `create_project({ name: "seo-ops 反馈模式套件", designSystem: "seo-ops" })`。
- `start_run({ project, skill: "frontend-design", agent: "claude", prompt })`，`requestId` 用一次性 UUID。模型走 Claude Code CLI 默认配置。
- 轮询 `get_run` 到 `succeeded | failed | canceled`；失败则把 `agentMessage` 原样报告给用户，不自动重跑。

prompt 要点（完整文本见附录 A）：单个 `index.html`，桌面 1180px 起，只用 `tokens.css` 的变量，不加载外部库；五个区块，每个区块把变体并排静态展示，不依赖点击才能看到；文案用附录 B 的原句。

### 4.3 原型页内容

| 区块 | 变体 | 说明 |
|---|---|---|
| ConfirmDialog | 删除空白草稿 / 归档商户 / Run 标记 NOT_CREATED；另加一个 busy 态和一个带错误的态 | 沿用 `operation-confirm-dialog` 骨架；主按钮在不可逆场景用 danger 色 |
| ConflictBanner | TaskDetail 文案 / PlanReview 文案；含 busy 态 | 页顶横幅，唯一动作「重新载入」，说明下方写操作已禁用 |
| Notice | error / success / warning × 页级 / 对话框内 | 页级用现有 `.error` `.notice` 形态统一为同一组件的三种 tone |
| Loading | 列表骨架 / 详情骨架 / 按钮 busy | 骨架用 `breathe` 动画，reduced-motion 下静态 |
| EmptyState | 带主操作 / 不带主操作 | 沿用 `.empty-state` 的灰底居中 |

### 4.4 审阅与定稿

- 我把 `previewUrl` 交给用户；用户在 OpenDesign Studio 里看、改。
- 定稿判据：用户明确说「定稿」。届时我用 `get_artifact` 拉最终 HTML/CSS 作为移植依据，存到 `docs/evidence/2026-09-09-feedback-kit/`。

## 5. 阶段 2：移植到 `web/`

### 5.1 组件与接口

放在 `web/src/components/feedback/`，每个组件一个文件，一个 `index.ts` 汇出。

```ts
// ConfirmDialog.tsx
type ConfirmDialogProps = {
  open: boolean
  code: string              // 眉标，如 'MERCHANT / ARCHIVE'
  title: string
  message: ReactNode        // 后果说明；三处现有原句原样传入
  confirmLabel: string
  tone?: 'danger' | 'primary'   // 默认 'danger'
  busy?: boolean
  error?: string            // 显示为对话框内 Notice(error)
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode      // 可选附加内容（参数表、二次输入）
}
```
行为：`role="dialog" aria-modal="true" aria-labelledby`；打开时焦点落到「取消」；Esc = 取消；点击遮罩**不**关闭（都是不可逆操作）；关闭后焦点回到触发按钮；`busy` 时两个按钮都禁用。

```ts
// ConflictBanner.tsx
type ConflictBannerProps = { message: string; reloadLabel?: string; busy?: boolean; onReload: () => void }
// Notice.tsx
type NoticeProps = { tone: 'error' | 'success' | 'warning'; children: ReactNode; inline?: boolean }
//   error → role="alert"；success/warning → role="status"
// LoadingState.tsx
type LoadingStateProps = { variant: 'list' | 'detail' | 'inline'; label: string }   // role="status" aria-label=label
// EmptyState.tsx
type EmptyStateProps = { title: string; description?: string; action?: { label: string; onClick: () => void } }
```

### 5.2 CSS 组织

新建 `web/src/feedback.css`，由 `index.css` 顶部 `@import`。原 `.operation-confirm-*`、`.error`、`.notice`、`.empty-state` 的定义迁入并改成组件类名（`.fb-dialog`、`.fb-banner`、`.fb-notice`、`.fb-skeleton`、`.fb-empty`）；旧类名保留为别名直到所有站点替换完，最后一次提交删除别名。

### 5.3 替换清单

| 站点 | 改法 |
|---|---|
| `MerchantList.tsx:101` 删除空白草稿 | `window.confirm` → `ConfirmDialog`，message 保持原句 |
| `MerchantDetail.tsx:294` 归档商户 | 同上；归档前置阻断逻辑不变（阻断时不弹框） |
| `RunDetail.tsx:286` NOT_CREATED | 同上；原因输入仍在页面表单里，对话框只做二次确认 |
| `TaskDetail.tsx` `conflict` | 「刷新任务」按钮 → `ConflictBanner`，message = 现有 409 文案；`metadataConflict`（本地草稿保留提示）与 409 无关，保持不变 |
| `PlanReview.tsx` `conflicted` | `.plan-conflict-note` + 「重新载入服务器 Plan」 → `ConflictBanner` |
| `MerchantProfile.tsx:1800` 4xx | 当 `status === 409` 时走 `ConflictBanner`；其他 4xx 仍是 `Notice(error)` |
| 各页 `加载中…` | → `LoadingState`，label 沿用各页现有文案 |
| 各页 `.error` / `.notice` | → `Notice` |
| 各页 `.empty-state` | → `EmptyState` |
| `MerchantProfile.tsx` 3 个业务对话框 | 外壳换 `ConfirmDialog` + `children`，内容不动 |

### 5.4 红线（来自 HANDOFF，移植时不得破坏）

- 409 一律不自动重试；`ConflictBanner` 只提供重新载入，重新载入成功后才解除禁用。
- 任何外部写入、付费调用、不可逆操作必须经过 `ConfirmDialog` 的显式点击；不得用「再次点击同一按钮」代替。
- 所有写操作仍用现有乐观锁字段；组件层不碰 API。

### 5.5 测试

现有 3 个用 `vi.stubGlobal('confirm', …)` 的测试改为真实交互：
- `merchantLifecycle.test.tsx` 删除空白草稿：点击删除 → `findByRole('dialog', { name: … })` → 断言原句在对话框内 → 点击确认按钮 → 断言 DELETE 请求。
- `merchantLifecycle.test.tsx` 归档阻断：断言**没有**对话框出现且按钮禁用。
- `runDispatchReconciliation.test.tsx` NOT_CREATED：同删除流程，断言 POST body 不变。

新增组件单测（`components/feedback/*.test.tsx`）：ConfirmDialog 的焦点、Esc、遮罩不关闭、busy 禁用；ConflictBanner 的 role 与 onReload；Notice 的 role 映射；LoadingState 的 `role="status"`；EmptyState 有无 action 两态。

## 6. 错误处理与边界

- OpenDesign run 失败：报告 `agentMessage`，不自动重跑；用户决定重跑或改 prompt。
- OpenDesign 未运行：MCP 配置带自启参数会拉起 headless daemon；若仍连不上，停下报告。
- 设计系统包放错位置或 manifest 不合法：`create_project` 会报找不到 `seo-ops`；先用 `resources/list` 确认 `od://design-systems/seo-ops/DESIGN.md` 出现再建项目。
- 原型里出现设计系统之外的颜色或外部库：视为不合格，让 OpenDesign 按同一 prompt 修，不在移植时「顺手改」。

## 7. 验收

阶段 1：
- `get_run` 状态 `succeeded`，`previewUrl` 可打开。
- 页面含 5 个区块、附录 B 的全部文案、只用 `tokens.css` 变量、无外部资源。
- 用户在 Studio 定稿。

阶段 2：
- `npm test`、`npm run lint`、`npm run build` 全绿。
- `grep -rn "window.confirm" web/src` 为 0。
- 3 处 409 站点都渲染 `ConflictBanner`，且没有任何自动重试。
- 所有对话框、横幅、加载、空态保留或补齐 `role` / `aria-*`。

## 附录 A：OpenDesign run prompt（中文，交给 frontend-design 技能）

> 为「SEO Ops」内部运营控制台制作一页「反馈模式套件」原型，文件名 index.html，桌面 1180px 起，只使用设计系统 seo-ops 的 tokens.css 变量，不引入任何外部字体、图标或脚本库。页面顶部一段说明，然后五个区块，每个区块把所有变体并排静态展示（不需要点击才能看到）。
> 1）确认对话框：三个真实案例（删除空白草稿、归档商户、标记 Core AI 未创建运行），外加一个「提交中」busy 态和一个「提交失败」带错误的态。结构固定为：眉标（等宽小字）+ 标题 + 关闭 ×；正文；底部「取消」（quiet）+ 危险确认按钮。
> 2）冲突横幅：请求返回 409 之后显示在页面顶部，唯一动作是「重新载入」，说明写操作已禁用；给出两条真实文案的版本和一个 busy 态。
> 3）提示：error / success / warning 三种语气，各有页级和对话框内两种位置。
> 4）加载：列表骨架、详情骨架、按钮 busy；骨架用轻微呼吸动画，并在 prefers-reduced-motion 下静止。
> 5）空态：带主操作按钮和不带主操作两种。
> 所有文案使用下面给出的原句，不要改写。整体延续现有语言：瓷灰底、白卡片、墨蓝文字、橙色主按钮、戳记式状态，不要引入渐变、毛玻璃或大圆角。

## 附录 B：必须原样使用的文案

- 删除：`“{商户名}”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？`
- 归档：`归档会关闭自动分析并停止创建新的执行；{N} 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“{商户名}”？`
- NOT_CREATED：`请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。`
- 409（Task）：`任务已变更，请刷新后再操作。`（`TaskDetail.tsx:588`，现按钮名「刷新任务」）
- 409（Plan）：`服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。`（`PlanReview.tsx:723`，现按钮名「重新载入服务器 Plan」）
- 重新载入按钮：统一为 `重新载入`。这是本设计里唯一的文案改动；测试里对「刷新任务」「重新载入服务器 Plan」按钮名的断言随之更新。
- 空态：`当前筛选下没有商户。` / `当前查询条件下没有任务。` / `暂无事件记录。` / `尚未发起分析。第一次分析会在这里生成报告和任务提案。`
- 加载：文本 `加载中…`（MerchantDetail / RunDetail / TaskDetail / MerchantProfile 四处一致）；`aria-label` 沿用各页现有值，如 `正在加载商户资料`

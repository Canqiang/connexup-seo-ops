# SEO Ops

> Category: Productivity & SaaS
> Connexup 内部 SEO 运营控制台的现有视觉语言。本文件描述的是「已经存在的样子」，不是新方向：生成任何界面时延续它，不要重新发明。

## 1. Visual Theme & Atmosphere

内部运营台账：瓷灰底、白卡片、墨蓝文字、橙色主按钮、戳记式状态。密度偏高、克制、可扫读。中文界面，桌面优先（最小宽度 1180px），不做移动端适配。

- **Visual style:** dense operational, calm, print-like
- **Color stance:** light surfaces, one warm accent, semantic colors only for state
- **Design intent:** 让操作员一眼分清「信息」「可执行」「危险 / 不可逆」三类内容。

## 2. Color

- **Background:** `#f5f7f9` — 瓷灰页面底（`--bg`）。
- **Surface:** `#ffffff` — 白卡片、对话框（`--surface`）。
- **Surface warm:** `#e8eff5` — 次级面板底（`--surface-warm`）。
- **Text:** `#19324a` — 墨蓝黑正文（`--fg`）；次级 `#4f6578`（`--fg-2`）；弱化 `#8394a4`（`--muted`）。
- **Border:** `#d5dfe7` — 默认分割线（`--border`）；强调边 `#b9c9d6`（`--line-strong`）。
- **Accent / Primary action:** `#c8731a` 橙 — 只用于主按钮和「需要注意」的提示；hover `#9d5712`。
- **Brand blue:** `#37799a` — 链接、眉标、信息类强调（`--brand`）；深色 `#205d7b`（`--brand-ink`）；浅底 `#e7f2f7`（`--brand-soft`）。
- **Success:** `#26765b`，浅底 `#e5f2ed`。
- **Warning:** 复用橙 `#c8731a`，浅底 `#fff5e8`。
- **Danger:** `#b4372e`，浅底 `#f9e9e7`。
- **AI:** `#6b46a8`，浅底 `#f0e9f9` — 只标记 AI 生成内容。

语义色面积控制在 5% 以内；大面积永远是灰底 + 白卡片。

## 3. Typography

- **Families:** 正文与标题都用 `"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`；眉标、代码、ID 用 `ui-monospace, "SF Mono", Menlo, monospace`。
- **Scale:** 10 / 12 / 14 / 16 / 18 / 24 / 32 / 40 px；正文 14px，行高 1.65。
- **眉标（section-code / eyebrow）:** 10px 等宽、600 字重、`letter-spacing: 0.16em`、颜色 `#205d7b`、全大写英文，如 `LOCAL FALCON / PAID SCAN`。
- 标题不加装饰；对话框标题 18px。

## 4. Spacing & Grid

- 4px 基准；常用 8 / 12 / 16 / 20 / 24 / 32 / 48。
- 卡片内边距 18–22px；对话框 header / footer 各 18px 22px。
- 内容最大宽 1380px，左侧固定导航栏。

## 5. Layout & Composition

- 页面 = 眉标 + 标题 + 一句摘要，然后是卡片或表格。
- 信息用表格和 `dl` 参数表呈现，不用大图和插画。
- 层级靠留白和 1px 分割线，不靠阴影；阴影只给浮层。

## 6. Components

- **Button:** 高 34–42px，8px 圆角，1px 边。默认白底灰字；`primary` 橙底白字 500 字重；`quiet` 透明底灰字；`danger-button` 白底红字红边。禁用态灰底白字。
- **Stamp（状态戳）:** 小号大写文字 + 浅色底 + 同色系深色字，矩形，不用圆角药丸。
- **Confirm dialog（operation-confirm-dialog）:** 640px 宽（人工对账 720px）；白底、1px `#b9c9d6` 边、阴影 `0 24px 70px rgb(25 50 74 / 22%)`。结构固定：
  - header：左边眉标 + 18px 标题，右边 34px 的 `×` 关闭按钮；底部 1px 分割线；
  - body：后果说明段落；可选参数表（`dl`）或二次输入；错误提示放在这里，红字红底；
  - footer：右对齐，`quiet` 取消 + 主按钮；底色 `#fbfcfd`，顶部 1px 分割线。不可逆操作的主按钮用 danger 色。
- **Notice:** 页级提示是一条 8px 12px 内边距、8px 圆角、浅色底、同色系文字的横条；success 用绿、error 用红、warning 用橙。
- **Empty state:** 最小高 116px，居中，灰字 13px，底色 `#fbfcfd`。
- **Loading:** 文本 `加载中…`，配 `role="status"`。骨架块用 `breathe` 呼吸动画（opacity 1 → 0.25 → 1）。

## 7. Motion & Interaction

- 过渡 120–200ms，`cubic-bezier(0.2, 0, 0, 1)`。
- 浮层进入：轻微位移 + 淡入；不做缩放弹跳。
- `prefers-reduced-motion: reduce` 下所有动画静止，只保留状态变化。

## 8. Voice & Brand

- 全部中文，短句，陈述事实和后果，不用感叹号。
- 危险操作的文案先说后果再问确认，例如「删除空白草稿后无法恢复，确认删除？」。
- 英文只出现在眉标、ID 和技术名词（GBP、FBR、Core AI、Local Falcon、revision）。

## 9. Anti-patterns

- 渐变、毛玻璃、大圆角（>8px）、彩色阴影、装饰性插画或图标行。
- 用颜色代替文字表达状态。
- 点击遮罩关闭确认对话框；按钮文案「OK」「Yes」。
- 引入外部字体、图标库、脚本库。

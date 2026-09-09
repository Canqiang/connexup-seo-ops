# Feedback Kit Phase 2 (Port to web/) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved OpenDesign prototype (`docs/evidence/2026-09-09-feedback-kit/prototype/index.html`) into five shared React components and replace every hand-rolled confirm, 409 conflict, error/success notice, loading text and empty state in `web/src` with them.

**Architecture:** Five components under `web/src/components/feedback/`, one file each, styled by a new `web/src/feedback.css` that `index.css` imports first. Components own markup, roles and focus behaviour; pages keep their state machines and only swap the rendered element. `window.confirm` disappears; the three 409 handlers converge on `ConflictBanner`. Old page-specific CSS is deleted only after a grep proves it unused.

**Tech Stack:** React 19, TypeScript 6 (`verbatimModuleSyntax`, `noUnusedLocals`), Vite 8, Vitest 4 + @testing-library/react 16 (jsdom, no jest-dom matchers: assert with plain `expect` on DOM properties), oxlint.

**Spec:** `docs/superpowers/specs/2026-09-09-feedback-consistency-design.md` (section 5 and 7; appendix B for copy). Prototype: `docs/evidence/2026-09-09-feedback-kit/prototype/index.html` (CSS lines 254–419 are the visual source of truth).

## Global Constraints

- 409 is never auto-retried. `ConflictBanner` offers exactly one action, `重新载入`, and pages disable every write control while conflicted (spec 5.4).
- Irreversible actions go through `ConfirmDialog` with an explicit click on the confirm button; the confirm copy is byte-identical to the current strings (spec appendix B).
- The only copy change in this phase: the conflict reload button is `重新载入` (was `刷新任务` in TaskDetail and `重新载入服务器 Plan` in PlanReview). `重新加载 Plan 与商户状态` (non-conflict reload) and `刷新任务状态` are different actions and stay.
- Loading text is `加载中…` with `role="status"`; empty-state copy stays exactly as today.
- No UI library, no backend change, no new npm dependency.
- All buttons reuse the existing base `button` rule plus `.primary` / `.quiet`; the only new button class is `danger-solid`.
- Tests: `cd web && npm test` (vitest, jsdom). Lint: `npm run lint` (oxlint). Build: `npm run build` (tsc + vite). All three green before every commit.
- Commits: Conventional Commits prefix, trailer block as in earlier commits of this session.
- Work happens in worktree `.worktrees/feedback-kit-phase-2` on branch `feedback-kit-phase-2` (user preference from phase 1). Every path below is relative to the worktree root unless it starts with `web/`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `web/src/feedback.css` | All feedback-component styles (`.fb-*`, `button.danger-solid`, updated `.empty-state`). Imported by `index.css` as its first statement. |
| `web/src/components/feedback/Notice.tsx` | Tone-coloured message strip; `error` → `role="alert"`, others `role="status"`; optional action button. |
| `web/src/components/feedback/EmptyState.tsx` | Grey centred empty block with optional primary action. |
| `web/src/components/feedback/LoadingState.tsx` | `加载中…` status text, optionally with list or detail skeleton. |
| `web/src/components/feedback/ConfirmDialog.tsx` | Modal confirm: eyebrow + title + close, body, cancel + confirm; Esc cancels, backdrop does not, focus trapped and restored. |
| `web/src/components/feedback/ConflictBanner.tsx` | 409 banner with `重新载入`. |
| `web/src/components/feedback/index.ts` | Re-exports. |
| `web/src/components/feedback/*.test.tsx` | One test file per component. |
| Modified pages | `MerchantList`, `MerchantDetail`, `RunDetail`, `TaskDetail`, `PlanReview`, `MerchantProfile`, `TasksOverview`, `PerformanceDashboard`, `App.tsx`. |
| Modified tests | `merchantLifecycle.test.tsx`, `runDispatchReconciliation.test.tsx`, `App.test.tsx`. |
| `web/src/index.css` | Gains the import; loses rules that become unused (Task 11). |
| Spec appendix C | Records the one dialog left on its own shell (Local Falcon reconciliation). |

---

### Task 0: Worktree and baseline

**Files:** none.

- [ ] **Step 1: Create the worktree from current `main`**

```bash
cd /Users/xander/git_repo/connexup-seo-ops
git worktree add .worktrees/feedback-kit-phase-2 -b feedback-kit-phase-2
```
Then enter it with the native worktree tool (`EnterWorktree` with `path`).

- [ ] **Step 2: Install and baseline**

Run: `cd web && npm ci --no-audit --no-fund && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -3`
Expected: `Tests  395 passed (395)`, lint clean, build `✓ built`.

---

### Task 1: Styles, `Notice`, `EmptyState`, `LoadingState`

**Files:**
- Create: `web/src/feedback.css`
- Modify: `web/src/index.css:1` (add import)
- Create: `web/src/components/feedback/Notice.tsx`, `EmptyState.tsx`, `LoadingState.tsx`, `index.ts`
- Test: `web/src/components/feedback/Notice.test.tsx`, `EmptyState.test.tsx`, `LoadingState.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type NoticeTone = 'error' | 'success' | 'warning'
  export type NoticeAction = { label: string; onClick: () => void; disabled?: boolean }
  export function Notice(props: { tone: NoticeTone; children: ReactNode; action?: NoticeAction; id?: string; className?: string }): JSX.Element
  export function EmptyState(props: { children: ReactNode; action?: NoticeAction; compact?: boolean; className?: string }): JSX.Element
  export function LoadingState(props: { variant?: 'inline' | 'list' | 'detail'; label?: string; rows?: number; className?: string }): JSX.Element
  ```

- [ ] **Step 1: Write the failing tests**

`web/src/components/feedback/Notice.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notice } from './Notice'

afterEach(cleanup)

describe('Notice', () => {
  it('renders error as an alert with the error tone class', () => {
    render(<Notice tone="error">请求校验失败：商户名称不能为空</Notice>)
    const el = screen.getByRole('alert')
    expect(el.className).toContain('fb-notice-error')
    expect(el.textContent).toBe('请求校验失败：商户名称不能为空')
  })

  it('renders success and warning as status', () => {
    render(<><Notice tone="success">已保存。</Notice><Notice tone="warning">此操作将消耗 Local Falcon credits</Notice></>)
    const [ok, warn] = screen.getAllByRole('status')
    expect(ok.className).toContain('fb-notice-success')
    expect(warn.className).toContain('fb-notice-warning')
  })

  it('renders an optional action button', () => {
    const onClick = vi.fn()
    render(<Notice tone="error" action={{ label: '重试读取', onClick }}>读取失败</Notice>)
    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
```

`web/src/components/feedback/EmptyState.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EmptyState } from './EmptyState'

afterEach(cleanup)

describe('EmptyState', () => {
  it('renders copy without a button by default', () => {
    render(<EmptyState>当前筛选下没有商户。</EmptyState>)
    expect(screen.getByText('当前筛选下没有商户。').closest('.empty-state')).not.toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders a primary action when given', () => {
    const onClick = vi.fn()
    render(<EmptyState action={{ label: '发起分析', onClick }}>尚未发起分析。第一次分析会在这里生成报告和任务提案。</EmptyState>)
    const button = screen.getByRole('button', { name: '发起分析' })
    expect(button.className).toContain('primary')
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('adds the compact class', () => {
    render(<EmptyState compact>正在读取 Task Plan…</EmptyState>)
    expect(screen.getByText('正在读取 Task Plan…').closest('.empty-state')?.className).toContain('compact-empty')
  })
})
```

`web/src/components/feedback/LoadingState.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LoadingState } from './LoadingState'

afterEach(cleanup)

describe('LoadingState', () => {
  it('renders 加载中… as a status by default', () => {
    render(<LoadingState />)
    expect(screen.getByRole('status').textContent).toBe('加载中…')
  })

  it('renders a list skeleton hidden from assistive tech', () => {
    const { container } = render(<LoadingState variant="list" rows={3} />)
    expect(screen.getByRole('status').textContent).toBe('加载中…')
    const hidden = container.querySelector('[aria-hidden="true"]')
    expect(hidden).not.toBeNull()
    expect(hidden!.querySelectorAll('.fb-sk-row').length).toBe(4) // header + 3 rows
  })

  it('accepts a custom label', () => {
    render(<LoadingState label="正在读取 Plan…" />)
    expect(screen.getByRole('status').textContent).toBe('正在读取 Plan…')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/components/feedback`
Expected: 3 files fail with `Failed to resolve import "./Notice"` (and EmptyState, LoadingState).

- [ ] **Step 3: Write `feedback.css`**

```css
/* 反馈模式套件 —— 由 docs/evidence/2026-09-09-feedback-kit/prototype/index.html 移植。
   五个模式：ConfirmDialog / ConflictBanner / Notice / LoadingState / EmptyState。
   只用 index.css 已有的 token；派生色直接写既有字面量。 */

/* ---- 按钮补充：实心危险按钮 ---- */
button.danger-solid {
  background: var(--bad);
  border-color: var(--bad);
  color: #fff;
  font-weight: 500;
}
button.danger-solid:hover:not(:disabled) { background: #9f312e; border-color: #9f312e; color: #fff; }
button.danger-solid:disabled { background: var(--muted); border-color: var(--muted); color: #fff; }
button[aria-busy="true"] { cursor: progress; }

/* ---- 戳记 ---- */
.fb-stamp {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  font: 600 10px/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
  background: var(--paper-blue);
  color: var(--brand-ink);
}
.fb-stamp-on-warn { background: var(--card); color: #9d5712; box-shadow: inset 0 0 0 1px #e5bb87; }

/* ---- Notice ---- */
.fb-notice {
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1.5;
}
.fb-notice > span { flex: 1; min-width: 0; }
.fb-notice-error { background: var(--bad-soft); color: var(--bad); }
.fb-notice-success { background: var(--ok-soft); color: var(--ok); }
.fb-notice-warning { background: var(--accent-soft); color: #9d5712; }
.fb-notice + .fb-notice { margin-top: 8px; }
.fb-notice button { flex: none; }

/* ---- Confirm dialog ---- */
.fb-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  padding: 32px;
  background: rgb(25 50 74 / 30%);
}
.fb-dialog {
  width: min(640px, calc(100vw - 96px));
  max-height: min(720px, calc(100vh - 64px));
  overflow: auto;
  background: var(--card);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  box-shadow: 0 24px 70px rgb(25 50 74 / 22%);
}
.fb-dialog-wide { width: min(720px, calc(100vw - 96px)); }
.fb-dialog-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--line);
}
.fb-dialog-title { margin: 4px 0 0; color: var(--ink); font-size: 18px; line-height: 1.35; font-weight: 600; }
.fb-dialog .dialog-close { border-radius: 8px; font-size: 20px; }
.fb-dialog .dialog-close:disabled { background: #fbfcfd; color: var(--muted); cursor: not-allowed; }
.fb-dialog-body { display: grid; gap: 12px; padding: 20px 22px; }
.fb-dialog-body > p { margin: 0; }
.fb-dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  padding: 18px 22px;
  border-top: 1px solid var(--line);
  background: #fbfcfd;
  border-radius: 0 0 8px 8px;
}

/* ---- Conflict banner (409) ---- */
.fb-conflict {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 0 16px;
  padding: 10px 24px;
  background: var(--accent-soft);
  border-bottom: 1px solid #e5bb87;
  color: #9d5712;
}
.fb-conflict-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.fb-conflict-text p { margin: 0; font-weight: 500; }
.fb-conflict-detail { font-size: 12px; font-weight: 400; color: #8c4c0d; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.fb-conflict-actions { display: flex; align-items: center; gap: 12px; }
.fb-conflict-status { font-size: 12px; color: #9d5712; }

/* ---- Loading ---- */
.fb-loading { margin: 0; color: var(--ink-2); font-size: 13px; }
.fb-loading-card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.fb-loading-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
}
.fb-loading-text { font-size: 12px; color: var(--ink-2); }
.fb-skeleton {
  height: 12px;
  border-radius: 4px;
  background: var(--paper-blue);
  animation: breathe 1.6s ease-in-out infinite;
}
.fb-skeleton-stamp { width: 56px; height: 18px; }
.fb-sk-row {
  display: grid;
  grid-template-columns: 2fr 72px 1fr 1fr 96px;
  align-items: center;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
}
.fb-sk-row:last-child { border-bottom: 0; }
.fb-sk-row-head { padding: 10px 16px; background: #fbfcfd; }
.fb-sk-row-head .fb-skeleton { height: 8px; }
.fb-sk-detail { display: grid; gap: 20px; padding: 20px; }
.fb-sk-title { display: grid; gap: 10px; }
.fb-sk-dl { display: grid; grid-template-columns: 88px 1fr; align-items: center; gap: 14px 16px; }

/* ---- Empty state（覆盖 index.css 的旧规则） ---- */
.empty-state {
  min-height: 116px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 12px;
  padding: 20px;
  text-align: center;
  background: #fbfcfd;
  color: var(--ink-2);
  font-size: 13px;
  line-height: 1.6;
}
.empty-state p { margin: 0; max-width: 36em; }

@media (prefers-reduced-motion: reduce) {
  .fb-skeleton { animation: none; }
}
```

- [ ] **Step 4: Import it from `index.css`**

Replace the first line of `web/src/index.css` (the comment `/* seo-ops 台账视觉系统 —— 瓷灰底 / 白卡片 / 墨蓝主色 / 戳记式状态 */`) with:
```css
@import './feedback.css';
/* seo-ops 台账视觉系统 —— 瓷灰底 / 白卡片 / 墨蓝主色 / 戳记式状态 */
```
Because `@import` must precede every other rule, the file's later `.empty-state` rule (line ~2418) will override the imported one. Delete that old `.empty-state { … }` block (the 8 lines from `.empty-state {` to its closing `}`) now so the imported rule wins. `@keyframes breathe` stays in `index.css` (line ~425); `feedback.css` relies on it.

- [ ] **Step 5: Write the three components**

`web/src/components/feedback/Notice.tsx`:
```tsx
import type { ReactNode } from 'react'

export type NoticeTone = 'error' | 'success' | 'warning'
export type NoticeAction = { label: string; onClick: () => void; disabled?: boolean }

type NoticeProps = {
  tone: NoticeTone
  children: ReactNode
  action?: NoticeAction
  id?: string
  className?: string
}

export function Notice({ tone, children, action, id, className }: NoticeProps) {
  const classes = ['fb-notice', `fb-notice-${tone}`, className].filter(Boolean).join(' ')
  return (
    <div className={classes} role={tone === 'error' ? 'alert' : 'status'} id={id}>
      <span>{children}</span>
      {action && (
        <button type="button" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>
      )}
    </div>
  )
}
```

`web/src/components/feedback/EmptyState.tsx`:
```tsx
import type { ReactNode } from 'react'
import type { NoticeAction } from './Notice'

type EmptyStateProps = {
  children: ReactNode
  action?: NoticeAction
  compact?: boolean
  className?: string
}

export function EmptyState({ children, action, compact, className }: EmptyStateProps) {
  const classes = ['empty-state', compact ? 'compact-empty' : null, className].filter(Boolean).join(' ')
  return (
    <div className={classes}>
      <p>{children}</p>
      {action && (
        <button type="button" className="primary" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>
      )}
    </div>
  )
}
```

`web/src/components/feedback/LoadingState.tsx`:
```tsx
type LoadingStateProps = {
  variant?: 'inline' | 'list' | 'detail'
  label?: string
  rows?: number
  className?: string
}

const LIST_WIDTHS = [
  ['72%', null, '60%', '45%', '100%'],
  ['58%', null, '70%', '40%', '100%'],
  ['80%', null, '52%', '48%', '100%'],
  ['64%', null, '66%', '36%', '100%'],
  ['70%', null, '58%', '50%', '100%'],
] as const

function Bar({ width, stamp }: { width?: string | null; stamp?: boolean }) {
  return <div className={stamp ? 'fb-skeleton fb-skeleton-stamp' : 'fb-skeleton'} style={width ? { width } : undefined} />
}

export function LoadingState({ variant = 'inline', label = '加载中…', rows = 5, className }: LoadingStateProps) {
  if (variant === 'inline') {
    return <p className={['fb-loading', className].filter(Boolean).join(' ')} role="status">{label}</p>
  }
  return (
    <div className={['fb-loading-card', className].filter(Boolean).join(' ')}>
      <div className="fb-loading-head"><span className="fb-loading-text" role="status">{label}</span></div>
      {variant === 'list' ? (
        <div aria-hidden="true">
          <div className="fb-sk-row fb-sk-row-head">
            <Bar width="40%" /><Bar width="70%" /><Bar width="55%" /><Bar width="45%" /><Bar width="60%" />
          </div>
          {Array.from({ length: rows }, (_, index) => {
            const widths = LIST_WIDTHS[index % LIST_WIDTHS.length]
            return (
              <div className="fb-sk-row" key={index}>
                {widths.map((width, cell) => <Bar key={cell} width={width} stamp={width === null} />)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="fb-sk-detail" aria-hidden="true">
          <div className="fb-sk-title"><Bar width="96px" /><Bar width="220px" /></div>
          <div className="fb-sk-dl">
            <Bar width="64px" /><Bar width="60%" />
            <Bar width="48px" /><Bar stamp />
            <Bar width="72px" /><Bar width="76%" />
            <Bar width="56px" /><Bar width="32%" />
            <Bar width="64px" /><Bar width="54%" />
          </div>
        </div>
      )}
    </div>
  )
}
```

`web/src/components/feedback/index.ts`:
```ts
export { Notice } from './Notice'
export type { NoticeAction, NoticeTone } from './Notice'
export { EmptyState } from './EmptyState'
export { LoadingState } from './LoadingState'
```
(ConfirmDialog and ConflictBanner exports are appended in Tasks 2 and 3.)

- [ ] **Step 6: Run the tests, lint, build**

Run: `cd web && npx vitest run src/components/feedback && npm run lint && npm run build 2>&1 | tail -2`
Expected: 9 tests pass; lint clean; build ok.

- [ ] **Step 7: Commit**

```bash
git add web/src/feedback.css web/src/index.css web/src/components/feedback
git commit -m "feat(web): add Notice, EmptyState and LoadingState feedback components"
```

---

### Task 2: `ConfirmDialog`

**Files:**
- Create: `web/src/components/feedback/ConfirmDialog.tsx`
- Test: `web/src/components/feedback/ConfirmDialog.test.tsx`
- Modify: `web/src/components/feedback/index.ts`

**Interfaces:**
- Consumes: `Notice` from Task 1.
- Produces:
  ```ts
  export type ConfirmDialogProps = {
    open: boolean
    code: string                 // eyebrow, e.g. 'MERCHANT / ARCHIVE'
    title: string
    message?: ReactNode          // string → <p>; element → as-is
    confirmLabel: string
    busyLabel?: string           // default '提交中…'
    tone?: 'danger' | 'primary'  // default 'danger'
    busy?: boolean
    error?: string
    closeLabel?: string          // default '关闭'
    wide?: boolean               // 720px shell
    onConfirm: () => void
    onCancel: () => void
    children?: ReactNode
  }
  export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element | null
  ```

- [ ] **Step 1: Write the failing test**

`web/src/components/feedback/ConfirmDialog.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialog } from './ConfirmDialog'

afterEach(cleanup)

const base = {
  open: true,
  code: 'DRAFT / DELETE',
  title: '删除空白草稿',
  message: '“误建空白草稿”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？',
  confirmLabel: '确认删除',
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ConfirmDialog {...base} open={false} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('is a labelled modal that focuses 取消 and confirms on click', () => {
    const onConfirm = vi.fn()
    render(<ConfirmDialog {...base} onConfirm={onConfirm} onCancel={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: '删除空白草稿' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
    screen.getByText(base.message)
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape and on the close button, never on backdrop click', () => {
    const onCancel = vi.fn()
    const { container } = render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.click(container.querySelector('.fb-backdrop')!)
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('disables everything and shows the busy label while busy', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog {...base} busy onConfirm={() => {}} onCancel={onCancel} />)
    const confirm = screen.getByRole('button', { name: '提交中…' }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.getAttribute('aria-busy')).toBe('true')
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '关闭' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('shows the error inside the body and keeps buttons enabled', () => {
    render(<ConfirmDialog {...base} error="请求校验失败：商户名称不能为空" onConfirm={() => {}} onCancel={() => {}} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toBe('请求校验失败：商户名称不能为空')
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBe(alert.id)
    expect((screen.getByRole('button', { name: '确认删除' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('restores focus to the opener when it closes', () => {
    function Harness() {
      return <><button type="button">打开</button><ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} /></>
    }
    const { rerender } = render(<Harness />)
    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    rerender(<><button type="button">打开</button><ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} /></>)
    rerender(<><button type="button">打开</button><ConfirmDialog {...base} open={false} onConfirm={() => {}} onCancel={() => {}} /></>)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '打开' }))
  })

  it('traps Tab inside the dialog', () => {
    render(<ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} />)
    const close = screen.getByRole('button', { name: '关闭' })
    const confirm = screen.getByRole('button', { name: '确认删除' })
    confirm.focus()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(confirm)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/components/feedback/ConfirmDialog.test.tsx`
Expected: `Failed to resolve import "./ConfirmDialog"`.

- [ ] **Step 3: Write the component**

```tsx
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Notice } from './Notice'

export type ConfirmDialogProps = {
  open: boolean
  code: string
  title: string
  message?: ReactNode
  confirmLabel: string
  busyLabel?: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  error?: string
  closeLabel?: string
  wide?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function ConfirmDialog({
  open, code, title, message, confirmLabel, busyLabel = '提交中…', tone = 'danger',
  busy = false, error, closeLabel = '关闭', wide = false, onConfirm, onCancel, children,
}: ConfirmDialogProps) {
  const titleId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    cancelRef.current?.focus()
    return () => {
      const opener = openerRef.current
      openerRef.current = null
      if (opener && opener.isConnected) opener.focus()
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy) onCancel()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fb-backdrop">
      <section
        ref={dialogRef}
        className={wide ? 'fb-dialog fb-dialog-wide' : 'fb-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? errorId : undefined}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        <header className="fb-dialog-header">
          <div>
            <p className="section-code">{code}</p>
            <h4 className="fb-dialog-title" id={titleId}>{title}</h4>
          </div>
          <button type="button" className="dialog-close" aria-label={closeLabel} onClick={onCancel} disabled={busy}>×</button>
        </header>
        <div className="fb-dialog-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
          {children}
          {error && <Notice tone="error" id={errorId}>{error}</Notice>}
        </div>
        <footer className="fb-dialog-footer">
          <button type="button" className="quiet" ref={cancelRef} onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger-solid' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}
```

Append to `index.ts`:
```ts
export { ConfirmDialog } from './ConfirmDialog'
export type { ConfirmDialogProps } from './ConfirmDialog'
```

- [ ] **Step 4: Run tests, lint, build**

Run: `cd web && npx vitest run src/components/feedback && npm run lint && npm run build 2>&1 | tail -2`
Expected: 16 tests pass; lint and build clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/feedback
git commit -m "feat(web): add ConfirmDialog with focus trap and busy state"
```

---

### Task 3: `ConflictBanner`

**Files:**
- Create: `web/src/components/feedback/ConflictBanner.tsx`
- Test: `web/src/components/feedback/ConflictBanner.test.tsx`
- Modify: `web/src/components/feedback/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export function ConflictBanner(props: { message: string; detail?: string; busy?: boolean; onReload: () => void }): JSX.Element
  ```
  Renders `role="alert"`, a `409` stamp, `message` in its own `<p>` (so `getByText(message)` matches), optional `detail` (raw server text) in a second `<p>`, and one button `重新载入` (disabled + `aria-busy` while busy, with a `加载中…` status beside it).

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictBanner } from './ConflictBanner'

afterEach(cleanup)

describe('ConflictBanner', () => {
  it('is an alert with the message, the 409 stamp and a single 重新载入 action', () => {
    const onReload = vi.fn()
    render(<ConflictBanner message="任务已变更，请刷新后再操作。" onReload={onReload} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent).toContain('409')
    screen.getByText('任务已变更，请刷新后再操作。')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '重新载入' }))
    expect(onReload).toHaveBeenCalledTimes(1)
    expect(screen.getByText('写操作已禁用')).not.toBeNull()
  })

  it('shows the raw server detail separately', () => {
    render(<ConflictBanner message="服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。" detail="plan revision changed; refresh and retry" onReload={() => {}} />)
    screen.getByText('服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。')
    screen.getByText('plan revision changed; refresh and retry')
  })

  it('disables the button and shows 加载中… while busy', () => {
    render(<ConflictBanner message="任务已变更，请刷新后再操作。" busy onReload={() => {}} />)
    const button = screen.getByRole('button', { name: '重新载入' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('加载中…')
    expect(screen.queryByText('写操作已禁用')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/components/feedback/ConflictBanner.test.tsx`
Expected: `Failed to resolve import "./ConflictBanner"`.

- [ ] **Step 3: Write the component**

```tsx
type ConflictBannerProps = {
  message: string
  detail?: string
  busy?: boolean
  onReload: () => void
}

export function ConflictBanner({ message, detail, busy = false, onReload }: ConflictBannerProps) {
  return (
    <div className="fb-conflict" role="alert" aria-busy={busy || undefined}>
      <span className="fb-stamp fb-stamp-on-warn">409</span>
      <div className="fb-conflict-text">
        <p>{message}</p>
        {detail && <p className="fb-conflict-detail">{detail}</p>}
      </div>
      <div className="fb-conflict-actions">
        {busy
          ? <span className="fb-conflict-status" role="status">加载中…</span>
          : <span className="fb-stamp fb-stamp-on-warn">写操作已禁用</span>}
        <button type="button" className="primary" onClick={onReload} disabled={busy} aria-busy={busy || undefined}>重新载入</button>
      </div>
    </div>
  )
}
```

Append to `index.ts`: `export { ConflictBanner } from './ConflictBanner'`

- [ ] **Step 4: Run tests, lint, build**

Run: `cd web && npx vitest run src/components/feedback && npm run lint && npm run build 2>&1 | tail -2`
Expected: 19 tests pass; lint and build clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/feedback
git commit -m "feat(web): add ConflictBanner for 409 responses"
```

---

### Task 4: MerchantList — delete confirm, error, empty state

**Files:**
- Modify: `web/src/pages/MerchantList.tsx:1-5, 28-29, 96-117, 119, 237`
- Modify: `web/src/merchantLifecycle.test.tsx:296-347`

**Interfaces:**
- Consumes: `ConfirmDialog`, `Notice`, `EmptyState` from `../components/feedback`.

- [ ] **Step 1: Update the delete test to drive the dialog**

In `merchantLifecycle.test.tsx`, inside `it('offers guarded deletion only for an eligible archived blank draft', …)`:
- Delete the two lines `const confirmMock = vi.fn(() => true)` and `vi.stubGlobal('confirm', confirmMock)`.
- Replace
  ```tsx
  fireEvent.click(deleteButton)

  expect(confirmMock).toHaveBeenCalledWith(
    '“误建空白草稿”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？',
  )
  ```
  with
  ```tsx
  fireEvent.click(deleteButton)

  const dialog = await screen.findByRole('dialog', { name: '删除空白草稿' })
  within(dialog).getByText('“误建空白草稿”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？')
  expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
  ```
- Add `within` to the `@testing-library/react` import on line 3.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web && npx vitest run src/merchantLifecycle.test.tsx -t "guarded deletion"`
Expected: FAIL, `Unable to find role="dialog"`.

- [ ] **Step 3: Replace `window.confirm` with `ConfirmDialog`**

Imports (top of `MerchantList.tsx`):
```tsx
import { ConfirmDialog, EmptyState, Notice } from '../components/feedback'
```
State (next to `deletingId`):
```tsx
const [pendingDelete, setPendingDelete] = useState<MerchantStats | null>(null)
const [deleteError, setDeleteError] = useState('')
```
Replace the whole `removeBlankDraft` function with:
```tsx
const requestBlankDraftRemoval = (event: React.MouseEvent, merchant: MerchantStats) => {
  event.preventDefault()
  event.stopPropagation()
  if (!merchant.can_delete || deletingId !== null) return
  setDeleteError('')
  setPendingDelete(merchant)
}

const removeBlankDraft = async () => {
  const merchant = pendingDelete
  if (!merchant || deletingId !== null) return
  setDeletingId(merchant.id)
  try {
    await api.deleteMerchant(merchant.id)
    setMerchants(current => current.filter(item => item.id !== merchant.id))
    setError('')
    setPendingDelete(null)
  } catch (err) {
    setDeleteError((err as Error).message)
  } finally {
    setDeletingId(null)
  }
}
```
Change the button's `onClick={event => void removeBlankDraft(event, m)}` to `onClick={event => requestBlankDraftRemoval(event, m)}`.

Replace `{error && <p className="error">{error}</p>}` with `{error && <Notice tone="error">{error}</Notice>}`.

Replace `<div className="empty-state">当前筛选下没有商户。</div>` with `<EmptyState>当前筛选下没有商户。</EmptyState>`.

Before the closing `</main>`, add:
```tsx
<ConfirmDialog
  open={pendingDelete !== null}
  code="DRAFT / DELETE"
  title="删除空白草稿"
  message={pendingDelete ? `“${pendingDelete.name}”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？` : ''}
  confirmLabel="确认删除"
  busyLabel="删除中…"
  busy={deletingId !== null}
  error={deleteError}
  onConfirm={() => void removeBlankDraft()}
  onCancel={() => { if (deletingId === null) { setPendingDelete(null); setDeleteError('') } }}
/>
```

- [ ] **Step 4: Run the full suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all pass (395 + 19 new = 414). If `App.test.tsx` fails on `getByRole('alert')` finding several alerts, narrow that query in the test to `getAllByRole('alert')[0]` or a `within(...)` scope — do not remove the role from the component.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/MerchantList.tsx web/src/merchantLifecycle.test.tsx
git commit -m "feat(web): confirm blank-draft deletion in ConfirmDialog"
```

---

### Task 5: MerchantDetail — archive confirm, notices, loading, empty states

**Files:**
- Modify: `web/src/pages/MerchantDetail.tsx:1-9, 288-306, 331-338, 490-499, 605, 658`
- Modify: `web/src/merchantLifecycle.test.tsx:684-724` (archive block test)

- [ ] **Step 1: Update the archive-block test**

In `it('blocks archiving when a known task is running or awaiting review', …)`: delete `const confirmMock = vi.fn(() => true)` and `vi.stubGlobal('confirm', confirmMock)`; replace `expect(confirmMock).not.toHaveBeenCalled()` with `expect(screen.queryByRole('dialog')).toBeNull()`.

Add a new test right after it:
```tsx
it('archives only after the operator confirms in the dialog', async () => {
  window.history.pushState({}, '', '/merchants/1')
  const merchantRecord = {
    id: 1, name: '在营商户', status: 'active', notes: null, primary_location: null,
    website_url: null, auto_run_interval_days: 7, created_at: '2026-09-02T00:00:00Z',
  }
  const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/api/merchants/1' && init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ...merchantRecord, status: 'archived' }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => input === '/api/merchants/1'
        ? merchantRecord
        : input === '/api/merchants/1/tasks'
          ? [{ ...activeTask, id: 6, status: 'PENDING' }]
          : [],
    }
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)

  fireEvent.click(await screen.findByRole('button', { name: '归档商户' }))
  const dialog = await screen.findByRole('dialog', { name: '归档商户' })
  within(dialog).getByText('归档会关闭自动分析并停止创建新的执行；1 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“在营商户”？')
  expect(fetchMock.mock.calls.some(([input, init]) => input === '/api/merchants/1' && (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }))
  await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (
    input === '/api/merchants/1' && (init as RequestInit | undefined)?.method === 'PATCH'
  ))).toBe(true))
  await screen.findByText('商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。')
  expect(screen.queryByRole('dialog')).toBeNull()
})
```

- [ ] **Step 2: Run to verify the new test fails**

Run: `cd web && npx vitest run src/merchantLifecycle.test.tsx -t "confirms in the dialog"`
Expected: FAIL, `Unable to find role="dialog"`.

- [ ] **Step 3: Port the page**

Import: `import { ConfirmDialog, EmptyState, LoadingState, Notice } from '../components/feedback'`

State (with the other `useState` calls): 
```tsx
const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false)
const [archiveBusy, setArchiveBusy] = useState(false)
const [archiveError, setArchiveError] = useState('')
```
Replace `toggleArchive` with two functions:
```tsx
const toggleArchive = () => {
  if (!merchant) return
  if (merchant.status === 'active') {
    const archiveBlockingTaskCount = tasks.filter(taskBlocksArchive).length
    if (archiveBlockingTaskCount > 0 || hasRunning) return
    setArchiveError('')
    setArchiveConfirmOpen(true)
    return
  }
  void applyArchiveToggle()
}

const applyArchiveToggle = async () => {
  if (!merchant || archiveBusy) return
  setArchiveBusy(true)
  try {
    const updated = await api.patchMerchant(merchant.id, { status: merchant.status === 'active' ? 'archived' : 'active' })
    setMerchant(updated)
    if (updated.status === 'archived') setShowCreate(false)
    setActionError('')
    setArchiveConfirmOpen(false)
  } catch (err) {
    if (merchant.status === 'active') setArchiveError((err as Error).message)
    else setActionError((err as Error).message)
  } finally {
    setArchiveBusy(false)
  }
}
```
`todoCount` moves into the dialog message:
```tsx
const todoCount = tasks.filter(task => TODO_STATUSES.includes(task.status)).length
```
(declare it once after `merchant` is known, next to `merchantArchived`).

Loading branch (`if (!merchant) { … }`): replace `{merchantError ? <p className="error">{merchantError}</p> : <p>加载中…</p>}` with `{merchantError ? <Notice tone="error">{merchantError}</Notice> : <LoadingState variant="detail" />}`.

Notices block (lines 490–499): 
```tsx
{archiveBlockedReason && (
  <Notice tone="warning" id="archive-blocked-reason" className="archive-blocker-notice">{archiveBlockedReason}</Notice>
)}
{merchantArchived && (
  <Notice tone="warning">商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。</Notice>
)}
{merchantError && <Notice tone="error">{merchantError}</Notice>}
{tasksError && <Notice tone="error">{tasksError}</Notice>}
{runsError && <Notice tone="error">{runsError}</Notice>}
{actionError && <Notice tone="error">{actionError}</Notice>}
```
The four `onboarding-notice` paragraphs at lines 448–465 contain links and stay untouched.

Empty states: `<EmptyState>尚未发起分析。第一次分析会在这里生成报告和任务提案。</EmptyState>` and `<EmptyState>当前筛选下没有任务。</EmptyState>`.

Before `</main>`:
```tsx
<ConfirmDialog
  open={archiveConfirmOpen}
  code="MERCHANT / ARCHIVE"
  title="归档商户"
  message={`归档会关闭自动分析并停止创建新的执行；${todoCount} 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“${merchant.name}”？`}
  confirmLabel="确认归档"
  busyLabel="归档中…"
  busy={archiveBusy}
  error={archiveError}
  onConfirm={() => void applyArchiveToggle()}
  onCancel={() => { if (!archiveBusy) { setArchiveConfirmOpen(false); setArchiveError('') } }}
/>
```

- [ ] **Step 4: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green (415 tests). The existing test `await screen.findByText('商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。')` at `merchantLifecycle.test.tsx:247` still passes because `Notice` renders the text inside a `<span>`.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/MerchantDetail.tsx web/src/merchantLifecycle.test.tsx
git commit -m "feat(web): confirm merchant archive in ConfirmDialog and unify detail notices"
```

---

### Task 6: RunDetail — NOT_CREATED confirm, notices, loading, empty states

**Files:**
- Modify: `web/src/pages/RunDetail.tsx:14, 266-273, 283-300, 346-350, 387, 418, 427, 439, 461, 487-489`
- Modify: `web/src/runDispatchReconciliation.test.tsx:537-580`

- [ ] **Step 1: Update the NOT_CREATED test**

Delete `const confirmMock = vi.fn(() => true)` and `vi.stubGlobal('confirm', confirmMock)`. Replace
```tsx
expect(confirmMock).toHaveBeenCalledWith(
  '请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。',
)
```
with
```tsx
const dialog = await screen.findByRole('dialog', { name: '标记 Core AI 未创建运行' })
within(dialog).getByText('请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。')
expect(fetchMock.mock.calls.some(([input, init]) => input === '/api/runs/41/reconcile-dispatch' && (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
fireEvent.click(within(dialog).getByRole('button', { name: '确认标记未创建' }))
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/runDispatchReconciliation.test.tsx -t "second confirmation"`
Expected: FAIL, `Unable to find role="dialog"`.

- [ ] **Step 3: Port the page**

Import: `import { ConfirmDialog, EmptyState, LoadingState, Notice } from '../components/feedback'`

State: `const [notCreatedConfirmOpen, setNotCreatedConfirmOpen] = useState(false)`

In `reconcileDispatch`, replace
```tsx
if (action === 'NOT_CREATED' && !window.confirm(
  '请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。',
)) return
```
with
```tsx
if (action === 'NOT_CREATED' && !notCreatedConfirmOpen) {
  setNotCreatedConfirmOpen(true)
  return
}
setNotCreatedConfirmOpen(false)
```
(The confirm button calls `reconcileDispatch('NOT_CREATED')` again while the dialog is open, which now passes through.)

Loading branch: `{runError ? <Notice tone="error">{runError}</Notice> : <LoadingState variant="detail" />}`.

Lines 346–350:
```tsx
{runError && <Notice tone="error">{runError}</Notice>}
{merchantError && <Notice tone="error">{merchantError}</Notice>}
{auditError && <Notice tone="error">{auditError}</Notice>}
{run.error && !needsDispatchReview && <Notice tone="error">{run.error}</Notice>}
{reconciliationNotice && <Notice tone="success" className="dispatch-reconciliation-success">{reconciliationNotice}</Notice>}
```
Line 387: `{reconciliationError && <Notice tone="error">{reconciliationError}</Notice>}`
Line 418: `<EmptyState>这次分析还没有返回报告。</EmptyState>`
Line 427: `<LoadingState label="正在读取 Task Plan…" />`
Line 439: `<Notice tone="warning">商户已归档，Plan 与生成任务仅供查看；恢复在营后可继续审批。</Notice>`
Line 461: `<EmptyState compact>本次分析没有生成可编辑 Task Plan。</EmptyState>`
Line 487: `<LoadingState label="正在载入当前批准 revision 的正式 Task。" />`
Line 489: `<EmptyState compact>当前批准 revision 暂无可显示的正式 Task。</EmptyState>`

The two `plan-load-error` sections (Task Plan 读取失败 / 正式 Task 读取失败) become:
```tsx
<Notice tone="error" action={{ label: '重试读取 Plan', onClick: () => void loadPlan() }}>{planError}</Notice>
```
(use whichever error variable each section renders today; keep the button label each section uses today.)

Before `</main>`:
```tsx
<ConfirmDialog
  open={notCreatedConfirmOpen}
  code="CORE AI / RUN NOT CREATED"
  title="标记 Core AI 未创建运行"
  message="请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。"
  confirmLabel="确认标记未创建"
  busy={reconciliationBusy}
  onConfirm={() => void reconcileDispatch('NOT_CREATED')}
  onCancel={() => { if (!reconciliationBusy) setNotCreatedConfirmOpen(false) }}
/>
```
Any `aria-label="…读取失败"` test queries on the removed sections: run the suite and update those queries to `getByRole('alert')` scoped with `within` if they break.

- [ ] **Step 4: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/RunDetail.tsx web/src/runDispatchReconciliation.test.tsx web/src/App.test.tsx
git commit -m "feat(web): confirm NOT_CREATED reconciliation in ConfirmDialog and unify run notices"
```

---

### Task 7: TaskDetail — 409 banner, loading, notices, empty states

**Files:**
- Modify: `web/src/pages/TaskDetail.tsx:1-10, 758-770, 823-839, 900-901, 979`
- Modify: `web/src/App.test.tsx:4297`

- [ ] **Step 1: Update the conflict test**

`App.test.tsx:4297`: `screen.getByRole('button', { name: '刷新任务' })` → `screen.getByRole('button', { name: '重新载入' })`. Add after it: `expect((screen.getByRole('button', { name: '保存内部元数据' }) as HTMLButtonElement).disabled).toBe(true)`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/App.test.tsx -t "任务已变更"`
(If the `-t` filter matches nothing, run the whole file.) Expected: FAIL on the `重新载入` query.

- [ ] **Step 3: Port the page**

Import: `import { ConflictBanner, EmptyState, LoadingState, Notice } from '../components/feedback'`

Loading branch (line 766): `) : loading ? <LoadingState variant="detail" /> : <p>没有可显示的任务。</p>}`; the `task-load-state` error section becomes `<Notice tone="error" action={validTaskId ? { label: '重试读取', onClick: load } : undefined}>{error}</Notice>`.

Lines 823–839:
```tsx
{merchantArchived && (
  <Notice tone="warning">商户已归档，任务已冻结；恢复在营后可继续处理。</Notice>
)}
{conflict ? (
  <ConflictBanner message="任务已变更，请刷新后再操作。" busy={busy || loading} onReload={load} />
) : error ? (
  <Notice tone="error">{error}</Notice>
) : null}
{metadataConflict && (
  <Notice tone="error" action={{ label: '刷新任务', onClick: load, disabled: busy || loading }}>{metadataConflict}</Notice>
)}
{notice && <Notice tone="success">{notice}</Notice>}
```
Keep `setError('任务已变更，请刷新后再操作。')` in `failAction` (other code reads `error`), and make sure `load` clears `conflict` on success (it already does via `acceptTask`; verify with `grep -n "setConflict(false)"`, add it in `load`'s success path if missing).

Write controls while conflicted: every mutation button on the page already checks `busy`; add `|| conflict` to the `disabled` expression of the metadata save button (`保存内部元数据`), the approve/reject/cancel/retry action buttons in the header, and `TaskAssignment`'s `disabled` prop. Do not touch read-only controls (`刷新任务状态`, links).

Line 901: `<EmptyState>尚无内容准备 Attempt。</EmptyState>`; line 979: `<EmptyState>暂无事件记录。</EmptyState>`.

- [ ] **Step 4: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green. Tests at `App.test.tsx:4327` (`queryByText('任务已变更…')` is null after reload) and `:4545` still hold.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/TaskDetail.tsx web/src/App.test.tsx
git commit -m "feat(web): show task 409 as ConflictBanner and unify task detail feedback"
```

---

### Task 8: PlanReview — 409 banner, notices, loading

**Files:**
- Modify: `web/src/pages/PlanReview.tsx:3, 548-560, 588-604, 723`
- Modify: `web/src/App.test.tsx:3498`

- [ ] **Step 1: Update the conflict test**

`App.test.tsx:3498`: `screen.getByRole('button', { name: '重新载入服务器 Plan' })` → `screen.getByRole('button', { name: '重新载入' })`. Keep the preceding `await screen.findByText('plan revision changed; refresh and retry')` — the raw message is shown as the banner's `detail`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npx vitest run src/App.test.tsx -t "revision"`
Expected: FAIL on `重新载入`.

- [ ] **Step 3: Port the page**

Import: `import { ConflictBanner, LoadingState, Notice } from '../components/feedback'`

Loading branch (548–560): error → `<Notice tone="error" action={{ label: '重新加载', onClick: () => void load(), disabled: busy === 'load' }}>无法读取 Plan：{error}</Notice>`; loading → `<LoadingState variant="detail" label="正在读取 Plan…" />`.

Lines 588–604:
```tsx
{conflicted ? (
  <ConflictBanner
    message="服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。"
    detail={error || undefined}
    busy={busy === 'load'}
    onReload={() => void load()}
  />
) : error ? (
  <Notice
    tone="error"
    action={merchantStatus !== 'active' ? { label: '重新加载 Plan 与商户状态', onClick: () => void load(), disabled: Boolean(busy) } : undefined}
  >{error}</Notice>
) : null}
{notice && <Notice tone="success">{notice}</Notice>}
{merchantStatus === 'archived' && (
  <Notice tone="warning">商户已归档，Plan 与生成任务仅供查看；恢复在营后可继续审批。</Notice>
)}
{merchantStatus === null && !error && (
  <Notice tone="warning">正在确认商户状态，Plan 暂时只读。</Notice>
)}
```
Delete line 723 (`{conflicted && <p className="plan-conflict-note">…</p>}`). `load()` must reset `conflicted` to `false` on success — check `grep -n "setConflicted(false)"`; add it in `load`'s success path if absent. Write controls (`save`, `approve`, `reject`, per-item edits) already include `conflicted` in their disabled logic (lines 460, 498, 523, 565, 566, 753); leave them.

- [ ] **Step 4: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green. The five `重新加载 Plan 与商户状态` assertions (3115–3315) still hold because that non-conflict action is unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/PlanReview.tsx web/src/App.test.tsx
git commit -m "feat(web): show plan 409 as ConflictBanner and unify plan review feedback"
```

---

### Task 9: MerchantProfile — 409, page feedback, two dialogs on the shared shell

**Files:**
- Modify: `web/src/pages/MerchantProfile.tsx:1-10, 1305-1352, 1355-1382, 1800-1803, 1954-1960, 1983-1984, 2080`
- Modify: `docs/superpowers/specs/2026-09-09-feedback-consistency-design.md` (append appendix C)

- [ ] **Step 1: Locate the tests that drive the two dialogs**

Run: `cd web && grep -n -E "确认生成 Local Falcon 报告|关闭生成确认|确认采用 FBR 版本|确认恢复 Skill 版本|关闭版本确认|Local Falcon 人工对账" src/App.test.tsx | head -20`
Record the line numbers; they are the assertions that must keep passing.

- [ ] **Step 2: Port the page**

Import: `import { ConfirmDialog, ConflictBanner, LoadingState, Notice } from '../components/feedback'`

State: `const [conflict, setConflict] = useState(false)`.

Relink catch (line ~1800): 
```tsx
} catch (err) {
  if (!relinkAccepted && err instanceof ApiError && err.status >= 400 && err.status < 500) {
    fbrRelinkRequestRef.current = null
  }
  if (err instanceof ApiError && err.status === 409) setConflict(true)
  setError((err as Error).message)
}
```
Add a `reloadAfterConflict` next to the existing loaders:
```tsx
const reloadAfterConflict = async () => {
  try {
    const [nextMerchant, nextProfile] = await Promise.all([api.getMerchant(merchantId), api.getMerchantProfile(merchantId)])
    setMerchant(nextMerchant)
    setProfile(nextProfile)
    setFbrMerchantId(nextProfile.fbr_merchant_id || '')
    setError('')
    setConflict(false)
  } catch (err) {
    setError((err as Error).message)
  }
}
```
(Use the page's existing load helpers if it already has a function that fetches both; call that instead and clear `conflict` on success. Check with `grep -n "api.getMerchant(" src/pages/MerchantProfile.tsx`.)

Loading branch (1954–1960): `{error ? <Notice tone="error">{error}</Notice> : <LoadingState variant="detail" />}`.

Lines 1983–1984:
```tsx
{conflict
  ? <ConflictBanner message="商户资料已被他人修改，本页数据已过期。" detail={error || undefined} onReload={() => void reloadAfterConflict()} />
  : error && <Notice tone="error" className="profile-error">{error}</Notice>}
{isArchived && <Notice tone="warning">商户已归档，恢复在营后可操作。</Notice>}
```
While `conflict` is true, pass `disabled` to the relink / sync / SEO mutation buttons: add `|| conflict` to each of their `disabled` expressions (find them with `grep -n "disabled={" src/pages/MerchantProfile.tsx | grep -i -E "relink|sync|refresh|generate|activation"`).

Line 2080: `<Notice tone="warning" className="profile-sync-warning">上次同步失败：{profile.last_error}。已保留最后一次成功数据。</Notice>`.

Local Falcon paid-scan dialog (1305–1352) → keep its body, swap the shell:
```tsx
<ConfirmDialog
  open={Boolean(confirmLocalFalcon)}
  code="LOCAL FALCON / PAID SCAN"
  title="确认生成 Local Falcon 报告"
  closeLabel="关闭生成确认"
  tone="primary"
  confirmLabel={`确认并生成 ${localFalconConfirmation?.keywords.length || 0} 个报告`}
  busyLabel="正在提交…"
  busy={localFalconBusy}
  error={generationError}
  onConfirm={() => void confirmGeneration()}
  onCancel={closeGenerationConfirmation}
>
  <Notice tone="warning"><strong>此操作将消耗 Local Falcon credits</strong>。系统只提交当前已评分并待审批的 Top {localFalconConfirmation?.keywords.length || 0}，不会自动扩大关键词范围。</Notice>
  <div className="scan-confirm-location" aria-label="扫描门店">…unchanged…</div>
  <dl className="scan-confirm-params" aria-label="扫描参数">…unchanged…</dl>
  <div className="scan-confirm-keywords" aria-label="待生成关键词">…unchanged…</div>
</ConfirmDialog>
```
Remove the old `operation-confirm-backdrop` / `section` / `header` / `footer` wrappers and the `credit-warning` and `scan-confirm-error` paragraphs (the error now comes from the `error` prop).

Keyword-version dialog (1355–1382) → same treatment:
```tsx
<ConfirmDialog
  open={selectedVersion !== null}
  code="KEYWORD VERSION"
  title={`确认${selectedVersion?.version.source === 'FBR' ? '采用 FBR 关键词版本' : '恢复 Skill 关键词版本'}`}
  closeLabel="关闭版本确认"
  tone="primary"
  confirmLabel={selectedVersion?.version.source === 'FBR' ? '确认采用 FBR 版本' : '确认恢复 Skill 版本'}
  busyLabel="正在采用…"
  busy={activationBusy}
  error={activationError}
  onConfirm={() => void confirmVersionActivation()}
  onCancel={() => setSelectedVersion(null)}
>
  {selectedVersion && <>
    <p>将采用 #{selectedVersion.version.artifact_id}，并以确认时的当前活动版本 #{selectedVersion.expectedActiveArtifactId ?? '无'} 作为冲突校验。</p>
    {selectedVersion.version.source === 'FBR' && (
      isFbrActivationLocalFalconEligible(selectedVersion.version.score_status)
        ? <p className="muted">{fbrActivationEligibilityCopy(selectedVersion.version.score_status)}</p>
        : <Notice tone="warning">{fbrActivationEligibilityCopy(selectedVersion.version.score_status)}</Notice>
    )}
  </>}
</ConfirmDialog>
```
The Local Falcon reconciliation dialog (`LocalFalconReconciliationDialog`, lines ~690–800) has three conditional action buttons and does not fit the cancel + confirm footer. Leave it on its current shell; only replace its `{error && <p className="scan-confirm-error" role="alert">{error}</p>}` with `{error && <Notice tone="error">{error}</Notice>}`.

- [ ] **Step 3: Record the exception in the spec**

Append to `docs/superpowers/specs/2026-09-09-feedback-consistency-design.md`:
```markdown
## 附录 C：保留原实现的对话框

- `MerchantProfile.tsx` 的 `LocalFalconReconciliationDialog`（Local Falcon 人工对账）：footer 有「确认未提交并关闭批次 / 关闭剩余未执行项 / 绑定已受理报告」三个条件动作，不符合 `ConfirmDialog` 的取消 + 单一确认结构。保留 `operation-confirm-dialog reconciliation-dialog` 外壳，只把内部错误提示换成 `Notice`。
```

- [ ] **Step 4: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green. If a test queried `getByText('此操作将消耗 Local Falcon credits')`, it still matches because the `<strong>` keeps the same text.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/MerchantProfile.tsx docs/superpowers/specs/2026-09-09-feedback-consistency-design.md web/src/App.test.tsx
git commit -m "feat(web): move merchant profile dialogs and 409 handling onto shared feedback components"
```

---

### Task 10: TasksOverview, PerformanceDashboard, login error

**Files:**
- Modify: `web/src/pages/TasksOverview.tsx:145-153`
- Modify: `web/src/pages/PerformanceDashboard.tsx:208-209`
- Modify: `web/src/App.tsx:116`

- [ ] **Step 1: Port the three sites**

TasksOverview (lines 145–153): the `task-query-error` section → `<Notice tone="error" action={{ label: '重试查询', onClick: load, disabled: loading }}>{error}</Notice>` (if the section already has a retry button, keep its label; if not, use `重试查询`). Empty → `<EmptyState>当前查询条件下没有任务。</EmptyState>`. While `loading` and no error, render `<LoadingState variant="list" label="正在查询…" />` in place of the table.

PerformanceDashboard line 208: `<Notice tone="error">读取数据看板失败：{error}</Notice>`; line 209: `<LoadingState label="正在读取最近一次成功同步的表现快照…" />`.

App.tsx line 116: `{error && <Notice tone="error">{error}</Notice>}` with `import { Notice } from './components/feedback'`.

- [ ] **Step 2: Run suite, lint, build**

Run: `cd web && npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/TasksOverview.tsx web/src/pages/PerformanceDashboard.tsx web/src/App.tsx web/src/App.test.tsx
git commit -m "feat(web): use shared feedback components on tasks overview, dashboard and login"
```

---

### Task 11: Remove dead CSS and verify acceptance

**Files:**
- Modify: `web/src/index.css`

- [ ] **Step 1: Prove each rule is unused, then delete it**

For each class below, run `grep -rn "<name>" web/src --include='*.tsx' | grep -v '\.test\.'`; delete the rule only when the grep prints nothing:
`.error` (line ~516), `.notice` base + `.notice.archive-blocker-notice` (keep `.onboarding-notice`), `.operation-confirm-backdrop`, `.operation-confirm-dialog` (all its selectors), `.scan-confirm-error`, `.credit-warning` (also the `.keyword-version-confirm-copy .credit-warning` / `.scan-confirm-error` lines), `.task-action-message` (+ `.success` variant), `.task-load-state`, `.plan-review-page .plan-message` (+ variants), `.plan-review-page .plan-load-state`, `.plan-review-page .plan-conflict-note` (both lines), `.run-report-page .plan-load-error` (all lines), `.task-query-error`, `.dispatch-reconciliation-success` (keep if `Notice className` still uses it).
`.reconciliation-dialog` and `.reconciliation-*` stay (appendix C). `.dialog-close` stays (used by `ConfirmDialog`). `@keyframes breathe` stays.

- [ ] **Step 2: Acceptance checks from spec section 7**

Run:
```bash
cd web && grep -rn "window.confirm" src | grep -v '\.test\.' ; echo "confirm-sites=$?"
grep -rn "ConflictBanner" src/pages | wc -l
npm test 2>&1 | tail -4 && npm run lint && npm run build 2>&1 | tail -2
```
Expected: `confirm-sites=1` (grep found nothing), `ConflictBanner` referenced in 3 pages, tests / lint / build green.

- [ ] **Step 3: Visual check in the running app**

Start `npm run dev` in `web/` (the API must be running on :8000; if it is not, start it per `README.md`), open `/merchants/<id>` and trigger 归档 to see the dialog, then compare against the prototype at `docs/evidence/2026-09-09-feedback-kit/prototype/index.html`. Fix spacing/colour drift in `feedback.css` only.

- [ ] **Step 4: Commit**

```bash
git add web/src/index.css web/src/feedback.css
git commit -m "chore(web): drop page-specific feedback CSS replaced by shared components"
```

Then finish the branch with `superpowers:finishing-a-development-branch`.

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

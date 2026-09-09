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
    const { rerender } = render(<><button type="button">打开</button><ConfirmDialog {...base} open={false} onConfirm={() => {}} onCancel={() => {}} /></>)
    const opener = screen.getByRole('button', { name: '打开' })
    opener.focus()
    rerender(<><button type="button">打开</button><ConfirmDialog {...base} onConfirm={() => {}} onCancel={() => {}} /></>)
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消' }))
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

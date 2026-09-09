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

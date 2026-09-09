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

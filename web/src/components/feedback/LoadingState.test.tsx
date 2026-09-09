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

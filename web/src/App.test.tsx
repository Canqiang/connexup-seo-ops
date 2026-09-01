// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('desktop operator shell', () => {
  beforeEach(() => {
    window.history.pushState({}, '', '/tasks')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [],
    }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps global navigation visible and marks the current workspace', async () => {
    render(<App />)

    screen.getByRole('complementary', { name: 'SEO Ops 主导航' })
    expect(screen.getByRole('link', { name: '任务' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('内部运营工作台')).toBeNull()
  })

  it('gives the task workspace named filters for fast keyboard operation', async () => {
    render(<App />)

    await screen.findByRole('main', { name: '任务总览' })
    screen.getByRole('group', { name: '任务状态筛选' })
    screen.getByRole('combobox', { name: '任务类别' })
  })

  it('presents merchant creation and merchant data as named work areas', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    await screen.findByRole('main', { name: '商户台账' })
    screen.getByRole('form', { name: '新建商户' })
    screen.getByRole('group', { name: '商户状态筛选' })
  })

  it('opens a merchant workspace from anywhere on its table row', async () => {
    window.history.pushState({}, '', '/')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.startsWith('/api/merchants?')
        ? [{
            id: 1,
            name: 'Only Bear Chicken & Boba',
            notes: 'Mineola',
            status: 'active',
            todo_count: 3,
            doing_count: 1,
            has_running_run: false,
            last_run_at: null,
            last_run_status: null,
            auto_run_interval_days: null,
          }]
        : input.endsWith('/api/merchants/1')
          ? { id: 1, name: 'Only Bear Chicken & Boba', status: 'active', notes: 'Mineola', auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
          : [],
    })))
    render(<App />)

    const row = await screen.findByRole('link', { name: '打开商户 Only Bear Chicken & Boba' })
    fireEvent.click(row)

    await screen.findByRole('main', { name: '商户工作区' })
  })

  it('organizes merchant operations into analysis and task work areas', async () => {
    window.history.pushState({}, '', '/merchants/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1')
        ? { id: 1, name: '测试商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户工作区' })
    screen.getByRole('region', { name: 'AI 分析' })
    screen.getByRole('region', { name: '任务队列' })
  })

  it('labels the evidence editor as the task completion record', async () => {
    window.history.pushState({}, '', '/tasks/1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 1,
        merchant_id: 1,
        title: '更新 GBP 营业时间',
        description: null,
        rationale: '营业时间已变化',
        expected_outcome: '减少误访',
        category: 'gbp',
        scheduled_start: null,
        status: 'doing',
        evidence_note: '',
        source_run_id: null,
        source_key: null,
        created_at: '2026-09-01T00:00:00Z',
        completed_at: null,
      }),
    }))
    render(<App />)

    await screen.findByRole('main', { name: '任务详情' })
    screen.getByRole('textbox', { name: '执行证据' })
  })

  it('separates a run report from the tasks it proposed', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/tasks')
        ? []
        : {
            id: 1,
            merchant_id: 1,
            coreai_run_id: 'run-1',
            status: 'succeeded',
            trigger_kind: 'manual',
            report_text: '# 报告',
            error: null,
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          },
    })))
    render(<App />)

    await screen.findByRole('main', { name: '分析报告' })
    screen.getByRole('region', { name: '报告正文' })
  })
})

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const activeTask = {
  id: 1,
  merchant_id: 1,
  merchant_name: '在营商户',
  merchant_status: 'active',
  title: '在营任务',
  description: null,
  rationale: null,
  expected_outcome: null,
  category: 'gbp',
  scheduled_start: null,
  status: 'todo',
  execution_status: null,
  evidence_note: null,
  source_run_id: null,
  source_plan_approved: true,
  source_key: null,
  created_at: '2026-09-02T00:00:00Z',
  completed_at: null,
}

const archivedTask = {
  ...activeTask,
  id: 2,
  merchant_id: 2,
  merchant_name: '已归档商户',
  merchant_status: 'archived',
  title: '已冻结任务',
}

describe('merchant lifecycle', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps archived merchant tasks out of the active queue until explicitly included', async () => {
    window.history.pushState({}, '', '/tasks')
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks?include_archived=true'
        ? [archivedTask, activeTask]
        : input === '/api/tasks'
          ? [activeTask]
          : { username: 'test', role: 'operator' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('在营任务')
    expect(screen.queryByText('已冻结任务')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '显示已归档商户任务' }))

    await screen.findByText('已冻结任务')
    screen.getByText('商户已归档')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks?include_archived=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('renders an archived merchant task as frozen and removes execution actions', async () => {
    window.history.pushState({}, '', '/tasks/2')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/tasks/2/execution') {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ detail: 'execution not found' }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/tasks/2'
          ? archivedTask
          : input === '/api/merchants/2'
            ? {
                id: 2,
                name: '已归档商户',
                status: 'archived',
                notes: null,
                primary_location: null,
                website_url: null,
                auto_run_interval_days: null,
                created_at: '2026-09-02T00:00:00Z',
              }
            : { username: 'test', role: 'operator' },
      }
    }))

    render(<App />)

    await screen.findByText('商户已归档，任务已冻结；恢复在营后可继续处理。')
    expect(screen.queryByRole('button', { name: '交给 Agent 执行' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消任务' })).toBeNull()
  })

  it('confirms that deleting an archived merchant also deletes its related data', async () => {
    window.history.pushState({}, '', '/merchants/2')
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/merchants/2' && init?.method === 'DELETE') {
        return { ok: true, status: 204, json: async () => null }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/merchants/2'
          ? {
              id: 2,
              name: '已归档商户',
              status: 'archived',
              notes: null,
              primary_location: null,
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-02T00:00:00Z',
            }
          : input === '/api/merchants/2/tasks'
            ? [archivedTask]
            : input === '/api/merchants/2/runs'
              ? [{
                  id: 9,
                  merchant_id: 2,
                  coreai_run_id: 'run-9',
                  status: 'succeeded',
                  trigger_kind: 'manual',
                  report_text: '# history',
                  error: null,
                  plan_approved_at: null,
                  created_at: '2026-09-01T00:00:00Z',
                  finished_at: '2026-09-01T00:01:00Z',
                }]
              : [],
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('商户已归档，自动分析和任务执行已暂停；历史记录仍然保留。')
    expect(screen.queryByRole('button', { name: '开始诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '＋ 新建任务' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '删除商户' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/merchants/2',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    expect(confirmMock).toHaveBeenCalledWith(
      '永久删除后，该商户及其所有任务、分析记录和关联资料将无法恢复。确认删除“已归档商户”？',
    )
    await screen.findByRole('main', { name: '商户台账' })
  })

  it('deletes an archived merchant directly from the merchant ledger', async () => {
    window.history.pushState({}, '', '/')
    let deleted = false
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const archivedMerchant = {
      id: 2,
      name: '已归档商户',
      status: 'archived',
      notes: null,
      primary_location: null,
      website_url: null,
      auto_run_interval_days: null,
      todo_count: 16,
      doing_count: 6,
      has_running_run: false,
      last_run_at: '2026-09-01T14:09:00Z',
      last_run_status: 'succeeded',
      created_at: '2026-09-01T00:00:00Z',
    }
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/merchants/2' && init?.method === 'DELETE') {
        deleted = true
        return { ok: true, status: 204, json: async () => null }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/merchants?status=archived'
          ? deleted ? [] : [archivedMerchant]
          : input === '/api/merchants?status=active'
            ? []
            : { username: 'test', role: 'operator' },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByRole('main', { name: '商户台账' })
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    await screen.findByRole('link', { name: '打开商户 已归档商户' })
    fireEvent.click(screen.getByRole('button', { name: '删除商户 已归档商户' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/merchants/2',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    expect(confirmMock).toHaveBeenCalledWith(
      '永久删除后，该商户及其所有任务、分析记录和关联资料将无法恢复。确认删除“已归档商户”？',
    )
    await screen.findByText('当前筛选下没有商户。')
    expect(window.location.pathname).toBe('/')
  })

  it('explains how existing tasks are frozen before archiving a merchant', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const tasks = [
      activeTask,
      { ...activeTask, id: 3, title: '第二个待办' },
      { ...activeTask, id: 4, title: '进行中任务', status: 'doing' },
    ]
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/merchants/1' && init?.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 1,
            name: '在营商户',
            status: 'archived',
            notes: null,
            primary_location: null,
            website_url: null,
            auto_run_interval_days: null,
            created_at: '2026-09-02T00:00:00Z',
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/merchants/1'
          ? {
              id: 1,
              name: '在营商户',
              status: 'active',
              notes: null,
              primary_location: null,
              website_url: null,
              auto_run_interval_days: 7,
              created_at: '2026-09-02T00:00:00Z',
            }
          : input === '/api/merchants/1/tasks'
            ? tasks
            : [],
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '归档商户' }))

    expect(confirmMock).toHaveBeenCalledWith(
      '归档后将冻结 2 个待办和 1 个进行中任务，并关闭自动分析；任务与历史记录不会删除。确认归档“在营商户”？',
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/merchants/1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'archived' }),
      }),
    ))
  })

  it('keeps an archived merchant Plan readable but removes its approval action', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({ detail: 'accepted audit not found' }),
        }
      }
      const data = input === '/api/runs/1'
        ? {
            id: 1,
            merchant_id: 2,
            coreai_run_id: 'run-1',
            status: 'succeeded',
            trigger_kind: 'manual',
            report_text: '# 诊断报告',
            error: null,
            plan_approved_at: null,
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          }
        : input === '/api/runs/1/tasks'
          ? [archivedTask]
          : {
              id: 2,
              name: '已归档商户',
              status: 'archived',
              notes: null,
              primary_location: null,
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-02T00:00:00Z',
            }
      return { ok: true, status: 200, json: async () => data }
    }))

    render(<App />)

    await screen.findByText('商户已归档，Plan 与生成任务仅供查看；恢复在营后可继续审批。')
    expect(screen.queryByRole('button', { name: '确认 Plan' })).toBeNull()
    screen.getByRole('link', { name: '已冻结任务' })
  })
})

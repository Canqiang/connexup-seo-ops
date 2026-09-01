// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
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

  it('requires the configured operator session before showing the workspace', async () => {
    let signedIn = false
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') {
        return signedIn
          ? { ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) }
          : { ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ detail: 'authentication required' }) }
      }
      if (input === '/api/auth/login' && init?.method === 'POST') {
        signedIn = true
        return { ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) }
      }
      return { ok: true, status: 200, json: async () => [] }
    }))

    render(<App />)

    await screen.findByRole('main', { name: 'SEO Ops 登录' })
    expect(screen.queryByRole('complementary', { name: 'SEO Ops 主导航' })).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: '账号' }), { target: { value: 'test' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'seo-ops-test' } })
    fireEvent.click(screen.getByRole('button', { name: '登录' }))

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    screen.getByText('test')
  })

  it('keeps global navigation visible and marks the current workspace', async () => {
    render(<App />)

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    expect(screen.getByRole('link', { name: '任务' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByText('内部运营工作台')).toBeNull()
  })

  it('gives the task workspace named filters for fast keyboard operation', async () => {
    render(<App />)

    await screen.findByRole('main', { name: '任务总览' })
    screen.getByRole('group', { name: '任务状态筛选' })
    screen.getByRole('combobox', { name: '任务类别' })
  })

  it('opens tasks for agent assignment instead of bypassing review from the list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{
        id: 5,
        merchant_id: 1,
        merchant_name: 'Only Bear',
        title: '生成本周 GBP Post',
        description: null,
        rationale: '保持内容活跃度',
        expected_outcome: '提升本地曝光',
        category: 'gbp',
        scheduled_start: null,
        status: 'todo',
        execution_status: 'ready',
        evidence_note: null,
        source_run_id: null,
        source_plan_approved: true,
        source_key: null,
        created_at: '2026-09-01T00:00:00Z',
        completed_at: null,
      }],
    }))
    render(<App />)

    await screen.findByRole('link', { name: '查看任务：生成本周 GBP Post' })
    screen.getByText('待审批')
    expect(screen.queryByRole('button', { name: '开始' })).toBeNull()
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('keeps merchant creation collapsed until the operator asks for it', async () => {
    window.history.pushState({}, '', '/')
    render(<App />)

    await screen.findByRole('main', { name: '商户台账' })
    expect(screen.queryByRole('form', { name: '新建商户' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /新建商户/ }))
    screen.getByRole('form', { name: '新建商户' })
    screen.getByRole('textbox', { name: '商户名称' })
    screen.getByRole('textbox', { name: '主要地点' })
    screen.getByRole('textbox', { name: '官网' })
    screen.getByRole('group', { name: '商户状态筛选' })
  })

  it('creates a merchant, starts its first diagnosis, and opens its workspace', async () => {
    window.history.pushState({}, '', '/')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${input}`)
      const merchant = {
        id: 91,
        name: 'Only Bear Chicken & Boba',
        status: 'active',
        notes: null,
        primary_location: 'Mineola, NY',
        website_url: 'https://onlybear.example.com',
        auto_run_interval_days: null,
        created_at: '2026-09-01T00:00:00Z',
      }
      const data = method === 'POST' && input === '/api/merchants'
        ? merchant
        : method === 'POST' && input === '/api/merchants/91/runs'
          ? { id: 12, merchant_id: 91, status: 'running', trigger_kind: 'manual', plan_approved_at: null, created_at: '2026-09-01T00:00:01Z' }
          : input === '/api/merchants/91'
            ? merchant
            : []
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Only Bear Chicken & Boba' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Mineola, NY' } })
    fireEvent.change(screen.getByRole('textbox', { name: '官网' }), { target: { value: 'https://onlybear.example.com' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并开始诊断' }))

    await screen.findByRole('main', { name: '商户工作区' })
    expect(calls.indexOf('POST /api/merchants')).toBeLessThan(calls.indexOf('POST /api/merchants/91/runs'))
    expect(calls).toContain('GET /api/merchants/91')
  })

  it('opens the persisted merchant when automatic diagnosis cannot start', async () => {
    window.history.pushState({}, '', '/')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const merchant = {
        id: 92,
        name: 'Fallback Merchant',
        status: 'active',
        notes: null,
        primary_location: 'Queens, NY',
        website_url: null,
        auto_run_interval_days: null,
        created_at: '2026-09-01T00:00:00Z',
      }
      if (init?.method === 'POST' && input === '/api/merchants/92/runs') {
        return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ detail: 'core-ai not configured' }) }
      }
      const data = init?.method === 'POST' && input === '/api/merchants'
        ? merchant
        : input === '/api/merchants/92'
          ? merchant
          : []
      return { ok: true, status: init?.method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Fallback Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Queens, NY' } })
    fireEvent.click(screen.getByRole('button', { name: '保存并开始诊断' }))

    await screen.findByRole('heading', { name: 'Fallback Merchant' })
    await screen.findByText('商户已保存，但初始诊断未能启动。')
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

  it('shows one clear diagnosis status and next action for a new merchant', async () => {
    window.history.pushState({}, '', '/merchants/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1')
        ? {
            id: 1,
            name: '新商户',
            status: 'active',
            notes: null,
            primary_location: 'Queens, NY',
            website_url: 'https://example.com',
            auto_run_interval_days: null,
            created_at: '2026-09-01T00:00:00Z',
          }
        : [],
    })))
    render(<App />)

    const status = await screen.findByRole('region', { name: '初始诊断' })
    within(status).getByRole('heading', { name: '尚未开始初始诊断' })
    within(status).getByRole('button', { name: '开始诊断' })
    expect(within(status).queryAllByRole('button')).toHaveLength(1)
  })

  it('turns a completed diagnosis into a single Plan approval action', async () => {
    window.history.pushState({}, '', '/merchants/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1')
        ? { id: 1, name: '新商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : input.endsWith('/api/merchants/1/runs')
          ? [{
              id: 7,
              merchant_id: 1,
              coreai_run_id: 'run-7',
              status: 'succeeded',
              trigger_kind: 'manual',
              report_text: '# 诊断报告',
              error: null,
              plan_approved_at: null,
              created_at: '2026-09-01T00:00:00Z',
              finished_at: '2026-09-01T00:01:00Z',
            }]
          : input.endsWith('/api/merchants/1/tasks')
            ? [{
                id: 11,
                merchant_id: 1,
                title: '补全 GBP 营业时间',
                description: null,
                rationale: '营业时间缺失',
                expected_outcome: '减少误访',
                category: 'gbp',
                scheduled_start: null,
                status: 'todo',
                evidence_note: null,
                source_run_id: 7,
                source_plan_approved: false,
                source_key: 'hours',
                created_at: '2026-09-01T00:01:00Z',
                completed_at: null,
              }]
            : [],
    })))
    render(<App />)

    const status = await screen.findByRole('region', { name: '初始诊断' })
    within(status).getByRole('heading', { name: '诊断完成，Plan 草案待确认' })
    within(status).getByRole('button', { name: '查看并确认 Plan' })
    expect(within(status).queryAllByRole('button')).toHaveLength(1)
    screen.getByText('等待确认 Plan')
    expect(screen.queryByRole('button', { name: '开始' })).toBeNull()
  })

  it('uses analysis time as the primary record identifier', async () => {
    window.history.pushState({}, '', '/merchants/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1')
        ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : input.endsWith('/api/merchants/1/runs')
          ? [{
              id: 7,
              merchant_id: 1,
              coreai_run_id: 'run-7',
              status: 'succeeded',
              trigger_kind: 'manual',
              report_text: '# 报告',
              error: null,
              created_at: '2026-09-01T00:00:00Z',
              finished_at: '2026-09-01T00:01:00Z',
            }]
          : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户工作区' })
    screen.getByRole('link', { name: '返回商户列表' })
    screen.getByRole('columnheader', { name: '分析时间' })
    screen.getByRole('columnheader', { name: '用时' })
    screen.getByRole('link', { name: /打开 .* 的分析报告/ })
    screen.getByText('1 分钟')
    screen.getByText('已生成报告')
    expect(screen.queryByRole('columnheader', { name: '结束时间' })).toBeNull()
    expect(screen.queryByText('分析 7')).toBeNull()
  })

  it('shows the agent result as read-only and gives the human only review actions', async () => {
    window.history.pushState({}, '', '/tasks/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks/1'
        ? ({
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
          })
        : input === '/api/tasks/1/execution'
          ? ({
              id: 4,
              task_id: 1,
              coreai_run_id: 'run-exec-4',
              status: 'ready',
              attempt: 1,
              output_text: '已更新营业时间草案，并完成回读检查。',
              error: null,
              review_note: null,
              created_at: '2026-09-01T00:01:00Z',
              finished_at: '2026-09-01T00:02:00Z',
              reviewed_at: null,
            })
          : ({ id: 1, name: '测试商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }),
    })))
    render(<App />)

    const result = await screen.findByRole('region', { name: 'Agent 执行结果' })
    within(result).getByText('已更新营业时间草案，并完成回读检查。')
    within(result).getByRole('button', { name: '批准完成' })
    within(result).getByRole('button', { name: '退回重做' })
    expect(screen.queryByRole('textbox', { name: '执行证据' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存证据' })).toBeNull()
  })

  it('assigns a new task to the agent instead of opening a manual evidence form', async () => {
    window.history.pushState({}, '', '/tasks/2')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: input !== '/api/tasks/2/execution',
      status: input === '/api/tasks/2/execution' ? 404 : 200,
      statusText: input === '/api/tasks/2/execution' ? 'Not Found' : 'OK',
      json: async () => input === '/api/tasks/2'
        ? ({
            id: 2,
            merchant_id: 1,
            title: '生成本周 GBP Post',
            description: null,
            rationale: '保持内容活跃度',
            expected_outcome: '提升本地曝光',
            category: 'gbp',
            scheduled_start: null,
            status: 'todo',
            evidence_note: null,
            source_run_id: null,
            source_key: null,
            created_at: '2026-09-01T00:00:00Z',
            completed_at: null,
          })
        : input === '/api/tasks/2/execution'
          ? ({ detail: 'execution not found' })
          : ({ id: 1, name: '测试商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }),
    })))
    render(<App />)

    await screen.findByRole('main', { name: '任务详情' })
    screen.getByRole('button', { name: '交给 Agent 执行' })
    screen.getByText('尚未交给 Agent')
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('returns a merchant task to the merchant workspace it came from', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const task = {
      id: 37,
      merchant_id: 1,
      title: '撰写本地落地页或服务介绍内容',
      description: '补全本地服务内容',
      rationale: '缺少本地关键词内容页',
      expected_outcome: '覆盖本地搜索需求',
      category: 'content',
      scheduled_start: null,
      status: 'todo',
      evidence_note: null,
      source_run_id: 8,
      source_key: 'local-page',
      created_at: '2026-09-01T06:43:00Z',
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/merchants/1'
        ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : input === '/api/merchants/1/tasks'
          ? [task]
          : input === '/api/tasks/37'
            ? task
            : [],
    })))
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: task.title }))
    fireEvent.click(await screen.findByRole('button', { name: '返回冒烟商户' }))

    await screen.findByRole('main', { name: '商户工作区' })
    await screen.findByRole('heading', { name: '冒烟商户' })
  })

  it('returns a task opened from the task overview to the task overview', async () => {
    window.history.pushState({}, '', '/tasks')
    const task = {
      id: 38,
      merchant_id: 1,
      merchant_name: '冒烟商户',
      title: '完善 GBP 商户资料',
      description: null,
      rationale: '资料不完整',
      expected_outcome: '提升地图可见性',
      category: 'gbp',
      scheduled_start: null,
      status: 'todo',
      evidence_note: null,
      source_run_id: null,
      source_key: null,
      created_at: '2026-09-01T06:43:00Z',
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks'
        ? [task]
        : input === '/api/tasks/38'
          ? task
          : input === '/api/merchants/1'
            ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
    })))
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: task.title }))
    await screen.findByRole('main', { name: '任务详情' })
    fireEvent.click(screen.getByRole('button', { name: '返回任务总览' }))

    await screen.findByRole('main', { name: '任务总览' })
  })

  it('returns to the explicit task origin even when the detail route has no browser history entry', async () => {
    window.history.replaceState(
      { usr: { taskOrigin: { kind: 'merchant', from: '/merchants/1' } }, key: 'task-direct', idx: 0 },
      '',
      '/tasks/40',
    )
    const task = {
      id: 40,
      merchant_id: 1,
      title: '同步本地服务内容',
      description: null,
      rationale: '保持信息一致',
      expected_outcome: '减少信息差异',
      category: 'content',
      scheduled_start: null,
      status: 'todo',
      evidence_note: null,
      source_run_id: null,
      source_key: null,
      created_at: '2026-09-01T06:43:00Z',
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: input !== '/api/tasks/40/execution',
      status: input === '/api/tasks/40/execution' ? 404 : 200,
      statusText: input === '/api/tasks/40/execution' ? 'Not Found' : 'OK',
      json: async () => input === '/api/tasks/40'
        ? task
        : input === '/api/tasks/40/execution'
          ? { detail: 'execution not found' }
          : input === '/api/merchants/1'
            ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
    })))

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '返回冒烟商户' }))

    await screen.findByRole('main', { name: '商户工作区' })
    expect(window.location.pathname).toBe('/merchants/1')
  })

  it('uses the merchant as the safe fallback and removes internal task decoration', async () => {
    window.history.replaceState({}, '', '/tasks/39')
    const task = {
      id: 39,
      merchant_id: 1,
      title: '更新官网服务介绍',
      description: null,
      rationale: '页面信息过期',
      expected_outcome: '保持信息一致',
      category: 'content',
      scheduled_start: null,
      status: 'doing',
      evidence_note: '',
      source_run_id: 8,
      source_key: 'service-page',
      created_at: '2026-09-01T06:43:00Z',
      completed_at: null,
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: input !== '/api/tasks/39/execution',
      status: input === '/api/tasks/39/execution' ? 404 : 200,
      statusText: input === '/api/tasks/39/execution' ? 'Not Found' : 'OK',
      json: async () => input === '/api/tasks/39'
        ? task
        : input === '/api/tasks/39/execution'
          ? { detail: 'execution not found' }
          : { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' },
    })))
    render(<App />)

    await screen.findByRole('main', { name: '任务详情' })
    screen.getByRole('button', { name: '返回冒烟商户' })
    screen.getByRole('heading', { name: task.title })
    screen.getByRole('heading', { name: '任务说明' })
    screen.getByRole('heading', { name: 'Agent 执行结果' })
    const context = screen.getByRole('banner', { name: '任务上下文' })
    within(context).getByRole('group', { name: '任务状态与来源' })
    within(context).getByRole('group', { name: '任务操作' })
    expect(screen.queryByText('TASK #39 / 执行工单')).toBeNull()
    expect(screen.queryByText('TASK BRIEF')).toBeNull()
    expect(screen.queryByText('EXECUTION EVIDENCE')).toBeNull()
    expect(screen.queryByRole('textbox', { name: '执行证据' })).toBeNull()
  })

  it('makes the report primary and keeps generated tasks in a compact side list', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/runs/1'
        ? {
            id: 1,
            merchant_id: 1,
            coreai_run_id: 'run-1',
            status: 'succeeded',
            trigger_kind: 'manual',
            report_text: '# 报告',
            error: null,
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          }
        : input === '/api/runs/1/tasks'
          ? [{
              id: 11,
              merchant_id: 1,
              title: '补全 GBP 营业时间',
              description: null,
              rationale: '营业时间缺失',
              expected_outcome: '减少误访',
              category: 'gbp',
              scheduled_start: null,
              status: 'todo',
              evidence_note: null,
              source_run_id: 1,
              source_key: 'hours',
              created_at: '2026-09-01T00:01:00Z',
              completed_at: null,
            }]
          : { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' },
    })))
    render(<App />)

    await screen.findByRole('main', { name: '分析报告' })
    screen.getByRole('link', { name: '返回冒烟商户' })
    screen.getByRole('heading', { name: '09-01 08:00 分析报告' })
    const report = screen.getByRole('region', { name: '报告正文' })
    const tasks = screen.getByRole('complementary', { name: '本次生成任务' })
    screen.getByRole('link', { name: '补全 GBP 营业时间' })
    screen.getByText('1 分钟')
    expect(report.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('table', { name: '任务列表' })).toBeNull()
    expect(screen.queryByText('分析 #1')).toBeNull()
  })

  it('approves a generated Plan from the report before its tasks can execute', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const approvedAt = init?.method === 'POST' ? '2026-09-01T00:02:00Z' : null
      const data = input === '/api/runs/1' || input === '/api/runs/1/approve-plan'
        ? {
            id: 1,
            merchant_id: 1,
            coreai_run_id: 'run-1',
            status: 'succeeded',
            trigger_kind: 'manual',
            report_text: '# 诊断报告',
            error: null,
            plan_approved_at: approvedAt,
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          }
        : input === '/api/runs/1/tasks'
          ? [{
              id: 11,
              merchant_id: 1,
              title: '补全 GBP 营业时间',
              description: null,
              rationale: '营业时间缺失',
              expected_outcome: '减少误访',
              category: 'gbp',
              scheduled_start: null,
              status: 'todo',
              evidence_note: null,
              source_run_id: 1,
              source_key: 'hours',
              created_at: '2026-09-01T00:01:00Z',
              completed_at: null,
            }]
          : { id: 1, name: '新商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
      return { ok: true, status: init?.method === 'POST' ? 200 : 200, json: async () => data }
    }))
    render(<App />)

    const decision = await screen.findByRole('region', { name: 'Plan 审批' })
    within(decision).getByText('确认后，这些任务才可交给 Agent 执行。')
    fireEvent.click(within(decision).getByRole('button', { name: '确认 Plan' }))

    await within(decision).findByText('Plan 已确认')
    expect(within(decision).queryByRole('button', { name: '确认 Plan' })).toBeNull()
  })
})

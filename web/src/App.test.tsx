// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const PLAN_CHECKSUM_1 = 'a'.repeat(64)
const PLAN_CHECKSUM_2 = 'b'.repeat(64)

function planItem(key: string, depends_on: string[] = []) {
  return {
    key,
    task_type: 'PREPARE_ONLY' as const,
    title: `${key} title`,
    rationale: `${key} rationale`,
    expected_outcome: `${key} outcome`,
    depends_on,
    scheduled_start: null,
    parameters: {},
  }
}

function planView(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    merchant_id: 1,
    source_kind: 'AGENT',
    source_run_id: 1,
    state: 'OPEN',
    latest_revision: 1,
    approved_revision: null,
    created_at: '2026-09-01T00:01:00Z',
    closed_at: null,
    current_revision: {
      id: 17,
      plan_id: 7,
      revision: 1,
      decision_state: 'DRAFT',
      schema_version: 'seo_ops.task_plan.v1',
      checksum: PLAN_CHECKSUM_1,
      source: 'AGENT',
      created_by: 'run-1',
      created_at: '2026-09-01T00:01:00Z',
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      payload: {
        schema_version: 'seo_ops.task_plan.v1',
        tasks: [planItem('draft'), planItem('review', ['draft'])],
      },
    },
    ...overrides,
  }
}

function planViewFor(id: number, runId: number, tasks = [planItem('draft'), planItem('review', ['draft'])]) {
  const base = planView()
  return {
    ...base,
    id,
    source_run_id: runId,
    current_revision: {
      ...base.current_revision,
      plan_id: id,
      payload: { schema_version: 'seo_ops.task_plan.v1', tasks },
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response<T>(data: T, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status >= 500 ? 'Server Error' : 'OK',
    json: async () => data,
  }
}

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

    await screen.findByRole('heading', { name: 'Only Bear Chicken & Boba' })
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

    await screen.findByRole('region', { name: 'AI 分析' })
    screen.getByRole('region', { name: '任务队列' })
  })

  it('links merchant operations to a separate merchant profile view', async () => {
    window.history.pushState({}, '', '/merchants/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1')
        ? { id: 1, name: 'Only Bear', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : [],
    })))
    render(<App />)

    const link = await screen.findByRole('link', { name: '商户资料' })
    expect(link.getAttribute('href')).toBe('/merchants/1/profile')
    screen.getByRole('link', { name: '运营' })
  })

  it('guides an unbound merchant to save an exact FBR merchant id', async () => {
    window.history.pushState({}, '', '/merchants/1/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1/seo-targets')
        ? { merchant_id: 1, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
        : input.endsWith('/api/merchants/1/profile')
        ? {
            merchant_id: 1,
            state: 'unbound',
            fbr_merchant_id: null,
            sync_status: null,
            last_synced_at: null,
            last_error: null,
            locations: [],
          }
        : input.endsWith('/api/merchants/1')
          ? { id: 1, name: 'Only Bear', status: 'active', notes: 'Mineola, NY', auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
          : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    screen.getByRole('heading', { name: '连接 FBR 商户资料' })
    screen.getByRole('textbox', { name: 'FBR Merchant ID' })
    screen.getByRole('button', { name: '保存绑定' })
    expect(screen.queryByText(/OAuth/)).toBeNull()
  })

  it('presents synchronized GBP facts as one readable location record', async () => {
    window.history.pushState({}, '', '/merchants/1/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/1/seo-targets')
        ? {
            merchant_id: 1,
            cycle_id: 'cycle-1',
            cycle_status: 'ready',
            active_stage: null,
            keyword_set: {
              schema_version: 'seo_ops.keyword_set.v2',
              merchant_id: '1',
              market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Mineola, NY' },
              generation_method: 'PERSISTED_FBR_READBACK',
              title: 'Only Bear keyword set',
              summary: 'US local SEO targets.',
              keywords: [{
                keyword: 'fried chicken mineola ny',
                strategy: 'LOCAL',
                intent: 'LOCAL',
                priority: 'UNSCORED',
                rationale: 'Connected category and location evidence.',
                source_tags: ['FBR_KEYWORD_STORE'],
                target_surface_types: ['GBP', 'WEBSITE'],
                target_location: 'Mineola, NY',
              }],
              evidence_gaps: [],
            },
            audit_report: null,
            ranking_report: {
              schema_version: 'seo_ops.ranking_report.v1',
              merchant_id: '1',
              title: 'Only Bear ranking baseline',
              summary: 'Live baseline.',
              captured_at: '2026-09-02T03:30:00Z',
              source_mode: 'LIVE_READ_ONLY',
              keywords: [{ keyword: 'fried chicken mineola ny', local_rank: 3, organic_rank: 8, source: 'LIVE_READ_ONLY', note: 'DataForSEO Local Pack.' }],
              limitations: [],
            },
            error: null,
          }
        : input.endsWith('/api/merchants/1/profile')
        ? {
            merchant_id: 1,
            state: 'synced',
            fbr_merchant_id: 'fbr-only-bear',
            sync_status: 'synced',
            last_synced_at: '2026-09-02T03:00:00Z',
            last_error: null,
            locations: [{
              gbp_location_id: 'locations/123',
              google_account_id: 'accounts/77',
              name: 'locations/123',
              place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
              title: 'Only Bear Chicken & Boba',
              phone: '+1 516-555-1010',
              additional_phones: [],
              address: '123 Mineola Ave, Mineola, NY 11501, US',
              address_lines: ['123 Mineola Ave'],
              locality: 'Mineola',
              administrative_area: 'NY',
              postal_code: '11501',
              region_code: 'US',
              website_url: 'https://onlybear.example.com',
              primary_category: 'Chicken restaurant',
              additional_categories: ['Bubble tea store'],
              open_status: 'OPEN',
              description: 'Crispy chicken and boba in Mineola.',
              regular_hours: [{ open_day: 'MONDAY', open_time: '11:00', close_day: 'MONDAY', close_time: '21:00' }],
              attribute_count: 3,
              post_count: 6,
              live_post_count: 6,
              recent_posts: [{
                post_id: 'post-1',
                state: 'LIVE',
                summary: 'Fresh pastries near Broadway\nWarm scratch-baked croissants, made daily with real butter.',
                created_at: '2026-09-01T10:00:00Z',
                updated_at: null,
                media_count: 1,
                media_url: 'https://images.example/post-1.jpg',
                media_format: 'PHOTO',
                cta_type: 'ORDER',
                cta_url: 'https://order.example.com',
              }, ...Array.from({ length: 5 }, (_, index) => ({
                post_id: `post-${index + 2}`,
                state: 'LIVE',
                summary: `Scheduled post ${index + 2}`,
                created_at: `2026-08-${String(30 - index).padStart(2, '0')}T10:00:00Z`,
                updated_at: null,
                media_count: 1,
                media_url: `https://images.example/post-${index + 2}.jpg`,
                media_format: 'PHOTO',
                cta_type: null,
                cta_url: null,
              }))],
              menu_count: 1,
              menu_section_count: 2,
              menu_item_count: 14,
              menu_sections: [{ name: 'Lunch', item_count: 8 }, { name: 'Drinks', item_count: 6 }],
              menu_items: [
                {
                  section_name: 'Lunch',
                  name: 'Avocado sandwich',
                  description: 'House-made lunch favorite',
                  price_amount: 12.5,
                  currency_code: 'USD',
                  media_url: null,
                },
                {
                  section_name: 'Drinks',
                  name: 'Cold Brew',
                  description: 'Slow-steeped house coffee',
                  price_amount: 5.5,
                  currency_code: 'USD',
                  media_url: null,
                },
                ...Array.from({ length: 5 }, (_, index) => ({
                  section_name: 'Lunch',
                  name: `Menu item ${index + 3}`,
                  description: `Menu description ${index + 3}`,
                  price_amount: index + 7,
                  currency_code: 'USD',
                  media_url: index === 4 ? 'https://images.example/menu-7.jpg' : null,
                })),
              ],
              review_count: 17,
              review_sync_status: 'ready',
              review_scope: 'recent_month',
              review_average_rating: 4.8,
              review_reply_rate: 0.94,
              recent_reviews: [{
                review_id: 'review-1',
                rating: 5,
                content: 'Great neighborhood cafe',
                reviewer_name: 'Jamie',
                created_at: '2026-09-01T12:00:00Z',
                has_reply: false,
              }],
              media_count: null,
              customer_media_count: null,
              question_count: null,
              place_action_link_count: null,
              verification_count: null,
              performance_metrics: [
                { metric_date: '2026-09-01', metric: 'BUSINESS_IMPRESSIONS_MOBILE_MAPS', value: 1215 },
                { metric_date: '2026-09-01', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS', value: 70 },
                { metric_date: '2026-09-01', metric: 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH', value: 664 },
                { metric_date: '2026-09-01', metric: 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH', value: 129 },
                { metric_date: '2026-09-01', metric: 'WEBSITE_CLICKS', value: 14 },
                { metric_date: '2026-09-01', metric: 'BUSINESS_DIRECTION_REQUESTS', value: 26 },
                { metric_date: '2026-09-01', metric: 'CALL_CLICKS', value: 1 },
              ],
              search_keywords: [
                { month: '2026-08', keyword: 'coffee', value: 6246 },
                { month: '2026-07', keyword: 'coffee', value: 754 },
                { month: '2026-08', keyword: 'breakfast', value: 2727 },
                { month: '2026-08', keyword: 'brunch', value: 2376 },
              ],
              source_updated_at: '2026-09-02T02:30:00Z',
              synced_at: '2026-09-02T03:00:00Z',
            }],
          }
        : input.endsWith('/api/merchants/1')
          ? { id: 1, name: 'Only Bear', status: 'active', notes: 'Mineola, NY', auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
          : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    screen.getByRole('combobox', { name: 'GBP 门店' })
    screen.getByRole('heading', { name: 'Only Bear Chicken & Boba' })
    screen.getByText('123 Mineola Ave, Mineola, NY 11501, US')
    screen.getByText('+1 516-555-1010')
    screen.getByRole('link', { name: 'https://onlybear.example.com' })
    screen.getByText('Chicken restaurant')
    screen.getByText('Crispy chicken and boba in Mineola.')
    screen.getByText('周一 11:00–21:00')
    screen.getByRole('navigation', { name: 'GBP 资料分区' })
    screen.getByRole('heading', { name: '内容资产' })
    screen.getByText('本次同步 6 条')
    screen.getByText('显示 5 / 6')
    expect(screen.getAllByRole('img', { name: 'GBP Post 缩略图' })).toHaveLength(5)
    expect(screen.queryByText('Scheduled post 6')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看全部 6 条 Post' }))
    expect(screen.getAllByText('Scheduled post 6')).toHaveLength(2)
    expect(screen.getAllByRole('img', { name: 'GBP Post 缩略图' })).toHaveLength(6)
    const unavailableThumbnail = screen.getAllByRole('img', { name: 'GBP Post 缩略图' })[0]
    fireEvent.error(unavailableThumbnail)
    expect(document.body.contains(unavailableThumbnail)).toBe(false)
    expect(screen.queryAllByRole('img', { name: 'GBP Post 配图' })
      .filter(image => image.getAttribute('src') === 'https://images.example/post-1.jpg')).toHaveLength(0)
    expect(screen.getAllByText('媒体暂不可用')).toHaveLength(2)
    screen.getByText('1 个菜单 · 2 个分类 · 14 个菜品')
    screen.getByRole('combobox', { name: '菜品分类' })
    screen.getByRole('img', { name: 'Menu item 7' })
    screen.getByText('House-made lunch favorite')
    screen.getByText('$12.50')
    expect(screen.getAllByText('暂无菜品图片')).toHaveLength(5)
    expect(screen.queryByText('Menu item 6')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看全部 7 个菜品' }))
    screen.getByText('Menu item 6')
    fireEvent.change(screen.getByRole('combobox', { name: '菜品分类' }), { target: { value: 'Drinks' } })
    screen.getByText('Cold Brew')
    expect(screen.queryByText('Avocado sandwich')).toBeNull()
    expect(screen.queryByRole('button', { name: '字段说明' })).toBeNull()
    const storeCodeHelp = screen.getByRole('button', { name: '说明：门店代码' })
    fireEvent.click(storeCodeHelp)
    within(screen.getByRole('dialog', { name: '门店代码说明' })).getByText(/不是 GBP Location ID/)
    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('dialog', { name: '门店代码说明' })).toBeNull()
    fireEvent.click(storeCodeHelp)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '门店代码说明' })).toBeNull()
    screen.getByRole('button', { name: '说明：同步数量' })
    screen.getByRole('button', { name: '说明：真实搜索词' })
    screen.getByRole('button', { name: '说明：目标关键词' })
    screen.getByRole('button', { name: '说明：本地排名' })
    screen.getByRole('button', { name: '说明：自然排名' })
    screen.getByText(/Warm scratch-baked croissants/)
    expect(screen.getByRole('link', { name: '打开 ORDER 链接' }).getAttribute('href')).toBe('https://order.example.com')
    screen.getByText('Great neighborhood cafe')
    screen.getByText('近 30 天 17 条')
    screen.getByText('平均 4.8 · 回复率 94%')
    screen.getByText('独立媒体库未同步')
    screen.getByRole('heading', { name: 'GBP 表现与真实搜索词' })
    screen.getByText('地图曝光')
    screen.getByText('1,285')
    screen.getByText('搜索曝光')
    screen.getByText('793')
    screen.getByText('网站点击')
    screen.getByText('路线请求')
    screen.getByText('电话点击')
    screen.getByRole('heading', { name: '真实搜索词' })
    screen.getByText('coffee')
    screen.getByText('7,000')
    screen.getByText('breakfast')
    screen.getByText('2,727')
    screen.getByText('brunch')
    screen.getByText('2,376')
    screen.getByRole('heading', { name: 'SEO 目标关键词与排名' })
    screen.getByText('fried chicken mineola ny')
    screen.getByText('待运营确认')
    screen.getByText('#3')
    screen.getByText('#8')
    screen.getByText('FBR 已落库 · 1 个关键词')
    screen.getByRole('button', { name: '重新同步关键词库' })
    screen.getByText('排名来源：DataForSEO')
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull()
    expect(screen.queryByText('尚未接入')).toBeNull()
    expect(screen.queryByText('UAT 接口未部署')).toBeNull()
    screen.getByText('同步于 09-02 11:00')
  })

  it('shows Local Falcon reports as compact heatmap rows and opens a fixed report drawer', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets')
        ? {
            merchant_id: 3,
            cycle_id: 'cycle-lf',
            cycle_status: 'ready',
            active_stage: null,
            keyword_set: {
              schema_version: 'seo_ops.keyword_set.v2',
              merchant_id: '3',
              market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Upper West Side, New York, NY' },
              generation_method: 'EVIDENCE_BOUNDED_RESEARCH',
              title: 'UWS keyword set',
              summary: 'Accepted targets.',
              keywords: [
                { keyword: 'breakfast upper west side', strategy: 'LOCAL', intent: 'LOCAL', priority: 'UNSCORED', rationale: 'Local target.', source_tags: ['GBP'], target_surface_types: ['GBP'], target_location: 'Upper West Side' },
                { keyword: 'coffee near lincoln center', strategy: 'LOCAL', intent: 'LOCAL', priority: 'UNSCORED', rationale: 'Local target.', source_tags: ['GBP'], target_surface_types: ['GBP'], target_location: 'Upper West Side' },
              ],
              evidence_gaps: [],
            },
            audit_report: null,
            ranking_report: {
              schema_version: 'seo_ops.ranking_report.v1',
              merchant_id: '3',
              title: 'UWS ranking baseline',
              summary: 'Live baseline.',
              captured_at: '2026-09-02T03:30:00Z',
              source_mode: 'LIVE_READ_ONLY',
              keywords: [
                { keyword: 'breakfast upper west side', local_rank: 1, organic_rank: null, source: 'LIVE_READ_ONLY', note: 'Local Falcon ARP rounded by the v1 Agent.' },
                { keyword: 'coffee near lincoln center', local_rank: 3, organic_rank: 8, source: 'LIVE_READ_ONLY', note: 'DataForSEO Local Pack.' },
              ],
              limitations: [],
            },
            local_falcon: {
              status: 'synced',
              last_synced_at: '2026-09-02T08:30:00Z',
              last_error: null,
              missing_keywords: ['coffee near lincoln center'],
              reports: [{
                schema_version: 'seo_ops.local_falcon_snapshot.v1',
                report_key: '8aa3c7e1f6c599b',
                place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
                keyword: 'breakfast upper west side',
                platform: 'google',
                captured_at: '2026-08-28T12:00:00',
                center_lat: 40.1,
                center_lng: -73.1,
                grid_size: 3,
                radius: 0.5,
                measurement: 'km',
                arp: 1.38,
                atrp: 1.38,
                solv: 93.83,
                found_in: 9,
                image_url: null,
                heatmap_url: null,
                grid_points: [
                  { lat: 40.2, lng: -73.2, found: true, rank: 1 },
                  { lat: 40.1, lng: -73.2, found: true, rank: 1 },
                  { lat: 40.0, lng: -73.2, found: true, rank: 2 },
                  { lat: 40.2, lng: -73.1, found: true, rank: 1 },
                  { lat: 40.1, lng: -73.1, found: true, rank: 1 },
                  { lat: 40.0, lng: -73.1, found: true, rank: 3 },
                  { lat: 40.2, lng: -73.0, found: true, rank: 2 },
                  { lat: 40.1, lng: -73.0, found: true, rank: 4 },
                  { lat: 40.0, lng: -73.0, found: true, rank: 8 },
                ],
              }],
            },
            capabilities: { can_regenerate: true },
            error: null,
          }
        : input.endsWith('/api/merchants/3/profile')
          ? {
              merchant_id: 3,
              state: 'synced',
              fbr_merchant_id: 'fbr-choice',
              sync_status: 'synced',
              last_synced_at: '2026-09-02T03:00:00Z',
              last_error: null,
              locations: [{
                gbp_location_id: 'locations/uws',
                title: 'Choice Brooklyn - Upper West Side',
                address: '2040 Broadway, New York, NY 10023, US',
                additional_phones: [],
                address_lines: [],
                additional_categories: [],
                regular_hours: [],
                menu_sections: [],
                menu_items: [],
                recent_posts: [],
                recent_reviews: [],
                performance_metrics: [],
                search_keywords: [],
                synced_at: '2026-09-02T03:00:00Z',
              }],
            }
          : input.endsWith('/api/merchants/3')
            ? { id: 3, name: 'Choice Brooklyn - Upper West Side', primary_location: '2040 Broadway, New York, NY 10023', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
    })))

    render(<App />)

    await screen.findByRole('heading', { name: 'SEO 目标关键词与排名' })
    screen.getByRole('button', { name: '重新生成' })
    screen.getByRole('button', { name: '同步已有 Local Falcon 报告' })
    screen.getByRole('columnheader', { name: '热力图' })
    screen.getByRole('img', { name: 'breakfast upper west side Local Falcon 热力图' })
    screen.getByText('3 × 3 grid')
    screen.getByText('0.5 km radius')
    expect(screen.getAllByText('1.38')).toHaveLength(2)
    screen.getByText('93.83')
    expect(screen.queryByRole('button', { name: '查看 coffee near lincoln center 的 Local Falcon 报告' })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'breakfast upper west side Local Falcon 报告' })).toBeNull()
    const detailButton = screen.getByRole('button', { name: '查看 breakfast upper west side 的 Local Falcon 报告' })
    fireEvent.click(detailButton)
    const drawer = screen.getByRole('dialog', { name: 'breakfast upper west side Local Falcon 报告' })
    const grid = within(drawer).getByRole('grid', { name: 'breakfast upper west side 地理排名点阵' })
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(9)
    within(drawer).getByText('3 × 3')
    within(drawer).getByText('0.5 km')
    within(drawer).getByText('报告 8aa3c7e1f6c599b')
    fireEvent.click(within(drawer).getByRole('button', { name: '关闭 Local Falcon 报告' }))
    expect(screen.queryByRole('dialog', { name: 'breakfast upper west side Local Falcon 报告' })).toBeNull()
  })

  it('defaults a multi-location profile to the GBP record matching the SEO Ops merchant', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets')
        ? { merchant_id: 3, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
        : input.endsWith('/api/merchants/3/profile')
        ? {
            merchant_id: 3,
            state: 'synced',
            fbr_merchant_id: 'fbr-choice',
            sync_status: 'synced',
            last_synced_at: '2026-09-02T03:00:00Z',
            last_error: null,
            locations: [
              {
                gbp_location_id: 'locations/clinton',
                title: 'Choice Brooklyn - Clinton Hill',
                address: '318 Lafayette Avenue, Brooklyn, NY 11238, US',
                additional_phones: [],
                address_lines: [],
                additional_categories: [],
                regular_hours: [],
                synced_at: '2026-09-02T03:00:00Z',
              },
              {
                gbp_location_id: 'locations/uws',
                title: 'Choice Brooklyn - Upper West Side',
                address: '2040 Broadway, New York, NY 10023, US',
                additional_phones: [],
                address_lines: [],
                additional_categories: [],
                regular_hours: [],
                synced_at: '2026-09-02T03:00:00Z',
              },
            ],
          }
        : input.endsWith('/api/merchants/3')
          ? { id: 3, name: 'Choice Brooklyn - Upper West Side', primary_location: '2040 Broadway, New York, NY 10023', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
          : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    expect((screen.getByRole('combobox', { name: 'GBP 门店' }) as HTMLSelectElement).value).toBe('locations/uws')
    screen.getByRole('heading', { name: 'Choice Brooklyn - Upper West Side', level: 2 })
  })

  it('automatically reads the FBR keyword repository only when no saved snapshot exists', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => ({
      ok: true,
      status: input.endsWith('/seo-targets/refresh') ? 202 : 200,
      json: async () => input.endsWith('/seo-targets/refresh') && init?.method === 'POST'
        ? {
            merchant_id: 3,
            cycle_id: 'first-fbr-read',
            cycle_status: 'ready',
            active_stage: null,
            keyword_set: {
              schema_version: 'seo_ops.keyword_set.v2',
              merchant_id: '3',
              market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Upper West Side' },
              generation_method: 'PERSISTED_FBR_READBACK',
              title: 'UWS persisted keywords',
              summary: 'Read from FBR.',
              keywords: [{ keyword: 'breakfast upper west side', strategy: 'LOCAL', intent: 'LOCAL', priority: 'P1', rationale: 'Persisted.', source_tags: ['FBR_KEYWORD_STORE'], target_surface_types: ['GBP'], target_location: 'Upper West Side' }],
              evidence_gaps: [],
            },
            audit_report: null,
            ranking_report: null,
            error: null,
          }
        : input.endsWith('/api/merchants/3/seo-targets')
          ? { merchant_id: 3, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
          : input.endsWith('/api/merchants/3/profile')
            ? {
                merchant_id: 3,
                state: 'synced',
                fbr_merchant_id: 'fbr-choice',
                sync_status: 'synced',
                last_synced_at: '2026-09-02T03:00:00Z',
                last_error: null,
                locations: [{
                  gbp_location_id: 'locations/uws',
                  title: 'Choice Brooklyn - Upper West Side',
                  address: '2040 Broadway, New York, NY 10023, US',
                  additional_phones: [],
                  address_lines: [],
                  additional_categories: [],
                  regular_hours: [],
                  menu_sections: [],
                  menu_items: [],
                  recent_posts: [],
                  recent_reviews: [],
                  performance_metrics: [],
                  search_keywords: [],
                  synced_at: '2026-09-02T03:00:00Z',
                }],
              }
            : input.endsWith('/api/merchants/3')
              ? { id: 3, name: 'Choice Brooklyn - Upper West Side', primary_location: '2040 Broadway, New York, NY 10023', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
              : [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByRole('button', { name: '重新同步关键词库' })
    screen.getByText('FBR 已落库 · 1 个关键词')
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input, init]) =>
        String(input).endsWith('/api/merchants/3/seo-targets/refresh') && (init as RequestInit | undefined)?.method === 'POST',
      )).toHaveLength(1)
    })
  })

  it('shows unavailable review data as unsynced instead of zero reviews', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets')
        ? { merchant_id: 3, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
        : input.endsWith('/api/merchants/3/profile')
          ? {
              merchant_id: 3,
              state: 'synced',
              fbr_merchant_id: 'fbr-choice',
              sync_status: 'synced',
              last_synced_at: '2026-09-02T03:00:00Z',
              last_error: null,
              locations: [{
                gbp_location_id: 'locations/uws',
                title: 'Choice Brooklyn - Upper West Side',
                address: '2040 Broadway, New York, NY 10023, US',
                additional_phones: [],
                address_lines: [],
                additional_categories: [],
                regular_hours: [],
                review_sync_status: 'unavailable',
                review_count: null,
                recent_reviews: [],
                synced_at: '2026-09-02T03:00:00Z',
              }],
            }
          : input.endsWith('/api/merchants/3')
            ? { id: 3, name: 'Choice Brooklyn - Upper West Side', primary_location: '2040 Broadway, New York, NY 10023', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
    })))
    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    screen.getByText('评价数据未同步')
    screen.getByText('Review Integration 尚未关联这家 GBP 门店；这不代表 Google 商户页面没有评价。')
    expect(screen.queryByText('0 条')).toBeNull()
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

  it('uses the persisted Plan to show a completed diagnosis even before formal Tasks exist', async () => {
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
            ? []
            : input.endsWith('/api/runs/7/task-plan')
              ? planView({ source_run_id: 7 })
            : [],
    })))
    render(<App />)

    const status = await screen.findByRole('region', { name: '初始诊断' })
    within(status).getByRole('heading', { name: '诊断完成，Plan 草案待确认' })
    within(status).getByRole('button', { name: '查看并编辑 Plan' })
    expect(within(status).queryAllByRole('button')).toHaveLength(1)
    expect(screen.queryByRole('link', { name: 'draft title' })).toBeNull()
    expect(screen.queryByRole('button', { name: '开始' })).toBeNull()
  })

  it('keeps merchant task and Plan read errors isolated while retrying only the Plan', async () => {
    window.history.pushState({}, '', '/merchants/1')
    let planAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/merchants/1') return response({
        id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z',
      })
      if (input === '/api/merchants/1/tasks') return response({ detail: 'task queue read failed' }, 503)
      if (input === '/api/merchants/1/runs') return response([{
        id: 7, merchant_id: 1, coreai_run_id: 'run-7', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: null,
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      }])
      if (input === '/api/runs/7/task-plan') {
        planAttempts += 1
        return planAttempts === 1
          ? response({ detail: 'persisted plan read failed' }, 500)
          : response(planView({ source_run_id: 7 }))
      }
      return response([])
    }))

    render(<App />)

    const diagnosis = await screen.findByRole('region', { name: '初始诊断' })
    within(diagnosis).getByRole('heading', { name: '无法读取 Task Plan' })
    within(diagnosis).getByText('persisted plan read failed')
    screen.getByText('task queue read failed')
    expect(within(diagnosis).queryByRole('button', { name: '重新分析' })).toBeNull()
    fireEvent.click(within(diagnosis).getByRole('button', { name: '重试读取 Plan' }))

    await within(diagnosis).findByRole('heading', { name: '诊断完成，Plan 草案待确认' })
    screen.getByText('task queue read failed')
    expect(planAttempts).toBe(2)
  })

  it('does not let stale merchant reads overwrite a new merchant route', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const oldMerchant = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/merchants/1') return oldMerchant.promise
      if (input === '/api/merchants/2') return Promise.resolve(response({
        id: 2, name: 'Current Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-02T00:00:00Z',
      }))
      return Promise.resolve(response([]))
    }))
    render(<App />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/merchants/1')).toBe(true))

    act(() => {
      window.history.pushState({}, '', '/merchants/2')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: 'Current Merchant' })
    oldMerchant.resolve(response({
      id: 1, name: 'Stale Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z',
    }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: 'Stale Merchant' })).toBeNull()
    screen.getByRole('heading', { name: 'Current Merchant' })
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

    await screen.findByRole('link', { name: '返回商户列表' })
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

    await screen.findByRole('button', { name: '交给 Agent 执行' })
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

    await screen.findByRole('button', { name: '返回冒烟商户' })
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

  it('keeps draft Plan items out of the formal task list and opens the Plan workspace', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: input !== '/api/runs/1/audit',
      status: input === '/api/runs/1/audit' ? 404 : 200,
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
        : input === '/api/runs/1/task-plan'
          ? planView()
        : input === '/api/runs/1/audit'
          ? { detail: 'accepted audit not found' }
          : { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' },
    })))
    render(<App />)

    await screen.findByRole('link', { name: '返回冒烟商户' })
    screen.getByRole('heading', { name: '09-01 08:00 分析报告' })
    const report = screen.getByRole('region', { name: '报告正文' })
    const tasks = screen.getByRole('complementary', { name: '本次生成任务' })
    const planLink = screen.getByRole('link', { name: '查看并编辑 Plan' })
    expect(planLink.getAttribute('href')).toBe('/task-plans/7')
    within(tasks).getByText(/Revision 1/)
    within(tasks).getByText('0 项')
    within(tasks).getByText('当前 Plan 草稿包含 2 项；尚未物化正式 Task。')
    screen.getByText('1 分钟')
    expect(report.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'draft title' })).toBeNull()
    expect(screen.queryByRole('table', { name: '任务列表' })).toBeNull()
    expect(screen.queryByText('分析 #1')).toBeNull()
  })

  it('loads canonical formal Tasks only after a Plan revision is approved', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({ detail: 'accepted audit not found' }) }
      }
      const data = input === '/api/runs/1'
        ? {
            id: 1,
            merchant_id: 1,
            coreai_run_id: 'run-1',
            status: 'succeeded',
            trigger_kind: 'manual',
            report_text: '# 报告',
            error: null,
            plan_approved_at: '2026-09-01T00:02:00Z',
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          }
        : input === '/api/runs/1/task-plan'
          ? planView({
              approved_revision: 1,
              current_revision: { ...planView().current_revision, decision_state: 'APPROVED' },
            })
          : input === '/api/tasks?plan_id=7'
            ? [{
                id: 11,
                merchant_id: 1,
                plan_id: 7,
                plan_revision: 1,
                task_key: 'draft',
                task_type: 'PREPARE_ONLY',
                title: '正式准备任务',
                category: 'content',
                status: 'PENDING',
                source_run_id: 1,
              }]
            : { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
      return { ok: true, status: 200, json: async () => data }
    }))
    render(<App />)

    await screen.findByText('Plan Revision 1 已批准')
    screen.getByRole('link', { name: '正式准备任务' })
    expect(screen.queryByRole('button', { name: '确认 Plan' })).toBeNull()
  })

  it('shows only current approved Plan tasks in stable payload order', async () => {
    window.history.pushState({}, '', '/runs/1')
    const approved = planView({
      approved_revision: 1,
      current_revision: {
        ...planView().current_revision,
        decision_state: 'APPROVED',
        payload: {
          schema_version: 'seo_ops.task_plan.v1',
          tasks: [planItem('review', ['draft']), planItem('draft')],
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') return response({ detail: 'accepted audit not found' }, 404)
      if (input === '/api/runs/1') return response({
        id: 1,
        merchant_id: 1,
        coreai_run_id: 'run-1',
        status: 'succeeded',
        trigger_kind: 'manual',
        report_text: '# Report',
        error: null,
        plan_approved_at: '2026-09-01T00:02:00Z',
        created_at: '2026-09-01T00:00:00Z',
        finished_at: '2026-09-01T00:01:00Z',
      })
      if (input === '/api/runs/1/task-plan') return response(approved)
      if (input === '/api/tasks?plan_id=7') return response([
        { id: 99, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'obsolete', task_type: 'PREPARE_ONLY', title: 'Removed history', category: null, status: 'CANCELLED', source_run_id: 1 },
        { id: 12, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft formal task', category: 'content', status: 'PENDING', source_run_id: 1 },
        { id: 11, merchant_id: 1, plan_id: 7, plan_revision: 0, task_key: 'review', task_type: 'PREPARE_ONLY', title: 'Review formal task', category: 'review', status: 'DONE', source_run_id: 1 },
      ])
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    const taskPanel = await screen.findByRole('complementary', { name: '本次生成任务' })
    await within(taskPanel).findByRole('link', { name: 'Review formal task' })
    const taskLinks = within(taskPanel).getAllByRole('link').filter(link => link.getAttribute('href')?.startsWith('/tasks/'))
    expect(taskLinks.map(link => link.textContent)).toEqual(['Review formal task', 'Draft formal task'])
    within(taskPanel).getByText('2 项')
    expect(within(taskPanel).queryByText('Removed history')).toBeNull()
  })

  it('does not mix an older approved task set into a latest draft revision', async () => {
    window.history.pushState({}, '', '/runs/1')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      calls.push(input)
      if (input === '/api/runs/1/audit') return response({ detail: 'accepted audit not found' }, 404)
      if (input === '/api/runs/1/task-plan') return response(planView({
        latest_revision: 2,
        approved_revision: 1,
        current_revision: { ...planView().current_revision, revision: 2, checksum: PLAN_CHECKSUM_2 },
      }))
      if (input === '/api/runs/1') return response({
        id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: '2026-09-01T00:02:00Z',
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      })
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    const taskPanel = await screen.findByRole('complementary', { name: '本次生成任务' })
    await within(taskPanel).findByText('Plan Revision 2 待审批')
    within(taskPanel).getByText('0 项')
    within(taskPanel).getByText('当前 Plan 草稿包含 2 项；Revision 1 的历史 Task 请到任务队列查看。')
    expect(calls).not.toContain('/api/tasks?plan_id=7')
  })

  it('fails closed when canonical Plan tasks contain a duplicate key', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') return response({ detail: 'accepted audit not found' }, 404)
      if (input === '/api/runs/1/task-plan') return response(planView({
        approved_revision: 1,
        current_revision: { ...planView().current_revision, decision_state: 'APPROVED' },
      }))
      if (input === '/api/tasks?plan_id=7') return response([
        { id: 11, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft A', category: null, status: 'PENDING', source_run_id: 1 },
        { id: 12, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft B', category: null, status: 'PENDING', source_run_id: 1 },
        { id: 13, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'review', task_type: 'PREPARE_ONLY', title: 'Review task', category: null, status: 'PENDING', source_run_id: 1 },
      ])
      if (input === '/api/runs/1') return response({
        id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: '2026-09-01T00:02:00Z',
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      })
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    await screen.findByText('正式 Task 数据包含重复 key：draft')
    expect(screen.queryByRole('link', { name: 'Draft A' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'Draft B' })).toBeNull()
    within(screen.getByRole('complementary', { name: '本次生成任务' })).getByText('0 项')
  })

  it('distinguishes a Run Plan load error from 404 and retries without clearing audit errors', async () => {
    window.history.pushState({}, '', '/runs/1')
    let planAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1') return response({
        id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: null,
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      })
      if (input === '/api/runs/1/audit') return response({ detail: 'audit storage unavailable' }, 500)
      if (input === '/api/runs/1/task-plan') {
        planAttempts += 1
        return planAttempts === 1
          ? response({ detail: 'persisted plan read failed' }, 500)
          : response({ detail: 'plan not found' }, 404)
      }
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    const taskPanel = await screen.findByRole('complementary', { name: '本次生成任务' })
    await within(taskPanel).findByRole('alert', { name: 'Task Plan 读取失败' })
    within(taskPanel).getByText('persisted plan read failed')
    screen.getByText('audit storage unavailable')
    expect(within(taskPanel).queryByText('本次分析没有生成可编辑 Task Plan。')).toBeNull()
    fireEvent.click(within(taskPanel).getByRole('button', { name: '重试读取 Plan' }))

    await within(taskPanel).findByText('本次分析没有生成可编辑 Task Plan。')
    screen.getByText('audit storage unavailable')
    expect(planAttempts).toBe(2)
  })

  it('does not let stale Run reads overwrite a new Run route', async () => {
    window.history.pushState({}, '', '/runs/1')
    const oldRun = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/runs/1') return oldRun.promise
      if (input === '/api/runs/2') return Promise.resolve(response({
        id: 2, merchant_id: 2, coreai_run_id: 'run-2', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Current report', error: null, plan_approved_at: null,
        created_at: '2026-09-02T00:00:00Z', finished_at: '2026-09-02T00:01:00Z',
      }))
      if (input === '/api/merchants/2') return Promise.resolve(response({
        id: 2, name: 'Current Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-02T00:00:00Z',
      }))
      if (input.includes('/task-plan') || input.includes('/audit')) {
        return Promise.resolve(response({ detail: 'not found' }, 404))
      }
      return Promise.resolve(response([]))
    }))
    render(<App />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/runs/1')).toBe(true))

    act(() => {
      window.history.pushState({}, '', '/runs/2')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: '09-02 08:00 分析报告' })
    oldRun.resolve(response({
      id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
      report_text: '# Stale report', error: null, plan_approved_at: null,
      created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
    }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: '09-01 08:00 分析报告' })).toBeNull()
    screen.getByRole('heading', { name: 'Current report' })
  })

  it('keeps a Plan review bound to the current route across reverse responses', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    const seven = deferred<ReturnType<typeof response>>()
    const eight = deferred<ReturnType<typeof response>>()
    const mutations: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/task-plans/7') return seven.promise
      if (input === '/api/task-plans/8') return eight.promise
      if (init?.method === 'PUT') {
        mutations.push(input)
        const body = JSON.parse(String(init.body))
        const saved = planViewFor(8, 8, body.plan.tasks)
        return Promise.resolve(response({
          ...saved,
          latest_revision: 2,
          current_revision: {
            ...saved.current_revision,
            revision: 2,
            checksum: PLAN_CHECKSUM_2,
            payload: body.plan,
          },
        }))
      }
      return Promise.resolve(response([]))
    }))

    render(<App />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/task-plans/7')).toBe(true))
    act(() => {
      window.history.pushState({}, '', '/task-plans/8')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    expect(screen.queryByRole('textbox', { name: '任务标题 draft' })).toBeNull()
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/task-plans/8')).toBe(true))

    eight.resolve(response(planViewFor(8, 8, [{ ...planItem('eight'), title: 'Plan eight task' }])))
    const eightTitle = await screen.findByRole('textbox', { name: '任务标题 eight' }) as HTMLInputElement
    expect(eightTitle.value).toBe('Plan eight task')

    seven.resolve(response(planViewFor(7, 7, [{ ...planItem('seven'), title: 'Stale seven task' }])))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('textbox', { name: '任务标题 seven' })).toBeNull()
    expect(screen.getByText('#8')).toBeTruthy()

    fireEvent.change(eightTitle, { target: { value: 'Updated Plan eight task' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Plan 草稿' }))
    await screen.findByText('已保存 Revision 2')
    expect(mutations).toEqual(['/api/task-plans/8/draft'])
  })

  it('runs Plan mutations single-flight and freezes every editor decision while pending', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    const saveResponse = deferred<ReturnType<typeof response>>()
    const approveResponse = deferred<ReturnType<typeof response>>()
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/task-plans/7/draft') {
        calls.push({ input, init })
        return saveResponse.promise
      }
      if (input === '/api/task-plans/7/approve') {
        calls.push({ input, init })
        return approveResponse.promise
      }
      return Promise.resolve(response(planView()))
    }))
    render(<App />)

    const title = await screen.findByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Edited once' } })
    fireEvent.click(screen.getByRole('button', { name: '标记删除 review' }))
    const removalReason = screen.getByRole('textbox', { name: '删除原因 review' }) as HTMLTextAreaElement
    fireEvent.change(removalReason, { target: { value: 'Folded into the draft step.' } })
    const save = screen.getByRole('button', { name: '保存 Plan 草稿' }) as HTMLButtonElement
    act(() => { save.click(); save.click() })

    await waitFor(() => expect(calls.filter(call => call.input.endsWith('/draft'))).toHaveLength(1))
    expect(title.disabled).toBe(true)
    expect((screen.getByRole('listbox', { name: '前置任务 draft' }) as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '添加 Task' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '标记删除 draft' }) as HTMLButtonElement).disabled).toBe(true)
    expect(removalReason.disabled).toBe(true)
    expect((screen.getByRole('button', { name: '撤销删除 review' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: '拒绝原因' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(title, { target: { value: 'Attempted pending edit' } })
    expect(title.value).toBe('Edited once')

    const draftBody = JSON.parse(String(calls[0].init?.body))
    const savedPlan = planView({
      latest_revision: 2,
      current_revision: {
        ...planView().current_revision,
        revision: 2,
        checksum: PLAN_CHECKSUM_2,
        payload: draftBody.plan,
      },
    })
    saveResponse.resolve(response(savedPlan))
    await screen.findByText('已保存 Revision 2')
    expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).value).toBe('Edited once')

    const approve = screen.getByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement
    act(() => { approve.click(); approve.click() })
    await waitFor(() => expect(calls.filter(call => call.input.endsWith('/approve'))).toHaveLength(1))
    expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).disabled).toBe(true)
    approveResponse.resolve(response({
      ...savedPlan,
      approved_revision: 2,
      current_revision: { ...savedPlan.current_revision, decision_state: 'APPROVED' },
    }))
    await screen.findByText('当前 Revision 已批准')
  })

  it('edits, adds, saves, and approves only the returned complete Plan revision', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    let savedPlan = planView()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') {
        return { ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) }
      }
      if (input === '/api/task-plans/7/draft' && init?.method === 'PUT') {
        calls.push({ input, init })
        const body = JSON.parse(String(init.body))
        savedPlan = planView({
          latest_revision: 2,
          current_revision: {
            ...planView().current_revision,
            id: 18,
            revision: 2,
            checksum: PLAN_CHECKSUM_2,
            source: 'OPERATOR',
            payload: body.plan,
          },
        })
        return { ok: true, status: 200, json: async () => savedPlan }
      }
      if (input === '/api/task-plans/7/approve' && init?.method === 'POST') {
        calls.push({ input, init })
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...savedPlan,
            approved_revision: 2,
            current_revision: { ...savedPlan.current_revision, decision_state: 'APPROVED' },
            tasks: [],
          }),
        }
      }
      return { ok: true, status: 200, json: async () => planView() }
    }))
    render(<App />)

    fireEvent.change(await screen.findByRole('textbox', { name: '任务标题 draft' }), {
      target: { value: 'Draft the weekly post' },
    })
    expect((screen.getByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: '添加 Task' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Task key new-task' }), { target: { value: 'publish' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务标题 publish' }), { target: { value: 'Publish the weekly post' } })
    fireEvent.change(screen.getByRole('textbox', { name: '任务理由 publish' }), { target: { value: 'Keep the profile current' } })
    fireEvent.change(screen.getByRole('textbox', { name: '预期结果 publish' }), { target: { value: 'One reviewed post draft' } })
    const dependencies = screen.getByRole('listbox', { name: '前置任务 publish' }) as HTMLSelectElement
    const reviewOption = within(dependencies).getByRole('option', { name: 'review' }) as HTMLOptionElement
    reviewOption.selected = true
    fireEvent.change(dependencies)

    fireEvent.click(screen.getByRole('button', { name: '保存 Plan 草稿' }))
    await screen.findByText('已保存 Revision 2')
    const draftCall = calls.find(call => call.input.endsWith('/draft'))!
    const draftBody = JSON.parse(String(draftCall.init?.body))
    expect(draftBody.expected_revision).toBe(1)
    expect(draftBody.removals).toEqual([])
    expect(draftBody.plan.tasks.map((item: { key: string }) => item.key)).toEqual(['draft', 'review', 'publish'])
    expect(draftBody.plan.tasks[2].depends_on).toEqual(['review'])

    fireEvent.click(screen.getByRole('button', { name: '批准当前 Plan' }))
    await screen.findByText('当前 Revision 已批准')
    const approveCall = calls.find(call => call.input.endsWith('/approve'))!
    expect(JSON.parse(String(approveCall.init?.body))).toEqual({ revision: 2, checksum: PLAN_CHECKSUM_2 })
  })

  it('keeps an existing Task pending removal until a reason is saved, and can reject the whole Plan', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') {
        return { ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) }
      }
      calls.push({ input, init })
      if (input.endsWith('/draft') && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body))
        return {
          ok: true,
          status: 200,
          json: async () => planView({
            latest_revision: 2,
            current_revision: {
              ...planView().current_revision,
              revision: 2,
              checksum: PLAN_CHECKSUM_2,
              payload: body.plan,
            },
          }),
        }
      }
      if (input.endsWith('/reject') && init?.method === 'POST') {
        return { ok: true, status: 200, json: async () => planView({ state: 'REJECTED', current_revision: { ...planView().current_revision, decision_state: 'REJECTED' } }) }
      }
      return { ok: true, status: 200, json: async () => planView() }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '标记删除 draft' }))
    screen.getByText('待删除')
    expect((screen.getByRole('button', { name: '保存 Plan 草稿' }) as HTMLButtonElement).disabled).toBe(true)
    screen.getByText('任务 review 仍依赖待删除任务 draft，请先调整前置任务')
    fireEvent.change(screen.getByRole('textbox', { name: '删除原因 draft' }), {
      target: { value: 'This draft step is covered elsewhere.' },
    })
    expect((screen.getByRole('button', { name: '保存 Plan 草稿' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '清除全部前置任务' }))
    fireEvent.click(screen.getByRole('button', { name: '保存 Plan 草稿' }))
    await screen.findByText('已保存 Revision 2')
    const body = JSON.parse(String(calls.find(call => call.input.endsWith('/draft'))?.init?.body))
    expect(body.removals).toEqual([{ key: 'draft', reason: 'This draft step is covered elsewhere.' }])
    expect(body.plan.tasks).toEqual([expect.objectContaining({ key: 'review', depends_on: [] })])

    fireEvent.change(screen.getByRole('textbox', { name: '拒绝原因' }), { target: { value: 'This Plan is outside the current cycle.' } })
    fireEvent.click(screen.getByRole('button', { name: '拒绝整个 Plan' }))
    await screen.findByText('当前 Revision 已拒绝')
    const rejectCall = calls.find(call => call.input.endsWith('/reject'))!
    expect(JSON.parse(String(rejectCall.init?.body))).toEqual({
      expected_revision: 2,
      reason: 'This Plan is outside the current cycle.',
    })
  })

  it('disables save and approval when local dependency edits create a cycle', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me' ? { username: 'test', role: 'operator' } : planView(),
    })))
    render(<App />)

    const dependencies = await screen.findByRole('listbox', { name: '前置任务 draft' }) as HTMLSelectElement
    const reviewOption = within(dependencies).getByRole('option', { name: 'review' }) as HTMLOptionElement
    reviewOption.selected = true
    fireEvent.change(dependencies)

    await screen.findByText('Plan 存在循环依赖：draft、review')
    expect((screen.getByRole('button', { name: '保存 Plan 草稿' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('preserves a 409 conflict and prevents approval with the stale checksum', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') {
        return { ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) }
      }
      if (input === '/api/task-plans/7/approve' && init?.method === 'POST') {
        return {
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: async () => ({ detail: 'plan revision changed; refresh and retry' }),
        }
      }
      return { ok: true, status: 200, json: async () => planView() }
    }))
    render(<App />)

    const approve = await screen.findByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)

    await screen.findByText('plan revision changed; refresh and retry')
    expect(approve.disabled).toBe(true)
    screen.getByRole('button', { name: '重新载入服务器 Plan' })
  })

  it('renders an accepted Audit snapshot as decisions instead of raw JSON or legacy Markdown', async () => {
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
            report_text: '# Legacy text that should not be primary',
            error: null,
            created_at: '2026-09-01T00:00:00Z',
            finished_at: '2026-09-01T00:01:00Z',
          }
        : input === '/api/runs/1/audit'
          ? {
              id: 7,
              run_id: 1,
              merchant_id: 1,
              schema_version: 'seo_ops.audit_report.v1',
              evidence_mode: 'PUBLIC_AND_CONFIRMED',
              finding_count: 1,
              source_ref: 'run-1',
              accepted_at: '2026-09-01T00:01:00Z',
              audit: {
                schema_version: 'seo_ops.audit_report.v1',
                merchant_id: '1',
                title: 'Only Bear 本地 SEO 初诊',
                summary: '官网与商户身份已确认，结构化数据仍需处理。',
                evidence_mode: 'PUBLIC_AND_CONFIRMED',
                findings: [{
                  id: 'missing-schema',
                  area: 'TECHNICAL',
                  severity: 'HIGH',
                  observation: '官网未发现 Restaurant 结构化数据。',
                  evidence: ['公开页面源代码检查未发现 Restaurant JSON-LD。'],
                  recommendation: '先生成草稿并由运营审批后上线。',
                }],
                limitations: ['本次未使用 Search Console 数据。'],
                next_actions: ['审阅 Restaurant Schema 草稿。'],
              },
            }
          : input === '/api/runs/1/tasks'
            ? []
            : { id: 1, name: 'Only Bear', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' },
    })))
    render(<App />)

    const audit = await screen.findByRole('article', { name: 'Audit 报告' })
    within(audit).getByRole('heading', { name: 'Only Bear 本地 SEO 初诊' })
    within(audit).getByText('官网与商户身份已确认，结构化数据仍需处理。')
    within(audit).getByText('公开资料 + 已确认信息')
    within(audit).getByText('技术 SEO')
    within(audit).getByText('高优先级')
    within(audit).getByText('官网未发现 Restaurant 结构化数据。')
    within(audit).getByText('公开页面源代码检查未发现 Restaurant JSON-LD。')
    within(audit).getByText('先生成草稿并由运营审批后上线。')
    within(audit).getByText('本次未使用 Search Console 数据。')
    within(audit).getByText('审阅 Restaurant Schema 草稿。')
    expect(screen.queryByText('seo_ops.audit_report.v1')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Legacy text that should not be primary' })).toBeNull()
  })
})

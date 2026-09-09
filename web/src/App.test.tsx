// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api } from './api'
import { isAcceptedLocalFalconBatchReadback, keywordIdentity } from './localFalcon'

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

function activeMerchant(id = 1) {
  return {
    id,
    name: `Merchant ${id}`,
    status: 'active' as const,
    notes: null,
    primary_location: null,
    website_url: null,
    auto_run_interval_days: null,
    created_at: '2026-09-01T00:00:00Z',
  }
}

function canonicalPlanContext(approvedRevision = 1) {
  return {
    id: 7,
    source_kind: 'AGENT',
    state: 'OPEN',
    latest_revision: approvedRevision,
    approved_revision: approvedRevision,
  }
}

function taskSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    merchant_id: 1,
    plan_id: 7,
    plan_revision: 1,
    task_key: 'review',
    task_type: 'PREPARE_ONLY',
    workflow_version: 1,
    parameters: { description: 'Review the prepared copy', category: 'review' },
    definition_checksum: 'c'.repeat(64),
    title: 'Review content',
    description: 'Review the prepared copy',
    rationale: 'Catch unsupported claims',
    expected_outcome: 'A reviewable decision',
    category: 'review',
    scheduled_start: null,
    status: 'PENDING',
    version: 3,
    assignee: null,
    labels: [],
    operator_note: null,
    evidence_note: null,
    source_run_id: 1,
    source_key: 'plan:7:review',
    replaces_task_id: null,
    replaced_by_task_id: null,
    created_at: '2026-09-03T01:00:00+00:00',
    updated_at: '2026-09-03T01:00:00+00:00',
    started_at: null,
    completed_at: null,
    cancelled_at: null,
    merchant_name: 'Only Bear',
    plan: canonicalPlanContext(1),
    source_plan_approved: true,
    blocker: null,
    readiness: 'READY',
    execution_status: null,
    ...overrides,
  }
}

function taskExecution(overrides: Record<string, unknown> = {}) {
  const result = {
    outcome: 'ready',
    summary: 'Prepared a reviewable draft.',
    artifact_refs: ['artifact://draft-v1'],
    evidence: ['Prepared from the approved merchant context.'],
    external_write_performed: false,
  }
  return {
    id: 41,
    task_id: 12,
    stage: 'PREPARATION',
    status: 'SUCCEEDED',
    attempt: 1,
    approval_id: null,
    artifact_id: null,
    request_checksum: 'd'.repeat(64),
    idempotency_key: 'task:12:preparation:1:dddddddddddddddd',
    dispatch_started_at: '2026-09-03T01:01:00+00:00',
    coreai_run_id: null,
    provider_resource_id: null,
    preparation_trust: 'REVIEWABLE',
    error: null,
    review_note: null,
    next_attempt_at: null,
    created_at: '2026-09-03T01:01:00+00:00',
    finished_at: '2026-09-03T01:02:00+00:00',
    reviewed_at: null,
    request: {
      definition_checksum: 'c'.repeat(64),
      executor_kind: 'COREAI_LLM_CALL',
      llm_call_id: 'preparation-call',
      stage: 'PREPARATION',
      task_id: 12,
      workflow_version: 1,
    },
    evidence: result.evidence,
    result,
    result_checksum: 'e'.repeat(64),
    ...overrides,
  }
}

function taskDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...taskSummary(),
    upstream: [],
    downstream: [],
    executions: [],
    events: [{
      id: 91,
      entity_type: 'TASK',
      entity_id: 12,
      event_type: 'TASK_MATERIALIZED',
      actor_type: 'SYSTEM',
      actor_id: null,
      payload: { plan_revision: 1 },
      created_at: '2026-09-03T01:00:00+00:00',
    }],
    ...overrides,
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
    window.sessionStorage.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('only accepts a paid scan readback when request, approval, cohort, config, and status all match', () => {
    const expected = {
      requestId: 'request-1',
      approvalId: 7,
      expectedScanConfigSha256: 'b'.repeat(64),
      keywordArtifactId: 41,
      expectedCohortSha256: 'a'.repeat(64),
    }
    const state = {
      merchant_id: 3,
      cycle_status: 'ready' as const,
      active_stage: null,
      keyword_set: null,
      active_keyword_artifact_id: null,
      active_keyword_source: null,
      active_keyword_activated_at: null,
      keyword_versions: [],
      latest_fbr_import: null,
      audit_report: null,
      ranking_report: null,
      error: null,
      local_falcon: {
        status: 'not_synced' as const,
        last_synced_at: null,
        last_error: null,
        missing_keywords: [],
        reports: [],
        approval: {
          id: 7,
          keyword_artifact_id: 41,
          cohort_sha256: 'a'.repeat(64),
          approved_at: '2026-09-02T09:00:00Z',
        },
        scan_batch: {
          id: 9,
          approval_id: 7,
          request_id: 'request-1',
          status: 'submitting' as const,
          scan_config_sha256: 'b'.repeat(64),
          total_count: 2,
          pending_count: 2,
          submitting_count: 0,
          submitted_count: 0,
          completed_count: 0,
          unknown_count: 0,
          failed_count: 0,
          needs_reconciliation: false,
        },
      },
    }

    expect(isAcceptedLocalFalconBatchReadback(state, expected)).toBe(true)
    expect(isAcceptedLocalFalconBatchReadback({
      ...state,
      local_falcon: {
        ...state.local_falcon,
        scan_batch: { ...state.local_falcon.scan_batch, status: 'unknown' as const },
      },
    }, expected)).toBe(false)
    expect(isAcceptedLocalFalconBatchReadback({
      ...state,
      local_falcon: {
        ...state.local_falcon,
        scan_batch: { ...state.local_falcon.scan_batch, scan_config_sha256: 'c'.repeat(64) },
      },
    }, expected)).toBe(false)
  })

  it('joins keyword reports with the same Unicode identity as the backend', () => {
    expect(keywordIdentity('Coffee  Near Me')).toBe(keywordIdentity('ＣＯＦＦＥＥ\u00a0near me'))
  })

  it('serializes a confirmed keyword version activation to the local API', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const activate = (api as Partial<typeof api>).activateSeoKeywordVersion

    expect(activate).toBeTypeOf('function')
    await activate!(3, { artifact_id: 99, expected_active_artifact_id: 41, confirmed: true })

    expect(fetchMock).toHaveBeenCalledWith('/api/merchants/3/seo-targets/activations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ artifact_id: 99, expected_active_artifact_id: 41, confirmed: true }),
    }))
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

  it('keeps the top bar focused on the operator without a redundant merchant scope', async () => {
    render(<App />)

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    const topBar = document.querySelector('.workspace-bar')
    expect(topBar).not.toBeNull()
    expect(within(topBar as HTMLElement).queryByText('当前工作范围')).toBeNull()
    expect(within(topBar as HTMLElement).queryByText('全部商户')).toBeNull()
    within(topBar as HTMLElement).getByRole('group', { name: '操作员账户' })
  })

  it('keeps the operator identity and logout action together on one account row', async () => {
    render(<App />)

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    const account = screen.getByRole('group', { name: '操作员账户' })
    within(account).getByText('当前操作员')
    const accountRow = within(account).getByRole('group', { name: '当前操作员操作' })
    within(accountRow).getByText('SEO Ops Team')
    within(accountRow).getByRole('button', { name: '退出' })
  })

  it('keeps the account action divider decorative', async () => {
    render(<App />)

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    const accountRow = screen.getByRole('group', { name: '当前操作员操作' })
    expect(accountRow.querySelector('[aria-hidden="true"]')).not.toBeNull()
    expect(within(accountRow).queryByRole('separator')).toBeNull()
  })

  it('keeps the full operator name available when a long identity is visually truncated', async () => {
    const username = 'north-america-local-search-operations@example.com'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me' ? { username, role: 'operator' } : [],
    })))
    render(<App />)

    await screen.findByRole('complementary', { name: 'SEO Ops 主导航' })
    expect(screen.getByText(username).getAttribute('title')).toBe(username)
  })

  it('gives the task workspace named filters for fast keyboard operation', async () => {
    render(<App />)

    await screen.findByRole('main', { name: '任务总览' })
    screen.getByRole('group', { name: '任务查询条件' })
    fireEvent.change(screen.getByRole('combobox', { name: '任务状态' }), { target: { value: 'EXECUTING' } })
    fireEvent.change(screen.getByRole('combobox', { name: '任务就绪状态' }), { target: { value: 'BLOCKED' } })
    fireEvent.change(screen.getByRole('combobox', { name: '任务阻塞原因' }), { target: { value: 'UPSTREAM_NOT_DONE' } })
    fireEvent.change(screen.getByRole('combobox', { name: '任务来源' }), { target: { value: 'AGENT' } })

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/tasks?status=EXECUTING&readiness=BLOCKED&blocker_code=UPSTREAM_NOT_DONE&source_kind=AGENT',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
  })

  it('does not show rows from the previous server query beneath newly selected filters', async () => {
    const filtered = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/tasks') return Promise.resolve(response([taskSummary({ title: 'Old unfiltered task' })]))
      if (input === '/api/tasks?status=DONE') return filtered.promise
      return Promise.resolve(response([]))
    }))
    render(<App />)

    await screen.findByRole('link', { name: '查看任务：Old unfiltered task' })
    fireEvent.change(screen.getByRole('combobox', { name: '任务状态' }), { target: { value: 'DONE' } })
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/tasks?status=DONE',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ))
    expect(screen.queryByRole('link', { name: '查看任务：Old unfiltered task' })).toBeNull()

    filtered.resolve(response([taskSummary({ id: 13, title: 'Completed filtered task', status: 'DONE' })]))
    await screen.findByRole('link', { name: '查看任务：Completed filtered task' })
  })

  it('opens formal tasks without offering direct completion or a batch status mutation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [taskSummary({
        id: 5,
        title: '生成本周 GBP Post',
        category: 'gbp',
        status: 'AWAITING_APPROVAL',
        execution_status: 'SUCCEEDED',
      })],
    }))
    render(<App />)

    await screen.findByRole('link', { name: '查看任务：生成本周 GBP Post' })
    within(screen.getByRole('table', { name: '跨商户任务列表' })).getByText('待内容审批')
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
    expect(screen.getByRole('textbox', { name: '商户名称' }).hasAttribute('required')).toBe(true)
    expect(screen.getByRole('textbox', { name: '主要地点' }).hasAttribute('required')).toBe(true)
    expect(screen.getByRole('textbox', { name: 'FBR Merchant ID' }).hasAttribute('required')).toBe(false)
    expect(screen.getByRole('textbox', { name: '官网' }).hasAttribute('required')).toBe(false)
    screen.getByRole('button', { name: '新建' })
    screen.getByRole('group', { name: '商户状态筛选' })
  })

  it('creates an unbound merchant, starts a basic diagnosis, and opens its workspace', async () => {
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
        website_url: null,
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
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    await screen.findByRole('heading', { name: 'Only Bear Chicken & Boba' })
    expect(calls.indexOf('POST /api/merchants')).toBeLessThan(calls.indexOf('POST /api/merchants/91/runs'))
    expect(calls.some(call => call.includes('/fbr-link') || call.includes('/gbp-sync'))).toBe(false)
    expect(calls).toContain('GET /api/merchants/91')
  })

  it('creates only one merchant when the form is submitted twice before React rerenders', async () => {
    window.history.pushState({}, '', '/')
    let createCalls = 0
    let resolveCreate!: (response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    const pendingCreate = new Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>(resolve => {
      resolveCreate = resolve
    })
    const merchant = {
      id: 95,
      name: 'Single Merchant',
      status: 'active',
      notes: null,
      primary_location: 'Queens, NY',
      website_url: null,
      auto_run_interval_days: null,
      created_at: '2026-09-03T00:00:00Z',
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'POST' && input === '/api/merchants') {
        createCalls += 1
        return pendingCreate
      }
      const data = method === 'POST' && input === '/api/merchants/95/runs'
        ? { id: 15, merchant_id: 95, status: 'running', trigger_kind: 'manual', plan_approved_at: null, error: null, created_at: '2026-09-03T00:00:01Z', finished_at: null }
        : input === '/api/merchants/95'
          ? merchant
          : []
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Single Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Queens, NY' } })
    const form = screen.getByRole('form', { name: '新建商户' })
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(createCalls).toBe(1)
    resolveCreate({ ok: true, status: 201, json: async () => merchant })
    await screen.findByRole('heading', { name: 'Single Merchant' })
  })

  it('binds and synchronizes FBR before starting the connected diagnosis', async () => {
    window.history.pushState({}, '', '/')
    const calls: string[] = []
    let fbrRequestBody = ''
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${input}`)
      const merchant = {
        id: 93,
        name: 'Connected Merchant',
        status: 'active',
        notes: null,
        primary_location: 'Brooklyn, NY',
        website_url: null,
        auto_run_interval_days: null,
        created_at: '2026-09-01T00:00:00Z',
      }
      let data: unknown = []
      if (method === 'POST' && input === '/api/merchants') data = merchant
      if (method === 'PUT' && input === '/api/merchants/93/fbr-link') {
        fbrRequestBody = String(init?.body ?? '')
        data = { merchant_id: 93, state: 'not_synced', fbr_merchant_id: 'fbr-93', sync_status: 'not_synced', last_synced_at: null, last_error: null, locations: [] }
      }
      if (method === 'POST' && input === '/api/merchants/93/gbp-sync') {
        data = { merchant_id: 93, state: 'synced', fbr_merchant_id: 'fbr-93', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null, locations: [{ gbp_location_id: 'locations/93' }] }
      }
      if (method === 'POST' && input === '/api/merchants/93/runs') {
        data = { id: 13, merchant_id: 93, status: 'running', trigger_kind: 'manual', plan_approved_at: null, error: null, created_at: '2026-09-03T00:00:01Z', finished_at: null }
      }
      if (input === '/api/merchants/93') data = merchant
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Connected Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Brooklyn, NY' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'FBR Merchant ID' }), { target: { value: '  fbr-93  ' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    await screen.findByRole('heading', { name: 'Connected Merchant' })
    expect(fbrRequestBody).toBe(JSON.stringify({ fbr_merchant_id: 'fbr-93' }))
    expect(calls.indexOf('PUT /api/merchants/93/fbr-link')).toBeLessThan(calls.indexOf('POST /api/merchants/93/gbp-sync'))
    expect(calls.indexOf('POST /api/merchants/93/gbp-sync')).toBeLessThan(calls.indexOf('POST /api/merchants/93/runs'))
  })

  it('keeps the created merchant and links to its profile when initial GBP sync fails', async () => {
    window.history.pushState({}, '', '/')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${input}`)
      const merchant = {
        id: 94,
        name: 'GBP Retry Merchant',
        status: 'active',
        notes: null,
        primary_location: 'Queens, NY',
        website_url: null,
        auto_run_interval_days: null,
        created_at: '2026-09-01T00:00:00Z',
      }
      const data = method === 'POST' && input === '/api/merchants'
        ? merchant
        : method === 'PUT' && input === '/api/merchants/94/fbr-link'
          ? { merchant_id: 94, state: 'not_synced', fbr_merchant_id: 'fbr-94', sync_status: 'not_synced', last_synced_at: null, last_error: null, locations: [] }
          : method === 'POST' && input === '/api/merchants/94/gbp-sync'
            ? { merchant_id: 94, state: 'failed', fbr_merchant_id: 'fbr-94', sync_status: 'failed', last_synced_at: null, last_error: 'FBR temporarily unavailable', locations: [] }
          : input === '/api/merchants/94/profile'
            ? { merchant_id: 94, state: 'failed', fbr_merchant_id: 'fbr-94', sync_status: 'failed', last_synced_at: null, last_error: 'FBR temporarily unavailable', locations: [] }
          : input === '/api/merchants/94/seo-targets'
            ? { merchant_id: 94, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
          : input === '/api/merchants/94'
            ? merchant
            : []
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'GBP Retry Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Queens, NY' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'FBR Merchant ID' }), { target: { value: 'fbr-94' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    await screen.findByRole('heading', { name: 'GBP Retry Merchant' })
    const notice = await screen.findByRole('alert')
    within(notice).getByText(/FBR\/GBP 初始化失败/)
    within(notice).getByText(/FBR temporarily unavailable/)
    const retryLink = within(notice).getByRole('link', { name: '前往商户资料重试' })
    expect(retryLink.getAttribute('href')).toBe('/merchants/94/profile')
    expect(calls).not.toContain('POST /api/merchants/94/runs')
    expect(screen.queryByRole('region', { name: '初始诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '开始诊断' })).toBeNull()

    fireEvent.click(retryLink)
    await screen.findByRole('main', { name: '商户资料' })
    screen.getByRole('button', { name: '同步 GBP 资料' })
  })

  it('does not start diagnosis when GBP sync reports synced without a readable location', async () => {
    window.history.pushState({}, '', '/')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${input}`)
      const merchant = { id: 98, name: 'Empty GBP Merchant', status: 'active', notes: null, primary_location: 'Queens, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-03T00:00:00Z' }
      const data = method === 'POST' && input === '/api/merchants'
        ? merchant
        : method === 'POST' && input === '/api/merchants/98/gbp-sync'
          ? { merchant_id: 98, state: 'synced', fbr_merchant_id: 'fbr-98', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null, locations: [] }
          : input === '/api/merchants/98/profile'
            ? { merchant_id: 98, state: 'synced', fbr_merchant_id: 'fbr-98', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null, locations: [] }
            : input === '/api/merchants/98' ? merchant : []
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Empty GBP Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Queens, NY' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'FBR Merchant ID' }), { target: { value: 'fbr-98' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    const notice = await screen.findByRole('alert')
    within(notice).getByRole('link', { name: '前往商户资料重试' })
    expect(calls).not.toContain('POST /api/merchants/98/runs')
  })

  it('turns the GBP sync required diagnosis detail into profile setup retry', async () => {
    window.history.pushState({}, '', '/')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const merchant = { id: 99, name: 'Stale GBP Merchant', status: 'active', notes: null, primary_location: 'Queens, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-03T00:00:00Z' }
      if (method === 'POST' && input === '/api/merchants/99/runs') {
        return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ detail: 'GBP 资料尚未完成当前同步，请先同步 GBP 后再开始诊断' }) }
      }
      const profile = { merchant_id: 99, state: 'synced', fbr_merchant_id: 'fbr-99', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null, locations: [{ gbp_location_id: 'locations/99' }] }
      const data = method === 'POST' && input === '/api/merchants' ? merchant : input.includes('/gbp-sync') ? profile : input.endsWith('/profile') ? profile : input.endsWith('/99') ? merchant : []
      return { ok: true, status: method === 'POST' ? 201 : 200, json: async () => data }
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: /新建商户/ }))
    fireEvent.change(screen.getByRole('textbox', { name: '商户名称' }), { target: { value: 'Stale GBP Merchant' } })
    fireEvent.change(screen.getByRole('textbox', { name: '主要地点' }), { target: { value: 'Queens, NY' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'FBR Merchant ID' }), { target: { value: 'fbr-99' } })
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    const notice = await screen.findByRole('alert')
    within(notice).getByText(/FBR\/GBP 初始化失败/)
    within(notice).getByText(/GBP 资料尚未完成当前同步/)
    within(notice).getByRole('link', { name: '前往商户资料重试' })
  })

  it('opens the persisted merchant when a 201 diagnosis response reports failed', async () => {
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
        return {
          ok: true,
          status: 201,
          json: async () => ({ id: 14, merchant_id: 92, status: 'failed', trigger_kind: 'manual', plan_approved_at: null, error: 'core-ai not configured', created_at: '2026-09-03T00:00:00Z', finished_at: '2026-09-03T00:00:00Z' }),
        }
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
    fireEvent.click(screen.getByRole('button', { name: '新建' }))

    await screen.findByRole('heading', { name: 'Fallback Merchant' })
    const notice = await screen.findByRole('status')
    within(notice).getByText(/商户已保存，但初始诊断未能启动。/)
    within(notice).getByText(/core-ai not configured/)
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

  it('refreshes the cached GBP profile every 30 seconds without starting an FBR sync', async () => {
    window.history.pushState({}, '', '/merchants/1/profile')
    let profileReads = 0
    let profileRefresh: (() => void) | null = null
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 30_000 && typeof handler === 'function') {
        profileRefresh = handler as () => void
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })
    const calls: Array<{ input: string; method: string }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const method = init?.method || 'GET'
      calls.push({ input, method })
      if (input.endsWith('/api/merchants/1/profile')) {
        profileReads += 1
        return {
          ok: true,
          status: 200,
          json: async () => ({
            merchant_id: 1,
            state: 'synced',
            fbr_merchant_id: 'fbr-only-bear',
            sync_status: 'synced',
            last_synced_at: profileReads === 1
              ? '2026-09-03T01:00:00Z'
              : '2026-09-03T02:00:00Z',
            last_error: null,
            locations: [],
          }),
        }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input.endsWith('/api/merchants/1/seo-targets')
          ? { merchant_id: 1, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
          : input.endsWith('/api/merchants/1')
            ? { id: 1, name: 'Only Bear', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
      }
    }))

    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    expect(profileReads).toBe(1)
    screen.getByText('最后同步 09-03 09:00')
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000)
    await act(async () => {
      profileRefresh?.()
      await Promise.resolve()
    })
    await waitFor(() => expect(profileReads).toBe(2))
    await screen.findByText('最后同步 09-03 10:00')
    expect(screen.queryByText('最后同步 09-03 09:00')).toBeNull()
    expect(calls.filter(call => call.input.endsWith('/gbp-sync'))).toEqual([])
    expect(calls.filter(call => call.input.endsWith('/api/merchants/1/profile')))
      .toEqual([
        { input: '/api/merchants/1/profile', method: 'GET' },
        { input: '/api/merchants/1/profile', method: 'GET' },
      ])
    intervalSpy.mockRestore()
  })

  it('does not let an older profile poll overwrite a completed manual sync', async () => {
    window.history.pushState({}, '', '/merchants/1/profile')
    let profileReads = 0
    let profileRefresh: (() => void) | null = null
    let resolveStalePoll: ((response: { ok: boolean; status: number; json: () => Promise<unknown> }) => void) | null = null
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation((handler, timeout) => {
      if (timeout === 30_000 && typeof handler === 'function') {
        profileRefresh = handler as () => void
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>
    })
    const profileAt = (lastSyncedAt: string) => ({
      merchant_id: 1,
      state: 'synced',
      fbr_merchant_id: 'fbr-only-bear',
      sync_status: 'synced',
      last_synced_at: lastSyncedAt,
      last_error: null,
      locations: [],
    })
    const response = (data: unknown) => ({
      ok: true,
      status: 200,
      json: async () => data,
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/merchants/1/gbp-sync') && init?.method === 'POST') {
        return response(profileAt('2026-09-03T03:00:00Z'))
      }
      if (input.endsWith('/api/merchants/1/profile')) {
        profileReads += 1
        if (profileReads === 1) return response(profileAt('2026-09-03T01:00:00Z'))
        return new Promise(resolve => { resolveStalePoll = resolve })
      }
      if (input.endsWith('/api/merchants/1/seo-targets')) {
        return response({ merchant_id: 1, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null })
      }
      if (input.endsWith('/api/merchants/1')) {
        return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      }
      return response([])
    }))

    render(<App />)
    await screen.findByText('最后同步 09-03 09:00')

    await act(async () => {
      profileRefresh?.()
      await Promise.resolve()
    })
    expect(profileReads).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '同步 GBP 资料' }))
    await screen.findByText('最后同步 09-03 11:00')

    await act(async () => {
      resolveStalePoll?.(response(profileAt('2026-09-03T02:00:00Z')))
      await Promise.resolve()
    })
    expect(screen.queryByText('最后同步 09-03 10:00')).toBeNull()
    screen.getByText('最后同步 09-03 11:00')
    intervalSpy.mockRestore()
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
              keywords: [
                {
                  keyword: 'only bear',
                  strategy: 'LOCAL',
                  intent: 'BRAND',
                  priority: 'P0',
                  score: 15,
                  score_rank: 2,
                  local_falcon_selected: true,
                  rationale: 'Brand-defense keyword retained even when its Skill score is lower.',
                  source_tags: ['FBR_KEYWORD_STORE'],
                  target_surface_types: ['GBP', 'WEBSITE'],
                  target_location: 'Mineola, NY',
                },
                {
                  keyword: 'fried chicken mineola ny',
                  strategy: 'LOCAL',
                  intent: 'LOCAL',
                  priority: 'UNSCORED',
                  score: 96.5,
                  score_rank: 1,
                  local_falcon_selected: true,
                  rationale: 'Connected category and location evidence.',
                  source_tags: ['FBR_KEYWORD_STORE'],
                  target_surface_types: ['GBP', 'WEBSITE'],
                  target_location: 'Mineola, NY',
                },
              ],
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
              keywords: [
                { keyword: 'only bear', local_rank: null, organic_rank: 1, source: 'LIVE_READ_ONLY', note: 'DataForSEO brand result.' },
                { keyword: 'fried chicken mineola ny', local_rank: 3, organic_rank: 8, source: 'LIVE_READ_ONLY', note: 'DataForSEO Local Pack.' },
              ],
              limitations: [],
            },
            capabilities: { can_regenerate: false, can_sync_local_falcon: true },
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
    screen.getByText('only bear')
    screen.getByText('待运营确认')
    const keywordTable = screen.getByRole('region', { name: '关键词与 Local Falcon 排名' })
    const keywordRows = within(keywordTable).getAllByRole('row').slice(1)
    expect(keywordRows).toHaveLength(2)
    within(keywordRows[0]).getByText('fried chicken mineola ny')
    within(keywordRows[1]).getByText('only bear')
    screen.getByRole('columnheader', { name: /Skill 评分/ })
    screen.getByRole('columnheader', { name: /DataForSEO Local Pack 排名/ })
    screen.getByRole('columnheader', { name: /DataForSEO 自然排名/ })
    const topKeywordCells = within(keywordRows[0]).getAllByRole('cell')
    expect(topKeywordCells[1].textContent).toContain('96.5')
    expect(topKeywordCells[6].textContent).toBe('#3')
    expect(topKeywordCells[7].textContent).toBe('#8')
    screen.getByText('评分排名 #1')
    expect(screen.getAllByText('Local Falcon Top 20')).toHaveLength(2)
    screen.getByText('FBR 已落库 · 2 个关键词 · Top 2')
    screen.getByText('共 2 个关键词 · P0 1 · 未评分 1 · 在此窗口内滚动查看')
    screen.getByRole('button', { name: '从 FBR 重新读取' })
    screen.getByRole('button', { name: '只同步已有报告' })
    expect(screen.getAllByText('排名来源：DataForSEO')).toHaveLength(2)
    expect((screen.getByRole('button', { name: '重新生成关键词并评分' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByText('尚未接入')).toBeNull()
    expect(screen.queryByText('UAT 接口未部署')).toBeNull()
    screen.getByText('同步于 09-02 11:00')
  })

  it('shows an accessible workflow status as soon as keyword generation starts', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const seoState = (cycleStatus: 'ready' | 'running', activeStage: string | null) => ({
      merchant_id: 3,
      cycle_id: 'cycle-running',
      cycle_status: cycleStatus,
      active_stage: activeStage,
      keyword_set_artifact_id: 41,
      local_falcon_cohort_sha256: 'a'.repeat(64),
      keyword_set: {
        schema_version: 'seo_ops.keyword_set.v2',
        merchant_id: '3',
        market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Upper West Side, New York, NY' },
        generation_method: 'EVIDENCE_BOUNDED_RESEARCH',
        title: 'Previous UWS keyword set',
        summary: 'The last accepted result remains visible while the next run executes.',
        keywords: [{
          keyword: 'breakfast upper west side',
          strategy: 'LOCAL',
          intent: 'LOCAL',
          priority: 'P0',
          score: 95,
          score_rank: 1,
          local_falcon_selected: true,
          rationale: 'Existing accepted target.',
          source_tags: ['KEYWORD_SKILL'],
          target_surface_types: ['GBP'],
          target_location: 'Upper West Side',
        }],
        evidence_gaps: [],
      },
      audit_report: null,
      ranking_report: null,
      local_falcon: {
        current_place_id: 'place-uws',
        status: 'not_synced',
        reports: [],
        scan_batch: null,
      },
      capabilities: {
        can_regenerate: true,
        can_sync_local_falcon: true,
        can_approve_local_falcon: true,
        can_generate_local_falcon: true,
      },
      error: null,
    })
    let regenerateAccepted = false
    let finishRegenerate: () => void = () => undefined
    const pendingRegenerate = new Promise<{
      ok: boolean
      status: number
      json: () => Promise<ReturnType<typeof seoState>>
    }>(resolve => {
      finishRegenerate = () => {
        regenerateAccepted = true
        resolve({
          ok: true,
          status: 202,
          json: async () => seoState('running', 'KEYWORD_SET'),
        })
      }
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.endsWith('/api/merchants/3/seo-targets/regenerate') && init?.method === 'POST') return pendingRegenerate
      return {
        ok: true,
        status: 200,
        json: async () => input.endsWith('/api/merchants/3/seo-targets')
          ? regenerateAccepted ? seoState('running', 'KEYWORD_SET') : seoState('ready', null)
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
                  place_id: 'place-uws',
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
      }
    }))

    render(<App />)

    const heading = await screen.findByRole('heading', { name: 'SEO 目标关键词与排名' })
    const regenerate = screen.getByRole('button', { name: '重新生成关键词并评分' })
    expect((regenerate as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(regenerate)

    const status = screen.getByRole('status', { name: '关键词生成状态' })
    within(status).getByText('正在生成并评分关键词')
    within(status).getByText('Seed → Ranking · 当前结果保留')
    expect(heading.closest('section')?.getAttribute('aria-busy')).toBeNull()
    expect(screen.getByRole('region', { name: '关键词与 Local Falcon 排名' }).getAttribute('aria-busy')).toBe('true')
    expect(status.querySelector('.seo-running-spinner')).not.toBeNull()
    expect(status.querySelector('.seo-running-progress')).not.toBeNull()
    for (const name of ['重新生成关键词并评分', '审批并生成 Top 20 报告', '读取中…', '只同步已有报告']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }

    await act(async () => finishRegenerate())
    expect(screen.getByRole('status', { name: '关键词生成状态' })).toBe(status)
  })

  it('keeps Local Falcon rankings in one fixed table and confirms credit spend before generating Top 20 reports', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const cohortSha256 = 'a'.repeat(64)
    const seoState = {
      merchant_id: 3,
      cycle_id: 'cycle-lf',
      cycle_status: 'ready',
      active_stage: null,
      keyword_set_artifact_id: 41,
      local_falcon_cohort_sha256: cohortSha256,
      keyword_set: {
        schema_version: 'seo_ops.keyword_set.v2',
        merchant_id: '3',
        market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Upper West Side, New York, NY' },
        generation_method: 'EVIDENCE_BOUNDED_RESEARCH',
        title: 'UWS keyword set',
        summary: 'Accepted targets.',
        keywords: [
          { keyword: 'breakfast upper west side', strategy: 'LOCAL', intent: 'LOCAL', priority: 'UNSCORED', score: 95, score_rank: 1, local_falcon_selected: true, rationale: 'Local target.', source_tags: ['GBP'], target_surface_types: ['GBP'], target_location: 'Upper West Side' },
          { keyword: 'coffee near lincoln center', strategy: 'LOCAL', intent: 'LOCAL', priority: 'UNSCORED', score: 88, score_rank: 2, local_falcon_selected: true, rationale: 'Local target.', source_tags: ['GBP'], target_surface_types: ['GBP'], target_location: 'Upper West Side' },
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
        current_place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
        status: 'synced',
        last_synced_at: '2026-09-02T08:30:00Z',
        last_error: null,
        missing_keywords: ['coffee near lincoln center'],
        scan_defaults: {
          place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
          lat: 40.1,
          lng: -73.1,
          grid_size: 3,
          radius: 0.5,
          measurement: 'km',
          platform: 'google',
        },
        scan_defaults_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        approval: null,
        scan_batch: null,
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
      capabilities: {
        can_regenerate: true,
        can_sync_local_falcon: true,
        can_approve_local_falcon: true,
        can_generate_local_falcon: true,
      },
      error: null,
    }
    let scanAttempts = 0
    const approvedLocalFalcon = {
      id: 7,
      keyword_artifact_id: 41,
      cohort_sha256: cohortSha256,
      approved_at: '2026-09-02T09:00:00Z',
    }
    const submittingScanBatch = {
      id: 9,
      approval_id: 7,
      request_id: 'frozen-safe-request-id',
      status: 'submitting',
      scan_config_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      total_count: 2,
      pending_count: 2,
      submitting_count: 0,
      submitted_count: 0,
      completed_count: 0,
      unknown_count: 0,
      failed_count: 0,
      needs_reconciliation: false,
    }
    const unknownScanBatch = {
      ...submittingScanBatch,
      status: 'unknown',
      pending_count: 0,
      unknown_count: 2,
      needs_reconciliation: true,
    }
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const isScanBatch = input.endsWith('/api/merchants/3/local-falcon-scan-batches') && init?.method === 'POST'
      const simulateLostResponse = isScanBatch && scanAttempts++ === 0
      return {
      ok: !simulateLostResponse,
      status: simulateLostResponse ? 502 : input.endsWith('/local-falcon-approvals') ? 201 : input.endsWith('/local-falcon-scan-batches') ? 202 : 200,
      json: async () => simulateLostResponse
        ? { detail: 'Local Falcon gateway response was lost' }
        : input.endsWith('/api/merchants/3/seo-targets')
        ? scanAttempts >= 2
          ? { ...seoState, local_falcon: { ...seoState.local_falcon, approval: approvedLocalFalcon, scan_batch: unknownScanBatch } }
          : seoState
        : input.endsWith('/api/merchants/3/local-falcon-approvals') && init?.method === 'POST'
          ? { ...seoState, local_falcon: { ...seoState.local_falcon, approval: approvedLocalFalcon } }
          : input.endsWith('/api/merchants/3/local-falcon-scan-batches') && init?.method === 'POST'
            ? { ...seoState, local_falcon: { ...seoState.local_falcon, approval: approvedLocalFalcon, scan_batch: submittingScanBatch } }
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
                place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
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
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    window.sessionStorage.setItem('seo-ops.local-falcon-confirmation.3', JSON.stringify({
      requestId: 'frozen-safe-request-id',
      scanConfigSha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      keywordArtifactId: 41,
      cohortSha256,
      placeId: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
      locationTitle: 'FORGED STORE',
      keywords: [{ keyword: 'forged paid keyword', score: 999, scoreRank: 1 }],
      scanDefaults: { gridSize: 99, radius: 999, measurement: 'km' },
    }))

    render(<App />)

    await screen.findByRole('heading', { name: 'SEO 目标关键词与排名' })
    screen.getByRole('button', { name: '重新生成关键词并评分' })
    screen.getByRole('button', { name: '审批并生成 Top 20 报告' })
    screen.getByRole('button', { name: '从 FBR 重新读取' })
    screen.getByRole('button', { name: '只同步已有报告' })
    screen.getByText('评分 95')
    screen.getByText('评分排名 #1')
    const heatmapHeader = screen.getByRole('columnheader', { name: /热力图/ })
    const legend = within(heatmapHeader).getByRole('group', { name: '热力图图例' })
    for (const label of ['1–3', '4–5', '6–10', '11+', '未发现']) within(legend).getByText(label)
    const tableViewport = screen.getByRole('region', { name: '关键词与 Local Falcon 排名' })
    const heatmap = within(tableViewport).getByRole('grid', { name: 'breakfast upper west side Local Falcon 热力图' })
    const points = within(heatmap).getAllByRole('gridcell')
    expect(points).toHaveLength(9)
    expect(points[0].getAttribute('tabindex')).toBe('0')
    expect(points[1].getAttribute('tabindex')).toBe('-1')
    points[0].focus()
    fireEvent.keyDown(points[0], { key: 'ArrowRight' })
    expect(document.activeElement).toBe(points[1])
    expect(points[1].getAttribute('aria-label')).toContain('第 1 名')
    screen.getByText('3 × 3 grid')
    screen.getByText('0.5 km radius')
    expect(screen.getAllByText('1.38')).toHaveLength(2)
    screen.getByText('93.83')
    screen.getByText('coffee near lincoln center')
    expect(screen.queryByRole('button', { name: /查看 .* Local Falcon 报告/ })).toBeNull()
    expect(screen.queryByRole('dialog', { name: 'breakfast upper west side Local Falcon 报告' })).toBeNull()
    expect(screen.queryByRole('button', { name: /查看全部 .* 个关键词/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '审批并生成 Top 20 报告' }))
    const confirmation = screen.getByRole('dialog', { name: '确认生成 Local Falcon 报告' })
    within(confirmation).getByText('此操作将消耗 Local Falcon credits')
    within(confirmation).getByText('breakfast upper west side')
    within(confirmation).getByText('coffee near lincoln center')
    expect(within(confirmation).queryByText('forged paid keyword')).toBeNull()
    expect(within(confirmation).queryByText('FORGED STORE')).toBeNull()
    within(confirmation).getByText('Choice Brooklyn - Upper West Side')
    within(confirmation).getByText('2040 Broadway, New York, NY 10023, US')
    within(confirmation).getByText('ChIJH8iZh-5ZwokRPLzzADeSnYE')
    within(confirmation).getByText('40.100000, -73.100000')
    within(confirmation).getByText('3 × 3')
    within(confirmation).getByText('0.5 km')
    within(confirmation).getByText('km')
    within(confirmation).getByText('2 个')
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认并生成 2 个报告' }))

    await within(confirmation).findByText('Local Falcon gateway response was lost')
    expect(screen.getByRole('dialog', { name: '确认生成 Local Falcon 报告' })).toBe(confirmation)
    fireEvent.click(within(confirmation).getByRole('button', { name: '关闭生成确认' }))
    expect(screen.queryByRole('dialog', { name: '确认生成 Local Falcon 报告' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '审批并生成 Top 20 报告' }))
    const retriedConfirmation = screen.getByRole('dialog', { name: '确认生成 Local Falcon 报告' })
    fireEvent.click(within(retriedConfirmation).getByRole('button', { name: '确认并生成 2 个报告' }))

    await waitFor(() => {
      const approvalCall = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith('/local-falcon-approvals') && init?.method === 'POST')
      const batchCalls = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/local-falcon-scan-batches') && init?.method === 'POST')
      expect(JSON.parse(String(approvalCall?.[1]?.body))).toEqual({ keyword_artifact_id: 41, expected_cohort_sha256: cohortSha256 })
      expect(batchCalls).toHaveLength(2)
      const firstBatch = JSON.parse(String(batchCalls[0]?.[1]?.body))
      const retriedBatch = JSON.parse(String(batchCalls[1]?.[1]?.body))
      expect(firstBatch).toMatchObject({
        approval_id: 7,
        request_id: 'frozen-safe-request-id',
        confirm_credit_spend: true,
        expected_scan_config_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      })
      expect(retriedBatch.request_id).toBe(firstBatch.request_id)
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '确认生成 Local Falcon 报告' })).toBeNull())
    expect((screen.getByRole('button', { name: '审批并生成 Top 20 报告' }) as HTMLButtonElement).disabled).toBe(true)
    const batchStatus = screen.getByRole('alert', { name: 'Local Falcon 批次状态' })
    within(batchStatus).getByText('本批次需人工对账')
    within(batchStatus).getByText('未知 2')
    within(batchStatus).getByText('排队 0')
    within(batchStatus).getByText('派发中 0')
    within(batchStatus).getByText('已受理 0')
    within(batchStatus).getByText('已完成 0')
    within(batchStatus).getByText('失败 0')
    within(batchStatus).getByText('为避免重复扣 credits，不能自动重试或更换 request ID。')
    fireEvent.click(within(batchStatus).getByRole('button', { name: '人工对账' }))
    const reconciliation = screen.getByRole('dialog', { name: 'Local Falcon 人工对账' })
    within(reconciliation).getByText('当前报告缺少可验证的提交关联，暂不能安全绑定。')
    within(reconciliation).getByText(/不允许手工绑定或重新扣费扫描/)
    expect(within(reconciliation).queryByRole('button', { name: '绑定已受理报告' })).toBeNull()
  })

  it('polls a queued Local Falcon batch with GET until it needs reconciliation without submitting again', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const submittingBatch = {
      id: 9,
      approval_id: 7,
      request_id: 'existing-request-id',
      status: 'submitting',
      total_count: 2,
      pending_count: 1,
      submitting_count: 1,
      submitted_count: 0,
      completed_count: 0,
      unknown_count: 0,
      failed_count: 0,
      needs_reconciliation: false,
    }
    const unknownBatch = {
      ...submittingBatch,
      status: 'unknown',
      pending_count: 1,
      submitting_count: 0,
      unknown_count: 1,
      needs_reconciliation: true,
      can_confirm_not_submitted: true,
      can_bind_acknowledged_report: true,
      items: [
        { keyword: 'breakfast upper west side', status: 'unknown', error: 'gateway response lost', updated_at: '2026-09-02T09:01:00Z' },
        { keyword: 'coffee near lincoln center', status: 'pending', error: null, updated_at: '2026-09-02T09:01:00Z' },
      ],
    }
    const partiallyReconciledBatch = {
      ...unknownBatch,
      status: 'partial',
      completed_count: 1,
      unknown_count: 0,
      needs_reconciliation: true,
      can_confirm_not_submitted: false,
      items: [
        { ...unknownBatch.items[0], status: 'completed', error: null },
        unknownBatch.items[1],
      ],
    }
    const closedBatch = {
      ...partiallyReconciledBatch,
      status: 'failed',
      pending_count: 0,
      failed_count: 1,
      needs_reconciliation: false,
      items: [
        partiallyReconciledBatch.items[0],
        { ...partiallyReconciledBatch.items[1], status: 'failed', error: 'closed without retry' },
      ],
    }
    const seoState = (scanBatch: typeof submittingBatch | typeof unknownBatch) => ({
      merchant_id: 3,
      cycle_status: 'ready',
      active_stage: null,
      keyword_set_artifact_id: null,
      local_falcon_cohort_sha256: null,
      keyword_set: null,
      audit_report: null,
      ranking_report: null,
      local_falcon: {
        current_place_id: 'place-uws',
        status: 'not_synced',
        last_synced_at: null,
        last_error: null,
        missing_keywords: [],
        reports: [],
        scan_defaults: null,
        scan_defaults_sha256: null,
        approval: null,
        scan_batch: scanBatch,
      },
      capabilities: {
        can_regenerate: false,
        can_sync_local_falcon: false,
        can_approve_local_falcon: false,
        can_generate_local_falcon: false,
      },
      error: null,
    })
    let seoReads = 0
    let reconciliationAttempts = 0
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const isReconciliation = input.endsWith('/api/merchants/3/local-falcon-scan-batches/9/reconcile') && init?.method === 'POST'
      const simulateReconciliationFailure = isReconciliation && reconciliationAttempts++ === 0
      return {
      ok: !simulateReconciliationFailure,
      status: simulateReconciliationFailure ? 409 : 200,
      json: async () => simulateReconciliationFailure
        ? { detail: '报告与冻结扫描参数不匹配，未写入对账结果。' }
        : isReconciliation
          ? seoState(JSON.parse(String(init?.body)).action === 'CLOSE_WITHOUT_RETRY' ? closedBatch : partiallyReconciledBatch)
        : input.endsWith('/api/merchants/3/seo-targets')
        ? seoState(seoReads++ === 0 ? submittingBatch : unknownBatch)
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
                place_id: 'place-uws',
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
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const batchStatus = await screen.findByRole('alert', { name: 'Local Falcon 批次状态' })
    within(batchStatus).getByText('本批次需人工对账')
    within(batchStatus).getByText('排队 1')
    within(batchStatus).getByText('未知 1')
    fireEvent.click(within(batchStatus).getByRole('button', { name: '人工对账' }))
    const reconciliation = screen.getByRole('dialog', { name: 'Local Falcon 人工对账' })
    within(reconciliation).getByText(/不会自动重试/)
    expect((within(reconciliation).getByRole('button', { name: '绑定已受理报告' }) as HTMLButtonElement).disabled).toBe(true)
    within(reconciliation).getByRole('button', { name: '确认未提交并关闭批次' })
    fireEvent.change(within(reconciliation).getByRole('combobox', { name: '未知关键词' }), { target: { value: 'breakfast upper west side' } })
    fireEvent.change(within(reconciliation).getByRole('textbox', { name: 'Local Falcon report key' }), { target: { value: '8aa3c7e1f6c599b' } })
    fireEvent.change(within(reconciliation).getByRole('textbox', { name: '对账原因' }), { target: { value: '已在 Local Falcon 后台确认该报告已受理。' } })
    fireEvent.click(within(reconciliation).getByRole('button', { name: '绑定已受理报告' }))

    await within(reconciliation).findByRole('alert')
    within(reconciliation).getByText('报告与冻结扫描参数不匹配，未写入对账结果。')
    expect(screen.getByRole('dialog', { name: 'Local Falcon 人工对账' })).toBe(reconciliation)
    fireEvent.click(within(reconciliation).getByRole('button', { name: '绑定已受理报告' }))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(([url, init]) => (
        String(url).endsWith('/local-falcon-scan-batches/9/reconcile')
        && (init as RequestInit | undefined)?.method === 'POST'
      ))
      expect(calls).toHaveLength(2)
      expect(JSON.parse(String((calls[1]?.[1] as RequestInit | undefined)?.body))).toEqual({
        action: 'BIND_ACKNOWLEDGED_REPORT',
        keyword: 'breakfast upper west side',
        report_key: '8aa3c7e1f6c599b',
        reason: '已在 Local Falcon 后台确认该报告已受理。',
      })
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Local Falcon 人工对账' })).toBeNull())
    const partialStatus = screen.getByRole('alert', { name: 'Local Falcon 批次状态' })
    within(partialStatus).getByText('已完成 1')
    within(partialStatus).getByText('未知 0')
    fireEvent.click(within(partialStatus).getByRole('button', { name: '人工对账' }))
    const closeReconciliation = screen.getByRole('dialog', { name: 'Local Falcon 人工对账' })
    expect(within(closeReconciliation).queryByRole('button', { name: '绑定已受理报告' })).toBeNull()
    fireEvent.change(within(closeReconciliation).getByRole('textbox', { name: '对账原因' }), { target: { value: '已核实所有未知报告，剩余关键词本轮不再执行。' } })
    fireEvent.click(within(closeReconciliation).getByRole('button', { name: '关闭剩余未执行项' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Local Falcon 人工对账' })).toBeNull())
    const terminalStatus = screen.getByRole('status', { name: 'Local Falcon 批次状态' })
    within(terminalStatus).getByText('本批次处理失败')
    const reconciliationCalls = fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/local-falcon-scan-batches/9/reconcile')
      && (init as RequestInit | undefined)?.method === 'POST'
    ))
    expect(reconciliationCalls).toHaveLength(3)
    expect(JSON.parse(String((reconciliationCalls[2]?.[1] as RequestInit | undefined)?.body))).toEqual({
      action: 'CLOSE_WITHOUT_RETRY',
      reason: '已核实所有未知报告，剩余关键词本轮不再执行。',
    })
    expect(seoReads).toBeGreaterThanOrEqual(2)
    expect(fetchMock.mock.calls.filter(([url, init]) => (
      String(url).endsWith('/local-falcon-scan-batches') && (init as RequestInit | undefined)?.method === 'POST'
    ))).toHaveLength(0)
  })

  it('defaults a multi-location profile to the bound GBP record and blocks paid SEO actions after switching locations', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets')
        ? {
            merchant_id: 3,
            cycle_status: 'ready',
            active_stage: null,
            keyword_set_artifact_id: 41,
            local_falcon_cohort_sha256: 'a'.repeat(64),
            keyword_set: {
              generation_method: 'PERSISTED_FBR_READBACK',
              keywords: [{ keyword: 'breakfast upper west side', strategy: 'LOCAL', intent: 'LOCAL', priority: 'P0', score: 95, score_rank: 1, local_falcon_selected: true, rationale: 'Top target.', source_tags: ['FBR_KEYWORD_STORE'], target_surface_types: ['GBP'], target_location: 'Upper West Side' }],
            },
            audit_report: null,
            ranking_report: null,
            local_falcon: {
              current_place_id: 'place-uws',
              scan_defaults: { place_id: 'place-uws', lat: 40.77, lng: -73.98, grid_size: 9, radius: 0.5, measurement: 'km', platform: 'google' },
              scan_defaults_sha256: 'b'.repeat(64),
              reports: [],
            },
            capabilities: { can_regenerate: true, can_sync_local_falcon: true, can_approve_local_falcon: true, can_generate_local_falcon: true, blockers: {} },
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
            locations: [
              {
                gbp_location_id: 'locations/clinton',
                place_id: 'place-clinton',
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
                place_id: 'place-uws',
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
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await screen.findByRole('main', { name: '商户资料' })
    const locationSelect = screen.getByRole('combobox', { name: 'GBP 门店' }) as HTMLSelectElement
    expect(locationSelect.value).toBe('locations/uws')
    screen.getByRole('heading', { name: 'Choice Brooklyn - Upper West Side', level: 2 })
    expect((screen.getByRole('button', { name: '审批并生成 Top 20 报告' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(locationSelect, { target: { value: 'locations/clinton' } })

    screen.getByRole('heading', { name: 'Choice Brooklyn - Clinton Hill', level: 2 })
    screen.getByText('当前 SEO 工作区未绑定到所选 GBP 门店。为避免对错误的 Place ID 发起付费扫描，关键词与 Local Falcon 操作已暂停。')
    for (const name of ['重新生成关键词并评分', '审批并生成 Top 20 报告', '从 FBR 重新读取', '只同步已有报告']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input).includes('local-falcon') && (init as RequestInit | undefined)?.method === 'POST',
    )).toHaveLength(0)
  })

  it('does not refresh FBR keywords during page load or local polling', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
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
                  place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
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

    await screen.findByRole('heading', { name: 'SEO 目标关键词与排名' })
    screen.getByRole('button', { name: '从 FBR 重新读取' })
    expect(fetchMock.mock.calls.filter(([input, init]) =>
      String(input).endsWith('/api/merchants/3/seo-targets/refresh') && (init as RequestInit | undefined)?.method === 'POST',
    )).toHaveLength(0)
  })

  it('polls running SEO state with GET and never refreshes FBR keywords', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const seoState = {
      merchant_id: 3,
      cycle_status: 'running',
      active_stage: 'KEYWORD_SET',
      keyword_set: null,
      audit_report: null,
      ranking_report: null,
      error: null,
    }
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets')
        ? seoState
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
                place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
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
    const seoReads = () => fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === '/api/merchants/3/seo-targets' && !(init as RequestInit | undefined)?.method,
    ).length
    const refreshPosts = () => fetchMock.mock.calls.filter(([input, init]) =>
      String(input) === '/api/merchants/3/seo-targets/refresh' && (init as RequestInit | undefined)?.method === 'POST',
    ).length

    vi.useFakeTimers()
    try {
      render(<App />)
      await act(async () => {
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      screen.getByRole('heading', { name: 'SEO 目标关键词与排名' })
      expect(seoReads()).toBeGreaterThanOrEqual(2)
      const readsBeforeInterval = seoReads()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000)
      })
      expect(seoReads()).toBeGreaterThan(readsBeforeInterval)
      expect(refreshPosts()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps active Skill keywords after the operator reads an FBR candidate', async () => {
    window.history.pushState({}, '', '/merchants/3/profile')
    const activeSkillState = {
      merchant_id: 3,
      cycle_status: 'ready',
      active_stage: null,
      keyword_set_artifact_id: 41,
      active_keyword_artifact_id: 41,
      active_keyword_source: 'SKILL',
      active_keyword_activated_at: '2026-09-03T00:00:00Z',
      keyword_versions: [{ artifact_id: 41, place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE', source: 'SKILL', activation_eligible: true, generation_method: 'UPSTREAM_DETERMINISTIC_ADAPTER', keyword_count: 1, local_keyword_count: 1, organic_keyword_count: 0, scored_keyword_count: 1, score_status: 'VERIFIED_SKILL', completed_at: '2026-09-03T00:00:00Z', is_active: true }],
      latest_fbr_import: null,
      local_falcon_cohort_sha256: 'a'.repeat(64),
      keyword_set: {
        schema_version: 'seo_ops.keyword_set.v2',
        merchant_id: '3',
        market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Upper West Side' },
        generation_method: 'UPSTREAM_DETERMINISTIC_ADAPTER',
        title: 'Active Skill keywords',
        summary: 'The activated Skill result.',
        keywords: [{ keyword: 'active skill keyword', strategy: 'LOCAL', intent: 'LOCAL', priority: 'P0', score: 95, score_rank: 1, local_falcon_selected: true, rationale: 'Active.', source_tags: ['SKILL'], target_surface_types: ['GBP'], target_location: 'Upper West Side' }],
        evidence_gaps: [],
      },
      audit_report: null,
      ranking_report: null,
      local_falcon: {
        current_place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE',
        status: 'not_synced',
        last_synced_at: null,
        last_error: null,
        missing_keywords: [],
        reports: [],
        scan_defaults: { place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE', lat: 40.77, lng: -73.98, grid_size: 3, radius: 0.5, measurement: 'km', platform: 'google' },
        scan_defaults_sha256: 'b'.repeat(64),
      },
      capabilities: { can_regenerate: true, can_sync_local_falcon: false, can_approve_local_falcon: true, can_generate_local_falcon: true },
      error: null,
    }
    const fbrCandidateReadback = {
      ...activeSkillState,
      latest_fbr_import: {
        artifact_id: 99,
        imported_at: '2026-09-03T00:01:00Z',
        is_active: false,
        comparison: {
          active_local_count: 1,
          fbr_local_count: 1,
          added_count: 1,
          removed_count: 1,
          priority_changed_count: 0,
          target_surfaces_changed_count: 0,
          added_keywords: ['candidate FBR keyword'],
          removed_keywords: ['active skill keyword'],
          changed_keywords: [],
        },
      },
    }
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => ({
      ok: true,
      status: input.endsWith('/seo-targets/refresh') || input.endsWith('/local-falcon-scan-batches') ? 202 : input.endsWith('/local-falcon-approvals') ? 201 : 200,
      json: async () => input.endsWith('/api/merchants/3/seo-targets/refresh') && init?.method === 'POST'
        ? fbrCandidateReadback
        : input.endsWith('/api/merchants/3/local-falcon-approvals') && init?.method === 'POST'
          ? { ...fbrCandidateReadback, local_falcon: { ...fbrCandidateReadback.local_falcon, approval: { id: 7, keyword_artifact_id: 41, cohort_sha256: 'a'.repeat(64), approved_at: '2026-09-03T00:01:01Z' } } }
          : input.endsWith('/api/merchants/3/local-falcon-scan-batches') && init?.method === 'POST'
            ? { ...fbrCandidateReadback, local_falcon: { ...fbrCandidateReadback.local_falcon, approval: { id: 7, keyword_artifact_id: 41, cohort_sha256: 'a'.repeat(64), approved_at: '2026-09-03T00:01:01Z' }, scan_batch: { id: 8, approval_id: 7, status: 'submitting', total_count: 1, pending_count: 1, submitting_count: 0, submitted_count: 0, completed_count: 0, unknown_count: 0, failed_count: 0, needs_reconciliation: false } } }
        : input.endsWith('/api/merchants/3/seo-targets')
          ? activeSkillState
          : input.endsWith('/api/merchants/3/profile')
            ? {
                merchant_id: 3,
                state: 'synced',
                fbr_merchant_id: 'fbr-choice',
                sync_status: 'synced',
                last_synced_at: '2026-09-02T03:00:00Z',
                last_error: null,
                locations: [{ gbp_location_id: 'locations/uws', place_id: 'ChIJH8iZh-5ZwokRPLzzADeSnYE', title: 'Choice Brooklyn - Upper West Side', address: '2040 Broadway, New York, NY 10023, US', additional_phones: [], address_lines: [], additional_categories: [], regular_hours: [], menu_sections: [], menu_items: [], recent_posts: [], recent_reviews: [], performance_metrics: [], search_keywords: [], synced_at: '2026-09-02T03:00:00Z' }],
              }
            : input.endsWith('/api/merchants/3')
              ? { id: 3, name: 'Choice Brooklyn - Upper West Side', primary_location: '2040 Broadway, New York, NY 10023', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
              : [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('active skill keyword')
    fireEvent.click(screen.getByRole('button', { name: '从 FBR 重新读取' }))
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([input, init]) =>
        String(input).endsWith('/api/merchants/3/seo-targets/refresh') && (init as RequestInit | undefined)?.method === 'POST',
      )).toHaveLength(1)
    })
    screen.getByText('active skill keyword')
    expect(screen.queryByText('candidate FBR keyword')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '审批并生成 Top 20 报告' }))
    const confirmation = screen.getByRole('dialog', { name: '确认生成 Local Falcon 报告' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '确认并生成 1 个报告' }))
    await waitFor(() => {
      const approvalCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).endsWith('/api/merchants/3/local-falcon-approvals') && (init as RequestInit | undefined)?.method === 'POST',
      )
      expect(JSON.parse(String(approvalCall?.[1]?.body))).toEqual({
        keyword_artifact_id: 41,
        expected_cohort_sha256: 'a'.repeat(64),
      })
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
      json: async () => input.endsWith('/api/merchants/1/profile')
        ? { merchant_id: 1, state: 'unbound', fbr_merchant_id: null, sync_status: null, last_synced_at: null, last_error: null, locations: [] }
        : input.endsWith('/api/merchants/1')
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
    expect(screen.queryByRole('link', { name: '前往商户资料重试' })).toBeNull()
  })

  it.each(['failed', 'not_synced'] as const)('blocks diagnosis after refresh when the bound FBR profile is %s', async profileState => {
    window.history.pushState({}, '', '/merchants/96')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/96/profile')
        ? {
            merchant_id: 96,
            state: profileState,
            fbr_merchant_id: 'fbr-96',
            sync_status: profileState,
            last_synced_at: null,
            last_error: profileState === 'failed' ? 'FBR unavailable' : null,
            locations: [],
          }
        : input.endsWith('/api/merchants/96')
          ? { id: 96, name: 'Bound Merchant', status: 'active', notes: null, primary_location: 'Queens, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-03T00:00:00Z' }
          : [],
    })))
    render(<App />)

    await screen.findByRole('heading', { name: 'Bound Merchant' })
    const notice = await screen.findByRole('alert')
    within(notice).getByText(/GBP 尚未同步完成/)
    expect(within(notice).getByRole('link', { name: '前往商户资料重试' }).getAttribute('href')).toBe('/merchants/96/profile')
    expect(screen.queryByRole('region', { name: '初始诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '开始诊断' })).toBeNull()
  })

  it('blocks every diagnosis entry after refresh when a synced bound profile has no locations', async () => {
    window.history.pushState({}, '', '/merchants/100')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input.endsWith('/api/merchants/100/profile')
        ? { merchant_id: 100, state: 'synced', fbr_merchant_id: 'fbr-100', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null, locations: [] }
        : input.endsWith('/api/merchants/100/runs')
          ? [{ id: 100, merchant_id: 100, status: 'succeeded', trigger_kind: 'manual', plan_approved_at: '2026-09-03T00:00:00Z', error: null, created_at: '2026-09-03T00:00:00Z', finished_at: '2026-09-03T00:01:00Z' }]
          : input.endsWith('/api/merchants/100')
            ? { id: 100, name: 'No Location Merchant', status: 'active', notes: null, primary_location: 'Queens, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-03T00:00:00Z' }
            : [],
    })))
    render(<App />)

    await screen.findByRole('heading', { name: 'No Location Merchant' })
    within(await screen.findByRole('alert')).getByRole('link', { name: '前往商户资料重试' })
    expect(screen.queryByRole('region', { name: '初始诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull()
  })

  it('shows an explicit profile-status error without misclassifying the merchant as bound or blocking basic diagnosis', async () => {
    window.history.pushState({}, '', '/merchants/97')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input.endsWith('/api/merchants/97/profile')) {
        return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ detail: 'profile status unavailable' }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input.endsWith('/api/merchants/97')
          ? { id: 97, name: 'Unknown Profile Merchant', status: 'active', notes: null, primary_location: 'Queens, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-03T00:00:00Z' }
          : [],
      }
    }))
    render(<App />)

    await screen.findByRole('heading', { name: 'Unknown Profile Merchant' })
    const notice = await screen.findByRole('alert')
    within(notice).getByText(/无法读取 FBR\/GBP 状态/)
    within(notice).getByText(/profile status unavailable/)
    screen.getByRole('button', { name: '开始诊断' })
    expect(screen.queryByRole('link', { name: '前往商户资料重试' })).toBeNull()
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
    const execution = taskExecution({
      id: 4,
      task_id: 1,
      idempotency_key: 'task:1:preparation:1:dddddddddddddddd',
      request: {
        definition_checksum: 'c'.repeat(64),
        executor_kind: 'COREAI_LLM_CALL',
        llm_call_id: 'preparation-call',
        stage: 'PREPARATION',
        task_id: 1,
        workflow_version: 1,
      },
      evidence: ['基于已确认的营业时间事实。'],
      result: {
        outcome: 'ready',
        summary: '已生成营业时间更新草案。',
        artifact_refs: ['artifact://hours-draft'],
        evidence: ['基于已确认的营业时间事实。'],
        external_write_performed: false,
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks/1'
        ? taskDetail({
            id: 1,
            title: '更新 GBP 营业时间',
            rationale: '营业时间已变化',
            expected_outcome: '减少误访',
            category: 'gbp',
            status: 'AWAITING_APPROVAL',
            version: 5,
            execution_status: 'SUCCEEDED',
            executions: [execution],
          })
          : ({ id: 1, name: '测试商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }),
    })))
    render(<App />)

    const result = await screen.findByRole('region', { name: 'Attempt 1 结果' })
    within(result).getByText('已生成营业时间更新草案。')
    screen.getByRole('button', { name: '批准准备结果' })
    screen.getByRole('button', { name: '退回重新准备' })
    expect(screen.queryByRole('textbox', { name: '执行证据' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存证据' })).toBeNull()
  })

  it('assigns a new task to the agent instead of opening a manual evidence form', async () => {
    window.history.pushState({}, '', '/tasks/2')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks/2'
        ? taskDetail({
            id: 2,
            title: '生成本周 GBP Post',
            rationale: '保持内容活跃度',
            expected_outcome: '提升本地曝光',
            category: 'gbp',
          })
          : ({ id: 1, name: '测试商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }),
    })))
    render(<App />)

    await screen.findByRole('button', { name: '开始内容准备' })
    screen.getByText('尚无内容准备 Attempt。')
    expect(screen.queryByRole('textbox', { name: '执行证据' })).toBeNull()
    expect(screen.queryByRole('button', { name: /发布/ })).toBeNull()
  })

  it('returns a merchant task to the merchant workspace it came from', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const task = taskSummary({
      id: 37,
      title: '撰写本地落地页或服务介绍内容',
      description: '补全本地服务内容',
      rationale: '缺少本地关键词内容页',
      expected_outcome: '覆盖本地搜索需求',
      category: 'content',
      source_run_id: 8,
      source_key: 'local-page',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/merchants/1'
        ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
        : input === '/api/merchants/1/tasks'
          ? [task]
          : input === '/api/tasks/37'
            ? taskDetail(task)
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
    const task = taskSummary({
      id: 38,
      merchant_name: '冒烟商户',
      title: '完善 GBP 商户资料',
      rationale: '资料不完整',
      expected_outcome: '提升地图可见性',
      category: 'gbp',
      source_run_id: null,
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks'
        ? [task]
        : input === '/api/tasks/38'
          ? taskDetail(task)
          : input === '/api/merchants/1'
            ? { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
            : [],
    })))
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: task.title }))
    await screen.findByRole('main', { name: '任务详情' })
    fireEvent.click(await screen.findByRole('button', { name: '返回任务总览' }))

    await screen.findByRole('main', { name: '任务总览' })
  })

  it('returns to the explicit task origin even when the detail route has no browser history entry', async () => {
    window.history.replaceState(
      { usr: { taskOrigin: { kind: 'merchant', from: '/merchants/1' } }, key: 'task-direct', idx: 0 },
      '',
      '/tasks/40',
    )
    const task = taskDetail({
      id: 40,
      title: '同步本地服务内容',
      rationale: '保持信息一致',
      expected_outcome: '减少信息差异',
      category: 'content',
      source_run_id: null,
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks/40'
        ? task
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
    const task = taskDetail({
      id: 39,
      title: '更新官网服务介绍',
      rationale: '页面信息过期',
      expected_outcome: '保持信息一致',
      category: 'content',
      status: 'PREPARING',
      source_run_id: 8,
      source_key: 'service-page',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/tasks/39'
        ? task
        : { id: 1, name: '冒烟商户', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' },
    })))
    render(<App />)

    await screen.findByRole('button', { name: '返回冒烟商户' })
    screen.getByRole('heading', { name: task.title })
    screen.getByRole('heading', { name: '任务定义' })
    screen.getByRole('heading', { name: '全部 Attempts' })
    screen.getByRole('heading', { name: '生命周期轨迹' })
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
    const planLink = await screen.findByRole('link', { name: '查看并编辑 Plan' })
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
          : input === '/api/tasks?plan_id=7&include_archived=true'
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
                plan: canonicalPlanContext(1),
              }, {
                id: 12,
                merchant_id: 1,
                plan_id: 7,
                plan_revision: 1,
                task_key: 'review',
                task_type: 'PREPARE_ONLY',
                title: '正式审核任务',
                category: 'review',
                status: 'PENDING',
                source_run_id: 1,
                plan: canonicalPlanContext(1),
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
      if (input === '/api/tasks?plan_id=7&include_archived=true') return response([
        { id: 99, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'obsolete', task_type: 'PREPARE_ONLY', title: 'Removed history', category: null, status: 'CANCELLED', source_run_id: 1, plan: canonicalPlanContext(1) },
        { id: 12, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft formal task', category: 'content', status: 'PENDING', source_run_id: 1, plan: canonicalPlanContext(1) },
        { id: 11, merchant_id: 1, plan_id: 7, plan_revision: 0, task_key: 'review', task_type: 'PREPARE_ONLY', title: 'Review formal task', category: 'review', status: 'DONE', source_run_id: 1, plan: canonicalPlanContext(1) },
      ])
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    const taskPanel = await screen.findByRole('complementary', { name: '本次生成任务' })
    await within(taskPanel).findByRole('link', { name: 'Review formal task' })
    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks?plan_id=7&include_archived=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
    const taskLinks = within(taskPanel).getAllByRole('link').filter(link => link.getAttribute('href')?.startsWith('/tasks/'))
    expect(taskLinks.map(link => link.textContent)).toEqual(['Review formal task', 'Draft formal task'])
    within(taskPanel).getByText('2 项')
    expect(within(taskPanel).queryByText('Removed history')).toBeNull()
  })

  it('labels generated tasks on the run page with the shared task status vocabulary', async () => {
    window.history.pushState({}, '', '/runs/1')
    const approved = planView({
      approved_revision: 1,
      current_revision: { ...planView().current_revision, decision_state: 'APPROVED' },
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
      if (input === '/api/tasks?plan_id=7&include_archived=true') return response([
        { id: 11, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Publishing task', category: 'content', status: 'EXECUTING', source_run_id: 1, plan: canonicalPlanContext(1) },
        { id: 12, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'review', task_type: 'PREPARE_ONLY', title: 'Awaiting task', category: 'review', status: 'AWAITING_APPROVAL', source_run_id: 1, plan: canonicalPlanContext(1) },
      ])
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    const taskPanel = await screen.findByRole('complementary', { name: '本次生成任务' })
    await within(taskPanel).findByRole('link', { name: 'Publishing task' })
    const executing = within(taskPanel).getByText('发布中')
    expect(executing.className).toBe('badge executing')
    const awaiting = within(taskPanel).getByText('待内容审批')
    expect(awaiting.className).toBe('badge awaiting')
    expect(within(taskPanel).queryByText('执行中')).toBeNull()
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
    expect(calls).not.toContain('/api/tasks?plan_id=7&include_archived=true')
  })

  it('fails closed when canonical Plan tasks contain a duplicate key', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') return response({ detail: 'accepted audit not found' }, 404)
      if (input === '/api/runs/1/task-plan') return response(planView({
        approved_revision: 1,
        current_revision: { ...planView().current_revision, decision_state: 'APPROVED' },
      }))
      if (input === '/api/tasks?plan_id=7&include_archived=true') return response([
        { id: 11, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft A', category: null, status: 'PENDING', source_run_id: 1, plan: canonicalPlanContext(1) },
        { id: 12, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'draft', task_type: 'PREPARE_ONLY', title: 'Draft B', category: null, status: 'PENDING', source_run_id: 1, plan: canonicalPlanContext(1) },
        { id: 13, merchant_id: 1, plan_id: 7, plan_revision: 1, task_key: 'review', task_type: 'PREPARE_ONLY', title: 'Review task', category: null, status: 'PENDING', source_run_id: 1, plan: canonicalPlanContext(1) },
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

  it('fails closed when an approved payload key has no canonical Task row', async () => {
    window.history.pushState({}, '', '/runs/1')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/runs/1/audit') return response({ detail: 'accepted audit not found' }, 404)
      if (input === '/api/runs/1/task-plan') return response(planView({
        approved_revision: 1,
        current_revision: { ...planView().current_revision, decision_state: 'APPROVED' },
      }))
      if (input === '/api/tasks?plan_id=7&include_archived=true') return response([
        {
          id: 11,
          merchant_id: 1,
          plan_id: 7,
          plan_revision: 1,
          task_key: 'draft',
          task_type: 'PREPARE_ONLY',
          title: 'Only one row',
          category: null,
          status: 'PENDING',
          source_run_id: 1,
          plan: canonicalPlanContext(1),
        },
      ])
      if (input === '/api/runs/1') return response({
        id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: '2026-09-01T00:02:00Z',
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      })
      return response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
    }))

    render(<App />)

    await screen.findByText('正式 Task 数据缺少当前批准 key：review，请刷新 Plan')
    expect(screen.queryByRole('link', { name: 'Only one row' })).toBeNull()
    within(screen.getByRole('complementary', { name: '本次生成任务' })).getByText('0 项')
  })

  it('rejects Task rows from a newer approved revision snapshot', async () => {
    window.history.pushState({}, '', '/runs/1')
    const taskRows = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/runs/1/audit') return Promise.resolve(response({ detail: 'accepted audit not found' }, 404))
      if (input === '/api/runs/1/task-plan') return Promise.resolve(response(planView({
        approved_revision: 1,
        current_revision: {
          ...planView().current_revision,
          decision_state: 'APPROVED',
          payload: { schema_version: 'seo_ops.task_plan.v1', tasks: [planItem('draft')] },
        },
      })))
      if (input === '/api/tasks?plan_id=7&include_archived=true') return taskRows.promise
      if (input === '/api/runs/1') return Promise.resolve(response({
        id: 1, merchant_id: 1, coreai_run_id: 'run-1', status: 'succeeded', trigger_kind: 'manual',
        report_text: '# Report', error: null, plan_approved_at: '2026-09-01T00:02:00Z',
        created_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:01:00Z',
      }))
      return Promise.resolve(response({ id: 1, name: 'Merchant', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
    }))

    render(<App />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/tasks?plan_id=7&include_archived=true')).toBe(true))
    taskRows.resolve(response([{
      id: 21,
      merchant_id: 1,
      plan_id: 7,
      plan_revision: 1,
      task_key: 'draft',
      task_type: 'PREPARE_ONLY',
      title: 'Revision two row',
      category: null,
      status: 'PENDING',
      source_run_id: 1,
      plan: canonicalPlanContext(2),
    }]))

    await screen.findByText('正式 Task 所属批准 revision 已变化，请刷新 Plan')
    expect(screen.queryByRole('link', { name: 'Revision two row' })).toBeNull()
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
    await within(taskPanel).findByRole('alert')
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
      if (input === '/api/merchants/1') return Promise.resolve(response(activeMerchant()))
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

  it('retries the complete Plan identity load after merchant status lookup fails', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    let merchantAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/task-plans/7') return response(planView())
      if (input === '/api/merchants/1') {
        merchantAttempts += 1
        return merchantAttempts === 1
          ? response({ detail: 'merchant status unavailable' }, 503)
          : response(activeMerchant())
      }
      return response({ detail: 'not found' }, 404)
    }))

    render(<App />)

    await screen.findByText('merchant status unavailable')
    const title = screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement
    expect(title.disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新加载 Plan 与商户状态' }))

    await waitFor(() => expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).disabled).toBe(false))
    expect(screen.queryByText('merchant status unavailable')).toBeNull()
    expect(merchantAttempts).toBe(2)
  })

  it('treats an unrecognized merchant status as a retryable read error', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    let merchantAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/task-plans/7') return response(planView())
      if (input === '/api/merchants/1') {
        merchantAttempts += 1
        return response(merchantAttempts === 1
          ? { ...activeMerchant(), status: 'syncing' }
          : activeMerchant())
      }
      return response({ detail: 'not found' }, 404)
    }))

    render(<App />)

    await screen.findByText('商户状态响应无效')
    expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '重新加载 Plan 与商户状态' }))
    await waitFor(() => expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).disabled).toBe(false))
    expect(merchantAttempts).toBe(2)
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
      if (input === '/api/merchants/1') return Promise.resolve(response(activeMerchant()))
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

  it('preserves edits and retries the original save after a non-conflict mutation failure', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    let saveAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response(activeMerchant())
      if (input === '/api/task-plans/7/draft' && init?.method === 'PUT') {
        saveAttempts += 1
        if (saveAttempts === 1) return response({ detail: 'save service unavailable' }, 503)
        const body = JSON.parse(String(init.body))
        return response(planView({
          latest_revision: 2,
          current_revision: {
            ...planView().current_revision,
            revision: 2,
            checksum: PLAN_CHECKSUM_2,
            payload: body.plan,
          },
        }))
      }
      return response(planView())
    }))

    render(<App />)

    const title = await screen.findByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement
    fireEvent.change(title, { target: { value: 'Keep this local draft' } })
    fireEvent.click(screen.getByRole('button', { name: '保存 Plan 草稿' }))

    await screen.findByText('save service unavailable')
    expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).value).toBe('Keep this local draft')
    expect(screen.queryByRole('button', { name: '重新加载 Plan 与商户状态' })).toBeNull()
    const retrySave = screen.getByRole('button', { name: '保存 Plan 草稿' }) as HTMLButtonElement
    expect(retrySave.disabled).toBe(false)
    fireEvent.click(retrySave)

    await screen.findByText('已保存 Revision 2')
    expect((screen.getByRole('textbox', { name: '任务标题 draft' }) as HTMLInputElement).value).toBe('Keep this local draft')
    expect(saveAttempts).toBe(2)
  })

  it('retries approval in place after a non-conflict mutation failure', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    let approveAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response(activeMerchant())
      if (input === '/api/task-plans/7/approve' && init?.method === 'POST') {
        approveAttempts += 1
        if (approveAttempts === 1) return response({ detail: 'approval service unavailable' }, 503)
        return response(planView({
          approved_revision: 1,
          current_revision: {
            ...planView().current_revision,
            decision_state: 'APPROVED',
          },
        }))
      }
      return response(planView())
    }))

    render(<App />)

    const approve = await screen.findByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement
    fireEvent.click(approve)

    await screen.findByText('approval service unavailable')
    expect(screen.queryByRole('button', { name: '重新加载 Plan 与商户状态' })).toBeNull()
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)

    await screen.findByText('当前 Revision 已批准')
    expect(approveAttempts).toBe(2)
  })

  it('preserves the rejection reason and retries rejection after a non-conflict mutation failure', async () => {
    window.history.pushState({}, '', '/task-plans/7')
    let rejectAttempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response(activeMerchant())
      if (input === '/api/task-plans/7/reject' && init?.method === 'POST') {
        rejectAttempts += 1
        if (rejectAttempts === 1) return response({ detail: 'rejection service unavailable' }, 503)
        return response(planView({
          current_revision: {
            ...planView().current_revision,
            decision_state: 'REJECTED',
          },
        }))
      }
      return response(planView())
    }))

    render(<App />)

    const reason = await screen.findByRole('textbox', { name: '拒绝原因' }) as HTMLTextAreaElement
    fireEvent.change(reason, { target: { value: 'Keep this rejection rationale' } })
    const reject = screen.getByRole('button', { name: '拒绝整个 Plan' }) as HTMLButtonElement
    fireEvent.click(reject)

    await screen.findByText('rejection service unavailable')
    expect((screen.getByRole('textbox', { name: '拒绝原因' }) as HTMLTextAreaElement).value).toBe('Keep this rejection rationale')
    expect(screen.queryByRole('button', { name: '重新加载 Plan 与商户状态' })).toBeNull()
    expect(reject.disabled).toBe(false)
    fireEvent.click(reject)

    await screen.findByText('当前 Revision 已拒绝')
    expect(rejectAttempts).toBe(2)
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
      if (input === '/api/merchants/1') return response(activeMerchant())
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
      if (input === '/api/merchants/1') return response(activeMerchant())
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
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => response(
      input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/1'
          ? activeMerchant()
          : planView(),
    )))
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
      if (input === '/api/merchants/1') return response(activeMerchant())
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

  it('shows one queue blocker, publication-compatible labels, and the full dependency chain only in detail', async () => {
    window.history.pushState({}, '', '/tasks')
    const draft = taskSummary({ id: 11, task_key: 'draft', title: 'Draft content', status: 'EXECUTING', execution_status: 'RUNNING' })
    const review = taskSummary({
      blocker: { code: 'UPSTREAM_NOT_DONE', task_id: 11, task_key: 'draft', task_title: 'Draft content' },
      readiness: 'BLOCKED',
    })
    const publish = taskSummary({ id: 13, task_key: 'publish', title: 'Publish content', status: 'VERIFYING', execution_status: 'RUNNING' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/tasks/12') {
        return response(taskDetail({
          upstream: [draft],
          downstream: [publish],
          blocker: review.blocker,
          readiness: 'BLOCKED',
          scheduled_start: '2026-09-05T09:30:00+08:00',
        }))
      }
      if (input === '/api/merchants/1') {
        return response({
          id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null,
          website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z',
        })
      }
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input.startsWith('/api/tasks')) return response([draft, review, publish])
      return response([])
    }))

    render(<App />)

    await screen.findByText('被「Draft content」阻塞')
    const queue = screen.getByRole('table', { name: '跨商户任务列表' })
    within(queue).getByText('发布中')
    within(queue).getByText('验证中')
    expect(screen.queryByRole('heading', { name: '上游任务' })).toBeNull()
    fireEvent.click(screen.getByRole('link', { name: '查看任务：Review content' }))
    const upstream = await screen.findByRole('region', { name: '上游任务' })
    expect(within(upstream).getByRole('link', { name: 'Draft content' }).getAttribute('href')).toBe('/tasks/11')
    const downstream = screen.getByRole('region', { name: '下游任务' })
    expect(within(downstream).getByRole('link', { name: 'Publish content' }).getAttribute('href')).toBe('/tasks/13')
    const lifecycle = screen.getByRole('region', { name: '生命周期轨迹' })
    expect(lifecycle.textContent).toContain('被「Draft content」阻塞')
    screen.getByText('09-05 09:30')
    screen.getByRole('button', { name: '刷新任务状态' })
    expect(screen.queryByRole('button', { name: /物理删除|直接完成|批量/ })).toBeNull()
  })

  it('creates an independent PREPARE_ONLY task with the complete strict envelope', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({
        id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: 'Mineola, NY',
        website_url: 'https://example.test', auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z',
      })
      if (input === '/api/merchants/1/tasks' && init?.method === 'POST') {
        return response(taskSummary({ id: 21, source_kind: 'OPERATOR', title: 'Prepare weekly post copy' }), 201)
      }
      if (input.startsWith('/api/tasks')) return response([])
      if (input === '/api/merchants/1/runs') return response([])
      return response([])
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '＋ 新建任务' }))
    fireEvent.change(screen.getByRole('textbox', { name: '任务标题' }), { target: { value: ' Prepare weekly post copy ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '为什么做' }), { target: { value: ' Keep the profile useful ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '预期效果' }), { target: { value: ' A reviewable post draft ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '准备要求' }), { target: { value: ' Draft only ' } })
    fireEvent.change(screen.getByLabelText('计划开始'), { target: { value: '2026-09-05T09:30' } })
    fireEvent.change(screen.getByRole('combobox', { name: '任务类别' }), { target: { value: 'content' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(calls.some(call => call.input === '/api/merchants/1/tasks' && call.init?.method === 'POST')).toBe(true))
    const create = calls.find(call => call.input === '/api/merchants/1/tasks' && call.init?.method === 'POST')!
    expect(JSON.parse(String(create.init?.body))).toEqual({
      task_type: 'PREPARE_ONLY',
      title: 'Prepare weekly post copy',
      rationale: 'Keep the profile useful',
      expected_outcome: 'A reviewable post draft',
      scheduled_start: new Date('2026-09-05T09:30').toISOString(),
      parameters: { description: 'Draft only', category: 'content' },
    })
  })

  it('saves only operator metadata with CAS, normalized labels, and a detail readback', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    let current = taskDetail()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({
        id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null,
        website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z',
      })
      if (input === '/api/tasks/12' && init?.method === 'PATCH') {
        current = taskDetail({ version: 4, assignee: 'operator-a', labels: ['urgent', 'review'], operator_note: 'Check brand tone' })
        return response(taskSummary(current))
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    fireEvent.change(await screen.findByRole('textbox', { name: '负责人' }), { target: { value: ' operator-a ' } })
    for (let index = 0; index < 3; index += 1) fireEvent.click(screen.getByRole('button', { name: '新增内部标签' }))
    const labelInputs = screen.getAllByRole('textbox', { name: /^内部标签 \d+$/ })
    fireEvent.change(labelInputs[0], { target: { value: ' urgent ' } })
    fireEvent.change(labelInputs[1], { target: { value: ' review ' } })
    fireEvent.change(labelInputs[2], { target: { value: ' urgent ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '操作人备注' }), { target: { value: ' Check brand tone ' } })
    fireEvent.click(screen.getByRole('button', { name: '保存内部元数据' }))

    await screen.findByText('Task version 4')
    const mutation = calls.find(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')!
    expect(JSON.parse(String(mutation.init?.body))).toEqual({
      expected_version: 3,
      assignee: 'operator-a',
      labels: ['urgent', 'review'],
      operator_note: 'Check brand tone',
    })
    expect(calls.filter(call => call.input === '/api/tasks/12' && !call.init?.method)).toHaveLength(2)
  })

  it('preserves comma and newline-containing labels plus untouched metadata when saving one dirty field', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    let current = taskDetail({ labels: ['New York,\nUSA'], operator_note: ' Keep this exact ' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12' && init?.method === 'PATCH') {
        current = taskDetail({ version: 4, assignee: 'operator-a', labels: ['New York,\nUSA'], operator_note: ' Keep this exact ' })
        return response(taskSummary(current))
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    fireEvent.change(await screen.findByRole('textbox', { name: '负责人' }), { target: { value: 'operator-a' } })
    fireEvent.click(screen.getByRole('button', { name: '保存内部元数据' }))
    await screen.findByText('Task version 4')
    expect(JSON.parse(String(calls.find(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')?.init?.body))).toEqual({
      expected_version: 3,
      assignee: 'operator-a',
    })
    expect((screen.getByRole('textbox', { name: '内部标签 1' }) as HTMLTextAreaElement).value).toBe('New York,\nUSA')
    expect((screen.getByRole('textbox', { name: '操作人备注' }) as HTMLTextAreaElement).value).toBe(' Keep this exact ')
  })

  it('disables normalized no-op metadata saves and never sends an empty CAS mutation', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') {
        return response(taskDetail({
          assignee: 'operator-a', labels: ['urgent', 'review'], operator_note: 'Check brand tone',
        }))
      }
      return response([])
    }))
    render(<App />)

    fireEvent.change(await screen.findByRole('textbox', { name: '负责人' }), { target: { value: ' operator-a ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '内部标签 1' }), { target: { value: ' urgent ' } })
    fireEvent.click(screen.getByRole('button', { name: '新增内部标签' }))
    fireEvent.change(screen.getByRole('textbox', { name: '内部标签 3' }), { target: { value: ' review ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '操作人备注' }), { target: { value: ' Check brand tone ' } })

    const save = screen.getByRole('button', { name: '保存内部元数据' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(calls.filter(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')).toHaveLength(0)
    screen.getByText('没有需要保存的变更。')
  })

  it('cancels a safe task with a reason and preserves its history instead of deleting it', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    let current = taskDetail()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12/cancel') {
        current = taskDetail({ status: 'CANCELLED', version: 4, cancelled_at: '2026-09-03T02:00:00+00:00' })
        return response(taskSummary(current))
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '取消任务并保留历史' }))
    const submit = screen.getByRole('button', { name: '确认取消任务' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '取消原因' }), { target: { value: ' Campaign was withdrawn ' } })
    fireEvent.click(submit)

    await screen.findByText('已取消')
    const mutation = calls.find(call => call.input === '/api/tasks/12/cancel')!
    expect(mutation.init?.method).toBe('POST')
    expect(JSON.parse(String(mutation.init?.body))).toEqual({ expected_version: 3, reason: 'Campaign was withdrawn' })
    expect(calls.some(call => call.init?.method === 'DELETE')).toBe(false)
  })

  it('treats a 201 execution as an attempt result, binds approval identity, and never claims publication', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const result = taskExecution()
    let current = taskDetail()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12/execute') {
        current = taskDetail({ status: 'AWAITING_APPROVAL', version: 5, execution_status: 'SUCCEEDED', executions: [result] })
        return response(result, 201)
      }
      if (input === '/api/tasks/12/approve-execution') {
        current = taskDetail({ status: 'DONE', version: 6, execution_status: 'SUCCEEDED', completed_at: '2026-09-03T02:03:00+00:00', executions: [{ ...result, preparation_trust: 'UNTRUSTED', reviewed_at: '2026-09-03T02:03:00+00:00' }] })
        return response({ task: current, execution: current.executions[0] })
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    const start = await screen.findByRole('button', { name: '开始内容准备' })
    act(() => { start.click(); start.click() })
    await screen.findByRole('button', { name: '批准准备结果' })
    expect(calls.filter(call => call.input === '/api/tasks/12/execute')).toHaveLength(1)
    expect(JSON.parse(String(calls.find(call => call.input === '/api/tasks/12/execute')?.init?.body))).toEqual({ expected_version: 3 })
    screen.getByText('Prepared a reviewable draft.')
    screen.getByText('服务端已校验：无外部业务写入')
    screen.getByText('人工批准只会完成这个内容准备 Task；不会发布，也不会验证外部资源。')
    fireEvent.click(screen.getByRole('button', { name: '批准准备结果' }))
    await screen.findByText('已完成')
    expect(JSON.parse(String(calls.find(call => call.input === '/api/tasks/12/approve-execution')?.init?.body))).toEqual({
      expected_version: 5,
      expected_execution_id: 41,
      expected_result_checksum: 'e'.repeat(64),
    })
  })

  it.each([
    ['TASK_PREPARATION_APPROVED', 41],
    ['TASK_PREPARATION_RETURNED', 41],
    ['TASK_PREPARATION_APPROVED', 99],
  ] as const)('binds read-only result history to review event %s / execution %s', async (eventType, reviewedExecutionId) => {
    window.history.pushState({}, '', '/tasks/12')
    const reviewed = taskExecution({ reviewed_at: '2026-09-03T02:03:00Z', preparation_trust: 'UNTRUSTED' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: eventType.endsWith('APPROVED') ? 'DONE' : 'PENDING',
        execution_status: 'SUCCEEDED', executions: [reviewed], events: [{id: 92, entity_type:'TASK', entity_id:12,
          event_type:eventType, actor_type:'OPERATOR', actor_id:'test', payload:{execution_id:reviewedExecutionId}, created_at:reviewed.reviewed_at}] }))
      return response([])
    }))
    render(<App />)
    await screen.findByRole('article', { name: 'Attempt 1' })
    if (reviewedExecutionId !== 41) {
      expect(screen.queryByText('历史准备结果（只读）')).toBeNull()
      screen.getByText('无法确认是否外写')
      expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
      return
    }
    screen.getByText('历史准备结果（只读）')
    if (eventType.endsWith('APPROVED')) {
      const lifecycle = screen.getByRole('region', { name: '生命周期轨迹' })
      expect(within(lifecycle).queryByText('READY')).toBeNull()
      expect(lifecycle.textContent).not.toContain('可执行')
    }
    screen.getByText('Prepared a reviewable draft.')
    expect(screen.queryByText('无法确认是否外写')).toBeNull()
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退回重新准备' })).toBeNull()
  })

  it('does not retain a running notice after an asynchronous preparation completes', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const running = taskExecution({ status: 'RUNNING', coreai_run_id: 'agent-run', result: null,
      result_checksum: null, evidence: [], finished_at: null, preparation_trust: 'UNTRUSTED' })
    let current = taskDetail()
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active' })
      if (input === '/api/tasks/12/execute') {
        current = taskDetail({ status: 'PREPARING', version: 4, execution_status: 'RUNNING', executions: [running] })
        return response(running, 201)
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: '开始内容准备' }))
    await screen.findByText('运行中', { exact: true })
    current = taskDetail({ status: 'AWAITING_APPROVAL', version: 5, execution_status: 'SUCCEEDED',
      executions: [taskExecution({ coreai_run_id: 'agent-run', preparation_trust: 'UNTRUSTED' })] })
    fireEvent.click(screen.getByRole('button', { name: '刷新任务状态' }))
    await screen.findByText('准备完成', { exact: true })
    expect(screen.queryByText(/Attempt 当前状态：运行中/)).toBeNull()
  })

  it.each([true, false])('requires a bound run for dedicated Agent review (%s)', async (bound) => {
    window.history.pushState({}, '', '/tasks/12')
    const execution = taskExecution({
      coreai_run_id: bound ? 'dedicated-run' : null,
      request: {
        definition_checksum: 'c'.repeat(64), executor_kind: 'COREAI_AGENT_PREPARATION_V1',
        stage: 'PREPARATION', task_id: 12, workflow_version: 1,
        local_agent_id: 'local-agent', coreai_agent_id: 'remote-agent', agent_name: '专用准备 Agent',
        config_sha256: 'a'.repeat(64), operator: 'test', merchant_lifecycle: [1, 'b'.repeat(64)],
        agent_snapshot: { id: 'remote-agent', type: 'AGENT', status: 'PUBLISHED', tools: [], skill_ids: [],
          subagent_ids: [], dataset_config: [], sandbox_config: null, enable_memory: false },
      },
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [execution] }))
      return response([])
    }))
    render(<App />)
    await screen.findByRole('article', { name: 'Attempt 1' })
    const approval = screen.queryByRole('button', { name: '批准准备结果' }) as HTMLButtonElement | null
    if (bound) {
      expect(approval?.disabled).toBe(false)
      screen.getByText('dedicated-run')
      screen.getByText('专用准备 Agent')
    } else {
      expect(!approval || approval.disabled).toBe(true)
    }
  })

  it('binds return to the current Task version, execution id, checksum, and a non-empty reason', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const execution = taskExecution()
    let current = taskDetail({ status: 'AWAITING_APPROVAL', version: 5, execution_status: 'SUCCEEDED', executions: [execution] })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12/return-execution') {
        current = taskDetail({ status: 'PENDING', version: 6, execution_status: 'SUCCEEDED', executions: [{ ...execution, preparation_trust: 'UNTRUSTED', reviewed_at: '2026-09-03T02:03:00+00:00', review_note: 'Use approved menu facts' }] })
        return response({ task: current, execution: current.executions[0] })
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '退回重新准备' }))
    const submit = screen.getByRole('button', { name: '确认退回' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox', { name: '退回原因' }), { target: { value: ' Use approved menu facts ' } })
    fireEvent.click(submit)
    await screen.findByText('待办')
    expect(JSON.parse(String(calls.find(call => call.input === '/api/tasks/12/return-execution')?.init?.body))).toEqual({
      expected_version: 5,
      expected_execution_id: 41,
      expected_result_checksum: 'e'.repeat(64),
      reason: 'Use approved menu facts',
    })
  })

  it('never offers PREPARE_ONLY review actions for a succeeded publication attempt', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const publication = taskExecution({ stage: 'PUBLICATION', preparation_trust: 'UNTRUSTED' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') {
        return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [publication] }))
      }
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 1' })
    screen.getByText('发布完成')
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退回重新准备' })).toBeNull()
  })

  it.each([
    {
      name: 'an extra public request key',
      execution: () => {
        const current = taskExecution()
        return taskExecution({ preparation_trust: 'UNTRUSTED', request: { ...current.request, unexpected: 'unsafe' } })
      },
    },
    {
      name: 'a missing public request key',
      execution: () => taskExecution({ preparation_trust: 'UNTRUSTED', request: {
        definition_checksum: 'c'.repeat(64), executor_kind: 'COREAI_LLM_CALL', llm_call_id: 'preparation-call',
        stage: 'PREPARATION', task_id: 12,
      } }),
    },
    { name: 'a Core AI run marker', execution: () => taskExecution({ coreai_run_id: 'coreai-run-41', preparation_trust: 'UNTRUSTED' }) },
    { name: 'a provider resource marker', execution: () => taskExecution({ provider_resource_id: 'provider-resource-41', preparation_trust: 'UNTRUSTED' }) },
    { name: 'an artifact marker', execution: () => taskExecution({ artifact_id: 81, preparation_trust: 'UNTRUSTED' }) },
    { name: 'an approval marker', execution: () => taskExecution({ approval_id: 71, preparation_trust: 'UNTRUSTED' }) },
    { name: 'mismatched execution evidence', execution: () => taskExecution({ evidence: ['Different evidence.'], preparation_trust: 'UNTRUSTED' }) },
    { name: 'a non-succeeded status', execution: () => taskExecution({ status: 'FAILED', preparation_trust: 'UNTRUSTED' }) },
    { name: 'an already reviewed result', execution: () => taskExecution({ reviewed_at: '2026-09-03T03:00:00+00:00', preparation_trust: 'UNTRUSTED' }) },
  ])('shows no safe claim or review control when the latest envelope has $name', async ({ execution }) => {
    window.history.pushState({}, '', '/tasks/12')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [execution()] }))
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 1' })
    screen.getByText('无法确认是否外写')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退回重新准备' })).toBeNull()
  })

  it('does not elevate a valid public envelope when the server-derived preparation trust is untrusted', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const hiddenEnvelopeFailure = taskExecution({ preparation_trust: 'UNTRUSTED' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [hiddenEnvelopeFailure] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('服务端未确认此结果可审')
    screen.getByText('无法确认是否外写')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
    expect(screen.queryByRole('button', { name: '退回重新准备' })).toBeNull()
  })

  it('does not trust a valid-looking result after a newer attempt exists', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const older = taskExecution({ preparation_trust: 'UNTRUSTED' })
    const newer = taskExecution({ id: 42, attempt: 2, status: 'FAILED', result: null, result_checksum: null, evidence: [], idempotency_key: 'task:12:preparation:2:dddddddddddddddd', preparation_trust: 'RETRYABLE' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'FAILED', executions: [older, newer] }))
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 2' })
    screen.getByText('无法确认是否外写')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
  })

  it.each([
    {
      name: 'a summary status that disagrees with the latest execution',
      execution: () => taskExecution(),
      detail: { execution_status: 'FAILED' },
    },
    {
      name: 'a non-integer attempt identity',
      execution: () => taskExecution({ attempt: '1' }),
      detail: { execution_status: 'SUCCEEDED' },
    },
  ])('rejects $name', async ({ execution, detail }) => {
    window.history.pushState({}, '', '/tasks/12')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', executions: [execution()], ...detail }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('无法确认是否外写')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
  })

  it('fails closed instead of crashing or claiming no-write for a malformed stored result', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const malformed = taskExecution({
      result: { outcome: 'ready', summary: 'Missing result arrays', external_write_performed: false },
      preparation_trust: 'UNTRUSTED',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [malformed] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('公开结果预检未通过')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
  })

  it.each([
    ['a needs-input object', { outcome: 'needs_input', questions: ['Which location?'], external_write_performed: false }],
    ['an array', ['unexpected']],
    ['a scalar', 'unexpected'],
    ['a null succeeded result', null],
  ])('renders arbitrary JSON safely and fails closed for %s', async (_name, result) => {
    window.history.pushState({}, '', '/tasks/12')
    const malformed = taskExecution({ result, preparation_trust: 'UNTRUSTED' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [malformed] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('无法确认是否外写')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
  })

  it('surfaces a write-positive stored result as unsafe and never renders the green no-write mark', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const unsafe = taskExecution({
      result: {
        outcome: 'ready', summary: 'A write was reported.', artifact_refs: ['provider://resource'],
        evidence: ['Provider accepted a write.'], external_write_performed: true,
      },
      evidence: ['Provider accepted a write.'],
      preparation_trust: 'UNTRUSTED',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED', executions: [unsafe] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('结果报告可能发生外部业务写入')
    expect(screen.queryByText('服务端已校验：无外部业务写入')).toBeNull()
    expect(screen.queryByRole('button', { name: '批准准备结果' })).toBeNull()
  })

  it('does not offer preparation retry or no-write reassurance for publication uncertainty', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const publication = taskExecution({ stage: 'PUBLICATION', status: 'UNKNOWN', result: null, result_checksum: null, preparation_trust: 'UNTRUSTED' })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'UNKNOWN', executions: [publication] }))
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 1' })
    expect(screen.queryByRole('button', { name: '授权重新准备' })).toBeNull()
    screen.getByText('外部发布结果不确定，可能已经发生业务写入；不要重复发布，需人工核对。')
    expect(screen.queryByText('再次准备可能重复产生模型成本，但这个阶段没有外部业务写入。')).toBeNull()
  })

  it('trusts only a no-tool UNKNOWN preparation envelope for the narrow no-write explanation', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const unknown = taskExecution({
      status: 'UNKNOWN', result: null, result_checksum: null, evidence: [],
      preparation_trust: 'UNKNOWN_NO_TOOL',
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider response was ambiguous',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'UNKNOWN', executions: [unknown] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('无工具端点不具备业务写能力，但模型调用结果未知；人工重试可能重复计费。')
    screen.getByRole('button', { name: '授权重新准备' })
    expect(screen.queryByText('无法确认是否外写')).toBeNull()
  })

  it('does not elevate valid-looking UNKNOWN public data when server-derived trust is untrusted', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const unknown = taskExecution({
      status: 'UNKNOWN', result: null, result_checksum: null, evidence: [],
      preparation_trust: 'UNTRUSTED',
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider response was ambiguous',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'UNKNOWN', executions: [unknown] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('无法确认是否外写')
    expect(screen.queryByText('无工具端点不具备业务写能力，但模型调用结果未知；人工重试可能重复计费。')).toBeNull()
    expect(screen.queryByRole('button', { name: '授权重新准备' })).toBeNull()
  })

  it('treats an UNKNOWN preparation with a Core AI run marker as untrusted', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const unknown = taskExecution({
      status: 'UNKNOWN', result: null, result_checksum: null, evidence: [], coreai_run_id: 'coreai-run-41',
      preparation_trust: 'UNTRUSTED',
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider response was ambiguous',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'UNKNOWN', executions: [unknown] }))
      return response([])
    }))
    render(<App />)

    await screen.findByText('无法确认是否外写')
    expect(screen.queryByText('无工具端点不具备业务写能力，但模型调用结果未知；人工重试可能重复计费。')).toBeNull()
    expect(screen.queryByRole('button', { name: '授权重新准备' })).toBeNull()
  })

  it('does not offer retry for a legacy failed execution whose result is null', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const legacy = taskExecution({
      status: 'FAILED', result: null, result_checksum: null,
      idempotency_key: 'legacy-task-execution-41',
      preparation_trust: 'UNTRUSTED',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'FAILED', executions: [legacy] }))
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 1' })
    expect(screen.queryByRole('button', { name: '授权重新准备' })).toBeNull()
  })

  it.each([
    { preparationTrust: 'RETRYABLE', coreaiRunId: null, shouldOfferRetry: true },
    { preparationTrust: 'UNTRUSTED', coreaiRunId: null, shouldOfferRetry: false },
    { preparationTrust: 'RETRYABLE', coreaiRunId: 'unexpected-coreai-run', shouldOfferRetry: false },
  ])('gates failed preparation retry on server trust $preparationTrust and run marker $coreaiRunId', async ({ preparationTrust, coreaiRunId, shouldOfferRetry }) => {
    window.history.pushState({}, '', '/tasks/12')
    const failed = taskExecution({
      status: 'FAILED', result: null, result_checksum: null, evidence: [], preparation_trust: preparationTrust,
      coreai_run_id: coreaiRunId,
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider rejected the request',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', execution_status: 'FAILED', executions: [failed] }))
      return response([])
    }))
    render(<App />)

    await screen.findByRole('article', { name: 'Attempt 1' })
    if (shouldOfferRetry) screen.getByRole('button', { name: '授权重新准备' })
    else expect(screen.queryByRole('button', { name: '授权重新准备' })).toBeNull()
  })

  it('requires an explicit retry reason after UNKNOWN and warns about duplicate model cost without implying a write', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const unknown = taskExecution({
      status: 'UNKNOWN', result: null, result_checksum: null, evidence: [],
      preparation_trust: 'UNKNOWN_NO_TOOL',
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider response was ambiguous',
    })
    let current = taskDetail({ status: 'NEEDS_ATTENTION', version: 7, execution_status: 'UNKNOWN', executions: [unknown] })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12/retry-preparation') {
        current = taskDetail({ status: 'PENDING', version: 8, execution_status: 'UNKNOWN', executions: [{ ...unknown, preparation_trust: 'UNTRUSTED' }] })
        return response(taskSummary(current))
      }
      if (input === '/api/tasks/12') return response(current)
      return response([])
    }))
    render(<App />)

    await screen.findByText('结果不确定，需要人工介入')
    screen.getByText('无工具端点不具备业务写能力，但模型调用结果未知；人工重试可能重复计费。')
    fireEvent.click(screen.getByRole('button', { name: '授权重新准备' }))
    fireEvent.change(screen.getByRole('textbox', { name: '重试原因' }), { target: { value: ' No external result was returned ' } })
    fireEvent.click(screen.getByRole('button', { name: '确认重新准备' }))
    await screen.findByText('Task version 8')
    expect(JSON.parse(String(calls.find(call => call.input === '/api/tasks/12/retry-preparation')?.init?.body))).toEqual({
      expected_version: 7,
      reason: 'No external result was returned',
    })
  })

  it('keeps a 409 conflict visible and never automatically repeats the mutation', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12' && init?.method === 'PATCH') return response({ detail: 'task changed; refresh and retry' }, 409)
      if (input === '/api/tasks/12') return response(taskDetail())
      return response([])
    }))
    render(<App />)

    fireEvent.change(await screen.findByRole('textbox', { name: '负责人' }), { target: { value: 'operator-a' } })
    fireEvent.click(screen.getByRole('button', { name: '保存内部元数据' }))
    await screen.findByText('任务已变更，请刷新后再操作。')
    screen.getByRole('button', { name: '重新载入' })
    expect((screen.getByRole('button', { name: '保存内部元数据' }) as HTMLButtonElement).disabled).toBe(true)
    expect(calls.filter(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')).toHaveLength(1)
    screen.getByText('Task version 3')
  })

  it('preserves a non-stale 409 safety explanation instead of mislabeling it as a version conflict', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const unknown = taskExecution({
      status: 'UNKNOWN', result: null, result_checksum: null, evidence: [],
      preparation_trust: 'UNKNOWN_NO_TOOL',
      finished_at: '2026-09-03T02:00:00+00:00', error: 'Provider response was ambiguous',
    })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      if (input === '/api/tasks/12/retry-preparation') {
        return response({ detail: 'task does not have a safely retryable preparation failure' }, 409)
      }
      if (input === '/api/tasks/12') return response(taskDetail({ status: 'NEEDS_ATTENTION', version: 7, execution_status: 'UNKNOWN', executions: [unknown] }))
      return response([])
    }))
    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '授权重新准备' }))
    fireEvent.change(screen.getByRole('textbox', { name: '重试原因' }), { target: { value: 'No result returned' } })
    fireEvent.click(screen.getByRole('button', { name: '确认重新准备' }))

    await screen.findByText('task does not have a safely retryable preparation failure')
    expect(screen.queryByText('任务已变更，请刷新后再操作。')).toBeNull()
    expect(calls.filter(call => call.input === '/api/tasks/12/retry-preparation')).toHaveLength(1)
  })

  it('ignores a stale detail read after the route changes', async () => {
    window.history.pushState({}, '', '/tasks/12')
    const stale = deferred<ReturnType<typeof response>>()
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/tasks/12') return stale.promise
      if (input === '/api/tasks/13') return Promise.resolve(response(taskDetail({ id: 13, task_key: 'current', title: 'Current task' })))
      if (input === '/api/merchants/1') return Promise.resolve(response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
      return Promise.resolve(response([]))
    }))
    render(<App />)
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => input === '/api/tasks/12')).toBe(true))

    act(() => {
      window.history.pushState({}, '', '/tasks/13')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await screen.findByRole('heading', { name: 'Current task' })
    stale.resolve(response(taskDetail({ title: 'Stale task' })))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: 'Stale task' })).toBeNull()
  })

  it('polls an active task until another worker settles it, then stops polling', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const active = taskDetail({ status: 'PREPARING', version: 4, execution_status: 'RUNNING', executions: [activeExecution] })
    const settled = taskDetail({
      status: 'AWAITING_APPROVAL', version: 5, execution_status: 'SUCCEEDED', executions: [taskExecution()],
      events: [...taskDetail().events, {
        id: 92, entity_type: 'TASK', entity_id: 12, event_type: 'TASK_PREPARATION_SUCCEEDED',
        actor_type: 'SYSTEM', actor_id: null, payload: { execution_id: 41 }, created_at: '2026-09-03T01:02:00+00:00',
      }],
    })
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/tasks/12') {
        taskReads += 1
        return response(taskReads === 1 ? active : settled)
      }
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      return response([])
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByText('准备中')).toBeTruthy())
    expect(taskReads).toBe(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    screen.getByText('待内容审批')
    screen.getByText('内容准备已返回可审结果')
    expect(taskReads).toBe(2)

    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(taskReads).toBe(2)
  })

  it('does not let task polling abort a slow merchant read from the full detail load', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const merchant = deferred<ReturnType<typeof response>>()
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const active = taskDetail({ status: 'PREPARING', version: 4, execution_status: 'RUNNING', executions: [activeExecution] })
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/tasks/12') {
        taskReads += 1
        return Promise.resolve(response(active))
      }
      if (input === '/api/merchants/1') return merchant.promise
      return Promise.resolve(response([]))
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByText('准备中')).toBeTruthy())
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    expect(taskReads).toBe(1)

    merchant.resolve(response({ id: 1, name: 'Slow Merchant', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
    await act(async () => { await Promise.resolve() })
    screen.getByRole('button', { name: '返回Slow Merchant' })
    expect((screen.getByRole('button', { name: '刷新任务状态' }) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(taskReads).toBe(2)
  })

  it('keeps one slow poll alive across later intervals and stops after that poll settles the task', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const slowPoll = deferred<ReturnType<typeof response>>()
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const active = taskDetail({ status: 'PREPARING', version: 4, execution_status: 'RUNNING', executions: [activeExecution] })
    const settled = taskDetail({ status: 'AWAITING_APPROVAL', version: 5, execution_status: 'SUCCEEDED', executions: [taskExecution()] })
    const pollSignals: AbortSignal[] = []
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/tasks/12') {
        taskReads += 1
        if (taskReads === 1) return Promise.resolve(response(active))
        pollSignals.push(init?.signal as AbortSignal)
        return slowPoll.promise
      }
      if (input === '/api/merchants/1') return Promise.resolve(response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
      return Promise.resolve(response([]))
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByText('准备中')).toBeTruthy())
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(taskReads).toBe(2)
    expect(pollSignals).toHaveLength(1)
    expect(pollSignals[0].aborted).toBe(false)

    slowPoll.resolve(response(settled))
    await act(async () => { await Promise.resolve() })
    screen.getByText('待内容审批')
    await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
    expect(taskReads).toBe(2)
  })

  it('preserves a dirty metadata draft but blocks saving when polling sees the edited field change remotely', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const initial = taskDetail({
      status: 'PREPARING', version: 4, assignee: 'operator-a', labels: ['urgent'], operator_note: 'base note',
      execution_status: 'RUNNING', executions: [activeExecution],
    })
    const refreshed = taskDetail({
      status: 'PREPARING', version: 5, assignee: 'server-owner', labels: ['server'], operator_note: 'server note',
      execution_status: 'RUNNING', executions: [activeExecution],
    })
    let taskReads = 0
    const calls: Array<{ input: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/tasks/12' && init?.method === 'PATCH') return response(taskSummary(refreshed))
      if (input === '/api/tasks/12') {
        taskReads += 1
        return response(taskReads === 1 ? initial : refreshed)
      }
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      return response([])
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: '负责人' })).toBeTruthy())
    fireEvent.change(screen.getByRole('textbox', { name: '负责人' }), { target: { value: ' local owner ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '内部标签 1' }), { target: { value: ' urgent ' } })
    fireEvent.change(screen.getByRole('textbox', { name: '操作人备注' }), { target: { value: ' base note ' } })

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    screen.getByText('Task version 5')
    expect((screen.getByRole('textbox', { name: '负责人' }) as HTMLInputElement).value).toBe(' local owner ')
    expect((screen.getByRole('textbox', { name: '内部标签 1' }) as HTMLTextAreaElement).value).toBe('server')
    expect((screen.getByRole('textbox', { name: '操作人备注' }) as HTMLTextAreaElement).value).toBe('server note')
    screen.getByText('远端负责人已变化；本地草稿已保留，请刷新任务后重新核对。')

    const save = screen.getByRole('button', { name: '保存内部元数据' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    await act(async () => { await Promise.resolve() })
    expect(calls.filter(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')).toHaveLength(0)
    expect((screen.getByRole('textbox', { name: '负责人' }) as HTMLInputElement).value).toBe(' local owner ')
  })

  it('keeps the original metadata CAS version when polling changes only runtime state', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const initial = taskDetail({
      status: 'PREPARING', version: 4, assignee: null,
      execution_status: 'RUNNING', executions: [activeExecution],
    })
    const refreshed = taskDetail({
      status: 'PREPARING', version: 5, assignee: null,
      execution_status: 'RUNNING', executions: [activeExecution],
    })
    const calls: Array<{ input: string; init?: RequestInit }> = []
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      calls.push({ input, init })
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/tasks/12' && init?.method === 'PATCH') return response({ detail: 'task changed; refresh and retry' }, 409)
      if (input === '/api/tasks/12') {
        taskReads += 1
        return response(taskReads === 1 ? initial : refreshed)
      }
      if (input === '/api/merchants/1') return response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' })
      return response([])
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: '负责人' })).toBeTruthy())
    const assignee = screen.getByRole('textbox', { name: '负责人' })
    fireEvent.change(assignee, { target: { value: ' local owner ' } })
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    screen.getByText('Task version 5')
    expect(screen.queryByText(/远端负责人已变化/)).toBeNull()

    const save = screen.getByRole('button', { name: '保存内部元数据' }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    screen.getByText('任务已变更，请刷新后再操作。')
    const patchCall = calls.find(call => call.input === '/api/tasks/12' && call.init?.method === 'PATCH')
    expect(JSON.parse(String(patchCall?.init?.body))).toEqual({ expected_version: 4, assignee: 'local owner' })
    expect((assignee as HTMLInputElement).value).toBe(' local owner ')
  })

  it('invalidates an in-flight poll before accepting a metadata mutation readback', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const activeExecution = taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })
    const initial = taskDetail({
      status: 'PREPARING', version: 4, assignee: 'server-owner', execution_status: 'RUNNING', executions: [activeExecution],
    })
    const updated = taskDetail({
      status: 'PREPARING', version: 5, assignee: 'local-owner', execution_status: 'RUNNING', executions: [activeExecution],
    })
    const stalePoll = deferred<ReturnType<typeof response>>()
    let taskReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/merchants/1') return Promise.resolve(response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
      if (input === '/api/tasks/12' && init?.method === 'PATCH') return Promise.resolve(response(taskSummary(updated)))
      if (input === '/api/tasks/12') {
        taskReads += 1
        if (taskReads === 1) return Promise.resolve(response(initial))
        if (taskReads === 2) return stalePoll.promise
        return Promise.resolve(response(updated))
      }
      return Promise.resolve(response([]))
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByRole('textbox', { name: '负责人' })).toBeTruthy())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(taskReads).toBe(2)
    fireEvent.change(screen.getByRole('textbox', { name: '负责人' }), { target: { value: 'local-owner' } })
    fireEvent.click(screen.getByRole('button', { name: '保存内部元数据' }))
    await vi.waitFor(() => expect(screen.getByText('Task version 5')).toBeTruthy())

    stalePoll.resolve(response(initial))
    await act(async () => { await Promise.resolve() })
    screen.getByText('Task version 5')
    expect((screen.getByRole('textbox', { name: '负责人' }) as HTMLInputElement).value).toBe('local-owner')
  })

  it('ignores a deferred poll response from a task route that is no longer active', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/tasks/12')
    const stalePoll = deferred<ReturnType<typeof response>>()
    let taskTwelveReads = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/auth/me') return Promise.resolve(response({ username: 'test', role: 'operator' }))
      if (input === '/api/tasks/12') {
        taskTwelveReads += 1
        if (taskTwelveReads === 1) {
          return Promise.resolve(response(taskDetail({ status: 'PREPARING', execution_status: 'RUNNING', executions: [taskExecution({ status: 'RUNNING', result: null, result_checksum: null, evidence: [], preparation_trust: 'UNTRUSTED', finished_at: null })] })))
        }
        return stalePoll.promise
      }
      if (input === '/api/tasks/13') return Promise.resolve(response(taskDetail({ id: 13, task_key: 'current', title: 'Current task' })))
      if (input === '/api/merchants/1') return Promise.resolve(response({ id: 1, name: 'Only Bear', status: 'active', notes: null, primary_location: null, website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }))
      return Promise.resolve(response([]))
    }))
    render(<App />)

    await vi.waitFor(() => expect(screen.getByText('准备中')).toBeTruthy())
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(taskTwelveReads).toBe(2)

    act(() => {
      window.history.pushState({}, '', '/tasks/13')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    screen.getByRole('heading', { name: 'Current task' })

    stalePoll.resolve(response(taskDetail({ title: 'Stale polled task' })))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('heading', { name: 'Stale polled task' })).toBeNull()
    screen.getByRole('heading', { name: 'Current task' })
  })

  it('retries a failed server-filtered task query without inventing a local fallback', async () => {
    window.history.pushState({}, '', '/tasks')
    let attempts = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input.startsWith('/api/tasks')) {
        attempts += 1
        return attempts === 1 ? response({ detail: 'task query unavailable' }, 503) : response([taskSummary()])
      }
      return response([])
    }))
    render(<App />)

    await screen.findByText('task query unavailable')
    fireEvent.click(screen.getByRole('button', { name: '重试查询' }))
    await screen.findByRole('link', { name: '查看任务：Review content' })
    expect(attempts).toBe(2)
  })
})

describe('关键词版本 controls', () => {
  const activeState = (overrides: Record<string, unknown> = {}) => ({
    merchant_id: 3,
    cycle_status: 'ready',
    active_stage: null,
    keyword_set_artifact_id: 41,
    active_keyword_artifact_id: 41,
    active_keyword_source: 'SKILL',
    active_keyword_activated_at: '2026-09-03T00:00:00Z',
    keyword_versions: [
      { artifact_id: 41, place_id: 'place-3', source: 'SKILL', activation_eligible: true, generation_method: 'EVIDENCE_BOUNDED_RESEARCH', keyword_count: 16, local_keyword_count: 10, organic_keyword_count: 6, scored_keyword_count: 16, score_status: 'VERIFIED_SKILL', completed_at: '2026-09-03T00:00:00Z', is_active: true },
      { artifact_id: 32, place_id: 'place-3', source: 'SKILL', activation_eligible: true, generation_method: 'EVIDENCE_BOUNDED_RESEARCH', keyword_count: 12, local_keyword_count: 8, organic_keyword_count: 4, scored_keyword_count: 12, score_status: 'VERIFIED_SKILL', completed_at: '2026-09-02T00:00:00Z', is_active: false },
      { artifact_id: 99, place_id: 'place-3', source: 'FBR', activation_eligible: true, generation_method: 'PERSISTED_FBR_READBACK', keyword_count: 101, local_keyword_count: 71, organic_keyword_count: 30, scored_keyword_count: 0, score_status: 'UNSCORED', completed_at: '2026-09-03T00:01:00Z', is_active: false },
    ],
    latest_fbr_import: {
      artifact_id: 99,
      imported_at: '2026-09-03T00:01:00Z',
      is_active: false,
      comparison: {
        active_local_count: 10,
        fbr_local_count: 71,
        added_count: 63,
        removed_count: 2,
        priority_changed_count: 4,
        target_surfaces_changed_count: 5,
        added_keywords: ['candidate one'],
        removed_keywords: ['active one'],
        changed_keywords: [{ keyword: 'shared keyword', priority: { active: 'P2', fbr: 'P0' }, target_surfaces: { active: ['GBP'], fbr: ['GBP', 'LANDING_PAGE'] } }],
      },
    },
    keyword_set: {
      schema_version: 'seo_ops.keyword_set.v2', merchant_id: '3',
      market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Brooklyn' },
      generation_method: 'EVIDENCE_BOUNDED_RESEARCH', title: 'Active Skill', summary: 'Active local truth.',
      keywords: [{ keyword: 'active local truth', strategy: 'LOCAL', intent: 'LOCAL', priority: 'P0', score: 95, score_rank: 1, local_falcon_selected: true, rationale: 'active', source_tags: ['SKILL'], target_surface_types: ['GBP'], target_location: 'Brooklyn' }],
      evidence_gaps: [],
    },
    audit_report: null, ranking_report: null,
    local_falcon: { current_place_id: 'place-3', status: 'not_synced', last_synced_at: null, last_error: null, missing_keywords: [], reports: [] },
    capabilities: { can_regenerate: true, can_sync_local_falcon: false, can_approve_local_falcon: false, can_generate_local_falcon: false },
    error: null,
    ...overrides,
  })

  const profile = {
    merchant_id: 3, state: 'synced', fbr_merchant_id: 'fbr-3', sync_status: 'synced', last_synced_at: '2026-09-03T00:00:00Z', last_error: null,
    locations: [{ gbp_location_id: 'locations/3', place_id: 'place-3', title: 'Version Store', address: 'Brooklyn, NY', additional_phones: [], address_lines: [], additional_categories: [], regular_hours: [], menu_sections: [], menu_items: [], recent_posts: [], recent_reviews: [], performance_metrics: [], search_keywords: [], synced_at: '2026-09-03T00:00:00Z' }],
  }

  const renderWithState = (state: Record<string, unknown>, onActivate?: (body: string) => { ok: boolean; status: number; data: unknown }) => {
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const body = String(init?.body || '')
      if (input === '/api/merchants/3/seo-targets/activations' && init?.method === 'POST' && onActivate) {
        const response = onActivate(body)
        return { ok: response.ok, status: response.status, statusText: response.ok ? 'OK' : 'Conflict', json: async () => response.data }
      }
      return {
        ok: true, status: 200,
        json: async () => input === '/api/merchants/3/seo-targets' ? state
          : input === '/api/merchants/3/profile' ? profile
            : input === '/api/merchants/3' ? { id: 3, name: 'Version Store', primary_location: 'Brooklyn, NY', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
              : { username: 'test', role: 'operator' },
      }
    }))
    render(<App />)
  }

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders separate active Skill and latest FBR Local labels', async () => {
    renderWithState(activeState())
    await screen.findByText('SEO Ops 当前版本 · Skill · 16 个关键词（Local 10 / Organic 6）· 评分已验证')
    screen.getByText('最新 FBR Local 导入 · 101 个关键词 · 未采用')
    screen.getByText('active local truth')
  })

  it('keeps a ready activation conflict visible to the operator', async () => {
    renderWithState(activeState({
      cycle_status: 'ready',
      error: 'keyword activation conflict: active version changed while Skill generation was running',
    }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('关键词版本激活冲突')
    expect(alert.textContent).toContain('active version changed')
  })

  it('labels an adopted scored FBR version without claiming Skill verification', async () => {
    const scoredFbrVersion = {
      artifact_id: 98,
      place_id: 'place-3',
      source: 'FBR',
      activation_eligible: true,
      generation_method: 'PERSISTED_FBR_READBACK',
      keyword_count: 1,
      local_keyword_count: 1,
      organic_keyword_count: 0,
      scored_keyword_count: 1,
      score_status: 'SCORED_UNVERIFIED',
      completed_at: '2026-09-03T00:04:00Z',
      is_active: true,
    }
    renderWithState(activeState({
      active_keyword_artifact_id: 98,
      keyword_set_artifact_id: 98,
      active_keyword_source: 'FBR',
      keyword_versions: [scoredFbrVersion],
      latest_fbr_import: null,
      keyword_set: {
        schema_version: 'seo_ops.keyword_set.v2', merchant_id: '3',
        market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Brooklyn' },
        generation_method: 'PERSISTED_FBR_READBACK', title: 'Scored FBR', summary: 'Imported FBR scores.',
        keywords: [{ keyword: 'fbr scored keyword', strategy: 'LOCAL', intent: 'LOCAL', priority: 'P0', score: 88, score_rank: 1, local_falcon_selected: true, rationale: 'FBR', source_tags: ['FBR_KEYWORD_STORE'], target_surface_types: ['GBP'], target_location: 'Brooklyn' }],
        evidence_gaps: [],
      },
    }))

    await screen.findByText('fbr scored keyword')
    screen.getByRole('columnheader', { name: /FBR 评分 \/ 排名/ })
    expect(screen.queryByRole('columnheader', { name: /Skill 评分/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '说明：关键词评分' }))
    screen.getByText(/评分来自当前采用的 FBR 关键词版本，尚未通过 Skill 来源验证/)
  })

  it('explains that page load reads the active local keyword version', async () => {
    renderWithState(activeState())
    await screen.findByText('active local truth')

    fireEvent.click(screen.getByRole('button', { name: '说明：目标关键词' }))

    screen.getByText(/页面加载读取 SEO Ops 当前采用的本地关键词版本/)
    screen.getByText(/FBR 只在运营人员明确点击“从 FBR 重新读取”时导入候选版本/)
  })

  it('renders API comparison counts without recomputing truncated details', async () => {
    renderWithState(activeState())
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    const comparison = screen.getByRole('region', { name: '最新 FBR Local 对比' })
    within(comparison).getByText('当前 Local 10')
    within(comparison).getByText('FBR Local 71')
    within(comparison).getByText('新增 63')
    within(comparison).getByText('移除 2')
    within(comparison).getByText('优先级变化 4')
    within(comparison).getByText('落地页变化 5')
    within(comparison).getByText('candidate one')
    within(comparison).getByText('active one')
    within(comparison).getByText('shared keyword')
  })

  it('offers Skill restore and FBR adoption only for inactive versions', async () => {
    renderWithState(activeState())
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    screen.getByRole('button', { name: '恢复这个 Skill 版本' })
    screen.getByRole('button', { name: '采用这个 FBR 版本' })
    expect(within(screen.getByText(/#41/).closest('li') as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('does not offer adoption when the server marks an FBR-looking version ineligible', async () => {
    renderWithState(activeState({
      keyword_versions: [
        activeState().keyword_versions[0],
        {
          ...activeState().keyword_versions[2],
          artifact_id: 100,
          source: 'FBR',
          activation_eligible: false,
          is_active: false,
        },
      ],
      latest_fbr_import: null,
    }))
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))

    expect(within(screen.getByText(/#100/).closest('li') as HTMLElement).queryByRole('button')).toBeNull()
  })

  it('renders partial and unverified score states and restores only verified Skill versions', async () => {
    renderWithState(activeState({
      keyword_versions: [
        ...activeState().keyword_versions,
        { artifact_id: 52, place_id: 'place-3', source: 'LEGACY', activation_eligible: false, generation_method: 'UPSTREAM_DETERMINISTIC_ADAPTER', keyword_count: 2, local_keyword_count: 1, organic_keyword_count: 1, scored_keyword_count: 1, score_status: 'PARTIAL', completed_at: '2026-09-03T00:02:00Z', is_active: false },
        { artifact_id: 53, place_id: 'place-3', source: 'LEGACY', activation_eligible: false, generation_method: 'UPSTREAM_DETERMINISTIC_ADAPTER', keyword_count: 2, local_keyword_count: 1, organic_keyword_count: 1, scored_keyword_count: 2, score_status: 'SCORED_UNVERIFIED', completed_at: '2026-09-03T00:03:00Z', is_active: false },
      ],
    }))
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))

    within(screen.getByText(/#52/).closest('li') as HTMLElement).getByText(/部分评分/)
    within(screen.getByText(/#53/).closest('li') as HTMLElement).getByText(/已评分，来源未验证/)
    expect(screen.getAllByRole('button', { name: '恢复这个 Skill 版本' })).toHaveLength(1)
  })

  it('renders the active partial score status accurately', async () => {
    const partial = { artifact_id: 52, place_id: 'place-3', source: 'LEGACY', activation_eligible: false, generation_method: 'UPSTREAM_DETERMINISTIC_ADAPTER', keyword_count: 2, local_keyword_count: 1, organic_keyword_count: 1, scored_keyword_count: 1, score_status: 'PARTIAL', completed_at: '2026-09-03T00:02:00Z', is_active: true }
    renderWithState(activeState({
      active_keyword_artifact_id: 52,
      keyword_set_artifact_id: 52,
      keyword_versions: [partial],
    }))

    await screen.findByText('SEO Ops 当前版本 · 历史 · 2 个关键词（Local 1 / Organic 1）· 部分评分')
  })

  it('waits for explicit confirmation before adopting an unscored FBR version', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
      ok: true, status: 200,
      json: async () => input === '/api/merchants/3/seo-targets/activations' ? activeState({ active_keyword_artifact_id: 99, active_keyword_source: 'FBR' })
        : input === '/api/merchants/3/seo-targets' ? activeState()
          : input === '/api/merchants/3/profile' ? profile
            : input === '/api/merchants/3' ? { id: 3, name: 'Version Store', primary_location: 'Brooklyn, NY', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
              : { username: 'test', role: 'operator' },
    }))
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    fireEvent.click(screen.getByRole('button', { name: '采用这个 FBR 版本' }))
    const dialog = screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })
    within(dialog).getByText('采用未评分的 FBR 版本会停用 Local Falcon Top 20，直到恢复或重新生成已评分的 Skill 版本。')
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/merchants/3/seo-targets/activations' && (init as RequestInit).method === 'POST')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/merchants/3/seo-targets/activations' && (init as RequestInit).method === 'POST')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '采用这个 FBR 版本' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })).getByRole('button', { name: '确认采用 FBR 版本' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/merchants/3/seo-targets/activations', expect.objectContaining({ body: JSON.stringify({ artifact_id: 99, expected_active_artifact_id: 41, confirmed: true }) })))
  })

  it('keeps Local Falcon eligibility for a fully scored trusted FBR version', async () => {
    const scoredFbr = { artifact_id: 98, place_id: 'place-3', source: 'FBR', activation_eligible: true, generation_method: 'PERSISTED_FBR_READBACK', keyword_count: 10, local_keyword_count: 10, organic_keyword_count: 0, scored_keyword_count: 10, score_status: 'SCORED_UNVERIFIED', completed_at: '2026-09-03T00:04:00Z', is_active: false }
    renderWithState(activeState({
      keyword_versions: [activeState().keyword_versions[0], scoredFbr],
      latest_fbr_import: {
        ...activeState().latest_fbr_import,
        artifact_id: 98,
      },
    }))
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    fireEvent.click(screen.getByRole('button', { name: '采用这个 FBR 版本' }))

    const dialog = screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })
    const eligibility = within(dialog).getByText('该 FBR 版本已有完整评分；虽非 Skill 验证评分，采用后仍可继续使用 Local Falcon Top 20。')
    expect(eligibility.className).toBe('muted')
    expect(within(dialog).queryByText(/会停用 Local Falcon Top 20/)).toBeNull()
  })

  it('uses server active ID over stale version flags after a successful FBR adoption', async () => {
    const activatedState = activeState({
      active_keyword_artifact_id: 99,
      active_keyword_source: 'FBR',
      keyword_set_artifact_id: 99,
      keyword_set: {
        schema_version: 'seo_ops.keyword_set.v2', merchant_id: '3',
        market: { country_code: 'US', language: 'en-US', search_engine: 'GOOGLE', location_name: 'Brooklyn' },
        generation_method: 'PERSISTED_FBR_READBACK', title: 'Activated FBR', summary: 'Server active FBR truth.',
        keywords: [{ keyword: 'fbr activated keyword', strategy: 'LOCAL', intent: 'LOCAL', priority: 'UNSCORED', score: null, score_rank: null, rationale: 'FBR', source_tags: ['FBR'], target_surface_types: ['GBP'], target_location: 'Brooklyn' }], evidence_gaps: [],
      },
      // The API metadata flags are intentionally stale: artifact 41 is still marked active.
      keyword_versions: activeState().keyword_versions,
    })
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
      ok: true, status: 200,
      json: async () => input === '/api/merchants/3/seo-targets/activations' ? activatedState
        : input === '/api/merchants/3/seo-targets' ? activeState()
          : input === '/api/merchants/3/profile' ? profile
            : input === '/api/merchants/3' ? { id: 3, name: 'Version Store', primary_location: 'Brooklyn, NY', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
              : { username: 'test', role: 'operator' },
    }))
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    fireEvent.click(screen.getByRole('button', { name: '采用这个 FBR 版本' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })).getByRole('button', { name: '确认采用 FBR 版本' }))
    await screen.findByText('fbr activated keyword')
    screen.getByText(/FBR Local · #99 · 当前版本/)
    expect(screen.queryByText('active local truth')).toBeNull()
  })

  it('reads back server truth once after a stale activation conflict', async () => {
    const serverTruth = activeState({ active_keyword_artifact_id: 32, active_keyword_source: 'SKILL', keyword_set_artifact_id: 32, keyword_versions: activeState().keyword_versions.map((version: { artifact_id: number }) => ({ ...version, is_active: version.artifact_id === 32 })) })
    let seoReads = 0
    window.history.pushState({}, '', '/merchants/3/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      if (input === '/api/merchants/3/seo-targets') { seoReads += 1; return { ok: true, status: 200, json: async () => seoReads === 1 ? activeState() : serverTruth } }
      if (input === '/api/merchants/3/seo-targets/activations') return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({ detail: '版本已被其他操作更新' }) }
      return { ok: true, status: 200, json: async () => input === '/api/merchants/3/profile' ? profile : input === '/api/merchants/3' ? { id: 3, name: 'Version Store', primary_location: 'Brooklyn, NY', status: 'active', notes: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' } : { username: 'test', role: 'operator' } }
    }))
    render(<App />)
    await screen.findByRole('button', { name: '查看版本' })
    fireEvent.click(screen.getByRole('button', { name: '查看版本' }))
    fireEvent.click(screen.getByRole('button', { name: '采用这个 FBR 版本' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })).getByRole('button', { name: '确认采用 FBR 版本' }))
    await screen.findByRole('alert')
    expect(seoReads).toBe(2)
    screen.getByText(/#32.*当前版本/)
    const dialog = screen.getByRole('dialog', { name: '确认采用 FBR 关键词版本' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认采用 FBR 版本' }))
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === '/api/merchants/3/seo-targets/activations')).toHaveLength(2))
    const activationBodies = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === '/api/merchants/3/seo-targets/activations')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
    expect(activationBodies).toEqual([
      { artifact_id: 99, expected_active_artifact_id: 41, confirmed: true },
      { artifact_id: 99, expected_active_artifact_id: 41, confirmed: true },
    ])
  })
})

describe('Performance 数据看板', () => {
  const dashboard = {
    window: {
      label: '2026-08-01 至 2026-08-31',
      start: '2026-08-01',
      end: '2026-08-31',
      historical_comparison_available: false as const,
    },
    coverage: {
      active_merchants: 3,
      merchants_with_performance: 2,
      locations_with_performance: 4,
      latest_synced_at: '2026-09-02T08:30:00Z',
    },
    totals: {
      total_views: { value: 12345, merchant_coverage: 2 },
      map_views: { value: 4567, merchant_coverage: 2 },
      search_views: { value: 7778, merchant_coverage: 2 },
      website_clicks: { value: null, merchant_coverage: 1 },
      direction_requests: { value: 88, merchant_coverage: 2 },
      call_clicks: { value: null, merchant_coverage: 1 },
      action_events: { value: null, merchant_coverage: 1 },
    },
    trends: [{ metric_date: '2026-08-01', map_views: 44, search_views: 80, merchant_coverage: 2 }],
    merchants: [{
      merchant_id: 7,
      name: 'Only Bear Chicken & Boba',
      primary_location: 'Mineola, NY',
      data_status: 'ready' as const,
      synced_at: '2026-09-02T08:30:00Z',
      location_count: 2,
      total_views: 12345,
      map_views: 4567,
      search_views: 7778,
      website_clicks: null,
      direction_requests: 88,
      call_clicks: null,
      review_average_rating: null,
      review_reply_rate: null,
      review_scope: null,
    }],
  }

  beforeEach(() => {
    window.history.pushState({}, '', '/dashboard')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? dashboard
        : { username: 'test', role: 'operator' },
    })))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('places the current dashboard link first in primary navigation', async () => {
    render(<App />)

    const primaryNav = await screen.findByRole('navigation', { name: '主要功能' })
    expect(within(primaryNav).getAllByRole('link').map(link => link.textContent)).toEqual(['看板', '商户', '任务', 'Agent'])
    const dashboardLink = within(primaryNav).getByRole('link', { name: '看板' })
    expect(dashboardLink.getAttribute('aria-current')).toBe('page')
    const workspaceBar = document.querySelector('.workspace-bar')
    expect(workspaceBar).not.toBeNull()
    expect(within(workspaceBar as HTMLElement).queryByRole('link', { name: /看板/ })).toBeNull()
    await screen.findByRole('main', { name: '数据看板' })
    expect(screen.getAllByText('12,345')).toHaveLength(2)
    expect(screen.getAllByText('覆盖 2 家')).toHaveLength(3)
    screen.getByText('N/A')
    screen.getByText('已记录行动事件')
    screen.getByText('数据来自最近一次成功同步的 FBR/GBP 快照；行动为事件次数，不代表人数、到店、订单或转化；当前仅展示已同步快照，不提供跨期比较')
  })

  it('preserves missing values and lets operators drill into GBP performance', async () => {
    render(<App />)

    const merchantLink = await screen.findByRole('link', { name: 'Only Bear Chicken & Boba' })
    expect(merchantLink.getAttribute('href')).toBe('/merchants/7/profile#gbp-performance')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    screen.getByText('评分 — / 回复率 —')
  })

  it('shows a directionally clear empty trend state without inventing zeros', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? { ...dashboard, trends: [], merchants: [{ ...dashboard.merchants[0], data_status: 'no_performance' as const, total_views: null }] }
        : { username: 'test', role: 'operator' },
    })))
    render(<App />)

    await screen.findByText('当前窗口没有可展示的搜索或地图日趋势；请等待下一次成功同步。')
    expect(screen.getAllByText('无绩效数据')).toHaveLength(2)
  })

  it('formats fractional review reply rates and whole-number ratings for the merchant ledger', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? { ...dashboard, merchants: [{ ...dashboard.merchants[0], location_count: 1, review_average_rating: 4, review_reply_rate: 0.94, review_scope: 'all_synced' }] }
        : { username: 'test', role: 'operator' },
    })))
    render(<App />)

    await screen.findByText('评分 4.0 / 回复率 94%')
  })

  it('uses calendar time, breaks lines across missing days, shades calendar weekends, and exposes a data table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? { ...dashboard, trends: [
            { metric_date: '2026-08-03', map_views: 44, search_views: 80, merchant_coverage: 2 },
            { metric_date: '2026-08-04', map_views: 32, search_views: 58, merchant_coverage: 2 },
            { metric_date: '2026-08-10', map_views: 61, search_views: 92, merchant_coverage: 2 },
          ] }
        : { username: 'test', role: 'operator' },
    })))
    render(<App />)

    await screen.findByRole('heading', { name: '搜索+地图曝光量 · 逐日趋势' })
    const metricChoices = await screen.findByRole('group', { name: '趋势指标' })
    expect(within(metricChoices).getByRole('button', { name: '总曝光' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(metricChoices).getByRole('button', { name: 'Google搜索' }).getAttribute('aria-pressed')).toBe('false')
    expect(within(metricChoices).getByRole('button', { name: 'Google地图' }).getAttribute('aria-pressed')).toBe('false')
    const chart = await screen.findByRole('img', { name: /总曝光逐日趋势/ })
    expect(chart.getAttribute('viewBox')).toBe('0 0 1040 260')
    const points = [...chart.querySelectorAll('circle')]
    expect(points).toHaveLength(3)
    const firstGap = Number(points[1].getAttribute('cx')) - Number(points[0].getAttribute('cx'))
    const missingDayGap = Number(points[2].getAttribute('cx')) - Number(points[1].getAttribute('cx'))
    expect(missingDayGap / firstGap).toBeCloseTo(6, 4)
    const line = chart.querySelector('.dashboard-chart-line')
    expect(line?.tagName.toLowerCase()).toBe('path')
    expect(line?.getAttribute('d')?.match(/M/g)).toHaveLength(2)
    expect(chart.querySelectorAll('.dashboard-chart-grid')).toHaveLength(4)
    expect(chart.querySelectorAll('.dashboard-chart-weekend')).toHaveLength(2)
    expect([...chart.querySelectorAll('text')].map(label => label.textContent)).toEqual(expect.arrayContaining(['8/3', '8/10', '0']))
    expect(chart.querySelector('.dashboard-chart-comparison-divider')).toBeNull()
    const dataTable = await screen.findByRole('table', { name: '总曝光趋势数据' })
    expect(within(dataTable).getAllByRole('row')).toHaveLength(4)
    expect(within(dataTable).getByRole('columnheader', { name: '日期' })).toBeTruthy()
    expect(within(dataTable).getByRole('columnheader', { name: '总曝光' })).toBeTruthy()
    expect(within(dataTable).getByRole('columnheader', { name: '可比覆盖' })).toBeTruthy()
    expect(within(dataTable).getByRole('row', { name: '2026-08-10 153 2 家' })).toBeTruthy()
    await screen.findByText('横轴为实际日期，灰色背景为周末；缺失日期不补零，折线断开。')
    await screen.findByText('当前仅展示一次同步快照内的逐日值，不提供跨期比较。')
  })

  it('switches the selected single-line metric and updates its accessible daily values', async () => {
    render(<App />)

    const metricChoices = await screen.findByRole('group', { name: '趋势指标' })
    fireEvent.click(within(metricChoices).getByRole('button', { name: 'Google搜索' }))
    expect(within(metricChoices).getByRole('button', { name: 'Google搜索' }).getAttribute('aria-pressed')).toBe('true')
    await screen.findByRole('img', { name: /Google搜索逐日趋势/ })
    const searchTable = await screen.findByRole('table', { name: 'Google搜索趋势数据' })
    within(searchTable).getByRole('row', { name: '2026-08-01 80 2 家' })

    fireEvent.click(within(metricChoices).getByRole('button', { name: 'Google地图' }))
    expect(within(metricChoices).getByRole('button', { name: 'Google地图' }).getAttribute('aria-pressed')).toBe('true')
    await screen.findByRole('img', { name: /Google地图逐日趋势/ })
    const mapTable = await screen.findByRole('table', { name: 'Google地图趋势数据' })
    within(mapTable).getByRole('row', { name: '2026-08-01 44 2 家' })
  })

  it('warns when daily comparable coverage changes across the trend', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? { ...dashboard, trends: [
            { metric_date: '2026-08-01', map_views: 44, search_views: 80, merchant_coverage: 1 },
            { metric_date: '2026-08-02', map_views: 50, search_views: 84, merchant_coverage: 2 },
          ] }
        : { username: 'test', role: 'operator' },
    })))
    render(<App />)

    await screen.findByText('每日覆盖 1–2 家，总量不可直接作同口径比较')
  })

  it('clicking a dashboard merchant focuses its loaded GBP performance section', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/dashboard/performance'
        ? dashboard
        : input === '/api/merchants/7'
          ? { id: 7, name: 'Only Bear Chicken & Boba', status: 'active', notes: null, primary_location: 'Mineola, NY', website_url: null, auto_run_interval_days: null, created_at: '2026-09-01T00:00:00Z' }
          : input === '/api/merchants/7/profile'
            ? {
                merchant_id: 7, state: 'synced', fbr_merchant_id: 'fbr-only-bear', sync_status: 'synced', last_synced_at: '2026-09-02T08:30:00Z', last_error: null,
                locations: [{
                  gbp_location_id: 'locations/only-bear', google_account_id: null, name: 'locations/only-bear', place_id: null, title: 'Only Bear Chicken & Boba', store_code: null, language_code: null, phone: null, additional_phones: [], address: 'Mineola, NY', address_lines: [], locality: null, administrative_area: null, postal_code: null, region_code: 'US', website_url: null, primary_category: null, additional_categories: [], open_status: null, description: null, regular_hours: [], attribute_count: null, menu_count: null, menu_section_count: null, menu_item_count: null, menu_sections: [], menu_items: [], post_count: null, live_post_count: null, recent_posts: [], review_count: null, review_sync_status: 'unavailable', review_scope: null, review_average_rating: null, review_reply_rate: null, recent_reviews: [], media_count: null, customer_media_count: null, question_count: null, place_action_link_count: null, verification_count: null, performance_metrics: [], search_keywords: [], source_updated_at: null, synced_at: '2026-09-02T08:30:00Z',
                }],
              }
            : input === '/api/merchants/7/seo-targets'
              ? { merchant_id: 7, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
              : { username: 'test', role: 'operator' },
    })))
    render(<App />)

    fireEvent.click(await screen.findByRole('link', { name: 'Only Bear Chicken & Boba' }))
    const performance = await screen.findByRole('region', { name: 'GBP 表现与真实搜索词' })
    expect(document.activeElement).toBe(performance)
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
    window.history.pushState({}, '', '/merchants/7/profile#gbp-reviews')
    fireEvent.popState(window)
    window.history.pushState({}, '', '/merchants/7/profile#gbp-performance')
    fireEvent.popState(window)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2))
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  })
})

describe('Agent Workbench route', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('agents navigation and direct route', async () => {
    window.history.pushState({}, '', '/agents')
    const fetcher = vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/agent-workbench?range=30d'
          ? {
              snapshot_at: '2026-09-06T01:00:00.000Z', last_complete_discovery_at: null, sync_health: 'not_configured', stale: true,
              current_state_complete: null, current_state_checked_at: null, current_state_incomplete_statuses: [], fresh_until: null,
              has_active_runs: null, has_queued_runs: null, has_waiting_runs: null,
              current_counts: {
                running: { value: null, quality: 'unknown', last_observed_value: null, last_observed_at: null },
                queued: { value: null, quality: 'unknown', last_observed_value: null, last_observed_at: null },
                waiting: { value: null, quality: 'unknown', last_observed_value: null, last_observed_at: null },
                legacy_nonterminal: { value: null, quality: 'unknown', last_observed_value: null, last_observed_at: null },
              },
              refresh_after_ms: 30000, range: '30d', timezone: 'Asia/Shanghai', range_start: null, range_end: '2026-09-06T01:00:00.000Z', metrics_complete_for_range: true,
              coverage: { mirrored_run_count: 0, remote_total_runs: 0, history_complete: true, range_complete: true, coverage_start_at: null, coverage_as_of: null },
              summary: { run_count: 0, terminal_runs: 0, successful_runs: 0, success_rate: null, known_input_tokens: 0, known_output_tokens: 0, known_total_tokens: 0, token_known_runs: 0, token_eligible_runs: 0 },
              signals: [], agents: [], sync_warnings: [],
            }
          : [],
    }))
    vi.stubGlobal('fetch', fetcher)
    render(<App />)

    const link = await screen.findByRole('link', { name: 'Agent' })
    expect(link.getAttribute('aria-current')).toBe('page')
    await screen.findByRole('heading', { name: 'Agent 工作台' })
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/auth/me', '/api/agent-workbench?range=30d'])
  })

  it('keeps shell navigation and logout inside the single inert application root', async () => {
    window.history.pushState({}, '', '/agents')
    const agent = {
      id: 'agent-active', agent_key: 'active', coreai_agent_id: 'core-active', display_name: 'Active Agent', role: 'SEO', sort_order: 1,
      lifecycle_status: 'active', coreai_metadata: { name: null, model: null, timeout_hint_seconds: null, last_verified_at: null, verification_error: null },
      suspect_after_seconds: 120, sync_pending: false,
      sync: { health: 'fresh', last_discovery_attempt_at: null, last_discovery_success_at: null, discovery_error: null, current_state_checked_at: null, current_state_error: null, next_discovery_at: null, last_fast_poll_attempt_at: null, last_fast_poll_success_at: null, fast_poll_error: null },
      current_state_complete: true,
      current_counts: {
        running: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
        queued: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
        waiting: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
      },
      range_metrics: { run_count: 0, terminal_runs: 0, successful_runs: 0, success_rate: null, known_input_tokens: 0, known_output_tokens: 0, known_total_tokens: 0, token_known_runs: 0, token_eligible_runs: 0 },
      coverage: { mirrored_run_count: 0, remote_total_runs: 0, history_complete: true, range_complete: true, coverage_start_at: null, coverage_as_of: null },
      last_terminal_run: null, warnings: [],
    }
    const snapshot = {
      snapshot_at: '2026-09-06T01:00:00.000Z', last_complete_discovery_at: null, sync_health: 'fresh', stale: false,
      current_state_complete: true, current_state_checked_at: null, current_state_incomplete_statuses: [], fresh_until: '2026-09-06T01:01:30.000Z',
      has_active_runs: false, has_queued_runs: false, has_waiting_runs: false,
      current_counts: {
        running: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
        queued: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
        waiting: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
        legacy_nonterminal: { value: 0, quality: 'exact', last_observed_value: 0, last_observed_at: null },
      },
      refresh_after_ms: 30000, range: '30d', timezone: 'Asia/Shanghai', range_start: null, range_end: '2026-09-06T01:00:00.000Z', metrics_complete_for_range: true,
      coverage: { mirrored_run_count: 0, remote_total_runs: 0, history_complete: true, range_complete: true, coverage_start_at: null, coverage_as_of: null },
      summary: { run_count: 0, terminal_runs: 0, successful_runs: 0, success_rate: null, known_input_tokens: 0, known_output_tokens: 0, known_total_tokens: 0, token_known_runs: 0, token_eligible_runs: 0 },
      signals: [], agents: [agent], sync_warnings: [],
    }
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me' ? { username: 'test', role: 'operator' } : snapshot,
    })))
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    render(<App />, { container: root })

    const agentLink = await screen.findByRole('link', { name: 'Agent' })
    const logout = screen.getByRole('button', { name: '退出' })
    fireEvent.click(await screen.findByRole('button', { name: '管理 Agent' }))

    expect(root.hasAttribute('inert')).toBe(true)
    expect(root.contains(agentLink)).toBe(true)
    expect(root.contains(logout)).toBe(true)
    expect(root.contains(screen.getByRole('heading', { name: 'Agent 工作台' }))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭 Agent 管理' }))
    root.remove()
  })
})

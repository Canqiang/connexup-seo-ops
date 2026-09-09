// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const activeTask = {
  id: 1,
  merchant_id: 1,
  merchant_name: '在营商户',
  merchant_status: 'active',
  plan_id: 10,
  plan_revision: 1,
  task_key: 'active-task',
  task_type: 'PREPARE_ONLY',
  workflow_version: 1,
  parameters: {},
  definition_checksum: 'a'.repeat(64),
  title: '在营任务',
  description: null,
  rationale: '需要完成',
  expected_outcome: '获得可审结果',
  category: 'gbp',
  scheduled_start: null,
  status: 'PENDING',
  version: 1,
  assignee: null,
  labels: [],
  operator_note: null,
  execution_status: null,
  evidence_note: null,
  source_run_id: null,
  source_key: null,
  replaces_task_id: null,
  replaced_by_task_id: null,
  plan: {
    id: 10,
    source_kind: 'OPERATOR',
    state: 'OPEN',
    latest_revision: 1,
    approved_revision: 1,
  },
  source_plan_approved: true,
  readiness: 'READY',
  blocker: null,
  created_at: '2026-09-02T00:00:00Z',
  updated_at: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
}

const archivedTask = {
  ...activeTask,
  id: 2,
  merchant_id: 2,
  merchant_name: '已归档商户',
  merchant_status: 'archived',
  plan_id: 11,
  task_key: 'archived-task',
  plan: { ...activeTask.plan, id: 11, source_kind: 'AGENT' },
  title: '已冻结任务',
  readiness: 'BLOCKED',
  blocker: { code: 'MERCHANT_ARCHIVED' },
}

const archivedTaskDetail = {
  ...archivedTask,
  upstream: [],
  downstream: [],
  executions: [],
  events: [],
}

function draftPlanForArchivedMerchant() {
  return {
    id: 11,
    merchant_id: 2,
    source_kind: 'AGENT',
    source_run_id: 1,
    state: 'OPEN',
    latest_revision: 1,
    approved_revision: null,
    created_at: '2026-09-01T00:00:00Z',
    closed_at: null,
    current_revision: {
      id: 110,
      plan_id: 11,
      revision: 1,
      decision_state: 'DRAFT',
      schema_version: 'seo_ops.task_plan.v1',
      checksum: 'b'.repeat(64),
      source: 'AGENT',
      created_by: 'agent',
      created_at: '2026-09-01T00:00:00Z',
      decided_by: null,
      decided_at: null,
      decision_reason: null,
      payload: {
        schema_version: 'seo_ops.task_plan.v1',
        tasks: [{
          key: archivedTask.task_key,
          task_type: 'PREPARE_ONLY',
          title: archivedTask.title,
          rationale: archivedTask.rationale,
          expected_outcome: archivedTask.expected_outcome,
          depends_on: [],
          scheduled_start: null,
          parameters: {},
        }],
      },
    },
  }
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
    expect(screen.getAllByText('商户已归档').length).toBeGreaterThanOrEqual(2)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks?include_archived=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('renders an archived merchant task as frozen and removes execution actions', async () => {
    window.history.pushState({}, '', '/tasks/2')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/tasks/2'
          ? archivedTaskDetail
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
    expect((screen.getByRole('textbox', { name: '负责人' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: '操作人备注' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '新增内部标签' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps every task mutation unavailable while merchant status is unresolved', async () => {
    window.history.pushState({}, '', '/tasks/2')
    const unresolvedMerchant = new Promise<never>(() => undefined)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: string) => {
      if (input === '/api/tasks/2') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          ...archivedTaskDetail,
          merchant_status: undefined,
          readiness: 'READY',
          blocker: null,
        }) })
      }
      if (input === '/api/merchants/2') return unresolvedMerchant
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ username: 'test', role: 'operator' }) })
    }))

    render(<App />)

    await screen.findByRole('heading', { name: '已冻结任务' })
    expect(screen.queryByRole('button', { name: '开始内容准备' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消任务并保留历史' })).toBeNull()
    expect((screen.getByRole('textbox', { name: '负责人' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('textbox', { name: '操作人备注' }) as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '新增内部标签' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps an archived merchant history visible without offering destructive deletion', async () => {
    window.history.pushState({}, '', '/merchants/2')
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
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

    await screen.findByText('商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。')
    expect(screen.queryByRole('button', { name: '开始诊断' })).toBeNull()
    expect(screen.queryByRole('button', { name: '＋ 新建任务' })).toBeNull()
    expect(screen.queryByRole('button', { name: '删除商户' })).toBeNull()
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
  })

  it('opens an archived merchant from the ledger without offering deletion', async () => {
    window.history.pushState({}, '', '/')
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
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/merchants?status=archived'
          ? [archivedMerchant]
          : input === '/api/merchants?status=active'
            ? []
            : { username: 'test', role: 'operator' },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByRole('main', { name: '商户台账' })
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    const archivedRow = await screen.findByRole('link', { name: '打开商户 已归档商户' })
    expect(screen.queryByRole('button', { name: '删除商户 已归档商户' })).toBeNull()

    fireEvent.click(archivedRow)

    expect(window.location.pathname).toBe('/merchants/2')
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
  })

  it('offers guarded deletion only for an eligible archived blank draft', async () => {
    window.history.pushState({}, '', '/')
    const archivedMerchant = {
      id: 7,
      name: '误建空白草稿',
      status: 'archived',
      notes: null,
      primary_location: 'Mineola, NY',
      website_url: null,
      auto_run_interval_days: null,
      todo_count: 0,
      doing_count: 0,
      has_running_run: false,
      last_run_at: null,
      last_run_status: null,
      can_delete: true,
      created_at: '2026-09-04T00:00:00Z',
    }
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/merchants/7' && init?.method === 'DELETE') {
        return { ok: true, status: 204, json: async () => undefined }
      }
      return {
        ok: true,
        status: 200,
        json: async () => input === '/api/merchants?status=archived'
          ? [archivedMerchant]
          : input === '/api/merchants?status=active'
            ? []
            : { username: 'test', role: 'operator' },
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '已归档' }))
    const deleteButton = await screen.findByRole('button', { name: '删除商户 误建空白草稿' })
    fireEvent.click(deleteButton)

    const dialog = await screen.findByRole('dialog', { name: '删除空白草稿' })
    within(dialog).getByText('“误建空白草稿”没有任何同步、任务、分析或审计历史。删除空白草稿后无法恢复，确认删除？')
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/merchants/7',
      expect.objectContaining({ method: 'DELETE' }),
    ))
    await waitFor(() => expect(screen.queryByRole('link', { name: '打开商户 误建空白草稿' })).toBeNull())
    expect(window.location.pathname).toBe('/')
  })

  it('relinks FBR only after explicit confirmation with the displayed binding CAS', async () => {
    window.history.pushState({}, '', '/merchants/4/profile')
    let relinked = false
    let relinkBody: Record<string, unknown> | null = null
    const oldHash = 'a'.repeat(64)
    const newHash = 'b'.repeat(64)
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/performance-identities/fbr/relink' && init?.method === 'POST') {
        relinkBody = JSON.parse(String(init.body))
        relinked = true
        return {
          ok: true,
          status: 200,
          json: async () => ({
            request_id: relinkBody?.request_id,
            previous_event_id: 40,
            binding: {
              event_id: 41,
              merchant_id: 4,
              fbr_merchant_id: 'fbr-new',
              canonical_fbr_merchant_sha256: newHash,
              generation: 4,
              valid_from: '2026-09-04T01:00:00.000000Z',
              valid_to: null,
              content_sha256: 'c'.repeat(64),
              close_content_sha256: null,
            },
            projection_binding_event_id: 41,
          }),
        }
      }
      const data = input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/4'
          ? {
              id: 4,
              name: '需要纠正绑定的商户',
              status: 'active',
              notes: null,
              primary_location: 'Mineola, NY',
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-04T00:00:00Z',
            }
          : input === '/api/merchants/4/profile'
            ? {
                merchant_id: 4,
                state: 'synced',
                fbr_merchant_id: relinked ? 'fbr-new' : 'fbr-old',
                binding_generation: relinked ? 4 : 3,
                binding_sha256: relinked ? newHash : oldHash,
                sync_status: relinked ? 'not_synced' : 'synced',
                last_synced_at: relinked ? null : '2026-09-04T00:10:00Z',
                last_error: null,
                locations: [],
              }
            : input === '/api/merchants/4/seo-targets'
              ? { merchant_id: 4, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
              : []
      return { ok: true, status: 200, json: async () => data }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '重新绑定 FBR' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新的 FBR Merchant ID' }), { target: { value: 'fbr-new' } })
    fireEvent.change(screen.getByRole('textbox', { name: '重新绑定原因' }), { target: { value: '已与 FBR 团队核对资源 ID' } })
    const submit = screen.getByRole('button', { name: '确认重新绑定' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是同一商户的正确 FBR 资源，并理解当前 GBP 快照将被清空' }))
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(relinkBody).toEqual(expect.objectContaining({
      merchant_id: 4,
      expected_current_binding_generation: 3,
      expected_current_fbr_sha256: oldHash,
      new_fbr_merchant_id: 'fbr-new',
      reason: '已与 FBR 团队核对资源 ID',
      confirmed: true,
      request_id: expect.stringMatching(/^seo-ops-fbr-relink-4-/),
    })))
    await screen.findByText('Merchant ID · fbr-new')
    expect(screen.queryByRole('form', { name: '重新绑定 FBR Merchant ID' })).toBeNull()
  })

  it('rotates the FBR relink request id after 4xx but retains it across 5xx retries', async () => {
    window.history.pushState({}, '', '/merchants/4/profile')
    const relinkBodies: Array<Record<string, unknown>> = []
    const bindingHash = 'a'.repeat(64)
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/performance-identities/fbr/relink' && init?.method === 'POST') {
        relinkBodies.push(JSON.parse(String(init.body)))
        const rejectedAsDeterministic = relinkBodies.length === 1
        return {
          ok: false,
          status: rejectedAsDeterministic ? 409 : 503,
          statusText: rejectedAsDeterministic ? 'Conflict' : 'Service Unavailable',
          json: async () => ({ detail: rejectedAsDeterministic ? 'merchant_has_active_work' : 'FBR unavailable' }),
        }
      }
      const data = input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/4'
          ? {
              id: 4,
              name: '需要纠正绑定的商户',
              status: 'active',
              notes: null,
              primary_location: 'Mineola, NY',
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-04T00:00:00Z',
            }
          : input === '/api/merchants/4/profile'
            ? {
                merchant_id: 4,
                state: 'synced',
                fbr_merchant_id: 'fbr-old',
                binding_generation: 3,
                binding_sha256: bindingHash,
                sync_status: 'synced',
                last_synced_at: '2026-09-04T00:10:00Z',
                last_error: null,
                locations: [],
              }
            : input === '/api/merchants/4/seo-targets'
              ? { merchant_id: 4, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
              : []
      return { ok: true, status: 200, json: async () => data }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '重新绑定 FBR' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新的 FBR Merchant ID' }), { target: { value: 'fbr-new' } })
    fireEvent.change(screen.getByRole('textbox', { name: '重新绑定原因' }), { target: { value: '已与 FBR 团队核对资源 ID' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是同一商户的正确 FBR 资源，并理解当前 GBP 快照将被清空' }))

    fireEvent.click(screen.getByRole('button', { name: '确认重新绑定' }))
    await screen.findByRole('alert')
    await waitFor(() => expect(relinkBodies).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: '确认重新绑定' }))
    await waitFor(() => expect(relinkBodies).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: '确认重新绑定' }))
    await waitFor(() => expect(relinkBodies).toHaveLength(3))

    expect(relinkBodies[0].request_id).toMatch(/^seo-ops-fbr-relink-4-/)
    expect(relinkBodies[1].request_id).toMatch(/^seo-ops-fbr-relink-4-/)
    expect(relinkBodies[1].request_id).not.toBe(relinkBodies[0].request_id)
    expect(relinkBodies[2].request_id).toBe(relinkBodies[1].request_id)
  })

  it('retains the accepted FBR relink request id when its profile readback fails', async () => {
    window.history.pushState({}, '', '/merchants/4/profile')
    const relinkBodies: Array<Record<string, unknown>> = []
    const bindingHash = 'a'.repeat(64)
    let profileReads = 0
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/performance-identities/fbr/relink' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        relinkBodies.push(body)
        return {
          ok: true,
          status: 200,
          json: async () => ({
            request_id: body.request_id,
            previous_event_id: 40,
            binding: {
              event_id: 41,
              merchant_id: 4,
              fbr_merchant_id: 'fbr-new',
              canonical_fbr_merchant_sha256: 'b'.repeat(64),
              generation: 4,
              valid_from: '2026-09-04T01:00:00.000000Z',
              valid_to: null,
              content_sha256: 'c'.repeat(64),
              close_content_sha256: null,
            },
            projection_binding_event_id: 41,
          }),
        }
      }
      if (input === '/api/merchants/4/profile') {
        profileReads += 1
        if (profileReads > 1) {
          return {
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({ detail: 'profile readback unavailable' }),
          }
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            merchant_id: 4,
            state: 'synced',
            fbr_merchant_id: 'fbr-old',
            binding_generation: 3,
            binding_sha256: bindingHash,
            sync_status: 'synced',
            last_synced_at: '2026-09-04T00:10:00Z',
            last_error: null,
            locations: [],
          }),
        }
      }
      const data = input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/4'
          ? {
              id: 4,
              name: '需要纠正绑定的商户',
              status: 'active',
              notes: null,
              primary_location: 'Mineola, NY',
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-04T00:00:00Z',
            }
          : input === '/api/merchants/4/seo-targets'
            ? { merchant_id: 4, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
            : []
      return { ok: true, status: 200, json: async () => data }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '重新绑定 FBR' }))
    fireEvent.change(screen.getByRole('textbox', { name: '新的 FBR Merchant ID' }), { target: { value: 'fbr-new' } })
    fireEvent.change(screen.getByRole('textbox', { name: '重新绑定原因' }), { target: { value: '已与 FBR 团队核对资源 ID' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是同一商户的正确 FBR 资源，并理解当前 GBP 快照将被清空' }))

    fireEvent.click(screen.getByRole('button', { name: '确认重新绑定' }))
    await waitFor(() => expect(relinkBodies).toHaveLength(1))
    await screen.findByRole('alert')

    fireEvent.click(screen.getByRole('button', { name: '确认重新绑定' }))
    await waitFor(() => expect(relinkBodies).toHaveLength(2))

    expect(relinkBodies[1].request_id).toBe(relinkBodies[0].request_id)
  })

  it('keeps an archived unbound merchant profile read-only', async () => {
    window.history.pushState({}, '', '/merchants/8/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/8'
          ? {
              id: 8,
              name: '已归档未绑定商户',
              status: 'archived',
              notes: null,
              primary_location: null,
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-04T00:00:00Z',
            }
          : input === '/api/merchants/8/profile'
            ? {
                merchant_id: 8,
                state: 'unbound',
                fbr_merchant_id: null,
                binding_generation: null,
                binding_sha256: null,
                sync_status: null,
                last_synced_at: null,
                last_error: null,
                locations: [],
              }
            : input === '/api/merchants/8/seo-targets'
              ? { merchant_id: 8, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
              : [],
    })))

    render(<App />)

    await screen.findByText('商户已归档，恢复在营后可操作。')
    expect(screen.queryByRole('textbox', { name: 'FBR Merchant ID' })).toBeNull()
    expect(screen.queryByRole('button', { name: '保存绑定' })).toBeNull()
  })

  it('keeps archived bound FBR controls read-only', async () => {
    window.history.pushState({}, '', '/merchants/9/profile')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
      ok: true,
      status: 200,
      json: async () => input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/merchants/9'
          ? {
              id: 9,
              name: '已归档已绑定商户',
              status: 'archived',
              notes: null,
              primary_location: null,
              website_url: null,
              auto_run_interval_days: null,
              created_at: '2026-09-04T00:00:00Z',
            }
          : input === '/api/merchants/9/profile'
            ? {
                merchant_id: 9,
                state: 'synced',
                fbr_merchant_id: 'fbr-archived',
                binding_generation: 2,
                binding_sha256: 'c'.repeat(64),
                sync_status: 'synced',
                last_synced_at: '2026-09-04T00:10:00Z',
                last_error: null,
                locations: [],
              }
            : input === '/api/merchants/9/seo-targets'
              ? { merchant_id: 9, cycle_status: 'empty', active_stage: null, keyword_set: null, audit_report: null, ranking_report: null, error: null }
              : [],
    })))

    render(<App />)

    await screen.findByText('商户已归档，恢复在营后可操作。')
    expect(screen.queryByRole('button', { name: '重新绑定 FBR' })).toBeNull()
    expect(screen.queryByRole('button', { name: /同步 GBP 资料|重新同步/ })).toBeNull()
  })

  it('blocks archiving when a known task is running or awaiting review', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const tasks = [
      { ...activeTask, id: 4, title: '进行中任务', status: 'PREPARING' },
      { ...activeTask, id: 5, title: '待审核任务', status: 'AWAITING_APPROVAL', execution_status: 'SUCCEEDED' },
    ]
    const fetchMock = vi.fn().mockImplementation(async (input: string) => {
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

    const archiveButton = await screen.findByRole('button', { name: '归档商户' })

    expect((archiveButton as HTMLButtonElement).disabled).toBe(true)
    await screen.findByText('暂时无法归档：还有 2 个任务正在执行或等待审核。请先完成审核，并等待任务执行结束。')
    fireEvent.click(archiveButton)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchMock.mock.calls.some(([input, init]) => (
      input === '/api/merchants/1' && (init as RequestInit | undefined)?.method === 'PATCH'
    ))).toBe(false)
  })

  it('blocks archiving while a merchant analysis is running', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const fetchMock = vi.fn().mockImplementation(async (input: string) => ({
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
        : input === '/api/merchants/1/runs'
          ? [{
              id: 12,
              merchant_id: 1,
              coreai_run_id: 'run-12',
              status: 'running',
              trigger_kind: 'manual',
              report_text: null,
              error: null,
              plan_approved_at: null,
              created_at: '2026-09-02T00:00:00Z',
              finished_at: null,
            }]
          : [],
    }))
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const archiveButton = await screen.findByRole('button', { name: '归档商户' })

    expect((archiveButton as HTMLButtonElement).disabled).toBe(true)
    await screen.findByText('暂时无法归档：商户分析仍在运行。请等待分析结束后再归档。')
    fireEvent.click(archiveButton)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(fetchMock.mock.calls.some(([input, init]) => (
      input === '/api/merchants/1' && (init as RequestInit | undefined)?.method === 'PATCH'
    ))).toBe(false)
  })

  it('preserves pending work and history when archiving an idle merchant', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const tasks = [activeTask, { ...activeTask, id: 3, title: '第二个待办' }]
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

    const dialog = await screen.findByRole('dialog', { name: '归档商户' })
    within(dialog).getByText('归档会关闭自动分析并停止创建新的执行；2 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“在营商户”？')
    expect(fetchMock.mock.calls.some(([input, init]) => input === '/api/merchants/1' && (init as RequestInit | undefined)?.method === 'PATCH')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/merchants/1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'archived' }),
      }),
    ))
    await screen.findByText('商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。')
    expect(screen.queryByRole('form', { name: '新建任务' })).toBeNull()
  })

  it('surfaces the server conflict when a hidden sync blocks archiving', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/merchants/1' && init?.method === 'PATCH') {
        return {
          ok: false,
          status: 409,
          statusText: 'Conflict',
          json: async () => ({ detail: '仍有正在同步的数据，请等待同步完成后再归档' }),
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
          : [],
      }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    fireEvent.click(await screen.findByRole('button', { name: '归档商户' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: '归档商户' })).getByRole('button', { name: '确认归档' }))

    await screen.findByText('仍有正在同步的数据，请等待同步完成后再归档')
    expect(screen.getByRole('button', { name: '归档商户' })).toBeTruthy()
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
      const plan = {
        id: 11,
        merchant_id: 2,
        source_kind: 'AGENT',
        source_run_id: 1,
        state: 'OPEN',
        latest_revision: 1,
        approved_revision: 1,
        created_at: '2026-09-01T00:00:00Z',
        closed_at: null,
        current_revision: {
          id: 110,
          plan_id: 11,
          revision: 1,
          decision_state: 'APPROVED',
          schema_version: 'seo_ops.task_plan.v1',
          checksum: 'b'.repeat(64),
          source: 'AGENT',
          created_by: 'agent',
          created_at: '2026-09-01T00:00:00Z',
          decided_by: 'test',
          decided_at: '2026-09-01T00:01:00Z',
          decision_reason: null,
          payload: {
            schema_version: 'seo_ops.task_plan.v1',
            tasks: [{
              key: archivedTask.task_key,
              task_type: 'PREPARE_ONLY',
              title: archivedTask.title,
              rationale: archivedTask.rationale,
              expected_outcome: archivedTask.expected_outcome,
              depends_on: [],
              scheduled_start: null,
              parameters: {},
            }],
          },
        },
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
        : input === '/api/runs/1/task-plan'
          ? plan
        : input === '/api/tasks?plan_id=11&include_archived=true'
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
    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks?plan_id=11&include_archived=true',
      expect.objectContaining({ credentials: 'same-origin' }),
    )
  })

  it('keeps a draft Plan read-only when its merchant is archived', async () => {
    window.history.pushState({}, '', '/task-plans/11')
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      const data = input === '/api/auth/me'
        ? { username: 'test', role: 'operator' }
        : input === '/api/task-plans/11'
          ? draftPlanForArchivedMerchant()
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
            : { detail: 'not found' }
      return { ok: true, status: 200, json: async () => data, init }
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    await screen.findByText('商户已归档，Plan 与生成任务仅供查看；恢复在营后可继续审批。')
    expect((screen.getByRole('textbox', { name: '任务标题 archived-task' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '添加 Task' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '批准当前 Plan' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '拒绝整个 Plan' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method && init.method !== 'GET')).toHaveLength(0)
  })
})

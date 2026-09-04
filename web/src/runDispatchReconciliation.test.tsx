// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Run } from './api'

function response<T>(data: T, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : status === 409 ? 'Conflict' : 'OK',
    json: async () => data,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const merchant = {
  id: 1,
  name: 'Dispatch Merchant',
  status: 'active',
  notes: null,
  primary_location: 'Queens, NY',
  website_url: null,
  auto_run_interval_days: null,
  created_at: '2026-09-04T00:00:00Z',
}

const unknownRun: Run = {
  id: 41,
  merchant_id: 1,
  coreai_run_id: null,
  provider_candidate_run_id: 'candidate-run-41',
  dispatch_state: 'UNKNOWN',
  needs_attention: true,
  status: 'running',
  trigger_kind: 'manual',
  report_text: null,
  error: 'COREAI_DISPATCH_OUTCOME_UNKNOWN',
  plan_approved_at: null,
  created_at: '2026-09-04T00:00:00Z',
  finished_at: null,
}

function merchantDetailFetch(run = unknownRun) {
  return vi.fn().mockImplementation(async (input: string) => {
    if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
    if (input === '/api/merchants/1') return response(merchant)
    if (input === '/api/merchants/1/runs') return response([run])
    if (input === '/api/merchants/1/tasks') return response([])
    if (input === '/api/merchants/1/profile') {
      return response({
        merchant_id: 1,
        state: 'unbound',
        fbr_merchant_id: null,
        sync_status: null,
        last_synced_at: null,
        last_error: null,
        locations: [],
      })
    }
    return response([])
  })
}

function runDetailFetch(
  reconcile?: (body: Record<string, unknown>) => ReturnType<typeof response> | Promise<ReturnType<typeof response>>,
  detailRun: Run = unknownRun,
) {
  return vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
    if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
    if (input === '/api/runs/41' && (!init?.method || init.method === 'GET')) return response(detailRun)
    if (input === '/api/runs/41/reconcile-dispatch' && init?.method === 'POST') {
      return reconcile?.(JSON.parse(String(init.body))) ?? response(unknownRun)
    }
    if (input === '/api/runs/41/audit' || input === '/api/runs/41/task-plan') {
      return response({ detail: 'not found' }, 404)
    }
    if (input === '/api/merchants/1') return response(merchant)
    return response([])
  })
}

describe('run dispatch reconciliation', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('stops empty polling and directs an UNKNOWN merchant run to manual review', async () => {
    window.history.pushState({}, '', '/merchants/1')
    const intervalSpy = vi.spyOn(window, 'setInterval')
    vi.stubGlobal('fetch', merchantDetailFetch())

    render(<App />)

    await screen.findByRole('heading', { name: '派发结果需人工核对' })
    screen.getByText('Core AI 是否已创建本次分析尚不确定。不要重新触发诊断；请进入本次记录核对。')
    screen.getByText('暂时无法归档：本次分析的派发结果需人工核对。请先进入分析记录完成核对；不要重新触发。')
    screen.getByText('需人工核对')
    expect((screen.getByRole('button', { name: '归档商户' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '重新分析' })).toBeNull()
    expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 10_000)

    fireEvent.click(screen.getByRole('button', { name: '进入人工核对' }))
    expect(window.location.pathname).toBe('/runs/41')
  })

  it.each(['DISPATCHING', 'DISPATCHED'] as const)(
    'keeps normal polling for an explicitly pollable %s run',
    async dispatchState => {
      window.history.pushState({}, '', '/merchants/1')
      const intervalSpy = vi.spyOn(window, 'setInterval')
      vi.stubGlobal('fetch', merchantDetailFetch({
        ...unknownRun,
        provider_candidate_run_id: null,
        dispatch_state: dispatchState,
        needs_attention: false,
        error: null,
      }))

      render(<App />)

      await screen.findByRole('heading', { name: '正在诊断商户当前问题' })
      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 10_000)
    },
  )

  it.each([
    ['FAILED', 'FAILED'],
    ['legacy null', null],
    ['malformed value', 'CORRUPTED'],
  ])('does not poll a running row with %s dispatch state', async (_label, dispatchState) => {
    window.history.pushState({}, '', '/merchants/1')
    const intervalSpy = vi.spyOn(window, 'setInterval')
    const damagedRun = {
      ...unknownRun,
      provider_candidate_run_id: null,
      dispatch_state: dispatchState,
      needs_attention: false,
      error: null,
    } as unknown as Run
    vi.stubGlobal('fetch', merchantDetailFetch(damagedRun))

    render(<App />)

    await screen.findByRole('heading', { name: '正在诊断商户当前问题' })
    expect(intervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 10_000)
  })

  it.each(['DISPATCHING', 'DISPATCHED'] as const)(
    'polls a Run detail whose dispatch state is explicitly %s',
    async dispatchState => {
      vi.useFakeTimers()
      window.history.pushState({}, '', '/runs/41')
      const fetchMock = runDetailFetch(undefined, {
        ...unknownRun,
        dispatch_state: dispatchState,
        needs_attention: false,
        error: null,
      })
      vi.stubGlobal('fetch', fetchMock)

      render(<App />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const detailReads = () => fetchMock.mock.calls.filter(([input, init]) => (
        input === '/api/runs/41' && (!(init as RequestInit | undefined)?.method
          || (init as RequestInit).method === 'GET')
      )).length
      expect(detailReads()).toBe(1)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(detailReads()).toBe(2)
    },
  )

  it.each([
    ['UNKNOWN', 'UNKNOWN'],
    ['FAILED', 'FAILED'],
    ['legacy null', null],
    ['malformed value', 'CORRUPTED'],
  ])('does not poll a Run detail with %s dispatch state', async (_label, dispatchState) => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/runs/41')
    const detailRun = {
      ...unknownRun,
      dispatch_state: dispatchState,
      needs_attention: dispatchState === 'UNKNOWN',
    } as unknown as Run
    const fetchMock = runDetailFetch(undefined, detailRun)
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41')).toHaveLength(1)
  })

  it('cancels a pending Run detail timer when navigation unmounts the page', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/runs/41')
    const fetchMock = runDetailFetch(undefined, {
      ...unknownRun,
      dispatch_state: 'DISPATCHED',
      needs_attention: false,
      error: null,
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    fireEvent.click(screen.getByRole('link', { name: '返回Dispatch Merchant' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })

    expect(window.location.pathname).toBe('/merchants/1')
    expect(fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41')).toHaveLength(1)
  })

  it('prefills the candidate run and binds a verified existing provider run', async () => {
    window.history.pushState({}, '', '/runs/41')
    const reconciled = {
      ...unknownRun,
      coreai_run_id: 'candidate-run-41',
      dispatch_state: 'DISPATCHED',
      needs_attention: false,
      error: null,
    }
    const fetchMock = runDetailFetch(
      () => response(reconciled),
      { ...unknownRun, coreai_run_id: 'legacy-run-41' },
    )
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const review = await screen.findByRole('region', { name: '派发结果人工核对' })
    const providerInput = within(review).getByRole('textbox', { name: 'Core AI Run ID' }) as HTMLInputElement
    expect(providerInput.value).toBe('candidate-run-41')
    expect(within(review).queryByRole('button', { name: '确认未创建' })).toBeNull()
    within(review).getByText('不要重新触发诊断。请先在 Core AI 核实是否已创建对应运行。')
    within(review).getByText('COREAI_DISPATCH_OUTCOME_UNKNOWN')
    fireEvent.change(within(review).getByRole('textbox', { name: '核对原因' }), {
      target: { value: '已在 Core AI 核对同一商户与输入' },
    })
    fireEvent.click(within(review).getByRole('button', { name: '绑定已有运行' }))

    await screen.findByText('已绑定 Core AI 运行，分析状态已刷新。')
    expect(screen.queryByRole('region', { name: '派发结果人工核对' })).toBeNull()
    const call = fetchMock.mock.calls.find(([input, init]) => (
      input === '/api/runs/41/reconcile-dispatch' && (init as RequestInit | undefined)?.method === 'POST'
    ))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: 'BIND_EXISTING',
      provider_run_id: 'candidate-run-41',
      reason: '已在 Core AI 核对同一商户与输入',
    })
  })

  it('polls a bound run without overlap, loads its terminal report and plan, then stops', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/runs/41')
    const boundRun: Run = {
      ...unknownRun,
      coreai_run_id: 'candidate-run-41',
      dispatch_state: 'DISPATCHED',
      needs_attention: false,
      error: null,
    }
    const completedRun: Run = {
      ...boundRun,
      status: 'succeeded',
      report_text: '# Completed fallback report',
      finished_at: '2026-09-04T00:05:00Z',
    }
    const acceptedAudit = {
      id: 7,
      run_id: 41,
      merchant_id: 1,
      schema_version: 'seo_ops.audit_report.v1' as const,
      evidence_mode: 'CONFIRMED_FACTS_ONLY' as const,
      finding_count: 0,
      source_ref: 'candidate-run-41',
      accepted_at: '2026-09-04T00:05:00Z',
      audit: {
        schema_version: 'seo_ops.audit_report.v1' as const,
        merchant_id: '1',
        title: '轮询完成后的 Audit',
        summary: '终态刷新读取到了已验收报告。',
        evidence_mode: 'CONFIRMED_FACTS_ONLY' as const,
        findings: [],
        limitations: [],
        next_actions: ['审阅新生成的任务计划。'],
      },
    }
    const completedPlan = {
      id: 9,
      merchant_id: 1,
      source_kind: 'AGENT',
      source_run_id: 41,
      state: 'OPEN',
      latest_revision: 1,
      approved_revision: null,
      created_at: '2026-09-04T00:05:00Z',
      closed_at: null,
      current_revision: {
        id: 19,
        plan_id: 9,
        revision: 1,
        decision_state: 'DRAFT',
        schema_version: 'seo_ops.task_plan.v1',
        checksum: 'a'.repeat(64),
        source: 'AGENT',
        created_by: 'candidate-run-41',
        created_at: '2026-09-04T00:05:00Z',
        decided_by: null,
        decided_at: null,
        decision_reason: null,
        payload: {
          schema_version: 'seo_ops.task_plan.v1',
          tasks: [{
            key: 'review-audit',
            task_type: 'PREPARE_ONLY',
            title: 'Review the completed audit',
            rationale: 'The accepted audit needs operator review',
            expected_outcome: 'A reviewed plan',
            depends_on: [],
            scheduled_start: null,
            parameters: {},
          }],
        },
      },
    }
    const pendingPoll = deferred<ReturnType<typeof response<Run>>>()
    let runReads = 0
    let terminal = false
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/runs/41' && (!init?.method || init.method === 'GET')) {
        runReads += 1
        if (runReads === 1) return response(unknownRun)
        if (runReads === 2) return pendingPoll.promise
        terminal = true
        return response(completedRun)
      }
      if (input === '/api/runs/41/reconcile-dispatch' && init?.method === 'POST') {
        return response(boundRun)
      }
      if (input === '/api/runs/41/audit') {
        return terminal ? response(acceptedAudit) : response({ detail: 'not found' }, 404)
      }
      if (input === '/api/runs/41/task-plan') {
        return terminal ? response(completedPlan) : response({ detail: 'not found' }, 404)
      }
      if (input === '/api/merchants/1') return response(merchant)
      return response([])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    const review = screen.getByRole('region', { name: '派发结果人工核对' })
    fireEvent.change(within(review).getByRole('textbox', { name: '核对原因' }), {
      target: { value: '已核实候选运行属于本次分析' },
    })
    fireEvent.click(within(review).getByRole('button', { name: '绑定已有运行' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(runReads).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(runReads).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(runReads).toBe(2)

    await act(async () => {
      pendingPoll.resolve(response({ ...boundRun }))
      await Promise.resolve()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    screen.getByRole('heading', { name: '轮询完成后的 Audit' })
    screen.getByText('当前 Plan 草稿包含 1 项；尚未物化正式 Task。')
    const settledCounts = {
      run: runReads,
      audit: fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41/audit').length,
      plan: fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41/task-plan').length,
    }
    expect(settledCounts).toEqual({ run: 3, audit: 2, plan: 2 })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect({
      run: runReads,
      audit: fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41/audit').length,
      plan: fetchMock.mock.calls.filter(([input]) => input === '/api/runs/41/task-plan').length,
    }).toEqual(settledCounts)
  })

  it('shows terminal run truth without waiting for artifact reloads to settle', async () => {
    vi.useFakeTimers()
    window.history.pushState({}, '', '/runs/41')
    const boundRun: Run = {
      ...unknownRun,
      coreai_run_id: 'candidate-run-41',
      dispatch_state: 'DISPATCHED',
      needs_attention: false,
      error: null,
    }
    const completedRun: Run = {
      ...boundRun,
      status: 'succeeded',
      report_text: '# Completed fallback report',
      finished_at: '2026-09-04T00:05:00Z',
    }
    const pendingArtifact = deferred<ReturnType<typeof response>>()
    let runReads = 0
    let terminal = false
    const fetchMock = vi.fn().mockImplementation(async (input: string, init?: RequestInit) => {
      if (input === '/api/auth/me') return response({ username: 'test', role: 'operator' })
      if (input === '/api/runs/41' && (!init?.method || init.method === 'GET')) {
        runReads += 1
        if (runReads === 1) return response(boundRun)
        terminal = true
        return response(completedRun)
      }
      if (input === '/api/runs/41/audit' || input === '/api/runs/41/task-plan') {
        return terminal ? pendingArtifact.promise : response({ detail: 'not found' }, 404)
      }
      if (input === '/api/merchants/1') return response(merchant)
      return response([])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    screen.getByText('成功')
    screen.getByRole('heading', { name: 'Completed fallback report' })
    expect(runReads).toBe(2)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(runReads).toBe(2)
  })

  it('falls back to the legacy Core AI run id when no provider candidate was persisted', async () => {
    window.history.pushState({}, '', '/runs/41')
    vi.stubGlobal('fetch', runDetailFetch(undefined, {
      ...unknownRun,
      coreai_run_id: 'legacy-core-run-41',
      provider_candidate_run_id: null,
    }))

    render(<App />)

    const review = await screen.findByRole('region', { name: '派发结果人工核对' })
    const providerInput = within(review).getByRole('textbox', { name: 'Core AI Run ID' }) as HTMLInputElement
    expect(providerInput.value).toBe('legacy-core-run-41')
  })

  it('keeps the review open and surfaces a reconciliation error verbatim', async () => {
    window.history.pushState({}, '', '/runs/41')
    vi.stubGlobal('fetch', runDetailFetch(() => response({ detail: 'provider run could not be verified' }, 409)))

    render(<App />)

    const review = await screen.findByRole('region', { name: '派发结果人工核对' })
    fireEvent.change(within(review).getByRole('textbox', { name: '核对原因' }), {
      target: { value: '尝试绑定候选运行' },
    })
    fireEvent.click(within(review).getByRole('button', { name: '绑定已有运行' }))

    await within(review).findByText('provider run could not be verified')
    expect(within(review).getByRole('textbox', { name: 'Core AI Run ID' })).toBeTruthy()
    expect(within(review).queryByRole('button', { name: /重试/ })).toBeNull()
  })

  it('closes review with truthful failure when the persisted candidate cannot be bound', async () => {
    window.history.pushState({}, '', '/runs/41')
    const failedCandidate: Run = {
      ...unknownRun,
      dispatch_state: 'FAILED',
      needs_attention: false,
      status: 'failed',
      error: 'COREAI_RUN_NO_LONGER_AVAILABLE',
      finished_at: '2026-09-04T00:05:00Z',
    }
    vi.stubGlobal('fetch', runDetailFetch(() => response(failedCandidate)))

    render(<App />)

    const review = await screen.findByRole('region', { name: '派发结果人工核对' })
    fireEvent.change(within(review).getByRole('textbox', { name: '核对原因' }), {
      target: { value: '已核对持久化候选运行' },
    })
    fireEvent.click(within(review).getByRole('button', { name: '绑定已有运行' }))

    await screen.findByText('候选运行无法安全绑定；本次分析已标记失败，可返回商户页重新发起。')
    expect(screen.queryByRole('region', { name: '派发结果人工核对' })).toBeNull()
    screen.getByText('COREAI_RUN_NO_LONGER_AVAILABLE')
  })

  it('requires a reason and second confirmation before marking the provider run not created', async () => {
    window.history.pushState({}, '', '/runs/41')
    const runWithoutProviderEvidence: Run = {
      ...unknownRun,
      provider_candidate_run_id: null,
    }
    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)
    const reconciled = {
      ...unknownRun,
      dispatch_state: 'FAILED',
      needs_attention: false,
      status: 'failed',
      error: 'COREAI_DISPATCH_CONFIRMED_NOT_CREATED',
      finished_at: '2026-09-04T00:05:00Z',
    }
    const fetchMock = runDetailFetch(() => response(reconciled), runWithoutProviderEvidence)
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    const review = await screen.findByRole('region', { name: '派发结果人工核对' })
    const notCreated = within(review).getByRole('button', { name: '确认未创建' }) as HTMLButtonElement
    expect(notCreated.disabled).toBe(true)
    fireEvent.change(within(review).getByRole('textbox', { name: '核对原因' }), {
      target: { value: '已确认 Core AI 中不存在对应运行' },
    })
    expect(notCreated.disabled).toBe(false)
    fireEvent.click(notCreated)

    expect(confirmMock).toHaveBeenCalledWith(
      '请再次确认：Core AI 中没有创建本次运行。确认后本次分析会标记失败，之后才能重新发起诊断。',
    )
    await screen.findByText('已确认 Core AI 未创建运行；本次分析已标记失败，可返回商户页重新发起。')
    const call = fetchMock.mock.calls.find(([input, init]) => (
      input === '/api/runs/41/reconcile-dispatch' && (init as RequestInit | undefined)?.method === 'POST'
    ))
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: 'NOT_CREATED',
      expected_provider_candidate_run_id: null,
      reason: '已确认 Core AI 中不存在对应运行',
    })
  })
})

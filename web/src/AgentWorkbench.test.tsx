// @vitest-environment jsdom

import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError, type AgentMutationResponse, type AgentRunHistory, type AgentWorkbenchSnapshot, type CurrentCount, type ProjectedRunSummary, type WorkbenchAgent, type WorkbenchSignal } from './api'
import AgentWorkbench from './pages/AgentWorkbench'
import { useAgentWorkbenchPolling } from './useAgentWorkbenchPolling'
import LiveRunStage from './components/agent-workbench/LiveRunStage'
import { createPresentationState, replacePresentationSnapshot, type PresentedWorkbench } from './agentWorkbenchPresentation'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value })
}

const exactCount = (value: number): CurrentCount => ({
  value,
  quality: 'exact',
  last_observed_value: value,
  last_observed_at: '2026-09-06T01:00:00.000Z',
})

function makeAgent(lifecycleStatus: 'active' | 'disabled' | 'retired' = 'active'): WorkbenchAgent {
  return {
    id: `agent-${lifecycleStatus}`,
    agent_key: `key-${lifecycleStatus}`,
    coreai_agent_id: `core-${lifecycleStatus}`,
    display_name: `${lifecycleStatus} Agent`,
    role: 'SEO 研究',
    sort_order: 1,
    lifecycle_status: lifecycleStatus,
    coreai_metadata: { name: null, model: null, timeout_hint_seconds: null, last_verified_at: null, verification_error: null },
    suspect_after_seconds: 120,
    sync_pending: false,
    sync: {
      health: lifecycleStatus === 'active' ? 'fresh' : 'stale',
      last_discovery_attempt_at: '2026-09-06T01:00:00.000Z',
      last_discovery_success_at: '2026-09-06T01:00:00.000Z',
      discovery_error: null,
      current_state_checked_at: '2026-09-06T01:00:00.000Z',
      current_state_error: null,
      next_discovery_at: null,
      last_fast_poll_attempt_at: null,
      last_fast_poll_success_at: null,
      fast_poll_error: null,
    },
    current_state_complete: lifecycleStatus === 'active',
    current_counts: { running: exactCount(0), queued: exactCount(0), waiting: exactCount(0) },
    range_metrics: { run_count: 0, terminal_runs: 0, successful_runs: 0, success_rate: null, known_input_tokens: 0, known_output_tokens: 0, known_total_tokens: 0, token_known_runs: 0, token_eligible_runs: 0 },
    coverage: { mirrored_run_count: 0, remote_total_runs: 0, history_complete: true, range_complete: true, coverage_start_at: null, coverage_as_of: '2026-09-06T01:00:00.000Z' },
    last_terminal_run: null,
    warnings: [],
  }
}

function makeSnapshot(overrides: Partial<AgentWorkbenchSnapshot> = {}): AgentWorkbenchSnapshot {
  return {
    snapshot_at: '2026-09-06T01:00:00.000Z',
    last_complete_discovery_at: '2026-09-06T01:00:00.000Z',
    sync_health: 'fresh',
    stale: false,
    current_state_complete: true,
    current_state_checked_at: '2026-09-06T01:00:00.000Z',
    current_state_incomplete_statuses: [],
    fresh_until: '2026-09-06T01:01:30.000Z',
    has_active_runs: false,
    has_queued_runs: false,
    has_waiting_runs: false,
    current_counts: {
      running: exactCount(0),
      queued: exactCount(0),
      waiting: exactCount(0),
      legacy_nonterminal: exactCount(0),
    },
    refresh_after_ms: 30_000,
    range: '30d',
    timezone: 'Asia/Shanghai',
    range_start: '2026-08-06T16:00:00.000Z',
    range_end: '2026-09-06T16:00:00.000Z',
    metrics_complete_for_range: true,
    coverage: {
      mirrored_run_count: 0,
      remote_total_runs: 0,
      history_complete: true,
      range_complete: true,
      coverage_start_at: null,
      coverage_as_of: '2026-09-06T01:00:00.000Z',
    },
    summary: {
      run_count: 0,
      terminal_runs: 0,
      successful_runs: 0,
      success_rate: null,
      known_input_tokens: 0,
      known_output_tokens: 0,
      known_total_tokens: 0,
      token_known_runs: 0,
      token_eligible_runs: 0,
    },
    signals: [],
    agents: [makeAgent()],
    sync_warnings: [],
    ...overrides,
  }
}

function makeSignal(overrides: Partial<WorkbenchSignal> = {}): WorkbenchSignal {
  return {
    coreai_run_id: 'run-current-123456789',
    local_agent_id: 'agent-1',
    agent_name: '研究 Agent',
    agent_role: '研究任务',
    lifecycle_status: 'active',
    agent_current_state_complete: true,
    raw_status: 'RUNNING',
    presentation_group: 'active',
    signal_state: 'active',
    trigger_type: 'MANUAL',
    fresh: true,
    suspect: false,
    suspect_reason: null,
    started_at: '2026-09-06T00:59:00.000Z',
    effective_started_at: '2026-09-06T00:59:00.000Z',
    completed_at: null,
    terminal_observed_at: null,
    receipt_expires_at: null,
    elapsed_seconds: 60,
    last_synced_at: '2026-09-06T01:00:00.000Z',
    fresh_until: '2026-09-06T01:01:30.000Z',
    suspect_at: '2026-09-06T01:02:00.000Z',
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    token_state: 'pending',
    association: null,
    ...overrides,
  }
}

function makeHistoryItem(overrides: Partial<ProjectedRunSummary> = {}): ProjectedRunSummary {
  return {
    coreai_run_id: 'history-run-1',
    raw_status: 'COMPLETED',
    presentation_group: 'success',
    trigger_type: 'SCHEDULED',
    started_at: '2026-09-06T00:00:00.000Z',
    effective_started_at: '2026-09-06T00:00:00.000Z',
    completed_at: '2026-09-06T00:01:00.000Z',
    terminal_observed_at: '2026-09-06T00:01:01.000Z',
    receipt_expires_at: null,
    elapsed_seconds: 60,
    duration_seconds: 60,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    token_state: 'known',
    last_synced_at: '2026-09-06T00:01:02.000Z',
    suspect: false,
    suspect_reason: null,
    archiving: false,
    archive_delayed: false,
    warning_codes: [],
    association: null,
    error_summary: null,
    ...overrides,
  }
}

function makeHistory(range: 'today' | '7d' | '30d' | 'all' = '30d', overrides: Partial<AgentRunHistory> = {}): AgentRunHistory {
  return {
    items: [makeHistoryItem()],
    next_before: null,
    range,
    timezone: 'Asia/Shanghai',
    range_start: null,
    range_end: '2026-09-06T01:00:00.000Z',
    ...overrides,
  }
}

function liveSnapshot(overrides: Partial<AgentWorkbenchSnapshot> = {}) {
  return makeSnapshot({
    has_active_runs: true,
    current_counts: {
      running: exactCount(1),
      queued: exactCount(0),
      waiting: exactCount(0),
      legacy_nonterminal: exactCount(0),
    },
    signals: [makeSignal()],
    refresh_after_ms: 5_000,
    ...overrides,
  })
}

function present(snapshot: AgentWorkbenchSnapshot): PresentedWorkbench {
  const state = replacePresentationSnapshot(createPresentationState(), snapshot, performance.now(), 'initial')
  if (!state.presentation) throw new Error('expected presentation')
  return state.presentation
}

type MutationKind = 'register' | 'edit' | 'disable' | 're-enable' | 'retire' | 'replace'

const mutationKinds: MutationKind[] = ['register', 'edit', 'disable', 're-enable', 'retire', 'replace']

function mutationAgent(kind: MutationKind): WorkbenchAgent {
  return kind === 're-enable' ? makeAgent('disabled') : makeAgent()
}

function mutationResponse(kind: MutationKind): AgentMutationResponse {
  const original = mutationAgent(kind)
  const lifecycle = kind === 'disable' ? 'disabled' : kind === 'retire' ? 'retired' : 'active'
  const syncPending = kind === 'register' || kind === 're-enable' || kind === 'replace'
  return {
    agent: {
      ...original,
      id: kind === 'register' ? 'agent-new' : original.id,
      lifecycle_status: lifecycle,
      coreai_agent_id: kind === 'register' ? 'core-matrix' : kind === 'replace' ? 'core-replacement' : original.coreai_agent_id,
      agent_key: kind === 'register' ? 'matrix' : original.agent_key,
      display_name: kind === 'register' ? 'Matrix Agent' : kind === 'edit' ? '更新名称' : original.display_name,
      sync_pending: syncPending,
    },
    sync_pending: syncPending,
  }
}

function stubMutation(kind: MutationKind, promise: Promise<AgentMutationResponse>) {
  if (kind === 'register') return vi.spyOn(api, 'registerAgent').mockReturnValue(promise)
  if (kind === 'retire') return vi.spyOn(api, 'retireAgent').mockReturnValue(promise)
  if (kind === 'replace') return vi.spyOn(api, 'replaceAgent').mockReturnValue(promise)
  return vi.spyOn(api, 'updateAgent').mockReturnValue(promise)
}

function submitMutation(kind: MutationKind) {
  if (kind === 'register') {
    fireEvent.click(screen.getByRole('button', { name: '管理 Agent' }))
    fireEvent.change(screen.getByLabelText('Core AI Agent ID'), { target: { value: 'core-matrix' } })
    fireEvent.change(screen.getByLabelText('Agent key'), { target: { value: 'matrix' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Matrix Agent' } })
    fireEvent.change(screen.getByLabelText('职责'), { target: { value: 'Matrix Role' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并注册' }))
    return
  }
  if (kind === 'retire') {
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    return
  }
  if (kind === 'replace') {
    fireEvent.click(screen.getByRole('button', { name: '替换' }))
    fireEvent.change(screen.getByLabelText('Core AI Agent ID'), { target: { value: 'core-replacement' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }))
    return
  }
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  if (kind === 'edit') {
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '更新名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
  } else {
    fireEvent.click(screen.getByRole('button', { name: kind === 'disable' ? '停用 Agent' : '重新验证并启用' }))
  }
}

function expectExactMutationCall(kind: MutationKind, mutation: ReturnType<typeof vi.fn> | ReturnType<typeof vi.spyOn>) {
  if (kind === 'register') {
    expect(mutation).toHaveBeenCalledWith({
      coreai_agent_id: 'core-matrix',
      agent_key: 'matrix',
      display_name: 'Matrix Agent',
      role: 'Matrix Role',
      sort_order: 0,
      suspect_after_seconds: 120,
    })
  } else if (kind === 'edit') {
    expect(mutation).toHaveBeenCalledWith('agent-active', {
      display_name: '更新名称',
      role: 'SEO 研究',
      sort_order: 1,
      suspect_after_seconds: 120,
    })
  } else if (kind === 'disable') {
    expect(mutation).toHaveBeenCalledWith('agent-active', { lifecycle_status: 'disabled' })
  } else if (kind === 're-enable') {
    expect(mutation).toHaveBeenCalledWith('agent-disabled', { lifecycle_status: 'active' })
  } else if (kind === 'retire') {
    expect(mutation).toHaveBeenCalledWith('agent-active')
  } else {
    expect(mutation).toHaveBeenCalledWith('agent-active', {
      coreai_agent_id: 'core-replacement',
      display_name: 'active Agent',
      role: 'SEO 研究',
      sort_order: 1,
      suspect_after_seconds: 120,
    })
  }
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  setVisibility('visible')
})

describe('Agent Workbench', () => {
  it('visible StrictMode mount fetches once', async () => {
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())

    render(
      <StrictMode>
        <AgentWorkbench />
      </StrictMode>,
    )

    await waitFor(() => expect(getWorkbench).toHaveBeenCalledTimes(1))
    expect(getWorkbench).toHaveBeenCalledWith('30d', expect.any(AbortSignal))
  })

  it.each([[5_000], [30_000]])('server cadence starts after settlement (%i ms)', async refreshAfterMs => {
    vi.useFakeTimers()
    const getWorkbench = vi
      .spyOn(api, 'getAgentWorkbench')
      .mockResolvedValue(makeSnapshot({ refresh_after_ms: refreshAfterMs }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(refreshAfterMs - 1) })
    expect(getWorkbench).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(getWorkbench).toHaveBeenCalledTimes(2)
  })

  it('StrictMode probe remount joins one in-flight request', async () => {
    const pending = deferred<AgentWorkbenchSnapshot>()
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockReturnValue(pending.promise)

    const view = render(<StrictMode><AgentWorkbench /></StrictMode>)
    await act(async () => { await Promise.resolve() })

    expect(getWorkbench).toHaveBeenCalledTimes(1)
    view.unmount()
    pending.reject(new DOMException('aborted', 'AbortError'))
    await act(async () => { await Promise.resolve() })
  })

  it('real unmount aborts shared request after deferred cleanup', async () => {
    const pending = deferred<AgentWorkbenchSnapshot>()
    let requestSignal: AbortSignal | undefined
    const abortSpy = vi.fn()
    vi.spyOn(api, 'getAgentWorkbench').mockImplementation((_range, signal) => {
      requestSignal = signal
      signal.addEventListener('abort', abortSpy)
      return pending.promise
    })

    const view = render(<AgentWorkbench />)
    expect(requestSignal?.aborted).toBe(false)
    view.unmount()
    await act(async () => { await Promise.resolve() })

    expect(requestSignal?.aborted).toBe(true)
    expect(abortSpy).toHaveBeenCalledTimes(1)
    pending.reject(new DOMException('aborted', 'AbortError'))
  })

  it('automatic requests never overlap in StrictMode', async () => {
    vi.useFakeTimers()
    const requests: Array<ReturnType<typeof deferred<AgentWorkbenchSnapshot>>> = []
    let concurrent = 0
    let maximumConcurrent = 0
    vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => {
      const request = deferred<AgentWorkbenchSnapshot>()
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      void request.promise.finally(() => { concurrent -= 1 }).catch(() => undefined)
      requests.push(request)
      return request.promise
    })

    render(<StrictMode><AgentWorkbench /></StrictMode>)
    expect(requests).toHaveLength(1)
    await act(async () => { requests[0].resolve(makeSnapshot({ refresh_after_ms: 5_000 })); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(requests).toHaveLength(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(requests).toHaveLength(2)
    await act(async () => { requests[1].resolve(makeSnapshot({ refresh_after_ms: 5_000 })); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(requests).toHaveLength(3)
    expect(maximumConcurrent).toBe(1)
  })

  it('range change aborts obsolete generation', async () => {
    const requests: Array<{ range: string; signal: AbortSignal } & ReturnType<typeof deferred<AgentWorkbenchSnapshot>>> = []
    vi.spyOn(api, 'getAgentWorkbench').mockImplementation((range, signal) => {
      const request = Object.assign(deferred<AgentWorkbenchSnapshot>(), { range, signal })
      requests.push(request)
      return request.promise
    })

    function Harness() {
      const [range, setRange] = useState<'30d' | '7d'>('30d')
      useAgentWorkbenchPolling(range)
      return <button type="button" onClick={() => setRange('7d')}>近 7 天</button>
    }

    render(<Harness />)
    expect(requests).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '近 7 天' }))
    await act(async () => { await Promise.resolve() })
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(1)

    requests[0].reject(new DOMException('aborted', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    expect(requests).toHaveLength(2)
    expect(requests[1].range).toBe('7d')
  })

  it('stored pause performs no initial read', async () => {
    window.sessionStorage.setItem('seo-ops.agent-workbench.auto-update', 'paused')
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench')

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    expect(getWorkbench).not.toHaveBeenCalled()
    expect(screen.getByText('自动更新已暂停 · 尚未读取')).not.toBeNull()
    expect(screen.getByRole('button', { name: '刷新显示' })).not.toBeNull()
  })

  it('hidden mount waits for visibility', async () => {
    setVisibility('hidden')
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).not.toHaveBeenCalled()

    setVisibility('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(1)
  })

  it('hide aborts and focus while hidden is inert', async () => {
    const pending = deferred<AgentWorkbenchSnapshot>()
    let requestSignal: AbortSignal | undefined
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation((_range, signal) => {
      requestSignal = signal
      return pending.promise
    })

    render(<AgentWorkbench />)
    expect(getWorkbench).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await Promise.resolve() })

    expect(requestSignal?.aborted).toBe(true)
    expect(getWorkbench).toHaveBeenCalledTimes(1)
    pending.reject(new DOMException('aborted', 'AbortError'))
  })

  it.each([
    ['idle', makeSnapshot()],
    ['running', liveSnapshot()],
  ])('visible focus downgrades before one causal successor (%s)', async (_mode, initialSnapshot) => {
    vi.useFakeTimers()
    const oldAutomatic = deferred<AgentWorkbenchSnapshot>()
    const successor = deferred<AgentWorkbenchSnapshot>()
    const responses = [Promise.resolve(initialSnapshot), oldAutomatic.promise, successor.promise]
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => responses.shift()!)

    function Harness() {
      const result = useAgentWorkbenchPolling('30d')
      return <div>
        <span data-testid="current">{String(result.presentation?.current_counts.running.claim_is_current)}</span>
        <span data-testid="idle">{String(result.presentation?.idle_eligible)}</span>
        <span data-testid="motion">{String(result.presentation?.signals.some(signal => signal.may_animate))}</span>
        <span data-testid="snapshot">{result.snapshot?.snapshot_at}</span>
      </div>
    }

    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(initialSnapshot.refresh_after_ms) })
    expect(getWorkbench).toHaveBeenCalledTimes(2)

    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(screen.getByTestId('current').textContent).toBe('false')
    expect(screen.getByTestId('idle').textContent).toBe('false')
    expect(screen.getByTestId('motion').textContent).toBe('false')
    expect(getWorkbench).toHaveBeenCalledTimes(2)

    oldAutomatic.resolve(liveSnapshot({ snapshot_at: '2026-09-06T01:00:30.000Z' }))
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('snapshot').textContent).toBe(initialSnapshot.snapshot_at)

    successor.resolve(liveSnapshot({ snapshot_at: '2026-09-06T01:00:40.000Z' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('true')
  })

  it('visible focus downgrades before one causal successor when successor fails', async () => {
    vi.useFakeTimers()
    const oldAutomatic = deferred<AgentWorkbenchSnapshot>()
    const failedSuccessor = deferred<AgentWorkbenchSnapshot>()
    const responses = [Promise.resolve(liveSnapshot()), oldAutomatic.promise, failedSuccessor.promise]
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => responses.shift()!)
    function Harness() {
      const result = useAgentWorkbenchPolling('30d')
      return <span data-testid="current">{String(result.presentation?.current_counts.running.claim_is_current)}</span>
    }
    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(screen.getByTestId('current').textContent).toBe('false')
    expect(getWorkbench).toHaveBeenCalledTimes(2)
    oldAutomatic.resolve(liveSnapshot({ snapshot_at: '2026-09-06T01:00:20.000Z' }))
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(3)
    failedSuccessor.reject(new Error('upstream unavailable'))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('false')
  })

  it('mutation refresh intent waits for a post-write non-overlapping successor', async () => {
    vi.useFakeTimers()
    const oldAutomatic = deferred<AgentWorkbenchSnapshot>()
    const successor = deferred<AgentWorkbenchSnapshot>()
    const responses = [Promise.resolve(liveSnapshot()), oldAutomatic.promise, successor.promise]
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => responses.shift()!)

    function Harness() {
      const result = useAgentWorkbenchPolling('30d')
      return <div>
        <span data-testid="current">{String(result.presentation?.current_counts.running.claim_is_current)}</span>
        <button type="button" onClick={() => result.requestRefresh('mutation')}>mutation</button>
      </div>
    }

    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    fireEvent.click(screen.getByRole('button', { name: 'mutation' }))

    expect(screen.getByTestId('current').textContent).toBe('false')
    expect(getWorkbench).toHaveBeenCalledTimes(2)
    oldAutomatic.resolve(liveSnapshot({ snapshot_at: '2026-09-06T01:00:30.000Z' }))
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(3)
    successor.resolve(liveSnapshot({ snapshot_at: '2026-09-06T01:00:40.000Z' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('true')
  })

  it('pause refresh and resume obey pending range', async () => {
    window.sessionStorage.setItem('seo-ops.agent-workbench.auto-update', 'paused')
    const manual = deferred<AgentWorkbenchSnapshot>()
    const resumed = deferred<AgentWorkbenchSnapshot>()
    const responses = [manual.promise, resumed.promise]
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => responses.shift()!)

    render(<AgentWorkbench />)
    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    expect(getWorkbench).not.toHaveBeenCalled()
    expect(screen.getByText('已选择近 7 天 · 当前仍显示近 30 天数据')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    expect(getWorkbench).toHaveBeenCalledTimes(1)
    expect(getWorkbench.mock.calls[0][0]).toBe('7d')
    manual.resolve(makeSnapshot({ range: '7d' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/自动更新已暂停/)).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '恢复自动更新' }))
    expect(getWorkbench).toHaveBeenCalledTimes(2)
    expect(getWorkbench.mock.calls[1][0]).toBe('7d')
    resumed.resolve(makeSnapshot({ range: '7d' }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(/自动更新 · 空闲最多 30 秒/)).not.toBeNull()
  })

  it('exact deadlines fire between elapsed ticks', async () => {
    vi.useFakeTimers()
    const snapshot = liveSnapshot({
      fresh_until: '2026-09-06T01:00:01.250Z',
      signals: [makeSignal({ fresh_until: '2026-09-06T01:00:10.000Z' })],
      refresh_after_ms: 30_000,
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(snapshot)

    function Harness() {
      const result = useAgentWorkbenchPolling('30d')
      return <span data-testid="current">{String(result.presentation?.current_counts.running.claim_is_current)}</span>
    }

    render(<Harness />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByTestId('current').textContent).toBe('true')
    await act(async () => { await vi.advanceTimersByTimeAsync(1_249) })
    expect(screen.getByTestId('current').textContent).toBe('true')
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByTestId('current').textContent).toBe('false')
  })

  it('exact deadlines fire between elapsed ticks for suspect and receipt expiry', async () => {
    vi.useFakeTimers()
    const suspectSnapshot = liveSnapshot({
      fresh_until: '2026-09-06T01:00:10.000Z',
      signals: [makeSignal({ fresh_until: '2026-09-06T01:00:10.000Z', suspect_at: '2026-09-06T01:00:01.250Z' })],
      refresh_after_ms: 30_000,
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(suspectSnapshot)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(screen.getByRole('tab').textContent).toContain('状态待确认')
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(false)

    cleanup()
    const receipt = makeSignal({
      coreai_run_id: 'receipt-1',
      raw_status: 'COMPLETED',
      presentation_group: 'success',
      signal_state: 'completed',
      fresh: false,
      receipt_expires_at: '2026-09-06T01:00:01.250Z',
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ signals: [receipt], refresh_after_ms: 30_000 }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('tab', { name: /已完成/ })).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(screen.queryByRole('tab')).toBeNull()
  })

  it('fresh deadline revokes stage current wording', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({
      fresh_until: '2026-09-06T01:00:01.250Z',
      signals: [makeSignal({ fresh_until: '2026-09-06T01:00:10.000Z' })],
      refresh_after_ms: 30_000,
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('1 个 Agent · 1 个 Run 进行中')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(screen.getByText('已看到 1 个 Agent 的运行记录 · 当前数量未知')).not.toBeNull()
  })

  it('suspect deadline revokes owning stage wording', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({
      fresh_until: '2026-09-06T01:00:10.000Z',
      signals: [makeSignal({ fresh_until: '2026-09-06T01:00:10.000Z', suspect_at: '2026-09-06T01:00:01.250Z' })],
      refresh_after_ms: 30_000,
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(screen.getByText('已看到 1 个 Agent 的运行记录 · 当前数量未知')).not.toBeNull()
    expect(screen.queryByText('1 个 Agent · 1 个 Run 进行中')).toBeNull()
  })

  it.each(['hidden', 'pause'])('hide and pause revoke stage current wording before render (%s)', async mode => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(true)
    if (mode === 'hidden') {
      setVisibility('hidden')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    } else {
      fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    }
    expect(screen.getByText('已看到 1 个 Agent 的运行记录 · 当前数量未知')).not.toBeNull()
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(false)
  })

  it.each(['pause', 'hidden', 'focus'])('%s downgrade qualifies raw RUNNING copy and removes rail currentness', async mode => {
    const successor = deferred<AgentWorkbenchSnapshot>()
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(liveSnapshot())
      .mockReturnValueOnce(successor.promise)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    if (mode === 'pause') {
      fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    } else if (mode === 'hidden') {
      setVisibility('hidden')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    } else {
      act(() => { window.dispatchEvent(new Event('focus')) })
    }

    expect(screen.getByRole('tab').textContent).toContain('截至 2026-09-06T01:00:00.000Z 状态为 RUNNING')
    expect(screen.getByRole('tabpanel').querySelector('[aria-current="step"]')).toBeNull()
    if (mode === 'focus') successor.reject(new DOMException('aborted', 'AbortError'))
  })

  it.each(['freshness', 'suspect'])('%s deadline qualifies raw RUNNING copy and removes rail currentness', async mode => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({
      fresh_until: '2026-09-06T01:00:10.000Z',
      signals: [makeSignal({
        fresh_until: mode === 'freshness' ? '2026-09-06T01:00:01.250Z' : '2026-09-06T01:00:10.000Z',
        suspect_at: mode === 'suspect' ? '2026-09-06T01:00:01.250Z' : '2026-09-06T01:00:10.000Z',
      })],
      refresh_after_ms: 30_000,
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })

    expect(screen.getByRole('tab').textContent).toContain('截至 2026-09-06T01:00:00.000Z 状态为 RUNNING')
    expect(screen.getByRole('tabpanel').querySelector('[aria-current="step"]')).toBeNull()
  })

  it('removed focused receipt transfers focus', async () => {
    const receipt = makeSignal({
      coreai_run_id: 'receipt-focus',
      raw_status: 'COMPLETED',
      presentation_group: 'success',
      signal_state: 'completed',
      fresh: false,
      effective_started_at: '2026-09-06T01:00:00.000Z',
      receipt_expires_at: '2026-09-06T01:00:20.000Z',
    })
    const running = makeSignal({ coreai_run_id: 'running-focus' })
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(liveSnapshot({ signals: [receipt, running] }))
      .mockResolvedValueOnce(liveSnapshot({ signals: [running] }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const receiptTab = screen.getByRole('tab', { name: /已完成/ })
    fireEvent.click(receiptTab)
    receiptTab.focus()
    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /运行中/ }))
  })

  it('removed focused receipt transfers focus on local expiry and uses heading fallback', async () => {
    vi.useFakeTimers()
    const expiring = makeSignal({
      coreai_run_id: 'receipt-expiring',
      raw_status: 'COMPLETED',
      presentation_group: 'success',
      signal_state: 'completed',
      fresh: false,
      effective_started_at: '2026-09-06T01:00:00.000Z',
      receipt_expires_at: '2026-09-06T01:00:01.250Z',
    })
    const running = makeSignal({ coreai_run_id: 'running-after-expiry' })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({ signals: [expiring, running], refresh_after_ms: 30_000 }))
    const view = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const expiringTab = screen.getByRole('tab', { name: /已完成/ })
    fireEvent.click(expiringTab)
    expiringTab.focus()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /运行中/ }))

    view.unmount()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ signals: [expiring], refresh_after_ms: 30_000 }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const onlyTab = screen.getByRole('tab')
    onlyTab.focus()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: '执行信号' }))
  })

  it.each(['pause-manual', 'hide-visible', 'pause-resume'])('aborted request queues one immediate successor (%s)', async mode => {
    const oldRequest = deferred<AgentWorkbenchSnapshot>()
    const successor = deferred<AgentWorkbenchSnapshot>()
    const responses = [oldRequest.promise, successor.promise]
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockImplementation(() => responses.shift()!)
    render(<AgentWorkbench />)
    const firstSignal = getWorkbench.mock.calls[0][1]

    if (mode === 'pause-manual') {
      fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
      fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    } else if (mode === 'hide-visible') {
      setVisibility('hidden')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      setVisibility('visible')
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    } else {
      fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
      fireEvent.click(screen.getByRole('button', { name: '恢复自动更新' }))
    }

    expect(firstSignal.aborted).toBe(true)
    expect(getWorkbench).toHaveBeenCalledTimes(1)
    oldRequest.reject(new DOMException('aborted', 'AbortError'))
    await act(async () => { await Promise.resolve() })
    expect(getWorkbench).toHaveBeenCalledTimes(2)
    successor.resolve(makeSnapshot())
    await act(async () => { await Promise.resolve() })
  })

  it('header and range copy reflects snapshot truth', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ range: '30d' }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText(/运行状态已刷新/)).not.toBeNull()
    expect((screen.getByRole('radio', { name: '近 30 天' }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('自动更新 · 空闲最多 30 秒')).not.toBeNull()
    expect(screen.getByRole('button', { name: '刷新显示' }).getAttribute('aria-describedby')).toBeTruthy()
  })

  it('summary qualifies incomplete range metrics', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      metrics_complete_for_range: false,
      coverage: {
        mirrored_run_count: 7,
        remote_total_runs: 10,
        history_complete: false,
        range_complete: false,
        coverage_start_at: '2026-08-20T00:00:00.000Z',
        coverage_as_of: '2026-09-06T01:00:00.000Z',
      },
      summary: {
        run_count: 7,
        terminal_runs: 6,
        successful_runs: 5,
        success_rate: 5 / 6,
        known_input_tokens: 1200,
        known_output_tokens: 300,
        known_total_tokens: 1500,
        token_known_runs: 4,
        token_eligible_runs: 6,
      },
    }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    const summary = screen.getByRole('region', { name: 'Agent 汇总' })
    expect(within(summary).getByText('Run 数')).not.toBeNull()
    expect(within(summary).getByText('7')).not.toBeNull()
    expect(within(summary).getByText('成功完成')).not.toBeNull()
    expect(within(summary).getByText('5')).not.toBeNull()
    expect(within(summary).getByText('成功率')).not.toBeNull()
    expect(within(summary).getAllByText('基于已镜像 7/10 次').length).toBeGreaterThanOrEqual(3)
  })

  it('summary keeps presented current counts independent of range', async () => {
    const first = makeSnapshot({ current_counts: { running: exactCount(3), queued: exactCount(2), waiting: exactCount(1), legacy_nonterminal: exactCount(0) } })
    const second = makeSnapshot({
      range: '7d',
      summary: { ...makeSnapshot().summary, run_count: 99 },
      current_counts: { running: exactCount(3), queued: exactCount(2), waiting: exactCount(1), legacy_nonterminal: exactCount(0) },
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValueOnce(first).mockResolvedValueOnce(second)

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 3')).not.toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 3')).not.toBeNull()
    expect(screen.getByLabelText('Run 数 99')).not.toBeNull()
  })

  it('summary presents lower-bound and observed-unknown current counts', async () => {
    const lowerBound: CurrentCount = { value: 2, quality: 'lower_bound', last_observed_value: 2, last_observed_at: '2026-09-06T01:00:00.000Z' }
    const observedUnknown: CurrentCount = { value: null, quality: 'unknown', last_observed_value: 4, last_observed_at: '2026-09-06T00:55:00.000Z' }
    const neverObserved: CurrentCount = { value: null, quality: 'unknown', last_observed_value: null, last_observed_at: null }
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      current_counts: { running: lowerBound, queued: observedUnknown, waiting: neverObserved, legacy_nonterminal: exactCount(0) },
    }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 至少 2')).not.toBeNull()
    expect(screen.getByLabelText('当前排队 当前数量未知 · 上次确认 4（2026-09-06T00:55:00.000Z）')).not.toBeNull()
    expect(screen.getByLabelText('当前等待 当前数量未知 · 尚无成功确认')).not.toBeNull()
  })

  it('summary distinguishes zero denominator and zero tokens', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      summary: { ...makeSnapshot().summary, run_count: 3, terminal_runs: 0, success_rate: null },
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('成功率 —')).not.toBeNull()
    expect(screen.getByLabelText('已知总 Tokens 0')).not.toBeNull()
    expect(within(screen.getByRole('region', { name: 'Agent 汇总' })).getByText('已知 0/0 次')).not.toBeNull()
  })

  it('fresh deadline revokes summary current wording', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({ fresh_until: '2026-09-06T01:00:01.000Z' }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 1')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.queryByLabelText('当前运行 1')).toBeNull()
    expect(screen.getByLabelText(/当前运行 当前数量未知/)).not.toBeNull()
  })

  it('suspect deadline revokes summary owning count', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({
      signals: [makeSignal({ suspect_at: '2026-09-06T01:00:01.000Z', fresh_until: '2026-09-06T01:02:00.000Z' })],
      fresh_until: '2026-09-06T01:02:00.000Z',
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 1')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.queryByLabelText('当前运行 1')).toBeNull()
  })

  it('summary never renders mirrored count over stale zero total', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      metrics_complete_for_range: false,
      coverage: { mirrored_run_count: 1, remote_total_runs: null, history_complete: false, range_complete: false, coverage_start_at: null, coverage_as_of: null },
      sync_warnings: [{ code: 'LOCAL_RUN_UNCONFIRMED', message: '本地 Run 尚未确认', local_agent_id: null, coreai_run_id: 'local-run' }],
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByText('基于已镜像 1 次 · 上游总数未知').length).toBeGreaterThan(0)
    expect(document.body.textContent).not.toContain('1/0')
  })

  it('hide and pause revoke summary current wording', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('当前运行 1')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    expect(screen.queryByLabelText('当前运行 1')).toBeNull()
    expect(screen.getByLabelText(/当前运行 数据截至/)).not.toBeNull()
  })

  it('registry supports twelve mixed lifecycle agents', async () => {
    const agents = Array.from({ length: 12 }, (_, index) => ({
      ...makeAgent(index > 8 ? 'retired' : index > 6 ? 'disabled' : 'active'),
      id: `agent-${index}`,
      display_name: `Agent ${String(index).padStart(2, '0')}`,
      sort_order: 12 - index,
    }))
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ agents }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    const table = screen.getByRole('table', { name: 'Agent 台账' })
    expect(within(table).getAllByRole('row')).toHaveLength(10)
    expect(screen.queryByText('Agent 11')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '查看已归档' }))
    expect(within(table).getAllByRole('row')).toHaveLength(13)
    expect(screen.getByText('Agent 11')).not.toBeNull()
  })

  it('registry row renders factual metrics and warnings', async () => {
    const agent = makeAgent()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ agents: [{
      ...agent,
      range_metrics: { ...agent.range_metrics, run_count: 12, terminal_runs: 10, successful_runs: 8, success_rate: .8, known_input_tokens: 1200, known_output_tokens: 400, known_total_tokens: 1600, token_known_runs: 8, token_eligible_runs: 10 },
      coreai_metadata: { ...agent.coreai_metadata, verification_error: '元数据不可达' },
      sync: { ...agent.sync, current_state_error: '当前状态同步延迟' },
      warnings: [{ code: 'ASSOCIATION_MISSING', message: '业务关联待确认', local_agent_id: agent.id, coreai_run_id: null }],
    }] }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const row = screen.getByRole('rowheader', { name: /active Agent/ }).closest('tr')!
    expect(row.textContent).toContain('80%')
    expect(row.textContent).toContain('1600')
    expect(screen.getByText('元数据验证：元数据不可达')).not.toBeNull()
    expect(screen.getByText('当前同步：当前状态同步延迟')).not.toBeNull()
    expect(screen.getByText('业务关联待确认')).not.toBeNull()
  })

  it('retired rows retain history but suppress all mutation controls', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ agents: [makeAgent('retired')] }))
    vi.spyOn(api, 'getAgentRunHistory').mockResolvedValue(makeHistory())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看已归档' }))
    const row = screen.getByRole('rowheader', { name: /retired Agent/ }).closest('tr')!

    expect(within(row).getByRole('button', { name: '查看历史' })).not.toBeNull()
    expect(within(row).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(row).queryByRole('button', { name: '替换' })).toBeNull()
    expect(within(row).queryByRole('button', { name: '归档' })).toBeNull()
    expect(within(row).queryByRole('button', { name: '重新验证并启用' })).toBeNull()
  })

  it('register mutation rereads persisted snapshot', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const persisted = { ...makeAgent(), id: 'agent-new', display_name: '内容 Agent', agent_key: 'content', coreai_agent_id: 'core-content', sync_pending: true }
    const register = vi.spyOn(api, 'registerAgent').mockResolvedValue({ agent: persisted, sync_pending: true })
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: '管理 Agent' }))
    fireEvent.change(screen.getByLabelText('Core AI Agent ID'), { target: { value: 'core-content' } })
    fireEvent.change(screen.getByLabelText('Agent key'), { target: { value: 'content' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '内容 Agent' } })
    fireEvent.change(screen.getByLabelText('职责'), { target: { value: '内容运营' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并注册' }))

    await waitFor(() => expect(register).toHaveBeenCalledWith({
      coreai_agent_id: 'core-content',
      agent_key: 'content',
      display_name: '内容 Agent',
      role: '内容运营',
      sort_order: 0,
      suspect_after_seconds: 120,
    }))
    expect(await screen.findByText(/设置已保存.*active.*同步待处理/)).not.toBeNull()
  })

  it('edit disable and re-enable use exact contracts', async () => {
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const response = { agent: makeAgent(), sync_pending: false }
    const update = vi.spyOn(api, 'updateAgent').mockResolvedValue(response)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '更新名称' } })
    fireEvent.click(screen.getByRole('button', { name: '保存设置' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-active', { display_name: '更新名称', role: 'SEO 研究', sort_order: 1, suspect_after_seconds: 120 }))
    expect(await screen.findByText(/设置已保存.*无同步待处理/)).not.toBeNull()
    expect(screen.queryByText(/同步已确认/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '停用 Agent' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-active', { lifecycle_status: 'disabled' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭 Agent 管理' }))
    cleanup()
    const disabled = { ...makeAgent('disabled'), id: 'agent-disabled' }
    getWorkbench.mockResolvedValue(makeSnapshot({ agents: [disabled] }))
    update.mockResolvedValue({ agent: { ...disabled, lifecycle_status: 'active', sync_pending: true }, sync_pending: true })
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    fireEvent.click(screen.getByRole('button', { name: '重新验证并启用' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('agent-disabled', { lifecycle_status: 'active' }))
  })

  it('retire and replace require explicit confirmation', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const retire = vi.spyOn(api, 'retireAgent').mockResolvedValue({ agent: { ...makeAgent(), lifecycle_status: 'retired' }, sync_pending: false })
    const replace = vi.spyOn(api, 'replaceAgent').mockResolvedValue({ agent: { ...makeAgent(), coreai_agent_id: 'core-replacement', sync_pending: true }, sync_pending: true })
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    expect(screen.getByRole('dialog', { name: '归档 active Agent' })).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    await waitFor(() => expect(retire).toHaveBeenCalledWith('agent-active'))
    expect(screen.queryByRole('button', { name: /删除/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭 Agent 管理' }))
    fireEvent.click(screen.getByRole('button', { name: '替换' }))
    fireEvent.change(screen.getByLabelText('Core AI Agent ID'), { target: { value: 'core-replacement' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并替换' }))
    await waitFor(() => expect(replace).toHaveBeenCalledWith('agent-active', {
      coreai_agent_id: 'core-replacement',
      display_name: 'active Agent',
      role: 'SEO 研究',
      sort_order: 1,
      suspect_after_seconds: 120,
    }))
  })

  it.each(mutationKinds)('paused mutation does not bypass read pause (%s)', async kind => {
    const agent = mutationAgent(kind)
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ agents: [agent] }))
    const history = vi.spyOn(api, 'getAgentRunHistory')
    const response = mutationResponse(kind)
    const mutation = stubMutation(kind, Promise.resolve(response))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    getWorkbench.mockClear()
    submitMutation(kind)
    expect(await screen.findByText(/页面仍为暂停快照/)).not.toBeNull()
    expect(screen.getByText(new RegExp(`设置已保存.*${response.agent.lifecycle_status}.*${response.sync_pending ? '同步待处理' : '无同步待处理'}`))).not.toBeNull()
    expectExactMutationCall(kind, mutation)
    expect(getWorkbench).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'duplicate', message: 'Agent 已存在', code: 'DUPLICATE', field: 'agent_key', fieldLabel: 'Agent key', fieldMessage: 'Agent key 已被使用' },
    { label: 'inaccessible', message: 'Core AI Agent 不可访问', code: 'INACCESSIBLE', field: 'coreai_agent_id', fieldLabel: 'Core AI Agent ID', fieldMessage: '当前操作员无权访问' },
    { label: 'unpublished', message: 'Core AI Agent 尚未发布', code: 'UNPUBLISHED', field: 'coreai_agent_id', fieldLabel: 'Core AI Agent ID', fieldMessage: '请先发布 Agent' },
    { label: 'form', message: '设置未保存', code: 'INVALID', field: null, fieldLabel: null, fieldMessage: null },
  ])('structured mutation errors bind fields ($label)', async ({ message, code, field, fieldLabel, fieldMessage }) => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    vi.spyOn(api, 'registerAgent').mockRejectedValue(new ApiError(message, 409, code, field && fieldMessage ? { [field]: fieldMessage } : {}))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    submitMutation('register')
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(message)
    if (field && fieldLabel && fieldMessage) {
      expect(screen.getByLabelText(fieldLabel).getAttribute('aria-describedby')).toBe(`agent-manager-${field}-error`)
      expect(screen.getByText(fieldMessage)).not.toBeNull()
    }
  })

  it('drawer portal stays outside inert application root', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const view = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '管理 Agent' }))
    const dialog = screen.getByRole('dialog', { name: '注册 Agent' })
    expect(dialog.closest('.agent-workbench__portal')?.parentElement).toBe(document.body)
    expect(view.container.contains(dialog)).toBe(false)
  })

  it.each([
    { mode: 'register', opener: '管理 Agent', target: 'Core AI Agent ID' },
    { mode: 'edit', opener: '编辑', target: '显示名称' },
    { mode: 'replace', opener: '替换', target: 'Core AI Agent ID' },
    { mode: 'retire', opener: '归档', target: '归档 active Agent' },
  ])('drawer mode chooses deterministic initial focus ($mode)', async ({ opener, target }) => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: opener }))
    await act(async () => { await Promise.resolve() })
    expect(document.activeElement).toBe(
      target === '归档 active Agent'
        ? screen.getByRole('heading', { name: target })
        : screen.getByLabelText(target),
    )
  })

  it('drawer explicit focus handler wraps forward', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '管理 Agent' }))
    const submit = screen.getByRole('button', { name: '验证并注册' })
    submit.focus()
    fireEvent.keyDown(submit, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭 Agent 管理' }))
  })

  it('drawer explicit focus handler wraps backward', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const opener = screen.getByRole('button', { name: '管理 Agent' })
    fireEvent.click(opener)
    const close = screen.getByRole('button', { name: '关闭 Agent 管理' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '验证并注册' }))
  })

  it.each(['none', 'attribute', 'property'] as const)('drawer restores preexisting inert state (%s)', async priorState => {
    const root = document.createElement('div')
    root.id = 'root'
    if (priorState === 'attribute') root.setAttribute('inert', '')
    if (priorState === 'property') Object.defineProperty(root, 'inert', { configurable: true, writable: true, value: true })
    document.body.appendChild(root)
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    render(<AgentWorkbench />, { container: root })
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '管理 Agent' }))
    expect(root.hasAttribute('inert')).toBe(true)
    if (priorState === 'property') expect((root as HTMLElement & { inert: boolean }).inert).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '关闭 Agent 管理' }))
    expect(root.hasAttribute('inert')).toBe(priorState === 'attribute')
    if (priorState === 'property') expect((root as HTMLElement & { inert: boolean }).inert).toBe(true)
    root.remove()
  })

  it('drawer escape restores opener during pending request', async () => {
    const mutation = deferred<{ agent: ReturnType<typeof makeAgent>; sync_pending: boolean }>()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    vi.spyOn(api, 'registerAgent').mockReturnValue(mutation.promise)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const opener = screen.getByRole('button', { name: '管理 Agent' })
    fireEvent.click(opener)
    fireEvent.change(screen.getByLabelText('Core AI Agent ID'), { target: { value: 'core-pending' } })
    fireEvent.change(screen.getByLabelText('Agent key'), { target: { value: 'pending' } })
    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Pending' } })
    fireEvent.change(screen.getByLabelText('职责'), { target: { value: 'Pending' } })
    fireEvent.click(screen.getByRole('button', { name: '验证并注册' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
    mutation.resolve({ agent: makeAgent(), sync_pending: false })
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText(/设置已保存/)).toBeNull()
  })

  it('expansion loads first local history page', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const history = vi.spyOn(api, 'getAgentRunHistory').mockResolvedValue({
      items: [{
        coreai_run_id: 'history-run-1', raw_status: 'COMPLETED', presentation_group: 'success', trigger_type: 'SCHEDULED',
        started_at: '2026-09-06T00:00:00.000Z', effective_started_at: '2026-09-06T00:00:00.000Z', completed_at: '2026-09-06T00:01:00.000Z', terminal_observed_at: '2026-09-06T00:01:01.000Z', receipt_expires_at: null,
        elapsed_seconds: 60, duration_seconds: 60, input_tokens: 10, output_tokens: 5, total_tokens: 15, token_state: 'known', last_synced_at: '2026-09-06T00:01:02.000Z', suspect: false, suspect_reason: null, archiving: false, archive_delayed: false, warning_codes: [], association: null, error_summary: null,
      }],
      next_before: null, range: '30d', timezone: 'Asia/Shanghai', range_start: null, range_end: '2026-09-06T01:00:00.000Z',
    })
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))

    await waitFor(() => expect(history).toHaveBeenCalledWith('agent-active', '30d', 20, null, expect.any(AbortSignal)))
    expect(await screen.findByText('history-run-1')).not.toBeNull()
  })

  it('initial history read failure is distinct from an exact zero result', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    vi.spyOn(api, 'getAgentRunHistory').mockRejectedValue(new Error('已清理的历史读取错误'))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))

    expect(await screen.findByText('已清理的历史读取错误')).not.toBeNull()
    expect(screen.queryByText('此范围暂无已镜像 Run')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('load-more history failure preserves cached items and exposes the read error', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    vi.spyOn(api, 'getAgentRunHistory')
      .mockResolvedValueOnce(makeHistory('30d', { next_before: 'cursor-2' }))
      .mockRejectedValueOnce(new Error('载入更多暂不可用'))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')

    fireEvent.click(screen.getByRole('button', { name: '载入更多' }))

    expect(await screen.findByText('载入更多暂不可用')).not.toBeNull()
    expect(screen.getByText('history-run-1')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('history cursor appends only matching response', async () => {
    const obsolete = deferred<AgentRunHistory>()
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(makeSnapshot())
      .mockResolvedValueOnce(makeSnapshot({ range: '7d' }))
    const history = vi.spyOn(api, 'getAgentRunHistory')
      .mockResolvedValueOnce(makeHistory('30d', { next_before: 'cursor-1' }))
      .mockReturnValueOnce(obsolete.promise)
      .mockResolvedValueOnce(makeHistory('7d', { items: [makeHistoryItem({ coreai_run_id: 'new-range-run' })] }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')
    fireEvent.click(screen.getByRole('button', { name: '载入更多' }))
    expect(history).toHaveBeenNthCalledWith(2, 'agent-active', '30d', 20, 'cursor-1', expect.any(AbortSignal))
    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    await waitFor(() => expect(history).toHaveBeenCalledTimes(3))
    expect(await screen.findByText('new-range-run')).not.toBeNull()
    obsolete.resolve(makeHistory('30d', { items: [makeHistoryItem({ coreai_run_id: 'obsolete-run' })] }))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByText('obsolete-run')).toBeNull()
  })

  it('paused range change performs zero aggregate and history reads', async () => {
    const aggregate = vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const history = vi.spyOn(api, 'getAgentRunHistory').mockResolvedValue(makeHistory())
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    await act(async () => { await Promise.resolve() })
    expect(aggregate).toHaveBeenCalledTimes(1)
    expect(history).toHaveBeenCalledTimes(1)
    expect(screen.getByText('已选择近 7 天 · 当前仍显示近 30 天数据')).not.toBeNull()
  })

  it('paused manual refresh and history controls permit only one read', async () => {
    const aggregate = vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(makeSnapshot())
      .mockResolvedValueOnce(makeSnapshot({ range: '7d' }))
    const history = vi.spyOn(api, 'getAgentRunHistory').mockResolvedValue(makeHistory('30d', { next_before: 'cursor' }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    expect(await screen.findByText('历史仍为 30d · 当前页面为 7d')).not.toBeNull()
    expect(aggregate).toHaveBeenCalledTimes(2)
    expect(history).toHaveBeenCalledTimes(1)
    expect((screen.getByRole('button', { name: '载入更多' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('resume reloads expanded history after aggregate acceptance', async () => {
    const resumed = deferred<AgentWorkbenchSnapshot>()
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValueOnce(makeSnapshot()).mockReturnValueOnce(resumed.promise)
    const history = vi.spyOn(api, 'getAgentRunHistory')
      .mockResolvedValueOnce(makeHistory())
      .mockResolvedValueOnce(makeHistory('7d', { items: [makeHistoryItem({ coreai_run_id: 'resumed-run' })] }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    fireEvent.click(screen.getByRole('radio', { name: '近 7 天' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复自动更新' }))
    expect(history).toHaveBeenCalledTimes(1)
    resumed.resolve(makeSnapshot({ range: '7d' }))
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('resumed-run')).not.toBeNull()
  })

  it('failed resume keeps history paused until a later aggregate is accepted', async () => {
    const failedResume = deferred<AgentWorkbenchSnapshot>()
    const acceptedResume = deferred<AgentWorkbenchSnapshot>()
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(makeSnapshot())
      .mockReturnValueOnce(failedResume.promise)
      .mockReturnValueOnce(acceptedResume.promise)
    const history = vi.spyOn(api, 'getAgentRunHistory')
      .mockResolvedValueOnce(makeHistory())
      .mockResolvedValueOnce(makeHistory('30d', { items: [makeHistoryItem({ coreai_run_id: 'accepted-resume-run' })] }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    await screen.findByText('history-run-1')
    fireEvent.click(screen.getByRole('button', { name: '暂停自动更新' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复自动更新' }))

    failedResume.reject(new Error('恢复读取失败'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(screen.getByRole('button', { name: '恢复自动更新' })).not.toBeNull()
    expect(screen.getByText(/自动更新已暂停 · 数据截至/)).not.toBeNull()
    expect(history).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '恢复自动更新' }))
    expect(history).toHaveBeenCalledTimes(1)
    acceptedResume.resolve(makeSnapshot())
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('accepted-resume-run')).not.toBeNull()
    expect(screen.getByRole('button', { name: '暂停自动更新' })).not.toBeNull()
  })

  it('history item exposes factual fields and warning badges', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    vi.spyOn(api, 'getAgentRunHistory').mockResolvedValue(makeHistory('30d', { items: [makeHistoryItem({
      coreai_run_id: 'history-facts-id',
      raw_status: null,
      presentation_group: 'unknown',
      trigger_type: null,
      token_state: 'unconfirmed',
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      association: { kind: 'run', source_local_id: 9, merchant_id: 2, merchant_name: 'Bear', local_href: '/runs/9', local_label: '本地 Run #9' },
      error_summary: '已清理的错误摘要',
      warning_codes: ['LOCAL_TRIGGER_STATUS_MISSING', 'TERMINAL_STATUS_CONFLICT', 'TOKEN_USAGE_INVALID'],
      archive_delayed: true,
    })] }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: '查看历史' }))
    expect(await screen.findByText('状态待确认（上游未返回状态）')).not.toBeNull()
    expect(screen.getByText('NULL · unknown')).not.toBeNull()
    expect(screen.getByText('触发来源待确认')).not.toBeNull()
    expect(screen.getByText('状态确认后判断')).not.toBeNull()
    expect(screen.getByRole('link', { name: '本地 Run #9' }).getAttribute('href')).toBe('/runs/9')
    expect(screen.getByText('已清理的错误摘要')).not.toBeNull()
    for (const warning of ['状态待确认', '状态冲突', 'Token 数据异常', '归档延迟']) expect(screen.getByText(warning)).not.toBeNull()
    expect(screen.getByRole('button', { name: '复制完整 Run ID history-facts-id' })).not.toBeNull()
  })

  it.each(mutationKinds)('running mutations linearize aggregate readback after write (%s)', async kind => {
    vi.useFakeTimers()
    const oldRead = deferred<AgentWorkbenchSnapshot>()
    const readback = deferred<AgentWorkbenchSnapshot>()
    const mutationResult = deferred<AgentMutationResponse>()
    const signals: AbortSignal[] = []
    const events: string[] = []
    let openAggregateReads = 0
    let maxAggregateConcurrency = 0
    const aggregate = vi.spyOn(api, 'getAgentWorkbench').mockImplementation((_range, signal) => {
      signals.push(signal)
      if (signals.length === 1) return Promise.resolve(makeSnapshot({ agents: [mutationAgent(kind)], refresh_after_ms: 1_000 }))
      openAggregateReads += 1
      maxAggregateConcurrency = Math.max(maxAggregateConcurrency, openAggregateReads)
      if (signals.length === 2) {
        events.push('old-read-started')
        return oldRead.promise.finally(() => { openAggregateReads -= 1; events.push('old-read-settled') })
      }
      events.push('successor-started')
      return readback.promise
    })
    const mutation = stubMutation(kind, mutationResult.promise)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(aggregate).toHaveBeenCalledTimes(2)
    submitMutation(kind)
    expectExactMutationCall(kind, mutation)
    const response = mutationResponse(kind)
    events.push('mutation-resolved')
    mutationResult.resolve(response)
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(new RegExp(`设置已保存.*${response.agent.lifecycle_status}.*${response.sync_pending ? '同步待处理' : '无同步待处理'}`))).not.toBeNull()
    expect(signals[1].aborted).toBe(true)
    expect(aggregate).toHaveBeenCalledTimes(2)
    oldRead.resolve(makeSnapshot({ summary: { ...makeSnapshot().summary, run_count: 99 } }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(aggregate).toHaveBeenCalledTimes(3)
    expect(screen.queryByLabelText('Run 数 99')).toBeNull()
    expect(events.indexOf('successor-started')).toBeGreaterThan(events.indexOf('old-read-settled'))
    expect(events.indexOf('successor-started')).toBeGreaterThan(events.indexOf('mutation-resolved'))
    expect(maxAggregateConcurrency).toBe(1)
    readback.resolve(makeSnapshot({ agents: [{ ...mutationAgent(kind), ...response.agent }], summary: { ...makeSnapshot().summary, run_count: 1 } }))
    await act(async () => { await Promise.resolve() })
    expect(screen.getByLabelText('Run 数 1')).not.toBeNull()
  })

  it('running mutations linearize aggregate readback after write (mutation error)', async () => {
    vi.useFakeTimers()
    const oldRead = deferred<AgentWorkbenchSnapshot>()
    const mutationResult = deferred<AgentMutationResponse>()
    const signals: AbortSignal[] = []
    const aggregate = vi.spyOn(api, 'getAgentWorkbench').mockImplementation((_range, signal) => {
      signals.push(signal)
      return signals.length === 1 ? Promise.resolve(makeSnapshot({ refresh_after_ms: 1_000 })) : oldRead.promise
    })
    stubMutation('register', mutationResult.promise)
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    submitMutation('register')

    mutationResult.reject(new Error('变更未保存'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toBe('变更未保存')
    expect(signals[1].aborted).toBe(false)
    expect(aggregate).toHaveBeenCalledTimes(2)

    oldRead.resolve(makeSnapshot())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(aggregate).toHaveBeenCalledTimes(2)
  })

  it('running mutations linearize aggregate readback after write (successful successor failure)', async () => {
    vi.useFakeTimers()
    const oldRead = deferred<AgentWorkbenchSnapshot>()
    const failedReadback = deferred<AgentWorkbenchSnapshot>()
    const retry = deferred<AgentWorkbenchSnapshot>()
    const signals: AbortSignal[] = []
    const aggregate = vi.spyOn(api, 'getAgentWorkbench').mockImplementation((_range, signal) => {
      signals.push(signal)
      if (signals.length === 1) return Promise.resolve(makeSnapshot({ refresh_after_ms: 1_000 }))
      if (signals.length === 2) return oldRead.promise
      if (signals.length === 3) return failedReadback.promise
      return retry.promise
    })
    stubMutation('register', Promise.resolve(mutationResponse('register')))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    submitMutation('register')
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/设置已保存.*同步待处理/)).not.toBeNull()
    oldRead.resolve(makeSnapshot())
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(aggregate).toHaveBeenCalledTimes(3)

    failedReadback.reject(new Error('变更后的读取失败'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/设置已保存.*同步待处理/)).not.toBeNull()
    expect(screen.getByText('变更后的读取失败')).not.toBeNull()
    expect(screen.getByText('当前状态待确认')).not.toBeNull()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(aggregate).toHaveBeenCalledTimes(4)
    retry.resolve(makeSnapshot())
  })

  it('initial read failure leaves loading state and keeps the error non-assertive', async () => {
    vi.useFakeTimers()
    const firstRead = deferred<AgentWorkbenchSnapshot>()
    const retry = deferred<AgentWorkbenchSnapshot>()
    const getWorkbench = vi.spyOn(api, 'getAgentWorkbench')
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(retry.promise)
    const { container } = render(<AgentWorkbench />)
    expect(screen.getByText('正在载入 Agent 状态')).not.toBeNull()

    firstRead.reject(new Error('本地快照暂不可读'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })

    expect(screen.queryByText('正在载入 Agent 状态')).toBeNull()
    expect(screen.getByText('Agent 状态暂不可用 · 等待自动重试')).not.toBeNull()
    expect(screen.getByText('本地快照暂不可读')).not.toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(29_999) })
    expect(screen.queryByText('正在载入 Agent 状态')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(getWorkbench).toHaveBeenCalledTimes(2)
    expect(screen.getByText('正在载入 Agent 状态')).not.toBeNull()
    retry.reject(new DOMException('aborted', 'AbortError'))
  })

  it('one polite region announces new Runs, terminal transitions, and copy completion', async () => {
    const runningA = makeSignal({ coreai_run_id: 'run-a' })
    const runningB = makeSignal({ coreai_run_id: 'run-b', local_agent_id: 'agent-2', agent_name: '执行 Agent' })
    const completedA = makeSignal({
      coreai_run_id: 'run-a',
      raw_status: 'COMPLETED',
      presentation_group: 'success',
      signal_state: 'completed',
      fresh: false,
      completed_at: '2026-09-06T01:00:02.000Z',
      terminal_observed_at: '2026-09-06T01:00:02.000Z',
      receipt_expires_at: '2026-09-06T01:00:12.000Z',
    })
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(liveSnapshot({ signals: [runningA] }))
      .mockResolvedValueOnce(liveSnapshot({ signals: [runningA, runningB], current_counts: { running: exactCount(2), queued: exactCount(0), waiting: exactCount(0), legacy_nonterminal: exactCount(0) } }))
      .mockResolvedValueOnce(liveSnapshot({ signals: [completedA, runningB], current_counts: { running: exactCount(1), queued: exactCount(0), waiting: exactCount(0), legacy_nonterminal: exactCount(0) } }))
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })

    const { container } = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByText(/发现新的 Run：run-b/).textContent).toContain('手动刷新完成')

    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await waitFor(() => expect(screen.getByText(/Run run-a 已变为终态：COMPLETED/).textContent).toContain('手动刷新完成'))

    fireEvent.click(screen.getByRole('button', { name: '复制完整 Run ID run-a' }))
    await waitFor(() => expect(screen.getByText('已复制 Run ID：run-a')).not.toBeNull())
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
  })

  it('the polite event region announces freshness loss and restoration', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'getAgentWorkbench')
      .mockResolvedValueOnce(makeSnapshot({ fresh_until: '2026-09-06T01:00:01.250Z' }))
      .mockResolvedValueOnce(makeSnapshot({ snapshot_at: '2026-09-06T01:00:02.000Z', fresh_until: '2026-09-06T01:01:32.000Z' }))

    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_250) })
    expect(screen.getByText('当前状态新鲜度已失效')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    await act(async () => { await vi.advanceTimersByTimeAsync(100) })
    expect(screen.getByText(/当前状态新鲜度已恢复/).textContent).toContain('手动刷新完成')
  })

  it('serializes a delayed copy after a completed network announcement', async () => {
    const copy = deferred<void>()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockReturnValue(copy.promise) },
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({ signals: [makeSignal({ coreai_run_id: 'run-delayed-copy' })] }))
    const { container } = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]')!
    const mutations: string[] = []
    const observer = new MutationObserver(() => mutations.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })

    fireEvent.click(screen.getByRole('button', { name: '复制完整 Run ID run-delayed-copy' }))
    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await waitFor(() => expect(mutations.some(value => value.includes('手动刷新完成'))).toBe(true))
    copy.resolve()
    await waitFor(() => expect(mutations.some(value => value.includes('已复制 Run ID：run-delayed-copy'))).toBe(true))

    const manualIndex = mutations.findIndex(value => value.includes('手动刷新完成'))
    const copyIndex = mutations.findIndex(value => value.includes('已复制 Run ID：run-delayed-copy'))
    expect(manualIndex).toBeGreaterThanOrEqual(0)
    expect(copyIndex).toBeGreaterThan(manualIndex)
    observer.disconnect()
  })

  it('mutates the polite region for repeated identical manual refresh completions', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot())
    const { container } = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]')!
    const mutations: string[] = []
    const observer = new MutationObserver(() => mutations.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })

    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await waitFor(() => expect(mutations.filter(value => value.includes('手动刷新完成'))).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '刷新显示' }))
    await waitFor(() => expect(mutations.filter(value => value.includes('手动刷新完成'))).toHaveLength(2))
    expect(mutations[1]).not.toBe(mutations[0])
    observer.disconnect()
  })

  it('mutates the polite region for repeated copy completion of the same Run', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({ signals: [makeSignal({ coreai_run_id: 'run-repeat-copy' })] }))
    const { container } = render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    const region = container.querySelector<HTMLElement>('[aria-live="polite"]')!
    const mutations: string[] = []
    const observer = new MutationObserver(() => mutations.push(region.textContent ?? ''))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    const copyButton = screen.getByRole('button', { name: '复制完整 Run ID run-repeat-copy' })

    fireEvent.click(copyButton)
    await waitFor(() => expect(mutations.filter(value => value.includes('已复制 Run ID：run-repeat-copy'))).toHaveLength(1))
    fireEvent.click(copyButton)
    await waitFor(() => expect(mutations.filter(value => value.includes('已复制 Run ID：run-repeat-copy'))).toHaveLength(2))
    expect(mutations[1]).not.toBe(mutations[0])
    observer.disconnect()
  })

  it('sync health unavailable keeps persisted data static', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(liveSnapshot({
      sync_health: 'unavailable',
      stale: true,
      fresh_until: null,
      agents: [makeAgent()],
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })

    expect(screen.getByText('实时同步不可用 · 显示已保存数据')).not.toBeNull()
    expect(screen.getByText('active Agent')).not.toBeNull()
    expect(screen.getByRole('tab', { name: /研究 Agent/ }).classList.contains('agent-workbench__signal--motion')).toBe(false)
    expect(screen.queryByText('当前全部空闲')).toBeNull()
  })

  it('no-record notice is distinct from idle', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({ agents: [], sync_health: 'not_configured', current_state_complete: null }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('尚未注册 SEO Ops Agent')).not.toBeNull()
    expect(screen.getByRole('button', { name: '管理 Agent' })).not.toBeNull()
    expect(screen.queryByText('当前全部空闲')).toBeNull()
  })

  it('disabled-only notice retains legacy signals', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      agents: [makeAgent('disabled')],
      signals: [makeSignal({ lifecycle_status: 'disabled', fresh: false })],
      current_state_complete: null,
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('当前没有启用的 Agent')).not.toBeNull()
    expect(screen.getByRole('tab', { name: /研究 Agent/ })).not.toBeNull()
    expect(screen.queryByText('当前全部空闲')).toBeNull()
  })

  it('retired-only notice retains archived signals', async () => {
    vi.spyOn(api, 'getAgentWorkbench').mockResolvedValue(makeSnapshot({
      agents: [makeAgent('retired')],
      signals: [makeSignal({ lifecycle_status: 'retired', fresh: false })],
      current_state_complete: null,
    }))
    render(<AgentWorkbench />)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText('当前没有在册 Agent')).not.toBeNull()
    expect(screen.getByRole('link', { name: '查看已归档' })).not.toBeNull()
    expect(screen.getByRole('tab', { name: /研究 Agent/ })).not.toBeNull()
  })

  it('stage renders tabs and one selected panel', () => {
    const signals = [
      makeSignal({ coreai_run_id: 'run-a', agent_name: 'Agent A' }),
      makeSignal({ coreai_run_id: 'run-b', agent_name: 'Agent B' }),
      makeSignal({ coreai_run_id: 'run-c', agent_name: 'Agent C' }),
    ]
    render(<LiveRunStage presentation={present(liveSnapshot({ signals, current_counts: { running: exactCount(3), queued: exactCount(0), waiting: exactCount(0), legacy_nonterminal: exactCount(0) } }))} />)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(3)
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1)
    expect(tabs[0].getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id)
    tabs[0].focus()
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: /Agent C/ }).getAttribute('aria-selected')).toBe('true')
  })

  it('stage detail exposes every factual field', () => {
    const signal = makeSignal({
      coreai_run_id: 'run-complete-1234567890',
      association: { kind: 'run', source_local_id: 9, merchant_id: 2, merchant_name: '可可小卤', local_href: '/runs/9', local_label: '可可小卤 · Run 9' },
      trigger_type: 'TASK_EXECUTION',
      token_state: 'known',
      input_tokens: 1200,
      output_tokens: 300,
      total_tokens: 1500,
    })
    render(<LiveRunStage presentation={present(liveSnapshot({ signals: [signal] }))} />)
    expect(screen.getAllByText('研究 Agent').length).toBeGreaterThan(0)
    expect(screen.getByText('研究任务')).not.toBeNull()
    expect(screen.getByRole('link', { name: '可可小卤 · Run 9' }).getAttribute('href')).toBe('/runs/9')
    expect(screen.getByText('TASK_EXECUTION')).not.toBeNull()
    expect(screen.getByText(/1500 Tokens/)).not.toBeNull()
    expect(screen.getByLabelText('完整 Run ID run-complete-1234567890')).not.toBeNull()
    expect(screen.getByRole('button', { name: '复制完整 Run ID run-complete-1234567890' })).not.toBeNull()
    const time = screen.getByText(/已持续 60 秒/).closest('time')
    expect(time?.getAttribute('datetime')).toBe(signal.effective_started_at)
    expect(time?.getAttribute('aria-live')).toBe('off')
    expect(screen.getByText(/上次成功同步/)).not.toBeNull()
  })

  it('stage headline respects current-count quality', () => {
    const signals = [
      makeSignal({ coreai_run_id: 'run-1', local_agent_id: 'agent-a' }),
      makeSignal({ coreai_run_id: 'run-2', local_agent_id: 'agent-a' }),
      makeSignal({ coreai_run_id: 'run-3', local_agent_id: 'agent-b' }),
      makeSignal({ coreai_run_id: 'run-q', local_agent_id: 'agent-c', raw_status: 'PENDING', presentation_group: 'queued', signal_state: 'queued' }),
      makeSignal({ coreai_run_id: 'run-w', local_agent_id: 'agent-d', raw_status: 'PAUSED', presentation_group: 'waiting', signal_state: 'waiting' }),
      makeSignal({ coreai_run_id: 'run-archive', signal_state: 'archiving', raw_status: 'COMPLETED', presentation_group: 'success', fresh: false }),
    ]
    const presentation = present(liveSnapshot({
      signals,
      current_counts: { running: exactCount(3), queued: exactCount(1), waiting: exactCount(1), legacy_nonterminal: exactCount(0) },
    }))
    const { rerender } = render(<LiveRunStage presentation={presentation} />)
    expect(screen.getByText('2 个 Agent · 3 个 Run 进行中')).not.toBeNull()
    expect(screen.getByText('1 个排队')).not.toBeNull()
    expect(screen.getByText('1 个等待输入')).not.toBeNull()
    expect(screen.getByText('1 个归档中')).not.toBeNull()

    rerender(<LiveRunStage presentation={{ ...presentation, current_counts: { ...presentation.current_counts, running: { ...presentation.current_counts.running, quality: 'lower_bound', value: 3, copy: '至少 3', exact_owner_claim_allowed: false } } }} />)
    expect(screen.getByText('已看到 2 个 Agent · 至少 3 个 Run 进行中')).not.toBeNull()

    rerender(<LiveRunStage presentation={{ ...presentation, current_counts: { ...presentation.current_counts, running: { ...presentation.current_counts.running, quality: 'unknown', value: null, copy: '当前数量未知', claim_is_current: false, exact_owner_claim_allowed: false } } }} />)
    expect(screen.getByText('已看到 2 个 Agent 的运行记录 · 当前数量未知')).not.toBeNull()
  })

  it('owner headlines exclude ineligible raw RUNNING rows from current claims', () => {
    const signals = [
      makeSignal({ coreai_run_id: 'eligible', local_agent_id: 'owner-current' }),
      makeSignal({ coreai_run_id: 'stale', local_agent_id: 'owner-stale', fresh: false }),
      makeSignal({ coreai_run_id: 'uncertain', local_agent_id: 'owner-uncertain', signal_state: 'uncertain' }),
      makeSignal({ coreai_run_id: 'disabled', local_agent_id: 'owner-disabled', lifecycle_status: 'disabled' }),
      makeSignal({ coreai_run_id: 'retired', local_agent_id: 'owner-retired', lifecycle_status: 'retired' }),
    ]
    const presentation = present(liveSnapshot({
      signals,
      current_counts: { running: exactCount(1), queued: exactCount(0), waiting: exactCount(0), legacy_nonterminal: exactCount(0) },
    }))
    const { rerender } = render(<LiveRunStage presentation={presentation} />)
    expect(screen.getByText('1 个 Agent · 1 个 Run 进行中')).not.toBeNull()

    rerender(<LiveRunStage presentation={{
      ...presentation,
      current_counts: {
        ...presentation.current_counts,
        running: { ...presentation.current_counts.running, quality: 'lower_bound', value: 1, copy: '至少 1', exact_owner_claim_allowed: false },
      },
    }} />)
    expect(screen.getByText('已看到 1 个 Agent · 至少 1 个 Run 进行中')).not.toBeNull()

    rerender(<LiveRunStage presentation={{
      ...presentation,
      current_counts: {
        ...presentation.current_counts,
        running: { ...presentation.current_counts.running, quality: 'unknown', value: null, copy: '当前数量未知', claim_is_current: false, exact_owner_claim_allowed: false },
      },
    }} />)
    expect(screen.getByText('已看到 3 个 Agent 的运行记录 · 当前数量未知')).not.toBeNull()
  })

  it('unknown and legacy signals remain static', () => {
    const presentation = present(makeSnapshot({
      signals: [
        makeSignal({ coreai_run_id: 'unknown', raw_status: 'AWAITING_REVIEW', presentation_group: 'unknown', signal_state: 'uncertain', fresh: false }),
        makeSignal({ coreai_run_id: 'missing', raw_status: null, presentation_group: 'unknown', signal_state: 'uncertain', lifecycle_status: 'retired', fresh: false }),
      ],
      current_state_complete: false,
    }))
    render(<LiveRunStage presentation={presentation} />)
    expect(screen.getByRole('tab', { name: /未知状态（AWAITING_REVIEW）/ }).classList.contains('agent-workbench__signal--motion')).toBe(false)
    expect(screen.getByRole('tab', { name: /状态待确认（上游未返回状态）/ }).classList.contains('agent-workbench__signal--motion')).toBe(false)
  })

  it.each([
    ['qualified', {}, true, '运行中'],
    ['pending', { raw_status: 'PENDING', presentation_group: 'queued', signal_state: 'queued' }, false, '排队中'],
    ['paused', { raw_status: 'PAUSED', presentation_group: 'waiting', signal_state: 'waiting' }, false, '等待输入'],
    ['completed', { raw_status: 'COMPLETED', presentation_group: 'success', signal_state: 'completed', fresh: false }, false, '已完成'],
    ['failed', { raw_status: 'FAILED', presentation_group: 'failure', signal_state: 'completed', fresh: false }, false, '失败'],
    ['timeout', { raw_status: 'TIMEOUT', presentation_group: 'failure', signal_state: 'completed', fresh: false }, false, '超时'],
    ['cancelled', { raw_status: 'CANCELLED', presentation_group: 'cancelled', signal_state: 'completed', fresh: false }, false, '已取消'],
    ['skipped', { raw_status: 'SKIPPED', presentation_group: 'skipped', signal_state: 'completed', fresh: false }, false, '已跳过'],
    ['archiving', { raw_status: 'COMPLETED', presentation_group: 'success', signal_state: 'archiving', fresh: false }, false, '已完成'],
    ['uncertain', { signal_state: 'uncertain' }, false, '状态待确认'],
    ['stale', { fresh: false }, false, '状态为 RUNNING'],
    ['incomplete', { agent_current_state_complete: false }, false, '运行中'],
    ['suspect', { suspect: true }, false, '运行中'],
    ['disabled', { lifecycle_status: 'disabled' }, false, '运行中'],
    ['retired', { lifecycle_status: 'retired' }, false, '运行中'],
  ])('only qualified running signal has motion (%s)', (_name, overrides, expected, statusCopy) => {
    const signal = makeSignal(overrides as Partial<WorkbenchSignal>)
    render(<LiveRunStage presentation={present(liveSnapshot({ signals: [signal] }))} />)
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(expected)
    expect(screen.getByRole('tab').textContent).toContain(statusCopy)
  })

  it.each([
    ['metadata warning only', (() => {
      const agent = makeAgent()
      return liveSnapshot({ agents: [{ ...agent, coreai_metadata: { ...agent.coreai_metadata, verification_error: 'metadata endpoint unavailable' } }] })
    })()],
    ['another Agent stale', (() => {
      const healthy = makeAgent()
      const stale = makeAgent()
      return liveSnapshot({
        sync_health: 'partial',
        stale: true,
        agents: [healthy, { ...stale, id: 'agent-other', lifecycle_status: 'active', current_state_complete: false, sync: { ...stale.sync, health: 'stale' } }],
      })
    })()],
  ])('independently healthy RUNNING motion survives %s', (_name, snapshot) => {
    render(<LiveRunStage presentation={present(snapshot as AgentWorkbenchSnapshot)} />)
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(true)
  })

  it.each([
    ['PENDING', { raw_status: 'PENDING', presentation_group: 'queued', signal_state: 'queued' }, '排队中', '已派发 / 等待执行'],
    ['RUNNING', {}, '运行中', 'Core AI Run 进行中'],
    ['PAUSED', { raw_status: 'PAUSED', presentation_group: 'waiting', signal_state: 'waiting' }, '等待输入', '等待输入'],
    ['uncertain', { signal_state: 'uncertain' }, '状态待确认', null],
    ['archiving', { raw_status: 'COMPLETED', presentation_group: 'success', signal_state: 'archiving', fresh: false }, '已完成', 'SEO Ops 归档中'],
    ['COMPLETED', { raw_status: 'COMPLETED', presentation_group: 'success', signal_state: 'completed', fresh: false }, '已完成', '已完成'],
    ['FAILED', { raw_status: 'FAILED', presentation_group: 'failure', signal_state: 'completed', fresh: false }, '失败', '失败'],
    ['TIMEOUT', { raw_status: 'TIMEOUT', presentation_group: 'failure', signal_state: 'completed', fresh: false }, '超时', '超时'],
    ['CANCELLED', { raw_status: 'CANCELLED', presentation_group: 'cancelled', signal_state: 'completed', fresh: false }, '已取消', '已取消'],
    ['SKIPPED', { raw_status: 'SKIPPED', presentation_group: 'skipped', signal_state: 'completed', fresh: false }, '已跳过', '已跳过'],
    ['stale PAUSED', { raw_status: 'PAUSED', presentation_group: 'waiting', signal_state: 'waiting', fresh: false }, '等待输入', null],
  ])('status and verified lifecycle matrix: %s', (_name, overrides, statusCopy, currentLabel) => {
    const signal = makeSignal(overrides as Partial<WorkbenchSignal>)
    render(<LiveRunStage presentation={present(liveSnapshot({ signals: [signal] }))} />)
    expect(screen.getByRole('tab').textContent).toContain(statusCopy)
    const current = screen.getByRole('tabpanel').querySelector('[aria-current="step"]')
    expect(current?.textContent ?? null).toBe(currentLabel)
  })

  it('idle requires fresh complete exact active proof', () => {
    const { rerender } = render(<LiveRunStage presentation={present(makeSnapshot())} />)
    expect(screen.getByText('当前全部空闲')).not.toBeNull()
    expect(screen.getByText('等待下一次派发')).not.toBeNull()

    const denied = [
      present(makeSnapshot({ agents: [] })),
      present(makeSnapshot({ stale: true, sync_health: 'stale' })),
      present(makeSnapshot({ current_state_complete: false })),
      present(liveSnapshot()),
    ]
    for (const presentation of denied) {
      rerender(<LiveRunStage presentation={presentation} />)
      expect(screen.queryByText('当前全部空闲')).toBeNull()
    }
  })
})

// @vitest-environment jsdom

import { StrictMode, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type AgentWorkbenchSnapshot, type CurrentCount, type WorkbenchAgent, type WorkbenchSignal } from './api'
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
    ['qualified', {}, true],
    ['pending', { raw_status: 'PENDING', presentation_group: 'queued', signal_state: 'queued' }, false],
    ['stale', { fresh: false }, false],
    ['incomplete', { agent_current_state_complete: false }, false],
    ['suspect', { suspect: true }, false],
    ['disabled', { lifecycle_status: 'disabled' }, false],
    ['retired', { lifecycle_status: 'retired' }, false],
  ])('only qualified running signal has motion (%s)', (_name, overrides, expected) => {
    const signal = makeSignal(overrides as Partial<WorkbenchSignal>)
    render(<LiveRunStage presentation={present(liveSnapshot({ signals: [signal] }))} />)
    expect(screen.getByRole('tab').classList.contains('agent-workbench__signal--motion')).toBe(expected)
    expect(screen.getByRole('tab').textContent).toContain(signal.raw_status === 'PENDING' ? '排队中' : '运行中')
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

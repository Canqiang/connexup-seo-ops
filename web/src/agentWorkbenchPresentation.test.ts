import { describe, expect, it } from 'vitest'

import type { AgentWorkbenchSnapshot, CurrentCount, WorkbenchAgent, WorkbenchSignal } from './api'
import {
  advancePresentation,
  alignedEpochMs,
  createPresentationState,
  diffWorkbenchEvents,
  formatCompactNumber,
  formatWorkbenchStatus,
  reconcileSignalSelection,
  replacePresentationSnapshot,
  signalElapsedSeconds,
} from './agentWorkbenchPresentation'

const exactCount = (value: number): CurrentCount => ({
  value,
  quality: 'exact',
  last_observed_value: value,
  last_observed_at: '2026-09-03T00:00:00.000Z',
})

function makeSnapshot(overrides: Partial<AgentWorkbenchSnapshot> = {}): AgentWorkbenchSnapshot {
  return {
    snapshot_at: '2026-09-03T00:00:00.000Z',
    last_complete_discovery_at: '2026-09-03T00:00:00.000Z',
    sync_health: 'fresh',
    stale: false,
    current_state_complete: true,
    current_state_checked_at: '2026-09-03T00:00:00.000Z',
    current_state_incomplete_statuses: [],
    fresh_until: '2026-09-03T00:00:00.010Z',
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
    range_start: '2026-08-04T16:00:00.000Z',
    range_end: '2026-09-03T16:00:00.000Z',
    metrics_complete_for_range: true,
    coverage: {
      mirrored_run_count: 0,
      remote_total_runs: 0,
      history_complete: true,
      range_complete: true,
      coverage_start_at: null,
      coverage_as_of: '2026-09-03T00:00:00.000Z',
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
    agents: [{ lifecycle_status: 'active' } as WorkbenchAgent],
    sync_warnings: [],
    ...overrides,
  }
}

function makeSignal(overrides: Partial<WorkbenchSignal> = {}): WorkbenchSignal {
  return {
    coreai_run_id: 'run-1',
    local_agent_id: 'agent-1',
    agent_name: 'Research Agent',
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
    started_at: '2026-09-02T23:59:00.000Z',
    effective_started_at: '2026-09-02T23:59:00.000Z',
    completed_at: null,
    terminal_observed_at: null,
    receipt_expires_at: null,
    elapsed_seconds: 60,
    last_synced_at: '2026-09-03T00:00:00.000Z',
    fresh_until: '2026-09-03T00:00:01.000Z',
    suspect_at: '2026-09-03T00:00:02.000Z',
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    token_state: 'pending',
    association: null,
    ...overrides,
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function presentSnapshot(snapshot: AgentWorkbenchSnapshot, receivedAtMonotonicMs = 30_000) {
  const state = replacePresentationSnapshot(createPresentationState(), snapshot, receivedAtMonotonicMs, 'initial')
  if (!state.presentation) throw new Error('expected presentation')
  return state.presentation
}

describe('agent workbench presentation', () => {
  it('snapshot clock aligns monotonically', () => {
    const clock = { snapshotEpochMs: 1_000_000, receivedAtMonotonicMs: 5_000 }

    expect(alignedEpochMs(clock, 6_250)).toBe(1_001_250)
    expect(alignedEpochMs(clock, 4_000)).toBe(1_000_000)

    const firstSeenBackedSignal = {
      started_at: null,
      effective_started_at: '2026-09-03T00:00:00Z',
      elapsed_seconds: 37,
    } as WorkbenchSignal
    expect(signalElapsedSeconds(firstSeenBackedSignal, clock, 7_999)).toBe(39)
  })

  it('compact number formatting', () => {
    expect(formatCompactNumber(0)).toBe('0')
    expect(formatCompactNumber(999)).toBe('999')
    expect(formatCompactNumber(12_500)).toBe('1.3万')
    expect(formatCompactNumber(1_234_567)).toBe('123.5万')
    expect(() => formatCompactNumber(Number.NaN)).toThrow(RangeError)
    expect(() => formatCompactNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })

  it('aggregate deadline downgrades exact zero current claims', () => {
    const snapshot = deepFreeze(makeSnapshot())
    const rawBefore = JSON.stringify(snapshot)
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 1_000, 'initial')

    expect(initial.presentation?.current_counts.running).toMatchObject({
      value: 0,
      quality: 'exact',
      claim_is_current: true,
      exact_owner_claim_allowed: true,
    })
    expect(initial.presentation?.idle_eligible).toBe(true)

    const expired = advancePresentation(initial, 1_010, 'clock')

    expect(expired.presentation?.current_counts.running).toEqual({
      value: null,
      quality: 'unknown',
      last_observed_value: 0,
      last_observed_at: '2026-09-03T00:00:00.000Z',
      copy: '当前数量未知 · 上次确认 0（2026-09-03T00:00:00.000Z）',
      claim_is_current: false,
      exact_owner_claim_allowed: false,
    })
    expect(expired.presentation?.has_active_runs).toBeNull()
    expect(expired.presentation?.has_queued_runs).toBeNull()
    expect(expired.presentation?.has_waiting_runs).toBeNull()
    expect(expired.presentation?.idle_eligible).toBe(false)
    expect(expired.snapshot).toBe(snapshot)
    expect(JSON.stringify(snapshot)).toBe(rawBefore)
  })

  it('aggregate deadline downgrades exact positive current claims', () => {
    const snapshot = deepFreeze(
      makeSnapshot({
        has_active_runs: true,
        current_counts: {
          running: exactCount(2),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [makeSignal({ fresh_until: '2026-09-03T00:00:01.000Z' })],
      }),
    )
    const rawBefore = JSON.stringify(snapshot)
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 2_000, 'initial')

    expect(initial.presentation?.current_counts.running).toMatchObject({
      value: 2,
      quality: 'exact',
      copy: '当前 2',
      claim_is_current: true,
      exact_owner_claim_allowed: true,
    })

    const expired = advancePresentation(initial, 2_010, 'clock')

    expect(expired.presentation?.current_counts.running).toEqual({
      value: null,
      quality: 'unknown',
      last_observed_value: 2,
      last_observed_at: '2026-09-03T00:00:00.000Z',
      copy: '当前数量未知 · 上次确认 2（2026-09-03T00:00:00.000Z）',
      claim_is_current: false,
      exact_owner_claim_allowed: false,
    })
    expect(expired.presentation?.idle_eligible).toBe(false)
    expect(expired.presentation?.signals[0].may_animate).toBe(true)
    expect(JSON.stringify(snapshot)).toBe(rawBefore)
  })

  it('aggregate deadline does not suppress independently fresh running motion', () => {
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:00.010Z',
        has_active_runs: true,
        current_counts: {
          running: exactCount(1),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [makeSignal({ fresh_until: '2026-09-03T00:00:01.000Z' })],
      }),
    )
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 2_500, 'initial')

    const expired = advancePresentation(initial, 2_510, 'clock')

    expect(expired.presentation?.aggregate_fresh).toBe(false)
    expect(expired.presentation?.current_counts.running.quality).toBe('unknown')
    expect(expired.presentation?.idle_eligible).toBe(false)
    expect(expired.presentation?.signals[0]).toMatchObject({ locally_fresh: true, may_animate: true })
  })

  it('aggregate deadline downgrades lower-bound current claims', () => {
    const lowerBound: CurrentCount = {
      value: 3,
      quality: 'lower_bound',
      last_observed_value: 3,
      last_observed_at: '2026-09-03T00:00:00.000Z',
    }
    const snapshot = deepFreeze(
      makeSnapshot({
        has_active_runs: true,
        current_counts: {
          running: lowerBound,
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
      }),
    )
    const rawBefore = JSON.stringify(snapshot)
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 3_000, 'initial')

    expect(initial.presentation?.current_counts.running).toMatchObject({
      value: 3,
      quality: 'lower_bound',
      copy: '至少 3',
      claim_is_current: true,
      exact_owner_claim_allowed: false,
    })

    const expired = advancePresentation(initial, 3_010, 'clock')

    expect(expired.presentation?.current_counts.running.quality).toBe('unknown')
    expect(expired.presentation?.current_counts.running.copy).not.toContain('至少')
    expect(expired.presentation?.current_counts.running.last_observed_value).toBe(3)
    expect(JSON.stringify(snapshot)).toBe(rawBefore)
  })

  it('focus advance synchronously downgrades cached presentation', () => {
    const cases = [
      { name: 'exact idle', snapshot: makeSnapshot(), initiallyAnimated: false },
      {
        name: 'running',
        snapshot: makeSnapshot({
          fresh_until: '2026-09-03T00:00:01.000Z',
          has_active_runs: true,
          current_counts: {
            running: exactCount(1),
            queued: exactCount(0),
            waiting: exactCount(0),
            legacy_nonterminal: exactCount(0),
          },
          signals: [makeSignal()],
        }),
        initiallyAnimated: true,
      },
    ]

    for (const testCase of cases) {
      const snapshot = deepFreeze(testCase.snapshot)
      const rawBefore = JSON.stringify(snapshot)
      const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 4_000, 'initial')
      expect(initial.presentation?.signals.some(signal => signal.may_animate), testCase.name).toBe(
        testCase.initiallyAnimated,
      )

      const focused = advancePresentation(initial, 4_001, 'focus')

      expect(focused.presentation?.current_counts.running.quality, testCase.name).toBe('unknown')
      expect(focused.presentation?.current_counts.running.claim_is_current, testCase.name).toBe(false)
      expect(focused.presentation?.has_active_runs, testCase.name).toBeNull()
      expect(focused.presentation?.idle_eligible, testCase.name).toBe(false)
      expect(focused.presentation?.signals.every(signal => !signal.may_animate), testCase.name).toBe(true)
      const laterClock = advancePresentation(focused, 4_100, 'clock')
      expect(laterClock.presentation?.current_counts.running.quality, `${testCase.name} later clock`).toBe('unknown')
      expect(laterClock.presentation?.signals.every(signal => !signal.may_animate), `${testCase.name} later clock`).toBe(
        true,
      )
      expect(JSON.stringify(snapshot), testCase.name).toBe(rawBefore)
    }
  })

  it('pre-focus automatic response cannot clear the freshness barrier', () => {
    const initialSnapshot = deepFreeze(makeSnapshot({ range: '7d' }))
    const staleResponse = deepFreeze(makeSnapshot({ range: '30d' }))
    const initial = replacePresentationSnapshot(createPresentationState(), initialSnapshot, 10_000, 'initial')
    const focused = advancePresentation(initial, 10_100, 'focus')

    const rejected = replacePresentationSnapshot(focused, staleResponse, 10_200, 'automatic', 10_050)

    expect(rejected.snapshot).toBe(initialSnapshot)
    expect(rejected.freshnessBarrier).toBe('focus')
    expect(rejected.presentation?.current_counts.running.quality).toBe('unknown')
    expect(rejected.presentation?.idle_eligible).toBe(false)

    const accepted = replacePresentationSnapshot(rejected, staleResponse, 10_300, 'automatic', 10_150)
    expect(accepted.snapshot).toBe(staleResponse)
    expect(accepted.freshnessBarrier).toBeNull()
    expect(accepted.presentation?.current_counts.running.quality).toBe('exact')
    expect(accepted.presentation?.idle_eligible).toBe(true)
  })

  it('pre-mutation automatic response cannot restore running motion', () => {
    const initialSnapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_active_runs: true,
        current_counts: {
          running: exactCount(1),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [makeSignal({ fresh_until: '2026-09-03T00:00:10.000Z' })],
      }),
    )
    const staleResponse = deepFreeze(makeSnapshot({ range: '7d' }))
    const initial = replacePresentationSnapshot(createPresentationState(), initialSnapshot, 11_000, 'initial')
    const mutating = advancePresentation(initial, 11_100, 'mutation')

    const rejected = replacePresentationSnapshot(mutating, staleResponse, 11_200, 'automatic', 11_050)

    expect(rejected.snapshot).toBe(initialSnapshot)
    expect(rejected.freshnessBarrier).toBe('mutation')
    expect(rejected.presentation?.current_counts.running.quality).toBe('unknown')
    expect(rejected.presentation?.signals[0].may_animate).toBe(false)
  })

  it('suspect deadline changes only presentation truth', () => {
    const running = makeSignal({
      suspect_at: '2026-09-03T00:00:01.250Z',
      fresh_until: '2026-09-03T00:00:10.000Z',
    })
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_active_runs: true,
        current_counts: {
          running: exactCount(1),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [running],
      }),
    )
    const rawBefore = JSON.stringify(snapshot)
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 5_000, 'initial')
    const ticked = advancePresentation(initial, 6_000, 'clock')

    expect(ticked.presentation?.signals[0]).toMatchObject({ suspect: false, elapsed_seconds: 61, may_animate: true })

    const suspect = advancePresentation(ticked, 6_250, 'clock')

    expect(suspect.presentation?.signals[0]).toMatchObject({
      raw_status: 'RUNNING',
      suspect: true,
      suspect_reason: '超过本地状态待确认阈值',
      signal_state: 'uncertain',
      fresh: false,
      locally_fresh: false,
      may_animate: false,
    })
    expect(suspect.presentation?.current_counts.running.quality).toBe('unknown')
    expect(JSON.stringify(snapshot)).toBe(rawBefore)

    const pendingSnapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_queued_runs: true,
        current_counts: {
          running: exactCount(0),
          queued: exactCount(1),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [
          makeSignal({
            coreai_run_id: 'pending-1',
            raw_status: 'PENDING',
            presentation_group: 'queued',
            signal_state: 'queued',
            suspect_at: '2026-09-03T00:00:01.250Z',
            fresh_until: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )
    const pendingInitial = replacePresentationSnapshot(createPresentationState(), pendingSnapshot, 8_000, 'initial')
    const pendingSuspect = advancePresentation(pendingInitial, 9_250, 'clock')

    expect(pendingSuspect.presentation?.signals[0]).toMatchObject({
      raw_status: 'PENDING',
      suspect: true,
      suspect_reason: '超过本地状态待确认阈值',
      signal_state: 'uncertain',
      fresh: false,
      may_animate: false,
    })
    expect(pendingSuspect.presentation?.current_counts.queued.quality).toBe('unknown')

    const pausedSnapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_waiting_runs: true,
        current_counts: {
          running: exactCount(0),
          queued: exactCount(0),
          waiting: exactCount(1),
          legacy_nonterminal: exactCount(0),
        },
        signals: [
          makeSignal({
            coreai_run_id: 'paused-1',
            raw_status: 'PAUSED',
            presentation_group: 'waiting',
            signal_state: 'waiting',
            suspect_at: '2026-09-03T00:00:01.250Z',
            fresh_until: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )
    const pausedInitial = replacePresentationSnapshot(createPresentationState(), pausedSnapshot, 10_000, 'initial')
    const oldPaused = advancePresentation(pausedInitial, 11_250, 'clock')

    expect(oldPaused.presentation?.signals[0]).toMatchObject({
      raw_status: 'PAUSED',
      signal_state: 'waiting',
      suspect: false,
      suspect_reason: null,
      may_animate: false,
    })
    expect(oldPaused.presentation?.current_counts.waiting.quality).toBe('exact')
  })

  it('signal deadlines gate motion independently', () => {
    const first = makeSignal({
      coreai_run_id: 'run-first',
      local_agent_id: 'agent-first',
      fresh_until: '2026-09-03T00:00:01.000Z',
      suspect_at: '2026-09-03T00:00:20.000Z',
    })
    const second = makeSignal({
      coreai_run_id: 'run-second',
      local_agent_id: 'agent-second',
      fresh_until: '2026-09-03T00:00:05.000Z',
      suspect_at: '2026-09-03T00:00:20.000Z',
    })
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_active_runs: true,
        current_counts: {
          running: exactCount(2),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [first, second],
      }),
    )
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 12_000, 'initial')
    const advanced = advancePresentation(initial, 13_000, 'clock')

    expect(advanced.presentation?.signals.map(signal => [signal.coreai_run_id, signal.may_animate])).toEqual([
      ['run-first', false],
      ['run-second', true],
    ])
    expect(advanced.presentation?.current_counts.running.quality).toBe('unknown')
    expect(advanced.presentation?.has_active_runs).toBeNull()
    expect(advanced.presentation?.has_queued_runs).toBeNull()
    expect(advanced.presentation?.has_waiting_runs).toBeNull()
    expect(snapshot.signals[0].fresh).toBe(true)
    expect(snapshot.signals[1].fresh).toBe(true)
  })

  it('receipt expires automatically but freezes while paused', () => {
    const receipt = makeSignal({
      coreai_run_id: 'receipt-1',
      raw_status: 'COMPLETED',
      presentation_group: 'success',
      signal_state: 'completed',
      fresh: false,
      suspect_at: null,
      fresh_until: null,
      completed_at: '2026-09-03T00:00:00.000Z',
      terminal_observed_at: '2026-09-03T00:00:00.000Z',
      receipt_expires_at: '2026-09-03T00:00:01.000Z',
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      token_state: 'known',
    })
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [receipt],
      }),
    )
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 14_000, 'initial')

    expect(initial.presentation?.signals.map(signal => signal.coreai_run_id)).toEqual(['receipt-1'])

    const expired = advancePresentation(initial, 15_000, 'clock')

    expect(expired.presentation?.signals).toEqual([])

    const pauseInitial = replacePresentationSnapshot(createPresentationState(), snapshot, 16_000, 'initial')
    const paused = advancePresentation(pauseInitial, 16_500, 'pause')
    const lateTick = advancePresentation(paused, 18_000, 'clock')

    expect(paused.pausedAtMonotonicMs).toBe(16_500)
    expect(lateTick.presentation?.signals.map(signal => signal.coreai_run_id)).toEqual(['receipt-1'])
    expect(lateTick.presentation?.signals[0].timing_copy).toBe(
      '数据截至 2026-09-03T00:00:00.000Z · 完成于 2026-09-03T00:00:00.000Z · 终态观测于 2026-09-03T00:00:00.000Z',
    )

    const manuallyExpired = advancePresentation(paused, 18_000, 'manual')
    const postManualTick = advancePresentation(manuallyExpired, 19_000, 'clock')
    expect(manuallyExpired.pausedAtMonotonicMs).toBe(18_000)
    expect(manuallyExpired.presentation?.signals).toEqual([])
    expect(postManualTick.presentation?.signals).toEqual([])

    const pausedReadback = replacePresentationSnapshot(paused, snapshot, 17_000, 'manual')
    expect(pausedReadback.pausedAtMonotonicMs).toBe(17_000)
    expect(pausedReadback.freshnessBarrier).toBe('pause')
    expect(pausedReadback.presentation?.current_counts.running.quality).toBe('unknown')
    expect(pausedReadback.presentation?.signals.map(signal => signal.coreai_run_id)).toEqual(['receipt-1'])

    const resumed = advancePresentation(lateTick, 18_000, 'resume')
    expect(resumed.pausedAtMonotonicMs).toBeNull()
    expect(resumed.presentation?.signals).toEqual([])
  })

  it('pause copy uses persisted absolute evidence without fabricating legacy observation time', () => {
    const legacyCount: CurrentCount = {
      value: 4,
      quality: 'lower_bound',
      last_observed_value: 4,
      last_observed_at: null,
    }
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        current_counts: {
          running: { ...exactCount(2), last_observed_at: null },
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: legacyCount,
        },
        signals: [
          makeSignal({
            coreai_run_id: 'terminal-completed',
            raw_status: 'COMPLETED',
            presentation_group: 'success',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            completed_at: '2026-09-02T23:59:59.000Z',
            terminal_observed_at: '2026-09-03T00:00:00.000Z',
            receipt_expires_at: '2026-09-03T00:00:10.000Z',
          }),
          makeSignal({
            coreai_run_id: 'terminal-observed',
            raw_status: 'CANCELLED',
            presentation_group: 'cancelled',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            completed_at: null,
            terminal_observed_at: '2026-09-03T00:00:00.000Z',
            receipt_expires_at: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 13_000, 'initial')

    const paused = advancePresentation(initial, 13_500, 'pause')

    expect(paused.presentation?.current_counts.running).toMatchObject({
      last_observed_at: '2026-09-03T00:00:00.000Z',
      copy: '数据截至 2026-09-03T00:00:00.000Z · 已确认 2',
    })
    expect(paused.presentation?.current_counts.legacy_nonterminal).toMatchObject({
      last_observed_at: null,
      copy: '数据截至未知 · 上次确认 4',
    })
    expect(paused.presentation?.signals.map(signal => signal.timing_copy)).toEqual([
      '数据截至 2026-09-03T00:00:00.000Z · 完成于 2026-09-02T23:59:59.000Z · 终态观测于 2026-09-03T00:00:00.000Z',
      '数据截至 2026-09-03T00:00:00.000Z · 终态观测于 2026-09-03T00:00:00.000Z',
    ])
  })

  it('snapshot replacement never replays receipt entrance', () => {
    const receiptSnapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [
          makeSignal({
            coreai_run_id: 'receipt-seen',
            raw_status: 'COMPLETED',
            presentation_group: 'success',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            completed_at: '2026-09-03T00:00:00.000Z',
            terminal_observed_at: '2026-09-03T00:00:00.000Z',
            receipt_expires_at: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )

    const initial = replacePresentationSnapshot(createPresentationState(), receiptSnapshot, 20_000, 'initial')
    expect(initial.presentation?.entering_receipt_ids).toEqual(['receipt-seen'])

    const automatic = replacePresentationSnapshot(initial, receiptSnapshot, 20_100, 'automatic')
    expect(automatic.presentation?.entering_receipt_ids).toEqual([])

    const focusReadback = replacePresentationSnapshot(automatic, receiptSnapshot, 20_200, 'focus')
    expect(focusReadback.presentation?.entering_receipt_ids).toEqual([])
    expect([...focusReadback.seenReceiptIds]).toEqual(['receipt-seen'])

    const expiredReceiptSnapshot = deepFreeze(
      makeSnapshot({
        signals: [
          makeSignal({
            coreai_run_id: 'receipt-expired',
            raw_status: 'COMPLETED',
            presentation_group: 'success',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            receipt_expires_at: '2026-09-02T23:59:59.000Z',
          }),
        ],
      }),
    )
    const expired = replacePresentationSnapshot(createPresentationState(), expiredReceiptSnapshot, 20_300, 'initial')
    expect(expired.presentation?.entering_receipt_ids).toEqual([])
    expect([...expired.seenReceiptIds]).toEqual([])
  })

  it('manual replacement while paused records receipts without entrance replay', () => {
    const receiptSnapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [
          makeSignal({
            coreai_run_id: 'receipt-during-pause',
            raw_status: 'COMPLETED',
            presentation_group: 'success',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            completed_at: '2026-09-03T00:00:00.000Z',
            terminal_observed_at: '2026-09-03T00:00:00.000Z',
            receipt_expires_at: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )
    const initial = replacePresentationSnapshot(createPresentationState(), deepFreeze(makeSnapshot()), 21_000, 'initial')
    const paused = advancePresentation(initial, 21_100, 'pause')

    const manual = replacePresentationSnapshot(paused, receiptSnapshot, 21_200, 'manual', 21_150)

    expect(manual.presentation?.entering_receipt_ids).toEqual([])
    expect([...manual.seenReceiptIds]).toEqual(['receipt-during-pause'])

    const resumed = advancePresentation(manual, 21_300, 'resume')
    const readback = replacePresentationSnapshot(resumed, receiptSnapshot, 21_400, 'resume', 21_350)
    expect(readback.presentation?.entering_receipt_ids).toEqual([])
  })

  it('selection reconciliation reports removal', () => {
    const previous = [
      makeSignal({ coreai_run_id: 'run-a' }),
      makeSignal({ coreai_run_id: 'run-b' }),
      makeSignal({ coreai_run_id: 'run-c' }),
    ]
    const next = [makeSignal({ coreai_run_id: 'run-new' }), ...previous]

    const surviving = reconcileSignalSelection(previous, next, 'run-b', 'automatic')

    expect(surviving).toEqual({
      selectedSignalId: 'run-b',
      selectedWasRemoved: false,
      focusStageHeading: false,
    })
    expect(surviving).not.toHaveProperty('focusSelectedTab')

    const nextIndex = reconcileSignalSelection(previous, [previous[0], previous[2]], 'run-b', 'automatic')
    expect(nextIndex).toEqual({
      selectedSignalId: 'run-c',
      selectedWasRemoved: true,
      focusStageHeading: false,
    })

    const precedingFinal = reconcileSignalSelection(previous, [previous[0], previous[1]], 'run-c', 'automatic')
    expect(precedingFinal).toEqual({
      selectedSignalId: 'run-b',
      selectedWasRemoved: true,
      focusStageHeading: false,
    })

    const noSignals = reconcileSignalSelection(previous, [], 'run-b', 'automatic')
    expect(noSignals).toEqual({
      selectedSignalId: null,
      selectedWasRemoved: true,
      focusStageHeading: true,
    })

    const paused = reconcileSignalSelection(previous, [], 'run-b', 'pause')
    expect(paused).toEqual({
      selectedSignalId: 'run-b',
      selectedWasRemoved: false,
      focusStageHeading: false,
    })

    const initialSelection = reconcileSignalSelection(
      [],
      [
        makeSignal({ coreai_run_id: 'run-old', effective_started_at: '2026-09-03T00:00:00.000Z' }),
        makeSignal({ coreai_run_id: 'run-a', effective_started_at: '2026-09-03T00:01:00.000Z' }),
        makeSignal({ coreai_run_id: 'run-z', effective_started_at: '2026-09-03T00:01:00.000Z' }),
      ],
      null,
      'initial',
    )
    expect(initialSelection).toEqual({
      selectedSignalId: 'run-z',
      selectedWasRemoved: false,
      focusStageHeading: false,
    })
  })

  it('initial selection compares parsed fractional epochs before run id tie-break', () => {
    const fractionalLatest = reconcileSignalSelection(
      [],
      [
        makeSignal({ coreai_run_id: 'run-z', effective_started_at: '2026-09-03T00:00:00.10Z' }),
        makeSignal({ coreai_run_id: 'run-a', effective_started_at: '2026-09-03T00:00:00.1Z' }),
        makeSignal({ coreai_run_id: 'run-m', effective_started_at: '2026-09-03T00:00:00.101Z' }),
      ],
      null,
      'initial',
    )
    expect(fractionalLatest.selectedSignalId).toBe('run-m')

    const equalEpoch = reconcileSignalSelection(
      [],
      [
        makeSignal({ coreai_run_id: 'run-a', effective_started_at: '2026-09-03T00:00:00.1Z' }),
        makeSignal({ coreai_run_id: 'run-z', effective_started_at: '2026-09-03T00:00:00.10Z' }),
      ],
      null,
      'initial',
    )
    expect(equalEpoch.selectedSignalId).toBe('run-z')
  })

  it('workbench event diff is semantic only', () => {
    const previous = presentSnapshot(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [makeSignal({ coreai_run_id: 'run-a' })],
      }),
    )
    const withDiscovery = presentSnapshot(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [makeSignal({ coreai_run_id: 'run-new' }), makeSignal({ coreai_run_id: 'run-a' })],
      }),
    )

    expect(diffWorkbenchEvents(previous, withDiscovery, { kind: 'snapshot', reason: 'automatic' })).toEqual([
      '发现新的 Run：run-new',
    ])

    const terminal = presentSnapshot(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        signals: [
          makeSignal({
            coreai_run_id: 'run-a',
            raw_status: 'COMPLETED',
            presentation_group: 'success',
            signal_state: 'completed',
            fresh: false,
            fresh_until: null,
            suspect_at: null,
            completed_at: '2026-09-03T00:00:01.000Z',
            terminal_observed_at: '2026-09-03T00:00:01.000Z',
            receipt_expires_at: '2026-09-03T00:00:10.000Z',
          }),
        ],
      }),
    )
    expect(diffWorkbenchEvents(previous, terminal, { kind: 'snapshot', reason: 'automatic' })).toEqual([
      'Run run-a 已变为终态：COMPLETED',
    ])

    const stale = presentSnapshot(
      makeSnapshot({
        sync_health: 'stale',
        stale: true,
        fresh_until: null,
        signals: [makeSignal({ coreai_run_id: 'run-a', fresh: false, fresh_until: null })],
      }),
    )
    expect(diffWorkbenchEvents(previous, stale, { kind: 'snapshot', reason: 'automatic' })).toEqual([
      '当前状态新鲜度已失效',
    ])
    expect(diffWorkbenchEvents(stale, previous, { kind: 'snapshot', reason: 'automatic' })).toEqual([
      '当前状态新鲜度已恢复',
    ])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'snapshot', reason: 'manual' })).toEqual([
      '手动刷新完成',
    ])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'run-id-copy', runId: 'run-a', succeeded: true })).toEqual([
      '已复制 Run ID：run-a',
    ])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'timer-tick' })).toEqual([])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'relative-wording' })).toEqual([])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'row-expansion' })).toEqual([])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'snapshot', reason: 'automatic' })).toEqual([])
    expect(diffWorkbenchEvents(previous, previous, { kind: 'run-id-copy', runId: 'run-a', succeeded: false })).toEqual(
      [],
    )
  })

  it('timer tick announces aggregate freshness loss only on transition', () => {
    const snapshot = deepFreeze(makeSnapshot({ fresh_until: '2026-09-03T00:00:00.010Z' }))
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 30_000, 'initial')
    const unchanged = advancePresentation(initial, 30_005, 'clock')
    const expired = advancePresentation(unchanged, 30_010, 'clock')

    expect(diffWorkbenchEvents(initial.presentation, unchanged.presentation, { kind: 'timer-tick' })).toEqual([])
    expect(diffWorkbenchEvents(unchanged.presentation, expired.presentation, { kind: 'timer-tick' })).toEqual([
      '当前状态新鲜度已失效',
    ])
    expect(diffWorkbenchEvents(expired.presentation, expired.presentation, { kind: 'timer-tick' })).toEqual([])
  })

  it('status labels cover known, future, and statusless values', () => {
    expect([
      'PENDING',
      'RUNNING',
      'PAUSED',
      'COMPLETED',
      'FAILED',
      'TIMEOUT',
      'CANCELLED',
      'SKIPPED',
    ].map(status => formatWorkbenchStatus(status))).toEqual([
      '排队中',
      '运行中',
      '等待输入',
      '已完成',
      '失败',
      '超时',
      '已取消',
      '已跳过',
    ])
    expect(formatWorkbenchStatus('AWAITING_REVIEW')).toBe('未知状态（AWAITING_REVIEW）')
    expect(formatWorkbenchStatus(null)).toBe('状态待确认（上游未返回状态）')
  })

  it('presentation barriers mutate only derived truth', () => {
    const snapshot = deepFreeze(
      makeSnapshot({
        fresh_until: '2026-09-03T00:00:10.000Z',
        has_active_runs: true,
        current_counts: {
          running: exactCount(1),
          queued: exactCount(0),
          waiting: exactCount(0),
          legacy_nonterminal: exactCount(0),
        },
        signals: [makeSignal({ fresh_until: '2026-09-03T00:00:10.000Z' })],
      }),
    )
    const rawBefore = JSON.stringify(snapshot)
    const initial = replacePresentationSnapshot(createPresentationState(), snapshot, 40_000, 'initial')

    for (const reason of ['hidden', 'focus', 'mutation', 'pause'] as const) {
      const downgraded = advancePresentation(initial, 40_100, reason)
      expect(downgraded.presentation?.current_counts.running.quality, reason).toBe('unknown')
      expect(downgraded.presentation?.idle_eligible, reason).toBe(false)
      expect(downgraded.presentation?.signals.every(signal => !signal.may_animate), reason).toBe(true)
      expect(downgraded.snapshot, reason).toBe(snapshot)
      expect(JSON.stringify(snapshot), reason).toBe(rawBefore)
    }
  })
})

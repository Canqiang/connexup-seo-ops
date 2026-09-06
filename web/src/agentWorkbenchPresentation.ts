import type { AgentWorkbenchSnapshot, CurrentCount, WorkbenchSignal } from './api'

export type SnapshotClock = {
  snapshotEpochMs: number
  receivedAtMonotonicMs: number
}

export function alignedEpochMs(clock: SnapshotClock, nowMonotonicMs: number): number {
  return clock.snapshotEpochMs + Math.max(0, nowMonotonicMs - clock.receivedAtMonotonicMs)
}

export function signalElapsedSeconds(
  signal: WorkbenchSignal,
  clock: SnapshotClock,
  nowMonotonicMs: number,
): number {
  return signal.elapsed_seconds + Math.floor(Math.max(0, nowMonotonicMs - clock.receivedAtMonotonicMs) / 1000)
}

const compactNumberFormatter = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('compact number must be finite')
  return compactNumberFormatter.format(value)
}

const knownStatusLabels: Record<string, string> = {
  PENDING: '排队中',
  RUNNING: '运行中',
  PAUSED: '等待输入',
  COMPLETED: '已完成',
  FAILED: '失败',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
  SKIPPED: '已跳过',
}

export function formatWorkbenchStatus(rawStatus: string | null): string {
  if (rawStatus === null) return '状态待确认（上游未返回状态）'
  return knownStatusLabels[rawStatus] ?? `未知状态（${rawStatus}）`
}

export type PresentationAdvanceReason = 'clock' | 'hidden' | 'focus' | 'pause' | 'manual' | 'resume' | 'mutation'
export type SnapshotReplacementReason =
  | 'initial'
  | 'automatic'
  | 'manual'
  | 'visibility'
  | 'focus'
  | 'resume'
  | 'range'
  | 'mutation'

export type PresentedCurrentCount = CurrentCount & {
  copy: string
  claim_is_current: boolean
  exact_owner_claim_allowed: boolean
}

export type PresentedSignal = WorkbenchSignal & {
  locally_fresh: boolean
  may_animate: boolean
  timing_copy: string
}

export type PresentedWorkbench = {
  current_counts: {
    running: PresentedCurrentCount
    queued: PresentedCurrentCount
    waiting: PresentedCurrentCount
    legacy_nonterminal: PresentedCurrentCount
  }
  signals: PresentedSignal[]
  aggregate_fresh: boolean
  has_active_runs: boolean | null
  has_queued_runs: boolean | null
  has_waiting_runs: boolean | null
  idle_eligible: boolean
  entering_receipt_ids: string[]
}

export type WorkbenchEventDiffContext =
  | { kind: 'snapshot'; reason: SnapshotReplacementReason }
  | { kind: 'timer-tick' }
  | { kind: 'relative-wording' }
  | { kind: 'row-expansion' }
  | { kind: 'run-id-copy'; runId: string; succeeded: boolean }

export function diffWorkbenchEvents(
  previous: PresentedWorkbench | null,
  next: PresentedWorkbench | null,
  context: WorkbenchEventDiffContext,
): string[] {
  if (context.kind === 'run-id-copy') {
    return context.succeeded ? [`已复制 Run ID：${context.runId}`] : []
  }
  if (context.kind === 'timer-tick') {
    if (!previous || !next || previous.aggregate_fresh === next.aggregate_fresh) return []
    return [next.aggregate_fresh ? '当前状态新鲜度已恢复' : '当前状态新鲜度已失效']
  }
  if (context.kind !== 'snapshot' || !previous || !next) return []
  const previousById = new Map(previous.signals.map(signal => [signal.coreai_run_id, signal]))
  const announcements = next.signals
    .filter(signal => !previousById.has(signal.coreai_run_id))
    .map(signal => `发现新的 Run：${signal.coreai_run_id}`)
  const terminalStatuses = new Set(['COMPLETED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'SKIPPED'])
  for (const signal of next.signals) {
    const prior = previousById.get(signal.coreai_run_id)
    if (prior && signal.raw_status !== prior.raw_status && signal.raw_status && terminalStatuses.has(signal.raw_status)) {
      announcements.push(`Run ${signal.coreai_run_id} 已变为终态：${signal.raw_status}`)
    }
  }
  if (previous.aggregate_fresh !== next.aggregate_fresh) {
    announcements.push(next.aggregate_fresh ? '当前状态新鲜度已恢复' : '当前状态新鲜度已失效')
  }
  if (context.reason === 'manual') announcements.push('手动刷新完成')
  return announcements
}

export type PresentationState = {
  snapshot: AgentWorkbenchSnapshot | null
  presentation: PresentedWorkbench | null
  clock: SnapshotClock | null
  pausedAtMonotonicMs: number | null
  freshnessBarrier: 'hidden' | 'focus' | 'pause' | 'mutation' | 'resume' | null
  freshnessBarrierAtMonotonicMs: number | null
  seenReceiptIds: ReadonlySet<string>
  lastReplacementReason: SnapshotReplacementReason | null
}

export type SignalSelectionReconciliation = {
  selectedSignalId: string | null
  selectedWasRemoved: boolean
  focusStageHeading: boolean
}

export function reconcileSignalSelection(
  previousSignals: readonly WorkbenchSignal[],
  nextSignals: readonly WorkbenchSignal[],
  selectedSignalId: string | null,
  reason: PresentationAdvanceReason | SnapshotReplacementReason,
): SignalSelectionReconciliation {
  if (reason === 'pause') {
    return { selectedSignalId, selectedWasRemoved: false, focusStageHeading: false }
  }
  if (selectedSignalId !== null && nextSignals.some(signal => signal.coreai_run_id === selectedSignalId)) {
    return { selectedSignalId, selectedWasRemoved: false, focusStageHeading: false }
  }
  if (nextSignals.length === 0) {
    return {
      selectedSignalId: null,
      selectedWasRemoved: selectedSignalId !== null,
      focusStageHeading: selectedSignalId !== null,
    }
  }
  if (selectedSignalId === null) {
    const newest = [...nextSignals].sort((left, right) => {
      const timeOrder = Date.parse(right.effective_started_at) - Date.parse(left.effective_started_at)
      return Number.isFinite(timeOrder) && timeOrder !== 0
        ? timeOrder
        : right.coreai_run_id.localeCompare(left.coreai_run_id)
    })[0]
    return { selectedSignalId: newest.coreai_run_id, selectedWasRemoved: false, focusStageHeading: false }
  }
  if (selectedSignalId !== null) {
    const previousIndex = previousSignals.findIndex(signal => signal.coreai_run_id === selectedSignalId)
    if (previousIndex >= 0 && previousIndex < nextSignals.length) {
      return {
        selectedSignalId: nextSignals[previousIndex].coreai_run_id,
        selectedWasRemoved: true,
        focusStageHeading: false,
      }
    }
    if (previousIndex >= 0 && nextSignals.length > 0) {
      return {
        selectedSignalId: nextSignals[nextSignals.length - 1].coreai_run_id,
        selectedWasRemoved: true,
        focusStageHeading: false,
      }
    }
  }
  return { selectedSignalId: null, selectedWasRemoved: selectedSignalId !== null, focusStageHeading: false }
}

export function mayAnimateRunning(signal: WorkbenchSignal, signalLocallyFresh: boolean): boolean {
  return (
    signalLocallyFresh &&
    signal.agent_current_state_complete &&
    signal.lifecycle_status === 'active' &&
    signal.raw_status === 'RUNNING' &&
    signal.signal_state === 'active' &&
    signal.fresh &&
    !signal.suspect
  )
}

export function createPresentationState(): PresentationState {
  return {
    snapshot: null,
    presentation: null,
    clock: null,
    pausedAtMonotonicMs: null,
    freshnessBarrier: null,
    freshnessBarrierAtMonotonicMs: null,
    seenReceiptIds: new Set(),
    lastReplacementReason: null,
  }
}

function unknownCountCopy(value: number | null, observedAt: string | null, absoluteTiming: boolean): string {
  if (absoluteTiming) {
    if (observedAt !== null && value !== null) return `数据截至 ${observedAt} · 已确认 ${value}`
    if (observedAt !== null) return `数据截至 ${observedAt} · 当前数量未知`
    if (value !== null) return `数据截至未知 · 上次确认 ${value}`
    return '数据截至未知 · 尚无成功确认'
  }
  return value !== null && observedAt !== null
    ? `当前数量未知 · 上次确认 ${value}（${observedAt}）`
    : '当前数量未知 · 尚无成功确认'
}

function currentCount(
  count: CurrentCount,
  claimIsCurrent: boolean,
  running: boolean,
  observedAtFallback: string | null,
  absoluteTiming = false,
): PresentedCurrentCount {
  if (claimIsCurrent && count.quality !== 'unknown') {
    return {
      ...count,
      copy: count.quality === 'exact' ? `当前 ${count.value}` : `至少 ${count.value}`,
      claim_is_current: true,
      exact_owner_claim_allowed: running && count.quality === 'exact',
    }
  }
  const lastObservedValue = count.value ?? count.last_observed_value
  const lastObservedAt = count.last_observed_at ?? observedAtFallback
  return {
    value: null,
    quality: 'unknown',
    last_observed_value: lastObservedValue,
    last_observed_at: lastObservedAt,
    copy: unknownCountCopy(lastObservedValue, lastObservedAt, absoluteTiming),
    claim_is_current: false,
    exact_owner_claim_allowed: false,
  }
}

function absoluteSignalTimingCopy(signal: WorkbenchSignal, elapsedSeconds: number): string {
  const parts = [`数据截至 ${signal.last_synced_at}`]
  if (signal.completed_at !== null) parts.push(`完成于 ${signal.completed_at}`)
  if (signal.terminal_observed_at !== null) parts.push(`终态观测于 ${signal.terminal_observed_at}`)
  if (parts.length === 1) parts.push(`已持续 ${elapsedSeconds} 秒`)
  return parts.join(' · ')
}

function buildPresentation(
  snapshot: AgentWorkbenchSnapshot,
  clock: SnapshotClock,
  nowMonotonicMs: number,
  enteringReceiptIds: string[] = [],
  forceStale = false,
  absoluteTiming = false,
): PresentedWorkbench {
  const alignedNow = alignedEpochMs(clock, nowMonotonicMs)
  const freshUntil = snapshot.fresh_until === null ? null : Date.parse(snapshot.fresh_until)
  const aggregateFresh =
    !forceStale && snapshot.sync_health === 'fresh' && !snapshot.stale && freshUntil !== null && alignedNow < freshUntil
  const countsAreCurrent = aggregateFresh && snapshot.current_state_complete === true
  const currentCounts = {
    running: currentCount(
      snapshot.current_counts.running,
      countsAreCurrent,
      true,
      snapshot.current_state_checked_at,
      absoluteTiming,
    ),
    queued: currentCount(
      snapshot.current_counts.queued,
      countsAreCurrent,
      false,
      snapshot.current_state_checked_at,
      absoluteTiming,
    ),
    waiting: currentCount(
      snapshot.current_counts.waiting,
      countsAreCurrent,
      false,
      snapshot.current_state_checked_at,
      absoluteTiming,
    ),
    legacy_nonterminal: currentCount(
      snapshot.current_counts.legacy_nonterminal,
      countsAreCurrent,
      false,
      null,
      absoluteTiming,
    ),
  }
  let runningClaimCurrent = countsAreCurrent
  let queuedClaimCurrent = countsAreCurrent
  let waitingClaimCurrent = countsAreCurrent
  const visibleSignals = snapshot.signals.filter(signal => {
    if (signal.receipt_expires_at === null) return true
    const receiptExpiresAt = Date.parse(signal.receipt_expires_at)
    return !Number.isFinite(receiptExpiresAt) || alignedNow < receiptExpiresAt
  })
  const signals = visibleSignals.map(signal => {
    const signalFreshUntil = signal.fresh_until === null ? null : Date.parse(signal.fresh_until)
    const suspectAt = signal.suspect_at === null ? null : Date.parse(signal.suspect_at)
    const suspectExpired =
      (signal.raw_status === 'RUNNING' || signal.raw_status === 'PENDING') &&
      suspectAt !== null &&
      alignedNow >= suspectAt
    const locallyFresh =
      !forceStale &&
      signal.fresh &&
      !suspectExpired &&
      signalFreshUntil !== null &&
      alignedNow < signalFreshUntil
    if (signal.fresh && !locallyFresh && signal.raw_status === 'RUNNING') runningClaimCurrent = false
    if (signal.fresh && !locallyFresh && signal.raw_status === 'PENDING') queuedClaimCurrent = false
    if (signal.fresh && !locallyFresh && signal.raw_status === 'PAUSED') waitingClaimCurrent = false
    const elapsedSeconds = signalElapsedSeconds(signal, clock, nowMonotonicMs)
    return {
      ...signal,
      signal_state: suspectExpired ? ('uncertain' as const) : signal.signal_state,
      suspect: suspectExpired || signal.suspect,
      suspect_reason: suspectExpired ? '超过本地状态待确认阈值' : signal.suspect_reason,
      fresh: locallyFresh,
      elapsed_seconds: elapsedSeconds,
      locally_fresh: locallyFresh,
      may_animate: mayAnimateRunning(signal, locallyFresh),
      timing_copy: absoluteTiming
        ? absoluteSignalTimingCopy(signal, elapsedSeconds)
        : `已持续 ${elapsedSeconds} 秒`,
    }
  })
  if (!runningClaimCurrent) {
    currentCounts.running = currentCount(
      snapshot.current_counts.running,
      false,
      true,
      snapshot.current_state_checked_at,
      absoluteTiming,
    )
  }
  if (!queuedClaimCurrent) {
    currentCounts.queued = currentCount(
      snapshot.current_counts.queued,
      false,
      false,
      snapshot.current_state_checked_at,
      absoluteTiming,
    )
  }
  if (!waitingClaimCurrent) {
    currentCounts.waiting = currentCount(
      snapshot.current_counts.waiting,
      false,
      false,
      snapshot.current_state_checked_at,
      absoluteTiming,
    )
  }
  const hasActiveAgents = snapshot.agents.some(agent => agent.lifecycle_status === 'active')
  const idleEligible =
    aggregateFresh &&
    snapshot.current_state_complete === true &&
    hasActiveAgents &&
    currentCounts.running.quality === 'exact' &&
    currentCounts.running.value === 0 &&
    currentCounts.queued.quality === 'exact' &&
    currentCounts.queued.value === 0 &&
    currentCounts.waiting.quality === 'exact' &&
    currentCounts.waiting.value === 0 &&
    signals.length === 0
  const convenienceClaimsCurrent =
    aggregateFresh && runningClaimCurrent && queuedClaimCurrent && waitingClaimCurrent

  return {
    current_counts: currentCounts,
    signals,
    aggregate_fresh: aggregateFresh,
    has_active_runs: convenienceClaimsCurrent ? snapshot.has_active_runs : null,
    has_queued_runs: convenienceClaimsCurrent ? snapshot.has_queued_runs : null,
    has_waiting_runs: convenienceClaimsCurrent ? snapshot.has_waiting_runs : null,
    idle_eligible: idleEligible,
    entering_receipt_ids: enteringReceiptIds,
  }
}

export function replacePresentationSnapshot(
  state: PresentationState,
  snapshot: AgentWorkbenchSnapshot,
  receivedAtMonotonicMs: number,
  reason: SnapshotReplacementReason,
  requestStartedAtMonotonicMs?: number,
): PresentationState {
  const protectsAgainstOlderRequests = state.freshnessBarrier !== null && state.freshnessBarrier !== 'pause'
  if (
    protectsAgainstOlderRequests &&
    state.freshnessBarrierAtMonotonicMs !== null &&
    (requestStartedAtMonotonicMs === undefined || requestStartedAtMonotonicMs < state.freshnessBarrierAtMonotonicMs)
  ) {
    return state
  }
  const clock = {
    snapshotEpochMs: Date.parse(snapshot.snapshot_at),
    receivedAtMonotonicMs,
  }
  const receiptIds = snapshot.signals
    .filter(signal => {
      if (signal.receipt_expires_at === null) return false
      const receiptExpiresAt = Date.parse(signal.receipt_expires_at)
      return !Number.isFinite(receiptExpiresAt) || clock.snapshotEpochMs < receiptExpiresAt
    })
    .map(signal => signal.coreai_run_id)
  const enteringReceiptIds = receiptIds.filter(id => !state.seenReceiptIds.has(id))
  const seenReceiptIds = new Set(state.seenReceiptIds)
  for (const id of receiptIds) seenReceiptIds.add(id)
  const remainPaused = state.pausedAtMonotonicMs !== null && reason !== 'resume'
  return {
    ...state,
    snapshot,
    clock,
    presentation: buildPresentation(
      snapshot,
      clock,
      receivedAtMonotonicMs,
      remainPaused ? [] : enteringReceiptIds,
      remainPaused,
      remainPaused,
    ),
    pausedAtMonotonicMs: remainPaused ? receivedAtMonotonicMs : null,
    freshnessBarrier: remainPaused ? 'pause' : null,
    freshnessBarrierAtMonotonicMs: remainPaused ? receivedAtMonotonicMs : null,
    seenReceiptIds,
    lastReplacementReason: reason,
  }
}

export function advancePresentation(
  state: PresentationState,
  nowMonotonicMs: number,
  reason: PresentationAdvanceReason,
): PresentationState {
  if (!state.snapshot || !state.clock) return state
  const establishesFreshnessBarrier =
    reason === 'hidden' || reason === 'focus' || reason === 'pause' || reason === 'mutation' || reason === 'resume'
  const freshnessBarrier = establishesFreshnessBarrier ? reason : state.freshnessBarrier
  const freshnessBarrierAtMonotonicMs = establishesFreshnessBarrier
    ? nowMonotonicMs
    : state.freshnessBarrierAtMonotonicMs
  const forceStale = freshnessBarrier !== null
  const pausedAtMonotonicMs =
    reason === 'resume'
      ? null
      : reason === 'pause' || (reason === 'manual' && state.pausedAtMonotonicMs !== null)
        ? nowMonotonicMs
        : state.pausedAtMonotonicMs
  const presentationNow = pausedAtMonotonicMs ?? nowMonotonicMs
  return {
    ...state,
    presentation: buildPresentation(
      state.snapshot,
      state.clock,
      presentationNow,
      [],
      forceStale,
      pausedAtMonotonicMs !== null,
    ),
    pausedAtMonotonicMs,
    freshnessBarrier,
    freshnessBarrierAtMonotonicMs,
  }
}

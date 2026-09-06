import { useCallback, useEffect, useRef, useState } from 'react'

import { api, isAbortError, type AgentWorkbenchSnapshot, type WorkbenchRange } from './api'
import {
  advancePresentation,
  alignedEpochMs,
  createPresentationState,
  replacePresentationSnapshot,
  type PresentationState,
  type PresentedWorkbench,
} from './agentWorkbenchPresentation'

export type WorkbenchRefreshReason =
  | 'initial'
  | 'automatic'
  | 'manual'
  | 'visibility'
  | 'focus'
  | 'resume'
  | 'range'
  | 'mutation'

type ImmediateRefreshIntent = {
  reason: WorkbenchRefreshReason
  intentEpoch: number
}

type SharedRequest = {
  key: string
  controller: AbortController
  promise: Promise<AgentWorkbenchSnapshot>
  subscribers: number
  settled: boolean
}

type ActiveRequest = {
  shared: SharedRequest
  generation: number
  obsolete: boolean
  startedIntentEpoch: number
  reason: WorkbenchRefreshReason
  startedAtMonotonicMs: number
}

let sharedRequest: SharedRequest | null = null

function acquireRequest(range: WorkbenchRange): SharedRequest {
  if (
    sharedRequest &&
    !sharedRequest.settled &&
    !sharedRequest.controller.signal.aborted &&
    sharedRequest.subscribers > 0 &&
    sharedRequest.key === range
  ) {
    sharedRequest.subscribers += 1
    return sharedRequest
  }
  const controller = new AbortController()
  const record: SharedRequest = {
    key: range,
    controller,
    promise: api.getAgentWorkbench(range, controller.signal),
    subscribers: 1,
    settled: false,
  }
  sharedRequest = record
  void record.promise.finally(() => {
    record.settled = true
    if (sharedRequest === record) sharedRequest = null
  }).catch(() => undefined)
  return record
}

function retainRequest(record: SharedRequest): void {
  record.subscribers += 1
}

function releaseRequest(record: SharedRequest): void {
  record.subscribers = Math.max(0, record.subscribers - 1)
  queueMicrotask(() => {
    if (record.subscribers === 0 && !record.settled) record.controller.abort()
  })
}

export type AgentWorkbenchPolling = {
  snapshot: AgentWorkbenchSnapshot | null
  presentation: PresentedWorkbench | null
  loading: boolean
  refreshing: boolean
  error: string | null
  autoUpdate: boolean
  requestRefresh: (reason: WorkbenchRefreshReason) => void
  setAutoUpdate: (enabled: boolean) => void
  snapshotAgeSeconds: number | null
}

export function useAgentWorkbenchPolling(range: WorkbenchRange): AgentWorkbenchPolling {
  const [presentationState, setPresentationState] = useState<PresentationState>(createPresentationState)
  const initiallyAutoUpdating =
    typeof window === 'undefined' ||
    window.sessionStorage.getItem('seo-ops.agent-workbench.auto-update') !== 'paused'
  const [loading, setLoading] = useState(initiallyAutoUpdating)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [snapshotAgeSeconds, setSnapshotAgeSeconds] = useState<number | null>(null)
  const [autoUpdate, setAutoUpdateState] = useState(initiallyAutoUpdating)
  const autoUpdateRef = useRef(autoUpdate)
  const stateRef = useRef(presentationState)
  const mountedRef = useRef(false)
  const generationRef = useRef(1)
  const intentEpochRef = useRef(0)
  const activeRequestRef = useRef<ActiveRequest | null>(null)
  const immediateIntentRef = useRef<ImmediateRefreshIntent | null>(null)
  const selectedRangeRef = useRef(range)
  const previousRangeRef = useRef(range)
  const refreshTimerRef = useRef<number | null>(null)
  const tickTimerRef = useRef<number | null>(null)
  const deadlineTimerRef = useRef<number | null>(null)
  const armPresentationTimersRef = useRef<() => void>(() => undefined)
  const cleanupTokenRef = useRef<object | null>(null)
  const requestRef = useRef<(reason: WorkbenchRefreshReason) => void>(() => undefined)

  const commitState = useCallback((next: PresentationState) => {
    stateRef.current = next
    setPresentationState(next)
  }, [])

  const clearRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current)
    refreshTimerRef.current = null
  }, [])

  const clearPresentationTimers = useCallback(() => {
    if (tickTimerRef.current !== null) window.clearTimeout(tickTimerRef.current)
    if (deadlineTimerRef.current !== null) window.clearTimeout(deadlineTimerRef.current)
    tickTimerRef.current = null
    deadlineTimerRef.current = null
  }, [])

  const armPresentationTimers = useCallback(() => {
    clearPresentationTimers()
    const state = stateRef.current
    if (
      !mountedRef.current ||
      !autoUpdateRef.current ||
      document.visibilityState !== 'visible' ||
      !state.snapshot ||
      !state.clock
    ) return
    tickTimerRef.current = window.setTimeout(() => {
      const now = performance.now()
      commitState(advancePresentation(stateRef.current, now, 'clock'))
      if (stateRef.current.clock) {
        setSnapshotAgeSeconds(Math.floor(Math.max(0, now - stateRef.current.clock.receivedAtMonotonicMs) / 1_000))
      }
      armPresentationTimersRef.current()
    }, 1_000)

    const alignedNow = alignedEpochMs(state.clock, performance.now())
    const candidates = [state.snapshot.fresh_until]
    for (const signal of state.snapshot.signals) {
      candidates.push(signal.fresh_until, signal.receipt_expires_at)
      if (signal.raw_status === 'PENDING' || signal.raw_status === 'RUNNING') candidates.push(signal.suspect_at)
    }
    const nextDeadline = candidates
      .map(value => value === null ? Number.NaN : Date.parse(value))
      .filter(value => Number.isFinite(value) && value > alignedNow)
      .sort((left, right) => left - right)[0]
    if (nextDeadline !== undefined) {
      deadlineTimerRef.current = window.setTimeout(() => {
        const now = performance.now()
        commitState(advancePresentation(stateRef.current, now, 'clock'))
        if (stateRef.current.clock) {
          setSnapshotAgeSeconds(Math.floor(Math.max(0, now - stateRef.current.clock.receivedAtMonotonicMs) / 1_000))
        }
        armPresentationTimersRef.current()
      }, Math.max(0, nextDeadline - alignedNow))
    }
  }, [clearPresentationTimers, commitState])
  const scheduleNext = useCallback((rawDelay: number | undefined) => {
    clearRefreshTimer()
    if (!mountedRef.current || !autoUpdateRef.current || document.visibilityState !== 'visible') return
    const delay = Number.isFinite(rawDelay)
      ? Math.min(60_000, Math.max(1_000, rawDelay as number))
      : 30_000
    refreshTimerRef.current = window.setTimeout(() => requestRef.current('automatic'), delay)
  }, [clearRefreshTimer])

  const startRequest = useCallback(function startRequestImpl(intent: ImmediateRefreshIntent) {
    if (
      !mountedRef.current ||
      document.visibilityState !== 'visible' ||
      (!autoUpdateRef.current && intent.reason !== 'manual')
    ) return
    const barrierAt = stateRef.current.freshnessBarrierAtMonotonicMs
    const startedAtMonotonicMs = barrierAt === null
      ? performance.now()
      : Math.max(performance.now(), barrierAt + 0.001)
    const active: ActiveRequest = {
      shared: acquireRequest(selectedRangeRef.current),
      generation: generationRef.current,
      obsolete: false,
      startedIntentEpoch: intent.intentEpoch,
      reason: intent.reason,
      startedAtMonotonicMs,
    }
    activeRequestRef.current = active
    clearRefreshTimer()
    if (stateRef.current.snapshot) setRefreshing(true)
    let settledDelay = stateRef.current.snapshot?.refresh_after_ms

    void active.shared.promise
      .then(snapshot => {
        const mayCommit =
          mountedRef.current &&
          activeRequestRef.current === active &&
          active.generation === generationRef.current &&
          !active.obsolete &&
          active.startedIntentEpoch >= intent.intentEpoch
        if (!mayCommit) return
        settledDelay = snapshot.refresh_after_ms
        let nextState = replacePresentationSnapshot(
          stateRef.current,
          snapshot,
          performance.now(),
          active.reason,
          active.startedAtMonotonicMs,
        )
        if (active.reason === 'manual' && !autoUpdateRef.current) {
          nextState = advancePresentation(nextState, performance.now(), 'pause')
        }
        if (snapshot.sync_health === 'unavailable' || snapshot.sync_health === 'stale' || snapshot.sync_health === 'not_configured') {
          nextState = advancePresentation(nextState, performance.now(), 'focus')
        }
        commitState(nextState)
        setSnapshotAgeSeconds(0)
        queueMicrotask(() => armPresentationTimersRef.current())
        setError(null)
      })
      .catch(cause => {
        if (!mountedRef.current || activeRequestRef.current !== active || active.obsolete || isAbortError(cause)) return
        setError(cause instanceof Error ? cause.message : '读取 Agent 状态失败')
      })
      .finally(() => {
        if (activeRequestRef.current !== active) return
        activeRequestRef.current = null
        if (!mountedRef.current || active.generation !== generationRef.current) return
        setLoading(false)
        setRefreshing(false)
        if (active.reason === 'resume') setAutoUpdateState(true)
        const queued = immediateIntentRef.current
        immediateIntentRef.current = null
        if (queued) {
          if (
            document.visibilityState === 'visible' &&
            (autoUpdateRef.current || queued.reason === 'manual')
          ) startRequestImpl(queued)
          return
        }
        scheduleNext(settledDelay)
      })
  }, [clearRefreshTimer, commitState, scheduleNext])

  const queueRequest = useCallback((reason: WorkbenchRefreshReason) => {
    clearRefreshTimer()
    if (!autoUpdateRef.current && reason !== 'manual') return
    const immediate = reason !== 'initial' && reason !== 'automatic'
    const intentEpoch = immediate ? ++intentEpochRef.current : intentEpochRef.current
    const intent = { reason, intentEpoch }
    const active = activeRequestRef.current
    if (!active) {
      startRequest(intent)
      return
    }
    if (!immediate) return
    active.obsolete = true
    active.shared.controller.abort()
    immediateIntentRef.current = intent
  }, [clearRefreshTimer, startRequest])

  const requestRefresh = useCallback((reason: WorkbenchRefreshReason) => {
    if (reason === 'mutation' && autoUpdateRef.current && stateRef.current.snapshot) {
      commitState(advancePresentation(stateRef.current, performance.now(), 'mutation'))
    }
    requestRef.current(reason)
  }, [commitState])

  const setAutoUpdate = useCallback((enabled: boolean) => {
    window.sessionStorage.setItem('seo-ops.agent-workbench.auto-update', enabled ? 'running' : 'paused')
    if (!enabled) {
      autoUpdateRef.current = false
      setAutoUpdateState(false)
      clearRefreshTimer()
      clearPresentationTimers()
      if (stateRef.current.snapshot) commitState(advancePresentation(stateRef.current, performance.now(), 'pause'))
      const active = activeRequestRef.current
      if (active) {
        active.obsolete = true
        active.shared.controller.abort()
      }
      immediateIntentRef.current = null
      setLoading(false)
      return
    }
    autoUpdateRef.current = true
    if (stateRef.current.snapshot) commitState(advancePresentation(stateRef.current, performance.now(), 'resume'))
    requestRef.current('resume')
  }, [clearPresentationTimers, clearRefreshTimer, commitState])

  useEffect(() => {
    armPresentationTimersRef.current = armPresentationTimers
  }, [armPresentationTimers])

  useEffect(() => {
    requestRef.current = queueRequest
  }, [queueRequest])

  useEffect(() => {
    mountedRef.current = true
    const cleanupToken = {}
    cleanupTokenRef.current = cleanupToken
    const active = activeRequestRef.current
    if (active && !active.shared.settled) retainRequest(active.shared)
    else if (autoUpdateRef.current && document.visibilityState === 'visible') queueRequest('initial')
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') {
        clearRefreshTimer()
        clearPresentationTimers()
        immediateIntentRef.current = null
        if (stateRef.current.snapshot) commitState(advancePresentation(stateRef.current, performance.now(), 'hidden'))
        const current = activeRequestRef.current
        if (current) {
          current.obsolete = true
          current.shared.controller.abort()
        }
        return
      }
      if (autoUpdateRef.current) {
        if (stateRef.current.snapshot) {
          commitState(advancePresentation(stateRef.current, performance.now(), 'clock'))
          armPresentationTimersRef.current()
        }
        queueRequest('visibility')
      }
    }
    const handleFocus = () => {
      if (!autoUpdateRef.current || document.visibilityState !== 'visible') return
      if (stateRef.current.snapshot) commitState(advancePresentation(stateRef.current, performance.now(), 'focus'))
      queueRequest('focus')
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', handleFocus)
    return () => {
      mountedRef.current = false
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', handleFocus)
      clearRefreshTimer()
      clearPresentationTimers()
      const current = activeRequestRef.current
      if (current) releaseRequest(current.shared)
      queueMicrotask(() => {
        if (cleanupTokenRef.current !== cleanupToken || mountedRef.current) return
        generationRef.current += 1
        immediateIntentRef.current = null
        if (activeRequestRef.current) {
          activeRequestRef.current.obsolete = true
          activeRequestRef.current.shared.controller.abort()
        }
      })
    }
  }, [clearPresentationTimers, clearRefreshTimer, commitState, queueRequest])

  useEffect(() => {
    selectedRangeRef.current = range
    if (previousRangeRef.current === range) return
    previousRangeRef.current = range
    queueRequest('range')
  }, [queueRequest, range])

  return {
    snapshot: presentationState.snapshot,
    presentation: presentationState.presentation,
    loading,
    refreshing,
    error,
    autoUpdate,
    requestRefresh,
    setAutoUpdate,
    snapshotAgeSeconds,
  }
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { WorkbenchRange, WorkbenchSignal } from '../api'
import { reconcileSignalSelection } from '../agentWorkbenchPresentation'
import LiveRunStage from '../components/agent-workbench/LiveRunStage'
import AgentSummaryMetrics from '../components/agent-workbench/AgentSummaryMetrics'
import AgentRegistryTable, { type AgentManagerMode } from '../components/agent-workbench/AgentRegistryTable'
import AgentManagerDrawer from '../components/agent-workbench/AgentManagerDrawer'
import { useAgentWorkbenchPolling } from '../useAgentWorkbenchPolling'

const rangeLabels: Record<WorkbenchRange, string> = {
  today: '今天',
  '7d': '近 7 天',
  '30d': '近 30 天',
  all: '全部',
}

function syncHeadline(
  syncHealth: 'fresh' | 'partial' | 'stale' | 'unavailable' | 'not_configured',
  ageSeconds: number,
  lastSuccess: string | null,
): string {
  if (syncHealth === 'fresh') return `运行状态已刷新 · ${ageSeconds} 秒前`
  if (syncHealth === 'partial') return '部分 Agent 状态延迟'
  if (syncHealth === 'unavailable') return '实时同步不可用 · 显示已保存数据'
  if (syncHealth === 'stale') return `状态可能延迟 · 上次成功同步 ${lastSuccess ?? '未知'}`
  return '尚未配置 Agent 同步'
}

export default function AgentWorkbench() {
  const [range, setRange] = useState<WorkbenchRange>('30d')
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null)
  const [managerMode, setManagerMode] = useState<AgentManagerMode | null>(null)
  const [managerOpener, setManagerOpener] = useState<HTMLElement | null>(null)
  const result = useAgentWorkbenchPolling(range)
  const { snapshot, presentation, loading, refreshing, error, autoUpdate, requestRefresh, setAutoUpdate } = result
  const displayedRange = snapshot?.range ?? '30d'
  const headingRef = useRef<HTMLHeadingElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const previousSignalsRef = useRef<readonly WorkbenchSignal[]>([])
  const selectedWasFocusedRef = useRef(false)
  const focusedSignalIdRef = useRef<string | null>(null)

  useLayoutEffect(() => () => {
    selectedWasFocusedRef.current = selectedSignalId !== null && focusedSignalIdRef.current === selectedSignalId
  }, [presentation, selectedSignalId])

  const openManager = (mode: AgentManagerMode, opener?: HTMLElement) => {
    setManagerOpener(opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null))
    setManagerMode(mode)
  }

  useEffect(() => {
    if (!presentation) return
    const reconciliation = reconcileSignalSelection(
      previousSignalsRef.current,
      presentation.signals,
      selectedSignalId,
      'clock',
    )
    previousSignalsRef.current = presentation.signals
    if (reconciliation.selectedSignalId !== selectedSignalId) setSelectedSignalId(reconciliation.selectedSignalId)
    if (reconciliation.selectedWasRemoved && selectedWasFocusedRef.current) {
      queueMicrotask(() => {
        if (reconciliation.selectedSignalId) tabRefs.current.get(reconciliation.selectedSignalId)?.focus()
        else headingRef.current?.focus()
      })
    }
    selectedWasFocusedRef.current = false
  }, [presentation, selectedSignalId])

  const activeAgents = snapshot?.agents.filter(agent => agent.lifecycle_status === 'active') ?? []
  const disabledAgents = snapshot?.agents.filter(agent => agent.lifecycle_status === 'disabled') ?? []
  const retiredAgents = snapshot?.agents.filter(agent => agent.lifecycle_status === 'retired') ?? []
  const lastCompletedAgent = snapshot?.agents
    .filter(agent => agent.last_terminal_run?.completed_at)
    .sort((left, right) => Date.parse(right.last_terminal_run!.completed_at!) - Date.parse(left.last_terminal_run!.completed_at!))[0]
  const lastCompleted = lastCompletedAgent?.last_terminal_run?.completed_at
    ? { agentName: lastCompletedAgent.display_name, completedAt: lastCompletedAgent.last_terminal_run.completed_at }
    : null

  return (
    <main className="agent-workbench">
      <header className="agent-workbench__page-header">
        <div>
          <h1>Agent 工作台</h1>
          <p>查看 SEO Ops Agent 的已保存运行事实与同步新鲜度。</p>
        </div>
        <div className="agent-workbench__sync-copy">
          {snapshot
            ? <strong>{syncHeadline(snapshot.sync_health, result.snapshotAgeSeconds ?? 0, snapshot.last_complete_discovery_at)}</strong>
            : !autoUpdate
              ? <strong>自动更新已暂停 · 尚未读取</strong>
              : loading
                ? <strong>正在载入 Agent 状态</strong>
                : error
                  ? <strong>Agent 状态暂不可用 · 等待自动重试</strong>
                  : <strong>尚未读取 Agent 状态</strong>}
          {snapshot && snapshot.current_state_complete === false && <span>当前状态覆盖不完整</span>}
          {refreshing && <span>正在刷新</span>}
          {error && <span className="agent-workbench__read-error">{error}</span>}
        </div>
      </header>

      <section className="agent-workbench__controls" aria-label="工作台读取控制">
        <fieldset className="agent-workbench__range">
          <legend>统计范围</legend>
          {(Object.entries(rangeLabels) as Array<[WorkbenchRange, string]>).map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="agent-workbench-range"
                value={value}
                checked={range === value}
                onChange={() => setRange(value)}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
        <div className="agent-workbench__update-controls">
          <p id="agent-workbench-refresh-description">刷新显示只重新读取 SEO Ops 本地快照；后台同步在浏览器暂停或隐藏时仍独立运行。</p>
          {!autoUpdate && snapshot && <strong>自动更新已暂停 · 数据截至 {snapshot.snapshot_at}</strong>}
          {autoUpdate && snapshot && <strong>{snapshot.refresh_after_ms <= 5_000 ? '自动更新 · 运行中约 5 秒' : '自动更新 · 空闲最多 30 秒'}</strong>}
          <button type="button" aria-describedby="agent-workbench-refresh-description" onClick={() => requestRefresh('manual')}>刷新显示</button>
          <button type="button" onClick={() => setAutoUpdate(!autoUpdate)}>{autoUpdate ? '暂停自动更新' : '恢复自动更新'}</button>
        </div>
        {!autoUpdate && range !== displayedRange && (
          <p className="agent-workbench__pending-range">已选择{rangeLabels[range]} · 当前仍显示{rangeLabels[displayedRange]}数据</p>
        )}
      </section>

      {presentation && (
        <LiveRunStage
          presentation={presentation}
          selectedSignalId={selectedSignalId}
          onSelectSignal={setSelectedSignalId}
          headingRef={headingRef}
          tabRefs={tabRefs}
          onAnnouncement={result.publishAnnouncement}
          onFocusedSignalChange={id => { focusedSignalIdRef.current = id }}
          lastCompleted={lastCompleted}
        />
      )}

      {snapshot && presentation && <AgentSummaryMetrics snapshot={snapshot} presentation={presentation} />}

      {snapshot && snapshot.agents.length === 0 && (
        <section className="agent-workbench__notice"><strong>尚未注册 SEO Ops Agent</strong><button type="button" onClick={event => openManager({ kind: 'register' }, event.currentTarget)}>管理 Agent</button></section>
      )}
      {snapshot && activeAgents.length === 0 && disabledAgents.length > 0 && (
        <section className="agent-workbench__notice"><strong>当前没有启用的 Agent</strong></section>
      )}
      {snapshot && activeAgents.length === 0 && disabledAgents.length === 0 && retiredAgents.length > 0 && (
        <section className="agent-workbench__notice"><strong>当前没有在册 Agent</strong><a href="#agent-workbench-registry">查看已归档</a></section>
      )}

      {snapshot && <AgentRegistryTable agents={snapshot.agents} range={displayedRange} autoUpdate={autoUpdate} onManage={openManager} onAnnouncement={result.publishAnnouncement} />}

      {snapshot && snapshot.sync_warnings.length > 0 && <section className="agent-workbench__warnings" aria-labelledby="agent-workbench-warnings-heading"><h2 id="agent-workbench-warnings-heading">运行告警</h2><ul>{snapshot.sync_warnings.map((warning, index) => <li key={`${warning.code}-${index}`}><strong>{warning.message}</strong>{warning.local_agent_id && <span>Agent {warning.local_agent_id}</span>}{warning.coreai_run_id && <span>Run {warning.coreai_run_id}</span>}</li>)}</ul></section>}

      {managerMode && <AgentManagerDrawer mode={managerMode} autoUpdate={autoUpdate} requestRefresh={result.requestRefresh} opener={managerOpener} onClose={() => setManagerMode(null)} />}

      <div className="agent-workbench__announcer" aria-live="polite" aria-atomic="true">
        {result.eventAnnouncement && (
          <span key={result.eventAnnouncement.sequence}>
            <span>{result.eventAnnouncement.message}</span>
            <span aria-hidden="true">{result.eventAnnouncement.sequence}</span>
          </span>
        )}
      </div>
    </main>
  )
}

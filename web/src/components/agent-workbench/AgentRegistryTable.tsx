import { useState } from 'react'

import type { WorkbenchAgent, WorkbenchRange } from '../../api'
import { formatCompactNumber, type PresentedWorkbench } from '../../agentWorkbenchPresentation'
import AgentRunHistory from './AgentRunHistory'

const lifecycleLabels: Record<WorkbenchAgent['lifecycle_status'], string> = {
  active: '启用',
  disabled: '停用',
  retired: '已归档',
}

export type AgentManagerMode =
  | { kind: 'register' }
  | { kind: 'edit'; agent: WorkbenchAgent }
  | { kind: 'replace'; agent: WorkbenchAgent }
  | { kind: 'retire'; agent: WorkbenchAgent }

type AgentRegistryTableProps = {
  agents: WorkbenchAgent[]
  presentation: PresentedWorkbench
  snapshotAt: string
  range: WorkbenchRange
  autoUpdate: boolean
  showArchived: boolean
  onShowArchivedChange: (show: boolean) => void
  onManage: (mode: AgentManagerMode, opener?: HTMLElement) => void
  onAnnouncement: (message: string) => void
}

function incompleteCoverageQualifier(agent: WorkbenchAgent): string {
  return agent.coverage.remote_total_runs === null
    ? `基于已镜像 ${agent.coverage.mirrored_run_count} 次 · 上游总数未知`
    : `基于已镜像 ${agent.coverage.mirrored_run_count}/${agent.coverage.remote_total_runs} 次`
}

function rangeQualifier(agent: WorkbenchAgent): string | null {
  return agent.coverage.range_complete ? null : incompleteCoverageQualifier(agent)
}

function statusCopy(agent: WorkbenchAgent, presentation: PresentedWorkbench, snapshotAt: string): string {
  const counts = agent.current_counts
  const keys = ['running', 'queued', 'waiting'] as const
  const nonzero = keys.find(key => (counts[key].value ?? 0) > 0)
  const labels = { running: '运行', queued: '排队', waiting: '等待' }
  const countsAreCurrent = presentation.aggregate_fresh && keys.every(key => presentation.current_counts[key].claim_is_current)
  if (!countsAreCurrent) {
    if (nonzero) {
      const count = counts[nonzero]
      const observedAt = count.last_observed_at ?? agent.sync.current_state_checked_at ?? snapshotAt
      return `截至 ${observedAt} · 已确认 ${count.value} ${labels[nonzero]}`
    }
    const observedAt = agent.sync.current_state_checked_at ?? snapshotAt
    return agent.last_terminal_run
      ? `截至 ${observedAt} · 最近终态 ${agent.last_terminal_run.raw_status ?? '待确认'}`
      : `截至 ${observedAt} · 无已确认活动 Run`
  }
  const unknown = (['running', 'queued', 'waiting'] as const).find(key => counts[key].quality === 'unknown')
  if (unknown) {
    const count = counts[unknown]
    return count.last_observed_value !== null && count.last_observed_at !== null
      ? `当前数量未知 · 上次确认 ${count.last_observed_value}（${count.last_observed_at}）`
      : '当前数量未知 · 尚无成功确认'
  }
  if (nonzero) {
    const label = labels[nonzero]
    const count = counts[nonzero]
    if (count.quality === 'lower_bound') return `至少 ${count.value} ${label}`
    return `${count.value} ${label}`
  }
  return agent.last_terminal_run?.raw_status ?? '无运行记录'
}

function terminalTokenCopy(agent: WorkbenchAgent): string | null {
  const run = agent.last_terminal_run
  if (!run) return null
  if (run.token_state === 'known') return `最近 Run 总计 ${formatCompactNumber(run.total_tokens ?? 0)}`
  if (run.token_state === 'pending') return '完成后入账'
  if (run.token_state === 'unconfirmed') return '状态确认后判断'
  return '不可用'
}

function AgentRow({ agent, presentation, snapshotAt, expanded, onToggle, range, autoUpdate, onManage, onAnnouncement }: {
  agent: WorkbenchAgent
  presentation: PresentedWorkbench
  snapshotAt: string
  expanded: boolean
  onToggle: () => void
  range: WorkbenchRange
  autoUpdate: boolean
  onManage: (mode: AgentManagerMode, opener?: HTMLElement) => void
  onAnnouncement: (message: string) => void
}) {
  const historyId = `agent-history-${agent.id}`
  const qualifier = rangeQualifier(agent)
  const rate = agent.range_metrics.success_rate === null ? '—' : `${Math.round(agent.range_metrics.success_rate * 100)}%`
  const total = agent.range_metrics.known_total_tokens
  return (
    <>
      <tr>
        <th scope="row"><strong>{agent.display_name}</strong><small>{agent.role}</small></th>
        <td><span className={`agent-workbench__badge agent-workbench__badge--${agent.lifecycle_status}`}>{lifecycleLabels[agent.lifecycle_status]}</span></td>
        <td>{statusCopy(agent, presentation, snapshotAt)}</td>
        <td aria-label={`Run 数 ${agent.range_metrics.run_count}`}>{formatCompactNumber(agent.range_metrics.run_count)}{qualifier && <small>{qualifier}</small>}</td>
        <td>{rate}</td>
        <td aria-label={`完整 Token 数 ${agent.range_metrics.known_input_tokens} ${agent.range_metrics.known_output_tokens} ${total}`}>
          <span>{formatCompactNumber(agent.range_metrics.known_input_tokens)} / {formatCompactNumber(agent.range_metrics.known_output_tokens)} / {formatCompactNumber(total)}</span>
          <small>已知 {agent.range_metrics.token_known_runs}/{agent.range_metrics.token_eligible_runs} 次</small>
          {terminalTokenCopy(agent) && <small>{terminalTokenCopy(agent)}</small>}
        </td>
        <td>{agent.sync.last_discovery_success_at ?? '尚无成功同步'}<small>{agent.coverage.history_complete ? '历史完整' : incompleteCoverageQualifier(agent)}</small></td>
        <td>
          <button type="button" aria-expanded={expanded} aria-controls={historyId} onClick={onToggle}>{expanded ? '收起历史' : '查看历史'}</button>
          {agent.lifecycle_status !== 'retired' && <>
            <button type="button" onClick={event => onManage({ kind: 'edit', agent }, event.currentTarget)}>编辑</button>
            <button type="button" onClick={event => onManage({ kind: 'replace', agent }, event.currentTarget)}>替换</button>
            <button type="button" onClick={event => onManage({ kind: 'retire', agent }, event.currentTarget)}>归档</button>
          </>}
        </td>
      </tr>
      {(agent.warnings.length > 0 || agent.coreai_metadata.verification_error || agent.sync.current_state_error) && (
        <tr className="agent-workbench__warning-row"><td colSpan={8}><ul className="agent-workbench__badges">
          {agent.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}
          {agent.coreai_metadata.verification_error && <li>元数据验证：{agent.coreai_metadata.verification_error}</li>}
          {agent.sync.current_state_error && <li>当前同步：{agent.sync.current_state_error}</li>}
        </ul></td></tr>
      )}
      {expanded && <tr><td colSpan={8}><div id={historyId}><AgentRunHistory agent={agent} range={range} autoUpdate={autoUpdate} onAnnouncement={onAnnouncement} /></div></td></tr>}
    </>
  )
}

export default function AgentRegistryTable({ agents, presentation, snapshotAt, range, autoUpdate, showArchived, onShowArchivedChange, onManage, onAnnouncement }: AgentRegistryTableProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const sorted = [...agents]
    .filter(agent => showArchived || agent.lifecycle_status !== 'retired')
    .sort((left, right) => left.sort_order - right.sort_order || left.display_name.localeCompare(right.display_name, 'zh-CN'))
  const toggle = (id: string) => setExpanded(current => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  return (
    <section id="agent-workbench-registry" className="agent-workbench__registry" aria-labelledby="agent-workbench-registry-heading" tabIndex={-1}>
      <header><div><p>Registry</p><h2 id="agent-workbench-registry-heading">Agent 台账</h2></div><div>
        <button type="button" onClick={() => onShowArchivedChange(!showArchived)}>{showArchived ? '隐藏已归档' : '查看已归档'}</button>
        {agents.length > 0 && <button type="button" className="agent-workbench__operator-action" onClick={event => onManage({ kind: 'register' }, event.currentTarget)}>管理 Agent</button>}
      </div></header>
      {sorted.length === 0 ? <p>尚无 Agent 记录</p> : <div className="agent-workbench__table-scroll" role="region" aria-label="Agent 台账表格" tabIndex={0}>
        <table aria-label="Agent 台账">
          <thead><tr><th>Agent / 职责</th><th>生命周期</th><th>当前 / 最近</th><th>Run 数</th><th>成功率</th><th>Tokens（入/出/总）</th><th>同步 / 覆盖</th><th>操作</th></tr></thead>
          <tbody>{sorted.map(agent => <AgentRow key={agent.id} agent={agent} presentation={presentation} snapshotAt={snapshotAt} expanded={expanded.has(agent.id)} onToggle={() => toggle(agent.id)} range={range} autoUpdate={autoUpdate} onManage={onManage} onAnnouncement={onAnnouncement} />)}</tbody>
        </table>
      </div>}
    </section>
  )
}

import { useEffect, useRef, useState } from 'react'

import { api, isAbortError, type AgentRunHistory as AgentRunHistoryResponse, type ProjectedRunSummary, type WorkbenchAgent, type WorkbenchRange } from '../../api'
import { diffWorkbenchEvents, formatCompactNumber, formatWorkbenchStatus } from '../../agentWorkbenchPresentation'

type AgentRunHistoryProps = {
  agent: WorkbenchAgent
  range: WorkbenchRange
  autoUpdate: boolean
  onAnnouncement: (message: string) => void
}

const warningLabels: Record<string, string> = {
  LOCAL_TRIGGER_STATUS_MISSING: '状态待确认',
  TERMINAL_STATUS_CONFLICT: '状态冲突',
  TOKEN_USAGE_INVALID: 'Token 数据异常',
  ARCHIVE_DELAY: '归档延迟',
}

function tokenCopy(item: ProjectedRunSummary): string {
  if (item.token_state === 'known') {
    return `输入 ${formatCompactNumber(item.input_tokens ?? 0)} · 输出 ${formatCompactNumber(item.output_tokens ?? 0)} · 总计 ${formatCompactNumber(item.total_tokens ?? 0)}`
  }
  if (item.token_state === 'pending') return '完成后入账'
  if (item.token_state === 'unconfirmed') return '状态确认后判断'
  return '不可用'
}

function RunItem({ item, onAnnouncement }: { item: ProjectedRunSummary; onAnnouncement: (message: string) => void }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.coreai_run_id)
      for (const message of diffWorkbenchEvents(null, null, { kind: 'run-id-copy', runId: item.coreai_run_id, succeeded: true })) onAnnouncement(message)
    } catch {
      // Copy failure is intentionally silent; the ID remains visible and selectable.
    }
  }
  const warnings = [...new Set([...item.warning_codes, ...(item.archive_delayed ? ['ARCHIVE_DELAY'] : [])])]
  const knownNonterminal = item.presentation_group === 'queued' || item.presentation_group === 'active' || item.presentation_group === 'waiting'
  const durationCopy = item.duration_seconds !== null
    ? `${item.duration_seconds} 秒`
    : knownNonterminal
      ? `已持续 ${item.elapsed_seconds} 秒`
      : '不可用'
  return (
    <li className="agent-workbench__history-item">
      <header>
        <strong>{formatWorkbenchStatus(item.raw_status)}</strong>
        <span>{item.raw_status ?? 'NULL'} · {item.presentation_group}</span>
      </header>
      <dl>
        <div><dt>开始</dt><dd><time dateTime={item.effective_started_at} aria-label={`开始时间 ${item.effective_started_at}`}>{item.effective_started_at}</time></dd></div>
        <div><dt>完成</dt><dd>{item.completed_at ? <time dateTime={item.completed_at} aria-label={`完成时间 ${item.completed_at}`}>{item.completed_at}</time> : knownNonterminal ? '未完成' : '不可用'}</dd></div>
        <div><dt>耗时</dt><dd>{durationCopy}</dd></div>
        <div><dt>触发</dt><dd>{item.trigger_type ?? '触发来源待确认'}</dd></div>
        <div><dt>Tokens</dt><dd aria-label={item.token_state === 'known' ? `完整 Token 数 ${item.input_tokens ?? 0} ${item.output_tokens ?? 0} ${item.total_tokens ?? 0}` : undefined}>{tokenCopy(item)}</dd></div>
        <div><dt>关联</dt><dd>{item.association
          ? item.association.local_href
            ? <a href={item.association.local_href}>{item.association.local_label}</a>
            : item.association.local_label
          : '未关联商户'}</dd></div>
      </dl>
      {item.error_summary && <p className="agent-workbench__history-error">{item.error_summary}</p>}
      {warnings.length > 0 && <ul className="agent-workbench__badges">{warnings.map(code => <li key={code}>{warningLabels[code] ?? code}</li>)}</ul>}
      <div className="agent-workbench__run-id"><code>{item.coreai_run_id}</code><button type="button" onClick={() => void copy()} aria-label={`复制完整 Run ID ${item.coreai_run_id}`}>复制 ID</button></div>
    </li>
  )
}

export default function AgentRunHistory({ agent, range, autoUpdate, onAnnouncement }: AgentRunHistoryProps) {
  const [history, setHistory] = useState<AgentRunHistoryResponse | null>(null)
  const [items, setItems] = useState<ProjectedRunSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const requestRef = useRef<AbortController | null>(null)
  const historyRef = useRef<AgentRunHistoryResponse | null>(null)
  historyRef.current = history

  // Pausing stops the workbench re-reading on its own. It is not a lock on the
  // operator's own reads, so `load` never checks `autoUpdate`; callers decide.
  // `targetRange` is the range the request belongs to, which is the displayed
  // range for a fresh read and the loaded history's own range when paginating
  // a paused history whose range no longer matches the page.
  const load = (before: string | null, append: boolean, targetRange: WorkbenchRange = range) => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    void api.getAgentRunHistory(agent.id, targetRange, 20, before, controller.signal).then(response => {
      if (controller.signal.aborted || generation !== generationRef.current || response.range !== targetRange) return
      setHistory(response)
      setItems(current => append ? [...current, ...response.items] : response.items)
      setError(null)
    }).catch(error => {
      if (!isAbortError(error) && generation === generationRef.current) {
        setError(error instanceof Error ? error.message : '读取历史失败')
      }
    }).finally(() => {
      if (generation === generationRef.current) setLoading(false)
    })
  }

  useEffect(() => {
    let cancelled = false
    // Re-read when live. While paused, still perform the first read — there is
    // no earlier snapshot to preserve, and refusing it only hides history from
    // an operator who paused before opening it.
    if (autoUpdate || historyRef.current === null) {
      queueMicrotask(() => { if (!cancelled) load(null, false) })
    }
    return () => {
      cancelled = true
      generationRef.current += 1
      requestRef.current?.abort()
    }
    // Loading is bound only to the accepted aggregate range and pause state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, range, autoUpdate])

  return (
    <section className="agent-workbench__history" aria-label={`${agent.display_name} 运行历史`} aria-live="off">
      {!autoUpdate && history && history.range !== range && <p>历史仍为 {history.range} · 当前页面为 {range}</p>}
      {loading && items.length === 0 && <p>正在载入历史</p>}
      {error && <p className="agent-workbench__history-error">{error}</p>}
      {history !== null && items.length === 0 && !loading && !error && <p>此范围暂无已镜像 Run</p>}
      <ol>{items.map(item => <RunItem key={item.coreai_run_id} item={item} onAnnouncement={onAnnouncement} />)}</ol>
      {history?.next_before && <button type="button" disabled={loading} onClick={() => load(history.next_before, true, history.range)}>载入更多</button>}
    </section>
  )
}

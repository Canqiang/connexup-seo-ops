import { useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, MutableRefObject, RefObject } from 'react'

import type { PresentedCurrentCount, PresentedSignal, PresentedWorkbench } from '../../agentWorkbenchPresentation'
import { diffWorkbenchEvents, formatCompactNumber, formatWorkbenchStatus } from '../../agentWorkbenchPresentation'

type LiveRunStageProps = {
  presentation: PresentedWorkbench
  selectedSignalId?: string | null
  onSelectSignal?: (id: string) => void
  headingRef?: RefObject<HTMLHeadingElement | null>
  tabRefs?: MutableRefObject<Map<string, HTMLButtonElement>>
  onAnnouncement?: (message: string) => void
  onFocusedSignalChange?: (id: string | null) => void
  lastCompleted?: { agentName: string; completedAt: string } | null
}

function stableId(prefix: string, runId: string): string {
  return `${prefix}-${encodeURIComponent(runId).replaceAll('%', '-')}`
}

function currentBucketCopy(
  kind: 'running' | 'queued' | 'waiting',
  count: PresentedCurrentCount,
  signals: PresentedSignal[],
): string | null {
  const matching = signals.filter(signal => {
    if (kind === 'running') return signal.raw_status === 'RUNNING'
    if (kind === 'queued') return signal.raw_status === 'PENDING'
    return signal.raw_status === 'PAUSED'
  })
  const verifiedMatching = matching.filter(signal => {
    if (signal.lifecycle_status !== 'active' || !signal.locally_fresh) return false
    if (kind === 'running') return signal.signal_state === 'active'
    if (kind === 'queued') return signal.signal_state === 'queued'
    return signal.signal_state === 'waiting'
  })
  const currentOwners = new Set(verifiedMatching.map(signal => signal.local_agent_id)).size
  const cachedActiveOwners = new Set(
    matching
      .filter(signal => signal.lifecycle_status === 'active')
      .map(signal => signal.local_agent_id),
  ).size
  const suffix = kind === 'running' ? '个 Run 进行中' : kind === 'queued' ? '个排队' : '个等待输入'
  if (count.claim_is_current && count.quality === 'exact') {
    if (count.value === 0) return null
    if (
      kind === 'running' &&
      count.exact_owner_claim_allowed &&
      verifiedMatching.length === count.value &&
      currentOwners > 0
    ) return `${currentOwners} 个 Agent · ${count.value} ${suffix}`
    return `${count.value} ${suffix}`
  }
  if (count.claim_is_current && count.quality === 'lower_bound' && count.value !== null) {
    return kind === 'running' && currentOwners > 0
      ? `已看到 ${currentOwners} 个 Agent · 至少 ${count.value} ${suffix}`
      : `至少 ${count.value} ${suffix}`
  }
  if (kind === 'running' && cachedActiveOwners > 0) return `已看到 ${cachedActiveOwners} 个 Agent 的运行记录 · 当前数量未知`
  if (matching.length > 0 || count.last_observed_value !== null) {
    return kind === 'queued' ? '排队数量未知' : kind === 'waiting' ? '等待输入数量未知' : '运行中数量未知'
  }
  return null
}

function signalStatus(signal: PresentedSignal): string {
  if (!signal.locally_fresh && signal.raw_status === 'RUNNING') {
    const snapshotCopy = `截至 ${signal.last_synced_at ?? '未知'} 状态为 RUNNING`
    return signal.signal_state === 'uncertain' ? `状态待确认（${snapshotCopy}）` : snapshotCopy
  }
  if (signal.signal_state === 'uncertain' && signal.raw_status && ['RUNNING', 'PENDING'].includes(signal.raw_status)) {
    return `状态待确认（原状态 ${signal.raw_status}）`
  }
  return formatWorkbenchStatus(signal.raw_status)
}

type LifecycleNode = { label: string; state: 'complete' | 'current' | 'future' | 'unknown' }

function lifecycleNodes(signal: PresentedSignal): LifecycleNode[] {
  if (signal.signal_state === 'uncertain' || signal.raw_status === null || signal.presentation_group === 'unknown') {
    return [{ label: '上游状态待确认', state: 'unknown' }]
  }
  if (signal.signal_state === 'archiving') return [
    { label: '终态已确认', state: 'complete' },
    { label: 'SEO Ops 归档中', state: 'current' },
  ]
  if (signal.raw_status === 'PENDING') return [
    { label: '已派发 / 等待执行', state: signal.locally_fresh ? 'current' : 'unknown' },
    { label: 'Core AI Run 进行中', state: 'future' },
    { label: '等待结果归档', state: 'future' },
  ]
  if (signal.raw_status === 'RUNNING') return [
    { label: '已派发', state: 'complete' },
    { label: 'Core AI Run 进行中', state: signal.locally_fresh ? 'current' : 'unknown' },
    { label: '等待结果归档', state: 'future' },
  ]
  if (signal.raw_status === 'PAUSED') return [
    { label: '已派发', state: 'complete' },
    { label: '已进入 Core AI', state: 'complete' },
    { label: '等待输入', state: signal.locally_fresh ? 'current' : 'unknown' },
    { label: '等待结果归档', state: 'future' },
  ]
  if (signal.raw_status === 'SKIPPED') return [
    { label: '触发已记录', state: 'complete' },
    { label: '已跳过', state: 'current' },
  ]
  return [
    { label: '进入队列', state: 'complete' },
    { label: '运行中', state: 'complete' },
    { label: formatWorkbenchStatus(signal.raw_status), state: 'current' },
  ]
}

function tokenCopy(signal: PresentedSignal): string {
  if (signal.token_state === 'pending') return '完成后入账'
  if (signal.token_state === 'unavailable') return '不可用'
  if (signal.token_state === 'unconfirmed') return 'Token 待确认'
  if (
    signal.input_tokens === null ||
    signal.output_tokens === null ||
    signal.total_tokens === null ||
    !Number.isInteger(signal.input_tokens) ||
    !Number.isInteger(signal.output_tokens) ||
    !Number.isInteger(signal.total_tokens) ||
    signal.input_tokens < 0 ||
    signal.output_tokens < 0 ||
    signal.total_tokens < 0
  ) return '不可用'
  return `${formatCompactNumber(signal.total_tokens)} Tokens（输入 ${formatCompactNumber(signal.input_tokens)} · 输出 ${formatCompactNumber(signal.output_tokens)}）`
}

export default function LiveRunStage({
  presentation,
  selectedSignalId,
  onSelectSignal,
  headingRef,
  tabRefs,
  onAnnouncement,
  onFocusedSignalChange,
  lastCompleted,
}: LiveRunStageProps) {
  const [internalSelection, setInternalSelection] = useState<string | null>(null)
  const fallbackHeadingRef = useRef<HTMLHeadingElement>(null)
  const fallbackTabRefs = useRef(new Map<string, HTMLButtonElement>())
  const refs = tabRefs ?? fallbackTabRefs
  const signals = presentation.signals
  const selectedId = signals.some(signal => signal.coreai_run_id === (selectedSignalId ?? internalSelection))
    ? (selectedSignalId ?? internalSelection)
    : signals[0]?.coreai_run_id ?? null
  const selected = signals.find(signal => signal.coreai_run_id === selectedId) ?? null
  const facts = useMemo(() => {
    const values = [
      currentBucketCopy('running', presentation.current_counts.running, signals),
      currentBucketCopy('queued', presentation.current_counts.queued, signals),
      currentBucketCopy('waiting', presentation.current_counts.waiting, signals),
    ].filter((value): value is string => value !== null)
    const archiving = signals.filter(signal => signal.signal_state === 'archiving').length
    if (archiving > 0) values.push(`${archiving} 个归档中`)
    return values
  }, [presentation.current_counts, signals])

  const select = (id: string) => {
    setInternalSelection(id)
    onSelectSignal?.(id)
  }
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const offset = event.key === 'ArrowRight' ? 1 : -1
    const target = signals[(index + offset + signals.length) % signals.length]
    select(target.coreai_run_id)
    refs.current.get(target.coreai_run_id)?.focus()
  }
  const copyRunId = async (runId: string) => {
    try {
      await navigator.clipboard.writeText(runId)
      const messages = diffWorkbenchEvents(presentation, presentation, { kind: 'run-id-copy', runId, succeeded: true })
      if (messages.length > 0) onAnnouncement?.(messages.join('；'))
    } catch {
      // Clipboard denial is intentionally not announced as success.
    }
  }

  return (
    <section className="agent-workbench__stage" aria-labelledby="agent-workbench-stage-heading">
      <header className="agent-workbench__stage-header">
        <div>
          <p>Execution Signal</p>
          <h2 id="agent-workbench-stage-heading" ref={headingRef ?? fallbackHeadingRef} tabIndex={-1}>执行信号</h2>
        </div>
        {facts.length > 0 && <div className="agent-workbench__stage-facts">{facts.map(fact => <strong key={fact}>{fact}</strong>)}</div>}
      </header>

      {presentation.idle_eligible && signals.length === 0 ? (
        <div className="agent-workbench__idle">
          <strong>当前全部空闲</strong>
          {lastCompleted && <p>最近完成：{lastCompleted.agentName} · <time dateTime={lastCompleted.completedAt} aria-live="off">{lastCompleted.completedAt}</time></p>}
          <p>等待下一次派发</p>
        </div>
      ) : signals.length === 0 ? (
        <p className="agent-workbench__stage-empty">当前状态待确认</p>
      ) : (
        <>
          <div className="agent-workbench__signals" role="tablist" aria-label="当前和最近的 Agent Run">
            {signals.map((signal, index) => {
              const tabId = stableId('agent-workbench-tab', signal.coreai_run_id)
              const panelId = stableId('agent-workbench-panel', signal.coreai_run_id)
              const selectedTab = signal.coreai_run_id === selectedId
              const classes = [
                'agent-workbench__signal',
                signal.may_animate ? 'agent-workbench__signal--motion' : '',
                presentation.entering_receipt_ids.includes(signal.coreai_run_id) ? 'agent-workbench__receipt--enter' : '',
              ].filter(Boolean).join(' ')
              return (
                <button
                  key={signal.coreai_run_id}
                  ref={node => {
                    if (node) refs.current.set(signal.coreai_run_id, node)
                    else refs.current.delete(signal.coreai_run_id)
                  }}
                  id={tabId}
                  type="button"
                  role="tab"
                  aria-selected={selectedTab}
                  aria-controls={panelId}
                  tabIndex={selectedTab ? 0 : -1}
                  className={classes}
                  onClick={() => select(signal.coreai_run_id)}
                  onFocus={() => onFocusedSignalChange?.(signal.coreai_run_id)}
                  onBlur={() => onFocusedSignalChange?.(null)}
                  onKeyDown={event => handleTabKey(event, index)}
                >
                  <span className="agent-workbench__signal-dot" aria-hidden="true" />
                  <span>{signal.agent_name}</span>
                  <strong>{signalStatus(signal)}</strong>
                  {signal.lifecycle_status !== 'active' && <small>{signal.lifecycle_status === 'disabled' ? '已停用 Agent' : '已归档 Agent'}</small>}
                </button>
              )
            })}
          </div>

          {selected && (
            <article
              id={stableId('agent-workbench-panel', selected.coreai_run_id)}
              role="tabpanel"
              aria-labelledby={stableId('agent-workbench-tab', selected.coreai_run_id)}
              className={`agent-workbench__signal-detail${selected.may_animate ? ' agent-workbench__signal-detail--motion' : ''}`}
            >
              <div className="agent-workbench__signal-identity">
                <div><span>Agent</span><strong>{selected.agent_name}</strong><small>{selected.agent_role}</small></div>
                <div><span>状态</span><strong>{signalStatus(selected)}</strong><small>上游状态：{selected.raw_status ?? '未返回'}</small></div>
                <div>
                  <span>业务关联</span>
                  {selected.association?.local_href
                    ? <a href={selected.association.local_href}>{selected.association.local_label}</a>
                    : <strong>{selected.association?.local_label ?? '未关联商户'}</strong>}
                </div>
              </div>

              <ol className="agent-workbench__rail" aria-label="已验证生命周期">
                {lifecycleNodes(selected).map(node => (
                  <li key={node.label} data-state={node.state} aria-current={node.state === 'current' ? 'step' : undefined}>
                    <span aria-hidden="true" />{node.label}
                  </li>
                ))}
              </ol>

              <dl className="agent-workbench__facts">
                <div><dt>持续时间</dt><dd><time dateTime={selected.effective_started_at} aria-live="off" aria-label={`开始时间 ${selected.effective_started_at}`}>{selected.timing_copy}</time>{selected.started_at === null && <small>（按首次观测时间）</small>}</dd></div>
                <div><dt>触发来源</dt><dd>{selected.trigger_type ?? '触发来源待确认'}</dd></div>
                <div><dt>Token</dt><dd>{tokenCopy(selected)}</dd></div>
                <div><dt>同步</dt><dd>{selected.last_synced_at ? `上次成功同步 ${selected.last_synced_at}` : '尚无成功同步'} · {selected.locally_fresh ? '状态新鲜' : '显示已保存数据'}</dd></div>
                <div><dt>Run ID</dt><dd><code aria-label={`完整 Run ID ${selected.coreai_run_id}`}>{selected.coreai_run_id.length > 16 ? `${selected.coreai_run_id.slice(0, 8)}…${selected.coreai_run_id.slice(-4)}` : selected.coreai_run_id}</code><button type="button" aria-label={`复制完整 Run ID ${selected.coreai_run_id}`} onClick={() => void copyRunId(selected.coreai_run_id)}>复制</button></dd></div>
              </dl>
            </article>
          )}
        </>
      )}
    </section>
  )
}

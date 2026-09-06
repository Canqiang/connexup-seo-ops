import type { AgentWorkbenchSnapshot } from '../../api'
import { formatCompactNumber, type PresentedCurrentCount, type PresentedWorkbench } from '../../agentWorkbenchPresentation'

type AgentSummaryMetricsProps = {
  snapshot: AgentWorkbenchSnapshot
  presentation: PresentedWorkbench
}

function CurrentMetric({ label, count }: { label: string; count: PresentedCurrentCount }) {
  const copy = count.quality === 'exact' && count.claim_is_current
    ? String(count.value)
    : count.quality === 'lower_bound' && count.claim_is_current
      ? `至少 ${count.value}`
      : count.quality === 'unknown' ? count.copy : '状态待确认'
  return <div className="agent-workbench__summary-current" aria-label={`${label} ${copy}`}><dt>{label}</dt><dd>{copy}</dd></div>
}

function coverageCopy(snapshot: AgentWorkbenchSnapshot): string | null {
  if (snapshot.metrics_complete_for_range && snapshot.coverage.range_complete) return null
  const mirrored = snapshot.coverage.mirrored_run_count
  return snapshot.coverage.remote_total_runs === null
    ? `基于已镜像 ${mirrored} 次 · 上游总数未知`
    : `基于已镜像 ${mirrored}/${snapshot.coverage.remote_total_runs} 次`
}

function Metric({ label, value, qualifier }: { label: string; value: number | string; qualifier: string | null }) {
  const accessible = typeof value === 'number' ? String(value) : value
  return (
    <div className="agent-workbench__summary-metric">
      <dt>{label}</dt>
      <dd aria-label={`${label} ${accessible}`}>
        {typeof value === 'number' ? formatCompactNumber(value) : value}
      </dd>
      {qualifier && <small>{qualifier}</small>}
    </div>
  )
}

export default function AgentSummaryMetrics({ snapshot, presentation }: AgentSummaryMetricsProps) {
  const qualifier = coverageCopy(snapshot)
  return (
    <section className="agent-workbench__summary" aria-label="Agent 汇总">
      <h2>范围汇总</h2>
      <dl>
        <Metric label="Run 数" value={snapshot.summary.run_count} qualifier={qualifier} />
        <Metric label="成功完成" value={snapshot.summary.successful_runs} qualifier={qualifier} />
        <Metric
          label="成功率"
          value={snapshot.summary.success_rate === null ? '—' : `${Math.round(snapshot.summary.success_rate * 100)}%`}
          qualifier={qualifier}
        />
        <Metric label="已知总 Tokens" value={snapshot.summary.known_total_tokens} qualifier={qualifier} />
        <Metric
          label="Token 覆盖"
          value={`已知 ${snapshot.summary.token_known_runs}/${snapshot.summary.token_eligible_runs} 次`}
          qualifier={qualifier}
        />
      </dl>
      <dl className="agent-workbench__summary-current-list" aria-label="当前状态数量">
        <CurrentMetric label="当前运行" count={presentation.current_counts.running} />
        <CurrentMetric label="当前排队" count={presentation.current_counts.queued} />
        <CurrentMetric label="当前等待" count={presentation.current_counts.waiting} />
        {(presentation.current_counts.legacy_nonterminal.value !== 0 || presentation.current_counts.legacy_nonterminal.quality !== 'exact') && (
          <CurrentMetric label="其他非终态" count={presentation.current_counts.legacy_nonterminal} />
        )}
      </dl>
    </section>
  )
}

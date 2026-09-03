import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type PerformanceDashboard as PerformanceDashboardData } from '../api'

const number = new Intl.NumberFormat('en-US')

const statusText = {
  ready: '已就绪',
  unbound: '未绑定 FBR',
  not_synced: '未同步',
  syncing: '同步中',
  failed: '同步失败',
  no_performance: '无绩效数据',
} as const

function displayNumber(value: number | null) {
  return value === null ? '—' : number.format(value)
}

function displayDate(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

function displayRating(value: number | null) {
  return value === null ? '—' : value.toFixed(1)
}

function displayReplyRate(value: number | null) {
  return value === null ? '—' : `${Math.round(value * 100)}%`
}

type TrendMetric = 'total' | 'search' | 'map'
const dayInMilliseconds = 24 * 60 * 60 * 1000

const trendMetrics: Array<{ id: TrendMetric; label: string; value: (point: PerformanceDashboardData['trends'][number]) => number }> = [
  { id: 'total', label: '总曝光', value: point => point.map_views + point.search_views },
  { id: 'search', label: 'Google搜索', value: point => point.search_views },
  { id: 'map', label: 'Google地图', value: point => point.map_views },
]

function formatTimelineDate(value: string) {
  const [, month, day] = value.split('-')
  return month && day ? `${Number(month)}/${Number(day)}` : value
}

function timelineTimestamp(value: string) {
  return new Date(`${value}T00:00:00Z`).getTime()
}

function timelineDate(timestamp: number) {
  return new Date(timestamp).toISOString().slice(0, 10)
}

function isWeekend(timestamp: number) {
  const date = new Date(timestamp)
  return date.getUTCDay() === 0 || date.getUTCDay() === 6
}

function chartMaximum(value: number) {
  if (value <= 1) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 2 ? 0.5 : normalized <= 5 ? 1 : 2
  return Math.ceil(value / (step * magnitude)) * step * magnitude
}

function chartLabelIndexes(length: number) {
  if (length <= 4) return Array.from({ length }, (_, index) => index)
  const indexes = new Set([0, length - 1])
  const step = (length - 1) / 4
  for (let index = 1; index < 4; index += 1) indexes.add(Math.round(index * step))
  return [...indexes].sort((left, right) => left - right)
}

function TrendChart({ trends }: { trends: PerformanceDashboardData['trends'] }) {
  const [metricId, setMetricId] = useState<TrendMetric>('total')
  const metric = trendMetrics.find(option => option.id === metricId) ?? trendMetrics[0]
  const coverages = trends.map(point => point.merchant_coverage)
  const minimumCoverage = coverages.length ? Math.min(...coverages) : 0
  const maximumCoverage = coverages.length ? Math.max(...coverages) : 0
  const coverageChanges = minimumCoverage !== maximumCoverage
  const coverageNote = coverageChanges
    ? `每日覆盖 ${minimumCoverage}–${maximumCoverage} 家，总量不可直接作同口径比较`
    : `每日可比覆盖 ${minimumCoverage} 家`

  return <>
    <div className="dashboard-trend-card-header">
      <div>
        <h2 id="dashboard-trend-title">搜索+地图曝光量 · 逐日趋势</h2>
        <p>仅汇总同日同时有搜索和地图曝光的商户。</p>
      </div>
      {trends.length > 0 && <span className={`dashboard-trend-coverage-badge${coverageChanges ? ' warning' : ''}`}>{coverageNote}</span>}
    </div>
    <div className="dashboard-trend-tabs" role="group" aria-label="趋势指标">
      {trendMetrics.map(option => <button
        key={option.id}
        type="button"
        className={option.id}
        aria-pressed={metric.id === option.id}
        onClick={() => setMetricId(option.id)}
      >{option.label}</button>)}
    </div>
    {!trends.length
      ? <p className="dashboard-empty-trend">当前窗口没有可展示的搜索或地图日趋势；请等待下一次成功同步。</p>
      : <TrendFigure trends={trends} metric={metric} coverageNote={coverageNote} coverageChanges={coverageChanges} />}
  </>
}

function TrendFigure({ trends, metric, coverageNote, coverageChanges }: {
  trends: PerformanceDashboardData['trends']
  metric: typeof trendMetrics[number]
  coverageNote: string
  coverageChanges: boolean
}) {
  const width = 1040
  const height = 260
  const padding = { left: 48, right: 14, top: 18, bottom: 44 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const datedTrends = trends
    .map(point => ({ point, timestamp: timelineTimestamp(point.metric_date) }))
    .sort((left, right) => left.timestamp - right.timestamp)
  const firstTimestamp = datedTrends[0].timestamp
  const lastTimestamp = datedTrends.at(-1)?.timestamp ?? firstTimestamp
  const calendarDayCount = Math.max(1, Math.round((lastTimestamp - firstTimestamp) / dayInMilliseconds) + 1)
  const calendarDays = Array.from({ length: calendarDayCount }, (_, index) => firstTimestamp + dayInMilliseconds * index)
  const values = datedTrends.map(({ point }) => metric.value(point))
  const highest = Math.max(...values, 0)
  const maximum = chartMaximum(highest)
  const step = chartWidth / calendarDayCount
  const xForTimestamp = (timestamp: number) => padding.left + step * ((timestamp - firstTimestamp) / dayInMilliseconds + 0.5)
  const yForValue = (value: number) => padding.top + chartHeight * (1 - value / maximum)
  const path = datedTrends.map(({ timestamp }, index) => {
    const startsSegment = index === 0 || timestamp - datedTrends[index - 1].timestamp !== dayInMilliseconds
    return `${startsSegment ? 'M' : 'L'}${xForTimestamp(timestamp).toFixed(1)},${yForValue(values[index]).toFixed(1)}`
  }).join(' ')
  const first = datedTrends[0].point.metric_date
  const last = datedTrends.at(-1)?.point.metric_date ?? first
  const description = `${metric.label}逐日趋势：${first} 至 ${last}；最高日${metric.label} ${number.format(highest)}；${coverageNote}。`
  const labelIndexes = chartLabelIndexes(calendarDays.length)

  return <figure className="dashboard-trend-figure">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={description}>
      <title>{description}</title>
      {calendarDays.map((timestamp, index) => isWeekend(timestamp) && <rect
        key={`weekend-${timelineDate(timestamp)}`}
        className="dashboard-chart-weekend"
        x={padding.left + step * index}
        y={padding.top}
        width={step}
        height={chartHeight}
      />)}
      {Array.from({ length: 4 }, (_, index) => {
        const ratio = index / 3
        const y = padding.top + chartHeight * (1 - ratio)
        return <g key={index}>
          <line x1={padding.left} y1={y} x2={width - padding.right} y2={y} className="dashboard-chart-grid" />
          <text x={padding.left - 8} y={y} className="dashboard-chart-y-label">{number.format(Math.round(maximum * ratio))}</text>
        </g>
      })}
      <line x1={padding.left} y1={padding.top + chartHeight} x2={width - padding.right} y2={padding.top + chartHeight} className="dashboard-chart-axis" />
      <path d={path} className={`dashboard-chart-line ${metric.id}`} />
      {datedTrends.map(({ point, timestamp }, index) => {
        const value = values[index]
        const dailyDescription = `${point.metric_date}：${metric.label} ${number.format(value)}；可比覆盖 ${point.merchant_coverage} 家`
        return <g key={point.metric_date} aria-hidden="true">
          <title>{dailyDescription}</title>
          <circle data-metric-date={point.metric_date} cx={xForTimestamp(timestamp)} cy={yForValue(value)} r="3.6" className={`dashboard-chart-point ${metric.id}`} />
        </g>
      })}
      {labelIndexes.map(index => <text key={timelineDate(calendarDays[index])} x={xForTimestamp(calendarDays[index])} y={height - padding.bottom + 10} className="dashboard-chart-x-label">{formatTimelineDate(timelineDate(calendarDays[index]))}</text>)}
    </svg>
    <table className="visually-hidden">
      <caption>{metric.label}趋势数据</caption>
      <thead><tr><th scope="col">日期</th><th scope="col">{metric.label}</th><th scope="col">可比覆盖</th></tr></thead>
      <tbody>{datedTrends.map(({ point }, index) => <tr key={point.metric_date}>
        <td>{point.metric_date}</td><td>{number.format(values[index])}</td><td>{point.merchant_coverage} 家</td>
      </tr>)}</tbody>
    </table>
    <figcaption>
      <span>横轴为实际日期，灰色背景为周末；缺失日期不补零，折线断开。</span>
      <span>当前仅展示一次同步快照内的逐日值，不提供跨期比较。</span>
      {coverageChanges && <span>覆盖变化会影响总量。</span>}
    </figcaption>
  </figure>
}

function Metric({ label, metric }: { label: string; metric: { value: number | null; merchant_coverage: number } }) {
  return <div className="dashboard-metric">
    <span>{label}</span>
    <strong>{metric.value === null ? 'N/A' : number.format(metric.value)}</strong>
    <small>覆盖 {metric.merchant_coverage} 家</small>
  </div>
}

export default function PerformanceDashboard() {
  const [dashboard, setDashboard] = useState<PerformanceDashboardData | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getPerformanceDashboard().then(setDashboard).catch(err => setError((err as Error).message))
  }, [])

  if (error) return <main aria-label="数据看板"><h1>Performance 数据看板</h1><p className="error" role="alert">读取数据看板失败：{error}</p></main>
  if (!dashboard) return <main aria-label="数据看板"><h1>Performance 数据看板</h1><p className="page-summary">正在读取最近一次成功同步的表现快照…</p></main>

  const gaps = dashboard.merchants.filter(merchant => merchant.data_status !== 'ready')
  const { coverage, totals, window } = dashboard

  return (
    <main className="performance-dashboard" aria-label="数据看板">
      <header className="dashboard-heading">
        <div>
          <p className="eyebrow">PERFORMANCE / FBR + GBP SNAPSHOT</p>
          <h1>Performance 数据看板</h1>
          <p className="page-summary">全部在营商户 · {window.label}{window.start || window.end ? `（${window.start ?? '—'} 至 ${window.end ?? '—'}）` : ''}</p>
        </div>
        <dl className="dashboard-coverage">
          <div><dt>在营商户</dt><dd>{coverage.active_merchants} 家</dd></div>
          <div><dt>有表现商户</dt><dd>{coverage.merchants_with_performance} 家</dd></div>
          <div><dt>覆盖地点</dt><dd>{coverage.locations_with_performance} 个</dd></div>
          <div><dt>最后同步</dt><dd>{displayDate(coverage.latest_synced_at)}</dd></div>
        </dl>
      </header>

      <p className="dashboard-method-note">数据来自最近一次成功同步的 FBR/GBP 快照；行动为事件次数，不代表人数、到店、订单或转化；当前仅展示已同步快照，不提供跨期比较</p>

      <section className="dashboard-stat-strip" aria-label="汇总表现">
        <Metric label="总曝光" metric={totals.total_views} />
        <Metric label="地图曝光" metric={totals.map_views} />
        <Metric label="搜索曝光" metric={totals.search_views} />
        <Metric label="已记录行动事件" metric={totals.action_events} />
      </section>

      <section className="dashboard-trend-panel" aria-labelledby="dashboard-trend-title">
        <TrendChart trends={dashboard.trends} />
      </section>

      <section aria-labelledby="dashboard-merchants-title">
        <div className="dashboard-table-heading"><div><h2 id="dashboard-merchants-title">商户表现台账</h2><p>点击商户进入 GBP 表现明细。</p></div><span>{dashboard.merchants.length} 家商户</span></div>
        <div className="dashboard-table-viewport" role="region" aria-label="商户表现表" tabIndex={0}>
          <table className="dashboard-table">
            <thead><tr><th>商户</th><th>总曝光</th><th>路线</th><th>官网</th><th>电话</th><th>评分 / 回复率</th><th>数据状态</th><th>最后同步</th></tr></thead>
            <tbody>{dashboard.merchants.map(merchant => <tr key={merchant.merchant_id}>
              <th scope="row"><Link to={`/merchants/${merchant.merchant_id}/profile#gbp-performance`}>{merchant.name}</Link><small>{merchant.primary_location ?? '—'} · {merchant.location_count} 个地点</small></th>
              <td>{displayNumber(merchant.total_views)}</td><td>{displayNumber(merchant.direction_requests)}</td><td>{displayNumber(merchant.website_clicks)}</td><td>{displayNumber(merchant.call_clicks)}</td>
              <td>评分 {displayRating(merchant.review_average_rating)} / 回复率 {displayReplyRate(merchant.review_reply_rate)}</td>
              <td><span className={`dashboard-status ${merchant.data_status}`}>{statusText[merchant.data_status]}</span></td><td>{displayDate(merchant.synced_at)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>

      <section className="dashboard-gaps" aria-labelledby="dashboard-gaps-title">
        <h2 id="dashboard-gaps-title">数据缺口</h2>
        {gaps.length ? <ul>{gaps.map(merchant => <li key={merchant.merchant_id}><strong>{merchant.name}</strong><span className={`dashboard-status ${merchant.data_status}`}>{statusText[merchant.data_status]}</span><span>{merchant.data_status === 'unbound' ? '需要绑定 FBR 商户后才能读取 GBP 表现。' : merchant.data_status === 'failed' ? '最近一次同步失败，请查看商户资料中的同步错误。' : merchant.data_status === 'not_synced' ? '尚未完成首次成功同步。' : merchant.data_status === 'syncing' ? '同步正在进行，完成后再回读。' : '已同步资料，但当前窗口未返回表现指标。'}</span></li>)}</ul> : <p>当前没有未绑定、失败、未同步、同步中或无绩效数据的商户。</p>}
      </section>
    </main>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ApiError, api, isAbortError } from '../api'
import type {
  ComparisonMode,
  MerchantPerformance as MerchantPerformanceData,
  MerchantPerformanceQuery,
  PerformanceKpi,
  PerformanceLocationSummary,
  PerformanceLocations,
  PerformanceSeriesPoint,
} from '../performanceTypes'
import MerchantSectionNav from '../components/MerchantSectionNav'
import { EmptyState, LoadingState, Notice } from '../components/feedback'
import { formatTime } from '../format'

const TIMEZONE_OPTIONS = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles']

const COMPARISON_MODES: ComparisonMode[] = ['previous_equal_length', 'previous_complete_calendar_month', 'custom']
const COMPARISON_LABELS: Record<ComparisonMode, string> = {
  previous_equal_length: '环比上一等长周期',
  previous_complete_calendar_month: '环比上一自然月',
  custom: '自定义对比区间',
}

const DELTA_REASON_LABELS: Record<string, string> = {
  comparison_zero: '对比期为 0，无法计算百分比变化',
  current_unavailable: '当前周期无数据',
  comparison_unavailable: '对比周期无数据',
}

const MISSING_REASON_LABELS: Record<string, string> = {
  no_observation: '未同步',
  metric_unavailable: '来源未提供',
}

const QUALITY_CATEGORY_LABELS: Record<string, string> = {
  source_omits_metric_rows: '来源未返回该指标行',
}

const QUALITY_SEVERITY_LABELS: Record<string, string> = {
  red: '严重',
  yellow: '警示',
}

const SOURCE_STATUS_LABELS: Record<string, string> = {
  ready: '就绪',
  no_data: '暂无数据',
}

/** Format a canonical decimal string for display -- string-only, never a numeric round-trip. */
function formatDecimal(value: string | null): string {
  if (value === null) return '无数据'
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(value)
  if (!match) return value
  const [, sign, integer, fraction = ''] = match
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}${fraction}`
}

function formatDelta(delta: string): string {
  return delta.startsWith('-') ? `${delta}%` : `+${delta}%`
}

function deltaClass(delta: string): string {
  if (/^-?0(\.0+)?$/.test(delta)) return 'performance-delta performance-delta-flat'
  if (delta.startsWith('-')) return 'performance-delta performance-delta-down'
  return 'performance-delta performance-delta-up'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

function parseISODate(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day))
}

/** The calendar date `instant` falls on inside `timeZone`, as an ISO string -- via the built-in Intl API, no new dependency. */
function storeDateIso(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant)
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '01'
  return `${get('year')}-${get('month')}-${get('day')}`
}

function addDaysIso(iso: string, delta: number): string {
  const date = parseISODate(iso)
  date.setUTCDate(date.getUTCDate() + delta)
  return formatISODate(date)
}

/**
 * The reference date for preset/default-period math, resolved in the bound
 * locations' own timezone(s) rather than the browser's -- an account
 * manager whose browser sits in a different timezone from the store must
 * not get a default period or preset that is off by a calendar day near
 * local midnight.
 *
 * Exactly mirrors the backend's own `resolve_default_end`
 * (`api/app/performance_identity.py`): for each timezone, take store-local
 * *yesterday* (`local_today - 1 day`) -- never today, which is still in
 * progress and would only guarantee an empty trailing cell -- then, when
 * several locations are selected, the earliest (`min`) of those per-scope
 * yesterdays. Locations share one timezone in this pilot, so the tie-break
 * is usually moot; ISO date strings sort lexicographically the same as
 * chronologically, so a plain string sort after subtracting the day finds
 * that minimum.
 */
function referenceDateIso(timeZones: string[]): string {
  const now = new Date()
  const zones = timeZones.length === 0 ? ['UTC'] : timeZones
  return zones.map(tz => addDaysIso(storeDateIso(tz, now), -1)).sort()[0]
}

function lastNDays(n: number, reference: Date): { start: string; end: string } {
  const end = reference
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (n - 1))
  return { start: formatISODate(start), end: formatISODate(end) }
}

function thisMonth(reference: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1))
  return { start: formatISODate(start), end: formatISODate(reference) }
}

function lastMonth(reference: Date): { start: string; end: string } {
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 0))
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
  return { start: formatISODate(start), end: formatISODate(end) }
}

// The backend's own default (resolve_default_end, exercised only when a
// request omits `current` entirely) is a trailing 28 days; match it here
// too, since this fallback fires on every first page load.
function currentPeriodFromParams(searchParams: URLSearchParams, reference: Date): { start: string; end: string } {
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  if (from && to) return { start: from, end: to }
  return lastNDays(28, reference)
}

function parseComparisonMode(raw: string | null): ComparisonMode {
  return raw && (COMPARISON_MODES as string[]).includes(raw) ? (raw as ComparisonMode) : 'previous_equal_length'
}

function parseLocationParam(raw: string | null): number[] | null {
  if (!raw) return null
  const ids = raw.split(',').map(Number).filter(id => Number.isInteger(id))
  return ids.length ? ids : null
}

function buildQueryBody(searchParams: URLSearchParams, reference: Date): MerchantPerformanceQuery {
  const period = currentPeriodFromParams(searchParams, reference)
  const mode = parseComparisonMode(searchParams.get('cmp'))
  const comparison = mode === 'custom'
    ? { mode, start: searchParams.get('cmpFrom') ?? period.start, end: searchParams.get('cmpTo') ?? period.end }
    : { mode }
  return {
    location_ids: parseLocationParam(searchParams.get('locations')) ?? [],
    current: period,
    comparison,
    granularity: 'day',
  }
}

type PerformanceErrorKind = 'not_enabled' | 'timezone_missing' | 'other'

function classifyPerformanceError(err: unknown): { kind: PerformanceErrorKind; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof ApiError && err.status === 409 && message === 'history_read_not_enabled_for_merchant') {
    return { kind: 'not_enabled', message }
  }
  if (err instanceof ApiError && err.status === 409 && message === 'location_timezone_missing') {
    return { kind: 'timezone_missing', message }
  }
  return { kind: 'other', message }
}

function KpiCard({ kpi }: { kpi: PerformanceKpi }) {
  return (
    <article className="performance-kpi-card">
      <h3>{kpi.label}</h3>
      <strong className="performance-kpi-value">{formatDecimal(kpi.current.value)}</strong>
      <p className="performance-kpi-compare">
        {kpi.comparison ? <>vs {formatDecimal(kpi.comparison.value)}</> : '无对比期'}
        {' '}
        {kpi.delta !== null
          ? <span className={deltaClass(kpi.delta)}>{formatDelta(kpi.delta)}</span>
          : <span className="performance-kpi-delta-na">{(kpi.delta_reason && DELTA_REASON_LABELS[kpi.delta_reason]) ?? '无法计算环比'}</span>}
      </p>
      {kpi.current.completeness === 'partial'
        && <p className="performance-kpi-partial">数据不完整（{kpi.current.observed}/{kpi.current.expected} 天）</p>}
      {kpi.metric_key === 'CALL_CLICKS' && <p className="performance-kpi-footnote">电话按钮点击 ≠ 接通或到店</p>}
    </article>
  )
}

function seriesReasonText(point: PerformanceSeriesPoint): string {
  if (point.missing_reason === null) return ''
  return MISSING_REASON_LABELS[point.missing_reason] ?? point.missing_reason
}

function SeriesTable({ series }: { series: MerchantPerformanceData['series'][number] | undefined }) {
  if (!series || series.points.length === 0) {
    return <p className="performance-empty-note">当前周期没有逐日数据。</p>
  }
  return (
    <div className="performance-table-viewport">
      <table className="performance-table">
        <caption>{series.label} · 逐日</caption>
        <thead><tr><th scope="col">日期</th><th scope="col">数值</th><th scope="col">说明</th></tr></thead>
        <tbody>
          {series.points.map(point => (
            <tr key={point.date}>
              <th scope="row">{point.date}</th>
              <td>{point.value === null ? '无数据' : formatDecimal(point.value)}</td>
              <td>{seriesReasonText(point)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function QualityTable({ quality }: { quality: MerchantPerformanceData['quality'] }) {
  if (quality.length === 0) return <p className="performance-empty-note">当前周期没有数据质量提示。</p>
  return (
    <div className="performance-table-viewport">
      <table className="performance-table">
        <thead><tr><th scope="col">来源</th><th scope="col">问题</th><th scope="col">级别</th><th scope="col">影响期间</th><th scope="col">详情</th></tr></thead>
        <tbody>
          {quality.map((event, index) => (
            <tr key={index}>
              <td>{event.source}</td>
              <td>{QUALITY_CATEGORY_LABELS[event.category] ?? event.category}</td>
              <td>{QUALITY_SEVERITY_LABELS[event.severity] ?? event.severity}</td>
              <td>{event.start_date ?? '—'} 至 {event.end_date ?? '—'}</td>
              <td>{Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`).join('；') || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SourcesTable({ sources }: { sources: MerchantPerformanceData['sources'] }) {
  if (sources.length === 0) return <p className="performance-empty-note">当前没有可用的数据来源信息。</p>
  return (
    <div className="performance-table-viewport">
      <table className="performance-table">
        <thead><tr><th scope="col">来源</th><th scope="col">日期基准</th><th scope="col">数据截至</th><th scope="col">最近成功同步</th><th scope="col">状态</th></tr></thead>
        <tbody>
          {sources.map((source, index) => (
            <tr key={index}>
              <td>{source.source}</td>
              <td>{source.date_basis}</td>
              <td>{source.source_data_through ?? '—'}</td>
              <td>{formatTime(source.last_success_sync_at)}</td>
              <td>{SOURCE_STATUS_LABELS[source.status] ?? source.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BackfillNotes({ notes }: { notes: MerchantPerformanceData['backfill_notes'] }) {
  if (notes.length === 0) return <p className="performance-empty-note">该周期内没有数据修正记录。</p>
  return (
    <ul className="performance-backfill-notes">
      {notes.map((note, index) => <li key={index}>{note.business_date} · {note.metric_key}</li>)}
    </ul>
  )
}

function PerformanceResults({ data }: { data: MerchantPerformanceData }) {
  const { periods } = data
  return (
    <>
      <p className="performance-period-summary">
        当前：{periods.current.start} 至 {periods.current.end}（共 {periods.current.days} 天）
        {periods.comparison
          ? <> · 对比：{periods.comparison.start} 至 {periods.comparison.end}{periods.basis === 'daily_average' ? '（按日均值换算）' : ''}</>
          : ' · 无对比期'}
      </p>

      <section aria-labelledby="performance-kpis-title">
        <h2 id="performance-kpis-title">核心指标</h2>
        <div className="performance-kpi-grid">
          {data.kpis.map(kpi => <KpiCard key={kpi.metric_key} kpi={kpi} />)}
        </div>
      </section>

      <section aria-labelledby="performance-series-title">
        <h2 id="performance-series-title">逐日明细</h2>
        <SeriesTable series={data.series[0]} />
      </section>

      <section aria-labelledby="performance-quality-title">
        <h2 id="performance-quality-title">数据质量</h2>
        <QualityTable quality={data.quality} />
      </section>

      <section aria-labelledby="performance-sources-title">
        <h2 id="performance-sources-title">数据来源</h2>
        <SourcesTable sources={data.sources} />
      </section>

      <section aria-labelledby="performance-backfill-title">
        <h2 id="performance-backfill-title">数据补齐 / 修正</h2>
        <BackfillNotes notes={data.backfill_notes} />
      </section>
    </>
  )
}

function TimezoneGateItem({ location, onSaved }: { location: PerformanceLocationSummary; onSaved: () => void }) {
  const [tz, setTz] = useState(TIMEZONE_OPTIONS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.setLocationTimezone(location.location_id, tz)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="performance-timezone-gate-item">
      <Notice tone="warning">{`门店「${location.display_name}」尚未设置时区，无法按门店本地日聚合`}</Notice>
      <div className="performance-timezone-form">
        <label>
          时区
          <select
            aria-label={`选择「${location.display_name}」的时区`}
            value={tz}
            onChange={event => setTz(event.target.value)}
          >
            {TIMEZONE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <button type="button" onClick={() => void save()} disabled={busy}>{busy ? '保存中…' : '保存时区'}</button>
        {error && <Notice tone="error">{error}</Notice>}
      </div>
    </div>
  )
}

export default function MerchantPerformance() {
  const { id } = useParams()
  return <MerchantPerformancePage key={id ?? 'invalid'} merchantId={Number(id)} />
}

function MerchantPerformancePage({ merchantId }: { merchantId: number }) {
  const validMerchantId = Number.isInteger(merchantId) && merchantId > 0
  const [searchParams, setSearchParams] = useSearchParams()
  const mountedRef = useRef(false)
  const locationsEpochRef = useRef(0)
  const queryEpochRef = useRef(0)
  const queryControllerRef = useRef<AbortController | null>(null)

  const [locationsState, setLocationsState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [locationsError, setLocationsError] = useState('')
  const [locationsData, setLocationsData] = useState<PerformanceLocations | null>(null)

  const [perfState, setPerfState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [perfError, setPerfError] = useState<{ kind: PerformanceErrorKind; message: string } | null>(null)
  const [performanceData, setPerformanceData] = useState<MerchantPerformanceData | null>(null)

  const [draftLocationIds, setDraftLocationIds] = useState<Set<number>>(new Set())
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [draftCmp, setDraftCmp] = useState<ComparisonMode>('previous_equal_length')
  const [draftCmpFrom, setDraftCmpFrom] = useState('')
  const [draftCmpTo, setDraftCmpTo] = useState('')

  const loadLocations = useCallback(() => {
    const epoch = ++locationsEpochRef.current
    setLocationsState('loading')
    api.getPerformanceLocations(merchantId)
      .then(data => {
        if (!mountedRef.current || locationsEpochRef.current !== epoch) return
        setLocationsData(data)
        setLocationsState('ready')
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || !mountedRef.current || locationsEpochRef.current !== epoch) return
        setLocationsData(null)
        setLocationsError(err instanceof Error ? err.message : String(err))
        setLocationsState('error')
      })
  }, [merchantId])

  // Effects here only ever schedule these callbacks (via setTimeout(fn, 0))
  // rather than invoking them synchronously in the effect body -- the
  // callbacks themselves set state (loading flags, derived draft fields)
  // before their first await, and doing that synchronously inside an effect
  // is exactly the "you might not need an effect" anti-pattern; deferring
  // by one tick keeps the state update where React expects it, in a task
  // instead of the render-commit phase. Same idiom as TasksOverview's load().
  useEffect(() => {
    mountedRef.current = true
    const timer = validMerchantId ? window.setTimeout(loadLocations, 0) : null
    return () => {
      mountedRef.current = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [validMerchantId, loadLocations])

  // Resolved in the bound locations' own timezone(s), not the browser's --
  // `referenceIso` is a primitive, so it is stable across renders (by
  // value) for use as a dependency below, unlike a freshly-constructed
  // Date each render.
  const timeZones = locationsData
    ? locationsData.locations.map(loc => loc.timezone_name).filter((tz): tz is string => tz !== null)
    : []
  const referenceIso = referenceDateIso(timeZones)

  // `searchParams` is a stable reference from react-router (memoized on the
  // location's search string), so it is safe to depend on directly here.
  const syncDraftFromParams = useCallback(() => {
    if (locationsState !== 'ready' || !locationsData) return
    const allIds = locationsData.locations.map(loc => loc.location_id)
    const selected = parseLocationParam(searchParams.get('locations'))
    setDraftLocationIds(new Set(selected ?? allIds))
    const period = currentPeriodFromParams(searchParams, parseISODate(referenceIso))
    setDraftFrom(period.start)
    setDraftTo(period.end)
    setDraftCmp(parseComparisonMode(searchParams.get('cmp')))
    setDraftCmpFrom(searchParams.get('cmpFrom') ?? period.start)
    setDraftCmpTo(searchParams.get('cmpTo') ?? period.end)
  }, [locationsState, locationsData, searchParams, referenceIso])

  useEffect(() => {
    const timer = window.setTimeout(syncDraftFromParams, 0)
    return () => window.clearTimeout(timer)
  }, [syncDraftFromParams])

  const missingTimezoneLocations = locationsData ? locationsData.locations.filter(loc => loc.timezone_name === null) : []
  const gateBlockedByFeature = locationsData !== null && !locationsData.history_read_enabled
  const gateBlockedByTimezone = missingTimezoneLocations.length > 0
  const blockedByGate = gateBlockedByFeature || gateBlockedByTimezone

  const runQuery = useCallback(() => {
    if (!validMerchantId || locationsState !== 'ready' || blockedByGate) return
    const epoch = ++queryEpochRef.current
    queryControllerRef.current?.abort()
    const controller = new AbortController()
    queryControllerRef.current = controller
    setPerfState('loading')
    setPerfError(null)
    const body = buildQueryBody(searchParams, parseISODate(referenceIso))
    api.queryMerchantPerformance(merchantId, body, controller.signal)
      .then(data => {
        if (!mountedRef.current || queryEpochRef.current !== epoch) return
        setPerformanceData(data)
        setPerfState('ready')
      })
      .catch((err: unknown) => {
        if (isAbortError(err) || !mountedRef.current || queryEpochRef.current !== epoch) return
        setPerformanceData(null)
        setPerfError(classifyPerformanceError(err))
        setPerfState('error')
      })
  }, [merchantId, validMerchantId, locationsState, blockedByGate, searchParams, referenceIso])

  useEffect(() => {
    const timer = window.setTimeout(runQuery, 0)
    return () => {
      window.clearTimeout(timer)
      queryControllerRef.current?.abort()
    }
  }, [runQuery])

  const toggleLocation = (locationId: number) => {
    setDraftLocationIds(prev => {
      const next = new Set(prev)
      if (next.has(locationId)) next.delete(locationId)
      else next.add(locationId)
      return next
    })
  }

  const applyPreset = (period: { start: string; end: string }) => {
    setDraftFrom(period.start)
    setDraftTo(period.end)
  }

  const applyFilters = () => {
    const next = new URLSearchParams(searchParams)
    next.set('from', draftFrom)
    next.set('to', draftTo)
    next.set('cmp', draftCmp)
    if (draftCmp === 'custom') {
      next.set('cmpFrom', draftCmpFrom)
      next.set('cmpTo', draftCmpTo)
    } else {
      next.delete('cmpFrom')
      next.delete('cmpTo')
    }
    const allIds = locationsData?.locations.map(loc => loc.location_id) ?? []
    if (draftLocationIds.size > 0 && draftLocationIds.size < allIds.length) {
      next.set('locations', [...draftLocationIds].sort((a, b) => a - b).join(','))
    } else {
      next.delete('locations')
    }
    setSearchParams(next)
  }

  if (!validMerchantId) {
    return <main aria-label="商户表现"><EmptyState>无效的商户 ID。</EmptyState></main>
  }

  return (
    <main className="performance-page" aria-label="商户表现">
      <MerchantSectionNav merchantId={merchantId} active="performance" />
      <header className="performance-page-header">
        <p className="eyebrow">PERFORMANCE / GBP HISTORY</p>
        <h1>商户表现</h1>
      </header>

      {locationsState === 'loading' && <LoadingState variant="detail" label="正在读取门店信息…" />}
      {locationsState === 'error' && <Notice tone="error">{locationsError}</Notice>}

      {locationsState === 'ready' && gateBlockedByFeature && (
        <EmptyState>该商户尚未启用历史数据读取</EmptyState>
      )}

      {locationsState === 'ready' && !gateBlockedByFeature && gateBlockedByTimezone && (
        <div className="performance-timezone-gate">
          {missingTimezoneLocations.map(location => (
            <TimezoneGateItem key={location.location_id} location={location} onSaved={loadLocations} />
          ))}
        </div>
      )}

      {locationsState === 'ready' && !blockedByGate && locationsData && (
        <>
          <section className="performance-filter-bar" aria-label="筛选条件">
            <fieldset>
              <legend>门店</legend>
              {locationsData.locations.map(location => (
                <label key={location.location_id} className="performance-location-checkbox">
                  <input
                    type="checkbox"
                    checked={draftLocationIds.has(location.location_id)}
                    onChange={() => toggleLocation(location.location_id)}
                  />
                  {location.display_name}
                </label>
              ))}
            </fieldset>

            <div className="performance-period-presets" role="group" aria-label="期间预设">
              <button type="button" onClick={() => applyPreset(lastNDays(7, parseISODate(referenceIso)))}>最近 7 天</button>
              <button type="button" onClick={() => applyPreset(lastNDays(28, parseISODate(referenceIso)))}>最近 28 天</button>
              <button type="button" onClick={() => applyPreset(lastNDays(90, parseISODate(referenceIso)))}>最近 90 天</button>
              <button type="button" onClick={() => applyPreset(thisMonth(parseISODate(referenceIso)))}>本月</button>
              <button type="button" onClick={() => applyPreset(lastMonth(parseISODate(referenceIso)))}>上月</button>
            </div>

            <div className="performance-period-inputs">
              <label>
                开始日期
                <input type="date" aria-label="开始日期" value={draftFrom} onChange={event => setDraftFrom(event.target.value)} />
              </label>
              <label>
                结束日期
                <input type="date" aria-label="结束日期" value={draftTo} onChange={event => setDraftTo(event.target.value)} />
              </label>
            </div>

            <label className="performance-comparison-select">
              对比区间
              <select
                aria-label="对比区间"
                value={draftCmp}
                onChange={event => setDraftCmp(event.target.value as ComparisonMode)}
              >
                {COMPARISON_MODES.map(mode => <option key={mode} value={mode}>{COMPARISON_LABELS[mode]}</option>)}
              </select>
            </label>
            {draftCmp === 'custom' && (
              <div className="performance-period-inputs">
                <label>
                  对比开始
                  <input type="date" aria-label="对比开始日期" value={draftCmpFrom} onChange={event => setDraftCmpFrom(event.target.value)} />
                </label>
                <label>
                  对比结束
                  <input type="date" aria-label="对比结束日期" value={draftCmpTo} onChange={event => setDraftCmpTo(event.target.value)} />
                </label>
              </div>
            )}

            <button type="button" className="primary" onClick={applyFilters} disabled={draftLocationIds.size === 0}>应用筛选</button>
          </section>

          <p className="performance-scope-note">选择期间只查询已有数据，不会生成报告、调用 LLM 或购买扫描。</p>

          {perfState === 'loading' && <LoadingState variant="detail" label="正在读取表现数据…" />}
          {perfState === 'error' && perfError && (
            perfError.kind === 'not_enabled'
              ? <EmptyState>该商户尚未启用历史数据读取</EmptyState>
              : perfError.kind === 'timezone_missing'
                ? <Notice tone="warning">至少一个绑定门店尚未设置时区，无法按门店本地日聚合。请到上方设置时区。</Notice>
                : <Notice tone="error">{perfError.message}</Notice>
          )}
          {perfState === 'ready' && performanceData && <PerformanceResults data={performanceData} />}
        </>
      )}
    </main>
  )
}

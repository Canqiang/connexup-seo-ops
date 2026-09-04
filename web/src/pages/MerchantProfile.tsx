import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import {
  ApiError,
  api,
  type LocalFalconReconciliationRequest,
  type LocalFalconScanBatch,
  type LocalFalconSnapshot,
  type Merchant,
  type MerchantGbpLocation,
  type MerchantProfile as MerchantProfileData,
  type SeoTargetState,
} from '../api'
import MerchantSectionNav from '../components/MerchantSectionNav'
import { formatTime } from '../format'
import { isAcceptedLocalFalconBatchReadback, keywordIdentity } from '../localFalcon'

const DAY_LABELS: Record<string, string> = {
  MONDAY: '周一',
  TUESDAY: '周二',
  WEDNESDAY: '周三',
  THURSDAY: '周四',
  FRIDAY: '周五',
  SATURDAY: '周六',
  SUNDAY: '周日',
}

const POST_PREVIEW_COUNT = 5
const MENU_PREVIEW_COUNT = 6

const newFbrRelinkRequestId = (merchantId: number) => (
  `seo-ops-fbr-relink-${merchantId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
)

type LocalFalconConfirmationDraft = {
  requestId: string
  scanConfigSha256: string
  keywordArtifactId: number
  cohortSha256: string
  placeId: string
  locationTitle: string
  locationAddress: string | null
  keywords: Array<{ keyword: string; score: number; scoreRank: number }>
  scanDefaults: {
    centerLat: number
    centerLng: number
    gridSize: number
    radius: number
    measurement: 'mi' | 'km'
  }
}

type LocalFalconConfirmationBinding = Pick<
  LocalFalconConfirmationDraft,
  'requestId' | 'scanConfigSha256' | 'keywordArtifactId' | 'cohortSha256' | 'placeId'
>

type KeywordScoreStatus = SeoTargetState['keyword_versions'][number]['score_status']

const KEYWORD_SCORE_STATUS_LABELS: Record<KeywordScoreStatus, string> = {
  VERIFIED_SKILL: '评分已验证',
  SCORED_UNVERIFIED: '已评分，来源未验证',
  UNSCORED: '未评分',
  PARTIAL: '部分评分',
}

function fbrActivationEligibilityCopy(scoreStatus: KeywordScoreStatus) {
  if (scoreStatus === 'VERIFIED_SKILL') {
    return '该 FBR 版本评分已验证；采用后可继续使用 Local Falcon Top 20。'
  }
  if (scoreStatus === 'SCORED_UNVERIFIED') {
    return '该 FBR 版本已有完整评分；虽非 Skill 验证评分，采用后仍可继续使用 Local Falcon Top 20。'
  }
  if (scoreStatus === 'PARTIAL') {
    return '该 FBR 版本仅有部分评分；采用后会停用 Local Falcon Top 20，直到恢复或重新生成评分已验证的 Skill 版本。'
  }
  return '采用未评分的 FBR 版本会停用 Local Falcon Top 20，直到恢复或重新生成已评分的 Skill 版本。'
}

function isFbrActivationLocalFalconEligible(scoreStatus: KeywordScoreStatus) {
  return scoreStatus === 'VERIFIED_SKILL' || scoreStatus === 'SCORED_UNVERIFIED'
}

function FieldHelp({
  label,
  description,
  align = 'start',
}: {
  label: string
  description: string
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  return (
    <span className={`field-help ${align === 'end' ? 'align-end' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="field-help-trigger"
        aria-label={`说明：${label}`}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >?</button>
      {open && (
        <span className="field-help-popover" role="dialog" aria-label={`${label}说明`}>
          <strong>{label}</strong>
          <span>{description}</span>
        </span>
      )}
    </span>
  )
}

function displayHours(location: MerchantGbpLocation) {
  if (location.regular_hours.length === 0) return <p className="profile-empty-copy">FBR 暂未返回常规营业时间。</p>
  return (
    <ul className="gbp-hours-list">
      {location.regular_hours.map((period, index) => (
        <li key={`${period.open_day}-${period.open_time}-${index}`}>
          <span>{DAY_LABELS[period.open_day] ?? period.open_day} {period.open_time}–{period.close_time}</span>
        </li>
      ))}
    </ul>
  )
}

function countText(value: number | null | undefined, unit: string) {
  return value == null ? '未同步' : `${value} ${unit}`
}

function sourceState(value: number | null | undefined, label: string) {
  return value == null ? `${label}未同步` : `${label} ${value}`
}

function safeHttpUrl(value: string | null | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function postTitle(summary: string | null) {
  const firstLine = summary?.split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) return '无文案摘要'
  return firstLine.length > 68 ? `${firstLine.slice(0, 68)}…` : firstLine
}

function formatMenuPrice(amount: number | null, currencyCode: string | null) {
  if (amount == null || !currencyCode) return '价格未同步'
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currencyCode,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currencyCode}`
  }
}

function ContentAssets({ location }: { location: MerchantGbpLocation }) {
  const posts = location.recent_posts ?? []
  const sections = location.menu_sections ?? []
  const menuItems = location.menu_items ?? []
  const [showAllPosts, setShowAllPosts] = useState(false)
  const [showAllMenuItems, setShowAllMenuItems] = useState(false)
  const [menuCategory, setMenuCategory] = useState('')
  const [unavailableMedia, setUnavailableMedia] = useState<Set<string>>(() => new Set())
  const visiblePosts = showAllPosts ? posts : posts.slice(0, POST_PREVIEW_COUNT)
  const filteredMenuItems = menuCategory
    ? menuItems.filter(item => item.section_name === menuCategory)
    : menuItems
  const previewMenuItems = [...filteredMenuItems].sort(
    (left, right) => Number(Boolean(right.media_url)) - Number(Boolean(left.media_url)),
  )
  const visibleMenuItems = showAllMenuItems
    ? filteredMenuItems
    : previewMenuItems.slice(0, MENU_PREVIEW_COUNT)
  const markMediaUnavailable = (mediaUrl: string) => {
    setUnavailableMedia(current => {
      const next = new Set(current)
      next.add(mediaUrl)
      return next
    })
  }
  return (
    <section className="gbp-data-section" id="gbp-content" aria-labelledby="gbp-content-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">CONTENT ASSETS</p>
          <h3 id="gbp-content-title">内容资产</h3>
        </div>
        <p>{sourceState(location.media_count, '独立媒体库')}</p>
      </div>
      <div className="gbp-content-grid">
        <div className="gbp-content-column">
          <div className="gbp-content-stat">
            <div>
              <span className="field-label-line">
                <strong>{location.post_count == null ? 'Post 未同步' : `本次同步 ${location.post_count} 条`}</strong>
                <FieldHelp label="同步数量" description="本次从 FBR 快照读取到的记录数，不保证等于 Google 上的全部历史数据。" />
              </span>
              <span>{location.live_post_count == null ? '在线状态未同步' : `${location.live_post_count} 条在线`}</span>
            </div>
            <span>{posts.length > 0 ? `显示 ${visiblePosts.length} / ${posts.length}` : '暂无可展示内容'}</span>
          </div>
          {posts.length > 0 ? (
            <>
              <div className="gbp-post-list">
                {visiblePosts.map((post, index) => {
                  const mediaUrl = safeHttpUrl(post.media_url)
                  const mediaUnavailable = mediaUrl ? unavailableMedia.has(mediaUrl) : false
                  const ctaUrl = safeHttpUrl(post.cta_url)
                  return (
                    <details className="gbp-post-item" key={post.post_id ?? index} open={index === 0}>
                      <summary>
                        {mediaUrl && !mediaUnavailable && (
                          <img
                            className="gbp-post-thumbnail"
                            src={mediaUrl}
                            alt="GBP Post 缩略图"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            onError={() => markMediaUnavailable(mediaUrl)}
                          />
                        )}
                        {mediaUrl && mediaUnavailable && <span className="gbp-post-media-unavailable compact">媒体暂不可用</span>}
                        <span className="gbp-post-summary-copy">
                          <strong>{postTitle(post.summary)}</strong>
                          <small>{post.created_at ? formatTime(post.created_at) : '未提供发布时间'}</small>
                        </span>
                        <span className={`data-state ${post.state === 'LIVE' ? 'ready' : ''}`}>{post.state || '状态未知'}</span>
                      </summary>
                      <div className="gbp-post-preview">
                        {mediaUrl && !mediaUnavailable && (
                          <img
                            src={mediaUrl}
                            alt="GBP Post 配图"
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                            onError={() => markMediaUnavailable(mediaUrl)}
                          />
                        )}
                        {mediaUrl && mediaUnavailable && <div className="gbp-post-media-unavailable">媒体暂不可用</div>}
                        <div className="gbp-post-content">
                          <p>{post.summary || '此 Post 没有文案。'}</p>
                          <div className="gbp-post-meta">
                            <span>{post.media_count > 0 ? `${post.media_count} 个媒体文件` : '无媒体'}</span>
                            {ctaUrl && (
                              <a href={ctaUrl} target="_blank" rel="noreferrer">
                                打开 {post.cta_type || 'CTA'} 链接
                              </a>
                            )}
                          </div>
                        </div>
                      </div>
                    </details>
                  )
                })}
              </div>
              {posts.length > POST_PREVIEW_COUNT && (
                <div className="gbp-post-actions">
                  <button type="button" className="quiet" onClick={() => setShowAllPosts(value => !value)}>
                    {showAllPosts ? `收起，仅看最近 ${POST_PREVIEW_COUNT} 条` : `查看全部 ${posts.length} 条 Post`}
                  </button>
                </div>
              )}
            </>
          ) : <p className="profile-empty-copy">{location.post_count == null ? 'Post 尚未同步。' : 'FBR 当前未返回 Post。'}</p>}
        </div>
        <div className="gbp-content-column">
          <div className="gbp-content-stat">
            <div>
              <strong>
                {location.menu_count == null
                  ? '菜单未同步'
                  : `${location.menu_count} 个菜单 · ${location.menu_section_count ?? 0} 个分类 · ${location.menu_item_count ?? 0} 个菜品`}
              </strong>
              <span>{menuItems.length > 0 ? `显示 ${visibleMenuItems.length} / ${filteredMenuItems.length}` : '暂无可展示菜品'}</span>
            </div>
            {sections.length > 0 && (
              <label className="gbp-menu-filter">菜品分类
                <select
                  aria-label="菜品分类"
                  value={menuCategory}
                  onChange={event => {
                    setMenuCategory(event.target.value)
                    setShowAllMenuItems(false)
                  }}
                >
                  <option value="">全部分类</option>
                  {sections.map((section, index) => <option key={`${section.name}-${index}`} value={section.name}>{section.name} ({section.item_count})</option>)}
                </select>
              </label>
            )}
          </div>
          {menuItems.length > 0 ? (
            <>
              <ul className="gbp-menu-catalog" aria-label="菜品目录">
                {visibleMenuItems.map((item, index) => {
                  const mediaUrl = safeHttpUrl(item.media_url)
                  const mediaUnavailable = mediaUrl ? unavailableMedia.has(mediaUrl) : false
                  return (
                    <li key={`${item.section_name}-${item.name}-${index}`}>
                      {mediaUrl && !mediaUnavailable ? (
                        <img
                          src={mediaUrl}
                          alt={item.name}
                          loading="lazy"
                          decoding="async"
                          referrerPolicy="no-referrer"
                          onError={() => markMediaUnavailable(mediaUrl)}
                        />
                      ) : (
                        <span className="gbp-menu-image-empty">{mediaUnavailable ? '图片暂不可用' : '暂无菜品图片'}</span>
                      )}
                      <div className="gbp-menu-item-copy">
                        <span>{item.section_name}</span>
                        <div><strong>{item.name}</strong><b>{formatMenuPrice(item.price_amount, item.currency_code)}</b></div>
                        <p>{item.description || 'FBR 暂未提供菜品描述。'}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
              {filteredMenuItems.length > MENU_PREVIEW_COUNT && (
                <div className="gbp-menu-actions">
                  <button type="button" className="quiet" onClick={() => setShowAllMenuItems(value => !value)}>
                    {showAllMenuItems ? `收起，仅看前 ${MENU_PREVIEW_COUNT} 个菜品` : `查看全部 ${filteredMenuItems.length} 个菜品`}
                  </button>
                </div>
              )}
            </>
          ) : <p className="profile-empty-copy">{location.menu_count == null ? '菜单尚未同步。' : 'FBR 当前未返回菜品详情，请重新同步。'}</p>}
        </div>
      </div>
    </section>
  )
}

function Reviews({ location }: { location: MerchantGbpLocation }) {
  const reviews = location.recent_reviews ?? []
  const hasReviewData = location.review_sync_status === 'ready' || reviews.length > 0
  const count = countText(location.review_count, '条')
  const countLabel = location.review_scope === 'recent_month' ? `近 30 天 ${count}` : count
  const reviewSummary = [
    location.review_average_rating == null ? null : `平均 ${location.review_average_rating.toFixed(1)}`,
    location.review_reply_rate == null ? null : `回复率 ${Math.round(location.review_reply_rate * 100)}%`,
  ].filter(Boolean).join(' · ')
  return (
    <section className="gbp-data-section" id="gbp-reviews" aria-labelledby="gbp-reviews-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">REVIEWS</p>
          <h3 id="gbp-reviews-title">评价</h3>
        </div>
        <strong>{hasReviewData ? countLabel : '评价数据未同步'}</strong>
      </div>
      {reviewSummary && <p className="gbp-data-note">{reviewSummary}</p>}
      {reviews.length > 0 ? (
        <ul className="gbp-simple-list gbp-review-list">
          {reviews.map((review, index) => (
            <li key={review.review_id ?? index}>
              <div>
                <strong>{review.content || '无文字评价'}</strong>
                {(review.reviewer_name || review.created_at) && (
                  <span>{[review.reviewer_name, review.created_at ? formatTime(review.created_at) : null].filter(Boolean).join(' · ')}</span>
                )}
              </div>
              <span>{review.rating == null ? '无评分' : `${review.rating.toFixed(1)} / 5`}{review.has_reply ? ' · 已回复' : ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gbp-data-note">
          {hasReviewData
            ? 'FBR 当前已同步，但没有返回评价。'
            : 'Review Integration 尚未关联这家 GBP 门店；这不代表 Google 商户页面没有评价。'}
        </p>
      )}
    </section>
  )
}

const metricLabels = [
  { label: '地图曝光', metrics: ['BUSINESS_IMPRESSIONS_MOBILE_MAPS', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS'] },
  { label: '搜索曝光', metrics: ['BUSINESS_IMPRESSIONS_MOBILE_SEARCH', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH'] },
  { label: '网站点击', metrics: ['WEBSITE_CLICKS'] },
  { label: '路线请求', metrics: ['BUSINESS_DIRECTION_REQUESTS'] },
  { label: '电话点击', metrics: ['CALL_CLICKS'] },
]

function SourceCoverage({ location }: { location: MerchantGbpLocation }) {
  const performance = location.performance_metrics ?? []
  const keywordTotals = new Map<string, { keyword: string; value: number; months: Set<string> }>()
  for (const row of location.search_keywords ?? []) {
    const keyword = row.keyword.trim()
    if (!keyword) continue
    const key = keywordIdentity(keyword)
    const current = keywordTotals.get(key) ?? { keyword, value: 0, months: new Set<string>() }
    current.value += row.value
    current.months.add(row.month)
    keywordTotals.set(key, current)
  }
  const keywords = [...keywordTotals.values()]
    .sort((left, right) => right.value - left.value)
    .slice(0, 10)
  const values = new Map<string, number>()
  for (const row of performance) {
    values.set(row.metric, (values.get(row.metric) ?? 0) + row.value)
  }

  return (
    <section className="gbp-data-section" id="gbp-performance" aria-labelledby="gbp-performance-title" tabIndex={-1}>
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">GBP INSIGHTS</p>
          <h3 id="gbp-performance-title">GBP 表现与真实搜索词</h3>
        </div>
        <p>表现近 30 天 · 搜索词近 3 个月</p>
      </div>
      {performance.length > 0 ? (
        <dl className="gbp-metric-strip">
          {metricLabels.map(item => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>{item.metrics.reduce((total, metric) => total + (values.get(metric) ?? 0), 0).toLocaleString('en-US')}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="gbp-data-note">FBR 暂未返回 GBP 表现数据。</p>
      )}

      <div className="gbp-keyword-block">
        <div className="gbp-keyword-head">
          <div>
            <div className="field-label-line">
              <h4>真实搜索词</h4>
              <FieldHelp label="真实搜索词" description="用户在 Google 与 Maps 找到门店时实际使用的查询词，不等于运营设定的目标关键词。" />
            </div>
            <p>Google 与 Maps 用户找到这家门店时实际使用的查询词</p>
          </div>
          <span>{keywords.length > 0 ? `Top ${keywords.length}` : '暂无数据'}</span>
        </div>
        {keywords.length > 0 ? (
          <table className="gbp-keyword-table">
            <thead><tr><th>搜索词</th><th>月份</th><th>搜索量</th></tr></thead>
            <tbody>
              {keywords.map((row, index) => (
                <tr key={`${row.keyword}-${index}`}>
                  <td>{row.keyword}</td>
                  <td>{[...row.months].sort().join(' / ')}</td>
                  <td>{row.value.toLocaleString('en-US')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="gbp-data-note">FBR 暂未返回真实搜索词。</p>
        )}
      </div>
    </section>
  )
}

const seoStageLabels: Record<string, string> = {
  KEYWORD_SET: '正在生成目标关键词',
  AUDIT_REPORT: '正在校验关键词与诊断证据',
  RANKING_REPORT: '正在读取排名基线',
}

const strategyLabels: Record<string, string> = {
  LOCAL: '本地搜索',
  ORGANIC: '自然搜索',
  GBP: 'GBP',
  CONTENT: '内容',
  COMMERCIAL: '商业词',
}

const priorityLabels: Record<string, string> = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  UNSCORED: '待运营确认',
}

function localFalconPoints(report: LocalFalconSnapshot) {
  return [...report.grid_points].sort((left, right) => right.lat - left.lat || left.lng - right.lng)
}

function localFalconRankTone(rank: number | null, found = true) {
  if (rank === null || !found) return 'missing'
  if (rank <= 3) return 'strong'
  if (rank <= 5) return 'good'
  if (rank <= 10) return 'medium'
  return 'weak'
}

function localFalconMetricTone(metric: 'rank' | 'solv', value: number) {
  if (metric === 'solv') {
    if (value >= 67) return 'strong'
    if (value >= 34) return 'good'
    if (value > 0) return 'medium'
    return 'weak'
  }
  if (value <= 3) return 'strong'
  if (value <= 5) return 'good'
  if (value <= 10) return 'medium'
  return 'weak'
}

function LocalFalconMiniHeatmap({ report }: { report: LocalFalconSnapshot }) {
  const points = localFalconPoints(report)
  const [activePoint, setActivePoint] = useState(0)
  const pointRefs = useRef<Array<HTMLSpanElement | null>>([])

  const focusPoint = (nextPoint: number) => {
    const boundedPoint = Math.max(0, Math.min(points.length - 1, nextPoint))
    setActivePoint(boundedPoint)
    pointRefs.current[boundedPoint]?.focus()
  }

  const handlePointKeyDown = (event: React.KeyboardEvent<HTMLSpanElement>, index: number) => {
    let nextPoint: number | null = null
    if (event.key === 'ArrowRight') nextPoint = index + 1
    if (event.key === 'ArrowLeft') nextPoint = index - 1
    if (event.key === 'ArrowDown') nextPoint = index + report.grid_size
    if (event.key === 'ArrowUp') nextPoint = index - report.grid_size
    if (event.key === 'Home') nextPoint = 0
    if (event.key === 'End') nextPoint = points.length - 1
    if (nextPoint === null) return
    event.preventDefault()
    focusPoint(nextPoint)
  }

  return (
    <span
      className="local-falcon-mini-heatmap"
      role="grid"
      aria-label={`${report.keyword} Local Falcon 热力图`}
      aria-rowcount={report.grid_size}
      aria-colcount={report.grid_size}
      style={{ gridTemplateColumns: `repeat(${report.grid_size}, 8px)` }}
    >
      {points.map((point, index) => {
        const result = point.rank && point.found ? `第 ${point.rank} 名` : '未发现'
        return (
          <span
            ref={node => { pointRefs.current[index] = node }}
            role="gridcell"
            aria-rowindex={Math.floor(index / report.grid_size) + 1}
            aria-colindex={(index % report.grid_size) + 1}
            aria-label={`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}：${result}`}
            data-tooltip={result}
            tabIndex={activePoint === index ? 0 : -1}
            className={`local-falcon-mini-dot ${localFalconRankTone(point.rank, point.found)}`}
            key={`${point.lat}-${point.lng}-${index}`}
            onFocus={() => setActivePoint(index)}
            onKeyDown={event => handlePointKeyDown(event, index)}
          />
        )
      })}
    </span>
  )
}

function LocalFalconLegend() {
  return (
    <span className="local-falcon-legend" role="group" aria-label="热力图图例">
      <span><i className="strong" />1–3</span>
      <span><i className="good" />4–5</span>
      <span><i className="medium" />6–10</span>
      <span><i className="weak" />11+</span>
      <span><i className="missing" />未发现</span>
    </span>
  )
}

function LocalFalconMetricChip({
  metric,
  value,
}: {
  metric: 'rank' | 'solv'
  value: number
}) {
  return (
    <span className={`local-falcon-metric-chip ${localFalconMetricTone(metric, value)}`}>
      {value.toFixed(2)}
    </span>
  )
}

function LocalFalconBatchNotice({
  batch,
  onOpenReconciliation,
}: {
  batch: LocalFalconScanBatch
  onOpenReconciliation: () => void
}) {
  const needsReconciliation = batch.needs_reconciliation || batch.status === 'unknown' || batch.status === 'partial'
  const canConfirmNotSubmitted = Boolean(batch.can_confirm_not_submitted)
  const title = needsReconciliation
    ? '本批次需人工对账'
    : batch.status === 'submitting'
      ? '本批次正在后台派发'
      : batch.status === 'submitted'
        ? '本批次已受理，等待报告完成'
        : batch.status === 'completed'
          ? '本批次报告已完成'
          : '本批次处理失败'
  const counts = [
    ['排队', batch.pending_count],
    ['派发中', batch.submitting_count],
    ['已受理', batch.submitted_count],
    ['已完成', batch.completed_count],
    ['未知', batch.unknown_count],
    ['失败', batch.failed_count],
  ] as const

  return (
    <section
      className={`seo-target-message local-falcon-batch-notice ${needsReconciliation || batch.status === 'failed' ? 'warning' : 'muted'}`}
      role={needsReconciliation ? 'alert' : 'status'}
      aria-label="Local Falcon 批次状态"
    >
      <span className="local-falcon-batch-title">
        <strong>{title}</strong>
        {(needsReconciliation || canConfirmNotSubmitted) && (
          <button className="quiet compact" type="button" onClick={onOpenReconciliation}>人工对账</button>
        )}
      </span>
      <span className="local-falcon-batch-counts" aria-label={`共 ${batch.total_count} 个关键词`}>
        {counts.map(([label, count]) => <span key={label}>{label} {count}</span>)}
      </span>
      <small>
        {needsReconciliation
          ? '为避免重复扣 credits，不能自动重试或更换 request ID。'
          : batch.status === 'submitting'
            ? '任务已进入后台队列，页面无需保持打开。'
            : batch.status === 'submitted'
              ? 'Local Falcon 已确认受理；报告完成后可同步读取。'
              : batch.status === 'completed'
                ? '报告已完成，可用“只同步已有报告”读取最新结果。'
                : batch.error || '未完成的关键词不会自动重试。'}
      </small>
    </section>
  )
}

function LocalFalconReconciliationDialog({
  batch,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  batch: LocalFalconScanBatch
  busy: boolean
  error: string
  onClose: () => void
  onSubmit: (body: LocalFalconReconciliationRequest) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [reportKey, setReportKey] = useState('')
  const [reason, setReason] = useState('')
  const unknownItems = (batch.items ?? []).filter(item => item.status === 'unknown')
  const normalizedReportKey = reportKey.trim()
  const normalizedReason = reason.trim()
  const reportKeyValid = /^[0-9a-f]{15}$/.test(normalizedReportKey)
  const reasonValid = normalizedReason.length >= 10
  const canBindAcknowledgedReport = batch.can_bind_acknowledged_report === true
  const canBind = canBindAcknowledgedReport && Boolean(keyword) && reportKeyValid && reasonValid && !busy
  const hasAcknowledgedOutstanding = batch.submitting_count > 0 || batch.submitted_count > 0
  const canConfirmNotSubmitted = Boolean(batch.can_confirm_not_submitted)
  const canCloseWithoutRetry = batch.unknown_count === 0
    && batch.status === 'partial'
    && !hasAcknowledgedOutstanding

  return (
    <div className="operation-confirm-backdrop">
      <section
        className="operation-confirm-dialog reconciliation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-falcon-reconciliation-title"
      >
        <header>
          <div>
            <p className="section-code">LOCAL FALCON / RECONCILIATION</p>
            <h4 id="local-falcon-reconciliation-title">Local Falcon 人工对账</h4>
          </div>
          <button type="button" className="dialog-close" aria-label="关闭人工对账" onClick={onClose} disabled={busy}>×</button>
        </header>
        <p className="reconciliation-boundary"><strong>这里只登记已核实的外部事实。</strong>系统不会自动重试、补扫或更换 request ID，避免重复消耗 credits。</p>
        {error && <p className="scan-confirm-error" role="alert">{error}</p>}
        {batch.unknown_count > 0 && (
          <section className="reconciliation-section" aria-labelledby="bind-report-title">
            <div>
              <h5 id="bind-report-title">绑定已受理报告</h5>
              <p>{canBindAcknowledgedReport
                ? '仅当你已在 Local Falcon 后台找到对应报告时使用。'
                : (batch.report_binding_blocker ?? '当前报告缺少可验证的提交关联，暂不能安全绑定。')}</p>
            </div>
            {!canBindAcknowledgedReport ? (
              <p className="reconciliation-inline-warning">请先使用“只同步已有报告”读取系统已确认的 report key；在上游提供可验证的提交时间或关联 ID 前，不允许手工绑定或重新扣费扫描。</p>
            ) : unknownItems.length > 0 ? (
              <div className="reconciliation-fields">
                <label>未知关键词
                  <select aria-label="未知关键词" value={keyword} onChange={event => setKeyword(event.target.value)} disabled={busy}>
                    <option value="">选择待对账关键词</option>
                    {unknownItems.map(item => <option value={item.keyword} key={item.keyword}>{item.keyword}</option>)}
                  </select>
                </label>
                <label>Local Falcon report key
                  <input
                    aria-label="Local Falcon report key"
                    value={reportKey}
                    onChange={event => setReportKey(event.target.value.trim())}
                    maxLength={15}
                    pattern="[0-9a-f]{15}"
                    placeholder="15 位小写十六进制"
                    autoComplete="off"
                    disabled={busy}
                  />
                  {reportKey && !reportKeyValid && <small>请输入 15 位小写十六进制 report key。</small>}
                </label>
              </div>
            ) : <p className="reconciliation-inline-warning">批次尚未返回可绑定的关键词明细，请刷新状态后再试。</p>}
          </section>
        )}
        <section className="reconciliation-section reconciliation-reason" aria-labelledby="reconciliation-reason-title">
          <div>
            <h5 id="reconciliation-reason-title">对账原因</h5>
            <p>该说明会随操作记录保存，便于后续追溯。</p>
          </div>
          <label className="visually-hidden" htmlFor="local-falcon-reconciliation-reason">对账原因</label>
          <textarea
            id="local-falcon-reconciliation-reason"
            aria-label="对账原因"
            value={reason}
            onChange={event => setReason(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="写明你核实了什么，以及依据来自哪里"
            disabled={busy}
          />
          {reason && !reasonValid && <small className="reconciliation-reason-hint">至少填写 10 个字符。</small>}
        </section>
        {batch.unknown_count === 0 && batch.status === 'partial' && hasAcknowledgedOutstanding && (
          <p className="reconciliation-pending-note">仍有已派发或已受理的报告，当前不能关闭。请先使用“只同步已有报告”读回结果。</p>
        )}
        <footer className="reconciliation-actions">
          <button type="button" className="quiet" onClick={onClose} disabled={busy}>取消</button>
          {canConfirmNotSubmitted && (
            <button
              type="button"
              className="reconciliation-danger"
              disabled={!reasonValid || busy}
              onClick={() => onSubmit({ action: 'CONFIRM_NOT_SUBMITTED', reason: normalizedReason })}
            >确认未提交并关闭批次</button>
          )}
          {canCloseWithoutRetry && (
            <button
              type="button"
              className="reconciliation-danger"
              disabled={!reasonValid || busy}
              onClick={() => onSubmit({ action: 'CLOSE_WITHOUT_RETRY', reason: normalizedReason })}
            >关闭剩余未执行项</button>
          )}
          {batch.unknown_count > 0 && canBindAcknowledgedReport && (
            <button
              type="button"
              className="primary"
              disabled={!canBind}
              onClick={() => onSubmit({
                action: 'BIND_ACKNOWLEDGED_REPORT',
                keyword,
                report_key: normalizedReportKey,
                reason: normalizedReason,
              })}
            >{busy ? '正在对账…' : '绑定已受理报告'}</button>
          )}
        </footer>
      </section>
    </div>
  )
}

function KeywordRanking({
  location,
  state,
  busy,
  regenerating,
  localFalconBusy,
  onRefresh,
  onRegenerate,
  onActivateKeywordVersion,
  onSyncLocalFalcon,
  onGenerateLocalFalcon,
  onReconcileLocalFalcon,
}: {
  location: MerchantGbpLocation
  state: SeoTargetState | null
  busy: boolean
  regenerating: boolean
  localFalconBusy: boolean
  onRefresh: () => void
  onRegenerate: () => void
  onActivateKeywordVersion: (artifactId: number, expectedActiveArtifactId: number | null) => Promise<string | null>
  onSyncLocalFalcon: () => void
  onGenerateLocalFalcon: (
    requestId: string,
    expectedScanConfigSha256: string,
    keywordArtifactId: number,
    expectedCohortSha256: string,
  ) => Promise<string | null>
  onReconcileLocalFalcon: (batchId: number, body: LocalFalconReconciliationRequest) => Promise<string | null>
}) {
  const [confirmLocalFalcon, setConfirmLocalFalcon] = useState(false)
  const [generationError, setGenerationError] = useState('')
  const [localFalconConfirmation, setLocalFalconConfirmation] = useState<LocalFalconConfirmationDraft | null>(null)
  const [reconcileLocalFalcon, setReconcileLocalFalcon] = useState(false)
  const [reconciliationError, setReconciliationError] = useState('')
  const [versionsOpen, setVersionsOpen] = useState(false)
  const [selectedVersion, setSelectedVersion] = useState<{
    version: SeoTargetState['keyword_versions'][number]
    expectedActiveArtifactId: number | null
  } | null>(null)
  const [activationBusy, setActivationBusy] = useState(false)
  const [activationError, setActivationError] = useState('')
  const rankRows = new Map(
    (state?.ranking_report?.keywords ?? []).map(row => [keywordIdentity(row.keyword), row]),
  )
  const localFalconReports = state?.local_falcon?.reports ?? []
  const localFalconRows = new Map(
    localFalconReports.map(report => [keywordIdentity(report.keyword), report]),
  )
  const sourceKeywords = state?.keyword_set?.keywords ?? []
  const keywordVersions = state?.keyword_versions ?? []
  const activeVersion = state?.active_keyword_artifact_id == null
    ? keywordVersions.find(version => version.is_active)
    : keywordVersions.find(version => version.artifact_id === state.active_keyword_artifact_id)
  const latestFbrVersion = state?.latest_fbr_import
    ? keywordVersions.find(version => version.artifact_id === state.latest_fbr_import?.artifact_id)
    : null
  const latestFbrIsActive = state?.active_keyword_artifact_id == null
    ? state?.latest_fbr_import?.is_active === true
    : state.active_keyword_artifact_id === state?.latest_fbr_import?.artifact_id
  const keywords = sourceKeywords
    .map((keyword, sourceIndex) => ({ keyword, sourceIndex }))
    .sort((left, right) => {
      const leftScore = left.keyword.score
      const rightScore = right.keyword.score
      const leftHasScore = leftScore !== null && leftScore !== undefined
      const rightHasScore = rightScore !== null && rightScore !== undefined
      if (leftHasScore !== rightHasScore) return leftHasScore ? -1 : 1
      if (leftHasScore && rightHasScore && leftScore !== rightScore) {
        return (rightScore as number) - (leftScore as number)
      }
      return left.sourceIndex - right.sourceIndex
    })
    .map(({ keyword }) => keyword)
  const priorityCounts = keywords.reduce<Record<string, number>>((counts, keyword) => {
    counts[keyword.priority] = (counts[keyword.priority] ?? 0) + 1
    return counts
  }, {})
  const prioritySummary = (['P0', 'P1', 'P2', 'P3', 'UNSCORED'] as const)
    .filter(priority => priorityCounts[priority])
    .map(priority => `${priority === 'UNSCORED' ? '未评分' : priority} ${priorityCounts[priority]}`)
    .join(' · ')
  const localKeywords = keywords.filter(keyword => keyword.strategy === 'LOCAL')
  const localFalconCohort = localKeywords.filter(keyword =>
    keyword.local_falcon_selected && keyword.score !== null && keyword.score !== undefined && keyword.score_rank,
  )
  const canSyncLocalFalcon = state?.capabilities?.can_sync_local_falcon === true
  const canRegenerate = state?.capabilities?.can_regenerate === true
  const canApproveLocalFalcon = state?.capabilities?.can_approve_local_falcon === true
  const canGenerateLocalFalcon = state?.capabilities?.can_generate_local_falcon === true
  const capabilityBlockers = state?.capabilities?.blockers
  const hasMissingLocalScores = localKeywords.some(keyword =>
    keyword.score === null || keyword.score === undefined || !keyword.score_rank,
  )
  const hasUntrustedKeywordCohort = capabilityBlockers?.approve_local_falcon?.includes('no_trusted_scored_cohort') === true
    && !hasMissingLocalScores
  const hasTrustedScoredCohort = localFalconCohort.length > 0
    && capabilityBlockers?.approve_local_falcon?.includes('no_trusted_scored_cohort') !== true
  const keywordSkillUnconfigured = capabilityBlockers?.regenerate?.includes('keyword_skill_unconfigured') === true
  const localFalconIntegrationUnconfigured = capabilityBlockers?.generate_local_falcon?.includes('local_falcon_integration_unconfigured') === true
  const scanDefaultsMissing = capabilityBlockers?.generate_local_falcon?.includes('scan_defaults_missing') === true
  const isRunning = state?.cycle_status === 'running'
  const isGenerationRunning = regenerating || isRunning
  const activeStage = regenerating && !isRunning ? 'KEYWORD_SET' : state?.active_stage
  const isPersistedReadback = state?.keyword_set?.generation_method === 'PERSISTED_FBR_READBACK'
  const refreshButtonLabel = busy || isRunning ? '读取中…' : '从 FBR 重新读取'
  const scanDefaults = state?.local_falcon?.scan_defaults
  const scanDefaultsSha256 = state?.local_falcon?.scan_defaults_sha256
  const keywordArtifactId = state?.keyword_set_artifact_id
  const cohortSha256 = state?.local_falcon_cohort_sha256
  const scanBatch = state?.local_falcon?.scan_batch
  const scanBatchIsUncertain = scanBatch?.status === 'unknown' || scanBatch?.status === 'partial'
  const scanBatchIsActive = scanBatch?.status === 'submitting' || scanBatch?.status === 'submitted'
  const currentPlaceId = state?.local_falcon?.current_place_id
  const locationMismatch = !currentPlaceId || currentPlaceId !== location.place_id
  const canOpenGenerationConfirmation = canApproveLocalFalcon
    && canGenerateLocalFalcon
    && Boolean(scanDefaultsSha256)
    && Boolean(keywordArtifactId)
    && Boolean(cohortSha256)
    && !scanBatchIsUncertain
    && !scanBatchIsActive
    && !locationMismatch

  const openGenerationConfirmation = () => {
    if (!scanDefaultsSha256 || !scanDefaults || !keywordArtifactId || !cohortSha256) return
    setGenerationError('')
    const stored = readLocalFalconConfirmation(state?.merchant_id || 0)
    const frozen = localFalconConfirmation || stored
    const canReuseFrozen = frozen
      && frozen.scanConfigSha256 === scanDefaultsSha256
      && frozen.keywordArtifactId === keywordArtifactId
      && frozen.cohortSha256 === cohortSha256
      && frozen.placeId === scanDefaults.place_id
      && !scanBatch
    const next: LocalFalconConfirmationDraft = {
      requestId: canReuseFrozen ? frozen.requestId : localFalconRequestId(state?.merchant_id || 0),
      scanConfigSha256: scanDefaultsSha256,
      keywordArtifactId,
      cohortSha256,
      placeId: scanDefaults.place_id,
      locationTitle: location.title,
      locationAddress: location.address,
      keywords: localFalconCohort.map(keyword => ({
        keyword: keyword.keyword,
        score: keyword.score as number,
        scoreRank: keyword.score_rank as number,
      })),
      scanDefaults: {
        centerLat: scanDefaults.lat,
        centerLng: scanDefaults.lng,
        gridSize: scanDefaults.grid_size,
        radius: scanDefaults.radius,
        measurement: scanDefaults.measurement,
      },
    }
    setLocalFalconConfirmation(next)
    saveLocalFalconConfirmation(state?.merchant_id || 0, next)
    setConfirmLocalFalcon(true)
  }

  const closeGenerationConfirmation = () => {
    setConfirmLocalFalcon(false)
    setGenerationError('')
  }

  const clearGenerationConfirmation = () => {
    setConfirmLocalFalcon(false)
    setLocalFalconConfirmation(null)
    setGenerationError('')
    clearLocalFalconConfirmation(state?.merchant_id || 0)
  }

  const confirmGeneration = async () => {
    if (!localFalconConfirmation) return
    const failure = await onGenerateLocalFalcon(
      localFalconConfirmation.requestId,
      localFalconConfirmation.scanConfigSha256,
      localFalconConfirmation.keywordArtifactId,
      localFalconConfirmation.cohortSha256,
    )
    if (failure) setGenerationError(failure)
    else clearGenerationConfirmation()
  }

  const submitReconciliation = async (body: LocalFalconReconciliationRequest) => {
    if (!scanBatch) return
    setReconciliationError('')
    const failure = await onReconcileLocalFalcon(scanBatch.id, body)
    if (failure) setReconciliationError(failure)
    else setReconcileLocalFalcon(false)
  }

  const openVersionConfirmation = (version: SeoTargetState['keyword_versions'][number]) => {
    setActivationError('')
    setSelectedVersion({ version, expectedActiveArtifactId: state?.active_keyword_artifact_id ?? null })
  }

  const confirmVersionActivation = async () => {
    if (!selectedVersion) return
    setActivationBusy(true)
    setActivationError('')
    const failure = await onActivateKeywordVersion(selectedVersion.version.artifact_id, selectedVersion.expectedActiveArtifactId)
    setActivationBusy(false)
    if (failure) {
      setActivationError(`关键词版本冲突或采用失败：${failure}`)
      return
    }
    setSelectedVersion(null)
  }

  const activeSourceLabel = activeVersion?.source === 'FBR' ? 'FBR Local' : activeVersion?.source === 'LEGACY' ? '历史' : 'Skill'
  const activeScoreLabel = activeVersion
    ? KEYWORD_SCORE_STATUS_LABELS[activeVersion.score_status]
    : null
  const keywordScoreHeading = state?.active_keyword_source === 'FBR'
    ? 'FBR 评分 / 排名'
    : state?.active_keyword_source === 'LEGACY'
      ? '当前版本评分 / 排名'
      : 'Skill 评分 / 排名'
  const keywordScoreDescription = state?.active_keyword_source === 'FBR'
    ? '评分来自当前采用的 FBR 关键词版本，尚未通过 Skill 来源验证。表格按评分降序展示；P0–P3 是运营优先级，不参与排序。Local Falcon 的 Top 20 仍只从本地关键词中选择。'
    : state?.active_keyword_source === 'LEGACY'
      ? '评分来自当前采用的历史关键词版本，来源验证状态以“SEO Ops 当前版本”提示为准。表格按评分降序展示；P0–P3 是运营优先级，不参与排序。'
      : '评分来自专用 Agent 依次加载 Seed 与 Ranking Skill 后返回的关键词产物。表格按该评分统一降序展示；P0–P3 是运营优先级，不参与排序。Local Falcon 的 Top 20 仍只从本地关键词中选择。'
  const comparison = state?.latest_fbr_import?.comparison

  return (
    <section className="gbp-data-section" id="seo-keywords" aria-labelledby="seo-keywords-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">SEO TARGETS</p>
          <div className="field-label-line">
            <h3 id="seo-keywords-title">SEO 目标关键词与排名</h3>
            <FieldHelp label="目标关键词" description="页面加载读取 SEO Ops 当前采用的本地关键词版本，不会访问 FBR 或触发生成。FBR 只在运营人员明确点击“从 FBR 重新读取”时导入候选版本；只有点击“重新生成关键词并评分”才会运行已配置的 Seed + Ranking Skill 工作流。" />
          </div>
        </div>
        <div className={`seo-target-actions${isGenerationRunning ? ' is-running' : ''}`}>
          {isGenerationRunning
            ? (
                <div
                  className="seo-running-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  aria-label="关键词生成状态"
                >
                  <span className="seo-running-status-line">
                    <span className="seo-running-spinner" aria-hidden="true" />
                    <span className="seo-running-status-copy">
                      <strong>
                        {activeStage === 'KEYWORD_SET'
                          ? '正在生成并评分关键词'
                          : activeStage
                            ? seoStageLabels[activeStage] || '正在处理 SEO 工作流'
                            : '正在启动关键词工作流'}
                      </strong>
                      <span>
                        {activeStage === 'KEYWORD_SET' ? 'Seed → Ranking' : 'SEO 工作流执行中'}
                        {keywords.length > 0 ? ' · 当前结果保留' : ''}
                      </span>
                    </span>
                  </span>
                  <span className="seo-running-progress" aria-hidden="true"><span /></span>
                </div>
              )
            : isPersistedReadback
              ? <span>FBR 已落库 · {keywords.length} 个关键词 · {hasMissingLocalScores ? '评分缺失' : `Top ${localFalconCohort.length}`}</span>
              : keywords.length > 0
                ? hasTrustedScoredCohort
                  ? <span>Seed + Ranking Skill 已调用 · Top {localFalconCohort.length} 待审批</span>
                  : <span>历史关键词结果 · 尚未通过来源校验</span>
                : null}
          <div className="seo-target-primary-actions">
            <button
              className="quiet"
              type="button"
              onClick={onRegenerate}
              disabled={busy || isRunning || !canRegenerate || locationMismatch}
            >重新生成关键词并评分</button>
            <button
              className="primary"
              type="button"
              onClick={openGenerationConfirmation}
              disabled={localFalconBusy || isGenerationRunning || !canOpenGenerationConfirmation}
            >审批并生成 Top 20 报告</button>
          </div>
          <div className="seo-target-secondary-actions" aria-label="关键词辅助操作">
            <button className="text-action" type="button" onClick={() => setVersionsOpen(value => !value)} aria-expanded={versionsOpen} aria-controls="seo-keyword-versions">查看版本</button>
            <span aria-hidden="true">·</span>
            <button className="text-action" type="button" onClick={onRefresh} disabled={busy || isRunning || locationMismatch || scanBatchIsActive || scanBatchIsUncertain}>{refreshButtonLabel}</button>
            <span aria-hidden="true">·</span>
            <button
              className="text-action"
              type="button"
              onClick={onSyncLocalFalcon}
              disabled={localFalconBusy || isGenerationRunning || !canSyncLocalFalcon || locationMismatch}
            >{localFalconBusy ? '同步中…' : '只同步已有报告'}</button>
          </div>
        </div>
      </div>
      {(state?.cycle_status === 'failed' || Boolean(state?.error)) && (
        <p className="seo-target-message error" role="alert">
          {state?.cycle_status === 'failed' ? '关键词同步失败' : '关键词版本激活冲突'}：{state?.error || '未能读取 FBR 关键词库'}
        </p>
      )}
      {activeVersion && (
        <p className="seo-active-version" role="status">
          SEO Ops 当前版本 · {activeSourceLabel} · {activeVersion.keyword_count} 个关键词（Local {activeVersion.local_keyword_count} / Organic {activeVersion.organic_keyword_count}）· {activeScoreLabel}
        </p>
      )}
      {state?.latest_fbr_import && latestFbrVersion && !latestFbrIsActive && (
        <p className="seo-fbr-version-status" role="status">最新 FBR Local 导入 · {latestFbrVersion.keyword_count} 个关键词 · 未采用</p>
      )}
      {versionsOpen && (
        <section className="seo-keyword-versions" id="seo-keyword-versions" aria-labelledby="seo-keyword-versions-title">
          <div className="seo-keyword-versions-head">
            <div>
              <h4 id="seo-keyword-versions-title">关键词版本</h4>
              <p>当前表格只显示 SEO Ops 当前版本；FBR 导入先作为候选版本比较。</p>
            </div>
            <button className="text-action" type="button" onClick={() => setVersionsOpen(false)}>收起版本</button>
          </div>
          {comparison && (
            <section className="seo-fbr-comparison" role="region" aria-label="最新 FBR Local 对比">
              <h5>最新 FBR Local 对比</h5>
              <div className="seo-fbr-comparison-counts">
                <span>当前 Local {comparison.active_local_count}</span>
                <span>FBR Local {comparison.fbr_local_count}</span>
                <span>新增 {comparison.added_count}</span>
                <span>移除 {comparison.removed_count}</span>
                <span>优先级变化 {comparison.priority_changed_count}</span>
                <span>落地页变化 {comparison.target_surfaces_changed_count}</span>
              </div>
              <div className="seo-fbr-comparison-details" aria-label="FBR 对比明细">
                {comparison.added_keywords.length > 0 && <p><strong>新增关键词</strong>{comparison.added_keywords.slice(0, 6).map(keyword => <span key={keyword}>{keyword}</span>)}</p>}
                {comparison.removed_keywords.length > 0 && <p><strong>移除关键词</strong>{comparison.removed_keywords.slice(0, 6).map(keyword => <span key={keyword}>{keyword}</span>)}</p>}
                {comparison.changed_keywords.length > 0 && <p><strong>变化关键词</strong>{comparison.changed_keywords.slice(0, 6).map(change => <span key={change.keyword}>{change.keyword}</span>)}</p>}
              </div>
            </section>
          )}
          <ul className="seo-version-list" aria-label="关键词版本列表">
            {keywordVersions.map(version => {
              const isFbr = version.source === 'FBR'
              const isCurrentActive = state?.active_keyword_artifact_id == null
                ? version.is_active
                : version.artifact_id === state.active_keyword_artifact_id
              const sourceLabel = isFbr ? 'FBR Local' : version.source === 'SKILL' ? 'Skill' : '历史'
              const actionLabel = isFbr ? '采用这个 FBR 版本' : '恢复这个 Skill 版本'
              const canActivate = version.activation_eligible
              return (
                <li key={version.artifact_id} className={isCurrentActive ? 'is-active' : ''}>
                  <div>
                    <strong>{sourceLabel} · #{version.artifact_id}{isCurrentActive ? ' · 当前版本' : ''}</strong>
                    <span>{version.keyword_count} 个关键词（Local {version.local_keyword_count} / Organic {version.organic_keyword_count}） · {KEYWORD_SCORE_STATUS_LABELS[version.score_status]}</span>
                  </div>
                  {!isCurrentActive && canActivate && <button type="button" className={isFbr ? 'primary compact' : 'quiet compact'} disabled={activationBusy} onClick={() => openVersionConfirmation(version)}>{actionLabel}</button>}
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {locationMismatch && (
        <p className="seo-target-message warning" role="alert">当前 SEO 工作区未绑定到所选 GBP 门店。为避免对错误的 Place ID 发起付费扫描，关键词与 Local Falcon 操作已暂停。</p>
      )}
      {hasMissingLocalScores && (
        <p className="seo-target-message warning" role="status">{isPersistedReadback ? 'FBR 未返回' : '当前关键词结果缺少'}关键词评分，无法确定 Local Falcon Top 20。已停止同步，避免把全部关键词误当作 Top 20。</p>
      )}
      {hasUntrustedKeywordCohort && (
        <p className="seo-target-message warning" role="status">当前关键词产物尚未通过来源与 Top 20 评分校验，不能进入 Local Falcon 付费队列。</p>
      )}
      {keywordSkillUnconfigured && (
        <p className="seo-target-message muted" role="status">关键词生成 Skill 尚未配置，当前只能读取 FBR 已落库数据。</p>
      )}
      {scanDefaultsMissing && !scanBatchIsUncertain && !scanBatchIsActive && (
        <p className="seo-target-message muted" role="status">缺少可复用的 Local Falcon 扫描参数，暂不能生成新报告。</p>
      )}
      {localFalconIntegrationUnconfigured && (
        <p className="seo-target-message muted" role="status">Local Falcon 接口尚未配置，当前只能查看已落库数据。</p>
      )}
      {canGenerateLocalFalcon && !scanDefaultsSha256 && (
        <p className="seo-target-message muted" role="status">Local Falcon 扫描参数尚未校验，暂不能提交付费扫描。</p>
      )}
      {scanBatch && (
        <LocalFalconBatchNotice
          batch={scanBatch}
          onOpenReconciliation={() => {
            setReconciliationError('')
            setReconcileLocalFalcon(true)
          }}
        />
      )}
      {keywords.length > 0 ? (
        <div className="seo-target-table-wrap">
          <div
            className="seo-target-table-viewport"
            role="region"
            aria-label="关键词与 Local Falcon 排名"
            aria-busy={isGenerationRunning}
            tabIndex={0}
          >
            <table className="seo-target-table">
              <thead>
                <tr>
                  <th>关键词 / 优先级</th>
                  <th><span className="field-label-line align-right">{keywordScoreHeading}<FieldHelp label="关键词评分" description={keywordScoreDescription} align="end" /></span></th>
                  <th><span className="local-falcon-heatmap-head"><span>热力图</span><LocalFalconLegend /></span></th>
                  <th><span className="field-label-line align-right">ARP<FieldHelp label="ARP" description="Local Falcon 网格中各采样点排名的平均值；数值越低越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">ATRP<FieldHelp label="ATRP" description="商户被发现的采样点中，各点排名的平均值；数值越低越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">SoLV<FieldHelp label="SoLV" description="Share of Local Voice，本地排名可见度占比；数值越高越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">DataForSEO Local Pack 排名<FieldHelp label="本地排名" description="DataForSEO 在单一搜索位置读取的 Local Pack 名次；它不是 Skill 评分，也不是 Local Falcon 网格平均排名。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">DataForSEO 自然排名<FieldHelp label="自然排名" description="DataForSEO 读取的商户网站普通自然搜索结果位置；没有测得时显示“—”，不代表第 0 名。" align="end" /></span></th>
                </tr>
              </thead>
              <tbody>
                {keywords.map(keyword => {
                const normalizedKeyword = keywordIdentity(keyword.keyword)
                const ranking = rankRows.get(normalizedKeyword)
                const localFalcon = localFalconRows.get(normalizedKeyword)
                const source = localFalcon
                  ? '排名来源：Local Falcon'
                  : ranking?.source === 'LIVE_READ_ONLY'
                    ? ranking.note?.includes('DataForSEO') ? '排名来源：DataForSEO' : '排名来源：实时读取'
                    : '排名未测得'
                return (
                  <tr className={localFalcon ? 'has-local-falcon-report' : ''} key={keyword.keyword}>
                    <td>
                      <div className="seo-keyword-summary">
                        <strong>{keyword.keyword}</strong>
                        <span className="seo-keyword-meta">
                          {localFalcon ? (
                            <>
                              <span>{formatTime(localFalcon.captured_at)}</span>
                              <span>{localFalcon.grid_size} × {localFalcon.grid_size} grid</span>
                              <span>{localFalcon.radius} {localFalcon.measurement} radius</span>
                              <span>{localFalcon.grid_points.length} points</span>
                            </>
                          ) : (
                            <>
                              <span>{strategyLabels[keyword.strategy] || keyword.strategy}</span>
                              <span>{source}</span>
                            </>
                          )}
                        </span>
                        <span className="seo-keyword-flags">
                          <span className={`seo-priority ${keyword.priority.toLocaleLowerCase()}`}>{priorityLabels[keyword.priority]}</span>
                          {keyword.local_falcon_selected ? <span className="local-falcon-selection">Local Falcon Top 20</span> : null}
                        </span>
                      </div>
                    </td>
                    <td>
                      <span className="seo-skill-score">
                        {keyword.score !== null && keyword.score !== undefined
                          ? <span>评分 {Number.isInteger(keyword.score) ? keyword.score : keyword.score.toFixed(1)}</span>
                          : <span>评分未返回</span>}
                        {keyword.score_rank ? <span>评分排名 #{keyword.score_rank}</span> : <span>排名 —</span>}
                      </span>
                    </td>
                    <td>{localFalcon ? <LocalFalconMiniHeatmap report={localFalcon} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="rank" value={localFalcon.arp} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="rank" value={localFalcon.atrp} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="solv" value={localFalcon.solv} /> : '—'}</td>
                    <td>{ranking?.local_rank ? `#${ranking.local_rank}` : '—'}</td>
                    <td>{ranking?.organic_rank ? `#${ranking.organic_rank}` : '—'}</td>
                  </tr>
                )
                })}
              </tbody>
            </table>
          </div>
          <div className="seo-target-footer">
            <span>共 {keywords.length} 个关键词{prioritySummary ? ` · ${prioritySummary}` : ''} · 在此窗口内滚动查看</span>
            <p className="seo-target-footnote">
              {state?.local_falcon?.status === 'failed'
                ? `Local Falcon 同步失败：${state.local_falcon.last_error || '未知错误'}。已保留最后一次成功快照。`
                : state?.local_falcon?.last_synced_at
                  ? `Local Falcon 已同步于 ${formatTime(state.local_falcon.last_synced_at)}；缺少 ${state.local_falcon.missing_keywords.length} 个已有报告。`
                  : state?.ranking_report?.source_mode === 'LIVE_READ_ONLY'
                ? `排名读取于 ${formatTime(state.ranking_report.captured_at)}；“—”表示当前数据源未测得，不代表第 0 名。`
                : state?.ranking_report
                  ? '本轮没有可验证的实时排名源；“—”表示未测得，不代表第 0 名。'
                : isRunning ? '正在同步关键词库，当前结果会继续保留。' : '关键词已从库中读取，尚无可验证排名。'}
            </p>
          </div>
        </div>
      ) : (
        <div className="seo-target-empty">
          <strong>{isRunning && state?.active_stage ? seoStageLabels[state.active_stage] : '关键词库暂无数据'}</strong>
          <p>先读取 FBR 已落库关键词；生成新关键词需要单独配置并运行正式的 seed + ranking Skill 工作流。</p>
        </div>
      )}
      {confirmLocalFalcon && (
        <div className="operation-confirm-backdrop">
          <section
            className="operation-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="local-falcon-confirm-title"
          >
            <header>
              <div>
                <p className="section-code">LOCAL FALCON / PAID SCAN</p>
                <h4 id="local-falcon-confirm-title">确认生成 Local Falcon 报告</h4>
              </div>
              <button type="button" className="dialog-close" aria-label="关闭生成确认" onClick={closeGenerationConfirmation} disabled={localFalconBusy}>×</button>
            </header>
            <p className="credit-warning"><strong>此操作将消耗 Local Falcon credits</strong>。系统只提交当前已评分并待审批的 Top {localFalconConfirmation?.keywords.length || 0}，不会自动扩大关键词范围。</p>
            {generationError && <p className="scan-confirm-error" role="alert">{generationError}</p>}
            <div className="scan-confirm-location" aria-label="扫描门店">
              <strong>{localFalconConfirmation?.locationTitle}</strong>
              <span>{localFalconConfirmation?.locationAddress || '未返回门店地址'}</span>
            </div>
            <dl className="scan-confirm-params" aria-label="扫描参数">
              <div><dt>Place ID</dt><dd>{localFalconConfirmation?.placeId}</dd></div>
              <div><dt>扫描中心</dt><dd>{localFalconConfirmation ? `${localFalconConfirmation.scanDefaults.centerLat.toFixed(6)}, ${localFalconConfirmation.scanDefaults.centerLng.toFixed(6)}` : '—'}</dd></div>
              <div><dt>关键词</dt><dd>{localFalconConfirmation?.keywords.length || 0} 个</dd></div>
              <div><dt>点阵</dt><dd>{localFalconConfirmation?.scanDefaults.gridSize} × {localFalconConfirmation?.scanDefaults.gridSize}</dd></div>
              <div><dt>半径</dt><dd>{localFalconConfirmation?.scanDefaults.radius} {localFalconConfirmation?.scanDefaults.measurement}</dd></div>
              <div><dt>测量单位</dt><dd>{localFalconConfirmation?.scanDefaults.measurement}</dd></div>
              <div><dt>平台</dt><dd>Google</dd></div>
            </dl>
            <div className="scan-confirm-keywords" aria-label="待生成关键词">
              <ol>
                {localFalconConfirmation?.keywords.map(keyword => (
                  <li key={keyword.keyword}>
                    <span>#{keyword.scoreRank}</span>
                    <strong>{keyword.keyword}</strong>
                    <small>评分 {keyword.score}</small>
                  </li>
                ))}
              </ol>
            </div>
            <footer>
              <button type="button" className="quiet" onClick={closeGenerationConfirmation} disabled={localFalconBusy}>取消</button>
              <button type="button" className="primary" onClick={() => void confirmGeneration()} disabled={localFalconBusy}>
                {localFalconBusy ? '正在提交…' : `确认并生成 ${localFalconConfirmation?.keywords.length || 0} 个报告`}
              </button>
            </footer>
          </section>
        </div>
      )}
      {selectedVersion && (
        <div className="operation-confirm-backdrop">
          <section className="operation-confirm-dialog keyword-version-confirm" role="dialog" aria-modal="true" aria-labelledby="keyword-version-confirm-title">
            <header>
              <div>
                <p className="section-code">KEYWORD VERSION</p>
                <h4 id="keyword-version-confirm-title">确认{selectedVersion.version.source === 'FBR' ? '采用 FBR 关键词版本' : '恢复 Skill 关键词版本'}</h4>
              </div>
              <button type="button" className="dialog-close" aria-label="关闭版本确认" onClick={() => setSelectedVersion(null)} disabled={activationBusy}>×</button>
            </header>
            <div className="keyword-version-confirm-copy">
              <p>将采用 #{selectedVersion.version.artifact_id}，并以确认时的当前活动版本 #{selectedVersion.expectedActiveArtifactId ?? '无'} 作为冲突校验。</p>
              {selectedVersion.version.source === 'FBR' && (
                <p className={isFbrActivationLocalFalconEligible(selectedVersion.version.score_status) ? 'muted' : 'credit-warning'}>{fbrActivationEligibilityCopy(selectedVersion.version.score_status)}</p>
              )}
              {activationError && <p className="scan-confirm-error" role="alert">{activationError}</p>}
            </div>
            <footer>
              <button type="button" className="quiet" onClick={() => setSelectedVersion(null)} disabled={activationBusy}>取消</button>
              <button type="button" className="primary" onClick={() => void confirmVersionActivation()} disabled={activationBusy}>{activationBusy ? '正在采用…' : selectedVersion.version.source === 'FBR' ? '确认采用 FBR 版本' : '确认恢复 Skill 版本'}</button>
            </footer>
          </section>
        </div>
      )}
      {reconcileLocalFalcon && scanBatch && (
        <LocalFalconReconciliationDialog
          batch={scanBatch}
          busy={localFalconBusy}
          error={reconciliationError}
          onClose={() => {
            setReconciliationError('')
            setReconcileLocalFalcon(false)
          }}
          onSubmit={body => void submitReconciliation(body)}
        />
      )}
    </section>
  )
}

function GbpLocationRecord({
  location,
  seoTargets,
  seoBusy,
  seoRegenerating,
  localFalconBusy,
  onRefreshSeo,
  onRegenerateSeo,
  onActivateKeywordVersion,
  onSyncLocalFalcon,
  onGenerateLocalFalcon,
  onReconcileLocalFalcon,
}: {
  location: MerchantGbpLocation
  seoTargets: SeoTargetState | null
  seoBusy: boolean
  seoRegenerating: boolean
  localFalconBusy: boolean
  onRefreshSeo: () => void
  onRegenerateSeo: () => void
  onActivateKeywordVersion: (artifactId: number, expectedActiveArtifactId: number | null) => Promise<string | null>
  onSyncLocalFalcon: () => void
  onGenerateLocalFalcon: (
    requestId: string,
    expectedScanConfigSha256: string,
    keywordArtifactId: number,
    expectedCohortSha256: string,
  ) => Promise<string | null>
  onReconcileLocalFalcon: (batchId: number, body: LocalFalconReconciliationRequest) => Promise<string | null>
}) {
  const categories = [location.primary_category, ...location.additional_categories].filter(Boolean) as string[]

  return (
    <article className="gbp-record" aria-label={`GBP 门店：${location.title}`}>
      <nav className="gbp-data-nav" aria-label="GBP 资料分区">
        <a href="#gbp-basic">基础资料</a>
        <a href="#gbp-content">内容资产</a>
        <a href="#gbp-reviews">评价</a>
        <a href="#gbp-performance">GBP 表现</a>
        <a href="#seo-keywords">SEO 关键词</a>
      </nav>
      <header className="gbp-record-head" id="gbp-basic">
        <div>
          <p className="section-code">GOOGLE BUSINESS PROFILE</p>
          <h2>{location.title}</h2>
          <p>{location.address || '地址尚未同步'}</p>
        </div>
        {location.open_status && (
          <span className={`badge ${location.open_status === 'OPEN' ? 'active' : ''}`}>
            {location.open_status === 'OPEN' ? '营业中' : location.open_status}
          </span>
        )}
      </header>

      <dl className="gbp-facts">
        <div><dt>电话</dt><dd>{location.phone || '—'}</dd></div>
        <div>
          <dt>官网</dt>
          <dd>{location.website_url ? <a href={location.website_url} target="_blank" rel="noreferrer">{location.website_url}</a> : '—'}</dd>
        </div>
        <div>
          <dt><span className="field-label-line">门店代码<FieldHelp label="门店代码" description="GBP 的 storeCode，用于商户内部匹配；不是 GBP Location ID。" align="end" /></span></dt>
          <dd>{location.store_code || '—'}</dd>
        </div>
      </dl>

      <div className="gbp-profile-body">
        <section aria-labelledby="gbp-description-title">
          <h3 id="gbp-description-title">商户介绍</h3>
          <p>{location.description || 'FBR 暂未返回商户介绍。'}</p>
          <h3>类别</h3>
          {categories.length > 0
            ? <div className="profile-tags">{categories.map(category => <span key={category}>{category}</span>)}</div>
            : <p className="profile-empty-copy">暂无类别</p>}
        </section>
        <section aria-labelledby="gbp-hours-title">
          <h3 id="gbp-hours-title">营业时间</h3>
          {displayHours(location)}
        </section>
      </div>

      <ContentAssets location={location} />
      <Reviews location={location} />
      <SourceCoverage location={location} />
      <KeywordRanking
        location={location}
        state={seoTargets}
        busy={seoBusy}
        regenerating={seoRegenerating}
        localFalconBusy={localFalconBusy}
        onRefresh={onRefreshSeo}
        onRegenerate={onRegenerateSeo}
        onActivateKeywordVersion={onActivateKeywordVersion}
        onSyncLocalFalcon={onSyncLocalFalcon}
        onGenerateLocalFalcon={onGenerateLocalFalcon}
        onReconcileLocalFalcon={onReconcileLocalFalcon}
      />

      <footer className="gbp-source-foot">
        <span>{location.source_updated_at ? `FBR 数据更新于 ${formatTime(location.source_updated_at)}` : 'FBR 未提供来源更新时间'}</span>
        <span>同步于 {formatTime(location.synced_at)}</span>
      </footer>
    </article>
  )
}

function preferredLocationId(merchant: Merchant, locations: MerchantGbpLocation[]) {
  const normalizedName = merchant.name.trim().toLocaleLowerCase()
  const titleMatch = locations.find(location => location.title.trim().toLocaleLowerCase() === normalizedName)
  if (titleMatch) return titleMatch.gbp_location_id

  const normalizedPrimaryLocation = merchant.primary_location?.trim().toLocaleLowerCase()
  const addressMatch = normalizedPrimaryLocation
    ? locations.find(location => {
        const address = location.address?.trim().toLocaleLowerCase()
        return address && (address.includes(normalizedPrimaryLocation) || normalizedPrimaryLocation.includes(address))
      })
    : undefined
  return addressMatch?.gbp_location_id || locations[0]?.gbp_location_id || ''
}

function localFalconRequestId(merchantId: number) {
  const randomPart = globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
  return `seo-ops-${merchantId}-${Date.now()}-${randomPart}`
}

function localFalconConfirmationKey(merchantId: number) {
  return `seo-ops.local-falcon-confirmation.${merchantId}`
}

function readLocalFalconConfirmation(merchantId: number): LocalFalconConfirmationBinding | null {
  if (!merchantId) return null
  try {
    const raw = window.sessionStorage.getItem(localFalconConfirmationKey(merchantId))
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<LocalFalconConfirmationBinding>
    if (
      typeof value.requestId !== 'string'
      || typeof value.scanConfigSha256 !== 'string'
      || typeof value.keywordArtifactId !== 'number'
      || typeof value.cohortSha256 !== 'string'
      || typeof value.placeId !== 'string'
    ) return null
    return value as LocalFalconConfirmationBinding
  } catch {
    return null
  }
}

function saveLocalFalconConfirmation(merchantId: number, draft: LocalFalconConfirmationDraft) {
  if (!merchantId) return
  try {
    const binding: LocalFalconConfirmationBinding = {
      requestId: draft.requestId,
      scanConfigSha256: draft.scanConfigSha256,
      keywordArtifactId: draft.keywordArtifactId,
      cohortSha256: draft.cohortSha256,
      placeId: draft.placeId,
    }
    window.sessionStorage.setItem(localFalconConfirmationKey(merchantId), JSON.stringify(binding))
  } catch {
    // sessionStorage 不可用时仍允许当前页面使用内存中的冻结确认单。
  }
}

function clearLocalFalconConfirmation(merchantId: number) {
  if (!merchantId) return
  try {
    window.sessionStorage.removeItem(localFalconConfirmationKey(merchantId))
  } catch {
    // 清理失败不应阻断已确认的后端状态读回。
  }
}

export default function MerchantProfile() {
  const { id } = useParams()
  const location = useLocation()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [profile, setProfile] = useState<MerchantProfileData | null>(null)
  const [seoTargets, setSeoTargets] = useState<SeoTargetState | null>(null)
  const [fbrMerchantId, setFbrMerchantId] = useState('')
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showFbrRelink, setShowFbrRelink] = useState(false)
  const [newFbrMerchantId, setNewFbrMerchantId] = useState('')
  const [fbrRelinkReason, setFbrRelinkReason] = useState('')
  const [fbrRelinkConfirmed, setFbrRelinkConfirmed] = useState(false)
  const [fbrRelinking, setFbrRelinking] = useState(false)
  const [seoBusy, setSeoBusy] = useState(false)
  const [seoRegenerating, setSeoRegenerating] = useState(false)
  const [localFalconBusy, setLocalFalconBusy] = useState(false)
  const performanceHashFocusedRef = useRef<string | null>(null)
  const profileMutationVersionRef = useRef(0)
  const profileMutationBusyRef = useRef(false)
  const fbrRelinkRequestRef = useRef<{ key: string; requestId: string } | null>(null)

  useEffect(() => {
    let active = true
    void Promise.all([
      api.getMerchant(merchantId),
      api.getMerchantProfile(merchantId),
      api.getSeoTargets(merchantId),
    ]).then(([merchantData, profileData, seoData]) => {
      if (!active) return
      setMerchant(merchantData)
      setProfile(profileData)
      setSeoTargets(seoData)
      setFbrMerchantId(profileData.fbr_merchant_id || '')
      setSelectedLocationId(preferredLocationId(merchantData, profileData.locations))
      setError('')
    }).catch(err => {
      if (active) setError((err as Error).message)
    })
    return () => { active = false }
  }, [merchantId])

  useEffect(() => {
    let active = true
    let inFlight = false
    const readLatestProfile = () => {
      if (inFlight || profileMutationBusyRef.current) return
      inFlight = true
      const mutationVersion = profileMutationVersionRef.current
      void api.getMerchantProfile(merchantId).then(next => {
        if (
          !active
          || profileMutationBusyRef.current
          || mutationVersion !== profileMutationVersionRef.current
        ) return
        setProfile(next)
        setSelectedLocationId(current => (
          next.locations.some(item => item.gbp_location_id === current)
            ? current
            : next.locations[0]?.gbp_location_id || ''
        ))
      }).catch(() => {
        // Keep the last successful snapshot visible on a transient read failure.
      }).finally(() => {
        inFlight = false
      })
    }
    const timer = window.setInterval(readLatestProfile, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [merchantId])

  useEffect(() => {
    const shouldPollSeo = seoTargets?.cycle_status === 'running'
      || seoTargets?.local_falcon?.scan_batch?.status === 'submitting'
    if (!shouldPollSeo) return
    let active = true
    let inFlight = false
    const readLatestSeoState = () => {
      if (inFlight) return
      inFlight = true
      void api.getSeoTargets(merchantId).then(next => {
        if (active) setSeoTargets(next)
      }).catch(err => {
        if (active) setError((err as Error).message)
      }).finally(() => {
        inFlight = false
      })
    }
    readLatestSeoState()
    const timer = window.setInterval(readLatestSeoState, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [merchantId, seoTargets?.cycle_status, seoTargets?.local_falcon?.scan_batch?.status])

  const selectedLocation = useMemo(
    () => profile?.locations.find(location => location.gbp_location_id === selectedLocationId) || profile?.locations[0],
    [profile, selectedLocationId],
  )

  useEffect(() => {
    if (location.hash !== '#gbp-performance') performanceHashFocusedRef.current = null
  }, [location.hash, merchantId])

  useEffect(() => {
    const focusKey = `${merchantId}:${location.hash}`
    if (location.hash !== '#gbp-performance' || !profile || !selectedLocation || performanceHashFocusedRef.current === focusKey) return
    const section = document.getElementById('gbp-performance')
    if (!section) return
    performanceHashFocusedRef.current = focusKey
    section.focus({ preventScroll: true })
    section.scrollIntoView({ block: 'start' })
  }, [location.hash, merchantId, profile, selectedLocation])

  const bind = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!fbrMerchantId.trim()) return
    const mutationVersion = ++profileMutationVersionRef.current
    profileMutationBusyRef.current = true
    setBusy(true)
    try {
      const next = await api.bindMerchantFbr(merchantId, fbrMerchantId.trim())
      if (mutationVersion !== profileMutationVersionRef.current) return
      setProfile(next)
      setSelectedLocationId('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      profileMutationBusyRef.current = false
      setBusy(false)
    }
  }

  const sync = async () => {
    const mutationVersion = ++profileMutationVersionRef.current
    profileMutationBusyRef.current = true
    setBusy(true)
    try {
      const next = await api.syncMerchantGbp(merchantId)
      if (mutationVersion !== profileMutationVersionRef.current) return
      setProfile(next)
      setSelectedLocationId(merchant ? preferredLocationId(merchant, next.locations) : next.locations[0]?.gbp_location_id || '')
      setError('')
    } catch (err) {
      setError((err as Error).message)
      try {
        const latest = await api.getMerchantProfile(merchantId)
        if (mutationVersion === profileMutationVersionRef.current) setProfile(latest)
      } catch {
        // 保留当前已读到的快照，让失败不会遮住最后一次成功数据。
      }
    } finally {
      profileMutationBusyRef.current = false
      setBusy(false)
    }
  }

  const cancelFbrRelink = () => {
    if (fbrRelinking) return
    setShowFbrRelink(false)
    setNewFbrMerchantId('')
    setFbrRelinkReason('')
    setFbrRelinkConfirmed(false)
    fbrRelinkRequestRef.current = null
  }

  const relinkFbr = async (event: React.FormEvent) => {
    event.preventDefault()
    const nextFbrMerchantId = newFbrMerchantId.trim()
    const reason = fbrRelinkReason.trim()
    if (
      fbrRelinking
      || !fbrRelinkConfirmed
      || !nextFbrMerchantId
      || !reason
      || nextFbrMerchantId === profile?.fbr_merchant_id
      || profile?.binding_generation == null
      || !profile.binding_sha256
    ) return

    const requestKey = JSON.stringify({
      merchantId,
      generation: profile.binding_generation,
      sha256: profile.binding_sha256,
      nextFbrMerchantId,
      reason,
    })
    if (fbrRelinkRequestRef.current?.key !== requestKey) {
      fbrRelinkRequestRef.current = {
        key: requestKey,
        requestId: newFbrRelinkRequestId(merchantId),
      }
    }

    const mutationVersion = ++profileMutationVersionRef.current
    profileMutationBusyRef.current = true
    setFbrRelinking(true)
    let relinkAccepted = false
    try {
      const result = await api.relinkMerchantFbr({
        request_id: fbrRelinkRequestRef.current.requestId,
        merchant_id: merchantId,
        expected_current_binding_generation: profile.binding_generation,
        expected_current_fbr_sha256: profile.binding_sha256,
        new_fbr_merchant_id: nextFbrMerchantId,
        reason,
        confirmed: true,
      })
      relinkAccepted = true
      const latest = await api.getMerchantProfile(merchantId)
      if (mutationVersion !== profileMutationVersionRef.current) return
      if (
        latest.fbr_merchant_id !== result.binding.fbr_merchant_id
        || latest.binding_generation !== result.binding.generation
        || latest.binding_sha256 !== result.binding.canonical_fbr_merchant_sha256
      ) {
        throw new Error('FBR 重新绑定后的资料读回不一致，请停止操作并联系管理员')
      }
      setProfile(latest)
      setFbrMerchantId(latest.fbr_merchant_id || '')
      setSelectedLocationId('')
      setError('')
      cancelFbrRelink()
    } catch (err) {
      if (!relinkAccepted && err instanceof ApiError && err.status >= 400 && err.status < 500) {
        fbrRelinkRequestRef.current = null
      }
      setError((err as Error).message)
    } finally {
      profileMutationBusyRef.current = false
      setFbrRelinking(false)
    }
  }

  const refreshSeo = useCallback(async () => {
    setSeoBusy(true)
    try {
      setSeoTargets(await api.refreshSeoTargets(merchantId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSeoBusy(false)
    }
  }, [merchantId])

  const syncLocalFalcon = useCallback(async () => {
    setLocalFalconBusy(true)
    try {
      setSeoTargets(await api.syncLocalFalconReports(merchantId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
      try {
        setSeoTargets(await api.getSeoTargets(merchantId))
      } catch {
        // 保留最后一次成功快照；失败状态会在下一次读取时显示。
      }
    } finally {
      setLocalFalconBusy(false)
    }
  }, [merchantId])

  const generateLocalFalcon = useCallback(async (
    requestId: string,
    expectedScanConfigSha256: string,
    keywordArtifactId: number,
    expectedCohortSha256: string,
  ) => {
    setLocalFalconBusy(true)
    let approvalId: number | null = null
    try {
      const approvedState = await api.approveLocalFalconCohort(merchantId, {
        keyword_artifact_id: keywordArtifactId,
        expected_cohort_sha256: expectedCohortSha256,
      })
      setSeoTargets(approvedState)
      approvalId = approvedState.local_falcon?.approval?.id ?? null
      if (!approvalId) throw new Error('关键词审批未返回有效记录，尚未提交付费扫描。')
      const next = await api.createLocalFalconScanBatch(merchantId, {
        approval_id: approvalId,
        request_id: requestId,
        expected_scan_config_sha256: expectedScanConfigSha256,
        confirm_credit_spend: true,
      })
      if (!isAcceptedLocalFalconBatchReadback(next, {
        requestId,
        approvalId,
        expectedScanConfigSha256,
        keywordArtifactId,
        expectedCohortSha256,
      })) {
        throw new Error('付费批次读回与本次确认不一致，确认单已保留，请先核对批次状态。')
      }
      setSeoTargets(next)
      setError('')
      return null
    } catch (err) {
      const requestError = (err as Error).message
      try {
        const readback = await api.getSeoTargets(merchantId)
        setSeoTargets(readback)
        if (approvalId && isAcceptedLocalFalconBatchReadback(readback, {
          requestId,
          approvalId,
          expectedScanConfigSha256,
          keywordArtifactId,
          expectedCohortSha256,
        })) {
          setError('')
          return null
        }
      } catch {
        // 读回失败时保留冻结 request_id，允许操作者稍后安全重试同一确认单。
      }
      return requestError
    } finally {
      setLocalFalconBusy(false)
    }
  }, [merchantId])

  const reconcileLocalFalcon = useCallback(async (
    batchId: number,
    body: LocalFalconReconciliationRequest,
  ) => {
    setLocalFalconBusy(true)
    try {
      const next = await api.reconcileLocalFalconScanBatch(merchantId, batchId, body)
      setSeoTargets(next)
      setError('')
      return null
    } catch (err) {
      const message = (err as Error).message
      try {
        setSeoTargets(await api.getSeoTargets(merchantId))
      } catch {
        // 保留最后一次可验证状态；人工对账不会自动重试。
      }
      return message
    } finally {
      setLocalFalconBusy(false)
    }
  }, [merchantId])

  const regenerateSeo = useCallback(async () => {
    setSeoBusy(true)
    setSeoRegenerating(true)
    try {
      setSeoTargets(await api.regenerateSeoTargets(merchantId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSeoBusy(false)
      setSeoRegenerating(false)
    }
  }, [merchantId])

  const activateKeywordVersion = useCallback(async (artifactId: number, expectedActiveArtifactId: number | null) => {
    try {
      setSeoTargets(await api.activateSeoKeywordVersion(merchantId, {
        artifact_id: artifactId,
        expected_active_artifact_id: expectedActiveArtifactId,
        confirmed: true,
      }))
      setError('')
      return null
    } catch (err) {
      const requestError = (err as Error).message
      try {
        setSeoTargets(await api.getSeoTargets(merchantId))
      } catch {
        // The failed request remains visible; never replace a known active table with a candidate.
      }
      return requestError
    }
  }, [merchantId])

  if (!merchant || !profile) {
    return (
      <main aria-label="正在加载商户资料" className="merchant-workspace-page merchant-profile-page">
        <p className="breadcrumb"><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const isUnbound = profile.state === 'unbound'
  const hasLocations = profile.locations.length > 0
  const isArchived = merchant.status === 'archived'

  return (
    <main aria-label="商户资料" className="merchant-workspace-page merchant-profile-page">
      <header className="merchant-identity-bar">
        <Link to="/" className="back-button" aria-label="返回商户列表">
          <span aria-hidden="true">←</span><span>商户列表</span>
        </Link>
        <div className="merchant-identity">
          <h1>{merchant.name}</h1>
          <p className="page-summary">{merchant.primary_location || merchant.notes || '查看从 FBR 只读同步的 Google 商户资料。'}</p>
        </div>
        <div className="page-actions">
          <span className={`badge ${merchant.status}`}>{merchant.status === 'active' ? '在营' : '已归档'}</span>
        </div>
      </header>

      <MerchantSectionNav merchantId={merchantId} active="profile" />
      {error && <p className="error profile-error" role="alert">{error}</p>}
      {isArchived && <p className="notice warning" role="status">商户已归档，恢复在营后可操作。</p>}

      {isUnbound ? (
        <section className="profile-connect-panel" aria-labelledby="profile-connect-title">
          <div>
            <p className="section-code">READ-ONLY SOURCE</p>
            <h2 id="profile-connect-title">连接 FBR 商户资料</h2>
            <p>保存准确的 FBR Merchant ID 后，SEO Ops 可以只读同步已落库的 GBP 门店资料。</p>
          </div>
          {!isArchived && (
            <form onSubmit={bind} className="profile-bind-form">
              <label>FBR Merchant ID<input aria-label="FBR Merchant ID" value={fbrMerchantId} onChange={event => setFbrMerchantId(event.target.value)} required /></label>
              <button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存绑定'}</button>
            </form>
          )}
          <p className="source-boundary">这里只保存资源 ID 和资料快照，不保存 Google 授权凭证。</p>
        </section>
      ) : (
        <>
          <section className="profile-source-bar" aria-label="FBR 同步状态">
            <div className="profile-source-summary">
              <span className={`source-status ${profile.state}`}>{profile.state === 'synced' ? 'FBR 已同步' : profile.state === 'failed' ? '同步失败' : '等待首次同步'}</span>
              <span className="source-id">Merchant ID · {profile.fbr_merchant_id}</span>
              {profile.last_synced_at && <span>最后同步 {formatTime(profile.last_synced_at)}</span>}
            </div>
            {!isArchived && (
              <div className="profile-source-actions">
                <button
                  type="button"
                  onClick={() => setShowFbrRelink(value => !value)}
                  disabled={busy || fbrRelinking || profile.binding_generation == null || !profile.binding_sha256}
                >
                  重新绑定 FBR
                </button>
                <button className="primary" type="button" onClick={() => void sync()} disabled={busy || fbrRelinking}>
                  {busy ? '同步中…' : hasLocations ? '重新同步' : '同步 GBP 资料'}
                </button>
              </div>
            )}
          </section>

          {showFbrRelink && (
            <form className="profile-relink-panel" aria-label="重新绑定 FBR Merchant ID" onSubmit={relinkFbr}>
              <div className="profile-relink-intro">
                <p className="section-code">IDENTITY CORRECTION</p>
                <h2>纠正 FBR 资源绑定</h2>
                <p>仅用于同一商户绑定错误的纠正。系统会保留旧绑定历史，并清空当前可替换的 GBP 快照；有活动任务时会拒绝操作。</p>
              </div>
              <label>
                <span>新的 FBR Merchant ID</span>
                <input
                  aria-label="新的 FBR Merchant ID"
                  value={newFbrMerchantId}
                  onChange={event => setNewFbrMerchantId(event.target.value)}
                  disabled={fbrRelinking}
                  required
                />
              </label>
              <label>
                <span>重新绑定原因</span>
                <textarea
                  aria-label="重新绑定原因"
                  value={fbrRelinkReason}
                  onChange={event => setFbrRelinkReason(event.target.value)}
                  disabled={fbrRelinking}
                  required
                />
              </label>
              <label className="profile-relink-confirmation">
                <input
                  type="checkbox"
                  checked={fbrRelinkConfirmed}
                  onChange={event => setFbrRelinkConfirmed(event.target.checked)}
                  disabled={fbrRelinking}
                />
                <span>我确认这是同一商户的正确 FBR 资源，并理解当前 GBP 快照将被清空</span>
              </label>
              <div className="profile-relink-actions">
                <button type="button" className="quiet" onClick={cancelFbrRelink} disabled={fbrRelinking}>取消</button>
                <button
                  type="submit"
                  className="danger-button"
                  disabled={
                    fbrRelinking
                    || !fbrRelinkConfirmed
                    || !newFbrMerchantId.trim()
                    || !fbrRelinkReason.trim()
                    || newFbrMerchantId.trim() === profile.fbr_merchant_id
                  }
                >
                  {fbrRelinking ? '正在重新绑定…' : '确认重新绑定'}
                </button>
              </div>
            </form>
          )}

          {profile.last_error && <p className="notice warning profile-sync-warning">上次同步失败：{profile.last_error}。已保留最后一次成功数据。</p>}

          {hasLocations && selectedLocation ? (
            <section className="profile-location-area" aria-label="GBP 门店资料">
              <div className="profile-location-toolbar">
                <div>
                  <p className="section-code">BUSINESS RECORD</p>
                  <h2>GBP 门店资料</h2>
                </div>
                <div className="profile-location-actions">
                  {profile.locations.length > 1 && (
                    <label>GBP 门店
                      <select aria-label="GBP 门店" value={selectedLocation.gbp_location_id} onChange={event => setSelectedLocationId(event.target.value)}>
                        {profile.locations.map(location => <option key={location.gbp_location_id} value={location.gbp_location_id}>{location.title}</option>)}
                      </select>
                    </label>
                  )}
                  {profile.locations.length === 1 && (
                    <label className="single-location-label">GBP 门店
                      <select aria-label="GBP 门店" value={selectedLocation.gbp_location_id} disabled>
                        <option value={selectedLocation.gbp_location_id}>{selectedLocation.title}</option>
                      </select>
                    </label>
                  )}
                </div>
              </div>
              <GbpLocationRecord
                location={selectedLocation}
                seoTargets={seoTargets}
                seoBusy={seoBusy}
                seoRegenerating={seoRegenerating}
                localFalconBusy={localFalconBusy}
                onRefreshSeo={() => void refreshSeo()}
                onRegenerateSeo={() => void regenerateSeo()}
                onActivateKeywordVersion={activateKeywordVersion}
                onSyncLocalFalcon={() => void syncLocalFalcon()}
                onGenerateLocalFalcon={generateLocalFalcon}
                onReconcileLocalFalcon={reconcileLocalFalcon}
              />
            </section>
          ) : (
            <section className="profile-empty-state">
              <h2>尚无 GBP 门店资料</h2>
              <p>点击“同步 GBP 资料”读取 FBR 当前已落库的门店信息。</p>
            </section>
          )}
        </>
      )}
    </main>
  )
}

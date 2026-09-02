import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  api,
  type LocalFalconSnapshot,
  type Merchant,
  type MerchantGbpLocation,
  type MerchantProfile as MerchantProfileData,
  type SeoTargetState,
} from '../api'
import MerchantSectionNav from '../components/MerchantSectionNav'
import { formatTime } from '../format'

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
const SEO_KEYWORD_PREVIEW_COUNT = 10

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
    const key = keyword.toLocaleLowerCase()
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
    <section className="gbp-data-section" id="gbp-performance" aria-labelledby="gbp-performance-title">
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
  return (
    <span
      className="local-falcon-mini-heatmap"
      role="img"
      aria-label={`${report.keyword} Local Falcon 热力图`}
      style={{ gridTemplateColumns: `repeat(${report.grid_size}, 6px)` }}
    >
      {localFalconPoints(report).map((point, index) => (
        <span
          aria-hidden="true"
          className={`local-falcon-mini-dot ${localFalconRankTone(point.rank, point.found)}`}
          key={`${point.lat}-${point.lng}-${index}`}
        />
      ))}
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

function KeywordRanking({
  state,
  busy,
  localFalconBusy,
  onRefresh,
  onRegenerate,
  onSyncLocalFalcon,
}: {
  state: SeoTargetState | null
  busy: boolean
  localFalconBusy: boolean
  onRefresh: () => void
  onRegenerate: () => void
  onSyncLocalFalcon: () => void
}) {
  const [showAll, setShowAll] = useState(false)
  const [selectedReportKey, setSelectedReportKey] = useState<string | null>(null)
  const rankRows = new Map(
    (state?.ranking_report?.keywords ?? []).map(row => [row.keyword.trim().toLocaleLowerCase(), row]),
  )
  const localFalconReports = state?.local_falcon?.reports ?? []
  const localFalconRows = new Map(
    localFalconReports.map(report => [report.keyword.trim().toLocaleLowerCase(), report]),
  )
  const keywords = state?.keyword_set?.keywords ?? []
  const visibleKeywords = showAll ? keywords : keywords.slice(0, SEO_KEYWORD_PREVIEW_COUNT)
  const isRunning = state?.cycle_status === 'running'
  const isPersistedReadback = state?.keyword_set?.generation_method === 'PERSISTED_FBR_READBACK'
  const buttonLabel = busy || isRunning ? '同步中…' : keywords.length > 0 ? '重新同步关键词库' : '同步关键词库'
  const selectedReport = localFalconReports.find(report => report.report_key === selectedReportKey) ?? null
  const orderedGridPoints = selectedReport ? localFalconPoints(selectedReport) : []

  return (
    <section className="gbp-data-section" id="seo-keywords" aria-labelledby="seo-keywords-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">SEO TARGETS</p>
          <div className="field-label-line">
            <h3 id="seo-keywords-title">SEO 目标关键词与排名</h3>
            <FieldHelp label="目标关键词" description="优先读取 FBR 已落库关键词，不会在页面加载或同步时重新生成。只有数据库无数据且正式的 seed + ranking Skill 工作流已配置后，才允许单独发起生成。" />
          </div>
        </div>
        <div className="seo-target-actions">
          {isRunning && state?.active_stage
            ? <span>{seoStageLabels[state.active_stage]}{keywords.length > 0 ? ' · 当前结果保留' : ''}</span>
            : isPersistedReadback
              ? <span>FBR 已落库 · {keywords.length} 个关键词</span>
              : keywords.length > 0 ? <span>历史 Agent 结果</span> : null}
          <button
            className="quiet"
            type="button"
            onClick={onSyncLocalFalcon}
            disabled={localFalconBusy || isRunning || keywords.length === 0}
          >{localFalconBusy ? '同步中…' : '同步已有 Local Falcon 报告'}</button>
          <button className="quiet" type="button" onClick={onRefresh} disabled={busy || isRunning}>{buttonLabel}</button>
          {state?.capabilities?.can_regenerate ? (
            <button className="quiet" type="button" onClick={onRegenerate} disabled={busy || isRunning}>重新生成</button>
          ) : null}
        </div>
      </div>
      {state?.cycle_status === 'failed' && (
        <p className="seo-target-message error" role="alert">关键词同步失败：{state.error || '未能读取 FBR 关键词库'}</p>
      )}
      {keywords.length > 0 ? (
        <div className="seo-target-table-wrap">
          <div className={`seo-target-table-viewport ${showAll ? 'expanded' : ''}`}>
            <table className="seo-target-table">
              <thead>
                <tr>
                  <th><span className="field-label-line">关键词与扫描参数<FieldHelp label="本地排名" description="DataForSEO 读取的单一搜索位置 Local Pack 名次，会显示在关键词下方；它不是 Local Falcon 网格的平均排名。" /></span></th>
                  <th>热力图</th>
                  <th><span className="field-label-line align-right">ARP<FieldHelp label="ARP" description="Local Falcon 网格中各采样点排名的平均值；数值越低越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">ATRP<FieldHelp label="ATRP" description="商户被发现的采样点中，各点排名的平均值；数值越低越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">SoLV<FieldHelp label="SoLV" description="Share of Local Voice，本地排名可见度占比；数值越高越好。" align="end" /></span></th>
                  <th><span className="field-label-line align-right">自然排名<FieldHelp label="自然排名" description="商户网站在普通自然搜索结果中的可验证位置；没有测得时显示“—”，不代表第 0 名。" align="end" /></span></th>
                  <th><span className="visually-hidden">操作</span></th>
                </tr>
              </thead>
              <tbody>
                {visibleKeywords.map(keyword => {
                const normalizedKeyword = keyword.keyword.trim().toLocaleLowerCase()
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
                              {ranking?.local_rank ? <span>Local Pack <strong>#{ranking.local_rank}</strong></span> : null}
                            </>
                          )}
                        </span>
                        <span className={`seo-priority ${keyword.priority.toLocaleLowerCase()}`}>{priorityLabels[keyword.priority]}</span>
                      </div>
                    </td>
                    <td>{localFalcon ? <LocalFalconMiniHeatmap report={localFalcon} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="rank" value={localFalcon.arp} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="rank" value={localFalcon.atrp} /> : '—'}</td>
                    <td>{localFalcon ? <LocalFalconMetricChip metric="solv" value={localFalcon.solv} /> : '—'}</td>
                    <td>{ranking?.organic_rank ? `#${ranking.organic_rank}` : '—'}</td>
                    <td>{localFalcon ? (
                      <button
                        type="button"
                        className="local-falcon-report-button"
                        aria-label={`查看 ${keyword.keyword} 的 Local Falcon 报告`}
                        aria-expanded={selectedReportKey === localFalcon.report_key}
                        onClick={() => setSelectedReportKey(localFalcon.report_key)}
                      >查看报告</button>
                    ) : null}</td>
                  </tr>
                )
                })}
              </tbody>
            </table>
          </div>
          <div className="seo-target-footer">
            {keywords.length > SEO_KEYWORD_PREVIEW_COUNT ? (
              <button type="button" className="quiet" onClick={() => setShowAll(value => !value)}>
                {showAll ? `收起，仅看前 ${SEO_KEYWORD_PREVIEW_COUNT} 个` : `查看全部 ${keywords.length} 个关键词`}
              </button>
            ) : <span />}
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
          {selectedReport && (
            <div className="local-falcon-drawer-backdrop">
              <aside
                className="local-falcon-drawer"
                role="dialog"
                aria-modal="true"
                aria-label={`${selectedReport.keyword} Local Falcon 报告`}
              >
                <header className="local-falcon-drawer-head">
                  <div>
                    <p className="section-code">LOCAL FALCON / SCAN REPORT</p>
                    <h4>{selectedReport.keyword}</h4>
                    <p>报告 {selectedReport.report_key}</p>
                  </div>
                  <button
                    type="button"
                    className="local-falcon-drawer-close"
                    aria-label="关闭 Local Falcon 报告"
                    onClick={() => setSelectedReportKey(null)}
                  >×</button>
                </header>
                <div className="local-falcon-drawer-body">
                  <div className="local-falcon-drawer-summary">
                    <div><span>ARP</span><LocalFalconMetricChip metric="rank" value={selectedReport.arp} /></div>
                    <div><span>ATRP</span><LocalFalconMetricChip metric="rank" value={selectedReport.atrp} /></div>
                    <div><span>SoLV</span><LocalFalconMetricChip metric="solv" value={selectedReport.solv} /></div>
                  </div>
                  <div className="local-falcon-scan-meta" aria-label="扫描参数">
                    <span>{selectedReport.grid_size} × {selectedReport.grid_size}</span>
                    <span>{selectedReport.radius} {selectedReport.measurement}</span>
                    <span>{selectedReport.found_in} / {selectedReport.grid_points.length} 个采样点可见</span>
                    <span>{formatTime(selectedReport.captured_at)}</span>
                  </div>
                  <section className="local-falcon-map-panel" aria-label="地理排名分布">
                    <div
                      className="local-falcon-grid"
                      role="grid"
                      aria-label={`${selectedReport.keyword} 地理排名点阵`}
                      style={{
                        gridTemplateColumns: `repeat(${selectedReport.grid_size}, minmax(0, 1fr))`,
                        width: Math.min(selectedReport.grid_size * 52, 520),
                      }}
                    >
                      {orderedGridPoints.map((point, index) => (
                        <span
                          key={`${point.lat}-${point.lng}-${index}`}
                          className={`local-falcon-grid-cell ${localFalconRankTone(point.rank, point.found)}`}
                          role="gridcell"
                          aria-label={`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}：${point.rank ? `第 ${point.rank} 名` : '未发现'}`}
                          title={`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`}
                        >{point.rank ? `#${point.rank}` : '—'}</span>
                      ))}
                    </div>
                    <p className="local-falcon-legend"><span className="strong">1–3</span><span className="good">4–5</span><span className="medium">6–10</span><span className="weak">11+</span><span className="missing">未发现</span></p>
                  </section>
                </div>
              </aside>
            </div>
          )}
        </div>
      ) : (
        <div className="seo-target-empty">
          <strong>{isRunning && state?.active_stage ? seoStageLabels[state.active_stage] : '关键词库暂无数据'}</strong>
          <p>先读取 FBR 已落库关键词；生成新关键词需要单独配置并运行正式的 seed + ranking Skill 工作流。</p>
        </div>
      )}
    </section>
  )
}

function GbpLocationRecord({
  location,
  seoTargets,
  seoBusy,
  localFalconBusy,
  onRefreshSeo,
  onRegenerateSeo,
  onSyncLocalFalcon,
}: {
  location: MerchantGbpLocation
  seoTargets: SeoTargetState | null
  seoBusy: boolean
  localFalconBusy: boolean
  onRefreshSeo: () => void
  onRegenerateSeo: () => void
  onSyncLocalFalcon: () => void
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
        state={seoTargets}
        busy={seoBusy}
        localFalconBusy={localFalconBusy}
        onRefresh={onRefreshSeo}
        onRegenerate={onRegenerateSeo}
        onSyncLocalFalcon={onSyncLocalFalcon}
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

export default function MerchantProfile() {
  const { id } = useParams()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [profile, setProfile] = useState<MerchantProfileData | null>(null)
  const [seoTargets, setSeoTargets] = useState<SeoTargetState | null>(null)
  const [fbrMerchantId, setFbrMerchantId] = useState('')
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [seoBusy, setSeoBusy] = useState(false)
  const [localFalconBusy, setLocalFalconBusy] = useState(false)
  const autoSeoMerchantRef = useRef<number | null>(null)

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
    if (seoTargets?.cycle_status !== 'running') return
    let active = true
    const timer = window.setInterval(() => {
      void api.getSeoTargets(merchantId).then(next => {
        if (active) setSeoTargets(next)
      }).catch(err => {
        if (active) setError((err as Error).message)
      })
    }, 5000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [merchantId, seoTargets?.cycle_status])

  const selectedLocation = useMemo(
    () => profile?.locations.find(location => location.gbp_location_id === selectedLocationId) || profile?.locations[0],
    [profile, selectedLocationId],
  )

  const bind = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!fbrMerchantId.trim()) return
    setBusy(true)
    try {
      const next = await api.bindMerchantFbr(merchantId, fbrMerchantId.trim())
      setProfile(next)
      setSelectedLocationId('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const sync = async () => {
    setBusy(true)
    try {
      const next = await api.syncMerchantGbp(merchantId)
      setProfile(next)
      setSelectedLocationId(merchant ? preferredLocationId(merchant, next.locations) : next.locations[0]?.gbp_location_id || '')
      setError('')
    } catch (err) {
      setError((err as Error).message)
      try {
        setProfile(await api.getMerchantProfile(merchantId))
      } catch {
        // 保留当前已读到的快照，让失败不会遮住最后一次成功数据。
      }
    } finally {
      setBusy(false)
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

  const regenerateSeo = useCallback(async () => {
    setSeoBusy(true)
    try {
      setSeoTargets(await api.regenerateSeoTargets(merchantId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSeoBusy(false)
    }
  }, [merchantId])

  useEffect(() => {
    if (!profile || !seoTargets || profile.locations.length === 0 || seoTargets.cycle_status !== 'empty') return
    if (autoSeoMerchantRef.current === merchantId) return
    autoSeoMerchantRef.current = merchantId
    void refreshSeo()
  }, [merchantId, profile, refreshSeo, seoTargets])

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

      {isUnbound ? (
        <section className="profile-connect-panel" aria-labelledby="profile-connect-title">
          <div>
            <p className="section-code">READ-ONLY SOURCE</p>
            <h2 id="profile-connect-title">连接 FBR 商户资料</h2>
            <p>保存准确的 FBR Merchant ID 后，SEO Ops 可以只读同步已落库的 GBP 门店资料。</p>
          </div>
          <form onSubmit={bind} className="profile-bind-form">
            <label>FBR Merchant ID<input aria-label="FBR Merchant ID" value={fbrMerchantId} onChange={event => setFbrMerchantId(event.target.value)} required /></label>
            <button className="primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存绑定'}</button>
          </form>
          <p className="source-boundary">这里只保存资源 ID 和资料快照，不保存 Google 授权凭证。</p>
        </section>
      ) : (
        <>
          <section className="profile-source-bar" aria-label="FBR 同步状态">
            <div>
              <span className={`source-status ${profile.state}`}>{profile.state === 'synced' ? 'FBR 已同步' : profile.state === 'failed' ? '同步失败' : '等待首次同步'}</span>
              <span className="source-id">Merchant ID · {profile.fbr_merchant_id}</span>
              {profile.last_synced_at && <span>最后同步 {formatTime(profile.last_synced_at)}</span>}
            </div>
            <button className="primary" type="button" onClick={() => void sync()} disabled={busy}>
              {busy ? '同步中…' : hasLocations ? '重新同步' : '同步 GBP 资料'}
            </button>
          </section>

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
                localFalconBusy={localFalconBusy}
                onRefreshSeo={() => void refreshSeo()}
                onRegenerateSeo={() => void regenerateSeo()}
                onSyncLocalFalcon={() => void syncLocalFalcon()}
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

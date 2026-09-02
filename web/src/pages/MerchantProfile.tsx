import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type MerchantGbpLocation, type MerchantProfile as MerchantProfileData } from '../api'
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

function ContentAssets({ location }: { location: MerchantGbpLocation }) {
  const posts = location.recent_posts ?? []
  const sections = location.menu_sections ?? []
  return (
    <section className="gbp-data-section" id="gbp-content" aria-labelledby="gbp-content-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">CONTENT ASSETS</p>
          <h3 id="gbp-content-title">内容资产</h3>
        </div>
        <p>{sourceState(location.media_count, '媒体')}</p>
      </div>
      <div className="gbp-content-grid">
        <div className="gbp-content-column">
          <div className="gbp-content-stat">
            <strong>{countText(location.post_count, '条 Post')}</strong>
            <span>{location.live_post_count == null ? '在线状态未同步' : `${location.live_post_count} 条在线`}</span>
          </div>
          {posts.length > 0 ? (
            <div className="gbp-post-list">
              {posts.map((post, index) => (
                <details className="gbp-post-item" key={post.post_id ?? index} open={index === 0}>
                  <summary>
                    <span className="gbp-post-summary-copy">
                      <strong>{postTitle(post.summary)}</strong>
                      <small>{post.created_at ? formatTime(post.created_at) : '未提供发布时间'}</small>
                    </span>
                    <span className={`data-state ${post.state === 'LIVE' ? 'ready' : ''}`}>{post.state || '状态未知'}</span>
                  </summary>
                  <div className="gbp-post-preview">
                    {safeHttpUrl(post.media_url) && (
                      <img src={safeHttpUrl(post.media_url) ?? undefined} alt="GBP Post 配图" loading="lazy" />
                    )}
                    <div className="gbp-post-content">
                      <p>{post.summary || '此 Post 没有文案。'}</p>
                      <div className="gbp-post-meta">
                        <span>{post.media_count > 0 ? `${post.media_count} 张图片` : '无图片'}</span>
                        {safeHttpUrl(post.cta_url) && (
                          <a href={safeHttpUrl(post.cta_url) ?? undefined} target="_blank" rel="noreferrer">
                            打开 {post.cta_type || 'CTA'} 链接
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                </details>
              ))}
            </div>
          ) : <p className="profile-empty-copy">{location.post_count == null ? 'Post 尚未同步。' : 'FBR 当前未返回 Post。'}</p>}
        </div>
        <div className="gbp-content-column">
          <div className="gbp-content-stat">
            <strong>
              {location.menu_count == null
                ? '菜单未同步'
                : `${location.menu_count} 个菜单 · ${location.menu_section_count ?? 0} 个分类 · ${location.menu_item_count ?? 0} 个菜品`}
            </strong>
            <span>只展示分类摘要</span>
          </div>
          {sections.length > 0 ? (
            <ul className="gbp-menu-sections">
              {sections.map((section, index) => <li key={`${section.name}-${index}`}><span>{section.name}</span><strong>{section.item_count}</strong></li>)}
            </ul>
          ) : <p className="profile-empty-copy">{location.menu_count == null ? '菜单尚未同步。' : 'FBR 当前未返回菜单分类。'}</p>}
        </div>
      </div>
    </section>
  )
}

function Reviews({ location }: { location: MerchantGbpLocation }) {
  const reviews = location.recent_reviews ?? []
  return (
    <section className="gbp-data-section" id="gbp-reviews" aria-labelledby="gbp-reviews-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">REVIEWS</p>
          <h3 id="gbp-reviews-title">评价</h3>
        </div>
        <strong>{countText(location.review_count, '条')}</strong>
      </div>
      {reviews.length > 0 ? (
        <ul className="gbp-simple-list gbp-review-list">
          {reviews.map((review, index) => (
            <li key={review.review_id ?? index}>
              <div>
                <strong>{review.content || '无文字评价'}</strong>
                <span>{review.reviewer_name || '匿名用户'} · {review.created_at ? formatTime(review.created_at) : '时间未知'}</span>
              </div>
              <span>{review.rating == null ? '无评分' : `${review.rating.toFixed(1)} / 5`}{review.has_reply ? ' · 已回复' : ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="gbp-data-note">
          {location.review_count == null
            ? '评价接口尚未返回可用数据。'
            : 'FBR 当前返回 0 条评价；这不代表 Google 商户页面实际没有评价。'}
        </p>
      )}
    </section>
  )
}

function SourceCoverage() {
  return (
    <section className="gbp-data-section" id="gbp-performance" aria-labelledby="gbp-performance-title">
      <div className="gbp-data-section-head">
        <div>
          <p className="section-code">SOURCE COVERAGE</p>
          <h3 id="gbp-performance-title">表现与搜索词</h3>
        </div>
      </div>
      <dl className="gbp-coverage-list">
        <div><dt>GBP 表现</dt><dd><strong>UAT 接口未部署</strong><span>曝光、点击、电话与路线请求暂不展示</span></dd></div>
        <div><dt>搜索词</dt><dd><strong>UAT 接口未部署</strong><span>查询词与本地排名需接入独立数据源</span></dd></div>
      </dl>
    </section>
  )
}

function GbpLocationRecord({ location }: { location: MerchantGbpLocation }) {
  const categories = [location.primary_category, ...location.additional_categories].filter(Boolean) as string[]

  return (
    <article className="gbp-record" aria-label={`GBP 门店：${location.title}`}>
      <nav className="gbp-data-nav" aria-label="GBP 资料分区">
        <a href="#gbp-basic">基础资料</a>
        <a href="#gbp-content">内容资产</a>
        <a href="#gbp-reviews">评价</a>
        <a href="#gbp-performance">表现与搜索词</a>
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
        <div><dt>门店代码</dt><dd>{location.store_code || '—'}</dd></div>
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
      <SourceCoverage />

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
  const [fbrMerchantId, setFbrMerchantId] = useState('')
  const [selectedLocationId, setSelectedLocationId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([
      api.getMerchant(merchantId),
      api.getMerchantProfile(merchantId),
    ]).then(([merchantData, profileData]) => {
      if (!active) return
      setMerchant(merchantData)
      setProfile(profileData)
      setFbrMerchantId(profileData.fbr_merchant_id || '')
      setSelectedLocationId(preferredLocationId(merchantData, profileData.locations))
      setError('')
    }).catch(err => {
      if (active) setError((err as Error).message)
    })
    return () => { active = false }
  }, [merchantId])

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
              <GbpLocationRecord location={selectedLocation} />
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

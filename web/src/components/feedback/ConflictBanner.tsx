type ConflictBannerProps = {
  message: string
  detail?: string
  busy?: boolean
  onReload: () => void
}

export function ConflictBanner({ message, detail, busy = false, onReload }: ConflictBannerProps) {
  return (
    <div className="fb-conflict" role="alert" aria-busy={busy || undefined}>
      <span className="fb-stamp fb-stamp-on-warn">409</span>
      <div className="fb-conflict-text">
        <p>{message}</p>
        {detail && <p className="fb-conflict-detail">{detail}</p>}
      </div>
      <div className="fb-conflict-actions">
        {busy
          ? <span className="fb-conflict-status" role="status">加载中…</span>
          : <span className="fb-stamp fb-stamp-on-warn">写操作已禁用</span>}
        <button type="button" className="primary" onClick={onReload} disabled={busy} aria-busy={busy || undefined}>重新载入</button>
      </div>
    </div>
  )
}

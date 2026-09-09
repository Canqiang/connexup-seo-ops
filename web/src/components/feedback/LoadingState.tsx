type LoadingStateProps = {
  variant?: 'inline' | 'list' | 'detail'
  label?: string
  rows?: number
  className?: string
}

const LIST_WIDTHS = [
  ['72%', null, '60%', '45%', '100%'],
  ['58%', null, '70%', '40%', '100%'],
  ['80%', null, '52%', '48%', '100%'],
  ['64%', null, '66%', '36%', '100%'],
  ['70%', null, '58%', '50%', '100%'],
] as const

function Bar({ width, stamp }: { width?: string | null; stamp?: boolean }) {
  return <div className={stamp ? 'fb-skeleton fb-skeleton-stamp' : 'fb-skeleton'} style={width ? { width } : undefined} />
}

export function LoadingState({ variant = 'inline', label = '加载中…', rows = 5, className }: LoadingStateProps) {
  if (variant === 'inline') {
    return <p className={['fb-loading', className].filter(Boolean).join(' ')} role="status">{label}</p>
  }
  return (
    <div className={['fb-loading-card', className].filter(Boolean).join(' ')}>
      <div className="fb-loading-head"><span className="fb-loading-text" role="status">{label}</span></div>
      {variant === 'list' ? (
        <div aria-hidden="true">
          <div className="fb-sk-row fb-sk-row-head">
            <Bar width="40%" /><Bar width="70%" /><Bar width="55%" /><Bar width="45%" /><Bar width="60%" />
          </div>
          {Array.from({ length: rows }, (_, index) => {
            const widths = LIST_WIDTHS[index % LIST_WIDTHS.length]
            return (
              <div className="fb-sk-row" key={index}>
                {widths.map((width, cell) => <Bar key={cell} width={width} stamp={width === null} />)}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="fb-sk-detail" aria-hidden="true">
          <div className="fb-sk-title"><Bar width="96px" /><Bar width="220px" /></div>
          <div className="fb-sk-dl">
            <Bar width="64px" /><Bar width="60%" />
            <Bar width="48px" /><Bar stamp />
            <Bar width="72px" /><Bar width="76%" />
            <Bar width="56px" /><Bar width="32%" />
            <Bar width="64px" /><Bar width="54%" />
          </div>
        </div>
      )}
    </div>
  )
}

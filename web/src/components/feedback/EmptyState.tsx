import type { ReactNode } from 'react'
import type { NoticeAction } from './Notice'

type EmptyStateProps = {
  children: ReactNode
  action?: NoticeAction
  compact?: boolean
  className?: string
}

export function EmptyState({ children, action, compact, className }: EmptyStateProps) {
  const classes = ['empty-state', compact ? 'compact-empty' : null, className].filter(Boolean).join(' ')
  return (
    <div className={classes}>
      <p>{children}</p>
      {action && (
        <button type="button" className="primary" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>
      )}
    </div>
  )
}

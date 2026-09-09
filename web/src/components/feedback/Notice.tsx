import type { ReactNode } from 'react'

export type NoticeTone = 'error' | 'success' | 'warning'
export type NoticeAction = { label: string; onClick: () => void; disabled?: boolean }

type NoticeProps = {
  tone: NoticeTone
  children: ReactNode
  action?: NoticeAction
  id?: string
  className?: string
}

export function Notice({ tone, children, action, id, className }: NoticeProps) {
  const classes = ['fb-notice', `fb-notice-${tone}`, className].filter(Boolean).join(' ')
  return (
    <div className={classes} role={tone === 'error' ? 'alert' : 'status'} id={id}>
      <span>{children}</span>
      {action && (
        <button type="button" onClick={action.onClick} disabled={action.disabled}>{action.label}</button>
      )}
    </div>
  )
}

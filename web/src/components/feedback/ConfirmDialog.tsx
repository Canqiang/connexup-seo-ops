import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Notice } from './Notice'

export type ConfirmDialogProps = {
  open: boolean
  code: string
  title: string
  message?: ReactNode
  confirmLabel: string
  busyLabel?: string
  tone?: 'danger' | 'primary'
  busy?: boolean
  error?: string
  closeLabel?: string
  wide?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export function ConfirmDialog({
  open, code, title, message, confirmLabel, busyLabel = '提交中…', tone = 'danger',
  busy = false, error, closeLabel = '关闭', wide = false, onConfirm, onCancel, children,
}: ConfirmDialogProps) {
  const titleId = useId()
  const errorId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const opener = openerRef.current
      openerRef.current = null
      if (opener && opener.isConnected) opener.focus()
    }
  }, [open])

  // Keep focus inside the dialog: on open, and again after a busy phase, because
  // disabling the buttons while busy drops focus to <body>.
  useEffect(() => {
    if (!open || busy) return
    if (!dialogRef.current?.contains(document.activeElement)) cancelRef.current?.focus()
  }, [open, busy])

  // Escape is handled at document level so it works wherever focus ended up.
  useEffect(() => {
    if (!open) return
    const onDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', onDocumentKeyDown)
    return () => document.removeEventListener('keydown', onDocumentKeyDown)
  }, [open, busy, onCancel])

  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return
    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fb-backdrop">
      <section
        ref={dialogRef}
        className={wide ? 'fb-dialog fb-dialog-wide' : 'fb-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={error ? errorId : undefined}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      >
        <header className="fb-dialog-header">
          <div>
            <p className="section-code">{code}</p>
            <h4 className="fb-dialog-title" id={titleId}>{title}</h4>
          </div>
          <button type="button" className="dialog-close" aria-label={closeLabel} onClick={onCancel} disabled={busy}>×</button>
        </header>
        <div className="fb-dialog-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
          {children}
          {error && <Notice tone="error" id={errorId}>{error}</Notice>}
        </div>
        <footer className="fb-dialog-footer">
          <button type="button" className="quiet" ref={cancelRef} onClick={onCancel} disabled={busy}>取消</button>
          <button
            type="button"
            className={tone === 'danger' ? 'danger-solid' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  )
}

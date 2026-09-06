import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'

import { api, ApiError, type AgentMutationResponse } from '../../api'
import type { AgentManagerMode } from './AgentRegistryTable'

type AgentManagerDrawerProps = {
  mode: AgentManagerMode
  autoUpdate: boolean
  requestRefresh: (reason: 'mutation') => void
  onClose: () => void
  opener: HTMLElement | null
}

type FormValues = {
  coreai_agent_id: string
  agent_key: string
  display_name: string
  role: string
  sort_order: string
  suspect_after_seconds: string
}

const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
const lifecycleLabels = { active: '启用', disabled: '停用', retired: '已归档' } as const

export default function AgentManagerDrawer({ mode, autoUpdate, requestRefresh, onClose, opener }: AgentManagerDrawerProps) {
  const agent = mode.kind === 'register' ? null : mode.agent
  const [values, setValues] = useState<FormValues>({
    coreai_agent_id: agent?.coreai_agent_id ?? '',
    agent_key: agent?.agent_key ?? '',
    display_name: agent?.display_name ?? '',
    role: agent?.role ?? '',
    sort_order: String(agent?.sort_order ?? 0),
    suspect_after_seconds: String(agent?.suspect_after_seconds ?? 1800),
  })
  const [busy, setBusy] = useState(false)
  const [confirmation, setConfirmation] = useState<AgentMutationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstInputRef = useRef<HTMLInputElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const openerRef = useRef<HTMLElement | null>(opener)
  const mountedRef = useRef(true)
  const [portalNode] = useState(() => {
    const node = document.createElement('div')
    node.className = 'agent-workbench agent-workbench__portal'
    return node
  })

  useLayoutEffect(() => {
    mountedRef.current = true
    document.body.appendChild(portalNode)
    const opener = openerRef.current
    const root = document.getElementById('root')
    const hadAttribute = root?.hasAttribute('inert') ?? false
    const supportsProperty = root !== null && 'inert' in root
    const previousProperty = supportsProperty ? (root as HTMLElement & { inert: boolean }).inert : false
    root?.setAttribute('inert', '')
    if (supportsProperty && root) (root as HTMLElement & { inert: boolean }).inert = true
    queueMicrotask(() => mode.kind === 'retire' ? headingRef.current?.focus() : firstInputRef.current?.focus())
    return () => {
      mountedRef.current = false
      if (root) {
        if (hadAttribute) root.setAttribute('inert', '')
        else root.removeAttribute('inert')
        if (supportsProperty) (root as HTMLElement & { inert: boolean }).inert = previousProperty
      }
      portalNode.remove()
      const focusTarget = opener?.isConnected ? opener : document.getElementById('agent-workbench-registry')
      focusTarget?.focus()
    }
  }, [mode.kind, portalNode])

  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [onClose])

  const set = (key: keyof FormValues, value: string) => setValues(current => ({ ...current, [key]: value }))
  const fieldProps = (key: keyof FormValues, label: string) => ({
    'aria-label': label,
    value: values[key],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(key, event.target.value),
    'aria-describedby': fields[key] ? `agent-manager-${key}-error` : undefined,
  })

  const complete = (response: AgentMutationResponse) => {
    requestRefresh('mutation')
    if (!mountedRef.current) return
    setConfirmation(response)
    setError(null)
    setFields({})
  }
  const fail = (cause: unknown) => {
    if (!mountedRef.current) return
    setError(cause instanceof Error ? cause.message : '设置未保存')
    setFields(cause instanceof ApiError ? cause.fields : {})
  }
  const mutate = async (action: () => Promise<AgentMutationResponse>) => {
    setBusy(true)
    setError(null)
    setFields({})
    try { complete(await action()) } catch (cause) { fail(cause) } finally { if (mountedRef.current) setBusy(false) }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (mode.kind === 'register') {
      void mutate(() => api.registerAgent({
        coreai_agent_id: values.coreai_agent_id,
        agent_key: values.agent_key,
        display_name: values.display_name,
        role: values.role,
        sort_order: Number(values.sort_order),
        suspect_after_seconds: Number(values.suspect_after_seconds),
      }))
    } else if (mode.kind === 'edit') {
      void mutate(() => api.updateAgent(mode.agent.id, {
        display_name: values.display_name,
        role: values.role,
        sort_order: Number(values.sort_order),
        suspect_after_seconds: Number(values.suspect_after_seconds),
      }))
    } else if (mode.kind === 'replace') {
      void mutate(() => api.replaceAgent(mode.agent.id, {
        coreai_agent_id: values.coreai_agent_id,
        display_name: values.display_name,
        role: values.role,
        sort_order: Number(values.sort_order),
        suspect_after_seconds: Number(values.suspect_after_seconds),
      }))
    } else {
      void mutate(() => api.retireAgent(mode.agent.id))
    }
  }

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])]
    if (controls.length === 0) return
    if (event.shiftKey && document.activeElement === headingRef.current) {
      event.preventDefault(); controls.at(-1)?.focus()
    } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
      event.preventDefault(); controls[0].focus()
    } else if (event.shiftKey && document.activeElement === controls[0]) {
      event.preventDefault(); controls.at(-1)?.focus()
    }
  }

  const title = mode.kind === 'register' ? '注册 Agent' : mode.kind === 'edit' ? `管理 ${mode.agent.display_name}` : mode.kind === 'replace' ? `替换 ${mode.agent.display_name}` : `归档 ${mode.agent.display_name}`
  const submitLabel = mode.kind === 'register' ? '验证并注册' : mode.kind === 'edit' ? '保存设置' : mode.kind === 'replace' ? '验证并替换' : '确认归档'
  return createPortal(
    <div className="agent-workbench__drawer-backdrop">
      <div ref={dialogRef} className="agent-workbench__drawer" role="dialog" aria-modal="true" aria-labelledby="agent-manager-heading" onKeyDown={trapFocus}>
        <header><h2 id="agent-manager-heading" ref={headingRef} tabIndex={mode.kind === 'retire' ? -1 : undefined}>{title}</h2><button type="button" onClick={onClose} aria-label="关闭 Agent 管理">关闭</button></header>
        <form onSubmit={submit}>
          {mode.kind === 'retire' ? <p>归档后将从默认台账隐藏；历史事实仍保留。</p> : <div className="agent-workbench__drawer-fields">
            {(mode.kind === 'register' || mode.kind === 'replace') && <label>Core AI Agent ID<input ref={firstInputRef} {...fieldProps('coreai_agent_id', 'Core AI Agent ID')} required />{fields.coreai_agent_id && <small id="agent-manager-coreai_agent_id-error">{fields.coreai_agent_id}</small>}</label>}
            {mode.kind === 'register' && <label>Agent key<input {...fieldProps('agent_key', 'Agent key')} required />{fields.agent_key && <small id="agent-manager-agent_key-error">{fields.agent_key}</small>}</label>}
            <label>显示名称<input ref={mode.kind === 'edit' ? firstInputRef : undefined} {...fieldProps('display_name', '显示名称')} required />{fields.display_name && <small id="agent-manager-display_name-error">{fields.display_name}</small>}</label>
            <label>职责<input {...fieldProps('role', '职责')} required />{fields.role && <small id="agent-manager-role-error">{fields.role}</small>}</label>
            <label>排序<input type="number" {...fieldProps('sort_order', '排序')} />{fields.sort_order && <small id="agent-manager-sort_order-error">{fields.sort_order}</small>}</label>
            <label>状态待确认阈值<input type="number" {...fieldProps('suspect_after_seconds', '状态待确认阈值')} />{fields.suspect_after_seconds && <small id="agent-manager-suspect_after_seconds-error">{fields.suspect_after_seconds}</small>}</label>
            {agent?.coreai_metadata.timeout_hint_seconds !== null && agent?.coreai_metadata.timeout_hint_seconds !== undefined && <p>Core AI 配置参考值：{agent.coreai_metadata.timeout_hint_seconds} 秒</p>}
          </div>}
          {error && <p role="alert" className="agent-workbench__form-error">{error}</p>}
          {confirmation && <p className="agent-workbench__receipt">设置已保存 · {lifecycleLabels[confirmation.agent.lifecycle_status]} · {confirmation.sync_pending ? '同步待处理' : '无同步待处理'}{!autoUpdate && ' · 页面仍为暂停快照；点击刷新显示或恢复自动更新'}</p>}
          {mode.kind === 'edit' && <div className="agent-workbench__lifecycle-actions">
            {mode.agent.lifecycle_status === 'active'
              ? <button type="button" disabled={busy} onClick={() => void mutate(() => api.updateAgent(mode.agent.id, { lifecycle_status: 'disabled' }))}>停用 Agent</button>
              : <button type="button" disabled={busy} onClick={() => void mutate(() => api.updateAgent(mode.agent.id, { lifecycle_status: 'active' }))}>重新验证并启用</button>}
          </div>}
          <footer><button type="button" onClick={onClose}>取消</button><button type="submit" className="agent-workbench__operator-action" disabled={busy}>{busy ? '保存中…' : submitLabel}</button></footer>
        </form>
      </div>
    </div>, portalNode,
  )
}

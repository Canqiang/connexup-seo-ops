import { useEffect, useRef, useState } from 'react'
import { api, ApiError, isAbortError, type TaskAssignmentIdentity, type TaskAssignmentState } from '../api'

type Props = {
  taskId: number
  version: number
  assignment: TaskAssignmentIdentity | null
  agentBound?: boolean
  disabled: boolean
  onSaved: () => void
}

function identityKey(value: TaskAssignmentIdentity | null): string {
  return value ? `${value.assignee_type}:${value.assignee_id}` : ''
}

export default function TaskAssignment({ taskId, version, assignment, agentBound = false, disabled, onSaved }: Props) {
  const [editing, setEditing] = useState(false)
  const [state, setState] = useState<TaskAssignmentState | null>(null)
  const [selected, setSelected] = useState('')
  const [reason, setReason] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const controller = useRef<AbortController | null>(null)
  const inFlight = useRef(false)

  useEffect(() => () => { controller.current?.abort() }, [taskId])

  async function load() {
    if (inFlight.current) return
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    setEditing(true)
    setLoading(true)
    setError('')
    try {
      const fresh = await api.getTaskAssignment(taskId, next.signal)
      if (next.signal.aborted) return
      setState(fresh)
      setSelected(identityKey(fresh.assignment))
      setNeedsRefresh(false)
    } catch (err) {
      if (!isAbortError(err) && !next.signal.aborted) {
        setError('负责人信息读取失败，请重新加载。')
        setNeedsRefresh(true)
      }
    } finally {
      if (!next.signal.aborted) setLoading(false)
    }
  }

  function cancel() {
    controller.current?.abort()
    setEditing(false)
    setState(null)
    setReason('')
    setError('')
    setLoading(false)
  }

  const stale = state !== null && version > state.version
  const chosen = state?.options.find(option => identityKey(option) === selected)
  const changed = state !== null && selected !== identityKey(state.assignment)
  const locked = disabled || !state?.can_change

  async function save() {
    if (!state || locked || loading || needsRefresh || stale || !changed || !reason.trim() || inFlight.current) return
    if (selected && !chosen) return
    inFlight.current = true
    setSaving(true)
    const next = new AbortController()
    controller.current = next
    try {
      await api.setTaskAssignment(taskId, {
        expected_version: state.version,
        assignee_type: chosen?.assignee_type ?? null,
        assignee_id: chosen?.assignee_id ?? null,
        reason: reason.trim(),
      }, next.signal)
      if (next.signal.aborted) return
      setEditing(false)
      setState(null)
      setReason('')
      onSaved()
    } catch (err) {
      if (!isAbortError(err) && !next.signal.aborted) {
        setError(err instanceof ApiError && err.status === 409
          ? '任务已变化或暂不能转交，请重新加载负责人后确认。'
          : '分配未确认，请重新加载核实；不会自动重复提交。')
        setNeedsRefresh(true)
      }
    } finally {
      inFlight.current = false
      if (!next.signal.aborted) setSaving(false)
    }
  }

  return <section className="panel task-assignment" aria-label="任务负责人">
    <div className="panel-head compact">
      <div><h2>任务负责人</h2><p>责任分配不会自动开始执行。</p></div>
      {!editing && <button type="button" className="quiet" disabled={disabled} onClick={() => void load()}>分配负责人</button>}
    </div>
    <div className="task-assignment-body">
      <strong>{assignment?.display_name ?? '未分配'}</strong>
      {assignment?.assignee_type === 'AGENT' && <p>{agentBound
        ? '已配置专用 Agent；开始前会校验配置，准备结果仍需 AM 审批，不会自动发布。'
        : '专用 Agent 未配置执行绑定或已停用，不能使用默认内容准备通道。'}</p>}
      {assignment?.agent_status && assignment.agent_status !== 'active' && <p>该 Agent 已停用或退役，请重新分配。</p>}
      {disabled && <p>任务正在处理或已结束，当前不能转交。</p>}
      {editing && <>
        {loading && <p role="status">正在读取负责人…</p>}
        {error && <p role="alert">{error}</p>}
        {stale && <p role="status">任务版本已更新，请重新加载负责人后再保存。</p>}
        {state?.lock_reason && <p>{state.lock_reason}</p>}
        {(needsRefresh || stale) && <button type="button" disabled={loading || saving} onClick={() => void load()}>重新加载负责人</button>}
        {state && <>
          <label>选择负责人<select aria-label="选择负责人" value={selected} disabled={locked || loading || saving} onChange={event => setSelected(event.target.value)}>
            <option value="">未分配</option>
            {state.assignment && !state.options.some(option => identityKey(option) === identityKey(state.assignment)) &&
              <option value={identityKey(state.assignment)} disabled>{state.assignment.display_name}（不可继续分配）</option>}
            {state.options.map(option => <option key={identityKey(option)} value={identityKey(option)}>{option.assignee_type === 'AGENT' ? `Agent · ${option.display_name}` : option.display_name}</option>)}
          </select></label>
          <label>分配原因<textarea aria-label="分配原因" maxLength={2000} rows={2} value={reason} disabled={locked || saving} onChange={event => setReason(event.target.value)} /></label>
        </>}
        <div className="task-assignment-actions">
          <button type="button" className="quiet" aria-label="取消分配编辑" disabled={saving} onClick={cancel}>取消</button>
          <button type="button" className="primary" disabled={locked || loading || saving || stale || needsRefresh || !changed || !reason.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存分配'}</button>
        </div>
      </>}
    </div>
  </section>
}

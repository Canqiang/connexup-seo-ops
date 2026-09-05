import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, ApiError, type Merchant, type TaskPlan, type TaskPlanItem, type TaskPlanPayload, isAbortError } from '../api'
import { executionWaves, isTaskPlan, taskPlanSnapshot, taskPlanValidationErrors } from '../taskPlan'

type EditorTask = TaskPlanItem & {
  editorId: string
  persistedKey: string | null
}

type BusyAction = 'save' | 'approve' | 'reject' | 'load' | null

const DECISION_LABELS = {
  DRAFT: '待审批',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  SUPERSEDED: '已取代',
} as const

const CATEGORY_OPTIONS = [
  ['', '未设置'],
  ['gbp', 'GBP 资料'],
  ['content', '内容建设'],
  ['review', '评论口碑'],
  ['citation', '信息一致性'],
  ['technical', '技术优化'],
  ['other', '其他'],
] as const

function cloneTask(item: TaskPlanItem, editorId: string): EditorTask {
  return {
    ...item,
    depends_on: [...item.depends_on],
    parameters: { ...item.parameters },
    editorId,
    persistedKey: item.key,
  }
}

function planItem(item: EditorTask): TaskPlanItem {
  return {
    key: item.key,
    task_type: 'PREPARE_ONLY',
    title: item.title,
    rationale: item.rationale,
    expected_outcome: item.expected_outcome,
    depends_on: [...item.depends_on],
    scheduled_start: item.scheduled_start || null,
    parameters: { ...item.parameters },
  }
}

function parameterText(item: EditorTask, key: 'description' | 'category'): string {
  const value = item.parameters[key]
  return typeof value === 'string' ? value : ''
}

function PlanTaskEditor({
  item,
  activeTasks,
  changed,
  disabled,
  removalReason,
  onChange,
  onMarkRemoval,
  onUndoRemoval,
  onRemoveNew,
  onRemovalReason,
}: {
  item: EditorTask
  activeTasks: EditorTask[]
  changed: boolean
  disabled: boolean
  removalReason: string | undefined
  onChange: (editorId: string, patch: Partial<TaskPlanItem>) => void
  onMarkRemoval: (editorId: string) => void
  onUndoRemoval: (editorId: string) => void
  onRemoveNew: (editorId: string) => void
  onRemovalReason: (editorId: string, reason: string) => void
}) {
  const displayKey = item.key || '未命名'
  const pendingRemoval = removalReason !== undefined
  const availableDependencies = activeTasks.filter(candidate => candidate.editorId !== item.editorId)

  const updateParameter = (key: 'description' | 'category', value: string) => {
    const parameters = { ...item.parameters }
    if (value) parameters[key] = value
    else delete parameters[key]
    onChange(item.editorId, { parameters })
  }

  return (
    <article className={`plan-task-editor${pendingRemoval ? ' pending-removal' : ''}`} aria-label={`Task ${displayKey}`}>
      <header className="plan-task-head">
        <div>
          <span className="plan-task-key">{displayKey}</span>
          <span className="plan-task-type">PREPARE_ONLY</span>
          {changed && <span className="plan-change-mark">用户已修改</span>}
          {pendingRemoval && <span className="plan-remove-mark">待删除</span>}
        </div>
        {pendingRemoval ? (
          <button type="button" className="quiet" disabled={disabled} onClick={() => onUndoRemoval(item.editorId)} aria-label={`撤销删除 ${displayKey}`}>
            撤销删除
          </button>
        ) : item.persistedKey ? (
          <button type="button" className="quiet danger-link" disabled={disabled} onClick={() => onMarkRemoval(item.editorId)} aria-label={`标记删除 ${displayKey}`}>
            标记删除
          </button>
        ) : (
          <button type="button" className="quiet danger-link" disabled={disabled} onClick={() => onRemoveNew(item.editorId)} aria-label={`移除新增任务 ${displayKey}`}>
            移除新增任务
          </button>
        )}
      </header>

      {pendingRemoval ? (
        <div className="plan-removal-editor">
          <p>保存新 revision 后才会移除；原始建议和原因会保留在审计记录中。</p>
          <label>
            <span>删除原因</span>
            <textarea
              aria-label={`删除原因 ${displayKey}`}
              value={removalReason}
              onChange={event => onRemovalReason(item.editorId, event.target.value)}
              rows={3}
              maxLength={2000}
              required
              disabled={disabled}
            />
          </label>
        </div>
      ) : (
        <div className="plan-task-fields">
          <label className="plan-field-key">
            <span>Task key</span>
            <input
              aria-label={`Task key ${displayKey}`}
              value={item.key}
              readOnly={Boolean(item.persistedKey)}
              disabled={disabled}
              onChange={event => onChange(item.editorId, { key: event.target.value })}
            />
          </label>
          <label className="plan-field-title">
            <span>任务标题</span>
            <input
              aria-label={`任务标题 ${displayKey}`}
              value={item.title}
              disabled={disabled}
              onChange={event => onChange(item.editorId, { title: event.target.value })}
            />
          </label>
          <label>
            <span>任务理由</span>
            <textarea
              aria-label={`任务理由 ${displayKey}`}
              value={item.rationale}
              disabled={disabled}
              onChange={event => onChange(item.editorId, { rationale: event.target.value })}
              rows={3}
            />
          </label>
          <label>
            <span>预期结果</span>
            <textarea
              aria-label={`预期结果 ${displayKey}`}
              value={item.expected_outcome}
              disabled={disabled}
              onChange={event => onChange(item.editorId, { expected_outcome: event.target.value })}
              rows={3}
            />
          </label>
          <label>
            <span>前置任务</span>
            <select
              multiple
              aria-label={`前置任务 ${displayKey}`}
              value={item.depends_on}
              disabled={disabled}
              onChange={event => onChange(item.editorId, {
                depends_on: Array.from(event.currentTarget.selectedOptions, option => option.value),
              })}
            >
              {availableDependencies.map(candidate => (
                <option key={candidate.editorId} value={candidate.key}>{candidate.key || '未命名'}</option>
              ))}
            </select>
            <span className="plan-dependency-help">
              <small>按住 Command 或 Ctrl 可多选；不能选择自身或重复依赖。</small>
              {item.depends_on.length > 0 && (
                <button type="button" className="quiet" disabled={disabled} onClick={() => onChange(item.editorId, { depends_on: [] })}>
                  清除全部前置任务
                </button>
              )}
            </span>
          </label>
          <label>
            <span>计划开始时间</span>
            <input
              aria-label={`计划开始时间 ${displayKey}`}
              value={item.scheduled_start ?? ''}
              disabled={disabled}
              placeholder="2026-09-05T13:00:00Z"
              onChange={event => onChange(item.editorId, { scheduled_start: event.target.value || null })}
            />
            <small>使用带时区的 RFC 3339 时间；留空表示不延后。</small>
          </label>
          <label>
            <span>准备说明</span>
            <textarea
              aria-label={`任务描述 ${displayKey}`}
              value={parameterText(item, 'description')}
              disabled={disabled}
              onChange={event => updateParameter('description', event.target.value)}
              rows={3}
              maxLength={4000}
            />
          </label>
          <label>
            <span>任务类别</span>
            <select
              aria-label={`任务类别 ${displayKey}`}
              value={parameterText(item, 'category')}
              disabled={disabled}
              onChange={event => updateParameter('category', event.target.value)}
            >
              {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
      )}
    </article>
  )
}

export default function PlanReview() {
  const { id } = useParams()
  return <PlanReviewWorkspace key={id ?? 'invalid'} planId={Number(id)} />
}

function PlanReviewWorkspace({ planId }: { planId: number }) {
  const validPlanId = Number.isInteger(planId) && planId > 0
  const nextEditorId = useRef(1)
  const mountedRef = useRef(false)
  const identityEpochRef = useRef(0)
  const loadEpochRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const mutationControllerRef = useRef<AbortController | null>(null)
  const mutationInFlightRef = useRef(false)
  const editEpochRef = useRef(0)
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [merchantStatus, setMerchantStatus] = useState<Merchant['status'] | null>(null)
  const [tasks, setTasks] = useState<EditorTask[]>([])
  const [savedSnapshot, setSavedSnapshot] = useState('')
  const [removalReasons, setRemovalReasons] = useState<Record<string, string>>({})
  const [rejectReason, setRejectReason] = useState('')
  const [busy, setBusy] = useState<BusyAction>(validPlanId ? 'load' : null)
  const [error, setError] = useState(validPlanId ? '' : 'Plan ID 无效')
  const [notice, setNotice] = useState('')
  const [conflicted, setConflicted] = useState(false)

  const isCurrentIdentity = useCallback((epoch: number) => (
    mountedRef.current && identityEpochRef.current === epoch
  ), [])

  const applyServerPlan = useCallback((fresh: TaskPlan, epoch: number) => {
    if (!isCurrentIdentity(epoch) || !isTaskPlan(fresh) || fresh.id !== planId || fresh.current_revision.plan_id !== planId) return false
    const payload = fresh.current_revision.payload
    setPlan(fresh)
    setTasks(payload.tasks.map((item, index) => cloneTask(
      item,
      `revision-${fresh.current_revision.revision}-${index}-${item.key}`,
    )))
    setSavedSnapshot(taskPlanSnapshot(payload))
    setRemovalReasons({})
    setConflicted(false)
    editEpochRef.current += 1
    return true
  }, [isCurrentIdentity, planId])

  const load = useCallback(async () => {
    const identityEpoch = identityEpochRef.current
    const loadEpoch = ++loadEpochRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    if (!validPlanId || !mountedRef.current) return
    setBusy('load')
    setPlan(null)
    setMerchantStatus(null)
    setTasks([])
    setSavedSnapshot('')
    setRemovalReasons({})
    setRejectReason('')
    setError('')
    setNotice('')
    setConflicted(false)
    try {
      const fresh = await api.getTaskPlan(planId, controller.signal)
      if (!isCurrentIdentity(identityEpoch) || loadEpochRef.current !== loadEpoch || controller.signal.aborted) return
      if (!applyServerPlan(fresh, identityEpoch)) {
        setError('Task Plan 响应与当前路由不一致')
        return
      }
      const merchant = await api.getMerchant(fresh.merchant_id, controller.signal)
      if (!isCurrentIdentity(identityEpoch) || loadEpochRef.current !== loadEpoch || controller.signal.aborted) return
      if (merchant.id !== fresh.merchant_id) {
        setError('商户响应与 Task Plan 不一致')
        return
      }
      if (merchant.status !== 'active' && merchant.status !== 'archived') {
        setError('商户状态响应无效')
        return
      }
      setMerchantStatus(merchant.status)
      setError('')
      setNotice('')
    } catch (loadError) {
      if (isAbortError(loadError) || !isCurrentIdentity(identityEpoch) || loadEpochRef.current !== loadEpoch) return
      setError((loadError as Error).message)
    } finally {
      if (isCurrentIdentity(identityEpoch) && loadEpochRef.current === loadEpoch) setBusy(null)
    }
  }, [applyServerPlan, isCurrentIdentity, planId, validPlanId])

  useEffect(() => {
    mountedRef.current = true
    identityEpochRef.current += 1
    const timer = window.setTimeout(() => void load(), 0)
    return () => {
      window.clearTimeout(timer)
      mountedRef.current = false
      identityEpochRef.current += 1
      loadEpochRef.current += 1
      loadControllerRef.current?.abort()
      mutationControllerRef.current?.abort()
      mutationInFlightRef.current = false
    }
  }, [load])

  const activeTasks = useMemo(
    () => tasks.filter(task => removalReasons[task.editorId] === undefined),
    [removalReasons, tasks],
  )
  const payload = useMemo<TaskPlanPayload>(() => ({
    schema_version: 'seo_ops.task_plan.v1',
    tasks: activeTasks.map(planItem),
  }), [activeTasks])
  const dirty = plan ? taskPlanSnapshot(payload) !== savedSnapshot || Object.keys(removalReasons).length > 0 : false

  const validationErrors = useMemo(() => {
    const errors = taskPlanValidationErrors(payload.tasks)
    for (const task of tasks) {
      const reason = removalReasons[task.editorId]
      if (reason !== undefined && task.persistedKey && !reason.trim()) {
        errors.push(`删除任务 ${task.persistedKey} 前必须填写原因`)
      }
      if (reason !== undefined && reason.trim().length > 2000) {
        errors.push(`删除任务 ${task.persistedKey ?? task.key} 的原因超过 2000 字`)
      }
    }
    for (const active of activeTasks) {
      for (const removed of tasks.filter(task => removalReasons[task.editorId] !== undefined)) {
        if (active.key === removed.persistedKey) {
          errors.push(`不能在同一 revision 删除并重新添加 Task key ${active.key}`)
        }
        if (active.depends_on.includes(removed.key)) {
          errors.push(`任务 ${active.key} 仍依赖待删除任务 ${removed.key}，请先调整前置任务`)
        }
      }
    }
    return [...new Set(errors)]
  }, [activeTasks, payload.tasks, removalReasons, tasks])

  const waves = useMemo(() => {
    try {
      return executionWaves(activeTasks.map(planItem)).map(wave => (
        wave.map(waveItem => activeTasks.find(task => task.key === waveItem.key)!)
      ))
    } catch {
      return activeTasks.length ? [activeTasks] : []
    }
  }, [activeTasks])

  const savedTasks = useMemo(
    () => new Map(plan?.current_revision.payload.tasks.map(item => [
      item.key,
      taskPlanSnapshot({ schema_version: 'seo_ops.task_plan.v1', tasks: [item] }),
    ]) ?? []),
    [plan],
  )

  const markConflict = (actionError: unknown, epoch: number) => {
    if (!isCurrentIdentity(epoch)) return
    if (actionError instanceof ApiError && actionError.status === 409) setConflicted(true)
    setError((actionError as Error).message)
    setNotice('')
  }

  const beginMutation = (action: Exclude<BusyAction, 'load' | null>) => {
    if (mutationInFlightRef.current || !mountedRef.current) return null
    mutationInFlightRef.current = true
    const controller = new AbortController()
    mutationControllerRef.current = controller
    setBusy(action)
    return { controller, epoch: identityEpochRef.current }
  }

  const finishMutation = (controller: AbortController, epoch: number) => {
    if (mutationControllerRef.current !== controller) return
    mutationControllerRef.current = null
    mutationInFlightRef.current = false
    if (isCurrentIdentity(epoch)) setBusy(null)
  }

  const updateTask = (editorId: string, patch: Partial<TaskPlanItem>) => {
    if (mutationInFlightRef.current) return
    editEpochRef.current += 1
    setTasks(current => {
      const currentTask = current.find(task => task.editorId === editorId)
      if (!currentTask) return current
      const previousKey = currentTask.key
      return current.map(task => {
        if (task.editorId === editorId) return { ...task, ...patch }
        if (patch.key !== undefined && previousKey !== patch.key && task.depends_on.includes(previousKey)) {
          return { ...task, depends_on: task.depends_on.map(key => key === previousKey ? patch.key! : key) }
        }
        return task
      })
    })
    setNotice('')
  }

  const addTask = () => {
    if (mutationInFlightRef.current) return
    editEpochRef.current += 1
    const existing = new Set(tasks.map(task => task.key))
    let suffix = 1
    let key = 'new-task'
    while (existing.has(key)) {
      suffix += 1
      key = `new-task-${suffix}`
    }
    setTasks(current => [...current, {
      editorId: `new-${nextEditorId.current++}`,
      persistedKey: null,
      key,
      task_type: 'PREPARE_ONLY',
      title: '',
      rationale: '',
      expected_outcome: '',
      depends_on: [],
      scheduled_start: null,
      parameters: {},
    }])
    setNotice('')
  }

  const save = async () => {
    if (merchantStatus !== 'active' || !plan || plan.id !== planId || conflicted || validationErrors.length > 0 || !dirty) return
    const mutation = beginMutation('save')
    if (!mutation) return
    const sourcePlan = plan
    const sourceEditEpoch = editEpochRef.current
    try {
      const removals = tasks.flatMap(task => {
        const reason = removalReasons[task.editorId]
        return task.persistedKey && reason !== undefined
          ? [{ key: task.persistedKey, reason: reason.trim() }]
          : []
      })
      const fresh = await api.replaceTaskPlanDraft(sourcePlan.id, {
        expected_revision: sourcePlan.current_revision.revision,
        plan: payload,
        removals,
      }, mutation.controller.signal)
      if (!isCurrentIdentity(mutation.epoch) || mutation.controller.signal.aborted) return
      if (editEpochRef.current !== sourceEditEpoch) {
        setConflicted(true)
        setError('保存期间本地 Plan 已变化，服务器响应未覆盖当前编辑')
        return
      }
      if (!applyServerPlan(fresh, mutation.epoch)) {
        setConflicted(true)
        setError('Task Plan 响应与当前路由不一致')
        return
      }
      setError('')
      setNotice(`已保存 Revision ${fresh.current_revision.revision}`)
    } catch (saveError) {
      if (!isAbortError(saveError)) markConflict(saveError, mutation.epoch)
    } finally {
      finishMutation(mutation.controller, mutation.epoch)
    }
  }

  const approve = async () => {
    if (merchantStatus !== 'active' || !plan || plan.id !== planId || dirty || conflicted || validationErrors.length > 0 || plan.current_revision.decision_state !== 'DRAFT') return
    const mutation = beginMutation('approve')
    if (!mutation) return
    const sourcePlan = plan
    try {
      const fresh = await api.approveTaskPlan(sourcePlan.id, {
        revision: sourcePlan.current_revision.revision,
        checksum: sourcePlan.current_revision.checksum,
      }, mutation.controller.signal)
      if (!isCurrentIdentity(mutation.epoch) || mutation.controller.signal.aborted) return
      if (!applyServerPlan(fresh, mutation.epoch)) {
        setConflicted(true)
        setError('Task Plan 响应与当前路由不一致')
        return
      }
      setError('')
      setNotice('当前 Revision 已批准')
    } catch (approveError) {
      if (!isAbortError(approveError)) markConflict(approveError, mutation.epoch)
    } finally {
      finishMutation(mutation.controller, mutation.epoch)
    }
  }

  const reject = async () => {
    if (merchantStatus !== 'active' || !plan || plan.id !== planId || dirty || conflicted || !rejectReason.trim() || rejectReason.trim().length > 2000 || plan.current_revision.decision_state !== 'DRAFT') return
    const mutation = beginMutation('reject')
    if (!mutation) return
    const sourcePlan = plan
    try {
      const fresh = await api.rejectTaskPlan(sourcePlan.id, {
        expected_revision: sourcePlan.current_revision.revision,
        reason: rejectReason.trim(),
      }, mutation.controller.signal)
      if (!isCurrentIdentity(mutation.epoch) || mutation.controller.signal.aborted) return
      if (!applyServerPlan(fresh, mutation.epoch)) {
        setConflicted(true)
        setError('Task Plan 响应与当前路由不一致')
        return
      }
      setRejectReason('')
      setError('')
      setNotice('当前 Revision 已拒绝')
    } catch (rejectError) {
      if (!isAbortError(rejectError)) markConflict(rejectError, mutation.epoch)
    } finally {
      finishMutation(mutation.controller, mutation.epoch)
    }
  }

  if (!plan) {
    return (
      <main className="plan-review-page" aria-label="Plan 审批工作区">
        {error ? (
          <section className="plan-load-state" role="alert">
            <strong>无法读取 Plan</strong>
            <p>{error}</p>
            <button type="button" onClick={() => void load()} disabled={busy === 'load'}>重新加载</button>
          </section>
        ) : <p className="plan-load-state">正在读取 Plan…</p>}
      </main>
    )
  }

  const currentDecision = plan.current_revision.decision_state
  const merchantReadOnly = merchantStatus !== 'active'
  const mutationLocked = merchantReadOnly || busy === 'save' || busy === 'approve' || busy === 'reject'
  const canSave = !merchantReadOnly && dirty && !conflicted && validationErrors.length === 0 && !busy
  const canApprove = !merchantReadOnly && !dirty && !conflicted && validationErrors.length === 0 && currentDecision === 'DRAFT' && !busy
  const backTo = plan.source_run_id ? `/runs/${plan.source_run_id}` : `/merchants/${plan.merchant_id}`

  return (
    <main className="plan-review-page" aria-label="Plan 审批工作区">
      <header className="plan-identity-bar">
        <Link to={backTo} className="back-button" aria-label="返回 Plan 来源">
          <span aria-hidden="true">←</span>
          <span>{plan.source_run_id ? '分析报告' : '商户工作区'}</span>
        </Link>
        <div className="plan-identity-copy">
          <h1>Task Plan 审批</h1>
          <p>逐项编辑后保存完整 revision；批准会冻结当前 checksum，并一次性物化全部 Task。</p>
        </div>
        <dl className="plan-machine-identity" aria-label="Plan 版本身份">
          <div><dt>Plan</dt><dd>#{plan.id}</dd></div>
          <div><dt>Revision</dt><dd>{plan.current_revision.revision}</dd></div>
          <div><dt>状态</dt><dd>{DECISION_LABELS[currentDecision]}</dd></div>
          <div><dt>Checksum</dt><dd title={plan.current_revision.checksum}>{plan.current_revision.checksum.slice(0, 12)}</dd></div>
        </dl>
      </header>

      {error && (
        <div className="plan-message error" role="alert">
          <span>{error}</span>
          {(conflicted || merchantStatus !== 'active') && (
            <button type="button" onClick={() => void load()} disabled={Boolean(busy)}>
              {conflicted ? '重新载入服务器 Plan' : '重新加载 Plan 与商户状态'}
            </button>
          )}
        </div>
      )}
      {notice && <p className="plan-message success" role="status">{notice}</p>}
      {merchantStatus === 'archived' && (
        <p className="plan-message warning" role="status">商户已归档，Plan 与生成任务仅供查看；恢复在营后可继续审批。</p>
      )}
      {merchantStatus === null && !error && (
        <p className="plan-message warning" role="status">正在确认商户状态，Plan 暂时只读。</p>
      )}

      <div className="plan-review-layout">
        <section className="plan-wave-ledger" aria-labelledby="plan-wave-title">
          <header className="plan-ledger-head">
            <div>
              <h2 id="plan-wave-title">执行波次</h2>
              <p>同一波可并行准备；下一波必须等待全部前置 Task 完成。</p>
            </div>
            <button type="button" onClick={addTask} disabled={mutationLocked || activeTasks.length >= 50}>添加 Task</button>
          </header>

          {waves.map((wave, waveIndex) => (
            <section className="plan-wave" aria-label={`第 ${waveIndex + 1} 波`} key={`wave-${waveIndex}`}>
              <div className="plan-wave-marker" aria-hidden="true">
                <span>{waveIndex + 1}</span>
              </div>
              <div className="plan-wave-content">
                <header>
                  <h3>第 {waveIndex + 1} 波</h3>
                  <span>{wave.length} 项</span>
                </header>
                {wave.map(item => {
                  const changed = item.persistedKey === null
                    || savedTasks.get(item.persistedKey) !== taskPlanSnapshot({
                      schema_version: 'seo_ops.task_plan.v1',
                      tasks: [planItem(item)],
                    })
                  return (
                    <PlanTaskEditor
                      key={item.editorId}
                      item={item}
                      activeTasks={activeTasks}
                      changed={changed}
                      disabled={mutationLocked}
                      removalReason={removalReasons[item.editorId]}
                      onChange={updateTask}
                      onMarkRemoval={editorId => {
                        if (mutationInFlightRef.current) return
                        editEpochRef.current += 1
                        setRemovalReasons(current => ({ ...current, [editorId]: '' }))
                      }}
                      onUndoRemoval={editorId => setRemovalReasons(current => {
                        if (mutationInFlightRef.current) return current
                        editEpochRef.current += 1
                        const next = { ...current }
                        delete next[editorId]
                        return next
                      })}
                      onRemoveNew={editorId => {
                        if (mutationInFlightRef.current) return
                        editEpochRef.current += 1
                        setTasks(current => current.filter(task => task.editorId !== editorId))
                      }}
                      onRemovalReason={(editorId, reason) => {
                        if (mutationInFlightRef.current) return
                        editEpochRef.current += 1
                        setRemovalReasons(current => ({ ...current, [editorId]: reason }))
                      }}
                    />
                  )
                })}
              </div>
            </section>
          ))}

          {tasks.filter(task => removalReasons[task.editorId] !== undefined).map(item => (
            <section className="plan-removed-row" aria-label={`待删除 Task ${item.key}`} key={`removed-${item.editorId}`}>
              <PlanTaskEditor
                item={item}
                activeTasks={activeTasks}
                changed
                disabled={mutationLocked}
                removalReason={removalReasons[item.editorId]}
                onChange={updateTask}
                onMarkRemoval={() => {}}
                onUndoRemoval={editorId => setRemovalReasons(current => {
                  if (mutationInFlightRef.current) return current
                  editEpochRef.current += 1
                  const next = { ...current }
                  delete next[editorId]
                  return next
                })}
                onRemoveNew={editorId => {
                  if (mutationInFlightRef.current) return
                  editEpochRef.current += 1
                  setTasks(current => current.filter(task => task.editorId !== editorId))
                }}
                onRemovalReason={(editorId, reason) => {
                  if (mutationInFlightRef.current) return
                  editEpochRef.current += 1
                  setRemovalReasons(current => ({ ...current, [editorId]: reason }))
                }}
              />
            </section>
          ))}
        </section>

        <aside className="plan-decision-rail" aria-label="整版审批">
          <section className="plan-decision-summary">
            <h2>整版审批</h2>
            <p>审批对象是保存后的完整 Plan，不支持单 Task 批准。</p>
            <dl>
              <div><dt>当前任务</dt><dd>{activeTasks.length}</dd></div>
              <div><dt>执行波次</dt><dd>{validationErrors.length ? '—' : waves.length}</dd></div>
              <div><dt>已生效 revision</dt><dd>{plan.approved_revision ?? '无'}</dd></div>
            </dl>
          </section>

          {validationErrors.length > 0 && (
            <section className="plan-validation" aria-label="Plan 校验错误" role="alert">
              <strong>先修正以下问题</strong>
              <ul>{validationErrors.map(message => <li key={message}>{message}</li>)}</ul>
            </section>
          )}

          {dirty && validationErrors.length === 0 && (
            <p className="plan-dirty-note">存在未保存修改。保存后才能批准或拒绝当前 revision。</p>
          )}
          {conflicted && <p className="plan-conflict-note">服务器 revision 已变化，旧 checksum 已失效。请重新载入后审阅。</p>}

          <div className="plan-primary-actions">
            <button type="button" onClick={() => void save()} disabled={!canSave}>
              {busy === 'save' ? '保存中…' : '保存 Plan 草稿'}
            </button>
            <button type="button" className="primary" onClick={() => void approve()} disabled={!canApprove}>
              {busy === 'approve' ? '批准中…' : '批准当前 Plan'}
            </button>
          </div>

          <section className="plan-reject-zone" aria-labelledby="plan-reject-title">
            <h3 id="plan-reject-title">拒绝整个 Plan</h3>
            <label>
              <span>拒绝原因</span>
              <textarea
                aria-label="拒绝原因"
                value={rejectReason}
                onChange={event => {
                  if (!mutationInFlightRef.current) setRejectReason(event.target.value)
                }}
                rows={4}
                maxLength={2000}
                disabled={mutationLocked}
              />
            </label>
            <button
              type="button"
              className="danger-button"
              onClick={() => void reject()}
              disabled={merchantReadOnly || dirty || conflicted || !rejectReason.trim() || rejectReason.trim().length > 2000 || currentDecision !== 'DRAFT' || Boolean(busy)}
            >
              {busy === 'reject' ? '拒绝中…' : '拒绝整个 Plan'}
            </button>
          </section>
        </aside>
      </div>
    </main>
  )
}

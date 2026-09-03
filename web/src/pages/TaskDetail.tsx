import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ApiError,
  api,
  type Merchant,
  type TaskBlocker,
  type TaskDetail as TaskDetailRecord,
  type TaskExecution,
  type TaskMetadataUpdate,
  type TaskSummary,
} from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, TASK_STATUS_CLASSES, TASK_STATUS_LABELS } from '../labels'

const EXECUTION_STATUS_LABELS: Record<TaskExecution['status'], string> = {
  PENDING: '等待派发',
  DISPATCHING: '正在派发',
  RUNNING: '运行中',
  SUCCEEDED: '准备完成',
  FAILED: '准备失败',
  UNKNOWN: '结果不确定',
  CANCELLED: '已停止',
}

function executionStatusLabel(execution: TaskExecution): string {
  if (execution.status === 'SUCCEEDED') {
    if (execution.stage === 'PUBLICATION') return '发布完成'
    if (execution.stage === 'VERIFICATION') return '验证完成'
  }
  if (execution.status === 'FAILED') {
    if (execution.stage === 'PUBLICATION') return '发布失败'
    if (execution.stage === 'VERIFICATION') return '验证失败'
  }
  return EXECUTION_STATUS_LABELS[execution.status]
}

const EXECUTION_STATUS_CLASSES: Record<TaskExecution['status'], string> = {
  PENDING: 'todo',
  DISPATCHING: 'doing',
  RUNNING: 'doing',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNKNOWN: 'failed',
  CANCELLED: 'cancelled',
}

const EVENT_LABELS: Record<string, string> = {
  TASK_MATERIALIZED: '由批准的 Plan 物化',
  TASK_METADATA_UPDATED: '内部元数据已更新',
  TASK_CANCELLED: '任务已取消并保留历史',
  TASK_PREPARATION_CLAIMED: '内容准备已认领',
  TASK_PREPARATION_SUCCEEDED: '内容准备已返回可审结果',
  TASK_PREPARATION_FAILED: '内容准备失败',
  TASK_PREPARATION_UNKNOWN: '内容准备结果不确定',
  TASK_PREPARATION_RETRY_AUTHORIZED: '操作人授权重新准备',
  TASK_PREPARATION_APPROVED: '操作人批准准备结果',
  TASK_PREPARATION_RETURNED: '操作人退回重新准备',
  TASK_REPLACED: '任务已被 replacement 取代',
  TASK_CREATED_AS_REPLACEMENT: '作为 replacement 创建',
}

type TaskOrigin = {
  kind: 'merchant' | 'tasks' | 'run'
  from: string
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function normalizeMetadataText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? ''
  return normalized || null
}

function normalizeMetadataLabels(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function equalLabels(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function metadataUpdateCandidate(
  task: TaskDetailRecord,
  assignee: string,
  labels: string[],
  operatorNote: string,
): TaskMetadataUpdate | null {
  const normalizedAssignee = normalizeMetadataText(assignee)
  const normalizedLabels = normalizeMetadataLabels(labels)
  const normalizedOperatorNote = normalizeMetadataText(operatorNote)
  const assigneeChanged = normalizedAssignee !== normalizeMetadataText(task.assignee)
  const labelsChanged = !equalLabels(normalizedLabels, normalizeMetadataLabels(task.labels))
  const operatorNoteChanged = normalizedOperatorNote !== normalizeMetadataText(task.operator_note)
  const shared = {
    expected_version: task.version,
    ...(labelsChanged ? { labels: normalizedLabels } : {}),
    ...(operatorNoteChanged ? { operator_note: normalizedOperatorNote } : {}),
  }
  if (assigneeChanged) return { ...shared, assignee: normalizedAssignee }
  if (labelsChanged) return { ...shared, labels: normalizedLabels }
  if (operatorNoteChanged) return { expected_version: task.version, operator_note: normalizedOperatorNote }
  return null
}

function blockerSummary(blocker: TaskBlocker | null): string {
  if (!blocker) return '可执行'
  if (blocker.code === 'UPSTREAM_NOT_DONE') {
    return blocker.task_title ? `被「${blocker.task_title}」阻塞` : '等待上游任务完成'
  }
  if (blocker.code === 'SCHEDULED_FOR_FUTURE') {
    return blocker.scheduled_start ? `等待至 ${formatTime(blocker.scheduled_start)}` : '等待计划时间'
  }
  if (blocker.code === 'MERCHANT_ARCHIVED') return '商户已归档'
  return 'Plan revision 已停用'
}

function isStaleIdentityConflict(error: unknown): error is ApiError {
  return error instanceof ApiError
    && error.status === 409
    && (error.message === 'task changed; refresh and retry'
      || error.message === 'task review target changed; refresh and retry')
}

function latestExecution(task: TaskDetailRecord): TaskExecution | null {
  return task.executions.length > 0 ? task.executions[task.executions.length - 1] : null
}

function isActiveExecution(execution: TaskExecution | null): boolean {
  return execution !== null && ['PENDING', 'DISPATCHING', 'RUNNING'].includes(execution.status)
}

type VerifiedTaskResult = {
  outcome: 'ready'
  summary: string
  artifact_refs: string[]
  evidence: string[]
  external_write_performed: false
}

type TrustedPreparation =
  | { kind: 'reviewable'; result: VerifiedTaskResult }
  | { kind: 'trusted-unknown-no-tool' }
  | { kind: 'untrusted' }

const PREPARATION_REQUEST_KEYS = [
  'definition_checksum',
  'executor_kind',
  'llm_call_id',
  'stage',
  'task_id',
  'workflow_version',
].sort()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isLowerHexChecksum(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isVerifiedPreparationResult(value: unknown): value is VerifiedTaskResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Record<string, unknown>
  const keys = Object.keys(result).sort()
  if (keys.join('|') !== 'artifact_refs|evidence|external_write_performed|outcome|summary') return false
  if (result.outcome !== 'ready'
    || result.external_write_performed !== false
    || typeof result.summary !== 'string'
    || !result.summary.trim()
    || result.summary !== result.summary.trim()
    || !Array.isArray(result.artifact_refs)
    || !Array.isArray(result.evidence)) return false
  const validStrings = (items: unknown[]) => items.every(item => typeof item === 'string' && Boolean(item.trim()))
  return validStrings(result.artifact_refs)
    && validStrings(result.evidence)
    && result.artifact_refs.length + result.evidence.length > 0
}

function trustedPreparation(task: TaskDetailRecord, execution: TaskExecution | null): TrustedPreparation {
  const latest = latestExecution(task)
  if (!execution
    || !latest
    || latest.id !== execution.id
    || latest.attempt !== execution.attempt
    || !Number.isInteger(execution.attempt)
    || execution.attempt < 1
    || task.task_type !== 'PREPARE_ONLY'
    || execution.stage !== 'PREPARATION'
    || task.execution_status !== execution.status
    || execution.task_id !== task.id
    || execution.reviewed_at !== null
    || execution.legacy_result
    || execution.coreai_run_id !== null
    || execution.provider_resource_id !== null
    || execution.approval_id !== null
    || execution.artifact_id !== null
    || !isRecord(execution.request)
    || Object.keys(execution.request).sort().join('|') !== PREPARATION_REQUEST_KEYS.join('|')
    || execution.request.executor_kind !== 'COREAI_LLM_CALL'
    || typeof execution.request.llm_call_id !== 'string'
    || !execution.request.llm_call_id.trim()
    || execution.request.definition_checksum !== task.definition_checksum
    || !isLowerHexChecksum(execution.request.definition_checksum)
    || execution.request.stage !== 'PREPARATION'
    || execution.request.task_id !== task.id
    || execution.request.workflow_version !== task.workflow_version
    || !Number.isInteger(execution.request.workflow_version)
    || (execution.request.workflow_version as number) <= 0
    || !isLowerHexChecksum(execution.request_checksum)
    || execution.idempotency_key !== `task:${task.id}:preparation:${execution.attempt}:${execution.request_checksum.slice(0, 16)}`) {
    return { kind: 'untrusted' }
  }

  if (execution.status === 'UNKNOWN'
    && task.status === 'NEEDS_ATTENTION'
    && execution.result === null
    && execution.result_checksum === null
    && Array.isArray(execution.evidence)
    && execution.evidence.length === 0) {
    return { kind: 'trusted-unknown-no-tool' }
  }

  if (execution.status !== 'SUCCEEDED'
    || task.status !== 'AWAITING_APPROVAL'
    || !isVerifiedPreparationResult(execution.result)) {
    return { kind: 'untrusted' }
  }
  const result = execution.result
  if (!isLowerHexChecksum(execution.result_checksum)
    || !Array.isArray(execution.evidence)
    || !execution.evidence.every(item => typeof item === 'string')
    || execution.evidence.length !== result.evidence.length
    || !execution.evidence.every((item, index) => item === result.evidence[index])) {
    return { kind: 'untrusted' }
  }
  return { kind: 'reviewable', result }
}

function executionResultView(execution: TaskExecution, trust: TrustedPreparation) {
  if (execution.result === null && (trust.kind !== 'untrusted' || execution.status !== 'SUCCEEDED')) return null
  if (trust.kind !== 'reviewable') {
    const rawResult = execution.result as unknown
    const reportedWrite = Boolean(rawResult
      && typeof rawResult === 'object'
      && !Array.isArray(rawResult)
      && (rawResult as Record<string, unknown>).external_write_performed === true)
    return (
      <section className="task-unsafe-result" role="alert">
        <strong>无法确认是否外写</strong>
        <p><span>{reportedWrite ? '结果报告可能发生外部业务写入' : '结果结构未通过本地安全校验'}</span></p>
        <p>{reportedWrite
          ? '该结果违反 PREPARE_ONLY 安全契约，不可审批；请人工核对事件与外部资源。'
          : '该结果不是可审的规范化 Preparation 结构；不可审批，也不能据此认定未发生外部写入。'}</p>
        <pre>{JSON.stringify(rawResult, null, 2)}</pre>
      </section>
    )
  }
  const result = trust.result
  return (
    <section className="task-result" aria-label={`Attempt ${execution.attempt} 结果`}>
      <h3>准备结果</h3>
      <p className="task-result-summary">{result.summary}</p>
      <div className="task-result-columns">
        <div><h4>Artifact refs</h4>{result.artifact_refs.length > 0 ? <ul>{result.artifact_refs.map((ref, index) => <li key={`${index}:${ref}`}><code>{ref}</code></li>)}</ul> : <p>无</p>}</div>
        <div><h4>Evidence</h4>{result.evidence.length > 0 ? <ul>{result.evidence.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul> : <p>无</p>}</div>
      </div>
      <p className="task-no-write-mark">已校验：无外部业务写入</p>
    </section>
  )
}

function isRetryablePreparation(task: TaskDetailRecord, execution: TaskExecution | null): boolean {
  if (task.status !== 'NEEDS_ATTENTION' || task.replaced_by_task_id !== null || !execution) return false
  if (task.executions.some(isActiveExecution)
    || execution.stage !== 'PREPARATION'
    || execution.idempotency_key.startsWith('legacy-task-execution-')
    || execution.legacy_result
    || execution.provider_resource_id !== null
    || execution.approval_id !== null
    || execution.artifact_id !== null
    || execution.reviewed_at !== null) return false
  if (execution.status === 'UNKNOWN') {
    return trustedPreparation(task, execution).kind === 'trusted-unknown-no-tool'
  }
  if (execution.status !== 'FAILED' && execution.status !== 'CANCELLED') return false
  return execution.result === null
    || (isRecord(execution.result) && execution.result.external_write_performed === false)
}

function resultIdentity(task: TaskDetailRecord, execution: TaskExecution) {
  if (!execution.result_checksum) throw new Error('当前准备结果缺少 checksum，不能审批')
  return {
    expected_version: task.version,
    expected_execution_id: execution.id,
    expected_result_checksum: execution.result_checksum,
  }
}

function dependencyList(tasks: TaskSummary[], empty: string) {
  if (tasks.length === 0) return <p className="task-dependency-empty">{empty}</p>
  return (
    <ul className="task-dependency-list">
      {tasks.map(item => (
        <li key={item.id}>
          <Link to={`/tasks/${item.id}`}>{item.title}</Link>
          <span>{TASK_STATUS_LABELS[item.status]}</span>
        </li>
      ))}
    </ul>
  )
}

export default function TaskDetail() {
  const { id } = useParams()
  return <TaskDetailPage key={id ?? 'invalid'} taskId={Number(id)} />
}

function TaskDetailPage({ taskId }: { taskId: number }) {
  const validTaskId = Number.isInteger(taskId) && taskId > 0
  const location = useLocation()
  const navigate = useNavigate()
  const mountedRef = useRef(false)
  const loadEpochRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const fullLoadInFlightRef = useRef(false)
  const actionControllerRef = useRef<AbortController | null>(null)
  const actionBusyRef = useRef(false)
  const taskRef = useRef<TaskDetailRecord | null>(null)
  const assigneeDraftRef = useRef('')
  const labelsDraftRef = useRef<string[]>([])
  const operatorNoteDraftRef = useRef('')
  const [task, setTask] = useState<TaskDetailRecord | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [loading, setLoading] = useState(validTaskId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(validTaskId ? '' : '任务 ID 无效')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [assignee, setAssignee] = useState('')
  const [labels, setLabels] = useState<string[]>([])
  const [operatorNote, setOperatorNote] = useState('')
  const [showCancel, setShowCancel] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [showRetry, setShowRetry] = useState(false)
  const [retryReason, setRetryReason] = useState('')
  const [showReturn, setShowReturn] = useState(false)
  const [returnReason, setReturnReason] = useState('')

  const acceptTask = useCallback((fresh: TaskDetailRecord, preserveMetadataDraft = false) => {
    if (fresh.id !== taskId) throw new Error('任务响应与当前路由不一致')
    const previous = taskRef.current
    const preserveAssignee = preserveMetadataDraft && previous !== null
      && normalizeMetadataText(assigneeDraftRef.current) !== normalizeMetadataText(previous.assignee)
    const preserveLabels = preserveMetadataDraft && previous !== null
      && !equalLabels(normalizeMetadataLabels(labelsDraftRef.current), normalizeMetadataLabels(previous.labels))
    const preserveOperatorNote = preserveMetadataDraft && previous !== null
      && normalizeMetadataText(operatorNoteDraftRef.current) !== normalizeMetadataText(previous.operator_note)
    taskRef.current = fresh
    setTask(fresh)
    if (!preserveAssignee) {
      assigneeDraftRef.current = fresh.assignee ?? ''
      setAssignee(fresh.assignee ?? '')
    }
    if (!preserveLabels) {
      labelsDraftRef.current = [...fresh.labels]
      setLabels([...fresh.labels])
    }
    if (!preserveOperatorNote) {
      operatorNoteDraftRef.current = fresh.operator_note ?? ''
      setOperatorNote(fresh.operator_note ?? '')
    }
  }, [taskId])

  const load = useCallback(() => {
    if (!validTaskId) return
    const epoch = ++loadEpochRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    fullLoadInFlightRef.current = true
    setLoading(true)
    setError('')
    setConflict(false)
    setShowCancel(false)
    setShowRetry(false)
    setShowReturn(false)
    api.getTask(taskId, controller.signal)
      .then(async fresh => {
        if (!mountedRef.current || loadEpochRef.current !== epoch || controller.signal.aborted) return
        acceptTask(fresh)
        const freshMerchant = await api.getMerchant(fresh.merchant_id, controller.signal)
        if (!mountedRef.current || loadEpochRef.current !== epoch || controller.signal.aborted) return
        if (freshMerchant.id !== fresh.merchant_id) throw new Error('商户响应与任务不一致')
        setMerchant(freshMerchant)
      })
      .catch(nextError => {
        if (!isAbortError(nextError) && mountedRef.current && loadEpochRef.current === epoch) {
          setError((nextError as Error).message)
        }
      })
      .finally(() => {
        if (loadControllerRef.current === controller) fullLoadInFlightRef.current = false
        if (mountedRef.current && loadEpochRef.current === epoch) setLoading(false)
      })
  }, [acceptTask, taskId, validTaskId])

  const poll = useCallback(() => {
    if (!validTaskId || actionBusyRef.current || fullLoadInFlightRef.current) return
    const epoch = ++loadEpochRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    api.getTask(taskId, controller.signal)
      .then(fresh => {
        if (!mountedRef.current || loadEpochRef.current !== epoch || controller.signal.aborted) return
        acceptTask(fresh, true)
        setError('')
        setConflict(false)
      })
      .catch(nextError => {
        if (!isAbortError(nextError) && mountedRef.current && loadEpochRef.current === epoch) {
          setError((nextError as Error).message)
        }
      })
  }, [acceptTask, taskId, validTaskId])

  useEffect(() => {
    mountedRef.current = true
    const initialLoad = window.setTimeout(load, 0)
    return () => {
      window.clearTimeout(initialLoad)
      mountedRef.current = false
      fullLoadInFlightRef.current = false
      loadEpochRef.current += 1
      loadControllerRef.current?.abort()
      actionControllerRef.current?.abort()
    }
  }, [load])

  const latestForPolling = task ? latestExecution(task) : null
  const shouldPoll = task !== null && (
    ['PREPARING', 'EXECUTING', 'VERIFYING'].includes(task.status)
    || isActiveExecution(latestForPolling)
  )

  useEffect(() => {
    if (!shouldPoll) return
    const timer = window.setInterval(poll, 5000)
    return () => window.clearInterval(timer)
  }, [poll, shouldPoll])

  const beginAction = () => {
    if (actionBusyRef.current) return null
    actionBusyRef.current = true
    loadEpochRef.current += 1
    loadControllerRef.current?.abort()
    fullLoadInFlightRef.current = false
    setLoading(false)
    const controller = new AbortController()
    actionControllerRef.current?.abort()
    actionControllerRef.current = controller
    setBusy(true)
    setError('')
    setNotice('')
    setConflict(false)
    return controller
  }

  const actionIsCurrent = (controller: AbortController) => (
    mountedRef.current && actionControllerRef.current === controller && !controller.signal.aborted
  )

  const finishAction = (controller: AbortController) => {
    if (actionControllerRef.current !== controller) return
    actionBusyRef.current = false
    if (mountedRef.current) setBusy(false)
  }

  const failAction = (controller: AbortController, nextError: unknown) => {
    if (isAbortError(nextError) || !actionIsCurrent(controller)) return
    if (isStaleIdentityConflict(nextError)) {
      setConflict(true)
      setError('任务已变更，请刷新后再操作。')
      return
    }
    setError((nextError as Error).message)
  }

  const reread = async (controller: AbortController) => {
    const fresh = await api.getTask(taskId, controller.signal)
    if (!actionIsCurrent(controller)) return null
    acceptTask(fresh)
    return fresh
  }

  const saveMetadata = async () => {
    if (!task) return
    const normalizedLabels = normalizeMetadataLabels(labels)
    if (normalizedLabels.length > 20) {
      setError('内部标签最多 20 个')
      return
    }
    if (normalizedLabels.some(value => value.length > 50)) {
      setError('每个内部标签最多 50 个字符')
      return
    }
    const body = metadataUpdateCandidate(task, assignee, labels, operatorNote)
    if (!body) {
      setError('')
      setNotice('没有需要保存的变更。')
      return
    }
    const controller = beginAction()
    if (!controller) return
    try {
      const summary = await api.patchTaskMetadata(taskId, body, controller.signal)
      if (!actionIsCurrent(controller)) return
      if (summary.id !== taskId) throw new Error('任务更新响应与当前路由不一致')
      await reread(controller)
      if (actionIsCurrent(controller)) setNotice('内部元数据已保存。')
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const cancelTask = async () => {
    if (!task || !cancelReason.trim()) return
    const controller = beginAction()
    if (!controller) return
    try {
      const summary = await api.cancelTask(taskId, {
        expected_version: task.version,
        reason: cancelReason.trim(),
      }, controller.signal)
      if (!actionIsCurrent(controller)) return
      if (summary.id !== taskId) throw new Error('任务取消响应与当前路由不一致')
      await reread(controller)
      if (actionIsCurrent(controller)) {
        setShowCancel(false)
        setCancelReason('')
        setNotice('任务已取消；定义、Attempts 和事件历史均已保留。')
      }
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const retryPreparation = async () => {
    if (!task || !retryReason.trim()) return
    const controller = beginAction()
    if (!controller) return
    try {
      const summary = await api.retryTaskPreparation(taskId, {
        expected_version: task.version,
        reason: retryReason.trim(),
      }, controller.signal)
      if (!actionIsCurrent(controller)) return
      if (summary.id !== taskId) throw new Error('任务重试响应与当前路由不一致')
      await reread(controller)
      if (actionIsCurrent(controller)) {
        setShowRetry(false)
        setRetryReason('')
        setNotice('已授权创建新的内容准备 Attempt。')
      }
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const execute = async () => {
    if (!task) return
    const controller = beginAction()
    if (!controller) return
    try {
      const execution = await api.executeTask(taskId, { expected_version: task.version }, controller.signal)
      if (!actionIsCurrent(controller)) return
      if (execution.task_id !== taskId) throw new Error('执行响应与当前任务不一致')
      await reread(controller)
      if (!actionIsCurrent(controller)) return
      if (execution.status === 'SUCCEEDED') setNotice('内容准备已完成，等待人工审批。')
      else if (execution.status === 'UNKNOWN') setNotice('本次内容准备结果不确定，需要人工判断后再重试。')
      else if (execution.status === 'FAILED') setNotice('本次内容准备失败，需要人工处理。')
      else setNotice(`内容准备 Attempt 当前状态：${executionStatusLabel(execution)}。`)
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const approve = async () => {
    if (!task) return
    const execution = latestExecution(task)
    if (!execution) return
    const controller = beginAction()
    if (!controller) return
    try {
      const response = await api.approveTaskExecution(taskId, resultIdentity(task, execution), controller.signal)
      if (!actionIsCurrent(controller)) return
      acceptTask(response.task)
      setNotice('准备结果已批准；PREPARE_ONLY Task 已完成，没有发布或验证外部资源。')
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const returnForRevision = async () => {
    if (!task || !returnReason.trim()) return
    const execution = latestExecution(task)
    if (!execution) return
    const controller = beginAction()
    if (!controller) return
    try {
      const response = await api.returnTaskExecution(taskId, {
        ...resultIdentity(task, execution),
        reason: returnReason.trim(),
      }, controller.signal)
      if (!actionIsCurrent(controller)) return
      acceptTask(response.task)
      setShowReturn(false)
      setReturnReason('')
      setNotice('结果已退回；下一次执行会创建新的内容准备 Attempt。')
    } catch (nextError) {
      failAction(controller, nextError)
    } finally {
      finishAction(controller)
    }
  }

  const origin = (location.state as { taskOrigin?: TaskOrigin } | null)?.taskOrigin
  const backLabel = origin?.kind === 'tasks'
    ? '返回任务总览'
    : origin?.kind === 'run'
      ? '返回分析报告'
      : `返回${merchant?.name ?? '商户工作区'}`

  const goBack = () => {
    if (origin?.from) navigate(origin.from)
    else navigate(task ? `/merchants/${task.merchant_id}` : '/tasks')
  }

  if (!task) {
    return (
      <main aria-label="任务详情" className="task-detail-page">
        {error ? (
          <section className="task-load-state" role="alert">
            <p>{error}</p>
            {validTaskId && <button type="button" onClick={load}>重试读取</button>}
          </section>
        ) : <p>{loading ? '加载中…' : '没有可显示的任务。'}</p>}
      </main>
    )
  }

  const latest = latestExecution(task)
  const metadataCandidate = metadataUpdateCandidate(task, assignee, labels, operatorNote)
  const canExecute = task.status === 'PENDING'
    && task.readiness === 'READY'
    && task.replaced_by_task_id === null
    && !task.executions.some(isActiveExecution)
  const canCancel = ['PENDING', 'AWAITING_APPROVAL', 'NEEDS_ATTENTION'].includes(task.status)
    && !task.executions.some(isActiveExecution)
  const canRetry = isRetryablePreparation(task, latest)
  const latestTrust = trustedPreparation(task, latest)
  const canReview = latestTrust.kind === 'reviewable'
  const lifecycleSteps = [
    { key: 'PENDING', label: '接收任务' },
    { key: 'PREPARING', label: '无工具内容准备' },
    { key: 'AWAITING_APPROVAL', label: '人工审批' },
    { key: 'DONE', label: '准备任务完成' },
  ] as const
  const currentIndex = lifecycleSteps.findIndex(step => step.key === task.status)

  return (
    <main aria-label="任务详情" className="task-detail-page">
      <header className="task-context-bar" aria-label="任务上下文">
        <div className="task-context-top">
          <button type="button" className="back-button" onClick={goBack} aria-label={backLabel}>
            <span aria-hidden="true">←</span>
            <span>{origin?.kind === 'tasks' ? '任务总览' : origin?.kind === 'run' ? '分析报告' : merchant?.name ?? '商户工作区'}</span>
          </button>
          <div className="task-summary" role="group" aria-label="任务状态与来源">
            <span className={`badge ${TASK_STATUS_CLASSES[task.status]}`}>{TASK_STATUS_LABELS[task.status]}</span>
            {task.category && <span className="badge cat">{CATEGORY_LABELS[task.category] ?? task.category}</span>}
            <Link to={`/task-plans/${task.plan_id}`}>Plan #{task.plan_id}</Link>
            {task.source_run_id != null && <Link to={`/runs/${task.source_run_id}`}>分析 #{task.source_run_id}</Link>}
          </div>
        </div>
        <div className="task-context-main">
          <div className="task-identity">
            <h1 id="task-detail-title">{task.title}</h1>
            <p>{task.task_key} · PREPARE_ONLY · Task version {task.version}</p>
          </div>
          <div className="task-actions" role="group" aria-label="任务操作">
            <button className="quiet" type="button" aria-label="刷新任务状态" onClick={load} disabled={busy || loading}>刷新</button>
            {canExecute && <button className="primary" type="button" onClick={() => void execute()} disabled={busy}>开始内容准备</button>}
            {canRetry && <button type="button" onClick={() => { setShowCancel(false); setShowRetry(value => !value) }} disabled={busy}>授权重新准备</button>}
            {canCancel && <button className="quiet" type="button" onClick={() => { setShowRetry(false); setShowCancel(value => !value) }} disabled={busy}>取消任务并保留历史</button>}
          </div>
        </div>
      </header>

      {error && (
        <section className="task-action-message error" role="alert">
          <span>{error}</span>
          {conflict && <button type="button" onClick={load} disabled={busy}>刷新任务</button>}
        </section>
      )}
      {notice && <p className="task-action-message success" role="status">{notice}</p>}

      {(showCancel || showRetry) && (
        <section className="task-decision-form" aria-label={showCancel ? '取消任务' : '重新准备'}>
          {showCancel ? (
            <>
              <label htmlFor="cancel-reason">取消原因</label>
              <textarea id="cancel-reason" maxLength={2000} value={cancelReason} onChange={event => setCancelReason(event.target.value)} disabled={busy} />
              <p>任务会进入 CANCELLED；定义、Attempts 和审计事件不会删除。</p>
              <div>
                <button className="danger-button" type="button" onClick={() => void cancelTask()} disabled={busy || !cancelReason.trim()}>确认取消任务</button>
                <button type="button" onClick={() => setShowCancel(false)} disabled={busy}>保留任务</button>
              </div>
            </>
          ) : (
            <>
              <label htmlFor="retry-reason">重试原因</label>
              <textarea id="retry-reason" maxLength={2000} value={retryReason} onChange={event => setRetryReason(event.target.value)} disabled={busy} />
              <p>会创建新的内容准备 Attempt，可能重复产生模型成本；不会发布外部资源。</p>
              <div>
                <button className="primary" type="button" onClick={() => void retryPreparation()} disabled={busy || !retryReason.trim()}>确认重新准备</button>
                <button type="button" onClick={() => setShowRetry(false)} disabled={busy}>暂不重试</button>
              </div>
            </>
          )}
        </section>
      )}

      <div className="task-detail-layout">
        <div className="task-detail-primary">
          <section className="task-lifecycle-ledger" aria-label="生命周期轨迹">
            <header>
              <div>
                <h2>生命周期轨迹</h2>
                <p>服务端模板决定状态；{blockerSummary(task.blocker)}。</p>
              </div>
              <span className={`badge ${task.readiness === 'READY' ? 'ready' : 'failed'}`}>{task.readiness === 'READY' ? 'READY' : 'BLOCKED'}</span>
            </header>
            <ol>
              {lifecycleSteps.map((step, index) => (
                <li key={step.key} className={task.status === step.key ? 'current' : currentIndex >= 0 && index < currentIndex ? 'complete' : ''}>
                  <span className="task-lifecycle-marker" aria-hidden="true">{index + 1}</span>
                  <strong>{step.label}</strong>
                  <small>{step.key}</small>
                </li>
              ))}
            </ol>
            {task.status === 'NEEDS_ATTENTION' && <p className="task-lifecycle-exception">流程已转入人工处理；系统不会盲目重新派发。</p>}
            {task.status === 'CANCELLED' && <p className="task-lifecycle-exception neutral">任务已取消，所有历史仍可查询。</p>}
            {(task.status === 'EXECUTING' || task.status === 'VERIFYING') && (
              <p className="task-lifecycle-exception">这是兼容展示状态；Phase 1 不启用外部发布或验证。</p>
            )}
          </section>

          <section className="panel task-attempts" aria-labelledby="task-attempts-title">
            <div className="panel-head compact">
              <div><h2 id="task-attempts-title">全部 Attempts</h2><p>每次内容准备都有独立身份，历史只追加不覆盖。</p></div>
              <span className="result-count">{task.executions.length} 次</span>
            </div>
            {task.executions.length === 0 ? (
              <div className="empty-state">尚无内容准备 Attempt。</div>
            ) : (
              <div className="task-attempt-list">
                {task.executions.map(execution => {
                  const trust = trustedPreparation(task, execution)
                  return (
                  <article key={execution.id} className={`task-attempt ${execution === latest ? 'latest' : ''}`} aria-label={`Attempt ${execution.attempt}`}>
                    <header>
                      <div>
                        <strong>Attempt {execution.attempt}</strong>
                        <span>#{execution.id} · {execution.stage}</span>
                      </div>
                      <span className={`badge ${EXECUTION_STATUS_CLASSES[execution.status]}`}>{executionStatusLabel(execution)}</span>
                    </header>
                    <dl>
                      <div><dt>开始</dt><dd>{formatTime(execution.created_at)}</dd></div>
                      <div><dt>结束</dt><dd>{execution.finished_at ? formatTime(execution.finished_at) : '—'}</dd></div>
                      <div><dt>请求 checksum</dt><dd title={execution.request_checksum}>{execution.request_checksum.slice(0, 12)}…</dd></div>
                    </dl>
                    {execution.status === 'UNKNOWN' && (
                      <section className="task-unknown-warning" role="alert">
                        <strong>结果不确定，需要人工介入</strong>
                        {trust.kind === 'trusted-unknown-no-tool' ? (
                          <p>无工具端点不具备业务写能力，但模型调用结果未知；人工重试可能重复计费。</p>
                        ) : execution.stage === 'PREPARATION' ? (
                          <><b>无法确认是否外写</b><p>执行身份或资源标记不可信；不要自动重试，需人工核对。</p></>
                        ) : execution.stage === 'PUBLICATION' ? (
                          <><b>无法确认是否外写</b><p>外部发布结果不确定，可能已经发生业务写入；不要重复发布，需人工核对。</p></>
                        ) : (
                          <><b>无法确认是否外写</b><p>外部验证结果不确定，不能据此判断发布状态；不要重复发布，需人工核对。</p></>
                        )}
                      </section>
                    )}
                    {execution.error && <p className="task-attempt-error">{execution.error}</p>}
                    {execution.legacy_result && (
                      <section className="task-legacy-result">
                        <strong>历史结果（未验证）</strong>
                        <pre>{execution.legacy_result.output_text}</pre>
                      </section>
                    )}
                    {executionResultView(execution, trust)}
                    {execution.review_note && <p className="task-review-note"><strong>退回原因：</strong>{execution.review_note}</p>}
                    {execution === latest && canReview && (
                      <div className="task-review-zone">
                        <p>人工批准只会完成这个内容准备 Task；不会发布，也不会验证外部资源。</p>
                        {!showReturn ? (
                          <div role="group" aria-label="准备结果审批">
                            <button className="primary" type="button" onClick={() => void approve()} disabled={busy}>批准准备结果</button>
                            <button type="button" onClick={() => setShowReturn(true)} disabled={busy}>退回重新准备</button>
                          </div>
                        ) : (
                          <div className="return-form">
                            <label htmlFor="return-reason">退回原因</label>
                            <textarea id="return-reason" rows={3} maxLength={2000} value={returnReason} onChange={event => setReturnReason(event.target.value)} disabled={busy} />
                            <div className="review-actions">
                              <button className="primary" type="button" onClick={() => void returnForRevision()} disabled={busy || !returnReason.trim()}>确认退回</button>
                              <button type="button" onClick={() => setShowReturn(false)} disabled={busy}>保留结果</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                  )
                })}
              </div>
            )}
          </section>

          <section className="panel task-event-ledger" aria-labelledby="task-events-title">
            <div className="panel-head compact">
              <div><h2 id="task-events-title">Task events</h2><p>Append-only 审计记录。</p></div>
              <span className="result-count">{task.events.length} 条</span>
            </div>
            {task.events.length === 0 ? <div className="empty-state">暂无事件记录。</div> : (
              <ol>
                {task.events.map(event => (
                  <li key={event.id}>
                    <time dateTime={event.created_at}>{formatTime(event.created_at)}</time>
                    <div><strong>{EVENT_LABELS[event.event_type] ?? event.event_type}</strong><span>{event.actor_type}{event.actor_id ? ` / ${event.actor_id}` : ''}</span></div>
                    <details><summary>事件数据</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="task-detail-rail">
          <section className="panel task-definition" aria-labelledby="task-definition-title">
            <div className="panel-head compact"><div><h2 id="task-definition-title">任务定义</h2><p>执行定义不可在正式 Task 上原地修改。</p></div></div>
            <dl className="brief-list compact-brief">
              <div><dt>为什么做</dt><dd>{task.rationale || '—'}</dd></div>
              <div><dt>预期效果</dt><dd>{task.expected_outcome || '—'}</dd></div>
              <div><dt>准备要求</dt><dd>{task.description || '—'}</dd></div>
              <div><dt>计划开始</dt><dd>{task.scheduled_start ? formatTime(task.scheduled_start) : '立即可调度'}</dd></div>
              <div><dt>Definition checksum</dt><dd className="checksum" title={task.definition_checksum}>{task.definition_checksum}</dd></div>
            </dl>
            <div className="panel-foot"><Link to={`/task-plans/${task.plan_id}`}>在 Plan revision 中修改执行定义</Link></div>
          </section>

          <section className="panel task-plan-identity" aria-labelledby="task-plan-title">
            <div className="panel-head compact"><h2 id="task-plan-title">Plan 身份</h2></div>
            <dl>
              <div><dt>Plan</dt><dd><Link to={`/task-plans/${task.plan_id}`}>#{task.plan_id}</Link></dd></div>
              <div><dt>Task revision</dt><dd>{task.plan_revision}</dd></div>
              <div><dt>当前批准</dt><dd>{task.plan.approved_revision ?? '—'}</dd></div>
              <div><dt>最新 revision</dt><dd>{task.plan.latest_revision}</dd></div>
              <div><dt>Workflow</dt><dd>{task.task_type} / v{task.workflow_version}</dd></div>
              <div><dt>来源</dt><dd>{task.plan.source_kind}</dd></div>
            </dl>
          </section>

          <section className="panel task-dependencies" aria-label="上游任务">
            <div className="panel-head compact"><h2>上游任务</h2><span className="result-count">{task.upstream.length}</span></div>
            {dependencyList(task.upstream, '没有上游依赖。')}
          </section>

          <section className="panel task-dependencies" aria-label="下游任务">
            <div className="panel-head compact"><h2>下游任务</h2><span className="result-count">{task.downstream.length}</span></div>
            {dependencyList(task.downstream, '没有下游任务。')}
          </section>

          <section className="panel task-metadata" aria-labelledby="task-metadata-title">
            <div className="panel-head compact"><div><h2 id="task-metadata-title">内部元数据</h2><p>不改变执行定义或审批对象。</p></div></div>
            <div className="task-metadata-fields">
              <label>负责人<input aria-label="负责人" maxLength={100} value={assignee} onChange={event => { assigneeDraftRef.current = event.target.value; setAssignee(event.target.value) }} disabled={busy} /></label>
              <div className="task-label-field">
                <span>内部标签</span>
                <div className="task-label-editor" role="group" aria-label="内部标签编辑器">
                  {labels.map((label, index) => (
                    <div key={index}>
                      <textarea
                        aria-label={`内部标签 ${index + 1}`}
                        rows={1}
                        value={label}
                        onChange={event => setLabels(current => {
                          const next = current.map((item, itemIndex) => itemIndex === index ? event.target.value : item)
                          labelsDraftRef.current = next
                          return next
                        })}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="quiet"
                        aria-label={`移除内部标签 ${index + 1}`}
                        onClick={() => setLabels(current => {
                          const next = current.filter((_, itemIndex) => itemIndex !== index)
                          labelsDraftRef.current = next
                          return next
                        })}
                        disabled={busy}
                      >移除</button>
                    </div>
                  ))}
                  <button type="button" className="quiet" aria-label="新增内部标签" onClick={() => setLabels(current => {
                    const next = [...current, '']
                    labelsDraftRef.current = next
                    return next
                  })} disabled={busy || labels.length >= 20}>＋ 添加标签</button>
                </div>
                <small>逐项编辑，保存时自动 trim / 去重，最多 20 个。</small>
              </div>
              <label>操作人备注<textarea aria-label="操作人备注" maxLength={2000} value={operatorNote} onChange={event => { operatorNoteDraftRef.current = event.target.value; setOperatorNote(event.target.value) }} disabled={busy} /></label>
            </div>
            <div className="panel-foot task-metadata-actions">
              <span>Task version {task.version}</span>
              {metadataCandidate === null && <small>没有需要保存的变更。</small>}
              <button className="primary" type="button" onClick={() => void saveMetadata()} disabled={busy || metadataCandidate === null}>保存内部元数据</button>
            </div>
          </section>
        </aside>
      </div>
    </main>
  )
}

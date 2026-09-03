import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type TaskBlockerCode, type TaskReadiness, type TaskSourceKind, type TaskStatus, type TaskSummary } from '../api'
import TaskTable from '../components/TaskTable'
import { TASK_STATUS_LABELS } from '../labels'

const STATUS_RANK: Record<TaskStatus, number> = {
  NEEDS_ATTENTION: 0,
  AWAITING_APPROVAL: 1,
  PENDING: 2,
  PREPARING: 3,
  EXECUTING: 4,
  VERIFYING: 5,
  DONE: 6,
  CANCELLED: 7,
}

const STATUS_ORDER = Object.keys(STATUS_RANK) as TaskStatus[]
const BLOCKER_OPTIONS: Array<[TaskBlockerCode, string]> = [
  ['UPSTREAM_NOT_DONE', '等待上游任务'],
  ['SCHEDULED_FOR_FUTURE', '等待计划时间'],
  ['MERCHANT_ARCHIVED', '商户已归档'],
  ['REVISION_INACTIVE', 'Plan revision 已停用'],
]

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export default function TasksOverview() {
  const mountedRef = useRef(false)
  const loadEpochRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [status, setStatus] = useState<TaskStatus | ''>('')
  const [readiness, setReadiness] = useState<TaskReadiness | ''>('')
  const [blockerCode, setBlockerCode] = useState<TaskBlockerCode | ''>('')
  const [sourceKind, setSourceKind] = useState<TaskSourceKind | ''>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    const epoch = ++loadEpochRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    setLoading(true)
    setError('')
    setTasks([])
    api.listAllTasks({
      status: status || undefined,
      readiness: readiness || undefined,
      blocker_code: blockerCode || undefined,
      source_kind: sourceKind || undefined,
    }, controller.signal)
      .then(fresh => {
        if (!mountedRef.current || loadEpochRef.current !== epoch || controller.signal.aborted) return
        setTasks([...fresh].sort((left, right) => STATUS_RANK[left.status] - STATUS_RANK[right.status] || right.id - left.id))
      })
      .catch(nextError => {
        if (!isAbortError(nextError) && mountedRef.current && loadEpochRef.current === epoch) {
          setTasks([])
          setError((nextError as Error).message)
        }
      })
      .finally(() => {
        if (mountedRef.current && loadEpochRef.current === epoch) setLoading(false)
      })
  }, [blockerCode, readiness, sourceKind, status])

  useEffect(() => {
    mountedRef.current = true
    const initialLoad = window.setTimeout(load, 0)
    return () => {
      window.clearTimeout(initialLoad)
      mountedRef.current = false
      loadEpochRef.current += 1
      loadControllerRef.current?.abort()
    }
  }, [load])

  const changeReadiness = (next: TaskReadiness | '') => {
    setReadiness(next)
    if (next !== 'BLOCKED') setBlockerCode('')
  }

  return (
    <main aria-labelledby="tasks-overview-title" className="tasks-overview-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">EXECUTION / 跨商户任务</p>
          <h1 id="tasks-overview-title">任务总览</h1>
          <p className="page-summary">查询正式 Task、阻塞原因和审批状态；列表只显示首个阻塞条件。</p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head compact">
          <div>
            <p className="section-code">ACTION QUEUE</p>
            <h2>执行队列</h2>
          </div>
          <span className="result-count">{loading ? '正在查询…' : `返回 ${tasks.length} 项`}</span>
        </div>

        <div className="table-toolbar task-query-toolbar" role="group" aria-label="任务查询条件">
          <label>
            <span>权威状态</span>
            <select aria-label="任务状态" value={status} onChange={event => setStatus(event.target.value as TaskStatus | '')}>
              <option value="">全部状态</option>
              {STATUS_ORDER.map(value => <option key={value} value={value}>{TASK_STATUS_LABELS[value]}</option>)}
            </select>
          </label>
          <label>
            <span>就绪状态</span>
            <select aria-label="任务就绪状态" value={readiness} onChange={event => changeReadiness(event.target.value as TaskReadiness | '')}>
              <option value="">全部</option>
              <option value="READY">可执行</option>
              <option value="BLOCKED">被阻塞</option>
            </select>
          </label>
          <label>
            <span>阻塞原因</span>
            <select aria-label="任务阻塞原因" value={blockerCode} disabled={readiness !== 'BLOCKED'} onChange={event => setBlockerCode(event.target.value as TaskBlockerCode | '')}>
              <option value="">全部阻塞原因</option>
              {BLOCKER_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span>来源</span>
            <select aria-label="任务来源" value={sourceKind} onChange={event => setSourceKind(event.target.value as TaskSourceKind | '')}>
              <option value="">全部来源</option>
              <option value="AGENT">Agent Plan</option>
              <option value="OPERATOR">操作人新增</option>
              <option value="MIGRATION">历史迁移</option>
            </select>
          </label>
          <button type="button" onClick={load} disabled={loading}>刷新</button>
        </div>

        {error ? (
          <section className="task-query-error" role="alert">
            <p>{error}</p>
            <button type="button" onClick={load}>重试查询</button>
          </section>
        ) : tasks.length > 0 ? (
          <TaskTable tasks={tasks} showMerchant />
        ) : !loading ? (
          <div className="empty-state">当前查询条件下没有任务。</div>
        ) : null}
      </section>
    </main>
  )
}

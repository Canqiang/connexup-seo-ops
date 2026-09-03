import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api, type AuditSnapshot, type Merchant, type PlanTaskSummary, type Run, type TaskPlan, type TaskWorkflowStatus } from '../api'
import AuditReport from '../components/AuditReport'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS } from '../labels'
import { reportForDisplay } from '../reportDisplay'
import { formatRunDuration } from '../runPresentation'
import { isTaskPlan } from '../taskPlan'

const WORKFLOW_STATUS_LABELS: Record<TaskWorkflowStatus, string> = {
  PENDING: '待办',
  PREPARING: '准备中',
  AWAITING_APPROVAL: '待内容审批',
  EXECUTING: '执行中',
  VERIFYING: '验证中',
  DONE: '已完成',
  NEEDS_ATTENTION: '需要人工处理',
  CANCELLED: '已取消',
}

const WORKFLOW_STATUS_CLASSES: Record<TaskWorkflowStatus, string> = {
  PENDING: 'todo',
  PREPARING: 'doing',
  AWAITING_APPROVAL: 'todo',
  EXECUTING: 'doing',
  VERIFYING: 'doing',
  DONE: 'done',
  NEEDS_ATTENTION: 'failed',
  CANCELLED: 'cancelled',
}

type PlanReadState = 'loading' | 'ready' | 'missing' | 'error'

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function currentPlanTasks(plan: TaskPlan, rows: PlanTaskSummary[]): PlanTaskSummary[] {
  const expectedKeys = plan.current_revision.payload.tasks.map(item => item.key)
  const expected = new Set(expectedKeys)
  if (expected.size !== expectedKeys.length) throw new Error('当前批准 Plan 包含重复 Task key，请刷新 Plan')
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.task_key)) throw new Error(`正式 Task 数据包含重复 key：${row.task_key}`)
    seen.add(row.task_key)
    if (row.plan_id !== plan.id || !row.plan || row.plan.id !== plan.id) {
      throw new Error('正式 Task 数据与当前 Plan 不一致，请刷新 Plan')
    }
    if (row.plan.approved_revision !== plan.current_revision.revision) {
      throw new Error('正式 Task 所属批准 revision 已变化，请刷新 Plan')
    }
    if (row.plan_revision > plan.current_revision.revision) {
      throw new Error('正式 Task revision 晚于当前批准 Plan，请刷新 Plan')
    }
    if (row.plan.latest_revision !== plan.latest_revision
      || row.plan.state !== plan.state
      || row.plan.source_kind !== plan.source_kind) {
      throw new Error('正式 Task 所属 Plan 已变化，请刷新 Plan')
    }
    if (!expected.has(row.task_key) && row.status !== 'CANCELLED') {
      throw new Error(`正式 Task 数据包含当前批准 Plan 之外的 key：${row.task_key}，请刷新 Plan`)
    }
  }
  const byKey = new Map(rows.map(row => [row.task_key, row]))
  return expectedKeys.map(key => {
    const row = byKey.get(key)
    if (!row) throw new Error(`正式 Task 数据缺少当前批准 key：${key}，请刷新 Plan`)
    return row
  })
}

export default function RunDetail() {
  const { id } = useParams()
  return <RunDetailPage key={id ?? 'invalid'} runId={Number(id)} />
}

function RunDetailPage({ runId }: { runId: number }) {
  const validRunId = Number.isInteger(runId) && runId > 0
  const mountedRef = useRef(false)
  const planEpochRef = useRef(0)
  const planControllerRef = useRef<AbortController | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<PlanTaskSummary[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [planState, setPlanState] = useState<PlanReadState>(validRunId ? 'loading' : 'error')
  const [audit, setAudit] = useState<AuditSnapshot | null>(null)
  const [runError, setRunError] = useState(validRunId ? '' : '分析 ID 无效')
  const [merchantError, setMerchantError] = useState('')
  const [planError, setPlanError] = useState(validRunId ? '' : '分析 ID 无效')
  const [taskError, setTaskError] = useState('')
  const [auditError, setAuditError] = useState('')

  const loadPlan = useCallback(async () => {
    const epoch = ++planEpochRef.current
    planControllerRef.current?.abort()
    const controller = new AbortController()
    planControllerRef.current = controller
    setPlan(null)
    setTasks([])
    setTasksLoading(false)
    setPlanState('loading')
    setPlanError('')
    setTaskError('')
    try {
      const fresh = await api.getRunTaskPlan(runId, controller.signal)
      if (!mountedRef.current || planEpochRef.current !== epoch || controller.signal.aborted) return
      if (fresh === null) {
        setPlanState('missing')
        return
      }
      if (!isTaskPlan(fresh)
        || fresh.current_revision.plan_id !== fresh.id
        || fresh.latest_revision !== fresh.current_revision.revision
        || fresh.source_run_id !== runId) {
        throw new Error('Task Plan 响应格式或来源无效')
      }
      setPlan(fresh)
      setPlanState('ready')

      if (fresh.current_revision.decision_state !== 'APPROVED') return
      if (fresh.approved_revision !== fresh.current_revision.revision) {
        setTaskError('当前批准 revision 身份不一致，未载入正式 Task')
        return
      }
      setTasksLoading(true)
      try {
        const rows = await api.listPlanTasks(fresh.id, controller.signal)
        if (!mountedRef.current || planEpochRef.current !== epoch || controller.signal.aborted) return
        setTasks(currentPlanTasks(fresh, rows))
      } catch (error) {
        if (isAbortError(error) || !mountedRef.current || planEpochRef.current !== epoch) return
        setTasks([])
        setTaskError((error as Error).message)
      } finally {
        if (mountedRef.current && planEpochRef.current === epoch) setTasksLoading(false)
      }
    } catch (error) {
      if (isAbortError(error) || !mountedRef.current || planEpochRef.current !== epoch) return
      setPlan(null)
      setTasks([])
      setPlanState('error')
      setPlanError((error as Error).message)
    }
  }, [runId])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      planEpochRef.current += 1
      planControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!validRunId) return
    const runController = new AbortController()
    const auditController = new AbortController()
    let runAccepted = false

    api.getRun(runId, runController.signal)
      .then(fresh => {
        if (!mountedRef.current || runController.signal.aborted) return null
        if (fresh.id !== runId) throw new Error('分析响应与当前路由不一致')
        runAccepted = true
        setRun(fresh)
        setRunError('')
        return api.getMerchant(fresh.merchant_id, runController.signal)
          .then(freshMerchant => ({ freshMerchant, expectedId: fresh.merchant_id }))
      })
      .then(result => {
        if (!result || !mountedRef.current || runController.signal.aborted) return
        if (result.freshMerchant.id !== result.expectedId) throw new Error('商户响应与分析记录不一致')
        setMerchant(result.freshMerchant)
        setMerchantError('')
      })
      .catch(error => {
        if (isAbortError(error) || !mountedRef.current || runController.signal.aborted) return
        if (runAccepted) setMerchantError((error as Error).message)
        else setRunError((error as Error).message)
      })

    api.getRunAudit(runId, auditController.signal)
      .then(fresh => {
        if (!mountedRef.current || auditController.signal.aborted) return
        if (fresh !== null && fresh.run_id !== runId) throw new Error('Audit 响应与当前分析不一致')
        setAudit(fresh)
        setAuditError('')
      })
      .catch(error => {
        if (isAbortError(error) || !mountedRef.current || auditController.signal.aborted) return
        setAuditError((error as Error).message)
      })

    const planTimer = window.setTimeout(() => void loadPlan(), 0)
    return () => {
      window.clearTimeout(planTimer)
      runController.abort()
      auditController.abort()
    }
  }, [loadPlan, runId, validRunId])

  if (!run) {
    return (
      <main aria-label="分析报告">
        <p className="breadcrumb"><Link to="/">← 商户台账</Link></p>
        {runError ? <p className="error">{runError}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const decision = plan?.current_revision.decision_state
  const draftCount = plan?.current_revision.payload.tasks.length ?? 0

  return (
    <main aria-label="分析报告" className="run-report-page">
      <header className="run-context-bar">
        <Link
          to={`/merchants/${run.merchant_id}`}
          className="back-button"
          aria-label={`返回${merchant?.name ?? '商户工作区'}`}
        >
          <span aria-hidden="true">←</span>
          <span>{merchant?.name ?? '商户工作区'}</span>
        </Link>
        <div className="run-identity">
          <h1 id="run-detail-title">{formatTime(run.created_at)} 分析报告</h1>
        </div>
        <div className="run-summary" aria-label="分析运行摘要">
          <span className={`badge ${run.status}`}>{RUN_STATUS_LABELS[run.status]}</span>
          <span>{run.trigger_kind === 'auto' ? '自动触发' : '手动触发'}</span>
          <span>{formatRunDuration(run.created_at, run.finished_at)}</span>
        </div>
      </header>
      {runError && <p className="error">{runError}</p>}
      {merchantError && <p className="error">{merchantError}</p>}
      {auditError && <p className="error">{auditError}</p>}
      {run.error && <p className="error">{run.error}</p>}

      <div className="run-review-grid">
        <section className="panel report-panel" aria-label="报告正文">
          {audit
            ? <AuditReport snapshot={audit} />
            : run.report_text
            ? <div className="report"><ReactMarkdown>{reportForDisplay(run.report_text)}</ReactMarkdown></div>
            : <div className="empty-state">这次分析还没有返回报告。</div>}
        </section>

        <aside className="panel run-task-panel" aria-labelledby="run-tasks-title">
          <div className="panel-head compact">
            <h2 id="run-tasks-title">本次生成任务</h2>
            <span className="result-count">{tasks.length} 项</span>
          </div>
          {run.status === 'succeeded' && planState === 'loading' && (
            <div className="empty-state compact-empty">正在读取 Task Plan…</div>
          )}
          {run.status === 'succeeded' && planState === 'error' && (
            <section className="plan-load-error" role="alert" aria-label="Task Plan 读取失败">
              <strong>无法读取 Task Plan</strong>
              <p>{planError}</p>
              <button type="button" onClick={() => void loadPlan()}>重试读取 Plan</button>
            </section>
          )}
          {run.status === 'succeeded' && planState === 'ready' && plan && (
            <section className={`plan-decision ${decision === 'APPROVED' ? 'approved' : ''}`} aria-label="Plan 审批">
              <strong>
                {decision === 'APPROVED'
                  ? `Plan Revision ${plan.current_revision.revision} 已批准`
                  : decision === 'REJECTED'
                    ? `Plan Revision ${plan.current_revision.revision} 已拒绝`
                    : `Plan Revision ${plan.current_revision.revision} 待审批`}
              </strong>
              <p>
                {decision === 'DRAFT'
                  ? plan.approved_revision == null
                    ? `当前 Plan 草稿包含 ${draftCount} 项；尚未物化正式 Task。`
                    : `当前 Plan 草稿包含 ${draftCount} 项；Revision ${plan.approved_revision} 的历史 Task 请到任务队列查看。`
                  : decision === 'APPROVED'
                    ? '完整 revision 已冻结，正式 Task 已进入运营队列。'
                    : `当前 Plan 包含 ${draftCount} 项；该 revision 未获批准，不会创建正式 Task。`}
              </p>
              <Link className="plan-review-link" to={`/task-plans/${plan.id}`}>查看并编辑 Plan</Link>
            </section>
          )}
          {run.status === 'succeeded' && planState === 'missing' && (
            <div className="empty-state compact-empty">本次分析没有生成可编辑 Task Plan。</div>
          )}
          {taskError && (
            <section className="plan-load-error" role="alert" aria-label="正式 Task 读取失败">
              <p>{taskError}</p>
              <button type="button" onClick={() => void loadPlan()}>重试读取 Plan</button>
            </section>
          )}
          {decision === 'APPROVED' && tasks.length > 0 ? (
            <ul className="generated-task-list">
              {tasks.map(task => (
                <li key={task.id}>
                  <Link
                    to={`/tasks/${task.id}`}
                    state={{ taskOrigin: { kind: 'run', from: `/runs/${run.id}` } }}
                  >
                    {task.title}
                  </Link>
                  <div>
                    <span className="badge cat">{task.category ? CATEGORY_LABELS[task.category] ?? task.category : '未分类'}</span>
                    <span className={`badge ${WORKFLOW_STATUS_CLASSES[task.status]}`}>{WORKFLOW_STATUS_LABELS[task.status]}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : decision === 'APPROVED' && tasksLoading ? (
            <div className="empty-state compact-empty">正在载入当前批准 revision 的正式 Task。</div>
          ) : decision === 'APPROVED' && !taskError ? (
            <div className="empty-state compact-empty">当前批准 revision 暂无可显示的正式 Task。</div>
          ) : null}
          <div className="panel-foot">
            <Link to={`/merchants/${run.merchant_id}`} className="panel-link">查看商户任务 →</Link>
          </div>
        </aside>
      </div>
    </main>
  )
}

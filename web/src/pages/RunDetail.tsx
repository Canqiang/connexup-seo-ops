import { useEffect, useState } from 'react'
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

export default function RunDetail() {
  const { id } = useParams()
  const runId = Number(id)
  const [run, setRun] = useState<Run | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<PlanTaskSummary[]>([])
  const [plan, setPlan] = useState<TaskPlan | null>(null)
  const [planLoaded, setPlanLoaded] = useState(false)
  const [audit, setAudit] = useState<AuditSnapshot | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api.getRun(runId)
      .then(fresh => {
        setRun(fresh)
        return api.getMerchant(fresh.merchant_id)
      })
      .then(setMerchant)
      .catch(e => setError((e as Error).message))
    api.getRunTaskPlan(runId)
      .then(freshPlan => {
        if (freshPlan !== null && !isTaskPlan(freshPlan)) {
          throw new Error('Task Plan 响应格式无效')
        }
        const validPlan = isTaskPlan(freshPlan) ? freshPlan : null
        setPlan(validPlan)
        setPlanLoaded(true)
        if (validPlan?.approved_revision != null) {
          return api.listPlanTasks(validPlan.id).then(setTasks)
        }
        setTasks([])
      })
      .catch(e => {
        setPlanLoaded(true)
        setError((e as Error).message)
      })
    api.getRunAudit(runId).then(setAudit).catch(e => setError((e as Error).message))
  }, [runId])

  if (!run) {
    return (
      <main aria-label="分析报告">
        <p className="breadcrumb"><Link to="/">← 商户台账</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

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
      {error && <p className="error">{error}</p>}
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
            <span className="result-count">{plan?.current_revision.payload.tasks.length ?? 0} 项</span>
          </div>
          {run.status === 'succeeded' && !planLoaded && (
            <div className="empty-state compact-empty">正在读取 Task Plan…</div>
          )}
          {run.status === 'succeeded' && planLoaded && plan && (
            <section className={`plan-decision ${plan.current_revision.decision_state === 'APPROVED' ? 'approved' : ''}`} aria-label="Plan 审批">
              <strong>
                {plan.current_revision.decision_state === 'APPROVED'
                  ? `Plan Revision ${plan.current_revision.revision} 已批准`
                  : plan.current_revision.decision_state === 'REJECTED'
                    ? `Plan Revision ${plan.current_revision.revision} 已拒绝`
                    : `Plan Revision ${plan.current_revision.revision} 待审批`}
              </strong>
              <p>
                {plan.current_revision.decision_state === 'DRAFT'
                  ? plan.approved_revision == null
                    ? '尚未物化正式 Task；请先逐项审阅并保存完整 Plan。'
                    : `Revision ${plan.approved_revision} 仍生效；新草稿批准前不会改写现有 Task。`
                  : plan.current_revision.decision_state === 'APPROVED'
                    ? '完整 revision 已冻结，正式 Task 已进入运营队列。'
                    : '该 revision 未获批准，不会创建正式 Task。'}
              </p>
              <Link className="plan-review-link" to={`/task-plans/${plan.id}`}>查看并编辑 Plan</Link>
            </section>
          )}
          {run.status === 'succeeded' && planLoaded && !plan && (
            <div className="empty-state compact-empty">本次分析没有生成可编辑 Task Plan。</div>
          )}
          {plan?.approved_revision != null && tasks.length > 0 ? (
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
          ) : plan?.approved_revision != null ? (
            <div className="empty-state compact-empty">已批准 Plan 正在载入正式 Task。</div>
          ) : null}
          <div className="panel-foot">
            <Link to={`/merchants/${run.merchant_id}`} className="panel-link">查看商户任务 →</Link>
          </div>
        </aside>
      </div>
    </main>
  )
}

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api, type AuditSnapshot, type Merchant, type Run, type Task } from '../api'
import AuditReport from '../components/AuditReport'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'
import { reportForDisplay } from '../reportDisplay'
import { formatRunDuration } from '../runPresentation'

export default function RunDetail() {
  const { id } = useParams()
  const runId = Number(id)
  const [run, setRun] = useState<Run | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [audit, setAudit] = useState<AuditSnapshot | null>(null)
  const [error, setError] = useState('')
  const [approving, setApproving] = useState(false)

  useEffect(() => {
    api.getRun(runId)
      .then(fresh => {
        setRun(fresh)
        return api.getMerchant(fresh.merchant_id)
      })
      .then(setMerchant)
      .catch(e => setError((e as Error).message))
    api.listRunTasks(runId).then(setTasks).catch(() => {})
    api.getRunAudit(runId).then(setAudit).catch(e => setError((e as Error).message))
  }, [runId])

  const approvePlan = async () => {
    setApproving(true)
    try {
      setRun(await api.approvePlan(runId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setApproving(false)
    }
  }

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
            <span className="result-count">{tasks.length} 项</span>
          </div>
          {run.status === 'succeeded' && tasks.length > 0 && (
            <section className={`plan-decision ${run.plan_approved_at ? 'approved' : ''}`} aria-label="Plan 审批">
              {run.plan_approved_at ? (
                <>
                  <strong>Plan 已确认</strong>
                  <p>这些任务可以交给 Agent 执行。</p>
                </>
              ) : (
                <>
                  <strong>等待运营确认</strong>
                  <p>确认后，这些任务才可交给 Agent 执行。</p>
                  <button className="primary" onClick={approvePlan} disabled={approving}>
                    {approving ? '确认中…' : '确认 Plan'}
                  </button>
                </>
              )}
            </section>
          )}
          {tasks.length > 0 ? (
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
                    <span className={`badge ${task.status}`}>{TASK_STATUS_LABELS[task.status]}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="empty-state compact-empty">本次分析没有生成任务。</div>
          )}
          <div className="panel-foot">
            <Link to={`/merchants/${run.merchant_id}`} className="panel-link">查看商户任务 →</Link>
          </div>
        </aside>
      </div>
    </main>
  )
}

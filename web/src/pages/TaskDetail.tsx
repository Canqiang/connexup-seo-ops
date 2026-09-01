import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type Merchant, type Task, type TaskExecution, type TaskStatus } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS } from '../labels'

const LABELS: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }

type TaskOrigin = {
  kind: 'merchant' | 'tasks' | 'run'
  from: string
}

export default function TaskDetail() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const taskId = Number(id)
  const [task, setTask] = useState<Task | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [execution, setExecution] = useState<TaskExecution | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showReturn, setShowReturn] = useState(false)
  const [returnReason, setReturnReason] = useState('')

  useEffect(() => {
    api.getTask(taskId)
      .then(t => {
        setTask(t)
        return Promise.all([api.getMerchant(t.merchant_id), api.getTaskExecution(taskId)])
      })
      .then(([nextMerchant, nextExecution]) => {
        setMerchant(nextMerchant)
        setExecution(nextExecution)
      })
      .catch(e => setError((e as Error).message))
  }, [taskId])

  useEffect(() => {
    if (execution?.status !== 'running') return
    const timer = window.setInterval(() => {
      api.getTaskExecution(taskId)
        .then(next => next && setExecution(next))
        .catch(e => setError((e as Error).message))
    }, 3000)
    return () => window.clearInterval(timer)
  }, [execution?.status, taskId])

  const origin = (location.state as { taskOrigin?: TaskOrigin } | null)?.taskOrigin

  const backLabel = origin?.kind === 'tasks'
    ? '返回任务总览'
    : origin?.kind === 'run'
      ? '返回分析报告'
      : `返回${merchant?.name ?? '商户工作区'}`

  const goBack = () => {
    if (origin?.from) {
      navigate(origin.from)
      return
    }
    navigate(task ? `/merchants/${task.merchant_id}` : '/tasks')
  }

  const transition = async (status: TaskStatus) => {
    try {
      setTask(await api.patchTask(taskId, { status }))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const assignToAgent = async () => {
    setBusy(true)
    try {
      const nextExecution = await api.executeTask(taskId)
      setExecution(nextExecution)
      setTask(await api.getTask(taskId))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const approve = async () => {
    setBusy(true)
    try {
      const result = await api.approveTaskExecution(taskId)
      setTask(result.task)
      setExecution(result.execution)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const returnForRevision = async () => {
    if (!returnReason.trim()) return
    setBusy(true)
    try {
      setExecution(await api.returnTaskExecution(taskId, returnReason.trim()))
      setShowReturn(false)
      setReturnReason('')
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (!task) {
    return (
      <main aria-label="任务详情">
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const planLocked = task.status === 'todo' && task.source_run_id != null && task.source_plan_approved === false
  const canAssign = !planLocked && (
    (task.status === 'todo' && execution == null)
    || (task.status === 'doing' && execution == null)
    || (task.status === 'doing' && (execution?.status === 'failed' || execution?.status === 'returned'))
  )
  const executionLabel = execution?.status === 'running'
    ? 'Agent 执行中'
    : execution?.status === 'ready'
      ? '待审批'
      : execution?.status === 'failed'
        ? '执行失败'
        : execution?.status === 'returned'
          ? '已退回'
          : LABELS[task.status]

  return (
    <main aria-label="任务详情" className="task-detail-page">
      <header className="task-context-bar" aria-label="任务上下文">
        <div className="task-context-top">
          <button type="button" className="back-button" onClick={goBack} aria-label={backLabel}>
            <span aria-hidden="true">←</span>
            <span>{origin?.kind === 'tasks' ? '任务总览' : origin?.kind === 'run' ? '分析报告' : merchant?.name ?? '商户工作区'}</span>
          </button>
          <div className="task-summary" role="group" aria-label="任务状态与来源">
            <span className={`badge ${execution?.status ?? task.status}`}>{executionLabel}</span>
            {task.category && <span className="badge cat">{CATEGORY_LABELS[task.category] ?? task.category}</span>}
            {task.source_run_id != null && <Link to={`/runs/${task.source_run_id}`}>来源：分析报告</Link>}
          </div>
        </div>
        <div className="task-context-main">
          <div className="task-identity">
            <h1 id="task-detail-title">{task.title}</h1>
          </div>
          {(canAssign || planLocked || (task.status === 'todo' && execution == null)) && (
            <div className="task-actions" role="group" aria-label="任务操作">
              {planLocked && <span className="plan-lock-label">等待确认 Plan</span>}
              {canAssign && (
                <button className="primary" onClick={assignToAgent} disabled={busy}>
                  {execution?.status === 'failed' || execution?.status === 'returned' ? '重新交给 Agent' : '交给 Agent 执行'}
                </button>
              )}
              {task.status === 'todo' && execution == null && (
                <button className="quiet" onClick={() => transition('cancelled')}>取消任务</button>
              )}
            </div>
          )}
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <div className="task-workflow-stack">
        <section className="panel agent-result-panel" aria-labelledby="agent-result-title">
          <div className="panel-head compact">
            <div>
              <h2 id="agent-result-title">Agent 执行结果</h2>
              <p>结果由 Agent 自动回填；人工只负责批准或退回。</p>
            </div>
          </div>
          {!execution && (
            <div className="agent-empty-state">
              <strong>尚未交给 Agent</strong>
              <p>{planLocked ? '先在分析报告中确认 Plan，之后即可执行。' : '确认任务后，将由已配置的执行 Agent 产出结果。'}</p>
            </div>
          )}
          {execution?.status === 'running' && (
            <div className="agent-progress" role="status">
              <span className="agent-progress-dot" aria-hidden="true" />
              <div><strong>Agent 正在执行</strong><p>完成后结果会自动出现在这里，无需人工填写证据。</p></div>
            </div>
          )}
          {execution?.status === 'failed' && (
            <div className="agent-message error-state">
              <strong>本次执行失败</strong>
              <p>{execution.error || 'Core AI 未返回可用结果。'}</p>
            </div>
          )}
          {execution?.status === 'returned' && (
            <div className="agent-message returned-state">
              <strong>已退回 Agent 重做</strong>
              <p>{execution.review_note}</p>
            </div>
          )}
          {(execution?.status === 'ready' || execution?.status === 'approved') && (
            <div className="agent-output-wrap">
              <div className="agent-output-meta">
                <span>{execution.status === 'approved' ? '已批准' : '待审批'}</span>
                <span>第 {execution.attempt} 次执行 · {formatTime(execution.finished_at ?? execution.created_at)}</span>
              </div>
              <pre className="agent-output">{execution.output_text || 'Agent 未返回文本结果。'}</pre>
              {execution.status === 'ready' && (
                <div className="review-zone">
                  {!showReturn ? (
                    <div className="review-actions" role="group" aria-label="执行结果审批">
                      <button className="primary" onClick={approve} disabled={busy}>批准完成</button>
                      <button onClick={() => setShowReturn(true)} disabled={busy}>退回重做</button>
                    </div>
                  ) : (
                    <div className="return-form">
                      <label htmlFor="return-reason">退回原因</label>
                      <textarea id="return-reason" rows={3} value={returnReason} onChange={e => setReturnReason(e.target.value)} placeholder="说明需要 Agent 修改的内容" />
                      <div className="review-actions">
                        <button className="primary" onClick={returnForRevision} disabled={busy || !returnReason.trim()}>确认退回</button>
                        <button onClick={() => setShowReturn(false)}>取消</button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel detail-panel" aria-labelledby="task-brief-title">
          <div className="panel-head compact">
            <div>
              <h2 id="task-brief-title">任务说明</h2>
              <p>Agent 执行所依据的目标和背景。</p>
            </div>
          </div>
          <dl className="brief-list compact-brief">
            <div><dt>为什么做</dt><dd>{task.rationale || <span className="muted">未填写</span>}</dd></div>
            <div><dt>预期效果</dt><dd>{task.expected_outcome || <span className="muted">未填写</span>}</dd></div>
            {task.description && <div><dt>执行要求</dt><dd>{task.description}</dd></div>}
          </dl>
          <div className="panel-foot metadata">创建于 {formatTime(task.created_at)}{task.completed_at ? ` · 完成于 ${formatTime(task.completed_at)}` : ''}</div>
        </section>
      </div>
    </main>
  )
}

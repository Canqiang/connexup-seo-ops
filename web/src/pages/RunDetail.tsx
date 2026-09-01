import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api, type Run, type Task } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'

export default function RunDetail() {
  const { id } = useParams()
  const runId = Number(id)
  const [run, setRun] = useState<Run | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    api.getRun(runId).then(setRun).catch(e => setError((e as Error).message))
    api.listRunTasks(runId).then(setTasks).catch(() => {})
  }, [runId])

  if (!run) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to={`/merchants/${run.merchant_id}`}>← 返回商户</Link></p>
      <h1>分析 #{run.id}</h1>
      <p>
        <span className={`badge ${run.status}`}>{RUN_STATUS_LABELS[run.status]}</span>
        <span className="muted">{run.trigger_kind === 'auto' ? '自动' : '手动'} · 发起于 {formatTime(run.created_at)}{run.finished_at ? ` · 结束于 ${formatTime(run.finished_at)}` : ''}</span>
      </p>
      {error && <p className="error">{error}</p>}
      {run.error && <p className="error">{run.error}</p>}

      {tasks.length > 0 && (
        <>
          <h2>本次生成的任务（{tasks.length}）</h2>
          <ul className="list">
            {tasks.map(t => (
              <li key={t.id} className="task-row">
                <div className="task-line1">
                  {t.category && <span className="badge cat">{CATEGORY_LABELS[t.category] ?? t.category}</span>}
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  <span className={`badge ${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span>
                </div>
                {t.expected_outcome && (
                  <div className="task-line2 muted"><span>预期：{t.expected_outcome}</span></div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>报告</h2>
      {run.report_text
        ? <div className="report"><ReactMarkdown>{run.report_text}</ReactMarkdown></div>
        : <p className="muted">（暂无报告）</p>}
    </main>
  )
}

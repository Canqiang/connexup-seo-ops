import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import { api, type Run, type Task, type TaskStatus } from '../api'
import TaskTable from '../components/TaskTable'
import { formatTime } from '../format'
import { RUN_STATUS_LABELS } from '../labels'
import { reportForDisplay } from '../reportDisplay'

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

  const transitionTask = async (taskId: number, status: TaskStatus) => {
    try {
      await api.patchTask(taskId, { status })
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      api.listRunTasks(runId).then(setTasks).catch(() => {})
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
    <main aria-labelledby="run-detail-title">
      <p className="breadcrumb"><Link to={`/merchants/${run.merchant_id}`}>← 返回商户工作区</Link></p>
      <header className="page-head">
        <div>
          <p className="eyebrow">AGENT RUN / 分析记录</p>
          <h1 id="run-detail-title">分析 #{run.id}</h1>
          <div className="headline-meta">
            <span className={`badge ${run.status}`}>{RUN_STATUS_LABELS[run.status]}</span>
            <span className="muted">{run.trigger_kind === 'auto' ? '自动触发' : '手动触发'} · 发起于 {formatTime(run.created_at)}{run.finished_at ? ` · 结束于 ${formatTime(run.finished_at)}` : ''}</span>
          </div>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      {run.error && <p className="error">{run.error}</p>}

      {tasks.length > 0 && (
        <section className="panel" aria-labelledby="run-tasks-title">
          <div className="panel-head compact">
            <div>
              <p className="section-code">PROPOSED ACTIONS</p>
              <h2 id="run-tasks-title">本次生成的任务</h2>
            </div>
            <span className="result-count">{tasks.length} 项</span>
          </div>
          <TaskTable tasks={tasks} showSource={false} onAction={transitionTask} />
        </section>
      )}

      <section className="panel report-panel" aria-labelledby="report-body-title">
        <div className="panel-head compact">
          <div>
            <p className="section-code">ANALYSIS REPORT</p>
            <h2 id="report-body-title">报告正文</h2>
          </div>
        </div>
        {run.report_text
          ? <div className="report"><ReactMarkdown>{reportForDisplay(run.report_text)}</ReactMarkdown></div>
          : <div className="empty-state">这次分析还没有返回报告。</div>}
      </section>
    </main>
  )
}

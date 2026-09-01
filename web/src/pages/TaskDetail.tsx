import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Task, type TaskStatus } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS } from '../labels'

const NEXT: Record<TaskStatus, TaskStatus[]> = {
  todo: ['doing', 'cancelled'],
  doing: ['done', 'cancelled'],
  done: [],
  cancelled: [],
}
const LABELS: Record<TaskStatus, string> = { todo: '待办', doing: '进行中', done: '已完成', cancelled: '已取消' }

export default function TaskDetail() {
  const { id } = useParams()
  const taskId = Number(id)
  const [task, setTask] = useState<Task | null>(null)
  const [evidence, setEvidence] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getTask(taskId)
      .then(t => { setTask(t); setEvidence(t.evidence_note ?? '') })
      .catch(e => setError((e as Error).message))
  }, [taskId])

  const transition = async (status: TaskStatus) => {
    try {
      setTask(await api.patchTask(taskId, { status }))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const saveEvidence = async () => {
    try {
      setTask(await api.patchTask(taskId, { evidence_note: evidence }))
      setError('')
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!task) {
    return (
      <main aria-label="任务详情">
        <p className="breadcrumb"><Link to="/tasks">← 任务总览</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main aria-labelledby="task-detail-title">
      <p className="breadcrumb"><Link to="/tasks">← 任务总览</Link> <span>/</span> <Link to={`/merchants/${task.merchant_id}`}>所属商户</Link></p>
      <header className="page-head task-detail-head">
        <div>
          <p className="eyebrow">TASK #{task.id} / 执行工单</p>
          <h1 id="task-detail-title">{task.title}</h1>
          <div className="headline-meta">
            <span className={`badge ${task.status}`}>{LABELS[task.status]}</span>
            {task.category && <span className="badge cat">{CATEGORY_LABELS[task.category] ?? task.category}</span>}
            {task.source_run_id != null && <Link to={`/runs/${task.source_run_id}`} className="muted">来自分析 #{task.source_run_id}</Link>}
          </div>
        </div>
        {NEXT[task.status].length > 0 && (
          <div className="page-actions">
            {NEXT[task.status].map(s => (
              <button key={s} className={s === 'doing' || s === 'done' ? 'primary' : ''} onClick={() => transition(s)}>
                {s === 'doing' ? '开始执行' : s === 'done' ? '标记完成' : '取消任务'}
              </button>
            ))}
          </div>
        )}
      </header>
      {error && <p className="error">{error}</p>}

      <div className="detail-grid">
        <section className="panel detail-panel" aria-labelledby="task-brief-title">
          <div className="panel-head compact">
            <div>
              <p className="section-code">TASK BRIEF</p>
              <h2 id="task-brief-title">任务说明</h2>
            </div>
          </div>
          <dl className="brief-list">
            <div>
              <dt>为什么做</dt>
              <dd>{task.rationale || <span className="muted">未填写</span>}</dd>
            </div>
            <div>
              <dt>预期效果</dt>
              <dd>{task.expected_outcome || <span className="muted">未填写</span>}</dd>
            </div>
            {task.description && (
              <div>
                <dt>补充描述</dt>
                <dd>{task.description}</dd>
              </div>
            )}
          </dl>
          <div className="panel-foot metadata">创建于 {formatTime(task.created_at)}{task.completed_at ? ` · 完成于 ${formatTime(task.completed_at)}` : ''}</div>
        </section>

        <section className="panel evidence-panel" aria-labelledby="task-evidence-title">
          <div className="panel-head compact">
            <div>
              <p className="section-code">EXECUTION EVIDENCE</p>
              <h2 id="task-evidence-title">执行证据</h2>
              <p>记录实际做了什么、结果如何，以及可回读的链接或路径。</p>
            </div>
          </div>
          <div className="evidence-editor">
            <textarea
              aria-label="执行证据"
              rows={9}
              value={evidence}
              onChange={e => setEvidence(e.target.value)}
              placeholder="例如：已更新 GBP 营业时间；回读链接：https://…"
            />
            <div className="editor-actions">
              <button onClick={saveEvidence} className="primary">保存证据</button>
              {saved && <span className="saved-mark" role="status">已保存</span>}
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}

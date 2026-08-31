import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Task, type TaskStatus } from '../api'

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
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to={`/merchants/${task.merchant_id}`}>← 返回商户</Link></p>
      <h1>{task.title}</h1>
      <p><span className={`badge ${task.status}`}>{LABELS[task.status]}</span></p>
      {error && <p className="error">{error}</p>}

      <h2>为什么做</h2>
      <p>{task.rationale || <span className="muted">（未填写）</span>}</p>
      {task.description && (
        <>
          <h2>描述</h2>
          <p>{task.description}</p>
        </>
      )}

      {NEXT[task.status].length > 0 && (
        <p>
          {NEXT[task.status].map(s => (
            <button key={s} onClick={() => transition(s)} style={{ marginRight: 8 }}>
              转为{LABELS[s]}
            </button>
          ))}
        </p>
      )}

      <h2>执行证据</h2>
      <textarea
        rows={6}
        value={evidence}
        onChange={e => setEvidence(e.target.value)}
        placeholder="做了什么、结果如何；需要截图先贴链接"
      />
      <p>
        <button onClick={saveEvidence}>保存证据</button>
        {saved && <span className="muted"> 已保存</span>}
      </p>

      <p className="muted">创建于 {task.created_at}{task.completed_at ? ` · 完成于 ${task.completed_at}` : ''}</p>
    </main>
  )
}

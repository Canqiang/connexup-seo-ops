import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type Task, type TaskStatus } from '../api'

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  done: '已完成',
  cancelled: '已取消',
}
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']

export default function MerchantDetail() {
  const { id } = useParams()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.getMerchant(merchantId).then(setMerchant).catch(e => setError((e as Error).message))
    api.listTasks(merchantId).then(setTasks).catch(e => setError((e as Error).message))
  }, [merchantId])

  useEffect(load, [load])

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await api.createTask(merchantId, {
        title: title.trim(),
        rationale: rationale.trim() || undefined,
        description: description.trim() || undefined,
      })
      setTitle('')
      setRationale('')
      setDescription('')
      load()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const toggleArchive = async () => {
    if (!merchant) return
    try {
      setMerchant(await api.patchMerchant(merchant.id, { status: merchant.status === 'active' ? 'archived' : 'active' }))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!merchant) {
    return (
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  return (
    <main>
      <p><Link to="/">← 商户列表</Link></p>
      <h1>{merchant.name}</h1>
      <p>
        <span className={`badge ${merchant.status}`}>{merchant.status === 'active' ? '在营' : '已归档'}</span>
        <button onClick={toggleArchive}>{merchant.status === 'active' ? '归档' : '恢复在营'}</button>
      </p>
      {merchant.notes && <p className="muted">{merchant.notes}</p>}
      {error && <p className="error">{error}</p>}

      <h2>新建任务</h2>
      <form onSubmit={createTask}>
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="标题" />
        <input value={rationale} onChange={e => setRationale(e.target.value)} placeholder="为什么做（动因）" />
        <input value={description} onChange={e => setDescription(e.target.value)} placeholder="描述（可选）" />
        <button type="submit">创建</button>
      </form>

      {STATUS_ORDER.map(s => {
        const group = tasks.filter(t => t.status === s)
        if (group.length === 0) return null
        return (
          <section key={s}>
            <h2>{STATUS_LABELS[s]}（{group.length}）</h2>
            <ul className="list">
              {group.map(t => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  {t.rationale && <span className="muted">{t.rationale}</span>}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}

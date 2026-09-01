import { useCallback, useEffect, useState } from 'react'
import { api, type Task, type TaskStatus } from '../api'
import TaskTable from '../components/TaskTable'
import { CATEGORY_LABELS, TASK_STATUS_LABELS } from '../labels'

type TaskWithMerchant = Task & { merchant_name: string }

const STATUS_RANK: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2, cancelled: 3 }
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']

export default function TasksOverview() {
  const [tasks, setTasks] = useState<TaskWithMerchant[]>([])
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>('todo')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(() => {
    api.listAllTasks()
      .then(fresh => setTasks(prev => {
        const sortFresh = (xs: TaskWithMerchant[]) =>
          [...xs].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.id - a.id)
        if (prev.length === 0) return sortFresh(fresh)
        const byId = new Map(fresh.map(f => [f.id, f]))
        const kept = prev.filter(p => byId.has(p.id)).map(p => byId.get(p.id)!)
        const added = sortFresh(fresh.filter(f => !prev.some(p => p.id === f.id)))
        return [...added, ...kept]
      }))
      .catch(e => setError((e as Error).message))
  }, [])

  useEffect(load, [load])

  const shown = tasks
    .filter(t => statusFilter === null || t.status === statusFilter)
    .filter(t => categoryFilter === '' || t.category === categoryFilter)

  const counts = STATUS_ORDER.map(s => [s, tasks.filter(t => t.status === s).length] as const)

  const toggleSelect = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(prev => {
      const shownIds = shown.map(t => t.id)
      const allSelected = shownIds.length > 0 && shownIds.every(id => prev.has(id))
      return allSelected ? new Set() : new Set(shownIds)
    })
  }

  const transitionTask = async (taskId: number, status: TaskStatus) => {
    try {
      await api.patchTask(taskId, { status })
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      load()
    }
  }

  const batch = async (status: TaskStatus) => {
    if (selected.size === 0) return
    try {
      const res = await api.batchTasks([...selected], status)
      setNotice(`已更新 ${res.updated.length} 项${res.skipped.length ? `，跳过 ${res.skipped.length} 项（状态不允许）` : ''}`)
      setError('')
      setSelected(new Set())
    } catch (err) {
      setError((err as Error).message)
    } finally {
      load()
    }
  }

  return (
    <main>
      <h1>任务总览</h1>
      {error && <p className="error">{error}</p>}

      <div className="stats">
        {counts.filter(([, n]) => n > 0).map(([s, n]) => (
          <button
            key={s}
            className={`stat ${s}${statusFilter === s ? ' on' : ''}`}
            onClick={() => { setStatusFilter(f => f === s ? null : s); setSelected(new Set()) }}
          >
            {TASK_STATUS_LABELS[s]} {n}
          </button>
        ))}
        <select value={categoryFilter} onChange={e => { setCategoryFilter(e.target.value); setSelected(new Set()) }}>
          <option value="">全部类别</option>
          {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        {tasks.length === 0 && <span className="muted">暂无任务</span>}
      </div>

      {selected.size > 0 && (
        <p className="batch-bar">
          <span className="muted">已选 {selected.size} 项</span>
          <button className="primary" onClick={() => batch('doing')}>批量开始</button>
          <button onClick={() => batch('done')}>批量完成</button>
          <button onClick={() => batch('cancelled')}>批量取消</button>
          <button onClick={() => setSelected(new Set())}>清除选择</button>
        </p>
      )}
      {notice && <p className="muted">{notice}</p>}

      <TaskTable
        tasks={shown}
        showMerchant
        onAction={transitionTask}
        selected={selected}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
      />
    </main>
  )
}

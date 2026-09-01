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
  const [error, setError] = useState('')

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

  return (
    <main aria-labelledby="tasks-overview-title">
      <header className="page-head">
        <div>
          <p className="eyebrow">EXECUTION / 跨商户任务</p>
          <h1 id="tasks-overview-title">任务总览</h1>
          <p className="page-summary">在同一张表里筛选、授权并跟进所有商户的执行任务。</p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="panel">
        <div className="panel-head compact">
          <div>
            <p className="section-code">ACTION QUEUE</p>
            <h2>执行队列</h2>
          </div>
          <span className="result-count">显示 {shown.length} / 共 {tasks.length} 项</span>
        </div>

        <div className="table-toolbar task-toolbar">
          <div className="stats" role="group" aria-label="任务状态筛选">
            {counts.filter(([, n]) => n > 0).map(([s, n]) => (
              <button
                key={s}
                className={`stat ${s}${statusFilter === s ? ' on' : ''}`}
                onClick={() => setStatusFilter(f => f === s ? null : s)}
              >
                {TASK_STATUS_LABELS[s]} <strong>{n}</strong>
              </button>
            ))}
          </div>
          <select aria-label="任务类别" value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="">全部类别</option>
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>

        {shown.length > 0 ? (
          <TaskTable
            tasks={shown}
            showMerchant
          />
        ) : (
          <div className="empty-state">当前筛选下没有任务。</div>
        )}
      </section>
    </main>
  )
}

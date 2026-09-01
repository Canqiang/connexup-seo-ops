import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type Run, type Task, type TaskStatus } from '../api'
import TaskTable from '../components/TaskTable'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'

const STATUS_RANK: Record<TaskStatus, number> = { todo: 0, doing: 1, done: 2, cancelled: 3 }
const STATUS_ORDER: TaskStatus[] = ['todo', 'doing', 'done', 'cancelled']
const INTERVAL_OPTIONS = [
  { value: '', label: '自动分析：关闭' },
  { value: '7', label: '自动分析：每 7 天' },
  { value: '30', label: '自动分析：每 30 天' },
]
const RUNS_PREVIEW = 3

export default function MerchantDetail() {
  const { id } = useParams()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [notice, setNotice] = useState('')
  const [showAllRuns, setShowAllRuns] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [expectedOutcome, setExpectedOutcome] = useState('')
  const [category, setCategory] = useState('other')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.getMerchant(merchantId)
      .then(m => { setMerchant(m); setError('') })
      .catch(e => setError((e as Error).message))
    api.listTasks(merchantId)
      .then(fresh => setTasks(prev => {
        // 排序只在首次加载时算；之后就地更新，行不因状态变化跳位
        const sortFresh = (xs: Task[]) =>
          [...xs].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.id - a.id)
        if (prev.length === 0) return sortFresh(fresh)
        const byId = new Map(fresh.map(f => [f.id, f]))
        const kept = prev.filter(p => byId.has(p.id)).map(p => byId.get(p.id)!)
        const added = sortFresh(fresh.filter(f => !prev.some(p => p.id === f.id)))
        return [...added, ...kept]
      }))
      .catch(e => setError((e as Error).message))
    api.listRuns(merchantId).then(setRuns).catch(e => setError((e as Error).message))
  }, [merchantId])

  useEffect(load, [load])

  const hasRunning = runs.some(r => r.status === 'running')

  useEffect(() => {
    if (!hasRunning) return
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [hasRunning, load])

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return
    try {
      await api.createTask(merchantId, {
        title: title.trim(),
        rationale: rationale.trim() || undefined,
        expected_outcome: expectedOutcome.trim() || undefined,
        category,
        description: description.trim() || undefined,
      })
      setTitle('')
      setRationale('')
      setExpectedOutcome('')
      setDescription('')
      setShowCreate(false)
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

  const startRun = async () => {
    try {
      await api.createRun(merchantId)
      setError('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      load()
    }
  }

  const toggleSelect = (taskId: number) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(taskId)) next.delete(taskId)
      else next.add(taskId)
      return next
    })
  }

  const toggleAll = () => {
    setSelected(prev => {
      const ids = shownTasks.map(t => t.id)
      const all = ids.length > 0 && ids.every(id => prev.has(id))
      return all ? new Set<number>() : new Set(ids)
    })
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

  const changeInterval = async (value: string) => {
    try {
      setMerchant(await api.patchMerchant(merchantId, { auto_run_interval_days: value === '' ? null : Number(value) }))
      setError('')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (!merchant) {
    return (
      <main aria-label="商户工作区">
        <p className="breadcrumb"><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const counts = STATUS_ORDER.map(s => [s, tasks.filter(t => t.status === s).length] as const)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, RUNS_PREVIEW)
  const shownTasks = tasks.filter(t => statusFilter === null || t.status === statusFilter)

  return (
    <main aria-labelledby="merchant-workspace-title">
      <p className="breadcrumb"><Link to="/">← 商户台账</Link></p>
      <header className="page-head merchant-head">
        <div>
          <p className="eyebrow">MERCHANT / 商户工作区</p>
          <h1 id="merchant-workspace-title">{merchant.name}</h1>
          <p className="page-summary">{merchant.notes || '管理本商户的分析记录、任务授权与执行进度。'}</p>
        </div>
        <div className="page-actions">
          <span className={`badge ${merchant.status}`}>{merchant.status === 'active' ? '在营' : '已归档'}</span>
          <button onClick={toggleArchive}>{merchant.status === 'active' ? '归档商户' : '恢复在营'}</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <div className="ledger-strip" aria-label="商户运营摘要">
        <div><span>待办任务</span><strong>{tasks.filter(t => t.status === 'todo').length}</strong></div>
        <div><span>进行中</span><strong>{tasks.filter(t => t.status === 'doing').length}</strong></div>
        <div><span>分析记录</span><strong>{runs.length}</strong></div>
        <div><span>自动分析</span><strong>{merchant.auto_run_interval_days ? `${merchant.auto_run_interval_days} 天` : '关闭'}</strong></div>
      </div>

      <section className="panel" aria-labelledby="analysis-title">
        <div className="panel-head">
          <div>
            <p className="section-code">CORE AI / ANALYSIS</p>
            <h2 id="analysis-title">AI 分析</h2>
            <p>生成分析报告和待办提案，执行仍由运营人员授权。</p>
          </div>
          <div className="panel-actions">
            <select
              aria-label="自动分析周期"
              value={merchant.auto_run_interval_days == null ? '' : String(merchant.auto_run_interval_days)}
              onChange={e => changeInterval(e.target.value)}
            >
              {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <button onClick={startRun} disabled={hasRunning} className="primary">
              {hasRunning ? '分析进行中…' : '发起分析'}
            </button>
          </div>
        </div>
        {runs.length > 0 ? (
          <>
            <div className="table-wrap flush">
              <table aria-label="分析记录">
                <thead>
                  <tr><th>#</th><th>状态</th><th>触发</th><th>发起</th><th>结束</th><th>错误</th></tr>
                </thead>
                <tbody>
                  {visibleRuns.map(r => (
                    <tr key={r.id}>
                      <td className="nowrap"><Link to={`/runs/${r.id}`}>#{r.id}</Link></td>
                      <td className="nowrap"><span className={`badge ${r.status}`}>{RUN_STATUS_LABELS[r.status]}</span></td>
                      <td className="dim nowrap">{r.trigger_kind === 'auto' ? '自动' : '手动'}</td>
                      <td className="dim nowrap">{formatTime(r.created_at)}</td>
                      <td className="dim nowrap">{r.finished_at ? formatTime(r.finished_at) : '—'}</td>
                      <td className="dim">{r.error || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs.length > RUNS_PREVIEW && (
              <div className="panel-foot"><button className="quiet" onClick={() => setShowAllRuns(v => !v)}>
                {showAllRuns ? '收起记录' : `查看全部 ${runs.length} 次分析`}
              </button></div>
            )}
          </>
        ) : (
          <div className="empty-state">尚未发起分析。第一次分析会在这里生成报告和任务提案。</div>
        )}
      </section>

      <section className="panel" aria-labelledby="merchant-tasks-title">
        <div className="panel-head">
          <div>
            <p className="section-code">ACTION QUEUE</p>
            <h2 id="merchant-tasks-title">任务队列</h2>
          </div>
          <button onClick={() => setShowCreate(v => !v)}>{showCreate ? '收起' : '＋ 新建任务'}</button>
        </div>

        {showCreate && (
          <form onSubmit={createTask} aria-label="新建任务" className="task-create-form">
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="任务标题" />
            <input value={rationale} onChange={e => setRationale(e.target.value)} placeholder="为什么做" />
            <input value={expectedOutcome} onChange={e => setExpectedOutcome(e.target.value)} placeholder="预期效果（可选）" />
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="补充描述（可选）" />
            <select aria-label="任务类别" value={category} onChange={e => setCategory(e.target.value)}>
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button type="submit" className="primary">创建任务</button>
            <button type="button" className="quiet" onClick={() => setShowCreate(false)}>取消</button>
          </form>
        )}

        <div className="table-toolbar">
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
          <span className="result-count">显示 {shownTasks.length} / 共 {tasks.length} 项</span>
        </div>

        {selected.size > 0 && (
          <div className="batch-bar" role="toolbar" aria-label="批量任务操作">
            <strong>已选 {selected.size} 项</strong>
            <button className="primary" onClick={() => batch('doing')}>批量开始</button>
            <button onClick={() => batch('done')}>批量完成</button>
            <button onClick={() => batch('cancelled')}>批量取消</button>
            <button className="quiet" onClick={() => setSelected(new Set())}>清除选择</button>
          </div>
        )}
        {notice && <p className="notice" role="status">{notice}</p>}

        {shownTasks.length > 0 ? (
          <TaskTable
            tasks={shownTasks}
            onAction={transitionTask}
            selected={selected}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleAll}
          />
        ) : (
          <div className="empty-state">当前筛选下没有任务。</div>
        )}
      </section>
    </main>
  )
}

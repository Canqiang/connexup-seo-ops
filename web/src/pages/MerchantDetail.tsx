import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type Merchant, type Run, type Task, type TaskStatus } from '../api'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'

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
    api.listTasks(merchantId).then(setTasks).catch(e => setError((e as Error).message))
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
      <main>
        <p><Link to="/">← 商户列表</Link></p>
        {error ? <p className="error">{error}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const counts = STATUS_ORDER.map(s => [s, tasks.filter(t => t.status === s).length] as const)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, RUNS_PREVIEW)

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

      <div className="stats">
        {counts.filter(([, n]) => n > 0).map(([s, n]) => (
          <a key={s} href={`#sec-${s}`} className={`stat ${s}`}>{TASK_STATUS_LABELS[s]} {n}</a>
        ))}
        {tasks.length === 0 && <span className="muted">暂无任务</span>}
      </div>

      <h2>AI 分析</h2>
      <p>
        <button onClick={startRun} disabled={hasRunning} className="primary">
          {hasRunning ? '分析进行中…' : '发起分析'}
        </button>
        {' '}
        <select
          value={merchant.auto_run_interval_days == null ? '' : String(merchant.auto_run_interval_days)}
          onChange={e => changeInterval(e.target.value)}
        >
          {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </p>
      {runs.length > 0 && (
        <>
          <ul className="list">
            {visibleRuns.map(r => (
              <li key={r.id}>
                <Link to={`/runs/${r.id}`}>#{r.id}</Link>
                <span className={`badge ${r.status}`}>{RUN_STATUS_LABELS[r.status]}</span>
                <span className="muted">{r.trigger_kind === 'auto' ? '自动' : '手动'} · {formatTime(r.created_at)}</span>
                {r.error && <span className="muted">{r.error}</span>}
              </li>
            ))}
          </ul>
          {runs.length > RUNS_PREVIEW && (
            <p><button onClick={() => setShowAllRuns(v => !v)}>
              {showAllRuns ? '收起' : `全部 ${runs.length} 次分析`}
            </button></p>
          )}
        </>
      )}

      <h2>任务</h2>
      {!showCreate
        ? <p><button onClick={() => setShowCreate(true)}>＋ 新建任务</button></p>
        : (
          <form onSubmit={createTask}>
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="标题" />
            <input value={rationale} onChange={e => setRationale(e.target.value)} placeholder="为什么做（动因）" />
            <input value={expectedOutcome} onChange={e => setExpectedOutcome(e.target.value)} placeholder="预期效果（可选）" />
            <input value={description} onChange={e => setDescription(e.target.value)} placeholder="描述（可选）" />
            <select value={category} onChange={e => setCategory(e.target.value)}>
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button type="submit" className="primary">创建</button>
            <button type="button" onClick={() => setShowCreate(false)}>取消</button>
          </form>
        )}

      {STATUS_ORDER.map(s => {
        const group = tasks.filter(t => t.status === s)
        if (group.length === 0) return null
        return (
          <section key={s} id={`sec-${s}`}>
            <h2>{TASK_STATUS_LABELS[s]}（{group.length}）</h2>
            <ul className="list">
              {group.map(t => (
                <li key={t.id} className="task-row">
                  <div className="task-line1">
                    {t.category && <span className="badge cat">{CATEGORY_LABELS[t.category] ?? t.category}</span>}
                    <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                    {t.source_run_id != null && <span className="badge ai">AI</span>}
                    <span className="muted row-end">{formatTime(t.created_at)}</span>
                  </div>
                  {(t.rationale || t.expected_outcome) && (
                    <div className="task-line2 muted">
                      {t.rationale && <span>动因：{t.rationale}</span>}
                      {t.expected_outcome && <span>预期：{t.expected_outcome}</span>}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </main>
  )
}

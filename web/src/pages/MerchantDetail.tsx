import { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type Merchant, type Run, type Task, type TaskStatus } from '../api'
import TaskTable from '../components/TaskTable'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'
import { formatRunDuration, runResult } from '../runPresentation'

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
  const location = useLocation()
  const navigate = useNavigate()
  const merchantId = Number(id)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null)
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

  const diagnosisStartFailed = Boolean((location.state as { diagnosisStartFailed?: boolean } | null)?.diagnosisStartFailed)

  const counts = STATUS_ORDER.map(s => [s, tasks.filter(t => t.status === s).length] as const)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, RUNS_PREVIEW)
  const shownTasks = tasks.filter(t => statusFilter === null || t.status === statusFilter)
  const latestRun = runs[0]
  const latestRunTasks = latestRun ? tasks.filter(task => task.source_run_id === latestRun.id) : []

  const diagnosis = !latestRun
    ? {
        title: '尚未开始初始诊断',
        copy: '先诊断网站、GBP、本地关键词与竞争环境，再由 Agent 提出执行 Plan。',
        action: 'start' as const,
        actionLabel: '开始诊断',
      }
    : latestRun.status === 'running'
      ? {
          title: '正在诊断商户当前问题',
          copy: 'Core AI 正在收集证据并生成 Plan 草案，完成后会回到这里等待确认。',
          action: null,
          actionLabel: '',
        }
      : latestRun.status === 'failed'
        ? {
            title: '初始诊断未完成',
            copy: latestRun.error || '本次诊断没有成功返回结果，可以重新开始。',
            action: 'start' as const,
            actionLabel: '重新开始诊断',
          }
        : latestRunTasks.length === 0
          ? {
              title: '诊断完成，但未生成 Plan',
              copy: '报告已经返回，但没有生成可执行任务；建议重新分析。',
              action: 'start' as const,
              actionLabel: '重新分析',
            }
          : latestRun.plan_approved_at
            ? {
                title: 'Plan 已确认',
                copy: `${latestRunTasks.length} 项任务已进入运营队列，Agent 可按任务状态执行。`,
                action: 'report' as const,
                actionLabel: '查看诊断报告',
              }
            : {
                title: '诊断完成，Plan 草案待确认',
                copy: `Agent 已提出 ${latestRunTasks.length} 项任务；确认后才会进入执行。`,
                action: 'report' as const,
                actionLabel: '查看并确认 Plan',
              }

  return (
    <main aria-label="商户工作区" className="merchant-workspace-page">
      {diagnosisStartFailed && <p className="notice warning" role="status">商户已保存，但初始诊断未能启动。</p>}
      <header className="merchant-identity-bar">
        <Link to="/" className="back-button" aria-label="返回商户列表">
          <span aria-hidden="true">←</span>
          <span>商户列表</span>
        </Link>
        <div className="merchant-identity">
          <h1 id="merchant-workspace-title">{merchant.name}</h1>
          <p className="page-summary">{merchant.notes || '管理本商户的分析记录、任务授权与执行进度。'}</p>
        </div>
        <div className="page-actions">
          <span className={`badge ${merchant.status}`}>{merchant.status === 'active' ? '在营' : '已归档'}</span>
          <button onClick={toggleArchive}>{merchant.status === 'active' ? '归档商户' : '恢复在营'}</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="diagnosis-card" aria-label="初始诊断">
        <div className="diagnosis-state">
          <span className={`status-dot ${latestRun?.status ?? 'idle'}`} aria-hidden="true" />
          <div>
            <p className="section-code">INITIAL DIAGNOSIS</p>
            <h2 id="diagnosis-title">{diagnosis.title}</h2>
            <p>{diagnosis.copy}</p>
          </div>
        </div>
        {diagnosis.action === 'start' && (
          <button className="primary" onClick={startRun} disabled={hasRunning}>{diagnosis.actionLabel}</button>
        )}
        {diagnosis.action === 'report' && latestRun && (
          <button className={latestRun.plan_approved_at ? '' : 'primary'} onClick={() => navigate(`/runs/${latestRun.id}`)}>
            {diagnosis.actionLabel}
          </button>
        )}
      </section>

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
          {latestRun?.plan_approved_at && (
            <div className="panel-actions">
              <select
                aria-label="自动分析周期"
                value={merchant.auto_run_interval_days == null ? '' : String(merchant.auto_run_interval_days)}
                onChange={e => changeInterval(e.target.value)}
              >
                {INTERVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button onClick={startRun} disabled={hasRunning}>
                {hasRunning ? '分析进行中…' : '重新分析'}
              </button>
            </div>
          )}
        </div>
        {runs.length > 0 ? (
          <>
            <div className="table-wrap flush">
              <table aria-label="分析记录">
                <thead>
                  <tr><th>分析时间</th><th>状态</th><th>触发方式</th><th>用时</th><th>结果</th><th aria-label="查看报告" /></tr>
                </thead>
                <tbody>
                  {visibleRuns.map(r => {
                    const analysisTime = formatTime(r.created_at)
                    return (
                      <tr
                        key={r.id}
                        className="run-row"
                        role="link"
                        tabIndex={0}
                        aria-label={`打开 ${analysisTime} 的分析报告`}
                        onClick={() => navigate(`/runs/${r.id}`)}
                        onKeyDown={event => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            navigate(`/runs/${r.id}`)
                          }
                        }}
                      >
                        <td className="nowrap"><strong>{analysisTime}</strong></td>
                        <td className="nowrap"><span className={`badge ${r.status}`}>{RUN_STATUS_LABELS[r.status]}</span></td>
                        <td className="dim nowrap">{r.trigger_kind === 'auto' ? '自动' : '手动'}</td>
                        <td className="dim nowrap">{formatRunDuration(r.created_at, r.finished_at)}</td>
                        <td className={`run-result ${r.status}`}>{runResult(r)}</td>
                        <td className="run-enter" aria-hidden="true">→</td>
                      </tr>
                    )
                  })}
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

        {shownTasks.length > 0 ? (
          <TaskTable
            tasks={shownTasks}
          />
        ) : (
          <div className="empty-state">当前筛选下没有任务。</div>
        )}
      </section>
    </main>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api, type Merchant, type MerchantProfile, type Run, type Task, type TaskCategory, type TaskPlan, type TaskStatus, isAbortError } from '../api'
import TaskTable from '../components/TaskTable'
import MerchantSectionNav from '../components/MerchantSectionNav'
import { formatTime } from '../format'
import { CATEGORY_LABELS, RUN_STATUS_LABELS, TASK_STATUS_LABELS } from '../labels'
import { formatRunDuration, runResult } from '../runPresentation'
import { isTaskPlan } from '../taskPlan'

const STATUS_RANK: Record<TaskStatus, number> = {
  NEEDS_ATTENTION: 0,
  AWAITING_APPROVAL: 1,
  PENDING: 2,
  PREPARING: 3,
  EXECUTING: 4,
  VERIFYING: 5,
  DONE: 6,
  CANCELLED: 7,
}
const STATUS_ORDER = Object.keys(STATUS_RANK) as TaskStatus[]
const TODO_STATUSES: TaskStatus[] = ['NEEDS_ATTENTION', 'AWAITING_APPROVAL', 'PENDING']
const ACTIVE_STATUSES: TaskStatus[] = ['PREPARING', 'EXECUTING', 'VERIFYING']
const ARCHIVE_BLOCKING_TASK_STATUSES: TaskStatus[] = ['PREPARING', 'AWAITING_APPROVAL', 'EXECUTING', 'VERIFYING']
const ARCHIVE_BLOCKING_EXECUTION_STATUSES = ['PENDING', 'DISPATCHING', 'RUNNING']
const INTERVAL_OPTIONS = [
  { value: '', label: '自动分析：关闭' },
  { value: '7', label: '自动分析：每 7 天' },
  { value: '30', label: '自动分析：每 30 天' },
]
const RUNS_PREVIEW = 3

const isConnectedProfileReady = (profile: MerchantProfile) => profile.state === 'synced'
  && profile.sync_status === 'synced'
  && Boolean(profile.last_synced_at)
  && profile.locations.length > 0

type PlanReadState = 'idle' | 'loading' | 'ready' | 'missing' | 'error'

function taskBlocksArchive(task: Task): boolean {
  return ARCHIVE_BLOCKING_TASK_STATUSES.includes(task.status)
    || (task.execution_status !== null && ARCHIVE_BLOCKING_EXECUTION_STATUSES.includes(task.execution_status))
}

function archiveBlockerMessage(taskCount: number, hasRunningRun: boolean, hasUnknownRun: boolean): string {
  if (hasUnknownRun) {
    return taskCount > 0
      ? `暂时无法归档：本次分析的派发结果需人工核对，且还有 ${taskCount} 个任务正在执行或等待审核。请先进入分析记录完成核对，并处理相关任务；不要重新触发。`
      : '暂时无法归档：本次分析的派发结果需人工核对。请先进入分析记录完成核对；不要重新触发。'
  }
  if (taskCount > 0 && hasRunningRun) {
    return `暂时无法归档：还有 ${taskCount} 个任务正在执行或等待审核，且商户分析仍在运行。请先完成审核，并等待任务和分析结束。`
  }
  if (taskCount > 0) {
    return `暂时无法归档：还有 ${taskCount} 个任务正在执行或等待审核。请先完成审核，并等待任务执行结束。`
  }
  if (hasRunningRun) {
    return '暂时无法归档：商户分析仍在运行。请等待分析结束后再归档。'
  }
  return ''
}

export default function MerchantDetail() {
  const { id } = useParams()
  return <MerchantDetailPage key={id ?? 'invalid'} merchantId={Number(id)} />
}

function MerchantDetailPage({ merchantId }: { merchantId: number }) {
  const validMerchantId = Number.isInteger(merchantId) && merchantId > 0
  const location = useLocation()
  const navigate = useNavigate()
  const mountedRef = useRef(false)
  const loadEpochRef = useRef(0)
  const loadControllerRef = useRef<AbortController | null>(null)
  const planEpochRef = useRef(0)
  const planControllerRef = useRef<AbortController | null>(null)
  const createControllerRef = useRef<AbortController | null>(null)
  const createBusyRef = useRef(false)
  const latestRunIdRef = useRef<number | null>(null)
  const [merchant, setMerchant] = useState<Merchant | null>(null)
  const [profileStatus, setProfileStatus] = useState<{
    merchantId: number
    loaded: boolean
    profile: MerchantProfile | null
    error: string
  }>(() => ({ merchantId, loaded: false, profile: null, error: '' }))
  const [tasks, setTasks] = useState<Task[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [latestTaskPlan, setLatestTaskPlan] = useState<TaskPlan | null>(null)
  const [planState, setPlanState] = useState<PlanReadState>('idle')
  const [statusFilter, setStatusFilter] = useState<TaskStatus | null>(null)
  const [showAllRuns, setShowAllRuns] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [expectedOutcome, setExpectedOutcome] = useState('')
  const [category, setCategory] = useState<TaskCategory>('other')
  const [description, setDescription] = useState('')
  const [scheduledStart, setScheduledStart] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [merchantError, setMerchantError] = useState(validMerchantId ? '' : '商户 ID 无效')
  const [tasksError, setTasksError] = useState('')
  const [runsError, setRunsError] = useState('')
  const [planError, setPlanError] = useState('')
  const [actionError, setActionError] = useState('')

  const clearPlan = useCallback((state: PlanReadState, runId: number | null) => {
    planEpochRef.current += 1
    planControllerRef.current?.abort()
    latestRunIdRef.current = runId
    setLatestTaskPlan(null)
    setPlanState(state)
    setPlanError('')
  }, [])

  const loadLatestPlan = useCallback(async (runId: number) => {
    const epoch = ++planEpochRef.current
    planControllerRef.current?.abort()
    const controller = new AbortController()
    planControllerRef.current = controller
    latestRunIdRef.current = runId
    setLatestTaskPlan(null)
    setPlanState('loading')
    setPlanError('')
    try {
      const freshPlan = await api.getRunTaskPlan(runId, controller.signal)
      if (!mountedRef.current
        || planEpochRef.current !== epoch
        || latestRunIdRef.current !== runId
        || controller.signal.aborted) return
      if (freshPlan === null) {
        setPlanState('missing')
        return
      }
      if (!isTaskPlan(freshPlan)
        || freshPlan.current_revision.plan_id !== freshPlan.id
        || freshPlan.source_run_id !== runId) {
        throw new Error('Task Plan 响应格式或来源无效')
      }
      setLatestTaskPlan(freshPlan)
      setPlanState('ready')
    } catch (error) {
      if (isAbortError(error)
        || !mountedRef.current
        || planEpochRef.current !== epoch
        || latestRunIdRef.current !== runId) return
      setLatestTaskPlan(null)
      setPlanState('error')
      setPlanError((error as Error).message)
    }
  }, [])

  const load = useCallback(() => {
    if (!mountedRef.current) return
    const epoch = ++loadEpochRef.current
    loadControllerRef.current?.abort()
    const controller = new AbortController()
    loadControllerRef.current = controller
    const current = () => mountedRef.current && loadEpochRef.current === epoch && !controller.signal.aborted

    api.getMerchant(merchantId, controller.signal)
      .then(fresh => {
        if (!current()) return
        if (fresh.id !== merchantId) throw new Error('商户响应与当前路由不一致')
        setMerchant(fresh)
        setMerchantError('')
      })
      .catch(error => {
        if (!isAbortError(error) && current()) setMerchantError((error as Error).message)
      })
    api.listTasks(merchantId, controller.signal)
      .then(fresh => {
        if (!current()) return
        if (fresh.some(task => task.merchant_id !== merchantId)) {
          throw new Error('任务列表响应与当前商户不一致')
        }
        setTasks(prev => {
          // 排序只在首次加载时算；之后就地更新，行不因状态变化跳位
          const sortFresh = (xs: Task[]) =>
            [...xs].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.id - a.id)
          if (prev.length === 0) return sortFresh(fresh)
          const byId = new Map(fresh.map(f => [f.id, f]))
          const kept = prev.filter(p => byId.has(p.id)).map(p => byId.get(p.id)!)
          const added = sortFresh(fresh.filter(f => !prev.some(p => p.id === f.id)))
          return [...added, ...kept]
        })
      })
      .then(() => { if (current()) setTasksError('') })
      .catch(error => {
        if (!isAbortError(error) && current()) setTasksError((error as Error).message)
      })
    api.listRuns(merchantId, controller.signal)
      .then(freshRuns => {
        if (!current()) return
        setRuns(freshRuns)
        setRunsError('')
        const latest = freshRuns[0]
        if (!latest || latest.status !== 'succeeded') {
          clearPlan('idle', latest?.id ?? null)
          return
        }
        void loadLatestPlan(latest.id)
      })
      .catch(error => {
        if (!isAbortError(error) && current()) setRunsError((error as Error).message)
      })
  }, [clearPlan, loadLatestPlan, merchantId])

  useEffect(() => {
    mountedRef.current = true
    if (validMerchantId) load()
    return () => {
      mountedRef.current = false
      loadEpochRef.current += 1
      planEpochRef.current += 1
      loadControllerRef.current?.abort()
      planControllerRef.current?.abort()
      createControllerRef.current?.abort()
    }
  }, [load, merchantId, validMerchantId])

  useEffect(() => {
    if (!validMerchantId) return
    let active = true
    void api.getMerchantProfile(merchantId)
      .then(profile => {
        if (!active) return
        setProfileStatus({ merchantId, loaded: true, profile, error: '' })
      })
      .catch(err => {
        if (!active) return
        setProfileStatus({ merchantId, loaded: true, profile: null, error: (err as Error).message })
      })
    return () => { active = false }
  }, [merchantId, validMerchantId])

  const hasRunning = runs.some(r => r.status === 'running')
  const hasUnknownRun = runs.some(r => r.status === 'running' && r.dispatch_state === 'UNKNOWN')
  const hasPollableRun = runs.some(r => r.status === 'running'
    && (r.dispatch_state === 'DISPATCHING' || r.dispatch_state === 'DISPATCHED'))

  useEffect(() => {
    if (!hasPollableRun) return
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [hasPollableRun, load])

  const createTask = async (e: React.FormEvent) => {
    e.preventDefault()
    if (createBusyRef.current || !title.trim() || !rationale.trim() || !expectedOutcome.trim()) return
    createBusyRef.current = true
    setCreateBusy(true)
    const controller = new AbortController()
    createControllerRef.current?.abort()
    createControllerRef.current = controller
    try {
      const created = await api.createTask(merchantId, {
        task_type: 'PREPARE_ONLY',
        title: title.trim(),
        rationale: rationale.trim(),
        expected_outcome: expectedOutcome.trim(),
        scheduled_start: scheduledStart ? new Date(scheduledStart).toISOString() : null,
        parameters: {
          ...(description.trim() ? { description: description.trim() } : {}),
          category,
        },
      }, controller.signal)
      if (!mountedRef.current || controller.signal.aborted) return
      if (created.merchant_id !== merchantId) throw new Error('新建任务响应与当前商户不一致')
      setTitle('')
      setRationale('')
      setExpectedOutcome('')
      setDescription('')
      setScheduledStart('')
      setShowCreate(false)
      setActionError('')
      load()
    } catch (err) {
      if (!isAbortError(err) && mountedRef.current && !controller.signal.aborted) setActionError((err as Error).message)
    } finally {
      if (createControllerRef.current === controller) {
        createBusyRef.current = false
        if (mountedRef.current) setCreateBusy(false)
      }
    }
  }

  const toggleArchive = async () => {
    if (!merchant) return
    if (merchant.status === 'active') {
      const archiveBlockingTaskCount = tasks.filter(taskBlocksArchive).length
      if (archiveBlockingTaskCount > 0 || hasRunning) return
      const todoCount = tasks.filter(task => TODO_STATUSES.includes(task.status)).length
      const confirmed = window.confirm(
        `归档会关闭自动分析并停止创建新的执行；${todoCount} 个待办及全部历史记录会保留。任何进行中、待审核或同步中的工作都必须先处理完成。确认归档“${merchant.name}”？`,
      )
      if (!confirmed) return
    }
    try {
      const updated = await api.patchMerchant(merchant.id, { status: merchant.status === 'active' ? 'archived' : 'active' })
      setMerchant(updated)
      if (updated.status === 'archived') setShowCreate(false)
      setActionError('')
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  const startRun = async () => {
    const currentProfile = profileStatus.merchantId === merchantId ? profileStatus.profile : null
    if (!profileStatus.loaded || (currentProfile?.fbr_merchant_id && !isConnectedProfileReady(currentProfile))) return
    try {
      await api.createRun(merchantId)
      setActionError('')
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      load()
    }
  }

  const changeInterval = async (value: string) => {
    try {
      setMerchant(await api.patchMerchant(merchantId, { auto_run_interval_days: value === '' ? null : Number(value) }))
      setActionError('')
    } catch (err) {
      setActionError((err as Error).message)
    }
  }

  if (!merchant) {
    return (
      <main aria-label="商户工作区">
        <p className="breadcrumb"><Link to="/">← 商户列表</Link></p>
        {merchantError ? <p className="error">{merchantError}</p> : <p>加载中…</p>}
      </main>
    )
  }

  const onboardingState = location.state as {
    diagnosisStartFailed?: boolean
    diagnosisStartError?: string
    profileSetupFailed?: boolean
    profileSetupError?: string
  } | null
  const diagnosisStartFailed = Boolean(onboardingState?.diagnosisStartFailed)
  const profileSetupFailed = Boolean(onboardingState?.profileSetupFailed)
  const currentProfileStatus = profileStatus.merchantId === merchantId ? profileStatus : null
  const merchantProfile = currentProfileStatus?.profile ?? null
  const profileStatusLoaded = Boolean(currentProfileStatus?.loaded)
  const profileStatusError = currentProfileStatus?.error ?? ''
  const persistedProfileBlocked = Boolean(
    profileStatusLoaded
    && merchantProfile?.fbr_merchant_id
    && !isConnectedProfileReady(merchantProfile),
  )
  const profileSetupBlocked = profileSetupFailed || persistedProfileBlocked

  const counts = STATUS_ORDER.map(s => [s, tasks.filter(t => t.status === s).length] as const)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, RUNS_PREVIEW)
  const shownTasks = tasks.filter(t => statusFilter === null || t.status === statusFilter)
  const latestRun = runs[0]
  const merchantArchived = merchant.status === 'archived'
  const archiveBlockingTaskCount = tasks.filter(taskBlocksArchive).length
  const archiveBlockedReason = merchantArchived ? '' : archiveBlockerMessage(archiveBlockingTaskCount, hasRunning, hasUnknownRun)
  const latestPlanTaskCount = latestTaskPlan?.current_revision.payload.tasks.length ?? 0

  const diagnosis = !latestRun
    ? {
        title: '尚未开始初始诊断',
        copy: '先诊断网站、GBP、本地关键词与竞争环境，再由 Agent 提出执行 Plan。',
        action: 'start' as const,
        actionLabel: '开始诊断',
      }
    : latestRun.status === 'running' && latestRun.dispatch_state === 'UNKNOWN'
      ? {
          title: '派发结果需人工核对',
          copy: 'Core AI 是否已创建本次分析尚不确定。不要重新触发诊断；请进入本次记录核对。',
          action: 'report' as const,
          actionLabel: '进入人工核对',
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
        : planState === 'loading'
          ? {
              title: '正在读取 Task Plan',
              copy: '报告已经返回，正在读取持久化的 Plan revision。',
              action: null,
              actionLabel: '',
            }
        : planState === 'error'
          ? {
              title: '无法读取 Task Plan',
              copy: planError,
              action: 'retry-plan' as const,
              actionLabel: '重试读取 Plan',
            }
        : planState === 'missing'
          ? {
              title: '诊断完成，但未生成 Plan',
              copy: '报告已经返回，但没有持久化的可编辑 Task Plan；建议重新分析。',
              action: 'start' as const,
              actionLabel: '重新分析',
            }
          : !latestTaskPlan
            ? {
                title: '正在读取 Task Plan',
                copy: '报告已经返回，正在读取持久化的 Plan revision。',
                action: null,
                actionLabel: '',
              }
          : latestTaskPlan.current_revision.decision_state === 'APPROVED'
            ? {
                title: 'Plan 已确认',
                copy: `${latestPlanTaskCount} 项任务已进入运营队列，可按依赖顺序进行无工具内容准备。`,
                action: 'report' as const,
                actionLabel: '查看诊断报告',
              }
            : latestTaskPlan.current_revision.decision_state === 'REJECTED'
              ? {
                  title: 'Plan 已拒绝',
                  copy: `Revision ${latestTaskPlan.current_revision.revision} 已拒绝，不会物化正式 Task。`,
                  action: 'report' as const,
                  actionLabel: '查看诊断报告',
                }
            : {
                title: '诊断完成，Plan 草案待确认',
                copy: `Revision ${latestTaskPlan.current_revision.revision} 包含 ${latestPlanTaskCount} 项任务；完整批准后才会物化。`,
                action: 'plan' as const,
                actionLabel: '查看并编辑 Plan',
              }

  return (
    <main aria-label="商户工作区" className="merchant-workspace-page">
      {profileSetupFailed && (
        <p className="notice warning onboarding-notice" role="alert">
          <span>商户已新建，但 FBR/GBP 初始化失败，尚未开始诊断。{onboardingState?.profileSetupError ? `原因：${onboardingState.profileSetupError}` : ''}</span>
          <Link to={`/merchants/${merchantId}/profile`}>前往商户资料重试</Link>
        </p>
      )}
      {!profileSetupFailed && persistedProfileBlocked && (
        <p className="notice warning onboarding-notice" role="alert">
          <span>FBR 已绑定，但 GBP 尚未同步完成，诊断暂未启动。{merchantProfile?.last_error ? `原因：${merchantProfile.last_error}` : ''}</span>
          <Link to={`/merchants/${merchantId}/profile`}>前往商户资料重试</Link>
        </p>
      )}
      {profileStatusError && (
        <p className="notice warning onboarding-notice" role="alert">
          <span>无法读取 FBR/GBP 状态，当前未将商户误判为已绑定，基础诊断仍可使用。原因：{profileStatusError}</span>
        </p>
      )}
      {diagnosisStartFailed && (
        <p className="notice warning onboarding-notice" role="status">
          <span>商户已保存，但初始诊断未能启动。{onboardingState?.diagnosisStartError ? `原因：${onboardingState.diagnosisStartError}` : ''}</span>
        </p>
      )}
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
          <button
            onClick={toggleArchive}
            disabled={merchant.status === 'active' && Boolean(archiveBlockedReason)}
            aria-describedby={archiveBlockedReason ? 'archive-blocked-reason' : undefined}
          >
            {merchant.status === 'active' ? '归档商户' : '恢复在营'}
          </button>
        </div>
      </header>
      <MerchantSectionNav merchantId={merchantId} active="operations" />
      {archiveBlockedReason && (
        <p id="archive-blocked-reason" className="notice warning archive-blocker-notice" role="status">{archiveBlockedReason}</p>
      )}
      {merchantArchived && (
        <p className="notice warning" role="status">商户已归档；自动分析和新的任务执行已暂停，待办及历史记录均已保留。</p>
      )}
      {merchantError && <p className="error">{merchantError}</p>}
      {tasksError && <p className="error">{tasksError}</p>}
      {runsError && <p className="error">{runsError}</p>}
      {actionError && <p className="error">{actionError}</p>}

      {profileStatusLoaded && !profileSetupBlocked && (
        <section className="diagnosis-card" aria-label="初始诊断">
          <div className="diagnosis-state">
            <span className={`status-dot ${latestRun?.status ?? 'idle'}`} aria-hidden="true" />
            <div>
              <p className="section-code">INITIAL DIAGNOSIS</p>
              <h2 id="diagnosis-title">{diagnosis.title}</h2>
              <p>{diagnosis.copy}</p>
            </div>
          </div>
          {!merchantArchived && diagnosis.action === 'start' && (
            <button className="primary" onClick={startRun} disabled={hasRunning}>{diagnosis.actionLabel}</button>
          )}
          {diagnosis.action === 'report' && latestRun && (
            <button className={latestTaskPlan?.current_revision.decision_state === 'APPROVED' ? '' : 'primary'} onClick={() => navigate(`/runs/${latestRun.id}`)}>
              {diagnosis.actionLabel}
            </button>
          )}
          {!merchantArchived && diagnosis.action === 'plan' && latestTaskPlan && (
            <button className="primary" onClick={() => navigate(`/task-plans/${latestTaskPlan.id}`)}>
              {diagnosis.actionLabel}
            </button>
          )}
          {diagnosis.action === 'retry-plan' && latestRun && (
            <button className="primary" onClick={() => void loadLatestPlan(latestRun.id)}>
              {diagnosis.actionLabel}
            </button>
          )}
        </section>
      )}

      <div className="ledger-strip" aria-label="商户运营摘要">
        <div><span>待办任务</span><strong>{tasks.filter(t => TODO_STATUSES.includes(t.status)).length}</strong></div>
        <div><span>进行中</span><strong>{tasks.filter(t => ACTIVE_STATUSES.includes(t.status)).length}</strong></div>
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
          {profileStatusLoaded && !profileSetupBlocked && !merchantArchived && latestTaskPlan?.approved_revision != null && (
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
          {!merchantArchived && (
            <button onClick={() => setShowCreate(v => !v)}>{showCreate ? '收起' : '＋ 新建任务'}</button>
          )}
        </div>

        {showCreate && !merchantArchived && (
          <form onSubmit={createTask} aria-label="新建任务" className="task-create-form">
            <label>任务标题<input aria-label="任务标题" required maxLength={200} value={title} onChange={e => setTitle(e.target.value)} /></label>
            <label>为什么做<input aria-label="为什么做" required maxLength={2000} value={rationale} onChange={e => setRationale(e.target.value)} /></label>
            <label>预期效果<input aria-label="预期效果" required maxLength={1000} value={expectedOutcome} onChange={e => setExpectedOutcome(e.target.value)} /></label>
            <label>准备要求<input aria-label="准备要求" maxLength={4000} value={description} onChange={e => setDescription(e.target.value)} /></label>
            <label>计划开始<input aria-label="计划开始" type="datetime-local" value={scheduledStart} onChange={e => setScheduledStart(e.target.value)} /></label>
            <label>任务类别<select aria-label="任务类别" value={category} onChange={e => setCategory(e.target.value as TaskCategory)}>
              {Object.entries(CATEGORY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select></label>
            <p className="task-create-boundary">PREPARE_ONLY · 仅生成可审内容，不发布外部资源。</p>
            <div className="task-create-actions">
              <button type="submit" className="primary" disabled={createBusy || !title.trim() || !rationale.trim() || !expectedOutcome.trim()}>{createBusy ? '创建中…' : '创建任务'}</button>
              <button type="button" className="quiet" disabled={createBusy} onClick={() => setShowCreate(false)}>取消</button>
            </div>
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

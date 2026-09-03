export type TaskPlanItem = {
  key: string
  task_type: 'PREPARE_ONLY'
  title: string
  rationale: string
  expected_outcome: string
  depends_on: string[]
  scheduled_start: string | null
  parameters: Record<string, unknown>
}

export type TaskPlanPayload = {
  schema_version: 'seo_ops.task_plan.v1'
  tasks: TaskPlanItem[]
}

export type TaskPlanDecisionState = 'DRAFT' | 'APPROVED' | 'REJECTED' | 'SUPERSEDED'

export type TaskPlanRevision = {
  id: number
  plan_id: number
  revision: number
  decision_state: TaskPlanDecisionState
  schema_version: 'seo_ops.task_plan.v1'
  checksum: string
  source: 'AGENT' | 'OPERATOR' | string
  created_by: string
  created_at: string
  decided_by: string | null
  decided_at: string | null
  decision_reason: string | null
  payload: TaskPlanPayload
}

export type TaskPlan = {
  id: number
  merchant_id: number
  source_kind: 'AGENT' | 'OPERATOR' | string
  source_run_id: number | null
  state: 'OPEN' | 'REJECTED' | 'CLOSED'
  latest_revision: number
  approved_revision: number | null
  created_at: string
  closed_at: string | null
  current_revision: TaskPlanRevision
}

export function isTaskPlan(value: unknown): value is TaskPlan {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<TaskPlan>
  const revision = candidate.current_revision as Partial<TaskPlanRevision> | undefined
  return typeof candidate.id === 'number'
    && typeof candidate.latest_revision === 'number'
    && Boolean(revision)
    && typeof revision?.revision === 'number'
    && typeof revision?.checksum === 'string'
    && Array.isArray(revision?.payload?.tasks)
}

const TASK_KEY = /^[a-z0-9_-]{1,80}$/
const AWARE_RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

function duplicateValue(values: string[]): string | null {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return null
}

export function executionWaves(tasks: TaskPlanItem[]): TaskPlanItem[][] {
  const duplicateKey = duplicateValue(tasks.map(task => task.key))
  if (duplicateKey) throw new Error(`Plan 存在重复 Task key：${duplicateKey}`)

  const keys = new Set(tasks.map(task => task.key))
  for (const task of tasks) {
    const duplicateDependency = duplicateValue(task.depends_on)
    if (duplicateDependency) {
      throw new Error(`任务 ${task.key} 重复依赖 ${duplicateDependency}`)
    }
    for (const dependency of task.depends_on) {
      if (dependency === task.key) throw new Error(`任务 ${task.key} 不能依赖自身`)
      if (!keys.has(dependency)) {
        throw new Error(`任务 ${task.key} 引用了不存在的前置任务 ${dependency}`)
      }
    }
  }

  const remaining = new Set(tasks.map(task => task.key))
  const complete = new Set<string>()
  const waves: TaskPlanItem[][] = []

  while (remaining.size > 0) {
    const wave = tasks.filter(task => (
      remaining.has(task.key) && task.depends_on.every(key => complete.has(key))
    ))
    if (wave.length === 0) {
      const cycle = tasks.filter(task => remaining.has(task.key)).map(task => task.key)
      throw new Error(`Plan 存在循环依赖：${cycle.join('、')}`)
    }
    waves.push(wave)
    for (const task of wave) {
      remaining.delete(task.key)
      complete.add(task.key)
    }
  }

  return waves
}

export function taskPlanValidationErrors(tasks: TaskPlanItem[]): string[] {
  const errors: string[] = []
  if (tasks.length === 0) return ['Plan 至少需要保留一项任务']
  if (tasks.length > 50) errors.push('Plan 最多包含 50 项任务')

  const duplicateKey = duplicateValue(tasks.map(task => task.key))
  if (duplicateKey) errors.push(`Plan 存在重复 Task key：${duplicateKey}`)

  for (const task of tasks) {
    const displayKey = task.key || '未命名'
    if (!TASK_KEY.test(task.key)) {
      errors.push(`Task key ${displayKey} 只能使用小写字母、数字、- 和 _，长度 1–80`)
    }
    if (!task.title.trim()) errors.push(`任务 ${displayKey} 缺少标题`)
    else if (task.title.length > 200) errors.push(`任务 ${displayKey} 的标题超过 200 字`)
    if (!task.rationale.trim()) errors.push(`任务 ${displayKey} 缺少理由`)
    else if (task.rationale.length > 2000) errors.push(`任务 ${displayKey} 的理由超过 2000 字`)
    if (!task.expected_outcome.trim()) errors.push(`任务 ${displayKey} 缺少预期结果`)
    else if (task.expected_outcome.length > 1000) errors.push(`任务 ${displayKey} 的预期结果超过 1000 字`)
    if (task.task_type !== 'PREPARE_ONLY') errors.push(`任务 ${displayKey} 的类型当前不可用`)
    if (task.depends_on.length > 20) errors.push(`任务 ${displayKey} 最多设置 20 项前置任务`)
    if (task.scheduled_start && (
      !AWARE_RFC3339.test(task.scheduled_start) || Number.isNaN(Date.parse(task.scheduled_start))
    )) {
      errors.push(`任务 ${displayKey} 的计划时间必须是带时区的 RFC 3339 时间`)
    }
  }

  if (!duplicateKey) {
    try {
      executionWaves(tasks)
    } catch (error) {
      errors.push((error as Error).message)
    }
  }

  return [...new Set(errors)]
}

export function taskPlanSnapshot(payload: TaskPlanPayload): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, entry]) => [key, normalize(entry)]),
      )
    }
    return value
  }
  return JSON.stringify(normalize(payload))
}

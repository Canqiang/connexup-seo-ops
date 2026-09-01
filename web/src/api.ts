export type Merchant = {
  id: number
  name: string
  status: 'active' | 'archived'
  notes: string | null
  primary_location: string | null
  website_url: string | null
  auto_run_interval_days: number | null
  created_at: string
}

export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled'
export type TaskExecutionStatus = 'running' | 'ready' | 'failed' | 'approved' | 'returned'

export type TaskExecution = {
  id: number
  task_id: number
  coreai_run_id: string | null
  status: TaskExecutionStatus
  attempt: number
  output_text: string | null
  error: string | null
  review_note: string | null
  created_at: string
  finished_at: string | null
  reviewed_at: string | null
}

export type Task = {
  id: number
  merchant_id: number
  title: string
  description: string | null
  rationale: string | null
  expected_outcome: string | null
  category: string | null
  scheduled_start: string | null
  status: TaskStatus
  execution_status?: TaskExecutionStatus | null
  evidence_note: string | null
  source_run_id: number | null
  source_plan_approved: boolean
  source_key: string | null
  created_at: string
  completed_at: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...init })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = body && typeof body.detail === 'string' ? body.detail : `${res.status} ${res.statusText}`
    throw new Error(detail)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

async function requestOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const detail = body && typeof body.detail === 'string' ? body.detail : `${res.status} ${res.statusText}`
    throw new Error(detail)
  }
  return res.json()
}

export type RunStatus = 'running' | 'succeeded' | 'failed'

export type MerchantStats = Merchant & {
  todo_count: number
  doing_count: number
  has_running_run: boolean
  last_run_at: string | null
  last_run_status: RunStatus | null
}

export type Run = {
  id: number
  merchant_id: number
  coreai_run_id: string | null
  status: RunStatus
  trigger_kind: 'manual' | 'auto'
  report_text?: string | null
  error: string | null
  plan_approved_at: string | null
  created_at: string
  finished_at: string | null
}

export type Operator = {
  username: string
  role: 'operator'
}

export const api = {
  me: () => request<Operator>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<Operator>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  listMerchants: (status?: 'active' | 'archived') =>
    request<MerchantStats[]>(`/api/merchants${status ? `?status=${status}` : ''}`),
  createMerchant: (body: { name: string; notes?: string; primary_location?: string; website_url?: string }) =>
    request<Merchant>('/api/merchants', { method: 'POST', body: JSON.stringify(body) }),
  getMerchant: (id: number) => request<Merchant>(`/api/merchants/${id}`),
  patchMerchant: (id: number, body: Partial<Pick<Merchant, 'name' | 'status' | 'notes' | 'primary_location' | 'website_url' | 'auto_run_interval_days'>>) =>
    request<Merchant>(`/api/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  listTasks: (merchantId: number) => request<Task[]>(`/api/merchants/${merchantId}/tasks`),
  createTask: (merchantId: number, body: { title: string; description?: string; rationale?: string; expected_outcome?: string; category?: string }) =>
    request<Task>(`/api/merchants/${merchantId}/tasks`, { method: 'POST', body: JSON.stringify(body) }),
  getTask: (id: number) => request<Task>(`/api/tasks/${id}`),
  getTaskExecution: (id: number) => requestOptional<TaskExecution>(`/api/tasks/${id}/execution`),
  executeTask: (id: number) => request<TaskExecution>(`/api/tasks/${id}/execute`, { method: 'POST' }),
  approveTaskExecution: (id: number) => request<{ task: Task; execution: TaskExecution }>(`/api/tasks/${id}/approve-execution`, { method: 'POST' }),
  returnTaskExecution: (id: number, reason: string) => request<TaskExecution>(`/api/tasks/${id}/return-execution`, { method: 'POST', body: JSON.stringify({ reason }) }),
  patchTask: (id: number, body: Partial<Pick<Task, 'title' | 'description' | 'rationale' | 'expected_outcome' | 'category' | 'evidence_note' | 'status'>>) =>
    request<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  listRuns: (merchantId: number) => request<Run[]>(`/api/merchants/${merchantId}/runs`),
  createRun: (merchantId: number) => request<Run>(`/api/merchants/${merchantId}/runs`, { method: 'POST' }),
  getRun: (id: number) => request<Run>(`/api/runs/${id}`),
  approvePlan: (id: number) => request<Run>(`/api/runs/${id}/approve-plan`, { method: 'POST' }),
  listRunTasks: (id: number) => request<Task[]>(`/api/runs/${id}/tasks`),
  listAllTasks: () => request<(Task & { merchant_name: string })[]>('/api/tasks'),
  batchTasks: (ids: number[], status: TaskStatus) =>
    request<{ updated: number[]; skipped: number[] }>('/api/tasks/batch', { method: 'POST', body: JSON.stringify({ ids, status }) }),
}

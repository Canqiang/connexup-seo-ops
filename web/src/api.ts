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

export type AuditArea = 'GBP' | 'WEBSITE' | 'LOCAL_CONTENT' | 'TECHNICAL' | 'CITATIONS' | 'REVIEWS' | 'ANALYTICS' | 'OTHER'
export type AuditSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
export type AuditEvidenceMode = 'PUBLIC_AND_CONFIRMED' | 'CONNECTED_AND_CONFIRMED' | 'CONFIRMED_FACTS_ONLY'

export type AuditFinding = {
  id: string
  area: AuditArea
  severity: AuditSeverity
  observation: string
  evidence: string[]
  recommendation: string
}

export type AuditReport = {
  schema_version: 'seo_ops.audit_report.v1'
  merchant_id: string
  title: string
  summary: string
  evidence_mode: AuditEvidenceMode
  findings: AuditFinding[]
  limitations: string[]
  next_actions: string[]
}

export type AuditSnapshot = {
  id: number
  run_id: number
  merchant_id: number
  schema_version: 'seo_ops.audit_report.v1'
  evidence_mode: AuditEvidenceMode
  finding_count: number
  source_ref: string | null
  accepted_at: string
  audit: AuditReport
}

export type GbpHoursPeriod = {
  open_day: string
  open_time: string
  close_day: string
  close_time: string
}

export type GbpPostSummary = {
  post_id: string | null
  state: string | null
  summary: string | null
  created_at: string | null
  updated_at: string | null
  media_count: number
  media_url: string | null
  media_format: string | null
  cta_type: string | null
  cta_url: string | null
}

export type GbpMenuSectionSummary = {
  name: string
  item_count: number
}

export type GbpMenuItem = {
  section_name: string
  name: string
  description: string | null
  price_amount: number | null
  currency_code: string | null
  media_url: string | null
}

export type GbpReviewSummary = {
  review_id: string | null
  rating: number | null
  content: string | null
  reviewer_name: string | null
  created_at: string | null
  has_reply: boolean
}

export type GbpPerformanceMetric = {
  metric_date: string
  metric: string
  value: number
}

export type GbpSearchKeywordMetric = {
  month: string
  keyword: string
  value: number
}

export type MerchantGbpLocation = {
  gbp_location_id: string
  google_account_id: string | null
  name: string | null
  place_id: string | null
  title: string
  store_code: string | null
  language_code: string | null
  phone: string | null
  additional_phones: string[]
  address: string | null
  address_lines: string[]
  locality: string | null
  administrative_area: string | null
  postal_code: string | null
  region_code: string | null
  website_url: string | null
  primary_category: string | null
  additional_categories: string[]
  open_status: string | null
  description: string | null
  regular_hours: GbpHoursPeriod[]
  attribute_count: number | null
  menu_count: number | null
  menu_section_count: number | null
  menu_item_count: number | null
  menu_sections: GbpMenuSectionSummary[]
  menu_items: GbpMenuItem[]
  post_count: number | null
  live_post_count: number | null
  recent_posts: GbpPostSummary[]
  review_count: number | null
  review_sync_status?: 'ready' | 'unavailable'
  review_scope?: 'all_synced' | 'recent_month' | null
  review_average_rating?: number | null
  review_reply_rate?: number | null
  recent_reviews: GbpReviewSummary[]
  media_count: number | null
  customer_media_count: number | null
  question_count: number | null
  place_action_link_count: number | null
  verification_count: number | null
  performance_metrics?: GbpPerformanceMetric[]
  search_keywords?: GbpSearchKeywordMetric[]
  source_updated_at: string | null
  synced_at: string
}

export type MerchantProfile = {
  merchant_id: number
  state: 'unbound' | 'not_synced' | 'syncing' | 'synced' | 'failed'
  fbr_merchant_id: string | null
  sync_status: string | null
  last_synced_at: string | null
  last_error: string | null
  locations: MerchantGbpLocation[]
}

export type SeoKeyword = {
  keyword: string
  strategy: 'LOCAL' | 'ORGANIC'
  intent: 'LOCAL' | 'ORGANIC' | 'BRAND' | 'MENU' | 'NEAR_ME'
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'UNSCORED'
  rationale: string
  source_tags: string[]
  target_surface_types: string[]
  target_location: string | null
}

export type SeoKeywordSet = {
  schema_version: 'seo_ops.keyword_set.v2'
  merchant_id: string
  market: { country_code: 'US'; language: 'en-US'; search_engine: 'GOOGLE'; location_name?: string | null }
  generation_method: 'PERSISTED_FBR_READBACK' | 'UPSTREAM_DETERMINISTIC_ADAPTER' | 'EVIDENCE_BOUNDED_RESEARCH'
  title: string
  summary: string
  keywords: SeoKeyword[]
  evidence_gaps: string[]
}

export type SeoRankingItem = {
  keyword: string
  local_rank: number | null
  organic_rank: number | null
  source: 'LIVE_READ_ONLY' | 'UNAVAILABLE'
  note?: string | null
}

export type SeoRankingReport = {
  schema_version: 'seo_ops.ranking_report.v1'
  merchant_id: string
  title: string
  summary: string
  captured_at: string
  source_mode: 'LIVE_READ_ONLY' | 'CONFIRMED_FACTS_ONLY'
  keywords: SeoRankingItem[]
  limitations: string[]
}

export type LocalFalconGridPoint = {
  lat: number
  lng: number
  found: boolean
  rank: number | null
}

export type LocalFalconSnapshot = {
  schema_version: 'seo_ops.local_falcon_snapshot.v1'
  report_key: string
  place_id: string
  keyword: string
  platform: 'google'
  captured_at: string
  center_lat: number
  center_lng: number
  grid_size: number
  radius: number
  measurement: 'mi' | 'km'
  arp: number
  atrp: number
  solv: number
  found_in: number
  image_url: string | null
  heatmap_url: string | null
  grid_points: LocalFalconGridPoint[]
}

export type LocalFalconState = {
  status: 'not_synced' | 'synced' | 'failed'
  last_synced_at: string | null
  last_error: string | null
  missing_keywords: string[]
  reports: LocalFalconSnapshot[]
}

export type SeoTargetState = {
  merchant_id: number
  cycle_id?: string
  cycle_status: 'empty' | 'running' | 'ready' | 'failed'
  active_stage: 'KEYWORD_SET' | 'AUDIT_REPORT' | 'RANKING_REPORT' | null
  keyword_set: SeoKeywordSet | null
  audit_report: AuditReport | null
  ranking_report: SeoRankingReport | null
  local_falcon?: LocalFalconState
  capabilities?: { can_regenerate: boolean }
  error: string | null
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
  getMerchantProfile: (id: number) => request<MerchantProfile>(`/api/merchants/${id}/profile`),
  getSeoTargets: (id: number) => request<SeoTargetState>(`/api/merchants/${id}/seo-targets`),
  refreshSeoTargets: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/seo-targets/refresh`, { method: 'POST' }),
  regenerateSeoTargets: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/seo-targets/regenerate`, { method: 'POST' }),
  syncLocalFalconReports: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/local-falcon-sync`, { method: 'POST' }),
  bindMerchantFbr: (id: number, fbrMerchantId: string) =>
    request<MerchantProfile>(`/api/merchants/${id}/fbr-link`, {
      method: 'PUT',
      body: JSON.stringify({ fbr_merchant_id: fbrMerchantId }),
    }),
  syncMerchantGbp: (id: number) =>
    request<MerchantProfile>(`/api/merchants/${id}/gbp-sync`, { method: 'POST' }),
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
  getRunAudit: (id: number) => requestOptional<AuditSnapshot>(`/api/runs/${id}/audit`),
  approvePlan: (id: number) => request<Run>(`/api/runs/${id}/approve-plan`, { method: 'POST' }),
  listRunTasks: (id: number) => request<Task[]>(`/api/runs/${id}/tasks`),
  listAllTasks: () => request<(Task & { merchant_name: string })[]>('/api/tasks'),
  batchTasks: (ids: number[], status: TaskStatus) =>
    request<{ updated: number[]; skipped: number[] }>('/api/tasks/batch', { method: 'POST', body: JSON.stringify({ ids, status }) }),
}

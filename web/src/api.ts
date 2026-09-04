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
  merchant_status?: 'active' | 'archived'
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
  score?: number | null
  score_rank?: number | null
  local_falcon_selected?: boolean
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

export type SeoKeywordVersion = {
  artifact_id: number
  place_id: string
  source: 'SKILL' | 'FBR' | 'LEGACY'
  activation_eligible: boolean
  generation_method: SeoKeywordSet['generation_method']
  keyword_count: number
  local_keyword_count: number
  organic_keyword_count: number
  scored_keyword_count: number
  score_status: 'VERIFIED_SKILL' | 'SCORED_UNVERIFIED' | 'UNSCORED' | 'PARTIAL'
  completed_at: string | null
  is_active: boolean
}

export type SeoKeywordComparison = {
  active_local_count: number
  fbr_local_count: number
  added_count: number
  removed_count: number
  priority_changed_count: number
  target_surfaces_changed_count: number
  added_keywords: string[]
  removed_keywords: string[]
  changed_keywords: Array<{
    keyword: string
    priority: { active: SeoKeyword['priority']; fbr: SeoKeyword['priority'] } | null
    target_surfaces: { active: string[]; fbr: string[] } | null
  }>
}

export type SeoLatestFbrImport = {
  artifact_id: number
  imported_at: string | null
  is_active: boolean
  comparison: SeoKeywordComparison
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

export type LocalFalconScanBatch = {
  id: number
  approval_id: number
  request_id?: string
  status: 'submitting' | 'submitted' | 'partial' | 'completed' | 'failed' | 'unknown'
  scan_config?: Record<string, unknown>
  scan_config_sha256?: string
  total_count: number
  pending_count: number
  submitting_count: number
  submitted_count: number
  completed_count: number
  unknown_count: number
  failed_count: number
  needs_reconciliation: boolean
  can_confirm_not_submitted?: boolean
  can_bind_acknowledged_report?: boolean
  report_binding_blocker?: string | null
  items?: Array<{
    keyword: string
    status: 'pending' | 'submitting' | 'submitted' | 'completed' | 'failed' | 'unknown'
    error: string | null
    updated_at: string
  }>
  error?: string | null
  created_at?: string
  completed_at?: string | null
}

export type LocalFalconReconciliationAction =
  | 'BIND_ACKNOWLEDGED_REPORT'
  | 'CONFIRM_NOT_SUBMITTED'
  | 'CLOSE_WITHOUT_RETRY'

export type LocalFalconReconciliationRequest = {
  action: LocalFalconReconciliationAction
  keyword?: string
  report_key?: string
  reason: string
}

export type LocalFalconState = {
  current_place_id?: string | null
  status: 'not_synced' | 'synced' | 'failed'
  last_synced_at: string | null
  last_error: string | null
  missing_keywords: string[]
  reports: LocalFalconSnapshot[]
  scan_defaults?: {
    place_id: string
    lat: number
    lng: number
    grid_size: number
    radius: number
    measurement: 'mi' | 'km'
    platform: 'google'
  } | null
  scan_defaults_sha256?: string | null
  approval?: {
    id: number
    keyword_artifact_id: number
    cohort_sha256: string
    cohort?: Array<{ keyword: string; score: number; score_rank: number }>
    place_id?: string
    approved_by?: string
    approved_at: string
  } | null
  scan_batch?: LocalFalconScanBatch | null
}

export type SeoTargetState = {
  merchant_id: number
  cycle_id?: string
  cycle_status: 'empty' | 'running' | 'ready' | 'failed'
  active_stage: 'KEYWORD_SET' | 'AUDIT_REPORT' | 'RANKING_REPORT' | null
  keyword_set: SeoKeywordSet | null
  keyword_set_artifact_id?: number | null
  active_keyword_artifact_id: number | null
  active_keyword_source: 'SKILL' | 'FBR' | 'LEGACY' | null
  active_keyword_activated_at: string | null
  keyword_versions: SeoKeywordVersion[]
  latest_fbr_import: SeoLatestFbrImport | null
  local_falcon_cohort_sha256?: string | null
  audit_report: AuditReport | null
  ranking_report: SeoRankingReport | null
  local_falcon?: LocalFalconState
  capabilities?: {
    can_regenerate: boolean
    can_sync_local_falcon?: boolean
    can_approve_local_falcon?: boolean
    can_generate_local_falcon?: boolean
    blockers?: {
      regenerate?: string[]
      sync_local_falcon?: string[]
      approve_local_falcon?: string[]
      generate_local_falcon?: string[]
    }
  }
  error: string | null
}

export type Operator = {
  username: string
  role: 'operator'
}

export type PerformanceMetricTotal = {
  value: number | null
  merchant_coverage: number
}

export type PerformanceDashboard = {
  window: {
    label: string
    start: string | null
    end: string | null
    historical_comparison_available: false
  }
  coverage: {
    active_merchants: number
    merchants_with_performance: number
    locations_with_performance: number
    latest_synced_at: string | null
  }
  totals: {
    total_views: PerformanceMetricTotal
    map_views: PerformanceMetricTotal
    search_views: PerformanceMetricTotal
    website_clicks: PerformanceMetricTotal
    direction_requests: PerformanceMetricTotal
    call_clicks: PerformanceMetricTotal
    action_events: PerformanceMetricTotal
  }
  trends: Array<{
    metric_date: string
    map_views: number
    search_views: number
    merchant_coverage: number
  }>
  merchants: Array<{
    merchant_id: number
    name: string
    primary_location: string | null
    data_status: 'ready' | 'unbound' | 'not_synced' | 'syncing' | 'failed' | 'no_performance'
    synced_at: string | null
    location_count: number
    total_views: number | null
    map_views: number | null
    search_views: number | null
    website_clicks: number | null
    direction_requests: number | null
    call_clicks: number | null
    review_average_rating: number | null
    review_reply_rate: number | null
    review_scope: string | null
  }>
}

export const api = {
  me: () => request<Operator>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<Operator>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  getPerformanceDashboard: () => request<PerformanceDashboard>('/api/dashboard/performance'),
  listMerchants: (status?: 'active' | 'archived') =>
    request<MerchantStats[]>(`/api/merchants${status ? `?status=${status}` : ''}`),
  createMerchant: (body: { name: string; notes?: string; primary_location?: string; website_url?: string }) =>
    request<Merchant>('/api/merchants', { method: 'POST', body: JSON.stringify(body) }),
  getMerchant: (id: number) => request<Merchant>(`/api/merchants/${id}`),
  getMerchantProfile: (id: number) => request<MerchantProfile>(`/api/merchants/${id}/profile`),
  getSeoTargets: (id: number) => request<SeoTargetState>(`/api/merchants/${id}/seo-targets`),
  refreshSeoTargets: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/seo-targets/refresh`, { method: 'POST' }),
  activateSeoKeywordVersion: (id: number, body: {
    artifact_id: number
    expected_active_artifact_id: number | null
    confirmed: true
  }) =>
    request<SeoTargetState>(`/api/merchants/${id}/seo-targets/activations`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  regenerateSeoTargets: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/seo-targets/regenerate`, { method: 'POST' }),
  syncLocalFalconReports: (id: number) =>
    request<SeoTargetState>(`/api/merchants/${id}/local-falcon-sync`, { method: 'POST' }),
  approveLocalFalconCohort: (id: number, body: { keyword_artifact_id: number; expected_cohort_sha256: string }) =>
    request<SeoTargetState>(`/api/merchants/${id}/local-falcon-approvals`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createLocalFalconScanBatch: (id: number, body: {
    approval_id: number
    request_id: string
    expected_scan_config_sha256: string
    confirm_credit_spend: true
  }) =>
    request<SeoTargetState>(`/api/merchants/${id}/local-falcon-scan-batches`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reconcileLocalFalconScanBatch: (id: number, batchId: number, body: LocalFalconReconciliationRequest) =>
    request<SeoTargetState>(`/api/merchants/${id}/local-falcon-scan-batches/${batchId}/reconcile`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  bindMerchantFbr: (id: number, fbrMerchantId: string) =>
    request<MerchantProfile>(`/api/merchants/${id}/fbr-link`, {
      method: 'PUT',
      body: JSON.stringify({ fbr_merchant_id: fbrMerchantId }),
    }),
  syncMerchantGbp: (id: number) =>
    request<MerchantProfile>(`/api/merchants/${id}/gbp-sync`, { method: 'POST' }),
  patchMerchant: (id: number, body: Partial<Pick<Merchant, 'name' | 'status' | 'notes' | 'primary_location' | 'website_url' | 'auto_run_interval_days'>>) =>
    request<Merchant>(`/api/merchants/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteMerchant: (id: number) => request<void>(`/api/merchants/${id}`, { method: 'DELETE' }),
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
  listAllTasks: (includeArchived = false) => request<(Task & { merchant_name: string })[]>(
    `/api/tasks${includeArchived ? '?include_archived=true' : ''}`,
  ),
  batchTasks: (ids: number[], status: TaskStatus) =>
    request<{ updated: number[]; skipped: number[] }>('/api/tasks/batch', { method: 'POST', body: JSON.stringify({ ids, status }) }),
}

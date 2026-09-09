/**
 * Types for the Task 9 merchant-scoped Performance read endpoints.
 *
 * Numbers arrive as canonical decimal strings, never JavaScript numbers --
 * the page must format them (thousands separators are fine) and must never
 * run arithmetic on them. `null` always means "no value", distinct from an
 * observed `"0"`.
 */

export type PerformanceLocationSummary = {
  location_id: number
  display_name: string
  timezone_name: string | null
  status: string
}

export type PerformanceLocations = {
  merchant_id: number
  history_read_enabled: boolean
  locations: PerformanceLocationSummary[]
}

export type ComparisonMode = 'previous_equal_length' | 'previous_complete_calendar_month' | 'custom'

/** Request body for POST /api/merchants/{id}/performance/query. */
export type MerchantPerformanceQuery = {
  location_ids?: number[]
  current?: { start: string; end: string }
  comparison?: { mode: ComparisonMode; start?: string; end?: string }
  // The API accepts only "day" -- weekly/monthly rollup does not exist.
  granularity?: 'day'
}

export type PeriodBasis = 'total' | 'daily_average'

export type MerchantPerformancePeriods = {
  current: { start: string; end: string; days: number }
  comparison: { start: string; end: string; days: number } | null
  mode: ComparisonMode
  basis: PeriodBasis
  granularity: 'day'
}

export type Availability = 'available' | 'unavailable'
export type Completeness = 'complete' | 'partial' | 'unknown'

export type KpiPeriodValue = {
  value: string | null
  availability: Availability
  completeness: Completeness
  observed: number
  expected: number
  data_through: string | null
}

export type DeltaReason = 'comparison_zero' | 'current_unavailable' | 'comparison_unavailable' | null

export type PerformanceKpi = {
  metric_key: string
  label: string
  unit: string
  formula_version: string
  current: KpiPeriodValue
  comparison: KpiPeriodValue | null
  delta: string | null
  delta_type: 'percent'
  delta_reason: DeltaReason
  comparison_basis: PeriodBasis
}

/**
 * `no_observation` -- this day was never synced. `metric_unavailable` -- an
 * observation exists but the source explicitly reported no data for this
 * metric. These are different facts for an account manager and must not
 * render the same.
 */
export type MissingReason = 'no_observation' | 'metric_unavailable' | null

export type PerformanceSeriesPoint = {
  date: string
  value: string | null
  availability: Availability
  completeness: Completeness
  missing_reason: MissingReason
}

export type PerformanceSeries = {
  metric_key: string
  label: string
  points: PerformanceSeriesPoint[]
}

/**
 * `source_data_through` is deliberately distinct from a KPI's period-scoped
 * `data_through`: it is the newest published batch across all time for
 * these scopes, not the last available day inside the requested period.
 */
export type PerformanceSource = {
  source: string
  date_basis: string
  source_data_through: string | null
  last_success_sync_at: string | null
  status: string
}

export type PerformanceQualityEvent = {
  source: string
  category: string
  severity: string
  start_date: string | null
  end_date: string | null
  status: string
  details: Record<string, unknown>
}

export type PerformanceBackfillNote = { business_date: string; metric_key: string }

export type MerchantPerformance = {
  contract_version: string
  formula_version: string
  merchant_id: number
  population_hash: string
  population: unknown
  periods: MerchantPerformancePeriods
  kpis: PerformanceKpi[]
  series: PerformanceSeries[]
  coverage: { current_days: number; comparison_days: number | null }
  quality: PerformanceQualityEvent[]
  sources: PerformanceSource[]
  backfill_notes: PerformanceBackfillNote[]
}

export type PerformanceBackfillBlocker = { code: string; detail: string; location_id?: number }

export type PerformanceBackfillPreflight = {
  merchant_id: number
  requested_start: string
  requested_end: string
  clamped_start: string
  clamped_end: string
  source_start_date: string
  locations: Array<{ location_id: number; display_name: string; timezone_name: string | null }>
  partitions: Array<{ partition_month: string; start: string; end: string }>
  batch_estimate: number
  blockers: PerformanceBackfillBlocker[]
}

export type PerformanceBackfillConfirmResult = {
  job_id: number
  batch_ids: number[]
  clamped_start: string
  clamped_end: string
}

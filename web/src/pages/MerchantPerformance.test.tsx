// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MerchantPerformance from './MerchantPerformance'
import { api } from '../api'

const LOCATIONS = {
  merchant_id: 3,
  history_read_enabled: true,
  locations: [{ location_id: 11, display_name: '2020 Broadway', timezone_name: 'America/New_York', status: 'active' }],
}

const BODY = {
  contract_version: 'seo_ops.merchant_performance.v1',
  formula_version: 'seo_ops.performance_metrics.v1',
  merchant_id: 3,
  population_hash: 'abc',
  population: { contract: 'seo_ops.performance_population.v1', merchant_id: 3, locations: [] },
  periods: {
    current: { start: '2026-09-01', end: '2026-09-02', days: 2 },
    comparison: { start: '2026-08-30', end: '2026-08-31', days: 2 },
    mode: 'previous_equal_length', basis: 'total', granularity: 'day',
  },
  kpis: [{
    metric_key: 'gbp_impressions_total', label: 'GBP 曝光', unit: 'count',
    formula_version: 'seo_ops.performance_metrics.v1',
    current: { value: '200', availability: 'available', completeness: 'complete', observed: 2, expected: 2, data_through: '2026-09-02' },
    comparison: { value: '100', availability: 'available', completeness: 'complete', observed: 2, expected: 2, data_through: '2026-08-31' },
    delta: '100.0', delta_type: 'percent', delta_reason: null, comparison_basis: 'total',
  }],
  series: [{
    metric_key: 'gbp_impressions_total', label: 'GBP 曝光',
    points: [
      { date: '2026-09-01', value: '100', availability: 'available', completeness: 'complete', missing_reason: null },
      { date: '2026-09-02', value: null, availability: 'unavailable', completeness: 'unknown', missing_reason: 'no_observation' },
    ],
  }],
  coverage: { current_days: 2, comparison_days: 2 },
  quality: [{
    source: 'GBP', category: 'source_omits_metric_rows', severity: 'yellow',
    start_date: '2026-09-02', end_date: '2026-09-02', status: 'open', details: { metric_key: 'CALL_CLICKS' },
  }],
  sources: [{
    source: 'GBP', date_basis: 'store_local', source_data_through: '2026-09-02',
    last_success_sync_at: '2026-09-09T06:00:00.000000Z', status: 'ready',
  }],
  backfill_notes: [{ business_date: '2026-09-01', metric_key: 'WEBSITE_CLICKS' }],
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/merchants/3/performance${search}`]}>
      <Routes><Route path="/merchants/:id/performance" element={<MerchantPerformance />} /></Routes>
    </MemoryRouter>,
  )
}

const ORIGINAL_TZ = process.env.TZ

beforeEach(() => {
  vi.spyOn(api, 'getPerformanceLocations').mockResolvedValue(LOCATIONS as never)
  vi.spyOn(api, 'queryMerchantPerformance').mockResolvedValue(BODY as never)
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); process.env.TZ = ORIGINAL_TZ })

describe('MerchantPerformance', () => {
  it('renders totals, the comparison and the delta from the server response', async () => {
    renderPage()
    expect(await screen.findByText('GBP 曝光')).toBeTruthy()
    expect(screen.getByText('200')).toBeTruthy()
    expect(screen.getByText(/vs 100/)).toBeTruthy()
    expect(screen.getByText(/\+100\.0%/)).toBeTruthy()
  })

  it('shows a missing day as 无数据 rather than zero', async () => {
    renderPage()
    const table = await screen.findByRole('table', { name: /逐日/ })
    const row = within(table).getByRole('row', { name: /2026-09-02/ })
    const valueCell = within(row).getAllByRole('cell')[0]
    expect(valueCell.textContent).toBe('无数据')
  })

  it('sends the period from the query string, and computes a clicked preset in the store timezone -- not the test runner clock', async () => {
    // Pin the process's own ambient timezone rather than trusting whatever
    // machine runs this suite: nothing in this repo pins TZ (no `TZ` in
    // package.json scripts, no vitest setup file, no CI workflow), so a
    // runner already sitting in an Americas zone (offset <= -3h -- which
    // includes all four store timezones this feature supports:
    // America/New_York, Chicago, Denver, Los_Angeles) would coincidentally
    // compute the same local date as the store timezone below even with the
    // pre-fix, ambient-clock bug, making the test pass either way. Asia/
    // Shanghai (UTC+8) is an offset >= -2h -- the bucket (all of Asia,
    // Europe, Africa, Oceania) where an ambient-clock computation provably
    // disagrees with the store's at the instant below, so this pin
    // guarantees the two diverge regardless of the host machine's real zone.
    process.env.TZ = 'Asia/Shanghai'
    // 2026-10-01T02:00:00Z is 2026-10-01 in that pinned Asia/Shanghai clock
    // (UTC+8) but still 2026-09-30 in the store's America/New_York timezone
    // (UTC-4, EDT) -- the two clocks disagree on both the day AND the
    // month. If "上月" used the ambient/test clock it would compute
    // September (2026-09-01..2026-09-30); computed correctly in the store's
    // timezone it must compute August (2026-08-01..2026-08-31).
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-10-01T02:00:00Z'))
    renderPage('?from=2026-09-01&to=2026-09-02&cmp=previous_equal_length&granularity=day')
    await waitFor(() => expect(api.queryMerchantPerformance).toHaveBeenCalledWith(3, expect.objectContaining({
      current: { start: '2026-09-01', end: '2026-09-02' },
      comparison: { mode: 'previous_equal_length' },
    }), expect.anything()))
    fireEvent.click(await screen.findByRole('button', { name: '上月' }))
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(api.queryMerchantPerformance).toHaveBeenCalledTimes(2))
    expect(api.queryMerchantPerformance).toHaveBeenLastCalledWith(3, expect.objectContaining({
      current: { start: '2026-08-01', end: '2026-08-31' },
    }), expect.anything())

    // "上月" only reads year and month, so it cannot tell the store-local
    // *yesterday* rule (referenceDateIso) apart from a same-month "today"
    // bug: at this pinned instant store-local today is 2026-09-30 and
    // store-local yesterday is 2026-09-29 -- both September, so either
    // reference computes the same "上月" (August) above. "最近 28 天" is
    // day-sensitive and discriminates cleanly: the correct
    // store-local-*yesterday* reference (2026-09-29) gives 2026-09-02
    // through 2026-09-29, while a reference of store-local *today*
    // (2026-09-30) -- the same bug this suite's ambient-clock case also
    // guards, just one day later -- would give 2026-09-03 through
    // 2026-09-30 instead.
    fireEvent.click(screen.getByRole('button', { name: '最近 28 天' }))
    fireEvent.click(screen.getByRole('button', { name: '应用筛选' }))
    await waitFor(() => expect(api.queryMerchantPerformance).toHaveBeenCalledTimes(3))
    expect(api.queryMerchantPerformance).toHaveBeenLastCalledWith(3, expect.objectContaining({
      current: { start: '2026-09-02', end: '2026-09-29' },
    }), expect.anything())
  })

  it('blocks the query and offers a timezone form when the store timezone is unset', async () => {
    vi.spyOn(api, 'getPerformanceLocations').mockResolvedValue({
      ...LOCATIONS,
      locations: [{ ...LOCATIONS.locations[0], timezone_name: null, status: 'needs_attention' }],
    } as never)
    renderPage()
    expect(await screen.findByText(/尚未设置时区/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '保存时区' })).toBeTruthy()
    expect(api.queryMerchantPerformance).not.toHaveBeenCalled()
  })

  it('lists data quality and correction notes', async () => {
    renderPage()
    expect(await screen.findByText(/来源未返回该指标行/)).toBeTruthy()
    expect(screen.getByText(/2026-09-01 · WEBSITE_CLICKS/)).toBeTruthy()
  })

  it('does not render a granularity control -- the API only ever accepts "day"', async () => {
    renderPage()
    await screen.findByText('GBP 曝光')
    expect(screen.queryByText('按天')).toBeNull()
    expect(screen.queryByText('按周')).toBeNull()
    expect(screen.queryByText('按月')).toBeNull()
    expect(screen.queryByRole('radiogroup')).toBeNull()
    expect(screen.queryByRole('group', { name: /粒度/ })).toBeNull()
  })

  it('distinguishes an unsynced day from a day the source reported as unavailable', async () => {
    vi.spyOn(api, 'queryMerchantPerformance').mockResolvedValue({
      ...BODY,
      periods: { ...BODY.periods, current: { start: '2026-09-01', end: '2026-09-03', days: 3 } },
      series: [{
        metric_key: 'gbp_impressions_total', label: 'GBP 曝光',
        points: [
          { date: '2026-09-01', value: '100', availability: 'available', completeness: 'complete', missing_reason: null },
          { date: '2026-09-02', value: null, availability: 'unavailable', completeness: 'unknown', missing_reason: 'no_observation' },
          { date: '2026-09-03', value: null, availability: 'unavailable', completeness: 'unknown', missing_reason: 'metric_unavailable' },
        ],
      }],
    } as never)
    renderPage()
    const table = await screen.findByRole('table', { name: /逐日/ })
    const unsyncedRow = within(table).getByRole('row', { name: /2026-09-02/ })
    const unavailableRow = within(table).getByRole('row', { name: /2026-09-03/ })
    const unsyncedCells = within(unsyncedRow).getAllByRole('cell')
    const unavailableCells = within(unavailableRow).getAllByRole('cell')
    expect(unsyncedCells[0].textContent).toBe('无数据')
    expect(unavailableCells[0].textContent).toBe('无数据')
    expect(unsyncedCells[1].textContent).not.toBe(unavailableCells[1].textContent)
  })
})

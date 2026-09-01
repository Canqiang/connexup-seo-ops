import { describe, expect, it } from 'vitest'
import { reportForDisplay } from './reportDisplay'

describe('reportForDisplay', () => {
  it('hides the fenced JSON plan while preserving the readable report', () => {
    const report = [
      '# 运营复盘',
      '',
      '本周应优先修复 GBP 营业时间。',
      '',
      '```json',
      '{"items":[{"source_key":"item-1","title":"更新营业时间"}]}',
      '```',
    ].join('\n')

    const displayed = reportForDisplay(report)

    expect(displayed).toContain('# 运营复盘')
    expect(displayed).toContain('本周应优先修复 GBP 营业时间。')
    expect(displayed).not.toContain('item-1')
    expect(displayed).not.toContain('```json')
  })

  it('keeps non-JSON code examples intact', () => {
    const report = '## Schema 建议\n\n```html\n<script type="application/ld+json">\n```'

    expect(reportForDisplay(report)).toBe(report)
  })
})

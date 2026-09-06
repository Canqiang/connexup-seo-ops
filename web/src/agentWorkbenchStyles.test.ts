import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./index.css', import.meta.url)), 'utf8')

function rgb(hex: string) {
  return [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
}

function luminance(hex: string) {
  return rgb(hex).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
}

function contrast(foreground: string, background: string) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (values[0] + .05) / (values[1] + .05)
}

describe('Agent Workbench styles', () => {
  it('workbench palette meets contrast contract', () => {
    for (const color of ['#2CCBB6', '#71D7AF', '#F2B56B', '#FF9A91', '#A9BDC9', '#FFFFFF']) expect(contrast(color, '#19324A')).toBeGreaterThanOrEqual(4.5)
    for (const color of ['#176B60', '#26765B', '#9D5712', '#B4372E', '#596F81']) expect(contrast(color, '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
    expect(css).toContain('.agent-workbench .agent-workbench__summary')
  })

  it('workbench accessibility fallbacks are scoped', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.agent-workbench__drawer/)
    expect(css).toMatch(/@media \(forced-colors: active\)[\s\S]*\.agent-workbench__drawer/)
    expect(css).toContain('.agent-workbench.agent-workbench__portal .agent-workbench__drawer')
    expect(css).toContain('.agent-workbench .agent-workbench__table-scroll')
    expect(css).toMatch(/overflow-x:\s*auto/)
  })
})

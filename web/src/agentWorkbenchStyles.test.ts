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

function cssVariable(name: string) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))
  if (!match) throw new Error(`Missing CSS variable ${name}`)
  return match[1].toUpperCase()
}

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`Missing CSS rule ${selector}`)
  return match[1]
}

function mediaBlocks(condition: string) {
  const marker = `@media (${condition})`
  const blocks: string[] = []
  let searchFrom = 0
  while (true) {
    const start = css.indexOf(marker, searchFrom)
    if (start < 0) break
    const open = css.indexOf('{', start + marker.length)
    let depth = 1
    let cursor = open + 1
    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1
      if (css[cursor] === '}') depth -= 1
      cursor += 1
    }
    blocks.push(css.slice(open + 1, cursor - 1))
    searchFrom = cursor
  }
  if (blocks.length === 0) throw new Error(`Missing media query ${condition}`)
  return blocks.join('\n')
}

function selectorsWithDeclaration(source: string, declaration: string) {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => declarations.includes(declaration))
    .flatMap(([, selectors]) => selectors.split(',').map(selector => selector.trim().replace(/\s+/g, ' ')))
}

function workbenchTokenMap() {
  return Object.fromEntries(
    [...rule('.agent-workbench').matchAll(/(--aw-[\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)]
      .map(([, name, value]) => [name, value.toUpperCase()]),
  )
}

describe('Agent Workbench styles', () => {
  it('workbench palette meets contrast contract', () => {
    expect(workbenchTokenMap()).toEqual({
      '--aw-stage': '#19324A',
      '--aw-page': '#F5F7F9',
      '--aw-card': '#FFFFFF',
      '--aw-live': '#2CCBB6',
      '--aw-live-dark': '#176B60',
      '--aw-success': '#26765B',
      '--aw-action-small': '#9D5712',
      '--aw-failure': '#B4372E',
      '--aw-stage-success': '#71D7AF',
      '--aw-stage-warning': '#F2B56B',
      '--aw-stage-failure': '#FF9A91',
      '--aw-secondary': '#596F81',
      '--aw-stage-divider': '#5E7F95',
      '--aw-stage-secondary': '#A9BDC9',
    })
    const stage = cssVariable('--aw-stage')
    const card = cssVariable('--aw-card')
    for (const name of ['--aw-live', '--aw-stage-success', '--aw-stage-warning', '--aw-stage-failure', '--aw-stage-secondary', '--aw-card']) {
      expect(contrast(cssVariable(name), stage), name).toBeGreaterThanOrEqual(4.5)
    }
    for (const name of ['--aw-live-dark', '--aw-success', '--aw-action-small', '--aw-failure', '--aw-secondary']) {
      expect(contrast(cssVariable(name), card), name).toBeGreaterThanOrEqual(4.5)
    }
    expect(cssVariable('--aw-action-small')).toBe('#9D5712')
    expect(rule('.agent-workbench .agent-workbench__operator-action')).toMatch(/border-color:\s*var\(--aw-action-small\)/)
    expect(rule('.agent-workbench .agent-workbench__operator-action')).toMatch(/background:\s*var\(--aw-action-small\)/)
    expect(css).not.toContain('#C66C14')
    expect(css).toContain('.agent-workbench .agent-workbench__summary')
  })

  it('reserves orange for actions and attention and bright teal for proven motion', () => {
    const orangeRules = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--aw-action-small\)[^{}]*)\}/g)]
    expect(orangeRules).toHaveLength(1)
    expect(orangeRules[0][1].trim()).toBe('.agent-workbench .agent-workbench__operator-action')
    expect(rule('.agent-workbench .agent-workbench__pending-range')).toMatch(/color:\s*var\(--aw-secondary\)/)
    const brightTealRules = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--aw-live\)[^{}]*)\}/g)]
    expect(brightTealRules).toHaveLength(2)
    for (const [, selector] of brightTealRules) {
      expect(selector.includes('signal--motion') || selector.trim() === '50%').toBe(true)
    }
    expect(rule('.agent-workbench .agent-workbench__range input:focus-visible + span')).toMatch(/outline:\s*3px solid var\(--aw-stage\)/)
    expect(rule('.agent-workbench .agent-workbench__signal:focus-visible')).toMatch(/outline:\s*3px solid var\(--aw-card\)/)
    expect(rule('.agent-workbench .agent-workbench__signal small')).toMatch(/color:\s*var\(--aw-stage-secondary\)/)
    expect(rule('.agent-workbench .agent-workbench__rail li[aria-current="step"] > span')).toMatch(/background:\s*var\(--aw-card\)/)
    expect(rule('.agent-workbench .agent-workbench__badge--disabled')).toMatch(/color:\s*var\(--aw-secondary\)/)
  })

  it('does not leak legacy registry list layout into history cards or badges', () => {
    expect(css).not.toMatch(/\.agent-workbench \.agent-workbench__registry\s+(?:ul|li)\s*\{/)
    expect(rule('.agent-workbench .agent-workbench__history > ol')).toMatch(/display:\s*grid/)
    expect(rule('.agent-workbench .agent-workbench__badges')).toMatch(/display:\s*flex/)
    expect(rule('.agent-workbench .agent-workbench__badges li')).toMatch(/display:\s*inline-flex/)
  })

  it('gives programmatic registry and execution-heading fallbacks explicit focus rings', () => {
    expect(rule('.agent-workbench .agent-workbench__registry:focus-visible')).toMatch(/outline:\s*3px solid var\(--aw-stage\)/)
    expect(rule('.agent-workbench .agent-workbench__stage-header h2:focus-visible')).toMatch(/outline:\s*3px solid var\(--aw-card\)/)
    const forcedColors = mediaBlocks('forced-colors: active')
    expect(forcedColors).toContain('.agent-workbench__registry:focus-visible')
    expect(forcedColors).toContain('.agent-workbench__stage-header h2:focus-visible')
    expect(forcedColors).toMatch(/outline:\s*3px solid Highlight/)
  })

  it('motion is exclusive to truthful motion selectors and fully disabled when reduced', () => {
    const workbenchCss = css.slice(css.indexOf('/* ---- Agent Workbench: truthful execution signal ---- */'))
    const animatedSelectors = new Set(
      [...workbenchCss.matchAll(/([^{}]+)\{([^{}]*animation:\s*[^{}]*)\}/g)]
        .filter(([, , declarations]) => [...declarations.matchAll(/animation:\s*([^;]+)/g)].some(([, value]) => value.trim() !== 'none'))
        .map(([, selector]) => selector.trim().replace(/\s+/g, ' ')),
    )
    const infiniteAnimations = [...workbenchCss.matchAll(/([^{}]+)\{[^{}]*animation:\s*([\w-]+)[^;{}]*\binfinite\b[^{}]*\}/g)]
      .map(([, selector, animation]) => ({ selector: selector.trim().replace(/\s+/g, ' '), animation }))
    expect(infiniteAnimations).toEqual([
      { selector: '.agent-workbench .agent-workbench__signal--motion .agent-workbench__signal-dot', animation: 'aw-live-pulse' },
      { selector: '.agent-workbench .agent-workbench__stage:has(.agent-workbench__signal--motion) .agent-workbench__signal-detail--motion .agent-workbench__rail li[aria-current="step"] > span', animation: 'aw-rail-pulse' },
    ])

    const reducedMotion = mediaBlocks('prefers-reduced-motion: reduce')
    const animationNoneSelectors = new Set(selectorsWithDeclaration(reducedMotion, 'animation: none'))
    for (const selector of animatedSelectors) expect(animationNoneSelectors.has(selector), selector).toBe(true)
    for (const selector of [
      '.agent-workbench .agent-workbench__signal--motion .agent-workbench__signal-dot',
      '.agent-workbench .agent-workbench__signal-detail--motion .agent-workbench__rail li[aria-current="step"] > span',
      '.agent-workbench .agent-workbench__stage:has(.agent-workbench__signal--motion) .agent-workbench__signal-detail--motion .agent-workbench__rail li[aria-current="step"] > span',
      '.agent-workbench .agent-workbench__receipt--enter',
      '.agent-workbench.agent-workbench__portal .agent-workbench__drawer',
      '.agent-workbench.agent-workbench__portal .agent-workbench__receipt',
    ]) expect(animationNoneSelectors.has(selector), selector).toBe(true)
    const staticScrollSelectors = new Set(selectorsWithDeclaration(reducedMotion, 'scroll-behavior: auto'))
    for (const selector of [
      '.agent-workbench .agent-workbench__signals',
      '.agent-workbench .agent-workbench__table-scroll',
      '.agent-workbench.agent-workbench__portal .agent-workbench__drawer',
    ]) expect(staticScrollSelectors.has(selector), selector).toBe(true)
  })

  it('forced colors preserve borders, selection, status text, and focus without animation', () => {
    const forcedColors = mediaBlocks('forced-colors: active')
    for (const selector of [
      '.agent-workbench__summary',
      '.agent-workbench__registry',
      '.agent-workbench__table-scroll',
      '.agent-workbench__history-item',
      '.agent-workbench.agent-workbench__portal .agent-workbench__drawer',
    ]) expect(forcedColors).toContain(selector)
    expect(forcedColors).toMatch(/border-color:\s*CanvasText/)
    expect(forcedColors).toContain('.agent-workbench__range input:checked + span')
    expect(forcedColors).toContain('.agent-workbench__signal[aria-selected="true"]')
    expect(forcedColors).toMatch(/outline:\s*2px solid Highlight/)
    expect(forcedColors).toContain('.agent-workbench__badge')
    expect(forcedColors).toMatch(/color:\s*CanvasText/)
    expect(forcedColors).toContain(':focus-visible')
    expect(forcedColors).toMatch(/outline:\s*3px solid Highlight/)
    expect(forcedColors).not.toMatch(/animation\s*:/)
  })

  it('workbench overflow and drawer selectors remain scoped', () => {
    expect(css).toContain('.agent-workbench.agent-workbench__portal .agent-workbench__drawer')
    expect(rule('.agent-workbench .agent-workbench__table-scroll')).toMatch(/overflow-x:\s*auto/)
  })
})

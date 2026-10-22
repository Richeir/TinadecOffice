/**
 * The desktop palette has to have exactly one "brand" answer, and it lives in
 * two places: the `:root[data-theme]` floor in `styles.css`, and the default
 * accent in `useTheme.ts`. Only the ~60 properties listed in
 * `monetExtract.buildDynamicVars` get overwritten at runtime, so whatever the
 * CSS floor says is what the app actually renders for `--text-link`, the
 * terminal selection tint, canvas themes and every `var(--x, …)` fallback.
 *
 * That is how the old teal brand survived next to a blue accent: two sources,
 * two answers. The brand is the poster lilac now, so both sources carry the
 * same two hex values and these assertions keep a stray copy-paste from
 * reintroducing a third answer.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { ACCENT_COLORS, DEFAULT_ACCENT } from './composables/useTheme'

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

function themeBlock(theme: 'dark' | 'light'): Record<string, string> {
  const marker = `:root[data-theme="${theme}"] {`
  const start = css.indexOf(marker)
  if (start < 0) throw new Error(`styles.css is missing ${marker}`)
  const end = css.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated ${marker}`)

  const vars: Record<string, string> = {}
  for (const line of css.slice(start + marker.length, end).split('\n')) {
    const match = /^\s*(--[\w-]+):\s*(.+?);\s*$/.exec(line)
    if (match) vars[match[1]!] = match[2]!.trim()
  }
  return vars
}

const dark = themeBlock('dark')
const light = themeBlock('light')

const BRAND_DARK = '#d2bdf5'
const BRAND_LIGHT = '#675687'

describe('styles.css accent floor', () => {
  it('defaults to the same lilac the theme pipeline picks', () => {
    expect(dark['--accent-primary']).toBe(BRAND_DARK)
    expect(dark['--accent-brand']).toBe(BRAND_DARK)
    expect(dark['--text-brand']).toBe(BRAND_DARK)

    expect(light['--accent-primary']).toBe(BRAND_LIGHT)
    expect(light['--accent-brand']).toBe(BRAND_LIGHT)
    expect(light['--text-brand']).toBe(BRAND_LIGHT)
  })

  it('agrees with the accent preset useTheme ships as default', () => {
    // If these drift, an install that has never written localStorage renders
    // one colour before the first injection and another one after it.
    const preset = ACCENT_COLORS.find((c) => c.key === DEFAULT_ACCENT)
    expect(preset, `DEFAULT_ACCENT "${DEFAULT_ACCENT}" has no preset`).toBeTruthy()
    expect(preset!.dark.accentPrimary).toBe(BRAND_DARK)
    expect(preset!.light.accentPrimary).toBe(BRAND_LIGHT)
  })

  it('keeps links on the brand lilac', () => {
    // `--text-link` is deliberately outside the Monet injection, so this CSS
    // value is what every unstyled link renders.
    expect(dark['--text-link']).toBe(dark['--accent-primary'])
    expect(light['--text-link']).toBe(light['--accent-primary'])
  })

  it('carries none of the retired palettes', () => {
    const lower = css.toLowerCase()
    const retired = ['#2ec4b6', '#1f8f80', '#1f6f68', '#58a6ff', '#0969da', '#0a0e14', '#11151c', '#1a1f29']
    for (const value of retired) {
      expect(lower, `styles.css still ships the retired value ${value}`).not.toContain(value)
    }
  })

  it('keeps semantic colors away from the accent family', () => {
    // Success/approval green must read the same under every accent.
    expect(dark['--accent-success']).toBe('#3fb950')
    expect(light['--accent-success']).toBe('#1a7f37')
    expect(dark['--text-error']).toBe('#f85149')
  })

  it('tints the surfaces purple rather than blue-black', () => {
    // A blue-black floor under a lilac accent is the same two-source bug in a
    // quieter form: the app reads as "lavender UI on a navy page".
    expect(dark['--bg-primary']).toBe('#15121a')
    expect(light['--bg-secondary']).toBe('#faf7fd')
  })
})

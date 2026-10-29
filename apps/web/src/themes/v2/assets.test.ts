import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { v2Assets, v2Stylesheet } from './assets.ts'

const css = v2Stylesheet.body
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]+\{|@supports[^{]+\{|@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').split('}').map(rule => rule.trim()).filter(Boolean)

describe('v2 stylesheet asset', () => {
  it('is versioned by content hash and stays well inside the browser budget', () => {
    expect(v2Stylesheet.href).toBe(`/assets/themes/v2/styles.css?v=${createHash('sha256').update(css).digest('hex').slice(0, 16)}`)
    expect(v2Stylesheet.contentType).toBe('text/css; charset=utf-8')
    expect(v2Assets).toEqual([v2Stylesheet])
    expect(Object.isFrozen(v2Assets)).toBe(true)
    // The product budget is 60 KB gzip per route chunk; the whole v2 stylesheet stays under a fifth of it.
    expect(gzipSync(css).byteLength).toBeLessThan(12 * 1024)
  })

  it('scopes every rule to the v2 root or a v2-owned class or id, and never styles classic classes', () => {
    for (const rule of rules) {
      const selectors = rule.slice(0, rule.indexOf('{'))
      if (!selectors.trim()) continue
      for (const selector of selectors.split(/,(?![^(]*\))/)) {
        expect(selector.trim(), rule).toMatch(/^(?::where\(\[data-ui-theme="v2"\]\)|\[data-ui-theme="v2"\]|\.v2-|#xp-toast-region)/)
      }
    }
    expect(css).not.toMatch(/\.xp-/)
    expect(css).not.toContain('/*')
  })

  it('lays out right to left through logical properties only', () => {
    expect(css).not.toMatch(/(?:^|[;{\s])(?:margin|padding|border)-(?:left|right)\b/)
    expect(css).not.toMatch(/(?:^|[;{\s])(?:left|right)\s*:/)
    expect(css).not.toMatch(/(?:text-align|float|clear)\s*:\s*(?:left|right)/)
    // Four-value margin/padding shorthands are physical on the inline axis unless both sides match.
    for (const [, , , right, , left] of css.matchAll(/(?:^|[;{])(margin|padding):\s*([^;}\s]+)\s+([^;}\s]+)\s+([^;}\s]+)\s+([^;}\s]+)\s*[;}]/g)) expect(right).toBe(left)
    expect(css).toContain('.v2-flip:dir(rtl){transform:scaleX(-1)}')
  })

  it('defines light tokens, the dark override and the Arabic font override', () => {
    expect(css).toMatch(/^\[data-ui-theme="v2"\]\{color-scheme:light;/)
    expect(css).toContain('[data-ui-theme="v2"][data-theme="dark"]{color-scheme:dark;')
    expect(css).toContain('[data-ui-theme="v2"]:lang(ar){--font-sans:sans-serif}')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
  })
})

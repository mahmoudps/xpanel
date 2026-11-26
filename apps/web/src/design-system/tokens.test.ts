import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_FONT_SIZES_PX,
  ALLOWED_RADII_PX,
  ALLOWED_SPACING_PX,
  DESIGN_TOKENS,
  DESIGN_TOKENS_CSS,
  SEMANTIC_DARK_COLORS,
  SEMANTIC_LIGHT_COLORS,
  SIDEBAR_NAV_COLORS,
} from './tokens.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const GENERATOR_PATH = resolve(HERE, '../../../../scripts/generate-design-tokens.mjs')

describe('design-system single-source tokens', () => {
  it('matches generated CSS and TypeScript modules against tokens.json', () => {
    const out = execFileSync(process.execPath, [GENERATOR_PATH, '--check'], { encoding: 'utf8' })
    expect(out).toContain('Design tokens are in sync')
    expect(readFileSync(resolve(HERE, 'styles/tokens.css'), 'utf8')).toBe(DESIGN_TOKENS_CSS)
  })

  it('enforces exact spacing, radius, and typography scales', () => {
    expect([...ALLOWED_SPACING_PX]).toEqual([4, 8, 12, 16, 24, 32, 48, 64])
    expect([...ALLOWED_RADII_PX]).toEqual([8, 12, 999])
    expect([...ALLOWED_FONT_SIZES_PX]).toEqual([12, 13, 14, 16, 20, 26, 32])

    for (const size of Object.keys(DESIGN_TOKENS.typography.sizes)) {
      const enLh = Number.parseFloat(DESIGN_TOKENS.typography.lineHeights.en[size as keyof typeof DESIGN_TOKENS.typography.lineHeights.en])
      const arLh = Number.parseFloat(DESIGN_TOKENS.typography.lineHeights.ar[size as keyof typeof DESIGN_TOKENS.typography.lineHeights.ar])
      expect(arLh).toBeGreaterThanOrEqual(enLh)
    }
  })

  it('caps semantic color slots at <= 35 with full light/dark parity and white workspace sidebar', () => {
    const lightKeys = Object.keys(SEMANTIC_LIGHT_COLORS)
    const darkKeys = Object.keys(SEMANTIC_DARK_COLORS)
    expect(lightKeys.length).toBeLessThanOrEqual(35)
    expect(darkKeys).toEqual(lightKeys)

    expect(SIDEBAR_NAV_COLORS.workspaceLight.nav).toBe('#FFFFFF')
    expect(SIDEBAR_NAV_COLORS.xwhmLight.nav).toBe('#0A1830')
    expect(DESIGN_TOKENS_CSS).toContain('[data-ui-theme="v2"][data-surface="xpanel"]:not([data-theme="dark"])')
    expect(DESIGN_TOKENS_CSS).toContain('.ds-shell[data-surface="xpanel"]>.ds-sidebar')
    expect(DESIGN_TOKENS_CSS).toContain('--nav:#FFFFFF;')
    expect(DESIGN_TOKENS_CSS).toContain('--radius-control:8px;--radius-chip:8px;--radius-pill:999px')
  })

  it('keeps font stacks compliant with Arabic shaping and omits !important or CSS comments', () => {
    expect(DESIGN_TOKENS.typography.fonts.mono.split(',')).not.toContain('monospace')
    expect(DESIGN_TOKENS_CSS).not.toContain('!important')
    expect(DESIGN_TOKENS_CSS).not.toContain('/*')
  })
})

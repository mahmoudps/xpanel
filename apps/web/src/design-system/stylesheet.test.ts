import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  compactDesignCss,
  DESIGN_SYSTEM_BASE_CSS,
  DESIGN_SYSTEM_COMPONENTS_CSS,
  DESIGN_SYSTEM_FOUNDATION_CSS,
  DESIGN_SYSTEM_LAYOUTS_CSS,
  DESIGN_SYSTEM_OVERLAYS_CSS,
  DESIGN_SYSTEM_SHELL_CSS,
} from './stylesheet.ts'
import { renderAppShell } from './components/app-shell.ts'

const STYLES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'styles')

describe('design-system real CSS stylesheets', () => {
  it('bans !important, comments, physical direction properties, and raw hex colors outside tokens.css', () => {
    const physicalProperty = /(?:^|[{;])\s*(?:margin|padding|border)-(?:left|right)\s*:|(?:^|[{;])\s*(?:left|right)\s*:|text-align\s*:\s*(?:left|right)\b/i
    const hexColor = /#[0-9a-fA-F]{3,8}\b/
    for (const file of readdirSync(STYLES_DIR)) {
      const raw = readFileSync(resolve(STYLES_DIR, file), 'utf8')
      expect(raw, `${file} must not use !important`).not.toContain('!important')
      if (file !== 'tokens.css') {
        expect(raw, `${file} must not hardcode hex colors outside tokens.css`).not.toMatch(hexColor)
      }
      expect(raw, `${file} must use CSS logical properties only`).not.toMatch(physicalProperty)
    }
  })

  it('keeps served compacted CSS free of comments and well under gzip size budgets', () => {
    const bundle = [
      DESIGN_SYSTEM_FOUNDATION_CSS,
      DESIGN_SYSTEM_OVERLAYS_CSS,
      DESIGN_SYSTEM_COMPONENTS_CSS,
      DESIGN_SYSTEM_LAYOUTS_CSS,
    ].join('')
    for (const chunk of [DESIGN_SYSTEM_BASE_CSS, DESIGN_SYSTEM_SHELL_CSS, DESIGN_SYSTEM_OVERLAYS_CSS, DESIGN_SYSTEM_COMPONENTS_CSS, DESIGN_SYSTEM_LAYOUTS_CSS]) {
      expect(chunk).not.toContain('/*')
      expect(chunk.length).toBeGreaterThan(20)
    }
    expect(gzipSync(DESIGN_SYSTEM_FOUNDATION_CSS).byteLength).toBeLessThan(12 * 1024)
    expect(gzipSync(bundle).byteLength).toBeLessThan(20 * 1024)
  })

  it('preserves descendant combinators before pseudo-classes and aligns collapsed shell selectors', () => {
    expect(compactDesignCss(':where([data-ui-theme="v2"]) :is(a, button):focus-visible { outline: 2px solid var(--focus); }'))
      .toBe(':where([data-ui-theme="v2"]) :is(a,button):focus-visible{outline:2px solid var(--focus)}')
    expect(DESIGN_SYSTEM_BASE_CSS).toContain(':where([data-ui-theme="v2"]) :is(')
    expect(DESIGN_SYSTEM_BASE_CSS).not.toContain(':where([data-ui-theme="v2"]):is(')

    const shellHtml = renderAppShell({
      surface: 'xwhm',
      brandHtml: '<span>xWHM</span>',
      navGroups: [{ id: 'home', title: 'Home', items: [{ id: 'dash', label: 'Dashboard', href: '/whm', current: true }] }],
      topbarHtml: '',
      contentHtml: '',
      collapsed: true,
    })
    expect(shellHtml).toContain('class="ds-shell" data-surface="xwhm" data-sidebar-collapsed="true"')
    expect(DESIGN_SYSTEM_SHELL_CSS).toContain('.ds-shell[data-sidebar-collapsed="true"]')
    expect(DESIGN_SYSTEM_SHELL_CSS).toContain('.ds-shell[data-sidebar-collapsed="true"] .ds-nav-link__label')
  })
})

import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { parseMarkup } from '../markup.ts'
import { classicWhmBackupClientTemplates } from '../../board-port/whm-backup-client-templates.ts'
import { v2Stylesheet } from './assets.ts'
import { v2SharedStylesheets, v2StylesheetsForDocument } from './route-assets.ts'
import { v2WhmBackupClientTemplates } from './pages/xwhm/lifecycle/backup-client-templates.ts'
import { v2SoftwareCenterTemplates } from './pages/xwhm/software/software-center-client-templates.ts'
import { siteHealthClientTemplates } from './pages/xpanel/diagnostic-client-templates.ts'

const routeCss = (surface: 'xpanel' | 'xwhm', route: string): string => v2StylesheetsForDocument({ surface, route, viewKind: 'workspace' }).map(asset => asset.body).join('\n')
const hasClass = (value: string | undefined, name: string): boolean => (value ?? '').split(/\s+/).includes(name)

describe('selected V2 dynamic fragment styling', () => {
  it.each([['classic', classicWhmBackupClientTemplates, 'xp-whm-backup-actions'], ['v2', v2WhmBackupClientTemplates, 'v2-lifecycle__actions']] as const)('retains the %s action group inside the cloned pager and each multi-action backup cell', (_theme, templates, actionsClass) => {
    const nodes = parseMarkup(templates())
    for (const name of ['pager', 'destination-row', 'run-row']) {
      const template = nodes.findIndex(node => node.attrs.get('data-xp-template') === 'whm-backup-' + name)
      const buttons = nodes.filter(node => node.template === template && node.tag === 'button')
      expect(buttons).toHaveLength(2)
      for (const button of buttons) expect(hasClass(nodes[button.parent]?.attrs.get('class'), actionsClass)).toBe(true)
    }
    expect(routeCss('xwhm', '/whm/backups')).toContain('.v2-lifecycle__actions,.v2-lifecycle__choices{display:flex;flex-wrap:wrap;gap:16px;align-items:center}')
  })
  it('styles the actual radio ring with server-driven selected and disabled states', () => {
    const nodes = parseMarkup(v2WhmBackupClientTemplates())
    const template = nodes.findIndex(node => node.attrs.get('data-xp-template') === 'whm-backup-radio')
    const radio = nodes.find(node => node.template === template && node.attrs.get('role') === 'radio')!
    expect(radio.attrs.has('disabled')).toBe(true)
    expect(radio.attrs.get('aria-checked')).not.toBe('true')
    const css = routeCss('xwhm', '/whm/backups/restore')
    expect(css).toContain('.v2-lifecycle__radio-ring{display:inline-flex;align-items:center;justify-content:center;flex:none;inline-size:18px;block-size:18px;border:2px solid var(--line-strong);border-radius:50%}')
    expect(css).toContain('[role=radio][aria-checked=true] .v2-lifecycle__radio-ring::after')
    expect(css).toContain('[role=radio]:disabled{color:var(--muted);background:var(--sunken);cursor:not-allowed}')
    expect(css).toContain('[data-approved-whm-backups] [role=radiogroup]{display:flex;flex-direction:column;gap:16px;min-inline-size:0}')
  })
  it('keeps dynamic software groups in the existing scroll boundary with distinct text and group spacing', () => {
    const nodes = parseMarkup(v2SoftwareCenterTemplates())
    const group = nodes.find(node => node.attrs.has('data-sc-group'))!
    expect(hasClass(group.attrs.get('class'), 'v2-whm-data__stack')).toBe(true)
    const scroll = nodes.find(node => node.attrs.get('data-xp-slot') === 'scroll')!
    expect(hasClass(scroll.attrs.get('class'), 'v2-whm-data__scroll')).toBe(true)
    expect(nodes.some(node => hasClass(node.attrs.get('class'), 'v2-whm-data__table'))).toBe(false)
    const css = routeCss('xwhm', '/whm/software/catalog')
    expect(css).toContain('.v2-whm-data__scroll{min-inline-size:0;max-inline-size:100%;overflow-x:auto}')
    expect(css).toContain('.v2-whm-data[data-whm-software-center] .v2-software-center__identity{display:flex;flex-direction:column;gap:var(--space-1);min-inline-size:0}')
  })
  it('loads neutral health chips on the health route without preselecting an observed result', () => {
    const chip = parseMarkup(siteHealthClientTemplates()).find(node => node.attrs.has('data-state-chip'))!
    expect(chip.attrs.get('data-state-chip')).toBe('')
    const css = routeCss('xpanel', '/health')
    expect(css).toContain('.v2-panel-extra [data-site-health] [data-state-chip]{display:inline-flex')
    expect(css).toContain('background:var(--sunken);color:var(--muted)')
    for (const state of ['ok', 'problem', 'unavailable']) expect(css).toContain('.v2-panel-extra [data-site-health] [data-state-chip=' + state + ']')
    expect(routeCss('xpanel', '/advanced/network-tools')).not.toContain('[data-site-health] [data-state-chip]')
  })
  it.each(['/whm/backups', '/whm/backups/restore', '/whm/software/catalog', '/whm/software/runtimes', '/whm/software/modules', '/health'])('preserves the existing strict compressed asset budget for %s', route => {
    const assets = [v2Stylesheet, ...v2SharedStylesheets, ...v2StylesheetsForDocument({ surface: route.startsWith('/whm/') ? 'xwhm' : 'xpanel', route, viewKind: 'workspace' })]
    expect(assets.reduce((sum, asset) => sum + gzipSync(asset.body).byteLength, 0)).toBeLessThanOrEqual(60 * 1024)
  })
})

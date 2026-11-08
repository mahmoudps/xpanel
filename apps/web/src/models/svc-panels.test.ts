import { describe, expect, it } from 'vitest'
import { renderClassicSvcPanels } from '../board-port/svc-panels-workspace.ts'
import { SVC_PANELS } from './svc-panels.ts'
import { SVC_PANELS_CLIENT_BINDING, svcGet, svcRows, svcSet, svcShow, svcWafFiles } from '../svc-panels-client.ts'
import { v2Messages } from '../themes/v2/messages.ts'
import { renderV2SvcPanels } from '../themes/v2/pages/xwhm/svc-panels.ts'

const words = { none: 'Not read', yes: 'Yes', no: 'No' }
const show = (value: unknown, format = 'text', labels: Record<string, string> | null = null): string => svcShow(value, format, labels, words, value => 'at ' + value)
const hooksOf = (html: string): string[] => [...new Set(html.match(/data-svc-[a-z-]+="[^"]*"/g) ?? [])].sort()
const t = v2Messages.translator('en')

describe('services centre panels', { tags: ['unit'] }, () => {
  it('walks dotted paths and never turns a missing value into a number', () => {
    expect(svcGet({ a: { b: [1, 2] } }, 'a.b.length')).toBe(2)
    expect(show(undefined)).toBe('Not read')
    expect(show(0)).toBe('0')
    expect(show(false, 'yes-no')).toBe('No')
    expect(show(0o700, 'octal')).toBe('0700')
    expect(show('applied', 'text', { applied: 'Applied' })).toBe('Applied')
    expect(show(['one', 'two'])).toBe('one; two')
  })
  it('shows every source build state, and Panel settings carries the panel in both themes', () => {
    const panel = SVC_PANELS['/whm/panel/settings']!.find(item => item.id === 'source-builds')!
    const state = panel.sections[0]!.tables![0]!.columns.find(column => column.path === 'state')!
    expect(Object.keys(state.labels!)).toEqual(['current', 'stale', 'rebuilding', 'rebuild_failed'])
    expect(panel.read).toBe('/api/server/services/source-builds')
  })
  it('sets dotted paths and lists an object of rows by key', () => {
    const target = {}
    svcSet(target, 'a.b', 1)
    expect(target).toEqual({ a: { b: 1 } })
    expect(svcRows({ alice: { mail: false } })).toEqual([{ key: 'alice', value: { mail: false } }])
    expect(svcRows(null)).toEqual([])
  })
  it('marks each rule file with its own switch', () => {
    const view = svcWafFiles({ policy: { crsDisabledFiles: ['b.conf'], vendors: [{ id: 'acme', disabledFiles: [] }] }, observation: { crs: ['a.conf', 'b.conf'], vendors: { acme: ['c.conf'] } } })
    expect(view.files).toEqual([{ vendor: 'crs', file: 'a.conf', enabled: true }, { vendor: 'crs', file: 'b.conf', enabled: false }, { vendor: 'acme', file: 'c.conf', enabled: true }])
  })
  it('draws the same hooks in both themes on every route', () => {
    for (const route of Object.keys(SVC_PANELS)) {
      const classic = renderClassicSvcPanels(route, { locale: 'en', canRead: true, canManage: () => true })
      const v2 = renderV2SvcPanels(route, t, 'en', true, () => true)
      expect(hooksOf(v2), route).toEqual(hooksOf(classic))
      expect(classic, route).toContain('data-svc-status')
    }
  })
  it('keeps write controls closed for a tool the activation gate has not admitted', () => {
    const html = renderClassicSvcPanels('/whm/security/isolation', { locale: 'en', canRead: true, canManage: tool => tool === 'traceroute-toggle' })
    expect(html).toMatch(/data-svc-panel="fork-bomb"[^>]*data-svc-can-manage="false"/)
    expect(html).toMatch(/data-svc-panel="traceroute"[^>]*data-svc-can-manage="true"/)
  })
  it('draws nothing on other routes and is a browser-safe binding', () => {
    expect(renderClassicSvcPanels('/whm', { locale: 'en', canRead: true, canManage: () => true })).toBe('')
    expect(renderV2SvcPanels('/whm', t, 'en', true, () => true)).toBe('')
    expect(() => new Function('return ' + SVC_PANELS_CLIENT_BINDING)).not.toThrow()
  })
})

import { describe, expect, it } from 'vitest'
import { AUTHORITATIVE_CONTROLLER_DECLARATIONS } from './controller-hooks.ts'
import { checkControllerDeclarations } from './controller-conformance.ts'
import { parseMarkup } from './markup.ts'
import { renderV2PanelHome } from './v2/pages/xpanel/home.ts'

const legacyIds = ['panel-home-desktop-filter', 'panel-home-phone-filter', 'home-desktop-filter-ids', 'home-phone-filter-ids', 'home-group-controls-relation']
const homeRules = AUTHORITATIVE_CONTROLLER_DECLARATIONS.filter(item => legacyIds.includes(item.id) || item.id === 'panel-home-tools')
const legacy = '<section data-home-desktop><input id="home-header-search" type="search" aria-describedby="tool-filter-count"><input id="tool-filter" type="search"><p id="tool-filter-count" role="status"></p></section><section data-home-phone><input id="m-filter" type="search"><p id="m-filter-count" role="status"></p><button type="button" data-home-action="toggle-group" aria-controls="m-group-tools-0">Files</button><ul id="m-group-tools-0" data-tool-panel><li>File manager</li></ul></section>'
const wrap = (body: string, theme: 'classic' | 'v2' | 'default' | 'fragment'): string => theme === 'fragment' ? body
  : `<html${theme === 'default' ? '' : ` data-ui-theme="${theme}"`}><body>${body}</body></html>`
const check = (body: string, theme: 'classic' | 'v2' | 'default' | 'fragment') => checkControllerDeclarations(parseMarkup(wrap(body, theme)), homeRules, { route: '/home', surface: 'xpanel', qualified: true })

describe('Home controller ownership across themes', () => {
  it.each(['classic', 'default', 'fragment'] as const)('keeps complete legacy controls valid for %s rendering', theme => {
    expect(homeRules).toHaveLength(6)
    expect(check(legacy, theme)).toEqual([])
  })

  it.each(['classic', 'default', 'fragment'] as const)('does not waive a missing real desktop filter for %s rendering', theme => {
    const issues = check(legacy.replace('<input id="tool-filter" type="search">', ''), theme)
    expect(issues.some(issue => issue.controller === 'panel-home-desktop-filter' && issue.name === '#tool-filter')).toBe(true)
    expect(issues.some(issue => issue.controller === 'home-desktop-filter-ids' && issue.name === '#tool-filter')).toBe(true)
  })

  it('keeps the Classic phone filter mandatory', () => {
    const issues = check(legacy.replace('<input id="m-filter" type="search">', ''), 'classic')
    expect(issues.some(issue => issue.controller === 'panel-home-phone-filter' && issue.name === '#m-filter')).toBe(true)
    expect(issues.some(issue => issue.controller === 'home-phone-filter-ids' && issue.name === '#m-filter')).toBe(true)
  })

  it('keeps the Classic group target inside the owning phone scope', () => {
    const body = legacy.replace('aria-controls="m-group-tools-0"', 'aria-controls="m-group-tools-1"') + '<ul id="m-group-tools-1" data-tool-panel></ul>'
    expect(check(body, 'classic').some(issue => issue.controller === 'home-group-controls-relation' && issue.kind === 'relation')).toBe(true)
  })

  it.each(['en', 'ar'] as const)('accepts the real single responsive V2 Home in %s without legacy stand-in controls', locale => {
    const body = renderV2PanelHome({ locale })
    expect(body).toContain('data-panel-home')
    expect(body).not.toContain('data-home-desktop')
    expect(body).not.toContain('data-home-phone')
    expect(check(body, 'v2')).toEqual([])
  })

  it.each(['en', 'ar'] as const)('still rejects missing V2 filtering in %s', locale => {
    const body = renderV2PanelHome({ locale }).replace(' data-home-filter aria-controls=', ' aria-controls=')
    const issues = check(body, 'v2')
    expect(issues.some(issue => issue.controller.startsWith('panel-home-tools') && issue.kind === 'hook' && issue.name === 'input[data-home-filter]')).toBe(true)
    expect(issues.every(issue => !legacyIds.includes(issue.controller))).toBe(true)
  })

  it('keeps the V2 result-count target globally unique', () => {
    const body = renderV2PanelHome({ locale: 'en' }) + '<p id="tool-filter-count">Another count</p>'
    expect(check(body, 'v2').some(issue => issue.controller === 'panel-home-tools' && issue.kind === 'relation')).toBe(true)
  })

  it('keeps the independent V2 home controller required when the owning root is missing', () => {
    const body = renderV2PanelHome({ locale: 'en' }).replace(' data-panel-home', ' data-removed-home')
    expect(check(body, 'v2').some(issue => issue.controller === 'panel-home-tools' && issue.kind === 'controller')).toBe(true)
  })
})
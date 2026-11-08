import { describe, expect, it } from 'vitest'
import { translator } from './i18n.ts'
import { DESIGN_TOKENS_CSS, PHONE_TABLE_ROWS_CSS } from './tokens.ts'
import { V2_BASE_CSS, V2_PHONE_TABLE_ROWS_CSS } from './themes/v2/base.ts'
import { v2StylesheetsForDocument } from './themes/v2/route-assets.ts'
import { renderWhmServiceClientTemplates } from './board-port/whm-service-client-templates.ts'
import { renderWhmServiceManagerWorkspace } from './board-port/whm-service-manager-workspace.ts'
import { renderV2WhmServiceClientTemplates } from './themes/v2/pages/xwhm/host/service-client-templates.ts'
import { dataTable } from './themes/v2/components/data-table.ts'
import { WHM_SERVICES_CSS } from './themes/v2/pages/xwhm/host/services.ts'

const t = translator('en')

describe('phone table rows keep two columns instead of scrolling sideways', () => {
  // V2 carries the rows in each page stylesheet, outside the shared foundation that every document loads.
  const v2Page = v2StylesheetsForDocument({ surface: 'xwhm', route: '/whm/services' }).map(asset => asset.body).join('')
  for (const [theme, sheet, block] of [['classic', DESIGN_TOKENS_CSS, PHONE_TABLE_ROWS_CSS], ['v2', v2Page, V2_PHONE_TABLE_ROWS_CSS]] as const) {
    it(`lays every ${theme} row out as the name opposite its value on a phone`, () => {
      expect(sheet).toContain(block)
      expect(block).toMatch(/^@media ?\(max-width: ?600px\) ?\{/)
      expect(block).toMatch(/min-(?:inline-size|width): ?0 ?!important/)
      expect(block).toMatch(/tr(?::not\(\[hidden\]\))? ?\{ ?display: ?grid; ?grid-template-columns: ?minmax\(0, ?1fr\) fit-content\(50%\)/)
    })
  }

  it('keeps the V2 phone rows out of the shared foundation', () => {
    expect(V2_BASE_CSS).not.toContain(V2_PHONE_TABLE_ROWS_CSS)
  })

  it('names a fact on the same line where the value does not name itself', () => {
    expect(PHONE_TABLE_ROWS_CSS).toMatch(/\[data-phone-label\]::before ?\{ ?content: ?attr\(data-phone-label\)/)
    expect(WHM_SERVICES_CSS).toContain('.v2-services [data-phone-label]::before{content:attr(data-phone-label)')
  })

  it('lets a classic table whose browser acceptance pins a scrolling layout keep its columns', () => {
    expect(PHONE_TABLE_ROWS_CSS).toContain(':is(table,.xp-table):not(.xp-table--columns,')
    // A classic matrix scrolls inside its region with the first column frozen.
    expect(PHONE_TABLE_ROWS_CSS).toMatch(/:first-child ?\{ ?position: ?sticky; ?inset-inline-start: ?0/)
  })

  it('leaves the tables that already lay out their own phone rows to their own rules', () => {
    for (const own of ['.xp-accounts__table', '[data-section="audit-log"] *', '.xp-whm-dns *']) expect(PHONE_TABLE_ROWS_CSS).toContain(own)
    for (const own of ['.v2-whm-quotas__table', ':is(.v2-identity-rows,.v2-boxtrapper,[data-leech-protection]) *']) expect(V2_PHONE_TABLE_ROWS_CSS).toContain(own)
  })

  it('shows the active state opposite each service unit and labels the other facts in both themes', () => {
    const ar = translator('ar')
    expect(renderWhmServiceManagerWorkspace({ locale: 'ar', canRead: true, canManage: true })).toContain('class="xp-table xp-whm-detail-table xp-table--value-3"')
    for (const render of [renderWhmServiceClientTemplates, renderV2WhmServiceClientTemplates]) {
      const manager = render('manager', 'ar'), host = render('host', 'ar')
      for (const label of ['Substate', 'Start at boot']) expect(manager).toContain(`data-phone-label="${ar(label)}"`)
      for (const label of ['Role', 'Version', 'Uptime', 'Memory']) expect(host).not.toContain(`data-phone-label="${ar(label)}"`)
      for (const label of ['Active state', 'Load state']) expect(manager).not.toContain(`data-phone-label="${ar(label)}"`)
    }
    // The services page puts the facts under the name and its state as one wrapping line.
    expect(WHM_SERVICES_CSS).toMatch(/\.v2-services tbody tr:not\(\[hidden\]\)\{display:flex!important;flex-wrap:wrap/)
    expect(dataTable(t, { id: 'units', caption: 'Units', columns: [{ label: 'Unit' }], rows: [], phoneValueColumn: 3 })).toContain('class="v2-table v2-table--value-3"')
  })
})

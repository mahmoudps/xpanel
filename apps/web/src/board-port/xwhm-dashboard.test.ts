import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
import { renderWhmDashboard, whmDashboardFixture, whmDashboardFromProps } from './xwhm-dashboard.ts'

describe('xWHM dashboard board port', () => {
  it('keeps the board regions in the sample fixture', () => {
    const html = renderWhmDashboard(whmDashboardFixture())
    for (const marker of ['Search tools and accounts', '>Create account</a>', 'id="rec-title"', 'Server resources', 'role="meter"', 'id="acc-title"', 'id="host-title"', 'Recent audit entries', 'Check for drift now', 'Generation 142 · active']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('Activity & Jobs'), false)
    assert.equal(html.includes('Sign out'), false)
  })

  it('keeps the same cards when the host has not reported measurements', () => {
    const html = renderWhmDashboard(whmDashboardFromProps({ locale: 'en', principal: { username: 'root' } }))
    for (const marker of ['id="rec-title"', 'id="host-title"', 'Server resources', 'role="meter"', 'Near a limit', '>Create account</a>']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('alice'), false)
    assert.equal(html.includes('karim'), false)
    assert.equal(html.includes('>41<'), false)
    assert.equal(html.includes('data-generation-chip='), false)
    assert.match(html, /data-host-observation="unavailable"/)
    const product = renderWhmSurface({ principal: { kind: 'root', id: 'root', username: 'root' }, activeRoute: '/whm' })
    assert.match(product, /data-board-port="xwhm-dashboard"/)
    assert.match(product, /aria-label="Search tools and accounts"/)
    assert.doesNotMatch(product, /Activity & Jobs|Sign out|data-generation-chip=/)
  })
})

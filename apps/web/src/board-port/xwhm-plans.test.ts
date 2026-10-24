import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan } from '@xpanel/core'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
import { gateAccepts, padPort, sameCapture, scoreGate } from './board-gate.ts'
import { PNG } from 'pngjs'
import { renderWhmPlansFixture } from './xwhm-plans.ts'

const solid = (width: number, height: number): Buffer => {
  const png = new PNG({ width, height })
  png.data.fill(255)
  return PNG.sync.write(png)
}

describe('plans board port', () => {
  it('keeps the board sample in the fixture and off the product route', () => {
    const fixture = renderWhmPlansFixture()
    assert.match(fixture, /data-board-port="xwhm-plans"/)
    assert.match(fixture, /data-plan-editor-form="true"/)
    assert.match(fixture, /1 unsaved change/)
    assert.match(fixture, /alice-shop.com/)
    assert.match(fixture, /\/dev\/sda/)
    assert.equal(fixture.includes('data-dc-tpl'), false)
    assert.doesNotMatch(fixture, /id="dc-root"|<x-dc|data-sc-name/)

    const product = renderWhmSurface({
      locale: 'en',
      activeRoute: '/whm/plans',
      principal: { kind: 'root', id: 'root', username: 'root' },
      hostname: 'srv1.xpanel.test',
      plans: [defaultPlan({ id: 'observed-plan', name: 'Observed plan', featureListId: 'observed-features' })],
      accounts: [],
    })
    assert.match(product, /data-surface|data-board-port="xwhm-plans"/)
    assert.match(product, /Observed plan/)
    assert.match(product, /data-plan-editor-form="true"/)
    assert.doesNotMatch(product, /alice-shop\.com|omar-clinic|10\.0\.0\.16|\/dev\/sda|31 accounts|9 accounts/)
    assert.match(product, /MiB/)
  })

  it('does not invent an account count or a slice device when they were not read', () => {
    const product = renderWhmSurface({
      locale: 'en',
      activeRoute: '/whm/plans',
      principal: { kind: 'root', id: 'root', username: 'root' },
      plans: [defaultPlan({ id: 'p', name: 'Observed plan', featureListId: 'features' })],
    })
    assert.equal(product.includes('/dev/sda'), false)
    assert.match(product, /The host name was not read/)
    assert.match(product, /The account count was not read/)
    assert.equal(product.includes('0 accounts'), false)
  })

  it('refuses a byte-identical capture and fails a 1px pad marker', () => {
    const png = solid(20, 20)
    const score = scoreGate(png, png)
    assert.equal(score.pass, true)
    assert.equal(gateAccepts({ score, board: png, app: png, negativePass: false }), false)
    assert.equal(sameCapture(png, png), true)
    const html = '<div class="xp-board-port" data-board-port="xwhm-plans" style="min-height:100vh">'
    assert.match(padPort(html, 'xwhm-plans'), /padding-top:1px/)
  })
})

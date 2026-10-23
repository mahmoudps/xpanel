import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ARABIC_TYPE_CSS, BOARD_SANS_LTR, BOARD_SANS_RTL } from './arabic-type.ts'
import { renderFidelityDocument as renderDashboard } from './board-port/xwhm-dashboard.ts'
import { renderFidelityDocument as renderHome } from './board-port/xpanel-home.fixture.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'

const rootFace = /class="xp-board-port"[^>]*style="[^"]*font-family:/

describe('Arabic typography layer', () => {
  it('keeps the Arabic scale off the LTR tracking values', () => {
    assert.ok(ARABIC_TYPE_CSS.includes(BOARD_SANS_RTL))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 14.5px !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('line-height: 1.75 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 12.5px !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 12px !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-weight: 500 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('letter-spacing: 0 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 24px !important'))
    assert.equal(ARABIC_TYPE_CSS.includes('0.02em'), false)
    assert.equal(ARABIC_TYPE_CSS.includes('0.04em'), false)
    assert.equal(ARABIC_TYPE_CSS.includes('0.06em'), false)
    assert.ok(DESIGN_TOKENS_CSS.includes(BOARD_SANS_RTL))
    assert.ok(DESIGN_TOKENS_CSS.includes('html[lang="ar"]'))
  })

  it('moves the board-port face onto a class the RTL rule can override', () => {
    for (const html of [renderHome('ltr'), renderHome('phone'), renderDashboard('ltr')]) {
      assert.equal(rootFace.test(html), false)
      assert.ok(html.includes(BOARD_SANS_LTR))
      assert.equal(html.includes('dir="rtl"'), false)
    }
    for (const html of [renderHome('ar'), renderDashboard('rtl')]) {
      assert.equal(rootFace.test(html), false)
      assert.ok(html.includes('dir="rtl"'))
      assert.ok(html.includes(BOARD_SANS_RTL))
      assert.ok(html.includes('font-size: 14.5px !important'))
      assert.equal(html.includes('letter-spacing: 0.02em'), false)
    }
  })
})

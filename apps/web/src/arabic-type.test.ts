import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ARABIC_TYPE_CSS, BOARD_SANS_LTR, BOARD_SANS_RTL } from './arabic-type.ts'
import { isolateLtrRuns } from './bidi-runs.ts'
import { renderFidelityDocument as renderDashboard } from './board-port/xwhm-dashboard.ts'
import { renderFidelityDocument as renderHome } from './board-port/xpanel-home.fixture.ts'
import { DESIGN_TOKENS_CSS } from './tokens.ts'

/** Dates left in text after every `<bdi dir="ltr">` island is removed. */
const bareDirectionalRuns = (html: string): string[] => {
  let previous = ''
  let current = html
  const island = /<bdi\b[^>]*\bdir="ltr"[^>]*>[\s\S]*?<\/bdi>/g
  while (current !== previous) {
    previous = current
    current = current.replace(island, '')
  }
  const text = current.replace(/<[^>]+>/g, ' ')
  return text.match(/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/g) ?? []
}

const rootFace = /class="xp-board-port"[^>]*style="[^"]*font-family:/

describe('Arabic typography layer', () => {
  it('keeps the Arabic scale off the LTR tracking values', () => {
    assert.ok(ARABIC_TYPE_CSS.includes(BOARD_SANS_RTL))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 16px !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('line-height: 1.75 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 14px !important'))
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
      assert.ok(html.includes('font-size: 16px !important'))
      assert.equal(html.includes('letter-spacing: 0.02em'), false)
      assert.deepEqual(bareDirectionalRuns(html), [])
    }
  })

  it('keeps a date inside an Arabic phrase in source order', () => {
    const home = renderHome('ar')
    assert.match(home, /آخر نسخة <bdi dir="ltr">2026-10-21<\/bdi>/)
    assert.match(home, /<bdi dir="ltr">2026-11-01<\/bdi>/)
    assert.equal(isolateLtrRuns('طُبّق 13:48 UTC'), 'طُبّق <bdi dir="ltr">13:48 UTC</bdi>')
    assert.equal(isolateLtrRuns('3.2 / 10 GB'), '3.2 / 10 GB')
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { ARABIC_TYPE_CSS, BOARD_SANS_LTR, BOARD_SANS_RTL, isArabicSentence } from './arabic-type.ts'
import { isolateLtrRuns, metaPieces } from './bidi-runs.ts'
import { renderFidelityDocument as renderDashboard, renderWhmDashboard, whmDashboardFromProps } from './board-port/xwhm-dashboard.ts'
import { renderInbox, xmailInboxFromProps } from './board-port/xmail-inbox.ts'
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
    assert.ok(ARABIC_TYPE_CSS.includes('[data-meta-label]'))
    assert.ok(ARABIC_TYPE_CSS.includes('flex-shrink: 0 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('white-space: nowrap !important'))
    assert.equal(ARABIC_TYPE_CSS.includes('[data-tool="true"] > a > bdi'), false)
    assert.ok(ARABIC_TYPE_CSS.includes('letter-spacing: 0 !important'))
    assert.ok(ARABIC_TYPE_CSS.includes('font-size: 24px !important'))
    assert.equal(ARABIC_TYPE_CSS.includes('0.02em'), false)
    assert.equal(ARABIC_TYPE_CSS.includes('0.04em'), false)
    assert.equal(ARABIC_TYPE_CSS.includes('0.06em'), false)
    assert.ok(DESIGN_TOKENS_CSS.includes(BOARD_SANS_RTL))
    assert.ok(DESIGN_TOKENS_CSS.includes('html[lang="ar"]'))
    assert.match(DESIGN_TOKENS_CSS, /html\[lang="ar"\] \{[^}]*--xp-leading-body: 28px/)
    assert.equal(/html\[lang="ar"\] \{[^}]*--xp-leading-body: 26px/.test(DESIGN_TOKENS_CSS), false)
    assert.match(ARABIC_TYPE_CSS, /html\[lang="ar"\] body,\nhtml\[dir=rtl\] body \{ font-family: [^;]+; line-height: 1\.75; \}/)
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
    assert.match(home, /data-meta title="آخر نسخة 2026-10-21"/)
    assert.match(home, /data-meta-label>آخر نسخة<\/span><bdi data-meta-value dir="ltr"[^>]*>2026-10-21<\/bdi>/)
    assert.match(home, /data-meta-value dir="ltr"[^>]*>6<\/bdi><span data-meta-label>عناصر<\/span>/)
    assert.match(home, /data-meta title="3\.2 \/ 10 GB"[^>]*>[\s\S]*data-meta-value dir="ltr"[^>]*>3\.2 \/ 10 GB<\/bdi>/)
    assert.match(home, /<bdi dir="ltr">2026-11-01<\/bdi>/)
    assert.deepEqual(metaPieces('آخر نسخة 2026-10-21'), [
      { kind: 'label', text: 'آخر نسخة' },
      { kind: 'value', text: '2026-10-21' },
    ])
    assert.deepEqual(metaPieces('6 عناصر'), [
      { kind: 'value', text: '6' },
      { kind: 'label', text: 'عناصر' },
    ])
    assert.deepEqual(metaPieces('1,431 اليوم'), [
      { kind: 'value', text: '1,431' },
      { kind: 'label', text: 'اليوم' },
    ])
    assert.deepEqual(metaPieces('3.2 / 10 GB'), [{ kind: 'value', text: '3.2 / 10 GB' }])
    assert.deepEqual(metaPieces('مستخدمان'), [{ kind: 'value', text: 'مستخدمان' }])
    assert.equal(isolateLtrRuns('طُبّق 13:48 UTC'), 'طُبّق <bdi dir="ltr">13:48 UTC</bdi>')
    assert.equal(isolateLtrRuns('3.2 / 10 GB'), '3.2 / 10 GB')
  })

  it('sets a whole Arabic sentence in the sans stack and keeps identifiers mono', () => {
    assert.equal(isArabicSentence('لا حسابات قرب الحد'), true)
    assert.equal(isArabicSentence('سجل داخلي'), true)
    assert.equal(isArabicSentence('صندوق بريد'), true)
    assert.equal(isArabicSentence('جار القراءة'), true)
    assert.equal(isArabicSentence('المالك غير متاح'), true)
    assert.equal(isArabicSentence('الجيل 142'), true)
    assert.equal(isArabicSentence('karim'), false)
    assert.equal(isArabicSentence('omar-clinic.net'), false)
    assert.equal(isArabicSentence('info@alice-shop.com'), false)
    assert.equal(isArabicSentence('/home/omar/public_html'), false)
    assert.equal(isArabicSentence('nginx 1.24.0'), false)
    assert.equal(isArabicSentence('None'), false)
    const dashboard = renderWhmDashboard(whmDashboardFromProps({ locale: 'ar', nearLimits: [] }))
    assert.match(dashboard, /class="xp-ar-sentence"[^>]*>لا حسابات قرب الحد</)
    assert.equal(dashboard.includes("font-family: 'IBM Plex Mono', monospace\">لا حسابات قرب الحد"), false)
    const english = renderWhmDashboard(whmDashboardFromProps({ locale: 'en', nearLimits: [] }))
    assert.match(english, /font-family: 'IBM Plex Mono', monospace">None</)
    assert.equal(english.includes('class="xp-ar-sentence"'), false)
    assert.equal(english.includes('dir="rtl"'), false)
  })

  it('lets a live-shaped inbox row and address shrink inside the page', () => {
    const message = {
      uid: 7,
      folder: 'INBOX',
      from: 'procurement.notices@very-long-vendor-name.example.test',
      fromName: 'International Procurement Notices Desk',
      to: 'orders.and.customer.care.desk@alice-shop.example.test',
      cc: 'karim.mansour.operations@alice-shop.example.test',
      subject: 'Shipment',
      preview: 'Friday',
      body: 'Friday',
      receivedAt: '2026-10-22T14:00:00Z',
      unread: true,
    }
    for (const locale of ['en', 'ar'] as const) {
      const html = renderInbox(xmailInboxFromProps({ locale, mailbox: 'owner@department.alice-shop.example.test', messages: [message] }))
      assert.match(html, /data-mail-name="true" style="min-width: 0/)
      assert.match(html, /data-mail-addr="true" style="min-width: 0; max-width: 100%[^"]*overflow-wrap: anywhere/)
      assert.match(html, /data-mail-mailbox="true" style="min-width: 0[^"]*overflow-wrap: anywhere/)
    }
    assert.match(ARABIC_TYPE_CSS, /data-mail-addr/)
    assert.match(ARABIC_TYPE_CSS, /xp-ar-sentence/)
    assert.match(ARABIC_TYPE_CSS, /a\[data-usage-link\]/)
  })
})

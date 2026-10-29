import { SYNTHETIC_WEBSITE_ANALYTICS, SYNTHETIC_WHM_IO_SNAPSHOT } from '../../../tests/fixtures/analytics-snapshots.ts'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import * as readableDateTimeTokens from './tokens.ts'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderWebApp, serveStaticAsset } from './app.ts'
import { localeDirection, translator } from './i18n.ts'
import {
  formatAsciiBytes,
  formatAsciiDate,
  formatUtcClock,
  formatUtcDay,
  formatAsciiNumber,
  formatAsciiPercent,
  normalizeAsciiDigits,
  renderLtrValue,
} from './tokens.ts'
import { renderMailSurface, type MailSurfaceProps } from './surfaces/xmail.ts'
import { renderPanelSurface, type PanelSurfaceProps } from './surfaces/xpanel.ts'
import { renderWhmSurface, type WhmSurfaceProps } from './surfaces/xwhm.ts'
import { createLiveEventStore, renderReconcileBanner } from './ws-client.ts'
import {
  DESIGN_TOKENS_CSS,
  classifyHttpActionState,
  renderAsyncActionState,
} from './tokens.ts'

const EASTERN_ARABIC_DIGIT_RE = /[\u0660-\u0669\u06f0-\u06f9]/
const syntheticPlan = defaultPlan({ id: 'rtl-plan', name: 'Synthetic RTL plan', featureListId: 'rtl-features' })
const syntheticAccount: Account = {
  id: 'rtl-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: syntheticPlan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'info@alice-shop.com',
  ipv4: '10.0.0.12', shell: 'none', createdAt: '2026-10-22T14:05:00Z',
}
const syntheticWhm: WhmSurfaceProps = {
  principal: { kind: 'root', id: 'rtl-root', username: 'synthetic-root' }, hostname: 'srv1.xpanel.test', accounts: [syntheticAccount], plans: [syntheticPlan], ioSnapshot: SYNTHETIC_WHM_IO_SNAPSHOT,
  ipPool: [{ id: 'rtl-ip', address: '10.0.0.12', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Synthetic RTL sample' }],
}
const syntheticPanel: PanelSurfaceProps = {
  account: syntheticAccount, plan: syntheticPlan, websiteAnalytics: SYNTHETIC_WEBSITE_ANALYTICS,
  files: [{ name: 'rtl.txt', path: '/home/alice/public_html/rtl.txt', kind: 'file', sizeBytes: 42, modeOctal: '0640', modifiedAt: '2026-10-22T14:05:00Z' }],
  domains: [{ id: 'rtl-domain', accountId: syntheticAccount.id, name: 'alice-shop.com', kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'static', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }],
}
const syntheticMail: MailSurfaceProps = { mailbox: 'info@alice-shop.com', quotaUsedMb: 42, quotaLimitMb: 1024, messages: [], sieveRules: [] }

describe('H03 & Q02 — Bilingual UX/UI, RTL <bdi dir="ltr"> isolation, ASCII digits, focusable table regions & non-deceptive async states (A29, A30, A56, A57, A58)', () => {
  it('A29 & A56: normalizes and formats all numbers, bytes, percentages, dates, and i18n interpolations as Western ASCII digits (0-9)', () => {
    assert.equal(normalizeAsciiDigits('٢٠٢٦-١٠-٢٢ ١٤:٠٥:٠٠'), '2026-10-22 14:05:00')
    assert.equal(normalizeAsciiDigits('۹۸٬۷۶۵٫۴۳'), '98,765.43')
    assert.equal(formatAsciiNumber(1234567.89, { decimals: 2 }), '1,234,567.89')
    assert.equal(formatAsciiBytes(15 * 1024 * 1024), '15.7 MB')
    assert.equal(formatAsciiPercent(84.5), '84.5%')
    assert.equal(formatAsciiDate('2026-10-22T14:05:09.000Z', { includeTime: true }), '2026-10-22 14:05 UTC')
    assert.equal(formatUtcClock('2026-10-22T17:29:00.000Z'), '17:29 UTC')
    assert.equal(formatUtcDay('2026-10-22T22:30:00.000Z'), '2026-10-22 UTC')

    const arTranslated = translator('ar')('{filesCount} files · {durationMs} ms · sha256 {checksum}', {
      filesCount: '٣٨',
      durationMs: 184,
      checksum: '9f86d081884c',
    })
    assert.equal(EASTERN_ARABIC_DIGIT_RE.test(arTranslated), false)
    assert.match(arTranslated, /38/)
    assert.match(arTranslated, /184/)

    for (const locale of ['en', 'ar'] as const) {
      const loginDoc = renderWebApp({ surface: 'login', locale })
      const routeScreens = [
        ...['/whm', '/whm/accounts', '/whm/plans', '/whm/server/ips', '/whm/monitoring/io'].map(activeRoute => renderWhmSurface({ ...syntheticWhm, activeRoute, locale })),
        ...['/home', '/domains', '/files/manager', '/metrics/traffic', '/advanced/terminal'].map(activeRoute => renderPanelSurface({ ...syntheticPanel, activeRoute, locale })),
        ...['/mail/inbox', '/mail/compose', '/mail/settings/filters', '/mail/settings/autoresponder', '/mail/overview'].map(activeRoute => renderMailSurface({ ...syntheticMail, activeRoute, locale })),
      ]
      for (const html of [loginDoc, ...routeScreens]) {
        assert.equal(
          EASTERN_ARABIC_DIGIT_RE.test(html),
          false,
          `Surface in locale=${locale} must never contain Eastern Arabic digits`,
        )
      }
    }
  })

  it('preserves the complete observed SHA256 checksum in isolated reconcile metadata for English and Arabic', () => {
    const checksum = '0123456789abcdef'.repeat(4)
    for (const locale of ['en', 'ar'] as const) {
      const live = createLiveEventStore()
      assert.doesNotMatch(renderReconcileBanner(live.getState(), locale), /class="xp-reconcile-meta /)
      live.dispatch({ id: 'full-checksum-event', at: '2026-10-27T10:30:00Z', kind: 'reconcile.applied', scope: { accountId: null }, data: { generationId: 143, stateChecksum: checksum, filesCount: 38, durationMs: 184 } })
      const html = renderReconcileBanner(live.getState(), locale)
      const metadata = html.match(/<span class="xp-reconcile-meta [^>]*>([\s\S]*?)<\/span>/)?.[1]
      assert.ok(metadata, 'Observed reconciliation includes its metadata')
      const checksumValue = metadata.match(/<bdi dir="ltr"[^>]*>([^<]+)<\/bdi>/)?.[1]
      assert.equal(checksumValue, checksum, 'The visible checksum retains every observed character')
      assert.equal(live.getState().reconcile.stateChecksum, checksum, 'Display does not alter observed state')
      assert.equal(EASTERN_ARABIC_DIGIT_RE.test(metadata), false)
    }
  })

  it('A56 & A57: enforces RTL document direction, <bdi dir="ltr"> isolation on technical tokens, and inline-start alignment for LTR inputs in RTL', () => {
    assert.equal(localeDirection('ar'), 'rtl')
    assert.equal(localeDirection('en'), 'ltr')

    const isolatedJob = renderLtrValue('JOB-٠٠٠١٤٢', 'xp-mono')
    assert.equal(isolatedJob, '<bdi dir="ltr" class="xp-mono">JOB-000142</bdi>')

    const whmAr = ['/whm/accounts', '/whm/server/ips'].map(activeRoute => renderWhmSurface({ ...syntheticWhm, activeRoute, locale: 'ar' })).join('\n')
    const panelAr = renderPanelSurface({ ...syntheticPanel, activeRoute: '/domains', locale: 'ar' })
    const mailAr = renderMailSurface({ ...syntheticMail, activeRoute: '/mail/inbox', locale: 'ar' })
    const live = createLiveEventStore()
    live.dispatch({ id: 'rtl-event', at: '2026-10-22T14:05:00Z', kind: 'reconcile.applied', scope: { accountId: null }, data: { generationId: 142, stateChecksum: '9f86d081884c', filesCount: 38, durationMs: 184 } })
    const reconcileAr = renderReconcileBanner(live.getState(), 'ar')

    // Verify technical tokens (hostname, slice units, paths, domains, IPs, emails, sha256) are wrapped in <bdi dir="ltr">
    assert.match(whmAr, /<bdi dir="ltr"[^>]*>srv1\.xpanel\.test<\/bdi>/)
    assert.match(whmAr, /<bdi dir="ltr">xpanel-20014\.slice<\/bdi>/)
    assert.match(whmAr, /<bdi dir="ltr">10\.0\.0\.12\/24<\/bdi>/)
    assert.match(reconcileAr, /<bdi dir="ltr"[^>]*>9f86d081884c<\/bdi>/)
    assert.match(reconcileAr, /38/)
    assert.match(reconcileAr, /184/)
    assert.match(panelAr, /<bdi dir="ltr">\/home\/alice\/public_html<\/bdi>/)
    assert.match(panelAr, /<bdi dir="ltr">alice-shop\.com<\/bdi>/)
    assert.match(mailAr, /<bdi dir="ltr"[^>]*>info@alice-shop\.com<\/bdi>/)

    // Verify CSS rules isolate <bdi dir="ltr"> and align RTL inputs with dir="ltr" to the right (inline-start in RTL)
    assert.match(DESIGN_TOKENS_CSS, /bdi\[dir="ltr"\][\s\S]*?direction:\s*ltr;[\s\S]*?unicode-bidi:\s*isolate;/)
    assert.match(
      DESIGN_TOKENS_CSS,
      /html\[dir="rtl"\]\s+\.xp-input\[dir="ltr"\][\s\S]*?text-align:\s*right;/,
    )
  })

  it('A29, A56, A57 & A58: wraps all data tables in keyboard-focusable scrollable regions (role="region" tabindex="0" aria-label) with <th scope="col"> and responsive 360px/200% zoom rules', () => {
    for (const locale of ['en', 'ar'] as const) {
      for (const html of [
        renderWhmSurface({ ...syntheticWhm, activeRoute: '/whm/accounts', locale }),
        renderPanelSurface({ ...syntheticPanel, activeRoute: '/domains', locale }),
        renderMailSurface({ ...syntheticMail, activeRoute: '/mail/settings/filters', locale }),
      ]) {
        const tableWraps = [...html.matchAll(/<div(?=[^>]*\sclass="(?:[^"]*\s)?xp-table-wrap(?:\s[^"]*)?")([^>]*)>/g)]
        assert.ok(tableWraps.length >= 1, 'Expected at least one .xp-table-wrap in surface')
        for (const match of tableWraps) {
          const attrs = match[1] ?? ''
          assert.match(attrs, /\brole="region"/, `.xp-table-wrap missing role="region": ${attrs}`)
          assert.match(attrs, /\btabindex="0"/, `.xp-table-wrap missing tabindex="0": ${attrs}`)
          assert.match(attrs, /\baria-label="[^"]+"/, `.xp-table-wrap missing aria-label: ${attrs}`)
        }

        const thTags = [...html.matchAll(/<th(\s+[^>]*|\s*)>/g)]
        assert.ok(thTags.length >= 4, 'Expected table header cells')
        for (const th of thTags) {
          assert.match(th[1] ?? '', /\bscope="col"/, `<th> missing scope="col": ${th[0]}`)
        }
      }
    }

    // Verify responsive CSS collapses multi-column shells and tri-pane webmail at <= 960px and <= 480px (360px mobile & 200% zoom)
    assert.match(DESIGN_TOKENS_CSS, /@media\s*\(max-width:\s*960px\)[\s\S]*?\.xp-mail-tri-pane[\s\S]*?grid-template-columns:\s*1fr/)
    // Both forms are a single flexible track; minmax(0, 1fr) also contains wide children.
    assert.match(DESIGN_TOKENS_CSS, /@media\s*\(max-width:\s*480px\)[\s\S]*?\.xp-kpi-grid[\s\S]*?grid-template-columns:\s*(?:1fr|minmax\(\s*0\s*,\s*1fr\s*\))\s*;/)
  })

  it('A30, A57 & A58: classifies HTTP 202 / queued / unverified responses as pending (never deceptive success) and renders accessible action states in en and ar', () => {
    // HTTP 202 Accepted or queued/running/unobserved MUST map to 'pending', never 'succeeded'
    assert.equal(classifyHttpActionState({ httpStatus: 202, status: 'queued' }), 'pending')
    assert.equal(classifyHttpActionState({ httpStatus: 200, status: 'running' }), 'pending')
    assert.equal(classifyHttpActionState({ httpStatus: 200, observed: false }), 'pending')

    // Permission denied, conflict, unavailable, failed, succeeded
    assert.equal(classifyHttpActionState({ httpStatus: 403, errorCode: 'FORBIDDEN' }), 'denied')
    assert.equal(classifyHttpActionState({ httpStatus: 409, errorCode: 'CONFLICT' }), 'conflict')
    assert.equal(classifyHttpActionState({ httpStatus: 412, errorCode: 'PRECONDITION_FAILED' }), 'unavailable')
    assert.equal(classifyHttpActionState({ httpStatus: 503, errorCode: 'UNAVAILABLE' }), 'unavailable')
    assert.equal(classifyHttpActionState({ httpStatus: 422, status: 'failed' }), 'failed')
    assert.equal(classifyHttpActionState({ httpStatus: 200, status: 'applied', observed: true }), 'succeeded')

    const pendingBannerAr = renderAsyncActionState({
      state: 'pending',
      locale: 'ar',
      jobId: 'JOB-000001',
      generationId: 142,
      httpStatus: 202,
    })
    assert.match(pendingBannerAr, /data-action-state="pending"/)
    assert.match(pendingBannerAr, /data-preserve-draft="true"/)
    assert.match(pendingBannerAr, /data-deceptive-success="false"/)
    assert.match(pendingBannerAr, /aria-busy="true"/)
    assert.match(pendingBannerAr, /<bdi dir="ltr">JOB-000001<\/bdi>/)
    assert.match(pendingBannerAr, /<bdi dir="ltr">#142<\/bdi>/)
    assert.equal(EASTERN_ARABIC_DIGIT_RE.test(pendingBannerAr), false)

    for (const state of ['loading', 'pending', 'succeeded', 'denied', 'failed', 'unavailable', 'conflict'] as const) {
      const enHtml = renderAsyncActionState({ state, locale: 'en', jobId: 'JOB-000009' })
      const arHtml = renderAsyncActionState({ state, locale: 'ar', jobId: 'JOB-000009' })
      assert.match(enHtml, new RegExp(`data-action-state="${state}"`))
      assert.match(arHtml, new RegExp(`data-action-state="${state}"`))
      assert.equal(EASTERN_ARABIC_DIGIT_RE.test(enHtml), false)
      assert.equal(EASTERN_ARABIC_DIGIT_RE.test(arHtml), false)
    }

    // Verify surface integration with actionState
    const panelWithConflict = renderPanelSurface({
      ...syntheticPanel, activeRoute: '/home',
      locale: 'ar',
      actionState: {
        state: 'conflict',
        httpStatus: 409,
        errorCode: 'CONFLICT',
        jobId: 'JOB-000077',
      },
    })
    assert.match(panelWithConflict, /data-action-state="conflict"/)
    assert.match(panelWithConflict, /data-preserve-draft="true"/)
    assert.match(panelWithConflict, /<bdi dir="ltr">JOB-000077<\/bdi>/)
  })

  it('A29: serves public client assets (/assets/login.js, /assets/ws.js, /assets/tokens.css) with strict nosniff MIME headers and 404s unknown asset paths', async () => {
    const loginRes = serveStaticAsset('/assets/login.js')
    assert.ok(loginRes)
    assert.equal(loginRes.status, 200)
    assert.equal(loginRes.headers.get('content-type'), 'application/javascript; charset=utf-8')
    assert.equal(loginRes.headers.get('x-content-type-options'), 'nosniff')
    assert.ok((await loginRes.text()).length > 100)

    const wsRes = serveStaticAsset('/assets/ws.js')
    assert.ok(wsRes)
    assert.equal(wsRes.status, 200)
    assert.equal(wsRes.headers.get('content-type'), 'application/javascript; charset=utf-8')

    const cssRes = serveStaticAsset('/assets/tokens.css')
    assert.ok(cssRes)
    assert.equal(cssRes.status, 200)
    assert.equal(cssRes.headers.get('content-type'), 'text/css; charset=utf-8')

    const missingRes = serveStaticAsset('/assets/unknown.js')
    assert.ok(missingRes)
    assert.equal(missingRes.status, 404)
    assert.equal(serveStaticAsset('/panel'), null)
  })
})

describe('readable datetime presentation', () => {
  type Value = string | Date | null | undefined
  type Formatter = (value: Value) => string
  const published = readableDateTimeTokens as typeof readableDateTimeTokens & { formatDisplayDateTime?: Formatter; DISPLAY_DATETIME_BINDING?: string }
  const formatter = (mode: 'server' | 'serialized'): Formatter => {
    if (mode === 'server') {
      assert.equal(typeof published.formatDisplayDateTime, 'function', 'The shared server formatter is exported')
      return published.formatDisplayDateTime!
    }
    assert.equal(typeof published.DISPLAY_DATETIME_BINDING, 'string', 'The shared browser expression is exported')
    const sandbox: Record<string, unknown> = {}
    const display = runInNewContext(published.DISPLAY_DATETIME_BINDING!, sandbox) as Formatter
    assert.equal(typeof display, 'function')
    assert.deepEqual(Object.keys(sandbox), [], 'The expression keeps dependencies local without window globals')
    return display
  }
  for (const mode of ['server', 'serialized'] as const) {
    describe(mode, () => {
      it('renders the fixed readable YYYY-MM-DD HH:mm UTC example', () => {
        assert.equal(formatter(mode)('2026-10-27T09:01:02.000Z'), '2026-10-27 09:01 UTC')
      })
      it('drops seconds and every supplied fractional digit', () => {
        const display = formatter(mode)
        assert.equal(display('2026-10-27T09:01:02.234567Z'), '2026-10-27 09:01 UTC')
        assert.equal(display('2026-10-27T09:01:02.000001Z'), '2026-10-27 09:01 UTC')
        assert.equal(display('2026-10-27T09:01:02.1200Z'), '2026-10-27 09:01 UTC')
      })
      it('shows whole and all-zero fractional seconds to the minute', () => {
        const display = formatter(mode)
        assert.equal(display('2026-10-27T09:01:02.000000Z'), '2026-10-27 09:01 UTC')
        assert.equal(display('2026-10-27T09:01:02Z'), '2026-10-27 09:01 UTC')
      })
      it('converts explicit offsets and midnight/year boundaries to UTC', () => {
        const display = formatter(mode)
        assert.equal(display('2026-10-27T11:31:02.234567+02:30'), '2026-10-27 09:01 UTC')
        assert.equal(display('2026-10-27T00:15:00.000+03:00'), '2026-10-26 21:15 UTC')
        assert.equal(display('2026-12-31T23:45:00.000-02:30'), '2027-01-01 02:15 UTC')
      })
      it('uses ASCII digits for normalized input and output', () => {
        const input = '\u0662\u0660\u0662\u0666-\u0661\u0660-\u0662\u0667T\u0660\u0669:\u0660\u0661:\u0660\u0662.\u0661\u0662\u0660\u0660Z'
        const shown = formatter(mode)(input)
        assert.equal(shown, '2026-10-27 09:01 UTC')
        assert.equal(EASTERN_ARABIC_DIGIT_RE.test(shown), false)
      })
      it('shows a clear unavailable value for invalid or unzoned input', () => {
        const display = formatter(mode)
        for (const input of [null, undefined, '', 'not-a-date', '2026-10-27', '2026-10-27T09:01:02', '2026-02-30T09:01:02Z', '2026-10-27T09:01:02+25:00', new Date(Number.NaN)]) {
          assert.equal(display(input), '—', 'Invalid input remains unavailable: ' + String(input))
        }
      })
      it('formats a Date instant without modifying its value', () => {
        const input = new Date('2026-10-27T09:01:02.120Z'), epoch = input.getTime()
        assert.equal(formatter(mode)(input), '2026-10-27 09:01 UTC')
        assert.equal(input.getTime(), epoch)
      })
    })
  }
  it('keeps the existing default date, invalid fallback, UTC clock and day contracts', () => {
    assert.equal(formatAsciiDate('2026-10-27T09:01:02.345Z'), '2026-10-27')
    assert.equal(formatAsciiDate('not-a-date'), 'not-a-date')
    assert.equal(formatAsciiDate(new Date(Number.NaN)), '')
    assert.equal(formatAsciiDate('\u0662\u0660\u0662\u0666-\u0661\u0660-\u0662\u0667T\u0660\u0669:\u0660\u0661:\u0660\u0662Z'), '2026-10-27T09:01:02Z')
    assert.equal(formatUtcClock('2026-10-27T00:15:00.000+03:00'), '21:15 UTC')
    assert.equal(formatUtcDay('2026-10-27T00:15:00.000+03:00'), '2026-10-26 UTC')
  })
  it('embeds the same generated expression in a raw standalone client closure', () => {
    assert.equal(typeof published.DISPLAY_DATETIME_BINDING, 'string')
    const sandbox: Record<string, unknown> = {}
    const script = String.raw`(()=>{const display = ${published.DISPLAY_DATETIME_BINDING};return function (value) { return display(value); };})()`
    const display = runInNewContext(script, sandbox) as Formatter
    assert.equal(display('2026-10-27T11:31:02.234567+02:30'), '2026-10-27 09:01 UTC')
    assert.deepEqual(Object.keys(sandbox), [])
  })
})

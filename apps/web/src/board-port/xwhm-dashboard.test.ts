import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { Account, AuditEntry, Plan } from '@xpanel/core'
import { resolveWebDocumentRoute } from '../document-routes.ts'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
import { mapAgentHostInfo, renderWhmDashboard, whmDashboardFixture, whmDashboardFixtureAr, whmDashboardFromProps } from './xwhm-dashboard.ts'

const rootVisibility = { principal: { kind: 'root' as const, id: 'fixture-root', username: 'root' } }

describe('xWHM dashboard board port', () => {
  it('does not infer root navigation authority from a display username', () => {
    const html = renderWhmDashboard(whmDashboardFromProps({ principal: { username: 'root' } }))
    assert.equal(html.includes('data-nav-route='), false)
    assert.equal(html.includes('href="/whm/accounts/new"'), false)
    assert.equal(html.includes('href="/whm/server/upgrade"'), false)
  })

  it('adds the create-account CTA only for its explicit reseller ACL', () => {
    const principal = { kind: 'reseller' as const, id: 'fixture-reseller', username: 'reseller' }
    const html = renderWhmDashboard(whmDashboardFromProps({ principal, visibility: { principal, reseller: { acl: ['create-account'] } } }))
    assert.ok(html.includes('href="/whm/accounts/new"'))
    for (const route of ['/whm/accounts', '/whm/server/upgrade', '/whm/resellers', '/whm/audit']) assert.equal(html.includes(`href="${route}"`), false, route)
  })

  it.each(['en', 'ar'] as const)('keeps %s root-only navigation and CTAs out of a list-accounts reseller dashboard', locale => {
    const principal = { kind: 'reseller' as const, id: 'fixture-reseller', username: 'reseller' }
    const html = renderWhmSurface({ locale, activeRoute: '/whm', principal, visibility: { principal, reseller: { acl: ['list-accounts'] } } })
    assert.ok(html.includes('href="/whm/accounts"'))
    for (const route of ['/whm/accounts/new', '/whm/resellers', '/whm/audit', '/whm/services', '/whm/server/setup', '/whm/server/upgrade', '/whm/security/firewall']) {
      assert.equal(html.includes(`href="${route}"`), false, route)
    }
  })

  it('uses observed assigned-cap evidence and never treats delegated controllers as enforcement proof', () => {
    const identity = { enforcedLimits: { cpu: true, memory: true, io: true, pids: true } }
    const unknown = whmDashboardFromProps({ hostSample: mapAgentHostInfo({ identity }) })
    assert.equal(unknown.controllersNote, 'Plan-limit verification is unavailable.')
    for (const observedLimits of [
      { status: 'unavailable', checkedAccounts: 0, unavailableAccounts: 1, gaps: [] },
      { status: 'verified', checkedAccounts: 1, unavailableAccounts: 1, gaps: [] },
      { status: 'verified', checkedAccounts: 0, unavailableAccounts: 0, gaps: [] },
      { status: 'verified', checkedAccounts: 1, unavailableAccounts: 0, gaps: ['memory'] },
    ]) {
      const model = whmDashboardFromProps({ hostSample: mapAgentHostInfo({ identity: { ...identity, observedLimits } }) })
      assert.equal(model.controllersNote, 'Plan-limit verification is unavailable.')
    }
    const match = whmDashboardFromProps({ hostSample: mapAgentHostInfo({ identity: { observedLimits: { status: 'verified', checkedAccounts: 1, unavailableAccounts: 0, gaps: [] } } }) })
    assert.equal(match.controllersNote, 'Observed account caps match assigned plan limits.')
    const wrong = whmDashboardFromProps({ hostSample: mapAgentHostInfo({ identity: { ...identity, observedLimits: { status: 'gaps', checkedAccounts: 1, unavailableAccounts: 0, gaps: ['memory', 'io'] } } }) })
    assert.equal(wrong.controllersNote, 'Observed account caps do not match all assigned plan limits.')
    assert.equal(renderWhmDashboard(unknown).includes('All plan limits are enforced on this host.'), false)
  })

  it('links Upgrade to the canonical registered server document', () => {
    const target = '/whm/server/upgrade'
    assert.deepEqual(resolveWebDocumentRoute(target), { surface: 'xwhm', activeRoute: target })
    assert.equal(resolveWebDocumentRoute('/whm/upgrade'), null)
    for (const locale of ['en', 'ar'] as const) {
      const html = renderWhmDashboard(whmDashboardFromProps({ locale, principal: { username: 'root' }, visibility: rootVisibility }))
      assert.ok(html.includes(`href="${target}"`))
      assert.equal(html.includes('href="/whm/upgrade"'), false)
    }
  })

  it('keeps the board regions in the sample fixture', () => {
    const html = renderWhmDashboard(whmDashboardFixture())
    for (const marker of ['Search tools and accounts', '>Create account</a>', 'id="rec-title"', 'Server resources', 'role="meter"', 'id="acc-title"', 'id="host-title"', 'Recent audit entries', 'Check for drift now', 'Generation 142 · active']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('Activity & Jobs'), false)
    assert.equal(html.includes('Sign out'), false)
  })

  it('keeps the same cards when the host has not reported measurements', () => {
    const html = renderWhmDashboard(whmDashboardFromProps({ locale: 'en', principal: { username: 'root' }, visibility: rootVisibility }))
    for (const marker of ['id="rec-title"', 'id="host-title"', 'Server resources', 'role="meter"', 'Near a limit', '>Create account</a>']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('alice'), false)
    assert.equal(html.includes('karim'), false)
    assert.equal(html.includes('>41<'), false)
    assert.equal(html.includes('data-generation-chip='), false)
    assert.match(html, /data-host-observation="unavailable"/)
    assert.equal(html.includes('In sync'), false)
    assert.equal(html.includes('No certificates renew within 30 days.'), false)
    const product = renderWhmSurface({ principal: { kind: 'root', id: 'root', username: 'root' }, activeRoute: '/whm' })
    assert.match(product, /data-board-port="xwhm-dashboard"/)
    assert.match(product, /aria-label="Search tools and accounts"/)
    assert.match(product, /data-action="logout"/)
    assert.doesNotMatch(product, /Activity & Jobs|data-generation-chip=/)
  })

  it('keeps English document direction while isolating the hostname', () => {
    const model = whmDashboardFixture()
    const html = renderWhmDashboard(model)
    const hostname = `<bdi dir="ltr">${model.ledeHost}</bdi>`
    assert.equal(html.split(hostname).length - 1, 1)
    assert.equal(html.includes('dir="rtl"'), false)
    assert.match(html, /2026-10-22 14:05 UTC<\/time>\./)
    assert.match(html, /inset 3px 0 0 #6EA0FF/)
    assert.doesNotMatch(html, /inset -3px/)
  })

  it('renders Arabic sentences with LTR isolates around numbers, units, and paths', () => {
    const html = renderWhmDashboard(whmDashboardFixtureAr())
    for (const marker of [
      'dir="rtl"',
      'لوحة الخادم',
      '<bdi dir="ltr">41 days, 6 hours</bdi>',
      '<bdi dir="ltr">4 cores · 8 GB</bdi>',
      '<bdi dir="ltr">6.8.0-45-generic</bdi>',
      '<bdi dir="ltr">3.4 / 8 GB</bdi>',
      '<bdi dir="ltr">1.9 M / 26.2 M</bdi>',
      '<bdi dir="ltr">142 / 400 GB</bdi>',
      '<bdi dir="ltr">3</bdi> شهادات',
      '<bdi dir="ltr">44</bdi> حساباً في المجموع.',
      'كل حدود الخطط مفروضة على هذا المضيف.',
      'inset -3px 0 0 #6EA0FF',
      '<bdi dir="ltr">xWHM</bdi></a></li><li aria-hidden="true">/</li><li aria-current="page">اللوحة</li>',
    ]) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('days, 6 hours 41'), false)
    assert.equal(html.includes('>Dashboard<'), false)
  })

  it('binds a lab host sample and leaves unread fields empty', () => {
    const html = renderWhmDashboard(whmDashboardFromProps({
      locale: 'en',
      principal: { username: 'root' },
      hostname: 'lab.example.test',
      generationId: 28,
      driftCount: 0,
      accounts: [{ status: 'active' }, { status: 'suspended' }] as Account[],
      resellers: [],
      plans: [] as Plan[],
      certificates: [{ names: ['lab.example.test'], notAfter: '2020-01-01T00:00:00.000Z' }],
      hostSample: {
        load1: 0.42,
        memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 },
        disk: { mount: '/', totalBytes: 20 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
        system: 'Debian GNU/Linux 12',
        kernel: '6.1.0-lab',
        uptimeSeconds: 41 * 86400 + 6 * 3600,
        engine: 'nginx 1.24.0',
        panelVersion: '0.1.0',
      },
      services: [
        { name: 'Postfix', version: '', active: true, installed: true },
        { name: 'Redis', version: '', active: false, installed: false },
        { name: 'PowerDNS', version: '', active: false, checked: false },
      ],
      auditEntries: [{
        id: 'audit-1', at: '2026-10-23T18:04:00.000Z', actor: 'root', action: 'service_user.deleted',
        target: 'box@lab.example.test', detail: {}, outcome: 'ok',
      } satisfies AuditEntry],
    }))
    for (const marker of ['lab.example.test', '1 certificate renews within 30 days:', '2020-01-01 UTC', 'Generation 28', 'In sync', '28 = 28', 'load 0.42', 'Disk on /', 'Deleted service user', 'box@lab.example.test', '18:04 UTC', 'Times in UTC', 'Postfix', 'Not installed', 'Not checked', '1 / 1', '2 accounts and 0 plans', 'Debian GNU/Linux 12', '6.1.0-lab', '41 days, 6 hours', 'nginx 1.24.0', '0.1.0', 'data-host-observation="observed"']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('service_user.deleted'), false)
    assert.equal(html.includes('>18:04<'), false)
    assert.equal(html.includes('alice'), false)
    assert.equal(html.includes('Ubuntu'), false)
    assert.equal(html.includes('>41<'), false)
    const unread = renderWhmDashboard(whmDashboardFromProps({
      locale: 'en', principal: { username: 'root' }, hostname: 'lab.example.test', driftCount: null, certificates: undefined,
    }))
    assert.equal(unread.includes('In sync'), false)
    assert.equal(unread.includes('Times in UTC'), false)
    assert.match(unread, /data-host-observation="unavailable"/)
    const arabic = renderWhmDashboard(whmDashboardFromProps({
      locale: 'ar',
      principal: { username: 'root' },
      services: [{ name: 'PowerDNS', version: '', active: false, installed: false }],
      auditEntries: [{
        id: 'audit-ar', at: '2026-10-23T17:29:00.000Z', actor: 'root', action: 'service_user.created',
        target: 'box@lab.example.test', detail: {}, outcome: 'ok',
      } satisfies AuditEntry],
      hostSample: { uptimeSeconds: 2 * 86400 + 3600 },
    }))
    assert.match(arabic, /أنشأ مستخدم خدمة/)
    assert.match(arabic, /غير مثبت/)
    assert.match(arabic, /17:29 UTC/)
    assert.match(arabic, /الأوقات بتوقيت/)
    assert.match(arabic, /يومان وساعة واحدة/)
    assert.doesNotMatch(arabic, /service_user\.created/)
    const auditPage = renderWhmSurface({
      principal: { kind: 'root', id: 'root', username: 'root' },
      activeRoute: '/whm/audit',
      locale: 'ar',
      auditEntries: [{
        id: 'audit-ar', at: '2026-10-23T17:29:00.000Z', actor: 'root', action: 'dns.zone.saved',
        target: 'lab.example.test', detail: {}, outcome: 'ok',
      } satisfies AuditEntry],
    })
    assert.match(auditPage, /حفظ منطقة/)
    assert.match(auditPage, /<bdi dir="ltr">DNS<\/bdi>/)
    assert.match(auditPage, /2026-10-23 17:29 UTC/)
    assert.match(auditPage, /lab\.example\.test/)
    assert.doesNotMatch(auditPage, /dns\.zone\.saved/)
  })
})

describe('readable live xWHM header instant', () => {
  it.each(['en', 'ar'] as const)('keeps the %s minute-precision human header and existing machine timestamp behavior separate', locale => {
    const hostSample = { sampledAt: '2026-10-27T14:00:01.123456+02:00' }
    const before = { ...hostSample }
    const model = whmDashboardFromProps({ locale, principal: rootVisibility.principal, visibility: rootVisibility, hostSample })
    assert.equal(model.ledeTime, '2026-10-27 12:00 UTC')
    assert.equal(model.ledeDatetime, '2026-10-27T12:00:01.123Z')
    const html = renderWhmDashboard(model)
    const time = /<time datetime="([^"]*)">([\s\S]*?)<\/time>/.exec(html)!
    assert.equal(time[1], '2026-10-27T12:00:01.123Z')
    assert.equal(time[2]!.replace(/<[^>]*>/g, ''), '2026-10-27 12:00 UTC')
    if (locale === 'ar') assert.match(time[2]!, /<bdi dir="ltr"[^>]*>2026-10-27 12:00 UTC<\/bdi>/)
    assert.deepEqual(hostSample, before)
    assert.doesNotMatch(time[2]!, /[\u0660-\u0669\u06f0-\u06f9]/)
  })
})

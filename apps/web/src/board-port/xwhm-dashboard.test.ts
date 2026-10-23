import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { Account, AuditEntry, Plan } from '@xpanel/core'
import { renderWhmSurface } from '../surfaces/xwhm.ts'
import { renderWhmDashboard, whmDashboardFixture, whmDashboardFixtureAr, whmDashboardFromProps } from './xwhm-dashboard.ts'

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
    assert.equal(html.includes('In sync'), false)
    assert.equal(html.includes('No certificates renew within 30 days.'), false)
    const product = renderWhmSurface({ principal: { kind: 'root', id: 'root', username: 'root' }, activeRoute: '/whm' })
    assert.match(product, /data-board-port="xwhm-dashboard"/)
    assert.match(product, /aria-label="Search tools and accounts"/)
    assert.doesNotMatch(product, /Activity & Jobs|Sign out|data-generation-chip=/)
  })

  it('keeps the approved English dashboard free of bidi isolates', () => {
    const html = renderWhmDashboard(whmDashboardFixture())
    assert.equal(html.includes('<bdi'), false)
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
      hostSample: {
        load1: 0.42,
        memory: { totalBytes: 8 * 1024 ** 3, availableBytes: 5 * 1024 ** 3 },
        disk: { mount: '/', totalBytes: 20 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 },
      },
      certificates: [{ names: ['lab.example.test'], notAfter: '2020-01-01T00:00:00.000Z' }],
      services: [
        { name: 'Postfix', version: '', active: true, installed: true },
        { name: 'Redis', version: '', active: false, installed: false },
      ],
      auditEntries: [{
        id: 'audit-1', at: '2026-10-23T18:04:00.000Z', actor: 'root', action: 'mailbox.create',
        target: 'box@lab.example.test', detail: {}, outcome: 'ok',
      } satisfies AuditEntry],
    }))
    for (const marker of ['lab.example.test', '1 certificate renews within 30 days:', 'Generation 28', 'In sync', '28 = 28', 'load 0.42', 'Disk on /', 'mailbox.create', 'Postfix', '2 accounts and 0 plans', 'data-host-observation="observed"']) {
      assert.ok(html.includes(marker), marker)
    }
    assert.equal(html.includes('alice'), false)
    assert.equal(html.includes('Ubuntu'), false)
    assert.equal(html.includes('>41<'), false)
    assert.equal(html.includes('6.8.0'), false)
    const unread = renderWhmDashboard(whmDashboardFromProps({
      locale: 'en', principal: { username: 'root' }, hostname: 'lab.example.test', driftCount: null, certificates: undefined,
    }))
    assert.equal(unread.includes('In sync'), false)
    assert.match(unread, /data-host-observation="unavailable"/)
  })
})

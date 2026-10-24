import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account } from '@xpanel/core'
import { renderPanelSurface, type PanelSurfaceProps } from '../../surfaces/xpanel.ts'
import { renderWhmSurface, type WhmSurfaceProps } from '../../surfaces/xwhm.ts'
import { escapeHtml } from '../../tokens.ts'
import { composedXpanelRoutes, composedXwhmRoutes } from './all.ts'

const at = '2026-10-22T14:05:00Z'
const plan = { ...defaultPlan({ id: 'composed-plan', name: 'Synthetic plan', featureListId: 'composed-features' }), shell: 'jailed' as const }
const account: Account = {
  id: 'composed-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice-shop.com',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice-shop.com',
  ipv4: '10.0.0.21', ipv6: '2001:db8::12', shell: 'jailed', createdAt: at,
}
const panel: PanelSurfaceProps = {
  account, plan,
  domains: [{ id: 'composed-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: account.ipv6 }],
  customConfig: { domainId: 'composed-domain', accountId: account.id, domainName: account.primaryDomain, nginxInclude: '# synthetic include', apacheInclude: '# synthetic include', userIni: { memory_limit: '256M' }, customHeaders: {}, cacheBypassPaths: [], updatedAt: at, updatedBy: 'user' },
  files: [{ name: 'fixture.txt', path: '/home/alice/public_html/fixture.txt', kind: 'file', sizeBytes: 128, modeOctal: '0640', modifiedAt: at }, { name: 'trashed-fixture.txt', path: '/home/alice/.trash/trashed-fixture.txt', kind: 'file', sizeBytes: 64, modeOctal: '0640', modifiedAt: at, trashed: true }],
  databases: [{ id: 'composed-db', accountId: account.id, engine: 'mariadb', name: 'alice_fixture', trashedAt: null }],
  serviceUsers: [{ id: 'composed-user', accountId: account.id, login: 'info@alice-shop.com', services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html' }],
}
const whm: WhmSurfaceProps = {
  principal: { kind: 'root', id: 'composed-root', username: 'synthetic-root' },
  hostname: 'srv1.xpanel.test',
  accounts: [account],
  plans: [plan],
  services: [{ name: 'nginx', unit: 'nginx.service', version: 'fixture', active: true, enabled: true, rssMb: 24, role: 'edge' }],
  resellers: [{ id: 'composed-reseller', username: 'fixture-reseller', acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 10240, totalBandwidthMb: 102400, oversell: false, nameservers: [], delegatedIps: [] }],
  ipPool: [{ id: 'composed-ip', address: '10.0.0.12', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' }],
  mailIpConfig: { mode: 'custom-map', defaultIpv4: account.ipv4, defaultIpv6: account.ipv6 ?? null, defaultHelo: 'mail.alice-shop.com', domainOverrides: [] },
  generations: [{ generationId: 142, at, actor: 'synthetic-root', summary: 'Synthetic generation', stateChecksum: '9f86d081884c', filesCount: 38, durationMs: 184, status: 'superseded' }],
}

const registered = new Set([...composedXpanelRoutes, ...composedXwhmRoutes].map(spec => spec.route))

describe('composed screens for routes without a board', () => {
  it('renders every registered route from its template with one title', () => {
    assert.ok(registered.size > 0)
    for (const spec of composedXpanelRoutes) {
      for (const locale of ['en', 'ar'] as const) {
        const html = renderPanelSurface({ ...panel, locale, activeRoute: spec.route })
        assert.match(html, new RegExp(`data-composed-route="${spec.route}"`))
        const template = escapeHtml(spec.template).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(html, new RegExp(`data-composed-template="${template}"`))
        const title = escapeHtml(locale === 'ar' ? spec.title[1] : spec.title[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`))
        assert.equal((html.match(/<h1\b/g) ?? []).length, 1, spec.route)
      }
    }
    for (const spec of composedXwhmRoutes) {
      for (const locale of ['en', 'ar'] as const) {
        const html = renderWhmSurface({ ...whm, locale, activeRoute: spec.route })
        assert.match(html, new RegExp(`data-composed-route="${spec.route}"`))
        const template = escapeHtml(spec.template).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(html, new RegExp(`data-composed-template="${template}"`))
        const title = escapeHtml(locale === 'ar' ? spec.title[1] : spec.title[0]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(html, new RegExp(`<h1[^>]*>${title}</h1>`))
        assert.equal((html.match(/<h1\b/g) ?? []).length, 1, spec.route)
      }
    }
  })

  it('keeps real rows and does not invent the other engine or the other folder', () => {
    if (registered.has('/files/trash')) {
      const trash = renderPanelSurface({ ...panel, activeRoute: '/files/trash' })
      assert.match(trash, /data-file-path="\/home\/alice\/\.trash\/trashed-fixture\.txt"/)
      assert.doesNotMatch(trash, /data-file-path="\/home\/alice\/public_html\/fixture\.txt"/)
      assert.match(trash, /data-action="restore-file"/)
    }
    if (registered.has('/files/ftp')) {
      assert.match(renderPanelSurface({ ...panel, activeRoute: '/files/ftp' }), /info@alice-shop\.com/)
    }
    if (registered.has('/files/web-disk')) {
      const webdisk = renderPanelSurface({ ...panel, activeRoute: '/files/web-disk' })
      assert.match(webdisk, /No Web Disk accounts are stored/)
      assert.doesNotMatch(webdisk, /info@alice-shop\.com/)
    }
    if (registered.has('/databases/postgresql')) {
      const postgres = renderPanelSurface({ ...panel, activeRoute: '/databases/postgresql' })
      assert.doesNotMatch(postgres, /alice_fixture/)
      assert.match(postgres, /No databases are connected for this engine/)
    }
    if (registered.has('/domains/site-settings')) {
      const settings = renderPanelSurface({ ...panel, activeRoute: '/domains/site-settings' })
      assert.match(settings, /data-userdata-form="true"/)
      assert.match(settings, /SuexecUserGroup/)
      assert.match(renderPanelSurface({ ...panel, customConfig: undefined, activeRoute: '/domains/site-settings' }), /data-screen="unavailable"/)
    }
    if (registered.has('/advanced/terminal')) {
      const terminal = renderPanelSurface({ ...panel, activeRoute: '/advanced/terminal' })
      assert.match(terminal, /No terminal session has started/)
      assert.match(terminal, /data-terminal-output=""/)
      const disabled = renderPanelSurface({ ...panel, account: { ...account, shell: 'none' }, plan: { ...plan, shell: 'none' }, activeRoute: '/advanced/terminal' })
      assert.match(disabled, /data-terminal-disabled="true"/)
    }
  })

  it('keeps the wired xWHM tools and leaves unwired actions disabled', () => {
    if (registered.has('/whm/server/ips')) {
      const ips = renderWhmSurface({ ...whm, activeRoute: '/whm/server/ips' })
      assert.match(ips, /data-ip-pool-table="true"/)
      assert.match(ips, /<bdi dir="ltr">10\.0\.0\.12\/24<\/bdi>/)
      assert.doesNotMatch(ips, /data-mail-ip-config-form/)
    }
    if (registered.has('/whm/email/outbound')) {
      const mail = renderWhmSurface({ ...whm, activeRoute: '/whm/email/outbound' })
      assert.match(mail, /data-mail-ip-config-form="true"/)
      assert.match(mail, /name="defaultIpv4"[^>]*value="10\.0\.0\.21"/)
      assert.match(mail, /name="defaultHelo"[^>]*value="mail\.alice-shop\.com"/)
      assert.match(renderWhmSurface({ ...whm, mailIpConfig: undefined, activeRoute: '/whm/email/outbound' }), /data-screen="unavailable"/)
    }
    if (registered.has('/whm/panel/data')) {
      assert.match(renderWhmSurface({ ...whm, activeRoute: '/whm/panel/data' }), /data-action="rollback-generation"/)
    }
    if (registered.has('/whm/backups/restore')) {
      assert.match(renderWhmSurface({ ...whm, activeRoute: '/whm/backups/restore' }), /data-account-backups="true"/)
    }
    if (registered.has('/whm/monitoring/server-info')) {
      assert.match(renderWhmSurface({ ...whm, activeRoute: '/whm/monitoring/server-info' }), /data-host-info="true"/)
    }
    if (registered.has('/whm/monitoring/io')) {
      assert.match(renderWhmSurface({ ...whm, ioSnapshot: undefined, activeRoute: '/whm/monitoring/io' }), /data-screen="unavailable"/)
    }
    if (registered.has('/advanced/mime-types')) {
      const soon = renderPanelSurface({ ...panel, activeRoute: '/advanced/mime-types' })
      assert.match(soon, /disabled data-wiring="soon"/)
      assert.match(soon, /Coming soon/)
      const soonAr = renderPanelSurface({ ...panel, locale: 'ar', activeRoute: '/advanced/mime-types' })
      assert.match(soonAr, /قيد التفعيل/)
      assert.match(soonAr, /أنواع MIME|MIME/)
    }
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type ServiceUser } from '@xpanel/core'
import { COMPOSED_ROUTES, renderComposedPage } from './composed-pages.ts'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { resolveSurfaceSection } from '../shell.ts'

const plan = defaultPlan({ id: 'composed-plan', name: 'Synthetic plan', featureListId: 'composed-features' })
const account: Account = {
  id: 'composed-account', username: 'alice', uid: 20014, gid: 20014, home: '/home/alice', primaryDomain: 'alice.example.test',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'owner@alice.example.test',
  ipv4: '192.0.2.21', ipv6: null, shell: 'none', createdAt: '2026-10-22T14:05:00Z',
}
const domain: Domain = {
  id: 'composed-domain', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null,
  docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited', ipv4: account.ipv4, ipv6: null,
}
const mailbox: ServiceUser = {
  id: 'composed-user', accountId: account.id, login: 'info@alice.example.test', services: { email: true, ftp: false, webdisk: false },
  mailboxQuotaMb: 1024, ftpDir: 'public_html',
}

describe('composed email and account pages', () => {
  it('opens every scoped route inside the panel and keeps email accounts on its own screen', () => {
    for (const route of COMPOSED_ROUTES) assert.equal(resolveSurfaceSection('xpanel', route), 'composed')
    assert.equal(resolveSurfaceSection('xpanel', '/email/accounts'), 'users')
    const accounts = renderPanelSurface({ locale: 'en', activeRoute: '/email/accounts', account, plan, serviceUsers: [mailbox] })
    assert.match(accounts, /data-mailbox-form/)
    assert.doesNotMatch(accounts, /data-composed-route/)
  })

  it('shows plan limits and refuses invented forwarder rows', () => {
    const html = renderPanelSurface({
      locale: 'en', activeRoute: '/email/forwarders', account, plan, domains: [domain], serviceUsers: [mailbox],
    })
    assert.match(html, /data-composed-route="\/email\/forwarders"/)
    assert.match(html, new RegExp(String(plan.caps.forwarders)))
    assert.match(html, /disabled/)
    assert.doesNotMatch(html, /alias@|redirect@|noreply@|sample@/)
    assert.match(html, /No rows\./)
  })

  it('lists real mailboxes without inventing filter rules', () => {
    const html = renderComposedPage({ locale: 'ar', route: '/email/filters', account, serviceUsers: [mailbox] })
    assert.match(html, /info@alice\.example\.test/)
    assert.match(html, /لا توجد قواعد/)
    assert.doesNotMatch(html, /subject|from|fileinto/i)
  })

  it('keeps deliverability unchecked and language switching live', () => {
    const mail = renderComposedPage({ locale: 'en', route: '/email/deliverability', account, domains: [domain] })
    assert.match(mail, /alice\.example\.test/)
    assert.match(mail, /Not checked/)
    assert.doesNotMatch(mail, /pass|valid|aligned/i)
    const language = renderPanelSurface({ locale: 'ar', theme: 'light', activeRoute: '/preferences/language', account, plan })
    assert.match(language, /data-composed-state="live"/)
    assert.match(language, /العربية/)
    assert.match(language, /href="\?lang=en"/)
    assert.match(language, /owner@alice\.example\.test|alice\.example\.test/)
  })

  it('shows the contact address and service logins, and leaves team empty', () => {
    const preferences = renderComposedPage({ locale: 'en', route: '/preferences', account, theme: 'dark' })
    assert.match(preferences, /owner@alice\.example\.test/)
    assert.match(preferences, /Dark/)
    assert.match(preferences, /disabled/)
    const users = renderComposedPage({ locale: 'en', route: '/preferences/users', account, serviceUsers: [mailbox] })
    assert.match(users, /info@alice\.example\.test/)
    assert.match(users, />Email</)
    const team = renderComposedPage({ locale: 'en', route: '/preferences/team', account, serviceUsers: [mailbox] })
    assert.match(team, /data-composed-state="empty"/)
    assert.doesNotMatch(team, /info@alice\.example\.test|alice</)
  })

  it('reports account status and does not invent a site check', () => {
    const html = renderComposedPage({ locale: 'en', route: '/health', account, domains: [domain] })
    assert.match(html, /Active/)
    assert.match(html, /alice\.example\.test/)
    assert.match(html, /Not checked/)
    assert.doesNotMatch(html, /HTTP 200|healthy|latency/i)
  })
})

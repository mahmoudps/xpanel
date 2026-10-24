import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Principal, type ServiceUser } from '@xpanel/core'
import { tools, navigation } from '@xpanel/catalog'
import { renderEmailAccountsExtension, emailAccountsRouteSpec } from './email-accounts.ts'
import { accountPageRouteSpecs, renderAccountPagesExtension } from './account-pages.ts'
import { renderStoreExtension, storeRouteSpecs, type StoreExtensionInput } from './store.ts'
import { EXTENSION_CSS, extensionCollection } from './shared.ts'

const principal: Principal = { kind: 'user', id: 'synthetic-user', username: 'alice', accountId: 'account-a' }
const account = { id: 'account-a', username: 'alice', primaryDomain: 'alice.example.test', planId: 'plan-a', status: 'active' as const, contactEmail: 'contact@example.test' }
const user: ServiceUser = { id: 'service-a', accountId: account.id, login: 'mail@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 64, ftpDir: '' }
const root: Principal = { kind: 'root', id: 'synthetic-root', username: 'root' }

describe('account and store extension presentation boundaries', () => {
  it('distinguishes unread collections from observed empty results in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      assert.match(extensionCollection(locale, undefined, ['Empty result', 'نتيجة فارغة'], () => ''), /data-collection-state="unread"/)
      assert.match(extensionCollection(locale, { state: 'read', items: [] }, ['Empty result', 'نتيجة فارغة'], () => ''), /data-collection-state="empty"/)
      for (const route of ['/email/filters', '/email/encryption', '/preferences/team']) {
        const html = renderAccountPagesExtension({ locale, route, account, principal })
        assert.match(html, /data-collection-state="unread"/)
        assert.doesNotMatch(html, /No rules|لا توجد قواعد|data-collection-state="empty"/)
      }
    }
  })

  it('keeps mailbox operations on existing hooks, authority and exact native payload fields', () => {
    const input = { locale: 'en' as const, principal, account, mutationsQualified: true, users: { state: 'read' as const, items: [user, { ...user, id: 'foreign', accountId: 'other', login: 'hidden@example.test' }] }, domains: { state: 'read' as const, items: [{ id: 'domain-a', accountId: account.id, name: account.primaryDomain }] } }
    const html = renderEmailAccountsExtension(input)
    for (const name of ['localPart', 'domainId', 'password', 'mailboxQuotaMb']) assert.match(html, new RegExp(`name="${name}"`))
    for (const hook of ['data-mailbox-form', 'data-mailbox-status', 'data-mailbox-password-dialog', 'data-mailbox-quota-dialog', 'data-remove-mailbox="service-a"']) assert.ok(html.includes(hook))
    assert.doesNotMatch(html, /hidden@example\.test|name="ftpDir"|data-service-choice|<script|<nav/)
    assert.equal(renderEmailAccountsExtension({ ...input, principal: root }), '')
    assert.equal(renderEmailAccountsExtension({ ...input, principal: { ...principal, accountId: 'other' } }), '')
    assert.doesNotMatch(renderEmailAccountsExtension({ ...input, mutationsQualified: false }), /data-mailbox-form|data-remove-mailbox/)
    assert.match(renderEmailAccountsExtension({ ...input, domains: { state: 'read', items: [] } }), /type="submit"[^>]* disabled/)
  })

  it('keeps non-mail service users read only under mailbox qualification', () => {
    const ftp = { ...user, id: 'ftp-only', login: 'ftp-login', services: { email: false, ftp: true, webdisk: false } }
    const webdisk = { ...user, id: 'disk-only', login: 'disk-login', services: { email: false, ftp: false, webdisk: true } }
    const combined = { ...user, id: 'combined-mail', login: 'combined@example.test', services: { email: true, ftp: true, webdisk: true } }
    for (const locale of ['en', 'ar'] as const) {
      const html = renderEmailAccountsExtension({ locale, principal, account, mutationsQualified: true, users: { state: 'read', items: [user, ftp, webdisk, combined] } })
      for (const item of [ftp, webdisk]) {
        assert.ok(html.includes(item.login), 'Non-mail service detail remains visible')
        for (const hook of ['data-mailbox-password', 'data-mailbox-quota', 'data-remove-mailbox']) assert.ok(!html.includes(`${hook}="${item.id}"`), 'Mailbox qualification does not enable another service action')
      }
      for (const item of [user, combined]) assert.ok(html.includes(`data-remove-mailbox="${item.id}"`), 'Existing mail service actions remain available')
    }
  })

  it('never borrows caps from a mismatched plan or invents service health', () => {
    const basePlan = defaultPlan()
    const plan = { ...basePlan, id: 'wrong-plan', name: 'Wrong plan marker', caps: { ...basePlan.caps, mailboxes: 98765 } }
    const html = renderEmailAccountsExtension({ locale: 'en', principal, account, plan })
    assert.doesNotMatch(html, /Wrong plan marker|98765/)
    assert.match(html, /Not read/)
    const health = renderAccountPagesExtension({ locale: 'ar', principal, account, route: '/email/deliverability', domains: { state: 'read', items: [{ accountId: account.id, name: '<img src=x>' }, { accountId: 'other', name: 'foreign.example.test' }] } })
    assert.match(health, /data-check-state="unread"/)
    assert.match(health, /&lt;img src=x&gt;/)
    assert.doesNotMatch(health, /<img|foreign\.example\.test|data-check-state="passed"/)
  })

  it('keeps preferences bound to current contact/theme', () => {
    const html = renderAccountPagesExtension({ locale: 'en', principal, account, route: '/preferences', theme: 'dark' })
    assert.match(html, /contact@example\.test/)
    assert.match(html, /Dark/)
    assert.match(html, /disabled data-wiring="unavailable"/)

  })

  it('keeps every store screen read-only and rejects the wrong principal', () => {
    for (const locale of ['en', 'ar'] as const) for (const spec of storeRouteSpecs) {
      const input: StoreExtensionInput = { locale, route: spec.route, principal: spec.surface === 'xwhm' ? root : principal, account }
      const html = renderStoreExtension(input)
      assert.match(html, /data-installer-state="unavailable"/)
      assert.doesNotMatch(html, /<form|<script|aria-valuenow|role="progressbar"|data-installer-state="installed"|data-installer-progress="idle"|No job is running/)
      const buttons = html.match(/<button\b[^>]*>/g) ?? []
      assert.ok(buttons.length > 0)
      assert.ok(buttons.every(button => button.includes(' disabled ')))
      const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1])
      assert.deepEqual(links, storeRouteSpecs.filter(item => item.surface === spec.surface).map(item => item.route))
      assert.equal(html.match(/aria-current="page"/g)?.length, 1)
      assert.equal(renderStoreExtension({ ...input, principal: spec.surface === 'xwhm' ? principal : root }), '')
      assert.equal(renderStoreExtension({ ...input, principal: { kind: 'reseller', id: 'synthetic-reseller', username: 'reseller' } }), '')
    }
    const html = renderStoreExtension({ locale: 'en', route: '/whm/software/store', principal: root, plans: { state: 'read', items: [{ name: '<script>bad</script>' }] } })
    assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/)
    assert.doesNotMatch(html, /<script>/)
    assert.match(html, /Application feature key/)
    assert.match(renderStoreExtension({ locale: 'en', route: '/software/installer', principal, account }), /data-installer-state="unavailable"/)
    assert.match(renderStoreExtension({ locale: 'ar', route: '/whm/software/site-software', principal: root }), /data-installer-state="unavailable"/)
  })

  it('references existing tools without claiming renderer coverage qualifies routes', () => {
    const known = new Set(tools.map(tool => tool.id))
    const currentPages = navigation.flatMap(surface => surface.sections.flatMap(section => section.pages))
    for (const spec of [emailAccountsRouteSpec, ...accountPageRouteSpecs, ...storeRouteSpecs]) {
      assert.ok(spec.tools.length > 0)
      assert.ok(spec.tools.every(tool => known.has(tool)), spec.route)
      const existing = currentPages.find(page => page.route === spec.route)
      if (existing) assert.deepEqual([...spec.tools].sort(), [...existing.tools].sort(), spec.route)
    }
    const accountParent = currentPages.find(page => page.route === '/software/installer')
    const rootParent = currentPages.find(page => page.route === '/whm/software/site-software')
    assert.ok(accountParent)
    assert.ok(rootParent)
    for (const spec of storeRouteSpecs) assert.deepEqual([...spec.tools].sort(), [...(spec.surface === 'xpanel' ? accountParent : rootParent).tools].sort())
  })

  it('declares scoped logical layout without asserting browser geometry acceptance', () => {
    assert.match(EXTENSION_CSS, /gap:32px/)
    assert.match(EXTENSION_CSS, /gap:24px/)
    assert.match(EXTENSION_CSS, /gap:16px/)
    assert.match(EXTENSION_CSS, /gap:8px/)
    assert.match(EXTENSION_CSS, /padding:24px/)
    assert.match(EXTENSION_CSS, /max-width:800px[^}]*padding:16px/)
    assert.match(EXTENSION_CSS, /min-block-size:44px/)
    assert.doesNotMatch(EXTENSION_CSS, /overflow:\s*hidden|text-align:\s*(left|right)|padding-(left|right)/)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { defaultPlan, type Account, type ServiceUser } from '@xpanel/core'
import { renderPanelSurface } from '../surfaces/xpanel.ts'
import { renderFidelityDocument } from './xpanel-email.fixture.ts'
import { renderLiveDocument, renderXpanelEmail } from './xpanel-email.ts'

const at = '2026-10-22T14:05:00Z'
const plan = defaultPlan({ id: 'mail-plan', name: 'Business', featureListId: 'features' })
const account: Account = {
  id: 'mail-account', username: 'owner', uid: 21000, gid: 21000, home: '/home/owner', primaryDomain: 'example.test',
  planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'ops@example.test',
  ipv4: '192.0.2.10', shell: 'none', createdAt: at,
}
const user: ServiceUser = {
  id: 'mailbox-1', accountId: account.id, login: 'info@example.test',
  services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 1024, ftpDir: 'public_html',
}

const page = renderXpanelEmail({
  account, plan, domains: [{ id: 'domain-1', name: account.primaryDomain }], serviceUsers: [user],
})

describe('xPanel email accounts', () => {
  it('keeps the mailbox form bound to the service-user API', () => {
    const form = page.slice(page.indexOf('<form'), page.indexOf('</form>'))
    assert.match(form, /data-mailbox-form="true"/)
    assert.match(form, /id="mailbox-local"[^>]*name="localPart"/)
    assert.match(form, /id="mailbox-domain"[^>]*name="domainId"/)
    assert.match(form, /id="mailbox-password"[^>]*name="password"[^>]*minlength="8"/)
    assert.match(form, /id="mailbox-quota"[^>]*name="mailboxQuotaMb"/)
    assert.match(form, /data-service-choice="email"[^>]*aria-checked="true"/)
    assert.match(form, /data-service-choice="ftp"[^>]*aria-checked="false"/)
    assert.match(form, /data-service-choice="webdisk"[^>]*aria-checked="false"/)
    assert.match(form, /name="ftpDir"/)
    assert.match(form, /data-quota-unlimited/)
    assert.doesNotMatch(form, /novalidate/)
    assert.match(page, /data-mailbox-password="mailbox-1"/)
    assert.match(page, /data-mailbox-quota="mailbox-1"/)
    assert.match(page, /data-mailbox-password-dialog/)
    assert.match(page, /data-mailbox-quota-dialog/)
    assert.match(page, /data-remove-mailbox="mailbox-1"/)
    assert.equal([...page.matchAll(/<h1\b/g)].length, 1)
  })

  it('shows the quota limit in MiB and leaves unmeasured fields pending', () => {
    assert.match(page, /<bdi dir="ltr">1,024 MiB<\/bdi>/)
    assert.match(page, /<bdi dir="ltr">info@example\.test<\/bdi>/)
    assert.match(page, /<bdi dir="ltr">\/home\/owner\/public_html<\/bdi>/)
    assert.match(page, />IMAP<\/dt><dd[^>]*>[\s\S]*?Coming soon/)
    assert.doesNotMatch(page, /:993|:995|:465|550 No such|0% used/)
    assert.match(page, /The forwarder list is not loaded/)
    assert.match(page, /The plan stores no Web Disk cap/)
    assert.match(page, /Mailbox size is not measured yet/)
    assert.match(page, /data-email-panel="forwarders"[^>]*style="display:none"/)
  })

  it('keeps Arabic sentences out of the English sample and numbers in bdi', () => {
    const arabic = renderXpanelEmail({
      locale: 'ar', account, plan,
      domains: [{ id: 'domain-1', name: account.primaryDomain }],
      serviceUsers: [user],
    })
    assert.match(arabic, /تسجيل الدخول/)
    assert.match(arabic, /الخدمات/)
    assert.match(arabic, /حصة صندوق البريد/)
    assert.match(arabic, /تسجيلات دخول للخدمات/)
    assert.match(arabic, /<bdi dir="ltr">1,024 MiB<\/bdi>/)
    assert.match(arabic, /<bdi dir="ltr">21000<\/bdi>|<bdi dir="ltr">21,000<\/bdi>|uid 21,000/)
    assert.match(arabic, /class="xp-ar-sentence"/)
    assert.match(arabic, /قيد التفعيل/)
    assert.doesNotMatch(arabic, /Coming soon/)
    assert.doesNotMatch(arabic, />Login<|>Services</)
  })

  it('does not invent a mailbox when the list is empty', () => {
    const empty = renderXpanelEmail({ account, plan, domains: [{ id: 'domain-1', name: 'example.test' }] })
    assert.match(empty, /No service users yet/)
    assert.doesNotMatch(empty, /data-service-row-login=/)
    const live = renderLiveDocument('ltr')
    assert.match(live, /No domains/)
    assert.doesNotMatch(live, /info@example\.test|public_html\/events/)
  })

  it('renders the artboard only from the fixture', () => {
    const art = renderFidelityDocument()
    assert.match(art, /Email and service users/)
    assert.match(art, /info@alice-shop\.com/)
    assert.doesNotMatch(page, /alice-shop\.com|public_html\/events|550 No such/)
  })

  it('leaves the FTP page on the existing users section', () => {
    const ftp = renderPanelSurface({ account, plan, activeRoute: '/files/ftp', serviceUsers: [user] })
    const email = renderPanelSurface({
      account, plan, activeRoute: '/email/accounts',
      domains: [{ id: 'domain-1', accountId: account.id, name: 'example.test', kind: 'primary', parentId: null, docRoot: '/home/owner/public_html', siteType: 'php', upstream: null, redirect: null,
        php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 1, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 1, processIdleTimeoutSec: 1 }, ini: {} },
        wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }],
      serviceUsers: [user],
    })
    assert.match(ftp, /info@example\.test/)
    assert.doesNotMatch(ftp, /data-board-port="xpanel-email"/)
    assert.match(email, /data-board-port="xpanel-email"/)
    assert.match(email, /data-mailbox-form="true"/)
    assert.match(email, /info@example\.test/)
  })
})

import { describe, expect, it } from 'vitest'
import type { ServiceUser } from '@xpanel/core'
import { v2Messages } from '../../../messages.ts'
import { renderV2EmailAccountsPage, type EmailAccountsPageProps } from './accounts.ts'

const t = v2Messages.translator('en')
const user: ServiceUser = {
  id: 'mail-user-private', accountId: 'account-private', login: 'sales@example.test',
  services: { email: true, ftp: true, webdisk: false }, mailboxQuotaMb: 512, ftpDir: 'public_html/incoming',
}
const page = (patch: Partial<EmailAccountsPageProps> = {}): string => renderV2EmailAccountsPage(t, {
  account: { username: 'alice', primaryDomain: 'example.test' },
  domains: { state: 'read', items: [{ id: 'domain-private', name: 'example.test' }] },
  users: { state: 'read', items: [user] }, canManage: true, ...patch,
})

describe('v2 email accounts', () => {
  it('keeps creation and native password/quota dialog contracts usable by the existing controller', () => {
    const html = page()
    expect(html).toContain('data-mailbox-form="true"')
    for (const name of ['localPart', 'domainId', 'password', 'mailboxQuotaMb']) expect(html).toContain(`name="${name}"`)
    for (const kind of ['password', 'quota']) expect(html).toContain(`<dialog class="v2-email-dialog" data-mailbox-${kind}-dialog`)
    expect(html).toContain('data-password-generate data-password-target="mailbox-password"')
    expect(html).toContain('data-mailbox-password="mail-user-private"')
    expect(html).toContain('data-mailbox-quota="mail-user-private" data-mailbox-quota-value="512"')
    expect(html).toContain('data-remove-mailbox="mail-user-private"')
    expect(html).toContain('data-handoff="xmail" data-handoff-mailbox="sales@example.test"')
    expect(html).toContain('data-handoff-status role="status" aria-live="polite" hidden')
    expect(html).not.toContain('>mail-user-private<')
    expect(html).not.toContain('>domain-private<')
  })

  it('preserves a read-only list without mutation controls while retaining authorized webmail handoff', () => {
    const html = page({ canManage: false })
    expect(html).toContain('sales@example.test')
    expect(html).toContain('data-handoff="xmail"')
    expect(html).not.toContain('data-mailbox-form')
    expect(html).not.toContain('data-mailbox-password=')
    expect(html).not.toContain('data-mailbox-quota=')
    expect(html).not.toContain('data-remove-mailbox=')
    expect(html).not.toContain('data-mailbox-password-dialog')
  })

  it('distinguishes unread and failed collections from a successful empty read', () => {
    const unread = page({ users: { state: 'unread' } })
    const failed = page({ users: { state: 'failed' } })
    const empty = page({ users: { state: 'read', items: [] } })
    expect(unread).toContain('data-collection-state="unread"')
    expect(unread).not.toContain('No service users were returned.')
    expect(failed).toContain('data-collection-state="failed"')
    expect(failed).toContain('data-table-state="error"')
    expect(failed).toContain('This list could not be read.')
    expect(empty).toContain('data-collection-state="empty"')
    expect(empty).toContain('No service users were returned.')
  })

  it('keeps the creation form visible but disabled when no authorized domain was read', () => {
    for (const domains of [{ state: 'unread' }, { state: 'failed' }, { state: 'read', items: [] }] as const) {
      const html = page({ domains })
      expect(html).toContain('name="domainId" required disabled')
      expect(html).toContain('No authorized domain was read. Creation is unavailable.')
      expect(html).toContain('type="submit" class="v2-btn v2-btn--primary" disabled')
    }
  })

  it('shows stored service facts and unread observations without invented mailbox usage or sign-in times', () => {
    const html = page({ users: { state: 'read', items: [user, { ...user, id: 'ftp-only', login: 'deploy@example.test', services: { email: false, ftp: true, webdisk: true }, mailboxQuotaMb: 'unlimited' }] } })
    expect(html).toContain('public_html/incoming')
    expect(html).toContain('No mailbox')
    expect(html).toContain('Connection hosts, ports, mailbox usage and delivery health were not read.')
    expect(html).not.toContain('data-mailbox-password="ftp-only"')
    expect(html).not.toContain('data-handoff-mailbox="deploy@example.test"')
  })

  it('escapes untrusted labels, login, paths and domain names while keeping routing IDs out of visible text', () => {
    const attack = '<img src=x onerror="alert(1)">'
    const html = page({ account: { username: attack, primaryDomain: attack }, domains: { state: 'read', items: [{ id: attack, name: attack }] }, users: { state: 'read', items: [{ ...user, id: attack, login: attack, ftpDir: attack }] } })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(html).not.toContain('class="xp-')
  })

  it('keeps label values on one content edge and isolates technical fragments for Arabic', () => {
    const html = renderV2EmailAccountsPage(v2Messages.translator('ar'), {
      account: { username: 'alice', primaryDomain: 'example.test' }, domains: { state: 'read', items: [] },
      users: { state: 'read', items: [user] }, canManage: false,
    })
    expect(html).toContain('<dd><bdi class="v2-mono v2-num" dir="ltr">alice</bdi></dd>')
    expect(html).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]/)
    expect(html).not.toContain('<dd dir="ltr">')
  })
})

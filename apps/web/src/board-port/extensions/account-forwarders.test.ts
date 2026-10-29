import { describe, expect, it } from 'vitest'
import { renderAccountForwarders } from './account-forwarders.ts'
import { renderAccountPagesExtension, type AccountPagesExtensionInput } from './account-pages.ts'

describe('account forwarder configuration view', () => {
  it('keeps unread and observed empty states distinct and never claims activation before a read', () => {
    const unread = renderAccountForwarders({ lang: 'en', domains: [], canManage: true })
    const empty = renderAccountForwarders({ lang: 'en', domains: [], forwarders: [], canManage: true })
    expect(unread).toContain('Records have not been read.')
    expect(empty).toContain('No forwarders.')
    expect(empty).not.toContain('Applied')
    expect(empty).not.toContain('has not been applied')
  })
  it('offers the design options: reject with an error, autoresponders and the default address', () => {
    const html = renderAccountForwarders({ lang: 'en', domains: [{ name: 'tenant.test' }], mailboxes: ['info@tenant.test'], canManage: true })
    expect(html).toContain('value="reject"')
    expect(html).not.toContain('unavailable')
    expect(html).toContain('data-autoresponder-form')
    expect(html).toContain('Starts (UTC)')
    expect(html).toContain('No end date')
    expect(html).toContain('data-default-form')
    expect(html).toContain('Discard silently')
    const noMailbox = renderAccountForwarders({ lang: 'en', domains: [{ name: 'tenant.test' }], mailboxes: [], canManage: true })
    // an address without a mailbox can answer too, so the form needs only a domain
    expect(noMailbox).toContain('data-autoresponder-form')
    expect(noMailbox).toContain('answers without a mailbox')
    expect(renderAccountForwarders({ lang: 'en', domains: [], mailboxes: [], canManage: true })).not.toContain('data-autoresponder-form')
  })
  it('renders scoped metadata without mutation controls when read-only', () => {
    const html = renderAccountForwarders({ lang: 'en', domains: [{ name: 'tenant.test' }], canManage: false, forwarders: [{ id: 'internal-id', source: 'info@tenant.test', destinations: ['outside@recipient.test'] }] })
    expect(html).toContain('info@tenant.test')
    expect(html).not.toContain('<form')
    expect(html).not.toContain('data-forwarder-delete=')
    expect(html).not.toContain('internal-id')
  })
  it('escapes stored strings in content and attributes', () => {
    const html = renderAccountForwarders({ lang: 'en', domains: [{ name: '<script>' }], canManage: true, forwarders: [{ id: '" onclick="bad', source: '<img src=x>', destinations: ['<script>bad</script>'] }] })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data-forwarder-delete="" onclick=')
    expect(html).toContain('&lt;script&gt;')
  })
  it('keeps Arabic labels and isolated technical addresses', () => {
    const html = renderAccountForwarders({ lang: 'ar', domains: [{ name: 'tenant.test' }], canManage: true, forwarders: [{ id: 'record', source: 'info@tenant.test', destinations: ['outside@recipient.test'] }] })
    expect(html).toContain('رفضه برسالة خطأ إلى المرسل')
    expect(html).toContain('<bdi dir="ltr"')
    expect(html).toContain('العنوان الافتراضي')
    expect(html).toContain('aria-live="polite"')
  })
  const ownerInput = (): AccountPagesExtensionInput => ({
    locale: 'en', route: '/email/forwarders',
    principal: { id: 'principal-a', kind: 'user', username: 'alice', accountId: 'account-a' },
    account: { id: 'account-a', planId: 'plan-a', status: 'active', contactEmail: 'alice@tenant.test' },
    domains: { state: 'read', items: [{ accountId: 'account-a', name: 'tenant.test' }, { accountId: 'account-b', name: 'foreign.test' }] },
  })
  it('keeps configuration mutations closed without explicit route qualification', () => {
    const html = renderAccountPagesExtension(ownerInput())
    expect(html).not.toContain('data-forwarder-create')
    expect(html).toContain('data-forwarder-refresh')
  })
  it('admits qualified owner configuration only with a domain read', () => {
    const html = renderAccountPagesExtension({ ...ownerInput(), mutationsQualified: true })
    expect(html).toContain('data-forwarder-create')
    expect(html).toContain('tenant.test')
    expect(html).not.toContain('foreign.test')
    const unread = renderAccountPagesExtension({ ...ownerInput(), mutationsQualified: true, domains: { state: 'unread' } })
    expect(unread).not.toContain('data-forwarder-create')
  })
  it('discards all content for a wrong principal, other account or suspended owner', () => {
    const input = ownerInput()
    expect(renderAccountPagesExtension({ ...input, principal: { ...input.principal, kind: 'root' } })).toBe('')
    expect(renderAccountPagesExtension({ ...input, account: { ...input.account, id: 'other-account' } })).toBe('')
    expect(renderAccountPagesExtension({ ...input, account: { ...input.account, status: 'suspended' } })).toBe('')
  })
})

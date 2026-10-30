import { describe, expect, it } from 'vitest'
import { defaultPlan, type Account, type Domain, type ServiceUser } from '@xpanel/core'
import { parseMarkup, type MarkupNode } from '../../../../markup.ts'
import {
  renderV2PanelEmailTool, renderV2PanelMailingLists, renderV2PanelEmailFilters, renderV2PanelDeliverability,
  renderV2PanelSpamFilters, renderV2PanelQuarantine, renderV2PanelEmailArchive,
  renderV2PanelEmailEncryption, renderV2PanelCalendarsContacts, V2_PANEL_EMAIL_TOOL_ROUTES, PANEL_ADDITIONAL_CSS,
} from './index.ts'

const account: Account = {
  id: '10000000-0000-4000-8000-000000000001', username: 'alice', uid: 20014, gid: 20014,
  home: '/home/alice', primaryDomain: 'alice.example', planId: 'plan', ownerId: null, status: 'active',
  suspendReason: null, contactEmail: '', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z',
}
const domain: Domain = {
  id: '10000000-0000-4000-8000-000000000002', accountId: account.id, name: account.primaryDomain, kind: 'primary',
  parentId: null, docRoot: '/home/alice/public_html', siteType: 'php', upstream: null, redirect: null,
  php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 0, processIdleTimeoutSec: 10 }, ini: {} },
  wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited',
}
const mailbox: ServiceUser = { id: '10000000-0000-4000-8000-000000000003', accountId: account.id, login: 'info@alice.example', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' }
const authority = { canRead: true, canManage: true }
const readOnly = { canRead: true, canManage: false }
const props = { account, domains: [domain], serviceUsers: [mailbox] }
const renderers = [renderV2PanelMailingLists, renderV2PanelEmailFilters, renderV2PanelDeliverability, renderV2PanelSpamFilters, renderV2PanelQuarantine, renderV2PanelEmailArchive, renderV2PanelEmailEncryption, renderV2PanelCalendarsContacts]
const by = (html: string, attribute: string, value?: string): MarkupNode | undefined => parseMarkup(html).find(node => node.template < 0 && node.attrs.has(attribute) && (value === undefined || node.attrs.get(attribute) === value))


const assertUnknownWorkspace = (html: string): void => {
  const nodes = parseMarkup(html)
  const live = nodes.filter(node => node.template < 0)
  expect(live.filter(node => (node.attrs.get('class') ?? '').split(/\s+/).includes('v2-card')).length).toBeGreaterThanOrEqual(2)
  const controls = live.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))
  if (controls.length) expect(live.some(node => node.attrs.get('data-readonly') === 'true')).toBe(true)
  for (const node of live.filter(node => ['input', 'select', 'textarea', 'button'].includes(node.tag))) {
    let current: typeof node | undefined = node
    let blocked = node.attrs.has('disabled')
    while (current && !blocked) {
      blocked = current.attrs.get('data-readonly') === 'true' || current.tag === 'fieldset' && current.attrs.has('disabled')
      current = current.parent < 0 ? undefined : nodes[current.parent]
    }
    expect(blocked, node.tag + ' must remain inside an inert controller boundary').toBe(true)
  }
  for (const node of live) for (const [key, value] of node.attrs) {
    if (/^data-.*(?:can-read|can-manage|manage)$/.test(key)) expect(value, key).not.toBe('true')
  }
}

describe('v2 account email tool family', () => {
  it('dispatches exactly its 8 documents and leaves unrelated routes to their own renderers', () => {
    expect(V2_PANEL_EMAIL_TOOL_ROUTES).toHaveLength(8)
    for (const activeRoute of V2_PANEL_EMAIL_TOOL_ROUTES) expect(renderV2PanelEmailTool({ ...props, activeRoute }, authority)).toContain(`data-v2-panel-page="${activeRoute}"`)
    for (const activeRoute of ['/email/accounts', '/email/forwarders', '/email/archive/unknown', '/mail/settings/spam', '/whm/email/queue']) expect(renderV2PanelEmailTool({ ...props, activeRoute }, authority)).toBeUndefined()
  })

  it('requires explicit read authority before exposing account data or binding any email controller', () => {
    for (const render of renderers) {
      const html = render(props)
      assertUnknownWorkspace(html)
      for (const secret of [account.id, account.username, domain.name, mailbox.login]) expect(html).not.toContain(secret)
      expect(html).toContain('v2-card')
    }
  })

  it('requires a real account even when the caller supplied positive authority', () => {
    for (const render of renderers) {
      const html = render({ serviceUsers: [mailbox], domains: [domain] }, authority)
      assertUnknownWorkspace(html)
      expect(html).not.toContain(mailbox.login)
      expect(html).not.toContain(domain.name)
    }
  })

  it('filters every supplied domain/mailbox choice to the account and distinguishes unread domain options', () => {
    const foreignDomain = { ...domain, id: 'foreign-domain', accountId: 'neighbor', name: 'foreign.example' }
    const foreignMailbox = { ...mailbox, id: 'foreign-mailbox', accountId: 'neighbor', login: 'secret@foreign.example' }
    const injected = { ...props, domains: [domain, foreignDomain], serviceUsers: [mailbox, foreignMailbox] }
    for (const render of renderers) {
      const html = render(injected, authority)
      expect(html).not.toContain(foreignDomain.name)
      expect(html).not.toContain(foreignMailbox.login)
    }
    expect(renderV2PanelEmailFilters({ account }, authority)).toContain('Mailbox options have not been read.')
    expect(renderV2PanelEmailFilters({ account, serviceUsers: [] }, authority)).not.toContain('Mailbox options have not been read.')
    expect(by(renderV2PanelMailingLists({ account }, authority), 'data-ml-create')?.attrs.has('disabled')).toBe(true)
  })

  it('takes the mailing-list cap only from the matching saved plan', () => {
    const basePlan = defaultPlan({ id: account.planId, name: 'Account plan' })
    const plan = { ...basePlan, caps: { ...basePlan.caps, mailingLists: 17 } }
    const matched = renderV2PanelMailingLists({ ...props, plan }, authority)
    expect(matched).toContain('>17</bdi>')
    const foreign = renderV2PanelMailingLists({ ...props, plan: { ...plan, id: 'neighbor-plan', caps: { ...plan.caps, mailingLists: 901 } } }, authority)
    expect(foreign).not.toContain('>901</bdi>')
    expect(foreign).toContain('Not read')
  })

  it('preserves saved list configuration and the independent delivery/moderation workspace', () => {
    const html = renderV2PanelMailingLists(props, authority)
    for (const hook of ['data-mailing-lists', 'data-mailing-lists-rows', 'data-mailing-list-status', 'data-ml-name', 'data-ml-domain', 'data-ml-members', 'data-ml-moderation', 'data-ml-archive', 'data-ml-create', 'data-mailx-lists-refresh', 'data-mailx-lists-rows', 'data-mailx-lists-status', 'data-mailx-lists-apply']) expect(by(html, hook), hook).toBeDefined()
    expect(by(html, 'data-mailx-tools')?.attrs.get('data-mailx-tools-section')).toBe('lists')
    expect(html).toContain('Moderation needs a list manager')
    expect(by(html, 'data-mailx-lists-apply')?.attrs.has('disabled')).toBe(true)
  })

  it('keeps all filter editor, testing and compilation contracts with their real named fields', () => {
    const html = renderV2PanelEmailFilters(props, authority)
    for (const hook of ['data-filter-list', 'data-filter-count', 'data-filter-empty', 'data-filter-scope', 'data-filter-editor', 'data-filter-conditions', 'data-filter-actions', 'data-filter-test', 'data-filter-test-run', 'data-filter-trace', 'data-filter-outcome', 'data-filter-compilation', 'data-filter-preview']) expect(by(html, hook), hook).toBeDefined()
    const nodes = parseMarkup(html)
    for (const name of ['name', 'enabled', 'matchAll', 'stop', 'from', 'to', 'subject', 'body']) expect(nodes.some(node => node.attrs.get('name') === name), name).toBe(true)
    expect(html).toContain('mailbox:info@alice.example')
    expect(html).toContain('Nothing is delivered or sent.')
  })

  it('keeps spam thresholds bounded and separates saved policy from observed native mailbox effects', () => {
    const html = renderV2PanelSpamFilters(props, authority)
    for (const key of ['spam-rewrite', 'spam-header', 'spam-greylist', 'spam-reject', 'spam-autodelete-score']) {
      const node = by(html, 'data-spam-score', key)!
      expect(Object.fromEntries(node.attrs)).toMatchObject({ type: 'number', min: '0', max: '100', step: '0.5', dir: 'ltr' })
    }
    expect(by(html, 'data-mailx-tools')?.attrs.get('data-mailx-tools-section')).toBe('spam')
    expect(html).toContain('Mailbox spam state has not been read.')
    expect(html).toContain('BoxTrapper is unavailable on this server.')
    expect(by(html, 'data-mailx-tools-apply')?.attrs.has('disabled')).toBe(true)
  })

  it('retains quarantine paging, review, bounded release, independent deletion and explicit digest state', () => {
    const html = renderV2PanelQuarantine(props, authority)
    for (const key of ['mailbox', 'total', 'observed', 'messages', 'detail', 'from', 'subject', 'received', 'held', 'score', 'headers', 'refresh', 'older', 'newest', 'release', 'delete', 'allow', 'retention', 'expire', 'release-limit']) expect(by(html, `data-quarantine-${key}`), key).toBeDefined()
    for (const key of ['older', 'newest', 'release', 'delete', 'allow', 'expire']) expect(by(html, `data-quarantine-${key}`)?.attrs.has('disabled'), key).toBe(true)
    expect(by(html, 'data-quarantine-detail')?.attrs.has('hidden')).toBe(true)
    expect(html).toContain('1 MiB bounded learning size')
    expect(html).toContain('digest transport is not configured')
  })

  it('keeps archive facts and all 7 policy columns without assuming an applied policy', () => {
    const html = renderV2PanelEmailArchive(props, authority)
    for (const key of ['saved', 'host', 'state', 'observed-at', 'updated']) expect(by(html, 'data-mailx-archive-fact', key)).toBeDefined()
    expect(by(html, 'data-mailx-archive-form')?.tag).toBe('form')
    expect(by(html, 'data-mailx-archive-save')?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('colspan="7"')
    expect(html).toContain('Retention runs only when you start it.')
    expect(by(renderV2PanelEmailArchive(props, readOnly), 'data-mailx-archive-form')?.tag).toBe('div')
  })

  it('keeps OpenPGP passphrases blank, file import bounded and destructive controls locked before selection', () => {
    const html = renderV2PanelEmailEncryption(props, authority)
    const passphrase = by(html, 'data-pgp-passphrase')!
    expect(Object.fromEntries(passphrase.attrs)).toMatchObject({ type: 'password', autocomplete: 'new-password', minlength: '12', maxlength: '1024' })
    expect(passphrase.attrs.has('value')).toBe(false)
    expect(by(html, 'data-pgp-file')?.attrs.get('accept')).toBe('.asc,application/pgp-keys,text/plain')
    for (const key of ['generate', 'import', 'delete']) expect(by(html, `data-pgp-${key}`)?.attrs.has('disabled')).toBe(true)
    expect(html).toContain('up to 256 KiB')
    expect(html).toContain('xMail does not sign, encrypt or decrypt messages')
  })

  it('keeps calendar handoffs mailbox-select bound and no DAV endpoint or invented collection records', () => {
    const html = renderV2PanelCalendarsContacts(props, authority)
    for (const hook of ['data-collaboration-collections', 'data-collaboration-shares', 'data-collaboration-create', 'data-mailx-calendar-mailbox', 'data-mailx-calendar-target', 'data-mailx-calendar-name', 'data-mailx-calendar-color', 'data-mailx-calendar-timezone', 'data-mailx-calendar-save', 'data-mailx-calendar-delete', 'data-mailx-descriptions', 'data-mailx-address-books', 'data-mailx-task-lists', 'data-mailx-collections-save']) expect(by(html, hook), hook).toBeDefined()
    const handoffs = parseMarkup(html).filter(node => node.attrs.has('data-handoff'))
    expect(handoffs).toHaveLength(2)
    for (const handoff of handoffs) expect(Object.fromEntries(handoff.attrs)).toMatchObject({ 'data-handoff': 'xmail', 'data-handoff-mailbox-select': 'collaboration-mailbox', 'data-handoff-state': 'idle' })
    expect(html).not.toMatch(/https?:\/\/[^"\s<]*\/dav/)
    expect(html).toContain('no CalDAV or CardDAV server is installed')
    const readOnlyHtml = renderV2PanelCalendarsContacts(props, readOnly)
    expect(readOnlyHtml).not.toContain('<form')
    expect(by(readOnlyHtml, 'data-mailx-calendar-save')?.attrs.has('disabled')).toBe(true)
  })

  it('never upgrades stored domain names to delivery success and distinguishes an empty authorized domain read', () => {
    const html = renderV2PanelDeliverability(props, authority)
    expect(html).toContain(domain.name)
    expect(html).toContain('data-check-state="unread"')
    expect(html).toContain('data-wiring="unavailable" disabled')
    expect(html).not.toContain('Passed')
    expect(renderV2PanelDeliverability({ account, domains: [] }, authority)).toContain('The read returned no domains.')
    expect(renderV2PanelDeliverability({ account }, authority)).not.toContain('The read returned no domains.')
  })

  it('locks writes for both read-only authority and inactive account while keeping full sections', () => {
    for (const state of [{ ...props, account: { ...account, status: 'suspended' as const } }, props]) {
      const auth = state === props ? readOnly : authority
      expect(by(renderV2PanelMailingLists(state, auth), 'data-ml-create')?.attrs.has('disabled')).toBe(true)
      expect(by(renderV2PanelSpamFilters(state, auth), 'data-spam-save')?.attrs.has('disabled')).toBe(true)
      expect(by(renderV2PanelEmailFilters(state, auth), 'data-filter-new')?.attrs.has('disabled')).toBe(true)
      expect(renderV2PanelCalendarsContacts(state, auth)).toContain('Collection settings')
    }
  })

  it('escapes all account-owned names and keeps explicit Arabic direction and ASCII numeric roles', () => {
    const html = renderV2PanelMailingLists({ ...props, locale: 'ar', domains: [{ ...domain, name: '<img src=x onerror=alert(1)>' }] }, authority)
    expect(html).toContain('dir="rtl"')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
    expect(renderV2PanelEmailEncryption({ ...props, locale: 'ar' }, authority)).toContain('value="365"')
    expect(PANEL_ADDITIONAL_CSS).toContain('gap:var(--space-1)')
    expect(PANEL_ADDITIONAL_CSS).toContain('gap:var(--space-2)')
    expect(PANEL_ADDITIONAL_CSS).toContain('gap:var(--space-3)')
    expect(PANEL_ADDITIONAL_CSS).toContain('gap:var(--space-4)')
    expect(PANEL_ADDITIONAL_CSS).not.toMatch(/text-align:\s*(?:left|right)|margin-(?:left|right)|padding-(?:left|right)/)
  })
})

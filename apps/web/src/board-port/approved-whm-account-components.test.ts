import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import type { Account, Plan, Reseller } from '@xpanel/core'
import type { WhmSurfaceProps } from '../surfaces/xwhm.ts'
import { renderApprovedWhmAccountActions, renderApprovedWhmAccountBulkControls, renderApprovedWhmAccountCreateFields, renderApprovedWhmAccountCreateStatus, renderApprovedWhmAccountSelection, renderApprovedWhmAccountTableCells } from './approved-whm-account-components.ts'

const reseller: Reseller = { id: '10000000-0000-4000-8000-000000000001', username: 'provider7', acl: ['list-accounts', 'create-account', 'edit-account', 'change-plan'], maxAccounts: 5, totalDiskMb: 4096, totalBandwidthMb: 16384, oversell: false, nameservers: [], delegatedIps: [] }
const foreign: Reseller = { ...reseller, id: '10000000-0000-4000-8000-000000000002', username: 'foreignProvider' }
const account: Account = { id: '20000000-0000-4000-8000-000000000001', username: 'owner7', uid: 1007, gid: 1007, home: '/home/owner7', primaryDomain: 'owner7.example.test', planId: '30000000-0000-4000-8000-000000000001', ownerId: reseller.id, status: 'active', suspendReason: null, contactEmail: 'owner7@example.test', ipv4: '192.0.2.7', shell: 'none', createdAt: '2026-10-25T00:00:00.000Z' }
const plan: Plan = { id: account.planId, name: 'Configured plan7', ownerId: reseller.id, featureListId: '40000000-0000-4000-8000-000000000001', resources: { diskMb: 512, bandwidthMbMonth: 2048, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 1, phpWorkers: 1 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 128 }
const otherPlan: Plan = { ...plan, id: '30000000-0000-4000-8000-000000000002', name: 'Foreign private plan', ownerId: foreign.id }
const globalPlan: Plan = { ...plan, id: '30000000-0000-4000-8000-000000000003', name: 'Shared root plan', ownerId: null }
const qualifiedIds = new Set(['list-accounts', 'create-account', 'modify-account'])
const catalog = tools.map(tool => qualifiedIds.has(tool.id) ? { ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } } : tool)
const root = { kind: 'root' as const, id: 'root-private-key', username: 'administrator7' }
const base = (): WhmSurfaceProps => ({ principal: root, catalog, accounts: [account], resellers: [reseller, foreign], plans: [plan, otherPlan, globalPlan] })
const text = (html: string) => html.replace(/<[^>]+>/g, '')
const fragments = (props: WhmSurfaceProps) => renderApprovedWhmAccountCreateFields(props) + renderApprovedWhmAccountCreateStatus(props) + renderApprovedWhmAccountBulkControls(props) + renderApprovedWhmAccountSelection(props, account.username) + renderApprovedWhmAccountActions(props, account.username) + renderApprovedWhmAccountTableCells(props, account.username)

describe('approved account creation components', () => {
  it('provides owner and shell fields and a local generator for the existing native create form', () => {
    const html = renderApprovedWhmAccountCreateFields(base())
    expect(html).toContain('name="ownerId" value="" checked')
    expect(html).toContain(`name="ownerId" value="${reseller.id}"`)
    expect(html).toContain('name="shell" type="radio" value="none"')
    expect(html).toContain('Owner after this account')
    expect(html).toContain('Candidate not read')
    expect(html).toContain('data-create-owner-capacity')
    expect(html).toContain('name="shell" type="radio" value="jailed" checked')
    expect(html).toContain('data-account-generate-password data-password-target="new-acc-password"')
    expect(html).toContain('data-account-toggle-password data-password-target="new-acc-password" aria-pressed="false"')
    expect(html).not.toMatch(/<form\b|<h1\b|name="password"|value="[A-Za-z0-9!]{12,}"/)
    expect(text(html)).not.toContain(reseller.id)
    expect(text(html)).not.toContain(root.id)
  })

  it('allows a reseller only its own create owner without copying foreign reseller metadata', () => {
    const html = renderApprovedWhmAccountCreateFields({ ...base(), principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: reseller })
    expect(html).toContain(`name="ownerId" value="${reseller.id}" checked`)
    expect(html).toContain('provider7')
    expect(html).not.toContain(foreign.id)
    expect(html).not.toContain(foreign.username)
    expect(html).not.toContain('name="ownerId" value="" checked')
  })

  it('requires both host qualification and caller create permission', () => {
    for (const props of [{ ...base(), catalog: undefined }, { ...base(), principal: { kind: 'reseller' as const, id: reseller.id, username: reseller.username }, activeReseller: { ...reseller, acl: ['list-accounts'] as Reseller['acl'] } }, { ...base(), principal: { kind: 'user' as const, id: 'user-private', username: 'root', accountId: account.id } }]) {
      const html = renderApprovedWhmAccountCreateFields(props)
      expect(html).toContain('data-capability-state="unavailable"')
      expect(html).not.toContain(reseller.id)
      expect(html).not.toContain(foreign.username)
      for (const control of html.matchAll(/<(?:input|button)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
    }
  })

  it('does not accept broad catalog status or incomplete delivery as create readiness', () => {
    const broad = catalog.map(tool => tool.id === 'create-account' ? { ...tool, delivery: { ...tool.delivery, status: 'researched' as const } } : { ...tool, status: 'verified' as const })
    const html = renderApprovedWhmAccountCreateFields({ ...base(), catalog: broad })
    expect(html).toContain('data-capability-state="unavailable"')
    expect(html).not.toContain(reseller.id)
  })

  it('shows operation steps and expected artifacts without fabricating a provisioning result', () => {
    const html = renderApprovedWhmAccountCreateStatus(base())
    expect(html.match(/data-account-creation-step="/g)).toHaveLength(6)
    expect(html.match(/data-account-creation-step-state>Not observed/g)).toHaveLength(6)
    for (const label of ['Creation progress', 'What will be created', 'Linux user', 'Home', 'Slice', 'Apache vhost', 'Nginx server', 'PHP-FPM pool', 'DNS zone', 'Mail domain', 'Databases']) expect(html).toContain(label)
    expect(html).not.toMatch(/<form\b|<h1\b|role="progressbar"|aria-valuenow|Created xpanel|1007|\/home\/owner7|192\.0\.2\.7/)
    expect(html).toContain('No account-creation operation has been observed')
    expect(html.match(/<textarea[^>]*readonly disabled[^>]*><\/textarea>/g)).toHaveLength(3)
    expect(html).toContain('data-account-create-another data-create-route="/whm/accounts/new?lang=en&amp;theme=dark&amp;density=comfortable"')
  })
})

describe('approved account list components', () => {
  it('preserves the bulk bar and row selection with honest disabled action semantics', () => {
    const html = renderApprovedWhmAccountBulkControls(base())
    for (const label of ['Selected accounts', 'Select loaded accounts', '0 selected', 'Suspend', 'Unsuspend', 'Change plan', 'Change owner', 'Clear selection']) expect(html).toContain(label)
    expect(html).toContain('no reviewed sequential-operation contract')
    expect(html).toContain('Rows per page')
    expect(html).toContain('native account-list pager')
    expect(html).not.toMatch(/data-list-next|data-list-previous|data-list-pages/)
    for (const control of html.matchAll(/<(?:input|button)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
    const selection = renderApprovedWhmAccountSelection(base(), account.username)
    expect(selection).toContain('value="owner7" data-account-selection disabled')
    expect(selection).not.toContain(account.id)
  })

  it('binds supported plan and root ownership forms for a qualified account context', () => {
    const html = renderApprovedWhmAccountActions(base(), account.username)
    expect(html).toContain('data-account-plan-form="true" data-account-username="owner7"')
    expect(html).toContain('data-account-plan-status')
    expect(html).toContain('name="planId"')
    expect(html).toContain(`value="${account.planId}" selected`)
    expect(html).toContain('data-reseller-owner-form="true" data-account-username="owner7"')
    expect(html).toContain('data-reseller-owner-status')
    expect(html).toContain(`value="${reseller.id}" selected`)
    expect(html.match(/<form\b/g)).toHaveLength(2)
    expect(html.match(/<\/form>/g)).toHaveLength(2)
    expect(html).not.toMatch(/<h1\b|active host limits\.<\/p>\s*<[^>]*role="status"[^>]*>Success/)
  })

  it('filters foreign rows and plan ownership while denying reseller ownership changes', () => {
    const scoped = { ...base(), principal: { kind: 'reseller' as const, id: reseller.id, username: reseller.username }, activeReseller: reseller, accounts: [account, { ...account, username: 'foreign7', ownerId: foreign.id }] }
    const html = renderApprovedWhmAccountActions(scoped, account.username)
    expect(html).toContain('data-account-plan-form')
    expect(html).toContain(plan.name)
    expect(html).toContain(globalPlan.name)
    expect(html).not.toContain(otherPlan.name)
    expect(html).not.toContain('data-reseller-owner-form')
    expect(html).toContain('Only root may change account ownership')
    expect(renderApprovedWhmAccountActions(scoped, 'foreign7')).not.toContain('foreign7')
    expect(renderApprovedWhmAccountSelection(scoped, 'foreign7')).not.toContain('foreign7')
  })

  it('adds real owner and IP cells while separating unread usage from saved limits', () => {
    const html = renderApprovedWhmAccountTableCells(base(), account.username)
    expect(html.match(/<td\b/g)).toHaveLength(4)
    expect(html).toContain('data-account-table-value="owner"')
    expect(html).toContain('provider7')
    expect(html).toContain('192.0.2.7')
    expect(html).toContain('512 MiB')
    expect(html).toContain('2048 MiB')
    expect(html.match(/Usage has not been read/g)).toHaveLength(2)
    expect(html).not.toMatch(/role="meter"|aria-valuenow|0%|0 MiB/)
    const unknown = renderApprovedWhmAccountTableCells({ ...base(), plans: undefined, resellers: undefined }, account.username)
    expect(unknown).not.toContain(reseller.id)
    expect(unknown).not.toContain('512 MiB')
  })

  it('requires both edit-account and change-plan ACLs for reseller plan updates', () => {
    for (const acl of [['list-accounts', 'change-plan'], ['list-accounts', 'edit-account']] as Reseller['acl'][]) {
      const html = renderApprovedWhmAccountActions({ ...base(), principal: { kind: 'reseller', id: reseller.id, username: reseller.username }, activeReseller: { ...reseller, acl } }, account.username)
      expect(html).not.toContain('data-account-plan-form')
      expect(html).toContain('data-account-plan-readonly')
      expect(html).not.toContain('data-reseller-owner-form')
    }
  })

  it('does not assume a missing current plan or unknown owner means root', () => {
    const html = renderApprovedWhmAccountActions({ ...base(), plans: [globalPlan], resellers: [] }, account.username)
    expect(html).not.toMatch(/data-account-plan-form|data-reseller-owner-form/)
    expect(html).toContain('Current plan not read')
    expect(html).toContain('Owner choices not read')
    expect(html).not.toContain('value="" selected')
  })

  it('retains read-only state for terminating accounts and unqualified account mutations', () => {
    for (const props of [{ ...base(), accounts: [{ ...account, status: 'terminating' as const }] }, { ...base(), catalog: catalog.map(tool => tool.id === 'modify-account' ? { ...tool, status: 'researched' as const } : tool) }]) {
      const html = renderApprovedWhmAccountActions(props, account.username)
      expect(html).not.toMatch(/<form\b/)
      expect(html).toContain('data-account-plan-readonly')
      expect(html).toContain('data-account-owner-readonly')
      for (const control of html.matchAll(/<(?:select|button)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
    }
  })
})

describe('account component output boundaries', () => {
  it.each(['en', 'ar'] as const)('keeps the %s unavailable skeleton without private DTOs, active forms, or non-ASCII digits', locale => {
    const html = fragments({ ...base(), locale, capabilityUnavailable: true })
    expect(html).not.toMatch(/<form\b|provider7|foreignProvider|owner7|Configured plan7|Foreign private plan|root-private-key|192\.0\.2\.7|[\u0660-\u0669\u06f0-\u06f9]/)
    for (const control of html.matchAll(/<(?:input|button|select)\b[^>]*>/g)) expect(control[0]).toMatch(/\bdisabled\b/)
  })

  it('fails closed for a malformed account route key before building mutation or selection attributes', () => {
    const username = 'owner7\" autofocus'
    const props = { ...base(), accounts: [{ ...account, username }] }
    expect(renderApprovedWhmAccountActions(props, username)).not.toMatch(/<form\b|autofocus/)
    expect(renderApprovedWhmAccountSelection(props, username)).not.toMatch(/value=|autofocus/)
  })

  it.each(['en', 'ar'] as const)('preserves the %s label/content inset and isolated physical alignment contract for native preview controls', locale => {
    const html = renderApprovedWhmAccountCreateFields({ ...base(), locale }) + renderApprovedWhmAccountCreateStatus({ ...base(), locale })
    expect(html).toContain('.xp-whm-account-field>label[for]{padding-inline-start:var(--xp-control-content-inset)}')
    expect(html).toContain('.xp-whm-account-field :is(input,textarea)[dir=ltr]{direction:ltr;unicode-bidi:isolate;text-align:left}')
    expect(html).toContain('html[dir=rtl] .xp-whm-account-field :is(input,textarea)[dir=ltr]{text-align:right}')
    expect(html).not.toContain('.xp-whm-account-field :is(input,textarea)[dir=ltr]{text-align:start}')
    expect(html).not.toContain('html[dir=rtl] .xp-whm-account-field :is(input,textarea)[dir=ltr]{text-align:end}')
    for (const key of ['slice', 'apache', 'nginx']) {
      const id = `whm-create-config-${key}`
      expect(html).toMatch(new RegExp(`<div class="xp-whm-account-field"><label class="xp-label" for="${id}">[^<]+</label><textarea id="${id}" class="xp-input xp-mono" dir="ltr" rows="4" readonly disabled aria-describedby="whm-create-config-help"></textarea></div>`))
    }
    expect(html).toContain('gap:var(--xp-space-label,8px)')
    expect(html).toContain('gap:var(--xp-space-field,16px)')
    expect(html).toContain('gap:var(--xp-space-group,24px)')
    expect(html).toContain('gap:var(--xp-space-section,32px)')
  })

  it('keeps fragment IDs unique and escapes supplied public names', () => {
    const html = fragments(base())
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!)
    expect(new Set(ids).size).toBe(ids.length)
    expect(html).not.toMatch(/<h1\b/)
    const escaped = renderApprovedWhmAccountCreateFields({ ...base(), resellers: [{ ...reseller, username: '<unsafe&provider>' }] })
    expect(escaped).toContain('&lt;unsafe&amp;provider&gt;')
    expect(escaped).not.toContain('<unsafe&provider>')
  })
})

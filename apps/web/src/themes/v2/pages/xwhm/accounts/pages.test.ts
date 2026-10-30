import { projectReadOnlyWhmSurface } from '../../../../../models/theme-surface.ts'
import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal, type Reseller } from '@xpanel/core'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2WhmAccountList } from './list.ts'
import { renderV2WhmAccountCreate } from './create.ts'

const t = v2Messages.translator('en')
const root: Principal = { kind: 'root', id: 'internal-root', username: 'operator' }
const plan = defaultPlan({ id: 'internal-plan', name: 'Business', featureListId: 'internal-features' })
const account: Account = { id: 'internal-account', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@external.example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T08:00:00Z' }
const catalog = (ids: readonly string[]): CatalogTool[] => tools.filter(tool => ids.includes(tool.id)).map(tool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))
const props: WhmSurfaceProps = { principal: root, visibility: { principal: root }, accounts: [account], plans: [plan], resellers: [], catalog: catalog(['list-accounts', 'create-account', 'modify-account']) }

describe('v2 account list', () => {
  it('keeps authorized real account actions, the native dialog and list controller hooks', () => {
    const html = renderV2WhmAccountList(t, props)
    for (const hook of ['data-accounts-workspace', 'data-account-list-controls', 'data-list-search-input', 'data-list-pages', 'data-list-previous', 'data-list-next', 'data-account-contact-form', 'data-account-password-form', 'data-account-plan-form', 'data-reseller-owner-form', 'data-handoff="xpanel"', 'data-account-dialog', 'data-account-action-form', 'data-account-dialog-username', 'data-account-dialog-domain', 'data-account-reason-field', 'data-type-to-confirm', 'data-account-action-submit']) expect(html).toContain(hook)
    expect(html).toContain('<dialog ')
    expect(html).toContain('data-action="terminate-account"')
    expect(html).toContain('data-account-status data-state="active"')
    expect(html).toContain('data-account-status-label>Active</span>')
    expect(html).toContain('name="password" type="password" required minlength="8"')
    expect(html).toContain('data-account-id="internal-account"')
    expect(html).not.toContain('>internal-account<')
    expect(html).not.toContain('>internal-plan<')
    expect(html).toContain('Usage / configured plan limit. Usage has not been read.')
    expect(html).toContain('data-account-select-all disabled')
  })

  it('filters reseller rows and metadata before rendering without showing neighboring accounts', () => {
    const principal: Principal = { kind: 'reseller', id: 'internal-reseller', username: 'partner' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] }
    const html = renderV2WhmAccountList(t, { ...props, principal, visibility: { principal, reseller: { acl: reseller.acl } }, activeReseller: reseller, accounts: [{ ...account, ownerId: principal.id }, { ...account, id: 'neighbor', username: 'neighbor', ownerId: 'other', primaryDomain: 'secret.example.test' }] })
    expect(html).toContain('alice.example.test')
    expect(html).not.toContain('secret.example.test')
    expect(html).not.toContain('data-action="terminate-account"')
    expect(html).not.toContain('data-handoff="xpanel"')
  })

  it('distinguishes unread from empty and escapes supplied identity text', () => {
    expect(renderV2WhmAccountList(t, { ...props, accounts: undefined })).toContain('The account list is unavailable.')
    expect(renderV2WhmAccountList(t, { ...props, accounts: [] })).toContain('No accounts.')
    const html = renderV2WhmAccountList(t, { ...props, accounts: [{ ...account, primaryDomain: '<img src=x onerror=alert(1)>' }] })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img src=x')
  })
})

describe('v2 native create account', () => {
  it('provides each native named control once and no fabricated host task result', () => {
    const html = renderV2WhmAccountCreate(t, props)
    for (const name of ['username', 'primaryDomain', 'contactEmail', 'password', 'planId', 'ipAssignment', 'ipv6', 'ownerId']) expect([...html.matchAll(new RegExp(`name="${name}"`, 'g'))]).toHaveLength(1)
    for (const hook of ['data-create-account-form', 'data-account-ip-address', 'data-account-ip-status', 'data-account-ip-refresh', 'data-account-generate-password', 'data-account-toggle-password', 'data-plan-preview-model', 'data-create-plan-preview', 'data-account-create-status', 'data-approved-account-create-status', 'data-account-creation-observation', 'data-account-create-another', 'data-create-route']) expect(html).toContain(hook)
    expect(html).toContain('<option value="dedicated:auto" disabled>')
    expect(html).toContain('No account-creation operation has been observed.')
    expect(html).toContain('data-account-creation-step-state>Not observed')
    expect(html).not.toContain('uid 20017')
    expect(html).not.toContain('value="salma"')
    expect(html).toContain('name="password" type="password" required minlength="8"')
  })

  it('fails closed without qualification and never exposes another owner’s plans', () => {
    const html = renderV2WhmAccountCreate(t, { ...props, catalog: [] })
    expect(html).toContain('Account creation is not qualified for this host or caller.')
    expect(html).toContain('type="submit" class="v2-btn v2-btn--primary" disabled')
    const principal: Principal = { kind: 'reseller', id: 'partner', username: 'partner' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['create-account'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] }
    const own = renderV2WhmAccountCreate(t, { ...props, principal, visibility: { principal, reseller: { acl: reseller.acl } }, activeReseller: reseller, plans: [plan, { ...plan, id: 'neighbor', ownerId: 'other', name: 'Hidden neighbor plan' }] })
    expect(own).not.toContain('Hidden neighbor plan')
    expect(own).toContain('value="partner" checked')
  })
})


describe('v2 stored account facts without provider qualification', () => {
  const unqualified = tools.map(tool => ({ ...tool, status: 'researched' as const, delivery: { ...tool.delivery, status: 'researched' as const } }))
  it('renders a trusted stored list without mounting account mutations or handoff', () => {
    const view = projectReadOnlyWhmSurface({ ...props, activeRoute: '/whm/accounts', capabilityUnavailable: true, catalog: unqualified })!
    const html = renderV2WhmAccountList(t, view.props, view.authority)
    expect(html).toContain('alice.example.test')
    expect(html).toContain('data-account-details')
    for (const hook of ['data-account-contact-form', 'data-account-password-form', 'data-account-plan-form', 'data-reseller-owner-form', 'data-handoff="xpanel"', 'data-action="terminate-account"', 'data-action="suspend-account"']) expect(html).not.toContain(hook)
    expect(view.authority.canRead).toBe(false)
    expect(view.authority.canManage).toBe(false)
    expect(renderV2WhmAccountList(t, view.props)).not.toContain('alice.example.test')
  })
  it('keeps all create controls disabled despite unrelated qualified tools', () => {
    const view = projectReadOnlyWhmSurface({ ...props, activeRoute: '/whm/accounts/new', capabilityUnavailable: true, catalog: unqualified })!
    const html = renderV2WhmAccountCreate(t, { ...view.props, capabilityUnavailable: false, catalog: props.catalog }, view.authority)
    expect(html).toContain('Configured plan limits')
    expect(html).toContain('type="submit" class="v2-btn v2-btn--primary" disabled')
    expect(html).toContain('name="username" type="text" dir="ltr" required pattern="[a-z][a-z0-9]{0,15}" maxlength="16" autocomplete="off" autocapitalize="none" spellcheck="false" disabled')
  })
  it('does not expose stored accounts when the explicit fact grant is missing despite qualified tools', () => {
    const view = projectReadOnlyWhmSurface({ ...props, activeRoute: '/whm/accounts', capabilityUnavailable: true })!
    const html = renderV2WhmAccountList(t, { ...view.props, capabilityUnavailable: false }, { ...view.authority, canRead: true, canManage: true, authorizedTools: new Set() })
    expect(html).not.toContain('alice.example.test')
    expect(html).not.toContain('data-account-contact-form')
    expect(html).not.toContain('data-handoff="xpanel"')
  })
  it('never displays a neighboring reseller account from the supplied snapshot', () => {
    const principal: Principal = { kind: 'reseller', id: 'partner', username: 'partner' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] }
    const view = projectReadOnlyWhmSurface({ ...props, principal, visibility: { principal, reseller }, activeReseller: reseller, activeRoute: '/whm/accounts', capabilityUnavailable: true, catalog: unqualified, accounts: [{ ...account, ownerId: principal.id }, { ...account, id: 'neighbor', username: 'neighbor', ownerId: 'other', primaryDomain: 'secret.example.test' }] })!
    const html = renderV2WhmAccountList(t, view.props, view.authority)
    expect(html).toContain('alice.example.test')
    expect(html).not.toContain('secret.example.test')
    expect(html).not.toContain('data-account-contact-form')
  })
})

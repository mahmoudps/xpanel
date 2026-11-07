import { projectReadOnlyWhmSurface } from '../../../../../models/theme-surface.ts'
import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal, type Reseller } from '@xpanel/core'
import type { WhmSurfaceProps } from '../../../../contract.ts'
import { v2Messages } from '../../../messages.ts'
import { renderV2WhmAccountList } from './list.ts'
import { renderV2WhmAccountCreate } from './create.ts'
import { parseMarkup } from '../../../../markup.ts'

const t = v2Messages.translator('en')
const root: Principal = { kind: 'root', id: 'internal-root', username: 'operator' }
const plan = defaultPlan({ id: 'internal-plan', name: 'Business', featureListId: 'internal-features' })
const account: Account = { id: 'internal-account', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@external.example.test', ipv4: '192.0.2.10', shell: 'none', createdAt: '2026-10-29T08:00:00Z' }
const catalog = (ids: readonly string[]): CatalogTool[] => tools.filter(tool => ids.includes(tool.id)).map(tool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))
const props: WhmSurfaceProps = { principal: root, visibility: { principal: root }, accounts: [account], plans: [plan], resellers: [], catalog: catalog(['list-accounts', 'create-account', 'modify-account']) }

describe('v2 account list', () => {

  it.each(['en', 'ar'] as const)('renders the %s configured IO write cap without treating missing usage as throughput', locale => {
    const translate = v2Messages.translator(locale)
    const ioCell = (html: string): string => {
      const cells = [...html.matchAll(/<td data-account-table-value="io-write">([\s\S]*?)<\/td>/g)]
      expect(cells).toHaveLength(1)
      return cells[0]![1]!
    }
    for (const [cap, expected] of [[2_000_000, '2.00 MB/s'], [0, '0 B/s'], ['unlimited', translate('Unlimited')]] as const) {
      const cell = ioCell(renderV2WhmAccountList(translate, { ...props, locale, plans: [{ ...plan, resources: { ...plan.resources, ioWriteBps: cap } }] }))
      expect(cell.replace(/<[^>]+>/g, '')).toBe(expected)
      if (typeof cap === 'number') expect(cell).toMatch(/<bdi\b[^>]*dir="ltr"/)
      expect(cell).not.toMatch(/[\u0660-\u0669\u06f0-\u06f9]|role="meter"|aria-valuenow/)
    }
    for (const plans of [undefined, [{ ...plan, id: 'unrelated-plan' }], [{ ...plan, resources: { ...plan.resources, ioWriteBps: Number.NaN } }], [{ ...plan, resources: { ...plan.resources, ioWriteBps: -1 } }]]) {
      const cell = ioCell(renderV2WhmAccountList(translate, { ...props, locale, plans }))
      expect(cell).toBe(translate('Not read'))
      expect(cell).not.toContain(' B/s')
    }
  })

  it('never exposes a neighboring reseller plan cap even when its id matches the account', () => {
    const principal: Principal = { kind: 'reseller', id: 'internal-reseller', username: 'partner' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
    const scoped: WhmSurfaceProps = { ...props, principal, visibility: { principal, reseller }, activeReseller: reseller, accounts: [{ ...account, ownerId: principal.id }] }
    const cell = (input: WhmSurfaceProps) => renderV2WhmAccountList(t, input).match(/<td data-account-table-value="io-write">([\s\S]*?)<\/td>/)?.[1] ?? ''
    for (const ownerId of [null, principal.id]) {
      expect(cell({ ...scoped, plans: [{ ...plan, ownerId, resources: { ...plan.resources, ioWriteBps: 2_000_000 } }] })).toContain('2.00 MB/s')
    }
    const foreignPlan = { ...plan, ownerId: 'other-reseller', resources: { ...plan.resources, ioWriteBps: 9_000_000 } }
    expect(cell({ ...scoped, plans: [foreignPlan] })).toBe('Not read')
    expect(cell({ ...scoped, accounts: [{ ...account, ownerId: 'other-reseller' }], plans: [foreignPlan] })).toBe('')
  })

  it.each(['en', 'ar'] as const)('aligns the %s IO cap header, cells and empty table span', locale => {
    const translate = v2Messages.translator(locale)
    const html = renderV2WhmAccountList(translate, { ...props, locale })
    const table = html.match(/<table class="v2-table v2-whm-accounts__table">([\s\S]*?)<\/table>/)?.[1] ?? ''
    const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    const firstRow = table.match(/<tbody>\s*<tr\b[^>]*>([\s\S]*?)<\/tr>/)?.[1] ?? ''
    const cells = [...firstRow.matchAll(/<td\b[^>]*>[\s\S]*?<\/td>/g)]
    expect(headers).toHaveLength(11)
    expect(cells).toHaveLength(headers.length)
    expect(headers[8]![1]).toBe(translate('IO write cap'))
    expect(cells[8]![0]).toContain('data-account-table-value="io-write"')
    expect(renderV2WhmAccountList(translate, { ...props, locale, accounts: [] })).toContain('<td colspan="11">')
  })
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
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
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
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['create-account'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
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
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts'], maxAccounts: 5, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: { disk: false, bandwidth: false }, nameservers: [], delegatedIps: [] }
    const view = projectReadOnlyWhmSurface({ ...props, principal, visibility: { principal, reseller }, activeReseller: reseller, activeRoute: '/whm/accounts', capabilityUnavailable: true, catalog: unqualified, accounts: [{ ...account, ownerId: principal.id }, { ...account, id: 'neighbor', username: 'neighbor', ownerId: 'other', primaryDomain: 'secret.example.test' }] })!
    const html = renderV2WhmAccountList(t, view.props, view.authority)
    expect(html).toContain('alice.example.test')
    expect(html).not.toContain('secret.example.test')
    expect(html).not.toContain('data-account-contact-form')
  })
})


describe('v2 selected account detail composition', () => {
  it.each(['en', 'ar'] as const)('keeps the %s detail panel outside the table and every existing native form once', locale => {
    const translate = v2Messages.translator(locale)
    const html = renderV2WhmAccountList(translate, { ...props, locale, accounts: [account, { ...account, id: 'internal-bob', username: 'bob', primaryDomain: 'bob.example.test' }] })
    const nodes = parseMarkup(html)
    const asides = nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.attrs.has('data-account-detail-panel'))
    expect(asides).toHaveLength(1)
    const detail = asides[0]!
    expect(detail.node.tag).toBe('aside')
    expect(detail.node.attrs.has('hidden')).toBe(true)
    for (let parent = detail.node.parent; parent >= 0; parent = nodes[parent]!.parent) expect(['table', 'tbody', 'tr', 'td']).not.toContain(nodes[parent]!.tag)
    const openers = nodes.filter(node => node.attrs.has('data-account-detail-open'))
    const panels = nodes.filter(node => node.attrs.has('data-account-detail-for'))
    expect(openers.map(node => node.attrs.get('data-account-detail-open')).sort()).toEqual(['alice', 'bob'])
    expect(panels.map(node => node.attrs.get('data-account-detail-for')).sort()).toEqual(['alice', 'bob'])
    for (const opener of openers) {
      expect(opener.tag).toBe('button')
      expect(opener.attrs.get('type')).toBe('button')
      expect(opener.attrs.get('aria-controls')).toBe(detail.node.attrs.get('id'))
      expect(opener.attrs.get('aria-expanded')).toBe('false')
      expect(opener.attrs.has('data-action')).toBe(false)
    }
    expect(panels.every(node => node.tag === 'section' && node.attrs.has('hidden'))).toBe(true)
    for (const hook of ['data-account-contact-form', 'data-account-password-form', 'data-account-plan-form', 'data-reseller-owner-form']) {
      const forms = nodes.filter(node => node.attrs.has(hook))
      expect(forms).toHaveLength(2)
      for (const form of forms) {
        const ancestors: number[] = []
        for (let parent = form.parent; parent >= 0; parent = nodes[parent]!.parent) ancestors.push(parent)
        expect(ancestors).toContain(detail.index)
        expect(ancestors.some(index => nodes[index]!.tag === 'td')).toBe(false)
      }
    }
    const ids = nodes.map(node => node.attrs.get('id')).filter(Boolean)
    expect(new Set(ids).size).toBe(ids.length)
    for (const label of locale === 'ar' ? ['تفاصيل الحساب', 'الهوية والخطة', 'الحدود والاستخدام', 'إغلاق تفاصيل الحساب'] : ['Account details', 'Identity and plan', 'Limits and usage', 'Close account details']) expect(html).toContain(label)
    expect(html).not.toMatch(/<details[^>]*class="v2-whm-accounts__detail"/)
  })

  it('retains unknown usage, empty selection and stored read-only authority without introducing mutation hooks', () => {
    for (const accounts of [undefined, []]) {
      const nodes = parseMarkup(renderV2WhmAccountList(t, { ...props, accounts }))
      expect(nodes.filter(node => node.attrs.has('data-account-detail-for') || node.attrs.has('data-account-detail-open'))).toHaveLength(0)
      expect(nodes.find(node => node.attrs.has('data-account-detail-panel'))?.attrs.has('hidden')).toBe(true)
    }
    const unqualified = tools.map(tool => ({ ...tool, status: 'researched' as const, delivery: { ...tool.delivery, status: 'researched' as const } }))
    const view = projectReadOnlyWhmSurface({ ...props, activeRoute: '/whm/accounts', capabilityUnavailable: true, catalog: unqualified })!
    const html = renderV2WhmAccountList(t, view.props, view.authority)
    const nodes = parseMarkup(html)
    expect(nodes.filter(node => node.attrs.has('data-account-detail-open'))).toHaveLength(1)
    for (const hook of ['data-account-contact-form', 'data-account-password-form', 'data-account-plan-form', 'data-reseller-owner-form', 'data-handoff']) expect(nodes.some(node => node.attrs.has(hook))).toBe(false)
    for (const field of nodes.filter(node => ['contactEmail', 'password'].includes(node.attrs.get('name') ?? ''))) expect(field.attrs.has('disabled')).toBe(true)
    expect(html).toContain('Usage / configured plan limit. Usage has not been read.')
    expect(html).not.toContain('role="meter"')
  })
})

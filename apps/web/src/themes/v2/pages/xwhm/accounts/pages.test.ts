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
      const cells = [...html.matchAll(/<td data-account-table-value="io-write"[^>]*>([\s\S]*?)<\/td>/g)]
      expect(cells).toHaveLength(1)
      return cells[0]![1]!
    }
    for (const [cap, expected] of [[2_000_000, '1.91\u00a0MiB/s'], [0, '0\u00a0B/s'], ['unlimited', translate('Unlimited')]] as const) {
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
    const cell = (input: WhmSurfaceProps) => renderV2WhmAccountList(t, input).match(/<td data-account-table-value="io-write"[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? ''
    for (const ownerId of [null, principal.id]) {
      expect(cell({ ...scoped, plans: [{ ...plan, ownerId, resources: { ...plan.resources, ioWriteBps: 2_000_000 } }] })).toContain('1.91\u00a0MiB/s')
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
    expect(headers).toHaveLength(8)
    expect(cells).toHaveLength(headers.length)
    expect(headers[6]![1]).toBe(translate('IO write cap'))
    expect(cells[6]![0]).toContain('data-account-table-value="io-write"')
    expect(renderV2WhmAccountList(translate, { ...props, locale, accounts: [] })).toContain('<td colspan="8">')
  })
  it('shows measured disk and traffic against the limit with a meter, and Not read for what the host did not report', () => {
    const limited = { ...plan, resources: { ...plan.resources, diskMb: 1000, bandwidthMbMonth: 'unlimited' as const } }
    const read = (bytes: number | null) => ({ state: 'read' as const, bytes, observedAt: '2026-11-10T08:00:00.000Z', unmeasured: bytes === null ? 1 : 0 })
    const html = renderV2WhmAccountList(t, { ...props, plans: [limited], accountUsage: { [account.id]: { disk: read(900 * 1048576), traffic: read(5 * 1048576) } } })
    expect(html).toContain('<bdi dir="ltr">900\u00a0MiB</bdi> / <bdi dir="ltr">1000\u00a0MiB</bdi></span><div class="v2-bar" role="meter" aria-label="Disk" aria-valuemin="0" aria-valuemax="100" aria-valuenow="90" aria-valuetext="900\u00a0MiB / 1000\u00a0MiB"><span class="v2-bar__fill v2-bar--warn" style="inline-size:90%">')
    // An unlimited limit has no scale: the measured value is shown without a bar.
    expect(html).toContain('<bdi dir="ltr">5.00\u00a0MiB</bdi> / Unlimited</span></div>')
    // The disk meter is drawn in the row and in the detail panel; unlimited traffic has none.
    expect([...html.matchAll(/role="meter"/g)]).toHaveLength(2)
    expect(html).not.toContain('Usage / configured plan limit. Usage has not been read.')
    const unreported = renderV2WhmAccountList(t, { ...props, plans: [limited], accountUsage: { [account.id]: { disk: read(null), traffic: { state: 'unavailable', bytes: null, observedAt: null, unmeasured: 1 } } } })
    expect(unreported).toContain('<span>Not read / <bdi dir="ltr">1000\u00a0MiB</bdi></span></div>')
    expect(unreported).toContain('<span>Not read / Unlimited</span></div>')
    expect(unreported).not.toContain('role="meter"')
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

  it('offers plans and IP modes as choice cards and reviews only the real form defaults', () => {
    const html = renderV2WhmAccountCreate(t, { ...props, plans: [plan, { ...plan, id: 'second-plan', name: 'Second plan' }] })
    expect(html).not.toContain('<select id="new-acc-plan"')
    expect(html).toContain('<fieldset class="v2-whm-create__owners" id="new-acc-plan">')
    expect(html).toContain(`<input type="radio" id="new-acc-plan-0" name="planId" value="${plan.id}" required checked data-review-label="Business">`)
    expect(html).toContain('<input type="radio" id="new-acc-plan-1" name="planId" value="second-plan" required data-review-label="Second plan">')
    expect(html).toContain('name="ipMode" value="shared" data-account-ip-mode checked>')
    expect(html).toContain('name="ipMode" value="dedicated:auto" data-account-ip-mode disabled>')
    expect(html).toContain('<select id="new-acc-ipv4" name="ipAssignment" required')
    for (const field of ['username', 'primaryDomain', 'contactEmail', 'planId', 'ownerId', 'ipAssignment', 'ipv6', 'shell']) expect([...html.matchAll(new RegExp(`data-create-review="${field}"`, 'g'))]).toHaveLength(1)
    expect(html).not.toContain('data-create-review="password"')
    expect(html).toContain('<bdi data-create-review="planId">Business</bdi>')
    expect(html).toContain('<bdi data-create-review="ownerId">root</bdi>')
    expect(html).toContain('<bdi data-create-review="username">Not entered</bdi>')
    expect(html).toContain('<bdi data-create-review="shell">Jailed shell</bdi>')
    expect([...html.matchAll(/Checked when submitted/g)]).toHaveLength(3)
    expect(html).toContain('data-account-ip-check>IP availability has not been read.')
  })
  it('formats plan IO rates like the account list instead of raw bytes', () => {
    const html = renderV2WhmAccountCreate(t, { ...props, plans: [{ ...plan, resources: { ...plan.resources, ioReadBps: 2_000_000, ioWriteBps: 'unlimited' } }] })
    expect(html).toContain('<bdi dir="ltr">1.91\u00a0MiB/s</bdi>')
    expect(html).not.toContain('2000000')
  })
  it('keeps one disabled plan control and an unread review when plans were not read', () => {
    const html = renderV2WhmAccountCreate(t, { ...props, plans: undefined })
    expect(html).toContain('<input type="radio" id="new-acc-plan-empty" name="planId" value="" disabled>')
    expect(html).toContain('<bdi data-create-review="planId">Not read</bdi>')
    expect(html).toContain('type="submit" class="v2-btn v2-btn--primary" disabled')
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

describe('v2 account list board regions', () => {
  it('names the list, counts it, keeps secondary values under their primary cell and folds every detail form', () => {
    const html = renderV2WhmAccountList(t, props)
    expect(html).toContain('<h2 id="v2-whm-accounts-list">Account list</h2><p>1 account in total. Newest first.</p>')
    expect(html).toContain('Resellers see only the accounts they own.')
    expect(html).toContain('<a href="/whm/plans" class="v2-btn">Plans</a>')
    expect(html.split('href="/whm/accounts">Clear filters<')).toHaveLength(3)
    expect(html).toContain('<small class="v2-muted v2-mono" data-account-table-value="ip"><bdi dir="ltr">192.0.2.10</bdi></small>')
    expect(html).toContain('<small class="v2-muted" data-account-table-value="owner">Owner <bdi dir="ltr">root</bdi></small>')
    for (const hook of ['disk', 'bandwidth']) expect(html).toContain(`<div class="v2-whm-accounts__quota" data-account-table-value="${hook}">`)
    const nodes = parseMarkup(html)
    for (const hook of ['data-account-contact-form', 'data-account-password-form', 'data-account-plan-form', 'data-account-limits-form']) {
      const form = nodes.find(node => node.attrs.has(hook))!
      expect(nodes[form.parent]!.tag).toBe('details')
    }
    // The row keeps one opener; the handoff lives in the row menu and in the panel, never on the opener.
    const handoffs = nodes.filter(node => node.attrs.has('data-handoff'))
    expect(handoffs).toHaveLength(2)
    expect(handoffs.map(node => node.attrs.get('role') ?? 'button').sort()).toEqual(['button', 'menuitem'])
  })

  it('shows no root scope note, plan link or account count to a caller who may not list accounts', () => {
    const principal: Principal = { kind: 'reseller', id: 'internal-reseller', username: 'partner' }
    const html = renderV2WhmAccountList(t, { ...props, principal, visibility: { principal }, accounts: [] })
    for (const absent of ['Resellers see only the accounts they own.', 'href="/whm/plans"', 'in total.']) expect(html).not.toContain(absent)
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
    // One avatar opener per row; row-menu items open named sections of the same panel.
    expect(openers.filter(node => !node.attrs.has('data-account-detail-section')).map(node => node.attrs.get('data-account-detail-open')).sort()).toEqual(['alice', 'bob'])
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

describe('v2 account row menu, drawer actions and status chips', () => {
  it('opens details sections from the row menu, keeps Suspend and Delete in the drawer, and binds status chips with real counts', () => {
    const suspended = { ...account, id: 'internal-suspended', username: 'bob', primaryDomain: 'bob.example.test', uid: 20002, status: 'suspended' as const }
    const html = renderV2WhmAccountList(t, { ...props, accounts: [account, suspended] })
    const nodes = parseMarkup(html)
    const openers = nodes.filter(node => node.attrs.get('data-account-detail-open') === 'alice')
    // The avatar button comes first: the focus-return target. Menu openers name the part they open and close the menu.
    expect(openers[0]?.attrs.has('data-account-detail-section')).toBe(false)
    const sections = openers.slice(1).map(node => node.attrs.get('data-account-detail-section'))
    expect(sections.length).toBeGreaterThan(0)
    for (const opener of openers.slice(1)) {
      expect(opener.attrs.get('aria-controls')).toBe('v2-account-detail'); expect(opener.attrs.get('aria-expanded')).toBe('false')
      expect(opener.attrs.get('popovertarget')).toBe('v2-account-alice-menu'); expect(opener.attrs.has('data-action')).toBe(false)
    }
    const panel = nodes.findIndex(node => node.attrs.get('data-account-detail-for') === 'alice')
    const inPanel = (index: number) => { for (let at = nodes[index]?.parent ?? -1; at >= 0; at = nodes[at]!.parent) if (at === panel) return true; return false }
    for (const section of sections) expect(nodes.some((node, index) => node.attrs.get('data-account-detail-section') === section && node.tag === 'details' && inPanel(index))).toBe(true)
    const drawerActions = nodes.flatMap((node, index) => node.tag === 'button' && node.attrs.get('data-username') === 'alice' && inPanel(index) ? [node.attrs.get('data-action')] : [])
    expect(drawerActions).toEqual(['suspend-account', 'terminate-account'])
    expect(html).toMatch(/data-account-detail-for="bob".*data-action="unsuspend-account"/s)
    const chips = nodes.filter(node => node.attrs.has('data-list-state-chip'))
    expect(chips.map(node => `${node.attrs.get('data-list-state-chip')}:${node.attrs.get('aria-pressed')}`)).toEqual([':true', 'active:false', 'suspended:false', 'terminating:false'])
    expect(html).toMatch(/data-list-state-chip="suspended">Suspended<span class="v2-count v2-num">1<\/span>/)
  })

  it('offers no chips before the list is readable', () => {
    expect(renderV2WhmAccountList(t, { ...props, accounts: undefined })).not.toContain('data-list-state-chip')
  })
})

import { describe, expect, it } from 'vitest'
import { tools, type CatalogTool } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal } from '@xpanel/core'
import type { UnavailableProps } from './themes/contract.ts'
import { renderV2ReadOnlyPage } from './themes/v2/surfaces/read-only.ts'
import { V2_SECURITY_SLOT, renderV2AccountSecuritySlot } from './themes/v2/surfaces/slots.ts'
import { parseMarkup } from './themes/markup.ts'
import { renderWebApp, unavailableView, type WebAppRenderState } from './app.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))
const account: Account = { id: 'account-test', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-test', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const visibility = { principal: { kind: 'user' as const, id: 'principal-test', username: account.username, accountId: account.id }, disabledFeatures: new Set<string>() }
const props = (changes: Partial<UnavailableProps> = {}): UnavailableProps => ({ surface: 'xpanel', locale: 'en', theme: 'light', density: 'comfortable', route: '/resources', heading: 'Resources', admitted: true, securityPage: false, qualifiedRoutes: new Set(), signedIn: true, visibility, catalog,
  readOnlyFacts: { surface: 'xpanel', panel: { account, plan: defaultPlan({ id: account.planId, name: 'Saved plan' }), visibility, catalog } }, ...changes })

describe('scoped V2 read-only dispatch', () => {
  it('never reads sensitive body facts for a denied route', () => {
    expect(renderV2ReadOnlyPage(props({ admitted: false, readOnlyFacts: undefined }))).toBeUndefined()
  })
  it('rejects absent or mismatched realm facts', () => {
    expect(() => renderV2ReadOnlyPage(props({ readOnlyFacts: undefined }))).toThrow('v2_readonly_facts_missing')
    expect(() => renderV2ReadOnlyPage(props({ readOnlyFacts: { surface: 'xmail', mail: {} } }))).toThrow('v2_readonly_facts_realm_mismatch')
  })
  it('renders a real stored-fact body inside a native-controller blocker', () => {
    const html = renderV2ReadOnlyPage(props())!
    expect(html).toContain('data-readonly="true" data-qualified="false"')
    expect(html).toContain('Saved plan')
    expect(html).not.toContain('v2-unavailable__panel')
    expect(html).not.toContain('id="main-content"')
  })
  it('preserves unknown resource layout without synthesizing an account or plan', () => {
    const html = renderV2ReadOnlyPage(props({ readOnlyFacts: { surface: 'xpanel', panel: { visibility, catalog } } }))!
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('<h1')
    expect(html).not.toContain(account.id)
    expect(html).not.toContain('Saved plan')
  })
  const root = { kind: 'root' as const, id: 'root-test', username: 'operator' }
  const securityCases: readonly UnavailableProps[] = [
    props({ route: '/security/account', securityPage: true }),
    props({ surface: 'xwhm', route: '/whm/security/sign-in', securityPage: true, visibility: { principal: root }, readOnlyFacts: { surface: 'xwhm', whm: { principal: root, visibility: { principal: root }, catalog } } }),
    props({ surface: 'xmail', route: '/mail/settings/security', securityPage: true, readOnlyFacts: { surface: 'xmail', mail: { visibility, catalog } } }),
  ]
  it.each(securityCases)('keeps core security usable and native controls blocked on $surface', value => {
    const html = renderV2ReadOnlyPage(value)!
    expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
    const rendered = renderV2AccountSecuritySlot({ bodyHtml: html, security: { locale: 'en', totpEnabled: false, principalKind: value.surface === 'xwhm' ? 'root' : 'user', surface: value.surface } })
    const nodes = parseMarkup(rendered)
    const core = nodes.filter(node => node.attrs.has('data-account-security'))
    expect(core).toHaveLength(1)
    const ancestorIndices = (index: number): number[] => {
      const parents: number[] = []
      for (let parent = nodes[index]!.parent; parent >= 0; parent = nodes[parent]!.parent) parents.push(parent)
      return parents
    }
    const isBlocked = (index: number): boolean => ancestorIndices(index).some(parent => nodes[parent]!.attrs.get('data-readonly') === 'true' || nodes[parent]!.attrs.get('data-qualified') === 'false')
    const coreIndex = nodes.indexOf(core[0]!)
    expect(isBlocked(coreIndex)).toBe(false)
    expect(core[0]!.attrs.get('data-auth-state')).toBe('optional')
    nodes.forEach((node, index) => {
      if (node.template >= 0 || !['input', 'select', 'textarea', 'button'].includes(node.tag)) return
      if (ancestorIndices(index).includes(coreIndex)) expect(isBlocked(index)).toBe(false)
      else expect(isBlocked(index) || node.attrs.has('disabled')).toBe(true)
    })
    expect(nodes.some(node => node.attrs.has('data-auth-setup-form'))).toBe(true)
    if (value.surface === 'xpanel') {
      const slotNodes = parseMarkup(html), slotIndex = slotNodes.findIndex(node => node.attrs.has('data-v2-account-security-slot'))
      expect(slotIndex).toBeGreaterThanOrEqual(0)
      const owners: string[] = []
      for (let parent = slotNodes[slotIndex]?.parent ?? -1; parent >= 0; parent = slotNodes[parent]?.parent ?? -1) {
        const route = slotNodes[parent]?.attrs.get('data-v2-settings-route')
        if (route) owners.push(route)
      }
      expect(owners).toContain('/security/account')
      expect(isBlocked(nodes.findIndex(node => node.attrs.get('id') === 'v2-security-new-password'))).toBe(true)
    }
  })
  it('refuses a missing, unexpected or duplicated security host', () => {
    expect(() => renderV2ReadOnlyPage(props({ securityPage: true }))).toThrow('v2_readonly_security_slot_missing_or_duplicated')
    expect(() => renderV2ReadOnlyPage(props({ route: '/security/account', securityPage: false }))).toThrow('v2_readonly_unexpected_security_slot')
    const security = { locale: 'en' as const, totpEnabled: false, principalKind: 'user' as const, surface: 'xpanel' as const }
    for (const bodyHtml of ['<section></section>', V2_SECURITY_SLOT + V2_SECURITY_SLOT]) expect(() => renderV2AccountSecuritySlot({ bodyHtml, security })).toThrow('v2_account_security_slot_missing_or_duplicated')
  })
  it('keeps the unknown mailbox Inbox layout without inventing a mailbox identity', () => {
    const html = renderV2ReadOnlyPage(props({ surface: 'xmail', route: '/mail/inbox', readOnlyFacts: { surface: 'xmail', mail: { visibility, catalog } } }))!
    expect(html).toContain('data-readonly="true"')
    expect(html).toContain('data-mail-list')
    expect(html).not.toContain('alice@')
    expect(html).not.toContain('data-mail-folder-workspace="true" data-qualified="true"')
  })
})
interface FactorDocumentCase {
  surface: 'xpanel' | 'xwhm' | 'xmail'
  route: string
  principal: Principal
}
const factorDocuments: readonly FactorDocumentCase[] = [
  { surface: 'xpanel', route: '/security/account', principal: visibility.principal },
  { surface: 'xwhm', route: '/whm/security/sign-in', principal: { kind: 'root', id: 'factor-root', username: 'operator' } },
  { surface: 'xmail', route: '/mail/settings/security', principal: { kind: 'user', id: 'factor-mailbox', username: 'mailbox@example.test', accountId: account.id } },
]
function factorDocumentState(entry: FactorDocumentCase, locale: 'en' | 'ar', qualified: boolean, factorKnown = true): WebAppRenderState {
  const branchCatalog: readonly CatalogTool[] = qualified
    ? tools.map((tool): CatalogTool => ({ ...tool, status: 'verified', delivery: { ...tool.delivery, status: 'verified' } }))
    : catalog
  return { surface: entry.surface, activeRoute: entry.route, locale, uiTheme: 'v2', theme: 'light',
    visibility: { principal: entry.principal }, catalog: branchCatalog, mfaRuntimeMode: 'disabled',
    ...(factorKnown ? { security: { totpEnabled: true } } : {}) }
}
function nativeControlsStayBlocked(html: string): void {
  const nodes = parseMarkup(html)
  nodes.forEach((node, index) => {
    if (node.template >= 0 || !['input', 'select', 'textarea', 'button'].includes(node.tag)) return
    let guarded = node.attrs.has('disabled')
    for (let at = index; at >= 0; at = nodes[at]?.parent ?? -1) {
      const ancestor = nodes[at]
      if (!ancestor) throw new Error('Broken native control ancestry')
      guarded ||= ancestor.attrs.get('data-readonly') === 'true' || ancestor.attrs.get('data-qualified') === 'false'
        || ancestor.tag === 'fieldset' && ancestor.attrs.has('disabled')
    }
    expect(guarded, node.tag).toBe(true)
  })
}

describe('authenticated factor-only document descriptors', () => {
  for (const entry of factorDocuments) for (const locale of ['en', 'ar'] as const) for (const qualified of [false, true]) {
    it(entry.surface + ' retains its full security layout without native facts in ' + locale + ' (qualified=' + qualified + ')', { tags: ['feature'] }, () => {
      const state = factorDocumentState(entry, locale, qualified)
      const descriptor = unavailableView(state, locale, 'light', 'comfortable', entry.route)
      expect(descriptor.admitted).toBe(true)
      const native = descriptor.readOnlyFacts
      if (!native) throw new Error('Missing explicit absent-fact realm')
      expect(native.surface).toBe(entry.surface)
      if (native.surface === 'xpanel') {
        expect(native.panel).toEqual({ authPersonal: { state: 'unavailable', canChangePassword: false,
          canReadSessions: false, canRevokeSessions: false, canReadApiTokens: false, canManageApiTokens: false } })
      } else {
        expect(native.surface === 'xwhm' ? native.whm : native.mail).toEqual({})
      }
      const body = renderV2ReadOnlyPage(descriptor)
      if (!body) throw new Error('Missing approved read-only security body')
      nativeControlsStayBlocked(body)
      const html = renderWebApp(state), nodes = parseMarkup(html)
      const cards = nodes.filter(node => node.template < 0 && node.attrs.get('data-account-security') === 'two-factor')
      expect(cards).toHaveLength(1)
      const current = cards[0]
      if (!current) throw new Error('Missing trusted factor card')
      expect(current.attrs.get('data-auth-state')).toBe('development-disabled')
      expect(current.attrs.get('data-mfa-configured')).toBe('true')
      expect(nodes.some(node => node.template < 0 && (node.attrs.has('data-auth-setup-form') || node.attrs.has('data-auth-enroll-form')))).toBe(false)
      expect(nodes.some(node => node.template < 0 && node.attrs.has('data-v2-account-security-slot'))).toBe(false)
    })
  }

  it.each(factorDocuments)('does not manufacture trusted factor/native state for $surface', { tags: ['feature'] }, entry => {
    const state = factorDocumentState(entry, 'en', false, false)
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', entry.route)
    expect(descriptor.readOnlyFacts).toBeUndefined()
    expect(state.security).toBeUndefined()
    expect(() => renderV2ReadOnlyPage(descriptor)).toThrow('v2_readonly_facts_missing')
  })

  it('does not grant an anonymous factor document a native realm', { tags: ['feature'] }, () => {
    const entry = factorDocuments[0]
    if (!entry) throw new Error('Missing account-security case')
    const { visibility: omitted, ...anonymous } = factorDocumentState(entry, 'en', false)
    expect(omitted).toBeDefined()
    const descriptor = unavailableView(anonymous, 'en', 'light', 'comfortable', entry.route)
    expect(descriptor.admitted).toBe(false)
    expect(descriptor.readOnlyFacts).toBeUndefined()
    expect(parseMarkup(renderWebApp(anonymous)).some(node => node.template < 0 && node.attrs.has('data-account-security'))).toBe(false)
  })

  it('does not use a security URL from another realm as authority', { tags: ['feature'] }, () => {
    const entry = factorDocuments[1]
    if (!entry) throw new Error('Missing administrator-security case')
    const state: WebAppRenderState = { ...factorDocumentState(entry, 'en', false), surface: 'xpanel' }
    expect(unavailableView(state, 'en', 'light', 'comfortable', entry.route).readOnlyFacts).toBeUndefined()
  })

  it('preserves rejection of a supplied foreign account instead of replacing it with empty facts', { tags: ['feature'] }, () => {
    const entry = factorDocuments[0]
    if (!entry) throw new Error('Missing account-security case')
    const foreign = { ...account, id: 'foreign-factor-account' }
    const state: WebAppRenderState = { ...factorDocumentState(entry, 'en', false), panel: { account: foreign } }
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', entry.route)
    const native = descriptor.readOnlyFacts
    expect(native?.surface).toBe('xpanel')
    if (native?.surface !== 'xpanel') throw new Error('Missing supplied realm')
    expect(native.panel.account).toEqual(foreign)
    expect(() => renderWebApp(state)).toThrow('v2_readonly_authority_unavailable:xpanel')
  })

  it('keeps missing hosting-route facts fail-closed despite a known factor', { tags: ['feature'] }, () => {
    const entry = factorDocuments[0]
    if (!entry) throw new Error('Missing account-security case')
    const state: WebAppRenderState = { ...factorDocumentState(entry, 'en', false), activeRoute: '/resources' }
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', '/resources')
    expect(descriptor.readOnlyFacts).toBeUndefined()
    expect(() => renderV2ReadOnlyPage(descriptor)).toThrow('v2_readonly_facts_missing')
  })

  it('keeps reseller self-factor settings independent of administrative list facts', { tags: ['feature'] }, () => {
    const entry: FactorDocumentCase = { surface: 'xwhm', route: '/whm/security/sign-in', principal: { kind: 'reseller', id: 'factor-reseller', username: 'partner' } }
    const state = factorDocumentState(entry, 'en', false)
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', entry.route)
    // The root-only administrative layout stays denied; self-factor controls remain independently usable.
    expect(descriptor.admitted).toBe(false)
    expect(descriptor.readOnlyFacts).toBeUndefined()
    const cards = parseMarkup(renderWebApp(state)).filter(node => node.template < 0 && node.attrs.get('data-account-security') === 'two-factor')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.attrs.get('data-auth-state')).toBe('development-disabled')
  })
})

describe('invalid supplied native facts retain their rejection', () => {
  it.each(factorDocuments)('does not enrich explicit null native facts for $surface factor settings', { tags: ['feature'] }, entry => {
    const state = factorDocumentState(entry, 'en', false)
    const field = entry.surface === 'xpanel' ? 'panel' : entry.surface === 'xwhm' ? 'whm' : 'mail'
    // Deliberately model invalid runtime input without asserting it is a valid typed realm.
    Object.defineProperty(state, field, { value: null })
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', entry.route)
    expect(descriptor.readOnlyFacts).toBeUndefined()
    expect(() => renderWebApp(state)).toThrow('v2_readonly_facts_missing')
  })

  it('does not enrich explicit null native facts on another hosting route', { tags: ['feature'] }, () => {
    const entry = factorDocuments[0]
    if (!entry) throw new Error('Missing account-security case')
    const state: WebAppRenderState = { ...factorDocumentState(entry, 'en', false), activeRoute: '/resources' }
    Object.defineProperty(state, 'panel', { value: null })
    const descriptor = unavailableView(state, 'en', 'light', 'comfortable', '/resources')
    expect(descriptor.readOnlyFacts).toBeUndefined()
    expect(() => renderWebApp(state)).toThrow('v2_readonly_facts_missing')
  })
})

import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account } from '@xpanel/core'
import type { UnavailableProps } from '../../contract.ts'
import { renderV2ReadOnlyPage } from './read-only.ts'
import { V2_SECURITY_SLOT, renderV2AccountSecuritySlot } from './slots.ts'
import { parseMarkup } from '../../markup.ts'

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
      const slotHost = parseMarkup(html).find(node => node.attrs.has('data-v2-account-security-slot'))!
      expect(parseMarkup(html)[slotHost.parent]!.attrs.get('data-v2-settings-route')).toBe('/security/account')
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
import { describe, expect, it } from 'vitest'
import { tools } from '@xpanel/catalog'
import { defaultPlan, type Account, type Principal } from '@xpanel/core'
import { installedThemePackages, unavailableView, type WebAppRenderState } from '../app.ts'
import { translator } from '../i18n.ts'
import { registeredUiThemeIds } from '../themes/registry.ts'
import { parseMarkup } from '../themes/markup.ts'
import { V2_SECURITY_SLOT } from '../themes/v2/surfaces/slots.ts'
import type { UnavailableProps } from '../themes/contract.ts'
import { v2Theme } from '../themes/v2/theme.ts'
import { renderV2ReadOnlyPage } from '../themes/v2/surfaces/read-only.ts'
import { projectReadOnlyMailSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface } from './theme-surface.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))
const account: Account = { id: 'account-a', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const plan = defaultPlan({ id: account.planId, name: 'Business' })
const principal: Principal = { kind: 'user', id: 'user-a', username: account.username, accountId: account.id }
const visibility = { principal, disabledFeatures: new Set<string>() }
const state: WebAppRenderState = { surface: 'xpanel', panel: { account, plan }, visibility, catalog }
const descriptor = (changes: Partial<WebAppRenderState> = {}, route = '/resources'): UnavailableProps => unavailableView({ ...state, ...changes }, 'en', 'light', 'comfortable', route)

describe('trusted read-only theme composition', () => {
  it('attaches facts only for the current admitted realm and preserves the actual catalog', () => {
    const value = descriptor({ whm: { hostname: 'other-surface.test' }, mail: { mailbox: 'other@example.test' } })
    expect(value.readOnlyFacts).toEqual({ surface: 'xpanel', panel: state.panel })
    expect(value.catalog).toBe(catalog)
    expect(descriptor({}, '/whm/accounts').readOnlyFacts).toBeUndefined()
    expect(descriptor({ panel: undefined }).readOnlyFacts).toBeUndefined()
  })

  it('does not create context cycles or copy descriptors into source facts', () => {
    const first = descriptor(), second = descriptor()
    expect(first.unavailableView).toBeUndefined()
    expect(first.readOnlyFacts?.surface === 'xpanel' && first.readOnlyFacts.panel).toBe(state.panel)
    expect(state.panel).not.toHaveProperty('unavailableView')
    expect(() => JSON.stringify(first)).not.toThrow()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('preserves role-authorized stored facts while leaving native qualification unchanged and all mutations closed', () => {
    const view = projectReadOnlyPanelSurface({ account, plan, visibility, catalog, activeRoute: '/email/accounts' })!
    expect(view.props.account).toBe(account)
    expect(view.authority).toMatchObject({ presentation: 'read-only', canReadFacts: true, canRead: false, canManage: false, canUseTerminal: false, canChangeOwner: false, allowUnlimited: false })
    expect(view.authority.qualifiedTools.size).toBe(0)
    expect(view.authority.authorizedTools.size).toBeGreaterThan(0)
    expect(view.catalog).toBe(catalog)
  })

  it('never synthesizes account facts when the rich account record is missing', () => {
    const view = projectReadOnlyPanelSurface({ visibility, catalog, activeRoute: '/resources', plan, files: [], usage: { phpVersion: null, diskBytes: 0, memoryBytes: 0, processCount: 0, bandwidth: 'unmeasured' } })!
    expect(view.props.account).toBeUndefined()
    expect(view.props.plan).toBeUndefined()
    expect(view.props.files).toBeUndefined()
    expect(view.props.usage).toBeUndefined()
    expect(view.authority.canReadFacts).toBe(false)
    const html = renderV2ReadOnlyPage(descriptor({ panel: {} }))!
    const nodes = parseMarkup(html)
    expect(nodes.filter(node => node.tag === 'h1')).toHaveLength(1)
    expect(nodes.some(node => node.attrs.get('data-resource-reading') === 'unread')).toBe(true)
    for (const id of ['v2-resource-limits-title', 'v2-resource-cpu-title', 'v2-resource-memory-title', 'v2-resource-service-title', 'v2-resource-processes-title', 'v2-resource-folders-title']) {
      expect(nodes.some(node => node.attrs.get('id') === id)).toBe(true)
    }
    expect(nodes.some(node => node.attrs.has('data-account') || node.attrs.has('data-uid'))).toBe(false)
    expect(html).not.toContain(account.primaryDomain)
    expect(html).not.toContain(plan.name)
    expect(html).not.toContain('xpanel-' + account.uid + '.slice')
    const refresh = nodes.find(node => node.tag === 'button' && node.attrs.get('aria-describedby') === 'v2-resource-refresh-note')!
    expect(refresh.attrs.has('disabled')).toBe(true)
    expect(nodes.some(node => node.attrs.get('data-readonly') === 'true' && node.attrs.get('data-qualified') === 'false')).toBe(true)
  })

  it('rejects foreign account facts and malformed surface contexts before rendering', () => {
    expect(projectReadOnlyPanelSurface({ account: { ...account, id: 'foreign-account' }, visibility, catalog, activeRoute: '/resources' })).toBeUndefined()
    expect(() => renderV2ReadOnlyPage({ ...descriptor(), readOnlyFacts: { surface: 'xmail', mail: { mailbox: 'foreign@example.test' } } })).toThrow('v2_readonly_facts_realm_mismatch:xpanel')
    expect(() => v2Theme.renderPanel({})).toThrow('v2_core_unavailable_context_missing:xpanel')
    expect(() => v2Theme.renderWhm({ unavailableView: descriptor() })).toThrow('v2_core_unavailable_context_mismatch:xwhm')
  })

  it('renders full stored-fact layouts with native mutations blocked', () => {
    const html = renderV2ReadOnlyPage(descriptor())!
    expect(html).toContain('<h1')
    expect(html).toContain('Stored plan limit')
    expect(html).not.toContain('data-terminal-open')
    const email = renderV2ReadOnlyPage(descriptor({}, '/email/accounts'))!
    const nodes = parseMarkup(email)
    expect(nodes.filter(node => node.tag === 'h1')).toHaveLength(1)
    expect(nodes.some(node => node.tag === 'table')).toBe(true)
    const create = nodes.find(node => node.tag === 'form' && node.attrs.get('data-mailbox-form') === 'true')!
    expect(create).toBeDefined()
    let parent = create.parent
    const ancestors = []
    while (parent >= 0) { ancestors.push(nodes[parent]!); parent = nodes[parent]!.parent }
    expect(ancestors.some(node => node.tag === 'fieldset' && node.attrs.has('disabled'))).toBe(true)
    expect(ancestors.some(node => node.attrs.get('data-readonly') === 'true')).toBe(true)
    expect(nodes.some(node => node.attrs.has('data-mailbox-password') || node.attrs.has('data-remove-mailbox'))).toBe(false)
  })

  it('keeps unknown mailbox and operator provider observations unread with no mutation authority', () => {
    const mail = projectReadOnlyMailSurface({ visibility, catalog, activeRoute: '/mail/inbox', quotaUsedMb: 0, quotaLimitMb: 100, messages: [] })!
    expect(mail.props.mailbox).toBeUndefined()
    expect(mail.props.messages).toBeUndefined()
    expect(mail.props.quotaUsedMb).toBeUndefined()
    expect(mail.authority).toMatchObject({ canReadFacts: false, canRead: false, canManage: false })
    const root: Principal = { kind: 'root', id: 'root-a', username: 'operator' }
    const whm = projectReadOnlyWhmSurface({ principal: root, visibility: { principal: root }, catalog, activeRoute: '/whm/monitoring/logs', capabilityUnavailable: true })!
    expect(whm.props.capabilityUnavailable).toBe(true)
    expect(whm.props.services).toBeUndefined()
    expect(whm.authority).toMatchObject({ presentation: 'read-only', canRead: false, canManage: false, canUseTerminal: false, canChangeOwner: false })
  })

  it('keeps the single account-security slot outside native-controller read-only boundaries', () => {
    const html = renderV2ReadOnlyPage(descriptor({}, '/security/account'))!
    expect(html.split(V2_SECURITY_SLOT)).toHaveLength(2)
    const nodes = parseMarkup(html)
    const slots = nodes.filter(node => node.attrs.has('data-v2-account-security-slot'))
    expect(slots).toHaveLength(1)
    let parent = slots[0]!.parent
    while (parent >= 0) {
      expect(nodes[parent]!.attrs.get('data-readonly')).not.toBe('true')
      expect(nodes[parent]!.attrs.get('data-qualified')).not.toBe('false')
      parent = nodes[parent]!.parent
    }
    expect(nodes.some(node => node.attrs.get('data-readonly') === 'true')).toBe(true)
  })
  it('derives installed metadata from the real registry shared with personal preferences', () => {
    const installed = installedThemePackages('ar')
    expect(installed.map(item => item.id)).toEqual(registeredUiThemeIds())
    expect(installed).toEqual([{ id: 'classic', label: translator('ar')('Classic'), surfaces: ['xpanel', 'xwhm', 'xmail'], available: true }])
    expect(v2Theme.id).toBe('v2')
    expect(registeredUiThemeIds()).not.toContain('v2')
    expect(v2Theme.slots).toHaveProperty('accountSecurity')
  })
})

import { describe, expect, it } from 'vitest'
import { tools, type VisibilityContext } from '@xpanel/catalog'
import { defaultPlan, type Account, type DatabaseUser, type Domain, type Principal, type Reseller, type WebsiteAnalyticsSnapshot } from '@xpanel/core'
import type { PanelSurfaceProps, WhmSurfaceProps } from '../themes/contract.ts'
import { MONITORING_LOG_DEFAULT_LINES, MONITORING_LOG_MAX_LINES, MONITORING_LOG_UNITS } from '../../../../packages/os/src/monitoring-command.ts'
import { projectPanelSurface, projectWhmSurface, projectReadOnlyPanelSurface, projectReadOnlyWhmSurface, projectReadOnlyMailSurface } from './theme-surface.ts'

const catalog = tools.map(tool => ({ ...tool, status: 'verified' as const, delivery: { ...tool.delivery, status: 'verified' as const } }))
const account: Account = { id: 'account-a', username: 'alice', uid: 20001, gid: 20001, home: '/home/alice', primaryDomain: 'alice.test', planId: 'plan-a', ownerId: null, status: 'active', suspendReason: null, contactEmail: 'alice@example.test', ipv4: '192.0.2.10', shell: 'jailed', createdAt: '2026-10-29T00:00:00Z' }
const plan = { ...defaultPlan({ id: account.planId, name: 'Business' }), shell: 'jailed' as const }
const user: VisibilityContext = { principal: { kind: 'user', id: 'user-a', username: account.username, accountId: account.id }, disabledFeatures: new Set() }
const domain: Domain = { id: 'domain-a', accountId: account.id, name: account.primaryDomain, kind: 'primary', parentId: null, docRoot: account.home + '/public_html', siteType: 'php', upstream: null, redirect: null, php: { version: '8.3', handler: 'fpm', ini: {}, fpm: { mode: 'ondemand', maxChildren: 4, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 } }, wildcard: false, certificateId: null, suspended: false, expiresAt: null, pathQuotaMb: 'unlimited' }
const panel = (changes: Partial<PanelSurfaceProps> = {}): PanelSurfaceProps => ({ activeRoute: '/home', account, plan, domains: [domain], visibility: user, catalog, ...changes })
const root: Principal = { kind: 'root', id: 'root-a', username: 'operator' }
const whm = (changes: Partial<WhmSurfaceProps> = {}): WhmSurfaceProps => ({ activeRoute: '/whm', principal: root, visibility: { principal: root }, catalog, ...changes })
const analytics = (): WebsiteAnalyticsSnapshot => ({ domain: domain.name, accountId: account.id, at: '2026-10-29T12:00:00Z', totals: { requests: 0, bytes: 0, uniqueVisitors: 0, cacheHitRatioPercent: 0, errorRatePercent: 0, avgRequestTimeMs: 0, p95RequestTimeMs: 0, avgUpstreamTimeMs: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0 }, series: [], topPaths: [], topReferrers: [], topClientIps: [] })

describe('theme-neutral account surface projection', () => {
  it('requires the current account and the matching user principal before exposing any facts', () => {
    for (const input of [panel({ account: undefined }), panel({ visibility: undefined }), panel({ visibility: { ...user, principal: { ...user.principal, accountId: 'foreign-account' } as typeof user.principal } }), panel({ visibility: { principal: root } })]) {
      expect(projectPanelSurface(input)).toBeUndefined()
    }
  })

  it('uses an explicitly supplied catalog and never substitutes default tools or promotes authorization', () => {
    const home = projectPanelSurface(panel({ catalog: [] }))
    expect(home?.catalog).toEqual([])
    expect(home?.authority.qualifiedTools.size).toBe(0)
    expect(home?.authority.authorizedTools.size).toBe(0)
    expect(projectPanelSurface(panel({ activeRoute: '/email/accounts', catalog: [] }))).toBeUndefined()
    const unqualified = catalog.map(tool => ({ ...tool, status: 'implemented' as const, delivery: { ...tool.delivery, status: 'implemented' as const } }))
    const view = projectPanelSurface(panel({ catalog: unqualified }))
    expect(view?.authority.authorizedTools.size).toBeGreaterThan(0)
    expect(view?.authority.qualifiedTools.size).toBe(0)
    expect(projectPanelSurface(panel({ activeRoute: '/files/manager', catalog: unqualified }))).toBeUndefined()
  })

  it('drops foreign account collections, mismatched plans and database grants outside the account', () => {
    const ownUser: DatabaseUser = { id: 'db-user-a', accountId: account.id, name: 'alice_app', grants: [{ databaseId: 'db-a', privileges: ['SELECT'] }] }
    const foreignUser: DatabaseUser = { ...ownUser, id: 'db-user-b', accountId: 'account-b', name: 'alice_foreign' }
    const view = projectPanelSurface(panel({ plan: defaultPlan({ id: 'foreign-plan', name: 'Foreign plan' }), domains: [domain, { ...domain, id: 'domain-b', accountId: 'account-b', name: 'foreign.test' }],
      databases: [{ id: 'db-a', accountId: account.id, name: 'alice_app', engine: 'mariadb', trashedAt: null }, { id: 'db-b', accountId: 'account-b', name: 'foreign_db', engine: 'mariadb', trashedAt: null }],
      databaseUsers: [ownUser, foreignUser, { id: 'db-user-c', name: 'alice_stale', grants: [{ databaseId: 'db-b', privileges: ['ALL'] }] }],
      serviceUsers: [{ id: 'service-b', accountId: 'account-b', login: 'secret@foreign.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: '' }],
      certificates: [{ id: 'certificate-b', accountId: 'account-b', names: ['foreign.test'], source: 'upload', challenge: null, notAfter: '2027-01-01T00:00:00Z', autoRenew: false }],
      dnsRecords: [{ id: 'dns-a', zone: domain.name, name: '@', type: 'A', ttl: 3600, content: '192.0.2.1', priority: null }, { id: 'dns-b', zone: 'foreign.test', name: '@', type: 'A', ttl: 3600, content: '192.0.2.2', priority: null }],
    }))!
    expect(view.props.plan).toBeUndefined()
    expect(view.props.domains?.map(row => row.id)).toEqual([domain.id])
    expect(view.props.databases?.map(row => row.id)).toEqual(['db-a'])
    expect(view.props.databaseUsers?.map(row => row.id)).toEqual([ownUser.id])
    expect(view.props.serviceUsers).toEqual([])
    expect(view.props.certificates).toEqual([])
    expect(view.props.dnsRecords?.map(row => row.id)).toEqual(['dns-a'])
  })

  it('preserves unread collections separately from observed empty ones', () => {
    const unread = projectPanelSurface(panel({ domains: undefined }))!
    expect(unread.props.domains).toBeUndefined()
    expect(unread.props.databases).toBeUndefined()
    expect(unread.props.serviceUsers).toBeUndefined()
    const empty = projectPanelSurface(panel({ domains: [], databases: [], serviceUsers: [] }))!
    expect(empty.props.domains).toEqual([])
    expect(empty.props.databases).toEqual([])
    expect(empty.props.serviceUsers).toEqual([])
  })

  it('binds custom configuration and analytics to the selected owned domain', () => {
    expect(projectPanelSurface(panel({ activeDomain: 'foreign.test' }))).toBeUndefined()
    const view = projectPanelSurface(panel({ activeDomain: domain.name, customConfig: { accountId: 'account-b', domainId: 'domain-b', domainName: 'foreign.test', nginxInclude: 'foreign config', apacheInclude: '', userIni: {}, customHeaders: {}, cacheBypassPaths: [], updatedAt: '2026-10-29T00:00:00Z', updatedBy: 'root' }, websiteAnalytics: { ...analytics(), accountId: 'account-b' } }))!
    expect(view.props.activeDomain).toBe(domain.name)
    expect(view.props.customConfig).toBeUndefined()
    expect(view.props.websiteAnalytics).toBeUndefined()
    expect(view.props.websiteAnalyticsUnavailable).toBe(true)
  })

  it('keeps terminal qualification, active account state and both jailed-shell policies independent', () => {
    expect(projectPanelSurface(panel({ activeRoute: '/advanced/terminal' }))?.authority.canUseTerminal).toBe(true)
    expect(projectPanelSurface(panel({ activeRoute: '/advanced/terminal', plan: { ...plan, shell: 'none' } }))?.authority.canUseTerminal).toBe(false)
    expect(projectPanelSurface(panel({ activeRoute: '/advanced/terminal', account: { ...account, status: 'suspended' } }))?.authority.canManage).toBe(false)
    expect(projectPanelSurface(panel({ activeRoute: '/advanced/terminal', visibility: { ...user, allowedToolIds: new Set() } }))).toBeUndefined()
  })

  it('does not infer domain-selection authority from a valid sample or a requested label', () => {
    expect(projectPanelSurface(panel({ websiteAnalytics: analytics() }))?.authority.domainSelectionAvailable).toBe(false)
    expect(projectPanelSurface(panel({ websiteAnalyticsDomainSelectionAvailable: true, websiteAnalytics: analytics() }))?.authority.domainSelectionAvailable).toBe(true)
  })
})

describe('theme-neutral operator surface projection', () => {
  it('denies missing, conflicting or account principals and unavailable capabilities', () => {
    expect(projectWhmSurface(whm({ principal: undefined, visibility: undefined }))).toBeUndefined()
    expect(projectWhmSurface(whm({ principal: { ...root, id: 'other-root' } }))).toBeUndefined()
    expect(projectWhmSurface(whm({ principal: user.principal, visibility: user }))).toBeUndefined()
    expect(projectWhmSurface(whm({ capabilityUnavailable: true }))).toBeUndefined()
    expect(projectWhmSurface(whm({ activeRoute: '/whm/unknown' }))).toBeUndefined()
  })

  it('fences reseller accounts, associated plans, editor state and host-only observations', () => {
    const principal: Principal = { kind: 'reseller', id: 'reseller-a', username: 'dealer' }
    const reseller: Reseller = { id: principal.id, username: principal.username, acl: ['list-accounts', 'manage-plans'], maxAccounts: 10, totalDiskMb: 10000, totalBandwidthMb: 10000, oversell: false, nameservers: [], delegatedIps: [] }
    const owned = { ...account, ownerId: principal.id }, foreignPlan = defaultPlan({ id: 'foreign-plan', name: 'Foreign', ownerId: 'reseller-b' })
    const view = projectWhmSurface(whm({ activeRoute: '/whm/plans', principal, visibility: { principal, reseller }, activeReseller: reseller,
      accounts: [owned, { ...account, id: 'foreign-account', username: 'bob', ownerId: 'reseller-b' }], plans: [plan, foreignPlan],
      planEditorState: { kind: 'edit', plan: foreignPlan }, domains: [domain, { ...domain, id: 'foreign-domain', accountId: 'foreign-account', name: 'foreign.test' }],
      featureLists: [{ id: 'shared', name: 'Shared', ownerId: null }, { id: 'own', name: 'Own', ownerId: principal.id }, { id: 'foreign', name: 'Foreign', ownerId: 'reseller-b' }],
      services: [], firewallRules: [], ipPool: [], adminSessionIp: '198.51.100.10', certificates: [], auditEntries: [],
    }))!
    expect(view.props.accounts).toEqual([owned])
    expect(view.props.plans).toEqual([plan])
    expect(view.props.planEditorState).toEqual({ kind: 'unavailable' })
    expect(view.props.domains).toEqual([domain])
    expect(view.props.featureLists?.map(row => row.id)).toEqual(['shared', 'own'])
    for (const field of ['services', 'firewallRules', 'ipPool', 'adminSessionIp', 'certificates', 'auditEntries'] as const) expect(view.props[field]).toBeUndefined()
    expect(view.authority.allowUnlimited).toBe(false)
    expect(view.authority.canChangeOwner).toBe(false)
  })

  it('keeps personal operator preferences available without pretending native tools are qualified', () => {
    const view = projectWhmSurface(whm({ activeRoute: '/whm/preferences', catalog: [] }))!
    expect(view.route).toBe('/whm/preferences')
    expect(view.authority.qualifiedTools.size).toBe(0)
    expect(projectWhmSurface(whm({ activeRoute: '/whm/accounts', catalog: [] }))).toBeUndefined()
  })

  it('uses the actual reviewed log bounds without inventing a provider observation', () => {
    const view = projectWhmSurface(whm({ activeRoute: '/whm/monitoring/logs' }))!
    expect(view.monitoringLogUnits).toBe(MONITORING_LOG_UNITS)
    expect(view.monitoringLogDefaultLines).toBe(MONITORING_LOG_DEFAULT_LINES)
    expect(view.monitoringLogMaxLines).toBe(MONITORING_LOG_MAX_LINES)
    expect(view.props.services).toBeUndefined()
    expect(view.props.hostSample).toBeUndefined()
  })
})


describe('read-only surface provider boundaries', () => {
  const blocked = (authority: NonNullable<ReturnType<typeof projectReadOnlyPanelSurface>>['authority']) => {
    expect(authority.presentation).toBe('read-only')
    expect(authority.canRead).toBe(false)
    expect(authority.canReadAccounts).toBe(false)
    expect(authority.canManage).toBe(false)
    expect(authority.canUseTerminal).toBe(false)
    expect(authority.canChangeOwner).toBe(false)
    expect(authority.allowUnlimited).toBe(false)
  }
  it('never upgrades stored Panel facts to native authority even with a fully qualified catalog', () => {
    const view = projectReadOnlyPanelSurface(panel())
    expect(view).toBeDefined()
    expect(view!.props.account).toBe(account)
    expect(view!.authority.canReadFacts).toBe(true)
    blocked(view!.authority)
    expect(projectPanelSurface(panel())!.authority.canRead).toBe(true)
  })
  it('never upgrades operator facts to native account reads or management', () => {
    const view = projectReadOnlyWhmSurface(whm({ accounts: [account], capabilityUnavailable: true }))
    expect(view).toBeDefined()
    expect(view!.props.accounts).toEqual([account])
    expect(view!.authority.canReadFacts).toBe(true)
    blocked(view!.authority)
    expect(projectWhmSurface(whm())!.authority.canRead).toBe(true)
  })
  it('never upgrades a sealed mailbox fact projection to provider reads', () => {
    const view = projectReadOnlyMailSurface({ activeRoute: '/mail/inbox', mailbox: 'alice@example.test', visibility: user, catalog })
    expect(view).toBeDefined()
    expect(view!.props.mailbox).toBe('alice@example.test')
    expect(view!.authority.canReadFacts).toBe(true)
    blocked(view!.authority)
  })
  it('clears absent identities and rejects foreign account facts without fabricating empty observations', () => {
    const panelView = projectReadOnlyPanelSurface(panel({ account: undefined, databases: [{ id: 'stale-db', accountId: account.id, name: 'alice_stale', engine: 'mariadb', trashedAt: null }] }))!
    expect(panelView.props.account).toBeUndefined()
    expect(panelView.props.databases).toBeUndefined()
    expect(panelView.authority.canReadFacts).toBe(false)
    blocked(panelView.authority)
    expect(projectReadOnlyPanelSurface(panel({ account: { ...account, id: 'foreign-account' } }))).toBeUndefined()
    const mailboxView = projectReadOnlyMailSurface({ activeRoute: '/mail/inbox', visibility: user, catalog, messages: [], quotaUsedMb: 0 })!
    expect(mailboxView.props.mailbox).toBeUndefined()
    expect(mailboxView.props.messages).toBeUndefined()
    expect(mailboxView.props.quotaUsedMb).toBeUndefined()
    expect(mailboxView.authority.canReadFacts).toBe(false)
    blocked(mailboxView.authority)
  })
})

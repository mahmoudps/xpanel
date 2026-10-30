import { canOpenRegisteredRoute, canonicalNavigationRoute, isToolAuthorized, navigation, registeredDocumentAliases, tools as defaultCatalog, visibleNavigation, visibleTools, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import type { Account, Principal } from '@xpanel/core'
import type { MailSurfaceProps, PanelSurfaceProps, ThemeViewProps, WhmSurfaceProps } from '../themes/contract.ts'
import { parseWebsiteAnalyticsSnapshot } from './website-analytics.ts'
import { MONITORING_LOG_DEFAULT_LINES, MONITORING_LOG_MAX_LINES, MONITORING_LOG_UNITS } from '../../../../packages/os/src/monitoring-command.ts'

export interface SurfaceAuthority {
  readonly presentation: 'live' | 'read-only'
  /** Permission to display supplied stored facts; never permission to perform a provider read. */
  readonly canReadFacts: boolean
  readonly canRead: boolean
  readonly canManage: boolean
  readonly canUseTerminal: boolean
  readonly canReadAccounts: boolean
  readonly canChangeOwner: boolean
  readonly allowUnlimited: boolean
  readonly ownerId: string | null
  readonly relatedRoutes: ReadonlySet<string>
  readonly qualifiedTools: ReadonlySet<string>
  readonly authorizedTools: ReadonlySet<string>
  readonly logKinds: readonly ('access' | 'error')[]
  /** Account traffic props already describe the selected owned domain, rather than a requested UI label. */
  readonly domainSelectionAvailable: boolean
}

interface SurfaceProjection {
  readonly route: string
  readonly visibility: VisibilityContext
  readonly catalog: readonly CatalogTool[]
  readonly authority: SurfaceAuthority
}

export interface PanelSurfaceView extends SurfaceProjection {
  readonly surface: 'xpanel'
  readonly props: PanelSurfaceProps & ThemeViewProps & { readonly account: Account }
}

export interface ReadOnlyPanelSurfaceView extends SurfaceProjection {
  readonly surface: 'xpanel'
  readonly props: PanelSurfaceProps & ThemeViewProps
}

export interface ReadOnlyMailSurfaceView extends SurfaceProjection {
  readonly surface: 'xmail'
  readonly props: MailSurfaceProps & ThemeViewProps
}

export interface WhmSurfaceView extends SurfaceProjection {
  readonly surface: 'xwhm'
  readonly props: WhmSurfaceProps & ThemeViewProps & { readonly principal: Principal }
  readonly monitoringLogUnits: readonly string[]
  readonly monitoringLogDefaultLines: number
  readonly monitoringLogMaxLines: number
}

function surfaceAccess(surface: 'xpanel' | 'xwhm' | 'xmail', route: string, visibility: VisibilityContext, catalog: readonly CatalogTool[]) {
  const pages = visibleNavigation(visibility, catalog).find(item => item.surface === surface)?.sections.flatMap(section => section.pages) ?? []
  const routes = new Set(pages.map(page => page.route))
  // Persisted operator preferences are admitted by core independently of native host tools.
  if (surface === 'xwhm' && canOpenRegisteredRoute('/whm/preferences', visibility)) routes.add('/whm/preferences')
  for (const alias of registeredDocumentAliases) if (routes.has(alias.parentRoute)) routes.add(alias.route)
  const qualifiedTools = new Set(visibleTools(catalog, visibility).map(tool => tool.id))
  const authorizedTools = new Set(catalog.filter(tool => isToolAuthorized(tool, visibility)).map(tool => tool.id))
  const allowed = canOpenRegisteredRoute(route, visibility) && routes.has(canonicalNavigationRoute(route))
  return { routes, qualifiedTools, authorizedTools, allowed }
}

function authority(
  access: ReturnType<typeof surfaceAccess>,
  context: { readonly canManage: boolean; readonly root: boolean; readonly ownerId: string | null; readonly allowUnlimited: boolean; readonly canUseTerminal?: boolean; readonly domainSelectionAvailable?: boolean },
): SurfaceAuthority {
  return {
    presentation: 'live', canReadFacts: true,
    canRead: access.allowed, canManage: access.allowed && context.canManage,
    canUseTerminal: access.allowed && context.canManage && context.canUseTerminal === true,
    canReadAccounts: access.qualifiedTools.has('list-accounts'),
    canChangeOwner: context.root && access.qualifiedTools.has('change-ownership-multiple-accounts'),
    allowUnlimited: context.allowUnlimited, ownerId: context.ownerId,
    relatedRoutes: access.routes, qualifiedTools: access.qualifiedTools, authorizedTools: access.authorizedTools,
    logKinds: [
      ...(access.qualifiedTools.has('raw-access') ? ['access' as const] : []),
      ...(access.qualifiedTools.has('errors') ? ['error' as const] : []),
    ],
    domainSelectionAvailable: context.domainSelectionAvailable === true,
  }
}

/** Core has already admitted the listener/session. This projection fences supplied collections to that account. */
function scopePanelFacts(props: PanelSurfaceProps & ThemeViewProps, account: Account, visibility: VisibilityContext, catalog: readonly CatalogTool[], route: string): PanelSurfaceView['props'] | undefined {
  const domains = props.domains?.filter(domain => domain.accountId === account.id)
  if (props.activeDomain !== undefined && (domains === undefined ? props.activeDomain !== account.primaryDomain : !domains.some(domain => domain.name === props.activeDomain))) return undefined
  const selected = domains?.find(domain => domain.name === props.activeDomain)
    ?? domains?.find(domain => domain.name === account.primaryDomain) ?? domains?.[0]
  const domainIds = new Set(domains?.map(domain => domain.id)), names = new Set(domains?.map(domain => domain.name))
  const plan = props.plan?.id === account.planId ? props.plan : undefined
  const databases = props.databases?.filter(database => database.accountId === account.id)
  const databaseIds = new Set(databases?.map(database => database.id))
  const users = databases === undefined ? undefined : props.databaseUsers?.filter(user => {
    const declaredAccountId = 'accountId' in user ? user.accountId : undefined
    return (declaredAccountId === undefined ? user.name.startsWith(account.username + '_') : declaredAccountId === account.id)
      && user.grants.every(grant => databaseIds.has(grant.databaseId))
  })
  const custom = props.customConfig
  const customConfig = custom?.accountId === account.id && domainIds.has(custom.domainId)
    && custom.domainName === selected?.name ? custom : undefined
  const websiteAnalytics = props.websiteAnalytics === undefined || selected === undefined ? undefined
    : parseWebsiteAnalyticsSnapshot(props.websiteAnalytics, { accountId: account.id, domain: selected.name }) ?? undefined
  const scoped: PanelSurfaceProps & ThemeViewProps & { account: Account } = {
    ...props, account, visibility, catalog, activeRoute: route,
    plan, domains, databases, databaseUsers: users,
    serviceUsers: props.serviceUsers?.filter(user => user.accountId === account.id),
    certificates: props.certificates?.filter(certificate => certificate.accountId === account.id),
    dnsRecords: domains === undefined ? undefined : props.dnsRecords?.filter(record => names.has(record.zone)),
    activeDomain: selected?.name ?? account.primaryDomain, customConfig, websiteAnalytics,
    ...(props.websiteAnalytics !== undefined && websiteAnalytics === undefined ? { websiteAnalyticsUnavailable: true } : {}),
  }
  return scoped
}

export function projectPanelSurface(props: PanelSurfaceProps & ThemeViewProps): PanelSurfaceView | undefined {
  const account = props.account, visibility = props.visibility
  if (!account || visibility?.principal.kind !== 'user' || visibility.principal.accountId !== account.id) return undefined
  const route = props.activeRoute === '/panel' ? '/home' : props.activeRoute ?? '/home'
  const catalog = props.catalog ?? defaultCatalog, access = surfaceAccess('xpanel', route, visibility, catalog)
  if (!access.allowed) return undefined
  const scoped = scopePanelFacts(props, account, visibility, catalog, route)
  if (!scoped) return undefined
  return { surface: 'xpanel', route, props: scoped, visibility, catalog, authority: authority(access, {
    canManage: account.status === 'active', root: false, ownerId: account.ownerId, allowUnlimited: false,
    canUseTerminal: account.shell === 'jailed' && scoped.plan?.shell === 'jailed' && access.qualifiedTools.has('terminal'),
    domainSelectionAvailable: 'websiteAnalyticsDomainSelectionAvailable' in props && props.websiteAnalyticsDomainSelectionAvailable === true,
  }) }
}

const matchingPrincipal = (left: Principal, right: Principal): boolean => left.kind === right.kind && left.id === right.id
  && (left.kind !== 'user' || right.kind === 'user' && left.accountId === right.accountId)

/** Root sees supplied host facts; resellers see their owned collections and assigned plan references only. */
function projectWhmSurfaceMode(props: WhmSurfaceProps & ThemeViewProps, presentation: 'live' | 'read-only'): WhmSurfaceView | undefined {
  const principal = props.visibility?.principal ?? props.principal
  if (!principal || principal.kind === 'user' || presentation === 'live' && props.capabilityUnavailable === true) return undefined
  if (props.visibility && props.principal && !matchingPrincipal(props.visibility.principal, props.principal)) return undefined
  const activeReseller = principal.kind === 'reseller' && props.activeReseller?.id === principal.id ? props.activeReseller : undefined
  const visibility = props.visibility ?? { principal, ...(activeReseller ? { reseller: activeReseller } : {}) }
  const route = props.activeRoute ?? '/whm', catalog = props.catalog ?? defaultCatalog
  const access = surfaceAccess('xwhm', route, visibility, catalog)
  const registeredWhmRoute = navigation.some(surface => surface.surface === 'xwhm' && surface.sections.some(section => section.pages.some(page => page.route === canonicalNavigationRoute(route))))
  if (presentation === 'live' ? !access.allowed : !registeredWhmRoute) return undefined
  const root = principal.kind === 'root'
  const accounts = (presentation === 'live' ? access.qualifiedTools : access.authorizedTools).has('list-accounts') ? props.accounts?.filter(account => root || account.ownerId === principal.id) : undefined
  const accountIds = new Set(accounts?.map(account => account.id)), assignedPlanIds = new Set(accounts?.map(account => account.planId))
  const plans = props.plans?.filter(plan => root || plan.ownerId === principal.id || assignedPlanIds.has(plan.id))
  const selectedPlanId = props.planEditorState?.kind === 'edit' ? props.planEditorState.plan.id : undefined
  const selectedPlan = selectedPlanId === undefined ? undefined : plans?.find(plan => plan.id === selectedPlanId)
  const planEditorState = props.planEditorState?.kind === 'edit'
    ? selectedPlan ? { kind: 'edit' as const, plan: selectedPlan } : { kind: 'unavailable' as const } : props.planEditorState
  const names = new Set(accounts?.map(account => account.username))
  const scoped: WhmSurfaceProps & ThemeViewProps & { principal: Principal } = {
    ...props, principal, visibility, catalog, activeRoute: route, activeReseller, accounts, plans, planEditorState,
    domains: root ? props.domains : accounts === undefined ? undefined : props.domains?.filter(domain => accountIds.has(domain.accountId)),
    resellers: props.resellers?.filter(reseller => root || reseller.id === principal.id),
    featureLists: props.featureLists?.filter(list => root || list.ownerId === null || list.ownerId === principal.id),
    ipPool: root ? props.ipPool : undefined, firewallRules: root ? props.firewallRules : undefined,
    mailIpConfig: root ? props.mailIpConfig : undefined, serverSettings: root ? props.serverSettings : undefined,
    hostSample: root ? props.hostSample : undefined, services: root ? props.services : undefined,
    certificates: root ? props.certificates : undefined, adminSessionIp: root ? props.adminSessionIp : undefined,
    generations: root ? props.generations : undefined, auditEntries: root ? props.auditEntries : undefined,
    auditList: root ? props.auditList : undefined, nearLimits: root ? props.nearLimits : accounts === undefined ? undefined : props.nearLimits?.filter(item => names.has(item.name)),
    driftCount: root ? props.driftCount : undefined, driftCheckedAt: root ? props.driftCheckedAt : undefined,
    rollbackGenerationId: root ? props.rollbackGenerationId : undefined,
  }
  const acls = visibility.reseller?.acl ?? []
  const liveAuthority = authority(access, {
    canManage: root || principal.kind === 'reseller', root, ownerId: root ? null : principal.id,
    allowUnlimited: root || acls.includes('allow-unlimited-plans'),
    canUseTerminal: root && (access.qualifiedTools.has('root-web-terminal') || access.qualifiedTools.has('aapanel-web-terminal')),
  })
  return { surface: 'xwhm', route, props: scoped, visibility, catalog,
    monitoringLogUnits: MONITORING_LOG_UNITS, monitoringLogDefaultLines: MONITORING_LOG_DEFAULT_LINES, monitoringLogMaxLines: MONITORING_LOG_MAX_LINES,
    authority: presentation === 'live' ? liveAuthority : readOnlyAuthority(liveAuthority, true) }
}

function readOnlyAuthority(value: SurfaceAuthority, canReadFacts: boolean): SurfaceAuthority {
  return { ...value, presentation: 'read-only', canReadFacts, canRead: false, canReadAccounts: false, canManage: false, canUseTerminal: false, canChangeOwner: false, allowUnlimited: false }
}

export const projectWhmSurface = (props: WhmSurfaceProps & ThemeViewProps): WhmSurfaceView | undefined => projectWhmSurfaceMode(props, 'live')
export const projectReadOnlyWhmSurface = (props: WhmSurfaceProps & ThemeViewProps): WhmSurfaceView | undefined => projectWhmSurfaceMode(props, 'read-only')

/** Missing rich facts remain absent. A role name and account key never become a synthetic Account. */
export function projectReadOnlyPanelSurface(props: PanelSurfaceProps & ThemeViewProps): ReadOnlyPanelSurfaceView | undefined {
  const visibility = props.visibility
  if (visibility?.principal.kind !== 'user' || !visibility.principal.accountId.trim()) return undefined
  const account = props.account
  if (account && account.id !== visibility.principal.accountId) return undefined
  const route = props.activeRoute === '/panel' ? '/home' : props.activeRoute ?? '/home', catalog = props.catalog ?? defaultCatalog
  if (!canOpenRegisteredRoute(route, visibility)) return undefined
  const access = surfaceAccess('xpanel', route, visibility, catalog)
  const scoped = account ? scopePanelFacts(props, account, visibility, catalog, route) : {
    ...props, visibility, catalog, activeRoute: route, account: undefined, plan: undefined, domains: undefined,
    databases: undefined, databaseUsers: undefined, serviceUsers: undefined, certificates: undefined, dnsRecords: undefined,
    activeDomain: undefined, customConfig: undefined, websiteAnalytics: undefined, usage: undefined, files: undefined, recentAudit: undefined,
  }
  if (!scoped) return undefined
  return { surface: 'xpanel', route, props: scoped, visibility, catalog, authority: readOnlyAuthority(authority(access, { canManage: false, root: false, ownerId: account?.ownerId ?? null, allowUnlimited: false }), !!account) }
}

export function projectReadOnlyMailSurface(props: MailSurfaceProps & ThemeViewProps): ReadOnlyMailSurfaceView | undefined {
  const visibility = props.visibility, route = props.activeRoute === '/mail' ? '/mail/inbox' : props.activeRoute ?? '/mail/inbox'
  if (visibility?.principal.kind !== 'user' || !canOpenRegisteredRoute(route, visibility)) return undefined
  const catalog = props.catalog ?? defaultCatalog, access = surfaceAccess('xmail', route, visibility, catalog)
  const live = authority(access, { canManage: false, root: false, ownerId: null, allowUnlimited: false })
  const canRead = live.canRead && (route !== '/mail/search' || access.qualifiedTools.has('webmail-search'))
  const scoped = props.mailbox ? props : { ...props, messages: undefined, folderCounts: undefined, quotaUsedMb: undefined, quotaUsedBytes: undefined, quotaLimitMb: undefined,
    composeDraft: undefined, sieveRules: undefined, vacationEnabled: undefined, identityDkim: undefined, identitySpf: undefined, identitySize: undefined }
  return { surface: 'xmail', route, props: { ...scoped, visibility, catalog, activeRoute: route }, visibility, catalog,
    authority: readOnlyAuthority({ ...live, canRead }, !!props.mailbox) }
}


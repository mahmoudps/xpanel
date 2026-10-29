import { execFile, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { agentCallerHeaders, loadAgentCredentialFile } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { bindMfaRuntimePolicy, canSeeAccount, captureMfaRuntimePolicy, fail, hasAcl, isXpanelError, type AuditEntry, type Domain, type MfaRuntimePolicy, type OsProfile, type WebsiteAnalyticsSnapshot } from '@xpanel/core'
import { canOpenRegisteredRoute, canonicalNavigationRoute, visibleNavigation, type CatalogTool, type VisibilityContext } from '@xpanel/catalog'
import { mapAgentHostInfo, mapAgentServices } from '../../web/src/board-port/xwhm-dashboard.ts'
import { parseWebsiteAnalyticsSnapshot, type WebsiteAnalyticsWindow } from '../../web/src/charts.ts'
import { publicContactEmail } from '../../web/src/display-name.ts'
import { isOfferedLocale, requestLocale } from '../../web/src/i18n.ts'
import type { WebAppRenderState } from '../../web/src/app.ts'
import { createDb, getMailboxSession, initializeOperationalMetadata, latestActive, listAudit, listSessionsForPrincipal, migrate, previousGeneration, type AuditQuery, type Db } from '@xpanel/db'
import { detectOs } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { runCli } from './cli.ts'
import { loadQualifiedCatalog } from './host-catalog.ts'
import { parseAuditFilters } from './audit-filters.ts'
import { loadMailDocument, messageSizeLimitBytes, messageSizeLimitFromPostconf, type MailDocument } from './mail/document.ts'
import { auditActorQuery, auditTargetQuery, createLocalMailboxTransport, mailFolderName, mailboxAddressIndex, rewriteMailboxIds } from './mail/inbox.ts'
import { createApiApp, ensureRootPrincipal, listenApiServer } from './server.ts'
import { authenticateRequest } from './auth.ts'
import { teamToolIds } from './team-access.ts'
import { teamFileReader, teamMemberResolver } from './team-session.ts'
import { createHandoffSessionCheck } from './panel-handoff-authority.ts'
import { readAdminPreferenceValues } from './admin-preferences.ts'
import { brandingForDocuments, panelBrandingFile, servePanelBrandingAsset } from './panel-branding.ts'
import { panelSettingsFile } from './panel-settings.ts'
import { installSavedLanguages } from './panel-languages.ts'
import { requireMailboxPrincipalAccess } from './authorization.ts'
import { createAgentClient } from './agent-client.ts'
import { startAlertScheduler } from './alert-runtime.ts'
import { classifyCliInvocation, xpanelServiceUid } from './cli-privilege.ts'
import { ENTRY_POINTS, entryPointAdmitsPrincipal, isMailboxPrincipalUsername, type EntryPoint } from './entry-points.ts'
import { assertStateWritable } from './state-access.ts'
import { LiveEventHub, WS_AUTHORIZATION_UNAVAILABLE } from './ws.ts'
import type { ApiApp } from './server.ts'
import {
  awaitLifecycleWriterDrain,
  createLifecycleBackgroundResources,
  isLifecycleManaged,
  readLifecycleBarrier,
  readLifecyclePublicStatus,
  startLifecycleWriterParticipant,
  withLifecycleWriterAdmission,
} from '../../../scripts/lifecycle-admission.mjs'

type ApiLifecycleParticipant = Awaited<ReturnType<typeof startLifecycleWriterParticipant>>

/** IPC is established before startup writers; an unsafe canonical namespace is quarantined. */
export const prepareApiLifecycleStartup = async (): Promise<{ managed: boolean; quarantined: boolean; participant?: ApiLifecycleParticipant }> => {
  let managed: boolean
  let quarantined = false
  try { managed = await isLifecycleManaged() }
  catch { managed = true; quarantined = true }
  try {
    if (await readLifecycleBarrier() !== null) { managed = true; quarantined = true }
  } catch { managed = true; quarantined = true }
  if (!managed) return { managed: false, quarantined: false }
  const participant = await createLifecycleBackgroundResources(() => startLifecycleWriterParticipant('api'))
  try {
    try { quarantined ||= await readLifecycleBarrier() !== null }
    catch { quarantined = true }
    return { managed: true, quarantined, participant }
  } catch (error) {
    await participant.close()
    throw error
  }
}

/** Frozen until restart: no database, state renderer, authentication or promotion callback exists. */
export const createQuarantinedApiApp = (): ApiApp => ({
  hub: createLifecycleBackgroundResources(() => new LiveEventHub()),
  fetch: async request => {
    const url = new URL(request.url)
    const health = request.method === 'GET' && url.pathname === '/api/health' && url.search === ''
    return new Response(JSON.stringify(health
      ? { ok: true, lifecycle: 'quarantined', writable: false }
      : { error: 'Lifecycle maintenance requires attention before this request can run.' }), {
      status: health ? 200 : 503,
      headers: { 'content-type': health ? 'application/json' : 'application/problem+json', 'cache-control': 'no-store', ...(health ? {} : { 'retry-after': '5' }) },
    })
  },
  authenticateUpgrade: async () => WS_AUTHORIZATION_UNAVAILABLE,
  watchMailbox: () => {},
})

export const closeApiLifecycleParticipant = async (participant?: ApiLifecycleParticipant): Promise<void> => {
  if (!participant) return
  await awaitLifecycleWriterDrain()
  await participant.close()
}

export interface PanelServerOptions {
  port?: number
  host?: string
  dbPath?: string
  stateDir?: string
  homeBaseDir?: string
  rootPassword?: string
  serverSecret?: string
  agentApp?: AgentApp
  os?: OsProfile
  agentToken?: string
  agentTokenFile?: string
  agentSocket?: string
  serverSecretFile?: string
  allowedOrigins?: readonly string[]
  trustedProxyAddresses?: readonly string[]
  webRenderer?: (req: Request) => Promise<Response> | Response
}

/** The bounded host-observation reply accepted from the agent account-usage contract. */
interface AccountUsageObservation {
  phpVersion: string | null
  diskBytes: number | null
  memoryBytes: number | null
  processCount: number | null
  bandwidth: 'unmeasured'
  ioEnforced?: boolean | null
  bandwidthMonth?: { month: string; totalBytes: number | null; limitBytes: number | null; usedPercent: number | null; enforced: boolean; limited: boolean }
}

/** Same four windows the agent website-analytics route accepts. */
const isWebsiteAnalyticsWindow = (value: string | null): value is WebsiteAnalyticsWindow =>
  value === '1h' || value === '24h' || value === '7d' || value === '30d'

const readUsageNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export const detectHostOsProfile = async (): Promise<OsProfile> => {
  return detectOs((p) => readFileSync(p, 'utf8'))
}

/**
 * Loads `serveWebUi` from `@xpanel/web` dynamically so visiting `/`, `/login`, `/whm`, `/panel`, `/mail`
 * renders the full bilingual HTML5 UI hydrated with live state from `StateStore` and `Db` when available.
 */
export const createDefaultWebRenderer = async (deps: {
  store: StateStore
  db: Db
  serverSecret: string
  /** Internal startup policy, shared with API and WebSocket authentication. */
  mfaRuntimePolicy?: MfaRuntimePolicy
  entryPoint?: EntryPoint
  /** This listener's own exact public origin. A listener renders no other panel's address. */
  publicOrigin?: string
  /** Connected agent. Implemented tools qualify only when its Linux probes pass. */
  agent?: { fetch: AgentApp['fetch']; token: string } | null
}): Promise<(req: Request) => Promise<Response> | Response> => {
  const mfaRuntimePolicy = bindMfaRuntimePolicy(deps.mfaRuntimePolicy)
  const { serveWebUi, resolveWebDocumentRoute } = await import('../../web/src/index.ts')
  const publicOrigin = (() => {
    if (!deps.publicOrigin) return undefined
    try { const url = new URL(deps.publicOrigin); return url.protocol === 'https:' && url.origin === deps.publicOrigin ? url.origin : undefined } catch { return undefined }
  })()
  /**
   * The existing agent account-usage contract, shared by /home and /resources.
   * A missing agent, failed read or unexpected wire shape is no observation (null),
   * never a zero sample. Bandwidth stays explicitly unmeasured.
   */
  const readAccountUsageObservation = async (principalId: string, username: string): Promise<AccountUsageObservation | null> => {
    if (!deps.agent) return null
    try {
      const response = await deps.agent.fetch(new Request(`http://agent.local/host/account-usage?username=${encodeURIComponent(username)}`, {
        headers: agentCallerHeaders({ principalId, token: deps.agent.token }),
      }))
      if (!response.ok) return null
      const body = await response.json() as {
        phpVersion?: unknown
        diskBytes?: unknown
        memoryBytes?: unknown
        processCount?: unknown
        bandwidth?: unknown
        ioEnforced?: unknown
        bandwidthMonth?: unknown
      }
      if (body.bandwidth !== 'unmeasured') return null
      const month = body.bandwidthMonth as Record<string, unknown> | undefined
      const nullableCount = (value: unknown): boolean => value === null || Number.isSafeInteger(value) && (value as number) >= 0
      const bandwidthMonth = month && typeof month === 'object' && typeof month.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month.month) && nullableCount(month.totalBytes) && nullableCount(month.limitBytes)
        && (month.usedPercent === null || readUsageNumber(month.usedPercent) !== null) && typeof month.enforced === 'boolean' && typeof month.limited === 'boolean'
        ? { month: month.month, totalBytes: month.totalBytes as number | null, limitBytes: month.limitBytes as number | null, usedPercent: month.usedPercent as number | null, enforced: month.enforced, limited: month.limited } : null
      return {
        phpVersion: typeof body.phpVersion === 'string' && /^\d+\.\d+$/.test(body.phpVersion) ? body.phpVersion : null,
        diskBytes: readUsageNumber(body.diskBytes),
        memoryBytes: readUsageNumber(body.memoryBytes),
        processCount: readUsageNumber(body.processCount),
        bandwidth: 'unmeasured' as const,
        ...(typeof body.ioEnforced === 'boolean' ? { ioEnforced: body.ioEnforced } : {}),
        ...(bandwidthMonth ? { bandwidthMonth } : {}),
      }
    } catch {
      return null
    }
  }
  /**
   * The existing account-scoped website traffic read path (`GET /api/analytics/websites/:id`
   * and the agent `/analytics/websites/:domainId` query). Server-wide IO is never used here.
   */
  const readWebsiteTraffic = async (
    principalId: string,
    domain: Pick<Domain, 'id' | 'name' | 'accountId'>,
    window: WebsiteAnalyticsWindow,
  ): Promise<WebsiteAnalyticsSnapshot | null> => {
    if (!deps.agent) return null
    try {
      const response = await deps.agent.fetch(new Request(`http://agent.local/analytics/websites/${encodeURIComponent(domain.id)}?window=${window}`, {
        headers: agentCallerHeaders({ principalId, token: deps.agent.token }),
      }))
      if (!response.ok) return null
      return parseWebsiteAnalyticsSnapshot(await response.json(), { domain: domain.name, accountId: domain.accountId })
    } catch {
      return null
    }
  }
  return async (req) => {
    const url = new URL(req.url)
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    // Every authenticated document of a handed-off session carries the identity banner.
    let impersonation: { target: string; issuer: string } | undefined
    // Saved branding, default appearance and the live-updates switch reach every rendered document; page state still wins.
    const panelDocumentState = async (): Promise<Partial<WebAppRenderState>> => {
      const [brandingRead, settings] = await Promise.all([panelBrandingFile(deps.store).read().catch(() => null), panelSettingsFile(deps.store).current()])
      const branding = brandingRead?.raw !== null ? brandingRead?.value ?? null : null
      return { ...(branding ? { branding: brandingForDocuments(branding), theme: branding.defaultTheme, density: branding.defaultDensity } : {}),
        ...(settings.liveUpdates ? {} : { realtimeEnabled: false }) }
    }
    const serve = (request: Request, state?: () => Promise<WebAppRenderState>) =>
      serveWebUi(request, state && (async () => ({ ...await panelDocumentState(), ...await state(), ...(impersonation ? { impersonation } : {}) })))
    let resolvedContact: string | undefined | null = null
    const supportEmail = async (): Promise<string | undefined> => {
      if (resolvedContact !== null) return resolvedContact || undefined
      try {
        const branded = (await panelBrandingFile(deps.store).current()).supportEmail
        resolvedContact = publicContactEmail(branded || (await deps.store.getServerSettings())?.adminEmail) ?? ''
      } catch {
        resolvedContact = ''
      }
      return resolvedContact || undefined
    }
    const qualifiedDocumentCatalog = async (): Promise<readonly CatalogTool[] | undefined> => {
      const loaded = await loadQualifiedCatalog(deps.agent ?? null)
      return loaded.some(tool => tool.status === 'verified') ? loaded : undefined
    }
    const documentStatus = async (
      status: 400 | 403 | 404,
      model: {
        surface: EntryPoint
        visibility?: VisibilityContext
        accountId?: string
        workspaceHref?: string
        catalog?: readonly CatalogTool[]
      },
    ) => {
      const email = await supportEmail()
      const catalog = model.catalog ?? (model.visibility ? await qualifiedDocumentCatalog() : undefined)
      let hostname: string | undefined
      if (model.surface === 'xwhm' && model.visibility?.principal.kind === 'root' && deps.agent) {
        try {
          const response = await deps.agent.fetch(new Request('http://agent.local/host/info', {
            headers: agentCallerHeaders({ principalId: model.visibility.principal.id, token: deps.agent.token }),
          }))
          if (response.ok) {
            const probed = mapAgentHostInfo(await response.json())?.hostname
            if (probed) hostname = probed
          }
        } catch { /* The settings hostname is the other source. */ }
      }
      if (!hostname && model.surface === 'xwhm') {
        try {
          const settings = await deps.store.getServerSettings()
          if (settings?.hostname) hostname = settings.hostname
        } catch { /* A status page can render without a host subtitle. */ }
      }
      if (!hostname && model.surface === 'xpanel' && model.accountId) {
        try {
          const account = await deps.store.getAccount(model.accountId)
          if (account?.primaryDomain) hostname = account.primaryDomain
        } catch { /* The brand stays the panel name. */ }
      }
      return serve(req, async () => ({
        surface: model.surface,
        mfaRuntimeMode: mfaRuntimePolicy.mode,
        activeRoute: url.pathname,
        ...(model.visibility ? { visibility: model.visibility } : {}),
        ...(catalog ? { catalog } : {}),
        ...(model.accountId ? { accountId: model.accountId } : {}),
        ...(email ? { supportEmail: email } : {}),
        error: {
          status,
          surface: model.surface,
          ...(hostname ? { hostname } : {}),
          ...(model.workspaceHref ? { workspaceHref: model.workspaceHref } : {}),
        },
      }))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers })
    const brandingAsset = await servePanelBrandingAsset(deps.store, url.pathname)
    if (brandingAsset) return brandingAsset
    if (url.pathname === '/favicon.ico' || url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
      return serveWebUi(req)
    }
    if (url.pathname === '/login') {
      const email = await supportEmail()
      return serveWebUi(req, async () => ({
        surface: 'login',
        mfaRuntimeMode: mfaRuntimePolicy.mode,
        ...(email ? { supportEmail: email } : {}),
        login: {
          ...(deps.entryPoint ? { audience: deps.entryPoint, targetSurface: deps.entryPoint } : {}),
          ...(email ? { supportEmail: email } : {}),
          ...(publicOrigin ? { publicOrigin } : {}),
          // A failed handoff lands here with one generic message; the reason is only in the audit trail.
          ...(url.searchParams.get('handoff') === 'failed' ? { handoffFailed: true } : {}),
        },
      }))
    }
    const documentRoute = resolveWebDocumentRoute(url.pathname)
    // Browser documents require a session; a scoped API token cannot expose an unscoped HTML snapshot.
    const teamMember = teamMemberResolver(teamFileReader(deps.store.rootDir))
    const caller = await authenticateRequest(deps.db, req, {
      serverSecret: deps.serverSecret, clientIp: null, mfaRuntimePolicy, teamMember,
      handoffAuthority: createHandoffSessionCheck({ db: deps.db, store: deps.store, teamMember }),
      ...(deps.entryPoint ? { entryPoint: deps.entryPoint } : {}),
    })
    const sessionReady = Boolean(caller && caller.mfaVerified && caller.apiTokenId === null && !caller.principalRecord.forcePasswordChange)
    const sessionVisibility = sessionReady && caller
      ? { principal: caller.principal, disabledFeatures: new Set<string>() }
      : undefined
    if (sessionReady && caller?.impersonator) {
      const mailbox = isMailboxPrincipalUsername(caller.principal.username) && caller.sessionId ? (await getMailboxSession(deps.db, caller.sessionId))?.mailbox : undefined
      impersonation = { target: mailbox ?? caller.principal.username, issuer: caller.impersonator.login }
    }
    if (!documentRoute) {
      return documentStatus(404, {
        surface: deps.entryPoint ?? 'xpanel',
        ...(sessionVisibility ? { visibility: sessionVisibility } : {}),
      })
    }
    // The listener, never a query parameter or a forwarded header, chooses its HTML surface.
    if (deps.entryPoint && url.pathname !== '/' && documentRoute.surface !== deps.entryPoint) {
      return documentStatus(404, { surface: deps.entryPoint })
    }

    if (!caller || !sessionReady) {
      return new Response(null, { status: 303, headers: { ...headers, location: '/login' } })
    }
    const principal = caller.principal
    const panelSettings = await panelSettingsFile(deps.store).current()
    if (panelSettings.offlineMode && principal.kind !== 'root') {
      const surface: EntryPoint = documentRoute.surface === 'xwhm' || documentRoute.surface === 'xmail' ? documentRoute.surface : 'xpanel'
      const offline = await serve(req, async () => ({ surface: deps.entryPoint ?? surface, mfaRuntimeMode: mfaRuntimePolicy.mode, activeRoute: url.pathname,
        error: { status: 503, surface: deps.entryPoint ?? surface, retryHref: url.pathname, ...(panelSettings.offlineMessage ? { notice: panelSettings.offlineMessage } : {}) } }))
      offline.headers.set('retry-after', '300')
      return offline
    }
    const savedAppearance = await readAdminPreferenceValues(deps.store.rootDir, principal)
    // A saved language the administrator no longer offers falls back to normal negotiation.
    const adminAppearance = savedAppearance ? { ...(isOfferedLocale(savedAppearance.language) ? { locale: savedAppearance.language } : {}), theme: savedAppearance.theme, density: savedAppearance.density } : {}
    const security = { totpEnabled: caller.principalRecord.totpEnabled }
    // Mailbox identities belong to xMail alone, and only they may open it.
    const mailboxIdentity = principal.kind === 'user' && isMailboxPrincipalUsername(principal.username)
    const wrongRole = (deps.entryPoint && !entryPointAdmitsPrincipal(deps.entryPoint, caller.principalRecord))
      || (documentRoute.surface === 'xwhm' && principal.kind === 'user')
      || (documentRoute.surface === 'xmail' && !mailboxIdentity)
      || (documentRoute.surface === 'xpanel' && mailboxIdentity && url.pathname !== '/')
    if (wrongRole && documentRoute.surface !== 'login') {
      const deniedSurface: EntryPoint = documentRoute.surface === 'xwhm' || documentRoute.surface === 'xmail' ? documentRoute.surface : 'xpanel'
      return documentStatus(403, {
        surface: deps.entryPoint ?? deniedSurface,
        visibility: { principal, disabledFeatures: new Set() },
      })
    }
    const surface: EntryPoint = documentRoute.surface === 'xwhm' || documentRoute.surface === 'xmail' ? documentRoute.surface : 'xpanel'
    if (url.pathname === '/') {
      const target = new URL(deps.entryPoint ? ENTRY_POINTS[deps.entryPoint].home : mailboxIdentity ? '/mail' : principal.kind === 'user' ? '/panel' : '/whm', url)
      for (const key of ['lang', 'theme', 'density', 'accountId']) if (url.searchParams.has(key)) target.searchParams.set(key, url.searchParams.get(key)!)
      return new Response(null, { status: 303, headers: { ...headers, location: `${target.pathname}${target.search}` } })
    }
    const reseller = principal.kind === 'reseller' ? (await deps.store.getReseller(principal.id)) ?? undefined : undefined
    // Administrator preferences address only the authenticated principal and require no account-list ACL.
    if (surface === 'xwhm' && documentRoute.activeRoute === '/whm/preferences') {
      if (principal.kind === 'reseller' && (!reseller || reseller.id !== principal.id || reseller.username !== principal.username)) return documentStatus(403, { surface, visibility: { principal } })
      if ([...url.searchParams.keys()].some(key => !['lang', 'theme', 'density'].includes(key))) return documentStatus(400, { surface, visibility: { principal } })
      const preferenceCatalog = await loadQualifiedCatalog(deps.agent ?? null)
      return serve(req, async () => ({ surface, ...adminAppearance, mfaRuntimeMode: mfaRuntimePolicy.mode,
        activeRoute: documentRoute.activeRoute, security, visibility: { principal, ...(reseller ? { reseller } : {}) }, catalog: preferenceCatalog,
        whm: { principal, activeReseller: reseller ?? null } }))
    }
    // Self-service factor management is independent of administrative document permissions.
    if (principal.kind === 'reseller' && surface === 'xwhm' && documentRoute.activeRoute === '/whm/security/sign-in') {
      if (!reseller || reseller.id !== principal.id || reseller.username !== principal.username) {
        return serve(req, async () => ({
          surface,
          mfaRuntimeMode: mfaRuntimePolicy.mode,
          activeRoute: documentRoute.activeRoute,
          error: { status: 403, surface },
        }))
      }
      return serve(req, async () => ({
        surface,
        ...adminAppearance,
        mfaRuntimeMode: mfaRuntimePolicy.mode,
        activeRoute: documentRoute.activeRoute,
        security,
        visibility: { principal },
      }))
    }
    const requiredAcl = surface === 'xmail' ? 'edit-account'
      : surface === 'xwhm' && documentRoute.activeRoute === '/whm/plans/features' ? 'manage-feature-lists'
      : 'list-accounts'
    if (principal.kind === 'reseller' && (!reseller || !hasAcl(principal, reseller, requiredAcl))) {
      return documentStatus(403, {
        surface,
        visibility: { principal, ...(reseller ? { reseller } : {}), disabledFeatures: new Set() },
      })
    }
    const accountId = url.searchParams.get('accountId')
    const ownAccountId = principal.kind === 'user' && accountId === principal.accountId ? accountId : undefined
    if (principal.kind === 'user' && accountId && accountId !== principal.accountId) {
      return documentStatus(404, {
        surface,
        visibility: { principal, disabledFeatures: new Set() },
        workspaceHref: ENTRY_POINTS[surface].home,
      })
    }
    const scoped = principal.kind === 'user'
      ? await deps.store.readAccountWorkspace(principal.accountId, { username: principal.username })
      : accountId ? await deps.store.readAccountWorkspace(accountId) : null
    if (accountId && (!scoped?.account || !canSeeAccount(principal, scoped.account))) {
      return documentStatus(404, {
        surface,
        visibility: { principal, ...(reseller ? { reseller } : {}), disabledFeatures: new Set() },
        workspaceHref: ENTRY_POINTS[surface].home,
      })
    }
    if (principal.kind === 'user' && (!scoped?.account || scoped.account.status !== 'active' || !scoped.plan || !scoped.featureList)) {
      return documentStatus(403, {
        surface,
        visibility: { principal, disabledFeatures: new Set(scoped?.featureList?.disabled ?? []) },
      })
    }
    const scopedVisibility = {
      principal,
      ...(reseller ? { reseller } : {}),
      disabledFeatures: new Set(scoped?.featureList?.disabled ?? []),
      ...(caller.team ? { allowedToolIds: new Set(teamToolIds(caller.team.roles)) } : {}),
    }
    if (!canOpenRegisteredRoute(documentRoute.activeRoute, scopedVisibility)) {
      return documentStatus(403, {
        surface,
        visibility: scopedVisibility,
        ...(ownAccountId ? { accountId: ownAccountId } : {}),
        workspaceHref: ENTRY_POINTS[surface].home,
      })
    }
    const catalog = await loadQualifiedCatalog(deps.agent ?? null)
    const qualifiedCatalog = catalog.some(tool => tool.status === 'verified') ? catalog : undefined
    const qualifiedRoute = visibleNavigation(scopedVisibility, catalog).some(item => item.surface === surface
      && item.sections.some(section => section.pages.some(page => page.route === canonicalNavigationRoute(documentRoute.activeRoute))))
    if (!qualifiedRoute) {
      const email = await supportEmail()
      const summaryAccount = principal.kind === 'user' && surface === 'xpanel' ? scoped?.account : null
      const summaryPlan = summaryAccount ? scoped?.plan : null
      return serve(req, async () => ({
        surface,
        ...adminAppearance,
        mfaRuntimeMode: mfaRuntimePolicy.mode,
        activeRoute: documentRoute.activeRoute,
        security,
        visibility: scopedVisibility,
        ...(qualifiedCatalog ? { catalog: qualifiedCatalog } : {}),
        ...(ownAccountId ? { accountId: ownAccountId } : {}),
        ...(email ? { supportEmail: email } : {}),
        workspaceSummary: {
          ...(summaryAccount ? { account: { id: summaryAccount.id, ownerId: summaryAccount.ownerId, username: summaryAccount.username,
            primaryDomain: summaryAccount.primaryDomain, status: summaryAccount.status, planId: summaryAccount.planId } } : {}),
          ...(summaryPlan ? { plan: { id: summaryPlan.id, name: summaryPlan.name } } : {}),
        },
      }))
    }
    const homeAccount = scoped?.account
    const homePlan = scoped?.plan
    if (surface === 'xpanel' && documentRoute.activeRoute === '/home' && principal.kind === 'user' && homeAccount?.status === 'active' && homePlan) {
      const email = await supportEmail()
      const [ownedUsers, sessions, homeAudit, homeDomains, homeDatabaseState, homeUsage] = await Promise.all([
        deps.store.listOwnedServiceUsers(homeAccount.username).catch(() => []),
        caller.team ? [] : listSessionsForPrincipal(deps.db, principal.id).catch(() => []),
        caller.team ? [] : listAudit(deps.db, { mentions: homeAccount.username, limit: 8 }).catch(() => []),
        deps.store.listDomains({ accountId: homeAccount.id }).catch(() => []),
        deps.store.readAccountDatabases(homeAccount.id, { username: homeAccount.username }),
        readAccountUsageObservation(principal.id, homeAccount.username),
      ])
      const homeAddresses = mailboxAddressIndex(ownedUsers.flatMap(user => user.services.email && user.login.includes('@') ? [user.login] : []))
      const lastSignInAt = [...sessions]
        .filter(session => session.id !== caller.sessionId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.createdAt
      return serve(req, async () => ({
        surface,
        activeRoute: '/home',
        mfaRuntimeMode: mfaRuntimePolicy.mode,
        security,
        visibility: scopedVisibility,
        ...(qualifiedCatalog ? { catalog: qualifiedCatalog } : {}),
        ...(ownAccountId ? { accountId: ownAccountId } : {}),
        ...(email ? { supportEmail: email } : {}),
        panel: {
          account: homeAccount,
          plan: homePlan,
          domains: homeDomains,
          ...(homeUsage ? { usage: homeUsage } : {}),
          databases: homeDatabaseState.databases,
          databaseUsers: homeDatabaseState.databaseUsers.map(user => ({ id: user.id, name: user.name, grants: user.grants })),
          serviceUsers: ownedUsers.map(user => ({ ...user, passwordHash: '' })),
          files: [],
          ...(lastSignInAt ? { lastSignInAt } : {}),
          recentAudit: homeAudit.map(entry => ({
            action: entry.action,
            actor: rewriteMailboxIds(entry.actor, homeAddresses),
            target: rewriteMailboxIds(entry.target, homeAddresses),
            detail: entry.detail,
          })),
        },
      }))
    }
    const auditRoute = surface === 'xwhm' && documentRoute.activeRoute === '/whm/audit' && principal.kind === 'root'
    let auditFilters: AuditQuery = {}
    if (auditRoute) {
      try { auditFilters = parseAuditFilters(url.searchParams) }
      catch (error) {
        if (!isXpanelError(error) || error.code !== 'VALIDATION') throw error
        return documentStatus(400, { surface, visibility: scopedVisibility, workspaceHref: '/whm/audit', catalog })
      }
    }
    // Qualified screens re-authorize against their fresh full snapshot, not the earlier projection.
    const snap = await deps.store.readSnapshot()
    const ownedAccounts = snap.accounts.filter((account) => canSeeAccount(principal, account))
    const account = accountId ? ownedAccounts.find((a) => a.id === accountId) : ownedAccounts[0]
    if (accountId && !account) {
      return documentStatus(404, {
        surface,
        visibility: { principal, ...(reseller ? { reseller } : {}), disabledFeatures: new Set() },
        workspaceHref: ENTRY_POINTS[surface].home,
      })
    }
    if (principal.kind === 'user' && (!account || account.status !== 'active')) {
      return documentStatus(403, {
        surface,
        visibility: { principal, disabledFeatures: new Set() },
      })
    }
    const plan = account ? snap.plans.find((p) => p.id === account.planId) : undefined
    const featureList = plan ? snap.featureLists.find((f) => f.id === plan.featureListId) : undefined
    if (principal.kind === 'user' && (!plan || !featureList)) {
      return documentStatus(403, {
        surface,
        visibility: { principal, disabledFeatures: new Set(featureList?.disabled ?? []) },
      })
    }
    const visibility = {
      principal,
      ...(reseller ? { reseller } : {}),
      disabledFeatures: new Set(featureList?.disabled ?? []),
    }
    const listedAccounts = principal.kind === 'reseller' && !hasAcl(principal, reseller, 'list-accounts') ? [] : ownedAccounts
    const listedAccountIds = new Set(listedAccounts.map(account => account.id))
    const visibleDomains = snap.domains.filter(domain => listedAccountIds.has(domain.accountId))
    const listedPlanIds = new Set(listedAccounts.map((a) => a.planId))
    const visiblePlans = snap.plans.filter((p) => principal.kind === 'root' || p.ownerId === principal.id || listedPlanIds.has(p.id))
    const visibleResellers = snap.resellers.filter((r) => principal.kind === 'root' || r.id === principal.id)
    const visibleFeatureLists = snap.featureLists
      .filter(item => principal.kind === 'root' || (principal.kind === 'reseller' && (item.ownerId === null || item.ownerId === principal.id)))
      .map(({ id, name, disabled, ownerId }) => ({ id, name, disabled, ownerId }))
    const requestedPlanId = url.searchParams.has('planId') ? url.searchParams.get('planId') : null
    const selectedEditPlan = requestedPlanId !== null ? visiblePlans.find(item => item.id === requestedPlanId) : undefined
    const planEditorState = requestedPlanId === null ? { kind: 'create' as const }
      : selectedEditPlan ? { kind: 'edit' as const, plan: selectedEditPlan } : { kind: 'unavailable' as const }
    const visibleIpPool = principal.kind === 'root' ? snap.ipPool ?? [] : []
    const visibleFirewall = principal.kind === 'root' ? snap.firewall.rules : []
    const accountDomains = snap.domains.filter((d) => d.accountId === account?.id)
    const accountDatabases = snap.databases.filter((d) => d.accountId === account?.id)
    const accountDatabaseUsers = snap.databaseUsers.filter((user) => user.accountId === account?.id).map((user) => ({ id: user.id, accountId: user.accountId, name: user.name, grants: user.grants }))
    const accountServiceUsers = snap.serviceUsers.filter((u) => u.accountId === account?.id).map((u) => ({ ...u, passwordHash: '' }))
    const accountCertificates = account ? snap.certificates.filter(certificate => certificate.accountId === account.id) : []
    // The owner site-settings page reads the selected domain's custom configuration from the
    // desired-state store. A domain without a saved record renders empty editable defaults; it is
    // never presented as a saved configuration and the page keeps its explicit application state.
    const siteSettingsRoute = surface === 'xpanel' && documentRoute.activeRoute === '/domains/site-settings'
    const requestedSiteDomain = url.searchParams.get('domainId')
    const selectedSiteDomain = siteSettingsRoute && account
      ? (requestedSiteDomain && /^[0-9a-f-]{36}$/i.test(requestedSiteDomain) ? accountDomains.find(domain => domain.id === requestedSiteDomain.toLowerCase()) : undefined)
        ?? accountDomains.find(domain => domain.kind === 'primary')
        ?? accountDomains[0]
      : undefined
    const domainCustomConfig = selectedSiteDomain ? await deps.store.getDomainCustomConfig(selectedSiteDomain.id).catch(() => null) : null
    const customConfigView = selectedSiteDomain ? {
      domainId: selectedSiteDomain.id, accountId: selectedSiteDomain.accountId, domainName: selectedSiteDomain.name,
      nginxInclude: domainCustomConfig?.nginxInclude ?? '',
      apacheInclude: domainCustomConfig?.apacheInclude ?? '',
      userIni: domainCustomConfig?.userIni ?? {},
      customHeaders: domainCustomConfig?.customHeaders ?? {},
      cacheBypassPaths: domainCustomConfig?.cacheBypassPaths ?? [],
      updatedAt: domainCustomConfig?.updatedAt ?? '',
      updatedBy: domainCustomConfig?.updatedBy ?? 'user',
    } : undefined
    // The two approved account pages read their existing account-scoped observations here.
    // A missing agent, failed read or invalid reply leaves no prop, so the page keeps its
    // explicit unavailable state instead of fabricating a sample.
    const resourcesRoute = surface === 'xpanel' && documentRoute.activeRoute === '/resources'
    const trafficRoute = surface === 'xpanel' && documentRoute.activeRoute === '/metrics/traffic'
    const requestedWindow = url.searchParams.get('window')
    const trafficWindow: WebsiteAnalyticsWindow = isWebsiteAnalyticsWindow(requestedWindow) ? requestedWindow : '24h'
    const trafficDomain = trafficRoute && account
      ? accountDomains.find(domain => domain.name === account.primaryDomain)
        ?? accountDomains.find(domain => domain.kind === 'primary')
        ?? accountDomains[0]
      : undefined
    const [resourceUsage, trafficAnalytics] = await Promise.all([
      resourcesRoute && account ? readAccountUsageObservation(principal.id, account.username) : null,
      trafficDomain ? readWebsiteTraffic(principal.id, trafficDomain, trafficWindow) : null,
    ])
    const active = await latestActive(deps.db)
    const dashboardRoute = surface === 'xwhm' && documentRoute.activeRoute === '/whm' && principal.kind === 'root'
    const AUDIT_PAGE_SIZE = 50
    const typedActor = auditFilters.actor ?? ''
    const typedAction = auditFilters.action ?? ''
    const typedTarget = auditFilters.target ?? ''
    const actionFilter = typedAction
    const beforeId = auditFilters.beforeId ?? ''
    const auditBounds = {
      ...(auditFilters.outcome ? { outcome: auditFilters.outcome } : {}),
      ...(auditFilters.from ? { from: auditFilters.from } : {}),
      ...(auditFilters.to ? { to: auditFilters.to } : {}),
    }
    const actorFilters = typedActor ? [...new Set([typedActor, auditActorQuery(typedActor)])] : []
    const targetFilters = typedTarget ? [...new Set([typedTarget, auditTargetQuery(typedTarget)])] : []
    const collectAudit = async (query: AuditQuery): Promise<AuditEntry[]> => {
      const actors = actorFilters.length > 0 ? actorFilters : [undefined]
      const targets = targetFilters.length > 0 ? targetFilters : [undefined]
      const found = new Map<string, AuditEntry>()
      for (const actor of actors) {
        for (const target of targets) {
          const rows = await listAudit(deps.db, {
            ...query,
            ...(actor ? { actor } : {}),
            ...(target ? { target } : {}),
          })
          for (const row of rows) found.set(row.id, row)
        }
      }
      return [...found.values()].sort((a, b) => Number(b.id) - Number(a.id))
    }
    const readAgentJson = async (path: string): Promise<unknown> => {
      const allowed = path === '/host/info' ? dashboardRoute || auditRoute : dashboardRoute
      if (!allowed || !deps.agent) return null
      try {
        const response = await deps.agent.fetch(new Request(`http://agent.local${path}`, {
          headers: agentCallerHeaders({ principalId: principal.id, token: deps.agent.token }),
        }))
        if (!response.ok) return null
        return await response.json()
      } catch {
        return null
      }
    }
    const [hostInfo, hostServices, hostDrift, overviewAudit, rollbackGeneration, auditListed] = await Promise.all([
      dashboardRoute || auditRoute ? readAgentJson('/host/info') : null,
      dashboardRoute ? readAgentJson('/host/services') : null,
      dashboardRoute ? readAgentJson('/host/drift') : null,
      dashboardRoute ? listAudit(deps.db, { limit: 8 }).catch(() => []) : [],
      dashboardRoute ? previousGeneration(deps.db).catch(() => null) : null,
      auditRoute
        ? collectAudit({
            ...auditBounds,
            limit: AUDIT_PAGE_SIZE + 1,
            ...(beforeId ? { beforeId } : {}),
            ...(actionFilter ? { action: actionFilter } : {}),
          }).catch(() => [])
        : [],
    ])
    const mailboxAddresses = mailboxAddressIndex(
      snap.serviceUsers.filter(user => user.services.email && user.login.includes('@')).map(user => user.login),
    )
    const showAudit = (entry: AuditEntry): AuditEntry => ({
      ...entry,
      actor: rewriteMailboxIds(entry.actor, mailboxAddresses),
      target: rewriteMailboxIds(entry.target, mailboxAddresses),
    })
    const auditPage = overviewAudit.map(showAudit)
    const auditHasMore = auditListed.length > AUDIT_PAGE_SIZE
    const auditRows = auditListed.slice(0, AUDIT_PAGE_SIZE).map(showAudit)
    const asRecord = (value: unknown): Record<string, unknown> | null =>
      value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
    const hostSample = mapAgentHostInfo(hostInfo)
    const serviceRows = mapAgentServices(hostServices)
    const driftRecord = asRecord(hostDrift)
    const driftCount = typeof driftRecord?.count === 'number' && Number.isSafeInteger(driftRecord.count) && driftRecord.count >= 0
      ? driftRecord.count
      : null
    const driftCheckedAt = typeof driftRecord?.checkedAt === 'string' && !Number.isNaN(Date.parse(driftRecord.checkedAt))
      ? driftRecord.checkedAt
      : null
    const hostInfoRecord = asRecord(hostInfo)
    const hostCertificates = Array.isArray(hostInfoRecord?.certificates)
      ? hostInfoRecord.certificates.flatMap(item => {
          const row = asRecord(item)
          const names = Array.isArray(row?.names) ? row.names.filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 253) : []
          const notAfter = typeof row?.notAfter === 'string' ? row.notAfter : ''
          return names.length > 0 && !Number.isNaN(Date.parse(notAfter)) ? [{ names, notAfter }] : []
        })
      : []
    const numericCap = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
    const nearLimits = listedAccounts.flatMap(accountRow => {
      const accountPlan = snap.plans.find(item => item.id === accountRow.planId)
      if (!accountPlan) return []
      const checks: Array<[string, number, number | null]> = [
        ['mailboxes', snap.serviceUsers.filter(user => user.accountId === accountRow.id && user.services.email).length, numericCap(accountPlan.caps.mailboxes)],
        ['addon domains', snap.domains.filter(domain => domain.accountId === accountRow.id && domain.kind === 'addon').length, numericCap(accountPlan.caps.addonDomains)],
        ['databases', [...snap.databases, ...snap.postgresqlDatabases ?? []].filter(database => database.accountId === accountRow.id && !database.trashedAt).length, numericCap(accountPlan.caps.databases)],
      ]
      return checks.flatMap(([label, used, cap]) => cap !== null && used / cap >= 0.8 ? [{ name: accountRow.username, note: `${used} / ${cap} ${label}` }] : [])
    })
    return serve(req, async () => ({
      surface,
      ...adminAppearance,
      activeRoute: documentRoute.activeRoute,
      mfaRuntimeMode: mfaRuntimePolicy.mode,
      security,
      ...(url.searchParams.has('accountId') && account ? { accountId: account.id } : {}),
      visibility,
      ...(qualifiedCatalog ? { catalog: qualifiedCatalog } : {}),
      ...(active ? { generationId: active.id } : {}),
      ...(surface === 'xwhm' ? { whm: {
        principal,
        activeReseller: reseller ?? null,
        accounts: listedAccounts,
        domains: visibleDomains,
        plans: visiblePlans,
        featureLists: visibleFeatureLists,
        planEditorState,
        resellers: visibleResellers,
        ...(principal.kind === 'root' && snap.mailIpConfig ? { mailIpConfig: snap.mailIpConfig } : {}),
        ipPool: visibleIpPool,
        firewallRules: visibleFirewall,
        ...(principal.kind === 'root' && snap.server ? {
          serverSettings: snap.server.settings,
          hostname: hostSample?.hostname ?? snap.server.settings.hostname,
          ...(hostSample?.panelDomain ? { panelHostname: hostSample.panelDomain } : {}),
        } : {}),
        ...(auditRoute ? {
          auditEntries: auditRows,
          auditList: {
            ...auditBounds,
            actor: typedActor,
            action: typedAction,
            target: typedTarget,
            before: beforeId,
            hasMore: auditHasMore,
            oldestId: auditRows.at(-1)?.id ?? '',
          },
        } : {}),
        ...(dashboardRoute ? {
          auditEntries: auditPage,
          certificates: hostInfo
            ? [...hostCertificates, ...snap.certificates.map(certificate => ({ names: certificate.names, notAfter: certificate.notAfter }))]
            : (snap.certificates.length > 0 ? snap.certificates : undefined),
          driftCount,
          ...(driftCheckedAt ? { driftCheckedAt } : {}),
          nearLimits,
          ...(active?.activatedAt ? { generationActivatedAt: active.activatedAt } : {}),
          ...(rollbackGeneration ? { rollbackGenerationId: rollbackGeneration.id } : {}),
          ...(hostSample ? { hostSample } : {}),
          ...(serviceRows ? { services: serviceRows } : {}),
        } : {}),
      } } : {}),
      ...(surface === 'xpanel' ? { panel: {
        ...(account ? { account } : {}),
        ...(plan ? { plan } : {}),
        domains: accountDomains,
        ...(customConfigView ? { customConfig: customConfigView } : {}),
        certificates: accountCertificates,
        ...(resourceUsage ? { usage: resourceUsage } : {}),
        ...(trafficAnalytics
          ? { websiteAnalytics: trafficAnalytics, websiteAnalyticsWindow: trafficWindow }
          : trafficRoute ? { websiteAnalyticsUnavailable: true } : {}),
        databases: accountDatabases,
        databaseUsers: accountDatabaseUsers,
        serviceUsers: accountServiceUsers,
        files: [],
      } } : {}),
      ...(surface === 'xmail' ? { mail: await (async () => {
        if (documentRoute.activeRoute === '/mail/contacts') {
          const access = await requireMailboxPrincipalAccess(deps.store, caller).catch(() => null)
          return { mailbox: access?.mailbox ?? '' }
        }
        let postfixMain: string | null = null
        try { postfixMain = readFileSync('/etc/postfix/main.cf', 'utf8') } catch { postfixMain = null }
        let dkimProbe: 'signing' | 'refused' | 'unknown' = 'unknown'
        if (deps.agent) {
          try {
            const response = await deps.agent.fetch(new Request('http://agent.local/host/dkim-probe', {
              headers: agentCallerHeaders({ principalId: principal.id, token: deps.agent.token }),
            }))
            if (response.ok) {
              const body = await response.json() as { status?: unknown }
              if (body.status === 'signing' || body.status === 'refused' || body.status === 'unknown') dkimProbe = body.status
            }
          } catch { /* An unread probe stays unknown. It is not a connection. */ }
        }
        const dkimByDomain: Record<string, { selector: string; dnsTxt: string }> = {}
        try {
          const parsed = JSON.parse(readFileSync('/etc/opendkim/signing.json', 'utf8')) as {
            domains?: Record<string, { selector?: unknown; dnsTxt?: unknown }>
          }
          for (const [name, row] of Object.entries(parsed.domains ?? {})) {
            if (row && typeof row.selector === 'string' && typeof row.dnsTxt === 'string') {
              dkimByDomain[name] = { selector: row.selector, dnsTxt: row.dnsTxt }
            }
          }
        } catch { /* No published signing material. The probe line stays the label. */ }
        if (postfixMain !== null && messageSizeLimitBytes(postfixMain) === null) {
          try {
            const output = await new Promise<string>((resolve, reject) => {
              execFile('/usr/sbin/postconf', ['-h', 'message_size_limit'], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024, windowsHide: true }, (error, stdout) => {
                if (error) reject(error)
                else resolve(stdout)
              })
            })
            const bytes = messageSizeLimitFromPostconf(output)
            if (bytes !== null) postfixMain = `${postfixMain}\nmessage_size_limit = ${bytes}\n`
          } catch { /* The file text stays the only source when postconf cannot run. */ }
        }
        const routeFolder = ({ '/mail/sent': 'Sent', '/mail/drafts': 'Drafts', '/mail/trash': 'Trash' } as Record<string, string | undefined>)[documentRoute.activeRoute]
        const requestedFolder = routeFolder ?? url.searchParams.get('folder')
        let folder = 'INBOX'
        try { folder = mailFolderName(requestedFolder) } catch { folder = 'INBOX' }
        const mode = url.searchParams.get('mode')
        const replyUid = Number(url.searchParams.get('uid'))
        const replyMode = mode === 'reply' || mode === 'reply-all' || mode === 'forward' ? mode : null
        const managedFolder = (documentRoute.activeRoute === '/mail/inbox' || routeFolder !== undefined) && ['INBOX', 'Sent', 'Drafts', 'Trash'].includes(folder)
        const loaded = await loadMailDocument({
          readFirst: !managedFolder && req.headers.get('x-xpanel-mail-refresh') !== 'list',
          db: deps.db,
          store: deps.store,
          serverSecret: deps.serverSecret,
          sessionId: caller.sessionId,
          transport: createLocalMailboxTransport(),
          folder,
          postfixMain,
          dkimProbe,
          dkimByDomain,
          zones: snap.zones.map(zone => ({
            name: zone.name,
            records: zone.records.map(record => ({ name: record.name, type: record.type, content: record.content })),
          })),
          locale: requestLocale(url, req),
          ...(replyMode && documentRoute.activeRoute === '/mail/compose' && Number.isInteger(replyUid) && replyUid > 0
            ? { reply: { mode: replyMode, uid: replyUid } }
            : {}),
        }).catch((): MailDocument => ({ mailbox: '', mailListFailed: true }))
        return {
          mailbox: loaded.mailbox,
          ...(folder !== 'INBOX' ? { activeFolder: folder } : {}),
          ...(loaded.quotaUsedMb !== undefined ? { quotaUsedMb: loaded.quotaUsedMb } : {}),
          ...(loaded.quotaUsedBytes !== undefined ? { quotaUsedBytes: loaded.quotaUsedBytes } : {}),
          ...(loaded.quotaLimitMb !== undefined ? { quotaLimitMb: loaded.quotaLimitMb } : {}),
          ...(loaded.messages !== undefined ? { messages: loaded.messages } : {}),
          ...(loaded.folderCounts ? { folderCounts: loaded.folderCounts } : {}),
          ...(loaded.mailListFailed ? { mailListFailed: true } : {}),
          ...(loaded.vacationEnabled !== undefined ? { vacationEnabled: loaded.vacationEnabled } : {}),
          ...(loaded.sieveRules ? { sieveRules: loaded.sieveRules } : {}),
          ...(loaded.identityDkim ? { identityDkim: loaded.identityDkim } : {}),
          ...(loaded.identitySpf ? { identitySpf: loaded.identitySpf } : {}),
          ...(loaded.identitySize ? { identitySize: loaded.identitySize } : {}),
          ...(loaded.composeDraft ? { composeDraft: loaded.composeDraft } : {}),
        }
      })() } : {}),
    }))
  }
}

export interface PanelEntryPointConfig {
  publicOrigin: string
  port: number
}

export interface PanelEntrypointsOptions extends Omit<PanelServerOptions, 'port' | 'allowedOrigins' | 'trustedProxyAddresses' | 'webRenderer'> {
  entryPoints?: Readonly<Record<EntryPoint, PanelEntryPointConfig>>
  ingressSecret?: string
  ingressSecretFile?: string
}

const ENTRY_POINT_ORDER: readonly EntryPoint[] = ['xpanel', 'xwhm', 'xmail']
/** The only crossings: xWHM opens xPanel for an account, xPanel opens xMail for a mailbox. Never rendered. */
const HANDOFF_ROUTES: Readonly<Record<EntryPoint, (origins: Readonly<Record<EntryPoint, PanelEntryPointConfig>>) => { targetOrigin?: string; issuerOrigin?: string }>> = {
  xwhm: origins => ({ targetOrigin: origins.xpanel.publicOrigin }),
  xpanel: origins => ({ targetOrigin: origins.xmail.publicOrigin, issuerOrigin: origins.xwhm.publicOrigin }),
  xmail: origins => ({ issuerOrigin: origins.xpanel.publicOrigin }),
}
const ENTRY_POINT_ENV = {
  xpanel: { origin: 'XPANEL_PANEL_PUBLIC_ORIGIN', port: 'XPANEL_PANEL_PORT', defaultPort: 12083 },
  xwhm: { origin: 'XPANEL_WHM_PUBLIC_ORIGIN', port: 'XPANEL_WHM_PORT', defaultPort: 12087 },
  xmail: { origin: 'XPANEL_MAIL_PUBLIC_ORIGIN', port: 'XPANEL_MAIL_PORT', defaultPort: 12096 },
} as const

/** Validate the entire configuration before opening the database or binding any listener. */
export const resolvePanelEntrypoints = (
  options: Pick<PanelEntrypointsOptions, 'entryPoints' | 'host'> = {},
  env: NodeJS.ProcessEnv = process.env,
): { host: string; entryPoints: Readonly<Record<EntryPoint, PanelEntryPointConfig>> } => {
  const host = options.host ?? env.XPANEL_HOST ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== '::1') fail('PRECONDITION_FAILED', 'entrypoint listeners must bind an explicit loopback address')
  const ports = new Set<number>()
  const entryPoints = {} as Record<EntryPoint, PanelEntryPointConfig>
  for (const entryPoint of ENTRY_POINT_ORDER) {
    const config = ENTRY_POINT_ENV[entryPoint]
    const explicit = options.entryPoints?.[entryPoint]
    const rawPort = env[config.port]
    if (!explicit && rawPort !== undefined && !/^[1-9][0-9]{0,4}$/.test(rawPort)) {
      fail('PRECONDITION_FAILED', `${config.port} must be an integer port`)
    }
    const port = explicit?.port ?? (rawPort === undefined ? config.defaultPort : Number(rawPort))
    if (!Number.isInteger(port) || port < 1 || port > 65535 || ports.has(port)) {
      fail('PRECONDITION_FAILED', 'entrypoint listener ports must be distinct integers in 1..65535')
    }
    ports.add(port)
    const publicOrigin = explicit?.publicOrigin ?? env[config.origin] ?? fail('PRECONDITION_FAILED', 'each entrypoint requires an exact HTTPS origin')
    let parsed: URL
    try { parsed = new URL(publicOrigin ?? '') } catch { return fail('PRECONDITION_FAILED', `${config.origin} must be an exact HTTPS origin`) }
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin || parsed.port !== String(ENTRY_POINTS[entryPoint].port)) {
      fail('PRECONDITION_FAILED', `${config.origin} must be an exact HTTPS origin on port ${ENTRY_POINTS[entryPoint].port}`)
    }
    entryPoints[entryPoint] = Object.freeze({ publicOrigin, port })
  }
  // Browsers share cookies across the ports of one host; each panel needs its own hostname.
  if (new Set(ENTRY_POINT_ORDER.map(name => new URL(entryPoints[name].publicOrigin).hostname)).size !== ENTRY_POINT_ORDER.length) {
    fail('PRECONDITION_FAILED', 'the xPanel, xWHM and xMail origins must use three distinct hostnames')
  }
  return { host, entryPoints: Object.freeze(entryPoints) }
}

/**
 * One unprivileged process owns one SQLite handle, state store and agent client.
 * Three immutable applications listen privately behind independent HTTPS ingress servers.
 * Public TLS is terminated by the configured ingress, never by these HTTP listeners.
 */
export const startPanelEntrypoints = async (opts: PanelEntrypointsOptions = {}) => {
  const mfaRuntimePolicy = captureMfaRuntimePolicy()
  const { host, entryPoints } = resolvePanelEntrypoints(opts)
  if (!opts.agentApp && ENTRY_POINT_ORDER.some(name => entryPoints[name].port !== ENTRY_POINT_ENV[name].defaultPort)) {
    fail('PRECONDITION_FAILED', 'production entrypoint listeners must use reserved ports 12083, 12087 and 12096')
  }
  if (!opts.agentApp && (process.platform !== 'linux' || process.getuid?.() === 0)) {
    fail('PRECONDITION_FAILED', 'the API must run as an unprivileged Linux service with a separate agent')
  }
  const defaultBaseDir = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
  const dbPath = opts.dbPath ?? process.env.XPANEL_DB_PATH ?? `${defaultBaseDir}/control.db`
  const stateDir = opts.stateDir ?? process.env.XPANEL_STATE_DIR ?? `${defaultBaseDir}/state`
  const lifecycle = await prepareApiLifecycleStartup()
  let dbHandle: ReturnType<typeof createDb> | undefined
  let client: ReturnType<typeof createAgentClient> | undefined
  let alerts: ReturnType<typeof startAlertScheduler> | undefined
  const listeners: Awaited<ReturnType<typeof listenApiServer>>[] = []
  const agentSubscriptions: (() => void)[] = []
  const sockets = new Set<Socket>()
  const apps = {} as Record<EntryPoint, ReturnType<typeof createApiApp>>
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // HTTP closeAllConnections does not include upgraded WebSocket connections.
      for (const socket of sockets) socket.destroy()
      const alertResults = await Promise.allSettled([Promise.resolve().then(() => alerts?.stop())])
      const listenerResults = await Promise.allSettled(listeners.map(listener => listener.close()))
      const subscriptionResults = await Promise.allSettled(agentSubscriptions.map(async unsubscribe => unsubscribe()))
      const clientResults = await Promise.allSettled([Promise.resolve().then(() => client?.close())])
      const errors: unknown[] = [...alertResults, ...listenerResults, ...subscriptionResults, ...clientResults].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      try { await awaitLifecycleWriterDrain() } catch (error) { errors.push(error) }
      try { await dbHandle?.close() } catch (error) { errors.push(error) }
      try { await closeApiLifecycleParticipant(lifecycle.participant) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, 'API entrypoint shutdown requires operational inspection')
    })()
    return closePromise
  }
  try {
    if (lifecycle.quarantined) {
      for (const entryPoint of ENTRY_POINT_ORDER) {
        const app = createQuarantinedApiApp()
        apps[entryPoint] = app
        const listener = await createLifecycleBackgroundResources(() => listenApiServer(app, { port: entryPoints[entryPoint].port, host }))
        listener.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
        listeners.push(listener)
      }
      return {
        quarantined: true as const, apps: Object.freeze(apps), host, entryPoints,
        listeners: Object.freeze(Object.fromEntries(ENTRY_POINT_ORDER.map((name, index) => [name, { port: listeners[index]!.port, publicOrigin: entryPoints[name].publicOrigin }])) as Record<EntryPoint, { port: number; publicOrigin: string }>),
        close,
      }
    }
    const serverSecret = opts.serverSecret ?? await loadAgentCredentialFile(opts.serverSecretFile ?? process.env.XPANEL_SERVER_SECRET_FILE ?? '/etc/xpanel/server.secret')
    const agentToken = opts.agentToken ?? await loadAgentCredentialFile(opts.agentTokenFile ?? process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token')
    const ingressSecret = opts.ingressSecret ?? await loadAgentCredentialFile(opts.ingressSecretFile ?? process.env.XPANEL_INGRESS_SECRET_FILE ?? '/etc/xpanel/ingress.secret')
    if (Buffer.byteLength(ingressSecret, 'utf8') < 32) fail('PRECONDITION_FAILED', 'a protected ingress credential of at least 32 bytes is required')
    const os = opts.os ?? await detectHostOsProfile()
    const handle = await withLifecycleWriterAdmission(async () => {
      if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true })
      await mkdir(stateDir, { recursive: true })
      await assertStateWritable(stateDir)
      const opened = createDb(dbPath, lifecycle.managed ? { durability: 'strict' } : {})
      dbHandle = opened
      await migrate(opened.runner)
      await initializeOperationalMetadata(opened.db)
      await ensureRootPrincipal(opened.db, { ...(opts.rootPassword ? { password: opts.rootPassword } : {}) })
      return opened
    })
    const store = new StateStore(stateDir)
    // Saved locale policy and uploaded catalogs apply from panel start; invalid saved state keeps the release catalogs.
    const languages = await installSavedLanguages(store.rootDir)
    if (languages.policy === 'invalid' || languages.rejected.length) console.warn(`languages: saved policy ${languages.policy}; catalogs not applied: ${languages.rejected.join(', ') || 'none'}`)
    if (!opts.agentApp) client = createLifecycleBackgroundResources(() => createAgentClient({ socketPath: opts.agentSocket ?? process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken }))
    const sharedAgent = opts.agentApp ?? client!
    const agentApp: AgentApp = {
      fetch: request => sharedAgent.fetch(request),
      subscribe: callback => {
        const unsubscribe = sharedAgent.subscribe(callback)
        agentSubscriptions.push(unsubscribe)
        return unsubscribe
      },
    }
    for (const entryPoint of ENTRY_POINT_ORDER) {
      const config = entryPoints[entryPoint]
      const webRenderer = await createDefaultWebRenderer({
        store, db: handle.db, serverSecret, mfaRuntimePolicy, entryPoint, publicOrigin: config.publicOrigin,
        agent: { fetch: request => agentApp.fetch(request), token: agentToken },
      })
      const app = createLifecycleBackgroundResources(() => createApiApp({
        db: handle.db, store, agentApp, agentToken, os, serverSecret, mfaRuntimePolicy, webRenderer,
        entryPoint, publicOrigin: config.publicOrigin, allowedOrigins: [config.publicOrigin], handoff: HANDOFF_ROUTES[entryPoint](entryPoints),
        ingressSecret, requireSecureCookies: true, requireOriginHeader: true,
        ...(opts.homeBaseDir ? { homeBaseDir: opts.homeBaseDir } : {}),
      }))
      apps[entryPoint] = app
      const listener = await createLifecycleBackgroundResources(() => listenApiServer(app, { port: config.port, host }))
      listener.server.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      listeners.push(listener)
    }
    alerts = createLifecycleBackgroundResources(() => startAlertScheduler({ db: handle.db, store, agentApp, agentToken, admit: withLifecycleWriterAdmission,
      onError: () => process.stderr.write('xpanel-api: a scheduled alert check did not complete\n') }))
    return {
      quarantined: false as const, apps: Object.freeze(apps), host, entryPoints, db: handle.db, store,
      listeners: Object.freeze(Object.fromEntries(ENTRY_POINT_ORDER.map((name, index) => [name, {
        port: listeners[index]!.port, publicOrigin: entryPoints[name].publicOrigin,
      }])) as Record<EntryPoint, { port: number; publicOrigin: string }>),
      close,
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}

const CLI_VERBS = new Set(['status', 'reconcile', 'rollback', 'reindex', 'init-root', 'reset-password', 'disable-2fa', 'repair-state-ownership', 'help', '--help', '-h'])

const readPasswordInput = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    process.stderr.write('Enter new password (min 8 characters) and press Enter: ')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 4096) fail('VALIDATION', 'password input exceeds the maximum length')
    chunks.push(buffer)
    if (process.stdin.isTTY && (buffer.includes(0x0a) || buffer.includes(0x0d))) {
      break
    }
  }
  if (process.stdin.isTTY) {
    process.stdin.pause()
    const text = Buffer.concat(chunks).toString('utf8')
    const firstLine = text.split(/\r?\n/)[0] ?? ''
    return `${firstLine}\n`
  }
  return Buffer.concat(chunks).toString('utf8')
}

const isMainModule = (): boolean => {
  try {
    return process.argv[1] === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

const repairStateOwnership = (stateDir: string, dbPath: string): number => {
  const targets = [stateDir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]
  for (const target of targets) {
    const result = spawnSync('chown', target === stateDir ? ['-R', 'xpanel:xpanel', target] : ['xpanel:xpanel', target], { encoding: 'utf8' })
    if (result.status !== 0 && target === stateDir) {
      process.stderr.write(`state ownership repair failed: ${result.stderr || result.error?.message || 'chown failed'}\n`)
      return result.status ?? 1
    }
  }
  process.stdout.write(`state ownership repaired for ${stateDir}\n`)
  return 0
}

/** The canonical help renderer has no database or state capability to acquire. */
const runCliHelp = (args: readonly string[]) => runCli(args, {
  get db(): never { return fail('PRECONDITION_FAILED', 'help cannot access the control database') },
  get store(): never { return fail('PRECONDITION_FAILED', 'help cannot access desired state') },
  stdout: line => process.stdout.write(`${line}\n`),
  stderr: line => process.stderr.write(`${line}\n`),
})

const cliLifecycleQuarantined = async (): Promise<{ managed: boolean; quarantined: boolean }> => {
  try {
    const managed = await isLifecycleManaged()
    return { managed, quarantined: await readLifecycleBarrier() !== null }
  } catch { return { managed: true, quarantined: true } }
}

const printQuarantinedCliStatus = async (): Promise<number> => {
  let phase = 'unavailable'
  let reference: string | null = null
  try {
    const status = await readLifecyclePublicStatus()
    if (status.active && ['pending', 'retirement_pending', 'attention'].includes(String(status.phase))) phase = String(status.phase)
    if (typeof status.reference === 'string' && /^XP-JOB-(?:[0-9]{4}-)?[0-9]{6,16}$/.test(status.reference)) reference = status.reference
  } catch { /* Unsafe lifecycle evidence is attention, never normal panel status. */ }
  process.stdout.write(`Lifecycle status: ${phase}; reference=${reference ?? 'unissued'}. Normal panel startup requires a restart after the barrier is retired.\n`)
  return 6
}

const dropCliToXpanel = (args: readonly string[]): void => {
  const result = spawnSync('runuser', ['-u', 'xpanel', '--', process.execPath, process.argv[1] ?? '', ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error || result.status === null) {
    process.stderr.write(`refusing to write panel state as root: ${result.error?.message ?? 'runuser -u xpanel failed'}\n`)
    process.exit(1)
  }
  process.exit(result.status)
}

if (isMainModule()) {
  const args = process.argv.slice(2)
  const firstArg = args[0] === 'xpanel' ? args[1] : args[0]
  if (firstArg && CLI_VERBS.has(firstArg)) {
    const invocation = classifyCliInvocation({
      platform: process.platform,
      uid: process.getuid?.(),
      command: firstArg,
      serviceUid: xpanelServiceUid(),
    })
    if (invocation === 'refuse') {
      fail('FORBIDDEN', 'administrative commands must run as the xpanel service user. Root invocations are re-executed with runuser -u xpanel.')
    }
    const executeCli = async (): Promise<number> => {
      if (invocation === 'help') return (await runCliHelp(args)).code
      const defaultPaths = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
      if (invocation === 'repair-as-root') {
        return withLifecycleWriterAdmission(() => repairStateOwnership(process.env.XPANEL_STATE_DIR ?? `${defaultPaths}/state`, process.env.XPANEL_DB_PATH ?? `${defaultPaths}/control.db`))
      }
      if (invocation === 'drop-to-xpanel') dropCliToXpanel(args)
      // Keep CLI-created SQLite sidecars private to the same trusted daemon group.
      process.umask(0o007)
      const dbPath = process.env.XPANEL_DB_PATH ?? `${defaultPaths}/control.db`
      const stateDir = process.env.XPANEL_STATE_DIR ?? `${defaultPaths}/state`
      const lifecycle = await cliLifecycleQuarantined()
      if (firstArg === 'status' && lifecycle.quarantined) return printQuarantinedCliStatus()
      return withLifecycleWriterAdmission(async () => {
        const dbHandle = createDb(dbPath, lifecycle.managed ? { durability: 'strict' } : {})
        let client: ReturnType<typeof createAgentClient> | undefined
        try {
          await migrate(dbHandle.runner)
          await initializeOperationalMetadata(dbHandle.db)
          const requiresAgent = firstArg === 'reconcile' || firstArg === 'rollback'
          const agentToken = requiresAgent ? await loadAgentCredentialFile(process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token') : undefined
          if (agentToken) client = createAgentClient({ socketPath: process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken })
          return (await runCli(args, {
            db: dbHandle.db,
            store: new StateStore(stateDir),
            ...(client && agentToken ? { agentApp: client, agentToken } : {}),
            readPassword: readPasswordInput,
            stdout: line => process.stdout.write(`${line}\n`),
            stderr: line => process.stderr.write(`${line}\n`),
          })).code
        } finally {
          client?.close()
          await dbHandle.close()
        }
      })
    }
    executeCli()
      .then(code => { process.exitCode = code })
      .catch(error => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exitCode = 1
      })
  } else {
    startPanelEntrypoints()
      .then((srv) => {
        for (const entryPoint of ENTRY_POINT_ORDER) {
          const listener = srv.listeners[entryPoint]
          process.stdout.write(`${entryPoint}: private HTTP listener ${srv.host}:${listener.port}; public HTTPS ingress required at ${listener.publicOrigin}\n`)
        }
        const shutdown = () => {
          srv.close().finally(() => process.exit(0))
        }
        process.once('SIGINT', shutdown)
        process.once('SIGTERM', shutdown)
      })
      .catch((err) => {
        process.stderr.write(`xpanel-api fatal error: ${err instanceof Error ? err.message : String(err)}\n`)
        process.exit(1)
      })
  }
}

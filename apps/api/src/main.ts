import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Socket } from 'node:net'
import { fileURLToPath } from 'node:url'
import { loadAgentCredentialFile } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { canSeeAccount, fail, hasAcl } from '@xpanel/core'
import { visibleNavigation } from '@xpanel/catalog'
import type { VisibilityContext } from '@xpanel/catalog'
import { publicContactEmail } from '../../web/src/display-name.ts'
import type { OsProfile } from '@xpanel/core'
import { createDb, latestActive, migrate, type Db } from '@xpanel/db'
import { detectOs } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { runCli } from './cli.ts'
import { createApiApp, ensureRootPrincipal, listenApiServer } from './server.ts'
import { authenticateRequest } from './auth.ts'
import { createAgentClient } from './agent-client.ts'
import { ENTRY_POINTS, entryPointAllowsRole, type EntryPoint } from './entry-points.ts'

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

const detectHostOsProfile = async (): Promise<OsProfile> => {
  return detectOs((p) => readFileSync(p, 'utf8'))
}

/**
 * Loads `serveWebUi` from `@xpanel/web` dynamically so visiting `/`, `/login`, `/whm`, `/panel`, `/mail`
 * renders the full bilingual HTML5 UI hydrated with live state from `StateStore` and `Db` when available.
 */
const WORKSPACE_HOME: Record<EntryPoint, string> = { xpanel: '/home', xwhm: '/whm', xmail: '/mail/inbox' }

const isWorkspaceHome = (route: { surface: string; activeRoute: string }): boolean =>
  WORKSPACE_HOME[route.surface as EntryPoint] === route.activeRoute

const suggestedPanel = (pathname: string, current?: EntryPoint): EntryPoint | undefined => {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
  const guess: EntryPoint | undefined = path === '/whm' || path.startsWith('/whm/') ? 'xwhm'
    : path === '/mail' || path.startsWith('/mail/') ? 'xmail'
    : path === '/panel' || path.startsWith('/panel/') ? 'xpanel'
    : undefined
  return guess && guess !== current ? guess : undefined
}

export const createDefaultWebRenderer = async (deps: {
  store: StateStore
  db: Db
  serverSecret: string
  entryPoint?: EntryPoint
  /** Exact public origins. Missing origins are not linked. */
  panels?: Partial<Record<EntryPoint, string>>
}): Promise<(req: Request) => Promise<Response> | Response> => {
  const { serveWebUi, resolveWebDocumentRoute } = await import('../../web/src/index.ts')
  const panelLinks = (['xpanel', 'xwhm', 'xmail'] as const).flatMap(surface => {
    const origin = deps.panels?.[surface]
    if (!origin) return []
    try {
      const url = new URL(origin)
      if (url.protocol !== 'https:' || url.origin !== origin) return []
      return [{ surface, origin: url.origin }]
    } catch {
      return []
    }
  })
  return async (req) => {
    const url = new URL(req.url)
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    let resolvedContact: string | undefined | null = null
    const supportEmail = async (): Promise<string | undefined> => {
      if (resolvedContact !== null) return resolvedContact || undefined
      try {
        resolvedContact = publicContactEmail((await deps.store.getServerSettings())?.adminEmail) ?? ''
      } catch {
        resolvedContact = ''
      }
      return resolvedContact || undefined
    }
    const documentStatus = async (
      status: 403 | 404,
      model: {
        surface: EntryPoint
        visibility?: VisibilityContext
        accountId?: string
        workspaceHref?: string
        suggested?: EntryPoint
      },
    ) => {
      const email = await supportEmail()
      return serveWebUi(req, async () => ({
        surface: model.surface,
        activeRoute: url.pathname,
        ...(model.visibility ? { visibility: model.visibility } : {}),
        ...(model.accountId ? { accountId: model.accountId } : {}),
        ...(email ? { supportEmail: email } : {}),
        ...(panelLinks.length ? { panels: panelLinks } : {}),
        error: {
          status,
          surface: model.surface,
          ...(model.workspaceHref ? { workspaceHref: model.workspaceHref } : {}),
          ...(model.suggested ? { suggested: model.suggested } : {}),
        },
      }))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers })
    if (url.pathname === '/favicon.ico' || url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
      return serveWebUi(req)
    }
    if (url.pathname === '/login') {
      const email = await supportEmail()
      return serveWebUi(req, async () => ({
        surface: 'login',
        ...(email ? { supportEmail: email } : {}),
        ...(panelLinks.length ? { panels: panelLinks } : {}),
        login: {
          ...(deps.entryPoint ? { audience: deps.entryPoint, targetSurface: deps.entryPoint } : {}),
          ...(email ? { supportEmail: email } : {}),
          ...(panelLinks.length ? { panels: panelLinks } : {}),
        },
      }))
    }
    const documentRoute = resolveWebDocumentRoute(url.pathname)
    if (!documentRoute) {
      return documentStatus(404, {
        surface: deps.entryPoint ?? 'xpanel',
        ...(suggestedPanel(url.pathname, deps.entryPoint) ? { suggested: suggestedPanel(url.pathname, deps.entryPoint) } : {}),
      })
    }
    // The listener, never a query parameter or a forwarded header, chooses its HTML surface.
    if (deps.entryPoint && url.pathname !== '/' && documentRoute.surface !== deps.entryPoint) {
      const suggested = documentRoute.surface !== 'login' && documentRoute.surface !== deps.entryPoint ? documentRoute.surface : suggestedPanel(url.pathname, deps.entryPoint)
      return documentStatus(404, {
        surface: deps.entryPoint,
        ...(suggested ? { suggested } : {}),
      })
    }

    // Browser documents require a session; a scoped API token cannot expose an unscoped HTML snapshot.
    const caller = await authenticateRequest(deps.db, req, {
      serverSecret: deps.serverSecret, clientIp: null,
      ...(deps.entryPoint ? { entryPoint: deps.entryPoint } : {}),
    })
    if (!caller || !caller.mfaVerified || caller.apiTokenId !== null || caller.principalRecord.forcePasswordChange) {
      return new Response(null, { status: 303, headers: { ...headers, location: '/login' } })
    }
    const principal = caller.principal
    const roleHome: EntryPoint | undefined = principal.kind === 'user' ? 'xpanel' : 'xwhm'
    const wrongRole = (deps.entryPoint && !entryPointAllowsRole(deps.entryPoint, principal.kind))
      || (documentRoute.surface === 'xwhm' && principal.kind === 'user')
    if (wrongRole && documentRoute.surface !== 'login') {
      const deniedSurface: EntryPoint = documentRoute.surface === 'xwhm' || documentRoute.surface === 'xmail' ? documentRoute.surface : 'xpanel'
      return documentStatus(403, {
        surface: deps.entryPoint ?? deniedSurface,
        visibility: { principal, disabledFeatures: new Set() },
        ...(roleHome !== (deps.entryPoint ?? deniedSurface) ? { suggested: roleHome } : {}),
      })
    }
    if (principal.kind === 'root' && !caller.principalRecord.totpEnabled && process.env.XPANEL_ALLOW_PASSWORD_ONLY_ROOT !== '1') {
      return new Response('Multi-factor enrollment is required.', { status: 403, headers })
    }
    const surface: EntryPoint = documentRoute.surface === 'xwhm' || documentRoute.surface === 'xmail' ? documentRoute.surface : 'xpanel'
    if (url.pathname === '/') {
      const target = new URL(deps.entryPoint ? ENTRY_POINTS[deps.entryPoint].home : principal.kind === 'user' ? '/panel' : '/whm', url)
      for (const key of ['lang', 'theme', 'density', 'accountId']) if (url.searchParams.has(key)) target.searchParams.set(key, url.searchParams.get(key)!)
      return new Response(null, { status: 303, headers: { ...headers, location: `${target.pathname}${target.search}` } })
    }
    const reseller = principal.kind === 'reseller' ? (await deps.store.getReseller(principal.id)) ?? undefined : undefined
    const requiredAcl = surface === 'xmail' ? 'edit-account' : 'list-accounts'
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
    }
    const qualifiedRoute = visibleNavigation(scopedVisibility).some(item => item.surface === surface
      && item.sections.some(section => section.pages.some(page => page.route === documentRoute.activeRoute)))
    if (!qualifiedRoute) {
      if (!isWorkspaceHome(documentRoute)) {
        return documentStatus(404, {
          surface,
          visibility: scopedVisibility,
          ...(ownAccountId ? { accountId: ownAccountId } : {}),
          workspaceHref: ENTRY_POINTS[surface].home,
        })
      }
      const email = await supportEmail()
      const summaryAccount = principal.kind === 'user' && surface === 'xpanel' ? scoped?.account : null
      const summaryPlan = summaryAccount ? scoped?.plan : null
      return serveWebUi(req, async () => ({
        surface,
        visibility: scopedVisibility,
        ...(ownAccountId ? { accountId: ownAccountId } : {}),
        ...(email ? { supportEmail: email } : {}),
        ...(panelLinks.length ? { panels: panelLinks } : {}),
        workspaceSummary: {
          ...(summaryAccount ? { account: { id: summaryAccount.id, ownerId: summaryAccount.ownerId, username: summaryAccount.username,
            primaryDomain: summaryAccount.primaryDomain, status: summaryAccount.status, planId: summaryAccount.planId } } : {}),
          ...(summaryPlan ? { plan: { id: summaryPlan.id, name: summaryPlan.name } } : {}),
        },
      }))
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
    const listedPlanIds = new Set(listedAccounts.map((a) => a.planId))
    const visiblePlans = snap.plans.filter((p) => principal.kind === 'root' || p.ownerId === principal.id || listedPlanIds.has(p.id))
    const visibleResellers = snap.resellers.filter((r) => principal.kind === 'root' || r.id === principal.id)
    const visibleIpPool = principal.kind === 'root' ? snap.ipPool ?? [] : []
    const visibleFirewall = principal.kind === 'root' ? snap.firewall.rules : []
    const accountDomains = snap.domains.filter((d) => d.accountId === account?.id)
    const accountDatabases = snap.databases.filter((d) => d.accountId === account?.id)
    const accountServiceUsers = snap.serviceUsers.filter((u) => u.accountId === account?.id).map((u) => ({ ...u, passwordHash: '' }))
    const active = await latestActive(deps.db)
    return serveWebUi(req, async () => ({
      surface,
      ...(url.searchParams.has('accountId') && account ? { accountId: account.id } : {}),
      visibility,
      ...(active ? { generationId: active.id } : {}),
      whm: {
        principal,
        activeReseller: reseller ?? null,
        accounts: listedAccounts,
        plans: visiblePlans,
        resellers: visibleResellers,
        ipPool: visibleIpPool,
        firewallRules: visibleFirewall,
        ...(principal.kind === 'root' && snap.server ? { hostname: snap.server.settings.hostname } : {}),
      },
      panel: {
        ...(account ? { account } : {}),
        ...(plan ? { plan } : {}),
        domains: accountDomains,
        databases: accountDatabases,
        serviceUsers: accountServiceUsers,
        files: [],
      },
      mail: { mailbox: '', domain: '', messages: [], sieveRules: [], quotaUsedMb: 0 },
    }))
  }
}

/**
 * Starts the `xpanel-api` HTTP + WebSocket server with integrated Web UI renderer (`@xpanel/web`).
 */
export const startPanelServer = async (opts: PanelServerOptions = {}) => {
  const port = opts.port ?? (Number(process.env.XPANEL_PORT ?? '2087') || 2087)
  const host = opts.host ?? process.env.XPANEL_HOST ?? '127.0.0.1'
  const defaultBaseDir = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
  const dbPath = opts.dbPath ?? process.env.XPANEL_DB_PATH ?? `${defaultBaseDir}/control.db`
  const stateDir = opts.stateDir ?? process.env.XPANEL_STATE_DIR ?? `${defaultBaseDir}/state`
  if (!opts.agentApp && (process.platform !== 'linux' || process.getuid?.() === 0)) {
    fail('PRECONDITION_FAILED', 'the API must run as an unprivileged Linux service with a separate agent')
  }
  const serverSecret = opts.serverSecret ?? await loadAgentCredentialFile(opts.serverSecretFile ?? process.env.XPANEL_SERVER_SECRET_FILE ?? '/etc/xpanel/server.secret')
  const agentToken = opts.agentToken ?? await loadAgentCredentialFile(opts.agentTokenFile ?? process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token')
  const os = opts.os ?? await detectHostOsProfile()

  if (dbPath !== ':memory:') {
    await mkdir(dirname(dbPath), { recursive: true })
  }
  await mkdir(stateDir, { recursive: true })

  const dbHandle = createDb(dbPath)
  let client: ReturnType<typeof createAgentClient> | undefined
  try {
    await migrate(dbHandle.runner)
    const store = new StateStore(stateDir)
    await ensureRootPrincipal(dbHandle.db, { ...(opts.rootPassword ? { password: opts.rootPassword } : {}) })
    if (!opts.agentApp) client = createAgentClient({ socketPath: opts.agentSocket ?? process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken })
    const agentApp = opts.agentApp ?? client!
    const webRenderer = opts.webRenderer ?? await createDefaultWebRenderer({ store, db: dbHandle.db, serverSecret })
    const app = createApiApp({
      db: dbHandle.db, store, agentApp, agentToken, os, webRenderer, serverSecret,
      secureCookies: !opts.agentApp,
      allowedOrigins: opts.allowedOrigins ?? (process.env.XPANEL_ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? []),
      trustedProxyAddresses: opts.trustedProxyAddresses ?? (process.env.XPANEL_TRUSTED_PROXIES?.split(',').filter(Boolean) ?? []),
      ...(opts.homeBaseDir ? { homeBaseDir: opts.homeBaseDir } : {}),
    })
    const listener = await listenApiServer(app, { port, host })
    return {
      app, port: listener.port, host, db: dbHandle.db, store,
      close: async () => { client?.close(); await listener.close(); await dbHandle.close() },
    }
  } catch (error) {
    client?.close()
    await dbHandle.close()
    throw error
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
  return { host, entryPoints: Object.freeze(entryPoints) }
}

/**
 * One unprivileged process owns one SQLite handle, state store and agent client.
 * Three immutable applications listen privately behind independent HTTPS ingress servers.
 * Public TLS is terminated by the configured ingress, never by these HTTP listeners.
 */
export const startPanelEntrypoints = async (opts: PanelEntrypointsOptions = {}) => {
  const { host, entryPoints } = resolvePanelEntrypoints(opts)
  if (!opts.agentApp && ENTRY_POINT_ORDER.some(name => entryPoints[name].port !== ENTRY_POINT_ENV[name].defaultPort)) {
    fail('PRECONDITION_FAILED', 'production entrypoint listeners must use reserved ports 12083, 12087 and 12096')
  }
  if (!opts.agentApp && (process.platform !== 'linux' || process.getuid?.() === 0)) {
    fail('PRECONDITION_FAILED', 'the API must run as an unprivileged Linux service with a separate agent')
  }
  const serverSecret = opts.serverSecret ?? await loadAgentCredentialFile(opts.serverSecretFile ?? process.env.XPANEL_SERVER_SECRET_FILE ?? '/etc/xpanel/server.secret')
  const agentToken = opts.agentToken ?? await loadAgentCredentialFile(opts.agentTokenFile ?? process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token')
  const ingressSecret = opts.ingressSecret ?? await loadAgentCredentialFile(opts.ingressSecretFile ?? process.env.XPANEL_INGRESS_SECRET_FILE ?? '/etc/xpanel/ingress.secret')
  if (Buffer.byteLength(ingressSecret, 'utf8') < 32) fail('PRECONDITION_FAILED', 'a protected ingress credential of at least 32 bytes is required')
  const os = opts.os ?? await detectHostOsProfile()
  const defaultBaseDir = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
  const dbPath = opts.dbPath ?? process.env.XPANEL_DB_PATH ?? `${defaultBaseDir}/control.db`
  const stateDir = opts.stateDir ?? process.env.XPANEL_STATE_DIR ?? `${defaultBaseDir}/state`
  if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true })
  await mkdir(stateDir, { recursive: true })
  const dbHandle = createDb(dbPath)
  let client: ReturnType<typeof createAgentClient> | undefined
  const listeners: Awaited<ReturnType<typeof listenApiServer>>[] = []
  const agentSubscriptions: (() => void)[] = []
  const sockets = new Set<Socket>()
  let closePromise: Promise<void> | undefined
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      // HTTP closeAllConnections does not include upgraded WebSocket connections.
      for (const socket of sockets) socket.destroy()
      const listenerResults = await Promise.allSettled(listeners.map(listener => listener.close()))
      const subscriptionResults = await Promise.allSettled(agentSubscriptions.map(async unsubscribe => unsubscribe()))
      const clientResults = await Promise.allSettled([Promise.resolve().then(() => client?.close())])
      await dbHandle.close()
      const failed = [...listenerResults, ...subscriptionResults, ...clientResults].find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    return closePromise
  }
  try {
    await migrate(dbHandle.runner)
    const store = new StateStore(stateDir)
    await ensureRootPrincipal(dbHandle.db, { ...(opts.rootPassword ? { password: opts.rootPassword } : {}) })
    if (!opts.agentApp) client = createAgentClient({ socketPath: opts.agentSocket ?? process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken })
    const sharedAgent = opts.agentApp ?? client!
    const agentApp: AgentApp = {
      fetch: request => sharedAgent.fetch(request),
      subscribe: callback => {
        const unsubscribe = sharedAgent.subscribe(callback)
        agentSubscriptions.push(unsubscribe)
        return unsubscribe
      },
    }
    const apps = {} as Record<EntryPoint, ReturnType<typeof createApiApp>>
    for (const entryPoint of ENTRY_POINT_ORDER) {
      const config = entryPoints[entryPoint]
      const publicPanels = Object.fromEntries(ENTRY_POINT_ORDER.map(name => [name, entryPoints[name].publicOrigin])) as Record<EntryPoint, string>
      const webRenderer = await createDefaultWebRenderer({ store, db: dbHandle.db, serverSecret, entryPoint, panels: publicPanels })
      const app = createApiApp({
        db: dbHandle.db, store, agentApp, agentToken, os, serverSecret, webRenderer,
        entryPoint, publicOrigin: config.publicOrigin, publicPanels, allowedOrigins: [config.publicOrigin],
        ingressSecret, requireSecureCookies: true, requireOriginHeader: true,
        ...(opts.homeBaseDir ? { homeBaseDir: opts.homeBaseDir } : {}),
      })
      apps[entryPoint] = app
      const listener = await listenApiServer(app, { port: config.port, host })
      listener.server.on('connection', socket => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      listeners.push(listener)
    }
    return {
      apps: Object.freeze(apps), host, entryPoints, db: dbHandle.db, store,
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

const CLI_VERBS = new Set(['status', 'reconcile', 'rollback', 'reindex', 'init-root', 'reset-password', 'disable-2fa', 'help', '--help', '-h'])

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

if (isMainModule()) {
  const args = process.argv.slice(2)
  const firstArg = args[0] === 'xpanel' ? args[1] : args[0]
  if (firstArg && CLI_VERBS.has(firstArg)) {
    if (process.platform === 'linux' && process.getuid?.() !== 0 && !['status', 'help', '--help', '-h'].includes(firstArg)) {
      fail('FORBIDDEN', 'local administrative commands require the operating-system root user')
    }
    // Keep CLI-created SQLite sidecars private to the same trusted daemon group.
    process.umask(0o007)
    const defaultBaseDir = process.platform === 'linux' ? '/var/lib/xpanel' : '.xpanel-data'
    const dbPath = process.env.XPANEL_DB_PATH ?? `${defaultBaseDir}/control.db`
    const stateDir = process.env.XPANEL_STATE_DIR ?? `${defaultBaseDir}/state`
    const dbHandle = createDb(dbPath)
    let client: ReturnType<typeof createAgentClient> | undefined
    migrate(dbHandle.runner)
      .then(async () => {
        const requiresAgent = firstArg === 'reconcile' || firstArg === 'rollback'
        const agentToken = requiresAgent ? await loadAgentCredentialFile(process.env.XPANEL_AGENT_TOKEN_FILE ?? '/etc/xpanel/agent.token') : undefined
        if (agentToken) client = createAgentClient({ socketPath: process.env.XPANEL_AGENT_SOCKET ?? '/run/xpanel/agent.sock', token: agentToken })
        return runCli(args, {
          db: dbHandle.db,
          store: new StateStore(stateDir),
          ...(client && agentToken ? { agentApp: client, agentToken } : {}),
          readPassword: readPasswordInput,
          stdout: (line) => process.stdout.write(`${line}\n`),
          stderr: (line) => process.stderr.write(`${line}\n`),
        })
      })
      .then(async (res) => {
        client?.close()
        await dbHandle.close()
        process.exit(res.code)
      })
      .catch(async (err) => {
        client?.close()
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
        await dbHandle.close()
        process.exit(1)
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

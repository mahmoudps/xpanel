import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAgentCredentialFile } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { canSeeAccount, fail, hasAcl } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { createDb, latestActive, migrate, type Db } from '@xpanel/db'
import { detectOs } from '@xpanel/os'
import { StateStore } from '@xpanel/state'
import { runCli } from './cli.ts'
import { createApiApp, ensureRootPrincipal, listenApiServer } from './server.ts'
import { authenticateRequest } from './auth.ts'
import { createAgentClient } from './agent-client.ts'

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
export const createDefaultWebRenderer = async (deps: {
  store: StateStore
  db: Db
  serverSecret: string
}): Promise<(req: Request) => Promise<Response> | Response> => {
  const { serveWebUi, resolveWebDocumentRoute } = await import('../../web/src/index.ts')
  return async (req) => {
    const url = new URL(req.url)
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers })
    if (url.pathname === '/favicon.ico' || url.pathname === '/assets' || url.pathname.startsWith('/assets/')) {
      return serveWebUi(req)
    }
    if (url.pathname === '/login') return serveWebUi(req, async () => ({ surface: 'login' }))
    const documentRoute = resolveWebDocumentRoute(url.pathname)
    if (!documentRoute) {
      return new Response('Not Found', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } })
    }

    // Browser documents require a session; a scoped API token cannot expose an unscoped HTML snapshot.
    const caller = await authenticateRequest(deps.db, req, { serverSecret: deps.serverSecret, clientIp: null })
    if (!caller || !caller.mfaVerified || caller.apiTokenId !== null || caller.principalRecord.forcePasswordChange) {
      return new Response(null, { status: 303, headers: { ...headers, location: '/login' } })
    }
    const principal = caller.principal
    if (principal.kind === 'root' && !caller.principalRecord.totpEnabled && process.env.XPANEL_ALLOW_PASSWORD_ONLY_ROOT !== '1') {
      return new Response('Multi-factor enrollment is required.', { status: 403, headers })
    }
    const surface = documentRoute.surface
    if (surface === 'xwhm' && principal.kind === 'user') return new Response(null, { status: 403, headers })
    if (url.pathname === '/') {
      const target = new URL(principal.kind === 'user' ? '/panel' : '/whm', url)
      for (const key of ['lang', 'theme', 'density', 'accountId']) if (url.searchParams.has(key)) target.searchParams.set(key, url.searchParams.get(key)!)
      return new Response(null, { status: 303, headers: { ...headers, location: `${target.pathname}${target.search}` } })
    }
    const reseller = principal.kind === 'reseller' ? (await deps.store.getReseller(principal.id)) ?? undefined : undefined
    const requiredAcl = surface === 'xmail' ? 'edit-account' : 'list-accounts'
    if (principal.kind === 'reseller' && (!reseller || !hasAcl(principal, reseller, requiredAcl))) return new Response(null, { status: 403, headers })
    const snap = await deps.store.readSnapshot()
    const ownedAccounts = snap.accounts.filter((account) => canSeeAccount(principal, account))
    const accountId = url.searchParams.get('accountId')
    const account = accountId ? ownedAccounts.find((a) => a.id === accountId) : ownedAccounts[0]
    if (accountId && !account) return new Response(null, { status: 404, headers })
    if (principal.kind === 'user' && (!account || account.status !== 'active')) return new Response(null, { status: 403, headers })
    const plan = account ? snap.plans.find((p) => p.id === account.planId) : undefined
    const featureList = plan ? snap.featureLists.find((f) => f.id === plan.featureListId) : undefined
    if (principal.kind === 'user' && (!plan || !featureList)) return new Response(null, { status: 403, headers })
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
      activeRoute: documentRoute.activeRoute,
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
    startPanelServer()
      .then((srv) => {
        process.stdout.write(`xpanel-api listening on http://${srv.host}:${srv.port}\n`)
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

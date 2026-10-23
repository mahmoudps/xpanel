import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { groups, visibleTools, visibleNavigation } from '@xpanel/catalog'
import {
  fail,
  isXpanelError,
  isUuid,
  assertAcl,
  parseIp,
  canonicalIp,
  validateDomainCustomConfig,
  MANAGEMENT_PUBLIC_PORTS,
  validateUsername,
} from '@xpanel/core'
import type {
  Account,
  AuditEntry,
  DomainCustomConfig,
  ErrorCode,
  FeatureList,
  FirewallRule,
  Id,
  IoAnalyticsSnapshot,
  LiveEvent,
  LiveEventScope,
  MailIpConfig,
  OsProfile,
  PhpSettings,
  Reseller,
  ServerIpEntry,
  ServerSettings,
} from '@xpanel/core'
import {
  appendAudit,
  checkLockout,
  changePasswordForSession,
  clearLockout,
  consumeRecoveryHash,
  consumeTotpStep,
  completeTotpEnrollment,
  disableTotpForSession,
  createResellerPrincipal,
  createRootPrincipal,
  createAuthenticatedSession,
  createUpgrade,
  createUserPrincipal,
  deletePrincipal,
  findPrincipalByUsername,
  latestActive,
  listAudit,
  listGenerations,
  getPendingTotpEnrollment,
  startTotpEnrollment,
  recordLogin,
  recordLoginAttempt,
  reindexFromState,
  revokeSession,
  revokeAccountSessionsAndTokens,
  setPasswordHash,
  syncAccountContactIndex,
  searchIndex,
  recordLoginFailure,
} from '@xpanel/db'
import type { Db } from '@xpanel/db'
import {
  buildReview,
  countActiveTransfers,
  createTransferSession,
  preflight,
  reviewDigest,
  transition,
} from '@xpanel/lifecycle'
import type { LocalInventory, PreflightInput, TransferEvent, TransferSession } from '@xpanel/lifecycle'
import type {
  DnsZoneState,
  DomainPatch,
  FirewallGuard,
  NewAccount,
  NewDomain,
  NewFirewallRule,
  NewPlan,
  NewReseller,
  NewServiceUser,
  PlanPatch,
  ResellerPatch,
  ServiceUserPatch,
  StateStore,
} from '@xpanel/state'
import {
  authenticateRequest,
  clearSessionCookie,
  deriveCsrfToken,
  formatSessionCookie,
  generateTotpSecret,
  sealTotpSecret,
  sha256Hex,
  unsealTotpSecret,
  verifyPasswordArgon2id,
  verifyTotpStep,
  passwordHashFromInput,
} from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { createExtendedApiRouter } from './extended-routes.ts'
import { assertAccountAuthorized, assertAccountFeatures, assertApiScope, assertRequestAuthorized, requireDomainAccount, ownedAccounts } from './authorization.ts'
import { LiveEventHub } from './ws.ts'
import type { EventSubscriber } from './ws.ts'
import { renderWebApp } from '../../web/src/app.ts'
import { requestPrefersHtml } from '../../web/src/status-page.ts'
import { ENTRY_POINTS, entryPointAllowsApiRoute, entryPointAllowsRole, sessionTokenHash } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import { loadQualifiedCatalog } from './host-catalog.ts'
import { renderTotpQrSvg } from './totp-qr.ts'
import { createLocalMailboxTransport, establishMailboxSession, openMailboxSession, parseMailboxSend } from './mail/inbox.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { deleteMailboxSession } from '@xpanel/db'

// Public PHC fixture used only to equalize unknown-user password work; never an account credential.
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=65536,t=3,p=4$QkJCQkJCQkJCQkJCQkJCQg$02+8XtfLLaSCZqlfA84rmzJ5VytASY+ko8Y0KCBMjk8"

export const INGRESS_SECRET_HEADER = 'x-xpanel-ingress-secret'

export interface TransportContext {
  remoteAddress?: string
  trustedIngress?: boolean
  tls?: boolean
}

interface InternalTransportMeta {
  remoteAddress: string | null
  trustedIngress: boolean
  tls: boolean
}

const transportPeers = new WeakMap<Request, InternalTransportMeta>()
const trustedIngressRequests = new WeakSet<IncomingMessage>()

const defaultPhp = (version: PhpSettings['version'] = '8.3'): PhpSettings => ({
  version,
  handler: 'fpm',
  fpm: {
    mode: 'ondemand',
    maxChildren: 4,
    startServers: 2,
    minSpareServers: 1,
    maxSpareServers: 3,
    maxRequests: 500,
    processIdleTimeoutSec: 10,
  },
  ini: {},
})

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 422,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LIMIT_EXCEEDED: 422,
  OVERSELL_BLOCKED: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  SELF_LOCKOUT: 422,
  ENGINE_UNAVAILABLE: 422,
  UNSUPPORTED_OS: 422,
  CONFIG_TEST_FAILED: 422,
  PRECONDITION_FAILED: 412,
  SERVICE_UNAVAILABLE: 503,
}

const jsonResponse = (body: unknown, status = 200, extraHeaders?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  })

/**
 * Formats an RFC 7807 Problem Details response.
 * Never leaks internal `err.message` on 500 responses — always returns constant `"Internal server error"`.
 */
const problemResponse = (err: unknown, instance: string, method = ''): Response => {
  if (isXpanelError(err)) {
    const isLockedOut = err.detail.lockedOut === true
    const status = isLockedOut ? 429 : (STATUS_BY_CODE[err.code] ?? 400)
    const code = isLockedOut ? 'LOCKED_OUT' : err.code
    return new Response(
      JSON.stringify({
        type: `https://xpanel.dev/problems/${code.toLowerCase().replace(/_/g, '-')}`,
        title: code,
        status,
        detail: err.message,
        code,
        instance,
        ...(Object.keys(err.detail).length > 0 && { details: err.detail }),
      }),
      {
        status,
        headers: { 'content-type': 'application/problem+json; charset=utf-8' },
      },
    )
  }
  const stack = err instanceof Error ? err.stack ?? err.message : String(err)
  console.error(`[xpanel-api] unexpected error ${method || 'UNKNOWN'} ${instance}\n${stack}`)
  return new Response(
    JSON.stringify({
      type: 'https://xpanel.dev/problems/internal-error',
      title: 'INTERNAL_ERROR',
      status: 500,
      detail: 'Internal server error',
      code: 'INTERNAL_ERROR',
      instance,
      details: { stateChanged: false },
    }),
    {
      status: 500,
      headers: { 'content-type': 'application/problem+json; charset=utf-8' },
    },
  )
}

const transportProblem = (status: number, code: string, detail: string, instance: string): Response => new Response(JSON.stringify({ type: 'about:blank', title: code, status, code, detail, instance }), { status, headers: { 'content-type': 'application/problem+json; charset=utf-8' } })

export interface ApiServerDeps {
  entryPoint?: EntryPoint
  publicOrigin?: string
  db: Db
  store: StateStore
  agentApp?: AgentApp
  agentToken?: string
  serverSecret: string
  allowedOrigins?: readonly string[]
  trustedProxyAddresses?: readonly string[]
  ingressSecret?: string
  requireSecureCookies?: boolean
  requireOriginHeader?: boolean
  hub?: LiveEventHub
  os?: OsProfile
  secureCookies?: boolean
  lockoutThreshold?: number
  lockoutDurationMs?: number
  homeBaseDir?: string
  mailboxTransport?: MailboxTransport
  webRenderer?: (req: Request) => Promise<Response> | Response
  /** Exact HTTPS origins of the three panels, used by the misdirected-host page. */
  publicPanels?: Partial<Record<EntryPoint, string>>
}

export interface ApiApp {
  fetch(req: Request, context?: TransportContext): Promise<Response>
  hub: LiveEventHub
  authenticateUpgrade(req: IncomingMessage, context?: TransportContext): Promise<EventSubscriber | null>
}

const readJsonBody = async <T = Record<string, unknown>>(req: Request): Promise<T> => {
  if (req.body === null) return {} as T
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return fail('VALIDATION', 'request body must be valid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('VALIDATION', 'request body must be a JSON object')
  return body as T
}

const publicServiceUser = <T extends object>(user: T): Omit<T, 'passwordHash'> => {
  const safe = { ...user } as T & { passwordHash?: unknown }
  delete safe.passwordHash
  return safe
}

const normalizedIp = (ip: string): string => parseIp(ip) ? canonicalIp(ip).address : ip

const isLocalProxyAddress = (address: string): boolean => {
  const parsed = parseIp(address)
  if (!parsed || parsed.value === 0n || (parsed.version === 4 && parsed.value >> 24n === 127n) || (parsed.version === 6 && parsed.value === 1n)) return true
  return Object.values(networkInterfaces()).some(entries => entries?.some(entry => {
    const local = parseIp(entry.address)
    return local?.version === parsed.version && local.value === parsed.value
  }))
}

export const createApiApp = (deps: ApiServerDeps): ApiApp => {
  // Copy the profile: mutating the caller's dependency object cannot retarget a running listener.
  const entryPoint = deps.entryPoint
  if (entryPoint !== undefined && !Object.hasOwn(ENTRY_POINTS, entryPoint)) return fail('PRECONDITION_FAILED', 'invalid entry point')
  const publicOrigin = deps.publicOrigin
  if (publicOrigin !== undefined) {
    const parsed = new URL(publicOrigin)
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) return fail('PRECONDITION_FAILED', 'publicOrigin must be an exact HTTPS origin')
  }
  const serverSecret = deps.serverSecret
  if (typeof serverSecret !== 'string' || Buffer.byteLength(serverSecret, 'utf8') < 32) fail('PRECONDITION_FAILED', 'a protected server secret of at least 32 bytes is required')
  const ingressSecret = deps.ingressSecret
  if (ingressSecret !== undefined && (typeof ingressSecret !== 'string' || Buffer.byteLength(ingressSecret, 'utf8') < 32)) {
    return fail('PRECONDITION_FAILED', 'a protected ingressSecret of at least 32 bytes is required when configured')
  }
  const trustedProxies = new Set((deps.trustedProxyAddresses ?? []).map(normalizedIp))
  if ([...trustedProxies].some(isLocalProxyAddress)) return fail('PRECONDITION_FAILED', 'trusted proxies must be remote dedicated hosts; local proxy trust requires protected ingress')
  const allowedOrigins = new Set(deps.allowedOrigins ?? [])
  if (entryPoint && allowedOrigins.size !== 1) return fail('PRECONDITION_FAILED', 'interactive entry points require one exact allowed origin')
  if (entryPoint && [...allowedOrigins].some(origin => { try { const url = new URL(origin); return url.protocol !== 'https:' || url.origin !== origin } catch { return true } })) return fail('PRECONDITION_FAILED', 'interactive origins must be exact HTTPS origins')
  if (publicOrigin && !allowedOrigins.has(publicOrigin)) return fail('PRECONDITION_FAILED', 'publicOrigin must match the configured allowed origin')
  const publicPanels: Partial<Record<EntryPoint, string>> = {}
  for (const name of ['xpanel', 'xwhm', 'xmail'] as const) {
    const origin = deps.publicPanels?.[name]
    if (origin === undefined) continue
    let parsed: URL
    try { parsed = new URL(origin) } catch { return fail('PRECONDITION_FAILED', 'public panel origins must be exact HTTPS origins') }
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password || parsed.hash) {
      return fail('PRECONDITION_FAILED', 'public panel origins must be exact HTTPS origins')
    }
    publicPanels[name] = parsed.origin
  }
  const panelLinks = (['xpanel', 'xwhm', 'xmail'] as const).flatMap(surface => {
    const origin = publicPanels[surface]
    return origin ? [{ surface, origin }] : []
  })
  const prefersDocumentHtml = (request: Request, pathname: string, method: string): boolean =>
    (method === 'GET' || method === 'HEAD') && !pathname.startsWith('/api/') && requestPrefersHtml(request)
  const renderTransportStatus = (request: Request, status: 421 | 500 | 503): Response => {
    const pageUrl = new URL(request.url, 'http://localhost')
    const locale = pageUrl.searchParams.get('lang') === 'ar' ? 'ar' as const : 'en' as const
    const theme = pageUrl.searchParams.get('theme') === 'dark' ? 'dark' as const : 'light' as const
    const density = pageUrl.searchParams.get('density') === 'compact' ? 'compact' as const : 'comfortable' as const
    const html = renderWebApp({
      surface: 'xpanel',
      locale,
      theme,
      density,
      activeRoute: pageUrl.pathname,
      ...(panelLinks.length ? { panels: panelLinks } : {}),
      error: {
        status,
        surface: 'xpanel',
        ...(status === 500 || status === 503 ? { retryHref: `${pageUrl.pathname}${pageUrl.search}` } : {}),
      },
    })
    return new Response(html, {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
      },
    })
  }

  const hasValidIngressSecret = (req: Request): boolean => {
    if (!ingressSecret) return false
    const supplied = req.headers.get(INGRESS_SECRET_HEADER)
    if (typeof supplied !== 'string' || supplied.length === 0) return false
    const expectedBuf = Buffer.from(ingressSecret, 'utf8')
    const actualBuf = Buffer.from(supplied, 'utf8')
    return expectedBuf.byteLength === actualBuf.byteLength && timingSafeEqual(expectedBuf, actualBuf)
  }

  const isTrustedProxySource = (req: Request): boolean => {
    const meta = transportPeers.get(req)
    const suppliedSecret = req.headers.get(INGRESS_SECRET_HEADER)
    if (ingressSecret) {
      if (suppliedSecret !== null && !hasValidIngressSecret(req)) {
        return fail('UNAUTHENTICATED', 'invalid ingress authentication credential')
      }
      if (hasValidIngressSecret(req)) return true
      if (meta?.trustedIngress) {
        return fail('UNAUTHENTICATED', 'missing ingress authentication credential')
      }
    } else if (meta?.trustedIngress) {
      return true
    }
    const current = meta?.remoteAddress ?? null
    if (!current || !trustedProxies.has(current) || isLocalProxyAddress(current)) return false
    return true
  }

  const extractClientIp = (req: Request): string | null => {
    const meta = transportPeers.get(req)
    const current = meta?.remoteAddress ?? null
    if (!isTrustedProxySource(req)) return current
    const protoHeader = req.headers.get('x-forwarded-proto')?.trim().toLowerCase()
    if (protoHeader !== undefined && protoHeader !== '' && protoHeader !== 'https' && protoHeader !== 'http') {
      return fail('UNAUTHENTICATED', 'invalid forwarded protocol')
    }
    const rawForwarded = req.headers.get('x-forwarded-for')
    const chain = rawForwarded !== null ? rawForwarded.split(',').map(value => normalizedIp(value.trim())) : []
    if (chain.length > 1 || chain.some(value => !parseIp(value))) return fail('UNAUTHENTICATED', 'invalid forwarded client identity')
    if (chain.length === 0) {
      const realIp = req.headers.get('x-real-ip')?.trim()
      if (!realIp || !parseIp(realIp)) return fail('UNAUTHENTICATED', 'trusted proxy must supply a valid client identity')
      return normalizedIp(realIp)
    }
    return chain[0]!
  }

  const isVerifiedHttps = (req: Request): boolean => {
    const meta = transportPeers.get(req)
    if (meta?.tls) return true
    if (!isTrustedProxySource(req)) return false
    return req.headers.get('x-forwarded-proto')?.trim().toLowerCase() === 'https'
  }

  const useSecureCookies = (req: Request): boolean =>
    Boolean(deps.secureCookies || deps.requireSecureCookies || isVerifiedHttps(req))

  const isOriginPermitted = (origin: string, req: Request): boolean => {
    if (allowedOrigins.size > 0) return allowedOrigins.has(origin)
    try {
      const reqUrl = new URL(req.url, 'http://localhost')
      if (origin === reqUrl.origin) return true
      if (useSecureCookies(req) && origin === `https://${reqUrl.host}`) return true
      return false
    } catch {
      return false
    }
  }

  const hub = deps.hub ?? new LiveEventHub()
  const lockoutThreshold = deps.lockoutThreshold ?? 5
  const lockoutDurationMs = deps.lockoutDurationMs ?? 15 * 60_000

  if (deps.agentApp) {
    deps.agentApp.subscribe((event) => {
      hub.broadcast(event)
    })
  }

  const transferSessions = new Map<string, TransferSession>()

  const emitAudit = async (
    input: {
      actor: string
      action: string
      target: string
      detail?: Record<string, unknown>
      outcome: 'ok' | 'denied' | 'failed'
      principalId?: Id | null
      ip?: string | null
    },
    scope: LiveEventScope = { accountId: null, resellerId: null },
  ): Promise<AuditEntry> => {
    const entry = await appendAudit(deps.db, input)
    const event: LiveEvent = {
      id: randomUUID(),
      at: entry.at,
      kind: 'audit.entry',
      scope,
      data: entry,
    }
    hub.broadcast(event)
    return entry
  }

  const resolveResellerForCaller = async (caller: AuthenticatedCaller): Promise<Reseller | null> => {
    if (caller.principal.kind !== 'reseller') return null
    return deps.store.getReseller(caller.principal.id)
  }

  const resolveResellerId = async (caller: AuthenticatedCaller): Promise<Id | null> => {
    if (caller.principal.kind !== 'reseller') return null
    const r = await resolveResellerForCaller(caller)
    return r?.id ?? null
  }

  const buildSubscriberForCaller = async (caller: AuthenticatedCaller): Promise<EventSubscriber> => {
    if (caller.principal.kind === 'root') {
      return { kind: 'root', id: caller.principal.id, username: caller.principal.username }
    }
    if (caller.principal.kind === 'reseller') {
      const resellerId = (await resolveResellerId(caller)) ?? caller.principal.id
      const owned = await deps.store.listAccounts({ ownerId: resellerId })
      return {
        kind: 'reseller',
        id: resellerId,
        username: caller.principal.username,
        ownedAccountIds: new Set(owned.filter((a) => a.status === 'active').map((a) => a.id)),
      }
    }
    const account = await deps.store.getAccount(caller.principal.accountId, { username: caller.principal.username })
    if (!account || account.status !== 'active') {
      return fail('FORBIDDEN', 'hosting account is suspended or terminating')
    }
    return {
      kind: 'user',
      id: caller.principal.id,
      username: caller.principal.username,
      accountId: caller.principal.accountId,
    }
  }

  const authenticateUpgrade = async (req: IncomingMessage, context?: TransportContext): Promise<EventSubscriber | null> => {
    if (entryPoint === 'xmail') return null
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v)
      else if (Array.isArray(v)) headers.set(k, v.join(', '))
    }
    const webReq = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers })
    if (publicOrigin && new URL(webReq.url).host !== new URL(publicOrigin).host) return null
    const peer = context?.remoteAddress ?? req.socket?.remoteAddress
    const trustedIngress = Boolean(context?.trustedIngress || trustedIngressRequests.has(req))
    const tls = Boolean(context?.tls || ('encrypted' in (req.socket ?? {}) && (req.socket as { encrypted?: boolean }).encrypted))
    transportPeers.set(webReq, {
      remoteAddress: peer ? normalizedIp(peer) : null,
      trustedIngress,
      tls,
    })
    const origin = headers.get('origin')
    if (origin ? !allowedOrigins.has(origin) : !headers.has('authorization')) return null
    try {
      if (deps.requireSecureCookies && !isVerifiedHttps(webReq) && (entryPoint || (!deps.secureCookies && !headers.has('authorization')))) {
        return null
      }
      const caller = await authenticateRequest(deps.db, webReq, { serverSecret, clientIp: extractClientIp(webReq), touchSession: false, entryPoint })
      if (!caller || !caller.mfaVerified) return null
      if (caller.apiTokenId !== null) assertApiScope(caller, 'events:read')
      await assertRequestAuthorized(deps.store, caller, new Request(new URL('/api/events/recent', webReq.url), { headers }))
      return buildSubscriberForCaller(caller)
    } catch {
      return null
    }
  }

  const requireCaller = async (req: Request, opts?: { allowUnverifiedMfa?: boolean }): Promise<AuthenticatedCaller> => {
    const clientIp = extractClientIp(req)
    const caller = await authenticateRequest(deps.db, req, { serverSecret, clientIp, entryPoint })
    if (!caller) {
      return fail('UNAUTHENTICATED', 'authentication required')
    }
    if (
      deps.requireSecureCookies &&
      !deps.secureCookies &&
      !isVerifiedHttps(req) &&
      caller.sessionId !== null &&
      caller.apiTokenId === null
    ) {
      return fail('FORBIDDEN', 'HTTPS ingress is required for session cookie authentication')
    }
    if (!opts?.allowUnverifiedMfa && !caller.mfaVerified) {
      return fail('FORBIDDEN', 'two-factor authentication verification required')
    }
    const method = req.method.toUpperCase()
    if (
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') &&
      caller.sessionId !== null &&
      caller.apiTokenId === null
    ) {
      const origin = req.headers.get('origin')?.trim() ?? null
      const secFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
      if (
        (origin !== null && !isOriginPermitted(origin, req)) ||
        (origin === null && (secFetchSite === 'cross-site' || deps.requireOriginHeader === true))
      ) {
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.origin_rejected',
          target: new URL(req.url, 'http://localhost').pathname,
          detail: { origin, secFetchSite },
          outcome: 'denied',
          principalId: caller.principal.id,
          ip: clientIp,
        })
        return fail('FORBIDDEN', 'cross-origin state-changing request rejected')
      }
      if (!caller.csrfValid) {
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.csrf_rejected',
          target: new URL(req.url, 'http://localhost').pathname,
          outcome: 'denied',
          principalId: caller.principal.id,
          ip: clientIp,
        })
        return fail('FORBIDDEN', 'invalid or missing CSRF token (x-csrf-token)')
      }
    }
    await assertRequestAuthorized(deps.store, caller, req)
    return caller
  }

  const assertRoot = async (caller: AuthenticatedCaller, action: string): Promise<void> => {
    if (caller.principal.kind !== 'root') {
      await emitAudit({
        actor: caller.principal.username,
        action: 'rbac.denied',
        target: action,
        detail: { requiredRole: 'root', actualRole: caller.principal.kind },
        outcome: 'denied',
        principalId: caller.principal.id,
      })
      return fail('FORBIDDEN', 'root role is required for this operation')
    }
  }

  const assertCanAccessAccount = async (
    caller: AuthenticatedCaller,
    account: Account,
    action: string,
    opts?: { allowUserSelf?: boolean },
  ): Promise<void> => {
    await assertAccountAuthorized(deps.store, caller, account, action, opts?.allowUserSelf ?? true)
  }

  const assertCanBindCertificate = async (caller: AuthenticatedCaller, account: Account): Promise<void> => {
    if (caller.apiTokenId !== null) assertApiScope(caller, 'tls:write')
    if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'manage-ssl')
    await assertAccountFeatures(deps.store, caller, account, ['ssl-install'])
  }

  const resolveAccountParam = async (idOrUsername: string): Promise<Account> => {
    const byId = await deps.store.getAccount(idOrUsername)
    if (byId) return byId
    const byUsername = await deps.store.getAccountByUsername(idOrUsername.toLowerCase())
    if (byUsername) return byUsername
    return fail('NOT_FOUND', `account "${idOrUsername}" not found`)
  }

  const callAgent = async (
    pathAndQuery: string,
    opts: {
      method?: string
      body?: unknown
      caller: AuthenticatedCaller
    },
  ): Promise<Response> => {
    const agentApp = deps.agentApp
    if (!agentApp) {
      return fail('PRECONDITION_FAILED', 'privileged host agent is not connected')
    }
    if (!deps.agentToken) return fail('PRECONDITION_FAILED', 'protected agent service credentials are required')
    const method = opts.method ?? 'GET'
    const headers: Record<string, string> = {
      ...agentCallerHeaders({
        principalId: opts.caller.principal.id,
        token: deps.agentToken,
      }),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    }
    return agentApp.fetch(
      new Request(`http://agent.local${pathAndQuery}`, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      }),
    )
  }

  const triggerReconcile = async (
    caller: AuthenticatedCaller,
    opts?: { force?: boolean; scope?: LiveEventScope },
  ): Promise<{ ok: boolean; status: number; body: Record<string, unknown> } | null> => {
    if (!deps.agentApp) {
      const snap = await deps.store.readSnapshot()
      await reindexFromState(deps.db, snap)
      return null
    }
    const res = await callAgent('/state/apply', {
      method: 'POST',
      caller,
      body: {
        force: Boolean(opts?.force),
      },
    })
    const body = (await res.json()) as Record<string, unknown>
    return { ok: res.ok, status: res.status, body }
  }

  const requireAccountHostAgent = (): void => {
    if (!deps.agentApp || !deps.agentToken) {
      fail('PRECONDITION_FAILED', 'a protected host agent connection is required for account changes', {
        verificationRequired: true, reason: 'host_agent_unavailable', stateChanged: false,
      })
    }
  }

  const accountMutationFailure = async (
    caller: AuthenticatedCaller,
    account: Account,
    action: string,
    outcome: 'failed' | 'unknown' | 'not_applied',
    reason: string,
    code: ErrorCode = 'SERVICE_UNAVAILABLE',
    hostStatus?: number,
  ): Promise<never> => {
    const detail = { verificationRequired: true, needsAttention: true, stateChanged: true,
      hostOutcome: outcome, reason, ...(hostStatus === undefined ? {} : { hostStatus }) }
    await emitAudit({ actor: caller.principal.username, action: 'account.' + action + '.configuration_failed',
      target: 'account:' + account.username, detail, outcome: 'failed', principalId: caller.principal.id,
    }, { accountId: account.id, resellerId: account.ownerId })
    return fail(code, 'account configuration requires verification before further action', detail)
  }

  const captureAccountMutation = async (
    caller: AuthenticatedCaller,
    targetId: Id,
    action: string,
    validate?: (account: Account) => void | Promise<void>,
    beforeRelease?: (account: Account) => Promise<void>,
  ): Promise<{ account: Account; expectedRevision: number }> => {
    const lease = await deps.store.getWriterLock().acquire()
    try {
      const account = await deps.store.getAccount(targetId)
      if (!account) return fail('NOT_FOUND', 'account not found')
      await assertCanAccessAccount(caller, account, action, { allowUserSelf: false })
      if (account.status === 'terminating') return fail('PRECONDITION_FAILED', 'account termination requires attention')
      await validate?.(account)
      await beforeRelease?.(account)
      const authority = await lease.assertFencingToken()
      return { account, expectedRevision: authority.revision }
    } finally { await lease.release() }
  }

  const readAccountApplyBody = async (response: Response): Promise<Record<string, unknown> | null> => {
    if (!response.body) return null
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        bytes += next.value.byteLength
        if (bytes > 65_536) { await reader.cancel(); return null }
        chunks.push(next.value)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
    } finally { reader.releaseLock() }
  }

  const applyAccountConfiguration = async (
    caller: AuthenticatedCaller, account: Account, action: string, expectedRevision: number,
  ): Promise<{ status: 'applied'; generation: { id: number; status: 'active'; checksum: string }; filesCount: number; durationMs: number }> => {
    let response: Response
    try { response = await callAgent('/state/apply', { method: 'POST', caller, body: { force: false } }) }
    catch { return accountMutationFailure(caller, account, action, 'unknown', 'host_transport_unknown') }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      return accountMutationFailure(caller, account, action, 'failed', 'host_apply_rejected', response.status === 422 ? 'CONFIG_TEST_FAILED' : 'SERVICE_UNAVAILABLE', response.status)
    }
    let body: Record<string, unknown> | null
    try { body = await readAccountApplyBody(response) }
    catch { return accountMutationFailure(caller, account, action, 'unknown', 'host_reply_unverified') }
    if (body?.status === 'failed') return accountMutationFailure(caller, account, action, 'failed', 'host_apply_failed', 'CONFIG_TEST_FAILED')
    if (body?.status === 'noop') return accountMutationFailure(caller, account, action, 'not_applied', 'host_apply_not_verified', 'PRECONDITION_FAILED')
    const generation = body?.generation
    const gen = generation !== null && typeof generation === 'object' && !Array.isArray(generation) ? generation as Record<string, unknown> : null
    if (body?.status !== 'applied' || !gen || !Number.isSafeInteger(gen.id) || Number(gen.id) < 1 || gen.status !== 'active'
      || typeof gen.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(gen.checksum)
      || !Number.isSafeInteger(body.filesCount) || Number(body.filesCount) < 0
      || typeof body.durationMs !== 'number' || !Number.isFinite(body.durationMs) || body.durationMs < 0) {
      return accountMutationFailure(caller, account, action, 'unknown', 'host_reply_unverified')
    }
    if (await deps.store.getRevision() !== expectedRevision) {
      return accountMutationFailure(caller, account, action, 'unknown', 'state_changed_during_apply', 'CONFLICT')
    }
    return { status: 'applied', generation: { id: Number(gen.id), status: 'active', checksum: gen.checksum }, filesCount: Number(body.filesCount), durationMs: body.durationMs }
  }

  const accountExecution = () => ({ status: 'configuration_applied', scope: 'global_configuration', targetVerified: false, verificationRequired: true } as const)

  const observeAccountExecution = async (caller: AuthenticatedCaller, ipv4: string) => {
    const pending = accountExecution()
    try {
      const response = await callAgent('/host/addresses', { caller })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        return pending
      }
      const body = await response.json() as { addresses?: unknown }
      const seen = Array.isArray(body.addresses) && body.addresses.includes(ipv4)
      if (!seen) return pending
      return { status: 'configuration_applied' as const, scope: 'global_configuration' as const, targetVerified: true, verificationRequired: false, hostBinding: 'observed' as const, observedAddress: ipv4 }
    } catch {
      return pending
    }
  }

  const ownedDatabaseName = (username: string, raw: unknown): string => {
    if (typeof raw !== 'string' || raw.trim().length === 0) return fail('VALIDATION', 'database name is required')
    const name = raw.trim().toLowerCase()
    return name.startsWith(`${username}_`) ? name : `${username}_${name}`
  }

  const mysqlNativePasswordHash = (password: string): string => {
    if (password.length < 8 || password.length > 256) return fail('VALIDATION', 'database password must be 8 to 256 characters')
    return `*${createHash('sha1').update(createHash('sha1').update(password).digest()).digest('hex').toUpperCase()}`
  }

  const recordFailedLoginAndMaybeLock = async (
    username: string,
    ip: string,
    reason: string,
    principalId?: Id | null,
  ): Promise<void> => {
    const failure = await recordLoginFailure(deps.db, { username, ip, reason, surface: 'panel', threshold: lockoutThreshold, windowMs: lockoutDurationMs, lockoutDurationMs })
    if (failure.lockedUntil) {
      const failures = Math.max(failure.usernameFailures, failure.ipFailures)
      await emitAudit({ actor: username, action: 'auth.lockout', target: 'authentication', detail: { failures, lockedUntil: failure.lockedUntil }, outcome: 'denied', principalId: principalId ?? null, ip })
      return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, failures, lockedUntil: failure.lockedUntil })
    }
  }

  const extendedRouter = createExtendedApiRouter({
    db: deps.db,
    store: deps.store,
    ...(deps.homeBaseDir !== undefined && { homeBaseDir: deps.homeBaseDir }),
    requireCaller,
    assertRoot,
    assertCanAccessAccount,
    resolveAccountParam,
    resolveResellerId,
    emitAudit,
    triggerReconcile,
  })

  const fetch = async (req: Request, context?: TransportContext): Promise<Response> => {
    if (context) {
      let peer: string | null = null
      if (context.remoteAddress !== undefined) {
        peer = normalizedIp(context.remoteAddress)
        if (!parseIp(peer)) return problemResponse(new Error('invalid transport context'), '/')
      }
      transportPeers.set(req, {
        remoteAddress: peer,
        trustedIngress: Boolean(context.trustedIngress),
        tls: Boolean(context.tls),
      })
    }
    const url = new URL(req.url, 'http://localhost')
    const { pathname } = url
    const method = req.method.toUpperCase()
    if (req.body !== null && pathname.startsWith('/api/') && req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return transportProblem(415, 'UNSUPPORTED_MEDIA_TYPE', 'application/json is required', pathname)
    }

    try {
      if (publicOrigin && url.host !== new URL(publicOrigin).host) {
        if (prefersDocumentHtml(req, pathname, method)) return renderTransportStatus(req, 421)
        return transportProblem(421, 'MISDIRECTED_REQUEST', 'request host does not match this entry point', pathname)
      }
      if (entryPoint && pathname.startsWith('/api/') && !entryPointAllowsApiRoute(entryPoint, pathname, method)) return transportProblem(404, 'NOT_FOUND', 'route is unavailable on this entry point', pathname)
      if (entryPoint && pathname !== '/api/health' && deps.requireSecureCookies && !isVerifiedHttps(req)) return transportProblem(403, 'FORBIDDEN', 'verified HTTPS ingress is required for this entry point', pathname)
      // ---- Health --------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/health') {
        return jsonResponse({ ok: true })
      }

      // ---- Authentication & 2FA ------------------------------------------------------
      if (method === 'POST' && pathname === '/api/auth/login') {
        const loginOrigin = req.headers.get('origin')?.trim() ?? null
        const loginFetchSite = req.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null
        const ip = extractClientIp(req) ?? '127.0.0.1'
        if (
          (loginOrigin !== null && !isOriginPermitted(loginOrigin, req)) ||
          (loginOrigin === null && (loginFetchSite === 'cross-site' || deps.requireOriginHeader === true))
        ) {
          await emitAudit({
            actor: 'anonymous',
            action: 'auth.origin_rejected',
            target: '/api/auth/login',
            detail: { origin: loginOrigin, secFetchSite: loginFetchSite },
            outcome: 'denied',
            ip,
          })
          return fail('FORBIDDEN', 'cross-origin authentication request rejected')
        }
        if (deps.requireSecureCookies && !deps.secureCookies && !isVerifiedHttps(req)) {
          return fail('PRECONDITION_FAILED', 'HTTPS ingress is required for secure session cookies')
        }
        const body = await readJsonBody<{
          username?: string
          password?: string
          totpCode?: string
          recoveryCode?: string
        }>(req)
        const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (!username || !password) {
          return fail('VALIDATION', 'username and password are required')
        }

        const activeLockout = await checkLockout(deps.db, { username, ip })
        if (activeLockout) {
          await recordLoginAttempt(deps.db, {
            surface: 'panel',
            username,
            ip,
            success: false,
            reason: 'locked_out',
          })
          await emitAudit({
            actor: username,
            action: 'auth.login_locked',
            target: `principal:${username}`,
            detail: { lockedUntil: activeLockout.lockedUntil },
            outcome: 'denied',
            ip,
          })
          return fail('FORBIDDEN', `too many failed login attempts; locked until ${activeLockout.lockedUntil}`, {
            lockedOut: true,
            lockedUntil: activeLockout.lockedUntil,
          })
        }

        if (entryPoint === 'xmail' && username.includes('@')) {
          let established: Awaited<ReturnType<typeof establishMailboxSession>>
          try {
            established = await establishMailboxSession({
              db: deps.db,
              store: deps.store,
              serverSecret,
              transport: deps.mailboxTransport ?? createLocalMailboxTransport(),
              entryPoint,
              mailbox: username,
              password,
              ip,
              userAgent: req.headers.get('user-agent') ?? 'xpanel-client',
            })
          } catch (err) {
            if (isXpanelError(err) && err.code === 'UNAUTHENTICATED') {
              await emitAudit({
                actor: username,
                action: 'auth.login_failed',
                target: `mailbox:${username}`,
                detail: { reason: 'invalid_credentials' },
                outcome: 'denied',
                ip,
              })
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_credentials', null)
              return fail('UNAUTHENTICATED', 'invalid username or password')
            }
            throw err
          }
          await clearLockout(deps.db, { username })
          await recordLoginAttempt(deps.db, { surface: 'panel', username, ip, success: true })
          await recordLogin(deps.db, established.principal.id)
          const mailboxCsrf = deriveCsrfToken(established.rawToken, serverSecret, entryPoint)
          const mailboxCookie = formatSessionCookie(established.rawToken, {
            entryPoint,
            secure: useSecureCookies(req),
            maxAgeSec: 86_400,
          })
          await emitAudit({
            actor: established.mailbox,
            action: 'auth.login',
            target: `mailbox:${established.mailbox}`,
            detail: { sessionId: established.session.id },
            outcome: 'ok',
            principalId: established.principal.id,
            ip,
          }, { accountId: established.principal.kind === 'user' ? established.principal.accountId : null, resellerId: null })
          return jsonResponse({
            principal: established.principal,
            mailbox: established.mailbox,
            entryPoint,
            home: ENTRY_POINTS[entryPoint].home,
            session: { id: established.session.id, expiresAt: established.session.expiresAt, mfaVerified: established.session.mfaVerified },
            csrfToken: mailboxCsrf,
            passwordChangeRequired: false,
            mfaEnrollmentRequired: false,
          }, 200, { 'set-cookie': mailboxCookie })
        }

        const principalRecord = await findPrincipalByUsername(deps.db, username)
        const passwordMatches = await verifyPasswordArgon2id(password, principalRecord?.passwordHash ?? DUMMY_PASSWORD_HASH)
        const passwordValid = principalRecord !== null && !principalRecord.disabled && passwordMatches

        if (!principalRecord || !passwordValid || (entryPoint && !entryPointAllowsRole(entryPoint, principalRecord.kind))) {
          await emitAudit({
            actor: username,
            action: 'auth.login_failed',
            target: `principal:${username}`,
            detail: { reason: 'invalid_credentials' },
            outcome: 'denied',
            principalId: principalRecord?.id ?? null,
            ip,
          })
          await recordFailedLoginAndMaybeLock(username, ip, 'invalid_credentials', principalRecord?.id ?? null)
          return fail('UNAUTHENTICATED', 'invalid username or password')
        }

        if (principalRecord.kind === 'user' && principalRecord.accountId) {
          const account = await deps.store.getAccount(principalRecord.accountId, { username: principalRecord.username })
          if (!account) return fail('UNAUTHENTICATED', 'hosting account is unavailable')
          if (account.status !== 'active') {
            await emitAudit({
              actor: username,
              action: 'auth.login_denied_suspended',
              target: `account:${account.username}`,
              detail: { status: account.status },
              outcome: 'denied',
              principalId: principalRecord.id,
              ip,
            })
            return fail('FORBIDDEN', `account "${account.username}" is ${account.status}`)
          }
        }

        if (principalRecord.totpEnabled && !principalRecord.totpSecretEnc) return fail('PRECONDITION_FAILED', 'two-factor key recovery is required')
        if (principalRecord.totpEnabled && principalRecord.totpSecretEnc) {
          const secretBase32 = unsealTotpSecret(principalRecord.totpSecretEnc, serverSecret)
          if (typeof body.totpCode === 'string' && body.totpCode.trim().length > 0) {
            const step = verifyTotpStep(secretBase32, body.totpCode)
            if (step === null || !await consumeTotpStep(deps.db, principalRecord.id, step, principalRecord.totpSecretEnc)) {
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_totp', principalRecord.id)
              return fail('UNAUTHENTICATED', 'invalid two-factor authentication code')
            }
          } else if (typeof body.recoveryCode === 'string' && body.recoveryCode.trim().length > 0) {
            const consumed = await consumeRecoveryHash(deps.db, principalRecord.id, sha256Hex(body.recoveryCode.trim()))
            if (!consumed) {
              await recordFailedLoginAndMaybeLock(username, ip, 'invalid_recovery_code', principalRecord.id)
              return fail('UNAUTHENTICATED', 'invalid recovery code')
            }
          } else {
            return fail('UNAUTHENTICATED', 'two-factor authentication code required', { mfaRequired: true })
          }
        }

        const rawToken = randomBytes(32).toString('hex')
        const tokenHash = sessionTokenHash(rawToken, entryPoint)
        const expiresAt = new Date(Date.now() + 24 * 3600_000).toISOString()
        const session = await createAuthenticatedSession(deps.db, {
          principalId: principalRecord.id,
          tokenHash,
          expiresAt,
          ip,
          userAgent: req.headers.get('user-agent') ?? 'xpanel-client',
          mfaVerified: principalRecord.totpEnabled,
          expectedPasswordHash: principalRecord.passwordHash,
          expectedTotpEnabled: principalRecord.totpEnabled,
          expectedSealedSecret: principalRecord.totpSecretEnc,
        })
        if (!session) return fail('UNAUTHENTICATED', 'credentials changed; authenticate again')
        await clearLockout(deps.db, { username })
        await recordLoginAttempt(deps.db, {
          surface: 'panel',
          username,
          ip,
          success: true,
        })
        await recordLogin(deps.db, principalRecord.id)


        const csrfToken = deriveCsrfToken(rawToken, serverSecret, entryPoint)
        const cookie = formatSessionCookie(rawToken, {
          entryPoint,
          secure: useSecureCookies(req),
          maxAgeSec: 86_400,
        })

        const principal =
          principalRecord.kind === 'root'
            ? { kind: 'root' as const, id: principalRecord.id, username: principalRecord.username }
            : principalRecord.kind === 'reseller'
              ? { kind: 'reseller' as const, id: principalRecord.id, username: principalRecord.username }
              : {
                  kind: 'user' as const,
                  id: principalRecord.id,
                  username: principalRecord.username,
                  accountId: principalRecord.accountId!,
                }

        await emitAudit(
          {
            actor: principal.username,
            action: 'auth.login',
            target: `principal:${principal.username}`,
            detail: { sessionId: session.id, mfa: principalRecord.totpEnabled },
            outcome: 'ok',
            principalId: principal.id,
            ip,
          },
          {
            accountId: principal.kind === 'user' ? principal.accountId : null,
            resellerId: principal.kind === 'reseller' ? principal.id : null,
          },
        )

        return jsonResponse(
          {
            principal,
            ...(entryPoint ? { entryPoint, home: ENTRY_POINTS[entryPoint].home } : {}),
            session: {
              id: session.id,
              expiresAt: session.expiresAt,
              mfaVerified: session.mfaVerified,
            },
            csrfToken,
            totpEnabled: principalRecord.totpEnabled,
            passwordChangeRequired: principalRecord.forcePasswordChange,
            mfaEnrollmentRequired: false,
          },
          200,
          { 'set-cookie': cookie },
        )
      }

      if (method === 'POST' && pathname === '/api/auth/logout') {
        const caller = await requireCaller(req, { allowUnverifiedMfa: true })
        if (caller.sessionId) {
          await deleteMailboxSession(deps.db, caller.sessionId)
          await revokeSession(deps.db, caller.sessionId)
        }
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.logout',
          target: `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
          ip: extractClientIp(req),
        })
        return jsonResponse({ ok: true }, 200, {
          'set-cookie': clearSessionCookie({ secure: useSecureCookies(req), entryPoint }),
        })
      }

      if (method === 'GET' && pathname === '/api/auth/me') {
        const caller = await requireCaller(req, { allowUnverifiedMfa: true })
        return jsonResponse({
          ...(entryPoint ? { entryPoint, home: ENTRY_POINTS[entryPoint].home } : {}),
          principal: caller.principal,
          totpEnabled: caller.principalRecord.totpEnabled,
          passwordChangeRequired: caller.principalRecord.forcePasswordChange,
          mfaEnrollmentRequired: false,
          csrfToken: caller.sessionToken ? deriveCsrfToken(caller.sessionToken, serverSecret, entryPoint) : null,
        })
      }

      if (method === 'POST' && pathname === '/api/auth/change-password') {
        const caller = await requireCaller(req)
        if (!caller.sessionId || caller.apiTokenId !== null) return fail('FORBIDDEN', 'password changes require an interactive session')
        const body = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(req)
        if (Object.keys(body).some(key => key !== 'currentPassword' && key !== 'newPassword')) return fail('VALIDATION', 'only currentPassword and newPassword are accepted')
        if (typeof body.currentPassword !== 'string' || !body.currentPassword || typeof body.newPassword !== 'string') return fail('VALIDATION', 'current and new passwords are required')
        if (body.currentPassword === body.newPassword) return fail('VALIDATION', 'new password must differ from the current password')
        const ip = extractClientIp(req) ?? '127.0.0.1'
        const activeLockout = await checkLockout(deps.db, { username: caller.principal.username, ip })
        if (activeLockout) return fail('FORBIDDEN', 'too many failed authentication attempts', { lockedOut: true, lockedUntil: activeLockout.lockedUntil })
        if (!await verifyPasswordArgon2id(body.currentPassword, caller.principalRecord.passwordHash)) {
          await recordFailedLoginAndMaybeLock(caller.principal.username, ip, 'invalid_password_change_reauthentication', caller.principal.id)
          return fail('UNAUTHENTICATED', 'current password is incorrect')
        }
        const newPasswordHash = await passwordHashFromInput({ password: body.newPassword })
        const changed = await changePasswordForSession(deps.db, {
          principalId: caller.principal.id,
          sessionId: caller.sessionId,
          expectedPasswordHash: caller.principalRecord.passwordHash,
          newPasswordHash,
          expectedTotpEnabled: caller.principalRecord.totpEnabled,
          expectedSealedSecret: caller.principalRecord.totpSecretEnc,
          expectedForcePasswordChange: caller.principalRecord.forcePasswordChange,
        })
        if (!changed) return fail('UNAUTHENTICATED', 'authentication state changed; authenticate again')
        await emitAudit({ actor: caller.principal.username, action: 'auth.password_changed', target: `principal:${caller.principal.username}`, outcome: 'ok', principalId: caller.principal.id, ip })
        return jsonResponse({ ok: true, reauthenticationRequired: true }, 200, {
          'set-cookie': clearSessionCookie({ secure: useSecureCookies(req), entryPoint }),
        })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/setup') {
        const caller = await requireCaller(req)
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor enrollment requires an interactive session')
        if (caller.principalRecord.totpEnabled) return fail('CONFLICT', 'two-factor authentication is already enabled')
        const body = await readJsonBody<{ password?: string }>(req)
        if (typeof body.password !== 'string' || !await verifyPasswordArgon2id(body.password, caller.principalRecord.passwordHash)) return fail('UNAUTHENTICATED', 'current password is required for two-factor enrollment')
        const secret = generateTotpSecret()
        const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex'))
        const enrollment = await startTotpEnrollment(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, expectedPasswordHash: caller.principalRecord.passwordHash, sealedSecret: sealTotpSecret(secret, serverSecret), recoveryHashes: recoveryCodes.map(sha256Hex) })
        const otpauthUrl = `otpauth://totp/xPanel:${encodeURIComponent(caller.principal.username)}?secret=${secret}&issuer=xPanel`
        let qrCodeSvg: string | undefined
        try { qrCodeSvg = renderTotpQrSvg(otpauthUrl) } catch { qrCodeSvg = undefined }
        return jsonResponse({
          secret,
          otpauthUrl,
          ...(qrCodeSvg ? { qrCodeSvg } : {}),
          recoveryCodes,
          expiresAt: enrollment.expiresAt,
        })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/enable') {
        const caller = await requireCaller(req)
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor enrollment requires an interactive session')
        const body = await readJsonBody<{ code?: string }>(req)
        if (Object.keys(body).some(key => key !== 'code')) return fail('VALIDATION', 'only the verification code is accepted')
        const pending = await getPendingTotpEnrollment(deps.db, caller.principal.id, caller.sessionId)
        if (!pending) {
          return fail('PRECONDITION_FAILED', '2FA setup must be initiated before enabling')
        }
        const secret = unsealTotpSecret(pending.sealedSecret, serverSecret)
        const code = typeof body.code === 'string' ? body.code.trim() : ''
        const step = verifyTotpStep(secret, code)
        if (step === null) {
          return fail('VALIDATION', 'invalid TOTP verification code')
        }
        if (!await completeTotpEnrollment(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, enrollmentId: pending.enrollmentId, step })) return fail('PRECONDITION_FAILED', 'two-factor enrollment expired or changed')
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.2fa_enabled',
          target: `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, totpEnabled: true })
      }

      if (method === 'POST' && pathname === '/api/auth/2fa/disable') {
        const caller = await requireCaller(req)
        if (!caller.sessionId) return fail('FORBIDDEN', 'two-factor changes require an interactive session')
        const body = await readJsonBody<{ password?: string; code?: string; recoveryCode?: string }>(req)
        if (typeof body.password !== 'string' || !await verifyPasswordArgon2id(body.password, caller.principalRecord.passwordHash)) return fail('UNAUTHENTICATED', 'current password is required')
        const sealedSecret = caller.principalRecord.totpSecretEnc
        if (!caller.principalRecord.totpEnabled || !sealedSecret) return fail('PRECONDITION_FAILED', 'two-factor authentication is not enabled')
        const step = typeof body.code === 'string' ? verifyTotpStep(unsealTotpSecret(sealedSecret, serverSecret), body.code) : null
        const verified = step !== null
          ? await consumeTotpStep(deps.db, caller.principal.id, step, sealedSecret)
          : typeof body.recoveryCode === 'string' && await consumeRecoveryHash(deps.db, caller.principal.id, sha256Hex(body.recoveryCode.trim()))
        if (!verified) return fail('UNAUTHENTICATED', 'a fresh two-factor code is required')
        if (!await disableTotpForSession(deps.db, { principalId: caller.principal.id, sessionId: caller.sessionId, expectedPasswordHash: caller.principalRecord.passwordHash, expectedSealedSecret: sealedSecret })) return fail('PRECONDITION_FAILED', 'two-factor state changed; authenticate again')
        await emitAudit({
          actor: caller.principal.username,
          action: 'auth.2fa_disabled',
          target: `principal:${caller.principal.username}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, totpEnabled: false })
      }

      // ---- Live Events & Catalog & Search --------------------------------------------
      if (method === 'GET' && pathname === '/api/events/recent') {
        const caller = await requireCaller(req)
        const subscriber = await buildSubscriberForCaller(caller)
        const limit = Number(url.searchParams.get('limit') ?? '100') || 100
        const afterSeqParam = url.searchParams.get('afterSeq') ?? url.searchParams.get('cursor')
        const afterSeq = afterSeqParam !== null && /^\d+$/.test(afterSeqParam) ? Number(afterSeqParam) : undefined
        const afterId = url.searchParams.get('afterId') ?? undefined
        return jsonResponse(
          hub.resyncFor(subscriber, {
            limit,
            ...(afterSeq !== undefined && { afterSeq }),
            ...(afterId !== undefined && { afterId }),
          }),
        )
      }

      if (method === 'GET' && pathname === '/api/catalog') {
        const caller = await requireCaller(req)
        const context: Parameters<typeof visibleTools>[1] = { principal: caller.principal }
        if (caller.principal.kind === 'user') {
          const account = await deps.store.getAccount(caller.principal.accountId)
          const plan = account ? await deps.store.getPlan(account.planId) : null
          const featureList = plan ? await deps.store.getFeatureList(plan.featureListId) : null
          if (!featureList) return fail('PRECONDITION_FAILED', 'account feature policy is unavailable')
          context.disabledFeatures = new Set(featureList.disabled)
        } else if (caller.principal.kind === 'reseller') {
          const reseller = await resolveResellerForCaller(caller)
          if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
          context.reseller = reseller
        }
        const catalog = await loadQualifiedCatalog(
          deps.agentApp && deps.agentToken
            ? { fetch: request => deps.agentApp!.fetch(request), token: deps.agentToken }
            : null,
        )
        return jsonResponse({ tools: visibleTools(catalog, context), groups, navigation: visibleNavigation(context, catalog) })
      }

      if (method === 'GET' && pathname === '/api/search') {
        const caller = await requireCaller(req)
        const q = url.searchParams.get('q') ?? ''
        if (!q.trim()) return jsonResponse({ hits: [] })
        const kindParam = url.searchParams.get('kind')
        const kind =
          kindParam === 'account' || kindParam === 'domain' || kindParam === 'reseller' || kindParam === 'plan'
            ? kindParam
            : undefined
        if (caller.principal.kind === 'root') {
          const hits = await searchIndex(deps.db, q, { ...(kind && { kind }) })
          return jsonResponse({ hits })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const hits = await searchIndex(deps.db, q, {
            ...(resellerId && { ownerId: resellerId }),
            ...(kind && { kind }),
          })
          return jsonResponse({ hits })
        }
        const hits = await searchIndex(deps.db, q, {
          accountId: caller.principal.accountId,
          ...(kind && { kind }),
        })
        return jsonResponse({ hits })
      }

      // ---- Server Settings -----------------------------------------------------------
      if (method === 'GET' && pathname === '/api/server/settings') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.settings.read')
        const [settings, setupComplete] = await Promise.all([
          deps.store.getServerSettings(),
          deps.store.isSetupComplete(),
        ])
        return jsonResponse({ settings, setupComplete })
      }

      if (method === 'PUT' && pathname === '/api/server/settings') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.settings.update')
        const body = await readJsonBody<ServerSettings & { markSetupComplete?: boolean }>(req)
        const settings = await deps.store.saveServerSettings(body)
        if (body.markSetupComplete !== false) {
          await deps.store.markSetupComplete()
        }
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'server.settings.updated',
          target: 'server:settings',
          detail: { hostname: settings.hostname, engine: settings.engine },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ settings, reconcile: reconcile?.body ?? null })
      }

      // ---- Feature Lists -------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/feature-lists') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ featureLists: await deps.store.listFeatureLists() })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const all = await deps.store.listFeatureLists()
          return jsonResponse({
            featureLists: all.filter((f) => f.ownerId === null || f.ownerId === resellerId),
          })
        }
        return fail('FORBIDDEN', 'user accounts cannot list feature lists')
      }

      if (method === 'POST' && pathname === '/api/feature-lists') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create feature lists')
        const body = await readJsonBody<Omit<FeatureList, 'id'>>(req)
        const ownerId =
          caller.principal.kind === 'reseller' ? await resolveResellerId(caller) : (body.ownerId ?? null)
        const featureList = await deps.store.createFeatureList({
          name: body.name,
          ownerId,
          disabled: body.disabled ?? [],
        })
        await emitAudit({
          actor: caller.principal.username,
          action: 'feature_list.created',
          target: `feature-list:${featureList.id}`,
          detail: { name: featureList.name },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ featureList }, 201)
      }

      const featureListIdMatch = /^\/api\/feature-lists\/([0-9a-f-]{36})$/i.exec(pathname)
      if (featureListIdMatch) {
        const caller = await requireCaller(req)
        const flId = featureListIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getFeatureList(flId)
        if (!existing) return fail('NOT_FOUND', `feature list "${flId}" not found`)
        if (caller.principal.kind !== 'root') {
          const resellerId = await resolveResellerId(caller)
          if (!resellerId || existing.ownerId !== resellerId) {
            return fail('FORBIDDEN', 'not authorized to modify this feature list')
          }
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<{ name?: string; disabled?: string[] }>(req)
          const featureList = await deps.store.updateFeatureList(flId, patch)
          return jsonResponse({ featureList })
        }
        if (method === 'DELETE') {
          await deps.store.deleteFeatureList(flId)
          return jsonResponse({ ok: true })
        }
      }

      // ---- Plans ---------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/plans') {
        const caller = await requireCaller(req)
        const all = await deps.store.listPlans()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ plans: all })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({ plans: all.filter((p) => p.ownerId === null || p.ownerId === resellerId) })
        }
        const acc = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({ plans: all.filter((p) => p.id === acc?.planId) })
      }

      if (method === 'POST' && pathname === '/api/plans') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create plans')
        const body = await readJsonBody<Partial<NewPlan> & { name: string }>(req)
        const ownerId =
          caller.principal.kind === 'reseller' ? await resolveResellerId(caller) : (body.ownerId ?? null)

        let featureListId = body.featureListId
        if (!featureListId) {
          const existingFls = await deps.store.listFeatureLists()
          if (existingFls[0]) {
            featureListId = existingFls[0].id
          } else {
            const defaultFl = await deps.store.createFeatureList({
              name: 'Standard',
              ownerId: null,
              disabled: [],
            })
            featureListId = defaultFl.id
          }
        }

        const resources = body.resources ?? {
          diskMb: 10_240,
          bandwidthMbMonth: 102_400,
          ioReadBps: 50_000_000,
          ioWriteBps: 50_000_000,
          ioReadIops: 2000,
          ioWriteIops: 2000,
          memoryMb: 1024,
          maxProcesses: 64,
          cpuPercent: 200,
        }
        const defaultMailboxQuotaMb =
          body.defaultMailboxQuotaMb ??
          (typeof resources.diskMb === 'number' ? Math.min(1024, Math.max(1, resources.diskMb)) : 1024)

        const plan = await deps.store.createPlan({
          name: body.name,
          ownerId,
          featureListId,
          resources,
          caps: body.caps ?? {
            addonDomains: 10,
            aliasDomains: 10,
            subdomains: 20,
            mailboxes: 20,
            forwarders: 20,
            mailingLists: 5,
            ftpAccounts: 10,
            databases: 10,
            phpWorkers: 8,
          },
          dedicatedIp: body.dedicatedIp ?? false,
          shell: body.shell ?? 'jailed',
          defaultMailboxQuotaMb,
        })
        const snap = await deps.store.readSnapshot()
        await reindexFromState(deps.db, snap)
        await emitAudit({
          actor: caller.principal.username,
          action: 'plan.created',
          target: `plan:${plan.id}`,
          detail: { name: plan.name, ownerId: plan.ownerId },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ plan }, 201)
      }

      const planIdMatch = /^\/api\/plans\/([0-9a-f-]{36})$/i.exec(pathname)
      if (planIdMatch) {
        const caller = await requireCaller(req)
        const planId = planIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getPlan(planId)
        if (!existing) return fail('NOT_FOUND', `plan "${planId}" not found`)
        if (caller.principal.kind !== 'root') {
          const resellerId = await resolveResellerId(caller)
          if (!resellerId || existing.ownerId !== resellerId) {
            return fail('FORBIDDEN', 'not authorized to modify this plan')
          }
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<PlanPatch>(req)
          const plan = await deps.store.updatePlan(planId, patch)
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'plan.updated',
            target: `plan:${plan.id}`,
            detail: { name: plan.name },
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ plan, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deletePlan(planId)
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'plan.deleted',
            target: `plan:${planId}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true })
        }
      }

      // ---- Resellers -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/resellers') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'reseller') {
          const r = await resolveResellerForCaller(caller)
          return jsonResponse({ resellers: r ? [r] : [] })
        }
        await assertRoot(caller, 'resellers.list')
        return jsonResponse({ resellers: await deps.store.listResellers() })
      }

      if (method === 'POST' && pathname === '/api/resellers') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'resellers.create')
        const body = await readJsonBody<Omit<NewReseller, 'passwordHash'> & { password?: string; passwordHash?: string }>(req)
        const passwordHash = await passwordHashFromInput(body)
        const reseller = await deps.store.createReseller({
          ...body,
          passwordHash,
        })
        const existingPrincipal = await findPrincipalByUsername(deps.db, reseller.username)
        if (!existingPrincipal) {
          await createResellerPrincipal(deps.db, {
            id: reseller.id,
            username: reseller.username,
            passwordHash,
          })
        }
        const snap = await deps.store.readSnapshot()
        await reindexFromState(deps.db, snap)
        await emitAudit({
          actor: caller.principal.username,
          action: 'reseller.created',
          target: `reseller:${reseller.username}`,
          detail: { resellerId: reseller.id },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ reseller }, 201)
      }

      const resellerIdMatch = /^\/api\/resellers\/([0-9a-f-]{36})$/i.exec(pathname)
      if (resellerIdMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'resellers.modify')
        const resellerId = resellerIdMatch[1]!.toLowerCase()
        if (method === 'PATCH') {
          const patch = await readJsonBody<ResellerPatch>(req)
          const reseller = await deps.store.updateReseller(resellerId, patch)
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'reseller.updated',
            target: `reseller:${reseller.username}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ reseller })
        }
        if (method === 'DELETE') {
          const existing = await deps.store.getReseller(resellerId)
          await deps.store.deleteReseller(resellerId)
          if (existing) {
            const p = await findPrincipalByUsername(deps.db, existing.username)
            if (p) await deletePrincipal(deps.db, p.id)
          }
          const snap = await deps.store.readSnapshot()
          await reindexFromState(deps.db, snap)
          await emitAudit({
            actor: caller.principal.username,
            action: 'reseller.deleted',
            target: `reseller:${resellerId}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true })
        }
      }

      const mailboxTransport = deps.mailboxTransport ?? createLocalMailboxTransport()
      const inboxMatch = /^\/api\/webmail\/inbox\/([1-9]\d*)$/.exec(pathname)
      if (pathname === '/api/webmail/inbox' && method === 'GET') {
        const caller = await requireCaller(req)
        const opened = await openMailboxSession(deps.db, serverSecret, caller.sessionId)
        if (caller.principal.kind === 'user' && caller.principal.accountId !== opened.record.accountId) {
          return fail('NOT_FOUND', 'mailbox not found')
        }
        const messages = await mailboxTransport.list(opened.record.mailbox, opened.password)
        return jsonResponse({ mailbox: opened.record.mailbox, folder: 'INBOX', complete: true, messages })
      }
      if (inboxMatch && (method === 'GET' || method === 'DELETE')) {
        const caller = await requireCaller(req)
        const opened = await openMailboxSession(deps.db, serverSecret, caller.sessionId)
        if (caller.principal.kind === 'user' && caller.principal.accountId !== opened.record.accountId) {
          return fail('NOT_FOUND', 'mailbox not found')
        }
        const uid = Number(inboxMatch[1])
        if (method === 'DELETE') {
          await mailboxTransport.remove(opened.record.mailbox, opened.password, uid)
          return jsonResponse({ ok: true, uid })
        }
        const message = await mailboxTransport.read(opened.record.mailbox, opened.password, uid)
        return jsonResponse({ mailbox: opened.record.mailbox, message })
      }
      if (pathname === '/api/webmail/send' && method === 'POST') {
        const caller = await requireCaller(req)
        const opened = await openMailboxSession(deps.db, serverSecret, caller.sessionId)
        if (caller.principal.kind === 'user' && caller.principal.accountId !== opened.record.accountId) {
          return fail('NOT_FOUND', 'mailbox not found')
        }
        const sent = await mailboxTransport.send(opened.record.mailbox, opened.password, parseMailboxSend(await readJsonBody(req)))
        return jsonResponse({ mailbox: opened.record.mailbox, messageId: sent.messageId }, 201)
      }
      if (method === 'GET' && pathname === '/api/server/info') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.info')
        return callAgent('/host/info', { caller })
      }
      if (method === 'GET' && pathname === '/api/server/drift') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.drift')
        return callAgent('/host/drift', { caller })
      }
      if (method === 'GET' && pathname === '/api/server/services') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.services')
        return callAgent('/host/services', { caller })
      }
      const serviceRestart = /^\/api\/server\/services\/([a-z0-9-]+)\/restart$/.exec(pathname)
      if (method === 'POST' && serviceRestart) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'server.services.restart')
        return callAgent(`/host/services/${serviceRestart[1]}/restart`, { method: 'POST', caller, body: {} })
      }
      const accountBackup = /^\/api\/backups\/accounts\/([a-z][a-z0-9]{2,15})$/.exec(pathname)
      if (accountBackup && (method === 'GET' || method === 'POST')) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'backup.account')
        const username = accountBackup[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        if (method === 'GET') return callAgent(`/accounts/${username}/backups`, { caller })
        return callAgent(`/accounts/${username}/backups`, { method: 'POST', caller, body: await readJsonBody(req) })
      }

      // ---- Accounts: Jailed Files & Shell (Proxied to Agent) -------------------------
      const accountFilesMatch = /^\/api\/accounts\/([a-z][a-z0-9]{2,15})\/files$/.exec(pathname)
      if (method === 'POST' && accountFilesMatch) {
        const caller = await requireCaller(req)
        const username = accountFilesMatch[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        await assertCanAccessAccount(caller, account, 'files')
        const body = await readJsonBody(req)
        return callAgent(`/accounts/${username}/files`, {
          method: 'POST',
          caller,
          body,
        })
      }

      const accountCertificatesMatch = /^\/api\/accounts\/([a-z][a-z0-9]{2,15})\/certificates$/.exec(pathname)
      if (method === 'POST' && accountCertificatesMatch) {
        const caller = await requireCaller(req)
        const username = accountCertificatesMatch[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        await assertCanAccessAccount(caller, account, 'certificates')
        await assertCanBindCertificate(caller, account)
        const body = await readJsonBody<{ domain?: unknown; certificateId?: unknown; directoryUrl?: unknown }>(req)
        const domainName = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : ''
        if (!domainName) return fail('VALIDATION', 'domain is required')
        const domain = (await deps.store.listDomains({ accountId: account.id })).find(item => item.name === domainName)
        if (!domain) return fail('NOT_FOUND', 'domain not found')
        const directoryUrl = caller.principal.kind === 'root' && typeof body.directoryUrl === 'string' && body.directoryUrl.startsWith('http://127.0.0.1:')
          ? body.directoryUrl
          : undefined
        const certificateId = typeof body.certificateId === 'string' ? body.certificateId : undefined
        const agentResponse = await callAgent(`/accounts/${username}/certificates`, {
          method: 'POST',
          caller,
          body: {
            domain: domain.name,
            ...(certificateId ? { certificateId } : {}),
            ...(directoryUrl ? { directoryUrl } : {}),
          },
        })
        if (!agentResponse.ok) return agentResponse
        const issued = await agentResponse.json() as {
          certificate?: {
            id?: string
            names?: string[]
            notAfter?: string
            fingerprintSha256?: string | null
            certPath?: string
            keyPath?: string
          }
        }
        const certificate = issued.certificate
        if (!certificate?.id || !certificate.certPath || !certificate.keyPath || !certificate.notAfter || !certificate.names?.length) {
          return fail('PRECONDITION_FAILED', 'the certificate authority did not return a usable certificate')
        }
        const stored = await deps.store.createCertificate({
          id: certificate.id,
          accountId: account.id,
          names: certificate.names,
          source: 'acme',
          challenge: 'http-01',
          notAfter: certificate.notAfter,
          autoRenew: true,
          certPath: certificate.certPath,
          keyPath: certificate.keyPath,
          fingerprintSha256: certificate.fingerprintSha256 ?? null,
        })
        if (domain.certificateId !== stored.id) await deps.store.updateDomain(domain.id, { certificateId: stored.id })
        const reconcile = await triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
        await emitAudit({
          actor: caller.principal.username,
          action: 'certificate.issued',
          target: `domain:${domain.name}`,
          detail: { certificateId: stored.id, notAfter: stored.notAfter },
          outcome: 'ok',
          principalId: caller.principal.id,
        }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ certificate: stored, reconcile })
      }

      const accountShellMatch = /^\/api\/accounts\/([a-z][a-z0-9]{2,15})\/shell$/.exec(pathname)
      if (method === 'POST' && accountShellMatch) {
        const caller = await requireCaller(req)
        const username = accountShellMatch[1]!
        const account = await deps.store.getAccountByUsername(username)
        if (!account) return fail('NOT_FOUND', `account "${username}" not found`)
        await assertCanAccessAccount(caller, account, 'shell')
        const body = await readJsonBody(req)
        return callAgent(`/accounts/${username}/shell`, {
          method: 'POST',
          caller,
          body,
        })
      }

      // ---- Accounts CRUD & Lifecycle -------------------------------------------------
      if (method === 'GET' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ accounts: await deps.store.listAccounts() })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({
            accounts: resellerId ? await deps.store.listAccounts({ ownerId: resellerId }) : [],
          })
        }
        const acc = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({ accounts: acc ? [acc] : [] })
      }

      if (method === 'POST' && pathname === '/api/accounts') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') return fail('FORBIDDEN', 'user accounts cannot create hosting accounts')
        const body = await readJsonBody<Partial<NewAccount> & { username: string; primaryDomain: string; planId: Id; password?: string }>(req)
        requireAccountHostAgent()
        const username = validateUsername(body.username)
        const passwordHash = await passwordHashFromInput(body)
        let ownerId: Id | null
        let expectedRevision: number
        const lease = await deps.store.getWriterLock().acquire()
        try {
          const reseller = caller.principal.kind === 'reseller' ? await resolveResellerForCaller(caller) : null
          if (caller.principal.kind === 'reseller') {
            if (!reseller) return fail('FORBIDDEN', 'reseller authorization is unavailable')
            assertAcl(caller.principal, reseller, 'create-account')
          }
          ownerId = caller.principal.kind === 'reseller' ? reseller!.id : body.ownerId ?? null
          if (await findPrincipalByUsername(deps.db, username) || await deps.store.getAccountByUsername(username)) return fail('CONFLICT', 'the account username is already reserved')
          expectedRevision = (await lease.assertFencingToken()).revision
        } finally { await lease.release() }
        const account = await deps.store.createAccount({ username, passwordHash, primaryDomain: body.primaryDomain, planId: body.planId,
          ownerId, contactEmail: body.contactEmail ?? username + '@' + body.primaryDomain,
          ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }), ...(body.ipAssignment !== undefined && { ipAssignment: body.ipAssignment }),
          ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }), ...(body.extraIps !== undefined && { extraIps: body.extraIps }),
          shell: body.shell ?? 'jailed', php: body.php ?? defaultPhp('8.3'), ...(body.homeBase !== undefined && { homeBase: body.homeBase }),
        }, { expectedRevision })
        const reconcile = await applyAccountConfiguration(caller, account, 'create', expectedRevision + 1)
        try {
          const existing = await findPrincipalByUsername(deps.db, account.username)
          if (existing && (existing.kind !== 'user' || existing.accountId !== account.id)) {
            return accountMutationFailure(caller, account, 'create', 'unknown', 'identity_binding_conflict', 'CONFLICT')
          }
          if (!existing) await createUserPrincipal(deps.db, { username: account.username, passwordHash, accountId: account.id })
        } catch { return accountMutationFailure(caller, account, 'create', 'unknown', 'identity_establishment_unverified') }
        await emitAudit({ actor: caller.principal.username, action: 'account.desired.created', target: 'account:' + account.username,
          detail: { accountId: account.id, primaryDomain: account.primaryDomain, planId: account.planId, execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: account.id, resellerId: account.ownerId })
        const primaryDomains = await deps.store.listDomains({ accountId: account.id })
        return jsonResponse({ account, primaryDomain: primaryDomains[0] ?? null, reconcile, execution: await observeAccountExecution(caller, account.ipv4) }, 201)
      }

      const accountSuspendMatch = /^\/api\/accounts\/([^/]+)\/(suspend|unsuspend)$/.exec(pathname)
      if (method === 'POST' && accountSuspendMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountSuspendMatch[1]!)
        const verb = accountSuspendMatch[2]!
        await assertCanAccessAccount(caller, target, 'account.' + verb, { allowUserSelf: false })
        const body = await readJsonBody<{ reason?: string }>(req)
        requireAccountHostAgent()
        const captured = await captureAccountMutation(caller, target.id, 'account.' + verb, account => {
          const expected = verb === 'suspend' ? 'active' : 'suspended'
          if (account.status !== expected) fail('CONFLICT', 'account is not in the expected state for this transition')
        }, verb === 'unsuspend' ? async account => {
          try { await revokeAccountSessionsAndTokens(deps.db, account.id) }
          catch { fail('SERVICE_UNAVAILABLE', 'account access cleanup requires verification', { reason: 'access_revocation_failed', verificationRequired: true, stateChanged: false }) }
        } : undefined)
        const updated = verb === 'suspend'
          ? await deps.store.suspendAccount(captured.account.id, body.reason || 'Suspended by administrator', { expectedRevision: captured.expectedRevision })
          : await deps.store.unsuspendAccount(captured.account.id, { expectedRevision: captured.expectedRevision })
        if (verb === 'suspend') {
          try { await revokeAccountSessionsAndTokens(deps.db, updated.id) }
          catch { return accountMutationFailure(caller, updated, verb, 'unknown', 'access_revocation_failed') }
        }
        const reconcile = await applyAccountConfiguration(caller, updated, verb, captured.expectedRevision + 1)
        await emitAudit({ actor: caller.principal.username, action: 'account.desired.' + (verb === 'suspend' ? 'suspended' : 'unsuspended'),
          target: 'account:' + updated.username, detail: { accountStatus: updated.status, reason: updated.suspendReason, execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: updated.id, resellerId: updated.ownerId })
        return jsonResponse({ account: updated, reconcile, execution: accountExecution() })
      }

      const accountItemMatch = /^\/api\/accounts\/([^/]+)$/.exec(pathname)
      if (accountItemMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountItemMatch[1]!)
        if (method === 'GET') {
          await assertCanAccessAccount(caller, target, 'account.read')
          return jsonResponse({ account: target, domains: await deps.store.listDomains({ accountId: target.id }) })
        }
        if (method === 'PATCH') {
          await assertCanAccessAccount(caller, target, 'account.update', { allowUserSelf: false })
          const patch = await readJsonBody<{ planId?: Id; ownerId?: Id | null; contactEmail?: string; ipv4?: string; ipv6?: string | null; shell?: 'none' | 'jailed' }>(req)
          if (Object.keys(patch).some(key => !['planId', 'ownerId', 'contactEmail', 'ipv4', 'ipv6', 'shell'].includes(key))) return fail('VALIDATION', 'unsupported account setting')
          const metadataOnly = Object.keys(patch).length === 1 && Object.hasOwn(patch, 'contactEmail')
          if (metadataOnly) {
            const updated = await deps.store.updateAccount(target.id, { contactEmail: patch.contactEmail })
            try {
              await syncAccountContactIndex(deps.db, updated)
            } catch {
              let reverted = true
              try { await deps.store.updateAccount(updated.id, { contactEmail: target.contactEmail }) } catch { reverted = false }
              return fail('SERVICE_UNAVAILABLE', 'account contact index could not be updated', { reason: 'contact_index_failed', verificationRequired: true, stateChanged: !reverted })
            }
            await emitAudit({ actor: caller.principal.username, action: 'account.contact.updated', target: 'account:' + updated.username,
              detail: { contactEmail: updated.contactEmail }, outcome: 'ok', principalId: caller.principal.id,
            }, { accountId: updated.id, resellerId: updated.ownerId })
            return jsonResponse({ account: updated, stateChanged: true })
          }
          requireAccountHostAgent()
          const captured = await captureAccountMutation(caller, target.id, 'account.update', async account => {
            if (patch.planId && patch.planId !== account.planId && caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'change-plan')
            if (patch.ownerId !== undefined && patch.ownerId !== account.ownerId) await assertRoot(caller, 'account.change_owner')
            if (!Object.entries(patch).some(([key, value]) => value !== undefined && value !== account[key as keyof Account])) return fail('CONFLICT', 'account already has the requested settings')
          })
          let updated = captured.account
          let expectedRevision = captured.expectedRevision
          if (patch.planId && patch.planId !== updated.planId) { updated = await deps.store.changePlan(updated.id, patch.planId, { expectedRevision }); expectedRevision++ }
          if (patch.ownerId !== undefined && patch.ownerId !== updated.ownerId) { updated = await deps.store.changeOwner(updated.id, patch.ownerId, { expectedRevision }); expectedRevision++ }
          if (patch.contactEmail !== undefined || patch.ipv4 !== undefined || patch.ipv6 !== undefined || patch.shell !== undefined) {
            updated = await deps.store.updateAccount(updated.id, patch, { expectedRevision }); expectedRevision++
          }
          const reconcile = await applyAccountConfiguration(caller, updated, 'update', expectedRevision)
          await emitAudit({ actor: caller.principal.username, action: 'account.desired.updated', target: 'account:' + updated.username,
            detail: { execution: accountExecution() }, outcome: 'ok', principalId: caller.principal.id,
          }, { accountId: updated.id, resellerId: updated.ownerId })
          return jsonResponse({ account: updated, reconcile, execution: accountExecution() })
        }
        if (method === 'DELETE') {
          await assertCanAccessAccount(caller, target, 'account.delete', { allowUserSelf: false })
          const body = await readJsonBody<{ confirmUsername?: unknown }>(req)
          if (Object.keys(body).some(key => key !== 'confirmUsername') || typeof body.confirmUsername !== 'string' || body.confirmUsername !== target.username) {
            return fail('VALIDATION', 'confirmation must match the account username')
          }
          const current = await deps.store.getAccount(target.id)
          if (!current) return fail('NOT_FOUND', 'account not found')
          await assertCanAccessAccount(caller, current, 'account.delete', { allowUserSelf: false })
          if (body.confirmUsername !== current.username) return fail('CONFLICT', 'account confirmation is no longer current')
          const unavailable = () => fail('PRECONDITION_FAILED', 'account termination requires a verified target-bound purge operation', {
            verificationRequired: true, reason: 'target_bound_purge_unavailable', stateChanged: false,
          })
          let probe: Response
          try { probe = await callAgent(`/accounts/${current.username}/purge`, { method: 'GET', caller }) }
          catch { return unavailable() }
          if (!probe.ok) {
            await probe.body?.cancel().catch(() => undefined)
            return unavailable()
          }
          const probeBody = await probe.json().catch(() => null) as { available?: unknown; contract?: unknown } | null
          if (probeBody?.available !== true || probeBody.contract !== 'target-bound-userdel') return unavailable()
          const marked = await deps.store.markTerminating(current.id)
          const purge = await callAgent(`/accounts/${marked.username}/purge`, {
            method: 'POST', caller, body: { confirmUsername: marked.username, uid: marked.uid, home: marked.home },
          })
          const purgeBody = await purge.json().catch(() => null) as { purged?: unknown; reason?: unknown } | null
          if (!purge.ok || purgeBody?.purged !== true) {
            return fail('SERVICE_UNAVAILABLE', 'account purge did not complete', {
              verificationRequired: true, reason: typeof purgeBody?.reason === 'string' ? purgeBody.reason : 'purge_failed', stateChanged: true,
            })
          }
          await revokeAccountSessionsAndTokens(deps.db, marked.id)
          const identities = await deps.db.query<{ id: string }>('SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [marked.id])
          for (const identity of identities) await deletePrincipal(deps.db, identity.id)
          await deps.store.deleteAccount(marked.id)
          await reindexFromState(deps.db, await deps.store.readSnapshot())
          await emitAudit({ actor: caller.principal.username, action: 'account.terminated', target: 'account:' + marked.username,
            detail: { purged: true }, outcome: 'ok', principalId: caller.principal.id,
          }, { accountId: marked.id, resellerId: marked.ownerId })
          return jsonResponse({ ok: true, purged: true })
        }
      }

      const accountPasswordMatch = /^\/api\/accounts\/([^/]+)\/password$/.exec(pathname)
      if (method === 'POST' && accountPasswordMatch) {
        const caller = await requireCaller(req)
        const target = await resolveAccountParam(accountPasswordMatch[1]!)
        await assertCanAccessAccount(caller, target, 'account.password', { allowUserSelf: false })
        if (caller.principal.kind === 'reseller') assertAcl(caller.principal, await resolveResellerForCaller(caller), 'change-password')
        const body = await readJsonBody<{ password?: string }>(req)
        const passwordHash = await passwordHashFromInput({ password: body.password })
        const identities = await deps.db.query<{ id: string }>('SELECT id FROM principals WHERE account_id = $1 ORDER BY id', [target.id])
        if (identities.length === 0) {
          const taken = await findPrincipalByUsername(deps.db, target.username)
          if (taken) return fail('CONFLICT', 'login identity is not bound to this account', { stateChanged: false })
          const created = await createUserPrincipal(deps.db, { username: target.username, passwordHash, accountId: target.id })
          identities.push({ id: created.id })
        }
        for (const identity of identities) await setPasswordHash(deps.db, identity.id, passwordHash)
        await emitAudit({ actor: caller.principal.username, action: 'account.password.changed', target: 'account:' + target.username,
          detail: { principals: identities.length }, outcome: 'ok', principalId: caller.principal.id,
        }, { accountId: target.id, resellerId: target.ownerId })
        return jsonResponse({ ok: true, accountId: target.id, principals: identities.length })
      }

      // ---- Multi-IPv4 / IPv6 Pool Management -----------------------------------------
      if (method === 'GET' && pathname === '/api/ips') {
        const caller = await requireCaller(req)
        if (url.searchParams.size > 0) {
          const allowed = new Set(['view', 'planId', 'ownerId'])
          for (const key of url.searchParams.keys()) {
            if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return fail('VALIDATION', 'invalid or repeated IP allocation query parameter')
          }
          const planId = url.searchParams.get('planId'), requestedOwner = url.searchParams.get('ownerId')
          if (url.searchParams.get('view') !== 'allocation' || !isUuid(planId) || planId !== planId.toLowerCase()
            || (requestedOwner !== null && (!isUuid(requestedOwner) || requestedOwner !== requestedOwner.toLowerCase()))) {
            return fail('VALIDATION', 'allocation preview requires a canonical planId and optional ownerId UUID')
          }
          let ownerId: Id | null = requestedOwner
          if (caller.principal.kind === 'reseller') {
            const resellerId = await resolveResellerId(caller)
            if (!resellerId || (requestedOwner !== null && requestedOwner !== resellerId)) return fail('FORBIDDEN', 'allocation preview owner must match the authenticated reseller')
            ownerId = resellerId
          } else if (caller.principal.kind !== 'root') {
            return fail('FORBIDDEN', 'hosting administrator permission is required for allocation preview')
          }
          return jsonResponse(await deps.store.readAccountIpAllocationOptions({ planId, ownerId }))
        }
        const all = await deps.store.listServerIps()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ ips: all })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          return jsonResponse({
            ips: all.filter((ip) => ip.role === 'shared' || ip.ownerId === null || ip.ownerId === resellerId),
          })
        }
        const account = await deps.store.getAccount(caller.principal.accountId)
        return jsonResponse({
          ips: all.filter((ip) => ip.address === account?.ipv4 || ip.address === account?.ipv6),
        })
      }

      if (method === 'POST' && pathname === '/api/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'ips.save')
        const body = await readJsonBody<Partial<ServerIpEntry> & { address: string }>(req)
        if (typeof body.address !== 'string') return fail('VALIDATION', 'address must be an IP address string')
        const version: 4 | 6 = body.version ?? (body.address.includes(':') ? 6 : 4)
        const ip = await deps.store.saveServerIp({
          ...(body.id && { id: body.id }),
          address: body.address,
          version,
          prefixLength: body.prefixLength ?? (version === 6 ? 64 : 24),
          interfaceName: body.interfaceName ?? 'eth0',
          role: body.role ?? 'shared',
          ownerKind: body.ownerKind ?? 'root',
          ownerId: body.ownerId ?? null,
          ptrHostname: body.ptrHostname ?? null,
          isPrimary: body.isPrimary ?? false,
          notes: body.notes ?? '',
        })
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'ip.saved',
          target: `ip:${ip.address}`,
          detail: { id: ip.id, version: ip.version, role: ip.role, ownerId: ip.ownerId },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ip, reconcile: reconcile?.body ?? null }, 201)
      }

      const ipDeleteMatch = /^\/api\/ips\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && ipDeleteMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'ips.delete')
        const ipId = ipDeleteMatch[1]!.toLowerCase()
        if (!await deps.store.deleteServerIp(ipId)) return fail('NOT_FOUND', 'IP pool entry not found')
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'ip.deleted',
          target: `ip:${ipId}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      // ---- Mail Outbound IP Configuration --------------------------------------------
      if (method === 'GET' && pathname === '/api/mail/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'mail.ips.read')
        return jsonResponse({ config: await deps.store.getMailIpConfig() })
      }

      if (method === 'PUT' && pathname === '/api/mail/ips') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'mail.ips.update')
        const body = await readJsonBody<MailIpConfig>(req)
        const config = await deps.store.saveMailIpConfig(body)
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'mail.ips.updated',
          target: 'mail:ips',
          detail: { mode: config.mode, overridesCount: config.domainOverrides.length },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ config, reconcile: reconcile?.body ?? null })
      }

      // ---- Domains & Smart Custom Configuration (userdata) ---------------------------
      const domainCustomMatch = /^\/api\/domains\/([0-9a-f-]{36})\/custom-config$/i.exec(pathname)
      if (domainCustomMatch) {
        const caller = await requireCaller(req)
        const domainId = domainCustomMatch[1]!.toLowerCase()
        const domain = await deps.store.getDomain(domainId)
        if (!domain) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(domain.accountId)
        if (!account) return fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.custom_config')

        if (method === 'GET') {
          return jsonResponse({ config: await deps.store.getDomainCustomConfig(domain.id) })
        }

        if (method === 'PUT') {
          const body = await readJsonBody<
            Partial<DomainCustomConfig> & { allowRootDirectives?: boolean }
          >(req)
          const allowRootDirectives = caller.principal.kind === 'root' && Boolean(body.allowRootDirectives)
          const validated = validateDomainCustomConfig(
            {
              ...body,
              domainId: domain.id,
              accountId: account.id,
              domainName: domain.name,
              updatedBy: caller.principal.kind,
            },
            { allowRootDirectives, accountHome: account.home },
          )

          const previousConfig = await deps.store.getDomainCustomConfig(domain.id)
          const saved = await deps.store.saveDomainCustomConfig(validated)
          const reconcile = await triggerReconcile(caller, {
            force: true,
            scope: { accountId: account.id, resellerId: account.ownerId },
          })

          if (reconcile && (!reconcile.ok || reconcile.body.status === 'failed')) {
            if (previousConfig) {
              await deps.store.saveDomainCustomConfig(previousConfig)
            } else {
              await deps.store.deleteDomainCustomConfig(domain.id)
            }
            await emitAudit(
              {
                actor: caller.principal.username,
                action: 'domain.custom_config.rollback',
                target: `domain:${domain.name}`,
                detail: {
                  domainId: domain.id,
                  failedTest: reconcile.body.failedTest,
                  error: reconcile.body.error,
                },
                outcome: 'failed',
                principalId: caller.principal.id,
              },
              { accountId: account.id, resellerId: account.ownerId },
            )
            return fail(
              'CONFIG_TEST_FAILED',
              `custom config for "${domain.name}" failed service config test (${String(reconcile.body.failedTest ?? 'test')}) and was automatically rolled back`,
              {
                domainId: domain.id,
                rolledBack: true,
                failedTest: reconcile.body.failedTest,
                error: reconcile.body.error,
                reconcile: reconcile.body,
              },
            )
          }

          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.custom_config.updated',
              target: `domain:${domain.name}`,
              detail: { domainId: domain.id },
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ config: saved, reconcile: reconcile?.body ?? null })
        }

        if (method === 'DELETE') {
          await deps.store.deleteDomainCustomConfig(domain.id)
          const reconcile = await triggerReconcile(caller, {
            force: true,
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.custom_config.deleted',
              target: `domain:${domain.name}`,
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      if (method === 'GET' && pathname === '/api/domains') {
        const caller = await requireCaller(req)
        const accountIdFilter = url.searchParams.get('accountId') ?? undefined
        if (caller.principal.kind === 'root') {
          return jsonResponse({
            domains: await deps.store.listDomains(accountIdFilter ? { accountId: accountIdFilter } : undefined),
          })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          const allDomains = await deps.store.listDomains(accountIdFilter ? { accountId: accountIdFilter } : undefined)
          return jsonResponse({ domains: allDomains.filter((d) => ownedIds.has(d.accountId)) })
        }
        return jsonResponse({
          domains: await deps.store.listDomains({ accountId: caller.principal.accountId }),
        })
      }

      if (method === 'POST' && pathname === '/api/domains') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<Partial<NewDomain> & { name: string; parentDomainId?: Id | null }>(req)
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.create')
        if (body.certificateId) await assertCanBindCertificate(caller, account)

        const existingDomains = await deps.store.listDomains({ accountId: account.id })
        const primaryDomain = existingDomains.find((d) => d.kind === 'primary')

        const domain = await deps.store.createDomain({
          accountId: account.id,
          name: body.name,
          kind: body.kind ?? 'addon',
          parentId: body.parentId ?? body.parentDomainId ?? null,
          docRoot: body.docRoot ?? `${account.home}/domains/${body.name}/public_html`,
          siteType: body.siteType ?? 'php',
          upstream: body.upstream ?? null,
          redirect: body.redirect ?? null,
          php: body.php ?? primaryDomain?.php ?? defaultPhp('8.3'),
          wildcard: body.wildcard ?? false,
          certificateId: body.certificateId ?? null,
          suspended: body.suspended ?? false,
          expiresAt: body.expiresAt ?? null,
          pathQuotaMb: body.pathQuotaMb ?? 'unlimited',
          ...(body.ipv4 !== undefined && { ipv4: body.ipv4 }),
          ...(body.ipv6 !== undefined && { ipv6: body.ipv6 }),
        })
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'domain.created',
            target: `domain:${domain.name}`,
            detail: { domainId: domain.id, kind: domain.kind, accountId: domain.accountId },
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ domain, reconcile: reconcile?.body ?? null }, 201)
      }

      const domainIdMatch = /^\/api\/domains\/([0-9a-f-]{36})$/i.exec(pathname)
      if (domainIdMatch) {
        const caller = await requireCaller(req)
        const domainId = domainIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getDomain(domainId)
        if (!existing) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'domain.modify')

        if (method === 'PATCH') {
          const patch = await readJsonBody<DomainPatch>(req)
          if (patch.certificateId !== undefined && patch.certificateId !== existing.certificateId) await assertCanBindCertificate(caller, account)
          const domain = await deps.store.updateDomain(domainId, patch)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.updated',
              target: `domain:${domain.name}`,
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ domain, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deleteDomain(domainId)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          await emitAudit(
            {
              actor: caller.principal.username,
              action: 'domain.deleted',
              target: `domain:${existing.name}`,
              outcome: 'ok',
              principalId: caller.principal.id,
            },
            { accountId: account.id, resellerId: account.ownerId },
          )
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- Databases -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/databases') {
        const caller = await requireCaller(req)
        const includeTrashed = url.searchParams.get('includeTrashed') === 'true'
        if (caller.principal.kind === 'user') {
          return jsonResponse({
            databases: await deps.store.listDatabases(caller.principal.accountId, { includeTrashed }),
          })
        }
        const accountId = url.searchParams.get('accountId')
        if (accountId) {
          const account = await deps.store.getAccount(accountId)
          if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
          await assertCanAccessAccount(caller, account, 'databases.list')
          return jsonResponse({
            databases: await deps.store.listDatabases(account.id, { includeTrashed }),
          })
        }
        const snap = await deps.store.readSnapshot()
        if (caller.principal.kind === 'root') {
          return jsonResponse({
            databases: includeTrashed ? snap.databases : snap.databases.filter((d) => d.trashedAt === null),
          })
        }
        const resellerId = await resolveResellerId(caller)
        const ownedIds = new Set((await ownedAccounts(deps.store, caller)).map(account => account.id))
        return jsonResponse({
          databases: snap.databases.filter(
            (d) => ownedIds.has(d.accountId) && (includeTrashed || d.trashedAt === null),
          ),
        })
      }

      if (method === 'POST' && pathname === '/api/databases') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<{ accountId?: Id; name: string }>(req)
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'database.create')
        const database = await deps.store.createDatabase({ accountId: account.id, name: body.name })
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'database.created',
            target: `database:${database.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ database, reconcile: reconcile?.body ?? null }, 201)
      }

      const dbTrashRestoreMatch = /^\/api\/databases\/([0-9a-f-]{36})\/(trash|restore)$/i.exec(pathname)
      if (method === 'POST' && dbTrashRestoreMatch) {
        const caller = await requireCaller(req)
        const dbId = dbTrashRestoreMatch[1]!.toLowerCase()
        const verb = dbTrashRestoreMatch[2]!
        const existing = await deps.store.getDatabase(dbId)
        if (!existing) return fail('NOT_FOUND', `database "${dbId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, `database.${verb}`)
        const database =
          verb === 'trash' ? await deps.store.trashDatabase(dbId) : await deps.store.restoreDatabase(dbId)
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: `database.${verb}ed`,
            target: `database:${database.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ database, reconcile: reconcile?.body ?? null })
      }

      const dbDeleteMatch = /^\/api\/databases\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && dbDeleteMatch) {
        const caller = await requireCaller(req)
        const dbId = dbDeleteMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabase(dbId)
        if (!existing) return fail('NOT_FOUND', `database "${dbId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'database.purge')
        if (existing.trashedAt === null) await deps.store.trashDatabase(dbId)
        await deps.store.purgeDatabase(dbId)
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'database.purged',
            target: `database:${existing.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      if (method === 'GET' && pathname === '/api/databases/users') {
        const caller = await requireCaller(req)
        const accountId = caller.principal.kind === 'user' ? caller.principal.accountId : (url.searchParams.get('accountId') ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.list')
        const users = (await deps.store.listDatabaseUsers(account.id)).map(user => ({ id: user.id, name: user.name, grants: user.grants }))
        return jsonResponse({ users })
      }

      if (method === 'POST' && pathname === '/api/databases/users') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<{ accountId?: Id; name?: string; password?: string; databaseId?: Id; privileges?: string[] }>(req)
        const accountId = caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId) return fail('VALIDATION', 'accountId is required')
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.create')
        const user = await deps.store.createDatabaseUser({
          accountId: account.id,
          name: ownedDatabaseName(account.username, body.name),
          authPlugin: 'mysql_native_password',
          authString: mysqlNativePasswordHash(body.password ?? ''),
        })
        const granted = body.databaseId
          ? await deps.store.setGrant({ databaseUserId: user.id, databaseId: body.databaseId, privileges: body.privileges ?? ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] })
          : user
        const reconcile = await triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
        await emitAudit({ actor: caller.principal.username, action: 'database_user.created', target: `database-user:${granted.name}`,
          outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ user: { id: granted.id, name: granted.name, grants: granted.grants }, reconcile: reconcile?.body ?? null }, 201)
      }

      const databaseUserGrantMatch = /^\/api\/databases\/users\/([0-9a-f-]{36})\/grants$/i.exec(pathname)
      if (method === 'POST' && databaseUserGrantMatch) {
        const caller = await requireCaller(req)
        const userId = databaseUserGrantMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabaseUser(userId)
        if (!existing) return fail('NOT_FOUND', 'database user not found')
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.grant')
        const body = await readJsonBody<{ databaseId?: Id; privileges?: string[] }>(req)
        if (!body.databaseId) return fail('VALIDATION', 'databaseId is required')
        const user = await deps.store.setGrant({ databaseUserId: existing.id, databaseId: body.databaseId, privileges: body.privileges ?? ['SELECT'] })
        const reconcile = await triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
        return jsonResponse({ user: { id: user.id, name: user.name, grants: user.grants }, reconcile: reconcile?.body ?? null })
      }

      const databaseUserMatch = /^\/api\/databases\/users\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'DELETE' && databaseUserMatch) {
        const caller = await requireCaller(req)
        const userId = databaseUserMatch[1]!.toLowerCase()
        const existing = await deps.store.getDatabaseUser(userId)
        if (!existing) return fail('NOT_FOUND', 'database user not found')
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', 'account not found')
        await assertCanAccessAccount(caller, account, 'database_user.delete')
        await deps.store.deleteDatabaseUser(existing.id)
        const reconcile = await triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
        await emitAudit({ actor: caller.principal.username, action: 'database_user.deleted', target: `database-user:${existing.name}`,
          outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
        return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
      }

      // ---- Service Users (Mailboxes & FTP) -------------------------------------------
      if (method === 'GET' && pathname === '/api/service-users') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'user') {
          return jsonResponse({
            serviceUsers: (await deps.store.listServiceUsers(caller.principal.accountId)).map(publicServiceUser),
          })
        }
        const accountId = url.searchParams.get('accountId')
        if (accountId) {
          const account = await deps.store.getAccount(accountId)
          if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
          await assertCanAccessAccount(caller, account, 'service_users.list')
          return jsonResponse({ serviceUsers: (await deps.store.listServiceUsers(account.id)).map(publicServiceUser) })
        }
        const snap = await deps.store.readSnapshot()
        if (caller.principal.kind === 'root') {
          return jsonResponse({ serviceUsers: snap.serviceUsers.map(publicServiceUser) })
        }
        const resellerId = await resolveResellerId(caller)
        const ownedIds = new Set((await ownedAccounts(deps.store, caller)).map(account => account.id))
        return jsonResponse({
          serviceUsers: snap.serviceUsers.filter((u) => ownedIds.has(u.accountId)).map(publicServiceUser),
        })
      }

      if (method === 'POST' && pathname === '/api/service-users') {
        const caller = await requireCaller(req)
        const body = await readJsonBody<
          Partial<NewServiceUser> & { domainId?: Id; localPart?: string; password?: string }
        >(req)
        const accountId =
          caller.principal.kind === 'user' ? caller.principal.accountId : (body.accountId ?? '')
        if (!accountId || !body.services) {
          return fail('VALIDATION', 'accountId and services are required')
        }
        const account = await deps.store.getAccount(accountId)
        if (!account) return fail('NOT_FOUND', `account "${accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'service_user.create')
        await assertAccountFeatures(deps.store, caller, account, [body.services.email ? 'email-accounts' : '', body.services.ftp ? 'ftp-accounts' : '', body.services.webdisk ? 'web-disk' : ''].filter(Boolean))

        let login = body.login
        if (!login && body.localPart && body.domainId) {
          const dom = await deps.store.getDomain(body.domainId)
          if (!dom || dom.accountId !== account.id) return fail('NOT_FOUND', 'domain not found')
          login = `${body.localPart}@${dom.name}`
        }
        if (!login) return fail('VALIDATION', 'login (or localPart + domainId) is required')

        const passwordHash = await passwordHashFromInput(body, { service: true })

        const serviceUser = await deps.store.createServiceUser({
          accountId: account.id,
          login,
          passwordHash,
          services: body.services,
          mailboxQuotaMb: body.mailboxQuotaMb ?? 1024,
          ftpDir: body.ftpDir ?? 'public_html',
        })
        const reconcile = await triggerReconcile(caller, {
          scope: { accountId: account.id, resellerId: account.ownerId },
        })
        await emitAudit(
          {
            actor: caller.principal.username,
            action: 'service_user.created',
            target: `service-user:${serviceUser.login}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          },
          { accountId: account.id, resellerId: account.ownerId },
        )
        return jsonResponse({ serviceUser: publicServiceUser(serviceUser), reconcile: reconcile?.body ?? null }, 201)
      }

      const serviceUserIdMatch = /^\/api\/service-users\/([0-9a-f-]{36})$/i.exec(pathname)
      if (serviceUserIdMatch) {
        const caller = await requireCaller(req)
        const suId = serviceUserIdMatch[1]!.toLowerCase()
        const existing = await deps.store.getServiceUser(suId)
        if (!existing) return fail('NOT_FOUND', `service user "${suId}" not found`)
        const account = await deps.store.getAccount(existing.accountId)
        if (!account) return fail('NOT_FOUND', `account "${existing.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'service_user.modify')

        if (method === 'PATCH') {
          const patch = await readJsonBody<ServiceUserPatch & { password?: string }>(req)
          const services = patch.services ?? existing.services
          await assertAccountFeatures(deps.store, caller, account, [services.email ? 'email-accounts' : '', services.ftp ? 'ftp-accounts' : '', services.webdisk ? 'web-disk' : ''].filter(Boolean))
          const resolvedPatch: ServiceUserPatch = {
            ...patch,
            ...(patch.password !== undefined || patch.passwordHash !== undefined
              ? { passwordHash: await passwordHashFromInput(patch, { service: true }) }
              : {}),
          }
          const serviceUser = await deps.store.updateServiceUser(suId, resolvedPatch)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          return jsonResponse({ serviceUser, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deleteServiceUser(suId)
          const reconcile = await triggerReconcile(caller, {
            scope: { accountId: account.id, resellerId: account.ownerId },
          })
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- DNS Zones -----------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/dns/zones') {
        const caller = await requireCaller(req)
        if (caller.principal.kind === 'root') {
          return jsonResponse({ zones: await deps.store.listDnsZones() })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          const zones = await deps.store.listDnsZones()
          return jsonResponse({ zones: zones.filter((z) => z.accountId && ownedIds.has(z.accountId)) })
        }
        return jsonResponse({ zones: await deps.store.listDnsZones(caller.principal.accountId) })
      }

      const dnsZoneMatch = /^\/api\/dns\/zones\/([^/]+)$/.exec(pathname)
      if (dnsZoneMatch) {
        const caller = await requireCaller(req)
        const zoneName = decodeURIComponent(dnsZoneMatch[1]!).toLowerCase()
        if (method === 'PUT') {
          const body = await readJsonBody<Partial<DnsZoneState>>(req)
          const existingZone = await deps.store.getDnsZone(zoneName)
          if (existingZone) {
            if (existingZone.accountId) {
              const existingOwner = await deps.store.getAccount(existingZone.accountId)
              if (!existingOwner) return fail('NOT_FOUND', 'zone not found')
              await assertCanAccessAccount(caller, existingOwner, 'dns.zone.save')
            } else if (caller.principal.kind !== 'root') return fail('NOT_FOUND', 'zone not found')
          }
          const zoneAccountId = caller.principal.kind === 'user'
            ? caller.principal.accountId
            : body.accountId !== undefined ? body.accountId : existingZone?.accountId ?? null
          if (caller.principal.kind !== 'root' && existingZone && zoneAccountId !== existingZone.accountId) return fail('FORBIDDEN', 'zone ownership cannot be changed')
          if (zoneAccountId) {
            const owner = await deps.store.getAccount(zoneAccountId)
            if (!owner) return fail('NOT_FOUND', 'account not found')
            await assertCanAccessAccount(caller, owner, 'dns.zone.save')
            if (!existingZone && caller.principal.kind !== 'root') await requireDomainAccount(deps.store, caller, zoneName, 'dns.zone.save', owner.id)
          } else await assertRoot(caller, 'dns.zone.save')
          const zone = await deps.store.saveDnsZone({
            id: body.id ?? existingZone?.id ?? randomUUID(),
            name: zoneName,
            accountId: zoneAccountId,
            serial: body.serial ?? (existingZone ? existingZone.serial + 1 : 2026102201),
            records: body.records ?? [],
          })
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'dns.zone.saved',
            target: `zone:${zone.name}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ zone, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          const existing = await deps.store.getDnsZone(zoneName)
          if (existing?.accountId) {
            const account = await deps.store.getAccount(existing.accountId)
            if (account) await assertCanAccessAccount(caller, account, 'dns.zone.delete')
          } else {
            await assertRoot(caller, 'dns.zone.delete')
          }
          await deps.store.deleteDnsZone(zoneName)
          const reconcile = await triggerReconcile(caller)
          await emitAudit({
            actor: caller.principal.username,
            action: 'dns.zone.deleted',
            target: `zone:${zoneName}`,
            outcome: 'ok',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- Firewall ------------------------------------------------------------------
      if (method === 'GET' && pathname === '/api/firewall') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.read')
        return jsonResponse(await deps.store.getFirewallState())
      }

      if (method === 'POST' && pathname === '/api/firewall/rules') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.create')
        const body = await readJsonBody<NewFirewallRule & { sessionIp?: string }>(req)
        const settings = await deps.store.getServerSettings()
        const guard: FirewallGuard = {
          lockout: {
            sessionIp: extractClientIp(req) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for firewall changes'),
            panelPort: settings?.panelPort ?? 2087,
            managementPorts: MANAGEMENT_PUBLIC_PORTS,
            sshPort: settings?.sshPort ?? 22,
          },
        }
        const rule = await deps.store.createFirewallRule(body, guard)
        const reconcile = await triggerReconcile(caller)
        await emitAudit({
          actor: caller.principal.username,
          action: 'firewall.rule.created',
          target: `firewall:${rule.id}`,
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ rule, reconcile: reconcile?.body ?? null }, 201)
      }

      const fwRuleMatch = /^\/api\/firewall\/rules\/([0-9a-f-]{36})$/i.exec(pathname)
      if (fwRuleMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'firewall.modify')
        const ruleId = fwRuleMatch[1]!.toLowerCase()
        const settings = await deps.store.getServerSettings()
        const guard: FirewallGuard = {
          lockout: {
            sessionIp: extractClientIp(req) ?? fail('PRECONDITION_FAILED', 'trusted transport peer is required for firewall changes'),
            panelPort: settings?.panelPort ?? 2087,
            managementPorts: MANAGEMENT_PUBLIC_PORTS,
            sshPort: settings?.sshPort ?? 22,
          },
        }
        if (method === 'PATCH') {
          const patch = await readJsonBody<Partial<Omit<FirewallRule, 'id'>>>(req)
          const rule = await deps.store.updateFirewallRule(ruleId, patch, guard)
          const reconcile = await triggerReconcile(caller)
          return jsonResponse({ rule, reconcile: reconcile?.body ?? null })
        }
        if (method === 'DELETE') {
          await deps.store.deleteFirewallRule(ruleId, guard)
          const reconcile = await triggerReconcile(caller)
          return jsonResponse({ ok: true, reconcile: reconcile?.body ?? null })
        }
      }

      // ---- IO Monitor & Website Analytics --------------------------------------------
      if (method === 'GET' && pathname === '/api/analytics/io') {
        const caller = await requireCaller(req)
        const principal = caller.principal
        const res = await callAgent('/analytics/io', {
          method: 'GET',
          caller,
        })
        if (!res.ok) return res
        const snap = (await res.json()) as IoAnalyticsSnapshot
        if (principal.kind === 'root') {
          return jsonResponse(snap)
        }
        if (principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const ownedIds = new Set(accounts.map((a) => a.id))
          return jsonResponse({
            ...snap,
            accounts: snap.accounts.filter((a) => ownedIds.has(a.accountId)),
          })
        }
        return jsonResponse({
          ...snap,
          accounts: snap.accounts.filter((a) => a.accountId === principal.accountId),
        })
      }

      if (method === 'POST' && pathname === '/api/analytics/websites/ingest') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'analytics.websites.ingest')
        const body = await readJsonBody(req)
        return callAgent('/analytics/websites/ingest', {
          method: 'POST',
          caller,
          body,
        })
      }

      const webAnalyticsMatch = /^\/api\/analytics\/websites\/([0-9a-f-]{36})$/i.exec(pathname)
      if (method === 'GET' && webAnalyticsMatch) {
        const caller = await requireCaller(req)
        const domainId = webAnalyticsMatch[1]!.toLowerCase()
        const domain = await deps.store.getDomain(domainId)
        if (!domain) return fail('NOT_FOUND', `domain "${domainId}" not found`)
        const account = await deps.store.getAccount(domain.accountId)
        if (!account) return fail('NOT_FOUND', `account "${domain.accountId}" not found`)
        await assertCanAccessAccount(caller, account, 'analytics.websites')
        const window = url.searchParams.get('window') ?? '24h'
        return callAgent(`/analytics/websites/${domainId}?window=${encodeURIComponent(window)}`, {
          method: 'GET',
          caller,
        })
      }

      // ---- Generations, Reconcile, Rollback & Audit ----------------------------------
      if (method === 'GET' && pathname === '/api/generations') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'generations.list')
        const [generations, currentGeneration] = await Promise.all([
          listGenerations(deps.db),
          latestActive(deps.db),
        ])
        return jsonResponse({ generations, currentGeneration })
      }

      if (method === 'POST' && pathname === '/api/reconcile') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'reconcile')
        const body = await readJsonBody<{ force?: boolean }>(req)
        return callAgent('/reconcile', {
          method: 'POST',
          caller,
          body: { force: Boolean(body.force) },
        })
      }

      const rollbackMatch = /^\/api\/generations\/(\d+)\/rollback$/.exec(pathname)
      if (method === 'POST' && rollbackMatch) {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'generations.rollback')
        const genId = Number(rollbackMatch[1])
        return callAgent(`/generations/${genId}/rollback`, {
          method: 'POST',
          caller,
          body: {},
        })
      }

      if (method === 'GET' && pathname === '/api/audit') {
        const caller = await requireCaller(req)
        const limit = Number(url.searchParams.get('limit') ?? '100') || 100
        const entries = await listAudit(deps.db, { limit })
        if (caller.principal.kind === 'root') {
          return jsonResponse({ entries })
        }
        if (caller.principal.kind === 'reseller') {
          const resellerId = await resolveResellerId(caller)
          const accounts = resellerId ? await ownedAccounts(deps.store, caller) : []
          const usernames = new Set(accounts.map((a) => a.username))
          return jsonResponse({
            entries: entries.filter(
              (e) =>
                e.actor === caller.principal.username ||
                usernames.has(e.actor) ||
                [...usernames].some((u) => e.target.includes(`account:${u}`)),
            ),
          })
        }
        return jsonResponse({
          entries: entries.filter(
            (e) =>
              e.actor === caller.principal.username ||
              e.target.startsWith(`account:${caller.principal.username}`),
          ),
        })
      }

      // ---- Root-Gated Lifecycle: Upgrade & Transfer ----------------------------------
      if (method === 'POST' && pathname === '/api/lifecycle/upgrade') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'lifecycle.upgrade')
        const agentApp = deps.agentApp
        if (!agentApp) {
          return fail('PRECONDITION_FAILED', 'verified privileged agent connection is required for upgrades')
        }
        const agentHealth = await callAgent('/health', { caller })
        if (!agentHealth.ok) {
          return fail('PRECONDITION_FAILED', 'privileged agent health check failed')
        }

        const body = await readJsonBody<
          Partial<PreflightInput> & { dryRun?: boolean; snapshotPath?: string }
        >(req)
        const osId = deps.os?.id ?? 'ubuntu'
        const osVer = deps.os?.versionId ?? '24.04'
        const preflightInput: PreflightInput = {
          freeBytes: body.freeBytes ?? 20 * 1024 * 1024 * 1024,
          releaseBytes: body.releaseBytes ?? 100 * 1024 * 1024,
          os: body.os ?? {
            id: osId,
            versionId: osVer,
            idLike: osId === 'ubuntu' || osId === 'debian' ? ['debian'] : ['rhel', 'fedora'],
            versionCodename: osId === 'ubuntu' ? 'noble' : '',
            name: osId,
            prettyName: `${osId} ${osVer}`,
            platformId: '',
            fields: {},
          },
          activeTransfers: body.activeTransfers ?? countActiveTransfers([...transferSessions.values()]),
          currentVersion: body.currentVersion ?? '0.1.0',
          targetVersion: body.targetVersion ?? '0.2.0',
          schemaVersions: body.schemaVersions ?? { current: 1, target: 1 },
        }

        const report = preflight(preflightInput)
        if (!report.ok) {
          await emitAudit({
            actor: caller.principal.username,
            action: 'lifecycle.upgrade.preflight_failed',
            target: `release:${preflightInput.targetVersion}`,
            detail: { report },
            outcome: 'failed',
            principalId: caller.principal.id,
          })
          return jsonResponse({ ok: false, report, upgrade: null }, 422)
        }

        const upgrade =
          body.dryRun === true
            ? null
            : await createUpgrade(deps.db, {
                fromVersion: preflightInput.currentVersion,
                toVersion: preflightInput.targetVersion,
                actor: caller.principal.username,
                fromSchemaVersion: preflightInput.schemaVersions.current,
                ...(body.snapshotPath && { snapshotPath: body.snapshotPath }),
              })

        await emitAudit({
          actor: caller.principal.username,
          action: 'lifecycle.upgrade.started',
          target: `release:${preflightInput.targetVersion}`,
          detail: { upgradeId: upgrade?.id ?? null, fromVersion: preflightInput.currentVersion },
          outcome: 'ok',
          principalId: caller.principal.id,
        })
        return jsonResponse({ ok: true, report, upgrade })
      }

      if (method === 'POST' && pathname === '/api/lifecycle/transfer') {
        const caller = await requireCaller(req)
        await assertRoot(caller, 'lifecycle.transfer')
        const agentApp = deps.agentApp
        if (!agentApp) {
          return fail('PRECONDITION_FAILED', 'verified privileged agent connection is required for transfers')
        }
        const agentHealth = await agentApp.fetch(new Request('http://agent.local/health'))
        if (!agentHealth.ok) {
          return fail('PRECONDITION_FAILED', 'privileged agent health check failed')
        }

        const buildLocalInventory = async (): Promise<LocalInventory> => {
          const [accounts, domains, plans] = await Promise.all([
            deps.store.listAccounts(),
            deps.store.listDomains(),
            deps.store.listPlans(),
          ])
          return {
            usernames: accounts.map((a) => a.username),
            domains: domains.map((d) => d.name),
            uids: accounts.map((a) => a.uid),
            plans: plans.map((p) => p.name),
          }
        }

        const body = await readJsonBody<{
          id?: string
          sessionId?: string
          auth?: unknown
          event?: TransferEvent
          events?: TransferEvent[]
        }>(req)

        const now = new Date().toISOString()
        let session: TransferSession

        if (body.sessionId && body.event) {
          const prev = transferSessions.get(body.sessionId)
          if (!prev) return fail('NOT_FOUND', `transfer session "${body.sessionId}" not found`)
          const ev =
            body.event.type === 'select' && !body.event.local
              ? { ...body.event, local: await buildLocalInventory() }
              : body.event
          session = transition(prev, ev, now)
        } else {
          const id = body.id ?? randomUUID()
          session = createTransferSession({
            id,
            actor: caller.principal.username,
            now,
            auth: body.auth ?? {
              kind: 'ssh-key',
              host: 'source.example.com',
              port: 22,
              user: 'root',
              keyId: randomUUID(),
              hostKeyFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            },
          })
          if (Array.isArray(body.events)) {
            for (const rawEv of body.events) {
              const ev =
                rawEv.type === 'select' && !rawEv.local
                  ? { ...rawEv, local: await buildLocalInventory() }
                  : rawEv
              session = transition(session, ev, new Date().toISOString())
            }
          }
        }

        transferSessions.set(session.id, session)
        const review =
          session.state === 'reviewed' || session.state === 'applying' ? buildReview(session) : null
        const digest = review ? reviewDigest(review) : session.reviewDigest

        await emitAudit({
          actor: caller.principal.username,
          action: 'lifecycle.transfer',
          target: `transfer:${session.id}`,
          detail: { state: session.state, reviewDigest: digest },
          outcome: 'ok',
          principalId: caller.principal.id,
        })

        return jsonResponse({ ok: true, session, review, digest })
      }

      // ---- Extended Capabilities Router ----------------------------------------------
      const extendedRes = await extendedRouter.handleExtendedRoute(req, url, method)
      if (extendedRes) {
        return extendedRes
      }

      // ---- Optional Web UI Renderer Fallback -----------------------------------------
      if (deps.webRenderer && !pathname.startsWith('/api/')) {
        return await deps.webRenderer(req)
      }

      return fail('NOT_FOUND', `route ${method} ${pathname} not found`)
    } catch (err) {
      if (!isXpanelError(err)) {
        await appendAudit(deps.db, {
          actor: 'system',
          action: 'api.internal_error',
          target: pathname,
          detail: { error: err instanceof Error ? err.message : String(err) },
          outcome: 'failed',
        }).catch(() => undefined)
      }
      const status = isXpanelError(err)
        ? (err.detail.lockedOut === true ? 429 : (STATUS_BY_CODE[err.code] ?? 400))
        : 500
      if ((status === 500 || status === 503) && prefersDocumentHtml(req, pathname, method)) {
        try { return renderTransportStatus(req, status) } catch { /* keep the problem document */ }
      }
      return problemResponse(err, pathname, method)
    }
  }

  return {
    fetch,
    hub,
    authenticateUpgrade,
  }
}

export interface ListenApiServerOptions {
  port?: number
  host?: string
  ingressSocketPath?: string
  ingressSocketMode?: number
}

/**
 * Starts the HTTP + WebSocket server for the xPanel API & Web UI, with an optional
 * verified UNIX domain / named-pipe ingress listener (`ingressSocketPath`).
 */
export const listenApiServer = async (
  app: ApiApp,
  opts: ListenApiServerOptions = {},
): Promise<{
  server: Server
  ingressServer?: Server
  port: number
  ingressSocketPath?: string
  close: () => Promise<void>
}> => {
  const buildHttpServer = (trustedIngress: boolean): Server => {
    const srv = createServer(async (req, res) => {
      if (trustedIngress) trustedIngressRequests.add(req)
      const writeResponse = async (response: Response): Promise<void> => {
        if (res.destroyed || res.writableEnded) return
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(await response.arrayBuffer()))
      }
      const requestPath = (req.url ?? '/').split('?')[0] ?? '/'
      const accountFileWrite = req.method === 'POST' && /^\/api\/accounts\/[a-z][a-z0-9]{2,15}\/files$/.test(requestPath)
      const maxBodyBytes = accountFileWrite ? 3 * 1024 * 1024 : 1024 * 1024
      try {
        const declaredLength = req.headers['content-length']
        const bodyLimit = accountFileWrite ? '3 MiB' : '1 MiB'
        if (declaredLength && Number(declaredLength) > maxBodyBytes) {
          await writeResponse(transportProblem(413, 'CONTENT_TOO_LARGE', `request body exceeds ${bodyLimit}`, req.url ?? '/'))
          req.resume()
          return
        }
        let bodyBytes = 0
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk)
          bodyBytes += bytes.byteLength
          if (bodyBytes > maxBodyBytes) {
            await writeResponse(transportProblem(413, 'CONTENT_TOO_LARGE', `request body exceeds ${bodyLimit}`, req.url ?? '/'))
            req.resume()
            return
          }
          chunks.push(bytes)
        }
        const body = chunks.length > 0 ? Buffer.concat(chunks, bodyBytes) : undefined
        const method = req.method ?? 'GET'
        const headers = new Headers()
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(key, value)
          else if (Array.isArray(value)) headers.set(key, value.join(', '))
        }
        const request = new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
          method,
          headers,
          ...(body && method !== 'GET' && method !== 'HEAD' ? { body } : {}),
        })
        const peer = req.socket.remoteAddress
        await writeResponse(
          await app.fetch(request, {
            ...(peer ? { remoteAddress: peer } : trustedIngress ? { remoteAddress: '127.0.0.1' } : {}),
            trustedIngress,
          }),
        )
      } catch (error) {
        await writeResponse(problemResponse(error, req.url ?? '/', req.method ?? '')).catch(() => res.destroy())
      }
    })
    srv.requestTimeout = 30_000
    srv.headersTimeout = 10_000
    srv.maxConnections = 128
    app.hub.attachToServer(srv, (req) => {
      if (trustedIngress) trustedIngressRequests.add(req)
      return app.authenticateUpgrade(req, { trustedIngress })
    })
    return srv
  }

  const server = buildHttpServer(false)

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolveListen())
  })

  let ingressServer: Server | undefined
  const ingressSocketPath = opts.ingressSocketPath
  if (ingressSocketPath) {
    if (!ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
      await rm(ingressSocketPath, { force: true }).catch(() => undefined)
    }
    ingressServer = buildHttpServer(true)
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        ingressServer!.once('error', rejectListen)
        ingressServer!.listen(ingressSocketPath, () => resolveListen())
      })
      if (process.platform !== 'win32' && !ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
        await chmod(ingressSocketPath, opts.ingressSocketMode ?? 0o660)
      }
    } catch (err) {
      server.closeAllConnections?.()
      await new Promise<void>((r) => server.close(() => r()))
      throw err
    }
  }

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : (opts.port ?? 0)

  return {
    server,
    ...(ingressServer && { ingressServer }),
    ...(ingressSocketPath && { ingressSocketPath }),
    port,
    close: async () => {
      await Promise.all([
        new Promise<void>((resolveClose) => {
          server.closeAllConnections?.()
          server.close(() => resolveClose())
        }),
        ingressServer
          ? new Promise<void>((resolveClose) => {
              ingressServer.closeAllConnections?.()
              ingressServer.close(() => resolveClose())
            })
          : Promise.resolve(),
      ])
      if (ingressSocketPath && !ingressSocketPath.startsWith('\\\\.\\pipe\\')) {
        await rm(ingressSocketPath, { force: true }).catch(() => undefined)
      }
    },
  }
}

/**
 * Helper to ensure a default `root` principal exists in the control database.
 */
export const ensureRootPrincipal = async (
  db: Db,
  opts: { password?: string; passwordHash?: string; forcePasswordChange?: boolean } = {},
) => {
  const existing = await findPrincipalByUsername(db, 'root')
  if (existing) return existing
  const passwordHash = await passwordHashFromInput(opts)
  return createRootPrincipal(db, {
    username: 'root',
    passwordHash,
    forcePasswordChange: opts.forcePasswordChange ?? true,
  })
}

import { createHash, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { fail, isUuid, isXpanelError } from '@xpanel/core'
import { findExternalIdentity, getPrincipal, linkExternalIdentity, listExternalIdentities, revokeProviderIdentities, touchExternalIdentity, unlinkExternalIdentity } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { parseCookies } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { entryPointAdmitsPrincipal } from './entry-points.ts'
import type { EntryPoint } from './entry-points.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertOwnSession, bodyOf, expectedRevision, invalid, json, object, reauthenticate, unchanged } from './identity-http.ts'
import type { ReauthenticationPorts } from './identity-http.ts'
import { authorizationUrl, exchangeCode, fetchJson, issuerUrl, parseDiscovery, parseJwks, pkcePair, randomToken, verifyIdToken } from './oidc-protocol.ts'
import type { OidcDiscovery, OidcFetch, OidcIdentity, OidcKey } from './oidc-protocol.ts'

/**
 * cPanel Manage External Authentications with OpenID Connect providers configured by root. A provider identity signs
 * in only after its owner linked it from a signed-in, password-confirmed session; nothing is matched by e-mail and no
 * principal is created. Local two-factor authentication still applies. xMail is excluded: a mailbox session needs the
 * mailbox password for IMAP.
 */
export const EXTERNAL_AUTH_STATE = 'extended/panel/external-auth.json'
export const CALLBACK_PATH = '/api/auth/oidc/callback'
const MAX_PROVIDERS = 8
const FLOW_TTL_MS = 10 * 60_000
const MAX_FLOWS = 512
const METADATA_TTL_MS = 10 * 60_000
const KEY_REFRESH_MS = 60_000
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const CLIENT_TEXT = /^[\x21-\x7e]{1,512}$/
const PANEL_ENTRY_POINTS = ['xpanel', 'xwhm'] as const
type PanelEntry = typeof PANEL_ENTRY_POINTS[number]

interface ProviderRecord {
  id: string
  label: string
  issuer: string
  clientId: string
  clientSecret: string
  entryPoints: Record<PanelEntry, boolean>
  createdAt: string
  updatedAt: string
}
interface ProvidersFile { version: 1; providers: ProviderRecord[] }

const parseFile = (raw: unknown): ProvidersFile | null => {
  if (raw === null) return { version: 1, providers: [] }
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.providers) || raw.providers.length > MAX_PROVIDERS) return null
  const providers: ProviderRecord[] = []
  for (const item of raw.providers) {
    if (!object(item) || Object.keys(item).sort().join() !== 'clientId,clientSecret,createdAt,entryPoints,id,issuer,label,updatedAt') return null
    const entry = item.entryPoints
    if (typeof item.id !== 'string' || !PROVIDER_ID.test(item.id) || typeof item.label !== 'string' || !/^[^\u0000-\u001f\u007f]{1,64}$/u.test(item.label) || issuerUrl(item.issuer) !== item.issuer
      || typeof item.clientId !== 'string' || !CLIENT_TEXT.test(item.clientId) || typeof item.clientSecret !== 'string' || !CLIENT_TEXT.test(item.clientSecret)
      || !object(entry) || Object.keys(entry).sort().join() !== 'xpanel,xwhm' || typeof entry.xpanel !== 'boolean' || typeof entry.xwhm !== 'boolean'
      || typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return null
    providers.push(item as unknown as ProviderRecord)
  }
  return new Set(providers.map(item => item.id)).size === providers.length ? { version: 1, providers } : null
}
/** The revision covers secret digests, never secret bytes. */
const fileRevision = (raw: unknown): string => {
  const file = parseFile(raw)
  const redacted = file ? { ...file, providers: file.providers.map(item => ({ ...item, clientSecret: createHash('sha256').update(item.clientSecret).digest('hex') })) } : { invalid: true }
  return createHash('sha256').update(JSON.stringify(redacted)).digest('hex')
}
const publicProvider = (item: ProviderRecord) => ({ id: item.id, label: item.label, issuer: item.issuer, clientId: item.clientId, entryPoints: { ...item.entryPoints }, createdAt: item.createdAt, updatedAt: item.updatedAt })

interface Flow {
  binding: string
  purpose: 'sign-in' | 'link'
  providerId: string
  issuer: string
  entryPoint: PanelEntry
  state: string
  nonce: string
  verifier: string
  redirectUri: string
  returnTo: string
  createdAt: number
  principalId: string | null
  sessionId: string | null
  verified: OidcIdentity | null
}

export interface ExternalAuthHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'>, Omit<ReauthenticationPorts, 'requireCaller' | 'emitAudit'> {
  db: Db
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  entryPoint: EntryPoint | undefined
  /** This listener's exact public HTTPS origin; without it no redirect URI can be registered and sign-in stays unavailable. */
  publicOrigin: string | undefined
  /** Public origins of the other panel listeners, shown to root as redirect URIs to register. */
  otherOrigins?: Partial<Record<PanelEntry, string>>
  secureCookies: (request: Request) => boolean
  fetch: OidcFetch
  now?: () => number
}

export interface ExternalSignIn { principalId: string; username: string; providerId: string }

/** The providers root enabled for a panel listener, for its sign-in page; a damaged file offers none. */
export async function enabledProvidersFor(rootDir: string, entryPoint: EntryPoint | undefined): Promise<{ id: string; label: string }[]> {
  if (entryPoint !== 'xpanel' && entryPoint !== 'xwhm') return []
  let raw: unknown
  try { raw = await readJsonIfExists<unknown>(join(rootDir, EXTERNAL_AUTH_STATE)) } catch { return [] }
  return (parseFile(raw)?.providers ?? []).filter(item => item.entryPoints[entryPoint]).map(item => ({ id: item.id, label: item.label }))
}

export interface ExternalAuth {
  handle(request: Request, url: URL, method: string): Promise<Response | null>
  /** The sign-in step: the verified, linked identity of this browser's completed provider sign-in; consumed once. */
  redeemSignIn(request: Request): Promise<ExternalSignIn>
}

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest()
const sameSecret = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right))

export function createExternalAuth(helpers: ExternalAuthHelpers): ExternalAuth {
  const now = helpers.now ?? Date.now
  const flows = new Map<string, Flow>()
  const metadata = new Map<string, { at: number; discovery: OidcDiscovery; keys: OidcKey[]; keysAt: number }>()
  const entry: PanelEntry | null = helpers.entryPoint === 'xpanel' || helpers.entryPoint === 'xwhm' ? helpers.entryPoint : null
  const cookieName = (request: Request) => (helpers.secureCookies(request) ? '__Host-' : '') + 'xpanel_external'
  const cookie = (request: Request, value: string, maxAge: number) =>
    `${cookieName(request)}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${helpers.secureCookies(request) ? '; Secure' : ''}`
  const bindingOf = (request: Request): string | null => {
    const value = parseCookies(request.headers.get('cookie'))[cookieName(request)]
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
  }
  const sweep = () => { const cutoff = now() - FLOW_TTL_MS; for (const [key, flow] of flows) if (flow.createdAt <= cutoff) flows.delete(key) }
  const flowOf = (request: Request): Flow | null => {
    sweep()
    const binding = bindingOf(request)
    if (!binding) return null
    for (const flow of flows.values()) if (flow.verified && sameSecret(flow.binding, binding)) return flow
    return null
  }

  const readRaw = async (): Promise<unknown> => { try { return await readJsonIfExists<unknown>(join(helpers.store.rootDir, EXTERNAL_AUTH_STATE)) } catch { return { invalid: true } } }
  const readFileOrFail = async (): Promise<{ raw: unknown; file: ProvidersFile }> => {
    const raw = await readRaw(), file = parseFile(raw)
    return file ? { raw, file } : fail('PRECONDITION_FAILED', 'the saved external authentication configuration requires review', { ...unchanged, reason: 'configuration_invalid' })
  }
  const enabledProvider = async (id: string, at: PanelEntry): Promise<ProviderRecord> => {
    const file = parseFile(await readRaw())
    const provider = file?.providers.find(item => item.id === id)
    return provider && provider.entryPoints[at] ? provider : fail('FORBIDDEN', 'this identity provider is not enabled for this panel', { ...unchanged, reason: 'provider_disabled' })
  }
  const providerMetadata = async (provider: Pick<ProviderRecord, 'issuer'>, refreshKeys = false): Promise<{ discovery: OidcDiscovery; keys: OidcKey[] }> => {
    const cached = metadata.get(provider.issuer)
    if (cached && now() - cached.at < METADATA_TTL_MS && !(refreshKeys && now() - cached.keysAt >= KEY_REFRESH_MS)) return cached
    const discovery = cached && now() - cached.at < METADATA_TTL_MS ? cached.discovery
      : parseDiscovery(await fetchJson(helpers.fetch, provider.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration'), provider.issuer)
    const keys = parseJwks(await fetchJson(helpers.fetch, discovery.jwksUri))
    const entryValue = { at: cached && discovery === cached.discovery ? cached.at : now(), discovery, keys, keysAt: now() }
    if (metadata.size >= MAX_PROVIDERS * 2) metadata.clear()
    metadata.set(provider.issuer, entryValue)
    return entryValue
  }
  const redirectUri = (): string => helpers.publicOrigin ? helpers.publicOrigin + CALLBACK_PATH : fail('PRECONDITION_FAILED', 'external sign-in needs the exact public HTTPS origin of this panel', { ...unchanged, reason: 'public_origin_required' })
  const available = (request: Request): PanelEntry => {
    if (!entry) return fail('FORBIDDEN', 'external sign-in is not available on this panel', { ...unchanged, reason: 'entry_point_unsupported' })
    if (!helpers.secureCookies(request)) return fail('PRECONDITION_FAILED', 'external sign-in requires HTTPS', { ...unchanged, reason: 'https_required' })
    redirectUri()
    return entry
  }

  async function begin(request: Request, input: { purpose: Flow['purpose']; provider: ProviderRecord; at: PanelEntry; caller: AuthenticatedCaller | null }): Promise<{ url: string; setCookie: string }> {
    const { discovery } = await providerMetadata(input.provider)
    sweep()
    if (flows.size >= MAX_FLOWS) return fail('SERVICE_UNAVAILABLE', 'too many external sign-ins are in progress; try again shortly', unchanged)
    const binding = randomToken(), state = randomToken(), nonce = randomToken(), pkce = pkcePair(), uri = redirectUri()
    flows.set(state, { binding, purpose: input.purpose, providerId: input.provider.id, issuer: input.provider.issuer, entryPoint: input.at, state, nonce, verifier: pkce.verifier, redirectUri: uri,
      returnTo: input.purpose === 'sign-in' ? '/login' : input.at === 'xwhm' ? '/whm/security/sign-in' : '/security/account', createdAt: now(),
      principalId: input.caller?.principal.id ?? null, sessionId: input.caller?.sessionId ?? null, verified: null })
    return { url: authorizationUrl(discovery, { clientId: input.provider.clientId, redirectUri: uri, state, nonce, challenge: pkce.challenge }), setCookie: cookie(request, binding, FLOW_TTL_MS / 1000) }
  }
  const redirect = (location: string, setCookie?: string): Response =>
    new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(setCookie ? { 'set-cookie': setCookie } : {}) } })
  const outcome = (path: string, result: 'verified' | 'failed', reason?: string) => `${path}?external=${result}${reason ? '&reason=' + encodeURIComponent(reason) : ''}`

  async function callback(request: Request, url: URL): Promise<Response> {
    sweep()
    const state = url.searchParams.get('state') ?? ''
    const flow = /^[A-Za-z0-9_-]{43}$/.test(state) ? flows.get(state) : undefined
    const binding = bindingOf(request)
    // The state is single-use and must come back to the browser that started the flow (login CSRF defence).
    if (!flow || flow.verified || !binding || !sameSecret(flow.binding, binding) || flow.entryPoint !== entry) {
      if (flow && !flow.verified) flows.delete(state)
      await helpers.emitAudit({ actor: 'anonymous', action: 'auth.external_failed', target: 'external-auth', outcome: 'denied', detail: { reason: 'state_invalid' } }).catch(() => undefined)
      return redirect(outcome('/login', 'failed', 'state_invalid'))
    }
    flows.delete(state)
    const refused = async (reason: string): Promise<Response> => {
      await helpers.emitAudit({ actor: 'anonymous', action: 'auth.external_failed', target: 'provider:' + flow.providerId, outcome: 'denied', detail: { reason, purpose: flow.purpose } }).catch(() => undefined)
      return redirect(outcome(flow.returnTo, 'failed', reason))
    }
    try {
      const provider = await enabledProvider(flow.providerId, flow.entryPoint)
      if (provider.issuer !== flow.issuer) return refused('provider_changed')
      if (url.searchParams.has('error')) { const code = url.searchParams.get('error') ?? ''; return refused(/^[a-z_]{1,64}$/.test(code) ? 'provider_' + code : 'provider_error') }
      // RFC 9207: an authorization response that names its issuer must name this provider (mix-up defence).
      if (url.searchParams.has('iss') && url.searchParams.get('iss') !== provider.issuer) return refused('issuer_mismatch')
      const code = url.searchParams.get('code') ?? ''
      if (!code || code.length > 2048 || /[\u0000- \u007f]/.test(code)) return refused('code_missing')
      const { discovery } = await providerMetadata(provider)
      const idToken = await exchangeCode(helpers.fetch, discovery, { clientId: provider.clientId, clientSecret: provider.clientSecret, code, redirectUri: flow.redirectUri, verifier: flow.verifier })
      const verify = (keys: readonly OidcKey[]) => verifyIdToken(idToken, { keys, issuer: provider.issuer, clientId: provider.clientId, nonce: flow.nonce, algorithms: discovery.algorithms, now: new Date(now()) })
      let identity: OidcIdentity
      try { identity = verify((await providerMetadata(provider)).keys) } catch (error) {
        // A provider that rotated its keys gets one key-set refresh, rate limited.
        if (!isXpanelError(error) || error.detail.reason !== 'id_token_key_unknown') throw error
        identity = verify((await providerMetadata(provider, true)).keys)
      }
      flows.set(state, { ...flow, verified: identity, createdAt: now() })
      await helpers.emitAudit({ actor: 'anonymous', action: 'auth.external_verified', target: 'provider:' + provider.id, outcome: 'ok', detail: { purpose: flow.purpose } })
      return redirect(outcome(flow.returnTo, 'verified'))
    } catch (error) {
      return refused(isXpanelError(error) && typeof error.detail.reason === 'string' ? error.detail.reason : 'provider_unavailable')
    }
  }

  /** The verified identity waiting in this browser; consumed only by the caller that finishes it. */
  const takeVerified = (request: Request, purpose: Flow['purpose']): Flow => {
    const flow = flowOf(request)
    if (!flow || flow.purpose !== purpose || flow.entryPoint !== entry) return fail('UNAUTHENTICATED', 'no verified external sign-in is waiting in this browser; start again', { ...unchanged, reason: 'external_flow_missing' })
    flows.delete(flow.state)
    return flow
  }

  async function redeemSignIn(request: Request): Promise<ExternalSignIn> {
    const at = available(request)
    const flow = takeVerified(request, 'sign-in')
    await enabledProvider(flow.providerId, at)
    const link = await findExternalIdentity(helpers.db, flow.issuer, flow.verified!.subject)
    const principal = link && link.providerId === flow.providerId ? await getPrincipal(helpers.db, link.principalId) : null
    if (!link || !principal || principal.disabled || !entryPointAdmitsPrincipal(at, principal)) {
      await helpers.emitAudit({ actor: 'anonymous', action: 'auth.external_not_linked', target: 'provider:' + flow.providerId, outcome: 'denied' }).catch(() => undefined)
      return fail('UNAUTHENTICATED', 'this external identity is not linked to a user of this panel', { ...unchanged, reason: 'identity_not_linked' })
    }
    await touchExternalIdentity(helpers.db, link.id, new Date(now()))
    return { principalId: principal.id, username: principal.username, providerId: flow.providerId }
  }

  async function ownView(caller: AuthenticatedCaller, at: PanelEntry | null) {
    const file = parseFile(await readRaw())
    const providers = (file?.providers ?? []).filter(item => at && item.entryPoints[at])
    const labels = new Map((file?.providers ?? []).map(item => [item.id, item.label]))
    const identities = (await listExternalIdentities(helpers.db, { principalId: caller.principal.id })).map(item =>
      ({ id: item.id, providerId: item.providerId, providerLabel: labels.get(item.providerId) ?? null, label: item.label, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt }))
    return { available: Boolean(at && helpers.publicOrigin && file), reason: !at ? 'entry_point_unsupported' : !helpers.publicOrigin ? 'public_origin_required' : !file ? 'configuration_invalid' : null,
      providers: providers.map(item => ({ id: item.id, label: item.label })), identities }
  }

  async function own(request: Request, url: URL, method: string): Promise<Response> {
    const base = '/api/auth/external-identities'
    const id = url.pathname.length > base.length + 1 ? url.pathname.slice(base.length + 1) : null
    const start = url.pathname === base + '/start'
    const allowed = start ? ['POST'] : id ? ['DELETE'] : ['GET', 'POST']
    if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
    if (url.search) return invalid('external identities accept no selectors')
    const caller = await helpers.requireCaller(request)
    assertOwnSession(caller)
    if (method === 'GET') return json(await ownView(caller, entry))
    if (id && !start) {
      if (!isUuid(id)) return fail('NOT_FOUND', 'external identity not found', unchanged)
      const removed = await unlinkExternalIdentity(helpers.db, id, caller.principal.id)
      if (!removed) return fail('NOT_FOUND', 'external identity not found', unchanged)
      await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'auth.external_identity_unlinked', target: 'provider:' + removed.providerId, outcome: 'ok' })
      return json(await ownView(caller, entry))
    }
    const at = available(request)
    if (start) {
      const body = await bodyOf(request, 2048, ['currentPassword', 'providerId'], ['currentPassword', 'providerId'])
      if (typeof body.providerId !== 'string' || !PROVIDER_ID.test(body.providerId)) return invalid('choose an identity provider')
      const provider = await enabledProvider(body.providerId, at)
      // Linking is the explicit, verified action: the password is confirmed before the provider is contacted.
      const fresh = await reauthenticate(request, caller, helpers, { password: body.currentPassword, action: 'external_identity_link' })
      const flow = await begin(request, { purpose: 'link', provider, at, caller: fresh })
      return json({ authorizationUrl: flow.url }, 200, { 'set-cookie': flow.setCookie })
    }
    await bodyOf(request, 64, [])
    const flow = takeVerified(request, 'link')
    if (flow.principalId !== caller.principal.id || flow.sessionId !== caller.sessionId) return fail('FORBIDDEN', 'the link was started from another session', { ...unchanged, reason: 'external_flow_session' })
    await enabledProvider(flow.providerId, at)
    const linked = await linkExternalIdentity(helpers.db, { principalId: caller.principal.id, providerId: flow.providerId, issuer: flow.issuer, subject: flow.verified!.subject, label: flow.verified!.label }, new Date(now()))
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'auth.external_identity_linked', target: 'provider:' + linked.providerId, outcome: 'ok' })
    return json(await ownView(caller, entry), 201, { 'set-cookie': cookie(request, '', 0) })
  }

  /** Root: provider configuration (secrets write-only) and every linked identity. */
  async function server(request: Request, url: URL, method: string): Promise<Response> {
    const linkId = url.pathname.startsWith('/api/server/sec/external-auth/links/') ? url.pathname.slice('/api/server/sec/external-auth/links/'.length) : null
    const allowed = linkId !== null ? ['DELETE'] : ['GET', 'PUT']
    if (!allowed.includes(method)) return new Response(null, { status: 405, headers: { allow: allowed.join(', ') } })
    if (url.search) return invalid('external authentication accepts no selectors')
    const action = method === 'GET' ? 'server.sec.external_auth.read' : linkId !== null ? 'server.sec.external_auth.unlink' : 'server.sec.external_auth.update'
    const caller = await helpers.requireCaller(request)
    await helpers.assertRoot(caller, action)
    const view = async (raw: unknown) => {
      const file = parseFile(raw)
      const identities = await listExternalIdentities(helpers.db)
      const names = new Map<string, string>()
      for (const id of new Set(identities.map(item => item.principalId))) { const principal = await getPrincipal(helpers.db, id); if (principal) names.set(id, principal.username) }
      const origins: Partial<Record<PanelEntry, string>> = { ...helpers.otherOrigins, ...(entry && helpers.publicOrigin ? { [entry]: helpers.publicOrigin } : {}) }
      return { state: raw === null ? 'default' : file ? 'saved' : 'invalid', revision: fileRevision(raw), providers: file?.providers.map(publicProvider) ?? [],
        redirectUris: Object.fromEntries(PANEL_ENTRY_POINTS.filter(name => origins[name]).map(name => [name, origins[name] + CALLBACK_PATH])),
        identities: identities.map(item => ({ id: item.id, principal: names.get(item.principalId) ?? null, providerId: item.providerId, label: item.label, createdAt: item.createdAt, lastUsedAt: item.lastUsedAt })) }
    }
    if (method === 'GET') return json(await view(await readRaw()))
    if (linkId !== null) {
      if (!isUuid(linkId)) return fail('NOT_FOUND', 'external identity not found', unchanged)
      const removed = await unlinkExternalIdentity(helpers.db, linkId)
      if (!removed) return fail('NOT_FOUND', 'external identity not found', unchanged)
      await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.external_auth.unlinked', target: 'provider:' + removed.providerId, outcome: 'ok', detail: { principalId: removed.principalId } })
      return json(await view(await readRaw()))
    }
    const body = await bodyOf(request, 32 * 1024, ['expectedRevision', 'providers'], ['expectedRevision', 'providers'])
    const expected = expectedRevision(body.expectedRevision)
    if (!Array.isArray(body.providers) || body.providers.length > MAX_PROVIDERS) return invalid(`at most ${MAX_PROVIDERS} identity providers are allowed`)
    const { raw, file } = await readFileOrFail()
    if (fileRevision(raw) !== expected) return fail('CONFLICT', 'the provider configuration changed; reload before saving', unchanged)
    const at = new Date(now()).toISOString(), current = new Map(file.providers.map(item => [item.id, item]))
    const providers: ProviderRecord[] = []
    for (const item of body.providers) {
      if (!object(item) || Object.keys(item).some(key => !['clientId', 'clientSecret', 'entryPoints', 'id', 'issuer', 'label'].includes(key))) return invalid('each provider has id, label, issuer, clientId, clientSecret and entryPoints')
      if (typeof item.id !== 'string' || !PROVIDER_ID.test(item.id)) return invalid('a provider id is 1 to 32 lowercase letters, digits and dashes')
      const label = typeof item.label === 'string' ? item.label.trim() : ''
      if (!/^[^\u0000-\u001f\u007f]{1,64}$/u.test(label)) return invalid('a provider name is 1 to 64 characters')
      const issuer = issuerUrl(item.issuer)
      if (!issuer) return invalid('the issuer must be an https URL without query or fragment')
      if (typeof item.clientId !== 'string' || !CLIENT_TEXT.test(item.clientId)) return invalid('the client ID is 1 to 512 visible characters')
      const previous = current.get(item.id)
      if (previous && previous.issuer !== issuer) return invalid('the issuer of a saved provider cannot change; remove it and add it again')
      const secret = item.clientSecret === undefined ? previous?.clientSecret : item.clientSecret
      if (typeof secret !== 'string' || !CLIENT_TEXT.test(secret)) return invalid('the client secret is 1 to 512 visible characters')
      const entryPoints = item.entryPoints
      if (!object(entryPoints) || Object.keys(entryPoints).sort().join() !== 'xpanel,xwhm' || typeof entryPoints.xpanel !== 'boolean' || typeof entryPoints.xwhm !== 'boolean') return invalid('entryPoints must say whether xPanel and xWHM offer the provider')
      // A new or re-pointed provider must pass discovery now; a misconfigured one is never saved.
      if (!previous || previous.clientId !== item.clientId) await providerMetadata({ issuer })
      providers.push({ id: item.id, label, issuer, clientId: item.clientId, clientSecret: secret, entryPoints: { xpanel: entryPoints.xpanel, xwhm: entryPoints.xwhm },
        createdAt: previous?.createdAt ?? at, updatedAt: previous && previous.label === label && previous.clientId === item.clientId && previous.clientSecret === secret
          && previous.entryPoints.xpanel === entryPoints.xpanel && previous.entryPoints.xwhm === entryPoints.xwhm ? previous.updatedAt : at })
    }
    if (new Set(providers.map(item => item.id)).size !== providers.length) return invalid('provider ids must be unique')
    const next: ProvidersFile = { version: 1, providers }
    const removed = file.providers.filter(item => !providers.some(kept => kept.id === item.id)).map(item => item.id)
    // Discovery ran before the writer lock; the saved file must still be the one this change was built on.
    const lease = await helpers.store.getWriterLock().acquire()
    try {
      const fresh = await helpers.requireCaller(request)
      await helpers.assertRoot(fresh, action)
      if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'root authorization changed', unchanged)
      if (fileRevision(await readRaw()) !== expected) return fail('CONFLICT', 'the provider configuration changed; reload before saving', unchanged)
      await lease.assertFencingToken()
      await atomicWriteJson(join(helpers.store.rootDir, EXTERNAL_AUTH_STATE), next, 0o600, () => lease.assertFencingToken())
    } finally { await lease.release() }
    let revoked = 0
    for (const id of removed) revoked += await revokeProviderIdentities(helpers.db, id)
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.sec.external_auth.saved', target: 'server:sec:external-auth', outcome: 'ok', detail: { providers: next.providers.length, removed: removed.length, revokedIdentities: revoked } })
    return json(await view(next))
  }

  async function handle(request: Request, url: URL, method: string): Promise<Response | null> {
    const path = url.pathname
    if (path === '/api/server/sec/external-auth' || path.startsWith('/api/server/sec/external-auth/links/')) return server(request, url, method)
    if (path === '/api/auth/external-identities' || path.startsWith('/api/auth/external-identities/')) return own(request, url, method)
    if (!path.startsWith('/api/auth/oidc/')) return null
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (path === '/api/auth/oidc/start') {
      const query = [...url.searchParams]
      if (query.length !== 1 || query[0]![0] !== 'provider' || !PROVIDER_ID.test(query[0]![1])) return redirect(outcome('/login', 'failed', 'provider_unknown'))
      try {
        const at = available(request)
        const flow = await begin(request, { purpose: 'sign-in', provider: await enabledProvider(query[0]![1], at), at, caller: null })
        return redirect(flow.url, flow.setCookie)
      } catch (error) {
        return redirect(outcome('/login', 'failed', isXpanelError(error) && typeof error.detail.reason === 'string' ? error.detail.reason : 'provider_unavailable'))
      }
    }
    if (path === CALLBACK_PATH) return callback(request, url)
    if (path === '/api/auth/oidc/pending') {
      if (url.search) return invalid('the pending sign-in accepts no selectors')
      const flow = flowOf(request)
      if (!flow || flow.purpose !== 'sign-in' || flow.entryPoint !== entry) return json({ pending: false })
      const file = parseFile(await readRaw()), provider = file?.providers.find(item => item.id === flow.providerId)
      const link = await findExternalIdentity(helpers.db, flow.issuer, flow.verified!.subject)
      const principal = link && link.providerId === flow.providerId ? await getPrincipal(helpers.db, link.principalId) : null
      if (!principal) { flows.delete(flow.state); return json({ pending: false, reason: 'identity_not_linked', provider: provider ? { id: provider.id, label: provider.label } : null }) }
      return json({ pending: true, provider: provider ? { id: provider.id, label: provider.label } : null, username: principal.username, secondFactor: principal.totpEnabled ? 'enrolled' : 'none' })
    }
    return null
  }

  return { handle, redeemSignIn }
}

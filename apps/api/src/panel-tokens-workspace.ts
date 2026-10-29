import { randomBytes } from 'node:crypto'
import { fail, formatCidr, parseCidr } from '@xpanel/core'
import { createApiToken, listApiTokensForPrincipal, revokeApiToken } from '@xpanel/db'
import type { ApiTokenRecord } from '@xpanel/db'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export type PanelTokensWorkspaceHelpers = Pick<ExtendedRouteHelpers, 'db' | 'requireCaller' | 'assertRoot' | 'emitAudit'>

/** Every resource policyForRequest (authorization.ts) assigns, plus the direct events/tls scope checks. A token grants `<resource>:read|write`. */
export const API_TOKEN_SCOPE_RESOURCES = [
  'accounts', 'account-preferences', 'analytics', 'apps', 'audit', 'auth', 'backups', 'branding', 'cache', 'catalog', 'cluster', 'containers', 'cron',
  'databases', 'dns', 'domains', 'events', 'feature-lists', 'files', 'firewall', 'generations', 'git', 'ips', 'jobs', 'languages', 'lifecycle', 'mail',
  'plans', 'reconcile', 'resellers', 'search', 'security', 'server', 'service-users', 'shell', 'tls', 'webmail', 'whmcs',
] as const
export const API_TOKEN_ALL_SCOPES = '*'
export const API_TOKEN_MAX_ACTIVE = 50
const KNOWN_SCOPES = new Set(API_TOKEN_SCOPE_RESOURCES.flatMap(resource => [resource + ':read', resource + ':write']))
const ROUTE = /^\/api\/server\/panel\/api-tokens(?:\/([^/]+)\/(revoke))?$/
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MAX_BODY_BYTES = 16 * 1024
const LIST_LIMIT = 200
const DAY_MS = 86_400_000
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export type ApiTokenState = 'active' | 'expired' | 'revoked'
const stateOf = (token: ApiTokenRecord, now: number): ApiTokenState => token.revokedAt !== null ? 'revoked' : Date.parse(token.expiresAt) <= now ? 'expired' : 'active'
/** The public listing. The stored hash never leaves the server. */
const view = (token: ApiTokenRecord, now: number) => ({
  id: token.id, name: token.name, scopes: token.scopes, allowedIps: token.allowedIps, createdAt: token.createdAt, expiresAt: token.expiresAt,
  lastUsedAt: token.lastUsedAt, lastUsedIp: token.lastUsedIp, revokedAt: token.revokedAt, state: stateOf(token, now),
})

export interface ApiTokenCreateInput { name: string; scopes: string[]; expiresInDays: number; allowedIps: string[] }

/** Strict create grammar: exact keys, a known scope subset ('*' only alone), 1..365 days and canonical IPv4/IPv6 addresses or CIDR networks. */
export function parseApiTokenCreate(body: unknown): ApiTokenCreateInput {
  if (!object(body) || Object.keys(body).some(key => !['name', 'scopes', 'expiresInDays', 'allowedIps'].includes(key))) return invalid('only name, scopes, expiresInDays and allowedIps are accepted')
  if (typeof body.name !== 'string' || !NAME_RE.test(body.name)) return invalid('name must be 1 to 64 lowercase letters, digits and inner dashes')
  const scopes = body.scopes
  if (!Array.isArray(scopes) || scopes.length < 1 || scopes.length > KNOWN_SCOPES.size || new Set(scopes).size !== scopes.length
    || !scopes.every(scope => typeof scope === 'string' && (scope === API_TOKEN_ALL_SCOPES || KNOWN_SCOPES.has(scope)))) return invalid('scopes must be a non-empty set of known <resource>:read or <resource>:write scopes')
  if (scopes.includes(API_TOKEN_ALL_SCOPES) && scopes.length !== 1) return invalid('the all-scopes grant must be the only scope')
  if (!Number.isSafeInteger(body.expiresInDays) || (body.expiresInDays as number) < 1 || (body.expiresInDays as number) > 365) return invalid('expiresInDays must be an integer from 1 to 365')
  const raw = body.allowedIps ?? []
  if (!Array.isArray(raw) || raw.length > 16) return invalid('allowedIps must list at most 16 addresses or networks')
  const allowedIps = raw.map(entry => {
    const cidr = typeof entry === 'string' && entry.length <= 49 ? parseCidr(entry) : null
    return cidr ? formatCidr(cidr) : invalid('each allowed address must be an IPv4 or IPv6 address or a CIDR network with zero host bits')
  })
  if (new Set(allowedIps).size !== allowedIps.length) return invalid('allowed addresses must not repeat')
  return { name: body.name, scopes: scopes as string[], expiresInDays: body.expiresInDays as number, allowedIps }
}

const readBody = async (request: Request, required: boolean): Promise<unknown> => {
  const text = await request.text()
  if (!required) return text.length > 0 ? invalid('token revocation does not accept a body') : undefined
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  try { return JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
}

/** Root manages its own API listener tokens: list, create (raw value returned once) and revoke. */
export async function handlePanelTokensWorkspaceRoute(request: Request, url: URL, method: string, helpers: PanelTokensWorkspaceHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const id = match[1]
  const action = id !== undefined ? 'panel.api_tokens.revoke' : method === 'POST' ? 'panel.api_tokens.create' : 'panel.api_tokens.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  // A bearer token must never mint or revoke tokens: management needs the interactive root session.
  if (caller.sessionId === null || caller.apiTokenId !== null) return fail('FORBIDDEN', 'API token management requires an interactive root session', { stateChanged: false })
  const allow = id !== undefined ? 'POST' : 'GET, POST'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (url.search) return invalid('API token routes do not accept selectors')
  if (id !== undefined && !ID_RE.test(id)) return invalid('a lowercase token id is required')
  const principalId = caller.principal.id
  const list = async () => (await listApiTokensForPrincipal(helpers.db, principalId)).slice(0, LIST_LIMIT)
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== principalId || current.sessionId !== caller.sessionId || current.apiTokenId !== null) return fail('FORBIDDEN', 'API token authority changed', { stateChanged: false })
    return current
  }
  if (method === 'GET') {
    const tokens = await list(), now = Date.now()
    // recordApiTokenUse exists in the repository but no request path calls it, so last use is not recorded.
    return json(200, { tokens: tokens.map(token => view(token, now)), usageRecorded: false })
  }
  if (id === undefined) {
    const input = parseApiTokenCreate(await readBody(request, true))
    const actor = await fresh()
    if ((await list()).filter(token => stateOf(token, Date.now()) === 'active').length >= API_TOKEN_MAX_ACTIVE) return fail('CONFLICT', `at most ${API_TOKEN_MAX_ACTIVE} active tokens are allowed; revoke one first`, { stateChanged: false })
    const secret = 'xp_' + randomBytes(32).toString('base64url'), tokenHash = sha256Hex(secret)
    const created = await createApiToken(helpers.db, { principalId, name: input.name, tokenHash, scopes: input.scopes, allowedIps: input.allowedIps, expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString() })
    const now = Date.now(), stored = (await list()).find(token => token.id === created.id)
    if (!stored || stored.tokenHash !== tokenHash || stateOf(stored, now) !== 'active') return fail('SERVICE_UNAVAILABLE', 'the new token could not be verified; review the token list', { stateChanged: true, verificationRequired: true })
    try {
      await helpers.emitAudit({ actor: actor.principal.username, action: 'auth.api_token.created', target: 'api-token:' + stored.id, detail: { name: stored.name, scopes: stored.scopes, expiresAt: stored.expiresAt, allowedIps: stored.allowedIps.length }, outcome: 'ok', principalId })
    } catch {
      // An unaudited credential is not issued: revoke it before reporting.
      try { await revokeApiToken(helpers.db, stored.id, principalId) } catch { return fail('SERVICE_UNAVAILABLE', 'the token audit failed and its revocation requires verification', { stateChanged: true, verificationRequired: true }) }
      return fail('SERVICE_UNAVAILABLE', 'the token was not issued because its audit record could not be written', { stateChanged: true, verificationRequired: false })
    }
    return json(201, { token: view(stored, now), secret })
  }
  await readBody(request, false)
  const target = (await list()).find(token => token.id === id)
  if (!target) return fail('NOT_FOUND', 'API token not found', { stateChanged: false })
  const before = stateOf(target, Date.now())
  if (before !== 'active') return fail('CONFLICT', before === 'revoked' ? 'the token is already revoked' : 'the token has already expired', { stateChanged: false })
  const actor = await fresh()
  await revokeApiToken(helpers.db, id, principalId)
  const now = Date.now(), after = (await list()).find(token => token.id === id)
  if (!after || after.revokedAt === null) return fail('SERVICE_UNAVAILABLE', 'the revocation could not be verified; review the token list', { stateChanged: true, verificationRequired: true })
  try { await helpers.emitAudit({ actor: actor.principal.username, action: 'auth.api_token.revoked', target: 'api-token:' + id, detail: { name: after.name }, outcome: 'ok', principalId }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the token is revoked but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  return json(200, { token: view(after, now) })
}

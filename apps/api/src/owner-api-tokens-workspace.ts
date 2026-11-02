import { randomBytes } from 'node:crypto'
import { fail, formatCidr, parseCidr, SESSION_ABSOLUTE_TIMEOUT_MS, SESSION_IDLE_TIMEOUT_MS } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { createApiToken, findActiveSessionByTokenHash, listApiTokensForPrincipal, renameApiToken, revokeApiToken } from '@xpanel/db'
import type { ApiTokenRecord, Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { assertAuthPersonalOwner } from './auth-personal.ts'
import { assertAccountPlanFeatures } from './authorization.ts'
import { sessionTokenHash, type EntryPoint } from './entry-points.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const OWNER_API_TOKEN_SCOPE_RESOURCES = ['files', 'databases', 'dns', 'mail', 'backups', 'cron'] as const
export const OWNER_API_TOKEN_SCOPES = OWNER_API_TOKEN_SCOPE_RESOURCES.flatMap(resource => [resource + ':read', resource + ':write'])
export const OWNER_API_TOKEN_MAX_ACTIVE = 50
const KNOWN_SCOPES = new Set(OWNER_API_TOKEN_SCOPES)
const BASE = '/api/auth/api-tokens'
const ROUTE = /^\/api\/auth\/api-tokens(?:\/([^/]+)(?:\/(revoke))?)?$/
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NAME = /^[A-Za-z0-9_-]{1,50}$/
const DAY_MS = 86_400_000
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const stateOf = (token: ApiTokenRecord, now: number): 'active' | 'expired' | 'revoked' => token.revokedAt !== null ? 'revoked' : Date.parse(token.expiresAt) <= now ? 'expired' : 'active'
const view = (token: ApiTokenRecord, now: number) => ({
  id: token.id, name: token.name, scopes: token.scopes, allowedIps: token.allowedIps, createdAt: token.createdAt, expiresAt: token.expiresAt,
  lastUsedAt: token.lastUsedAt, lastUsedIp: token.lastUsedIp, revokedAt: token.revokedAt, state: stateOf(token, now),
})

export interface OwnerApiTokensWorkspaceHelpers {
  db: Db
  store: StateStore
  entryPoint?: EntryPoint
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  /** Trusted construction: reauthenticate the original request using only this admitted DB runner. */
  authorizeSession(tx: Db, request: Request, original: AuthenticatedCaller): Promise<AuthenticatedCaller>
  emitAudit: ExtendedRouteHelpers['emitAudit']
}

/** Shared with the trusted personal producer; these leaves are safe while its caller holds the state writer. */
export async function assertOwnerApiTokenFeatureAccess(store: StateStore, caller: AuthenticatedCaller): Promise<Account> {
  assertAuthPersonalOwner(caller)
  if (caller.principal.kind !== 'user') return fail('FORBIDDEN', 'an original account owner is required', unchanged)
  const account = await store.getAccount(caller.principal.accountId, { username: caller.principal.username })
  if (!account || account.id !== caller.principal.accountId || account.status !== 'active') return fail('FORBIDDEN', 'the active owner account is unavailable', unchanged)
  await assertAccountPlanFeatures(store, account, ['api-tokens'])
  return account
}

const identity = (caller: AuthenticatedCaller, entryPoint?: EntryPoint) => {
  assertAuthPersonalOwner(caller, entryPoint)
  if (caller.principal.kind !== 'user' || !caller.sessionId || !caller.sessionToken) return fail('FORBIDDEN', 'an original owner session is required', unchanged)
  return { principalId: caller.principal.id, username: caller.principal.username, accountId: caller.principal.accountId,
    sessionId: caller.sessionId, sessionToken: caller.sessionToken }
}

async function admitted<T>(request: Request, original: AuthenticatedCaller, helpers: OwnerApiTokensWorkspaceHelpers, work: (tx: Db, assertDeadline: () => void) => Promise<T>): Promise<T> {
  const captured = identity(original, helpers.entryPoint)
  const lease = await helpers.store.getWriterLock().acquire()
  let committed = false
  try {
    const result = await helpers.db.transaction(async tx => {
      const check = async (): Promise<() => void> => {
        await lease.assertFencingToken()
        const current = await helpers.authorizeSession(tx, request, original)
        const actual = identity(current, helpers.entryPoint)
        if (actual.principalId !== captured.principalId || actual.username !== captured.username || actual.accountId !== captured.accountId
          || actual.sessionId !== captured.sessionId || actual.sessionToken !== captured.sessionToken
          || (request.method !== 'GET' && !current.csrfValid)) return fail('FORBIDDEN', 'the original owner authority changed', unchanged)
        const hash = sessionTokenHash(actual.sessionToken, helpers.entryPoint)
        const session = await findActiveSessionByTokenHash(tx, hash)
        if (!session || session.id !== captured.sessionId || session.principalId !== captured.principalId || session.tokenHash !== hash
          || session.revokedAt !== null || session.impersonatorPrincipalId !== null || session.impersonatorLogin !== null || session.impersonatorTeamMemberId !== null) return fail('FORBIDDEN', 'the original owner session changed', unchanged)
        // The same persisted session supplies the clock bound. No request value or raw MFA bit grants authority.
        const validUntil = Math.min(Date.parse(session.expiresAt), Date.parse(session.createdAt) + SESSION_ABSOLUTE_TIMEOUT_MS, Date.parse(session.lastSeenAt) + SESSION_IDLE_TIMEOUT_MS)
        const assertDeadline = (): void => { if (!Number.isFinite(validUntil) || Date.now() >= validUntil) fail('FORBIDDEN', 'the original owner session expired', unchanged) }
        await assertOwnerApiTokenFeatureAccess(helpers.store, current)
        await lease.assertFencingToken()
        assertDeadline()
        return assertDeadline
      }
      const before = await check()
      before()
      const result = await work(tx, before)
      const after = await check()
      after()
      return result
    })
    committed = true
    return result
  } finally {
    try { await lease.release() } catch {
      fail('SERVICE_UNAVAILABLE', 'the token admission release requires verification', { stateChanged: committed && request.method !== 'GET', verificationRequired: committed })
    }
  }
}

const readBody = async (request: Request, required: boolean): Promise<unknown> => {
  if (required && request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (reader) for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 16 * 1024) { await reader.cancel(); return invalid('the request body is too large') }
      chunks.push(part.value)
    }
    if (!required) return size ? invalid('token revocation does not accept a body') : undefined
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { return invalid('request body is not valid JSON') }
  } finally { reader?.releaseLock() }
}

export function parseOwnerApiTokenCreate(value: unknown): { name: string; scopes: string[]; expiresInDays: number; allowedIps: string[] } {
  if (!object(value) || Object.keys(value).some(key => !['name', 'scopes', 'expiresInDays', 'allowedIps', 'readOnly'].includes(key))) return invalid('only token name, scopes, expiry, allowed addresses and readOnly are accepted')
  if (typeof value.name !== 'string' || !NAME.test(value.name)) return invalid('name must contain 1 to 50 ASCII letters, digits, dashes or underscores')
  const scopes = value.scopes
  if (!Array.isArray(scopes) || !scopes.length || scopes.length > KNOWN_SCOPES.size || new Set(scopes).size !== scopes.length
    || !scopes.every((scope): scope is string => typeof scope === 'string' && KNOWN_SCOPES.has(scope))) return invalid('a unique set of supported account read/write scopes is required')
  if (value.readOnly !== undefined && typeof value.readOnly !== 'boolean') return invalid('readOnly must be a boolean')
  if (value.readOnly === true && scopes.some(scope => scope.endsWith(':write'))) return invalid('a read-only token cannot grant write scopes')
  const days = value.expiresInDays
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > 365) return invalid('an explicit expiry from 1 to 365 days is required')
  const rawIps = value.allowedIps ?? []
  if (!Array.isArray(rawIps) || rawIps.length > 16) return invalid('at most 16 allowed addresses are accepted')
  const allowedIps = rawIps.map(raw => {
    const cidr = typeof raw === 'string' && raw.length <= 49 ? parseCidr(raw) : null
    return cidr ? formatCidr(cidr) : invalid('each allowed address must be a canonical IPv4/IPv6 address or CIDR network')
  })
  if (new Set(allowedIps).size !== allowedIps.length) return invalid('allowed addresses must not repeat')
  return { name: value.name, scopes: [...scopes], expiresInDays: days, allowedIps }
}

function renameInput(value: unknown): string {
  if (!object(value) || Object.keys(value).length !== 1 || typeof value.name !== 'string' || !NAME.test(value.name)) return invalid('only a valid token name is accepted')
  return value.name
}

function bulkInput(value: unknown): string[] {
  if (!object(value) || Object.keys(value).length !== 1 || !Array.isArray(value.ids) || value.ids.length < 1 || value.ids.length > 50
    || new Set(value.ids).size !== value.ids.length || !value.ids.every((id): id is string => typeof id === 'string' && ID.test(id))) return invalid('ids must contain 1 to 50 unique lowercase token UUIDs')
  return [...value.ids]
}

/** Self service only. No principal/account selector, privileged issuer or request-controlled authority is accepted. */
export async function handleOwnerApiTokensWorkspaceRoute(request: Request, url: URL, method: string, helpers: OwnerApiTokensWorkspaceHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  const caller = await helpers.requireCaller(request)
  const owner = identity(caller, helpers.entryPoint)
  if (request.headers.has('authorization') || (method !== 'GET' && !caller.csrfValid)) return fail('FORBIDDEN', 'API token management requires the original interactive owner session', unchanged)
  if (url.search) return invalid('API token routes do not accept selectors')
  const bulk = match[1] === 'revoke' && match[2] === undefined
  const id = bulk ? undefined : match[1]
  const revoke = match[2] === 'revoke'
  const allow = bulk || revoke ? 'POST' : id === undefined ? 'GET, POST' : 'PATCH'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  if (id !== undefined && !ID.test(id)) return invalid('a lowercase token UUID is required')

  if (method === 'GET') {
    const tokens = await admitted(request, caller, helpers, async (tx, assertDeadline) => { const tokens = await listApiTokensForPrincipal(tx, owner.principalId); assertDeadline(); return tokens })
    return json(200, { tokens: tokens.map(token => view(token, Date.now())), usageRecorded: true })
  }
  if (url.pathname === BASE) {
    const input = parseOwnerApiTokenCreate(await readBody(request, true))
    const created = await admitted(request, caller, helpers, async (tx, assertDeadline) => {
      const tokens = await listApiTokensForPrincipal(tx, owner.principalId)
      assertDeadline()
      if (tokens.some(token => token.name.toLowerCase() === input.name.toLowerCase())) return fail('CONFLICT', 'this token name is already in use', unchanged)
      if (tokens.filter(token => stateOf(token, Date.now()) === 'active').length >= OWNER_API_TOKEN_MAX_ACTIVE) return fail('CONFLICT', 'at most 50 active account tokens are allowed', unchanged)
      const secret = 'xp_' + randomBytes(32).toString('base64url')
      assertDeadline()
      const token = await createApiToken(tx, { principalId: owner.principalId, name: input.name, tokenHash: sha256Hex(secret), scopes: input.scopes,
        allowedIps: input.allowedIps, expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS).toISOString() })
      assertDeadline()
      const stored = (await listApiTokensForPrincipal(tx, owner.principalId)).find(row => row.id === token.id)
      assertDeadline()
      if (!stored || stored.tokenHash !== sha256Hex(secret) || stateOf(stored, Date.now()) !== 'active') return fail('SERVICE_UNAVAILABLE', 'the new account token could not be verified', unchanged)
      return { token: stored, secret }
    })
    try {
      await helpers.emitAudit({ actor: owner.username, principalId: owner.principalId, action: 'auth.account_api_token.created', target: 'api-token:' + created.token.id,
        detail: { name: created.token.name, scopes: created.token.scopes, expiresAt: created.token.expiresAt, allowedIps: created.token.allowedIps.length }, outcome: 'ok' })
    } catch {
      // Internal compensation cannot depend on a credential that may have expired after the admitted commit.
      try {
        await helpers.db.transaction(async tx => {
          await revokeApiToken(tx, created.token.id, owner.principalId)
          const stored = (await listApiTokensForPrincipal(tx, owner.principalId)).find(token => token.id === created.token.id)
          if (!stored?.revokedAt) throw new Error('token_compensation_unverified')
        })
      } catch { return fail('SERVICE_UNAVAILABLE', 'the unissued token revocation requires verification', { stateChanged: true, verificationRequired: true }) }
      return fail('SERVICE_UNAVAILABLE', 'the token was not issued because its audit record could not be written', { stateChanged: true, verificationRequired: false })
    }
    return json(201, { token: view(created.token, Date.now()), secret: created.secret })
  }

  const ids = bulk ? bulkInput(await readBody(request, true)) : id === undefined ? invalid('a token id is required') : [id]
  const name = !bulk && !revoke ? renameInput(await readBody(request, true)) : undefined
  if (!bulk && revoke) await readBody(request, false)
  const tokens = await admitted(request, caller, helpers, async (tx, assertDeadline) => {
    const own = await listApiTokensForPrincipal(tx, owner.principalId)
    assertDeadline()
    if (ids.some(tokenId => !own.some(token => token.id === tokenId))) return fail('NOT_FOUND', 'API token not found', unchanged)
    for (const tokenId of ids) {
      assertDeadline()
      if (name !== undefined) await renameApiToken(tx, tokenId, owner.principalId, name)
      else await revokeApiToken(tx, tokenId, owner.principalId)
      assertDeadline()
    }
    const after = await listApiTokensForPrincipal(tx, owner.principalId)
    assertDeadline()
    return ids.map(tokenId => {
      const token = after.find(row => row.id === tokenId)
      if (!token || (name !== undefined ? token.name !== name : token.revokedAt === null)) return fail('SERVICE_UNAVAILABLE', 'the token change could not be verified', unchanged)
      return token
    })
  })
  try {
    await helpers.emitAudit({ actor: owner.username, principalId: owner.principalId, action: name === undefined ? 'auth.account_api_token.revoked' : 'auth.account_api_token.renamed',
      target: bulk ? 'principal:' + owner.principalId : 'api-token:' + ids[0], detail: { count: tokens.length, ...(name === undefined ? {} : { name }) }, outcome: 'ok' })
  } catch { return fail('SERVICE_UNAVAILABLE', 'the token change is saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  const publicTokens = tokens.map(token => view(token, Date.now()))
  return json(200, bulk ? { tokens: publicTokens } : { token: publicTokens[0] })
}

import { fail, isXpanelError } from '@xpanel/core'
import type { Account, ErrorCode } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import { isMailboxPrincipal } from './authorization.ts'

export interface AccountHealthWorkspaceHelpers {
  /** Authenticates and applies the declared route policy (reseller ACL list-accounts). */
  requireCaller(request: Request): Promise<AuthenticatedCaller>
  /** The existing ownership scoping (ownedAccounts): every account for root, owned accounts for a reseller. */
  visibleAccounts(caller: AuthenticatedCaller): Promise<readonly Pick<Account, 'username'>[]>
  /** The protected agent RPC; only the reviewed health path and validated usernames are forwarded. */
  forward(caller: AuthenticatedCaller, pathAndQuery: string): Promise<Response>
  now?: () => Date
}

export const ACCOUNT_HEALTH_BATCH = 50
const MAX_PENDING = 5000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = { 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 412: 'PRECONDITION_FAILED', 422: 'VALIDATION', 503: 'SERVICE_UNAVAILABLE' }

function readSelection(url: URL): string[] {
  if (url.search.length > 2048 || [...url.searchParams.keys()].some(key => key !== 'username')) return fail('VALIDATION', 'account health accepts only username selectors', unchanged)
  const usernames = url.searchParams.getAll('username')
  if (usernames.length > ACCOUNT_HEALTH_BATCH || new Set(usernames).size !== usernames.length || usernames.some(name => !USERNAME.test(name)))
    return fail('VALIDATION', `at most ${ACCOUNT_HEALTH_BATCH} distinct account usernames may be selected`, unchanged)
  return usernames
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('missing_body')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      bytes += next.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response_limit') }
      chunks.push(next.value)
    }
  } finally { reader.releaseLock() }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
}

/**
 * GET /api/accounts/health for root and resellers. Without selectors it checks the first 50 visible
 * accounts and lists the rest as pending; with ?username= it rechecks exactly those (1..50) visible accounts.
 */
export async function handleAccountHealthWorkspaceRoute(request: Request, url: URL, method: string, helpers: AccountHealthWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/accounts/health') return null
  const initial = await helpers.requireCaller(request)
  if (isMailboxPrincipal(initial) || initial.principal.kind !== 'root' && initial.principal.kind !== 'reseller') return fail('FORBIDDEN', 'account health requires root or a reseller with list-accounts', unchanged)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const requested = readSelection(url)
  const visible = (await helpers.visibleAccounts(initial)).map(account => account.username).sort()
  const known = new Set(visible)
  if (requested.some(name => !known.has(name))) return fail('NOT_FOUND', 'account not found', unchanged)
  const batch = requested.length ? requested : visible.slice(0, ACCOUNT_HEALTH_BATCH)
  const pending = requested.length ? [] : visible.slice(ACCOUNT_HEALTH_BATCH, ACCOUNT_HEALTH_BATCH + MAX_PENDING)
  const truncated = !requested.length && visible.length > ACCOUNT_HEALTH_BATCH + MAX_PENDING
  if (!batch.length) return json({ observedAt: (helpers.now ?? (() => new Date()))().toISOString(), host: 'unavailable', accounts: [], pending: [], truncated: false })

  let response: Response
  try { response = await helpers.forward(initial, '/host/accounts/health?' + batch.map(name => 'username=' + name).join('&')) }
  catch (error) {
    if (isXpanelError(error) && error.detail.stateChanged === false) throw error
    return fail('SERVICE_UNAVAILABLE', 'protected host transport could not be verified', unchanged)
  }
  let payload: unknown
  try { payload = await readBounded(response) } catch { return fail('SERVICE_UNAVAILABLE', 'protected host response could not be verified', unchanged) }
  const fresh = await helpers.requireCaller(request)
  if (fresh.principal.id !== initial.principal.id || fresh.principal.kind !== initial.principal.kind || fresh.sessionId !== initial.sessionId || fresh.apiTokenId !== initial.apiTokenId)
    return fail('FORBIDDEN', 'account health authority changed', unchanged)
  if (!response.ok) {
    const message = object(payload) && typeof payload.detail === 'string' && payload.detail.length <= 300 && !/[\u0000-\u001f\u007f-\u009f]/.test(payload.detail) ? payload.detail : 'the protected host refused the account health request'
    return fail(CODE_BY_STATUS[response.status] ?? 'PRECONDITION_FAILED', message, unchanged)
  }
  // Only the requested accounts, in order, may cross the boundary; the browser parser validates every field.
  if (!object(payload) || typeof payload.observedAt !== 'string' || (payload.host !== 'read' && payload.host !== 'unavailable') || !Array.isArray(payload.accounts)
    || payload.accounts.length !== batch.length || payload.accounts.some((entry, index) => !object(entry) || entry.username !== batch[index])) return fail('SERVICE_UNAVAILABLE', 'protected host response could not be verified', unchanged)
  const still = new Set((await helpers.visibleAccounts(fresh)).map(account => account.username))
  return json({ observedAt: payload.observedAt, host: payload.host, accounts: payload.accounts.filter(entry => still.has((entry as { username: string }).username)), pending: pending.filter(name => still.has(name)), truncated })
}

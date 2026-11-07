import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DNS_CLUSTER_PEER_PREFIX } from '../../agent/src/dns-cluster-model.ts'
import type { PanelGatePolicy } from '../../agent/src/panel-gate-policy.ts'
import type { SecListener } from '../../agent/src/sec-policy.ts'
import { parseCookies, verifyPasswordArgon2id } from './auth.ts'
import { cachedSecRecord } from './sec-panel-access.ts'

const COOKIE_TTL_SEC = 12 * 3600
const FAILURE_LIMIT = 10, FAILURE_WINDOW_MS = 15 * 60_000, FAILURE_TRACKED = 4096
export const TEMPORARY_LOGIN_PATH = /^\/login\/temporary\/([A-Za-z0-9_-]{43})$/

/** These carry their own credential and are called by machines or one-time forms that hold no gate cookie. */
const OWN_CREDENTIAL = new Set(['/api/health', '/api/dav/authorize', '/api/integrations/whmcs/provision', '/nic/update', '/login/handoff'])
const hasOwnCredential = (pathname: string): boolean => OWN_CREDENTIAL.has(pathname) || pathname.startsWith('/hook/') || pathname.startsWith('/share/') || pathname.startsWith(DNS_CLUSTER_PEER_PREFIX) || TEMPORARY_LOGIN_PATH.test(pathname)

const plain = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers: { 'cache-control': 'no-store', ...headers } })
export const cookieName = (listener: SecListener, secure: boolean): string => `${secure ? '__Host-' : ''}${listener}_gate`
/** Any change of the entrance or of the basic credential ends every earlier pass. */
const fingerprint = (policy: PanelGatePolicy): string => createHash('sha256').update(JSON.stringify([policy.entrance?.path ?? null, policy.basicAuth?.username ?? null, policy.basicAuth?.passwordHash ?? null])).digest('hex')
const sign = (secret: string, listener: SecListener, policy: PanelGatePolicy, expires: number, flags: string): string =>
  createHmac('sha256', secret).update(`xpanel-panel-gate:v1\0${listener}\0${expires}\0${flags}\0${fingerprint(policy)}`).digest('base64url')

export function issueGateCookie(input: { secret: string; listener: SecListener; policy: PanelGatePolicy; flags: string; secure: boolean; now?: () => number }): string {
  const expires = Math.floor((input.now?.() ?? Date.now()) / 1000) + COOKIE_TTL_SEC, flags = [...new Set(input.flags)].sort().join('')
  const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${COOKIE_TTL_SEC}`, ...(input.secure ? ['Secure'] : [])]
  return `${cookieName(input.listener, input.secure)}=${expires}.${flags}.${sign(input.secret, input.listener, input.policy, expires, flags)}; ${attrs.join('; ')}`
}

function heldFlags(request: Request, input: { secret: string; listener: SecListener; policy: PanelGatePolicy; secure: boolean; now: number }): string {
  const value = parseCookies(request.headers.get('cookie'))[cookieName(input.listener, input.secure)]
  const match = value ? /^([1-9][0-9]{0,11})\.([be]{1,2})\.([A-Za-z0-9_-]{43})$/.exec(value) : null
  if (!match || Number(match[1]) <= input.now / 1000) return ''
  const want = Buffer.from(sign(input.secret, input.listener, input.policy, Number(match[1]), match[2]!)), got = Buffer.from(match[3]!)
  return want.length === got.length && timingSafeEqual(want, got) ? match[2]! : ''
}

// shortcut: failures are counted per API process and reset on restart, enough to bound Argon2 work on 1 vCPU.
const failures = new Map<string, { count: number; until: number }>()
async function basicAccepted(request: Request, policy: NonNullable<PanelGatePolicy['basicAuth']>, client: string, now: number): Promise<boolean> {
  const header = /^Basic ([A-Za-z0-9+/=]{1,2048})$/.exec(request.headers.get('authorization') ?? '')?.[1]
  if (!header) return false
  const seen = failures.get(client)
  if (seen && seen.until > now && seen.count >= FAILURE_LIMIT) return false
  const decoded = Buffer.from(header, 'base64').toString('utf8'), colon = decoded.indexOf(':')
  const nameMatches = colon > 0 && decoded.slice(0, colon) === policy.username
  if (await verifyPasswordArgon2id(colon > 0 ? decoded.slice(colon + 1) : '', policy.passwordHash) && nameMatches) { failures.delete(client); return true }
  if (failures.size >= FAILURE_TRACKED) failures.clear()
  failures.set(client, { count: seen && seen.until > now ? seen.count + 1 : 1, until: seen && seen.until > now ? seen.until : now + FAILURE_WINDOW_MS })
  return false
}

const unauthenticated = (policy: PanelGatePolicy): Response => {
  const { kind, url } = policy.response
  return kind === 'redirect' ? plain(302, { location: url! }) : plain(kind === 'forbidden' ? 403 : kind === 'blank' ? 200 : 404)
}

export interface PanelGateInput {
  rootDir: string
  listener: SecListener
  request: Request
  pathname: string
  search: string
  method: string
  secret: string
  secure: boolean
  /** Read only when a basic credential is tried: it refuses an ingress request without a client identity. */
  client: () => string
  /** Asked only when the entrance would refuse: a signed-in person keeps working when the entrance is turned on. */
  hasSession: () => Promise<boolean>
  now?: () => number
}

/**
 * Pre-authentication gate of one network entry point: stop switch, secret entrance, then basic authentication.
 * Every pass only reaches the normal sign-in or session check; nothing here authenticates a person.
 * An unreadable policy closes the listener until `xpanel panel-access reset` repairs it from the console.
 */
export async function panelGate(input: PanelGateInput): Promise<Response | null> {
  if (hasOwnCredential(input.pathname)) return null
  const record = await cachedSecRecord(input.rootDir, 'panel-gate')
  if (record === undefined) return null
  if (record === null) return plain(503)
  const policy = record.policy, { listener, request, secret, secure } = input, now = input.now?.() ?? Date.now()
  if (policy.stopped.includes(listener)) return plain(503)
  const entrance = policy.entrance?.listeners.includes(listener) ? policy.entrance : null
  const basic = policy.basicAuth?.listeners.includes(listener) ? policy.basicAuth : null
  if (!entrance && !basic) return null
  const held = heldFlags(request, { secret, listener, policy, secure, now })
  const cookie = (flag: string): string => issueGateCookie({ secret, listener, policy, flags: held + flag, secure, now: () => now })
  if (entrance && input.method === 'GET' && input.pathname === `/${entrance.path}`) return plain(303, { location: '/login', 'set-cookie': cookie('e'), 'referrer-policy': 'no-referrer' })
  if (entrance && !held.includes('e') && !await input.hasSession()) return unauthenticated(policy)
  if (basic && !held.includes('b')) {
    // A linked server or API client cannot answer a Basic challenge; its token is checked in full here and again by the route.
    if (/^bearer\s/i.test(request.headers.get('authorization') ?? '') && await input.hasSession()) return null
    if (!await basicAccepted(request, basic, input.client(), now)) return plain(401, { 'www-authenticate': 'Basic realm="Restricted", charset="UTF-8"' })
    if (input.method === 'GET') return plain(303, { location: `${input.pathname}${input.search}`, 'set-cookie': cookie('b') })
  }
  return null
}

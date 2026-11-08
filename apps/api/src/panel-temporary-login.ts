import { createHash, randomBytes } from 'node:crypto'
import { fail } from '@xpanel/core'
import { createAuthenticatedSession, getPrincipal } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import type { StateStore } from '@xpanel/state'
import { PANEL_TEMPORARY_LOGINS_DEFAULT, PANEL_TEMPORARY_LOGINS_MAX, TEMPORARY_LIFETIME_MINUTES } from '../../agent/src/panel-gate-policy.ts'
import type { PanelTemporaryLogin } from '../../agent/src/panel-gate-policy.ts'
import { readSecRecord, secRevision } from '../../agent/src/sec-policy.ts'
import { formatSessionCookie } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import { sessionTokenHash } from './entry-points.ts'
import { issueGateCookie, TEMPORARY_LOGIN_PATH } from './panel-gate.ts'
import { cachedSecRecord } from './sec-panel-access.ts'
import { DOCUMENT_CSP } from '../../web/src/content-security-policy.ts'
import { readSecRaw, writeSecRecord } from './sec-workspace.ts'

const MARK = 'temporary:'
const KEEP_MS = 30 * 86_400_000
const PRIVATE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } as const
const SECURITY_ROUTE = /^\/api\/server\/(?:panel-access|sec\/panel-access)(?:\/|$)/
// Secrets and files: read-only, but each opens a way to write that does not pass this check.
const SENSITIVE_READ = /\/(?:download|export|raw|dump|credentials|ssh-key|root-password)(?:\/|$)|\/ssl\/keys\/|\/panel-backups\/[^/]+$/
const unchanged = { stateChanged: false }

export const isTemporaryLogin = (login: string | null | undefined): boolean => login?.startsWith(MARK) === true
const tokenHash = (token: string): string => createHash('sha256').update(`xpanel-temporary-login:v1\0${token}`, 'utf8').digest('hex')
const idOf = (login: string): string => login.slice(MARK.length)
export const temporaryActor = (id: string): string => `${MARK}${id}`

type Audit = (entry: { actor: string; action: string; target: string; detail?: Record<string, unknown>; outcome: 'ok' | 'denied' | 'failed'; principalId?: string | null; ip?: string | null }) => Promise<unknown>

/** Why a temporary session may not make this request, or null. A helper reads; only signing out changes anything. */
export function temporaryRefusal(pathname: string, method: string): string | null {
  if (pathname === '/api/auth/logout') return null
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'temporary_session_read_only'
  return SECURITY_ROUTE.test(pathname) || SENSITIVE_READ.test(pathname) ? 'temporary_session_no_access' : null
}

/** requireCaller's check of every API call of a temporary session; the rows are its separate activity log. */
export async function admitTemporaryRequest(input: { caller: AuthenticatedCaller; pathname: string; method: string; ip: string | null; emitAudit: Audit }): Promise<void> {
  const refusal = temporaryRefusal(input.pathname, input.method)
  if (refusal || !input.pathname.startsWith('/api/auth/')) await input.emitAudit({ actor: input.caller.impersonator!.login, action: refusal ? 'temporary_login.refused' : 'temporary_login.request', target: `${input.method} ${input.pathname}`.slice(0, 256), outcome: refusal ? 'denied' : 'ok', principalId: input.caller.principal.id, ip: input.ip })
  if (refusal) fail('FORBIDDEN', 'a temporary session cannot do this', { ...unchanged, reason: refusal })
}

/** A handed-out session lives only while its link does; revoking the link ends it on the next request. */
export async function temporaryLoginActive(rootDir: string, login: string, now = Date.now()): Promise<boolean> {
  const record = await cachedSecRecord(rootDir, 'panel-temporary-logins')
  if (record === null) throw new Error('temporary_logins_unreadable')
  const link = record?.policy.logins.find(item => item.id === idOf(login))
  return !!link && link.revokedAt === null && Date.parse(link.expiresAt) > now
}

const loginsOf = (raw: unknown): PanelTemporaryLogin[] | null => raw === null ? [...PANEL_TEMPORARY_LOGINS_DEFAULT.logins] : readSecRecord('panel-temporary-logins', raw)?.policy.logins ?? null
const readLogins = async (store: Pick<StateStore, 'rootDir'>): Promise<{ raw: unknown; logins: PanelTemporaryLogin[] }> => {
  const raw = await readSecRaw(store, 'panel-temporary-logins'), logins = loginsOf(raw)
  return logins ? { raw, logins } : fail('PRECONDITION_FAILED', 'saved temporary links require review', unchanged)
}
export const temporaryLoginState = (link: PanelTemporaryLogin, now: number): 'revoked' | 'used' | 'expired' | 'unused' =>
  link.revokedAt ? 'revoked' : link.usedAt ? 'used' : Date.parse(link.expiresAt) <= now ? 'expired' : 'unused'
export const temporaryLoginView = (link: PanelTemporaryLogin, now: number): Record<string, unknown> => ({ id: link.id, note: link.note, issuer: link.issuer, createdAt: link.createdAt, expiresAt: link.expiresAt, usedAt: link.usedAt, revokedAt: link.revokedAt, state: temporaryLoginState(link, now) })
export const listTemporaryLogins = async (store: Pick<StateStore, 'rootDir'>, now: number): Promise<Record<string, unknown>[]> => (await readLogins(store)).logins.map(link => temporaryLoginView(link, now))

export function parseTemporaryRequest(body: Record<string, unknown>): { lifetimeMinutes: number; note: string } {
  const { lifetimeMinutes, note } = body
  if (Object.keys(body).sort().join() !== 'lifetimeMinutes,note' || typeof lifetimeMinutes !== 'number' || !Number.isSafeInteger(lifetimeMinutes) || lifetimeMinutes < TEMPORARY_LIFETIME_MINUTES.min || lifetimeMinutes > TEMPORARY_LIFETIME_MINUTES.max) return fail('VALIDATION', `the lifetime must be ${TEMPORARY_LIFETIME_MINUTES.min} to ${TEMPORARY_LIFETIME_MINUTES.max} minutes`, unchanged)
  if (typeof note !== 'string' || note.length > 128 || /[\u0000-\u001f\u007f]/.test(note)) return fail('VALIDATION', 'the note must be one line of at most 128 characters', unchanged)
  return { lifetimeMinutes, note }
}

/** The token exists only in this reply; the file keeps its hash. */
export async function issueTemporaryLogin(store: StateStore, caller: AuthenticatedCaller, input: { lifetimeMinutes: number; note: string }, fresh: () => Promise<unknown>, now = new Date()): Promise<{ token: string; link: PanelTemporaryLogin }> {
  const token = randomBytes(32).toString('base64url')
  const link: PanelTemporaryLogin = { id: randomBytes(8).toString('hex'), tokenHash: tokenHash(token), note: input.note, issuerId: caller.principal.id, issuer: caller.principal.username,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + input.lifetimeMinutes * 60_000).toISOString(), usedAt: null, revokedAt: null }
  const { raw, logins } = await readLogins(store)
  const kept = logins.filter(item => now.getTime() - Date.parse(item.expiresAt) < KEEP_MS).slice(-(PANEL_TEMPORARY_LOGINS_MAX - 1))
  await writeSecRecord({ store }, 'panel-temporary-logins', secRevision('panel-temporary-logins', raw), () => ({ logins: [...kept, link] }), fresh)
  return { token, link }
}

export async function revokeTemporaryLogin(store: StateStore, id: string, fresh: () => Promise<unknown>, now = new Date()): Promise<PanelTemporaryLogin> {
  const { raw, logins } = await readLogins(store), link = logins.find(item => item.id === id)
  if (!link) return fail('NOT_FOUND', 'temporary link not found', unchanged)
  const revoked = { ...link, revokedAt: link.revokedAt ?? now.toISOString() }
  await writeSecRecord({ store }, 'panel-temporary-logins', secRevision('panel-temporary-logins', raw), () => ({ logins: logins.map(item => item.id === id ? revoked : item) }), fresh)
  return revoked
}

export interface TemporaryLoginRouteDeps {
  db: Db
  store: StateStore
  publicOrigin?: string
  serverSecret: string
  emitAudit: Audit
  clientIp: (request: Request) => string
  secureCookies: (request: Request) => boolean
  /** Translated page text; the page holds no panel chrome, because it may be the first thing a helper sees. */
  text: (request: Request, message: string) => string
  now?: () => Date
}

// no-referrer would turn the form's Origin into null, and the POST below requires the real one.
const html = (status: number, body: string): Response => new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><body style="font-family:sans-serif;max-inline-size:32rem;margin:32px auto;padding-inline:16px">${body}</body>`, { status, headers: { ...PRIVATE, 'referrer-policy': 'same-origin', 'content-security-policy': DOCUMENT_CSP, 'content-type': 'text/html; charset=utf-8' } })

export function createTemporaryLoginRoutes(deps: TemporaryLoginRouteDeps) {
  const REFUSED = { revoked: 'LINK_REVOKED', used: 'LINK_USED', expired: 'LINK_EXPIRED' } as const
  const MESSAGE = { revoked: msgid('This sign-in link was revoked.'), used: msgid('This sign-in link was already used.'), expired: msgid('This sign-in link has expired.') } as const
  const refuse = (request: Request, state: keyof typeof REFUSED): Response => {
    const code = REFUSED[state]
    return request.headers.get('accept')?.includes('application/json')
      ? new Response(JSON.stringify({ type: 'about:blank', title: code, status: 401, code, detail: code, instance: '/login/temporary' }), { status: 401, headers: { ...PRIVATE, 'content-type': 'application/problem+json' } })
      : html(401, `<p>${deps.text(request, MESSAGE[state])}</p><p><code>${code}</code></p>`)
  }
  return async (request: Request, pathname: string, method: string): Promise<Response | null> => {
    const token = TEMPORARY_LOGIN_PATH.exec(pathname)?.[1]
    if (!token) return null
    if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { ...PRIVATE, allow: 'GET, POST' } })
    const now = deps.now?.() ?? new Date(), { raw, logins } = await readLogins(deps.store), hash = tokenHash(token), link = logins.find(item => item.tokenHash === hash)
    if (!link) return new Response(null, { status: 404, headers: PRIVATE })
    const state = temporaryLoginState(link, now.getTime())
    if (state !== 'unused') return refuse(request, state)
    // A link preview fetches GET: only this form's POST spends the link.
    if (method === 'GET') return html(200, `<p>${deps.text(request, msgid('This link opens a read-only session of xWHM for a limited time.'))}</p><form method="post"><button type="submit">${deps.text(request, msgid('Open the session'))}</button></form>`)
    if (deps.publicOrigin && request.headers.get('origin') !== deps.publicOrigin) return new Response(null, { status: 403, headers: PRIVATE })
    const issuer = await getPrincipal(deps.db, link.issuerId)
    if (!issuer || issuer.kind !== 'root' || issuer.disabled || issuer.forcePasswordChange) return new Response(null, { status: 403, headers: PRIVATE })
    try { await writeSecRecord({ store: deps.store }, 'panel-temporary-logins', secRevision('panel-temporary-logins', raw), () => ({ logins: logins.map(item => item.id === link.id ? { ...item, usedAt: now.toISOString() } : item) }), async () => {}) }
    catch { return refuse(request, 'used') }
    const rawToken = randomBytes(32).toString('base64url'), ip = deps.clientIp(request), secure = deps.secureCookies(request)
    const session = await createAuthenticatedSession(deps.db, { principalId: issuer.id, tokenHash: sessionTokenHash(rawToken, 'xwhm'), expiresAt: link.expiresAt, ip, userAgent: request.headers.get('user-agent') ?? 'xpanel-client', mfaVerified: true,
      impersonator: { principalId: issuer.id, login: temporaryActor(link.id) }, expectedPasswordHash: issuer.passwordHash, expectedTotpEnabled: issuer.totpEnabled, expectedSealedSecret: issuer.totpSecretEnc })
    if (!session) return new Response(null, { status: 403, headers: PRIVATE })
    await deps.emitAudit({ actor: temporaryActor(link.id), action: 'temporary_login.opened', target: 'temporary-login:' + link.id, outcome: 'ok', principalId: issuer.id, ip, detail: { sessionId: session.id, expiresAt: link.expiresAt } })
    const headers = new Headers({ ...PRIVATE, location: '/whm' })
    headers.append('set-cookie', formatSessionCookie(rawToken, { entryPoint: 'xwhm', secure, maxAgeSec: Math.floor((Date.parse(link.expiresAt) - now.getTime()) / 1000) }))
    const gate = await cachedSecRecord(deps.store.rootDir, 'panel-gate')
    if (gate) headers.append('set-cookie', issueGateCookie({ secret: deps.serverSecret, listener: 'xwhm', policy: gate.policy, flags: 'be', secure }))
    return new Response(null, { status: 303, headers })
  }
}

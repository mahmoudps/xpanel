import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApiToken, createRootPrincipal, createSession, createTestDb } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { hashPasswordArgon2id, sha256Hex } from './auth.ts'
import { createApiApp } from './server.ts'

// Real-loopback acceptance for trusted-self session management. Sessions are created through the
// real login endpoint plus the real session repository; no browser mock is involved.

const PASSWORD = 'RootSessionFixture!2026'
const cleanup: Array<() => Promise<unknown>> = []
interface SessionRow { id: string; principalId?: string; current?: boolean; ip?: string | null; userAgent?: string | null; mfaVerified?: boolean; tokenHash?: unknown; createdAt?: string; lastSeenAt?: string; expiresAt?: string }

const fixture = async () => {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: await hashPasswordArgon2id(PASSWORD), forcePasswordChange: false })
  const foreign = await createRootPrincipal(database.db, { username: 'other-root', passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg', forcePasswordChange: false })
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: 'sessions-synthetic-server-secret' })
  const login = async () => {
    const response = await app.fetch(new Request('http://localhost/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: PASSWORD }) }))
    expect(response.status).toBe(200)
    const body = await response.json() as { csrfToken: string }
    const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]!
    return { cookie, csrf: body.csrfToken, raw: cookie.split('=')[1]! }
  }
  const extraSession = async (principalId = root.id) => {
    const raw = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')
    const session = await createSession(database.db, { principalId, tokenHash: sha256Hex(raw), expiresAt: new Date(Date.now() + 3600_000).toISOString(), ip: '198.51.100.9', userAgent: 'Second device fixture' })
    return { raw, session }
  }
  const request = (path: string, options: { method?: string; cookie?: string; csrf?: string | null; bearer?: string; body?: unknown } = {}) =>
    app.fetch(new Request('http://localhost' + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}),
        ...(options.bearer ? { authorization: 'Bearer ' + options.bearer } : {}),
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    }))
  const audit = (action: string) => database.db.query<{ action: string }>('SELECT action FROM audit_log WHERE action = $1', [action])
  return { database, state, root, foreign, app, login, extraSession, request, audit }
}

describe('trusted-self session management HTTP acceptance', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Synthetic sessions cleanup failed')
  })

  it('lists only the current principal sessions with a current marker and no token hashes', async () => {
    const session = await f.login()
    const extra = await f.extraSession()
    const response = await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })
    expect(response.status).toBe(200)
    const body = await response.json() as { sessions: SessionRow[]; currentSessionId: string }
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.filter(row => row.current)).toHaveLength(1)
    expect(body.sessions.find(row => row.current)?.id).toBe(body.currentSessionId)
    expect(body.sessions.map(row => row.id)).toContain(extra.session.id)
    expect(JSON.stringify(body)).not.toMatch(/tokenHash|token_hash|csrf/i)
    expect(body.sessions[0]).toMatchObject({ mfaVerified: expect.any(Boolean), createdAt: expect.any(String), lastSeenAt: expect.any(String), expiresAt: expect.any(String) })
  })

  it('revokes another own session and verifies it disappears', async () => {
    const session = await f.login()
    const extra = await f.extraSession()
    const response = await f.request('/api/auth/sessions/' + extra.session.id, { method: 'DELETE', cookie: session.cookie, csrf: session.csrf })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, currentSessionRevoked: false })
    const after = await (await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })).json() as { sessions: SessionRow[] }
    expect(after.sessions.map(row => row.id)).not.toContain(extra.session.id)
    expect((await f.audit('auth.session_revoked')).length).toBe(1)
  })

  it('refuses revoking another principal session', async () => {
    const session = await f.login()
    const foreign = await f.extraSession(f.foreign!.id)
    const before = (await (await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })).json() as { sessions: SessionRow[] }).sessions
    const response = await f.request('/api/auth/sessions/' + foreign.session.id, { method: 'DELETE', cookie: session.cookie, csrf: session.csrf })
    expect(response.status).toBe(404)
    const after = (await (await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })).json() as { sessions: SessionRow[] }).sessions
    expect(after.map(row => row.id)).toEqual(before.map(row => row.id))
  })

  it('revokes every other owned session and keeps the current one', async () => {
    const session = await f.login()
    const extra = await f.extraSession()
    const response = await f.request('/api/auth/sessions/revoke-others', { method: 'POST', cookie: session.cookie, csrf: session.csrf })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; revokedCount: number }
    expect(body.ok).toBe(true)
    expect(body.revokedCount).toBe(1)
    const after = (await (await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })).json() as { sessions: SessionRow[] }).sessions
    expect(after).toHaveLength(1)
    expect(after[0]!.current).toBe(true)
    expect(after.some(row => row.id === extra.session.id)).toBe(false)
    expect((await f.audit('auth.sessions_revoked_others')).length).toBe(1)
  })

  it('refuses interactive-session routes for API tokens and anonymous callers', async () => {
    const rawToken = 'xp_' + randomUUID()
    await createApiToken(f.database.db, { principalId: f.root.id, name: 'Synthetic sessions token', tokenHash: sha256Hex(rawToken), scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    for (const path of ['/api/auth/sessions', '/api/auth/sessions/revoke-others']) {
      const response = await f.request(path, { method: path.endsWith('revoke-others') ? 'POST' : 'GET', bearer: rawToken })
      expect(response.status, path).toBe(403)
    }
    const anonymous = await f.request('/api/auth/sessions')
    expect(anonymous.status).toBe(401)
  })

  it('requires a valid CSRF token for revocation and changes nothing without it', async () => {
    const session = await f.login()
    const extra = await f.extraSession()
    const missing = await f.request('/api/auth/sessions/' + extra.session.id, { method: 'DELETE', cookie: session.cookie })
    expect(missing.status).toBe(403)
    const invalid = await f.request('/api/auth/sessions/' + extra.session.id, { method: 'DELETE', cookie: session.cookie, csrf: 'b'.repeat(64) })
    expect(invalid.status).toBe(403)
    const after = (await (await f.request('/api/auth/sessions', { cookie: session.cookie, csrf: session.csrf })).json() as { sessions: SessionRow[] }).sessions
    expect(after.some(row => row.id === extra.session.id)).toBe(true)
  })
})

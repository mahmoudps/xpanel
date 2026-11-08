import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRootPrincipal, createSession, createTestDb, listAudit } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { PANEL_GATE_DEFAULT } from '../../agent/src/panel-gate-policy.ts'
import type { PanelGatePolicy } from '../../agent/src/panel-gate-policy.ts'
import { SEC_STATE_PATHS, secRevision } from '../../agent/src/sec-policy.ts'
import { deriveCsrfToken, passwordHashFromInput } from './auth.ts'
import { sessionCookieName, sessionTokenHash } from './entry-points.ts'
import { panelGate } from './panel-gate.ts'
import { temporaryRefusal } from './panel-temporary-login.ts'
import { createApiApp } from './server.ts'
import type { ApiApp } from './server.ts'

const SECRET = 'panel-access-fixture-secret-32-bytes-minimum'
const ORIGIN = 'https://whm.example.test:2087'
// Public independent libargon2 vector; this identity exists only in this test.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const IP = { remoteAddress: '198.51.100.1' }
let app: ApiApp, rootDir: string, rootId: string, cookie: string, csrf: string, close: () => Promise<void>, db: Parameters<typeof listAudit>[0]

beforeEach(async () => {
  const database = await createTestDb(), state = await createTestStateStore()
  close = async () => { await database.close(); await state.close() }
  db = database.db
  app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xwhm', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true })
  rootDir = state.store.rootDir
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  rootId = root.id
  const raw = randomBytes(32).toString('hex')
  await createSession(database.db, { principalId: root.id, tokenHash: sessionTokenHash(raw, 'xwhm'), mfaVerified: true, expiresAt: new Date(Date.now() + 3600_000).toISOString() })
  cookie = `${sessionCookieName('xwhm', true)}=${raw}`
  csrf = deriveCsrfToken(raw, SECRET, 'xwhm')
})
afterEach(() => close())

const anonymous = (path: string, headers: Record<string, string> = {}) => app.fetch(new Request(ORIGIN + path, { headers }), IP)
const signedIn = (path: string, method = 'GET', body?: unknown) => app.fetch(new Request(ORIGIN + path, { method, headers: { cookie, 'x-csrf-token': csrf, origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), IP)
const saveGate = async (policy: Partial<PanelGatePolicy>) => {
  const file = join(rootDir, SEC_STATE_PATHS['panel-gate'])
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ version: 1, policy: { ...PANEL_GATE_DEFAULT, ...policy }, updatedAt: new Date().toISOString() }))
}
const cookieOf = (response: Response): string => response.headers.getSetCookie().find(line => line.includes('_gate='))!.split(';')[0]!
const entrance = { path: 'door-2026-x', listeners: ['xwhm' as const] }

describe('entrance and unauthenticated response', () => {
  it('hides the panel without the entrance and shows the sign-in after it', async () => {
    await saveGate({ entrance })
    const hidden = await anonymous('/login', { accept: 'text/html' })
    expect(hidden.status).toBe(404)
    expect(await hidden.text()).toBe('')
    expect((await anonymous('/api/auth/me')).status).toBe(404)
    const pass = await anonymous('/door-2026-x')
    expect(pass.status).toBe(303)
    expect(pass.headers.get('location')).toBe('/login')
    expect((await anonymous('/api/auth/me', { cookie: cookieOf(pass) })).status).toBe(401)
  })

  it('refuses a forged or stale pass and lets an open session keep working', async () => {
    await saveGate({ entrance })
    const pass = cookieOf(await anonymous('/door-2026-x'))
    expect((await anonymous('/login', { cookie: pass.slice(0, -2) + 'xx' })).status).toBe(404)
    await saveGate({ entrance: { ...entrance, path: 'door-2027-y' } })
    expect((await anonymous('/login', { cookie: pass })).status).toBe(404)
    expect((await signedIn('/api/auth/me')).status).toBe(200)
  })

  it('answers with the configured response and spares machine routes', async () => {
    await saveGate({ entrance, response: { kind: 'forbidden', url: null } })
    expect((await anonymous('/login')).status).toBe(403)
    await saveGate({ entrance, response: { kind: 'blank', url: null } })
    expect((await anonymous('/login')).status).toBe(200)
    await saveGate({ entrance, response: { kind: 'redirect', url: 'https://example.com/' } })
    expect((await anonymous('/login')).headers.get('location')).toBe('https://example.com/')
    expect((await anonymous('/api/health')).status).toBe(200)
    // Past the gate, which would redirect: a scheduler hook carries its own key.
    expect((await anonymous('/hook/aaaaaaaaaaa1')).status).toBe(404)
    // A share link is its own credential too: it reaches the route, which is closed on this listener.
    expect((await anonymous('/share/aaaaaaaaaaa1')).headers.get('location')).toBeNull()
  })

  it('admits a valid token through basic authentication, and a cluster peer through both', async () => {
    await saveGate({ entrance, basicAuth: { username: 'guard', passwordHash: await passwordHashFromInput({ password: 'correct horse battery' }), listeners: ['xwhm'] } })
    const gate = (pathname: string, authorization: string, hasSession: boolean) => panelGate({ rootDir, listener: 'xwhm', request: new Request(ORIGIN + pathname, { headers: { authorization } }), pathname, search: '', method: 'POST', secret: 'x'.repeat(64), secure: true, client: () => '192.0.2.1', hasSession: async () => hasSession })
    expect(await gate('/api/server/nodes/peer/live/alice/freeze', 'Bearer real', true)).toBeNull()
    expect((await gate('/api/server/nodes/peer/live/alice/freeze', 'Bearer forged', false))!.status).toBe(404)
    expect((await gate('/api/cluster/dns/zones', 'Bearer member', false))).toBeNull()
  })

  it('applies only to the listed entry point', async () => {
    await saveGate({ entrance: { ...entrance, listeners: ['xmail'] } })
    expect((await anonymous('/api/auth/me')).status).toBe(401)
  })

  it('closes a broken rules file and reopens from a reset', async () => {
    await saveGate({ entrance })
    await writeFile(join(rootDir, SEC_STATE_PATHS['panel-gate']), '{broken')
    expect((await anonymous('/login')).status).toBe(503)
    expect((await anonymous('/api/health')).status).toBe(200)
  })
})

describe('basic authentication', () => {
  it('asks before the sign-in page and never authenticates a person', async () => {
    await saveGate({ basicAuth: { username: 'guard', passwordHash: await passwordHashFromInput({ password: 'correct horse battery' }), listeners: ['xwhm'] } })
    const asked = await anonymous('/login', { accept: 'text/html' })
    expect(asked.status).toBe(401)
    expect(asked.headers.get('www-authenticate')).toContain('Basic')
    const basic = `Basic ${Buffer.from('guard:correct horse battery').toString('base64')}`
    expect((await anonymous('/login', { authorization: `Basic ${Buffer.from('guard:wrong').toString('base64')}` })).status).toBe(401)
    const passed = await anonymous('/login', { accept: 'text/html', authorization: basic })
    expect(passed.status).toBe(303)
    expect((await anonymous('/api/auth/me', { authorization: basic, cookie: cookieOf(passed) })).status).toBe(401)
  })

  it('keeps a signed-in browser working when it also sends the basic header', async () => {
    const password = 'correct horse battery'
    await saveGate({ basicAuth: { username: 'guard', passwordHash: await passwordHashFromInput({ password }), listeners: ['xwhm'] } })
    const response = await app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie, authorization: `Basic ${Buffer.from(`guard:${password}`).toString('base64')}` } }), IP)
    expect(response.status).toBe(303)
    const again = await app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: `${cookie}; ${cookieOf(response)}`, authorization: `Basic ${Buffer.from(`guard:${password}`).toString('base64')}` } }), IP)
    expect(again.status).toBe(200)
  })
})

describe('saving the gate', () => {
  it('stores the password as a hash, never shows it, and keeps the saver signed in', async () => {
    const read = await (await signedIn('/api/server/panel-access')).json() as { revision: string }
    const saved = await signedIn('/api/server/panel-access/gate', 'PUT', { expectedRevision: read.revision, entrance, response: PANEL_GATE_DEFAULT.response, stopped: [], basicAuth: { username: 'guard', password: 'correct horse battery', listeners: ['xwhm'] } })
    expect(saved.status).toBe(200)
    const body = await saved.text()
    expect(body).not.toContain('argon2')
    expect(body).not.toContain('correct horse')
    expect(saved.headers.getSetCookie().join()).toContain('_gate=')
    expect((await listAudit(db, { limit: 5 })).map(row => row.action)).toContain('server.panel_access.gate_saved')
  })

  it('returns ENTRANCE_TOO_SHORT as 422 and refuses a stale revision', async () => {
    const short = await signedIn('/api/server/panel-access/gate', 'PUT', { expectedRevision: secRevision('panel-gate', null), entrance: { path: 'short1', listeners: ['xwhm'] }, response: PANEL_GATE_DEFAULT.response, stopped: [], basicAuth: null })
    expect(short.status).toBe(422)
    expect(await short.json()).toMatchObject({ details: { reason: 'ENTRANCE_TOO_SHORT' } })
    const stale = await signedIn('/api/server/panel-access/gate', 'PUT', { expectedRevision: 'a'.repeat(64), entrance: null, response: PANEL_GATE_DEFAULT.response, stopped: [], basicAuth: null })
    expect(stale.status).toBe(409)
  })

  it('refuses to move the panel without the host agent and validates the port first', async () => {
    const hosts = { xpanel: null, xwhm: null, xmail: null }
    const bad = await signedIn('/api/server/panel-access/binding', 'PUT', { ports: { xpanel: 2083, xwhm: 70000, xmail: 2096 }, hosts })
    expect(bad.status).toBe(422)
    expect(await bad.json()).toMatchObject({ details: { reason: 'INVALID_PORT' } })
    const busy = await signedIn('/api/server/panel-access/binding', 'PUT', { ports: { xpanel: 2083, xwhm: 443, xmail: 2096 }, hosts })
    expect(busy.status).toBe(409)
    const noAgent = await signedIn('/api/server/panel-access/binding', 'PUT', { ports: { xpanel: 2083, xwhm: 18888, xmail: 2096 }, hosts })
    expect(noAgent.status).toBe(412)
    expect(await noAgent.json()).toMatchObject({ details: { reason: 'host_agent_unavailable' } })
  })
})

describe('temporary sign-in links', () => {
  const create = async (lifetimeMinutes = 60) => {
    const response = await signedIn('/api/server/panel-access/temporary-logins', 'POST', { lifetimeMinutes, note: 'support' })
    expect(response.status).toBe(201)
    return await response.json() as { id: string; url: string }
  }
  const open = (url: string) => app.fetch(new Request(url, { method: 'POST', headers: { origin: ORIGIN } }), IP)
  const sessionOf = (response: Response): string => response.headers.getSetCookie().find(line => line.includes('xwhm_session='))!.split(';')[0]!

  it('opens a read-only session once, with its own activity log', async () => {
    const { id, url } = await create()
    const page = await app.fetch(new Request(url), IP)
    expect(page.status).toBe(200)
    expect(page.headers.get('referrer-policy')).toBe('same-origin')
    const opened = await open(url)
    expect(opened.status).toBe(303)
    expect(opened.headers.get('location')).toBe('/whm')
    const helper = sessionOf(opened)
    expect((await app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: helper } }), IP)).status).toBe(200)
    const listed = await app.fetch(new Request(`${ORIGIN}/api/server/hostname-history`, { headers: { cookie: helper } }), IP)
    expect(listed.status).not.toBe(403)
    const change = await app.fetch(new Request(`${ORIGIN}/api/server/panel-access/binding`, { method: 'PUT', headers: { cookie: helper, origin: ORIGIN, 'content-type': 'application/json' }, body: '{}' }), IP)
    expect(change.status).toBe(403)
    expect((await app.fetch(new Request(`${ORIGIN}/api/server/panel-access`, { headers: { cookie: helper } }), IP)).status).toBe(403)
    const reuse = await open(url)
    expect(reuse.status).toBe(401)
    expect(await reuse.text()).toContain('LINK_USED')
    const activity = await (await signedIn(`/api/server/panel-access/temporary-logins/${id}/activity`)).json() as { rows: { action: string; outcome: string }[] }
    expect(activity.rows.map(row => row.action)).toEqual(expect.arrayContaining(['temporary_login.opened', 'temporary_login.refused']))
  })

  it('returns LINK_EXPIRED as 401 and spends nothing on a preview', async () => {
    const { url } = await create(5)
    expect((await app.fetch(new Request(url), IP)).status).toBe(200)
    expect((await app.fetch(new Request(url), IP)).status).toBe(200)
    const file = join(rootDir, SEC_STATE_PATHS['panel-temporary-logins']), { readFile } = await import('node:fs/promises')
    const record = JSON.parse(await readFile(file, 'utf8')) as { policy: { logins: { expiresAt: string }[] } }
    record.policy.logins[0]!.expiresAt = '2020-01-01T00:00:00.000Z'
    await writeFile(file, JSON.stringify(record))
    const expired = await app.fetch(new Request(url, { headers: { accept: 'application/json' } }), IP)
    expect(expired.status).toBe(401)
    expect(await expired.json()).toMatchObject({ code: 'LINK_EXPIRED' })
  })

  it('ends a session when its link is revoked, and refuses a foreign form post', async () => {
    const { id, url } = await create()
    expect((await app.fetch(new Request(url, { method: 'POST', headers: { origin: 'https://evil.example' } }), IP)).status).toBe(403)
    const helper = sessionOf(await open(url))
    expect((await signedIn(`/api/server/panel-access/temporary-logins/${id}`, 'DELETE')).status).toBe(200)
    expect((await app.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { cookie: helper } }), IP)).status).toBe(401)
    const issued = await (await signedIn('/api/server/panel-access')).json() as { temporaryLogins: { state: string }[] }
    expect(issued.temporaryLogins[0]!.state).toBe('revoked')
    expect(rootId).toBeTruthy()
  })

  it('passes through the gate on the strength of the token alone', async () => {
    const { url } = await create()
    await saveGate({ entrance })
    expect((await app.fetch(new Request(url), IP)).status).toBe(200)
    const opened = await open(url)
    expect(opened.status).toBe(303)
    expect(opened.headers.getSetCookie().join()).toContain('_gate=')
  })

  it('reads only: every write and every download is refused', () => {
    expect(temporaryRefusal('/api/accounts', 'POST')).toBe('temporary_session_read_only')
    expect(temporaryRefusal('/api/server/hostname', 'PUT')).toBe('temporary_session_read_only')
    expect(temporaryRefusal('/api/server/sec/panel-access', 'GET')).toBe('temporary_session_no_access')
    expect(temporaryRefusal('/api/account/logs/x/access/download', 'GET')).toBe('temporary_session_no_access')
    for (const path of ['/api/server/panel-backups/xpanel-control-20261107T000000Z.tar.gz', '/api/databases/11111111-1111-4111-8111-111111111111/dump', '/api/server/config-as-code/export', '/api/server/ftp-log/raw']) expect(temporaryRefusal(path, 'GET'), path).toBe('temporary_session_no_access')
    expect(temporaryRefusal('/api/server/panel-backups', 'GET')).toBeNull()
    expect(temporaryRefusal('/api/auth/logout', 'POST')).toBeNull()
    expect(temporaryRefusal('/api/accounts', 'GET')).toBeNull()
    for (const path of ['/api/server/root-password', '/api/server/databases/root-password', '/api/transfers/credentials', '/api/transfers/ssh-key', '/api/server/ssl/keys/x', '/api/accounts/x/ssl/keys/y']) expect(temporaryRefusal(path, 'GET')).toBe('temporary_session_no_access')
  })

  it('refuses every write route of the authorization matrix, logout aside', () => {
    const { routes } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../docs/planning/authorization-route-matrix.json'), 'utf8')) as { routes: { method: string; path: string }[] }
    const writes = routes.filter(route => !['GET', 'HEAD', 'OPTIONS'].includes(route.method) && route.path !== '/api/auth/logout')
    expect(writes.length).toBeGreaterThan(100)
    for (const route of writes) expect(temporaryRefusal(route.path, route.method), route.path).toBe('temporary_session_read_only')
  })
})

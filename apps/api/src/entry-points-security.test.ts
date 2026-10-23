import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, it } from 'vitest'
import WebSocket from 'ws'
import { createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal, revokeSession } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { computeTotpCode, deriveCsrfToken, sha256Hex } from './auth.ts'
import { ENTRY_POINTS, sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { createApiApp, listenApiServer, type ApiServerDeps } from './server.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'

// Public independent libargon2 vector; these identities and network listeners exist only in this test.
const PASSWORD = 'correct horse battery staple'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'entry-point-security-fixture-32-bytes-minimum'
const profiles = ['xpanel', 'xwhm', 'xmail'] as const
const origin = (profile: EntryPoint) => `https://panel.example.test:${ENTRY_POINTS[profile].port}`
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const feature = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Standard', ownerId: null, featureListId: feature.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10000000, ioWriteBps: 10000000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 5, mailingLists: 2, ftpAccounts: 5, databases: 5, phpWorkers: 4 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 512 })
  const account = await state.store.createAccount({ username: 'alice', passwordHash: HASH, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'alice@example.test', ipv4: '203.0.113.10', shell: 'jailed',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
  const user = await createUserPrincipal(database.db, { username: 'alice', passwordHash: HASH, accountId: account.id })
  await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  await createResellerPrincipal(database.db, { username: 'reseller', passwordHash: HASH })
  const servers = new Map<EntryPoint, Awaited<ReturnType<typeof listenApiServer>>>()
  for (const profile of profiles) {
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: profile, publicOrigin: origin(profile), allowedOrigins: [origin(profile)], secureCookies: true, requireOriginHeader: true, lockoutThreshold: 20 })
    const listener = await listenApiServer(app, { host: '127.0.0.1', port: 0 })
    cleanup.push(() => { listener.server.closeAllConnections(); return listener.close() })
    servers.set(profile, listener)
  }
  const request = (profile: EntryPoint, path: string, options: { method?: string; body?: unknown; cookie?: string; csrf?: string; headers?: Record<string, string> } = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: servers.get(profile)!.port, path, method: options.method ?? 'GET', headers: { host: new URL(origin(profile)).host, origin: origin(profile), ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.cookie ? { cookie: options.cookie } : {}), ...(options.csrf ? { 'x-csrf-token': options.csrf } : {}), ...options.headers } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers }))
      })
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body !== undefined ? JSON.stringify(options.body) : undefined)
  })
  const login = async (profile: EntryPoint, username = 'alice') => {
    const response = await request(profile, '/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } })
    const data = await response.json() as { csrfToken?: string; home?: string; mfaEnrollmentRequired?: boolean }
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? ''
    return { response, data, cookie, raw: cookie.slice(cookie.indexOf('=') + 1) }
  }
  const websocketStatus = (profile: EntryPoint, cookie: string, headers: Record<string, string> = {}): Promise<number> => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${servers.get(profile)!.port}/api/ws`, { headers: { host: new URL(origin(profile)).host, origin: origin(profile), cookie, ...headers }, handshakeTimeout: 2000 })
    ws.once('open', () => { ws.terminate(); resolve(101) })
    ws.once('unexpected-response', (_req, response) => { response.resume(); ws.terminate(); resolve(response.statusCode!) })
    ws.on('error', error => { if (!String(error).includes('closed before')) reject(error) })
  })
  return { database, state, account, user, servers, request, login, websocketStatus }
}

describe('interactive entry point isolation on real HTTP and WebSocket listeners', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })

  it('issues distinct cookies, server-selected homes and audience-separated database credentials', async () => {
    const panel = await f.login('xpanel'); const mail = await f.login('xmail')
    assert.equal(panel.response.status, 200); assert.equal(mail.response.status, 200)
    assert.equal(panel.data.home, '/panel'); assert.equal(mail.data.home, '/mail')
    assert.ok(panel.cookie.startsWith('__Host-xpanel_session=')); assert.ok(mail.cookie.startsWith('__Host-xmail_session='))
    assert.notEqual(sessionTokenHash(panel.raw, 'xpanel'), sessionTokenHash(panel.raw, 'xmail'))
    assert.notEqual(sessionTokenHash(panel.raw, 'xpanel'), sha256Hex(panel.raw))
    assert.equal(panel.data.csrfToken, deriveCsrfToken(panel.raw, SECRET, 'xpanel'))
    assert.notEqual(panel.data.csrfToken, deriveCsrfToken(panel.raw, SECRET, 'xmail'))
    assert.notEqual(panel.data.csrfToken, deriveCsrfToken(panel.raw, SECRET))
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 200)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: `${sessionCookieName('xpanel')}=${panel.raw}` })).status, 401)
    assert.equal((await f.request('xmail', '/api/auth/me', { cookie: mail.cookie })).status, 200)
  })

  it('rejects cross-profile raw-token replay even when renamed to the destination cookie', async () => {
    for (const source of profiles) {
      const session = await f.login(source, source === 'xwhm' ? 'root' : 'alice')
      assert.equal(session.response.status, 200)
      for (const destination of profiles.filter(value => value !== source)) {
        const replay = `${sessionCookieName(destination, true)}=${session.raw}`
        assert.equal((await f.request(destination, '/api/auth/me', { cookie: replay })).status, 401)
      }
    }
  })

  it('rejects valid credentials for the wrong role without issuing any cookie', async () => {
    for (const [profile, username] of [['xpanel', 'root'], ['xpanel', 'reseller'], ['xmail', 'root'], ['xmail', 'reseller'], ['xwhm', 'alice']] as const) {
      const session = await f.login(profile, username)
      assert.equal(session.response.status, 401); assert.equal(session.response.headers.get('set-cookie'), null)
    }
    const root = await f.login('xwhm', 'root')
    assert.equal(root.data.mfaEnrollmentRequired, true)
    assert.equal((await f.request('xwhm', '/api/accounts', { cookie: root.cookie })).status, 403)
  })

  it('confines APIs before routing and refuses query/header audience overrides', async () => {
    const mail = await f.login('xmail')
    for (const path of ['/api/accounts', '/api/accounts/alice/files', '/api/domains', '/api/server/settings', '/api/catalog', '/api/events/recent', '/api/mail/filters']) {
      assert.equal((await f.request('xmail', `${path}?entryPoint=xwhm&role=root`, { cookie: mail.cookie, headers: { 'x-entry-point': 'xwhm', 'x-role': 'root' } })).status, 404)
    }
    const panel = await f.login('xpanel')
    for (const path of ['/api/server/settings', '/api/lifecycle/upgrade', '/api/mail/ips', '/api/firewall', '/api/setup/wizard', '/api/webmail/folders']) assert.equal((await f.request('xpanel', path, { cookie: panel.cookie })).status, 404)
    assert.equal((await f.request('xwhm', '/api/webmail/folders')).status, 404)
    assert.equal((await f.request('xpanel', '/api/accounts', { method: 'POST', cookie: panel.cookie, csrf: panel.data.csrfToken, body: {} })).status, 404)
    // Account workspace sessions never become mailbox principals or an empty successful mailbox.
    assert.notEqual((await f.request('xmail', '/api/webmail/folders', { cookie: mail.cookie })).status, 200)
  })

  it('rejects another port origin, missing origin and a mismatched public Host', async () => {
    const panel = await f.login('xpanel')
    const headers = { origin: origin('xmail') }
    assert.equal((await f.request('xpanel', '/api/auth/login', { method: 'POST', body: { username: 'alice', password: PASSWORD }, headers })).status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: panel.cookie, csrf: panel.data.csrfToken, headers })).status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: panel.cookie, csrf: panel.data.csrfToken, headers: { origin: '' } })).status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie, headers: { host: new URL(origin('xmail')).host } })).status, 421)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 200)
  })

  it('logs out only the current profile session but credential changes revoke every profile session', async () => {
    const panel = await f.login('xpanel'); const mail = await f.login('xmail')
    const logout = await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: panel.cookie, csrf: panel.data.csrfToken })
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /^__Host-xpanel_session=;/)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 401)
    assert.equal((await f.request('xmail', '/api/auth/me', { cookie: mail.cookie })).status, 200)
    const secondPanel = await f.login('xpanel')
    const changed = await f.request('xmail', '/api/auth/change-password', { method: 'POST', cookie: mail.cookie, csrf: mail.data.csrfToken, body: { currentPassword: PASSWORD, newPassword: 'New-password-fixture-2026' } })
    assert.equal(changed.status, 200)
    assert.match(changed.headers.get('set-cookie')!, /^__Host-xmail_session=;/)
    assert.equal((await f.request('xmail', '/api/auth/me', { cookie: mail.cookie })).status, 401)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: secondPanel.cookie })).status, 401)
  })

  it('denies bearer API keys on every interactive listener even alongside a valid cookie', async () => {
    const raw = 'xp_public_fixture_interactive_audience_denial'
    await createApiToken(f.database.db, { principalId: f.user.id, name: 'fixture', tokenHash: sha256Hex(raw), scopes: ['*'], allowedIps: [], expiresAt: new Date(Date.now() + 3600000).toISOString() })
    for (const profile of profiles) {
      const session = await f.login(profile, profile === 'xwhm' ? 'root' : 'alice')
      assert.equal((await f.request(profile, '/api/auth/me', { cookie: session.cookie, headers: { authorization: `Bearer ${raw}` } })).status, 401)
    }
  })

  it('authorizes same-profile WebSockets and denies renamed replay, wrong origin and all xMail upgrades', async () => {
    const panel = await f.login('xpanel'); const mail = await f.login('xmail')
    assert.equal(await f.websocketStatus('xpanel', panel.cookie), 101)
    assert.equal(await f.websocketStatus('xpanel', `${sessionCookieName('xpanel', true)}=${mail.raw}`), 401)
    assert.equal(await f.websocketStatus('xpanel', panel.cookie, { origin: origin('xmail') }), 401)
    assert.equal(await f.websocketStatus('xpanel', panel.cookie, { authorization: 'Bearer xp_unsupported_fixture' }), 401)
    assert.equal(await f.websocketStatus('xmail', mail.cookie), 401)
    assert.equal(await f.websocketStatus('xwhm', `${sessionCookieName('xwhm', true)}=${panel.raw}`), 401)
  })

  it('retains root bootstrap, TOTP and single-use recovery inside the administrative audience', async () => {
    const root = await f.login('xwhm', 'root')
    const setup = await f.request('xwhm', '/api/auth/2fa/setup', { method: 'POST', cookie: root.cookie, csrf: root.data.csrfToken, body: { password: PASSWORD } })
    assert.equal(setup.status, 200)
    const enrollment = await setup.json() as { secret: string; recoveryCodes: string[] }
    const enabled = await f.request('xwhm', '/api/auth/2fa/enable', { method: 'POST', cookie: root.cookie, csrf: root.data.csrfToken, body: { code: computeTotpCode(enrollment.secret) } })
    assert.equal(enabled.status, 200)
    assert.equal((await f.request('xwhm', '/api/auth/me', { cookie: root.cookie })).status, 200)
    assert.equal(await f.websocketStatus('xwhm', root.cookie), 101)
    const recoveryCode = enrollment.recoveryCodes[0]!
    const wrongAudience = await f.request('xpanel', '/api/auth/login', { method: 'POST', body: { username: 'root', password: PASSWORD, recoveryCode } })
    assert.equal(wrongAudience.status, 401)
    assert.equal(wrongAudience.headers.get('set-cookie'), null)
    const recovered = await f.request('xwhm', '/api/auth/login', { method: 'POST', body: { username: 'root', password: PASSWORD, recoveryCode } })
    assert.equal(recovered.status, 200)
    const replay = await f.request('xwhm', '/api/auth/login', { method: 'POST', body: { username: 'root', password: PASSWORD, recoveryCode } })
    assert.equal(replay.status, 401)
    assert.equal(replay.headers.get('set-cookie'), null)
  })

  it('rejects legacy-hash, expired and revoked session records on an explicit audience', async () => {
    const create = (tokenHash: string) => createSession(f.database.db, { principalId: f.user.id, tokenHash, expiresAt: new Date(Date.now() + 3600000).toISOString(), ip: '127.0.0.1', userAgent: 'fixture', mfaVerified: false })
    const legacy = 'public_legacy_session_fixture'
    await create(sha256Hex(legacy))
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: `${sessionCookieName('xpanel', true)}=${legacy}` })).status, 401)
    const expired = 'public_expired_session_fixture'
    const expiredSession = await create(sessionTokenHash(expired, 'xpanel'))
    await f.database.db.query('UPDATE sessions SET created_at = $1, last_seen_at = $1, expires_at = $2 WHERE id = $3', [new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() - 1000).toISOString(), expiredSession.id])
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: `${sessionCookieName('xpanel', true)}=${expired}` })).status, 401)
    const raw = 'public_revoked_session_fixture'
    const session = await create(sessionTokenHash(raw, 'xpanel'))
    const cookie = `${sessionCookieName('xpanel', true)}=${raw}`
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie })).status, 200)
    await revokeSession(f.database.db, session.id)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie })).status, 401)
  })

  it('rejects ambiguous origin lists and keeps the configured profile immutable', async () => {
    const deps: ApiServerDeps = { db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint: 'xmail', allowedOrigins: [origin('xmail')] }
    assert.throws(() => createApiApp({ ...deps, allowedOrigins: profiles.map(origin) }), /one exact allowed origin/)
    assert.throws(() => createApiApp({ ...deps, allowedOrigins: ['*'] }), /exact HTTPS/)
    const app = createApiApp(deps)
    deps.entryPoint = 'xwhm'
    assert.equal((await app.fetch(new Request(`${origin('xmail')}/api/accounts`))).status, 404)
  })

  it('protects HTML as well as API traffic with authenticated HTTPS ingress', async () => {
    let rendered = 0
    const ingressSecret = 'public_test_ingress_credential_32_bytes_minimum'
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint: 'xpanel', publicOrigin: origin('xpanel'), allowedOrigins: [origin('xpanel')], requireSecureCookies: true, secureCookies: true, ingressSecret,
      webRenderer: () => { rendered++; return new Response('protected renderer fixture') } })
    const request = (headers: Record<string, string> = {}) => app.fetch(new Request(`${origin('xpanel')}/login`, { headers }), { remoteAddress: '127.0.0.1' })
    assert.equal((await request()).status, 403)
    assert.equal((await request({ 'x-forwarded-proto': 'https' })).status, 403)
    assert.equal(rendered, 0)
    assert.equal((await request({ 'x-forwarded-proto': 'https', 'x-xpanel-ingress-secret': ingressSecret })).status, 200)
    assert.equal(rendered, 1)
  })

  it('confines xPanel account-wide mail filters to the owning account without denied mutations', async () => {
    const other = await f.state.store.createAccount({ ...f.account, username: 'bob', primaryDomain: 'bob.example.test', contactEmail: 'bob@example.test', passwordHash: HASH,
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    const ext = new ExtendedFeaturesStore(f.state.rootDir)
    const rule = (accountId: string | null, name: string) => ({ id: randomUUID(), accountId, name, scope: 'global', mailbox: null, priority: 1, enabled: true, matchAll: true, conditions: [{ field: 'subject', comparator: 'contains', value: name }], action: { type: 'fileinto', target: 'Spam' }, compiledSieve: '', createdAt: new Date().toISOString() })
    const own = rule(f.account.id, 'Own rule')
    const foreign = rule(other.id, 'Foreign private rule')
    const serverWide = rule(null, 'Server private rule')
    const seeded = [own, foreign, serverWide]
    await ext.write('mail/filters.json', seeded)
    const session = await f.login('xpanel')
    const request = (path: string, method: string, body?: unknown) => f.request('xpanel', path, { method, cookie: session.cookie, csrf: session.data.csrfToken, ...(body !== undefined ? { body } : {}) })
    const listed = await request('/api/mail/filters', 'GET')
    assert.equal(listed.status, 200)
    const view = await listed.json() as { filters: Array<{ id: string }>; compiledSieve: string }
    assert.deepEqual(view.filters.map(item => item.id), [own.id])
    assert.equal(JSON.stringify(view).includes('Foreign private rule'), false)
    assert.equal(JSON.stringify(view).includes('Server private rule'), false)
    const createForeign = await request('/api/mail/filters', 'POST', { accountId: other.id, scope: 'global', name: 'Rejected foreign creation' })
    assert.equal(createForeign.status, 404)
    assert.deepEqual(await ext.readOrDefault('mail/filters.json', []), seeded)
    assert.equal((await request(`/api/mail/filters/${foreign.id}`, 'DELETE')).status, 404)
    assert.deepEqual(await ext.readOrDefault('mail/filters.json', []), seeded)
    assert.equal((await request(`/api/mail/filters/${serverWide.id}`, 'DELETE')).status, 403)
    assert.deepEqual(await ext.readOrDefault('mail/filters.json', []), seeded)
    const allowed = await request('/api/mail/filters', 'POST', { accountId: f.account.id, scope: 'global', name: 'Owned account-wide rule' })
    assert.equal(allowed.status, 201)
  })
})

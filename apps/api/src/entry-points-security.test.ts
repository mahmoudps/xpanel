import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, it } from 'vitest'
import WebSocket from 'ws'
import { createApiToken, createDb, createResellerPrincipal, createRootPrincipal, createSession, createTestDb, createUserPrincipal, revokeSession } from '@xpanel/db'
import { createStateStore, createTestStateStore } from '@xpanel/state'
import { ACCOUNT_SELF_PASSWORD_MIN_LENGTH, MIN_ARGON2_MEMORY_KIB, fail } from '@xpanel/core'
import { computeTotpCode, deriveCsrfToken, hashPasswordArgon2id, sha256Hex, verifyPasswordArgon2id } from './auth.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { ENTRY_POINTS, entryPointAllowsApiRoute, sessionCookieName, sessionTokenHash, type EntryPoint } from './entry-points.ts'
import { createApiApp, listenApiServer, type ApiServerDeps } from './server.ts'
import { ExtendedFeaturesStore } from './extended-routes.ts'
import { writeSignInLockout } from './testing/sign-in-policy-fixture.ts'

// Public independent libargon2 vector; these identities and network listeners exist only in this test.
const PASSWORD = 'correct horse battery staple'
let HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SECRET = 'entry-point-security-fixture-32-bytes-minimum'
const STATE_PARENT = existsSync('/dev/shm') ? '/dev/shm' : tmpdir()
const profiles = ['xpanel', 'xwhm', 'xmail'] as const
const origin = (profile: EntryPoint) => `https://panel.example.test:${ENTRY_POINTS[profile].port}`
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

interface CachedStateFile { relPath: string; bytes: Buffer }
const buildStateTemplate = async () => {
  HASH = await hashPasswordArgon2id(PASSWORD, { memoryKiB: MIN_ARGON2_MEMORY_KIB, timeCost: 1, parallelism: 1 })
  const seedDb = await createTestDb()
  const state = await createTestStateStore()
  try {
    const feature = await state.store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({ name: 'Standard', ownerId: null, featureListId: feature.id,
      resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10000000, ioWriteBps: 10000000, ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
      caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 5, mailingLists: 2, ftpAccounts: 5, databases: 5, phpWorkers: 4 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 512 })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const account = await state.store.createAccount({ username: 'alice', passwordHash: HASH, primaryDomain: 'alice.example.test', planId: plan.id, ownerId: null, contactEmail: 'alice@example.test', ipv4: '203.0.113.10', shell: 'jailed',
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    // xMail admits mailbox addresses only; the hosting account owner signs in on xPanel.
    const mailbox = await state.store.createServiceUser({ accountId: account.id, login: 'inbox@alice.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
    await writeSignInLockout(state.store.rootDir, 20)
    const user = await createUserPrincipal(seedDb.db, { username: 'alice', passwordHash: HASH, accountId: account.id })
    await createRootPrincipal(seedDb.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    await createResellerPrincipal(seedDb.db, { username: 'reseller', passwordHash: HASH })
    const lock = state.store.getWriterLock()
    const stateFiles: CachedStateFile[] = []
    const dirSet = new Set<string>()
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (full === lock.mutexFilePath || full.startsWith(lock.mutexFilePath + '-') || full === lock.lockDirPath || full.startsWith(lock.lockDirPath + sep)) continue
        const rel = relative(state.rootDir, full)
        if (entry.isDirectory()) { dirSet.add(rel); await walk(full) }
        else { const d = dirname(rel); if (d !== '.') dirSet.add(d); stateFiles.push({ relPath: rel, bytes: await readFile(full) }) }
      }
    }
    await walk(state.rootDir)
    return { sqlite: seedDb.sqlite.serialize(), stateFiles, relDirs: [...dirSet], feature, account, mailbox, user }
  } finally {
    await state.close()
    await seedDb.close()
  }
}
let template!: Awaited<ReturnType<typeof buildStateTemplate>>

const fixture = async () => {
  const database = createDb(':memory:')
  database.sqlite.deserialize(template.sqlite)
  const rootDir = await mkdtemp(join(STATE_PARENT, 'xpanel-state-'))
  for (const relDir of template.relDirs) await mkdir(join(rootDir, relDir), { recursive: true, mode: 0o750 })
  await Promise.all(template.stateFiles.map(file => writeFile(join(rootDir, file.relPath), file.bytes, { mode: 0o640 })))
  const state = { store: createStateStore(rootDir), rootDir, close: () => rm(rootDir, { recursive: true, force: true }) }
  cleanup.push(() => database.close(), () => state.close())
  const { feature, account, mailbox, user } = template
  // A disposable silent listener prevents a watch from reaching any installed mail service.
  const imapSockets = new Set<Socket>()
  const imap = createNetServer(socket => { imapSockets.add(socket); socket.on('error', () => {}); socket.once('close', () => imapSockets.delete(socket)) })
  await new Promise<void>(resolve => imap.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const socket of imapSockets) socket.destroy(); await new Promise<void>(resolve => imap.close(() => resolve())) })
  const imapAddress = imap.address()
  assert.ok(imapAddress && typeof imapAddress === 'object')
  const mailboxTransport: MailboxTransport = {
    async verify(login, password) {
      const serviceUser = await state.store.getServiceUserByLogin(login)
      const storedHash = serviceUser ? await state.store.getServiceUserHash(serviceUser.id) : null
      const hash = storedHash?.startsWith('{ARGON2ID}') ? storedHash.slice('{ARGON2ID}'.length) : storedHash
      if (!serviceUser?.services.email || typeof hash !== 'string' || !await verifyPasswordArgon2id(password, hash)) fail('UNAUTHENTICATED', 'invalid mailbox credentials')
    },
    async list() { return [] }, async read() { return fail('NOT_FOUND', 'message not found') }, async remove() {},
    async send() { return { messageId: '<synthetic-entry-point@example.test>' } },
  }
  const servers = new Map<EntryPoint, Awaited<ReturnType<typeof listenApiServer>>>()
  for (const profile of profiles) {
    const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: profile, publicOrigin: origin(profile), allowedOrigins: [origin(profile)], secureCookies: true, requireOriginHeader: true,
      ...(profile === 'xmail' ? { mailboxTransport, mailboxEnvironment: { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: String(imapAddress.port), XPANEL_IMAP_TIMEOUT_MS: '100' } } : {}),
    })
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
  const login = async (profile: EntryPoint, username = profile === 'xmail' ? mailbox.login : 'alice') => {
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
  return { database, state, account, feature, user, mailbox, servers, request, login, websocketStatus }
}

describe('interactive entry point isolation on real HTTP and WebSocket listeners', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { template = await buildStateTemplate() })
  afterAll(async () => {})
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
      const session = await f.login(source, source === 'xwhm' ? 'root' : undefined)
      assert.equal(session.response.status, 200)
      for (const destination of profiles.filter(value => value !== source)) {
        const replay = `${sessionCookieName(destination, true)}=${session.raw}`
        assert.equal((await f.request(destination, '/api/auth/me', { cookie: replay })).status, 401)
      }
    }
  })

  it('rejects valid credentials for the wrong role without issuing any cookie', { tags: ['slow'] }, async () => {
    for (const [profile, username] of [['xpanel', 'root'], ['xpanel', 'reseller'], ['xmail', 'root'], ['xmail', 'reseller'], ['xmail', 'alice'], ['xwhm', 'alice'], ['xpanel', 'inbox@alice.example.test'], ['xwhm', 'inbox@alice.example.test']] as const) {
      const session = await f.login(profile, username)
      assert.equal(session.response.status, 401); assert.equal(session.response.headers.get('set-cookie'), null)
    }
    const root = await f.login('xwhm', 'root')
    assert.equal(root.data.mfaEnrollmentRequired, false)
    assert.equal((await f.request('xwhm', '/api/accounts', { cookie: root.cookie })).status, 200)
    assert.equal(await f.websocketStatus('xwhm', root.cookie), 101)
    const reseller = await f.login('xwhm', 'reseller')
    assert.equal(reseller.response.status, 200)
    assert.equal(reseller.data.mfaEnrollmentRequired, false)
    assert.notEqual(reseller.response.headers.get('set-cookie'), null)
  })

  it('manages only the owner sessions on the real xPanel listener with CSRF and Origin protection', async () => {
    const panel = await f.login('xpanel')
    assert.equal(panel.response.status, 200)
    assert.ok(typeof panel.data.csrfToken === 'string')
    const csrf = panel.data.csrfToken
    const addOwned = () => createSession(f.database.db, { principalId: f.user.id,
      tokenHash: sessionTokenHash(randomUUID(), 'xpanel'), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const other = await addOwned()
    const foreignPrincipal = await createRootPrincipal(f.database.db, { username: 'foreign-self-session', passwordHash: HASH, forcePasswordChange: false })
    const foreign = await createSession(f.database.db, { principalId: foreignPrincipal.id,
      tokenHash: sessionTokenHash(randomUUID(), 'xpanel'), expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const read = async () => {
      const response = await f.request('xpanel', '/api/auth/sessions', { cookie: panel.cookie })
      assert.equal(response.status, 200)
      return await response.json() as { sessions: { id: string; current: boolean; tokenHash?: unknown; principalId?: unknown }[]; currentSessionId: string }
    }
    const before = await read()
    assert.equal(before.sessions.length, 2)
    assert.ok(before.sessions.some(row => row.id === other.id && !row.current))
    assert.ok(before.sessions.some(row => row.id === before.currentSessionId && row.current))
    assert.ok(before.sessions.every(row => row.id !== foreign.id && row.tokenHash === undefined && row.principalId === undefined))
    assert.equal((await f.request('xpanel', '/api/auth/sessions/' + foreign.id, { method: 'DELETE', cookie: panel.cookie, csrf })).status, 404)
    assert.equal((await f.request('xpanel', '/api/auth/sessions/' + other.id, { method: 'DELETE', cookie: panel.cookie })).status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/sessions/' + other.id, { method: 'DELETE', cookie: panel.cookie, csrf, headers: { origin: origin('xmail') } })).status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/sessions/revoke-others', { method: 'POST', cookie: panel.cookie, csrf, headers: { origin: '' } })).status, 403)
    assert.equal((await read()).sessions.length, 2)
    const bearer = 'xp_nonoperational_self_sessions_fixture'
    await createApiToken(f.database.db, { principalId: f.user.id, name: 'self-sessions-fixture', tokenHash: sha256Hex(bearer),
      scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
    assert.equal((await f.request('xpanel', '/api/auth/sessions', { cookie: panel.cookie, headers: { authorization: 'Bearer ' + bearer } })).status, 401)
    const ended = await f.request('xpanel', '/api/auth/sessions/' + other.id, { method: 'DELETE', cookie: panel.cookie, csrf })
    assert.equal(ended.status, 200)
    assert.deepEqual(await ended.json(), { ok: true, currentSessionRevoked: false })
    assert.ok(!(await read()).sessions.some(row => row.id === other.id))
    const extra = await addOwned()
    const remaining = await f.request('xpanel', '/api/auth/sessions/revoke-others', { method: 'POST', cookie: panel.cookie, csrf })
    assert.equal(remaining.status, 200)
    assert.deepEqual(await remaining.json(), { ok: true, revokedCount: 1 })
    const after = await read()
    assert.equal(after.sessions.length, 1)
    assert.ok(after.sessions.every(row => row.current && row.id !== extra.id))
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 200)
    const current = await f.request('xpanel', '/api/auth/sessions/' + after.currentSessionId, { method: 'DELETE', cookie: panel.cookie, csrf })
    assert.equal(current.status, 200)
    assert.deepEqual(await current.json(), { ok: true, currentSessionRevoked: true })
    assert.match(current.headers.get('set-cookie') ?? '', /^__Host-xpanel_session=;/)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 401)
  })

  it('keeps the existing self-password boundary at seven rejected and eight accepted on the xPanel listener', async () => {
    const panel = await f.login('xpanel')
    assert.equal(panel.response.status, 200)
    assert.ok(typeof panel.data.csrfToken === 'string')
    const csrf = panel.data.csrfToken
    assert.equal(ACCOUNT_SELF_PASSWORD_MIN_LENGTH, 8)
    const protectedAuthState = async (): Promise<string> => {
      const principals = await f.database.db.query('SELECT id, password_hash, password_changed_at, force_password_change, disabled FROM principals WHERE id=$1', [f.user.id])
      const sessions = await f.database.db.query('SELECT id, token_hash, revoked_at FROM sessions WHERE principal_id=$1 ORDER BY id', [f.user.id])
      assert.equal(principals.length, 1)
      assert.ok(sessions.length > 0)
      // Normal authentication may touch lastSeen; compare only protected fields and never print credential material.
      return sha256Hex(JSON.stringify({ principals, sessions }))
    }
    const authBefore = await protectedAuthState()
    const short = 'a'.repeat(ACCOUNT_SELF_PASSWORD_MIN_LENGTH - 1)
    const accepted = 'a'.repeat(ACCOUNT_SELF_PASSWORD_MIN_LENGTH)
    const refused = await f.request('xpanel', '/api/auth/change-password', { method: 'POST', cookie: panel.cookie, csrf,
      body: { currentPassword: PASSWORD, newPassword: short } })
    assert.equal(refused.status, 422)
    const problem: unknown = await refused.json()
    assert.ok(problem !== null && typeof problem === 'object' && !Array.isArray(problem) && 'code' in problem && 'status' in problem)
    assert.equal(problem.code, 'VALIDATION')
    assert.equal(problem.status, 422)
    assert.equal(await protectedAuthState(), authBefore)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 200)
    const changed = await f.request('xpanel', '/api/auth/change-password', { method: 'POST', cookie: panel.cookie, csrf,
      body: { currentPassword: PASSWORD, newPassword: accepted } })
    assert.equal(changed.status, 200)
    assert.deepEqual(await changed.json(), { ok: true, reauthenticationRequired: true })
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 401)
    assert.equal((await f.request('xpanel', '/api/auth/login', { method: 'POST', body: { username: 'alice', password: accepted } })).status, 200)
    assert.equal((await f.request('xpanel', '/api/auth/login', { method: 'POST', body: { username: 'alice', password: PASSWORD } })).status, 401)
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
    // An account owner session never authenticates on xMail, so it can never act as a mailbox.
    const raw = 'owner-session-replayed-on-xmail-fixture'
    await createSession(f.database.db, { principalId: f.user.id, tokenHash: sessionTokenHash(raw, 'xmail'), mfaVerified: true, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    assert.equal((await f.request('xmail', '/api/webmail/folders', { cookie: `${sessionCookieName('xmail', true)}=${raw}` })).status, 401)
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

  it('ends the session on logout when the CSRF token is missing or stale, and still rejects a cross-origin logout', async () => {
    const missing = await f.login('xpanel')
    const logout = await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: missing.cookie })
    assert.equal(logout.status, 200)
    assert.match(logout.headers.get('set-cookie')!, /^__Host-xpanel_session=;/)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: missing.cookie })).status, 401)
    const stale = await f.login('xpanel')
    const expired = await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: stale.cookie, csrf: 'expired-csrf-token' })
    assert.equal(expired.status, 200)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: stale.cookie })).status, 401)
    const kept = await f.login('xpanel')
    const cross = await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: kept.cookie, headers: { origin: origin('xmail') } })
    assert.equal(cross.status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: kept.cookie })).status, 200)
    const other = await f.request('xpanel', '/api/auth/change-password', { method: 'POST', cookie: kept.cookie, body: { currentPassword: PASSWORD, newPassword: 'Another-password-fixture-2026' } })
    assert.equal(other.status, 403)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: kept.cookie })).status, 200)
  })

  it('logs out only the current profile session, and an owner credential change never touches the separate mailbox identity', async () => {
    const panel = await f.login('xpanel'); const mail = await f.login('xmail')
    const logout = await f.request('xpanel', '/api/auth/logout', { method: 'POST', cookie: panel.cookie, csrf: panel.data.csrfToken })
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /^__Host-xpanel_session=;/)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: panel.cookie })).status, 401)
    assert.equal((await f.request('xmail', '/api/auth/me', { cookie: mail.cookie })).status, 200)
    const secondPanel = await f.login('xpanel'); const thirdPanel = await f.login('xpanel')
    const changed = await f.request('xpanel', '/api/auth/change-password', { method: 'POST', cookie: secondPanel.cookie, csrf: secondPanel.data.csrfToken, body: { currentPassword: PASSWORD, newPassword: 'New-password-fixture-2026' } })
    assert.equal(changed.status, 200)
    assert.match(changed.headers.get('set-cookie')!, /^__Host-xpanel_session=;/)
    assert.equal((await f.request('xpanel', '/api/auth/me', { cookie: thirdPanel.cookie })).status, 401)
    assert.equal((await f.request('xmail', '/api/auth/me', { cookie: mail.cookie })).status, 200)
  })

  it('denies bearer API keys on every interactive listener even alongside a valid cookie', async () => {
    const raw = 'xp_public_fixture_interactive_audience_denial'
    await createApiToken(f.database.db, { principalId: f.user.id, name: 'fixture', tokenHash: sha256Hex(raw), scopes: ['*'], allowedIps: [], expiresAt: new Date(Date.now() + 3600000).toISOString() })
    for (const profile of profiles) {
      const session = await f.login(profile, profile === 'xwhm' ? 'root' : undefined)
      assert.equal((await f.request(profile, '/api/auth/me', { cookie: session.cookie, headers: { authorization: `Bearer ${raw}` } })).status, 401)
    }
  })

  it('authorizes same-profile WebSockets, including xMail, and denies renamed replay and a wrong origin', { tags: ['slow'] }, async () => {
    const panel = await f.login('xpanel')
    const accountMail = await f.login('xmail', 'alice')
    assert.equal(accountMail.response.status, 401)
    assert.equal(accountMail.response.headers.get('set-cookie'), null)
    const serviceUser = f.mailbox
    const mail = await f.login('xmail', serviceUser.login)
    assert.equal(mail.response.status, 200)
    assert.ok(mail.cookie.startsWith('__Host-xmail_session='))
    assert.equal(await f.websocketStatus('xpanel', panel.cookie), 101)
    assert.equal(await f.websocketStatus('xpanel', `${sessionCookieName('xpanel', true)}=${mail.raw}`), 401)
    assert.equal(await f.websocketStatus('xpanel', panel.cookie, { origin: origin('xmail') }), 401)
    assert.equal(await f.websocketStatus('xpanel', panel.cookie, { authorization: 'Bearer xp_unsupported_fixture' }), 401)
    assert.equal(await f.websocketStatus('xmail', mail.cookie), 101)
    assert.equal(await f.websocketStatus('xmail', mail.cookie, { origin: origin('xpanel') }), 401)
    assert.equal(await f.websocketStatus('xmail', mail.cookie, { authorization: 'Bearer xp_unsupported_fixture' }), 401)
    assert.equal(await f.websocketStatus('xwhm', `${sessionCookieName('xwhm', true)}=${panel.raw}`), 401)
    await f.database.db.query('DELETE FROM mailbox_sessions WHERE mailbox = $1', [serviceUser.login])
    assert.equal(await f.websocketStatus('xmail', mail.cookie), 401)
    const renewed = await f.login('xmail', serviceUser.login)
    assert.equal(renewed.response.status, 200)
    assert.equal(await f.websocketStatus('xmail', renewed.cookie), 101)
    await f.state.store.updateFeatureList(f.feature.id, { disabled: ['email-accounts'] })
    assert.equal(await f.websocketStatus('xmail', renewed.cookie), 401)
    await f.state.store.updateFeatureList(f.feature.id, { disabled: [] })
    await f.state.store.updateServiceUser(serviceUser.id, { services: { email: false, ftp: true, webdisk: false } })
    assert.equal(await f.websocketStatus('xmail', renewed.cookie), 401)
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

  it('serves the mailbox own filters on the xMail listener through the webmail base only', async () => {
    const mail = await f.login('xmail')
    const request = (profile: EntryPoint, path: string, method = 'GET', body?: unknown, session = mail) => f.request(profile, path, { method, cookie: session.cookie, csrf: session.data.csrfToken, ...(body !== undefined ? { body } : {}) })
    const scope = { scope: 'mailbox', mailbox: f.mailbox.login }
    const listed = await request('xmail', `/api/webmail/filters?scope=mailbox&mailbox=${encodeURIComponent(f.mailbox.login)}`)
    assert.equal(listed.status, 200)
    const view = await listed.json() as { context: { mailbox: string }; filters: unknown[]; revision: string }
    assert.equal(view.context.mailbox, f.mailbox.login)
    assert.deepEqual(view.filters, [])
    const created = await request('xmail', '/api/webmail/filters', 'POST', { ...scope, name: 'Mailbox rule', conditions: [], actions: [{ type: 'keep' }], expectedRevision: view.revision })
    assert.equal(created.status, 201)
    const saved = await new ExtendedFeaturesStore(f.state.rootDir).readOrDefault<Array<{ name: string; scope: string; mailbox: string }>>('mail/filters.json', [])
    assert.deepEqual(saved.map(rule => [rule.name, rule.scope, rule.mailbox]), [['Mailbox rule', 'mailbox', f.mailbox.login]])
    assert.equal((await request('xmail', '/api/webmail/filters', 'POST', { scope: 'global', name: 'Account rule', conditions: [], actions: [{ type: 'keep' }] })).status, 403)
    assert.equal((await request('xmail', '/api/mail/filters')).status, 404)
    const panel = await f.login('xpanel')
    assert.equal((await request('xpanel', '/api/webmail/filters', 'GET', undefined, panel)).status, 404)
  })

  it('confines xPanel account-wide mail filters to the owning account without denied mutations', async () => {
    const other = await f.state.store.createAccount({ ...f.account, username: 'bob', primaryDomain: 'bob.example.test', contactEmail: 'bob@example.test', passwordHash: HASH,
      php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} } })
    const ext = new ExtendedFeaturesStore(f.state.rootDir)
    const rule = (accountId: string | null, name: string) => ({ id: randomUUID(), accountId, name, scope: 'global', mailbox: null, priority: 1, enabled: true, matchAll: true, conditions: [{ field: 'subject', comparator: 'contains', value: name }], actions: [{ type: 'fileinto', target: 'Spam' }], compiledSieve: '', createdAt: new Date().toISOString() })
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
    const allowed = await request('/api/mail/filters', 'POST', { accountId: f.account.id, scope: 'global', name: 'Owned account-wide rule', conditions: [], actions: [{ type: 'keep' }] })
    assert.equal(allowed.status, 201)
  })
})

describe('finite owner personal-auth listener admission', () => {
  it('admits only exact owner methods and rejects aliases, malformed IDs and other listeners', { tags: ['feature'] }, () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const routes: readonly (readonly [string, string])[] = [
      ['GET', '/api/auth/sessions'], ['POST', '/api/auth/sessions/revoke-others'], ['DELETE', '/api/auth/sessions/' + id],
      ['GET', '/api/auth/api-tokens'], ['POST', '/api/auth/api-tokens'], ['PATCH', '/api/auth/api-tokens/' + id],
      ['POST', '/api/auth/api-tokens/' + id + '/revoke'], ['POST', '/api/auth/api-tokens/revoke'],
    ]
    for (const profile of profiles) for (const [method, path] of routes) {
      assert.equal(entryPointAllowsApiRoute(profile, path, method), profile === 'xpanel', profile + ':' + method + ':' + path)
    }
    const deniedRoutes: readonly (readonly [string, string])[] = [
      ['POST', '/api/auth/sessions'], ['GET', '/api/auth/sessions/revoke-others'], ['PUT', '/api/auth/sessions/' + id],
      ['GET', '/api/auth/sessions/' + id], ['DELETE', '/api/auth/sessions/' + '1'.repeat(36)],
      ['DELETE', '/api/auth/sessions/' + id + '/extra'], ['GET', '/api/auth/sessions/'],
      ['DELETE', '/api/auth/api-tokens/' + id], ['GET', '/api/auth/api-tokens/revoke'],
      ['PATCH', '/api/auth/api-tokens/' + id.toUpperCase().replace('1', 'A')],
      ['POST', '/api/auth/api-tokens/' + id + '/revoke/extra'], ['POST', '/api/auth/api-tokens/'],
      ['GET', '/api/auth/api-tokens/other'], ['GET', '/api/auth/other/sessions'],
    ]
    for (const [method, path] of deniedRoutes) for (const profile of profiles) assert.equal(entryPointAllowsApiRoute(profile, path, method), false, profile + ':' + method + ':' + path)
  })
})

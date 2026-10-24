import { request as httpRequest } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import { createApiToken, createTestDb, createUserPrincipal, findActiveApiTokenByHash } from '@xpanel/db'
import { atomicWriteJson, createTestStateStore } from '@xpanel/state'
import { sha256Hex, verifyPasswordArgon2id } from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { sessionCookieName } from './entry-points.ts'
import type { MailboxTransport } from './mail/inbox.ts'

const SECRET = 'native-mailbox-rest-synthetic-server-secret-32'
const ORIGIN = 'https://mail.example.test:2096'
const PASSWORD = 'correct horse battery staple'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Mail boundary', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Mail boundary', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 3, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = await state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const owner = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  const createMailbox = (local: string) => state.store.createServiceUser({ accountId: account.id, login: `${local}@alpha.example.test`, services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: `{ARGON2ID}${HASH}` })
  const own = await createMailbox('inbox'), sibling = await createMailbox('support')
  const transport: MailboxTransport = {
    async verify(login, password) {
      const service = await state.store.getServiceUserByLogin(login)
      const stored = service ? await state.store.getServiceUserHash(service.id) : null
      const hash = stored?.startsWith('{ARGON2ID}') ? stored.slice('{ARGON2ID}'.length) : stored
      if (!service?.services.email || !hash || !await verifyPasswordArgon2id(password, hash)) fail('UNAUTHENTICATED', 'invalid mailbox credentials')
    },
    async list() { return [] }, async read() { return fail('NOT_FOUND', 'message not found') }, async remove() {}, async send() { return { messageId: '<synthetic@example.test>' } },
  }
  const app = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, requireOriginHeader: true, mailboxTransport: transport })
  const listener = await listenApiServer(app)
  cleanup.push(async () => { listener.server.closeAllConnections(); await listener.close() })
  const call = (path: string, method = 'GET', body?: unknown, session?: { cookie: string; csrf: string }, extra: Record<string, string> = {}): Promise<Response> => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: listener.port, path, method, headers: { host: new URL(ORIGIN).host, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), ...extra } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode!, headers: { 'set-cookie': response.headers['set-cookie']?.join(', ') ?? '' } })))
    })
    request.once('error', reject)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const login = async () => {
    const response = await call('/api/auth/login', 'POST', { username: own.login, password: PASSWORD })
    expect(response.status).toBe(200)
    const body = await response.json() as { csrfToken: string; mailbox: string; principal: { username: string } }
    expect(body.mailbox).toBe(own.login)
    expect(body.principal.username).toMatch(/^mbx[0-9a-f]{28}$/)
    return { cookie: (response.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrfToken }
  }
  const base = { folder: 'INBOX', from: 'sender@example.test', to: [own.login], cc: [], bcc: [], subject: 'marker', htmlBody: '', attachments: [], identityId: null, read: false, starred: false, sentAt: new Date().toISOString() }
  const calendarId = randomUUID(), identityId = randomUUID()
  const seeds = {
    'webmail/messages.json': [{ ...base, id: randomUUID(), mailbox: own.login, textBody: 'OWN_MAILBOX_MARKER' }, { ...base, id: randomUUID(), mailbox: sibling.login, textBody: 'SIBLING_MAILBOX_MARKER' }],
    'webmail/identities.json': [{ id: identityId, mailbox: sibling.login, email: sibling.login, displayName: 'Sibling', replyTo: sibling.login, textSignature: '', htmlSignature: '', isDefault: false }],
    'webmail/calendars.json': [{ id: calendarId, owner: sibling.login, name: 'Sibling calendar', color: '#123456', timezone: 'UTC', shares: [], events: [], createdAt: new Date().toISOString() }],
    'mail/filters.json': [],
  }
  for (const [path, data] of Object.entries(seeds)) await atomicWriteJson(join(state.rootDir, 'extended', path), data)
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.keys(seeds).map(async path => [path, await readFile(join(state.rootDir, 'extended', path), 'utf8')])))
  const legacy = createApiApp({ db: database.db, store: state.store, serverSecret: SECRET })
  const token = async (scopes: string[]) => { const raw = randomBytes(32).toString('hex'); await createApiToken(database.db, { principalId: owner.id, name: 'Synthetic boundary token', tokenHash: sha256Hex(raw), scopes, expiresAt: new Date(Date.now() + 60_000).toISOString() }); return raw }
  const tokenCall = (raw: string, path: string) => legacy.fetch(new Request('http://panel.example.test' + path, { headers: { authorization: 'Bearer ' + raw } }))
  return { database, state, features, own, sibling, owner, legacy, calendarId, identityId, call, login, snapshot, token, tokenCall }
}

describe('native interactive mailbox REST authority', () => {
  it('does not let a persisted owner bearer mailbox scope impersonate a sealed mailbox WebSocket session', async () => {
    const f = await fixture()
    const scopes = ['events:read', `mailbox:${f.own.id}`]
    const raw = await f.token(scopes)
    const persisted = await findActiveApiTokenByHash(f.database.db, sha256Hex(raw))
    expect(persisted?.principalId).toBe(f.owner.id)
    expect(persisted?.scopes).toEqual(scopes)
    const before = await f.snapshot()
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET, allowedOrigins: [ORIGIN] })
    const upgrade = (token: string) => ({ headers: { host: new URL(ORIGIN).host, authorization: `Bearer ${token}`, origin: ORIGIN }, url: '/api/ws', socket: { remoteAddress: '192.0.2.5' } }) as IncomingMessage
    // The same persisted owner and ingress accept an ordinary events token. The
    // scoped token must additionally prove its sealed mailbox session identity.
    expect(await app.authenticateUpgrade(upgrade(await f.token(['events:read'])))).toMatchObject({ kind: 'user', id: f.owner.id })
    expect(await app.authenticateUpgrade(upgrade(raw))).toBeNull()
    expect(await f.snapshot()).toEqual(before)
  })
  it('binds actual address login to one mailbox instead of account-owner authority', async () => {
    const f = await fixture(), session = await f.login()
    const own = await f.call('/api/webmail/search?q=MARKER&mailbox=' + encodeURIComponent(f.own.login), 'GET', undefined, session)
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('OWN_MAILBOX_MARKER')
    const before = await f.snapshot()
    for (const path of ['/api/webmail/search?q=MARKER&mailbox=', '/api/webmail/messages?mailbox=', '/api/webmail/identities?mailbox=', '/api/webmail/calendars?mailbox=']) {
      const response = await f.call(path + encodeURIComponent(f.sibling.login), 'GET', undefined, session)
      expect.soft(response.status).toBe(404)
      expect.soft(await response.text()).not.toContain('SIBLING_MAILBOX_MARKER')
    }
    expect(await f.snapshot()).toEqual(before)
  })

  it('rejects sibling identity/calendar bodies and preserves Sieve profile confinement without mutations', async () => {
    const f = await fixture(), session = await f.login(), before = await f.snapshot()
    const identity = await f.call('/api/webmail/identities', 'POST', { mailbox: f.sibling.login, email: f.sibling.login, displayName: 'Unauthorized replacement' }, session)
    expect.soft(identity.status).toBe(404)
    const calendar = await f.call(`/api/webmail/calendars/${f.calendarId}/share`, 'POST', { principal: f.own.login, permission: 'read-write', mailbox: f.sibling.login }, session)
    expect.soft(calendar.status).toBe(404)
    expect.soft((await f.call('/api/mail/filters', 'POST', { mailbox: f.sibling.login, scope: 'mailbox', name: 'Unauthorized filter', conditions: [], action: { type: 'keep' } }, session)).status).toBe(404)
    expect(await f.snapshot()).toEqual(before)
  })

  it('fails closed for missing sealed session and revoked service/plan while retaining recovery routes', async () => {
    const f = await fixture()
    let session = await f.login()
    await f.database.db.query('DELETE FROM mailbox_sessions WHERE mailbox = $1', [f.own.login])
    expect.soft((await f.call('/api/webmail/search?mailbox=' + encodeURIComponent(f.own.login), 'GET', undefined, session)).status).toBe(401)
    expect((await f.call('/api/auth/me', 'GET', undefined, session)).status).toBe(200)
    session = await f.login()
    await f.state.store.updateFeatureList(f.features.id, { disabled: ['email-accounts'] })
    expect((await f.call('/api/webmail/search?mailbox=' + encodeURIComponent(f.own.login), 'GET', undefined, session)).status).toBe(403)
    expect((await f.call('/api/auth/me', 'GET', undefined, session)).status).toBe(200)
    await f.state.store.updateFeatureList(f.features.id, { disabled: [] })
    await f.state.store.updateServiceUser(f.own.id, { services: { email: false, ftp: true, webdisk: false } })
    expect.soft((await f.call('/api/webmail/search?mailbox=' + encodeURIComponent(f.sibling.login), 'GET', undefined, session)).status).toBe(403)
    expect((await f.call('/api/auth/logout', 'POST', {}, session)).status).toBe(200)
  })

  it('preserves account-owner and explicitly scoped token contracts plus interactive origin/CSRF/audience guards', async () => {
    const f = await fixture(), session = await f.login()
    const owner = await f.token(['webmail:read'])
    expect((await f.tokenCall(owner, '/api/webmail/identities?mailbox=' + encodeURIComponent(f.sibling.login))).status).toBe(200)
    const scoped = await f.token([`mailbox:${f.own.id}`, 'webmail:read'])
    expect((await f.tokenCall(scoped, '/api/webmail/identities?mailbox=' + encodeURIComponent(f.own.login))).status).toBe(200)
    expect((await f.tokenCall(scoped, '/api/webmail/identities?mailbox=' + encodeURIComponent(f.sibling.login))).status).toBe(404)
    const before = await f.snapshot()
    const body = { mailbox: f.own.login, email: f.own.login, displayName: 'Rejected request' }
    expect((await f.call('/api/webmail/identities', 'POST', body, session, { origin: 'https://another.example.test' })).status).toBe(403)
    expect((await f.call('/api/webmail/identities', 'POST', body, session, { 'x-csrf-token': 'invalid' })).status).toBe(403)
    expect((await f.call('/api/webmail/identities', 'GET', undefined, session, { authorization: 'Bearer ' + owner })).status).toBe(401)
    const raw = session.cookie.slice(session.cookie.indexOf('=') + 1)
    expect((await f.call('/api/webmail/identities', 'GET', undefined, { ...session, cookie: sessionCookieName('xpanel', true) + '=' + raw })).status).toBe(401)
    expect(await f.snapshot()).toEqual(before)
  })
})

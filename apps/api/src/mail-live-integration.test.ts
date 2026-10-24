import { createPublicKey, randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { FakeHostExecutor, HostReconciler, createAgentApp } from '@xpanel/agent'
import { createApiToken, createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { ensureOpenDkimSigning, readOpenDkimPublicMaterial } from '../../agent/src/services/opendkim-live.ts'
import { sha256Hex } from './auth.ts'
import { establishMailboxSession } from './mail/inbox.ts'
import type { MailboxTransport } from './mail/inbox.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { sessionCookieName } from './entry-points.ts'
import { LiveEventHub } from './ws.ts'

const SECRET = 'synthetic-live-mail-integration-secret-32'
const TOKEN = 'c'.repeat(64)
const ORIGIN = 'https://mail.example.test'
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const until = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2500
  while (!predicate()) { if (Date.now() > deadline) throw new Error('local mail fixture did not reach the expected state'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

const imapFixture = async () => {
  const sockets = new Set<Socket>()
  let connections = 0
  let idles = 0
  const server = createServer(socket => {
    connections++
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    socket.write('* OK synthetic mailbox fixture\r\n')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1)
        const [tag, command] = line.split(' ')
        if (command === 'LOGIN') socket.write(`${tag} OK logged in\r\n`)
        else if (command === 'SELECT') socket.write(`* 1 EXISTS\r\n${tag} OK selected\r\n`)
        else if (command === 'IDLE') { idles++; socket.write('+ idling\r\n') }
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing local IMAP fixture address')
  return { port: address.port, sockets, get connections() { return connections }, get idles() { return idles } }
}

const fixture = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(() => database.close(), () => state.close())
  const features = await state.store.createFeatureList({ name: 'Live mail fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Live mail fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1024, bandwidthMbMonth: 'unlimited', ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 512, maxProcesses: 32, cpuPercent: 100 },
    caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 3, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} }
  const account = await state.store.createAccount({ username: 'alpha', primaryDomain: 'alpha.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@alpha.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const other = await state.store.createAccount({ username: 'beta', primaryDomain: 'beta.example.test', passwordHash: HASH, planId: plan.id, ownerId: null, contactEmail: 'owner@beta.example.test', ipv4: '192.0.2.10', shell: 'none', php })
  const mailbox = await state.store.createServiceUser({ accountId: account.id, login: 'a@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  const second = await state.store.createServiceUser({ accountId: account.id, login: 'b@alpha.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 100, ftpDir: 'public_html', passwordHash: HASH })
  const transport: MailboxTransport = { async verify() {}, async list() { return [] }, async read() { throw new Error('unused') }, async remove() {}, async send() { return { messageId: '<synthetic@example.test>' } } }
  const established = await establishMailboxSession({ db: database.db, store: state.store, serverSecret: SECRET, transport, entryPoint: 'xmail', mailbox: mailbox.login, password: 'synthetic-mailbox-password', ip: '127.0.0.1', userAgent: 'local-fixture' })
  return { database, state, features, account, other, mailbox, second, transport, established }
}

const connected = async () => {
  const f = await fixture()
  const imap = await imapFixture()
  const environment = { XPANEL_IMAP_HOST: '127.0.0.1', XPANEL_IMAP_PORT: String(imap.port), XPANEL_IMAP_TIMEOUT_MS: '250' }
  const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET, entryPoint: 'xmail', publicOrigin: ORIGIN, allowedOrigins: [ORIGIN], secureCookies: true, mailboxTransport: f.transport, mailboxEnvironment: environment, hub: new LiveEventHub({ heartbeatIntervalMs: 30, pongTimeoutMs: 500 }) })
  const listener = await listenApiServer(app)
  cleanup.push(() => listener.close())
  const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/api/ws`, { headers: { host: 'mail.example.test', Origin: ORIGIN, Cookie: `${sessionCookieName('xmail', true)}=${f.established.rawToken}` } })
  cleanup.push(() => ws.terminate())
  const events: Array<{ kind: string; scope?: { mailboxLogin?: string } }> = []
  ws.on('message', data => events.push(JSON.parse(data.toString())))
  await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  await until(() => imap.idles === 1)
  return { ...f, imap, environment, app, ws, events }
}

describe('mail live API integration on disposable loopback listeners', () => {
  it('uses one watch through reauthorization, immutable startup configuration and reconnect', async () => {
    const f = await connected()
    await until(() => f.events.some(event => event.kind === 'mail.changed'))
    const count = f.events.length
    for (const socket of f.imap.sockets) socket.write('* 2 EXISTS\r\n')
    await until(() => f.events.length > count)
    expect(f.events.every(event => event.scope?.mailboxLogin === f.mailbox.login)).toBe(true)
    f.environment.XPANEL_IMAP_PORT = '1'
    for (const socket of f.imap.sockets) socket.destroy()
    await until(() => f.imap.idles === 2)
    expect(f.imap.connections).toBe(2)
    f.ws.close()
    await until(() => f.ws.readyState === WebSocket.CLOSED && f.imap.sockets.size === 0)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(f.imap.connections).toBe(2)
  })

  it.each(['service', 'feature', 'expiry', 'identity'])('aborts the watch after %s authority changes without reconnecting', async kind => {
    const f = await connected()
    if (kind === 'service') await f.state.store.updateServiceUser(f.mailbox.id, { services: { email: false, ftp: true, webdisk: false } })
    if (kind === 'feature') await f.state.store.updateFeatureList(f.features.id, { disabled: ['email-accounts'] })
    if (kind === 'expiry') await f.database.db.query('UPDATE sessions SET created_at = $1, expires_at = $2 WHERE id = $3', ['2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', f.established.session.id])
    if (kind === 'identity') await f.database.db.query('UPDATE mailbox_sessions SET mailbox = $1, service_user_id = $2 WHERE session_id = $3', [f.second.login, f.second.id, f.established.session.id])
    await until(() => f.ws.readyState === WebSocket.CLOSED && f.imap.sockets.size === 0)
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(f.imap.connections).toBe(1)
    expect(f.app.hub.clientCount).toBe(0)
  })

  it('passes real public material through API and agent and refuses missing or foreign keys', async () => {
    const f = await fixture()
    const executor = new FakeHostExecutor()
    const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
    await ensureOpenDkimSigning(executor, [f.account.primaryDomain])
    const material = await readOpenDkimPublicMaterial(executor, f.account.primaryDomain)
    const root = await createRootPrincipal(f.database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
    const tenant = await createUserPrincipal(f.database.db, { username: f.account.username, accountId: f.account.id, passwordHash: HASH })
    const bearer = async (principalId: string) => { const raw = randomBytes(32).toString('hex'); await createApiToken(f.database.db, { principalId, name: 'Synthetic local token', tokenHash: sha256Hex(raw), scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() }); return raw }
    const rootToken = await bearer(root.id)
    const tenantToken = await bearer(tenant.id)
    const agent = createAgentApp({ db: f.database.db, store: f.state.store, executor, os: { id: os.id, versionId: os.versionId, family: os.family }, agentToken: TOKEN, reconciler: new HostReconciler({ db: f.database.db, store: f.state.store, executor, os }) })
    const app = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET, agentApp: agent, agentToken: TOKEN })
    const post = (token: string, domain: string, target = app) => target.fetch(new Request('http://panel.example.test/api/dns/email-auth/batch', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ domains: [domain] }) }))
    const accepted = await post(rootToken, f.account.primaryDomain)
    expect(accepted.status).toBe(200)
    const body = await accepted.json() as { provisioned: Array<{ dkim: string }> }
    const encoded = /\bp=([^;\s]+)/.exec(body.provisioned[0]!.dkim)?.[1]
    expect(createPublicKey({ key: Buffer.from(encoded ?? '', 'base64'), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString()).toBe(material?.publicKeyPem)
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY')
    const missingBefore = await f.state.store.getDnsZone(f.other.primaryDomain)
    expect((await post(rootToken, f.other.primaryDomain)).status).toBe(412)
    expect(await f.state.store.getDnsZone(f.other.primaryDomain)).toEqual(missingBefore)
    expect([403, 404]).toContain((await post(tenantToken, f.other.primaryDomain)).status)
    const disconnected = createApiApp({ db: f.database.db, store: f.state.store, serverSecret: SECRET })
    expect((await post(rootToken, f.account.primaryDomain, disconnected)).status).toBe(412)
  })
})

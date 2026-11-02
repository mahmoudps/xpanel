import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { LiveEvent } from '@xpanel/core'
import {
  createApiToken, createResellerPrincipal, createRootPrincipal, createSession, createTestDb,
  createUserPrincipal, findActiveApiTokenByHash, listAudit, revokeApiToken, setPasswordHash,
  setPrincipalDisabled, setTotpSecret,
} from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import {
  computeTotpCode, deriveCsrfToken, generateTotpSecret, hashPasswordArgon2id,
  HOST_SESSION_COOKIE_NAME, sealTotpSecret, SESSION_COOKIE_NAME, sha256Hex,
} from './auth.ts'
import { createApiApp, listenApiServer } from './server.ts'
import { LiveEventHub, type EventSubscriber } from './ws.ts'

const ROOT: EventSubscriber = { kind: 'root', username: 'root' }
const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const eventually = async (predicate: () => boolean, timeoutMs = 1500): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('network condition was not observed before the deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

interface WireClient {
  socket: Socket
  bytes: Buffer
  status: number | null
  closed: boolean
}

/** Sends real wire bytes independently of the server's WebSocket implementation. */
const openWire = async (
  port: number,
  headers: Record<string, string> = {},
  path = '/api/ws',
  timeoutMs: number | null = 1500,
): Promise<WireClient> => {
  const socket = connect(port, '127.0.0.1')
  const client: WireClient = { socket, bytes: Buffer.alloc(0), status: null, closed: false }
  cleanup.push(() => { socket.destroy() })
  socket.on('data', (chunk: Buffer) => {
    client.bytes = Buffer.concat([client.bytes, chunk])
    const match = /^HTTP\/1\.1 (\d{3})/.exec(client.bytes.toString('latin1'))
    if (match) client.status = Number(match[1])
  })
  socket.on('error', () => { client.closed = true })
  socket.on('close', () => { client.closed = true })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const requestHeaders = {
    Host: 'panel.xpanel.test',
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
    ...headers,
  }
  socket.write([
    `GET ${path} HTTP/1.1`,
    ...Object.entries(requestHeaders).map(([key, value]) => `${key}: ${value}`),
    '\r\n',
  ].join('\r\n'))
  if (timeoutMs !== null) await eventually(() => client.status !== null || client.closed, timeoutMs)
  return client
}

const serve = async (
  hub: LiveEventHub,
  authenticate: () => Promise<EventSubscriber | null>,
  onConnected?: Parameters<LiveEventHub['attachToServer']>[2],
): Promise<number> => {
  const server: Server = createServer()
  const connections = new Set<Socket>()
  server.on('connection', (socket) => {
    connections.add(socket)
    socket.once('close', () => connections.delete(socket))
  })
  hub.attachToServer(server, authenticate, onConnected)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => {
    for (const socket of connections) socket.destroy()
    return new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

const event = (id: string, accountId: string | null = null): LiveEvent => ({
  id,
  at: new Date().toISOString(),
  kind: 'security.ban',
  scope: { accountId },
  data: { ip: '198.51.100.1', reason: id, expiresAt: new Date(Date.now() + 60_000).toISOString() },
})

describe('WebSocket live authorization and transport security', () => {
  it('aborts a mailbox watch after current authorization expires', async () => {
    let authorized = true
    let watchSignal: AbortSignal | undefined
    const hub = new LiveEventHub({ heartbeatIntervalMs: 20, pongTimeoutMs: 500 })
    const mailbox: EventSubscriber = { kind: 'user', id: 'mailbox-user', accountId: 'account-a', mailboxLogin: 'alice@example.test' }
    const port = await serve(hub, async () => authorized ? mailbox : null, (_request, _subscriber, signal) => { watchSignal = signal })
    const client = await openWire(port)
    assert.equal(client.status, 101)
    assert.equal(watchSignal?.aborted, false)
    authorized = false
    await eventually(() => client.closed)
    assert.equal(watchSignal?.aborted, true)
    assert.equal(hub.clientCount, 0)
  })

  it('closes the old mailbox watch when a same-account mailbox binding changes', async () => {
    let login = 'alice@example.test'
    let watchSignal: AbortSignal | undefined
    const hub = new LiveEventHub()
    const port = await serve(hub, async () => ({ kind: 'user', id: 'mailbox-user', accountId: 'account-a', mailboxLogin: login }), (_request, _subscriber, signal) => { watchSignal = signal })
    const client = await openWire(port)
    login = 'bob@example.test'
    hub.broadcast({ id: 'old-mailbox-private', at: new Date().toISOString(), kind: 'mail.changed', scope: { accountId: 'account-a', mailboxLogin: 'alice@example.test' }, data: { folder: 'INBOX' } })
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('old-mailbox-private')), false)
    assert.equal(watchSignal?.aborted, true)
  })

  it('rechecks authorization before sending an event after a connection has been revoked', async () => {
    let authorized = true
    const hub = new LiveEventHub()
    const port = await serve(hub, async () => authorized ? ROOT : null)
    const client = await openWire(port)
    assert.equal(client.status, 101)
    hub.broadcast(event('before-revocation'))
    await eventually(() => client.bytes.includes(Buffer.from('before-revocation')))
    authorized = false
    hub.broadcast(event('after-revocation-private-marker'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('after-revocation-private-marker')), false)
    assert.equal(hub.clientCount, 0)
  })

  it('rejects an invalid WebSocket version before upgrading', async () => {
    const port = await serve(new LiveEventHub(), async () => ROOT)
    const client = await openWire(port, { 'Sec-WebSocket-Version': '12' })
    assert.notEqual(client.status, 101)
    assert.equal((await openWire(port, { 'Sec-WebSocket-Version': '8' })).status, 426)
  })

  it('rejects a declared oversized frame without waiting for its payload', async () => {
    const port = await serve(new LiveEventHub(), async () => ROOT)
    const client = await openWire(port)
    assert.equal(client.status, 101)
    // Masked text frame declares 1 MiB but deliberately supplies no payload.
    const frame = Buffer.alloc(14)
    frame[0] = 0x81
    frame[1] = 0xff
    frame.writeBigUInt64BE(1024n * 1024n, 2)
    client.socket.write(frame)
    await eventually(() => client.closed)
  })

  it('rejects missing authorization and unknown endpoints', async () => {
    const port = await serve(new LiveEventHub(), async () => null)
    assert.equal((await openWire(port)).status, 401)
    assert.equal((await openWire(port, {}, '/api/other')).status, 404)
  })

  it('rejects a noncanonical handshake key', async () => {
    const port = await serve(new LiveEventHub(), async () => ROOT)
    assert.equal((await openWire(port, { 'Sec-WebSocket-Key': 'bad-key' })).status, 400)
  })

  it('rejects unmasked client control frames', async () => {
    const port = await serve(new LiveEventHub(), async () => ROOT)
    const client = await openWire(port)
    client.socket.write(Buffer.from([0x89, 0x00]))
    await eventually(() => client.closed)
  })

  it('handles a valid masked ping split across TCP writes', async () => {
    const port = await serve(new LiveEventHub(), async () => ROOT)
    const client = await openWire(port)
    const payload = Buffer.from('split-ping-marker')
    const mask = Buffer.from([0x12, 0x34, 0x56, 0x78])
    const encoded = Buffer.concat([
      Buffer.from([0x89, 0x80 | payload.length]), mask,
      Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!)),
    ])
    client.socket.write(encoded.subarray(0, 3))
    client.socket.write(encoded.subarray(3))
    await eventually(() => client.bytes.includes(payload))
    assert.equal(client.closed, false)
  })

  it('bounds an outbound queue while authorization is waiting', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const hub = new LiveEventHub()
    const port = await serve(hub, async () => {
      if (++calls === 1) return ROOT
      return new Promise((resolve) => { release = () => resolve(ROOT) })
    })
    const client = await openWire(port)
    cleanup.push(() => release?.())
    for (let i = 0; i < 40; i++) hub.broadcast(event(`queued-private-marker-${i}`))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('queued-private-marker')), false)
    assert.equal(hub.clientCount, 0)
  })

  it('applies current ownership before sending a formerly visible account event', async () => {
    const owned = new Set(['account-a'])
    const subscriber: EventSubscriber = { kind: 'reseller', id: 'reseller-a', ownedAccountIds: owned }
    const hub = new LiveEventHub()
    const port = await serve(hub, async () => subscriber)
    const client = await openWire(port)
    hub.broadcast(event('owned-before-transfer', 'account-a'))
    await eventually(() => client.bytes.includes(Buffer.from('owned-before-transfer')))
    owned.clear()
    hub.broadcast(event('private-after-transfer', 'account-a'))
    const barrier = event('ownership-check-complete')
    barrier.scope.resellerId = 'reseller-a'
    hub.broadcast(barrier)
    await eventually(() => client.bytes.includes(Buffer.from('ownership-check-complete')))
    assert.equal(client.bytes.includes(Buffer.from('private-after-transfer')), false)
  })

  it('reauthorizes replay rather than trusting the handshake grant', async () => {
    let calls = 0
    const hub = new LiveEventHub()
    hub.broadcast(event('private-history-marker'))
    const port = await serve(hub, async () => ++calls === 1 ? ROOT : null)
    const client = await openWire(port, {}, '/api/ws?replay=1')
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('private-history-marker')), false)
  })

  it('closes a silent client after its heartbeat deadline', async () => {
    const hub = new LiveEventHub({ heartbeatIntervalMs: 20, pongTimeoutMs: 20 })
    const port = await serve(hub, async () => ROOT)
    const client = await openWire(port)
    await eventually(() => client.closed)
    assert.equal(hub.clientCount, 0)
  })

  it('keeps an authenticated client alive when it answers heartbeats', async () => {
    let authorizations = 0
    const hub = new LiveEventHub({ heartbeatIntervalMs: 20, pongTimeoutMs: 500 })
    const port = await serve(hub, async () => { authorizations++; return ROOT })
    const client = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { perMessageDeflate: false })
    cleanup.push(() => client.terminate())
    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    await eventually(() => authorizations >= 4)
    assert.equal(client.readyState, WebSocket.OPEN)
    assert.equal(hub.clientCount, 1)
  })

  it('revalidates an inactive connection even when there are no events', async () => {
    let authorized = true
    const hub = new LiveEventHub({ heartbeatIntervalMs: 20, pongTimeoutMs: 20 })
    const port = await serve(hub, async () => authorized ? ROOT : null)
    const client = await openWire(port)
    authorized = false
    await eventually(() => client.closed)
    assert.equal(hub.clientCount, 0)
  })

  it('releases pending upgrade capacity after authorization hangs beyond its deadline', { tags: ['feature'] }, async () => {
    // TCP and authorization remain real; only the JavaScript deadline clock is controlled.
    const observeWire = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 1500
      while (!predicate()) {
        if (Date.now() >= deadline) assert.fail('wire state did not settle before its real deadline')
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let authorize = false
      let waiting = 0
      const port = await serve(new LiveEventHub(), async () => {
        if (authorize) return ROOT
        waiting++
        return new Promise<EventSubscriber | null>(() => {})
      })
      const pending = await Promise.all(Array.from({ length: 32 }, () => openWire(port, {}, '/api/ws', null)))
      await observeWire(() => waiting === 32)
      const refused = await openWire(port, {}, '/api/ws', null)
      await observeWire(() => refused.status !== null || refused.closed)
      assert.equal(refused.status, 503)

      await vi.advanceTimersByTimeAsync(9999)
      assert.equal(pending.every((client) => !client.closed && client.status === null), true)
      await vi.advanceTimersByTimeAsync(1)
      await observeWire(() => pending.every((client) => client.closed))
      assert.equal(pending.every((client) => client.status !== 101), true)

      authorize = true
      let recovered: WireClient | undefined
      const recoveryDeadline = Date.now() + 1500
      do {
        recovered = await openWire(port, {}, '/api/ws', null)
        await observeWire(() => recovered!.status !== null || recovered!.closed)
        if (recovered.status === 101) break
        await new Promise<void>((resolve) => setImmediate(resolve))
      } while (Date.now() < recoveryDeadline)
      assert.equal(recovered.status, 101)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('event hub scope and retained history', () => {
  it('delivers and replays mailbox invalidations only to root and the bound mailbox', () => {
    const hub = new LiveEventHub()
    const subscribers: EventSubscriber[] = [ROOT, { kind: 'reseller', id: 'reseller-a', ownedAccountIds: ['account-a'] }, { kind: 'user', accountId: 'account-a' }, { kind: 'user', accountId: 'account-a', mailboxLogin: 'alice@example.test' }, { kind: 'user', accountId: 'account-a', mailboxLogin: 'bob@example.test' }, { kind: 'user', accountId: 'account-b', mailboxLogin: 'alice@example.test' }]
    const deliveries = subscribers.map(() => [] as string[])
    subscribers.forEach((subscriber, index) => hub.registerClient(subscriber, event => deliveries[index]!.push(event.id)))
    const changed: LiveEvent = { id: 'mailbox-changed', at: new Date().toISOString(), kind: 'mail.changed', scope: { accountId: 'account-a', mailboxLogin: 'alice@example.test' }, data: { folder: 'INBOX' } }
    hub.broadcast(changed)
    assert.deepEqual(deliveries, [['mailbox-changed'], [], [], ['mailbox-changed'], [], []])
    assert.deepEqual(subscribers.map(subscriber => hub.recentEventsFor(subscriber).length), [1, 0, 0, 1, 0, 0])
    const malformed: LiveEvent = { ...changed, kind: 'mail.flags', data: { mailbox: 'alice@example.test', folder: 'INBOX', uid: 0, flags: ['\\Seen'] } }
    assert.equal(hub.broadcast(malformed), 0)
    assert.deepEqual(hub.recentEventsFor(ROOT).map(event => event.id), ['mailbox-changed'])
  })

  it('keeps root, reseller, account and mailbox deliveries in their authorized scope', () => {
    const hub = new LiveEventHub()
    const received: string[][] = [[], [], [], []]
    const subscribers: EventSubscriber[] = [
      ROOT,
      { kind: 'reseller', id: 'reseller-a', ownedAccountIds: new Set(['account-a']) },
      { kind: 'user', accountId: 'account-a' },
      { kind: 'service', login: 'alice@example.test' },
    ]
    subscribers.forEach((subscriber, index) => hub.registerClient(subscriber, (item) => {
      received[index]!.push(item.id)
    }))
    const mailboxEvent = event('mailbox-a')
    mailboxEvent.scope.mailboxLogin = 'alice@example.test'
    const items = [event('root'), event('account-a', 'account-a'), event('account-b', 'account-b'), mailboxEvent]
    for (const item of items) hub.broadcast(item)
    assert.deepEqual(received, [['root', 'account-a', 'account-b', 'mailbox-a'], ['account-a'], ['account-a'], ['mailbox-a']])
    assert.deepEqual(hub.recentEventsFor(subscribers[3]!).map((item) => item.id), ['mailbox-a'])
    assert.deepEqual(hub.recentEventsFor(ROOT, 0), [])
  })

  it('limits retained history by count and bytes', () => {
    const hub = new LiveEventHub()
    for (let i = 0; i < 110; i++) hub.broadcast(event(`small-${i}`))
    assert.equal(hub.recentEventsFor(ROOT).length, 100)
    assert.equal(hub.recentEventsFor(ROOT)[0]!.id, 'small-10')
    for (let i = 0; i < 100; i++) hub.broadcast(event(`large-${i}-${'x'.repeat(20_000)}`))
    const retained = hub.recentEventsFor(ROOT)
    assert.ok(retained.length < 100)
    assert.ok(retained.reduce((bytes, item) => bytes + Buffer.byteLength(JSON.stringify(item)), 0) <= 1024 * 1024)
  })
})

const SERVER_SECRET = 'network-security-test-fixture-secret-32-bytes-minimum'
const ALLOWED_ORIGIN = 'https://panel.xpanel.test'
let fixturePasswordHash: string

beforeAll(async () => {
  fixturePasswordHash = await hashPasswordArgon2id(randomBytes(32).toString('hex'))
})

/** Real SQLite identities/tokens and a real HTTP listener; no fake host operation is involved. */
const authenticatedServer = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(async () => { await database.close(); await state.close() })
  const principal = await createRootPrincipal(database.db, {
    username: 'root', passwordHash: fixturePasswordHash, forcePasswordChange: false,
  })
  await setTotpSecret(database.db, principal.id, sealTotpSecret(generateTotpSecret(), SERVER_SECRET))
  const app = createApiApp({
    db: database.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ALLOWED_ORIGIN],
  })
  const listener = await listenApiServer(app)
  const sockets = new Set<Socket>()
  listener.server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy()
    await listener.close()
  })
  const token = async (scopes = ['events:read'], allowedIps = ['127.0.0.1/32']) => {
    const raw = `xp_${randomBytes(32).toString('hex')}`
    const record = await createApiToken(database.db, {
      principalId: principal.id, name: 'network-security-test', tokenHash: sha256Hex(raw),
      scopes, allowedIps, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    return { record, headers: { Authorization: `Bearer ${raw}`, Origin: ALLOWED_ORIGIN } }
  }
  return { database, principal, app, port: listener.port, token }
}

const proxyConstructor = async () => {
  const database = await createTestDb()
  const state = await createTestStateStore()
  cleanup.push(async () => { await database.close(); await state.close() })
  return (trustedProxyAddresses: readonly string[]) => createApiApp({
    db: database.db, store: state.store, serverSecret: SERVER_SECRET, trustedProxyAddresses,
  })
}

describe('trusted proxy configuration boundary', () => {
  it('rejects IPv4 and IPv6 loopback addresses as trusted TCP proxies', async () => {
    const construct = await proxyConstructor()
    for (const address of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '0:0:0:0:0:0:0:1']) {
      assert.throws(() => construct([address]), { code: 'PRECONDITION_FAILED' })
    }
  })

  it('rejects dotted, hexadecimal and expanded IPv4-mapped loopback forms', async () => {
    const construct = await proxyConstructor()
    for (const address of ['::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
      assert.throws(() => construct([address]), { code: 'PRECONDITION_FAILED' })
    }
  })

  it('rejects actual assigned non-loopback host addresses and their mapped forms', async (context) => {
    const assigned = Object.values(networkInterfaces()).flatMap((interfaces) => interfaces ?? [])
      .filter((entry) => !entry.internal)
    if (assigned.length === 0) context.skip('no assigned non-loopback interface is available for this proof')
    const construct = await proxyConstructor()
    for (const entry of assigned) {
      assert.throws(() => construct([entry.address]), { code: 'PRECONDITION_FAILED' })
      if (entry.family === 'IPv4') {
        const parts = entry.address.split('.').map(Number)
        const hex = `${(parts[0]! * 256 + parts[1]!).toString(16)}:${(parts[2]! * 256 + parts[3]!).toString(16)}`
        for (const mapped of [`::ffff:${entry.address}`, `::ffff:${hex}`, `0:0:0:0:0:ffff:${hex}`]) {
          assert.throws(() => construct([mapped]), { code: 'PRECONDITION_FAILED' })
        }
      }
    }
  })

  it('accepts an explicitly configured external address without claiming live remote-proxy proof', async () => {
    const assigned = new Set(Object.values(networkInterfaces()).flatMap((interfaces) => interfaces ?? []).map((entry) => entry.address))
    const external = ['198.51.100.200', '203.0.113.200', '192.0.2.200'].find((address) => !assigned.has(address))
    assert.ok(external, 'the constructor fixture requires an address not assigned to this host')
    const construct = await proxyConstructor()
    assert.equal(typeof construct([external]).fetch, 'function')
  })
})

describe('WebSocket authentication against real API and SQLite authority', () => {
  it('uses the real peer IP and rejects spoofed forwarded headers for an IP-bound token', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token(['events:read'], ['198.51.100.10/32'])
    const client = await openWire(fixture.port, {
      ...token.headers, 'X-Forwarded-For': '198.51.100.10', 'X-Real-IP': '198.51.100.10',
    })
    assert.equal(client.status, 401)
    const response = await fetch(`http://127.0.0.1:${fixture.port}/api/events/recent`, {
      headers: { ...token.headers, 'X-Forwarded-For': '198.51.100.10', 'X-Real-IP': '198.51.100.10' },
    })
    assert.equal(response.status, 401)
  })

  it('rejects an unauthorized Origin even when the bearer token is valid', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    const client = await openWire(fixture.port, { ...token.headers, Origin: 'https://untrusted.example' })
    assert.equal(client.status, 401)
  })

  it('requires explicit events scope instead of accepting an unrelated root read token', async () => {
    const fixture = await authenticatedServer()
    for (const scopes of [['audit:read'], []]) {
      const token = await fixture.token(scopes)
      assert.equal((await openWire(fixture.port, token.headers)).status, 401)
    }
  })

  it('stops an existing connection after its API token is revoked in SQLite', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    const client = await openWire(fixture.port, token.headers)
    assert.equal(client.status, 101)
    fixture.app.hub.broadcast(event('db-token-before-revocation'))
    await eventually(() => client.bytes.includes(Buffer.from('db-token-before-revocation')))
    await revokeApiToken(fixture.database.db, token.record.id)
    fixture.app.hub.broadcast(event('db-token-after-revocation-private'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('db-token-after-revocation-private')), false)
  })

  it('stops an existing connection after its principal is disabled', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    const client = await openWire(fixture.port, token.headers)
    assert.equal(client.status, 101)
    await setPrincipalDisabled(fixture.database.db, fixture.principal.id, true)
    fixture.app.hub.broadcast(event('disabled-principal-private'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('disabled-principal-private')), false)
  })

  it('rejects a new handshake for a principal required to change its password', async () => {
    const fixture = await authenticatedServer()
    await fixture.database.db.query('UPDATE principals SET force_password_change = 1 WHERE id = $1', [fixture.principal.id])
    const token = await fixture.token()
    assert.ok(await findActiveApiTokenByHash(fixture.database.db, token.record.tokenHash))
    assert.equal((await openWire(fixture.port, token.headers)).status, 401)
    assert.equal(fixture.app.hub.clientCount, 0)
  })

  it('reauthorizes an existing connection against a direct persisted force-change flag without token revocation', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    const client = await openWire(fixture.port, token.headers)
    assert.equal(client.status, 101)
    fixture.app.hub.broadcast(event('force-change-before-transition'))
    await eventually(() => client.bytes.includes(Buffer.from('force-change-before-transition')))
    await fixture.database.db.query('UPDATE principals SET force_password_change = 1 WHERE id = $1', [fixture.principal.id])
    // Keep the credential active to isolate fresh policy reads from credential revocation.
    assert.ok(await findActiveApiTokenByHash(fixture.database.db, token.record.tokenHash))
    fixture.app.hub.broadcast(event('forced-change-late-private-event'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('forced-change-late-private-event')), false)
    assert.equal(fixture.app.hub.clientCount, 0)
  })

  it('revokes the token and closes an established connection after an administrative password reset', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    const client = await openWire(fixture.port, token.headers)
    assert.equal(client.status, 101)
    fixture.app.hub.broadcast(event('password-reset-before-transition'))
    await eventually(() => client.bytes.includes(Buffer.from('password-reset-before-transition')))
    const replacement = await hashPasswordArgon2id(randomBytes(32).toString('hex'))
    await setPasswordHash(fixture.database.db, fixture.principal.id, replacement, { forceChange: true })
    assert.equal(await findActiveApiTokenByHash(fixture.database.db, token.record.tokenHash), null)
    fixture.app.hub.broadcast(event('password-reset-late-private-event'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('password-reset-late-private-event')), false)
    assert.equal(fixture.app.hub.clientCount, 0)
  })

  it('stops a connection when its session becomes idle without renewing it through passive events', async () => {
    const fixture = await authenticatedServer()
    const raw = randomBytes(32).toString('hex')
    const session = await createSession(fixture.database.db, {
      principalId: fixture.principal.id, tokenHash: sha256Hex(raw), mfaVerified: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const client = await openWire(fixture.port, { Cookie: `xpanel_session=${raw}`, Origin: ALLOWED_ORIGIN })
    assert.equal(client.status, 101)
    const idleAt = new Date(Date.now() - 31 * 60_000).toISOString()
    await fixture.database.db.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [idleAt, session.id])
    fixture.app.hub.broadcast(event('idle-session-private'))
    await eventually(() => client.closed)
    assert.equal(client.bytes.includes(Buffer.from('idle-session-private')), false)
    const rows = await fixture.database.db.query<{ last_seen_at: string }>(
      'SELECT last_seen_at FROM sessions WHERE id = $1', [session.id],
    )
    assert.equal(rows[0]!.last_seen_at, idleAt)
  })

  it('rejects spoofed X-Forwarded-For and X-Forwarded-Proto from IPv4-mapped loopback ::ffff:127.0.0.1 on HTTP and WS', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    cleanup.push(async () => { await database.close(); await state.close() })
    const totpSecret = generateTotpSecret()
    const principal = await createRootPrincipal(database.db, {
      username: 'root', passwordHash: fixturePasswordHash, forcePasswordChange: false,
    })
    await setTotpSecret(database.db, principal.id, sealTotpSecret(totpSecret, SERVER_SECRET))
    const app = createApiApp({
      db: database.db,
      store: state.store,
      serverSecret: SERVER_SECRET,
      allowedOrigins: [ALLOWED_ORIGIN],
      requireSecureCookies: true,
    })
    const raw = `xp_${randomBytes(32).toString('hex')}`
    await createApiToken(database.db, {
      principalId: principal.id,
      name: 'mapped-loopback-test',
      tokenHash: sha256Hex(raw),
      scopes: ['events:read'],
      allowedIps: ['198.51.100.10/32'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })

    for (const mappedPeer of ['::ffff:127.0.0.1', '0:0:0:0:0:ffff:7f00:1']) {
      // HTTP request with spoofed X-Forwarded-For from IPv4-mapped loopback must not satisfy IP allowlist
      const httpRes = await app.fetch(
        new Request('http://panel.xpanel.test/api/events/recent', {
          headers: {
            Authorization: `Bearer ${raw}`,
            'X-Forwarded-For': '198.51.100.10',
            'X-Real-IP': '198.51.100.10',
            'X-Forwarded-Proto': 'https',
          },
        }),
        { remoteAddress: mappedPeer },
      )
      assert.equal(httpRes.status, 401)

      // WS upgrade with spoofed X-Forwarded-For from IPv4-mapped loopback must be rejected
      const fakeUpgrade = {
        url: '/api/ws',
        headers: {
          authorization: `Bearer ${raw}`,
          origin: ALLOWED_ORIGIN,
          'x-forwarded-for': '198.51.100.10',
          'x-real-ip': '198.51.100.10',
          'x-forwarded-proto': 'https',
        },
        socket: { remoteAddress: mappedPeer },
      } as unknown as Parameters<typeof app.authenticateUpgrade>[0]
      assert.equal(await app.authenticateUpgrade(fakeUpgrade), null)

      // Spoofed X-Forwarded-Proto: https from IPv4-mapped loopback must not satisfy requireSecureCookies
      const rawSession = randomBytes(32).toString('hex')
      await createSession(database.db, {
        principalId: principal.id,
        tokenHash: sha256Hex(rawSession),
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      })
      const meRes = await app.fetch(
        new Request('http://panel.xpanel.test/api/auth/me', {
          headers: {
            Cookie: `${HOST_SESSION_COOKIE_NAME}=${rawSession}`,
            'X-Forwarded-For': '198.51.100.10',
            'X-Forwarded-Proto': 'https',
          },
        }),
        { remoteAddress: mappedPeer },
      )
      assert.equal(meRes.status, 403)
    }
  })

  it('honors X-Forwarded-For and X-Forwarded-Proto only over a verified UNIX ingress socket or ingressSecret channel', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    const dir = await mkdtemp(join(tmpdir(), 'xpanel-ingress-'))
    cleanup.push(async () => {
      await database.close()
      await state.close()
      await rm(dir, { recursive: true, force: true })
    })
    const password = 'IngressRootPassword!2026'
    const passwordHash = await hashPasswordArgon2id(password)
    const totpSecret = generateTotpSecret()
    const principal = await createRootPrincipal(database.db, {
      username: 'root', passwordHash, forcePasswordChange: false,
    })
    await setTotpSecret(database.db, principal.id, sealTotpSecret(totpSecret, SERVER_SECRET))

    const app = createApiApp({
      db: database.db,
      store: state.store,
      serverSecret: SERVER_SECRET,
      allowedOrigins: [ALLOWED_ORIGIN],
      requireSecureCookies: true,
      lockoutThreshold: 2,
      lockoutDurationMs: 60_000,
    })
    // A closed transport can still have an already-started authorization waiting
    // for the state mutex. Retire those real operations before deleting SQLite.
    const pendingAuthorizations = new Set<Promise<unknown>>()
    const authenticateUpgrade = app.authenticateUpgrade
    app.authenticateUpgrade = async (...args) => {
      const pending = authenticateUpgrade(...args)
      pendingAuthorizations.add(pending)
      try { return await pending }
      finally { pendingAuthorizations.delete(pending) }
    }
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\xpanel-ingress-${randomBytes(8).toString('hex')}`
      : join(dir, 'api-ingress.sock')
    const listener = await listenApiServer(app, { ingressSocketPath: socketPath })
    cleanup.push(async () => {
      await listener.close()
      await Promise.all(pendingAuthorizations)
    })

    const ingressHttp = async (path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
        const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined
        const req = httpRequest(
          {
            socketPath,
            path,
            method: opts.method ?? 'GET',
            headers: {
              Host: 'panel.xpanel.test',
              ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) } : {}),
              ...(opts.headers ?? {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c) => chunks.push(Buffer.from(c)))
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              text: Buffer.concat(chunks).toString('utf8'),
            }))
          },
        )
        req.once('error', reject)
        if (payload) req.write(payload)
        req.end()
      })

    // 1. Over the untrusted TCP port, forged X-Forwarded-Proto: https is rejected when requireSecureCookies is active
    const tcpLogin = await fetch(`http://127.0.0.1:${listener.port}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Origin: ALLOWED_ORIGIN,
        'X-Forwarded-For': '198.51.100.10',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ username: 'root', password, totpCode: computeTotpCode(totpSecret) }),
    })
    assert.equal(tcpLogin.status, 412)

    // 2. Over the verified UNIX ingress listener, X-Forwarded-Proto: https and X-Forwarded-For are trusted
    const ingressLogin = await ingressHttp('/api/auth/login', {
      method: 'POST',
      headers: {
        Origin: ALLOWED_ORIGIN,
        'X-Forwarded-For': '198.51.100.10',
        'X-Forwarded-Proto': 'https',
      },
      body: { username: 'root', password, totpCode: computeTotpCode(totpSecret) },
    })
    assert.equal(ingressLogin.status, 200)
    const setCookieHeader = String(ingressLogin.headers['set-cookie'] ?? '')
    assert.match(setCookieHeader, new RegExp(`^${HOST_SESSION_COOKIE_NAME}=`))
    assert.match(setCookieHeader, /;\s*Secure\b/)
    assert.match(setCookieHeader, /;\s*HttpOnly\b/)

    // 3. API token bound to 198.51.100.10/32 succeeds over verified ingress (HTTP + WS) and fails over direct TCP
    const rawToken = `xp_${randomBytes(32).toString('hex')}`
    await createApiToken(database.db, {
      principalId: principal.id,
      name: 'ingress-ip-bound',
      tokenHash: sha256Hex(rawToken),
      scopes: ['events:read'],
      allowedIps: ['198.51.100.10/32'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const ingressEvents = await ingressHttp('/api/events/recent', {
      headers: {
        Authorization: `Bearer ${rawToken}`,
        'X-Forwarded-For': '::ffff:198.51.100.10',
        'X-Forwarded-Proto': 'https',
      },
    })
    assert.equal(ingressEvents.status, 200)

    const wsIngressSocket = connect(socketPath)
    cleanup.push(() => {
      wsIngressSocket.destroy()
    })
    let wsBytes = Buffer.alloc(0)
    wsIngressSocket.on('data', (c) => { wsBytes = Buffer.concat([wsBytes, Buffer.from(c)]) })
    await new Promise<void>((resolve, reject) => {
      wsIngressSocket.once('connect', resolve)
      wsIngressSocket.once('error', reject)
    })
    wsIngressSocket.write([
      'GET /api/ws HTTP/1.1',
      'Host: panel.xpanel.test',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${rawToken}`,
      `Origin: ${ALLOWED_ORIGIN}`,
      'X-Forwarded-For: 198.51.100.10',
      'X-Forwarded-Proto: https',
      '\r\n',
    ].join('\r\n'))
    await eventually(() => wsBytes.toString('latin1').startsWith('HTTP/1.1 101'))

    // 4. Failed logins over verified ingress lock out the forwarded client IP without locking out other clients
    const bad1 = await ingressHttp('/api/auth/login', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': '198.51.100.77', 'X-Forwarded-Proto': 'https' },
      body: { username: 'nonexistent-a', password: 'WrongPassword!1' },
    })
    assert.equal(bad1.status, 401)
    const bad2 = await ingressHttp('/api/auth/login', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': '::ffff:198.51.100.77', 'X-Forwarded-Proto': 'https' },
      body: { username: 'nonexistent-b', password: 'WrongPassword!2' },
    })
    assert.equal(bad2.status, 429)

    // Another client IP behind the same ingress proxy is not locked out
    const otherClient = await ingressHttp('/api/auth/login', {
      method: 'POST',
      headers: { Origin: ALLOWED_ORIGIN, 'X-Forwarded-For': '198.51.100.88', 'X-Forwarded-Proto': 'https' },
      body: { username: 'nonexistent-c', password: 'WrongPassword!3' },
    })
    assert.equal(otherClient.status, 401)
  })

  it('rejects cross-origin Origin headers on cookie-authenticated HTTP mutations even when CSRF token is valid', async () => {
    const fixture = await authenticatedServer()
    const rawSession = randomBytes(32).toString('hex')
    await createSession(fixture.database.db, {
      principalId: fixture.principal.id,
      tokenHash: sha256Hex(rawSession),
      mfaVerified: true,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const csrfToken = deriveCsrfToken(rawSession, SERVER_SECRET)

    // Cross-origin POST mutation with valid session cookie + valid CSRF token must fail 403 before mutation
    const crossOriginPost = await fetch(`http://127.0.0.1:${fixture.port}/api/feature-lists`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawSession}`,
        'x-csrf-token': csrfToken,
        Origin: 'https://evil.example',
      },
      body: JSON.stringify({ name: 'CrossOriginList', ownerId: null, disabled: [] }),
    })
    assert.equal(crossOriginPost.status, 403)
    assert.equal((await fixture.app.fetch(new Request('http://localhost/api/feature-lists', {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${rawSession}` },
    })).then((r) => r.json()) as { featureLists: unknown[] }).featureLists.length, 0)

    // Same-origin / allowed-origin POST mutation with valid session cookie + valid CSRF token succeeds
    const allowedOriginPost = await fetch(`http://127.0.0.1:${fixture.port}/api/feature-lists`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${rawSession}`,
        'x-csrf-token': csrfToken,
        Origin: ALLOWED_ORIGIN,
      },
      body: JSON.stringify({ name: 'AllowedOriginList', ownerId: null, disabled: [] }),
    })
    assert.equal(allowedOriginPost.status, 201)
    const { featureList } = (await allowedOriginPost.json()) as { featureList: { id: string } }

    // Cross-origin PATCH and DELETE must also fail 403
    for (const method of ['PATCH', 'DELETE'] as const) {
      const res = await fetch(`http://127.0.0.1:${fixture.port}/api/feature-lists/${featureList.id}`, {
        method,
        headers: {
          ...(method === 'PATCH' ? { 'content-type': 'application/json' } : {}),
          Cookie: `${SESSION_COOKIE_NAME}=${rawSession}`,
          'x-csrf-token': csrfToken,
          Origin: 'https://evil.example',
        },
        ...(method === 'PATCH' ? { body: JSON.stringify({ name: 'Tampered' }) } : {}),
      })
      assert.equal(res.status, 403)
    }

    // Cookie-authenticated WS upgrade with cross-origin or missing Origin must fail 401
    const wsCrossOrigin = await openWire(fixture.port, {
      Cookie: `${SESSION_COOKIE_NAME}=${rawSession}`,
      Origin: 'https://evil.example',
    })
    assert.equal(wsCrossOrigin.status, 401)
    const wsMissingOrigin = await openWire(fixture.port, {
      Cookie: `${SESSION_COOKIE_NAME}=${rawSession}`,
    })
    assert.equal(wsMissingOrigin.status, 401)

    const audits = await listAudit(fixture.database.db, { limit: 20 })
    assert.ok(audits.some((a) => a.action === 'auth.origin_rejected' && a.outcome === 'denied'))
  })

  it('drops mid-queue WebSocket events on account suspension, ownership transfer, password reset, and token revocation', async () => {
    const database = await createTestDb()
    const state = await createTestStateStore()
    cleanup.push(async () => { await database.close(); await state.close() })

    const fl = await state.store.createFeatureList({ name: 'Default', ownerId: null, disabled: [] })
    const plan = await state.store.createPlan({
      name: 'Standard',
      ownerId: null,
      featureListId: fl.id,
      resources: {
        diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 10_000_000, ioWriteBps: 10_000_000,
        ioReadIops: 1000, ioWriteIops: 1000, memoryMb: 512, maxProcesses: 32, cpuPercent: 100,
      },
      caps: {
        addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 5, forwarders: 5,
        mailingLists: 2, ftpAccounts: 5, databases: 5, phpWorkers: 4,
      },
      dedicatedIp: false,
      shell: 'jailed',
      defaultMailboxQuotaMb: 512,
    })
    const resellerA = await state.store.createReseller({
      username: 'resellera',
      passwordHash: fixturePasswordHash,
      acl: ['list-accounts', 'edit-account', 'suspend-account'],
      maxAccounts: 10,
      totalDiskMb: 10240,
      totalBandwidthMb: 102400,
      oversell: false,
      nameservers: ['ns1.example.test'],
      delegatedIps: [],
    })
    const resellerB = await state.store.createReseller({
      username: 'resellerb',
      passwordHash: fixturePasswordHash,
      acl: ['list-accounts'],
      maxAccounts: 10,
      totalDiskMb: 10240,
      totalBandwidthMb: 102400,
      oversell: false,
      nameservers: ['ns1.example.test'],
      delegatedIps: [],
    })
    await createResellerPrincipal(database.db, {
      id: resellerA.id, username: resellerA.username, passwordHash: fixturePasswordHash,
    })
    await state.store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
    const accountA = await state.store.createAccount({
      username: 'alice',
      passwordHash: fixturePasswordHash,
      primaryDomain: 'alice.example.test',
      planId: plan.id,
      ownerId: resellerA.id,
      contactEmail: 'alice@example.test',
      ipv4: '203.0.113.10',
      shell: 'jailed',
      php: {
        version: '8.3',
        handler: 'fpm',
        fpm: { mode: 'ondemand', maxChildren: 4, startServers: 2, minSpareServers: 1, maxSpareServers: 3, maxRequests: 500, processIdleTimeoutSec: 10 },
        ini: {},
      },
    })
    const userPrincipal = await createUserPrincipal(database.db, {
      username: accountA.username, passwordHash: fixturePasswordHash, accountId: accountA.id,
    })

    const app = createApiApp({
      db: database.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ALLOWED_ORIGIN],
    })
    const listener = await listenApiServer(app)
    const sockets = new Set<Socket>()
    listener.server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    cleanup.push(async () => {
      for (const s of sockets) s.destroy()
      await listener.close()
    })

    // Connect both user (alice) and reseller (resellera) over real WebSockets
    const userRaw = `xp_${randomBytes(32).toString('hex')}`
    await createApiToken(database.db, {
      principalId: userPrincipal.id, name: 'alice-ws', tokenHash: sha256Hex(userRaw),
      scopes: ['events:read'], allowedIps: ['127.0.0.1/32'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })
    const resellerRaw = `xp_${randomBytes(32).toString('hex')}`
    await createApiToken(database.db, {
      principalId: resellerA.id, name: 'reseller-ws', tokenHash: sha256Hex(resellerRaw),
      scopes: ['events:read'], allowedIps: ['127.0.0.1/32'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    })

    const userClient = await openWire(listener.port, { Authorization: `Bearer ${userRaw}`, Origin: ALLOWED_ORIGIN })
    const resellerClient = await openWire(listener.port, { Authorization: `Bearer ${resellerRaw}`, Origin: ALLOWED_ORIGIN })
    assert.equal(userClient.status, 101)
    assert.equal(resellerClient.status, 101)

    // Initial event while active is delivered to both
    app.hub.broadcast(event('alice-active-1', accountA.id))
    await eventually(() =>
      userClient.bytes.includes(Buffer.from('alice-active-1')) &&
      resellerClient.bytes.includes(Buffer.from('alice-active-1')),
    )

    // Enqueue 6 events into memory FIRST, then suspend accountA while the queue is flushing
    for (let i = 0; i < 6; i++) {
      app.hub.broadcast(event(`suspended-queued-secret-${i}`, accountA.id))
    }
    await state.store.suspendAccount(accountA.id, 'policy violation')
    for (let i = 6; i < 10; i++) {
      app.hub.broadcast(event(`suspended-queued-secret-${i}`, accountA.id))
    }
    const resellerBarrier = event('reseller-own-barrier-after-suspend')
    resellerBarrier.scope.resellerId = resellerA.id
    app.hub.broadcast(resellerBarrier)

    await eventually(() => userClient.closed)
    await eventually(() => resellerClient.bytes.includes(Buffer.from('reseller-own-barrier-after-suspend')))
    assert.equal(userClient.bytes.includes(Buffer.from('suspended-queued-secret-9')), false)
    assert.equal(resellerClient.bytes.includes(Buffer.from('suspended-queued-secret-9')), false)

    // Unsuspend accountA, enqueue events, then transfer ownership to resellerB while queued
    await state.store.unsuspendAccount(accountA.id)
    await state.store.changeOwner(accountA.id, resellerB.id)
    for (let i = 0; i < 6; i++) {
      app.hub.broadcast(event(`transferred-queued-secret-${i}`, accountA.id))
    }
    const resellerBarrier2 = event('reseller-own-barrier-after-transfer')
    resellerBarrier2.scope.resellerId = resellerA.id
    app.hub.broadcast(resellerBarrier2)
    await eventually(() => resellerClient.bytes.includes(Buffer.from('reseller-own-barrier-after-transfer')))
    assert.equal(resellerClient.bytes.includes(Buffer.from('transferred-queued-secret')), false)

    // Enqueue events for resellerA, then reset resellerA's password while queued; queued events must drop and socket close
    const replacementHash = await hashPasswordArgon2id(randomBytes(32).toString('hex'))
    await setPasswordHash(database.db, resellerA.id, replacementHash, { forceChange: true })
    for (let i = 0; i < 4; i++) {
      const ev = event(`reseller-after-pw-reset-${i}`)
      ev.scope.resellerId = resellerA.id
      app.hub.broadcast(ev)
    }
    await eventually(() => resellerClient.closed)
    assert.equal(resellerClient.bytes.includes(Buffer.from('reseller-after-pw-reset')), false)
    assert.equal(app.hub.clientCount, 0)
  })

  it('assigns monotonic sequence cursors and flags resyncRequired when bounded WS history rolls over', async () => {
    const fixture = await authenticatedServer()
    const token = await fixture.token()
    for (let i = 1; i <= 5; i++) {
      fixture.app.hub.broadcast(event(`seq-event-${i}`))
    }
    const res1 = await fetch(`http://127.0.0.1:${fixture.port}/api/events/recent?afterSeq=2`, {
      headers: token.headers,
    })
    assert.equal(res1.status, 200)
    const body1 = (await res1.json()) as {
      events: Array<{ id: string; seq: number }>
      cursor: number
      oldestRetainedSeq: number | null
      resyncRequired: boolean
    }
    assert.deepEqual(body1.events.map((e) => e.id), ['seq-event-3', 'seq-event-4', 'seq-event-5'])
    assert.deepEqual(body1.events.map((e) => e.seq), [3, 4, 5])
    assert.equal(body1.cursor, 5)
    assert.equal(body1.oldestRetainedSeq, 1)
    assert.equal(body1.resyncRequired, false)

    // Roll over bounded 100-event history and verify afterSeq=2 reports resyncRequired: true
    for (let i = 6; i <= 115; i++) {
      fixture.app.hub.broadcast(event(`seq-event-${i}`))
    }
    const res2 = await fetch(`http://127.0.0.1:${fixture.port}/api/events/recent?afterSeq=2&limit=5`, {
      headers: token.headers,
    })
    assert.equal(res2.status, 200)
    const body2 = (await res2.json()) as {
      events: Array<{ id: string; seq: number }>
      cursor: number
      oldestRetainedSeq: number | null
      resyncRequired: boolean
    }
    assert.equal(body2.resyncRequired, true)
    assert.equal(body2.oldestRetainedSeq, 16)
    assert.equal(body2.cursor, 115)

    // WebSocket upgrade with ?afterSeq=112 replays only events 113..115
    const wsClient = await openWire(fixture.port, token.headers, '/api/ws?afterSeq=112')
    assert.equal(wsClient.status, 101)
    await eventually(() => wsClient.bytes.includes(Buffer.from('seq-event-115')))
    assert.equal(wsClient.bytes.includes(Buffer.from('seq-event-112')), false)
    assert.equal(wsClient.bytes.includes(Buffer.from('seq-event-113')), true)
  })

  it('rejects fragmented client data frames and mismatched pong payloads', async () => {
    const hub = new LiveEventHub({ heartbeatIntervalMs: 25, pongTimeoutMs: 40 })
    const port = await serve(hub, async () => ROOT)

    // 1. Fragmented client text frame (FIN=0, opcode=1) is rejected immediately
    const fragClient = await openWire(port)
    assert.equal(fragClient.status, 101)
    const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
    const payload = Buffer.from('frag')
    const fragFrame = Buffer.concat([
      Buffer.from([0x01, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!)),
    ])
    fragClient.socket.write(fragFrame)
    await eventually(() => fragClient.closed)

    // 2. Client sending a pong with a mismatched payload does not cancel the heartbeat timeout
    const badPongClient = await openWire(port)
    assert.equal(badPongClient.status, 101)
    const badPongPayload = Buffer.from('wrongpong')
    const pongFrame = Buffer.concat([
      Buffer.from([0x8a, 0x80 | badPongPayload.length]),
      mask,
      Buffer.from(badPongPayload.map((b, i) => b ^ mask[i % 4]!)),
    ])
    badPongClient.socket.write(pongFrame)
    await eventually(() => badPongClient.closed)
    assert.equal(hub.clientCount, 0)
  })
})

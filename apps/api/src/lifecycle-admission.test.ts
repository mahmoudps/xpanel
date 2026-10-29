import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import type { Db } from '@xpanel/db'
import { StateStore } from '@xpanel/state'
import { createApiApp } from './server.ts'
import { startPanelServer } from './test-panel-server.ts'
import { createAgentApp, type AgentServerDeps } from '../../agent/src/server.ts'

// Synthetic filesystem reader fixtures exercise real route dispatch, never native authority.
const model = vi.hoisted(() => ({ namespace: false, bytes: null as Buffer | null, failure: null as Error | null, rootReads: 0, fenceAfterPrecheck: false, lockFailure: false }))
// Only replace the native systemd participation transport. Admission, startup dispatch,
// quarantine app and listener are the actual production implementations.
vi.mock('../../../scripts/lifecycle-admission.mjs', async original => {
  const actual = await original<typeof import('../../../scripts/lifecycle-admission.mjs')>()
  return { ...actual, startLifecycleWriterParticipant: async () => ({ close: async () => {} }) }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (args[0] === '/var/lib/xpanel-lifecycle/writer.lock' && model.lockFailure) throw Object.assign(new Error('lock unread'), { code: 'EIO' })
    if (args[0] === '/var/lib/xpanel-lifecycle') {
      model.rootReads++
      if (model.fenceAfterPrecheck && model.rootReads === 2) { model.namespace = true; model.bytes = Buffer.from(JSON.stringify(pending)) }
      if (!model.namespace) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
      return {} as Awaited<ReturnType<typeof actual.lstat>>
    }
    return actual.lstat(...args)
  } }
})
vi.mock('../../../scripts/lifecycle-ownership.mjs', () => ({
  withTrustedDirectory: async (_path: string, callback: () => unknown) => { if (model.failure) throw model.failure; return callback() },
  withTrustedFile: async (path: string, _options: unknown, callback: (pin: { bytes: Buffer }) => unknown) => {
    if (model.failure) throw model.failure
    if (path !== '/var/lib/xpanel-lifecycle/writer-barrier.json' || !model.bytes) throw Object.assign(new Error('absent'), { code: 'ENOENT' })
    return callback({ bytes: model.bytes })
  },
}))
const pending = { schemaVersion: 1, operationId: '12345678-1234-4234-8234-123456789abc', reference: null, kind: 'upgrade', phase: 'pending', requestFingerprint: 'a'.repeat(64), sequence: 1, createdAt: '2026-10-24T12:00:00.000Z' }
const fixture = () => {
  const query = vi.fn(() => { throw new Error('No database access is permitted by this fixture') })
  const db = { query, transaction: vi.fn(() => { throw new Error('No transaction is permitted') }) } as unknown as Db
  const store = new StateStore('/unused-lifecycle-route-fixture')
  const api = createApiApp({ db, store, serverSecret: 'lifecycle-fixture-secret-at-least-32-bytes' })
  const agent = createAgentApp({ db, store, agentToken: 'a'.repeat(64), reconciler: { subscribe: () => () => {} } } as unknown as AgentServerDeps)
  return { api, agent, query, db }
}

describe('current API and agent lifecycle admission', () => {
  beforeEach(() => { model.rootReads = 0; model.fenceAfterPrecheck = false; model.lockFailure = false; model.namespace = false; model.bytes = null; model.failure = null })
  it('preserves portable unadopted health and the existing agent authentication boundary', async () => {
    model.namespace = false; model.bytes = null; model.failure = null
    const { api, agent, query } = fixture()
    expect((await api.fetch(new Request('http://localhost/api/health'))).status).toBe(200)
    expect((await agent.fetch(new Request('http://agent.local/health'))).status).toBe(401)
    expect(query).not.toHaveBeenCalled()
  })
  it('blocks login, page reads and WS authorization before database/session/audit work', async () => {
    const { api, agent, query, db } = fixture()
    model.namespace = true
    for (const bytes of [JSON.stringify(pending), JSON.stringify({ ...pending, phase: 'retirement_pending' }), '{invalid']) {
      model.bytes = Buffer.from(bytes); model.failure = null
      for (const path of ['/api/auth/login', '/home', '/api/health?apply=1']) {
        const response = await api.fetch(new Request('http://localhost' + path, { method: path.includes('login') ? 'POST' : 'GET' }))
        expect(response.status).toBe(503); expect(response.headers.get('set-cookie')).toBeNull()
      }
      expect(typeof await api.authenticateUpgrade({ headers: { host: 'localhost' }, url: '/api/ws' } as IncomingMessage)).toBe('symbol')
      expect((await agent.fetch(new Request('http://agent.local/health'))).status).toBe(503)
      expect((await api.fetch(new Request('http://localhost/api/health'))).status).toBe(200)
    }
    expect(query).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled()
  })
  it('keeps an unread or unsafe existing namespace fenced', async () => {
    model.namespace = true; model.bytes = null; model.failure = new Error('TRUSTED_PARENT_DRIFT')
    const { api, agent, query } = fixture()
    expect((await api.fetch(new Request('http://localhost/login'))).status).toBe(503)
    expect((await agent.fetch(new Request('http://agent.local/host/info'))).status).toBe(503)
    expect(query).not.toHaveBeenCalled()
    model.namespace = false; model.failure = null
  })
})

// A real local TCP upgrade checks the emitted status, not only the authorization result.
const rawUpgrade = async (api: ReturnType<typeof createApiApp>) => {
  const server = createServer()
  api.hub.attachToServer(server, req => api.authenticateUpgrade(req))
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test listener')
    return await rawUpgradePort(address.port)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}
const rawUpgradePort = (port: number) => new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1'); let bytes = ''
      socket.setTimeout(2000, () => socket.destroy(new Error('test upgrade did not settle')))
      socket.once('error', reject)
      socket.on('data', chunk => { bytes += chunk.toString('utf8') })
      socket.once('end', () => { socket.destroy(); resolve(bytes) })
      socket.once('connect', () => socket.write('GET /api/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + 'dGhlIHNhbXBsZSBub25j' + 'ZQ==' + '\r\n\r\n'))
})

describe('WebSocket lifecycle availability over the network', () => {
  beforeEach(() => { model.rootReads = 0; model.fenceAfterPrecheck = false; model.lockFailure = false; model.namespace = false; model.bytes = null; model.failure = null })
  it('keeps ordinary unauthenticated legacy upgrades at one 401', async () => {
    const { api, query } = fixture()
    const response = await rawUpgrade(api)
    expect(response).toMatch(/^HTTP\/1.1 401 Unauthorized/)
    expect(response.match(/HTTP\/1.1/g)).toHaveLength(1)
    expect(response).not.toMatch(/set-cookie|retry-after/i)
    expect(query).not.toHaveBeenCalled()
  })
  it('keeps the actual quarantined startup listener retryable before any database initialization', async () => {
    model.namespace = true; model.bytes = Buffer.from(JSON.stringify(pending))
    const agentApp = { fetch: async () => { throw new Error('quarantined startup must not call the agent') } } as unknown as import('../../agent/src/server.ts').AgentApp
    const server = await startPanelServer({ port: 0, host: '127.0.0.1', agentApp })
    try {
      expect(server.quarantined).toBe(true)
      expect(server).not.toHaveProperty('db')
      const response = await rawUpgradePort(server.port)
      expect(response).toMatch(/^HTTP\/1.1 503 Service Unavailable/)
      expect(response.match(/HTTP\/1.1/g)).toHaveLength(1)
      expect(response).toMatch(/\r\nRetry-After: 5\r\n/i)
      expect(response).not.toMatch(/set-cookie/i)
    } finally { await server.close() }
  })
  it.each(['pending', 'retirement_pending', 'invalid', 'unsafe', 'race', 'lock-error'])('returns exactly one retryable 503 before authentication: %s', async kind => {
    const { api, query, db } = fixture()
    if (kind === 'race') model.fenceAfterPrecheck = true
    else if (kind === 'lock-error') model.lockFailure = true
    else {
      model.namespace = true
      model.bytes = Buffer.from(kind === 'invalid' ? '{invalid' : JSON.stringify({ ...pending, phase: kind === 'retirement_pending' ? kind : 'pending' }))
      if (kind === 'unsafe') model.failure = new Error('TRUSTED_PARENT_DRIFT')
    }
    const response = await rawUpgrade(api)
    expect(response).toMatch(/^HTTP\/1.1 503 Service Unavailable/)
    expect(response.match(/HTTP\/1.1/g)).toHaveLength(1)
    expect(response).toMatch(/\r\nRetry-After: 5\r\n/i)
    expect(response).not.toMatch(/set-cookie/i)
    expect(query).not.toHaveBeenCalled(); expect(db.transaction).not.toHaveBeenCalled()
  })
})

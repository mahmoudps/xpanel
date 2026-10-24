import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Db } from '@xpanel/db'
import { StateStore } from '@xpanel/state'
import { createApiApp } from './server.ts'
import { createAgentApp, type AgentServerDeps } from '../../agent/src/server.ts'

// Synthetic filesystem reader fixtures exercise real route dispatch, never native authority.
const model = vi.hoisted(() => ({ namespace: false, bytes: null as Buffer | null, failure: null as Error | null }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (args[0] === '/var/lib/xpanel-lifecycle') {
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
      expect(await api.authenticateUpgrade({ headers: { host: 'localhost' }, url: '/api/ws' } as IncomingMessage)).toBeNull()
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

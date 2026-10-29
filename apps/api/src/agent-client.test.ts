import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server, RequestListener } from 'node:http'
import { afterEach, describe, it, vi } from 'vitest'
import { MAX_AGENT_MESSAGE_BYTES } from '@xpanel/agent'
import { isXpanelError, XpanelError } from '@xpanel/core'
import type { LiveEvent } from '@xpanel/core'
import { createApiToken, createRootPrincipal, createTestDb, setTotpSecret } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { generateTotpSecret, hashPasswordArgon2id, sealTotpSecret, sha256Hex } from './auth.ts'
import { createAgentClient } from './agent-client.ts'
import { createApiApp } from './server.ts'

const TOKEN = 'a'.repeat(64)

describe('agent IPC client configuration', () => {
  it('rejects missing credentials and invalid timeouts before opening a connection', () => {
    assert.throws(() => createAgentClient({ socketPath: '/run/xpanel/agent.sock', token: '' }))
    assert.throws(() => createAgentClient({ socketPath: '/run/xpanel/agent.sock', token: TOKEN, timeoutMs: 0 }))
  })

  it('reports a missing local transport as SERVICE_UNAVAILABLE with HTTP 503, without exposing the socket path', async () => {
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\xpqb-missing-${randomUUID()}` : `/run/xpqb-missing-${randomUUID()}/agent.sock`
    const client = createAgentClient({ socketPath, token: TOKEN, timeoutMs: 100 })
    try {
      await assert.rejects(() => client.fetch(new Request('http://agent.local/health')), error => {
        assert.ok(isXpanelError(error))
        assert.equal(error.code, 'SERVICE_UNAVAILABLE')
        assert.equal(error.status, 503)
        assert.equal(error.message.includes(socketPath), false)
        return true
      })
      assert.equal(new XpanelError('PRECONDITION_FAILED', 'confined helper unavailable').status, 412)
    } finally { client.close() }
  })

  it('returns the sanitized transport outage as HTTP 503 through the actual API adapter', async () => {
    const db = await createTestDb()
    const state = await createTestStateStore()
    const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\xpqb-api-missing-${randomUUID()}` : `/run/xpqb-api-missing-${randomUUID()}/agent.sock`
    const client = createAgentClient({ socketPath, token: TOKEN, timeoutMs: 100 })
    try {
      const serverSecret = 'b'.repeat(64)
      const principal = await createRootPrincipal(db.db, { username: 'root', passwordHash: await hashPasswordArgon2id(randomUUID()), forcePasswordChange: false })
      await setTotpSecret(db.db, principal.id, sealTotpSecret(generateTotpSecret(), serverSecret))
      const rawToken = randomUUID()
      await createApiToken(db.db, { principalId: principal.id, name: 'Availability test', tokenHash: sha256Hex(rawToken), scopes: ['*'], expiresAt: new Date(Date.now() + 60_000).toISOString() })
      const app = createApiApp({ db: db.db, store: state.store, serverSecret, agentApp: client, agentToken: TOKEN })
      const response = await app.fetch(new Request('http://api.local/api/analytics/io', { headers: { authorization: `Bearer ${rawToken}` } }))
      assert.equal(response.status, 503)
      const problem = await response.text()
      assert.equal(JSON.parse(problem).code, 'SERVICE_UNAVAILABLE')
      assert.equal(problem.includes(socketPath), false)
      assert.equal(problem.includes(TOKEN), false)
    } finally {
      client.close()
      await db.close()
      await state.close()
    }
  })

  it('has no TCP fallback or ability to relay requests to an external origin', async () => {
    const client = createAgentClient({ socketPath: '/missing-agent.sock', token: TOKEN })
    await assert.rejects(() => client.fetch(new Request('http://example.com/reconcile')),
      error => isXpanelError(error) && error.code === 'VALIDATION')
    client.close()
    await assert.rejects(() => client.fetch(new Request('http://agent.local/health')),
      error => isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE')
  })
})

// These are actual Windows development IPC requests, not Linux permission/UID proof.
// The Linux deployment path requires a separately provisioned root-owned socket.
if (process.platform === 'win32') describe('agent client over a Windows local named pipe', () => {
  let server: Server | undefined
  let client: ReturnType<typeof createAgentClient> | undefined

  const listen = async (handler: RequestListener, timeoutMs = 1_000) => {
    const socketPath = `\\\\.\\pipe\\xpanel-agent-test-${randomUUID()}`
    server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(socketPath, resolve)
    })
    client = createAgentClient({ socketPath, token: TOKEN, timeoutMs })
    return client
  }

  afterEach(async () => {
    client?.close()
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(() => resolve()))
    }
    client = undefined
    server = undefined
  })

  it('uses the configured credential, forwards principal identity, and drops caller role headers', async () => {
    const principalId = randomUUID()
    const ipc = await listen(async (req, res) => {
      assert.equal(req.headers['x-xpanel-agent-token'], TOKEN)
      assert.equal(req.headers['x-xpanel-principal-id'], principalId)
      assert.equal(req.headers['x-xpanel-role'], undefined)
      assert.equal(req.headers['x-xpanel-actor'], undefined)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString() }))
    })
    const response = await ipc.fetch(new Request('http://agent.local/state/apply?fixture=1', {
      method: 'POST', headers: {
        'content-type': 'application/json', 'x-xpanel-agent-token': 'forged',
        'x-xpanel-principal-id': principalId, 'x-xpanel-role': 'root', 'x-xpanel-actor': 'victim',
      }, body: JSON.stringify({ force: false }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { method: 'POST', path: '/state/apply?fixture=1', body: '{"force":false}' })
  })

  it('preserves an agent rejection and fails a nonresponding local connection with a bounded timeout', async () => {
    const ipc = await listen((req, res) => {
      if (req.url === '/hang') return
      if (req.url === '/helper-unavailable') {
        res.statusCode = 412
        res.setHeader('content-type', 'application/problem+json')
        res.end('{"code":"PRECONDITION_FAILED"}')
        return
      }
      res.statusCode = 401
      res.setHeader('content-type', 'application/problem+json')
      res.end('{"code":"UNAUTHENTICATED"}')
    }, 50)
    const rejected = await ipc.fetch(new Request('http://agent.local/health'))
    assert.equal(rejected.status, 401)
    const missingHelper = await ipc.fetch(new Request('http://agent.local/helper-unavailable'))
    assert.equal(missingHelper.status, 412)
    assert.deepEqual(await missingHelper.json(), { code: 'PRECONDITION_FAILED' })
    await assert.rejects(() => ipc.fetch(new Request('http://agent.local/hang')),
      error => isXpanelError(error) && error.code === 'SERVICE_UNAVAILABLE')
  })

  it('streams a terminal session output beyond the request timeout and closes it on cancel', async () => {
    let closed!: () => void
    const serverClosed = new Promise<void>(resolve => { closed = resolve })
    let write!: (line: string) => void
    const ipc = await listen((req, res) => {
      assert.equal(req.url, '/terminal/sessions/2f7a1c9e-4b1d-4a7e-9c1f-6d2e8b5a3f10/output')
      res.setHeader('content-type', 'application/x-ndjson')
      res.flushHeaders()
      write = line => { res.write(line + '\n') }
      res.once('close', closed)
    }, 50)
    const response = await ipc.fetch(new Request('http://agent.local/terminal/sessions/2f7a1c9e-4b1d-4a7e-9c1f-6d2e8b5a3f10/output'))
    const reader = response.body!.getReader()
    await new Promise(resolve => setTimeout(resolve, 120))
    write('{"o":"aGk="}')
    assert.equal(Buffer.from((await reader.read()).value!).toString(), '{"o":"aGk="}\n')
    await reader.cancel()
    await serverClosed
  })

  it('limits response bytes and never accepts partial content as success', async () => {
    const ipc = await listen((_req, res) => res.end(Buffer.alloc(MAX_AGENT_MESSAGE_BYTES + 1)))
    await assert.rejects(() => ipc.fetch(new Request('http://agent.local/oversized')),
      error => isXpanelError(error) && error.code === 'LIMIT_EXCEEDED')
  })

  it('receives an authenticated live event and closes the stream when unsubscribed', async () => {
    let resolveClosed = () => undefined as void
    const streamClosed = new Promise<void>(resolve => { resolveClosed = resolve })
    const event = {
      id: randomUUID(), at: new Date().toISOString(), kind: 'service.health',
      scope: { accountId: null, resellerId: null }, data: { service: 'nginx', healthy: true },
    } as unknown as LiveEvent
    const ipc = await listen((req, res) => {
      assert.equal(req.url, '/internal/events')
      assert.equal(req.headers['x-xpanel-agent-token'], TOKEN)
      res.once('close', resolveClosed)
      res.setHeader('content-type', 'application/x-ndjson')
      res.write(`${JSON.stringify({ heartbeat: new Date().toISOString() })}\n`)
      res.write(`${JSON.stringify({ event })}\n`)
    })
    let unsubscribe = () => undefined as void
    const received = await new Promise<LiveEvent>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('event stream did not deliver fixture')), 2_000)
      unsubscribe = ipc.subscribe(value => { clearTimeout(timeout); resolve(value) })
    })
    assert.deepEqual(received, event)
    unsubscribe()
    await streamClosed
  })

  it('disconnects malformed event frames without dispatching them to API subscribers', async () => {
    let resolveClosed = () => undefined as void
    const streamClosed = new Promise<void>(resolve => { resolveClosed = resolve })
    const ipc = await listen((_req, res) => {
      res.once('close', resolveClosed)
      res.setHeader('content-type', 'application/x-ndjson')
      res.write('null\n')
    })
    let delivered = 0
    const unsubscribe = ipc.subscribe(() => { delivered++ })
    await streamClosed
    unsubscribe()
    assert.equal(delivered, 0)
  })

  it('disconnects a failing internal subscriber without terminating other event consumers or leaking its error', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const event = { kind: 'service.health', scope: {}, data: {} } as unknown as LiveEvent
      const ipc = await listen((_req, res) => {
        res.setHeader('content-type', 'application/x-ndjson')
        res.write(`${JSON.stringify({ event })}\n`)
      })
      const removeFailing = ipc.subscribe(() => { throw new Error('PRIVATE_SUBSCRIBER_ERROR') })
      let removeHealthy = () => undefined as void
      const received = await new Promise<LiveEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('healthy subscriber lost its event')), 2_000)
        removeHealthy = ipc.subscribe(value => { clearTimeout(timer); resolve(value) })
      })
      assert.deepEqual(received, event)
      assert.equal(warning.mock.calls.length, 1)
      assert.equal(warning.mock.calls[0]?.[0], 'Agent event subscriber failed and was disconnected')
      removeFailing()
      removeHealthy()
    } finally {
      warning.mockRestore()
    }
  })
})

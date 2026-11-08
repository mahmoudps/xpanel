import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_TOOLS_STATE } from '@xpanel/core'
import { createRootPrincipal, createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { atomicWriteJson } from '@xpanel/state'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { hashPasswordArgon2id } from './auth.ts'
import { runDdnsCycle } from './host-ddns.ts'
import { handleInboundHook } from './host-tools-workspace.ts'
import { createApiApp } from './server.ts'

const SERVER_SECRET = 'host-tools-synthetic-server-secret-at-least-32-bytes'
const ORIGIN = 'https://panel.example.test'
const PASSWORD = 'SyntheticRootPassword!2026'
let passwordHash: string
beforeAll(async () => { passwordHash = await hashPasswordArgon2id(PASSWORD) })
type Reply = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

describe('scheduler and host tools API', () => {
  let db: TestDbHandle
  let state: TestStateStoreHandle
  beforeEach(async () => { db = await createTestDb(); state = await createTestStateStore(); await createRootPrincipal(db.db, { username: 'root', passwordHash, forcePasswordChange: false }) })
  afterEach(async () => { await state.close(); await db.close() })

  const session = async () => {
    const api = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
    const login = await api.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN }, body: JSON.stringify({ username: 'root', password: PASSWORD }) }))
    const { csrfToken } = await login.json() as { csrfToken: string }
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Reply }> => {
      const response = await api.fetch(new Request(ORIGIN + path, { method, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrfToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      const text = await response.text()
      return { status: response.status, body: text ? JSON.parse(text) as Reply : {} }
    }
  }
  const TASKS = '/api/server/host-tools/tasks'
  const task = { name: 'Nightly', type: 'command', cycle: 'daily', hour: '3', minute: '5', command: '/usr/bin/true', enabled: true, chained: false }

  it('adds, edits and deletes a task bound to its revision', async () => {
    const call = await session(), first = await call('GET', TASKS)
    expect(first.body).toMatchObject({ rows: [], tasks: [], scripts: [] })
    const saved = await call('POST', TASKS, { ...task, expectedRevision: first.body.revision })
    expect(saved.status).toBe(200)
    expect((await call('POST', TASKS, { ...task, expectedRevision: first.body.revision })).status).toBe(409)
    const edited = await call('PUT', `${TASKS}/${saved.body.id}`, { ...task, name: 'Renamed', expectedRevision: saved.body.revision })
    expect((await call('GET', TASKS)).body.rows).toMatchObject([{ id: saved.body.id, name: 'Renamed', hour: 3 }])
    expect((await call('DELETE', `${TASKS}/${saved.body.id}`, { expectedRevision: edited.body.revision })).status).toBe(200)
    expect((await call('GET', TASKS)).body.rows).toEqual([])
  })

  it('rejects a site backup every N seconds and a task with a shell line', async () => {
    const call = await session(), { revision } = (await call('GET', TASKS)).body
    const backup = await call('POST', TASKS, { ...task, type: 'site-backup', cycle: 'seconds', every: 30, target: 'example.com', keep: 3, expectedRevision: revision })
    expect(backup.status).toBe(422)
    expect(JSON.stringify(backup.body)).toContain('task_cycle_invalid')
    expect(JSON.stringify((await call('POST', TASKS, { ...task, command: 'rm -rf /', expectedRevision: revision })).body)).toContain('task_command_invalid')
  })

  it('refuses a trigger loop, and deleting a task its trigger needs', async () => {
    const call = await session()
    let { revision } = (await call('GET', TASKS)).body
    const one = await call('POST', TASKS, { ...task, name: 'One', expectedRevision: revision }), two = await call('POST', TASKS, { ...task, name: 'Two', expectedRevision: one.body.revision })
    const TRIGGERS = '/api/server/host-tools/triggers'
    const link = await call('POST', TRIGGERS, { name: 'A', taskId: one.body.id, match: 'include', value: 'x', targetId: two.body.id, expectedRevision: two.body.revision })
    expect(link.status).toBe(200)
    revision = link.body.revision
    expect(JSON.stringify((await call('POST', TRIGGERS, { name: 'B', taskId: two.body.id, match: 'include', value: 'x', targetId: one.body.id, expectedRevision: revision })).body)).toContain('trigger_loop')
    expect(JSON.stringify((await call('DELETE', `${TASKS}/${two.body.id}`, { expectedRevision: revision })).body)).toContain('trigger_task_unknown')
  })

  it('says truthfully that a run needs a host agent', async () => {
    const call = await session(), read = await call('GET', TASKS), saved = await call('POST', TASKS, { ...task, expectedRevision: read.body.revision })
    const run = await call('POST', `${TASKS}/${saved.body.id}/run`, {})
    expect(run.status).toBe(412)
    expect(JSON.stringify(run.body)).toContain('host_agent_unavailable')
    expect((await call('POST', `${TASKS}/bbbbbbbbbbbb/run`, {})).status).toBe(404)
  })

  it('never returns dynamic DNS credentials or the frp token, and keeps them on an edit', async () => {
    const call = await session(), DDNS = '/api/server/host-tools/ddns', read = await call('GET', DDNS)
    const saved = await call('POST', DDNS, { hostname: 'home.example.com', provider: 'cloudflare', secret: 'x'.repeat(40), expectedRevision: read.body.revision })
    expect(saved.status).toBe(200)
    const list = await call('GET', DDNS)
    expect(JSON.stringify(list.body)).not.toContain('x'.repeat(40))
    expect(list.body.rows[0]).toMatchObject({ secret: '', secretSet: true })
    expect((await call('PUT', `${DDNS}/${saved.body.id}`, { hostname: 'home2.example.com', provider: 'cloudflare', secret: '', expectedRevision: list.body.revision })).status).toBe(200)
    expect((await call('GET', DDNS)).body.rows[0]).toMatchObject({ hostname: 'home2.example.com', secretSet: true })
  })

  it('refuses frp until the binary is installed', async () => {
    const call = await session(), read = await call('GET', '/api/server/host-tools/frp-server')
    const saved = await call('PUT', '/api/server/host-tools/frp-server', { enabled: true, bindPort: 7000, token: 'x'.repeat(32), portMin: 7100, portMax: 7199, expectedRevision: read.body.revision })
    expect(JSON.stringify(saved.body)).toContain('frp_not_installed')
  })

  it('lists watched services and saves one', async () => {
    const call = await session(), read = await call('GET', '/api/server/host-tools/watchdog')
    expect(read.body.rows.map((row: Reply) => row.id)).toEqual(['nginx', 'postfix', 'dovecot', 'mariadb', 'pdns', 'pure-ftpd'])
    expect((await call('PUT', '/api/server/host-tools/watchdog/dovecot', { enabled: true, autoRestart: true, intervalSec: 60, budgetPerHour: 2, expectedRevision: read.body.revision })).status).toBe(200)
    expect((await call('GET', '/api/server/host-tools/watchdog')).body.rows[2]).toMatchObject({ id: 'dovecot', enabled: true })
  })

  it('saves saved commands without a host', async () => {
    const call = await session(), API = '/api/server/host-tools/saved-commands', read = await call('GET', API)
    expect((await call('POST', API, { name: 'Disk', content: 'df -h', expectedRevision: read.body.revision })).status).toBe(200)
    expect((await call('GET', API)).body.rows).toMatchObject([{ name: 'Disk', content: 'df -h' }])
  })

  it('needs a session: no anonymous read', async () => {
    const api = createApiApp({ db: db.db, store: state.store, serverSecret: SERVER_SECRET, allowedOrigins: [ORIGIN] })
    expect((await api.fetch(new Request(ORIGIN + TASKS))).status).toBe(401)
  })

  describe('inbound hook', () => {
    const ID = 'aaaaaaaaaaa1', SCRIPT = 'bbbbbbbbbbb1'
    const key = 'k'.repeat(43), keyHash = 'c'.repeat(64)
    const save = async (hash: string): Promise<void> => {
      mkdirSync(join(state.store.rootDir, 'extended/server'), { recursive: true })
      await atomicWriteJson(join(state.store.rootDir, HOST_TOOLS_STATE.scheduler), { tasks: [], triggers: [], scripts: [{ id: SCRIPT, name: 'Deploy', language: 'bash', returns: 'string', args: '', remark: '', content: 'echo ok\n' }], hooks: [{ id: ID, name: 'Deploy', scriptId: SCRIPT, keyHash: hash, createdAt: '2026-11-07T00:00:00.000Z' }] })
    }
    const digest = async (value: string): Promise<string> => (await import('node:crypto')).createHash('sha256').update(value).digest('hex')
    const post = (value: string, id = ID) => new Request(`${ORIGIN}/hook/${id}`, { method: 'POST', headers: { 'x-hook-key': value }, body: 'rm -rf /' })
    const url = (request: Request) => new URL(request.url)
    const emitAudit = vi.fn(async () => undefined)

    it('answers 403 and runs nothing for a wrong key, and runs once for the right one', async () => {
      await save(await digest(key))
      const start = vi.fn(async () => true), ports = { store: state.store, start, emitAudit }
      const wrong = post('wrong')
      expect((await handleInboundHook(wrong, url(wrong), '192.0.2.9', ports)).status).toBe(403)
      expect(start).not.toHaveBeenCalled()
      const right = post(key)
      expect((await handleInboundHook(right, url(right), '192.0.2.9', ports)).status).toBe(202)
      expect(start.mock.calls).toEqual([[ID]])
      expect(emitAudit.mock.calls.map(call => (call as unknown[])[0])).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'server.hook.called', outcome: 'denied' }), expect.objectContaining({ action: 'server.hook.called', outcome: 'ok' })]))
    })
    it('never takes the key from the URL, where an access log would keep it', async () => {
      await save(await digest(key))
      const start = vi.fn(async () => true), inUrl = new Request(`${ORIGIN}/hook/${ID}?access_key=${key}`, { method: 'POST' })
      expect((await handleInboundHook(inUrl, url(inUrl), null, { store: state.store, start, emitAudit })).status).toBe(403)
      expect(start).not.toHaveBeenCalled()
    })
    it('never distinguishes an unknown hook, and accepts only POST', async () => {
      await save(keyHash)
      const start = vi.fn(async () => true), ports = { store: state.store, start, emitAudit }
      const unknown = post(key, 'cccccccccccc')
      expect((await handleInboundHook(unknown, url(unknown), null, ports)).status).toBe(403)
      const get = new Request(`${ORIGIN}/hook/${ID}`, { headers: { 'x-hook-key': key } })
      expect((await handleInboundHook(get, url(get), null, ports)).status).toBe(405)
      expect(start).not.toHaveBeenCalled()
    })
    it('limits calls per hook', async () => {
      await save(await digest(key))
      const start = vi.fn(async () => true), ports = { store: state.store, start, emitAudit, now: () => new Date(Date.UTC(2030, 0, 1)) }
      let last = 0
      for (let index = 0; index < 31; index++) { const request = post(key, 'aaaaaaaaaaa1'); last = (await handleInboundHook(request, url(request), null, ports)).status }
      expect(last).toBe(429)
      expect(start.mock.calls.length).toBeLessThanOrEqual(30)
    })
  })

  describe('dynamic DNS cycle', () => {
    const save = async (records: unknown[], intervalMinutes = 10): Promise<void> => {
      mkdirSync(join(state.store.rootDir, 'extended/server'), { recursive: true })
      await atomicWriteJson(join(state.store.rootDir, HOST_TOOLS_STATE.ddns), { intervalMinutes, ipSource: 'https://ip.example.test/', records })
    }
    const record = { id: 'aaaaaaaaaaa1', hostname: 'home.example.com', provider: 'dyndns2', server: 'https://dyn.example.test/nic/update', username: 'u', secret: 's3cret' }
    const fetcher = (ip: { value: string }, calls: string[]) => (async (input: URL | string) => {
      const target = String(input)
      if (target === 'https://ip.example.test/') return new Response(ip.value)
      calls.push(target)
      return new Response('good ' + ip.value)
    }) as unknown as typeof fetch
    const ports = (ip: { value: string }, calls: string[], at: { now: number }) => ({ store: state.store, fetcher: fetcher(ip, calls), reconcile: async () => true, now: () => new Date(at.now) })

    it('updates on a changed address at the next check, and only then', async () => {
      await save([record])
      const ip = { value: '203.0.113.1' }, calls: string[] = [], at = { now: Date.UTC(2026, 10, 7) }
      await runDdnsCycle(ports(ip, calls, at))
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('myip=203.0.113.1')
      at.now += 60_000
      await runDdnsCycle(ports(ip, calls, at))
      at.now += 10 * 60_000
      await runDdnsCycle(ports(ip, calls, at))
      expect(calls).toHaveLength(1)
      ip.value = '203.0.113.2'
      at.now += 10 * 60_000
      const status = await runDdnsCycle(ports(ip, calls, at))
      expect(calls[1]).toContain('myip=203.0.113.2')
      expect(status!.records[record.id]).toMatchObject({ ip: '203.0.113.2' })
    })

    it('records a provider refusal and retries it on the next check', async () => {
      await save([record])
      const calls: string[] = []
      const refuse = (async (input: URL | string) => { if (String(input).startsWith('https://ip.')) return new Response('203.0.113.1'); calls.push(String(input)); return new Response('badauth') }) as unknown as typeof fetch
      const status = await runDdnsCycle({ store: state.store, fetcher: refuse, reconcile: async () => true, now: () => new Date(Date.UTC(2026, 10, 7)) })
      expect(status!.records[record.id]).toMatchObject({ error: 'ddns_provider_refused' })
      await runDdnsCycle({ store: state.store, fetcher: refuse, reconcile: async () => true, now: () => new Date(Date.UTC(2026, 10, 7, 1)) })
      expect(calls).toHaveLength(2)
    })

    it('edits a zone on this server and bumps its serial', async () => {
      await save([{ id: 'aaaaaaaaaaa2', hostname: 'home.example.com', provider: 'local', server: '', username: '', secret: '' }])
      await state.store.saveDnsZone({ id: '22222222-2222-4222-8222-222222222222', name: 'example.com', accountId: null, serial: 1, records: [{ id: '11111111-1111-4111-8111-111111111111', zone: 'example.com', name: 'home', type: 'A', ttl: 300, content: '198.51.100.1', priority: null }] })
      const reconcile = vi.fn(async () => true)
      await runDdnsCycle({ store: state.store, fetcher: (async () => new Response('203.0.113.1')) as unknown as typeof fetch, reconcile, now: () => new Date(Date.UTC(2026, 10, 7)) })
      const zone = await state.store.getDnsZone('example.com')
      expect(zone).toMatchObject({ serial: 2 })
      expect(zone!.records[0]!.content).toBe('203.0.113.1')
      expect(reconcile).toHaveBeenCalledTimes(1)
    })

    it('does nothing without records', async () => {
      expect(await runDdnsCycle({ store: state.store, fetcher: (async () => { throw new Error('no network') }) as unknown as typeof fetch, reconcile: async () => true })).toBeNull()
    })
  })
})

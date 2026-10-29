import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createUserPrincipal, createTestDb, deletePrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'
import type { AgentServerDeps } from './server.ts'
import type { BenchmarkStore } from './benchmark.ts'

// Real mounted routing and persisted principal authentication. No Linux executor,
// host-job runner, Git runner or OpenPGP runner is enabled by these fixtures.
const TOKEN = 'a'.repeat(64)
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
// This boundary exercises route subscriptions only; reconciliation is never dispatched.
const subscriptionOnlyReconciler = (): AgentServerDeps['reconciler'] => {
  const boundary: Pick<AgentServerDeps['reconciler'], 'subscribe'> = { subscribe: () => () => {} }
  return boundary as unknown as AgentServerDeps['reconciler']
}
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Mounted agent cleanup failed')
})
async function fixture(extra: Partial<AgentServerDeps> = {}) {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const owner = await createUserPrincipal(database.db, { username: 'mountowner', accountId: randomUUID(), passwordHash: HASH })
  const executor = new FakeHostExecutor(), run = vi.spyOn(executor, 'runCommand'), read = vi.spyOn(executor, 'readFile')
  const app = createAgentApp({ db: database.db, store: state.store, executor,
    os: { id: 'ubuntu', versionId: '24.04', family: 'debian' }, agentToken: TOKEN,
    reconciler: subscriptionOnlyReconciler(), ...extra })
  const request = (path: string, options: { method?: string; body?: unknown; principalId?: string; token?: string } = {}) => app.fetch(new Request('http://agent.local' + path, {
    method: options.method ?? 'GET', headers: { ...agentCallerHeaders({ principalId: options.principalId ?? root.id, token: options.token ?? TOKEN }), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }))
  return { database, state, root, owner, executor, run, read, app, request }
}
const unavailableHistory = (): BenchmarkStore => ({ read: vi.fn<BenchmarkStore['read']>(async () => ({ state: 'read', results: [] })), prepare: vi.fn(async () => {}), removed: vi.fn(async () => true), append: vi.fn(async () => {}) })

describe('resumed workflows through the real agent app', () => {
  it.each([
    ['/host/databases/tuning', { state: 'unavailable', capabilities: { apply: false } }],
    ['/host/monitoring/benchmark', { history: { state: 'unavailable', results: [] }, jobsAvailable: false }],
    ['/host/monitoring/traffic', { interfaces: { state: 'unavailable', items: [] }, http: { state: 'unavailable' } }],
  ])('keeps absent native providers unavailable on %s', async (path, expected) => {
    const f = await fixture(), response = await f.request(path as string)
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject(expected)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('refuses native service control when a Linux executor is absent', async () => {
    const f = await fixture()
    for (const options of [{}, { method: 'POST', body: { action: 'restart', unit: 'ssh.service', expectedRevision: 'a'.repeat(64) } }]) {
      const response = await f.request('/host/service-manager' + (options.method ? '/action' : ''), options)
      expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    }
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['/host/service-manager', '/host/databases/tuning', '/host/monitoring/benchmark', '/host/monitoring/traffic'])('denies non-root callers before native work at %s', async path => {
    const f = await fixture(), response = await f.request(path, { principalId: f.owner.id })
    expect(response.status).toBe(403); expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['/host/service-manager?unit=ssh.service', '/host/databases/tuning?sql=SELECT+1', '/host/monitoring/benchmark?seconds=10', '/host/monitoring/traffic?path=/etc'])('rejects selectors before native work at %s', async path => {
    const f = await fixture(), response = await f.request(path)
    expect(response.status).toBe(422); expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['/host/service-manager', '/host/databases/tuning', '/host/monitoring/benchmark', '/host/monitoring/traffic'])('enforces route method at %s', async path => {
    const f = await fixture(), response = await f.request(path, { method: 'DELETE' })
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('GET')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('reads injected benchmark history but keeps jobs unavailable without their own runner', async () => {
    const store = unavailableHistory(), f = await fixture({ benchmarkStore: store })
    const view = await f.request('/host/monitoring/benchmark')
    expect(view.status).toBe(200); expect(await view.json()).toMatchObject({ history: { state: 'read', results: [] }, jobsAvailable: false })
    const refused = await f.request('/host/monitoring/benchmark/jobs', { method: 'POST', body: { confirm: 'RUN' } })
    expect(refused.status).toBe(412); expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    expect(store.prepare).not.toHaveBeenCalled(); expect(store.append).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it('reauthenticates persisted root authority after the benchmark history await', async () => {
    const store = unavailableHistory(), f = await fixture({ benchmarkStore: store })
    vi.mocked(store.read).mockImplementationOnce(async () => { await deletePrincipal(f.database.db, f.root.id); return { state: 'read', results: [] } })
    const response = await f.request('/host/monitoring/benchmark')
    expect(response.status).toBe(401); expect(store.prepare).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it('rejects a service token revoked at the mounted authentication boundary before providers', async () => {
    const store = unavailableHistory(), f = await fixture({ benchmarkStore: store })
    const response = await f.request('/host/monitoring/benchmark', { token: 'b'.repeat(64) })
    expect(response.status).toBe(401); expect(store.read).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it.each([{ confirm: 'RUN', seconds: 100 }, { confirm: 'run' }, { confirm: 'RUN', command: '/bin/sh' }])('rejects benchmark mutation grammar %j before providers', async body => {
    const store = unavailableHistory(), f = await fixture({ benchmarkStore: store })
    expect((await f.request('/host/monitoring/benchmark/jobs', { method: 'POST', body })).status).toBe(422)
    expect(store.prepare).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['/accounts/mountowner/git', '/accounts/mountowner/pgp'])('does not let root impersonate an account key/repository owner at %s', async path => {
    const f = await fixture()
    expect((await f.request(path)).status).toBe(403); expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })
})

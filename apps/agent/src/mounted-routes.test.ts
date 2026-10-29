import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createUserPrincipal, createResellerPrincipal, createTestDb, deletePrincipal } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import { profileFor } from '@xpanel/os'
import { FakeHostExecutor } from './executor.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'
import type { AgentServerDeps } from './server.ts'

const TOKEN = 'a'.repeat(64)
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const cleanup: Array<() => Promise<unknown>> = []
const subscriptionOnlyReconciler = (): AgentServerDeps['reconciler'] => {
  const boundary: Pick<AgentServerDeps['reconciler'], 'subscribe'> = { subscribe: () => () => {} }
  return boundary as unknown as AgentServerDeps['reconciler']
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Expected an object response')
  return value as Record<string, unknown>
}
async function revisionResponse(response: Response) {
  const value = jsonObject(await response.json())
  if (typeof value.revision !== 'string') throw new Error('Expected a string revision')
  return { ...value, revision: value.revision }
}
afterEach(async () => {
  vi.restoreAllMocks()
  const results = await Promise.allSettled(cleanup.splice(0).reverse().map(close => close()))
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Mounted-route agent fixture cleanup failed')
})
async function fixture(extra: Partial<AgentServerDeps> = {}) {
  const database = await createTestDb(); cleanup.push(() => database.close())
  const state = await createTestStateStore(); cleanup.push(() => state.close())
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: HASH, forcePasswordChange: false })
  const owner = await createUserPrincipal(database.db, { username: 'mountowner', accountId: randomUUID(), passwordHash: HASH })
  const resellerState = await state.store.createReseller({ username: 'mountreseller', passwordHash: HASH, acl: [], maxAccounts: 10, totalDiskMb: 100000, totalBandwidthMb: 100000, oversell: false, nameservers: [], delegatedIps: [] })
  const reseller = await createResellerPrincipal(database.db, { id: resellerState.id, username: resellerState.username, passwordHash: HASH })
  const executor = new FakeHostExecutor(), run = vi.spyOn(executor, 'runCommand'), read = vi.spyOn(executor, 'readFile')
  const app = createAgentApp({ db: database.db, store: state.store, executor, os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n'), agentToken: TOKEN, reconciler: subscriptionOnlyReconciler(), ...extra })
  const request = (path: string, options: { method?: string; body?: unknown; principalId?: string; token?: string } = {}) => app.fetch(new Request('http://agent.local' + path, { method: options.method ?? 'GET',
    headers: { ...agentCallerHeaders({ principalId: options.principalId ?? root.id, token: options.token ?? TOKEN }), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }))
  return { database, state, root, owner, reseller, executor, run, read, app, request }
}

describe('mounted real agent update mounts', () => {
  it.each(['', '?excludeKernel=true'])('keeps the plan option %s visible while native updates remain unavailable', async suffix => {
    const f = await fixture(), response = await f.request('/host/system-updates/plan' + suffix)
    expect(response.status).toBe(200)
    const body = jsonObject(await response.json())
    expect(body).toMatchObject({ plan: { state: 'unavailable', source: null, packages: [], reason: 'unsupported-host' }, actions: { refresh: false, apply: false } })
    if (suffix) expect(jsonObject(body.plan).excludeKernel).toBe(true)
    else expect(body.plan).not.toHaveProperty('excludeKernel')
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['?excludeKernel=false', '?excludeKernel=TRUE', '?excludeKernel=true&excludeKernel=true', '?excludeKernel=true&path=/etc'])('rejects selectors %s before any executor call', async suffix => {
    const f = await fixture()
    expect((await f.request('/host/system-updates/plan' + suffix)).status).toBe(422)
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['owner', 'reseller'] as const)('denies the %s principal before reading an update plan', async role => {
    const f = await fixture()
    expect((await f.request('/host/system-updates/plan?excludeKernel=true', { principalId: f[role].id })).status).toBe(403)
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('refuses missing native job authority without mutating packages or holds', async () => {
    const f = await fixture(), response = await f.request('/host/system-updates/apply', { method: 'POST', body: { mode: 'all', expectedRevision: 'a'.repeat(64), excludeKernel: true } })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('retains the service-token boundary for the excluded plan', async () => {
    const f = await fixture()
    expect((await f.request('/host/system-updates/plan?excludeKernel=true', { token: 'b'.repeat(64) })).status).toBe(401)
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })
})

describe('mounted real agent configuration health mounts', () => {
  const path = '/host/configuration-health'
  const intent = { target: 'a'.repeat(64), expectedRevision: 'b'.repeat(64), expectedGenerationId: 1, expectedGenerationChecksum: 'c'.repeat(64), confirmation: 'REPAIR CONFIGURATION' }
  it('reports no native observation and keeps targeted recoverable repair unavailable', async () => {
    const f = await fixture(), response = await f.request(path)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'unavailable', targets: [], tests: [], canRepair: false })
    const repair = await f.request(path + '/repair', { method: 'POST', body: intent })
    expect(repair.status).toBe(412); expect(await repair.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each(['owner', 'reseller'] as const)('refuses %s configuration observation or repair before provider work', async role => {
    const f = await fixture()
    expect((await f.request(path, { principalId: f[role].id })).status).toBe(403)
    expect((await f.request(path + '/repair', { principalId: f[role].id, method: 'POST', body: intent })).status).toBe(403)
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it.each([path + '?path=/etc/shadow', path + '/repair?command=id'])('refuses injected selectors on %s', async route => {
    const f = await fixture()
    expect((await f.request(route, route.includes('/repair') ? { method: 'POST', body: intent } : {})).status).toBe(422)
    expect(f.run).not.toHaveBeenCalled()
  })

  it.each([[path, 'GET'], [path + '/repair', 'POST']])('pins %s to method %s', async (route, allow) => {
    const f = await fixture(), response = await f.request(route!, { method: 'DELETE' })
    expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe(allow)
    expect(f.run).not.toHaveBeenCalled()
  })
})

async function boundAccount(f: Awaited<ReturnType<typeof fixture>>) {
  const features = await f.state.store.createFeatureList({ name: 'Bound native metadata', ownerId: null, disabled: [] })
  const plan = await f.state.store.createPlan({ name: 'Bound native metadata', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 4, aliasDomains: 4, subdomains: 4, mailboxes: 4, forwarders: 4, mailingLists: 4, ftpAccounts: 4, databases: 4, phpWorkers: 4 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await f.state.store.saveServerIp({ address: '192.0.2.64', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await f.state.store.createAccount({ username: 'boundowner', passwordHash: HASH, primaryDomain: 'boundowner.example.test', planId: plan.id, ownerId: null,
    contactEmail: 'owner@boundowner.example.test', ipv4: '192.0.2.64', shell: 'none',
    php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const principal = await createUserPrincipal(f.database.db, { username: account.username, accountId: account.id, passwordHash: HASH })
  return { account, principal, features, plan }
}
describe('mounted agent native provider holds and account binding', () => {
  it.each(['preview', 'apply'])('keeps Composer %s jobs unavailable without the qualified helper/provider', async action => {
    const f = await fixture(), response = await f.request('/host/composer/jobs/' + action, { method: 'POST', body: { action: 'install', domainId: randomUUID(), ...(action === 'apply' ? { expectedRevision: 'a'.repeat(64), reviewFingerprint: 'b'.repeat(64) } : {}) } })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('rejects arbitrary Composer command/path selectors before provider admission', async () => {
    const f = await fixture()
    expect((await f.request('/host/composer/jobs/preview', { method: 'POST', body: { action: 'install', domainId: randomUUID(), command: '/bin/sh', path: '/etc' } })).status).toBe(422)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('reads only managed private package metadata and keeps mutation admission absent', async () => {
    const files = vi.fn(async (_context: unknown, request: { op: string }) => { if (request.op === 'list') return []; throw new Error('Unexpected file effect: ' + request.op) })
    const f = await fixture({ accountFileRunner: { run: files } }), bound = await boundAccount(f), path = '/accounts/' + bound.account.username + '/packages'
    const response = await f.request(path, { principalId: bound.principal.id })
    expect(response.status).toBe(200)
    const view = await revisionResponse(response)
    expect(view).toMatchObject({ context: { accountId: bound.account.id }, packages: [], available: [], capabilities: { install: false, remove: false, recover: false } })
    expect((await f.request(path, { principalId: bound.principal.id, method: 'POST', body: { op: 'install', name: 'HTTP_Request2', expectedRevision: view.revision } })).status).toBe(412)
    expect(files.mock.calls.every(([, request]) => request.op === 'list')).toBe(true); expect(f.run).not.toHaveBeenCalled()
  })

  it.each(['root', 'reseller'] as const)('does not let %s impersonate a package owner', async role => {
    const f = await fixture(), bound = await boundAccount(f)
    expect((await f.request('/accounts/' + bound.account.username + '/packages', { principalId: f[role].id })).status).toBe(403)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('exposes saved remote-host policy while refusing unqualified SQL/firewall effects', async () => {
    const f = await fixture(), bound = await boundAccount(f), path = '/accounts/' + bound.account.username + '/database-remote-access', before = await f.state.store.getAccount(bound.account.id)
    const response = await f.request(path, { principalId: bound.principal.id })
    expect(response.status).toBe(200)
    const view = await revisionResponse(response)
    expect(view).toMatchObject({ entries: [], capability: { canChange: false, reason: 'native_provider_unavailable' }, application: { nativeQualified: false } })
    const refused = await f.request(path, { principalId: bound.principal.id, method: 'POST', body: { action: 'add', expectedRevision: view.revision, host: '203.0.113.7', comment: '' } })
    expect(refused.status).toBe(412); expect(await refused.json()).toMatchObject({ details: { stateChanged: false } })
    expect(await f.state.store.getAccount(bound.account.id)).toEqual(before); expect(f.run).not.toHaveBeenCalled()
  })

  it('reauthenticates persisted database-owner authority after an awaited canonical snapshot read', async () => {
    const f = await fixture(), bound = await boundAccount(f), read = f.state.store.readDatabaseRemoteAccess.bind(f.state.store)
    vi.spyOn(f.state.store, 'readDatabaseRemoteAccess').mockImplementationOnce(async (...args) => { const value = await read(...args); await deletePrincipal(f.database.db, bound.principal.id); return value })
    const response = await f.request('/accounts/' + bound.account.username + '/database-remote-access', { principalId: bound.principal.id })
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('native_provider_unavailable')
    expect(f.run).not.toHaveBeenCalled()
  })

  it('refuses a foreign hosting principal before reading remote host policy', async () => {
    const f = await fixture(), bound = await boundAccount(f)
    expect((await f.request('/accounts/' + bound.account.username + '/database-remote-access', { principalId: f.owner.id })).status).toBe(403)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('keeps native ingress activation unavailable even with a valid saved proxy policy', async () => {
    const f = await fixture()
    const read = await f.request('/host/trusted-proxies')
    expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ state: 'unavailable', active: null, activation: 'unavailable' })
    const { atomicWriteJson } = await import('@xpanel/state'), { join } = await import('node:path')
    const record = { version: 1, policy: { cidrs: ['203.0.113.0/24'], header: 'X-Forwarded-For' }, updatedAt: new Date().toISOString() }
    await atomicWriteJson(join(f.state.store.rootDir, 'extended/server/trusted-proxies.json'), record)
    const { trustedProxyRevision } = await import('../../../packages/core/src/trusted-proxies.ts')
    const response = await f.request('/host/trusted-proxies/apply', { method: 'POST', body: { expectedRevision: trustedProxyRevision(record), expectedActiveRevision: 'a'.repeat(64) } })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('denies non-root ingress and destination capability reads before native work', async () => {
    const f = await fixture()
    for (const path of ['/host/trusted-proxies', '/host/backups/destinations/capabilities']) expect((await f.request(path, { principalId: f.owner.id })).status).toBe(403)
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('does not fabricate backup destination proof when a remote transport is absent', async () => {
    const f = await fixture(), capabilities = await f.request('/host/backups/destinations/capabilities')
    expect(capabilities.status).toBe(200); expect(await capabilities.json()).toEqual({ available: false, profiles: [], nativeApplied: false })
    const response = await f.request('/host/backups/destinations/' + randomUUID() + '/test', { method: 'POST', body: { expectedTargetDigest: 'a'.repeat(64) } })
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false, nativeApplied: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })

  it('does not promote an RHEL profile into native repair authority', async () => {
    const f = await fixture({ os: profileFor('ID=almalinux\nVERSION_ID="9"\n') })
    const response = await f.request('/host/repair/diagnostics')
    expect(response.status).toBe(412); expect(await response.json()).toMatchObject({ details: { stateChanged: false } })
    expect(f.run).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
  })
})

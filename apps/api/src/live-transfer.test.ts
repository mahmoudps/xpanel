import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { buildReview, createTransferSession, transition } from '@xpanel/lifecycle'
import type { TransferEvent, TransferSession } from '@xpanel/lifecycle'
import { movedStatePath } from '../../agent/src/account-edge.ts'
import { handleTransferSourcePackageRoute, parsePackageRequest } from './acct-transfer-source.ts'
import { createTransferExecution } from './lifecycle-transfer-execution.ts'
import type { TransferExecutionDeps } from './lifecycle-transfer-execution.ts'
import { handleLiveSourceRoute, LIVE_CUTOVER_TTL, livePeerPath, movedZoneRecords } from './live-transfer.ts'
import { addFakeServer, createFakeNetwork, linkServers } from './node-peers-test-fixture.ts'
import type { FakeNetwork, FakeServer } from './node-peers-test-fixture.ts'
import { nodeOrigin, readNodeToken } from './node-link.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Feature layer: real routes and real state on both servers over the modelled pin. Only host agents are synthetic:
// they cannot prove a suspended site, a proxied request or a relayed message; the scope note says what a real pair must.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const SOURCE_IP = '203.0.113.5', DEST_IP = '192.0.2.10', SOURCE_HOST = 'source.example.com'
const PLAN = { name: 'gold', resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
  caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'jailed', defaultMailboxQuotaMb: 100 } as never
const PHP = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as never
let network: FakeNetwork, source: FakeServer, destination: FakeServer
let sourceTasks: Map<string, Record<string, unknown>>, packages: Record<string, unknown>[], applied: string[], suspensions: string[], drained: string[], queued: { drained: boolean; remaining: number | null }

const account = (store: FakeServer['store'], username: string, ipv4: string, planId: string) => store.createAccount({ username, passwordHash: HASH, primaryDomain: username + '.example.test', planId, ownerId: null, contactEmail: 'owner@example.test', ipv4, shell: 'jailed', php: PHP } as never)
const sourceAgent = async (_caller: AuthenticatedCaller, path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> => {
  if (path === '/transfers/tasks') {
    const id = randomUUID(), body = init.body as Record<string, unknown>
    packages.push(body)
    sourceTasks.set(id, { id, kind: 'package', username: body.username, state: 'succeeded', updatedAt: '2026-11-07T10:00:00.000Z', result: { artifacts: [{ name: 'home.tar.gz', bytes: 10, sha256: 'c'.repeat(64) }, { name: 'db-alice_wp.sql', bytes: 10, sha256: 'c'.repeat(64) }, { name: 'cert-0.pem', bytes: 10, sha256: 'c'.repeat(64) }], databases: [{ name: 'alice_wp', artifact: 'db-alice_wp.sql' }], certificates: [] } })
    return Response.json({ task: { id } }, { status: 202 })
  }
  if (init.method === 'DELETE') return Response.json({ discarded: true })
  return Response.json({ task: sourceTasks.get(path.split('/').at(-1)!) })
}

beforeEach(async () => {
  sourceTasks = new Map(); packages = []; applied = []; suspensions = []; drained = []; queued = { drained: true, remaining: 0 }
  network = createFakeNetwork()
  source = await addFakeServer(network, 'source', { routes: server => [
    (request, url, method) => handleLiveSourceRoute(request, url, method, { ...server.guards, store: server.store, link: server.link,
      setSuspension: async (_caller, target, verb, reason) => {
        suspensions.push(verb)
        if (verb === 'suspend') await server.store.suspendAccount(target.id, reason ?? 'x')
        else await server.store.unsuspendAccount(target.id, { allowLocked: true } as never)
      }, applyAccount: async (_caller, target) => { applied.push(target.username) },
      drainMail: async (_caller, domains) => { drained.push(...domains); return queued } }),
    (request, url, method) => handleTransferSourcePackageRoute(request, url, method, { ...server.guards, readSnapshot: async () => ({ ...await server.store.readSnapshot(), server: { settings: { hostname: SOURCE_HOST } } }) as never, readEdge: async () => ({}), agent: sourceAgent }),
  ] })
  destination = await addFakeServer(network, 'destination')
  await linkServers(destination, source)
  for (const [server, ip] of [[source, SOURCE_IP], [destination, DEST_IP]] as const) {
    const features = await server.store.createFeatureList({ name: 'default', ownerId: null, disabled: [] })
    await server.store.createPlan({ ...PLAN as object, name: 'gold', ownerId: null, featureListId: features.id } as never)
    await server.store.saveServerIp({ address: ip, version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  }
  const plan = (await source.store.listPlans())[0]!
  const alice = await account(source.store, 'alice', SOURCE_IP, plan.id)
  await source.store.createDatabase({ accountId: alice.id, name: 'alice_wp' })
  await source.store.saveDnsZone({ id: randomUUID(), accountId: alice.id, name: 'alice.example.test', serial: 2026110701, records: [
    { id: randomUUID(), zone: 'alice.example.test', name: '@', type: 'A', ttl: 14400, priority: null, content: SOURCE_IP },
    { id: randomUUID(), zone: 'alice.example.test', name: '@', type: 'MX', ttl: 14400, priority: 10, content: 'mail.alice.example.test.' },
    { id: randomUUID(), zone: 'alice.example.test', name: 'elsewhere', type: 'A', ttl: 14400, priority: null, content: '198.51.100.9' },
  ] } as never)
})
afterEach(() => network.close())

const session = async (live = true): Promise<TransferSession> => {
  const auth = await destination.link.transferAuth(source.link.selfId)
  let s = createTransferSession({ id: randomUUID(), actor: 'root', now: '2026-11-07T10:00:00.000Z', auth, live })
  s = transition(s, { type: 'connected', source: { hostname: SOURCE_HOST, version: '1.4.0' } }, '2026-11-07T10:00:01.000Z')
  s = transition(s, { type: 'inventory', accounts: [{ username: 'alice', uid: 20001, primaryDomain: 'alice.example.test', domains: ['alice.example.test'], plan: 'gold', diskBytes: 100, databases: ['alice_wp'], mailboxes: 0, phpVersions: ['8.3'] }], plans: [{ name: 'gold' }] }, '2026-11-07T10:00:02.000Z')
  s = transition(s, { type: 'select', accounts: ['alice'], plans: [], local: { usernames: [], domains: [], uids: [], plans: ['gold'] } }, '2026-11-07T10:00:03.000Z')
  s = transition(s, { type: 'review' }, '2026-11-07T10:00:04.000Z')
  return transition(s, { type: 'confirm', digest: s.reviewDigest! }, '2026-11-07T10:00:05.000Z')
}
const execution = (options: { failOn?: (body: Record<string, unknown>) => boolean; changed?: boolean; midway?: () => Promise<void> } = {}) => {
  const tasks = new Map<string, Record<string, unknown>>(), hostTasks: Record<string, unknown>[] = []
  const deps: TransferExecutionDeps = {
    store: destination.store, readToken: id => readNodeToken(destination.store, id), pollMs: 0, defaultPhp: async () => PHP, transport: network.transport,
    agent: async (_caller, path, init = {}) => {
      if (path === '/transfers/tasks') {
        const body = init.body as Record<string, unknown>, id = randomUUID(), failed = options.failOn?.(body) ?? false
        hostTasks.push(body)
        if (body.kind === 'fetch' && options.midway) await options.midway()
        tasks.set(id, { id, kind: body.kind, state: failed ? 'failed' : 'succeeded', error: failed ? 'synthetic failure' : null, result: body.kind === 'home-changes' ? { changed: options.changed ?? false } : { home: { compared: true }, databases: [], certificates: [] } })
        return Response.json({ task: { id } }, { status: 202 })
      }
      if (init.method === 'DELETE') return Response.json({ discarded: true })
      return Response.json({ task: tasks.get(path.split('/').at(-1)!) })
    },
    createAccount: async (_caller, input) => account(destination.store, input.username, DEST_IP, input.planId) as Promise<Account>,
    applyAccount: async () => undefined,
    removeAccount: async (_caller, target) => { await destination.store.deleteAccount((await destination.store.markTerminating(target.id)).id) },
    audit: async (_caller, action) => { destination.audits.push({ action }) },
  }
  return { hostTasks, execution: createTransferExecution(deps) }
}
const run = async (ports: ReturnType<typeof execution>, s: TransferSession) => {
  const events: TransferEvent[] = [], results: Record<string, Record<string, unknown>> = {}
  await ports.execution.run(destination.caller, s, buildReview(s), async (event, result) => { events.push(event); if (result) results[event.account] = result as Record<string, unknown> }, async () => false)
  return { events, results, phases: events.map(event => event.type === 'progress' ? event.phase : event.type) }
}
const zone = async () => (await source.store.getDnsZone('alice.example.test'))!
const movedFile = () => readFile(join(source.store.rootDir, movedStatePath(alice().id)), 'utf8')
let aliceAccount: Account
const alice = () => aliceAccount
beforeEach(async () => { aliceAccount = (await source.store.getAccountByUsername('alice'))! })

describe('live transfer', () => {
  it('copies, freezes, syncs the rest and cuts the account over', async () => {
    const ports = execution(), s = await session()
    const outcome = await run(ports, s)
    expect(outcome.phases).toEqual(['exporting', 'copying', 'importing', 'reconciling', 'syncing', 'cutover', 'done'])
    // the first copy runs against the live account; the second is the difference, taken while it is frozen
    expect(packages).toEqual([{ kind: 'package', username: 'alice', live: true }, { kind: 'package', username: 'alice', live: true, base: expect.any(String) }])
    expect(ports.hostTasks.map(task => task.kind)).toEqual(['fetch', 'restore', 'fetch', 'restore'])
    expect(ports.hostTasks[3]).toMatchObject({ incremental: true, certificates: [], databases: [{ artifact: 'db-alice_wp.sql', target: 'alice_wp' }] })
    expect((ports.hostTasks[2]!.artifacts as { name: string }[]).map(artifact => artifact.name)).toEqual(['home.tar.gz', 'db-alice_wp.sql'])
    // the acceptance: suspended source, service proxying on, its zone at the destination
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'suspended', suspendReason: 'Live transfer to ' + destination.hostname })
    expect(JSON.parse(await movedFile())).toMatchObject({ version: 1, ipv4: DEST_IP, hostname: destination.hostname })
    expect((await zone()).records.map(record => [record.name, record.type, record.content, record.ttl])).toEqual(expect.arrayContaining([['@', 'A', DEST_IP, LIVE_CUTOVER_TTL], ['elsewhere', 'A', '198.51.100.9', 14400]]))
    expect((await zone()).serial).toBeGreaterThan(2026110701)
    expect(await destination.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    expect(outcome.results.alice).toMatchObject({ rolledBack: false, createdAccountId: expect.any(String), live: { zones: 1, revertedAt: null } })
    expect(source.audits.map(entry => entry.action)).toEqual(expect.arrayContaining(['transfer.live.frozen', 'transfer.live.cutover']))
    expect(destination.audits.map(entry => entry.action)).toEqual(expect.arrayContaining(['transfer.account.frozen', 'transfer.account.synced', 'transfer.account.cutover']))
    expect(JSON.stringify([source.audits, destination.audits])).not.toContain('xp_')
    // both packages are removed from the source once they are used
    expect(applied).toContain('alice')
  })
  it('leaves an ordinary transfer untouched', async () => {
    const outcome = await run(execution(), await session(false))
    expect(outcome.phases).toEqual(['exporting', 'copying', 'importing', 'reconciling', 'done'])
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    expect(packages).toEqual([{ kind: 'package', username: 'alice' }])
  })
  it('flushes queued mail before the final sync, and releases the source when some stays', async () => {
    queued = { drained: false, remaining: 2 }
    const outcome = await run(execution(), await session())
    expect(outcome.phases.at(-1)).toBe('failed')
    expect(drained.length).toBeGreaterThan(0)
    expect(packages).toHaveLength(1)
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    expect(suspensions).toEqual(['suspend', 'unsuspend'])
  })
  it('releases the source and removes the copy when the final sync fails', async () => {
    let restores = 0
    const ports = execution({ failOn: body => body.kind === 'restore' && ++restores === 2 })
    const outcome = await run(ports, await session())
    expect(outcome.phases.at(-1)).toBe('failed')
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    await expect(movedFile()).rejects.toThrow()
    expect((await zone()).records.some(record => record.content === DEST_IP)).toBe(false)
    expect(await destination.store.getAccountByUsername('alice')).toBeNull()
    expect(suspensions).toEqual(['suspend', 'unsuspend'])
    expect(source.audits.map(entry => entry.action)).toContain('transfer.live.reverted')
  })
  it('refuses the cutover when the account changed during the first copy', async () => {
    let added = false
    const ports = execution({ midway: async () => {
      if (added) return
      added = true
      await source.store.saveCronJobs(alice().id, [{ id: randomUUID(), accountId: alice().id, schedule: '@daily', command: 'true', comment: 'added during the copy', enabled: true }] as never)
    } })
    const outcome = await run(ports, await session())
    const last = outcome.events.at(-1) as Extract<TransferEvent, { type: 'progress' }>
    expect(last).toMatchObject({ phase: 'failed', error: expect.stringContaining('changed on the source during the copy') })
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    expect(await destination.store.getAccountByUsername('alice')).toBeNull()
  })
  it('says so when the source cannot be released', async () => {
    const ports = execution({ failOn: body => { if (body.incremental !== true) return false; source.reachable = false; return true } })
    const outcome = await run(ports, await session())
    const last = outcome.events.at(-1) as Extract<TransferEvent, { type: 'progress' }>
    expect(last.error).toMatch(/could not be released; its account stays suspended/)
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'suspended' })
  })
  it('releases a frozen source after a restart, using what the run saved', async () => {
    const ports = execution(), s = await session()
    const frozen = await source.serve(new Request(nodeOrigin({ hostname: source.hostname, port: 2087 }) + livePeerPath('alice', 'freeze'), { method: 'POST', headers: { authorization: 'Bearer ' + (await readNodeToken(destination.store, source.link.selfId))!, 'content-type': 'application/json' }, body: JSON.stringify({ session: s.id }) }))
    expect(frozen.status).toBe(200)
    expect(await ports.execution.recover(destination.caller, s.progress.alice!, { liveFrozen: true }, s)).toBe(false)
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
  })
  it('takes a cut-over account back, and asks first when the copy changed', { tags: ['slow'] }, async () => {
    const ports = execution({ changed: true }), s = await session()
    const { results } = await run(ports, s)
    const refused = await ports.execution.revert!(destination.caller, s, 'alice', results.alice!, false).catch(error => error)
    expect(refused).toMatchObject({ code: 'CONFLICT', detail: { reason: 'post_cutover_writes' } })
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'suspended' })
    const live = await ports.execution.revert!(destination.caller, s, 'alice', results.alice!, true)
    expect(live.revertedAt).toEqual(expect.any(String))
    expect(await source.store.getAccountByUsername('alice')).toMatchObject({ status: 'active' })
    await expect(movedFile()).rejects.toThrow()
    expect((await zone()).records.find(record => record.name === '@' && record.type === 'A')).toMatchObject({ content: SOURCE_IP, ttl: 14400 })
    expect(await destination.store.getAccountByUsername('alice')).toBeNull()
    await expect(ports.execution.revert!(destination.caller, s, 'alice', { ...results.alice!, live: { ...results.alice!.live as object, revertedAt: 'x' } as never }, true)).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('needs a linked server as its source', async () => {
    const s = createTransferSession({ id: randomUUID(), actor: 'root', now: '2026-11-07T10:00:00.000Z', auth: { kind: 'api-token', url: 'https://source.example.test', tokenId: randomUUID(), tlsFingerprint: null }, live: true })
    await expect(createTransferExecution({ store: destination.store, readToken: async () => 'token' } as never).admit(destination.caller, s, { accounts: [], plans: [] } as never)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('lets one session hold an account, and accepts linked servers only', async () => {
    const token = (await readNodeToken(destination.store, source.link.selfId))!, post = (step: 'freeze' | 'cutover' | 'revert', body: unknown, bearer: string | null = token, username = 'alice') => source.serve(new Request(nodeOrigin({ hostname: source.hostname, port: 2087 }) + livePeerPath(username, step), { method: 'POST', headers: { ...(bearer ? { authorization: 'Bearer ' + bearer } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const first = randomUUID(), other = randomUUID()
    expect((await post('cutover', { session: first, ipv4: DEST_IP })).status).toBe(412)
    expect((await post('freeze', { session: first })).status).toBe(200)
    // mail waits from the moment the account is frozen, and no address means nothing is proxied yet
    expect(JSON.parse(await movedFile())).toMatchObject({ ipv4: null })
    expect(await (await post('freeze', { session: first })).json()).toMatchObject({ repeated: true })
    expect(((await (await post('freeze', { session: other })).json()) as { details: { reason: string } }).details.reason).toBe('live_transfer_running')
    expect((await post('cutover', { session: first, ipv4: '999.0.0.1' })).status).toBe(400)
    expect((await post('revert', { session: other })).status).toBe(409)
    expect((await post('freeze', { session: first }, null)).status).toBe(403)
    expect((await post('freeze', { session: first }, token, 'nobody')).status).toBe(404)
    expect(await (await post('revert', { session: first })).json()).toEqual({ reverted: true })
    expect(await (await post('revert', { session: first })).json()).toEqual({ reverted: false })
    await source.store.suspendAccount(alice().id, 'billing')
    expect(((await (await post('freeze', { session: first })).json()) as { details: { reason: string } }).details.reason).toBe('account_not_active')
  })
  it('moves source addresses only and accepts three package requests', () => {
    expect(movedZoneRecords([{ id: '1', zone: 'z', name: '@', type: 'A', ttl: 60, priority: null, content: '1.1.1.1' }, { id: '2', zone: 'z', name: '@', type: 'TXT', ttl: 60, priority: null, content: '1.1.1.1' }] as never, '1.1.1.1', '2.2.2.2').map(record => record.content)).toEqual(['2.2.2.2', '1.1.1.1'])
    const base = randomUUID()
    expect(parsePackageRequest('{}')).toEqual({})
    expect(parsePackageRequest('{"live":true}')).toEqual({ live: true })
    expect(parsePackageRequest(JSON.stringify({ live: true, base }))).toEqual({ live: true, base })
    for (const bad of ['', '[]', '{"live":false}', '{"base":"x"}', '{"live":true,"base":"../x"}']) expect(() => parsePackageRequest(bad)).toThrow(/exactly/)
    expect(() => fail('VALIDATION', 'x')).toThrow()
  })
})

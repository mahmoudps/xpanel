import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cronJobUnitId, cronWorkspaceRevision } from '@xpanel/core'
import { createRootPrincipal, createTestDb, createUserPrincipal } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import { AccountProcessServiceAdapter } from './services/account-process.ts'
import { agentCallerHeaders, createAgentApp } from './server.ts'

// Actual account/state/principal boundary with declared memory-only host/admission fixtures.
// No systemd, tenant DAC, scheduler qualification or completed execution is certified here.
const token = 'c'.repeat(64), hash = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const cleanups: Array<() => Promise<unknown>> = []
const fixture = async () => {
  const state = await createTestStateStore(); cleanups.push(() => state.close())
  const database = await createTestDb(); cleanups.push(() => database.close())
  const features = await state.store.createFeatureList({ name: 'Cron host fixture', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Cron host fixture', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
  await state.store.saveServerIp({ address: '192.0.2.55', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const account = await state.store.createAccount({ username: 'crona', passwordHash: hash, primaryDomain: 'crona.example.test', planId: plan.id, ownerId: null, contactEmail: 'owner@crona.example.test', ipv4: '192.0.2.55', shell: 'none', php: { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } })
  const principal = await createUserPrincipal(database.db, { username: account.username, accountId: account.id, passwordHash: hash })
  const root = await createRootPrincipal(database.db, { username: 'root', passwordHash: hash })
  const job = { id: randomUUID(), accountId: account.id, schedule: '@daily', command: '  printf "%s" "SYNTHETIC_PRIVATE_COMMAND"  ', comment: 'Fixture work', enabled: true, maxRuntimeSec: 300 }
  await state.store.saveCronJobs(account.id, [job])
  const executor = new FakeHostExecutor(), os = profileFor('ID=ubuntu\nVERSION_ID=24.04\n')
  const adapter = new AccountProcessServiceAdapter({ executor, os })
  await adapter.reconcileAccountCronJobs({ account, plan, jobs: [{ ...job, id: cronJobUnitId(job.id) }] })
  const reconciler = new HostReconciler({ store: state.store, db: database.db, executor, os })
  const admission = vi.fn(async () => {})
  const app = (qualified = true) => createAgentApp({ db: database.db, store: state.store, executor, reconciler, os, agentToken: token, ...(qualified ? { cronQualification: admission } : {}) })
  const revision = () => state.store.listCronJobs(account.id).then(jobs => cronWorkspaceRevision(account.id, jobs))
  const intent = async () => ({ accountId: account.id, jobId: job.id, expectedRevision: await revision() })
  const call = async (action = 'status', options: { qualified?: boolean; principalId?: string; body?: Record<string, unknown>; username?: string } = {}) => app(options.qualified !== false).fetch(new Request('http://agent.test/accounts/' + (options.username ?? account.username) + '/cron/' + job.id + '/' + action, { method: 'POST', headers: { ...agentCallerHeaders({ principalId: options.principalId ?? principal.id, token }), 'content-type': 'application/json' }, body: JSON.stringify(options.body ?? await intent()) }))
  const starts = () => executor.executedCommands.filter(argv => argv[1] === 'start')
  return { state, database, account, features, job, executor, principal, root, admission, intent, call, starts }
}

describe('cron guarded agent boundary', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeEach(async () => { f = await fixture() })
  afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

  it('fails closed without trusted local qualification before any host command', async () => {
    const before = f.executor.executedCommands.length
    expect((await f.call('run', { qualified: false })).status).toBe(412)
    expect(f.executor.executedCommands).toHaveLength(before); expect(f.starts()).toEqual([])
  })
  it('observes declared host state and requests only the canonical nonblocking unit without claiming completion', async () => {
    const before = (await f.state.store.readSnapshot()).revision
    const status = await f.call(), observed = await status.json() as Record<string, unknown>
    expect(status.status).toBe(200); expect(observed).toMatchObject({ context: { accountId: f.account.id, jobId: f.job.id }, observation: { lastResult: 'unknown', lastExitCode: null, serviceRunning: false } })
    const run = await f.call('run'); expect(run.status).toBe(202)
    expect(await run.json()).toMatchObject({ observation: { serviceRunning: true, lastResult: 'unknown', lastExitCode: null } })
    expect(f.starts()).toEqual([['/usr/bin/systemctl', 'start', '--no-block', 'xpanel-cron-crona-' + cronJobUnitId(f.job.id) + '.service']])
    expect(JSON.stringify(f.executor.executedCommands)).not.toContain('SYNTHETIC_PRIVATE_COMMAND')
    expect((await f.state.store.readSnapshot()).revision).toBe(before)
    expect((await f.call('run')).status).toBe(409); expect(f.starts()).toHaveLength(1)
  })
  it('refuses stale revisions, disabled jobs, request-selected identities and nonowners before starting', async () => {
    expect((await f.call('run', { body: { ...await f.intent(), expectedRevision: '0'.repeat(64) } })).status).toBe(409)
    expect((await f.call('run', { body: { ...await f.intent(), uid: 0 } })).status).toBe(422)
    expect((await f.call('run', { body: { ...await f.intent(), accountId: randomUUID() } })).status).toBe(422)
    expect((await f.call('run', { principalId: f.root.id })).status).toBe(403)
    expect((await f.call('run', { username: 'cronb' })).status).toBe(403)
    await f.state.store.saveCronJobs(f.account.id, [{ ...f.job, enabled: false }])
    expect((await f.call('run')).status).toBe(412); expect(f.starts()).toEqual([])
  })
  it('rechecks saved configuration and feature authority after acquiring its own account lease', async () => {
    const original = f.state.store.withCronAccountLease.bind(f.state.store)
    vi.spyOn(f.state.store, 'withCronAccountLease').mockImplementationOnce(async (accountId, operation) => {
      await f.state.store.updateFeatureList(f.features.id, { disabled: ['cron'] })
      return original(accountId, operation)
    })
    expect((await f.call('run')).status).toBe(403); expect(f.starts()).toEqual([])
  })
  it.each(['command', 'service', 'timer'])('refuses changed installed %s source even with fixture qualification', async kind => {
    const id = cronJobUnitId(f.job.id), path = kind === 'command' ? '/etc/xpanel/cron/crona/' + id + '.command' : '/etc/systemd/system/xpanel-cron-crona-' + id + '.' + kind
    f.executor.files.get(path)!.content += 'changed synthetic source'
    const response = await f.call('run'); expect(response.status).toBe(412)
    expect(await response.json()).toMatchObject({ details: { sourceConflict: true, stateChanged: false } })
    expect(f.starts()).toEqual([])
  })
})

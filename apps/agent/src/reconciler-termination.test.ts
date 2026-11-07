import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { suggestServerSettings } from '@xpanel/core'
import type { HostAction } from '@xpanel/core'
import { createTestDb, latestActive, type TestDbHandle } from '@xpanel/db'
import { profileFor } from '@xpanel/os'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import { FakeHostExecutor } from './executor.ts'
import { compileDesiredGeneration, HostReconciler } from './reconciler.ts'

const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const os = profileFor('ID=ubuntu\nVERSION_ID="24.04"\n')
const php = { version: '8.3', handler: 'fpm' as const, fpm: { mode: 'ondemand' as const, maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 500, processIdleTimeoutSec: 10 }, ini: {} }

/** Deleting the user is the point of no return of an account termination. */
describe('account termination point of no return', { tags: ['feature'] }, () => {
  let state: TestStateStoreHandle
  let db: TestDbHandle
  let executor: FakeHostExecutor
  beforeEach(async () => { state = await createTestStateStore(); db = await createTestDb(); executor = new FakeHostExecutor() })
  afterEach(async () => { vi.restoreAllMocks(); await state.close(); await db.close() })

  const seed = async () => {
    const store = state.store, suggested = suggestServerSettings({ cores: 2, memoryMb: 2048 })
    await store.saveServerSettings({ hostname: 'srv1.example.com', nameservers: ['ns1.example.com', 'ns2.example.com'], adminEmail: 'ops@example.com', engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
    const features = await store.createFeatureList({ name: 'Standard', ownerId: null, disabled: [] })
    const plan = await store.createPlan({ name: 'Pro', ownerId: null, featureListId: features.id, resources: { diskMb: 1024, bandwidthMbMonth: 1024, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 256, maxProcesses: 32, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 5, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 })
    await store.saveServerIp({ address: '203.0.113.10', version: 4, prefixLength: 24, interfaceName: 'eth0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: 'Termination fixture' })
    const create = (username: string) => store.createAccount({ username, passwordHash: ARGON2, primaryDomain: `${username}.example.com`, planId: plan.id, ownerId: null, contactEmail: `${username}@example.com`, ipv4: '203.0.113.10', shell: 'none', php })
    const alice = await create('alice'), bob = await create('bob')
    await store.saveDnsZone({ id: randomUUID(), accountId: alice.id, name: 'alice.example.com', serial: 2026110601, records: [{ id: randomUUID(), zone: 'alice.example.com', name: 'www', type: 'A', ttl: 300, content: '203.0.113.10', priority: null }] })
    await store.createDatabase({ accountId: alice.id, name: 'alice_app' })
    return { alice, bob }
  }
  const dns = () => {
    let failNext = false
    return { failNextVerify: () => { failNext = true }, provider: { validate: async () => {}, verify: async () => {
      if (failNext) { failNext = false; throw new Error('authoritative observation still answers the removed zone') }
    } } }
  }
  const reconcilerWith = (provider = dns().provider) => new HostReconciler({ store: state.store, db: db.db, executor, os, quotaFilesystem: '/home', dnsPublication: provider })
  const userDeletions = () => executor.executedActions.filter(action => action.kind === 'delete-user')
  const quotaClears = (user: string) => executor.executedActions.filter(action => action.kind === 'set-quota' && action.user === user && action.blockHardKb === 0)
  const drops = () => executor.sqlStatements.filter(entry => entry.statement.startsWith('DROP DATABASE IF EXISTS `alice_app`'))

  it('keeps quota, user, home and database removal out of the rollback-capable generation', async () => {
    const { alice } = await seed()
    await state.store.markTerminating(alice.id)
    const snapshot = await state.store.readSnapshot()
    const steps = (retirements?: ReadonlyMap<string, 'removing' | 'removed'>) => {
      const compiled = compileDesiredGeneration(snapshot, { os, quotaFilesystem: '/home', ...(retirements && { retirements }) })
      expect(compiled.postActions.some(action => action.kind === 'delete-user' || (action.kind === 'set-quota' && action.user === 'alice') || (action.kind === 'remove-path' && action.path === alice.home))).toBe(false)
      expect(compiled.postActions.some(action => action.kind === 'sql' && action.statements.some(statement => statement.includes('alice_app')))).toBe(false)
      return compiled.terminatingAccounts.map(entry => [entry.id, entry.userRemoved, entry.retire.map(step => step.step)])
    }
    expect(steps()).toEqual([[alice.id, false, ['quota', 'user', 'home', 'mariadb']]])
    // An unknown userdel outcome repeats userdel (idempotent for an absent user) but no longer clears its quota.
    expect(steps(new Map([[alice.id, 'removing']]))).toEqual([[alice.id, false, ['user', 'home', 'mariadb']]])
    expect(steps(new Map([[alice.id, 'removed']]))).toEqual([[alice.id, true, ['home', 'mariadb']]])
  })

  it('runs every observation before deleting the user, so a DNS observation failure rolls back while the user still exists', { tags: ['slow'] }, async () => {
    const { alice, bob } = await seed()
    const observer = dns()
    const reconciler = reconcilerWith(observer.provider)
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    await state.store.markTerminating(alice.id)
    observer.failNextVerify()
    const failed = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(failed).toMatchObject({ status: 'failed', rolledBack: true })
    expect(userDeletions()).toEqual([])
    expect(quotaClears('alice')).toEqual([])
    expect(drops()).toEqual([])
    expect(executor.users.has('alice')).toBe(true)
    expect(executor.files.has('/var/lib/powerdns/zones/alice.example.com.zone')).toBe(true)
    expect(await reconciler.journal.readActiveJournal()).toBeNull()
    expect((await state.store.getAccount(alice.id))?.status).toBe('terminating')
    expect(executor.users.has('bob')).toBe(true)
    expect(await state.store.getAccount(bob.id)).not.toBeNull()
  })

  it('never rolls back after userdel: reports the named step, keeps the account terminating and completes it without a second userdel', { tags: ['slow'] }, async () => {
    const { alice, bob } = await seed()
    const reconciler = reconcilerWith()
    expect((await reconciler.reconcile({ actor: 'root', mailAuth: null })).status).toBe('applied')
    await state.store.markTerminating(alice.id)
    const run = executor.runAction.bind(executor)
    let failHome = true
    vi.spyOn(executor, 'runAction').mockImplementation(async (action: HostAction) => {
      if (failHome && action.kind === 'remove-path' && action.path === alice.home) {
        failHome = false
        throw new Error('synthetic home removal failure')
      }
      return run(action)
    })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const partial = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(partial).toMatchObject({ status: 'applied', generation: { status: 'active' },
      incompleteRetirements: [{ accountId: alice.id, username: 'alice', userRemoved: true, failedStep: 'home' }] })
    expect(log).toHaveBeenCalledWith('xpanel-agent account retirement step failed:', 'alice', 'home', 'synthetic home removal failure')
    if (partial.status !== 'applied') throw new Error('termination generation was not applied')
    expect((await latestActive(db.db))?.id).toBe(partial.generation.id)
    expect(await reconciler.journal.readActiveJournal()).toBeNull()
    expect((await state.store.getAccount(alice.id))?.status).toBe('terminating')
    expect(await reconciler.journal.readRetirements([alice])).toEqual(new Map([[alice.id, 'removed']]))
    expect(executor.users.has('alice')).toBe(false)
    expect(executor.users.has('bob')).toBe(true)
    expect(executor.files.has('/var/lib/powerdns/zones/alice.example.com.zone')).toBe(false)
    expect(drops()).toEqual([])

    const completed = await reconciler.reconcile({ actor: 'root', mailAuth: null })
    expect(completed.status).toBe('applied')
    expect(completed).not.toHaveProperty('incompleteRetirements')
    expect(userDeletions()).toEqual([{ kind: 'delete-user', name: 'alice' }])
    expect(quotaClears('alice')).toHaveLength(1)
    expect(drops()).toHaveLength(1)
    expect(await state.store.getAccount(alice.id)).toBeNull()
    expect(await state.store.getAccount(bob.id)).not.toBeNull()
    expect(await reconciler.journal.readRetirements([alice])).toEqual(new Map())
  })

  it('fails closed on a retirement record that names another identity', async () => {
    const { alice } = await seed()
    const reconciler = reconcilerWith()
    await state.store.markTerminating(alice.id)
    await reconciler.journal.saveRetirement({ schemaVersion: 1, accountId: alice.id, username: 'alice', uid: alice.uid + 1, user: 'removed' })
    await expect(reconciler.reconcile({ actor: 'root', mailAuth: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(userDeletions()).toEqual([])
  })
})

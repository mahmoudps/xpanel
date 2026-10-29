import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, findPrincipalByAccountId } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { createLifecycleAccount } from './lifecycle-account-create.ts'
import type { LifecycleAccountPorts } from './lifecycle-account-create.ts'
import { parseZoneTemplate } from './acct-templates-workspace.ts'
import type { AuthenticatedCaller } from './auth.ts'

// Real StateStore and SQLite fixtures; the host apply is a synthetic port that only checks the revision.
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const
const root = { principal: { kind: 'root', id: 'r', username: 'root' }, sessionId: 's', apiTokenId: null } as unknown as AuthenticatedCaller
const open: Array<TestStateStoreHandle | TestDbHandle> = []
afterEach(async () => { for (const handle of open.splice(0)) await handle.close() })

const fixture = async (templates: unknown = null) => {
  const state = await createTestStateStore(), database = await createTestDb(); open.push(state, database)
  const features = await state.store.createFeatureList({ name: 'F', ownerId: null, disabled: [] })
  const plan = await state.store.createPlan({ name: 'Gold', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 } as never)
  await state.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' } as never)
  const applied: number[] = []
  const ports: LifecycleAccountPorts = {
    store: state.store, db: database.db, php, hashPassword: async () => HASH,
    readTemplates: async () => typeof templates === 'function' ? (templates as (planId: string) => unknown)(plan.id) : templates,
    applyConfiguration: async (_caller, _account, _action, expected) => { applied.push(expected); expect(await state.store.getRevision()).toBe(expected) },
  }
  return { state, database, plan, ports, applied }
}
const template = (planId: string) => [{ id: '66666666-6666-4666-8666-666666666666', name: 'Shop', records: parseZoneTemplate('shop 3600 CNAME www.%domain%.'), defaultPage: { title: 'a', body: 'b' }, suspendedPage: { title: 'a', body: 'b' }, planIds: [planId], updatedAt: '2026-10-28T00:00:00.000Z', updatedBy: 'root' }]

describe('lifecycle account creation', () => {
  it('creates the account with a closed panel login and applies the host at the next revision', async () => {
    const f = await fixture()
    const account = await createLifecycleAccount(root, { username: 'bob', primaryDomain: 'bob.example.test', planId: f.plan.id }, f.ports)
    expect(account).toMatchObject({ username: 'bob', primaryDomain: 'bob.example.test', ownerId: null, ipv4: '192.0.2.10' })
    expect(await findPrincipalByAccountId(f.database.db, account.id)).toMatchObject({ username: 'bob', forcePasswordChange: true })
    expect(await f.state.store.getDnsZone('bob.example.test')).toBeNull()
    expect(f.applied).toHaveLength(1)
  })
  it('adds the plan template zone in the same flow and applies after both writes', async () => {
    const f = await fixture(template)
    const account = await createLifecycleAccount(root, { username: 'bob', primaryDomain: 'bob.example.test', planId: f.plan.id }, f.ports)
    const zone = await f.state.store.getDnsZone('bob.example.test')
    expect(zone).toMatchObject({ accountId: account.id })
    expect(zone!.records).toContainEqual(expect.objectContaining({ name: 'shop', type: 'CNAME', content: 'www.bob.example.test.' }))
    expect(zone!.records.some(record => record.type === 'A' && record.content === '192.0.2.10')).toBe(true)
  })
  it('refuses before any state change on an unreadable templates file, a taken name or an existing zone', async () => {
    const broken = await fixture([{ id: 'x' }]), before = await broken.state.store.getRevision()
    await expect(createLifecycleAccount(root, { username: 'bob', primaryDomain: 'bob.example.test', planId: broken.plan.id }, broken.ports)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await broken.state.store.getRevision()).toBe(before)
    const f = await fixture(template)
    await f.state.store.saveDnsZone({ id: '77777777-7777-4777-8777-777777777777', name: 'bob.example.test', accountId: null, serial: 1, records: [] })
    await expect(createLifecycleAccount(root, { username: 'bob', primaryDomain: 'bob.example.test', planId: f.plan.id }, f.ports)).rejects.toMatchObject({ code: 'CONFLICT', detail: { stateChanged: false } })
    await createLifecycleAccount(root, { username: 'carol', primaryDomain: 'carol.example.test', planId: f.plan.id }, f.ports)
    await expect(createLifecycleAccount(root, { username: 'carol', primaryDomain: 'other.example.test', planId: f.plan.id }, f.ports)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(createLifecycleAccount({ principal: { kind: 'reseller' } } as never, { username: 'dave', primaryDomain: 'dave.example.test', planId: f.plan.id }, f.ports)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

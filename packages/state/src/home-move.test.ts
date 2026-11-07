import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const HASH = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 1, maxRequests: 50, processIdleTimeoutSec: 10 }, ini: {} } as const

const fixture = async () => {
  const handle = await createTestStateStore()
  fixtures.push(handle)
  const features = await handle.store.createFeatureList({ name: 'Move policy', ownerId: null, disabled: [] })
  const plan = await handle.store.createPlan({
    name: 'Move plan', ownerId: null, featureListId: features.id,
    resources: { diskMb: 1000, bandwidthMbMonth: 10000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 100, ioWriteIops: 100, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 },
    caps: { addonDomains: 5, aliasDomains: 5, subdomains: 5, mailboxes: 4, forwarders: 4, mailingLists: 5, ftpAccounts: 5, databases: 5, phpWorkers: 5 },
    dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100,
  })
  await handle.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, note: null } as never)
  const account = await handle.store.createAccount({ username: 'mover', passwordHash: HASH, primaryDomain: 'mover.example.test', planId: plan.id, ownerId: null, contactEmail: 'mover@example.test', ipv4: '192.0.2.10', shell: 'none', php })
  return { store: handle.store, account }
}

describe('Rearrange an Account in desired state', () => {
  it('holds the account while it moves, then gives it and its sites the new home', async () => {
    const { store, account } = await fixture()
    const moving = await store.beginHomeMove(account.id, '/home2/mover')
    expect(moving).toMatchObject({ status: 'suspended', home: '/home/mover', homeMove: { to: '/home2/mover', resumeStatus: 'active' } })
    await expect(store.beginHomeMove(account.id, '/home3/mover')).rejects.toMatchObject({ detail: { reason: 'account_busy' } })
    const moved = await store.finishHomeMove(account.id)
    expect(moved).toMatchObject({ status: 'active', suspendReason: null, home: '/home2/mover' })
    expect(moved.homeMove).toBeUndefined()
    expect((await store.listDomains({ accountId: account.id })).map(domain => domain.docRoot)).toEqual(['/home2/mover/public_html'])
    expect((await store.readSnapshot()).accounts.find(item => item.id === account.id)?.home).toBe('/home2/mover')
  })
  it('finishes a move whose sites were written before a crash', async () => {
    const { store, account } = await fixture()
    await store.beginHomeMove(account.id, '/home2/mover')
    const [site] = await store.listDomains({ accountId: account.id })
    await store.updateDomain(site!.id, { docRoot: '/home2/mover/public_html' })
    expect((await store.finishHomeMove(account.id)).home).toBe('/home2/mover')
    expect((await store.listDomains({ accountId: account.id }))[0]!.docRoot).toBe('/home2/mover/public_html')
  })
  it('returns a cancelled move to the state it left, and an admin suspension stays one', async () => {
    const { store, account } = await fixture()
    await store.suspendAccount(account.id, 'Unpaid')
    await store.beginHomeMove(account.id, '/home2/mover')
    const back = await store.cancelHomeMove(account.id)
    expect(back).toMatchObject({ status: 'suspended', suspendReason: 'Unpaid', home: '/home/mover' })
    expect(back.homeMove).toBeUndefined()
    expect((await store.listDomains({ accountId: account.id }))[0]!.docRoot).toBe('/home/mover/public_html')
  })
  it('takes only another home root', async () => {
    const { store, account } = await fixture()
    for (const to of ['/home/mover', '/srv/mover', '/home2/other', '/home100/mover']) await expect(store.beginHomeMove(account.id, to), to).rejects.toMatchObject({ detail: { reason: 'invalid_home_root' } })
  })
  it('turns the force HTTPS flag on and off in one write, never on an alias', async () => {
    const { store, account } = await fixture()
    const [primary] = await store.listDomains({ accountId: account.id })
    expect((await store.setDomainsForceHttps(account.id, [primary!.id], true))[0]!.forceHttps).toBe(true)
    expect((await store.listDomains({ accountId: account.id }))[0]!.forceHttps).toBe(true)
    expect((await store.setDomainsForceHttps(account.id, [primary!.id], false))[0]!.forceHttps).toBeUndefined()
  })
})

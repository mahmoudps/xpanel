import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestStateStore, StateStore, type TestStateStoreHandle } from './store.ts'
import type { NewAccount } from './types.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } as const
const fixture = async () => {
  const h = await createTestStateStore(); fixtures.push(h)
  const feature = await h.store.createFeatureList({ name: 'IP diagnostics', ownerId: null, disabled: [] })
  const plan = await h.store.createPlan({ name: 'IP diagnostics', ownerId: null, featureListId: feature.id, resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: true, shell: 'none', defaultMailboxQuotaMb: 128 })
  const shared = await h.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const dedicated = await h.store.saveServerIp({ address: '192.0.2.11', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const input = (username: string, over: Record<string, unknown> = {}): NewAccount => ({ username, primaryDomain: `${username}.example.test`, contactEmail: `admin@${username}.example.test`, planId: plan.id, ownerId: null, passwordHash: ARGON2, shell: 'none', php, ...over } as NewAccount)
  return { ...h, plan, shared, dedicated, input }
}

describe('account-as-IP-reservation state contract; diagnostic desired state, not host binding', () => {
  it('uses the persisted shared primary when address fields are omitted', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('sharedone'))
    expect(account.ipv4).toBe(f.shared.address)
    expect((await f.store.listServerIps()).find(ip => ip.id === f.shared.id)?.ownerKind).toBe('root')
  })
  it('allows only one primary shared address per family and refuses primary dedicated entries', async () => {
    const f = await fixture()
    await expect(f.store.saveServerIp({ ...f.shared, id: randomUUID(), address: '192.0.2.12' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.store.saveServerIp({ ...f.dedicated, isPrimary: true })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('refuses a root-supplied literal absent from pool before UID/account changes', async () => {
    const f = await fixture(), before = await f.store.readSnapshot()
    await expect(f.store.createAccount(f.input('unknownip', { ipv4: '192.0.2.99' }))).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const after = await f.store.readSnapshot(); expect(after.accounts).toEqual(before.accounts); expect(after.uidAllocator).toEqual(before.uidAllocator)
  })
  it('prevents two independent stores reserving the same dedicated address', async () => {
    const f = await fixture(), second = new StateStore(f.rootDir)
    const results = await Promise.allSettled([f.store.createAccount(f.input('dedicatedone', { ipv4: f.dedicated.address })), second.createAccount(f.input('dedicatedtwo', { ipv4: f.dedicated.address }))])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const denied = results.find(result => result.status === 'rejected') as PromiseRejectedResult
    expect(denied.reason.code).toBe('CONFLICT')
    expect((await f.store.listAccounts()).filter(account => account.ipv4 === f.dedicated.address)).toHaveLength(1)
  })
  it('refuses removing or reclassifying an in-use pool address', async () => {
    const f = await fixture(); await f.store.createAccount(f.input('boundone', { ipv4: f.dedicated.address }))
    await expect(f.store.deleteServerIp(f.dedicated.id)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.store.saveServerIp({ ...f.dedicated, role: 'shared' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
  it('retains a terminating dedicated reservation until qualified release exists', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('endingone', { ipv4: f.dedicated.address }))
    await f.store.markTerminating(account.id)
    await expect(f.store.deleteAccount(account.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.store.getAccount(account.id)).not.toBeNull()
  })
  it('does not release a dedicated address through an ordinary account IP edit', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('changeone', { ipv4: f.dedicated.address }))
    await expect(f.store.updateAccount(account.id, { ipv4: f.shared.address })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await f.store.getAccount(account.id))?.ipv4).toBe(f.dedicated.address)
  })
  it('selects dedicated inventory by mode and reports exhaustion without UID or principal effects', async () => {
    const f = await fixture(); let principalEffects = 0
    f.store.setHooks({ onCreateUserPrincipal: () => { principalEffects++ } })
    const first = await f.store.createAccount(f.input('autoone', { ipAssignment: { mode: 'dedicated', poolId: f.dedicated.id } }))
    expect(first.ipv4).toBe(f.dedicated.address)
    const before = await f.store.readSnapshot()
    await expect(f.store.createAccount(f.input('autotwo', { ipAssignment: { mode: 'dedicated' } }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'dedicated_ipv4_unavailable' } })
    expect((await f.store.readSnapshot()).uidAllocator).toEqual(before.uidAllocator); expect(principalEffects).toBe(1)
  })
  it('keeps suspended dedicated reservations and rejects plan downgrades that would lose entitlement', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('suspendedone', { ipAssignment: { mode: 'dedicated' } }))
    await f.store.suspendAccount(account.id, 'diagnostic hold')
    await expect(f.store.createAccount(f.input('suspendedtwo', { ipv4: f.dedicated.address }))).rejects.toMatchObject({ code: 'CONFLICT' })
    const sharedPlan = await f.store.createPlan({ ...f.plan, name: 'Shared diagnostics', dedicatedIp: false })
    await expect(f.store.changePlan(account.id, sharedPlan.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('cleans an uncommitted creation before retry while permanently burning its UID', async () => {
    const f = await fixture()
    f.store.setHooks({ onBeforeAccountCommit: () => { throw new Error('diagnostic before commit') } })
    await expect(f.store.createAccount(f.input('failureone', { ipAssignment: { mode: 'dedicated' } }))).rejects.toThrow('diagnostic before commit')
    expect(await f.store.listAccounts()).toEqual([])
    const burnt = (await f.store.readSnapshot()).uidAllocator
    f.store.setHooks({})
    const retry = await f.store.createAccount(f.input('failureone', { ipAssignment: { mode: 'dedicated' } }))
    expect(retry.ipv4).toBe(f.dedicated.address); expect((await f.store.readSnapshot()).uidAllocator).not.toEqual(burnt)
  })
  it('reads allocation preview without allocating a UID, reference, revision or fencing token', async () => {
    const f = await fixture(), authorityPath = f.store.getWriterLock().authorityFilePath, before = await readFile(authorityPath)
    const result = await f.store.readAccountIpAllocationOptions({ planId: f.plan.id, ownerId: null })
    expect(result.hostBinding).toBe('unverified'); expect(result.dedicated.count).toBe(1)
    expect(await readFile(authorityPath)).toEqual(before)
    const held = await f.store.getWriterLock().acquire(), authorityHeld = await readFile(authorityPath)
    try { await expect(f.store.readAccountIpAllocationOptions({ planId: f.plan.id, ownerId: null })).rejects.toMatchObject({ code: 'CONFLICT' }); expect(await readFile(authorityPath)).toEqual(authorityHeld) }
    finally { await held.release() }
  })
  it('validates raw pool files as a whole, including duplicate canonical IPv6 addresses', async () => {
    const f = await fixture(), path = join(f.rootDir, 'ip-pool.json')
    await writeFile(path, JSON.stringify([f.shared, { ...f.shared, id: randomUUID() }]))
    await expect(f.store.listServerIps()).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('does not remove entitlement in place while a dedicated account uses the plan', async () => {
    const f = await fixture(); await f.store.createAccount(f.input('planheld', { ipAssignment: { mode: 'dedicated' } }))
    await expect(f.store.updatePlan(f.plan.id, { dedicatedIp: false })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await f.store.getPlan(f.plan.id))?.dedicatedIp).toBe(true)
  })
  it('rejects global or foreign-domain mail claims against an existing dedicated reservation', async () => {
    const f = await fixture(), owner = await f.store.createAccount(f.input('mailowner', { ipAssignment: { mode: 'dedicated' } }))
    await f.store.createAccount(f.input('mailforeign'))
    const config = { mode: 'server-default', defaultIpv4: null, defaultIpv6: null, defaultHelo: null, domainOverrides: [] } as const
    await expect(f.store.saveMailIpConfig({ ...config, defaultIpv4: f.dedicated.address, domainOverrides: [] })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(f.store.saveMailIpConfig({ ...config, domainOverrides: [{ domainName: 'mailforeign.example.test', ipv4: f.dedicated.address, ipv6: null, heloHostname: null }] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await f.store.getMailIpConfig()).toBeNull(); expect((await f.store.getAccount(owner.id))?.ipv4).toBe(f.dedicated.address)
  })
  it('does not treat an absent pool entry as proof that account deletion releases no dedicated IP', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('lostinventory', { ipAssignment: { mode: 'dedicated' } }))
    await f.store.markTerminating(account.id)
    await writeFile(join(f.rootDir, 'ip-pool.json'), JSON.stringify([f.shared]))
    await expect(f.store.deleteAccount(account.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await f.store.getAccount(account.id)).not.toBeNull()
  })
  it('keeps a reseller delegation needed by an existing dedicated account', async () => {
    const f = await fixture(), reseller = await f.store.createReseller({ username: 'ipreseller', passwordHash: ARGON2, acl: ['create-account'], maxAccounts: 10, totalDiskMb: 102400, totalBandwidthMb: 102400, oversell: false, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [f.dedicated.address] })
    const account = await f.store.createAccount(f.input('resellerheld', { ownerId: reseller.id, ipAssignment: { mode: 'dedicated' } }))
    await expect(f.store.updateReseller(reseller.id, { delegatedIps: [] })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await f.store.getReseller(reseller.id))?.delegatedIps).toEqual([f.dedicated.address])
    expect((await f.store.getAccount(account.id))?.ipv4).toBe(f.dedicated.address)
  })
  it('allows the assigned domain to send through its own dedicated IP without freeing its reservation', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('ownmail', { ipAssignment: { mode: 'dedicated' } }))
    const config = { mode: 'custom-map' as const, defaultIpv4: null, defaultIpv6: null, defaultHelo: null,
      domainOverrides: [{ domainName: 'ownmail.example.test', ipv4: f.dedicated.address, ipv6: null, heloHostname: null }] }
    expect((await f.store.saveMailIpConfig(config)).domainOverrides).toEqual(config.domainOverrides)
    await expect(f.store.createAccount(f.input('othermail', { ipAssignment: { mode: 'dedicated' } }))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(f.store.changeOwner(account.id, randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    const domain = (await f.store.listDomains({ accountId: account.id }))[0]!
    await expect(f.store.updateDomain(domain.id, { ipv4: '192.0.2.99' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
  it('does not free a mail-only dedicated reservation or admit a literal outside inventory', async () => {
    const f = await fixture(), config = { mode: 'server-default' as const, defaultIpv4: f.dedicated.address, defaultIpv6: null, defaultHelo: null, domainOverrides: [] }
    await f.store.saveMailIpConfig(config)
    expect((await f.store.readAccountIpAllocationOptions({ planId: f.plan.id, ownerId: null })).dedicated.count).toBe(0)
    await expect(f.store.saveMailIpConfig({ ...config, defaultIpv4: null })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(f.store.saveMailIpConfig({ ...config, defaultIpv4: '192.0.2.99' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect((await f.store.getMailIpConfig())?.defaultIpv4).toBe(f.dedicated.address)
  })
  it.each((['clear-domain', 'delete-domain', 'delete-account'] as const).flatMap(operation => ['192.0.2.11', '192.0.2.99'].map(address => [operation, address] as const)))('retains a legacy orphan override during %s for %s until verified deprovisioning', async (operation, address) => {
      const f = await fixture(), account = await f.store.createAccount(f.input('legacyheld'))
      const { id: _id, ...primary } = (await f.store.listDomains({ accountId: account.id }))[0]!
      const addon = await f.store.createDomain({ ...primary, name: 'legacy.example.test', kind: 'addon', parentId: null, docRoot: `${account.home}/legacy` })
      const path = join(f.rootDir, 'accounts', account.username, 'domains', `${addon.name}.json`)
      await writeFile(path, JSON.stringify({ ...addon, ipv4: address }))
      if (operation === 'delete-account') await f.store.markTerminating(account.id)
      const mutation = operation === 'clear-domain' ? f.store.updateDomain(addon.id, { ipv4: null })
        : operation === 'delete-domain' ? f.store.deleteDomain(addon.id) : f.store.deleteAccount(account.id)
      await expect(mutation).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'ip_release_unverified' } })
      expect(JSON.parse(await readFile(path, 'utf8')).ipv4).toBe(address)
      expect(await f.store.getAccount(account.id)).not.toBeNull()
  })
  it('permits removing a domain override while its account keeps the dedicated reservation', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('retainedowner', { ipAssignment: { mode: 'dedicated' } }))
    const { id: _id, ...primary } = (await f.store.listDomains({ accountId: account.id }))[0]!
    const addon = await f.store.createDomain({ ...primary, name: 'retained.example.test', kind: 'addon', parentId: null, docRoot: `${account.home}/retained`, ipv4: f.dedicated.address })
    await f.store.updateDomain(addon.id, { ipv4: null })
    expect(await f.store.deleteDomain(addon.id)).toBe(true)
    expect((await f.store.getAccount(account.id))?.ipv4).toBe(f.dedicated.address)
    expect((await f.store.readAccountIpAllocationOptions({ planId: f.plan.id, ownerId: null })).dedicated.count).toBe(0)
  })
  it('checks every cascaded child reservation before removing the first domain file', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('cascadeheld'))
    const { id: _id, ...primary } = (await f.store.listDomains({ accountId: account.id }))[0]!
    const parent = await f.store.createDomain({ ...primary, name: 'parent.example.test', kind: 'addon', parentId: null, docRoot: `${account.home}/parent` })
    const child = await f.store.createDomain({ ...primary, name: 'child.parent.example.test', kind: 'subdomain', parentId: parent.id, docRoot: `${account.home}/child` })
    const childPath = join(f.rootDir, 'accounts', account.username, 'domains', `${child.name}.json`)
    await writeFile(childPath, JSON.stringify({ ...child, ipv4: '192.0.2.99' }))
    await expect(f.store.deleteDomain(parent.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await f.store.listDomains({ accountId: account.id })).map(domain => domain.id)).toEqual(expect.arrayContaining([parent.id, child.id]))
    expect(JSON.parse(await readFile(childPath, 'utf8')).ipv4).toBe('192.0.2.99')
  })
  it('keeps existing shared-only deletion behavior for canonical nonexclusive domain overrides', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('sharedlegacy'))
    const shared = await f.store.saveServerIp({ ...f.shared, id: randomUUID(), address: '192.0.2.12', isPrimary: false })
    const domain = (await f.store.listDomains({ accountId: account.id }))[0]!
    const path = join(f.rootDir, 'accounts', account.username, 'domains', `${domain.name}.json`)
    await writeFile(path, JSON.stringify({ ...domain, ipv4: shared.address }))
    await f.store.markTerminating(account.id)
    expect(await f.store.deleteAccount(account.id)).toBe(true)
    expect(await f.store.getAccount(account.id)).toBeNull()
  })
})

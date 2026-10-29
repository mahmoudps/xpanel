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
  const feature = await h.store.createFeatureList({ name: 'Bandwidth diagnostics', ownerId: null, disabled: [] })
  const plan = await h.store.createPlan({ name: 'Bandwidth diagnostics', ownerId: null, featureListId: feature.id, resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: true, shell: 'none', defaultMailboxQuotaMb: 128 })
  const shared = await h.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const dedicated = await h.store.saveServerIp({ address: '192.0.2.11', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'dedicated', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: false, notes: '' })
  const input = (username: string, over: Record<string, unknown> = {}): NewAccount => ({ username, primaryDomain: `${username}.example.test`, contactEmail: `admin@${username}.example.test`, planId: plan.id, ownerId: null, passwordHash: ARGON2, shell: 'none', php, ...over } as NewAccount)
  return { ...h, plan, shared, dedicated, input }
}

describe('enforced monthly bandwidth limit in desired state', () => {
  it('records and clears the limited month in one revision-bound mutation and keeps the plan switch', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('limitone'))
    const plan = await f.store.updatePlan(f.plan.id, { enforceBandwidth: true })
    expect(plan.enforceBandwidth).toBe(true)
    const before = await f.store.readSnapshot()
    await expect(f.store.setBandwidthLimits([{ accountId: account.id, month: '2026-10' }], { expectedRevision: (before.revision ?? 0) + 99 })).rejects.toMatchObject({ code: 'CONFLICT' })
    const [limited] = await f.store.setBandwidthLimits([{ accountId: account.id, month: '2026-10' }], { expectedRevision: before.revision! })
    expect(limited!.bandwidthLimitedMonth).toBe('2026-10')
    const snapshot = await f.store.readSnapshot()
    expect(snapshot.revision).toBeGreaterThan(before.revision!)
    expect(snapshot.accounts.find(entry => entry.id === account.id)?.bandwidthLimitedMonth).toBe('2026-10')
    expect(snapshot.plans.find(entry => entry.id === f.plan.id)?.enforceBandwidth).toBe(true)
    const [lifted] = await f.store.setBandwidthLimits([{ accountId: account.id, month: null }])
    expect(lifted).not.toHaveProperty('bandwidthLimitedMonth')
    await expect(f.store.setBandwidthLimits([{ accountId: account.id, month: '2026-13' }])).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.store.updatePlan(f.plan.id, { enforceBandwidth: 'yes' as unknown as boolean })).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

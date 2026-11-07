import { afterEach, describe, expect, it } from 'vitest'
import { effectivePlan } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from './store.ts'
import type { NewAccount } from './types.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } as const
const fixture = async () => {
  const h = await createTestStateStore(); fixtures.push(h)
  const feature = await h.store.createFeatureList({ name: 'Limits', ownerId: null, disabled: [] })
  const resources = { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }
  const caps = { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }
  const plan = await h.store.createPlan({ name: 'Limits', ownerId: null, featureListId: feature.id, resources, caps, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 128 })
  const other = await h.store.createPlan({ name: 'Other', ownerId: null, featureListId: feature.id, resources: { ...resources, bandwidthMbMonth: 20480 }, caps, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 128 })
  await h.store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const input = (username: string, over: Record<string, unknown> = {}): NewAccount => ({ username, primaryDomain: `${username}.example.test`, contactEmail: `admin@${username}.example.test`, planId: plan.id, ownerId: null, passwordHash: ARGON2, shell: 'none', php, ...over } as NewAccount)
  return { ...h, plan, other, input }
}

describe('per-account limit overrides in desired state', { tags: ['feature'] }, () => {
  it('merges overrides field by field, clears a field with null and keeps a valid snapshot', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('limits'))
    const set = await f.store.setAccountLimits(account.id, { resources: { bandwidthMbMonth: 1024, diskMb: 'unlimited' } })
    expect(set.limits).toEqual({ resources: { bandwidthMbMonth: 1024, diskMb: 'unlimited' } })
    const merged = await f.store.setAccountLimits(account.id, { resources: { diskMb: null }, caps: { databases: 5 } })
    expect(merged.limits).toEqual({ resources: { bandwidthMbMonth: 1024 }, caps: { databases: 5 } })
    expect(effectivePlan(f.plan, merged)).toMatchObject({ resources: { bandwidthMbMonth: 1024, diskMb: 1024 }, caps: { databases: 5 } })
    const cleared = await f.store.setAccountLimits(account.id, { resources: { bandwidthMbMonth: null }, caps: { databases: null } })
    expect(cleared).not.toHaveProperty('limits')
    await expect(f.store.setAccountLimits(account.id, { resources: { diskMb: 0 } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(f.store.setAccountLimits(account.id, { resources: { nope: 1 } } as never)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await f.store.readSnapshot()).accounts[0]).not.toHaveProperty('limits')
  })

  it('refuses a mailbox quota above the account disk quota with LIMIT_EXCEEDED', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('capped'))
    const limit = (await f.store.getPlan(account.planId))!.resources.diskMb as number
    await expect(f.store.createServiceUser({ accountId: account.id, login: 'big@capped.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: limit + 1, ftpDir: 'public_html', passwordHash: '{ARGON2ID}' + ARGON2 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('refuses a disk or PHP limit below what the account already uses, with a stable reason', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('quotas'))
    await f.store.createServiceUser({ accountId: account.id, login: 'mail@quotas.example.test', services: { email: true, ftp: false, webdisk: false }, mailboxQuotaMb: 512, ftpDir: 'public_html', passwordHash: '{ARGON2ID}' + ARGON2 })
    await expect(f.store.setAccountLimits(account.id, { resources: { diskMb: 256 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'disk_below_mailbox_quota', stateChanged: false } })
    await expect(f.store.setAccountLimits(account.id, { caps: { phpWorkers: 1 } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'limits_below_php_settings' } })
    expect((await f.store.setAccountLimits(account.id, { resources: { diskMb: 512 } })).limits).toEqual({ resources: { diskMb: 512 } })
    expect((await f.store.getAccount(account.id))?.limits).toEqual({ resources: { diskMb: 512 } })
  })

  it('keeps a reseller account within the reseller bandwidth total', async () => {
    const f = await fixture()
    const reseller = await f.store.createReseller({ username: 'limitseller', passwordHash: ARGON2, acl: ['create-account', 'edit-account'], maxAccounts: 10, totalDiskMb: 102400, totalBandwidthMb: 15000, oversell: { disk: false, bandwidth: false }, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [] })
    const account = await f.store.createAccount(f.input('owned', { ownerId: reseller.id }))
    await expect(f.store.setAccountLimits(account.id, { resources: { bandwidthMbMonth: 20000 } })).rejects.toMatchObject({ code: 'OVERSELL_BLOCKED' })
    expect((await f.store.setAccountLimits(account.id, { resources: { bandwidthMbMonth: 12000 } })).limits?.resources?.bandwidthMbMonth).toBe(12000)
  })

  it('resets only custom bandwidth limits to the package value and a plan change drops every override', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('reset'))
    await expect(f.store.resetBandwidthLimits([account.id])).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'bandwidth_limit_not_custom' } })
    await f.store.setAccountLimits(account.id, { resources: { bandwidthMbMonth: 'unlimited', diskMb: 2048 } })
    const [reset] = await f.store.resetBandwidthLimits([account.id])
    expect(reset!.limits).toEqual({ resources: { diskMb: 2048 } })
    expect(effectivePlan(f.plan, reset!).resources.bandwidthMbMonth).toBe(10240)
    await expect(f.store.resetBandwidthLimits([account.id, account.id])).rejects.toMatchObject({ code: 'VALIDATION' })
    const moved = await f.store.changePlan(account.id, f.other.id)
    expect(moved).not.toHaveProperty('limits')
    expect(moved.planId).toBe(f.other.id)
  })

  it('relieves only limited accounts through a UTC day and keeps log settings or server defaults', async () => {
    const f = await fixture(), account = await f.store.createAccount(f.input('relief'))
    await expect(f.store.relieveBandwidthLimits([account.id], '2026-11-06')).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'bandwidth_not_limited' } })
    await f.store.setBandwidthLimits([{ accountId: account.id, month: '2026-11' }])
    await expect(f.store.relieveBandwidthLimits([account.id], '2026-11-31')).rejects.toMatchObject({ code: 'VALIDATION' })
    const [relieved] = await f.store.relieveBandwidthLimits([account.id], '2026-11-06')
    expect(relieved).toMatchObject({ bandwidthReliefDate: '2026-11-06' })
    expect(relieved).not.toHaveProperty('bandwidthLimitedMonth')
    const logs = await f.store.setAccountLogSettings(account.id, { archive: true, removePreviousMonthArchive: false, retentionDays: 7 })
    expect(logs.logs).toEqual({ archive: true, removePreviousMonthArchive: false, retentionDays: 7 })
    await expect(f.store.setAccountLogSettings(account.id, { archive: true, removePreviousMonthArchive: false, retentionDays: 0 })).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(await f.store.setAccountLogSettings(account.id, null)).not.toHaveProperty('logs')
  })
})

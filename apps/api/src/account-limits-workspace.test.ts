import { afterEach, describe, expect, it, vi } from 'vitest'
import { fail } from '@xpanel/core'
import type { Account, Plan, Principal } from '@xpanel/core'
import { createTestStateStore, type TestStateStoreHandle } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { changeAccountPackageLimit, handleAccountLimitsRoute, isPackageLimitPatch, type AccountLimitsPorts, type PackageChangePorts } from './account-limits-workspace.ts'

const fixtures: TestStateStoreHandle[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
const ARGON2 = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'
const php = { version: '8.3', handler: 'fpm', fpm: { mode: 'ondemand', maxChildren: 2, startServers: 1, minSpareServers: 1, maxSpareServers: 2, maxRequests: 100, processIdleTimeoutSec: 10 }, ini: {} } as const

async function setup() {
  const h = await createTestStateStore(); fixtures.push(h)
  const store = h.store
  const feature = await store.createFeatureList({ name: 'Limits', ownerId: null, disabled: [] })
  const plan = await store.createPlan({ name: 'Limits', ownerId: null, featureListId: feature.id, resources: { diskMb: 1024, bandwidthMbMonth: 10240, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 2, aliasDomains: 2, subdomains: 2, mailboxes: 2, forwarders: 2, mailingLists: 2, ftpAccounts: 2, databases: 2, phpWorkers: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 128 })
  await store.saveServerIp({ address: '192.0.2.10', version: 4, prefixLength: 24, interfaceName: 'test0', role: 'shared', ownerKind: 'root', ownerId: null, ptrHostname: null, isPrimary: true, notes: '' })
  const reseller = await store.createReseller({ username: 'seller', passwordHash: ARGON2, acl: ['create-account', 'edit-account'], maxAccounts: 5, totalDiskMb: 102400, totalBandwidthMb: 15000, oversell: { disk: false, bandwidth: false }, nameservers: ['ns1.example.test', 'ns2.example.test'], delegatedIps: [] })
  const create = (username: string, ownerId: string | null) => store.createAccount({ username, primaryDomain: `${username}.example.test`, contactEmail: `admin@${username}.example.test`, planId: plan.id, ownerId, passwordHash: ARGON2, shell: 'none', php } as never)
  const rooted = await create('rooted', null), owned = await create('owned', reseller.id)
  const root = { principal: { kind: 'root', id: 'root-id', username: 'root' } } as unknown as AuthenticatedCaller
  const seller = { principal: { kind: 'reseller', id: reseller.id, username: 'seller' } } as unknown as AuthenticatedCaller
  let caller = root
  const applyAccountConfiguration = vi.fn(async () => ({ status: 'applied' }))
  const emitAudit = vi.fn(async () => undefined)
  const ports: AccountLimitsPorts = {
    store, requireCaller: async () => caller, readJsonBody: async request => await request.json() as Record<string, unknown>,
    resolveAccountParam: async id => await store.getAccount(id) ?? fail('NOT_FOUND', 'account not found'),
    assertCanAccessAccount: async (who, account) => { if (who.principal.kind === 'reseller' && account.ownerId !== who.principal.id) fail('NOT_FOUND', 'account not found') },
    assertRoot: async who => { if (who.principal.kind !== 'root') fail('FORBIDDEN', 'root role is required for this operation') },
    resolveReseller: async who => who.principal.kind === 'reseller' ? store.getReseller(who.principal.id) : null,
    captureAccountMutation: async (_who, id) => ({ account: (await store.getAccount(id))!, expectedRevision: await store.getRevision() }),
    requireHostAgent: () => undefined, applyAccountConfiguration, emitAudit, execution: () => ({ status: 'configuration_applied' }), now: () => new Date('2026-11-06T10:00:00.000Z'),
    readDisk: async () => ({ observedAt: '2026-11-06T10:00:00.000Z', filesystems: { state: 'unavailable', inodes: 'unavailable', items: [], reason: 'filesystems-unavailable' },
      accounts: { state: 'read', source: 'repquota', mount: '/home', items: [{ username: 'rooted', usedBytes: 300 * 1048576, limitBytes: null }, { username: 'owned', usedBytes: null, limitBytes: null }] } }),
  }
  const route = (path: string, method: string, body?: unknown) => { const url = new URL('http://whm.test' + path); return handleAccountLimitsRoute(new Request(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), url, method, ports) }
  const call = async (path: string, method: string, body?: unknown) => await (await route(path, method, body))!.json() as Record<string, any>
  return { store, plan, rooted, owned, reseller, route, call, applyAccountConfiguration, emitAudit, as: (who: 'root' | 'seller') => { caller = who === 'root' ? root : seller } }
}

describe('account limit overrides and bandwidth relief routes', { tags: ['feature'] }, () => {
  it('saves one account override, applies it through the host reconcile and reports the effective limits', async () => {
    const t = await setup()
    const body = await t.call(`/api/accounts/${t.rooted.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 1024, diskMb: 'unlimited' } })
    expect(body.account.limits).toEqual({ resources: { bandwidthMbMonth: 1024, diskMb: 'unlimited' } })
    expect(body.effective.resources).toMatchObject({ bandwidthMbMonth: 1024, diskMb: 'unlimited', memoryMb: 128 })
    expect(t.applyAccountConfiguration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: t.rooted.id }), 'limits', expect.any(Number))
    expect(t.emitAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'account.limits.updated', target: 'account:rooted' }), { accountId: t.rooted.id, resellerId: null })
    expect((await t.call(`/api/accounts/${t.rooted.id}/limits`, 'PATCH', { resources: { diskMb: null } })).account.limits).toEqual({ resources: { bandwidthMbMonth: 1024 } })
    for (const bad of [{}, { resources: {} }, { resources: { bandwidthMbMonth: -1 } }, { quota: 1 }]) await expect(t.route(`/api/accounts/${t.rooted.id}/limits`, 'PATCH', bad)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect((await t.route(`/api/accounts/${t.rooted.id}/limits`, 'GET'))!.status).toBe(405)
  })

  it('keeps a reseller to its own accounts, its totals and its unlimited privilege', async () => {
    const t = await setup()
    t.as('seller')
    await expect(t.route(`/api/accounts/${t.rooted.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 100 } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(t.route(`/api/accounts/${t.owned.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 'unlimited' } })).rejects.toMatchObject({ code: 'FORBIDDEN', detail: { acl: 'allow-unlimited-plans' } })
    await expect(t.route(`/api/accounts/${t.owned.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 20000 } })).rejects.toMatchObject({ code: 'OVERSELL_BLOCKED' })
    expect((await t.call(`/api/accounts/${t.owned.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 12000 } })).account.limits).toEqual({ resources: { bandwidthMbMonth: 12000 } })
    await expect(t.route('/api/accounts/bandwidth/custom', 'GET')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('lists only custom bandwidth limits, resets them to the package value and relieves limited accounts until 00:00 UTC', async () => {
    const t = await setup()
    expect((await t.call('/api/accounts/bandwidth/custom', 'GET')).accounts).toEqual([])
    await t.call(`/api/accounts/${t.rooted.id}/limits`, 'PATCH', { resources: { bandwidthMbMonth: 'unlimited' } })
    expect((await t.call('/api/accounts/bandwidth/custom', 'GET')).accounts).toEqual([expect.objectContaining({ username: 'rooted', packageLimitMb: 10240, customLimitMb: 'unlimited' })])
    const reset = await t.call('/api/accounts/bandwidth/reset', 'POST', { accounts: [t.rooted.id] })
    expect(reset).toMatchObject({ enforcement: 'next_collection', accounts: [expect.not.objectContaining({ limits: expect.anything() })] })
    expect((await t.call('/api/accounts/bandwidth/custom', 'GET')).accounts).toEqual([])
    await expect(t.route('/api/accounts/bandwidth/reset', 'POST', { accounts: [t.rooted.id] })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'bandwidth_limit_not_custom' } })
    await t.store.setBandwidthLimits([{ accountId: t.owned.id, month: '2026-11' }])
    t.applyAccountConfiguration.mockClear()
    const relief = await t.call('/api/accounts/bandwidth/relief', 'POST', { accounts: [t.owned.id] })
    expect(relief).toMatchObject({ reliefThrough: '2026-11-06', accounts: [expect.objectContaining({ username: 'owned', bandwidthReliefDate: '2026-11-06' })] })
    expect((await t.store.getAccount(t.owned.id)) as Account).not.toHaveProperty('bandwidthLimitedMonth')
    expect(t.applyAccountConfiguration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: t.owned.id }), 'bandwidth_relief', expect.any(Number))
    await expect(t.route('/api/accounts/bandwidth/relief', 'POST', { accounts: [t.owned.id] })).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'bandwidth_not_limited' } })
    for (const bad of [{}, { accounts: [] }, { accounts: ['x'] }, { accounts: [t.owned.id, t.owned.id] }, { accounts: [t.owned.id], all: true }])
      await expect(t.route('/api/accounts/bandwidth/relief', 'POST', bad)).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('pages the WHM Quota Modification table on the server with the limit in force and its source', async () => {
    const t = await setup()
    await t.call(`/api/accounts/${t.owned.id}/limits`, 'PATCH', { resources: { diskMb: 4096 } })
    const all = await t.call('/api/accounts/disk-quotas?sort=limit&dir=desc', 'GET')
    expect(all).toMatchObject({ total: 2, page: 1, pageSize: 25, sort: 'limit', dir: 'desc', usage: { state: 'read', reason: null } })
    expect(all.rows.map((row: { username: string; limitMb: unknown; source: string; usedMb: unknown; owner: unknown }) => [row.username, row.limitMb, row.source, row.usedMb, row.owner])).toEqual([['owned', 4096, 'account', null, 'seller'], ['rooted', 1024, 'package', 300, 'root']])
    expect((await t.call('/api/accounts/disk-quotas?q=root', 'GET')).rows.map((row: { username: string }) => row.username)).toEqual(['rooted'])
    expect((await t.call('/api/accounts/disk-quotas?owner=root', 'GET')).total).toBe(1)
    const paged = await t.call('/api/accounts/disk-quotas?pageSize=10&page=9', 'GET')
    expect(paged).toMatchObject({ page: 1, total: 2 })
    for (const bad of ['?sort=uid', '?dir=up', '?pageSize=7', '?page=0', '?owner=x', '?q=a&q=b', '?extra=1']) await expect(t.route('/api/accounts/disk-quotas' + bad, 'GET')).rejects.toMatchObject({ code: 'VALIDATION' })
    t.as('seller')
    const own = await t.call('/api/accounts/disk-quotas', 'GET')
    expect(own.rows.map((row: { username: string }) => row.username)).toEqual(['owned'])
    expect(own.usage).toEqual({ state: 'unavailable', observedAt: null, reason: 'usage_root_only' })
    expect((await t.route('/api/accounts/disk-quotas', 'POST'))!.status).toBe(405)
  })
})

describe('a limit that diverges from the assigned package', () => {
  const plan = { id: 'p1', name: 'basic', ownerId: null, featureListId: 'f', resources: { diskMb: 10 }, caps: { addonDomains: 1, subdomains: 2 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 1 } as unknown as Plan
  const account = { id: 'a1', username: 'user1', planId: 'p1' } as unknown as Account
  const ports = (plans: Plan[] = [plan]) => {
    const calls: unknown[][] = [], root = { kind: 'root', id: 'r', username: 'root' } as Principal
    return { calls, ports: { principal: root, changePlan: async (id: string) => { calls.push(['changePlan', id]); return { moved: id } }, reconcileAll: async () => { calls.push(['reconcileAll']); return null },
      saveLimits: async (patch: unknown) => { calls.push(['setAccountLimits', 'a1', patch]); return account }, assertUnlimitedAllowed: async () => { calls.push(['assertUnlimitedAllowed']) }, audit: async (action: string, saved: Plan) => { calls.push(['audit', action, saved.id]) },
      store: { getPlan: async () => plan, listPlans: async () => plans, createPlan: async (input: Omit<Plan, 'id'>) => { calls.push(['createPlan', input.name, input.caps.addonDomains]); return { ...input, id: 'p2' } },
        updatePlan: async (id: string, patch: unknown) => { calls.push(['updatePlan', id, patch]); return plan } } } as unknown as PackageChangePorts }
  }
  it('lists the five resolutions and changes nothing without one', async () => {
    const f = ports()
    await expect(changeAccountPackageLimit(account, { maxaddon: 3 }, f.ports)).rejects.toMatchObject({ code: 'CONFLICT', detail: { resolutions: ['switch', 'create', 'update', 'detach', 'keep'], stateChanged: false } })
    expect(f.calls).toEqual([])
    expect(await changeAccountPackageLimit(account, { maxaddon: 1 }, f.ports)).toEqual({ account, stateChanged: false })
  })
  it('creates <package>_<user>, moves only this account and refuses what the product cannot do', async () => {
    const f = ports()
    expect(await changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'create' }, f.ports)).toEqual({ moved: 'p2' })
    expect(f.calls).toEqual([['createPlan', 'basic_user1', 3], ['audit', 'plan.created', 'p2'], ['changePlan', 'p2']])
    await expect(changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'detach' }, f.ports)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { reason: 'package_required' } })
    await expect(changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'switch' }, f.ports)).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'no_matching_package' } })
    await expect(changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'other' }, f.ports)).rejects.toMatchObject({ code: 'VALIDATION' })
  })
  it('switches to a matching package, updates the package, or keeps an account limit', async () => {
    const twin = { ...plan, id: 'p3', caps: { addonDomains: 3, subdomains: 2 } } as unknown as Plan, f = ports([plan, twin])
    expect(await changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'switch' }, f.ports)).toEqual({ moved: 'p3' })
    await changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'update' }, f.ports)
    await changeAccountPackageLimit(account, { maxaddon: 3, resolution: 'keep' }, f.ports)
    expect(f.calls.slice(1)).toEqual([['updatePlan', 'p1', { caps: { addonDomains: 3, subdomains: 2 } }], ['reconcileAll'], ['audit', 'plan.updated', 'p1'], ['setAccountLimits', 'a1', { caps: { addonDomains: 3 } }]])
  })
  it('takes every WHM limit name and every package field, with resources and caps together', async () => {
    const full = { ...plan, resources: { diskMb: 10, bandwidthMbMonth: 20, memoryMb: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 2, mailboxes: 3, mailingLists: 4, ftpAccounts: 5, databases: 6, phpWorkers: 7 } } as unknown as Plan
    const f = ports()
    ;(f.ports.store as { getPlan: unknown }).getPlan = async () => full
    await changeAccountPackageLimit(account, { maxpark: 2, maxsub: 3, maxpop: 'unlimited', maxlst: 5, maxftp: 6, maxsql: 7, phpWorkers: 8, quota: 11, bwlimit: 'unlimited', memoryMb: 128, resolution: 'keep' }, f.ports)
    expect(f.calls).toEqual([['assertUnlimitedAllowed'], ['setAccountLimits', 'a1', { resources: { diskMb: 11, bandwidthMbMonth: 'unlimited', memoryMb: 128 }, caps: { aliasDomains: 2, subdomains: 3, mailboxes: 'unlimited', mailingLists: 5, ftpAccounts: 6, databases: 7, phpWorkers: 8 } }]])
    await expect(changeAccountPackageLimit(account, { quota: 11 }, f.ports)).rejects.toMatchObject({ code: 'CONFLICT', detail: { reason: 'package_conflict' } })
    expect(await changeAccountPackageLimit(account, { quota: 10, maxsub: 2 }, f.ports)).toEqual({ account, stateChanged: false })
  })
  it('builds a derived package from what the account has and keeps other accounts out of its overrides', async () => {
    const own = { ...account, limits: { caps: { subdomains: 9 } } } as unknown as Account, f = ports(), created: unknown[] = []
    ;(f.ports.store as { createPlan: unknown }).createPlan = async (input: Plan) => { created.push(input); return { ...input, id: 'p2' } }
    await changeAccountPackageLimit(own, { quota: 11, resolution: 'create' }, f.ports)
    expect(created).toMatchObject([{ resources: { diskMb: 11 }, caps: { addonDomains: 1, subdomains: 9 } }])
    f.calls.length = 0
    await changeAccountPackageLimit(own, { quota: 11, resolution: 'update' }, f.ports)
    expect(f.calls[0]).toEqual(['updatePlan', 'p1', { resources: { diskMb: 11 } }])
  })
  it('drops an override when the value is the package value, and refuses a wrong field or value', async () => {
    const own = { ...account, limits: { caps: { addonDomains: 5 } } } as unknown as Account, f = ports()
    await changeAccountPackageLimit(own, { maxaddon: 1 }, f.ports)
    expect(f.calls).toEqual([['setAccountLimits', 'a1', { caps: { addonDomains: null } }]])
    for (const body of [{ maxaddon: 1, contactEmail: 'a@example.test' }, { maxaddon: '3' }, { maxaddon: null }])
      await expect(changeAccountPackageLimit(account, body, f.ports)).rejects.toMatchObject({ code: 'VALIDATION', detail: { stateChanged: false } })
    await expect(changeAccountPackageLimit(account, { quota: -1, resolution: 'keep' }, f.ports)).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(isPackageLimitPatch({ contactEmail: 'a@example.test', shell: 'none' })).toBe(false)
    expect(isPackageLimitPatch({ bwlimit: 1 })).toBe(true)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createDatabaseRemoteAccessNative, databaseRemoteAccessRevision, handleDatabaseRemoteAccessRoute } from './database-remote-access.ts'
import type { DatabaseRemoteAccessRouteDeps, DatabaseRemoteAccessSnapshot, DatabaseRemoteAccessTransaction, DatabaseRemoteAccessView } from './database-remote-access.ts'
import type { Plan } from '@xpanel/core'
import type { MariadbPrivilege } from '../../../packages/render/src/services/mariadb.ts'
const id = '11111111-1111-4111-8111-111111111111', principalId = '22222222-2222-4222-8222-222222222222', createdAt = '2026-10-27T00:00:00.000Z'
function setup() {
  let snapshot: DatabaseRemoteAccessSnapshot = { account: { id, username: 'alice', createdAt, status: 'active', planId: principalId, databaseRemoteAccess: [], uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', ownerId: null, suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.1', ipv6: null, shell: 'none' }, databases: [], users: [] }
  const plan: Plan = { id: principalId, name: 'Remote fixture', ownerId: null, featureListId: id, resources: { diskMb: 1000, bandwidthMbMonth: 1000, ioReadBps: 1048576, ioWriteBps: 1048576, ioReadIops: 10, ioWriteIops: 10, memoryMb: 128, maxProcesses: 16, cpuPercent: 100 }, caps: { addonDomains: 1, aliasDomains: 1, subdomains: 1, mailboxes: 1, forwarders: 1, mailingLists: 1, ftpAccounts: 1, databases: 2, phpWorkers: 1 }, dedicatedIp: false, shell: 'none', defaultMailboxQuotaMb: 100 }
  let disabled: string[] = [], afterCallbackFailure = false
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
  const events: string[] = []
  const native = { qualified: true as const, inspect: vi.fn(async () => true), apply: vi.fn(async () => { events.push('apply') }), verify: vi.fn(async () => true), recovery: { prepare: vi.fn(async () => { events.push('prepare'); return { fixture: true } }), restore: vi.fn(async () => { events.push('restore') }), verifyRestored: vi.fn(async () => true), committed: vi.fn(async () => { events.push('committed') }) } }
  const store = { getAccountByUsername: vi.fn(async () => clone(snapshot.account)), getPlan: vi.fn(async () => plan), getFeatureList: vi.fn(async () => ({ id, name: 'Remote fixture features', ownerId: null, disabled })), readDatabaseRemoteAccess: vi.fn(async () => clone(snapshot)),
    withDatabaseRemoteAccessLease: async <T>(_accountId: string, _revision: string, run: (snapshot: DatabaseRemoteAccessSnapshot, tx: DatabaseRemoteAccessTransaction) => Promise<T>): Promise<T> => {
      const before = clone(snapshot); let restore: (() => Promise<void>) | undefined
      try {
        const result = await run(clone(snapshot), { onAbort: operation => { restore = operation }, commit: async entries => { events.push('commit'); snapshot = { ...snapshot, account: { ...snapshot.account, databaseRemoteAccess: clone(entries) } } } })
        if (afterCallbackFailure) throw new Error('synthetic authority commit failure')
        return result
      } catch (error) { if (restore) await restore(); snapshot = before; throw error }
    },
  }
  vi.spyOn(store, 'withDatabaseRemoteAccessLease')
  const currentPrincipal = vi.fn(async () => ({ id: principalId, kind: 'user', username: 'alice', accountId: id, disabled: false }))
  const deps: DatabaseRemoteAccessRouteDeps = { caller: { role: 'user', accountId: id, principalId, actor: 'alice', resellerId: null }, store, currentPrincipal, native, audit: vi.fn(async () => undefined), now: () => new Date(createdAt) }
  const send = (body?: unknown, path = '/accounts/alice/database-remote-access') => { const url = new URL('http://agent.test' + path); return handleDatabaseRemoteAccessRoute(new Request(url, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }), url, body ? 'POST' : 'GET', deps) }
  const add = () => send({ action: 'add', expectedRevision: databaseRemoteAccessRevision(snapshot), host: '192.0.2.7', comment: 'Office' })
  return { deps, store, native, events, send, add, currentPrincipal, snapshot: () => snapshot, disable: () => { disabled = ['remote-database-access'] }, failAuthority: () => { afterCallbackFailure = true } }
}
describe('account remote database transaction', () => {
  it('reads saved policy with explicit unavailable proof and refuses native-absent changes', async () => {
    const ctx = setup(); delete ctx.deps.native
    const view = await (await ctx.send())!.json() as DatabaseRemoteAccessView
    expect(view.capability).toEqual({ canChange: false, reason: 'native_provider_unavailable' })
    expect(view.application.nativeQualified).toBe(false)
    await expect(ctx.add()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(ctx.store.withDatabaseRemoteAccessLease).not.toHaveBeenCalled()
  })
  it('records recovery before effects, commits only after native readback and finalizes after state authority', async () => {
    const ctx = setup(), response = await ctx.add(), view = await response!.json() as DatabaseRemoteAccessView
    expect(ctx.events).toEqual(['prepare', 'apply', 'commit', 'committed'])
    expect(view.entries[0]).toMatchObject({ host: '192.0.2.7', firewall: 'verified', grants: 'verified' })
    expect(JSON.stringify(view)).not.toMatch(/authPlugin|authString|passwordHash/)
  })
  it('rechecks owner identity, disabled feature, account and selectors before provider work', async () => {
    for (const kind of ['principal', 'feature', 'neighbor', 'selector'] as const) {
      const ctx = setup()
      if (kind === 'principal') ctx.currentPrincipal.mockResolvedValue({ id, kind: 'user', username: 'alice', accountId: id, disabled: false })
      if (kind === 'feature') ctx.disable()
      await expect(kind === 'neighbor' ? ctx.send(undefined, '/accounts/bob/database-remote-access') : kind === 'selector' ? ctx.send(undefined, '/accounts/alice/database-remote-access?accountId=' + id) : ctx.add()).rejects.toMatchObject({ code: kind === 'selector' ? 'VALIDATION' : 'FORBIDDEN' })
      expect(ctx.native.apply).not.toHaveBeenCalled()
    }
  })
  it('refuses stale CAS and does not run recovery or native apply', async () => {
    const ctx = setup()
    await expect(ctx.send({ action: 'add', expectedRevision: 'f'.repeat(64), host: '192.0.2.7', comment: '' })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(ctx.native.recovery.prepare).not.toHaveBeenCalled(); expect(ctx.native.apply).not.toHaveBeenCalled()
  })
  it('detects revocation during recovery preparation before any native effect and invokes compensation under the transaction', async () => {
    const ctx = setup()
    ctx.native.recovery.prepare.mockImplementationOnce(async () => { ctx.currentPrincipal.mockResolvedValue({ id: principalId, kind: 'user', username: 'alice', accountId: id, disabled: true }); return { fixture: true } })
    await expect(ctx.add()).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(ctx.native.apply).not.toHaveBeenCalled(); expect(ctx.native.recovery.restore).toHaveBeenCalledOnce()
    expect(ctx.snapshot().account.databaseRemoteAccess).toEqual([])
  })
  it('does not expose failed native inspection or recovery details and starts no effect', async () => {
    for (const kind of ['inspect', 'prepare'] as const) {
      const ctx = setup()
      if (kind === 'inspect') ctx.native.inspect.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'))
      else ctx.native.recovery.prepare.mockRejectedValue(new Error('PRIVATE_PROVIDER_DETAIL'))
      await expect(ctx.add()).rejects.toMatchObject({ code: kind === 'inspect' ? 'PRECONDITION_FAILED' : 'SERVICE_UNAVAILABLE', detail: { stateChanged: false } })
      expect(ctx.native.apply).not.toHaveBeenCalled()
    }
  })
  it('compensates failed native readback and a failure after callback completion without finalizing recovery', async () => {
    for (const failure of ['readback', 'authority'] as const) {
      const ctx = setup()
      if (failure === 'readback') ctx.native.verify.mockResolvedValue(false); else ctx.failAuthority()
      await expect(ctx.add()).rejects.toThrow()
      expect(ctx.native.recovery.restore).toHaveBeenCalledOnce(); expect(ctx.native.recovery.verifyRestored).toHaveBeenCalledOnce()
      expect(ctx.native.recovery.committed).not.toHaveBeenCalled(); expect(ctx.snapshot().account.databaseRemoteAccess).toEqual([])
    }
  })
  it('uses existing protected MariaDB adapter with saved names and reauthorizes before each effect', async () => {
    const ctx = setup(), dbId = '33333333-3333-4333-8333-333333333333'
    const snapshot: DatabaseRemoteAccessSnapshot = { ...ctx.snapshot(), databases: [{ id: dbId, accountId: id, name: 'alice_shop', engine: 'mariadb', trashedAt: null }], users: [{ id: principalId, accountId: id, name: 'alice_app', authPlugin: 'mysql_native_password', authString: '*' + 'A'.repeat(40), grants: [{ databaseId: dbId, privileges: ['SELECT'] }] }] }
    const mariadb = { query: vi.fn(async (_statements: readonly string[]) => 'localhost\n'), inspectUserGrants: vi.fn(async () => ({ hasGlobalGrant: false, databaseGrants: new Map([['alice\\_shop', ['SELECT'] as MariadbPrivilege[]]]) })), createUser: vi.fn(async () => undefined), dropUser: vi.fn(async () => undefined), reconcileUserGrants: vi.fn(async () => ({} as Awaited<ReturnType<import('./services/mariadb.ts').MariaDbServiceAdapter['reconcileUserGrants']>>)) }
    const firewall = { apply: vi.fn(async () => undefined), verify: vi.fn(async () => true) }
    const native = createDatabaseRemoteAccessNative({ mariadb, firewall, recovery: ctx.native.recovery, qualification: { sqlAndFirewallRecoveryVerified: true } })
    expect(await native.inspect(snapshot)).toBe(true)
    expect(mariadb.query.mock.calls[0]?.[0]).toEqual(["SELECT Host FROM mysql.user WHERE User = 'alice_app' ORDER BY Host LIMIT 102"])
    const authorize = vi.fn(async () => undefined)
    await native.apply(snapshot, [{ host: '192.0.2.0/24', comment: '', createdAt }], authorize)
    expect(mariadb.createUser).toHaveBeenCalledWith('alice_app', 'alice', ['192.0.2.0/255.255.255.0'], { plugin: 'mysql_native_password', hash: '*' + 'A'.repeat(40) })
    expect(authorize).toHaveBeenCalledTimes(4)
    authorize.mockRejectedValue(new Error('revoked')); mariadb.createUser.mockClear()
    await expect(native.apply(snapshot, [{ host: '192.0.2.7', comment: '', createdAt }], authorize)).rejects.toThrow('revoked')
    expect(mariadb.createUser).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { databaseRemoteAccessRevision } from './database-remote-access.ts'
import type { DatabaseRemoteAccessEntry, DatabaseRemoteAccessSnapshot } from './database-remote-access.ts'
import { createDatabaseRemoteAccessFirewall, createDatabaseRemoteAccessJournalRecovery, databaseUserRemoteSqlHosts, databaseUserSqlHosts, parseNftRemoteSet, pendingDatabaseRemoteAccessJournals, qualifyDatabaseRemoteAccessNative } from './db-remote-provider.ts'
import type { RemoteAccessAccountEntries, RemoteRecoveryFs } from './db-remote-provider.ts'
import { isDatabaseRemoteCommand } from '../../../packages/os/src/db-remote-command.ts'

const id = '11111111-1111-4111-8111-111111111111', other = '33333333-3333-4333-8333-333333333333', createdAt = '2026-10-27T00:00:00.000Z', dir = '/var/lib/xpanel/remote-access-recovery'
const entry = (host: string): DatabaseRemoteAccessEntry => ({ host, comment: '', createdAt })
const snapshot = (entries: DatabaseRemoteAccessEntry[] = []): DatabaseRemoteAccessSnapshot => ({
  account: { id, username: 'alice', createdAt, status: 'active', planId: other, databaseRemoteAccess: entries, uid: 1001, gid: 1001, home: '/home/alice', primaryDomain: 'alice.example.test', ownerId: null, suspendReason: null, contactEmail: 'owner@alice.example.test', ipv4: '192.0.2.1', ipv6: null, shell: 'none' },
  databases: [{ id: '44444444-4444-4444-8444-444444444444', accountId: id, name: 'alice_app', engine: 'mariadb', createdAt, trashedAt: null }],
  users: [{ id: '55555555-5555-4555-8555-555555555555', accountId: id, name: 'alice_app', grants: [{ databaseId: '44444444-4444-4444-8444-444444444444', privileges: ['ALL PRIVILEGES'] }], createdAt, authPlugin: 'mysql_native_password', authString: '*' + 'A'.repeat(40) }],
} as unknown as DatabaseRemoteAccessSnapshot)

/** Simulated kernel sets fed by the reviewed replacement argv. */
function kernel(initial: { v4?: string[]; v6?: string[] } | null = { v4: [], v6: [] }) {
  let sets = initial
  const run = vi.fn(async (argv: readonly string[]) => {
    if (!isDatabaseRemoteCommand(argv)) throw new Error('unreviewed argv')
    if (argv.length === 2) {
      if (!sets) return { ok: false, code: 1, stdout: '', stderr: 'No such file or directory' }
      const groups = [...argv[1]!.matchAll(/add element inet xpanel xpanel_dbremote([46]) \{ ([^}]+) \}/g)]
      sets = { v4: groups.find(g => g[1] === '4')?.[2]!.split(', ') ?? [], v6: groups.find(g => g[1] === '6')?.[2]!.split(', ') ?? [] }
      return { ok: true, code: 0, stdout: '', stderr: '' }
    }
    const family = argv.at(-1) === 'xpanel_dbremote4' ? 4 : 6
    if (!sets) return { ok: false, code: 1, stdout: '', stderr: 'Error: No such file or directory' }
    const items = family === 4 ? sets.v4! : sets.v6!
    const elem = items.map(item => item.includes('/') ? { prefix: { addr: item.split('/')[0], len: Number(item.split('/')[1]) } } : item)
    return { ok: true, code: 0, stdout: JSON.stringify({ nftables: [{ metainfo: { json_schema_version: 1 } }, { set: { family: 'inet', name: 'xpanel_dbremote' + family, table: 'xpanel', type: family === 4 ? 'ipv4_addr' : 'ipv6_addr', handle: 3, flags: ['interval'], ...(elem.length ? { elem } : {}) } }] }), stderr: '' }
  })
  return { run, sets: () => sets }
}
function memoryFs(uid = 0, mode = 0o40700) {
  const files = new Map<string, string>(), events: string[] = []
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const fs: RemoteRecoveryFs = {
    lstat: async path => { if (path === dir) return { isDirectory: () => true, isSymbolicLink: () => false, uid, mode }; if (files.has(path)) return { isDirectory: () => false, isSymbolicLink: () => false, uid: 0, mode: 0o100600 }; throw missing() },
    writeSynced: async (path, data) => { events.push('write+fsync ' + path.slice(dir.length + 1)); files.set(path, data) },
    rename: async (from, to) => { events.push('rename'); files.set(to, files.get(from)!); files.delete(from) },
    unlink: async path => { if (!files.delete(path)) throw missing(); events.push('unlink') },
    syncDirectory: async () => { events.push('fsync dir') },
    readdir: async () => [...files.keys()].map(path => path.slice(dir.length + 1)),
    readFile: async path => { const text = files.get(path); if (text === undefined) throw missing(); return text },
  }
  return { fs, files, events }
}
const adapter = () => ({ query: vi.fn(async () => '1\n'), inspectUserGrants: vi.fn(), createUser: vi.fn(async () => undefined), dropUser: vi.fn(async () => undefined), reconcileUserGrants: vi.fn(async () => ({}) as never) })
const inventory = (alice: string[], neighbour: string[] = ['198.51.100.0/24'], neighbourStatus: RemoteAccessAccountEntries['status'] = 'active'): RemoteAccessAccountEntries[] =>
  [{ accountId: id, status: 'active', entries: alice.map(entry) }, { accountId: other, status: neighbourStatus, entries: neighbour.map(entry) }]

describe('remote database firewall provider', () => {
  it('replaces the target account inside the active-account union and preserves neighbours', async () => {
    const k = kernel(), firewall = createDatabaseRemoteAccessFirewall({ run: k.run, readAllEntries: async () => inventory(['192.0.2.7']) })
    await firewall.apply(snapshot().account, [entry('203.0.113.0/24'), entry('2001:db8::7')])
    expect(k.sets()).toEqual({ v4: ['198.51.100.0/24', '203.0.113.0/24'], v6: ['2001:db8::7'] })
    expect(await firewall.verify(snapshot().account, [entry('203.0.113.0/24'), entry('2001:db8::7')])).toBe(true)
    expect(await firewall.verify(snapshot().account, [entry('192.0.2.7')])).toBe(false)
  })
  it('excludes suspended neighbours and a suspended target', async () => {
    const k = kernel(), firewall = createDatabaseRemoteAccessFirewall({ run: k.run, readAllEntries: async () => inventory([], ['198.51.100.0/24'], 'suspended') })
    await firewall.apply({ ...snapshot().account, status: 'suspended' }, [entry('192.0.2.7')])
    expect(k.sets()).toEqual({ v4: [], v6: [] })
  })
  it('never verifies a missing renderer set or a foreign set object', async () => {
    const k = kernel(null), firewall = createDatabaseRemoteAccessFirewall({ run: k.run, readAllEntries: async () => inventory([]) })
    expect(await firewall.verify(snapshot().account, [])).toBe(false)
    expect(() => parseNftRemoteSet(JSON.stringify({ nftables: [{ set: { family: 'inet', table: 'xpanel', name: 'xpanel_banned', type: 'ipv4_addr', flags: ['interval'] } }] }), 4)).toThrow()
  })
  it('compares auto-merged kernel intervals, ranges and element wrappers exactly', () => {
    const json = JSON.stringify({ nftables: [{ set: { family: 'inet', table: 'xpanel', name: 'xpanel_dbremote4', type: 'ipv4_addr', flags: ['interval'], elem: [{ range: ['192.0.2.0', '192.0.2.255'] }, { elem: { val: '198.51.100.7', comment: 'x' } }] } }] })
    expect(parseNftRemoteSet(json, 4)).toEqual([[3221225984n, 3221226239n], [3325256711n, 3325256711n]])
    expect(() => parseNftRemoteSet(json, 6)).toThrow()
  })
})

describe('remote database recovery journal', () => {
  const setup = (live = true) => {
    const k = kernel(), memory = memoryFs(), mariadb = adapter(), all = { value: inventory([]) }
    const firewall = createDatabaseRemoteAccessFirewall({ run: k.run, readAllEntries: async () => all.value })
    const verify = vi.fn(async () => true), inspect = vi.fn(async () => live)
    const recovery = createDatabaseRemoteAccessJournalRecovery({ fs: memory.fs, dir, mariadb, firewall, inspect, verify })
    return { k, memory, mariadb, recovery, verify, inspect }
  }
  it('captures a verified preimage durably before returning: temp write+fsync, rename, directory fsync', async () => {
    const ctx = setup(), checkpoint = await ctx.recovery.prepare(snapshot(), [entry('192.0.2.7')])
    expect(checkpoint).toEqual({ accountId: id })
    expect(ctx.memory.events).toEqual(['write+fsync ' + id + '.json.tmp', 'rename', 'fsync dir'])
    const journal = JSON.parse(ctx.memory.files.get(dir + '/' + id + '.json')!)
    expect(journal).toMatchObject({ format: 'xpanel.remote-database-recovery', beforeRevision: databaseRemoteAccessRevision(snapshot()), after: [entry('192.0.2.7')] })
    expect(journal.before.users[0].authString).toBe('*' + 'A'.repeat(40))
    await expect(ctx.recovery.prepare(snapshot(), [])).rejects.toThrow('remote_database_recovery_pending')
  })
  it('refuses an unverified live preimage or an unsafe directory without writing', async () => {
    const ctx = setup(false)
    await expect(ctx.recovery.prepare(snapshot(), [entry('192.0.2.7')])).rejects.toThrow('remote_database_preimage_unverified')
    for (const [uid, mode] of [[1000, 0o40700], [0, 0o40755]] as const) {
      const memory = memoryFs(uid, mode), recovery = createDatabaseRemoteAccessJournalRecovery({ fs: memory.fs, dir, mariadb: adapter(), firewall: { apply: vi.fn(), verify: vi.fn() }, inspect: async () => true, verify: async () => true })
      await expect(recovery.prepare(snapshot(), [])).rejects.toThrow('remote_database_journal_directory_unsafe')
      expect(memory.files.size).toBe(0)
    }
    expect(ctx.memory.files.size).toBe(0)
  })
  it('restores SQL hosts, auth, grants and firewall to the preimage, then clears the journal once verified', async () => {
    const ctx = setup(), before = snapshot([entry('203.0.113.9')])
    const checkpoint = await ctx.recovery.prepare(before, [entry('192.0.2.0/24')])
    await ctx.recovery.restore(checkpoint)
    expect(ctx.mariadb.dropUser).toHaveBeenCalledWith('alice_app', 'alice', ['192.0.2.0/255.255.255.0'])
    expect(ctx.mariadb.createUser).toHaveBeenCalledWith('alice_app', 'alice', ['203.0.113.9'], { plugin: 'mysql_native_password', hash: '*' + 'A'.repeat(40) })
    expect(ctx.mariadb.reconcileUserGrants).toHaveBeenCalledWith({ user: 'alice_app', username: 'alice', host: '203.0.113.9', desiredGrants: [{ database: 'alice_app', privileges: ['ALL PRIVILEGES'] }] })
    expect(ctx.k.sets()).toEqual({ v4: ['198.51.100.0/24', '203.0.113.9'], v6: [] })
    ctx.verify.mockResolvedValueOnce(false)
    expect(await ctx.recovery.verifyRestored(checkpoint)).toBe(false); expect(ctx.memory.files.size).toBe(1)
    expect(await ctx.recovery.verifyRestored(checkpoint)).toBe(true); expect(ctx.memory.files.size).toBe(0)
  })
  it('commits by removing the journal durably and rejects a tampered journal', async () => {
    const ctx = setup(), checkpoint = await ctx.recovery.prepare(snapshot(), [entry('192.0.2.7')])
    const path = dir + '/' + id + '.json', journal = JSON.parse(ctx.memory.files.get(path)!)
    ctx.memory.files.set(path, JSON.stringify({ ...journal, after: [entry('0.0.0.0/1')] }))
    await expect(ctx.recovery.restore(checkpoint)).rejects.toThrow('invalid_remote_database_journal')
    await ctx.recovery.committed(checkpoint)
    expect(ctx.memory.files.size).toBe(0); expect(ctx.memory.events.slice(-2)).toEqual(['unlink', 'fsync dir'])
    await expect(ctx.recovery.restore({ accountId: '../etc' })).rejects.toThrow('invalid_remote_database_checkpoint')
  })
  it('startup recovery restores before-state, finalizes committed state and keeps drifted journals for review', async () => {
    for (const [current, expected] of [['before', 'restored'], ['after', 'committed'], ['drift', 'review']] as const) {
      const ctx = setup(), before = snapshot()
      await ctx.recovery.prepare(before, [entry('192.0.2.7')])
      ctx.memory.files.set(dir + '/' + other + '.json.tmp', '{')
      const state = current === 'before' ? before : current === 'after' ? snapshot([entry('192.0.2.7')]) : snapshot([entry('203.0.113.1')])
      const report = await ctx.recovery.pending(async () => state)
      expect(report).toEqual([{ accountId: id, outcome: expected }, { accountId: other, outcome: 'discarded' }])
      expect(ctx.memory.files.has(dir + '/' + id + '.json')).toBe(expected === 'review')
      expect(ctx.mariadb.createUser).not.toHaveBeenCalled()
    }
  })
})

describe('remote database native qualification', () => {
  it('returns null without renderer sets, a safe journal directory or a reachable admin client', async () => {
    expect(await qualifyDatabaseRemoteAccessNative({ mariadb: adapter(), run: kernel(null).run, readAllEntries: async () => [], fs: memoryFs().fs, journalDir: dir })).toBeNull()
    expect(await qualifyDatabaseRemoteAccessNative({ mariadb: adapter(), run: kernel().run, readAllEntries: async () => [], fs: memoryFs(0, 0o40777).fs, journalDir: dir })).toBeNull()
    const down = adapter(); down.query.mockRejectedValue(new Error('PRIVATE'))
    expect(await qualifyDatabaseRemoteAccessNative({ mariadb: down, run: kernel().run, readAllEntries: async () => [], fs: memoryFs().fs, journalDir: dir })).toBeNull()
  })
  it('wires the journal recovery into the qualified native provider', async () => {
    const memory = memoryFs(), native = await qualifyDatabaseRemoteAccessNative({ mariadb: adapter(), run: kernel().run, readAllEntries: async () => inventory([]), fs: memory.fs, journalDir: dir })
    expect(native?.qualified).toBe(true)
    expect(await native!.recovery.pending(async () => snapshot())).toEqual([])
    expect(await pendingDatabaseRemoteAccessJournals(dir, memory.fs)).toBe(0)
  })
})

describe('remote database lifecycle propagation', () => {
  it('gives active accounts localhost plus every saved remote SQL host and suspended accounts localhost only', () => {
    const account = snapshot([entry('192.0.2.0/24'), entry('2001:db8::7')]).account
    expect(databaseUserSqlHosts(account)).toEqual(['localhost', '192.0.2.0/255.255.255.0', '2001:db8::7'])
    expect(databaseUserSqlHosts({ ...account, status: 'suspended' })).toEqual(['localhost'])
    expect(databaseUserRemoteSqlHosts({ ...account, status: 'terminating' } as never)).toEqual(['192.0.2.0/255.255.255.0', '2001:db8::7'])
    expect(databaseUserSqlHosts({ status: 'active' })).toEqual(['localhost'])
  })
})

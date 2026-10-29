import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, rename, unlink } from 'node:fs/promises'
import { databaseRemoteAccessRevision, databaseRemoteHost, parseCidr, parseDatabaseRemoteEntries, parseIp } from '@xpanel/core'
import type { Account, DatabaseUser } from '@xpanel/core'
import { createDatabaseRemoteAccessNative } from './database-remote-access.ts'
import type { DatabaseRemoteAccessEntry, DatabaseRemoteAccessFirewall, DatabaseRemoteAccessNative, DatabaseRemoteAccessRecovery, DatabaseRemoteAccessSnapshot } from './database-remote-access.ts'
import type { MariaDbServiceAdapter } from './services/mariadb.ts'
import { DB_REMOTE_MAX_ELEMENTS, DB_REMOTE_SET_V4, DB_REMOTE_SET_V6, DB_REMOTE_TABLE, canonicalDbRemoteSources, dbRemoteListArgv, dbRemoteReplaceArgv } from '../../../packages/os/src/db-remote-command.ts'
import type { DbRemoteFamily } from '../../../packages/os/src/db-remote-command.ts'

export const DATABASE_REMOTE_ACCESS_JOURNAL_DIR = '/var/lib/xpanel/remote-access-recovery'
export type RemoteAccessRun = (argv: readonly string[]) => Promise<{ ok: boolean; code: number | null; stdout: string; stderr: string }>
export type RemoteAccessAdapter = Pick<MariaDbServiceAdapter, 'query' | 'inspectUserGrants' | 'createUser' | 'dropUser' | 'reconcileUserGrants'>
export interface RemoteAccessAccountEntries { accountId: string; status: Account['status']; entries: readonly DatabaseRemoteAccessEntry[] }
export interface RemoteRecoveryStat { isDirectory(): boolean; isSymbolicLink(): boolean; uid: number; mode: number }
/** Injected file primitives; the production implementation is nodeRecoveryFs. */
export interface RemoteRecoveryFs {
  lstat(path: string): Promise<RemoteRecoveryStat>
  /** Create or truncate without following a symlink, mode 0600, write everything, fsync, close. */
  writeSynced(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  syncDirectory(path: string): Promise<void>
  readdir(path: string): Promise<string[]>
  readFile(path: string): Promise<string>
}
export const nodeRecoveryFs: RemoteRecoveryFs = {
  lstat: path => lstat(path),
  async writeSynced(path, data) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600)
    try { await handle.writeFile(data, 'utf8'); await handle.sync() } finally { await handle.close() }
  },
  rename: (from, to) => rename(from, to),
  unlink: path => unlink(path),
  async syncDirectory(path) { const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await handle.sync() } finally { await handle.close() } },
  readdir: path => readdir(path),
  readFile: path => readFile(path, 'utf8'),
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const JOURNAL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const sqlHost = (row: DatabaseRemoteAccessEntry): string => databaseRemoteHost(row.host).sqlHost

// ---------------------------------------------------------------- firewall

type Interval = readonly [bigint, bigint]
const BITS = { 4: 32n, 6: 128n } as const
const cidrInterval = (cidr: { value: bigint; prefix: number; version: 4 | 6 }): Interval => [cidr.value, cidr.value + (1n << (BITS[cidr.version] - BigInt(cidr.prefix))) - 1n]
const merged = (items: Interval[]): string[] => {
  const sorted = [...items].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0), out: [bigint, bigint][] = []
  for (const [start, end] of sorted) {
    const last = out.at(-1)
    if (last && start <= last[1] + 1n) { if (end > last[1]) last[1] = end } else out.push([start, end])
  }
  return out.map(([start, end]) => start + '-' + end)
}

/** libnftables-json(5): a set object lists `elem` as addresses, {prefix:{addr,len}}, {range:[a,b]} or {elem:{val}} wrappers. */
export function parseNftRemoteSet(stdout: string, family: DbRemoteFamily): Interval[] {
  const bad = (): never => { throw new Error('invalid_remote_database_set') }
  if (typeof stdout !== 'string' || stdout.length > 4 * 1024 * 1024) return bad()
  const doc: unknown = JSON.parse(stdout)
  if (!object(doc) || !Array.isArray(doc.nftables)) return bad()
  const sets = doc.nftables.filter(item => object(item) && Object.hasOwn(item, 'set')).map(item => (item as Record<string, unknown>).set)
  const set = sets.length === 1 ? sets[0] : bad()
  if (!object(set) || set.family !== 'inet' || set.table !== DB_REMOTE_TABLE || set.name !== (family === 4 ? DB_REMOTE_SET_V4 : DB_REMOTE_SET_V6) || set.type !== (family === 4 ? 'ipv4_addr' : 'ipv6_addr') || !Array.isArray(set.flags) || !set.flags.includes('interval')) return bad()
  const elements = set.elem === undefined ? [] : Array.isArray(set.elem) && set.elem.length <= DB_REMOTE_MAX_ELEMENTS * 2 ? set.elem : bad()
  const address = (raw: unknown): bigint => { const ip = parseIp(raw); return ip && ip.version === family ? ip.value : bad() }
  const one = (raw: unknown): Interval => {
    if (typeof raw === 'string') { const value = address(raw); return [value, value] }
    if (!object(raw) || Object.keys(raw).length !== 1) return bad()
    if (object(raw.elem)) return one(raw.elem.val)
    if (object(raw.prefix) && typeof raw.prefix.addr === 'string' && Number.isSafeInteger(raw.prefix.len)) { const cidr = parseCidr(raw.prefix.addr + '/' + String(raw.prefix.len)); return cidr && cidr.version === family ? cidrInterval(cidr) : bad() }
    if (Array.isArray(raw.range) && raw.range.length === 2) { const start = address(raw.range[0]), end = address(raw.range[1]); return start <= end ? [start, end] : bad() }
    return bad()
  }
  return elements.map(one)
}

/** Kernel source sets hold the union over every active account; neighbours' sources are always preserved. */
export function createDatabaseRemoteAccessFirewall(input: { run: RemoteAccessRun; readAllEntries(): Promise<RemoteAccessAccountEntries[]> }): DatabaseRemoteAccessFirewall {
  const expected = async (account: Account, entries: readonly DatabaseRemoteAccessEntry[]): Promise<{ v4: string[]; v6: string[] }> => {
    const all = await input.readAllEntries()
    if (!Array.isArray(all) || all.length > 10000 || new Set(all.map(row => row.accountId)).size !== all.length || !all.some(row => row.accountId === account.id)) throw new Error('remote_database_account_inventory_invalid')
    const sources = all.flatMap(row => row.accountId === account.id || row.status !== 'active' ? [] : parseDatabaseRemoteEntries([...row.entries]).map(entry => entry.host))
    if (account.status === 'active') sources.push(...parseDatabaseRemoteEntries([...entries]).map(entry => entry.host))
    return canonicalDbRemoteSources(sources)
  }
  return {
    async apply(account, entries) {
      const { v4, v6 } = await expected(account, entries)
      const result = await input.run(dbRemoteReplaceArgv([...v4, ...v6]))
      if (!result.ok) throw new Error('remote_database_firewall_apply_failed')
    },
    async verify(account, entries) {
      try {
        const want = await expected(account, entries)
        for (const family of [4, 6] as const) {
          const result = await input.run(dbRemoteListArgv(family))
          if (!result.ok) return false
          const live = merged(parseNftRemoteSet(result.stdout, family)), wanted = merged(want[family === 4 ? 'v4' : 'v6'].map(source => cidrInterval(parseCidr(source)!)))
          if (JSON.stringify(live) !== JSON.stringify(wanted)) return false
        }
        return true
      } catch { return false }
    },
  }
}

// ---------------------------------------------------------------- recovery journal

interface RecoveryJournal { format: 'xpanel.remote-database-recovery'; version: 1; accountId: string; beforeRevision: string; afterRevision: string; before: DatabaseRemoteAccessSnapshot; after: DatabaseRemoteAccessEntry[] }
export type RemoteRecoveryOutcome = 'restored' | 'committed' | 'discarded' | 'review'
export interface DatabaseRemoteAccessJournalRecovery extends DatabaseRemoteAccessRecovery {
  /** Agent startup: resolve every pending journal against the saved state; unresolved journals stay for review. */
  pending(readSnapshot: (accountId: string) => Promise<DatabaseRemoteAccessSnapshot>): Promise<{ accountId: string | null; outcome: RemoteRecoveryOutcome }[]>
}
const afterSnapshot = (before: DatabaseRemoteAccessSnapshot, after: DatabaseRemoteAccessEntry[]): DatabaseRemoteAccessSnapshot => ({ ...before, account: { ...before.account, databaseRemoteAccess: after } })
const savedEntries = (snapshot: DatabaseRemoteAccessSnapshot): DatabaseRemoteAccessEntry[] => parseDatabaseRemoteEntries(snapshot.account.databaseRemoteAccess ?? [])
const desiredGrants = (snapshot: DatabaseRemoteAccessSnapshot, user: DatabaseUser) => user.grants.flatMap(grant => {
  const db = snapshot.databases.find(row => row.id === grant.databaseId)
  return db && db.trashedAt === null ? [{ database: db.name, privileges: grant.privileges }] : []
})

export async function assertRemoteAccessJournalDirectory(fs: RemoteRecoveryFs, dir: string): Promise<void> {
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o7777) !== 0o700) throw new Error('remote_database_journal_directory_unsafe')
}

export function createDatabaseRemoteAccessJournalRecovery(input: { fs: RemoteRecoveryFs; dir: string; mariadb: RemoteAccessAdapter; firewall: DatabaseRemoteAccessFirewall; inspect(snapshot: DatabaseRemoteAccessSnapshot): Promise<boolean>; verify(snapshot: DatabaseRemoteAccessSnapshot, entries: readonly DatabaseRemoteAccessEntry[]): Promise<boolean> }): DatabaseRemoteAccessJournalRecovery {
  const { fs, dir, mariadb, firewall } = input
  const pathOf = (accountId: string): string => UUID.test(accountId) ? dir + '/' + accountId + '.json' : (() => { throw new Error('invalid_remote_database_checkpoint') })()
  const exists = async (path: string): Promise<boolean> => { try { await fs.lstat(path); return true } catch (error) { if ((error as { code?: unknown }).code === 'ENOENT') return false; throw error } }
  const remove = async (path: string): Promise<void> => {
    try { await fs.unlink(path) } catch (error) { if ((error as { code?: unknown }).code !== 'ENOENT') throw error }
    await fs.syncDirectory(dir)
  }
  const read = async (accountId: string): Promise<RecoveryJournal> => {
    const bad = (): never => { throw new Error('invalid_remote_database_journal') }
    const text = await fs.readFile(pathOf(accountId))
    if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) return bad()
    const raw: unknown = JSON.parse(text)
    if (!object(raw) || !exact(raw, ['format', 'version', 'accountId', 'beforeRevision', 'afterRevision', 'before', 'after']) || raw.format !== 'xpanel.remote-database-recovery' || raw.version !== 1 || raw.accountId !== accountId || !object(raw.before) || !object(raw.before.account)) return bad()
    const journal = raw as unknown as RecoveryJournal
    // Re-derives both fences: a modified journal can never steer recovery to another account or policy.
    if (journal.before.account.id !== accountId || databaseRemoteAccessRevision(journal.before) !== journal.beforeRevision || databaseRemoteAccessRevision(afterSnapshot(journal.before, parseDatabaseRemoteEntries(journal.after))) !== journal.afterRevision) return bad()
    return journal
  }
  /** Same adapter calls and ordering as native apply: close removed sources first, open the target set last. */
  const converge = async (snapshot: DatabaseRemoteAccessSnapshot, from: readonly DatabaseRemoteAccessEntry[], to: readonly DatabaseRemoteAccessEntry[]): Promise<void> => {
    const target = parseDatabaseRemoteEntries([...to]), previous = parseDatabaseRemoteEntries([...from])
    await firewall.apply(snapshot.account, target.filter(row => previous.some(item => item.host === row.host)))
    const removed = previous.filter(row => !target.some(item => item.host === row.host)).map(sqlHost)
    for (const user of snapshot.users) {
      for (const host of removed) await mariadb.dropUser(user.name, snapshot.account.username, [host])
      for (const row of target) {
        await mariadb.createUser(user.name, snapshot.account.username, [sqlHost(row)], { plugin: user.authPlugin, hash: user.authString })
        await mariadb.reconcileUserGrants({ user: user.name, username: snapshot.account.username, host: sqlHost(row), desiredGrants: desiredGrants(snapshot, user) })
      }
    }
    await firewall.apply(snapshot.account, target)
  }
  const checkpointId = (checkpoint: unknown): string => object(checkpoint) && exact(checkpoint, ['accountId']) && typeof checkpoint.accountId === 'string' && UUID.test(checkpoint.accountId) ? checkpoint.accountId : (() => { throw new Error('invalid_remote_database_checkpoint') })()
  return {
    async prepare(before, after) {
      const accountId = before.account.id, path = pathOf(accountId), target = parseDatabaseRemoteEntries([...after])
      const journal: RecoveryJournal = { format: 'xpanel.remote-database-recovery', version: 1, accountId, beforeRevision: databaseRemoteAccessRevision(before), afterRevision: databaseRemoteAccessRevision(afterSnapshot(before, target)), before, after: target }
      await assertRemoteAccessJournalDirectory(fs, dir)
      // An unresolved earlier outcome blocks every new change until startup recovery or review resolves it.
      if (await exists(path)) throw new Error('remote_database_recovery_pending')
      if (!await input.inspect(before)) throw new Error('remote_database_preimage_unverified')
      const text = JSON.stringify(journal)
      if (Buffer.byteLength(text) > MAX_JOURNAL_BYTES) throw new Error('remote_database_journal_capacity')
      await fs.writeSynced(path + '.tmp', text)
      await fs.rename(path + '.tmp', path)
      await fs.syncDirectory(dir)
      if (await fs.readFile(path) !== text) throw new Error('remote_database_journal_readback_failed')
      return { accountId }
    },
    async restore(checkpoint) {
      const journal = await read(checkpointId(checkpoint))
      await converge(journal.before, journal.after, savedEntries(journal.before))
    },
    async verifyRestored(checkpoint) {
      const journal = await read(checkpointId(checkpoint))
      if (!await input.verify(journal.before, savedEntries(journal.before))) return false
      // A journal left by a failed unlink is resolved at startup through the revision fence.
      try { await remove(pathOf(journal.accountId)) } catch { /* retained for startup recovery */ }
      return true
    },
    async committed(checkpoint) { await remove(pathOf(checkpointId(checkpoint))) },
    async pending(readSnapshot) {
      const report: { accountId: string | null; outcome: RemoteRecoveryOutcome }[] = []
      await assertRemoteAccessJournalDirectory(fs, dir)
      for (const name of (await fs.readdir(dir)).sort()) {
        const temporary = /^([0-9a-f-]{36})\.json\.tmp$/.exec(name)
        // prepare() had not returned, so no native effect started for this temporary file.
        if (temporary && UUID.test(temporary[1]!)) { await remove(dir + '/' + name); report.push({ accountId: temporary[1]!, outcome: 'discarded' }); continue }
        const accountId = JOURNAL.exec(name)?.[1] ?? null
        if (!accountId) { report.push({ accountId: null, outcome: 'review' }); continue }
        let outcome: RemoteRecoveryOutcome = 'review'
        try {
          const journal = await read(accountId), current = await readSnapshot(accountId), revision = databaseRemoteAccessRevision(current)
          if (revision === journal.beforeRevision) {
            await converge(journal.before, journal.after, savedEntries(journal.before))
            if (await input.verify(journal.before, savedEntries(journal.before))) outcome = 'restored'
          } else if (revision === journal.afterRevision && await input.verify(current, journal.after)) outcome = 'committed'
          if (outcome !== 'review') await remove(pathOf(accountId))
        } catch { outcome = 'review' }
        report.push({ accountId, outcome })
      }
      return report
    },
  }
}

// ---------------------------------------------------------------- qualification

export type QualifiedDatabaseRemoteAccessNative = DatabaseRemoteAccessNative & { recovery: DatabaseRemoteAccessJournalRecovery }

/** Null keeps remote access unavailable: missing renderer sets, an unsafe journal directory or an unreachable admin client. */
export async function qualifyDatabaseRemoteAccessNative(input: { mariadb: RemoteAccessAdapter; run: RemoteAccessRun; readAllEntries(): Promise<RemoteAccessAccountEntries[]>; journalDir?: string; fs?: RemoteRecoveryFs }): Promise<QualifiedDatabaseRemoteAccessNative | null> {
  const fs = input.fs ?? nodeRecoveryFs, dir = input.journalDir ?? DATABASE_REMOTE_ACCESS_JOURNAL_DIR
  try {
    await assertRemoteAccessJournalDirectory(fs, dir)
    for (const family of [4, 6] as const) {
      const result = await input.run(dbRemoteListArgv(family))
      if (!result.ok) return null
      parseNftRemoteSet(result.stdout, family)
    }
    if ((await input.mariadb.query(['SELECT 1'])).trim() !== '1') return null
  } catch { return null }
  const firewall = createDatabaseRemoteAccessFirewall({ run: input.run, readAllEntries: input.readAllEntries })
  let native: DatabaseRemoteAccessNative | null = null
  const ready = (): DatabaseRemoteAccessNative => native ?? (() => { throw new Error('remote_database_native_unavailable') })()
  const recovery = createDatabaseRemoteAccessJournalRecovery({ fs, dir, mariadb: input.mariadb, firewall, inspect: snapshot => ready().inspect(snapshot), verify: (snapshot, entries) => ready().verify(snapshot, entries) })
  native = createDatabaseRemoteAccessNative({ mariadb: input.mariadb, firewall, recovery, qualification: { sqlAndFirewallRecoveryVerified: true } })
  return native as QualifiedDatabaseRemoteAccessNative
}

export const recoverPendingDatabaseRemoteAccess = (native: QualifiedDatabaseRemoteAccessNative, readSnapshot: (accountId: string) => Promise<DatabaseRemoteAccessSnapshot>) => native.recovery.pending(readSnapshot)

/** Startup report when qualification failed: journals that stay pending until the provider is available. */
export async function pendingDatabaseRemoteAccessJournals(dir = DATABASE_REMOTE_ACCESS_JOURNAL_DIR, fs: RemoteRecoveryFs = nodeRecoveryFs): Promise<number> {
  try { return (await fs.readdir(dir)).filter(name => JOURNAL.test(name)).length } catch (error) { return (error as { code?: unknown }).code === 'ENOENT' ? 0 : -1 }
}

// ---------------------------------------------------------------- lifecycle propagation

/**
 * Hosts every saved database user must exist on. Remote hosts apply only while the account is active:
 * suspension keeps the saved policy but closes SQL and firewall access until reactivation.
 */
export const databaseUserSqlHosts = (account: Pick<Account, 'status' | 'databaseRemoteAccess'>): string[] =>
  ['localhost', ...(account.status === 'active' ? parseDatabaseRemoteEntries(account.databaseRemoteAccess ?? []).map(sqlHost) : [])]
/** Every saved remote host, whatever the status: dropped on suspension and termination. */
export const databaseUserRemoteSqlHosts = (account: Pick<Account, 'databaseRemoteAccess'>): string[] =>
  parseDatabaseRemoteEntries(account.databaseRemoteAccess ?? []).map(sqlHost)

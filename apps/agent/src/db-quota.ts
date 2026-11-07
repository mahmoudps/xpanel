import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, Database, DatabaseUser } from '@xpanel/core'
import type { NewAuditEntry } from '@xpanel/db'
import { services } from '@xpanel/render'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import { databaseUserSqlHosts } from './db-remote-provider.ts'
import { parseMariadbBatch } from './mariadb-admin.ts'

/**
 * Database size limits, as in aaPanel: a database over its limit keeps reads, deletes and drops, so its owner can
 * shrink it, and loses every privilege that adds data until the size is under the limit again.
 * Limits are root desired state in a panel file; the locks are this module's own record, and the reconciler honours them.
 */
export const DB_QUOTA_STATE = 'extended/panel/db-quotas.json'
const LOCK_STATE = 'extended/panel/db-quota-locks.json'
const KEPT = new Set(['SELECT', 'DELETE', 'DROP', 'LOCK TABLES', 'SHOW VIEW', 'EXECUTE'])
const TICK_MS = 5 * 60_000
export interface DbQuotaRow { database: string; account: string; sizeBytes: number | null; limitMb: number | null; locked: boolean }
export interface DbQuotaReport { observedAt: string; state: 'read' | 'unavailable'; rows: DbQuotaRow[] }

export function parseDbQuotas(raw: unknown): Record<string, number> | null {
  const limits = (raw as { limits?: unknown } | null)?.limits
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return null
  return Object.values(limits).every(value => Number.isInteger(value) && value >= 1 && value <= 16_777_216) ? limits as Record<string, number> : null
}
export const readDbQuotaLocks = async (stateRoot: string): Promise<Set<string>> => {
  try { const raw = await readJsonIfExists<{ locked?: unknown }>(join(stateRoot, LOCK_STATE)); return new Set(Array.isArray(raw?.locked) ? raw.locked.filter(item => typeof item === 'string') : []) } catch { return new Set() }
}
/** Saved privileges reduced to what a database over its limit keeps. */
export const dbQuotaPrivileges = (privileges: readonly string[], locked: boolean): string[] => locked ? services.normalizePrivileges(privileges).filter(right => KEPT.has(right)) : [...privileges]

export interface DbQuotaSql { query(statements: readonly string[]): Promise<string> }
export interface DbQuotaDeps {
  store: { rootDir: string; readSnapshot(): Promise<{ accounts: readonly Account[]; databases: readonly Database[]; databaseUsers: readonly DatabaseUser[] }> }
  sql: DbQuotaSql | null
  audit: (entry: NewAuditEntry) => Promise<unknown>
  now?: () => Date
}
export const dbQuotaSizesSql = (names: readonly string[]): string => `SELECT table_schema, COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema IN (${names.map(name => services.quoteString(name)).join(', ')}) GROUP BY table_schema`
export function parseDbQuotaSizes(stdout: string): Map<string, number> {
  return new Map(parseMariadbBatch(stdout, 2).map(([name, size]) => [name!, Number(size)]))
}

export function createDbQuotaEnforcer(deps: DbQuotaDeps) {
  const now = deps.now ?? (() => new Date())
  let busy = false, last = 0
  const load = async () => {
    const snapshot = await deps.store.readSnapshot()
    const limits = parseDbQuotas(await readJsonIfExists<unknown>(join(deps.store.rootDir, DB_QUOTA_STATE)).catch(() => null)) ?? {}
    return { snapshot, limits, locks: await readDbQuotaLocks(deps.store.rootDir), databases: snapshot.databases.filter(row => row.engine === 'mariadb' && row.trashedAt === null) }
  }
  type Loaded = Awaited<ReturnType<typeof load>>
  const sizes = async (databases: Loaded['databases']): Promise<Map<string, number> | null> => {
    if (databases.length === 0) return new Map()
    if (!deps.sql) return null
    try { return parseDbQuotaSizes(await deps.sql.query([dbQuotaSizesSql(databases.map(row => row.name))])) } catch { return null }
  }
  const report = (loaded: Loaded, measured: Map<string, number> | null, locks: Set<string>): DbQuotaReport => ({ observedAt: now().toISOString(), state: measured ? 'read' : 'unavailable',
    rows: loaded.databases.map(row => ({ database: row.name, account: loaded.snapshot.accounts.find(account => account.id === row.accountId)?.username ?? '', sizeBytes: measured ? measured.get(row.name) ?? 0 : null, limitMb: loaded.limits[row.name] ?? null, locked: locks.has(row.name) })) })
  const apply = async (loaded: Loaded, database: Database, locked: boolean): Promise<void> => {
    const account = loaded.snapshot.accounts.find(row => row.id === database.accountId)
    if (!account) return
    const statements: string[] = []
    for (const user of loaded.snapshot.databaseUsers.filter(row => row.accountId === account.id)) {
      const grant = user.grants.find(row => row.databaseId === database.id)
      if (!grant) continue
      for (const host of databaseUserSqlHosts(account)) {
        const kept = dbQuotaPrivileges(grant.privileges, locked)
        if (locked) statements.push(...services.revokePrivileges(user.name, account.username, [host], database.name))
        if (kept.length) statements.push(...services.grantPrivileges(user.name, account.username, [host], database.name, kept))
      }
    }
    if (statements.length) await deps.sql!.query(statements)
  }
  /** Idle with no limits and no locks: no SQL runs at all. */
  const enforce = async (actor: string): Promise<DbQuotaReport> => {
    const loaded = await load(), limited = loaded.databases.filter(row => loaded.limits[row.name] !== undefined)
    if (limited.length === 0 && loaded.locks.size === 0) return report(loaded, await sizes(loaded.databases), loaded.locks)
    const measured = await sizes(loaded.databases)
    if (!measured) return report(loaded, null, loaded.locks)
    const locks = new Set(loaded.locks)
    for (const database of loaded.databases) {
      const limit = loaded.limits[database.name], over = limit !== undefined && (measured.get(database.name) ?? 0) > limit * 1024 * 1024
      if (over === locks.has(database.name)) continue
      // The record is durable before the grants change, so a reconcile in between keeps the lock.
      if (over) locks.add(database.name); else locks.delete(database.name)
      await atomicWriteJson(join(deps.store.rootDir, LOCK_STATE), { locked: [...locks].sort() })
      await apply(loaded, database, over)
      await Promise.resolve(deps.audit({ actor, action: over ? 'database.quota.locked' : 'database.quota.unlocked', target: 'database:' + database.name, detail: { limitMb: limit ?? null }, outcome: 'ok' })).catch(() => undefined)
    }
    const known = new Set(loaded.databases.map(row => row.name)), kept = [...locks].filter(name => known.has(name))
    if (kept.length !== locks.size) await atomicWriteJson(join(deps.store.rootDir, LOCK_STATE), { locked: kept.sort() })
    return report(loaded, measured, new Set(kept))
  }
  return {
    enforce,
    observe: async (): Promise<DbQuotaReport> => { const loaded = await load(); return report(loaded, await sizes(loaded.databases), loaded.locks) },
    async tick(): Promise<void> {
      if (busy || Date.now() - last < TICK_MS) return
      busy = true; last = Date.now()
      try { await enforce('system:database-quota') } catch { /* the next tick measures again */ } finally { busy = false }
    },
  }
}
export type DbQuotaEnforcer = ReturnType<typeof createDbQuotaEnforcer>

export async function handleDbQuotaRoute(url: URL, method: string, deps: { assertRoot(action: string): Promise<{ actor: string }>; enforcer: DbQuotaEnforcer | null }): Promise<Response | null> {
  const apply = url.pathname === '/host/databases/quota/enforce'
  if (url.pathname !== '/host/databases/quota' && !apply) return null
  if (method !== (apply ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: apply ? 'POST' : 'GET' } })
  if (url.search) return fail('VALIDATION', 'database limits do not accept selectors', { stateChanged: false })
  const { actor } = await deps.assertRoot('host.databases.quota')
  if (!deps.enforcer) return fail('PRECONDITION_FAILED', 'MariaDB administration is not connected on this host', { stateChanged: false, reason: 'mariadb_admin_missing' })
  return new Response(JSON.stringify(apply ? await deps.enforcer.enforce(actor) : await deps.enforcer.observe()), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

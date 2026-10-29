import { dbGrantPattern, fail } from '@xpanel/core'
import type { Account, Database, DatabaseUser, FeatureList, Plan } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { StoredDatabaseUser } from '@xpanel/state'
import type { MariaDbServiceAdapter } from './services/mariadb.ts'
import type { AgentCallerIdentity } from './server.ts'
import { parseMariadbBatch } from './mariadb-admin.ts'

export { DATABASE_REMOTE_ACCESS_TOOL, DATABASE_REMOTE_ACCESS_LIMIT, databaseRemoteHost, parseDatabaseRemoteEntries, parseDatabaseRemoteAccessRequest, remoteAccessEntriesAfter, databaseRemoteAccessRevision } from '../../../packages/core/src/database-remote-access.ts'
export type { DatabaseRemoteAccessEntry, DatabaseRemoteAccessAccount, DatabaseRemoteAccessSnapshot, DatabaseRemoteHost, DatabaseRemoteAccessRequest } from '../../../packages/core/src/database-remote-access.ts'
import { DATABASE_REMOTE_ACCESS_TOOL, databaseRemoteHost, parseDatabaseRemoteEntries, parseDatabaseRemoteAccessRequest, remoteAccessEntriesAfter, databaseRemoteAccessRevision } from '../../../packages/core/src/database-remote-access.ts'
import type { DatabaseRemoteAccessEntry, DatabaseRemoteAccessSnapshot, DatabaseRemoteAccessStore } from '../../../packages/core/src/database-remote-access.ts'
export type { DatabaseRemoteAccessTransaction, DatabaseRemoteAccessStore } from '../../../packages/core/src/database-remote-access.ts'
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
export interface DatabaseRemoteAccessView {
  context: { accountId: string; username: string }
  revision: string
  entries: (DatabaseRemoteAccessEntry & { firewall: 'verified' | 'unavailable'; grants: 'verified' | 'unavailable' })[]
  limit: 100
  users: number
  databases: number
  capability: { canChange: boolean; reason: 'qualified' | 'native_provider_unavailable' | 'native_drift' }
  application: { status: 'read' | 'applied'; nativeQualified: boolean }
}
export interface DatabaseRemoteAccessRecovery {
  /** Must durably capture and verify exact live SQL account/auth/grant AND account-scoped firewall preimages before any effect. */
  prepare(before: DatabaseRemoteAccessSnapshot, after: readonly DatabaseRemoteAccessEntry[]): Promise<unknown>
  restore(checkpoint: unknown): Promise<void>
  verifyRestored(checkpoint: unknown): Promise<boolean>
  /** Mark committed durably; retain recovery on any uncertainty. */
  committed(checkpoint: unknown): Promise<void>
}
export interface DatabaseRemoteAccessFirewall {
  /** Only source-scoped TCP/3306 entries owned by account; preserve every neighbor/shared rule. */
  apply(account: Account, entries: readonly DatabaseRemoteAccessEntry[]): Promise<void>
  verify(account: Account, entries: readonly DatabaseRemoteAccessEntry[]): Promise<boolean>
}
export interface DatabaseRemoteAccessNative {
  readonly qualified: true
  inspect(snapshot: DatabaseRemoteAccessSnapshot): Promise<boolean>
  recovery: DatabaseRemoteAccessRecovery
  /** Recheck fresh principal/feature authority immediately before every SQL/firewall effect. */
  apply(before: DatabaseRemoteAccessSnapshot, after: readonly DatabaseRemoteAccessEntry[], authorize: () => Promise<void>): Promise<void>
  verify(snapshot: DatabaseRemoteAccessSnapshot, entries: readonly DatabaseRemoteAccessEntry[]): Promise<boolean>
}
type NativeAdapter = Pick<MariaDbServiceAdapter, 'query' | 'inspectUserGrants' | 'createUser' | 'dropUser' | 'reconcileUserGrants'>
const desiredGrants = (snapshot: DatabaseRemoteAccessSnapshot, user: DatabaseUser) => user.grants.flatMap(grant => {
  const db = snapshot.databases.find(row => row.id === grant.databaseId)
  return db && db.trashedAt === null ? [{ database: db.name, privileges: grant.privileges }] : []
})
/** SQL stays inside the existing protected MariaDB adapter. Missing durable recovery/firewall qualification never enables this factory. */
export function createDatabaseRemoteAccessNative(input: { mariadb: NativeAdapter; firewall: DatabaseRemoteAccessFirewall; recovery: DatabaseRemoteAccessRecovery; qualification: { sqlAndFirewallRecoveryVerified: true } }): DatabaseRemoteAccessNative {
  if (input.qualification.sqlAndFirewallRecoveryVerified !== true) return fail('PRECONDITION_FAILED', 'remote database recovery is not qualified', { stateChanged: false })
  const { mariadb, firewall, recovery } = input
  const existingHosts = async (snapshot: DatabaseRemoteAccessSnapshot, user: StoredDatabaseUser): Promise<string[]> => {
    const sql = 'SELECT Host FROM mysql.user WHERE User = ' + services.quoteString(services.assertDbUser(user.name, snapshot.account.username)) + ' ORDER BY Host LIMIT 102'
    const rows = parseMariadbBatch(await mariadb.query([sql]), 1).map(row => row[0]!)
    if (rows.length > 101 || new Set(rows).size !== rows.length) throw new Error('remote_database_host_capacity')
    return rows.sort()
  }
  const verify = async (snapshot: DatabaseRemoteAccessSnapshot, entries: readonly DatabaseRemoteAccessEntry[]): Promise<boolean> => {
    databaseRemoteAccessRevision(snapshot)
    const hosts = ['localhost', ...entries.map(row => databaseRemoteHost(row.host).sqlHost)].sort()
    for (const user of snapshot.users) {
      if (JSON.stringify(await existingHosts(snapshot, user)) !== JSON.stringify(hosts)) return false
      const expected = desiredGrants(snapshot, user).map(row => [dbGrantPattern(row.database), services.normalizePrivileges(row.privileges)] as const).sort(([a], [b]) => a.localeCompare(b))
      for (const host of hosts) {
        const live = await mariadb.inspectUserGrants(user.name, snapshot.account.username, host)
        if (live.hasGlobalGrant || JSON.stringify([...live.databaseGrants.entries()].sort(([a], [b]) => a.localeCompare(b))) !== JSON.stringify(expected)) return false
      }
    }
    return firewall.verify(snapshot.account, entries)
  }
  return { qualified: true, recovery, inspect: snapshot => verify(snapshot, snapshot.account.databaseRemoteAccess ?? []), verify,
    async apply(before, after, authorize) {
      databaseRemoteAccessRevision(before)
      const previous = parseDatabaseRemoteEntries(before.account.databaseRemoteAccess ?? []), next = parseDatabaseRemoteEntries([...after])
      // Close removed sources before removing SQL accounts; add network access only after exact SQL convergence.
      const retained = previous.filter(row => next.some(item => item.host === row.host))
      await authorize(); await firewall.apply(before.account, retained)
      for (const user of before.users) {
        const removed = previous.filter(row => !next.some(item => item.host === row.host)).map(row => databaseRemoteHost(row.host).sqlHost)
        for (const host of removed) { await authorize(); await mariadb.dropUser(user.name, before.account.username, [host]) }
        for (const row of next) {
          const host = databaseRemoteHost(row.host).sqlHost
          await authorize(); await mariadb.createUser(user.name, before.account.username, [host], { plugin: user.authPlugin, hash: user.authString })
          await authorize(); await mariadb.reconcileUserGrants({ user: user.name, username: before.account.username, host, desiredGrants: desiredGrants(before, user) })
        }
      }
      await authorize(); await firewall.apply(before.account, next)
    },
  }
}

export interface DatabaseRemoteAccessRouteDeps {
  caller: AgentCallerIdentity
  store: DatabaseRemoteAccessStore & { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  native?: DatabaseRemoteAccessNative
  audit(account: Account, action: string, host: string): Promise<void>
  now?: () => Date
}
const viewOf = (snapshot: DatabaseRemoteAccessSnapshot, verified: boolean, native: boolean, status: 'read' | 'applied' = 'read'): DatabaseRemoteAccessView => ({ context: { accountId: snapshot.account.id, username: snapshot.account.username }, revision: databaseRemoteAccessRevision(snapshot), entries: (snapshot.account.databaseRemoteAccess ?? []).map(row => ({ ...row, firewall: verified ? 'verified' : 'unavailable', grants: verified ? 'verified' : 'unavailable' })), limit: 100, users: snapshot.users.length, databases: snapshot.databases.filter(row => row.trashedAt === null).length, capability: { canChange: verified && native, reason: !native ? 'native_provider_unavailable' : verified ? 'qualified' : 'native_drift' }, application: { status, nativeQualified: verified && native } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/database-remote-access$/
export async function handleDatabaseRemoteAccessRoute(req: Request, url: URL, method: string, deps: DatabaseRemoteAccessRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (!['GET', 'POST'].includes(method)) return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return invalid('remote access does not accept query selectors')
  const authorize = async (account: Account): Promise<void> => {
    const caller = deps.caller, principal = await deps.currentPrincipal()
    if (caller.role !== 'user' || !caller.accountId || account.id !== caller.accountId || account.username !== match[1] || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is required', { stateChanged: false })
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!features || features.disabled.includes(DATABASE_REMOTE_ACCESS_TOOL)) return fail('FORBIDDEN', 'remote database access is disabled by the account plan', { stateChanged: false })
  }
  const account = await deps.store.getAccountByUsername(match[1]!)
  if (!account) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  await authorize(account)
  if (method === 'GET') {
    const snapshot = await deps.store.readDatabaseRemoteAccess(account.id), revision = databaseRemoteAccessRevision(snapshot)
    let verified = false
    if (deps.native) { try { verified = await deps.native.inspect(snapshot) } catch { /* saved policy remains visible, native state is unverified */ } }
    const fresh = await deps.store.readDatabaseRemoteAccess(account.id)
    await authorize(fresh.account)
    if (databaseRemoteAccessRevision(fresh) !== revision || fresh.account.createdAt !== account.createdAt) return fail('CONFLICT', 'remote database state changed while reading', { stateChanged: false })
    return json(viewOf(fresh, verified, !!deps.native))
  }
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await req.text()
  if (Buffer.byteLength(text) > 4096) return invalid('remote database request is too large')
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return invalid('a JSON object is required') }
  const request = parseDatabaseRemoteAccessRequest(raw), native = deps.native
  if (!native || native.qualified !== true) return fail('PRECONDITION_FAILED', 'qualified SQL and firewall recovery is unavailable; no remote host was changed', { stateChanged: false })
  let checkpoint: unknown, checkpointReady = false
  const response = await deps.store.withDatabaseRemoteAccessLease(account.id, request.expectedRevision, async (snapshot, tx) => {
    await authorize(snapshot.account)
    if (snapshot.account.createdAt !== account.createdAt || databaseRemoteAccessRevision(snapshot) !== request.expectedRevision) return fail('CONFLICT', 'remote database state changed; reload before retrying', { stateChanged: false })
    const next = remoteAccessEntriesAfter(parseDatabaseRemoteEntries(snapshot.account.databaseRemoteAccess ?? []), request, (deps.now?.() ?? new Date()).toISOString())
    let observed = false
    try { observed = await native.inspect(snapshot) } catch { /* provider details remain protected */ }
    if (!observed) return fail('PRECONDITION_FAILED', 'live database grants or firewall policy need review', { stateChanged: false })
    try { checkpoint = await native.recovery.prepare(snapshot, next) }
    catch { return fail('SERVICE_UNAVAILABLE', 'remote database recovery could not be prepared', { stateChanged: false, verificationRequired: true }) }
    checkpointReady = true
    tx.onAbort(async () => {
      await native.recovery.restore(checkpoint)
      if (!await native.recovery.verifyRestored(checkpoint)) return fail('SERVICE_UNAVAILABLE', 'remote database recovery requires inspection', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    })
    try {
      await authorize(snapshot.account)
      await native.apply(snapshot, next, () => authorize(snapshot.account))
      if (!await native.verify(snapshot, next)) throw new Error('remote_database_apply_unverified')
      await authorize(snapshot.account)
      await tx.commit(next)
      await deps.audit(snapshot.account, request.action, request.action === 'edit' ? request.replacement! : request.host)
      await authorize(snapshot.account)
      return json(viewOf({ ...snapshot, account: { ...snapshot.account, databaseRemoteAccess: next } }, true, true, 'applied'))
    } catch {
      // The store invokes onAbort before releasing the writer lease, including commit/authority failures.
      return fail('SERVICE_UNAVAILABLE', 'remote database change requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    }
  })
  if (checkpointReady) {
    try { await native.recovery.committed(checkpoint) }
    catch { return fail('SERVICE_UNAVAILABLE', 'remote database recovery record requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
  }
  return response
}

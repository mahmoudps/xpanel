import { createHash } from 'node:crypto'
import { fail } from './errors.ts'
import { assertDbNameOwned } from './rules/naming.ts'
import { formatCidr, parseCidr } from './rules/firewall.ts'
import { assertDbPrivileges } from './schemas.ts'
import type { Account, Database, DatabaseUser } from './types.ts'

export interface DatabaseRemoteAccessStoredUser extends DatabaseUser { authPlugin: 'mysql_native_password' | 'ed25519'; authString: string }
export const DATABASE_REMOTE_ACCESS_TOOL = 'remote-database-access'
export const DATABASE_REMOTE_ACCESS_LIMIT = 100
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HASH = /^[0-9a-f]{64}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const iso = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v))
export interface DatabaseRemoteAccessEntry { host: string; comment: string; createdAt: string }
export type DatabaseRemoteAccessAccount = Account & { databaseRemoteAccess?: DatabaseRemoteAccessEntry[] }
export interface DatabaseRemoteAccessSnapshot { account: DatabaseRemoteAccessAccount; databases: Database[]; users: DatabaseRemoteAccessStoredUser[] }
export interface DatabaseRemoteAccessTransaction {
  /** Bound writer lease: journal original account.json before callback; commit canonical entries exactly once. */
  commit(entries: DatabaseRemoteAccessEntry[]): Promise<void>
  /** Register before any native effect. Run under the same lease on callback/write/authority failure. */
  onAbort(restore: () => Promise<void>): void
}
export interface DatabaseRemoteAccessStore {
  readDatabaseRemoteAccess(accountId: string): Promise<DatabaseRemoteAccessSnapshot>
  withDatabaseRemoteAccessLease<T>(accountId: string, expectedRevision: string, callback: (snapshot: DatabaseRemoteAccessSnapshot, tx: DatabaseRemoteAccessTransaction) => Promise<T>): Promise<T>
}
export interface DatabaseRemoteHost { host: string; sqlHost: string; version: 4 | 6 }

/** MariaDB accepts IPv4 address/netmask hosts; IPv6 is exact-address only. No DNS lookup or any-host fallback. */
export function databaseRemoteHost(value: unknown): DatabaseRemoteHost {
  if (typeof value !== 'string' || value.length > 64 || value.trim() !== value || value === 'localhost') return invalid('use an exact IP address or an IPv4 network; localhost is implicit')
  const wildcard = /^((?:[0-9]{1,3}\.){1,3})%$/.exec(value)
  let input = value
  if (wildcard) {
    const octets = wildcard[1]!.slice(0, -1).split('.')
    input = [...octets, ...Array<string>(4 - octets.length).fill('0')].join('.') + '/' + String(octets.length * 8)
  }
  const cidr = parseCidr(input)
  if (!cidr || cidr.prefix === 0 || cidr.version === 6 && cidr.prefix !== 128) return invalid('use an exact IPv4/IPv6 address or an IPv4 CIDR with zero host bits; any-host access and DNS names are refused')
  const host = formatCidr(cidr)
  if (cidr.version === 6 || cidr.prefix === 32) return { host, sqlHost: host, version: cidr.version }
  const mask = (0xffffffffn << BigInt(32 - cidr.prefix)) & 0xffffffffn
  const netmask = [24n, 16n, 8n, 0n].map(shift => String((mask >> shift) & 255n)).join('.')
  return { host, sqlHost: host.split('/')[0] + '/' + netmask, version: 4 }
}
const commentOf = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069<>]/u.test(value)) return invalid('comment must be plain text of at most 200 characters')
  return value
}
export function parseDatabaseRemoteEntries(raw: unknown): DatabaseRemoteAccessEntry[] {
  if (!Array.isArray(raw) || raw.length > DATABASE_REMOTE_ACCESS_LIMIT) return invalid('at most 100 remote hosts are allowed')
  const seen = new Set<string>()
  return raw.map(item => {
    if (!object(item) || !exact(item, ['host', 'comment', 'createdAt']) || !iso(item.createdAt)) return invalid('invalid saved remote-host policy')
    const host = databaseRemoteHost(item.host).host
    if (host !== item.host || seen.has(host)) return invalid('remote hosts must be canonical and unique')
    seen.add(host)
    return { host, comment: commentOf(item.comment), createdAt: item.createdAt }
  })
}
export type DatabaseRemoteAccessRequest = { action: 'add' | 'edit' | 'remove'; expectedRevision: string; host: string; replacement?: string; comment?: string }
export function parseDatabaseRemoteAccessRequest(raw: unknown): DatabaseRemoteAccessRequest {
  if (!object(raw) || !['add', 'edit', 'remove'].includes(raw.action as string) || !exact(raw, raw.action === 'add' ? ['action', 'expectedRevision', 'host', 'comment'] : raw.action === 'edit' ? ['action', 'expectedRevision', 'host', 'replacement', 'comment'] : ['action', 'expectedRevision', 'host']) || typeof raw.expectedRevision !== 'string' || !HASH.test(raw.expectedRevision)) return invalid('the exact remote-host fields and a current revision are required')
  const action = raw.action as DatabaseRemoteAccessRequest['action'], host = databaseRemoteHost(raw.host).host
  return { action, expectedRevision: raw.expectedRevision, host, ...(action === 'edit' ? { replacement: databaseRemoteHost(raw.replacement).host } : {}), ...(action === 'remove' ? {} : { comment: commentOf(raw.comment) }) }
}
export function remoteAccessEntriesAfter(before: readonly DatabaseRemoteAccessEntry[], request: DatabaseRemoteAccessRequest, timestamp: string): DatabaseRemoteAccessEntry[] {
  const current = before.find(row => row.host === request.host)
  if (request.action === 'add' && current) return fail('CONFLICT', 'this remote host already exists', { stateChanged: false })
  if (request.action !== 'add' && !current) return fail('NOT_FOUND', 'remote host not found', { stateChanged: false })
  if (request.action === 'edit' && current && current.host === request.replacement && current.comment === request.comment) return invalid('change the host or comment before saving')
  const next = request.action === 'add' ? [...before, { host: request.host, comment: request.comment!, createdAt: timestamp }]
    : request.action === 'remove' ? before.filter(row => row.host !== request.host)
      : before.map(row => row.host === request.host ? { ...row, host: request.replacement!, comment: request.comment! } : row)
  return parseDatabaseRemoteEntries(next).sort((a, b) => a.host.localeCompare(b.host))
}
/** No secret/authentication column enters a public view. The digest also fences password/grant changes. */
export function databaseRemoteAccessRevision(snapshot: DatabaseRemoteAccessSnapshot): string {
  const account = snapshot.account
  if (!UUID.test(account.id) || !iso(account.createdAt) || snapshot.databases.length > 1000 || snapshot.users.length > 1000) return invalid('invalid database account snapshot')
  const databases = [...snapshot.databases].sort((a, b) => a.id.localeCompare(b.id)), users = [...snapshot.users].sort((a, b) => a.id.localeCompare(b.id))
  const ids = new Set<string>(), names = new Set<string>()
  for (const db of databases) {
    if (db.accountId !== account.id || !UUID.test(db.id) || ids.has(db.id) || names.has(db.name)) return invalid('invalid owned database snapshot')
    assertDbNameOwned(account.username, db.name); ids.add(db.id); names.add(db.name)
  }
  names.clear()
  const userIds = new Set<string>()
  for (const user of users) {
    if (user.accountId !== account.id || !UUID.test(user.id) || userIds.has(user.id) || names.has(user.name)) return invalid('invalid owned database-user snapshot')
    if (user.authPlugin === 'mysql_native_password' ? !/^\*[0-9A-F]{40}$/.test(user.authString) : user.authPlugin !== 'ed25519' || !/^[A-Za-z0-9+/]{43}$/.test(user.authString)) return invalid('invalid stored database authentication')
    assertDbNameOwned(account.username, user.name); userIds.add(user.id); names.add(user.name)
    const grantIds = new Set<string>()
    for (const grant of user.grants) {
      if (!ids.has(grant.databaseId) || grantIds.has(grant.databaseId)) return invalid('invalid owned database grant snapshot')
      assertDbPrivileges(grant.privileges); grantIds.add(grant.databaseId)
    }
  }
  return createHash('sha256').update(JSON.stringify({ account: { id: account.id, username: account.username, createdAt: account.createdAt, status: account.status, planId: account.planId, uid: account.uid, gid: account.gid, home: account.home, ownerId: account.ownerId, ipv4: account.ipv4, ipv6: account.ipv6 }, entries: parseDatabaseRemoteEntries(account.databaseRemoteAccess ?? []).sort((a, b) => a.host.localeCompare(b.host)), databases, users })).digest('hex')
}

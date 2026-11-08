import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { isIPv4, isIPv6 } from 'node:net'
import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { edge } from '@xpanel/render'
import { atomicWriteJson } from '@xpanel/state'
import { leechStatePath, readLeechRecord, type LeechRecord } from './leech-protection.ts'
import { proxyRulesByDomain, proxyRulesPath, readProxyRulesRecord, type ProxyRulesRecord } from './proxy-rules.ts'

/**
 * Per-account edge desired state: cPanel IP Blocker (addresses refused by every site of the account at the nginx
 * edge) and NGINX cache control (cache on or off for the account, purge by a new cache key epoch). One file per
 * account and feature under the state root; the reconciler renders both into the account's nginx sites.
 */
export const IP_BLOCKER_STATE_DIR = 'extended/edge/ip-blocker'
export const EDGE_CACHE_STATE_DIR = 'extended/edge/cache'
/** Set by a live transfer on its source. No address yet: frozen, mail waits. An address: this account's sites and mail pass through to it while suspended. */
export const MOVED_STATE_DIR = 'extended/edge/moved'
export const LIVE_TRANSFER_STATE_DIR = 'extended/server/live-transfers'
export const IP_BLOCKER_MAX = edge.ACCOUNT_EDGE_DENY_MAX
/** Blocks one range input may expand to; any IPv4 range fits in 62. */
export const IP_BLOCKER_RANGE_BLOCKS = 64

export interface IpBlockerRecord { version: 1; entries: string[]; updatedAt: string }
export interface EdgeCacheRecord { version: 1; enabled: boolean; epoch: string | null; purgedAt: string | null; updatedAt: string }
export interface MovedRecord { version: 1; ipv4: string | null; hostname: string; movedAt: string }
export type EdgeFeature = 'ip-blocker' | 'cache'
export const edgeStatePath = (feature: EdgeFeature, accountId: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId)) return fail('VALIDATION', 'account id is invalid')
  return (feature === 'ip-blocker' ? IP_BLOCKER_STATE_DIR : EDGE_CACHE_STATE_DIR) + '/' + accountId + '.json'
}
export const movedStatePath = (accountId: string): string => edgeStatePath('cache', accountId).replace(EDGE_CACHE_STATE_DIR, MOVED_STATE_DIR)
export const readMovedRecord = (raw: unknown): MovedRecord | null =>
  object(raw) && Object.keys(raw).sort().join() === 'hostname,ipv4,movedAt,version' && raw.version === 1 && (raw.ipv4 === null || typeof raw.ipv4 === 'string' && isIPv4(raw.ipv4)) && typeof raw.hostname === 'string' && typeof raw.movedAt === 'string' ? raw as unknown as MovedRecord : null
export const edgeRevision = (raw: unknown): string => createHash('sha256').update(JSON.stringify(raw ?? null)).digest('hex')

type Family = 4 | 6
const BITS: Record<Family, number> = { 4: 32, 6: 128 }
const toBig = (ip: string, family: Family): bigint => {
  if (family === 4) return ip.split('.').reduce((n, octet) => (n << 8n) | BigInt(Number(octet)), 0n)
  const [head = '', tail] = ip.toLowerCase().split('::')
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : []
  const groups = [...h, ...Array<string>(tail === undefined ? 0 : 8 - h.length - t.length).fill('0'), ...t]
  return groups.reduce((n, group) => (n << 16n) | BigInt(parseInt(group, 16)), 0n)
}
const fromBig = (value: bigint, family: Family): string => {
  if (family === 4) return [24n, 16n, 8n, 0n].map(shift => String((value >> shift) & 255n)).join('.')
  const groups = Array.from({ length: 8 }, (_unused, index) => ((value >> BigInt(112 - index * 16)) & 0xffffn).toString(16))
  // RFC 5952: compress the longest run of two or more zero groups.
  let best = -1, length = 0
  for (let start = 0; start < 8; start++) { let end = start; while (end < 8 && groups[end] === '0') end++; if (end - start > length && end - start > 1) { best = start; length = end - start } }
  return best < 0 ? groups.join(':') : groups.slice(0, best).join(':') + '::' + groups.slice(best + length).join(':')
}
const familyOf = (ip: string): Family | null => isIPv4(ip) && !ip.split('.').some(octet => octet.length > 1 && octet.startsWith('0')) ? 4 : isIPv6(ip) && !ip.includes('%') && !ip.includes('.') ? 6 : null
const mask = (prefix: number, family: Family): bigint => ((1n << BigInt(BITS[family])) - 1n) ^ ((1n << BigInt(BITS[family] - prefix)) - 1n)
const block = (start: bigint, prefix: number, family: Family): string => fromBig(start, family) + (prefix === BITS[family] ? '' : '/' + prefix)

/** First and last address of one canonical entry. */
export function ipBlockerRange(entry: string): { first: string; last: string } {
  const [ip = '', prefix] = entry.split('/'), family = familyOf(ip)
  if (!family) return fail('VALIDATION', 'blocked address is invalid')
  const bits = prefix === undefined ? BITS[family] : Number(prefix), start = toBig(ip, family)
  return { first: fromBig(start, family), last: fromBig(start | ((1n << BigInt(BITS[family] - bits)) - 1n), family) }
}

/** Smallest list of CIDR blocks that covers exactly start..end. */
const rangeBlocks = (start: bigint, end: bigint, family: Family): string[] => {
  const out: string[] = []
  while (start <= end && out.length <= IP_BLOCKER_RANGE_BLOCKS) {
    let size = BITS[family]
    while (size > 0) {
      const span = 1n << BigInt(BITS[family] - size + 1)
      if (start % span !== 0n || start + span - 1n > end) break
      size--
    }
    out.push(block(start, size, family))
    start += 1n << BigInt(BITS[family] - size)
  }
  return out
}
// The edge reaches the backend and the agent's own probes on loopback; blocking it would take every site down.
const protectedRange = (start: bigint, end: bigint, family: Family): boolean => family === 4 ? start <= toBig('127.255.255.255', 4) && end >= toBig('127.0.0.0', 4) : start <= 1n && end >= 1n

export type IpBlockerParse = { entries: string[] } | { code: 'address' | 'range' | 'too_many' | 'protected_address' }
/**
 * cPanel IP Blocker input: a single address, a CIDR block, a full range a.b.c.d-e.f.g.h, an implied range a.b.c.d-e,
 * or a leading prefix such as 10. or 10.5. (IPv4). Ranges become the exact covering CIDR blocks; hosts are
 * resolved by the caller before this parser runs.
 */
export function parseIpBlockerInput(input: string): IpBlockerParse {
  const value = input.trim()
  if (!value || value.length > 100 || /[^0-9A-Fa-f.:/-]/.test(value)) return { code: 'address' }
  const finish = (start: bigint, end: bigint, family: Family): IpBlockerParse => {
    if (start > end) return { code: 'range' }
    if (protectedRange(start, end, family)) return { code: 'protected_address' }
    const entries = rangeBlocks(start, end, family)
    return entries.length > IP_BLOCKER_RANGE_BLOCKS ? { code: 'too_many' } : { entries }
  }
  const prefix = /^((?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){1,3})$/.exec(value)
  if (prefix) {
    const octets = prefix[1]!.split('.').filter(Boolean), base = toBig([...octets, ...Array(4 - octets.length).fill('0')].join('.'), 4)
    return finish(base, base | ((1n << BigInt(32 - octets.length * 8)) - 1n), 4)
  }
  if (value.includes('-')) {
    const [left = '', right = '', extra] = value.split('-'), family = familyOf(left)
    if (!family || extra !== undefined) return { code: 'address' }
    if (family === 4 && /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/.test(right)) return finish(toBig(left, 4), toBig(left.split('.').slice(0, 3).join('.') + '.' + right, 4), 4)
    if (familyOf(right) !== family) return { code: 'address' }
    return finish(toBig(left, family), toBig(right, family), family)
  }
  const [ip = '', bits, extra] = value.split('/'), family = familyOf(ip)
  if (!family || extra !== undefined || bits !== undefined && (!/^(?:0|[1-9][0-9]{0,2})$/.test(bits) || Number(bits) > BITS[family])) return { code: 'address' }
  const size = bits === undefined ? BITS[family] : Number(bits), start = toBig(ip, family) & mask(size, family)
  return finish(start, start | ((1n << BigInt(BITS[family] - size)) - 1n), family)
}

const ISO = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
/** A saved entry must already be canonical: re-parsing it yields exactly itself. */
const canonical = (entry: unknown): entry is string => {
  if (typeof entry !== 'string') return false
  const parsed = parseIpBlockerInput(entry)
  return 'entries' in parsed && parsed.entries.length === 1 && parsed.entries[0] === entry
}
export function readIpBlockerRecord(raw: unknown): IpBlockerRecord | null {
  if (!object(raw) || !exact(raw, ['version', 'entries', 'updatedAt']) || raw.version !== 1 || !ISO(raw.updatedAt) || !Array.isArray(raw.entries) || raw.entries.length > IP_BLOCKER_MAX
    || !raw.entries.every(canonical) || new Set(raw.entries).size !== raw.entries.length) return null
  return { version: 1, entries: [...raw.entries as string[]], updatedAt: raw.updatedAt }
}
const EPOCH = /^[a-z0-9]{1,16}$/
export function readEdgeCacheRecord(raw: unknown): EdgeCacheRecord | null {
  if (!object(raw) || !exact(raw, ['version', 'enabled', 'epoch', 'purgedAt', 'updatedAt']) || raw.version !== 1 || typeof raw.enabled !== 'boolean' || !ISO(raw.updatedAt)
    || !(raw.epoch === null || typeof raw.epoch === 'string' && EPOCH.test(raw.epoch)) || !(raw.purgedAt === null || ISO(raw.purgedAt)) || (raw.epoch === null) !== (raw.purgedAt === null)) return null
  return { version: 1, enabled: raw.enabled, epoch: raw.epoch as string | null, purgedAt: raw.purgedAt as string | null, updatedAt: raw.updatedAt }
}
/** A new epoch per purge: the purge time in base 36, unique per millisecond and always different from the previous one. */
export const nextCacheEpoch = (now: Date, previous: string | null): string => {
  const epoch = now.getTime().toString(36)
  return epoch === previous ? (now.getTime() + 1).toString(36) : epoch
}

export interface AccountEdgeInput { policy: edge.AccountEdgePolicy; cache: boolean; proxyRules?: Record<string, edge.ProxyRule[]> }
const readState = async (root: string, path: string): Promise<unknown> => {
  let text: string
  try { text = await readFile(join(root, path), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return fail('PRECONDITION_FAILED', 'saved edge configuration is unreadable; review it before reconciliation')
  }
  try { return JSON.parse(text) } catch { return fail('PRECONDITION_FAILED', 'saved edge configuration is invalid; review it before reconciliation') }
}

/** Reconciler input; an invalid saved file stops reconciliation rather than dropping an account's blocks. */
export async function readAccountEdge(root: string, accounts: readonly Pick<Account, 'id'>[]): Promise<Map<string, AccountEdgeInput>> {
  const out = new Map<string, AccountEdgeInput>()
  for (const account of accounts) {
    const blockedRaw = await readState(root, edgeStatePath('ip-blocker', account.id)), cacheRaw = await readState(root, edgeStatePath('cache', account.id)), rulesRaw = await readState(root, proxyRulesPath(account.id))
    const movedRaw = await readState(root, movedStatePath(account.id))
    const blocked = blockedRaw === null ? null : readIpBlockerRecord(blockedRaw), cache = cacheRaw === null ? null : readEdgeCacheRecord(cacheRaw), rules = rulesRaw === null ? null : readProxyRulesRecord(rulesRaw), moved = movedRaw === null ? null : readMovedRecord(movedRaw)
    if (blockedRaw !== null && !blocked || cacheRaw !== null && !cache || rulesRaw !== null && !rules || movedRaw !== null && !moved) return fail('PRECONDITION_FAILED', 'saved edge configuration is invalid; review it before reconciliation')
    if (blocked || cache || rules || moved) out.set(account.id, { policy: { deny: blocked?.entries ?? [], cacheEpoch: cache?.epoch ?? null, ...(moved ? { movedTo: moved.ipv4 } : {}) }, cache: cache?.enabled ?? true, ...(rules && { proxyRules: proxyRulesByDomain(rules) }) })
  }
  return out
}
/** Everything an account saved at the edge, Leech Protection included; it moves with the account on a server transfer. */
export interface AccountEdgeState { ipBlocker?: IpBlockerRecord; cache?: EdgeCacheRecord; leech?: LeechRecord; proxyRules?: ProxyRulesRecord }
/** Null for anything but canonical records, which is all a transfer source may send. */
export function parseAccountEdgeState(raw: unknown): AccountEdgeState | null {
  if (!object(raw) || Object.keys(raw).some(key => !['ipBlocker', 'cache', 'leech', 'proxyRules'].includes(key))) return null
  const ipBlocker = raw.ipBlocker === undefined ? undefined : readIpBlockerRecord(raw.ipBlocker), cache = raw.cache === undefined ? undefined : readEdgeCacheRecord(raw.cache)
  const leech = raw.leech === undefined ? undefined : readLeechRecord(raw.leech), proxyRules = raw.proxyRules === undefined ? undefined : readProxyRulesRecord(raw.proxyRules)
  if (ipBlocker === null || cache === null || leech === null || proxyRules === null) return null
  return { ...(ipBlocker && { ipBlocker }), ...(cache && { cache }), ...(leech && { leech }), ...(proxyRules && { proxyRules }) }
}
export async function readAccountEdgeState(root: string, accountId: string): Promise<AccountEdgeState> {
  const saved = { ipBlocker: await readState(root, edgeStatePath('ip-blocker', accountId)), cache: await readState(root, edgeStatePath('cache', accountId)), leech: await readState(root, leechStatePath(accountId)), proxyRules: await readState(root, proxyRulesPath(accountId)) }
  return parseAccountEdgeState(Object.fromEntries(Object.entries(saved).filter(([, record]) => record !== null))) ?? fail('PRECONDITION_FAILED', 'saved edge configuration is invalid; review it before the transfer')
}
export async function writeAccountEdgeState(root: string, accountId: string, state: AccountEdgeState, confirm: () => Promise<void>): Promise<void> {
  for (const [path, record] of [[edgeStatePath('ip-blocker', accountId), state.ipBlocker], [edgeStatePath('cache', accountId), state.cache], [leechStatePath(accountId), state.leech], [proxyRulesPath(accountId), state.proxyRules]] as const)
    if (record) await atomicWriteJson(join(root, path), record, 0o640, confirm)
}
/** Called once a purged account has left the desired state. */
export async function removeAccountEdgeState(root: string, accountId: string): Promise<void> {
  for (const path of [edgeStatePath('ip-blocker', accountId), edgeStatePath('cache', accountId), leechStatePath(accountId), proxyRulesPath(accountId), movedStatePath(accountId), LIVE_TRANSFER_STATE_DIR + '/' + accountId + '.json']) await rm(join(root, path), { force: true })
}
/** Unsuspending a moved account ends its proxying. */
export const clearAccountMoved = (root: string, accountId: string): Promise<void> => rm(join(root, movedStatePath(accountId)), { force: true })
/** nginxSiteFile options for one account: its edge policy, and the cache switched off when the account turned it off. */
export const accountEdgeSiteOptions = (edgeByAccount: ReadonlyMap<string, AccountEdgeInput> | undefined, accountId: string): { accountEdge?: edge.AccountEdgePolicy; cache?: false; proxyRules?: Record<string, edge.ProxyRule[]> } => {
  const saved = edgeByAccount?.get(accountId)
  return saved ? { accountEdge: saved.policy, ...(saved.cache ? {} : { cache: false as const }), ...(saved.proxyRules && { proxyRules: saved.proxyRules }) } : {}
}

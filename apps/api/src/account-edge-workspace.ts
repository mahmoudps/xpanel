import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { fail, validateDomainName } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { edgeRevision, edgeStatePath, IP_BLOCKER_MAX, ipBlockerRange, nextCacheEpoch, parseIpBlockerInput, readEdgeCacheRecord, readIpBlockerRecord } from '../../agent/src/account-edge.ts'
import type { EdgeCacheRecord, EdgeFeature, IpBlockerRecord } from '../../agent/src/account-edge.ts'

export const IP_BLOCKER_PATH = '/api/account/ip-blocker'
export const EDGE_CACHE_PATH = '/api/account/edge-cache'
export interface AccountEdgePorts extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'emitAudit' | 'triggerReconcile'> {
  store: StateStore
  /** Host name to addresses for cPanel's host-name entries; the default asks the system resolver with a bound. */
  resolveHost?: (name: string) => Promise<string[]>
  now?: () => Date
}
type Reconcile = 'requested' | 'failed' | 'not_connected' | 'unknown'
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const field = (message: string, name: string, code: string): never => fail('VALIDATION', message, { ...unchanged, fields: [{ field: name, code }] })
const MAX_RESOLVED = 16

export const systemResolve = async (name: string): Promise<string[]> => {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('resolve_timeout')), 3000) })
  try { return (await Promise.race([lookup(name, { all: true, verbatim: true }), timeout])).map(item => item.address) } finally { clearTimeout(timer) }
}
export const readEdgeBody = async (request: Request, maxBytes = 2048): Promise<Record<string, unknown>> => {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'JSON is required', unchanged)
  const raw = await request.text()
  if (Buffer.byteLength(raw) > maxBytes) return fail('VALIDATION', 'the request is too large', unchanged)
  let value: unknown
  try { value = JSON.parse(raw) } catch { return fail('VALIDATION', 'valid JSON is required', unchanged) }
  return object(value) ? value : fail('VALIDATION', 'a JSON object is required', unchanged)
}
const readRaw = async (store: Pick<StateStore, 'rootDir'>, feature: EdgeFeature, account: Account): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, edgeStatePath(feature, account.id))) } catch { return fail('PRECONDITION_FAILED', 'saved edge configuration is unreadable; review it before changing it', unchanged) }
}
export const reconcileOutcome = async (ports: Pick<AccountEdgePorts, 'triggerReconcile'>, caller: AuthenticatedCaller): Promise<Reconcile> => {
  try { const result = await ports.triggerReconcile(caller); return result === null ? 'not_connected' : result.ok ? 'requested' : 'failed' } catch { return 'unknown' }
}

/** The next saved cache record, or null when the account already has this setting. */
export function nextEdgeCacheRecord(raw: unknown, op: 'purge' | 'enable' | 'disable', now: Date): EdgeCacheRecord | null {
  const current = raw === null ? { enabled: true, epoch: null, purgedAt: null } : readEdgeCacheRecord(raw) ?? fail('PRECONDITION_FAILED', 'saved cache settings require review before changing them', unchanged)
  if (op !== 'purge' && current.enabled === (op === 'enable')) return null
  // A purge moves the account to a new cache key epoch; old responses are never served again and age out of the cache.
  return op === 'purge' ? { version: 1, enabled: current.enabled, epoch: nextCacheEpoch(now, current.epoch), purgedAt: now.toISOString(), updatedAt: now.toISOString() }
    : { version: 1, enabled: op === 'enable', epoch: current.epoch, purgedAt: current.purgedAt, updatedAt: now.toISOString() }
}

export function ipBlockerView(account: Pick<Account, 'id' | 'username'>, raw: unknown) {
  const record = raw === null ? null : readIpBlockerRecord(raw)
  return { context: { accountId: account.id, username: account.username }, state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const, revision: edgeRevision(raw),
    limit: IP_BLOCKER_MAX, updatedAt: record?.updatedAt ?? null, entries: (record?.entries ?? []).map(entry => ({ entry, ...ipBlockerRange(entry) })) }
}
export function edgeCacheView(account: Pick<Account, 'id' | 'username'>, raw: unknown) {
  const record = raw === null ? null : readEdgeCacheRecord(raw)
  return { context: { accountId: account.id, username: account.username }, state: raw === null ? 'default' as const : record ? 'saved' as const : 'invalid' as const, revision: edgeRevision(raw),
    enabled: raw === null ? true : record?.enabled ?? null, purgedAt: record?.purgedAt ?? null, updatedAt: record?.updatedAt ?? null }
}

/** IP Blocker and NGINX cache control of the signed-in account owner; the account comes from the session only. */
export async function handleAccountEdgeRoute(request: Request, url: URL, method: string, ports: AccountEdgePorts): Promise<Response | null> {
  const feature: EdgeFeature | null = url.pathname === IP_BLOCKER_PATH ? 'ip-blocker' : url.pathname === EDGE_CACHE_PATH ? 'cache' : null
  if (!feature) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'edge settings accept no query selectors', unchanged)
  const tool = feature === 'ip-blocker' ? 'ip-blocker' : 'nginx-cache-control', label = feature === 'ip-blocker' ? 'IP Blocker' : 'Cache control'
  const authorize = () => authorizeAccountOwner(ports, request, [tool], label)
  const first = await authorize()
  const view = (raw: unknown) => feature === 'ip-blocker' ? ipBlockerView(first.account, raw) : edgeCacheView(first.account, raw)
  if (method === 'GET') return workspaceJson(view(await readRaw(ports.store, feature, first.account)))
  const body = await readEdgeBody(request)
  const keys = Object.keys(body).sort().join()
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return field('the exact read revision is required', 'expectedRevision', 'revision')
  const now = (ports.now ?? (() => new Date()))()
  let build: (raw: unknown) => IpBlockerRecord | EdgeCacheRecord, action: string, detail: Record<string, unknown>
  if (feature === 'ip-blocker') {
    const op = keys === 'add,expectedRevision' ? 'add' : keys === 'expectedRevision,remove' ? 'remove' : null
    const value = op ? body[op] : null
    if (!op || typeof value !== 'string' || value.length > 255) return fail('VALIDATION', 'a change takes expectedRevision and exactly one of add or remove', unchanged)
    let entries: string[] = []
    if (op === 'add') {
      const parsed = parseIpBlockerInput(value)
      if ('entries' in parsed) entries = parsed.entries
      else if (parsed.code !== 'address') return field('the address or range cannot be blocked', 'add', parsed.code)
      else {
        // cPanel accepts a host name and blocks the addresses it resolves to now.
        let name: string
        try { name = validateDomainName(value.trim().toLowerCase()) } catch { return field('use an address, a range, a CIDR block or a host name', 'add', 'address') }
        let addresses: string[]
        try { addresses = await (ports.resolveHost ?? systemResolve)(name) } catch { return field('the host name could not be resolved', 'add', 'unresolved') }
        if (!addresses.length) return field('the host name could not be resolved', 'add', 'unresolved')
        for (const address of [...new Set(addresses)].slice(0, MAX_RESOLVED)) {
          const one = parseIpBlockerInput(address)
          if (!('entries' in one)) return field('the host name resolves to an address that cannot be blocked', 'add', one.code === 'protected_address' ? 'protected_address' : 'address')
          entries.push(...one.entries)
        }
      }
    } else if (!('entries' in parseIpBlockerInput(value))) return field('the entry is not a saved block', 'remove', 'address')
    action = op === 'add' ? 'account.ip_blocker.added' : 'account.ip_blocker.removed'
    detail = { entries: op === 'add' ? entries.length : 1 }
    build = raw => {
      const current = raw === null ? [] : readIpBlockerRecord(raw)?.entries ?? fail('PRECONDITION_FAILED', 'saved blocks require review before changing them', unchanged)
      let next: string[]
      if (op === 'remove') { if (!current.includes(value)) return field('the entry is not a saved block', 'remove', 'not_found'); next = current.filter(entry => entry !== value) }
      else {
        const added = [...new Set(entries)].filter(entry => !current.includes(entry))
        if (!added.length) return field('the address or range is already blocked', 'add', 'duplicate')
        next = [...current, ...added]
        if (next.length > IP_BLOCKER_MAX) return field(`at most ${IP_BLOCKER_MAX} blocks are saved`, 'add', 'too_many')
      }
      return { version: 1, entries: next, updatedAt: now.toISOString() }
    }
  } else {
    if (keys !== 'expectedRevision,op' || !['purge', 'enable', 'disable'].includes(body.op as string)) return fail('VALIDATION', 'a change takes expectedRevision and op purge, enable or disable', unchanged)
    const op = body.op as 'purge' | 'enable' | 'disable'
    action = 'account.edge_cache.' + (op === 'purge' ? 'purged' : op === 'enable' ? 'enabled' : 'disabled')
    detail = {}
    build = raw => nextEdgeCacheRecord(raw, op, now) ?? field('the cache already has this setting', 'op', 'unchanged')
  }
  const fresh = async (): Promise<AuthenticatedCaller> => {
    const again = await authorize()
    return again.caller.principal.id === first.caller.principal.id && again.account.id === first.account.id ? again.caller : fail('CONFLICT', 'the account binding changed before saving', unchanged)
  }
  const lease = await ports.store.getWriterLock().acquire()
  let attempted = false, saved: unknown
  try {
    await fresh()
    const raw = await readRaw(ports.store, feature, first.account)
    if (edgeRevision(raw) !== body.expectedRevision) return fail('CONFLICT', 'saved edge settings changed; read them before saving', unchanged)
    const record = build(raw)
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(ports.store.rootDir, edgeStatePath(feature, first.account.id)), record, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
    saved = await readRaw(ports.store, feature, first.account)
    if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('readback_mismatch')
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved edge settings could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
  const current = await fresh().catch(() => null)
  try { await ports.emitAudit({ actor: first.caller.principal.username, action, target: 'account:' + first.account.username, principalId: first.caller.principal.id, outcome: 'ok', detail }) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  return workspaceJson({ ...view(saved), reconcile: current ? await reconcileOutcome(ports, current) : 'unknown' })
}

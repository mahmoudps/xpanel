import { canonicalIp, fail, isPrivateAddress, isUuid } from '@xpanel/core'
import type { Account, Id, ServerIpEntry } from '@xpanel/core'
import type { StateSnapshot, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { compareServerNetwork, projectServerNetwork } from './server-observation-workspace.ts'
import type { PoolStatus } from './server-observation-workspace.ts'

/**
 * Root IP tools: Change a Site's IP Address, IP Migration Wizard, Rebuild the IP Address Pool, Show/Edit Reserved IPs,
 * Show IP Address Usage, IPv6 Ranges and Assign IPv6. State changes are desired state; the agent binds the addresses
 * and clears a release hold only after it verified the new binding. Binding shown here is always the host's own report.
 */
export interface IpNetworkHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'resolveAccountParam'> {
  store: Pick<StateStore, 'readSnapshot' | 'changeAccountIp' | 'changeAccountIps' | 'migrateIps' | 'rebuildIpPool' | 'updateServerIp' | 'listIpv6Ranges' | 'saveIpv6Ranges' | 'assignAccountIpv6FromRange'>
  /** Applies desired state through the agent; null without one. */
  reconcile: (caller: AuthenticatedCaller) => Promise<{ body: Record<string, unknown> } | null>
  /** The protected agent's /host/server/network read; absent without a host agent. */
  readNetwork?: (caller: AuthenticatedCaller) => Promise<unknown>
}

export interface IpUsageRow {
  id: Id; address: string; version: 4 | 6; role: ServerIpEntry['role']; isPrimary: boolean; reserved: boolean
  releasing: ServerIpEntry['releasing'] | null
  /** 1:1 NAT state of a private address: its public mapping, or unknown; null for a public address */
  nat: { state: 'mapped' | 'unknown'; publicAddress: string | null } | null
  /** the host's report of the address; unverified when the host was not read */
  binding: PoolStatus
  accounts: { id: Id; username: string; field: 'ipv4' | 'ipv6' | 'extraIps' }[]
  domains: { name: string; accountId: Id }[]
  mail: string[]
  resellers: { id: Id; username: string; use: 'delegated' | 'shared' }[]
}

const IP_ROUTE = /^\/api\/accounts\/([^/]+)\/(ip|ipv6)$/
const POOL_ROUTE = /^\/api\/ips\/([0-9a-f-]{36})$/i
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const body = async (request: Request): Promise<Record<string, unknown>> => {
  let value: unknown
  try { value = await request.json() } catch { return fail('VALIDATION', 'a JSON object body is required', { stateChanged: false }) }
  return object(value) ? value : fail('VALIDATION', 'a JSON object body is required', { stateChanged: false })
}
const only = (value: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(value).some(key => !keys.includes(key))) fail('VALIDATION', `accepted fields: ${keys.join(', ')}`, { stateChanged: false })
}

/** Per pool address: who uses it in desired state, and the host's binding report when it was read. */
export function ipUsage(snapshot: Pick<StateSnapshot, 'ipPool' | 'accounts' | 'domains' | 'mailIpConfig' | 'resellers'>, binding: ReadonlyMap<string, PoolStatus> | null): IpUsageRow[] {
  const same = (address: string) => (raw: string | null | undefined): boolean => raw != null && canonicalIp(raw).address === address
  return (snapshot.ipPool ?? []).map(entry => {
    const is = same(entry.address), mail = snapshot.mailIpConfig
    return {
      id: entry.id, address: entry.address, version: entry.version, role: entry.role, isPrimary: entry.isPrimary, reserved: entry.reserved === true, releasing: entry.releasing ?? null,
      binding: binding?.get(entry.address) ?? 'unverified',
      nat: isPrivateAddress(entry.address) ? { state: entry.publicAddress ? 'mapped' : 'unknown', publicAddress: entry.publicAddress ?? null } : null,
      accounts: snapshot.accounts.flatMap((account: Account) => [
        ...(is(account.ipv4) ? [{ id: account.id, username: account.username, field: 'ipv4' as const }] : []),
        ...(is(account.ipv6) ? [{ id: account.id, username: account.username, field: 'ipv6' as const }] : []),
        ...((account.extraIps ?? []).some(is) ? [{ id: account.id, username: account.username, field: 'extraIps' as const }] : []),
      ]),
      domains: snapshot.domains.filter(domain => is(domain.ipv4) || is(domain.ipv6)).map(domain => ({ name: domain.name, accountId: domain.accountId })),
      mail: mail ? [...(is(mail.defaultIpv4) || is(mail.defaultIpv6) ? ['server default'] : []), ...mail.domainOverrides.filter(o => is(o.ipv4) || is(o.ipv6)).map(o => o.domainName)] : [],
      resellers: snapshot.resellers.flatMap(reseller => [
        ...(reseller.delegatedIps.some(is) ? [{ id: reseller.id, username: reseller.username, use: 'delegated' as const }] : []),
        ...(is(reseller.sharedIp) ? [{ id: reseller.id, username: reseller.username, use: 'shared' as const }] : []),
      ]),
    }
  })
}

export async function handleIpNetworkRoute(request: Request, url: URL, method: string, helpers: IpNetworkHelpers): Promise<Response | null> {
  const path = url.pathname
  const accountMatch = IP_ROUTE.exec(path), poolMatch = POOL_ROUTE.exec(path)
  const known = accountMatch || ['/api/ips/migrate', '/api/ips/rebuild', '/api/ips/usage', '/api/ips/ranges', '/api/ips/change-many'].includes(path) || (poolMatch && method === 'PATCH')
  if (!known) return null
  const caller = await helpers.requireCaller(request)
  const audit = (entry: { action: string; target: string; detail: Record<string, unknown> }) => helpers.emitAudit({ actor: caller.principal.username, ...entry, outcome: 'ok', principalId: caller.principal.id })

  if (accountMatch) {
    await helpers.assertRoot(caller, accountMatch[2] === 'ip' ? 'account.ip.change' : 'account.ipv6.assign')
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const account = await helpers.resolveAccountParam(accountMatch[1]!)
    const input = await body(request)
    if (accountMatch[2] === 'ip') {
      only(input, ['ipv4', 'ipv6'])
      const result = await helpers.store.changeAccountIp(account.id, input as { ipv4?: string; ipv6?: string | null })
      await audit({ action: 'account.ip.changed', target: `account:${account.username}`, detail: { from: { ipv4: account.ipv4, ipv6: account.ipv6 ?? null }, to: { ipv4: result.account.ipv4, ipv6: result.account.ipv6 ?? null }, held: result.held } })
      return json({ ...result, reconcile: (await helpers.reconcile(caller))?.body ?? null })
    }
    only(input, ['rangeId'])
    if (typeof input.rangeId !== 'string' || !isUuid(input.rangeId)) return fail('VALIDATION', 'rangeId must be an IPv6 range id', { stateChanged: false })
    const result = await helpers.store.assignAccountIpv6FromRange(account.id, input.rangeId.toLowerCase())
    await audit({ action: 'account.ipv6.assigned', target: `account:${account.username}`, detail: { ipv6: result.ip.address, rangeId: input.rangeId.toLowerCase(), held: result.held } })
    return json({ ...result, reconcile: (await helpers.reconcile(caller))?.body ?? null })
  }

  if (path === '/api/ips/usage') {
    await helpers.assertRoot(caller, 'ips.usage')
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    const snapshot = await helpers.store.readSnapshot()
    let binding: Map<string, PoolStatus> | null = null
    if (helpers.readNetwork) {
      const observed = projectServerNetwork(await helpers.readNetwork(caller))
      binding = new Map(compareServerNetwork(observed, snapshot).pool.map(row => [row.address, row.status]))
    }
    return json({ ips: ipUsage(snapshot, binding), observed: binding !== null })
  }

  if (path === '/api/ips/ranges') {
    await helpers.assertRoot(caller, method === 'GET' ? 'ips.ranges.read' : 'ips.ranges.save')
    if (method === 'GET') return json({ ranges: await helpers.store.listIpv6Ranges() })
    if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    const input = await body(request)
    only(input, ['ranges'])
    const ranges = await helpers.store.saveIpv6Ranges(input.ranges)
    await audit({ action: 'ip.ranges.saved', target: 'ip:ranges', detail: { count: ranges.length } })
    return json({ ranges })
  }

  if (poolMatch) {
    await helpers.assertRoot(caller, 'ips.update')
    const input = await body(request)
    only(input, ['reserved', 'ptrHostname', 'notes', 'publicAddress'])
    const ip = await helpers.store.updateServerIp(poolMatch[1]!.toLowerCase(), input as { reserved?: boolean; ptrHostname?: string | null; notes?: string; publicAddress?: string | null })
    await audit({ action: 'ip.updated', target: `ip:${ip.address}`, detail: { id: ip.id, reserved: ip.reserved === true, ptrHostname: ip.ptrHostname, publicAddress: ip.publicAddress ?? null } })
    return json({ ip })
  }

  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (path === '/api/ips/change-many') {
    await helpers.assertRoot(caller, 'ips.change_many')
    const input = await body(request)
    only(input, ['changes'])
    const results = await helpers.store.changeAccountIps(input.changes as { accountId: Id; ipv4?: string; ipv6?: string | null }[])
    await audit({ action: 'ip.sites_changed', target: 'ip:pool', detail: { accounts: results.map(r => ({ username: r.account.username, ipv4: r.account.ipv4, ipv6: r.account.ipv6 ?? null, held: r.held })) } })
    return json({ results, reconcile: (await helpers.reconcile(caller))?.body ?? null })
  }
  if (path === '/api/ips/migrate') {
    await helpers.assertRoot(caller, 'ips.migrate')
    const input = await body(request)
    only(input, ['mappings'])
    const result = await helpers.store.migrateIps(input.mappings as { from: string; to: string }[])
    await audit({ action: 'ip.migrated', target: 'ip:pool', detail: { moved: result.moved, held: result.held } })
    return json({ ...result, reconcile: (await helpers.reconcile(caller))?.body ?? null })
  }
  await helpers.assertRoot(caller, 'ips.rebuild')
  if (!helpers.readNetwork) return fail('PRECONDITION_FAILED', 'rebuilding the pool reads the host interfaces through the protected agent', { reason: 'host_unavailable', stateChanged: false })
  only(await body(request), [])
  const observed = projectServerNetwork(await helpers.readNetwork(caller))
  if (observed.interfaces.state !== 'read' || observed.interfaces.truncated) return fail('SERVICE_UNAVAILABLE', 'the host interfaces could not be read; the pool was not changed', { reason: 'interfaces_unavailable', stateChanged: false })
  const candidates = observed.interfaces.items.filter(item => !item.loopback).flatMap(item => item.addresses.filter(address => address.scope === 'global')
    .map(address => ({ address: address.address, prefixLength: address.prefixLength, interfaceName: item.name })))
  const result = await helpers.store.rebuildIpPool(candidates)
  await audit({ action: 'ip.pool.rebuilt', target: 'ip:pool', detail: { added: result.added.map(ip => ip.address) } })
  return json({ ...result, reconcile: result.added.length ? (await helpers.reconcile(caller))?.body ?? null : null })
}

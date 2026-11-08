import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { fail, validateDomainName } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { DNS_CLUSTER_MAX_PEERS, DNS_CLUSTER_PROTOCOL, DNS_CLUSTER_STATE, dnsClusterAddress, dnsClusterName, dnsClusterPin, dnsClusterPort, dnsClusterRevision, dnsClusterRole, dnsClusterThreshold, dnsClusterToken, dnsClusterTokenHash, readDnsClusterConfig } from '../../agent/src/dns-cluster-model.ts'
import type { DnsClusterConfig, DnsClusterMember } from '../../agent/src/dns-cluster-model.ts'
import { dnsClusterPinnedCall, DnsClusterTransportError } from '../../agent/src/dns-cluster-transport.ts'
import type { DnsClusterCall } from '../../agent/src/dns-cluster-transport.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface DnsClusterWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: Pick<StateStore, 'rootDir' | 'getWriterLock'>
  /** Protected agent transport; a body sends a POST. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  call?: DnsClusterCall
  now?: () => Date
}
export const DNS_CLUSTER_ROUTE = '/api/server/dns-cluster'
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const same = (left: AuthenticatedCaller, right: AuthenticatedCaller): boolean => left.principal.id === right.principal.id && left.sessionId === right.sessionId && left.apiTokenId === right.apiTokenId

async function bodyOf(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('application/json is required')
  const raw = await request.text()
  let value: unknown
  try { value = raw.length <= 2048 ? JSON.parse(raw) : null } catch { value = null }
  if (!object(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return invalid('unsupported request fields')
  return value
}
const revisionOf = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : invalid('the exact observed revision is required')
const readRaw = async (store: Pick<StateStore, 'rootDir'>): Promise<unknown> => {
  try { return await readJsonIfExists<unknown>(join(store.rootDir, DNS_CLUSTER_STATE)) } catch { return fail('PRECONDITION_FAILED', 'the saved DNS cluster configuration is unreadable', unchanged) }
}

/** Same lease, revision and readback as the other 0600 secret files; a write that was attempted and not read back is reported as unknown. */
async function write(helpers: DnsClusterWorkspaceHelpers, expected: string, change: (config: DnsClusterConfig) => DnsClusterConfig, fresh: () => Promise<unknown>): Promise<DnsClusterConfig> {
  const lease = await helpers.store.getWriterLock().acquire()
  let attempted = false
  try {
    await fresh()
    const raw = await readRaw(helpers.store), config = readDnsClusterConfig(raw)
    if (!config) return fail('PRECONDITION_FAILED', 'the saved DNS cluster configuration is invalid', { ...unchanged, reason: 'cluster_config_invalid' })
    if (dnsClusterRevision(raw) !== expected) return fail('CONFLICT', 'the DNS cluster configuration changed; reload before saving', unchanged)
    const next = { ...change(structuredClone(config)), updatedAt: (helpers.now?.() ?? new Date()).toISOString() }
    if (!readDnsClusterConfig(next)) return invalid('the change would make the cluster configuration invalid')
    await lease.assertFencingToken(); attempted = true
    await atomicWriteJson(join(helpers.store.rootDir, DNS_CLUSTER_STATE), next, 0o600, async () => { await fresh(); await lease.assertFencingToken() })
    if (JSON.stringify(await readRaw(helpers.store)) !== JSON.stringify(next)) throw new Error('readback_mismatch')
    return next
  } catch (error) {
    if (attempted) return fail('SERVICE_UNAVAILABLE', 'the cluster configuration could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    throw error
  } finally { await lease.release() }
}

const memberOf = (name: string, config: DnsClusterConfig): DnsClusterMember => config.members.find(item => item.name === name) ?? fail('NOT_FOUND', 'the member is not saved', unchanged)
/** Proves the address, pin and token before anything is saved. The reason names the failed step and never carries the token. */
async function hello(helpers: DnsClusterWorkspaceHelpers, member: Pick<DnsClusterMember, 'name' | 'address' | 'port' | 'pin' | 'token'>): Promise<void> {
  const refused = (reason: string, message: string): never => fail('PRECONDITION_FAILED', message, { ...unchanged, reason })
  let response
  try { response = await (helpers.call ?? dnsClusterPinnedCall)(member, { method: 'GET', path: '/api/cluster/dns/hello' }) }
  catch (error) {
    const kind = error instanceof DnsClusterTransportError ? error.kind : 'unreachable'
    return refused(kind === 'pin_mismatch' ? 'pin_mismatch' : kind === 'tls_failed' ? 'tls_failed' : 'member_unreachable', kind === 'pin_mismatch' ? 'the member presented a different key than the pin' : 'the member could not be reached')
  }
  const code = object(response.body) && typeof response.body.code === 'string' ? response.body.code : null
  if (response.status === 401) return refused('token_invalid', 'the member refused the token')
  if (response.status !== 200) return refused(code ?? 'member_refused', 'the member refused the call')
  if (!object(response.body) || response.body.protocol !== DNS_CLUSTER_PROTOCOL) return refused('protocol_mismatch', 'the member speaks a different cluster protocol')
}

const hostView = async (helpers: DnsClusterWorkspaceHelpers, caller: AuthenticatedCaller): Promise<{ members: Record<string, unknown>; conflicts: unknown[]; pin: string | null } | null> => {
  if (!helpers.callHost) return null
  try { const value = await helpers.callHost(caller, '/host/dns-cluster'); return object(value) && object(value.members) && Array.isArray(value.conflicts) ? value as { members: Record<string, unknown>; conflicts: unknown[]; pin: string | null } : null } catch { return null }
}
/** Tokens and token hashes stop here: no view carries them. */
function viewOf(raw: unknown, config: DnsClusterConfig | null, host: Awaited<ReturnType<typeof hostView>>) {
  if (!config) return { state: 'invalid' as const, revision: dnsClusterRevision(raw), enabled: false, failureThreshold: null, members: [], inbound: [], conflicts: [], pin: null, observation: 'unavailable' as const }
  return {
    state: raw === null ? 'default' as const : 'saved' as const, revision: dnsClusterRevision(raw), enabled: config.enabled, failureThreshold: config.failureThreshold, updatedAt: config.updatedAt,
    members: config.members.map(({ token: _token, ...member }) => ({ ...member, runtime: host?.members[member.name] ?? null })),
    inbound: config.inbound.map(({ tokenHash: _hash, issuedBy: _issuer, ...peer }) => peer),
    conflicts: host?.conflicts ?? [], pin: host?.pin ?? null, observation: host ? 'read' as const : 'unavailable' as const,
  }
}

/** Root-only. Add and pair members, issue inbound tokens, run a sync. An outbound token enters here once and never leaves. */
export async function handleDnsClusterWorkspaceRoute(request: Request, url: URL, method: string, helpers: DnsClusterWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== DNS_CLUSTER_ROUTE && !url.pathname.startsWith(DNS_CLUSTER_ROUTE + '/')) return null
  const tail = url.pathname.slice(DNS_CLUSTER_ROUTE.length).replace(/^\//, '')
  const action = 'server.dns-cluster.' + (method === 'GET' ? 'read' : 'update')
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (url.search) return invalid('the DNS cluster workspace accepts no query selectors')
  const fresh = async (): Promise<AuthenticatedCaller> => { const current = await helpers.requireCaller(request); await helpers.assertRoot(current, action); return same(caller, current) ? current : fail('FORBIDDEN', 'root authorization changed', unchanged) }
  const audited = async (name: string, target: string, detail: Record<string, unknown>): Promise<void> => {
    try { await helpers.emitAudit({ actor: caller.principal.username, action: 'server.dns-cluster.' + name, target, principalId: caller.principal.id, outcome: 'ok', detail }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true }) }
  }
  const view = async (config: DnsClusterConfig, extra: Record<string, unknown> = {}) => json({ ...viewOf(config, config, await hostView(helpers, caller)), ...extra })
  const allow = (...methods: string[]): Response | null => methods.includes(method) ? null : new Response(null, { status: 405, headers: { allow: methods.join(', ') } })

  if (tail === '') {
    const denied = allow('GET', 'PUT')
    if (denied) return denied
    if (method === 'GET') { const raw = await readRaw(helpers.store); return json(viewOf(raw, readDnsClusterConfig(raw), await hostView(helpers, caller))) }
    const body = await bodyOf(request, ['enabled', 'failureThreshold', 'expectedRevision'])
    if (typeof body.enabled !== 'boolean') return invalid('enabled must be true or false')
    const enabled = body.enabled, failureThreshold = dnsClusterThreshold(body.failureThreshold)
    const next = await write(helpers, revisionOf(body.expectedRevision), config => ({ ...config, enabled, failureThreshold }), fresh)
    await audited('settings_saved', 'dns:cluster', { enabled, failureThreshold })
    return view(next)
  }
  if (tail === 'inbound') {
    const denied = allow('POST')
    if (denied) return denied
    const body = await bodyOf(request, ['name', 'address', 'expectedRevision'])
    const name = dnsClusterName(body.name), address = dnsClusterAddress(body.address)
    const token = 'xpdc_' + randomBytes(32).toString('base64url'), createdAt = (helpers.now?.() ?? new Date()).toISOString()
    const next = await write(helpers, revisionOf(body.expectedRevision), config => {
      if (config.inbound.length >= DNS_CLUSTER_MAX_PEERS) invalid(`at most ${DNS_CLUSTER_MAX_PEERS} inbound members can be saved`)
      if (config.inbound.some(item => item.name === name)) fail('CONFLICT', 'that member already has a token; remove it first', { ...unchanged, reason: 'member_exists' })
      return { ...config, inbound: [...config.inbound, { name, address, tokenHash: dnsClusterTokenHash(token), hint: token.slice(-4), issuedBy: caller.principal.id, createdAt }] }
    }, fresh)
    await audited('inbound_issued', 'dns-member:' + name, { address })
    return view(next, { token })
  }
  const inbound = /^inbound\/([^/]+)$/.exec(tail)
  if (inbound) {
    const denied = allow('DELETE')
    if (denied) return denied
    const name = validateDomainName(decodeURIComponent(inbound[1]!)), body = await bodyOf(request, ['expectedRevision'])
    const next = await write(helpers, revisionOf(body.expectedRevision), config => config.inbound.some(item => item.name === name) ? { ...config, inbound: config.inbound.filter(item => item.name !== name) } : fail('NOT_FOUND', 'the inbound member is not saved', unchanged), fresh)
    await audited('inbound_revoked', 'dns-member:' + name, {})
    return view(next)
  }
  if (tail === 'members') {
    const denied = allow('POST')
    if (denied) return denied
    const body = await bodyOf(request, ['name', 'address', 'port', 'pin', 'token', 'role', 'expectedRevision'])
    const member: DnsClusterMember = { name: dnsClusterName(body.name), address: dnsClusterAddress(body.address), port: dnsClusterPort(body.port), pin: dnsClusterPin(body.pin), token: dnsClusterToken(body.token), role: dnsClusterRole(body.role), createdAt: (helpers.now?.() ?? new Date()).toISOString() }
    await hello(helpers, member)
    const next = await write(helpers, revisionOf(body.expectedRevision), config => {
      if (config.members.length >= DNS_CLUSTER_MAX_PEERS) invalid(`at most ${DNS_CLUSTER_MAX_PEERS} members can be saved`)
      if (config.members.some(item => item.name === member.name)) fail('CONFLICT', 'that member is already saved', { ...unchanged, reason: 'member_exists' })
      return { ...config, members: [...config.members, member] }
    }, fresh)
    await audited('member_added', 'dns-member:' + member.name, { address: member.address, role: member.role })
    return view(next)
  }
  if (tail === 'sync') {
    const denied = allow('POST')
    if (denied) return denied
    const body = await bodyOf(request, ['mode', 'zone', 'member', 'includeMissing', 'force'])
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'synchronising zones needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
    const actor = await fresh()
    const result = await helpers.callHost(actor, '/host/dns-cluster/sync', body)
    await audited('synced', 'dns:cluster', { mode: body.mode, zone: body.zone, member: body.member, forced: body.force })
    return json(result)
  }
  const member = /^members\/([^/]+)(\/reset)?$/.exec(tail)
  if (!member) return fail('NOT_FOUND', 'route not found', unchanged)
  const name = validateDomainName(decodeURIComponent(member[1]!))
  if (member[2]) {
    const denied = allow('POST')
    if (denied) return denied
    if (!helpers.callHost) return fail('PRECONDITION_FAILED', 're-enabling a member needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
    await bodyOf(request, [])
    const actor = await fresh()
    await helpers.callHost(actor, '/host/dns-cluster/reset', { member: name })
    await audited('member_reset', 'dns-member:' + name, {})
    const raw = await readRaw(helpers.store)
    return json(viewOf(raw, readDnsClusterConfig(raw), await hostView(helpers, caller)))
  }
  const denied = allow('PUT', 'DELETE')
  if (denied) return denied
  if (method === 'DELETE') {
    const body = await bodyOf(request, ['expectedRevision'])
    const next = await write(helpers, revisionOf(body.expectedRevision), config => { memberOf(name, config); return { ...config, members: config.members.filter(item => item.name !== name) } }, fresh)
    await audited('member_removed', 'dns-member:' + name, {})
    return view(next)
  }
  const body = await bodyOf(request, ['role', 'pin', 'token', 'expectedRevision'])
  const role = dnsClusterRole(body.role), pin = body.pin === null ? null : dnsClusterPin(body.pin), token = body.token === null ? null : dnsClusterToken(body.token)
  const expected = revisionOf(body.expectedRevision)
  // A new pin or token is proved before it replaces the one that works.
  if (pin || token) { const raw = await readRaw(helpers.store), saved = memberOf(name, readDnsClusterConfig(raw) ?? fail('PRECONDITION_FAILED', 'the saved DNS cluster configuration is invalid', unchanged)); await hello(helpers, { ...saved, pin: pin ?? saved.pin, token: token ?? saved.token }) }
  const next = await write(helpers, expected, config => { const current = memberOf(name, config); return { ...config, members: config.members.map(item => item === current ? { ...item, role, pin: pin ?? item.pin, token: token ?? item.token } : item) } }, fresh)
  await audited('member_updated', 'dns-member:' + name, { role, pinChanged: pin !== null, tokenChanged: token !== null })
  return view(next)
}

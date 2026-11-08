import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isXpanelError, validateDomainName } from '@xpanel/core'
import { readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { applyDnsZoneCopy, DNS_CLUSTER_MAX_ZONE_BYTES, DNS_CLUSTER_PEER_PREFIX, DNS_CLUSTER_PROTOCOL, DNS_CLUSTER_STATE, DNS_CLUSTER_TOKEN, dnsClusterTokenMatches, dnsZoneCopyFromText, readDnsClusterConfig, removeDnsZoneCopy } from '../../agent/src/dns-cluster-model.ts'
import type { DnsClusterInbound } from '../../agent/src/dns-cluster-model.ts'
import type { AuthenticatedCaller } from './auth.ts'

export interface DnsClusterPeerHelpers {
  store: Pick<StateStore, 'rootDir' | 'getDnsZone' | 'saveDnsZone' | 'deleteDnsZone'>
  /** Trusted-ingress client address, never a value the request chose. */
  clientAddress: (request: Request) => string | null
  /** The root who issued the token; a disabled or demoted issuer stops every call. */
  issuer: (principalId: string) => Promise<AuthenticatedCaller>
  callHost: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
  reconcile: (caller: AuthenticatedCaller) => Promise<{ ok: boolean } | null>
  audit: (entry: { actor: string; principalId: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  now?: () => Date
}
const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const refused = (status: number, code: string): Response => reply(status, { code })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

async function bounded(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const next = await reader.read()
    if (next.done) break
    bytes += next.value.byteLength
    if (bytes > max) { await reader.cancel(); return null }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function admit(request: Request, helpers: DnsClusterPeerHelpers): Promise<{ peer: DnsClusterInbound; caller: AuthenticatedCaller } | Response> {
  let raw: unknown
  try { raw = await readJsonIfExists<unknown>(join(helpers.store.rootDir, DNS_CLUSTER_STATE)) } catch { return refused(503, 'cluster_config_unreadable') }
  const config = readDnsClusterConfig(raw)
  if (!config) return refused(503, 'cluster_config_invalid')
  const token = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
  const peer = DNS_CLUSTER_TOKEN.test(token) ? config.inbound.find(item => dnsClusterTokenMatches(token, item.tokenHash)) : undefined
  if (!peer) return refused(401, 'token_invalid')
  if (!config.enabled) return refused(403, 'cluster_disabled')
  if (helpers.clientAddress(request) !== peer.address) return refused(403, 'address_not_allowed')
  try { return { peer, caller: await helpers.issuer(peer.issuedBy) } } catch { return refused(403, 'token_issuer_inactive') }
}

/** Calls from other cluster members. A bearer token and address admit them; no session, cookie or browser reaches this route. */
export async function handleDnsClusterPeerRoute(request: Request, url: URL, method: string, helpers: DnsClusterPeerHelpers): Promise<Response> {
  const admitted = await admit(request, helpers)
  if (admitted instanceof Response) return admitted
  const { peer, caller } = admitted, tail = url.pathname.slice(DNS_CLUSTER_PEER_PREFIX.length), now = helpers.now ?? (() => new Date())
  const audit = (action: string, target: string, outcome: 'ok' | 'failed', detail: Record<string, unknown>) => helpers.audit({ actor: 'cluster:' + peer.name, principalId: caller.principal.id, action, target, outcome, detail }).catch(() => undefined)
  if (tail === 'hello') return method === 'GET' ? reply(200, { protocol: DNS_CLUSTER_PROTOCOL, member: peer.name }) : refused(405, 'method_not_allowed')
  if (tail === 'zones') {
    if (method !== 'GET') return refused(405, 'method_not_allowed')
    try { return reply(200, await helpers.callHost(caller, '/host/dns-cluster/zones')) } catch { return refused(503, 'zones_unreadable') }
  }
  if (tail === 'commit') {
    if (method !== 'POST') return refused(405, 'method_not_allowed')
    const applied = await helpers.reconcile(caller).catch(() => null)
    return reply(200, { outcome: applied?.ok ? 'applied' : 'failed' })
  }
  const match = /^zones\/([^/]+)$/.exec(tail)
  if (!match) return refused(404, 'route_unknown')
  let zone: string
  try { zone = validateDomainName(decodeURIComponent(match[1]!)) } catch { return refused(422, 'zone_invalid') }
  if (method === 'GET') {
    try { return reply(200, await helpers.callHost(caller, '/host/dns-cluster/zone?zone=' + encodeURIComponent(zone))) }
    catch (error) { return isXpanelError(error) && error.code === 'CONFLICT' ? refused(409, 'dnssec_signed') : isXpanelError(error) && error.code === 'NOT_FOUND' ? refused(404, 'zone_not_held') : refused(503, 'zones_unreadable') }
  }
  if (method === 'DELETE') {
    const decision = await removeDnsZoneCopy(helpers.store, peer.name, zone)
    if (decision.action === 'conflict') return reply(409, { outcome: 'conflict', reason: decision.reason })
    if (decision.action === 'write') await audit('dns.cluster.copy_removed', 'dns:' + zone, 'ok', {})
    return reply(200, { outcome: decision.action === 'write' ? 'removed' : 'unchanged' })
  }
  if (method !== 'PUT') return refused(405, 'method_not_allowed')
  const raw = await bounded(request, DNS_CLUSTER_MAX_ZONE_BYTES + 4096)
  if (raw === null) return refused(413, 'zone_too_large')
  let body: unknown
  try { body = JSON.parse(raw) } catch { return refused(422, 'body_invalid') }
  if (!object(body) || Object.keys(body).sort().join() !== 'force,serial,text' || typeof body.text !== 'string' || typeof body.force !== 'boolean') return refused(422, 'body_invalid')
  let decision
  try {
    const copy = dnsZoneCopyFromText(zone, body.text)
    if (copy.serial !== body.serial) return refused(422, 'serial_mismatch')
    decision = await applyDnsZoneCopy(helpers.store, peer.name, copy, { id: randomUUID(), at: now().toISOString(), force: body.force, recordId: randomUUID })
  } catch (error) {
    if (isXpanelError(error) && (error.code === 'VALIDATION' || error.code === 'CONFLICT')) return reply(422, { outcome: 'rejected', code: 'zone_invalid' })
    return refused(503, 'zone_not_saved')
  }
  if (decision.action === 'conflict') {
    await audit('dns.cluster.copy_refused', 'dns:' + zone, 'ok', { reason: decision.reason })
    return reply(409, { outcome: 'conflict', reason: decision.reason })
  }
  if (decision.action === 'write') await audit('dns.cluster.copy_written', 'dns:' + zone, 'ok', { serial: body.serial, forced: body.force })
  return reply(200, { outcome: decision.action === 'write' ? 'written' : 'unchanged' })
}

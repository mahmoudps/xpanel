import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fail, validateDomainName } from '@xpanel/core'
import type { StateStore } from '@xpanel/state'
import { DNSSEC_CURRENT_CONFIG_ARGV, dnssecListKeysArgv } from '../../../packages/os/src/dnssec-command.ts'
import { dnsClusterName, dnsZoneCopyFromText, DNS_CLUSTER_PORT } from './dns-cluster-model.ts'
import type { DnsMemberRuntime } from './dns-cluster-model.ts'
import { createDnsClusterSync, dnsZoneDirStamp, readDnsClusterRuntime, readLocalZones } from './dns-cluster-sync.ts'
import type { DnsClusterSync, DnsClusterSyncDeps, DnsClusterSyncRequest } from './dns-cluster-sync.ts'
import { dnsClusterSpkiPin } from './dns-cluster-transport.ts'
import { dnssecStoreConfigured, parseDnssecKeyList } from './dnssec.ts'
import { listenerTlsPaths, MANAGEMENT_INGRESS_CONF } from './service-detail.ts'
import { DEFAULT_DNS_ZONE_DIR } from './services/dns.ts'

const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const DNS_CLUSTER_SYNC_TIMEOUT_MS = 300_000

/** The key this server presents to members on xWHM, read from the certificate nginx serves there. */
export async function readDnsClusterLocalPin(read: (path: string) => Promise<string> = path => readFile(path, 'utf8')): Promise<string | null> {
  try { const cert = listenerTlsPaths(await read(MANAGEMENT_INGRESS_CONF), DNS_CLUSTER_PORT)[0]?.cert; return cert ? dnsClusterSpkiPin(await read(cert)) : null } catch { return null }
}

/** A zone is signed when the key store holds a key for it; a server with no store signs nothing. */
export const dnsClusterSignedZone = (run: (argv: string[]) => Promise<{ ok: boolean; stdout: string }>) => async (zone: string): Promise<boolean | null> => {
  const config = await run([...DNSSEC_CURRENT_CONFIG_ARGV]).catch(() => null)
  if (!config?.ok) return null
  if (!dnssecStoreConfigured(config.stdout)) return false
  const listed = await run(dnssecListKeysArgv(zone)).catch(() => null)
  return listed?.ok ? parseDnssecKeyList(listed.stdout, zone).length > 0 : null
}

export function createHostDnsClusterSync(input: Pick<DnsClusterSyncDeps, 'rootDir' | 'store' | 'reconcile' | 'audit'> & { run: (argv: string[]) => Promise<{ ok: boolean; stdout: string }>; zoneDir?: string }): DnsClusterSync {
  const zoneDir = input.zoneDir ?? DEFAULT_DNS_ZONE_DIR
  return createDnsClusterSync({ ...input, zoneStamp: dnsZoneDirStamp(zoneDir), signedZone: dnsClusterSignedZone(input.run), readZoneFile: zone => readDnsZoneFile(zoneDir, zone) })
}
async function readDnsZoneFile(zoneDir: string, zone: string): Promise<string | null> {
  try { return await readFile(join(zoneDir, validateDomainName(zone) + '.zone'), 'utf8') } catch { return null }
}

function parseSyncRequest(value: unknown): DnsClusterSyncRequest {
  if (!object(value) || Object.keys(value).sort().join() !== 'force,includeMissing,member,mode,zone') return invalid('mode, zone, member, includeMissing and force are required')
  if (value.mode !== 'push' && value.mode !== 'pull') return invalid('the mode must be push or pull')
  if (typeof value.includeMissing !== 'boolean' || typeof value.force !== 'boolean') return invalid('includeMissing and force must be true or false')
  if (value.force && (value.mode !== 'push' || value.zone === null || value.member === null)) return invalid('overwriting needs one zone and one member')
  return { mode: value.mode, zone: value.zone === null ? null : validateDomainName(value.zone), member: value.member === null ? null : dnsClusterName(value.member), includeMissing: value.includeMissing, force: value.force }
}
const conflictsOf = (name: string, state: DnsMemberRuntime) => Object.entries(state.zones).filter(([, ack]) => ack.state !== 'synced').slice(0, 200).map(([zone, ack]) => ({ member: name, zone, state: ack.state, reason: ack.reason, serial: ack.serial, at: ack.at }))
const summaryOf = (state: DnsMemberRuntime) => ({ state: state.state, failures: state.failures, failureCode: state.failureCode, lastAttemptAt: state.lastAttemptAt, lastSuccessAt: state.lastSuccessAt, outageSince: state.outageSince, nextAttemptAt: state.nextAttemptAt, pending: state.pending, zones: Object.keys(state.zones).length })

export interface DnsClusterHostContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  rootDir: string
  sync: DnsClusterSync | null
  store: Pick<StateStore, 'listDnsZones' | 'getDnsZone'>
  zoneDir?: string
  signedZone?: (zone: string) => Promise<boolean | null>
  pin?: () => Promise<string | null>
}
const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/dns-cluster': { method: 'GET', action: 'dns.cluster.members.read' },
  '/host/dns-cluster/zones': { method: 'GET', action: 'dns.cluster.members.read' },
  '/host/dns-cluster/zone': { method: 'GET', action: 'dns.cluster.members.read' },
  '/host/dns-cluster/sync': { method: 'POST', action: 'dns.cluster.sync' },
  '/host/dns-cluster/reset': { method: 'POST', action: 'dns.cluster.sync' },
}

/** Root-only. Members, tokens and zones come from saved state; a request names them and never supplies them. */
export async function handleDnsClusterHostRoute(req: Request, url: URL, method: string, ctx: DnsClusterHostContext): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const zoneDir = ctx.zoneDir ?? DEFAULT_DNS_ZONE_DIR
  if (url.pathname === '/host/dns-cluster') {
    const runtime = await readDnsClusterRuntime(ctx.rootDir), entries = Object.entries(runtime.members)
    return json({ members: Object.fromEntries(entries.map(([name, state]) => [name, summaryOf(state)])), conflicts: entries.flatMap(([name, state]) => conflictsOf(name, state)).slice(0, 500), pin: await (ctx.pin ?? readDnsClusterLocalPin)() })
  }
  if (url.pathname === '/host/dns-cluster/zones') {
    const source = await readLocalZones({ store: ctx.store, readZoneFile: zone => readDnsZoneFile(zoneDir, zone) })
    const replicas = (await ctx.store.listDnsZones()).filter(zone => zone.replica)
    return json({ zones: [...source.zones.map(zone => ({ zone: zone.zone, serial: zone.serial, origin: 'local' })), ...replicas.map(zone => ({ zone: zone.name, serial: zone.serial, origin: 'replica' }))].slice(0, 5000) })
  }
  if (url.pathname === '/host/dns-cluster/zone') {
    const zone = validateDomainName(url.searchParams.get('zone') ?? ''), held = await ctx.store.getDnsZone(zone)
    if (!held || held.replica) return fail('NOT_FOUND', 'this server is not the source of the zone', unchanged)
    if ((await ctx.signedZone?.(zone)) !== false) return fail('CONFLICT', 'a signed zone is not copied', { ...unchanged, reason: 'dnssec_signed' })
    const text = await readDnsZoneFile(zoneDir, zone)
    if (text === null) return fail('NOT_FOUND', 'the zone has not been published yet', unchanged)
    return json({ zone, serial: dnsZoneCopyFromText(zone, text).serial, text })
  }
  if (!ctx.sync) return fail('PRECONDITION_FAILED', 'cluster synchronisation needs the native Linux host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 1024 ? JSON.parse(text) : null } catch { body = null }
  if (url.pathname === '/host/dns-cluster/sync') return json(await ctx.sync.run(parseSyncRequest(body)))
  if (!object(body) || Object.keys(body).join() !== 'member') return invalid('only the member is accepted')
  const member = dnsClusterName(body.member)
  return await ctx.sync.reset(member) ? json({ member, outcome: 'reset' }) : fail('NOT_FOUND', 'the member has no recorded state', unchanged)
}

import { randomUUID } from 'node:crypto'
import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import { services } from '@xpanel/render'
import type { DnsZoneState, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import { dnsZoneRevision } from './dns-workspace.ts'

export const DNS_ZONE_FILE_ROUTE = /^\/api\/dns\/zones\/([a-z0-9.-]{1,253})\/zone-file$/
export interface ZoneFilePorts {
  store: Pick<StateStore, 'getDnsZone' | 'getAccount' | 'getServerSettings'>
  requireCaller: (req: Request) => Promise<AuthenticatedCaller>
  assertRoot: (caller: AuthenticatedCaller, action: string) => Promise<void>
  assertCanAccessAccount: (caller: AuthenticatedCaller, account: Account, action: string) => Promise<void>
}
type ZoneRecordInput = Pick<DnsZoneState['records'][number], 'name' | 'type' | 'ttl' | 'content' | 'priority'>
export interface ZoneImportDifference { name: string; type: string; current: string | null; imported: string | null; action: 'add' | 'remove' | 'change' }

const unchanged = { stateChanged: false }
const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const canonical = (zone: string, records: readonly ZoneRecordInput[]) => services.validateZone(records.map(record => ({ zone, name: record.name, type: record.type, ttl: record.ttl, content: record.content, priority: record.priority })), { requireSoa: false })
const identity = (record: { name: string; type: string; content: string; priority: number | null }): string => JSON.stringify([record.name, record.type, record.content, record.priority])
const shown = (record: { ttl: number; content: string; priority: number | null }): string => `${record.ttl} ${record.priority === null ? '' : record.priority + ' '}${record.content}`

/** The saved zone as BIND text. The SOA is the one the reconciler publishes; serving-time additions such as mail keys are not saved records. */
export function zoneFileText(zone: DnsZoneState, primaryNameserver: string | undefined): string {
  const primary = (primaryNameserver ?? `ns1.${zone.name}`).replace(/\.$/, '')
  return services.renderBindZone([{ zone: zone.name, name: '@', type: 'SOA', ttl: 3600, content: `${primary}. hostmaster.${zone.name}. ${zone.serial} 3600 1800 1209600 3600`, priority: null }, ...canonical(zone.name, zone.records)])
}

/** Parses a zone file against the saved zone. Nothing is stored: the page saves the returned records through the guarded zone route. */
export function previewZoneImport(zone: DnsZoneState, text: string) {
  const parsed = services.parseBindZone(text, { origin: zone.name })
  const imported = parsed.records.filter(record => record.type !== 'SOA')
  const saved = zone.records.map(record => ({ id: record.id, ...services.validateRecord({ zone: zone.name, name: record.name, type: record.type, ttl: record.ttl, content: record.content, priority: record.priority }) }))
  const savedIds = new Map(saved.map(record => [identity(record), record.id]))
  const before = new Map(saved.map(record => [identity(record), record])), after = new Map(imported.map(record => [identity(record), record]))
  const differences: ZoneImportDifference[] = []
  for (const [key, record] of after) {
    const current = before.get(key)
    if (!current) differences.push({ name: record.name, type: record.type, current: null, imported: shown(record), action: 'add' })
    else if (current.ttl !== record.ttl) differences.push({ name: record.name, type: record.type, current: shown(current), imported: shown(record), action: 'change' })
  }
  for (const [key, record] of before) if (!after.has(key)) differences.push({ name: record.name, type: record.type, current: shown(record), imported: null, action: 'remove' })
  return {
    zone: zone.name, revision: dnsZoneRevision(zone), differences, skipped: parsed.skipped,
    records: imported.map(record => ({ id: savedIds.get(identity(record)) ?? randomUUID(), name: record.name, type: record.type, ttl: record.ttl, content: record.content, ...(record.priority === null ? {} : { priority: record.priority }) })),
  }
}

export async function handleDnsZoneFileRoute(request: Request, url: URL, method: string, ports: ZoneFilePorts): Promise<Response | null> {
  const name = DNS_ZONE_FILE_ROUTE.exec(url.pathname)?.[1]
  if (!name) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  const caller = await ports.requireCaller(request)
  const zone = await ports.store.getDnsZone(name)
  if (!zone) return fail('NOT_FOUND', 'zone not found', unchanged)
  if (zone.accountId) {
    const owner = await ports.store.getAccount(zone.accountId)
    if (!owner) return fail('NOT_FOUND', 'zone not found', unchanged)
    await ports.assertCanAccessAccount(caller, owner, 'dns.zone.file')
  } else await ports.assertRoot(caller, 'dns.zone.file')
  if (method === 'GET') return json({ zone: zone.name, fileName: `${zone.name}.db`, text: zoneFileText(zone, (await ports.store.getServerSettings())?.nameservers[0]) })
  let body: unknown
  try { body = await request.json() } catch { return fail('VALIDATION', 'a JSON object body is required', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'text' || typeof (body as { text: unknown }).text !== 'string') return fail('VALIDATION', 'the zone file text is required', unchanged)
  return json(previewZoneImport(zone, (body as { text: string }).text))
}

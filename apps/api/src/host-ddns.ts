import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { canonicalIp, defaultDdns, fail, HOST_TOOLS_STATE, validateDdns } from '@xpanel/core'
import type { DdnsRecord, DdnsState, DnsRecord } from '@xpanel/core'
import { findPrincipalByUsername } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, backgroundStateWrite, readJsonIfExists } from '@xpanel/state'
import type { DnsZoneState, StateStore } from '@xpanel/state'
import { assertDnsZoneRevision, dnsZoneRevision } from './dns-workspace.ts'
import { CLOUDFLARE_API } from './sec-cloudflare.ts'

export const DDNS_STATUS_STATE = 'extended/server/ddns-status.json'
const TICK_MS = 60_000
const REQUEST_MS = 15_000
export interface DdnsStatus { checkedAt: string | null; ip: string | null; records: Record<string, { ip: string; at: string } | { error: string; at: string }> }
export const emptyDdnsStatus = (): DdnsStatus => ({ checkedAt: null, ip: null, records: {} })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refused = (reason: string): never => fail('PRECONDITION_FAILED', 'the record could not be updated', { stateChanged: false, reason })

export interface DdnsPorts {
  store: Pick<StateStore, 'rootDir' | 'getDnsZone' | 'listDnsZones' | 'saveDnsZone'>
  fetcher: typeof fetch
  reconcile: () => Promise<boolean>
  now?: () => Date
}

const zoneOf = async (ports: DdnsPorts, hostname: string): Promise<DnsZoneState> => {
  const names = (await ports.store.listDnsZones()).map(zone => zone.name).filter(name => hostname === name || hostname.endsWith(`.${name}`)).sort((left, right) => right.length - left.length)
  return (names[0] ? await ports.store.getDnsZone(names[0]) : null) ?? refused('ddns_zone_unknown')
}

async function updateLocal(ports: DdnsPorts, record: DdnsRecord, ip: string, type: 'A' | 'AAAA'): Promise<void> {
  const zone = await zoneOf(ports, record.hostname), name = record.hostname === zone.name ? '@' : record.hostname.slice(0, -zone.name.length - 1)
  const found = zone.records.filter(row => row.name === name && row.type === type)
  if (found.length > 1) refused('ddns_record_ambiguous')
  const row: DnsRecord = found[0] ? { ...found[0], content: ip } : { id: randomUUID(), zone: zone.name, name, type, ttl: 300, content: ip, priority: null }
  const revision = dnsZoneRevision(zone), next = { ...zone, serial: zone.serial === 4294967295 ? 1 : zone.serial + 1, records: found[0] ? zone.records.map(item => item.id === row.id ? row : item) : [...zone.records, row] }
  await backgroundStateWrite(() => ports.store.saveDnsZone(next, { dnsGuard: async current => { assertDnsZoneRevision(current, revision) } }))
  if (!await ports.reconcile()) refused('ddns_reconcile_failed')
}

async function updateCloudflare(ports: DdnsPorts, record: DdnsRecord, ip: string, type: 'A' | 'AAAA'): Promise<void> {
  const call = async (path: string, init?: { method: string; body: unknown }): Promise<Record<string, unknown>> => {
    const response = await ports.fetcher(CLOUDFLARE_API + path, { method: init?.method ?? 'GET', headers: { authorization: `Bearer ${record.secret}`, accept: 'application/json', ...init ? { 'content-type': 'application/json' } : {} }, ...init ? { body: JSON.stringify(init.body) } : {}, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) })
    const body: unknown = await response.json().catch(() => null)
    return object(body) && body.success === true ? body : refused('ddns_provider_refused')
  }
  const labels = record.hostname.split('.')
  let zoneId: string | null = null
  for (let start = 0; start < labels.length - 1 && !zoneId; start++) {
    const found = (await call(`/zones?name=${labels.slice(start).join('.')}`)).result
    zoneId = Array.isArray(found) && object(found[0]) && typeof found[0].id === 'string' ? found[0].id : null
  }
  if (!zoneId) return refused('ddns_zone_unknown')
  const rows = (await call(`/zones/${zoneId}/dns_records?type=${type}&name=${record.hostname}`)).result
  const existing = Array.isArray(rows) && object(rows[0]) && typeof rows[0].id === 'string' ? rows[0].id : null
  const body = { type, name: record.hostname, content: ip, ttl: 300 }
  await call(existing ? `/zones/${zoneId}/dns_records/${existing}` : `/zones/${zoneId}/dns_records`, { method: existing ? 'PATCH' : 'POST', body })
}

async function updateDyndns(ports: DdnsPorts, record: DdnsRecord, ip: string): Promise<void> {
  const target = new URL(record.server)
  target.searchParams.set('hostname', record.hostname)
  target.searchParams.set('myip', ip)
  const response = await ports.fetcher(target, { headers: { authorization: `Basic ${Buffer.from(`${record.username}:${record.secret}`).toString('base64')}`, 'user-agent': 'xPanel-ddns' }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) })
  if (!/^(?:good|nochg)\b/.test((await response.text()).trim())) refused('ddns_provider_refused')
}

const reasonOf = (error: unknown): string => object(error) && object(error.detail) && typeof error.detail.reason === 'string' ? error.detail.reason : 'ddns_provider_unreachable'

/** One check: skipped until its interval passes, and a record is sent only when the address differs from the one last accepted. */
export async function runDdnsCycle(ports: DdnsPorts, options: { force?: boolean } = {}): Promise<DdnsStatus | null> {
  const raw = await readJsonIfExists<unknown>(join(ports.store.rootDir, HOST_TOOLS_STATE.ddns)), state: DdnsState = raw === null ? defaultDdns() : validateDdns(raw)
  if (!state.records.length) return null
  const statusPath = join(ports.store.rootDir, DDNS_STATUS_STATE), saved = await readJsonIfExists<DdnsStatus>(statusPath).catch(() => null), status: DdnsStatus = object(saved) ? saved : emptyDdnsStatus()
  const now = (ports.now ?? (() => new Date()))(), due = status.checkedAt === null || now.getTime() - Date.parse(status.checkedAt) >= state.intervalMinutes * 60_000
  if (!due && !options.force) return status
  const next: DdnsStatus = { ...status, checkedAt: now.toISOString(), records: { ...status.records } }
  let ip: string
  try {
    const response = await ports.fetcher(state.ipSource, { redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) })
    ip = canonicalIp((await response.text()).trim()).address
  } catch {
    await atomicWriteJson(statusPath, { ...next, ip: null }, 0o640)
    return { ...next, ip: null }
  }
  next.ip = ip
  const type = ip.includes(':') ? 'AAAA' : 'A'
  for (const record of state.records) {
    const last = status.records[record.id]
    if (last && 'ip' in last && last.ip === ip) continue
    try {
      if (record.provider === 'local') await updateLocal(ports, record, ip, type)
      else if (record.provider === 'cloudflare') await updateCloudflare(ports, record, ip, type)
      else await updateDyndns(ports, record, ip)
      next.records[record.id] = { ip, at: now.toISOString() }
    } catch (error) { next.records[record.id] = { error: reasonOf(error), at: now.toISOString() } }
  }
  await atomicWriteJson(statusPath, next, 0o640)
  return next
}

/** Reconciles as the root principal through the protected agent channel, as the scheduled alert checks read the host. */
export async function ddnsRootReconcile(input: { db: Db; agentApp: AgentApp; agentToken: string }): Promise<boolean> {
  const principal = await findPrincipalByUsername(input.db, 'root')
  if (!principal || principal.disabled || principal.kind !== 'root') return false
  const response = await input.agentApp.fetch(new Request('http://agent.local/state/apply', { method: 'POST', headers: { ...agentCallerHeaders({ principalId: principal.id, token: input.agentToken }), 'content-type': 'application/json' }, body: JSON.stringify({ force: false }) }))
  await response.body?.cancel()
  return response.status === 200
}

/** In-process schedule in the API service, no timer unit of its own: a saved file with no records costs one small read a minute. */
export function startDdnsScheduler(input: { db: Db; store: DdnsPorts['store']; agentApp: AgentApp; agentToken: string; admit: <T>(task: () => Promise<T>) => Promise<T>; fetcher?: typeof fetch }): { stop: () => Promise<void> } {
  let running: Promise<unknown> | null = null
  const timer = setInterval(() => {
    if (running) return
    running = input.admit(() => runDdnsCycle({ store: input.store, fetcher: input.fetcher ?? fetch, reconcile: () => ddnsRootReconcile(input) })).catch(() => undefined).finally(() => { running = null })
  }, TICK_MS)
  timer.unref()
  return { stop: async () => { clearInterval(timer); await running } }
}

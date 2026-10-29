import { fail, isXpanelError } from '@xpanel/core'
import type { DnsZoneState, StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { assertDnsZoneRevision, dnsZoneRevision } from './dns-workspace.ts'
import { isServiceDetailZone } from '../../../packages/os/src/service-detail-command.ts'
import type { DnsAnswerState, DnsCheckJobSummary, DnsCheckZoneResult, DnsCompareRead, DnsCompareRow, DnsDriftFlag, DnsNameserverHost, DnsNameserverRead, DnsNameserverResult } from '../../agent/src/dns-tools.ts'

export interface DnsToolsWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit' | 'triggerReconcile'> {
  store: Pick<StateStore, 'listDnsZones' | 'getDnsZone' | 'saveDnsZone'>
  /** Protected agent transport; a body sends a POST. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
  now?: () => Date
}
export type TtlApplyState = 'applied' | 'unchanged' | 'conflict' | 'not-found' | 'refused' | 'unknown' | 'not-attempted'
export interface TtlApplyResult { zone: string; state: TtlApplyState; revision: string | null; changes: number }

const ROUTE = /^\/api\/server\/dns-tools(?:\/(check-jobs|compare|nameservers|ttl\/preview|ttl\/apply)(?:\/([^/]+))?)?$/
const KIND = 'dns.tools.check-zones', SERVER = '127.0.0.1', PAGE_SIZE = 25, ZONES_PER_JOB = 32, JOBS_MAX = 64, TTL_ZONES_MAX = 32, TTL_MAX = 2_147_483_647
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const
const CHECK_STATES = ['passed', 'failed', 'unavailable', 'pending', 'not-run'] as const
const ANSWERS = ['answered', 'nxdomain', 'no-data', 'refused', 'servfail', 'no-response', 'unavailable'] as const
const FILE_STATES = ['parsed', 'missing', 'malformed', 'too-large', 'not-regular', 'unreadable', 'not-read'] as const
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !UNSAFE.test(value)
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === 'string' && (allowed as readonly string[]).includes(value)
const host = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/.test(value)
const hosts = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 && value.every(host) && new Set(value).size === value.length
const ip = (value: unknown): value is string => typeof value === 'string' && value.length <= 45 && /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:.]{2,45})$/.test(value)
const unverified = (): never => fail('PRECONDITION_FAILED', 'the DNS tools observation could not be verified', { stateChanged: false, verificationRequired: true })
const review = (): never => fail('PRECONDITION_FAILED', 'the DNS check job submission requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(item => b.includes(item))

function jobSummary(value: unknown): DnsCheckJobSummary {
  if (!object(value) || !uuid(value.id) || !oneOf(value.status, STATUSES) || !text(value.summary, 512) || !int(value.zones, ZONES_PER_JOB) || value.zones < 1 || !iso(value.createdAt)
    || value.startedAt !== null && !iso(value.startedAt) || value.finishedAt !== null && !iso(value.finishedAt) || value.error !== null && !text(value.error, 1024)) return unverified()
  return { id: value.id, status: value.status, summary: value.summary, zones: value.zones, createdAt: value.createdAt, startedAt: value.startedAt as string | null, finishedAt: value.finishedAt as string | null, error: value.error as string | null }
}

export function projectCheckJobs(value: unknown): { jobs: DnsCheckJobSummary[] } {
  if (!object(value) || !Array.isArray(value.jobs) || value.jobs.length > JOBS_MAX) return unverified()
  const jobs = value.jobs.map(jobSummary)
  return new Set(jobs.map(job => job.id)).size === jobs.length ? { jobs } : unverified()
}

export function projectCheckJob(value: unknown, id: string): { job: DnsCheckJobSummary; logAvailable: boolean; logTruncated: boolean; results: DnsCheckZoneResult[] } {
  if (!object(value) || typeof value.logAvailable !== 'boolean' || typeof value.logTruncated !== 'boolean' || !Array.isArray(value.results)) return unverified()
  const job = jobSummary(value.job)
  if (job.id !== id || value.results.length !== job.zones) return unverified()
  const results = value.results.map((raw): DnsCheckZoneResult => {
    if (!object(raw) || raw.zone !== null && !isServiceDetailZone(raw.zone) || !oneOf(raw.state, CHECK_STATES) || !Array.isArray(raw.messages) || raw.messages.length > 20 || !raw.messages.every(item => text(item, 300))) return unverified()
    const counted = raw.state === 'passed' || raw.state === 'failed', numbers = [raw.records, raw.errors, raw.warnings]
    if (counted ? !numbers.every(item => int(item)) || (raw.state === 'passed') !== (raw.errors === 0) : numbers.some(item => item !== null)) return unverified()
    return { zone: raw.zone as string | null, state: raw.state, records: raw.records as number | null, errors: raw.errors as number | null, warnings: raw.warnings as number | null, messages: raw.messages as string[] }
  })
  return { job, logAvailable: value.logAvailable, logTruncated: value.logTruncated, results }
}

const pageOf = (value: Record<string, unknown>, page: number): boolean => iso(value.observedAt) && value.server === SERVER && value.page === page && int(value.pages) && value.pages >= page && int(value.total)
  && Math.max(1, Math.ceil(value.total / PAGE_SIZE)) === value.pages && Array.isArray(value.zones) && value.zones.length === Math.min(PAGE_SIZE, Math.max(0, value.total - (page - 1) * PAGE_SIZE))

/** Recomputes every drift flag from the projected facts; a host read that disagrees with itself is refused. */
export const driftOf = (saved: DnsCompareRow['saved'], live: DnsCompareRow['live']): DnsDriftFlag[] => {
  const drift: DnsDriftFlag[] = []
  if (live.state !== 'answered') drift.push('not-answered')
  if (saved.file !== 'parsed') drift.push('file-not-parsed')
  if (live.serial !== null && saved.fileSerial !== null && live.serial !== saved.fileSerial) drift.push('serial-differs-from-file')
  if (live.serial !== null && saved.stateSerial !== null && live.serial < saved.stateSerial) drift.push('serial-behind-saved')
  if (live.nsState !== 'answered') drift.push('ns-not-answered'); else if (!sameSet(live.ns, saved.ns)) drift.push('ns-differs')
  return drift
}

export function projectCompare(value: unknown, page: number): DnsCompareRead {
  if (!object(value) || !pageOf(value, page) || !oneOf(value.control, ['reachable', 'unreachable', 'unavailable'] as const)) return unverified()
  const seen = new Set<string>()
  const zones = (value.zones as unknown[]).map((raw): DnsCompareRow => {
    if (!object(raw) || !isServiceDetailZone(raw.zone) || seen.has(raw.zone) || !object(raw.saved) || !object(raw.live) || !Array.isArray(raw.drift)) return unverified()
    const { saved: s, live: l } = raw
    if (s.stateSerial !== null && !int(s.stateSerial, 4294967295) || !oneOf(s.file, FILE_STATES) || (s.fileSerial === null) === (s.file === 'parsed') || s.fileSerial !== null && !int(s.fileSerial, 4294967295) || !hosts(s.ns)
      || !oneOf(l.state, ANSWERS) || (l.serial === null) === (l.state === 'answered') || l.serial !== null && !int(l.serial, 4294967295) || !oneOf(l.nsState, ANSWERS) || !hosts(l.ns) || l.nsState !== 'answered' && l.ns.length) return unverified()
    seen.add(raw.zone)
    const saved = { stateSerial: s.stateSerial as number | null, file: s.file, fileSerial: s.fileSerial as number | null, ns: s.ns }, live = { state: l.state, serial: l.serial as number | null, nsState: l.nsState, ns: l.ns }
    const drift = driftOf(saved, live)
    return raw.drift.length === drift.length && raw.drift.every((flag, index) => flag === drift[index]) ? { zone: raw.zone, saved, live, drift } : unverified()
  })
  return { observedAt: value.observedAt as string, server: SERVER, control: value.control, page, pages: value.pages as number, total: value.total as number, zones }
}

const nameserverResult = (state: DnsAnswerState, addresses: { thisServer: boolean }[], soa: DnsAnswerState): DnsNameserverResult =>
  state === 'answered' ? addresses.some(item => item.thisServer) ? soa === 'answered' ? 'answers' : 'no-answer' : 'other-server'
    : state === 'nxdomain' || state === 'no-data' ? 'not-resolved' : state === 'refused' ? 'not-local' : 'unavailable'

export function projectNameservers(value: unknown, page: number): DnsNameserverRead {
  if (!object(value) || !pageOf(value, page)) return unverified()
  const seen = new Set<string>()
  const zones = (value.zones as unknown[]).map(raw => {
    if (!object(raw) || !isServiceDetailZone(raw.zone) || seen.has(raw.zone) || !oneOf(raw.soa, ANSWERS) || typeof raw.truncated !== 'boolean' || !Array.isArray(raw.nameservers) || raw.nameservers.length > 16) return unverified()
    seen.add(raw.zone)
    const soa = raw.soa, names = new Set<string>()
    const nameservers = raw.nameservers.map((item): DnsNameserverHost => {
      if (!object(item) || !isServiceDetailZone(item.host) || names.has(item.host) || !oneOf(item.state, ANSWERS) || !Array.isArray(item.addresses) || item.addresses.length > 32
        || !item.addresses.every(entry => object(entry) && ip(entry.address) && typeof entry.thisServer === 'boolean') || (item.addresses.length > 0) !== (item.state === 'answered')) return unverified()
      names.add(item.host)
      const addresses = (item.addresses as Record<string, unknown>[]).map(entry => ({ address: entry.address as string, thisServer: entry.thisServer as boolean }))
      const result = item.result === 'not-checked' && item.state === 'unavailable' ? 'not-checked' : nameserverResult(item.state, addresses, soa)
      return item.result === result ? { host: item.host, state: item.state, addresses, result } : unverified()
    })
    return { zone: raw.zone, soa, nameservers, truncated: raw.truncated }
  })
  return { observedAt: value.observedAt as string, server: SERVER, page, pages: value.pages as number, total: value.total as number, zones }
}

export function projectCheckSubmission(value: unknown): { jobs: { id: string; status: string; zones: number }[]; zones: number; notQueued: number; incomplete: boolean } {
  if (!object(value) || !Array.isArray(value.jobs) || value.jobs.length < 1 || value.jobs.length > JOBS_MAX || !int(value.zones) || !int(value.notQueued) || typeof value.incomplete !== 'boolean') return review()
  const jobs = value.jobs.map(job => object(job) && uuid(job.id) && job.kind === KIND && oneOf(job.status, STATUSES) && int(job.zones, ZONES_PER_JOB) && job.zones >= 1 ? { id: job.id, status: job.status, zones: job.zones } : review())
  return { jobs, zones: value.zones, notQueued: value.notQueued, incomplete: value.incomplete }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const raw = await request.text()
  if (raw.length > 16_384) return fail('VALIDATION', 'DNS tools request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  return object(body) ? body : fail('VALIDATION', 'request body must be an object', unchanged)
}

const ttlOf = (value: unknown): number => int(value, TTL_MAX) ? value : fail('VALIDATION', `ttl must be an integer in 0..${TTL_MAX} seconds`, unchanged)
const exactKeys = (body: Record<string, unknown>, keys: readonly string[]): void => { if (Object.keys(body).length !== keys.length || !keys.every(key => Object.hasOwn(body, key))) fail('VALIDATION', 'unsupported DNS tools request field', unchanged) }
const zoneList = <T>(value: unknown, read: (item: unknown) => T, name: (item: T) => string): T[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > TTL_ZONES_MAX) return fail('VALIDATION', `1..${TTL_ZONES_MAX} zones are required`, unchanged)
  const items = value.map(read)
  return new Set(items.map(name)).size === items.length ? items : fail('VALIDATION', 'each zone may be listed once', unchanged)
}
const zoneName = (item: unknown): string => isServiceDetailZone(item) ? item : fail('VALIDATION', 'zones must be canonical saved zone names', unchanged)
const ttlRange = (zone: DnsZoneState): { minTtl: number | null; maxTtl: number | null } => zone.records.length ? { minTtl: Math.min(...zone.records.map(record => record.ttl)), maxTtl: Math.max(...zone.records.map(record => record.ttl)) } : { minTtl: null, maxTtl: null }

/** Root-only xWHM DNS tools. Checks and comparisons are host reads; the bulk TTL change reuses the zone store's revision-bound write. */
export async function handleDnsToolsWorkspaceRoute(request: Request, url: URL, method: string, helpers: DnsToolsWorkspaceHelpers): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match || match[2] !== undefined && match[1] !== 'check-jobs') return null
  const [, tool, id] = match, writing = method === 'POST' && (tool === 'ttl/apply' || tool === 'check-jobs' && id === undefined)
  const action = tool === 'ttl/apply' ? 'server.dns-tools.ttl' : writing ? 'server.dns-tools.check' : 'server.dns-tools.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = tool === 'check-jobs' && id === undefined ? 'GET, POST' : tool?.startsWith('ttl/') ? 'POST' : 'GET'
  if (!allow.split(', ').includes(method)) return new Response(null, { status: 405, headers: { allow } })
  const paged = tool === 'compare' || tool === 'nameservers', query = [...url.searchParams]
  if (paged ? query.length !== 1 || query[0]![0] !== 'page' || !/^[1-9][0-9]{0,3}$/.test(query[0]![1]) : url.search) return fail('VALIDATION', paged ? 'exactly one page number is required' : 'DNS tools do not accept selectors here', unchanged)
  if (id !== undefined && !uuid(id)) return fail('VALIDATION', 'a lowercase job id is required', unchanged)
  const observedAt = (): string => (helpers.now?.() ?? new Date()).toISOString()

  if (tool === undefined) {
    const zones = (await helpers.store.listDnsZones()).filter(zone => isServiceDetailZone(zone.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    return json({ observedAt: observedAt(), zones: zones.map(zone => ({ zone: zone.name, revision: dnsZoneRevision(zone), records: zone.records.length, ...ttlRange(zone) })) })
  }
  if (tool === 'ttl/preview') {
    const body = await readBody(request)
    exactKeys(body, ['ttl', 'zones'])
    const ttl = ttlOf(body.ttl), zones = zoneList(body.zones, zoneName, name => name)
    const rows = []
    for (const name of zones) {
      const zone = await helpers.store.getDnsZone(name)
      const changes = zone ? zone.records.filter(record => record.ttl !== ttl).length : 0
      rows.push({ zone: name, state: !zone ? 'not-found' : changes ? 'ready' : 'unchanged', revision: dnsZoneRevision(zone), records: zone?.records.length ?? 0, changes, ...(zone ? ttlRange(zone) : { minTtl: null, maxTtl: null }) })
    }
    return json({ observedAt: observedAt(), ttl, zones: rows })
  }
  if (tool === 'ttl/apply') {
    const body = await readBody(request)
    exactKeys(body, ['ttl', 'zones'])
    const ttl = ttlOf(body.ttl)
    const zones = zoneList(body.zones, item => {
      if (!object(item) || Object.keys(item).length !== 2 || typeof item.expectedZoneRevision !== 'string' || !/^[0-9a-f]{64}$/.test(item.expectedZoneRevision)) return fail('VALIDATION', 'each zone needs exactly its name and expectedZoneRevision', unchanged)
      return { zone: zoneName(item.zone), expected: item.expectedZoneRevision }
    }, item => item.zone)
    return json(await applyTtl(request, caller, action, ttl, zones, helpers))
  }
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'DNS tools require a connected host agent', unchanged)
  if (paged) {
    const page = Number(query[0]![1]), value = await helpers.callHost(caller, '/host/dns-tools/' + tool + '?page=' + page)
    return json(tool === 'compare' ? projectCompare(value, page) : projectNameservers(value, page))
  }
  if (!writing) return json(id === undefined ? projectCheckJobs(await helpers.callHost(caller, '/host/dns-tools/check-jobs')) : projectCheckJob(await helpers.callHost(caller, '/host/dns-tools/check-jobs/' + id), id))
  const raw = (await request.text()).trim()
  if (raw !== '' && raw !== '{}') return fail('VALIDATION', 'check jobs accept no request fields', unchanged)
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, action)
  if (fresh.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'DNS tools authority changed', unchanged)
  return json(projectCheckSubmission(await helpers.callHost(fresh, '/host/dns-tools/check-jobs', {})), 202)
}

/** One revision-bound zone write per zone; each saved effect is proven by a re-read. A changed authority or an unknown write stops the remaining zones. */
async function applyTtl(request: Request, caller: AuthenticatedCaller, action: string, ttl: number, zones: { zone: string; expected: string }[], helpers: DnsToolsWorkspaceHelpers) {
  const results: TtlApplyResult[] = []
  let stop = false, auditIncomplete = false
  for (const { zone: name, expected } of zones) {
    if (stop) { results.push({ zone: name, state: 'not-attempted', revision: null, changes: 0 }); continue }
    const current = await helpers.store.getDnsZone(name)
    if (!current) { results.push({ zone: name, state: 'not-found', revision: null, changes: 0 }); continue }
    if (dnsZoneRevision(current) !== expected) { results.push({ zone: name, state: 'conflict', revision: null, changes: 0 }); continue }
    const changes = current.records.filter(record => record.ttl !== ttl).length
    if (!changes) { results.push({ zone: name, state: 'unchanged', revision: expected, changes: 0 }); continue }
    let saved: DnsZoneState
    try {
      saved = await helpers.store.saveDnsZone({ ...current, serial: current.serial + 1, records: current.records.map(record => ({ ...record, ttl })) }, { dnsGuard: async latest => {
        assertDnsZoneRevision(latest, expected)
        const fresh = await helpers.requireCaller(request)
        await helpers.assertRoot(fresh, action)
        if (fresh.principal.id !== caller.principal.id) fail('FORBIDDEN', 'DNS tools authority changed', unchanged)
      } })
    } catch (error) {
      const code = isXpanelError(error) ? error.code : null
      if (code === 'CONFLICT') results.push({ zone: name, state: 'conflict', revision: null, changes: 0 })
      else if (code === 'VALIDATION') results.push({ zone: name, state: 'refused', revision: null, changes: 0 })
      else { results.push({ zone: name, state: code === 'FORBIDDEN' || code === 'UNAUTHENTICATED' ? 'refused' : 'unknown', revision: null, changes: 0 }); stop = true }
      continue
    }
    const reread = await helpers.store.getDnsZone(name).catch(() => null), revision = dnsZoneRevision(reread)
    if (!reread || revision !== dnsZoneRevision(saved) || !reread.records.every(record => record.ttl === ttl)) { results.push({ zone: name, state: 'unknown', revision: null, changes }); stop = true; continue }
    results.push({ zone: name, state: 'applied', revision, changes })
    try { await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'dns.zone.saved', target: 'zone:' + name, outcome: 'ok', detail: { tool: 'bulk-ttl', ttl, records: changes } }) } catch { auditIncomplete = true }
  }
  let reconcile: 'not-needed' | 'requested' | 'failed' | 'not-connected' | 'unknown' = 'not-needed'
  if (results.some(item => item.state === 'applied')) {
    try { const outcome = await helpers.triggerReconcile(caller); reconcile = outcome === null ? 'not-connected' : outcome.ok ? 'requested' : 'failed' } catch { reconcile = 'unknown' }
  }
  return { ttl, results, reconcile, auditIncomplete }
}


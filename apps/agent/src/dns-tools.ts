import { Resolver } from 'node:dns/promises'
import { networkInterfaces } from 'node:os'
import { fail, msgid } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobView } from './host-job-contract.ts'
import type { HostJobRunner } from './host-jobs.ts'
import { HOST_JOB_LOG_READ_MAX } from './host-jobs.ts'
import { checkDnsZone, readDnsServiceDetail } from './service-detail.ts'
import type { DnsServiceDetail, ServiceDetailHost, ServiceDetailState, ZoneFileState } from './service-detail.ts'
import { isServiceDetailCommand, isServiceDetailZone, pdnsCheckZoneArgv } from '../../../packages/os/src/service-detail-command.ts'

export const DNS_CHECK_JOB_KIND = 'dns.tools.check-zones'
// validateHostJobPlan admits 1..32 steps, so further zones are paged into additional jobs.
export const DNS_CHECK_ZONES_PER_JOB = 32
// shortcut: one request queues at most 64 jobs (2048 zones); raise together with HOST_JOB_LIST_MAX if a server holds more.
export const DNS_CHECK_JOBS_MAX = 64
// Every query of one page is sent at once and bounded by one resolver timeout, well inside the API's agent timeout.
export const DNS_TOOLS_PAGE_SIZE = 25
export const DNS_TOOLS_SERVER = '127.0.0.1'
const NS_PER_ZONE_MAX = 16, NS_HOSTS_PER_PAGE_MAX = 32, MESSAGES_MAX = 20, STEP_TIMEOUT_MS = 120_000

export type DnsToolsJobs = Pick<HostJobRunner, 'list' | 'get' | 'readLog'>
export interface DnsToolsZone { name: string; serial: number; records: readonly { name: string; type: string; content: string }[] }
export interface DnsToolsState extends ServiceDetailState { zones: readonly DnsToolsZone[] }
export interface DnsToolsResolver { soaSerial(zone: string): Promise<number>; ns(zone: string): Promise<string[]>; v4(host: string): Promise<string[]>; v6(host: string): Promise<string[]> }
export type DnsAnswerState = 'answered' | 'nxdomain' | 'no-data' | 'refused' | 'servfail' | 'no-response' | 'unavailable'
export type DnsDriftFlag = 'not-answered' | 'file-not-parsed' | 'serial-differs-from-file' | 'serial-behind-saved' | 'ns-not-answered' | 'ns-differs'
export interface DnsCompareRow {
  zone: string
  saved: { stateSerial: number | null; file: ZoneFileState; fileSerial: number | null; ns: string[] }
  live: { state: DnsAnswerState; serial: number | null; nsState: DnsAnswerState; ns: string[] }
  drift: DnsDriftFlag[]
}
export interface DnsCompareRead { observedAt: string; server: string; control: DnsServiceDetail['control']['state']; page: number; pages: number; total: number; zones: DnsCompareRow[] }
export type DnsNameserverResult = 'answers' | 'no-answer' | 'other-server' | 'not-resolved' | 'not-local' | 'unavailable' | 'not-checked'
export interface DnsNameserverHost { host: string; state: DnsAnswerState; addresses: { address: string; thisServer: boolean }[]; result: DnsNameserverResult }
export interface DnsNameserverRow { zone: string; soa: DnsAnswerState; nameservers: DnsNameserverHost[]; truncated: boolean }
export interface DnsNameserverRead { observedAt: string; server: string; page: number; pages: number; total: number; zones: DnsNameserverRow[] }
export type DnsCheckState = 'passed' | 'failed' | 'unavailable' | 'pending' | 'not-run'
export interface DnsCheckZoneResult { zone: string | null; state: DnsCheckState; records: number | null; errors: number | null; warnings: number | null; messages: string[] }
export interface DnsCheckJobSummary { id: string; status: HostJobView['status']; summary: string; zones: number; createdAt: string; startedAt: string | null; finishedAt: string | null; error: string | null }

const byName = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const hostName = (value: string): string => value.toLowerCase().replace(/\.$/, '')
/** Lowercase host names of LDH or underscore labels, without a trailing dot. */
export const isDnsToolsHost = (value: unknown): value is string => typeof value === 'string' && value.length <= 253 && /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/.test(value)
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort(byName).every((item, index) => item === [...b].sort(byName)[index])

/** Saved zones xPanel renders, in name order; the only zones these tools name. */
export const savedDnsZones = (state: DnsToolsState): DnsToolsZone[] => state.zones.filter(zone => isServiceDetailZone(zone.name)).sort((a, b) => byName(a.name, b.name))
/** Apex NS targets from saved records. The renderer refuses a target that is not a host name, so such a record is never published and is not compared. */
export const savedNameservers = (zone: DnsToolsZone): string[] => [...new Set(zone.records.filter(record => record.type === 'NS' && record.name === '@').map(record => hostName(record.content)).filter(isDnsToolsHost))].sort(byName)

const STEP_TITLE = msgid('Check zone {zone}')
// Step title values are bounded to 160 characters; a long zone is named by its position and recovered from the log.
const stepTitle = (zone: string, index: number): Pick<HostJobCommandStep, 'title' | 'titleValues'> =>
  ({ title: STEP_TITLE, titleValues: { zone: ('Check zone ' + zone).length <= 160 ? zone : String(index + 1) } })

/** One read-only host job per 32 saved zones: pdnsutil check-zone for each, nothing else. */
export function buildDnsCheckPlans(zones: readonly string[]): HostJobPlan[] {
  if (!Array.isArray(zones) || zones.length < 1 || zones.length > DNS_CHECK_ZONES_PER_JOB * DNS_CHECK_JOBS_MAX || !zones.every(isServiceDetailZone) || new Set(zones).size !== zones.length)
    return fail('VALIDATION', `1..${DNS_CHECK_ZONES_PER_JOB * DNS_CHECK_JOBS_MAX} distinct saved zones are required`, { stateChanged: false })
  const plans: HostJobPlan[] = []
  for (let start = 0; start < zones.length; start += DNS_CHECK_ZONES_PER_JOB) {
    const chunk = zones.slice(start, start + DNS_CHECK_ZONES_PER_JOB), last = start + chunk.length, allowed = new Set(chunk)
    plans.push({
      kind: DNS_CHECK_JOB_KIND, summary: `Check DNS zones ${start + 1}-${last} of ${zones.length}`, accountId: null,
      fingerprint: { zones: chunk }, detail: { first: start + 1, last, total: zones.length },
      // pdnsutil(1) check-zone exits 1 when it found errors; that is a completed check, so later zones still run.
      steps: chunk.map((zone, index) => ({ id: 'zone-' + (index + 1), ...stepTitle(zone, index), argv: pdnsCheckZoneArgv(zone), timeoutMs: STEP_TIMEOUT_MS, mutates: false, successExitCodes: [1] })),
      policy: argv => isServiceDetailCommand(argv) && argv.length === 3 && argv[1] === 'check-zone' && allowed.has(argv[2]!),
    })
  }
  return plans
}

// host-jobs.ts writes "\n<ISO> step i/n <id>", then "$ <argv>", the output, and "[exit <code|none>[, timed out]]".
const STEP_HEADER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z step (\d{1,2})\/(\d{1,2}) (zone-\d{1,2})$/
const COMMAND = /^\$ \/usr\/bin\/pdnsutil check-zone (\S{1,253})$/
const EXIT = /^\[exit (\d{1,3}|none)(, timed out)?\]$/
interface LogSection { zone: string | null; body: string[]; exit: number | null; complete: boolean; timedOut: boolean }

/** Step sections of one check job log. Saved record content cannot hold a line break, so pdnsutil output cannot start a runner line. */
export function dnsCheckLogSections(log: string, steps: number): Map<string, LogSection> {
  const raw = new Map<string, { command: string | null; lines: string[] }>()
  let current: { command: string | null; lines: string[] } | null = null
  for (const line of log.split('\n')) {
    const header = STEP_HEADER.exec(line)
    if (header && Number(header[2]) === steps && header[3] === 'zone-' + header[1] && !raw.has(header[3]!)) { current = { command: null, lines: [] }; raw.set(header[3]!, current); continue }
    if (!current) continue
    if (current.command === null) current.command = line; else current.lines.push(line)
  }
  const sections = new Map<string, LogSection>()
  for (const [id, section] of raw) {
    const zone = COMMAND.exec(section.command ?? '')?.[1] ?? null
    let end = section.lines.length - 1
    while (end >= 0 && !EXIT.test(section.lines[end]!)) end -= 1
    const exit = end >= 0 ? EXIT.exec(section.lines[end]!) : null
    sections.set(id, { zone: zone && isServiceDetailZone(zone) ? zone : null, body: exit ? section.lines.slice(0, end) : [], exit: exit && exit[1] !== 'none' ? Number(exit[1]) : null, complete: !!exit, timedOut: !!exit?.[2] })
  }
  return sections
}

const titleZone = (step: HostJobView['steps'][number]): string | null => { const zone = step.title === STEP_TITLE ? step.titleValues?.zone ?? '' : ''; return isServiceDetailZone(zone) ? zone : null }

/** Per-zone results of one check job. The step exit code from the durable job record decides passed or failed; the log only supplies counts and messages. */
export async function parseDnsCheckJob(job: HostJobView, log: string): Promise<DnsCheckZoneResult[]> {
  const sections = dnsCheckLogSections(log, job.steps.length), finished = job.status !== 'queued' && job.status !== 'running'
  const results: DnsCheckZoneResult[] = []
  for (const step of job.steps) {
    const section = sections.get(step.id), named = titleZone(step)
    const zone = named ?? section?.zone ?? null, empty = { records: null, errors: null, warnings: null, messages: [] }
    if (step.state === 'pending') { results.push({ zone, state: finished ? 'not-run' : 'pending', ...empty }); continue }
    if (step.state === 'skipped') { results.push({ zone, state: 'not-run', ...empty }); continue }
    if (step.state === 'running' && !finished) { results.push({ zone, state: 'pending', ...empty }); continue }
    if (step.state !== 'succeeded' || !zone || !section?.complete || section.timedOut || section.zone !== zone || section.exit === null || section.exit !== step.exitCode) { results.push({ zone, state: 'unavailable', ...empty }); continue }
    const exit = section.exit, check = await checkDnsZone({ zone, run: async () => ({ ok: exit === 0, code: exit, stdout: section.body.join('\n'), stderr: '' }) })
    results.push({ zone, state: check.state, records: check.records, errors: check.errors, warnings: check.warnings, messages: check.messages.slice(0, MESSAGES_MAX) })
  }
  return results
}

/** The whole job log, read in bounded windows up to the runner's 4 MiB cap. */
export async function readDnsCheckLog(jobs: Pick<DnsToolsJobs, 'readLog'>, id: string): Promise<{ text: string; truncated: boolean } | null> {
  let offset = 0, text = ''
  for (;;) {
    const part = await jobs.readLog(id, offset, HOST_JOB_LOG_READ_MAX)
    if (!part.available) return null
    text += part.text
    if (part.nextOffset >= part.total || part.nextOffset <= offset) return { text, truncated: part.truncated }
    offset = part.nextOffset
  }
}

export const dnsCheckJobSummary = (job: HostJobView): DnsCheckJobSummary =>
  ({ id: job.id, status: job.status, summary: job.summary, zones: job.steps.length, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error })

const ANSWER_FAILURES: Readonly<Record<string, DnsAnswerState>> = { ENOTFOUND: 'nxdomain', ENODATA: 'no-data', EREFUSED: 'refused', ESERVFAIL: 'servfail', ETIMEOUT: 'no-response', ECONNREFUSED: 'no-response', ECANCELLED: 'no-response' }
const failure = (error: unknown): DnsAnswerState => { const code = String((error as { code?: unknown } | null)?.code ?? ''); return Object.hasOwn(ANSWER_FAILURES, code) ? ANSWER_FAILURES[code]! : 'unavailable' }
const answer = async <T>(query: () => Promise<T>): Promise<{ state: DnsAnswerState; value: T | null }> => { try { return { state: 'answered', value: await query() } } catch (error) { return { state: failure(error), value: null } } }
const serial = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 4294967295 ? value : null
const names = (value: unknown): string[] | null => { const list = Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string') ? [...new Set(value.map(hostName))] : null; return list?.every(isDnsToolsHost) ? list.sort(byName) : null }
const addresses = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length <= 45 && /^[0-9a-f.:]+$/i.test(item)).slice(0, 16).map(item => item.toLowerCase()) : []

/** Queries only the server's own authoritative listener; there is no recursion through any other resolver. */
export function localAuthoritativeResolver(): DnsToolsResolver {
  const resolver = new Resolver({ timeout: 1500, tries: 1 })
  resolver.setServers([DNS_TOOLS_SERVER])
  return { soaSerial: async zone => (await resolver.resolveSoa(zone)).serial, ns: zone => resolver.resolveNs(zone), v4: host => resolver.resolve4(host), v6: host => resolver.resolve6(host) }
}
export const hostAddresses = (): string[] => Object.values(networkInterfaces()).flatMap(items => (items ?? []).map(item => item.address.toLowerCase()))

const page = (total: number, requested: number): { page: number; pages: number; start: number } => {
  const pages = Math.max(1, Math.ceil(total / DNS_TOOLS_PAGE_SIZE))
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > pages) return fail('VALIDATION', `page must be 1..${pages}`, { stateChanged: false })
  return { page: requested, pages, start: (requested - 1) * DNS_TOOLS_PAGE_SIZE }
}

async function liveSoa(resolver: DnsToolsResolver, zone: string): Promise<{ state: DnsAnswerState; serial: number | null }> {
  const soa = await answer(() => resolver.soaSerial(zone)), value = serial(soa.value)
  return soa.state === 'answered' && value === null ? { state: 'unavailable', serial: null } : { state: soa.state, serial: value }
}

/** Published (the local authoritative answer) against saved (state serial, rendered zone file and saved apex NS) for one page of zones. */
export async function compareDnsZones(input: { host: ServiceDetailHost; state: DnsToolsState; resolver: DnsToolsResolver; page: number; now?: () => Date }): Promise<DnsCompareRead> {
  const all = savedDnsZones(input.state), at = page(all.length, input.page), zones = all.slice(at.start, at.start + DNS_TOOLS_PAGE_SIZE)
  const files = new Set(zones.map(zone => zone.name + '.zone')), host = input.host
  // The service detail reader parses each rendered file's SOA; its listing is narrowed to this page so no other file is opened.
  const detail = await readDnsServiceDetail({ host: { ...host, listDirectory: async (dir, max) => { const listing = await host.listDirectory(dir, max); return { ...listing, entries: listing.entries.filter(entry => files.has(entry.name)) } } },
    readState: async () => ({ ...input.state, zones }), ...(input.now ? { now: input.now } : {}) })
  const rows = await Promise.all(zones.map(async (zone): Promise<DnsCompareRow> => {
    const file = detail.zones.find(row => row.zone === zone.name)
    const [soa, ns] = await Promise.all([liveSoa(input.resolver, zone.name), answer(() => input.resolver.ns(zone.name))])
    const liveNs = names(ns.value), nsState: DnsAnswerState = ns.state === 'answered' && liveNs === null ? 'unavailable' : ns.state
    const saved = { stateSerial: file?.stateSerial ?? null, file: file?.file ?? 'not-read', fileSerial: file?.fileSerial ?? null, ns: savedNameservers(zone) }
    const drift: DnsDriftFlag[] = []
    if (soa.state !== 'answered') drift.push('not-answered')
    if (saved.file !== 'parsed') drift.push('file-not-parsed')
    if (soa.serial !== null && saved.fileSerial !== null && soa.serial !== saved.fileSerial) drift.push('serial-differs-from-file')
    // xPanel serials are YYYYMMDDnn and never wrap, so plain comparison is the RFC 1982 order here.
    if (soa.serial !== null && saved.stateSerial !== null && soa.serial < saved.stateSerial) drift.push('serial-behind-saved')
    if (nsState !== 'answered') drift.push('ns-not-answered'); else if (!sameSet(liveNs!, saved.ns)) drift.push('ns-differs')
    return { zone: zone.name, saved, live: { state: soa.state, serial: soa.serial, nsState, ns: liveNs ?? [] }, drift }
  }))
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), server: DNS_TOOLS_SERVER, control: detail.control.state, page: at.page, pages: at.pages, total: all.length, zones: rows }
}

/** Saved apex nameservers of one page of zones, resolved and checked through the local authoritative listener only. */
export async function checkDnsNameservers(input: { state: DnsToolsState; resolver: DnsToolsResolver; localAddresses: () => readonly string[]; page: number; now?: () => Date }): Promise<DnsNameserverRead> {
  const all = savedDnsZones(input.state), at = page(all.length, input.page), zones = all.slice(at.start, at.start + DNS_TOOLS_PAGE_SIZE)
  const local = new Set(input.localAddresses().map(item => item.toLowerCase())), hosts = new Map<string, Promise<{ state: DnsAnswerState; addresses: string[] }>>()
  const resolve = (name: string): Promise<{ state: DnsAnswerState; addresses: string[] }> | null => {
    if (!hosts.has(name) && hosts.size >= NS_HOSTS_PER_PAGE_MAX) return null
    if (!hosts.has(name)) hosts.set(name, Promise.all([answer(() => input.resolver.v4(name)), answer(() => input.resolver.v6(name))]).then(([v4, v6]) => {
      const found = [...addresses(v4.value), ...addresses(v6.value)], states = [v4.state, v6.state]
      const state: DnsAnswerState = found.length ? 'answered' : states.includes('nxdomain') ? 'nxdomain' : states.every(item => item === 'no-data' || item === 'answered') ? 'no-data' : states.find(item => item !== 'no-data' && item !== 'answered')!
      return { state, addresses: found }
    }))
    return hosts.get(name)!
  }
  const rows = await Promise.all(zones.map(async (zone): Promise<DnsNameserverRow> => {
    const saved = savedNameservers(zone), listed = saved.slice(0, NS_PER_ZONE_MAX), soa = liveSoa(input.resolver, zone.name)
    const nameservers = await Promise.all(listed.map(async (host): Promise<DnsNameserverHost> => {
      const pending = resolve(host)
      if (!pending) return { host, state: 'unavailable', addresses: [], result: 'not-checked' }
      const [read, own] = await Promise.all([pending, soa])
      const mapped = read.addresses.map(address => ({ address, thisServer: local.has(address) }))
      const result: DnsNameserverResult = read.state === 'answered' ? mapped.some(item => item.thisServer) ? own.state === 'answered' ? 'answers' : 'no-answer' : 'other-server'
        : read.state === 'nxdomain' || read.state === 'no-data' ? 'not-resolved' : read.state === 'refused' ? 'not-local' : 'unavailable'
      return { host, state: read.state, addresses: mapped, result }
    }))
    return { zone: zone.name, soa: (await soa).state, nameservers, truncated: saved.length > listed.length }
  }))
  return { observedAt: (input.now?.() ?? new Date()).toISOString(), server: DNS_TOOLS_SERVER, page: at.page, pages: at.pages, total: all.length, zones: rows }
}

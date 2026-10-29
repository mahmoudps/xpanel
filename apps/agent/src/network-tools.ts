import { Resolver } from 'node:dns/promises'
import { connect } from 'node:net'
import { performance } from 'node:perf_hooks'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import { TRACEROUTE_MAX_HOPS, canonicalIp, isPublicAddress, pingArgv, tracerouteArgv } from '../../../packages/os/src/network-tools-command.ts'
import type { AgentCallerIdentity } from './server.ts'

export const NETWORK_TOOLS = ['dns', 'ping', 'traceroute', 'port'] as const
export type NetworkTool = (typeof NETWORK_TOOLS)[number]
export const DNS_RECORD_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'CAA'] as const
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number]
/** Plan feature: catalog tool id and its featureKey. */
export const NETWORK_TOOLS_FEATURES = ['track-dns', 'nettools'] as const
export const DNS_MAX_RECORDS = 50
export const DNS_RECORD_MAX_CHARS = 2048
export const RESOLVE_TIMEOUT_MS = 5000
export const PORT_TIMEOUT_MS = 3000
/** ping -w 10 keeps probing until 4 replies or the deadline, at one probe per second. */
export const PING_MAX_TRANSMITTED = 20

export type NetworkToolRequest = { tool: 'dns'; name: string; type: DnsRecordType } | { tool: 'ping' | 'traceroute'; host: string } | { tool: 'port'; host: string; port: number }
export type DnsStatus = 'answer' | 'nxdomain' | 'nodata' | 'servfail' | 'refused' | 'timeout' | 'failed'
export interface DnsResult { status: DnsStatus; records: string[]; truncated: boolean }
export interface PingResult { transmitted: number; received: number; errors: number; lossPercent: number; rtt: { minMs: number; avgMs: number; maxMs: number } | null }
/** A non-public hop (the server's own network) is reported without its address. */
export interface TracerouteHop { hop: number; address: string | null; nonPublic: boolean; rttMs: number | null; note: string | null }
export interface TracerouteResult { hops: TracerouteHop[]; reached: boolean }
export type PortState = 'open' | 'closed' | 'filtered'
export interface PortResult { state: PortState; elapsedMs: number }
export interface NetworkToolOutcome {
  /** refused: some resolved address is not public; unresolved: no A/AAAA answer. Nothing is sent in either case. */
  outcome: 'completed' | 'refused' | 'unresolved'
  target: { address: string; family: 4 | 6 } | null
  result: DnsResult | PingResult | TracerouteResult | PortResult | null
}
export interface NetworkToolView extends NetworkToolOutcome { context: { accountId: string; tool: NetworkTool }; query: Record<string, string | number>; observedAt: string }
export interface NetworkToolsHost {
  /** Presentation-format answers for one record type; rejects with the c-ares error code. */
  resolve(name: string, type: DnsRecordType): Promise<string[]>
  run(argv: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }>
  connect(address: string, family: 4 | 6, port: number): Promise<PortState>
}

// LDH host names whose last label starts with a letter, so an IP-like or option-like value never parses as a name.
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
// DNS lookups also reach service labels such as _dmarc and _domainkey.
const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const REQUEST_KEYS: Readonly<Record<NetworkTool, readonly string[]>> = { dns: ['name', 'type'], ping: ['host'], traceroute: ['host'], port: ['host', 'port'] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const refuse = (message: string): never => fail('VALIDATION', message, { stateChanged: false })
const normalizedName = (value: unknown, pattern: RegExp): string | null => {
  if (typeof value !== 'string' || value.length > 254) return null
  const name = value.toLowerCase().replace(/\.$/, '')
  return pattern.test(name) ? name : null
}

/** Exact keys per tool; a host is a canonical IP literal or an LDH name, never an option or a zone-qualified address. */
export function parseNetworkToolRequest(tool: string, raw: unknown): NetworkToolRequest {
  const keys = Object.hasOwn(REQUEST_KEYS, tool) ? REQUEST_KEYS[tool as NetworkTool] : refuse('unsupported network tool')
  if (!object(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key))) return refuse('the diagnostic request has unsupported fields')
  if (tool === 'dns') {
    const name = normalizedName(raw.name, DNS_NAME)
    if (!name || !DNS_RECORD_TYPES.includes(raw.type as DnsRecordType)) return refuse('enter a domain name and a supported record type')
    return { tool, name, type: raw.type as DnsRecordType }
  }
  const host = canonicalIp(raw.host)?.address ?? normalizedName(raw.host, HOST_NAME)
  if (!host) return refuse('enter a host name or an IP address')
  if (tool !== 'port') return { tool: tool as 'ping' | 'traceroute', host }
  if (typeof raw.port !== 'number' || !Number.isSafeInteger(raw.port) || raw.port < 1 || raw.port > 65535) return refuse('the port must be 1 to 65535')
  return { tool, host, port: raw.port }
}
export const networkToolQuery = (request: NetworkToolRequest): Record<string, string | number> =>
  request.tool === 'dns' ? { name: request.name, type: request.type } : request.tool === 'port' ? { host: request.host, port: request.port } : { host: request.host }

/** Node dns.Resolver answers in zone-file presentation order (RFC 1035 section 5.1; CAA per RFC 8659). */
export function queryDns(resolver: Pick<Resolver, 'resolve4' | 'resolve6' | 'resolveMx' | 'resolveTxt' | 'resolveCname' | 'resolveNs' | 'resolveSoa' | 'resolveCaa'>, name: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case 'A': return resolver.resolve4(name)
    case 'AAAA': return resolver.resolve6(name)
    case 'MX': return resolver.resolveMx(name).then(answers => answers.sort((a, b) => a.priority - b.priority).map(mx => mx.priority + ' ' + mx.exchange))
    case 'TXT': return resolver.resolveTxt(name).then(answers => answers.map(chunks => chunks.join('')))
    case 'CNAME': return resolver.resolveCname(name)
    case 'NS': return resolver.resolveNs(name)
    case 'SOA': return resolver.resolveSoa(name).then(soa => [[soa.nsname, soa.hostmaster, soa.serial, soa.refresh, soa.retry, soa.expire, soa.minttl].join(' ')])
    case 'CAA': return resolver.resolveCaa(name).then(answers => answers.map(({ critical, ...entry }) => { const [tag, value] = Object.entries(entry)[0] ?? ['', '']; return critical + ' ' + tag + ' "' + String(value) + '"' }))
  }
}

/** Host resolver (the server's configured nameservers), argv runner and TCP connector. */
export function systemNetworkToolsHost(run: NetworkToolsHost['run']): NetworkToolsHost {
  return {
    async resolve(name, type) {
      const resolver = new Resolver({ timeout: 2000, tries: 2 }), timer = setTimeout(() => resolver.cancel(), RESOLVE_TIMEOUT_MS)
      try { return await queryDns(resolver, name, type) } finally { clearTimeout(timer) }
    },
    run,
    connect: (address, family, port) => new Promise((resolve, reject) => {
      const socket = connect({ host: address, family, port })
      const settle = (finish: () => void): void => { clearTimeout(timer); socket.destroy(); finish() }
      const timer = setTimeout(() => settle(() => resolve('filtered')), PORT_TIMEOUT_MS)
      socket.once('connect', () => settle(() => resolve('open')))
      socket.once('error', (error: NodeJS.ErrnoException) => settle(() => error.code === 'ECONNREFUSED' ? resolve('closed')
        : ['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(error.code ?? '') ? resolve('filtered') : reject(error)))
    }),
  }
}

const DNS_FAILURES: Readonly<Record<string, DnsStatus>> = { ENOTFOUND: 'nxdomain', ENODATA: 'nodata', ESERVFAIL: 'servfail', EREFUSED: 'refused', ETIMEOUT: 'timeout', ECANCELLED: 'timeout' }
const clean = (value: string): string => { const text = value.replace(/[\u0000-\u001f\u007f]/g, '�'); return text.length > DNS_RECORD_MAX_CHARS ? text.slice(0, DNS_RECORD_MAX_CHARS) + '…' : text }
export async function lookupDns(host: NetworkToolsHost, name: string, type: DnsRecordType): Promise<DnsResult> {
  let answers: string[]
  try { answers = await host.resolve(name, type) }
  catch (error) { const code = object(error) && typeof error.code === 'string' ? error.code : ''; return { status: Object.hasOwn(DNS_FAILURES, code) ? DNS_FAILURES[code]! : 'failed', records: [], truncated: false } }
  const records = answers.slice(0, DNS_MAX_RECORDS).map(clean)
  return { status: records.length ? 'answer' : 'nodata', records, truncated: answers.length > DNS_MAX_RECORDS || records.some((record, index) => record !== answers[index]) }
}

/** Resolve once, check every answer, then use one checked literal; a name mixing public and private answers is refused. */
export async function resolveNetworkTarget(host: NetworkToolsHost, input: string): Promise<{ address: string; family: 4 | 6 } | 'refused' | 'unresolved'> {
  const literal = canonicalIp(input)
  const found = literal ? [literal.address] : (await Promise.all((['A', 'AAAA'] as const).map(type => host.resolve(input, type).catch((): string[] => [])))).flat()
  if (!found.length) return 'unresolved'
  const addresses = found.map(value => canonicalIp(value)?.address ?? '')
  if (!addresses.every(isPublicAddress)) return 'refused'
  const address = addresses.find(value => !value.includes(':')) ?? addresses[0]!
  return { address, family: address.includes(':') ? 6 : 4 }
}

// iputils ping(8) summary: "T packets transmitted, R received[, +N duplicates][, +N corrupted][, +N errors], L% packet loss, time Xms",
// then "rtt min/avg/max/mdev = a/b/c/d ms" only when a reply arrived.
const PING_COUNTS = /^(\d{1,3}) packets transmitted, (\d{1,3}) received(?:, \+\d{1,3} duplicates)?(?:, \+\d{1,3} corrupted)?(?:, \+(\d{1,3}) errors)?, (\d{1,3}(?:\.\d+)?)% packet loss(?:, time \d+ms)?$/m
const PING_RTT = /^rtt min\/avg\/max\/mdev = (\d+\.\d{3})\/(\d+\.\d{3})\/(\d+\.\d{3})\/\d+\.\d{3} ms(?:, pipe \d+)?$/m
export function parsePingSummary(stdout: string): PingResult | null {
  const counts = PING_COUNTS.exec(stdout), rtt = PING_RTT.exec(stdout)
  if (!counts) return null
  const transmitted = Number(counts[1]), received = Number(counts[2]), errors = Number(counts[3] ?? 0), lossPercent = Number(counts[4])
  if (transmitted < 1 || transmitted > PING_MAX_TRANSMITTED || received > transmitted || Math.abs(lossPercent - (transmitted - received) * 100 / transmitted) > 0.01 || (received > 0) !== (rtt !== null)) return null
  if (!rtt) return { transmitted, received, errors, lossPercent, rtt: null }
  const [minMs, avgMs, maxMs] = [Number(rtt[1]), Number(rtt[2]), Number(rtt[3])]
  return minMs <= avgMs && avgMs <= maxMs ? { transmitted, received, errors, lossPercent, rtt: { minMs, avgMs, maxMs } } : null
}

// traceroute(8) with -n -q 1: optional "traceroute to ADDR (ADDR), 20 hops max, N byte packets" header, then per hop
// "%2u " followed by " ADDR  RTT ms" or " *", and an optional " !X" annotation.
const TRACE_HEADER = /^traceroute to \S+ \((\S+)\), 20 hops max, \d{1,5} byte packets$/
const TRACE_HOP = /^ ?(\d{1,2})  (?:\*|(\S+)  (\d{1,6}\.\d{3}) ms)(?: (!\S{0,8}))?$/
export function parseTraceroute(stdout: string, target: string): TracerouteResult | null {
  const lines = stdout.split('\n').filter(line => line !== ''), header = lines[0] === undefined ? null : TRACE_HEADER.exec(lines[0])
  if (header) { lines.shift(); if (canonicalIp(header[1])?.address !== target) return null }
  const hops: TracerouteHop[] = []
  for (const line of lines) {
    const match = TRACE_HOP.exec(line), address = match?.[2] === undefined ? null : canonicalIp(match[2])?.address ?? ''
    if (!match || Number(match[1]) !== hops.length + 1 || hops.length >= TRACEROUTE_MAX_HOPS || address === '') return null
    const nonPublic = address !== null && !isPublicAddress(address)
    hops.push({ hop: hops.length + 1, address: nonPublic ? null : address, nonPublic, rttMs: match[3] === undefined ? null : Number(match[3]), note: match[4] ?? null })
  }
  return hops.length ? { hops, reached: hops.at(-1)!.address === target } : null
}

/** Runs one diagnostic against a checked public target. Missing binaries and unparsable output are refused, never synthesized. */
export async function runNetworkTool(host: NetworkToolsHost, request: NetworkToolRequest): Promise<NetworkToolOutcome> {
  if (request.tool === 'dns') return { outcome: 'completed', target: null, result: await lookupDns(host, request.name, request.type) }
  const target = await resolveNetworkTarget(host, request.host)
  if (typeof target === 'string') return { outcome: target, target: null, result: null }
  if (request.tool === 'port') {
    const started = performance.now(), state = await host.connect(target.address, target.family, request.port)
    return { outcome: 'completed', target, result: { state, elapsedMs: Math.round(performance.now() - started) } }
  }
  const run = await host.run(request.tool === 'ping' ? pingArgv(target.address) : tracerouteArgv(target.address))
  // env(1) exits 126/127 when the program cannot be executed or found.
  if (run.code === 126 || run.code === 127) return fail('PRECONDITION_FAILED', request.tool + ' is not installed on this server', { stateChanged: false })
  // ping(8) exits 1 when some or all replies are missing; 2 is an error.
  const result = request.tool === 'ping' ? run.code === 0 || run.code === 1 ? parsePingSummary(run.stdout) : null : run.ok ? parseTraceroute(run.stdout, target.address) : null
  return result ? { outcome: 'completed', target, result } : fail('PRECONDITION_FAILED', 'the ' + request.tool + ' output could not be verified', { stateChanged: false })
}

export interface NetworkToolsRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Absent off a native Linux host: diagnostics are reported unavailable, never synthesized. */
  host: NetworkToolsHost | null
  now?: () => Date
}
const NETWORK_TOOLS_ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/network-tools\/(dns|ping|traceroute|port)$/

/**
 * Account owner runs one read-only diagnostic from the server. The account lifecycle lease is not held: it is the
 * store's global writer lock and a network wait of several seconds would stall every write; nothing here reads or
 * changes account state, so authority is re-checked fresh after the run instead.
 */
export async function handleNetworkToolsRoute(req: Request, url: URL, method: string, deps: NetworkToolsRouteDeps): Promise<Response | null> {
  const match = NETWORK_TOOLS_ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'network diagnostics do not accept query selectors', { stateChanged: false })
  const username = match[1]!, tool = match[2] as NetworkTool, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'network diagnostics are run by the signed-in account owner', { stateChanged: false })
  const text = await req.text()
  if (text.length > 1024) return fail('LIMIT_EXCEEDED', 'the diagnostic request is too large', { stateChanged: false })
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return refuse('request body must be valid JSON') }
  const request = parseNetworkToolRequest(tool, raw)
  const authorize = async (): Promise<Account> => {
    const account = await deps.store.getAccountByUsername(username), principal = await deps.currentPrincipal()
    if (!account || account.id !== caller.accountId || account.status !== 'active' || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is not authorized', { stateChanged: false })
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!features || NETWORK_TOOLS_FEATURES.some(key => features.disabled.includes(key))) return fail('FORBIDDEN', 'network tools are disabled by the account plan', { stateChanged: false })
    return account
  }
  const account = await authorize()
  if (!deps.host) return fail('PRECONDITION_FAILED', 'network tools are unavailable on this host', { stateChanged: false })
  let outcome: NetworkToolOutcome
  try { outcome = await runNetworkTool(deps.host, request) }
  catch (error) { if (isXpanelError(error)) throw error; return fail('PRECONDITION_FAILED', 'the network diagnostic could not run', { stateChanged: false }) }
  // Fresh authority after the run: a revoked owner never receives the result.
  const fresh = await authorize()
  if (fresh.id !== account.id) return fail('CONFLICT', 'the account changed while the diagnostic ran', { stateChanged: false })
  const view: NetworkToolView = { context: { accountId: account.id, tool }, query: networkToolQuery(request), ...outcome, observedAt: (deps.now?.() ?? new Date()).toISOString() }
  return new Response(JSON.stringify(view), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { edge } from '@xpanel/render'
import type { LogTail, LogTailReader } from './account-logs.ts'

export const TRAFFIC_SAMPLE_MS = 1000
export const TRAFFIC_MAX_SITES = 32
export const TRAFFIC_LOG_BYTES = 64 * 1024
export interface TrafficInterface { name: string; state: 'read' | 'counter_reset'; receivedBps: number | null; sentBps: number | null }
export interface TrafficRow { domain: string; account: string; requests: number; receivedBytes: number; sentBytes: number; errors: number }
export interface TrafficAccount { account: string; requests: number; receivedBytes: number; sentBytes: number; errors: number }
export interface TrafficReport {
  scope: 'server'; observedAt: string
  interfaces: { state: 'read' | 'partial' | 'unavailable'; intervalMs: number; skipped: number; items: TrafficInterface[] }
  http: { state: 'read' | 'partial' | 'unavailable'; rows: TrafficRow[]; accounts: TrafficAccount[]; readSites: number; omittedRows: number; omittedSites: number; unavailableSites: number; skippedLines: number; truncated: boolean; from: string | null; to: string | null }
  history: { state: 'unavailable'; reason: 'network_counters_not_recorded' }
}
export interface TrafficMonitorContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  readProc: (() => Promise<string | null>) | null
  readTail: LogTailReader | null
  readState: () => Promise<{ accounts: readonly Account[]; domains: readonly Domain[] }>
  now?: () => Date; monotonic?: () => number; wait?: (ms: number) => Promise<void>
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

// proc_net(5): /proc/net/dev has 8 receive columns followed by 8 transmit columns; bytes are first in each set.
export function parseTrafficCounters(text: string): { counters: Map<string, { received: bigint; sent: bigint }>; skipped: number } | null {
  if (Buffer.byteLength(text) > 64 * 1024) return null
  const lines = text.trim().split('\n')
  if (lines.length < 3 || !lines[0]?.includes('Inter-') || !lines[1]?.includes('bytes') || lines.length > 258) return null
  const counters = new Map<string, { received: bigint; sent: bigint }>(); let skipped = 0
  for (const line of lines.slice(2)) {
    const match = /^\s*([a-zA-Z0-9_.-]{1,64}):\s*(.+)$/.exec(line), values = match?.[2]?.trim().split(/\s+/)
    if (!match || !values || values.length !== 16 || values.some(v => !/^[0-9]{1,20}$/.test(v)) || counters.has(match[1]!)) { skipped++; continue }
    counters.set(match[1]!, { received: BigInt(values[0]!), sent: BigInt(values[8]!) })
  }
  return counters.size ? { counters, skipped } : null
}
export function trafficRates(first: ReturnType<typeof parseTrafficCounters>, second: ReturnType<typeof parseTrafficCounters>, intervalMs: number): TrafficReport['interfaces'] {
  const unavailable: TrafficReport['interfaces'] = { state: 'unavailable', intervalMs: 0, skipped: 0, items: [] }
  if (!first || !second || !Number.isFinite(intervalMs) || intervalMs < 500 || intervalMs > 10000) return unavailable
  let skipped = first.skipped + second.skipped
  const items: TrafficInterface[] = []
  for (const [name, end] of second.counters) {
    const start = first.counters.get(name)
    if (!start) { skipped++; continue }
    const rx = end.received - start.received, tx = end.sent - start.sent
    const receivedBps = Math.round(Number(rx) * 1000 / intervalMs), sentBps = Math.round(Number(tx) * 1000 / intervalMs)
    const reset = rx < 0n || tx < 0n || rx > BigInt(Number.MAX_SAFE_INTEGER) || tx > BigInt(Number.MAX_SAFE_INTEGER) || !Number.isSafeInteger(receivedBps) || !Number.isSafeInteger(sentBps)
    items.push({ name, state: reset ? 'counter_reset' : 'read', receivedBps: reset ? null : receivedBps, sentBps: reset ? null : sentBps })
  }
  skipped += [...first.counters.keys()].filter(name => !second.counters.has(name)).length
  return items.length ? { state: skipped || items.some(row => row.state !== 'read') ? 'partial' : 'read', intervalMs: Math.round(intervalMs), skipped, items: items.sort((a, b) => a.name.localeCompare(b.name)) } : unavailable
}

/** Parses only the JSON xpanel_metrics format rendered by packages/render/src/edge/nginx.ts. */
export function summarizeTrafficLog(tail: LogTail, names: ReadonlySet<string>, account: string): { rows: TrafficRow[]; skipped: number; from: string | null; to: string | null } {
  const rows = new Map<string, TrafficRow>(); let skipped = 0, from: string | null = null, to: string | null = null
  const lines = tail.text.split('\n')
  if (tail.truncated) lines.shift()
  if (lines.at(-1) === '') lines.pop(); else if (lines.length) { lines.pop(); skipped++ }
  for (const line of lines) {
    let v: unknown
    try { v = line.length <= 16384 ? JSON.parse(line) : null } catch { v = null }
    if (!object(v) || typeof v.host !== 'string' || !names.has(v.host.toLowerCase()) || !count(v.bytes) || !count(v.request_bytes) || !count(v.status) || v.status < 100 || v.status > 599 || typeof v.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(v.time) || !Number.isFinite(Date.parse(v.time))) { skipped++; continue }
    const domain = v.host.toLowerCase(), row = rows.get(domain) ?? { domain, account, requests: 0, receivedBytes: 0, sentBytes: 0, errors: 0 }
    if (!Number.isSafeInteger(row.sentBytes + v.bytes) || !Number.isSafeInteger(row.receivedBytes + v.request_bytes)) { skipped++; continue }
    row.requests++; row.receivedBytes += v.request_bytes; row.sentBytes += v.bytes; if (v.status >= 400) row.errors++
    rows.set(domain, row)
    const at = new Date(v.time).toISOString(); if (from === null || at < from) from = at; if (to === null || at > to) to = at
  }
  return { rows: [...rows.values()], skipped, from, to }
}

export async function observeTraffic(ctx: TrafficMonitorContext): Promise<TrafficReport> {
  const http: TrafficReport['http'] = { state: 'unavailable', rows: [], accounts: [], readSites: 0, omittedRows: 0, omittedSites: 0, unavailableSites: 0, skippedLines: 0, truncated: false, from: null, to: null }
  const network = async (): Promise<TrafficReport['interfaces']> => {
    if (!ctx.readProc) return trafficRates(null, null, 0)
    try {
      const first = parseTrafficCounters(await ctx.readProc() ?? ''), begin = (ctx.monotonic ?? performance.now.bind(performance))()
      await (ctx.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(TRAFFIC_SAMPLE_MS)
      const second = parseTrafficCounters(await ctx.readProc() ?? ''), end = (ctx.monotonic ?? performance.now.bind(performance))()
      return trafficRates(first, second, end - begin)
    } catch { return trafficRates(null, null, 0) }
  }
  const logs = async (): Promise<void> => {
    if (!ctx.readTail) return
    try {
      const saved = await ctx.readState(), sites = saved.accounts.flatMap(account => edge.groupSites(account, saved.domains.filter(domain => domain.accountId === account.id)).map(group => ({ account: account.username, path: edge.nginxAccessLog(group.main.name), names: new Set(group.names.map(name => name.toLowerCase())) }))).sort((a, b) => a.path.localeCompare(b.path))
      http.omittedSites = Math.max(0, sites.length - TRAFFIC_MAX_SITES)
      for (const site of sites.slice(0, TRAFFIC_MAX_SITES)) {
        let tail: LogTail
        try { tail = await ctx.readTail(site.path, TRAFFIC_LOG_BYTES) } catch { http.unavailableSites++; continue }
        if (!tail.exists || Buffer.byteLength(tail.text) > TRAFFIC_LOG_BYTES) { http.unavailableSites++; continue }
        const summary = summarizeTrafficLog(tail, site.names, site.account)
        http.readSites++; http.skippedLines += summary.skipped; http.truncated ||= tail.truncated; http.rows.push(...summary.rows)
        if (summary.from && (!http.from || summary.from < http.from)) http.from = summary.from
        if (summary.to && (!http.to || summary.to > http.to)) http.to = summary.to
      }
      const accounts = new Map<string, TrafficAccount>(), rows: TrafficRow[] = []
      for (const row of http.rows) {
        const item = accounts.get(row.account) ?? { account: row.account, requests: 0, receivedBytes: 0, sentBytes: 0, errors: 0 }
        if (!(['requests', 'receivedBytes', 'sentBytes', 'errors'] as const).every(key => Number.isSafeInteger(item[key] + row[key]))) { http.omittedRows++; continue }
        item.requests += row.requests; item.receivedBytes += row.receivedBytes; item.sentBytes += row.sentBytes; item.errors += row.errors; accounts.set(row.account, item)
        rows.push(row)
      }
      rows.sort((a, b) => b.sentBytes - a.sentBytes || a.domain.localeCompare(b.domain)); http.omittedRows += Math.max(0, rows.length - 100); http.rows = rows.slice(0, 100); http.accounts = [...accounts.values()].sort((a, b) => b.sentBytes - a.sentBytes || a.account.localeCompare(b.account))
      http.state = sites.length && !http.readSites ? 'unavailable' : http.omittedRows || http.omittedSites || http.unavailableSites || http.skippedLines || http.truncated ? 'partial' : 'read'
    } catch { http.state = 'unavailable'; http.rows = []; http.accounts = [] }
  }
  const [interfaces] = await Promise.all([network(), logs()])
  return { scope: 'server', observedAt: (ctx.now?.() ?? new Date()).toISOString(), interfaces, http, history: { state: 'unavailable', reason: 'network_counters_not_recorded' } }
}

export async function handleTrafficMonitorRoute(req: Request, url: URL, method: string, ctx: TrafficMonitorContext): Promise<Response | null> {
  if (url.pathname !== '/host/monitoring/traffic') return null
  await ctx.assertRoot('server.traffic.read')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search || req.body !== null) return fail('VALIDATION', 'traffic observation accepts no selectors or body', { stateChanged: false })
  const result = await observeTraffic(ctx)
  await ctx.assertRoot('server.traffic.read')
  return Response.json(result, { headers: { 'cache-control': 'no-store' } })
}

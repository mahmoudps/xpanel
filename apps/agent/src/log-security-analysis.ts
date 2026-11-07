import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { parseAccessLogLine, resolveAccountLogPath } from './account-logs.ts'
import type { AccessLogEntry, LogSlice } from './account-logs.ts'

/** The largest tail of one site access log a run scans: about 12000 requests, enough for a day of a busy small site. */
export const LOG_ANALYSIS_MAX_BYTES = 4 * 1024 * 1024
const SAMPLES = 5, TOP_CLIENTS = 10, TEXT_MAX = 300
export const LOG_FINDING_TYPES = ['sql-injection', 'cross-site-scripting', 'path-traversal', 'remote-file-inclusion', 'command-injection', 'webshell-probe', 'vulnerability-scanner'] as const
export type LogFindingType = typeof LOG_FINDING_TYPES[number]
export interface LogFindingSample { time: string; ip: string; method: string; uri: string; status: number }
export interface LogFinding { type: LogFindingType; count: number; clients: number; samples: LogFindingSample[] }
export interface LogSecurityReport {
  site: string; observedAt: string
  scan: { fileExists: boolean; sizeBytes: number; scannedBytes: number; complete: boolean; requests: number; unparsed: number; flagged: number }
  findings: LogFinding[]; topClients: { ip: string; requests: number }[]
}

// Each pattern reads a decoded, lower-cased request target; a request counts once per type however many patterns it hits.
const TARGET_PATTERNS: Readonly<Record<Exclude<LogFindingType, 'webshell-probe' | 'vulnerability-scanner'>, readonly RegExp[]>> = {
  'sql-injection': [/\bunion\b[\s/*+]+(?:all[\s/*+]+)?select\b/, /\bselect\b[\s/*+(].{0,80}\bfrom\b[\s/*+]/, /\binformation_schema\b/, /['"`)]\s*(?:or|and)\s+['"`(]?\w{0,8}['"`]?\s*(?:=|like|>|<)/, /\b(?:or|and)\s+\d+\s*=\s*\d+/, /\b(?:sleep|benchmark|pg_sleep|load_file|extractvalue|updatexml)\s*\(/, /\binto\s+(?:out|dump)file\b/, /';\s*(?:drop|update|insert|delete)\b/],
  'cross-site-scripting': [/<\s*script\b/, /<\s*(?:img|svg|iframe|body)\b[^>]*\bon[a-z]+\s*=/, /\bjavascript\s*:/, /\bdocument\.(?:cookie|location)\b/, /\bon(?:error|load|mouseover|focus)\s*=\s*['"]?[a-z(]/],
  'path-traversal': [/(?:\.\.[/\\]){2,}/, /\/etc\/(?:passwd|shadow|hosts)\b/, /\/proc\/self\/(?:environ|cmdline|fd)\b/, /\bwin(?:dows|nt)[/\\]win\.ini\b/],
  'remote-file-inclusion': [/[?&][^=&]{1,64}=(?:https?|ftp):\/\/[^&]*\.(?:txt|php|sh|jpg)\b/, /[?&][^=&]{1,64}=(?:php|phar|expect|zip|data):/],
  'command-injection': [/[;|`&]\s*(?:cat|ls|id|uname|whoami|wget|curl|nc|bash|sh|python|perl|chmod)\b[\s+%/-]/, /\$\(\s*(?:cat|ls|id|uname|whoami|wget|curl)\b/, /\/bin\/(?:ba)?sh\b/, /\bcmd\.exe\b/],
}
const WEBSHELL_PATH = [/\/(?:c99|r57|wso|b374k|alfa|indoxploit|webshell|shell|cmd|phpspy|filesman)[0-9]*\.php\b/, /\/wp-content\/uploads\/[^?]*\.php\b/, /\/\.(?:env|git\/config|aws\/credentials|htpasswd|ssh\/id_rsa)\b/, /\/(?:phpinfo|info|test)\.php\b[^?]*$/]
const SCANNER_AGENT = /\b(?:sqlmap|nikto|nmap|masscan|acunetix|nessus|wpscan|dirbuster|gobuster|feroxbuster|nuclei|havij|zgrab|openvas)\b/

const clip = (text: string): string => { const value = text.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '?'); return value.length > TEXT_MAX ? value.slice(0, TEXT_MAX - 3) + '...' : value }
/** Attackers encode twice to pass filters, so two passes; a malformed escape leaves the text as it stands. */
const decoded = (uri: string): string => {
  let value = uri.replace(/\+/g, ' ')
  for (let pass = 0; pass < 2; pass++) try { value = decodeURIComponent(value) } catch { break }
  return value.toLowerCase()
}

export function classifyRequest(entry: Pick<AccessLogEntry, 'uri' | 'agent'>): LogFindingType[] {
  const target = decoded(entry.uri), path = target.split('?')[0]!, found: LogFindingType[] = []
  for (const [type, patterns] of Object.entries(TARGET_PATTERNS) as [LogFindingType, readonly RegExp[]][]) if (patterns.some(pattern => pattern.test(target))) found.push(type)
  if (WEBSHELL_PATH.some(pattern => pattern.test(path))) found.push('webshell-probe')
  if (SCANNER_AGENT.test(entry.agent.toLowerCase())) found.push('vulnerability-scanner')
  return found
}

/** Groups matches by type. A cut first line of a tail is the caller's to drop. */
export function analyzeAccessLog(lines: readonly string[]): Pick<LogSecurityReport, 'findings' | 'topClients'> & { requests: number; unparsed: number; flagged: number } {
  const groups = new Map<LogFindingType, { count: number; clients: Set<string>; samples: LogFindingSample[] }>(), clients = new Map<string, number>()
  let requests = 0, unparsed = 0, flagged = 0
  for (const line of lines) {
    const entry = parseAccessLogLine(line)
    if (!entry) { if (line.trim()) unparsed++; continue }
    requests++
    const types = classifyRequest(entry)
    if (!types.length) continue
    flagged++
    clients.set(entry.ip, (clients.get(entry.ip) ?? 0) + 1)
    for (const type of types) {
      const group = groups.get(type) ?? { count: 0, clients: new Set<string>(), samples: [] }
      group.count++; group.clients.add(entry.ip)
      if (group.samples.length < SAMPLES) group.samples.push({ time: clip(entry.time), ip: clip(entry.ip), method: clip(entry.method), uri: clip(entry.uri), status: entry.status })
      groups.set(type, group)
    }
  }
  const findings = LOG_FINDING_TYPES.flatMap(type => { const group = groups.get(type); return group ? [{ type, count: group.count, clients: group.clients.size, samples: group.samples }] : [] })
  return { findings, topClients: [...clients].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1)).slice(0, TOP_CLIENTS).map(([ip, count]) => ({ ip: clip(ip), requests: count })), requests, unparsed, flagged }
}

export interface LogSecurityRouteContext {
  assertRoot: (action: string) => Promise<unknown>
  readState: () => Promise<{ accounts: readonly Account[]; domains: readonly Domain[] }>
  /** Null off a native host: the analysis refuses, it never reports a clean site. */
  readLog: ((path: string, offset: number, maxBytes: number) => Promise<LogSlice>) | null
  now?: () => Date
}

/** GET /host/logs/security-analysis?domainId=<id>, root only: a read of the site's own edge log, never of a caller's path. */
export async function handleLogSecurityRoute(req: Request, url: URL, method: string, ctx: LogSecurityRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/logs/security-analysis') return null
  await ctx.assertRoot('server.logs.security-analysis')
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const domainId = url.searchParams.get('domainId')
  if (req.body !== null || [...url.searchParams.keys()].join() !== 'domainId' || !domainId || !/^[0-9a-f-]{36}$/.test(domainId)) return fail('VALIDATION', 'choose one site by its domain id', { stateChanged: false })
  if (!ctx.readLog) return fail('PRECONDITION_FAILED', 'site access logs are unavailable on this host', { stateChanged: false })
  const state = await ctx.readState(), domain = state.domains.find(item => item.id === domainId), account = domain && state.accounts.find(item => item.id === domain.accountId)
  if (!account) return fail('NOT_FOUND', 'domain not found', { stateChanged: false })
  const { path, site } = resolveAccountLogPath(account, state.domains.filter(item => item.accountId === account.id), domainId, 'access')
  const size = (await ctx.readLog(path, 0, 1)).sizeBytes, slice = await ctx.readLog(path, Math.max(0, size - LOG_ANALYSIS_MAX_BYTES), LOG_ANALYSIS_MAX_BYTES)
  const lines = slice.bytes.toString('utf8').split('\n')
  if (slice.start > 0) lines.shift()
  const { findings, topClients, requests, unparsed, flagged } = analyzeAccessLog(lines)
  const report: LogSecurityReport = { site, observedAt: (ctx.now ?? (() => new Date()))().toISOString(), scan: { fileExists: slice.exists, sizeBytes: slice.sizeBytes, scannedBytes: slice.bytes.length, complete: slice.start === 0, requests, unparsed, flagged }, findings, topClients }
  return new Response(JSON.stringify(report), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

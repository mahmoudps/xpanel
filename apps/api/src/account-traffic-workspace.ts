import { isIPv4, isIPv6 } from 'node:net'
import { join } from 'node:path'
import { fail, isXpanelError, validateDomainName } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { AccessLogEntry } from '../../agent/src/account-logs.ts'
import { edgeRevision, edgeStatePath, IP_BLOCKER_MAX, ipBlockerRange, parseIpBlockerInput, readIpBlockerRecord } from '../../agent/src/account-edge.ts'
import type { IpBlockerRecord } from '../../agent/src/account-edge.ts'
import { projectAccountLogs, type AccountLogsProjection } from './account-logs-workspace.ts'
import { authorizeAccountOwner, workspaceJson } from './account-ssh-workspace.ts'
import type { AccountSshPorts } from './account-ssh-workspace.ts'
import { ipBlockerView, readEdgeBody, reconcileOutcome } from './account-edge-workspace.ts'
import { assertAccountFeatures } from './authorization.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const ACCOUNT_TRAFFIC_MONITOR_PATH = '/api/account/traffic-monitor'
export const ACCOUNT_TRAFFIC_BLOCK_IP_PATH = '/api/account/traffic-monitor/block-ip'

const MAX_RECENT_REQUESTS = 50
const MAX_TOP_USER_AGENTS = 20
const MAX_TOP_CLIENT_IPS = 20
const MAX_DAILY_VISITORS = 31
const MAX_RESPONSE_BYTES = 512 * 1024
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g

export interface AccountTrafficPorts extends AccountSshPorts {
  emitAudit: ExtendedRouteHelpers['emitAudit']
  triggerReconcile?: ExtendedRouteHelpers['triggerReconcile']
  now?: () => Date
}

export interface AccountTrafficRequestEntry {
  time: string
  method: string
  path: string
  status: number
  bytes: number
  ip: string
  agent: string
}

export interface AccountTrafficUserAgentEntry {
  agent: string
  requests: number
  bytes: number
}

export interface AccountTrafficClientIpEntry {
  ip: string
  requests: number
  bytes: number
  errors: number
  blocked: boolean
}

export interface AccountTrafficDailyVisitorsEntry {
  date: string
  uniqueVisitors: number
  requests: number
  bytes: number
}

export interface AccountTrafficMonitorView {
  context: { username: string; domain: string | null; domains: string[] }
  state: 'read' | 'no_domains'
  observedAt: string
  summary: {
    totalRequests: number
    uniqueVisitors: number
    totalBytes: number
    error5xx: number
    truncated: boolean
    unparsedLines: number
    fileExists: boolean
  } | null
  dailyVisitors: AccountTrafficDailyVisitorsEntry[]
  recentRequests: AccountTrafficRequestEntry[]
  topUserAgents: AccountTrafficUserAgentEntry[]
  topClientIps: AccountTrafficClientIpEntry[]
  ipBlocker: { available: boolean; revision: string; blockedCount: number }
}

const unchanged = { stateChanged: false } as const
const sanitizeText = (value: string, maxChars: number): string => {
  const cleaned = value.replace(CONTROL_CHARS, '').trim()
  const wellFormed = cleaned.isWellFormed() ? cleaned : cleaned.toWellFormed()
  return wellFormed.length > maxChars ? wellFormed.slice(0, maxChars) : wellFormed
}

const addressToBigInt = (ip: string): { family: 4 | 6; value: bigint } | null => {
  if (isIPv4(ip) && !ip.split('.').some(octet => octet.length > 1 && octet.startsWith('0'))) {
    return { family: 4, value: ip.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n) }
  }
  if (isIPv6(ip) && !ip.includes('%') && !ip.includes('.')) {
    const [head = '', tail] = ip.toLowerCase().split('::')
    const left = head ? head.split(':') : []
    const right = tail ? tail.split(':') : []
    const missing = tail === undefined ? 0 : 8 - left.length - right.length
    if (missing < 0) return null
    const groups = [...left, ...Array<string>(missing).fill('0'), ...right]
    if (groups.length !== 8) return null
    return { family: 6, value: groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n) }
  }
  return null
}

/** True when an address falls within any canonical IP Blocker entry (IPv4/IPv6/CIDR). */
export function isIpBlockedByEntries(ip: string, entries: readonly string[]): boolean {
  const target = addressToBigInt(ip.trim())
  if (!target) return false
  for (const entry of entries) {
    let range: { first: string; last: string }
    try { range = ipBlockerRange(entry) } catch { continue }
    const first = addressToBigInt(range.first), last = addressToBigInt(range.last)
    if (!first || !last || first.family !== target.family) continue
    if (target.value >= first.value && target.value <= last.value) return true
  }
  return false
}

/** Validates strictly an IPv4, IPv6, or CIDR address (never hostnames or dash ranges). */
function parseStrictCidrOrIp(rawInput: string): { entries: string[] } | { code: 'address' | 'protected_address' | 'too_many' | 'range' } {
  const value = rawInput.trim()
  if (!value || value.length > 100 || value.includes('-') || value.endsWith('.')) return { code: 'address' }
  const parts = value.split('/')
  if (parts.length > 2) return { code: 'address' }
  const addr = parts[0] ?? ''
  if (!isIPv4(addr) && !isIPv6(addr)) return { code: 'address' }
  return parseIpBlockerInput(value)
}

/** Projects bounded account access-log telemetry without internal IDs or control characters. */
export function projectAccountTrafficTelemetry(
  logs: AccountLogsProjection,
  account: Pick<Account, 'username'>,
  selectedDomain: Pick<Domain, 'name'>,
  ownedDomains: readonly Pick<Domain, 'name'>[],
  ipBlocker: { available: boolean; revision: string; entries: readonly string[] },
): AccountTrafficMonitorView {
  const entries = logs.entries as readonly AccessLogEntry[]
  const uniqueIps = new Set<string>()
  const agentStats = new Map<string, { requests: number; bytes: number }>()
  const ipStats = new Map<string, { requests: number; bytes: number; errors: number }>()
  const dayStats = new Map<string, { ips: Set<string>; requests: number; bytes: number }>()
  let totalBytes = 0, error5xx = 0

  for (const entry of entries) {
    const ip = sanitizeText(entry.ip, 64)
    const agent = sanitizeText(entry.agent, 256) || '-'
    const parsedTime = Date.parse(entry.time)
    const isoTime = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : null
    if (ip) uniqueIps.add(ip)
    totalBytes += entry.bytes
    if (entry.status >= 500) error5xx++

    const agentRow = agentStats.get(agent) ?? { requests: 0, bytes: 0 }
    agentRow.requests++
    agentRow.bytes += entry.bytes
    agentStats.set(agent, agentRow)

    if (ip) {
      const ipRow = ipStats.get(ip) ?? { requests: 0, bytes: 0, errors: 0 }
      ipRow.requests++
      ipRow.bytes += entry.bytes
      if (entry.status >= 400) ipRow.errors++
      ipStats.set(ip, ipRow)
    }

    if (isoTime) {
      const date = isoTime.slice(0, 10)
      const dayRow = dayStats.get(date) ?? { ips: new Set<string>(), requests: 0, bytes: 0 }
      if (ip) dayRow.ips.add(ip)
      dayRow.requests++
      dayRow.bytes += entry.bytes
      dayStats.set(date, dayRow)
    }
  }

  const recentRequests: AccountTrafficRequestEntry[] = []
  for (let index = entries.length - 1; index >= 0 && recentRequests.length < MAX_RECENT_REQUESTS; index--) {
    const entry = entries[index]!
    const parsedTime = Date.parse(entry.time)
    const time = Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : sanitizeText(entry.time, 64)
    recentRequests.push({
      time,
      method: sanitizeText(entry.method, 16) || 'GET',
      path: sanitizeText(entry.uri, 512) || '/',
      status: entry.status,
      bytes: entry.bytes,
      ip: sanitizeText(entry.ip, 64),
      agent: sanitizeText(entry.agent, 256) || '-',
    })
  }

  const topUserAgents: AccountTrafficUserAgentEntry[] = [...agentStats.entries()]
    .map(([agent, row]) => ({ agent, requests: row.requests, bytes: row.bytes }))
    .sort((left, right) => right.requests - left.requests || right.bytes - left.bytes || left.agent.localeCompare(right.agent))
    .slice(0, MAX_TOP_USER_AGENTS)

  const topClientIps: AccountTrafficClientIpEntry[] = [...ipStats.entries()]
    .map(([ip, row]) => ({ ip, requests: row.requests, bytes: row.bytes, errors: row.errors, blocked: isIpBlockedByEntries(ip, ipBlocker.entries) }))
    .sort((left, right) => right.requests - left.requests || right.bytes - left.bytes || left.ip.localeCompare(right.ip))
    .slice(0, MAX_TOP_CLIENT_IPS)

  const dailyVisitors: AccountTrafficDailyVisitorsEntry[] = [...dayStats.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-MAX_DAILY_VISITORS)
    .map(([date, row]) => ({ date, uniqueVisitors: row.ips.size, requests: row.requests, bytes: row.bytes }))

  return {
    context: {
      username: account.username,
      domain: selectedDomain.name,
      domains: ownedDomains.map(domain => domain.name),
    },
    state: 'read',
    observedAt: sanitizeText(logs.observedAt, 64),
    summary: {
      totalRequests: entries.length,
      uniqueVisitors: uniqueIps.size,
      totalBytes,
      error5xx,
      truncated: logs.file.truncated,
      unparsedLines: logs.unparsedLines,
      fileExists: logs.file.exists,
    },
    dailyVisitors,
    recentRequests,
    topUserAgents,
    topClientIps,
    ipBlocker: {
      available: ipBlocker.available,
      revision: ipBlocker.revision,
      blockedCount: ipBlocker.entries.length,
    },
  }
}

async function readIpBlockerState(ports: AccountTrafficPorts, caller: Parameters<typeof assertAccountFeatures>[1], account: Account) {
  let featureAllowed = true
  try { await assertAccountFeatures(ports.store, caller, account, ['ip-blocker']) }
  catch (error) {
    if (isXpanelError(error) && error.code === 'FORBIDDEN') featureAllowed = false
    else throw error
  }
  let raw: unknown = null, valid = true
  try { raw = await readJsonIfExists<unknown>(join(ports.store.rootDir, edgeStatePath('ip-blocker', account.id))) }
  catch { valid = false }
  const record = raw === null ? null : readIpBlockerRecord(raw)
  if (raw !== null && !record) valid = false
  return {
    available: featureAllowed && valid,
    revision: valid ? edgeRevision(raw) : edgeRevision(null),
    entries: record?.entries ?? [],
  }
}

/** Account-scoped traffic monitor telemetry and IP block route (`/api/account/traffic-monitor`). */
export async function handleAccountTrafficRoute(request: Request, url: URL, method: string, ports: AccountTrafficPorts): Promise<Response | null> {
  if (url.pathname === ACCOUNT_TRAFFIC_MONITOR_PATH) {
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
    if (request.body !== null) return fail('VALIDATION', 'traffic monitor read accepts no request body', unchanged)
    for (const key of url.searchParams.keys()) {
      if (key !== 'domain' || url.searchParams.getAll('domain').length !== 1) {
        return fail('VALIDATION', 'traffic monitor accepts only an optional domain selector', unchanged)
      }
    }
    const first = await authorizeAccountOwner(ports, request, ['traffic-monitor-account'], 'Traffic monitor')
    const ownedDomains = (await ports.store.listDomains({ accountId: first.account.id }))
      .filter(domain => domain.accountId === first.account.id)
      .sort((left, right) => left.name.localeCompare(right.name))

    const requestedDomainParam = url.searchParams.get('domain')
    let selected: Domain | null = null
    if (requestedDomainParam !== null) {
      let normalized: string
      try { normalized = validateDomainName(requestedDomainParam.trim().toLowerCase()) }
      catch { return fail('VALIDATION', 'domain must be a valid hostname', unchanged) }
      selected = ownedDomains.find(domain => domain.name.toLowerCase() === normalized) ?? null
      if (!selected) return fail('NOT_FOUND', 'domain not found', unchanged)
    } else {
      selected = ownedDomains.find(domain => domain.name.toLowerCase() === first.account.primaryDomain.toLowerCase()) ?? ownedDomains[0] ?? null
    }

    const ipBlocker = await readIpBlockerState(ports, first.caller, first.account)
    if (!selected) {
      const emptyView: AccountTrafficMonitorView = {
        context: { username: first.account.username, domain: null, domains: [] },
        state: 'no_domains',
        observedAt: (ports.now?.() ?? new Date()).toISOString(),
        summary: null,
        dailyVisitors: [],
        recentRequests: [],
        topUserAgents: [],
        topClientIps: [],
        ipBlocker: { available: ipBlocker.available, revision: ipBlocker.revision, blockedCount: ipBlocker.entries.length },
      }
      return workspaceJson(emptyView)
    }

    const raw = await ports.readAgent(first.caller, '/accounts/' + first.account.username + '/logs/' + selected.id + '/access')
    const fresh = await authorizeAccountOwner(ports, request, ['traffic-monitor-account'], 'Traffic monitor')
    if (fresh.caller.principal.id !== first.caller.principal.id || fresh.account.id !== first.account.id) {
      return fail('FORBIDDEN', 'traffic monitor authority changed', unchanged)
    }
    const freshDomain = await ports.store.getDomain(selected.id)
    if (!freshDomain || freshDomain.accountId !== fresh.account.id) {
      return fail('CONFLICT', 'the selected domain ownership changed during observation', unchanged)
    }

    let projected: AccountLogsProjection
    try { projected = projectAccountLogs(raw, fresh.account, freshDomain, 'access') }
    catch (error) {
      if (isXpanelError(error) && error.code !== 'CONFIG_TEST_FAILED') throw error
      return fail('SERVICE_UNAVAILABLE', 'the account traffic telemetry could not be verified', unchanged)
    }

    const view = projectAccountTrafficTelemetry(projected, fresh.account, freshDomain, ownedDomains, ipBlocker)
    if (Buffer.byteLength(JSON.stringify(view), 'utf8') > MAX_RESPONSE_BYTES) {
      return fail('LIMIT_EXCEEDED', 'the projected traffic telemetry exceeds its response bound', unchanged)
    }
    return workspaceJson(view)
  }

  if (url.pathname === ACCOUNT_TRAFFIC_BLOCK_IP_PATH) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    if (url.search) return fail('VALIDATION', 'traffic monitor IP blocking accepts no query selectors', unchanged)
    const first = await authorizeAccountOwner(ports, request, ['traffic-monitor-account', 'ip-blocker'], 'Traffic monitor IP blocker')
    const body = await readEdgeBody(request)
    const keys = Object.keys(body).sort().join()
    if (keys !== 'expectedRevision,ip' || typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision) || typeof body.ip !== 'string' || body.ip.length > 100) {
      return fail('VALIDATION', 'expectedRevision and ip (IPv4, IPv6, or CIDR) are required', unchanged)
    }
    const parsed = parseStrictCidrOrIp(body.ip)
    if (!('entries' in parsed)) {
      return fail('VALIDATION', 'use a valid non-loopback IPv4, IPv6, or CIDR address', { ...unchanged, fields: [{ field: 'ip', code: parsed.code }] })
    }
    const now = (ports.now ?? (() => new Date()))()
    const path = join(ports.store.rootDir, edgeStatePath('ip-blocker', first.account.id))
    const readRaw = async (): Promise<unknown> => {
      try { return await readJsonIfExists<unknown>(path) }
      catch { return fail('PRECONDITION_FAILED', 'saved edge configuration is unreadable; review it before changing it', unchanged) }
    }
    const fresh = async () => {
      const again = await authorizeAccountOwner(ports, request, ['traffic-monitor-account', 'ip-blocker'], 'Traffic monitor IP blocker')
      return again.caller.principal.id === first.caller.principal.id && again.account.id === first.account.id
        ? again.caller : fail('CONFLICT', 'the account binding changed before saving', unchanged)
    }

    const lease = await ports.store.getWriterLock().acquire()
    let attempted = false, saved: unknown, added: string[] = []
    try {
      await fresh()
      const raw = await readRaw()
      if (edgeRevision(raw) !== body.expectedRevision) {
        return fail('CONFLICT', 'saved edge settings changed; read them before saving', unchanged)
      }
      const current = raw === null ? [] : readIpBlockerRecord(raw)?.entries ?? fail('PRECONDITION_FAILED', 'saved blocks require review before changing them', unchanged)
      added = [...new Set(parsed.entries)].filter(entry => !current.includes(entry))
      if (!added.length) {
        return fail('VALIDATION', 'the address or CIDR block is already blocked', { ...unchanged, fields: [{ field: 'ip', code: 'duplicate' }] })
      }
      const next = [...current, ...added]
      if (next.length > IP_BLOCKER_MAX) {
        return fail('VALIDATION', `at most ${IP_BLOCKER_MAX} blocks are saved`, { ...unchanged, fields: [{ field: 'ip', code: 'too_many' }] })
      }
      const record: IpBlockerRecord = { version: 1, entries: next, updatedAt: now.toISOString() }
      await lease.assertFencingToken()
      attempted = true
      await atomicWriteJson(path, record, 0o640, async () => { await fresh(); await lease.assertFencingToken() })
      saved = await readRaw()
      if (JSON.stringify(saved) !== JSON.stringify(record)) throw new Error('readback_mismatch')
    } catch (error) {
      if (attempted) return fail('SERVICE_UNAVAILABLE', 'the saved edge settings could not be verified; review before retrying', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
      throw error
    } finally {
      await lease.release()
    }

    const currentCaller = await fresh().catch(() => null)
    try {
      await ports.emitAudit({
        actor: first.caller.principal.username,
        action: 'account.ip_blocker.added',
        target: 'account:' + first.account.username,
        principalId: first.caller.principal.id,
        outcome: 'ok',
        detail: { entries: added.length, source: 'traffic-monitor' },
      })
    } catch {
      return fail('SERVICE_UNAVAILABLE', 'the change was saved but its audit record requires review', { stateChanged: true, verificationRequired: true })
    }

    const reconcile = currentCaller && ports.triggerReconcile ? await reconcileOutcome({ triggerReconcile: ports.triggerReconcile }, currentCaller) : 'not_connected'
    return workspaceJson({
      context: { username: first.account.username },
      blocked: added,
      revision: edgeRevision(saved),
      entries: ipBlockerView(first.account, saved).entries,
      reconcile,
      stateChanged: true,
    })
  }

  return null
}

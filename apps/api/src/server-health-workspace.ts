import { fail } from '@xpanel/core'
import type { Account } from '@xpanel/core'
import type { ServerHealthCheck, ServerHealthCheckId, ServerHealthItem, ServerHealthReport, ServerHealthState } from '../../agent/src/server-health.ts'
import type { AccountLimits, LimitResource, LimitRow, ServerLimitsReport } from '../../agent/src/server-health-limits.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export interface ServerHealthWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  /** Every saved account (root scope); only usernames are read. */
  listAccounts: () => Promise<readonly Pick<Account, 'username'>[]>
  /** Absent when no protected host agent is connected. */
  readHost?: (caller: AuthenticatedCaller, pathAndQuery: string) => Promise<unknown>
}

export const SERVER_LIMITS_BATCH = 50
const MAX_PENDING = 5000
const ACTION = 'server.server-health.read'
const CHECK_IDS: readonly ServerHealthCheckId[] = ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot']
const STATES: readonly ServerHealthState[] = ['ok', 'warning', 'problem', 'unavailable']
const RESOURCES: readonly LimitResource[] = ['cpu', 'memory', 'processes', 'io-read-bps', 'io-write-bps', 'io-read-iops', 'io-write-iops', 'disk']
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const REASON = /^[a-z][a-z_]{1,39}$/
const unchanged = { stateChanged: false }
const invalid = (): never => fail('PRECONDITION_FAILED', 'the server health observation could not be verified', unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number, lines = false): string => typeof value === 'string' && value.length <= max && value.isWellFormed() && !(lines ? /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/).test(value) ? value : invalid()
const iso = (value: unknown): string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : invalid()
const count = (value: unknown, max: number): number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max ? value as number : invalid()
const amount = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid()
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T => allowed.includes(value as T) ? value as T : invalid()
const nullable = <T>(value: unknown, read: (raw: unknown) => T): T | null => value === null ? null : read(value)
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const healthItem = (raw: unknown): ServerHealthItem => object(raw) ? { name: text(raw.name, 512), state: oneOf(raw.state, STATES), reason: typeof raw.reason === 'string' && REASON.test(raw.reason) ? raw.reason : invalid(), evidence: text(raw.evidence, 256) } : invalid()
/** Whitelists the agent health report: fixed check order, bounded text, counts that match the checks. */
export function projectServerHealth(value: unknown): ServerHealthReport {
  if (!object(value) || !object(value.thresholds) || !object(value.counts) || !Array.isArray(value.checks) || value.checks.length !== CHECK_IDS.length) return invalid()
  const pair = (raw: unknown) => object(raw) ? Object.freeze({ warning: amount(raw.warning), problem: amount(raw.problem) }) : invalid()
  const t = value.thresholds, counted = value.counts
  const thresholds = Object.freeze({ loadPerCore: pair(t.loadPerCore), memoryAvailablePercent: pair(t.memoryAvailablePercent), swapUsedPercent: pair(t.swapUsedPercent), diskUsedPercent: pair(t.diskUsedPercent), inodeUsedPercent: pair(t.inodeUsedPercent), certificateExpiryDays: count(t.certificateExpiryDays, 3650) })
  const checks = value.checks.map((raw, index): ServerHealthCheck => {
    if (!object(raw) || raw.id !== CHECK_IDS[index] || typeof raw.reason !== 'string' || !REASON.test(raw.reason)) return invalid()
    const entry: ServerHealthCheck = { id: CHECK_IDS[index]!, state: oneOf(raw.state, STATES), reason: raw.reason, evidence: text(raw.evidence, 1024) }
    if (raw.items === undefined && raw.omitted === undefined) return entry
    if (!Array.isArray(raw.items) || raw.items.length > 25) return invalid()
    const omitted = count(raw.omitted, 100_000)
    return omitted && raw.items.length !== 25 ? invalid() : { ...entry, items: raw.items.map(healthItem), omitted }
  })
  const counts = Object.fromEntries(STATES.map(state => [state, checks.filter(entry => entry.state === state).length])) as Record<ServerHealthState, number>
  if (STATES.some(state => counted[state] !== counts[state])) return invalid()
  return { observedAt: iso(value.observedAt), host: oneOf(value.host, ['read', 'unavailable'] as const), thresholds, counts, checks }
}

const limitRow = (raw: unknown, index: number): LimitRow => {
  if (!object(raw) || raw.id !== RESOURCES[index]) return invalid()
  const limit = raw.limit === null || raw.limit === 'unlimited' ? raw.limit : amount(raw.limit)
  return { id: RESOURCES[index]!, limit, enforced: nullable(raw.enforced, item => text(item, 4096, true)), enforcement: oneOf(raw.enforcement, ['match', 'drift', 'unavailable'] as const),
    usage: nullable(raw.usage, amount), percent: nullable(raw.percent, amount), usageState: oneOf(raw.usageState, ['ok', 'high', 'unlimited', 'unavailable'] as const) }
}
/** Only the requested accounts, in order, may cross the boundary; each has every resource row once. */
export function projectServerLimits(value: unknown, batch: readonly string[]): Omit<ServerLimitsReport, 'accounts'> & { accounts: AccountLimits[] } {
  if (!object(value) || !object(value.sample) || !Array.isArray(value.accounts) || value.accounts.length !== batch.length) return invalid()
  const accounts = value.accounts.map((raw, index): AccountLimits => {
    if (!object(raw) || raw.username !== batch[index] || !Array.isArray(raw.rows) || raw.rows.length !== RESOURCES.length) return invalid()
    const rows = raw.rows.map(limitRow)
    const high = rows.filter(row => row.usageState === 'high').length, drift = rows.filter(row => row.enforcement === 'drift').length
    const unavailable = rows.filter(row => row.enforcement === 'unavailable' || row.usageState === 'unavailable').length
    if (raw.high !== high || raw.drift !== drift || raw.unavailable !== unavailable) return invalid()
    return { username: batch[index]!, status: oneOf(raw.status, ['active', 'suspended', 'terminating'] as const), plan: nullable(raw.plan, item => text(item, 128)),
      slice: oneOf(raw.slice, ['read', 'not-active', 'unavailable'] as const), quota: oneOf(raw.quota, ['read', 'unavailable'] as const), high, drift, unavailable, rows }
  })
  const sample = value.sample, state = oneOf(sample.state, ['read', 'unavailable'] as const)
  return { observedAt: iso(value.observedAt), host: oneOf(value.host, ['read', 'unavailable'] as const), highPercent: count(value.highPercent, 100),
    sample: { state, observedAt: nullable(sample.observedAt, iso), reason: state === 'read' ? sample.reason === null ? null : invalid() : nullable(sample.reason, item => text(item, 40)) }, accounts }
}

function readSelection(url: URL): string[] {
  if (url.search.length > 2048 || [...url.searchParams.keys()].some(key => key !== 'username')) return fail('VALIDATION', 'resource limits accept only username selectors', unchanged)
  const usernames = url.searchParams.getAll('username')
  if (usernames.length > SERVER_LIMITS_BATCH || new Set(usernames).size !== usernames.length || usernames.some(name => !USERNAME.test(name)))
    return fail('VALIDATION', `at most ${SERVER_LIMITS_BATCH} distinct account usernames may be selected`, unchanged)
  return usernames
}

/**
 * Root-only GET /api/server/server-health and GET /api/server/server-limits. Without selectors the limits read covers the
 * first 50 accounts and lists the rest as pending; with ?username= it reads exactly those (1..50) accounts.
 */
export async function handleServerHealthWorkspaceRoute(request: Request, url: URL, method: string, helpers: ServerHealthWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== '/api/server/server-health' && url.pathname !== '/api/server/server-limits') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, ACTION)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const health = url.pathname === '/api/server/server-health'
  if (health && url.search) return fail('VALIDATION', 'server health does not accept selectors', unchanged)
  const requested = health ? [] : readSelection(url)
  let batch: string[] = [], pending: string[] = [], truncated = false
  if (!health) {
    const visible = (await helpers.listAccounts()).map(account => account.username).sort()
    const known = new Set(visible)
    if (requested.some(name => !known.has(name))) return fail('NOT_FOUND', 'account not found', unchanged)
    batch = requested.length ? requested : visible.slice(0, SERVER_LIMITS_BATCH)
    pending = requested.length ? [] : visible.slice(SERVER_LIMITS_BATCH, SERVER_LIMITS_BATCH + MAX_PENDING)
    truncated = !requested.length && visible.length > SERVER_LIMITS_BATCH + MAX_PENDING
    if (!batch.length) return json({ observedAt: new Date().toISOString(), host: 'unavailable', highPercent: 90, sample: { state: 'unavailable', observedAt: null, reason: 'no-accounts' }, accounts: [], pending: [], truncated: false })
  }
  if (!helpers.readHost) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
  const raw = await helpers.readHost(caller, health ? '/host/server-health' : '/host/server-limits?' + batch.map(name => 'username=' + name).join('&'))
  const fresh = await helpers.requireCaller(request)
  await helpers.assertRoot(fresh, ACTION)
  if (fresh.principal.id !== caller.principal.id || fresh.sessionId !== caller.sessionId || fresh.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'server health authority changed', unchanged)
  if (health) return json(projectServerHealth(raw))
  const still = new Set((await helpers.listAccounts()).map(account => account.username))
  const report = projectServerLimits(raw, batch)
  return json({ ...report, accounts: report.accounts.filter(entry => still.has(entry.username)), pending: pending.filter(name => still.has(name)), truncated })
}

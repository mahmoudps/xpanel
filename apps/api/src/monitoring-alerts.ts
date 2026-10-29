import { fail } from '@xpanel/core'
import type { ServerHealthCheck, ServerHealthCheckId, ServerHealthReport, ServerHealthState } from '../../agent/src/server-health.ts'
import { sha256Hex } from './auth.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { projectServerHealth } from './server-health-workspace.ts'
import { ALERT_SCHEDULE_MINUTES, configuredChannels, dispatchAlertNotices, EMPTY_DELIVERY_STATE, planAlertNotices, readSavedDeliveryState, serialDelivery } from './alert-delivery.ts'
import type { DeliveryChannels, DeliveryState, DeliveryTransports, ScheduledRunResult } from './alert-delivery.ts'

/** State files and transports shared by the root routes and the API's scheduled run (alert-runtime.ts). */
export interface AlertCycleHelpers {
  /** ext.readOrDefault('monitoring/alerts.json', null) */
  readRules: () => Promise<unknown>
  /** ext.write('monitoring/alerts.json', value) */
  writeRules: (value: unknown) => Promise<unknown>
  /** ext.readOrDefault('monitoring/alerts-state.json', null) */
  readState: () => Promise<unknown>
  /** ext.write('monitoring/alerts-state.json', value) */
  writeState: (value: unknown) => Promise<unknown>
  /** ext.readOrDefault('monitoring/alerts-delivery.json', null) */
  readDelivery: () => Promise<unknown>
  /** ext.write('monitoring/alerts-delivery.json', value) */
  writeDelivery: (value: unknown) => Promise<unknown>
  /** Saved notification channels (panel-notifications.ts) with the webhook signing key; null when none are saved or they cannot be verified. */
  readChannels: () => Promise<DeliveryChannels | null>
  transports: DeliveryTransports
  now?: () => Date
}
export interface MonitoringAlertsHelpers extends AlertCycleHelpers, Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** GET /host/server-health through the protected agent; absent when no agent is connected. */
  readHost?: (caller: AuthenticatedCaller, path: string) => Promise<unknown>
}

export interface AlertBound { unit: 'per-processor' | 'percent' | 'days'; direction: 'above' | 'below'; min: number; max: number; decimals: 0 | 1; default: number }
export const ALERT_CHECK_IDS: readonly ServerHealthCheckId[] = ['load', 'memory', 'swap', 'disk-space', 'disk-inodes', 'services', 'drift', 'certificates', 'reboot', 'bandwidth']
/**
 * Documented threshold bounds. Defaults are the health warning levels (apps/agent/src/server-health.ts; a test keeps them equal).
 * Certificates stop at 14 days because the health check lists only certificates inside its 14-day window.
 * Checks without a bound fire when the health check reports a warning or a problem.
 */
export const ALERT_BOUNDS: Readonly<Record<ServerHealthCheckId, AlertBound | null>> = {
  load: { unit: 'per-processor', direction: 'above', min: 0.5, max: 10, decimals: 1, default: 1 },
  memory: { unit: 'percent', direction: 'below', min: 1, max: 50, decimals: 0, default: 15 },
  swap: { unit: 'percent', direction: 'above', min: 10, max: 99, decimals: 0, default: 50 },
  'disk-space': { unit: 'percent', direction: 'above', min: 50, max: 99, decimals: 0, default: 85 },
  'disk-inodes': { unit: 'percent', direction: 'above', min: 50, max: 99, decimals: 0, default: 85 },
  services: null,
  drift: null,
  certificates: { unit: 'days', direction: 'below', min: 1, max: 14, decimals: 0, default: 14 },
  reboot: null,
  bandwidth: { unit: 'percent', direction: 'above', min: 50, max: 100, decimals: 0, default: 80 },
}
export interface AlertRule { id: ServerHealthCheckId; enabled: boolean; threshold: number | null }
export interface QuietWindow { start: string; end: string }
export interface AlertRuleSettings { rules: AlertRule[]; quiet: QuietWindow | null; updatedAt: string; updatedBy: string }
export type AlertState = 'firing' | 'ok' | 'unavailable' | 'disabled'
export interface AlertResult {
  id: ServerHealthCheckId; enabled: boolean; threshold: number | null; state: AlertState; severity: 'critical' | 'warning' | null
  health: ServerHealthState; value: number | null; matches: string[]; evidence: string; firstFiredAt: string | null
}
export interface AlertEvaluation { evaluatedAt: string; observedAt: string; host: 'read' | 'unavailable'; rulesRevision: string; quiet: boolean; results: AlertResult[] }
export const DEFAULT_ALERT_RULES: readonly AlertRule[] = ALERT_CHECK_IDS.map(id => ({ id, enabled: true, threshold: ALERT_BOUNDS[id]?.default ?? null }))

const ROUTE = '/api/server/monitoring-alerts'
const EVALUATE = ROUTE + '/evaluate'
const MAX_BODY_BYTES = 16 * 1024
const DAY = 86_400_000
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const HEALTH_STATES: readonly unknown[] = ['ok', 'warning', 'problem', 'unavailable']
const RESULT_KEYS = 'enabled,evidence,firstFiredAt,health,id,matches,severity,state,threshold,value'
const LOG_VIEW_LIMIT = 50
const unchanged = { stateChanged: false }
const invalid = (message: string): never => fail('VALIDATION', message, unchanged)
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value))
const json = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const revisionOf = (raw: unknown): string => sha256Hex(JSON.stringify(raw ?? null))
const thresholdFits = (bound: AlertBound | null, value: unknown): boolean => bound === null ? value === null
  : typeof value === 'number' && Number.isFinite(value) && value >= bound.min && value <= bound.max && Number(value.toFixed(bound.decimals)) === value

function rulesOf(value: unknown): AlertRule[] {
  if (!Array.isArray(value) || value.length !== ALERT_CHECK_IDS.length) return invalid('rules must list every health check once, in order')
  return value.map((raw, index): AlertRule => {
    const id = ALERT_CHECK_IDS[index]!, bound = ALERT_BOUNDS[id]
    if (!object(raw) || Object.keys(raw).sort().join() !== 'enabled,id,threshold' || raw.id !== id || typeof raw.enabled !== 'boolean') return invalid(`rule ${index + 1} must be the ${id} check with enabled and threshold only`)
    if (!thresholdFits(bound, raw.threshold)) return invalid(bound ? `the ${id} threshold must be from ${bound.min} to ${bound.max}${bound.decimals ? ' with at most one decimal' : ' as a whole number'}` : `the ${id} rule has no threshold`)
    return { id, enabled: raw.enabled, threshold: raw.threshold as number | null }
  })
}
function quietOf(value: unknown): QuietWindow | null {
  if (value === null) return null
  if (!object(value) || Object.keys(value).sort().join() !== 'end,start' || typeof value.start !== 'string' || typeof value.end !== 'string' || !TIME.test(value.start) || !TIME.test(value.end) || value.start === value.end)
    return invalid('the quiet window needs different HH:MM start and end times in UTC, or null')
  return { start: value.start, end: value.end }
}

/** Strict saved-file reader: anything else is reported as invalid, never as saved rules. */
export function readSavedAlertRules(raw: unknown): AlertRuleSettings | null {
  try {
    if (!object(raw) || Object.keys(raw).sort().join() !== 'quiet,rules,updatedAt,updatedBy' || !iso(raw.updatedAt) || typeof raw.updatedBy !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(raw.updatedBy)) return null
    return { rules: rulesOf(raw.rules), quiet: quietOf(raw.quiet), updatedAt: raw.updatedAt, updatedBy: raw.updatedBy }
  } catch { return null }
}

export function parseAlertRulesUpdate(body: unknown): { rules: AlertRule[]; quiet: QuietWindow | null; expectedRevision: string } {
  if (!object(body) || Object.keys(body).sort().join() !== 'expectedRevision,quiet,rules') return invalid('rules, quiet and expectedRevision are required and nothing else is accepted')
  if (typeof body.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(body.expectedRevision)) return invalid('the observed rules revision is required')
  return { rules: rulesOf(body.rules), quiet: quietOf(body.quiet), expectedRevision: body.expectedRevision }
}

function resultOf(raw: unknown, index: number): AlertResult | null {
  const id = ALERT_CHECK_IDS[index]!, firing = object(raw) && raw.state === 'firing'
  if (!object(raw) || Object.keys(raw).sort().join() !== RESULT_KEYS || raw.id !== id || typeof raw.enabled !== 'boolean' || !thresholdFits(ALERT_BOUNDS[id], raw.threshold)
    || !['firing', 'ok', 'unavailable', 'disabled'].includes(raw.state as string) || (raw.state === 'disabled') === raw.enabled || !HEALTH_STATES.includes(raw.health)
    || (firing ? raw.severity !== (raw.health === 'problem' ? 'critical' : 'warning') || !iso(raw.firstFiredAt) : raw.severity !== null || raw.firstFiredAt !== null)
    || raw.value !== null && (typeof raw.value !== 'number' || !Number.isFinite(raw.value))
    || !Array.isArray(raw.matches) || raw.matches.length > 25 || !raw.matches.every(name => typeof name === 'string' && name.length <= 512)
    || typeof raw.evidence !== 'string' || raw.evidence.length > 1024) return null
  return raw as unknown as AlertResult
}
/** Strict reader for the recorded last evaluation; an unverifiable record is not used for firing-since continuity. */
export function readSavedAlertEvaluation(raw: unknown): AlertEvaluation | null {
  if (!object(raw) || Object.keys(raw).sort().join() !== 'evaluatedAt,host,observedAt,quiet,results,rulesRevision' || !iso(raw.evaluatedAt) || !iso(raw.observedAt) || (raw.host !== 'read' && raw.host !== 'unavailable')
    || typeof raw.rulesRevision !== 'string' || !/^[0-9a-f]{64}$/.test(raw.rulesRevision) || typeof raw.quiet !== 'boolean' || !Array.isArray(raw.results) || raw.results.length !== ALERT_CHECK_IDS.length) return null
  const results = raw.results.map(resultOf)
  return results.every(entry => entry !== null) ? raw as unknown as AlertEvaluation : null
}

// Evidence templates are written by evaluateServerHealth (apps/agent/src/server-health.ts); the tests run that producer, so a template change fails them.
const PERCENT_USED = /\((\d+(?:\.\d+)?)% used\)$/
const SCALAR: Partial<Record<ServerHealthCheckId, RegExp>> = { load: /; 5m per processor=(\d+(?:\.\d+)?)$/, memory: /\((\d+(?:\.\d+)?)% available\)$/, swap: PERCENT_USED }
const NOT_AFTER = /^notAfter=(.+?) source=/
const round = (value: number): number => Math.round(value * 100) / 100
type Probe = { fires: boolean | null; value: number | null; matches: string[] }

/** fires: true is proven, false is proven clear, null could not be verified from the observation. */
function probe(check: ServerHealthCheck, threshold: number | null, report: ServerHealthReport): Probe {
  const bound = ALERT_BOUNDS[check.id], unknown: Probe = { fires: null, value: null, matches: [] }
  if (!bound || threshold === null) return check.state === 'unavailable' ? unknown
    : { fires: check.state !== 'ok', value: null, matches: (check.items ?? []).filter(item => item.state === 'problem' || item.state === 'warning').map(item => item.name) }
  const fires = (value: number): boolean => bound.direction === 'above' ? value >= threshold : value < threshold
  const pattern = SCALAR[check.id]
  if (pattern) {
    if (check.reason === 'swap_none') return { fires: false, value: null, matches: [] }
    const match = check.state === 'unavailable' ? null : pattern.exec(check.evidence)
    if (!match) return unknown
    const value = Number(match[1])
    return { fires: fires(value), value, matches: [] }
  }
  if (check.state === 'unavailable' && !check.items?.length) return unknown
  // Unlisted entries (omitted, or certificates beyond the health window) could match, so only a listed match is proof.
  let hidden = (check.omitted ?? 0) > 0 || check.id === 'certificates' && threshold > report.thresholds.certificateExpiryDays
  const values: number[] = [], matches: string[] = []
  for (const item of check.items ?? []) {
    const match = item.state === 'unavailable' ? null : (check.id === 'certificates' ? NOT_AFTER : PERCENT_USED).exec(item.evidence)
    const value = !match ? NaN : check.id === 'certificates' ? (Date.parse(match[1]!) - Date.parse(report.observedAt)) / DAY : Number(match[1])
    if (!Number.isFinite(value)) { if (check.id === 'certificates' && item.state === 'problem') matches.push(item.name); else hidden = true; continue }
    values.push(value)
    if (fires(value)) matches.push(item.name)
  }
  const value = values.length ? round(bound.direction === 'above' ? Math.max(...values) : Math.min(...values)) : null
  return { fires: matches.length ? true : hidden ? null : false, value, matches }
}

const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3))
const inQuietWindow = (window: QuietWindow | null, at: Date): boolean => {
  if (!window) return false
  const now = at.getUTCHours() * 60 + at.getUTCMinutes(), start = minutesOf(window.start), end = minutesOf(window.end)
  return start < end ? now >= start && now < end : now >= start || now < end
}
/** Applies saved rules to one projected health report; firing-since carries over only while the same rule keeps firing at the same threshold. */
export function evaluateAlertRules(report: ServerHealthReport, settings: { rules: readonly AlertRule[]; quiet: QuietWindow | null }, previous: AlertEvaluation | null, evaluatedAt: Date, rulesRevision: string): AlertEvaluation {
  const at = evaluatedAt.toISOString()
  // projectServerHealth and rulesOf both fix the check order, so rule i reads check i.
  const results = settings.rules.map((rule, index): AlertResult => {
    const check = report.checks[index]!, base = { id: rule.id, enabled: rule.enabled, threshold: rule.threshold, health: check.state, evidence: check.evidence }
    if (check.id !== rule.id) return fail('PRECONDITION_FAILED', 'the server health observation could not be verified', unchanged)
    if (!rule.enabled) return { ...base, state: 'disabled', severity: null, value: null, matches: [], firstFiredAt: null }
    const { fires, value, matches } = probe(check, rule.threshold, report), before = previous?.results[index]
    return { ...base, state: fires === true ? 'firing' : fires === false ? 'ok' : 'unavailable', severity: fires === true ? check.state === 'problem' ? 'critical' : 'warning' : null, value, matches: matches.slice(0, 25),
      firstFiredAt: fires !== true ? null : before?.state === 'firing' && before.threshold === rule.threshold && before.firstFiredAt ? before.firstFiredAt : at }
  })
  return { evaluatedAt: at, observedAt: report.observedAt, host: report.host, rulesRevision, quiet: inQuietWindow(settings.quiet, evaluatedAt), results }
}

/** Delivery as recorded: the schedule and its last run, where alerts go (counts only, never the signing key), queued retries and the latest log. */
const deliveryOf = (rawDelivery: unknown, channels: DeliveryChannels | null) => {
  const saved = rawDelivery === null ? null : readSavedDeliveryState(rawDelivery)
  return {
    scheduler: { everyMinutes: ALERT_SCHEDULE_MINUTES, lastRun: saved?.lastRun ?? null }, state: rawDelivery === null ? 'none' : saved ? 'read' : 'invalid',
    channels: { alerts: !!channels?.alerts, email: channels?.recipients.length ?? 0, webhook: !!channels?.webhook, active: configuredChannels(channels) },
    pending: (saved?.outbox ?? []).map(item => ({ noticeId: item.notice.id, kind: item.notice.kind, ruleId: item.notice.ruleId, channel: item.channel, attempts: item.attempts, nextAt: item.nextAt })),
    log: (saved?.log ?? []).slice(0, LOG_VIEW_LIMIT),
  }
}
const viewOf = async (rawRules: unknown, rawState: unknown, helpers: AlertCycleHelpers) => {
  const saved = rawRules === null ? null : readSavedAlertRules(rawRules)
  const evaluation = rawState === null ? null : readSavedAlertEvaluation(rawState)
  return {
    state: rawRules === null ? 'default' : saved ? 'saved' : 'invalid', rules: saved?.rules ?? DEFAULT_ALERT_RULES, quiet: saved?.quiet ?? null,
    updatedAt: saved?.updatedAt ?? null, updatedBy: saved?.updatedBy ?? null, revision: revisionOf(rawRules), bounds: ALERT_BOUNDS,
    delivery: deliveryOf(await helpers.readDelivery(), await helpers.readChannels()), evaluationState: rawState === null ? 'none' : evaluation ? 'read' : 'invalid', evaluation,
  }
}

/** Plans notices from a recorded evaluation (or, without one, only retries queued notices) and records the outcome. lastRun is set by scheduled runs only. */
async function deliver(helpers: AlertCycleHelpers, now: Date, evaluation: AlertEvaluation | null, quiet: boolean, lastRun?: DeliveryState['lastRun']): Promise<void> {
  await serialDelivery(async () => {
    const before = readSavedDeliveryState(await helpers.readDelivery()) ?? EMPTY_DELIVERY_STATE
    const plan = evaluation ? planAlertNotices(evaluation, before.told) : { notices: [], told: before.told }
    const after = await dispatchAlertNotices({ state: { ...before, told: plan.told }, notices: plan.notices, channels: await helpers.readChannels(), transports: helpers.transports, now, quiet })
    await helpers.writeDelivery(lastRun === undefined ? after : { ...after, lastRun })
  })
}

/** Applies the rules to one health observation, records it with read-back verification, then delivers. Callers hold serial. */
async function recordEvaluation(report: ServerHealthReport, rawRules: unknown, saved: AlertRuleSettings | null, helpers: AlertCycleHelpers, now: Date, lastRun?: DeliveryState['lastRun']): Promise<unknown> {
  const record = evaluateAlertRules(report, saved ?? { rules: DEFAULT_ALERT_RULES, quiet: null }, readSavedAlertEvaluation(await helpers.readState()), now, revisionOf(rawRules))
  await helpers.writeState(record)
  const back = await helpers.readState()
  if (revisionOf(back) !== revisionOf(record)) return fail('SERVICE_UNAVAILABLE', 'the recorded evaluation could not be verified', { stateChanged: true, verificationRequired: true })
  try { await deliver(helpers, now, record, record.quiet, lastRun) }
  catch { return fail('SERVICE_UNAVAILABLE', 'the evaluation is recorded but its delivery record requires review', { stateChanged: true, verificationRequired: true }) }
  return back
}

/**
 * One scheduled cycle (alert-runtime.ts runs it every ALERT_SCHEDULE_MINUTES): evaluate with the saved rules, then deliver.
 * When the rules cannot be verified or the host cannot be read nothing is evaluated, but queued retries still run and the reason is recorded.
 */
export async function runScheduledAlertCycle(helpers: AlertCycleHelpers & { readHost: () => Promise<unknown> }): Promise<ScheduledRunResult> {
  const now = (helpers.now ?? (() => new Date()))()
  const skip = async (result: ScheduledRunResult, quiet: boolean): Promise<ScheduledRunResult> => { await deliver(helpers, now, null, quiet, { at: now.toISOString(), result }); return result }
  const first = await helpers.readRules()
  if (first !== null && !readSavedAlertRules(first)) return serial(() => skip('rules_invalid', false))
  let report: ServerHealthReport
  try { report = projectServerHealth(await helpers.readHost()) }
  catch { return serial(async () => skip('host_unavailable', inQuietWindow(readSavedAlertRules(await helpers.readRules())?.quiet ?? null, now))) }
  return serial(async () => {
    const rawRules = await helpers.readRules(), saved = rawRules === null ? null : readSavedAlertRules(rawRules)
    if (rawRules !== null && !saved) return skip('rules_invalid', false)
    await recordEvaluation(report, rawRules, saved, helpers, now, { at: now.toISOString(), result: 'evaluated' })
    return 'evaluated'
  })
}

// shortcut: in-process serialization only; one API process owns these extended state files.
let queue: Promise<unknown> = Promise.resolve()
const serial = <T>(task: () => Promise<T>): Promise<T> => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run }
async function freshRoot(request: Request, caller: AuthenticatedCaller, action: string, helpers: MonitoringAlertsHelpers): Promise<AuthenticatedCaller> {
  const actor = await helpers.requireCaller(request)
  await helpers.assertRoot(actor, action)
  if (actor.principal.id !== caller.principal.id || actor.sessionId !== caller.sessionId || actor.apiTokenId !== caller.apiTokenId) return fail('FORBIDDEN', 'alert authority changed', unchanged)
  return actor
}

/**
 * Root-only GET/PUT /api/server/monitoring-alerts (rules and quiet window) and POST /api/server/monitoring-alerts/evaluate
 * (one on-demand evaluation of the server health observation, delivered like a scheduled one).
 */
export async function handleMonitoringAlertsRoute(request: Request, url: URL, method: string, helpers: MonitoringAlertsHelpers): Promise<Response | null> {
  if (url.pathname !== ROUTE && url.pathname !== EVALUATE) return null
  const evaluating = url.pathname === EVALUATE
  const action = evaluating ? 'server.monitoring-alerts.evaluate' : method === 'PUT' ? 'server.monitoring-alerts.update' : 'server.monitoring-alerts.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  const allow = evaluating ? ['POST'] : ['GET', 'PUT']
  if (!allow.includes(method)) return new Response(null, { status: 405, headers: { allow: allow.join(', ') } })
  if (url.search) return invalid('alert routes do not accept selectors')
  if (method === 'GET') return json(await viewOf(await helpers.readRules(), await helpers.readState(), helpers))
  const now = helpers.now ?? (() => new Date())

  if (evaluating) {
    if ((await request.text()).length) return invalid('evaluation does not accept a body')
    if (!helpers.readHost) return fail('PRECONDITION_FAILED', 'privileged host agent is not connected', unchanged)
    const before = await helpers.readRules()
    if (before !== null && !readSavedAlertRules(before)) return fail('PRECONDITION_FAILED', 'the saved alert rules could not be verified; save them again before evaluating', unchanged)
    const report = projectServerHealth(await helpers.readHost(caller, '/host/server-health'))
    return serial(async () => {
      await freshRoot(request, caller, action, helpers)
      const rawRules = await helpers.readRules(), saved = rawRules === null ? null : readSavedAlertRules(rawRules)
      if (rawRules !== null && !saved) return fail('PRECONDITION_FAILED', 'the saved alert rules could not be verified; save them again before evaluating', unchanged)
      return json(await viewOf(rawRules, await recordEvaluation(report, rawRules, saved, helpers, now()), helpers))
    })
  }

  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return invalid('JSON is required')
  const text = await request.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return invalid('the request body is too large')
  let body: unknown
  try { body = JSON.parse(text) } catch { return invalid('request body is not valid JSON') }
  const input = parseAlertRulesUpdate(body)
  return serial(async () => {
    if (revisionOf(await helpers.readRules()) !== input.expectedRevision) return fail('CONFLICT', 'alert rules changed since they were read; reload before saving', unchanged)
    const actor = await freshRoot(request, caller, action, helpers)
    const next: AlertRuleSettings = { rules: input.rules, quiet: input.quiet, updatedAt: now().toISOString(), updatedBy: actor.principal.username }
    await helpers.writeRules(next)
    const saved = await helpers.readRules()
    if (revisionOf(saved) !== revisionOf(next) || !readSavedAlertRules(saved)) return fail('SERVICE_UNAVAILABLE', 'the saved alert rules could not be verified', { stateChanged: true, verificationRequired: true })
    try {
      await helpers.emitAudit({ actor: actor.principal.username, action: 'server.alerts.updated', target: 'monitoring:alerts', outcome: 'ok', principalId: actor.principal.id,
        detail: { enabled: next.rules.filter(rule => rule.enabled).map(rule => rule.id), thresholds: Object.fromEntries(next.rules.filter(rule => rule.threshold !== null).map(rule => [rule.id, rule.threshold])), quiet: next.quiet } })
    } catch { return fail('SERVICE_UNAVAILABLE', 'the rules are saved but their audit record requires review', { stateChanged: true, verificationRequired: true }) }
    return json(await viewOf(saved, await helpers.readState(), helpers))
  })
}

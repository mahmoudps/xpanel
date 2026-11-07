import { join } from 'node:path'
import { fail } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { mailLogRange } from './mail-log-workspace.ts'
import { mailxStatePath } from '../../agent/src/mailx-policy.ts'

/** Root mail reports over the agent's journal aggregate, the route trace and the permission repair job. */
export interface MailReportsHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore
  callHost?: (caller: AuthenticatedCaller, path: string, body?: unknown) => Promise<unknown>
  now?: () => Date
}
/** Reporting thresholds for View Sent Summary. Nothing here stops mail: 0 turns a threshold off. */
export interface MailSendLimits { domainHourlyLimit: number; deferFailPercent: number; deferFailMinimum: number }
export const MAIL_SEND_LIMIT_DEFAULTS: MailSendLimits = { domainHourlyLimit: 0, deferFailPercent: 0, deferFailMinimum: 5 }
interface DomainRow { domain: string; account: string; messages: number; sent: number; deferred: number; failed: number; bytes: number }

export const MAIL_REPORT_ROUTE = /^\/api\/server\/(?:mail-reports\/(?:relayers|sent-summary|send-limits)|mail-trace|mail-maintenance\/repair)$/
const HOUR_MS = 3_600_000
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const unverified = (): never => fail('SERVICE_UNAVAILABLE', 'the mail report could not be verified', unchanged)
const reportOf = (value: unknown): Record<string, unknown> & { relayers: unknown[]; domains: DomainRow[] } =>
  object(value) && ['read', 'unavailable'].includes(String(value.state)) && Array.isArray(value.relayers) && Array.isArray(value.domains) ? value as never : unverified()
const parseLimits = (value: unknown): MailSendLimits | null =>
  object(value) && count(value.domainHourlyLimit, 1_000_000) && count(value.deferFailPercent, 100) && count(value.deferFailMinimum, 1_000_000)
    ? { domainHourlyLimit: value.domainHourlyLimit, deferFailPercent: value.deferFailPercent, deferFailMinimum: value.deferFailMinimum } : null

/** Over the hourly limit, or over the deferred and failed share once a domain has sent the minimum. */
export function flagSentDomain(row: DomainRow, limits: MailSendLimits): DomainRow & { overHourly: boolean; overDeferFail: boolean } {
  const problems = row.deferred + row.failed, total = row.sent + problems
  return { ...row, overHourly: limits.domainHourlyLimit > 0 && row.messages > limits.domainHourlyLimit,
    overDeferFail: limits.deferFailPercent > 0 && problems >= limits.deferFailMinimum && total > 0 && problems * 100 / total >= limits.deferFailPercent }
}

export async function handleMailReportsWorkspaceRoute(req: Request, url: URL, method: string, helpers: MailReportsHelpers): Promise<Response | null> {
  if (!MAIL_REPORT_ROUTE.test(url.pathname)) return null
  const path = url.pathname, action = 'server.mail-reports', now = helpers.now ?? (() => new Date())
  const caller = await helpers.requireCaller(req)
  await helpers.assertRoot(caller, action)
  const confirm = async (): Promise<void> => {
    const current = await helpers.requireCaller(req)
    await helpers.assertRoot(current, action)
    if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'mail report authority changed', unchanged)
  }
  const limitsPath = join(helpers.store.rootDir, ...mailxStatePath('send-limits.json'))
  const limits = async (): Promise<MailSendLimits> => {
    const stored = await readJsonIfExists<unknown>(limitsPath).catch(() => null)
    return parseLimits(stored) ?? MAIL_SEND_LIMIT_DEFAULTS
  }
  const host = async <T>(call: (read: NonNullable<MailReportsHelpers['callHost']>) => Promise<T>): Promise<T> => helpers.callHost ? call(helpers.callHost) : fail('PRECONDITION_FAILED', 'no protected host agent is connected', unchanged)
  if (path.endsWith('/send-limits')) {
    if (method === 'GET') { const body = await limits(); await confirm(); return json({ limits: body }) }
    if (method !== 'PUT') return new Response(null, { status: 405, headers: { allow: 'GET, PUT' } })
    const body = parseLimits(await req.json().catch(() => null))
    if (!body) return fail('VALIDATION', 'an hourly limit, a percentage from 0 through 100 and a minimum message count are required', unchanged)
    const lease = await helpers.store.getWriterLock().acquire()
    try { await confirm(); await lease.assertFencingToken(); await atomicWriteJson(limitsPath, body, 0o640, () => lease.assertFencingToken()) } finally { await lease.release() }
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.mail_reports.limits_saved', target: 'server:mail-policy', outcome: 'ok', detail: { ...body } })
    return json({ limits: body })
  }
  if (path.endsWith('/mail-trace')) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await req.json().catch(() => null)
    const address = object(body) && Object.keys(body).length === 1 ? body.address : null
    if (typeof address !== 'string' || address.length > 254) return fail('VALIDATION', 'one destination address is required', unchanged)
    const reply = await host(call => call(caller, '/host/mail/trace', { address: address.trim().toLowerCase() }))
    await confirm()
    return json(object(reply) && typeof reply.deliverable === 'boolean' && Array.isArray(reply.steps) ? reply : unverified())
  }
  if (path.endsWith('/repair')) {
    if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
    const body = await req.json().catch(() => null)
    if (!object(body) || Object.keys(body).length !== 1 || !(body.accounts === 'all' || Array.isArray(body.accounts) && body.accounts.length <= 1000)) return fail('VALIDATION', 'accounts must be all or a list of account names', unchanged)
    const reply = await host(call => call(caller, '/host/mail/maintenance/repair', { accounts: body.accounts }))
    if (!object(reply) || !Array.isArray(reply.jobs) || !count(reply.accounts, 1_000_000)) return fail('SERVICE_UNAVAILABLE', 'the repair job outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
    await helpers.emitAudit({ actor: caller.principal.username, principalId: caller.principal.id, action: 'server.mail_maintenance.repair_requested', target: 'mail:repair-permissions', outcome: 'ok', detail: { accounts: reply.accounts, jobs: reply.jobs.length } })
    return json(reply, 202)
  }
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  const summary = path.endsWith('/sent-summary'), current = summary && url.searchParams.get('view') === 'current'
  for (const key of new Set(url.searchParams.keys())) if (![...(summary ? ['view'] : []), 'since', 'until'].includes(key) || url.searchParams.getAll(key).length !== 1) return fail('VALIDATION', 'unsupported or repeated report selector', unchanged)
  if (summary && !['history', 'current', null].includes(url.searchParams.get('view'))) return fail('VALIDATION', 'view must be history or current', unchanged)
  if (current && (url.searchParams.has('since') || url.searchParams.has('until'))) return fail('VALIDATION', 'the current view always reads the last hour', unchanged)
  const end = Math.floor(now().getTime() / 1000) * 1000, stamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + 'Z'
  const range = current ? { since: stamp(end - HOUR_MS), until: stamp(end) } : mailLogRange(url, now)
  const { relayers, relayersOmitted, domains, domainsOmitted, ...view } = reportOf(await host(call => call(caller, '/host/mail/log/report?' + new URLSearchParams(range).toString())))
  await confirm()
  if (!summary) return json({ ...view, rows: relayers, omitted: relayersOmitted })
  const thresholds = await limits()
  return json({ ...view, view: current ? 'current' : 'history', limits: thresholds, rows: current ? domains.map(row => flagSentDomain(row, thresholds)) : domains, omitted: domainsOmitted })
}

import { agentCallerHeaders } from '@xpanel/agent'
import type { AgentApp } from '@xpanel/agent'
import { appendAudit, findPrincipalByUsername, listAudit } from '@xpanel/db'
import type { Db } from '@xpanel/db'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { join } from 'node:path'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import type { SecKind } from '../../agent/src/sec-policy.ts'
import { alertTransports } from './alert-runtime.ts'
import type { DeliveryTransports } from './alert-delivery.ts'
import { renewForwardCertificates } from './forward-certificate.ts'
import { AUTOSSL_PROVIDER, autoSslReportable, handleAutoSslRoute, readAutoSslScheduler, readAutoSslState, runAutoSslTick } from './autossl.ts'
import type { AutoSslLogRow, CaaLookup } from './autossl.ts'
import type { AgentCall } from './certificate-runtime.ts'
import { applyMarketingOutcomes, handleMailMarketingRoute, runMarketingTick } from './mail-marketing.ts'
import { handleNotificationTemplateRoute, sendNotification } from './notification-templates.ts'
import { handleOutboundHoldRoute, readMailOutcomes, readOutboundPolicy, readOutboundState, runOutboundTick } from './outbound-spam.ts'
import type { OutboundHold } from './outbound-spam.ts'

const TICK_MS = 60_000
/** The audit log already records these, so a notice follows the action on every path that performs it. */
const AUDITED_NOTICES = ['account.provisioned', 'account.suspended', 'account.unsuspended'] as const
const NOTICE_CURSOR = 'extended/panel/notification-cursor.json'
const QUOTA_STATE = 'extended/panel/quota-warnings.json'
const QUOTA_PERCENT = 90

export interface MailCertInput {
  db: Db; store: StateStore; agentApp: AgentApp; agentToken: string; publicOrigin: string | null
  admit: <T>(task: () => Promise<T>) => Promise<T>
  transports?: DeliveryTransports; caa?: CaaLookup; resolves?: (name: string) => Promise<boolean>; onError?: (part: string) => void; everyMs?: number
}
/** Scheduled work calls the agent as the built-in root principal, like the administrative CLI (cli.ts). */
export const rootAgentCall = (input: Pick<MailCertInput, 'db' | 'agentApp' | 'agentToken'>): AgentCall => async (path, options) => {
  const principal = await findPrincipalByUsername(input.db, 'root')
  if (!principal || principal.disabled || principal.kind !== 'root') throw new Error('an active root principal is required for scheduled work')
  return input.agentApp.fetch(new Request('http://agent.local' + path, { method: options.method ?? 'GET', headers: { ...agentCallerHeaders({ principalId: principal.id, token: input.agentToken }), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) }))
}

/** Run state shown beside the saved policy of these tools. */
export async function readMailCertExtra(store: StateStore, kind: SecKind): Promise<Record<string, unknown>> {
  if (kind === 'autossl') { const state = await readAutoSslState(store); return { provider: AUTOSSL_PROVIDER, scheduler: await readAutoSslScheduler(store), queue: state.queue.slice(0, 200), log: state.log.slice(0, 200) } }
  if (kind !== 'outbound-spam') return {}
  const state = await readOutboundState(store), rows = (table: Record<string, { hourly: number; daily: number }>, scope: string) => Object.entries(table).map(([target, counter]) => ({ scope, target, ...counter }))
  return { holds: state.holds, usage: [...rows(state.accounts, 'account'), ...rows(state.domains, 'domain'), ...rows(state.mailboxes, 'mailbox')].sort((a, b) => b.hourly - a.hourly).slice(0, 200) }
}

export interface MailCertRouteHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  store: StateStore; publicOrigin: string | null
  /** The protected agent as this caller; null without a connected host agent. */
  call: ((caller: AuthenticatedCaller) => AgentCall) | null
}
/** The root routes of these tools; each handler answers only its own paths. */
export async function handleMailCertRoutes(request: Request, url: URL, method: string, helpers: MailCertRouteHelpers): Promise<Response | null> {
  const email = async () => (await alertTransports(helpers.store)).email
  return await handleNotificationTemplateRoute(request, url, method, { ...helpers, email, adminEmail: async () => (await helpers.store.getServerSettings())?.adminEmail || null })
    ?? await handleMailMarketingRoute(request, url, method, { ...helpers, email })
    ?? await handleOutboundHoldRoute(request, url, method, helpers)
    ?? await handleAutoSslRoute(request, url, method, helpers)
}

const SUMMARY_LINES = 200
export const autoSslSummary = (rows: readonly AutoSslLogRow[]): string => rows.slice(0, SUMMARY_LINES).map(row => `${row.domain}: ${row.result}${row.code ? ' (' + row.code + ')' : ''}. ${row.message}`).join('\n')

/** Sends the notices for account actions audited since the last cursor; a first run starts at now, so history is never mailed. */
async function deliverAccountNotices(input: MailCertInput, transports: DeliveryTransports, now: Date): Promise<void> {
  const path = join(input.store.rootDir, NOTICE_CURSOR), saved = await readJsonIfExists<{ at?: string }>(path).catch(() => null)
  if (!saved?.at) { await atomicWriteJson(path, { at: now.toISOString() }, 0o640); return }
  const delivery = { store: input.store, email: transports.email }, snapshot = await input.store.readSnapshot()
  for (const action of AUDITED_NOTICES) {
    for (const entry of await listAudit(input.db, { action, from: saved.at, limit: 200 })) {
      if (entry.outcome !== 'ok' || entry.at <= saved.at) continue
      const username = /^account:([a-z][a-z0-9]{0,15})$/.exec(entry.target)?.[1], account = snapshot.accounts.find(item => item.username === username)
      if (!account?.contactEmail) continue
      await sendNotification(delivery, { event: action, to: account.contactEmail, locale: 'en', values: { account: account.username, domain: account.primaryDomain, server: transports.serverName } }).catch(() => input.onError?.('account-notice'))
    }
  }
  await atomicWriteJson(path, { at: now.toISOString() }, 0o640)
}

/** Once a day: an account at 90% of its disk quota is warned once a month. */
async function deliverQuotaWarnings(input: MailCertInput, call: AgentCall, transports: DeliveryTransports, now: Date): Promise<void> {
  const path = join(input.store.rootDir, QUOTA_STATE), saved = await readJsonIfExists<{ day?: string; warned?: Record<string, string> }>(path).catch(() => null), day = now.toISOString().slice(0, 10), month = day.slice(0, 7)
  if (saved?.day === day) return
  const warned = { ...saved?.warned }, response = await call('/host/monitoring/disk', {})
  const disk = response.ok ? await response.json().catch(() => null) as { accounts?: { state?: string; items?: { username: string; usedBytes: number | null }[] } } | null : null
  if (disk?.accounts?.state === 'read') {
    const snapshot = await input.store.readSnapshot(), plans = new Map(snapshot.plans.map(plan => [plan.id, plan]))
    for (const item of disk.accounts.items ?? []) {
      const account = snapshot.accounts.find(row => row.username === item.username), limit = account?.limits?.resources?.diskMb ?? plans.get(account?.planId ?? '')?.resources.diskMb
      if (!account?.contactEmail || typeof limit !== 'number' || limit < 1 || item.usedBytes === null || warned[item.username] === month) continue
      const usedMb = Math.ceil(item.usedBytes / 1048576), percent = Math.floor(usedMb * 100 / limit)
      if (percent < QUOTA_PERCENT) continue
      await sendNotification({ store: input.store, email: transports.email }, { event: 'quota.warning', to: account.contactEmail, locale: 'en', values: { account: item.username, usedMb: String(usedMb), limitMb: String(limit), percent: String(percent), server: transports.serverName } }).then(() => { warned[item.username] = month }).catch(() => input.onError?.('quota-warning'))
    }
  }
  await atomicWriteJson(path, { day, warned }, 0o640)
}

/**
 * One minute timer inside the API service (no extra daemon or timer unit), never two ticks at once, each under a fresh
 * lifecycle writer admission. A part that fails is retried by the next tick and never stops the others.
 */
// A certificate authority limits repeated failures, so a refused renewal waits.
const FORWARD_RENEWAL_INTERVAL_MS = 6 * 3_600_000
export function startMailCertScheduler(input: MailCertInput): { stop: () => Promise<void>; tick: () => Promise<void> } {
  let running: Promise<unknown> | null = null, stopped = false, timer: ReturnType<typeof setTimeout> | undefined, lastForwardRenewal = 0
  const part = async (name: string, work: () => Promise<void>): Promise<void> => { try { await work() } catch { input.onError?.(name) } }
  const work = async (): Promise<void> => {
    const transports = input.transports ?? await alertTransports(input.store), now = new Date(), call = rootAgentCall(input), admin = (await input.store.getServerSettings())?.adminEmail || null
    const audit = async (entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }, actor: string): Promise<void> => { await appendAudit(input.db, { actor, ...entry }) }
    const delivery = { store: input.store, email: transports.email }
    if (now.getTime() - lastForwardRenewal >= FORWARD_RENEWAL_INTERVAL_MS) { lastForwardRenewal = now.getTime(); await part('forward-certificates', () => renewForwardCertificates(input.store, (path, options) => call(path, options), now)) }
    await part('autossl', () => runAutoSslTick({ store: input.store, call, seed: transports.serverName,
      ...(input.caa ? { caa: input.caa } : {}), ...(input.resolves ? { resolves: input.resolves } : {}),
      reconcile: async () => { const response = await call('/state/apply', { method: 'POST', body: { force: false } }), body = await response.json().catch(() => null) as { status?: string } | null; return response.ok && ['applied', 'noop'].includes(String(body?.status)) },
      audit: entry => audit(entry, 'system:autossl'),
      report: async (rows, levels) => {
        const snapshot = await input.store.readSnapshot(), adminRows = autoSslReportable(rows, levels.admin)
        if (admin && adminRows.length) await sendNotification(delivery, { event: 'ssl.renewal', to: admin, locale: 'en', values: { account: 'all accounts', summary: autoSslSummary(adminRows), server: transports.serverName } })
        for (const username of new Set(rows.map(row => row.username))) {
          const own = autoSslReportable(rows.filter(row => row.username === username), levels.user), contact = snapshot.accounts.find(account => account.username === username)?.contactEmail
          if (contact && own.length) await sendNotification(delivery, { event: 'ssl.renewal', to: contact, locale: 'en', values: { account: username, summary: autoSslSummary(own), server: transports.serverName } })
        }
      } }))
    await part('mail-log', async () => {
      const policy = await readOutboundPolicy(input.store), state = await readOutboundState(input.store), marketing = await readJsonIfExists(join(input.store.rootDir, 'extended/mail/marketing.json')).catch(() => null)
      if (!policy?.enabled && marketing === null) return
      const read = await readMailOutcomes(call, state.cursor, now)
      if (!read) return
      await applyMarketingOutcomes(input.store, read.outcomes.marketing, now)
      await runOutboundTick({ store: input.store, call, actor: 'system:outbound', audit: entry => audit(entry, 'system:outbound'),
        notify: async (hold: OutboundHold, contact) => {
          const values = { target: hold.key, count: String(hold.count), limit: String(hold.limit), window: hold.window === 'hourly' ? 'hour' : 'day', server: transports.serverName }
          for (const to of new Set([admin, contact].filter((item): item is string => !!item))) await sendNotification(delivery, { event: 'mail.outbound_hold', to, locale: 'en', values })
        } }, read)
    })
    await part('mail-marketing', () => runMarketingTick({ store: input.store, email: transports.email, webhook: transports.webhook, publicOrigin: input.publicOrigin }))
    await part('account-notices', () => deliverAccountNotices(input, transports, now))
    await part('quota-warnings', () => deliverQuotaWarnings(input, call, transports, now))
  }
  const tick = (): Promise<void> => {
    if (running || stopped) return Promise.resolve()
    const task = input.admit(work).catch(() => input.onError?.('admission')).finally(() => { running = null; schedule() })
    running = task
    return task
  }
  const schedule = (): void => { if (stopped) return; timer = setTimeout(() => void tick(), input.everyMs ?? TICK_MS); timer.unref() }
  schedule()
  return { tick, stop: async () => { stopped = true; clearTimeout(timer); await running } }
}

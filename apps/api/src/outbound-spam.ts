import { join } from 'node:path'
import { fail } from '@xpanel/core'
import type { Account, Domain } from '@xpanel/core'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { workspaceJson } from './account-ssh-workspace.ts'
import type { AgentCall } from './certificate-runtime.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSecRaw, secBody } from './sec-workspace.ts'
import { readSecRecord, SEC_DEFAULTS } from '../../agent/src/sec-policy.ts'
import { mailxCompositeRevision, mailxStatePath } from '../../agent/src/mailx-policy.ts'
import { readMailxSaved } from '../../agent/src/mailx-routes.ts'
import type { MailOutcomes } from '../../agent/src/mail-log-reports.ts'
import type { OutboundSpamPolicy } from '../../agent/src/mail-cert-policy.ts'

/** Rolling usage and the current holds. Holds are desired state: the mail policy section is rendered from them. */
export const OUTBOUND_STATE = 'extended/mail/outbound-usage.json'
export interface OutboundHold { key: string; scope: 'mailbox' | 'domain' | 'account'; window: 'hourly' | 'daily'; count: number; limit: number; at: string }
interface Counter { hourly: number; daily: number }
export interface OutboundState { version: 1; cursor: string | null; hour: string | null; day: string | null; mailboxes: Record<string, Counter>; domains: Record<string, Counter>; accounts: Record<string, Counter>; holds: OutboundHold[]; unapplied?: boolean }
export const EMPTY_OUTBOUND_STATE: OutboundState = { version: 1, cursor: null, hour: null, day: null, mailboxes: {}, domains: {}, accounts: {}, holds: [] }
const unchanged = { stateChanged: false }
const review = { stateChanged: true, verificationRequired: true, unknownOutcome: true }
const LOOK_BACK_MS = 300_000, MAX_CATCH_UP_MS = 3_600_000

const statePath = (store: Pick<StateStore, 'rootDir'>): string => join(store.rootDir, OUTBOUND_STATE)
export function parseOutboundState(value: unknown): OutboundState {
  const raw = value as Partial<OutboundState> | null
  return raw && raw.version === 1 && Array.isArray(raw.holds) && raw.mailboxes && raw.accounts ? { ...raw, domains: raw.domains ?? {} } as OutboundState : structuredClone(EMPTY_OUTBOUND_STATE)
}
export const readOutboundState = async (store: Pick<StateStore, 'rootDir'>): Promise<OutboundState> => parseOutboundState(await readJsonIfExists<unknown>(statePath(store)).catch(() => null))
export const readOutboundPolicy = async (store: Pick<StateStore, 'rootDir'>): Promise<OutboundSpamPolicy | null> => {
  const raw = await readSecRaw(store, 'outbound-spam')
  return raw === null ? structuredClone(SEC_DEFAULTS['outbound-spam']) : readSecRecord('outbound-spam', raw)?.policy ?? null
}

/** A mailbox rule beats the server mailbox default; an account rule beats its plan rule, which beats the server account default. */
export function outboundLimits(policy: OutboundSpamPolicy, target: { mailbox?: string; domain?: string; account?: string; plan?: string | null }): { hourly: number; daily: number } {
  const rule = (scope: string, name: string | null | undefined) => name ? policy.rules.find(item => item.scope === scope && item.target === name.toLowerCase()) : undefined
  if (target.mailbox) return rule('mailbox', target.mailbox) ?? { hourly: policy.mailboxHourly, daily: policy.mailboxDaily }
  if (target.domain) return rule('domain', target.domain) ?? { hourly: policy.domainHourly, daily: policy.domainDaily }
  return rule('account', target.account) ?? rule('plan', target.plan) ?? { hourly: policy.accountHourly, daily: policy.accountDaily }
}

export interface OutboundSnapshot { accounts: readonly Pick<Account, 'id' | 'username' | 'planId' | 'contactEmail'>[]; domains: readonly Pick<Domain, 'name' | 'accountId'>[]; plans: readonly { id: string; name: string }[] }
/** Adds a usage read to the rolling counters and returns the holds it newly causes; a key already held is not raised again. */
export function applyOutboundUsage(state: OutboundState, usage: MailOutcomes['usage'], policy: OutboundSpamPolicy, snapshot: OutboundSnapshot, now: Date): OutboundHold[] {
  const hour = now.toISOString().slice(0, 13), day = now.toISOString().slice(0, 10)
  if (state.day !== day) { state.day = day; state.hour = hour; state.mailboxes = {}; state.domains = {}; state.accounts = {} }
  else if (state.hour !== hour) { state.hour = hour; for (const row of [...Object.values(state.mailboxes), ...Object.values(state.domains), ...Object.values(state.accounts)]) row.hourly = 0 }
  const owners = new Map(snapshot.domains.map(domain => [domain.name, domain.accountId])), accounts = new Map(snapshot.accounts.map(account => [account.id, account])), plans = new Map(snapshot.plans.map(plan => [plan.id, plan.name]))
  const added: OutboundHold[] = [], held = new Set(state.holds.map(hold => hold.scope + ' ' + hold.key))
  const check = (scope: OutboundHold['scope'], key: string, counter: Counter, limits: { hourly: number; daily: number }): void => {
    if (held.has(scope + ' ' + key)) return
    const window = limits.hourly > 0 && counter.hourly > limits.hourly ? 'hourly' : limits.daily > 0 && counter.daily > limits.daily ? 'daily' : null
    if (!window) return
    const hold: OutboundHold = { key, scope, window, count: counter[window], limit: limits[window], at: now.toISOString() }
    held.add(scope + ' ' + key); added.push(hold); state.holds.push(hold)
  }
  const touched = new Set<string>()
  for (const row of usage) {
    const account = accounts.get(owners.get(row.domain) ?? '')
    if (!account) continue
    const bump = (table: Record<string, Counter>, key: string): void => { const counter = table[key] ??= { hourly: 0, daily: 0 }; counter.hourly += row.recipients; counter.daily += row.recipients }
    bump(state.accounts, account.username); touched.add(account.username)
    bump(state.domains, row.domain); check('domain', row.domain, state.domains[row.domain]!, outboundLimits(policy, { domain: row.domain }))
    if (row.user.includes('@')) { bump(state.mailboxes, row.user); check('mailbox', row.user, state.mailboxes[row.user]!, outboundLimits(policy, { mailbox: row.user })) }
  }
  for (const username of touched) {
    const account = snapshot.accounts.find(item => item.username === username)!
    check('account', username, state.accounts[username]!, outboundLimits(policy, { account: username, plan: plans.get(account.planId) ?? null }))
  }
  return added
}

interface HoldSnapshot { accounts: readonly (Pick<Account, 'id' | 'username'> & { uid?: number | null })[]; domains: readonly Pick<Domain, 'name' | 'accountId'>[] }
/** What Postfix must hold: a mailbox by address, an account by every domain and by its UID for local sendmail. */
export function outboundHoldMaps(holds: readonly OutboundHold[], snapshot: HoldSnapshot): { senders: string[]; uids: number[] } {
  const senders = new Set<string>(), uids = new Set<number>()
  for (const hold of holds) {
    if (hold.scope === 'mailbox' || hold.scope === 'domain') { senders.add(hold.key); continue }
    const account = snapshot.accounts.find(item => item.username === hold.key)
    if (!account) continue
    for (const domain of snapshot.domains) if (domain.accountId === account.id) senders.add(domain.name)
    if (Number.isSafeInteger(account.uid) && account.uid! >= 1000) uids.add(account.uid!)
  }
  return { senders: [...senders].sort(), uids: [...uids].sort((a, b) => a - b) }
}

export interface OutboundPorts { store: StateStore; call: AgentCall; audit: (entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>; notify?: (hold: OutboundHold, contact: string | null) => Promise<void>; actor: string; now?: () => Date }
/** Writes the hold section and applies it through the mail policy path, which tests Postfix and rolls back. */
async function applyHolds(ports: Pick<OutboundPorts, 'store' | 'call' | 'actor' | 'now'>, holds: readonly OutboundHold[]): Promise<boolean> {
  const snapshot = await ports.store.readSnapshot(), policy = outboundHoldMaps(holds, snapshot as unknown as HoldSnapshot)
  const lease = await ports.store.getWriterLock().acquire()
  try {
    await lease.assertFencingToken()
    await atomicWriteJson(join(ports.store.rootDir, ...mailxStatePath('outbound.json')), { section: 'outbound', policy, updatedAt: (ports.now ?? (() => new Date()))().toISOString(), updatedBy: ports.actor }, 0o640)
  } finally { await lease.release() }
  const response = await ports.call('/host/mailx/apply', { method: 'POST', body: { revision: mailxCompositeRevision(await readMailxSaved(ports.store.rootDir)) } })
  const body = await response.json().catch(() => null) as { outcome?: string } | null
  return response.ok && (body?.outcome === 'applied' || body?.outcome === 'nothing')
}
const instant = (at: number): string => new Date(at).toISOString().slice(0, 19) + 'Z'
/** Reads the deliveries since the last tick once; the campaign tick shares the same read. */
export async function readMailOutcomes(call: AgentCall, cursor: string | null, now: Date): Promise<{ outcomes: MailOutcomes; from: string; until: string } | null> {
  const end = Math.floor(now.getTime() / 1000) * 1000, start = Math.max(cursor ? Date.parse(cursor) : end - 60_000, end - MAX_CATCH_UP_MS)
  const from = instant(start), until = instant(end)
  if (start >= end) return null
  const response = await call('/host/mail/log/outcomes?' + new URLSearchParams({ since: instant(start - LOOK_BACK_MS), until, from }).toString(), {})
  const outcomes = response.ok ? await response.json().catch(() => null) as MailOutcomes | null : null
  return outcomes?.state === 'read' ? { outcomes, from, until } : null
}
/** One tick: counts what the log shows since the last one and holds a sender over its limit. Detection follows the log, so mail sent inside that minute goes out. */
export async function runOutboundTick(ports: OutboundPorts, read: { outcomes: MailOutcomes; until: string }): Promise<void> {
  const policy = await readOutboundPolicy(ports.store)
  const state = await readOutboundState(ports.store), now = (ports.now ?? (() => new Date()))()
  state.cursor = read.until
  if (policy?.enabled) {
    const snapshot = await ports.store.readSnapshot(), added = applyOutboundUsage(state, read.outcomes.usage, policy, snapshot as unknown as OutboundSnapshot, now)
    if (added.length || state.unapplied) {
      const applied = await applyHolds(ports, state.holds).catch(() => false)
      // A hold Postfix has not taken is retried each tick; the page already lists it.
      state.unapplied = !applied
      for (const hold of added) {
        await ports.audit({ action: 'mail.outbound.held', target: hold.scope + ':' + hold.key, outcome: applied ? 'ok' : 'failed', detail: { window: hold.window, count: hold.count, limit: hold.limit } })
        const account = hold.scope === 'account' ? snapshot.accounts.find(item => item.username === hold.key) : snapshot.accounts.find(item => snapshot.domains.some(domain => domain.accountId === item.id && domain.name === hold.key.slice(hold.key.lastIndexOf('@') + 1)))
        await ports.notify?.(hold, account?.contactEmail || null).catch(() => undefined)
      }
    }
  }
  await atomicWriteJson(statePath(ports.store), state, 0o640)
}

export interface OutboundRouteHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> { store: StateStore; call: ((caller: Parameters<ExtendedRouteHelpers['assertRoot']>[0]) => AgentCall) | null }
const BASE = '/api/server/mail/outbound/holds'
/** Lifts a hold, then releases or deletes what it held. A lifted sender starts from zero, so a release does not hold it again in the same window. */
export async function handleOutboundHoldRoute(request: Request, url: URL, method: string, helpers: OutboundRouteHelpers): Promise<Response | null> {
  if (url.pathname !== BASE + '/release' && url.pathname !== BASE + '/delete') return null
  const action = url.pathname.endsWith('/release') ? 'release' : 'delete', caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.mail.outbound.manage')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (!helpers.call) return fail('PRECONDITION_FAILED', 'held mail needs the host agent', { ...unchanged, reason: 'host_agent_unavailable' })
  const body = await secBody(request, 1024)
  if (Object.keys(body).join() !== 'key' || typeof body.key !== 'string') return fail('VALIDATION', 'name the held sender', unchanged)
  const key = body.key, state = await readOutboundState(helpers.store), hold = state.holds.find(item => item.key === key)
  if (!hold) return fail('NOT_FOUND', 'this sender is not held', unchanged)
  const snapshot = await helpers.store.readSnapshot(), { senders } = outboundHoldMaps([hold], snapshot as unknown as HoldSnapshot)
  const remaining = state.holds.filter(item => item !== hold), call = helpers.call(caller)
  if (!await applyHolds({ store: helpers.store, call, actor: caller.principal.username }, remaining)) return fail('SERVICE_UNAVAILABLE', 'the hold could not be lifted; review the mail policy', review)
  state.holds = remaining
  delete (hold.scope === 'mailbox' ? state.mailboxes : hold.scope === 'domain' ? state.domains : state.accounts)[key]
  await atomicWriteJson(statePath(helpers.store), state, 0o640)
  const response = await call('/host/mail/queue/held', { method: 'POST', body: { senders, action } })
  const result = response.ok ? await response.json().catch(() => null) as { matched?: number; remaining?: number | null } | null : null
  await helpers.emitAudit({ actor: caller.principal.username, action: action === 'release' ? 'mail.outbound.released' : 'mail.outbound.deleted', target: (hold.scope === 'mailbox' ? 'mailbox:' : 'account:') + key, principalId: caller.principal.id, outcome: result?.remaining === 0 ? 'ok' : 'failed', detail: { matched: result?.matched ?? null, remaining: result?.remaining ?? null } }).catch(() => undefined)
  if (result?.remaining !== 0) return fail('SERVICE_UNAVAILABLE', 'held messages require review in the mail queue', review)
  return workspaceJson({ key, action, matched: result.matched ?? 0 })
}

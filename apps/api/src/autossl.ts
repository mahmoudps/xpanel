import { createHash } from 'node:crypto'
import { lookup, Resolver } from 'node:dns/promises'
import { join } from 'node:path'
import { fail, isXpanelError, redactInlineSecrets } from '@xpanel/core'
import type { Account, Certificate, Domain } from '@xpanel/core'
import { services } from '@xpanel/render'
import { validateCertificateRenewalTarget } from '@xpanel/agent'
import { atomicWriteJson, readJsonIfExists } from '@xpanel/state'
import type { StateStore } from '@xpanel/state'
import { workspaceJson } from './account-ssh-workspace.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { readSecRaw, secBody } from './sec-workspace.ts'
import { requestAcmeMaterial } from './certificate-runtime.ts'
import type { AgentCall } from './certificate-runtime.ts'
import { readSecRecord, SEC_DEFAULTS } from '../../agent/src/sec-policy.ts'
import type { AutoSslNotifyLevel, AutoSslPolicy } from '../../agent/src/mail-cert-policy.ts'

/** Run state beside the saved policy: the schedule, the pending queue and 30 days of results. */
export const AUTOSSL_STATE = 'extended/tls/autossl-state.json'
const DAY_MS = 86_400_000, LOG_DAYS = 30, LOG_MAX = 2000, QUEUE_MAX = 5000, RETRY_MAX_DAYS = 8
/** The only CA this release orders from (agent ACME directory); a CAA set must name it. */
export const AUTOSSL_CAA_ISSUER = 'letsencrypt.org'
export const AUTOSSL_PROVIDER = { name: "Let's Encrypt", challenge: 'http-01', maxValidityDays: 90, wildcard: false, ancestorValidation: false }

export type AutoSslReason = 'renewal' | 'missing' | 'replacement'
export type AutoSslResult = 'issued' | 'renewed' | 'skipped' | 'deferred' | 'failed'
export type AutoSslTrigger = 'nightly' | 'manual' | 'new-domain'
export interface AutoSslQueueRow { username: string; domain: string; certificateId: string | null; reason: AutoSslReason; trigger: AutoSslTrigger; attempts: number; nextAttemptAt: string; lastCode: string | null }
export interface AutoSslLogRow { at: string; trigger: AutoSslTrigger; username: string; domain: string; result: AutoSslResult; code: string | null; message: string }
export interface AutoSslState { version: 1; nextRunAt: string | null; lastRunAt: string | null; pending: { username: string | null } | null; queue: AutoSslQueueRow[]; log: AutoSslLogRow[]; unreported: AutoSslLogRow[] }
export const EMPTY_AUTOSSL_STATE: AutoSslState = { version: 1, nextRunAt: null, lastRunAt: null, pending: null, queue: [], log: [], unreported: [] }

export interface AutoSslSnapshot { accounts: readonly Pick<Account, 'id' | 'username' | 'status'>[]; domains: readonly Pick<Domain, 'id' | 'accountId' | 'name' | 'certificateId'>[]; certificates: readonly Certificate[] }

/**
 * What a run orders, and why. Uploaded certificates are never touched unless replacement is on and they are expired
 * or within 3 days of expiry. An ACME certificate renews once, however many domains share it. DNS-01 and wildcard
 * certificates need a DNS challenge this run does not perform, so they stay out.
 */
export function autoSslCandidates(snapshot: AutoSslSnapshot, policy: AutoSslPolicy, now: Date, only: string | null = null): Omit<AutoSslQueueRow, 'trigger' | 'attempts' | 'nextAttemptAt' | 'lastCode'>[] {
  const accounts = new Map(snapshot.accounts.filter(account => account.status === 'active' && !policy.excludedAccounts.includes(account.username) && (only === null || account.username === only)).map(account => [account.id, account]))
  const certificates = new Map(snapshot.certificates.map(certificate => [certificate.id, certificate]))
  const due = new Set(services.certsForAutoRenew(snapshot.certificates, now, policy.renewDays).map(certificate => certificate.id))
  const rows: ReturnType<typeof autoSslCandidates> = [], renewed = new Set<string>()
  for (const domain of snapshot.domains) {
    const account = accounts.get(domain.accountId)
    if (!account || policy.excludedDomains.includes(domain.name) || domain.name.startsWith('*.')) continue
    const certificate = domain.certificateId ? certificates.get(domain.certificateId) : undefined
    const row = (reason: AutoSslReason, certificateId: string | null) => rows.push({ username: account.username, domain: domain.name, certificateId, reason })
    if (!certificate) { row('missing', null); continue }
    if (certificate.source === 'upload') {
      const left = Date.parse(certificate.notAfter) - now.getTime()
      if (policy.replaceInvalid && !(left > 3 * DAY_MS)) row('replacement', null)
      continue
    }
    if (!due.has(certificate.id)) continue
    if (certificate.source === 'self-signed') { row('missing', null); continue }
    if (certificate.challenge !== 'http-01' || certificate.names.some(name => name.startsWith('*.')) || renewed.has(certificate.id)) continue
    renewed.add(certificate.id); row('renewal', certificate.id)
  }
  return rows.slice(0, QUEUE_MAX)
}

export type CaaLookup = (name: string) => Promise<{ tag: string; value: string }[]>
const CAA_ANSWERS_NOTHING = new Set(['ENODATA', 'ENOTFOUND', 'NOTFOUND', 'NODATA'])
/** RFC 8659 tree climb: the closest name with a CAA set decides; a set without an issue property allows any CA. */
export async function caaAllows(name: string, resolve: CaaLookup, issuer = AUTOSSL_CAA_ISSUER): Promise<boolean> {
  const labels = name.replace(/^\*\./, '').split('.')
  for (let index = 0; index < labels.length - 1; index++) {
    let set: { tag: string; value: string }[]
    try { set = await resolve(labels.slice(index).join('.')) }
    catch (error) { if (CAA_ANSWERS_NOTHING.has((error as NodeJS.ErrnoException).code ?? '')) continue; throw error }
    const issue = set.filter(record => record.tag.toLowerCase() === 'issue')
    if (!set.length) continue
    return !issue.length || issue.some(record => record.value.split(';')[0]!.trim().toLowerCase() === issuer)
  }
  return true
}
/** Node names the property in the record itself: { critical, issue: 'letsencrypt.org' }. */
export const systemCaaLookup: CaaLookup = async name => {
  const resolver = new Resolver({ timeout: 5000, tries: 2 })
  return (await resolver.resolveCaa(name)).flatMap(record => Object.entries(record).filter(([tag]) => tag !== 'critical').map(([tag, value]) => ({ tag, value: String(value) })))
}

/** One fixed hour per host, derived from its name, so a fleet does not reach the CA at once. */
export function nextAutoSslRun(now: Date, seed: string): string {
  const minutes = 60 + createHash('sha256').update(seed).digest().readUInt16BE(0) % 240
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + minutes * 60_000
  return new Date(today > now.getTime() ? today : today + DAY_MS).toISOString()
}

const statePath = (store: Pick<StateStore, 'rootDir'>): string => join(store.rootDir, AUTOSSL_STATE)
const iso = (value: unknown): boolean => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
export function parseAutoSslState(value: unknown): AutoSslState {
  const raw = value as Partial<AutoSslState> | null
  // A damaged run file costs one schedule read, never a saved policy or an order.
  return raw && raw.version === 1 && iso(raw.nextRunAt) && iso(raw.lastRunAt) && Array.isArray(raw.queue) && Array.isArray(raw.log) && Array.isArray(raw.unreported) ? raw as AutoSslState : structuredClone(EMPTY_AUTOSSL_STATE)
}
export const readAutoSslState = async (store: Pick<StateStore, 'rootDir'>): Promise<AutoSslState> => parseAutoSslState(await readJsonIfExists<unknown>(statePath(store)).catch(() => null))
const writeState = (store: Pick<StateStore, 'rootDir'>, state: AutoSslState): Promise<void> => atomicWriteJson(statePath(store), state, 0o640)
let serial: Promise<unknown> = Promise.resolve()
/** The minute tick and the manual run route change the same file; each change reads it fresh. */
const changeState = <T>(store: Pick<StateStore, 'rootDir'>, change: (state: AutoSslState) => T): Promise<T> => {
  const run = serial.then(async () => { const state = await readAutoSslState(store), result = change(state); await writeState(store, state); return result })
  serial = run.catch(() => undefined)
  return run
}
export const readAutoSslPolicy = async (store: Pick<StateStore, 'rootDir'>): Promise<AutoSslPolicy | null> => {
  const raw = await readSecRaw(store, 'autossl')
  return raw === null ? structuredClone(SEC_DEFAULTS.autossl) : readSecRecord('autossl', raw)?.policy ?? null
}
/** `active` only once the scheduler has written a next run: a host without the host agent never starts it. */
export async function readAutoSslScheduler(store: Pick<StateStore, 'rootDir'>): Promise<{ state: 'active' | 'disabled' | 'unavailable'; nextRunAt: string | null; lastRunAt: string | null; reason: string | null; renewDays: number | null }> {
  const policy = await readAutoSslPolicy(store).catch(() => null), state = await readAutoSslState(store)
  if (!policy) return { state: 'unavailable', nextRunAt: null, lastRunAt: state.lastRunAt, reason: 'autossl_policy_invalid', renewDays: null }
  if (!policy.enabled) return { state: 'disabled', nextRunAt: null, lastRunAt: state.lastRunAt, reason: 'autossl_disabled', renewDays: null }
  return state.nextRunAt ? { state: 'active', nextRunAt: state.nextRunAt, lastRunAt: state.lastRunAt, reason: null, renewDays: policy.renewDays } : { state: 'unavailable', nextRunAt: null, lastRunAt: state.lastRunAt, reason: 'host_agent_unavailable', renewDays: null }
}
/** Asks the next minute tick to run; a run needs the host agent, so a request never orders by itself. */
export const requestAutoSslRun = (store: Pick<StateStore, 'rootDir'>, username: string | null): Promise<void> => changeState(store, state => { state.pending = { username } })

export interface AutoSslPorts {
  store: StateStore
  call: AgentCall
  /** One generation for the changed certificate; false when it could not be confirmed. */
  reconcile: () => Promise<boolean>
  audit: (entry: { action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }) => Promise<unknown>
  /** Mails the results of a finished run. */
  report?: (rows: readonly AutoSslLogRow[], levels: { admin: AutoSslNotifyLevel; user: AutoSslNotifyLevel }) => Promise<void>
  caa?: CaaLookup
  resolves?: (name: string) => Promise<boolean>
  seed: string
  now?: () => Date
}
const LEVEL_RESULTS: Readonly<Record<AutoSslNotifyLevel, readonly AutoSslResult[]>> = { all: ['issued', 'renewed', 'skipped', 'deferred', 'failed'], problems: ['skipped', 'deferred', 'failed'], failures: ['failed'], none: [] }
export const autoSslReportable = (rows: readonly AutoSslLogRow[], level: AutoSslNotifyLevel): AutoSslLogRow[] => rows.filter(row => LEVEL_RESULTS[level].includes(row.result))
const refused = (code: string, message: string) => ({ result: 'skipped' as const, code, message })
const clip = (text: string): string => redactInlineSecrets(text).replace(/[\r\n]+/g, ' ').slice(0, 300)

/** One order: CAA and DNS first, so a name the CA would refuse costs no failed validation against the rate limit. */
async function attempt(ports: AutoSslPorts, row: AutoSslQueueRow): Promise<{ result: AutoSslResult; code: string | null; message: string }> {
  const { store } = ports, snapshot = await store.readSnapshot()
  const account = snapshot.accounts.find(item => item.username === row.username), domain = snapshot.domains.find(item => item.name === row.domain && item.accountId === account?.id)
  if (!account || account.status !== 'active' || !domain) return refused('target_changed', 'The account or domain is no longer active.')
  const certificate = row.certificateId ? snapshot.certificates.find(item => item.id === row.certificateId) ?? null : null
  const renewal = row.certificateId ? validateCertificateRenewalTarget({ certificateId: row.certificateId, certificate, accountId: account.id, domain, domains: snapshot.domains }) : null
  const names = renewal?.names ?? [domain.name]
  try {
    for (const name of names) if (!await caaAllows(name, ports.caa ?? systemCaaLookup)) return refused('caa_forbids', `The CAA records of ${name} do not allow ${AUTOSSL_CAA_ISSUER}. No order was placed.`)
    for (const name of names) if (!await (ports.resolves ?? (host => lookup(host).then(() => true, () => false)))(name)) return { result: 'deferred', code: 'dns_unresolved', message: `${name} does not resolve yet. No order was placed.` }
  } catch { return { result: 'deferred', code: 'dns_unavailable', message: 'The DNS checks could not finish. No order was placed.' } }
  const expectedRevision = snapshot.revision
  try {
    const material = await requestAcmeMaterial(ports.call, account.username, { domain: domain.name, expectedRevision, ...(renewal ? { certificateId: renewal.certificateId } : {}) })
    if ((renewal && material.id !== renewal.certificateId) || JSON.stringify([...material.names].sort()) !== JSON.stringify([...names].sort())) return { result: 'failed', code: 'names_differ', message: 'The issued certificate does not match the reviewed names.' }
    await store.saveCertificateBinding({ ...material, accountId: account.id, source: 'acme', challenge: 'http-01', autoRenew: true }, domain.id, { expectedRevision, certificateGuard: async (current, domains) => {
      const fresh = domains.find(item => item.id === domain.id && item.accountId === account.id && item.name === domain.name)
      if (!fresh) throw new Error('certificate domain changed')
      if (renewal) validateCertificateRenewalTarget({ certificateId: renewal.certificateId, certificate: current, accountId: account.id, domain: fresh, domains })
      else if (current) throw new Error('fresh certificate identity already exists')
    } })
    const applied = await ports.reconcile()
    await ports.audit({ action: renewal ? 'certificate.renewed' : 'certificate.issued', target: 'domain:' + domain.name, outcome: 'ok', detail: { certificateId: material.id, names: material.names, notAfter: material.notAfter, automatic: true } })
    return applied ? { result: renewal ? 'renewed' : 'issued', code: null, message: `Valid until ${material.notAfter}.` }
      : { result: 'failed', code: 'apply_unverified', message: 'The certificate was saved, but its configuration could not be confirmed.' }
  } catch (error) {
    if (isXpanelError(error)) return { result: 'failed', code: String(error.detail.reason ?? error.code).slice(0, 64), message: clip(error.message) }
    return { result: 'failed', code: 'order_failed', message: 'The order could not be completed.' }
  }
}

/** A failed order waits 1, 2, 4, then 8 days: the CA limits failed validations per host name. */
const retryAt = (now: Date, attempts: number): string => new Date(now.getTime() + Math.min(2 ** Math.max(attempts - 1, 0), RETRY_MAX_DAYS) * DAY_MS).toISOString()

/** One minute tick: refreshes the schedule, queues a due run and places at most one order, so a large host never loads the CPU or the CA. */
export async function runAutoSslTick(ports: AutoSslPorts): Promise<void> {
  const now = (ports.now ?? (() => new Date()))(), policy = await readAutoSslPolicy(ports.store)
  if (!policy) return
  if (!policy.enabled) {
    await changeState(ports.store, state => { state.nextRunAt = null; state.pending = null; state.queue = [] })
    return
  }
  const snapshot = await ports.store.readSnapshot() as unknown as AutoSslSnapshot
  const next = await changeState(ports.store, state => {
    state.nextRunAt ??= nextAutoSslRun(now, ports.seed)
    const nightly = Date.parse(state.nextRunAt) <= now.getTime(), pending = state.pending
    const stamp = (rows: ReturnType<typeof autoSslCandidates>, trigger: AutoSslTrigger): AutoSslQueueRow[] => rows.filter(row => !state.queue.some(item => item.domain === row.domain)).map(row => ({ ...row, trigger, attempts: 0, nextAttemptAt: now.toISOString(), lastCode: null }))
    if (nightly || pending) {
      const trigger = nightly ? 'nightly' : 'manual', only = nightly ? null : pending!.username
      // A manual run retries what is waiting; the nightly run keeps each row's own back-off.
      if (!nightly) for (const row of state.queue) if (only === null || row.username === only) row.nextAttemptAt = now.toISOString()
      state.queue.push(...stamp(autoSslCandidates(snapshot, policy, now, only), trigger))
      state.lastRunAt = now.toISOString()
      if (nightly) state.nextRunAt = nextAutoSslRun(now, ports.seed)
      state.pending = null
    } else state.queue.push(...stamp(autoSslCandidates(snapshot, policy, now).filter(row => row.reason === 'missing'), 'new-domain').filter(row => !state.log.some(entry => entry.domain === row.domain && Date.parse(entry.at) > now.getTime() - DAY_MS)))
    state.queue.splice(QUEUE_MAX)
    return state.queue.find(row => Date.parse(row.nextAttemptAt) <= now.getTime()) ?? null
  })
  if (next) {
    const outcome = await attempt(ports, next).catch(() => ({ result: 'failed' as const, code: 'order_failed', message: 'The order could not be completed.' }))
    const entry: AutoSslLogRow = { at: now.toISOString(), trigger: next.trigger, username: next.username, domain: next.domain, ...outcome }
    await changeState(ports.store, state => {
      const row = state.queue.find(item => item.domain === next.domain)
      if (row && (outcome.result === 'deferred' || outcome.result === 'failed') && row.attempts < 8) { row.attempts++; row.lastCode = outcome.code; row.nextAttemptAt = retryAt(now, row.attempts) }
      else state.queue = state.queue.filter(item => item.domain !== next.domain)
      const cutoff = now.getTime() - LOG_DAYS * DAY_MS
      state.log = [entry, ...state.log.filter(item => Date.parse(item.at) >= cutoff)].slice(0, LOG_MAX)
      state.unreported = [...state.unreported, entry].slice(-LOG_MAX)
    })
  }
  const finished = await changeState(ports.store, state => {
    if (state.queue.some(row => Date.parse(row.nextAttemptAt) <= now.getTime()) || !state.unreported.length) return null
    const rows = state.unreported
    state.unreported = []
    return rows
  })
  if (finished && ports.report) await ports.report(finished, { admin: policy.adminNotify, user: policy.userNotify }).catch(() => undefined)
}

/** WHM "Run now": for every account, or one when its name is given. The next minute tick performs the run. */
export async function handleAutoSslRoute(request: Request, url: URL, method: string, helpers: Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> & { store: StateStore }): Promise<Response | null> {
  if (url.pathname !== '/api/server/ssl/autossl/run') return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, 'server.sec.autossl.run')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const body = await secBody(request, 256), username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : null
  if (url.search || Object.keys(body).some(key => key !== 'username')) return fail('VALIDATION', 'only an account name is accepted', { stateChanged: false })
  if (username !== null && !await helpers.store.getAccountByUsername(username)) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
  const scheduler = await readAutoSslScheduler(helpers.store)
  if (scheduler.state !== 'active') return fail('PRECONDITION_FAILED', 'automatic certificates are not running on this server', { stateChanged: false, reason: scheduler.reason })
  await requestAutoSslRun(helpers.store, username)
  await helpers.emitAudit({ actor: caller.principal.username, action: 'server.sec.autossl.run', target: username ? 'account:' + username : 'server:autossl', principalId: caller.principal.id, outcome: 'ok', detail: {} }).catch(() => undefined)
  return workspaceJson({ queued: true, username })
}

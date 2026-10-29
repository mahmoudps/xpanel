import { fail } from '@xpanel/core'
import type { OsProfile } from '@xpanel/core'
import { services as render } from '@xpanel/render'
import type { StateSnapshot } from '@xpanel/state'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { DOVECOT_OBSERVED_SETTINGS, DOVECOT_PATH_SETTINGS, MAIL_SERVER_PAGE_KEYS, isDovecotFileReference, MASTER_OBSERVED_OPTIONS, POSTFIX_OBSERVED_KEYS } from '../../../packages/os/src/mail-server-command.ts'
import type { MailServerPage } from '../../../packages/os/src/mail-server-command.ts'
import { MAIL_SERVER_MAX_SERVICES, isMailServerText, parsePostconfMain, parsePostconfMaster } from '../../agent/src/mail-server-observation.ts'
import type { MailServerObservation, MasterService } from '../../agent/src/mail-server-observation.ts'
import { mailxDovecotLines, mailxRoutingModes, renderMailxPostfix } from '../../agent/src/mailx-policy.ts'
import type { MailxDovecotDialect, MailxRoutingMode, MailxSaved } from '../../agent/src/mailx-policy.ts'
import { mailxCertPaths } from '../../../packages/os/src/mailx-command.ts'

export type MailServerState = 'match' | 'drift' | 'not-managed' | 'unknown'
export type MailServerHost = 'connected' | 'not-connected' | 'unverified'
export type MailDomainExpectation = 'mx-saved' | 'mx-missing' | 'zone-missing' | 'no-mailboxes'
export interface MailServerComparison { key: string; observed: string | null; desired: string | null; state: MailServerState }
export interface MailServerSettingRow extends MailServerComparison { source: 'postfix' | 'dovecot' }
export interface MailServerServiceRow { service: string; observed: string | null; desired: string | null; state: MailServerState; options: MailServerComparison[]; otherOptions: number }
/** `mode` is the saved routing (local unless the routing policy names the domain). */
export interface MailServerDomainRow { domain: string; account: string | null; mailboxes: number; zone: string | null; mx: { priority: number | null; host: string }[]; state: MailDomainExpectation; mode: MailxRoutingMode }
export interface MailServerWorkspaceView {
  page: MailServerPage
  host: MailServerHost
  observedAt: string | null
  sources: { postfix: 'read' | 'unavailable'; master: 'read' | 'unavailable'; dovecot: 'read' | 'unavailable'; desired: 'rendered' | 'unavailable' }
  settings: MailServerSettingRow[]
  services: MailServerServiceRow[]
  domains: MailServerDomainRow[]
  truncated: boolean
  /** The settings are edited through the saved server mail policy (/api/server/mailx/server and /routing). */
  editable: true
}
export type MailServerSaved = Pick<StateSnapshot, 'accounts' | 'domains' | 'serviceUsers' | 'zones'>
/** `masterOptions` holds overrides of services the reconciler does not render (the port 25 certificate). */
export interface MailServerDesired { main: Map<string, string>; master: MasterService[]; dovecot: Map<string, string>; masterOptions?: Record<string, Record<string, string>> }
export interface MailServerWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot'> {
  /** The authenticated agent runs only postconf -n, postconf -M and doveconf -h; absent when no host agent is connected. */
  readObservation?: (caller: AuthenticatedCaller) => Promise<unknown>
  readSaved: () => Promise<MailServerSaved>
  /** The saved server mail policy; its rendered values join the reconciler's as "Rendered by xPanel". */
  readMailPolicy?: () => Promise<MailxSaved>
  os?: OsProfile
}

export const MAIL_SERVER_MAX_DOMAINS = 2000
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const iso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
const invalid = (): never => { throw new Error('invalid_mail_server_observation') }
const REASONS = ['command_failed', 'output_limit', 'malformed_output']
const header = (value: unknown): 'read' | 'unavailable' => {
  if (!object(value) || !['read', 'unavailable'].includes(String(value.state)) || (value.state === 'read' ? value.reason !== undefined : !REASONS.includes(String(value.reason)))) return invalid()
  return value.state as 'read' | 'unavailable'
}
const values = (raw: unknown, keys: readonly string[], nullable: boolean, max?: number): Record<string, string | null> => {
  if (!object(raw) || Object.keys(raw).some(key => !keys.includes(key))) return invalid()
  return Object.fromEntries(keys.filter(key => key in raw).map(key => [key, raw[key] === null && nullable ? null : isMailServerText(raw[key], max) ? raw[key] : invalid()]))
}

/** Whitelists the host boundary: allowlisted parameter names and bounded observed text only. */
export function projectMailServerObservation(value: unknown): MailServerObservation {
  if (!object(value) || !iso(value.observedAt) || !object(value.postfix) || !object(value.master) || !object(value.dovecot)) return invalid()
  const postfix = header(value.postfix), master = header(value.master), dovecot = header(value.dovecot)
  const settings = values(value.postfix.settings, POSTFIX_OBSERVED_KEYS, false) as Record<string, string>
  const dovecotSettings = values(value.dovecot.settings, DOVECOT_OBSERVED_SETTINGS, true, 1024)
  // Certificate and key settings may only name a file (or be empty); anything else could be key material.
  if (DOVECOT_PATH_SETTINGS.some(key => { const item = dovecotSettings[key]; return item != null && item !== '' && !isDovecotFileReference(item) })) return invalid()
  const raw = value.master.services
  if (!Array.isArray(raw) || raw.length > MAIL_SERVER_MAX_SERVICES || Object.keys(dovecotSettings).length !== DOVECOT_OBSERVED_SETTINGS.length) return invalid()
  const seen = new Set<string>()
  const services = raw.map((item): MasterService => {
    if (!object(item) || typeof item.service !== 'string' || !/^[A-Za-z0-9_.:[\]/-]{1,128}$/.test(item.service) || seen.has(item.service) || typeof item.fields !== 'string'
      || !/^inet [yn-] [yn-] [yn-] (?:-|\d{1,9}\??) (?:-|\d{1,9}) [A-Za-z0-9_./-]{1,128}$/.test(item.fields) || !Number.isSafeInteger(item.otherOptions) || (item.otherOptions as number) < 0) return invalid()
    seen.add(item.service)
    return { service: item.service, fields: item.fields, options: values(item.options, MASTER_OBSERVED_OPTIONS, false) as Record<string, string>, otherOptions: item.otherOptions as number }
  })
  const read = (state: string, entries: number) => state === 'read' || entries === 0 ? state as 'read' | 'unavailable' : invalid()
  return {
    observedAt: value.observedAt,
    postfix: { state: read(postfix, Object.keys(settings).length), ...(postfix === 'unavailable' ? { reason: value.postfix.reason as 'command_failed' } : {}), settings },
    master: { state: read(master, services.length), ...(master === 'unavailable' ? { reason: value.master.reason as 'command_failed' } : {}), services },
    dovecot: { state: dovecot === 'read' ? Object.values(dovecotSettings).some(item => item !== null) ? 'read' : invalid() : Object.values(dovecotSettings).every(item => item === null) ? 'unavailable' : invalid(),
      ...(dovecot === 'unavailable' ? { reason: 'command_failed' as const } : {}), settings: dovecotSettings },
  }
}

/** The configuration the reconciler applies on every mail host (applyPostfixLocalDelivery), parsed with the same grammar as the observation. */
export function renderedMailServerDesired(os: OsProfile | undefined): MailServerDesired | null {
  if (!os) return null
  try {
    // 10-auth.conf holds top-level `name = value` lines only; comments are dropped before the shared parser runs.
    const auth = render.renderDovecotAuthConf(os).content.split('\n').filter(line => !line.startsWith('#')).join('\n')
    return { main: parsePostconfMain(render.localDeliveryMainBlock(os)), master: parsePostconfMaster(render.localSubmissionMasterBlock(os)), dovecot: parsePostconfMain(auth) }
  } catch { return null }
}

/**
 * Adds what the saved mail policy renders: main.cf parameters, the port 25 certificate, the Dovecot server file in the
 * host's dialect, and the chosen mail-client certificate (the generation renders it for submission and, unless IMAP has
 * its own, for Dovecot).
 */
export function withMailPolicy(desired: MailServerDesired | null, saved: MailxSaved | null, dialect: MailxDovecotDialect = '2.3'): MailServerDesired | null {
  if (!desired || !saved) return desired
  const plan = renderMailxPostfix(saved), main = new Map(desired.main), dovecot = new Map(desired.dovecot)
  for (const [key, value] of Object.entries(plan.settings)) main.set(key, value)
  const server = saved.sections.server?.policy, submission = server?.certificates.submission ?? null
  if (submission) main.set('smtpd_tls_cert_file', mailxCertPaths(submission).certFile)
  // The policy lines are `name = value`, the same grammar as the observation.
  if (server) for (const [key, value] of parsePostconfMain(mailxDovecotLines(server.dovecot, server.certificates.imap ?? submission, dialect).join('\n'))) dovecot.set(key, value)
  const masterOptions: Record<string, Record<string, string>> = typeof plan.master === 'string'
    ? { smtp: { smtpd_tls_cert_file: mailxCertPaths(plan.master).certFile } } : {}
  return { ...desired, main, dovecot, masterOptions }
}

// postconf(5): list values are separated by commas and/or whitespace, so separators alone are not drift.
const same = (left: string, right: string): boolean => left.split(/[\s,]+/).filter(Boolean).join(' ') === right.split(/[\s,]+/).filter(Boolean).join(' ')
const compare = (rendered: boolean, observedRead: boolean, observed: string | null, desired: string | null): MailServerState =>
  !rendered ? 'unknown' : desired === null ? 'not-managed' : !observedRead ? 'unknown' : observed !== null && same(observed, desired) ? 'match' : 'drift'
const SUBMISSION = /(?:^|:)(?:587|465|submission|submissions|smtps)$/

function serviceRows(page: MailServerPage, observation: MailServerObservation | null, desired: MailServerDesired | null): MailServerServiceRow[] {
  if (page === 'routing') return []
  const read = observation?.master.state === 'read'
  const observed = (observation?.master.services ?? []).filter(item => page === 'server' || SUBMISSION.test(item.service))
  const names = [...new Set([...(desired?.master ?? []).map(item => item.service), ...observed.map(item => item.service), ...Object.keys(desired?.masterOptions ?? {})])]
  return names.map(service => {
    const have = observed.find(item => item.service === service), want = desired?.master.find(item => item.service === service)
    const extra = desired?.masterOptions?.[service] ?? {}
    const options = MASTER_OBSERVED_OPTIONS.filter(key => (want && key in want.options) || key in extra || (have && key in have.options)).map(key => {
      const seen = have?.options[key] ?? null, rendered = want?.options[key] ?? extra[key] ?? null
      return { key, observed: seen, desired: rendered, state: compare(!!desired, read, seen, rendered) }
    })
    const fields = compare(!!desired, read, have?.fields ?? null, want?.fields ?? null)
    const state: MailServerState = fields === 'drift' || options.some(item => item.state === 'drift') ? 'drift' : fields === 'match' && options.every(item => item.state !== 'unknown') ? 'match' : fields
    return { service, observed: have?.fields ?? null, desired: want?.fields ?? null, state, options, otherOptions: have?.otherOptions ?? 0 }
  })
}

function domainRows(saved: MailServerSaved, modes: ReadonlyMap<string, MailxRoutingMode>): { rows: MailServerDomainRow[]; truncated: boolean } {
  const accounts = new Map(saved.accounts.map(account => [account.id, account]))
  // compileDesiredGeneration lists a virtual mailbox domain for each domain with an email service user, skipping terminating accounts.
  const mailboxes = new Map<string, number>()
  for (const user of saved.serviceUsers) if (user.services.email) mailboxes.set(user.domainId, (mailboxes.get(user.domainId) ?? 0) + 1)
  const zones = [...saved.zones].sort((a, b) => b.name.length - a.name.length)
  const domains = [...saved.domains].sort((a, b) => a.name.localeCompare(b.name))
  const rows = domains.slice(0, MAIL_SERVER_MAX_DOMAINS).map((domain): MailServerDomainRow => {
    const name = domain.name.toLowerCase(), account = accounts.get(domain.accountId)
    const zone = zones.find(item => name === item.name.toLowerCase() || name.endsWith('.' + item.name.toLowerCase()))
    const relative = zone && name !== zone.name.toLowerCase() ? name.slice(0, -(zone.name.length + 1)) : '@'
    const mx = (zone?.records ?? []).filter(record => record.type === 'MX' && record.name.toLowerCase() === relative).slice(0, 20).map(record => ({ priority: record.priority, host: record.content.slice(0, 255) }))
    const count = account && account.status !== 'terminating' ? mailboxes.get(domain.id) ?? 0 : 0
    return { domain: domain.name, account: account?.username ?? null, mailboxes: count, zone: zone?.name ?? null, mx, state: count === 0 ? 'no-mailboxes' : !zone ? 'zone-missing' : mx.length ? 'mx-saved' : 'mx-missing', mode: modes.get(name) ?? 'local' }
  })
  return { rows, truncated: domains.length > rows.length }
}

export function buildMailServerView(page: MailServerPage, observation: MailServerObservation | null, host: MailServerHost, desired: MailServerDesired | null, saved: MailServerSaved | null, policy: MailxSaved | null = null): MailServerWorkspaceView {
  const postfixRead = observation?.postfix.state === 'read', dovecotRead = observation?.dovecot.state === 'read'
  const settings: MailServerSettingRow[] = MAIL_SERVER_PAGE_KEYS[page].map(key => {
    const observed = observation?.postfix.settings[key] ?? null, rendered = desired?.main.get(key) ?? null
    return { source: 'postfix', key, observed, desired: rendered, state: compare(!!desired, postfixRead, observed, rendered) }
  })
  if (page === 'server') for (const key of DOVECOT_OBSERVED_SETTINGS) {
    const observed = observation?.dovecot.settings[key] ?? null, rendered = desired?.dovecot.get(key) ?? null
    settings.push({ source: 'dovecot', key, observed, desired: rendered, state: compare(!!desired, dovecotRead, observed, rendered) })
  }
  const domains = page === 'routing' && saved ? domainRows(saved, policy ? mailxRoutingModes(policy) : new Map()) : { rows: [], truncated: false }
  return { page, host, observedAt: observation?.observedAt ?? null,
    sources: { postfix: postfixRead ? 'read' : 'unavailable', master: observation?.master.state === 'read' ? 'read' : 'unavailable', dovecot: dovecotRead ? 'read' : 'unavailable', desired: desired ? 'rendered' : 'unavailable' },
    settings, services: serviceRows(page, observation, desired), domains: domains.rows, truncated: domains.truncated, editable: true }
}

const PAGE = /^\/api\/server\/mail-server\/(server|routing|outbound)$/

export async function handleMailServerWorkspaceRoute(request: Request, url: URL, method: string, helpers: MailServerWorkspaceHelpers): Promise<Response | null> {
  const match = PAGE.exec(url.pathname)
  if (!match) return null
  const action = 'server.mail-server.read'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET' } })
  if (url.search) return fail('VALIDATION', 'mail server workspace routes do not accept selectors', { stateChanged: false })
  const page = match[1] as MailServerPage
  let observation: MailServerObservation | null = null, host: MailServerHost = 'not-connected'
  if (helpers.readObservation) try { observation = projectMailServerObservation(await helpers.readObservation(caller)); host = 'connected' } catch { host = 'unverified' }
  const saved = page === 'routing' ? await helpers.readSaved() : null
  // A saved policy that needs review leaves the rendered column unavailable rather than half-filled.
  let policy: MailxSaved | null = null, policyRead = !helpers.readMailPolicy
  if (helpers.readMailPolicy) try { policy = await helpers.readMailPolicy(); policyRead = true } catch { policyRead = false }
  const current = await helpers.requireCaller(request)
  await helpers.assertRoot(current, action)
  if (current.principal.id !== caller.principal.id) return fail('FORBIDDEN', 'mail server authority changed', { stateChanged: false })
  return new Response(JSON.stringify(buildMailServerView(page, observation, host, policyRead ? withMailPolicy(renderedMailServerDesired(helpers.os), policy, observation?.dovecot.settings.ssl_server_cert_file != null ? '2.4' : '2.3') : null, saved, policy)), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

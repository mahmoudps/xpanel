import { isIP } from 'node:net'
import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { isAccountUsername, isFail2banAddress, isFail2banJail, isScanTarget } from '../../../packages/os/src/security-tools-command.ts'
import type { AntivirusRead, AntivirusScanView, AntivirusUpdateView, ScanSummary } from '../../agent/src/security-tools-antivirus.ts'
import type { Fail2banJailView, IntrusionRead, UnbanResult } from '../../agent/src/security-tools-intrusion.ts'
import type { IsolationCheck, IsolationReport } from '../../agent/src/security-tools-isolation.ts'

export interface SecurityToolsWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Protected agent transport; a body sends a POST mutation. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}
export interface SecurityToolsIsolationResponse { accounts: { username: string; status: string }[]; report: IsolationReport | null }
export interface SecurityToolsJobAck { job: { id: string; referenceCode: string | null; kind: string; status: string } }

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string; host: string; fields?: readonly string[]; kind?: string }>> = {
  '/api/server/security-tools/intrusion': { method: 'GET', action: 'server.security-tools.read', host: '/host/security-tools/intrusion' },
  '/api/server/security-tools/intrusion/unban': { method: 'POST', action: 'server.security-tools.unban', host: '/host/security-tools/intrusion/unban', fields: ['jail', 'address'] },
  '/api/server/security-tools/antivirus': { method: 'GET', action: 'server.security-tools.read', host: '/host/security-tools/antivirus' },
  '/api/server/security-tools/antivirus/scan': { method: 'POST', action: 'server.security-tools.scan', host: '/host/security-tools/antivirus/scan', fields: ['account'], kind: 'security.antivirus.scan' },
  '/api/server/security-tools/antivirus/update': { method: 'POST', action: 'server.security-tools.update', host: '/host/security-tools/antivirus/update', fields: [], kind: 'security.antivirus.signatures' },
  '/api/server/security-tools/isolation': { method: 'GET', action: 'server.security-tools.read', host: '/host/security-tools/isolation' },
}
const unchanged = { stateChanged: false }
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const intOrNull = (value: unknown): value is number | null => value === null || int(value)
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max && !UNSAFE.test(value)
const textOrNull = (value: unknown, max: number): value is string | null => value === null || text(value, max)
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const reference = (value: unknown): value is string | null => value === null || typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9 ._:/-]*$/.test(value) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && value !== 'XP-JOB-000000'
const oneOf = <T extends string>(value: unknown, values: readonly T[]): value is T => typeof value === 'string' && (values as readonly string[]).includes(value)
const banned = (value: unknown): value is string => {
  if (isFail2banAddress(value)) return true
  const match = typeof value === 'string' ? /^([0-9A-Fa-f:.]{2,45})\/([0-9]{1,3})$/.exec(value) : null
  return !!match && isIP(match[1]!) !== 0 && Number(match[2]) <= (isIP(match[1]!) === 4 ? 32 : 128)
}
const unverified = (): never => fail('PRECONDITION_FAILED', 'the security tools observation could not be verified', { stateChanged: false, verificationRequired: true })
const review = (): never => fail('PRECONDITION_FAILED', 'the security tools action outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const accountsOf = (value: unknown): { username: string; status: string }[] => Array.isArray(value) && value.length <= 5000
  ? value.map(item => object(item) && isAccountUsername(item.username) && text(item.status, 32) ? { username: item.username, status: item.status } : unverified()) : unverified()

export function projectIntrusion(value: unknown): IntrusionRead {
  if (!object(value) || !oneOf(value.state, ['read', 'not_installed', 'unavailable'] as const) || !time(value.observedAt) || !Array.isArray(value.jails) || value.jails.length > 64 || !int(value.unsupportedJails) || typeof value.jailsTruncated !== 'boolean') return unverified()
  if (value.state === 'unavailable' ? !oneOf(value.reason, ['command_failed', 'malformed_output'] as const) : value.reason !== undefined) return unverified()
  if (value.state !== 'read' && value.jails.length) return unverified()
  let total = 0
  const jails = value.jails.map((raw): Fail2banJailView => {
    const counts = object(raw) ? [raw.currentlyFailed, raw.totalFailed, raw.currentlyBanned, raw.totalBanned] : []
    if (!object(raw) || !isFail2banJail(raw.name) || !oneOf(raw.state, ['read', 'unavailable'] as const) || !Array.isArray(raw.banned) || typeof raw.truncated !== 'boolean'
      || (raw.state === 'read' ? !counts.every(int) : !counts.every(item => item === null) || raw.banned.length !== 0) || !raw.banned.every(banned) || (total += raw.banned.length) > 5000) return unverified()
    return { name: raw.name, state: raw.state, currentlyFailed: raw.currentlyFailed as number | null, totalFailed: raw.totalFailed as number | null, currentlyBanned: raw.currentlyBanned as number | null, totalBanned: raw.totalBanned as number | null, banned: [...raw.banned as string[]], truncated: raw.truncated }
  })
  return { state: value.state, observedAt: value.observedAt, ...(value.state === 'unavailable' ? { reason: value.reason as IntrusionRead['reason'] } : {}), jails, unsupportedJails: value.unsupportedJails, jailsTruncated: value.jailsTruncated }
}

/** An unban is reported confirmed only when the re-read it carries no longer lists the address. */
export function projectUnban(value: unknown, input: { jail: string; address: string }): UnbanResult {
  if (!object(value) || value.jail !== input.jail || value.address !== input.address || !oneOf(value.outcome, ['confirmed', 'unknown'] as const) || value.verificationRequired !== (value.outcome === 'unknown')
    || !object(value.after) || ![true, false, null].includes(value.after.banned as boolean | null) || value.outcome === 'confirmed' && value.after.banned !== false || !time(value.observedAt)) return review()
  return { jail: input.jail, address: input.address, outcome: value.outcome, verificationRequired: value.outcome === 'unknown', after: { banned: value.after.banned as boolean | null }, observedAt: value.observedAt }
}

const summaryOf = (value: unknown): ScanSummary | null => {
  if (value === null) return null
  if (!object(value) || !int(value.infectedFiles) || ![value.knownViruses, value.scannedDirectories, value.scannedFiles].every(intOrNull) || ![value.engineVersion, value.dataScanned, value.time].every(item => textOrNull(item, 64))) return unverified()
  return { knownViruses: value.knownViruses as number | null, engineVersion: value.engineVersion as string | null, scannedDirectories: value.scannedDirectories as number | null, scannedFiles: value.scannedFiles as number | null, infectedFiles: value.infectedFiles, dataScanned: value.dataScanned as string | null, time: value.time as string | null }
}

export function projectAntivirus(value: unknown): AntivirusRead {
  if (!object(value) || !time(value.observedAt) || !object(value.engine) || !object(value.updater) || ![true, false, null].includes(value.updater.present as boolean | null) || typeof value.jobsAvailable !== 'boolean'
    || !Array.isArray(value.scans) || value.scans.length > 10 || !Array.isArray(value.updates) || value.updates.length > 5) return unverified()
  const engine = value.engine
  if (!oneOf(engine.state, ['read', 'not_installed', 'unavailable'] as const) || (engine.state === 'read' ? !text(engine.version, 64) || !intOrNull(engine.signatureVersion) || !textOrNull(engine.signatureDate, 64) : engine.version !== null || engine.signatureVersion !== null || engine.signatureDate !== null)) return unverified()
  const base = (raw: Record<string, unknown>) => uuid(raw.jobId) && reference(raw.referenceCode) && oneOf(raw.status, STATUSES) && intOrNull(raw.exitCode) && time(raw.createdAt) && (raw.finishedAt === null || time(raw.finishedAt))
  const scans = value.scans.map((raw): AntivirusScanView => {
    if (!object(raw) || !base(raw) || !oneOf(raw.result, ['pending', 'clean', 'infected', 'error', 'cancelled', 'unknown'] as const) || raw.target !== null && !isScanTarget(raw.target) || raw.account !== (raw.target === null ? null : String(raw.target).split('/').at(-1))
      || !Array.isArray(raw.infected) || raw.infected.length > 50 || typeof raw.listComplete !== 'boolean') return unverified()
    const target = raw.target as string | null
    const infected = raw.infected.map(item => object(item) && target && text(item.path, 1024) && (item.path === target || item.path.startsWith(target + '/')) && typeof item.signature === 'string' && /^[A-Za-z0-9._:{}+-]{1,160}$/.test(item.signature) ? { path: item.path, signature: item.signature } : unverified())
    return { jobId: raw.jobId as string, referenceCode: raw.referenceCode as string | null, account: raw.account as string | null, target, status: raw.status as AntivirusScanView['status'], result: raw.result, exitCode: raw.exitCode as number | null, createdAt: raw.createdAt as string, finishedAt: raw.finishedAt as string | null, summary: summaryOf(raw.summary), infected, listComplete: raw.listComplete }
  })
  const updates = value.updates.map((raw): AntivirusUpdateView => {
    if (!object(raw) || !base(raw) || !oneOf(raw.result, ['pending', 'updated', 'up_to_date', 'error', 'cancelled', 'unknown'] as const) || !intOrNull(raw.signatureVersion)) return unverified()
    return { jobId: raw.jobId as string, referenceCode: raw.referenceCode as string | null, status: raw.status as AntivirusUpdateView['status'], result: raw.result, exitCode: raw.exitCode as number | null, createdAt: raw.createdAt as string, finishedAt: raw.finishedAt as string | null, signatureVersion: raw.signatureVersion as number | null }
  })
  return { observedAt: value.observedAt, engine: { state: engine.state, version: engine.version as string | null, signatureVersion: engine.signatureVersion as number | null, signatureDate: engine.signatureDate as string | null },
    updater: { present: value.updater.present as boolean | null }, jobsAvailable: value.jobsAvailable, accounts: accountsOf(value.accounts), scans, updates }
}

export function projectIsolation(value: unknown, username: string | null): SecurityToolsIsolationResponse {
  if (!object(value) || (username === null ? value.report !== null : !object(value.report))) return unverified()
  const accounts = accountsOf(value.accounts)
  if (username === null) return { accounts, report: null }
  const raw = value.report as Record<string, unknown>
  if (raw.username !== username || !int(raw.uid) || !text(raw.status, 32) || !time(raw.observedAt) || !oneOf(raw.state, ['ok', 'drift', 'unavailable'] as const) || !object(raw.counts) || !Array.isArray(raw.checks) || raw.checks.length > 64) return unverified()
  const counts = { ok: 0, drift: 0, unavailable: 0 }
  const checks = raw.checks.map((item): IsolationCheck => {
    if (!object(item) || typeof item.id !== 'string' || !/^[a-z][a-z0-9.-]{0,31}$/.test(item.id) || !oneOf(item.state, ['ok', 'drift', 'unavailable'] as const) || !textOrNull(item.expected, 256) || !textOrNull(item.observed, 256)) return unverified()
    counts[item.state]++
    return { id: item.id, state: item.state, expected: item.expected, observed: item.observed }
  })
  const state = counts.drift ? 'drift' : counts.unavailable ? 'unavailable' : 'ok'
  const reported = raw.counts as Record<string, unknown>
  if (raw.state !== state || (['ok', 'drift', 'unavailable'] as const).some(key => reported[key] !== counts[key])) return unverified()
  return { accounts, report: { username, uid: raw.uid, status: raw.status, observedAt: raw.observedAt, state, counts, checks } }
}

const projectJob = (value: unknown, kind: string): SecurityToolsJobAck => {
  const job = object(value) && object(value.job) ? value.job : null
  if (!job || !uuid(job.id) || !reference(job.referenceCode) || job.kind !== kind || !oneOf(job.status, STATUSES)) return review()
  return { job: { id: job.id, referenceCode: job.referenceCode, kind, status: job.status } }
}

async function readBody(request: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const raw = await request.text()
  if (raw.length > 1024) return fail('VALIDATION', 'security tools request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported security tools request field', unchanged)
  if (fields.includes('jail') && (!isFail2banJail(body.jail) || !isFail2banAddress(body.address))) return fail('VALIDATION', 'a reviewed jail name and one IP address are required', unchanged)
  if (fields.includes('account') && !isAccountUsername(body.account)) return fail('VALIDATION', 'an account username is required', unchanged)
  return body
}

/** Root-only xWHM security tools: fail2ban, ClamAV and account isolation. Only identities cross to the host agent. */
export async function handleSecurityToolsWorkspaceRoute(request: Request, url: URL, method: string, helpers: SecurityToolsWorkspaceHelpers): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const isolation = url.pathname === '/api/server/security-tools/isolation'
  const query = [...url.searchParams]
  if (url.search && !(isolation && query.length === 1 && query[0]![0] === 'account' && isAccountUsername(query[0]![1]))) return fail('VALIDATION', 'security tools routes accept only one account selector on isolation', unchanged)
  const body = route.fields ? await readBody(request, route.fields) : undefined
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'security tools require a connected host agent', unchanged)
  if (route.method === 'GET') {
    if (!isolation) return json(url.pathname.endsWith('/intrusion') ? projectIntrusion(await helpers.callHost(caller, route.host)) : projectAntivirus(await helpers.callHost(caller, route.host)))
    const account = url.searchParams.get('account')
    return json(projectIsolation(await helpers.callHost(caller, route.host + (account ? '?account=' + account : '')), account))
  }
  const fresh = async (stateChanged: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, route.action)
    return current.principal.id === caller.principal.id ? current : fail('FORBIDDEN', 'security tools authority changed', stateChanged ? { stateChanged: true, verificationRequired: true, unknownOutcome: true } : unchanged)
  }
  const actor = await fresh(false)
  const target = body!.jail !== undefined ? 'fail2ban:' + String(body!.jail) + ':' + String(body!.address) : body!.account !== undefined ? 'account:' + String(body!.account) : 'clamav:signatures'
  const audit = (outcome: string, extra: Record<string, unknown> = {}) => helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: route.action.replace('server.security-tools.', 'server.security_tools.'),
    target, outcome: outcome === 'confirmed' || outcome === 'submitted' ? 'ok' : 'failed', detail: { outcome, ...extra } })
  let result: UnbanResult | SecurityToolsJobAck
  try {
    const raw = await helpers.callHost(actor, route.host, body)
    result = route.kind ? projectJob(raw, route.kind) : projectUnban(raw, { jail: String(body!.jail), address: String(body!.address) })
  } catch (error) {
    const raw = (error as { detail?: unknown })?.detail, detail = object(raw) ? raw : {}
    await audit(detail.stateChanged === false && detail.unknownOutcome !== true ? 'refused' : 'unknown').catch(() => {})
    throw error
  }
  const outcome = 'job' in result ? 'submitted' : result.outcome, extra = 'job' in result ? { jobId: result.job.id } : {}
  try { await fresh(true) } catch {
    await audit(outcome, { ...extra, authorityChanged: true }).catch(() => {})
    return fail('FORBIDDEN', 'root authority changed; the security tools action outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  }
  try { await audit(outcome, extra) } catch { return review() }
  return json(result, 'job' in result ? 202 : 200)
}

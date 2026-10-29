import { fail } from '@xpanel/core'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'
import { MAILBOX_MAINTENANCE_OPERATIONS, isMailboxMaintenanceOperation, isMaintenanceMailbox } from '../../../packages/os/src/mailbox-maintenance-command.ts'
import type { FolderUsage, FoldersRead, MailboxMaintenanceRead, MaintenanceMailbox, QuotaRead, QuotaResource } from '../../agent/src/mailbox-maintenance.ts'

export interface MailboxMaintenanceWorkspaceHelpers extends Pick<ExtendedRouteHelpers, 'requireCaller' | 'assertRoot' | 'emitAudit'> {
  /** Protected agent transport; a body sends a POST mutation. Absent when no host agent is connected. */
  callHost?: (caller: AuthenticatedCaller, path: string, body?: Record<string, unknown>) => Promise<unknown>
}
export interface MailboxMaintenanceJobAck { job: { id: string; kind: string; status: string } }

const READ = '/api/server/mail-maintenance', JOBS = '/api/server/mail-maintenance/jobs'
const BULK_MAX = 32
const KINDS: Readonly<Record<string, string>> = { 'quota-recalc': 'mail.maintenance.quota-recalc', resync: 'mail.maintenance.resync', index: 'mail.maintenance.index' }
const REASONS = ['user_unknown', 'command_failed', 'quota_error', 'malformed_output']
const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled']
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const unchanged = { stateChanged: false }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const int = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length >= 1 && value.length <= max && !UNSAFE.test(value)
const time = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
const username = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9]{0,15}$/.test(value)
const unverified = (): never => fail('PRECONDITION_FAILED', 'the mailbox maintenance observation could not be verified', { stateChanged: false, verificationRequired: true })
const review = (): never => fail('PRECONDITION_FAILED', 'the mailbox maintenance job outcome requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

const quotaOf = (value: unknown): QuotaRead => {
  if (!object(value) || !Array.isArray(value.resources) || value.resources.length > 32) return unverified()
  if (value.state === 'unavailable') return REASONS.includes(String(value.reason)) && value.resources.length === 0 ? { state: 'unavailable', reason: value.reason as QuotaRead['reason'], resources: [] } : unverified()
  if (value.state !== 'read' || value.reason !== null) return unverified()
  const resources = value.resources.map((raw): QuotaResource => object(raw) && text(raw.root, 128) && (raw.type === 'STORAGE' || raw.type === 'MESSAGE') && int(raw.value) && (raw.limit === null || int(raw.limit)) && int(raw.percent)
    ? { root: raw.root, type: raw.type, value: raw.value, limit: raw.limit as number | null, percent: raw.percent } : unverified())
  return { state: 'read', reason: null, resources }
}

const foldersOf = (value: unknown): FoldersRead => {
  if (!object(value) || !Array.isArray(value.folders) || value.folders.length > 200 || typeof value.truncated !== 'boolean') return unverified()
  if (value.state === 'unavailable') return REASONS.includes(String(value.reason)) && value.folders.length === 0 && value.truncated === false && value.totalMessages === null && value.totalVsizeBytes === null
    ? { state: 'unavailable', reason: value.reason as FoldersRead['reason'], folders: [], truncated: false, totalMessages: null, totalVsizeBytes: null } : unverified()
  if (value.state !== 'read' || value.reason !== null || !int(value.totalMessages) || !int(value.totalVsizeBytes)) return unverified()
  const folders = value.folders.map((raw): FolderUsage => object(raw) && text(raw.name, 1024) && int(raw.messages) && int(raw.vsizeBytes) ? { name: raw.name, messages: raw.messages, vsizeBytes: raw.vsizeBytes } : unverified())
  // Without truncation the totals must be exactly the listed rows.
  if (!value.truncated && (folders.reduce((sum, item) => sum + item.messages, 0) !== value.totalMessages || folders.reduce((sum, item) => sum + item.vsizeBytes, 0) !== value.totalVsizeBytes)) return unverified()
  return { state: 'read', reason: null, folders, truncated: value.truncated, totalMessages: value.totalMessages, totalVsizeBytes: value.totalVsizeBytes }
}

/** Whitelists the host read: saved mailbox identities, quota rows and folder usage only. */
export function projectMailboxMaintenance(value: unknown, mailbox: string | null): MailboxMaintenanceRead {
  if (!object(value) || !time(value.observedAt) || !['configured', 'not_configured', 'unavailable'].includes(String(value.fts)) || typeof value.jobsAvailable !== 'boolean'
    || !Array.isArray(value.mailboxes) || value.mailboxes.length > 2000 || typeof value.mailboxesTruncated !== 'boolean') return unverified()
  const seen = new Set<string>()
  const mailboxes = value.mailboxes.map((raw): MaintenanceMailbox => {
    if (!object(raw) || !isMaintenanceMailbox(raw.login) || seen.has(raw.login) || !username(raw.account) || raw.savedQuotaMb !== null && !int(raw.savedQuotaMb)) return unverified()
    seen.add(raw.login)
    return { login: raw.login, account: raw.account, savedQuotaMb: raw.savedQuotaMb as number | null }
  })
  const base = { observedAt: value.observedAt, fts: value.fts as MailboxMaintenanceRead['fts'], jobsAvailable: value.jobsAvailable, mailboxes, mailboxesTruncated: value.mailboxesTruncated }
  if (mailbox === null) return value.report === null ? { ...base, report: null } : unverified()
  const report = value.report
  if (!object(report) || report.mailbox !== mailbox || mailboxes.length !== 1 || mailboxes[0]!.login !== mailbox || value.mailboxesTruncated || !username(report.account) || report.savedQuotaMb !== null && !int(report.savedQuotaMb)) return unverified()
  return { ...base, report: { mailbox, account: report.account, savedQuotaMb: report.savedQuotaMb as number | null, quota: quotaOf(report.quota), folders: foldersOf(report.folders) } }
}

const projectJob = (value: unknown, kind: string): MailboxMaintenanceJobAck => {
  const job = object(value) && object(value.job) ? value.job : null
  if (!job || !uuid(job.id) || job.kind !== kind || !STATUSES.includes(String(job.status))) return review()
  return { job: { id: job.id, kind, status: String(job.status) } }
}

async function readIntent(request: Request): Promise<{ operation: string; mailboxes: string[] }> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const raw = await request.text()
  if (raw.length > 16_384) return fail('VALIDATION', 'mailbox maintenance request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(raw) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!object(body) || Object.keys(body).length !== 2 || Object.keys(body).some(key => key !== 'operation' && key !== 'mailboxes')) return fail('VALIDATION', 'unsupported mailbox maintenance request field', unchanged)
  const { operation, mailboxes } = body
  if (!isMailboxMaintenanceOperation(operation) || !Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > BULK_MAX || !mailboxes.every(isMaintenanceMailbox) || new Set(mailboxes).size !== mailboxes.length)
    return fail('VALIDATION', `one of ${MAILBOX_MAINTENANCE_OPERATIONS.join(', ')} and 1..${BULK_MAX} distinct mailbox logins are required`, unchanged)
  return { operation, mailboxes: mailboxes as string[] }
}

/** Root-only xWHM mailbox maintenance: per-mailbox quota and folder usage, and reviewed doveadm jobs. */
export async function handleMailboxMaintenanceWorkspaceRoute(request: Request, url: URL, method: string, helpers: MailboxMaintenanceWorkspaceHelpers): Promise<Response | null> {
  if (url.pathname !== READ && url.pathname !== JOBS) return null
  const reading = url.pathname === READ, action = reading ? 'server.mail-maintenance.read' : 'server.mail-maintenance.submit'
  const caller = await helpers.requireCaller(request)
  await helpers.assertRoot(caller, action)
  if (method !== (reading ? 'GET' : 'POST')) return new Response(null, { status: 405, headers: { allow: reading ? 'GET' : 'POST' } })
  const query = [...url.searchParams]
  if (url.search && !(reading && query.length === 1 && query[0]![0] === 'mailbox' && isMaintenanceMailbox(query[0]![1]))) return fail('VALIDATION', 'mailbox maintenance accepts only one mailbox selector', unchanged)
  const intent = reading ? null : await readIntent(request)
  if (!helpers.callHost) return fail('PRECONDITION_FAILED', 'mailbox maintenance requires a connected host agent', unchanged)
  if (!intent) {
    const mailbox = url.searchParams.get('mailbox')
    return json(projectMailboxMaintenance(await helpers.callHost(caller, '/host/mail/maintenance' + (mailbox ? '?mailbox=' + encodeURIComponent(mailbox) : '')), mailbox))
  }
  const fresh = async (stateChanged: boolean): Promise<AuthenticatedCaller> => {
    const current = await helpers.requireCaller(request)
    await helpers.assertRoot(current, action)
    return current.principal.id === caller.principal.id ? current : fail('FORBIDDEN', 'mailbox maintenance authority changed', stateChanged ? { stateChanged: true, verificationRequired: true, unknownOutcome: true } : unchanged)
  }
  const actor = await fresh(false)
  const target = intent.mailboxes.length === 1 ? 'mailbox:' + intent.mailboxes[0] : 'mailboxes:' + intent.mailboxes.length
  const audit = (outcome: string, extra: Record<string, unknown> = {}) => helpers.emitAudit({ actor: actor.principal.username, principalId: actor.principal.id, action: 'server.mail_maintenance.' + intent.operation.replace('-', '_'),
    target, outcome: outcome === 'submitted' ? 'ok' : 'failed', detail: { outcome, mailboxes: intent.mailboxes.length, ...extra } })
  let result: MailboxMaintenanceJobAck
  try { result = projectJob(await helpers.callHost(actor, '/host/mail/maintenance/jobs', intent), KINDS[intent.operation]!) } catch (error) {
    const raw = (error as { detail?: unknown })?.detail, detail = object(raw) ? raw : {}
    await audit(detail.stateChanged === false && detail.unknownOutcome !== true ? 'refused' : 'unknown').catch(() => {})
    throw error
  }
  try { await fresh(true) } catch {
    await audit('submitted', { jobId: result.job.id, authorityChanged: true }).catch(() => {})
    return fail('FORBIDDEN', 'root authority changed; the mailbox maintenance job requires review', { stateChanged: true, verificationRequired: true, unknownOutcome: true })
  }
  try { await audit('submitted', { jobId: result.job.id }) } catch { return review() }
  return json(result, 202)
}

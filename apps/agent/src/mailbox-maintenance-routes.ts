import { fail, isXpanelError } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { MAILBOX_MAINTENANCE_BULK_MAX, buildMailboxMaintenancePlan, maintenanceMailboxes, parseMailPlugins, readMailboxMaintenance } from './mailbox-maintenance.ts'
import type { MaintenanceRun, MaintenanceSnapshot } from './mailbox-maintenance.ts'
import { DOVECONF_MAIL_PLUGINS_ARGV, isMailboxMaintenanceOperation, isMaintenanceMailbox } from '../../../packages/os/src/mailbox-maintenance-command.ts'

export interface MailboxMaintenanceAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface MailboxMaintenanceRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host executor only; null keeps every route unavailable instead of simulating Dovecot. */
  run: MaintenanceRun | null
  readSnapshot: () => Promise<MaintenanceSnapshot>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit?: (entry: MailboxMaintenanceAuditEntry) => Promise<unknown>
  now?: () => Date
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string }>> = {
  '/host/mail/maintenance': { method: 'GET', action: 'mail.maintenance.read' },
  '/host/mail/maintenance/jobs': { method: 'POST', action: 'mail.maintenance.submit' },
}
const MAX_BODY_CHARS = 16_384
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

async function readIntent(req: Request): Promise<{ operation: 'quota-recalc' | 'resync' | 'index'; mailboxes: string[] }> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  if (text.length > MAX_BODY_CHARS) return fail('VALIDATION', 'mailbox maintenance request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || Object.keys(body).some(key => key !== 'operation' && key !== 'mailboxes')) return fail('VALIDATION', 'unsupported mailbox maintenance request field', unchanged)
  const { operation, mailboxes } = body as Record<string, unknown>
  if (!isMailboxMaintenanceOperation(operation) || !Array.isArray(mailboxes) || mailboxes.length < 1 || mailboxes.length > MAILBOX_MAINTENANCE_BULK_MAX || !mailboxes.every(isMaintenanceMailbox) || new Set(mailboxes).size !== mailboxes.length)
    return fail('VALIDATION', `a reviewed operation and 1..${MAILBOX_MAINTENANCE_BULK_MAX} distinct mailbox logins are required`, unchanged)
  return { operation, mailboxes: mailboxes as string[] }
}

/** Root-only Dovecot mailbox maintenance. Requests carry saved mailbox logins only; argv comes from the reviewed grammar. */
export async function handleMailboxMaintenanceRoute(req: Request, url: URL, method: string, ctx: MailboxMaintenanceRouteContext): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const { actor } = await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const query = [...url.searchParams]
  if (url.search && !(route.method === 'GET' && query.length === 1 && query[0]![0] === 'mailbox' && isMaintenanceMailbox(query[0]![1]))) return fail('VALIDATION', 'mailbox maintenance accepts only one saved mailbox selector', unchanged)
  const intent = route.method === 'POST' ? await readIntent(req) : null
  const run = ctx.run
  if (!run) return fail('PRECONDITION_FAILED', 'mailbox maintenance requires the native Linux host executor', unchanged)
  const confirm = async (): Promise<string> => {
    const fresh = await ctx.assertRoot(route.action)
    return fresh.actor === actor ? actor : fail('FORBIDDEN', 'mailbox maintenance authority changed', unchanged)
  }
  const snapshot = await ctx.readSnapshot()
  const { mailboxes } = maintenanceMailboxes(snapshot)
  const saved = (login: string) => mailboxes.find(item => item.login === login) ?? null

  if (!intent) {
    const login = url.searchParams.get('mailbox')
    const mailbox = login === null ? null : saved(login)
    if (login !== null && !mailbox) return fail('NOT_FOUND', 'mailbox not found', unchanged)
    const read = await readMailboxMaintenance({ run, snapshot, mailbox, jobsAvailable: !!ctx.submitJob, ...(ctx.now ? { now: ctx.now } : {}) })
    await confirm()
    return json(read)
  }

  if (intent.mailboxes.some(login => !saved(login))) return fail('NOT_FOUND', 'mailbox not found', unchanged)
  if (intent.operation === 'index') {
    const fts = parseMailPlugins(await run([...DOVECONF_MAIL_PLUGINS_ARGV]).catch(() => null))
    if (fts !== 'configured') return fail('PRECONDITION_FAILED', fts === 'not_configured' ? 'full text search is not configured in Dovecot, so no search index was built' : 'the Dovecot plugin list could not be read, so no search index was built', { ...unchanged, reason: fts === 'not_configured' ? 'fts_not_configured' : 'fts_unavailable' })
  }
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  const plan = buildMailboxMaintenancePlan(intent)
  const current = await confirm()
  const target = intent.mailboxes.length === 1 ? 'mailbox:' + intent.mailboxes[0] : 'mailboxes:' + intent.mailboxes.length
  let job: HostJobView
  try { job = await ctx.submitJob(plan, current) } catch (error) {
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  await ctx.audit?.({ actor: current, action: 'mail.maintenance.' + intent.operation + '_submitted', target, outcome: 'ok', detail: { jobId: job.id, mailboxes: intent.mailboxes.length } }).catch(() => {})
  return json({ job: { id: job.id, kind: job.kind, status: job.status } }, 202)
}

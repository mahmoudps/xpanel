import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fail, isXpanelError, msgid } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { parseMailPlugins } from './mailbox-maintenance.ts'
import { mailxUnitState } from './mailfx-render.ts'
import { DOVECONF_MAIL_PLUGINS_ARGV, isMaintenanceMailbox } from '../../../packages/os/src/mailbox-maintenance-command.ts'
import { MAIL_LEARN_DIR_PREFIX, isMailReindexCommand, mailFetchTextArgv, mailFtsRescanArgv, mailIndexAllArgv, mailLearnFileArgv } from '../../../packages/os/src/mail-mailbox-actions-command.ts'
import type { MailLearnFolder } from '../../../packages/os/src/mail-mailbox-actions-command.ts'
import type { SpamStoreOwner } from '../../../packages/os/src/mailx-command.ts'
import type { AgentCallerIdentity } from './server.ts'

export const MAIL_REINDEX_JOB_KIND = 'mail.search.reindex'
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const summary = (mailbox: string): string => 'Rebuild the search index of ' + mailbox

export interface MailMailboxActionRun { (argv: string[]): Promise<{ ok: boolean; code: number | null; stdout: string; stderr?: string }> }
export interface MailMailboxActionContext {
  authenticateCaller: (req: Request) => Promise<AgentCallerIdentity>
  /** The sealed mailbox's own principal, with the tool enabled for its account. */
  assertMailbox: (caller: AgentCallerIdentity, address: string, features: readonly string[]) => Promise<void>
  run: MailMailboxActionRun | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<{ job: HostJobView; deduplicated: boolean }>) | null
  listJobs: (() => Promise<readonly HostJobView[]>) | null
}

/** doveadm fetch pager format: `text:`, the raw message, a form feed. Anything else is not a message. */
export function parseFetchedMessage(stdout: string): string | null {
  if (!stdout.startsWith('text:\n')) return null
  const body = stdout.slice(6).replace(/\n?\f\n?$/, '')
  return body ? body : null
}
async function activeEngine(run: MailMailboxActionRun): Promise<'rspamd' | 'spamassassin' | null> {
  if (await mailxUnitState(run as never, 'rspamd.service') === 'active') return 'rspamd'
  for (const unit of ['spamassassin.service', 'spamd.service'] as const) if (await mailxUnitState(run as never, unit) === 'active') return 'spamassassin'
  return null
}
// spamd switches to the user its client names, and that client is spamass-milter: its home holds the store. debian-spamd is the packaged fallback.
const SCANNER_USERS = ['spamass-milter', 'sa-milt', 'debian-spamd'] as const
/** The scanner account whose home already holds a Bayes store, else the first scanner account on this host. */
export async function readSpamStoreOwner(read: (path: string) => Promise<string> = path => readFile(path, 'utf8'), exists: (path: string) => Promise<boolean> = path => access(path).then(() => true, () => false)): Promise<SpamStoreOwner | null> {
  const rows = (await read('/etc/passwd').catch(() => '')).split('\n').map(line => line.split(':'))
  const owners = SCANNER_USERS.flatMap(user => rows.filter(row => row[0] === user).map(row => ({ uid: Number(row[2]), gid: Number(row[3]), home: row[5] ?? '' })))
  for (const owner of owners) if (await exists(owner.home + '/.spamassassin/bayes_toks')) return owner
  return owners[0] ?? null
}
/** One message, read by UID and taught to the running filter from a root-only temporary file. */
export async function learnMessage(run: MailMailboxActionRun, input: { address: string; folder: MailLearnFolder; uid: number; direction: 'spam' | 'ham' }, readOwner: () => Promise<SpamStoreOwner | null> = readSpamStoreOwner): Promise<{ learned: boolean; reason: string | null }> {
  const engine = await activeEngine(run)
  if (!engine) return { learned: false, reason: 'no_spam_filter' }
  const owner = engine === 'spamassassin' ? await readOwner() : null
  if (engine === 'spamassassin' && !owner) return { learned: false, reason: 'no_store_owner' }
  const fetched = await run(mailFetchTextArgv(input.address, input.folder, input.uid)).catch(() => null), message = fetched?.ok && fetched.code === 0 ? parseFetchedMessage(fetched.stdout) : null
  if (message === null) return { learned: false, reason: 'message_unreadable' }
  const dir = await mkdtemp(MAIL_LEARN_DIR_PREFIX)
  try {
    const path = dir + '/message.eml'
    await writeFile(path, message, { mode: 0o600, flag: 'wx' })
    const learned = await run(mailLearnFileArgv(engine, input.direction, path, owner)).catch(() => null)
    return learned?.ok && learned.code === 0 ? { learned: true, reason: null } : { learned: false, reason: 'learner_failed' }
  } finally { await rm(dir, { recursive: true, force: true }) }
}

export function buildMailReindexPlan(address: string): HostJobPlan {
  return { kind: MAIL_REINDEX_JOB_KIND, summary: summary(address), accountId: null, fingerprint: { address }, detail: { address },
    steps: [{ id: 'rescan', title: msgid('Mark the search index of {mailbox} for a rebuild'), titleValues: { mailbox: address }, argv: mailFtsRescanArgv(address), timeoutMs: 600_000, mutates: true },
      { id: 'index', title: msgid('Index every folder of {mailbox}'), titleValues: { mailbox: address }, argv: mailIndexAllArgv(address), timeoutMs: 1_800_000, mutates: true }],
    policy: isMailReindexCommand }
}

const LEARN_FEATURES = ['webmail-spam-marking'] as const, INDEX_FEATURES = ['webmail-search-index'] as const

/** POST /host/mail/learn-message, GET and POST /host/mail/search-index: each acts for the sealed mailbox that asked. */
export async function handleMailMailboxActionRoute(req: Request, url: URL, method: string, ctx: MailMailboxActionContext): Promise<Response | null> {
  const learn = url.pathname === '/host/mail/learn-message', index = url.pathname === '/host/mail/search-index'
  if (!learn && !index) return null
  const reading = index && method === 'GET'
  if (!reading && method !== 'POST') return new Response(null, { status: 405, headers: { allow: learn ? 'POST' : 'GET, POST' } })
  const caller = await ctx.authenticateCaller(req)
  let body: Record<string, unknown> = {}
  if (reading) { if ([...url.searchParams.keys()].some(key => key !== 'address') || url.searchParams.getAll('address').length !== 1) return fail('VALIDATION', 'one mailbox address is required', unchanged); body = { address: url.searchParams.get('address') } }
  else { try { const raw: unknown = JSON.parse(await req.text()); if (object(raw)) body = raw } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) } }
  const address = body.address
  if (!isMaintenanceMailbox(address)) return fail('VALIDATION', 'a canonical mailbox address is required', unchanged)
  const features = learn ? LEARN_FEATURES : INDEX_FEATURES
  await ctx.assertMailbox(caller, address, features)
  if (!ctx.run) return fail('PRECONDITION_FAILED', 'this action requires the native Linux host executor', unchanged)
  const run = ctx.run
  if (learn) {
    const { folder, uid, direction } = body
    if (Object.keys(body).length !== 4 || (folder !== 'INBOX' && folder !== 'Junk') || !Number.isSafeInteger(uid) || (direction !== 'spam' && direction !== 'ham')) return fail('VALIDATION', 'a folder, a message uid and a direction are required', unchanged)
    return json(await learnMessage(run, { address, folder, uid: uid as number, direction }))
  }
  const fts = parseMailPlugins(await run([...DOVECONF_MAIL_PLUGINS_ARGV]).catch(() => null) as never)
  if (reading) {
    const job = (await ctx.listJobs?.() ?? []).find(item => item.summary === summary(address)) ?? null
    await ctx.assertMailbox(await ctx.authenticateCaller(req), address, features)
    return json({ mailbox: address, fts, jobsAvailable: !!ctx.submitJob, job: job ? { id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt } : null })
  }
  if (fts !== 'configured') return fail('PRECONDITION_FAILED', 'full text search is not configured in Dovecot, so no search index was built', { ...unchanged, reason: 'fts_not_configured' })
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  await ctx.assertMailbox(await ctx.authenticateCaller(req), address, features)
  let submitted: { job: HostJobView; deduplicated: boolean }
  try { submitted = await ctx.submitJob(buildMailReindexPlan(address), caller.actor) } catch (error) {
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  if (submitted.deduplicated) return fail('CONFLICT', 'a search index rebuild is already running for this mailbox', { ...unchanged, reason: 'REINDEX_IN_PROGRESS' })
  return json({ job: { id: submitted.job.id, status: submitted.job.status } }, 202)
}

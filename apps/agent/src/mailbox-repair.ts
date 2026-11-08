import { fail, isXpanelError, msgid } from '@xpanel/core'
import type { HostJobCommandStep, HostJobPlan, HostJobRun, HostJobView } from './host-job-contract.ts'
import { MAILBOX_REPAIR_STEPS, isMailboxRepairCommand, mailboxRepairArgv, mailboxRepairCheckArgv } from '../../../packages/os/src/mailbox-repair-command.ts'
import type { MailboxRepairIdentity } from '../../../packages/os/src/mailbox-repair-command.ts'

export const MAILBOX_REPAIR_JOB_KIND = 'mail.maintenance.repair-permissions'
// validateHostJobPlan admits 1..32 steps and each account takes three, so further accounts are paged into more jobs.
export const MAILBOX_REPAIR_ACCOUNTS_PER_JOB = 10
const JOBS_MAX = 64
const STEP_TIMEOUT_MS = 1_800_000
const USERNAME = /^[a-z][a-z0-9]{0,15}$/
const TITLES = { owner: msgid('Restore mail ownership for {account}'), directories: msgid('Repair mail directory modes for {account}'), files: msgid('Repair mail file modes for {account}') } as const

/** Repairs change no data, only owner and mode bits, so a repeated run finds nothing further to do. */
export function buildMailboxRepairPlans(accounts: readonly MailboxRepairIdentity[]): HostJobPlan[] {
  if (accounts.length < 1 || accounts.length > MAILBOX_REPAIR_ACCOUNTS_PER_JOB * JOBS_MAX || new Set(accounts.map(account => account.username)).size !== accounts.length) return fail('VALIDATION', 'select at least one saved account', { stateChanged: false })
  const plans: HostJobPlan[] = []
  for (let start = 0; start < accounts.length; start += MAILBOX_REPAIR_ACCOUNTS_PER_JOB) {
    const chunk = accounts.slice(start, start + MAILBOX_REPAIR_ACCOUNTS_PER_JOB)
    plans.push({ kind: MAILBOX_REPAIR_JOB_KIND, summary: `Repair mail permissions for accounts ${start + 1}-${start + chunk.length} of ${accounts.length}`, accountId: null,
      fingerprint: { accounts: chunk.map(account => account.username) }, detail: { accounts: chunk.map(account => account.username) },
      steps: chunk.flatMap((account, index) => MAILBOX_REPAIR_STEPS.map((step): HostJobCommandStep => ({ id: `${step}-${index + 1}`, title: TITLES[step], titleValues: { account: account.username }, argv: mailboxRepairArgv(account, step), timeoutMs: STEP_TIMEOUT_MS, mutates: true }))),
      policy: isMailboxRepairCommand,
      verify: async (run: HostJobRun) => {
        const results: { account: string; ok: boolean }[] = []
        for (const account of chunk) {
          const result = await run(mailboxRepairCheckArgv(account), { timeoutMs: 600_000 }).catch(() => null)
          results.push({ account: account.username, ok: !!result && !result.timedOut && result.ok && result.stdout.trim() === '' })
        }
        return { ok: results.every(item => item.ok), detail: { checked: results.length, results } }
      } })
  }
  return plans
}

export interface MailboxRepairSnapshot { accounts: readonly { id: string; username: string; uid: number; gid: number; home: string; status: string }[]; serviceUsers: readonly { accountId: string; services: { email: boolean } }[] }
export interface MailboxRepairAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface MailboxRepairRouteContext {
  assertRoot: (action: string) => Promise<{ actor: string }>
  readSnapshot: () => Promise<MailboxRepairSnapshot>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit?: (entry: MailboxRepairAuditEntry) => Promise<unknown>
}
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

/** POST /host/mail/maintenance/repair: `accounts` is `all` or saved usernames; identities always come from saved state. */
export async function handleMailboxRepairRoute(req: Request, url: URL, method: string, ctx: MailboxRepairRouteContext): Promise<Response | null> {
  if (url.pathname !== '/host/mail/maintenance/repair') return null
  const { actor } = await ctx.assertRoot('mail.maintenance.repair')
  if (method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  if (url.search) return fail('VALIDATION', 'mailbox repair accepts no selectors', unchanged)
  const text = await req.text()
  if (text.length > 64_000) return fail('VALIDATION', 'mailbox repair request exceeds its bound', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  const accounts = body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 ? (body as Record<string, unknown>).accounts : undefined
  if (accounts !== 'all' && !(Array.isArray(accounts) && accounts.length >= 1 && accounts.every(item => typeof item === 'string' && USERNAME.test(item)))) return fail('VALIDATION', 'accounts must be all or a list of account names', unchanged)
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  // An account without a mailbox has no ~/mail, and find fails on a missing start path.
  const snapshot = await ctx.readSnapshot(), saved = snapshot.accounts.filter(account => account.status !== 'terminating' && USERNAME.test(account.username) && snapshot.serviceUsers.some(user => user.accountId === account.id && user.services.email))
  if (accounts !== 'all' && accounts.some(name => !saved.some(account => account.username === name))) return fail('NOT_FOUND', 'account not found', unchanged)
  const chosen = saved.filter(account => accounts === 'all' || accounts.includes(account.username)).sort((a, b) => a.username < b.username ? -1 : 1)
  if (!chosen.length) return fail('PRECONDITION_FAILED', 'no saved account has a mailbox to repair', unchanged)
  const plans = buildMailboxRepairPlans(chosen.map(({ username, uid, gid, home }) => ({ username, uid, gid, home })))
  const fresh = await ctx.assertRoot('mail.maintenance.repair')
  if (fresh.actor !== actor) return fail('FORBIDDEN', 'mailbox repair authority changed', unchanged)
  const jobs: HostJobView[] = []
  try { for (const plan of plans) jobs.push(await ctx.submitJob(plan, actor)) } catch (error) {
    if (isXpanelError(error) && !jobs.length) throw error
    return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  await ctx.audit?.({ actor, action: 'mail.maintenance.repair_submitted', target: accounts === 'all' ? 'accounts:all' : 'accounts:' + chosen.length, outcome: 'ok', detail: { accounts: chosen.length, jobs: jobs.map(job => job.id) } }).catch(() => {})
  return json({ accounts: chosen.length, jobs: jobs.map(job => ({ id: job.id, kind: job.kind, status: job.status })) }, 202)
}

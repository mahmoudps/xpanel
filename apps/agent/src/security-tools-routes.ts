import { realpath, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, Domain, Plan } from '@xpanel/core'
import type { AgentExecutor } from './executor.ts'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { resolveAccountIoDevices } from './io-device.ts'
import { buildAntivirusScanPlan, buildSignatureUpdatePlan, readAntivirus } from './security-tools-antivirus.ts'
import type { AntivirusJobs } from './security-tools-antivirus.ts'
import { readIntrusion, unbanAddress } from './security-tools-intrusion.ts'
import type { BinaryPresent, UnbanResult } from './security-tools-intrusion.ts'
import { inspectAccountHome, readAccountIsolation } from './security-tools-isolation.ts'
import type { InspectHome } from './security-tools-isolation.ts'
import { FRESHCLAM, isAccountUsername, isFail2banAddress, isFail2banJail, isScanTarget } from '../../../packages/os/src/security-tools-command.ts'

export interface SecurityToolsAuditEntry { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown> }
export interface SecurityToolsRouteContext {
  /** Re-authenticates the current caller and requires root on every call. */
  assertRoot: (action: string) => Promise<{ actor: string }>
  /** Native Linux host executor only; null keeps every host read unavailable instead of simulating one. */
  executor: AgentExecutor | null
  readSnapshot: () => Promise<{ accounts: readonly Account[]; plans: readonly Plan[]; domains: readonly Domain[] }>
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  jobs: AntivirusJobs | null
  audit?: (entry: SecurityToolsAuditEntry) => Promise<unknown>
  present?: BinaryPresent
  inspectHome?: InspectHome
  resolveHome?: (home: string) => Promise<string>
  ioDevices?: (account: Account) => Promise<readonly string[] | null>
  now?: () => Date
}

const ROUTES: Readonly<Record<string, { method: 'GET' | 'POST'; action: string; fields?: readonly string[] }>> = {
  '/host/security-tools/intrusion': { method: 'GET', action: 'security.intrusion.read' },
  '/host/security-tools/intrusion/unban': { method: 'POST', action: 'security.intrusion.unban', fields: ['jail', 'address'] },
  '/host/security-tools/antivirus': { method: 'GET', action: 'security.antivirus.read' },
  '/host/security-tools/antivirus/scan': { method: 'POST', action: 'security.antivirus.scan', fields: ['account'] },
  '/host/security-tools/antivirus/update': { method: 'POST', action: 'security.antivirus.update', fields: [] },
  '/host/security-tools/isolation': { method: 'GET', action: 'security.isolation.read' },
}
const unchanged = { stateChanged: false }
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const unavailable = (): never => fail('PRECONDITION_FAILED', 'security tools require the native Linux host executor', unchanged)
export const binaryPresent: BinaryPresent = path => stat(path).then(facts => facts.isFile(), error => (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : null)

async function readBody(req: Request, fields: readonly string[]): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  if (text.length > 1024) return fail('VALIDATION', 'security tools request exceeds the bounded body size', unchanged)
  let body: unknown
  try { body = JSON.parse(text) } catch { return fail('VALIDATION', 'request body must be valid JSON', unchanged) }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported security tools request field', unchanged)
  return body as Record<string, unknown>
}

const submitted = async (ctx: SecurityToolsRouteContext, plan: HostJobPlan, actor: string, audit: { action: string; target: string }): Promise<Response> => {
  if (!ctx.submitJob) return fail('PRECONDITION_FAILED', 'the host job runner is unavailable, so nothing was started', unchanged)
  let job: HostJobView
  try { job = await ctx.submitJob(plan, actor) } catch (error) {
    if (isXpanelError(error)) throw error
    return fail('SERVICE_UNAVAILABLE', 'job submission outcome is unknown; review host jobs before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  }
  await ctx.audit?.({ actor, action: audit.action, target: audit.target, outcome: 'ok', detail: { jobId: job.id } }).catch(() => {})
  return json({ job: { id: job.id, referenceCode: job.referenceCode, kind: job.kind, status: job.status } }, 202)
}

/** Root-only fail2ban, ClamAV and isolation host routes. Requests carry identities only; argv and paths come from reviewed grammar and the store. */
export async function handleSecurityToolsRoute(req: Request, url: URL, method: string, ctx: SecurityToolsRouteContext): Promise<Response | null> {
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname]! : null
  if (!route) return null
  const { actor } = await ctx.assertRoot(route.action)
  if (method !== route.method) return new Response(null, { status: 405, headers: { allow: route.method } })
  const isolation = url.pathname === '/host/security-tools/isolation'
  const query = [...url.searchParams]
  if (url.search && !(isolation && query.length === 1 && query[0]![0] === 'account' && isAccountUsername(query[0]![1]))) return fail('VALIDATION', 'security tools routes accept only one account selector on isolation', unchanged)
  const body = route.fields ? await readBody(req, route.fields) : null
  const executor = ctx.executor
  if (!executor) return unavailable()
  const now = ctx.now ?? (() => new Date())
  const run = (argv: string[]) => executor.runCommand(argv)
  const present = ctx.present ?? binaryPresent
  const confirm = async (): Promise<string> => {
    const fresh = await ctx.assertRoot(route.action)
    return fresh.actor === actor ? actor : fail('FORBIDDEN', 'security tools authority changed', unchanged)
  }

  if (url.pathname === '/host/security-tools/intrusion') return json(await readIntrusion({ run, present, now }))
  if (url.pathname === '/host/security-tools/intrusion/unban') {
    if (!isFail2banJail(body!.jail) || !isFail2banAddress(body!.address)) return fail('VALIDATION', 'a reviewed jail name and one IP address are required', unchanged)
    const jail = body!.jail, address = body!.address, target = 'fail2ban:' + jail + ':' + address
    if (ctx.audit) try { await ctx.audit({ actor, action: 'security.intrusion.unban_requested', target, outcome: 'ok', detail: { jail } }) }
    catch { return fail('PRECONDITION_FAILED', 'the unban could not be audited before dispatch', unchanged) }
    let result: UnbanResult, dispatched = false
    try { result = await unbanAddress({ run, jail, address, now, authorize: async () => { await confirm(); dispatched = true } }) }
    catch (error) {
      const detail = (error as { detail?: Record<string, unknown> })?.detail
      await ctx.audit?.({ actor, action: 'security.intrusion.unban', target, outcome: 'failed', detail: { outcome: !dispatched || detail?.stateChanged === false ? 'refused' : 'unknown' } }).catch(() => {})
      throw error
    }
    if (ctx.audit) try { await ctx.audit({ actor, action: 'security.intrusion.unban', target, outcome: result.outcome === 'confirmed' ? 'ok' : 'failed', detail: { outcome: result.outcome } }) }
    catch { return fail('SERVICE_UNAVAILABLE', 'the unban outcome and audit require review', { stateChanged: true, verificationRequired: true, unknownOutcome: true }) }
    return json(result)
  }

  const snapshot = await ctx.readSnapshot()
  if (url.pathname === '/host/security-tools/antivirus') return json(await readAntivirus({ run, present, accounts: snapshot.accounts, jobs: ctx.jobs, now }))
  if (url.pathname === '/host/security-tools/antivirus/update') {
    if (await present(FRESHCLAM).catch(() => null) === false) return fail('PRECONDITION_FAILED', 'freshclam is not installed; install ClamAV from the Software center', { ...unchanged, reason: 'freshclam_not_installed' })
    return submitted(ctx, buildSignatureUpdatePlan(), await confirm(), { action: 'security.antivirus.update_submitted', target: 'clamav:signatures' })
  }
  if (url.pathname === '/host/security-tools/antivirus/scan') {
    if (!isAccountUsername(body!.account)) return fail('VALIDATION', 'an account username is required', unchanged)
    const account = snapshot.accounts.find(item => item.username === body!.account)
    if (!account || account.status === 'terminating') return fail('NOT_FOUND', 'account not found', unchanged)
    // The scan target is the store home after realpath, required to be a directory owned by the account; never a request path.
    let target: string | null = null
    try {
      const resolved = await (ctx.resolveHome ?? realpath)(account.home)
      const facts = await (ctx.inspectHome ?? inspectAccountHome)(resolved)
      if (isScanTarget(resolved) && posix.basename(resolved) === account.username && facts?.type === 'directory' && facts.uid === account.uid) target = resolved
    } catch { target = null }
    if (!target) return fail('PRECONDITION_FAILED', 'the account home is not a directory owned by the account, so it was not scanned', { ...unchanged, reason: 'account_home_unverified' })
    return submitted(ctx, buildAntivirusScanPlan({ accountId: account.id, username: account.username, target }), await confirm(), { action: 'security.antivirus.scan_submitted', target: 'account:' + account.username })
  }

  const accounts = snapshot.accounts.filter(item => isAccountUsername(item.username)).map(item => ({ username: item.username, status: item.status })).sort((a, b) => a.username.localeCompare(b.username)).slice(0, 5000)
  const username = url.searchParams.get('account')
  if (username === null) return json({ accounts, report: null })
  const account = snapshot.accounts.find(item => item.username === username)
  if (!account) return fail('NOT_FOUND', 'account not found', unchanged)
  const ioDevices = ctx.ioDevices ? await ctx.ioDevices(account).catch(() => null) : (await resolveAccountIoDevices(executor, [account], '/home'))?.get(account.id) ?? null
  const report = await readAccountIsolation({ account, plan: snapshot.plans.find(plan => plan.id === account.planId) ?? null, domains: snapshot.domains, executor, ioDevices, now,
    ...(ctx.inspectHome ? { inspectHome: ctx.inspectHome } : {}) })
  return json({ accounts, report })
}

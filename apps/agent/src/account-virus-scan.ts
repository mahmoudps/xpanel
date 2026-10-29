import { realpath } from 'node:fs/promises'
import { posix } from 'node:path'
import { fail, isXpanelError } from '@xpanel/core'
import type { Account, FeatureList, Plan } from '@xpanel/core'
import type { HostJobPlan, HostJobView } from './host-job-contract.ts'
import { SCAN_FINDINGS_LIMIT, SCAN_JOB_KIND, buildAntivirusScanPlan, readAntivirus } from './security-tools-antivirus.ts'
import type { AntivirusEngine, AntivirusJobs, ScanFinding, ScanResult, ScanSummary } from './security-tools-antivirus.ts'
import type { BinaryPresent, SecurityToolsRun } from './security-tools-intrusion.ts'
import { inspectAccountHome } from './security-tools-isolation.ts'
import type { InspectHome } from './security-tools-isolation.ts'
import { binaryPresent } from './security-tools-routes.ts'
import { isScanTarget } from '../../../packages/os/src/security-tools-command.ts'
import type { AgentCallerIdentity } from './server.ts'

export const ACCOUNT_SCAN_JOB_KIND = 'security.antivirus.account-scan'
/** One kind per account: the runner's kind-prefix list then returns exactly this account's scans; root filters on the shared prefix. */
export const accountScanKind = (accountId: string): string => ACCOUNT_SCAN_JOB_KIND + ':' + accountId
export const ACCOUNT_SCAN_HISTORY = 10
export const ACCOUNT_SCAN_COOLDOWN_MINUTES = 15
const COOLDOWN_MS = ACCOUNT_SCAN_COOLDOWN_MINUTES * 60_000
/** Plan feature: catalog tool id and its featureKey. */
export const ACCOUNT_VIRUS_SCAN_FEATURES = ['virus-scanner', 'clamavconnector_scan'] as const
export type AccountScanBlock = 'engine_unavailable' | 'jobs_unavailable' | 'scan_active' | 'cooldown'
export interface AccountScanView { jobId: string; status: HostJobView['status']; result: ScanResult; createdAt: string; finishedAt: string | null; summary: ScanSummary | null; infected: ScanFinding[]; listComplete: boolean }
export interface AccountVirusScanView {
  context: { accountId: string; username: string }
  observedAt: string
  engine: AntivirusEngine
  jobsAvailable: boolean
  limits: { history: number; cooldownMinutes: number; findingsPerScan: number }
  start: { allowed: boolean; reason: AccountScanBlock | null; availableAt: string | null }
  /** Infected paths are relative to the scanned home; '.' is the home itself. */
  scans: AccountScanView[]
  started: { jobId: string } | null
}
type Gate = { reason: AccountScanBlock | null; availableAt: string | null }

async function ownScanJobs(jobs: AntivirusJobs, accountId: string): Promise<HostJobView[]> {
  const kind = accountScanKind(accountId)
  return (await jobs.list({ kindPrefix: kind, limit: ACCOUNT_SCAN_HISTORY })).filter(job => job.kind === kind && job.accountId === accountId)
}

/** One queued or running scan per account, and every start (any outcome) opens a cooldown. */
export function accountScanGate(own: readonly HostJobView[], now: Date): Gate {
  if (own.some(job => job.status === 'queued' || job.status === 'running')) return { reason: 'scan_active', availableAt: null }
  const last = Math.max(...own.map(job => Date.parse(job.createdAt)).filter(Number.isFinite))
  return now.getTime() - last < COOLDOWN_MS ? { reason: 'cooldown', availableAt: new Date(last + COOLDOWN_MS).toISOString() } : { reason: null, availableAt: null }
}

/** Engine and the owner's scans through the root antivirus reader, given only this account's jobs and logs. */
export async function readAccountVirusScan(input: { account: Account; run: SecurityToolsRun | null; present: BinaryPresent; jobs: AntivirusJobs | null; canSubmit: boolean; now: () => Date; started?: { jobId: string } | null }): Promise<AccountVirusScanView> {
  const { account, jobs } = input
  const own = jobs ? await ownScanJobs(jobs, account.id) : [], ids = new Set(own.map(job => job.id))
  const scoped: AntivirusJobs | null = jobs && {
    // readAntivirus reads root scan kinds; the relabelled copies carry this account's jobs only.
    list: async options => options?.kindPrefix === SCAN_JOB_KIND ? own.map(job => ({ ...job, kind: SCAN_JOB_KIND })) : [],
    readLog: async (id, offset, limit) => ids.has(id) ? jobs.readLog(id, offset, limit) : { id, available: false, offset: 0, nextOffset: 0, total: 0, truncated: false, text: '' },
  }
  const run = input.run
  const read = await readAntivirus({ run: run ?? (async () => { throw new Error('host_unavailable') }), present: run ? input.present : async () => null, accounts: [], jobs: scoped, now: input.now })
  const scans = read.scans.map((scan): AccountScanView => {
    const target = scan.target !== null && posix.basename(scan.target) === account.username ? scan.target : null
    return { jobId: scan.jobId, status: scan.status, result: scan.result, createdAt: scan.createdAt, finishedAt: scan.finishedAt, summary: target ? scan.summary : null,
      infected: target ? scan.infected.map(item => ({ path: item.path === target ? '.' : item.path.slice(target.length + 1), signature: item.signature })) : [], listComplete: !!target && scan.listComplete }
  })
  const gate: Gate = read.engine.state !== 'read' ? { reason: 'engine_unavailable', availableAt: null } : !jobs || !input.canSubmit ? { reason: 'jobs_unavailable', availableAt: null } : accountScanGate(own, input.now())
  return { context: { accountId: account.id, username: account.username }, observedAt: read.observedAt, engine: read.engine, jobsAvailable: !!jobs,
    limits: { history: ACCOUNT_SCAN_HISTORY, cooldownMinutes: ACCOUNT_SCAN_COOLDOWN_MINUTES, findingsPerScan: SCAN_FINDINGS_LIMIT },
    start: { allowed: gate.reason === null, ...gate }, scans, started: input.started ?? null }
}

export interface AccountVirusScanRouteDeps {
  caller: AgentCallerIdentity
  store: { getAccountByUsername(username: string): Promise<Account | null>; withAccountLifecycleLease<T>(accountId: string, operation: (account: Account) => Promise<T>): Promise<T>
    getPlan(id: string): Promise<Plan | null>; getFeatureList(id: string): Promise<FeatureList | null> }
  currentPrincipal(): Promise<{ kind: string; id: string; username: string; accountId: string | null; disabled: boolean } | null>
  /** Native Linux host executor only; null reports the engine unavailable instead of simulating it. */
  run: SecurityToolsRun | null
  jobs: AntivirusJobs | null
  submitJob: ((plan: HostJobPlan, actor: string) => Promise<HostJobView>) | null
  audit?: (entry: { actor: string; action: string; target: string; outcome: 'ok' | 'failed'; detail: Record<string, unknown>; principalId: string }) => Promise<unknown>
  present?: BinaryPresent
  resolveHome?: (home: string) => Promise<string>
  inspectHome?: InspectHome
  now?: () => Date
}
const ROUTE = /^\/accounts\/([a-z][a-z0-9]{0,15})\/virus-scan$/
const unchanged = { stateChanged: false }
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const refuse = (gate: Gate): never => gate.reason === 'scan_active' ? fail('CONFLICT', 'a scan of this account is already queued or running', { ...unchanged, reason: gate.reason })
  : gate.reason === 'cooldown' ? fail('LIMIT_EXCEEDED', 'one scan can start every ' + ACCOUNT_SCAN_COOLDOWN_MINUTES + ' minutes', { ...unchanged, reason: gate.reason, availableAt: gate.availableAt })
  : fail('PRECONDITION_FAILED', gate.reason === 'engine_unavailable' ? 'ClamAV is not available on this server, so nothing was started' : 'the host job runner is unavailable, so nothing was started', { ...unchanged, reason: gate.reason })

async function readEmptyBody(req: Request): Promise<void> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail('VALIDATION', 'application/json is required', unchanged)
  const text = await req.text()
  let body: unknown
  try { body = text.length <= 64 ? JSON.parse(text) : null } catch { body = null }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) fail('VALIDATION', 'a scan request takes no fields; the target is the account home', unchanged)
}

/** Account owner only: GET reads the engine and own scan history, POST queues one scan of the account home. */
export async function handleAccountVirusScanRoute(req: Request, url: URL, method: string, deps: AccountVirusScanRouteDeps): Promise<Response | null> {
  const match = ROUTE.exec(url.pathname)
  if (!match) return null
  if (method !== 'GET' && method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  if (url.search) return fail('VALIDATION', 'virus scan requests do not accept query selectors', unchanged)
  const username = match[1]!, caller = deps.caller
  if (caller.role !== 'user' || !caller.accountId) return fail('FORBIDDEN', 'virus scans are run by the signed-in account owner', unchanged)
  if (method === 'POST') await readEmptyBody(req)
  const current = async (): Promise<Account> => {
    const account = await deps.store.getAccountByUsername(username)
    return account && account.id === caller.accountId ? account : fail('NOT_FOUND', 'account not found', unchanged)
  }
  const authorize = async (account: Account): Promise<void> => {
    const principal = await deps.currentPrincipal()
    if (account.status !== 'active' || account.username !== username || !principal || principal.disabled || principal.kind !== 'user' || principal.id !== caller.principalId || principal.accountId !== account.id || principal.username !== account.username) return fail('FORBIDDEN', 'the current account owner is not authorized', unchanged)
    const plan = await deps.store.getPlan(account.planId), features = plan ? await deps.store.getFeatureList(plan.featureListId) : null
    if (!features || ACCOUNT_VIRUS_SCAN_FEATURES.some(key => features.disabled.includes(key))) return fail('FORBIDDEN', 'the virus scanner is disabled by the account plan', unchanged)
  }
  const now = deps.now ?? (() => new Date()), present = deps.present ?? binaryPresent
  const read = (account: Account, started: { jobId: string } | null = null) => readAccountVirusScan({ account, run: deps.run, present, jobs: deps.jobs, canSubmit: !!deps.submitJob, now, started })
  const account = await current()
  await authorize(account)
  if (method === 'GET') {
    const view = await read(account)
    // Fresh authority after the host read: a revoked owner never receives the history.
    await authorize(await current())
    return json(view)
  }
  const before = await read(account)
  if (before.start.reason) return refuse(before.start)
  const jobs = deps.jobs!, submitJob = deps.submitJob!
  const job = await deps.store.withAccountLifecycleLease(account.id, async fresh => {
    await authorize(fresh)
    const gate = accountScanGate(await ownScanJobs(jobs, fresh.id), now())
    if (gate.reason) return refuse(gate)
    // The target is the store home after realpath, a directory owned by the account uid; never a request path.
    let target: string | null = null
    try {
      const resolved = await (deps.resolveHome ?? realpath)(fresh.home), facts = await (deps.inspectHome ?? inspectAccountHome)(resolved)
      if (isScanTarget(resolved) && posix.basename(resolved) === fresh.username && facts?.type === 'directory' && facts.uid === fresh.uid) target = resolved
    } catch { target = null }
    if (!target) return fail('PRECONDITION_FAILED', 'the account home is not a directory owned by the account, so it was not scanned', { ...unchanged, reason: 'account_home_unverified' })
    const plan: HostJobPlan = { ...buildAntivirusScanPlan({ accountId: fresh.id, username: fresh.username, target }), kind: accountScanKind(fresh.id), summary: 'Antivirus scan of account ' + fresh.username + ' requested by its owner' }
    await authorize(fresh)
    try { return await submitJob(plan, caller.actor) } catch (error) {
      if (isXpanelError(error)) throw error
      return fail('SERVICE_UNAVAILABLE', 'scan submission outcome is unknown; read the scan history before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
    }
  })
  await deps.audit?.({ actor: caller.actor, action: 'account.virus_scan.submitted', target: 'account:' + account.username, outcome: 'ok', detail: { jobId: job.id }, principalId: caller.principalId }).catch(() => {})
  // The submission counts only when a re-read lists the job for this account.
  const after = await read(account, { jobId: job.id })
  if (!after.scans.some(scan => scan.jobId === job.id)) return fail('SERVICE_UNAVAILABLE', 'the scan was submitted but could not be read back; read the scan history before retrying', { stateChanged: true, unknownOutcome: true, verificationRequired: true })
  return json(after, 202)
}

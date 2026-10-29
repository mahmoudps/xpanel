import { randomUUID } from 'node:crypto'
import { cronJobFields as jobFields, cronJobUnitId, cronWorkspaceRevision, fail } from '@xpanel/core'
import type { Account, CronJobIntent, CronJobObservationReceipt, OsProfile } from '@xpanel/core'
import type { CronJobState } from '@xpanel/state'
import { system } from '@xpanel/render'
import { assertAccountFeatures, isMailboxPrincipal } from './authorization.ts'
import type { AuthenticatedCaller } from './auth.ts'
import type { ExtendedRouteHelpers } from './extended-routes.ts'

export const CRON_WORKSPACE_PATH = '/api/account/cron'
export const CRON_WORKSPACE_MAX_JOBS = 1000
export const CRON_WORKSPACE_MAX_RUNTIME = 604800
export { cronWorkspaceRevision } from '@xpanel/core'
type StoredCronJob = CronJobState & { maxRuntimeSec?: number }
export interface CronWorkspacePorts extends Pick<ExtendedRouteHelpers, 'store' | 'requireCaller' | 'emitAudit' | 'triggerReconcile'> {
  /** The actual configured host profile; omission never substitutes an assumed host. */
  osProfile?: OsProfile
  /** Trusted local qualification evidence, checked inside the current account lease. */
  admitCronMutation: (caller: AuthenticatedCaller, account: Account, action: 'save' | 'run') => Promise<void>
  withCronAccountLease: <T>(accountId: string, operation: (account: Account, jobs: readonly CronJobState[]) => Promise<T>) => Promise<T>
  runCronNow?: (caller: AuthenticatedCaller, intent: CronJobIntent) => Promise<CronJobObservationReceipt>
  observeCronStatus?: (caller: AuthenticatedCaller, intent: CronJobIntent) => Promise<CronJobObservationReceipt>
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeLine = (value: unknown, limit: number, field: string, allowEmpty = false): string => {
  if (typeof value !== 'string' || value.length > limit || !value.isWellFormed() || /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/u.test(value) || !allowEmpty && !value.trim()) return fail('VALIDATION', `${field} must be bounded single-line text`, { stateChanged: false })
  return value
}
export const parseCronWorkspaceBody = (value: unknown, mode: 'create' | 'edit' | 'delete'): Record<string, unknown> => {
  if (!object(value)) return fail('VALIDATION', 'cron request must be an object', { stateChanged: false })
  const fields = mode === 'delete' ? ['expectedRevision', 'confirmation'] : ['expectedRevision', 'schedule', 'command', 'comment', 'enabled', 'maxRuntimeSec']
  if (Object.keys(value).some(key => !fields.includes(key))) return fail('VALIDATION', 'unsupported cron request field', { stateChanged: false })
  if (typeof value.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.expectedRevision)) return fail('VALIDATION', 'expectedRevision must be a saved cron revision', { stateChanged: false })
  return value
}
export const validateCronWorkspaceDraft = (input: Record<string, unknown>, current?: StoredCronJob): Omit<StoredCronJob, 'id' | 'accountId'> => {
  const field = (key: string, fallback: unknown): unknown => Object.hasOwn(input, key) ? input[key] : fallback
  const schedule = safeLine(field('schedule', current?.schedule), 128, 'schedule')
  system.cronToOnCalendar(schedule)
  const command = safeLine(field('command', current?.command), 4096, 'command')
  const comment = safeLine(field('comment', current?.comment ?? ''), 255, 'comment', true)
  const enabled = field('enabled', current?.enabled ?? true)
  if (typeof enabled !== 'boolean') return fail('VALIDATION', 'enabled must be a boolean', { stateChanged: false })
  const runtime = Object.hasOwn(input, 'maxRuntimeSec') ? input.maxRuntimeSec : current?.maxRuntimeSec
  if (runtime !== undefined && runtime !== null && (typeof runtime !== 'number' || !Number.isSafeInteger(runtime) || runtime < 1 || runtime > CRON_WORKSPACE_MAX_RUNTIME)) return fail('VALIDATION', 'maxRuntimeSec must be null or an integer from 1 through 604800', { stateChanged: false })
  return { schedule, command, comment, enabled, ...(typeof runtime === 'number' ? { maxRuntimeSec: runtime } : {}) }
}
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })

export function createCronWorkspaceRoutes(ports: CronWorkspacePorts) {
  const admit = async (caller: AuthenticatedCaller, account: Account, action: 'save' | 'run'): Promise<void> => {
    if (typeof ports.admitCronMutation !== 'function') return fail('PRECONDITION_FAILED', 'Trusted cron mutation qualification is unavailable', { stateChanged: false })
    await ports.admitCronMutation(caller, account, action)
  }
  const checkJobs = (account: Account, jobs: readonly StoredCronJob[]): void => {
    if (jobs.some(job => job.accountId !== account.id) || new Set(jobs.map(job => job.id)).size !== jobs.length || new Set(jobs.map(job => cronJobUnitId(job.id))).size !== jobs.length) return fail('PRECONDITION_FAILED', 'Saved cron ownership or unit identity requires review', { stateChanged: false })
  }
  const checkReceipt = (value: CronJobObservationReceipt, account: Account, intent: CronJobIntent, running: boolean): CronJobObservationReceipt => {
    const invalid = (): never => fail('PRECONDITION_FAILED', 'Cron host reply requires review', running ? { stateChanged: true, unknownOutcome: true, verificationRequired: true } : { stateChanged: false, observationUnavailable: true })
    if (!object(value) || !object(value.context) || value.context.accountId !== account.id || value.context.jobId !== intent.jobId || value.revision !== intent.expectedRevision || !object(value.observation)) return invalid()
    const observation = value.observation, names = system.cronUnitNames(account.username, cronJobUnitId(intent.jobId))
    if (observation.username !== account.username || observation.jobId !== cronJobUnitId(intent.jobId) || observation.timerUnit !== names.timer || observation.serviceUnit !== names.service || observation.slice !== system.accountSliceName(account.uid)) return invalid()
    if (['timerEnabled', 'timerActive', 'serviceRunning'].some(key => typeof observation[key] !== 'boolean')) return invalid()
    for (const key of ['lastTriggerAt', 'lastStartedAt', 'nextRunAt']) { const timestamp = observation[key]; if (timestamp !== null && (typeof timestamp !== 'string' || !timestamp || timestamp.length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(timestamp))) return invalid() }
    if (observation.durationMs !== null && (typeof observation.durationMs !== 'number' || !Number.isFinite(observation.durationMs) || observation.durationMs < 0)) return invalid()
    if (observation.lastExitCode !== null && (typeof observation.lastExitCode !== 'number' || !Number.isInteger(observation.lastExitCode) || observation.lastExitCode < 0 || observation.lastExitCode > 255)) return invalid()
    if (typeof observation.lastResult !== 'string' || !observation.lastResult || observation.lastResult.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(observation.lastResult)) return invalid()
    return value
  }
  const authorize = async (req: Request, expectedAccountId?: string, freshAccount?: Account): Promise<{ caller: AuthenticatedCaller; account: Account }> => {
    const caller = await ports.requireCaller(req)
    if (caller.principal.kind !== 'user' || isMailboxPrincipal(caller)) return fail('FORBIDDEN', 'cron workspace requires the account owner', { stateChanged: false })
    if (expectedAccountId !== undefined && caller.principal.accountId !== expectedAccountId) return fail('FORBIDDEN', 'cron account binding changed', { stateChanged: false })
    const account = freshAccount ?? await ports.store.getAccount(caller.principal.accountId)
    if (!account || account.id !== caller.principal.accountId) return fail('NOT_FOUND', 'account not found', { stateChanged: false })
    if (account.status !== 'active') return fail('FORBIDDEN', 'cron configuration requires an active account', { stateChanged: false })
    await assertAccountFeatures(ports.store, caller, account, ['cron-jobs'])
    return { caller, account }
  }
  const project = (account: Account, jobs: readonly StoredCronJob[]): Record<string, unknown> => ({
    context: { accountId: account.id, username: account.username, home: account.home },
    revision: cronWorkspaceRevision(account.id, jobs),
    jobs: jobs.map(job => {
      let onCalendar: string[] = []
      try { onCalendar = system.cronToOnCalendar(job.schedule) } catch { /* Keep legacy unsupported schedules readable for repair/removal. */ }
      let unitPreview: { service: string; timer: string } | null = null
      if (ports.osProfile && onCalendar.length > 0) {
        const rendered = system.renderCronUnits(account, { id: cronJobUnitId(job.id), schedule: job.schedule, command: job.command, ...(job.maxRuntimeSec !== undefined ? { maxRuntimeSec: job.maxRuntimeSec } : {}) }, ports.osProfile)
        unitPreview = { service: rendered.service.content, timer: rendered.timer.content }
      }
      return { ...jobFields(job), onCalendar, scheduleSupported: onCalendar.length > 0, unitPreview, observation: { state: 'unavailable', lastRun: null, durationMs: null, nextRun: null } }
    }),
    capacity: { maxJobs: CRON_WORKSPACE_MAX_JOBS, used: jobs.length, maxRuntimeSec: CRON_WORKSPACE_MAX_RUNTIME },
    capabilities: { runNow: typeof ports.runCronNow === 'function' && typeof ports.withCronAccountLease === 'function', observation: typeof ports.observeCronStatus === 'function' && typeof ports.withCronAccountLease === 'function', outputEmail: false, unitPreview: !!ports.osProfile },
    application: { status: 'configuration_only', nativeApplied: false },
  })
  return async (req: Request, url: URL, method: string): Promise<Response | null> => {
    if (url.pathname !== CRON_WORKSPACE_PATH && !url.pathname.startsWith(CRON_WORKSPACE_PATH + '/')) return null
    const { caller, account } = await authorize(req)
    if (url.search) return fail('VALIDATION', 'cron workspace does not accept account or mailbox selectors', { stateChanged: false })
    const suffix = url.pathname.slice(CRON_WORKSPACE_PATH.length)
    const match = /^\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(status|run))?$/i.exec(suffix)
    const id = match?.[1]?.toLowerCase(), operation = match?.[2]
    if (suffix && !id) return fail('NOT_FOUND', 'cron job not found', { stateChanged: false })
    const jobs = await ports.store.listCronJobs(account.id)
    checkJobs(account, jobs)
    if (method === 'GET' && !suffix) return json(project(account, jobs))
    if (operation) {
      const running = operation === 'run', provider = running ? ports.runCronNow : ports.observeCronStatus
      if (method !== (running ? 'POST' : 'GET')) return new Response(null, { status: 405, headers: { allow: running ? 'POST' : 'GET' } })
      if (!provider || typeof ports.withCronAccountLease !== 'function') return fail('PRECONDITION_FAILED', 'Cron host execution or observation is unavailable', { stateChanged: false })
      let body: Record<string, unknown> | undefined
      if (running) {
        let raw: unknown
        try { raw = await req.json() } catch { return fail('VALIDATION', 'cron request must be valid JSON', { stateChanged: false }) }
        body = parseCronWorkspaceBody(raw, 'delete')
      }
      // Preparation uses local state only. The API lease ends before the RPC begins.
      const prepared = await ports.withCronAccountLease(account.id, async (freshAccount, persisted) => {
        const fresh = await authorize(req, account.id, freshAccount)
        checkJobs(freshAccount, persisted)
        const revision = cronWorkspaceRevision(freshAccount.id, persisted)
        if (running && body!.expectedRevision !== revision) return fail('CONFLICT', 'Cron configuration changed; read saved jobs before retrying', { stateChanged: false })
        const job = persisted.find(job => job.id === id)
        if (!job) return fail('NOT_FOUND', 'cron job not found', { stateChanged: false })
        if (running) {
          if (!job.enabled) return fail('PRECONDITION_FAILED', 'Enable and reconcile this schedule before manual execution', { stateChanged: false })
          system.cronToOnCalendar(job.schedule)
          if (body!.confirmation !== job.command) return fail('VALIDATION', 'Run confirmation must match the selected saved command', { stateChanged: false })
          await admit(fresh.caller, freshAccount, 'run')
        }
        return { account: freshAccount, caller: fresh.caller, intent: Object.freeze({ accountId: freshAccount.id, jobId: job.id, expectedRevision: revision }) }
      })
      const receipt = checkReceipt(await provider(prepared.caller, prepared.intent), prepared.account, prepared.intent, running)
      if (running) await ports.emitAudit({ actor: prepared.caller.principal.username, action: 'cron.run_requested', target: 'account:' + prepared.account.username, detail: { requested: true, completed: false }, outcome: 'ok', principalId: prepared.caller.principal.id }, { accountId: prepared.account.id, resellerId: prepared.account.ownerId })
      return json({ ...receipt, status: running ? 'accepted' : 'observed', ...(running ? { requested: true, completed: false } : {}) }, running ? 202 : 200)
    }
    if (!(method === 'POST' && !suffix || (method === 'PATCH' || method === 'DELETE') && !!id)) return new Response(null, { status: 405, headers: { allow: suffix ? 'PATCH, DELETE' : 'GET, POST' } })
    let raw: unknown
    try { raw = await req.json() } catch { return fail('VALIDATION', 'cron request must be valid JSON', { stateChanged: false }) }
    const mode = method === 'POST' ? 'create' : method === 'PATCH' ? 'edit' : 'delete'
    const body = parseCronWorkspaceBody(raw, mode)
    if (body.expectedRevision !== cronWorkspaceRevision(account.id, jobs)) return fail('CONFLICT', 'cron configuration changed; read saved jobs before retrying', { stateChanged: false })
    const current = id ? jobs.find(job => job.id === id) : undefined
    if (id && !current) return fail('NOT_FOUND', 'cron job not found', { stateChanged: false })
    if (mode === 'create' && jobs.length >= CRON_WORKSPACE_MAX_JOBS) return fail('CONFLICT', 'cron job capacity reached', { stateChanged: false })
    if (mode === 'delete' && body.confirmation !== current!.command) return fail('VALIDATION', 'delete confirmation must match the selected saved command', { stateChanged: false })
    const next = mode === 'delete' ? jobs.filter(job => job.id !== id)
      : mode === 'create' ? [...jobs, { id: randomUUID(), accountId: account.id, ...validateCronWorkspaceDraft(body) }]
      : jobs.map(job => job.id === id ? { id: job.id, accountId: account.id, ...validateCronWorkspaceDraft(body, job) } : job)
    checkJobs(account, next)
    const saved = await ports.store.saveCronJobs(account.id, next, { cronGuard: async (freshAccount, persisted) => {
      if (cronWorkspaceRevision(account.id, persisted) !== body.expectedRevision) return fail('CONFLICT', 'cron configuration changed; read saved jobs before retrying', { stateChanged: false })
      const fresh = await authorize(req, account.id, freshAccount)
      await admit(fresh.caller, freshAccount, 'save')
    } })
    await ports.emitAudit({ actor: caller.principal.username, action: 'cron.' + (mode === 'create' ? 'created' : mode === 'edit' ? 'updated' : 'deleted'), target: 'account:' + account.username,
      detail: { jobCount: saved.length }, outcome: 'ok', principalId: caller.principal.id }, { accountId: account.id, resellerId: account.ownerId })
    const reconcile = await ports.triggerReconcile(caller, { scope: { accountId: account.id, resellerId: account.ownerId } })
    return json({ ...project(account, saved), reconcile: reconcile?.body ?? null }, mode === 'create' ? 201 : 200)
  }
}

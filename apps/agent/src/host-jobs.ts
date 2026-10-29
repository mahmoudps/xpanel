import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { fail, isXpanelError, redactInlineSecrets } from '@xpanel/core'
import {
  acquireJobLease, completeJobWithLease, computeJobRequestFingerprint, enqueueDurableJob, finishJob, getDurableJob,
  renewJobLease, requestJobCancellation, saveJobCheckpoint,
} from '@xpanel/db'
import type { Db, DurableJobRecord, JobFailureClass } from '@xpanel/db'
import type { HostJobCommandResult, HostJobCommandStep, HostJobPlan, HostJobRun, HostJobStepResult, HostJobStepRun, HostJobStepState, HostJobTitleValues, HostJobVerification, HostJobView } from './host-job-contract.ts'
import { HOST_JOB_ENV_NAMES, HOST_JOB_MAX_TIMEOUT_MS } from './host-job-exec.ts'

export const DEFAULT_HOST_JOB_LOG_DIR = '/var/lib/xpanel-agent/jobs'
export const HOST_JOB_LOG_CAP_BYTES = 4 * 1024 * 1024
export const HOST_JOB_LOG_READ_MAX = 262_144
export const HOST_JOB_LIST_MAX = 100
export const HOST_JOB_STATUSES: readonly HostJobView['status'][] = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled'])
export const HOST_JOB_KIND_RE = /^[a-z][a-z0-9_.:-]{0,127}$/
export const HOST_JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const STEP_ID_RE = /^[a-z][a-z0-9-]{0,63}$/
const TITLE_VALUE_NAME_RE = /^[a-z][A-Za-z0-9]{0,31}$/
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/
const LOCK_CONTENTION_RE = /Could not get lock|dpkg frontend lock|Waiting for cache lock/i
const LOG_MARKER = Buffer.from(`\n[log truncated at ${HOST_JOB_LOG_CAP_BYTES} bytes]\n`, 'utf8')
const STEP_STATES: readonly HostJobStepState[] = ['pending', 'running', 'succeeded', 'failed', 'skipped', 'unknown']
const MAX_PLAN_DATA_BYTES = 16 * 1024
const MAX_VERIFICATION_BYTES = 8 * 1024
const MAX_RESULT_TEXT_BYTES = 64 * 1024
const MAX_FINALIZER_COMMANDS = 32
const DEFAULT_LEASE_MS = 30_000

type StepRecord = { id: string; state: HostJobStepState; exitCode: number | null }
type Settlement = { status: 'succeeded' | 'failed' | 'cancelled'; failureClass: JobFailureClass | null; error: string | null; verification?: HostJobVerification }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const safeText = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max && value.isWellFormed() && !UNSAFE_TEXT_RE.test(value)
const titleValues = (value: unknown): value is HostJobTitleValues => object(value) && Object.keys(value).length <= 8
  && Object.entries(value).every(([name, item]) => TITLE_VALUE_NAME_RE.test(name) && safeText(item, 0, 160))
const jsonBytes = (value: unknown): number => { try { return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') } catch { return Infinity } }
const invalid = (message: string): never => fail('VALIDATION', message, { stateChanged: false })

/** Rejects anything outside the reviewed plan contract and returns an immutable copy of its steps. */
export const validateHostJobPlan = (plan: HostJobPlan): readonly HostJobCommandStep[] => {
  if (!object(plan)) return invalid('a host job plan is required')
  if (typeof plan.kind !== 'string' || !HOST_JOB_KIND_RE.test(plan.kind)) return invalid('host job kind must look like system.packages.upgrade')
  if (!safeText(plan.summary, 1, 512)) return invalid('host job summary must be 1..512 safe characters')
  if (plan.accountId !== null && (typeof plan.accountId !== 'string' || !HOST_JOB_ID_RE.test(plan.accountId))) return invalid('host job account must be a lowercase UUID or null')
  if (!object(plan.fingerprint) || !object(plan.detail) || jsonBytes({ fingerprint: plan.fingerprint, detail: plan.detail }) > MAX_PLAN_DATA_BYTES) return invalid('host job fingerprint and detail must be bounded objects')
  if (typeof plan.policy !== 'function') return invalid('host job plans require a command policy')
  for (const name of ['beforeStep', 'verify', 'finalize'] as const) if (plan[name] !== undefined && typeof plan[name] !== 'function') return invalid(`host job ${name} must be a function`)
  if (!Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 32) return invalid('host job plans require 1..32 steps')
  const ids = new Set<string>()
  return Object.freeze(plan.steps.map((step: HostJobCommandStep): HostJobCommandStep => {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !STEP_ID_RE.test(step.id) || ids.has(step.id)) return invalid('host job step ids must be unique short slugs')
    ids.add(step.id)
    if (!safeText(step.title, 1, 160) || step.titleValues !== undefined && !titleValues(step.titleValues)) return invalid('host job steps require an English title message and bounded title values')
    if (!Array.isArray(step.argv) || step.argv.length < 1 || step.argv.length > 256 || step.argv.some(item => typeof item !== 'string' || item.length > 4096 || item.includes('\0')) || !step.argv[0]!.startsWith('/')) return invalid('host job steps require an absolute binary and bounded argv')
    if (typeof step.timeoutMs !== 'number' || !Number.isSafeInteger(step.timeoutMs) || step.timeoutMs < 1 || step.timeoutMs > HOST_JOB_MAX_TIMEOUT_MS) return invalid('host job step timeout must be 1..3600000 ms')
    if (typeof step.mutates !== 'boolean') return invalid('host job steps must declare whether they change the host')
    if (step.env !== undefined && (!object(step.env) || Object.entries(step.env).some(([name, value]) => !(HOST_JOB_ENV_NAMES as readonly string[]).includes(name) || !safeText(value, 0, 256)))) return invalid('host job environment is limited to reviewed names')
    if (step.successExitCodes !== undefined && (!Array.isArray(step.successExitCodes) || step.successExitCodes.length < 1 || step.successExitCodes.length > 8 || new Set(step.successExitCodes).size !== step.successExitCodes.length || step.successExitCodes.some(code => !Number.isSafeInteger(code) || code < 1 || code > 255))) return invalid('host job success exit codes must be 1..8 distinct codes in 1..255')
    return Object.freeze({ id: step.id, title: step.title, ...(step.titleValues ? { titleValues: Object.freeze({ ...step.titleValues }) } : {}), argv: Object.freeze([...step.argv]), ...(step.env ? { env: Object.freeze({ ...step.env }) } : {}), timeoutMs: step.timeoutMs, mutates: step.mutates, ...(step.successExitCodes ? { successExitCodes: Object.freeze([...step.successExitCodes]) } : {}) })
  }))
}

const admits = (policy: HostJobPlan['policy'], argv: readonly string[]): boolean => { try { return policy(argv) === true } catch { return false } }

const sanitizeLog = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g, '\ufffd')

/** Last index at or before `end` that does not split a UTF-8 sequence. */
const utf8Boundary = (buffer: Buffer, end: number): number => {
  for (let back = 1; back <= Math.min(3, end); back++) {
    const byte = buffer[end - back]!
    if ((byte & 0xc0) === 0x80) continue
    const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return width > back && end - back > 0 ? end - back : end
  }
  return end
}

const storedSteps = (job: DurableJobRecord): Pick<HostJobView['steps'][number], 'id' | 'title' | 'titleValues'>[] | null => {
  const host = job.detail.hostJob
  if (!object(host) || host.v !== 1 || !Array.isArray(host.steps)) return null
  return host.steps.flatMap(step => object(step) && typeof step.id === 'string' && STEP_ID_RE.test(step.id) && safeText(step.titleEn, 1, 160)
    ? [{ id: step.id, title: step.titleEn, ...(titleValues(step.titleValues) ? { titleValues: step.titleValues } : {}) }] : [])
}

const stepRecords = (job: DurableJobRecord): StepRecord[] => {
  const raw = job.checkpointData.stepStates
  if (!Array.isArray(raw)) return []
  return raw.flatMap(item => object(item) && typeof item.id === 'string' && STEP_STATES.includes(item.state as HostJobStepState)
    ? [{ id: item.id, state: item.state as HostJobStepState, exitCode: Number.isSafeInteger(item.exitCode) ? item.exitCode as number : null }] : [])
}

const verificationOf = (value: unknown): HostJobVerification | null =>
  object(value) && typeof value.ok === 'boolean' && object(value.detail) ? { ok: value.ok, detail: value.detail } : null

const boundedVerification = (value: unknown, phase: string): HostJobVerification => {
  const observed = verificationOf(value)
  return !observed ? { ok: false, detail: { error: `${phase} returned an invalid result` } }
    : jsonBytes(observed.detail) > MAX_VERIFICATION_BYTES ? { ok: observed.ok, detail: { truncated: `${phase} detail exceeded ${MAX_VERIFICATION_BYTES} bytes` } } : observed
}

const retainedResult = (result: HostJobCommandResult | null): Readonly<HostJobCommandResult> | null => {
  if (!result) return null
  const text = (value: string): string => {
    const bytes = Buffer.from(value, 'utf8')
    return bytes.subarray(0, utf8Boundary(bytes, Math.min(bytes.length, MAX_RESULT_TEXT_BYTES))).toString('utf8')
  }
  return Object.freeze({ ok: result.ok, code: result.code, stdout: text(result.stdout), stderr: text(result.stderr), timedOut: result.timedOut })
}

export interface HostJobRunnerDeps {
  db: Db
  run: HostJobRun
  logDir?: string
  now?: () => Date
  leaseOwner?: string
  /** Lease length; renewed every third of it while a step runs. */
  leaseMs?: number
}

/**
 * Durable, serial host job execution. Plans (with their policy and verification functions) live
 * only in this process; a queued job whose plan is gone after a restart fails instead of running.
 */
export class HostJobRunner {
  private readonly db: Db
  private readonly run: HostJobRun
  private readonly logDir: string
  private readonly now: () => Date
  private readonly leaseOwner: string
  private readonly leaseMs: number
  private readonly plans = new Map<string, { plan: HostJobPlan; steps: readonly HostJobCommandStep[] }>()
  private readonly queue: string[] = []
  private readonly heartbeats = new Set<ReturnType<typeof setInterval>>()
  private admission: Promise<unknown> = Promise.resolve()
  private logWrites: Promise<unknown> = Promise.resolve()
  private draining: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private activeId: string | null = null
  private logDirReady: Promise<void> | null = null
  private closed = false

  constructor(deps: HostJobRunnerDeps) {
    this.db = deps.db
    this.run = deps.run
    this.logDir = deps.logDir ?? DEFAULT_HOST_JOB_LOG_DIR
    this.now = deps.now ?? (() => new Date())
    this.leaseOwner = (deps.leaseOwner ?? `host-jobs:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`).slice(0, 128)
    this.leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS
  }

  /** Validates and enqueues a reviewed plan, returning an existing unfinished job for the same request. */
  submit(plan: HostJobPlan, actor: string): Promise<{ job: HostJobView; deduplicated: boolean }> {
    const work = this.admission.then(() => this.admit(plan, actor))
    this.admission = work.catch(() => undefined)
    return work
  }

  private async admit(plan: HostJobPlan, actor: string): Promise<{ job: HostJobView; deduplicated: boolean }> {
    if (this.closed) return fail('PRECONDITION_FAILED', 'the host job runner is stopping', { stateChanged: false })
    const steps = validateHostJobPlan(plan)
    for (const step of steps) if (!admits(plan.policy, step.argv)) return fail('FORBIDDEN', 'a host job step is outside its reviewed command grammar', { stateChanged: false, step: step.id })
    const requestFingerprint = computeJobRequestFingerprint({ kind: plan.kind, accountId: plan.accountId, actor: 'host-job',
      detail: { fingerprint: plan.fingerprint, steps: steps.map(step => ({ id: step.id, argv: step.argv, env: step.env ?? {}, mutates: step.mutates, timeoutMs: step.timeoutMs })) } })
    const [existing] = await this.db.query<{ id: string }>(
      `SELECT j.id FROM jobs j JOIN job_runtime_leases l ON l.job_id = j.id
       WHERE l.request_fingerprint = $1 AND j.status IN ('queued', 'running') AND json_extract(j.detail, '$.hostJob.v') = 1
       ORDER BY j.created_at ASC LIMIT 1`, [requestFingerprint])
    if (existing) {
      const job = await this.get(existing.id)
      if (job) return { job, deduplicated: true }
    }
    const id = randomUUID()
    await this.createLog(id)
    let created: DurableJobRecord
    try {
      created = await enqueueDurableJob(this.db, {
        id, kind: plan.kind, accountId: plan.accountId, actor, summary: plan.summary, requestFingerprint, maxAttempts: 2,
        detail: { hostJob: { v: 1, summary: plan.summary, steps: steps.map(step => ({ id: step.id, titleEn: step.title, ...(step.titleValues ? { titleValues: step.titleValues } : {}), mutates: step.mutates, timeoutMs: step.timeoutMs })) }, plan: plan.detail, planFingerprint: plan.fingerprint },
      })
    } catch (error) {
      await unlink(this.logPath(id)).catch(() => undefined)
      throw error
    }
    this.plans.set(id, { plan: Object.freeze({ ...plan, steps }), steps })
    this.queue.push(id)
    await this.log(id, `${created.createdAt} queued ${plan.kind} for ${actor}: ${plan.summary}\n`)
    this.kick()
    return { job: this.view(created), deduplicated: false }
  }

  async get(id: string): Promise<HostJobView | null> {
    if (typeof id !== 'string' || !HOST_JOB_ID_RE.test(id)) return null
    const job = await getDurableJob(this.db, id)
    return job && storedSteps(job) ? this.view(job, await this.logSize(id)) : null
  }

  async list(options: { kindPrefix?: string; status?: HostJobView['status']; limit?: number } = {}): Promise<HostJobView[]> {
    const limit = options.limit ?? 50
    if (options.kindPrefix !== undefined && (typeof options.kindPrefix !== 'string' || !HOST_JOB_KIND_RE.test(options.kindPrefix))) return invalid('job kind filter is invalid')
    if (options.status !== undefined && !HOST_JOB_STATUSES.includes(options.status)) return invalid('job status filter is invalid')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HOST_JOB_LIST_MAX) return invalid('job list limit must be 1..100')
    const rows = await this.db.query<{ id: string }>(
      `SELECT j.id FROM jobs j
       WHERE json_extract(j.detail, '$.hostJob.v') = 1
         AND ($1 IS NULL OR substr(j.kind, 1, length($1)) = $1)
         AND ($2 IS NULL OR j.status = $2)
       ORDER BY j.created_at DESC, j.id DESC LIMIT $3`, [options.kindPrefix ?? null, options.status ?? null, limit])
    const views: HostJobView[] = []
    for (const row of rows) { const job = await this.get(row.id); if (job) views.push(job) }
    return views
  }

  /** Cancellation is recorded durably and honoured only between steps; a running step is never killed. */
  async cancel(id: string, actor: string, beforeWrite?: () => Promise<void>): Promise<HostJobView> {
    const current = await this.get(id)
    if (!current) return fail('NOT_FOUND', 'host job not found', { stateChanged: false })
    if (current.status !== 'queued' && current.status !== 'running') return fail('PRECONDITION_FAILED', `the job is already ${current.status}`, { stateChanged: false })
    await beforeWrite?.()
    const updated = await requestJobCancellation(this.db, { jobId: id, actor, reason: `cancellation requested by ${actor}`, now: this.now() })
    if (updated.status === 'cancelled' && this.activeId !== id) {
      const index = this.queue.indexOf(id)
      if (index >= 0) this.queue.splice(index, 1)
      this.plans.delete(id)
    }
    await this.log(id, `${this.now().toISOString()} cancellation requested by ${actor}${updated.status === 'cancelled' ? '; the job had not started' : '; it takes effect before the next step'}\n`)
    return (await this.get(id)) ?? fail('NOT_FOUND', 'host job not found', { stateChanged: true })
  }

  async readLog(id: string, offset = 0, limit = 65_536): Promise<{ id: string; available: boolean; offset: number; nextOffset: number; total: number; truncated: boolean; text: string }> {
    if (typeof id !== 'string' || !HOST_JOB_ID_RE.test(id)) return invalid('a job id is required')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > HOST_JOB_LOG_CAP_BYTES) return invalid('log offset is out of range')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > HOST_JOB_LOG_READ_MAX) return invalid('log read limit must be 1..262144')
    if (!(await this.get(id))) return fail('NOT_FOUND', 'host job not found', { stateChanged: false })
    let handle
    try { handle = await open(this.logPath(id), constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { id, available: false, offset: 0, nextOffset: 0, total: 0, truncated: false, text: '' }
      return fail('SERVICE_UNAVAILABLE', 'the job log could not be read', { stateChanged: false })
    }
    try {
      const metadata = await handle.stat()
      if (!metadata.isFile()) return fail('SERVICE_UNAVAILABLE', 'the job log could not be read', { stateChanged: false })
      const total = metadata.size
      if (offset > total) return invalid('log offset is beyond the recorded log')
      const buffer = Buffer.alloc(Math.min(limit, total - offset))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
      const end = offset + bytesRead < total ? utf8Boundary(buffer, bytesRead) : bytesRead
      return { id, available: true, offset, nextOffset: offset + end, total, truncated: total >= HOST_JOB_LOG_CAP_BYTES, text: sanitizeLog(buffer.subarray(0, end).toString('utf8')) }
    } finally { await handle.close() }
  }

  /**
   * Startup (and pre-run) recovery: an expired running host job was interrupted mid-plan, so its
   * outcome is unknown; a queued job whose plan is not in this process can no longer run as reviewed.
   * Callbacks are process-local: recovery cannot replay finalizers or claim their cleanup completed.
   */
  async recoverInterrupted(): Promise<{ failed: number }> {
    const rows = await this.db.query<{ id: string; status: string }>(
      `SELECT j.id, j.status FROM jobs j LEFT JOIN job_runtime_leases l ON l.job_id = j.id
       WHERE json_extract(j.detail, '$.hostJob.v') = 1
         AND (j.status = 'queued' OR (j.status = 'running' AND (l.lease_expires_at IS NULL OR l.lease_expires_at <= $1)))
       ORDER BY j.created_at ASC`, [this.now().toISOString()])
    let failed = 0
    for (const row of rows) {
      if (row.id === this.activeId || (row.status === 'queued' && this.plans.has(row.id))) continue
      try { if (await this.failInterrupted(row.id)) failed++ } catch { /* left for the next recovery pass */ }
    }
    return { failed }
  }

  /** Resolves once nothing is queued or running in this process (or a foreign lease blocks it). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining
  }

  /** Stops new normal steps; an active step and its finalizer retain the lease until they finish. */
  close(): void {
    this.closed = true
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private async failInterrupted(id: string): Promise<boolean> {
    const job = await getDurableJob(this.db, id)
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return false
    const running = stepRecords(job).find(step => step.state === 'running')
    const error = job.status === 'queued' ? 'plan no longer available after agent restart'
      : running ? `the agent stopped while step ${running.id} was running; the host outcome is unknown` : 'the agent stopped while the job was running; the host outcome is unknown'
    const failureClass: JobFailureClass = job.status === 'queued' ? 'permanent' : 'unknown_outcome'
    if (job.status === 'running' && job.cancelRequested) {
      // Lease acquisition would settle a cancel-requested job as cancelled, which would hide the unknown outcome.
      await finishJob(this.db, id, { status: 'failed', error, detail: { ...job.detail, hostJobOutcome: failureClass } })
    } else {
      let lease: DurableJobRecord | null
      try { lease = await acquireJobLease(this.db, { jobId: id, workerId: this.leaseOwner, leaseDurationMs: this.leaseMs, now: this.now() }) }
      catch (caught) {
        // The repository settles exhausted or cancel-before-start jobs itself.
        if (isXpanelError(caught) && caught.code === 'PRECONDITION_FAILED') { await this.log(id, `${this.now().toISOString()} recovery: ${caught.message}\n`); return true }
        throw caught
      }
      if (!lease) return false
      await completeJobWithLease(this.db, { jobId: id, workerId: this.leaseOwner, fencingToken: lease.fencingToken, status: 'failed', error, failureClass, now: this.now() })
    }
    await this.log(id, `${this.now().toISOString()} recovery: ${error}\n`)
    return true
  }

  private kick(): void {
    if (this.closed || this.draining || this.retryTimer) return
    this.draining = this.drain().catch(() => this.retryLater(1_000)).finally(() => {
      this.draining = null
      if (this.queue.length > 0 && !this.retryTimer) this.kick()
    })
  }

  private retryLater(ms: number): void {
    if (this.closed) return
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.kick() }, ms)
    this.retryTimer.unref?.()
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.queue.length > 0) {
      await this.recoverInterrupted()
      const [blocker] = await this.db.query<{ lease_expires_at: string | null }>(
        `SELECT l.lease_expires_at FROM jobs j JOIN job_runtime_leases l ON l.job_id = j.id
         WHERE j.status = 'running' AND json_extract(j.detail, '$.hostJob.v') = 1 ORDER BY l.lease_expires_at ASC LIMIT 1`)
      if (blocker) {
        // Another runner still holds an unexpired lease; only one host job may run per host.
        this.retryLater(Math.min(60_000, Math.max(1_000, Date.parse(blocker.lease_expires_at ?? '') - this.now().getTime() + 100 || 1_000)))
        return
      }
      const id = this.queue[0]!
      this.activeId = id
      try { await this.execute(id) } catch { /* settled or left to recovery */ }
      finally { this.activeId = null; this.queue.shift(); this.plans.delete(id) }
    }
  }

  private async execute(id: string): Promise<void> {
    const entry = this.plans.get(id)
    const queued = await getDurableJob(this.db, id)
    if (!entry || !queued || queued.status !== 'queued') return
    let lease: DurableJobRecord | null
    try { lease = await acquireJobLease(this.db, { jobId: id, workerId: this.leaseOwner, leaseDurationMs: this.leaseMs, now: this.now() }) }
    catch (error) { await this.log(id, `${this.now().toISOString()} not started: ${isXpanelError(error) ? error.message : 'lease unavailable'}\n`); return }
    if (!lease) return
    const { plan, steps } = entry
    const token = lease.fencingToken
    const states: StepRecord[] = steps.map(step => ({ id: step.id, state: 'pending', exitCode: null }))
    const results: HostJobStepResult[] = []
    const leaseRef = { jobId: id, workerId: this.leaseOwner, fencingToken: token }
    const renew = () => renewJobLease(this.db, { ...leaseRef, leaseDurationMs: this.leaseMs, now: this.now() })
    const checkpoint = (step: string, progress: number, extra: Record<string, unknown> = {}) =>
      saveJobCheckpoint(this.db, { ...leaseRef, step, progress, data: { stepStates: states, ...extra }, now: this.now() })
    let changedHost = false
    let finalization: Promise<HostJobVerification> | null = null
    const finalize = (): Promise<HostJobVerification> => {
      finalization ??= (async () => {
        await renew()
        await checkpoint('finalize', Math.floor(states.filter(step => step.state === 'succeeded').length * 99 / steps.length))
        let accepting = true, busy = false, commands = 0, commandFailed = false
        const pending = new Set<Promise<HostJobCommandResult>>()
        const run: HostJobStepRun = candidate => {
          if (!accepting || busy || commands >= MAX_FINALIZER_COMMANDS) {
            commandFailed = true
            return Promise.reject(new Error('finalizer commands must run serially within the active callback'))
          }
          busy = true
          commands++
          const work = (async () => {
            try {
              const step = validateHostJobPlan({ ...plan, steps: [candidate] })[0]!
              if (!admits(plan.policy, step.argv)) return fail('FORBIDDEN', 'a finalizer step is outside its reviewed command grammar', { stateChanged: false })
              await renew()
              await this.log(id, `\n${this.now().toISOString()} finalizer step ${step.id}\n$ ${step.argv.join(' ')}\n`)
              await renew()
              if (!admits(plan.policy, step.argv)) return fail('FORBIDDEN', 'a finalizer step is outside its reviewed command grammar', { stateChanged: false })
              const result = await this.run(step.argv, { ...(step.env ? { env: step.env } : {}), timeoutMs: step.timeoutMs })
              await renew()
              const success = !result.timedOut && (result.ok || result.code !== null && step.successExitCodes?.includes(result.code) === true)
              if (!success) commandFailed = true
              await this.log(id, `[finalizer exit ${result.code ?? 'none'}${result.timedOut ? ', timed out' : ''}]\n`)
              return retainedResult(result)!
            } catch (error) { commandFailed = true; throw error }
            finally { busy = false }
          })()
          pending.add(work)
          void work.then(() => pending.delete(work), () => pending.delete(work))
          return work
        }
        let verification: HostJobVerification
        try { verification = boundedVerification(await plan.finalize!(run, Object.freeze([...results])), 'finalization') }
        catch { verification = { ok: false, detail: { error: 'finalization could not be completed' } } }
        finally {
          accepting = false
          // A callback cannot return success while an unawaited command is still changing the host.
          if (pending.size) commandFailed = true
          await Promise.allSettled([...pending])
        }
        await renew()
        if (commandFailed) verification = { ok: false, detail: { ...verification.detail, error: 'a finalizer command failed or violated the active command contract' } }
        await this.log(id, `${this.now().toISOString()} finalization ${verification.ok ? 'confirmed cleanup' : 'did not confirm cleanup'}\n`)
        return verification
      })()
      return finalization
    }
    const settle = async (outcome: Settlement): Promise<void> => {
      const fresh = await renew()
      if (outcome.status === 'succeeded' && fresh.cancelRequested) outcome = { ...outcome, status: 'cancelled', failureClass: null, error: null }
      if (outcome.status === 'succeeded' && this.closed) outcome = { ...outcome, status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'retryable', error: 'the agent stopped after the last step; the plan did not complete verification' }
      if (plan.finalize) {
        const cleanup = await finalize()
        const verification = outcome.verification ? boundedVerification({ ok: outcome.verification.ok && cleanup.ok, detail: { verification: outcome.verification.detail, finalization: cleanup.detail } }, 'combined verification') : cleanup
        outcome = cleanup.ok ? { ...outcome, verification }
          : { status: 'failed', failureClass: 'unknown_outcome', error: `${outcome.error ? `${outcome.error}; ` : ''}finalization did not confirm cleanup; the host outcome requires review`, verification }
      }
      await checkpoint('settle', Math.min(99, Math.floor(states.filter(step => step.state === 'succeeded').length * 100 / steps.length)), outcome.verification ? { verification: outcome.verification } : {})
      const settled = await renew()
      if (outcome.status === 'succeeded' && settled.cancelRequested) outcome = { ...outcome, status: 'cancelled', failureClass: null, error: null }
      if (outcome.status === 'succeeded' && this.closed) outcome = { ...outcome, status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'retryable', error: 'the agent stopped before settlement; the host outcome requires review' }
      await completeJobWithLease(this.db, { ...leaseRef, status: outcome.status, error: outcome.error, failureClass: outcome.failureClass, now: this.now() })
      await this.log(id, `${this.now().toISOString()} job ${outcome.status}${outcome.failureClass ? ` (${outcome.failureClass})` : ''}${outcome.error ? `: ${outcome.error}` : ''}\n`)
    }
    const heartbeat = setInterval(() => { void renewJobLease(this.db, { ...leaseRef, leaseDurationMs: this.leaseMs, now: this.now() }).catch(() => undefined) }, Math.max(20, Math.floor(this.leaseMs / 3)))
    heartbeat.unref?.()
    this.heartbeats.add(heartbeat)
    try {
      await this.log(id, `${this.now().toISOString()} started (attempt ${lease.attempt})\n`)
      for (const [index, step] of steps.entries()) {
        const fresh = await getDurableJob(this.db, id)
        if (!fresh || fresh.status !== 'running' || fresh.fencingToken !== token) throw new Error('lease_lost')
        if (fresh.cancelRequested) return await settle({ status: 'cancelled', failureClass: null, error: null })
        if (this.closed) return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'retryable', error: `the agent stopped before step ${step.id}; earlier steps completed and later steps did not run` })
        if (!admits(plan.policy, step.argv)) {
          states[index] = { id: step.id, state: 'failed', exitCode: null }
          return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'permanent', error: `step ${step.id} was refused by its command policy before execution` })
        }
        // Persist execution intent before the last fresh authority check. No log or checkpoint
        // may delay execution after that check; the following renewal only fences its lease.
        states[index] = { id: step.id, state: 'running', exitCode: null }
        await checkpoint(`${step.id}:running`, Math.floor(index * 100 / steps.length))
        await this.log(id, `\n${this.now().toISOString()} step ${index + 1}/${steps.length} ${step.id}${step.mutates ? ' (changes the host)' : ''}\n$ ${step.argv.join(' ')}\n`)
        await renew()
        try { await plan.beforeStep?.(step) }
        catch {
          states[index] = { id: step.id, state: 'failed', exitCode: null }
          return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'permanent', error: `step ${step.id} failed fresh authorization before execution${changedHost ? '; earlier host changes require review' : ''}` })
        }
        const authorized = await renew()
        if (authorized.cancelRequested) {
          states[index] = { id: step.id, state: 'pending', exitCode: null }
          return await settle({ status: 'cancelled', failureClass: null, error: null })
        }
        if (this.closed) {
          states[index] = { id: step.id, state: 'pending', exitCode: null }
          return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'retryable', error: `the agent stopped before step ${step.id}; later steps did not run` })
        }
        if (!admits(plan.policy, step.argv)) {
          states[index] = { id: step.id, state: 'failed', exitCode: null }
          return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'permanent', error: `step ${step.id} was refused by its command policy before execution` })
        }
        let result: HostJobCommandResult | null = null
        try { result = await this.run(step.argv, { ...(step.env ? { env: step.env } : {}), timeoutMs: step.timeoutMs }) } catch { result = null }
        results.push(Object.freeze({ id: step.id, result: retainedResult(result) }))
        if (result) await this.log(id, `${result.stdout}${result.stdout && !result.stdout.endsWith('\n') ? '\n' : ''}${result.stderr ? `[stderr]\n${result.stderr}${result.stderr.endsWith('\n') ? '' : '\n'}` : ''}[exit ${result.code ?? 'none'}${result.timedOut ? ', timed out' : ''}]\n`)
        else await this.log(id, '[the step could not be run]\n')
        const exitCode = result && Number.isSafeInteger(result.code) ? result.code : null
        if (result && !result.timedOut && (result.ok || exitCode !== null && step.successExitCodes?.includes(exitCode) === true)) {
          states[index] = { id: step.id, state: 'succeeded', exitCode }
          changedHost ||= step.mutates
          await checkpoint(step.id, Math.floor((index + 1) * 100 / steps.length))
          continue
        }
        const reason = !result ? 'could not be run' : result.timedOut ? `timed out after ${step.timeoutMs} ms` : `exited with code ${result.code ?? 'none'}`
        if (step.mutates) {
          states[index] = { id: step.id, state: 'unknown', exitCode }
          return await settle({ status: 'failed', failureClass: 'unknown_outcome', error: `step ${step.id} ${reason} while changing the host; the outcome is unknown` })
        }
        states[index] = { id: step.id, state: 'failed', exitCode }
        const retryable = !!result && !result.timedOut && LOCK_CONTENTION_RE.test(`${result.stderr}\n${result.stdout}`)
        return await settle({ status: 'failed', failureClass: changedHost ? 'unknown_outcome' : retryable ? 'retryable' : 'permanent', error: `step ${step.id} ${reason}${retryable ? '; another package process held the lock' : ''}${changedHost ? '; earlier host changes require review' : ''}` })
      }
      const completed = await renew()
      if (completed.cancelRequested) return await settle({ status: 'cancelled', failureClass: null, error: null })
      if (this.closed || !plan.verify) return await settle({ status: 'succeeded', failureClass: null, error: null })
      let verification: HostJobVerification
      try {
        verification = boundedVerification(await plan.verify(this.run), 'verification')
      } catch { verification = { ok: false, detail: { error: 'verification could not be completed' } } }
      await this.log(id, `${this.now().toISOString()} verification ${verification.ok ? 'confirmed the expected host state' : 'did not confirm the expected host state'}\n`)
      return await settle(verification.ok ? { status: 'succeeded', failureClass: null, error: null, verification }
        : { status: 'failed', failureClass: changedHost ? 'unknown_outcome' : 'permanent', error: 'host verification did not confirm the expected result', verification })
    } catch {
      for (const step of states) if (step.state === 'running') step.state = 'unknown'
      // If the lease is gone, startup or pre-run recovery settles the job as an unknown outcome.
      await settle({ status: 'failed', failureClass: 'unknown_outcome', error: 'job bookkeeping failed while the plan was running; the host outcome is unknown' }).catch(() => undefined)
    } finally {
      clearInterval(heartbeat)
      this.heartbeats.delete(heartbeat)
    }
  }

  private view(job: DurableJobRecord, logBytes = 0): HostJobView {
    const terminal = job.status !== 'queued' && job.status !== 'running'
    const records = stepRecords(job)
    const summary = (job.detail.hostJob as Record<string, unknown> | undefined)?.summary
    const outcome = job.detail.hostJobOutcome
    return {
      id: job.id, referenceCode: job.referenceCode, kind: job.kind, status: job.status, progress: job.progress,
      summary: safeText(summary, 1, 512) ? summary : job.summary,
      accountId: job.accountId, actor: job.actor, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      steps: (storedSteps(job) ?? []).map(step => {
        const record = records.find(item => item.id === step.id)
        const state = record?.state ?? 'pending'
        // A settled job never runs its remaining steps; an interrupted running step has no known result.
        return { id: step.id, title: step.title, ...(step.titleValues ? { titleValues: step.titleValues } : {}), exitCode: record?.exitCode ?? null, state: terminal && state === 'pending' ? 'skipped' : terminal && state === 'running' ? 'unknown' : state }
      }),
      error: job.error,
      failureClass: job.failureClass ?? (outcome === 'unknown_outcome' || outcome === 'permanent' ? outcome : null),
      cancelRequested: job.cancelRequested,
      verification: verificationOf(job.checkpointData.verification),
      logBytes,
    }
  }

  private logPath(id: string): string {
    if (!HOST_JOB_ID_RE.test(id)) return fail('VALIDATION', 'a job id is required', { stateChanged: false })
    return join(this.logDir, `${id}.log`)
  }

  private ensureLogDir(): Promise<void> {
    this.logDirReady ??= (async () => {
      await mkdir(this.logDir, { recursive: true, mode: 0o700 })
      const metadata = await lstat(this.logDir)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail('PRECONDITION_FAILED', 'the host job log directory is not a private directory', { stateChanged: false })
      await chmod(this.logDir, 0o700)
    })().catch(error => { this.logDirReady = null; throw error })
    return this.logDirReady
  }

  private async createLog(id: string): Promise<void> {
    try {
      await this.ensureLogDir()
      const handle = await open(this.logPath(id), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      await handle.close()
    } catch { return fail('PRECONDITION_FAILED', 'the host job log could not be created', { stateChanged: false }) }
  }

  private async logSize(id: string): Promise<number> {
    try { const metadata = await lstat(this.logPath(id)); return metadata.isFile() ? metadata.size : 0 } catch { return 0 }
  }

  /** Appends within the 4 MiB cap; the last bytes become a truncation marker. Log failures never change a job outcome. */
  private log(id: string, text: string): Promise<void> {
    const write = this.logWrites.then(async () => {
      const handle = await open(this.logPath(id), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW)
      try {
        const metadata = await handle.stat()
        if (!metadata.isFile()) return
        const bytes = Buffer.from(redactInlineSecrets(text), 'utf8')
        const room = HOST_JOB_LOG_CAP_BYTES - LOG_MARKER.length - metadata.size
        if (room < 0) return
        await handle.write(bytes.length <= room ? bytes : Buffer.concat([bytes.subarray(0, room), LOG_MARKER]))
      } finally { await handle.close() }
    }).catch(() => undefined)
    this.logWrites = write
    return write
  }
}

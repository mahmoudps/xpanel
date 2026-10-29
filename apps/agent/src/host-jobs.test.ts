import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestDb, enqueueDurableJob, getDurableJob } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import type { HostJobCommandResult, HostJobCommandStep, HostJobPlan, HostJobRun, HostJobStepResult, HostJobStepRun } from './host-job-contract.ts'
import { HOST_JOB_LOG_CAP_BYTES, HostJobRunner, validateHostJobPlan } from './host-jobs.ts'

const handles: TestDbHandle[] = []
const dirs: string[] = []
const runners: HostJobRunner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.close()
  await Promise.all(handles.splice(0).map(handle => handle.close()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const ok = (stdout = ''): HostJobCommandResult => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false })
const failed = (code: number, stderr = ''): HostJobCommandResult => ({ ok: false, code, stdout: '', stderr, timedOut: false })
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const until = async (check: () => Promise<boolean> | boolean): Promise<void> => {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)) }
  throw new Error('condition not reached')
}

const setup = async (run: HostJobRun, options: { now?: () => Date; leaseMs?: number } = {}) => {
  const handle = handles.at(-1) ?? await createTestDb()
  if (!handles.includes(handle)) handles.push(handle)
  const logDir = dirs.at(-1) ?? await mkdtemp(join(tmpdir(), 'xpanel-host-jobs-'))
  if (!dirs.includes(logDir)) dirs.push(logDir)
  const runner = new HostJobRunner({ db: handle.db, run, logDir, ...options })
  runners.push(runner)
  return { runner, db: handle.db, logDir }
}

const plan = (overrides: Partial<HostJobPlan> = {}): HostJobPlan => ({
  kind: 'system.packages.upgrade', summary: 'Upgrade 2 packages', accountId: null,
  fingerprint: { revision: 'r1' }, detail: { packages: ['a', 'b'] },
  steps: [
    { id: 'refresh', title: 'Refresh package lists', argv: ['/usr/bin/apt-get', 'update'], timeoutMs: 1000, mutates: false },
    { id: 'upgrade', title: 'Install {count} upgrades', titleValues: { count: '2' }, argv: ['/usr/bin/apt-get', 'install', '-y', 'a', 'b'], env: { DEBIAN_FRONTEND: 'noninteractive' }, timeoutMs: 1000, mutates: true },
  ],
  policy: argv => argv[0] === '/usr/bin/apt-get',
  ...overrides,
})

describe('host job plan admission', () => {
  it('rejects plans outside the contract before anything is stored', () => {
    expect(() => validateHostJobPlan(plan({ kind: 'Bad Kind' }))).toThrow(/kind/)
    expect(() => validateHostJobPlan(plan({ steps: [] }))).toThrow(/1..32/)
    expect(() => validateHostJobPlan(plan({ steps: Array.from({ length: 33 }, (_, i) => ({ ...plan().steps[0]!, id: `s${i}` })) }))).toThrow(/1..32/)
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, argv: ['apt-get'] }] }))).toThrow(/absolute/)
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, env: { HOME: '/root' } as never }] }))).toThrow(/environment/)
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, timeoutMs: 3_600_001 }] }))).toThrow(/timeout/)
    expect(() => validateHostJobPlan(plan({ steps: [plan().steps[0]!, plan().steps[0]!] }))).toThrow(/unique/)
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, title: '' }] }))).toThrow(/title/)
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, titleValues: { 'bad name': 'x' } }] }))).toThrow(/title values/)
    expect(() => validateHostJobPlan(plan({ summary: 'a\u202eb' }))).toThrow(/summary/)
    for (const name of ['beforeStep', 'verify', 'finalize'] as const) expect(() => validateHostJobPlan(plan({ [name]: true } as never))).toThrow(name)
  })

  it('refuses a step outside the policy grammar and enqueues nothing', async () => {
    const calls: string[][] = []
    const { runner } = await setup(async argv => { calls.push([...argv]); return ok() })
    await expect(runner.submit(plan({ policy: argv => argv[1] === 'update' }), 'root')).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await runner.list()).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('host job runner state machine', () => {
  it('runs steps serially, verifies, persists per-step state and writes the log', async () => {
    const calls: { argv: string[]; env: unknown }[] = []
    let active = 0, peak = 0
    const { runner } = await setup(async (argv, options) => {
      active++; peak = Math.max(peak, active); calls.push({ argv: [...argv], env: options?.env })
      await new Promise(r => setTimeout(r, 5)); active--
      return ok(`ran ${argv[1]}\n`)
    })
    const verified = { ok: true, detail: { upgradable: 0 } }
    const first = await runner.submit(plan({ verify: async () => verified }), 'root')
    const second = await runner.submit(plan({ fingerprint: { revision: 'r2' } }), 'root')
    expect(first.deduplicated).toBe(false)
    const issuedReference = (await getDurableJob(handles[0]!.db, first.job.id))!.referenceCode
    expect(issuedReference).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    expect(first.job.referenceCode).toBe(issuedReference)
    expect(first.job).toMatchObject({ status: 'queued', progress: 0, actor: 'root', steps: [{ id: 'refresh', state: 'pending' }, { id: 'upgrade', state: 'pending' }] })
    await runner.idle()
    expect(peak).toBe(1)
    expect(calls.map(call => call.argv[1])).toEqual(['update', 'install', 'update', 'install'])
    expect(calls[1]!.env).toEqual({ DEBIAN_FRONTEND: 'noninteractive' })
    const done = (await runner.get(first.job.id))!
    expect(done).toMatchObject({ status: 'succeeded', progress: 100, failureClass: null, error: null, verification: verified,
      steps: [{ id: 'refresh', state: 'succeeded', exitCode: 0, title: 'Refresh package lists' }, { id: 'upgrade', state: 'succeeded', exitCode: 0, title: 'Install {count} upgrades', titleValues: { count: '2' } }] })
    expect(done.logBytes).toBeGreaterThan(0)
    expect(done.referenceCode).toBe(issuedReference)
    expect((await runner.get(second.job.id))!.status).toBe('succeeded')
    const log = await runner.readLog(first.job.id)
    expect(log.text).toContain('$ /usr/bin/apt-get install -y a b')
    expect(log.text).toContain('ran install')
    expect(log.text).toContain('verification confirmed')
    expect(log).toMatchObject({ available: true, offset: 0, nextOffset: log.total, truncated: false })
    expect((await runner.list({ kindPrefix: 'system.packages', status: 'succeeded' })).map(job => job.id).sort()).toEqual([first.job.id, second.job.id].sort())
    expect(await runner.list({ kindPrefix: 'system.repair' })).toEqual([])
  })

  it('returns the unfinished job for a repeated request instead of queuing it twice', async () => {
    const gate = deferred<HostJobCommandResult>()
    const { runner } = await setup(async () => gate.promise)
    const first = await runner.submit(plan(), 'root')
    const again = await runner.submit(plan(), 'admin2')
    expect(again).toMatchObject({ deduplicated: true, job: { id: first.job.id, actor: 'root' } })
    gate.resolve(ok())
    await runner.idle()
    expect((await runner.submit(plan(), 'root')).deduplicated).toBe(false)
    await runner.idle()
  })

  it('preserves an unissued null reference without allocating or substituting its internal id on reads', async () => {
    const { runner, db } = await setup(async () => ok())
    const { job } = await runner.submit(plan(), 'root')
    await runner.idle()
    await db.query('UPDATE official_reference_ledger SET tombstoned_at = $1 WHERE entity_id = $2', ['2026-10-27T10:00:00.000Z', job.id])
    const before = await db.query('SELECT * FROM official_reference_ledger WHERE entity_id = $1', [job.id])
    expect((await runner.get(job.id))!.referenceCode).toBeNull()
    expect((await runner.list())[0]!.referenceCode).toBeNull()
    expect(await db.query('SELECT * FROM official_reference_ledger WHERE entity_id = $1', [job.id])).toEqual(before)
  })

  it('re-checks the policy immediately before each step', async () => {
    let allow = true
    const calls: string[][] = []
    const { runner } = await setup(async argv => { calls.push([...argv]); allow = false; return ok() })
    const { job } = await runner.submit(plan({ policy: () => allow }), 'root')
    await runner.idle()
    expect(calls).toHaveLength(1)
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'permanent', error: 'step upgrade was refused by its command policy before execution',
      steps: [{ state: 'succeeded' }, { state: 'failed', exitCode: null }] })
  })

  it('treats only a documented success exit code as completion and keeps the exit code', async () => {
    expect(() => validateHostJobPlan(plan({ steps: [{ ...plan().steps[0]!, successExitCodes: [0] }] }))).toThrow(/success exit codes/)
    const scan = { id: 'scan', title: 'Scan', argv: ['/usr/bin/apt-get', 'check'], timeoutMs: 1000, mutates: false }
    const { runner } = await setup(async () => failed(1, 'findings'))
    const done = await runner.submit(plan({ fingerprint: { revision: 'exit-1' }, steps: [{ ...scan, successExitCodes: [1] }] }), 'root')
    await until(async () => (await runner.get(done.job.id))?.status === 'succeeded')
    expect((await runner.get(done.job.id))!.steps[0]).toMatchObject({ state: 'succeeded', exitCode: 1 })
    const refused = await runner.submit(plan({ fingerprint: { revision: 'exit-2' }, steps: [{ ...scan, successExitCodes: [2] }] }), 'root')
    await until(async () => (await runner.get(refused.job.id))?.status === 'failed')
  })

  it('honours cancellation between steps without interrupting the running step', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return argv[1] === 'update' ? gate.promise : ok() })
    const { job } = await runner.submit(plan(), 'root')
    await until(() => calls.length === 1)
    const requested = await runner.cancel(job.id, 'root')
    expect(requested).toMatchObject({ status: 'running', cancelRequested: true })
    gate.resolve(ok())
    await runner.idle()
    expect(calls).toEqual(['update'])
    expect(await runner.get(job.id)).toMatchObject({ status: 'cancelled', failureClass: null, steps: [{ state: 'succeeded' }, { state: 'skipped' }] })
    await expect(runner.cancel(job.id, 'root')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await runner.readLog(job.id)).text).toContain('cancellation requested by root')
  })

  it('cancels a queued job before it starts and runs the authority callback first', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return calls.length === 1 ? gate.promise : ok() })
    await runner.submit(plan(), 'root')
    const { job: queued } = await runner.submit(plan({ fingerprint: { revision: 'r2' } }), 'root')
    await until(() => calls.length === 1)
    const order: string[] = []
    await expect(runner.cancel(queued.id, 'root', async () => { order.push('authority'); throw new Error('authority changed') })).rejects.toThrow('authority changed')
    expect((await runner.get(queued.id))!.status).toBe('queued')
    const cancelled = await runner.cancel(queued.id, 'root', async () => { order.push('authority') })
    expect(order).toEqual(['authority', 'authority'])
    expect(cancelled).toMatchObject({ status: 'cancelled', steps: [{ state: 'skipped' }, { state: 'skipped' }] })
    gate.resolve(ok())
    await runner.idle()
    expect(calls).toEqual(['update', 'install'])
  })

  it('classifies a failed or timed-out mutating step as an unknown outcome', async () => {
    const { runner } = await setup(async argv => argv[1] === 'install' ? failed(100, 'E: dpkg was interrupted') : ok())
    const { job } = await runner.submit(plan({ steps: [...plan().steps, { id: 'cleanup', title: 'Clean up', argv: ['/usr/bin/apt-get', 'clean'], timeoutMs: 1000, mutates: true }] }), 'root')
    await runner.idle()
    const view = (await runner.get(job.id))!
    expect(view).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', steps: [{ state: 'succeeded' }, { state: 'unknown', exitCode: 100 }, { state: 'skipped' }] })
    expect(view.error).toContain('the outcome is unknown')
    expect((await getDurableJob(handles[0]!.db, job.id))!.needsAttention).toBe(true)

    const timeout = await setup(async argv => argv[1] === 'install' ? { ok: false, code: null, stdout: '', stderr: '', timedOut: true } : ok())
    const timed = await timeout.runner.submit(plan({ fingerprint: { revision: 't' } }), 'root')
    await timeout.runner.idle()
    expect(await timeout.runner.get(timed.job.id)).toMatchObject({ failureClass: 'unknown_outcome', steps: [{ state: 'succeeded' }, { state: 'unknown', exitCode: null }] })
    const thrown = await setup(async argv => { if (argv[1] === 'install') throw new Error('spawn failed'); return ok() })
    const exploded = await thrown.runner.submit(plan({ fingerprint: { revision: 'x' } }), 'root')
    await thrown.runner.idle()
    expect(await thrown.runner.get(exploded.job.id)).toMatchObject({ failureClass: 'unknown_outcome', steps: [{ state: 'succeeded' }, { state: 'unknown' }] })
  })

  it('classifies read-only failures as retryable only for package lock contention', async () => {
    const lock = await setup(async () => failed(100, 'E: Could not get lock /var/lib/dpkg/lock-frontend'))
    const locked = await lock.runner.submit(plan(), 'root')
    await lock.runner.idle()
    expect(await lock.runner.get(locked.job.id)).toMatchObject({ status: 'failed', failureClass: 'retryable', steps: [{ state: 'failed', exitCode: 100 }, { state: 'skipped' }] })
    const other = await setup(async () => failed(1, 'E: Unable to locate package'))
    const permanent = await other.runner.submit(plan({ fingerprint: { revision: 'p' } }), 'root')
    await other.runner.idle()
    expect(await other.runner.get(permanent.job.id)).toMatchObject({ status: 'failed', failureClass: 'permanent' })
  })

  it('fails a job whose verification does not confirm the host state', async () => {
    const { runner } = await setup(async () => ok())
    const { job } = await runner.submit(plan({ verify: async () => ({ ok: false, detail: { stillUpgradable: ['a'] } }) }), 'root')
    await runner.idle()
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', error: 'host verification did not confirm the expected result',
      verification: { ok: false, detail: { stillUpgradable: ['a'] } }, steps: [{ state: 'succeeded' }, { state: 'succeeded' }] })
    const readOnly = await runner.submit(plan({ fingerprint: { revision: 'ro' }, steps: [plan().steps[0]!], verify: async () => { throw new Error('probe failed') } }), 'root')
    await runner.idle()
    expect(await runner.get(readOnly.job.id)).toMatchObject({ status: 'failed', failureClass: 'permanent', verification: { ok: false, detail: { error: 'verification could not be completed' } } })
  })

  it('recovers interrupted and plan-less jobs truthfully after a restart', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    const before = await setup(async argv => { calls.push(argv[1]!); return argv[1] === 'install' ? gate.promise : ok() })
    const { job: interrupted } = await before.runner.submit(plan(), 'root')
    const { job: waiting } = await before.runner.submit(plan({ fingerprint: { revision: 'r2' } }), 'root')
    await until(() => calls.includes('install'))
    before.runner.close()
    const later = new Date(Date.now() + 3_600_000)
    const after = await setup(async () => ok(), { now: () => later })
    expect(await after.runner.recoverInterrupted()).toEqual({ failed: 2 })
    expect(await after.runner.get(interrupted.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome',
      error: 'the agent stopped while step upgrade was running; the host outcome is unknown', steps: [{ state: 'succeeded' }, { state: 'unknown' }] })
    expect(await after.runner.get(waiting.id)).toMatchObject({ status: 'failed', failureClass: 'permanent', error: 'plan no longer available after agent restart', steps: [{ state: 'skipped' }, { state: 'skipped' }] })
    gate.resolve(ok())
    await before.runner.idle()
    expect((await after.runner.get(interrupted.id))!.status).toBe('failed')
    expect(calls).toEqual(['update', 'install'])
    expect(await after.runner.recoverInterrupted()).toEqual({ failed: 0 })
  })

  it('keeps an interrupted cancel-requested job as an unknown outcome, not a clean cancellation', async () => {
    const gate = deferred<HostJobCommandResult>(), entered = deferred<void>()
    const before = await setup(async argv => {
      if (argv[1] !== 'install') return ok()
      entered.resolve(); return gate.promise
    })
    const { job } = await before.runner.submit(plan(), 'root')
    // Running is durable execution intent; interruption here must follow the actual effect attempt.
    await entered.promise
    await before.runner.cancel(job.id, 'root')
    before.runner.close()
    const later = new Date(Date.now() + 3_600_000)
    const after = await setup(async () => ok(), { now: () => later })
    await after.runner.recoverInterrupted()
    expect(await after.runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', cancelRequested: true, steps: [{ state: 'succeeded' }, { state: 'unknown' }] })
    gate.resolve(ok())
    await before.runner.idle()
  })

  it('ignores jobs that are not host jobs', async () => {
    const { runner, db } = await setup(async () => ok())
    const other = await enqueueDurableJob(db, { kind: 'backup.create', actor: 'root', summary: 'Backup' })
    expect(await runner.get(other.id)).toBeNull()
    expect(await runner.list()).toEqual([])
    await expect(runner.cancel(other.id, 'root')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runner.readLog(other.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(await runner.recoverInterrupted()).toEqual({ failed: 0 })
    expect((await getDurableJob(db, other.id))!.status).toBe('queued')
  })
})

describe('host job lifecycle callbacks', () => {
  const cleanup: HostJobCommandStep = { id: 'cleanup', title: 'Clean up', argv: ['/usr/bin/apt-get', 'clean'], timeoutMs: 1000, mutates: true }

  it.each([false, true])('refuses revoked authority before the next effect (prior mutation: %s)', async mutates => {
    const calls: string[] = [], checked: string[] = []
    let allowed = true
    const { runner } = await setup(async argv => { calls.push(argv[1]!); allowed = false; return ok() })
    const { job } = await runner.submit(plan({ steps: [{ ...plan().steps[0]!, mutates }, plan().steps[1]!], beforeStep: async step => {
      checked.push(step.id)
      if (!allowed) throw new Error('credentials revoked')
    } }), 'root')
    await runner.idle()
    expect(calls).toEqual(['update'])
    expect(checked).toEqual(['refresh', 'upgrade'])
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: mutates ? 'unknown_outcome' : 'permanent', steps: [{ state: 'succeeded' }, { state: 'failed', exitCode: null }] })
  })

  it('persists execution intent, awaits authority and notices cancellation before execution', async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const calls: string[] = []
    let finalized = 0
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const { job } = await runner.submit(plan({ beforeStep: async () => { entered.resolve(); await gate.promise }, finalize: async (_run, results) => {
      finalized++; expect(results).toEqual([]); return { ok: true, detail: {} }
    } }), 'root')
    await entered.promise
    expect((await runner.get(job.id))!.steps[0]!.state).toBe('running')
    await runner.cancel(job.id, 'root')
    gate.resolve()
    await runner.idle()
    expect(calls).toEqual([])
    expect(finalized).toBe(1)
    expect((await runner.get(job.id))!.status).toBe('cancelled')
  })

  it('checks fresh authority after awaited execution preparation before starting any effect', async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const calls: string[] = [], checked: string[] = []
    let allowed = true, finalized = 0
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const originalLog = Reflect.get(runner, 'log').bind(runner) as (id: string, text: string) => Promise<void>
    Reflect.set(runner, 'log', async (id: string, text: string) => {
      if (text.includes(' step 1/')) { entered.resolve(); await gate.promise }
      await originalLog(id, text)
    })
    const { job } = await runner.submit(plan({ beforeStep: async step => {
      checked.push(step.id)
      if (!allowed) throw new Error('credentials revoked during preparation')
    }, finalize: async (_run, results) => {
      finalized++; expect(results).toEqual([]); return { ok: true, detail: {} }
    } }), 'root')
    await entered.promise
    allowed = false
    gate.resolve()
    await runner.idle()
    expect(checked).toEqual(['refresh'])
    expect(calls).toEqual([])
    expect(finalized).toBe(1)
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'permanent', steps: [{ state: 'failed' }, { state: 'skipped' }] })
  })

  it.each(['cancel', 'close'] as const)('honours %s arriving during finalization before success is settled', async mode => {
    const gate = deferred<void>(), entered = deferred<void>()
    let finalized = 0
    const { runner } = await setup(async () => ok())
    const { job } = await runner.submit(plan({ finalize: async () => {
      finalized++; entered.resolve(); await gate.promise; return { ok: true, detail: {} }
    } }), 'root')
    await entered.promise
    if (mode === 'cancel') await runner.cancel(job.id, 'root')
    else runner.close()
    gate.resolve()
    await runner.idle()
    expect(finalized).toBe(1)
    expect(await runner.get(job.id)).toMatchObject({ status: mode === 'cancel' ? 'cancelled' : 'failed', failureClass: mode === 'cancel' ? null : 'unknown_outcome' })
  })

  it('rechecks finalizer command policy after awaited logging before cleanup effects', async () => {
    const calls: string[] = []
    let allowed = true
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const originalLog = Reflect.get(runner, 'log').bind(runner) as (id: string, text: string) => Promise<void>
    Reflect.set(runner, 'log', async (id: string, text: string) => {
      if (text.includes('finalizer step cleanup')) allowed = false
      await originalLog(id, text)
    })
    const { job } = await runner.submit(plan({ policy: () => allowed, finalize: async run => {
      await run(cleanup); return { ok: true, detail: {} }
    } }), 'root')
    await runner.idle()
    expect(calls).toEqual(['update', 'install'])
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', verification: { ok: false } })
  })

  it.each(['failure', 'timeout', 'throw'] as const)('runs cleanup once after a command %s without promoting failure', async mode => {
    const calls: string[] = []
    let finalized = 0
    const bad = mode === 'timeout' ? { ...failed(1), code: null, timedOut: true } : failed(1)
    const { runner } = await setup(async argv => {
      calls.push(argv[1]!)
      if (argv[1] === 'clean') return ok()
      if (mode === 'throw') throw new Error('spawn failed')
      return bad
    })
    const { job } = await runner.submit(plan({ finalize: async (run, results) => {
      finalized++
      expect(results).toEqual([{ id: 'refresh', result: mode === 'throw' ? null : bad }])
      await run(cleanup)
      return { ok: true, detail: { cleaned: true } }
    } }), 'root')
    await runner.idle()
    expect(calls).toEqual(['update', 'clean'])
    expect(finalized).toBe(1)
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'permanent', verification: { ok: true, detail: { cleaned: true } } })
  })

  it('retains unknown mutation outcomes after successful cleanup', async () => {
    let finalized = 0
    const { runner } = await setup(async argv => argv[1] === 'install' ? failed(2) : ok())
    const { job } = await runner.submit(plan({ finalize: async run => { finalized++; await run(cleanup); return { ok: true, detail: {} } } }), 'root')
    await runner.idle()
    expect(finalized).toBe(1)
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', steps: [{ state: 'succeeded' }, { state: 'unknown' }] })
  })

  it('provides immutable bounded ordered results and keeps verification before finalization', async () => {
    const order: string[] = []
    let rows: readonly HostJobStepResult[] = []
    const { runner } = await setup(async argv => { order.push(argv[1]!); return { ...ok('x'.repeat(70_000)), extra: { unbounded: 'x'.repeat(70_000) } } })
    const { job } = await runner.submit(plan({ verify: async () => { order.push('verify'); return { ok: true, detail: { observed: true } } }, finalize: async (run, results) => {
      order.push('finalize'); rows = results; await run(cleanup); return { ok: true, detail: { cleaned: true } }
    } }), 'root')
    await runner.idle()
    expect(order).toEqual(['update', 'install', 'verify', 'finalize', 'clean'])
    expect(rows.map(row => row.id)).toEqual(['refresh', 'upgrade'])
    expect(Object.isFrozen(rows) && rows.every(row => Object.isFrozen(row) && Object.isFrozen(row.result))).toBe(true)
    expect(rows.every(row => Object.keys(row.result!).sort().join(',') === 'code,ok,stderr,stdout,timedOut')).toBe(true)
    expect(rows.every(row => Buffer.byteLength(row.result!.stdout) === 65_536)).toBe(true)
    expect(await runner.get(job.id)).toMatchObject({ status: 'succeeded', verification: { ok: true, detail: { verification: { observed: true }, finalization: { cleaned: true } } } })
  })

  it('cleans up cancellation during the last step without running verification', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    let finalized = 0, verified = 0
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return argv[1] === 'update' ? gate.promise : ok() })
    const { job } = await runner.submit(plan({ steps: [plan().steps[0]!], verify: async () => { verified++; return { ok: true, detail: {} } }, finalize: async (run, results) => {
      finalized++; expect(results).toHaveLength(1); await run(cleanup); return { ok: true, detail: {} }
    } }), 'root')
    await until(() => calls.length === 1)
    await runner.cancel(job.id, 'root')
    gate.resolve(ok())
    await runner.idle()
    expect(calls).toEqual(['update', 'clean'])
    expect(finalized).toBe(1)
    expect(verified).toBe(0)
    expect((await runner.get(job.id))!.status).toBe('cancelled')
  })

  it('does not invoke callbacks for a queued job cancelled before it starts', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    let finalized = 0
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return calls.length === 1 ? gate.promise : ok() })
    await runner.submit(plan(), 'root')
    const { job } = await runner.submit(plan({ fingerprint: { revision: 'unstarted' }, beforeStep: async () => { throw new Error('must not run') }, finalize: async () => { finalized++; return { ok: true, detail: {} } } }), 'root')
    await until(() => calls.length === 1)
    await runner.cancel(job.id, 'root')
    gate.resolve(ok())
    await runner.idle()
    expect(finalized).toBe(0)
    expect((await runner.get(job.id))!.status).toBe('cancelled')
  })

  it.each([
    { ...cleanup, argv: ['/bin/sh', '-c', 'echo unsafe'] },
    { ...cleanup, timeoutMs: 3_600_001 },
    { ...cleanup, env: { HOME: '/root' } as never },
  ])('rejects unsafe finalizer commands before execution even if the callback catches rejection: %j', async unsafe => {
    const calls: string[] = []
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const { job } = await runner.submit(plan({ finalize: async run => {
      await expect(run(unsafe)).rejects.toBeDefined()
      return { ok: true, detail: {} }
    } }), 'root')
    await runner.idle()
    expect(calls).toEqual(['update', 'install'])
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', verification: { ok: false } })
  })

  it.each(['failure', 'timeout', 'throw', 'unverified'] as const)('fails with an unknown outcome when cleanup is %s', async mode => {
    let finalized = 0
    const { runner } = await setup(async argv => {
      if (argv[1] !== 'clean') return ok()
      if (mode === 'throw') throw new Error('cleanup unavailable')
      return mode === 'timeout' ? { ...failed(1), code: null, timedOut: true } : failed(1)
    })
    const { job } = await runner.submit(plan({ finalize: async run => {
      finalized++
      if (mode !== 'unverified') await run(cleanup)
      return { ok: mode !== 'unverified', detail: {} }
    } }), 'root')
    await runner.idle()
    expect(finalized).toBe(1)
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', verification: { ok: false } })
  })

  it('rejects commands saved for after the callback and job have settled', async () => {
    let late: HostJobStepRun | undefined
    const calls: string[] = []
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const { job } = await runner.submit(plan({ finalize: async run => { late = run; return { ok: true, detail: {} } } }), 'root')
    await runner.idle()
    await expect(late!(cleanup)).rejects.toThrow(/active callback/)
    expect(calls).toEqual(['update', 'install'])
    expect((await runner.get(job.id))!.status).toBe('succeeded')
  })

  it('waits for unawaited cleanup before failing the callback contract', async () => {
    const gate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    const { runner } = await setup(async argv => { calls.push(argv[1]!); return argv[1] === 'clean' ? gate.promise : ok() })
    const { job } = await runner.submit(plan({ finalize: async run => { void run(cleanup); return { ok: true, detail: {} } } }), 'root')
    await until(() => calls.includes('clean'))
    expect((await runner.get(job.id))!.status).toBe('running')
    gate.resolve(ok())
    await runner.idle()
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome' })
  })

  it('keeps the active lease alive through close and cleanup while leaving queued work unstarted', async () => {
    let clock = Date.now()
    const stepGate = deferred<HostJobCommandResult>(), cleanupGate = deferred<HostJobCommandResult>()
    const calls: string[] = []
    const { runner, db } = await setup(async argv => { calls.push(argv[1]!); return argv[1] === 'clean' ? cleanupGate.promise : stepGate.promise }, { now: () => new Date(clock), leaseMs: 500 })
    const { job } = await runner.submit(plan({ finalize: async run => { await run(cleanup); return { ok: true, detail: {} } } }), 'root')
    const queued = await runner.submit(plan({ fingerprint: { revision: 'closed-queue' }, finalize: async () => { throw new Error('unstarted cleanup') } }), 'root')
    await until(() => calls.length === 1)
    runner.close()
    clock += 200
    await until(async () => (await getDurableJob(db, job.id))!.leaseExpiresAt === new Date(clock + 500).toISOString())
    stepGate.resolve(ok())
    await until(() => calls.includes('clean'))
    clock += 200
    await until(async () => (await getDurableJob(db, job.id))!.leaseExpiresAt === new Date(clock + 500).toISOString())
    cleanupGate.resolve(ok())
    await runner.idle()
    expect(calls).toEqual(['update', 'clean'])
    expect(await runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'retryable' })
    expect((await runner.get(queued.job.id))!.status).toBe('queued')
  })

  it('does not replay cleanup or let a stale callback execute after recovery', async () => {
    const gate = deferred<void>(), entered = deferred<void>()
    const calls: string[] = []
    let finalized = 0
    const before = await setup(async argv => { calls.push(argv[1]!); return ok() })
    const { job } = await before.runner.submit(plan({ finalize: async run => {
      finalized++; entered.resolve(); await gate.promise
      await run(cleanup)
      return { ok: true, detail: {} }
    } }), 'root')
    await entered.promise
    before.runner.close()
    const after = await setup(async () => { throw new Error('recovery must not run commands') }, { now: () => new Date(Date.now() + 3_600_000) })
    expect(await after.runner.recoverInterrupted()).toEqual({ failed: 1 })
    gate.resolve()
    await before.runner.idle()
    expect(finalized).toBe(1)
    expect(calls).toEqual(['update', 'install'])
    expect(await after.runner.get(job.id)).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome' })
  })
})

describe('host job log', () => {
  it('caps the log at 4 MiB with a truncation marker and pages it by byte offset', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024)
    const { runner, logDir } = await setup(async () => ok(big))
    const { job } = await runner.submit(plan(), 'root')
    await runner.idle()
    const raw = await readFile(join(logDir, `${job.id}.log`), 'utf8')
    expect(Buffer.byteLength(raw)).toBe(HOST_JOB_LOG_CAP_BYTES)
    expect(raw.endsWith(`[log truncated at ${HOST_JOB_LOG_CAP_BYTES} bytes]\n`)).toBe(true)
    const page = await runner.readLog(job.id, 0, 262_144)
    expect(page).toMatchObject({ offset: 0, nextOffset: 262_144, total: HOST_JOB_LOG_CAP_BYTES, truncated: true })
    const last = await runner.readLog(job.id, HOST_JOB_LOG_CAP_BYTES - 100, 262_144)
    expect(last.nextOffset).toBe(HOST_JOB_LOG_CAP_BYTES)
    expect((await runner.get(job.id))!.status).toBe('succeeded')
    await expect(runner.readLog(job.id, 0, 262_145)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(runner.readLog(job.id, HOST_JOB_LOG_CAP_BYTES + 1)).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(runner.readLog('../etc/passwd')).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('returns sanitized text without splitting a UTF-8 character at a page edge', async () => {
    const { runner } = await setup(async () => ok('مرحبا\u001b[31m\r\nnext\u202e'))
    const { job } = await runner.submit(plan({ steps: [plan().steps[0]!] }), 'root')
    await runner.idle()
    const full = await runner.readLog(job.id)
    expect(full.text).toContain('مرحبا\ufffd[31m\nnext\ufffd')
    const start = (await readFile(join(dirs[0]!, `${job.id}.log`))).indexOf(Buffer.from('م', 'utf8'))
    const page = await runner.readLog(job.id, start, 3)
    expect(page.text).toBe('م')
    expect(page.nextOffset).toBe(start + 2)
  })
})

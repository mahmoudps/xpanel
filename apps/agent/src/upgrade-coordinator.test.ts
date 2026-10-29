import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRootPrincipal, createUpgrade, finishUpgrade, getDurableJob, listJobs, requestJobCancellation } from '@xpanel/db'
import { observeUpgradeInputs } from './upgrade-observation.ts'
import { createUpgradeFixture } from './upgrade-observation-fixture.ts'
import type { UpgradeFixture } from './upgrade-observation-fixture.ts'
import { DurableUpgradeCoordinator } from './upgrade-coordinator.ts'
import type { QualifiedUpgradeProcessProvider } from './upgrade-coordinator.ts'
import { consumeUpgradeHandoff, runNativeUpgradeCoordinatorBootstrap } from './upgrade-coordinator-bootstrap.ts'
import { parseUpgradeProcessBinding, readUpgradeIntentJob } from './upgrade-coordinator-contract.ts'
import type { UpgradeProcessBinding } from './upgrade-coordinator-contract.ts'
import type { UpgradeHandoff } from './upgrade-routes.ts'
import { runNativeLifecycleCommand } from './lifecycle/native-runtime.ts'

// Public PHC fixture only; it is not an account credential.
const PHC = '$argon2id$v=19$m=65536,t=3,p=4$MIIRqgvgQbgj220jfp0MPA$YfwJSVjtjSU0zzV/P3S9nnQ/USre2wvJMjfCIjrTQbg'
const PRINCIPAL = '00000000-0000-4000-8000-000000000001'
let f: UpgradeFixture, input: UpgradeHandoff, bindings: UpgradeProcessBinding[]
const provider = (): QualifiedUpgradeProcessProvider => ({ readiness: async () => ({ available: true, reasons: [] }), launch: vi.fn(async (binding: Readonly<UpgradeProcessBinding>): Promise<{ accepted: true; binding: UpgradeProcessBinding }> => { bindings.push({ ...binding }); return { accepted: true, binding: { ...binding } } }) })
const coordinator = (processProvider: QualifiedUpgradeProcessProvider | undefined = provider()) => new DurableUpgradeCoordinator({ db: f.db.db, provider: processProvider, observation: f.deps() })
const consume = (binding: UpgradeProcessBinding, runNative: (input: unknown, binding: UpgradeProcessBinding) => Promise<unknown>) => consumeUpgradeHandoff(binding, { db: f.db.db, observation: f.deps(), runNative })
beforeEach(async () => {
  f = await createUpgradeFixture(); await f.stage('1.1.0'); bindings = []
  await createRootPrincipal(f.db.db, { id: PRINCIPAL, username: 'root', passwordHash: PHC })
  const observed = await observeUpgradeInputs(f.deps({ coordinatorAvailable: true })), staged = observed.verified.get('1.1.0')!
  input = { actor: { kind: 'root', id: PRINCIPAL, username: 'root' }, handoffId: randomUUID(), expectedRevision: observed.observation.revision,
    release: { version: staged.manifest.version, schemaVersion: staged.manifest.schemaVersion, archivePath: staged.archivePath, sha256: staged.manifest.sha256, bytes: staged.manifest.bytes }, manifest: staged.manifest }
})
afterEach(async () => { await f.close() })

describe('durable upgrade coordinator protocol (synthetic process provider only)', () => {
  it('keeps the default provider held without creating or numbering a job', async () => {
    const held = new DurableUpgradeCoordinator({ db: f.db.db, observation: f.deps() })
    expect(await held.availability()).toEqual({ available: false, reasons: ['upgrade-native-provider-unqualified', 'upgrade-hosted-uid-unqualified'] })
    await expect(held.start(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false } })
    expect(await listJobs(f.db.db)).toEqual([])
  })

  it('persists one official reference and one dispatch across duplicate authenticated starts', async () => {
    const processProvider = provider(), first = await coordinator(processProvider).start(input)
    const second = await coordinator(processProvider).start({ ...input, handoffId: randomUUID() })
    expect(first.job.referenceCode).toMatch(/^XP-JOB-[0-9]{4}-[0-9]{6,16}$/)
    expect(second).toMatchObject({ handoffId: first.handoffId, job: first.job, deduplicated: true })
    expect(bindings).toHaveLength(1)
    const saved = readUpgradeIntentJob(await getDurableJob(f.db.db, first.job.id))
    expect(saved.job.checkpointStep).toBe('dispatch-committed')
    expect(saved.intent).toMatchObject({ principalId: PRINCIPAL, expectedRevision: input.expectedRevision, release: input.release })
    expect(JSON.stringify(saved.job.detail)).not.toContain(input.manifest.signature)
    expect(JSON.stringify(saved.job.detail)).not.toContain('[REDACTED]')
  })

  it('rejects stale observation, tampered release, and revoked principal before allocating a handoff', async () => {
    const c = coordinator()
    await expect(c.start({ ...input, expectedRevision: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(c.start({ ...input, release: { ...input.release, sha256: 'e'.repeat(64) } })).rejects.toMatchObject({ code: 'VALIDATION' })
    await f.db.db.query('UPDATE principals SET disabled=1 WHERE id=$1', [PRINCIPAL])
    await expect(c.start(input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(await listJobs(f.db.db)).toEqual([])
    expect(bindings).toEqual([])
  })

  it('records unknown launch outcomes and never redispatches the durable intent', async () => {
    const processProvider = provider(); processProvider.launch = vi.fn(async () => { throw new Error('opaque process failure') })
    const c = coordinator(processProvider)
    await expect(c.start(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true, verificationRequired: true } })
    await expect(c.start(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(processProvider.launch).toHaveBeenCalledTimes(1)
    const job = (await listJobs(f.db.db))[0]!, saved = await getDurableJob(f.db.db, job.id)
    expect(saved).toMatchObject({ status: 'failed', failureClass: 'unknown_outcome', needsAttention: true, attempt: 1, maxAttempts: 1 })
  })

  it('rejects a substituted acknowledgement', async () => {
    const processProvider = provider(); processProvider.launch = async binding => ({ accepted: true, binding: { ...binding, referenceCode: 'XP-JOB-2026-999999' } })
    await expect(coordinator(processProvider).start(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect((await getDurableJob(f.db.db, (await listJobs(f.db.db))[0]!.id))?.needsAttention).toBe(true)
  })

  it('withholds the acknowledgement after post-dispatch principal revocation', async () => {
    const processProvider = provider(); processProvider.launch = async binding => {
      await f.db.db.query('UPDATE principals SET disabled=1 WHERE id=$1', [PRINCIPAL])
      return { accepted: true, binding: { ...binding } }
    }
    await expect(coordinator(processProvider).start(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', detail: { unknownOutcome: true } })
    expect((await getDurableJob(f.db.db, (await listJobs(f.db.db))[0]!.id))?.needsAttention).toBe(true)
  })

  it('observes restart recovery without relaunch or historical state restoration', async () => {
    const processProvider = provider(), first = await coordinator(processProvider).start(input), restarted = coordinator(processProvider)
    expect(await restarted.inspectRecovery()).toEqual({ jobs: [{ ...first.job, state: 'review_required', relaunchAllowed: false }], automaticRecovery: false })
    expect(bindings).toHaveLength(1)
  })

  it('consumes one dispatch exactly once, verifies the actual upgrade row and keeps the issued reference', async () => {
    const first = await coordinator().start(input)
    const result = await consume(bindings[0]!, async () => {
      const upgrade = await createUpgrade(f.db.db, { fromVersion: '1.0.0', toVersion: '1.1.0', actor: 'root', fromSchemaVersion: f.db.migration.version })
      await finishUpgrade(f.db.db, upgrade.id, { status: 'succeeded', toSchemaVersion: input.release.schemaVersion })
      return { exitCode: 0, code: 'LIFECYCLE_NATIVE_COMMITTED', outcome: 'committed', details: { currentVersion: '1.1.0', upgradeId: upgrade.id } }
    })
    expect(result.job).toEqual({ ...first.job, status: 'succeeded' })
    const unexpected = vi.fn()
    await expect(consume(bindings[0]!, unexpected)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(unexpected).not.toHaveBeenCalled()
  })

  it('refuses wrong fingerprint, cancelled lease and an expired lease without native calls', async () => {
    await coordinator().start(input)
    const run = vi.fn()
    await expect(consume({ ...bindings[0]!, requestFingerprint: 'f'.repeat(64) }, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await requestJobCancellation(f.db.db, { jobId: bindings[0]!.jobId, actor: 'root' })
    await expect(consume(bindings[0]!, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await f.db.db.query("UPDATE job_runtime_leases SET cancel_requested=0,lease_expires_at='2000-01-01T00:00:00.000Z' WHERE job_id=$1", [bindings[0]!.jobId])
    await expect(consume(bindings[0]!, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(run).not.toHaveBeenCalled()
  })

  it('fences concurrent consumers and retains unknown outcome after native interruption', async () => {
    await coordinator().start(input)
    let started!: () => void, release!: () => void
    const nativeStarted = new Promise<void>(resolve => { started = resolve }), nativeBlocked = new Promise<void>(resolve => { release = resolve })
    const run = vi.fn(async () => { started(); await nativeBlocked; throw new Error('native interrupted') })
    const first = consume(bindings[0]!, run)
    await Promise.race([nativeStarted, first])
    await expect(consume(bindings[0]!, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    release()
    await expect(first).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(run).toHaveBeenCalledTimes(1)
    expect(await getDurableJob(f.db.db, bindings[0]!.jobId)).toMatchObject({ status: 'failed', needsAttention: true, failureClass: 'unknown_outcome' })
    await expect(consume(bindings[0]!, run)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('requires root Linux bootstrap and refuses changing a bound upgrade into recovery', async () => {
    await coordinator().start(input)
    const binding = parseUpgradeProcessBinding(bindings[0])
    if (process.platform !== 'linux') await expect(runNativeUpgradeCoordinatorBootstrap(binding)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(runNativeLifecycleCommand({ schemaVersion: 1, command: 'recover', mode: 'apply', json: true, assumeYes: true }, binding)).rejects.toMatchObject({ code: 'LIFECYCLE_HANDOFF_COMMAND_MISMATCH' })
  })
})

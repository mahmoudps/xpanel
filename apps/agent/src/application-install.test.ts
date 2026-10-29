import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { applicationDigest, verifyApplicationArtifact } from '../../../packages/os/src/application-artifact.ts'
import type { ApplicationArtifactDescriptor } from '../../../packages/os/src/application-artifact.ts'
import { applicationCatalogSigningBytes, verifyApplicationCatalog } from './application-catalog.ts'
import { ApplicationInstallCoordinator, APPLICATION_TRANSACTION_COMMAND, applicationInstallProviderAvailable, isApplicationInstallCommand, readApplicationInstallation, readApplicationInstallRequest, readApplicationObservedState, recoverApplicationInstallations } from './application-install.ts'
import type { ApplicationArtifactProvider, ApplicationInstallAction, ApplicationInstallDeps, ApplicationObservedState, ApplicationTarget, ApplicationTransactionIntent } from './application-install.ts'
import { HostJobRunner } from './host-jobs.ts'

// Explicit synthetic descriptor/transaction port. No filesystem, account, network or native install.
const target: ApplicationTarget = { accountId: '11111111-1111-4111-8111-111111111111', domainId: '22222222-2222-4222-8222-222222222222', uid: 1001, gid: 1001, identity: applicationDigest('held-account-directory-identity') }
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const initial = (): ApplicationObservedState => ({ revision: applicationDigest('empty-target'), unmanagedRevision: applicationDigest('unchanged-unmanaged-files'), empty: true, managedClean: true, recoveryRequired: false, installation: null })
const artifact = (version: string) => {
  const content = '<?php echo "' + version + '";', bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'sample', version, files: [{ path: 'index.php', sha256: applicationDigest(content), bytes: Buffer.byteLength(content), mode: '0644', contentBase64: Buffer.from(content).toString('base64') }] }))
  const descriptor: ApplicationArtifactDescriptor = { format: 'xpanel-files-v1', sha256: applicationDigest(bytes), bytes: bytes.length }
  return { bytes, descriptor, verified: verifyApplicationArtifact(bytes, descriptor, 'sample', version) }
}
type Failure = 'none' | 'snapshot' | 'apply' | 'commit-before' | 'commit-after' | 'readback' | 'recover' | 'unmanaged'
const fixture = () => {
  const artifacts = new Map(['1.0.0', '2.0.0'].map(version => [version, artifact(version)])), key = generateKeyPairSync('ed25519')
  const policy = { now: new Date('2026-10-27T12:00:00.000Z'), minimumSequence: 1, panelVersion: '1.4.2' }
  const payload = JSON.stringify({ schemaVersion: 1, sequence: 1, issuedAt: '2026-10-27T11:00:00.000Z', expiresAt: '2026-10-28T12:00:00.000Z', applications: [{ id: 'sample', name: 'Sample', releases: ['2.0.0', '1.0.0'].map(version => ({ version, minimumPanelVersion: '1.0.0', artifact: artifacts.get(version)!.descriptor })) }] })
  const catalog = verifyApplicationCatalog({ keyId: 'apps', payload, signature: sign(null, applicationCatalogSigningBytes(payload), key.privateKey).toString('hex') }, [{ keyId: 'apps', publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() }], policy)
  let state = initial(), currentTarget = { ...target }, revoked = false, leased = false, failure: Failure = 'none'
  const events: string[] = [], hooks = { afterApply: null as (() => Promise<void>) | null }
  const transactions = new Map<string, { before: ApplicationObservedState; intent: ApplicationTransactionIntent; expected: string | null; committed: boolean }>()
  const checkLease = () => { if (!leased) throw new Error('mutation/observation outside canonical account lease') }
  const provider: ApplicationArtifactProvider = {
    admission: { descriptorConfinement: true, accountLifetimeFence: true, durablePreimages: true, scopedWrites: true, digestReadback: true, boundedDeadlines: true, contentAddressedEgress: true },
    readArtifact: async descriptor => { events.push('artifact'); const found = [...artifacts.values()].find(item => item.descriptor.sha256 === descriptor.sha256); if (!found) throw new Error('missing'); return Uint8Array.from(found.bytes) },
    pendingTransactions: async () => { checkLease(); return [...transactions].map(([transactionId, tx]) => ({ transactionId, beforeRevision: tx.before.revision, expectedCommittedRevision: tx.expected })) },
    openTarget: async observedTarget => {
      checkLease(); events.push('open')
      return {
        target: { ...observedTarget },
        observe: async () => { checkLease(); events.push('observe'); return copy(state) },
        snapshot: async (intent, before) => {
          checkLease(); events.push('snapshot'); transactions.set(intent.transactionId, { before: copy(before), intent, expected: null, committed: false })
          if (failure === 'snapshot') throw new Error('snapshot receipt lost')
          return { transactionId: intent.transactionId, beforeRevision: before.revision, durable: true }
        },
        apply: async (intent, verified) => {
          checkLease(); events.push('apply')
          const tx = transactions.get(intent.transactionId)!
          expect(verified === null || verified.descriptor.sha256 === intent.next?.artifactSha256).toBe(true)
          const old = tx.before.installation, prior = old ? { appId: old.appId, version: old.version, artifactSha256: old.artifactSha256, files: old.files } : null
          state = { revision: applicationDigest('applied:' + intent.transactionId), unmanagedRevision: tx.before.unmanagedRevision, empty: intent.next === null, managedClean: true, recoveryRequired: false, installation: intent.next ? { ...copy(intent.next), previous: prior } : null }
          tx.expected = state.revision
          if (failure === 'readback') state = { ...state, managedClean: false }
          if (failure === 'unmanaged') state = { ...state, unmanagedRevision: applicationDigest('unexpected-unmanaged-change') }
          if (hooks.afterApply) await hooks.afterApply()
          if (failure === 'apply') throw new Error('apply crashed after its effect')
        },
        commit: async (transactionId, expectedRevision) => {
          checkLease(); events.push('commit')
          if (failure === 'commit-before') throw new Error('commit interrupted')
          transactions.get(transactionId)!.committed = true
          if (failure === 'commit-after') throw new Error('commit acknowledgement lost')
          return { transactionId, committedRevision: expectedRevision }
        },
        recover: async transactionId => {
          checkLease(); events.push('recover')
          if (failure === 'recover') throw new Error('recovery unavailable')
          const tx = transactions.get(transactionId)
          if (!tx) return { transactionId, state: 'not_started', beforeRevision: state.revision, committedRevision: null, observation: copy(state) }
          if (state.unmanagedRevision !== tx.before.unmanagedRevision) return { transactionId, state: 'unknown', beforeRevision: tx.before.revision, committedRevision: null, observation: copy(state) }
          if (!tx.committed) state = copy(tx.before)
          transactions.delete(transactionId)
          return { transactionId, state: tx.committed ? 'committed' : 'restored', beforeRevision: tx.before.revision, committedRevision: tx.committed ? tx.expected : null, observation: copy(state) }
        },
        close: async () => { events.push('close') },
      }
    },
  }
  const deps: ApplicationInstallDeps = {
    provider, catalog: async () => catalog, policy: () => policy,
    assertFresh: async () => { events.push('fresh'); if (revoked) throw new Error('revoked'); return { ...currentTarget } },
    assertAuthority: async () => { events.push('authority'); if (revoked) throw new Error('revoked') },
    withAccountLease: async <T>(_target: ApplicationTarget, operation: (fresh: ApplicationTarget) => Promise<T>): Promise<T> => {
      if (leased) throw new Error('nested account lease')
      leased = true; events.push('lease')
      try { return await operation({ ...currentTarget }) } finally { leased = false }
    },
  }
  const coordinator = new ApplicationInstallCoordinator(deps)
  const request = (action: ApplicationInstallAction, version?: string) => ({ action, appId: 'sample', expectedRevision: state.revision, expectedCatalogRevision: catalog.revision, ...(version ? { version } : {}) })
  return { deps, provider, coordinator, request, events, hooks, transactions, policy, catalog, artifacts, state: () => copy(state), setState: (value: ApplicationObservedState) => { state = copy(value) }, revoke: () => { revoked = true }, target: (value: ApplicationTarget) => { currentTarget = { ...value } }, failure: (value: Failure) => { failure = value } }
}
const handles: TestDbHandle[] = [], directories: string[] = [], runners: HostJobRunner[] = [], releases: (() => void)[] = []
afterEach(async () => {
  vi.useRealTimers(); for (const release of releases.splice(0)) release()
  for (const runner of runners.splice(0)) { runner.close(); await runner.idle() }
  await Promise.all(handles.splice(0).map(handle => handle.close()))
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const execute = async (t: ReturnType<typeof fixture>, request: unknown) => {
  const prepared = await t.coordinator.prepare(request), db = await createTestDb(), logDir = await mkdtemp(join(tmpdir(), 'xpanel-app-installer-'))
  handles.push(db); directories.push(logDir)
  const runner = new HostJobRunner({ db: db.db, run: t.coordinator.run, logDir }); runners.push(runner)
  const submitted = await runner.submit(prepared.plan, 'alice'); await runner.idle()
  return { prepared, runner, job: (await runner.get(submitted.job.id))! }
}
const until = async (check: () => boolean) => { for (let i = 0; i < 400; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('not reached') }

describe('recoverable descriptor-confined application transactions', () => {
  it('keeps writes unavailable without all trusted provider prerequisites and rejects path/URL/env intent injection', async () => {
    const t = fixture()
    expect(applicationInstallProviderAvailable(null)).toBe(false)
    expect(await readApplicationInstallation({ ...t.deps, provider: null })).toMatchObject({ observation: null, writesAvailable: false, reason: 'application_provider_unavailable' })
    expect((await readApplicationInstallation(t.deps)).observation?.revision).toBe(initial().revision)
    await expect(new ApplicationInstallCoordinator({ ...t.deps, provider: null }).prepare(t.request('install', '1.0.0'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: false, reason: 'application_provider_unavailable' } })
    for (const extra of [{ path: '/root' }, { url: 'https://attacker.invalid' }, { env: { HOME: '/root' } }, { uid: 0 }, { argv: ['/bin/sh'] }]) expect(() => readApplicationInstallRequest({ ...t.request('install', '1.0.0'), ...extra })).toThrow()
    expect(() => readApplicationInstallRequest(t.request('remove', '1.0.0'))).toThrow()
  })
  it('runs install, update, rollback and remove as existing durable host jobs with official references', async () => {
    const t = fixture()
    for (const [action, version, expectedVersion] of [['install', '1.0.0', '1.0.0'], ['update', '2.0.0', '2.0.0'], ['rollback', undefined, '1.0.0'], ['remove', undefined, null]] as const) {
      const { job } = await execute(t, t.request(action, version))
      expect(job.status).toBe('succeeded'); expect(job.referenceCode).toMatch(/^XP-JOB-/)
      expect(t.state().installation?.version ?? null).toBe(expectedVersion)
      expect(job.verification).toMatchObject({ ok: true, detail: { finalization: { transaction: 'committed', recoveryVerified: true } } })
    }
    expect(t.events.filter(event => ['snapshot', 'apply', 'commit', 'recover'].includes(event))).toEqual(Array.from({ length: 4 }, () => ['snapshot', 'apply', 'commit', 'recover']).flat())
    expect(t.transactions.size).toBe(0)
  })
  it.each(['snapshot', 'apply', 'commit-before', 'commit-after', 'readback', 'recover', 'unmanaged'] as const)('preserves a failed or unknown job and performs bounded recovery after %s', async failure => {
    const t = fixture(), before = t.state(); t.failure(failure)
    const { job } = await execute(t, t.request('install', '1.0.0'))
    expect(job.status).toBe('failed'); expect(job.failureClass).toBe('unknown_outcome')
    expect(t.events.filter(event => event === 'recover')).toHaveLength(1)
    if (['snapshot', 'apply', 'commit-before', 'readback'].includes(failure)) expect(t.state()).toEqual(before)
    if (failure === 'commit-after') expect(t.state().installation?.version).toBe('1.0.0')
    if (failure === 'recover' || failure === 'unmanaged') expect(job.verification?.ok).toBe(false)
  })
  it('revalidates fresh authority before the next effect and permits only identity-fenced cleanup after revocation', async () => {
    const t = fixture(); t.hooks.afterApply = async () => t.revoke()
    const { job } = await execute(t, t.request('install', '1.0.0'))
    expect(job.status).toBe('failed'); expect(job.failureClass).toBe('unknown_outcome')
    expect(t.events).not.toContain('commit'); expect(t.events.filter(event => event === 'recover')).toHaveLength(1)
    expect(t.state()).toEqual(initial())
  })
  it('refuses target replacement and stale revision/catalog before mutation', async () => {
    const t = fixture()
    await expect(t.coordinator.prepare({ ...t.request('install', '1.0.0'), expectedRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(t.coordinator.prepare({ ...t.request('install', '1.0.0'), expectedCatalogRevision: '0'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' })
    const prepared = await t.coordinator.prepare(t.request('install', '1.0.0'))
    t.policy.panelVersion = '0.9.0'
    await expect(prepared.plan.beforeStep!(prepared.plan.steps[0]!)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    t.policy.panelVersion = '1.4.2'
    t.target({ ...target, uid: 2001 })
    await expect(prepared.plan.beforeStep!(prepared.plan.steps[0]!)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(t.events).not.toContain('snapshot')
  })
  it('refuses altered owned files, overwriting an unmanaged site, downgrade updates and unverified rollback', async () => {
    const t = fixture()
    t.setState({ ...initial(), empty: false })
    await expect(t.coordinator.prepare(t.request('install', '1.0.0'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    t.setState(initial()); await execute(t, t.request('install', '2.0.0'))
    await expect(t.coordinator.prepare(t.request('update', '1.0.0'))).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(t.coordinator.prepare(t.request('rollback'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    t.setState({ ...t.state(), managedClean: false })
    await expect(t.coordinator.prepare(t.request('remove'))).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })
  it('deduplicates identical prepared intent and never accepts arbitrary command transport or bounds', async () => {
    const t = fixture(), request = t.request('install', '1.0.0')
    const first = await t.coordinator.prepare(request), second = await t.coordinator.prepare(request)
    expect(second).toBe(first)
    const argv = first.plan.steps[0]!.argv
    expect(isApplicationInstallCommand(argv)).toBe(true)
    for (const bad of [['/bin/sh', '-c', 'echo unsafe'], [...argv, '/root'], [APPLICATION_TRANSACTION_COMMAND, 'not-id', 'snapshot']]) expect(isApplicationInstallCommand(bad)).toBe(false)
    await expect(t.coordinator.run(argv, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(t.coordinator.run(argv, { timeoutMs: 60_000, env: { LC_ALL: 'C' } })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(first.discardUnstarted()).toBe(true)
    await expect(t.coordinator.run(argv, { timeoutMs: 60_000 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(t.events).not.toContain('snapshot')
  })
  it('recovers provider-listed persisted preimages after process loss without replaying a lost job plan', async () => {
    const t = fixture(), prepared = await t.coordinator.prepare(t.request('install', '1.0.0'))
    for (const command of prepared.plan.steps.slice(0, 2)) expect((await t.coordinator.run(command.argv, { timeoutMs: command.timeoutMs })).ok).toBe(true)
    expect(t.state().installation?.version).toBe('1.0.0')
    expect(await recoverApplicationInstallations(t.deps)).toEqual([{ transactionId: prepared.transactionId, state: 'restored', verified: true }])
    expect(t.state()).toEqual(initial()); expect(t.events.filter(event => event === 'apply')).toHaveLength(1)
  })
  it.each(['cancel', 'close'] as const)('restores its exact preimage when %s stops the plan after apply', async mode => {
    const t = fixture(), prepared = await t.coordinator.prepare(t.request('install', '1.0.0'))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); releases.push(release)
    t.hooks.afterApply = async () => gate
    const db = await createTestDb(), logDir = await mkdtemp(join(tmpdir(), 'xpanel-app-stop-')); handles.push(db); directories.push(logDir)
    const runner = new HostJobRunner({ db: db.db, run: t.coordinator.run, logDir }); runners.push(runner)
    const submitted = await runner.submit(prepared.plan, 'alice')
    await until(() => t.events.includes('apply'))
    if (mode === 'cancel') await runner.cancel(submitted.job.id, 'alice'); else runner.close()
    release(); await runner.idle()
    expect((await runner.get(submitted.job.id))!.status).toBe(mode === 'cancel' ? 'cancelled' : 'failed')
    expect(t.state()).toEqual(initial()); expect(t.events.filter(event => event === 'recover')).toHaveLength(1)
  })
  it('validates bounded observed metadata before trusting provider state', () => {
    expect(readApplicationObservedState(initial())).toEqual(initial())
    expect(() => readApplicationObservedState({ ...initial(), root: '/root' })).toThrow()
    expect(() => readApplicationObservedState({ ...initial(), revision: 'x' })).toThrow()
  })
})

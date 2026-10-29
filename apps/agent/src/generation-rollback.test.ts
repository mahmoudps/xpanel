import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { fail, suggestServerSettings } from '@xpanel/core'
import { activate, createRootPrincipal, createTestDb, getPrincipal, latestActive, listGenerations, setPrincipalDisabled } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { createTestStateStore, generationDesiredState } from '@xpanel/state'
import type { GenerationRollbackRequest, TestStateStoreHandle } from '@xpanel/state'
import { profileFor } from '@xpanel/os'
import { FakeHostExecutor, LinuxHostExecutor } from './executor.ts'
import { HostReconciler } from './reconciler.ts'
import { readGenerationRollbackAdmission } from './generation-rollback-admission.ts'

const handles: { state: TestStateStoreHandle; db: TestDbHandle }[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const handle of handles.splice(0)) { await handle.state.close(); await handle.db.close() } })
async function fixture() {
  const state = await createTestStateStore(), db = await createTestDb(); handles.push({ state, db })
  const hash = '$argon2id$v=19$m=65536,t=3,p=4$' + randomBytes(16).toString('base64').replace(/=/g, '') + '$' + randomBytes(32).toString('base64').replace(/=/g, '')
  const root = await createRootPrincipal(db.db, { username: 'root', passwordHash: hash })
  const suggested = suggestServerSettings({ cores: 4, memoryMb: 8192 })
  await state.store.saveServerSettings({ hostname: 'srv1.example.test', nameservers: ['ns1.example.test', 'ns2.example.test'], adminEmail: 'ops@example.test',
    engine: 'apache', apacheMpm: 'itk', panelPort: 2087, sshPort: 22, nginx: suggested.nginx, apache: suggested.apache, backendPort: 8080, backendTlsPort: 8443 })
  // Memory-only host model. These tests prove guards, source binding and sequencing, not native capability.
  const executor = new FakeHostExecutor()
  const reconciler = new HostReconciler({ store: state.store, db: db.db, executor, os: profileFor('ID=ubuntu\nVERSION_ID="24.04"\n') })
  const targetResult = await reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })
  if (targetResult.status !== 'applied') throw new Error('target fixture was not applied in the host model')
  const target = targetResult.generation, targetSource = await state.store.readValidatedGenerationSnapshot(target.id)
  const settings = (await state.store.getServerSettings())!
  await state.store.saveServerSettings({ ...settings, sshPort: 2222 })
  const currentResult = await reconciler.reconcile({ force: true, actor: 'root', mailAuth: null })
  if (currentResult.status !== 'applied') throw new Error('current fixture was not applied in the host model')
  const current = currentResult.generation, snapshot = await state.store.readSnapshot()
  const request: GenerationRollbackRequest = { expectedCurrentGenerationId: current.id, expectedCurrentStateRevision: snapshot.revision!, expectedTargetChecksum: target.checksum, confirmation: String(target.id) }
  const authorize = vi.fn(async () => { const principal = await getPrincipal(db.db, root.id); if (!principal || principal.disabled || principal.kind !== 'root') fail('FORBIDDEN', 'fresh root authorization is required', { stateChanged: false }) })
  const restore = (value = request) => reconciler.rollbackToGeneration(target.id, 'root', { request: value, authorize })
  return { state, db, root, executor, reconciler, target, targetSource, current, snapshot, request, authorize, restore }
}
describe('guarded generation rollback through actual state and generation stores', () => {
  it('returns the actual new active generation while preserving reviewed target identity and source', async () => {
    const f = await fixture(), result = await f.restore()
    expect(result.status).toBe('applied'); expect(result.generation!.id).toBeGreaterThan(f.current.id)
    expect(result.generation!.id).not.toBe(f.target.id)
    expect(result).toMatchObject({ rollbackTargetGenerationId: f.target.id, rollbackTargetChecksum: f.target.checksum, stateChanged: true })
    expect((await latestActive(f.db.db))!.id).toBe(result.generation!.id)
    expect((await f.state.store.readValidatedGenerationSnapshot(result.generation!.id))!.checksum).toBe(f.targetSource!.checksum)
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect((await f.state.store.getServerSettings())!.sshPort).toBe(22)
  })
  it('preserves newer saved pending state even when the submitted revision is current', async () => {
    const f = await fixture(), settings = (await f.state.store.getServerSettings())!
    await f.state.store.saveServerSettings({ ...settings, sshPort: 2200 })
    const before = await f.state.store.readSnapshot(), count = (await listGenerations(f.db.db)).length
    await expect(f.restore({ ...f.request, expectedCurrentStateRevision: before.revision! })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await f.state.store.readSnapshot()).toEqual(before); expect((await listGenerations(f.db.db)).length).toBe(count)
  })
  it.each(['active', 'target-checksum', 'root-revocation'])('rechecks %s after waiting for the actual restore writer boundary', async change => {
    const f = await fixture(), before = await f.state.store.readSnapshot(), held = await f.state.store.getWriterLock().acquire()
    const original = f.state.store.restoreGenerationSnapshot.bind(f.state.store)
    let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve })
    vi.spyOn(f.state.store, 'restoreGenerationSnapshot').mockImplementation((id, options) => { enter(); return original(id, options) })
    // Stored generation checksums are immutable; a stale reviewed checksum is the legitimate target mismatch.
    const request = change === 'target-checksum' ? { ...f.request, expectedTargetChecksum: '0'.repeat(64) } : f.request
    const outcome = f.restore(request).then(result => ({ result, error: null }), error => ({ result: null, error }))
    try {
      await entered
      if (change === 'active') await activate(f.db.db, f.target.id)
      if (change === 'root-revocation') await setPrincipalDisabled(f.db.db, f.root.id, true)
    } finally { await held.release(); await outcome }
    const observed = await outcome
    expect(observed.error).toMatchObject({ code: change === 'root-revocation' ? 'FORBIDDEN' : 'CONFLICT' })
    expect(await f.state.store.readSnapshot()).toEqual(before)
  })
  it('does not compile a pending desired save that arrives after restore releases its writer lease', async () => {
    const f = await fixture(), original = f.state.store.restoreGenerationSnapshot.bind(f.state.store), preflight = vi.spyOn(f.executor, 'preflight')
    vi.spyOn(f.state.store, 'restoreGenerationSnapshot').mockImplementation(async (id, options) => {
      const result = await original(id, options)
      await f.state.store.saveServerSettings({ ...result.server!.settings, sshPort: 2200 })
      return result
    })
    await expect(f.restore()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', detail: { stateChanged: true, verificationRequired: true } })
    expect(preflight).not.toHaveBeenCalled()
    expect((await f.state.store.getServerSettings())!.sshPort).toBe(2200)
    expect((await latestActive(f.db.db))!.id).toBe(f.current.id)
  })
  it('preserves the real failed candidate and previous active host generation when syntax validation fails', async () => {
    const f = await fixture(); f.executor.failConfigTest('sshd', 'declared configuration test failure')
    const result = await f.restore()
    expect(result.status).toBe('failed'); expect(result.generation!.status).toBe('failed')
    expect(result).toMatchObject({ rollbackTargetGenerationId: f.target.id, verificationRequired: true, details: { stateChanged: true, verificationRequired: true } })
    expect((await latestActive(f.db.db))!.id).toBe(f.current.id)
    expect(generationDesiredState(await f.state.store.readSnapshot(), await f.state.store.readValidatedGenerationSnapshot(f.current.id))!.pending).toBe(true)
  })
  it('reports real admission observations with declared host ports and refuses ordinary fake executors', async () => {
    const f = await fixture(), readFile = vi.fn(async () => 'ID=ubuntu\nVERSION_ID="24.04"\n')
    // Declared Linux-shaped IO port fake: no real host read or command is performed.
    const declaredLinuxPort = Object.assign(Object.create(LinuxHostExecutor.prototype), { readFile }) as LinuxHostExecutor
    const result = await readGenerationRollbackAdmission({ store: f.state.store, db: f.db.db, executor: declaredLinuxPort, journal: f.reconciler.journal })
    expect(result).toMatchObject({ guardVersion: 1, source: 'agent', canRollback: true, activeGeneration: { id: f.current.id, checksum: f.current.checksum }, sourceRevision: f.snapshot.revision })
    expect(result.eligibleTargets).toEqual([{ generationId: f.target.id, checksum: f.target.checksum }])
    expect(readFile).toHaveBeenCalledWith('/etc/os-release')
    expect((await readGenerationRollbackAdmission({ store: f.state.store, db: f.db.db, executor: f.executor, journal: f.reconciler.journal })).canRollback).toBe(false)
  })
})

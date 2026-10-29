import { afterEach, describe, expect, it } from 'vitest'
import { activate, createGeneration, createTestDb, latestActive, markTested } from '@xpanel/db'
import type { TestDbHandle } from '@xpanel/db'
import { buildGenerationRollbackAdmission, createTestStateStore } from '@xpanel/state'
import type { TestStateStoreHandle } from '@xpanel/state'
import { readGenerationWorkspace } from './generation-workspace.ts'

const handles: { state: TestStateStoreHandle; db: TestDbHandle }[] = []
afterEach(async () => { for (const handle of handles.splice(0)) { await handle.state.close(); await handle.db.close() } })
async function fixture() {
  const state = await createTestStateStore(), db = await createTestDb(); handles.push({ state, db })
  const target = await createGeneration(db.db, { checksum: '7'.repeat(64), actor: 'root' })
  await state.store.saveGenerationSnapshot(target.id); await markTested(db.db, target.id); await activate(db.db, target.id)
  const active = await createGeneration(db.db, { checksum: '9'.repeat(64), actor: 'root' })
  await state.store.saveGenerationSnapshot(active.id); await markTested(db.db, active.id); await activate(db.db, active.id)
  const snapshot = await state.store.readSnapshot()
  // Declared authenticated-agent DTO fake; this does not qualify a native host.
  const admission = buildGenerationRollbackAdmission({ executor: 'linux', supportedProfile: true, mutexAvailable: true, sourceAvailable: true,
    activeGeneration: { id: active.id, checksum: active.checksum }, sourceRevision: snapshot.revision!, eligibleTargets: [{ generationId: target.id, checksum: target.checksum }] })
  const read = (readAdmission = async () => admission) => readGenerationWorkspace({ store: state.store, db: db.db, readAdmission })
  return { state, db, target, active, snapshot, admission, read }
}
describe('generation workspace source-bound readback', () => {
  it('returns exact desired source and validated target admission without allocating on a read', async () => {
    const f = await fixture(), revision = await f.state.store.getRevision()
    const result = await f.read()
    expect(result.desiredState).toEqual({ revision, checksum: f.snapshot.checksum, pending: false })
    expect(result.desiredState!.checksum).not.toBe(f.active.checksum)
    expect(result.canRollback).toBe(true); expect(result.rollbackEligibleGenerationIds).toEqual([f.target.id])
    expect(await f.state.store.getRevision()).toBe(revision); expect((await latestActive(f.db.db))!.id).toBe(f.active.id)
  })
  it('preserves pending saved state even when an admission fake says ready', async () => {
    const f = await fixture()
    await f.state.store.createFeatureList({ name: 'Saved pending changes', ownerId: null, disabled: [] })
    const before = await f.state.store.readSnapshot(), result = await f.read(async () => ({ ...f.admission, sourceRevision: before.revision! }))
    expect(result.desiredState?.pending).toBe(true); expect(result.canRollback).toBe(false)
    expect(await f.state.store.readSnapshot()).toEqual(before)
  })
  it('refuses mismatched or unavailable agent target/source observations while retaining history', async () => {
    const f = await fixture()
    for (const admission of [{ ...f.admission, executor: 'fake' }, { ...f.admission, sourceRevision: f.snapshot.revision! + 1 }, { ...f.admission, eligibleTargets: [{ generationId: f.target.id, checksum: '0'.repeat(64) }] }]) {
      const result = await f.read(async () => admission as typeof f.admission)
      expect(result.generations).toHaveLength(2); expect(result.canRollback).toBe(false); expect(result.rollbackEligibleGenerationIds).toEqual([])
    }
    expect((await f.read(async () => { throw new Error('agent unavailable') })).canRollback).toBe(false)
  })
  it('refuses an active-generation change during admission read', async () => {
    const f = await fixture()
    const result = await f.read(async () => { await activate(f.db.db, f.target.id); return f.admission })
    expect(result.canRollback).toBe(false)
    expect((await latestActive(f.db.db))!.id).toBe(f.target.id)
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdir } from 'node:fs/promises'
import { createTestStateStore } from './store.ts'
import type { TestStateStoreHandle } from './store.ts'
import type { StateSnapshot } from './types.ts'

const handles: TestStateStoreHandle[] = []
afterEach(async () => { for (const handle of handles.splice(0)) await handle.close() })
async function fixture() {
  const handle = await createTestStateStore(); handles.push(handle)
  await handle.store.createFeatureList({ name: 'Snapshot features', ownerId: null, disabled: [] })
  const target = await handle.store.saveGenerationSnapshot(1)
  await handle.store.createFeatureList({ name: 'Saved newer features', ownerId: null, disabled: ['terminal'] })
  const current = await handle.store.readSnapshot()
  return { ...handle, target, current }
}
describe('trusted generation restore guard at the desired-state writer boundary', () => {
  it('passes the coherent current source and validated target before any staging and preserves refusal', async () => {
    const f = await fixture()
    const guard = vi.fn(async (current: StateSnapshot, target: StateSnapshot) => {
      expect(current).toMatchObject({ revision: f.current.revision, checksum: f.current.checksum })
      expect(target.checksum).toBe(f.target.checksum)
      expect((await readdir(f.rootDir)).filter(name => name.startsWith('.restore-'))).toEqual([])
      throw Object.assign(new Error('saved state must survive'), { code: 'CONFLICT' })
    })
    await expect(f.store.restoreGenerationSnapshot(1, { expectedRevision: f.current.revision, restoreGuard: guard })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(await f.store.readSnapshot()).toEqual(f.current)
    expect((await readdir(f.rootDir)).filter(name => name.startsWith('.restore-'))).toEqual([])
  })
  it('refuses an intervening saved revision before invoking the trusted guard', async () => {
    const f = await fixture(), guard = vi.fn(async () => undefined)
    await f.store.createFeatureList({ name: 'Intervening saved features', ownerId: null, disabled: [] })
    const before = await f.store.readSnapshot()
    await expect(f.store.restoreGenerationSnapshot(1, { expectedRevision: f.current.revision, restoreGuard: guard })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(guard).not.toHaveBeenCalled()
    expect(await f.store.readSnapshot()).toEqual(before)
  })
  it('keeps another desired save behind the actual restore writer lease and preserves it afterward', async () => {
    const f = await fixture()
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), released = new Promise<void>(resolve => { release = resolve })
    const restoring = f.store.restoreGenerationSnapshot(1, { expectedRevision: f.current.revision, restoreGuard: async () => { enter(); await released } })
    await entered
    let saveFinished = false
    const saving = f.store.createFeatureList({ name: 'Queued saved features', ownerId: null, disabled: [] }).then(value => { saveFinished = true; return value })
    await Promise.resolve()
    expect(saveFinished).toBe(false)
    release()
    const restored = await restoring, saved = await saving, observed = await f.store.readSnapshot()
    expect(restored.checksum).toBe(f.target.checksum)
    expect(observed.featureLists.map(item => item.name)).toEqual(['Queued saved features', 'Snapshot features'])
    expect(observed.featureLists.some(item => item.id === saved.id)).toBe(true)
    expect(observed.revision).toBe((restored.revision ?? 0) + 1)
  })
})

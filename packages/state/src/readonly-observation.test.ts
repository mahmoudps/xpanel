import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { StateStore, createTestStateStore } from './store.ts'
import type { ReadonlyStateObservation } from './readonly-observation.ts'

// Real desired-state files; this is no native lifecycle or hosted UID qualification.
describe('state observation without recovery or writer authority', () => {
  it('returns a complete immutable snapshot and retires its assertion without allocating an epoch', async () => {
    const h = await createTestStateStore()
    try {
      const list = await h.store.createFeatureList({ name: 'Observed features', ownerId: null, disabled: [] })
      const before = await readFile(join(h.rootDir, 'authority.json')), entries = await readdir(h.rootDir)
      let leaked: ReadonlyStateObservation | undefined
      await h.store.withReadonlyObservation(async observation => {
        leaked = observation
        expect(observation.snapshot.featureLists.map(row => row.id)).toContain(list.id)
        expect(observation.snapshot.revision).toBe(observation.authority.revision)
        expect(Object.isFrozen(observation.snapshot.featureLists[0])).toBe(true)
        await observation.assertCurrent()
      })
      expect(await readFile(join(h.rootDir, 'authority.json'))).toEqual(before)
      expect(await readdir(h.rootDir)).toEqual(entries)
      await expect(leaked!.assertCurrent()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally { await h.close() }
  })
  it('refuses a retained malformed writer marker without cleaning or repairing it', async () => {
    const h = await createTestStateStore()
    try {
      await h.store.createFeatureList({ name: 'Observed features', ownerId: null, disabled: [] })
      await mkdir(join(h.rootDir, '.lock')); await writeFile(join(h.rootDir, '.lock', 'intent.json'), '{interrupted')
      const before = await readFile(join(h.rootDir, 'authority.json'))
      await expect(h.store.withReadonlyObservation(async () => 'unreachable')).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect(await readFile(join(h.rootDir, '.lock', 'intent.json'), 'utf8')).toBe('{interrupted')
      expect(await readFile(join(h.rootDir, 'authority.json'))).toEqual(before)
    } finally { await h.close() }
  })
  it('rejects authority drift during the callback instead of presenting an old census as current', async () => {
    const h = await createTestStateStore()
    try {
      await h.store.createFeatureList({ name: 'Observed features', ownerId: null, disabled: [] })
      await expect(h.store.withReadonlyObservation(async observation => {
        const path = join(h.rootDir, 'authority.json'), value = JSON.parse(await readFile(path, 'utf8'))
        await writeFile(path, JSON.stringify({ ...value, revision: value.revision + 1 }))
        await observation.assertCurrent()
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally { await h.close() }
  })
  it('rejects an aborted writer epoch even when business revision did not advance', async () => {
    const h = await createTestStateStore()
    try {
      const input = { name: 'Observed features', ownerId: null, disabled: [] }
      await h.store.createFeatureList(input)
      await expect(h.store.withReadonlyObservation(async observation => {
        const other = new StateStore(h.rootDir)
        await expect(other.createFeatureList(input)).rejects.toBeDefined()
        const authority = JSON.parse(await readFile(join(h.rootDir, 'authority.json'), 'utf8'))
        expect(authority.revision).toBe(observation.authority.revision)
        expect(authority.fencingToken).toBeGreaterThan(observation.authority.fencingToken)
        await observation.assertCurrent()
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    } finally { await h.close() }
  })
})
